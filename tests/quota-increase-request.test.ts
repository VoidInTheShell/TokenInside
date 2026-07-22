import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adminClientPath = new URL("../components/admin-client.tsx", import.meta.url);
const experienceClientPath = new URL("../components/experience-client.tsx", import.meta.url);
const stylesPath = new URL("../app/globals.css", import.meta.url);
const requestRoutePath = new URL(
  "../app/api/token/quota-request/route.ts",
  import.meta.url,
);
const decisionRoutePath = new URL(
  "../app/api/admin/token-requests/[id]/decision/route.ts",
  import.meta.url,
);
const feishuEventPath = new URL("../app/api/feishu/events/route.ts", import.meta.url);
const submitPath = new URL("../lib/quota-operation-submit.ts", import.meta.url);
const policyPath = new URL("../lib/token-request-policy.ts", import.meta.url);
const storePath = new URL("../lib/store.ts", import.meta.url);
const postgresStorePath = new URL("../lib/postgres-store.ts", import.meta.url);
const postgresQueriesPath = new URL(
  "../lib/postgres-control-queries.ts",
  import.meta.url,
);

function section(source: string, startMarker: string, endMarker?: string) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  if (!endMarker) return source.slice(start);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

function assertOrdered(source: string, markers: string[]) {
  let cursor = -1;
  for (const marker of markers) {
    const next = source.indexOf(marker, cursor + 1);
    assert.ok(next > cursor, `${marker} must follow the previous marker`);
    cursor = next;
  }
}

test("用户统计搜索保持可编辑并在短防抖后查询", async () => {
  const client = await readFile(adminClientPath, "utf8");
  const filters = section(client, "function DirectoryFilters(", "export function AdminClient()");
  const search = section(
    filters,
    'className="usage-filter usage-search-filter"',
    "</label>",
  );

  assert.match(client, /function useDebouncedValue<T>\([\s\S]*?window\.setTimeout\([\s\S]*?delayMs/);
  assert.match(client, /useDebouncedValue\(userStatsFilters\)/);
  assert.doesNotMatch(client, /useDeferredValue/);
  assert.match(search, /value=\{value\.search\}/);
  assert.match(search, /onChange=\{\(event\) => onChange\(\{ \.\.\.value, search: event\.target\.value \}\)\}/);
  assert.doesNotMatch(search, /disabled=\{loading\}/);
});

test("Key 更换 completed 使用绿色成功标记", async () => {
  const [experience, admin] = await Promise.all([
    readFile(experienceClientPath, "utf8"),
    readFile(adminClientPath, "utf8"),
  ]);
  const userBadge = section(experience, "function badgeVariant(", "function displayName(");
  const adminBadge = section(admin, "function badgeVariant(", "function adminScopeLabel(");

  assert.match(userBadge, /\["provisioned", "approved", "completed"\]/);
  assert.match(adminBadge, /"completed"/);
  assert.match(experience, /<Badge variant=\{badgeVariant\(quotaOperation\.state\)\}>/);
});

test("个人套餐额度申请复用审批链并按部门优先、全局管理员兜底", async () => {
  const [route, policy, store, postgresStore, postgresQueries] = await Promise.all([
    readFile(requestRoutePath, "utf8"),
    readFile(policyPath, "utf8"),
    readFile(storePath, "utf8"),
    readFile(postgresStorePath, "utf8"),
    readFile(postgresQueriesPath, "utf8"),
  ]);

  assert.match(route, /requestedMonthlyQuota:\s*z\.number\(\)\.int\(\)\.positive\(\)\.max\(1_000_000\)/);
  assert.match(route, /reason:\s*z\.string\(\)\.max\(500\)\.optional\(\)/);
  assertOrdered(route, [
    "getActiveTokenForUser(user.id)",
    "getEffectiveUserGrantQuota(user.id)",
    "parsed.data.requestedMonthlyQuota <= currentMonthlyQuota",
    'requestType: "quota_adjust"',
    "resolveApprovalTargetForUser(user.openId, user.departmentId)",
    'target.source === "system_admin_fallback"',
    "globalApprovalTargets(await listAdminScopes())",
    "Promise.allSettled(",
  ]);
  assert.match(route, /scope\.status === "active" && scope\.scopeType === "global"/);
  assert.match(route, /approvalTargetOpenIds:\s*uniqueTargets/);
  assert.match(route, /approvalCardMessageIds:\s*messageIds/);
  assert.match(policy, /"first_apply",\s*"quota_adjust"/);
  assert.match(policy, /class PendingQuotaAdjustmentRequestError/);
  assert.match(store, /openQuotaAdjustmentRequestStatuses\.has\(request\.status\)/);
  assert.match(postgresStore, /`quota-adjust-request:\$\{request\.feishuUserId\}`/);
  assert.match(postgresStore, /request_type = 'quota_adjust'[\s\S]*?status = any\(\$2::text\[\]\)/);
  assert.match(postgresQueries, /request\.request_type in \('first_apply', 'quota_adjust'\)/);
});

test("套餐额度审批在 PostgreSQL 原子更新原申请并创建真实调额任务", async () => {
  const [submit, decision, event] = await Promise.all([
    readFile(submitPath, "utf8"),
    readFile(decisionRoutePath, "utf8"),
    readFile(feishuEventPath, "utf8"),
  ]);
  const persist = section(
    submit,
    "async function persistQuotaAdjustmentDecisionSubmission(",
    "export async function submitPostgresQuotaAdjustmentDecision(",
  );
  const adminDecision = section(
    submit,
    "export async function submitPostgresQuotaAdjustmentDecision(",
    "export async function submitPostgresQuotaAdjustmentCardApproval(",
  );
  const cardDecision = section(
    submit,
    "export async function submitPostgresQuotaAdjustmentCardApproval(",
    "export async function submitPostgresAdminFirstProvisionAllocation(",
  );

  assertOrdered(persist, [
    "readOperationSubmissionState(client",
    "assertNoConflictingOperation(state",
    "where feishu_user_id = $1 and status = 'active'",
    "from user_quota_policies",
    "requestedAssignedQuota <= assignedQuotaBefore",
    'operationType: "quota_adjust"',
    "saveTokenRequestRow(client, updatedRequest)",
    "insertQuotaOperationRow(client, operation)",
  ]);
  assert.match(persist, /assignedQuotaBefore/);
  assert.match(persist, /upstreamTokenIdBefore:\s*activeAccount\.newapiTokenId/);
  assert.match(adminDecision, /readAdminActorScope\(client, input\.actorUserId\)/);
  assert.match(adminDecision, /assertRequestScope\(locked\.request_data, locked\.user_data, scope\)/);
  assert.match(cardDecision, /request\.approvalTargetOpenIds\?\.length/);
  assert.match(cardDecision, /approvalTargets\.has\(input\.operatorOpenId\)/);
  assert.match(decision, /submitPostgresQuotaAdjustmentDecision/);
  assert.match(decision, /isQuotaAdjustment \? "quota_adjust" : "first_provision"/);
  assert.match(event, /submitPostgresQuotaAdjustmentCardApproval/);
  assert.match(event, /tokenRequest\.approvalTargetOpenIds\?\.length/);
});

test("申请卡与用量概览桌面各半，移动端紧跟当前 Key", async () => {
  const [client, styles] = await Promise.all([
    readFile(experienceClientPath, "utf8"),
    readFile(stylesPath, "utf8"),
  ]);
  const account = section(client, '{panel === "account" && (', '{panel === "usage" && (');

  assertOrdered(account, [
    'className="account-current-key"',
    'className="account-endpoints"',
    'className="account-quota-request"',
    "<UsageOverviewCard",
  ]);
  assert.match(account, /<CardTitle>申请套餐额度<\/CardTitle>/);
  assert.match(account, /htmlFor="quotaRequestTarget"/);
  assert.match(account, /htmlFor="quotaRequestReason"/);
  assert.match(account, /申请理由（选填）/);
  assert.match(account, /提交申请/);
  assert.match(
    styles,
    /\.account-dashboard\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[\s\S]*?"request overview";/,
  );
  assert.match(
    styles,
    /@media \(max-width: 720px\)[\s\S]*?\.account-dashboard\s*\{[\s\S]*?"key"[\s\S]*?"request"[\s\S]*?"endpoints"[\s\S]*?"overview"/,
  );
});
