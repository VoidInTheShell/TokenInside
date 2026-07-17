import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const preflightPath = new URL("../scripts/production-preflight.mjs", import.meta.url);
const performanceProfilePath = new URL("../performance-300.env.example", import.meta.url);
const environmentExamplePaths = [
  new URL("../.env.example", import.meta.url),
  new URL("../.env.production.example", import.meta.url),
];

function parseEnvironmentExample(source: string) {
  const values = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

function integerValue(values: Map<string, string>, name: string) {
  const value = Number(values.get(name));
  assert.ok(Number.isInteger(value), `${name} must be an integer`);
  return value;
}

test("production preflight budgets business, settlement, control, quota-submit, and lock pools", async () => {
  const source = await readFile(preflightPath, "utf8");
  const postgresChecks = source.slice(source.indexOf('if (storeBackend === "postgres")'));

  assert.match(
    postgresChecks,
    /const settlementPoolMax = Number\(process\.env\.DATABASE_SETTLEMENT_POOL_MAX \?\? "2"\)/,
  );
  assert.match(
    postgresChecks,
    /const controlPoolMax = Number\(process\.env\.DATABASE_CONTROL_POOL_MAX \?\? "4"\)/,
  );
  assert.match(
    postgresChecks,
    /const quotaSubmitPoolMax = Number\(process\.env\.DATABASE_QUOTA_SUBMIT_POOL_MAX \?\? "2"\)/,
  );
  assert.match(postgresChecks, /"DATABASE_SETTLEMENT_POOL_MAX"/);
  assert.match(
    postgresChecks,
    /Number\.isInteger\(settlementPoolMax\) && settlementPoolMax >= 1/,
  );
  assert.match(postgresChecks, /"DATABASE_CONTROL_POOL_MAX"/);
  assert.match(postgresChecks, /Number\.isInteger\(controlPoolMax\) && controlPoolMax >= 1/);
  assert.match(postgresChecks, /"DATABASE_QUOTA_SUBMIT_POOL_MAX"/);
  assert.match(
    postgresChecks,
    /Number\.isInteger\(quotaSubmitPoolMax\) && quotaSubmitPoolMax >= 1/,
  );
  assert.match(
    postgresChecks,
    /\["DATABASE_QUOTA_SUBMIT_CONNECTION_TIMEOUT_MS", "1000"\]/,
  );
  assert.match(
    postgresChecks,
    /\["DATABASE_QUOTA_SUBMIT_STATEMENT_TIMEOUT_MS", "3000"\]/,
  );
  assert.match(
    postgresChecks,
    /\["DATABASE_QUOTA_SUBMIT_LOCK_TIMEOUT_MS", "1000"\]/,
  );
  assert.match(
    postgresChecks,
    /businessPoolMax \+ settlementPoolMax \+ controlPoolMax \+ quotaSubmitPoolMax \+ lockPoolMax \+ 5\s*<\s*postgresMaxConnections - postgresReservedConnections/,
  );
});

test("200+30 checkpoint preserves six PostgreSQL connections after test pools", async () => {
  const values = parseEnvironmentExample(await readFile(performanceProfilePath, "utf8"));
  const business = integerValue(values, "DATABASE_POOL_MAX");
  const settlementPool = integerValue(values, "DATABASE_SETTLEMENT_POOL_MAX");
  const control = integerValue(values, "DATABASE_CONTROL_POOL_MAX");
  const quotaSubmit = integerValue(values, "DATABASE_QUOTA_SUBMIT_POOL_MAX");
  const lock = integerValue(values, "DATABASE_LOCK_POOL_MAX");
  const maxConnections = integerValue(values, "POSTGRES_MAX_CONNECTIONS");
  const reserved = integerValue(values, "POSTGRES_SUPERUSER_RESERVED_CONNECTIONS");

  assert.deepEqual(
    {
      business,
      settlementPool,
      control,
      quotaSubmit,
      quotaSubmitConnectionTimeoutMs: integerValue(
        values,
        "DATABASE_QUOTA_SUBMIT_CONNECTION_TIMEOUT_MS",
      ),
      quotaSubmitStatementTimeoutMs: integerValue(
        values,
        "DATABASE_QUOTA_SUBMIT_STATEMENT_TIMEOUT_MS",
      ),
      quotaSubmitLockTimeoutMs: integerValue(
        values,
        "DATABASE_QUOTA_SUBMIT_LOCK_TIMEOUT_MS",
      ),
      lock,
      proxy: integerValue(values, "TOKENINSIDE_PROXY_CONCURRENCY_MAX"),
      preparation: integerValue(values, "TOKENINSIDE_PROXY_PREPARATION_CONCURRENCY_MAX"),
      persistence: integerValue(values, "TOKENINSIDE_PROXY_PERSISTENCE_CONCURRENCY_MAX"),
      quotaOperations: integerValue(values, "TOKENINSIDE_QUOTA_OPERATION_CONCURRENCY_MAX"),
      settlement: integerValue(values, "TOKENINSIDE_USAGE_SETTLEMENT_CONCURRENCY_MAX"),
      materialization: integerValue(
        values,
        "TOKENINSIDE_BILLING_MATERIALIZATION_CONCURRENCY_MAX",
      ),
      maxConnections,
      reserved,
    },
    {
      business: 56,
      settlementPool: 4,
      control: 6,
      quotaSubmit: 3,
      quotaSubmitConnectionTimeoutMs: 1_000,
      quotaSubmitStatementTimeoutMs: 3_000,
      quotaSubmitLockTimeoutMs: 1_000,
      lock: 5,
      proxy: 300,
      preparation: 40,
      persistence: 12,
      quotaOperations: 1,
      settlement: 6,
      materialization: 2,
      maxConnections: 96,
      reserved: 8,
    },
  );

  const externalObserverAndDriverPools = 4 + 4;
  assert.equal(business + settlementPool + control + quotaSubmit + lock, 74);
  assert.equal(
    integerValue(values, "TOKENINSIDE_PROXY_PREPARATION_CONCURRENCY_MAX") +
      integerValue(values, "TOKENINSIDE_PROXY_PERSISTENCE_CONCURRENCY_MAX"),
    business - 4,
  );
  const remaining =
    maxConnections -
    reserved -
    business -
    settlementPool -
    control -
    quotaSubmit -
    lock -
    externalObserverAndDriverPools;
  assert.equal(remaining, 6);
});

test("checked-in deployment examples satisfy the preflight connection budget", async () => {
  for (const examplePath of environmentExamplePaths) {
    const values = parseEnvironmentExample(await readFile(examplePath, "utf8"));
    const appConnections =
      integerValue(values, "DATABASE_POOL_MAX") +
      integerValue(values, "DATABASE_SETTLEMENT_POOL_MAX") +
      integerValue(values, "DATABASE_CONTROL_POOL_MAX") +
      integerValue(values, "DATABASE_QUOTA_SUBMIT_POOL_MAX") +
      integerValue(values, "DATABASE_LOCK_POOL_MAX");
    const usableConnections =
      integerValue(values, "POSTGRES_MAX_CONNECTIONS") -
      integerValue(values, "POSTGRES_SUPERUSER_RESERVED_CONNECTIONS");

    assert.ok(appConnections + 5 < usableConnections);
  }
});
