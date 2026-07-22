import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const preflightPath = new URL("../scripts/production-preflight.mjs", import.meta.url);
const environmentExamplePaths = [
  new URL("../tokeninside.env.example", import.meta.url),
  new URL("../tokeninside.env.production.example", import.meta.url),
  new URL("../postgres-pools.env.example", import.meta.url),
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

test("production preflight validates only control-plane runtime limits", async () => {
  const source = await readFile(preflightPath, "utf8");
  const postgresChecks = source.slice(source.indexOf('if (storeBackend === "postgres")'));

  assert.match(source, /"TOKENINSIDE_QUOTA_OPERATION_CONCURRENCY_MAX"/);
  assert.match(source, /"TOKENINSIDE_DIRECT_CONSUMPTION_DRAIN_GRACE_MS"/);
  assert.doesNotMatch(source, /TOKENINSIDE_PROXY_/);
  assert.doesNotMatch(source, /BILLING_MATERIALIZATION/);
  assert.doesNotMatch(source, /DATABASE_SETTLEMENT_POOL_MAX/);
  assert.match(postgresChecks, /"DATABASE_CONTROL_POOL_MAX"/);
  assert.match(postgresChecks, /"DATABASE_QUOTA_SUBMIT_POOL_MAX"/);
  assert.match(postgresChecks, /"DATABASE_LOCK_POOL_MAX"/);
  assert.match(
    postgresChecks,
    /businessPoolMax \+ controlPoolMax \+ quotaSubmitPoolMax \+ lockPoolMax \+ 5\s*<\s*postgresMaxConnections - postgresReservedConnections/,
  );
});

test("checked-in environments fit the control-plane PostgreSQL connection budget", async () => {
  for (const examplePath of environmentExamplePaths) {
    const source = await readFile(examplePath, "utf8");
    const values = parseEnvironmentExample(source);
    const appConnections =
      integerValue(values, "DATABASE_POOL_MAX") +
      integerValue(values, "DATABASE_CONTROL_POOL_MAX") +
      integerValue(values, "DATABASE_QUOTA_SUBMIT_POOL_MAX") +
      integerValue(values, "DATABASE_LOCK_POOL_MAX");
    const usableConnections =
      integerValue(values, "POSTGRES_MAX_CONNECTIONS") -
      integerValue(values, "POSTGRES_SUPERUSER_RESERVED_CONNECTIONS");

    assert.ok(appConnections + 5 < usableConnections, examplePath.pathname);
    assert.doesNotMatch(source, /TOKENINSIDE_PROXY_/);
    assert.doesNotMatch(source, /TOKENINSIDE_USAGE_SETTLEMENT_/);
    assert.doesNotMatch(source, /BILLING_MATERIALIZATION/);
    assert.doesNotMatch(source, /DATABASE_SETTLEMENT_POOL_MAX/);
  }
});
