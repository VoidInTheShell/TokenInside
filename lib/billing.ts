import { toNewApiQuota, updateNewApiTokenQuota } from "@/lib/newapi";
import { getAppSettings, listActiveTokenAccounts, recordMonthlyResetApplied } from "@/lib/store";
import type { FeishuUser, TokenAccount } from "@/lib/types";

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

export async function runMonthlyBillingReset(input: {
  period?: string;
  dryRun: boolean;
  operatedByFeishuUserId: string;
  limit?: number;
}) {
  const targetPeriod = input.period ?? currentPeriod();
  const settings = await getAppSettings();
  const monthlyQuota = settings.defaultMonthlyQuota;
  const activeAccounts = await listActiveTokenAccounts();
  const candidates = activeAccounts
    .map(({ account, user }) => toItem({ account, user, targetPeriod, monthlyQuota }))
    .filter((item) => item.previousPeriod !== targetPeriod);
  const limitedCandidates = input.limit ? candidates.slice(0, input.limit) : candidates;
  const skippedCurrentPeriod = activeAccounts.length - candidates.length;

  if (input.dryRun) {
    return {
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
        reason: err instanceof Error ? err.message : "monthly reset failed",
      });
    }
  }

  return {
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
}
