import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const quotaSubmitPath = new URL("../lib/quota-operation-submit.ts", import.meta.url);
const helperPath = new URL("../lib/admin-default-provisioning.ts", import.meta.url);
const sagaPath = new URL("../lib/quota-saga.ts", import.meta.url);
const storePath = new URL("../lib/store.ts", import.meta.url);
const callbackPath = new URL(
  "../app/api/auth/feishu/callback/route.ts",
  import.meta.url,
);
const adminPostPath = new URL("../app/api/admin/admins/route.ts", import.meta.url);
const adminPatchPath = new URL(
  "../app/api/admin/admins/[id]/route.ts",
  import.meta.url,
);
const sessionPath = new URL("../app/api/session/route.ts", import.meta.url);
const experienceClientPath = new URL("../components/experience-client.tsx", import.meta.url);
const instrumentationPath = new URL("../instrumentation.ts", import.meta.url);

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
    assert.ok(next > cursor, `${marker} must follow the previous submission step`);
    cursor = next;
  }
}

test("管理员默认发放使用用户锁和用户/账期稳定幂等键原子受理", async () => {
  const source = await readFile(quotaSubmitPath, "utf8");
  const submit = section(
    source,
    "export async function submitPostgresAdminDefaultProvisioning(",
    "async function readAdminActorScope(",
  );

  assert.match(
    source,
    /return `admin-default-first-provision:\$\{feishuUserId\}:\$\{period\}`/,
  );
  assert.match(submit, /return withQuotaSubmitTransaction\(async \(client\) =>/);
  assert.match(submit, /pg_advisory_xact_lock/);
  assert.match(submit, /`user-quota:\$\{input\.feishuUserId\}`/);
  assert.match(submit, /where idempotency_key = \$3/);
  assert.match(submit, /where feishu_user_id = \$1 and status = 'active'/);
  assert.match(submit, /resolveSessionAdminScopeProjection/);
  assert.match(submit, /if \(row\.active_account\)/);
  assert.match(submit, /requestType: "first_apply"/);
  assert.match(submit, /status: "approved_provisioning"/);
  assert.match(submit, /operationType: "first_provision"/);
  assert.match(submit, /reservedDepartmentQuota: 0/);
  assertOrdered(submit, [
    "const storedRequest = await saveTokenRequestRow(client, request)",
    "const storedOperation = await insertQuotaOperationRow(client, operation)",
    "return {",
  ]);
  assert.doesNotMatch(
    submit,
    /runQuotaOperation|createNewApiToken|updateNewApiTokenQuota|fetch\(/,
  );
  assert.doesNotMatch(source, /quotaMigration|quotaFeatureFlags|assertSubmissionFeature/);
});

test("部门预算由 Saga 幂等确保，无部门的全局管理员不伪造部门", async () => {
  const [submitSource, sagaSource, helperSource, storeSource] = await Promise.all([
    readFile(quotaSubmitPath, "utf8"),
    readFile(sagaPath, "utf8"),
    readFile(helperPath, "utf8"),
    readFile(storePath, "utf8"),
  ]);
  const submit = section(
    submitSource,
    "export async function submitPostgresAdminDefaultProvisioning(",
    "async function readAdminActorScope(",
  );
  const firstProvision = section(
    sagaSource,
    "async function handleFirstProvision(",
    "async function accountBeforeRotation(",
  );

  assert.match(firstProvision, /reserveQuotaOperationDepartmentBudget/);
  const reserve = section(
    storeSource,
    "export async function reserveQuotaOperationDepartmentBudget(",
    "export async function listQuotaOperations(",
  );
  assert.match(reserve, /if \(!initial\.departmentId\) return initial/);
  assert.match(reserve, /await ensureDepartmentQuotaPeriod\(\{/);
  assertOrdered(reserve, [
    "if (!initial.departmentId) return initial",
    "await ensureDepartmentQuotaPeriod({",
    "reservePostgresQuotaOperationDepartmentBudget(",
  ]);
  assert.match(submit, /reservedDepartmentQuota: 0/);
  assert.doesNotMatch(submit, /reserveQuotaOperationDepartmentBudget/);
  assert.match(helperSource, /ensureQuotaOperationWorker\(\)/);
  assert.doesNotMatch(helperSource, /runQuotaOperation\(/);
});

test("只有确认后的管理员入口受理默认 Key，失败不会撤销登录或权限写入", async () => {
  const [callback, adminPost, adminPatch, helper, session, instrumentation] =
    await Promise.all([
      readFile(callbackPath, "utf8"),
      readFile(adminPostPath, "utf8"),
      readFile(adminPatchPath, "utf8"),
      readFile(helperPath, "utf8"),
      readFile(sessionPath, "utf8"),
      readFile(instrumentationPath, "utf8"),
    ]);

  assertOrdered(callback, [
    "const adminScope = await getEffectiveAdminScopeForUser(user)",
    "await ensureAdminDefaultProvisioning({",
    "const sessionToken = createSessionToken({",
    "await setSessionCookie(sessionToken)",
    "adminProvisioning,",
  ]);
  assertOrdered(adminPost, [
    "result = await upsertManualAdminScopeAsActor({",
    "await ensureAdminDefaultProvisioning({",
    "return NextResponse.json({ admin: result.scope, provisioning })",
  ]);
  assertOrdered(adminPatch, [
    "admin = await updateManualAdminScopeAsActor({",
    'admin.status === "active"',
    "await ensureAdminDefaultProvisioning({",
    "return NextResponse.json({ admin, provisioning })",
  ]);
  assert.match(helper, /catch \(error\)[\s\S]*status: "failed"/);
  assert.doesNotMatch(session, /ensureAdminDefaultProvisioning/);
  assert.doesNotMatch(instrumentation, /ensureAdminDefaultProvisioning/);
});

test("并发重复触发只唤醒 worker，并复用稳定操作而不进行启动全量扫描", async () => {
  const [submitSource, helperSource] = await Promise.all([
    readFile(quotaSubmitPath, "utf8"),
    readFile(helperPath, "utf8"),
  ]);
  const submit = section(
    submitSource,
    "export async function submitPostgresAdminDefaultProvisioning(",
    "async function readAdminActorScope(",
  );

  assertOrdered(submit, [
    "pg_advisory_xact_lock",
    "if (row.active_account)",
    "if (row.idempotent)",
    "if (row.open_operation)",
    "insertQuotaOperationRow(client, operation)",
  ]);
  assert.match(helperSource, /result\.status === "provisioning"/);
  assert.match(helperSource, /ensureQuotaOperationWorker\(\)/);
  assert.doesNotMatch(helperSource, /listAdminScopes|Promise\.all\([^)]*admin/i);
});

test("管理员等待自动发 Key 时留在用户后台且不会看到普通成员申请入口", async () => {
  const source = await readFile(experienceClientPath, "utf8");
  assert.match(source, /const isAdminWorkspace = Boolean\(session\?\.adminScope\)/);
  assert.match(
    source,
    /const title = hasActiveToken \|\| isAdminWorkspace \? "用户后台" : "套餐申请"/,
  );
  assert.match(source, /session\?\.adminScope \? \([\s\S]*管理员 Key 自动发放/);
  assert.match(source, /管理员用户后台已经开放/);
  const noKeyStart = source.indexOf("{!hasActiveToken ? (");
  const adminProvisioning = source.indexOf("session?.adminScope ? (", noKeyStart);
  const memberApplication = source.indexOf("<CardTitle>申请套餐</CardTitle>", noKeyStart);
  assert.ok(noKeyStart >= 0);
  assert.ok(adminProvisioning > noKeyStart);
  assert.ok(memberApplication > adminProvisioning);
});

test("访问撤销前无上游副作用的管理员默认发放可按原幂等键安全恢复", async () => {
  const [submitSource, helperSource, storeSource] = await Promise.all([
    readFile(quotaSubmitPath, "utf8"),
    readFile(helperPath, "utf8"),
    readFile(storePath, "utf8"),
  ]);
  const submit = section(
    submitSource,
    "export async function submitPostgresAdminDefaultProvisioning(",
    "async function readAdminActorScope(",
  );

  assert.match(submit, /canReopenFirstProvisionAfterAccessRevoke\(row\.idempotent\)/);
  assert.match(submit, /reopenFirstProvisionAfterAccessRevoke\(row\.idempotent/);
  assert.match(submit, /and operation_type = 'first_provision'\s+and state = 'cancelled'/);
  assert.match(submit, /worker_lease_id = null/);
  assert.match(submit, /completed_at = null/);
  assert.match(helperSource, /reopenJsonAdminDefaultProvisioningAfterAccessRevoke/);
  assert.match(storeSource, /canReopenFirstProvisionAfterAccessRevoke\(operation\)/);
  assert.match(storeSource, /withAdminScopeUserLocks\(\[input\.feishuUserId\]/);
  assert.match(storeSource, /withUserQuotaOperationLock\(input\.feishuUserId/);
  assert.match(
    submit,
    /\["completed", "compensated", "cancelled", "manual_review"\]\.includes/,
  );
});
