import type { PoolClient, QueryResultRow } from "pg";
import { nowIso, randomId, sha256Hex } from "./crypto.ts";
import { PackageBillingError } from "./package-errors.ts";
import {
  assertPositiveRawQuota,
  assertRawQuota,
  availableDepartmentBudget,
  canUserRequestRegrant,
  issuablePackageCount,
  packageGrantWindow,
  planGrantAllocations,
} from "./package-model.ts";
import {
  assertCanConfigureDepartmentBudget,
  assertCanCreatePackageDefinition,
  assertPackageDefinitionInScope,
  packageScopeDepartment,
} from "./package-permissions.ts";
import type {
  BillingPackageDefinition,
  BillingOperation,
  BillingPackageRequest,
  BillingPackageVersion,
  DepartmentBudgetCommitment,
  DepartmentBudgetPeriod,
  DepartmentPackageAssignment,
  PackageCycleType,
  PackageEligibilityPolicy,
  PackageOwnerScopeType,
  PackageRegrantPolicy,
  RequestBillingContext,
  UsageChargeAllocation,
  UserPackageGrant,
} from "./package-types.ts";
import { withPostgresClient, withPostgresTransaction } from "./postgres-store.ts";
import type { AdminScope } from "./types.ts";
import type { NewApiUsageRecord, TokenAccount } from "./types.ts";

function quotaNumber(value: unknown, field: string) {
  const number = typeof value === "number" ? value : Number(value);
  return assertRawQuota(number, field);
}

function definitionFromRow(row: QueryResultRow): BillingPackageDefinition {
  return {
    id: row.id,
    ownerScopeType: row.owner_scope_type,
    ownerDepartmentId: row.owner_department_id ?? undefined,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function versionFromRow(row: QueryResultRow): BillingPackageVersion {
  return {
    id: row.id,
    definitionId: row.definition_id,
    version: Number(row.version),
    grantedQuota: quotaNumber(row.granted_quota, "grantedQuota"),
    cycleType: row.cycle_type,
    cycleValue: Number(row.cycle_value),
    timezone: row.timezone,
    eligibilityPolicy: row.eligibility_policy_json,
    regrantPolicy: row.regrant_policy_json,
    status: row.status,
    effectiveFrom: row.effective_from ? new Date(row.effective_from).toISOString() : undefined,
    effectiveUntil: row.effective_until ? new Date(row.effective_until).toISOString() : undefined,
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at).toISOString(),
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : undefined,
    retiredAt: row.retired_at ? new Date(row.retired_at).toISOString() : undefined,
  };
}

function assignmentFromRow(row: QueryResultRow): DepartmentPackageAssignment {
  return {
    id: row.id,
    departmentId: row.department_id,
    packageVersionId: row.package_version_id,
    isDefault: row.is_default,
    status: row.status,
    assignedByUserId: row.assigned_by_user_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function budgetFromRow(row: QueryResultRow): DepartmentBudgetPeriod {
  return {
    id: row.id,
    departmentId: row.department_id,
    periodType: row.period_type,
    periodStart: new Date(row.period_start).toISOString(),
    periodEnd: new Date(row.period_end).toISOString(),
    budgetQuota: quotaNumber(row.budget_quota, "budgetQuota"),
    committedQuota: quotaNumber(row.committed_quota, "committedQuota"),
    pendingQuota: quotaNumber(row.pending_quota, "pendingQuota"),
    consumedQuota: quotaNumber(row.consumed_quota, "consumedQuota"),
    version: Number(row.version),
    configuredByUserId: row.configured_by_user_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function requestFromRow(row: QueryResultRow): BillingPackageRequest {
  return {
    id: row.id,
    requestKind: row.request_kind,
    userId: row.user_id,
    departmentIdAtRequest: row.department_id_at_request,
    packageDefinitionId: row.package_definition_id,
    packageVersionId: row.package_version_id,
    status: row.status,
    reason: row.reason,
    idempotencyKey: row.idempotency_key,
    approvalTargetOpenId: row.approval_target_open_id ?? undefined,
    approvalTargetSource: row.approval_target_source ?? undefined,
    approvalActionNonceHash: row.approval_action_nonce_hash ?? undefined,
    approvalCardMessageId: row.approval_card_message_id ?? undefined,
    approvalOperatorOpenId: row.approval_operator_open_id ?? undefined,
    approvalOperatedAt: row.approval_operated_at
      ? new Date(row.approval_operated_at).toISOString()
      : undefined,
    billingOperationId: row.billing_operation_id ?? undefined,
    grantId: row.grant_id ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function commitmentFromRow(row: QueryResultRow): DepartmentBudgetCommitment {
  return {
    id: row.id,
    departmentBudgetPeriodId: row.department_budget_period_id,
    departmentId: row.department_id,
    requestId: row.request_id,
    packageVersionId: row.package_version_id,
    grantId: row.grant_id ?? undefined,
    quota: quotaNumber(row.quota, "commitmentQuota"),
    state: row.state,
    idempotencyKey: row.idempotency_key,
    createdAt: new Date(row.created_at).toISOString(),
    committedAt: row.committed_at ? new Date(row.committed_at).toISOString() : undefined,
    releasedAt: row.released_at ? new Date(row.released_at).toISOString() : undefined,
  };
}

function grantFromRow(row: QueryResultRow): UserPackageGrant {
  return {
    id: row.id,
    userId: row.user_id,
    departmentIdAtGrant: row.department_id_at_grant,
    packageDefinitionId: row.package_definition_id,
    packageVersionId: row.package_version_id,
    snapshot: row.snapshot_json,
    grantedQuota: quotaNumber(row.granted_quota, "grantedQuota"),
    allocatedQuota: quotaNumber(row.allocated_quota, "allocatedQuota"),
    startsAt: new Date(row.starts_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    status: row.status,
    sourceRequestId: row.source_request_id,
    budgetCommitmentId: row.budget_commitment_id,
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at).toISOString(),
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : undefined,
    expiredAt: row.expired_at ? new Date(row.expired_at).toISOString() : undefined,
  };
}

function operationFromRow(row: QueryResultRow): BillingOperation {
  return {
    id: row.id,
    operationType: row.operation_type,
    userId: row.user_id,
    departmentId: row.department_id,
    state: row.state,
    idempotencyKey: row.idempotency_key,
    requestPayloadHash: row.request_payload_hash,
    currentStep: row.current_step,
    leaseOwner: row.lease_owner ?? undefined,
    leaseUntil: row.lease_until ? new Date(row.lease_until).toISOString() : undefined,
    lastErrorCode: row.last_error_code ?? undefined,
    lastErrorMessage: row.last_error_message ?? undefined,
    data: row.data ?? {},
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
  };
}

function contextFromRow(row: QueryResultRow): RequestBillingContext {
  return {
    id: row.id,
    sourceIdentity: row.source_identity ?? undefined,
    proxyRequestId: row.proxy_request_id,
    userId: row.user_id,
    departmentIdAtRequest: row.department_id_at_request,
    tokenAccountId: row.token_account_id,
    keyGeneration: Number(row.key_generation),
    candidateGrantIds: row.candidate_grant_ids,
    startedAt: new Date(row.started_at).toISOString(),
    finalizedAt: row.finalized_at ? new Date(row.finalized_at).toISOString() : undefined,
  };
}

function allocationFromRow(row: QueryResultRow): UsageChargeAllocation {
  return {
    id: row.id,
    sourceIdentity: row.source_identity,
    requestBillingContextId: row.request_billing_context_id,
    userId: row.user_id,
    departmentIdAtRequest: row.department_id_at_request,
    packageGrantId: row.package_grant_id,
    quota: quotaNumber(row.quota, "allocationQuota"),
    occurredAt: new Date(row.occurred_at).toISOString(),
    stabilizedAt: new Date(row.stabilized_at).toISOString(),
    idempotencyKey: row.idempotency_key,
  };
}

async function definitionById(client: PoolClient, id: string, lock = false) {
  const result = await client.query(
    `select * from billing_package_definitions where id = $1${lock ? " for update" : ""}`,
    [id],
  );
  return result.rows[0] ? definitionFromRow(result.rows[0]) : null;
}

async function versionById(client: PoolClient, id: string, lock = false) {
  const result = await client.query(
    `select * from billing_package_versions where id = $1${lock ? " for update" : ""}`,
    [id],
  );
  return result.rows[0] ? versionFromRow(result.rows[0]) : null;
}

function requireDefinition(definition: BillingPackageDefinition | null) {
  if (!definition) {
    throw new PackageBillingError(
      "package_resource_not_found",
      "套餐不存在或不在当前管理范围内",
      404,
    );
  }
  return definition;
}

function requireVersion(version: BillingPackageVersion | null) {
  if (!version) {
    throw new PackageBillingError(
      "package_resource_not_found",
      "套餐版本不存在或不在当前管理范围内",
      404,
    );
  }
  return version;
}

export async function createPackageDefinition(input: {
  scope: AdminScope;
  userId: string;
  ownerScopeType: PackageOwnerScopeType;
  ownerDepartmentId?: string;
  code: string;
  name: string;
  description?: string;
}) {
  const ownerDepartmentId = assertCanCreatePackageDefinition(
    input.scope,
    input.ownerScopeType,
    input.ownerDepartmentId,
  );
  const now = nowIso();
  const definition: BillingPackageDefinition = {
    id: randomId("pkg"),
    ownerScopeType: input.ownerScopeType,
    ownerDepartmentId,
    code: input.code,
    name: input.name,
    description: input.description ?? "",
    status: "active",
    createdByUserId: input.userId,
    createdAt: now,
    updatedAt: now,
  };
  try {
    return await withPostgresTransaction(async (client) => {
      const result = await client.query(
        `insert into billing_package_definitions
          (id, owner_scope_type, owner_department_id, code, name, description, status,
           created_by_user_id, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         returning *`,
        [
          definition.id,
          definition.ownerScopeType,
          definition.ownerDepartmentId ?? null,
          definition.code,
          definition.name,
          definition.description,
          definition.status,
          definition.createdByUserId,
          definition.createdAt,
          definition.updatedAt,
        ],
      );
      return definitionFromRow(result.rows[0]);
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("billing_package_definitions_owner_code_unique")) {
      throw new PackageBillingError("package_code_conflict", "当前套餐范围内 code 已存在", 409);
    }
    throw error;
  }
}

export async function listPackageDefinitions(input: {
  scope: AdminScope;
  limit?: number;
  offset?: number;
  status?: BillingPackageDefinition["status"];
}) {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const offset = Math.max(input.offset ?? 0, 0);
  return withPostgresClient(async (client) => {
    const params: unknown[] = [];
    const where: string[] = [];
    if (input.scope.scopeType === "department") {
      params.push(input.scope.departmentId);
      where.push(`(
        (definition.owner_scope_type = 'department' and definition.owner_department_id = $${params.length})
        or exists (
          select 1 from billing_package_versions version
          join department_package_assignments assignment on assignment.package_version_id = version.id
          where version.definition_id = definition.id
            and assignment.department_id = $${params.length}
        )
      )`);
    }
    if (input.status) {
      params.push(input.status);
      where.push(`definition.status = $${params.length}`);
    }
    const clause = where.length ? `where ${where.join(" and ")}` : "";
    const count = await client.query(
      `select count(*)::integer as total from billing_package_definitions definition ${clause}`,
      params,
    );
    params.push(limit, offset);
    const rows = await client.query(
      `select definition.* from billing_package_definitions definition
       ${clause}
       order by definition.updated_at desc, definition.id
       limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    return {
      items: rows.rows.map(definitionFromRow),
      total: Number(count.rows[0]?.total ?? 0),
      limit,
      offset,
    };
  });
}

export async function getPackageDefinition(input: { scope: AdminScope; definitionId: string }) {
  return withPostgresClient(async (client) => {
    const definition = requireDefinition(await definitionById(client, input.definitionId));
    if (input.scope.scopeType === "department") {
      const visible = await client.query(
        `select exists (
          select 1 from billing_package_versions version
          join department_package_assignments assignment on assignment.package_version_id = version.id
          where version.definition_id = $1 and assignment.department_id = $2
        ) as visible`,
        [definition.id, input.scope.departmentId],
      );
      if (
        definition.ownerDepartmentId !== input.scope.departmentId &&
        !visible.rows[0]?.visible
      ) {
        throw new PackageBillingError("package_resource_not_found", "套餐不存在或不在当前管理范围内", 404);
      }
    }
    const versions = await client.query(
      "select * from billing_package_versions where definition_id = $1 order by version desc",
      [definition.id],
    );
    return { definition, versions: versions.rows.map(versionFromRow) };
  });
}

export async function createPackageVersion(input: {
  scope: AdminScope;
  userId: string;
  definitionId: string;
  grantedQuota: number;
  cycleType: PackageCycleType;
  cycleValue: number;
  eligibilityPolicy?: PackageEligibilityPolicy;
  regrantPolicy?: PackageRegrantPolicy;
  effectiveFrom?: string;
  effectiveUntil?: string;
}) {
  assertPositiveRawQuota(input.grantedQuota, "grantedQuota");
  if (!Number.isInteger(input.cycleValue) || input.cycleValue <= 0) {
    throw new PackageBillingError("invalid_package_cycle", "套餐周期值必须是正整数", 400);
  }
  return withPostgresTransaction(async (client) => {
    const definition = requireDefinition(await definitionById(client, input.definitionId, true));
    assertPackageDefinitionInScope(input.scope, definition);
    if (definition.status !== "active") {
      throw new PackageBillingError("package_not_available", "已下架套餐不能创建新版本", 409);
    }
    const latest = await client.query(
      "select coalesce(max(version), 0)::integer as version from billing_package_versions where definition_id = $1",
      [definition.id],
    );
    const now = nowIso();
    const result = await client.query(
      `insert into billing_package_versions
        (id, definition_id, version, granted_quota, cycle_type, cycle_value, timezone,
         eligibility_policy_json, regrant_policy_json, status, effective_from, effective_until,
         created_by_user_id, created_at)
       values ($1,$2,$3,$4,$5,$6,'Asia/Hong_Kong',$7,$8,'draft',$9,$10,$11,$12)
       returning *`,
      [
        randomId("pkgv"),
        definition.id,
        Number(latest.rows[0]?.version ?? 0) + 1,
        input.grantedQuota,
        input.cycleType,
        input.cycleValue,
        input.eligibilityPolicy ?? { allowFirstRequest: true },
        input.regrantPolicy ?? { mode: "exhausted" },
        input.effectiveFrom ?? null,
        input.effectiveUntil ?? null,
        input.userId,
        now,
      ],
    );
    return versionFromRow(result.rows[0]);
  });
}

export async function publishPackageVersion(input: {
  scope: AdminScope;
  versionId: string;
}) {
  return withPostgresTransaction(async (client) => {
    const version = requireVersion(await versionById(client, input.versionId, true));
    const definition = requireDefinition(await definitionById(client, version.definitionId));
    assertPackageDefinitionInScope(input.scope, definition);
    if (version.status !== "draft") {
      throw new PackageBillingError("package_version_immutable", "只有 draft 套餐版本可以发布", 409);
    }
    const result = await client.query(
      `update billing_package_versions
       set status = 'published', published_at = $2
       where id = $1 returning *`,
      [version.id, nowIso()],
    );
    return versionFromRow(result.rows[0]);
  });
}

export async function retirePackageVersion(input: {
  scope: AdminScope;
  versionId: string;
}) {
  return withPostgresTransaction(async (client) => {
    const version = requireVersion(await versionById(client, input.versionId, true));
    const definition = requireDefinition(await definitionById(client, version.definitionId));
    assertPackageDefinitionInScope(input.scope, definition);
    if (version.status !== "published") {
      throw new PackageBillingError("package_version_immutable", "只有 published 套餐版本可以下架", 409);
    }
    const now = nowIso();
    const result = await client.query(
      `update billing_package_versions
       set status = 'retired', retired_at = $2
       where id = $1 returning *`,
      [version.id, now],
    );
    await client.query(
      `update department_package_assignments
       set status = 'disabled', is_default = false, updated_at = $2
       where package_version_id = $1`,
      [version.id, now],
    );
    return versionFromRow(result.rows[0]);
  });
}

export async function listDepartmentPackageAssignments(input: {
  scope: AdminScope;
  departmentId?: string;
}) {
  const departmentId = packageScopeDepartment(input.scope, input.departmentId);
  return withPostgresClient(async (client) => {
    const result = await client.query(
      `select assignment.*, version.granted_quota, version.cycle_type, version.cycle_value,
              version.status as version_status, definition.code, definition.name,
              definition.owner_scope_type, definition.owner_department_id
       from department_package_assignments assignment
       join billing_package_versions version on version.id = assignment.package_version_id
       join billing_package_definitions definition on definition.id = version.definition_id
       where assignment.department_id = $1
       order by assignment.is_default desc, assignment.updated_at desc`,
      [departmentId],
    );
    return result.rows.map((row) => ({
      assignment: assignmentFromRow(row),
      package: {
        code: row.code,
        name: row.name,
        grantedQuota: quotaNumber(row.granted_quota, "grantedQuota"),
        cycleType: row.cycle_type,
        cycleValue: Number(row.cycle_value),
        versionStatus: row.version_status,
        ownerScopeType: row.owner_scope_type,
        ownerDepartmentId: row.owner_department_id ?? undefined,
      },
    }));
  });
}

export async function upsertDepartmentPackageAssignment(input: {
  scope: AdminScope;
  userId: string;
  departmentId?: string;
  packageVersionId: string;
  isDefault: boolean;
  status: DepartmentPackageAssignment["status"];
}) {
  const departmentId = packageScopeDepartment(input.scope, input.departmentId);
  return withPostgresTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `package-assignment:${departmentId}`,
    ]);
    const version = requireVersion(await versionById(client, input.packageVersionId));
    const definition = requireDefinition(await definitionById(client, version.definitionId));
    if (version.status !== "published") {
      throw new PackageBillingError("package_not_available", "只有已发布套餐版本可以指派", 409);
    }
    if (
      definition.ownerScopeType === "department" &&
      definition.ownerDepartmentId !== departmentId
    ) {
      throw new PackageBillingError("assignment_scope_forbidden", "部门套餐不能指派给其他部门", 403);
    }
    const existing = await client.query(
      `select * from department_package_assignments
       where department_id = $1 and package_version_id = $2 for update`,
      [departmentId, version.id],
    );
    if (
      input.scope.scopeType === "department" &&
      definition.ownerScopeType === "global" &&
      existing.rowCount === 0
    ) {
      throw new PackageBillingError(
        "assignment_scope_forbidden",
        "部门主管只能管理已由全局管理员授权给本部门的全局套餐",
        403,
      );
    }
    const now = nowIso();
    if (input.isDefault && input.status === "active") {
      await client.query(
        `update department_package_assignments
         set is_default = false, updated_at = $2
         where department_id = $1 and is_default`,
        [departmentId, now],
      );
    }
    const result = await client.query(
      `insert into department_package_assignments
        (id, department_id, package_version_id, is_default, status,
         assigned_by_user_id, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$7)
       on conflict (department_id, package_version_id) do update set
         is_default = excluded.is_default,
         status = excluded.status,
         assigned_by_user_id = excluded.assigned_by_user_id,
         updated_at = excluded.updated_at
       returning *`,
      [
        existing.rows[0]?.id ?? randomId("pkga"),
        departmentId,
        version.id,
        input.status === "active" && input.isDefault,
        input.status,
        input.userId,
        now,
      ],
    );
    return assignmentFromRow(result.rows[0]);
  });
}

export async function upsertDepartmentBudget(input: {
  scope: AdminScope;
  userId: string;
  departmentId: string;
  periodType: DepartmentBudgetPeriod["periodType"];
  periodStart: string;
  periodEnd: string;
  budgetQuota: number;
}) {
  assertCanConfigureDepartmentBudget(input.scope);
  assertRawQuota(input.budgetQuota, "budgetQuota");
  if (new Date(input.periodEnd) <= new Date(input.periodStart)) {
    throw new PackageBillingError("invalid_budget_period", "部门预算结束时间必须晚于开始时间", 400);
  }
  return withPostgresTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `department-budget:${input.departmentId}:${input.periodStart}:${input.periodEnd}`,
    ]);
    const existing = await client.query(
      `select * from department_budget_periods
       where department_id = $1 and period_start = $2 and period_end = $3
       for update`,
      [input.departmentId, input.periodStart, input.periodEnd],
    );
    const row = existing.rows[0];
    const committed = quotaNumber(row?.committed_quota ?? 0, "committedQuota");
    const pending = quotaNumber(row?.pending_quota ?? 0, "pendingQuota");
    if (input.budgetQuota < committed + pending) {
      throw new PackageBillingError(
        "department_budget_below_commitments",
        "部门总预算不能低于已承诺额度与审批中额度之和",
        409,
      );
    }
    const now = nowIso();
    const result = await client.query(
      `insert into department_budget_periods
        (id, department_id, period_type, period_start, period_end, budget_quota,
         committed_quota, pending_quota, consumed_quota, version,
         configured_by_user_id, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,0,0,0,1,$7,$8,$8)
       on conflict (department_id, period_start, period_end) do update set
         period_type = excluded.period_type,
         budget_quota = excluded.budget_quota,
         version = department_budget_periods.version + 1,
         configured_by_user_id = excluded.configured_by_user_id,
         updated_at = excluded.updated_at
       returning *`,
      [
        row?.id ?? randomId("budget"),
        input.departmentId,
        input.periodType,
        input.periodStart,
        input.periodEnd,
        input.budgetQuota,
        input.userId,
        now,
      ],
    );
    return budgetFromRow(result.rows[0]);
  });
}

export async function getDepartmentBudgetOverview(input: {
  scope: AdminScope;
  departmentId?: string;
  at?: string;
}) {
  const departmentId = packageScopeDepartment(input.scope, input.departmentId);
  const at = input.at ?? nowIso();
  return withPostgresClient(async (client) => {
    const budgetResult = await client.query(
      `select * from department_budget_periods
       where department_id = $1 and period_start <= $2 and period_end > $2
       order by period_start desc limit 1`,
      [departmentId, at],
    );
    const budget = budgetResult.rows[0] ? budgetFromRow(budgetResult.rows[0]) : null;
    const assignmentResult = await client.query(
      `select version.id, version.granted_quota, definition.code, definition.name
       from department_package_assignments assignment
       join billing_package_versions version on version.id = assignment.package_version_id
       join billing_package_definitions definition on definition.id = version.definition_id
       where assignment.department_id = $1 and assignment.status = 'active'
         and version.status = 'published'
       order by assignment.is_default desc, definition.name, version.version desc`,
      [departmentId],
    );
    return {
      budget,
      availableQuota: budget ? availableDepartmentBudget(budget) : 0,
      packages: assignmentResult.rows.map((row) => {
        const version = { grantedQuota: quotaNumber(row.granted_quota, "grantedQuota") };
        return {
          packageVersionId: row.id,
          code: row.code,
          name: row.name,
          grantedQuota: version.grantedQuota,
          issuableCount: budget ? issuablePackageCount(budget, version) : 0,
        };
      }),
    };
  });
}

export async function listAvailablePackagesForDepartment(departmentId: string, at = nowIso()) {
  return withPostgresClient(async (client) => {
    const result = await client.query(
      `select assignment.*,
              version.id as version_id, version.definition_id, version.version,
              version.granted_quota, version.cycle_type, version.cycle_value,
              version.timezone, version.eligibility_policy_json, version.regrant_policy_json,
              version.status as version_status, version.effective_from, version.effective_until,
              version.created_by_user_id as version_created_by_user_id,
              version.created_at as version_created_at, version.published_at, version.retired_at,
              definition.id as package_definition_id, definition.code, definition.name,
              definition.description, definition.owner_scope_type, definition.owner_department_id,
              definition.status as definition_status,
              definition.created_by_user_id as definition_created_by_user_id,
              definition.created_at as definition_created_at,
              definition.updated_at as definition_updated_at
       from department_package_assignments assignment
       join billing_package_versions version on version.id = assignment.package_version_id
       join billing_package_definitions definition on definition.id = version.definition_id
       where assignment.department_id = $1
         and assignment.status = 'active'
         and version.status = 'published'
         and definition.status = 'active'
         and (version.effective_from is null or version.effective_from <= $2)
         and (version.effective_until is null or version.effective_until > $2)
       order by assignment.is_default desc, definition.name, version.version desc`,
      [departmentId, at],
    );
    return result.rows.map((row) => ({
      assignment: assignmentFromRow(row),
      definition: definitionFromRow({
        id: row.package_definition_id,
        owner_scope_type: row.owner_scope_type,
        owner_department_id: row.owner_department_id,
        code: row.code,
        name: row.name,
        description: row.description,
        status: row.definition_status,
        created_by_user_id: row.definition_created_by_user_id,
        created_at: row.definition_created_at,
        updated_at: row.definition_updated_at,
      }),
      version: versionFromRow({
        id: row.version_id,
        definition_id: row.definition_id,
        version: row.version,
        granted_quota: row.granted_quota,
        cycle_type: row.cycle_type,
        cycle_value: row.cycle_value,
        timezone: row.timezone,
        eligibility_policy_json: row.eligibility_policy_json,
        regrant_policy_json: row.regrant_policy_json,
        status: row.version_status,
        effective_from: row.effective_from,
        effective_until: row.effective_until,
        created_by_user_id: row.version_created_by_user_id,
        created_at: row.version_created_at,
        published_at: row.published_at,
        retired_at: row.retired_at,
      }),
    }));
  });
}

export async function listUserPackageGrants(input: {
  userId: string;
  includeHistory?: boolean;
}) {
  return withPostgresClient(async (client) => {
    const result = await client.query(
      `select * from user_package_grants
       where user_id = $1
         and ($2::boolean or (status = 'active' and expires_at > $3))
       order by expires_at, starts_at, id`,
      [input.userId, input.includeHistory ?? false, nowIso()],
    );
    return result.rows.map(grantFromRow);
  });
}

export async function getUserPackageBalance(userId: string, at = nowIso()) {
  return withPostgresClient(async (client) => {
    const result = await client.query(
      `select * from user_package_grants
       where user_id = $1 and status = 'active' and starts_at <= $2 and expires_at > $2
       order by expires_at, starts_at, id`,
      [userId, at],
    );
    const grants = result.rows.map(grantFromRow);
    const grantedQuota = grants.reduce((sum, item) => sum + item.grantedQuota, 0);
    const allocatedQuota = grants.reduce((sum, item) => sum + item.allocatedQuota, 0);
    return {
      grants,
      grantedQuota: assertRawQuota(grantedQuota, "grantedQuota"),
      allocatedQuota: assertRawQuota(allocatedQuota, "allocatedQuota"),
      availableQuota: assertRawQuota(grantedQuota - allocatedQuota, "availableQuota"),
    };
  });
}

export async function listUserPackageRequests(userId: string) {
  return withPostgresClient(async (client) => {
    const result = await client.query(
      `select * from billing_package_requests
       where user_id = $1 order by created_at desc, id`,
      [userId],
    );
    return result.rows.map(requestFromRow);
  });
}

export async function findPackageRequestById(requestId: string) {
  return withPostgresClient(async (client) => {
    const result = await client.query(
      "select * from billing_package_requests where id = $1",
      [requestId],
    );
    return result.rows[0] ? requestFromRow(result.rows[0]) : null;
  });
}

export async function createPackageRequestReservation(input: {
  userId: string;
  departmentId: string;
  packageVersionId: string;
  requestKind: "first" | "regrant" | "admin_grant";
  reason: string;
  clientRequestId: string;
  approvalActionNonceHash: string;
}) {
  const idempotencyKey = `package-${input.requestKind}:${input.userId}:${input.clientRequestId}`;
  return withPostgresTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `department-budget:${input.departmentId}`,
    ]);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `user-package:${input.userId}`,
    ]);
    const existing = await client.query(
      "select * from billing_package_requests where idempotency_key = $1",
      [idempotencyKey],
    );
    if (existing.rows[0]) {
      const request = requestFromRow(existing.rows[0]);
      if (
        request.userId !== input.userId ||
        request.packageVersionId !== input.packageVersionId ||
        request.requestKind !== input.requestKind
      ) {
        throw new PackageBillingError(
          "idempotency_payload_conflict",
          "相同 clientRequestId 已用于不同套餐申请",
          409,
        );
      }
      return { request, reused: true as const };
    }

    const user = await client.query(
      "select department_id, data from feishu_users where id = $1 for update",
      [input.userId],
    );
    if (!user.rows[0] || user.rows[0].department_id !== input.departmentId) {
      throw new PackageBillingError(
        "user_department_changed",
        "用户部门已变化，请刷新后重新申请套餐",
        409,
      );
    }
    const version = requireVersion(await versionById(client, input.packageVersionId));
    const definition = requireDefinition(await definitionById(client, version.definitionId));
    const now = nowIso();
    if (
      version.status !== "published" ||
      definition.status !== "active" ||
      (version.effectiveFrom && version.effectiveFrom > now) ||
      (version.effectiveUntil && version.effectiveUntil <= now)
    ) {
      throw new PackageBillingError("package_not_available", "套餐当前不可申请", 409);
    }
    const assignment = await client.query(
      `select * from department_package_assignments
       where department_id = $1 and package_version_id = $2 and status = 'active'
       for update`,
      [input.departmentId, version.id],
    );
    if (!assignment.rows[0]) {
      throw new PackageBillingError("package_not_assigned", "套餐未指派给当前部门", 409);
    }
    const grantRows = await client.query(
      `select * from user_package_grants
       where user_id = $1 and status = 'active' and expires_at > $2
       order by expires_at, starts_at, id for update`,
      [input.userId, now],
    );
    const activeGrants = grantRows.rows.map(grantFromRow);
    if (input.requestKind === "first" && activeGrants.length > 0) {
      throw new PackageBillingError(
        "package_first_request_conflict",
        "当前用户已有有效套餐，只能按策略申请重发",
        409,
      );
    }
    if (input.requestKind === "regrant") {
      const sameVersion = activeGrants.filter((grant) => grant.packageVersionId === version.id);
      if (sameVersion.length === 0) {
        throw new PackageBillingError(
          "package_regrant_not_eligible",
          "当前没有可重发的同版本套餐",
          409,
        );
      }
      const aggregate = {
        ...sameVersion[0],
        grantedQuota: sameVersion.reduce((sum, grant) => sum + grant.grantedQuota, 0),
        allocatedQuota: sameVersion.reduce((sum, grant) => sum + grant.allocatedQuota, 0),
        expiresAt: sameVersion.map((grant) => grant.expiresAt).sort().at(-1) ?? sameVersion[0].expiresAt,
      };
      if (!canUserRequestRegrant({ grant: aggregate, policy: version.regrantPolicy, now })) {
        throw new PackageBillingError(
          "package_regrant_not_eligible",
          "当前套餐尚未达到重发条件",
          409,
        );
      }
    }
    const budgetResult = await client.query(
      `select * from department_budget_periods
       where department_id = $1 and period_start <= $2 and period_end > $2
       order by period_start desc limit 1 for update`,
      [input.departmentId, now],
    );
    if (!budgetResult.rows[0]) {
      throw new PackageBillingError(
        "department_budget_unconfigured",
        "当前部门没有覆盖本时段的总预算",
        409,
      );
    }
    const budget = budgetFromRow(budgetResult.rows[0]);
    if (availableDepartmentBudget(budget) < version.grantedQuota) {
      throw new PackageBillingError(
        "department_budget_exhausted",
        "部门可发额度不足，无法预留该套餐",
        409,
      );
    }
    const requestId = randomId("pkgr"), commitmentId = randomId("budgetc");
    const requestResult = await client.query(
      `insert into billing_package_requests
        (id, request_kind, user_id, department_id_at_request, package_definition_id,
         package_version_id, status, reason, idempotency_key, approval_action_nonce_hash,
         created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,'pending_card_send',$7,$8,$9,$10,$10)
       returning *`,
      [
        requestId,
        input.requestKind,
        input.userId,
        input.departmentId,
        definition.id,
        version.id,
        input.reason,
        idempotencyKey,
        input.approvalActionNonceHash,
        now,
      ],
    );
    const commitmentResult = await client.query(
      `insert into department_budget_commitments
        (id, department_budget_period_id, department_id, request_id, package_version_id,
         quota, state, idempotency_key, created_at)
       values ($1,$2,$3,$4,$5,$6,'reserved',$7,$8)
       returning *`,
      [
        commitmentId,
        budget.id,
        input.departmentId,
        requestId,
        version.id,
        version.grantedQuota,
        `package-reservation:${requestId}`,
        now,
      ],
    );
    await client.query(
      `update department_budget_periods
       set pending_quota = pending_quota + $2, version = version + 1, updated_at = $3
       where id = $1`,
      [budget.id, version.grantedQuota, now],
    );
    return {
      request: requestFromRow(requestResult.rows[0]),
      commitment: commitmentFromRow(commitmentResult.rows[0]),
      definition,
      version,
      reused: false as const,
    };
  });
}

async function releaseRequestReservation(
  client: PoolClient,
  requestId: string,
  now: string,
) {
  const commitmentResult = await client.query(
    `select * from department_budget_commitments
     where request_id = $1 for update`,
    [requestId],
  );
  const commitment = commitmentResult.rows[0]
    ? commitmentFromRow(commitmentResult.rows[0])
    : null;
  if (!commitment || commitment.state !== "reserved") return commitment;
  const budgetResult = await client.query(
    "select * from department_budget_periods where id = $1 for update",
    [commitment.departmentBudgetPeriodId],
  );
  const budget = budgetFromRow(budgetResult.rows[0]);
  if (budget.pendingQuota < commitment.quota) {
    throw new PackageBillingError(
      "department_budget_invariant_broken",
      "释放套餐预留时部门审批中额度不足",
      500,
    );
  }
  await client.query(
    `update department_budget_commitments
     set state = 'released', released_at = $2 where id = $1`,
    [commitment.id, now],
  );
  await client.query(
    `update department_budget_periods
     set pending_quota = pending_quota - $2, version = version + 1, updated_at = $3
     where id = $1`,
    [budget.id, commitment.quota, now],
  );
  return { ...commitment, state: "released" as const, releasedAt: now };
}

export async function updatePackageRequestDelivery(input: {
  requestId: string;
  approvalTargetOpenId?: string;
  approvalTargetSource?: BillingPackageRequest["approvalTargetSource"];
  approvalCardMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
}) {
  return withPostgresTransaction(async (client) => {
    const current = await client.query(
      "select * from billing_package_requests where id = $1 for update",
      [input.requestId],
    );
    if (!current.rows[0]) {
      throw new PackageBillingError("package_resource_not_found", "套餐申请不存在", 404);
    }
    const request = requestFromRow(current.rows[0]);
    if (request.status !== "pending_card_send") return request;
    const now = nowIso();
    const status = input.approvalCardMessageId
      ? "pending_card_approval"
      : "approval_card_send_failed";
    if (status === "approval_card_send_failed") {
      await releaseRequestReservation(client, request.id, now);
    }
    const result = await client.query(
      `update billing_package_requests set
         status = $2,
         approval_target_open_id = coalesce($3, approval_target_open_id),
         approval_target_source = coalesce($4, approval_target_source),
         approval_card_message_id = coalesce($5, approval_card_message_id),
         error_code = $6,
         error_message = $7,
         updated_at = $8
       where id = $1 returning *`,
      [
        request.id,
        status,
        input.approvalTargetOpenId ?? null,
        input.approvalTargetSource ?? null,
        input.approvalCardMessageId ?? null,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        now,
      ],
    );
    return requestFromRow(result.rows[0]);
  });
}

export async function listAdminPackageRequests(input: {
  scope: AdminScope;
  limit?: number;
  offset?: number;
  status?: BillingPackageRequest["status"];
}) {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const offset = Math.max(input.offset ?? 0, 0);
  return withPostgresClient(async (client) => {
    const params: unknown[] = [];
    const where: string[] = [];
    if (input.scope.scopeType === "department") {
      params.push(input.scope.departmentId);
      where.push(`request.department_id_at_request = $${params.length}`);
    }
    if (input.status) {
      params.push(input.status);
      where.push(`request.status = $${params.length}`);
    }
    const clause = where.length ? `where ${where.join(" and ")}` : "";
    const count = await client.query(
      `select count(*)::integer as total from billing_package_requests request ${clause}`,
      params,
    );
    params.push(limit, offset);
    const result = await client.query(
      `select request.*, definition.code as package_code, definition.name as package_name,
              version.version as package_version, version.granted_quota,
              user_row.data as user_data
       from billing_package_requests request
       join billing_package_definitions definition on definition.id = request.package_definition_id
       join billing_package_versions version on version.id = request.package_version_id
       join feishu_users user_row on user_row.id = request.user_id
       ${clause}
       order by request.created_at desc, request.id
       limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    return {
      items: result.rows.map((row) => ({
        request: requestFromRow(row),
        package: {
          code: row.package_code,
          name: row.package_name,
          version: Number(row.package_version),
          grantedQuota: quotaNumber(row.granted_quota, "grantedQuota"),
        },
        user: row.user_data,
      })),
      total: Number(count.rows[0]?.total ?? 0),
      limit,
      offset,
    };
  });
}

export async function getScopedPackageRequest(input: {
  scope: AdminScope;
  requestId: string;
}) {
  return withPostgresClient(async (client) => {
    const result = await client.query(
      "select * from billing_package_requests where id = $1",
      [input.requestId],
    );
    if (!result.rows[0]) return null;
    const request = requestFromRow(result.rows[0]);
    if (
      input.scope.scopeType === "department" &&
      request.departmentIdAtRequest !== input.scope.departmentId
    ) {
      return null;
    }
    return request;
  });
}

export async function decidePackageRequest(input: {
  scope: AdminScope;
  operatedByUserId: string;
  operatedByOpenId: string;
  requestId: string;
  action: "approve" | "reject" | "cancel";
}) {
  return withPostgresTransaction(async (client) => {
    const requestResult = await client.query(
      "select * from billing_package_requests where id = $1 for update",
      [input.requestId],
    );
    if (!requestResult.rows[0]) {
      throw new PackageBillingError(
        "package_resource_not_found",
        "套餐申请不存在或不在当前管理范围内",
        404,
      );
    }
    const request = requestFromRow(requestResult.rows[0]);
    packageScopeDepartment(input.scope, request.departmentIdAtRequest);
    if (input.action !== "approve") {
      const target = input.action === "reject" ? "rejected" : "cancelled";
      if (request.status === target) return { request, grant: null, operation: null, reused: true };
      if (request.status !== "pending_card_approval" && request.status !== "pending_card_send") {
        throw new PackageBillingError(
          "package_request_state_conflict",
          "当前套餐申请状态不能拒绝或取消",
          409,
        );
      }
      const now = nowIso();
      await releaseRequestReservation(client, request.id, now);
      const updated = await client.query(
        `update billing_package_requests set
           status = $2, approval_operator_open_id = $3, approval_operated_at = $4,
           updated_at = $4
         where id = $1 returning *`,
        [request.id, target, input.operatedByOpenId, now],
      );
      return { request: requestFromRow(updated.rows[0]), grant: null, operation: null, reused: false };
    }

    if (request.status === "approved_provisioning" || request.status === "provisioned") {
      const grantResult = request.grantId
        ? await client.query("select * from user_package_grants where id = $1", [request.grantId])
        : { rows: [] };
      const operationResult = request.billingOperationId
        ? await client.query("select * from billing_operations where id = $1", [request.billingOperationId])
        : { rows: [] };
      return {
        request,
        grant: grantResult.rows[0] ? grantFromRow(grantResult.rows[0]) : null,
        operation: operationResult.rows[0] ? operationFromRow(operationResult.rows[0]) : null,
        reused: true,
      };
    }
    if (request.status !== "pending_card_approval" && request.status !== "pending_card_send") {
      throw new PackageBillingError(
        "package_request_state_conflict",
        "当前套餐申请状态不能批准",
        409,
      );
    }
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `department-budget:${request.departmentIdAtRequest}`,
    ]);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `user-package:${request.userId}`,
    ]);
    const commitmentResult = await client.query(
      `select * from department_budget_commitments
       where request_id = $1 for update`,
      [request.id],
    );
    if (!commitmentResult.rows[0]) {
      throw new PackageBillingError(
        "package_reservation_missing",
        "套餐申请缺少部门预算预留",
        500,
      );
    }
    const commitment = commitmentFromRow(commitmentResult.rows[0]);
    if (commitment.state !== "reserved") {
      throw new PackageBillingError(
        "package_request_state_conflict",
        "套餐预算预留已终态，不能批准",
        409,
      );
    }
    const budgetResult = await client.query(
      "select * from department_budget_periods where id = $1 for update",
      [commitment.departmentBudgetPeriodId],
    );
    const budget = budgetFromRow(budgetResult.rows[0]);
    if (budget.pendingQuota < commitment.quota) {
      throw new PackageBillingError(
        "department_budget_invariant_broken",
        "批准套餐时部门审批中额度不足",
        500,
      );
    }
    const version = requireVersion(await versionById(client, request.packageVersionId));
    const definition = requireDefinition(await definitionById(client, request.packageDefinitionId));
    if (version.status !== "published" || definition.status !== "active") {
      throw new PackageBillingError(
        "package_not_available",
        "套餐已下架，不能完成发放",
        409,
      );
    }
    const now = nowIso();
    const window = packageGrantWindow({
      cycleType: version.cycleType,
      cycleValue: version.cycleValue,
      timezone: version.timezone,
      startsAt: now,
    });
    const grantId = randomId("grant");
    const operationId = randomId("bop");
    const operationType =
      request.requestKind === "first"
        ? "first_grant"
        : request.requestKind === "regrant"
          ? "regrant"
          : "admin_grant";
    const payload = {
      requestId: request.id,
      packageVersionId: version.id,
      grantId,
      grantedQuota: version.grantedQuota,
    };
    const operationResult = await client.query(
      `insert into billing_operations
        (id, operation_type, user_id, department_id, state, idempotency_key,
         request_payload_hash, current_step, data, created_at, updated_at)
       values ($1,$2,$3,$4,'grant_committed',$5,$6,'grant_committed',$7,$8,$8)
       returning *`,
      [
        operationId,
        operationType,
        request.userId,
        request.departmentIdAtRequest,
        `package-${request.requestKind}:${request.id}`,
        sha256Hex(JSON.stringify(payload)),
        payload,
        now,
      ],
    );
    const snapshot = {
      packageCode: definition.code,
      packageName: definition.name,
      packageDescription: definition.description,
      version: version.version,
      grantedQuota: version.grantedQuota,
      cycleType: version.cycleType,
      cycleValue: version.cycleValue,
      timezone: version.timezone,
      eligibilityPolicy: version.eligibilityPolicy,
      regrantPolicy: version.regrantPolicy,
    };
    const grantResult = await client.query(
      `insert into user_package_grants
        (id, user_id, department_id_at_grant, package_definition_id, package_version_id,
         snapshot_json, granted_quota, allocated_quota, starts_at, expires_at, status,
         source_request_id, budget_commitment_id, created_by_user_id, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,'active',$10,$11,$12,$13)
       returning *`,
      [
        grantId,
        request.userId,
        request.departmentIdAtRequest,
        definition.id,
        version.id,
        snapshot,
        version.grantedQuota,
        window.startsAt,
        window.expiresAt,
        request.id,
        commitment.id,
        input.operatedByUserId,
        now,
      ],
    );
    await client.query(
      `update department_budget_commitments
       set state = 'committed', grant_id = $2, committed_at = $3
       where id = $1`,
      [commitment.id, grantId, now],
    );
    await client.query(
      `update department_budget_periods set
         pending_quota = pending_quota - $2,
         committed_quota = committed_quota + $2,
         version = version + 1,
         updated_at = $3
       where id = $1`,
      [budget.id, commitment.quota, now],
    );
    const updatedRequest = await client.query(
      `update billing_package_requests set
         status = 'approved_provisioning', approval_operator_open_id = $2,
         approval_operated_at = $3, billing_operation_id = $4, grant_id = $5,
         error_code = null, error_message = null, updated_at = $3
       where id = $1 returning *`,
      [request.id, input.operatedByOpenId, now, operationId, grantId],
    );
    return {
      request: requestFromRow(updatedRequest.rows[0]),
      grant: grantFromRow(grantResult.rows[0]),
      operation: operationFromRow(operationResult.rows[0]),
      reused: false,
    };
  });
}

export async function getPackageProvisioningContext(requestId: string) {
  return withPostgresClient(async (client) => {
    const requestResult = await client.query(
      "select * from billing_package_requests where id = $1",
      [requestId],
    );
    if (!requestResult.rows[0]) {
      throw new PackageBillingError("package_resource_not_found", "套餐申请不存在", 404);
    }
    const request = requestFromRow(requestResult.rows[0]);
    const grantResult = request.grantId
      ? await client.query("select * from user_package_grants where id = $1", [request.grantId])
      : { rows: [] };
    const operationResult = request.billingOperationId
      ? await client.query("select * from billing_operations where id = $1", [request.billingOperationId])
      : { rows: [] };
    const balanceResult = await client.query(
      `select coalesce(sum(granted_quota - allocated_quota), 0)::bigint as available_quota
       from user_package_grants
       where user_id = $1 and status = 'active' and starts_at <= $2 and expires_at > $2`,
      [request.userId, nowIso()],
    );
    return {
      request,
      grant: grantResult.rows[0] ? grantFromRow(grantResult.rows[0]) : null,
      operation: operationResult.rows[0] ? operationFromRow(operationResult.rows[0]) : null,
      availableQuota: quotaNumber(balanceResult.rows[0]?.available_quota ?? 0, "availableQuota"),
    };
  });
}

export async function updatePackageProvisioningState(input: {
  requestId: string;
  state: "upstream_applying" | "upstream_applied" | "completed" | "retryable_failed" | "manual_review";
  currentStep: string;
  tokenAccountId?: string;
  errorCode?: string;
  errorMessage?: string;
}) {
  return withPostgresTransaction(async (client) => {
    const requestResult = await client.query(
      "select * from billing_package_requests where id = $1 for update",
      [input.requestId],
    );
    if (!requestResult.rows[0]) {
      throw new PackageBillingError("package_resource_not_found", "套餐申请不存在", 404);
    }
    const request = requestFromRow(requestResult.rows[0]);
    if (!request.billingOperationId) {
      throw new PackageBillingError("billing_operation_missing", "套餐发放缺少 operation", 500);
    }
    const now = nowIso();
    const operationResult = await client.query(
      `update billing_operations set
         state = $2, current_step = $3, last_error_code = $4, last_error_message = $5,
         data = data || $6::jsonb, updated_at = $7,
         completed_at = case when $2 = 'completed' then $7 else completed_at end
       where id = $1 returning *`,
      [
        request.billingOperationId,
        input.state,
        input.currentStep,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        JSON.stringify(input.tokenAccountId ? { tokenAccountId: input.tokenAccountId } : {}),
        now,
      ],
    );
    const requestStatus = input.state === "completed" ? "provisioned" : "approved_provisioning";
    const updatedRequest = await client.query(
      `update billing_package_requests set
         status = $2, error_code = $3, error_message = $4, updated_at = $5
       where id = $1 returning *`,
      [
        request.id,
        requestStatus,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        now,
      ],
    );
    return {
      request: requestFromRow(updatedRequest.rows[0]),
      operation: operationFromRow(operationResult.rows[0]),
    };
  });
}

export async function createPackageKeyRotationOperation(input: {
  userId: string;
  departmentId: string;
  clientRequestId: string;
  reason: string;
  oldTokenAccountId: string;
  oldGeneration: number;
  targetAvailableQuota: number;
}) {
  return withPostgresTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `user-package:${input.userId}`,
    ]);
    const idempotencyKey = `package-key-rotation:${input.userId}:${input.clientRequestId}`;
    const payload = {
      userId: input.userId,
      departmentId: input.departmentId,
      reason: input.reason,
      oldTokenAccountId: input.oldTokenAccountId,
      oldGeneration: input.oldGeneration,
      targetAvailableQuota: assertRawQuota(input.targetAvailableQuota, "targetAvailableQuota"),
    };
    const requestPayloadHash = sha256Hex(JSON.stringify(payload));
    const existing = await client.query(
      "select * from billing_operations where idempotency_key = $1 for update",
      [idempotencyKey],
    );
    if (existing.rows[0]) {
      const operation = operationFromRow(existing.rows[0]);
      if (operation.requestPayloadHash !== requestPayloadHash) {
        throw new PackageBillingError(
          "idempotency_payload_conflict",
          "同一 Key 更换幂等键对应了不同请求",
          409,
        );
      }
      return { operation, reused: true as const };
    }
    const now = nowIso();
    const result = await client.query(
      `insert into billing_operations
        (id, operation_type, user_id, department_id, state, idempotency_key,
         request_payload_hash, current_step, data, created_at, updated_at)
       values ($1,'key_rotation',$2,$3,'planned',$4,$5,'planned',$6,$7,$7)
       returning *`,
      [randomId("bop"), input.userId, input.departmentId, idempotencyKey, requestPayloadHash, payload, now],
    );
    return { operation: operationFromRow(result.rows[0]), reused: false as const };
  });
}

export async function updatePackageBillingOperation(input: {
  operationId: string;
  userId: string;
  state: BillingOperation["state"];
  currentStep: string;
  data?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}) {
  return withPostgresTransaction(async (client) => {
    const now = nowIso();
    const result = await client.query(
      `update billing_operations set
         state = $3,
         current_step = $4,
         data = data || $5::jsonb,
         last_error_code = $6,
         last_error_message = $7,
         updated_at = $8,
         completed_at = case when $3 = 'completed' then $8 else completed_at end
       where id = $1 and user_id = $2 and operation_type = 'key_rotation'
       returning *`,
      [
        input.operationId,
        input.userId,
        input.state,
        input.currentStep,
        JSON.stringify(input.data ?? {}),
        input.errorCode ?? null,
        input.errorMessage ?? null,
        now,
      ],
    );
    if (!result.rows[0]) {
      throw new PackageBillingError("billing_operation_missing", "Key 更换 operation 不存在", 404);
    }
    return operationFromRow(result.rows[0]);
  });
}

export async function listUserPackageOperations(userId: string, limit = 30) {
  return withPostgresClient(async (client) => {
    const result = await client.query(
      `select * from billing_operations
       where user_id = $1
       order by created_at desc, id desc
       limit $2`,
      [userId, Math.min(Math.max(limit, 1), 100)],
    );
    return result.rows.map(operationFromRow);
  });
}

export async function beginRequestBillingContext(input: {
  proxyRequestId: string;
  userId: string;
  departmentId: string;
  tokenAccount: TokenAccount;
  startedAt?: string;
}) {
  return withPostgresTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `user-package:${input.userId}`,
    ]);
    const existing = await client.query(
      "select * from request_billing_contexts where proxy_request_id = $1",
      [input.proxyRequestId],
    );
    if (existing.rows[0]) {
      const context = contextFromRow(existing.rows[0]);
      if (
        context.userId !== input.userId ||
        context.tokenAccountId !== input.tokenAccount.id ||
        context.departmentIdAtRequest !== input.departmentId
      ) {
        throw new PackageBillingError(
          "idempotency_payload_conflict",
          "同一 proxy request 已冻结不同计费上下文",
          409,
        );
      }
      return context;
    }
    const startedAt = input.startedAt ?? nowIso();
    const grantResult = await client.query(
      `select * from user_package_grants
       where user_id = $1 and status = 'active'
         and starts_at <= $2 and expires_at > $2
         and allocated_quota < granted_quota
       order by expires_at, starts_at, id`,
      [input.userId, startedAt],
    );
    const grants = grantResult.rows.map(grantFromRow);
    const availableQuota = grants.reduce(
      (sum, grant) => sum + grant.grantedQuota - grant.allocatedQuota,
      0,
    );
    if (availableQuota <= 0) {
      throw new PackageBillingError(
        "package_quota_exhausted",
        "当前用户没有可用于本次请求的套餐额度",
        409,
      );
    }
    const result = await client.query(
      `insert into request_billing_contexts
        (id, source_identity, proxy_request_id, user_id, department_id_at_request,
         token_account_id, key_generation, candidate_grant_ids, started_at)
       values ($1,null,$2,$3,$4,$5,$6,$7,$8)
       returning *`,
      [
        randomId("ctx"),
        input.proxyRequestId,
        input.userId,
        input.departmentId,
        input.tokenAccount.id,
        input.tokenAccount.operationGeneration ?? 0,
        JSON.stringify(grants.map((grant) => grant.id)),
        startedAt,
      ],
    );
    return contextFromRow(result.rows[0]);
  });
}

function usageSourceIdentity(record: NewApiUsageRecord) {
  if (record.newapiTokenId && record.newapiRequestId) {
    return `request:${record.newapiTokenId}:${record.newapiRequestId}`;
  }
  if (record.newapiTokenId && record.newapiLogId) {
    return `log:${record.newapiTokenId}:${record.newapiLogId}`;
  }
  throw new PackageBillingError(
    "authoritative_usage_identity_missing",
    "NewAPI 权威用量缺少稳定 source identity",
    409,
  );
}

export async function allocateAuthoritativeUsageRecord(usageRecordId: string) {
  return withPostgresTransaction(async (client) => {
    const usageResult = await client.query<{ data: NewApiUsageRecord }>(
      "select data from newapi_usage_records where id = $1 for update",
      [usageRecordId],
    );
    const usage = usageResult.rows[0]?.data;
    if (!usage || usage.matchStatus !== "matched" || !usage.matchedProxyLogId) {
      throw new PackageBillingError(
        "authoritative_usage_not_matched",
        "NewAPI 权威用量尚未稳定匹配 proxy request",
        409,
        true,
      );
    }
    const contextResult = await client.query(
      "select * from request_billing_contexts where proxy_request_id = $1 for update",
      [usage.matchedProxyLogId],
    );
    if (!contextResult.rows[0]) {
      throw new PackageBillingError(
        "request_billing_context_missing",
        "匹配请求缺少冻结套餐计费上下文",
        500,
      );
    }
    const context = contextFromRow(contextResult.rows[0]);
    const sourceIdentity = usageSourceIdentity(usage);
    if (context.sourceIdentity && context.sourceIdentity !== sourceIdentity) {
      throw new PackageBillingError(
        "authoritative_usage_identity_conflict",
        "请求计费上下文已绑定其他 NewAPI source",
        409,
      );
    }
    const authoritativeQuota = quotaNumber(usage.quota, "authoritativeQuota");
    const existing = await client.query(
      `select * from usage_charge_allocations
       where source_identity = $1 order by package_grant_id`,
      [sourceIdentity],
    );
    if (existing.rows.length > 0) {
      const allocations = existing.rows.map(allocationFromRow);
      const total = allocations.reduce((sum, item) => sum + item.quota, 0);
      if (total !== authoritativeQuota) {
        throw new PackageBillingError(
          "authoritative_usage_allocation_conflict",
          "已有 allocation 总和与 NewAPI 权威用量不一致",
          500,
        );
      }
      return { context, allocations, authoritativeQuota, reused: true as const };
    }
    if (authoritativeQuota === 0) {
      await client.query(
        `update request_billing_contexts
         set source_identity = $2, finalized_at = $3 where id = $1`,
        [context.id, sourceIdentity, nowIso()],
      );
      return { context, allocations: [], authoritativeQuota, reused: false as const };
    }
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `user-package:${context.userId}`,
    ]);
    const grantsResult = await client.query(
      `select * from user_package_grants
       where id = any($1::text[]) and user_id = $2
       order by expires_at, starts_at, id for update`,
      [context.candidateGrantIds, context.userId],
    );
    const grants = grantsResult.rows.map((row) => ({
      ...grantFromRow(row),
      status: "active" as const,
    }));
    if (grants.length !== context.candidateGrantIds.length) {
      throw new PackageBillingError(
        "request_billing_context_invalid",
        "冻结计费上下文中的 grant 已不完整",
        500,
      );
    }
    const plan = planGrantAllocations(grants, authoritativeQuota);
    const occurredAt = usage.newapiCreatedAt ?? usage.lastSyncedAt;
    const stabilizedAt = nowIso();
    const allocations: UsageChargeAllocation[] = [];
    for (const item of plan) {
      const allocationResult = await client.query(
        `insert into usage_charge_allocations
          (id, source_identity, request_billing_context_id, user_id,
           department_id_at_request, package_grant_id, quota, occurred_at,
           stabilized_at, idempotency_key)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         returning *`,
        [
          randomId("alloc"),
          sourceIdentity,
          context.id,
          context.userId,
          context.departmentIdAtRequest,
          item.grantId,
          item.quota,
          occurredAt,
          stabilizedAt,
          `usage-allocation:${sourceIdentity}`,
        ],
      );
      allocations.push(allocationFromRow(allocationResult.rows[0]));
      await client.query(
        `update user_package_grants set
           allocated_quota = allocated_quota + $2,
           status = case when allocated_quota + $2 = granted_quota then 'exhausted' else status end
         where id = $1`,
        [item.grantId, item.quota],
      );
      const budgetResult = await client.query(
        `select budget.id
         from user_package_grants grant_row
         join department_budget_commitments commitment
           on commitment.id = grant_row.budget_commitment_id
         join department_budget_periods budget
           on budget.id = commitment.department_budget_period_id
         where grant_row.id = $1 for update of budget`,
        [item.grantId],
      );
      if (!budgetResult.rows[0]) {
        throw new PackageBillingError(
          "department_budget_commitment_missing",
          "allocation 对应 grant 缺少部门预算承诺",
          500,
        );
      }
      await client.query(
        `update department_budget_periods set
           consumed_quota = consumed_quota + $2,
           version = version + 1,
           updated_at = $3
         where id = $1`,
        [budgetResult.rows[0].id, item.quota, stabilizedAt],
      );
    }
    await client.query(
      `update request_billing_contexts
       set source_identity = $2, finalized_at = $3 where id = $1`,
      [context.id, sourceIdentity, stabilizedAt],
    );
    await client.query(
      `insert into billing_operations
        (id, operation_type, user_id, department_id, state, idempotency_key,
         request_payload_hash, current_step, data, created_at, updated_at, completed_at)
       values ($1,'usage_allocation',$2,$3,'completed',$4,$5,'completed',$6,$7,$7,$7)
       on conflict (idempotency_key) do nothing`,
      [
        randomId("bop"),
        context.userId,
        context.departmentIdAtRequest,
        `usage-allocation:${sourceIdentity}`,
        sha256Hex(JSON.stringify({ sourceIdentity, authoritativeQuota })),
        { usageRecordId, sourceIdentity, authoritativeQuota },
        stabilizedAt,
      ],
    );
    return { context, allocations, authoritativeQuota, reused: false as const };
  });
}

export async function listAdminPackageGrants(input: {
  scope: AdminScope;
  limit?: number;
  offset?: number;
  userId?: string;
  status?: UserPackageGrant["status"];
}) {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const offset = Math.max(input.offset ?? 0, 0);
  return withPostgresClient(async (client) => {
    const params: unknown[] = [];
    const where: string[] = [];
    if (input.scope.scopeType === "department") {
      params.push(input.scope.departmentId);
      where.push(`grant_row.department_id_at_grant = $${params.length}`);
    }
    if (input.userId) {
      params.push(input.userId);
      where.push(`grant_row.user_id = $${params.length}`);
    }
    if (input.status) {
      params.push(input.status);
      where.push(`grant_row.status = $${params.length}`);
    }
    const clause = where.length ? `where ${where.join(" and ")}` : "";
    const count = await client.query(
      `select count(*)::integer as total from user_package_grants grant_row ${clause}`,
      params,
    );
    params.push(limit, offset);
    const result = await client.query(
      `select grant_row.*, user_row.data as user_data
       from user_package_grants grant_row
       join feishu_users user_row on user_row.id = grant_row.user_id
       ${clause}
       order by grant_row.created_at desc, grant_row.id
       limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    return {
      items: result.rows.map((row) => ({ grant: grantFromRow(row), user: row.user_data })),
      total: Number(count.rows[0]?.total ?? 0),
      limit,
      offset,
    };
  });
}

export async function revokePackageGrant(input: {
  scope: AdminScope;
  grantId: string;
  operatedByUserId: string;
  reason: string;
  revision: string;
}) {
  return withPostgresTransaction(async (client) => {
    const grantResult = await client.query(
      "select * from user_package_grants where id = $1 for update",
      [input.grantId],
    );
    if (!grantResult.rows[0]) {
      throw new PackageBillingError(
        "package_resource_not_found",
        "套餐 grant 不存在或不在当前管理范围内",
        404,
      );
    }
    const grant = grantFromRow(grantResult.rows[0]);
    packageScopeDepartment(input.scope, grant.departmentIdAtGrant);
    if (grant.status === "revoked") return { grant, reused: true as const };
    if (grant.status === "expired") {
      throw new PackageBillingError("package_grant_state_conflict", "已到期 grant 不能撤销", 409);
    }
    const idempotencyKey = `package-revoke:${grant.id}:${input.revision}`;
    const existing = await client.query(
      "select * from billing_operations where idempotency_key = $1",
      [idempotencyKey],
    );
    if (existing.rows[0]) {
      return { grant, operation: operationFromRow(existing.rows[0]), reused: true as const };
    }
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `user-package:${grant.userId}`,
    ]);
    const now = nowIso();
    const updated = await client.query(
      `update user_package_grants
       set status = 'revoked', revoked_at = $2 where id = $1 returning *`,
      [grant.id, now],
    );
    const payload = { grantId: grant.id, reason: input.reason, revision: input.revision };
    const operationResult = await client.query(
      `insert into billing_operations
        (id, operation_type, user_id, department_id, state, idempotency_key,
         request_payload_hash, current_step, data, created_at, updated_at, completed_at)
       values ($1,'grant_revoke',$2,$3,'completed',$4,$5,'grant_revoked',$6,$7,$7,$7)
       returning *`,
      [
        randomId("bop"),
        grant.userId,
        grant.departmentIdAtGrant,
        idempotencyKey,
        sha256Hex(JSON.stringify(payload)),
        { ...payload, operatedByUserId: input.operatedByUserId },
        now,
      ],
    );
    return {
      grant: grantFromRow(updated.rows[0]),
      operation: operationFromRow(operationResult.rows[0]),
      reused: false as const,
    };
  });
}

export async function getPackageBillingReport(input: {
  scope: AdminScope;
  limit?: number;
  offset?: number;
}) {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const offset = Math.max(input.offset ?? 0, 0);
  return withPostgresClient(async (client) => {
    const departmentId = input.scope.scopeType === "department" ? input.scope.departmentId : null;
    const summary = await client.query(
      `select
         (select coalesce(sum(granted_quota),0)::bigint from user_package_grants
          where ($1::text is null or department_id_at_grant = $1)) as granted_quota,
         (select coalesce(sum(allocated_quota),0)::bigint from user_package_grants
          where ($1::text is null or department_id_at_grant = $1)) as allocated_quota,
         (select count(*)::integer from user_package_grants
          where ($1::text is null or department_id_at_grant = $1)) as grant_count,
         (select count(*)::integer from billing_package_requests
          where status in ('pending_card_send','pending_card_approval','approved','approved_provisioning')
            and ($1::text is null or department_id_at_request = $1)) as open_request_count,
         (select coalesce(sum(quota),0)::bigint from usage_charge_allocations
          where ($1::text is null or department_id_at_request = $1)) as authoritative_consumed_quota`,
      [departmentId],
    );
    const total = await client.query(
      `select count(*)::integer as total from usage_charge_allocations
       where ($1::text is null or department_id_at_request = $1)`,
      [departmentId],
    );
    const allocations = await client.query(
      `select allocation.*, grant_row.snapshot_json, user_row.data as user_data
       from usage_charge_allocations allocation
       join user_package_grants grant_row on grant_row.id = allocation.package_grant_id
       join feishu_users user_row on user_row.id = allocation.user_id
       where ($1::text is null or allocation.department_id_at_request = $1)
       order by allocation.occurred_at desc, allocation.id
       limit $2 offset $3`,
      [departmentId, limit, offset],
    );
    const row = summary.rows[0];
    return {
      summary: {
        grantedQuota: quotaNumber(row.granted_quota, "grantedQuota"),
        allocatedQuota: quotaNumber(row.allocated_quota, "allocatedQuota"),
        availableQuota: quotaNumber(
          Number(row.granted_quota) - Number(row.allocated_quota),
          "availableQuota",
        ),
        authoritativeConsumedQuota: quotaNumber(
          row.authoritative_consumed_quota,
          "authoritativeConsumedQuota",
        ),
        grantCount: Number(row.grant_count),
        openRequestCount: Number(row.open_request_count),
      },
      items: allocations.rows.map((item) => ({
        allocation: allocationFromRow(item),
        package: item.snapshot_json,
        user: item.user_data,
      })),
      total: Number(total.rows[0]?.total ?? 0),
      limit,
      offset,
    };
  });
}
