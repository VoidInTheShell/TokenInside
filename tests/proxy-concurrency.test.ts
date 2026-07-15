import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireProxyConcurrencySlot,
  acquireProxyPreparationSlot,
  proxyConcurrencySnapshot,
} from "../lib/proxy-concurrency.ts";

test("proxy concurrency uses parallel slots and admits queued work in FIFO order", async () => {
  const previousMax = process.env.TOKENINSIDE_PROXY_CONCURRENCY_MAX;
  const previousTimeout = process.env.TOKENINSIDE_PROXY_QUEUE_TIMEOUT_MS;
  process.env.TOKENINSIDE_PROXY_CONCURRENCY_MAX = "2";
  process.env.TOKENINSIDE_PROXY_QUEUE_TIMEOUT_MS = "1000";
  const releases: Array<() => void> = [];
  try {
    releases.push(await acquireProxyConcurrencySlot());
    releases.push(await acquireProxyConcurrencySlot());
    assert.deepEqual(proxyConcurrencySnapshot(), {
      active: 2,
      queued: 0,
      maxConcurrency: 2,
      preparation: { active: 0, queued: 0, maxConcurrency: 8 },
    });

    let thirdAdmitted = false;
    const third = acquireProxyConcurrencySlot().then((release) => {
      thirdAdmitted = true;
      releases.push(release);
    });
    await Promise.resolve();
    assert.equal(thirdAdmitted, false);
    assert.equal(proxyConcurrencySnapshot().queued, 1);

    releases.shift()?.();
    await third;
    assert.equal(thirdAdmitted, true);
    assert.deepEqual(proxyConcurrencySnapshot(), {
      active: 2,
      queued: 0,
      maxConcurrency: 2,
      preparation: { active: 0, queued: 0, maxConcurrency: 8 },
    });
  } finally {
    for (const release of releases) release();
    if (previousMax === undefined) delete process.env.TOKENINSIDE_PROXY_CONCURRENCY_MAX;
    else process.env.TOKENINSIDE_PROXY_CONCURRENCY_MAX = previousMax;
    if (previousTimeout === undefined) delete process.env.TOKENINSIDE_PROXY_QUEUE_TIMEOUT_MS;
    else process.env.TOKENINSIDE_PROXY_QUEUE_TIMEOUT_MS = previousTimeout;
  }
  assert.equal(proxyConcurrencySnapshot().active, 0);
});

test("proxy preparation gate bounds database work independently", async () => {
  const previousMax = process.env.TOKENINSIDE_PROXY_PREPARATION_CONCURRENCY_MAX;
  const previousTimeout = process.env.TOKENINSIDE_PROXY_PREPARATION_QUEUE_TIMEOUT_MS;
  process.env.TOKENINSIDE_PROXY_PREPARATION_CONCURRENCY_MAX = "1";
  process.env.TOKENINSIDE_PROXY_PREPARATION_QUEUE_TIMEOUT_MS = "1000";
  const firstRelease = await acquireProxyPreparationSlot();
  try {
    let secondAdmitted = false;
    let secondRelease: (() => void) | undefined;
    const second = acquireProxyPreparationSlot().then((release) => {
      secondAdmitted = true;
      secondRelease = release;
    });
    await Promise.resolve();
    assert.equal(secondAdmitted, false);
    assert.deepEqual(proxyConcurrencySnapshot().preparation, {
      active: 1,
      queued: 1,
      maxConcurrency: 1,
    });
    firstRelease();
    await second;
    assert.equal(secondAdmitted, true);
    secondRelease?.();
  } finally {
    firstRelease();
    if (previousMax === undefined) delete process.env.TOKENINSIDE_PROXY_PREPARATION_CONCURRENCY_MAX;
    else process.env.TOKENINSIDE_PROXY_PREPARATION_CONCURRENCY_MAX = previousMax;
    if (previousTimeout === undefined) delete process.env.TOKENINSIDE_PROXY_PREPARATION_QUEUE_TIMEOUT_MS;
    else process.env.TOKENINSIDE_PROXY_PREPARATION_QUEUE_TIMEOUT_MS = previousTimeout;
  }
  assert.equal(proxyConcurrencySnapshot().preparation.active, 0);
});
