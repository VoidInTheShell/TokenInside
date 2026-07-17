import { retryableUpstreamStatus, upstreamRetryAfterSeconds } from "./proxy-error.ts";

export type UpstreamRetryOptions = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  signal?: AbortSignal;
};

export function upstreamMaxAttemptsForMethod(method: string, configuredMaxAttempts: number) {
  const normalized = method.trim().toUpperCase();
  if (normalized !== "GET" && normalized !== "HEAD") return 1;
  return Math.max(1, Math.trunc(configuredMaxAttempts));
}

function abortError() {
  return new DOMException("The request was aborted", "AbortError");
}

function wait(delayMs: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function retryDelayMs(response: Response | undefined, attempt: number, options: UpstreamRetryOptions) {
  const headerDelay = response
    ? upstreamRetryAfterSeconds(response, 0) * 1000
    : 0;
  const exponential = options.baseDelayMs * 2 ** Math.max(attempt - 1, 0);
  return Math.min(Math.max(headerDelay, exponential), options.maxDelayMs);
}

export async function fetchUpstreamWithRetry(
  fetcher: (attempt: number) => Promise<Response>,
  options: UpstreamRetryOptions,
) {
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts));
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw abortError();
    try {
      const response = await fetcher(attempt);
      if (!retryableUpstreamStatus(response.status) || attempt === maxAttempts) {
        return { response, attempts: attempt };
      }
      await response.body?.cancel().catch(() => undefined);
      await wait(retryDelayMs(response, attempt, options), options.signal);
    } catch (error) {
      if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw error;
      }
      lastError = error;
      if (attempt === maxAttempts) {
        const exhausted = new Error(
          `NewAPI upstream failed after ${attempt} attempts: ${error instanceof Error ? error.message : "unknown error"}`,
          { cause: error },
        );
        Object.assign(exhausted, { attempts: attempt });
        throw exhausted;
      }
      await wait(retryDelayMs(undefined, attempt, options), options.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("NewAPI upstream retry exhausted");
}
