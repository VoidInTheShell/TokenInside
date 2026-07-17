import { Pool, type PoolClient } from "pg";
import {
  resolveSessionAdminScopeProjection,
  tokenRequestInAdminScope,
} from "@/lib/admin-scope";
import { getConfig } from "@/lib/config";
import { nowIso, randomId } from "@/lib/crypto";
import { hongKongBillingPeriod } from "@/lib/quota-model";
import { tokenRequestRequiresAdminDecision } from "@/lib/token-request-policy";
import type {
  AdminScope,
  AppSettings,
  DepartmentQuotaPeriod,
  FeishuUser,
  QuotaFeatureFlags,
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

function quotaFeatureFlags(settings: AppSettings): QuotaFeatureFlags {
  return {
    legacyAbsoluteQuotaWritesEnabled: false,
    quotaLedgerShadowRead: true,
    quotaSagaWritesEnabled: false,
    keyRotationSagaEnabled: false,
    quotaRestoreEnabled: false,
    monthlyPeriodOpenEnabled: false,
    reconciliationAutoDecreaseEnabled: false,
    ...settings.quotaFeatureFlags,
    reconciliationAutoIncreaseEnabled: false,
  };
}

function assertSubmissionFeature(
  settings: AppSettings,
  action: "quota_restore" | "key_rotation",
) {
  const flags = quotaFeatureFlags(settings);
  const enabled =
    flags.legacyAbsoluteQuotaWritesEnabled ||
    (flags.quotaSagaWritesEnabled &&
      (action === "quota_restore" ? flags.quotaRestoreEnabled : flags.keyRotationSagaEnabled));
  if (!enabled) {
    throw submissionError(
      503,
      "quota_feature_disabled",
      `F 阶段 ${action} 写入尚未启用；旧式绝对余额写入已关闭`,
    );
  }
  if (!flags.legacyAbsoluteQuotaWritesEnabled && !settings.quotaMigration?.appliedAt) {
    throw submissionError(
      503,
      "quota_feature_disabled",
      `F 阶段 ${action} 写入尚未就绪：历史额度账本迁移未完成`,
    );
  }
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

async function readRequestAndUser(client: PoolClient, requestId: string, lock: boolean) {
  const result = await client.query<{
    request_data: TokenRequest;
    user_data: FeishuUser | null;
  }>(
    `select request.data as request_data, request_user.data as user_data
     from token_requests request
     left join feishu_users request_user on request_user.id = request.feishu_user_id
     where request.id = $1
     ${lock ? "for update of request" : ""}`,
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
    settings: AppSettings;
    idempotent: QuotaOperation | null;
    open_operation: QuotaOperation | null;
    generation: number;
  }>(
    `select
       coalesce(
         (select data from app_settings where id = 'default'),
         '{"defaultMonthlyQuota":200}'::jsonb
       ) as settings,
       (select data
        from quota_operations
        where idempotency_key = $2
        limit 1) as idempotent,
       (select data
        from quota_operations
        where feishu_user_id = $1
          and state not in ('completed', 'compensated')
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

export type QuotaRestoreSubmission =
  | { handled: false }
  | {
      handled: true;
      request: TokenRequest;
      operation: QuotaOperation;
      deduplicated: boolean;
    };

export async function submitPostgresQuotaRestoreDecision(input: {
  actorUserId: string;
  requestId: string;
  approvedMonthlyQuota?: number;
}): Promise<QuotaRestoreSubmission> {
  return withQuotaSubmitTransaction(async (client) => {
    const { actor, scope } = await readAdminActorScope(client, input.actorUserId);
    const initial = await readRequestAndUser(client, input.requestId, false);
    if (!initial) {
      throw submissionError(404, "token_request_not_found", "申请单不存在或不在当前管理范围内");
    }
    assertRequestScope(initial.request_data, initial.user_data, scope);
    if (
      initial.request_data.requestType !== "quota_reset" &&
      initial.request_data.requestType !== "quota_restore"
    ) {
      return { handled: false };
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
    const idempotencyKey = `quota-operation:${request.id}`;
    const state = await readOperationSubmissionState(client, {
      feishuUserId: request.feishuUserId,
      idempotencyKey,
    });
    const existing = assertNoConflictingOperation(state, {
      feishuUserId: request.feishuUserId,
      operationType: "quota_restore",
      idempotencyKey,
    });
    if (existing) {
      return { handled: true, request, operation: existing, deduplicated: true };
    }
    if (!tokenRequestRequiresAdminDecision(request)) {
      throw submissionError(409, "token_request_not_actionable", "当前记录不是可人工处理的审批申请");
    }
    assertSubmissionFeature(state.settings, "quota_restore");

    const now = nowIso();
    const approvedMonthlyQuota =
      input.approvedMonthlyQuota ?? request.approvedMonthlyQuota ?? request.requestedMonthlyQuota;
    const updatedRequest: TokenRequest = {
      ...request,
      status: "approved_provisioning",
      approvedMonthlyQuota,
      approvalOperatorOpenId: actor.openId,
      approvalOperatedAt: now,
      errorMessage: undefined,
      updatedAt: now,
    };
    const operation: QuotaOperation = {
      id: randomId("qo"),
      operationType: "quota_restore",
      idempotencyKey,
      feishuUserId: request.feishuUserId,
      departmentId: locked.user_data?.departmentId,
      billingPeriod: hongKongBillingPeriod(),
      reservedDepartmentQuota: 0,
      operationGeneration: (state?.generation ?? 0) + 1,
      state: "planned",
      attemptCount: 0,
      requestId: request.id,
      createdByOpenId: actor.openId,
      createdAt: now,
      updatedAt: now,
    };
    const storedRequest = await saveTokenRequestRow(client, updatedRequest);
    const storedOperation = await insertQuotaOperationRow(client, operation);
    return {
      handled: true,
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
    const period = hongKongBillingPeriod();
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
          where feishu_user_id = $1 and state not in ('completed', 'compensated')
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
    assertSubmissionFeature(row.settings, "key_rotation");
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
