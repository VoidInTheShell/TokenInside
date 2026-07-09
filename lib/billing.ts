import { toNewApiQuota, updateNewApiTokenQuota } from "@/lib/newapi";
import { getConfig } from "@/lib/config";
import { withPostgresAdvisoryLock } from "@/lib/postgres-store";
import {
  getAppSettings,
  listActiveTokenAccounts,
  recordBillingOperation,
  recordMonthlyResetApplied,
} from "@/lib/store";
import type { FeishuUser, TokenAccount } from "@/lib/types";

const monthlyResetLocks = new Set<string>();

export type MonthlyResetItem = {
  feishuUserId: string;
  userName?: string;
  tokenAccountId: string;
  newapiTokenId?: string;
  previousPeriod: string;
  targetPeriod: string;
  monthlyQuota: number;
  status: "planned" | "skipped" | "applied" | "failed";
  reason?: string;
};

function currentPeriod() {
  return new Date().toISOString().slice(0, 7);
}

function displayName(user: FeishuUser | null) {
  return user?.name || user?.openId;
}

function toItem(input: {
  account: TokenAccount;
  user: FeishuUser | null;
  targetPeriod: string;
  monthlyQuota: number;
}): MonthlyResetItem {
  return {
    feishuUserId: input.account.feishuUserId,
    userName: displayName(input.user),
    tokenAccountId: input.account.id,
    newapiTokenId: input.account.newapiTokenId,
    previousPeriod: input.account.billingPeriod,
    targetPeriod: input.targetPeriod,
    monthlyQuota: input.monthlyQuota,
    status: "planned",
  };
}

function billingOperationStatus(input: {
  dryRun: boolean;
  applied: number;
  failed: number;
}) {
  if (input.dryRun) return "dry_run";
  if (input.failed > 0 && input.applied > 0) return "partial_failed";
  if (input.failed > 0) return "failed";
  return "applied";
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : "monthly billing reset failed";
}

export async function runMonthlyBillingReset(input: {
  period?: string;
  dryRun: boolean;
  operatedByFeishuUserId: string;
  operatedByOpenId: string;
  limit?: number;
}) {
  const targetPeriod = input.period ?? currentPeriod();
  const lockKey = `monthly_reset:${targetPeriod}`;
  const run = async (useProcessLock: boolean) => {
    let lockAcquired = false;
    try {
      if (!input.dryRun && useProcessLock) {
        if (monthlyResetLocks.has(lockKey)) {
          throw new Error(`monthly reset for ${targetPeriod} is already running`);
        }
        monthlyResetLocks.add(lockKey);
        lockAcquired = true;
      }

      const settings = await getAppSettings();
      const monthlyQuota = settings.defaultMonthlyQuota;
      const activeAccounts = await listActiveTokenAccounts();
      const candidates = activeAccounts
        .map(({ account, user }) => toItem({ account, user, targetPeriod, monthlyQuota }))
        .filter((item) => item.previousPeriod !== targetPeriod);
      const limitedCandidates = input.limit ? candidates.slice(0, input.limit) : candidates;
      const skippedCurrentPeriod = activeAccounts.length - candidates.length;

      if (input.dryRun) {
        const result = {
          period: targetPeriod,
          dryRun: true,
          monthlyQuota,
          totals: {
            activeTokens: activeAccounts.length,
            skippedCurrentPeriod,
            planned: limitedCandidates.length,
            applied: 0,
            failed: 0,
          },
          items: limitedCandidates,
        };
        await recordBillingOperation({
          kind: "monthly_reset",
          status: "dry_run",
          dryRun: true,
          operatedByFeishuUserId: input.operatedByFeishuUserId,
          period: targetPeriod,
          input: {
            period: targetPeriod,
            limit: input.limit,
            monthlyQuota,
          },
          summary: {
            activeTokens: result.totals.activeTokens,
            skippedCurrentPeriod: result.totals.skippedCurrentPeriod,
            planned: result.totals.planned,
            applied: result.totals.applied,
            failed: result.totals.failed,
            monthlyQuota,
          },
        });
        return result;
      }

      const items: MonthlyResetItem[] = [];
      for (const candidate of limitedCandidates) {
        if (!candidate.newapiTokenId) {
          items.push({
            ...candidate,
            status: "failed",
            reason: "active token has no NewAPI token id",
          });
          continue;
        }

        try {
          await updateNewApiTokenQuota({
            newapiTokenId: candidate.newapiTokenId,
            remainQuota: toNewApiQuota(monthlyQuota),
          });
          const recorded = await recordMonthlyResetApplied({
            tokenAccountId: candidate.tokenAccountId,
            feishuUserId: candidate.feishuUserId,
            period: targetPeriod,
            monthlyQuota,
            operatedByFeishuUserId: input.operatedByFeishuUserId,
            approvalOperatorOpenId: input.operatedByOpenId,
          });
          items.push({
            ...candidate,
            status: recorded.applied ? "applied" : "skipped",
            reason: recorded.reason,
          });
        } catch (err) {
          items.push({
            ...candidate,
            status: "failed",
            reason: errorMessage(err),
          });
        }
      }

      const result = {
        period: targetPeriod,
        dryRun: false,
        monthlyQuota,
        totals: {
          activeTokens: activeAccounts.length,
          skippedCurrentPeriod,
          planned: limitedCandidates.length,
          applied: items.filter((item) => item.status === "applied").length,
          failed: items.filter((item) => item.status === "failed").length,
        },
        items,
      };
      await recordBillingOperation({
        kind: "monthly_reset",
        status: billingOperationStatus({ dryRun: false, ...result.totals }),
        dryRun: false,
        operatedByFeishuUserId: input.operatedByFeishuUserId,
        period: targetPeriod,
        input: {
          period: targetPeriod,
          limit: input.limit,
          monthlyQuota,
        },
        summary: {
          activeTokens: result.totals.activeTokens,
          skippedCurrentPeriod: result.totals.skippedCurrentPeriod,
          planned: result.totals.planned,
          applied: result.totals.applied,
          failed: result.totals.failed,
          monthlyQuota,
        },
      });
      return result;
    } catch (err) {
      await recordBillingOperation({
        kind: "monthly_reset",
        status: "failed",
        dryRun: input.dryRun,
        operatedByFeishuUserId: input.operatedByFeishuUserId,
        period: targetPeriod,
        input: {
          period: targetPeriod,
          limit: input.limit,
        },
        summary: {
          failed: 1,
        },
        errorMessage: errorMessage(err),
      });
      throw err;
    } finally {
      if (lockAcquired) {
        monthlyResetLocks.delete(lockKey);
      }
    }
  };

  if (!input.dryRun && getConfig().storeBackend === "postgres") {
    return withPostgresAdvisoryLock(lockKey, () => run(false));
  }
  return run(true);
}
