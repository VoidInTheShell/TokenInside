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
    try {
      await reconcile(feishuUserId, period);
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
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

  return function finalizeBillingPeriod(
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
  };
}

const finalizePostgresBillingPeriod = createBillingPeriodFinalizer(
  async (feishuUserId, period) => {
    // Keep the coordinator independently testable under Node's native TS test
    // runner, which does not resolve the application's @/* import aliases.
    const { reconcilePostgresBillingPeriodForUser } = await import("./postgres-store.ts");
    await reconcilePostgresBillingPeriodForUser(feishuUserId, period);
  },
  {
    isEnabled: () => getConfig().storeBackend === "postgres",
    unrefTimers: true,
  },
);

export function finalizeBillingPeriodAfterSettlements(
  feishuUserId: string,
  period: string,
  delayMs = 750,
) {
  return finalizePostgresBillingPeriod(feishuUserId, period, delayMs);
}
