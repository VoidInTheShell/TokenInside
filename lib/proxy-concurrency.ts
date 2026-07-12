import { getConfig } from "./config.ts";

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer: ReturnType<typeof setTimeout>;
};

let active = 0;
const queue: Waiter[] = [];

export class ProxyQueueTimeoutError extends Error {
  constructor() {
    super("Gateway upstream concurrency queue timed out");
    this.name = "ProxyQueueTimeoutError";
  }
}

function abortError() {
  return new DOMException("The request was aborted", "AbortError");
}

function removeWaiter(waiter: Waiter) {
  const index = queue.indexOf(waiter);
  if (index >= 0) queue.splice(index, 1);
  clearTimeout(waiter.timer);
  if (waiter.signal && waiter.onAbort) {
    waiter.signal.removeEventListener("abort", waiter.onAbort);
  }
}

function releaseFactory() {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active = Math.max(active - 1, 0);
    dispatch();
  };
}

function dispatch() {
  const maxConcurrency = getConfig().proxy.maxConcurrency;
  while (active < maxConcurrency && queue.length > 0) {
    const waiter = queue.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    if (waiter.signal?.aborted) {
      waiter.reject(abortError());
      continue;
    }
    active += 1;
    waiter.resolve(releaseFactory());
  }
}

export async function acquireProxyConcurrencySlot(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
  const config = getConfig().proxy;
  if (active < config.maxConcurrency && queue.length === 0) {
    active += 1;
    return releaseFactory();
  }

  return new Promise<() => void>((resolve, reject) => {
    const waiter: Waiter = {
      resolve,
      reject,
      signal,
      timer: setTimeout(() => {
        removeWaiter(waiter);
        reject(new ProxyQueueTimeoutError());
      }, config.queueTimeoutMs),
    };
    waiter.timer.unref?.();
    if (signal) {
      waiter.onAbort = () => {
        removeWaiter(waiter);
        reject(abortError());
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    queue.push(waiter);
    dispatch();
  });
}

export function proxyConcurrencySnapshot() {
  return {
    active,
    queued: queue.length,
    maxConcurrency: getConfig().proxy.maxConcurrency,
  };
}
