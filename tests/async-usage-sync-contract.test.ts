import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const usageSyncRoutePath = new URL(
  "../app/api/admin/billing/usage-ingestion/route.ts",
  import.meta.url,
);
const usageSyncStatusRoutePath = new URL(
  "../app/api/admin/billing-operations/[id]/route.ts",
  import.meta.url,
);
const usageSyncPath = new URL("../lib/usage-sync.ts", import.meta.url);
const storePath = new URL("../lib/store.ts", import.meta.url);
const postgresStorePath = new URL("../lib/postgres-store.ts", import.meta.url);
const adminClientPath = new URL("../components/admin-client.tsx", import.meta.url);

test("root maintenance ingestion returns a durable 202 operation before external work", async () => {
  const route = await readFile(usageSyncRoutePath, "utf8");

  assert.match(route, /!isRootAdminScope\(auth\.scope\)/);
  assert.match(route, /defaultUsageSyncPolicy/);
  assert.match(route, /enqueueManualUsageSyncOperation/);
  assert.match(route, /after\(\(\) => runManualUsageSyncOperation/);
  assert.match(route, /if \(queued\.created\)/);
  assert.match(route, /status: 202/);
  assert.match(route, /status: 409/);
  assert.doesNotMatch(route, /await syncNewApiUsageLogs/);
  assert.ok(
    route.indexOf("enqueueManualUsageSyncOperation") <
      route.indexOf("after(() => runManualUsageSyncOperation"),
  );
});

test("manual usage sync worker uses atomic claim, lease renewal, and scheduler recovery", async () => {
  const [usageSync, store, postgresStore] = await Promise.all([
    readFile(usageSyncPath, "utf8"),
    readFile(storePath, "utf8"),
    readFile(postgresStorePath, "utf8"),
  ]);

  assert.match(usageSync, /claimBillingOperationExecution/);
  assert.match(usageSync, /requireRootActor: true/);
  assert.match(usageSync, /renewBillingOperationExecution/);
  assert.match(usageSync, /billingOperationLeaseId: leaseId/);
  assert.match(usageSync, /runRunnableManualUsageSyncOperations/);
  assert.match(store, /claimPostgresBillingOperationExecution/);
  assert.match(store, /renewPostgresBillingOperationExecution/);
  assert.match(store, /recordPostgresBillingOperation/);
  assert.doesNotMatch(store, /return mutatePostgresAppSettings\(fn\)/);
  assert.match(store, /canClaimBillingOperation\(operation, now\)/);
  assert.match(store, /current\.leaseId !== expectedLeaseId/);
  const operationStart = postgresStore.indexOf(
    "export async function enqueuePostgresBillingOperation(",
  );
  const operationEnd = postgresStore.indexOf(
    "export async function upsertPostgresUserQuotaPolicy(",
    operationStart,
  );
  assert.notEqual(operationStart, -1);
  assert.notEqual(operationEnd, -1);
  const operations = postgresStore.slice(operationStart, operationEnd);
  assert.match(operations, /withControlTransaction/);
  assert.match(operations, /options\.requireRootActor/);
  assert.match(operations, /resolvePostgresActorScopeInTransaction/);
  assert.match(operations, /actorScope\.source !== "environment"/);
  assert.match(operations, /update billing_operations/);
  assert.doesNotMatch(operations, /app_settings|mutatePostgresAppSettings/);

  const upsertStart = store.indexOf("function upsertBillingOperation(");
  const upsertEnd = store.indexOf("async function mutateBillingOperations<", upsertStart);
  assert.notEqual(upsertStart, -1);
  assert.notEqual(upsertEnd, -1);
  const upsert = store.slice(upsertStart, upsertEnd);
  assert.ok(
    upsert.indexOf("...input") <
      upsert.indexOf('id: input.id ?? existing?.id ?? randomId("bo")'),
    "an undefined optional input id must not overwrite the generated operation id",
  );
});

test("billing operation status is read-only and the admin UI has no manual ingestion poller", async () => {
  const [statusRoute, adminClient] = await Promise.all([
    readFile(usageSyncStatusRoutePath, "utf8"),
    readFile(adminClientPath, "utf8"),
  ]);

  assert.match(statusRoute, /requireAdminScope/);
  assert.match(statusRoute, /!isRootAdminScope\(auth\.scope\)/);
  assert.match(statusRoute, /findBillingOperationById/);
  assert.doesNotMatch(statusRoute, /ensureUsageSyncScheduler|after\(|runManualUsageSyncOperation/);
  assert.doesNotMatch(adminClient, /\/api\/admin\/billing-operations\//);
  assert.doesNotMatch(adminClient, /usageSyncOperationId|runUsageSync/);
});

test("quota balance changes use a bounded stable barrier scan instead of the global repair cursor", async () => {
  const usageSync = await readFile(usageSyncPath, "utf8");
  const saga = await readFile(new URL("../lib/quota-saga.ts", import.meta.url), "utf8");
  const start = usageSync.indexOf("export async function ingestQuotaBarrierUsage(");
  const end = usageSync.indexOf("function sleep(", start);
  assert.ok(start >= 0 && end > start);
  const barrier = usageSync.slice(start, end);
  assert.match(barrier, /settlementLagMinutes/);
  assert.match(barrier, /directConsumptionDrainGraceMs/);
  assert.match(barrier, /isSettlementWatermarkFresh/);
  assert.match(barrier, /const checkpointSettled = Date\.parse/);
  assert.match(barrier, /status: "checkpoint_behind"/);
  assert.match(barrier, /withUsageSyncLock\(false/);
  assert.match(barrier, /quotaBarrierMaxRows/);
  assert.match(barrier, /logsPage\.total !== expectedTotal/);
  assert.match(barrier, /scanFirstIdentity\(logsPage\.items\) !== expectedFirstIdentity/);
  assert.match(barrier, /verification\.total !== expectedTotal/);
  assert.match(barrier, /backfillProxyLogsFromNewApiUsage/);
  assert.match(barrier, /await finalizeBackfillBillingPeriods\(backfills, 0\)/);
  assert.ok(
    barrier.indexOf("await finalizeBackfillBillingPeriods(backfills, 0)") <
      barrier.indexOf('status: "completed"'),
    "the quota barrier must await derived billing before reporting completion",
  );
  assert.doesNotMatch(barrier, /repairCursorThrough\s*>?=/);
  assert.doesNotMatch(barrier, /checkpoint\?\.lastRunStatus\s*!==\s*"applied"/);
  assert.doesNotMatch(barrier, /checkpointCoversCutoff/);
  assert.doesNotMatch(barrier, /policy\.overlapMinutes/);
  assert.match(saga, /ingestQuotaBarrierUsage\(\{/);
  assert.match(saga, /consumptionBarrierIngestionStatus/);
});

test("usage integrity watermark is recomputed from currently open blocking issues", async () => {
  const [usageSync, store, postgres] = await Promise.all([
    readFile(usageSyncPath, "utf8"),
    readFile(storePath, "utf8"),
    readFile(postgresStorePath, "utf8"),
  ]);
  assert.match(usageSync, /await getEarliestOpenBlockingUsageIssue\(\)/);
  assert.match(usageSync, /integrityBlockedAt = blockingIssue/);
  assert.match(usageSync, /integrityBlockedIssueId = blockingIssue\?\.id/);
  assert.match(store, /getPostgresEarliestOpenBlockingUsageIssue/);
  assert.match(postgres, /getPostgresEarliestOpenBlockingUsageIssue/);
  assert.match(postgres, /where status = 'open'/);
  assert.match(postgres, /blocksSettlement/);
});
