import { listNewApiUsageLogs } from "@/lib/newapi";
import {
  backfillProxyLogsFromNewApiUsage,
  recordBillingOperation,
  type NewApiUsageBackfillResult,
} from "@/lib/store";

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
  };
};

export async function syncNewApiUsageLogs(input: {
  dryRun?: boolean;
  page?: number;
  size?: number;
  maxPages?: number;
  matchWindowMs?: number;
  operatedByFeishuUserId?: string;
} = {}): Promise<NewApiUsageSyncResult> {
  const dryRun = input.dryRun ?? true;
  const pageStart = Math.max(input.page ?? 0, 0);
  const size = Math.min(Math.max(input.size ?? 100, 1), 500);
  const maxPages = Math.min(Math.max(input.maxPages ?? 1, 1), 20);
  const pages: NewApiUsageSyncPageResult[] = [];
  const totals: NewApiUsageSyncResult["totals"] = {
    fetched: 0,
    seen: 0,
    matched: 0,
    updated: 0,
    skippedUnknownToken: 0,
    skippedNoMatch: 0,
  };
  try {
    for (let index = 0; index < maxPages; index += 1) {
      const page = pageStart + index;
      const logsPage = await listNewApiUsageLogs({ page, size });
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

      if (!logsPage.items.length || (page + 1) * size >= logsPage.total) {
        break;
      }
    }

    const result = {
      dryRun,
      pageStart,
      size,
      maxPages,
      pages,
      totals,
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
        },
        summary: {
          pages: pages.length,
          fetched: totals.fetched,
          seen: totals.seen,
          matched: totals.matched,
          updated: totals.updated,
          skippedUnknownToken: totals.skippedUnknownToken,
          skippedNoMatch: totals.skippedNoMatch,
        },
      });
    }

    return result;
  } catch (err) {
    if (input.operatedByFeishuUserId) {
      await recordBillingOperation({
        kind: "usage_sync",
        status: pages.length > 0 ? "partial_failed" : "failed",
        dryRun,
        operatedByFeishuUserId: input.operatedByFeishuUserId,
        input: {
          page: pageStart,
          size,
          maxPages,
          matchWindowMs: input.matchWindowMs,
        },
        summary: {
          pages: pages.length,
          fetched: totals.fetched,
          seen: totals.seen,
          matched: totals.matched,
          updated: totals.updated,
          skippedUnknownToken: totals.skippedUnknownToken,
          skippedNoMatch: totals.skippedNoMatch,
          failed: 1,
        },
        errorMessage: err instanceof Error ? err.message : "NewAPI usage sync failed",
      });
    }
    throw err;
  }
}
