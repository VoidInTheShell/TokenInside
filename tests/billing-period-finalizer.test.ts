import assert from "node:assert/strict";
import test from "node:test";
import { createBillingPeriodFinalizer } from "../lib/billing-period-finalizer.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("debounces calls made before reconciliation starts", async () => {
  let runs = 0;
  const finalize = createBillingPeriodFinalizer(async () => {
    runs += 1;
  });

  const first = finalize("fu_debounce", "2026-07", 5);
  const second = finalize("fu_debounce", "2026-07", 5);

  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(runs, 1);
});

test("a call during reconciliation forces a trailing run and shares its final promise", async () => {
  const firstStarted = deferred();
  const secondStarted = deferred();
  const releaseFirst = deferred();
  const releaseSecond = deferred();
  let runs = 0;
  const finalize = createBillingPeriodFinalizer(async () => {
    runs += 1;
    if (runs === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
      return;
    }
    secondStarted.resolve();
    await releaseSecond.promise;
  });

  const first = finalize("fu_dirty", "2026-07", 0);
  await firstStarted.promise;
  const second = finalize("fu_dirty", "2026-07", 0);
  const third = finalize("fu_dirty", "2026-07", 0);
  let settled = false;
  void first.then(() => {
    settled = true;
  });

  assert.equal(first, second);
  assert.equal(first, third);
  releaseFirst.resolve();
  await secondStarted.promise;
  assert.equal(runs, 2);
  assert.equal(settled, false);

  releaseSecond.resolve();
  await Promise.all([first, second, third]);
  assert.equal(settled, true);
  assert.equal(runs, 2);
});

test("each dirty running generation extends the shared promise through its final rerun", async () => {
  const starts = [deferred(), deferred(), deferred()];
  const releases = [deferred(), deferred(), deferred()];
  let runs = 0;
  const finalize = createBillingPeriodFinalizer(async () => {
    const index = runs;
    runs += 1;
    starts[index]?.resolve();
    await releases[index]?.promise;
  });

  const batch = finalize("fu_generations", "2026-07", 0);
  await starts[0].promise;
  assert.equal(finalize("fu_generations", "2026-07", 0), batch);
  releases[0].resolve();

  await starts[1].promise;
  assert.equal(finalize("fu_generations", "2026-07", 0), batch);
  releases[1].resolve();

  await starts[2].promise;
  let settled = false;
  void batch.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  releases[2].resolve();

  await batch;
  assert.equal(settled, true);
  assert.equal(runs, 3);
});

test("a failed batch is removed so a later call can retry", async () => {
  const expected = new Error("reconcile failed");
  let runs = 0;
  const finalize = createBillingPeriodFinalizer(async () => {
    runs += 1;
    if (runs === 1) throw expected;
  });

  const failed = finalize("fu_retry", "2026-07", 0);
  await assert.rejects(failed, expected);

  const retried = finalize("fu_retry", "2026-07", 0);
  assert.notEqual(retried, failed);
  await retried;
  assert.equal(runs, 2);
});

test("a dirty request retries a failed running generation before settling callers", async () => {
  const firstStarted = deferred();
  const releaseFailure = deferred();
  let runs = 0;
  const finalize = createBillingPeriodFinalizer(async () => {
    runs += 1;
    if (runs === 1) {
      firstStarted.resolve();
      await releaseFailure.promise;
      throw new Error("transient failure");
    }
  });

  const first = finalize("fu_dirty_retry", "2026-07", 0);
  await firstStarted.promise;
  const retryDemand = finalize("fu_dirty_retry", "2026-07", 0);
  releaseFailure.resolve();

  await Promise.all([first, retryDemand]);
  assert.equal(first, retryDemand);
  assert.equal(runs, 2);
});
