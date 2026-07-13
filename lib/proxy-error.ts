export type ProxyErrorInput = {
  status: number;
  message: string;
  code: string;
  requestId: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
  type?: string;
  details?: Record<string, unknown>;
};

export function buildProxyErrorPayload(input: ProxyErrorInput) {
  const retryable = input.retryable === true;
  const retryAfterSeconds = retryable
    ? Math.max(1, Math.ceil(input.retryAfterSeconds ?? 2))
    : undefined;
  const error = {
    message: input.message,
    type: input.type ?? "tokeninside_error",
    code: input.code,
    retryable,
    retry_after_seconds: retryAfterSeconds,
    request_id: input.requestId,
    ...(input.details ? { details: input.details } : {}),
  };
  return {
    error,
    retryable,
    retry_after_seconds: retryAfterSeconds,
    request_id: input.requestId,
  };
}

export function buildProxyErrorResponse(input: ProxyErrorInput) {
  const payload = buildProxyErrorPayload(input);
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-TokenInside-Request-Id": input.requestId,
  });
  if (payload.retry_after_seconds !== undefined) {
    headers.set("Retry-After", String(payload.retry_after_seconds));
  }
  return new Response(
    JSON.stringify(payload),
    { status: input.status, headers },
  );
}

export function buildProxyStreamErrorChunk(input: ProxyErrorInput) {
  return new TextEncoder().encode(
    `event: error\ndata: ${JSON.stringify(buildProxyErrorPayload(input))}\n\n`,
  );
}

export function retryableUpstreamStatus(status: number) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export function upstreamRetryAfterSeconds(response: Response, fallback = 2) {
  const value = Number(response.headers.get("retry-after"));
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : fallback;
}
