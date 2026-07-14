import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireProxyConcurrencySlot,
  ProxyQueueTimeoutError,
  proxyConcurrencySnapshot,
} from "../lib/proxy-concurrency.ts";

test("rejects immediately when the upstream gate is full and queue capacity is zero", async () => {
  const previousMax = process.env.TOKENINSIDE_PROXY_CONCURRENCY_MAX;
  const previousQueueMax = process.env.TOKENINSIDE_PROXY_QUEUE_MAX;
  process.env.TOKENINSIDE_PROXY_CONCURRENCY_MAX = "1";
  process.env.TOKENINSIDE_PROXY_QUEUE_MAX = "0";
  const before = proxyConcurrencySnapshot();
  const release = await acquireProxyConcurrencySlot();
  try {
    await assert.rejects(acquireProxyConcurrencySlot(), ProxyQueueTimeoutError);
    const during = proxyConcurrencySnapshot();
    assert.equal(during.active, 1);
    assert.equal(during.queued, 0);
    assert.equal(during.enqueuedTotal - before.enqueuedTotal, 0);
    assert.equal(during.rejectedTotal - before.rejectedTotal, 1);
  } finally {
    release();
    if (previousMax === undefined) delete process.env.TOKENINSIDE_PROXY_CONCURRENCY_MAX;
    else process.env.TOKENINSIDE_PROXY_CONCURRENCY_MAX = previousMax;
    if (previousQueueMax === undefined) delete process.env.TOKENINSIDE_PROXY_QUEUE_MAX;
    else process.env.TOKENINSIDE_PROXY_QUEUE_MAX = previousQueueMax;
  }
});
