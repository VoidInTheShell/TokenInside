import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schedulerPath = new URL("../lib/package-reset-scheduler.ts", import.meta.url);
const planPath = new URL("../lib/package-reset-plan.ts", import.meta.url);
const postgresStorePath = new URL("../lib/postgres-store.ts", import.meta.url);
const storePath = new URL("../lib/store.ts", import.meta.url);
const settingsRoutePath = new URL(
  "../app/api/admin/settings/route.ts",
  import.meta.url,
);
const adminClientPath = new URL("../components/admin-client.tsx", import.meta.url);
const instrumentationPath = new URL("../instrumentation.ts", import.meta.url);

test("package reset remains a system setting backed by an automatic fenced scheduler", async () => {
  const [scheduler, plan, postgresStore, store, settingsRoute, adminClient, instrumentation] =
    await Promise.all([
      readFile(schedulerPath, "utf8"),
      readFile(planPath, "utf8"),
      readFile(postgresStorePath, "utf8"),
      readFile(storePath, "utf8"),
      readFile(settingsRoutePath, "utf8"),
      readFile(adminClientPath, "utf8"),
      readFile(instrumentationPath, "utf8"),
    ]);

  assert.match(settingsRoute, /packageReset:[\s\S]*?enabled: z\.boolean\(\)/);
  assert.match(settingsRoute, /dayOfMonth: z\.number\(\)\.int\(\)\.min\(1\)\.max\(31\)/);
  assert.match(settingsRoute, /notifyPackageResetScheduler\(\)/);
  assert.match(adminClient, /<h3>套餐重置<\/h3>/);
  assert.match(adminClient, /<Switch/);
  assert.match(adminClient, /Array\.from\(\{ length: 31 \}/);
  assert.doesNotMatch(adminClient, /panel === "packageReset"/);

  assert.match(instrumentation, /ensurePackageResetScheduler/);
  assert.match(scheduler, /withPackageResetSchedulerFence/);
  assert.match(
    scheduler,
    /await preparePackageResetPeriod\([\s\S]*?await buildPackageResetPlan\([\s\S]*?await enqueuePackageResetPlan\(/,
  );
  assert.match(scheduler, /schedulerBlockedPollMs = 5 \* 60_000/);
  assert.match(scheduler, /schedulerCompletionRecheckMs = 60 \* 60_000/);
  assert.match(scheduler, /reason: "execution_failed"/);
  assert.doesNotMatch(scheduler, /error\.message/);

  assert.match(store, /options\.executionSource === "package_reset"/);
  assert.match(store, /assertPackageResetExecutionAllowed\([\s\S]*?store\.settings\.packageReset/);
  assert.match(store, /item\.createdByOpenId !== PACKAGE_RESET_SYSTEM_ACTOR/);
  assert.match(store, /previous\?\.quotaLimit \?\? initialDepartmentQuotaLimit/);
  assert.match(plan, /packagePeriod/);
  assert.doesNotMatch(plan, /usage.?sync|proxy_request_logs|user_billing_periods/i);

  assert.match(postgresStore, /options\.executionSource === "package_reset"/);
  assert.match(postgresStore, /from app_settings[\s\S]*?for share/);
  assert.match(postgresStore, /assertPackageResetExecutionAllowed/);
  assert.match(postgresStore, /previousPolicy\?\.quotaLimit \?\? initialDepartmentQuotaLimit/);
  assert.match(postgresStore, /updatedByFeishuUserId: PACKAGE_RESET_SYSTEM_ACTOR/);
});
