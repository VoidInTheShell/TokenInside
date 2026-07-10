import { Pool, type PoolClient } from "pg";
import { getConfig } from "@/lib/config";
import { nowIso, randomId } from "@/lib/crypto";
import { newApiUsageIdentityLockKeys } from "@/lib/newapi-usage-identity";
import type {
  AdminScope,
  AppSettings,
  FeishuEvent,
  FeishuUser,
  NewApiUsageRecord,
  ProxyRequestLog,
  RequestStatus,
  StoreShape,
  TokenAccount,
  TokenStatus,
  TokenRequest,
  UsageSyncCheckpoint,
  UsageSyncIssue,
  UserBillingPeriod,
} from "@/lib/types";

let pool: Pool | undefined;

export const REQUIRED_POSTGRES_TABLES = [
  "app_settings",
  "feishu_users",
  "token_requests",
  "token_accounts",
  "user_billing_periods",
  "feishu_events",
  "proxy_request_logs",
  "newapi_usage_records",
  "usage_sync_checkpoints",
  "usage_sync_issues",
  "admin_scopes",
] as const;

function getPool() {
  if (pool) return pool;
  const config = getConfig();
  const databaseUrl = config.databaseUrl;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required when TOKENINSIDE_STORE_BACKEND=postgres");
  }
  pool = new Pool({
    connectionString: databaseUrl,
    max: config.postgres.poolMax,
    idleTimeoutMillis: config.postgres.poolIdleTimeoutMs,
    connectionTimeoutMillis: config.postgres.poolConnectionTimeoutMs,
  });
  return pool;
}

async function readDataRows<T>(client: PoolClient, table: string, orderBy: string) {
  const result = await client.query<{ data: T }>(`select data from ${table} order by ${orderBy}`);
  return result.rows.map((row) => row.data);
}

async function insertJsonRows<T>(
  client: PoolClient,
  table: string,
  rows: T[],
  insert: (row: T) => { sql: string; values: unknown[] },
) {
  for (const row of rows) {
    const { sql, values } = insert(row);
    await client.query(sql, values);
  }
}

async function withClient<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>) {
  return withClient(async (client) => {
    try {
      await client.query("begin");
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback");
      throw err;
    }
  });
}

function periodFromIso(value?: string) {
  return value?.slice(0, 7) || nowIso().slice(0, 7);
}

function latestIso(...values: Array<string | undefined>) {
  const sorted = values.filter(Boolean).sort();
  return sorted.length ? sorted[sorted.length - 1] : nowIso();
}

function sameStringArray(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function finiteUsageAmount(value?: number) {
  return Number.isFinite(value) ? (value as number) : 0;
}

function proxyLogQuotaConsumed(log: ProxyRequestLog) {
  if (log.usageSource !== "newapi_log") return 0;
  return finiteUsageAmount(log.cost ?? log.quota);
}

function usageRecordQuotaConsumed(record: NewApiUsageRecord) {
  return finiteUsageAmount(record.cost ?? record.quota);
}

function usageRecordPeriod(record: NewApiUsageRecord) {
  return periodFromIso(record.newapiCreatedAt ?? record.lastSyncedAt ?? record.firstSeenAt);
}

async function readSettingsRow(client: PoolClient) {
  const result = await client.query<{ data: AppSettings }>(
    "select data from app_settings where id = 'default'",
  );
  return result.rows[0]?.data ?? { defaultMonthlyQuota: 200 };
}

async function saveSettingsRow(client: PoolClient, settings: AppSettings) {
  const result = await client.query<{ data: AppSettings }>(
    `insert into app_settings (id, data)
     values ('default', $1)
     on conflict (id) do update set data = excluded.data
     returning data`,
    [settings],
  );
  return result.rows[0].data;
}

async function saveFeishuUserRow(client: PoolClient, user: FeishuUser) {
  const result = await client.query<{ data: FeishuUser }>(
    `insert into feishu_users
      (id, tenant_key, open_id, department_id, data, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (id) do update set
       tenant_key = excluded.tenant_key,
       open_id = excluded.open_id,
       department_id = excluded.department_id,
       data = excluded.data,
       updated_at = excluded.updated_at
     returning data`,
    [
      user.id,
      user.tenantKey,
      user.openId,
      user.departmentId ?? null,
      user,
      user.createdAt,
      user.updatedAt,
    ],
  );
  return result.rows[0].data;
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

async function saveTokenAccountRow(client: PoolClient, account: TokenAccount) {
  const result = await client.query<{ data: TokenAccount }>(
    `insert into token_accounts
      (id, feishu_user_id, token_request_id, newapi_token_id, key_hash,
       status, billing_period, data, created_at, disabled_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (id) do update set
       feishu_user_id = excluded.feishu_user_id,
       token_request_id = excluded.token_request_id,
       newapi_token_id = excluded.newapi_token_id,
       key_hash = excluded.key_hash,
       status = excluded.status,
       billing_period = excluded.billing_period,
       data = excluded.data,
       disabled_at = excluded.disabled_at
     returning data`,
    [
      account.id,
      account.feishuUserId,
      account.tokenRequestId,
      account.newapiTokenId ?? null,
      account.keyHash,
      account.status,
      account.billingPeriod,
      account,
      account.createdAt,
      account.disabledAt ?? null,
    ],
  );
  return result.rows[0].data;
}

async function saveUserBillingPeriodRow(client: PoolClient, period: UserBillingPeriod) {
  const result = await client.query<{ data: UserBillingPeriod }>(
    `insert into user_billing_periods
      (id, feishu_user_id, period, data, updated_at)
     values ($1, $2, $3, $4, $5)
     on conflict (feishu_user_id, period) do update set
       data = excluded.data,
       updated_at = excluded.updated_at
     returning data`,
    [period.id, period.feishuUserId, period.period, period, period.updatedAt],
  );
  return result.rows[0].data;
}

async function saveFeishuEventRow(client: PoolClient, event: FeishuEvent) {
  const result = await client.query<{ data: FeishuEvent }>(
    `insert into feishu_events
      (id, event_uuid, event_type, instance_code, card_request_id, card_action,
       operator_open_id, message_id, processing_status, data, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (event_uuid) do update set
       event_type = excluded.event_type,
       instance_code = excluded.instance_code,
       card_request_id = excluded.card_request_id,
       card_action = excluded.card_action,
       operator_open_id = excluded.operator_open_id,
       message_id = excluded.message_id,
       processing_status = excluded.processing_status,
       data = excluded.data
     returning data`,
    [
      event.id,
      event.eventUuid,
      event.eventType ?? null,
      event.instanceCode ?? null,
      event.cardRequestId ?? null,
      event.cardAction ?? null,
      event.operatorOpenId ?? null,
      event.messageId ?? null,
      event.processingStatus,
      event,
      event.createdAt,
    ],
  );
  return result.rows[0].data;
}

async function saveProxyLogRow(client: PoolClient, log: ProxyRequestLog) {
  const result = await client.query<{ data: ProxyRequestLog }>(
    `insert into proxy_request_logs
      (id, feishu_user_id, token_account_id, request_path, method, status_code,
       data, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (id) do update set
       feishu_user_id = excluded.feishu_user_id,
       token_account_id = excluded.token_account_id,
       request_path = excluded.request_path,
       method = excluded.method,
       status_code = excluded.status_code,
       data = excluded.data
     returning data`,
    [
      log.id,
      log.feishuUserId ?? null,
      log.tokenAccountId ?? null,
      log.requestPath,
      log.method,
      log.statusCode,
      log,
      log.createdAt,
    ],
  );
  return result.rows[0].data;
}

async function saveNewApiUsageRecordRow(client: PoolClient, record: NewApiUsageRecord) {
  const result = await client.query<{ data: NewApiUsageRecord }>(
    `insert into newapi_usage_records
      (id, newapi_log_id, newapi_request_id, newapi_token_id, token_account_id,
       feishu_user_id, match_status, data, newapi_created_at, first_seen_at, last_synced_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (id) do update set
       newapi_log_id = excluded.newapi_log_id,
       newapi_request_id = excluded.newapi_request_id,
       newapi_token_id = excluded.newapi_token_id,
       token_account_id = excluded.token_account_id,
       feishu_user_id = excluded.feishu_user_id,
       match_status = excluded.match_status,
       data = excluded.data,
       newapi_created_at = excluded.newapi_created_at,
       last_synced_at = excluded.last_synced_at
     returning data`,
    [
      record.id,
      record.newapiLogId ?? null,
      record.newapiRequestId ?? null,
      record.newapiTokenId ?? null,
      record.tokenAccountId ?? null,
      record.feishuUserId ?? null,
      record.matchStatus,
      record,
      record.newapiCreatedAt ?? null,
      record.firstSeenAt,
      record.lastSyncedAt,
    ],
  );
  return result.rows[0].data;
}

async function saveUsageSyncCheckpointRow(client: PoolClient, checkpoint: UsageSyncCheckpoint) {
  const result = await client.query<{ data: UsageSyncCheckpoint }>(
    `insert into usage_sync_checkpoints
      (id, scope, data, updated_at)
     values ($1, $2, $3, $4)
     on conflict (scope) do update set
       data = excluded.data,
       updated_at = excluded.updated_at
     returning data`,
    [checkpoint.id, checkpoint.scope, checkpoint, checkpoint.updatedAt],
  );
  return result.rows[0].data;
}

async function saveUsageSyncIssueRow(client: PoolClient, issue: UsageSyncIssue) {
  const result = await client.query<{ data: UsageSyncIssue }>(
    `insert into usage_sync_issues
      (id, issue_type, status, newapi_log_id, newapi_request_id, newapi_token_id,
       data, first_seen_at, last_seen_at, last_synced_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (id) do update set
       issue_type = excluded.issue_type,
       status = excluded.status,
       newapi_log_id = excluded.newapi_log_id,
       newapi_request_id = excluded.newapi_request_id,
       newapi_token_id = excluded.newapi_token_id,
       data = excluded.data,
       last_seen_at = excluded.last_seen_at,
       last_synced_at = excluded.last_synced_at
     returning data`,
    [
      issue.id,
      issue.issueType,
      issue.status,
      issue.newapiLogId ?? null,
      issue.newapiRequestId ?? null,
      issue.newapiTokenId ?? null,
      issue,
      issue.firstSeenAt,
      issue.lastSeenAt,
      issue.lastSyncedAt,
    ],
  );
  return result.rows[0].data;
}

async function saveAdminScopeRow(client: PoolClient, scope: AdminScope) {
  const result = await client.query<{ data: AdminScope }>(
    `insert into admin_scopes
      (id, feishu_user_id, scope_type, department_id, source, status,
       data, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (id) do update set
       feishu_user_id = excluded.feishu_user_id,
       scope_type = excluded.scope_type,
       department_id = excluded.department_id,
       source = excluded.source,
       status = excluded.status,
       data = excluded.data,
       updated_at = excluded.updated_at
     returning data`,
    [
      scope.id,
      scope.feishuUserId,
      scope.scopeType,
      scope.departmentId ?? null,
      scope.source,
      scope.status,
      scope,
      scope.createdAt,
      scope.updatedAt,
    ],
  );
  return result.rows[0].data;
}

function isInactiveUser(user: FeishuUser) {
  return Boolean(user.status && user.status !== "active");
}

function blocksAutomaticAdminRestore(scope: AdminScope) {
  if (scope.status !== "disabled") return false;
  return (
    scope.disabledReason === "manual_revoke" ||
    scope.disabledReason === "user_deleted" ||
    scope.disabledReason === undefined
  );
}

function blocksAllAutomaticAdminRestoreForUser(scope: AdminScope) {
  return scope.scopeType === "global" && blocksAutomaticAdminRestore(scope);
}

function disabledAdminScope(
  scope: AdminScope,
  input: {
    now: string;
    reason: NonNullable<AdminScope["disabledReason"]>;
    disabledByFeishuUserId?: string;
  },
) {
  return {
    ...scope,
    status: "disabled" as const,
    disabledReason: input.reason,
    disabledByFeishuUserId: input.disabledByFeishuUserId,
    disabledAt: input.now,
    updatedAt: input.now,
  } satisfies AdminScope;
}

function activeAdminScope(scope: AdminScope, now: string) {
  return {
    ...scope,
    status: "active" as const,
    disabledReason: undefined,
    disabledByFeishuUserId: undefined,
    disabledAt: undefined,
    updatedAt: now,
  } satisfies AdminScope;
}

async function revokeAdminScopesForUserInTransaction(
  client: PoolClient,
  input: {
    feishuUserId: string;
    reason: NonNullable<AdminScope["disabledReason"]>;
    disabledByFeishuUserId?: string;
    now: string;
  },
) {
  const result = await client.query<{ data: AdminScope }>(
    `select data from admin_scopes
     where feishu_user_id = $1 and source <> 'environment'
     for update`,
    [input.feishuUserId],
  );
  const revoked: AdminScope[] = [];
  for (const row of result.rows) {
    revoked.push(
      await saveAdminScopeRow(
        client,
        disabledAdminScope(row.data, {
          now: input.now,
          reason: input.reason,
          disabledByFeishuUserId: input.disabledByFeishuUserId,
        }),
      ),
    );
  }
  return revoked;
}

async function syncPostgresBillingPeriodForUser(
  client: PoolClient,
  feishuUserId: string,
  period: string,
) {
  const settings = await readSettingsRow(client);
  const seededAt = nowIso();
  const seed: UserBillingPeriod = {
    id: randomId("bp"),
    feishuUserId,
    period,
    monthlyQuota: settings.defaultMonthlyQuota,
    quotaConsumed: 0,
    cost: 0,
    remainingQuota: settings.defaultMonthlyQuota,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    proxyLogCount: 0,
    usageRecordCount: 0,
    tokenAccountIds: [],
    updatedAt: seededAt,
  };
  await client.query(
    `insert into user_billing_periods
      (id, feishu_user_id, period, data, updated_at)
     values ($1, $2, $3, $4, $5)
     on conflict (feishu_user_id, period) do nothing`,
    [seed.id, seed.feishuUserId, seed.period, seed, seed.updatedAt],
  );

  const existingResult = await client.query<{ data: UserBillingPeriod }>(
    `select data from user_billing_periods
     where feishu_user_id = $1 and period = $2
     for update`,
    [feishuUserId, period],
  );
  const existing = existingResult.rows[0]?.data;
  const accounts = (
    await client.query<{ data: TokenAccount }>(
      `select data from token_accounts where feishu_user_id = $1 order by created_at, id`,
      [feishuUserId],
    )
  ).rows.map((row) => row.data);
  const requests = (
    await client.query<{ data: TokenRequest }>(
      `select data from token_requests where feishu_user_id = $1 order by created_at, id`,
      [feishuUserId],
    )
  ).rows.map((row) => row.data);
  const logs = (
    await client.query<{ data: ProxyRequestLog }>(
      `select data from proxy_request_logs where feishu_user_id = $1 order by created_at, id`,
      [feishuUserId],
    )
  ).rows.map((row) => row.data);
  const usageRecords = (
    await client.query<{ data: NewApiUsageRecord }>(
      `select data from newapi_usage_records
       where feishu_user_id = $1
       order by coalesce(newapi_created_at, last_synced_at), id`,
      [feishuUserId],
    )
  ).rows.map((row) => row.data);

  const requestById = new Map(requests.map((request) => [request.id, request]));
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const summary: UserBillingPeriod & { quotaUpdatedAt?: string; sourceUpdatedAt?: string } = {
    id: existing?.id ?? randomId("bp"),
    feishuUserId,
    period,
    monthlyQuota: existing?.monthlyQuota ?? settings.defaultMonthlyQuota,
    quotaConsumed: 0,
    cost: 0,
    remainingQuota: existing?.monthlyQuota ?? settings.defaultMonthlyQuota,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    proxyLogCount: 0,
    usageRecordCount: 0,
    activeTokenAccountId: undefined,
    tokenAccountIds: [],
    updatedAt: existing?.updatedAt ?? nowIso(),
    quotaUpdatedAt: undefined,
    sourceUpdatedAt: existing?.updatedAt,
  };

  function setQuota(quota: number | undefined, at: string) {
    if (!Number.isFinite(quota) || !quota || quota <= 0) return;
    if (!summary.quotaUpdatedAt || at.localeCompare(summary.quotaUpdatedAt) >= 0) {
      summary.monthlyQuota = quota;
      summary.quotaUpdatedAt = at;
    }
  }

  for (const account of accounts) {
    const accountPeriod = account.billingPeriod || periodFromIso(account.createdAt);
    if (accountPeriod !== period) continue;
    summary.tokenAccountIds.push(account.id);
    if (account.status === "active") summary.activeTokenAccountId = account.id;
    summary.sourceUpdatedAt = latestIso(
      summary.sourceUpdatedAt,
      account.createdAt,
      account.disabledAt,
    );

    const request = requestById.get(account.tokenRequestId);
    if (request) {
      setQuota(request.approvedMonthlyQuota ?? request.requestedMonthlyQuota, request.updatedAt);
      summary.sourceUpdatedAt = latestIso(summary.sourceUpdatedAt, request.updatedAt);
    }
  }

  for (const request of requests) {
    if (
      request.status !== "provisioned" ||
      (request.requestType !== "quota_reset" &&
        request.requestType !== "quota_adjust" &&
        request.requestType !== "monthly_reset") ||
      !request.tokenAccountId
    ) {
      continue;
    }
    const account = accountById.get(request.tokenAccountId);
    if (!account || (account.billingPeriod || periodFromIso(account.createdAt)) !== period) {
      continue;
    }
    setQuota(request.approvedMonthlyQuota ?? request.requestedMonthlyQuota, request.updatedAt);
    summary.sourceUpdatedAt = latestIso(summary.sourceUpdatedAt, request.updatedAt);
  }

  const proxyLogIdsBackedByNewApiRecords = new Set<string>();
  for (const record of usageRecords) {
    if (record.matchedProxyLogId) proxyLogIdsBackedByNewApiRecords.add(record.matchedProxyLogId);
    if (usageRecordPeriod(record) !== period) continue;
    if (record.matchStatus === "unknown_token" || record.matchStatus === "malformed_log") continue;
    const quotaConsumed = usageRecordQuotaConsumed(record);
    summary.quotaConsumed += quotaConsumed;
    summary.cost += quotaConsumed;
    summary.usageRecordCount += 1;
    summary.sourceUpdatedAt = latestIso(
      summary.sourceUpdatedAt,
      record.newapiCreatedAt,
      record.lastSyncedAt,
      record.firstSeenAt,
    );
  }

  for (const log of logs) {
    if (periodFromIso(log.createdAt) !== period) continue;
    summary.promptTokens += log.promptTokens ?? 0;
    summary.completionTokens += log.completionTokens ?? 0;
    summary.totalTokens += log.totalTokens ?? 0;
    summary.proxyLogCount += 1;
    if (!proxyLogIdsBackedByNewApiRecords.has(log.id)) {
      const quotaConsumed = proxyLogQuotaConsumed(log);
      if (quotaConsumed || log.cost !== undefined || log.quota !== undefined) {
        summary.quotaConsumed += quotaConsumed;
        summary.cost += quotaConsumed;
        summary.usageRecordCount += 1;
      }
    }
    summary.sourceUpdatedAt = latestIso(summary.sourceUpdatedAt, log.createdAt, log.updatedAt);
  }

  summary.tokenAccountIds = [...new Set(summary.tokenAccountIds)].sort();
  summary.quotaConsumed = Number(summary.quotaConsumed.toFixed(8));
  summary.cost = Number(summary.cost.toFixed(8));
  summary.remainingQuota = Math.max(Number((summary.monthlyQuota - summary.quotaConsumed).toFixed(8)), 0);
  summary.updatedAt = summary.sourceUpdatedAt ?? summary.updatedAt;
  delete summary.quotaUpdatedAt;
  delete summary.sourceUpdatedAt;

  if (
    !existing ||
    existing.monthlyQuota !== summary.monthlyQuota ||
    existing.quotaConsumed !== summary.quotaConsumed ||
    existing.cost !== summary.cost ||
    existing.remainingQuota !== summary.remainingQuota ||
    existing.promptTokens !== summary.promptTokens ||
    existing.completionTokens !== summary.completionTokens ||
    existing.totalTokens !== summary.totalTokens ||
    existing.proxyLogCount !== summary.proxyLogCount ||
    existing.usageRecordCount !== summary.usageRecordCount ||
    existing.activeTokenAccountId !== summary.activeTokenAccountId ||
    !sameStringArray(existing.tokenAccountIds, summary.tokenAccountIds) ||
    existing.updatedAt !== summary.updatedAt
  ) {
    return saveUserBillingPeriodRow(client, summary);
  }
  return existing;
}

export async function checkPostgresConnection() {
  const client = await getPool().connect();
  try {
    await client.query("select 1");
    return true;
  } finally {
    client.release();
  }
}

export async function checkPostgresSchema() {
  const client = await getPool().connect();
  try {
    const result = await client.query<{ table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = 'public' and table_name = any($1::text[])`,
      [REQUIRED_POSTGRES_TABLES],
    );
    const existing = new Set(result.rows.map((row) => row.table_name));
    const missingTables = REQUIRED_POSTGRES_TABLES.filter((table) => !existing.has(table));
    return {
      ready: missingTables.length === 0,
      missingTables,
      tableCount: result.rows.length,
      error: undefined as string | undefined,
    };
  } finally {
    client.release();
  }
}

export async function readPostgresStore(): Promise<StoreShape> {
  const client = await getPool().connect();
  try {
    const settings = await client.query<{ data: StoreShape["settings"] }>(
      "select data from app_settings where id = 'default'",
    );
    return {
      version: 1,
      settings: settings.rows[0]?.data ?? { defaultMonthlyQuota: 200 },
      users: await readDataRows<FeishuUser>(client, "feishu_users", "created_at, id"),
      tokenRequests: await readDataRows<TokenRequest>(
        client,
        "token_requests",
        "created_at, id",
      ),
      tokenAccounts: await readDataRows<TokenAccount>(
        client,
        "token_accounts",
        "created_at, id",
      ),
      userBillingPeriods: await readDataRows<UserBillingPeriod>(
        client,
        "user_billing_periods",
        "period, id",
      ),
      feishuEvents: await readDataRows<FeishuEvent>(client, "feishu_events", "created_at, id"),
      proxyRequestLogs: await readDataRows<ProxyRequestLog>(
        client,
        "proxy_request_logs",
        "created_at, id",
      ),
      newapiUsageRecords: await readDataRows<NewApiUsageRecord>(
        client,
        "newapi_usage_records",
        "coalesce(newapi_created_at, last_synced_at), id",
      ),
      usageSyncCheckpoints: await readDataRows<UsageSyncCheckpoint>(
        client,
        "usage_sync_checkpoints",
        "updated_at, id",
      ),
      usageSyncIssues: await readDataRows<UsageSyncIssue>(
        client,
        "usage_sync_issues",
        "last_seen_at, id",
      ),
      adminScopes: await readDataRows<AdminScope>(client, "admin_scopes", "created_at, id"),
    };
  } finally {
    client.release();
  }
}

export async function getPostgresAppSettings() {
  return withClient((client) => readSettingsRow(client));
}

export async function savePostgresAppSettings(settings: AppSettings) {
  return withTransaction((client) => saveSettingsRow(client, settings));
}

export async function mutatePostgresAppSettings<T>(
  fn: (settings: AppSettings) => T | Promise<T>,
) {
  return withTransaction(async (client) => {
    await client.query(
      `insert into app_settings (id, data)
       values ('default', $1)
       on conflict (id) do nothing`,
      [{ defaultMonthlyQuota: 200, billingOperations: [] }],
    );
    const settingsResult = await client.query<{ data: AppSettings }>(
      "select data from app_settings where id = 'default' for update",
    );
    const settings = settingsResult.rows[0]?.data ?? {
      defaultMonthlyQuota: 200,
      billingOperations: [],
    };
    const result = await fn(settings);
    await saveSettingsRow(client, settings);
    return result;
  });
}

export async function upsertPostgresFeishuUser(input: {
  id: string;
  tenantKey: string;
  openId: string;
  unionId?: string;
  feishuUserIdFromFeishu?: string;
  name?: string;
  avatarUrl?: string;
  departmentId?: string;
  departmentName?: string;
  now: string;
}) {
  return withTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `feishu_user:${input.tenantKey}:${input.openId}`,
    ]);
    const existing = await client.query<{ data: FeishuUser }>(
      `select data from feishu_users
       where tenant_key = $1 and open_id = $2
       for update`,
      [input.tenantKey, input.openId],
    );
    if (existing.rows[0]?.data) {
      const user = existing.rows[0].data;
      const updated: FeishuUser = {
        ...user,
        unionId: input.unionId ?? user.unionId,
        feishuUserIdFromFeishu: input.feishuUserIdFromFeishu ?? user.feishuUserIdFromFeishu,
        name: input.name ?? user.name,
        avatarUrl: input.avatarUrl ?? user.avatarUrl,
        departmentId: input.departmentId ?? user.departmentId,
        departmentName: input.departmentName ?? user.departmentName,
        updatedAt: input.now,
      };
      return saveFeishuUserRow(client, updated);
    }

    const user: FeishuUser = {
      id: input.id,
      tenantKey: input.tenantKey,
      openId: input.openId,
      unionId: input.unionId,
      feishuUserIdFromFeishu: input.feishuUserIdFromFeishu,
      name: input.name,
      avatarUrl: input.avatarUrl,
      departmentId: input.departmentId,
      departmentName: input.departmentName,
      status: "active",
      createdAt: input.now,
      updatedAt: input.now,
    };
    return saveFeishuUserRow(client, user);
  });
}

export async function insertPostgresTokenRequest(request: TokenRequest) {
  return withTransaction(async (client) => {
    const stored = await saveTokenRequestRow(client, request);
    if (stored.requestType === "first_apply") {
      const userResult = await client.query<{ data: FeishuUser }>(
        "select data from feishu_users where id = $1 for update",
        [stored.feishuUserId],
      );
      const user = userResult.rows[0]?.data;
      if (user?.status === "deleted") {
        const updatedUser: FeishuUser = {
          ...user,
          status: "active",
          deletedAt: undefined,
          deletedReason: undefined,
          updatedAt: stored.updatedAt,
        };
        await saveFeishuUserRow(client, updatedUser);
      }
    }
    return stored;
  });
}

export async function updatePostgresTokenRequest(
  id: string,
  patch: Partial<Omit<TokenRequest, "id" | "createdAt">>,
) {
  return transitionPostgresTokenRequest(id, patch);
}

export async function transitionPostgresTokenRequest(
  id: string,
  patch: Partial<Omit<TokenRequest, "id" | "createdAt">>,
  allowedStatuses?: RequestStatus[],
) {
  return withTransaction(async (client) => {
    const result = await client.query<{ data: TokenRequest }>(
      "select data from token_requests where id = $1 for update",
      [id],
    );
    const existing = result.rows[0]?.data;
    if (!existing) return null;
    if (allowedStatuses && !allowedStatuses.includes(existing.status)) return null;

    const updated: TokenRequest = {
      ...existing,
      ...patch,
      updatedAt: nowIso(),
    };
    const stored = await saveTokenRequestRow(client, updated);
    if (stored.tokenAccountId) {
      const accountResult = await client.query<{ data: TokenAccount }>(
        "select data from token_accounts where id = $1",
        [stored.tokenAccountId],
      );
      const account = accountResult.rows[0]?.data;
      if (account) {
        await syncPostgresBillingPeriodForUser(
          client,
          account.feishuUserId,
          account.billingPeriod || periodFromIso(account.createdAt),
        );
      }
    }
    return stored;
  });
}

export async function invalidatePostgresOpenFirstApplyRequests(input: {
  feishuUserId: string;
  approvedRequestId: string;
  approvalOperatorOpenId?: string;
  approvalOperatedAt?: string;
  statuses: RequestStatus[];
}) {
  return withTransaction(async (client) => {
    const now = nowIso();
    const result = await client.query<{ data: TokenRequest }>(
      `select data from token_requests
       where feishu_user_id = $1
         and id <> $2
         and request_type = 'first_apply'
         and status = any($3::text[])
       for update`,
      [input.feishuUserId, input.approvedRequestId, input.statuses],
    );
    const invalidated: TokenRequest[] = [];
    for (const row of result.rows) {
      const updated: TokenRequest = {
        ...row.data,
        status: "invalidated",
        errorMessage: undefined,
        approvalOperatorOpenId: row.data.approvalOperatorOpenId ?? input.approvalOperatorOpenId,
        approvalOperatedAt:
          row.data.approvalOperatedAt ?? input.approvalOperatedAt ?? now,
        updatedAt: now,
      };
      invalidated.push(await saveTokenRequestRow(client, updated));
    }
    return invalidated;
  });
}

export async function getPostgresActiveTokenForUser(feishuUserId: string) {
  return withClient(async (client) => {
    const result = await client.query<{ data: TokenAccount }>(
      `select data from token_accounts
       where feishu_user_id = $1 and status = 'active'
       order by created_at desc, id desc
       limit 1`,
      [feishuUserId],
    );
    return result.rows[0]?.data ?? null;
  });
}

export async function getPostgresDisabledTokenForUser(feishuUserId: string) {
  return withClient(async (client) => {
    const result = await client.query<{ data: TokenAccount }>(
      `select data from token_accounts
       where feishu_user_id = $1 and status = 'disabled'
       order by coalesce(disabled_at, created_at) desc, created_at desc, id desc
       limit 1`,
      [feishuUserId],
    );
    return result.rows[0]?.data ?? null;
  });
}

export async function findPostgresActiveTokenByHash(keyHash: string) {
  return withClient(async (client) => {
    const result = await client.query<{ data: TokenAccount }>(
      `select data from token_accounts
       where key_hash = $1 and status = 'active'
       limit 1`,
      [keyHash],
    );
    return result.rows[0]?.data ?? null;
  });
}

export async function insertPostgresTokenAccount(account: TokenAccount) {
  return withTransaction(async (client) => {
    const stored = await saveTokenAccountRow(client, account);
    await syncPostgresBillingPeriodForUser(
      client,
      stored.feishuUserId,
      stored.billingPeriod || periodFromIso(stored.createdAt),
    );
    return stored;
  });
}

export async function replacePostgresActiveTokenAccount(input: {
  oldTokenAccountId: string;
  account: TokenAccount;
}) {
  return withTransaction(async (client) => {
    const oldResult = await client.query<{ data: TokenAccount }>(
      `select data from token_accounts
       where id = $1 and feishu_user_id = $2 and status = 'active'
       for update`,
      [input.oldTokenAccountId, input.account.feishuUserId],
    );
    const oldAccount = oldResult.rows[0]?.data;
    if (!oldAccount) return null;

    const now = nowIso();
    const replaced: TokenAccount = {
      ...oldAccount,
      status: "replaced",
      disabledAt: now,
      replacedByTokenAccountId: input.account.id,
    };
    await saveTokenAccountRow(client, replaced);
    const stored = await saveTokenAccountRow(client, input.account);
    await syncPostgresBillingPeriodForUser(
      client,
      oldAccount.feishuUserId,
      oldAccount.billingPeriod || periodFromIso(oldAccount.createdAt),
    );
    await syncPostgresBillingPeriodForUser(
      client,
      stored.feishuUserId,
      stored.billingPeriod || periodFromIso(stored.createdAt),
    );
    return stored;
  });
}

export async function recordPostgresMonthlyResetApplied(input: {
  tokenAccountId: string;
  feishuUserId: string;
  period: string;
  monthlyQuota: number;
  approvalOperatorOpenId: string;
  now: string;
  requestId: string;
  approvalUuid: string;
}) {
  return withTransaction(async (client) => {
    const accountResult = await client.query<{ data: TokenAccount }>(
      `select data from token_accounts
       where id = $1 and feishu_user_id = $2 and status = 'active'
       for update`,
      [input.tokenAccountId, input.feishuUserId],
    );
    const account = accountResult.rows[0]?.data;
    if (!account) {
      return {
        applied: false,
        reason: "active_token_not_found",
        account: null,
        request: null,
      };
    }
    if (account.billingPeriod === input.period) {
      return {
        applied: false,
        reason: "already_current_period",
        account,
        request: null,
      };
    }

    const previousPeriod = account.billingPeriod || periodFromIso(account.createdAt);
    const updatedAccount: TokenAccount = {
      ...account,
      billingPeriod: input.period,
    };
    const storedAccount = await saveTokenAccountRow(client, updatedAccount);
    const request: TokenRequest = {
      id: input.requestId,
      feishuUserId: input.feishuUserId,
      requestType: "monthly_reset",
      status: "provisioned",
      reason: `monthly billing reset ${input.period}`,
      requestedMonthlyQuota: input.monthlyQuota,
      approvedMonthlyQuota: input.monthlyQuota,
      approvalUuid: input.approvalUuid,
      approvalMode: "manual",
      approvalOperatorOpenId: input.approvalOperatorOpenId,
      approvalOperatedAt: input.now,
      tokenAccountId: storedAccount.id,
      createdAt: input.now,
      updatedAt: input.now,
    };
    const storedRequest = await saveTokenRequestRow(client, request);
    await syncPostgresBillingPeriodForUser(client, input.feishuUserId, previousPeriod);
    await syncPostgresBillingPeriodForUser(client, input.feishuUserId, input.period);
    return {
      applied: true,
      reason: "applied",
      account: storedAccount,
      request: storedRequest,
    };
  });
}

export async function upsertPostgresFeishuEvent(
  event: Omit<FeishuEvent, "id" | "createdAt">,
) {
  return withTransaction(async (client) => {
    const existingResult = await client.query<{ data: FeishuEvent }>(
      `select data from feishu_events where event_uuid = $1 for update`,
      [event.eventUuid],
    );
    const existing = existingResult.rows[0]?.data;
    const stored: FeishuEvent = existing
      ? { ...existing, ...event }
      : { id: randomId("fe"), createdAt: nowIso(), ...event };
    return saveFeishuEventRow(client, stored);
  });
}

export async function getPostgresFeishuEventByUuid(eventUuid: string) {
  return withClient(async (client) => {
    const result = await client.query<{ data: FeishuEvent }>(
      "select data from feishu_events where event_uuid = $1",
      [eventUuid],
    );
    return result.rows[0]?.data ?? null;
  });
}

export async function upsertPostgresManualAdminScope(input: {
  targetOpenId: string;
  scopeType: AdminScope["scopeType"];
  departmentId?: string;
}) {
  return withTransaction(async (client) => {
    const userResult = await client.query<{ data: FeishuUser }>(
      `select data from feishu_users
       where open_id = $1
       order by created_at, id
       limit 1
       for update`,
      [input.targetOpenId],
    );
    const targetUser = userResult.rows[0]?.data;
    if (!targetUser) {
      return {
        scope: null,
        error: "target_user_not_found" as const,
      };
    }

    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `admin_scope:manual:${targetUser.id}:${input.scopeType}:${input.departmentId ?? ""}`,
    ]);

    const existingResult = await client.query<{ data: AdminScope }>(
      `select data from admin_scopes
       where feishu_user_id = $1
         and source = 'manual'
         and scope_type = $2
         and ($2 = 'global' or department_id is not distinct from $3)
       order by created_at, id
       limit 1
       for update`,
      [targetUser.id, input.scopeType, input.departmentId ?? null],
    );
    const now = nowIso();
    if (isInactiveUser(targetUser)) {
      await saveFeishuUserRow(client, {
        ...targetUser,
        status: "active",
        disabledAt: undefined,
        disabledReason: undefined,
        deletedAt: undefined,
        deletedReason: undefined,
        updatedAt: now,
      });
    }
    const existing = existingResult.rows[0]?.data;
    if (existing) {
      const updated: AdminScope = {
        ...activeAdminScope(existing, now),
        departmentId: input.scopeType === "department" ? input.departmentId : undefined,
      };
      return { scope: await saveAdminScopeRow(client, updated), error: null };
    }

    const scope: AdminScope = {
      id: randomId("as"),
      feishuUserId: targetUser.id,
      scopeType: input.scopeType,
      departmentId: input.scopeType === "department" ? input.departmentId : undefined,
      source: "manual",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    return { scope: await saveAdminScopeRow(client, scope), error: null };
  });
}

export async function updatePostgresManualAdminScope(input: {
  scopeId: string;
  status?: AdminScope["status"];
  departmentId?: string;
  disabledReason?: AdminScope["disabledReason"];
  disabledByFeishuUserId?: string;
}) {
  return withTransaction(async (client) => {
    const result = await client.query<{ data: AdminScope }>(
      "select data from admin_scopes where id = $1 for update",
      [input.scopeId],
    );
    const scope = result.rows[0]?.data;
    if (!scope || scope.source === "environment") return null;
    const now = nowIso();

    const statusUpdated =
      input.status === "active"
        ? activeAdminScope(scope, now)
        : input.status === "disabled"
          ? disabledAdminScope(scope, {
              now,
              reason: input.disabledReason ?? "manual_revoke",
              disabledByFeishuUserId: input.disabledByFeishuUserId,
            })
          : scope;

    const updated: AdminScope = {
      ...statusUpdated,
      departmentId:
        scope.scopeType === "department" && input.departmentId !== undefined
          ? input.departmentId
          : scope.departmentId,
      updatedAt: now,
    };
    return saveAdminScopeRow(client, updated);
  });
}

export async function syncPostgresDepartmentSupervisorAdminScope(input: {
  feishuUserId: string;
  departmentId: string;
  isSupervisor: boolean;
}) {
  return withTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `admin_scope:department_supervisor:${input.feishuUserId}:${input.departmentId}`,
    ]);
    const result = await client.query<{ data: AdminScope }>(
      `select data from admin_scopes
       where feishu_user_id = $1
         and scope_type = 'department'
         and department_id = $2
         and source = 'department_supervisor'
       order by created_at, id
       limit 1
       for update`,
      [input.feishuUserId, input.departmentId],
    );
    const existing = result.rows[0]?.data;
    const now = nowIso();
    const userResult = await client.query<{ data: FeishuUser }>(
      "select data from feishu_users where id = $1",
      [input.feishuUserId],
    );
    const user = userResult.rows[0]?.data;
    if (!user || isInactiveUser(user)) return null;

    const globalRevocationResult = await client.query<{ data: AdminScope }>(
      `select data from admin_scopes
       where feishu_user_id = $1
         and scope_type = 'global'
         and status = 'disabled'`,
      [input.feishuUserId],
    );
    if (
      globalRevocationResult.rows.some((row) =>
        blocksAllAutomaticAdminRestoreForUser(row.data),
      )
    ) {
      return null;
    }

    if (!input.isSupervisor) {
      if (existing) {
        if (blocksAutomaticAdminRestore(existing)) return null;
        await saveAdminScopeRow(
          client,
          disabledAdminScope(existing, {
            now,
            reason: "auto_sync_lost",
          }),
        );
      }
      return null;
    }

    if (existing) {
      if (blocksAutomaticAdminRestore(existing)) return null;
      return saveAdminScopeRow(client, activeAdminScope(existing, now));
    }

    const blockedResult = await client.query<{ data: AdminScope }>(
      `select data from admin_scopes
       where feishu_user_id = $1
         and scope_type = 'department'
         and department_id = $2
         and status = 'disabled'
       order by updated_at desc, id`,
      [input.feishuUserId, input.departmentId],
    );
    if (blockedResult.rows.some((row) => blocksAutomaticAdminRestore(row.data))) return null;

    const scope: AdminScope = {
      id: randomId("as"),
      feishuUserId: input.feishuUserId,
      scopeType: "department",
      departmentId: input.departmentId,
      source: "department_supervisor",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    return saveAdminScopeRow(client, scope);
  });
}

export async function updatePostgresUserAccessStatus(input: {
  feishuUserId: string;
  status: "disabled" | "deleted";
  reason?: string;
  tokenStatus: Extract<TokenStatus, "disabled" | "revoked">;
  adminRevokedByFeishuUserId?: string;
}) {
  return withTransaction(async (client) => {
    const now = nowIso();
    const userResult = await client.query<{ data: FeishuUser }>(
      "select data from feishu_users where id = $1 for update",
      [input.feishuUserId],
    );
    const user = userResult.rows[0]?.data;
    if (!user) return null;

    const activeResult = await client.query<{ data: TokenAccount }>(
      `select data from token_accounts
       where feishu_user_id = $1 and status = 'active'
       order by created_at desc, id desc
       limit 1
       for update`,
      [input.feishuUserId],
    );
    const activeAccount = activeResult.rows[0]?.data;
    const storedAccount = activeAccount
      ? await saveTokenAccountRow(client, {
          ...activeAccount,
          status: input.tokenStatus,
          disabledAt: now,
        })
      : null;

    const updatedUser: FeishuUser = {
      ...user,
      status: input.status,
      updatedAt: now,
      disabledAt: input.status === "disabled" ? now : user.disabledAt ?? now,
      disabledReason:
        input.status === "disabled" ? input.reason : user.disabledReason ?? input.reason,
      deletedAt: input.status === "deleted" ? now : user.deletedAt,
      deletedReason: input.status === "deleted" ? input.reason : user.deletedReason,
    };
    const storedUser = await saveFeishuUserRow(client, updatedUser);
    if (input.status === "deleted") {
      await revokeAdminScopesForUserInTransaction(client, {
        feishuUserId: input.feishuUserId,
        reason: "user_deleted",
        disabledByFeishuUserId: input.adminRevokedByFeishuUserId,
        now,
      });
    }
    if (storedAccount) {
      await syncPostgresBillingPeriodForUser(
        client,
        storedAccount.feishuUserId,
        storedAccount.billingPeriod || periodFromIso(storedAccount.createdAt),
      );
    }
    return { user: storedUser, tokenAccount: storedAccount };
  });
}

export async function revokePostgresAdminScopesForUser(input: {
  feishuUserId: string;
  reason: NonNullable<AdminScope["disabledReason"]>;
  disabledByFeishuUserId?: string;
}) {
  return withTransaction((client) =>
    revokeAdminScopesForUserInTransaction(client, {
      ...input,
      now: nowIso(),
    }),
  );
}

export async function enablePostgresUserAccess(input: {
  feishuUserId: string;
  reason?: string;
}) {
  return withTransaction(async (client) => {
    const now = nowIso();
    const userResult = await client.query<{ data: FeishuUser }>(
      "select data from feishu_users where id = $1 for update",
      [input.feishuUserId],
    );
    const user = userResult.rows[0]?.data;
    if (!user || user.status !== "disabled") return null;

    const activeResult = await client.query<{ data: TokenAccount }>(
      `select data from token_accounts
       where feishu_user_id = $1 and status = 'active'
       limit 1
       for update`,
      [input.feishuUserId],
    );
    if (activeResult.rows[0]?.data) return null;

    const disabledResult = await client.query<{ data: TokenAccount }>(
      `select data from token_accounts
       where feishu_user_id = $1 and status = 'disabled'
       order by coalesce(disabled_at, created_at) desc, created_at desc, id desc
       limit 1
       for update`,
      [input.feishuUserId],
    );
    const disabledAccount = disabledResult.rows[0]?.data;
    if (!disabledAccount) return null;

    const storedAccount = await saveTokenAccountRow(client, {
      ...disabledAccount,
      status: "active",
      disabledAt: undefined,
    });
    const storedUser = await saveFeishuUserRow(client, {
      ...user,
      status: "active",
      updatedAt: now,
      disabledAt: undefined,
      disabledReason: undefined,
    });
    await syncPostgresBillingPeriodForUser(
      client,
      storedAccount.feishuUserId,
      storedAccount.billingPeriod || periodFromIso(storedAccount.createdAt),
    );
    return { user: storedUser, tokenAccount: storedAccount };
  });
}

export async function insertPostgresProxyLog(log: ProxyRequestLog) {
  return withTransaction(async (client) => {
    const stored = await saveProxyLogRow(client, log);
    if (stored.feishuUserId) {
      await syncPostgresBillingPeriodForUser(
        client,
        stored.feishuUserId,
        periodFromIso(stored.createdAt),
      );
    }
    return stored;
  });
}

export async function updatePostgresProxyLog(
  id: string,
  patch: Partial<Omit<ProxyRequestLog, "id" | "createdAt">>,
) {
  return withTransaction(async (client) => {
    const result = await client.query<{ data: ProxyRequestLog }>(
      "select data from proxy_request_logs where id = $1 for update",
      [id],
    );
    const existing = result.rows[0]?.data;
    if (!existing) return null;
    const updated: ProxyRequestLog = {
      ...existing,
      ...patch,
      updatedAt: nowIso(),
    };
    if (
      updated.totalTokens === undefined &&
      updated.promptTokens !== undefined &&
      updated.completionTokens !== undefined
    ) {
      updated.totalTokens = updated.promptTokens + updated.completionTokens;
    }
    const stored = await saveProxyLogRow(client, updated);
    if (stored.feishuUserId) {
      await syncPostgresBillingPeriodForUser(
        client,
        stored.feishuUserId,
        periodFromIso(stored.createdAt),
      );
    }
    return stored;
  });
}

export async function upsertPostgresNewApiUsageRecord(record: NewApiUsageRecord) {
  return withTransaction(async (client) => {
    for (const lockKey of newApiUsageIdentityLockKeys(record)) {
      await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [lockKey]);
    }
    const existingResult = await client.query<{ data: NewApiUsageRecord }>(
      `select data
       from newapi_usage_records
       where id = $1
          or (
            newapi_token_id is not distinct from $2
            and (
              ($3::text is not null and newapi_request_id = $3)
              or (
                ($3::text is null or newapi_request_id is null)
                and $4::text is not null
                and newapi_log_id = $4
              )
            )
          )
       order by case when id = $1 then 0 else 1 end
       limit 1
       for update`,
      [record.id, record.newapiTokenId ?? null, record.newapiRequestId ?? null, record.newapiLogId ?? null],
    );
    const existing = existingResult.rows[0]?.data;
    const stored = await saveNewApiUsageRecordRow(client, {
      ...existing,
      ...record,
      id: existing?.id ?? record.id,
      firstSeenAt: existing?.firstSeenAt ?? record.firstSeenAt,
    });

    const affected = new Map<string, { feishuUserId: string; period: string }>();
    if (existing?.feishuUserId) {
      const period = usageRecordPeriod(existing);
      affected.set(`${existing.feishuUserId}\n${period}`, {
        feishuUserId: existing.feishuUserId,
        period,
      });
    }
    if (stored.feishuUserId) {
      const period = usageRecordPeriod(stored);
      affected.set(`${stored.feishuUserId}\n${period}`, {
        feishuUserId: stored.feishuUserId,
        period,
      });
    }
    for (const item of affected.values()) {
      await syncPostgresBillingPeriodForUser(client, item.feishuUserId, item.period);
    }
    return stored;
  });
}

export async function upsertPostgresUsageSyncIssue(issue: UsageSyncIssue) {
  return withTransaction(async (client) => {
    const existingResult = await client.query<{ data: UsageSyncIssue }>(
      "select data from usage_sync_issues where id = $1 for update",
      [issue.id],
    );
    const existing = existingResult.rows[0]?.data;
    return saveUsageSyncIssueRow(client, {
      ...existing,
      ...issue,
      id: existing?.id ?? issue.id,
      firstSeenAt: existing?.firstSeenAt ?? issue.firstSeenAt,
      occurrences: existing ? existing.occurrences + 1 : issue.occurrences,
      status: "open",
    });
  });
}

export async function upsertPostgresUsageSyncCheckpoint(checkpoint: UsageSyncCheckpoint) {
  return withTransaction(async (client) => saveUsageSyncCheckpointRow(client, checkpoint));
}

export async function withPostgresAdvisoryLock<T>(key: string, fn: () => Promise<T>) {
  if (getConfig().postgres.poolMax < 2) {
    throw new Error(
      "DATABASE_POOL_MAX must be at least 2 when running PostgreSQL advisory locked operations",
    );
  }
  return withClient(async (client) => {
    const lockResult = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)::bigint) as locked",
      [key],
    );
    if (!lockResult.rows[0]?.locked) {
      throw new Error(`${key} is already running`);
    }
    try {
      return await fn();
    } finally {
      await client.query("select pg_advisory_unlock(hashtext($1)::bigint)", [key]);
    }
  });
}

export async function writePostgresStore(store: StoreShape) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("delete from app_settings");
    await client.query("delete from admin_scopes");
    await client.query("delete from usage_sync_issues");
    await client.query("delete from usage_sync_checkpoints");
    await client.query("delete from newapi_usage_records");
    await client.query("delete from proxy_request_logs");
    await client.query("delete from feishu_events");
    await client.query("delete from user_billing_periods");
    await client.query("delete from token_accounts");
    await client.query("delete from token_requests");
    await client.query("delete from feishu_users");

    await client.query("insert into app_settings (id, data) values ('default', $1)", [
      store.settings,
    ]);

    await insertJsonRows(client, "feishu_users", store.users, (user) => ({
      sql: `insert into feishu_users
        (id, tenant_key, open_id, department_id, data, created_at, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7)`,
      values: [
        user.id,
        user.tenantKey,
        user.openId,
        user.departmentId ?? null,
        user,
        user.createdAt,
        user.updatedAt,
      ],
    }));

    await insertJsonRows(client, "token_requests", store.tokenRequests, (request) => ({
      sql: `insert into token_requests
        (id, feishu_user_id, request_type, status, approval_action_nonce_hash,
         approval_instance_code, approval_department_id, approval_target_open_id,
         data, created_at, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      values: [
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
    }));

    await insertJsonRows(client, "token_accounts", store.tokenAccounts, (account) => ({
      sql: `insert into token_accounts
        (id, feishu_user_id, token_request_id, newapi_token_id, key_hash,
         status, billing_period, data, created_at, disabled_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      values: [
        account.id,
        account.feishuUserId,
        account.tokenRequestId,
        account.newapiTokenId ?? null,
        account.keyHash,
        account.status,
        account.billingPeriod,
        account,
        account.createdAt,
        account.disabledAt ?? null,
      ],
    }));

    await insertJsonRows(
      client,
      "user_billing_periods",
      store.userBillingPeriods,
      (period) => ({
        sql: `insert into user_billing_periods
          (id, feishu_user_id, period, data, updated_at)
          values ($1, $2, $3, $4, $5)`,
        values: [period.id, period.feishuUserId, period.period, period, period.updatedAt],
      }),
    );

    await insertJsonRows(client, "feishu_events", store.feishuEvents, (event) => ({
      sql: `insert into feishu_events
        (id, event_uuid, event_type, instance_code, card_request_id, card_action,
         operator_open_id, message_id, processing_status, data, created_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      values: [
        event.id,
        event.eventUuid,
        event.eventType ?? null,
        event.instanceCode ?? null,
        event.cardRequestId ?? null,
        event.cardAction ?? null,
        event.operatorOpenId ?? null,
        event.messageId ?? null,
        event.processingStatus,
        event,
        event.createdAt,
      ],
    }));

    await insertJsonRows(client, "proxy_request_logs", store.proxyRequestLogs, (log) => ({
      sql: `insert into proxy_request_logs
        (id, feishu_user_id, token_account_id, request_path, method, status_code,
         data, created_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      values: [
        log.id,
        log.feishuUserId ?? null,
        log.tokenAccountId ?? null,
        log.requestPath,
        log.method,
        log.statusCode,
        log,
        log.createdAt,
      ],
    }));

    await insertJsonRows(client, "newapi_usage_records", store.newapiUsageRecords, (record) => ({
      sql: `insert into newapi_usage_records
        (id, newapi_log_id, newapi_request_id, newapi_token_id, token_account_id,
         feishu_user_id, match_status, data, newapi_created_at, first_seen_at, last_synced_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      values: [
        record.id,
        record.newapiLogId ?? null,
        record.newapiRequestId ?? null,
        record.newapiTokenId ?? null,
        record.tokenAccountId ?? null,
        record.feishuUserId ?? null,
        record.matchStatus,
        record,
        record.newapiCreatedAt ?? null,
        record.firstSeenAt,
        record.lastSyncedAt,
      ],
    }));

    await insertJsonRows(
      client,
      "usage_sync_checkpoints",
      store.usageSyncCheckpoints,
      (checkpoint) => ({
        sql: `insert into usage_sync_checkpoints
          (id, scope, data, updated_at)
          values ($1, $2, $3, $4)`,
        values: [checkpoint.id, checkpoint.scope, checkpoint, checkpoint.updatedAt],
      }),
    );

    await insertJsonRows(client, "usage_sync_issues", store.usageSyncIssues, (issue) => ({
      sql: `insert into usage_sync_issues
        (id, issue_type, status, newapi_log_id, newapi_request_id, newapi_token_id,
         data, first_seen_at, last_seen_at, last_synced_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      values: [
        issue.id,
        issue.issueType,
        issue.status,
        issue.newapiLogId ?? null,
        issue.newapiRequestId ?? null,
        issue.newapiTokenId ?? null,
        issue,
        issue.firstSeenAt,
        issue.lastSeenAt,
        issue.lastSyncedAt,
      ],
    }));

    await insertJsonRows(client, "admin_scopes", store.adminScopes, (scope) => ({
      sql: `insert into admin_scopes
        (id, feishu_user_id, scope_type, department_id, source, status,
         data, created_at, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      values: [
        scope.id,
        scope.feishuUserId,
        scope.scopeType,
        scope.departmentId ?? null,
        scope.source,
        scope.status,
        scope,
        scope.createdAt,
        scope.updatedAt,
      ],
    }));

    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
