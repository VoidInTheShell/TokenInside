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
      NEWAPI_REQUEST_TIMEOUT_MS: undefined,
      TOKENINSIDE_PROXY_CONCURRENCY_MAX: undefined,
      TOKENINSIDE_PROXY_QUEUE_TIMEOUT_MS: undefined,
    },
    () => {
      const config = getConfig();
      assert.equal(config.postgres.lockPoolMax, 10);
      assert.equal(config.newapi.requestTimeoutMs, 15_000);
      assert.equal(config.proxy.maxConcurrency, 60);
      assert.equal(config.proxy.queueTimeoutMs, 30_000);
    },
  );
});

test("reads explicit advisory lock pool and NewAPI timeout limits", () => {
  withEnvironment(
    {
      DATABASE_LOCK_POOL_MAX: "7",
      NEWAPI_REQUEST_TIMEOUT_MS: "23000",
      TOKENINSIDE_PROXY_CONCURRENCY_MAX: "12",
      TOKENINSIDE_PROXY_QUEUE_TIMEOUT_MS: "45000",
    },
    () => {
      const config = getConfig();
      assert.equal(config.postgres.lockPoolMax, 7);
      assert.equal(config.newapi.requestTimeoutMs, 23_000);
      assert.equal(config.proxy.maxConcurrency, 12);
      assert.equal(config.proxy.queueTimeoutMs, 45_000);
    },
  );
});
