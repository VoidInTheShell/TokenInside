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
const keyPrewarmPath = new URL("../lib/key-prewarm.ts", import.meta.url);
const rerunSingleFlightPath = new URL("../lib/rerun-single-flight.ts", import.meta.url);
const quotaGuardPath = new URL("../lib/quota-guard.ts", import.meta.url);
const quotaOperationSubmitPath = new URL(
  "../lib/quota-operation-submit.ts",
  import.meta.url,
);
const quotaDecisionRoutePath = new URL(
  "../app/api/admin/token-requests/[id]/decision/route.ts",
  import.meta.url,
);
const keyResetRoutePath = new URL("../app/api/token/reset/route.ts", import.meta.url);
const greenfieldBaselinePath = new URL(
  "../scripts/db-migrate.mjs",
  import.meta.url,
);

function functionBody(source: string, startMarker: string, endMarker: string) {
  const normalizedSource = source.replace(/\r\n/g, "\n");
  const start = normalizedSource.indexOf(startMarker);
  const end = normalizedSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return normalizedSource.slice(start, end);
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
  const claimStart = sagaSource.indexOf("export async function claimQuotaOperationCredential(");
  const acknowledgementStart = sagaSource.indexOf(
    "export async function acknowledgeQuotaOperationCredential(",
  );
  assert.notEqual(claimStart, -1);
  assert.notEqual(acknowledgementStart, -1);
  const claim = sagaSource.slice(claimStart, acknowledgementStart);

  assert.match(byId, /findPostgresQuotaOperationById\(operationId\)/);
  assert.match(byIdempotency, /findPostgresQuotaOperationByIdempotencyKey\(idempotencyKey\)/);
  assert.match(list, /listPostgresQuotaOperations\(input\)/);
  assert.ok(
    claim.indexOf("const candidate = await findQuotaOperationById(operationId)") <
      claim.indexOf("return withUserQuotaOperationLock"),
  );
  assert.match(claim, /candidate\.state !== "completed"/);
  assert.doesNotMatch(claim, /credentialCiphertext: undefined/);
  assert.match(routeSource, /const credentialReady =/);
  assert.match(routeSource, /credentialReady\s*\? await claimQuotaOperationCredential/);
  assert.match(routeSource, /acknowledgeQuotaOperationCredential/);
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
  const claimedRunner = functionBody(
    sagaSource,
    "async function runClaimedQuotaOperation(",
    "async function runQuotaOperationInner(",
  );

  assert.match(postgresTransition, /return withControlTransaction/);
  assert.equal(postgresTransition.match(/select data from quota_operations/g)?.length, 1);
  assert.match(postgresTransition, /for update/);
  assert.match(postgresTransition, /assertQuotaOperationTransition\(operation\.state, state\)/);
  assert.match(postgresTransition, /saveQuotaOperationRow\(client, updated\)/);
  assert.match(storeTransition, /if \(isPostgresBackend\(\)\)/);
  assert.match(storeTransition, /return transitionPostgresQuotaOperation\(operationId, state, patch\)/);
  assert.match(claimedRunner, /let operation = claimed/);
  assert.doesNotMatch(
    claimedRunner,
    /operation = \(await findQuotaOperationById\(operationId\)\)/,
  );
  assert.ok(
    runner.indexOf("findQuotaOperationById(operationId)") <
      runner.indexOf("withUserQuotaOperationLock"),
  );
  assert.ok(
    runner.indexOf("withUserQuotaOperationLock") <
      runner.indexOf("runClaimedQuotaOperation(operationId, executionFence)"),
  );
  assert.match(runner, /wait: options\.waitForFence \?\? true/);
  assert.match(claimedRunner, /executionFence\?\.assertHeld\(\)/);
  assert.match(claimedRunner, /executionFence\?\.markLost/);
  assert.match(claimedRunner, /isQuotaExecutionFenceLostError/);
});

test("the due worker uses a non-blocking user fence", async () => {
  const sagaSource = await readFile(quotaSagaPath, "utf8");
  const dueRunner = functionBody(
    sagaSource,
    "export async function runDueQuotaOperations(",
    "function scheduleQuotaWorker(",
  );
  assert.match(
    dueRunner,
    /runQuotaOperation\(operation\.id, \{ waitForFence: false \}\)/,
  );
});

test("the complete Saga fence does not recursively acquire the prewarm user lock", async () => {
  const [sagaSource, prewarmSource] = await Promise.all([
    readFile(quotaSagaPath, "utf8"),
    readFile(keyPrewarmPath, "utf8"),
  ]);
  const internalClaim = functionBody(
    prewarmSource,
    "export async function claimPrewarmedTokenForProvisionUnderUserFence(",
    "export async function claimPrewarmedTokenForProvision(",
  );
  const publicClaim = functionBody(
    prewarmSource,
    "export async function claimPrewarmedTokenForProvision(",
    "export async function clearClaimedPrewarmedCredential(",
  );

  assert.doesNotMatch(internalClaim, /withUserQuotaOperationLock/);
  assert.match(publicClaim, /withUserQuotaOperationLock/);
  assert.match(publicClaim, /claimPrewarmedTokenForProvisionUnderUserFence/);
  assert.match(sagaSource, /claimPrewarmedTokenForProvisionUnderUserFence\(\{/);
  assert.doesNotMatch(sagaSource, /claimPrewarmedTokenForProvision\(\{/);
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
    ["export async function updatePostgresUserAccessStatus", "export async function updatePostgresUserAccessStatusUnderUserFence"],
    ["export async function enablePostgresUserAccess", "export async function enablePostgresUserAccessUnderUserFence"],
  ]) {
    const body = functionBody(source, startMarker, endMarker);
    assert.match(body, /withTransaction/);
    assert.doesNotMatch(body, /withControl/);
  }
});

test("all PostgreSQL lanes share one versioned process-wide registry across Next chunks", async () => {
  const source = await readFile(postgresStorePath, "utf8");
  const registry = functionBody(
    source,
    "const POSTGRES_POOL_REGISTRY_VERSION = 1;",
    "export const REQUIRED_POSTGRES_TABLES",
  );

  assert.match(registry, /__tokenInsidePostgresPoolRegistry/);
  assert.match(registry, /globalThis as PostgresPoolGlobal/);
  assert.match(registry, /existing\.version !== POSTGRES_POOL_REGISTRY_VERSION/);
  assert.match(registry, /configFingerprint/);
  assert.match(registry, /PostgreSQL pool configuration changed at runtime/);
  assert.match(registry, /poolRuntimeSnapshot\(registry\.business\)/);
  assert.match(registry, /poolRuntimeSnapshot\(registry\.settlement\)/);
  assert.doesNotMatch(source, /let (?:pool|settlementPool|controlPool|advisoryLockPool): Pool/);
  for (const lane of ["business", "settlement", "control", "advisoryLock"]) {
    assert.match(source, new RegExp(`registry\\.${lane} = new Pool`));
  }
});

test("authoritative settlement uses a dedicated bounded pool instead of the proxy business pool", async () => {
  const source = await readFile(postgresStorePath, "utf8");
  const settlementPool = functionBody(
    source,
    "function getSettlementPool()",
    "function getAdvisoryLockPool()",
  );
  assert.match(settlementPool, /max: config\.postgres\.settlementPoolMax/);
  assert.match(settlementPool, /connectionTimeoutMillis/);

  for (const [startMarker, endMarker, expected] of [
    [
      "export async function readPostgresUsageMatchingSnapshot(",
      "export async function getPostgresUserById(",
      /withSettlementClient/,
    ],
    [
      "export async function settlePostgresMatchedNewApiUsage(",
      "async function upsertPostgresUsageSyncIssueWithClient(",
      /withSettlementTransaction/,
    ],
    [
      "export async function upsertPostgresUsageSyncIssue(",
      "async function loadPostgresUsageSettlementBatchState(",
      /withSettlementTransaction/,
    ],
    [
      "export async function withPostgresUsageSettlementBatch<",
      "export async function upsertPostgresUsageSyncCheckpoint(",
      /withSettlementTransaction/,
    ],
    [
      "export async function upsertPostgresUsageSyncCheckpoint(",
      "export async function withPostgresAdvisoryLock<",
      /withSettlementTransaction/,
    ],
    [
      "export async function reconcilePostgresBillingPeriodForUser(",
      "export async function reconcilePostgresBillingPeriodForQuotaOperation(",
      /withSettlementTransaction/,
    ],
  ] as const) {
    const body = functionBody(source, startMarker, endMarker);
    assert.match(body, expected);
    assert.doesNotMatch(body, /return withTransaction/);
  }
});

test("key rotation isolates its targeted Postgres work from the business pool", async () => {
  const [
    postgresSource,
    storeSource,
    sagaSource,
    guardSource,
    submitSource,
    decisionSource,
    resetSource,
  ] =
    await Promise.all([
      readFile(postgresStorePath, "utf8"),
      readFile(storePath, "utf8"),
      readFile(quotaSagaPath, "utf8"),
      readFile(quotaGuardPath, "utf8"),
      readFile(quotaOperationSubmitPath, "utf8"),
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
      "export async function transitionPostgresTokenRequestAfterQuotaMaterialization(",
    ],
    [
      "export async function transitionPostgresTokenRequestAfterQuotaMaterialization(",
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
  ]) {
    const body = functionBody(postgresSource, startMarker, endMarker);
    assert.match(body, /with(?:Client|Transaction)/, `${startMarker} must keep business`);
    assert.doesNotMatch(body, /withControl/, `${startMarker} must not move globally to control`);
  }

  const settingsRead = functionBody(
    postgresSource,
    "export async function getPostgresAppSettings()",
    "export async function getPostgresAppSettingsForQuotaOperation()",
  );
  assert.match(settingsRead, /withControlClient/);
  assert.doesNotMatch(settingsRead, /withClient\(/);

  const settingsMutation = functionBody(
    postgresSource,
    "export async function mutatePostgresAppSettings<",
    "export async function upsertPostgresUserQuotaPolicy(",
  );
  assert.match(settingsMutation, /withControlTransaction/);
  assert.match(settingsMutation, /JSON\.stringify\(settings\) !== before/);

  const sagaRouting = functionBody(
    sagaSource,
    "function usesIsolatedQuotaControlPool(",
    "async function clearCommittedDepartmentReservation(",
  );
  assert.match(
    sagaRouting,
    /return operation\.operationType === "key_rotation"/,
  );
  const lightweightRequestUpdate = functionBody(
    postgresSource,
    "export async function transitionPostgresTokenRequestAfterQuotaMaterialization(",
    "export async function upsertPostgresUserBillingPeriod(",
  );
  assert.match(lightweightRequestUpdate, /syncBillingPeriod: false/);
  assert.match(sagaSource, /updateOperationTokenRequestAfterMaterialization/);
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

  assert.match(guardSource, /TOKENINSIDE_QUOTA_WRITES_PAUSED/);
  assert.match(guardSource, /export function quotaWritesPaused\(\)/);
  assert.doesNotMatch(guardSource, /getAppSettings|quotaFeatureFlags|quota_restore/);
  assert.match(decisionSource, /await submitPostgresFirstProvisionDecision\(/);
  assert.match(resetSource, /updateTokenRequestForQuotaOperation\(tokenRequest\.id/);
  assert.match(submitSource, /max: config\.postgres\.quotaSubmitPoolMax/);
  assert.match(submitSource, /connectionTimeoutMillis: config\.postgres\.quotaSubmitConnectionTimeoutMs/);
  assert.match(resetSource, /await submitPostgresKeyRotation\(/);
  assert.doesNotMatch(decisionSource, /after\(\(\) => runQuotaOperation/);
  assert.doesNotMatch(resetSource, /after\(\(\) => runQuotaOperation/);
  assert.match(sagaSource, /ensureQuotaOperationWorker\(\)/);
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
    "async function closePostgresResolvedNoProxyMatchIssuesBatch(",
  );
  const settlement = functionBody(
    postgresSource,
    "async function settlePostgresMatchedNewApiUsageWithClient(",
    "export async function settlePostgresMatchedNewApiUsage(",
  );
  const issueUpsert = functionBody(
    postgresSource,
    "async function upsertPostgresUsageSyncIssueWithClient(",
    "export async function upsertPostgresUsageSyncIssue(",
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
    createMonthlyOpen.indexOf("user-quota:") <
      createMonthlyOpen.indexOf("policy_department_id") &&
      createMonthlyOpen.indexOf("policy_department_id") <
        createMonthlyOpen.indexOf("department-quota:"),
    "monthly open must resolve the current policy under the user lock before choosing a department scope",
  );
  assert.match(createMonthlyOpen, /pg_try_advisory_xact_lock\(hashtext\(\$1\)::bigint\)/);
  assert.match(createMonthlyOpen, /MonthlyOpenDepartmentLockBusyError/);
  assert.ok(
    createMonthlyOpen.indexOf("for (let attempt") <
      createMonthlyOpen.indexOf("withControlTransaction"),
    "monthly-open department try-lock retries must restart the complete transaction",
  );
  assert.match(
    createMonthlyOpen,
    /reservedDepartmentQuota: input\.departmentId[\s\S]*?\? input\.assignedMonthlyQuota[\s\S]*?: 0/,
  );
  assert.match(
    createMonthlyOpen,
    /state: input\.departmentId \? "budget_reserved" : "planned"/,
  );
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

test("accepted proxy responses retain their concurrency slot until terminal persistence settles", async () => {
  const routeSource = await readFile(proxyRoutePath, "utf8");
  const releaseObserver = functionBody(
    routeSource,
    "function releaseUpstreamSlotAfterTerminalPersistence(",
    "function createSettlementReadiness(logId: string)",
  );
  const streamLifecycle = functionBody(
    routeSource,
    "function streamWithProxyLog(input:",
    "async function readResponseBody(upstream: Response)",
  );
  const acceptedBodyResponses = functionBody(
    routeSource,
    "    if (upstream.body) {",
    "    const reason = sanitizedErrorMessage(err);",
  );
  const noBodyStart = acceptedBodyResponses.lastIndexOf(
    "const releaseAcceptedUpstreamSlot = releaseUpstreamSlot;",
  );
  assert.notEqual(noBodyStart, -1);
  const bodyResponseLifecycle = acceptedBodyResponses.slice(0, noBodyStart);
  const noBodyResponseLifecycle = acceptedBodyResponses.slice(noBodyStart);

  assert.match(
    releaseObserver,
    /terminalPersistence\s*\.then\(releaseUpstreamSlot, releaseUpstreamSlot\)\s*\.catch\(\(\) => undefined\)/,
  );
  assert.doesNotMatch(releaseObserver, /\.finally\(/);

  assert.match(
    streamLifecycle,
    /input\.finishSettlementReadiness\(work\);\s*releaseUpstreamSlotAfterTerminalPersistence\(work, input\.releaseUpstreamSlot\);/,
  );
  assert.doesNotMatch(streamLifecycle, /input\.releaseUpstreamSlot\(\)/);
  assert.doesNotMatch(streamLifecycle, /await persistTerminal\(/);
  assert.ok(
    streamLifecycle.indexOf("persistTerminal({") < streamLifecycle.indexOf("controller.close()"),
    "the stream must schedule terminal persistence before closing without awaiting it",
  );

  assert.match(bodyResponseLifecycle, /const releaseAcceptedUpstreamSlot = releaseUpstreamSlot/);
  assert.match(bodyResponseLifecycle, /settlement\.finish\(terminalPersistence!\)/);
  assert.match(
    bodyResponseLifecycle,
    /releaseUpstreamSlotAfterTerminalPersistence\(\s*terminalPersistence!,\s*releaseAcceptedUpstreamSlot,\s*\)/,
  );
  assert.doesNotMatch(bodyResponseLifecycle, /await recordResponse/);
  assert.doesNotMatch(bodyResponseLifecycle, /releaseUpstreamSlot\?\.\(\)/);
  assert.ok(
    bodyResponseLifecycle.indexOf("after(recordResponse.catch(() => undefined))") <
      bodyResponseLifecycle.indexOf("const response = new Response(clientBody"),
    "the client body response must be returned while recorder persistence remains background work",
  );

  assert.match(noBodyResponseLifecycle, /settlement\.finish\(terminalPersistence\)/);
  assert.match(
    noBodyResponseLifecycle,
    /releaseUpstreamSlotAfterTerminalPersistence\(\s*terminalPersistence,\s*releaseAcceptedUpstreamSlot,\s*\)/,
  );
  assert.doesNotMatch(noBodyResponseLifecycle, /await terminalPersistence/);
  assert.doesNotMatch(noBodyResponseLifecycle, /releaseUpstreamSlot\(\)/);
  assert.match(noBodyResponseLifecycle, /const response = new Response\(null/);
  assert.match(noBodyResponseLifecycle, /releaseUpstreamSlot = undefined;\s*return response;/);
});

test("proxy failures before a successful accepted response keep their direct slot release", async () => {
  const routeSource = await readFile(proxyRoutePath, "utf8");
  const outerRelease = routeSource.lastIndexOf("releaseUpstreamSlot?.();");
  const failurePersistence = routeSource.indexOf("await recordFailedProxyLog({", outerRelease);

  assert.notEqual(outerRelease, -1);
  assert.notEqual(failurePersistence, -1);
  assert.ok(outerRelease < failurePersistence);
});

test("deferred immediate usage settlement leaves the durable pending log for the scheduler", async () => {
  const routeSource = await readFile(proxyRoutePath, "utf8");
  const settlementLifecycle = functionBody(
    routeSource,
    "function settleNewApiUsageAfterResponse(",
    "function startProxyLeaseHeartbeat(logId: string)",
  );
  const deferredReturn = settlementLifecycle.indexOf(
    'if (result.reason === "deferred") return result;',
  );
  const retryPersistence = settlementLifecycle.indexOf(
    "await updateProxyUsageSettlementRetryReliably(context.proxyLogId",
  );

  assert.notEqual(deferredReturn, -1);
  assert.notEqual(retryPersistence, -1);
  assert.ok(
    deferredReturn < retryPersistence,
    "capacity deferral must return before scheduling another per-request database write",
  );
  assert.match(settlementLifecycle, /usageSettlementImmediateAttempts: result\.attempts/);
  assert.match(settlementLifecycle, /usageSettlementScanAttempts: 0/);
  assert.match(
    settlementLifecycle,
    /updateProxyUsageSettlementRetryReliably\(context\.proxyLogId/,
  );
  assert.doesNotMatch(
    settlementLifecycle,
    /updateProxyLogReliably\(context\.proxyLogId, \{\s*usageSettlementStatus: "retrying"/,
  );
});

test("proxy only schedules authoritative usage settlement for billable generation routes", async () => {
  const routeSource = await readFile(proxyRoutePath, "utf8");
  const proxyLifecycle = functionBody(
    routeSource,
    "async function proxy(request: Request, context: RouteContext)",
    "export function GET(request: Request, context: RouteContext)",
  );

  assert.match(
    proxyLifecycle,
    /const requiresUsageSettlement = isUsageRecordRequest\(\{\s*method: request\.method,\s*requestPath,\s*\}\);/,
  );
  assert.equal(
    proxyLifecycle.match(
      /usageSettlementStatus: requiresUsageSettlement \? "pending" : "not_applicable"/g,
    )?.length,
    2,
    "both admission and accepted-upstream persistence must classify non-billable requests",
  );
  assert.equal(
    proxyLifecycle.match(/if \(requiresUsageSettlement\) \{\s*settleNewApiUsageAfterResponse\(/g)
      ?.length,
    3,
    "stream, buffered, and empty successful responses must all gate settlement scheduling",
  );
});

test("proxy lifecycle persistence uses one atomic JSON merge statement", async () => {
  const source = await readFile(postgresStorePath, "utf8");
  const lifecycle = functionBody(
    source,
    "export async function updatePostgresProxyLog(",
    "export async function reservePostgresQuotaOperationDepartmentBudget(",
  );

  assert.match(lifecycle, /return withClient\(async \(client\) =>/);
  assert.equal(lifecycle.match(/await client\.query/g)?.length, 1);
  assert.match(lifecycle, /\(data - \$2::text\[\]\) \|\| \$3::jsonb/);
  assert.match(lifecycle, /update proxy_request_logs as target/);
  assert.doesNotMatch(lifecycle, /for update/i);
  assert.doesNotMatch(lifecycle, /saveProxyLogRow/);
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

test("pending usage tail backoff stays anchored to the immutable terminal time", async () => {
  const [source, baseline] = await Promise.all([
    readFile(postgresStorePath, "utf8"),
    readFile(greenfieldBaselinePath, "utf8"),
  ]);
  const horizon = functionBody(
    source,
    "export async function getPostgresPendingUsageSettlementHorizon(",
    "export async function deferPostgresCoveredPendingUsageSettlements(",
  );
  const backoff = functionBody(
    source,
    "export async function deferPostgresCoveredPendingUsageSettlements(",
    "export async function readPostgresUsageMatchingSnapshot(",
  );

  for (const query of [horizon, backoff]) {
    assert.match(
      query,
      /coalesce\(\s*nullif\(data->>'responseTimeUpdatedAt', ''\)::timestamptz,\s*created_at\s*\)/,
    );
  }
  assert.match(horizon, /withControlClient/);
  assert.match(horizon, /interval '24 hours'/);
  assert.match(horizon, /greatest\([\s\S]*finished_at \+ \(\$1::double precision \* interval '1 minute'\)[\s\S]*next_retry_at/);
  assert.match(backoff, /for update/);
  assert.match(backoff, /usageSettlementScanAttempts'\)::integer, 0/);
  assert.match(backoff, /usageSettlementImmediateAttempts/);
  assert.match(backoff, /usageSettlementScanAttempts', due\.scan_attempts \+ 1/);
  assert.match(backoff, /between \$1::timestamptz and \$2::timestamptz/);
  assert.match(backoff, /when due\.scan_attempts < 1 then interval '15 seconds'/);
  assert.match(backoff, /when due\.scan_attempts < 2 then interval '1 minute'/);
  assert.match(backoff, /when due\.scan_attempts < 3 then interval '5 minutes'/);
  assert.match(backoff, /else interval '15 minutes'/);

  assert.match(baseline, /proxy_request_logs_usage_pending_terminal_idx/);
  assert.match(baseline, /GREENFIELD_BASELINE_VERSION = "20260717_001_greenfield_baseline"/);
  assert.match(baseline, /on proxy_request_logs \(created_at\)/);
  assert.match(baseline, /usageSettlementStatus' in \('pending', 'retrying'\)/);
  assert.match(baseline, /in \('completed', 'failed', 'cancelled'\)/);
});

test("matched usage is an absorbing terminal state for late immediate retry patches", async () => {
  const [postgresSource, storeSource] = await Promise.all([
    readFile(postgresStorePath, "utf8"),
    readFile(storePath, "utf8"),
  ]);
  const postgresCas = functionBody(
    postgresSource,
    "export async function updatePostgresProxyUsageSettlementRetryIfUnsettled(",
    "export async function reservePostgresQuotaOperationDepartmentBudget(",
  );
  const storeCas = functionBody(
    storeSource,
    "export async function updateProxyUsageSettlementRetryIfUnsettled(",
    "export type NewApiUsageBackfillItem",
  );

  assert.match(postgresCas, /allowedUsageSettlementStatuses: \["pending", "retrying"\]/);
  assert.match(postgresSource, /data->>'usageSettlementStatus' = any\(\$24::text\[\]\)/);
  assert.match(
    postgresSource,
    /target\.data->>'usageSettlementStatus' = any\(\$24::text\[\]\)/,
  );
  assert.match(storeCas, /log\.usageSettlementStatus !== "pending"/);
  assert.match(storeCas, /log\.usageSettlementStatus !== "retrying"/);
  assert.match(storeCas, /return null/);
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
         values ($1, $2, $3, $4, $5, 'quota_adjust_grant', $6, $7, $8)`,
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
            entryType: "quota_adjust_grant",
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
        // quota_ledger_entries is immutable; this integration fixture remains
        // in the disposable TEST_DATABASE_URL database as audit evidence.
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
    // The full test suite runs several real-Postgres concurrency cases in
    // parallel. Preserve the short first retries but allow enough tail for a
    // heavily scheduled Windows/Docker runner; production itself already has
    // a longer bounded retry window.
    const retryDelaysMs = [2, 5, 10, 20, 40, 80, 160, 320, 640, 1_280];

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
