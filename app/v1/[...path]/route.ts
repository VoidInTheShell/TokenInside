import { after } from "next/server";
import { buildNewApiProxyUrl } from "@/lib/newapi";
import { getConfig } from "@/lib/config";
import { randomId, sha256Hex } from "@/lib/crypto";
import {
  acquireProxyConcurrencySlot,
  acquireProxyPreparationSlot,
  ProxyPreparationQueueTimeoutError,
} from "@/lib/proxy-concurrency";
import {
  buildProxyErrorResponse,
  buildProxyStreamErrorChunk,
  retryableUpstreamStatus,
  upstreamRetryAfterSeconds,
} from "@/lib/proxy-error";
import { fetchUpstreamWithRetry } from "@/lib/proxy-retry";
import { queueNewApiUsageSettlement } from "@/lib/usage-sync";
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
  beginProxyLog,
  findActiveTokenPrincipalByHash,
  updateProxyLog,
} from "@/lib/store";
import { findActiveTokenPrincipalCached } from "@/lib/proxy-principal-cache";
import { PackageBillingError } from "@/lib/package-errors";
import { beginRequestBillingContext } from "@/lib/package-repository";

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
  newapiTokenId?: string;
  model?: string;
  isStream: boolean;
  requestStartedAt: string;
};

function settleNewApiUsageAfterResponse(
  context: ProxyUsageSettlementContext,
  newapiRequestId?: string,
) {
  const newapiTokenId = context.newapiTokenId;
  if (!newapiTokenId) return;
  queueNewApiUsageSettlement({
    proxyLogId: context.proxyLogId,
    newapiTokenId,
    newapiRequestId,
    model: context.model,
    isStream: context.isStream,
    requestStartedAt: context.requestStartedAt,
  });
}

function startProxyLeaseHeartbeat(logId: string) {
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    const heartbeatAt = new Date();
    void updateProxyLog(logId, {
      heartbeatAt: heartbeatAt.toISOString(),
      leaseExpiresAt: new Date(heartbeatAt.getTime() + 2 * 60_000).toISOString(),
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
  newapiResponseRequestId?: string;
  apiFormat: string;
  requestId: string;
  settlementContext: ProxyUsageSettlementContext;
  releaseUpstreamSlot: () => void;
}) {
  const reader = input.body.getReader();
  const usageCollector = createSseUsageCollector({
    source: "proxy_stream",
    fallbackSemantic: usageSemanticFromApiFormat(input.apiFormat),
  });
  const stopHeartbeat = startProxyLeaseHeartbeat(input.logId);
  let finalized = false;
  const releaseOnce = () => {
    if (finalized) return false;
    finalized = true;
    stopHeartbeat();
    input.releaseUpstreamSlot();
    return true;
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            usageCollector.ingest(result.value);
            controller.enqueue(result.value);
          }
          if (!releaseOnce()) return;
          const usage = usageCollector.finish();
          await updateProxyLog(input.logId, {
            status: terminalStatus(input.statusCode),
            terminalStatus: terminalStatus(input.statusCode),
            durationMs: Date.now() - input.startedAt,
            responseTimeUpdatedAt: new Date().toISOString(),
            usageSource: hasUsageMetrics(usage) ? "proxy_stream" : "missing",
            ...newApiResponseRequestIdPatch(input.newapiResponseRequestId),
            ...usage,
            leaseExpiresAt: undefined,
          });
          if (input.statusCode < 400 && input.settlementContext.newapiTokenId) {
            queueNewApiUsageSettlement({
              proxyLogId: input.settlementContext.proxyLogId,
              newapiTokenId: input.settlementContext.newapiTokenId,
              newapiRequestId: input.newapiResponseRequestId,
              model: input.settlementContext.model,
              isStream: input.settlementContext.isStream,
              requestStartedAt: input.settlementContext.requestStartedAt,
            });
          }
          controller.close();
        } catch (err) {
          if (!releaseOnce()) return;
          await updateProxyLog(input.logId, {
            status: "failed",
            terminalStatus: "failed",
            statusCode: input.statusCode >= 400 ? input.statusCode : 502,
            durationMs: Date.now() - input.startedAt,
            errorMessage: sanitizedErrorMessage(err),
            responseTimeUpdatedAt: new Date().toISOString(),
            leaseExpiresAt: undefined,
          });
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
      })();
    },
    async cancel(reason) {
      if (!releaseOnce()) return;
      try {
        await reader.cancel(reason);
      } finally {
        await updateProxyLog(input.logId, {
          status: "cancelled",
          terminalStatus: "cancelled",
          statusCode: 499,
          durationMs: Date.now() - input.startedAt,
          errorMessage: "Client cancelled the request",
          responseTimeUpdatedAt: new Date().toISOString(),
          leaseExpiresAt: undefined,
        });
      }
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

async function recordFinishedProxyLog(input: {
  logId: string;
  startedAt: number;
  firstByteMs: number;
  preparationMs: number;
  billingContextMs: number;
  upstreamFirstByteMs: number;
  upstream: Response;
  requestPath: string;
  settlementContext: ProxyUsageSettlementContext;
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
  await updateProxyLog(input.logId, {
    status: terminalStatus(input.upstream.status),
    terminalStatus: terminalStatus(input.upstream.status),
    statusCode: input.upstream.status,
    durationMs: Date.now() - input.startedAt,
    firstByteMs: input.firstByteMs,
    preparationMs: input.preparationMs,
    billingContextMs: input.billingContextMs,
    upstreamFirstByteMs: input.upstreamFirstByteMs,
    responseTimeUpdatedAt: new Date().toISOString(),
    usageSource: hasUsageMetrics(usage) ? "proxy_json" : "missing",
    ...newApiResponseRequestIdPatch(newapiResponseRequestId),
    ...usage,
    errorMessage,
    leaseExpiresAt: undefined,
  });
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
  if (input.upstream.status < 400) {
    settleNewApiUsageAfterResponse(input.settlementContext, newapiResponseRequestId);
  }
}

async function recordFailedProxyLog(input: {
  logId: string;
  startedAt: number;
  err: unknown;
  aborted: boolean;
}) {
  await updateProxyLog(input.logId, {
    status: input.aborted ? "cancelled" : "failed",
    terminalStatus: input.aborted ? "cancelled" : "failed",
    statusCode: input.aborted ? 499 : 502,
    durationMs: Date.now() - input.startedAt,
    errorMessage: input.aborted ? "Client cancelled the request" : sanitizedErrorMessage(input.err),
    responseTimeUpdatedAt: new Date().toISOString(),
    leaseExpiresAt: undefined,
  });
}

function responseHeadersFrom(upstream: Response, requestId: string) {
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.delete("connection");
  responseHeaders.delete("keep-alive");
  responseHeaders.delete("proxy-authenticate");
  responseHeaders.delete("proxy-authorization");
  responseHeaders.delete("te");
  responseHeaders.delete("trailer");
  responseHeaders.delete("transfer-encoding");
  responseHeaders.delete("upgrade");
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

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
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

  let tokenAccount: NonNullable<Awaited<ReturnType<typeof findActiveTokenPrincipalByHash>>>["tokenAccount"];
  let user: NonNullable<Awaited<ReturnType<typeof findActiveTokenPrincipalByHash>>>["user"] & {};
  try {
    const keyHash = sha256Hex(key);
    const principal = await findActiveTokenPrincipalCached(
      keyHash,
      () => findActiveTokenPrincipalByHash(keyHash),
    );
    if (!principal?.tokenAccount) {
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
    tokenAccount = principal.tokenAccount;
    if (!principal.user) {
      releaseUpstreamSlot();
      releaseUpstreamSlot = undefined;
      return buildProxyErrorResponse({
        status: 403,
        message: "当前 Key 绑定的飞书用户已不存在",
        code: "bound_user_missing",
        requestId,
      });
    }
    user = principal.user;
    if (user.status === "disabled" || user.status === "deleted") {
      void addProxyLog({
        feishuUserId: user.id,
        tokenAccountId: tokenAccount.id,
        departmentId: user.departmentId,
        departmentName: user.departmentName,
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
    if (!user.departmentId) {
      throw new PackageBillingError(
        "user_department_required",
        "当前飞书用户没有可用于套餐计费的部门",
        409,
      );
    }
  } catch (error) {
    releaseUpstreamSlot?.();
    releaseUpstreamSlot = undefined;
    if (error instanceof PackageBillingError) {
      return buildProxyErrorResponse({
        status: error.status,
        message: error.message,
        code: error.code,
        requestId,
        retryable: error.retryable,
        retryAfterSeconds: error.retryable ? 2 : undefined,
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
  const preparationMs = Date.now() - startedAt;
  const proxyLogId = randomId("pl");
  const proxyLogCreatedAt = new Date().toISOString();
  const settlementContext: ProxyUsageSettlementContext = {
    proxyLogId,
    newapiTokenId: tokenAccount.newapiTokenId,
    model: metadata.model,
    isStream: metadata.clientRequestedStream,
    requestStartedAt: new Date(startedAt).toISOString(),
  };
  const stopRequestHeartbeat = startProxyLeaseHeartbeat(proxyLogId);

  const upstreamUrl = buildNewApiProxyUrl(path, requestUrl.search);
  let persistenceFailed = false;
  try {
    const retryConfig = getConfig().proxy;
    const internalUpstreamAbort = new AbortController();
    const upstreamSignal = AbortSignal.any([request.signal, internalUpstreamAbort.signal]);
    const billingContextStartedAt = Date.now();
    const billingContextPromise = (async () => {
      try {
        const proxyLog = await beginProxyLog({
          feishuUserId: user.id,
          tokenAccountId: tokenAccount.id,
          departmentId: user.departmentId,
          departmentName: user.departmentName,
          requestPath,
          method: request.method,
          model: metadata.model,
          provider: "NewAPI",
          providerKeyName: tokenAccount.newapiTokenId,
          apiFormat,
          endpointApiFormat: apiFormat,
          requestType: metadata.requestType,
          isStream: metadata.clientRequestedStream,
          clientRequestedStream: metadata.clientRequestedStream,
          clientIsStream: metadata.clientRequestedStream,
          userAgent: userAgent ?? undefined,
          clientIp,
          clientFamily: detectClientFamily(userAgent),
          billingPeriod: tokenAccount.billingPeriod,
          operationGeneration: tokenAccount.operationGeneration ?? 0,
          heartbeatAt: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 2 * 60_000).toISOString(),
        }, { id: proxyLogId, createdAt: proxyLogCreatedAt });
        await beginRequestBillingContext({
          proxyRequestId: proxyLog.id,
          userId: user.id,
          departmentId: user.departmentId!,
          tokenAccount,
          startedAt: proxyLog.createdAt,
        });
        return { proxyLog, billingContextMs: Date.now() - billingContextStartedAt };
      } catch (error) {
        persistenceFailed = true;
        throw error;
      }
    })();
    const upstreamStartedAt = Date.now();
    const upstreamPromise = fetchUpstreamWithRetry(
      () => fetch(upstreamUrl, {
        method: request.method,
        headers: filteredProxyHeaders(request, key, requestId),
        body: upstreamBody,
        cache: "no-store",
        signal: upstreamSignal,
      }),
      {
        maxAttempts: retryConfig.upstreamMaxAttempts,
        baseDelayMs: retryConfig.upstreamRetryBaseMs,
        maxDelayMs: retryConfig.upstreamRetryMaxDelayMs,
        signal: upstreamSignal,
      },
    ).then((result) => ({
      result,
      firstByteMs: Date.now() - upstreamStartedAt,
    }));
    let persisted: Awaited<typeof billingContextPromise>;
    let upstreamOutcome: Awaited<typeof upstreamPromise>;
    try {
      [persisted, upstreamOutcome] = await Promise.all([
        billingContextPromise,
        upstreamPromise,
      ]);
    } catch (error) {
      internalUpstreamAbort.abort();
      await Promise.allSettled([billingContextPromise, upstreamPromise]);
      throw error;
    }
    const { proxyLog, billingContextMs } = persisted;
    const upstreamResult = upstreamOutcome.result;
    const upstream = upstreamResult.response;
    const firstByteMs = Date.now() - startedAt;
    const upstreamFirstByteMs = upstreamOutcome.firstByteMs;
    const contentType = upstream.headers.get("content-type") ?? "";
    const upstreamIsStream = contentType.includes("text/event-stream");
    const newapiResponseRequestId = newApiResponseRequestIdFrom(upstream);
    const responseHeaders = responseHeadersFrom(upstream, requestId);
    responseHeaders.set("x-tokeninside-upstream-attempts", String(upstreamResult.attempts));
    responseHeaders.set("x-tokeninside-preparation-ms", String(preparationMs));
    responseHeaders.set("x-tokeninside-billing-context-ms", String(billingContextMs));
    responseHeaders.set("x-tokeninside-upstream-first-byte-ms", String(upstreamFirstByteMs));

    if (upstream.status >= 400) {
      const responseBody = await readResponseBody(upstream);
      await recordFinishedProxyLog({
        logId: proxyLog.id,
        startedAt,
        firstByteMs,
        preparationMs,
        billingContextMs,
        upstreamFirstByteMs,
        upstream,
        requestPath,
        settlementContext,
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

    if (upstreamIsStream && upstream.body) {
      responseHeaders.set("content-type", "text/event-stream; charset=utf-8");
      responseHeaders.set("cache-control", "no-cache, no-transform");
      responseHeaders.set("x-accel-buffering", "no");
      responseHeaders.delete("content-length");
      await updateProxyLog(proxyLog.id, {
        status: upstream.status >= 400 ? "failed" : "streaming",
        statusCode: upstream.status,
        durationMs: firstByteMs,
        firstByteMs,
        preparationMs,
        billingContextMs,
        upstreamFirstByteMs,
        isStream: true,
        upstreamIsStream: true,
        ...newApiResponseRequestIdPatch(newapiResponseRequestId),
        responseTimeUpdatedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 2 * 60_000).toISOString(),
      });
      stopRequestHeartbeat();
      return new Response(
        streamWithProxyLog({
          body: upstream.body,
          logId: proxyLog.id,
          startedAt,
          statusCode: upstream.status,
          newapiResponseRequestId,
          apiFormat,
          requestId,
          settlementContext,
          releaseUpstreamSlot,
        }),
        {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders,
        },
      );
    }

    const responseBody = await readResponseBody(upstream);
    await recordFinishedProxyLog({
      logId: proxyLog.id,
      startedAt,
      firstByteMs,
      preparationMs,
      billingContextMs,
      upstreamFirstByteMs,
      upstream,
      requestPath,
      settlementContext,
      apiFormat,
      responseBuffer: responseBody.buffer,
      responseJson: responseBody.json,
    });
    stopRequestHeartbeat();
    releaseUpstreamSlot();
    releaseUpstreamSlot = undefined;

    return new Response(responseBody.buffer, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    stopRequestHeartbeat();
    releaseUpstreamSlot?.();
    const aborted =
      request.signal.aborted ||
      (err instanceof DOMException && err.name === "AbortError");
    if (err instanceof PackageBillingError) {
      await updateProxyLog(proxyLogId, {
        status: "failed",
        terminalStatus: "failed",
        statusCode: err.status,
        durationMs: Date.now() - startedAt,
        errorMessage: sanitizedErrorMessage(err),
        responseTimeUpdatedAt: new Date().toISOString(),
        leaseExpiresAt: undefined,
      }).catch(() => undefined);
      return buildProxyErrorResponse({
        status: err.status,
        message: err.message,
        code: err.code,
        requestId,
        retryable: err.retryable,
        retryAfterSeconds: err.retryable ? 2 : undefined,
      });
    }
    if (persistenceFailed) {
      await updateProxyLog(proxyLogId, {
        status: "failed",
        terminalStatus: "failed",
        statusCode: 503,
        durationMs: Date.now() - startedAt,
        errorMessage: sanitizedErrorMessage(err),
        responseTimeUpdatedAt: new Date().toISOString(),
        leaseExpiresAt: undefined,
      }).catch(() => undefined);
      return buildProxyErrorResponse({
        status: 503,
        message: "TokenInside 数据库暂时繁忙，请在 2 秒后重试",
        code: "gateway_storage_unavailable",
        requestId,
        retryable: true,
        retryAfterSeconds: 2,
      });
    }
    await recordFailedProxyLog({
      logId: proxyLogId,
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
