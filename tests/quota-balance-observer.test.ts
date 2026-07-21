import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildQuotaBalanceObservationRecord,
  quotaBalanceObservationRecordId,
} from "../lib/quota-balance-observation-state.ts";

const observerPath = new URL("../lib/quota-balance-observer.ts", import.meta.url);
const instrumentationPath = new URL("../instrumentation.ts", import.meta.url);
const migrationPath = new URL("../scripts/db-migrate.mjs", import.meta.url);
const newApiPath = new URL("../lib/newapi.ts", import.meta.url);
const postgresStorePath = new URL("../lib/postgres-store.ts", import.meta.url);

const candidate = {
  id: "account-1",
  feishuUserId: "user-1",
  newapiTokenId: "101",
  operationGeneration: 3,
};

function stableRecord(input: {
  previous?: ReturnType<typeof buildQuotaBalanceObservationRecord>;
  classifiedStatus?: "healthy" | "excess_upstream" | "deficit_upstream";
  stable?: boolean;
  observedAt: string;
}) {
  const classifiedStatus = input.classifiedStatus ?? "excess_upstream";
  const stable = input.stable ?? true;
  return buildQuotaBalanceObservationRecord({
    id: quotaBalanceObservationRecordId(candidate.feishuUserId, "2026-07"),
    candidate,
    period: "2026-07",
    expectedAvailableQuota: 100,
    observedRemainQuota: stable ? 120 : undefined,
    firstObservedRemainQuota: stable ? 120 : undefined,
    secondObservedRemainQuota: stable ? 120 : undefined,
    classifiedStatus: stable ? classifiedStatus : "provisional",
    stable,
    reason: stable ? "stable_upstream_observation" : "proxy_request_inflight",
    settledThrough: "2026-07-18T00:00:00.000Z",
    previous: input.previous,
    observedAt: input.observedAt,
  });
}

test("余额偏差必须连续两次同类稳定观测才成为正式异常", () => {
  const first = stableRecord({ observedAt: "2026-07-18T00:00:00.000Z" });
  assert.equal(first.status, "provisional");
  assert.equal(first.evidence?.observerStableRounds, 1);
  assert.equal(first.evidence?.observerCandidateStatus, "excess_upstream");

  const second = stableRecord({
    previous: first,
    observedAt: "2026-07-18T00:05:00.000Z",
  });
  assert.equal(second.status, "excess_upstream");
  assert.equal(second.evidence?.observerStableRounds, 2);

  const stillFinal = stableRecord({
    previous: second,
    observedAt: "2026-07-18T00:10:00.000Z",
  });
  assert.equal(stillFinal.status, "excess_upstream");
  assert.equal(stillFinal.evidence?.observerStableRounds, 2);
});

test("任一不稳定轮次会打断确认链，健康结果立即生效", () => {
  const first = stableRecord({ observedAt: "2026-07-18T00:00:00.000Z" });
  const unstable = stableRecord({
    previous: first,
    stable: false,
    observedAt: "2026-07-18T00:05:00.000Z",
  });
  assert.equal(unstable.status, "provisional");
  assert.equal(unstable.evidence?.observerStableRounds, 0);
  assert.equal(unstable.evidence?.observerCandidateStatus, undefined);

  const restarted = stableRecord({
    previous: unstable,
    observedAt: "2026-07-18T00:10:00.000Z",
  });
  assert.equal(restarted.status, "provisional");
  assert.equal(restarted.evidence?.observerStableRounds, 1);

  const healthy = stableRecord({
    previous: restarted,
    classifiedStatus: "healthy",
    observedAt: "2026-07-18T00:15:00.000Z",
  });
  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.evidence?.observerStableRounds, 1);
});

test("观察器只读上游和授权账本，并使用有界 PG 控制面查询", async () => {
  const [observer, instrumentation, migration, newapi, postgresStore] = await Promise.all([
    readFile(observerPath, "utf8"),
    readFile(instrumentationPath, "utf8"),
    readFile(migrationPath, "utf8"),
    readFile(newApiPath, "utf8"),
    readFile(postgresStorePath, "utf8"),
  ]);
  const observeCandidateStart = observer.indexOf("async function observeCandidate(");
  const observeCandidateEnd = observer.indexOf(
    "async function runBoundedCandidateBatch(",
    observeCandidateStart,
  );
  const observeCandidate = observer.slice(
    observeCandidateStart,
    observeCandidateEnd,
  );

  assert.match(observer, /withPostgresAdvisoryLock\([\s\S]*?executionFence: true/);
  assert.match(observer, /withPostgresControlClient/);
  assert.match(observer, /quota_balance_observer_state/);
  assert.match(observer, /order by feishu_user_id, id[\s\S]*?limit \$2/);
  assert.match(observer, /const observerConcurrency = 2/);
  assert.equal(
    observeCandidate.match(/await getNewApiTokenRemainQuota\(/g)?.length,
    2,
  );
  assert.equal(
    observeCandidate.match(/await readObservationSnapshot\(/g)?.length,
    2,
  );
  assert.match(observeCandidate, /local_snapshot_changed_during_observation/);
  assert.match(observeCandidate, /classifyQuotaReconciliation/);
  assert.doesNotMatch(
    observer,
    /updateNewApiTokenQuota|insertPostgresQuotaLedgerEntry|quota_ledger_entries/,
  );
  assert.match(instrumentation, /void import\("@\/lib\/quota-balance-observer"\)/);
  assert.match(instrumentation, /quota_balance_observer_start_failed/);
  assert.match(newapi, /getNewApiTokenRemainQuota\([\s\S]*?timeoutMs/);
  assert.match(observeCandidate, /requireUsable: true/g);

  assert.match(migration, /quota_balance_observer_state/);
  assert.match(migration, /token_accounts_active_observer_idx/);
  assert.match(migration, /newapi_usage_records_billing_recent_authoritative_idx/);
  assert.match(
    migration,
    /billing_period,[\s\S]*?coalesce\(newapi_created_at, last_synced_at\) desc,[\s\S]*?id[\s\S]*?where match_status in \('matched', 'no_proxy_match'\)/,
  );
  assert.match(migration, /quota_operations_updated_idx/);
  assert.match(migration, /quota_operations_user_updated_idx/);
  assert.match(migration, /quota_reconciliation_token_period_idx/);
  assert.match(
    postgresStore,
    /REQUIRED_POSTGRES_TABLES[\s\S]*?"quota_balance_observer_state"/,
  );
  const requiredTableSection = postgresStore.slice(
    postgresStore.indexOf("export const REQUIRED_POSTGRES_TABLES = ["),
    postgresStore.indexOf("] as const;", postgresStore.indexOf("export const REQUIRED_POSTGRES_TABLES = [")),
  );
  assert.equal(requiredTableSection.match(/"[a-z_]+"/g)?.length, 23);
});

test("同一用户账期得到稳定且不泄露身份的确定性记录 ID", () => {
  const first = quotaBalanceObservationRecordId("open-id-sensitive", "2026-07");
  const second = quotaBalanceObservationRecordId("open-id-sensitive", "2026-07");
  const nextPeriod = quotaBalanceObservationRecordId(
    "open-id-sensitive",
    "2026-08",
  );
  assert.equal(first, second);
  assert.notEqual(first, nextPeriod);
  assert.doesNotMatch(first, /open-id-sensitive/);
  assert.match(first, /^qbo_[0-9a-f]{32}$/);
});
