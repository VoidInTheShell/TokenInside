import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const retiredRoutePath = new URL(
  "../app/api/admin/billing-health/route.ts",
  import.meta.url,
);
const adminClientPath = new URL("../components/admin-client.tsx", import.meta.url);
const packagesRoutePath = new URL(
  "../app/api/admin/packages/route.ts",
  import.meta.url,
);
const overviewRoutePath = new URL("../app/api/admin/overview/route.ts", import.meta.url);

function section(source: string, startMarker: string, endMarker?: string) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  if (!endMarker) return source.slice(start);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

test("移除的账务健康入口不再生成路由", async () => {
  await assert.rejects(access(retiredRoutePath));
});

test("管理后台移除账务审计与系统健康并保留三类 NewAPI 统计", async () => {
  const source = await readFile(adminClientPath, "utf8");
  assert.doesNotMatch(source, /billingAudit|systemHealth|BillingAuditPanel|SystemHealthPanel/);
  assert.doesNotMatch(source, /\/api\/admin\/billing-health/);
  assert.match(source, /panel === "departmentStats"/);
  assert.match(source, /panel === "userStats"/);
  assert.match(source, /panel === "usageRecords"/);
  assert.match(source, /panel === "userStats" &&/);
  assert.match(source, /直接按 NewAPI 日志展示/);
  const userStats = section(source, '{panel === "userStats" && (', '{panel === "usageRecords" && (');
  assert.doesNotMatch(userStats, /CardDescription/);
  assert.doesNotMatch(source, /兼容|迁移|旧版|已下线|账期|代理请求/);
});

test("套餐管理替代部门额度入口并落实角色写权限", async () => {
  const [client, route] = await Promise.all([
    readFile(adminClientPath, "utf8"),
    readFile(packagesRoutePath, "utf8"),
  ]);
  assert.match(client, /selectPanel\("packages"\)/);
  assert.match(client, /套餐管理/);
  assert.match(client, /本周期套餐额度/);
  assert.match(client, /下一周期套餐额度/);
  assert.match(client, /申请提升总额度上限/);
  assert.match(client, /fetch\("\/api\/admin\/packages"/);
  assert.match(client, /fetch\("\/api\/admin\/packages\/requests"/);
  assert.match(route, /totalQuotaLimit/);
  assert.match(route, /packageQuota/);
  assert.match(route, /action: z\.literal\("increase_current_package"\)/);
  assert.match(route, /action: z\.literal\("set_next_package"\)/);
  assert.match(route, /parsed\.data\.action === "set_total_limit"/);
  assert.match(route, /部门总额度上限只能由 root 或系统管理员设置/);
  assert.match(route, /submitPostgresCurrentPackageIncrease/);
  assert.match(route, /nextPackagePeriod\(settings\.packageReset\)/);
});

test("系统设置只保留稳定控制面配置且套餐重置仍由系统管理员管理", async () => {
  const source = await readFile(adminClientPath, "utf8");
  const settings = section(
    source,
    '{panel === "settings" && isSystemAdmin && (',
    "</main>",
  );
  assert.match(settings, /NewAPI 上游连接/);
  assert.match(settings, /默认申请额度/);
  assert.match(settings, /套餐重置/);
  assert.match(settings, /<Switch/);
  assert.doesNotMatch(
    settings,
    /用量同步|手动同步|匹配窗口|结算延迟|影子账本|计费操作/,
  );
});

test("overview 不向管理客户端暴露旧消费同步和本地账务操作", async () => {
  const source = await readFile(overviewRoutePath, "utf8");
  const settings = section(source, "function settingsForScope<", "export async function GET(");
  assert.match(settings, /defaultMonthlyQuota/);
  assert.match(settings, /newapiControl/);
  assert.doesNotMatch(settings, /usageSyncPolicy|usageSyncCheckpoint/);
  assert.doesNotMatch(settings, /billingOperations|quotaFeatureFlags|quotaMigration/);
});
