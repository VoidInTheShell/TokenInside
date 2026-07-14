import { getConfig } from "./config.ts";

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer: ReturnType<typeof setTimeout>;
  enqueuedAt: number;
};

type Gate = {
  active: number;
  queue: Waiter[];
  max: () => number;
  queueMax: () => number;
  timeoutMs: () => number;
  timeoutError: () => Error;
  enqueuedTotal: number;
  rejectedTotal: number;
  timedOutTotal: number;
  completedQueueWaitTotalMs: number;
  completedQueueWaitMaxMs: number;
  peakQueued: number;
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
  queueMax: () => getConfig().proxy.queueMax,
  timeoutMs: () => getConfig().proxy.queueTimeoutMs,
  timeoutError: () => new ProxyQueueTimeoutError(),
  enqueuedTotal: 0,
  rejectedTotal: 0,
  timedOutTotal: 0,
  completedQueueWaitTotalMs: 0,
  completedQueueWaitMaxMs: 0,
  peakQueued: 0,
};

const preparationGate: Gate = {
  active: 0,
  queue: [],
  max: () => getConfig().proxy.preparationMaxConcurrency,
  queueMax: () => getConfig().proxy.preparationQueueMax,
  timeoutMs: () => getConfig().proxy.preparationQueueTimeoutMs,
  timeoutError: () => new ProxyPreparationQueueTimeoutError(),
  enqueuedTotal: 0,
  rejectedTotal: 0,
  timedOutTotal: 0,
  completedQueueWaitTotalMs: 0,
  completedQueueWaitMaxMs: 0,
  peakQueued: 0,
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
    const queueWaitMs = Math.max(Date.now() - waiter.enqueuedAt, 0);
    gate.completedQueueWaitTotalMs += queueWaitMs;
    gate.completedQueueWaitMaxMs = Math.max(gate.completedQueueWaitMaxMs, queueWaitMs);
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

  if (gate.queue.length >= gate.queueMax()) {
    gate.rejectedTotal += 1;
    throw gate.timeoutError();
  }

  return new Promise<() => void>((resolve, reject) => {
    const enqueuedAt = Date.now();
    const waiter: Waiter = {
      resolve,
      reject,
      signal,
      timer: setTimeout(() => {
        removeWaiter(gate, waiter);
        gate.timedOutTotal += 1;
        reject(gate.timeoutError());
      }, gate.timeoutMs()),
      enqueuedAt,
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
    gate.enqueuedTotal += 1;
    gate.peakQueued = Math.max(gate.peakQueued, gate.queue.length);
    dispatch(gate);
  });
}

function gateSnapshot(gate: Gate) {
  return {
    active: gate.active,
    queued: gate.queue.length,
    maxConcurrency: gate.max(),
    maxQueued: gate.queueMax(),
    enqueuedTotal: gate.enqueuedTotal,
    rejectedTotal: gate.rejectedTotal,
    timedOutTotal: gate.timedOutTotal,
    completedQueueWaitTotalMs: gate.completedQueueWaitTotalMs,
    completedQueueWaitMaxMs: gate.completedQueueWaitMaxMs,
    peakQueued: gate.peakQueued,
  };
}

export function acquireProxyConcurrencySlot(signal?: AbortSignal) {
  return acquireGate(upstreamGate, signal);
}

export function acquireProxyPreparationSlot(signal?: AbortSignal) {
  return acquireGate(preparationGate, signal);
}

export function proxyConcurrencySnapshot() {
  return {
    ...gateSnapshot(upstreamGate),
    preparation: gateSnapshot(preparationGate),
  };
}
