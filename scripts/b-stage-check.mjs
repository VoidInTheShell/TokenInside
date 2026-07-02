import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const originalEnvKeys = new Set(Object.keys(process.env));

function loadEnvFile(name, override = false) {
  const filePath = path.join(root, name);
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (originalEnvKeys.has(key)) continue;
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(".env");
loadEnvFile(".env.local", true);

function env(name) {
  return process.env[name] ?? "";
}

function has(name) {
  return env(name).length > 0;
}

function validSessionSecret() {
  const value = env("TOKENINSIDE_SESSION_SECRET");
  const normalized = value.toLowerCase();
  return (
    value.length >= 32 &&
    !normalized.includes("replace") &&
    !normalized.includes("example") &&
    !normalized.includes("placeholder")
  );
}

function status(label, ok, detail = "") {
  const mark = ok ? "ok" : "missing";
  console.log(`${mark.padEnd(7)} ${label}${detail ? ` - ${detail}` : ""}`);
}

function requireValues(names) {
  const missing = names.filter((name) => !has(name));
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(", ")}`);
  }
}

async function parseJsonResponse(res, system) {
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok || body.success === false || body.code) {
    throw new Error(
      `${system} request failed: ${body.message ?? body.msg ?? body.error ?? res.status}`,
    );
  }
  return body.data ?? body;
}

async function getFeishuTenantAccessToken() {
  requireValues(["FEISHU_APP_ID", "FEISHU_APP_SECRET"]);
  const res = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: env("FEISHU_APP_ID"),
        app_secret: env("FEISHU_APP_SECRET"),
      }),
    },
  );
  const data = await parseJsonResponse(res, "Feishu tenant token");
  if (!data.tenant_access_token) {
    throw new Error("Feishu tenant token response did not include tenant_access_token");
  }
  return data.tenant_access_token;
}

async function checkFeishu() {
  const tenantAccessToken = await getFeishuTenantAccessToken();
  status("Feishu tenant_access_token", Boolean(tenantAccessToken));
}

function maskId(value) {
  if (!value || typeof value !== "string") return "";
  if (value.length <= 10) return `${value.slice(0, 2)}...${value.slice(-2)}`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function fieldNames(value) {
  return Object.keys(value ?? {}).sort().join(", ");
}

async function feishuContactFetch(path, tenantAccessToken) {
  const res = await fetch(`https://open.feishu.cn${path}`, {
    method: "GET",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${tenantAccessToken}`,
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok || (typeof body.code === "number" && body.code !== 0)) {
    const message = body.message ?? body.msg ?? body.error ?? res.status;
    throw new Error(`${message}${body.code ? ` (code=${body.code})` : ""}`);
  }
  return body.data ?? body;
}

async function checkFeishuContactRead() {
  const tenantAccessToken = await getFeishuTenantAccessToken();
  status("Feishu tenant_access_token", Boolean(tenantAccessToken));

  let userPage;
  try {
    const params = new URLSearchParams({
      department_id: "0",
      department_id_type: "open_department_id",
      fetch_child: "true",
      page_size: "50",
      user_id_type: "open_id",
    });
    userPage = await feishuContactFetch(
      `/open-apis/contact/v3/users/find_by_department?${params.toString()}`,
      tenantAccessToken,
    );
  } catch (err) {
    status("Feishu contact users.find_by_department", false, err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const users = Array.isArray(userPage.items) ? userPage.items : [];
  status("Feishu contact user list", users.length > 0, `items=${users.length}`);
  if (users.length === 0) {
    process.exitCode = 1;
  }
  if (users[0]) {
    console.log(`info    Feishu contact user list fields - ${fieldNames(users[0])}`);
  }

  const listedLeaderUser = users.find((user) => user.leader_user_id);
  status(
    "Feishu contact leader_user_id in list",
    Boolean(listedLeaderUser?.leader_user_id),
    listedLeaderUser?.leader_user_id ? maskId(listedLeaderUser.leader_user_id) : "not returned in sampled users",
  );

  const sampleUser = users.find((user) => user.open_id || user.user_id);
  if (!sampleUser) {
    status("Feishu contact user detail", false, "no user id returned from list");
    process.exitCode = 1;
    return;
  }

  const userIdType = sampleUser.open_id ? "open_id" : "user_id";
  const userId = sampleUser.open_id ?? sampleUser.user_id;
  let detail;
  try {
    const params = new URLSearchParams({
      user_id_type: userIdType,
      department_id_type: "open_department_id",
    });
    const data = await feishuContactFetch(
      `/open-apis/contact/v3/users/${encodeURIComponent(userId)}?${params.toString()}`,
      tenantAccessToken,
    );
    detail = data.user ?? data;
  } catch (err) {
    status("Feishu contact user detail", false, err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  status("Feishu contact user detail", Boolean(detail?.open_id || detail?.user_id));
  console.log(`info    Feishu contact user detail fields - ${fieldNames(detail)}`);
  status(
    "Feishu contact leader_user_id in detail",
    Boolean(detail?.leader_user_id),
    detail?.leader_user_id ? maskId(detail.leader_user_id) : "not returned for sampled user",
  );
  if (!listedLeaderUser?.leader_user_id && !detail?.leader_user_id) {
    process.exitCode = 1;
  }
}

async function subscribeFeishuApprovalEvents() {
  requireValues(["FEISHU_APPROVAL_CODE_TOKEN_REQUEST"]);
  const tenantAccessToken = await getFeishuTenantAccessToken();
  const approvalCode = encodeURIComponent(env("FEISHU_APPROVAL_CODE_TOKEN_REQUEST"));
  const res = await fetch(
    `https://open.feishu.cn/open-apis/approval/v4/approvals/${approvalCode}/subscribe`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${tenantAccessToken}`,
      },
      body: JSON.stringify({}),
    },
  );
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  const message = body.message ?? body.msg ?? body.error ?? "";
  const alreadySubscribed =
    typeof message === "string" &&
    message.toLowerCase().includes("subscription existed");
  if ((!res.ok || body.code) && !alreadySubscribed) {
    throw new Error(
      `Feishu approval event subscribe request failed: ${message || res.status}`,
    );
  }
  status(
    "Feishu approval event subscribe",
    true,
    alreadySubscribed ? "already subscribed" : "subscribed",
  );
}

function newApiHeaders() {
  const credential =
    env("NEWAPI_ACCESS_TOKEN") || env("NEWAPI_ADMIN_ACCESS_TOKEN") || env("NEWAPI_SYSTEM_AK");
  if (!credential) {
    throw new Error("Missing required env: NEWAPI_ACCESS_TOKEN or NEWAPI_ADMIN_ACCESS_TOKEN or NEWAPI_SYSTEM_AK");
  }
  requireValues(["NEWAPI_BASE_URL", "NEWAPI_CONTROL_USER_ID"]);
  return {
    "content-type": "application/json; charset=utf-8",
    authorization: credential,
    "New-Api-User": env("NEWAPI_CONTROL_USER_ID"),
    "LLMAPI-User": env("NEWAPI_CONTROL_USER_ID"),
  };
}

async function newApiFetch(path, init = {}) {
  const baseUrl = env("NEWAPI_BASE_URL").replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...newApiHeaders(),
      ...(init.headers ?? {}),
    },
  });
  return parseJsonResponse(res, "NewAPI");
}

function tokenId(value) {
  if (typeof value === "number") return value;
  const asNumber = Number(value);
  return Number.isNaN(asNumber) ? value : asNumber;
}

async function checkNewApiRead() {
  const page = await newApiFetch("/api/token/?p=0&size=1");
  status("NewAPI /api/token read", Array.isArray(page.items), `items=${page.items?.length ?? 0}`);
}

async function checkNewApiMutation() {
  const name = `TI-bcheck-${Date.now().toString(36)}`;
  await newApiFetch("/api/token", {
    method: "POST",
    body: JSON.stringify({
      name,
      remain_quota: 1,
      unlimited_quota: false,
      expired_time: -1,
    }),
  });
  status("NewAPI token create", true, name);

  const params = new URLSearchParams({ keyword: name, p: "0", size: "20" });
  const page = await newApiFetch(`/api/token/search?${params.toString()}`);
  const token = page.items?.find((item) => item.name === name);
  if (!token?.id) {
    throw new Error("Created NewAPI token could not be found by exact name");
  }
  status("NewAPI token search", true, `id=${token.id}`);

  const keyBody = await newApiFetch(`/api/token/${token.id}/key`, { method: "POST" });
  status("NewAPI token full key", Boolean(keyBody.key), keyBody.key ? "available" : "empty");

  await newApiFetch("/api/token/?status_only=true", {
    method: "PUT",
    body: JSON.stringify({ id: tokenId(token.id), status: 2 }),
  });
  status("NewAPI token disable", true, `id=${token.id}`);
}

async function main() {
  if (args.has("--help")) {
    console.log("Usage: npm run b:check -- [--feishu] [--feishu-contact] [--newapi] [--mutate-newapi] [--subscribe-approval] [--all]");
    console.log("--newapi only reads token list; --mutate-newapi creates one test token and disables it.");
    console.log("--feishu-contact checks read access to contact users and leader_user_id without printing personal data.");
    console.log("--subscribe-approval binds FEISHU_APPROVAL_CODE_TOKEN_REQUEST to approval_instance events.");
    return;
  }

  console.log("TokenInside B-stage environment readiness");
  status(
    "TOKENINSIDE_SESSION_SECRET",
    validSessionSecret(),
    has("TOKENINSIDE_SESSION_SECRET")
      ? "must be a real 32+ character secret, not a placeholder"
      : "",
  );
  status("FEISHU_APP_ID", has("FEISHU_APP_ID"));
  status("FEISHU_APP_SECRET", has("FEISHU_APP_SECRET"));
  status("FEISHU_APPROVAL_CODE_TOKEN_REQUEST", has("FEISHU_APPROVAL_CODE_TOKEN_REQUEST"));
  status("FEISHU_APPROVAL_EVENT_VERIFICATION_TOKEN", has("FEISHU_APPROVAL_EVENT_VERIFICATION_TOKEN"));
  status(
    "FEISHU_APPROVAL_EVENT_ENCRYPT_KEY",
    true,
    has("FEISHU_APPROVAL_EVENT_ENCRYPT_KEY")
      ? "configured"
      : "optional unless Feishu event encryption is enabled",
  );
  status("NEWAPI_BASE_URL", has("NEWAPI_BASE_URL"), env("NEWAPI_BASE_URL") || "not set");
  status("NEWAPI_CONTROL_USER_ID", has("NEWAPI_CONTROL_USER_ID"));
  status(
    "NewAPI control credential",
    has("NEWAPI_ACCESS_TOKEN") || has("NEWAPI_ADMIN_ACCESS_TOKEN") || has("NEWAPI_SYSTEM_AK"),
  );

  if (args.has("--all") || args.has("--feishu")) {
    await checkFeishu();
  }
  if (args.has("--feishu-contact")) {
    await checkFeishuContactRead();
  }
  if (args.has("--all") || args.has("--newapi")) {
    await checkNewApiRead();
  }
  if (args.has("--mutate-newapi")) {
    await checkNewApiMutation();
  }
  if (args.has("--subscribe-approval")) {
    await subscribeFeishuApprovalEvents();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
