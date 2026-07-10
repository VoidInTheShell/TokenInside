import { listNewApiUsageLogs } from "@/lib/newapi";
import type { NormalizedNewApiUsageLog } from "@/lib/newapi";
import { getConfig } from "@/lib/config";
import { nowIso } from "@/lib/crypto";
import { withPostgresAdvisoryLock } from "@/lib/postgres-store";
import {
  backfillProxyLogsFromNewApiUsage,
  defaultUsageSyncPolicy,
  getAppSettings,
  getUsageSyncCheckpoint,
  recordBillingOperation,
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
  };
};

const usageSyncLockKey = "usage_sync:newapi_logs";
let jsonUsageSyncRunning = false;
let schedulerStarted = false;
let schedulerTimer: ReturnType<typeof setTimeout> | undefined;

const immediateSettlementDefaults = {
  maxAttempts: 6,
  retryDelayMs: 750,
  pageSize: 20,
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

async function listUsageLogsForRequestId(requestId: string, pageSize: number) {
  const byRequestId = await listNewApiUsageLogs({
    requestId,
    size: pageSize,
  });
  const byUpstreamRequestId = await listNewApiUsageLogs({
    upstreamRequestId: requestId,
    size: pageSize,
  });

  return uniqueUsageLogs([...byRequestId.items, ...byUpstreamRequestId.items]);
}

export type NewApiProxyUsageSettlementResult = {
  attempted: boolean;
  newapiRequestId?: string;
  attempts: number;
  found: number;
  reason?: "missing_request_id" | "not_found";
  backfill?: NewApiUsageBackfillResult;
};

export async function syncNewApiUsageForProxyRequest(input: {
  newapiRequestId?: string;
  maxAttempts?: number;
  retryDelayMs?: number;
  pageSize?: number;
  matchWindowMs?: number;
}): Promise<NewApiProxyUsageSettlementResult> {
  const newapiRequestId = input.newapiRequestId?.trim();
  if (!newapiRequestId) {
    return {
      attempted: false,
      attempts: 0,
      found: 0,
      reason: "missing_request_id",
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

    const usageLogs = await listUsageLogsForRequestId(newapiRequestId, pageSize);
    if (!usageLogs.length) continue;

    const backfill = await backfillProxyLogsFromNewApiUsage(usageLogs, {
      dryRun: false,
      matchWindowMs,
    });
    return {
      attempted: true,
      newapiRequestId,
      attempts: attempt,
      found: usageLogs.length,
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
  operatedByFeishuUserId?: string;
  trigger?: UsageSyncTrigger;
} = {}): Promise<NewApiUsageSyncResult> {
  const dryRun = input.dryRun ?? true;
  const pageStart = Math.max(input.page ?? 0, 0);
  const size = Math.min(Math.max(input.size ?? 100, 1), 100);
  const maxPages = Math.min(Math.max(input.maxPages ?? 1, 1), 20);
  const matchWindowMinutes = Math.max(Math.round((input.matchWindowMs ?? 30 * 60 * 1000) / 60_000), 1);
  const overlapMinutes = Math.max(Math.trunc(input.overlapMinutes ?? 120), 0);
  const intervalMinutes = Math.min(Math.max(Math.trunc(input.intervalMinutes ?? defaultUsageSyncPolicy().intervalMinutes), 1), 24 * 60);
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
  try {
    for (let index = 0; index < maxPages; index += 1) {
      const page = pageStart + index;
      const logsPage = await listNewApiUsageLogs({ page, size });
      for (const item of logsPage.items) {
        if (
          item.createdAt &&
          (!lastSeenNewapiCreatedAt || item.createdAt.localeCompare(lastSeenNewapiCreatedAt) >= 0)
        ) {
          lastSeenNewapiCreatedAt = item.createdAt;
          lastSeenNewapiLogId = item.newapiLogId;
        }
      }
      const backfill = await backfillProxyLogsFromNewApiUsage(logsPage.items, {
        dryRun,
        matchWindowMs: input.matchWindowMs,
      });

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
        break;
      }
    }

    const lastRunAt = nowIso();
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
          lastRunStatus: "applied",
          lastRunBy: input.trigger ?? "manual",
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
          },
          nextRunAfter: addMinutes(lastRunAt, intervalMinutes),
        });

    const result = {
      dryRun,
      pageStart,
      size,
      maxPages,
      pages,
      totals,
      checkpoint: checkpoint
        ? {
            lastRunAt: checkpoint.lastRunAt ?? checkpoint.updatedAt,
            nextRunAfter: checkpoint.nextRunAfter,
            lastSeenNewapiLogId: checkpoint.lastSeenNewapiLogId,
            lastSeenNewapiCreatedAt: checkpoint.lastSeenNewapiCreatedAt,
          }
        : undefined,
    };

    if (input.operatedByFeishuUserId) {
      await recordBillingOperation({
        kind: "usage_sync",
        status: dryRun ? "dry_run" : "applied",
        dryRun,
        operatedByFeishuUserId: input.operatedByFeishuUserId,
        input: {
          page: pageStart,
          size,
          maxPages,
          matchWindowMs: input.matchWindowMs,
          overlapMinutes,
          intervalMinutes,
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
      await saveUsageSyncCheckpoint({
        scope: "newapi_usage_logs",
        pageStart,
        pageSize: size,
        maxPages,
        overlapMinutes,
        matchWindowMinutes,
        lastSeenNewapiLogId,
        lastSeenNewapiCreatedAt,
        lastRunAt: nowIso(),
        lastRunStatus: statusFromError(pages.length),
        lastRunBy: input.trigger ?? "manual",
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
        nextRunAfter: addMinutes(nowIso(), intervalMinutes),
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
    page: 0,
    size: policy.pageSize,
    maxPages: policy.maxPagesPerRun,
    overlapMinutes: policy.overlapMinutes,
    intervalMinutes: policy.intervalMinutes,
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
