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

type ProxyPersistencePriority = "acceptance" | "terminal";

type PersistenceWaiter = {
  resolve: (release: () => void) => void;
};

const persistenceAcceptanceBurstMax = 4;

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

const persistenceGate = {
  active: 0,
  acceptanceQueue: [] as PersistenceWaiter[],
  terminalQueue: [] as PersistenceWaiter[],
  acceptanceBurst: 0,
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

function persistenceReleaseFactory() {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    persistenceGate.active = Math.max(persistenceGate.active - 1, 0);
    dispatchPersistence();
  };
}

function dispatchPersistence() {
  const maxConcurrency = getConfig().proxy.persistenceMaxConcurrency;
  while (persistenceGate.active < maxConcurrency) {
    const hasAcceptance = persistenceGate.acceptanceQueue.length > 0;
    const hasTerminal = persistenceGate.terminalQueue.length > 0;
    const admitTerminal = hasTerminal && (
      !hasAcceptance ||
      persistenceGate.acceptanceBurst >= persistenceAcceptanceBurstMax
    );
    const waiter = admitTerminal
      ? persistenceGate.terminalQueue.shift()
      : persistenceGate.acceptanceQueue.shift() ?? persistenceGate.terminalQueue.shift();
    if (!waiter) return;
    if (admitTerminal || !hasAcceptance) {
      persistenceGate.acceptanceBurst = 0;
    } else if (hasTerminal) {
      persistenceGate.acceptanceBurst += 1;
    } else {
      persistenceGate.acceptanceBurst = 0;
    }
    persistenceGate.active += 1;
    waiter.resolve(persistenceReleaseFactory());
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

/**
 * Bounds response-lifecycle writes that share the PostgreSQL business pool
 * with admission. Durable upstream-acceptance writes have priority over
 * terminal updates, while both remain FIFO within their own class. Priority is
 * bounded so continuous traffic cannot starve terminal billing persistence.
 */
export function acquireProxyPersistenceSlot(
  priority: ProxyPersistencePriority = "terminal",
) {
  const queue = priority === "acceptance"
    ? persistenceGate.acceptanceQueue
    : persistenceGate.terminalQueue;
  return new Promise<() => void>((resolve) => {
    queue.push({ resolve });
    dispatchPersistence();
  });
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
    persistence: {
      active: persistenceGate.active,
      queued:
        persistenceGate.acceptanceQueue.length +
        persistenceGate.terminalQueue.length,
      acceptanceQueued: persistenceGate.acceptanceQueue.length,
      terminalQueued: persistenceGate.terminalQueue.length,
      maxConcurrency: getConfig().proxy.persistenceMaxConcurrency,
    },
  };
}
