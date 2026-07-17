import { getConfig } from "@/lib/config";
import { randomId } from "@/lib/crypto";
import { getEffectiveNewApiConfig } from "@/lib/newapi-runtime";
import {
  extractUsageFromNewApiOther,
  mergeUsageMetrics,
  type UsageMetrics,
} from "@/lib/usage-metrics";

type NewApiEnvelope<T> = {
  success?: boolean;
  message?: string;
  error?: string;
  data?: T;
};

type NewApiTokenRecord = {
  id?: string | number;
  name?: string;
  key?: string;
  remain_quota?: number;
  unlimited_quota?: boolean;
  expired_time?: number;
  status?: number;
};

type NewApiTokenPage = {
  items?: NewApiTokenRecord[];
  total?: number;
};

type NewApiKeyResponse = {
  key?: string;
  token?: string;
};

type NewApiBatchKeyResponse = {
  keys?: Record<string, string>;
};

export type NewApiLogRecord = {
  id?: string | number;
  created_at?: string | number;
  token_id?: string | number;
  token_name?: string;
  request_id?: string;
  upstream_request_id?: string;
  model_name?: string;
  prompt_tokens?: string | number;
  completion_tokens?: string | number;
  quota?: string | number;
  is_stream?: boolean | string | number;
  type?: string | number;
  use_time?: string | number;
  channel_name?: string;
  user_id?: string | number;
  username?: string;
  other?: unknown;
};

type NewApiLogPage = {
  items?: NewApiLogRecord[];
  total?: number;
};

export type NewApiModel = {
  id: string;
  object?: string;
  owned_by?: string;
  permission?: unknown[];
};

export type NormalizedNewApiUsageLog = UsageMetrics & {
  newapiLogId?: string;
  newapiRequestId?: string;
  newapiUpstreamRequestId?: string;
  newapiTokenId?: string;
  tokenName?: string;
  createdAt?: string;
  model?: string;
  quota?: number;
  cost?: number;
  isStream?: boolean;
  type?: string;
  newapiUseTimeSeconds?: number;
  providerChannelName?: string;
  newapiUserId?: string;
  newapiUsername?: string;
};

export type NewApiUsageLogPage = {
  items: NormalizedNewApiUsageLog[];
  total: number;
  page: number;
  size: number;
};

type NewApiModelsResponse = {
  object?: string;
  data?: NewApiModel[];
};

type NewApiModelsEnvelope = NewApiModelsResponse | NewApiEnvelope<NewApiModel[]> | NewApiEnvelope<NewApiModelsResponse>;

function getControlCredential(newapi: Awaited<ReturnType<typeof getEffectiveNewApiConfig>>) {
  return [newapi.accessToken, newapi.adminAccessToken, newapi.systemAk].find(
    (credential) => typeof credential === "string" && credential.length > 0,
  );
}

export function toNewApiQuota(displayQuota: number) {
  return Math.round(displayQuota * getConfig().newapi.quotaPerUnit);
}

export function fromNewApiQuota(internalQuota: number) {
  return internalQuota / getConfig().newapi.quotaPerUnit;
}

function getNewApiHeaders(
  newapi: Awaited<ReturnType<typeof getEffectiveNewApiConfig>>,
  initHeaders?: HeadersInit,
) {
  const credential = getControlCredential(newapi);
  if (!credential) {
    throw new Error("NEWAPI_ACCESS_TOKEN, NEWAPI_ADMIN_ACCESS_TOKEN or NEWAPI_SYSTEM_AK is required");
  }
  if (!newapi.controlUserId) {
    throw new Error("NEWAPI_CONTROL_USER_ID is required for NewAPI /api/token control APIs");
  }

  const headers = new Headers(initHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("authorization", credential);
  headers.set("New-Api-User", newapi.controlUserId);
  headers.set("LLMAPI-User", newapi.controlUserId);
  return headers;
}

function parseNewApiBody<T>(text: string, status: number) {
  if (!text) return {} as NewApiEnvelope<T>;
  try {
    return JSON.parse(text) as NewApiEnvelope<T>;
  } catch {
    throw new Error(`NewAPI returned non-JSON response: ${status}`);
  }
}

async function newApiFetch<T>(path: string, init: RequestInit = {}) {
  const newapi = await getEffectiveNewApiConfig();
  const timeoutSignal = AbortSignal.timeout(newapi.requestTimeoutMs);
  const res = await fetch(`${newapi.baseUrl}${path}`, {
    ...init,
    headers: getNewApiHeaders(newapi, init.headers),
    cache: "no-store",
    signal: init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal,
  });

  const body = parseNewApiBody<T>(await res.text(), res.status);
  if (!res.ok || body.success === false) {
    throw new Error(body.message ?? body.error ?? `NewAPI request failed: ${res.status}`);
  }
  return (body.data ?? body) as T;
}

function numberFromNewApi(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringFromNewApi(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function booleanFromNewApi(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return undefined;
}

function isoFromNewApiTime(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1_000_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const millis = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
    return new Date(millis).toISOString();
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function getTokenId(record?: NewApiTokenRecord | null) {
  if (!record?.id) return undefined;
  return String(record.id);
}

async function getNewApiToken(newapiTokenId: string) {
  return newApiFetch<NewApiTokenRecord>(`/api/token/${newapiTokenId}`);
}

export async function searchNewApiTokens(keyword: string) {
  const params = new URLSearchParams({
    p: "0",
    size: "20",
    keyword,
  });
  const page = await newApiFetch<NewApiTokenPage>(`/api/token/search?${params.toString()}`);
  return page.items ?? [];
}

async function searchNewApiTokensPaged(keyword: string) {
  const items: NewApiTokenRecord[] = [];
  for (let pageNumber = 1; pageNumber <= 5; pageNumber += 1) {
    const params = new URLSearchParams({
      p: String(pageNumber),
      size: "20",
      keyword,
    });
    const page = await newApiFetch<NewApiTokenPage>(`/api/token/search?${params.toString()}`);
    items.push(...(page.items ?? []));
    if ((page.items ?? []).length === 0 || items.length >= (page.total ?? items.length)) break;
  }
  return items;
}

export async function findNewApiTokenByName(name: string) {
  const tokens = await searchNewApiTokens(name);
  return tokens.find((token) => token.name === name) ?? null;
}

export async function createNewApiToken(input: {
  name: string;
  remainQuota: number;
}) {
  const newapi = await getEffectiveNewApiConfig();
  if (newapi.mock) {
    const key = `sk-ti-${randomId("mock").replaceAll("_", "")}`;
    return {
      newapiTokenId: randomId("newapi"),
      key,
    };
  }

  await newApiFetch<unknown>("/api/token", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      remain_quota: input.remainQuota,
      unlimited_quota: false,
      expired_time: -1,
    }),
  });

  const created = await findNewApiTokenByName(input.name);
  const id = getTokenId(created);
  if (!id) {
    throw new Error("NewAPI token was created but could not be found by exact name");
  }

  const key = await getNewApiTokenKey(id);
  return {
    newapiTokenId: id,
    key,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  const failed = workers.find((item) => item.status === "rejected");
  if (failed) throw failed.reason;
  return results;
}

export async function deleteNewApiTokens(newapiTokenIds: string[]) {
  const newapi = await getEffectiveNewApiConfig();
  if (newapiTokenIds.length === 0 || newapi.mock) return;
  const ids = newapiTokenIds.map(Number);
  if (ids.some((id) => !Number.isInteger(id))) {
    throw new Error("NewAPI batch delete requires numeric token IDs");
  }
  await newApiFetch<unknown>("/api/token/batch", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

export async function createPrewarmedNewApiTokens(input: {
  count: number;
  batchLabel?: string;
}) {
  const count = Math.trunc(input.count);
  if (count < 1 || count > 100) {
    throw new Error("一次可预热的 NewAPI Key 数量必须在 1 到 100 之间");
  }
  const newapi = await getEffectiveNewApiConfig();
  const labelPrefix = (input.batchLabel ?? "department")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(-10);
  const batchLabel = `${labelPrefix}-${randomId("warm").replace(/[^a-zA-Z0-9]/g, "").slice(-8)}`;
  if (newapi.mock) {
    return Array.from({ length: count }, (_, index) => ({
      newapiTokenId: randomId("newapi"),
      key: `sk-ti-prewarm-${batchLabel}-${index}`,
    }));
  }

  const names = Array.from(
    { length: count },
    (_, index) => `TI warm ${batchLabel} ${String(index).padStart(3, "0")}`.slice(0, 50),
  );
  let tokenIds: string[] = [];
  try {
    await mapWithConcurrency(names, 2, async (name) => {
      await newApiFetch<unknown>("/api/token", {
        method: "POST",
        body: JSON.stringify({
          name,
          remain_quota: 0,
          unlimited_quota: false,
          expired_time: -1,
        }),
      });
    });

    const foundTokens = await searchNewApiTokensPaged(`TI warm ${batchLabel}%`);
    const byName = new Map(foundTokens.map((item) => [item.name, item]));
    const tokens = names.map((name) => {
      const token = byName.get(name);
      if (!token?.id) throw new Error(`预热 NewAPI Key 创建后未找到: ${name}`);
      return token;
    });
    tokenIds = tokens.map((token) => String(token.id));
    const numericIds = tokenIds.map(Number);
    if (numericIds.some((id) => !Number.isInteger(id))) {
      throw new Error("NewAPI 批量读取 Key 要求数字 Token ID");
    }
    const keyBody = await newApiFetch<NewApiBatchKeyResponse>("/api/token/batch/keys", {
      method: "POST",
      body: JSON.stringify({ ids: numericIds }),
    });
    const keys = keyBody.keys ?? {};
    const warmed = tokens.map((token) => {
      const tokenId = String(token.id);
      const key = keys[tokenId];
      if (!key) throw new Error(`NewAPI 批量接口未返回预热 Key: ${token.name}`);
      return { newapiTokenId: tokenId, key };
    });
    return warmed;
  } catch (error) {
    if (tokenIds.length === 0) {
      const foundTokens = await searchNewApiTokensPaged(`TI warm ${batchLabel}%`).catch(() => []);
      tokenIds = foundTokens
        .filter((item) => names.includes(item.name ?? ""))
        .map((item) => String(item.id))
        .filter(Boolean);
    }
    await deleteNewApiTokens(tokenIds).catch(() => undefined);
    throw error;
  }
}

export async function getNewApiTokenKey(newapiTokenId: string) {
  const newapi = await getEffectiveNewApiConfig();
  if (newapi.mock) return `sk-ti-${newapiTokenId}`;
  const data = await newApiFetch<NewApiKeyResponse>(`/api/token/${newapiTokenId}/key`, {
    method: "POST",
  });
  return data.key ?? data.token;
}

export async function getNewApiTokenRemainQuota(newapiTokenId: string) {
  const newapi = await getEffectiveNewApiConfig();
  if (newapi.mock) return toNewApiQuota(200);
  const record = await getNewApiToken(newapiTokenId);
  return typeof record.remain_quota === "number" ? record.remain_quota : undefined;
}

export async function getNewApiTokenControlState(newapiTokenId: string) {
  const newapi = await getEffectiveNewApiConfig();
  if (newapi.mock) return { status: 1, remainQuota: toNewApiQuota(200) };
  const record = await getNewApiToken(newapiTokenId);
  return {
    status: record.status,
    remainQuota:
      typeof record.remain_quota === "number" ? record.remain_quota : undefined,
  };
}

export async function listModelsForNewApiToken(newapiTokenId: string) {
  const newapi = await getEffectiveNewApiConfig();
  if (newapi.mock) {
    return [
      { id: "gpt-4o-mini", object: "model", owned_by: "newapi" },
      { id: "claude-3-5-sonnet", object: "model", owned_by: "newapi" },
      { id: "deepseek-chat", object: "model", owned_by: "newapi" },
    ] satisfies NewApiModel[];
  }

  const key = await getNewApiTokenKey(newapiTokenId);
  if (!key) {
    throw new Error("NewAPI token key is unavailable");
  }

  const res = await fetch(`${newapi.baseUrl}/v1/models`, {
    headers: {
      authorization: `Bearer ${key}`,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(newapi.requestTimeoutMs),
  });
  const text = await res.text();
  const body = parseNewApiBody<NewApiModelsEnvelope>(text, res.status);
  if (!res.ok) {
    throw new Error(body.message ?? body.error ?? `NewAPI models request failed: ${res.status}`);
  }

  if (Array.isArray(body.data)) return body.data;
  if (body.data && "data" in body.data && Array.isArray(body.data.data)) {
    return body.data.data;
  }
  if ("data" in body && Array.isArray(body.data)) return body.data;
  return [];
}

export function normalizeNewApiUsageLog(record: NewApiLogRecord): NormalizedNewApiUsageLog {
  const promptTokens = numberFromNewApi(record.prompt_tokens);
  const completionTokens = numberFromNewApi(record.completion_tokens);
  const quota = numberFromNewApi(record.quota);
  const usageMetrics = extractUsageFromNewApiOther({
    other: record.other,
    promptTokens,
    completionTokens,
  });
  mergeUsageMetrics(usageMetrics, {
    cost: quota === undefined ? undefined : fromNewApiQuota(quota),
    usageFieldSources:
      quota === undefined
        ? usageMetrics.usageFieldSources
        : { ...usageMetrics.usageFieldSources, cost: "newapi_log" },
  });

  return {
    newapiLogId: stringFromNewApi(record.id),
    newapiRequestId: stringFromNewApi(record.request_id),
    newapiUpstreamRequestId: stringFromNewApi(record.upstream_request_id),
    newapiTokenId: stringFromNewApi(record.token_id),
    tokenName: stringFromNewApi(record.token_name),
    createdAt: isoFromNewApiTime(record.created_at),
    model: stringFromNewApi(record.model_name),
    ...usageMetrics,
    quota,
    isStream: booleanFromNewApi(record.is_stream),
    type: stringFromNewApi(record.type),
    newapiUseTimeSeconds: numberFromNewApi(record.use_time),
    providerChannelName: stringFromNewApi(record.channel_name),
    newapiUserId: stringFromNewApi(record.user_id),
    newapiUsername: stringFromNewApi(record.username),
  };
}

export async function listNewApiUsageLogs(input: {
  page?: number;
  size?: number;
  requestId?: string;
  upstreamRequestId?: string;
  startTimestamp?: number;
  endTimestamp?: number;
  tokenName?: string;
  modelName?: string;
} = {}): Promise<NewApiUsageLogPage> {
  const newapi = await getEffectiveNewApiConfig();
  const page = Math.max(input.page ?? 0, 0);
  const size = Math.min(Math.max(input.size ?? 100, 1), 100);
  if (newapi.mock) {
    return {
      items: [],
      total: 0,
      page,
      size,
    };
  }

  const params = new URLSearchParams({
    p: String(page + 1),
    page_size: String(size),
    type: "2",
  });
  if (input.requestId) params.set("request_id", input.requestId);
  if (input.upstreamRequestId) params.set("upstream_request_id", input.upstreamRequestId);
  if (input.startTimestamp !== undefined) params.set("start_timestamp", String(input.startTimestamp));
  if (input.endTimestamp !== undefined) params.set("end_timestamp", String(input.endTimestamp));
  if (input.tokenName) params.set("token_name", input.tokenName);
  if (input.modelName) params.set("model_name", input.modelName);
  const data = await newApiFetch<NewApiLogPage>(`/api/log/self?${params.toString()}`);
  const items = (data.items ?? [])
    .map(normalizeNewApiUsageLog)
    .filter((item) => !input.requestId || item.newapiRequestId === input.requestId)
    .filter(
      (item) =>
        !input.upstreamRequestId || item.newapiUpstreamRequestId === input.upstreamRequestId,
    )
    .filter(
      (item) =>
        input.startTimestamp === undefined ||
        (item.createdAt !== undefined &&
          new Date(item.createdAt).getTime() >= input.startTimestamp * 1000),
    )
    .filter(
      (item) =>
        input.endTimestamp === undefined ||
        (item.createdAt !== undefined &&
          new Date(item.createdAt).getTime() <= input.endTimestamp * 1000),
    )
    .filter((item) => !input.tokenName || item.tokenName === input.tokenName)
    .filter((item) => !input.modelName || item.model === input.modelName);
  return {
    items,
    total: typeof data.total === "number" ? data.total : items.length,
    page,
    size,
  };
}

async function setNewApiTokenStatus(newapiTokenId: string, status: 1 | 2) {
  const newapi = await getEffectiveNewApiConfig();
  if (newapi.mock) return;
  await newApiFetch<unknown>("/api/token/?status_only=true", {
    method: "PUT",
    body: JSON.stringify({
      id: Number.isNaN(Number(newapiTokenId)) ? newapiTokenId : Number(newapiTokenId),
      status,
    }),
  });
}

export async function enableNewApiToken(newapiTokenId: string) {
  await setNewApiTokenStatus(newapiTokenId, 1);
}

export async function disableNewApiToken(newapiTokenId: string) {
  await setNewApiTokenStatus(newapiTokenId, 2);
}

export async function updateNewApiTokenQuota(input: {
  newapiTokenId: string;
  remainQuota: number;
}) {
  const newapi = await getEffectiveNewApiConfig();
  if (newapi.mock) return;
  const existing = await getNewApiToken(input.newapiTokenId);
  if (!existing.id) {
    throw new Error("NewAPI token was not found before quota update");
  }
  await newApiFetch<unknown>("/api/token", {
    method: "PUT",
    body: JSON.stringify({
      ...existing,
      remain_quota: input.remainQuota,
    }),
  });
}

export async function buildNewApiProxyUrl(pathParts: string[], search: string) {
  const newapi = await getEffectiveNewApiConfig();
  const safePath = pathParts.map(encodeURIComponent).join("/");
  return `${newapi.baseUrl}/v1/${safePath}${search}`;
}
