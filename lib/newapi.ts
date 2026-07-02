import { getConfig } from "@/lib/config";
import { randomId } from "@/lib/crypto";

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

function getControlCredential() {
  const { newapi } = getConfig();
  return newapi.accessToken ?? newapi.adminAccessToken ?? newapi.systemAk;
}

function getNewApiHeaders(initHeaders?: HeadersInit) {
  const { newapi } = getConfig();
  const credential = getControlCredential();
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
  const { newapi } = getConfig();
  const res = await fetch(`${newapi.baseUrl}${path}`, {
    ...init,
    headers: getNewApiHeaders(init.headers),
    cache: "no-store",
  });

  const body = parseNewApiBody<T>(await res.text(), res.status);
  if (!res.ok || body.success === false) {
    throw new Error(body.message ?? body.error ?? `NewAPI request failed: ${res.status}`);
  }
  return (body.data ?? body) as T;
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

export async function findNewApiTokenByName(name: string) {
  const tokens = await searchNewApiTokens(name);
  return tokens.find((token) => token.name === name) ?? null;
}

export async function createNewApiToken(input: {
  name: string;
  remainQuota: number;
}) {
  const { newapi } = getConfig();
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

export async function getNewApiTokenKey(newapiTokenId: string) {
  const { newapi } = getConfig();
  if (newapi.mock) return `sk-ti-${newapiTokenId}`;
  const data = await newApiFetch<NewApiKeyResponse>(`/api/token/${newapiTokenId}/key`, {
    method: "POST",
  });
  return data.key ?? data.token;
}

export async function disableNewApiToken(newapiTokenId: string) {
  const { newapi } = getConfig();
  if (newapi.mock) return;
  await newApiFetch<unknown>("/api/token/?status_only=true", {
    method: "PUT",
    body: JSON.stringify({
      id: Number.isNaN(Number(newapiTokenId)) ? newapiTokenId : Number(newapiTokenId),
      status: 2,
    }),
  });
}

export async function updateNewApiTokenQuota(input: {
  newapiTokenId: string;
  remainQuota: number;
}) {
  const { newapi } = getConfig();
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

export function buildNewApiProxyUrl(pathParts: string[], search: string) {
  const { newapi } = getConfig();
  const safePath = pathParts.map(encodeURIComponent).join("/");
  return `${newapi.baseUrl}/v1/${safePath}${search}`;
}
