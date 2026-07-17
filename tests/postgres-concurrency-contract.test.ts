import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { createRerunSingleFlight } from "../lib/rerun-single-flight.ts";

const postgresStorePath = new URL("../lib/postgres-store.ts", import.meta.url);
const storePath = new URL("../lib/store.ts", import.meta.url);
const proxyRoutePath = new URL("../app/v1/[...path]/route.ts", import.meta.url);
const quotaOperationRoutePath = new URL(
  "../app/api/quota-operations/[id]/route.ts",
  import.meta.url,
);
const quotaSagaPath = new URL("../lib/quota-saga.ts", import.meta.url);
const rerunSingleFlightPath = new URL("../lib/rerun-single-flight.ts", import.meta.url);
const quotaGuardPath = new URL("../lib/quota-guard.ts", import.meta.url);
const quotaDecisionRoutePath = new URL(
  "../app/api/admin/token-requests/[id]/decision/route.ts",
  import.meta.url,
);
const keyResetRoutePath = new URL("../app/api/token/reset/route.ts", import.meta.url);

function functionBody(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

test("Postgres proxy admission uses a shared transaction fence without hot-row locks", async () => {
  const source = await readFile(postgresStorePath, "utf8");
  const admission = functionBody(
    source,
    "export async function insertPostgresQuotaAwareProxyLog",
    "export async function updatePostgresProxyLog",
  );

  assert.match(admission, /pg_try_advisory_xact_lock_shared/);
  assert.doesNotMatch(admission, /for update/i);
  assert.doesNotMatch(source, /localProxyAdmissionTails|withLocalProxyAdmissionFence/);
  assert.match(admission, /assertQuotaAdmission\(state, currentAccount\)/);

  for (const [startMarker, endMarker] of [
    ["export async function replacePostgresActiveTokenAccount", "export async function finalizePostgresTokenRotation"],
    ["export async function recordPostgresMonthlyResetApplied", "export async function upsertPostgresFeishuEvent"],
    ["export async function updatePostgresUserAccessStatus", "export async function revokePostgresAdminScopesForUser"],
    ["export async function enablePostgresUserAccess", "export async function insertPostgresProxyLog"],
  ]) {
    assert.match(
      functionBody(source, startMarker, endMarker),
      /lockPostgresUserQuotaFence/,
      `${startMarker} must take the exclusive admission fence`,
    );
  }
});

test("proxy hot path consolidates authentication and quota admission on one Postgres client", async () => {
  const [postgresSource, routeSource] = await Promise.all([
    readFile(postgresStorePath, "utf8"),
    readFile(proxyRoutePath, "utf8"),
  ]);
  const admission = functionBody(
    postgresSource,
    "export async function beginPostgresQuotaAwareProxyRequest",
    "export async function updatePostgresProxyLog",
  );

  assert.match(admission, /withTransaction<ProxyRequestAdmissionResult/);
  assert.match(admission, /select id as account_id,[\s\S]*operation_generation/);
  assert.match(admission, /pg_try_advisory_xact_lock_shared/);
  assert.match(admission, /left join feishu_users/);
  assert.match(admission, /left join user_quota_states/);
  assert.match(admission, /when admission <> 'open' then 'quota_admission_closed'/);
  assert.match(admission, /when account_generation <> active_generation/);
  assert.match(admission, /insert into proxy_request_logs/);
  assert.equal(
    admission.match(/await client\.query/g)?.length,
    2,
    "successful admission must use exactly two business SQL statements",
  );
  assert.doesNotMatch(admission, /for update/i);

  assert.match(routeSource, /beginQuotaAwareProxyRequest\(sha256Hex\(key\)/);
  assert.doesNotMatch(routeSource, /findActiveTokenByHash|beginQuotaAwareProxyLog|getUserById/);
});

test("Postgres quota rebuild delegates user rows to lock-scoped base-table reconciliation", async () => {
  const [postgresSource, storeSource] = await Promise.all([
    readFile(postgresStorePath, "utf8"),
    readFile(storePath, "utf8"),
  ]);
  const sync = functionBody(
    postgresSource,
    "async function syncPostgresBillingPeriodForUser",
    "export async function reconcilePostgresBillingPeriodForUser",
  );
  const rebuild = functionBody(
    storeSource,
    "async function rebuildQuotaMaterializedSnapshotsNow",
    "type QuotaMaterializationResult",
  );
  const postgresBranch = rebuild.slice(0, rebuild.indexOf("const store = await readStore();"));

  assert.match(sync, /billing-period-finalize:/);
  assert.match(sync, /from user_quota_policies/);
  assert.match(sync, /from quota_ledger_entries/);
  assert.match(sync, /from newapi_usage_records/);
  assert.match(sync, /saveUserBillingPeriodRow\(client, summary\)/);
  assert.match(postgresBranch, /rebuildPostgresQuotaMaterializedUsers\(period\)/);
  assert.doesNotMatch(postgresBranch, /persistUserBillingPeriod/);
});

test("quota operation polling uses Postgres point reads and avoids advisory locks until a credential is ready", async () => {
  const [storeSource, sagaSource, routeSource] = await Promise.all([
    readFile(storePath, "utf8"),
    readFile(quotaSagaPath, "utf8"),
    readFile(quotaOperationRoutePath, "utf8"),
  ]);
  const byId = functionBody(
    storeSource,
    "export async function findQuotaOperationById(",
    "export async function findQuotaOperationByIdempotencyKey(",
  );
  const byIdempotency = functionBody(
    storeSource,
    "export async function findQuotaOperationByIdempotencyKey(",
    "export async function updateQuotaOperation(",
  );
  const list = functionBody(
    storeSource,
    "export async function listQuotaOperations(",
    "export async function appendQuotaLedgerEntry(",
  );
  const takeStart = sagaSource.indexOf("export async function takeQuotaOperationCredential(");
  assert.notEqual(takeStart, -1);
  const take = sagaSource.slice(takeStart);

  assert.match(byId, /findPostgresQuotaOperationById\(operationId\)/);
  assert.match(byIdempotency, /findPostgresQuotaOperationByIdempotencyKey\(idempotencyKey\)/);
  assert.match(list, /listPostgresQuotaOperations\(input\)/);
  assert.ok(
    take.indexOf("const candidate = await findQuotaOperationById(operationId)") <
      take.indexOf("return withUserQuotaOperationLock"),
  );
  assert.match(take, /candidate\.state !== "completed"/);
  assert.match(routeSource, /const credentialReady =/);
  assert.match(routeSource, /credentialReady\s*\? await takeQuotaOperationCredential/);
});

test("quota operation transitions use one locked Postgres transaction and reuse the claimed row", async () => {
  const [postgresSource, storeSource, sagaSource] = await Promise.all([
    readFile(postgresStorePath, "utf8"),
    readFile(storePath, "utf8"),
    readFile(quotaSagaPath, "utf8"),
  ]);
  const postgresTransition = functionBody(
    postgresSource,
    "export async function transitionPostgresQuotaOperation(",
    "export async function claimPostgresQuotaOperationExecution(",
  );
  const storeTransition = functionBody(
    storeSource,
    "export async function transitionQuotaOperation(",
    "export async function reserveQuotaOperationDepartmentBudget(",
  );
  const runner = functionBody(
    sagaSource,
    "async function runQuotaOperationInner(",
    "export async function runQuotaOperation(",
  );

  assert.match(postgresTransition, /return withControlTransaction/);
  assert.equal(postgresTransition.match(/select data from quota_operations/g)?.length, 1);
  assert.match(postgresTransition, /for update/);
  assert.match(postgresTransition, /assertQuotaOperationTransition\(operation\.state, state\)/);
  assert.match(postgresTransition, /saveQuotaOperationRow\(client, updated\)/);
  assert.match(storeTransition, /if \(isPostgresBackend\(\)\)/);
  assert.match(storeTransition, /return transitionPostgresQuotaOperation\(operationId, state, patch\)/);
  assert.match(runner, /let operation = claimed/);
  assert.doesNotMatch(runner, /operation = \(await findQuotaOperationById\(operationId\)\)/);
});

test("quota control work uses a dedicated bounded pool while proxy admission stays on the business pool", async () => {
  const source = await readFile(postgresStorePath, "utf8");
  const controlPool = functionBody(source, "function getControlPool()", "function getAdvisoryLockPool()");
  const proxyAdmission = functionBody(
    source,
    "export async function beginPostgresQuotaAwareProxyRequest",
    "export async function updatePostgresProxyLog",
  );

  assert.match(controlPool, /max: config\.postgres\.controlPoolMax/);
  assert.match(controlPool, /connectionTimeoutMillis/);
  for (const [startMarker, endMarker] of [
    ["export async function findPostgresQuotaOperationById(", "export async function findPostgresQuotaOperationByIdempotencyKey("],
    ["export async function createPostgresQuotaOperation(", "export async function createPostgresMonthlyOpenOperations("],
    ["export async function updatePostgresQuotaOperation(", "export async function transitionPostgresQuotaOperation("],
    ["export async function transitionPostgresQuotaOperation(", "export async function claimPostgresQuotaOperationExecution("],
    ["export async function claimPostgresQuotaOperationExecution(", "export async function renewPostgresQuotaOperationExecution("],
    ["export async function renewPostgresQuotaOperationExecution(", "export async function releasePostgresQuotaOperationExecution("],
    ["export async function releasePostgresQuotaOperationExecution(", "export async function insertPostgresQuotaLedgerEntry("],
    ["export async function reservePostgresQuotaOperationDepartmentBudget(", "async function upsertPostgresNewApiUsageRecordWithClient("],
  ]) {
    assert.match(functionBody(source, startMarker, endMarker), /withControl(?:Client|Transaction)/);
  }
  assert.match(proxyAdmission, /withTransaction<ProxyRequestAdmissionResult/);
  assert.doesNotMatch(proxyAdmission, /withControl/);
  for (const [startMarker, endMarker] of [
    ["export async function replacePostgresActiveTokenAccount", "export async function finalizePostgresTokenRotation"],
    ["export async function recordPostgresMonthlyResetApplied", "export async function upsertPostgresFeishuEvent"],
    ["export async function updatePostgresUserAccessStatus", "export async function revokePostgresAdminScopesForUser"],
    ["export async function enablePostgresUserAccess", "export async function insertPostgresProxyLog"],
    ["export async function settlePostgresMatchedNewApiUsage(", "export async function upsertPostgresUsageSyncIssue("],
    ["export async function upsertPostgresUsageSyncIssue(", "export async function upsertPostgresUsageSyncCheckpoint("],
  ]) {
    const body = functionBody(source, startMarker, endMarker);
    assert.match(body, /withTransaction/);
    assert.doesNotMatch(body, /withControl/);
  }
});

test("quota restore and key rotation isolate their targeted Postgres work from the business pool", async () => {
  const [postgresSource, storeSource, sagaSource, guardSource, decisionSource, resetSource] =
    await Promise.all([
      readFile(postgresStorePath, "utf8"),
      readFile(storePath, "utf8"),
      readFile(quotaSagaPath, "utf8"),
      readFile(quotaGuardPath, "utf8"),
      readFile(quotaDecisionRoutePath, "utf8"),
      readFile(keyResetRoutePath, "utf8"),
    ]);

  for (const [startMarker, endMarker] of [
    [
      "export async function reconcilePostgresBillingPeriodForQuotaOperation(",
      "async function rebuildPostgresDepartmentQuotaMaterializedSnapshotWithClient(",
    ],
    [
      "export async function rebuildPostgresDepartmentQuotaMaterializedSnapshotForQuotaOperation(",
      "export async function rebuildPostgresQuotaMaterializedUsers(",
    ],
    [
      "export async function listPostgresInflightProxyRequestsForQuotaOperation(",
      "export async function getPostgresUserQuotaState(",
    ],
    [
      "export async function transitionPostgresTokenRequestForQuotaOperation(",
      "export async function upsertPostgresUserBillingPeriod(",
    ],
    [
      "export async function updatePostgresTokenAccountForQuotaOperation(",
      "export async function replacePostgresActiveTokenAccount(",
    ],
    [
      "export async function finalizePostgresTokenRotationForQuotaOperation(",
      "export async function finalizePostgresTokenProvision(",
    ],
    [
      "export async function getPostgresAppSettingsForQuotaOperation(",
      "export async function readPostgresUsageMatchingSnapshot(",
    ],
  ]) {
    const body = functionBody(postgresSource, startMarker, endMarker);
    assert.match(body, /withControl(?:Client|Transaction)/, `${startMarker} must use control`);
  }

  for (const [startMarker, endMarker] of [
    [
      "export async function reconcilePostgresBillingPeriodForUser(",
      "export async function reconcilePostgresBillingPeriodForQuotaOperation(",
    ],
    [
      "export async function rebuildPostgresDepartmentQuotaMaterializedSnapshot(",
      "export async function rebuildPostgresDepartmentQuotaMaterializedSnapshotForQuotaOperation(",
    ],
    [
      "export async function listPostgresInflightProxyRequests(",
      "export async function listPostgresInflightProxyRequestsForQuotaOperation(",
    ],
    [
      "export async function transitionPostgresTokenRequest(",
      "export async function transitionPostgresTokenRequestForQuotaOperation(",
    ],
    [
      "export async function updatePostgresTokenAccount(",
      "export async function updatePostgresTokenAccountForQuotaOperation(",
    ],
    [
      "export async function finalizePostgresTokenRotation(",
      "export async function finalizePostgresTokenRotationForQuotaOperation(",
    ],
    [
      "export async function getPostgresAppSettings()",
      "export async function getPostgresAppSettingsForQuotaOperation()",
    ],
  ]) {
    const body = functionBody(postgresSource, startMarker, endMarker);
    assert.match(body, /with(?:Client|Transaction)/, `${startMarker} must keep business`);
    assert.doesNotMatch(body, /withControl/, `${startMarker} must not move globally to control`);
  }

  const sagaRouting = functionBody(
    sagaSource,
    "function usesIsolatedQuotaControlPool(",
    "async function clearCommittedDepartmentReservation(",
  );
  assert.match(
    sagaRouting,
    /operation\.operationType === "quota_restore" \|\| operation\.operationType === "key_rotation"/,
  );
  for (const explicitPath of [
    "updateTokenAccountForQuotaOperation",
    "updateTokenRequestForQuotaOperation",
    "listInflightProxyRequestsForQuotaOperation",
    "rebuildUserQuotaMaterializedSnapshotForQuotaOperation",
  ]) {
    assert.match(sagaRouting, new RegExp(explicitPath));
  }
  assert.match(sagaSource, /finalizeTokenRotationForQuotaOperation\(/);
  assert.doesNotMatch(sagaSource, /\bfinalizeTokenRotation\(/);

  const scopedRequest = functionBody(
    storeSource,
    "export async function getScopedTokenRequest(",
    "export async function getScopedUser(",
  );
  const scopedPostgresBranch = scopedRequest.slice(0, scopedRequest.indexOf("const store = await readStore();"));
  assert.match(scopedPostgresBranch, /getPostgresTokenRequestById/);
  assert.match(scopedPostgresBranch, /getPostgresUserById/);
  assert.match(scopedPostgresBranch, /getPostgresActiveAdminScopeForUser/);
  assert.doesNotMatch(scopedPostgresBranch, /readStore\(/);

  const grantQuota = functionBody(
    storeSource,
    "export async function getEffectiveUserGrantQuota(",
    "export async function assertFirstProvisionDepartmentCapacity(",
  );
  const grantPostgresBranch = grantQuota.slice(0, grantQuota.indexOf("const store = await readStore();"));
  assert.match(grantPostgresBranch, /getPostgresUserById/);
  assert.match(grantPostgresBranch, /getPostgresUserBillingPeriod/);
  assert.match(grantPostgresBranch, /if \(billing\) return billing\.monthlyQuota/);
  assert.ok(
    grantPostgresBranch.indexOf("getPostgresUserBillingPeriod") <
      grantPostgresBranch.indexOf("getPostgresUserById"),
  );
  assert.doesNotMatch(grantPostgresBranch, /Promise\.all/);
  assert.match(grantPostgresBranch, /getAppSettingsForQuotaOperation/);
  assert.match(grantPostgresBranch, /ensureDepartmentQuotaPeriod/);
  assert.doesNotMatch(grantPostgresBranch, /readStore\(/);

  assert.match(
    guardSource,
    /action === "quota_restore" \|\| action === "key_rotation"[\s\S]*getAppSettingsForQuotaOperation/,
  );
  const workerFlags = functionBody(
    guardSource,
    "export async function getQuotaFeatureFlags()",
    "export async function assertQuotaWriteActionEnabled(",
  );
  assert.match(workerFlags, /getAppSettingsForQuotaOperation\(\)/);
  assert.doesNotMatch(workerFlags, /\bgetAppSettings\(\)/);
  assert.match(decisionSource, /const updateDecisionRequest =/);
  assert.match(decisionSource, /updateTokenRequestForQuotaOperation\(approved\.id/);
  assert.match(resetSource, /updateTokenRequestForQuotaOperation\(tokenRequest\.id/);
});

test("quota operation materialization avoids control-pool amplification and redundant key snapshots", async () => {
  const [postgresSource, storeSource, sagaSource, singleFlightSource] = await Promise.all([
    readFile(postgresStorePath, "utf8"),
    readFile(storePath, "utf8"),
    readFile(quotaSagaPath, "utf8"),
    readFile(rerunSingleFlightPath, "utf8"),
  ]);
  const lightweightInsert = functionBody(
    postgresSource,
    "export async function insertPostgresTokenAccountForQuotaOperation(",
    "async function updatePostgresTokenAccountWithClient(",
  );
  const quotaMaterialization = functionBody(
    storeSource,
    "const rebuildQuotaOperationDepartmentMaterializedSnapshot =",
    "export async function refreshUserBillingTokenMetadataForQuotaOperation(",
  );
  const userQuotaMaterialization = functionBody(
    storeSource,
    "export async function rebuildUserQuotaMaterializedSnapshotForQuotaOperation(",
    "export async function refreshUserBillingTokenMetadataForQuotaOperation(",
  );
  const keyRotation = functionBody(
    sagaSource,
    "async function handleKeyRotation(",
    "async function handleMonthlyOpen(",
  );

  assert.match(lightweightInsert, /withControlTransaction/);
  assert.match(lightweightInsert, /saveTokenAccountRow\(client, account\)/);
  assert.doesNotMatch(lightweightInsert, /syncPostgresBillingPeriodForUser/);
  assert.match(quotaMaterialization, /createRerunSingleFlight/);
  assert.match(singleFlightSource, /existing\.rerun = true/);
  assert.match(singleFlightSource, /if \(entry\.rerun\) continue/);
  assert.ok(
    singleFlightSource.indexOf("entries.delete(key)") <
      singleFlightSource.indexOf("return result"),
  );
  assert.doesNotMatch(userQuotaMaterialization, /Promise\.all/);
  assert.ok(
    userQuotaMaterialization.indexOf("reconcilePostgresBillingPeriodForQuotaOperation") <
      userQuotaMaterialization.indexOf("rebuildQuotaOperationDepartmentMaterializedSnapshot"),
  );
  assert.match(keyRotation, /addTokenAccountForQuotaOperation\(/);
  assert.match(keyRotation, /materializedPreDrainSnapshot = true/);
  assert.match(keyRotation, /refreshUserBillingTokenMetadataForQuotaOperation\(/);
  assert.match(keyRotation, /if \(!refreshed\) await rebuildOperationQuotaSnapshot\(current\)/);
});

test("authoritative usage settlement closes transient no-proxy-match issues without a reopen race", async () => {
  const [postgresSource, storeSource] = await Promise.all([
    readFile(postgresStorePath, "utf8"),
    readFile(storePath, "utf8"),
  ]);
  const closeIssues = functionBody(
    postgresSource,
    "async function closePostgresResolvedNoProxyMatchIssues(",
    "export async function settlePostgresMatchedNewApiUsage(",
  );
  const settlement = functionBody(
    postgresSource,
    "export async function settlePostgresMatchedNewApiUsage(",
    "export async function upsertPostgresUsageSyncIssue(",
  );
  const issueUpsert = functionBody(
    postgresSource,
    "export async function upsertPostgresUsageSyncIssue(",
    "export async function upsertPostgresUsageSyncCheckpoint(",
  );

  assert.match(closeIssues, /issue_type = 'no_proxy_match'/);
  assert.match(closeIssues, /status = 'open'/);
  assert.match(closeIssues, /sameNewApiUsageSource\(row\.data, record\)/);
  assert.match(closeIssues, /status: "closed"/);
  assert.match(closeIssues, /closedAt: syncedAt/);
  assert.match(settlement, /closePostgresResolvedNoProxyMatchIssues/);
  assert.match(issueUpsert, /newApiUsageIdentityLockKeys\(issue\)/);
  assert.match(issueUpsert, /from newapi_usage_records/);
  assert.match(issueUpsert, /status: resolved \? "closed" : "open"/);
  assert.match(storeSource, /closeResolvedNoProxyMatchIssuesInStore/);
  assert.match(storeSource, /settlementLagMinutes: 1/);
});

test("quota saga budget reservation and materialization stay scoped to one department and user", async () => {
  const [postgresSource, storeSource, sagaSource] = await Promise.all([
    readFile(postgresStorePath, "utf8"),
    readFile(storePath, "utf8"),
    readFile(quotaSagaPath, "utf8"),
  ]);
  const reserve = functionBody(
    postgresSource,
    "export async function reservePostgresQuotaOperationDepartmentBudget(",
    "async function upsertPostgresNewApiUsageRecordWithClient(",
  );
  const createOperation = functionBody(
    postgresSource,
    "export async function createPostgresQuotaOperation(",
    "export async function createPostgresMonthlyOpenOperations(",
  );
  const createMonthlyOpen = functionBody(
    postgresSource,
    "export async function createPostgresMonthlyOpenOperations(",
    "export async function updatePostgresQuotaOperation(",
  );
  const departmentMaterializer = functionBody(
    postgresSource,
    "async function rebuildPostgresDepartmentQuotaMaterializedSnapshotWithClient(",
    "export async function rebuildPostgresDepartmentQuotaMaterializedSnapshot(",
  );
  const targetedStoreMaterializer = functionBody(
    storeSource,
    "export async function rebuildUserQuotaMaterializedSnapshot(",
    "async function persistDepartmentQuotaPeriod(",
  );

  assert.match(reserve, /pg_try_advisory_xact_lock/);
  assert.doesNotMatch(reserve, /select pg_advisory_xact_lock/i);
  assert.ok(
    reserve.indexOf("for (let attempt") < reserve.indexOf("withControlTransaction"),
    "department budget retries must start outside the transaction",
  );
  assert.match(reserve, /if \(!lockResult\.rows\[0\]\?\.locked\) return null/);
  assert.match(reserve, /throw new QuotaOperationBusyError\(\)/);
  assert.match(reserve, /from quota_ledger_entries/);
  assert.match(reserve, /from quota_operations/);
  assert.ok(
    reserve.indexOf("pg_try_advisory_xact_lock") <
      reserve.indexOf("from quota_ledger_entries") &&
      reserve.indexOf("from quota_ledger_entries") <
        reserve.indexOf("saveQuotaOperationRow"),
    "the lock, aggregate checks, and state transition must share one transaction attempt",
  );
  assert.doesNotMatch(reserve, /readPostgresStore|withPostgresAdvisoryLock/);
  assert.match(createOperation, /user-quota:/);
  assert.doesNotMatch(createOperation, /department-quota:/);
  assert.ok(
    createMonthlyOpen.indexOf("department-quota:") <
      createMonthlyOpen.indexOf("user-quota:"),
    "monthly open must preserve department-before-user lock ordering",
  );
  assert.match(createMonthlyOpen, /reservedDepartmentQuota: input\.assignedMonthlyQuota/);
  assert.match(createMonthlyOpen, /state: "budget_reserved"/);
  assert.match(departmentMaterializer, /pg_advisory_xact_lock/);
  assert.match(departmentMaterializer, /materializeDepartmentQuota/);
  assert.match(targetedStoreMaterializer, /reconcilePostgresBillingPeriodForUser/);
  assert.match(targetedStoreMaterializer, /rebuildPostgresDepartmentQuotaMaterializedSnapshot/);
  assert.doesNotMatch(sagaSource, /rebuildQuotaMaterializedSnapshots/);
  assert.match(
    sagaSource,
    /operation\.operationType === "key_rotation" \? undefined : operation\.departmentId/,
  );
  assert.match(sagaSource, /clearCommittedDepartmentReservation\(current\)[\s\S]*rebuildOperationQuotaSnapshot\(current\)/);
});

test("Postgres inflight proxy lookup reads status from the JSON payload", async () => {
  const postgresSource = await readFile(postgresStorePath, "utf8");
  const lookup = functionBody(
    postgresSource,
    "async function listPostgresInflightProxyRequestsWithClient(",
    "export async function listPostgresInflightProxyRequests(",
  );
  assert.match(lookup, /data->>'status' in \('pending', 'streaming'\)/);
  assert.doesNotMatch(lookup, /\band status in \('pending', 'streaming'\)/);
});

test("proxy response persistence is observed before a long stream can outlive it", async () => {
  const routeSource = await readFile(proxyRoutePath, "utf8");
  const responseLifecycle = functionBody(
    routeSource,
    "const upstreamPersistence = withProxyPersistenceSlot(",
    "if (upstreamIsStream && upstream.body)",
  );

  assert.match(responseLifecycle, /"acceptance",/);
  assert.match(responseLifecycle, /updateProxyLogReliably\(proxyLog\.id/);
  assert.match(responseLifecycle, /void upstreamPersistence\.catch\(\(error\) =>/);
  assert.match(responseLifecycle, /tokeninside\.proxy\.upstream_persistence_failed/);
});

test("proxy lease heartbeats share the bounded lifecycle persistence gate", async () => {
  const routeSource = await readFile(proxyRoutePath, "utf8");
  const heartbeatLifecycle = functionBody(
    routeSource,
    "function startProxyLeaseHeartbeat(logId: string)",
    "function redactSensitiveText(value: string)",
  );

  assert.match(heartbeatLifecycle, /withProxyPersistenceSlot\("terminal", async \(\) =>/);
  assert.match(heartbeatLifecycle, /if \(stopped\) return;/);
  assert.match(heartbeatLifecycle, /await updateProxyLog\(logId/);
});

test("proxy body read failures release the outer concurrency slot", async () => {
  const routeSource = await readFile(proxyRoutePath, "utf8");
  const bodyReadLifecycle = functionBody(
    routeSource,
    "let body: ArrayBuffer | undefined",
    "const requestBody = parseJsonBody",
  );

  assert.match(bodyReadLifecycle, /try \{[\s\S]*await request\.arrayBuffer\(\)/);
  assert.match(bodyReadLifecycle, /catch \(error\) \{/);
  assert.match(bodyReadLifecycle, /releaseUpstreamSlot\?\.\(\)/);
  assert.match(bodyReadLifecycle, /releaseUpstreamSlot = undefined/);
  assert.match(bodyReadLifecycle, /code: aborted \? "client_cancelled" : "invalid_request_body"/);
});

test("proxy stream cancellation claims the terminal state before cancelling its reader", async () => {
  const routeSource = await readFile(proxyRoutePath, "utf8");
  const streamLifecycle = functionBody(
    routeSource,
    "function streamWithProxyLog",
    "async function readResponseBody",
  );
  const cancelLifecycle = functionBody(
    streamLifecycle,
    "async cancel(reason)",
    "    },\n  });",
  );

  assert.match(streamLifecycle, /let clientCancelled = false/);
  assert.match(streamLifecycle, /const result = await reader\.read\(\);\s*if \(clientCancelled\) return;/);
  assert.match(streamLifecycle, /catch \(err\) \{\s*if \(clientCancelled\) return;/);
  assert.ok(
    cancelLifecycle.indexOf("clientCancelled = true") <
      cancelLifecycle.indexOf("persistTerminal({") &&
      cancelLifecycle.indexOf("persistTerminal({") <
        cancelLifecycle.indexOf("await reader.cancel(reason)"),
    "cancellation must synchronously claim the terminal state before reader.cancel can resolve a pending pull",
  );
  assert.match(cancelLifecycle, /terminalStatus: "cancelled"/);
  assert.match(cancelLifecycle, /clientDeliveryStatus: "cancelled"/);
  assert.match(cancelLifecycle, /statusCode: 499/);
});

test("proxy stream read aborts are classified as client cancellation", async () => {
  const routeSource = await readFile(proxyRoutePath, "utf8");
  const streamLifecycle = functionBody(
    routeSource,
    "function streamWithProxyLog(input:",
    "async function readResponseBody(upstream: Response)",
  );

  assert.match(streamLifecycle, /signal: AbortSignal;/);
  assert.match(streamLifecycle, /const cancelled = input\.signal\.aborted/);
  assert.match(streamLifecycle, /err instanceof DOMException && err\.name === "AbortError"/);
  assert.match(streamLifecycle, /status: cancelled \? "cancelled" : "failed"/);
  assert.match(streamLifecycle, /statusCode: cancelled \? 499/);
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

async function rollbackAndRelease(client: PoolClient) {
  try {
    await client.query("rollback");
  } finally {
    client.release();
  }
}

test(
  "a dedicated control pool progresses while the business pool is fully checked out",
  { skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const businessPool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
    const controlPool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
    const heldBusinessClient = await businessPool.connect();
    let queuedBusinessCompleted = false;
    const queuedBusiness = businessPool.query<{ value: number }>("select 1 as value").then((result) => {
      queuedBusinessCompleted = true;
      return result;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(queuedBusinessCompleted, false);

      const controlResult = await Promise.race([
        controlPool.query<{ value: number }>("select 1 as value"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("control pool did not progress independently")), 1_000),
        ),
      ]);
      assert.equal(controlResult.rows[0]?.value, 1);
      assert.equal(queuedBusinessCompleted, false);
    } finally {
      heldBusinessClient.release();
      await queuedBusiness;
      await Promise.all([businessPool.end(), controlPool.end()]);
    }
  },
);

test(
  "quota-operation token insert skips billing sync and metadata refresh stays lightweight",
  { skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const pool = new Pool({ connectionString: testDatabaseUrl, max: 2 });
    const suffix = `${process.pid}_${Date.now()}`;
    const userId = `test_fast_insert_user_${suffix}`;
    const period = "2099-01";
    const billingId = `test_fast_insert_billing_${suffix}`;
    const accountId = `test_fast_insert_account_${suffix}`;
    const now = new Date().toISOString();
    const initialBilling = {
      id: billingId,
      feishuUserId: userId,
      period,
      monthlyQuota: 200,
      quotaConsumed: 17,
      cost: 17,
      remainingQuota: 183,
      promptTokens: 11,
      completionTokens: 6,
      totalTokens: 17,
      proxyLogCount: 1,
      usageRecordCount: 1,
      tokenAccountIds: [],
      updatedAt: now,
      sourceVersion: "sentinel",
    };
    try {
      await pool.query(
        `insert into user_billing_periods (id, feishu_user_id, period, data, updated_at)
         values ($1, $2, $3, $4, $5)`,
        [billingId, userId, period, initialBilling, now],
      );
      const account = {
        id: accountId,
        feishuUserId: userId,
        tokenRequestId: `test_fast_insert_request_${suffix}`,
        newapiTokenId: `test_fast_insert_upstream_${suffix}`,
        keyHash: `test_fast_insert_hash_${suffix}`,
        status: "active",
        billingPeriod: period,
        operationGeneration: 1,
        activatedAt: now,
        createdAt: now,
      };
      await pool.query(
        `insert into token_accounts
          (id, feishu_user_id, token_request_id, newapi_token_id, key_hash,
           status, billing_period, operation_generation, activated_at, data, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          account.id,
          account.feishuUserId,
          account.tokenRequestId,
          account.newapiTokenId,
          account.keyHash,
          account.status,
          account.billingPeriod,
          account.operationGeneration,
          account.activatedAt,
          account,
          account.createdAt,
        ],
      );

      const unchanged = await pool.query<{ data: typeof initialBilling }>(
        "select data from user_billing_periods where id = $1",
        [billingId],
      );
      assert.deepEqual(unchanged.rows[0]?.data, initialBilling);
    } finally {
      await pool.query("delete from token_accounts where id = $1", [accountId]).catch(() => undefined);
      await pool
        .query("delete from user_billing_periods where id = $1", [billingId])
        .catch(() => undefined);
      await pool.end();
    }
  },
);

test(
  "concurrent department materialization reruns after a later committed ledger entry",
  { skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const pool = new Pool({ connectionString: testDatabaseUrl, max: 4 });
    const materializerPool = new Pool({ connectionString: testDatabaseUrl, max: 2 });
    const locker = await pool.connect();
    const suffix = `${process.pid}_${Date.now()}`;
    const userId = `test_mat_user_${suffix}`;
    const departmentId = `test_mat_department_${suffix}`;
    const departmentRowId = `test_mat_department_row_${suffix}`;
    const operationId = `test_mat_operation_${suffix}`;
    const ledgerId = `test_mat_ledger_${suffix}`;
    const period = "2099-02";
    const signedQuota = 12_345;
    const now = new Date().toISOString();
    let lockHeld = false;
    try {
      await pool.query(
        `insert into department_quota_periods
          (id, department_id, period, data, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $5)`,
        [
          departmentRowId,
          departmentId,
          period,
          {
            id: departmentRowId,
            departmentId,
            departmentName: "concurrency test",
            period,
            quotaLimit: 1_000_000,
            defaultGrantQuota: 200,
            createdAt: now,
            updatedAt: now,
          },
          now,
        ],
      );
      await locker.query("begin");
      await locker.query("lock table quota_operations in access exclusive mode");
      lockHeld = true;

      const rebuild = createRerunSingleFlight(
        (input: { departmentId: string; period: string }) =>
          `${input.departmentId}\u0000${input.period}`,
        async (input) => {
          const client = await materializerPool.connect();
          try {
            await client.query("begin");
            await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
              `department-quota:${input.departmentId}:${input.period}`,
            ]);
            const existing = await client.query<{ data: Record<string, unknown> }>(
              `select data from department_quota_periods
               where department_id = $1 and period = $2
               for update`,
              [input.departmentId, input.period],
            );
            const committed = await client.query<{ quota: string }>(
              `select coalesce(sum(signed_quota), 0)::text as quota
               from quota_ledger_entries
               where department_id = $1 and period = $2`,
              [input.departmentId, input.period],
            );
            // The test holds an ACCESS EXCLUSIVE lock here so a later caller
            // can commit its ledger after the first committed-sum read.
            await client.query(
              `select coalesce(sum(greatest(coalesce((data->>'reservedDepartmentQuota')::bigint, 0), 0)), 0)
               from quota_operations
               where department_id = $1 and billing_period = $2`,
              [input.departmentId, input.period],
            );
            const data = {
              ...(existing.rows[0]?.data ?? {}),
              committedAuthorizedQuota: Number(committed.rows[0]?.quota ?? 0),
            };
            await client.query(
              `update department_quota_periods set data = $3
               where department_id = $1 and period = $2`,
              [input.departmentId, input.period, data],
            );
            await client.query("commit");
            return data;
          } catch (error) {
            await client.query("rollback").catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
        },
      );
      const first = rebuild({ departmentId, period });
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activity = await pool.query<{ count: string }>(
          `select count(*)::text as count
           from pg_stat_activity
           where pid <> pg_backend_pid()
             and wait_event_type = 'Lock'
             and query ilike '%from quota_operations%'`,
        );
        if (Number(activity.rows[0]?.count ?? 0) > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, "first materializer did not reach the forced mid-query lock");

      await pool.query(
        `insert into quota_ledger_entries
          (id, operation_id, feishu_user_id, department_id, period, entry_type,
           signed_quota, data, created_at)
         values ($1, $2, $3, $4, $5, 'quota_restore_grant', $6, $7, $8)`,
        [
          ledgerId,
          operationId,
          userId,
          departmentId,
          period,
          signedQuota,
          {
            id: ledgerId,
            operationId,
            feishuUserId: userId,
            departmentId,
            period,
            signedQuota,
            entryType: "quota_restore_grant",
            sourceType: "quota_operation",
            sourceId: operationId,
            quotaPerUnitSnapshot: 500_000,
            createdAt: now,
          },
          now,
        ],
      );
      const second = rebuild({ departmentId, period });
      assert.strictEqual(second, first);
      await locker.query("commit");
      lockHeld = false;

      const [firstResult, secondResult] = await Promise.all([first, second]);
      assert.equal(firstResult.committedAuthorizedQuota, signedQuota);
      assert.equal(secondResult.committedAuthorizedQuota, signedQuota);
      const stored = await pool.query<{ committed: string | null }>(
        `select data->>'committedAuthorizedQuota' as committed
         from department_quota_periods where id = $1`,
        [departmentRowId],
      );
      assert.equal(Number(stored.rows[0]?.committed), signedQuota);
    } finally {
      if (lockHeld) await locker.query("rollback").catch(() => undefined);
      locker.release();
      const cleanup = await pool.connect();
      try {
        await cleanup.query("begin");
        await cleanup.query("select set_config('tokeninside.allow_ledger_rewrite','on',true)");
        await cleanup.query("delete from quota_ledger_entries where id = $1", [ledgerId]);
        await cleanup.query(
          "delete from user_billing_periods where feishu_user_id = $1 and period = $2",
          [userId, period],
        );
        await cleanup.query("delete from department_quota_periods where id = $1", [
          departmentRowId,
        ]);
        await cleanup.query("commit");
      } catch (error) {
        await cleanup.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        cleanup.release();
        await Promise.all([pool.end(), materializerPool.end()]);
      }
    }
  },
);

test(
  "Postgres shared admissions coexist and remain mutually exclusive with a saga fence",
  { skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const pool = new Pool({ connectionString: testDatabaseUrl, max: 3 });
    const first = await pool.connect();
    const second = await pool.connect();
    const saga = await pool.connect();
    const key = `test:user-quota-fence:${process.pid}:${Date.now()}`;
    try {
      await Promise.all([first.query("begin"), second.query("begin")]);
      const [firstLock, secondLock] = await Promise.all([
        first.query<{ locked: boolean }>(
          "select pg_try_advisory_xact_lock_shared(hashtext($1)::bigint) as locked",
          [key],
        ),
        second.query<{ locked: boolean }>(
          "select pg_try_advisory_xact_lock_shared(hashtext($1)::bigint) as locked",
          [key],
        ),
      ]);
      assert.equal(firstLock.rows[0]?.locked, true);
      assert.equal(secondLock.rows[0]?.locked, true);

      const blockedSaga = await saga.query<{ locked: boolean }>(
        "select pg_try_advisory_lock(hashtext($1)::bigint) as locked",
        [key],
      );
      assert.equal(blockedSaga.rows[0]?.locked, false);

      await Promise.all([first.query("commit"), second.query("commit")]);
      const acquiredSaga = await saga.query<{ locked: boolean }>(
        "select pg_try_advisory_lock(hashtext($1)::bigint) as locked",
        [key],
      );
      assert.equal(acquiredSaga.rows[0]?.locked, true);
      await saga.query("select pg_advisory_unlock(hashtext($1)::bigint)", [key]);
    } finally {
      await Promise.allSettled([
        rollbackAndRelease(first),
        rollbackAndRelease(second),
      ]);
      saga.release();
      await pool.end();
    }
  },
);

test(
  "department budget try-lock retries serialize reservations without overselling",
  { skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const pool = new Pool({ connectionString: testDatabaseUrl, max: 12 });
    const suffix = `${process.pid}-${Date.now()}`;
    const rowId = `test-department-budget-${suffix}`;
    const userId = `test-department-budget-user-${suffix}`;
    const period = "2099-11";
    const lockKey = `department-quota:test-${suffix}:${period}`;
    const retryDelaysMs = [2, 5, 10, 20, 40, 80, 160, 320];

    async function reserveOne(workerIndex: number) {
      for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
        const client = await pool.connect();
        let locked = false;
        try {
          await client.query("begin");
          await client.query("set local lock_timeout = '25ms'");
          const lock = await client.query<{ locked: boolean }>(
            "select pg_try_advisory_xact_lock(hashtext($1)::bigint) as locked",
            [lockKey],
          );
          locked = lock.rows[0]?.locked === true;
          if (locked) {
            await client.query("select pg_sleep(0.01)");
            const current = await client.query<{ data: { budget: number; reserved: number } }>(
              "select data from user_billing_periods where id = $1 for update",
              [rowId],
            );
            const data = current.rows[0]?.data;
            assert.ok(data);
            if (data.reserved >= data.budget) {
              await client.query("commit");
              return false;
            }
            await client.query(
              `update user_billing_periods
               set data = $2::jsonb, updated_at = now()
               where id = $1`,
              [rowId, { ...data, reserved: data.reserved + 1 }],
            );
          }
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
        if (locked) return true;

        const retryDelayMs = retryDelaysMs[attempt];
        if (retryDelayMs === undefined) throw new Error("department budget busy");
        const jitterWindow = Math.max(Math.floor(retryDelayMs / 2), 1);
        const jitterMs = (workerIndex * 7 + attempt * 3) % jitterWindow;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs + jitterMs));
      }
      throw new Error("department budget busy");
    }

    try {
      await pool.query(
        `insert into user_billing_periods (id, feishu_user_id, period, data, updated_at)
         values ($1, $2, $3, $4, now())`,
        [rowId, userId, period, { budget: 5, reserved: 0 }],
      );
      const reservations = await Promise.all(
        Array.from({ length: 10 }, (_, index) => reserveOne(index)),
      );
      assert.equal(reservations.filter(Boolean).length, 5);

      const final = await pool.query<{ data: { budget: number; reserved: number } }>(
        "select data from user_billing_periods where id = $1",
        [rowId],
      );
      assert.deepEqual(final.rows[0]?.data, { budget: 5, reserved: 5 });
    } finally {
      await pool.query("delete from user_billing_periods where id = $1", [rowId]);
      await pool.end();
    }
  },
);

test(
  "billing finalizer and materializer serialize before the materializer rereads the row",
  { skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const pool = new Pool({ connectionString: testDatabaseUrl, max: 3 });
    const finalizer = await pool.connect();
    const materializer = await pool.connect();
    const suffix = `${process.pid}-${Date.now()}`;
    const userId = `test-billing-user-${suffix}`;
    const period = "2099-12";
    const rowId = `test-billing-row-${suffix}`;
    const key = `billing-period-finalize:${userId}:${period}`;
    try {
      await pool.query(
        `insert into user_billing_periods (id, feishu_user_id, period, data, updated_at)
         values ($1, $2, $3, $4, now())`,
        [rowId, userId, period, { legacyTotal: 0, materializedTotal: 0 }],
      );

      await finalizer.query("begin");
      await finalizer.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [key]);
      await materializer.query("begin");
      let materializerAcquired = false;
      const materializerLock = materializer
        .query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [key])
        .then(() => {
          materializerAcquired = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(materializerAcquired, false);

      await finalizer.query(
        `update user_billing_periods
         set data = jsonb_set(data, '{legacyTotal}', '5'::jsonb)
         where feishu_user_id = $1 and period = $2`,
        [userId, period],
      );
      await finalizer.query("commit");
      await materializerLock;

      const reread = await materializer.query<{ data: Record<string, number> }>(
        `select data from user_billing_periods
         where feishu_user_id = $1 and period = $2`,
        [userId, period],
      );
      assert.equal(reread.rows[0]?.data.legacyTotal, 5);
      await materializer.query(
        `update user_billing_periods
         set data = jsonb_set(data, '{materializedTotal}', '9'::jsonb)
         where feishu_user_id = $1 and period = $2`,
        [userId, period],
      );
      await materializer.query("commit");

      const combined = await pool.query<{ data: Record<string, number> }>(
        `select data from user_billing_periods
         where feishu_user_id = $1 and period = $2`,
        [userId, period],
      );
      assert.deepEqual(combined.rows[0]?.data, { legacyTotal: 5, materializedTotal: 9 });
    } finally {
      await Promise.allSettled([
        rollbackAndRelease(finalizer),
        rollbackAndRelease(materializer),
      ]);
      await pool.query("delete from user_billing_periods where id = $1", [rowId]);
      await pool.end();
    }
  },
);
