import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adminScopeRoutePath = new URL(
  "../app/api/admin/admins/[id]/route.ts",
  import.meta.url,
);
const adminScopesRoutePath = new URL("../app/api/admin/admins/route.ts", import.meta.url);
const quotaEditRoutePath = new URL(
  "../app/api/admin/token-requests/[id]/quota/route.ts",
  import.meta.url,
);
const tokenDecisionRoutePath = new URL(
  "../app/api/admin/token-requests/[id]/decision/route.ts",
  import.meta.url,
);
const quotaSubmitPath = new URL("../lib/quota-operation-submit.ts", import.meta.url);
const postgresStorePath = new URL("../lib/postgres-store.ts", import.meta.url);
const storePath = new URL("../lib/store.ts", import.meta.url);

test("管理员范围写入按 scopeId 精确执行并在锁内重验当前 actor", async () => {
  const [route, createRoute, postgres, store] = await Promise.all([
    readFile(adminScopeRoutePath, "utf8"),
    readFile(adminScopesRoutePath, "utf8"),
    readFile(postgresStorePath, "utf8"),
    readFile(storePath, "utf8"),
  ]);

  assert.match(route, /updateManualAdminScopeAsActor/);
  assert.doesNotMatch(route, /revokeAdminScopesForUser/);
  assert.match(postgres, /export async function updatePostgresManualAdminScopeAsActor/);
  assert.match(postgres, /lockAdminScopeUsersInTransaction\(client, \[/);
  assert.match(postgres, /resolvePostgresActorScopeInTransaction/);
  assert.match(postgres, /scope\.scopeType === "global" && !actorIsRoot/);
  assert.match(postgres, /select data from admin_scopes where id = \$1 for update/);
  assert.match(store, /export async function updateManualAdminScopeAsActor/);
  assert.match(store, /withAdminScopeUserLocks/);
  assert.match(store, /scope\.scopeType === "global" && !actorIsRoot/);
  assert.match(createRoute, /upsertManualAdminScopeAsActor/);
  assert.match(postgres, /export async function upsertPostgresManualAdminScopeAsActor/);
  assert.match(store, /export async function upsertManualAdminScopeAsActor/);
  assert.match(postgres, /targetHasActiveGlobalAdminScope/);
  assert.match(postgres, /系统管理员用户仅允许 root 管理员操作/);
  assert.match(store, /targetHasActiveGlobalAdminScope:[\s\S]*scope\.scopeType === "global"/);
});

test("审批额度编辑与审批受理共享用户锁和 request row CAS，不能分叉审计与账本", async () => {
  const [route, decisionRoute, submit, store] = await Promise.all([
    readFile(quotaEditRoutePath, "utf8"),
    readFile(tokenDecisionRoutePath, "utf8"),
    readFile(quotaSubmitPath, "utf8"),
    readFile(storePath, "utf8"),
  ]);

  assert.match(route, /updatePostgresTokenRequestQuotaAsActor/);
  assert.match(route, /updateJsonTokenRequestQuotaAsActor/);
  assert.doesNotMatch(route, /getScopedTokenRequest|updateTokenRequest\(/);
  assert.match(submit, /export async function updatePostgresTokenRequestQuotaAsActor/);
  assert.match(submit, /lockAdminScopeUsersForSubmission/);
  assert.match(submit, /`user-quota:\$\{initial\.request_data\.feishuUserId\}`/);
  assert.match(submit, /readRequestAndUser\(client, input\.requestId, true\)/);
  assert.match(submit, /tokenRequestAllowsQuotaEdit\(locked\.request_data\)/);
  assert.match(submit, /where idempotency_key = \$1 limit 1/);
  assert.match(store, /export async function updateJsonTokenRequestQuotaAsActor/);
  assert.match(store, /withUserQuotaOperationLock\(targetUserId/);
  assert.match(store, /tokenRequestAllowsQuotaEdit\(request\)/);
  assert.match(decisionRoute, /rejectPostgresTokenRequestAsActor/);
  assert.match(decisionRoute, /rejectJsonTokenRequestAsActor/);
  assert.match(submit, /export async function rejectPostgresTokenRequestAsActor/);
  assert.match(store, /export async function rejectJsonTokenRequestAsActor/);
  assert.match(submit, /tokenRequestRequiresAdminDecision\(locked\.request_data\)/);
  assert.match(submit, /for update of request, request_user/);
});
