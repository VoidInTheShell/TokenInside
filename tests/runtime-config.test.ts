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

test("uses bounded defaults for PostgreSQL pools and NewAPI control requests", () => {
  withEnvironment(
    {
      DATABASE_POOL_MAX: undefined,
      DATABASE_SETTLEMENT_POOL_MAX: undefined,
      DATABASE_LOCK_POOL_MAX: undefined,
      DATABASE_CONTROL_POOL_MAX: undefined,
      DATABASE_QUOTA_SUBMIT_POOL_MAX: undefined,
      DATABASE_QUOTA_SUBMIT_CONNECTION_TIMEOUT_MS: undefined,
      DATABASE_QUOTA_SUBMIT_STATEMENT_TIMEOUT_MS: undefined,
      DATABASE_QUOTA_SUBMIT_LOCK_TIMEOUT_MS: undefined,
      NEWAPI_REQUEST_TIMEOUT_MS: undefined,
      TOKENINSIDE_PROXY_CONCURRENCY_MAX: undefined,
      TOKENINSIDE_PROXY_QUEUE_TIMEOUT_MS: undefined,
      TOKENINSIDE_PROXY_PREPARATION_CONCURRENCY_MAX: undefined,
      TOKENINSIDE_PROXY_PREPARATION_QUEUE_TIMEOUT_MS: undefined,
      TOKENINSIDE_PROXY_PERSISTENCE_CONCURRENCY_MAX: undefined,
      TOKENINSIDE_PROXY_UPSTREAM_MAX_ATTEMPTS: undefined,
      TOKENINSIDE_QUOTA_OPERATION_CONCURRENCY_MAX: undefined,
      TOKENINSIDE_BILLING_MATERIALIZATION_CONCURRENCY_MAX: undefined,
      TOKENINSIDE_USAGE_SYNC_CONTINUATION_DELAY_MS: undefined,
    },
    () => {
      const config = getConfig();
      assert.equal(config.postgres.poolMax, 8);
      assert.equal(config.postgres.settlementPoolMax, 2);
      assert.equal(config.postgres.controlPoolMax, 4);
      assert.equal(config.postgres.quotaSubmitPoolMax, 2);
      assert.equal(config.postgres.quotaSubmitConnectionTimeoutMs, 1_000);
      assert.equal(config.postgres.quotaSubmitStatementTimeoutMs, 3_000);
      assert.equal(config.postgres.quotaSubmitLockTimeoutMs, 1_000);
      assert.equal(config.postgres.lockPoolMax, 10);
      assert.equal(config.newapi.requestTimeoutMs, 15_000);
      assert.equal(config.proxy.maxConcurrency, 480);
      assert.equal(config.proxy.queueTimeoutMs, 30_000);
      assert.equal(config.proxy.preparationMaxConcurrency, 8);
      assert.equal(config.proxy.preparationQueueTimeoutMs, 30_000);
      assert.equal(config.proxy.persistenceMaxConcurrency, 8);
      assert.equal(config.proxy.upstreamMaxAttempts, 2);
      assert.equal(config.billing.operationConcurrencyMax, 1);
      assert.equal(config.billing.materializationConcurrencyMax, 4);
      assert.equal(config.billing.usageSyncContinuationDelayMs, 250);
    },
  );
});

test("reads explicit PostgreSQL pool and NewAPI timeout limits", () => {
  withEnvironment(
    {
      DATABASE_POOL_MAX: "11",
      DATABASE_SETTLEMENT_POOL_MAX: "4",
      DATABASE_LOCK_POOL_MAX: "7",
      DATABASE_CONTROL_POOL_MAX: "3",
      DATABASE_QUOTA_SUBMIT_POOL_MAX: "3",
      DATABASE_QUOTA_SUBMIT_CONNECTION_TIMEOUT_MS: "800",
      DATABASE_QUOTA_SUBMIT_STATEMENT_TIMEOUT_MS: "2500",
      DATABASE_QUOTA_SUBMIT_LOCK_TIMEOUT_MS: "900",
      NEWAPI_REQUEST_TIMEOUT_MS: "23000",
      TOKENINSIDE_PROXY_CONCURRENCY_MAX: "12",
      TOKENINSIDE_PROXY_QUEUE_TIMEOUT_MS: "45000",
      TOKENINSIDE_PROXY_PREPARATION_CONCURRENCY_MAX: "6",
      TOKENINSIDE_PROXY_PREPARATION_QUEUE_TIMEOUT_MS: "12000",
      TOKENINSIDE_PROXY_PERSISTENCE_CONCURRENCY_MAX: "5",
      TOKENINSIDE_PROXY_UPSTREAM_MAX_ATTEMPTS: "3",
      TOKENINSIDE_QUOTA_OPERATION_CONCURRENCY_MAX: "2",
      TOKENINSIDE_BILLING_MATERIALIZATION_CONCURRENCY_MAX: "2",
      TOKENINSIDE_USAGE_SYNC_CONTINUATION_DELAY_MS: "125",
    },
    () => {
      const config = getConfig();
      assert.equal(config.postgres.poolMax, 11);
      assert.equal(config.postgres.settlementPoolMax, 4);
      assert.equal(config.postgres.controlPoolMax, 3);
      assert.equal(config.postgres.quotaSubmitPoolMax, 3);
      assert.equal(config.postgres.quotaSubmitConnectionTimeoutMs, 800);
      assert.equal(config.postgres.quotaSubmitStatementTimeoutMs, 2_500);
      assert.equal(config.postgres.quotaSubmitLockTimeoutMs, 900);
      assert.equal(config.postgres.lockPoolMax, 7);
      assert.equal(config.newapi.requestTimeoutMs, 23_000);
      assert.equal(config.proxy.maxConcurrency, 12);
      assert.equal(config.proxy.queueTimeoutMs, 45_000);
      assert.equal(config.proxy.preparationMaxConcurrency, 6);
      assert.equal(config.proxy.preparationQueueTimeoutMs, 12_000);
      assert.equal(config.proxy.persistenceMaxConcurrency, 5);
      assert.equal(config.proxy.upstreamMaxAttempts, 3);
      assert.equal(config.billing.operationConcurrencyMax, 2);
      assert.equal(config.billing.materializationConcurrencyMax, 2);
      assert.equal(config.billing.usageSyncContinuationDelayMs, 125);
    },
  );
});
