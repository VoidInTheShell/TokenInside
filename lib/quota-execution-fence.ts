import { AsyncLocalStorage } from "node:async_hooks";

const quotaExecutionFenceRuntimeVersion = 1 as const;

export class QuotaExecutionFenceLostError extends Error {
  readonly code = "quota_execution_fence_lost";

  constructor(message = "额度操作执行栅栏已丢失") {
    super(message);
    this.name = "QuotaExecutionFenceLostError";
  }
}

export type QuotaExecutionFence = {
  readonly key: string;
  readonly lost: boolean;
  readonly closed: boolean;
  markLost(reason?: unknown): void;
  close(): void;
  assertHeld(): void;
};

type QuotaExecutionFenceRuntime = {
  version: typeof quotaExecutionFenceRuntimeVersion;
  storage: AsyncLocalStorage<QuotaExecutionFence>;
};

type QuotaExecutionFenceGlobal = typeof globalThis & {
  __tokenInsideQuotaExecutionFenceRuntimeV1?: QuotaExecutionFenceRuntime;
};

const quotaExecutionFenceGlobal = globalThis as QuotaExecutionFenceGlobal;
const runtime =
  (quotaExecutionFenceGlobal.__tokenInsideQuotaExecutionFenceRuntimeV1 ??= {
    version: quotaExecutionFenceRuntimeVersion,
    storage: new AsyncLocalStorage<QuotaExecutionFence>(),
  });

function fenceError(reason?: unknown) {
  if (reason instanceof QuotaExecutionFenceLostError) return reason;
  const detail = reason instanceof Error ? `: ${reason.message}` : "";
  return new QuotaExecutionFenceLostError(`额度操作执行栅栏已丢失${detail}`);
}

export function createQuotaExecutionFence(key: string): QuotaExecutionFence {
  let lostError: QuotaExecutionFenceLostError | undefined;
  let closed = false;
  return {
    key,
    get lost() {
      return Boolean(lostError);
    },
    get closed() {
      return closed;
    },
    markLost(reason?: unknown) {
      lostError ??= fenceError(reason);
    },
    close() {
      closed = true;
    },
    assertHeld() {
      if (lostError) throw lostError;
      if (closed) {
        throw new QuotaExecutionFenceLostError("额度操作执行栅栏作用域已结束");
      }
    },
  };
}

export function runWithQuotaExecutionFence<T>(
  fence: QuotaExecutionFence,
  fn: () => Promise<T>,
) {
  // AsyncLocalStorage is process-global and shared by emitted server chunks,
  // so all database and NewAPI descendants observe this exact guard object.
  return runtime.storage.run(fence, fn);
}

export function assertQuotaExecutionFenceHeld() {
  runtime.storage.getStore()?.assertHeld();
}

export function isQuotaExecutionFenceLostError(error: unknown) {
  return (
    error instanceof QuotaExecutionFenceLostError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "quota_execution_fence_lost")
  );
}
