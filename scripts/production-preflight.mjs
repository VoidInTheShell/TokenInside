import { access, constants } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { createClient } from "redis";

const placeholderPatterns = [
  /^$/,
  /^replace-/i,
  /replace-with/i,
  /placeholder/i,
  /example/i,
];

function present(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0;
}

function safe(name) {
  const value = process.env[name]?.trim() ?? "";
  return present(name) && !placeholderPatterns.some((pattern) => pattern.test(value));
}

function result(name, ok, note) {
  return { name, ok, note };
}

async function canWriteDirectory(filePath) {
  try {
    const directory = path.dirname(path.resolve(filePath));
    await access(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function canConnectPostgres() {
  if (!present("DATABASE_URL")) return false;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  try {
    const client = await pool.connect();
    try {
      await client.query("select 1");
      return true;
    } finally {
      client.release();
    }
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

const requiredPostgresTables = [
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
];

const forbiddenLegacyTables = [
  "token_requests",
  "user_billing_periods",
  "department_quota_periods",
  "department_quota_requests",
  "quota_change_events",
  "user_quota_policies",
  "quota_operations",
  "quota_ledger_entries",
  "user_quota_states",
  "quota_reconciliation_records",
];

async function hasPostgresSchema() {
  if (!present("DATABASE_URL")) return false;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  try {
    const result = await pool.query(
      `select table_name
       from information_schema.tables
       where table_schema = 'public' and table_name = any($1::text[])`,
      [requiredPostgresTables],
    );
    return new Set(result.rows.map((row) => row.table_name)).size === requiredPostgresTables.length;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

async function canConnectRedis() {
  if (!present("TOKENINSIDE_REDIS_URL")) return false;
  const client = createClient({
    url: process.env.TOKENINSIDE_REDIS_URL,
    socket: {
      connectTimeout: Number(process.env.TOKENINSIDE_REDIS_CONNECT_TIMEOUT_MS ?? "1000"),
      reconnectStrategy: false,
    },
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
    return (await client.ping()) === "PONG";
  } catch {
    return false;
  } finally {
    if (client.isOpen) await client.close().catch(() => client.destroy());
  }
}

async function legacyQuotaSchemaAbsent() {
  if (!present("DATABASE_URL")) return false;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const result = await pool.query(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name = any($1::text[])`,
      [forbiddenLegacyTables],
    );
    return result.rowCount === 0;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

const storeBackend = process.env.TOKENINSIDE_STORE_BACKEND ?? "json";
const redisRequired = process.env.TOKENINSIDE_REDIS_REQUIRED === "true";
const checks = [
  result("NODE_ENV", process.env.NODE_ENV === "production", "must be production"),
  result("PORT", process.env.PORT === "16878", "must listen on 16878"),
  result("TOKENINSIDE_PUBLIC_BASE_URL", safe("TOKENINSIDE_PUBLIC_BASE_URL"), "must be a real public URL"),
  result("TOKENINSIDE_SESSION_SECRET", safe("TOKENINSIDE_SESSION_SECRET"), "must be a real random secret"),
  result("FEISHU_APP_ID", safe("FEISHU_APP_ID"), "required for Feishu OAuth"),
  result("FEISHU_APP_SECRET", safe("FEISHU_APP_SECRET"), "required for Feishu OAuth"),
  result(
    "FEISHU_APPROVAL_EVENT_VERIFICATION_TOKEN",
    safe("FEISHU_APPROVAL_EVENT_VERIFICATION_TOKEN"),
    "required for event verification",
  ),
  result("NEWAPI_BASE_URL", safe("NEWAPI_BASE_URL"), "required for proxy/control-plane calls"),
  result("NEWAPI_CONTROL_USER_ID", safe("NEWAPI_CONTROL_USER_ID"), "required for NewAPI token APIs"),
  result(
    "NEWAPI_CONTROL_CREDENTIAL",
    ["NEWAPI_ACCESS_TOKEN", "NEWAPI_ADMIN_ACCESS_TOKEN", "NEWAPI_SYSTEM_AK"].some(safe),
    "one NewAPI control credential must be configured",
  ),
  result(
    "TOKENINSIDE_STORE_BACKEND",
    storeBackend === "postgres",
    "G package runtime requires postgres",
  ),
  result(
    "TOKENINSIDE_REDIS_REQUIRED",
    redisRequired,
    "Redis hot-path cache is required for the Redis plus PostgreSQL runtime",
  ),
  result("TOKENINSIDE_REDIS_URL", safe("TOKENINSIDE_REDIS_URL"), "Redis URL must be configured"),
  result("REDIS_CONNECTION", await canConnectRedis(), "Redis must accept connections"),
  result(
    "NEWAPI_REQUEST_TIMEOUT_MS",
    Number.isInteger(Number(process.env.NEWAPI_REQUEST_TIMEOUT_MS ?? "15000")) &&
      Number(process.env.NEWAPI_REQUEST_TIMEOUT_MS ?? "15000") >= 1000,
    "must be an integer of at least 1000 milliseconds",
  ),
  result(
    "TOKENINSIDE_PROXY_CONCURRENCY_MAX",
    Number.isInteger(Number(process.env.TOKENINSIDE_PROXY_CONCURRENCY_MAX ?? "60")) &&
      Number(process.env.TOKENINSIDE_PROXY_CONCURRENCY_MAX ?? "60") >= 1,
    "must be a positive integer",
  ),
  result(
    "TOKENINSIDE_PROXY_QUEUE_TIMEOUT_MS",
    Number.isInteger(Number(process.env.TOKENINSIDE_PROXY_QUEUE_TIMEOUT_MS ?? "30000")) &&
      Number(process.env.TOKENINSIDE_PROXY_QUEUE_TIMEOUT_MS ?? "30000") >= 1000,
    "must be an integer of at least 1000 milliseconds",
  ),
];

if (storeBackend === "postgres") {
  const businessPoolMax = Number(process.env.DATABASE_POOL_MAX ?? "10");
  const lockPoolMax = Number(process.env.DATABASE_LOCK_POOL_MAX ?? "10");
  const postgresMaxConnections = Number(process.env.POSTGRES_MAX_CONNECTIONS ?? "30");
  const postgresReservedConnections = Number(
    process.env.POSTGRES_SUPERUSER_RESERVED_CONNECTIONS ?? "3",
  );
  checks.push(result("DATABASE_URL", safe("DATABASE_URL"), "required when store backend is postgres"));
  checks.push(result("POSTGRES_CONNECTION", await canConnectPostgres(), "PostgreSQL must accept connections"));
  checks.push(result("POSTGRES_SCHEMA", await hasPostgresSchema(), "all required tables must exist"));
  checks.push(result("LEGACY_QUOTA_SCHEMA", await legacyQuotaSchemaAbsent(), "legacy quota tables must be absent"));
  checks.push(
    result(
      "DATABASE_POOL_MAX",
      Number.isInteger(businessPoolMax) && businessPoolMax >= 2,
      "business pool max must be an integer of at least 2",
    ),
  );
  checks.push(
    result(
      "DATABASE_LOCK_POOL_MAX",
      Number.isInteger(lockPoolMax) && lockPoolMax >= 1,
      "advisory lock pool max must be a positive integer",
    ),
  );
  checks.push(
    result(
      "POSTGRES_APP_CONNECTION_BUDGET",
      Number.isInteger(postgresMaxConnections) &&
        Number.isInteger(postgresReservedConnections) &&
        businessPoolMax + lockPoolMax + 5 <
          postgresMaxConnections - postgresReservedConnections,
      "business pool + lock pool + 5 maintenance connections must stay below PostgreSQL usable connections",
    ),
  );
}

const ok = checks.every((check) => check.ok);
console.log(JSON.stringify({ ok, storeBackend, checks }));
if (!ok) process.exitCode = 1;
