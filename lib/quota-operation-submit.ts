import { Pool, type PoolClient } from "pg";
import {
  resolveSessionAdminScopeProjection,
  tokenRequestInAdminScope,
} from "@/lib/admin-scope";
import { getConfig } from "@/lib/config";
import { nowIso, randomId, sha256Hex } from "@/lib/crypto";
import { toNewApiQuota } from "@/lib/newapi";
import { packageBillingPeriod } from "@/lib/package-reset";
import {
  canReopenFirstProvisionAfterAccessRevoke,
  reopenFirstProvisionAfterAccessRevoke,
} from "@/lib/quota-saga-state";
import {
  tokenRequestAllowsQuotaEdit,
  tokenRequestRequiresAdminDecision,
} from "@/lib/token-request-policy";
import type {
  AdminScope,
  AppSettings,
  DepartmentQuotaPeriod,
  FeishuUser,
  QuotaOperation,
  TokenAccount,
  TokenRequest,
  UserBillingPeriod,
} from "@/lib/types";

type QuotaSubmitRuntime = typeof globalThis & {
  __tokenInsideQuotaSubmitPool?: Pool;
  __tokenInsideQuotaSubmitWarmPromise?: Promise<void>;
};

// Next.js emits independent route chunks. A module-local Pool would therefore
// multiply the reserved lane per route and instrumentation would warm a
// different instance. globalThis is shared by all chunks in this Node process.
const quotaSubmitRuntime = globalThis as QuotaSubmitRuntime;

export class QuotaSubmissionError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds?: number;

  constructor(input: {
    status: number;
    code: string;
    message: string;
    retryAfterSeconds?: number;
  }) {
    super(input.message);
    this.name = "QuotaSubmissionError";
    this.status = input.status;
    this.code = input.code;
    this.retryAfterSeconds = input.retryAfterSeconds;
  }
}

function submissionError(
  status: number,
  code: string,
  message: string,
  retryAfterSeconds?: number,
) {
  return new QuotaSubmissionError({ status, code, message, retryAfterSeconds });
}

function getQuotaSubmitPool() {
  if (quotaSubmitRuntime.__tokenInsideQuotaSubmitPool) {
    return quotaSubmitRuntime.__tokenInsideQuotaSubmitPool;
  }
  const config = getConfig();
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required for durable quota submission");
  }
  quotaSubmitRuntime.__tokenInsideQuotaSubmitPool = new Pool({
    connectionString: config.databaseUrl,
    max: config.postgres.quotaSubmitPoolMax,
    min: config.postgres.quotaSubmitPoolMax,
    idleTimeoutMillis: config.postgres.poolIdleTimeoutMs,
    connectionTimeoutMillis: config.postgres.quotaSubmitConnectionTimeoutMs,
  });
  return quotaSubmitRuntime.__tokenInsideQuotaSubmitPool;
}

export function quotaSubmitPoolRuntimeSnapshot() {
  return {
    total: quotaSubmitRuntime.__tokenInsideQuotaSubmitPool?.totalCount ?? 0,
    idle: quotaSubmitRuntime.__tokenInsideQuotaSubmitPool?.idleCount ?? 0,
    waiting: quotaSubmitRuntime.__tokenInsideQuotaSubmitPool?.waitingCount ?? 0,
    max: getConfig().postgres.quotaSubmitPoolMax,
  };
}

export async function warmQuotaSubmitPool() {
  const config = getConfig();
  if (config.storeBackend !== "postgres") return;
  if (!quotaSubmitRuntime.__tokenInsideQuotaSubmitWarmPromise) {
    quotaSubmitRuntime.__tokenInsideQuotaSubmitWarmPromise = (async () => {
      const pool = getQuotaSubmitPool();
      const clients = await Promise.all(
        Array.from({ length: config.postgres.quotaSubmitPoolMax }, () => pool.connect()),
      );
      try {
        await Promise.all(clients.map((client) => client.query("select 1")));
      } finally {
        for (const client of clients) client.release();
      }
    })().catch((error) => {
      quotaSubmitRuntime.__tokenInsideQuotaSubmitWarmPromise = undefined;
      throw error;
    });
  }
  await quotaSubmitRuntime.__tokenInsideQuotaSubmitWarmPromise;
}

function transientSubmissionFailure(error: unknown) {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    ["53300", "55P03", "57014", "57P01", "57P02", "57P03", "ETIMEDOUT"].includes(code) ||
    /timeout|too many clients|connection terminated/i.test(message)
  );
}

async function withQuotaSubmitTransaction<T>(fn: (client: PoolClient) => Promise<T>) {
  let client: PoolClient;
  try {
    client = await getQuotaSubmitPool().connect();
  } catch (error) {
    throw submissionError(
      503,
      "quota_submission_busy",
      "额度操作受理队列繁忙，请使用相同幂等键稍后重试",
      1,
    );
  }

  try {
    await client.query("begin");
    const config = getConfig();
    await client.query(
      `set local lock_timeout = '${config.postgres.quotaSubmitLockTimeoutMs}ms'`,
    );
    await client.query(
      `set local statement_timeout = '${config.postgres.quotaSubmitStatementTimeoutMs}ms'`,
    );
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (error instanceof QuotaSubmissionError) throw error;
    if (transientSubmissionFailure(error)) {
      throw submissionError(
        503,
        "quota_submission_busy",
        "额度操作未能在受理时限内持久化，请使用相同幂等键重试",
        1,
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

async function saveTokenRequestRow(client: PoolClient, request: TokenRequest) {
  const result = await client.query<{ data: TokenRequest }>(
    `insert into token_requests
      (id, feishu_user_id, request_type, status, approval_action_nonce_hash,
       approval_instance_code, approval_department_id, approval_target_open_id,
       data, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (id) do update set
       feishu_user_id = excluded.feishu_user_id,
       request_type = excluded.request_type,
       status = excluded.status,
       approval_action_nonce_hash = excluded.approval_action_nonce_hash,
       approval_instance_code = excluded.approval_instance_code,
       approval_department_id = excluded.approval_department_id,
       approval_target_open_id = excluded.approval_target_open_id,
       data = excluded.data,
       updated_at = excluded.updated_at
     returning data`,
    [
      request.id,
      request.feishuUserId,
      request.requestType,
      request.status,
      request.approvalActionNonceHash ?? null,
      request.approvalInstanceCode ?? null,
      request.approvalDepartmentId ?? null,
      request.approvalTargetOpenId ?? null,
      request,
      request.createdAt,
      request.updatedAt,
    ],
  );
  return result.rows[0].data;
}

async function insertQuotaOperationRow(client: PoolClient, operation: QuotaOperation) {
  const result = await client.query<{ data: QuotaOperation }>(
    `insert into quota_operations
      (id, operation_type, idempotency_key, feishu_user_id, department_id,
       billing_period, state, operation_generation, next_retry_at, data,
       created_at, updated_at, completed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, null, $9, $10, $10, null)
     returning data`,
    [
      operation.id,
      operation.operationType,
      operation.idempotencyKey,
      operation.feishuUserId,
      operation.departmentId ?? null,
      operation.billingPeriod,
      operation.state,
      operation.operationGeneration,
      operation,
      operation.createdAt,
    ],
  );
  return result.rows[0].data;
}

async function currentPackageBillingPeriodForSubmission(client: PoolClient) {
  const result = await client.query<{
    data: AppSettings;
    current_time: Date | string;
  }>(
    `select data, statement_timestamp() as current_time
     from app_settings
     where id = 'default'
     limit 1`,
  );
  const row = result.rows[0];
  const currentTime =
    row?.current_time instanceof Date
      ? row.current_time
      : new Date(row?.current_time ?? Date.now());
  return packageBillingPeriod(row?.data.packageReset, currentTime);
}

const adminDefaultApprovalOpenId = "system:admin-default";

export function adminDefaultProvisioningIdempotencyKey(
  feishuUserId: string,
  period: string,
) {
  return `admin-default-first-provision:${feishuUserId}:${period}`;
}

function adminDefaultProvisioningIdentity(feishuUserId: string, period: string) {
  const digest = sha256Hex(`${feishuUserId}:${period}`).slice(0, 28);
  return {
    requestId: `tr_admin_${digest}`,
    approvalUuid: `approval_admin_${digest}`,
    idempotencyKey: adminDefaultProvisioningIdempotencyKey(feishuUserId, period),
  };
}

async function readTokenRequestById(client: PoolClient, requestId?: string) {
  if (!requestId) return null;
  const result = await client.query<{ data: TokenRequest }>(
    "select data from token_requests where id = $1 limit 1",
    [requestId],
  );
  return result.rows[0]?.data ?? null;
}

export type AdminDefaultProvisioningSubmission =
  | {
      status: "active";
      tokenAccount: TokenAccount;
      deduplicated: true;
    }
  | {
      status: "provisioning";
      request: TokenRequest | null;
      operation: QuotaOperation;
      deduplicated: boolean;
    }
  | {
      status: "deferred";
      request: TokenRequest | null;
      operation?: QuotaOperation;
      reason: "conflicting_operation" | "terminal_operation_without_active_key";
      deduplicated: true;
    }
  | {
      status: "skipped";
      reason: "inactive_user" | "admin_scope_missing";
      deduplicated: true;
    };

/**
 * Atomically accepts an administrator's default first-provision job.
 *
 * This transaction only reads and writes local control-plane rows. NewAPI
 * calls and Saga execution remain owned by the durable quota worker.
 */
export async function submitPostgresAdminDefaultProvisioning(input: {
  feishuUserId: string;
}): Promise<AdminDefaultProvisioningSubmission> {
  return withQuotaSubmitTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `user-quota:${input.feishuUserId}`,
    ]);

    const period = await currentPackageBillingPeriodForSubmission(client);
    const identity = adminDefaultProvisioningIdentity(input.feishuUserId, period);
    const result = await client.query<{
      user_data: FeishuUser | null;
      active_scope: AdminScope | null;
      assigned_request: TokenRequest | null;
      scopes: AdminScope[];
      active_account: TokenAccount | null;
      idempotent: QuotaOperation | null;
      open_operation: QuotaOperation | null;
      reusable_request: TokenRequest | null;
      department_period: DepartmentQuotaPeriod | null;
      settings: AppSettings;
      generation: number;
    }>(
      `with target_user as materialized (
         select data, open_id, department_id
         from feishu_users
         where id = $1
         for share
       ), active_scope as materialized (
         select data
         from admin_scopes
         where feishu_user_id = $1 and status = 'active'
         order by case when scope_type = 'global' then 0 else 1 end,
                  updated_at desc,
                  id
         limit 1
         for share
       ), active_account as materialized (
         select data
         from token_accounts
         where feishu_user_id = $1 and status = 'active'
         order by created_at desc, id desc
         limit 1
         for share
       )
       select
         (select data from target_user) as user_data,
         (select data from active_scope) as active_scope,
         (select request.data
          from token_requests request
          where request.approval_target_open_id = (select open_id from target_user)
          order by request.updated_at desc, request.id
          limit 1) as assigned_request,
         coalesce(
           (select jsonb_agg(scope.data order by scope.updated_at desc, scope.id)
            from admin_scopes scope
            where scope.feishu_user_id = $1),
           '[]'::jsonb
         ) as scopes,
         (select data from active_account) as active_account,
         (select data
          from quota_operations
          where idempotency_key = $3
          limit 1) as idempotent,
         (select data
          from quota_operations
          where feishu_user_id = $1
            and state not in ('completed', 'compensated', 'cancelled')
          order by created_at desc, id
          limit 1) as open_operation,
         (select request.data
          from token_requests request
          where request.feishu_user_id = $1
            and request.request_type = 'first_apply'
            and request.status in (
              'pending_card_send',
              'pending_card_approval',
              'approval_card_send_failed',
              'approval_route_failed',
              'pending_feishu_approval',
              'approved',
              'approved_provisioning',
              'approved_provision_failed'
            )
          order by request.updated_at desc, request.id
          limit 1) as reusable_request,
         (select quota_period.data
          from department_quota_periods quota_period
          where quota_period.department_id = (select department_id from target_user)
            and quota_period.period = $2
          limit 1) as department_period,
         coalesce(
           (select data from app_settings where id = 'default'),
           '{"defaultMonthlyQuota":200}'::jsonb
         ) as settings,
         coalesce(
           (select active_generation from user_quota_states where feishu_user_id = $1),
           (select max(operation_generation) from token_accounts where feishu_user_id = $1),
           0
         )::integer as generation`,
      [input.feishuUserId, period, identity.idempotencyKey],
    );
    const row = result.rows[0];
    const user = row?.user_data;
    if (!user || (user.status && user.status !== "active")) {
      return { status: "skipped", reason: "inactive_user", deduplicated: true };
    }

    const scope = resolveSessionAdminScopeProjection({
      user,
      systemAdminOpenIds: new Set(getConfig().admin.systemAdminOpenIds),
      activeScope: row.active_scope,
      assignedRequest: row.assigned_request,
      scopes: row.scopes ?? [],
    });
    if (!scope) {
      return { status: "skipped", reason: "admin_scope_missing", deduplicated: true };
    }
    if (row.active_account) {
      return { status: "active", tokenAccount: row.active_account, deduplicated: true };
    }

    const monthlyQuota = Math.round(
      row.department_period?.defaultGrantQuota ?? row.settings.defaultMonthlyQuota,
    );
    if (!Number.isFinite(monthlyQuota) || monthlyQuota <= 0) {
      throw submissionError(
        409,
        "admin_default_quota_unavailable",
        "管理员默认发放额度未配置为正整数",
      );
    }

    if (row.idempotent) {
      if (
        row.idempotent.feishuUserId !== user.id ||
        row.idempotent.operationType !== "first_provision"
      ) {
        throw submissionError(409, "idempotency_conflict", "管理员默认发放幂等键已被其他操作使用");
      }
      const request = await readTokenRequestById(client, row.idempotent.requestId);
      if (canReopenFirstProvisionAfterAccessRevoke(row.idempotent)) {
        if (row.open_operation) {
          return {
            status: "deferred",
            request,
            operation: row.open_operation,
            reason: "conflicting_operation",
            deduplicated: true,
          };
        }
        const now = nowIso();
        const reopenedRequest: TokenRequest = {
          ...(request ?? {
            id: identity.requestId,
            feishuUserId: user.id,
            requestType: "first_apply" as const,
            reason: "管理员默认 Key 自动发放",
            approvalUuid: identity.approvalUuid,
            createdAt: now,
          }),
          feishuUserId: user.id,
          requestType: "first_apply",
          status: "approved_provisioning",
          reason: request?.reason || "管理员默认 Key 自动发放",
          requestedMonthlyQuota: monthlyQuota,
          approvedMonthlyQuota: monthlyQuota,
          approvalDepartmentId: user.departmentId,
          approvalMode: "manual",
          approvalOperatorOpenId: adminDefaultApprovalOpenId,
          approvalOperatedAt: now,
          errorMessage: undefined,
          updatedAt: now,
        };
        const storedRequest = await saveTokenRequestRow(client, reopenedRequest);
        const reopened = reopenFirstProvisionAfterAccessRevoke(row.idempotent, {
          departmentId: user.departmentId,
          requestedAssignedQuota: toNewApiQuota(monthlyQuota),
          operationGeneration: (row.generation ?? 0) + 1,
          requestId: storedRequest.id,
          reopenedAt: now,
        });
        const updated = await client.query<{ data: QuotaOperation }>(
          `update quota_operations
              set department_id = $2,
                  state = $3,
                  operation_generation = $4,
                  next_retry_at = null,
                  worker_lease_id = null,
                  worker_lease_expires_at = null,
                  data = $5,
                  updated_at = $6,
                  completed_at = null
            where id = $1
              and operation_type = 'first_provision'
              and state = 'cancelled'
            returning data`,
          [
            reopened.id,
            reopened.departmentId ?? null,
            reopened.state,
            reopened.operationGeneration,
            reopened,
            reopened.updatedAt,
          ],
        );
        if (!updated.rows[0]) {
          throw submissionError(
            409,
            "admin_default_reopen_conflict",
            "管理员默认发放取消任务状态已变化，请重试",
          );
        }
        return {
          status: "provisioning",
          request: storedRequest,
          operation: updated.rows[0].data,
          deduplicated: true,
        };
      }
      if (["completed", "compensated", "cancelled", "manual_review"].includes(row.idempotent.state)) {
        return {
          status: "deferred",
          request,
          operation: row.idempotent,
          reason: "terminal_operation_without_active_key",
          deduplicated: true,
        };
      }
      return {
        status: "provisioning",
        request,
        operation: row.idempotent,
        deduplicated: true,
      };
    }

    if (row.open_operation) {
      const request = await readTokenRequestById(client, row.open_operation.requestId);
      if (row.open_operation.operationType === "first_provision") {
        return {
          status: "provisioning",
          request,
          operation: row.open_operation,
          deduplicated: true,
        };
      }
      return {
        status: "deferred",
        request,
        operation: row.open_operation,
        reason: "conflicting_operation",
        deduplicated: true,
      };
    }

    const now = nowIso();
    const reusable = row.reusable_request;
    const request: TokenRequest = {
      ...(reusable ?? {
        id: identity.requestId,
        feishuUserId: user.id,
        requestType: "first_apply" as const,
        reason: "管理员默认 Key 自动发放",
        approvalUuid: identity.approvalUuid,
        createdAt: now,
      }),
      feishuUserId: user.id,
      requestType: "first_apply",
      status: "approved_provisioning",
      reason: reusable?.reason || "管理员默认 Key 自动发放",
      requestedMonthlyQuota: monthlyQuota,
      approvedMonthlyQuota: monthlyQuota,
      approvalDepartmentId: user.departmentId,
      approvalMode: "manual",
      approvalOperatorOpenId: adminDefaultApprovalOpenId,
      approvalOperatedAt: now,
      errorMessage: undefined,
      updatedAt: now,
    };
    const operation: QuotaOperation = {
      id: randomId("qo"),
      operationType: "first_provision",
      idempotencyKey: identity.idempotencyKey,
      feishuUserId: user.id,
      departmentId: user.departmentId,
      billingPeriod: period,
      requestedAssignedQuota: toNewApiQuota(monthlyQuota),
      reservedDepartmentQuota: 0,
      operationGeneration: (row.generation ?? 0) + 1,
      state: "planned",
      attemptCount: 0,
      requestId: request.id,
      createdByOpenId: adminDefaultApprovalOpenId,
      createdAt: now,
      updatedAt: now,
    };
    const storedRequest = await saveTokenRequestRow(client, request);
    const storedOperation = await insertQuotaOperationRow(client, operation);
    return {
      status: "provisioning",
      request: storedRequest,
      operation: storedOperation,
      deduplicated: false,
    };
  });
}

async function readAdminActorScope(client: PoolClient, actorUserId: string) {
  const result = await client.query<{
    actor_data: FeishuUser | null;
    active_scope: AdminScope | null;
    assigned_request: TokenRequest | null;
    scopes: AdminScope[];
  }>(
    `with actor as materialized (
       select data, open_id
       from feishu_users
       where id = $1
       for share
     ), active_scope as materialized (
       select data
       from admin_scopes
       where feishu_user_id = $1 and status = 'active'
       order by case when scope_type = 'global' then 0 else 1 end,
                updated_at desc,
                id
       limit 1
       for share
     )
     select
       (select data from actor) as actor_data,
       (select data from active_scope) as active_scope,
       (select request.data
        from token_requests request
        where request.approval_target_open_id = (select open_id from actor)
        order by request.updated_at desc, request.id
        limit 1) as assigned_request,
       coalesce(
         (select jsonb_agg(scope.data order by scope.updated_at desc, scope.id)
          from admin_scopes scope
          where scope.feishu_user_id = $1),
         '[]'::jsonb
       ) as scopes`,
    [actorUserId],
  );
  const row = result.rows[0];
  const actor = row?.actor_data;
  if (!actor) {
    throw submissionError(401, "session_user_missing", "飞书 OAuth 会话对应的用户不存在");
  }
  if (actor.status && actor.status !== "active") {
    throw submissionError(403, "session_user_inactive", "当前用户已禁用或删除");
  }
  const scope = resolveSessionAdminScopeProjection({
    user: actor,
    systemAdminOpenIds: new Set(getConfig().admin.systemAdminOpenIds),
    activeScope: row?.active_scope ?? null,
    assignedRequest: row?.assigned_request ?? null,
    scopes: row?.scopes ?? [],
  });
  if (!scope) {
    throw submissionError(403, "admin_scope_required", "当前飞书用户没有启用的 TokenInside 管理范围");
  }
  return { actor, scope };
}

async function lockAdminScopeUsersForSubmission(
  client: PoolClient,
  feishuUserIds: string[],
) {
  for (const feishuUserId of [...new Set(feishuUserIds)].sort()) {
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `admin-scope-user:${feishuUserId}`,
    ]);
  }
}

export async function updatePostgresTokenRequestQuotaAsActor(input: {
  actorUserId: string;
  requestId: string;
  approvedMonthlyQuota: number;
}) {
  if (
    !Number.isInteger(input.approvedMonthlyQuota) ||
    input.approvedMonthlyQuota <= 0 ||
    input.approvedMonthlyQuota > 1_000_000
  ) {
    throw submissionError(400, "quota_invalid", "最终额度必须是正整数");
  }
  return withQuotaSubmitTransaction(async (client) => {
    const initial = await readRequestAndUser(client, input.requestId, false);
    if (!initial) {
      throw submissionError(
        404,
        "token_request_not_found",
        "申请单不存在或不在当前管理范围内",
      );
    }
    await lockAdminScopeUsersForSubmission(client, [
      input.actorUserId,
      initial.request_data.feishuUserId,
    ]);
    const { scope } = await readAdminActorScope(client, input.actorUserId);
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `user-quota:${initial.request_data.feishuUserId}`,
    ]);
    const locked = await readRequestAndUser(client, input.requestId, true);
    if (!locked) {
      throw submissionError(404, "token_request_not_found", "申请单不存在");
    }
    assertRequestScope(locked.request_data, locked.user_data, scope);
    if (!tokenRequestAllowsQuotaEdit(locked.request_data)) {
      throw submissionError(
        409,
        "token_request_quota_not_editable",
        "当前记录不是可修改额度的审批申请",
      );
    }
    const operation = await client.query(
      "select 1 from quota_operations where idempotency_key = $1 limit 1",
      [`quota-operation:${locked.request_data.id}`],
    );
    if ((operation.rowCount ?? 0) > 0) {
      throw submissionError(
        409,
        "token_request_operation_exists",
        "额度操作已经受理，不能再修改申请额度",
      );
    }
    return saveTokenRequestRow(client, {
      ...locked.request_data,
      approvedMonthlyQuota: input.approvedMonthlyQuota,
      updatedAt: nowIso(),
    });
  });
}

export async function rejectPostgresTokenRequestAsActor(input: {
  actorUserId: string;
  requestId: string;
}) {
  return withQuotaSubmitTransaction(async (client) => {
    const initial = await readRequestAndUser(client, input.requestId, false);
    if (!initial) {
      throw submissionError(
        404,
        "token_request_not_found",
        "申请单不存在或不在当前管理范围内",
      );
    }
    await lockAdminScopeUsersForSubmission(client, [
      input.actorUserId,
      initial.request_data.feishuUserId,
    ]);
    const { actor, scope } = await readAdminActorScope(client, input.actorUserId);
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `user-quota:${initial.request_data.feishuUserId}`,
    ]);
    const locked = await readRequestAndUser(client, input.requestId, true);
    if (!locked) {
      throw submissionError(404, "token_request_not_found", "申请单不存在");
    }
    assertRequestScope(locked.request_data, locked.user_data, scope);
    if (!tokenRequestRequiresAdminDecision(locked.request_data)) {
      throw submissionError(
        409,
        "token_request_not_actionable",
        "当前记录不是可人工处理的审批申请",
      );
    }
    const operation = await client.query(
      "select 1 from quota_operations where idempotency_key = $1 limit 1",
      [`quota-operation:${locked.request_data.id}`],
    );
    if ((operation.rowCount ?? 0) > 0) {
      throw submissionError(
        409,
        "token_request_operation_exists",
        "额度操作已经受理，不能再拒绝该申请",
      );
    }
    const now = nowIso();
    return saveTokenRequestRow(client, {
      ...locked.request_data,
      status: "rejected",
      approvalOperatorOpenId: actor.openId,
      approvalOperatedAt: now,
      updatedAt: now,
    });
  });
}

function assertAdminActorCanTargetUser(
  actor: FeishuUser,
  scope: AdminScope,
  targetUser: FeishuUser,
) {
  if (scope.feishuUserId !== actor.id) {
    throw submissionError(403, "admin_scope_required", "当前管理员权限已变化，请刷新后重试");
  }
  const environmentRoot = getConfig().admin.systemAdminOpenIds.includes(
    targetUser.openId,
  );
  const actorIsRoot =
    scope.scopeType === "global" &&
    scope.source === "environment" &&
    scope.role === "root";
  if (environmentRoot && !actorIsRoot) {
    throw submissionError(403, "root_required", "环境变量 root 用户仅允许 root 管理员操作");
  }
  if (
    scope.scopeType !== "global" &&
    (!targetUser.departmentId || targetUser.departmentId !== scope.departmentId)
  ) {
    throw submissionError(404, "target_user_not_found", "用户不存在或不在当前管理范围内");
  }
}

function assertRootActorForGlobalAdminTarget(
  actorScope: AdminScope,
  targetScope: AdminScope | null,
) {
  if (targetScope?.scopeType !== "global") return;
  if (
    actorScope.scopeType === "global" &&
    actorScope.source === "environment" &&
    actorScope.role === "root"
  ) {
    return;
  }
  throw submissionError(
    403,
    "root_required",
    "系统管理员用户仅允许 root 管理员执行额度操作",
  );
}

async function readOptionalAdminScopeForUser(
  client: PoolClient,
  user: FeishuUser,
) {
  const result = await client.query<{
    active_scope: AdminScope | null;
    assigned_request: TokenRequest | null;
    scopes: AdminScope[];
  }>(
    `select
       (select data
        from admin_scopes
        where feishu_user_id = $1 and status = 'active'
        order by case when scope_type = 'global' then 0 else 1 end,
                 updated_at desc,
                 id
        limit 1) as active_scope,
       (select request.data
        from token_requests request
        where request.approval_target_open_id = $2
        order by request.updated_at desc, request.id
        limit 1) as assigned_request,
       coalesce(
         (select jsonb_agg(scope.data order by scope.updated_at desc, scope.id)
          from admin_scopes scope
          where scope.feishu_user_id = $1),
         '[]'::jsonb
       ) as scopes`,
    [user.id, user.openId],
  );
  const row = result.rows[0];
  return resolveSessionAdminScopeProjection({
    user,
    systemAdminOpenIds: new Set(getConfig().admin.systemAdminOpenIds),
    activeScope: row?.active_scope ?? null,
    assignedRequest: row?.assigned_request ?? null,
    scopes: row?.scopes ?? [],
  });
}

async function readRequestAndUser(client: PoolClient, requestId: string, lock: boolean) {
  const result = await client.query<{
    request_data: TokenRequest;
    user_data: FeishuUser | null;
  }>(
    `select request.data as request_data, request_user.data as user_data
     from token_requests request
     join feishu_users request_user on request_user.id = request.feishu_user_id
     where request.id = $1
     ${lock ? "for update of request, request_user" : ""}`,
    [requestId],
  );
  return result.rows[0] ?? null;
}

function assertRequestScope(
  request: TokenRequest,
  requestUser: FeishuUser | null,
  scope: AdminScope,
) {
  const users = new Map<string, FeishuUser>();
  if (requestUser) users.set(requestUser.id, requestUser);
  if (
    !tokenRequestInAdminScope(
      request,
      scope,
      users,
      new Set(getConfig().admin.systemAdminOpenIds),
    )
  ) {
    throw submissionError(404, "token_request_not_found", "申请单不存在或不在当前管理范围内");
  }
}

async function readOperationSubmissionState(
  client: PoolClient,
  input: { feishuUserId: string; idempotencyKey: string },
) {
  const result = await client.query<{
    idempotent: QuotaOperation | null;
    open_operation: QuotaOperation | null;
    generation: number;
  }>(
    `select
       (select data
        from quota_operations
        where idempotency_key = $2
        limit 1) as idempotent,
       (select data
        from quota_operations
        where feishu_user_id = $1
          and state not in ('completed', 'compensated', 'cancelled')
        order by created_at desc
        limit 1) as open_operation,
       coalesce(
         (select active_generation from user_quota_states where feishu_user_id = $1),
         (select max(operation_generation) from token_accounts where feishu_user_id = $1),
         0
       )::integer as generation`,
    [input.feishuUserId, input.idempotencyKey],
  );
  return result.rows[0];
}

function assertNoConflictingOperation(
  state: Awaited<ReturnType<typeof readOperationSubmissionState>>,
  input: {
    feishuUserId: string;
    operationType: QuotaOperation["operationType"];
    idempotencyKey: string;
  },
) {
  const idempotent = state?.idempotent;
  if (idempotent) {
    if (
      idempotent.feishuUserId !== input.feishuUserId ||
      idempotent.operationType !== input.operationType ||
      idempotent.idempotencyKey !== input.idempotencyKey
    ) {
      throw submissionError(409, "idempotency_conflict", "幂等键已被其他额度操作使用");
    }
    return idempotent;
  }
  if (state?.open_operation) {
    throw submissionError(
      409,
      "quota_operation_open",
      `用户已有未完成额度操作: ${state.open_operation.id}`,
    );
  }
  return null;
}

async function persistFirstProvisionSubmission(
  client: PoolClient,
  input: {
    request: TokenRequest;
    requestUser: FeishuUser | null;
    approvedMonthlyQuota: number;
    operatorOpenId: string;
    actionable: boolean;
    notActionableMessage: string;
  },
): Promise<FirstProvisionDecisionSubmission> {
  if (!input.requestUser || (input.requestUser.status && input.requestUser.status !== "active")) {
    throw submissionError(409, "target_user_inactive", "目标用户当前不是启用状态");
  }
  const idempotencyKey = `quota-operation:${input.request.id}`;
  const requestedAssignedQuota = toNewApiQuota(input.approvedMonthlyQuota);
  const state = await readOperationSubmissionState(client, {
    feishuUserId: input.request.feishuUserId,
    idempotencyKey,
  });
  const existing = assertNoConflictingOperation(state, {
    feishuUserId: input.request.feishuUserId,
    operationType: "first_provision",
    idempotencyKey,
  });
  if (existing) {
    if (
      existing.requestId !== input.request.id ||
      existing.requestedAssignedQuota !== requestedAssignedQuota
    ) {
      throw submissionError(
        409,
        "idempotency_conflict",
        "首次发放操作已使用不同的申请或额度受理",
      );
    }
    return { request: input.request, operation: existing, deduplicated: true };
  }
  if (!input.actionable) {
    throw submissionError(
      409,
      "token_request_not_actionable",
      input.notActionableMessage,
    );
  }

  const now = nowIso();
  const billingPeriod = await currentPackageBillingPeriodForSubmission(client);
  const updatedRequest: TokenRequest = {
    ...input.request,
    status: "approved_provisioning",
    approvedMonthlyQuota: input.approvedMonthlyQuota,
    approvalOperatorOpenId: input.operatorOpenId,
    approvalOperatedAt: now,
    errorMessage: undefined,
    updatedAt: now,
  };
  const operation: QuotaOperation = {
    id: randomId("qo"),
    operationType: "first_provision",
    idempotencyKey,
    feishuUserId: input.request.feishuUserId,
    departmentId: input.requestUser?.departmentId,
    billingPeriod,
    requestedAssignedQuota,
    reservedDepartmentQuota: 0,
    operationGeneration: (state?.generation ?? 0) + 1,
    state: "planned",
    attemptCount: 0,
    requestId: input.request.id,
    createdByOpenId: input.operatorOpenId,
    createdAt: now,
    updatedAt: now,
  };
  const storedRequest = await saveTokenRequestRow(client, updatedRequest);
  const storedOperation = await insertQuotaOperationRow(client, operation);
  return {
    request: storedRequest,
    operation: storedOperation,
    deduplicated: false,
  };
}

export type FirstProvisionDecisionSubmission = {
  request: TokenRequest;
  operation: QuotaOperation;
  deduplicated: boolean;
};

/**
 * Atomically accepts a normal user's approved first-provision request.
 *
 * Only local request and operation rows are committed here. The durable worker
 * owns NewAPI calls, department budget reservation, policy creation and ledger
 * materialization after this transaction returns.
 */
export async function submitPostgresFirstProvisionDecision(input: {
  actorUserId: string;
  requestId: string;
  approvedMonthlyQuota?: number;
}): Promise<FirstProvisionDecisionSubmission> {
  return withQuotaSubmitTransaction(async (client) => {
    const initial = await readRequestAndUser(client, input.requestId, false);
    if (!initial) {
      throw submissionError(404, "token_request_not_found", "申请单不存在或不在当前管理范围内");
    }
    await lockAdminScopeUsersForSubmission(client, [
      input.actorUserId,
      initial.request_data.feishuUserId,
    ]);
    const { actor, scope } = await readAdminActorScope(client, input.actorUserId);
    assertRequestScope(initial.request_data, initial.user_data, scope);
    if (initial.request_data.requestType !== "first_apply") {
      throw submissionError(409, "token_request_not_actionable", "当前记录不是首次额度申请");
    }

    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `user-quota:${initial.request_data.feishuUserId}`,
    ]);
    const locked = await readRequestAndUser(client, input.requestId, true);
    if (!locked) {
      throw submissionError(404, "token_request_not_found", "申请单不存在");
    }
    assertRequestScope(locked.request_data, locked.user_data, scope);

    const request = locked.request_data;
    const approvedMonthlyQuota =
      input.approvedMonthlyQuota ?? request.approvedMonthlyQuota ?? request.requestedMonthlyQuota;
    return persistFirstProvisionSubmission(client, {
      request,
      requestUser: locked.user_data,
      approvedMonthlyQuota,
      operatorOpenId: actor.openId,
      actionable: tokenRequestRequiresAdminDecision(request),
      notActionableMessage: "当前记录不是可人工处理的审批申请",
    });
  });
}

export async function submitPostgresFirstProvisionCardApproval(input: {
  requestId: string;
  operatorOpenId: string;
  nonce: string;
}): Promise<FirstProvisionDecisionSubmission> {
  return withQuotaSubmitTransaction(async (client) => {
    const initial = await readRequestAndUser(client, input.requestId, false);
    if (!initial || initial.request_data.requestType !== "first_apply") {
      throw submissionError(404, "token_request_not_found", "首次发放申请不存在");
    }

    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `user-quota:${initial.request_data.feishuUserId}`,
    ]);
    const locked = await readRequestAndUser(client, input.requestId, true);
    if (!locked || locked.request_data.requestType !== "first_apply") {
      throw submissionError(404, "token_request_not_found", "首次发放申请不存在");
    }
    const request = locked.request_data;
    if (
      !request.approvalActionNonceHash ||
      sha256Hex(input.nonce) !== request.approvalActionNonceHash
    ) {
      throw submissionError(403, "card_nonce_invalid", "审批卡片校验失败");
    }
    if (request.approvalTargetOpenId !== input.operatorOpenId) {
      throw submissionError(403, "card_operator_forbidden", "当前用户无权审批此申请");
    }

    return persistFirstProvisionSubmission(client, {
      request,
      requestUser: locked.user_data,
      approvedMonthlyQuota:
        request.approvedMonthlyQuota ?? request.requestedMonthlyQuota,
      operatorOpenId: input.operatorOpenId,
      actionable:
        request.status === "pending_card_approval" ||
        request.status === "approved_provision_failed",
      notActionableMessage: `当前申请状态不可批准: ${request.status}`,
    });
  });
}

export async function submitPostgresAdminFirstProvisionAllocation(input: {
  actorUserId: string;
  targetUserId: string;
  approvedMonthlyQuota: number;
  reason: string;
  clientRequestId: string;
}): Promise<FirstProvisionDecisionSubmission> {
  return withQuotaSubmitTransaction(async (client) => {
    await lockAdminScopeUsersForSubmission(client, [
      input.actorUserId,
      input.targetUserId,
    ]);
    const { actor, scope } = await readAdminActorScope(client, input.actorUserId);
    const initialTarget = await client.query<{ data: FeishuUser }>(
      "select data from feishu_users where id = $1 for share",
      [input.targetUserId],
    );
    const initialUser = initialTarget.rows[0]?.data;
    if (!initialUser) {
      throw submissionError(404, "target_user_not_found", "用户不存在或不在当前管理范围内");
    }
    assertAdminActorCanTargetUser(actor, scope, initialUser);

    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `user-quota:${input.targetUserId}`,
    ]);
    const targetResult = await client.query<{ data: FeishuUser }>(
      "select data from feishu_users where id = $1 for share",
      [input.targetUserId],
    );
    const targetUser = targetResult.rows[0]?.data;
    if (!targetUser) {
      throw submissionError(404, "target_user_not_found", "用户不存在或不在当前管理范围内");
    }
    if (targetUser.status && targetUser.status !== "active") {
      throw submissionError(409, "target_user_inactive", "目标用户当前不是启用状态");
    }
    assertAdminActorCanTargetUser(actor, scope, targetUser);
    const targetAdminScope = await readOptionalAdminScopeForUser(client, targetUser);
    assertRootActorForGlobalAdminTarget(scope, targetAdminScope);
    if (
      !targetUser.departmentId &&
      targetAdminScope?.scopeType !== "global"
    ) {
      throw submissionError(
        409,
        "target_department_missing",
        "目标用户必须先归属部门，或拥有有效的全局管理员身份",
      );
    }
    const activeAccount = await client.query(
      "select 1 from token_accounts where feishu_user_id = $1 and status = 'active' limit 1",
      [targetUser.id],
    );
    if ((activeAccount.rowCount ?? 0) > 0) {
      throw submissionError(409, "active_token_exists", "目标用户已经拥有 active Key");
    }

    const reusableResult = await client.query<{ data: TokenRequest }>(
      `select data
       from token_requests
       where feishu_user_id = $1
         and request_type = 'first_apply'
         and status in (
           'pending_card_send', 'pending_card_approval',
           'approval_card_send_failed', 'approval_route_failed',
           'pending_feishu_approval', 'approved',
           'approved_provisioning', 'approved_provision_failed',
           'draft_pending_approval_config'
         )
       order by updated_at desc, id
       limit 1
       for update`,
      [targetUser.id],
    );
    const now = nowIso();
    const digest = sha256Hex(
      `${targetUser.id}:${input.clientRequestId}`,
    ).slice(0, 28);
    const reusable = reusableResult.rows[0]?.data;
    const request: TokenRequest = {
      ...(reusable ?? {
        id: `tr_admin_alloc_${digest}`,
        feishuUserId: targetUser.id,
        requestType: "first_apply" as const,
        approvalUuid: `approval_admin_alloc_${digest}`,
        createdAt: now,
      }),
      feishuUserId: targetUser.id,
      requestType: "first_apply",
      status: reusable?.status ?? "approved",
      reason: input.reason,
      requestedMonthlyQuota: input.approvedMonthlyQuota,
      approvedMonthlyQuota: input.approvedMonthlyQuota,
      approvalDepartmentId: targetUser.departmentId,
      approvalMode: "manual",
      approvalOperatorOpenId: actor.openId,
      approvalOperatedAt: now,
      errorMessage: undefined,
      updatedAt: now,
    };
    return persistFirstProvisionSubmission(client, {
      request,
      requestUser: targetUser,
      approvedMonthlyQuota: input.approvedMonthlyQuota,
      operatorOpenId: actor.openId,
      actionable: true,
      notActionableMessage: "当前用户无法受理首次发放",
    });
  });
}

export type AdminQuotaAdjustmentSubmission = {
  request: TokenRequest;
  operation: QuotaOperation;
  deduplicated: boolean;
};

/**
 * Atomically accepts an administrator quota adjustment for an existing Key.
 *
 * The actor scope locks serialize this authorization decision with admin-scope
 * mutation. The target user quota lock then keeps the Active Key, generation,
 * idempotency check, request and operation in one local commit boundary.
 */
export async function submitPostgresAdminQuotaAdjustment(input: {
  actorUserId: string;
  targetUserId: string;
  approvedMonthlyQuota: number;
  reason: string;
  clientRequestId: string;
}): Promise<AdminQuotaAdjustmentSubmission> {
  return withQuotaSubmitTransaction(async (client) => {
    await lockAdminScopeUsersForSubmission(client, [
      input.actorUserId,
      input.targetUserId,
    ]);
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `user-quota:${input.targetUserId}`,
    ]);

    const { actor, scope } = await readAdminActorScope(client, input.actorUserId);
    const targetResult = await client.query<{ data: FeishuUser }>(
      "select data from feishu_users where id = $1 for update",
      [input.targetUserId],
    );
    const targetUser = targetResult.rows[0]?.data;
    if (!targetUser) {
      throw submissionError(404, "target_user_not_found", "用户不存在或不在当前管理范围内");
    }
    assertAdminActorCanTargetUser(actor, scope, targetUser);
    if (targetUser.status && targetUser.status !== "active") {
      throw submissionError(409, "target_user_inactive", "目标用户当前不是启用状态");
    }
    const targetAdminScope = await readOptionalAdminScopeForUser(client, targetUser);
    assertRootActorForGlobalAdminTarget(scope, targetAdminScope);
    if (!targetUser.departmentId && targetAdminScope?.scopeType !== "global") {
      throw submissionError(
        409,
        "target_department_missing",
        "目标用户必须先归属部门，或拥有有效的全局管理员身份",
      );
    }

    const idempotencyKey = `quota-adjust:${input.clientRequestId}`;
    const requestedAssignedQuota = toNewApiQuota(input.approvedMonthlyQuota);
    const state = await readOperationSubmissionState(client, {
      feishuUserId: targetUser.id,
      idempotencyKey,
    });
    const existing = assertNoConflictingOperation(state, {
      feishuUserId: targetUser.id,
      operationType: "quota_adjust",
      idempotencyKey,
    });
    if (existing) {
      if (existing.requestedAssignedQuota !== requestedAssignedQuota) {
        throw submissionError(409, "idempotency_conflict", "调额幂等键已使用不同额度受理");
      }
      const existingRequest = await readTokenRequestById(client, existing.requestId);
      if (
        !existingRequest ||
        existingRequest.feishuUserId !== targetUser.id ||
        existingRequest.requestType !== "quota_adjust"
      ) {
        throw submissionError(409, "idempotency_conflict", "调额幂等操作缺少匹配申请记录");
      }
      return {
        request: existingRequest,
        operation: existing,
        deduplicated: true,
      };
    }

    const activeAccountResult = await client.query<{ data: TokenAccount }>(
      `select data
       from token_accounts
       where feishu_user_id = $1 and status = 'active'
       order by created_at desc, id desc
       limit 1
       for share`,
      [targetUser.id],
    );
    const activeAccount = activeAccountResult.rows[0]?.data;
    if (!activeAccount?.newapiTokenId) {
      throw submissionError(409, "active_token_required", "目标用户没有可调额的 active NewAPI Key");
    }

    const now = nowIso();
    const digest = sha256Hex(`${targetUser.id}:${input.clientRequestId}`).slice(0, 28);
    const quotaRequest: TokenRequest = {
      id: `tr_admin_adjust_${digest}`,
      feishuUserId: targetUser.id,
      requestType: "quota_adjust",
      status: "approved_provisioning",
      reason: input.reason,
      requestedMonthlyQuota: input.approvedMonthlyQuota,
      approvedMonthlyQuota: input.approvedMonthlyQuota,
      approvalUuid: `approval_admin_adjust_${digest}`,
      approvalDepartmentId: targetUser.departmentId,
      approvalMode: "manual",
      approvalOperatorOpenId: actor.openId,
      approvalOperatedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const operation: QuotaOperation = {
      id: randomId("qo"),
      operationType: "quota_adjust",
      idempotencyKey,
      feishuUserId: targetUser.id,
      departmentId: targetUser.departmentId,
      billingPeriod: activeAccount.billingPeriod,
      requestedAssignedQuota,
      reservedDepartmentQuota: 0,
      operationGeneration: (state?.generation ?? 0) + 1,
      state: "planned",
      attemptCount: 0,
      upstreamTokenIdBefore: activeAccount.newapiTokenId,
      tokenAccountIdBefore: activeAccount.id,
      requestId: quotaRequest.id,
      createdByOpenId: actor.openId,
      createdAt: now,
      updatedAt: now,
    };
    const storedRequest = await saveTokenRequestRow(client, quotaRequest);
    const storedOperation = await insertQuotaOperationRow(client, operation);
    return {
      request: storedRequest,
      operation: storedOperation,
      deduplicated: false,
    };
  });
}

export async function submitPostgresKeyRotation(input: {
  feishuUserId: string;
  reason: string;
  clientRequestId: string;
}) {
  return withQuotaSubmitTransaction(async (client) => {
    const userResult = await client.query<{ data: FeishuUser }>(
      "select data from feishu_users where id = $1 for share",
      [input.feishuUserId],
    );
    const user = userResult.rows[0]?.data;
    if (!user) {
      throw submissionError(401, "session_user_missing", "飞书 OAuth 会话对应的用户不存在");
    }
    if (user.status && user.status !== "active") {
      throw submissionError(403, "session_user_inactive", "当前用户已禁用或删除");
    }

    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `user-quota:${user.id}`,
    ]);
    const lockedUserResult = await client.query<{ data: FeishuUser }>(
      "select data from feishu_users where id = $1 for share",
      [user.id],
    );
    const lockedUser = lockedUserResult.rows[0]?.data;
    if (!lockedUser || (lockedUser.status && lockedUser.status !== "active")) {
      throw submissionError(403, "session_user_inactive", "当前用户已禁用或删除");
    }
    const activeAccountPeriod = await client.query<{ data: TokenAccount }>(
      `select data
       from token_accounts
       where feishu_user_id = $1 and status = 'active'
       order by created_at desc, id desc
       limit 1
       for share`,
      [user.id],
    );
    const period =
      activeAccountPeriod.rows[0]?.data.billingPeriod ??
      (await currentPackageBillingPeriodForSubmission(client));
    const idempotencyKey = `key-reset:${input.clientRequestId}`;
    const result = await client.query<{
      settings: AppSettings;
      idempotent: QuotaOperation | null;
      open_operation: QuotaOperation | null;
      active_account: TokenAccount | null;
      billing: UserBillingPeriod | null;
      department_period: DepartmentQuotaPeriod | null;
      generation: number;
    }>(
      `select
         coalesce(
           (select data from app_settings where id = 'default'),
           '{"defaultMonthlyQuota":200}'::jsonb
         ) as settings,
         (select data from quota_operations where idempotency_key = $3 limit 1) as idempotent,
         (select data
          from quota_operations
          where feishu_user_id = $1 and state not in ('completed', 'compensated', 'cancelled')
          order by created_at desc
          limit 1) as open_operation,
         (select data
          from token_accounts
          where feishu_user_id = $1 and status = 'active'
          order by created_at desc, id desc
          limit 1) as active_account,
         (select data
          from user_billing_periods
          where feishu_user_id = $1 and period = $2
          limit 1) as billing,
         (select data
          from department_quota_periods
          where department_id = $4 and period = $2
          limit 1) as department_period,
         coalesce(
           (select active_generation from user_quota_states where feishu_user_id = $1),
           (select max(operation_generation) from token_accounts where feishu_user_id = $1),
           0
         )::integer as generation`,
      [user.id, period, idempotencyKey, user.departmentId ?? null],
    );
    const row = result.rows[0];
    const existing = assertNoConflictingOperation(row, {
      feishuUserId: user.id,
      operationType: "key_rotation",
      idempotencyKey,
    });
    if (existing) {
      const requestResult = existing.requestId
        ? await client.query<{ data: TokenRequest }>(
            "select data from token_requests where id = $1 limit 1",
            [existing.requestId],
          )
        : null;
      return {
        request: requestResult?.rows[0]?.data ?? null,
        operation: existing,
        deduplicated: true,
      };
    }
    if (!row.active_account) {
      throw submissionError(409, "active_token_required", "当前飞书用户没有可更换的 active NewAPI Key");
    }

    const monthlyQuota =
      row.billing?.monthlyQuota ??
      row.department_period?.defaultGrantQuota ??
      row.settings.defaultMonthlyQuota;
    const now = nowIso();
    const request: TokenRequest = {
      id: randomId("tr"),
      feishuUserId: user.id,
      requestType: "key_reset",
      status: "approved_provisioning",
      reason: input.reason,
      requestedMonthlyQuota: monthlyQuota,
      approvalUuid: randomId("approval"),
      approvalMode: "manual",
      approvalOperatorOpenId: user.openId,
      approvalOperatedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const operation: QuotaOperation = {
      id: randomId("qo"),
      operationType: "key_rotation",
      idempotencyKey,
      feishuUserId: user.id,
      departmentId: user.departmentId,
      billingPeriod: period,
      reservedDepartmentQuota: 0,
      operationGeneration: (row.generation ?? 0) + 1,
      state: "planned",
      attemptCount: 0,
      requestId: request.id,
      createdByOpenId: user.openId,
      createdAt: now,
      updatedAt: now,
    };
    const storedRequest = await saveTokenRequestRow(client, request);
    const storedOperation = await insertQuotaOperationRow(client, operation);
    return { request: storedRequest, operation: storedOperation, deduplicated: false };
  });
}
