import { getConfig } from "./config.ts";

type ReconcileBillingPeriod = (feishuUserId: string, period: string) => Promise<void>;

type PendingFinalization = {
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
  dirty: boolean;
  delayMs: number;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type BillingPeriodFinalizerOptions = {
  isEnabled?: () => boolean;
  unrefTimers?: boolean;
  maxConcurrency?: () => number;
};

export type BillingPeriodFinalizer = {
  (feishuUserId: string, period: string, delayMs?: number): Promise<void>;
  drain(): Promise<void>;
  pendingCount(): number;
  snapshot(): {
    active: number;
    queued: number;
    pendingKeys: number;
    maxConcurrency: number;
  };
};

/**
 * Creates a keyed, trailing-edge billing finalizer.
 *
 * Calls made before work starts are debounced. Calls made while reconciliation
 * is running mark that key dirty, causing one trailing reconciliation after the
 * current run. Every caller in the batch shares a promise that settles only
 * after the final non-dirty run.
 */
export function createBillingPeriodFinalizer(
  reconcile: ReconcileBillingPeriod,
  options: BillingPeriodFinalizerOptions = {},
) {
  const pending = new Map<string, PendingFinalization>();
  const isEnabled = options.isEnabled ?? (() => true);
  let activeReconciliations = 0;
  const reconciliationWaiters: Array<(release: () => void) => void> = [];

  function maxConcurrency() {
    return Math.max(
      1,
      Math.trunc(options.maxConcurrency?.() ?? Number.MAX_SAFE_INTEGER),
    );
  }

  function releaseReconciliationFactory() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeReconciliations = Math.max(activeReconciliations - 1, 0);
      dispatchReconciliations();
    };
  }

  function dispatchReconciliations() {
    while (
      activeReconciliations < maxConcurrency() &&
      reconciliationWaiters.length > 0
    ) {
      const waiter = reconciliationWaiters.shift();
      if (!waiter) return;
      activeReconciliations += 1;
      waiter(releaseReconciliationFactory());
    }
  }

  async function acquireReconciliationSlot() {
    if (
      activeReconciliations < maxConcurrency() &&
      reconciliationWaiters.length === 0
    ) {
      activeReconciliations += 1;
      return releaseReconciliationFactory();
    }
    return new Promise<() => void>((resolve) => {
      reconciliationWaiters.push(resolve);
      dispatchReconciliations();
    });
  }

  function arm(
    key: string,
    feishuUserId: string,
    period: string,
    entry: PendingFinalization,
  ) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void run(key, feishuUserId, period, entry);
    }, entry.delayMs);
    if (options.unrefTimers) entry.timer.unref?.();
  }

  async function run(
    key: string,
    feishuUserId: string,
    period: string,
    entry: PendingFinalization,
  ) {
    if (pending.get(key) !== entry || entry.running) return;

    entry.running = true;
    entry.dirty = false;
    let failed = false;
    let failure: unknown;
    let releaseReconciliation: (() => void) | undefined;
    try {
      releaseReconciliation = await acquireReconciliationSlot();
      await reconcile(feishuUserId, period);
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      releaseReconciliation?.();
      entry.running = false;
    }

    if (pending.get(key) !== entry) return;

    // A request received during this run owns a trailing reconciliation. This
    // also gives a failed run one demand-driven retry without creating an
    // unbounded autonomous retry loop.
    if (entry.dirty) {
      arm(key, feishuUserId, period, entry);
      return;
    }

    pending.delete(key);
    if (failed) entry.reject(failure);
    else entry.resolve();
  }

  const finalizeBillingPeriod = function finalizeBillingPeriod(
    feishuUserId: string,
    period: string,
    delayMs = 750,
  ): Promise<void> {
    if (!isEnabled()) return Promise.resolve();

    const key = `${feishuUserId}\n${period}`;
    const existing = pending.get(key);
    if (existing) {
      existing.delayMs = Math.max(0, delayMs);
      if (existing.running) existing.dirty = true;
      else arm(key, feishuUserId, period, existing);
      return existing.promise;
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const entry = {
      running: false,
      dirty: false,
      delayMs: Math.max(0, delayMs),
      promise,
      resolve,
      reject,
    } satisfies PendingFinalization;
    pending.set(key, entry);
    arm(key, feishuUserId, period, entry);
    return promise;
  } as BillingPeriodFinalizer;

  finalizeBillingPeriod.pendingCount = () => pending.size;
  finalizeBillingPeriod.snapshot = () => ({
    active: activeReconciliations,
    queued: reconciliationWaiters.length,
    pendingKeys: pending.size,
    maxConcurrency: maxConcurrency(),
  });
  finalizeBillingPeriod.drain = async () => {
    const failures: unknown[] = [];
    while (pending.size > 0) {
      const entries = [...pending.entries()];
      for (const [key, entry] of entries) {
        // Draining is an explicit request to finish accepted work now. It must
        // also carry through to a dirty trailing generation armed by a run
        // that is already in progress.
        entry.delayMs = 0;
        if (entry.timer) {
          clearTimeout(entry.timer);
          entry.timer = undefined;
        }
        const separator = key.indexOf("\n");
        const feishuUserId = key.slice(0, separator);
        const period = key.slice(separator + 1);
        void run(key, feishuUserId, period, entry);
      }
      const results = await Promise.allSettled(entries.map(([, entry]) => entry.promise));
      for (const result of results) {
        if (result.status === "rejected") failures.push(result.reason);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Billing period finalizer drain failed");
    }
  };

  return finalizeBillingPeriod;
}

const billingPeriodFinalizerRuntimeVersion = 1 as const;
const billingPeriodFinalizerRuntimeKey =
  "__tokenInsideBillingPeriodFinalizerRuntimeV1" as const;

type BillingPeriodFinalizerGlobalRuntime = {
  version: typeof billingPeriodFinalizerRuntimeVersion;
  finalizer: BillingPeriodFinalizer;
};

type BillingPeriodFinalizerRuntimeGlobal = typeof globalThis & {
  [billingPeriodFinalizerRuntimeKey]?: BillingPeriodFinalizerGlobalRuntime;
};

function createPostgresBillingPeriodFinalizer() {
  return createBillingPeriodFinalizer(
    async (feishuUserId, period) => {
      // Keep the coordinator independently testable under Node's native TS test
      // runner, which does not resolve the application's @/* import aliases.
      const { reconcilePostgresBillingPeriodForUser } = await import("./postgres-store.ts");
      await reconcilePostgresBillingPeriodForUser(feishuUserId, period);
    },
    {
      isEnabled: () => getConfig().storeBackend === "postgres",
      unrefTimers: true,
      maxConcurrency: () => getConfig().billing.materializationConcurrencyMax,
    },
  );
}

function getPostgresBillingPeriodFinalizer() {
  const runtimeGlobal = globalThis as BillingPeriodFinalizerRuntimeGlobal;
  const existing = runtimeGlobal[billingPeriodFinalizerRuntimeKey];
  if (existing?.version === billingPeriodFinalizerRuntimeVersion) {
    return existing.finalizer;
  }

  const finalizer = createPostgresBillingPeriodFinalizer();
  runtimeGlobal[billingPeriodFinalizerRuntimeKey] = {
    version: billingPeriodFinalizerRuntimeVersion,
    finalizer,
  };
  return finalizer;
}

// Next may evaluate this module in several server chunks (instrumentation,
// proxy/admin routes, and health). A versioned global owns the production
// finalizer so all chunks observe one pending map and one concurrency queue.
const finalizePostgresBillingPeriod = getPostgresBillingPeriodFinalizer();

export function finalizeBillingPeriodAfterSettlements(
  feishuUserId: string,
  period: string,
  delayMs = 750,
) {
  return finalizePostgresBillingPeriod(feishuUserId, period, delayMs);
}

export function drainBillingPeriodFinalizations() {
  return finalizePostgresBillingPeriod.drain();
}

export function billingPeriodFinalizationSnapshot() {
  return finalizePostgresBillingPeriod.snapshot();
}
