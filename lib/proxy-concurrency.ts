import { getConfig } from "./config.ts";

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer: ReturnType<typeof setTimeout>;
};

type Gate = {
  active: number;
  queue: Waiter[];
  max: () => number;
  timeoutMs: () => number;
  timeoutError: () => Error;
};

export class ProxyQueueTimeoutError extends Error {
  constructor() {
    super("Gateway upstream concurrency queue timed out");
    this.name = "ProxyQueueTimeoutError";
  }
}

export class ProxyPreparationQueueTimeoutError extends Error {
  constructor() {
    super("Gateway database preparation queue timed out");
    this.name = "ProxyPreparationQueueTimeoutError";
  }
}

const upstreamGate: Gate = {
  active: 0,
  queue: [],
  max: () => getConfig().proxy.maxConcurrency,
  timeoutMs: () => getConfig().proxy.queueTimeoutMs,
  timeoutError: () => new ProxyQueueTimeoutError(),
};

const preparationGate: Gate = {
  active: 0,
  queue: [],
  max: () => getConfig().proxy.preparationMaxConcurrency,
  timeoutMs: () => getConfig().proxy.preparationQueueTimeoutMs,
  timeoutError: () => new ProxyPreparationQueueTimeoutError(),
};

function abortError() {
  return new DOMException("The request was aborted", "AbortError");
}

function removeWaiter(gate: Gate, waiter: Waiter) {
  const index = gate.queue.indexOf(waiter);
  if (index >= 0) gate.queue.splice(index, 1);
  clearTimeout(waiter.timer);
  if (waiter.signal && waiter.onAbort) {
    waiter.signal.removeEventListener("abort", waiter.onAbort);
  }
}

function releaseFactory(gate: Gate) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    gate.active = Math.max(gate.active - 1, 0);
    dispatch(gate);
  };
}

function dispatch(gate: Gate) {
  const maxConcurrency = gate.max();
  while (gate.active < maxConcurrency && gate.queue.length > 0) {
    const waiter = gate.queue.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    if (waiter.signal?.aborted) {
      waiter.reject(abortError());
      continue;
    }
    gate.active += 1;
    waiter.resolve(releaseFactory(gate));
  }
}

async function acquireGate(gate: Gate, signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
  if (gate.active < gate.max() && gate.queue.length === 0) {
    gate.active += 1;
    return releaseFactory(gate);
  }

  return new Promise<() => void>((resolve, reject) => {
    const waiter: Waiter = {
      resolve,
      reject,
      signal,
      timer: setTimeout(() => {
        removeWaiter(gate, waiter);
        reject(gate.timeoutError());
      }, gate.timeoutMs()),
    };
    waiter.timer.unref?.();
    if (signal) {
      waiter.onAbort = () => {
        removeWaiter(gate, waiter);
        reject(abortError());
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    gate.queue.push(waiter);
    dispatch(gate);
  });
}

export function acquireProxyConcurrencySlot(signal?: AbortSignal) {
  return acquireGate(upstreamGate, signal);
}

export function acquireProxyPreparationSlot(signal?: AbortSignal) {
  return acquireGate(preparationGate, signal);
}

export function proxyConcurrencySnapshot() {
  return {
    active: upstreamGate.active,
    queued: upstreamGate.queue.length,
    maxConcurrency: getConfig().proxy.maxConcurrency,
    preparation: {
      active: preparationGate.active,
      queued: preparationGate.queue.length,
      maxConcurrency: getConfig().proxy.preparationMaxConcurrency,
    },
  };
}
