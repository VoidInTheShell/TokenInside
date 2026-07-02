import { getConfig } from "@/lib/config";
import { decryptAes256CbcBase64, sha256Hex, safeEqual } from "@/lib/crypto";

const feishuBaseUrl = "https://open.feishu.cn";
const feishuAccountsBaseUrl = "https://accounts.feishu.cn";

type FeishuResponse<T> = {
  code?: number;
  msg?: string;
  message?: string;
  error?: string;
  error_description?: string;
  data?: T;
} & Record<string, unknown>;

type FeishuOAuthTokenResponse = {
  code?: number;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
  msg?: string;
  message?: string;
};

function feishuErrorMessage(body: {
  msg?: string;
  message?: string;
  error?: string;
  error_description?: string;
}, fallback: string) {
  return body.error_description ?? body.message ?? body.msg ?? body.error ?? fallback;
}

async function feishuFetch<T>(
  path: string,
  init: RequestInit & { tenantAccessToken?: string; userAccessToken?: string } = {},
) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  if (init.tenantAccessToken) {
    headers.set("authorization", `Bearer ${init.tenantAccessToken}`);
  }
  if (init.userAccessToken) {
    headers.set("authorization", `Bearer ${init.userAccessToken}`);
  }

  const res = await fetch(`${feishuBaseUrl}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });
  const body = (await res.json()) as FeishuResponse<T>;
  if (!res.ok || (typeof body.code === "number" && body.code !== 0)) {
    throw new Error(feishuErrorMessage(body, `Feishu API failed: ${res.status}`));
  }
  return (body.data ?? body) as T;
}

export async function getTenantAccessToken() {
  const { feishu } = getConfig();
  if (!feishu.appId || !feishu.appSecret) {
    throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are required");
  }
  const data = await feishuFetch<{ tenant_access_token: string }>(
    "/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      body: JSON.stringify({
        app_id: feishu.appId,
        app_secret: feishu.appSecret,
      }),
    },
  );
  return data.tenant_access_token;
}

export async function exchangeFeishuCode(code: string) {
  const { feishu } = getConfig();
  if (!feishu.appId || !feishu.appSecret) {
    throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are required");
  }

  const res = await fetch(`${feishuAccountsBaseUrl}/oauth/v3/token`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    cache: "no-store",
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: feishu.appId,
      client_secret: feishu.appSecret,
    }),
  });
  const body = (await res.json()) as FeishuOAuthTokenResponse;
  if (!res.ok || (typeof body.code === "number" && body.code !== 0)) {
    throw new Error(feishuErrorMessage(body, `Feishu OAuth token failed: ${res.status}`));
  }
  if (!body.access_token) {
    throw new Error("Feishu OAuth token response did not include access_token");
  }
  return {
    access_token: body.access_token,
    token_type: body.token_type ?? "Bearer",
    expires_in: body.expires_in ?? 0,
    refresh_token: body.refresh_token,
    scope: body.scope,
  };
}

export async function getFeishuUserInfo(userAccessToken: string) {
  return feishuFetch<{
    name?: string;
    avatar_url?: string;
    open_id: string;
    union_id?: string;
    user_id?: string;
    tenant_key: string;
  }>("/open-apis/authen/v1/user_info", {
    method: "GET",
    userAccessToken,
  });
}

export async function createApprovalInstance(input: {
  approvalCode: string;
  openId: string;
  departmentId?: string;
  uuid: string;
  reason: string;
  requestedMonthlyQuota: number;
}) {
  const tenantAccessToken = await getTenantAccessToken();
  const form = JSON.stringify([
    {
      id: "requested_monthly_quota",
      type: "number",
      value: String(input.requestedMonthlyQuota),
    },
    {
      id: "reason",
      type: "textarea",
      value: input.reason,
    },
  ]);

  return feishuFetch<{ instance_code: string }>("/open-apis/approval/v4/instances", {
    method: "POST",
    tenantAccessToken,
    body: JSON.stringify({
      approval_code: input.approvalCode,
      open_id: input.openId,
      department_id: input.departmentId,
      form,
      uuid: input.uuid,
    }),
  });
}

export function verifyFeishuEventSignature(input: {
  timestamp?: string | null;
  nonce?: string | null;
  signature?: string | null;
  rawBody: string;
}) {
  const { feishu } = getConfig();
  if (!feishu.eventEncryptKey) return true;
  if (!input.timestamp || !input.nonce || !input.signature) return false;
  const expected = sha256Hex(
    `${input.timestamp}${input.nonce}${feishu.eventEncryptKey}${input.rawBody}`,
  );
  return safeEqual(expected, input.signature);
}

export function decryptFeishuEventPayload(encrypt: string) {
  const { feishu } = getConfig();
  if (!feishu.eventEncryptKey) {
    throw new Error("FEISHU_APPROVAL_EVENT_ENCRYPT_KEY is required for encrypted Feishu events");
  }
  return decryptAes256CbcBase64({
    ciphertextBase64: encrypt,
    keyMaterial: feishu.eventEncryptKey,
  });
}

export function verifyFeishuEventVerificationToken(token?: string | null) {
  const expected = getConfig().feishu.eventVerificationToken;
  if (!expected) return true;
  if (!token) return false;
  return safeEqual(expected, token);
}
