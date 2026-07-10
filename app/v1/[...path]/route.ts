import { after, NextResponse } from "next/server";
import { buildNewApiProxyUrl } from "@/lib/newapi";
import { sha256Hex } from "@/lib/crypto";
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
  beginProxyLog,
  findActiveTokenByHash,
  getUserById,
  updateProxyLog,
} from "@/lib/store";

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

function filteredProxyHeaders(request: Request, key: string) {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("cookie");
  headers.set("authorization", `Bearer ${key}`);
  headers.set("x-tokeninside-proxy", "1");
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
  after(async () => {
    await syncNewApiUsageForProxyRequest({
      newapiRequestId,
      proxyLogId: context.proxyLogId,
      newapiTokenId: context.newapiTokenId,
      model: context.model,
      isStream: context.isStream,
      requestStartedAt: context.requestStartedAt,
    }).catch(() => undefined);
  });
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
}) {
  const reader = input.body.getReader();
  const usageCollector = createSseUsageCollector({
    source: "proxy_stream",
    fallbackSemantic: usageSemanticFromApiFormat(input.apiFormat),
  });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          const usage = usageCollector.finish();
          await updateProxyLog(input.logId, {
            status: terminalStatus(input.statusCode),
            durationMs: Date.now() - input.startedAt,
            responseTimeUpdatedAt: new Date().toISOString(),
            usageSource: hasUsageMetrics(usage) ? "proxy_stream" : "missing",
            ...newApiResponseRequestIdPatch(input.newapiResponseRequestId),
            ...usage,
          });
          controller.close();
          return;
        }
        usageCollector.ingest(result.value);
        controller.enqueue(result.value);
      } catch (err) {
        await updateProxyLog(input.logId, {
          status: "failed",
          statusCode: input.statusCode >= 400 ? input.statusCode : 502,
          durationMs: Date.now() - input.startedAt,
          errorMessage: sanitizedErrorMessage(err),
          responseTimeUpdatedAt: new Date().toISOString(),
        });
        controller.error(err);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await updateProxyLog(input.logId, {
          status: "cancelled",
          statusCode: 499,
          durationMs: Date.now() - input.startedAt,
          errorMessage: "Client cancelled the request",
          responseTimeUpdatedAt: new Date().toISOString(),
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
    statusCode: input.upstream.status,
    durationMs: Date.now() - input.startedAt,
    firstByteMs: input.firstByteMs,
    responseTimeUpdatedAt: new Date().toISOString(),
    usageSource: hasUsageMetrics(usage) ? "proxy_json" : "missing",
    ...newApiResponseRequestIdPatch(newapiResponseRequestId),
    ...usage,
    errorMessage,
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
    statusCode: input.aborted ? 499 : 502,
    durationMs: Date.now() - input.startedAt,
    errorMessage: input.aborted ? "Client cancelled the request" : sanitizedErrorMessage(input.err),
    responseTimeUpdatedAt: new Date().toISOString(),
  });
}

function responseHeadersFrom(upstream: Response) {
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  return responseHeaders;
}

async function proxy(request: Request, context: RouteContext) {
  const startedAt = Date.now();
  const params = await context.params;
  const rawPath = params.path ?? [];
  const path = normalizeProxyPath(rawPath);
  const key = extractBearerKey(request);
  const requestUrl = new URL(request.url);
  const rawRequestPath = `/v1/${rawPath.join("/")}${requestUrl.search}`;
  const requestPath = `/v1/${path.join("/")}${requestUrl.search}`;
  const unsupported = getSupportedProxyError(request.method, path);

  if (unsupported) {
    await addProxyLog({
      requestPath: rawRequestPath,
      method: request.method,
      statusCode: unsupported.status,
      durationMs: Date.now() - startedAt,
      userAgent: request.headers.get("user-agent") ?? undefined,
      clientIp: request.headers.get("x-forwarded-for") ?? undefined,
    });
    return NextResponse.json({ error: unsupported.error }, { status: unsupported.status });
  }

  if (!key) {
    return NextResponse.json({ error: "Bearer NewAPI key is required" }, { status: 401 });
  }

  const tokenAccount = await findActiveTokenByHash(sha256Hex(key));
  if (!tokenAccount) {
    await addProxyLog({
      requestPath,
      method: request.method,
      statusCode: 403,
      durationMs: Date.now() - startedAt,
      userAgent: request.headers.get("user-agent") ?? undefined,
      clientIp: request.headers.get("x-forwarded-for") ?? undefined,
    });
    return NextResponse.json({ error: "NewAPI key is not bound to an active Feishu user" }, { status: 403 });
  }

  const user = await getUserById(tokenAccount.feishuUserId);
  if (!user) {
    return NextResponse.json({ error: "Bound Feishu user no longer exists" }, { status: 403 });
  }
  if (user.status === "disabled" || user.status === "deleted") {
    await addProxyLog({
      feishuUserId: user.id,
      tokenAccountId: tokenAccount.id,
      departmentId: user.departmentId,
      departmentName: user.departmentName,
      requestPath,
      method: request.method,
      statusCode: 403,
      durationMs: Date.now() - startedAt,
      userAgent: request.headers.get("user-agent") ?? undefined,
      clientIp: request.headers.get("x-forwarded-for") ?? undefined,
    });
    return NextResponse.json({ error: "Bound Feishu user is not active" }, { status: 403 });
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
  });
  const settlementContext: ProxyUsageSettlementContext = {
    proxyLogId: proxyLog.id,
    newapiTokenId: tokenAccount.newapiTokenId,
    model: metadata.model,
    isStream: metadata.clientRequestedStream,
    requestStartedAt: new Date(startedAt).toISOString(),
  };

  const upstreamUrl = buildNewApiProxyUrl(path, requestUrl.search);
  try {
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: filteredProxyHeaders(request, key),
      body: upstreamBody,
      cache: "no-store",
      signal: request.signal,
    });
    const firstByteMs = Date.now() - startedAt;
    const contentType = upstream.headers.get("content-type") ?? "";
    const upstreamIsStream = contentType.includes("text/event-stream");
    const newapiResponseRequestId = newApiResponseRequestIdFrom(upstream);
    const responseHeaders = responseHeadersFrom(upstream);

    if (upstreamIsStream && upstream.body) {
      await updateProxyLog(proxyLog.id, {
        status: upstream.status >= 400 ? "failed" : "streaming",
        statusCode: upstream.status,
        durationMs: firstByteMs,
        firstByteMs,
        isStream: true,
        upstreamIsStream: true,
        ...newApiResponseRequestIdPatch(newapiResponseRequestId),
        responseTimeUpdatedAt: new Date().toISOString(),
      });
      if (upstream.status < 400) {
        settleNewApiUsageAfterResponse(settlementContext, newapiResponseRequestId);
      }
      return new Response(
        streamWithProxyLog({
          body: upstream.body,
          logId: proxyLog.id,
          startedAt,
          statusCode: upstream.status,
          newapiResponseRequestId,
          apiFormat,
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
      upstream,
      requestPath,
      settlementContext,
      apiFormat,
      responseBuffer: responseBody.buffer,
      responseJson: responseBody.json,
    });

    return new Response(responseBody.buffer, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    const aborted =
      request.signal.aborted ||
      (err instanceof DOMException && err.name === "AbortError");
    await recordFailedProxyLog({
      logId: proxyLog.id,
      startedAt,
      err,
      aborted,
    });
    return NextResponse.json(
      { error: aborted ? "Client cancelled the request" : "Upstream request failed" },
      { status: aborted ? 499 : 502 },
    );
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
