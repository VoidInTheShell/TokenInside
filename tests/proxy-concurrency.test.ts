import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireProxyConcurrencySlot,
  acquireProxyPersistenceSlot,
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
      persistence: {
        active: 0,
        queued: 0,
        acceptanceQueued: 0,
        terminalQueued: 0,
        maxConcurrency: 8,
      },
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
      persistence: {
        active: 0,
        queued: 0,
        acceptanceQueued: 0,
        terminalQueued: 0,
        maxConcurrency: 8,
      },
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

test("proxy persistence bounds background writes and prioritizes acceptance", async () => {
  const previousMax = process.env.TOKENINSIDE_PROXY_PERSISTENCE_CONCURRENCY_MAX;
  process.env.TOKENINSIDE_PROXY_PERSISTENCE_CONCURRENCY_MAX = "1";
  const firstRelease = await acquireProxyPersistenceSlot("terminal");
  const order: string[] = [];
  let terminalRelease: (() => void) | undefined;
  let acceptanceRelease: (() => void) | undefined;
  try {
    const terminal = acquireProxyPersistenceSlot("terminal").then((release) => {
      order.push("terminal");
      terminalRelease = release;
    });
    const acceptance = acquireProxyPersistenceSlot("acceptance").then((release) => {
      order.push("acceptance");
      acceptanceRelease = release;
    });
    await Promise.resolve();
    assert.deepEqual(proxyConcurrencySnapshot().persistence, {
      active: 1,
      queued: 2,
      acceptanceQueued: 1,
      terminalQueued: 1,
      maxConcurrency: 1,
    });

    firstRelease();
    await acceptance;
    assert.deepEqual(order, ["acceptance"]);
    acceptanceRelease?.();
    await terminal;
    assert.deepEqual(order, ["acceptance", "terminal"]);
    terminalRelease?.();
  } finally {
    firstRelease();
    acceptanceRelease?.();
    terminalRelease?.();
    if (previousMax === undefined) {
      delete process.env.TOKENINSIDE_PROXY_PERSISTENCE_CONCURRENCY_MAX;
    } else {
      process.env.TOKENINSIDE_PROXY_PERSISTENCE_CONCURRENCY_MAX = previousMax;
    }
  }
  assert.equal(proxyConcurrencySnapshot().persistence.active, 0);
});

test("proxy persistence bounded priority cannot starve terminal writes", async () => {
  const previousMax = process.env.TOKENINSIDE_PROXY_PERSISTENCE_CONCURRENCY_MAX;
  process.env.TOKENINSIDE_PROXY_PERSISTENCE_CONCURRENCY_MAX = "1";
  const firstRelease = await acquireProxyPersistenceSlot("acceptance");
  const order: string[] = [];
  try {
    const terminal = acquireProxyPersistenceSlot("terminal").then((release) => {
      order.push("terminal");
      return release;
    });
    const acceptances = Array.from({ length: 6 }, (_, index) =>
      acquireProxyPersistenceSlot("acceptance").then((release) => {
        order.push(`acceptance-${index}`);
        return release;
      }));

    firstRelease();
    for (let index = 0; index < 4; index += 1) {
      const release = await acceptances[index];
      release();
    }
    const terminalRelease = await terminal;
    assert.deepEqual(order, [
      "acceptance-0",
      "acceptance-1",
      "acceptance-2",
      "acceptance-3",
      "terminal",
    ]);
    terminalRelease();
    for (let index = 4; index < acceptances.length; index += 1) {
      const release = await acceptances[index];
      release();
    }
  } finally {
    firstRelease();
    if (previousMax === undefined) {
      delete process.env.TOKENINSIDE_PROXY_PERSISTENCE_CONCURRENCY_MAX;
    } else {
      process.env.TOKENINSIDE_PROXY_PERSISTENCE_CONCURRENCY_MAX = previousMax;
    }
  }
  assert.equal(proxyConcurrencySnapshot().persistence.active, 0);
  assert.equal(proxyConcurrencySnapshot().persistence.queued, 0);
});
