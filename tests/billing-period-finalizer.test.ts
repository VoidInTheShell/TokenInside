import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createBillingPeriodFinalizer } from "../lib/billing-period-finalizer.ts";
import { effectiveBillingMaterializationConcurrencyMax } from "../lib/config.ts";

const billingPeriodFinalizerPath = new URL(
  "../lib/billing-period-finalizer.ts",
  import.meta.url,
);

type ProductionBillingPeriodFinalizerApi = {
  finalizeBillingPeriodAfterSettlements(
    feishuUserId: string,
    period: string,
    delayMs?: number,
  ): Promise<void>;
  drainBillingPeriodFinalizations(): Promise<void>;
  billingPeriodFinalizationSnapshot(): {
    active: number;
    queued: number;
    pendingKeys: number;
    maxConcurrency: number;
  };
};

async function loadProductionFinalizerChunk(input: {
  sharedGlobal: Record<string, unknown>;
  reconcile: (feishuUserId: string, period: string) => Promise<void>;
  maxConcurrency?: number;
  settlementPoolMax?: number;
  storeBackend?: "json" | "postgres";
}) {
  const source = await readFile(billingPeriodFinalizerPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: "billing-period-finalizer.ts",
  }).outputText;
  const module = { exports: {} as ProductionBillingPeriodFinalizerApi };
  const imports: Record<string, Record<string, unknown>> = {
    "./config.ts": {
      getConfig: () => ({
        storeBackend: input.storeBackend ?? "postgres",
        postgres: {
          settlementPoolMax: input.settlementPoolMax ?? 3,
        },
        billing: {
          materializationConcurrencyMax: input.maxConcurrency ?? 2,
        },
      }),
      effectiveBillingMaterializationConcurrencyMax,
    },
    "./postgres-store.ts": {
      reconcilePostgresBillingPeriodForUser: input.reconcile,
    },
  };
  runInNewContext(
    transpiled,
    {
      module,
      exports: module.exports,
      require: (specifier: string) => {
        const dependency = imports[specifier];
        if (!dependency) throw new Error(`unexpected finalizer import: ${specifier}`);
        return dependency;
      },
      setTimeout,
      clearTimeout,
      globalThis: input.sharedGlobal,
    },
    { filename: "billing-period-finalizer.js" },
  );
  return module.exports;
}

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

test("drain bypasses the debounce delay and waits for all pending keys", async () => {
  const runs: string[] = [];
  const finalize = createBillingPeriodFinalizer(async (userId, period) => {
    runs.push(`${userId}:${period}`);
  });

  const first = finalize("fu_drain_a", "2026-07", 60_000);
  const second = finalize("fu_drain_b", "2026-08", 60_000);
  assert.equal(finalize.pendingCount(), 2);

  await finalize.drain();
  await Promise.all([first, second]);

  assert.deepEqual(runs.sort(), ["fu_drain_a:2026-07", "fu_drain_b:2026-08"]);
  assert.equal(finalize.pendingCount(), 0);
});

test("drain waits through a dirty trailing generation", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  let runs = 0;
  const finalize = createBillingPeriodFinalizer(async () => {
    runs += 1;
    if (runs === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
  });

  const batch = finalize("fu_drain_dirty", "2026-07", 0);
  await firstStarted.promise;
  finalize("fu_drain_dirty", "2026-07", 60_000);
  const drained = finalize.drain();
  releaseFirst.resolve();

  await Promise.all([batch, drained]);
  assert.equal(runs, 2);
  assert.equal(finalize.pendingCount(), 0);
});

test("drain reports failures after removing failed entries", async () => {
  const expected = new Error("drain reconcile failed");
  const finalize = createBillingPeriodFinalizer(async () => {
    throw expected;
  });

  void finalize("fu_drain_failure", "2026-07", 60_000).catch(() => undefined);
  await assert.rejects(finalize.drain(), AggregateError);
  assert.equal(finalize.pendingCount(), 0);
});

test("materialization concurrency is bounded and drain waits for queued keys", async () => {
  const starts = [deferred(), deferred(), deferred()];
  const releases = [deferred(), deferred(), deferred()];
  let runs = 0;
  let active = 0;
  let maxObserved = 0;
  const finalize = createBillingPeriodFinalizer(
    async () => {
      const index = runs;
      runs += 1;
      active += 1;
      maxObserved = Math.max(maxObserved, active);
      starts[index]?.resolve();
      await releases[index]?.promise;
      active -= 1;
    },
    { maxConcurrency: () => 2 },
  );

  const batches = [
    finalize("fu_bounded_a", "2026-07", 0),
    finalize("fu_bounded_b", "2026-07", 0),
    finalize("fu_bounded_c", "2026-07", 0),
  ];
  await Promise.all([starts[0].promise, starts[1].promise]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(finalize.snapshot(), {
    active: 2,
    queued: 1,
    pendingKeys: 3,
    maxConcurrency: 2,
  });

  const drained = finalize.drain();
  releases[0].resolve();
  await starts[2].promise;
  assert.equal(maxObserved, 2);
  releases[1].resolve();
  releases[2].resolve();

  await Promise.all([...batches, drained]);
  assert.equal(maxObserved, 2);
  assert.deepEqual(finalize.snapshot(), {
    active: 0,
    queued: 0,
    pendingKeys: 0,
    maxConcurrency: 2,
  });
});

test("Postgres production finalizer reserves one settlement connection", async () => {
  const starts = [deferred(), deferred()];
  const releases = [deferred(), deferred()];
  let runs = 0;
  let active = 0;
  let maxObserved = 0;
  const chunk = await loadProductionFinalizerChunk({
    sharedGlobal: {},
    maxConcurrency: 4,
    settlementPoolMax: 2,
    reconcile: async () => {
      const index = runs;
      runs += 1;
      active += 1;
      maxObserved = Math.max(maxObserved, active);
      starts[index]?.resolve();
      await releases[index]?.promise;
      active -= 1;
    },
  });

  const batches = [
    chunk.finalizeBillingPeriodAfterSettlements("fu_reserved_a", "2026-07", 0),
    chunk.finalizeBillingPeriodAfterSettlements("fu_reserved_b", "2026-07", 0),
  ];
  await starts[0].promise;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(JSON.parse(JSON.stringify(chunk.billingPeriodFinalizationSnapshot())), {
    active: 1,
    queued: 1,
    pendingKeys: 2,
    maxConcurrency: 1,
  });

  releases[0].resolve();
  await starts[1].promise;
  assert.equal(maxObserved, 1);
  releases[1].resolve();
  await Promise.all(batches);

  assert.equal(runs, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(chunk.billingPeriodFinalizationSnapshot())), {
    active: 0,
    queued: 0,
    pendingKeys: 0,
    maxConcurrency: 1,
  });
});

test("independent production chunks share one versioned finalizer runtime", async () => {
  const starts = [deferred(), deferred(), deferred()];
  const releases = [deferred(), deferred(), deferred()];
  const sharedGlobal: Record<string, unknown> = {};
  let runs = 0;
  let active = 0;
  let maxObserved = 0;
  const reconcile = async () => {
    const index = runs;
    runs += 1;
    active += 1;
    maxObserved = Math.max(maxObserved, active);
    starts[index]?.resolve();
    await releases[index]?.promise;
    active -= 1;
  };

  const instrumentationChunk = await loadProductionFinalizerChunk({
    sharedGlobal,
    reconcile,
    maxConcurrency: 8,
    settlementPoolMax: 3,
  });
  const healthRouteChunk = await loadProductionFinalizerChunk({
    sharedGlobal,
    reconcile,
    maxConcurrency: 8,
    settlementPoolMax: 3,
  });

  const batches = [
    instrumentationChunk.finalizeBillingPeriodAfterSettlements(
      "fu_chunk_a",
      "2026-07",
      0,
    ),
    instrumentationChunk.finalizeBillingPeriodAfterSettlements(
      "fu_chunk_b",
      "2026-07",
      0,
    ),
    healthRouteChunk.finalizeBillingPeriodAfterSettlements(
      "fu_chunk_c",
      "2026-07",
      0,
    ),
  ];

  await Promise.all([starts[0].promise, starts[1].promise]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(
    JSON.parse(JSON.stringify(instrumentationChunk.billingPeriodFinalizationSnapshot())),
    {
      active: 2,
      queued: 1,
      pendingKeys: 3,
      maxConcurrency: 2,
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(healthRouteChunk.billingPeriodFinalizationSnapshot())),
    {
      active: 2,
      queued: 1,
      pendingKeys: 3,
      maxConcurrency: 2,
    },
  );
  assert.equal(
    (sharedGlobal.__tokenInsideBillingPeriodFinalizerRuntimeV1 as { version: number })
      .version,
    1,
  );

  const drained = healthRouteChunk.drainBillingPeriodFinalizations();
  releases[0].resolve();
  await starts[2].promise;
  assert.equal(maxObserved, 2);
  releases[1].resolve();
  releases[2].resolve();
  await Promise.all([...batches, drained]);

  assert.equal(runs, 3);
  assert.equal(maxObserved, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(instrumentationChunk.billingPeriodFinalizationSnapshot())),
    {
      active: 0,
      queued: 0,
      pendingKeys: 0,
      maxConcurrency: 2,
    },
  );
});
