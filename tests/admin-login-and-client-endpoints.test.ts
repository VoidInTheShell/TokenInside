import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { adminFirstLoginNeedsProvisioning } from "../lib/admin-login-state.ts";
import { newApiClientBaseUrls } from "../lib/newapi-client-endpoints.ts";

const experienceClientPath = new URL("../components/experience-client.tsx", import.meta.url);
const loginWaitingScreenPath = new URL(
  "../components/login-waiting-screen.tsx",
  import.meta.url,
);

test("管理员首次登录只在 active Key 回读后退出登录遮罩", () => {
  assert.equal(
    adminFirstLoginNeedsProvisioning({
      authenticated: true,
      hasAdminScope: true,
      hasActiveToken: false,
      workspaceAccess: "provisioning",
    }),
    true,
  );
  assert.equal(
    adminFirstLoginNeedsProvisioning({
      authenticated: true,
      hasAdminScope: true,
      hasActiveToken: true,
      workspaceAccess: "active",
    }),
    false,
  );
  assert.equal(
    adminFirstLoginNeedsProvisioning({
      authenticated: true,
      hasAdminScope: true,
      hasActiveToken: false,
      workspaceAccess: "disabled",
    }),
    false,
  );
  assert.equal(
    adminFirstLoginNeedsProvisioning({
      authenticated: true,
      hasAdminScope: false,
      hasActiveToken: false,
      workspaceAccess: "application_only",
    }),
    false,
  );
});

test("OpenAI 与 Claude Code Base URL 使用各自正确的版本路径", () => {
  assert.deepEqual(newApiClientBaseUrls("https://new-api.example.com"), {
    openAiBaseUrl: "https://new-api.example.com/v1",
    claudeCodeBaseUrl: "https://new-api.example.com",
  });
  assert.deepEqual(newApiClientBaseUrls("https://new-api.example.com/v1/"), {
    openAiBaseUrl: "https://new-api.example.com/v1",
    claudeCodeBaseUrl: "https://new-api.example.com",
  });
  assert.deepEqual(newApiClientBaseUrls(""), {
    openAiBaseUrl: "",
    claudeCodeBaseUrl: "",
  });
});

test("用户首页持续轮询管理员首次发放并展示两类客户端地址", async () => {
  const [experience, waiting] = await Promise.all([
    readFile(experienceClientPath, "utf8"),
    readFile(loginWaitingScreenPath, "utf8"),
  ]);

  assert.match(experience, /const adminFirstLoginPending = adminFirstLoginNeedsProvisioning\(/);
  assert.match(experience, /const shouldAutoRefreshSession = Boolean\([\s\S]*adminFirstLoginPending/);
  assert.match(experience, /const loginInProgress =[\s\S]*adminFirstLoginPending/);
  assert.match(experience, /setAdminProvisioningError\(operationError\)/);
  assert.match(experience, /mode=\{adminFirstLoginPending \? "admin-provisioning" : "authentication"\}/);
  assert.match(experience, /OpenAI 兼容 Base URL/);
  assert.match(experience, /Claude Code Base URL/);
  assert.match(experience, /ANTHROPIC_BASE_URL 时不要追加 \/v1/);
  assert.match(waiting, /正在准备用户后台/);
  assert.match(waiting, /飞书身份已确认，正在首次发放专属 Key/);
  assert.match(waiting, /重试发放/);
});
