import { getConfig } from "./config.ts";
import { reconcilePostgresBillingPeriodForUser } from "./postgres-store.ts";

type PendingFinalization = {
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

const pending = new Map<string, PendingFinalization>();

function schedule(
  key: string,
  feishuUserId: string,
  period: string,
  delayMs: number,
  entry: PendingFinalization,
) {
  const timer = setTimeout(() => {
    void reconcilePostgresBillingPeriodForUser(feishuUserId, period)
      .then(() => entry.resolve())
      .catch((error) => entry.reject(error))
      .finally(() => {
        if (pending.get(key) === entry) pending.delete(key);
      });
  }, Math.max(0, delayMs));
  timer.unref?.();
  return timer;
}

export function finalizeBillingPeriodAfterSettlements(
  feishuUserId: string,
  period: string,
  delayMs = 750,
) {
  if (getConfig().storeBackend !== "postgres") return Promise.resolve();
  const key = `${feishuUserId}\n${period}`;
  const existing = pending.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    existing.timer = schedule(key, feishuUserId, period, delayMs, existing);
    return existing.promise;
  }

  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const entry = {
    timer: undefined as unknown as ReturnType<typeof setTimeout>,
    promise,
    resolve,
    reject,
  } satisfies PendingFinalization;
  entry.timer = schedule(key, feishuUserId, period, delayMs, entry);
  pending.set(key, entry);
  return promise;
}
