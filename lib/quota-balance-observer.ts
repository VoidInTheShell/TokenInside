import { getConfig } from "@/lib/config";
import { nowIso } from "@/lib/crypto";
import { getNewApiTokenRemainQuota } from "@/lib/newapi";
import {
  isPostgresAdvisoryLockBusyError,
  getPostgresAppSettings,
  withPostgresAdvisoryLock,
  withPostgresControlClient,
} from "@/lib/postgres-store";
import {
  assertQuotaExecutionFenceHeld,
  isQuotaExecutionFenceLostError,
} from "@/lib/quota-execution-fence";
import {
  classifyQuotaReconciliation,
} from "@/lib/quota-model";
import { packageBillingPeriod } from "@/lib/package-reset";
import {
  buildQuotaBalanceObservationRecord,
  quotaBalanceObservationRecordId,
  type QuotaBalanceObservationCandidate as ObservationCandidate,
} from "@/lib/quota-balance-observation-state";
import type {
  QuotaReconciliationRecord,
  QuotaReconciliationStatus,
  TokenAccount,
  UsageSyncCheckpoint,
  UsageSyncIssue,
  UserBillingPeriod,
  UserQuotaState,
} from "@/lib/types";

const observerLockKey = "quota-balance-observer:v1";
const observerStateId = "default";
const observerConcurrency = 2;

type ObservationSnapshot = {
  account: TokenAccount | null;
  billing: UserBillingPeriod | null;
  quota_state: UserQuotaState | null;
  has_open_operation: boolean;
  has_inflight_request: boolean;
  checkpoint: UsageSyncCheckpoint | null;
  blocking_issue: UsageSyncIssue | null;
  previous_record: QuotaReconciliationRecord | null;
};

type ObservationRunResult = {
  status: "completed" | "busy" | "disabled";
  scanned: number;
  healthy: number;
  provisional: number;
  nonHealthy: number;
  failed: number;
};

type ObserverRuntime = {
  version: 1;
  started: boolean;
  running: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

type ObserverGlobal = typeof globalThis & {
  __tokenInsideQuotaBalanceObserverRuntimeV1?: ObserverRuntime;
};

const observerGlobal = globalThis as ObserverGlobal;
const observerRuntime =
  (observerGlobal.__tokenInsideQuotaBalanceObserverRuntimeV1 ??= {
    version: 1,
    started: false,
    running: false,
  });

function finiteQuota(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

async function listObservationCandidates(batchSize: number) {
  assertQuotaExecutionFenceHeld();
  return withPostgresControlClient(async (client) => {
    const state = await client.query<{ cursor_feishu_user_id: string | null }>(
      `select cursor_feishu_user_id
       from quota_balance_observer_state
       where id = $1
       limit 1`,
      [observerStateId],
    );
    const cursor = state.rows[0]?.cursor_feishu_user_id ?? "";
    const forward = await client.query<ObservationCandidate>(
      `select
         id,
         feishu_user_id as "feishuUserId",
         newapi_token_id as "newapiTokenId",
         operation_generation as "operationGeneration"
       from token_accounts
       where status = 'active'
         and newapi_token_id is not null
         and feishu_user_id > $1
       order by feishu_user_id, id
       limit $2`,
      [cursor, batchSize],
    );
    const candidates = [...forward.rows];
    const remaining = batchSize - candidates.length;
    if (remaining > 0 && cursor) {
      const wrapped = await client.query<ObservationCandidate>(
        `select
           id,
           feishu_user_id as "feishuUserId",
           newapi_token_id as "newapiTokenId",
           operation_generation as "operationGeneration"
         from token_accounts
         where status = 'active'
           and newapi_token_id is not null
           and feishu_user_id <= $1
         order by feishu_user_id, id
         limit $2`,
        [cursor, remaining],
      );
      candidates.push(...wrapped.rows);
    }
    return candidates;
  });
}

async function saveObservationCursor(feishuUserId: string, observedAt: string) {
  assertQuotaExecutionFenceHeld();
  await withPostgresControlClient((client) =>
    client.query(
      `insert into quota_balance_observer_state
         (id, cursor_feishu_user_id, last_run_at, updated_at)
       values ($1, $2, $3, $3)
       on conflict (id) do update set
         cursor_feishu_user_id = excluded.cursor_feishu_user_id,
         last_run_at = excluded.last_run_at,
         updated_at = excluded.updated_at`,
      [observerStateId, feishuUserId, observedAt],
    ),
  );
}

async function readObservationSnapshot(
  candidate: ObservationCandidate,
  period: string,
  recordId: string,
  observedAt: string,
) {
  assertQuotaExecutionFenceHeld();
  return withPostgresControlClient(async (client) => {
    const result = await client.query<ObservationSnapshot>(
      `select
         account.data as account,
         billing.data as billing,
         quota_state.data as quota_state,
         exists (
           select 1
           from quota_operations operation
           where operation.feishu_user_id = $2
             and operation.state not in ('completed', 'compensated', 'cancelled')
         ) as has_open_operation,
         exists (
           select 1
           from proxy_request_logs proxy_log
           where proxy_log.feishu_user_id = $2
             and proxy_log.operation_generation = coalesce(
               quota_state.active_generation,
               -1
             )
             and proxy_log.status_code = 0
             and proxy_log.data->>'status' in ('pending', 'streaming')
             and (
               proxy_log.lease_expires_at is null
               or proxy_log.lease_expires_at > $5::timestamptz
             )
         ) as has_inflight_request,
         (
           select checkpoint.data
           from usage_sync_checkpoints checkpoint
           where checkpoint.scope = 'newapi_usage_logs'
           order by checkpoint.updated_at desc
           limit 1
         ) as checkpoint,
         (
           select issue.data
           from usage_sync_issues issue
           where issue.status = 'open'
             and coalesce(
               nullif(issue.data->>'blocksSettlement', '')::boolean,
               false
             )
           order by coalesce(
             nullif(issue.data->>'occurredAt', '')::timestamptz,
             issue.first_seen_at
           ), issue.id
           limit 1
         ) as blocking_issue,
         previous.data as previous_record
       from (values (1)) singleton(value)
       left join token_accounts account
         on account.id = $1 and account.feishu_user_id = $2
       left join user_billing_periods billing
         on billing.feishu_user_id = $2 and billing.period = $3
       left join user_quota_states quota_state
         on quota_state.feishu_user_id = $2
       left join quota_reconciliation_records previous
         on previous.id = $4
       limit 1`,
      [candidate.id, candidate.feishuUserId, period, recordId, observedAt],
    );
    return result.rows[0];
  });
}

function unstableSnapshotReason(
  candidate: ObservationCandidate,
  snapshot: ObservationSnapshot,
) {
  if (
    !snapshot.account ||
    snapshot.account.status !== "active" ||
    snapshot.account.newapiTokenId !== candidate.newapiTokenId
  ) {
    return "active_account_changed";
  }
  if (!snapshot.billing || !finiteQuota(snapshot.billing.expectedAvailableQuota)) {
    return "billing_snapshot_unavailable";
  }
  if (!snapshot.quota_state) return "quota_state_unavailable";
  if (
    snapshot.quota_state.admission !== "open" ||
    snapshot.quota_state.operationId
  ) {
    return "quota_admission_closed";
  }
  if (
    snapshot.quota_state.activeGeneration !== candidate.operationGeneration
  ) {
    return "account_generation_changed";
  }
  if (
    snapshot.billing.activeTokenAccountId &&
    snapshot.billing.activeTokenAccountId !== candidate.id
  ) {
    return "billing_token_projection_changed";
  }
  if (snapshot.has_open_operation) return "quota_operation_in_progress";
  if (snapshot.has_inflight_request) return "proxy_request_inflight";
  if (!snapshot.checkpoint) return "usage_checkpoint_unavailable";
  if (snapshot.checkpoint.lastRunStatus !== "applied") {
    return "usage_scan_not_complete";
  }
  if (
    !snapshot.checkpoint.settledThrough ||
    snapshot.checkpoint.integrityBlockedAt ||
    snapshot.blocking_issue
  ) {
    return "usage_settlement_blocked";
  }
  if (snapshot.billing.settledThrough !== snapshot.checkpoint.settledThrough) {
    return "billing_materialization_behind";
  }
  return undefined;
}

function localSnapshotChangedDuringObservation(
  before: ObservationSnapshot,
  after: ObservationSnapshot,
) {
  return (
    before.account?.status !== after.account?.status ||
    before.account?.newapiTokenId !== after.account?.newapiTokenId ||
    before.account?.operationGeneration !== after.account?.operationGeneration ||
    before.billing?.expectedAvailableQuota !==
      after.billing?.expectedAvailableQuota ||
    before.billing?.materializedAt !== after.billing?.materializedAt ||
    before.billing?.activeTokenAccountId !== after.billing?.activeTokenAccountId ||
    before.quota_state?.admission !== after.quota_state?.admission ||
    before.quota_state?.activeGeneration !==
      after.quota_state?.activeGeneration ||
    before.quota_state?.operationId !== after.quota_state?.operationId ||
    before.quota_state?.updatedAt !== after.quota_state?.updatedAt ||
    before.checkpoint?.updatedAt !== after.checkpoint?.updatedAt ||
    before.checkpoint?.settledThrough !== after.checkpoint?.settledThrough ||
    before.checkpoint?.integrityBlockedAt !==
      after.checkpoint?.integrityBlockedAt
  );
}

async function saveObservationRecord(record: QuotaReconciliationRecord) {
  assertQuotaExecutionFenceHeld();
  await withPostgresControlClient((client) =>
    client.query(
      `insert into quota_reconciliation_records
         (id, feishu_user_id, token_account_id, period, status, operation_id,
          data, created_at, updated_at)
       values ($1, $2, $3, $4, $5, null, $6, $7, $8)
       on conflict (id) do update set
         token_account_id = excluded.token_account_id,
         status = excluded.status,
         operation_id = null,
         data = excluded.data,
         updated_at = excluded.updated_at`,
      [
        record.id,
        record.feishuUserId,
        record.tokenAccountId ?? null,
        record.period,
        record.status,
        record,
        record.createdAt,
        record.updatedAt,
      ],
    ),
  );
}

async function observeCandidate(
  candidate: ObservationCandidate,
  period: string,
  observedAt: string,
) {
  const id = quotaBalanceObservationRecordId(candidate.feishuUserId, period);
  const snapshot = await readObservationSnapshot(
    candidate,
    period,
    id,
    observedAt,
  );
  const expectedAvailableQuota = finiteQuota(
    snapshot.billing?.expectedAvailableQuota,
  )
    ? snapshot.billing.expectedAvailableQuota
    : snapshot.previous_record?.expectedAvailableQuota ?? 0;
  const unstableReason = unstableSnapshotReason(candidate, snapshot);
  if (unstableReason) {
    const record = buildQuotaBalanceObservationRecord({
      id,
      candidate,
      period,
      expectedAvailableQuota,
      classifiedStatus: "provisional",
      stable: false,
      reason: unstableReason,
      settledThrough: snapshot.checkpoint?.settledThrough,
      previous: snapshot.previous_record,
      observedAt,
    });
    await saveObservationRecord(record);
    return record.status;
  }

  const timeoutMs = getConfig().billing.balanceObservationReadTimeoutMs;
  let firstObservedRemainQuota: number | undefined;
  let secondObservedRemainQuota: number | undefined;
  try {
    firstObservedRemainQuota = await getNewApiTokenRemainQuota(
      candidate.newapiTokenId,
      { timeoutMs, requireUsable: true },
    );
    secondObservedRemainQuota = await getNewApiTokenRemainQuota(
      candidate.newapiTokenId,
      { timeoutMs, requireUsable: true },
    );
  } catch (error) {
    if (isQuotaExecutionFenceLostError(error)) throw error;
    const record = buildQuotaBalanceObservationRecord({
      id,
      candidate,
      period,
      expectedAvailableQuota,
      classifiedStatus: "provisional",
      stable: false,
      reason: "upstream_observation_failed",
      settledThrough: snapshot.checkpoint?.settledThrough,
      previous: snapshot.previous_record,
      observedAt,
    });
    await saveObservationRecord(record);
    return record.status;
  }

  const observedStable =
    finiteQuota(firstObservedRemainQuota) &&
    finiteQuota(secondObservedRemainQuota) &&
    firstObservedRemainQuota === secondObservedRemainQuota;
  const observedRemainQuota =
    finiteQuota(firstObservedRemainQuota) &&
    finiteQuota(secondObservedRemainQuota)
      ? Math.min(firstObservedRemainQuota, secondObservedRemainQuota)
      : undefined;
  // The upstream reads intentionally hold no control-pool connection. Close
  // that race window with a second point snapshot before classifying or
  // persisting a final result.
  const verifiedSnapshot = await readObservationSnapshot(
    candidate,
    period,
    id,
    nowIso(),
  );
  const verificationReason =
    unstableSnapshotReason(candidate, verifiedSnapshot) ??
    (localSnapshotChangedDuringObservation(snapshot, verifiedSnapshot)
      ? "local_snapshot_changed_during_observation"
      : undefined);
  if (verificationReason) {
    const record = buildQuotaBalanceObservationRecord({
      id,
      candidate,
      period,
      expectedAvailableQuota: finiteQuota(
        verifiedSnapshot.billing?.expectedAvailableQuota,
      )
        ? verifiedSnapshot.billing.expectedAvailableQuota
        : expectedAvailableQuota,
      observedRemainQuota,
      firstObservedRemainQuota,
      secondObservedRemainQuota,
      classifiedStatus: "provisional",
      stable: false,
      reason: verificationReason,
      settledThrough: verifiedSnapshot.checkpoint?.settledThrough,
      previous: verifiedSnapshot.previous_record,
      observedAt,
    });
    await saveObservationRecord(record);
    return record.status;
  }
  const classifiedStatus = classifyQuotaReconciliation({
    expectedAvailableQuota:
      verifiedSnapshot.billing?.expectedAvailableQuota ??
      expectedAvailableQuota,
    observedRemainQuota,
    settled: true,
    hasInflightRequests: false,
    hasNonTerminalOperation: false,
    observedStable,
  });
  const record = buildQuotaBalanceObservationRecord({
    id,
    candidate,
    period,
    expectedAvailableQuota:
      verifiedSnapshot.billing?.expectedAvailableQuota ??
      expectedAvailableQuota,
    observedRemainQuota,
    firstObservedRemainQuota,
    secondObservedRemainQuota,
    classifiedStatus,
    stable: observedStable,
    reason: observedStable ? "stable_upstream_observation" : "upstream_observation_changed",
    settledThrough: verifiedSnapshot.checkpoint?.settledThrough,
    previous: verifiedSnapshot.previous_record,
    observedAt,
  });
  await saveObservationRecord(record);
  return record.status;
}

async function runBoundedCandidateBatch(
  candidates: ObservationCandidate[],
  period: string,
  observedAt: string,
) {
  const outcomes = new Array<QuotaReconciliationStatus | "failed">(
    candidates.length,
  );
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const candidate = candidates[index];
      if (!candidate) return;
      try {
        outcomes[index] = await observeCandidate(candidate, period, observedAt);
      } catch (error) {
        if (isQuotaExecutionFenceLostError(error)) throw error;
        outcomes[index] = "failed";
        console.error(
          JSON.stringify({
            event: "tokeninside.quota_balance_observation_user_failed",
            feishuUserId: candidate.feishuUserId,
            tokenAccountId: candidate.id,
            error: error instanceof Error ? error.message : "unknown failure",
          }),
        );
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(observerConcurrency, candidates.length) },
      () => worker(),
    ),
  );
  return outcomes;
}

export async function runQuotaBalanceObservationOnce(): Promise<ObservationRunResult> {
  const config = getConfig();
  if (config.storeBackend !== "postgres") {
    return {
      status: "disabled",
      scanned: 0,
      healthy: 0,
      provisional: 0,
      nonHealthy: 0,
      failed: 0,
    };
  }
  try {
    return await withPostgresAdvisoryLock(
      observerLockKey,
      async () => {
        const observedAt = nowIso();
        const settings = await getPostgresAppSettings();
        const period = packageBillingPeriod(
          settings.packageReset,
          new Date(observedAt),
        );
        const candidates = await listObservationCandidates(
          config.billing.balanceObservationBatchSize,
        );
        const outcomes = await runBoundedCandidateBatch(
          candidates,
          period,
          observedAt,
        );
        const lastCandidate = candidates.at(-1);
        if (lastCandidate) {
          await saveObservationCursor(lastCandidate.feishuUserId, observedAt);
        }
        const healthy = outcomes.filter((status) => status === "healthy").length;
        const provisional = outcomes.filter(
          (status) => status === "provisional",
        ).length;
        const failed = outcomes.filter((status) => status === "failed").length;
        return {
          status: "completed",
          scanned: candidates.length,
          healthy,
          provisional,
          nonHealthy: outcomes.length - healthy - provisional - failed,
          failed,
        };
      },
      { wait: false, executionFence: true },
    );
  } catch (error) {
    if (isPostgresAdvisoryLockBusyError(error)) {
      return {
        status: "busy",
        scanned: 0,
        healthy: 0,
        provisional: 0,
        nonHealthy: 0,
        failed: 0,
      };
    }
    throw error;
  }
}

function scheduleQuotaBalanceObservation(delayMs: number) {
  if (observerRuntime.timer) clearTimeout(observerRuntime.timer);
  observerRuntime.timer = setTimeout(async () => {
    observerRuntime.timer = undefined;
    const intervalMs = getConfig().billing.balanceObservationIntervalMs;
    if (observerRuntime.running) {
      scheduleQuotaBalanceObservation(intervalMs);
      return;
    }
    observerRuntime.running = true;
    try {
      await runQuotaBalanceObservationOnce();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "tokeninside.quota_balance_observer_failed",
          error: error instanceof Error ? error.message : "unknown failure",
        }),
      );
    } finally {
      observerRuntime.running = false;
      scheduleQuotaBalanceObservation(intervalMs);
    }
  }, Math.max(Math.trunc(delayMs), 0));
  observerRuntime.timer.unref?.();
}

export function ensureQuotaBalanceObserver() {
  const config = getConfig();
  if (config.storeBackend !== "postgres" || observerRuntime.started) return;
  observerRuntime.started = true;
  scheduleQuotaBalanceObservation(config.billing.balanceObservationIntervalMs);
}
