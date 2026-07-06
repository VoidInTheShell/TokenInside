import { access, constants } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

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

const storeBackend = process.env.TOKENINSIDE_STORE_BACKEND ?? "json";
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
    storeBackend === "json" || storeBackend === "postgres",
    "must be json or postgres",
  ),
];

if (storeBackend === "json") {
  const storePath = process.env.TOKENINSIDE_STORE_PATH ?? ".local-data/tokeninside.json";
  checks.push(
    result(
      "TOKENINSIDE_STORE_PATH",
      await canWriteDirectory(storePath),
      "JSON store directory must be writable",
    ),
  );
}

if (storeBackend === "postgres") {
  checks.push(result("DATABASE_URL", safe("DATABASE_URL"), "required when store backend is postgres"));
  checks.push(result("POSTGRES_CONNECTION", await canConnectPostgres(), "PostgreSQL must accept connections"));
  checks.push(
    result(
      "DATABASE_POOL_MAX",
      Number.isInteger(Number(process.env.DATABASE_POOL_MAX ?? "10")) &&
        Number(process.env.DATABASE_POOL_MAX ?? "10") > 0,
      "pool max must be a positive integer",
    ),
  );
}

const ok = checks.every((check) => check.ok);
console.log(JSON.stringify({ ok, storeBackend, checks }));
if (!ok) process.exitCode = 1;
