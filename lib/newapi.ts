import { getConfig } from "@/lib/config";
import { randomId } from "@/lib/crypto";

type NewApiTokenResponse = {
  id?: string | number;
  token_id?: string | number;
  key?: string;
  token?: string;
};

function getControlCredential() {
  const { newapi } = getConfig();
  return newapi.accessToken ?? newapi.adminAccessToken ?? newapi.systemAk;
}

async function newApiFetch<T>(path: string, init: RequestInit = {}) {
  const { newapi } = getConfig();
  const credential = getControlCredential();
  if (!credential) {
    throw new Error("NEWAPI_ACCESS_TOKEN, NEWAPI_ADMIN_ACCESS_TOKEN or NEWAPI_SYSTEM_AK is required");
  }
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("authorization", `Bearer ${credential}`);

  const res = await fetch(`${newapi.baseUrl}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });

  const text = await res.text();
  const body = text ? (JSON.parse(text) as { data?: T; message?: string; error?: string }) : {};
  if (!res.ok) {
    throw new Error(body.message ?? body.error ?? `NewAPI request failed: ${res.status}`);
  }
  return (body.data ?? body) as T;
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

  const data = await newApiFetch<NewApiTokenResponse>("/api/token", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      remain_quota: input.remainQuota,
      unlimited_quota: false,
    }),
  });
  const id = data.id ?? data.token_id;
  const key = data.key ?? data.token;
  return {
    newapiTokenId: id ? String(id) : undefined,
    key,
  };
}

export async function getNewApiTokenKey(newapiTokenId: string) {
  const { newapi } = getConfig();
  if (newapi.mock) return `sk-ti-${newapiTokenId}`;
  const data = await newApiFetch<NewApiTokenResponse>(`/api/token/${newapiTokenId}/key`, {
    method: "GET",
  });
  return data.key ?? data.token;
}

export function buildNewApiProxyUrl(pathParts: string[], search: string) {
  const { newapi } = getConfig();
  const safePath = pathParts.map(encodeURIComponent).join("/");
  return `${newapi.baseUrl}/v1/${safePath}${search}`;
}
