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
import { assertLegacyAbsoluteQuotaWriteEnabled } from "@/lib/quota-guard";
import {
  hongKongBillingPeriod,
  isSettlementWatermarkFresh,
} from "@/lib/quota-model";
import { getStoreSnapshot } from "@/lib/store";
import { enqueueMonthlyOpenBatch } from "@/lib/quota-saga";

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
  if (!input.dryRun) await assertLegacyAbsoluteQuotaWriteEnabled("monthly_open");
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

export async function buildMonthlyPeriodOpenPlan(input: {
  period?: string;
}) {
  const period = input.period ?? hongKongBillingPeriod();
  const store = await getStoreSnapshot();
  const quotaPerUnit = getConfig().newapi.quotaPerUnit;
  const policies = store.userQuotaPolicies
    .filter(
      (item) =>
        item.effectiveFromPeriod <= period &&
        (!item.effectiveToPeriod || item.effectiveToPeriod >= period),
    )
    .sort((a, b) => b.version - a.version);
  const latestPolicyByUser = new Map<string, (typeof policies)[number]>();
  for (const policy of policies) {
    if (!latestPolicyByUser.has(policy.feishuUserId)) {
      latestPolicyByUser.set(policy.feishuUserId, policy);
    }
  }
  const usersById = new Map(store.users.map((item) => [item.id, item]));
  const activeTokenCounts = new Map<string, number>();
  for (const account of store.tokenAccounts.filter((item) => item.status === "active")) {
    activeTokenCounts.set(
      account.feishuUserId,
      (activeTokenCounts.get(account.feishuUserId) ?? 0) + 1,
    );
  }
  const activeTokenUserIds = new Set(activeTokenCounts.keys());
  const blockers: Array<{
    type: string;
    departmentId?: string;
    feishuUserId?: string;
    message: string;
  }> = [];
  for (const user of store.users.filter((item) => !item.status || item.status === "active")) {
    if (!latestPolicyByUser.has(user.id)) {
      blockers.push({
        type: "missing_policy",
        departmentId: user.departmentId,
        feishuUserId: user.id,
        message: "用户缺少有效月度额度策略",
      });
    }
    if ((activeTokenCounts.get(user.id) ?? 0) > 1) {
      blockers.push({
        type: "active_key_not_unique",
        departmentId: user.departmentId,
        feishuUserId: user.id,
        message: "用户存在多个 active Key",
      });
    }
  }
  for (const operation of store.quotaOperations.filter(
    (item) => item.state !== "completed" && item.state !== "compensated",
  )) {
    blockers.push({
      type: "open_operation",
      departmentId: operation.departmentId,
      feishuUserId: operation.feishuUserId,
      message: `存在未结额度操作 ${operation.id}`,
    });
  }
  const checkpoint = store.usageSyncCheckpoints.find(
    (item) => item.scope === "newapi_usage_logs",
  );
  const syncPolicy = store.settings.usageSyncPolicy;
  const watermarkFresh = isSettlementWatermarkFresh({
    settledThrough: checkpoint?.settledThrough,
    maxLagMinutes:
      2 * (syncPolicy?.intervalMinutes ?? 60) +
      (syncPolicy?.settlementLagMinutes ?? 5),
  });
  if (!watermarkFresh || checkpoint?.lastRunStatus !== "applied") {
    blockers.push({
      type: "usage_unsettled",
      message: "用量同步稳定水位缺失、过旧或最近窗口未完整结算",
    });
  }

  const departmentPlans = new Map<
    string,
    {
      departmentId: string;
      budgetQuota: number;
      assignedQuota: number;
      blocked: boolean;
      alreadyOpenedUsers: number;
      users: Array<{
        feishuUserId: string;
        assignedMonthlyQuota: number;
        hasActiveToken: boolean;
      }>;
    }
  >();
  for (const [feishuUserId, policy] of latestPolicyByUser) {
    const user = usersById.get(feishuUserId);
    if (!user || (user.status && user.status !== "active")) continue;
    if (!user.departmentId) {
      blockers.push({
        type: "missing_department",
        feishuUserId,
        message: "有效额度策略用户缺少部门归属",
      });
      continue;
    }
    const periodBudget = store.departmentQuotaPeriods.find(
      (item) => item.departmentId === user.departmentId && item.period === period,
    );
    if (!periodBudget) {
      blockers.push({
        type: "missing_department_budget",
        departmentId: user.departmentId,
        message: "部门缺少目标账期预算",
      });
    }
    const current = departmentPlans.get(user.departmentId) ?? {
      departmentId: user.departmentId,
      budgetQuota: Math.max(Math.round((periodBudget?.quotaLimit ?? 0) * quotaPerUnit), 0),
      assignedQuota: 0,
      blocked: false,
      alreadyOpenedUsers: 0,
      users: [],
    };
    current.assignedQuota += policy.assignedMonthlyQuota;
    const alreadyOpened = store.quotaLedgerEntries.some(
      (entry) =>
        entry.feishuUserId === feishuUserId &&
        entry.period === period &&
        (entry.entryType === "period_open_authorization" ||
          entry.entryType === "migration_opening"),
    );
    if (alreadyOpened) {
      current.alreadyOpenedUsers += 1;
    } else {
      current.users.push({
        feishuUserId,
        assignedMonthlyQuota: policy.assignedMonthlyQuota,
        hasActiveToken: activeTokenUserIds.has(feishuUserId),
      });
    }
    departmentPlans.set(user.departmentId, current);
  }
  for (const plan of departmentPlans.values()) {
    if (plan.assignedQuota > plan.budgetQuota) {
      plan.blocked = true;
      blockers.push({
        type: "department_budget_insufficient",
        departmentId: plan.departmentId,
        message: "部门目标账期预算不足，整批禁止部分发放",
      });
    }
    if (blockers.some((item) => item.departmentId === plan.departmentId)) plan.blocked = true;
  }
  return {
    period,
    dryRun: true,
    settledThrough: checkpoint?.settledThrough,
    blocked: blockers.length > 0,
    blockers,
    departments: [...departmentPlans.values()],
  };
}

export async function enqueueMonthlyPeriodOpenPlan(input: {
  plan: Awaited<ReturnType<typeof buildMonthlyPeriodOpenPlan>>;
  createdByOpenId: string;
  limit?: number;
}) {
  if (input.plan.blocked) throw new Error("月度开账 preflight 存在阻塞项");
  const selectedUsers: Array<{
    feishuUserId: string;
    assignedMonthlyQuota: number;
    hasActiveToken: boolean;
    departmentId: string;
  }> = [];
  for (const department of input.plan.departments.filter((item) => !item.blocked)) {
    if (
      input.limit !== undefined &&
      selectedUsers.length + department.users.length > input.limit
    ) {
      if (selectedUsers.length === 0) {
        throw new Error(
          `limit=${input.limit} 会拆分部门 ${department.departmentId}；月度开账只允许整部门执行`,
        );
      }
      break;
    }
    selectedUsers.push(
      ...department.users.map((user) => ({
        ...user,
        departmentId: department.departmentId,
      })),
    );
  }
  return enqueueMonthlyOpenBatch(
    selectedUsers.map((user) => ({
      feishuUserId: user.feishuUserId,
      departmentId: user.departmentId,
      period: input.plan.period,
      assignedMonthlyQuota: user.assignedMonthlyQuota,
      createdByOpenId: input.createdByOpenId,
    })),
  );
}
