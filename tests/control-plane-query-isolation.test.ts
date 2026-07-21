import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const storePath = new URL("../lib/store.ts", import.meta.url);
const postgresQueriesPath = new URL(
  "../lib/postgres-control-queries.ts",
  import.meta.url,
);
const sessionRoutePath = new URL("../app/api/session/route.ts", import.meta.url);
const overviewRoutePath = new URL("../app/api/admin/overview/route.ts", import.meta.url);
const experienceClientPath = new URL("../components/experience-client.tsx", import.meta.url);

function functionBody(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

test("session summary uses a bounded Postgres projection and retains JSON fallback", async () => {
  const [storeSource, querySource, routeSource] = await Promise.all([
    readFile(storePath, "utf8"),
    readFile(postgresQueriesPath, "utf8"),
    readFile(sessionRoutePath, "utf8"),
  ]);
  const summary = functionBody(
    storeSource,
    "export async function getSessionStoreSummary()",
    "export async function getAppSettings()",
  );
  const querySummary = functionBody(
    querySource,
    "export async function getPostgresSessionStoreSummary()",
    "type PostgresAuthenticatedSessionProjectionRow",
  );
  const postgresBranch = summary.slice(0, summary.indexOf("const store = await readStore();"));

  assert.match(postgresBranch, /getPostgresSessionStoreSummary/);
  assert.doesNotMatch(postgresBranch, /readStore\(/);
  assert.match(summary, /const store = await readStore\(\)/);
  assert.match(querySummary, /count\(\*\)::integer from proxy_request_logs/);
  assert.match(querySummary, /data->>'defaultMonthlyQuota'/);
  assert.doesNotMatch(querySummary, /select data from app_settings/);
  assert.match(querySummary, /withPostgresControlClient/);
  assert.match(routeSource, /getSessionStoreSummary/);
  assert.doesNotMatch(routeSource, /getStoreSnapshot/);
  assert.doesNotMatch(routeSource, /billingOperations/);
  assert.doesNotMatch(routeSource, /getNewApiTokenKey|maskApiKey/);
});

test("authenticated session request and admin-scope reads never load the full Postgres Store", async () => {
  const [storeSource, querySource] = await Promise.all([
    readFile(storePath, "utf8"),
    readFile(new URL("../lib/postgres-store.ts", import.meta.url), "utf8"),
  ]);
  const requestsBody = functionBody(
    storeSource,
    "export async function listUserTokenRequests(",
    "export async function getActiveTokenForUser(",
  );
  const requestsPostgresBranch = requestsBody.slice(
    0,
    requestsBody.indexOf("const store = await readStore();"),
  );
  assert.match(requestsPostgresBranch, /listPostgresTokenRequestsForUser/);
  assert.doesNotMatch(requestsPostgresBranch, /readStore\(/);

  const scopeBody = functionBody(
    storeSource,
    "async function resolveAdminScopeForKnownUser(",
    "export async function listAdminScopes(",
  );
  assert.match(scopeBody, /getAdminScopeForKnownUser/);
  assert.match(scopeBody, /getPostgresAdminScopeFallbackData/);
  assert.doesNotMatch(scopeBody, /store \?\? await readStore\(\)/);
  assert.match(querySource, /where feishu_user_id = \$1\s+order by created_at desc, id/);
  assert.match(querySource, /where approval_target_open_id = \$2/);
  assert.match(querySource, /withControlClient/);
});

test("authenticated Postgres session uses one read-only control projection after auth", async () => {
  const [storeSource, querySource, routeSource] = await Promise.all([
    readFile(storePath, "utf8"),
    readFile(postgresQueriesPath, "utf8"),
    readFile(sessionRoutePath, "utf8"),
  ]);
  const queryBody = functionBody(
    querySource,
    "export async function getPostgresAuthenticatedSessionProjection(",
    "type PostgresAdminUserRow",
  );
  const storeBody = functionBody(
    storeSource,
    "export async function getAuthenticatedSessionProjection(",
    "export async function getAppSettings()",
  );

  assert.match(queryBody, /withPostgresControlClient/);
  assert.equal(
    queryBody.match(/client\.query/g)?.length,
    1,
    "session projection must use exactly one control SQL statement",
  );
  assert.match(queryBody, /jsonb_agg\(request\.data order by request\.created_at desc, request\.id\)/);
  assert.match(queryBody, /active_token as materialized/);
  assert.match(queryBody, /billing\.period = \$4/);
  assert.match(queryBody, /select token\.billing_period from active_token token/);
  assert.match(queryBody, /scope\.status = 'active'/);
  assert.match(queryBody, /request\.approval_target_open_id = \$2/);
  assert.match(queryBody, /jsonb_agg\(scope\.data order by scope\.updated_at desc, scope\.id\)/);
  assert.match(queryBody, /from department_quota_periods quota_period/);
  assert.match(queryBody, /data->>'defaultMonthlyQuota'/);
  assert.match(queryBody, /count\(\*\)::integer from proxy_request_logs/);
  assert.doesNotMatch(
    queryBody,
    /\b(?:insert|update|delete)\b|for update|pg_advisory/i,
    "session projection must stay read-only and lock-free",
  );

  assert.match(storeBody, /if \(!isPostgresBackend\(\)\) return null/);
  assert.match(storeBody, /getPostgresAuthenticatedSessionProjection/);
  assert.match(storeBody, /currentPeriod: currentQuotaPeriod\(\)/);
  assert.match(storeBody, /resolveSessionAdminScopeProjection/);
  assert.match(storeBody, /projection\.currentBilling\?\.monthlyQuota/);
  assert.match(storeBody, /projection\.departmentQuotaPeriod\?\.defaultGrantQuota/);
  assert.match(storeBody, /billingPeriod: projection\.activeTokenBilling/);
  assert.doesNotMatch(
    storeBody,
    /readStore\(|ensureDepartmentQuotaPeriod|getEffectiveAdminScopeForUser|hydrateUserDepartment/,
  );

  const postgresBranchStart = routeSource.indexOf(
    "const postgresSession = await getAuthenticatedSessionProjection(currentUser)",
  );
  const jsonBranchStart = routeSource.indexOf("const user = await hydrateUserDepartment(currentUser)");
  assert.notEqual(postgresBranchStart, -1);
  assert.notEqual(jsonBranchStart, -1);
  assert.ok(postgresBranchStart < jsonBranchStart);
  const postgresRouteBranch = routeSource.slice(postgresBranchStart, jsonBranchStart);
  assert.match(postgresRouteBranch, /if \(postgresSession\)/);
  assert.match(postgresRouteBranch, /return authenticatedSessionResponse/);
  assert.doesNotMatch(
    postgresRouteBranch,
    /hydrateUserDepartment|getEffectiveAdminScopeForUser|getEffectiveUserGrantQuota|getUserBillingPeriod/,
  );
});

test("admin users and overview dispatch to targeted SQL before full-store fallback", async () => {
  const [storeSource, querySource, routeSource] = await Promise.all([
    readFile(storePath, "utf8"),
    readFile(postgresQueriesPath, "utf8"),
    readFile(overviewRoutePath, "utf8"),
  ]);
  const usersBody = functionBody(
    storeSource,
    "export async function listAdminUsers(",
    "export async function listAdminUserStats(",
  );
  const usersBranch = usersBody.slice(0, usersBody.indexOf("const store = await readStore();"));
  assert.match(usersBranch, /listPostgresAdminUsers/);
  assert.doesNotMatch(usersBranch, /readStore\(/);

  const overviewBranch = functionBody(
    storeSource,
    "export async function getAdminOverview(",
    "  const store = await readStore();",
  );
  assert.match(overviewBranch, /getPostgresAdminOverview/);
  assert.doesNotMatch(overviewBranch, /readStore\(/);
  assert.match(querySource, /postgresAdminOverviewSnapshots/);
  assert.match(querySource, /createAsyncSnapshotCache/);
  assert.match(querySource, /freshMs: 5_000/);
  assert.match(querySource, /staleMs: 30_000/);
  assert.match(querySource, /loadPostgresAdminOverview/);

  const metadataBody = functionBody(
    querySource,
    "export async function getPostgresAdminOverviewMetadata()",
    "export type PostgresUsageReportInput",
  );
  assert.match(metadataBody, /withPostgresControlClient/);
  assert.equal(metadataBody.match(/client\.query/g)?.length, 1);
  assert.match(metadataBody, /from app_settings/);
  assert.match(metadataBody, /from usage_sync_checkpoints/);
  assert.match(routeSource, /getAdminOverviewMetadata/);
  assert.doesNotMatch(routeSource, /getAppSettings|getUsageSyncCheckpoint/);
});

test("Postgres usage-sync checkpoint is a targeted control point read", async () => {
  const [storeSource, postgresSource] = await Promise.all([
    readFile(storePath, "utf8"),
    readFile(new URL("../lib/postgres-store.ts", import.meta.url), "utf8"),
  ]);
  const storeBody = functionBody(
    storeSource,
    "export async function getUsageSyncCheckpoint(",
    "export async function saveUsageSyncCheckpoint(",
  );
  const postgresBranch = storeBody.slice(0, storeBody.indexOf("const store = await readStore();"));
  assert.match(postgresBranch, /getPostgresUsageSyncCheckpoint/);
  assert.doesNotMatch(postgresBranch, /readStore\(/);

  const postgresBody = functionBody(
    postgresSource,
    "export async function getPostgresUsageSyncCheckpoint(",
    "export type PostgresBillingMaterializationTarget",
  );
  assert.match(postgresBody, /withControlClient/);
  assert.equal(postgresBody.match(/client\.query/g)?.length, 1);
  assert.match(postgresBody, /where scope = \$1 limit 1/);
});

test("usage reports filter, aggregate and paginate inside the isolated control query", async () => {
  const [storeSource, querySource] = await Promise.all([
    readFile(storePath, "utf8"),
    readFile(postgresQueriesPath, "utf8"),
  ]);
  for (const [startMarker, endMarker] of [
    ["export async function listAdminUsageRecords(", "export async function listUserUsageRecords("],
    ["export async function listUserUsageRecords(", "export async function listUserUsageReport("],
    ["export async function listUserUsageReport(", "export async function listDepartmentStats("],
  ]) {
    const body = functionBody(storeSource, startMarker, endMarker);
    const postgresBranch = body.slice(0, body.indexOf("const store = await readStore();"));
    assert.match(postgresBranch, /listPostgresUsageReport/);
    assert.doesNotMatch(postgresBranch, /readStore\(/);
    assert.match(body, /const store = await readStore\(\)/);
  }

  assert.match(querySource, /withPostgresControlClient/);
  assert.match(querySource, /date_scoped as materialized/);
  assert.match(querySource, /filtered as materialized/);
  assert.match(querySource, /aggregate_rows as materialized/);
  assert.match(querySource, /limit \$\{query\.limitParameter\} offset \$\{query\.offsetParameter\}/);
  assert.match(querySource, /count\(\*\)::integer from filtered/);
  assert.match(querySource, /from user_billing_periods billing/);
  assert.match(querySource, /as usage_overview/);
  assert.match(querySource, /usageOverview: row\.usage_overview \?\? null/);
  assert.doesNotMatch(querySource, /readPostgresStore|readStore\(/);
});

test("user usage polling refreshes records and overview together without overlapping hidden-tab work", async () => {
  const source = await readFile(experienceClientPath, "utf8");
  const loader = functionBody(
    source,
    "const loadUsageRecords = useCallback(",
    "const loadQuickApprovals = useCallback(",
  );

  assert.match(loader, /usageRefreshInFlightRef\.current/);
  assert.match(loader, /signal: controller\.signal/);
  assert.match(loader, /billingPeriod: data\.usageOverview \?\? null/);
  assert.match(source, /document\.visibilityState === "visible"/);
  assert.match(source, /window\.setTimeout\(\(\) => void poll\(\), 3000\)/);
  assert.doesNotMatch(source, /window\.setInterval\(\(\) => \{\s*void loadUsageRecords/);
});
