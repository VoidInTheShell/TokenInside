import { Pool, type PoolClient } from "pg";
import { resolveSessionAdminScopeProjection } from "@/lib/admin-scope";
import { getConfig } from "@/lib/config";
import { nowIso, randomId } from "@/lib/crypto";
import { isTerminalBillingOperationStatus } from "@/lib/billing-operation-state";
import {
  initialDepartmentQuotaLimit,
  validateDepartmentQuotaLimit,
} from "@/lib/department-quota";
import {
  assertQuotaExecutionFenceHeld,
  createQuotaExecutionFence,
  runWithQuotaExecutionFence,
  type QuotaExecutionFence,
} from "@/lib/quota-execution-fence";
import type { NormalizedNewApiUsageLog } from "@/lib/newapi";
import {
  hasConflictingProxyMatch,
  newApiUsageIdentityLockKeys,
  sameNewApiUsageSource,
} from "@/lib/newapi-usage-identity";
import {
  initialUnassignedMonthlyQuota,
  isSettlementWatermarkFresh,
  materializeDepartmentQuota,
  materializeUserQuota,
  resolveUsageBillingPeriod,
} from "@/lib/quota-model";
import {
  assertPackageResetExecutionAllowed,
  normalizePackageResetPolicy,
  PACKAGE_RESET_SYSTEM_ACTOR,
} from "@/lib/package-reset";
import {
  assertQuotaOperationTransition,
  canCancelQuotaOperationForAccessRevoke,
  canReopenMonthlyOpenAfterAccessRevoke,
  reopenMonthlyOpenAfterAccessRevoke,
} from "@/lib/quota-saga-state";
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
import { preserveUserAccessRevocationBarrier } from "@/lib/user-access-state";
import {
  openQuotaAdjustmentRequestStatuses,
  PendingQuotaAdjustmentRequestError,
} from "@/lib/token-request-policy";
import {
  lockDepartmentMemberSyncUsersSql,
  upsertDepartmentMembersSql,
} from "@/lib/department-member-sync-sql";
import {
  listStaleUserAccessResumeCandidatesSql,
  markUserAccessResumeEnableAttemptSql,
  rollbackPendingUserAccessResumeSql,
} from "@/lib/user-access-recovery-sql";
import type {
  AdminScope,
  AppSettings,
  BillingOperationKind,
  BillingOperationRecord,
  BillingOperationStatus,
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

const POSTGRES_POOL_REGISTRY_VERSION = 2;

type PostgresPoolRegistry = {
  version: typeof POSTGRES_POOL_REGISTRY_VERSION;
  configFingerprint?: string;
  business?: Pool;
  control?: Pool;
  advisoryLock?: Pool;
};

type PostgresPoolGlobal = typeof globalThis & {
  __tokenInsidePostgresPoolRegistry?: PostgresPoolRegistry;
};

// Next.js emits independent server chunks for instrumentation, health, and
// control routes. Module-local Pool variables are duplicated in those
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
    control: poolRuntimeSnapshot(registry.control),
    lock: poolRuntimeSnapshot(registry.advisoryLock),
  };
}

export const REQUIRED_POSTGRES_TABLES = [
  "schema_migrations",
  "app_settings",
  "billing_operations",
  "feishu_users",
  "token_requests",
  "token_accounts",
  "department_quota_periods",
  "quota_change_events",
  "user_quota_policies",
  "quota_operations",
  "quota_ledger_entries",
  "user_quota_states",
  "quota_reconciliation_records",
  "feishu_events",
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
  assertQuotaExecutionFenceHeld();
  const client = await getPool().connect();
  try {
    const result = await fn(client);
    assertQuotaExecutionFenceHeld();
    return result;
  } finally {
    client.release();
  }
}

async function withControlClient<T>(fn: (client: PoolClient) => Promise<T>) {
  assertQuotaExecutionFenceHeld();
  const client = await getControlPool().connect();
  try {
    const result = await fn(client);
    assertQuotaExecutionFenceHeld();
    return result;
  } finally {
    client.release();
  }
}

async function withSettlementClient<T>(fn: (client: PoolClient) => Promise<T>) {
  assertQuotaExecutionFenceHeld();
  const client = await getPool().connect();
  try {
    const result = await fn(client);
    assertQuotaExecutionFenceHeld();
    return result;
  } finally {
    client.release();
  }
}

export { withControlClient as withPostgresControlClient };

async function withAdvisoryLockClient<T>(
  fn: (client: PoolClient, destroyClient: () => void) => Promise<T>,
) {
  const client = await getAdvisoryLockPool().connect();
  let destroy = false;
  try {
    return await fn(client, () => {
      destroy = true;
    });
  } finally {
    client.release(destroy);
  }
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>) {
  return withClient(async (client) => {
    try {
      await client.query("begin");
      const result = await fn(client);
      assertQuotaExecutionFenceHeld();
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
      assertQuotaExecutionFenceHeld();
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
      assertQuotaExecutionFenceHeld();
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

function isAuthoritativeUsageRecord(record: NewApiUsageRecord) {
  return Boolean(
    record.feishuUserId &&
      record.tokenAccountId &&
      (record.matchStatus === "matched" || record.matchStatus === "no_proxy_match"),
  );
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
  assignedMonthlyQuota: number;
  authorizedQuota: number;
  authoritativeConsumedQuota: number;
  expectedAvailableQuota: number;
  overageQuota: number;
  ledgerEntries: number;
  policyPresent: boolean;
};

async function readSettingsRow(client: PoolClient) {
  const result = await client.query<{
    data: AppSettings & { billingOperations?: unknown };
  }>(
    "select data from app_settings where id = 'default'",
  );
  const { billingOperations: _legacyBillingOperations, ...settings } =
    result.rows[0]?.data ?? { defaultMonthlyQuota: 200 };
  return {
    ...settings,
    packageReset: normalizePackageResetPolicy(settings.packageReset),
  };
}

async function saveSettingsRow(client: PoolClient, settings: AppSettings) {
  const { billingOperations: _legacyBillingOperations, ...safeSettings } = settings as
    AppSettings & { billingOperations?: unknown };
  const result = await client.query<{ data: AppSettings }>(
    `insert into app_settings (id, data)
     values ('default', $1)
     on conflict (id) do update set data = excluded.data
     returning data`,
    [safeSettings],
  );
  return result.rows[0].data;
}

type PostgresTimestamp = string | Date;

type PostgresBillingOperationRow = {
  id: string;
  kind: BillingOperationKind;
  status: BillingOperationStatus;
  dry_run: boolean;
  operated_by_feishu_user_id: string;
  period: string | null;
  input: Record<string, unknown>;
  summary: BillingOperationRecord["summary"];
  error_message: string | null;
  attempt_count: number;
  lease_id: string | null;
  lease_expires_at: PostgresTimestamp | null;
  started_at: PostgresTimestamp | null;
  completed_at: PostgresTimestamp | null;
  created_at: PostgresTimestamp;
  updated_at: PostgresTimestamp;
};

const billingOperationColumns = `
  id, kind, status, dry_run, operated_by_feishu_user_id, period,
  input, summary, error_message, attempt_count, lease_id,
  lease_expires_at, started_at, completed_at, created_at, updated_at
`;

function postgresTimestampIso(value: PostgresTimestamp) {
  return value instanceof Date ? value.toISOString() : value;
}

function billingOperationFromRow(row: PostgresBillingOperationRow): BillingOperationRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    dryRun: row.dry_run,
    operatedByFeishuUserId: row.operated_by_feishu_user_id,
    ...(row.period !== null ? { period: row.period } : {}),
    ...(Object.keys(row.input ?? {}).length > 0 ? { input: row.input } : {}),
    summary: row.summary ?? {},
    ...(row.error_message !== null ? { errorMessage: row.error_message } : {}),
    ...(row.attempt_count > 0 ? { attemptCount: row.attempt_count } : {}),
    ...(row.lease_id !== null ? { leaseId: row.lease_id } : {}),
    ...(row.lease_expires_at !== null
      ? { leaseExpiresAt: postgresTimestampIso(row.lease_expires_at) }
      : {}),
    ...(row.started_at !== null
      ? { startedAt: postgresTimestampIso(row.started_at) }
      : {}),
    ...(row.completed_at !== null
      ? { completedAt: postgresTimestampIso(row.completed_at) }
      : {}),
    createdAt: postgresTimestampIso(row.created_at),
    updatedAt: postgresTimestampIso(row.updated_at),
  };
}

function billingOperationValues(operation: BillingOperationRecord) {
  return [
    operation.id,
    operation.kind,
    operation.status,
    operation.dryRun,
    operation.operatedByFeishuUserId,
    operation.period ?? null,
    operation.input ?? {},
    operation.summary,
    operation.errorMessage ?? null,
    operation.attemptCount ?? 0,
    operation.leaseId ?? null,
    operation.leaseExpiresAt ?? null,
    operation.startedAt ?? null,
    operation.completedAt ?? null,
    operation.createdAt,
    operation.updatedAt,
  ];
}

async function insertPostgresBillingOperationRow(
  client: PoolClient,
  operation: BillingOperationRecord,
) {
  const result = await client.query<PostgresBillingOperationRow>(
    `insert into billing_operations
      (id, kind, status, dry_run, operated_by_feishu_user_id, period,
       input, summary, error_message, attempt_count, lease_id,
       lease_expires_at, started_at, completed_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     returning ${billingOperationColumns}`,
    billingOperationValues(operation),
  );
  return billingOperationFromRow(result.rows[0]);
}

async function updatePostgresBillingOperationRowWithLease(
  client: PoolClient,
  operation: BillingOperationRecord,
  expectedLeaseId: string,
) {
  const result = await client.query<PostgresBillingOperationRow>(
    `update billing_operations set
       status = $3,
       summary = $8,
       error_message = $9,
       lease_id = null,
       lease_expires_at = null,
       completed_at = statement_timestamp(),
       updated_at = statement_timestamp()
     where id = $1
       and kind = $2
       and dry_run = $4
       and operated_by_feishu_user_id = $5
       and period is not distinct from $6
       and input = $7::jsonb
       and status = 'running'
       and lease_id = $10
       and lease_expires_at > statement_timestamp()
     returning ${billingOperationColumns}`,
    [
      operation.id,
      operation.kind,
      operation.status,
      operation.dryRun,
      operation.operatedByFeishuUserId,
      operation.period ?? null,
      operation.input ?? {},
      operation.summary,
      operation.errorMessage ?? null,
      expectedLeaseId,
    ],
  );
  return result.rows[0] ? billingOperationFromRow(result.rows[0]) : null;
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
       version, source_type, source_id, data, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (id) do update set
       department_id = excluded.department_id,
       effective_from_period = excluded.effective_from_period,
       effective_to_period = excluded.effective_to_period,
       version = excluded.version,
       source_type = excluded.source_type,
       source_id = excluded.source_id,
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
      policy.sourceType,
      policy.sourceId,
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
       billing_period, state, operation_generation, next_retry_at,
       worker_lease_id, worker_lease_expires_at, data,
       created_at, updated_at, completed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     on conflict (id) do update set
       state = excluded.state,
       next_retry_at = excluded.next_retry_at,
       worker_lease_id = excluded.worker_lease_id,
       worker_lease_expires_at = excluded.worker_lease_expires_at,
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
      operation.workerLeaseId ?? null,
      operation.workerLeaseExpiresAt ?? null,
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
       feishu_user_id, billing_period, match_status, data, newapi_created_at,
       first_seen_at, last_synced_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (id) do update set
       newapi_log_id = excluded.newapi_log_id,
       newapi_request_id = excluded.newapi_request_id,
       newapi_token_id = excluded.newapi_token_id,
       token_account_id = excluded.token_account_id,
       feishu_user_id = excluded.feishu_user_id,
       billing_period = excluded.billing_period,
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
      record.billingPeriod ?? null,
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

export type AdminUserActionAuthorizationCode =
  | "actor_scope_missing"
  | "target_out_of_scope"
  | "root_required"
  | "self_access_revoke_forbidden"
  | "last_root_revoke_forbidden";

export class AdminUserActionAuthorizationError extends Error {
  constructor(
    readonly code: AdminUserActionAuthorizationCode,
    readonly status: 403 | 409,
    message: string,
  ) {
    super(message);
    this.name = "AdminUserActionAuthorizationError";
  }
}

export function isAdminUserActionAuthorizationError(
  error: unknown,
): error is AdminUserActionAuthorizationError {
  return (
    error instanceof AdminUserActionAuthorizationError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AdminUserActionAuthorizationError" &&
      "code" in error)
  );
}

function adminScopeUserLockKey(feishuUserId: string) {
  return `admin-scope-user:${feishuUserId}`;
}

async function lockAdminScopeUsersInTransaction(
  client: PoolClient,
  feishuUserIds: string[],
) {
  const uniqueIds = [...new Set(feishuUserIds)].sort();
  for (const feishuUserId of uniqueIds) {
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      adminScopeUserLockKey(feishuUserId),
    ]);
  }
}

export function assertAdminScopeAllowsUserTarget(
  scope: AdminScope | null,
  targetUser: FeishuUser,
  input: {
    actorFeishuUserId: string;
    destructiveAccessRevoke?: boolean;
    activeEnvironmentRootCount?: number;
    targetHasActiveGlobalAdminScope?: boolean;
  },
) {
  if (!scope) {
    throw new AdminUserActionAuthorizationError(
      "actor_scope_missing",
      403,
      "当前管理员权限已变化，请刷新后重试",
    );
  }
  const environmentRoot = getConfig().admin.systemAdminOpenIds.includes(targetUser.openId);
  const actorIsRoot =
    scope.scopeType === "global" &&
    scope.source === "environment" &&
    scope.role === "root";
  if (input.targetHasActiveGlobalAdminScope && !actorIsRoot) {
    throw new AdminUserActionAuthorizationError(
      "root_required",
      403,
      "系统管理员用户仅允许 root 管理员操作",
    );
  }
  if (environmentRoot && !actorIsRoot) {
    throw new AdminUserActionAuthorizationError(
      "root_required",
      403,
      "环境变量 root 用户仅允许 root 管理员操作",
    );
  }
  if (
    scope.scopeType !== "global" &&
    (!targetUser.departmentId || targetUser.departmentId !== scope.departmentId)
  ) {
    throw new AdminUserActionAuthorizationError(
      "target_out_of_scope",
      403,
      "目标用户当前已不在管理员管理范围内",
    );
  }
  if (input.destructiveAccessRevoke && input.actorFeishuUserId === targetUser.id) {
    throw new AdminUserActionAuthorizationError(
      "self_access_revoke_forbidden",
      409,
      "不能禁用或删除当前登录的管理员账号",
    );
  }
  if (
    input.destructiveAccessRevoke &&
    environmentRoot &&
    (input.activeEnvironmentRootCount ?? 0) <= 1
  ) {
    throw new AdminUserActionAuthorizationError(
      "last_root_revoke_forbidden",
      409,
      "不能禁用或删除最后一个可用的 root 管理员",
    );
  }
}

async function resolvePostgresActorScopeInTransaction(
  client: PoolClient,
  actorFeishuUserId: string,
) {
  const result = await client.query<{
    user: FeishuUser;
    active_scope: AdminScope | null;
    assigned_request: TokenRequest | null;
    scopes: AdminScope[];
  }>(
    `select
       actor.data as user,
       (select scope.data
        from admin_scopes scope
        where scope.feishu_user_id = actor.id
          and scope.status = 'active'
        order by case when scope.scope_type = 'global' then 0 else 1 end,
                 scope.updated_at desc,
                 scope.id
        limit 1) as active_scope,
       (select request.data
        from token_requests request
        where request.approval_target_open_id = actor.open_id
        order by request.updated_at desc, request.id
        limit 1) as assigned_request,
       coalesce(
         (select jsonb_agg(scope.data order by scope.updated_at desc, scope.id)
          from admin_scopes scope
          where scope.feishu_user_id = actor.id),
         '[]'::jsonb
       ) as scopes
     from feishu_users actor
     where actor.id = $1`,
    [actorFeishuUserId],
  );
  const row = result.rows[0];
  if (!row?.user) return null;
  return resolveSessionAdminScopeProjection({
    user: row.user,
    systemAdminOpenIds: new Set(getConfig().admin.systemAdminOpenIds),
    activeScope: row.active_scope,
    assignedRequest: row.assigned_request,
    scopes: row.scopes ?? [],
  });
}

async function authorizePostgresAdminUserAction(
  client: PoolClient,
  input: {
    actorFeishuUserId: string;
    targetFeishuUserId: string;
    adminScopeLocksHeld?: boolean;
    destructiveAccessRevoke?: boolean;
  },
) {
  if (!input.adminScopeLocksHeld) {
    await lockAdminScopeUsersInTransaction(client, [
      input.actorFeishuUserId,
      input.targetFeishuUserId,
    ]);
  }
  const targetResult = await client.query<{ data: FeishuUser }>(
    "select data from feishu_users where id = $1 for update",
    [input.targetFeishuUserId],
  );
  const targetUser = targetResult.rows[0]?.data;
  if (!targetUser) return null;

  const environmentRoot = getConfig().admin.systemAdminOpenIds.includes(targetUser.openId);
  let activeEnvironmentRootCount: number | undefined;
  if (input.destructiveAccessRevoke && environmentRoot) {
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      "admin-scope-root-membership",
    ]);
    const countResult = await client.query<{ count: number }>(
      `select count(*)::integer as count
       from feishu_users
       where open_id = any($1::text[])
         and coalesce(data->>'status', 'active') = 'active'`,
      [getConfig().admin.systemAdminOpenIds],
    );
    activeEnvironmentRootCount = countResult.rows[0]?.count ?? 0;
  }

  const actorScope = await resolvePostgresActorScopeInTransaction(
    client,
    input.actorFeishuUserId,
  );
  const targetGlobalScope = await client.query<{ present: boolean }>(
    `select exists (
       select 1 from admin_scopes
       where feishu_user_id = $1
         and status = 'active'
         and scope_type = 'global'
     ) as present`,
    [input.targetFeishuUserId],
  );
  assertAdminScopeAllowsUserTarget(actorScope, targetUser, {
    actorFeishuUserId: input.actorFeishuUserId,
    destructiveAccessRevoke: input.destructiveAccessRevoke,
    activeEnvironmentRootCount,
    targetHasActiveGlobalAdminScope:
      environmentRoot || Boolean(targetGlobalScope.rows[0]?.present),
  });
  return { actorScope, targetUser };
}

export async function authorizePostgresAdminUserActionUnderScopeLocks(input: {
  actorFeishuUserId: string;
  targetFeishuUserId: string;
  destructiveAccessRevoke?: boolean;
}) {
  return withControlTransaction((client) =>
    authorizePostgresAdminUserAction(client, {
      ...input,
      adminScopeLocksHeld: true,
    }),
  );
}

async function revokeAdminScopesForUserInTransaction(
  client: PoolClient,
  input: {
    feishuUserId: string;
    reason: NonNullable<AdminScope["disabledReason"]>;
    disabledByFeishuUserId?: string;
    now: string;
    adminScopeLockHeld?: boolean;
  },
) {
  if (!input.adminScopeLockHeld) {
    await lockAdminScopeUsersInTransaction(client, [input.feishuUserId]);
  }
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

  const seededAt = materializedAt;
  const initialMonthlyQuota = initialUnassignedMonthlyQuota();
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
      `select data from token_accounts
       where feishu_user_id = $1 and billing_period = $2
       order by created_at, id`,
      [feishuUserId, period],
    )
  ).rows.map((row) => row.data);
  const logs = (
    await client.query<{ data: ProxyRequestLog }>(
      `select data from proxy_request_logs
       where feishu_user_id = $1 and billing_period = $2
       order by created_at, id`,
      [feishuUserId, period],
    )
  ).rows.map((row) => row.data);
  const usageRecords = (
    await client.query<{ data: NewApiUsageRecord }>(
      `select data from newapi_usage_records
       where feishu_user_id = $1 and billing_period = $2
       order by coalesce(newapi_created_at, last_synced_at), id`,
      [feishuUserId, period],
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

  }

  const proxyLogIdsBackedByNewApiRecords = new Set<string>();
  for (const record of usageRecords) {
    if (!isAuthoritativeUsageRecord(record)) continue;
    if (record.matchStatus === "matched" && record.matchedProxyLogId) {
      proxyLogIdsBackedByNewApiRecords.add(record.matchedProxyLogId);
    }
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
  const quotaPerUnit = getConfig().newapi.quotaPerUnit;
  const assignedMonthlyQuota = policy?.assignedMonthlyQuota ?? 0;
  const authoritativeConsumedQuota = usageRecords
    .filter(
      (record) =>
        isAuthoritativeUsageRecord(record) && usageRecordPeriod(record) === period,
    )
    .reduce(
      (total, record) => total + authoritativeQuotaFromRecord(record, quotaPerUnit),
      0,
    );
  const materialized = materializeUserQuota({
    assignedMonthlyQuota,
    authoritativeConsumedQuota,
    ledgerEntries,
  });

  summary.monthlyQuota = assignedMonthlyQuota / quotaPerUnit;
  summary.quotaConsumed = authoritativeConsumedQuota / quotaPerUnit;
  summary.cost = authoritativeConsumedQuota / quotaPerUnit;
  summary.remainingQuota = materialized.expectedAvailableQuota / quotaPerUnit;
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
  const result = await withSettlementTransaction((client) =>
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
       and state not in ('completed', 'compensated', 'cancelled')`,
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

export type PostgresMonthlyPeriodOpenCandidate = {
  feishuUserId: string;
  departmentId?: string;
  assignedMonthlyQuota: number;
  activeTokenCount: number;
  isGlobalAdmin: boolean;
  alreadyOpened: boolean;
};

type PostgresMonthlyPeriodOpenSnapshotRow = {
  candidates: PostgresMonthlyPeriodOpenCandidate[];
  department_quota_periods: Array<{
    departmentId: string;
    period: string;
    quotaLimit: number;
  }>;
  quota_operations: Array<{
    id: string;
    feishuUserId: string;
    departmentId?: string;
  }>;
};

/**
 * Loads only the control facts needed to plan one package reset. NewAPI usage
 * is read authoritatively by each quota operation after the Key is frozen.
 */
export async function getPostgresMonthlyPeriodOpenSnapshot(period: string) {
  return withControlClient(async (client) => {
    const result = await client.query<PostgresMonthlyPeriodOpenSnapshotRow>(
      `with latest_policy as materialized (
         select distinct on (policy.feishu_user_id)
           policy.feishu_user_id,
           policy.department_id,
           coalesce((policy.data->>'assignedMonthlyQuota')::bigint, 0) as assigned_monthly_quota
         from user_quota_policies policy
         where policy.effective_from_period <= $1
           and (
             policy.effective_to_period is null
             or policy.effective_to_period >= $1
           )
         order by policy.feishu_user_id, policy.version desc, policy.id desc
       ),
       eligible_users as materialized (
         select
           user_row.id as feishu_user_id,
           latest_policy.department_id,
           latest_policy.assigned_monthly_quota,
           (
             select count(*)::integer
             from token_accounts account
             where account.feishu_user_id = user_row.id
               and account.status = 'active'
           ) as active_token_count,
           (
             user_row.open_id = any($2::text[])
             or exists (
               select 1
               from admin_scopes scope
               where scope.feishu_user_id = user_row.id
                 and scope.scope_type = 'global'
                 and scope.status = 'active'
             )
           ) as is_global_admin,
           exists (
             select 1
             from quota_ledger_entries entry
             where entry.feishu_user_id = user_row.id
               and entry.period = $1
               and entry.entry_type = 'period_open_authorization'
           ) as already_opened
         from latest_policy
         join feishu_users user_row
           on user_row.id = latest_policy.feishu_user_id
         where coalesce(user_row.data->>'status', 'active') = 'active'
       )
       select
         coalesce(
           (
             select jsonb_agg(
               jsonb_strip_nulls(jsonb_build_object(
                 'feishuUserId', eligible.feishu_user_id,
                 'departmentId', eligible.department_id,
                 'assignedMonthlyQuota', eligible.assigned_monthly_quota,
                 'activeTokenCount', eligible.active_token_count,
                 'isGlobalAdmin', eligible.is_global_admin,
                 'alreadyOpened', eligible.already_opened
               ))
               order by eligible.feishu_user_id
             )
             from eligible_users eligible
           ),
           '[]'::jsonb
         ) as candidates,
         coalesce(
           (
             select jsonb_agg(
               jsonb_build_object(
                 'departmentId', quota_period.department_id,
                 'period', quota_period.period,
                 'quotaLimit', coalesce((quota_period.data->>'quotaLimit')::numeric, 0)
               )
               order by quota_period.department_id, quota_period.id
             )
             from department_quota_periods quota_period
             where quota_period.period = $1
           ),
           '[]'::jsonb
         ) as department_quota_periods,
         coalesce(
           (
             select jsonb_agg(
               jsonb_strip_nulls(jsonb_build_object(
                 'id', operation.id,
                 'feishuUserId', operation.feishu_user_id,
                 'departmentId', operation.department_id
               ))
               order by operation.created_at, operation.id
             )
             from quota_operations operation
             where operation.state not in ('completed', 'compensated', 'cancelled')
           ),
           '[]'::jsonb
         ) as quota_operations`,
      [period, getConfig().admin.systemAdminOpenIds],
    );
    const row = result.rows[0];
    return {
      candidates: row?.candidates ?? [],
      departmentQuotaPeriods: row?.department_quota_periods ?? [],
      quotaOperations: row?.quota_operations ?? [],
    };
  });
}

export async function readPostgresStore(): Promise<StoreShape> {
  const client = await getPool().connect();
  try {
    return {
      version: 1,
      settings: await readSettingsRow(client),
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
      userBillingPeriods: [],
      departmentQuotaPeriods: await readDataRows<DepartmentQuotaPeriod>(
        client,
        "department_quota_periods",
        "period, department_id, id",
      ),
      departmentQuotaRequests: [],
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
      proxyRequestLogs: [],
      newapiUsageRecords: [],
      usageSyncCheckpoints: [],
      usageSyncIssues: [],
      adminScopes: await readDataRows<AdminScope>(client, "admin_scopes", "created_at, id"),
    };
  } finally {
    client.release();
  }
}

export async function preparePostgresPackageResetPeriod(period: string) {
  return withControlTransaction(async (client) => {
    const settingsResult = await client.query<{
      data: AppSettings;
      current_time: Date | string;
    }>(
      `select data, statement_timestamp() as current_time
       from app_settings
       where id = 'default'
       for share`,
    );
    const settingsRow = settingsResult.rows[0];
    const currentTime =
      settingsRow?.current_time instanceof Date
        ? settingsRow.current_time
        : new Date(settingsRow?.current_time ?? Date.now());
    assertPackageResetExecutionAllowed({
      policy: settingsRow?.data.packageReset,
      period,
      now: currentTime,
    });

    const departments = await client.query<{
      department_id: string;
      department_name: string | null;
      assigned_quota: string;
    }>(
      `with assigned as materialized (
         select policy.department_id,
                max(nullif(user_row.data->>'departmentName', '')) as department_name,
                coalesce(sum((policy.data->>'assignedMonthlyQuota')::numeric), 0)::text
                  as assigned_quota
         from feishu_users user_row
         join lateral (
           select quota_policy.department_id, quota_policy.data
           from user_quota_policies quota_policy
           where quota_policy.feishu_user_id = user_row.id
             and quota_policy.effective_from_period <= $1
             and (
               quota_policy.effective_to_period is null
               or quota_policy.effective_to_period >= $1
             )
           order by quota_policy.version desc, quota_policy.id desc
           limit 1
         ) policy on true
         where coalesce(nullif(user_row.data->>'status', ''), 'active') = 'active'
           and policy.department_id is not null
         group by policy.department_id
       ), known as materialized (
         select distinct on (quota_period.department_id)
                quota_period.department_id,
                nullif(quota_period.data->>'departmentName', '') as department_name
         from department_quota_periods quota_period
         where quota_period.period < $1
         order by quota_period.department_id, quota_period.period desc, quota_period.id desc
       )
       select coalesce(assigned.department_id, known.department_id) as department_id,
              coalesce(assigned.department_name, known.department_name) as department_name,
              coalesce(assigned.assigned_quota, '0')::text as assigned_quota
       from assigned
       full join known on known.department_id = assigned.department_id
       order by coalesce(assigned.department_id, known.department_id)`,
      [period],
    );

    const created: DepartmentQuotaPeriod[] = [];
    for (const department of departments.rows) {
      await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
        `department-quota:${department.department_id}:${period}`,
      ]);
      const existing = await client.query<{ data: DepartmentQuotaPeriod }>(
        `select data
         from department_quota_periods
         where department_id = $1 and period = $2
         for update`,
        [department.department_id, period],
      );
      if (existing.rows[0]) continue;

      const previous = await client.query<{ data: DepartmentQuotaPeriod }>(
        `select data
         from department_quota_periods
         where department_id = $1 and period < $2
         order by period desc, id desc
         limit 1
         for share`,
        [department.department_id, period],
      );
      const assignedUnits = Math.ceil(
        Math.max(Number(department.assigned_quota), 0) /
          getConfig().newapi.quotaPerUnit,
      );
      const previousPolicy = previous.rows[0]?.data;
      const now = currentTime.toISOString();
      created.push(
        await saveDepartmentQuotaPeriodRow(client, {
          id: randomId("dqp"),
          departmentId: department.department_id,
          departmentName:
            previousPolicy?.departmentName ?? department.department_name ?? undefined,
          period,
          quotaLimit:
            previousPolicy?.quotaLimit ?? initialDepartmentQuotaLimit(assignedUnits),
          defaultGrantQuota:
            previousPolicy?.defaultGrantQuota ??
            settingsRow?.data.defaultMonthlyQuota ??
            200,
          createdAt: now,
          updatedAt: now,
          updatedByFeishuUserId: PACKAGE_RESET_SYSTEM_ACTOR,
        }),
      );
    }
    return created;
  });
}

export async function getPostgresAppSettings() {
  return withControlClient((client) => readSettingsRow(client));
}

export async function getPostgresNewApiRuntimeBindingSnapshot() {
  return withControlClient(async (client) => {
    const result = await client.query<{ settings: AppSettings }>(
      `select data as settings
       from app_settings
       where id = 'default'
       limit 1`,
    );
    return {
      settings: result.rows[0]?.settings ?? { defaultMonthlyQuota: 200 },
    };
  });
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
 * Enumerates the durable user-period obligations implied by authoritative NewAPI
 * source facts. The JSON record owns the billing-period snapshot; legacy rows
 * without it fall back to the NewAPI occurrence month in Hong Kong time.
 */
export async function listPostgresAuthoritativeUsageBillingMaterializationTargets() {
  return withClient(async (client) => {
    const result = await client.query<PostgresBillingMaterializationTarget>(
      `with authoritative_targets as (
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
         where match_status in ('matched', 'no_proxy_match')
           and feishu_user_id is not null
           and token_account_id is not null
       )
       select distinct "feishuUserId", "billingPeriod"
       from authoritative_targets
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
      [{ defaultMonthlyQuota: 200 }],
    );
    const settingsResult = await client.query<{ data: AppSettings }>(
      "select data from app_settings where id = 'default' for update",
    );
    const settings = settingsResult.rows[0]?.data ?? { defaultMonthlyQuota: 200 };
    const before = JSON.stringify(settings);
    const result = await fn(settings);
    // Deduplicated enqueue, failed claims and lease CAS misses are reads, not
    // writes. Avoid rewriting the single settings row when the mutation did
    // not change it; this removes needless row/WAL contention.
    if (JSON.stringify(settings) !== before) await saveSettingsRow(client, settings);
    return result;
  });
}

export async function updatePostgresAppSettingsAsActor(input: {
  actorFeishuUserId: string;
  defaultMonthlyQuota?: number;
  newapiControl?: AppSettings["newapiControl"];
  packageReset?: AppSettings["packageReset"];
}) {
  return withControlTransaction(async (client) => {
    await lockAdminScopeUsersInTransaction(client, [input.actorFeishuUserId]);
    const actorScope = await resolvePostgresActorScopeInTransaction(
      client,
      input.actorFeishuUserId,
    );
    if (!actorScope || actorScope.scopeType !== "global") {
      throw new AdminUserActionAuthorizationError(
        "actor_scope_missing",
        403,
        "当前全局管理员权限已变化，请刷新后重试",
      );
    }
    if (
      input.newapiControl &&
      !(actorScope.source === "environment" && actorScope.role === "root")
    ) {
      throw new AdminUserActionAuthorizationError(
        "root_required",
        403,
        "NewAPI 上游连接只能由 root 管理员修改",
      );
    }
    await client.query(
      `insert into app_settings (id, data)
       values ('default', $1)
       on conflict (id) do nothing`,
      [{ defaultMonthlyQuota: 200 }],
    );
    const result = await client.query<{ data: AppSettings }>(
      "select data from app_settings where id = 'default' for update",
    );
    const current = result.rows[0]?.data ?? { defaultMonthlyQuota: 200 };
    const now = nowIso();
    let newapiControl = current.newapiControl;
    if (input.newapiControl) {
      const accessTokenCiphertext =
        input.newapiControl.accessTokenCiphertext ??
        current.newapiControl?.accessTokenCiphertext;
      if (!accessTokenCiphertext) {
        const error = new Error("首次保存 NewAPI 上游连接时必须填写用户 AK");
        error.name = "NewApiControlSecretRequiredError";
        throw error;
      }
      newapiControl = {
        ...input.newapiControl,
        accessTokenCiphertext,
        updatedAt: now,
        updatedByFeishuUserId: input.actorFeishuUserId,
      };
    }
    const settings: AppSettings = {
      ...current,
      defaultMonthlyQuota:
        input.defaultMonthlyQuota ?? current.defaultMonthlyQuota,
      newapiControl,
      packageReset: input.packageReset
        ? normalizePackageResetPolicy({
            ...input.packageReset,
            updatedAt: now,
            updatedByFeishuUserId: input.actorFeishuUserId,
          })
        : normalizePackageResetPolicy(current.packageReset),
      updatedAt: now,
      updatedByFeishuUserId: input.actorFeishuUserId,
    };
    return saveSettingsRow(client, settings);
  });
}

export async function getPostgresEarliestOpenBlockingUsageIssue() {
  return withControlClient(async (client) => {
    const result = await client.query<{ data: UsageSyncIssue }>(
      `select data
       from usage_sync_issues
       where status = 'open'
         and coalesce(nullif(data->>'blocksSettlement', '')::boolean, false)
       order by coalesce(
         nullif(data->>'occurredAt', '')::timestamptz,
         first_seen_at
       ), id
       limit 1`,
    );
    return result.rows[0]?.data ?? null;
  });
}

export async function enqueuePostgresBillingOperation(
  operation: BillingOperationRecord,
  options: { requireRootActor?: boolean } = {},
) {
  return withControlTransaction(async (client) => {
    if (options.requireRootActor) {
      await lockAdminScopeUsersInTransaction(client, [
        operation.operatedByFeishuUserId,
      ]);
      const actorScope = await resolvePostgresActorScopeInTransaction(
        client,
        operation.operatedByFeishuUserId,
      );
      if (
        !actorScope ||
        actorScope.scopeType !== "global" ||
        actorScope.source !== "environment" ||
        actorScope.role !== "root"
      ) {
        throw new AdminUserActionAuthorizationError(
          "root_required",
          403,
          "该维护操作仅允许 root 执行",
        );
      }
    }
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `billing-operation-kind:${operation.kind}`,
    ]);
    const existing = await client.query<PostgresBillingOperationRow>(
      `select ${billingOperationColumns}
       from billing_operations
       where kind = $1
         and status in ('pending', 'running')
       order by created_at desc, id desc
       limit 1
       for update`,
      [operation.kind],
    );
    if (existing.rows[0]) {
      return {
        operation: billingOperationFromRow(existing.rows[0]),
        created: false,
      };
    }
    return {
      operation: await insertPostgresBillingOperationRow(client, operation),
      created: true,
    };
  });
}

async function assertPostgresDepartmentMemberSyncScope(
  client: PoolClient,
  input: { actorFeishuUserId: string; departmentId: string },
) {
  await lockAdminScopeUsersInTransaction(client, [input.actorFeishuUserId]);
  const actorResult = await client.query<{ data: FeishuUser }>(
    "select data from feishu_users where id = $1 for share",
    [input.actorFeishuUserId],
  );
  const actor = actorResult.rows[0]?.data;
  const actorScope = actor
    ? await resolvePostgresActorScopeInTransaction(client, input.actorFeishuUserId)
    : null;
  if (!actor || actor.status !== "active" || !actorScope) {
    throw new AdminUserActionAuthorizationError(
      "actor_scope_missing",
      403,
      "当前管理员用户或管理范围已变化，同步任务已安全停止",
    );
  }
  if (
    actorScope.scopeType === "department" &&
    actorScope.departmentId !== input.departmentId
  ) {
    throw new AdminUserActionAuthorizationError(
      "target_out_of_scope",
      403,
      "当前管理员已无权同步该部门",
    );
  }
  const departmentResult = await client.query<{ present: boolean }>(
    `select exists (
       select 1 from feishu_users where department_id = $1
       union all
       select 1 from department_quota_periods where department_id = $1
     ) as present`,
    [input.departmentId],
  );
  if (!departmentResult.rows[0]?.present) {
    throw new AdminUserActionAuthorizationError(
      "target_out_of_scope",
      403,
      "目标部门已不存在或不在 TokenInside 管理范围内",
    );
  }
  return { actor, actorScope };
}

export async function enqueuePostgresDepartmentMemberSyncOperationAsActor(
  operation: BillingOperationRecord,
) {
  const departmentId = String(operation.input?.departmentId ?? "");
  if (operation.kind !== "department_member_sync" || !departmentId) {
    throw new Error("部门成员同步任务缺少有效部门 ID");
  }
  return withControlTransaction(async (client) => {
    await assertPostgresDepartmentMemberSyncScope(client, {
      actorFeishuUserId: operation.operatedByFeishuUserId,
      departmentId,
    });
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `department-directory:${departmentId}`,
    ]);
    const existing = await client.query<PostgresBillingOperationRow>(
      `select ${billingOperationColumns}
       from billing_operations
       where kind = 'department_member_sync'
         and input->>'departmentId' = $1
         and status in ('pending', 'running')
       order by created_at desc, id desc
       limit 1
       for update`,
      [departmentId],
    );
    if (existing.rows[0]) {
      return {
        operation: billingOperationFromRow(existing.rows[0]),
        created: false,
      };
    }
    return {
      operation: await insertPostgresBillingOperationRow(client, operation),
      created: true,
    };
  });
}

async function getAuthorizedRunningDepartmentMemberSyncOperation(
  client: PoolClient,
  input: { operationId: string; leaseId: string },
) {
  // Lock order is deliberately actor -> department -> operation everywhere.
  // Read immutable identity without a row lock first so an enqueue transaction
  // can never hold the actor lock while this worker holds the operation row.
  const identityResult = await client.query<PostgresBillingOperationRow>(
    `select ${billingOperationColumns}
     from billing_operations
     where id = $1
       and kind = 'department_member_sync'
       and status = 'running'
       and lease_id = $2
       and lease_expires_at > statement_timestamp()`,
    [input.operationId, input.leaseId],
  );
  const identity = identityResult.rows[0]
    ? billingOperationFromRow(identityResult.rows[0])
    : null;
  const departmentId = String(identity?.input?.departmentId ?? "");
  if (!identity || !departmentId) {
    throw new Error(`department member sync lease lost: ${input.operationId}`);
  }
  await assertPostgresDepartmentMemberSyncScope(client, {
    actorFeishuUserId: identity.operatedByFeishuUserId,
    departmentId,
  });
  await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
    `department-directory:${departmentId}`,
  ]);
  const lockedResult = await client.query<PostgresBillingOperationRow>(
    `select ${billingOperationColumns}
     from billing_operations
     where id = $1
       and kind = 'department_member_sync'
       and status = 'running'
       and lease_id = $2
       and lease_expires_at > statement_timestamp()
     for update`,
    [input.operationId, input.leaseId],
  );
  const operation = lockedResult.rows[0]
    ? billingOperationFromRow(lockedResult.rows[0])
    : null;
  if (
    !operation ||
    operation.operatedByFeishuUserId !== identity.operatedByFeishuUserId ||
    operation.input?.departmentId !== departmentId
  ) {
    throw new Error(`department member sync lease lost: ${input.operationId}`);
  }
  return { operation, departmentId };
}

export async function assertPostgresDepartmentMemberSyncExecutionAuthorized(input: {
  operationId: string;
  leaseId: string;
}) {
  return withControlTransaction((client) =>
    getAuthorizedRunningDepartmentMemberSyncOperation(client, input),
  );
}

export async function batchUpsertPostgresDepartmentMembersForSync(input: {
  operationId: string;
  leaseId: string;
  tenantKey: string;
  departmentName?: string;
  contacts: Array<{
    id: string;
    openId: string;
    unionId?: string;
    feishuUserIdFromFeishu?: string;
    name?: string;
    avatarUrl?: string;
  }>;
  now: string;
}) {
  if (input.contacts.length === 0) return { synced: 0, skipped: 0 };
  if (input.contacts.length > 50) {
    throw new Error("单批部门成员导入不得超过 50 人");
  }
  return withControlTransaction(async (client) => {
    const { departmentId } = await getAuthorizedRunningDepartmentMemberSyncOperation(
      client,
      input,
    );
    const openIds = [...new Set(input.contacts.map((contact) => contact.openId))];
    const userLockKeys = openIds
      .map((openId) => `feishu_user:${input.tenantKey}:${openId}`)
      .sort();
    // Match the OAuth/upsertFeishuUser fence exactly. One ordered SQL statement
    // acquires the whole page without 50 control round trips and prevents an
    // absent-row snapshot from overwriting a concurrent disable/delete state.
    await client.query(lockDepartmentMemberSyncUsersSql, [userLockKeys]);
    const existingResult = await client.query<{ data: FeishuUser }>(
      `select data
       from feishu_users
       where tenant_key = $1 and open_id = any($2::text[])
       for update`,
      [input.tenantKey, openIds],
    );
    const existingByOpenId = new Map(
      existingResult.rows.map((row) => [row.data.openId, row.data]),
    );
    const rows: Array<{
      id: string;
      tenantKey: string;
      openId: string;
      departmentId: string;
      data: FeishuUser;
      createdAt: string;
      updatedAt: string;
    }> = [];
    let skipped = 0;
    for (const contact of input.contacts) {
      const existing = existingByOpenId.get(contact.openId);
      if (existing?.departmentId && existing.departmentId !== departmentId) {
        skipped += 1;
        continue;
      }
      const user: FeishuUser = existing
        ? {
            ...existing,
            unionId: contact.unionId ?? existing.unionId,
            feishuUserIdFromFeishu:
              contact.feishuUserIdFromFeishu ?? existing.feishuUserIdFromFeishu,
            name: contact.name ?? existing.name,
            avatarUrl: contact.avatarUrl ?? existing.avatarUrl,
            departmentId,
            departmentName: input.departmentName ?? existing.departmentName,
            updatedAt: input.now,
          }
        : {
            id: contact.id,
            tenantKey: input.tenantKey,
            openId: contact.openId,
            unionId: contact.unionId,
            feishuUserIdFromFeishu: contact.feishuUserIdFromFeishu,
            name: contact.name,
            avatarUrl: contact.avatarUrl,
            departmentId,
            departmentName: input.departmentName,
            status: "active",
            createdAt: input.now,
            updatedAt: input.now,
          };
      rows.push({
        id: user.id,
        tenantKey: user.tenantKey,
        openId: user.openId,
        departmentId,
        data: user,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      });
    }
    if (rows.length === 0) return { synced: 0, skipped };
    const stored = await client.query<{ id: string }>(
      upsertDepartmentMembersSql,
      [
        JSON.stringify(
          rows.map((row) => ({
            id: row.id,
            tenant_key: row.tenantKey,
            open_id: row.openId,
            department_id: row.departmentId,
            data: row.data,
            created_at: row.createdAt,
            updated_at: row.updatedAt,
          })),
        ),
      ],
    );
    return {
      synced: stored.rowCount ?? 0,
      skipped: skipped + rows.length - (stored.rowCount ?? 0),
    };
  });
}

export async function listPostgresDepartmentMemberSyncOperations(input: {
  departmentId?: string;
  limit?: number;
}) {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), 100);
  return withControlClient(async (client) => {
    const result = await client.query<PostgresBillingOperationRow>(
      `select ${billingOperationColumns}
       from billing_operations
       where kind = 'department_member_sync'
         and ($1::text is null or input->>'departmentId' = $1)
       order by updated_at desc, id desc
       limit $2`,
      [input.departmentId ?? null, limit],
    );
    return result.rows.map(billingOperationFromRow);
  });
}

export async function findPostgresBillingOperationById(operationId: string) {
  return withControlClient(async (client) => {
    const result = await client.query<PostgresBillingOperationRow>(
      `select ${billingOperationColumns}
       from billing_operations
       where id = $1
       limit 1`,
      [operationId],
    );
    return result.rows[0] ? billingOperationFromRow(result.rows[0]) : null;
  });
}

export async function listPostgresRunnableBillingOperations(input: {
  kind: BillingOperationKind;
  limit?: number;
  now: string;
}) {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 1), 0), 1_000);
  if (limit === 0) return [];
  return withControlClient(async (client) => {
    const result = await client.query<PostgresBillingOperationRow>(
      `select ${billingOperationColumns}
       from billing_operations
       where kind = $1
         and (
           status = 'pending'
           or (
             status = 'running'
             and lease_expires_at <= $2::timestamptz
           )
         )
       order by
         case when status = 'pending' then 0 else 1 end,
         coalesce(lease_expires_at, created_at),
         created_at,
         id
       limit $3`,
      [input.kind, input.now, limit],
    );
    return result.rows.map(billingOperationFromRow);
  });
}

export async function claimPostgresBillingOperationExecution(input: {
  operationId: string;
  kind: BillingOperationKind;
  leaseId: string;
  leaseExpiresAt: string;
}) {
  return withControlTransaction(async (client) => {
    const result = await client.query<PostgresBillingOperationRow>(
      `update billing_operations set
         status = 'running',
         attempt_count = attempt_count + 1,
         lease_id = $3,
         lease_expires_at = $4::timestamptz,
         started_at = coalesce(started_at, statement_timestamp()),
         updated_at = statement_timestamp()
       where id = $1
         and kind = $2
         and $4::timestamptz > statement_timestamp()
         and (
           status = 'pending'
           or (
             status = 'running'
             and lease_expires_at <= statement_timestamp()
           )
         )
       returning ${billingOperationColumns}`,
      [input.operationId, input.kind, input.leaseId, input.leaseExpiresAt],
    );
    return result.rows[0] ? billingOperationFromRow(result.rows[0]) : null;
  });
}

export async function renewPostgresBillingOperationExecution(input: {
  operationId: string;
  leaseId: string;
  leaseExpiresAt: string;
}) {
  return withControlTransaction(async (client) => {
    const result = await client.query<PostgresBillingOperationRow>(
      `update billing_operations set
         lease_expires_at = $3::timestamptz,
         updated_at = statement_timestamp()
       where id = $1
         and status = 'running'
         and lease_id = $2
         and lease_expires_at > statement_timestamp()
         and $3::timestamptz > lease_expires_at
       returning ${billingOperationColumns}`,
      [input.operationId, input.leaseId, input.leaseExpiresAt],
    );
    return result.rows[0] ? billingOperationFromRow(result.rows[0]) : null;
  });
}

export async function recordPostgresBillingOperation(input: {
  id?: string;
  expectedLeaseId?: string;
  kind: BillingOperationKind;
  status: BillingOperationStatus;
  dryRun: boolean;
  operatedByFeishuUserId: string;
  period?: string;
  input?: Record<string, unknown>;
  summary: BillingOperationRecord["summary"];
  errorMessage?: string;
}) {
  return withControlTransaction(async (client) => {
    if (Boolean(input.id) !== Boolean(input.expectedLeaseId)) {
      throw new Error("billing operation completion requires both id and lease");
    }
    if (!isTerminalBillingOperationStatus(input.status)) {
      throw new Error("billing operation records require a terminal status");
    }
    const existingResult = input.id
      ? await client.query<PostgresBillingOperationRow>(
          `select ${billingOperationColumns}
           from billing_operations
           where id = $1
             and (
               $2::text is null
               or (
                 status = 'running'
                 and lease_id = $2
                 and lease_expires_at > statement_timestamp()
               )
             )
           for update`,
          [input.id, input.expectedLeaseId ?? null],
        )
      : null;
    const existing = existingResult?.rows[0]
      ? billingOperationFromRow(existingResult.rows[0])
      : undefined;
    if (input.expectedLeaseId && !existing) {
      throw new Error(`billing operation lease lost: ${input.id ?? "unknown"}`);
    }

    const now = nowIso();
    const operation: BillingOperationRecord = {
      ...(existing ?? input),
      status: input.status,
      summary: input.summary,
      errorMessage: input.errorMessage,
      id: input.id ?? existing?.id ?? randomId("bo"),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      attemptCount: existing?.attemptCount,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      startedAt: existing?.startedAt,
      completedAt: now,
    };
    const stored = input.expectedLeaseId
      ? await updatePostgresBillingOperationRowWithLease(
          client,
          operation,
          input.expectedLeaseId,
        )
      : await insertPostgresBillingOperationRow(client, operation);
    if (!stored) {
      throw new Error(`billing operation lease lost: ${input.id ?? "unknown"}`);
    }
    return stored;
  });
}

export async function listPostgresBillingOperations(limit = 20) {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 0), 10_000);
  if (boundedLimit === 0) return [];
  return withControlClient(async (client) => {
    const result = await client.query<PostgresBillingOperationRow>(
      `select ${billingOperationColumns}
       from billing_operations
       order by updated_at desc, id desc
       limit $1`,
      [boundedLimit],
    );
    return result.rows.map(billingOperationFromRow);
  });
}

export async function upsertPostgresUserQuotaPolicy(policy: UserQuotaPolicy) {
  return withControlTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `user-quota:${policy.feishuUserId}`,
    ]);
    return saveUserQuotaPolicyRow(client, policy);
  });
}

export async function createPostgresUserQuotaPolicyVersion(input: {
  feishuUserId: string;
  assignedMonthlyQuota: number;
  departmentId?: string;
  effectiveFromPeriod: string;
  sourceType: UserQuotaPolicy["sourceType"];
  sourceId: string;
  quotaPerUnitSnapshot: number;
  updatedByOpenId?: string;
}) {
  return withControlTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `user-quota:${input.feishuUserId}`,
    ]);

    const idempotent = await client.query<{ data: UserQuotaPolicy }>(
      `select data
       from user_quota_policies
       where source_type = $1 and source_id = $2
       limit 1`,
      [input.sourceType, input.sourceId],
    );
    if (idempotent.rows[0]) return idempotent.rows[0].data;

    // The advisory lock covers the first version, while the latest row lock is
    // a concrete database fence for every subsequent version. Version
    // allocation therefore stays local to this user and this short control
    // transaction instead of reading the complete application store.
    const previous = await client.query<{ version: number }>(
      `select version
       from user_quota_policies
       where feishu_user_id = $1
       order by version desc, id desc
       limit 1
       for update`,
      [input.feishuUserId],
    );
    const now = nowIso();
    const policy: UserQuotaPolicy = {
      id: randomId("uqp"),
      feishuUserId: input.feishuUserId,
      assignedMonthlyQuota: Math.max(Math.trunc(input.assignedMonthlyQuota), 0),
      departmentId: input.departmentId,
      effectiveFromPeriod: input.effectiveFromPeriod,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      version: (previous.rows[0]?.version ?? 0) + 1,
      quotaPerUnitSnapshot: input.quotaPerUnitSnapshot,
      createdAt: now,
      updatedAt: now,
      updatedByOpenId: input.updatedByOpenId,
    };
    const inserted = await client.query<{ data: UserQuotaPolicy }>(
      `insert into user_quota_policies
        (id, feishu_user_id, department_id, effective_from_period, effective_to_period,
         version, source_type, source_id, data, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (source_type, source_id) do nothing
       returning data`,
      [
        policy.id,
        policy.feishuUserId,
        policy.departmentId ?? null,
        policy.effectiveFromPeriod,
        policy.effectiveToPeriod ?? null,
        policy.version,
        policy.sourceType,
        policy.sourceId,
        policy,
        policy.createdAt,
        policy.updatedAt,
      ],
    );
    if (inserted.rows[0]) return inserted.rows[0].data;

    // A source may race across different user advisory keys. The unique source
    // constraint chooses the winner; the loser returns that durable result and
    // preserves source-level idempotency without overwriting it.
    const concurrentlyInserted = await client.query<{ data: UserQuotaPolicy }>(
      `select data
       from user_quota_policies
       where source_type = $1 and source_id = $2
       limit 1`,
      [input.sourceType, input.sourceId],
    );
    if (!concurrentlyInserted.rows[0]) {
      throw new Error("quota policy source conflict did not resolve to a durable row");
    }
    return concurrentlyInserted.rows[0].data;
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

export async function listPostgresDueQuotaOperations(input: {
  now: string;
  limit?: number;
}) {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 0), 1_000);
  if (limit === 0) return [];
  return withControlClient(async (client) => {
    const result = await client.query<{ data: QuotaOperation }>(
      `select data
       from quota_operations
       where (
           state not in ('completed', 'compensated', 'cancelled', 'manual_review')
           or (
             state = 'manual_review'
             and operation_type = 'key_rotation'
             and data->>'lastErrorMessage' = 'NewAPI token 余额观测不稳定'
             and nullif(data->>'upstreamTokenIdAfter', '') is null
             and nullif(data->>'tokenAccountIdAfter', '') is null
           )
         )
         and (next_retry_at is null or next_retry_at <= $1::timestamptz)
         and (
           worker_lease_expires_at is null
           or worker_lease_expires_at <= statement_timestamp()
         )
       order by coalesce(next_retry_at, created_at), updated_at, id
       limit $2`,
      [input.now, limit],
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
    const user = await client.query<{ data: FeishuUser }>(
      "select data from feishu_users where id = $1 for share",
      [operation.feishuUserId],
    );
    if (
      !user.rows[0]?.data ||
      (user.rows[0].data.status && user.rows[0].data.status !== "active")
    ) {
      throw new Error("额度操作目标用户已禁用、删除或不存在");
    }
    const idempotent = await client.query<{ data: QuotaOperation }>(
      "select data from quota_operations where idempotency_key = $1",
      [operation.idempotencyKey],
    );
    if (idempotent.rows[0]) return idempotent.rows[0].data;
    const open = await client.query<{ data: QuotaOperation }>(
      `select data from quota_operations
       where feishu_user_id = $1
         and state not in ('completed', 'compensated', 'cancelled')
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

type PostgresMonthlyOpenResolvedRow = {
  feishu_user_id: string;
  billing_period: string;
  created_by_open_id: string | null;
  user_data: FeishuUser | null;
  policy_data: UserQuotaPolicy | null;
  policy_department_id: string | null;
  active_token_count: number;
  is_global_admin: boolean;
  already_opened: boolean;
  idempotent_operation: QuotaOperation | null;
  open_operation: QuotaOperation | null;
  active_generation: number | null;
  max_operation_generation: number;
};

class MonthlyOpenDepartmentLockBusyError extends Error {}

export async function createPostgresMonthlyOpenOperations(
  inputs: Array<{
    feishuUserId: string;
    departmentId?: string;
    billingPeriod: string;
    assignedMonthlyQuota: number;
    createdByOpenId?: string;
  }>,
  options: { executionSource?: "root" | "package_reset" } = {},
) {
  if (!inputs.length) return [];
  const uniqueInputs = [
    ...new Map(
      inputs.map((input) => [
        `${input.feishuUserId}\u0000${input.billingPeriod}`,
        input,
      ]),
    ).values(),
  ];
  const retryDelaysMs = [10, 25, 50, 100, 200];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withControlTransaction(async (client) => {
        if (options.executionSource === "package_reset") {
          if (
            uniqueInputs.some(
              (item) => item.createdByOpenId !== PACKAGE_RESET_SYSTEM_ACTOR,
            )
          ) {
            throw new Error("套餐重置自动任务的审计身份无效");
          }
          const automaticSettings = await client.query<{
            data: AppSettings;
            current_time: Date | string;
          }>(
            `select data, statement_timestamp() as current_time
             from app_settings
             where id = 'default'
             for share`,
          );
          const row = automaticSettings.rows[0];
          const currentTime =
            row?.current_time instanceof Date
              ? row.current_time
              : new Date(row?.current_time ?? Date.now());
          for (const period of new Set(uniqueInputs.map((item) => item.billingPeriod))) {
            assertPackageResetExecutionAllowed({
              policy: row?.data.packageReset,
              period,
              now: currentTime,
            });
          }
        } else {
          const creatorOpenIds = [
            ...new Set(uniqueInputs.map((item) => item.createdByOpenId).filter(Boolean)),
          ] as string[];
          if (
            creatorOpenIds.length !== 1 ||
            !getConfig().admin.systemAdminOpenIds.includes(creatorOpenIds[0])
          ) {
            throw new AdminUserActionAuthorizationError(
              "root_required",
              403,
              "套餐重置仅允许 root 执行",
            );
          }
          const actorCandidate = await client.query<{ id: string }>(
            "select id from feishu_users where open_id = $1 limit 1",
            [creatorOpenIds[0]],
          );
          const actorId = actorCandidate.rows[0]?.id;
          if (!actorId) {
            throw new AdminUserActionAuthorizationError(
              "root_required",
              403,
              "套餐重置 root 用户不存在或已失效",
            );
          }
          await lockAdminScopeUsersInTransaction(client, [actorId]);
          const actor = await client.query<{ data: FeishuUser }>(
            "select data from feishu_users where id = $1 for update",
            [actorId],
          );
          if (
            !actor.rows[0] ||
            actor.rows[0].data.openId !== creatorOpenIds[0] ||
            (actor.rows[0].data.status && actor.rows[0].data.status !== "active")
          ) {
            throw new AdminUserActionAuthorizationError(
              "root_required",
              403,
              "套餐重置 root 用户不存在或已失效",
            );
          }
        }
        // The plan supplies candidate identities only. Every business fact is
        // read again after the same short user lock used by policy/operation
        // creation, so a concurrent first provision or policy change wins
        // cleanly before this batch decides whether to enqueue.
        const userIds = [
          ...new Set(uniqueInputs.map((item) => item.feishuUserId)),
        ].sort();
        for (const feishuUserId of userIds) {
          await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
            `user-quota:${feishuUserId}`,
          ]);
        }
        // Stabilize existing manual global scopes. A concurrent insertion can
        // only turn a rejection into a later successful retry; revocation of a
        // scope observed below must wait for this transaction.
        await client.query(
          `select id
           from admin_scopes
           where feishu_user_id = any($1::text[])
             and status = 'active'
           order by feishu_user_id, id
           for share`,
          [userIds],
        );

        const requestedFacts = uniqueInputs.map((input) => ({
          feishu_user_id: input.feishuUserId,
          billing_period: input.billingPeriod,
          created_by_open_id: input.createdByOpenId ?? null,
        }));
        const resolvedResult = await client.query<PostgresMonthlyOpenResolvedRow>(
          `with requested as materialized (
             select request.feishu_user_id,
                    request.billing_period,
                    request.created_by_open_id
             from jsonb_to_recordset($1::jsonb) as request(
               feishu_user_id text,
               billing_period text,
               created_by_open_id text
             )
           )
           select
             request.feishu_user_id,
             request.billing_period,
             request.created_by_open_id,
             user_row.data as user_data,
             policy.data as policy_data,
             policy.department_id as policy_department_id,
             (
               select count(*)::integer
               from token_accounts account
               where account.feishu_user_id = request.feishu_user_id
                 and account.status = 'active'
             ) as active_token_count,
             (
               user_row.open_id = any($2::text[])
               or exists (
                 select 1
                 from admin_scopes scope
                 where scope.feishu_user_id = request.feishu_user_id
                   and scope.scope_type = 'global'
                   and scope.status = 'active'
               )
             ) as is_global_admin,
             exists (
               select 1
               from quota_ledger_entries entry
               where entry.feishu_user_id = request.feishu_user_id
                 and entry.period = request.billing_period
                 and entry.entry_type = 'period_open_authorization'
             ) as already_opened,
             (
               select operation.data
               from quota_operations operation
               where operation.idempotency_key =
                 'monthly-open:' || request.billing_period || ':' || request.feishu_user_id
               limit 1
             ) as idempotent_operation,
             (
               select operation.data
               from quota_operations operation
               where operation.feishu_user_id = request.feishu_user_id
                 and operation.state not in ('completed', 'compensated', 'cancelled')
               order by operation.created_at desc, operation.id desc
               limit 1
             ) as open_operation,
             (
               select state.active_generation
               from user_quota_states state
               where state.feishu_user_id = request.feishu_user_id
             ) as active_generation,
             (
               select coalesce(max(account.operation_generation), 0)::integer
               from token_accounts account
               where account.feishu_user_id = request.feishu_user_id
             ) as max_operation_generation
           from requested request
           left join feishu_users user_row
             on user_row.id = request.feishu_user_id
           left join lateral (
             select quota_policy.data, quota_policy.department_id
             from user_quota_policies quota_policy
             where quota_policy.feishu_user_id = request.feishu_user_id
               and quota_policy.effective_from_period <= request.billing_period
               and (
                 quota_policy.effective_to_period is null
                 or quota_policy.effective_to_period >= request.billing_period
               )
             order by quota_policy.version desc, quota_policy.id desc
             limit 1
           ) policy on true
           order by request.feishu_user_id, request.billing_period`,
          [JSON.stringify(requestedFacts), getConfig().admin.systemAdminOpenIds],
        );

        const operations: QuotaOperation[] = [];
        const resolvedInputs: Array<{
          feishuUserId: string;
          departmentId?: string;
          billingPeriod: string;
          assignedMonthlyQuota: number;
          createdByOpenId?: string;
          operationGeneration: number;
          reopenOperation?: QuotaOperation;
        }> = [];
        for (const row of resolvedResult.rows) {
          const idempotent = row.idempotent_operation;
          if (idempotent && idempotent.state !== "cancelled") {
            operations.push(idempotent);
            continue;
          }
          // A concurrent first provision may have committed this marker after
          // preflight. It is authoritative and makes this candidate a no-op.
          if (row.already_opened) continue;
          if (
            !row.user_data ||
            (row.user_data.status && row.user_data.status !== "active")
          ) {
            throw new Error(
              `月度开账用户已禁用、删除或不存在: ${row.feishu_user_id}`,
            );
          }
          if (!row.policy_data) {
            throw new Error(`月度开账用户缺少当前有效额度策略: ${row.feishu_user_id}`);
          }
          if (row.active_token_count > 1) {
            throw new Error(`月度开账用户存在多个 active Key: ${row.feishu_user_id}`);
          }
          if (!row.policy_department_id && !row.is_global_admin) {
            throw new Error(`月度开账用户缺少部门归属: ${row.feishu_user_id}`);
          }
          if (row.open_operation) {
            throw new Error(`用户已有未完成额度操作: ${row.open_operation.id}`);
          }
          if (
            idempotent &&
            !canReopenMonthlyOpenAfterAccessRevoke(idempotent)
          ) {
            throw new Error(
              `已取消的月度开账操作存在不安全副作用，禁止自动恢复: ${idempotent.id}`,
            );
          }
          const assignedMonthlyQuota = Number(row.policy_data.assignedMonthlyQuota);
          if (!Number.isSafeInteger(assignedMonthlyQuota) || assignedMonthlyQuota < 0) {
            throw new Error(`月度开账用户当前额度策略无效: ${row.feishu_user_id}`);
          }
          resolvedInputs.push({
            feishuUserId: row.feishu_user_id,
            departmentId: row.policy_department_id ?? undefined,
            billingPeriod: row.billing_period,
            assignedMonthlyQuota,
            createdByOpenId: row.created_by_open_id ?? undefined,
            operationGeneration:
              (row.active_generation ?? row.max_operation_generation ?? 0) + 1,
            reopenOperation: idempotent ?? undefined,
          });
        }
        if (!resolvedInputs.length) return operations;

        const departmentScopes = [
          ...new Map(
            resolvedInputs.flatMap((item) =>
              item.departmentId
                ? [
                    [
                      `${item.departmentId}\u0000${item.billingPeriod}`,
                      {
                        departmentId: item.departmentId,
                        billingPeriod: item.billingPeriod,
                      },
                    ] as const,
                  ]
                : [],
            ),
          ).values(),
        ].sort(
          (a, b) =>
            a.departmentId.localeCompare(b.departmentId) ||
            a.billingPeriod.localeCompare(b.billingPeriod),
        );
        for (const scope of departmentScopes) {
          const lock = await client.query<{ locked: boolean }>(
            "select pg_try_advisory_xact_lock(hashtext($1)::bigint) as locked",
            [`department-quota:${scope.departmentId}:${scope.billingPeriod}`],
          );
          if (!lock.rows[0]?.locked) {
            throw new MonthlyOpenDepartmentLockBusyError(
              `月度开账部门预算锁繁忙: ${scope.departmentId}:${scope.billingPeriod}`,
            );
          }
        }

        for (const scope of departmentScopes) {
          const { departmentId, billingPeriod: period } = scope;
          const requested = resolvedInputs
            .filter(
              (item) =>
                item.departmentId === departmentId && item.billingPeriod === period,
            )
            .reduce((sum, item) => sum + item.assignedMonthlyQuota, 0);
          if (requested === 0) continue;
          const policy = await client.query<{ data: DepartmentQuotaPeriod }>(
            `select data from department_quota_periods
             where department_id = $1 and period = $2
             for update`,
            [departmentId, period],
          );
          if (!policy.rows[0]) {
            throw new Error(`部门 ${departmentId} 缺少 ${period} 账期预算`);
          }
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
               and state not in ('completed', 'compensated', 'cancelled')`,
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

        for (const input of resolvedInputs) {
          const now = nowIso();
          if (input.reopenOperation) {
            const reopened = reopenMonthlyOpenAfterAccessRevoke(
              input.reopenOperation,
              {
                departmentId: input.departmentId,
                assignedMonthlyQuota: input.assignedMonthlyQuota,
                operationGeneration: input.operationGeneration,
                createdByOpenId: input.createdByOpenId,
                reopenedAt: now,
              },
            );
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
              throw new Error(`月度开账取消操作状态已变化，无法原子恢复: ${reopened.id}`);
            }
            operations.push(updated.rows[0].data);
            continue;
          }
          const operation: QuotaOperation = {
            id: randomId("qo"),
            operationType: "monthly_open",
            idempotencyKey: `monthly-open:${input.billingPeriod}:${input.feishuUserId}`,
            feishuUserId: input.feishuUserId,
            departmentId: input.departmentId,
            billingPeriod: input.billingPeriod,
            requestedAssignedQuota: input.assignedMonthlyQuota,
            reservedDepartmentQuota: input.departmentId
              ? input.assignedMonthlyQuota
              : 0,
            operationGeneration: input.operationGeneration,
            state: input.departmentId ? "budget_reserved" : "planned",
            attemptCount: 0,
            createdByOpenId: input.createdByOpenId,
            createdAt: now,
            updatedAt: now,
          };
          operations.push(await saveQuotaOperationRow(client, operation));
        }
        return operations;
      });
    } catch (error) {
      if (
        !(error instanceof MonthlyOpenDepartmentLockBusyError) ||
        attempt >= retryDelaysMs.length
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
    }
  }
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
        state === "completed" || state === "compensated" || state === "cancelled"
          ? nowIso()
          : patch.completedAt,
      updatedAt: patch.updatedAt ?? nowIso(),
    };
    return saveQuotaOperationRow(client, updated);
  });
}

export async function claimPostgresQuotaOperationExecution(input: {
  operationId: string;
  leaseId: string;
  leaseDurationMs: number;
}) {
  return withControlTransaction(async (client) => {
    const result = await client.query<{ data: QuotaOperation }>(
      `update quota_operations
       set worker_lease_id = $2,
           worker_lease_expires_at = statement_timestamp()
             + ($3::bigint * interval '1 millisecond'),
           data = data || jsonb_build_object(
             'workerLeaseId', $2::text,
             'workerLeaseExpiresAt', statement_timestamp()
               + ($3::bigint * interval '1 millisecond'),
             'updatedAt', statement_timestamp()
           ),
           updated_at = statement_timestamp()
       where id = $1
         and state not in ('completed', 'compensated', 'cancelled')
         and (
           worker_lease_id is null
           or worker_lease_id = $2
           or worker_lease_expires_at <= statement_timestamp()
         )
       returning data`,
      [input.operationId, input.leaseId, Math.max(Math.trunc(input.leaseDurationMs), 1)],
    );
    return result.rows[0]?.data ?? null;
  });
}

export async function renewPostgresQuotaOperationExecution(input: {
  operationId: string;
  leaseId: string;
  leaseDurationMs: number;
}) {
  return withControlTransaction(async (client) => {
    const result = await client.query<{ data: QuotaOperation }>(
      `update quota_operations
       set worker_lease_expires_at = statement_timestamp()
             + ($3::bigint * interval '1 millisecond'),
           data = data || jsonb_build_object(
             'workerLeaseExpiresAt', statement_timestamp()
               + ($3::bigint * interval '1 millisecond'),
             'updatedAt', statement_timestamp()
           ),
           updated_at = statement_timestamp()
       where id = $1
         and worker_lease_id = $2
         and state not in ('completed', 'compensated', 'cancelled')
         and worker_lease_expires_at > statement_timestamp()
       returning data`,
      [input.operationId, input.leaseId, Math.max(Math.trunc(input.leaseDurationMs), 1)],
    );
    return result.rows[0]?.data ?? null;
  });
}

export async function releasePostgresQuotaOperationExecution(input: {
  operationId: string;
  leaseId: string;
}) {
  return withControlTransaction(async (client) => {
    const result = await client.query<{ data: QuotaOperation }>(
      `update quota_operations
       set worker_lease_id = null,
           worker_lease_expires_at = null,
           data = (data - 'workerLeaseId' - 'workerLeaseExpiresAt') ||
             jsonb_build_object('updatedAt', statement_timestamp()),
           updated_at = statement_timestamp()
       where id = $1 and worker_lease_id = $2
       returning data`,
      [input.operationId, input.leaseId],
    );
    return result.rows[0]?.data ?? null;
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
    if (request.requestType === "quota_adjust") {
      await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
        `quota-adjust-request:${request.feishuUserId}`,
      ]);
      const existing = await client.query(
        `select 1
         from token_requests
         where feishu_user_id = $1
           and request_type = 'quota_adjust'
           and status = any($2::text[])
           and id <> $3
         limit 1`,
        [
          request.feishuUserId,
          [...openQuotaAdjustmentRequestStatuses],
          request.id,
        ],
      );
      if ((existing.rowCount ?? 0) > 0) {
        throw new PendingQuotaAdjustmentRequestError();
      }
    }
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
  return saveTokenRequestRow(client, updated);
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
    transitionPostgresTokenRequestWithClient(client, id, patch, allowedStatuses),
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

async function readPostgresDepartmentQuotaFacts(
  client: PoolClient,
  departmentId: string,
  period: string,
) {
  const result = await client.query<{
    allocated_quota: string;
    pending_reserved_quota: string;
    department_name: string | null;
  }>(
    `select
       coalesce((
         select sum(
           greatest(coalesce((policy.data->>'assignedMonthlyQuota')::numeric, 0), 0)
         ) / $3::numeric
         from feishu_users member
         join lateral (
           select quota_policy.data
           from user_quota_policies quota_policy
           where quota_policy.feishu_user_id = member.id
             and quota_policy.effective_from_period <= $2
             and (
               quota_policy.effective_to_period is null
               or quota_policy.effective_to_period >= $2
             )
           order by quota_policy.version desc, quota_policy.id desc
           limit 1
         ) policy on true
         where member.department_id = $1
           and coalesce(member.data->>'status', 'active') <> 'deleted'
       ), 0)::text as allocated_quota,
       coalesce((
         select sum(
           greatest(coalesce((operation.data->>'reservedDepartmentQuota')::numeric, 0), 0)
         ) / $3::numeric
         from quota_operations operation
         where operation.department_id = $1
           and operation.billing_period = $2
           and operation.state not in ('completed', 'compensated', 'cancelled')
       ), 0)::text as pending_reserved_quota,
       (
         select nullif(member.data->>'departmentName', '')
         from feishu_users member
         where member.department_id = $1
         order by member.updated_at desc, member.id
         limit 1
       ) as department_name`,
    [departmentId, period, getConfig().newapi.quotaPerUnit],
  );
  const row = result.rows[0];
  return {
    allocatedQuota: Number(row?.allocated_quota ?? 0),
    pendingReservedQuota: Number(row?.pending_reserved_quota ?? 0),
    departmentName: row?.department_name ?? undefined,
  };
}

async function readOrCreatePostgresDepartmentQuotaPeriod(
  client: PoolClient,
  input: {
    departmentId: string;
    departmentName?: string;
    period: string;
  },
) {
  const existing = await client.query<{ data: DepartmentQuotaPeriod }>(
    `select data from department_quota_periods
     where department_id = $1 and period = $2
     for update`,
    [input.departmentId, input.period],
  );
  if (existing.rows[0]?.data) return existing.rows[0].data;
  const [facts, settings] = await Promise.all([
    readPostgresDepartmentQuotaFacts(
      client,
      input.departmentId,
      input.period,
    ),
    readSettingsRow(client),
  ]);
  const now = nowIso();
  return saveDepartmentQuotaPeriodRow(client, {
    id: randomId("dqp"),
    departmentId: input.departmentId,
    departmentName: input.departmentName ?? facts.departmentName,
    period: input.period,
    quotaLimit: initialDepartmentQuotaLimit(facts.allocatedQuota),
    defaultGrantQuota: settings.defaultMonthlyQuota,
    createdAt: now,
    updatedAt: now,
  });
}

export async function updatePostgresDepartmentQuotaPolicyAsActor(input: {
  actorFeishuUserId: string;
  departmentId: string;
  departmentName?: string;
  period: string;
  quotaLimit?: number;
  defaultGrantQuota?: number;
}) {
  return withControlTransaction(async (client) => {
    await lockAdminScopeUsersInTransaction(client, [input.actorFeishuUserId]);
    const actorScope = await resolvePostgresActorScopeInTransaction(
      client,
      input.actorFeishuUserId,
    );
    if (!actorScope) {
      throw new AdminUserActionAuthorizationError(
        "actor_scope_missing",
        403,
        "当前管理员权限已变化，请刷新后重试",
      );
    }
    if (
      actorScope.scopeType === "department" &&
      actorScope.departmentId !== input.departmentId
    ) {
      throw new AdminUserActionAuthorizationError(
        "target_out_of_scope",
        403,
        "不能修改其他部门的额度设置",
      );
    }
    if (actorScope.scopeType === "department" && input.quotaLimit !== undefined) {
      throw new AdminUserActionAuthorizationError(
        "target_out_of_scope",
        403,
        "部门总额度上限只能由系统管理员直接设置",
      );
    }
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `department-quota:${input.departmentId}:${input.period}`,
    ]);
    const policy = await readOrCreatePostgresDepartmentQuotaPeriod(client, input);
    const facts = await readPostgresDepartmentQuotaFacts(
      client,
      input.departmentId,
      input.period,
    );
    if (input.quotaLimit !== undefined) {
      const error = validateDepartmentQuotaLimit(
        input.quotaLimit,
        facts.allocatedQuota + facts.pendingReservedQuota,
      );
      if (error) throw new Error(error);
    }
    if (
      input.defaultGrantQuota !== undefined &&
      (!Number.isInteger(input.defaultGrantQuota) ||
        input.defaultGrantQuota <= 0 ||
        input.defaultGrantQuota > 1_000_000)
    ) {
      throw new Error("部门默认发放额度必须是 1 到 1000000 之间的整数");
    }
    const now = nowIso();
    const updated = await saveDepartmentQuotaPeriodRow(client, {
      ...policy,
      departmentName: input.departmentName ?? policy.departmentName ?? facts.departmentName,
      quotaLimit: input.quotaLimit ?? policy.quotaLimit,
      defaultGrantQuota: input.defaultGrantQuota ?? policy.defaultGrantQuota,
      updatedAt: now,
      updatedByFeishuUserId: input.actorFeishuUserId,
    });
    if (input.quotaLimit !== undefined && input.quotaLimit !== policy.quotaLimit) {
      await saveQuotaChangeEventRow(client, {
        id: randomId("qce"),
        departmentId: input.departmentId,
        departmentName: updated.departmentName,
        period: input.period,
        operatedByFeishuUserId: input.actorFeishuUserId,
        kind: "department_limit_set",
        status: "applied",
        previousValue: policy.quotaLimit,
        nextValue: input.quotaLimit,
        delta: input.quotaLimit - policy.quotaLimit,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (
      input.defaultGrantQuota !== undefined &&
      input.defaultGrantQuota !== policy.defaultGrantQuota
    ) {
      await saveQuotaChangeEventRow(client, {
        id: randomId("qce"),
        departmentId: input.departmentId,
        departmentName: updated.departmentName,
        period: input.period,
        operatedByFeishuUserId: input.actorFeishuUserId,
        kind: "department_default_set",
        status: "applied",
        previousValue: policy.defaultGrantQuota,
        nextValue: input.defaultGrantQuota,
        delta: input.defaultGrantQuota - policy.defaultGrantQuota,
        createdAt: now,
        updatedAt: now,
      });
    }
    return updated;
  });
}

export async function createPostgresDepartmentQuotaRequestAsActor(input: {
  actorFeishuUserId: string;
  departmentId: string;
  departmentName?: string;
  period: string;
  action: DepartmentQuotaRequest["action"];
  reason: string;
  requestedQuotaLimit?: number;
  approvalTargetOpenId: string;
  approvalActionNonceHash: string;
}) {
  return withControlTransaction(async (client) => {
    await lockAdminScopeUsersInTransaction(client, [input.actorFeishuUserId]);
    const actorScope = await resolvePostgresActorScopeInTransaction(
      client,
      input.actorFeishuUserId,
    );
    if (
      !actorScope ||
      actorScope.scopeType !== "department" ||
      actorScope.departmentId !== input.departmentId
    ) {
      throw new AdminUserActionAuthorizationError(
        "target_out_of_scope",
        403,
        "当前部门管理员权限已变化，请刷新后重试",
      );
    }
    const actorResult = await client.query<{ data: FeishuUser }>(
      "select data from feishu_users where id = $1 for share",
      [input.actorFeishuUserId],
    );
    const actor = actorResult.rows[0]?.data;
    if (!actor || (actor.status && actor.status !== "active")) {
      throw new AdminUserActionAuthorizationError(
        "actor_scope_missing",
        403,
        "当前部门管理员用户已禁用或不存在",
      );
    }
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `department-quota:${input.departmentId}:${input.period}`,
    ]);
    const policy = await readOrCreatePostgresDepartmentQuotaPeriod(client, input);
    const duplicate = await client.query(
      `select 1 from department_quota_requests
       where department_id = $1
         and period = $2
         and status in ('pending_card_send', 'pending_card_approval', 'approval_card_send_failed')
       limit 1
       for update`,
      [input.departmentId, input.period],
    );
    if ((duplicate.rowCount ?? 0) > 0) {
      throw new Error("当前部门已有总额度申请正在处理");
    }
    if (input.action === "increase") {
      if (input.requestedQuotaLimit === undefined) {
        throw new Error("提高额度申请必须填写目标额度上限");
      }
      const facts = await readPostgresDepartmentQuotaFacts(
        client,
        input.departmentId,
        input.period,
      );
      const error = validateDepartmentQuotaLimit(
        input.requestedQuotaLimit,
        facts.allocatedQuota,
      );
      if (error) throw new Error(error);
      if (input.requestedQuotaLimit <= policy.quotaLimit) {
        throw new Error("提高额度申请必须大于当前部门额度上限");
      }
    }
    const now = nowIso();
    return saveDepartmentQuotaRequestRow(client, {
      id: randomId("dqr"),
      departmentId: input.departmentId,
      departmentName: input.departmentName ?? policy.departmentName,
      period: input.period,
      requesterFeishuUserId: actor.id,
      action: input.action,
      status: "pending_card_send",
      reason: input.reason,
      currentQuotaLimit: policy.quotaLimit,
      requestedQuotaLimit: input.requestedQuotaLimit,
      approvalTargetOpenId: input.approvalTargetOpenId,
      approvalActionNonceHash: input.approvalActionNonceHash,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function decidePostgresDepartmentQuotaRequestAsActor(input: {
  actorFeishuUserId: string;
  requestId: string;
  action: "approve" | "reject";
  approvedQuotaLimit?: number;
}) {
  return withControlTransaction(async (client) => {
    const requestIdentity = await client.query<{
      department_id: string;
      period: string;
    }>(
      "select department_id, period from department_quota_requests where id = $1",
      [input.requestId],
    );
    if (!requestIdentity.rows[0]) return null;
    await lockAdminScopeUsersInTransaction(client, [input.actorFeishuUserId]);
    const actorScope = await resolvePostgresActorScopeInTransaction(
      client,
      input.actorFeishuUserId,
    );
    if (!actorScope || actorScope.scopeType !== "global") {
      throw new AdminUserActionAuthorizationError(
        "actor_scope_missing",
        403,
        "只有当前有效的系统管理员可以审批部门额度申请",
      );
    }
    const departmentId = requestIdentity.rows[0].department_id;
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `department-quota:${departmentId}:${requestIdentity.rows[0].period}`,
    ]);
    const requestResult = await client.query<{ data: DepartmentQuotaRequest }>(
      "select data from department_quota_requests where id = $1 for update",
      [input.requestId],
    );
    const request = requestResult.rows[0]?.data;
    if (
      !request ||
      !["pending_card_send", "pending_card_approval", "approval_card_send_failed"].includes(
        request.status,
      )
    ) {
      return null;
    }
    const actorResult = await client.query<{ data: FeishuUser }>(
      "select data from feishu_users where id = $1",
      [input.actorFeishuUserId],
    );
    const actor = actorResult.rows[0]?.data;
    if (!actor) {
      throw new AdminUserActionAuthorizationError(
        "actor_scope_missing",
        403,
        "当前系统管理员用户不存在",
      );
    }
    const now = nowIso();
    if (input.action === "reject") {
      return saveDepartmentQuotaRequestRow(client, {
        ...request,
        status: "rejected",
        approvalOperatorOpenId: actor.openId,
        approvalOperatedAt: now,
        errorMessage: undefined,
        updatedAt: now,
      });
    }

    const policy = await readOrCreatePostgresDepartmentQuotaPeriod(client, {
      departmentId: request.departmentId,
      departmentName: request.departmentName,
      period: request.period,
    });
    const facts = await readPostgresDepartmentQuotaFacts(
      client,
      request.departmentId,
      request.period,
    );
    const approvedQuotaLimit =
      input.approvedQuotaLimit ?? request.requestedQuotaLimit;
    if (approvedQuotaLimit === undefined) {
      throw new Error("重置额度申请需要系统管理员填写审批额度");
    }
    const limitError = validateDepartmentQuotaLimit(
      approvedQuotaLimit,
      facts.allocatedQuota + facts.pendingReservedQuota,
    );
    if (limitError) throw new Error(limitError);
    if (request.action === "increase" && approvedQuotaLimit <= policy.quotaLimit) {
      throw new Error("提高额度审批值必须大于当前部门额度上限");
    }
    const updatedPolicy = await saveDepartmentQuotaPeriodRow(client, {
      ...policy,
      quotaLimit: approvedQuotaLimit,
      updatedAt: now,
      updatedByFeishuUserId: input.actorFeishuUserId,
    });
    await saveQuotaChangeEventRow(client, {
      id: `qce_department_request_${request.id}`,
      departmentId: request.departmentId,
      departmentName: request.departmentName,
      period: request.period,
      operatedByFeishuUserId: input.actorFeishuUserId,
      kind: "department_limit_set",
      status: "applied",
      previousValue: policy.quotaLimit,
      nextValue: approvedQuotaLimit,
      delta: approvedQuotaLimit - policy.quotaLimit,
      relatedDepartmentQuotaRequestId: request.id,
      createdAt: now,
      updatedAt: now,
    });
    const storedRequest = await saveDepartmentQuotaRequestRow(client, {
      ...request,
      status: "approved",
      approvedQuotaLimit,
      approvalOperatorOpenId: actor.openId,
      approvalOperatedAt: now,
      errorMessage: undefined,
      updatedAt: now,
    });
    return { request: storedRequest, policy: updatedPolicy };
  });
}

export async function getPostgresDepartmentQuotaOverview(
  scope: AdminScope,
  period: string,
) {
  return withControlClient(async (client) => {
    const departments = await client.query<{
      id: string;
      department_id: string;
      department_name: string | null;
      quota_limit: number;
      default_grant_quota: number;
      allocated_quota: number;
      pending_reserved_quota: number;
      available_quota: number;
      quota_consumed: number;
      remaining_quota: number;
      member_count: number;
      keyed_users: number;
      prewarmed_keys: number;
      updated_at: Date | string;
      updated_by_feishu_user_id: string | null;
    }>(
      `with department_ids as materialized (
         select distinct department_id
         from feishu_users
         where department_id is not null
         union
         select distinct department_id
         from department_quota_periods
         where period = $3
         union
         select $2::text
         where $1::text = 'department' and $2::text is not null
       ), scoped_departments as materialized (
         select department_id
         from department_ids
         where department_id is not null
           and ($1::text = 'global' or department_id = $2)
       ), member_stats as materialized (
         select member.department_id,
           max(nullif(member.data->>'departmentName', '')) as department_name,
           count(*) filter (
             where coalesce(member.data->>'status', 'active') <> 'deleted'
           )::integer as member_count,
           coalesce(
             sum(greatest(coalesce((policy.data->>'assignedMonthlyQuota')::numeric, 0), 0))
               / $4::numeric,
             0
           )::double precision as allocated_quota
         from feishu_users member
         join scoped_departments scoped on scoped.department_id = member.department_id
         left join lateral (
           select quota_policy.data
           from user_quota_policies quota_policy
           where quota_policy.feishu_user_id = member.id
             and quota_policy.effective_from_period <= $3
             and (
               quota_policy.effective_to_period is null
               or quota_policy.effective_to_period >= $3
             )
           order by quota_policy.version desc, quota_policy.id desc
           limit 1
         ) policy on true
         where coalesce(member.data->>'status', 'active') <> 'deleted'
         group by member.department_id
       ), account_stats as materialized (
         select member.department_id,
           count(distinct account.feishu_user_id) filter (
             where account.status = 'active'
           )::integer as keyed_users,
           count(*) filter (
             where account.status = 'pending_activation'
               and nullif(account.data->>'prewarmedAt', '') is not null
           )::integer as prewarmed_keys
         from token_accounts account
         join feishu_users member on member.id = account.feishu_user_id
         join scoped_departments scoped on scoped.department_id = member.department_id
         group by member.department_id
       ), reservation_stats as materialized (
         select operation.department_id,
           coalesce(
             sum(greatest(coalesce((operation.data->>'reservedDepartmentQuota')::numeric, 0), 0))
               / $4::numeric,
             0
           )::double precision as pending_reserved_quota
         from quota_operations operation
         join scoped_departments scoped on scoped.department_id = operation.department_id
         where operation.billing_period = $3
           and operation.state not in ('completed', 'compensated', 'cancelled')
         group by operation.department_id
       ), settings as materialized (
         select coalesce((data->>'defaultMonthlyQuota')::double precision, 200) as default_grant_quota
         from app_settings where id = 'default'
       )
       select
         coalesce(policy.id, 'virtual:' || scoped.department_id || ':' || $3) as id,
         scoped.department_id,
         coalesce(nullif(policy.data->>'departmentName', ''), members.department_name) as department_name,
         coalesce(
           (policy.data->>'quotaLimit')::double precision,
           greatest(1000, coalesce(members.allocated_quota, 0))
         ) as quota_limit,
         coalesce(
           (policy.data->>'defaultGrantQuota')::double precision,
           settings.default_grant_quota,
           200
         ) as default_grant_quota,
         coalesce(members.allocated_quota, 0) as allocated_quota,
         coalesce(reservations.pending_reserved_quota, 0) as pending_reserved_quota,
         greatest(
           coalesce((policy.data->>'quotaLimit')::double precision, greatest(1000, coalesce(members.allocated_quota, 0)))
             - coalesce(members.allocated_quota, 0)
             - coalesce(reservations.pending_reserved_quota, 0),
           0
         ) as available_quota,
         0::double precision as quota_consumed,
         0::double precision as remaining_quota,
         coalesce(members.member_count, 0)::integer as member_count,
         coalesce(accounts.keyed_users, 0)::integer as keyed_users,
         coalesce(accounts.prewarmed_keys, 0)::integer as prewarmed_keys,
         coalesce(policy.updated_at, statement_timestamp()) as updated_at,
         nullif(policy.data->>'updatedByFeishuUserId', '') as updated_by_feishu_user_id
       from scoped_departments scoped
       left join department_quota_periods policy
         on policy.department_id = scoped.department_id and policy.period = $3
       left join member_stats members on members.department_id = scoped.department_id
       left join account_stats accounts on accounts.department_id = scoped.department_id
       left join reservation_stats reservations on reservations.department_id = scoped.department_id
       left join settings on true
       order by coalesce(nullif(policy.data->>'departmentName', ''), members.department_name, scoped.department_id)`,
      [
        scope.scopeType,
        scope.departmentId ?? null,
        period,
        getConfig().newapi.quotaPerUnit,
      ],
    );
    const [requests, recentEvents] = await Promise.all([
      client.query<{
        data: DepartmentQuotaRequest;
        requester_name: string | null;
        requester_open_id: string | null;
        operator_name: string | null;
      }>(
        `select request.data,
                nullif(requester.data->>'name', '') as requester_name,
                requester.open_id as requester_open_id,
                nullif(operator_user.data->>'name', '') as operator_name
         from department_quota_requests request
         left join feishu_users requester on requester.id = request.requester_feishu_user_id
         left join feishu_users operator_user
           on operator_user.open_id = nullif(request.data->>'approvalOperatorOpenId', '')
         where request.period = $1
           and ($2::text = 'global' or request.department_id = $3)
         order by request.updated_at desc, request.id desc`,
        [period, scope.scopeType, scope.departmentId ?? null],
      ),
      client.query<{ data: QuotaChangeEvent }>(
        `select data
         from quota_change_events
         where period = $1
           and ($2::text = 'global' or department_id = $3)
         order by updated_at desc, id desc
         limit 100`,
        [period, scope.scopeType, scope.departmentId ?? null],
      ),
    ]);
    return {
      period,
      departments: departments.rows.map((row) => ({
        id: row.id,
        departmentId: row.department_id,
        departmentName: row.department_name ?? undefined,
        period,
        quotaLimit: Number(row.quota_limit),
        defaultGrantQuota: Number(row.default_grant_quota),
        allocatedQuota: Number(row.allocated_quota),
        pendingReservedQuota: Number(row.pending_reserved_quota),
        availableQuota: Number(row.available_quota),
        quotaConsumed: Number(row.quota_consumed),
        remainingQuota: Number(row.remaining_quota),
        memberCount: Number(row.member_count),
        keyedUsers: Number(row.keyed_users),
        prewarmedKeys: Number(row.prewarmed_keys),
        updatedAt: postgresTimestampIso(row.updated_at),
        updatedByFeishuUserId: row.updated_by_feishu_user_id ?? undefined,
      })),
      requests: requests.rows.map((row) => ({
        ...row.data,
        requesterName: row.requester_name ?? undefined,
        requesterOpenId: row.requester_open_id ?? undefined,
        approvalOperatorName: row.operator_name ?? undefined,
      })),
      recentEvents: recentEvents.rows.map((row) => row.data),
    };
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
  return withControlTransaction((client) => saveTokenAccountRow(client, account));
}

export async function insertPostgresPrewarmedTokenAccountIfEligible(input: {
  departmentId: string;
  account: TokenAccount;
}) {
  return withControlTransaction(async (client) => {
    const user = await client.query<{ data: FeishuUser }>(
      `select data
       from feishu_users
       where id = $1
         and department_id = $2
         and coalesce(data->>'status', 'active') = 'active'
       for update`,
      [input.account.feishuUserId, input.departmentId],
    );
    if (!user.rows[0]) return null;

    const eligibility = await client.query<{ blocked: boolean }>(
      `select
         exists (
           select 1
           from token_accounts account
           where account.feishu_user_id = $1
             and account.status in ('pending_activation', 'active', 'draining', 'settling')
         ) or exists (
           select 1
           from quota_operations operation
           where operation.feishu_user_id = $1
             and operation.state not in ('completed', 'compensated', 'cancelled')
         ) as blocked`,
      [input.account.feishuUserId],
    );
    if (eligibility.rows[0]?.blocked) return null;

    return saveTokenAccountRow(client, input.account);
  });
}

export async function claimPostgresPrewarmedTokenAccount(input: {
  feishuUserId: string;
  tokenRequestId: string;
  billingPeriod: string;
  operationGeneration?: number;
}) {
  return withControlTransaction(async (client) => {
    const result = await client.query<{ data: TokenAccount }>(
      `select data
       from token_accounts
       where feishu_user_id = $1
         and status = 'pending_activation'
         and newapi_token_id is not null
         and nullif(data->>'prewarmedCredentialCiphertext', '') is not null
       order by created_at, id
       limit 1
       for update`,
      [input.feishuUserId],
    );
    const account = result.rows[0]?.data;
    if (!account?.newapiTokenId || !account.prewarmedCredentialCiphertext) return null;
    return saveTokenAccountRow(client, {
      ...account,
      tokenRequestId: input.tokenRequestId,
      billingPeriod: input.billingPeriod,
      operationGeneration:
        input.operationGeneration ?? account.operationGeneration,
    });
  });
}

export async function insertPostgresTokenAccountForQuotaOperation(account: TokenAccount) {
  // Key rotation performs an authoritative snapshot at its accounting
  // boundary. A pending replacement account has no usage or ledger effect, so
  // inserting it must not trigger another full user rebuild.
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
    return saveTokenAccountRow(client, input.account);
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
    const identityResult = await client.query<{ id: string }>(
      `select id from feishu_users
       where open_id = $1
       order by created_at, id
       limit 1`,
      [input.targetOpenId],
    );
    const targetUserId = identityResult.rows[0]?.id;
    if (!targetUserId) {
      return {
        scope: null,
        error: "target_user_not_found" as const,
      };
    }
    await lockAdminScopeUsersInTransaction(client, [targetUserId]);
    const userResult = await client.query<{ data: FeishuUser }>(
      "select data from feishu_users where id = $1 for update",
      [targetUserId],
    );
    const targetUser = userResult.rows[0]?.data;
    if (!targetUser) {
      return {
        scope: null,
        error: "target_user_not_found" as const,
      };
    }
    if (isInactiveUser(targetUser)) {
      return {
        scope: null,
        error: "target_user_inactive" as const,
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
    const identityResult = await client.query<{ feishu_user_id: string }>(
      "select feishu_user_id from admin_scopes where id = $1",
      [input.scopeId],
    );
    const feishuUserId = identityResult.rows[0]?.feishu_user_id;
    if (!feishuUserId) return null;
    await lockAdminScopeUsersInTransaction(client, [feishuUserId]);
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
    await lockAdminScopeUsersInTransaction(client, [input.feishuUserId]);
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

type UpdatePostgresUserAccessStatusInput = {
  actorFeishuUserId: string;
  feishuUserId: string;
  status: "disabled" | "deleted";
  reason?: string;
  tokenStatus: Extract<TokenStatus, "disabled" | "revoked">;
  adminRevokedByFeishuUserId?: string;
  adminScopeLocksHeld?: boolean;
  upstreamDisabledAt?: string;
  consumptionBarrierCutoffAt?: string;
};

async function updatePostgresUserAccessStatusWithClient(
  client: PoolClient,
  input: UpdatePostgresUserAccessStatusInput,
) {
  const now = nowIso();
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `user-quota:${input.feishuUserId}`,
    ]);
    const authorized = await authorizePostgresAdminUserAction(client, {
      actorFeishuUserId: input.actorFeishuUserId,
      targetFeishuUserId: input.feishuUserId,
      adminScopeLocksHeld: input.adminScopeLocksHeld,
      destructiveAccessRevoke: true,
    });
    if (!authorized) return null;
    const user = authorized.targetUser;

    const accountResult = await client.query<{ data: TokenAccount }>(
      `select data from token_accounts
       where feishu_user_id = $1
         and (
           ($2::text = 'revoked' and status <> 'revoked')
           or
           ($2::text = 'disabled'
             and status in ('pending_activation', 'active', 'draining', 'settling'))
         )
       order by created_at, id
       for update`,
      [input.feishuUserId, input.tokenStatus],
    );
    const storedAccounts: TokenAccount[] = [];
    for (const row of accountResult.rows) {
      const nextStatus =
        input.tokenStatus === "disabled" && row.data.status === "pending_activation"
          ? "orphaned"
          : input.tokenStatus;
      storedAccounts.push(
        await saveTokenAccountRow(client, {
          ...row.data,
          status: nextStatus,
          disabledAt: now,
          prewarmedCredentialCiphertext:
            nextStatus === "orphaned" || nextStatus === "revoked"
              ? undefined
              : row.data.prewarmedCredentialCiphertext,
        }),
      );
    }

    const openOperations = await client.query<{ data: QuotaOperation }>(
      `select data from quota_operations
       where feishu_user_id = $1
         and state not in ('completed', 'compensated', 'cancelled')
       order by created_at, id
       for update`,
      [input.feishuUserId],
    );
    const cancelledOperationIds: string[] = [];
    const manualReviewOperationIds: string[] = [];
    for (const row of openOperations.rows) {
      const operation = row.data;
      const cancellable = canCancelQuotaOperationForAccessRevoke(operation);
      if (cancellable) cancelledOperationIds.push(operation.id);
      else manualReviewOperationIds.push(operation.id);
      await saveQuotaOperationRow(client, {
        ...operation,
        state: cancellable ? "cancelled" : "manual_review",
        reservedDepartmentQuota: cancellable ? 0 : operation.reservedDepartmentQuota,
        nextRetryAt: undefined,
        workerLeaseId: undefined,
        workerLeaseExpiresAt: undefined,
        lastErrorCode: cancellable
          ? "user_access_revoked"
          : "user_access_revoked_manual_review",
        lastErrorMessage:
          input.reason ??
          (input.status === "deleted" ? "用户已删除，额度操作已终止" : "用户已禁用，额度操作已终止"),
        evidence: {
          ...operation.evidence,
          userAccessRevokedAt: now,
          userAccessStatus: input.status,
          ...(cancellable
            ? { cancelledFromState: operation.state }
            : { manualReviewFromState: operation.state }),
          credentialRevokedAt:
            operation.credentialCiphertext && !operation.credentialDeliveredAt
              ? now
              : operation.evidence?.credentialRevokedAt,
        },
        credentialCiphertext:
          operation.credentialDeliveredAt ? operation.credentialCiphertext : undefined,
        updatedAt: now,
        completedAt: cancellable ? now : undefined,
      });
      if (operation.requestId) {
        const requestResult = await client.query<{ data: TokenRequest }>(
          "select data from token_requests where id = $1 for update",
          [operation.requestId],
        );
        const tokenRequest = requestResult.rows[0]?.data;
        if (tokenRequest && tokenRequest.status !== "provisioned") {
          await saveTokenRequestRow(client, {
            ...tokenRequest,
            status: "approved_provision_failed",
            errorMessage:
              input.status === "deleted"
                ? "用户已删除，Key 与套餐操作已终止；重新申请后将创建新操作"
                : "用户已禁用，Key 与套餐操作已终止",
            updatedAt: now,
          });
        }
      }
    }

    const terminalCredentials = await client.query<{ data: QuotaOperation }>(
      `select data from quota_operations
       where feishu_user_id = $1
         and state in ('completed', 'compensated', 'cancelled')
         and data ? 'credentialCiphertext'
         and not (data ? 'credentialDeliveredAt')
       order by created_at, id
       for update`,
      [input.feishuUserId],
    );
    for (const row of terminalCredentials.rows) {
      await saveQuotaOperationRow(client, {
        ...row.data,
        credentialCiphertext: undefined,
        evidence: {
          ...row.data.evidence,
          credentialRevokedAt: now,
          userAccessStatus: input.status,
        },
        updatedAt: now,
      });
    }

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
        adminScopeLockHeld: input.adminScopeLocksHeld,
      });
    }
    const quotaState = await readPostgresUserQuotaState(client, input.feishuUserId);
    const revocationBarrier = preserveUserAccessRevocationBarrier(input, quotaState);
    await saveUserQuotaStateRow(client, {
      feishuUserId: input.feishuUserId,
      admission: "closed",
      activeGeneration: quotaState.activeGeneration,
      operationId: undefined,
      closedReason: "user_access_revoked",
      ...revocationBarrier,
      updatedAt: now,
    });
    const resumableAccount = [...storedAccounts]
      .reverse()
      .find((account) => account.status === input.tokenStatus) ?? null;
    return {
      user: storedUser,
      tokenAccount: resumableAccount,
      tokenAccounts: storedAccounts,
      terminatedOperationIds: cancelledOperationIds,
      manualReviewOperationIds,
    };
}

export async function upsertPostgresManualAdminScopeAsActor(input: {
  actorFeishuUserId: string;
  targetOpenId: string;
  scopeType: AdminScope["scopeType"];
  departmentId?: string;
}) {
  return withControlTransaction(async (client) => {
    const identity = await client.query<{ id: string }>(
      `select id from feishu_users
       where open_id = $1
       order by created_at, id
       limit 1`,
      [input.targetOpenId],
    );
    const targetUserId = identity.rows[0]?.id;
    if (!targetUserId) {
      return { scope: null, error: "target_user_not_found" as const };
    }
    await lockAdminScopeUsersInTransaction(client, [
      input.actorFeishuUserId,
      targetUserId,
    ]);
    const actorScope = await resolvePostgresActorScopeInTransaction(
      client,
      input.actorFeishuUserId,
    );
    if (!actorScope || actorScope.scopeType !== "global") {
      throw new AdminUserActionAuthorizationError(
        "actor_scope_missing",
        403,
        "当前系统管理员权限已变化，请刷新后重试",
      );
    }
    const actorIsRoot =
      actorScope.source === "environment" && actorScope.role === "root";
    if (input.scopeType === "global" && !actorIsRoot) {
      throw new AdminUserActionAuthorizationError(
        "root_required",
        403,
        "只有 root 管理员可以指派系统管理员",
      );
    }
    if (
      getConfig().admin.systemAdminOpenIds.includes(input.targetOpenId) &&
      !actorIsRoot
    ) {
      throw new AdminUserActionAuthorizationError(
        "root_required",
        403,
        "环境变量 root 用户仅允许 root 管理员操作",
      );
    }
    const targetResult = await client.query<{ data: FeishuUser }>(
      "select data from feishu_users where id = $1 for update",
      [targetUserId],
    );
    const targetUser = targetResult.rows[0]?.data;
    if (!targetUser) {
      return { scope: null, error: "target_user_not_found" as const };
    }
    if (isInactiveUser(targetUser)) {
      return { scope: null, error: "target_user_inactive" as const };
    }
    if (input.scopeType === "department" && !input.departmentId) {
      throw new Error("指派部门管理员需要 departmentId");
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
    const existing = existingResult.rows[0]?.data;
    if (existing) {
      return {
        scope: await saveAdminScopeRow(client, {
          ...activeAdminScope(existing, now),
          departmentId:
            input.scopeType === "department" ? input.departmentId : undefined,
        }),
        error: null,
      };
    }
    const scope: AdminScope = {
      id: randomId("as"),
      feishuUserId: targetUser.id,
      scopeType: input.scopeType,
      departmentId:
        input.scopeType === "department" ? input.departmentId : undefined,
      source: "manual",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    return { scope: await saveAdminScopeRow(client, scope), error: null };
  });
}

export async function updatePostgresManualAdminScopeAsActor(input: {
  actorFeishuUserId: string;
  scopeId: string;
  status?: AdminScope["status"];
  departmentId?: string;
  disabledReason?: AdminScope["disabledReason"];
}) {
  return withControlTransaction(async (client) => {
    const identity = await client.query<{ feishu_user_id: string }>(
      "select feishu_user_id from admin_scopes where id = $1",
      [input.scopeId],
    );
    const targetFeishuUserId = identity.rows[0]?.feishu_user_id;
    if (!targetFeishuUserId) return null;
    await lockAdminScopeUsersInTransaction(client, [
      input.actorFeishuUserId,
      targetFeishuUserId,
    ]);
    const scopeResult = await client.query<{ data: AdminScope }>(
      "select data from admin_scopes where id = $1 for update",
      [input.scopeId],
    );
    const scope = scopeResult.rows[0]?.data;
    if (!scope || scope.source === "environment") return null;
    const actorScope = await resolvePostgresActorScopeInTransaction(
      client,
      input.actorFeishuUserId,
    );
    if (!actorScope || actorScope.scopeType !== "global") {
      throw new AdminUserActionAuthorizationError(
        "actor_scope_missing",
        403,
        "当前系统管理员权限已变化，请刷新后重试",
      );
    }
    const actorIsRoot =
      actorScope.source === "environment" && actorScope.role === "root";
    if (scope.scopeType === "global" && !actorIsRoot) {
      throw new AdminUserActionAuthorizationError(
        "root_required",
        403,
        "只有 root 管理员可以修改或取消系统管理员",
      );
    }

    const now = nowIso();
    const statusUpdated =
      input.status === "active"
        ? activeAdminScope(scope, now)
        : input.status === "disabled"
          ? disabledAdminScope(scope, {
              now,
              reason: input.disabledReason ?? "manual_revoke",
              disabledByFeishuUserId: input.actorFeishuUserId,
            })
          : scope;
    return saveAdminScopeRow(client, {
      ...statusUpdated,
      departmentId:
        scope.scopeType === "department" && input.departmentId !== undefined
          ? input.departmentId
          : scope.departmentId,
      updatedAt: now,
    });
  });
}

export async function updatePostgresUserAccessStatus(
  input: UpdatePostgresUserAccessStatusInput,
) {
  return withTransaction(async (client) => {
    await lockPostgresUserQuotaFence(client, input.feishuUserId);
    return updatePostgresUserAccessStatusWithClient(client, input);
  });
}

export async function updatePostgresUserAccessStatusUnderUserFence(
  input: UpdatePostgresUserAccessStatusInput,
) {
  // The caller already owns user-quota-fence on the dedicated session-lock
  // connection. Reacquiring that key on this pooled transaction would
  // deadlock against the caller itself.
  return withControlTransaction((client) =>
    updatePostgresUserAccessStatusWithClient(client, input),
  );
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

type EnablePostgresUserAccessInput = {
  actorFeishuUserId: string;
  feishuUserId: string;
  reason?: string;
  expectedTokenAccountId?: string;
  adminScopeLocksHeld?: boolean;
};

async function enablePostgresUserAccessWithClient(
  client: PoolClient,
  input: EnablePostgresUserAccessInput,
) {
    const now = nowIso();
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `user-quota:${input.feishuUserId}`,
    ]);
    const authorized = await authorizePostgresAdminUserAction(client, {
      actorFeishuUserId: input.actorFeishuUserId,
      targetFeishuUserId: input.feishuUserId,
      adminScopeLocksHeld: input.adminScopeLocksHeld,
    });
    if (!authorized) return null;
    const user = authorized.targetUser;
    if (!user || user.status !== "disabled") return null;

    const activeResult = await client.query<{ data: TokenAccount }>(
      `select data from token_accounts
       where feishu_user_id = $1 and status = 'active'
       limit 1
       for update`,
      [input.feishuUserId],
    );
    if (activeResult.rows[0]?.data) return null;

    const openOperation = await client.query<{ id: string }>(
      `select id from quota_operations
       where feishu_user_id = $1
         and state not in ('completed', 'compensated', 'cancelled')
       limit 1
       for update`,
      [input.feishuUserId],
    );
    if (openOperation.rows[0]) return null;

    const disabledResult = await client.query<{ data: TokenAccount }>(
      `select data from token_accounts
       where feishu_user_id = $1 and status = 'disabled'
         and ($2::text is null or id = $2)
       order by coalesce(disabled_at, created_at) desc, created_at desc, id desc
       limit 1
       for update`,
      [input.feishuUserId, input.expectedTokenAccountId ?? null],
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
    const quotaState = await readPostgresUserQuotaState(client, input.feishuUserId);
    await saveUserQuotaStateRow(client, {
      feishuUserId: input.feishuUserId,
      admission: "closed",
      activeGeneration: Math.max(
        quotaState.activeGeneration,
        storedAccount.operationGeneration ?? 0,
      ),
      operationId: undefined,
      closedReason: "user_access_resume_pending",
      resumeTokenAccountId: storedAccount.id,
      resumePreparedAt: now,
      updatedAt: now,
    });
    return { user: storedUser, tokenAccount: storedAccount };
}

export async function enablePostgresUserAccess(
  input: EnablePostgresUserAccessInput,
) {
  return withTransaction(async (client) => {
    await lockPostgresUserQuotaFence(client, input.feishuUserId);
    return enablePostgresUserAccessWithClient(client, input);
  });
}

export async function enablePostgresUserAccessUnderUserFence(
  input: EnablePostgresUserAccessInput,
) {
  return withControlTransaction((client) =>
    enablePostgresUserAccessWithClient(client, input),
  );
}

export async function markPostgresUserAccessResumeEnableAttemptUnderUserFence(input: {
  feishuUserId: string;
  expectedTokenAccountId: string;
}) {
  return withControlTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `user-quota:${input.feishuUserId}`,
    ]);
    const now = nowIso();
    const result = await client.query<{ data: UserQuotaState }>(
      markUserAccessResumeEnableAttemptSql,
      [input.feishuUserId, input.expectedTokenAccountId, now],
    );
    return result.rows[0]?.data ?? null;
  });
}

export async function listPostgresStaleUserAccessResumeCandidates(input: {
  staleBefore: string;
  limit: number;
}) {
  return withControlClient(async (client) => {
    const result = await client.query<{
      user: FeishuUser;
      account: TokenAccount;
      quota_state: UserQuotaState;
    }>(
      listStaleUserAccessResumeCandidatesSql,
      [input.staleBefore, input.limit],
    );
    return result.rows.map((row) => ({
      user: row.user,
      tokenAccount: row.account,
      quotaState: row.quota_state,
    }));
  });
}

export async function finalizePostgresUserAccessResumeUnderUserFence(input: {
  actorFeishuUserId: string;
  feishuUserId: string;
  expectedTokenAccountId: string;
  adminScopeLocksHeld?: boolean;
}) {
  return withControlTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `user-quota:${input.feishuUserId}`,
    ]);
    const authorized = await authorizePostgresAdminUserAction(client, {
      actorFeishuUserId: input.actorFeishuUserId,
      targetFeishuUserId: input.feishuUserId,
      adminScopeLocksHeld: input.adminScopeLocksHeld,
    });
    if (!authorized) return null;
    const result = await client.query<{
      user: FeishuUser | null;
      account: TokenAccount | null;
      quota_state: UserQuotaState | null;
      open_operation_id: string | null;
    }>(
      `select
         (select data from feishu_users where id = $1 for update) as user,
         (select data from token_accounts
          where id = $2 and feishu_user_id = $1 and status = 'active'
          for update) as account,
         (select data from user_quota_states where feishu_user_id = $1 for update) as quota_state,
         (select id from quota_operations
          where feishu_user_id = $1
            and state not in ('completed', 'compensated', 'cancelled')
          limit 1) as open_operation_id`,
      [input.feishuUserId, input.expectedTokenAccountId],
    );
    const row = result.rows[0];
    if (
      !row?.user ||
      row.user.status !== "active" ||
      !row.account ||
      row.open_operation_id ||
      row.quota_state?.admission !== "closed" ||
      row.quota_state.closedReason !== "user_access_resume_pending"
    ) {
      return null;
    }
    const now = nowIso();
    const quotaState = await saveUserQuotaStateRow(client, {
      feishuUserId: input.feishuUserId,
      admission: "open",
      activeGeneration: Math.max(
        row.quota_state.activeGeneration,
        row.account.operationGeneration ?? 0,
      ),
      operationId: undefined,
      closedReason: undefined,
      updatedAt: now,
    });
    return { user: row.user, tokenAccount: row.account, quotaState };
  });
}

export async function rollbackPostgresUserAccessResumeUnderUserFence(input: {
  feishuUserId: string;
  expectedTokenAccountId: string;
  upstreamDisabledAt: string;
  consumptionBarrierCutoffAt: string;
  reason: string;
}) {
  return withControlTransaction(async (client) => {
    // This short transaction lock serializes the three local projections. The
    // caller also owns user-quota-fence on a dedicated connection, so quota
    // operations and other access workflows cannot cross this compensation.
    await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `user-quota:${input.feishuUserId}`,
    ]);
    const result = await client.query<{
      user: FeishuUser;
      account: TokenAccount;
      quota_state: UserQuotaState;
    }>(rollbackPendingUserAccessResumeSql, [
      input.feishuUserId,
      input.expectedTokenAccountId,
      input.upstreamDisabledAt,
      input.consumptionBarrierCutoffAt,
      input.reason,
    ]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      user: row.user,
      tokenAccount: row.account,
      quotaState: row.quota_state,
    };
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
      if (!policy) throw new Error("部门套餐周期设置不存在");

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
           and state not in ('completed', 'compensated', 'cancelled')`,
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

function hasAuthoritativeUsageRecordBillingAmount(record: NewApiUsageRecord) {
  return [record.quota, record.cost].some(
    (value) => Number.isFinite(value) && (value as number) >= 0,
  );
}

async function closePostgresResolvedMissingCostIssues(
  client: PoolClient,
  record: NewApiUsageRecord,
) {
  if (!hasAuthoritativeUsageRecordBillingAmount(record)) return;
  const issues = await client.query<{ data: UsageSyncIssue }>(
    `select data
       from usage_sync_issues
      where issue_type = 'missing_cost'
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
      order by id
      for update`,
    [
      record.newapiTokenId ?? null,
      record.newapiRequestId ?? null,
      record.newapiLogId ?? null,
    ],
  );
  for (const row of issues.rows) {
    if (!sameNewApiUsageSource(row.data, record)) continue;
    await saveUsageSyncIssueRow(client, {
      ...row.data,
      status: "closed",
      lastSyncedAt: record.lastSyncedAt,
      closedAt: record.lastSyncedAt,
    });
  }
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
  if (
    existing &&
    !hasAuthoritativeUsageRecordBillingAmount(existing) &&
    hasAuthoritativeUsageRecordBillingAmount(stored)
  ) {
    await closePostgresResolvedMissingCostIssues(client, stored);
  }
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
  fn: (fence?: QuotaExecutionFence) => Promise<T>,
  options: { wait?: boolean; executionFence?: boolean } = {},
) {
  return withAdvisoryLockClient(async (client, destroyClient) => {
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
    const fence = options.executionFence
      ? createQuotaExecutionFence(key)
      : undefined;
    let heartbeatInFlight: Promise<void> | undefined;
    const markFenceLost = (error: unknown) => {
      fence?.markLost(error);
      destroyClient();
    };
    const onClientError = (error: Error) => markFenceLost(error);
    const onClientEnd = () => markFenceLost(new Error("PostgreSQL 栅栏连接已结束"));
    client.on("error", onClientError);
    client.on("end", onClientEnd);
    const heartbeat = fence
      ? setInterval(() => {
          if (heartbeatInFlight || fence.lost || fence.closed) return;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const query = client.query("select 1");
          // Keep a rejection handler on the underlying query even when the
          // timeout wins the race and the lock client is destroyed later.
          void query.catch(() => undefined);
          heartbeatInFlight = Promise.race([
            query.then(() => undefined),
            new Promise<void>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error("PostgreSQL 栅栏心跳超时")),
                10_000,
              );
              timeout.unref?.();
            }),
          ])
            .catch(markFenceLost)
            .finally(() => {
              if (timeout) clearTimeout(timeout);
              heartbeatInFlight = undefined;
            });
        }, 5_000)
      : undefined;
    heartbeat?.unref?.();
    let callbackFailed = false;
    try {
      const result = fence
        ? await runWithQuotaExecutionFence(fence, () => fn(fence))
        : await fn();
      fence?.assertHeld();
      return result;
    } catch (error) {
      callbackFailed = true;
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (heartbeatInFlight) await heartbeatInFlight;
      client.removeListener("error", onClientError);
      client.removeListener("end", onClientEnd);
      let fenceFailure: unknown;
      if (fence?.lost) {
        destroyClient();
        if (!callbackFailed) {
          try {
            fence.assertHeld();
          } catch (error) {
            fenceFailure = error;
          }
        }
      }
      fence?.close();
      if (fenceFailure) throw fenceFailure;
      if (!fence?.lost) {
        try {
          const unlocked = await client.query<{ unlocked: boolean }>(
            "select pg_advisory_unlock(hashtext($1)::bigint) as unlocked",
            [key],
          );
          if (!unlocked.rows[0]?.unlocked) {
            throw new Error("PostgreSQL 栅栏释放校验失败");
          }
        } catch (error) {
          markFenceLost(error);
          throw error;
        }
      }
    }
  });
}

export async function writePostgresStore(store: StoreShape) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("delete from app_settings");
    await client.query("delete from billing_operations");
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
    await client.query("delete from user_quota_policies");
    await client.query("delete from feishu_users");

    await saveSettingsRow(client, store.settings);
    for (const operation of store.settings.billingOperations ?? []) {
      await insertPostgresBillingOperationRow(client, operation);
    }

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

    for (const policy of store.userQuotaPolicies ?? []) {
      await saveUserQuotaPolicyRow(client, policy);
    }

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
         billing_period, operation_generation, lease_expires_at, heartbeat_at,
         data, created_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      values: [
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
    }));

    await insertJsonRows(client, "newapi_usage_records", store.newapiUsageRecords, (record) => ({
      sql: `insert into newapi_usage_records
        (id, newapi_log_id, newapi_request_id, newapi_token_id, token_account_id,
         feishu_user_id, billing_period, match_status, data, newapi_created_at,
         first_seen_at, last_synced_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      values: [
        record.id,
        record.newapiLogId ?? null,
        record.newapiRequestId ?? null,
        record.newapiTokenId ?? null,
        record.tokenAccountId ?? null,
        record.feishuUserId ?? null,
        record.billingPeriod ?? null,
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
