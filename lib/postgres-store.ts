import { Pool, type PoolClient } from "pg";
import { getConfig } from "./config.ts";

let pool: Pool | undefined;
let advisoryLockPool: Pool | undefined;

type PoolAcquisitionMetrics = {
  requestedTotal: number;
  acquiredTotal: number;
  queuedTotal: number;
  failedTotal: number;
  acquisitionMsTotal: number;
  acquisitionMsMax: number;
};

function emptyPoolAcquisitionMetrics(): PoolAcquisitionMetrics {
  return {
    requestedTotal: 0,
    acquiredTotal: 0,
    queuedTotal: 0,
    failedTotal: 0,
    acquisitionMsTotal: 0,
    acquisitionMsMax: 0,
  };
}

const businessPoolAcquisition = emptyPoolAcquisitionMetrics();
const lockPoolAcquisition = emptyPoolAcquisitionMetrics();

export async function closePostgresPools() {
  const pools = [pool, advisoryLockPool].filter((item): item is Pool => Boolean(item));
  pool = undefined;
  advisoryLockPool = undefined;
  await Promise.all(pools.map((item) => item.end()));
}

export const REQUIRED_POSTGRES_TABLES = [
  "schema_migrations",
  "app_settings",
  "feishu_users",
  "token_accounts",
  "feishu_events",
  "proxy_request_logs",
  "newapi_usage_records",
  "usage_sync_checkpoints",
  "usage_sync_issues",
  "admin_scopes",
  "billing_package_definitions",
  "billing_package_versions",
  "department_package_assignments",
  "billing_package_requests",
  "user_package_grants",
  "department_budget_periods",
  "department_budget_commitments",
  "request_billing_contexts",
  "usage_charge_allocations",
  "billing_operations",
  "newapi_quota_display_snapshots",
] as const;

function databaseUrl() {
  const url = getConfig().databaseUrl;
  if (!url) throw new Error("DATABASE_URL is required for the G package runtime");
  return url;
}

function getPool() {
  if (!pool) {
    const config = getConfig();
    pool = new Pool({
      connectionString: databaseUrl(),
      max: config.postgres.poolMax,
      idleTimeoutMillis: config.postgres.poolIdleTimeoutMs,
      connectionTimeoutMillis: config.postgres.poolConnectionTimeoutMs,
    });
  }
  return pool;
}

function getAdvisoryLockPool() {
  if (!advisoryLockPool) {
    const config = getConfig();
    advisoryLockPool = new Pool({
      connectionString: databaseUrl(),
      max: config.postgres.lockPoolMax,
      idleTimeoutMillis: config.postgres.poolIdleTimeoutMs,
      connectionTimeoutMillis: config.postgres.poolConnectionTimeoutMs,
    });
  }
  return advisoryLockPool;
}

async function connectWithMetrics(target: Pool, metrics: PoolAcquisitionMetrics) {
  const startedAt = performance.now();
  metrics.requestedTotal += 1;
  if (target.idleCount === 0 && target.totalCount >= (target.options.max ?? 10)) {
    metrics.queuedTotal += 1;
  }
  try {
    const client = await target.connect();
    const acquisitionMs = Math.max(performance.now() - startedAt, 0);
    metrics.acquiredTotal += 1;
    metrics.acquisitionMsTotal += acquisitionMs;
    metrics.acquisitionMsMax = Math.max(metrics.acquisitionMsMax, acquisitionMs);
    return client;
  } catch (error) {
    metrics.failedTotal += 1;
    throw error;
  }
}

function poolSnapshot(
  target: Pool | undefined,
  metrics: PoolAcquisitionMetrics,
  configuredMax: number,
) {
  return {
    initialized: Boolean(target),
    max: configuredMax,
    total: target?.totalCount ?? 0,
    idle: target?.idleCount ?? 0,
    waiting: target?.waitingCount ?? 0,
    ...metrics,
    acquisitionMsAverage:
      metrics.acquiredTotal > 0 ? metrics.acquisitionMsTotal / metrics.acquiredTotal : 0,
  };
}

export function postgresPoolSnapshot() {
  const config = getConfig();
  return {
    business: poolSnapshot(pool, businessPoolAcquisition, config.postgres.poolMax),
    advisoryLock: poolSnapshot(
      advisoryLockPool,
      lockPoolAcquisition,
      config.postgres.lockPoolMax,
    ),
  };
}

export async function withPostgresClient<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await connectWithMetrics(getPool(), businessPoolAcquisition);
  try { return await fn(client); } finally { client.release(); }
}

export async function withPostgresTransaction<T>(fn: (client: PoolClient) => Promise<T>) {
  return withPostgresClient(async (client) => {
    await client.query("begin");
    try {
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  });
}

export async function withPostgresAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>,
  options: { wait?: boolean } = {},
) {
  const client = await connectWithMetrics(getAdvisoryLockPool(), lockPoolAcquisition);
  try {
    if (options.wait) {
      await client.query("select pg_advisory_lock(hashtext($1)::bigint)", [key]);
    } else {
      const lock = await client.query<{ locked: boolean }>(
        "select pg_try_advisory_lock(hashtext($1)::bigint) as locked",
        [key],
      );
      if (!lock.rows[0]?.locked) throw new Error(`${key} is already running`);
    }
    try { return await fn(); }
    finally { await client.query("select pg_advisory_unlock(hashtext($1)::bigint)", [key]); }
  } finally {
    client.release();
  }
}

export async function checkPostgresConnection() {
  return withPostgresClient(async (client) => {
    await client.query("select 1");
    return true;
  });
}

export async function checkPostgresSchema() {
  return withPostgresClient(async (client) => {
    const result = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name = any($1::text[])`,
      [REQUIRED_POSTGRES_TABLES],
    );
    const existing = new Set(result.rows.map((row) => row.table_name));
    const missingTables = REQUIRED_POSTGRES_TABLES.filter((table) => !existing.has(table));
    return { ready: missingTables.length === 0, missingTables, tableCount: result.rowCount, error: undefined as string | undefined };
  });
}
