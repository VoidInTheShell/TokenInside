import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const healthLibPath = new URL("../lib/billing-health.ts", import.meta.url);
const healthRoutePath = new URL(
  "../app/api/admin/billing-health/route.ts",
  import.meta.url,
);
const adminClientPath = new URL("../components/admin-client.tsx", import.meta.url);
const panelsPath = new URL("../components/billing-health-panels.tsx", import.meta.url);
const overviewRoutePath = new URL("../app/api/admin/overview/route.ts", import.meta.url);

function section(source: string, startMarker: string, endMarker?: string) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  if (!endMarker) return source.slice(start);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

test("billing-health GET 只有只读管理员快照能力", async () => {
  const [route, source] = await Promise.all([
    readFile(healthRoutePath, "utf8"),
    readFile(healthLibPath, "utf8"),
  ]);
  const postgres = section(
    source,
    "async function getPostgresBillingHealth(",
    "async function getJsonBillingHealth(",
  );
  const jsonFallback = section(
    source,
    "async function getJsonBillingHealth(",
    "export async function getBillingHealth(",
  );

  assert.match(route, /export async function GET\(request: Request\)/);
  assert.doesNotMatch(route, /export async function (?:POST|PATCH|PUT|DELETE)/);
  assert.match(route, /await requireAdminScope\(\)/);
  assert.match(route, /await getBillingHealth\(auth\.scope, period\)/);
  assert.match(route, /"Cache-Control": "no-store"/);

  assert.match(postgres, /withPostgresControlClient/);
  assert.match(postgres, /with scoped_users as materialized/);
  assert.match(postgres, /\$1::text = 'global' or user_row\.department_id = \$2/);
  assert.match(postgres, /limit 100/);
  assert.match(postgres, /limit 200/);
  assert.doesNotMatch(postgres, /getStoreSnapshot|fetch\(|buildQuotaShadowReconciliation/);
  assert.doesNotMatch(postgres, /\b(?:insert|update|delete|truncate)\s+(?:into|from|[a-z_])/i);
  assert.match(jsonFallback, /await getStoreSnapshot\(\)/);
  assert.doesNotMatch(jsonFallback, /fetch\(|buildQuotaShadowReconciliation/);
});

test("PostgreSQL 健康查询按管理范围过滤且所有明细都有 SQL 上限", async () => {
  const source = await readFile(healthLibPath, "utf8");
  const postgres = section(
    source,
    "async function getPostgresBillingHealth(",
    "async function getJsonBillingHealth(",
  );

  assert.match(postgres, /join scoped_users scoped_user on scoped_user\.id = policy\.feishu_user_id/);
  assert.match(postgres, /join scoped_users scoped_user on scoped_user\.id = billing\.feishu_user_id/);
  assert.match(postgres, /join scoped_users scoped_user on scoped_user\.id = ledger\.feishu_user_id/);
  assert.match(postgres, /join scoped_users scoped_user on scoped_user\.id = usage_record\.feishu_user_id/);
  assert.match(postgres, /usage_record\.match_status in \('matched', 'no_proxy_match'\)/);
  assert.match(postgres, /join scoped_users scoped_user on scoped_user\.id = operation\.feishu_user_id/);
  assert.match(
    postgres,
    /current_consumption as materialized \([\s\S]*?order by coalesce\([\s\S]*?newapi_created_at[\s\S]*?last_synced_at[\s\S]*?limit 100/,
  );
  assert.match(postgres, /operation_counts as materialized/);
  assert.match(
    postgres,
    /operation_counts as materialized \([\s\S]*?where operation\.state not in \('completed', 'compensated', 'cancelled'\)/,
  );
  assert.match(postgres, /recent_operations as materialized \([\s\S]*?limit 100/);
  assert.doesNotMatch(postgres, /scoped_operations as materialized/);
  assert.match(postgres, /state = 'retryable_failed'/);
  assert.match(postgres, /state = 'manual_review'/);
  assert.match(postgres, /'manualReviewTasks'/);
  assert.match(postgres, /'staleAccessResumeTasks'/);
  assert.match(postgres, /'balanceObservationGaps'/);
  assert.match(postgres, /balance_observation_coverage as materialized/);
  assert.match(
    postgres,
    /stale_access_resumes as materialized \([\s\S]*?user_access_resume_pending[\s\S]*?limit 100/,
  );
  assert.match(postgres, /\$1::text = 'global' or scoped_user\.id is not null/);
  assert.match(postgres, /join scoped_users scoped_user on scoped_user\.id = record\.feishu_user_id/);
  assert.match(
    postgres,
    /join token_accounts reconciliation_account[\s\S]*?reconciliation_account\.status = 'active'/,
  );
  assert.match(postgres, /where \$5::boolean[\s\S]*checkpoint\.scope = 'newapi_usage_logs'/);
  assert.match(postgres, /scope\.source === "environment"/);
  assert.match(postgres, /scope\.role === "root"/);
  assert.equal(postgres.match(/limit 100/g)?.length, 6);
  assert.equal(postgres.match(/limit 200/g)?.length, 1);
  assert.match(postgres, /limit 1/);
  assert.doesNotMatch(postgres, /credentialCiphertext|idempotencyKey|evidence|raw/);
});

test("系统健康把人工检查和访问恢复积压分开计数并纳入红色状态", async () => {
  const [health, panels] = await Promise.all([
    readFile(healthLibPath, "utf8"),
    readFile(panelsPath, "utf8"),
  ]);

  assert.match(health, /manualReviewTasks: number/);
  assert.match(health, /staleAccessResumeTasks: number/);
  assert.match(health, /balanceObservationGaps: number/);
  assert.match(
    health,
    /retryTasks:[\s\S]*?state === "retryable_failed"[\s\S]*?manualReviewTasks:[\s\S]*?state === "manual_review"/,
  );
  assert.match(
    health,
    /balanceDrifts:[\s\S]*?"excess_upstream", "deficit_upstream", "manual_review"/,
  );
  assert.match(panels, /manualReviewTasks > 0/);
  assert.match(panels, /staleAccessResumeTasks > 0/);
  assert.match(panels, /balanceObservationGaps > 0/);
  assert.match(panels, /需要人工检查任务/);
  assert.match(panels, /等待恢复用户访问/);
  assert.match(panels, /余额观察待覆盖/);
});

test("管理后台用账务审计和系统健康替代旧额度控制并共享一次快照", async () => {
  const source = await readFile(adminClientPath, "utf8");
  const loader = section(
    source,
    "const loadBillingHealth = useCallback",
    "useEffect(() => {",
  );

  assert.match(source, /\| "billingAudit"/);
  assert.match(source, /\| "systemHealth"/);
  assert.match(source, /<BillingAuditPanel/);
  assert.match(source, /<SystemHealthPanel/);
  assert.match(source, /data=\{billingHealthData\}/g);
  assert.match(loader, /fetch\("\/api\/admin\/billing-health", \{ cache: "no-store" \}\)/);
  assert.doesNotMatch(loader, /method:|observe|POST/);
  assert.doesNotMatch(source, /QuotaControlResponse|quotaControlData|panel === "quotaControl"/);
  assert.doesNotMatch(source, /\/api\/admin\/quota-control/);
  assert.doesNotMatch(source, /runQuotaControlAction|安全向下校准|重建影子快照/);
});

test("root-only 系统健康和系统管理员操作入口不会向其他管理员渲染", async () => {
  const [client, health] = await Promise.all([
    readFile(adminClientPath, "utf8"),
    readFile(healthLibPath, "utf8"),
  ]);

  assert.match(
    client,
    /\{isRootAdmin && \([\s\S]*?onClick=\{\(\) => selectPanel\("systemHealth"\)\}/,
  );
  assert.match(client, /panel === "systemHealth" && isRootAdmin && \(/);
  assert.match(
    client,
    /scope\.scopeType !== "global" \|\| isRootAdmin \? \([\s\S]*?取消管理员[\s\S]*?\) : \(/,
  );
  assert.match(
    client,
    /\{isRootAdmin && \([\s\S]*?NewAPI 上游连接[\s\S]*?保存上游连接/,
  );
  assert.match(health, /scope\.source === "environment"/);
  assert.match(health, /scope\.role === "root"/);
  assert.match(health, /includeSystemHealth \? store\.usageSyncIssues : \[\]/);
  assert.match(
    health,
    /includeSystemHealth \? store\.quotaReconciliationRecords : \[\]/,
  );
  assert.match(
    health,
    /includeSystemHealth[\s\S]*?store\.usageSyncCheckpoints\.find/,
  );
});

test("系统设置只保留稳定业务配置并包含套餐重置", async () => {
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
    /用量同步|手动同步|同步周期|每页数量|重叠窗口|匹配窗口|结算延迟|重试基数/,
  );
  assert.doesNotMatch(settings, /月度开账|monthly-reset|preflight/);
  assert.doesNotMatch(settings, /F 阶段|功能开关|迁移门禁|影子账本|计费操作/);
  assert.doesNotMatch(settings, /billingOperations|quotaFeature|quotaMigration/);
});

test("账务与健康面板不回退显示内部代码或提供维护动作", async () => {
  const source = await readFile(panelsPath, "utf8");

  assert.match(source, /等待继续扫描/);
  assert.match(source, /其他授权变更/);
  assert.match(source, /其他账务任务/);
  assert.match(source, /其他消费异常/);
  assert.match(source, /已结算消费记录/);
  assert.match(source, /已归属 Key（未关联请求）/);
  assert.doesNotMatch(source, /\?\? entry\.entryType/);
  assert.doesNotMatch(source, /\?\? operation\.operationType/);
  assert.doesNotMatch(source, /\?\? operation\.state/);
  assert.doesNotMatch(source, /\?\? issue\.issueType/);
  assert.doesNotMatch(source, /activeGeneration|operationGeneration|\bA\/G\/C\/E\/R\b/);
  assert.doesNotMatch(source, /人工重试|立即重试|执行维护|修复余额|向下校准/);
  assert.doesNotMatch(source, /onClick=.*(?:POST|reconcile|retry)/);
  assert.match(source, /刷新只读快照/);
});

test("overview 不再向管理客户端暴露迁移、同步策略和旧 JSON 操作", async () => {
  const source = await readFile(overviewRoutePath, "utf8");
  const settings = section(source, "function settingsForScope<", "export async function GET(");

  assert.match(settings, /defaultMonthlyQuota/);
  assert.match(settings, /newapiControl/);
  assert.doesNotMatch(settings, /usageSyncPolicy|usageSyncCheckpoint/);
  assert.doesNotMatch(settings, /billingOperations|quotaFeatureFlags|quotaMigration/);
});
