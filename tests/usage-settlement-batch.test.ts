import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const postgresStorePath = new URL("../lib/postgres-store.ts", import.meta.url);
const storePath = new URL("../lib/store.ts", import.meta.url);

function functionBody(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

type BatchWriter = {
  upsertUsageRecord(record: Record<string, unknown>): Promise<Record<string, unknown>>;
  settleMatchedUsage(input: {
    record: Record<string, unknown>;
    proxyLogId: string;
    patch: Record<string, unknown>;
    syncedAt: string;
  }): Promise<{
    usageRecord: Record<string, unknown>;
    proxyLog: Record<string, unknown> | null;
  }>;
};

async function createPostgresBatchHarness(input: {
  usageRows?: Array<Record<string, unknown>>;
  proxyRows?: Array<Record<string, unknown>>;
  issueRows?: Array<Record<string, unknown>>;
} = {}) {
  const source = await readFile(postgresStorePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: "postgres-store.ts",
  }).outputText;
  const queries: string[] = [];
  let releases = 0;
  const client = {
    async query(sql: string, values: unknown[] = []) {
      const normalized = sql.trim().replace(/\s+/g, " ");
      queries.push(normalized);
      if (normalized.startsWith("insert into newapi_usage_records")) {
        return { rows: [{ data: values[8] }] };
      }
      if (normalized.startsWith("insert into proxy_request_logs")) {
        return { rows: [{ data: values[10] }] };
      }
      if (normalized.startsWith("insert into usage_sync_issues")) {
        return { rows: [{ data: values[6] }] };
      }
      if (normalized.startsWith("select data from newapi_usage_records")) {
        return { rows: (input.usageRows ?? []).map((data) => ({ data })) };
      }
      if (
        normalized.startsWith("select data from proxy_request_logs") &&
        normalized.includes("id = any($1::text[])")
      ) {
        return { rows: (input.proxyRows ?? []).map((data) => ({ data })) };
      }
      if (normalized.startsWith("with source_identities")) {
        const identities = JSON.parse(String(values[0])) as Array<{
          newapi_token_id: string | null;
          newapi_request_id: string | null;
          newapi_log_id: string | null;
        }>;
        return {
          rows: (input.issueRows ?? [])
            .filter((issue) => identities.some((identity) =>
              issue.newapiTokenId === (identity.newapi_token_id ?? undefined) &&
              (
                (identity.newapi_request_id !== null &&
                  issue.newapiRequestId === identity.newapi_request_id) ||
                ((identity.newapi_request_id === null || issue.newapiRequestId == null) &&
                  identity.newapi_log_id !== null &&
                  issue.newapiLogId === identity.newapi_log_id)
              )))
            .map((data) => ({ data })),
        };
      }
      return { rows: [] };
    },
    release() {
      releases += 1;
    },
  };
  class FakePool {
    totalCount = 0;
    idleCount = 0;
    waitingCount = 0;
    async connect() {
      return client;
    }
  }
  class TestError extends Error {}
  const module = {
    exports: {} as {
      withPostgresUsageSettlementBatch<T>(
        run: (writer: BatchWriter) => Promise<T>,
        options?: {
          lockKeys?: string[];
          usageSources?: Array<{
            recordId: string;
            usageLog: Record<string, unknown>;
          }>;
          proxyLogIds?: string[];
        },
      ): Promise<T>;
    },
  };
  const imports: Record<string, Record<string, unknown>> = {
    pg: { Pool: FakePool },
    "@/lib/admin-scope": {
      resolveSessionAdminScopeProjection: () => null,
    },
    "@/lib/user-access-state": {
      preserveUserAccessRevocationBarrier: (
        value: Record<string, unknown>,
      ) => value,
    },
    "@/lib/user-access-recovery-sql": {
      rollbackPendingUserAccessResumeSql: "select null where false",
    },
    "@/lib/config": {
      getConfig: () => ({
        databaseUrl: "postgres://test",
        postgres: {
          poolMax: 4,
          settlementPoolMax: 2,
          controlPoolMax: 2,
          lockPoolMax: 1,
          poolIdleTimeoutMs: 30_000,
          poolConnectionTimeoutMs: 1_000,
        },
        newapi: { quotaPerUnit: 500_000 },
      }),
    },
    "@/lib/crypto": {
      nowIso: () => "2026-07-17T00:00:00.000Z",
      randomId: () => "test-id",
    },
    "@/lib/billing-operation-state": {
      isTerminalBillingOperationStatus: (status: string) =>
        ["dry_run", "applied", "partial_failed", "failed"].includes(status),
    },
    "@/lib/department-quota": {
      initialDepartmentQuotaLimit: () => 1_000,
      validateDepartmentQuotaLimit: () => null,
    },
    "@/lib/greenfield-installation": {
      verifyGreenfieldInstallationBinding: () => ({ valid: true }),
    },
    "@/lib/department-member-sync-sql": {
      lockDepartmentMemberSyncUsersSql: "select true",
      upsertDepartmentMembersSql: "select true",
    },
    "@/lib/newapi-usage-identity": {
      hasConflictingProxyMatch: () => false,
      newApiUsageIdentityLockKeys: () => ["usage-identity"],
      sameNewApiUsageSource: (left: Record<string, unknown>, right: Record<string, unknown>) =>
        left.newapiTokenId === right.newapiTokenId &&
        left.newapiRequestId === right.newapiRequestId,
    },
    "@/lib/quota-model": {
      initialUnassignedMonthlyQuota: () => 0,
      materializeDepartmentQuota: () => ({}),
      materializeUserQuota: () => ({}),
      resolveUsageBillingPeriod: () => "2026-07",
    },
    "@/lib/package-reset": {
      assertPackageResetExecutionAllowed: () => ({
        period: "2026-07",
        scheduledAt: "2026-06-30T16:00:00.000Z",
      }),
      normalizePackageResetPolicy: (policy: unknown) =>
        policy ?? { enabled: false, dayOfMonth: 1 },
      PACKAGE_RESET_SYSTEM_ACTOR: "system:package-reset",
    },
    "@/lib/quota-saga-state": { assertQuotaOperationTransition: () => undefined },
    "@/lib/quota-execution-fence": {
      assertQuotaExecutionFenceHeld: () => undefined,
      createQuotaExecutionFence: (key: string) => ({
        key,
        lost: false,
        closed: false,
        markLost: () => undefined,
        close: () => undefined,
        assertHeld: () => undefined,
      }),
      runWithQuotaExecutionFence: async (
        _fence: unknown,
        run: () => Promise<unknown>,
      ) => run(),
    },
    "@/lib/quota-admission": {
      assertQuotaAdmission: () => undefined,
      QuotaAdmissionClosedError: TestError,
      QuotaOperationBusyError: TestError,
      StaleTokenGenerationError: TestError,
    },
    "@/lib/usage-matching": {
      isBillableProxyLog: () => true,
      isNewApiUsageMatchEligibleProxyLog: () => true,
    },
  };
  runInNewContext(transpiled, {
    module,
    exports: module.exports,
    require: (specifier: string) => {
      const dependency = imports[specifier];
      if (!dependency) throw new Error(`unexpected postgres-store import: ${specifier}`);
      return dependency;
    },
    console,
    setTimeout,
    clearTimeout,
  });
  return {
    api: module.exports,
    queries,
    get releases() {
      return releases;
    },
  };
}

function usageRecord(id: string) {
  return {
    id,
    newapiLogId: id,
    newapiRequestId: `request-${id}`,
    newapiTokenId: "token-1",
    matchStatus: "no_proxy_match",
    firstSeenAt: "2026-07-17T00:00:00.000Z",
    lastSyncedAt: "2026-07-17T00:00:00.000Z",
  };
}

function matchedUsageRecord(id: string, proxyLogId: string) {
  return {
    ...usageRecord(id),
    tokenAccountId: "account-1",
    matchStatus: "matched",
    matchedProxyLogId: proxyLogId,
  };
}

function proxyLog(id: string) {
  return {
    id,
    feishuUserId: "user-1",
    tokenAccountId: "account-1",
    requestPath: "/v1/chat/completions",
    method: "POST",
    status: "completed",
    statusCode: 200,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
  };
}

test("Postgres backfill keeps ordered one-to-one matching inside one page transaction", async () => {
  const [store, postgresStore] = await Promise.all([
    readFile(storePath, "utf8"),
    readFile(postgresStorePath, "utf8"),
  ]);
  const backfill = functionBody(
    store,
    "export async function backfillProxyLogsFromNewApiUsage(",
    "async function resolveAdminScopeForKnownUser(",
  );
  const transaction = functionBody(
    postgresStore,
    "export async function withPostgresUsageSettlementBatch<",
    "export async function upsertPostgresUsageSyncCheckpoint(",
  );
  const lockedRead = functionBody(
    postgresStore,
    "async function loadPostgresUsageSettlementBatchState(",
    "export type PostgresUsageSettlementBatchWriter",
  );
  const issueBatch = functionBody(
    postgresStore,
    "async function closePostgresResolvedNoProxyMatchIssuesBatch(",
    "async function settlePostgresMatchedNewApiUsageWithClient(",
  );

  assert.match(backfill, /for \(const usageLog of usageLogs\)/);
  assert.ok(
    backfill.indexOf("reservedProxyLogIds.add(proxyLog.id)") <
      backfill.indexOf("await persistMatched(record, proxyLog, patch, syncedAt)"),
    "one-to-one proxy reservation must happen before the first authoritative write await",
  );
  assert.match(
    backfill,
    /if \(dryRun\) return withSnapshotStats\(await runBackfill\(store\)\)/,
  );
  assert.match(
    backfill,
    /withPostgresUsageSettlementBatch\(\s*\(writer, lockedSnapshot\) =>[\s\S]*runBackfill/,
  );
  assert.match(backfill, /newapiUsageRecords: lockedSnapshot\.newapiUsageRecords/);
  assert.match(backfill, /proxyRequestLogs: lockedSnapshot\.proxyRequestLogs/);
  assert.match(transaction, /usageSources\.flatMap/);
  assert.match(
    transaction,
    /newApiUsageIdentityLockKeys\(\{[\s\S]*\.\.\.source\.usageLog,[\s\S]*id: source\.recordId/,
  );
  assert.match(transaction, /newapi_usage:proxy:/);
  assert.match(
    transaction,
    /acquirePostgresUsageAdvisoryLocks\(client, derivedLockKeys/,
  );
  assert.ok(
    lockedRead.indexOf("from newapi_usage_records") <
      lockedRead.indexOf("from proxy_request_logs"),
    "usage rows must be locked before proxy rows",
  );
  assert.match(
    lockedRead,
    /from newapi_usage_records[\s\S]*order by id[\s\S]*for update/,
  );
  assert.match(
    lockedRead,
    /from proxy_request_logs[\s\S]*order by id[\s\S]*for update/,
  );
  assert.match(transaction, /locksAlreadyHeld: true/);
  assert.match(transaction, /id: source\.recordId/);
  assert.match(issueBatch, /jsonb_to_recordset\(\$1::jsonb\)/);
  assert.match(issueBatch, /newapi_token_id: record\.newapiTokenId/);
  assert.match(issueBatch, /order by issue\.id[\s\S]*for update of issue/);
  assert.doesNotMatch(issueBatch, /newapi_token_id = any\(\$1::text\[\]\)/);
  assert.doesNotMatch(backfill, /upsertPostgresNewApiUsageRecord/);
  assert.doesNotMatch(backfill, /settlePostgresMatchedNewApiUsage\(/);
  assert.match(transaction, /return withSettlementTransaction\(async \(client\) =>/);
  assert.match(transaction, /upsertPostgresNewApiUsageRecordWithClient\(client, record, \{/);
  assert.match(
    transaction,
    /settlePostgresMatchedNewApiUsageWithClient\(\s*client,\s*input/,
  );
  assert.match(transaction, /closePostgresResolvedNoProxyMatchIssuesBatch/);
});

test("each matching snapshot is bounded to page identities and occupied candidates", async () => {
  const [store, postgresStore] = await Promise.all([
    readFile(storePath, "utf8"),
    readFile(postgresStorePath, "utf8"),
  ]);
  const snapshot = functionBody(
    postgresStore,
    "export async function readPostgresUsageMatchingSnapshot(",
    "export async function getPostgresUserById(",
  );
  const backfill = functionBody(
    store,
    "export async function backfillProxyLogsFromNewApiUsage(",
    "async function resolveAdminScopeForKnownUser(",
  );

  assert.match(snapshot, /usageSources: Array</);
  assert.match(snapshot, /data->>'newapiRequestId' = any\(\$3::text\[\]\)/);
  assert.match(snapshot, /data->>'newapiResponseRequestId' = any\(\$3::text\[\]\)/);
  assert.match(snapshot, /data->>'newapiUpstreamRequestId' = any\(\$3::text\[\]\)/);
  assert.match(snapshot, /input\.usageSources\.filter\(\(source\) => !sourceHasExactCandidate\(source\)\)/);
  assert.match(snapshot, /data->>'responseTimeUpdatedAt'/);
  assert.match(snapshot, /data->>'updatedAt'/);
  assert.match(snapshot, /fallbackSources\.flatMap/);
  assert.match(snapshot, /jsonb_to_recordset\(\$1::jsonb\)/);
  assert.match(snapshot, /ranges\."finishedAfter"/);
  assert.match(snapshot, /ranges\."finishedBefore"/);
  assert.match(snapshot, /id = any\(\$1::text\[\]\)/);
  assert.match(snapshot, /data->>'matchedProxyLogId' = any\(\$5::text\[\]\)/);
  assert.doesNotMatch(
    snapshot,
    /select data from newapi_usage_records where newapi_token_id = any/,
  );
  assert.match(snapshot, /exactProxyCandidates: exactProxyRows\.length/);
  assert.match(snapshot, /fallbackProxyCandidates: fallbackProxyLogs\.rows\.length/);
  assert.match(snapshot, /usageRecords: usageRecordById\.size/);

  assert.match(backfill, /recordId: usageRecordIdFromLog\(usageLog\)/);
  assert.match(backfill, /fallbackMatchingWindowMs = Math\.min\(/);
  assert.match(backfill, /30_000/);
  assert.match(backfill, /!persistLog &&\s*!persistMatched/);
  assert.match(backfill, /snapshot: matchingSnapshot\.stats/);
});

test("a successful authoritative page uses exactly one BEGIN and COMMIT", async () => {
  const harness = await createPostgresBatchHarness();
  await harness.api.withPostgresUsageSettlementBatch(async (writer) => {
    await writer.upsertUsageRecord(usageRecord("usage-1"));
    await writer.upsertUsageRecord(usageRecord("usage-2"));
    return "committed";
  });

  assert.equal(harness.queries.filter((query) => query === "begin").length, 1);
  assert.equal(harness.queries.filter((query) => query === "commit").length, 1);
  assert.equal(harness.queries.filter((query) => query === "rollback").length, 0);
  assert.equal(harness.releases, 1);
});

test("a locked page refreshes source and proxy state once instead of reading per record", async () => {
  const proxies = [proxyLog("proxy-1"), proxyLog("proxy-2")];
  const harness = await createPostgresBatchHarness({ proxyRows: proxies });
  const usageSources = ["usage-1", "usage-2"].map((id) => ({
    recordId: id,
    usageLog: {
      newapiLogId: id,
      newapiRequestId: `request-${id}`,
      newapiTokenId: "token-1",
    },
  }));

  await harness.api.withPostgresUsageSettlementBatch(
    async (writer) => {
      for (let index = 0; index < proxies.length; index += 1) {
        const proxy = proxies[index];
        await writer.settleMatchedUsage({
          record: matchedUsageRecord(`usage-${index + 1}`, String(proxy.id)),
          proxyLogId: String(proxy.id),
          patch: { quota: index + 1 },
          syncedAt: "2026-07-17T00:00:01.000Z",
        });
      }
    },
    {
      lockKeys: ["usage-identity", "proxy-1", "proxy-2"],
      usageSources,
      proxyLogIds: proxies.map((proxy) => String(proxy.id)),
    },
  );

  assert.equal(
    harness.queries.filter(
      (query) =>
        query.startsWith("select data from newapi_usage_records") &&
        query.includes("id = any($1::text[])"),
    ).length,
    1,
  );
  assert.equal(
    harness.queries.filter(
      (query) =>
        query.startsWith("select data from proxy_request_logs") &&
        query.includes("id = any($1::text[])"),
    ).length,
    1,
  );
  assert.equal(
    harness.queries.filter((query) =>
      query.includes("data->>'matchedProxyLogId' = $1"),
    ).length,
    0,
  );
  assert.equal(
    harness.queries.filter((query) =>
      query.includes("select data from proxy_request_logs where id = $1 for update"),
    ).length,
    0,
  );
  assert.equal(
    harness.queries.filter((query) => query.startsWith("insert into newapi_usage_records"))
      .length,
    2,
  );
  assert.equal(
    harness.queries.filter((query) => query.startsWith("insert into proxy_request_logs"))
      .length,
    2,
  );
});

test("a lock-time proxy owner prevents a stale page snapshot from rebinding that proxy", async () => {
  const owner = {
    ...matchedUsageRecord("owner", "proxy-1"),
    newapiRequestId: "request-owner",
  };
  const harness = await createPostgresBatchHarness({
    usageRows: [owner],
    proxyRows: [proxyLog("proxy-1")],
  });
  const incoming = {
    ...matchedUsageRecord("incoming", "proxy-1"),
    newapiRequestId: "request-incoming",
  };

  const settled = await harness.api.withPostgresUsageSettlementBatch(
    (writer) =>
      writer.settleMatchedUsage({
        record: incoming,
        proxyLogId: "proxy-1",
        patch: { quota: 99 },
        syncedAt: "2026-07-17T00:00:01.000Z",
      }),
    {
      usageSources: [
        {
          recordId: "incoming",
          usageLog: {
            newapiLogId: "incoming",
            newapiRequestId: "request-incoming",
            newapiTokenId: "token-1",
          },
        },
      ],
      proxyLogIds: ["proxy-1"],
    },
  );

  assert.equal(settled.proxyLog, null);
  assert.equal(settled.usageRecord.id, "owner");
  assert.equal(
    harness.queries.filter((query) => query.startsWith("insert into newapi_usage_records"))
      .length,
    0,
  );
  assert.equal(
    harness.queries.filter((query) => query.startsWith("insert into proxy_request_logs"))
      .length,
    0,
  );
});

test("an authoritative matched source cannot be downgraded by a later no-match scan", async () => {
  const existing = matchedUsageRecord("usage-1", "proxy-1");
  const harness = await createPostgresBatchHarness({
    usageRows: [existing],
  });
  const incoming = {
    ...usageRecord("usage-1"),
    matchStatus: "no_proxy_match",
    lastSyncedAt: "2026-07-17T00:00:02.000Z",
  };

  const stored = await harness.api.withPostgresUsageSettlementBatch(
    (writer) => writer.upsertUsageRecord(incoming),
    {
      usageSources: [{
        recordId: "usage-1",
        usageLog: {
          newapiLogId: "usage-1",
          newapiRequestId: "request-usage-1",
          newapiTokenId: "token-1",
        },
      }],
    },
  );

  assert.equal(stored.matchStatus, "matched");
  assert.equal(stored.matchedProxyLogId, "proxy-1");
  assert.equal(
    harness.queries.filter((query) => query.startsWith("insert into newapi_usage_records"))
      .length,
    0,
  );
});

test("a matched page closes only its exact no-proxy issue using snake-case SQL identities", async () => {
  const targetIssue = {
    id: "issue-target",
    issueType: "no_proxy_match",
    status: "open",
    newapiTokenId: "token-1",
    newapiRequestId: "request-usage-1",
    newapiLogId: "usage-1",
    firstSeenAt: "2026-07-17T00:00:00.000Z",
    lastSeenAt: "2026-07-17T00:00:00.000Z",
    lastSyncedAt: "2026-07-17T00:00:00.000Z",
  };
  const otherIssue = {
    ...targetIssue,
    id: "issue-other",
    newapiRequestId: "request-other",
    newapiLogId: "other",
  };
  const harness = await createPostgresBatchHarness({
    proxyRows: [proxyLog("proxy-1")],
    issueRows: [targetIssue, otherIssue],
  });
  const record = matchedUsageRecord("usage-1", "proxy-1");

  await harness.api.withPostgresUsageSettlementBatch(
    (writer) => writer.settleMatchedUsage({
      record,
      proxyLogId: "proxy-1",
      patch: { quota: 99 },
      syncedAt: "2026-07-17T00:00:01.000Z",
    }),
    {
      usageSources: [{
        recordId: "usage-1",
        usageLog: {
          newapiLogId: "usage-1",
          newapiRequestId: "request-usage-1",
          newapiTokenId: "token-1",
        },
      }],
      proxyLogIds: ["proxy-1"],
    },
  );

  const issueWrites = harness.queries.filter((query) =>
    query.startsWith("insert into usage_sync_issues"));
  assert.equal(issueWrites.length, 1);
  const issueRead = harness.queries.find((query) => query.startsWith("with source_identities"));
  assert.match(issueRead ?? "", /order by issue\.id for update of issue/);
});

test("a mid-page authoritative failure rolls back once and never commits", async () => {
  const harness = await createPostgresBatchHarness();
  const expected = new Error("second record failed");

  await assert.rejects(
    harness.api.withPostgresUsageSettlementBatch(async (writer) => {
      await writer.upsertUsageRecord(usageRecord("usage-1"));
      throw expected;
    }),
    expected,
  );

  assert.equal(harness.queries.filter((query) => query === "begin").length, 1);
  assert.equal(harness.queries.filter((query) => query === "commit").length, 0);
  assert.equal(harness.queries.filter((query) => query === "rollback").length, 1);
  assert.equal(harness.releases, 1);
});

test("unknown dedicated-upstream tokens are quarantined durably and block settlement", async () => {
  const store = await readFile(storePath, "utf8");
  const backfill = functionBody(
    store,
    "export async function backfillProxyLogsFromNewApiUsage(",
    "async function resolveAdminScopeForKnownUser(",
  );
  const unknownBranch = functionBody(
    backfill,
    "if (!account) {",
    "const existingRecord = store.newapiUsageRecords.find",
  );

  assert.match(unknownBranch, /matchStatus: "unknown_token"/);
  assert.match(unknownBranch, /issueType: "unknown_token"/);
  assert.match(unknownBranch, /severity: "critical"/);
  assert.match(unknownBranch, /blocksSettlement: true/);
  assert.ok(
    unknownBranch.indexOf("await persistRecord(record)") <
      unknownBranch.indexOf("continue;"),
  );
  assert.ok(
    unknownBranch.indexOf("await persistSyncIssue(issue)") <
      unknownBranch.indexOf("continue;"),
  );
});

test("known-token usage without a billing amount blocks both matched and unmatched settlement", async () => {
  const store = await readFile(storePath, "utf8");
  const backfill = functionBody(
    store,
    "export async function backfillProxyLogsFromNewApiUsage(",
    "async function resolveAdminScopeForKnownUser(",
  );
  assert.match(backfill, /hasAuthoritativeBillingAmount/);
  assert.match(backfill, /issueType: "missing_cost"/);
  assert.match(backfill, /severity: "critical"/);
  assert.match(backfill, /blocksSettlement: true/);
  assert.match(backfill, /blocksSettlement: missingBillingAmount/);
  assert.match(backfill, /blocksSettlement: Boolean\(billingIssue\)/);
});

test("a later authoritative amount closes the exact missing-cost issue in JSON and PostgreSQL", async () => {
  const [store, postgres] = await Promise.all([
    readFile(storePath, "utf8"),
    readFile(postgresStorePath, "utf8"),
  ]);
  assert.match(store, /function closeResolvedMissingCostIssuesInStore/);
  assert.match(store, /issue\.issueType !== "missing_cost"/);
  assert.match(store, /sameNewApiUsageSource\(issue, record\)/);
  assert.match(store, /issue\.status = "closed"/);
  assert.match(postgres, /function closePostgresResolvedMissingCostIssues/);
  assert.match(postgres, /where issue_type = 'missing_cost'/);
  assert.match(postgres, /and status = 'open'/);
  assert.match(postgres, /await closePostgresResolvedMissingCostIssues\(client, stored\)/);
});
