import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const runtimeStartupPath = new URL("../lib/runtime-startup.ts", import.meta.url);
const instrumentationPath = new URL("../instrumentation.ts", import.meta.url);
const healthPath = new URL("../app/api/health/route.ts", import.meta.url);

type RuntimeStartupSnapshot = {
  status: "idle" | "starting" | "retrying" | "ready";
  ready: boolean;
  attempts: number;
  workersStarted: boolean;
  lastError?: string;
  nextRetryAt?: string;
};

type RuntimeStartupApi = {
  ensureRuntimeStartup(): Promise<void>;
  runtimeStartupSnapshot(): RuntimeStartupSnapshot;
};

type TimerHandle = {
  id: number;
  unref(): void;
};

type TimerRecord = {
  handle: TimerHandle;
  callback: () => void;
  delayMs: number;
};

type WorkerStarts = {
  quota: number;
  access: number;
  department: number;
  packageReset: number;
};

async function createRuntimeStartupChunk(input: {
  sharedGlobal: Record<string, unknown>;
  timers: TimerRecord[];
  warm(): Promise<void>;
  checkSchema?(): Promise<{ ready: boolean }>;
  storeBackend?: "json" | "postgres";
  workerStarts: WorkerStarts;
  errorLogs?: string[];
}) {
  const source = await readFile(runtimeStartupPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: "runtime-startup.ts",
  }).outputText;
  const imports: Record<string, Record<string, unknown>> = {
    "@/lib/config": {
      getConfig: () => ({ storeBackend: input.storeBackend ?? "postgres" }),
    },
    "@/lib/quota-saga": {
      ensureQuotaOperationWorker: () => {
        input.workerStarts.quota += 1;
      },
    },
    "@/lib/user-access-control": {
      ensureUserAccessRecoveryWorker: () => {
        input.workerStarts.access += 1;
      },
    },
    "@/lib/quota-operation-submit": { warmQuotaSubmitPool: input.warm },
    "@/lib/postgres-store": {
      checkPostgresSchema: input.checkSchema ?? (async () => ({ ready: true })),
    },
    "@/lib/department-member-sync": {
      ensureDepartmentMemberSyncWorker: () => {
        input.workerStarts.department += 1;
      },
    },
    "@/lib/package-reset-scheduler": {
      ensurePackageResetScheduler: () => {
        input.workerStarts.packageReset += 1;
      },
    },
  };
  let timerId = input.timers.length + 1;
  const setTimer = (callback: () => void, delayMs = 0) => {
    const handle: TimerHandle = { id: timerId++, unref() {} };
    input.timers.push({ handle, callback, delayMs });
    return handle;
  };
  const module = { exports: {} as RuntimeStartupApi };
  runInNewContext(
    transpiled,
    {
      module,
      exports: module.exports,
      require: (specifier: string) => {
        const dependency = imports[specifier];
        if (!dependency) throw new Error(`unexpected runtime import: ${specifier}`);
        return dependency;
      },
      globalThis: input.sharedGlobal,
      setTimeout: setTimer,
      clearTimeout() {},
      console: {
        info() {},
        error(value: string) {
          input.errorLogs?.push(value);
        },
      },
    },
    { filename: "runtime-startup.js" },
  );
  return module.exports;
}

async function flushMicrotasks() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function emptyWorkerStarts(): WorkerStarts {
  return { quota: 0, access: 0, department: 0, packageReset: 0 };
}

test("startup retries a transient pool timeout and starts every worker exactly once", async () => {
  const sharedGlobal: Record<string, unknown> = {};
  const timers: TimerRecord[] = [];
  const workerStarts = emptyWorkerStarts();
  const errorLogs: string[] = [];
  let warmAttempts = 0;
  const api = await createRuntimeStartupChunk({
    sharedGlobal,
    timers,
    workerStarts,
    errorLogs,
    warm: async () => {
      warmAttempts += 1;
      if (warmAttempts === 1) {
        const error = new Error("Connection terminated due to connection timeout") as Error & {
          code?: string;
        };
        error.code = "ETIMEDOUT";
        throw error;
      }
    },
  });

  const startup = api.ensureRuntimeStartup();
  await flushMicrotasks();
  assert.deepEqual(
    { ...api.runtimeStartupSnapshot(), nextRetryAt: undefined },
    {
      status: "retrying",
      ready: false,
      attempts: 1,
      workersStarted: false,
      lastError: "connection_timeout",
      nextRetryAt: undefined,
    },
  );
  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.delayMs, 250);
  assert.match(errorLogs[0] ?? "", /"reason":"connection_timeout"/);
  assert.doesNotMatch(errorLogs[0] ?? "", /Connection terminated/);

  timers[0]?.callback();
  await startup;
  assert.equal(warmAttempts, 2);
  assert.deepEqual({ ...api.runtimeStartupSnapshot() }, {
    status: "ready",
    ready: true,
    attempts: 2,
    workersStarted: true,
    lastError: undefined,
    nextRetryAt: undefined,
  });
  assert.deepEqual(workerStarts, {
    quota: 1,
    access: 1,
    department: 1,
    packageReset: 1,
  });
  await api.ensureRuntimeStartup();
  assert.equal(warmAttempts, 2);
  assert.deepEqual(workerStarts, {
    quota: 1,
    access: 1,
    department: 1,
    packageReset: 1,
  });
});

test("independent Next chunks share one startup loop and one worker activation", async () => {
  const sharedGlobal: Record<string, unknown> = {};
  const timers: TimerRecord[] = [];
  const firstWorkers = emptyWorkerStarts();
  const secondWorkers = emptyWorkerStarts();
  let resolveWarm!: () => void;
  const warmGate = new Promise<void>((resolve) => {
    resolveWarm = resolve;
  });
  let firstWarmCalls = 0;
  let secondWarmCalls = 0;
  const first = await createRuntimeStartupChunk({
    sharedGlobal,
    timers,
    workerStarts: firstWorkers,
    warm: async () => {
      firstWarmCalls += 1;
      await warmGate;
    },
  });
  const second = await createRuntimeStartupChunk({
    sharedGlobal,
    timers,
    workerStarts: secondWorkers,
    warm: async () => {
      secondWarmCalls += 1;
    },
  });

  const firstStartup = first.ensureRuntimeStartup();
  const secondStartup = second.ensureRuntimeStartup();
  assert.equal(firstStartup, secondStartup);
  await flushMicrotasks();
  assert.equal(firstWarmCalls, 1);
  assert.equal(secondWarmCalls, 0);
  assert.equal(first.runtimeStartupSnapshot().status, "starting");
  assert.equal(second.runtimeStartupSnapshot().status, "starting");

  resolveWarm();
  await Promise.all([firstStartup, secondStartup]);
  assert.equal(first.runtimeStartupSnapshot().ready, true);
  assert.equal(second.runtimeStartupSnapshot().ready, true);
  assert.deepEqual(firstWorkers, {
    quota: 1,
    access: 1,
    department: 1,
    packageReset: 1,
  });
  assert.deepEqual(secondWorkers, emptyWorkerStarts());
  assert.equal(timers.length, 0);
});

test("workers wait for the migrated schema even after PostgreSQL accepts connections", async () => {
  const sharedGlobal: Record<string, unknown> = {};
  const timers: TimerRecord[] = [];
  const workerStarts = emptyWorkerStarts();
  let schemaChecks = 0;
  let warmAttempts = 0;
  const api = await createRuntimeStartupChunk({
    sharedGlobal,
    timers,
    workerStarts,
    warm: async () => {
      warmAttempts += 1;
    },
    checkSchema: async () => {
      schemaChecks += 1;
      return { ready: schemaChecks > 1 };
    },
  });

  const startup = api.ensureRuntimeStartup();
  await flushMicrotasks();
  assert.equal(api.runtimeStartupSnapshot().status, "retrying");
  assert.equal(api.runtimeStartupSnapshot().lastError, "schema_not_ready");
  assert.equal(api.runtimeStartupSnapshot().workersStarted, false);
  assert.equal(warmAttempts, 0);
  assert.deepEqual(workerStarts, emptyWorkerStarts());
  assert.equal(timers[0]?.delayMs, 250);

  timers[0]?.callback();
  await startup;
  assert.equal(schemaChecks, 2);
  assert.equal(warmAttempts, 1);
  assert.equal(api.runtimeStartupSnapshot().ready, true);
  assert.deepEqual(workerStarts, {
    quota: 1,
    access: 1,
    department: 1,
    packageReset: 1,
  });
});

test("JSON store startup skips every PostgreSQL readiness dependency", async () => {
  const workerStarts = emptyWorkerStarts();
  let warmAttempts = 0;
  let schemaChecks = 0;
  const api = await createRuntimeStartupChunk({
    sharedGlobal: {},
    timers: [],
    workerStarts,
    storeBackend: "json",
    warm: async () => {
      warmAttempts += 1;
    },
    checkSchema: async () => {
      schemaChecks += 1;
      return { ready: false };
    },
  });

  await api.ensureRuntimeStartup();
  assert.equal(warmAttempts, 0);
  assert.equal(schemaChecks, 0);
  assert.equal(api.runtimeStartupSnapshot().ready, true);
  assert.deepEqual(workerStarts, {
    quota: 1,
    access: 1,
    department: 1,
    packageReset: 1,
  });
});

test("startup retry delays back off and cap without leaking raw DNS failures", async () => {
  const sharedGlobal: Record<string, unknown> = {};
  const timers: TimerRecord[] = [];
  const errorLogs: string[] = [];
  const api = await createRuntimeStartupChunk({
    sharedGlobal,
    timers,
    workerStarts: emptyWorkerStarts(),
    errorLogs,
    warm: async () => {
      const error = new Error("getaddrinfo EAI_AGAIN postgres.private") as Error & {
        code?: string;
      };
      error.code = "EAI_AGAIN";
      throw error;
    },
  });

  void api.ensureRuntimeStartup();
  await flushMicrotasks();
  const expectedDelays = [250, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 30_000];
  for (let index = 0; index < expectedDelays.length; index += 1) {
    assert.equal(timers[index]?.delayMs, expectedDelays[index]);
    assert.equal(api.runtimeStartupSnapshot().lastError, "dns_unavailable");
    assert.doesNotMatch(errorLogs[index] ?? "", /postgres\.private/);
    timers[index]?.callback();
    await flushMicrotasks();
  }
});

test("instrumentation is non-blocking and health exposes startup readiness", async () => {
  const [instrumentation, health, runtime] = await Promise.all([
    readFile(instrumentationPath, "utf8"),
    readFile(healthPath, "utf8"),
    readFile(runtimeStartupPath, "utf8"),
  ]);
  assert.match(instrumentation, /void ensureRuntimeStartup\(\)/);
  assert.doesNotMatch(instrumentation, /await warmQuotaSubmitPool|ensureQuotaOperationWorker/);
  assert.match(health, /void ensureRuntimeStartup\(\)/);
  assert.match(health, /const ready = storeReady && runtimeStartup\.ready/);
  assert.match(health, /runtimeStartup,/);
  assert.match(health, /status: ready \? 200 : 503/);
  assert.match(runtime, /const startupRetryDelaysMs = \[250, 500, 1_000, 2_000, 5_000, 10_000, 30_000\]/);
  assert.match(runtime, /getConfig\(\)\.storeBackend === "postgres"/);
  assert.ok(
    runtime.indexOf("await checkPostgresSchema()") <
      runtime.indexOf("await warmQuotaSubmitPool()"),
  );
  assert.doesNotMatch(runtime, /ensureUsageSyncScheduler|quota-balance-observer/);
});
