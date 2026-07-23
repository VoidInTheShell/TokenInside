export type RuntimeStartupStatus = "idle" | "starting" | "retrying" | "ready";

export type RuntimeStartupError =
  | "configuration_error"
  | "connection_timeout"
  | "dns_unavailable"
  | "schema_not_ready"
  | "database_unavailable"
  | "initialization_failed";

export type RuntimeStartupSnapshot = {
  status: RuntimeStartupStatus;
  ready: boolean;
  attempts: number;
  workersStarted: boolean;
  lastError?: RuntimeStartupError;
  nextRetryAt?: string;
};

type RuntimeStartupState = {
  version: 1;
  status: RuntimeStartupStatus;
  attempts: number;
  workersStarted: boolean;
  lastError?: RuntimeStartupError;
  nextRetryAt?: string;
  startPromise?: Promise<void>;
  retryTimer?: ReturnType<typeof setTimeout>;
};

type RuntimeStartupGlobal = typeof globalThis & {
  __tokenInsideRuntimeStartupV1?: RuntimeStartupState;
};

const runtimeGlobal = globalThis as RuntimeStartupGlobal;
const runtimeStartup = (runtimeGlobal.__tokenInsideRuntimeStartupV1 ??= {
  version: 1,
  status: "idle",
  attempts: 0,
  workersStarted: false,
});

const startupRetryDelaysMs = [250, 500, 1_000, 2_000, 5_000, 10_000, 30_000];

function retryDelayMs(attempt: number) {
  return startupRetryDelaysMs[
    Math.min(Math.max(attempt - 1, 0), startupRetryDelaysMs.length - 1)
  ];
}

function classifyStartupError(error: unknown): RuntimeStartupError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  if (/DATABASE_URL|required|configuration/i.test(message)) return "configuration_error";
  if (/schema.*not ready/i.test(message)) return "schema_not_ready";
  if (["EAI_AGAIN", "ENOTFOUND"].includes(code) || /getaddrinfo|dns/i.test(message)) {
    return "dns_unavailable";
  }
  if (["ETIMEDOUT", "ETIME"].includes(code) || /timed? ?out|timeout/i.test(message)) {
    return "connection_timeout";
  }
  if (
    ["ECONNREFUSED", "ECONNRESET", "57P01", "57P02", "57P03"].includes(code) ||
    /connection terminated|connection refused|database/i.test(message)
  ) {
    return "database_unavailable";
  }
  return "initialization_failed";
}

function waitForRetry(delayMs: number) {
  return new Promise<void>((resolve) => {
    runtimeStartup.retryTimer = setTimeout(() => {
      runtimeStartup.retryTimer = undefined;
      resolve();
    }, delayMs);
    runtimeStartup.retryTimer.unref?.();
  });
}

async function initializeRuntimeOnce() {
  const [
    { ensureQuotaOperationWorker },
    { ensureUserAccessRecoveryWorker },
    { getConfig },
    { warmQuotaSubmitPool },
    { checkPostgresSchema },
    { ensureDepartmentMemberSyncWorker },
    { ensurePackageResetScheduler },
  ] = await Promise.all([
    import("@/lib/quota-saga"),
    import("@/lib/user-access-control"),
    import("@/lib/config"),
    import("@/lib/quota-operation-submit"),
    import("@/lib/postgres-store"),
    import("@/lib/department-member-sync"),
    import("@/lib/package-reset-scheduler"),
  ]);

  if (getConfig().storeBackend === "postgres") {
    const schema = await checkPostgresSchema();
    if (!schema.ready) throw new Error("TokenInside schema is not ready");
    await warmQuotaSubmitPool();
  }
  if (runtimeStartup.workersStarted) return;
  ensureQuotaOperationWorker();
  ensureUserAccessRecoveryWorker();
  ensureDepartmentMemberSyncWorker();
  ensurePackageResetScheduler();
  runtimeStartup.workersStarted = true;
}

async function runRuntimeStartup() {
  for (;;) {
    runtimeStartup.attempts += 1;
    runtimeStartup.status = runtimeStartup.attempts === 1 ? "starting" : "retrying";
    runtimeStartup.nextRetryAt = undefined;
    try {
      await initializeRuntimeOnce();
      runtimeStartup.status = "ready";
      runtimeStartup.lastError = undefined;
      runtimeStartup.nextRetryAt = undefined;
      console.info(
        JSON.stringify({
          event: "tokeninside.runtime_startup.ready",
          attempts: runtimeStartup.attempts,
        }),
      );
      return;
    } catch (error) {
      const lastError = classifyStartupError(error);
      const delayMs = retryDelayMs(runtimeStartup.attempts);
      runtimeStartup.status = "retrying";
      runtimeStartup.lastError = lastError;
      runtimeStartup.nextRetryAt = new Date(Date.now() + delayMs).toISOString();
      console.error(
        JSON.stringify({
          event: "tokeninside.runtime_startup.retrying",
          attempt: runtimeStartup.attempts,
          reason: lastError,
          retryInMs: delayMs,
        }),
      );
      await waitForRetry(delayMs);
    }
  }
}

export function ensureRuntimeStartup() {
  if (runtimeStartup.status === "ready") return Promise.resolve();
  if (!runtimeStartup.startPromise) {
    runtimeStartup.status = "starting";
    runtimeStartup.startPromise = runRuntimeStartup();
  }
  return runtimeStartup.startPromise;
}

export function runtimeStartupSnapshot(): RuntimeStartupSnapshot {
  return {
    status: runtimeStartup.status,
    ready: runtimeStartup.status === "ready" && runtimeStartup.workersStarted,
    attempts: runtimeStartup.attempts,
    workersStarted: runtimeStartup.workersStarted,
    lastError: runtimeStartup.lastError,
    nextRetryAt: runtimeStartup.nextRetryAt,
  };
}
