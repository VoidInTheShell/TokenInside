import { getConfig } from "@/lib/config";
import { decryptAes256CbcBase64, sha256Hex, safeEqual } from "@/lib/crypto";
import { selectInitialApprovalDepartmentId } from "@/lib/approval-routing";
import type { ApprovalRouteReason } from "@/lib/types";

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

export type FeishuContactUser = {
  open_id?: string;
  user_id?: string;
  union_id?: string;
  name?: string;
  avatar?: {
    avatar_origin?: string;
    avatar_640?: string;
    avatar_240?: string;
    avatar_72?: string;
  };
  department_ids?: string[];
  leader_user_id?: string;
};

type FeishuDepartment = {
  department_id?: string;
  open_department_id?: string;
  name?: string;
  i18n_name?: {
    zh_cn?: string;
    en_us?: string;
    ja_jp?: string;
  };
  parent_department_id?: string;
  leader_user_id?: string;
};

type ApprovalTarget = {
  departmentId?: string;
  leaderOpenId: string;
  source: "department_leader" | "parent_department_leader" | "system_admin_fallback";
  reason: ApprovalRouteReason;
  notice?: string;
  fallbackReason?: string;
};

export const SYSTEM_ADMIN_FALLBACK_NOTICE =
  "您当前不属于任何组织，请求将发送给系统管理员，请联系系统管理员审批";

function feishuErrorMessage(body: {
  msg?: string;
  message?: string;
  error?: string;
  error_description?: string;
}, fallback: string) {
  const message = body.error_description ?? body.message ?? body.msg ?? body.error ?? fallback;
  if (message.toLowerCase().includes("bot ability is not activated")) {
    return "飞书应用机器人能力未启用：请在飞书开放平台应用后台启用 Bot/机器人能力，并确认应用已发布后再提交申请。";
  }
  return message;
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

export async function getFeishuContactUserByOpenId(openId: string) {
  const tenantAccessToken = await getTenantAccessToken();
  const params = new URLSearchParams({
    user_id_type: "open_id",
    department_id_type: "open_department_id",
  });
  const data = await feishuFetch<{ user?: FeishuContactUser }>(
    `/open-apis/contact/v3/users/${encodeURIComponent(openId)}?${params.toString()}`,
    {
      method: "GET",
      tenantAccessToken,
    },
  );
  return data.user ?? (data as FeishuContactUser);
}

export async function getFeishuDepartmentById(departmentId: string) {
  const tenantAccessToken = await getTenantAccessToken();
  const params = new URLSearchParams({
    department_id_type: "open_department_id",
    user_id_type: "open_id",
  });
  const data = await feishuFetch<{ department?: FeishuDepartment }>(
    `/open-apis/contact/v3/departments/${encodeURIComponent(departmentId)}?${params.toString()}`,
    {
      method: "GET",
      tenantAccessToken,
    },
  );
  return data.department ?? (data as FeishuDepartment);
}

function feishuDepartmentDisplayName(department: FeishuDepartment) {
  return (
    department.name ??
    department.i18n_name?.zh_cn ??
    department.i18n_name?.en_us ??
    department.i18n_name?.ja_jp
  );
}

export async function getFeishuDepartmentNameById(departmentId?: string) {
  if (!departmentId || departmentId === "0") return undefined;
  const department = await getFeishuDepartmentById(departmentId);
  return feishuDepartmentDisplayName(department);
}

class ApprovalRoutingError extends Error {
  constructor(
    readonly reason: ApprovalRouteReason,
    message: string,
  ) {
    super(message);
  }
}

export async function listFeishuDepartmentUsers(
  departmentId: string,
  options: { fetchChild?: boolean } = {},
) {
  const tenantAccessToken = await getTenantAccessToken();
  const users: FeishuContactUser[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const params = new URLSearchParams({
      department_id: departmentId,
      department_id_type: "open_department_id",
      fetch_child: options.fetchChild ? "true" : "false",
      page_size: "50",
      user_id_type: "open_id",
    });
    if (pageToken) params.set("page_token", pageToken);
    const data = await feishuFetch<{
      items?: FeishuContactUser[];
      has_more?: boolean;
      page_token?: string;
    }>(`/open-apis/contact/v3/users/find_by_department?${params.toString()}`, {
      method: "GET",
      tenantAccessToken,
    });
    users.push(...(data.items ?? []));
    if (!data.has_more || !data.page_token) break;
    pageToken = data.page_token;
  }
  return users;
}

export function getPrimarySystemAdminOpenId() {
  const openId = getConfig().admin.systemAdminOpenIds[0];
  if (!openId) {
    throw new Error("TOKENINSIDE_SYSTEM_ADMIN_OPEN_IDS is required");
  }
  return openId;
}

function systemAdminFallbackNotice(
  reason: ApprovalRouteReason,
  requestKind: "first" | "regrant",
) {
  if (reason === "no_department") return SYSTEM_ADMIN_FALLBACK_NOTICE;
  if (reason === "applicant_is_department_admin") {
    return requestKind === "regrant"
      ? "您的套餐重发申请将发送给系统管理员审批。"
      : "您的套餐申请将发送给系统管理员审批。";
  }
  if (reason === "no_leader") {
    return "未找到可用的部门审批负责人，您的请求将发送给系统管理员审批。";
  }
  if (reason === "directory_lookup_failed") {
    return "组织信息暂时无法读取，您的请求将发送给系统管理员审批。";
  }
  return "您的请求将发送给系统管理员审批。";
}

function resolveSystemAdminFallback(
  error: unknown,
  knownDepartmentId: string | undefined,
  requestKind: "first" | "regrant",
): ApprovalTarget {
  const systemAdminOpenId = getConfig().admin.systemAdminOpenIds[0];
  const fallbackReason =
    error instanceof Error ? error.message : "Unable to resolve Feishu department leader";
  if (!systemAdminOpenId) {
    throw new Error(
      `${fallbackReason}; TOKENINSIDE_SYSTEM_ADMIN_OPEN_IDS is required for system administrator fallback`,
    );
  }

  const reason =
    error instanceof ApprovalRoutingError ? error.reason : "directory_lookup_failed";

  return {
    departmentId: selectInitialApprovalDepartmentId(knownDepartmentId),
    leaderOpenId: systemAdminOpenId,
    source: "system_admin_fallback",
    reason,
    notice: systemAdminFallbackNotice(reason, requestKind),
    fallbackReason,
  };
}

async function resolveDepartmentApprovalTargetForUser(
  openId: string,
  knownDepartmentId?: string,
): Promise<ApprovalTarget> {
  const visited = new Set<string>();
  let currentDepartmentId = selectInitialApprovalDepartmentId(knownDepartmentId);
  if (!currentDepartmentId) {
    const user = await getFeishuContactUserByOpenId(openId);
    currentDepartmentId = selectInitialApprovalDepartmentId(undefined, user.department_ids);
  }
  if (!currentDepartmentId) {
    throw new ApprovalRoutingError(
      "no_department",
      "Feishu contact user has no department_ids; cannot route approval card",
    );
  }
  let initialDepartmentId = currentDepartmentId;
  let applicantIsDepartmentLeader = false;

  while (currentDepartmentId && !visited.has(currentDepartmentId)) {
    visited.add(currentDepartmentId);
    const department = await getFeishuDepartmentById(currentDepartmentId);
    const departmentId =
      department.open_department_id ?? department.department_id ?? currentDepartmentId;
    if (!initialDepartmentId) initialDepartmentId = departmentId;

    if (department.leader_user_id && department.leader_user_id !== openId) {
      const source =
        departmentId === initialDepartmentId
          ? "department_leader"
          : "parent_department_leader";
      return {
        departmentId,
        leaderOpenId: department.leader_user_id,
        source,
        reason: source,
      };
    }
    if (department.leader_user_id === openId) {
      applicantIsDepartmentLeader = true;
      if (departmentId === initialDepartmentId) {
        throw new ApprovalRoutingError(
          "applicant_is_department_admin",
          "Current user is the leader of the applicant department",
        );
      }
    }

    currentDepartmentId = department.parent_department_id;
  }

  throw new ApprovalRoutingError(
    applicantIsDepartmentLeader ? "applicant_is_department_admin" : "no_leader",
    "No valid Feishu department leader found for current user",
  );
}

export async function resolveApprovalTargetForUser(
  openId: string,
  knownDepartmentId?: string,
  requestKind: "first" | "regrant" = "first",
): Promise<ApprovalTarget> {
  try {
    return await resolveDepartmentApprovalTargetForUser(openId, knownDepartmentId);
  } catch (err) {
    return resolveSystemAdminFallback(err, knownDepartmentId, requestKind);
  }
}

export async function sendPackageApprovalCard(input: {
  receiveOpenId: string;
  requestId: string;
  nonce: string;
  applicantName?: string;
  applicantOpenId: string;
  requestKind: "first" | "regrant";
  packageName: string;
  packageVersion: number;
  quotaLabel: string;
  cycleLabel: string;
  reason: string;
}) {
  const tenantAccessToken = await getTenantAccessToken();
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: input.requestKind === "first" ? "TokenInside 套餐申请" : "TokenInside 套餐重发申请",
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `**申请人**：${input.applicantName ?? input.applicantOpenId}`,
            `**套餐**：${input.packageName} v${input.packageVersion}`,
            `**套餐额度**：${input.quotaLabel}`,
            `**有效周期**：${input.cycleLabel}`,
            `**申请说明**：${input.reason || "未填写"}`,
          ].join("\n"),
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: { tag: "plain_text", content: "通过" },
            value: { requestId: input.requestId, action: "approve", nonce: input.nonce },
          },
          {
            tag: "button",
            type: "danger",
            text: { tag: "plain_text", content: "拒绝" },
            value: { requestId: input.requestId, action: "reject", nonce: input.nonce },
          },
        ],
      },
    ],
  };
  const params = new URLSearchParams({ receive_id_type: "open_id" });
  return feishuFetch<{ message_id?: string }>(
    `/open-apis/im/v1/messages?${params.toString()}`,
    {
      method: "POST",
      tenantAccessToken,
      body: JSON.stringify({
        receive_id: input.receiveOpenId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
    },
  );
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

export function hasFeishuEventVerificationToken() {
  return Boolean(getConfig().feishu.eventVerificationToken);
}
