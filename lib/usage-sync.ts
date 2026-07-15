import { listNewApiUsageLogs } from "@/lib/newapi";
import type { NormalizedNewApiUsageLog } from "@/lib/newapi";
import { getConfig } from "@/lib/config";
import { nowIso, randomId } from "@/lib/crypto";
import { fixedUsageSyncWindow, hongKongBillingPeriod } from "@/lib/quota-model";
import { withPostgresAdvisoryLock } from "@/lib/postgres-store";
import {
  backfillProxyLogsFromNewApiUsage,
  defaultUsageSyncPolicy,
  getAppSettings,
  getUsageSyncCheckpoint,
  recordBillingOperation,
  rebuildQuotaMaterializedSnapshots,
  saveUsageSyncCheckpoint,
  type NewApiUsageBackfillResult,
} from "@/lib/store";

type UsageSyncTrigger = "manual" | "auto";

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
  completedWindow: boolean;
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
  };
  checkpoint?: {
    lastRunAt: string;
    nextRunAfter?: string;
    lastSeenNewapiLogId?: string;
    lastSeenNewapiCreatedAt?: string;
    settledThrough?: string;
    cursorPage?: number;
  };
};

const usageSyncLockKey = "usage_sync:newapi_logs";
let jsonUsageSyncRunning = false;
let schedulerStarted = false;
let schedulerTimer: ReturnType<typeof setTimeout> | undefined;

const immediateSettlementDefaults = {
  maxAttempts: 6,
  retryDelayMs: 750,
  pageSize: 100,
  matchWindowMs: 10 * 60 * 1000,
};

function addMinutes(value: string, minutes: number) {
  return new Date(new Date(value).getTime() + minutes * 60 * 1000).toISOString();
}

function statusFromError(pageCount: number) {
  return pageCount > 0 ? "partial_failed" : "failed";
}

async function withUsageSyncLock<T>(dryRun: boolean, fn: () => Promise<T>) {
  if (dryRun) return fn();
  if (getConfig().storeBackend === "postgres") {
    return withPostgresAdvisoryLock(usageSyncLockKey, fn);
  }
  if (jsonUsageSyncRunning) {
    throw new Error(`${usageSyncLockKey} is already running`);
  }
  jsonUsageSyncRunning = true;
  try {
    return await fn();
  } finally {
    jsonUsageSyncRunning = false;
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
  const recent = await listNewApiUsageLogs({
    startTimestamp,
    size: input.pageSize,
  });
  const expectedModel = normalizedModel(input.model);

  return uniqueUsageLogs([...exact.items, ...recent.items])
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

export type NewApiProxyUsageSettlementResult = {
  attempted: boolean;
  newapiRequestId?: string;
  attempts: number;
  found: number;
  reason?: "missing_context" | "not_found";
  backfill?: NewApiUsageBackfillResult;
};

export async function syncNewApiUsageForProxyRequest(input: {
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
  operatedByFeishuUserId?: string;
  trigger?: UsageSyncTrigger;
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
  operatedByFeishuUserId?: string;
  trigger?: UsageSyncTrigger;
} = {}): Promise<NewApiUsageSyncResult> {
  const dryRun = input.dryRun ?? true;
  const previousCheckpoint = dryRun ? null : await getUsageSyncCheckpoint();
  const canResume = Boolean(
    input.page === undefined &&
      previousCheckpoint?.runId &&
      previousCheckpoint.scanStart &&
      previousCheckpoint.scanEnd &&
      previousCheckpoint.cursorPage !== undefined &&
      previousCheckpoint.lastRunStatus !== "applied",
  );
  const runStartedAt = canResume
    ? previousCheckpoint?.runStartedAt ?? nowIso()
    : nowIso();
  const runId = canResume ? previousCheckpoint?.runId ?? randomId("usr") : randomId("usr");
  const settlementLagMinutes = Math.min(
    Math.max(
      Math.trunc(
        input.settlementLagMinutes ?? defaultUsageSyncPolicy().settlementLagMinutes ?? 5,
      ),
      0,
    ),
    24 * 60,
  );
  const window = canResume
    ? {
        scanStart: previousCheckpoint!.scanStart!,
        scanEnd: previousCheckpoint!.scanEnd!,
      }
    : fixedUsageSyncWindow({
        runStartedAt,
        settledThrough: previousCheckpoint?.settledThrough,
        overlapMinutes: input.overlapMinutes ?? 120,
        settlementLagMinutes,
      });
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
  };
  let lastSeenNewapiLogId: string | undefined;
  let lastSeenNewapiCreatedAt: string | undefined;
  const reservedProxyLogIds: string[] = [];
  const seenUsageLogIdentities = new Set<string>();
  let completedWindow = false;
  let cursorPage = pageStart;
  try {
    for (let index = 0; index < maxPages; index += 1) {
      const page = pageStart + index;
      const logsPage = await listNewApiUsageLogs({
        page,
        size,
        startTimestamp: Math.floor(new Date(window.scanStart).getTime() / 1000),
        endTimestamp: Math.floor(new Date(window.scanEnd).getTime() / 1000),
      });
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

      if (!logsPage.items.length || (page + 1) * size >= logsPage.total) {
        completedWindow = true;
        cursorPage = 0;
        break;
      }
      cursorPage = page + 1;
    }

    const lastRunAt = nowIso();
    const successfulStatus = completedWindow ? "applied" : "partial_failed";
    const nextRunAfter = addMinutes(
      lastRunAt,
      completedWindow ? intervalMinutes : retryBaseMinutes,
    );
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
          scanStart: window.scanStart,
          scanEnd: window.scanEnd,
          settledThrough: completedWindow
            ? window.scanEnd
            : previousCheckpoint?.settledThrough,
          cursorPage,
          failureCount: completedWindow ? 0 : previousCheckpoint?.failureCount ?? 0,
          nextRetryAt: completedWindow ? undefined : nextRunAfter,
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
            completedWindow,
            scanStart: window.scanStart,
            scanEnd: window.scanEnd,
          },
          nextRunAfter,
        });

    if (!dryRun) {
      const affectedPeriods = new Set([
        hongKongBillingPeriod(new Date(window.scanStart)),
        hongKongBillingPeriod(new Date(window.scanEnd)),
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
      completedWindow,
      pages,
      totals,
      checkpoint: checkpoint
        ? {
            lastRunAt: checkpoint.lastRunAt ?? checkpoint.updatedAt,
            nextRunAfter: checkpoint.nextRunAfter,
            lastSeenNewapiLogId: checkpoint.lastSeenNewapiLogId,
            lastSeenNewapiCreatedAt: checkpoint.lastSeenNewapiCreatedAt,
            settledThrough: checkpoint.settledThrough,
            cursorPage: checkpoint.cursorPage,
          }
        : undefined,
    };

    if (input.operatedByFeishuUserId) {
      await recordBillingOperation({
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
          completedWindow,
        },
      });
    }

    return result;
  } catch (err) {
    if (input.operatedByFeishuUserId) {
      await recordBillingOperation({
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
        settledThrough: previousCheckpoint?.settledThrough,
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
          failed: 1,
        },
        nextRunAfter: addMinutes(failedAt, retryDelayMinutes),
      }).catch(() => undefined);
    }
    throw err;
  }
}

export async function runDueNewApiUsageSync() {
  const settings = await getAppSettings();
  const policy = {
    ...defaultUsageSyncPolicy(),
    ...settings.usageSyncPolicy,
  };
  if (!policy.enabled) return { ran: false, reason: "disabled" as const };

  const checkpoint = await getUsageSyncCheckpoint();
  const lastRunAt = checkpoint?.lastRunAt ?? policy.lastRunAt;
  const nextRunAfter =
    checkpoint?.nextRunAfter ??
    policy.nextRunAfter ??
    (lastRunAt ? addMinutes(lastRunAt, policy.intervalMinutes) : undefined);
  if (nextRunAfter && new Date(nextRunAfter).getTime() > Date.now()) {
    return { ran: false, reason: "not_due" as const, nextRunAfter };
  }

  const result = await syncNewApiUsageLogs({
    dryRun: false,
    size: policy.pageSize,
    maxPages: policy.maxPagesPerRun,
    overlapMinutes: policy.overlapMinutes,
    intervalMinutes: policy.intervalMinutes,
    settlementLagMinutes: policy.settlementLagMinutes,
    retryBaseMinutes: policy.retryBaseMinutes,
    matchWindowMs: policy.matchWindowMinutes * 60_000,
    operatedByFeishuUserId: "system:usage-sync",
    trigger: "auto",
  });
  return { ran: true, result };
}

function scheduleNextUsageSyncTick(delayMs: number) {
  if (schedulerTimer) clearTimeout(schedulerTimer);
  schedulerTimer = setTimeout(async () => {
    try {
      await runDueNewApiUsageSync();
    } catch (err) {
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
      const intervalMs = Math.max(policy.intervalMinutes, 1) * 60_000;
      scheduleNextUsageSyncTick(Math.min(intervalMs, 5 * 60_000));
    }
  }, Math.max(delayMs, 1000));
  schedulerTimer.unref?.();
}

export async function ensureUsageSyncScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  scheduleNextUsageSyncTick(1000);
}
