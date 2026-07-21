import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const policyPath = new URL("../lib/workspace-access.ts", import.meta.url);
const sessionPath = new URL("../app/api/session/route.ts", import.meta.url);
const modelsPath = new URL("../app/api/models/route.ts", import.meta.url);
const operationsPath = new URL("../app/api/quota-operations/route.ts", import.meta.url);
const operationPath = new URL(
  "../app/api/quota-operations/[id]/route.ts",
  import.meta.url,
);
const usagePath = new URL("../app/api/usage-records/route.ts", import.meta.url);
const tokenKeyPath = new URL("../app/api/token/key/route.ts", import.meta.url);
const tokenResetPath = new URL("../app/api/token/reset/route.ts", import.meta.url);

test("用户后台准入只有 application_only、provisioning、active 三态", async () => {
  const source = await readFile(policyPath, "utf8");

  assert.match(
    source,
    /export type WorkspaceAccess = "application_only" \| "provisioning" \| "active"/,
  );
  assert.match(source, /input\.activeToken\?\.status === "active"/);
  assert.match(source, /request\.requestType === "first_apply"/);
  assert.match(source, /firstApplyProvisioningStatuses\.has\(request\.status\)/);
  assert.match(source, /return "provisioning"/);
  assert.match(source, /return "application_only"/);
});

test("active 热路径不读取申请历史，未发 Key 的成员返回 403 及明确访问态", async () => {
  const source = await readFile(policyPath, "utf8");
  const activeCheck = source.indexOf(
    'resolveWorkspaceAccess({ user, activeToken }) === "active"',
  );
  const requestHistory = source.indexOf("await listUserTokenRequests(user.id)");

  assert.ok(activeCheck >= 0);
  assert.ok(requestHistory > activeCheck);
  assert.match(source, /code: "active_workspace_access_required"/);
  assert.match(source, /workspaceAccess,/);
  assert.match(source, /\{ status: 403 \}/);
});

test("session 纯读返回访问态，业务 API 强制 active gate，额度任务按登录本人恢复", async () => {
  const [session, models, operations, operation, usage, tokenKey, tokenReset] = await Promise.all([
    readFile(sessionPath, "utf8"),
    readFile(modelsPath, "utf8"),
    readFile(operationsPath, "utf8"),
    readFile(operationPath, "utf8"),
    readFile(usagePath, "utf8"),
    readFile(tokenKeyPath, "utf8"),
    readFile(tokenResetPath, "utf8"),
  ]);

  assert.match(session, /workspaceAccess: resolveWorkspaceAccess\(/);
  assert.match(session, /workspaceAccess: "application_only" satisfies WorkspaceAccess/);
  assert.doesNotMatch(
    session,
    /createTokenRequest|createQuotaOperation|ensureAdminDefaultProvisioning|ensureQuotaOperationWorker/,
  );
  for (const route of [models, usage, tokenKey, tokenReset]) {
    assert.match(route, /await requireActiveWorkspaceAccess\(\)/);
    assert.match(route, /if \("error" in access\) return access\.error/);
  }
  for (const route of [operations, operation]) {
    assert.match(route, /await getCurrentUser\(\)/);
    assert.doesNotMatch(route, /requireActiveWorkspaceAccess/);
    assert.match(route, /feishu_oauth_session_required/);
  }
  assert.match(operation, /operation\.feishuUserId !== user\.id/);
  assert.match(operations, /feishuUserId: user\.id/);
});
