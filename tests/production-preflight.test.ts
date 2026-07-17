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

test("production preflight budgets business, control, and lock pools", async () => {
  const source = await readFile(preflightPath, "utf8");
  const postgresChecks = source.slice(source.indexOf('if (storeBackend === "postgres")'));

  assert.match(
    postgresChecks,
    /const controlPoolMax = Number\(process\.env\.DATABASE_CONTROL_POOL_MAX \?\? "4"\)/,
  );
  assert.match(postgresChecks, /"DATABASE_CONTROL_POOL_MAX"/);
  assert.match(postgresChecks, /Number\.isInteger\(controlPoolMax\) && controlPoolMax >= 1/);
  assert.match(
    postgresChecks,
    /businessPoolMax \+ controlPoolMax \+ lockPoolMax \+ 5\s*<\s*postgresMaxConnections - postgresReservedConnections/,
  );
});

test("300-concurrency checkpoint preserves seven PostgreSQL connections after test pools", async () => {
  const values = parseEnvironmentExample(await readFile(performanceProfilePath, "utf8"));
  const business = integerValue(values, "DATABASE_POOL_MAX");
  const control = integerValue(values, "DATABASE_CONTROL_POOL_MAX");
  const lock = integerValue(values, "DATABASE_LOCK_POOL_MAX");
  const maxConnections = integerValue(values, "POSTGRES_MAX_CONNECTIONS");
  const reserved = integerValue(values, "POSTGRES_SUPERUSER_RESERVED_CONNECTIONS");

  assert.deepEqual(
    {
      business,
      control,
      lock,
      proxy: integerValue(values, "TOKENINSIDE_PROXY_CONCURRENCY_MAX"),
      preparation: integerValue(values, "TOKENINSIDE_PROXY_PREPARATION_CONCURRENCY_MAX"),
      persistence: integerValue(values, "TOKENINSIDE_PROXY_PERSISTENCE_CONCURRENCY_MAX"),
      quotaOperations: integerValue(values, "TOKENINSIDE_QUOTA_OPERATION_CONCURRENCY_MAX"),
      settlement: integerValue(values, "TOKENINSIDE_USAGE_SETTLEMENT_CONCURRENCY_MAX"),
      maxConnections,
      reserved,
    },
    {
      business: 60,
      control: 8,
      lock: 5,
      proxy: 300,
      preparation: 56,
      persistence: 4,
      quotaOperations: 4,
      settlement: 6,
      maxConnections: 96,
      reserved: 8,
    },
  );

  const externalObserverAndDriverPools = 4 + 4;
  const remaining =
    maxConnections - reserved - business - control - lock - externalObserverAndDriverPools;
  assert.equal(remaining, 7);
});

test("checked-in deployment examples satisfy the preflight connection budget", async () => {
  for (const examplePath of environmentExamplePaths) {
    const values = parseEnvironmentExample(await readFile(examplePath, "utf8"));
    const appConnections =
      integerValue(values, "DATABASE_POOL_MAX") +
      integerValue(values, "DATABASE_CONTROL_POOL_MAX") +
      integerValue(values, "DATABASE_LOCK_POOL_MAX");
    const usableConnections =
      integerValue(values, "POSTGRES_MAX_CONNECTIONS") -
      integerValue(values, "POSTGRES_SUPERUSER_RESERVED_CONNECTIONS");

    assert.ok(appConnections + 5 < usableConnections);
  }
});
