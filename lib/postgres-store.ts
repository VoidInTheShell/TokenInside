import { Pool, type PoolClient } from "pg";
import { getConfig } from "@/lib/config";
import { nowIso, randomId } from "@/lib/crypto";
import type { NormalizedNewApiUsageLog } from "@/lib/newapi";
import {
  hasConflictingProxyMatch,
  newApiUsageIdentityLockKeys,
  sameNewApiUsageSource,
} from "@/lib/newapi-usage-identity";
import {
  initialUnassignedMonthlyQuota,
  materializeDepartmentQuota,
  materializeUserQuota,
  resolveUsageBillingPeriod,
} from "@/lib/quota-model";
import { assertQuotaOperationTransition } from "@/lib/quota-saga-state";
import {
  assertQuotaAdmission,
  QuotaAdmissionClosedError,
  QuotaOperationBusyError,
  StaleTokenGenerationError,
} from "@/lib/quota-admission";
import {
  findProxyLogForNewApiUsage,
  isBillableProxyLog,
  isNewApiUsageMatchEligibleProxyLog,
} from "@/lib/usage-matching";
import type {
  AdminScope,
  AppSettings,
  DepartmentQuotaPeriod,
  DepartmentQuotaRequest,
  FeishuEvent,
  FeishuUser,
  NewApiUsageRecord,
  ProxyAdmissionLogInput,
  ProxyRequestLog,
  ProxyRequestAdmissionResult,
  QuotaChangeEvent,
  QuotaLedgerEntry,
  QuotaOperation,
  QuotaReconciliationRecord,
  RequestStatus,
  StoreShape,
  TokenAccount,
  TokenStatus,
  TokenRequest,
  UsageSyncCheckpoint,
  UsageSyncIssue,
  UserQuotaPolicy,
  UserQuotaState,
  UserBillingPeriod,
} from "@/lib/types";

const POSTGRES_POOL_REGISTRY_VERSION = 1;

type PostgresPoolRegistry = {
  version: typeof POSTGRES_POOL_REGISTRY_VERSION;
  configFingerprint?: string;
  business?: Pool;
  settlement?: Pool;
  control?: Pool;
  advisoryLock?: Pool;
};

type PostgresPoolGlobal = typeof globalThis & {
  __tokenInsidePostgresPoolRegistry?: PostgresPoolRegistry;
};

// Next.js emits independent server chunks for instrumentation, /v1, health,
// and control routes. Module-local Pool variables are duplicated in those
// chunks, so both the connection budget and health snapshot would otherwise
// be false. All chunks in this Node process share this one versioned registry.
const postgresPoolGlobal = globalThis as PostgresPoolGlobal;

function getPostgresPoolRegistry() {
  const existing = postgresPoolGlobal.__tokenInsidePostgresPoolRegistry;
  if (existing) {
    if (existing.version !== POSTGRES_POOL_REGISTRY_VERSION) {
      throw new Error("PostgreSQL pool registry version mismatch; restart TokenInside");
    }
    return existing;
  }
  const created: PostgresPoolRegistry = {
    version: POSTGRES_POOL_REGISTRY_VERSION,
  };
  postgresPoolGlobal.__tokenInsidePostgresPoolRegistry = created;
  return created;
}

function getValidatedPostgresPoolRegistry() {
  const config = getConfig();
  const fingerprint = JSON.stringify({
    databaseUrl: config.databaseUrl,
    poolMax: config.postgres.poolMax,
    settlementPoolMax: config.postgres.settlementPoolMax,
    controlPoolMax: config.postgres.controlPoolMax,
    lockPoolMax: config.postgres.lockPoolMax,
    idleTimeoutMs: config.postgres.poolIdleTimeoutMs,
    connectionTimeoutMs: config.postgres.poolConnectionTimeoutMs,
  });
  const registry = getPostgresPoolRegistry();
  if (registry.configFingerprint && registry.configFingerprint !== fingerprint) {
    throw new Error("PostgreSQL pool configuration changed at runtime; restart TokenInside");
  }
  registry.configFingerprint ??= fingerprint;
  return { config, registry };
}

function poolRuntimeSnapshot(target?: Pool) {
  return {
    total: target?.totalCount ?? 0,
    idle: target?.idleCount ?? 0,
    waiting: target?.waitingCount ?? 0,
  };
}

export function postgresPoolRuntimeSnapshot() {
  const registry = getPostgresPoolRegistry();
  return {
    business: poolRuntimeSnapshot(registry.business),
    settlement: poolRuntimeSnapshot(registry.settlement),
    control: poolRuntimeSnapshot(registry.control),
    lock: poolRuntimeSnapshot(registry.advisoryLock),
  };
}

export const REQUIRED_POSTGRES_TABLES = [
  "schema_migrations",
  "app_settings",
  "feishu_users",
  "token_requests",
  "token_accounts",
  "user_billing_periods",
  "department_quota_periods",
  "department_quota_requests",
  "quota_change_events",
  "user_quota_policies",
  "quota_operations",
  "quota_ledger_entries",
  "user_quota_states",
  "quota_reconciliation_records",
  "feishu_events",
  "proxy_request_logs",
  "newapi_usage_records",
  "usage_sync_checkpoints",
  "usage_sync_issues",
  "admin_scopes",
] as const;

function getPool() {
  const { config, registry } = getValidatedPostgresPoolRegistry();
  if (registry.business) return registry.business;
  const databaseUrl = config.databaseUrl;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required when TOKENINSIDE_STORE_BACKEND=postgres");
  }
  registry.business = new Pool({
    connectionString: databaseUrl,
    max: config.postgres.poolMax,
    idleTimeoutMillis: config.postgres.poolIdleTimeoutMs,
    connectionTimeoutMillis: config.postgres.poolConnectionTimeoutMs,
  });
  return registry.business;
}

function getControlPool() {
  const { config, registry } = getValidatedPostgresPoolRegistry();
  if (registry.control) return registry.control;
  const databaseUrl = config.databaseUrl;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required when TOKENINSIDE_STORE_BACKEND=postgres");
  }
  registry.control = new Pool({
    connectionString: databaseUrl,
    max: config.postgres.controlPoolMax,
    idleTimeoutMillis: config.postgres.poolIdleTimeoutMs,
    connectionTimeoutMillis: config.postgres.poolConnectionTimeoutMs,
  });
  return registry.control;
}

function getSettlementPool() {
  const { config, registry } = getValidatedPostgresPoolRegistry();
  if (registry.settlement) return registry.settlement;
  const databaseUrl = config.databaseUrl;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required when TOKENINSIDE_STORE_BACKEND=postgres");
  }
  registry.settlement = new Pool({
    connectionString: databaseUrl,
    max: config.postgres.settlementPoolMax,
    idleTimeoutMillis: config.postgres.poolIdleTimeoutMs,
    connectionTimeoutMillis: config.postgres.poolConnectionTimeoutMs,
  });
  return registry.settlement;
}

function getAdvisoryLockPool() {
  const { config, registry } = getValidatedPostgresPoolRegistry();
  if (registry.advisoryLock) return registry.advisoryLock;
  const databaseUrl = config.databaseUrl;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required when TOKENINSIDE_STORE_BACKEND=postgres");
  }
  registry.advisoryLock = new Pool({
    connectionString: databaseUrl,
    max: config.postgres.lockPoolMax,
    idleTimeoutMillis: config.postgres.poolIdleTimeoutMs,
    connectionTimeoutMillis: config.postgres.poolConnectionTimeoutMs,
  });
  return registry.advisoryLock;
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

async function withControlClient<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await getControlPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function withSettlementClient<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await getSettlementPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export { withControlClient as withPostgresControlClient };

async function withAdvisoryLockClient<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await getAdvisoryLockPool().connect();
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

async function withControlTransaction<T>(fn: (client: PoolClient) => Promise<T>) {
  return withControlClient(async (client) => {
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

async function withSettlementTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
) {
  return withSettlementClient(async (client) => {
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
  return resolveUsageBillingPeriod({
    billingPeriod: record.billingPeriod,
    occurredAt: record.newapiCreatedAt ?? record.lastSyncedAt ?? record.firstSeenAt,
  });
}

async function lockPostgresUserQuotaFence(client: PoolClient, feishuUserId: string) {
  await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
    `user-quota-fence:${feishuUserId}`,
  ]);
}

function authoritativeQuotaFromRecord(record: NewApiUsageRecord, quotaPerUnit: number) {
  if (Number.isFinite(record.quota)) return Math.max(Math.round(record.quota as number), 0);
  if (Number.isFinite(record.cost)) {
    return Math.max(Math.round((record.cost as number) * quotaPerUnit), 0);
  }
  return 0;
}

type PostgresUserQuotaMaterialization = {
  feishuUserId: string;
  period: string;
  legacyMonthlyQuota: number;
  legacyConsumedQuota: number;
  assignedMonthlyQuota: number;
  authorizedQuota: number;
  authoritativeConsumedQuota: number;
  expectedAvailableQuota: number;
  overageQuota: number;
  ledgerEntries: number;
  policyPresent: boolean;
};

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
       status, billing_period, operation_generation, drain_started_at,
       settled_through, activated_at, data, created_at, disabled_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     on conflict (id) do update set
       feishu_user_id = excluded.feishu_user_id,
       token_request_id = excluded.token_request_id,
       newapi_token_id = excluded.newapi_token_id,
       key_hash = excluded.key_hash,
       status = excluded.status,
       billing_period = excluded.billing_period,
       operation_generation = excluded.operation_generation,
       drain_started_at = excluded.drain_started_at,
       settled_through = excluded.settled_through,
       activated_at = excluded.activated_at,
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
      account.operationGeneration ?? 0,
      account.drainStartedAt ?? null,
      account.settledThrough ?? null,
      account.activatedAt ?? null,
      account,
      account.createdAt,
      account.disabledAt ?? null,
    ],
  );
  return result.rows[0].data;
}

async function saveUserQuotaPolicyRow(client: PoolClient, policy: UserQuotaPolicy) {
  const result = await client.query<{ data: UserQuotaPolicy }>(
    `insert into user_quota_policies
      (id, feishu_user_id, department_id, effective_from_period, effective_to_period,
       version, data, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (id) do update set
       department_id = excluded.department_id,
       effective_from_period = excluded.effective_from_period,
       effective_to_period = excluded.effective_to_period,
       version = excluded.version,
       data = excluded.data,
       updated_at = excluded.updated_at
     returning data`,
    [
      policy.id,
      policy.feishuUserId,
      policy.departmentId ?? null,
      policy.effectiveFromPeriod,
      policy.effectiveToPeriod ?? null,
      policy.version,
      policy,
      policy.createdAt,
      policy.updatedAt,
    ],
  );
  return result.rows[0].data;
}

async function saveQuotaOperationRow(client: PoolClient, operation: QuotaOperation) {
  const result = await client.query<{ data: QuotaOperation }>(
    `insert into quota_operations
      (id, operation_type, idempotency_key, feishu_user_id, department_id,
       billing_period, state, operation_generation, next_retry_at, data,
       created_at, updated_at, completed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     on conflict (id) do update set
       state = excluded.state,
       next_retry_at = excluded.next_retry_at,
       data = excluded.data,
       updated_at = excluded.updated_at,
       completed_at = excluded.completed_at
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
      operation.nextRetryAt ?? null,
      operation,
      operation.createdAt,
      operation.updatedAt,
      operation.completedAt ?? null,
    ],
  );
  return result.rows[0].data;
}

async function insertQuotaLedgerEntryRow(client: PoolClient, entry: QuotaLedgerEntry) {
  const inserted = await client.query<{ data: QuotaLedgerEntry }>(
    `insert into quota_ledger_entries
      (id, operation_id, feishu_user_id, department_id, period, entry_type,
       signed_quota, data, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (operation_id, entry_type) do nothing
     returning data`,
    [
      entry.id,
      entry.operationId,
      entry.feishuUserId,
      entry.departmentId ?? null,
      entry.period,
      entry.entryType,
      entry.signedQuota,
      entry,
      entry.createdAt,
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0].data;
  const existing = await client.query<{ data: QuotaLedgerEntry }>(
    `select data from quota_ledger_entries
     where operation_id = $1 and entry_type = $2`,
    [entry.operationId, entry.entryType],
  );
  return existing.rows[0].data;
}

async function saveUserQuotaStateRow(client: PoolClient, state: UserQuotaState) {
  const result = await client.query<{ data: UserQuotaState }>(
    `insert into user_quota_states
      (feishu_user_id, admission, active_generation, operation_id, data, updated_at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (feishu_user_id) do update set
       admission = excluded.admission,
       active_generation = excluded.active_generation,
       operation_id = excluded.operation_id,
       data = excluded.data,
       updated_at = excluded.updated_at
     returning data`,
    [
      state.feishuUserId,
      state.admission,
      state.activeGeneration,
      state.operationId ?? null,
      state,
      state.updatedAt,
    ],
  );
  return result.rows[0].data;
}

async function saveQuotaReconciliationRow(
  client: PoolClient,
  record: QuotaReconciliationRecord,
) {
  const result = await client.query<{ data: QuotaReconciliationRecord }>(
    `insert into quota_reconciliation_records
      (id, feishu_user_id, token_account_id, period, status, operation_id,
       data, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (id) do update set
       status = excluded.status,
       operation_id = excluded.operation_id,
       data = excluded.data,
       updated_at = excluded.updated_at
     returning data`,
    [
      record.id,
      record.feishuUserId,
      record.tokenAccountId ?? null,
      record.period,
      record.status,
      record.operationId ?? null,
      record,
      record.createdAt,
      record.updatedAt,
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

async function saveDepartmentQuotaPeriodRow(
  client: PoolClient,
  period: DepartmentQuotaPeriod,
) {
  const result = await client.query<{ data: DepartmentQuotaPeriod }>(
    `insert into department_quota_periods
      (id, department_id, period, data, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (department_id, period) do update set
       data = excluded.data,
       updated_at = excluded.updated_at
     returning data`,
    [
      period.id,
      period.departmentId,
      period.period,
      period,
      period.createdAt,
      period.updatedAt,
    ],
  );
  return result.rows[0].data;
}

async function saveDepartmentQuotaRequestRow(
  client: PoolClient,
  request: DepartmentQuotaRequest,
) {
  const result = await client.query<{ data: DepartmentQuotaRequest }>(
    `insert into department_quota_requests
      (id, department_id, requester_feishu_user_id, period, status,
       approval_target_open_id, approval_action_nonce_hash, data, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (id) do update set
       status = excluded.status,
       approval_target_open_id = excluded.approval_target_open_id,
       approval_action_nonce_hash = excluded.approval_action_nonce_hash,
       data = excluded.data,
       updated_at = excluded.updated_at
     returning data`,
    [
      request.id,
      request.departmentId,
      request.requesterFeishuUserId,
      request.period,
      request.status,
      request.approvalTargetOpenId,
      request.approvalActionNonceHash,
      request,
      request.createdAt,
      request.updatedAt,
    ],
  );
  return result.rows[0].data;
}

async function saveQuotaChangeEventRow(client: PoolClient, event: QuotaChangeEvent) {
  const result = await client.query<{ data: QuotaChangeEvent }>(
    `insert into quota_change_events
      (id, department_id, feishu_user_id, period, status,
       related_token_request_id, data, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (id) do update set
       status = excluded.status,
       related_token_request_id = excluded.related_token_request_id,
       data = excluded.data,
       updated_at = excluded.updated_at
     returning data`,
    [
      event.id,
      event.departmentId,
      event.feishuUserId ?? null,
      event.period,
      event.status,
      event.relatedTokenRequestId ?? null,
      event,
      event.createdAt,
      event.updatedAt,
    ],
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
       billing_period, operation_generation, lease_expires_at, heartbeat_at,
       data, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (id) do update set
       feishu_user_id = excluded.feishu_user_id,
       token_account_id = excluded.token_account_id,
       request_path = excluded.request_path,
       method = excluded.method,
       status_code = excluded.status_code,
       billing_period = excluded.billing_period,
       operation_generation = excluded.operation_generation,
       lease_expires_at = excluded.lease_expires_at,
       heartbeat_at = excluded.heartbeat_at,
       data = excluded.data
     returning data`,
    [
      log.id,
      log.feishuUserId ?? null,
      log.tokenAccountId ?? null,
      log.requestPath,
      log.method,
      log.statusCode,
      log.billingPeriod ?? null,
      log.operationGeneration ?? 0,
      log.leaseExpiresAt ?? null,
      log.heartbeatAt ?? null,
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
  materializedAt = nowIso(),
) {
  // Every writer that derives this shared row uses the same transaction fence.
  // This serializes finalizers with quota materialization without holding a
  // stale UserBillingPeriod snapshot outside the lock.
  await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
    `billing-period-finalize:${feishuUserId}:${period}`,
  ]);

  const settings = await readSettingsRow(client);
  const seededAt = materializedAt;
  const initialMonthlyQuota = initialUnassignedMonthlyQuota({
    defaultMonthlyQuota: settings.defaultMonthlyQuota,
    quotaMigrationApplied: Boolean(settings.quotaMigration?.appliedAt),
  });
  const seed: UserBillingPeriod = {
    id: randomId("bp"),
    feishuUserId,
    period,
    monthlyQuota: initialMonthlyQuota,
    quotaConsumed: 0,
    cost: 0,
    remainingQuota: initialMonthlyQuota,
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
  const policy = (
    await client.query<{ data: UserQuotaPolicy }>(
      `select data
       from user_quota_policies
       where feishu_user_id = $1
         and effective_from_period <= $2
         and (effective_to_period is null or effective_to_period >= $2)
       order by version desc, id desc
       limit 1`,
      [feishuUserId, period],
    )
  ).rows[0]?.data;
  const ledgerEntries = (
    await client.query<{ data: QuotaLedgerEntry }>(
      `select data
       from quota_ledger_entries
       where feishu_user_id = $1 and period = $2
       order by created_at, id`,
      [feishuUserId, period],
    )
  ).rows.map((row) => row.data);
  const usageCheckpoint = (
    await client.query<{ data: UsageSyncCheckpoint }>(
      `select data
       from usage_sync_checkpoints
       where scope = 'newapi_usage_logs'
       limit 1`,
    )
  ).rows[0]?.data;

  const requestById = new Map(requests.map((request) => [request.id, request]));
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const summary: UserBillingPeriod & { quotaUpdatedAt?: string; sourceUpdatedAt?: string } = {
    id: existing?.id ?? randomId("bp"),
    feishuUserId,
    period,
    monthlyQuota: existing?.monthlyQuota ?? initialMonthlyQuota,
    quotaConsumed: 0,
    cost: 0,
    remainingQuota: existing?.monthlyQuota ?? initialMonthlyQuota,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    proxyLogCount: 0,
    usageRecordCount: 0,
    activeTokenAccountId: undefined,
    tokenAccountIds: [],
    assignedQuotaUpdatedAt: existing?.assignedQuotaUpdatedAt,
    assignedQuotaUpdatedByFeishuUserId: existing?.assignedQuotaUpdatedByFeishuUserId,
    updatedAt: existing?.updatedAt ?? seededAt,
    quotaUpdatedAt: existing?.assignedQuotaUpdatedAt,
    sourceUpdatedAt: undefined,
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
    if (
      request &&
      request.requestType !== "key_reset" &&
      request.requestType !== "quota_reset" &&
      request.requestType !== "quota_restore"
    ) {
      setQuota(request.approvedMonthlyQuota ?? request.requestedMonthlyQuota, request.updatedAt);
      summary.sourceUpdatedAt = latestIso(summary.sourceUpdatedAt, request.updatedAt);
    }
  }

  for (const request of requests) {
    if (
      request.status !== "provisioned" ||
      (request.requestType !== "quota_adjust" &&
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
    if (record.matchStatus !== "matched") continue;
    if (record.matchedProxyLogId) proxyLogIdsBackedByNewApiRecords.add(record.matchedProxyLogId);
    if (usageRecordPeriod(record) !== period) continue;
    summary.promptTokens += record.promptTokens ?? 0;
    summary.completionTokens += record.completionTokens ?? 0;
    summary.totalTokens +=
      record.totalTokens ?? (record.promptTokens ?? 0) + (record.completionTokens ?? 0);
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
    if (
      resolveUsageBillingPeriod({
        billingPeriod: log.billingPeriod,
        occurredAt: log.createdAt,
      }) !== period
    ) {
      continue;
    }
    if (!isBillableProxyLog(log)) continue;
    summary.proxyLogCount += 1;
    if (!proxyLogIdsBackedByNewApiRecords.has(log.id)) {
      summary.promptTokens += log.promptTokens ?? 0;
      summary.completionTokens += log.completionTokens ?? 0;
      summary.totalTokens +=
        log.totalTokens ?? (log.promptTokens ?? 0) + (log.completionTokens ?? 0);
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
  const legacyMonthlyQuota = summary.monthlyQuota;
  const legacyConsumedQuota = summary.quotaConsumed;
  const quotaPerUnit = getConfig().newapi.quotaPerUnit;
  const ledgerAuthoritative = Boolean(settings.quotaMigration?.appliedAt);
  const assignedMonthlyQuota =
    policy?.assignedMonthlyQuota ??
    (ledgerAuthoritative
      ? 0
      : Math.max(Math.round(legacyMonthlyQuota * quotaPerUnit), 0));
  const authoritativeConsumedQuota = usageRecords
    .filter((record) => record.matchStatus === "matched" && usageRecordPeriod(record) === period)
    .reduce(
      (total, record) => total + authoritativeQuotaFromRecord(record, quotaPerUnit),
      0,
    );
  const materialized = materializeUserQuota({
    assignedMonthlyQuota,
    authoritativeConsumedQuota,
    ledgerEntries,
  });

  summary.monthlyQuota = ledgerAuthoritative
    ? assignedMonthlyQuota / quotaPerUnit
    : legacyMonthlyQuota;
  summary.remainingQuota = ledgerAuthoritative
    ? materialized.expectedAvailableQuota / quotaPerUnit
    : Math.max(Number((legacyMonthlyQuota - legacyConsumedQuota).toFixed(8)), 0);
  Object.assign(summary, materialized, {
    settledThrough: usageCheckpoint?.settledThrough,
    sourceVersion: `${policy?.version ?? 0}:${ledgerEntries.length}:${summary.usageRecordCount}`,
    materializedAt,
  });
  summary.updatedAt = summary.sourceUpdatedAt ?? existing?.updatedAt ?? seededAt;
  delete summary.quotaUpdatedAt;
  delete summary.sourceUpdatedAt;

  const billingPeriod = await saveUserBillingPeriodRow(client, summary);
  const materialization: PostgresUserQuotaMaterialization = {
    feishuUserId,
    period,
    legacyMonthlyQuota: Math.round(legacyMonthlyQuota * quotaPerUnit),
    legacyConsumedQuota: Math.round(legacyConsumedQuota * quotaPerUnit),
    assignedMonthlyQuota,
    authorizedQuota: materialized.authorizedQuota,
    authoritativeConsumedQuota,
    expectedAvailableQuota: materialized.expectedAvailableQuota,
    overageQuota: materialized.overageQuota,
    ledgerEntries: ledgerEntries.length,
    policyPresent: Boolean(policy),
  };
  return { billingPeriod, materialization };
}

export async function reconcilePostgresBillingPeriodForUser(
  feishuUserId: string,
  period: string,
) {
  const result = await withTransaction((client) =>
    syncPostgresBillingPeriodForUser(client, feishuUserId, period),
  );
  return result.billingPeriod;
}

export async function reconcilePostgresBillingPeriodForQuotaOperation(
  feishuUserId: string,
  period: string,
) {
  const result = await withControlTransaction((client) =>
    syncPostgresBillingPeriodForUser(client, feishuUserId, period),
  );
  return result.billingPeriod;
}

export async function refreshPostgresBillingPeriodTokenMetadataForQuotaOperation(
  feishuUserId: string,
  period: string,
) {
  return withControlTransaction(async (client) => {
    // Keep this lightweight metadata-only refresh ordered with full billing
    // materialization so it cannot overwrite a newer authoritative snapshot.
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `billing-period-finalize:${feishuUserId}:${period}`,
    ]);
    const existingResult = await client.query<{ data: UserBillingPeriod }>(
      `select data from user_billing_periods
       where feishu_user_id = $1 and period = $2
       for update`,
      [feishuUserId, period],
    );
    const existing = existingResult.rows[0]?.data;
    if (!existing) return null;

    const accounts = (
      await client.query<{ data: TokenAccount }>(
        `select data from token_accounts
         where feishu_user_id = $1
         order by created_at, id`,
        [feishuUserId],
      )
    ).rows.map((row) => row.data);
    const periodAccounts = accounts.filter(
      (account) => (account.billingPeriod || periodFromIso(account.createdAt)) === period,
    );
    const activeTokenAccountId = periodAccounts.find(
      (account) => account.status === "active",
    )?.id;
    return saveUserBillingPeriodRow(client, {
      ...existing,
      activeTokenAccountId,
      tokenAccountIds: [...new Set(periodAccounts.map((account) => account.id))].sort(),
      materializedAt: nowIso(),
    });
  });
}

async function rebuildPostgresDepartmentQuotaMaterializedSnapshotWithClient(
  client: PoolClient,
  departmentId: string,
  period: string,
) {
  await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
    `department-quota:${departmentId}:${period}`,
  ]);
  const existingResult = await client.query<{ data: DepartmentQuotaPeriod }>(
    `select data
     from department_quota_periods
     where department_id = $1 and period = $2
     for update`,
    [departmentId, period],
  );
  const existing = existingResult.rows[0]?.data;
  if (!existing) return null;

  const committedResult = await client.query<{ quota: string }>(
    `select coalesce(sum(entry.signed_quota), 0)::text as quota
     from quota_ledger_entries entry
     where entry.period = $2
       and (
         entry.department_id = $1
         or exists (
           select 1 from feishu_users user_row
           where user_row.id = entry.feishu_user_id
             and user_row.department_id = $1
             and coalesce(user_row.data->>'status', 'active') <> 'deleted'
         )
       )`,
    [departmentId, period],
  );
  const pendingResult = await client.query<{ quota: string }>(
    `select coalesce(
       sum(greatest(coalesce((data->>'reservedDepartmentQuota')::bigint, 0), 0)),
       0
     )::text as quota
     from quota_operations
     where department_id = $1
       and billing_period = $2
       and state not in ('completed', 'compensated')`,
    [departmentId, period],
  );
  const materialized = materializeDepartmentQuota({
    budgetQuota: Math.max(
      Math.round(existing.quotaLimit * getConfig().newapi.quotaPerUnit),
      0,
    ),
    committedAuthorizedQuota: Math.max(
      Number(committedResult.rows[0]?.quota ?? 0),
      0,
    ),
    pendingReservedQuota: Math.max(Number(pendingResult.rows[0]?.quota ?? 0), 0),
  });
  return saveDepartmentQuotaPeriodRow(client, {
    ...existing,
    ...materialized,
    materializedAt: nowIso(),
    updatedAt: existing.updatedAt,
  });
}

export async function rebuildPostgresDepartmentQuotaMaterializedSnapshot(
  departmentId: string,
  period: string,
) {
  return withTransaction((client) =>
    rebuildPostgresDepartmentQuotaMaterializedSnapshotWithClient(client, departmentId, period),
  );
}

export async function rebuildPostgresDepartmentQuotaMaterializedSnapshotForQuotaOperation(
  departmentId: string,
  period: string,
) {
  return withControlTransaction((client) =>
    rebuildPostgresDepartmentQuotaMaterializedSnapshotWithClient(client, departmentId, period),
  );
}

export async function rebuildPostgresQuotaMaterializedUsers(period: string) {
  const materializedAt = nowIso();
  const userIds = await withClient(async (client) => {
    const result = await client.query<{ feishu_user_id: string }>(
      `select id as feishu_user_id from feishu_users
       union
       select feishu_user_id from user_billing_periods where period = $1
       union
       select feishu_user_id
       from user_quota_policies
       where effective_from_period <= $1
         and (effective_to_period is null or effective_to_period >= $1)
       union
       select feishu_user_id from quota_ledger_entries where period = $1
       order by feishu_user_id`,
      [period],
    );
    return result.rows.map((row) => row.feishu_user_id);
  });
  const users = new Array<PostgresUserQuotaMaterialization>(userIds.length);
  let cursor = 0;
  const workerCount = Math.min(8, userIds.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < userIds.length) {
        const index = cursor;
        cursor += 1;
        const result = await withTransaction((client) =>
          syncPostgresBillingPeriodForUser(client, userIds[index], period, materializedAt),
        );
        users[index] = result.materialization;
      }
    }),
  );
  return { materializedAt, users };
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
      departmentQuotaPeriods: await readDataRows<DepartmentQuotaPeriod>(
        client,
        "department_quota_periods",
        "period, department_id, id",
      ),
      departmentQuotaRequests: await readDataRows<DepartmentQuotaRequest>(
        client,
        "department_quota_requests",
        "created_at, id",
      ),
      quotaChangeEvents: await readDataRows<QuotaChangeEvent>(
        client,
        "quota_change_events",
        "created_at, id",
      ),
      userQuotaPolicies: await readDataRows<UserQuotaPolicy>(
        client,
        "user_quota_policies",
        "feishu_user_id, version, id",
      ),
      quotaOperations: await readDataRows<QuotaOperation>(
        client,
        "quota_operations",
        "created_at, id",
      ),
      quotaLedgerEntries: await readDataRows<QuotaLedgerEntry>(
        client,
        "quota_ledger_entries",
        "created_at, id",
      ),
      userQuotaStates: await readDataRows<UserQuotaState>(
        client,
        "user_quota_states",
        "feishu_user_id",
      ),
      quotaReconciliationRecords: await readDataRows<QuotaReconciliationRecord>(
        client,
        "quota_reconciliation_records",
        "created_at, id",
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
  return withControlClient((client) => readSettingsRow(client));
}

export async function getPostgresAppSettingsForQuotaOperation() {
  return withControlClient((client) => readSettingsRow(client));
}

export async function getPostgresUsageSyncCheckpoint(
  scope: UsageSyncCheckpoint["scope"] = "newapi_usage_logs",
) {
  return withControlClient(async (client) => {
    const result = await client.query<{ data: UsageSyncCheckpoint }>(
      "select data from usage_sync_checkpoints where scope = $1 limit 1",
      [scope],
    );
    return result.rows[0]?.data ?? null;
  });
}

export type PostgresBillingMaterializationTarget = {
  feishuUserId: string;
  billingPeriod: string;
};

/**
 * Enumerates the durable user-period obligations implied by matched NewAPI
 * source facts. The JSON record owns the billing-period snapshot; legacy rows
 * without it fall back to the NewAPI occurrence month in Hong Kong time.
 */
export async function listPostgresMatchedUsageBillingMaterializationTargets() {
  return withClient(async (client) => {
    const result = await client.query<PostgresBillingMaterializationTarget>(
      `with matched_targets as (
         select
           coalesce(
             nullif(data->>'feishuUserId', ''),
             nullif(feishu_user_id, '')
           ) as "feishuUserId",
           case
             when coalesce(data->>'billingPeriod', '') ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
               then data->>'billingPeriod'
             when newapi_created_at is not null
               then to_char(newapi_created_at at time zone 'Asia/Hong_Kong', 'YYYY-MM')
             else null
           end as "billingPeriod"
         from newapi_usage_records
         where match_status = 'matched'
       )
       select distinct "feishuUserId", "billingPeriod"
       from matched_targets
       where "feishuUserId" is not null
         and "billingPeriod" is not null
       order by "feishuUserId", "billingPeriod"`,
    );
    return result.rows;
  });
}

export type PostgresPendingUsageSettlementHorizon = {
  count: number;
  transitionedToManualReviewCount: number;
  requiredThrough?: string;
  nextDueAt?: string;
  oldestFinishedAt?: string;
};

/**
 * Rebuilds the usage tail wake-up from durable terminal proxy facts. This is
 * deliberately an aggregate query: the scheduler needs one horizon, not one
 * in-memory waiter per request.
 */
export async function getPostgresPendingUsageSettlementHorizon(
  settlementLagMinutes: number,
): Promise<PostgresPendingUsageSettlementHorizon> {
  return withControlClient(async (client) => {
    const transitionedToManualReview = await client.query(
      `update proxy_request_logs
          set data = data || jsonb_build_object(
            'usageSettlementStatus', 'manual_review',
            'usageSettlementLastError',
              'Authoritative NewAPI usage was not matched within 24 hours',
            'updatedAt', $1::text
          )
        where data->>'usageSettlementStatus' in ('pending', 'retrying')
          and coalesce(data->>'terminalStatus', data->>'status', '')
            in ('completed', 'failed', 'cancelled')
          and coalesce(
            nullif(data->>'responseTimeUpdatedAt', '')::timestamptz,
            created_at
          ) < $1::timestamptz - interval '24 hours'`,
      [nowIso()],
    );
    const result = await client.query<{
      pending_count: string;
      required_through: Date | string | null;
      next_due_at: Date | string | null;
      oldest_finished_at: Date | string | null;
    }>(
      `with pending as (
         select
           coalesce(
             nullif(data->>'responseTimeUpdatedAt', '')::timestamptz,
             created_at
           ) as finished_at,
           nullif(data->>'usageSettlementNextRetryAt', '')::timestamptz as next_retry_at
         from proxy_request_logs
         where data->>'usageSettlementStatus' in ('pending', 'retrying')
           and coalesce(data->>'terminalStatus', data->>'status', '')
             in ('completed', 'failed', 'cancelled')
       )
       select
         count(*)::text as pending_count,
         max(finished_at) as required_through,
         min(
           greatest(
             finished_at + ($1::double precision * interval '1 minute'),
             coalesce(next_retry_at, '-infinity'::timestamptz)
           )
         ) as next_due_at,
         min(finished_at) as oldest_finished_at
       from pending`,
      [Math.max(settlementLagMinutes, 0)],
    );
    const row = result.rows[0];
    const iso = (value: Date | string | null | undefined) => {
      if (!value) return undefined;
      const parsed = value instanceof Date ? value : new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
    };
    return {
      count: Number(row?.pending_count ?? 0),
      transitionedToManualReviewCount: transitionedToManualReview.rowCount ?? 0,
      requiredThrough: iso(row?.required_through),
      nextDueAt: iso(row?.next_due_at),
      oldestFinishedAt: iso(row?.oldest_finished_at),
    };
  });
}

export async function deferPostgresCoveredPendingUsageSettlements(
  scanStart: string,
  scanEnd: string,
) {
  return withControlClient(async (client) => {
    const updatedAt = nowIso();
    const result = await client.query(
      `with due as (
         select id,
                greatest(
                  coalesce((data->>'usageSettlementScanAttempts')::integer, 0),
                  0
                ) as scan_attempts,
                greatest(
                  coalesce(
                    (data->>'usageSettlementImmediateAttempts')::integer,
                    (data->>'usageSettlementAttempts')::integer,
                    0
                  ),
                  0
                ) as immediate_attempts
         from proxy_request_logs
         where data->>'usageSettlementStatus' in ('pending', 'retrying')
           and coalesce(data->>'terminalStatus', data->>'status', '')
             in ('completed', 'failed', 'cancelled')
           and coalesce(
             nullif(data->>'responseTimeUpdatedAt', '')::timestamptz,
             created_at
           ) between $1::timestamptz and $2::timestamptz
           and coalesce(
             nullif(data->>'usageSettlementNextRetryAt', '')::timestamptz,
             '-infinity'::timestamptz
           ) <= $3::timestamptz
         for update
       )
       update proxy_request_logs target
          set data = target.data || jsonb_build_object(
            'usageSettlementStatus', 'retrying',
            'usageSettlementAttempts',
              due.immediate_attempts + due.scan_attempts + 1,
            'usageSettlementScanAttempts', due.scan_attempts + 1,
            'usageSettlementLastError',
              'Authoritative source was not visible after a nearby completed scan',
            'usageSettlementNextRetryAt',
              ($3::timestamptz + case
                when due.scan_attempts < 1 then interval '15 seconds'
                when due.scan_attempts < 2 then interval '1 minute'
                when due.scan_attempts < 3 then interval '5 minutes'
                else interval '15 minutes'
              end),
            'updatedAt', $3::text
          )
         from due
        where target.id = due.id`,
      [scanStart, scanEnd, updatedAt],
    );
    return result.rowCount ?? 0;
  });
}

export async function readPostgresUsageMatchingSnapshot(input: {
  usageSources: Array<{
    recordId: string;
    usageLog: NormalizedNewApiUsageLog;
  }>;
  proxyLogIds: string[];
  fallbackWindowMs: number;
}) {
  const newapiTokenIds = [
    ...new Set(
      input.usageSources.map((source) => source.usageLog.newapiTokenId).filter(Boolean),
    ),
  ] as string[];
  const proxyLogIds = [...new Set(input.proxyLogIds.filter(Boolean))];
  return withSettlementClient(async (client) => {
    const accounts = newapiTokenIds.length
      ? await client.query<{ data: TokenAccount }>(
          "select data from token_accounts where newapi_token_id = any($1::text[])",
          [newapiTokenIds],
        )
      : { rows: [] as Array<{ data: TokenAccount }> };
    const userIds = [...new Set(accounts.rows.map((row) => row.data.feishuUserId))];
    const users = userIds.length
      ? await client.query<{ data: FeishuUser }>(
          "select data from feishu_users where id = any($1::text[])",
          [userIds],
        )
      : { rows: [] as Array<{ data: FeishuUser }> };
    const accountIds = accounts.rows.map((row) => row.data.id);
    const accountIdByTokenId = new Map(
      accounts.rows
        .filter((row) => row.data.newapiTokenId)
        .map((row) => [row.data.newapiTokenId as string, row.data.id] as const),
    );
    const exactRequestIds = [
      ...new Set(
        input.usageSources
          .flatMap((source) => [
            source.usageLog.newapiRequestId,
            source.usageLog.newapiUpstreamRequestId,
          ])
          .filter(Boolean),
      ),
    ] as string[];
    const exactLogIds = [
      ...new Set(
        input.usageSources.map((source) => source.usageLog.newapiLogId).filter(Boolean),
      ),
    ] as string[];
    const exactProxyLogs = proxyLogIds.length
      ? await client.query<{ data: ProxyRequestLog }>(
          "select data from proxy_request_logs where id = any($1::text[])",
          [proxyLogIds],
        )
      : accountIds.length && (exactRequestIds.length || exactLogIds.length)
        ? await client.query<{ data: ProxyRequestLog }>(
            `select data
               from proxy_request_logs
              where (
                  token_account_id = any($1::text[])
                  or data->>'providerKeyName' = any($2::text[])
                )
                and (
                  data->>'newapiRequestId' = any($3::text[])
                  or data->>'newapiResponseRequestId' = any($3::text[])
                  or data->>'newapiUpstreamRequestId' = any($3::text[])
                  or data->>'newapiLogId' = any($4::text[])
                )
              order by created_at, id`,
            [accountIds, newapiTokenIds, exactRequestIds, exactLogIds],
          )
        : { rows: [] as Array<{ data: ProxyRequestLog }> };
    const exactProxyRows = exactProxyLogs.rows.map((row) => row.data);
    const sourceRecordIds = [...new Set(input.usageSources.map((source) => source.recordId))];
    const sourceRequestIds = [
      ...new Set(
        input.usageSources
          .map((source) => source.usageLog.newapiRequestId)
          .filter(Boolean),
      ),
    ] as string[];
    const sourceLogIds = [
      ...new Set(
        input.usageSources.map((source) => source.usageLog.newapiLogId).filter(Boolean),
      ),
    ] as string[];
    const exactProxyIds = exactProxyRows.map((proxyLog) => proxyLog.id);
    const initialUsageRecords = sourceRecordIds.length || exactProxyIds.length
      ? await client.query<{ data: NewApiUsageRecord }>(
          `select data
             from newapi_usage_records
            where id = any($1::text[])
               or (
                 newapi_token_id = any($2::text[])
                 and (
                   newapi_request_id = any($3::text[])
                   or newapi_log_id = any($4::text[])
                 )
               )
               or (
                 match_status = 'matched'
                 and data->>'matchedProxyLogId' = any($5::text[])
               )`,
          [sourceRecordIds, newapiTokenIds, sourceRequestIds, sourceLogIds, exactProxyIds],
        )
      : { rows: [] as Array<{ data: NewApiUsageRecord }> };
    const initialUsageRows = initialUsageRecords.rows.map((row) => row.data);
    const reservedExactProxyIds = new Set(
      initialUsageRows
        .filter((record) => record.matchStatus === "matched")
        .map((record) => record.matchedProxyLogId)
        .filter((proxyLogId): proxyLogId is string => Boolean(proxyLogId)),
    );
    const accountByTokenId = new Map(
      accounts.rows
        .filter((row) => row.data.newapiTokenId)
        .map((row) => [row.data.newapiTokenId as string, row.data] as const),
    );
    const sourceHasExactCandidate = (source: (typeof input.usageSources)[number]) => {
      const account = source.usageLog.newapiTokenId
        ? accountByTokenId.get(source.usageLog.newapiTokenId)
        : undefined;
      if (!account) return false;
      const existingRecord = initialUsageRows.find((record) =>
        sameNewApiUsageSource(record, source.usageLog),
      );
      return Boolean(
        findProxyLogForNewApiUsage({
          proxyLogs: exactProxyRows,
          usageLog: source.usageLog,
          account,
          matchWindowMs: 30_000,
          reservedProxyLogIds: reservedExactProxyIds,
          allowReservedProxyLogId: existingRecord?.matchedProxyLogId,
        }),
      );
    };
    const fallbackSources = proxyLogIds.length
      ? []
      : input.usageSources.filter((source) => !sourceHasExactCandidate(source));
    const fallbackWindowMs = Math.min(Math.max(input.fallbackWindowMs, 0), 30_000);
    const fallbackRanges = fallbackSources.flatMap((source) => {
      const createdAt = source.usageLog.createdAt
        ? new Date(source.usageLog.createdAt).getTime()
        : Number.NaN;
      const newapiTokenId = source.usageLog.newapiTokenId;
      const tokenAccountId = newapiTokenId
        ? accountIdByTokenId.get(newapiTokenId)
        : undefined;
      if (!tokenAccountId || !Number.isFinite(createdAt)) return [];
      return [{
        tokenAccountId,
        newapiTokenId,
        finishedAfter: new Date(createdAt - fallbackWindowMs).toISOString(),
        finishedBefore: new Date(createdAt + fallbackWindowMs).toISOString(),
      }];
    });
    const fallbackProxyLogs = fallbackRanges.length
      ? await client.query<{ data: ProxyRequestLog }>(
          `with fallback_ranges as materialized (
             select *
             from jsonb_to_recordset($1::jsonb) as ranges(
               "tokenAccountId" text,
               "newapiTokenId" text,
               "finishedAfter" timestamptz,
               "finishedBefore" timestamptz
             )
           )
           select distinct on (proxy.id) proxy.data
             from fallback_ranges ranges
             join proxy_request_logs proxy
               on (
                 proxy.token_account_id = ranges."tokenAccountId"
                 or proxy.data->>'providerKeyName' = ranges."newapiTokenId"
               )
              and coalesce(
                (proxy.data->>'responseTimeUpdatedAt')::timestamptz,
                (proxy.data->>'updatedAt')::timestamptz,
                proxy.created_at
              ) >= ranges."finishedAfter"
              and coalesce(
                (proxy.data->>'responseTimeUpdatedAt')::timestamptz,
                (proxy.data->>'updatedAt')::timestamptz,
                proxy.created_at
              ) <= ranges."finishedBefore"
            order by proxy.id, proxy.created_at`,
          [JSON.stringify(fallbackRanges)],
        )
      : { rows: [] as Array<{ data: ProxyRequestLog }> };
    const proxyById = new Map(
      [...exactProxyRows, ...fallbackProxyLogs.rows.map((row) => row.data)].map((proxyLog) => [
        proxyLog.id,
        proxyLog,
      ]),
    );
    const candidateProxyIds = [...proxyById.keys()];
    const fallbackProxyIds = fallbackProxyLogs.rows
      .map((row) => row.data.id)
      .filter((proxyLogId) => !exactProxyIds.includes(proxyLogId));
    const fallbackOccupancy = fallbackProxyIds.length
      ? await client.query<{ data: NewApiUsageRecord }>(
          `select data
             from newapi_usage_records
            where match_status = 'matched'
              and data->>'matchedProxyLogId' = any($1::text[])`,
          [fallbackProxyIds],
        )
      : { rows: [] as Array<{ data: NewApiUsageRecord }> };
    const usageRecordById = new Map(
      [...initialUsageRows, ...fallbackOccupancy.rows.map((row) => row.data)].map((record) => [
        record.id,
        record,
      ]),
    );
    return {
      users: users.rows.map((row) => row.data),
      tokenAccounts: accounts.rows.map((row) => row.data),
      proxyRequestLogs: [...proxyById.values()],
      newapiUsageRecords: [...usageRecordById.values()],
      stats: {
        usageSources: input.usageSources.length,
        tokenAccounts: accounts.rows.length,
        exactProxyCandidates: exactProxyRows.length,
        fallbackSources: fallbackSources.length,
        fallbackProxyCandidates: fallbackProxyLogs.rows.length,
        proxyCandidates: proxyById.size,
        usageRecords: usageRecordById.size,
      },
    };
  });
}

export async function getPostgresUserById(feishuUserId: string) {
  return withControlClient(async (client) => {
    const result = await client.query<{ data: FeishuUser }>(
      "select data from feishu_users where id = $1 limit 1",
      [feishuUserId],
    );
    return result.rows[0]?.data ?? null;
  });
}

async function readPostgresUserQuotaState(client: PoolClient, feishuUserId: string) {
  const result = await client.query<{ data: UserQuotaState | null; generation: number }>(
      `select
         (select data from user_quota_states where feishu_user_id = $1) as data,
         coalesce((select max(operation_generation) from token_accounts where feishu_user_id = $1), 0)::integer as generation`,
      [feishuUserId],
  );
  const row = result.rows[0];
  return row?.data ?? {
    feishuUserId,
    admission: "open" as const,
    activeGeneration: row?.generation ?? 0,
    updatedAt: nowIso(),
  };
}

export async function getPostgresActiveAdminScopeForUser(feishuUserId: string) {
  return withControlClient(async (client) => {
    const result = await client.query<{ data: AdminScope }>(
      `select data
       from admin_scopes
       where feishu_user_id = $1 and status = 'active'
       order by case when scope_type = 'global' then 0 else 1 end, updated_at desc, id
       limit 1`,
      [feishuUserId],
    );
    return result.rows[0]?.data ?? null;
  });
}

export async function getPostgresAdminScopeFallbackData(
  feishuUserId: string,
  approvalTargetOpenId: string,
) {
  return withControlClient(async (client) => {
    const result = await client.query<{
      assigned_request: TokenRequest | null;
      scopes: AdminScope[];
    }>(
      `select
         (select data
          from token_requests
          where approval_target_open_id = $2
          order by updated_at desc, id
          limit 1) as assigned_request,
         coalesce(
           (select jsonb_agg(data order by updated_at desc, id)
            from admin_scopes
            where feishu_user_id = $1),
           '[]'::jsonb
         ) as scopes`,
      [feishuUserId, approvalTargetOpenId],
    );
    return {
      assignedRequest: result.rows[0]?.assigned_request ?? null,
      scopes: result.rows[0]?.scopes ?? [],
    };
  });
}

export async function listPostgresTokenRequestsForUser(feishuUserId: string) {
  return withControlClient(async (client) => {
    const result = await client.query<{ data: TokenRequest }>(
      `select data
       from token_requests
       where feishu_user_id = $1
       order by created_at desc, id`,
      [feishuUserId],
    );
    return result.rows.map((row) => row.data);
  });
}

export async function getPostgresTokenRequestById(requestId: string) {
  return withControlClient(async (client) => {
    const result = await client.query<{ data: TokenRequest }>(
      "select data from token_requests where id = $1 limit 1",
      [requestId],
    );
    return result.rows[0]?.data ?? null;
  });
}

export async function getPostgresUserBillingPeriod(
  feishuUserId: string,
  period: string,
) {
  return withControlClient(async (client) => {
    const result = await client.query<{ data: UserBillingPeriod }>(
      `select data from user_billing_periods
       where feishu_user_id = $1 and period = $2
       limit 1`,
      [feishuUserId, period],
    );
    return result.rows[0]?.data ?? null;
  });
}

export async function getPostgresEffectiveUserQuotaPolicy(
  feishuUserId: string,
  period: string,
) {
  return withControlClient(async (client) => {
    const result = await client.query<{ data: UserQuotaPolicy }>(
      `select data
       from user_quota_policies
       where feishu_user_id = $1
         and effective_from_period <= $2
         and (effective_to_period is null or effective_to_period >= $2)
       order by version desc, id desc
       limit 1`,
      [feishuUserId, period],
    );
    return result.rows[0]?.data ?? null;
  });
}

export async function listPostgresTokenAccountsForUser(feishuUserId: string) {
  return withControlClient(async (client) => {
    const result = await client.query<{ data: TokenAccount }>(
      `select data from token_accounts
       where feishu_user_id = $1
       order by created_at, id`,
      [feishuUserId],
    );
    return result.rows.map((row) => row.data);
  });
}

async function listPostgresInflightProxyRequestsWithClient(
  client: PoolClient,
  feishuUserId: string,
  operationGeneration: number,
  at: string,
) {
  const result = await client.query<{ data: ProxyRequestLog }>(
    `select data
     from proxy_request_logs
     where feishu_user_id = $1
       and operation_generation = $2
       and data->>'status' in ('pending', 'streaming')
       and (lease_expires_at is null or lease_expires_at > $3::timestamptz)
     order by created_at, id`,
    [feishuUserId, operationGeneration, at],
  );
  return result.rows.map((row) => row.data);
}

export async function listPostgresInflightProxyRequests(
  feishuUserId: string,
  operationGeneration: number,
  at: string,
) {
  return withClient((client) =>
    listPostgresInflightProxyRequestsWithClient(client, feishuUserId, operationGeneration, at),
  );
}

export async function listPostgresInflightProxyRequestsForQuotaOperation(
  feishuUserId: string,
  operationGeneration: number,
  at: string,
) {
  return withControlClient((client) =>
    listPostgresInflightProxyRequestsWithClient(client, feishuUserId, operationGeneration, at),
  );
}

export async function getPostgresUserQuotaState(feishuUserId: string) {
  return withControlClient(async (client) => {
    return readPostgresUserQuotaState(client, feishuUserId);
  });
}

export async function savePostgresAppSettings(settings: AppSettings) {
  return withControlTransaction((client) => saveSettingsRow(client, settings));
}

export async function mutatePostgresAppSettings<T>(
  fn: (settings: AppSettings) => T | Promise<T>,
) {
  return withControlTransaction(async (client) => {
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
    const before = JSON.stringify(settings);
    const result = await fn(settings);
    // Deduplicated enqueue, failed claims and lease CAS misses are reads, not
    // writes. Avoid rewriting the single settings row when the mutation did
    // not change it; this removes needless row/WAL contention.
    if (JSON.stringify(settings) !== before) await saveSettingsRow(client, settings);
    return result;
  });
}

export async function upsertPostgresUserQuotaPolicy(policy: UserQuotaPolicy) {
  return withControlTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `user-quota:${policy.feishuUserId}`,
    ]);
    return saveUserQuotaPolicyRow(client, policy);
  });
}

export async function findPostgresQuotaOperationById(operationId: string) {
  return withControlClient(async (client) => {
    const result = await client.query<{ data: QuotaOperation }>(
      "select data from quota_operations where id = $1 limit 1",
      [operationId],
    );
    return result.rows[0]?.data ?? null;
  });
}

export async function findPostgresQuotaOperationByIdempotencyKey(
  idempotencyKey: string,
) {
  return withControlClient(async (client) => {
    const result = await client.query<{ data: QuotaOperation }>(
      "select data from quota_operations where idempotency_key = $1 limit 1",
      [idempotencyKey],
    );
    return result.rows[0]?.data ?? null;
  });
}

export async function listPostgresQuotaOperations(input: {
  feishuUserId?: string;
  state?: QuotaOperation["state"];
  limit?: number;
} = {}) {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 0), 1_000);
  if (limit === 0) return [];
  return withControlClient(async (client) => {
    const result = await client.query<{ data: QuotaOperation }>(
      `select data
       from quota_operations
       where ($1::text is null or feishu_user_id = $1)
         and ($2::text is null or state = $2)
       order by updated_at desc, id desc
       limit $3`,
      [input.feishuUserId ?? null, input.state ?? null, limit],
    );
    return result.rows.map((row) => row.data);
  });
}

export async function createPostgresQuotaOperation(operation: QuotaOperation) {
  return withControlTransaction(async (client) => {
    // A newly-created operation is still only planned and does not reserve
    // department budget. Department serialization belongs to the later budget
    // reservation transaction; taking it here needlessly queues unrelated users.
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `user-quota:${operation.feishuUserId}`,
    ]);
    const idempotent = await client.query<{ data: QuotaOperation }>(
      "select data from quota_operations where idempotency_key = $1",
      [operation.idempotencyKey],
    );
    if (idempotent.rows[0]) return idempotent.rows[0].data;
    const open = await client.query<{ data: QuotaOperation }>(
      `select data from quota_operations
       where feishu_user_id = $1
         and state not in ('completed', 'compensated')
       order by created_at desc
       limit 1`,
      [operation.feishuUserId],
    );
    if (open.rows[0]) {
      throw new Error(`用户已有未完成额度操作: ${open.rows[0].data.id}`);
    }
    return saveQuotaOperationRow(client, operation);
  });
}

export async function createPostgresMonthlyOpenOperations(
  inputs: Array<{
    feishuUserId: string;
    departmentId: string;
    billingPeriod: string;
    assignedMonthlyQuota: number;
    createdByOpenId?: string;
  }>,
) {
  if (!inputs.length) return [];
  return withTransaction(async (client) => {
    const departments = [
      ...new Set(inputs.map((item) => `${item.departmentId}:${item.billingPeriod}`)),
    ].sort();
    for (const department of departments) {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `department-quota:${department}`,
      ]);
    }
    for (const feishuUserId of [...new Set(inputs.map((item) => item.feishuUserId))].sort()) {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `user-quota:${feishuUserId}`,
      ]);
    }

    const operations: QuotaOperation[] = [];
    const newInputs: typeof inputs = [];
    for (const input of inputs) {
      const idempotencyKey = `monthly-open:${input.billingPeriod}:${input.feishuUserId}`;
      const idempotent = await client.query<{ data: QuotaOperation }>(
        "select data from quota_operations where idempotency_key = $1",
        [idempotencyKey],
      );
      if (idempotent.rows[0]) {
        if (
          idempotent.rows[0].data.requestedAssignedQuota !== input.assignedMonthlyQuota ||
          idempotent.rows[0].data.departmentId !== input.departmentId
        ) {
          throw new Error(
            `月度开账幂等记录与当前策略不一致: ${idempotent.rows[0].data.id}`,
          );
        }
        operations.push(idempotent.rows[0].data);
        continue;
      }
      const open = await client.query<{ data: QuotaOperation }>(
        `select data from quota_operations
         where feishu_user_id = $1 and state not in ('completed', 'compensated')
         limit 1`,
        [input.feishuUserId],
      );
      if (open.rows[0]) {
        throw new Error(`用户已有未完成额度操作: ${open.rows[0].data.id}`);
      }
      newInputs.push(input);
    }

    for (const departmentKey of departments) {
      const separator = departmentKey.lastIndexOf(":");
      const departmentId = departmentKey.slice(0, separator);
      const period = departmentKey.slice(separator + 1);
      const requested = newInputs
        .filter(
          (item) => item.departmentId === departmentId && item.billingPeriod === period,
        )
        .reduce((sum, item) => sum + item.assignedMonthlyQuota, 0);
      if (requested === 0) continue;
      const policy = await client.query<{ data: DepartmentQuotaPeriod }>(
        `select data from department_quota_periods
         where department_id = $1 and period = $2
         for update`,
        [departmentId, period],
      );
      if (!policy.rows[0]) throw new Error(`部门 ${departmentId} 缺少 ${period} 账期预算`);
      const budgetQuota = Math.max(
        Math.round(policy.rows[0].data.quotaLimit * getConfig().newapi.quotaPerUnit),
        0,
      );
      const committed = await client.query<{ quota: string }>(
        `select coalesce(sum(signed_quota), 0)::text as quota
         from quota_ledger_entries
         where department_id = $1 and period = $2`,
        [departmentId, period],
      );
      const pending = await client.query<{ quota: string }>(
        `select coalesce(sum(greatest(coalesce((data->>'reservedDepartmentQuota')::bigint, 0), 0)), 0)::text as quota
         from quota_operations
         where department_id = $1 and billing_period = $2
           and state not in ('completed', 'compensated')`,
        [departmentId, period],
      );
      const available = Math.max(
        budgetQuota -
          Math.max(Number(committed.rows[0]?.quota ?? 0), 0) -
          Math.max(Number(pending.rows[0]?.quota ?? 0), 0),
        0,
      );
      if (requested > available) {
        throw new Error(`部门 ${departmentId} 可用额度不足，月度开账整批未创建`);
      }
    }

    for (const input of newInputs) {
      const stateResult = await client.query<{ data: UserQuotaState }>(
        "select data from user_quota_states where feishu_user_id = $1",
        [input.feishuUserId],
      );
      const generationResult = await client.query<{ generation: number }>(
        `select coalesce(max(operation_generation), 0)::integer as generation
         from token_accounts where feishu_user_id = $1`,
        [input.feishuUserId],
      );
      const now = nowIso();
      const operation: QuotaOperation = {
        id: randomId("qo"),
        operationType: "monthly_open",
        idempotencyKey: `monthly-open:${input.billingPeriod}:${input.feishuUserId}`,
        feishuUserId: input.feishuUserId,
        departmentId: input.departmentId,
        billingPeriod: input.billingPeriod,
        requestedAssignedQuota: input.assignedMonthlyQuota,
        reservedDepartmentQuota: input.assignedMonthlyQuota,
        operationGeneration:
          (stateResult.rows[0]?.data.activeGeneration ??
            generationResult.rows[0]?.generation ??
            0) + 1,
        state: "budget_reserved",
        attemptCount: 0,
        createdByOpenId: input.createdByOpenId,
        createdAt: now,
        updatedAt: now,
      };
      operations.push(await saveQuotaOperationRow(client, operation));
    }
    return operations;
  });
}

export async function updatePostgresQuotaOperation(
  operationId: string,
  patch: Partial<QuotaOperation>,
  allowedStates?: QuotaOperation["state"][],
) {
  return withControlTransaction(async (client) => {
    const current = await client.query<{ data: QuotaOperation }>(
      "select data from quota_operations where id = $1 for update",
      [operationId],
    );
    const operation = current.rows[0]?.data;
    if (!operation || (allowedStates && !allowedStates.includes(operation.state))) return null;
    const updated: QuotaOperation = {
      ...operation,
      ...patch,
      id: operation.id,
      idempotencyKey: operation.idempotencyKey,
      updatedAt: patch.updatedAt ?? nowIso(),
    };
    return saveQuotaOperationRow(client, updated);
  });
}

export async function transitionPostgresQuotaOperation(
  operationId: string,
  state: QuotaOperation["state"],
  patch: Partial<QuotaOperation> = {},
) {
  return withControlTransaction(async (client) => {
    const current = await client.query<{ data: QuotaOperation }>(
      "select data from quota_operations where id = $1 for update",
      [operationId],
    );
    const operation = current.rows[0]?.data;
    if (!operation) return null;
    assertQuotaOperationTransition(operation.state, state);
    const updated: QuotaOperation = {
      ...operation,
      ...patch,
      id: operation.id,
      idempotencyKey: operation.idempotencyKey,
      state,
      completedAt:
        state === "completed" || state === "compensated" ? nowIso() : patch.completedAt,
      updatedAt: patch.updatedAt ?? nowIso(),
    };
    return saveQuotaOperationRow(client, updated);
  });
}

export async function claimPostgresQuotaOperationExecution(input: {
  operationId: string;
  leaseId: string;
  leaseExpiresAt: string;
}) {
  return withControlTransaction(async (client) => {
    const current = await client.query<{ data: QuotaOperation }>(
      "select data from quota_operations where id = $1 for update",
      [input.operationId],
    );
    const operation = current.rows[0]?.data;
    if (!operation) return null;
    if (
      operation.workerLeaseId &&
      operation.workerLeaseId !== input.leaseId &&
      operation.workerLeaseExpiresAt &&
      operation.workerLeaseExpiresAt > nowIso()
    ) {
      return null;
    }
    return saveQuotaOperationRow(client, {
      ...operation,
      workerLeaseId: input.leaseId,
      workerLeaseExpiresAt: input.leaseExpiresAt,
    });
  });
}

export async function renewPostgresQuotaOperationExecution(input: {
  operationId: string;
  leaseId: string;
  leaseExpiresAt: string;
}) {
  return withControlTransaction(async (client) => {
    const current = await client.query<{ data: QuotaOperation }>(
      "select data from quota_operations where id = $1 for update",
      [input.operationId],
    );
    const operation = current.rows[0]?.data;
    if (!operation || operation.workerLeaseId !== input.leaseId) return null;
    return saveQuotaOperationRow(client, {
      ...operation,
      workerLeaseExpiresAt: input.leaseExpiresAt,
    });
  });
}

export async function releasePostgresQuotaOperationExecution(input: {
  operationId: string;
  leaseId: string;
}) {
  return withControlTransaction(async (client) => {
    const current = await client.query<{ data: QuotaOperation }>(
      "select data from quota_operations where id = $1 for update",
      [input.operationId],
    );
    const operation = current.rows[0]?.data;
    if (!operation || operation.workerLeaseId !== input.leaseId) return operation ?? null;
    return saveQuotaOperationRow(client, {
      ...operation,
      workerLeaseId: undefined,
      workerLeaseExpiresAt: undefined,
    });
  });
}

export async function insertPostgresQuotaLedgerEntry(entry: QuotaLedgerEntry) {
  return withControlTransaction((client) => insertQuotaLedgerEntryRow(client, entry));
}

export async function upsertPostgresUserQuotaState(state: UserQuotaState) {
  return withControlTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `user-quota:${state.feishuUserId}`,
    ]);
    return saveUserQuotaStateRow(client, state);
  });
}

export async function upsertPostgresQuotaReconciliationRecord(
  record: QuotaReconciliationRecord,
) {
  return withTransaction((client) => saveQuotaReconciliationRow(client, record));
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
  return withControlTransaction(async (client) => {
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

export async function updatePostgresTokenRequestForQuotaOperation(
  id: string,
  patch: Partial<Omit<TokenRequest, "id" | "createdAt">>,
) {
  return transitionPostgresTokenRequestForQuotaOperation(id, patch);
}

async function transitionPostgresTokenRequestWithClient(
  client: PoolClient,
  id: string,
  patch: Partial<Omit<TokenRequest, "id" | "createdAt">>,
  allowedStatuses?: RequestStatus[],
  options: { syncBillingPeriod?: boolean } = {},
) {
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
  if (options.syncBillingPeriod !== false && stored.tokenAccountId) {
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
}

export async function transitionPostgresTokenRequest(
  id: string,
  patch: Partial<Omit<TokenRequest, "id" | "createdAt">>,
  allowedStatuses?: RequestStatus[],
) {
  return withTransaction((client) =>
    transitionPostgresTokenRequestWithClient(client, id, patch, allowedStatuses),
  );
}

export async function transitionPostgresTokenRequestForQuotaOperation(
  id: string,
  patch: Partial<Omit<TokenRequest, "id" | "createdAt">>,
  allowedStatuses?: RequestStatus[],
) {
  return withControlTransaction((client) =>
    transitionPostgresTokenRequestWithClient(client, id, patch, allowedStatuses),
  );
}

export async function transitionPostgresTokenRequestAfterQuotaMaterialization(
  id: string,
  patch: Partial<Omit<TokenRequest, "id" | "createdAt">>,
  allowedStatuses?: RequestStatus[],
) {
  return withControlTransaction((client) =>
    transitionPostgresTokenRequestWithClient(
      client,
      id,
      patch,
      allowedStatuses,
      { syncBillingPeriod: false },
    ),
  );
}

export async function upsertPostgresUserBillingPeriod(period: UserBillingPeriod) {
  return withTransaction((client) => saveUserBillingPeriodRow(client, period));
}

export async function upsertPostgresDepartmentQuotaPeriod(period: DepartmentQuotaPeriod) {
  return withTransaction((client) => saveDepartmentQuotaPeriodRow(client, period));
}

export async function insertPostgresDepartmentQuotaRequest(
  request: DepartmentQuotaRequest,
) {
  return withTransaction((client) => saveDepartmentQuotaRequestRow(client, request));
}

export async function updatePostgresDepartmentQuotaRequest(
  id: string,
  patch: Partial<Omit<DepartmentQuotaRequest, "id" | "createdAt">>,
  allowedStatuses?: DepartmentQuotaRequest["status"][],
) {
  return withTransaction(async (client) => {
    const result = await client.query<{ data: DepartmentQuotaRequest }>(
      "select data from department_quota_requests where id = $1 for update",
      [id],
    );
    const existing = result.rows[0]?.data;
    if (!existing) return null;
    if (allowedStatuses && !allowedStatuses.includes(existing.status)) return null;
    return saveDepartmentQuotaRequestRow(client, {
      ...existing,
      ...patch,
      updatedAt: nowIso(),
    });
  });
}

export async function upsertPostgresQuotaChangeEvent(event: QuotaChangeEvent) {
  return withTransaction((client) => saveQuotaChangeEventRow(client, event));
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
  return withControlClient(async (client) => {
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
       where key_hash = $1 and status in ('active', 'draining', 'settling')
       limit 1`,
      [keyHash],
    );
    return result.rows[0]?.data ?? null;
  });
}

export async function insertPostgresTokenAccount(account: TokenAccount) {
  return withControlTransaction(async (client) => {
    const stored = await saveTokenAccountRow(client, account);
    await syncPostgresBillingPeriodForUser(
      client,
      stored.feishuUserId,
      stored.billingPeriod || periodFromIso(stored.createdAt),
    );
    return stored;
  });
}

export async function insertPostgresTokenAccountForQuotaOperation(account: TokenAccount) {
  // quota_restore/key_rotation already perform an authoritative snapshot at
  // their accounting boundary. A pending replacement account has no usage or
  // ledger effect, so inserting it must not trigger another full user rebuild.
  return withControlTransaction((client) => saveTokenAccountRow(client, account));
}

async function updatePostgresTokenAccountWithClient(
  client: PoolClient,
  accountId: string,
  patch: Partial<TokenAccount>,
  allowedStatuses?: TokenStatus[],
) {
  const result = await client.query<{ data: TokenAccount }>(
    "select data from token_accounts where id = $1 for update",
    [accountId],
  );
  const account = result.rows[0]?.data;
  if (!account || (allowedStatuses && !allowedStatuses.includes(account.status))) return null;
  return saveTokenAccountRow(client, {
    ...account,
    ...patch,
    id: account.id,
    feishuUserId: account.feishuUserId,
    keyHash: account.keyHash,
  });
}

export async function updatePostgresTokenAccount(
  accountId: string,
  patch: Partial<TokenAccount>,
  allowedStatuses?: TokenStatus[],
) {
  return withTransaction((client) =>
    updatePostgresTokenAccountWithClient(client, accountId, patch, allowedStatuses),
  );
}

export async function updatePostgresTokenAccountForQuotaOperation(
  accountId: string,
  patch: Partial<TokenAccount>,
  allowedStatuses?: TokenStatus[],
) {
  return withControlTransaction((client) =>
    updatePostgresTokenAccountWithClient(client, accountId, patch, allowedStatuses),
  );
}

export async function replacePostgresActiveTokenAccount(input: {
  oldTokenAccountId: string;
  account: TokenAccount;
}) {
  return withTransaction(async (client) => {
    await lockPostgresUserQuotaFence(client, input.account.feishuUserId);
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

type FinalizePostgresTokenRotationInput = {
  feishuUserId: string;
  oldTokenAccountId: string;
  newTokenAccountId: string;
  operationGeneration: number;
  operationId: string;
  now: string;
};

async function finalizePostgresTokenRotationWithClient(
  client: PoolClient,
  input: FinalizePostgresTokenRotationInput,
) {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `user-quota:${input.feishuUserId}`,
  ]);
  const result = await client.query<{ data: TokenAccount }>(
    `select data from token_accounts
     where id = any($1::text[])
     order by id
     for update`,
    [[input.oldTokenAccountId, input.newTokenAccountId]],
  );
  const accounts = new Map(result.rows.map((row) => [row.data.id, row.data]));
  const oldAccount = accounts.get(input.oldTokenAccountId);
  const newAccount = accounts.get(input.newTokenAccountId);
  if (!oldAccount || !newAccount) throw new Error("Key 轮换本地账号记录不完整");
  const storedOld = await saveTokenAccountRow(client, {
    ...oldAccount,
    status: "replaced",
    disabledAt: input.now,
    replacedByTokenAccountId: newAccount.id,
  });
  const storedNew = await saveTokenAccountRow(client, {
    ...newAccount,
    status: "active",
    operationGeneration: input.operationGeneration,
    activatedAt: input.now,
  });
  const state = await saveUserQuotaStateRow(client, {
    feishuUserId: input.feishuUserId,
    admission: "open",
    activeGeneration: input.operationGeneration,
    operationId: undefined,
    closedReason: undefined,
    updatedAt: input.now,
  });
  return { oldAccount: storedOld, newAccount: storedNew, state };
}

export async function finalizePostgresTokenRotation(
  input: FinalizePostgresTokenRotationInput,
) {
  return withTransaction((client) => finalizePostgresTokenRotationWithClient(client, input));
}

export async function finalizePostgresTokenRotationForQuotaOperation(
  input: FinalizePostgresTokenRotationInput,
) {
  return withControlTransaction((client) =>
    finalizePostgresTokenRotationWithClient(client, input),
  );
}

export async function finalizePostgresTokenProvision(input: {
  feishuUserId: string;
  tokenAccountId: string;
  operationGeneration: number;
  now: string;
}) {
  return withControlTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `user-quota:${input.feishuUserId}`,
    ]);
    const accountResult = await client.query<{ data: TokenAccount }>(
      `select data from token_accounts
       where id = $1 and feishu_user_id = $2
       for update`,
      [input.tokenAccountId, input.feishuUserId],
    );
    const account = accountResult.rows[0]?.data;
    if (!account) throw new Error("首次发放本地 TokenAccount 不存在");
    const otherActive = await client.query<{ id: string }>(
      `select id from token_accounts
       where feishu_user_id = $1 and status = 'active' and id <> $2
       limit 1
       for update`,
      [input.feishuUserId, input.tokenAccountId],
    );
    if (otherActive.rows[0]) throw new Error("首次发放期间用户已出现其他 active Key");
    const storedAccount = await saveTokenAccountRow(client, {
      ...account,
      status: "active",
      operationGeneration: input.operationGeneration,
      activatedAt: account.activatedAt ?? input.now,
    });
    const state = await saveUserQuotaStateRow(client, {
      feishuUserId: input.feishuUserId,
      admission: "open",
      activeGeneration: input.operationGeneration,
      updatedAt: input.now,
    });
    return { account: storedAccount, state };
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
    await lockPostgresUserQuotaFence(client, input.feishuUserId);
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
    await lockPostgresUserQuotaFence(client, input.feishuUserId);
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
    await lockPostgresUserQuotaFence(client, input.feishuUserId);
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
  return withClient((client) => saveProxyLogRow(client, log));
}

export async function insertPostgresQuotaAwareProxyLog(
  account: TokenAccount,
  log: ProxyRequestLog,
) {
  const retryDelaysMs = [10, 25, 50, 100, 200];
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    const stored = await withTransaction(async (client) => {
      // Proxy admissions share this transaction lock with each other. A quota
      // saga holds the same key as a session-level exclusive lock, so it still
      // fences new admissions while changing generation or account state.
      const lockResult = await client.query<{ locked: boolean }>(
        "select pg_try_advisory_xact_lock_shared(hashtext($1)::bigint) as locked",
        [`user-quota-fence:${account.feishuUserId}`],
      );
      if (!lockResult.rows[0]?.locked) return null;

      const currentResult = await client.query<{
        account: TokenAccount;
        user: FeishuUser;
      }>(
        `select a.data as account, u.data as user
         from token_accounts a
         join feishu_users u on u.id = a.feishu_user_id
         where a.id = $1
           and a.key_hash = $2
           and a.feishu_user_id = $3
           and a.status in ('active', 'draining', 'settling')
         limit 1`,
        [account.id, account.keyHash, account.feishuUserId],
      );
      const currentAccount = currentResult.rows[0]?.account;
      const currentUser = currentResult.rows[0]?.user;
      if (
        !currentAccount ||
        !currentUser ||
        (currentUser.status && currentUser.status !== "active")
      ) {
        throw new StaleTokenGenerationError();
      }
      const state = await readPostgresUserQuotaState(client, account.feishuUserId);
      assertQuotaAdmission(state, currentAccount);
      return saveProxyLogRow(client, {
        ...log,
        billingPeriod: currentAccount.billingPeriod,
        operationGeneration: state.activeGeneration,
      });
    });
    if (stored) return stored;

    // A closed state is definitive and should fail immediately. An open state
    // can mean that the exclusive saga fence was acquired just before its
    // state transition, so retry the shared lock for a short bounded window.
    const state = await getPostgresUserQuotaState(account.feishuUserId);
    assertQuotaAdmission(state, account);
    const retryDelayMs = retryDelaysMs[attempt];
    if (retryDelayMs === undefined) throw new QuotaOperationBusyError();
    const jitterMs = Math.floor(Math.random() * Math.max(Math.floor(retryDelayMs / 2), 1));
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs + jitterMs));
  }
  throw new QuotaOperationBusyError();
}

type ProxyAdmissionRetry = {
  status: "retry";
};

/**
 * Authenticates and admits a proxy request on one pool client. The first
 * lookup intentionally returns only scalar identity columns; all mutable
 * account, user and quota state is reread after taking the shared saga fence.
 */
export async function beginPostgresQuotaAwareProxyRequest(
  keyHash: string,
  log: ProxyAdmissionLogInput,
): Promise<ProxyRequestAdmissionResult> {
  const retryDelaysMs = [10, 25, 50, 100, 200];
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    const result = await withTransaction<ProxyRequestAdmissionResult | ProxyAdmissionRetry>(
      async (client) => {
        // Business statement 1/2: discover the fence key and take the shared
        // transaction lock. Mutable state is deliberately not trusted here;
        // the next statement gets a fresh READ COMMITTED snapshot after the
        // fence has been acquired.
        const fenceResult = await client.query<{
          account_id: string;
          feishu_user_id: string;
          locked: boolean;
        }>(
          `with candidate as materialized (
             select id as account_id, feishu_user_id
             from token_accounts
             where key_hash = $1 and status in ('active', 'draining', 'settling')
             limit 1
           )
           select account_id,
                  feishu_user_id,
                  pg_try_advisory_xact_lock_shared(
                    hashtext('user-quota-fence:' || feishu_user_id)::bigint
                  ) as locked
           from candidate`,
          [keyHash],
        );
        const candidate = fenceResult.rows[0];
        if (!candidate) return { status: "inactive_token" };
        if (!candidate.locked) return { status: "retry" };

        const now = nowIso();
        const logId = randomId("pl");
        const leaseExpiresAt = new Date(new Date(now).getTime() + 2 * 60_000).toISOString();
        const baseLog: ProxyRequestLog = {
          ...log,
          id: logId,
          createdAt: now,
          updatedAt: now,
          statusCode: log.statusCode ?? 0,
          durationMs: log.durationMs ?? 0,
          status: log.status ?? "pending",
        };

        // Business statement 2/2: revalidate every mutable field under the
        // held fence and conditionally insert the pending log in one SQL
        // statement. This keeps admission and its durable billing identity
        // atomic without a separate SELECT and INSERT round trip.
        const currentResult = await client.query<{
          outcome:
            | "admitted"
            | "bound_user_missing"
            | "bound_user_inactive"
            | "quota_admission_closed"
            | "stale_token_generation";
          account: TokenAccount | null;
          user: FeishuUser | null;
          quota_state: UserQuotaState | null;
          proxy_log: ProxyRequestLog | null;
        }>(
          `with snapshot as materialized (
             select a.id as account_id,
                    a.feishu_user_id,
                    a.billing_period,
                    coalesce(a.operation_generation, 0)::integer as account_generation,
                    a.data as account,
                    u.data as user_data,
                    s.data as quota_state,
                    coalesce(s.admission, 'open') as admission,
                    coalesce(
                      s.active_generation,
                      (select max(generation_source.operation_generation)
                       from token_accounts generation_source
                       where generation_source.feishu_user_id = a.feishu_user_id),
                      0
                    )::integer as active_generation
             from token_accounts a
             left join feishu_users u on u.id = a.feishu_user_id
             left join user_quota_states s on s.feishu_user_id = a.feishu_user_id
             where a.id = $1
               and a.key_hash = $2
               and a.feishu_user_id = $3
               and a.status in ('active', 'draining', 'settling')
             limit 1
           ), decision as materialized (
             select snapshot.*,
                    case
                      when user_data is null then 'bound_user_missing'
                      when coalesce(user_data->>'status', 'active') <> 'active'
                        then 'bound_user_inactive'
                      when admission <> 'open' then 'quota_admission_closed'
                      when account_generation <> active_generation
                        then 'stale_token_generation'
                      else 'admitted'
                    end as outcome
             from snapshot
           ), payload as materialized (
             select decision.*,
                    jsonb_strip_nulls(
                      $5::jsonb || jsonb_build_object(
                        'feishuUserId', feishu_user_id,
                        'tokenAccountId', account_id,
                        'departmentId', user_data->>'departmentId',
                        'departmentName', user_data->>'departmentName',
                        'providerKeyName', account->>'newapiTokenId',
                        'billingPeriod', billing_period,
                        'operationGeneration', active_generation,
                        'heartbeatAt', $6::text,
                        'leaseExpiresAt', $7::text
                      )
                    ) as proxy_log
             from decision
           ), inserted as (
             insert into proxy_request_logs
               (id, feishu_user_id, token_account_id, request_path, method,
                status_code, billing_period, operation_generation,
                lease_expires_at, heartbeat_at, data, created_at)
             select $4,
                    feishu_user_id,
                    account_id,
                    $5::jsonb->>'requestPath',
                    $5::jsonb->>'method',
                    coalesce(($5::jsonb->>'statusCode')::integer, 0),
                    billing_period,
                    active_generation,
                    $7::timestamptz,
                    $6::timestamptz,
                    proxy_log,
                    $6::timestamptz
             from payload
             where outcome = 'admitted'
             returning data
           )
           select coalesce(
                    (select outcome from decision),
                    'stale_token_generation'
                  ) as outcome,
                  (select account from decision) as account,
                  (select user_data from decision) as user,
                  (select quota_state from decision) as quota_state,
                  (select data from inserted) as proxy_log`,
          [
            candidate.account_id,
            keyHash,
            candidate.feishu_user_id,
            logId,
            baseLog,
            now,
            leaseExpiresAt,
          ],
        );
        const current = currentResult.rows[0];
        if (!current || current.outcome === "stale_token_generation") {
          throw new StaleTokenGenerationError();
        }
        if (current.outcome === "quota_admission_closed") {
          if (!current.quota_state) throw new StaleTokenGenerationError();
          throw new QuotaAdmissionClosedError(current.quota_state);
        }
        if (current.outcome === "bound_user_missing") {
          if (!current.account) throw new StaleTokenGenerationError();
          return { status: "bound_user_missing", account: current.account };
        }
        if (current.outcome === "bound_user_inactive") {
          if (!current.account || !current.user) throw new StaleTokenGenerationError();
          return {
            status: "bound_user_inactive",
            account: current.account,
            user: current.user,
          };
        }
        if (!current.account || !current.user || !current.proxy_log) {
          throw new StaleTokenGenerationError();
        }
        return {
          status: "admitted",
          account: current.account,
          user: current.user,
          proxyLog: current.proxy_log,
        };
      },
    );
    if (result.status !== "retry") return result;

    const retryDelayMs = retryDelaysMs[attempt];
    if (retryDelayMs === undefined) throw new QuotaOperationBusyError();
    const jitterMs = Math.floor(Math.random() * Math.max(Math.floor(retryDelayMs / 2), 1));
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs + jitterMs));
  }
  throw new QuotaOperationBusyError();
}

export async function updatePostgresProxyLog(
  id: string,
  patch: Partial<Omit<ProxyRequestLog, "id" | "createdAt">>,
  options: {
    allowedUsageSettlementStatuses?: Array<"pending" | "retrying">;
  } = {},
) {
  const has = (key: keyof typeof patch) =>
    Object.prototype.hasOwnProperty.call(patch, key);
  const removedKeys = Object.entries(patch)
    .filter(([, value]) => value === undefined)
    .map(([key]) => key);
  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  const updatedAt = nowIso();

  return withClient(async (client) => {
    const result = await client.query<{ data: ProxyRequestLog }>(
      `with merged as (
         select id,
                (data - $2::text[]) || $3::jsonb ||
                  jsonb_build_object('updatedAt', $4::text) as data
         from proxy_request_logs
         where id = $1
           and (
             not $23::boolean
             or data->>'usageSettlementStatus' = any($24::text[])
           )
       ), normalized as (
         select id,
                case
                  when not (data ? 'totalTokens')
                    and data ? 'promptTokens'
                    and data ? 'completionTokens'
                  then data || jsonb_build_object(
                    'totalTokens',
                    (data->>'promptTokens')::bigint +
                      (data->>'completionTokens')::bigint
                  )
                  else data
                end as data
         from merged
       )
       update proxy_request_logs as target
       set feishu_user_id = case when $5::boolean then $6::text else target.feishu_user_id end,
           token_account_id = case when $7::boolean then $8::text else target.token_account_id end,
           request_path = case when $9::boolean then $10::text else target.request_path end,
           method = case when $11::boolean then $12::text else target.method end,
           status_code = case when $13::boolean then $14::integer else target.status_code end,
           billing_period = case when $15::boolean then $16::text else target.billing_period end,
           operation_generation = case when $17::boolean then $18::integer else target.operation_generation end,
           lease_expires_at = case when $19::boolean then $20::timestamptz else target.lease_expires_at end,
           heartbeat_at = case when $21::boolean then $22::timestamptz else target.heartbeat_at end,
           data = normalized.data
       from normalized
       where target.id = normalized.id
         and (
           not $23::boolean
           or target.data->>'usageSettlementStatus' = any($24::text[])
         )
       returning target.data`,
      [
        id,
        removedKeys,
        definedPatch,
        updatedAt,
        has("feishuUserId"),
        patch.feishuUserId ?? null,
        has("tokenAccountId"),
        patch.tokenAccountId ?? null,
        has("requestPath") && patch.requestPath !== undefined,
        patch.requestPath ?? null,
        has("method") && patch.method !== undefined,
        patch.method ?? null,
        has("statusCode") && patch.statusCode !== undefined,
        patch.statusCode ?? null,
        has("billingPeriod"),
        patch.billingPeriod ?? null,
        has("operationGeneration"),
        patch.operationGeneration ?? null,
        has("leaseExpiresAt"),
        patch.leaseExpiresAt ?? null,
        has("heartbeatAt"),
        patch.heartbeatAt ?? null,
        options.allowedUsageSettlementStatuses !== undefined,
        options.allowedUsageSettlementStatuses ?? [],
      ],
    );
    return result.rows[0]?.data ?? null;
  });
}

export async function updatePostgresProxyUsageSettlementRetryIfUnsettled(
  id: string,
  patch: Partial<Omit<ProxyRequestLog, "id" | "createdAt">>,
) {
  return updatePostgresProxyLog(id, patch, {
    allowedUsageSettlementStatuses: ["pending", "retrying"],
  });
}

export async function reservePostgresQuotaOperationDepartmentBudget(
  operationId: string,
  reservedDepartmentQuota: number,
) {
  const retryDelaysMs = [10, 25, 50, 100, 200, 400, 800];
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    const reserved = await withControlTransaction(async (client) => {
      const identity = await client.query<{
        department_id: string | null;
        billing_period: string;
      }>(
        `select department_id, billing_period
         from quota_operations
         where id = $1`,
        [operationId],
      );
      const departmentId = identity.rows[0]?.department_id;
      const billingPeriod = identity.rows[0]?.billing_period;
      if (!billingPeriod) throw new Error("额度操作不存在");
      if (!departmentId) throw new Error("额度操作缺少部门，无法预占部门预算");

      const lockResult = await client.query<{ locked: boolean }>(
        "select pg_try_advisory_xact_lock(hashtext($1)::bigint) as locked",
        [`department-quota:${departmentId}:${billingPeriod}`],
      );
      if (!lockResult.rows[0]?.locked) return null;

      const operationResult = await client.query<{ data: QuotaOperation }>(
        "select data from quota_operations where id = $1 for update",
        [operationId],
      );
      const operation = operationResult.rows[0]?.data;
      if (!operation) throw new Error("额度操作不存在");
      if (operation.reservedDepartmentQuota === reservedDepartmentQuota) return operation;

      const policyResult = await client.query<{ data: DepartmentQuotaPeriod }>(
        `select data
         from department_quota_periods
         where department_id = $1 and period = $2
         limit 1`,
        [departmentId, billingPeriod],
      );
      const policy = policyResult.rows[0]?.data;
      if (!policy) throw new Error("部门账期预算不存在");

      const committedResult = await client.query<{ quota: string }>(
        `select coalesce(sum(entry.signed_quota), 0)::text as quota
         from quota_ledger_entries entry
         where entry.period = $2
           and (
             entry.department_id = $1
             or exists (
               select 1 from feishu_users user_row
               where user_row.id = entry.feishu_user_id
                 and user_row.department_id = $1
                 and coalesce(user_row.data->>'status', 'active') <> 'deleted'
             )
           )`,
        [departmentId, billingPeriod],
      );
      const pendingResult = await client.query<{ quota: string }>(
        `select coalesce(
           sum(greatest(coalesce((data->>'reservedDepartmentQuota')::bigint, 0), 0)),
           0
         )::text as quota
         from quota_operations
         where id <> $1
           and department_id = $2
           and billing_period = $3
           and state not in ('completed', 'compensated')`,
        [operationId, departmentId, billingPeriod],
      );
      const budgetQuota = Math.max(
        Math.round(policy.quotaLimit * getConfig().newapi.quotaPerUnit),
        0,
      );
      const committedAuthorizedQuota = Math.max(
        Number(committedResult.rows[0]?.quota ?? 0),
        0,
      );
      const pendingReservedQuota = Math.max(
        Number(pendingResult.rows[0]?.quota ?? 0),
        0,
      );
      const availableQuota = Math.max(
        budgetQuota - committedAuthorizedQuota - pendingReservedQuota,
        0,
      );
      if (reservedDepartmentQuota > availableQuota) {
        throw new Error("部门可用额度不足，无法预占本次额度操作");
      }

      assertQuotaOperationTransition(operation.state, "budget_reserved");
      return saveQuotaOperationRow(client, {
        ...operation,
        state: "budget_reserved",
        reservedDepartmentQuota,
        updatedAt: nowIso(),
      });
    });
    if (reserved) return reserved;

    const retryDelayMs = retryDelaysMs[attempt];
    if (retryDelayMs === undefined) throw new QuotaOperationBusyError();
    const jitterMs = Math.floor(Math.random() * Math.max(Math.floor(retryDelayMs / 2), 1));
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs + jitterMs));
  }
  throw new QuotaOperationBusyError();
}

type PostgresUsageSettlementBatchSource = {
  recordId: string;
  usageLog: NormalizedNewApiUsageLog;
};

type PostgresUsageSettlementBatchState = {
  usageRecords: NewApiUsageRecord[];
  proxyLogsById: Map<string, ProxyRequestLog>;
};

export type PostgresUsageSettlementLockedSnapshot = {
  newapiUsageRecords: NewApiUsageRecord[];
  proxyRequestLogs: ProxyRequestLog[];
};

function findBatchUsageRecord(
  state: PostgresUsageSettlementBatchState,
  record: NewApiUsageRecord,
) {
  return (
    state.usageRecords.find((candidate) => candidate.id === record.id) ??
    state.usageRecords.find((candidate) => sameNewApiUsageSource(candidate, record))
  );
}

function rememberBatchUsageRecord(
  state: PostgresUsageSettlementBatchState,
  record: NewApiUsageRecord,
) {
  const index = state.usageRecords.findIndex(
    (candidate) =>
      candidate.id === record.id || sameNewApiUsageSource(candidate, record),
  );
  if (index >= 0) state.usageRecords[index] = record;
  else state.usageRecords.push(record);
}

async function upsertPostgresNewApiUsageRecordWithClient(
  client: PoolClient,
  record: NewApiUsageRecord,
  options: {
    locksAlreadyHeld?: boolean;
    batchState?: PostgresUsageSettlementBatchState;
  } = {},
) {
  const lockKeys = newApiUsageIdentityLockKeys(record);
  if (record.matchStatus === "matched" && record.matchedProxyLogId) {
    lockKeys.push(`newapi_usage:proxy:${record.matchedProxyLogId}`);
    lockKeys.sort();
  }
  if (!options.locksAlreadyHeld) {
    await acquirePostgresUsageAdvisoryLocks(client, lockKeys);
  }
  if (record.matchStatus === "matched" && record.matchedProxyLogId) {
    const proxyMatch = options.batchState
      ? options.batchState.usageRecords.find(
          (candidate) =>
            candidate.matchStatus === "matched" &&
            candidate.matchedProxyLogId === record.matchedProxyLogId,
        )
      : (
          await client.query<{ data: NewApiUsageRecord }>(
            `select data
             from newapi_usage_records
             where match_status = 'matched'
               and data->>'matchedProxyLogId' = $1
             order by last_synced_at desc, first_seen_at, id
             limit 1
             for update`,
            [record.matchedProxyLogId],
          )
        ).rows[0]?.data;
    if (proxyMatch && !sameNewApiUsageSource(proxyMatch, record)) {
      return proxyMatch;
    }
  }
  const existing = options.batchState
    ? findBatchUsageRecord(options.batchState, record)
    : (
        await client.query<{ data: NewApiUsageRecord }>(
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
           order by case
             when id = $1 then 0
             when $3::text is not null and newapi_request_id = $3 then 1
             else 2
           end
           limit 1
           for update`,
          [
            record.id,
            record.newapiTokenId ?? null,
            record.newapiRequestId ?? null,
            record.newapiLogId ?? null,
          ],
        )
      ).rows[0]?.data;
  if (existing && hasConflictingProxyMatch(existing, record)) {
    return existing;
  }
  if (
    existing?.matchStatus === "matched" &&
    existing.matchedProxyLogId &&
    (record.matchStatus !== "matched" || !record.matchedProxyLogId)
  ) {
    // An authoritative source-to-proxy binding is an absorbing state. A later
    // targeted/partial scan may not have loaded that proxy and can therefore
    // propose no_proxy_match for the same source; never let such a retry
    // silently release the unique binding. Unbinding requires an explicit,
    // separately audited repair operation.
    return existing;
  }
  const stored = await saveNewApiUsageRecordRow(client, {
    ...existing,
    ...record,
    id: existing?.id ?? record.id,
    firstSeenAt: existing?.firstSeenAt ?? record.firstSeenAt,
  });
  if (options.batchState) rememberBatchUsageRecord(options.batchState, stored);
  return stored;
}

export async function upsertPostgresNewApiUsageRecord(record: NewApiUsageRecord) {
  return withSettlementTransaction((client) =>
    upsertPostgresNewApiUsageRecordWithClient(client, record),
  );
}

type MatchedNewApiUsageSettlementInput = {
  record: NewApiUsageRecord;
  proxyLogId: string;
  patch: Partial<Omit<ProxyRequestLog, "id" | "createdAt">>;
  syncedAt: string;
};

async function closePostgresResolvedNoProxyMatchIssues(
  client: PoolClient,
  record: NewApiUsageRecord,
  proxyLogId: string,
  syncedAt: string,
) {
  const issues = await client.query<{ data: UsageSyncIssue }>(
    `select data
       from usage_sync_issues
      where issue_type = 'no_proxy_match'
        and status = 'open'
        and newapi_token_id is not distinct from $1
        and (
          ($2::text is not null and newapi_request_id = $2)
          or (
            ($2::text is null or newapi_request_id is null)
            and $3::text is not null
            and newapi_log_id = $3
          )
        )
      for update`,
    [record.newapiTokenId ?? null, record.newapiRequestId ?? null, record.newapiLogId ?? null],
  );
  for (const row of issues.rows) {
    if (!sameNewApiUsageSource(row.data, record)) continue;
    await saveUsageSyncIssueRow(client, {
      ...row.data,
      status: "closed",
      matchedProxyLogId: proxyLogId,
      lastSyncedAt: syncedAt,
      closedAt: syncedAt,
    });
  }
}

async function closePostgresResolvedNoProxyMatchIssuesBatch(
  client: PoolClient,
  records: NewApiUsageRecord[],
) {
  if (!records.length) return;
  const sourceIdentities = records.map((record) => ({
    newapi_token_id: record.newapiTokenId ?? null,
    newapi_request_id: record.newapiRequestId ?? null,
    newapi_log_id: record.newapiLogId ?? null,
  }));
  const issues = await client.query<{ data: UsageSyncIssue }>(
    `with source_identities as (
       select distinct
              source.newapi_token_id,
              source.newapi_request_id,
              source.newapi_log_id
         from jsonb_to_recordset($1::jsonb) as source(
           newapi_token_id text,
           newapi_request_id text,
           newapi_log_id text
         )
     )
     select issue.data
       from usage_sync_issues issue
      where issue.issue_type = 'no_proxy_match'
        and issue.status = 'open'
        and exists (
          select 1
            from source_identities source
           where issue.newapi_token_id is not distinct from source.newapi_token_id
             and (
               (source.newapi_request_id is not null
                 and issue.newapi_request_id = source.newapi_request_id)
               or (
                 (source.newapi_request_id is null or issue.newapi_request_id is null)
                 and source.newapi_log_id is not null
                 and issue.newapi_log_id = source.newapi_log_id
               )
             )
        )
      order by issue.id
      for update of issue`,
    [JSON.stringify(sourceIdentities)],
  );
  for (const row of issues.rows) {
    const record = records.find((candidate) => sameNewApiUsageSource(row.data, candidate));
    if (!record?.matchedProxyLogId) continue;
    await saveUsageSyncIssueRow(client, {
      ...row.data,
      status: "closed",
      matchedProxyLogId: record.matchedProxyLogId,
      lastSyncedAt: record.lastSyncedAt,
      closedAt: record.lastSyncedAt,
    });
  }
}

async function settlePostgresMatchedNewApiUsageWithClient(
  client: PoolClient,
  input: MatchedNewApiUsageSettlementInput,
  options: {
    closeResolvedIssues?: boolean;
    locksAlreadyHeld?: boolean;
    batchState?: PostgresUsageSettlementBatchState;
  } = {},
) {
    const usageRecord = await upsertPostgresNewApiUsageRecordWithClient(
      client,
      input.record,
      {
        locksAlreadyHeld: options.locksAlreadyHeld,
        batchState: options.batchState,
      },
    );
    if (
      !sameNewApiUsageSource(usageRecord, input.record) ||
      usageRecord.matchStatus !== "matched" ||
      usageRecord.matchedProxyLogId !== input.proxyLogId
    ) {
      return { usageRecord, proxyLog: null };
    }

    const existing = options.batchState
      ? options.batchState.proxyLogsById.get(input.proxyLogId)
      : (
          await client.query<{ data: ProxyRequestLog }>(
            "select data from proxy_request_logs where id = $1 for update",
            [input.proxyLogId],
          )
        ).rows[0]?.data;
    if (!existing) {
      throw new Error(`Matched proxy log ${input.proxyLogId} disappeared during settlement`);
    }
    if (!isNewApiUsageMatchEligibleProxyLog(existing, input.record)) {
      throw new Error(
        `Matched proxy log ${input.proxyLogId} is neither billable nor an exact successful-upstream recovery`,
      );
    }
    if (
      input.record.tokenAccountId &&
      existing.tokenAccountId &&
      input.record.tokenAccountId !== existing.tokenAccountId
    ) {
      throw new Error(`Matched proxy log ${input.proxyLogId} belongs to another token account`);
    }
    if (
      existing.newapiResponseRequestId &&
      existing.newapiResponseRequestId !== input.record.newapiRequestId &&
      existing.newapiResponseRequestId !== input.record.newapiUpstreamRequestId
    ) {
      throw new Error(`Matched proxy log ${input.proxyLogId} has a conflicting NewAPI identity`);
    }
    const updated: ProxyRequestLog = {
      ...existing,
      ...input.patch,
      usageSyncedAt: input.syncedAt,
      updatedAt: input.syncedAt,
    };
    if (
      updated.totalTokens === undefined &&
      updated.promptTokens !== undefined &&
      updated.completionTokens !== undefined
    ) {
      updated.totalTokens = updated.promptTokens + updated.completionTokens;
    }
    const proxyLog = await saveProxyLogRow(client, updated);
    if (options.batchState) {
      options.batchState.proxyLogsById.set(proxyLog.id, proxyLog);
    }
    if (options.closeResolvedIssues !== false) {
      await closePostgresResolvedNoProxyMatchIssues(
        client,
        usageRecord,
        proxyLog.id,
        input.syncedAt,
      );
    }
    return { usageRecord, proxyLog };
}

export async function settlePostgresMatchedNewApiUsage(
  input: MatchedNewApiUsageSettlementInput,
) {
  return withSettlementTransaction((client) =>
    settlePostgresMatchedNewApiUsageWithClient(client, input),
  );
}

async function upsertPostgresUsageSyncIssueWithClient(
  client: PoolClient,
  issue: UsageSyncIssue,
  options: { locksAlreadyHeld?: boolean } = {},
) {
  if (!options.locksAlreadyHeld) {
    await acquirePostgresUsageAdvisoryLocks(
      client,
      newApiUsageIdentityLockKeys(issue),
    );
  }
  const resolvedResult =
    issue.issueType === "no_proxy_match"
      ? await client.query<{ data: NewApiUsageRecord }>(
          `select data
             from newapi_usage_records
            where match_status = 'matched'
              and newapi_token_id is not distinct from $1
              and (
                ($2::text is not null and newapi_request_id = $2)
                or (
                  ($2::text is null or newapi_request_id is null)
                  and $3::text is not null
                  and newapi_log_id = $3
                )
              )
            order by last_synced_at desc, first_seen_at, id
            limit 1`,
          [issue.newapiTokenId ?? null, issue.newapiRequestId ?? null, issue.newapiLogId ?? null],
        )
      : undefined;
  const resolved = resolvedResult?.rows[0]?.data;
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
    status: resolved ? "closed" : "open",
    matchedProxyLogId: resolved?.matchedProxyLogId ?? issue.matchedProxyLogId,
    closedAt: resolved ? issue.lastSyncedAt : undefined,
  });
}

export async function upsertPostgresUsageSyncIssue(issue: UsageSyncIssue) {
  return withSettlementTransaction((client) =>
    upsertPostgresUsageSyncIssueWithClient(client, issue),
  );
}

async function loadPostgresUsageSettlementBatchState(
  client: PoolClient,
  input: {
    usageSources: PostgresUsageSettlementBatchSource[];
    proxyLogIds: string[];
  },
): Promise<PostgresUsageSettlementBatchState> {
  const sourceRecordIds = [
    ...new Set(input.usageSources.map((source) => source.recordId).filter(Boolean)),
  ];
  const sourceTokenIds = [
    ...new Set(
      input.usageSources
        .map((source) => source.usageLog.newapiTokenId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const sourceRequestIds = [
    ...new Set(
      input.usageSources
        .map((source) => source.usageLog.newapiRequestId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const sourceLogIds = [
    ...new Set(
      input.usageSources
        .map((source) => source.usageLog.newapiLogId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const proxyLogIds = [...new Set(input.proxyLogIds.filter(Boolean))];
  const usageRecords =
    sourceRecordIds.length || proxyLogIds.length
      ? await client.query<{ data: NewApiUsageRecord }>(
          `select data
             from newapi_usage_records
            where id = any($1::text[])
               or (
                 newapi_token_id = any($2::text[])
                 and (
                   newapi_request_id = any($3::text[])
                   or newapi_log_id = any($4::text[])
                 )
               )
               or (
                 match_status = 'matched'
                 and data->>'matchedProxyLogId' = any($5::text[])
               )
            order by id
            for update`,
          [
            sourceRecordIds,
            sourceTokenIds,
            sourceRequestIds,
            sourceLogIds,
            proxyLogIds,
          ],
        )
      : { rows: [] as Array<{ data: NewApiUsageRecord }> };
  const proxyLogs = proxyLogIds.length
    ? await client.query<{ data: ProxyRequestLog }>(
        `select data
           from proxy_request_logs
          where id = any($1::text[])
          order by id
          for update`,
        [proxyLogIds],
      )
    : { rows: [] as Array<{ data: ProxyRequestLog }> };
  return {
    usageRecords: usageRecords.rows.map((row) => row.data),
    proxyLogsById: new Map(
      proxyLogs.rows.map((row) => [row.data.id, row.data] as const),
    ),
  };
}

export type PostgresUsageSettlementBatchWriter = {
  upsertUsageRecord(record: NewApiUsageRecord): Promise<NewApiUsageRecord>;
  upsertUsageIssue(issue: UsageSyncIssue): Promise<UsageSyncIssue>;
  settleMatchedUsage(input: MatchedNewApiUsageSettlementInput): Promise<{
    usageRecord: NewApiUsageRecord;
    proxyLog: ProxyRequestLog | null;
  }>;
};

async function acquirePostgresUsageAdvisoryLocks(
  client: PoolClient,
  lockKeys: string[],
) {
  const uniqueLockKeys = [...new Set(lockKeys)].sort();
  if (!uniqueLockKeys.length) return;
  // Every participant uses the same lexical lock order. The page worker takes
  // all source and candidate-proxy locks in one round trip, eliminating both
  // hundreds of per-record lock queries and batch/immediate lock-order cycles.
  await client.query(
    `select pg_advisory_xact_lock(hashtext(ordered.lock_key)::bigint)
       from (
         select distinct lock_key
           from unnest($1::text[]) as keys(lock_key)
          order by lock_key
       ) ordered`,
    [uniqueLockKeys],
  );
}

export async function withPostgresUsageSettlementBatch<T>(
  run: (
    writer: PostgresUsageSettlementBatchWriter,
    lockedSnapshot?: PostgresUsageSettlementLockedSnapshot,
  ) => Promise<T>,
  options: {
    lockKeys?: string[];
    usageSources?: PostgresUsageSettlementBatchSource[];
    proxyLogIds?: string[];
  } = {},
) {
  return withSettlementTransaction(async (client) => {
    const usageSources = options.usageSources ?? [];
    const proxyLogIds = [...new Set((options.proxyLogIds ?? []).filter(Boolean))];
    const derivedLockKeys = [
      ...(options.lockKeys ?? []),
      ...usageSources.flatMap((source) =>
        newApiUsageIdentityLockKeys({
          ...source.usageLog,
          id: source.recordId,
        }),
      ),
      ...proxyLogIds.map((proxyLogId) => `newapi_usage:proxy:${proxyLogId}`),
    ];
    await acquirePostgresUsageAdvisoryLocks(client, derivedLockKeys);
    // The matching snapshot is deliberately read before the transaction so it
    // does not hold row locks while evaluating up to 100 candidates. Once all
    // deterministic source/proxy advisory locks are held, refresh the rows in
    // two bounded queries and reuse that locked state for every item in the
    // page. This removes three read round trips per matched record without
    // weakening source identity or one-to-one proxy conflict checks.
    const batchState =
      options.usageSources || options.proxyLogIds
        ? await loadPostgresUsageSettlementBatchState(client, {
            usageSources,
            proxyLogIds,
          })
        : undefined;
    const resolvedRecords: NewApiUsageRecord[] = [];
    const result = await run(
      {
        upsertUsageRecord: (record) =>
          upsertPostgresNewApiUsageRecordWithClient(client, record, {
            locksAlreadyHeld: true,
            batchState,
          }),
        upsertUsageIssue: (issue) =>
          upsertPostgresUsageSyncIssueWithClient(client, issue, {
            locksAlreadyHeld: true,
          }),
        settleMatchedUsage: async (input) => {
          const settled = await settlePostgresMatchedNewApiUsageWithClient(
            client,
            input,
            {
              closeResolvedIssues: false,
              locksAlreadyHeld: true,
              batchState,
            },
          );
          if (settled.proxyLog) resolvedRecords.push(settled.usageRecord);
          return settled;
        },
      },
      batchState
        ? {
            // The usage array is intentionally shared with batchState so each
            // RETURNING row becomes visible to later ordered matches in this
            // same page.
            newapiUsageRecords: batchState.usageRecords,
            proxyRequestLogs: [...batchState.proxyLogsById.values()],
          }
        : undefined,
    );
    // Closing resolved issues is derived from the same authoritative page and
    // stays in its transaction, but uses one page query instead of one query
    // for every matched usage record.
    await closePostgresResolvedNoProxyMatchIssuesBatch(client, resolvedRecords);
    return result;
  });
}

export async function upsertPostgresUsageSyncCheckpoint(checkpoint: UsageSyncCheckpoint) {
  return withSettlementTransaction(async (client) =>
    saveUsageSyncCheckpointRow(client, checkpoint),
  );
}

export class PostgresAdvisoryLockBusyError extends Error {
  readonly code = "POSTGRES_ADVISORY_LOCK_BUSY";
  readonly lockKey: string;

  constructor(lockKey: string) {
    super(`${lockKey} is already running`);
    this.name = "PostgresAdvisoryLockBusyError";
    this.lockKey = lockKey;
  }
}

export function isPostgresAdvisoryLockBusyError(
  error: unknown,
): error is PostgresAdvisoryLockBusyError {
  return (
    error instanceof PostgresAdvisoryLockBusyError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "POSTGRES_ADVISORY_LOCK_BUSY")
  );
}

export async function withPostgresAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>,
  options: { wait?: boolean } = {},
) {
  return withAdvisoryLockClient(async (client) => {
    if (options.wait) {
      await client.query("select pg_advisory_lock(hashtext($1)::bigint)", [key]);
    } else {
      const lockResult = await client.query<{ locked: boolean }>(
        "select pg_try_advisory_lock(hashtext($1)::bigint) as locked",
        [key],
      );
      if (!lockResult.rows[0]?.locked) {
        throw new PostgresAdvisoryLockBusyError(key);
      }
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
    await client.query("delete from quota_change_events");
    await client.query("delete from department_quota_requests");
    await client.query("delete from department_quota_periods");
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

    await insertJsonRows(
      client,
      "department_quota_periods",
      store.departmentQuotaPeriods,
      (period) => ({
        sql: `insert into department_quota_periods
          (id, department_id, period, data, created_at, updated_at)
          values ($1, $2, $3, $4, $5, $6)`,
        values: [
          period.id,
          period.departmentId,
          period.period,
          period,
          period.createdAt,
          period.updatedAt,
        ],
      }),
    );

    await insertJsonRows(
      client,
      "department_quota_requests",
      store.departmentQuotaRequests,
      (request) => ({
        sql: `insert into department_quota_requests
          (id, department_id, requester_feishu_user_id, period, status,
           approval_target_open_id, approval_action_nonce_hash, data, created_at, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        values: [
          request.id,
          request.departmentId,
          request.requesterFeishuUserId,
          request.period,
          request.status,
          request.approvalTargetOpenId,
          request.approvalActionNonceHash,
          request,
          request.createdAt,
          request.updatedAt,
        ],
      }),
    );

    await insertJsonRows(client, "quota_change_events", store.quotaChangeEvents, (event) => ({
      sql: `insert into quota_change_events
        (id, department_id, feishu_user_id, period, status,
         related_token_request_id, data, created_at, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      values: [
        event.id,
        event.departmentId,
        event.feishuUserId ?? null,
        event.period,
        event.status,
        event.relatedTokenRequestId ?? null,
        event,
        event.createdAt,
        event.updatedAt,
      ],
    }));

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
