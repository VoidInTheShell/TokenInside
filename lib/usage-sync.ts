import { listNewApiUsageLogs } from "@/lib/newapi";
import type { NormalizedNewApiUsageLog } from "@/lib/newapi";
import { getConfig } from "@/lib/config";
import { nowIso, randomId } from "@/lib/crypto";
import { assertQuotaExecutionFenceHeld } from "@/lib/quota-execution-fence";
import {
  fixedUsageSyncWindow,
  isSettlementWatermarkFresh,
} from "@/lib/quota-model";
import { packageBillingPeriod } from "@/lib/package-reset";
import {
  drainBillingPeriodFinalizations,
  finalizeBillingPeriodAfterSettlements,
} from "@/lib/billing-period-finalizer";
import {
  deferPostgresCoveredPendingUsageSettlements,
  getPostgresPendingUsageSettlementHorizon,
  isPostgresAdvisoryLockBusyError,
  listPostgresAuthoritativeUsageBillingMaterializationTargets,
  withPostgresAdvisoryLock,
} from "@/lib/postgres-store";
import {
  backfillProxyLogsFromNewApiUsage,
  claimBillingOperationExecution,
  defaultUsageSyncPolicy,
  enqueueBillingOperation,
  findBillingOperationById,
  getAppSettings,
  getEarliestOpenBlockingUsageIssue,
  getUsageSyncCheckpoint,
  listRunnableBillingOperations,
  recordBillingOperation,
  rebuildQuotaMaterializedSnapshots,
  renewBillingOperationExecution,
  saveUsageSyncCheckpoint,
  type NewApiUsageBackfillResult,
} from "@/lib/store";
import type {
  BillingOperationRecord,
  UsageSyncPolicy,
  UsageSyncRunStatus,
} from "@/lib/types";

type UsageSyncTrigger = "manual" | "auto";

export type ManualUsageSyncOperationInput = {
  dryRun: boolean;
  page?: number;
  size: number;
  maxPages: number;
  overlapMinutes: number;
  settlementLagMinutes: number;
  matchWindowMinutes: number;
  retryBaseMinutes: number;
  operatedByFeishuUserId: string;
};

export type NewApiUsageSyncPageResult = {
  page: number;
  size: number;
  fetched: number;
  total: number;
  backfill: NewApiUsageBackfillResult;
};

export type NewApiUsageSyncResult = {
  dryRun: boolean;
  pageStart: number;
  size: number;
  maxPages: number;
  runId: string;
  scanStart: string;
  scanEnd: string;
  scanTargetEnd: string;
  scanMode: "forward" | "repair";
  completedSlice: boolean;
  completedWindow: boolean;
  status: UsageSyncRunStatus;
  pages: NewApiUsageSyncPageResult[];
  totals: {
    fetched: number;
    seen: number;
    matched: number;
    updated: number;
    skippedUnknownToken: number;
    skippedNoMatch: number;
    recordsUpserted: number;
    issuesUpserted: number;
    snapshotProxyCandidates: number;
    snapshotUsageRecords: number;
    snapshotFallbackProxyCandidates: number;
  };
  checkpoint?: {
    lastRunAt: string;
    lastRunStatus?: UsageSyncRunStatus;
    nextRunAfter?: string;
    lastSeenNewapiLogId?: string;
    lastSeenNewapiCreatedAt?: string;
    ingestedThrough?: string;
    settledThrough?: string;
    integrityBlockedAt?: string;
    integrityBlockedIssueId?: string;
    cursorPage?: number;
    scanExpectedTotal?: number;
    scanFirstIdentity?: string;
    scanMode?: "forward" | "repair";
    repairCursorThrough?: string;
    repairWindowStart?: string;
    repairWindowEnd?: string;
  };
};

const usageSyncSliceSeconds = 30;
const usageSyncRepairSliceSeconds = 30;
const usageSyncTargetRowsPerSlice = 2_000;
const usageSyncRepairSlicesPerCycle = 15;
const usageSyncRepairPreemptForwardLagSeconds = 60;

type UsageSyncScanWindow = {
  scanStart: string;
  scanEnd: string;
  scanTargetEnd: string;
  scanMode: "forward" | "repair";
  repairWindowStart?: string;
  repairWindowEnd?: string;
};

const usageSyncLockKey = "usage_sync:newapi_logs";
const billingMaterializationRecoveryRetryDelayMs = 60_000;

type UsageSyncRuntimeState = {
  jsonUsageSyncRunning: boolean;
  schedulerStarted: boolean;
  schedulerTimer: ReturnType<typeof setTimeout> | undefined;
  schedulerNextTickAt: number | undefined;
  schedulerTickRunning: boolean;
  schedulerForceScanRequested: boolean;
  schedulerTailRefreshRequested: boolean;
  schedulerTailRefreshDirty: boolean;
  schedulerRepairSlicesRemaining: number;
  schedulerRepairBudgetRefillNotBeforeEpochMs: number;
  schedulerScanRetryNotBeforeEpochMs: number;
  schedulerTransientFailureCount: number;
  durablePendingTailObserved: boolean;
  durablePendingTailCount: number;
  durablePendingTailManualReviewCount: number;
  durablePendingTailRequiredThrough: string | undefined;
  durablePendingTailNextDueEpochMs: number;
  durablePendingTailLastRefreshEpochMs: number;
  durablePendingTailNextRefreshEpochMs: number;
  recoveryRequested: boolean;
  recoveryRunning: boolean;
  recoveryPromise: Promise<number> | undefined;
  recoveryNotBeforeEpochMs: number;
  recoveryLastTargetCount: number;
  recoveryLastErrorAt: string | undefined;
  activeImmediateSettlements: number;
  immediateSettlementIdlePromise: Promise<void> | undefined;
  resolveImmediateSettlementIdle: (() => void) | undefined;
};

type UsageSyncGlobalRuntime = typeof globalThis & {
  __tokenInsideUsageSyncRuntime?: UsageSyncRuntimeState;
};

// Next.js emits instrumentation and route handlers into independent server
// chunks. A module-local timer/force bit/token bucket creates multiple workers
// inside one Node process, so every mutable scheduler and immediate-settlement
// field must live behind one process-global object.
const usageSyncGlobalRuntime = globalThis as UsageSyncGlobalRuntime;
const usageSyncRuntime =
  usageSyncGlobalRuntime.__tokenInsideUsageSyncRuntime ??=
    {
      jsonUsageSyncRunning: false,
      schedulerStarted: false,
      schedulerTimer: undefined,
      schedulerNextTickAt: undefined,
      schedulerTickRunning: false,
      schedulerForceScanRequested: false,
      schedulerTailRefreshRequested: false,
      schedulerTailRefreshDirty: false,
      schedulerRepairSlicesRemaining: 0,
      schedulerRepairBudgetRefillNotBeforeEpochMs: 0,
      schedulerScanRetryNotBeforeEpochMs: 0,
      schedulerTransientFailureCount: 0,
      durablePendingTailObserved: false,
      durablePendingTailCount: 0,
      durablePendingTailManualReviewCount: 0,
      durablePendingTailRequiredThrough: undefined,
      durablePendingTailNextDueEpochMs: 0,
      durablePendingTailLastRefreshEpochMs: 0,
      durablePendingTailNextRefreshEpochMs: 0,
      recoveryRequested: true,
      recoveryRunning: false,
      recoveryPromise: undefined,
      recoveryNotBeforeEpochMs: 0,
      recoveryLastTargetCount: 0,
      recoveryLastErrorAt: undefined,
      activeImmediateSettlements: 0,
      immediateSettlementIdlePromise: undefined,
      resolveImmediateSettlementIdle: undefined,
    };

function tryAcquireImmediateSettlementSlot() {
  if (usageSyncRuntime.activeImmediateSettlements >= getConfig().billing.settlementConcurrencyMax) return null;
  usageSyncRuntime.activeImmediateSettlements += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    usageSyncRuntime.activeImmediateSettlements = Math.max(usageSyncRuntime.activeImmediateSettlements - 1, 0);
    if (usageSyncRuntime.activeImmediateSettlements === 0) {
      const resolveIdle = usageSyncRuntime.resolveImmediateSettlementIdle;
      usageSyncRuntime.immediateSettlementIdlePromise = undefined;
      usageSyncRuntime.resolveImmediateSettlementIdle = undefined;
      resolveIdle?.();
    }
  };
}

function waitForImmediateSettlementsToDrain() {
  if (usageSyncRuntime.activeImmediateSettlements === 0) return Promise.resolve();
  if (!usageSyncRuntime.immediateSettlementIdlePromise) {
    usageSyncRuntime.immediateSettlementIdlePromise = new Promise<void>((resolve) => {
      usageSyncRuntime.resolveImmediateSettlementIdle = resolve;
    });
  }
  return usageSyncRuntime.immediateSettlementIdlePromise;
}

export function billingMaterializationRecoverySnapshot() {
  const postgresEnabled = getConfig().storeBackend === "postgres";
  return {
    requested: postgresEnabled && usageSyncRuntime.recoveryRequested,
    running: postgresEnabled && usageSyncRuntime.recoveryRunning,
    lastTargetCount: postgresEnabled ? usageSyncRuntime.recoveryLastTargetCount : 0,
    lastErrorAt: postgresEnabled ? usageSyncRuntime.recoveryLastErrorAt : undefined,
    nextRetryAt:
      postgresEnabled && usageSyncRuntime.recoveryRequested && usageSyncRuntime.recoveryNotBeforeEpochMs > Date.now()
        ? new Date(usageSyncRuntime.recoveryNotBeforeEpochMs).toISOString()
        : undefined,
  };
}

const immediateSettlementDefaults = {
  maxAttempts: 6,
  retryDelayMs: 750,
  pageSize: 100,
  matchWindowMs: 10 * 60 * 1000,
};

function addMinutes(value: string, minutes: number) {
  return new Date(new Date(value).getTime() + minutes * 60 * 1000).toISOString();
}

function addMilliseconds(value: string, milliseconds: number) {
  return new Date(new Date(value).getTime() + milliseconds).toISOString();
}

function floorEpochSecond(value: string) {
  return Math.floor(new Date(value).getTime() / 1000);
}

function epochSecondIso(value: number) {
  return new Date(value * 1000).toISOString();
}

function isResumableUsageSyncCheckpoint(
  checkpoint: Awaited<ReturnType<typeof getUsageSyncCheckpoint>>,
) {
  return Boolean(
    checkpoint?.runId &&
      checkpoint.scanStart &&
      checkpoint.scanEnd &&
      checkpoint.scanTargetEnd &&
      checkpoint.scanMode &&
      checkpoint.cursorPage !== undefined &&
      (checkpoint.cursorPage === 0 ||
        (checkpoint.scanExpectedTotal !== undefined &&
          checkpoint.scanFirstIdentity !== undefined)) &&
      checkpoint.lastRunStatus !== "applied",
  );
}

function initialForwardUsageSyncWindow(input: {
  runStartedAt: string;
  settledThrough?: string;
  overlapMinutes: number;
  settlementLagMinutes: number;
}) {
  const fixed = fixedUsageSyncWindow(input);
  const targetEndSecond = floorEpochSecond(fixed.scanEnd);
  // Once a durable inclusive watermark exists, move forward from that second
  // instead of replaying the whole repair overlap on every run. The shared
  // boundary second is intentionally read again and absorbed by idempotency.
  const startSecond = input.settledThrough
    ? Math.min(floorEpochSecond(input.settledThrough), targetEndSecond)
    : floorEpochSecond(fixed.scanStart);
  return {
    scanStart: epochSecondIso(startSecond),
    scanEnd: epochSecondIso(
      Math.min(startSecond + usageSyncSliceSeconds - 1, targetEndSecond),
    ),
    scanTargetEnd: epochSecondIso(targetEndSecond),
    scanMode: "forward" as const,
  };
}

function nextForwardUsageSyncSlice(input: {
  scanEnd: string;
  scanTargetEnd: string;
  sliceSeconds?: number;
}) {
  const startSecond = floorEpochSecond(input.scanEnd);
  const targetEndSecond = floorEpochSecond(input.scanTargetEnd);
  const sliceSeconds = Math.max(
    Math.trunc(input.sliceSeconds ?? usageSyncSliceSeconds),
    1,
  );
  return {
    scanStart: epochSecondIso(startSecond),
    scanEnd: epochSecondIso(
      Math.min(startSecond + sliceSeconds - 1, targetEndSecond),
    ),
    scanTargetEnd: epochSecondIso(targetEndSecond),
    scanMode: "forward" as const,
  };
}

function nextRepairUsageSyncSlice(input: {
  settledThrough: string;
  repairCursorThrough?: string;
  repairWindowStart?: string;
  repairWindowEnd?: string;
  overlapMinutes: number;
}): UsageSyncScanWindow {
  const settledSecond = floorEpochSecond(input.settledThrough);
  const storedWindowStartSecond = input.repairWindowStart
    ? floorEpochSecond(input.repairWindowStart)
    : undefined;
  const storedWindowEndSecond = input.repairWindowEnd
    ? floorEpochSecond(input.repairWindowEnd)
    : undefined;
  const storedCursorSecond = input.repairCursorThrough
    ? floorEpochSecond(input.repairCursorThrough)
    : undefined;
  const canContinueFrozenWindow = Boolean(
    storedWindowStartSecond !== undefined &&
      storedWindowEndSecond !== undefined &&
      storedCursorSecond !== undefined &&
      storedCursorSecond >= storedWindowStartSecond &&
      storedCursorSecond < storedWindowEndSecond,
  );
  const repairWindowStartSecond = canContinueFrozenWindow
    ? storedWindowStartSecond!
    : settledSecond - input.overlapMinutes * 60;
  const repairWindowEndSecond = canContinueFrozenWindow
    ? storedWindowEndSecond!
    : settledSecond;
  const startSecond = canContinueFrozenWindow
    ? storedCursorSecond!
    : repairWindowStartSecond;
  const endSecond = Math.min(
    startSecond + usageSyncRepairSliceSeconds - 1,
    repairWindowEndSecond,
  );
  return {
    scanStart: epochSecondIso(startSecond),
    scanEnd: epochSecondIso(endSecond),
    scanTargetEnd: epochSecondIso(endSecond),
    scanMode: "repair" as const,
    repairWindowStart: epochSecondIso(repairWindowStartSecond),
    repairWindowEnd: epochSecondIso(repairWindowEndSecond),
  };
}

function statusFromError(pageCount: number) {
  return pageCount > 0 ? "partial_failed" : "failed";
}

function settlementWatermarkBeforeIntegrityBlock(
  settledThrough: string | undefined,
  integrityBlockedAt: string | undefined,
) {
  if (!settledThrough || !integrityBlockedAt) return settledThrough;
  if (floorEpochSecond(settledThrough) < floorEpochSecond(integrityBlockedAt)) {
    return settledThrough;
  }
  return epochSecondIso(floorEpochSecond(integrityBlockedAt) - 1);
}

async function withUsageSyncLock<T>(dryRun: boolean, fn: () => Promise<T>) {
  if (dryRun) return fn();
  if (getConfig().storeBackend === "postgres") {
    return withPostgresAdvisoryLock(usageSyncLockKey, fn, {
      executionFence: true,
    });
  }
  if (usageSyncRuntime.jsonUsageSyncRunning) {
    throw new Error(`${usageSyncLockKey} is already running`);
  }
  usageSyncRuntime.jsonUsageSyncRunning = true;
  try {
    return await fn();
  } finally {
    usageSyncRuntime.jsonUsageSyncRunning = false;
  }
}

export type QuotaBarrierUsageIngestionResult = {
  status:
    | "not_mature"
    | "checkpoint_behind"
    | "busy"
    | "unstable"
    | "too_large"
    | "integrity_blocked"
    | "completed";
  scanStart: string;
  scanEnd: string;
  matureAt: string;
  total?: number;
  firstIdentity?: string;
  pages?: number;
  affectedUsers?: number;
  integrityBlockedAt?: string;
  integrityBlockedIssueId?: string;
};

const quotaBarrierMaxRows = 50_000;

/**
 * Completes a bounded, stable NewAPI usage scan for an upstream-disable
 * accounting barrier. Unlike the low-priority two-hour repair cursor, this
 * scan is allowed to consume the complete relevant window in one control task
 * so quota changes do not leave a user's Key disabled for ~95 minutes.
 */
export async function ingestQuotaBarrierUsage(input: {
  upstreamDisabledAt: string;
  cutoffAt: string;
  billingPeriod: string;
}): Promise<QuotaBarrierUsageIngestionResult> {
  const settings = await getAppSettings();
  const policy = settings.usageSyncPolicy ?? defaultUsageSyncPolicy();
  const settlementLagMs =
    Math.max(
      policy.settlementLagMinutes ??
        defaultUsageSyncPolicy().settlementLagMinutes ??
        1,
      0,
    ) * 60_000;
  const cutoffTime = Date.parse(input.cutoffAt);
  const disabledTime = Date.parse(input.upstreamDisabledAt);
  if (!Number.isFinite(cutoffTime) || !Number.isFinite(disabledTime)) {
    throw new Error("额度操作消费结算屏障时间无效");
  }
  const matureAt = new Date(cutoffTime + settlementLagMs).toISOString();
  const periodStart = Date.parse(`${input.billingPeriod}-01T00:00:00+08:00`);
  const maxRequestWindowMs =
    getConfig().billing.directConsumptionDrainGraceMs;
  let scanStart = new Date(
    Math.max(disabledTime - maxRequestWindowMs, periodStart),
  ).toISOString();
  const scanEnd = input.cutoffAt;
  if (Date.now() < cutoffTime + settlementLagMs) {
    return { status: "not_mature", scanStart, scanEnd, matureAt };
  }
  try {
    return await withUsageSyncLock(false, async () => {
      const checkpoint = await getUsageSyncCheckpoint("newapi_usage_logs");
      if (checkpoint?.integrityBlockedAt) {
        return {
          status: "integrity_blocked",
          scanStart,
          scanEnd,
          matureAt,
          integrityBlockedAt: checkpoint.integrityBlockedAt,
          integrityBlockedIssueId: checkpoint.integrityBlockedIssueId,
        };
      }
      const checkpointFresh = isSettlementWatermarkFresh({
        settledThrough: checkpoint?.settledThrough,
        maxLagMinutes:
          2 * Math.max(policy.intervalMinutes, 1) +
          settlementLagMs / 60_000,
      });
      // A later global run may be continuation_pending even though its durable
      // watermark is still trustworthy. The dedicated scan below runs under
      // the same lock, includes any gap behind that watermark, and verifies the
      // complete quota window after its own settlement lag. Do not wait for the
      // low-priority global cursor to cover this operation's later cutoff.
      if (!checkpointFresh) {
        return {
          status: "checkpoint_behind",
          scanStart,
          scanEnd,
          matureAt,
        };
      }
      const checkpointSettled = Date.parse(checkpoint!.settledThrough!);
      scanStart = new Date(
        Math.max(
          Math.min(
            disabledTime - maxRequestWindowMs,
            checkpointSettled,
          ),
          periodStart,
        ),
      ).toISOString();
      const pageSize = 100;
      const startTimestamp = floorEpochSecond(scanStart);
      const endTimestamp = floorEpochSecond(scanEnd);
      const baseline = await listNewApiUsageLogs({
        page: 0,
        size: 1,
        startTimestamp,
        endTimestamp,
      });
      const expectedTotal = baseline.total;
      const expectedFirstIdentity = scanFirstIdentity(baseline.items);
      if (expectedTotal > quotaBarrierMaxRows) {
        return {
          status: "too_large",
          scanStart,
          scanEnd,
          matureAt,
          total: expectedTotal,
          firstIdentity: expectedFirstIdentity,
        };
      }

      const pageCount = Math.max(Math.ceil(expectedTotal / pageSize), 1);
      const backfills: NewApiUsageBackfillResult[] = [];
      const reservedProxyLogIds: string[] = [];
      let integrityBlockedAt: string | undefined;
      let integrityBlockedIssueId: string | undefined;
      for (let page = 0; page < pageCount; page += 1) {
        const logsPage = await listNewApiUsageLogs({
          page,
          size: pageSize,
          startTimestamp,
          endTimestamp,
        });
        if (
          logsPage.total !== expectedTotal ||
          (page === 0 &&
            scanFirstIdentity(logsPage.items) !== expectedFirstIdentity)
        ) {
          return {
            status: "unstable",
            scanStart,
            scanEnd,
            matureAt,
            total: logsPage.total,
            firstIdentity: scanFirstIdentity(logsPage.items),
            pages: page,
          };
        }
        const backfill = await backfillProxyLogsFromNewApiUsage(
          uniqueUsageLogs(logsPage.items),
          {
            dryRun: false,
            matchWindowMs: policy.matchWindowMinutes * 60_000,
            reservedProxyLogIds,
          },
        );
        backfills.push(backfill);
        for (const item of backfill.items) {
          if (item.proxyLogId && !reservedProxyLogIds.includes(item.proxyLogId)) {
            reservedProxyLogIds.push(item.proxyLogId);
          }
          if (!item.blocksSettlement) continue;
          const blockedAt = item.newapiCreatedAt ?? scanStart;
          if (!integrityBlockedAt || blockedAt < integrityBlockedAt) {
            integrityBlockedAt = blockedAt;
            integrityBlockedIssueId = item.issueId;
          }
        }
      }

      const verification = await listNewApiUsageLogs({
        page: 0,
        size: 1,
        startTimestamp,
        endTimestamp,
      });
      if (
        verification.total !== expectedTotal ||
        scanFirstIdentity(verification.items) !== expectedFirstIdentity
      ) {
        return {
          status: "unstable",
          scanStart,
          scanEnd,
          matureAt,
          total: verification.total,
          firstIdentity: scanFirstIdentity(verification.items),
          pages: pageCount,
        };
      }
      await finalizeBackfillBillingPeriods(backfills, 0);
      if (integrityBlockedAt) {
        return {
          status: "integrity_blocked",
          scanStart,
          scanEnd,
          matureAt,
          total: expectedTotal,
          firstIdentity: expectedFirstIdentity,
          pages: pageCount,
          integrityBlockedAt,
          integrityBlockedIssueId,
        };
      }
      const affectedUsers = new Set(
        backfills.flatMap((backfill) =>
          backfill.items
            .filter((item) => item.feishuUserId && item.billingPeriod)
            .map((item) => `${item.feishuUserId}\u0000${item.billingPeriod}`),
        ),
      ).size;
      return {
        status: "completed",
        scanStart,
        scanEnd,
        matureAt,
        total: expectedTotal,
        firstIdentity: expectedFirstIdentity,
        pages: pageCount,
        affectedUsers,
      };
    });
  } catch (error) {
    if (isPostgresAdvisoryLockBusyError(error)) {
      return { status: "busy", scanStart, scanEnd, matureAt };
    }
    throw error;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usageLogIdentity(log: NormalizedNewApiUsageLog) {
  if (log.newapiTokenId && log.newapiRequestId) {
    return `request:${log.newapiTokenId}:${log.newapiRequestId}`;
  }
  if (log.newapiTokenId && log.newapiLogId) {
    return `log:${log.newapiTokenId}:${log.newapiLogId}`;
  }
  return [
    log.newapiLogId,
    log.newapiRequestId,
    log.newapiTokenId,
    log.createdAt,
    log.model,
    log.quota,
  ]
    .filter((value) => value !== undefined && value !== null && String(value).length > 0)
    .join(":");
}

function scanFirstIdentity(logs: NormalizedNewApiUsageLog[]) {
  if (!logs.length) return "__empty__";
  return usageLogIdentity(logs[0]) || "__unidentified__";
}

function uniqueUsageLogs(logs: NormalizedNewApiUsageLog[]) {
  const seen = new Set<string>();
  return logs.filter((log) => {
    const identity = usageLogIdentity(log);
    if (!identity) return true;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function normalizedModel(value?: string) {
  return value?.trim().toLowerCase();
}

async function listUsageLogsForProxyRequest(input: {
  newapiRequestId?: string;
  newapiTokenId: string;
  model?: string;
  isStream?: boolean;
  requestStartedAt: string;
  pageSize: number;
}) {
  const requestStartedAt = new Date(input.requestStartedAt).getTime();
  const startTimestamp = Number.isFinite(requestStartedAt)
    ? Math.floor((requestStartedAt - 5_000) / 1000)
    : undefined;
  const exact = input.newapiRequestId
    ? await listNewApiUsageLogs({ requestId: input.newapiRequestId, size: input.pageSize })
    : { items: [] as NormalizedNewApiUsageLog[] };
  const candidates = exact.items.length
    ? exact.items
    : (
        await listNewApiUsageLogs({
          startTimestamp,
          size: input.pageSize,
        })
      ).items;
  const expectedModel = normalizedModel(input.model);

  return uniqueUsageLogs(candidates)
    .filter((log) => log.newapiTokenId === input.newapiTokenId)
    .filter(
      (log) =>
        !expectedModel || !normalizedModel(log.model) || normalizedModel(log.model) === expectedModel,
    )
    .filter((log) => input.isStream === undefined || log.isStream === input.isStream)
    .filter((log) => {
      if (startTimestamp === undefined || !log.createdAt) return true;
      return new Date(log.createdAt).getTime() >= startTimestamp * 1000;
    });
}

async function finalizeBackfillBillingPeriods(
  backfills: NewApiUsageBackfillResult[],
  delayMs?: number,
) {
  const affected = new Map<string, { feishuUserId: string; period: string }>();
  for (const backfill of backfills) {
    for (const item of backfill.items) {
      if (!item.feishuUserId || !item.billingPeriod) continue;
      affected.set(`${item.feishuUserId}\n${item.billingPeriod}`, {
        feishuUserId: item.feishuUserId,
        period: item.billingPeriod,
      });
    }
  }
  await Promise.all(
    [...affected.values()].map((item) =>
      finalizeBillingPeriodAfterSettlements(
        item.feishuUserId,
        item.period,
        delayMs,
      ),
    ),
  );
}

function requestBillingMaterializationRecoveryAfterFailure() {
  if (getConfig().storeBackend !== "postgres") return;
  const failedAt = Date.now();
  usageSyncRuntime.recoveryRequested = true;
  usageSyncRuntime.recoveryLastErrorAt = new Date(failedAt).toISOString();
  usageSyncRuntime.recoveryNotBeforeEpochMs = Math.max(
    usageSyncRuntime.recoveryNotBeforeEpochMs,
    failedAt + billingMaterializationRecoveryRetryDelayMs,
  );
  if (!usageSyncRuntime.schedulerStarted) usageSyncRuntime.schedulerStarted = true;
  if (!usageSyncRuntime.schedulerTickRunning) {
    scheduleNextUsageSyncTick(
      Math.max(usageSyncRuntime.recoveryNotBeforeEpochMs - Date.now(), 1000),
    );
  }
}

function observeRecoveredBillingMaterializationTarget(input: {
  feishuUserId: string;
  billingPeriod: string;
}) {
  void finalizeBillingPeriodAfterSettlements(input.feishuUserId, input.billingPeriod).catch(
    (error) => {
      requestBillingMaterializationRecoveryAfterFailure();
      console.error(
        JSON.stringify({
          event: "tokeninside.billing_period.materialization_recovery_target_failed",
          feishuUserId: input.feishuUserId,
          billingPeriod: input.billingPeriod,
          errorMessage:
            error instanceof Error ? error.message : "billing materialization recovery failed",
        }),
      );
    },
  );
}

async function registerDurableBillingMaterializationTargets(
  input: { force?: boolean } = {},
) {
  if (getConfig().storeBackend !== "postgres") {
    usageSyncRuntime.recoveryRequested = false;
    usageSyncRuntime.recoveryNotBeforeEpochMs = 0;
    return 0;
  }
  if (usageSyncRuntime.recoveryPromise) return usageSyncRuntime.recoveryPromise;
  if (!input.force && !usageSyncRuntime.recoveryRequested) return 0;
  if (!input.force && usageSyncRuntime.recoveryNotBeforeEpochMs > Date.now()) return 0;

  // Consume only the request visible at scan start. A finalizer rejection that
  // arrives during enumeration sets the bit/backoff again and survives this run.
  usageSyncRuntime.recoveryRequested = false;
  usageSyncRuntime.recoveryNotBeforeEpochMs = 0;
  usageSyncRuntime.recoveryRunning = true;
  let current!: Promise<number>;
  current = (async () => {
    const targets = await listPostgresAuthoritativeUsageBillingMaterializationTargets();
    usageSyncRuntime.recoveryLastTargetCount = targets.length;
    for (const target of targets) observeRecoveredBillingMaterializationTarget(target);
    return targets.length;
  })()
    .catch((error) => {
      requestBillingMaterializationRecoveryAfterFailure();
      throw error;
    })
    .finally(() => {
      usageSyncRuntime.recoveryRunning = false;
      if (usageSyncRuntime.recoveryPromise === current) usageSyncRuntime.recoveryPromise = undefined;
    });
  usageSyncRuntime.recoveryPromise = current;
  return current;
}

function billingMaterializationRecoveryDelayMs() {
  if (getConfig().storeBackend !== "postgres" || !usageSyncRuntime.recoveryRequested) return undefined;
  return Math.max(usageSyncRuntime.recoveryNotBeforeEpochMs - Date.now(), 1000);
}

function usageSyncContinuationDelayMs() {
  return Math.max(
    getConfig().billing.usageSyncContinuationDelayMs ?? 250,
    10,
  );
}

function usageSyncScanRetryDelayMs() {
  if (usageSyncRuntime.schedulerScanRetryNotBeforeEpochMs <= Date.now()) return 0;
  return usageSyncRuntime.schedulerScanRetryNotBeforeEpochMs - Date.now();
}

function usageSyncRepairSliceBudget(intervalMinutes: number) {
  const cycleSeconds = Math.max(intervalMinutes, 1) * 60;
  const netSecondsPerSlice = Math.max(usageSyncRepairSliceSeconds - 1, 1);
  return Math.min(
    Math.max(
      Math.ceil((cycleSeconds * 1.2) / netSecondsPerSlice),
      usageSyncRepairSlicesPerCycle,
    ),
    120,
  );
}

function clearDurablePendingUsageTailState() {
  usageSyncRuntime.schedulerTailRefreshDirty = false;
  usageSyncRuntime.schedulerTailRefreshRequested = false;
  usageSyncRuntime.durablePendingTailObserved = false;
  usageSyncRuntime.durablePendingTailCount = 0;
  usageSyncRuntime.durablePendingTailManualReviewCount = 0;
  usageSyncRuntime.durablePendingTailRequiredThrough = undefined;
  usageSyncRuntime.durablePendingTailNextDueEpochMs = 0;
  usageSyncRuntime.durablePendingTailNextRefreshEpochMs = 0;
}

async function refreshDurablePendingUsageTail(settlementLagMinutes: number) {
  if (getConfig().storeBackend !== "postgres") {
    clearDurablePendingUsageTailState();
    return;
  }
  const refreshStartedAt = Date.now();
  if (refreshStartedAt - usageSyncRuntime.durablePendingTailLastRefreshEpochMs < 5_000) {
    if (usageSyncRuntime.schedulerTailRefreshDirty) {
      usageSyncRuntime.durablePendingTailNextRefreshEpochMs =
        usageSyncRuntime.durablePendingTailLastRefreshEpochMs + 5_000;
    }
    return;
  }
  usageSyncRuntime.schedulerTailRefreshDirty = false;
  usageSyncRuntime.durablePendingTailNextRefreshEpochMs = 0;
  usageSyncRuntime.durablePendingTailLastRefreshEpochMs = refreshStartedAt;
  let horizon: Awaited<
    ReturnType<typeof getPostgresPendingUsageSettlementHorizon>
  >;
  try {
    horizon = await getPostgresPendingUsageSettlementHorizon(
      settlementLagMinutes,
    );
  } catch (error) {
    // A transient control-pool failure must not consume the last durable wake.
    // Restore the coalesced bit and retry on a bounded timer even when no new
    // request arrives after this failed horizon read.
    usageSyncRuntime.schedulerTailRefreshDirty = true;
    usageSyncRuntime.schedulerTailRefreshRequested = true;
    usageSyncRuntime.durablePendingTailNextRefreshEpochMs = Math.max(
      usageSyncRuntime.durablePendingTailNextRefreshEpochMs,
      refreshStartedAt + 5_000,
    );
    throw error;
  }
  usageSyncRuntime.durablePendingTailCount = horizon.count;
  usageSyncRuntime.durablePendingTailManualReviewCount =
    horizon.transitionedToManualReviewCount ?? 0;
  usageSyncRuntime.durablePendingTailRequiredThrough = horizon.requiredThrough;
  if (horizon.count <= 0) {
    usageSyncRuntime.schedulerTailRefreshRequested = usageSyncRuntime.schedulerTailRefreshDirty;
    if (usageSyncRuntime.schedulerTailRefreshDirty) {
      usageSyncRuntime.durablePendingTailNextRefreshEpochMs = refreshStartedAt + 5_000;
    }
    usageSyncRuntime.durablePendingTailObserved = false;
    usageSyncRuntime.durablePendingTailNextDueEpochMs = 0;
    return;
  }
  usageSyncRuntime.durablePendingTailObserved = true;
  usageSyncRuntime.schedulerTailRefreshRequested = true;
  if (usageSyncRuntime.schedulerTailRefreshDirty) {
    usageSyncRuntime.durablePendingTailNextRefreshEpochMs = refreshStartedAt + 5_000;
  }
  usageSyncRuntime.durablePendingTailNextDueEpochMs = horizon.nextDueAt
    ? new Date(horizon.nextDueAt).getTime()
    : Date.now();
  if (
    usageSyncRuntime.durablePendingTailNextDueEpochMs <= Date.now() &&
    usageSyncRuntime.schedulerScanRetryNotBeforeEpochMs <= Date.now()
  ) {
    usageSyncRuntime.schedulerForceScanRequested = true;
  }
}

function durablePendingUsageTailRefreshDelayMs() {
  if (!usageSyncRuntime.schedulerTailRefreshDirty) return undefined;
  if (usageSyncRuntime.durablePendingTailLastRefreshEpochMs <= 0) {
    return usageSyncContinuationDelayMs();
  }
  const refreshAt = Math.max(
    usageSyncRuntime.durablePendingTailNextRefreshEpochMs,
    usageSyncRuntime.durablePendingTailLastRefreshEpochMs + 5_000,
  );
  return Math.max(refreshAt - Date.now(), 10);
}

function durablePendingUsageTailDelayMs() {
  if (
    !usageSyncRuntime.durablePendingTailObserved ||
    usageSyncRuntime.durablePendingTailCount <= 0 ||
    usageSyncRuntime.durablePendingTailNextDueEpochMs <= 0
  ) {
    return undefined;
  }
  return Math.max(
    usageSyncRuntime.durablePendingTailNextDueEpochMs - Date.now(),
    usageSyncScanRetryDelayMs(),
    usageSyncRuntime.schedulerForceScanRequested ? usageSyncContinuationDelayMs() : 0,
    10,
  );
}

export function usageSettlementTailSnapshot() {
  return {
    requested: usageSyncRuntime.schedulerTailRefreshRequested,
    durablePendingCount: usageSyncRuntime.durablePendingTailCount,
    transitionedToManualReviewCount: usageSyncRuntime.durablePendingTailManualReviewCount,
    repairSlicesRemaining: usageSyncRuntime.schedulerRepairSlicesRemaining,
    repairBudgetRefillAt:
      usageSyncRuntime.schedulerRepairBudgetRefillNotBeforeEpochMs > Date.now()
        ? new Date(usageSyncRuntime.schedulerRepairBudgetRefillNotBeforeEpochMs).toISOString()
        : undefined,
    scanRetryNotBefore:
      usageSyncRuntime.schedulerScanRetryNotBeforeEpochMs > Date.now()
        ? new Date(usageSyncRuntime.schedulerScanRetryNotBeforeEpochMs).toISOString()
        : undefined,
    refreshDueAt:
      usageSyncRuntime.durablePendingTailNextRefreshEpochMs > Date.now()
        ? new Date(usageSyncRuntime.durablePendingTailNextRefreshEpochMs).toISOString()
        : undefined,
    durableRequiredThrough: usageSyncRuntime.durablePendingTailRequiredThrough,
    nextDueAt:
      usageSyncRuntime.durablePendingTailNextDueEpochMs > Date.now()
        ? new Date(usageSyncRuntime.durablePendingTailNextDueEpochMs).toISOString()
        : undefined,
  };
}

function observeImmediateBillingPeriodFinalization(
  proxyLogId: string,
  backfills: NewApiUsageBackfillResult[],
) {
  void finalizeBackfillBillingPeriods(backfills).catch((error) => {
    requestBillingMaterializationRecoveryAfterFailure();
    console.error(
      JSON.stringify({
        event: "tokeninside.billing_period.materialization_failed",
        proxyLogId,
        errorMessage:
          error instanceof Error ? error.message : "billing period materialization failed",
      }),
    );
  });
}

export type NewApiProxyUsageSettlementResult = {
  attempted: boolean;
  newapiRequestId?: string;
  attempts: number;
  found: number;
  reason?: "missing_context" | "not_found" | "deferred";
  backfill?: NewApiUsageBackfillResult;
};

async function syncNewApiUsageForProxyRequestInner(input: {
  newapiRequestId?: string;
  proxyLogId?: string;
  newapiTokenId?: string;
  model?: string;
  isStream?: boolean;
  requestStartedAt?: string;
  maxAttempts?: number;
  retryDelayMs?: number;
  pageSize?: number;
  matchWindowMs?: number;
}): Promise<NewApiProxyUsageSettlementResult> {
  const newapiRequestId = input.newapiRequestId?.trim();
  const proxyLogId = input.proxyLogId?.trim();
  const newapiTokenId = input.newapiTokenId?.trim();
  const requestStartedAt = input.requestStartedAt?.trim();
  if (!proxyLogId || !newapiTokenId || !requestStartedAt) {
    return {
      attempted: false,
      newapiRequestId,
      attempts: 0,
      found: 0,
      reason: "missing_context",
    };
  }

  const maxAttempts = Math.min(
    Math.max(Math.trunc(input.maxAttempts ?? immediateSettlementDefaults.maxAttempts), 1),
    20,
  );
  const retryDelayMs = Math.min(
    Math.max(Math.trunc(input.retryDelayMs ?? immediateSettlementDefaults.retryDelayMs), 0),
    10_000,
  );
  const pageSize = Math.min(
    Math.max(Math.trunc(input.pageSize ?? immediateSettlementDefaults.pageSize), 1),
    100,
  );
  const matchWindowMs = Math.min(
    Math.max(Math.trunc(input.matchWindowMs ?? immediateSettlementDefaults.matchWindowMs), 1_000),
    24 * 60 * 60 * 1000,
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1 && retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }

    const usageLogs = await listUsageLogsForProxyRequest({
      newapiRequestId,
      newapiTokenId,
      model: input.model,
      isStream: input.isStream,
      requestStartedAt,
      pageSize,
    });
    if (!usageLogs.length) continue;

    const backfill = await backfillProxyLogsFromNewApiUsage(usageLogs, {
      dryRun: false,
      matchWindowMs,
      persistUnmatched: false,
      targetProxyLogIds: [proxyLogId],
    });
    const matched = backfill.items.find((item) => item.proxyLogId === proxyLogId);
    if (!matched) continue;
    // The source/proxy transaction above is the authoritative settlement.
    // Period summaries are derived read models: observe them independently so
    // debounce/rebuild latency or a materialization failure cannot hold the
    // scarce immediate-settlement slot or regress a matched proxy to retrying.
    observeImmediateBillingPeriodFinalization(proxyLogId, [backfill]);
    return {
      attempted: true,
      newapiRequestId,
      attempts: attempt,
      found: 1,
      backfill,
    };
  }

  return {
    attempted: true,
    newapiRequestId,
    attempts: maxAttempts,
    found: 0,
    reason: "not_found",
  };
}

export async function syncNewApiUsageForProxyRequest(
  input: Parameters<typeof syncNewApiUsageForProxyRequestInner>[0],
) {
  const release = tryAcquireImmediateSettlementSlot();
  if (!release) {
    // The terminal proxy lifecycle is already durable before this function runs.
    // Do not retain one Promise/request closure per saturated request: the
    // durable log's usage settlement remains pending and this coalesced wake lets the
    // overlapping NewAPI usage scan settle it idempotently.
    wakeUsageSyncScheduler();
    return {
      attempted: false,
      newapiRequestId: input.newapiRequestId?.trim(),
      attempts: 0,
      found: 0,
      reason: "deferred" as const,
    };
  }
  try {
    const result = await syncNewApiUsageForProxyRequestInner(input);
    if (result.found === 0) wakeUsageSyncScheduler();
    return result;
  } catch (error) {
    wakeUsageSyncScheduler();
    throw error;
  } finally {
    release();
  }
}

export async function drainNewApiUsageSettlements() {
  await waitForImmediateSettlementsToDrain();
  // Re-enumerate the durable matched-source facts even when no in-memory
  // observer survived. The drain below then makes recovery failures visible to
  // shutdown and exact-accounting acceptance paths.
  await registerDurableBillingMaterializationTargets({ force: true });
  await drainBillingPeriodFinalizations();
}

export async function syncNewApiUsageLogs(input: {
  dryRun?: boolean;
  page?: number;
  size?: number;
  maxPages?: number;
  matchWindowMs?: number;
  overlapMinutes?: number;
  intervalMinutes?: number;
  settlementLagMinutes?: number;
  retryBaseMinutes?: number;
  allowRepair?: boolean;
  operatedByFeishuUserId?: string;
  trigger?: UsageSyncTrigger;
  billingOperationId?: string;
  billingOperationLeaseId?: string;
} = {}): Promise<NewApiUsageSyncResult> {
  return withUsageSyncLock(input.dryRun ?? true, () => syncNewApiUsageLogsUnlocked(input));
}

async function syncNewApiUsageLogsUnlocked(input: {
  dryRun?: boolean;
  page?: number;
  size?: number;
  maxPages?: number;
  matchWindowMs?: number;
  overlapMinutes?: number;
  intervalMinutes?: number;
  settlementLagMinutes?: number;
  retryBaseMinutes?: number;
  allowRepair?: boolean;
  operatedByFeishuUserId?: string;
  trigger?: UsageSyncTrigger;
  billingOperationId?: string;
  billingOperationLeaseId?: string;
} = {}): Promise<NewApiUsageSyncResult> {
  const dryRun = input.dryRun ?? true;
  const previousCheckpoint = dryRun ? null : await getUsageSyncCheckpoint();
  const previousIngestedThrough =
    previousCheckpoint?.ingestedThrough ?? previousCheckpoint?.settledThrough;
  const resumableCheckpoint = Boolean(
    input.page === undefined &&
      isResumableUsageSyncCheckpoint(previousCheckpoint),
  );
  const settlementLagMinutes = Math.min(
    Math.max(
      Math.trunc(
        input.settlementLagMinutes ?? defaultUsageSyncPolicy().settlementLagMinutes ?? 5,
      ),
      0,
    ),
    24 * 60,
  );
  const freshRunStartedAt = nowIso();
  const freshForwardWindow = initialForwardUsageSyncWindow({
    runStartedAt: freshRunStartedAt,
    settledThrough: previousIngestedThrough,
    overlapMinutes: input.overlapMinutes ?? 120,
    settlementLagMinutes,
  });
  const allowRepair = input.allowRepair ?? true;
  const freshForwardLagSeconds =
    floorEpochSecond(freshForwardWindow.scanTargetEnd) -
    floorEpochSecond(freshForwardWindow.scanStart);
  const canResume = Boolean(
    resumableCheckpoint &&
      !(
        previousCheckpoint?.scanMode === "repair" &&
        ((!allowRepair && freshForwardLagSeconds > 0) ||
          freshForwardLagSeconds > usageSyncRepairPreemptForwardLagSeconds)
      ),
  );
  const runStartedAt = canResume
    ? previousCheckpoint?.runStartedAt ?? freshRunStartedAt
    : freshRunStartedAt;
  const runId = canResume ? previousCheckpoint?.runId ?? randomId("usr") : randomId("usr");
  const forwardWindow = canResume
      ? initialForwardUsageSyncWindow({
        runStartedAt,
        settledThrough: previousIngestedThrough,
        overlapMinutes: input.overlapMinutes ?? 120,
        settlementLagMinutes,
      })
    : freshForwardWindow;
  const window: UsageSyncScanWindow = canResume
    ? {
        scanStart: previousCheckpoint!.scanStart!,
        scanEnd: previousCheckpoint!.scanEnd!,
        scanTargetEnd: previousCheckpoint!.scanTargetEnd!,
        scanMode: previousCheckpoint!.scanMode!,
        repairWindowStart: previousCheckpoint!.repairWindowStart,
        repairWindowEnd: previousCheckpoint!.repairWindowEnd,
      }
    : allowRepair &&
        previousIngestedThrough &&
        floorEpochSecond(forwardWindow.scanStart) >=
          floorEpochSecond(forwardWindow.scanTargetEnd)
      ? nextRepairUsageSyncSlice({
          settledThrough: previousIngestedThrough,
          repairCursorThrough: previousCheckpoint?.repairCursorThrough,
          repairWindowStart: previousCheckpoint?.repairWindowStart,
          repairWindowEnd: previousCheckpoint?.repairWindowEnd,
          overlapMinutes: input.overlapMinutes ?? 120,
        })
      : forwardWindow;
  const pageStart = Math.max(input.page ?? (canResume ? previousCheckpoint?.cursorPage ?? 0 : 0), 0);
  const size = Math.min(Math.max(input.size ?? 100, 1), 100);
  const maxPages = Math.min(Math.max(input.maxPages ?? 1, 1), 20);
  const matchWindowMinutes = Math.max(Math.round((input.matchWindowMs ?? 30 * 60 * 1000) / 60_000), 1);
  const overlapMinutes = Math.max(Math.trunc(input.overlapMinutes ?? 120), 0);
  const intervalMinutes = Math.min(Math.max(Math.trunc(input.intervalMinutes ?? defaultUsageSyncPolicy().intervalMinutes), 1), 24 * 60);
  const retryBaseMinutes = Math.min(
    Math.max(Math.trunc(input.retryBaseMinutes ?? defaultUsageSyncPolicy().retryBaseMinutes ?? 5), 1),
    24 * 60,
  );
  const pages: NewApiUsageSyncPageResult[] = [];
  const totals: NewApiUsageSyncResult["totals"] = {
    fetched: 0,
    seen: 0,
    matched: 0,
    updated: 0,
    skippedUnknownToken: 0,
    skippedNoMatch: 0,
    recordsUpserted: 0,
    issuesUpserted: 0,
    snapshotProxyCandidates: 0,
    snapshotUsageRecords: 0,
    snapshotFallbackProxyCandidates: 0,
  };
  let lastSeenNewapiLogId: string | undefined;
  let lastSeenNewapiCreatedAt: string | undefined;
  const reservedProxyLogIds: string[] = [];
  const seenUsageLogIdentities = new Set<string>();
  let scanExpectedTotal = canResume
    ? previousCheckpoint?.scanExpectedTotal
    : undefined;
  let expectedScanFirstIdentity = canResume
    ? previousCheckpoint?.scanFirstIdentity
    : undefined;
  let completedSlice = false;
  let completedWindow = false;
  let stabilityReset = false;
  let sliceResized = false;
  let cursorPage = pageStart;
  let integrityBlockedAt = previousCheckpoint?.integrityBlockedAt;
  let integrityBlockedIssueId = previousCheckpoint?.integrityBlockedIssueId;
  try {
    if (scanExpectedTotal === undefined && pageStart > 0) {
      const baseline = await listNewApiUsageLogs({
        page: 0,
        size: 1,
        startTimestamp: floorEpochSecond(window.scanStart),
        endTimestamp: floorEpochSecond(window.scanEnd),
      });
      scanExpectedTotal = baseline.total;
      expectedScanFirstIdentity = scanFirstIdentity(baseline.items);
    }
    for (let index = 0; index < maxPages; index += 1) {
      const page = pageStart + index;
      const logsPage = await listNewApiUsageLogs({
        page,
        size,
        startTimestamp: floorEpochSecond(window.scanStart),
        endTimestamp: floorEpochSecond(window.scanEnd),
      });
      if (scanExpectedTotal === undefined) {
        scanExpectedTotal = logsPage.total;
        if (page === 0) expectedScanFirstIdentity = scanFirstIdentity(logsPage.items);
      } else if (logsPage.total !== scanExpectedTotal) {
        // NewAPI exposes OFFSET pages rather than a snapshot/keyset cursor. If
        // this frozen slice changes, restarting page zero is the only safe way
        // to avoid silently stepping over rows shifted by a late insertion.
        stabilityReset = true;
        scanExpectedTotal = undefined;
        expectedScanFirstIdentity = undefined;
        cursorPage = 0;
        break;
      }
      if (
        page === 0 &&
        expectedScanFirstIdentity !== undefined &&
        scanFirstIdentity(logsPage.items) !== expectedScanFirstIdentity
      ) {
        stabilityReset = true;
        scanExpectedTotal = undefined;
        expectedScanFirstIdentity = undefined;
        cursorPage = 0;
        break;
      }
      if (page === 0 && window.scanMode === "forward") {
        const sliceSeconds =
          floorEpochSecond(window.scanEnd) - floorEpochSecond(window.scanStart) + 1;
        if (
          sliceSeconds > usageSyncSliceSeconds &&
          logsPage.total > usageSyncTargetRowsPerSlice
        ) {
          const resizedSeconds = Math.max(
            usageSyncSliceSeconds,
            Math.floor(
              (sliceSeconds * usageSyncTargetRowsPerSlice) / logsPage.total,
            ),
          );
          if (resizedSeconds < sliceSeconds) {
            window.scanEnd = epochSecondIso(
              floorEpochSecond(window.scanStart) + resizedSeconds - 1,
            );
            scanExpectedTotal = undefined;
            expectedScanFirstIdentity = undefined;
            cursorPage = 0;
            sliceResized = true;
            break;
          }
        }
      }
      for (const item of logsPage.items) {
        if (
          item.createdAt &&
          (!lastSeenNewapiCreatedAt || item.createdAt.localeCompare(lastSeenNewapiCreatedAt) >= 0)
        ) {
          lastSeenNewapiCreatedAt = item.createdAt;
          lastSeenNewapiLogId = item.newapiLogId;
        }
      }
      const usageLogs = uniqueUsageLogs(logsPage.items).filter((log) => {
        const identity = usageLogIdentity(log);
        if (!identity || !seenUsageLogIdentities.has(identity)) {
          if (identity) seenUsageLogIdentities.add(identity);
          return true;
        }
        return false;
      });
      const backfill = await backfillProxyLogsFromNewApiUsage(usageLogs, {
        dryRun,
        matchWindowMs: input.matchWindowMs,
        reservedProxyLogIds,
      });
      for (const item of backfill.items) {
        if (item.proxyLogId && !reservedProxyLogIds.includes(item.proxyLogId)) {
          reservedProxyLogIds.push(item.proxyLogId);
        }
        if (item.blocksSettlement) {
          const blockedAt = item.newapiCreatedAt ?? window.scanStart;
          if (!integrityBlockedAt || blockedAt < integrityBlockedAt) {
            integrityBlockedAt = blockedAt;
            integrityBlockedIssueId = item.issueId;
          }
        }
      }

      pages.push({
        page,
        size,
        fetched: logsPage.items.length,
        total: logsPage.total,
        backfill,
      });

      totals.fetched += logsPage.items.length;
      totals.seen += backfill.seen;
      totals.matched += backfill.matched;
      totals.updated += backfill.updated;
      totals.skippedUnknownToken += backfill.skippedUnknownToken;
      totals.skippedNoMatch += backfill.skippedNoMatch;
      totals.recordsUpserted += backfill.recordsUpserted;
      totals.issuesUpserted += backfill.issuesUpserted;
      totals.snapshotProxyCandidates += backfill.snapshot?.proxyCandidates ?? 0;
      totals.snapshotUsageRecords += backfill.snapshot?.usageRecords ?? 0;
      totals.snapshotFallbackProxyCandidates +=
        backfill.snapshot?.fallbackProxyCandidates ?? 0;

      if (logsPage.total === 0 || (page + 1) * size >= logsPage.total) {
        completedSlice = input.page === undefined || input.page === 0;
        cursorPage = 0;
        break;
      }
      cursorPage = page + 1;
    }

    if (completedSlice) {
      const verification = await listNewApiUsageLogs({
        page: 0,
        size: 1,
        startTimestamp: floorEpochSecond(window.scanStart),
        endTimestamp: floorEpochSecond(window.scanEnd),
      });
      if (
        verification.total !== scanExpectedTotal ||
        scanFirstIdentity(verification.items) !== expectedScanFirstIdentity
      ) {
        completedSlice = false;
        stabilityReset = true;
        cursorPage = 0;
        scanExpectedTotal = undefined;
        expectedScanFirstIdentity = undefined;
      }
    }

    if (!dryRun) {
      const blockingIssue = await getEarliestOpenBlockingUsageIssue();
      integrityBlockedAt = blockingIssue
        ? blockingIssue.occurredAt ?? blockingIssue.firstSeenAt
        : undefined;
      integrityBlockedIssueId = blockingIssue?.id;
    }

    const completedCurrentScan =
      completedSlice &&
      floorEpochSecond(window.scanEnd) >= floorEpochSecond(window.scanTargetEnd);

    const lastRunAt = nowIso();
    let checkpointWindow: UsageSyncScanWindow = window;
    let ingestedThrough = previousIngestedThrough;
    let settledThrough = previousCheckpoint?.settledThrough;
    let repairCursorThrough = previousCheckpoint?.repairCursorThrough;
    let repairWindowStart = previousCheckpoint?.repairWindowStart;
    let repairWindowEnd = previousCheckpoint?.repairWindowEnd;
    if (completedSlice && window.scanMode === "forward") {
      ingestedThrough = window.scanEnd;
      if (!integrityBlockedAt) settledThrough = window.scanEnd;
      const currentSliceSeconds =
        floorEpochSecond(window.scanEnd) - floorEpochSecond(window.scanStart) + 1;
      const nextSliceSeconds =
        scanExpectedTotal === 0
          ? Math.min(Math.max(currentSliceSeconds * 2, usageSyncSliceSeconds), 300)
          : usageSyncSliceSeconds;
      checkpointWindow = completedCurrentScan
        ? nextRepairUsageSyncSlice({
            settledThrough: window.scanEnd,
            repairCursorThrough,
            repairWindowStart,
            repairWindowEnd,
            overlapMinutes,
          })
        : nextForwardUsageSyncSlice({
            ...window,
            sliceSeconds: nextSliceSeconds,
          });
      // A completed forward target always yields one bounded low-priority
      // repair slice before this cycle is considered applied.
      completedWindow = false;
    } else if (completedSlice && window.scanMode === "repair") {
      repairCursorThrough = window.scanEnd;
      repairWindowStart = window.repairWindowStart;
      repairWindowEnd = window.repairWindowEnd;
      completedWindow = completedCurrentScan;
    }
    if (checkpointWindow.scanMode === "repair") {
      repairWindowStart = checkpointWindow.repairWindowStart;
      repairWindowEnd = checkpointWindow.repairWindowEnd;
    }
    settledThrough = settlementWatermarkBeforeIntegrityBlock(
      settledThrough,
      integrityBlockedAt,
    );
    const successfulStatus: UsageSyncRunStatus = completedWindow
      ? "applied"
      : "continuation_pending";
    const checkpointExpectedTotal = completedSlice ? undefined : scanExpectedTotal;
    const checkpointFirstIdentity = completedSlice
      ? undefined
      : expectedScanFirstIdentity;
    const nextRunAfter = addMinutes(
      lastRunAt,
      completedWindow ? intervalMinutes : 0,
    );
    const durableNextRunAfter = completedWindow
      ? nextRunAfter
      : addMilliseconds(lastRunAt, usageSyncContinuationDelayMs());
    const checkpoint = dryRun
      ? undefined
      : await saveUsageSyncCheckpoint({
          scope: "newapi_usage_logs",
          pageStart,
          pageSize: size,
          maxPages,
          overlapMinutes,
          matchWindowMinutes,
          lastSeenNewapiLogId,
          lastSeenNewapiCreatedAt,
          lastRunAt,
          lastRunStatus: successfulStatus,
          lastRunBy: input.trigger ?? "manual",
          runId,
          runStartedAt,
          scanStart: checkpointWindow.scanStart,
          scanEnd: checkpointWindow.scanEnd,
          scanTargetEnd: checkpointWindow.scanTargetEnd,
          scanMode: checkpointWindow.scanMode,
          scanExpectedTotal: checkpointExpectedTotal,
          scanFirstIdentity: checkpointFirstIdentity,
          ingestedThrough,
          settledThrough,
          integrityBlockedAt,
          integrityBlockedIssueId,
          repairCursorThrough,
          repairWindowStart,
          repairWindowEnd,
          cursorPage: completedSlice ? 0 : cursorPage,
          failureCount: 0,
          nextRetryAt: undefined,
          lastRunSummary: {
            pages: pages.length,
            fetched: totals.fetched,
            seen: totals.seen,
            matched: totals.matched,
            updated: totals.updated,
            skippedUnknownToken: totals.skippedUnknownToken,
            skippedNoMatch: totals.skippedNoMatch,
            recordsUpserted: totals.recordsUpserted,
            issuesUpserted: totals.issuesUpserted,
            snapshotProxyCandidates: totals.snapshotProxyCandidates,
            snapshotUsageRecords: totals.snapshotUsageRecords,
            snapshotFallbackProxyCandidates: totals.snapshotFallbackProxyCandidates,
            completedSlice,
            completedWindow,
            stabilityReset,
            sliceResized,
            scanMode: window.scanMode,
            scanExpectedTotal: scanExpectedTotal ?? 0,
            scanStart: window.scanStart,
            scanEnd: window.scanEnd,
            scanTargetEnd: window.scanTargetEnd,
            integrityBlocked: Boolean(integrityBlockedAt),
          },
          nextRunAfter: durableNextRunAfter,
        });

    if (!dryRun && getConfig().storeBackend === "postgres") {
      // The advisory lock owns an execution fence. Await derived finalizers so
      // no timer continues with a closed/stale ALS fence after lock release.
      await finalizeBackfillBillingPeriods(
        pages.map((page) => page.backfill),
        0,
      );
      assertQuotaExecutionFenceHeld();
      // Department availability is derived only from quota ledger grants and
      // live operation reservations, not usage. Affected-user finalizers cover
      // every user billing read model touched by this source page, so the PG
      // usage cursor must not wait for a redundant all-user/global rebuild.
    } else if (!dryRun) {
      // Preserve the JSON backend's existing synchronous materialization
      // semantics; the Postgres-only keyed finalizer is intentionally disabled
      // for this fallback store.
      const settings = await getAppSettings();
      const affectedPeriods = new Set([
        packageBillingPeriod(settings.packageReset, new Date(window.scanStart)),
        packageBillingPeriod(settings.packageReset, new Date(window.scanEnd)),
      ]);
      for (const affectedPeriod of affectedPeriods) {
        await rebuildQuotaMaterializedSnapshots(affectedPeriod);
      }
    }

    const result = {
      dryRun,
      pageStart,
      size,
      maxPages,
      runId,
      scanStart: window.scanStart,
      scanEnd: window.scanEnd,
      scanTargetEnd: window.scanTargetEnd,
      scanMode: window.scanMode,
      completedSlice,
      completedWindow,
      status: successfulStatus,
      pages,
      totals,
      checkpoint: checkpoint
        ? {
            lastRunAt: checkpoint.lastRunAt ?? checkpoint.updatedAt,
            nextRunAfter: checkpoint.nextRunAfter,
            lastSeenNewapiLogId: checkpoint.lastSeenNewapiLogId,
            lastSeenNewapiCreatedAt: checkpoint.lastSeenNewapiCreatedAt,
            lastRunStatus: checkpoint.lastRunStatus,
            ingestedThrough: checkpoint.ingestedThrough,
            settledThrough: checkpoint.settledThrough,
            integrityBlockedAt: checkpoint.integrityBlockedAt,
            integrityBlockedIssueId: checkpoint.integrityBlockedIssueId,
            cursorPage: checkpoint.cursorPage,
            scanExpectedTotal: checkpoint.scanExpectedTotal,
            scanFirstIdentity: checkpoint.scanFirstIdentity,
            scanMode: checkpoint.scanMode,
            repairCursorThrough: checkpoint.repairCursorThrough,
            repairWindowStart: checkpoint.repairWindowStart,
            repairWindowEnd: checkpoint.repairWindowEnd,
          }
        : undefined,
    };

    if (input.operatedByFeishuUserId) {
      await recordBillingOperation({
        id: input.billingOperationId,
        expectedLeaseId: input.billingOperationLeaseId,
        kind: "usage_sync",
        status: dryRun ? "dry_run" : successfulStatus,
        dryRun,
        operatedByFeishuUserId: input.operatedByFeishuUserId,
        input: {
          page: pageStart,
          size,
          maxPages,
          matchWindowMs: input.matchWindowMs,
          overlapMinutes,
          intervalMinutes,
          settlementLagMinutes,
          retryBaseMinutes,
          runId,
          scanStart: window.scanStart,
          scanEnd: window.scanEnd,
          scanTargetEnd: window.scanTargetEnd,
          scanMode: window.scanMode,
          trigger: input.trigger ?? "manual",
        },
        summary: {
          pages: pages.length,
          fetched: totals.fetched,
          seen: totals.seen,
          matched: totals.matched,
          updated: totals.updated,
          skippedUnknownToken: totals.skippedUnknownToken,
          skippedNoMatch: totals.skippedNoMatch,
          recordsUpserted: totals.recordsUpserted,
          issuesUpserted: totals.issuesUpserted,
          snapshotProxyCandidates: totals.snapshotProxyCandidates,
          snapshotUsageRecords: totals.snapshotUsageRecords,
          snapshotFallbackProxyCandidates: totals.snapshotFallbackProxyCandidates,
          completedSlice,
          completedWindow,
          runStatus: successfulStatus,
          continuationPending: !completedWindow,
          integrityBlocked: Boolean(integrityBlockedAt),
          stabilityReset,
          sliceResized,
          scanMode: window.scanMode,
        },
      });
    }

    return result;
  } catch (err) {
    if (input.operatedByFeishuUserId) {
      await recordBillingOperation({
        id: input.billingOperationId,
        expectedLeaseId: input.billingOperationLeaseId,
        kind: "usage_sync",
        status: statusFromError(pages.length),
        dryRun,
        operatedByFeishuUserId: input.operatedByFeishuUserId,
        input: {
          page: pageStart,
          size,
          maxPages,
          matchWindowMs: input.matchWindowMs,
          overlapMinutes,
          intervalMinutes,
          settlementLagMinutes,
          retryBaseMinutes,
          runId,
          scanStart: window.scanStart,
          scanEnd: window.scanEnd,
          scanTargetEnd: window.scanTargetEnd,
          scanMode: window.scanMode,
          trigger: input.trigger ?? "manual",
        },
        summary: {
          pages: pages.length,
          fetched: totals.fetched,
          seen: totals.seen,
          matched: totals.matched,
          updated: totals.updated,
          skippedUnknownToken: totals.skippedUnknownToken,
          skippedNoMatch: totals.skippedNoMatch,
          recordsUpserted: totals.recordsUpserted,
          issuesUpserted: totals.issuesUpserted,
          snapshotProxyCandidates: totals.snapshotProxyCandidates,
          snapshotUsageRecords: totals.snapshotUsageRecords,
          snapshotFallbackProxyCandidates: totals.snapshotFallbackProxyCandidates,
          failed: 1,
        },
        errorMessage: err instanceof Error ? err.message : "NewAPI usage sync failed",
      });
    }
    if (!dryRun) {
      const failedAt = nowIso();
      const failureCount = (previousCheckpoint?.failureCount ?? 0) + 1;
      const retryDelayMinutes = Math.min(
        retryBaseMinutes * 2 ** Math.min(failureCount - 1, 5),
        24 * 60,
      );
      await saveUsageSyncCheckpoint({
        scope: "newapi_usage_logs",
        pageStart,
        pageSize: size,
        maxPages,
        overlapMinutes,
        matchWindowMinutes,
        lastSeenNewapiLogId,
        lastSeenNewapiCreatedAt,
        lastRunAt: failedAt,
        lastRunStatus: statusFromError(pages.length),
        lastRunBy: input.trigger ?? "manual",
        runId,
        runStartedAt,
        scanStart: window.scanStart,
        scanEnd: window.scanEnd,
        scanTargetEnd: window.scanTargetEnd,
        scanMode: window.scanMode,
        scanExpectedTotal,
        scanFirstIdentity: expectedScanFirstIdentity,
        repairCursorThrough: previousCheckpoint?.repairCursorThrough,
        repairWindowStart:
          window.repairWindowStart ?? previousCheckpoint?.repairWindowStart,
        repairWindowEnd:
          window.repairWindowEnd ?? previousCheckpoint?.repairWindowEnd,
        ingestedThrough: previousIngestedThrough,
        settledThrough: settlementWatermarkBeforeIntegrityBlock(
          previousCheckpoint?.settledThrough,
          integrityBlockedAt,
        ),
        integrityBlockedAt,
        integrityBlockedIssueId,
        cursorPage,
        failureCount,
        nextRetryAt: addMinutes(failedAt, retryDelayMinutes),
        lastRunSummary: {
          pages: pages.length,
          fetched: totals.fetched,
          seen: totals.seen,
          matched: totals.matched,
          updated: totals.updated,
          skippedUnknownToken: totals.skippedUnknownToken,
          skippedNoMatch: totals.skippedNoMatch,
          recordsUpserted: totals.recordsUpserted,
          issuesUpserted: totals.issuesUpserted,
          snapshotProxyCandidates: totals.snapshotProxyCandidates,
          snapshotUsageRecords: totals.snapshotUsageRecords,
          snapshotFallbackProxyCandidates: totals.snapshotFallbackProxyCandidates,
          completedSlice: false,
          stabilityReset,
          sliceResized,
          failed: 1,
          integrityBlocked: Boolean(integrityBlockedAt),
        },
        nextRunAfter: addMinutes(failedAt, retryDelayMinutes),
      }).catch(() => undefined);
    }
    throw err;
  }
}

const manualUsageSyncLeaseDurationMs = 5 * 60_000;
const manualUsageSyncHeartbeatMs = 60_000;

function manualUsageSyncLeaseExpiresAt() {
  return new Date(Date.now() + manualUsageSyncLeaseDurationMs).toISOString();
}

function operationNumber(
  operation: BillingOperationRecord,
  key: string,
  options: { min: number; max: number; integer?: boolean; optional?: boolean },
) {
  const value = operation.input?.[key];
  if (value === undefined && options.optional) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (options.integer !== false && !Number.isInteger(value)) ||
    value < options.min ||
    value > options.max
  ) {
    throw new Error(`用量同步操作 ${operation.id} 的 ${key} 参数无效`);
  }
  return value;
}

function manualUsageSyncInputFromOperation(operation: BillingOperationRecord) {
  return {
    dryRun: operation.dryRun,
    page: operationNumber(operation, "page", {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      optional: true,
    }),
    size: operationNumber(operation, "size", { min: 1, max: 100 })!,
    maxPages: operationNumber(operation, "maxPages", { min: 1, max: 20 })!,
    overlapMinutes: operationNumber(operation, "overlapMinutes", {
      min: 0,
      max: 7 * 24 * 60,
    })!,
    settlementLagMinutes: operationNumber(operation, "settlementLagMinutes", {
      min: 0,
      max: 24 * 60,
    })!,
    matchWindowMinutes: operationNumber(operation, "matchWindowMinutes", {
      min: Number.EPSILON,
      max: 24 * 60,
      integer: false,
    })!,
    retryBaseMinutes: operationNumber(operation, "retryBaseMinutes", {
      min: 1,
      max: 24 * 60,
    })!,
  };
}

export async function enqueueManualUsageSyncOperation(input: ManualUsageSyncOperationInput) {
  return enqueueBillingOperation({
    kind: "usage_sync",
    dryRun: input.dryRun,
    operatedByFeishuUserId: input.operatedByFeishuUserId,
    requireRootActor: true,
    input: {
      dryRun: input.dryRun,
      page: input.page,
      size: input.size,
      maxPages: input.maxPages,
      overlapMinutes: input.overlapMinutes,
      settlementLagMinutes: input.settlementLagMinutes,
      matchWindowMinutes: input.matchWindowMinutes,
      retryBaseMinutes: input.retryBaseMinutes,
      trigger: "manual",
    },
  });
}

export async function runManualUsageSyncOperation(operationId: string) {
  const leaseId = randomId("bol");
  const claimed = await claimBillingOperationExecution({
    operationId,
    kind: "usage_sync",
    leaseId,
    leaseExpiresAt: manualUsageSyncLeaseExpiresAt(),
  });
  if (!claimed) return findBillingOperationById(operationId);

  const heartbeat = setInterval(() => {
    void renewBillingOperationExecution({
      operationId,
      leaseId,
      leaseExpiresAt: manualUsageSyncLeaseExpiresAt(),
    }).catch((error) => {
      console.error(
        JSON.stringify({
          event: "tokeninside.usage_sync.operation_lease_renew_failed",
          operationId,
          errorMessage: error instanceof Error ? error.message : "lease renew failed",
        }),
      );
    });
  }, manualUsageSyncHeartbeatMs);
  heartbeat.unref?.();

  try {
    const input = manualUsageSyncInputFromOperation(claimed);
    await syncNewApiUsageLogs({
      ...input,
      matchWindowMs: input.matchWindowMinutes * 60_000,
      operatedByFeishuUserId: claimed.operatedByFeishuUserId,
      trigger: "manual",
      billingOperationId: operationId,
      billingOperationLeaseId: leaseId,
    });
  } catch (error) {
    const current = await findBillingOperationById(operationId).catch(() => null);
    if (
      current?.status === "running" &&
      current.leaseId === leaseId
    ) {
      await recordBillingOperation({
        id: operationId,
        expectedLeaseId: leaseId,
        kind: "usage_sync",
        status: "failed",
        dryRun: claimed.dryRun,
        operatedByFeishuUserId: claimed.operatedByFeishuUserId,
        input: claimed.input,
        summary: { failed: 1 },
        errorMessage: error instanceof Error ? error.message : "NewAPI usage sync failed",
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
  return findBillingOperationById(operationId);
}

export async function runRunnableManualUsageSyncOperations(limit = 1) {
  const operations = await listRunnableBillingOperations({
    kind: "usage_sync",
    limit,
  });
  const results: Array<Awaited<ReturnType<typeof runManualUsageSyncOperation>>> = [];
  for (const operation of operations) {
    results.push(await runManualUsageSyncOperation(operation.id));
  }
  return results;
}

export async function runDueNewApiUsageSync(
  input: {
    force?: boolean;
    policy?: UsageSyncPolicy;
    allowRepair?: boolean;
  } = {},
) {
  const policy = input.policy ?? {
    ...defaultUsageSyncPolicy(),
    ...(await getAppSettings()).usageSyncPolicy,
  };
  const checkpoint = await getUsageSyncCheckpoint();
  const lastRunAt = checkpoint?.lastRunAt ?? policy.lastRunAt;
  const nextRunAfter =
    checkpoint?.nextRunAfter ??
    policy.nextRunAfter ??
    (lastRunAt ? addMinutes(lastRunAt, policy.intervalMinutes) : undefined);
  const durableFailureBackoff = Boolean(
    (checkpoint?.failureCount ?? 0) > 0 &&
      checkpoint?.nextRetryAt &&
      new Date(checkpoint.nextRetryAt).getTime() > Date.now(),
  );
  if (durableFailureBackoff) {
    return {
      ran: false,
      reason: "retry_backoff" as const,
      nextRunAfter: checkpoint?.nextRetryAt,
    };
  }
  const ingestedThrough = checkpoint?.ingestedThrough ?? checkpoint?.settledThrough;
  if (input.allowRepair === false && ingestedThrough) {
    const hasPendingForwardCheckpoint = Boolean(
      checkpoint?.scanMode === "forward" &&
        isResumableUsageSyncCheckpoint(checkpoint),
    );
    const forwardWindow = initialForwardUsageSyncWindow({
      runStartedAt: nowIso(),
      settledThrough: ingestedThrough,
      overlapMinutes: policy.overlapMinutes ?? 120,
      settlementLagMinutes: policy.settlementLagMinutes ?? 5,
    });
    if (
      !hasPendingForwardCheckpoint &&
      floorEpochSecond(forwardWindow.scanStart) >=
        floorEpochSecond(forwardWindow.scanTargetEnd)
    ) {
      return {
        ran: false,
        reason: "repair_budget_exhausted" as const,
        nextRunAfter: new Date(
          Math.max(usageSyncRuntime.schedulerRepairBudgetRefillNotBeforeEpochMs, Date.now() + 1_000),
        ).toISOString(),
      };
    }
  }
  if (!input.force && nextRunAfter && new Date(nextRunAfter).getTime() > Date.now()) {
    return { ran: false, reason: "not_due" as const, nextRunAfter };
  }

  try {
    const result = await syncNewApiUsageLogs({
      dryRun: false,
      size: policy.pageSize,
      maxPages: policy.maxPagesPerRun,
      overlapMinutes: policy.overlapMinutes,
      intervalMinutes: policy.intervalMinutes,
      settlementLagMinutes: policy.settlementLagMinutes,
      retryBaseMinutes: policy.retryBaseMinutes,
      allowRepair: input.allowRepair,
      matchWindowMs: policy.matchWindowMinutes * 60_000,
      operatedByFeishuUserId: "system:usage-sync",
      trigger: "auto",
    });
    return { ran: true, result };
  } catch (error) {
    if (isPostgresAdvisoryLockBusyError(error)) {
      // Another process/chunk already owns the durable scan fence. This is
      // normal ownership contention, not a source failure; retry with jitter
      // without increasing failureCount or persisting a long error backoff.
      return {
        ran: false,
        reason: "peer_active" as const,
        nextRunAfter: new Date(
          Date.now() + 500 + Math.floor(Math.random() * 1_000),
        ).toISOString(),
      };
    }
    throw error;
  }
}

function scheduleNextUsageSyncTick(delayMs: number) {
  const normalizedDelayMs = Math.max(delayMs, 10);
  const nextTickAt = Date.now() + normalizedDelayMs;
  if (
    usageSyncRuntime.schedulerTimer &&
    usageSyncRuntime.schedulerNextTickAt !== undefined &&
    usageSyncRuntime.schedulerNextTickAt <= nextTickAt
  ) {
    return;
  }
  if (usageSyncRuntime.schedulerTimer) clearTimeout(usageSyncRuntime.schedulerTimer);
  usageSyncRuntime.schedulerNextTickAt = nextTickAt;
  usageSyncRuntime.schedulerTimer = setTimeout(async () => {
    usageSyncRuntime.schedulerTimer = undefined;
    usageSyncRuntime.schedulerNextTickAt = undefined;
    usageSyncRuntime.schedulerTickRunning = true;
    let forceScan = false;
    try {
      try {
        await registerDurableBillingMaterializationTargets();
      } catch (error) {
        // The recovery function retained one requested bit plus recoveryNotBefore.
        // Source synchronization remains independent and can still progress.
        console.error(
          JSON.stringify({
            event: "tokeninside.billing_period.materialization_recovery_scan_failed",
            errorMessage:
              error instanceof Error ? error.message : "billing materialization recovery scan failed",
          }),
        );
      }
      await runRunnableManualUsageSyncOperations();
      const schedulerSettings = await getAppSettings();
      const schedulerPolicy = {
        ...defaultUsageSyncPolicy(),
        ...schedulerSettings.usageSyncPolicy,
      };
      await refreshDurablePendingUsageTail(
        schedulerPolicy.settlementLagMinutes ?? 5,
      ).catch((error) => {
        console.error(
          JSON.stringify({
            event: "tokeninside.usage_sync.pending_tail_scan_failed",
            errorMessage:
              error instanceof Error ? error.message : "pending tail scan failed",
          }),
        );
      });
      if (
        usageSyncRuntime.schedulerRepairSlicesRemaining <= 0 &&
        usageSyncRuntime.schedulerRepairBudgetRefillNotBeforeEpochMs <= Date.now()
      ) {
        usageSyncRuntime.schedulerRepairSlicesRemaining = usageSyncRepairSliceBudget(
          schedulerPolicy.intervalMinutes ?? 5,
        );
        usageSyncRuntime.schedulerRepairBudgetRefillNotBeforeEpochMs =
          Date.now() +
          Math.max(schedulerPolicy.intervalMinutes ?? 5, 1) * 60_000;
      }
      // Consume the coalesced request immediately before the automatic scan.
      // A capacity deferral that arrives while this scan is running sets the
      // flag again and therefore creates exactly one follow-up tick.
      const retryDelayMs = usageSyncScanRetryDelayMs();
      forceScan = usageSyncRuntime.schedulerForceScanRequested && retryDelayMs <= 0;
      if (forceScan) usageSyncRuntime.schedulerForceScanRequested = false;
      const automaticRun = await runDueNewApiUsageSync({
        force: forceScan,
        policy: schedulerPolicy,
        allowRepair: usageSyncRuntime.schedulerRepairSlicesRemaining > 0,
      });
      if (!automaticRun.ran && automaticRun.reason === "peer_active") {
        const retryAt = automaticRun.nextRunAfter
          ? new Date(automaticRun.nextRunAfter).getTime()
          : Date.now() + 1_000;
        usageSyncRuntime.schedulerScanRetryNotBeforeEpochMs = Number.isFinite(retryAt)
          ? Math.max(retryAt, Date.now() + 250)
          : Date.now() + 1_000;
        usageSyncRuntime.schedulerForceScanRequested = true;
      } else if (!automaticRun.ran && automaticRun.reason === "retry_backoff") {
        const retryAt = automaticRun.nextRunAfter
          ? new Date(automaticRun.nextRunAfter).getTime()
          : Date.now() + 5 * 60_000;
        usageSyncRuntime.schedulerScanRetryNotBeforeEpochMs = Number.isFinite(retryAt)
          ? Math.max(retryAt, Date.now() + 1_000)
          : Date.now() + 5 * 60_000;
        usageSyncRuntime.schedulerForceScanRequested = false;
        if (usageSyncRuntime.durablePendingTailObserved) {
          usageSyncRuntime.durablePendingTailNextDueEpochMs = Math.max(
            usageSyncRuntime.durablePendingTailNextDueEpochMs,
            usageSyncRuntime.schedulerScanRetryNotBeforeEpochMs,
          );
        }
      } else if (
        !automaticRun.ran &&
        automaticRun.reason === "repair_budget_exhausted"
      ) {
        // The repair budget only throttles historical overlap scans. A mature
        // durable settlement must not inherit the multi-minute repair refill.
        // Give the safe forward watermark a short amount of wall-clock room to
        // advance, then reread the inclusive boundary on the pending-tail timer.
        usageSyncRuntime.schedulerForceScanRequested = false;
        if (
          usageSyncRuntime.durablePendingTailObserved &&
          usageSyncRuntime.durablePendingTailCount > 0 &&
          usageSyncRuntime.durablePendingTailNextDueEpochMs > 0 &&
          usageSyncRuntime.durablePendingTailNextDueEpochMs <= Date.now()
        ) {
          usageSyncRuntime.durablePendingTailNextDueEpochMs = Date.now() + 15_000;
        }
      } else if (automaticRun.ran) {
        usageSyncRuntime.schedulerScanRetryNotBeforeEpochMs = 0;
        usageSyncRuntime.schedulerTransientFailureCount = 0;
      }
      const completedScan = automaticRun.ran && automaticRun.result?.completedSlice
        ? automaticRun.result
        : undefined;
      if (completedScan && getConfig().storeBackend === "postgres") {
        const deferredCount = await deferPostgresCoveredPendingUsageSettlements(
          completedScan.scanStart,
          completedScan.scanEnd,
        ).catch((error) => {
          console.error(
            JSON.stringify({
              event: "tokeninside.usage_sync.pending_tail_backoff_failed",
              errorMessage:
                error instanceof Error ? error.message : "pending tail backoff failed",
            }),
          );
          return 0;
        });
        if (deferredCount > 0) {
          usageSyncRuntime.durablePendingTailNextDueEpochMs = Date.now() + 15_000;
        }
      }
      await refreshDurablePendingUsageTail(
        schedulerPolicy.settlementLagMinutes ?? 5,
      ).catch((error) => {
        console.error(
          JSON.stringify({
            event: "tokeninside.usage_sync.pending_tail_refresh_failed",
            errorMessage:
              error instanceof Error ? error.message : "pending tail refresh failed",
          }),
        );
      });
      if (automaticRun.ran && automaticRun.result) {
        const result = automaticRun.result;
        const enteredRepair =
          result.scanMode === "forward" &&
          result.completedSlice &&
          result.checkpoint?.scanMode === "repair";
        const completedRepairSlice =
          result.scanMode === "repair" && result.completedSlice;
        const ranRepairBatch = result.scanMode === "repair";
        const completedRepairWindow =
          completedRepairSlice &&
          result.checkpoint?.repairWindowEnd !== undefined &&
          floorEpochSecond(result.scanEnd) >=
            floorEpochSecond(result.checkpoint.repairWindowEnd);
        if (completedRepairWindow) {
          usageSyncRuntime.schedulerRepairSlicesRemaining = 0;
        } else if (ranRepairBatch && usageSyncRuntime.schedulerRepairSlicesRemaining > 0) {
          usageSyncRuntime.schedulerRepairSlicesRemaining -= 1;
        }

        if (!result.completedWindow) {
          // A maxPages-limited scan persists its cursor. Ignore nextRunAfter on
          // the continuation so the same durable window drains promptly.
          usageSyncRuntime.schedulerForceScanRequested = true;
        } else if (
          completedRepairSlice &&
          usageSyncRuntime.schedulerRepairSlicesRemaining > 0
        ) {
          // A bounded in-memory budget lets low-priority repair cover more
          // than real time while every durable slice still yields back to the
          // scheduler. A fresh forward tail is recalculated before the next
          // repair slice and therefore preempts this burst.
          usageSyncRuntime.schedulerForceScanRequested = true;
        } else if (
          usageSyncRuntime.schedulerTailRefreshRequested &&
          usageSyncRuntime.durablePendingTailObserved &&
          usageSyncRuntime.durablePendingTailCount > 0
        ) {
          if (usageSyncRuntime.durablePendingTailNextDueEpochMs <= Date.now()) {
            usageSyncRuntime.schedulerForceScanRequested = true;
            usageSyncRuntime.durablePendingTailNextDueEpochMs = Date.now() + 5_000;
          }
        } else if (usageSyncRuntime.schedulerTailRefreshRequested) {
          // A capacity deferral can arrive while a long fixed window is being
          // drained. Run exactly one fresh window after it completes so the
          // durable scanEnd moves past that deferred tail.
          usageSyncRuntime.schedulerTailRefreshRequested = false;
          usageSyncRuntime.schedulerForceScanRequested = true;
        }
      }
    } catch (err) {
      // Source-scan failures persist their own durable nextRetryAt. Do not
      // retry at the continuation cadence. One bounded transient retry is
      // retained so lock/pre-checkpoint failures also avoid a dead wake.
      usageSyncRuntime.schedulerTransientFailureCount += 1;
      const transientRetryMs = Math.min(
        1_000 * 2 ** Math.min(usageSyncRuntime.schedulerTransientFailureCount - 1, 6),
        60_000,
      );
      usageSyncRuntime.schedulerScanRetryNotBeforeEpochMs =
        Date.now() + transientRetryMs;
      usageSyncRuntime.schedulerForceScanRequested = true;
      console.error(
        JSON.stringify({
          event: "tokeninside.usage_sync.scheduler_failed",
          errorMessage: err instanceof Error ? err.message : "NewAPI usage sync failed",
        }),
      );
    } finally {
      const settings = await getAppSettings().catch(() => null);
      const policy = {
        ...defaultUsageSyncPolicy(),
        ...settings?.usageSyncPolicy,
      };
      const intervalMs = Math.max(policy.intervalMinutes ?? 5, 1) * 60_000;
      const usageSyncDelayMs = usageSyncRuntime.schedulerForceScanRequested
        ? Math.max(
            usageSyncContinuationDelayMs(),
            usageSyncScanRetryDelayMs(),
          )
        : Math.min(intervalMs, 5 * 60_000);
      const recoveryDelayMs = billingMaterializationRecoveryDelayMs();
      const tailDelayMs = durablePendingUsageTailDelayMs();
      const tailRefreshDelayMs = durablePendingUsageTailRefreshDelayMs();
      const schedulerDelays = [
        usageSyncDelayMs,
        recoveryDelayMs,
        tailDelayMs,
        tailRefreshDelayMs,
      ].filter((candidate): candidate is number => candidate !== undefined);
      const delayUntilNextTick = Math.min(...schedulerDelays);
      usageSyncRuntime.schedulerTickRunning = false;
      scheduleNextUsageSyncTick(delayUntilNextTick);
    }
  }, normalizedDelayMs);
  usageSyncRuntime.schedulerTimer.unref?.();
}

function wakeUsageSyncScheduler() {
  // This is a single coalesced bit, not a per-request queue. The scheduled
  // worker first rebuilds the durable maturity horizon. Request paths do not
  // force a source scan before settlementLag/nextRetryAt is actually due.
  usageSyncRuntime.schedulerTailRefreshDirty = true;
  usageSyncRuntime.schedulerTailRefreshRequested = true;
  if (!usageSyncRuntime.schedulerStarted) {
    usageSyncRuntime.schedulerStarted = true;
  }
  if (usageSyncRuntime.schedulerTickRunning) {
    return;
  }
  scheduleNextUsageSyncTick(
    Math.max(
      durablePendingUsageTailRefreshDelayMs() ?? usageSyncContinuationDelayMs(),
      usageSyncScanRetryDelayMs(),
    ),
  );
}

export async function ensureUsageSyncScheduler() {
  if (usageSyncRuntime.schedulerStarted) return;
  usageSyncRuntime.schedulerStarted = true;
  scheduleNextUsageSyncTick(1000);
}
