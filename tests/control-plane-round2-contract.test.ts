import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adminClientPath = new URL("../components/admin-client.tsx", import.meta.url);
const experienceClientPath = new URL("../components/experience-client.tsx", import.meta.url);
const usageTablePath = new URL("../components/usage-records-table.tsx", import.meta.url);
const stylesPath = new URL("../app/globals.css", import.meta.url);
const packageRoutePath = new URL("../app/api/admin/packages/route.ts", import.meta.url);
const packageRequestRoutePath = new URL(
  "../app/api/admin/packages/requests/route.ts",
  import.meta.url,
);
const packageDecisionRoutePath = new URL(
  "../app/api/admin/packages/requests/[id]/decision/route.ts",
  import.meta.url,
);
const quotaAdjustRoutePath = new URL(
  "../app/api/admin/users/[id]/quota-adjust/route.ts",
  import.meta.url,
);
const cancelAdminRoutePath = new URL(
  "../app/api/admin/admins/[id]/route.ts",
  import.meta.url,
);
const tokenRequestRoutePath = new URL("../app/api/token/request/route.ts", import.meta.url);
const workspaceAccessPath = new URL("../lib/workspace-access.ts", import.meta.url);
const quotaSubmitPath = new URL("../lib/quota-operation-submit.ts", import.meta.url);
const quotaSagaPath = new URL("../lib/quota-saga.ts", import.meta.url);
const storePath = new URL("../lib/store.ts", import.meta.url);
const postgresStorePath = new URL("../lib/postgres-store.ts", import.meta.url);
const postgresQueriesPath = new URL(
  "../lib/postgres-control-queries.ts",
  import.meta.url,
);
const reportingPath = new URL("../lib/newapi-reporting.ts", import.meta.url);

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

test("用户目录筛选在桌面左侧紧凑排列，清除与搜索靠右，移动端每行两个控件", async () => {
  const [client, styles] = await Promise.all([
    readFile(adminClientPath, "utf8"),
    readFile(stylesPath, "utf8"),
  ]);
  const filters = section(client, "function DirectoryFilters(", "export function AdminClient()");

  assertOrdered(filters, [
    "<span>状态</span>",
    "<span>角色</span>",
    "<span>部门</span>",
    "<span>排序</span>",
    "<span>顺序</span>",
    'className="directory-filter-actions"',
    "清除筛选",
    'className="usage-filter usage-search-filter"',
    "<span>搜索</span>",
  ]);
  assert.match(
    styles,
    /\.directory-filters\s*\{[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*flex-end;[\s\S]*?flex-wrap:\s*nowrap;/,
  );
  assert.match(
    styles,
    /\.directory-filters\s*>\s*\.directory-filter-actions\s*\{[\s\S]*?margin-left:\s*auto;/,
  );
  assert.match(
    styles,
    /\.directory-filters\s*>\s*\.usage-search-filter\s*\{[\s\S]*?flex:\s*1\s+1\s+240px;[\s\S]*?min-width:\s*240px;[\s\S]*?max-width:\s*480px;/,
  );
  assert.match(
    styles,
    /\.directory-filters\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);\s*\}/,
  );
  assert.match(
    styles,
    /\.directory-filters\s*>\s*\.usage-search-filter\s*\{\s*grid-column:\s*1\s*\/\s*-1;\s*order:\s*-1;/,
  );
  const userStats = section(client, '{panel === "userStats" && (', '{panel === "usageRecords" && (');
  assert.match(userStats, /leading=\{[\s\S]*directory-filter-leading/);
  assert.match(userStats, /hideLabels/);
  assert.match(userStats, /compact-admin-card user-stats-card/);
  assertOrdered(userStats, ["<DirectoryFilters", "leading={", "刷新统计", "个用户"]);
  assert.match(styles, /\.user-stats-card \.directory-filters\s*\{[\s\S]*?margin:\s*0 0 2px;/);
  assert.match(
    styles,
    /\.directory-filters\s*>\s*\.directory-filter-leading\s*\{\s*grid-column:\s*1\s*\/\s*-1;/,
  );
});

test("部门额度双表、审批聚合和侧栏顺序保持紧凑结构", async () => {
  const [client, styles] = await Promise.all([
    readFile(adminClientPath, "utf8"),
    readFile(stylesPath, "utf8"),
  ]);
  const navigation = section(
    client,
    '<nav className="nav-list" aria-label="管理后台菜单">',
    "</nav>",
  );
  assertOrdered(navigation, [
    'selectPanel("users")',
    "用户管理",
    'selectPanel("approvals")',
    "审批处理",
    'selectPanel("packages")',
    "部门额度管理",
  ]);

  const packages = section(
    client,
    '{panel === "packages" && (',
    '{panel === "departmentStats" && isSystemAdmin && (',
  );
  assert.match(packages, /department-quota-summary-table/);
  assert.match(packages, /department-package-table/);
  assertOrdered(packages, [
    "<th>部门</th>",
    "<th>成员 / 已发</th>",
    "<th>当前总上限</th>",
    "<th>已发放</th>",
    "<th>可用</th>",
    "<th>预留</th>",
    "<CardTitle>部门套餐额度</CardTitle>",
    "<th>本周期套餐额度</th>",
    "<th>下一周期套餐额度</th>",
  ]);
  assert.doesNotMatch(packages, /department-quota-table|min-width:\s*1360px/);
  assert.doesNotMatch(packages, /<span>\{department\.departmentId\}<\/span>/);
  assert.doesNotMatch(packages, /申请提升总额度上限|总额度上限提升申请/);

  const approvals = section(
    client,
    '{panel === "approvals" && (',
    '{panel === "settings" && isSystemAdmin && (',
  );
  assert.match(approvals, /申请提升总额度上限/);
  assert.match(approvals, /总额度上限提升申请/);
  assert.match(approvals, /approvalOperatorLabel\(quotaRequest\)/);
  assert.match(client, /const \[res, packageRes\] = await Promise\.all/);
  assert.match(client, /api\/admin\/token-requests/);
  assert.match(client, /fetch\("\/api\/admin\/packages"/);
  assert.match(styles, /\.department-quota-summary-table,[\s\S]*?min-width:\s*0;/);
  assert.match(
    styles,
    /@media \(max-width:\s*720px\)[\s\S]*?\.department-quota-summary-table tr,[\s\S]*?grid-template-columns:\s*repeat\(2,/,
  );
});

test("用户启用禁用与取消管理员只刷新受影响区域", async () => {
  const client = await readFile(adminClientPath, "utf8");
  const cancel = section(client, "async function cancelAdmin(", "async function disableUser(");
  const disable = section(client, "async function disableUser(", "async function enableUser(");
  const enable = section(client, "async function enableUser(", "async function deleteUser(");

  assert.match(cancel, /Promise\.all\(\[loadAdminScopes\(\), loadAdminUsers\(\)\]\)/);
  assert.match(disable, /await loadAdminUsers\(\)/);
  assert.match(enable, /await loadAdminUsers\(\)/);
  for (const action of [cancel, disable, enable]) {
    assert.doesNotMatch(action, /\brefresh\(\)/);
    assert.doesNotMatch(action, /setLoading\(|location\.|router\./);
  }
});

test("部门统计区分已发放总额度与总额度上限并删除用量占比", async () => {
  const [client, reporting] = await Promise.all([
    readFile(adminClientPath, "utf8"),
    readFile(reportingPath, "utf8"),
  ]);
  const departmentStats = section(
    client,
    '{panel === "departmentStats" && isSystemAdmin && (',
    '{panel === "userStats" && (',
  );
  const listStats = section(
    reporting,
    "export async function listNewApiDepartmentStats(",
    "export async function getNewApiUserOverview(",
  );

  assert.match(listStats, /listDepartmentQuotaOverview\([\s\S]*current\.window\.period/);
  assert.match(listStats, /const issuedQuota = quota\?\.allocatedQuota \?\? fallbackIssuedQuota/);
  assert.match(listStats, /totalQuotaLimit:\s*quota\?\.quotaLimit/);
  assert.match(listStats, /if \(!log\.departmentId\) continue/);
  assert.match(listStats, /if \(!user\.departmentId\) continue/);
  assert.doesNotMatch(listStats, /\?\? "unknown"/);
  assert.doesNotMatch(listStats, /usageShare/);
  assertOrdered(departmentStats, ["已发放总额度", "总额度上限", "剩余额度"]);
  assert.match(departmentStats, /item\.issuedQuota/);
  assert.match(departmentStats, /item\.totalQuotaLimit/);
  assert.doesNotMatch(departmentStats, /用量占比|item\.usageShare/);
});

test("设置与用量分析删除冗余说明并使用统一保存文案", async () => {
  const client = await readFile(adminClientPath, "utf8");
  const usageRecords = section(
    client,
    '{panel === "usageRecords" && (',
    '{panel === "approvals" && (',
  );
  const usageAnalysisHeader = section(
    usageRecords,
    "<CardTitle>用量分析</CardTitle>",
    "{usageStatsExpanded && (",
  );
  const settings = section(client, '{panel === "settings" && isSystemAdmin && (');

  assert.doesNotMatch(usageAnalysisHeader, /CardDescription/);
  assert.match(settings, /<SaveIcon data-icon="inline-start"\s*\/>\s*保存\s*<\/Button>/);
  assert.doesNotMatch(settings, /保存上游连接/);
  assert.doesNotMatch(settings, /<h3>默认申请额度<\/h3>/);
  assert.doesNotMatch(settings, /新申请、首次授权和后续额度调整/);
  assert.doesNotMatch(settings, /当前值：/);
  assert.match(settings, /<label htmlFor="defaultMonthlyQuota">默认申请额度<\/label>/);
});

test("使用记录的 Tokens、额度消耗和首字总耗时列等宽且顺序稳定", async () => {
  const [table, styles] = await Promise.all([
    readFile(usageTablePath, "utf8"),
    readFile(stylesPath, "utf8"),
  ]);
  const desktop = section(table, '<div className="table-wrap table-scroll table-scroll-usage usage-records-desktop">');
  assertOrdered(desktop, [
    'className="usage-col-tokens"',
    'className="usage-col-cost"',
    'className="usage-col-performance"',
  ]);
  for (const column of ["tokens", "cost", "performance"]) {
    assert.match(
      styles,
      new RegExp(`\\.usage-table-admin \\.usage-col-${column} \\{\\s*width:\\s*15%;`),
    );
  }
});

test("用户统计和审批处理不显示副标题，审批状态旁展示飞书处理人姓名", async () => {
  const [client, postgresQueries, postgresStore, store] = await Promise.all([
    readFile(adminClientPath, "utf8"),
    readFile(postgresQueriesPath, "utf8"),
    readFile(postgresStorePath, "utf8"),
    readFile(storePath, "utf8"),
  ]);
  const userStats = section(client, '{panel === "userStats" && (', '{panel === "usageRecords" && (');
  const approvals = section(client, '{panel === "approvals" && (', '{panel === "settings"');
  const operatorLabel = section(client, "function approvalOperatorLabel(", "function currentBillingPeriod()");

  assert.doesNotMatch(userStats, /CardDescription/);
  assert.doesNotMatch(approvals, /CardDescription/);
  assertOrdered(approvals, ["<th>状态</th>", "<th>处理人</th>"]);
  assert.match(approvals, /approvalOperatorLabel\(request\)/);
  assert.match(operatorLabel, /approvalOperatorName\?\.trim\(\)/);
  assert.match(operatorLabel, /return input\.approvalOperatorName\.trim\(\)/);
  assert.match(operatorLabel, /startsWith\("system:"\).*return "系统自动处理"/s);
  assert.match(operatorLabel, /return "未同步飞书姓名"/);
  assert.doesNotMatch(operatorLabel, /系统管理员|部门管理员|普通用户|scopeType|role/);

  assert.match(postgresQueries, /left join feishu_users operator_user/);
  assert.match(
    postgresQueries,
    /operator_user\.open_id = nullif\(request\.data->>'approvalOperatorOpenId', ''\)/,
  );
  assert.match(postgresQueries, /'operator', page\.operator_data/);
  assert.match(store, /approvalOperatorName: operator\?\.name/);
  assert.match(postgresStore, /nullif\(operator_user\.data->>'name', ''\) as operator_name/);
  assert.match(postgresStore, /approvalOperatorName: row\.operator_name \?\? undefined/);
});

test("套餐管理区分本周期即时提高、下一周期设置和总额度上限申请", async () => {
  const [route, requestRoute, decisionRoute, submit, store, postgresStore] = await Promise.all([
    readFile(packageRoutePath, "utf8"),
    readFile(packageRequestRoutePath, "utf8"),
    readFile(packageDecisionRoutePath, "utf8"),
    readFile(quotaSubmitPath, "utf8"),
    readFile(storePath, "utf8"),
    readFile(postgresStorePath, "utf8"),
  ]);
  const currentIncrease = section(
    submit,
    "export async function submitPostgresCurrentPackageIncrease(",
    "export async function submitPostgresKeyRotation(",
  );
  const decision = section(
    store,
    "export async function decideDepartmentQuotaRequestAsActor(",
    "export async function getEffectiveUserGrantQuota(",
  );

  assert.match(route, /action:\s*z\.literal\("increase_current_package"\)/);
  assert.match(route, /action:\s*z\.literal\("set_next_package"\)/);
  assert.match(route, /action:\s*z\.literal\("set_total_limit"\)/);
  assert.match(route, /submitPostgresCurrentPackageIncrease/);
  assert.match(route, /nextPackagePeriod\(settings\.packageReset\)/);
  assert.match(currentIncrease, /input\.packageQuota <= policy\.defaultGrantQuota/);
  assert.match(currentIncrease, /current_package_increase_required/);
  assert.match(currentIncrease, /policy\.quotaLimit - allocatedQuota - pendingReservedQuota/);
  assert.match(currentIncrease, /department_quota_insufficient/);
  assertOrdered(currentIncrease, [
    "saveTokenRequestRow(client, request)",
    "insertQuotaOperationRow(client, operation)",
    "insert into department_quota_periods",
    "insert into quota_change_events",
  ]);
  assert.doesNotMatch(currentIncrease, /delete from|truncate|proxy_request_logs|newapi_usage_records/);

  assert.match(requestRoute, /listAdminScopes\(\)/);
  assert.match(requestRoute, /scope\.scopeType === "global"/);
  assert.match(requestRoute, /approvalTargetOpenIds/);
  assert.match(requestRoute, /Promise\.allSettled/);
  assert.match(requestRoute, /sendPackageQuotaLimitApprovalCard/);
  assert.match(decisionRoute, /isSystemAdminScope\(auth\.scope\)/);
  assert.match(decisionRoute, /decideDepartmentQuotaRequestAsActor/);
  assert.match(decision, /await decidePostgresDepartmentQuotaRequestAsActor\(input\)/);
  assert.match(decision, /result\.request : result/);
  assert.doesNotMatch(decision, /PostgreSQL 部门额度审批必须/);
  assert.match(postgresStore, /known as materialized/);
  assert.match(postgresStore, /quota_period\.period < \$1/);
  assert.match(postgresStore, /full join known on known\.department_id = assigned\.department_id/);
  assert.match(store, /for \(const prior of \[\.\.\.store\.departmentQuotaPeriods\]/);
  assert.match(store, /departments\.set\(prior\.departmentId,[\s\S]*assignedQuota: 0/);
});

test("额度变更使用 NewAPI 当前周期消费作为下限并只重算余额", async () => {
  const [route, saga] = await Promise.all([
    readFile(quotaAdjustRoutePath, "utf8"),
    readFile(quotaSagaPath, "utf8"),
  ]);

  assert.match(route, /getNewApiUserAuthoritativeQuotaSnapshot\(targetUser\.id\)/);
  assert.match(route, /toNewApiQuota\(approvedMonthlyQuota\) < authoritative\.consumedQuota/);
  assert.match(route, /code:\s*"quota_below_consumed"/);
  assert.match(route, /consumedQuota:\s*fromNewApiQuota\(authoritative\.consumedQuota\)/);
  assert.match(saga, /assignedQuotaAfter - authoritative\.consumedQuota/);
  assert.match(saga, /assignedMonthlyQuota - authoritative\.consumedQuota/);
  assert.match(saga, /consumedInPackagePeriod:\s*authoritative\.consumedQuota/);
});

test("取消管理员只撤销管理范围，禁用与删除保留各自访问语义和记录标记", async () => {
  const [cancelRoute, tokenRequestRoute, access, experience, store, postgresStore] =
    await Promise.all([
      readFile(cancelAdminRoutePath, "utf8"),
      readFile(tokenRequestRoutePath, "utf8"),
      readFile(workspaceAccessPath, "utf8"),
      readFile(experienceClientPath, "utf8"),
      readFile(storePath, "utf8"),
      readFile(postgresStorePath, "utf8"),
    ]);
  const disabledPanel = section(
    experience,
    'session?.workspaceAccess === "disabled" ? (',
    ") : session?.adminScope ? (",
  );
  const jsonReapply = section(store, "export async function createTokenRequest(", "export async function updateTokenRequest(");
  const postgresReapply = section(
    postgresStore,
    "export async function insertPostgresTokenRequest(",
    "export async function updatePostgresTokenRequest(",
  );

  assert.match(cancelRoute, /updateManualAdminScopeAsActor/);
  assert.match(cancelRoute, /status:\s*"disabled"/);
  assert.match(cancelRoute, /disabledReason:\s*"manual_revoke"/);
  assert.doesNotMatch(cancelRoute, /tokenAccount|newapiToken|disableNewApi|revokeNewApi/);

  assert.match(access, /user\?\.status === "deleted"\) return "application_only"/);
  assert.match(access, /user\?\.status === "disabled"\) return "disabled"/);
  assert.match(tokenRequestRoute, /user\.status === "disabled"/);
  assert.match(tokenRequestRoute, /workspace_user_disabled/);
  assert.match(disabledPanel, /当前用户已被禁用/);
  assert.match(disabledPanel, /等待管理员解禁/);
  assert.doesNotMatch(disabledPanel, /申请 Token|submitRequest|requestToken/);

  assert.match(jsonReapply, /if \(user\?\.status === "deleted"\)/);
  assert.match(jsonReapply, /user\.status = "active"/);
  assert.doesNotMatch(jsonReapply, /deletedAt\s*=\s*undefined|deletedReason\s*=\s*undefined/);
  assert.match(postgresReapply, /if \(user\?\.status === "deleted"\)/);
  assert.match(postgresReapply, /\.\.\.user,[\s\S]*status:\s*"active"/);
  assert.doesNotMatch(postgresReapply, /deletedAt:\s*undefined|deletedReason:\s*undefined/);
});

test("用户管理在禁用状态把同一操作位切换为启用按钮", async () => {
  const client = await readFile(adminClientPath, "utf8");
  const statusActions = section(
    client,
    'className="user-management-status-actions"',
    '<Trash2Icon data-icon="inline-start" />',
  );

  assertOrdered(statusActions, [
    'user.status === "disabled"',
    "onClick={() => void enableUser(user)}",
    "启用",
    "onClick={() => void disableUser(user)}",
    "禁用",
  ]);
  assert.match(statusActions, /user\.activeTokenStatus !== "disabled"/);
  assert.match(statusActions, /user\.activeTokenStatus !== "active"/);
});
