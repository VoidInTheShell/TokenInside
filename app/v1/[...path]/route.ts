import { NextResponse } from "next/server";
import { buildNewApiProxyUrl } from "@/lib/newapi";
import { sha256Hex } from "@/lib/crypto";
import { addProxyLog, findActiveTokenByHash, getUserById } from "@/lib/store";

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

function numberFromUsage(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function extractUsage(upstream: Response) {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return {};
  try {
    const body = (await upstream.clone().json()) as {
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
        input_tokens?: unknown;
        output_tokens?: unknown;
      };
    };
    const usage = body.usage;
    if (!usage) return {};
    const promptTokens = numberFromUsage(usage.prompt_tokens ?? usage.input_tokens);
    const completionTokens = numberFromUsage(
      usage.completion_tokens ?? usage.output_tokens,
    );
    const explicitTotalTokens = numberFromUsage(usage.total_tokens);
    return {
      promptTokens,
      completionTokens,
      totalTokens:
        explicitTotalTokens ??
        (promptTokens !== undefined && completionTokens !== undefined
          ? promptTokens + completionTokens
          : undefined),
    };
  } catch {
    return {};
  }
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
      requestPath,
      method: request.method,
      statusCode: 403,
      durationMs: Date.now() - startedAt,
      userAgent: request.headers.get("user-agent") ?? undefined,
      clientIp: request.headers.get("x-forwarded-for") ?? undefined,
    });
    return NextResponse.json({ error: "Bound Feishu user is not active" }, { status: 403 });
  }

  const upstreamUrl = buildNewApiProxyUrl(path, requestUrl.search);
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();

  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers: filteredProxyHeaders(request, key),
    body,
    cache: "no-store",
  });
  const usage = await extractUsage(upstream);

  await addProxyLog({
    feishuUserId: user.id,
    tokenAccountId: tokenAccount.id,
    departmentId: user.departmentId,
    requestPath,
    method: request.method,
    statusCode: upstream.status,
    durationMs: Date.now() - startedAt,
    ...usage,
    userAgent: request.headers.get("user-agent") ?? undefined,
    clientIp: request.headers.get("x-forwarded-for") ?? undefined,
  });

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
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
