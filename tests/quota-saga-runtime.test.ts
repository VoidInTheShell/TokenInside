import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const quotaSagaPath = new URL("../lib/quota-saga.ts", import.meta.url);

type QuotaSagaTestApi = {
  ensureQuotaOperationWorker(): void;
  quotaOperationExecutionSnapshot(): {
    active: number;
    queued: number;
    maxConcurrency: number;
  };
  runQuotaOperation(operationId: string): Promise<unknown>;
};

type Deferred = {
  promise: Promise<void>;
  resolve(): void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type TimerHandle = {
  id: number;
  unref(): void;
};

type TimerRecord = {
  handle: TimerHandle;
  callback: () => void | Promise<void>;
  delayMs: number;
  cleared: boolean;
};

async function createQuotaSagaChunk(input: {
  sharedGlobal: Record<string, unknown>;
  timerRecords: TimerRecord[];
  claims: string[];
  claimGates?: Record<string, Deferred>;
}) {
  const source = await readFile(quotaSagaPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: "quota-saga.ts",
  }).outputText;

  const noopModule = new Proxy<Record<string, unknown>>(
    {},
    {
      get: () => () => undefined,
    },
  );
  const imports: Record<string, Record<string, unknown>> = {
    "@/lib/config": {
      getConfig: () => ({ billing: { operationConcurrencyMax: 1 } }),
    },
    "@/lib/crypto": {
      nowIso: () => "2026-07-17T00:00:00.000Z",
      randomId: (prefix: string) => `${prefix}-lease`,
      sha256Hex: () => "hash",
    },
    "@/lib/quota-guard": {
      assertQuotaWriteActionEnabled: async () => undefined,
      quotaWritesPaused: () => false,
    },
    "@/lib/store": {
      findQuotaOperationById: async (operationId: string) => ({
        id: operationId,
        feishuUserId: `user-${operationId}`,
        state: "planned",
        operationType: "quota_adjust",
        attemptCount: 0,
      }),
      withUserQuotaOperationLock: async (
        _feishuUserId: string,
        fn: () => Promise<unknown>,
      ) => fn(),
      claimQuotaOperationExecution: async ({
        operationId,
      }: {
        operationId: string;
      }) => {
        input.claims.push(operationId);
        await input.claimGates?.[operationId]?.promise;
        return {
          id: operationId,
          state: "completed",
          operationType: "quota_adjust",
          attemptCount: 0,
        };
      },
      renewQuotaOperationExecution: async () => undefined,
      releaseQuotaOperationExecution: async () => undefined,
      listDueQuotaOperations: async () => [],
    },
    "@/lib/quota-saga-state": {
      canAutoResumeKeyRotationObservationFailure: () => false,
      canCompensateKeyRotationBeforeUpstream: () => false,
      quotaOperationRetryResumeState: () => "planned",
    },
  };

  let nextTimerId = input.timerRecords.length + 1;
  const setTimer = (
    callback: () => void | Promise<void>,
    delayMs = 0,
  ) => {
    const handle: TimerHandle = { id: nextTimerId++, unref() {} };
    input.timerRecords.push({ handle, callback, delayMs, cleared: false });
    return handle;
  };
  const clearTimer = (handle: TimerHandle) => {
    const timer = input.timerRecords.find((candidate) => candidate.handle === handle);
    if (timer) timer.cleared = true;
  };
  const module = { exports: {} as QuotaSagaTestApi };
  const context = {
    module,
    exports: module.exports,
    require: (specifier: string) => imports[specifier] ?? noopModule,
    console: { error() {} },
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    setInterval: setTimer,
    clearInterval: clearTimer,
    globalThis: input.sharedGlobal,
  };
  runInNewContext(transpiled, context, { filename: "quota-saga.js" });
  return module.exports;
}

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

test("independent Next chunks share one quota worker timer", async () => {
  const sharedGlobal: Record<string, unknown> = {};
  const timerRecords: TimerRecord[] = [];
  const claims: string[] = [];
  const first = await createQuotaSagaChunk({ sharedGlobal, timerRecords, claims });
  const second = await createQuotaSagaChunk({ sharedGlobal, timerRecords, claims });

  first.ensureQuotaOperationWorker();
  second.ensureQuotaOperationWorker();
  first.ensureQuotaOperationWorker();

  assert.equal(timerRecords.length, 1);
  assert.equal(timerRecords[0]?.delayMs, 500);
  assert.equal(timerRecords[0]?.cleared, false);
  const runtime = sharedGlobal.__tokenInsideQuotaSagaRuntimeV1 as {
    version: number;
    workerStarted: boolean;
    workerTimer: TimerHandle;
    activeQuotaOperations: number;
    quotaOperationWaiters: Array<() => void>;
  };
  assert.equal(runtime.version, 1);
  assert.equal(runtime.workerStarted, true);
  assert.equal(runtime.workerTimer, timerRecords[0]?.handle);
  assert.equal(runtime.activeQuotaOperations, 0);
  assert.equal(runtime.quotaOperationWaiters.length, 0);
});

test("independent Next chunks share quota operation slots and waiter handoff", async () => {
  const sharedGlobal: Record<string, unknown> = {};
  const timerRecords: TimerRecord[] = [];
  const claims: string[] = [];
  const firstGate = deferred();
  const secondGate = deferred();
  const claimGates = { first: firstGate, second: secondGate };
  const firstChunk = await createQuotaSagaChunk({
    sharedGlobal,
    timerRecords,
    claims,
    claimGates,
  });
  const secondChunk = await createQuotaSagaChunk({
    sharedGlobal,
    timerRecords,
    claims,
    claimGates,
  });

  const firstRun = firstChunk.runQuotaOperation("first");
  await flushMicrotasks();
  const secondRun = secondChunk.runQuotaOperation("second");
  await flushMicrotasks();

  assert.deepEqual(claims, ["first"]);
  assert.deepEqual({ ...firstChunk.quotaOperationExecutionSnapshot() }, {
    active: 1,
    queued: 1,
    maxConcurrency: 1,
  });
  assert.deepEqual({ ...secondChunk.quotaOperationExecutionSnapshot() }, {
    active: 1,
    queued: 1,
    maxConcurrency: 1,
  });

  firstGate.resolve();
  await firstRun;
  await flushMicrotasks();
  assert.deepEqual(claims, ["first", "second"]);
  assert.deepEqual({ ...firstChunk.quotaOperationExecutionSnapshot() }, {
    active: 1,
    queued: 0,
    maxConcurrency: 1,
  });

  secondGate.resolve();
  await secondRun;
  assert.deepEqual({ ...secondChunk.quotaOperationExecutionSnapshot() }, {
    active: 0,
    queued: 0,
    maxConcurrency: 1,
  });
});
