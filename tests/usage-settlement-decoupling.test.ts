import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const usageSyncPath = new URL("../lib/usage-sync.ts", import.meta.url);
const postgresStorePath = new URL("../lib/postgres-store.ts", import.meta.url);
const healthRoutePath = new URL("../app/api/health/route.ts", import.meta.url);

function functionBody(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

type UsageSyncTestApi = {
  runDueNewApiUsageSync(input?: { force?: boolean }): Promise<{
    ran: boolean;
    reason?: string;
  }>;
  syncNewApiUsageForProxyRequest(input: Record<string, unknown>): Promise<{
    reason?: string;
  }>;
  ensureUsageSyncScheduler(): Promise<void>;
  drainNewApiUsageSettlements(): Promise<void>;
  billingMaterializationRecoverySnapshot(): {
    requested: boolean;
    running: boolean;
    lastTargetCount: number;
    lastErrorAt?: string;
    nextRetryAt?: string;
  };
  usageSettlementTailSnapshot(): {
    repairSlicesRemaining: number;
  };
};

async function createUsageSyncSchedulerHarness(input: {
  pageTotals: number[];
  scanStart?: string;
  scanEnd?: string;
  initialCheckpoint?: Record<string, unknown>;
  storeBackend?: "postgres" | "json";
  enabled?: boolean;
  pageSize?: number;
  maxPagesPerRun?: number;
  backfillItems?: Array<{
    proxyLogId: string;
    feishuUserId: string;
    billingPeriod: string;
  }>;
  finalizeBillingPeriod?: (feishuUserId: string, period: string) => Promise<void>;
  recoveryTargets?: Array<{
    feishuUserId: string;
    billingPeriod: string;
  }>;
  onListRecoveryTargets?: (call: number) => void | Promise<void>;
  onListUsageLogs?: (context: {
    call: number;
    api: UsageSyncTestApi;
  }) => void | Promise<void>;
  listUsageErrorAtCall?: number;
  pendingHorizonErrorAtCall?: number;
  lockBusyAtRun?: number;
  nowIso?: string;
  pendingHorizon?: {
    count: number;
    nextDueAt?: string;
    requiredThrough?: string;
  };
  pendingHorizons?: Array<{
    count: number;
    nextDueAt?: string;
    requiredThrough?: string;
  }>;
  sharedGlobal?: Record<string, unknown>;
}) {
  const source = await readFile(usageSyncPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: "usage-sync.ts",
  }).outputText;

  type TimerHandle = { id: number; unref(): void };
  type PendingTimer = {
    handle: TimerHandle;
    callback: () => void | Promise<void>;
    delayMs: number;
  };
  const timers = new Map<number, PendingTimer>();
  const schedulerErrors: unknown[] = [];
  const listedPages: number[] = [];
  const deferredCoverageWindows: Array<{ scanStart: string; scanEnd: string }> = [];
  const events: string[] = [];
  let nextTimerId = 1;
  let listCalls = 0;
  let recoveryListCalls = 0;
  let horizonCalls = 0;
  let lockRuns = 0;
  let checkpoint: Record<string, unknown> | undefined = input.initialCheckpoint;
  let fixedScanEnd = input.scanEnd ?? "2026-07-17T00:00:00.000Z";
  let api: UsageSyncTestApi;

  const policy = {
    enabled: input.enabled ?? true,
    pageSize: input.pageSize ?? 1,
    maxPagesPerRun: input.maxPagesPerRun ?? 1,
    overlapMinutes: 120,
    intervalMinutes: 5,
    settlementLagMinutes: 0,
    retryBaseMinutes: 5,
    matchWindowMinutes: 30,
    nextRunAfter: "2099-01-01T00:00:00.000Z",
  };
  const backfill = {
    seen: input.backfillItems?.length ?? 0,
    matched: input.backfillItems?.length ?? 0,
    updated: input.backfillItems?.length ?? 0,
    skippedUnknownToken: 0,
    skippedNoMatch: 0,
    recordsUpserted: 0,
    issuesUpserted: 0,
    items: input.backfillItems ?? [],
  };

  const imports: Record<string, Record<string, unknown>> = {
    "@/lib/newapi": {
      listNewApiUsageLogs: async ({ page }: { page: number }) => {
        listCalls += 1;
        listedPages.push(page);
        if (listCalls === input.listUsageErrorAtCall) {
          throw new Error("synthetic NewAPI scan failure");
        }
        await input.onListUsageLogs?.({ call: listCalls, api });
        const total = input.pageTotals[Math.min(listCalls - 1, input.pageTotals.length - 1)] ?? 0;
        return {
          total,
          items: total
            ? [
                {
                  newapiLogId: `log-${page}`,
                  newapiTokenId: "token-1",
                  createdAt: "2026-07-17T00:00:00.000Z",
                  quota: 1,
                },
              ]
            : [],
        };
      },
    },
    "@/lib/config": {
      getConfig: () => ({
        storeBackend: input.storeBackend ?? "postgres",
        billing: {
          settlementConcurrencyMax: 0,
          usageSyncContinuationDelayMs: 250,
        },
      }),
    },
    "@/lib/crypto": {
      nowIso: () => input.nowIso ?? "2026-07-17T00:00:00.000Z",
      randomId: () => "usage-run-1",
    },
    "@/lib/quota-model": {
      fixedUsageSyncWindow: () => ({
        scanStart: input.scanStart ?? "2026-07-16T23:59:31.000Z",
        scanEnd: fixedScanEnd,
      }),
      hongKongBillingPeriod: () => "2026-07",
    },
    "@/lib/billing-period-finalizer": {
      drainBillingPeriodFinalizations: async () => undefined,
      finalizeBillingPeriodAfterSettlements: async (
        feishuUserId: string,
        period: string,
      ) => {
        events.push(`finalize:${feishuUserId}:${period}`);
        await input.finalizeBillingPeriod?.(feishuUserId, period);
      },
    },
    "@/lib/postgres-store": {
      deferPostgresCoveredPendingUsageSettlements: async (
        scanStart: string,
        scanEnd: string,
      ) => {
        deferredCoverageWindows.push({ scanStart, scanEnd });
        return 0;
      },
      getPostgresPendingUsageSettlementHorizon: async () => {
        horizonCalls += 1;
        if (horizonCalls === input.pendingHorizonErrorAtCall) {
          throw new Error("synthetic pending horizon failure");
        }
        return input.pendingHorizons?.[
          Math.min(horizonCalls - 1, input.pendingHorizons.length - 1)
        ] ?? input.pendingHorizon ?? {
          count: 1,
          nextDueAt: new Date(Date.now() - 1_000).toISOString(),
          requiredThrough: "2026-07-17T00:00:00.000Z",
        };
      },
      listPostgresMatchedUsageBillingMaterializationTargets: async () => {
        recoveryListCalls += 1;
        await input.onListRecoveryTargets?.(recoveryListCalls);
        return input.recoveryTargets ?? [];
      },
      withPostgresAdvisoryLock: async (
        _key: string,
        fn: () => Promise<unknown>,
      ) => {
        lockRuns += 1;
        if (lockRuns === input.lockBusyAtRun) {
          throw Object.assign(new Error("synthetic peer active"), {
            code: "POSTGRES_ADVISORY_LOCK_BUSY",
          });
        }
        return fn();
      },
      isPostgresAdvisoryLockBusyError: (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "POSTGRES_ADVISORY_LOCK_BUSY",
    },
    "@/lib/store": {
      backfillProxyLogsFromNewApiUsage: async () => backfill,
      claimBillingOperationExecution: async () => null,
      defaultUsageSyncPolicy: () => policy,
      enqueueBillingOperation: async () => undefined,
      findBillingOperationById: async () => null,
      getAppSettings: async () => ({ usageSyncPolicy: policy }),
      getUsageSyncCheckpoint: async () => checkpoint,
      listRunnableBillingOperations: async () => [],
      recordBillingOperation: async () => undefined,
      rebuildQuotaMaterializedSnapshots: async () => undefined,
      renewBillingOperationExecution: async () => undefined,
      saveUsageSyncCheckpoint: async (value: Record<string, unknown>) => {
        events.push(`checkpoint:${String(value.cursorPage)}`);
        checkpoint = { ...value, updatedAt: value.lastRunAt };
        return checkpoint;
      },
    },
  };
  const module = { exports: {} as UsageSyncTestApi };
  let fakeNowEpochMs = Date.now();
  class HarnessDate extends Date {
    constructor(value?: string | number | Date) {
      if (value === undefined) super(fakeNowEpochMs);
      else super(value);
    }
    static override now() {
      return fakeNowEpochMs;
    }
  }
  const fakeSetTimeout = (
    callback: () => void | Promise<void>,
    delayMs: number,
  ) => {
    const id = nextTimerId;
    nextTimerId += 1;
    const handle: TimerHandle = { id, unref() {} };
    timers.set(id, { handle, callback, delayMs });
    return handle;
  };
  const fakeClearTimeout = (handle: TimerHandle) => {
    timers.delete(handle.id);
  };
  const context = {
    module,
    exports: module.exports,
    require: (specifier: string) => {
      const dependency = imports[specifier];
      if (!dependency) throw new Error(`unexpected usage-sync import: ${specifier}`);
      return dependency;
    },
    console: {
      error: (...args: unknown[]) => schedulerErrors.push(args),
    },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    setInterval: fakeSetTimeout,
    clearInterval: fakeClearTimeout,
    Date: HarnessDate,
    ...(input.sharedGlobal ? { globalThis: input.sharedGlobal } : {}),
  };
  runInNewContext(transpiled, context, { filename: "usage-sync.js" });
  api = module.exports;

  return {
    api,
    events,
    schedulerErrors,
    listedPages,
    deferredCoverageWindows,
    get listCalls() {
      return listCalls;
    },
    get lockRuns() {
      return lockRuns;
    },
    get recoveryListCalls() {
      return recoveryListCalls;
    },
    get horizonCalls() {
      return horizonCalls;
    },
    get checkpoint() {
      return checkpoint;
    },
    setScanEnd(value: string) {
      fixedScanEnd = value;
    },
    pendingDelays() {
      return [...timers.values()]
        .sort((left, right) => left.handle.id - right.handle.id)
        .map((timer) => timer.delayMs);
    },
    async runNextTimer() {
      const timer = [...timers.values()].sort(
        (left, right) => left.handle.id - right.handle.id,
      )[0];
      assert.ok(timer, "expected a pending scheduler timer");
      timers.delete(timer.handle.id);
      fakeNowEpochMs += timer.delayMs;
      await timer.callback();
      return timer.delayMs;
    },
  };
}

test("authoritative immediate settlement does not await derived period materialization", async () => {
  const source = await readFile(usageSyncPath, "utf8");
  const immediate = functionBody(
    source,
    "async function syncNewApiUsageForProxyRequestInner",
    "export async function syncNewApiUsageForProxyRequest(",
  );
  const observer = functionBody(
    source,
    "function observeImmediateBillingPeriodFinalization",
    "export type NewApiProxyUsageSettlementResult",
  );

  assert.match(immediate, /observeImmediateBillingPeriodFinalization\(proxyLogId, \[backfill\]\)/);
  assert.doesNotMatch(immediate, /await finalizeBackfillBillingPeriods\(\[backfill\]\)/);
  assert.match(observer, /void finalizeBackfillBillingPeriods\(backfills\)\.catch/);
  assert.match(observer, /tokeninside\.billing_period\.materialization_failed/);
});

test("authoritative batch checkpoint does not await Postgres read-model materialization", async () => {
  const source = await readFile(usageSyncPath, "utf8");
  const batch = functionBody(
    source,
    "async function syncNewApiUsageLogsUnlocked",
    "const manualUsageSyncLeaseDurationMs",
  );
  const observer = functionBody(
    source,
    "function observeUsageSyncBillingPeriodFinalization",
    "export type NewApiProxyUsageSettlementResult",
  );

  assert.doesNotMatch(batch, /await finalizeBackfillBillingPeriods/);
  assert.match(observer, /void finalizeBackfillBillingPeriods\(backfills\)\.catch/);
  assert.match(observer, /tokeninside\.usage_sync\.materialization_failed/);
  assert.ok(
    batch.indexOf("saveUsageSyncCheckpoint({") <
      batch.indexOf("observeUsageSyncBillingPeriodFinalization("),
    "the durable source checkpoint must commit before derived finalization is queued",
  );
  assert.match(batch, /getConfig\(\)\.storeBackend === "postgres"/);
  assert.match(batch, /else if \(!dryRun\)[\s\S]*await rebuildQuotaMaterializedSnapshots/);
  assert.match(batch, /Department availability is derived only from quota ledger grants/);
});

test("matched Postgres source facts enumerate distinct durable user-period materialization targets", async () => {
  const source = await readFile(postgresStorePath, "utf8");
  const query = functionBody(
    source,
    "export async function listPostgresMatchedUsageBillingMaterializationTargets()",
    "export async function readPostgresUsageMatchingSnapshot(",
  );

  assert.match(query, /where match_status = 'matched'/);
  assert.match(query, /select distinct "feishuUserId", "billingPeriod"/);
  assert.match(query, /data->>'billingPeriod'/);
  assert.match(query, /newapi_created_at at time zone 'Asia\/Hong_Kong'/);
  assert.match(query, /"feishuUserId" is not null/);
  assert.match(query, /"billingPeriod" is not null/);
});

test("health exposes bounded materialization recovery state without error text", async () => {
  const route = await readFile(healthRoutePath, "utf8");
  assert.match(route, /billingMaterializationRecoverySnapshot/);
  assert.match(route, /billingMaterializationRecovery: billingMaterializationRecoverySnapshot\(\)/);

  const usageSync = await readFile(usageSyncPath, "utf8");
  const snapshot = functionBody(
    usageSync,
    "export function billingMaterializationRecoverySnapshot()",
    "const immediateSettlementDefaults",
  );
  for (const field of ["requested", "running", "lastTargetCount", "lastErrorAt", "nextRetryAt"]) {
    assert.match(snapshot, new RegExp(`${field}:`));
  }
  assert.doesNotMatch(snapshot, /errorMessage|lastErrorMessage/);
});

test("immediate settlement saturation leaves the durable pending log to the scheduler without an unbounded waiter queue", async () => {
  const source = await readFile(usageSyncPath, "utf8");
  const gate = functionBody(
    source,
    "function tryAcquireImmediateSettlementSlot()",
    "const immediateSettlementDefaults",
  );
  const settlement = functionBody(
    source,
    "export async function syncNewApiUsageForProxyRequest(",
    "export async function drainNewApiUsageSettlements()",
  );

  assert.match(
    gate,
    /activeImmediateSettlements >= getConfig\(\)\.billing\.settlementConcurrencyMax\) return null/,
  );
  assert.match(gate, /activeImmediateSettlements \+= 1/);
  assert.doesNotMatch(gate, /new Promise<void>\(\(resolve\) => .*push\(resolve\)/);
  assert.doesNotMatch(source, /immediateSettlementWaiters/);

  assert.match(settlement, /const release = tryAcquireImmediateSettlementSlot\(\)/);
  assert.match(settlement, /if \(!release\)/);
  assert.match(settlement, /wakeUsageSyncScheduler\(\)/);
  assert.match(settlement, /reason: "deferred" as const/);
  assert.ok(
    settlement.indexOf("if (!release)") <
      settlement.indexOf("syncNewApiUsageForProxyRequestInner(input)"),
    "saturated calls must return before starting immediate NewAPI polling",
  );
});

test("deferred settlement wake-ups are coalesced and never postpone an earlier scheduler tick", async () => {
  const source = await readFile(usageSyncPath, "utf8");
  const due = functionBody(
    source,
    "export async function runDueNewApiUsageSync(",
    "function scheduleNextUsageSyncTick(delayMs: number)",
  );
  const scheduler = functionBody(
    source,
    "function scheduleNextUsageSyncTick(delayMs: number)",
    "export async function ensureUsageSyncScheduler()",
  );
  const wake = functionBody(
    source,
    "function wakeUsageSyncScheduler()",
    "export async function ensureUsageSyncScheduler()",
  );

  assert.match(scheduler, /usageSyncRuntime\.schedulerNextTickAt <= nextTickAt/);
  assert.match(scheduler, /usageSyncRuntime\.schedulerTickRunning = true/);
  assert.match(scheduler, /forceScan = usageSyncRuntime\.schedulerForceScanRequested/);
  assert.match(scheduler, /usageSyncRuntime\.schedulerForceScanRequested = false/);
  assert.match(scheduler, /runDueNewApiUsageSync\(\{[\s\S]*force: forceScan,[\s\S]*policy: schedulerPolicy/);
  assert.match(
    scheduler,
    /if \(!result\.completedWindow\)/,
  );
  assert.match(scheduler, /automaticRun\.result\?\.completedSlice/);
  assert.match(scheduler, /completedScan\.scanStart/);
  assert.match(scheduler, /completedScan\.scanEnd/);
  assert.match(scheduler, /usageSyncRuntime\.schedulerRepairBudgetRefillNotBeforeEpochMs/);
  assert.match(scheduler, /reason === "retry_backoff"/);
  assert.match(scheduler, /usageSyncRuntime\.schedulerTransientFailureCount \+= 1/);
  assert.match(scheduler, /usageSyncRuntime\.schedulerForceScanRequested\s*\? Math\.max\(/);
  assert.match(scheduler, /usageSyncContinuationDelayMs\(\)/);
  assert.match(scheduler, /usageSyncScanRetryDelayMs\(\)/);
  assert.match(due, /if \(!policy\.enabled\) return \{ ran: false, reason: "disabled" as const \}/);
  assert.match(due, /if \(!input\.force && nextRunAfter/);
  assert.match(due, /syncNewApiUsageLogs\(\{/);
  assert.match(wake, /usageSyncRuntime\.schedulerTailRefreshRequested = true/);
  assert.doesNotMatch(wake, /usageSyncRuntime\.schedulerForceScanRequested = true/);
  assert.match(
    wake,
    /scheduleNextUsageSyncTick\([\s\S]*durablePendingUsageTailRefreshDelayMs\(\)[\s\S]*usageSyncContinuationDelayMs\(\)[\s\S]*usageSyncScanRetryDelayMs\(\)/,
  );
  assert.doesNotMatch(wake, /runDueNewApiUsageSync/);
  assert.doesNotMatch(wake, /new Promise/);
});

test("independent Next server chunks share one process-wide usage scheduler timer", async () => {
  const sharedGlobal: Record<string, unknown> = {};
  const first = await createUsageSyncSchedulerHarness({
    pageTotals: [0],
    sharedGlobal,
  });
  const second = await createUsageSyncSchedulerHarness({
    pageTotals: [0],
    sharedGlobal,
  });

  await first.api.ensureUsageSyncScheduler();
  await second.api.ensureUsageSyncScheduler();

  assert.deepEqual(first.pendingDelays(), [1_000]);
  assert.deepEqual(
    second.pendingDelays(),
    [],
    "a second bundled module must observe the first module's started/timer state",
  );
  const runtime = sharedGlobal.__tokenInsideUsageSyncRuntime as
    | { schedulerStarted?: boolean; schedulerRepairSlicesRemaining?: number }
    | undefined;
  assert.equal(runtime?.schedulerStarted, true);
  assert.equal(runtime?.schedulerRepairSlicesRemaining, 0);
});

test("a capacity deferral forces a locked scan and maxPages continuation until the window completes", async () => {
  const harness = await createUsageSyncSchedulerHarness({ pageTotals: [2, 2] });

  const ordinaryRun = await harness.api.runDueNewApiUsageSync();
  assert.equal(ordinaryRun.ran, false);
  assert.equal(ordinaryRun.reason, "not_due");
  assert.equal(harness.lockRuns, 0);

  const deferred = await harness.api.syncNewApiUsageForProxyRequest({
    proxyLogId: "proxy-1",
  });
  assert.equal(deferred.reason, "deferred");
  assert.deepEqual(harness.pendingDelays(), [250]);

  await harness.runNextTimer();
  assert.equal(harness.listCalls, 1, "forced wake must bypass a future nextRunAfter");
  assert.equal(harness.lockRuns, 1, "forced scans must still use the global usage lock");
  assert.deepEqual(harness.listedPages, [0]);
  assert.deepEqual(
    harness.pendingDelays(),
    [250],
    "an incomplete maxPages window must schedule a forced continuation",
  );

  await harness.runNextTimer();
  assert.equal(harness.listCalls, 3);
  assert.equal(harness.lockRuns, 2);
  assert.deepEqual(
    harness.listedPages,
    [0, 1, 0],
    "the forced follow-up must resume the cursor and verify the slice head",
  );
  assert.deepEqual(
    harness.pendingDelays(),
    [250],
    "a capacity wake retains exactly one fresh tail scan after the old window",
  );

  await harness.runNextTimer();
  assert.equal(harness.listCalls, 4);
  assert.deepEqual(harness.pendingDelays(), [250]);

  await harness.runNextTimer();
  assert.equal(harness.listCalls, 6);
  assert.deepEqual(harness.pendingDelays(), [250]);

  await harness.runNextTimer();
  assert.equal(harness.listCalls, 7);
  assert.deepEqual(harness.pendingDelays(), [250]);

  await harness.runNextTimer();
  assert.equal(harness.listCalls, 9);
  assert.deepEqual(harness.pendingDelays(), [250]);
  assert.deepEqual(harness.schedulerErrors, []);
});

test("an immature capacity deferral refreshes its horizon without scanning NewAPI", async () => {
  const nextDueAt = new Date(Date.now() + 60_000).toISOString();
  const harness = await createUsageSyncSchedulerHarness({
    pageTotals: [1],
    pendingHorizon: { count: 1, nextDueAt },
  });

  await harness.api.syncNewApiUsageForProxyRequest({ proxyLogId: "immature" });
  await harness.runNextTimer();
  assert.equal(harness.listCalls, 0);
  assert.ok((harness.pendingDelays()[0] ?? 0) >= 55_000);
});

test("a terminal wake inside the horizon throttle schedules a refresh within five seconds", async () => {
  const harness = await createUsageSyncSchedulerHarness({
    pageTotals: [0],
    pendingHorizons: [
      { count: 0 },
      {
        count: 1,
        nextDueAt: "2000-01-01T00:00:00.000Z",
        requiredThrough: "2026-07-17T00:00:00.000Z",
      },
    ],
  });

  await harness.api.ensureUsageSyncScheduler();
  await harness.runNextTimer();
  assert.equal(harness.horizonCalls, 1);
  assert.equal(harness.listCalls, 0);

  await harness.api.syncNewApiUsageForProxyRequest({ proxyLogId: "last-terminal" });
  assert.ok((harness.pendingDelays()[0] ?? 0) <= 5_000);
  await harness.runNextTimer();
  assert.equal(harness.horizonCalls, 2);
  assert.ok(harness.listCalls > 0, "the final wake must mature into a source scan");
});

test("a failed pending horizon read preserves the last wake and retries within five seconds", async () => {
  const harness = await createUsageSyncSchedulerHarness({
    pageTotals: [0],
    pendingHorizonErrorAtCall: 1,
    pendingHorizon: {
      count: 1,
      nextDueAt: "2000-01-01T00:00:00.000Z",
      requiredThrough: "2026-07-17T00:00:00.000Z",
    },
  });

  await harness.api.syncNewApiUsageForProxyRequest({ proxyLogId: "failed-horizon" });
  await harness.runNextTimer();
  assert.equal(harness.horizonCalls, 1);
  assert.equal(harness.listCalls, 0);
  assert.equal(harness.schedulerErrors.length, 1);
  assert.ok(
    (harness.pendingDelays()[0] ?? 0) <= 5_000,
    "a transient PostgreSQL read failure must retain a bounded refresh timer",
  );

  await harness.runNextTimer();
  assert.equal(harness.horizonCalls, 2);
  assert.ok(harness.listCalls > 0, "the retained wake must mature into a source scan");
});

test("a total above ten thousand keeps paging and never advances settledThrough early", async () => {
  const harness = await createUsageSyncSchedulerHarness({
    pageTotals: [...Array.from({ length: 102 }, () => 10_100), 0],
    pageSize: 100,
    maxPagesPerRun: 20,
  });

  await harness.api.syncNewApiUsageForProxyRequest({ proxyLogId: "deferred-large" });
  for (let run = 1; run <= 5; run += 1) {
    await harness.runNextTimer();
    assert.equal(harness.listCalls, run * 20);
    assert.equal(harness.checkpoint?.cursorPage, run * 20);
    assert.equal(
      harness.checkpoint?.settledThrough,
      undefined,
      "a partial deep-offset window must not publish a settled watermark",
    );
    assert.deepEqual(harness.pendingDelays(), [250]);
  }

  await harness.runNextTimer();
  assert.equal(harness.listCalls, 102);
  assert.equal(harness.checkpoint?.cursorPage, 0);
  assert.equal(harness.checkpoint?.settledThrough, "2026-07-17T00:00:00.000Z");
  assert.deepEqual(harness.pendingDelays(), [250]);
});

test("forward slices publish bounded progress before the whole catch-up target completes", async () => {
  const harness = await createUsageSyncSchedulerHarness({
    pageTotals: [1],
    scanStart: "2026-07-16T23:58:01.000Z",
    scanEnd: "2026-07-17T00:00:00.000Z",
  });

  await harness.api.syncNewApiUsageForProxyRequest({ proxyLogId: "forward-progress" });
  await harness.runNextTimer();
  assert.equal(harness.checkpoint?.settledThrough, "2026-07-16T23:58:30.000Z");
  assert.equal(harness.checkpoint?.scanStart, "2026-07-16T23:58:30.000Z");
  assert.equal(harness.checkpoint?.scanEnd, "2026-07-16T23:58:59.000Z");
  assert.equal(harness.checkpoint?.lastRunStatus, "partial_failed");
  assert.deepEqual(harness.pendingDelays(), [250]);

  await harness.runNextTimer();
  assert.equal(harness.checkpoint?.settledThrough, "2026-07-16T23:58:59.000Z");
  assert.equal(harness.checkpoint?.scanStart, "2026-07-16T23:58:59.000Z");
  assert.equal(harness.checkpoint?.scanEnd, "2026-07-16T23:59:28.000Z");
});

test("a completed forward target yields one bounded durable repair slice", async () => {
  const harness = await createUsageSyncSchedulerHarness({ pageTotals: [0] });

  await harness.api.syncNewApiUsageForProxyRequest({ proxyLogId: "repair-watermark" });
  await harness.runNextTimer();
  assert.equal(harness.checkpoint?.settledThrough, "2026-07-17T00:00:00.000Z");
  assert.equal(harness.checkpoint?.scanMode, "repair");
  assert.equal(harness.checkpoint?.scanStart, "2026-07-16T22:00:00.000Z");
  assert.equal(harness.checkpoint?.scanEnd, "2026-07-16T22:00:29.000Z");
  assert.equal(harness.checkpoint?.lastRunStatus, "partial_failed");

  await harness.runNextTimer();
  assert.equal(harness.checkpoint?.repairCursorThrough, "2026-07-16T22:00:29.000Z");
  assert.equal(harness.checkpoint?.lastRunStatus, "applied");
  assert.deepEqual(harness.pendingDelays(), [250]);
  assert.deepEqual(harness.deferredCoverageWindows.slice(0, 2), [
    {
      scanStart: "2026-07-16T23:59:31.000Z",
      scanEnd: "2026-07-17T00:00:00.000Z",
    },
    {
      scanStart: "2026-07-16T22:00:00.000Z",
      scanEnd: "2026-07-16T22:00:29.000Z",
    },
  ]);
});

test("a repair burst covers faster than wall time while yielding between slices", async () => {
  const harness = await createUsageSyncSchedulerHarness({ pageTotals: [0] });

  await harness.api.syncNewApiUsageForProxyRequest({ proxyLogId: "repair-burst" });
  await harness.runNextTimer();
  for (let slice = 0; slice < 15; slice += 1) {
    assert.deepEqual(harness.pendingDelays(), [250]);
    await harness.runNextTimer();
  }

  const repairStart = new Date("2026-07-16T22:00:00.000Z").getTime();
  const repairThrough = new Date(
    String(harness.checkpoint?.repairCursorThrough),
  ).getTime();
  assert.ok(
    repairThrough - repairStart >= 12 * 29_000,
    "one five-minute cycle must repair more than five minutes of history",
  );
  // The originating capacity wake retains one coalesced fresh-tail scan after
  // the bounded repair budget; it is still one yielded slice, not a new burst.
  if (harness.pendingDelays()[0] === 250) await harness.runNextTimer();
  assert.ok((harness.pendingDelays()[0] ?? 0) >= 295_000);

  const cursorBeforeFreshWake = new Date(
    String(harness.checkpoint?.repairCursorThrough),
  ).getTime();
  const listCallsBeforeFreshWake = harness.listCalls;
  harness.setScanEnd("2026-07-17T00:00:05.000Z");
  await harness.api.syncNewApiUsageForProxyRequest({ proxyLogId: "no-refill" });
  let shortTicks = 0;
  while (harness.pendingDelays()[0] < 10_000 && shortTicks < 8) {
    shortTicks += 1;
    await harness.runNextTimer();
  }
  const cursorAfterFreshWake = new Date(
    String(harness.checkpoint?.repairCursorThrough),
  ).getTime();
  assert.equal(
    cursorAfterFreshWake,
    cursorBeforeFreshWake,
    "a fresh wake cannot enter repair after its bucket is exhausted",
  );
  assert.ok(
    harness.listCalls - listCallsBeforeFreshWake <= 2,
    "only one bounded fresh-forward page plus verification may run",
  );
  assert.ok(
    (harness.pendingDelays()[0] ?? 0) >= 60_000,
    "the exhausted bucket must leave the continuation cadence",
  );
});

test("a frozen repair window continues after the forward watermark moves", async () => {
  const harness = await createUsageSyncSchedulerHarness({
    pageTotals: [0],
    scanStart: "2026-07-16T23:55:00.000Z",
    scanEnd: "2026-07-17T00:05:00.000Z",
    initialCheckpoint: {
      id: "usage-checkpoint",
      scope: "newapi_usage_logs",
      settledThrough: "2026-07-17T00:00:00.000Z",
      repairCursorThrough: "2026-07-16T22:00:29.000Z",
      repairWindowStart: "2026-07-16T22:00:00.000Z",
      repairWindowEnd: "2026-07-17T00:00:00.000Z",
      lastRunStatus: "applied",
      nextRunAfter: "2099-01-01T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    },
  });

  await harness.api.syncNewApiUsageForProxyRequest({ proxyLogId: "frozen-repair" });
  for (let run = 0; run < 4; run += 1) await harness.runNextTimer();

  assert.equal(harness.checkpoint?.settledThrough, "2026-07-17T00:05:00.000Z");
  assert.equal(harness.checkpoint?.scanMode, "repair");
  assert.equal(harness.checkpoint?.repairWindowStart, "2026-07-16T22:00:00.000Z");
  assert.equal(harness.checkpoint?.repairWindowEnd, "2026-07-17T00:00:00.000Z");
  assert.equal(harness.checkpoint?.scanStart, "2026-07-16T22:00:29.000Z");
  assert.equal(harness.checkpoint?.scanEnd, "2026-07-16T22:00:58.000Z");
});

test("a dense partial repair keeps its cursor across small forward drift and spends batch tokens", async () => {
  const harness = await createUsageSyncSchedulerHarness({
    pageTotals: [700],
    pageSize: 100,
    maxPagesPerRun: 3,
    initialCheckpoint: {
      id: "usage-checkpoint",
      scope: "newapi_usage_logs",
      settledThrough: "2026-07-17T00:00:00.000Z",
      runId: "repair-dense-run",
      runStartedAt: "2026-07-17T00:00:00.000Z",
      scanStart: "2026-07-16T22:00:00.000Z",
      scanEnd: "2026-07-16T22:00:29.000Z",
      scanTargetEnd: "2026-07-16T22:00:29.000Z",
      scanMode: "repair",
      repairWindowStart: "2026-07-16T22:00:00.000Z",
      repairWindowEnd: "2026-07-17T00:00:00.000Z",
      cursorPage: 0,
      lastRunStatus: "partial_failed",
      nextRunAfter: "2099-01-01T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    },
  });

  await harness.api.syncNewApiUsageForProxyRequest({ proxyLogId: "dense-repair" });
  await harness.runNextTimer();
  assert.equal(harness.checkpoint?.cursorPage, 3);
  harness.setScanEnd("2026-07-17T00:00:01.000Z");
  await harness.runNextTimer();
  assert.equal(harness.checkpoint?.cursorPage, 6);
  harness.setScanEnd("2026-07-17T00:00:02.000Z");
  await harness.runNextTimer();

  assert.deepEqual(harness.listedPages, [0, 1, 2, 3, 4, 5, 6, 0]);
  assert.equal(harness.checkpoint?.repairCursorThrough, "2026-07-16T22:00:29.000Z");
  assert.equal(
    harness.api.usageSettlementTailSnapshot().repairSlicesRemaining,
    12,
    "each repair page batch, including partial batches, must spend one token",
  );
});

test("an exhausted repair bucket preempts a partial repair for even a small forward lag", async () => {
  const sharedGlobal: Record<string, unknown> = {};
  const harness = await createUsageSyncSchedulerHarness({
    sharedGlobal,
    pageTotals: [100, 100],
    pageSize: 100,
    maxPagesPerRun: 3,
    initialCheckpoint: {
      id: "usage-checkpoint",
      scope: "newapi_usage_logs",
      settledThrough: "2026-07-16T23:59:30.000Z",
      runId: "repair-budget-exhausted",
      runStartedAt: "2026-07-17T00:00:00.000Z",
      scanStart: "2026-07-16T22:00:00.000Z",
      scanEnd: "2026-07-16T22:00:29.000Z",
      scanTargetEnd: "2026-07-16T22:00:29.000Z",
      scanMode: "repair",
      repairWindowStart: "2026-07-16T22:00:00.000Z",
      repairWindowEnd: "2026-07-17T00:00:00.000Z",
      repairCursorThrough: "2026-07-16T21:59:59.000Z",
      cursorPage: 3,
      scanExpectedTotal: 700,
      scanFirstIdentity: "stable-repair-head",
      lastRunStatus: "partial_failed",
      nextRunAfter: "2099-01-01T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    },
  });
  const runtime = sharedGlobal.__tokenInsideUsageSyncRuntime as {
    schedulerRepairSlicesRemaining: number;
    schedulerRepairBudgetRefillNotBeforeEpochMs: number;
  };
  runtime.schedulerRepairSlicesRemaining = 0;
  runtime.schedulerRepairBudgetRefillNotBeforeEpochMs = Date.now() + 300_000;

  await harness.api.syncNewApiUsageForProxyRequest({ proxyLogId: "forward-preempts" });
  await harness.runNextTimer();

  assert.equal(harness.listedPages[0], 0, "the stale repair page-3 cursor must not resume");
  assert.equal(
    (harness.checkpoint?.lastRunSummary as Record<string, unknown>)?.scanMode,
    "forward",
  );
  assert.equal(
    harness.checkpoint?.repairCursorThrough,
    "2026-07-16T21:59:59.000Z",
    "preemption must preserve the durable repair cursor",
  );
  assert.equal(
    harness.api.usageSettlementTailSnapshot().repairSlicesRemaining,
    0,
    "forward work must not mint or consume a repair token",
  );
});

test("an exhausted repair bucket still resumes a dense one-second forward OFFSET cursor", async () => {
  const sharedGlobal: Record<string, unknown> = {};
  const harness = await createUsageSyncSchedulerHarness({
    sharedGlobal,
    pageTotals: [700],
    pageSize: 100,
    maxPagesPerRun: 3,
    initialCheckpoint: {
      id: "usage-checkpoint",
      scope: "newapi_usage_logs",
      settledThrough: "2026-07-17T00:00:00.000Z",
      runId: "forward-dense-run",
      runStartedAt: "2026-07-17T00:00:00.000Z",
      scanStart: "2026-07-17T00:00:00.000Z",
      scanEnd: "2026-07-17T00:00:00.000Z",
      scanTargetEnd: "2026-07-17T00:00:00.000Z",
      scanMode: "forward",
      repairWindowStart: "2026-07-16T22:00:00.000Z",
      repairWindowEnd: "2026-07-17T00:00:00.000Z",
      repairCursorThrough: "2026-07-16T22:00:29.000Z",
      cursorPage: 3,
      scanExpectedTotal: 700,
      scanFirstIdentity: "log:token-1:log-0",
      lastRunStatus: "partial_failed",
      nextRunAfter: "2099-01-01T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    },
  });
  const runtime = sharedGlobal.__tokenInsideUsageSyncRuntime as {
    schedulerRepairSlicesRemaining: number;
    schedulerRepairBudgetRefillNotBeforeEpochMs: number;
  };
  runtime.schedulerRepairSlicesRemaining = 0;
  runtime.schedulerRepairBudgetRefillNotBeforeEpochMs = Date.now() + 300_000;

  await harness.api.syncNewApiUsageForProxyRequest({ proxyLogId: "forward-dense" });
  await harness.runNextTimer();

  assert.deepEqual(harness.listedPages, [3, 4, 5]);
  assert.equal(harness.checkpoint?.cursorPage, 6);
  assert.equal(harness.checkpoint?.scanMode, "forward");
  assert.equal(
    harness.checkpoint?.repairCursorThrough,
    "2026-07-16T22:00:29.000Z",
    "resuming forward pagination must preserve the durable repair cursor",
  );
  assert.equal(
    harness.api.usageSettlementTailSnapshot().repairSlicesRemaining,
    0,
    "forward pagination must not consume or refill the exhausted repair bucket",
  );

  await harness.runNextTimer();
  assert.deepEqual(
    harness.listedPages,
    [3, 4, 5, 6, 0],
    "the frozen forward OFFSET cursor must finish before repair is considered",
  );
  assert.equal(harness.checkpoint?.cursorPage, 0);
  assert.equal(harness.checkpoint?.scanMode, "repair");
  assert.equal(harness.checkpoint?.repairCursorThrough, "2026-07-16T22:00:29.000Z");
  assert.equal(harness.api.usageSettlementTailSnapshot().repairSlicesRemaining, 0);
});

test("an expanded empty forward slice shrinks before entering a dense burst", async () => {
  const harness = await createUsageSyncSchedulerHarness({
    pageTotals: [0, 0, 3_000],
    scanEnd: "2026-07-17T00:05:00.000Z",
    initialCheckpoint: {
      id: "usage-checkpoint",
      scope: "newapi_usage_logs",
      settledThrough: "2026-07-17T00:00:00.000Z",
      lastRunStatus: "applied",
      nextRunAfter: "2099-01-01T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    },
  });

  await harness.api.syncNewApiUsageForProxyRequest({ proxyLogId: "dense-boundary" });
  await harness.runNextTimer();
  assert.equal(harness.checkpoint?.settledThrough, "2026-07-17T00:00:29.000Z");

  await harness.runNextTimer();
  assert.equal(harness.checkpoint?.scanStart, "2026-07-17T00:00:29.000Z");
  assert.equal(harness.checkpoint?.scanEnd, "2026-07-17T00:01:08.000Z");
  assert.equal(harness.checkpoint?.cursorPage, 0);
  assert.equal(harness.checkpoint?.scanExpectedTotal, undefined);
  assert.equal(harness.checkpoint?.settledThrough, "2026-07-17T00:00:29.000Z");
  assert.equal(
    (harness.checkpoint?.lastRunSummary as Record<string, unknown>)?.sliceResized,
    true,
  );
});

test("a changing OFFSET slice resets to page zero without advancing its watermark", async () => {
  const harness = await createUsageSyncSchedulerHarness({
    pageTotals: [200, 201, 201],
    pageSize: 100,
    maxPagesPerRun: 1,
  });

  await harness.api.syncNewApiUsageForProxyRequest({ proxyLogId: "unstable-slice" });
  await harness.runNextTimer();
  assert.equal(harness.checkpoint?.cursorPage, 1);
  assert.equal(harness.checkpoint?.scanExpectedTotal, 200);
  assert.equal(harness.checkpoint?.settledThrough, undefined);

  await harness.runNextTimer();
  assert.deepEqual(harness.listedPages, [0, 1]);
  assert.equal(harness.checkpoint?.cursorPage, 0);
  assert.equal(harness.checkpoint?.scanExpectedTotal, undefined);
  assert.equal(harness.checkpoint?.settledThrough, undefined);
  assert.equal(
    (harness.checkpoint?.lastRunSummary as Record<string, unknown>)?.stabilityReset,
    true,
  );
  assert.deepEqual(harness.pendingDelays(), [250]);
});

test("an incomplete cursor continues while affected-user materialization is still pending", async () => {
  let releaseMaterialization!: () => void;
  const materialization = new Promise<void>((resolve) => {
    releaseMaterialization = resolve;
  });
  const harness = await createUsageSyncSchedulerHarness({
    pageTotals: [2, 2],
    backfillItems: [
      {
        proxyLogId: "proxy-1",
        feishuUserId: "user-1",
        billingPeriod: "2026-07",
      },
    ],
    finalizeBillingPeriod: () => materialization,
  });

  await harness.api.syncNewApiUsageForProxyRequest({ proxyLogId: "deferred-1" });
  await harness.runNextTimer();
  assert.deepEqual(harness.pendingDelays(), [250]);
  assert.deepEqual(harness.listedPages, [0]);
  assert.deepEqual(harness.events.slice(0, 2), [
    "checkpoint:1",
    "finalize:user-1:2026-07",
  ]);

  await harness.runNextTimer();
  assert.deepEqual(
    harness.listedPages,
    [0, 1, 0],
    "the forced cursor and slice verification must advance without waiting for the read model",
  );
  assert.deepEqual(harness.pendingDelays(), [250]);
  releaseMaterialization();
  await materialization;
});

test("a materializer rejection is observed without rolling back source progress", async () => {
  const expected = new Error("materializer failed");
  const harness = await createUsageSyncSchedulerHarness({
    pageTotals: [1],
    backfillItems: [
      {
        proxyLogId: "proxy-1",
        feishuUserId: "user-1",
        billingPeriod: "2026-07",
      },
    ],
    finalizeBillingPeriod: async () => {
      throw expected;
    },
  });

  await harness.api.syncNewApiUsageForProxyRequest({ proxyLogId: "deferred-1" });
  await harness.runNextTimer();
  await Promise.resolve();

  assert.equal(harness.listCalls, 2);
  assert.equal(harness.lockRuns, 1);
  assert.deepEqual(harness.events.slice(0, 2), [
    "checkpoint:0",
    "finalize:user-1:2026-07",
  ]);
  assert.equal(harness.schedulerErrors.length, 1);
  assert.match(JSON.stringify(harness.schedulerErrors[0]), /materialization_failed/);
});

test("deferrals arriving during a scan collapse into exactly one forced follow-up", async () => {
  const harness = await createUsageSyncSchedulerHarness({
    pageTotals: [1, 1],
    onListUsageLogs: async ({ call, api }) => {
      if (call !== 1) return;
      const deferred = await Promise.all([
        api.syncNewApiUsageForProxyRequest({ proxyLogId: "proxy-2" }),
        api.syncNewApiUsageForProxyRequest({ proxyLogId: "proxy-3" }),
        api.syncNewApiUsageForProxyRequest({ proxyLogId: "proxy-4" }),
      ]);
      assert.deepEqual(
        deferred.map((result) => result.reason),
        ["deferred", "deferred", "deferred"],
      );
    },
  });

  await harness.api.syncNewApiUsageForProxyRequest({ proxyLogId: "proxy-1" });
  await harness.runNextTimer();
  assert.deepEqual(
    harness.pendingDelays(),
    [250],
    "many in-flight deferrals must produce one timer, not one waiter/task each",
  );

  await harness.runNextTimer();
  assert.equal(
    harness.listCalls,
    4,
    "the coalesced flag must produce one follow-up scan plus one head verification per scan",
  );
  assert.deepEqual(harness.pendingDelays(), [250]);

  await harness.runNextTimer();
  assert.equal(harness.listCalls, 6);
  assert.deepEqual(harness.pendingDelays(), [250]);
  assert.deepEqual(harness.schedulerErrors, []);
});

test("force never overrides a disabled usage-sync policy", async () => {
  const harness = await createUsageSyncSchedulerHarness({
    enabled: false,
    pageTotals: [1],
  });

  const result = await harness.api.runDueNewApiUsageSync({ force: true });
  assert.equal(result.ran, false);
  assert.equal(result.reason, "disabled");
  assert.equal(harness.listCalls, 0);
  assert.equal(harness.lockRuns, 0);
});

test("a deferred wake cannot keep a disabled scheduler on the continuation cadence", async () => {
  const harness = await createUsageSyncSchedulerHarness({
    enabled: false,
    pageTotals: [1],
  });

  await harness.api.syncNewApiUsageForProxyRequest({ proxyLogId: "disabled-wake" });
  assert.deepEqual(harness.pendingDelays(), [250]);
  await harness.runNextTimer();

  assert.equal(harness.horizonCalls, 0);
  assert.equal(harness.listCalls, 0);
  assert.ok(
    (harness.pendingDelays()[0] ?? 0) >= 60_000,
    "disabled synchronization must return to its maintenance interval",
  );
  const secondDelay = await harness.runNextTimer();
  assert.ok(secondDelay >= 60_000);
  assert.equal(harness.horizonCalls, 0);
  assert.equal(harness.listCalls, 0);
  assert.ok((harness.pendingDelays()[0] ?? 0) >= 60_000);
});

test("a peer-owned advisory fence retries with jitter without recording scheduler failure", async () => {
  const harness = await createUsageSyncSchedulerHarness({
    pageTotals: [0],
    lockBusyAtRun: 1,
  });

  await harness.api.syncNewApiUsageForProxyRequest({ proxyLogId: "peer-owned" });
  await harness.runNextTimer();

  assert.equal(harness.lockRuns, 1);
  assert.equal(harness.listCalls, 0);
  assert.equal(harness.schedulerErrors.length, 0);
  assert.ok((harness.pendingDelays()[0] ?? 0) >= 250);
  assert.ok((harness.pendingDelays()[0] ?? 0) <= 1_500);

  await harness.runNextTimer();
  assert.equal(harness.lockRuns, 2);
  assert.ok(harness.listCalls > 0);
  assert.equal(harness.schedulerErrors.length, 0);
});

test("a forced source failure obeys durable retry instead of looping at continuation cadence", async () => {
  const harness = await createUsageSyncSchedulerHarness({
    pageTotals: [1],
    listUsageErrorAtCall: 1,
    nowIso: "2099-01-01T00:00:00.000Z",
  });

  await harness.api.syncNewApiUsageForProxyRequest({ proxyLogId: "scan-error" });
  await harness.runNextTimer();
  assert.equal(harness.listCalls, 1);
  assert.equal(harness.checkpoint?.failureCount, 1);
  assert.equal(harness.checkpoint?.nextRetryAt, "2099-01-01T00:05:00.000Z");
  assert.ok(
    (harness.pendingDelays()[0] ?? 0) >= 900,
    "the first transient retry must be bounded above the 250ms continuation cadence",
  );

  await harness.runNextTimer();
  assert.equal(harness.listCalls, 1, "durable retry backoff must block another source call");
  assert.deepEqual(harness.pendingDelays(), [300_000]);
  assert.equal(harness.schedulerErrors.length, 1);
});

test("startup recovery re-registers a matched source target even when the original observer never ran", async () => {
  const harness = await createUsageSyncSchedulerHarness({
    enabled: false,
    pageTotals: [0],
    recoveryTargets: [
      { feishuUserId: "recovered-user", billingPeriod: "2026-07" },
    ],
  });

  await harness.api.ensureUsageSyncScheduler();
  assert.deepEqual(harness.pendingDelays(), [1000]);
  await harness.runNextTimer();

  assert.equal(harness.recoveryListCalls, 1);
  assert.equal(harness.listCalls, 0, "disabled source sync must remain disabled");
  assert.deepEqual(harness.events, ["finalize:recovered-user:2026-07"]);
  const snapshot = harness.api.billingMaterializationRecoverySnapshot();
  assert.equal(snapshot.requested, false);
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.lastTargetCount, 1);
  assert.equal(snapshot.lastErrorAt, undefined);
  assert.equal(snapshot.nextRetryAt, undefined);
});

test("materialization rejection requests one recovery with a real not-before backoff", async () => {
  let finalizationAttempts = 0;
  const harness = await createUsageSyncSchedulerHarness({
    pageTotals: [2, 2],
    pendingHorizon: { count: 0 },
    recoveryTargets: [
      { feishuUserId: "retry-user", billingPeriod: "2026-07" },
    ],
    finalizeBillingPeriod: async () => {
      finalizationAttempts += 1;
      if (finalizationAttempts === 1) throw new Error("materialization rejected");
    },
  });

  await harness.api.ensureUsageSyncScheduler();
  await harness.runNextTimer();
  await Promise.resolve();

  const failed = harness.api.billingMaterializationRecoverySnapshot();
  assert.equal(failed.requested, true);
  assert.equal(failed.running, false);
  assert.equal(failed.lastTargetCount, 1);
  assert.equal(typeof failed.lastErrorAt, "string");
  assert.equal(typeof failed.nextRetryAt, "string");
  assert.equal(harness.recoveryListCalls, 1);
  assert.ok((harness.pendingDelays()[0] ?? 0) >= 59_000, "failure must not spin at 1s");

  await harness.api.syncNewApiUsageForProxyRequest({ proxyLogId: "force-usage-scan" });
  assert.ok((harness.pendingDelays()[0] ?? 0) <= 5_000);
  await harness.runNextTimer();
  assert.equal(
    harness.recoveryListCalls,
    1,
    "a 1s forced usage tick must skip recovery until recoveryNotBefore",
  );
  assert.ok(
    (harness.pendingDelays()[0] ?? 0) >= 54_000,
    "a tail refresh must not bypass materialization recovery backoff",
  );
});

test("drain force-enumerates durable targets before draining finalizers", async () => {
  const harness = await createUsageSyncSchedulerHarness({
    enabled: false,
    pageTotals: [0],
    recoveryTargets: [
      { feishuUserId: "drain-user", billingPeriod: "2026-06" },
    ],
  });

  await harness.api.drainNewApiUsageSettlements();
  assert.equal(harness.recoveryListCalls, 1);
  assert.deepEqual(harness.events, ["finalize:drain-user:2026-06"]);
});

test("concurrent drains share one recovery enumeration instead of allocating waiter work", async () => {
  let releaseList!: () => void;
  const listBlocked = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  const harness = await createUsageSyncSchedulerHarness({
    enabled: false,
    pageTotals: [0],
    recoveryTargets: [
      { feishuUserId: "single-flight-user", billingPeriod: "2026-07" },
    ],
    onListRecoveryTargets: () => listBlocked,
  });

  const drains = Promise.all([
    harness.api.drainNewApiUsageSettlements(),
    harness.api.drainNewApiUsageSettlements(),
    harness.api.drainNewApiUsageSettlements(),
  ]);
  await Promise.resolve();
  assert.equal(harness.recoveryListCalls, 1);
  releaseList();
  await drains;
  assert.deepEqual(harness.events, ["finalize:single-flight-user:2026-07"]);
});

test("JSON storage keeps durable materialization recovery as a no-op", async () => {
  const harness = await createUsageSyncSchedulerHarness({
    storeBackend: "json",
    enabled: false,
    pageTotals: [0],
    recoveryTargets: [
      { feishuUserId: "must-not-run", billingPeriod: "2026-07" },
    ],
  });

  await harness.api.drainNewApiUsageSettlements();
  assert.equal(harness.recoveryListCalls, 0);
  assert.deepEqual(harness.events, []);
  const snapshot = harness.api.billingMaterializationRecoverySnapshot();
  assert.equal(snapshot.requested, false);
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.lastTargetCount, 0);
});
