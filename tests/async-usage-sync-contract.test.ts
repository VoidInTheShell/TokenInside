import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const usageSyncRoutePath = new URL("../app/api/admin/usage-sync/route.ts", import.meta.url);
const usageSyncStatusRoutePath = new URL(
  "../app/api/admin/billing-operations/[id]/route.ts",
  import.meta.url,
);
const usageSyncPath = new URL("../lib/usage-sync.ts", import.meta.url);
const storePath = new URL("../lib/store.ts", import.meta.url);
const postgresStorePath = new URL("../lib/postgres-store.ts", import.meta.url);
const adminClientPath = new URL("../components/admin-client.tsx", import.meta.url);

test("manual usage sync returns a durable 202 operation before external work", async () => {
  const route = await readFile(usageSyncRoutePath, "utf8");

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
  assert.match(usageSync, /renewBillingOperationExecution/);
  assert.match(usageSync, /billingOperationLeaseId: leaseId/);
  assert.match(usageSync, /runRunnableManualUsageSyncOperations/);
  assert.match(store, /return mutatePostgresAppSettings\(fn\)/);
  assert.match(store, /canClaimBillingOperation\(operation, now\)/);
  assert.match(store, /current\.leaseId !== expectedLeaseId/);
  const mutationStart = postgresStore.indexOf("export async function mutatePostgresAppSettings<");
  const mutationEnd = postgresStore.indexOf(
    "export async function upsertPostgresUserQuotaPolicy(",
    mutationStart,
  );
  assert.notEqual(mutationStart, -1);
  assert.notEqual(mutationEnd, -1);
  const mutation = postgresStore.slice(mutationStart, mutationEnd);
  assert.match(mutation, /withControlTransaction/);
  assert.match(mutation, /JSON\.stringify\(settings\) !== before/);

  const upsertStart = store.indexOf("function upsertBillingOperation(");
  const upsertEnd = store.indexOf("function prependBillingOperation(", upsertStart);
  assert.notEqual(upsertStart, -1);
  assert.notEqual(upsertEnd, -1);
  const upsert = store.slice(upsertStart, upsertEnd);
  assert.ok(
    upsert.indexOf("...input") <
      upsert.indexOf('id: input.id ?? existing?.id ?? randomId("bo")'),
    "an undefined optional input id must not overwrite the generated operation id",
  );
});

test("global admin can poll usage sync without keeping the original request open", async () => {
  const [statusRoute, adminClient] = await Promise.all([
    readFile(usageSyncStatusRoutePath, "utf8"),
    readFile(adminClientPath, "utf8"),
  ]);

  assert.match(statusRoute, /requireAdminScope/);
  assert.match(statusRoute, /scope\.scopeType !== "global"/);
  assert.match(statusRoute, /findBillingOperationById/);
  assert.match(adminClient, /\/api\/admin\/billing-operations\/\$\{encodeURIComponent/);
  assert.match(adminClient, /setBusy\(false\)/);
  assert.match(adminClient, /Boolean\(usageSyncOperationId\)/);
});
