import { after } from "next/server";
import { buildNewApiProxyUrl } from "@/lib/newapi";
import { getConfig } from "@/lib/config";
import { randomId, sha256Hex } from "@/lib/crypto";
import {
  acquireProxyConcurrencySlot,
  acquireProxyPersistenceSlot,
  acquireProxyPreparationSlot,
  ProxyPreparationQueueTimeoutError,
} from "@/lib/proxy-concurrency";
import {
  buildProxyErrorResponse,
  buildProxyStreamErrorChunk,
  retryableUpstreamStatus,
  upstreamRetryAfterSeconds,
} from "@/lib/proxy-error";
import {
  fetchUpstreamWithRetry,
  upstreamMaxAttemptsForMethod,
} from "@/lib/proxy-retry";
import { syncNewApiUsageForProxyRequest } from "@/lib/usage-sync";
import {
  createSseUsageCollector,
  extractUsageFromJson,
  hasUsageMetrics,
  objectValue,
  parseJsonText,
  usageSemanticFromApiFormat,
} from "@/lib/usage-metrics";
import {
  addProxyLog,
  beginQuotaAwareProxyRequest,
  updateProxyLog,
  updateProxyUsageSettlementRetryIfUnsettled,
} from "@/lib/store";
import {
  QuotaAdmissionClosedError,
  QuotaOperationBusyError,
  StaleTokenGenerationError,
} from "@/lib/quota-admission";
import type { FeishuUser, ProxyRequestLog, TokenAccount } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

function normalizeProxyPath(path: string[]) {
  return path[0] === "v1" ? path.slice(1) : path;
}

function extractBearerKey(request: Request) {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function filteredProxyHeaders(request: Request, key: string, requestId: string) {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("cookie");
  headers.set("authorization", `Bearer ${key}`);
  headers.set("x-tokeninside-proxy", "1");
  headers.set("x-tokeninside-request-id", requestId);
  return headers;
}

function getSupportedProxyError(method: string, path: string[]) {
  const joined = path.join("/");
  const allowed =
    (method === "GET" && joined === "models") ||
    (method === "POST" && joined === "chat/completions") ||
    (method === "POST" && joined === "responses") ||
    (method === "POST" && joined === "messages");

  if (allowed) return null;

  const knownPath = ["models", "chat/completions", "responses", "messages"].includes(joined);
  return {
    status: knownPath ? 405 : 404,
    error:
      "TokenInside MVP proxy only supports GET /v1/models, POST /v1/chat/completions, POST /v1/responses and POST /v1/messages",
  };
}

function parseJsonBody(buffer: ArrayBuffer | undefined, contentType: string | null) {
  if (!buffer || !contentType?.includes("application/json")) return undefined;
  return parseJsonText(new TextDecoder().decode(buffer));
}

function bodyWithStreamUsageOptions(input: {
  body: ArrayBuffer | undefined;
  requestBody: unknown;
  apiFormat: string;
  clientRequestedStream: boolean;
}) {
  if (!input.body || input.apiFormat !== "openai:chat" || !input.clientRequestedStream) {
    return input.body;
  }
  const root = objectValue(input.requestBody);
  if (!root) return input.body;
  const streamOptions = objectValue(root.stream_options);
  if (streamOptions?.include_usage === true) return input.body;
  return new TextEncoder().encode(
    JSON.stringify({
      ...root,
      stream_options: {
        ...streamOptions,
        include_usage: true,
      },
    }),
  );
}

function extractErrorMessage(body: unknown) {
  const root = objectValue(body);
  const error = objectValue(root?.error);
  const message = error?.message ?? root?.message ?? root?.error;
  return typeof message === "string" && message.trim() ? message.slice(0, 500) : undefined;
}

function detectApiFormat(path: string[]) {
  const joined = path.join("/");
  if (joined === "models") return "openai:models";
  if (joined === "chat/completions") return "openai:chat";
  if (joined === "responses") return "openai:responses";
  if (joined === "messages") return "claude:messages";
  return "unknown";
}

function detectClientFamily(userAgent?: string | null) {
  const value = userAgent?.toLowerCase() ?? "";
  if (!value) return undefined;
  if (value.includes("curl")) return "curl";
  if (value.includes("python")) return "python";
  if (value.includes("node")) return "node";
  if (value.includes("openai")) return "openai-sdk";
  if (value.includes("claude")) return "claude";
  if (value.includes("mozilla")) return "browser";
  return "other";
}

function requestMetadata(path: string[], requestBody: unknown) {
  const body = objectValue(requestBody);
  const model =
    typeof body?.model === "string" && body.model.trim()
      ? body.model
      : path.join("/") === "models"
        ? "models"
        : "unknown";
  const clientRequestedStream = body?.stream === true;
  return {
    model,
    clientRequestedStream,
    requestType: clientRequestedStream ? ("stream" as const) : ("standard" as const),
  };
}

function terminalStatus(statusCode: number) {
  if (statusCode === 499) return "cancelled" as const;
  if (statusCode >= 400) return "failed" as const;
  return "completed" as const;
}

function newApiResponseRequestIdFrom(upstream: Response) {
  return upstream.headers.get("x-oneapi-request-id") ?? undefined;
}

function newApiResponseRequestIdPatch(newapiResponseRequestId?: string) {
  return newapiResponseRequestId ? { newapiResponseRequestId } : {};
}

type ProxyUsageSettlementContext = {
  proxyLogId: string;
  feishuUserId: string;
  billingPeriod: string;
  newapiTokenId?: string;
  model?: string;
  isStream: boolean;
  requestStartedAt: string;
};

const proxyLogWriteRetryDelaysMs = [0, 25, 100, 250, 500, 1_000] as const;

async function updateProxyLogReliably(
  logId: string,
  patch: Partial<Omit<ProxyRequestLog, "id" | "createdAt">>,
) {
  let lastError: unknown;
  for (const delayMs of proxyLogWriteRetryDelaysMs) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      const updated = await updateProxyLog(logId, patch);
      if (!updated) throw new Error(`Proxy log ${logId} no longer exists`);
      return updated;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Proxy log update failed");
}

async function updateProxyUsageSettlementRetryReliably(
  logId: string,
  patch: Partial<Omit<ProxyRequestLog, "id" | "createdAt">>,
) {
  let lastError: unknown;
  for (const delayMs of proxyLogWriteRetryDelaysMs) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      // A concurrent authoritative match is an absorbing terminal state. A
      // null result means the late retry patch intentionally lost that CAS.
      return await updateProxyUsageSettlementRetryIfUnsettled(logId, patch);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Proxy usage settlement retry update failed");
}

async function withProxyPersistenceSlot<T>(
  priority: "acceptance" | "terminal",
  work: () => Promise<T>,
) {
  const release = await acquireProxyPersistenceSlot(priority);
  try {
    return await work();
  } finally {
    release();
  }
}

function releaseUpstreamSlotAfterTerminalPersistence(
  terminalPersistence: Promise<unknown>,
  releaseUpstreamSlot: () => void,
) {
  void terminalPersistence
    .then(releaseUpstreamSlot, releaseUpstreamSlot)
    .catch(() => undefined);
}

function createSettlementReadiness(logId: string) {
  let finished = false;
  let resolveReady!: () => void;
  const readiness = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const finish = (work: Promise<unknown>) => {
    if (finished) return;
    finished = true;
    void work
      .catch((error) => {
        console.error(JSON.stringify({
          event: "tokeninside.proxy.terminal_persistence_failed",
          proxyLogId: logId,
          errorMessage: sanitizedErrorMessage(error),
        }));
      })
      .finally(resolveReady);
  };
  return { readiness, finish };
}

function settleNewApiUsageAfterResponse(
  context: ProxyUsageSettlementContext,
  newapiRequestId?: string,
  readiness?: Promise<void>,
) {
  const settle = async () => {
    if (readiness) await readiness;
    try {
      const result = await syncNewApiUsageForProxyRequest({
        newapiRequestId,
        proxyLogId: context.proxyLogId,
        newapiTokenId: context.newapiTokenId,
        model: context.model,
        isStream: context.isStream,
        requestStartedAt: context.requestStartedAt,
      });
      if (result.found > 0) return result;
      if (result.reason === "deferred") return result;
      const nextRetryAt = new Date(Date.now() + 15_000).toISOString();
      await updateProxyUsageSettlementRetryReliably(context.proxyLogId, {
        usageSettlementStatus: "retrying",
        usageSettlementAttempts: result.attempts,
        usageSettlementImmediateAttempts: result.attempts,
        usageSettlementScanAttempts: 0,
        usageSettlementLastError: result.reason ?? "NewAPI usage source is not visible yet",
        usageSettlementNextRetryAt: nextRetryAt,
      });
      return result;
    } catch (error) {
      const message = sanitizedErrorMessage(error);
      await updateProxyUsageSettlementRetryReliably(context.proxyLogId, {
        usageSettlementStatus: "retrying",
        usageSettlementLastError: message,
        usageSettlementNextRetryAt: new Date(Date.now() + 15_000).toISOString(),
      }).catch(() => undefined);
      console.error(JSON.stringify({
        event: "tokeninside.proxy.usage_settlement_failed",
        proxyLogId: context.proxyLogId,
        newapiRequestId,
        errorMessage: message,
      }));
      return undefined;
    }
  };
  if (readiness) {
    after(settle());
  } else {
    after(settle);
  }
}

function startProxyLeaseHeartbeat(logId: string) {
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    const heartbeatAt = new Date();
    void withProxyPersistenceSlot("terminal", async () => {
      if (stopped) return;
      await updateProxyLog(logId, {
        heartbeatAt: heartbeatAt.toISOString(),
        leaseExpiresAt: new Date(heartbeatAt.getTime() + 2 * 60_000).toISOString(),
      });
    })
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  }, 15_000);
  timer.unref?.();
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

function redactSensitiveText(value: string) {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "sk-[redacted]")
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function sanitizedErrorMessage(err: unknown) {
  if (err instanceof Error && err.message.trim()) return redactSensitiveText(err.message);
  return "Upstream request failed";
}

function upstreamErrorMessage(input: {
  statusCode: number;
  responseJson: unknown;
  responseBuffer: ArrayBuffer;
}) {
  const fromJson = extractErrorMessage(input.responseJson);
  if (fromJson) return redactSensitiveText(fromJson);
  const fromBody = redactSensitiveText(new TextDecoder().decode(input.responseBuffer));
  return fromBody || `Upstream returned HTTP ${input.statusCode}`;
}

function streamWithProxyLog(input: {
  body: ReadableStream<Uint8Array>;
  logId: string;
  startedAt: number;
  statusCode: number;
  upstreamHeadersMs: number;
  upstreamResponseReceivedAt: string;
  newapiResponseRequestId?: string;
  apiFormat: string;
  requestId: string;
  signal: AbortSignal;
  releaseUpstreamSlot: () => void;
  upstreamPersistence: Promise<unknown>;
  finishSettlementReadiness: (work: Promise<unknown>) => void;
}) {
  const reader = input.body.getReader();
  const usageCollector = createSseUsageCollector({
    source: "proxy_stream",
    fallbackSemantic: usageSemanticFromApiFormat(input.apiFormat),
  });
  const stopHeartbeat = startProxyLeaseHeartbeat(input.logId);
  let firstByteMs: number | undefined;
  let terminalStarted = false;
  let clientCancelled = false;
  const persistTerminal = (
    patch: Partial<Omit<ProxyRequestLog, "id" | "createdAt">>,
  ) => {
    if (terminalStarted) return;
    terminalStarted = true;
    const work = input.upstreamPersistence
      .catch(() => undefined)
      .then(() => withProxyPersistenceSlot(
        "terminal",
        () => updateProxyLogReliably(input.logId, patch),
      ));
    input.finishSettlementReadiness(work);
    releaseUpstreamSlotAfterTerminalPersistence(work, input.releaseUpstreamSlot);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (clientCancelled) return;
        if (result.done) {
          stopHeartbeat();
          const usage = usageCollector.finish();
          persistTerminal({
            status: terminalStatus(input.statusCode),
            terminalStatus: terminalStatus(input.statusCode),
            clientDeliveryStatus: "completed",
            statusCode: input.statusCode,
            upstreamStatusCode: input.statusCode,
            upstreamResponseReceivedAt: input.upstreamResponseReceivedAt,
            upstreamHeadersMs: input.upstreamHeadersMs,
            durationMs: Date.now() - input.startedAt,
            firstByteMs: firstByteMs ?? input.upstreamHeadersMs,
            isStream: true,
            upstreamIsStream: true,
            responseTimeUpdatedAt: new Date().toISOString(),
            usageSource: hasUsageMetrics(usage) ? "proxy_stream" : "missing",
            ...newApiResponseRequestIdPatch(input.newapiResponseRequestId),
            ...usage,
            leaseExpiresAt: undefined,
          });
          controller.close();
          return;
        }
        firstByteMs ??= Date.now() - input.startedAt;
        usageCollector.ingest(result.value);
        controller.enqueue(result.value);
      } catch (err) {
        if (clientCancelled) return;
        const cancelled = input.signal.aborted || (
          err instanceof DOMException && err.name === "AbortError"
        );
        stopHeartbeat();
        persistTerminal({
          status: cancelled ? "cancelled" : "failed",
          terminalStatus: cancelled ? "cancelled" : "failed",
          clientDeliveryStatus: cancelled ? "cancelled" : "failed",
          statusCode: cancelled ? 499 : input.statusCode >= 400 ? input.statusCode : 502,
          upstreamStatusCode: input.statusCode,
          upstreamResponseReceivedAt: input.upstreamResponseReceivedAt,
          upstreamHeadersMs: input.upstreamHeadersMs,
          firstByteMs,
          ...newApiResponseRequestIdPatch(input.newapiResponseRequestId),
          durationMs: Date.now() - input.startedAt,
          errorMessage: cancelled ? "Client cancelled the request" : sanitizedErrorMessage(err),
          responseTimeUpdatedAt: new Date().toISOString(),
          leaseExpiresAt: undefined,
        });
        if (cancelled) {
          controller.error(err);
          return;
        }
        try {
          controller.enqueue(buildProxyStreamErrorChunk({
            status: 502,
            message: `流式上游连接中断（${sanitizedErrorMessage(err)}），请在 2 秒后重试`,
            code: "upstream_stream_interrupted",
            type: "upstream_error",
            requestId: input.requestId,
            retryable: true,
            retryAfterSeconds: 2,
          }));
          controller.close();
        } catch {
          controller.error(err);
        }
      }
    },
    async cancel(reason) {
      clientCancelled = true;
      stopHeartbeat();
      persistTerminal({
        status: "cancelled",
        terminalStatus: "cancelled",
        clientDeliveryStatus: "cancelled",
        statusCode: 499,
        upstreamStatusCode: input.statusCode,
        upstreamResponseReceivedAt: input.upstreamResponseReceivedAt,
        upstreamHeadersMs: input.upstreamHeadersMs,
        firstByteMs,
        ...newApiResponseRequestIdPatch(input.newapiResponseRequestId),
        durationMs: Date.now() - input.startedAt,
        errorMessage: "Client cancelled the request",
        responseTimeUpdatedAt: new Date().toISOString(),
        leaseExpiresAt: undefined,
      });
      await reader.cancel(reason);
    },
  });
}

async function readResponseBody(upstream: Response) {
  const buffer = await upstream.arrayBuffer();
  const contentType = upstream.headers.get("content-type");
  const json = parseJsonBody(buffer, contentType);
  return {
    buffer,
    contentType,
    json,
  };
}

async function readRecorderBody(
  body: ReadableStream<Uint8Array>,
  startedAt: number,
  fallbackFirstByteMs: number,
) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let firstByteMs: number | undefined;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    firstByteMs ??= Date.now() - startedAt;
    chunks.push(result.value);
    totalBytes += result.value.byteLength;
  }
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    buffer: combined.buffer,
    firstByteMs: firstByteMs ?? fallbackFirstByteMs,
  };
}

async function recordFinishedProxyLog(input: {
  logId: string;
  startedAt: number;
  firstByteMs: number;
  upstreamHeadersMs: number;
  upstreamResponseReceivedAt: string;
  upstream: Response;
  requestPath: string;
  apiFormat: string;
  responseBuffer: ArrayBuffer;
  responseJson: unknown;
}) {
  const usage = extractUsageFromJson(input.responseJson, {
    source: "proxy_json",
    fallbackSemantic: usageSemanticFromApiFormat(input.apiFormat),
  });
  const newapiResponseRequestId = newApiResponseRequestIdFrom(input.upstream);
  const errorMessage =
    input.upstream.status >= 400
      ? upstreamErrorMessage({
          statusCode: input.upstream.status,
          responseJson: input.responseJson,
          responseBuffer: input.responseBuffer,
        })
      : undefined;
  await withProxyPersistenceSlot("terminal", () => updateProxyLogReliably(input.logId, {
    status: terminalStatus(input.upstream.status),
    terminalStatus: terminalStatus(input.upstream.status),
    clientDeliveryStatus: input.upstream.status < 400 ? "completed" : "failed",
    statusCode: input.upstream.status,
    upstreamStatusCode: input.upstream.status,
    upstreamResponseReceivedAt: input.upstreamResponseReceivedAt,
    upstreamHeadersMs: input.upstreamHeadersMs,
    durationMs: Date.now() - input.startedAt,
    firstByteMs: input.firstByteMs,
    responseTimeUpdatedAt: new Date().toISOString(),
    usageSource: hasUsageMetrics(usage) ? "proxy_json" : "missing",
    ...newApiResponseRequestIdPatch(newapiResponseRequestId),
    ...usage,
    errorMessage,
    leaseExpiresAt: undefined,
  }));
  if (input.upstream.status >= 400) {
    console.warn(
      JSON.stringify({
        event: "tokeninside.proxy.upstream_error",
        proxyLogId: input.logId,
        requestPath: input.requestPath,
        statusCode: input.upstream.status,
        newapiResponseRequestId,
        errorMessage,
      }),
    );
  }
}

async function recordFailedProxyLog(input: {
  logId: string;
  startedAt: number;
  err: unknown;
  aborted: boolean;
}) {
  await withProxyPersistenceSlot("terminal", () => updateProxyLogReliably(input.logId, {
    status: input.aborted ? "cancelled" : "failed",
    terminalStatus: input.aborted ? "cancelled" : "failed",
    clientDeliveryStatus: input.aborted ? "cancelled" : "failed",
    statusCode: input.aborted ? 499 : 502,
    durationMs: Date.now() - input.startedAt,
    errorMessage: input.aborted ? "Client cancelled the request" : sanitizedErrorMessage(input.err),
    responseTimeUpdatedAt: new Date().toISOString(),
    leaseExpiresAt: undefined,
  }));
}

function responseHeadersFrom(upstream: Response, requestId: string) {
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.set("x-tokeninside-request-id", requestId);
  return responseHeaders;
}

async function proxy(request: Request, context: RouteContext) {
  const startedAt = Date.now();
  const requestId = randomId("req");
  const params = await context.params;
  const rawPath = params.path ?? [];
  const path = normalizeProxyPath(rawPath);
  const key = extractBearerKey(request);
  const requestUrl = new URL(request.url);
  const rawRequestPath = `/v1/${rawPath.join("/")}${requestUrl.search}`;
  const requestPath = `/v1/${path.join("/")}${requestUrl.search}`;
  const unsupported = getSupportedProxyError(request.method, path);

  if (unsupported) {
    after(async () => {
      await addProxyLog({
        requestPath: rawRequestPath,
        method: request.method,
        statusCode: unsupported.status,
        durationMs: Date.now() - startedAt,
        userAgent: request.headers.get("user-agent") ?? undefined,
        clientIp: request.headers.get("x-forwarded-for") ?? undefined,
      }).catch(() => undefined);
    });
    return buildProxyErrorResponse({
      status: unsupported.status,
      message: unsupported.error,
      code: unsupported.status === 405 ? "unsupported_method" : "unsupported_endpoint",
      requestId,
    });
  }

  if (!key) {
    return buildProxyErrorResponse({
      status: 401,
      message: "缺少 Bearer NewAPI Key，请在 Authorization header 中提供",
      code: "missing_bearer_key",
      requestId,
    });
  }

  let releaseUpstreamSlot: (() => void) | undefined;
  try {
    releaseUpstreamSlot = await acquireProxyConcurrencySlot(request.signal);
  } catch (error) {
    const aborted = request.signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError");
    return buildProxyErrorResponse({
      status: aborted ? 499 : 503,
      message: aborted
        ? "客户端已取消请求"
        : "TokenInside 当前长请求并发已满，请在 2 秒后重试",
      code: aborted ? "client_cancelled" : "gateway_upstream_capacity_exhausted",
      requestId,
      retryable: !aborted,
      retryAfterSeconds: 2,
    });
  }

  let body: ArrayBuffer | undefined;
  try {
    body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
  } catch (error) {
    releaseUpstreamSlot?.();
    releaseUpstreamSlot = undefined;
    const aborted = request.signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError");
    return buildProxyErrorResponse({
      status: aborted ? 499 : 400,
      message: aborted ? "客户端已取消请求" : "无法读取请求体",
      code: aborted ? "client_cancelled" : "invalid_request_body",
      requestId,
    });
  }
  const requestBody = parseJsonBody(body, request.headers.get("content-type"));
  const apiFormat = detectApiFormat(path);
  const metadata = requestMetadata(path, requestBody);
  const upstreamBody = bodyWithStreamUsageOptions({
    body,
    requestBody,
    apiFormat,
    clientRequestedStream: metadata.clientRequestedStream,
  });
  const userAgent = request.headers.get("user-agent");
  const clientIp = request.headers.get("x-forwarded-for") ?? undefined;
  let releasePreparationSlot: (() => void) | undefined;
  try {
    releasePreparationSlot = await acquireProxyPreparationSlot(request.signal);
  } catch (error) {
    releaseUpstreamSlot?.();
    releaseUpstreamSlot = undefined;
    const aborted = request.signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError");
    const queueTimedOut = error instanceof ProxyPreparationQueueTimeoutError;
    return buildProxyErrorResponse({
      status: aborted ? 499 : 503,
      message: aborted
        ? "客户端已取消请求"
        : queueTimedOut
          ? "TokenInside 数据库准备队列繁忙，请在 2 秒后重试"
          : "TokenInside 请求准备失败，请在 2 秒后重试",
      code: aborted ? "client_cancelled" : "gateway_preparation_queue_full",
      requestId,
      retryable: !aborted,
      retryAfterSeconds: 2,
    });
  }

  let tokenAccount: TokenAccount;
  let user: FeishuUser;
  let proxyLog: ProxyRequestLog;
  try {
    const admission = await beginQuotaAwareProxyRequest(sha256Hex(key), {
      requestPath,
      method: request.method,
      model: metadata.model,
      provider: "NewAPI",
      apiFormat,
      endpointApiFormat: apiFormat,
      requestType: metadata.requestType,
      isStream: metadata.clientRequestedStream,
      clientRequestedStream: metadata.clientRequestedStream,
      clientIsStream: metadata.clientRequestedStream,
      userAgent: userAgent ?? undefined,
      clientIp,
      clientFamily: detectClientFamily(userAgent),
      usageSettlementStatus: "pending",
      usageSettlementAttempts: 0,
      usageSettlementImmediateAttempts: 0,
      usageSettlementScanAttempts: 0,
    });
    if (admission.status === "inactive_token") {
      void addProxyLog({
        requestPath,
        method: request.method,
        statusCode: 403,
        durationMs: Date.now() - startedAt,
        userAgent: userAgent ?? undefined,
        clientIp,
      }).catch(() => undefined);
      releaseUpstreamSlot();
      releaseUpstreamSlot = undefined;
      return buildProxyErrorResponse({
        status: 403,
        message: "当前 NewAPI Key 未绑定到有效的飞书用户或已经失效",
        code: "inactive_key",
        requestId,
      });
    }
    if (admission.status === "bound_user_missing") {
      releaseUpstreamSlot();
      releaseUpstreamSlot = undefined;
      return buildProxyErrorResponse({
        status: 403,
        message: "当前 Key 绑定的飞书用户已不存在",
        code: "bound_user_missing",
        requestId,
      });
    }
    if (admission.status === "bound_user_inactive") {
      void addProxyLog({
        feishuUserId: admission.user.id,
        tokenAccountId: admission.account.id,
        departmentId: admission.user.departmentId,
        departmentName: admission.user.departmentName,
        requestPath,
        method: request.method,
        statusCode: 403,
        durationMs: Date.now() - startedAt,
        userAgent: userAgent ?? undefined,
        clientIp,
      }).catch(() => undefined);
      releaseUpstreamSlot();
      releaseUpstreamSlot = undefined;
      return buildProxyErrorResponse({
        status: 403,
        message: "当前 Key 绑定的飞书用户已被禁用",
        code: "bound_user_inactive",
        requestId,
      });
    }
    tokenAccount = admission.account;
    user = admission.user;
    proxyLog = admission.proxyLog;
  } catch (error) {
    releaseUpstreamSlot?.();
    releaseUpstreamSlot = undefined;
    if (error instanceof QuotaAdmissionClosedError || error instanceof QuotaOperationBusyError) {
      return buildProxyErrorResponse({
        status: 409,
        message: `${error.message}，请在 2 秒后重试`,
        code: error.code,
        requestId,
        retryable: true,
        retryAfterSeconds: 2,
        details:
          error instanceof QuotaAdmissionClosedError && error.operationId
            ? { operation_id: error.operationId }
            : undefined,
      });
    }
    if (error instanceof StaleTokenGenerationError) {
      return buildProxyErrorResponse({
        status: 403,
        message: error.message,
        code: error.code,
        requestId,
      });
    }
    console.error(JSON.stringify({
      event: "tokeninside.proxy.preparation_failed",
      requestId,
      errorMessage: sanitizedErrorMessage(error),
    }));
    return buildProxyErrorResponse({
      status: 503,
      message: "TokenInside 数据库暂时繁忙，请在 2 秒后重试",
      code: "gateway_storage_unavailable",
      requestId,
      retryable: true,
      retryAfterSeconds: 2,
    });
  } finally {
    releasePreparationSlot?.();
    releasePreparationSlot = undefined;
  }
  const settlementContext: ProxyUsageSettlementContext = {
    proxyLogId: proxyLog.id,
    feishuUserId: user.id,
    billingPeriod: tokenAccount.billingPeriod,
    newapiTokenId: tokenAccount.newapiTokenId,
    model: metadata.model,
    isStream: metadata.clientRequestedStream,
    requestStartedAt: new Date(startedAt).toISOString(),
  };
  const stopRequestHeartbeat = startProxyLeaseHeartbeat(proxyLog.id);

  const upstreamUrl = buildNewApiProxyUrl(path, requestUrl.search);
  try {
    const retryConfig = getConfig().proxy;
    const upstreamResult = await fetchUpstreamWithRetry(
      () => fetch(upstreamUrl, {
        method: request.method,
        headers: filteredProxyHeaders(request, key, requestId),
        body: upstreamBody,
        cache: "no-store",
        signal: request.signal,
      }),
      {
        maxAttempts: upstreamMaxAttemptsForMethod(
          request.method,
          retryConfig.upstreamMaxAttempts,
        ),
        baseDelayMs: retryConfig.upstreamRetryBaseMs,
        maxDelayMs: retryConfig.upstreamRetryMaxDelayMs,
        signal: request.signal,
      },
    );
    const upstream = upstreamResult.response;
    const upstreamHeadersMs = Date.now() - startedAt;
    const upstreamResponseReceivedAt = new Date().toISOString();
    const contentType = upstream.headers.get("content-type") ?? "";
    const upstreamIsStream = contentType.includes("text/event-stream");
    const newapiResponseRequestId = newApiResponseRequestIdFrom(upstream);
    const responseHeaders = responseHeadersFrom(upstream, requestId);
    responseHeaders.set("x-tokeninside-upstream-attempts", String(upstreamResult.attempts));

    if (upstream.status >= 400) {
      const responseBody = await readResponseBody(upstream);
      await recordFinishedProxyLog({
        logId: proxyLog.id,
        startedAt,
        firstByteMs: upstreamHeadersMs,
        upstreamHeadersMs,
        upstreamResponseReceivedAt,
        upstream,
        requestPath,
        apiFormat,
        responseBuffer: responseBody.buffer,
        responseJson: responseBody.json,
      });
      stopRequestHeartbeat();
      releaseUpstreamSlot();
      releaseUpstreamSlot = undefined;
      const retryable = retryableUpstreamStatus(upstream.status);
      const retryAfterSeconds = upstreamRetryAfterSeconds(upstream);
      return buildProxyErrorResponse({
        status: upstream.status,
        message: `${upstreamErrorMessage({
          statusCode: upstream.status,
          responseJson: responseBody.json,
          responseBuffer: responseBody.buffer,
        })}${retryable ? `，请在 ${retryAfterSeconds} 秒后重试` : ""}`,
        code: `upstream_http_${upstream.status}`,
        type: "upstream_error",
        requestId,
        retryable,
        retryAfterSeconds,
        details: {
          upstream_attempts: upstreamResult.attempts,
          ...(newapiResponseRequestId
            ? { newapi_request_id: newapiResponseRequestId }
            : {}),
        },
      });
    }

    const upstreamPersistence = withProxyPersistenceSlot(
      "acceptance",
      () => updateProxyLogReliably(proxyLog.id, {
      status: upstreamIsStream ? "streaming" : "pending",
      upstreamStatusCode: upstream.status,
      upstreamResponseReceivedAt,
      upstreamHeadersMs,
      responseTimeUpdatedAt: upstreamResponseReceivedAt,
      ...newApiResponseRequestIdPatch(newapiResponseRequestId),
      usageSettlementStatus: "pending",
      usageSettlementAttempts: 0,
      usageSettlementImmediateAttempts: 0,
      usageSettlementScanAttempts: 0,
      usageSettlementLastError: undefined,
      usageSettlementNextRetryAt: undefined,
      }),
    );
    // A streaming response can stay open far longer than the persistence
    // retry window. Observe this rejection immediately so Node never treats it
    // as unhandled before the terminal stream branch joins the promise.
    void upstreamPersistence.catch((error) => {
      console.error(JSON.stringify({
        event: "tokeninside.proxy.upstream_persistence_failed",
        proxyLogId: proxyLog.id,
        errorMessage: sanitizedErrorMessage(error),
      }));
    });

    if (upstreamIsStream && upstream.body) {
      const settlement = createSettlementReadiness(proxyLog.id);
      settleNewApiUsageAfterResponse(
        settlementContext,
        newapiResponseRequestId,
        settlement.readiness,
      );
      stopRequestHeartbeat();
      return new Response(
        streamWithProxyLog({
          body: upstream.body,
          logId: proxyLog.id,
          startedAt,
          statusCode: upstream.status,
          upstreamHeadersMs,
          upstreamResponseReceivedAt,
          newapiResponseRequestId,
          apiFormat,
          requestId,
          signal: request.signal,
          releaseUpstreamSlot,
          upstreamPersistence,
          finishSettlementReadiness: settlement.finish,
        }),
        {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders,
        },
      );
    }

    if (upstream.body) {
      const releaseAcceptedUpstreamSlot = releaseUpstreamSlot;
      const [clientBody, recorderBody] = upstream.body.tee();
      const settlement = createSettlementReadiness(proxyLog.id);
      settleNewApiUsageAfterResponse(
        settlementContext,
        newapiResponseRequestId,
        settlement.readiness,
      );
      const recordResponse = (async () => {
        let terminalPersistence: Promise<unknown>;
        try {
          const recorded = await readRecorderBody(
            recorderBody,
            startedAt,
            upstreamHeadersMs,
          );
          terminalPersistence = upstreamPersistence
            .catch(() => undefined)
            .then(() => recordFinishedProxyLog({
              logId: proxyLog.id,
              startedAt,
              firstByteMs: recorded.firstByteMs,
              upstreamHeadersMs,
              upstreamResponseReceivedAt,
              upstream,
              requestPath,
              apiFormat,
              responseBuffer: recorded.buffer,
              responseJson: parseJsonBody(recorded.buffer, contentType),
            }));
        } catch (err) {
          terminalPersistence = upstreamPersistence
            .catch(() => undefined)
            .then(() => withProxyPersistenceSlot(
              "terminal",
              () => updateProxyLogReliably(proxyLog.id, {
              status: request.signal.aborted ? "cancelled" : "failed",
              terminalStatus: request.signal.aborted ? "cancelled" : "failed",
              clientDeliveryStatus: request.signal.aborted ? "cancelled" : "failed",
              statusCode: request.signal.aborted ? 499 : 502,
              upstreamStatusCode: upstream.status,
              upstreamResponseReceivedAt,
              upstreamHeadersMs,
              ...newApiResponseRequestIdPatch(newapiResponseRequestId),
              durationMs: Date.now() - startedAt,
              errorMessage: request.signal.aborted
                ? "Client cancelled the request"
                : sanitizedErrorMessage(err),
              responseTimeUpdatedAt: new Date().toISOString(),
              leaseExpiresAt: undefined,
              }),
            ));
        } finally {
          stopRequestHeartbeat();
        }
        settlement.finish(terminalPersistence!);
        releaseUpstreamSlotAfterTerminalPersistence(
          terminalPersistence!,
          releaseAcceptedUpstreamSlot,
        );
        await terminalPersistence!;
      })();
      after(recordResponse.catch(() => undefined));
      const response = new Response(clientBody, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
      releaseUpstreamSlot = undefined;
      return response;
    }

    const releaseAcceptedUpstreamSlot = releaseUpstreamSlot;
    const settlement = createSettlementReadiness(proxyLog.id);
    settleNewApiUsageAfterResponse(
      settlementContext,
      newapiResponseRequestId,
      settlement.readiness,
    );
    const terminalPersistence = upstreamPersistence
      .catch(() => undefined)
      .then(() => recordFinishedProxyLog({
        logId: proxyLog.id,
        startedAt,
        firstByteMs: upstreamHeadersMs,
        upstreamHeadersMs,
        upstreamResponseReceivedAt,
        upstream,
        requestPath,
        apiFormat,
        responseBuffer: new ArrayBuffer(0),
        responseJson: null,
      }));
    settlement.finish(terminalPersistence);
    releaseUpstreamSlotAfterTerminalPersistence(
      terminalPersistence,
      releaseAcceptedUpstreamSlot,
    );
    after(terminalPersistence.catch(() => undefined));
    stopRequestHeartbeat();
    const response = new Response(null, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
    releaseUpstreamSlot = undefined;
    return response;
  } catch (err) {
    stopRequestHeartbeat();
    releaseUpstreamSlot?.();
    const aborted =
      request.signal.aborted ||
      (err instanceof DOMException && err.name === "AbortError");
    await recordFailedProxyLog({
      logId: proxyLog.id,
      startedAt,
      err,
      aborted,
    }).catch(() => undefined);
    const reason = sanitizedErrorMessage(err);
    const attempts = typeof (err as { attempts?: unknown })?.attempts === "number"
      ? (err as { attempts: number }).attempts
      : getConfig().proxy.upstreamMaxAttempts;
    return buildProxyErrorResponse({
      status: aborted ? 499 : 502,
      message: aborted
        ? "客户端已取消请求"
        : `NewAPI 上游请求失败（${reason}），请在 2 秒后重试`,
      code: aborted ? "client_cancelled" : "upstream_request_failed",
      type: aborted ? "tokeninside_error" : "upstream_error",
      requestId,
      retryable: !aborted,
      retryAfterSeconds: 2,
      details: aborted ? undefined : { upstream_attempts: attempts },
    });
  }
}

export function GET(request: Request, context: RouteContext) {
  return proxy(request, context);
}

export function POST(request: Request, context: RouteContext) {
  return proxy(request, context);
}

export function PUT(request: Request, context: RouteContext) {
  return proxy(request, context);
}

export function PATCH(request: Request, context: RouteContext) {
  return proxy(request, context);
}

export function DELETE(request: Request, context: RouteContext) {
  return proxy(request, context);
}
