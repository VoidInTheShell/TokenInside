import assert from "node:assert/strict";
import test from "node:test";
import { getConfig } from "../lib/config.ts";

function withEnvironment(
  values: Record<string, string | undefined>,
  fn: () => void,
) {
  const previous = new Map(
    Object.keys(values).map((name) => [name, process.env[name]] as const),
  );
  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("uses bounded defaults for the control plane and NewAPI requests", () => {
  withEnvironment(
    {
      TOKENINSIDE_STORE_BACKEND: "postgres",
      DATABASE_POOL_MAX: undefined,
      DATABASE_LOCK_POOL_MAX: undefined,
      DATABASE_CONTROL_POOL_MAX: undefined,
      DATABASE_QUOTA_SUBMIT_POOL_MAX: undefined,
      DATABASE_QUOTA_SUBMIT_CONNECTION_TIMEOUT_MS: undefined,
      DATABASE_QUOTA_SUBMIT_STATEMENT_TIMEOUT_MS: undefined,
      DATABASE_QUOTA_SUBMIT_LOCK_TIMEOUT_MS: undefined,
      NEWAPI_REQUEST_TIMEOUT_MS: undefined,
      TOKENINSIDE_QUOTA_OPERATION_CONCURRENCY_MAX: undefined,
      TOKENINSIDE_DIRECT_CONSUMPTION_DRAIN_GRACE_MS: undefined,
    },
    () => {
      const config = getConfig();
      assert.equal(config.postgres.poolMax, 8);
      assert.equal(config.postgres.controlPoolMax, 4);
      assert.equal(config.postgres.quotaSubmitPoolMax, 2);
      assert.equal(config.postgres.quotaSubmitConnectionTimeoutMs, 1_000);
      assert.equal(config.postgres.quotaSubmitStatementTimeoutMs, 3_000);
      assert.equal(config.postgres.quotaSubmitLockTimeoutMs, 1_000);
      assert.equal(config.postgres.lockPoolMax, 10);
      assert.equal(config.newapi.requestTimeoutMs, 15_000);
      assert.equal(config.quotaControl.operationConcurrencyMax, 1);
      assert.equal(config.quotaControl.directConsumptionDrainGraceMs, 60_000);
      assert.equal("proxy" in config, false);
      assert.equal("billing" in config, false);
    },
  );
});

test("reads explicit control-plane pool and quota-operation limits", () => {
  withEnvironment(
    {
      TOKENINSIDE_STORE_BACKEND: "postgres",
      DATABASE_POOL_MAX: "11",
      DATABASE_LOCK_POOL_MAX: "7",
      DATABASE_CONTROL_POOL_MAX: "3",
      DATABASE_QUOTA_SUBMIT_POOL_MAX: "3",
      DATABASE_QUOTA_SUBMIT_CONNECTION_TIMEOUT_MS: "800",
      DATABASE_QUOTA_SUBMIT_STATEMENT_TIMEOUT_MS: "2500",
      DATABASE_QUOTA_SUBMIT_LOCK_TIMEOUT_MS: "900",
      NEWAPI_REQUEST_TIMEOUT_MS: "23000",
      TOKENINSIDE_QUOTA_OPERATION_CONCURRENCY_MAX: "2",
      TOKENINSIDE_DIRECT_CONSUMPTION_DRAIN_GRACE_MS: "45000",
    },
    () => {
      const config = getConfig();
      assert.equal(config.postgres.poolMax, 11);
      assert.equal(config.postgres.controlPoolMax, 3);
      assert.equal(config.postgres.quotaSubmitPoolMax, 3);
      assert.equal(config.postgres.quotaSubmitConnectionTimeoutMs, 800);
      assert.equal(config.postgres.quotaSubmitStatementTimeoutMs, 2_500);
      assert.equal(config.postgres.quotaSubmitLockTimeoutMs, 900);
      assert.equal(config.postgres.lockPoolMax, 7);
      assert.equal(config.newapi.requestTimeoutMs, 23_000);
      assert.equal(config.quotaControl.operationConcurrencyMax, 2);
      assert.equal(config.quotaControl.directConsumptionDrainGraceMs, 45_000);
    },
  );
});
