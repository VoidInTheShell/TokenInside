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

test("uses bounded defaults for the advisory lock pool and NewAPI control requests", () => {
  withEnvironment(
    {
      DATABASE_LOCK_POOL_MAX: undefined,
      TOKENINSIDE_REDIS_URL: undefined,
      TOKENINSIDE_REDIS_REQUIRED: undefined,
      TOKENINSIDE_REDIS_PRINCIPAL_TTL_SECONDS: undefined,
      NEWAPI_REQUEST_TIMEOUT_MS: undefined,
      TOKENINSIDE_PROXY_CONCURRENCY_MAX: undefined,
      TOKENINSIDE_PROXY_QUEUE_MAX: undefined,
      TOKENINSIDE_PROXY_QUEUE_TIMEOUT_MS: undefined,
      TOKENINSIDE_PROXY_PREPARATION_CONCURRENCY_MAX: undefined,
      TOKENINSIDE_PROXY_PREPARATION_QUEUE_MAX: undefined,
      TOKENINSIDE_PROXY_PREPARATION_QUEUE_TIMEOUT_MS: undefined,
      TOKENINSIDE_PROXY_UPSTREAM_MAX_ATTEMPTS: undefined,
    },
    () => {
      const config = getConfig();
      assert.equal(config.postgres.lockPoolMax, 10);
      assert.equal(config.redis.url, undefined);
      assert.equal(config.redis.required, false);
      assert.equal(config.redis.principalTtlSeconds, 300);
      assert.equal(config.newapi.requestTimeoutMs, 90_000);
      assert.equal(config.proxy.maxConcurrency, 480);
      assert.equal(config.proxy.queueMax, 0);
      assert.equal(config.proxy.queueTimeoutMs, 30_000);
      assert.equal(config.proxy.preparationMaxConcurrency, 8);
      assert.equal(config.proxy.preparationQueueMax, 0);
      assert.equal(config.proxy.preparationQueueTimeoutMs, 30_000);
      assert.equal(config.proxy.upstreamMaxAttempts, 2);
    },
  );
});

test("reads explicit advisory lock pool and NewAPI timeout limits", () => {
  withEnvironment(
    {
      DATABASE_LOCK_POOL_MAX: "7",
      TOKENINSIDE_REDIS_URL: "redis://redis:6379/0",
      TOKENINSIDE_REDIS_REQUIRED: "true",
      TOKENINSIDE_REDIS_PRINCIPAL_TTL_SECONDS: "90",
      NEWAPI_REQUEST_TIMEOUT_MS: "23000",
      TOKENINSIDE_PROXY_CONCURRENCY_MAX: "12",
      TOKENINSIDE_PROXY_QUEUE_MAX: "4",
      TOKENINSIDE_PROXY_QUEUE_TIMEOUT_MS: "45000",
      TOKENINSIDE_PROXY_PREPARATION_CONCURRENCY_MAX: "6",
      TOKENINSIDE_PROXY_PREPARATION_QUEUE_MAX: "2",
      TOKENINSIDE_PROXY_PREPARATION_QUEUE_TIMEOUT_MS: "12000",
      TOKENINSIDE_PROXY_UPSTREAM_MAX_ATTEMPTS: "3",
    },
    () => {
      const config = getConfig();
      assert.equal(config.postgres.lockPoolMax, 7);
      assert.equal(config.redis.url, "redis://redis:6379/0");
      assert.equal(config.redis.required, true);
      assert.equal(config.redis.principalTtlSeconds, 90);
      assert.equal(config.newapi.requestTimeoutMs, 23_000);
      assert.equal(config.proxy.maxConcurrency, 12);
      assert.equal(config.proxy.queueMax, 4);
      assert.equal(config.proxy.queueTimeoutMs, 45_000);
      assert.equal(config.proxy.preparationMaxConcurrency, 6);
      assert.equal(config.proxy.preparationQueueMax, 2);
      assert.equal(config.proxy.preparationQueueTimeoutMs, 12_000);
      assert.equal(config.proxy.upstreamMaxAttempts, 3);
    },
  );
});
