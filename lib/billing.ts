import { getConfig } from "@/lib/config";
import {
  hongKongBillingPeriod,
  isSettlementWatermarkFresh,
} from "@/lib/quota-model";
import { PACKAGE_RESET_SYSTEM_ACTOR } from "@/lib/package-reset";
import { getPostgresMonthlyPeriodOpenSnapshot } from "@/lib/postgres-store";
import { enqueueMonthlyOpenBatch } from "@/lib/quota-saga";
import { getStoreSnapshot } from "@/lib/store";
import type {
  DepartmentQuotaPeriod,
  QuotaOperation,
  UsageSyncPolicy,
  UsageSyncCheckpoint,
} from "@/lib/types";

type MonthlyPeriodOpenCandidate = {
  feishuUserId: string;
  departmentId?: string;
  assignedMonthlyQuota: number;
  activeTokenCount: number;
  isGlobalAdmin: boolean;
  alreadyOpened: boolean;
};

type MonthlyPeriodOpenSnapshot = {
  candidates: MonthlyPeriodOpenCandidate[];
  departmentQuotaPeriods: Array<
    Pick<DepartmentQuotaPeriod, "departmentId" | "period" | "quotaLimit">
  >;
  quotaOperations: Array<
    Pick<QuotaOperation, "id" | "feishuUserId" | "departmentId">
  >;
  settings: {
    usageSyncPolicy?: Pick<
      UsageSyncPolicy,
      "intervalMinutes" | "settlementLagMinutes"
    >;
  };
  usageSyncCheckpoint:
    | Pick<
        UsageSyncCheckpoint,
        "settledThrough" | "integrityBlockedAt" | "lastRunStatus"
      >
    | null;
};

async function getMonthlyPeriodOpenSnapshot(
  period: string,
): Promise<MonthlyPeriodOpenSnapshot> {
  const config = getConfig();
  if (config.storeBackend === "postgres") {
    return getPostgresMonthlyPeriodOpenSnapshot(period);
  }

  // The JSON backend remains the small-installation fallback and keeps its
  // existing whole-file snapshot semantics.
  const store = await getStoreSnapshot();
  const policies = store.userQuotaPolicies
    .filter(
      (item) =>
        item.effectiveFromPeriod <= period &&
        (!item.effectiveToPeriod || item.effectiveToPeriod >= period),
    )
    .sort((a, b) => b.version - a.version || a.id.localeCompare(b.id));
  const latestPolicyByUser = new Map<
    string,
    (typeof store.userQuotaPolicies)[number]
  >();
  for (const policy of policies) {
    if (!latestPolicyByUser.has(policy.feishuUserId)) {
      latestPolicyByUser.set(policy.feishuUserId, policy);
    }
  }

  const activeTokenCounts = new Map<string, number>();
  for (const account of store.tokenAccounts) {
    if (account.status !== "active") continue;
    activeTokenCounts.set(
      account.feishuUserId,
      (activeTokenCounts.get(account.feishuUserId) ?? 0) + 1,
    );
  }
  const alreadyOpenedUsers = new Set(
    store.quotaLedgerEntries
      .filter(
        (entry) =>
          entry.period === period &&
          entry.entryType === "period_open_authorization",
      )
      .map((entry) => entry.feishuUserId),
  );
  const globalAdminUserIds = new Set(
    store.adminScopes
      .filter((scope) => scope.scopeType === "global" && scope.status === "active")
      .map((scope) => scope.feishuUserId),
  );
  const systemAdminOpenIds = new Set(config.admin.systemAdminOpenIds);
  const candidates = store.users
    .filter((user) => !user.status || user.status === "active")
    .flatMap((user) => {
      const policy = latestPolicyByUser.get(user.id);
      if (!policy) return [];
      return [
        {
          feishuUserId: user.id,
          departmentId: policy.departmentId,
          assignedMonthlyQuota: policy.assignedMonthlyQuota,
          activeTokenCount: activeTokenCounts.get(user.id) ?? 0,
          isGlobalAdmin:
            systemAdminOpenIds.has(user.openId) || globalAdminUserIds.has(user.id),
          alreadyOpened: alreadyOpenedUsers.has(user.id),
        },
      ];
    })
    .sort((a, b) => a.feishuUserId.localeCompare(b.feishuUserId));

  return {
    candidates,
    departmentQuotaPeriods: store.departmentQuotaPeriods.filter(
      (item) => item.period === period,
    ),
    quotaOperations: store.quotaOperations.filter(
      (item) =>
        item.state !== "completed" &&
        item.state !== "compensated" &&
        item.state !== "cancelled",
    ),
    settings: store.settings,
    usageSyncCheckpoint:
      store.usageSyncCheckpoints.find(
        (item) => item.scope === "newapi_usage_logs",
      ) ?? null,
  };
}

export async function buildMonthlyPeriodOpenPlan(input: {
  period?: string;
}) {
  const period = input.period ?? hongKongBillingPeriod();
  const snapshot = await getMonthlyPeriodOpenSnapshot(period);
  const quotaPerUnit = getConfig().newapi.quotaPerUnit;
  const blockers: Array<{
    type: string;
    departmentId?: string;
    feishuUserId?: string;
    message: string;
  }> = [];
  for (const candidate of snapshot.candidates) {
    if (candidate.activeTokenCount > 1) {
      blockers.push({
        type: "active_key_not_unique",
        departmentId: candidate.departmentId,
        feishuUserId: candidate.feishuUserId,
        message: "用户存在多个 active Key",
      });
    }
  }
  for (const operation of snapshot.quotaOperations) {
    blockers.push({
      type: "open_operation",
      departmentId: operation.departmentId,
      feishuUserId: operation.feishuUserId,
      message: `存在未结额度操作 ${operation.id}`,
    });
  }
  const checkpoint = snapshot.usageSyncCheckpoint;
  const syncPolicy = snapshot.settings.usageSyncPolicy;
  const watermarkFresh = isSettlementWatermarkFresh({
    settledThrough: checkpoint?.settledThrough,
    maxLagMinutes:
      2 * (syncPolicy?.intervalMinutes ?? 60) +
      (syncPolicy?.settlementLagMinutes ?? 5),
  });
  if (checkpoint?.integrityBlockedAt) {
    blockers.push({
      type: "usage_integrity_blocked",
      message: "用量同步存在阻断完整结算的严重完整性异常",
    });
  }
  const settlementRunHealthy =
    checkpoint?.lastRunStatus === "applied" ||
    checkpoint?.lastRunStatus === "continuation_pending";
  if (!watermarkFresh || !settlementRunHealthy) {
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
  const unscopedPlan = {
    scope: "global" as const,
    assignedQuota: 0,
    blocked: false,
    alreadyOpenedUsers: 0,
    users: [] as Array<{
      feishuUserId: string;
      assignedMonthlyQuota: number;
      hasActiveToken: boolean;
    }>,
  };
  for (const candidate of snapshot.candidates) {
    const feishuUserId = candidate.feishuUserId;
    if (!candidate.departmentId) {
      if (candidate.isGlobalAdmin) {
        unscopedPlan.assignedQuota += candidate.assignedMonthlyQuota;
        if (candidate.alreadyOpened) {
          unscopedPlan.alreadyOpenedUsers += 1;
        } else {
          unscopedPlan.users.push({
            feishuUserId,
            assignedMonthlyQuota: candidate.assignedMonthlyQuota,
            hasActiveToken: candidate.activeTokenCount > 0,
          });
        }
        continue;
      }
      blockers.push({
        type: "missing_department",
        feishuUserId,
        message: "有效额度策略用户缺少部门归属",
      });
      continue;
    }
    const periodBudget = snapshot.departmentQuotaPeriods.find(
      (item) => item.departmentId === candidate.departmentId && item.period === period,
    );
    if (!periodBudget) {
      blockers.push({
        type: "missing_department_budget",
        departmentId: candidate.departmentId,
        message: "部门缺少目标账期预算",
      });
    }
    const current = departmentPlans.get(candidate.departmentId) ?? {
      departmentId: candidate.departmentId,
      budgetQuota: Math.max(Math.round((periodBudget?.quotaLimit ?? 0) * quotaPerUnit), 0),
      assignedQuota: 0,
      blocked: false,
      alreadyOpenedUsers: 0,
      users: [],
    };
    current.assignedQuota += candidate.assignedMonthlyQuota;
    if (candidate.alreadyOpened) {
      current.alreadyOpenedUsers += 1;
    } else {
      current.users.push({
        feishuUserId,
        assignedMonthlyQuota: candidate.assignedMonthlyQuota,
        hasActiveToken: candidate.activeTokenCount > 0,
      });
    }
    departmentPlans.set(candidate.departmentId, current);
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
  unscopedPlan.users.sort((a, b) => a.feishuUserId.localeCompare(b.feishuUserId));
  const unscopedUserIds = new Set(
    snapshot.candidates
      .filter((candidate) => !candidate.departmentId && candidate.isGlobalAdmin)
      .map((candidate) => candidate.feishuUserId),
  );
  unscopedPlan.blocked = blockers.some(
    (item) => item.feishuUserId && unscopedUserIds.has(item.feishuUserId),
  );
  return {
    period,
    dryRun: true,
    settledThrough: checkpoint?.settledThrough,
    blocked: blockers.length > 0,
    blockers,
    departments: [...departmentPlans.values()],
    unscoped: unscopedPlan,
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
    departmentId?: string;
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
  const remaining =
    input.limit === undefined
      ? input.plan.unscoped.users.length
      : Math.max(input.limit - selectedUsers.length, 0);
  selectedUsers.push(
    ...[...input.plan.unscoped.users]
      .sort((a, b) => a.feishuUserId.localeCompare(b.feishuUserId))
      .slice(0, remaining),
  );
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

export async function enqueuePackageResetPlan(input: {
  plan: Awaited<ReturnType<typeof buildMonthlyPeriodOpenPlan>>;
}) {
  if (input.plan.blocked) throw new Error("套餐重置 preflight 存在阻塞项");
  const users = [
    ...input.plan.departments.flatMap((department) =>
      department.blocked
        ? []
        : department.users.map((user) => ({
            ...user,
            departmentId: department.departmentId,
          })),
    ),
    ...input.plan.unscoped.users.map((user) => ({
      ...user,
      departmentId: undefined,
    })),
  ];
  return enqueueMonthlyOpenBatch(
    users.map((user) => ({
      feishuUserId: user.feishuUserId,
      departmentId: user.departmentId,
      period: input.plan.period,
      assignedMonthlyQuota: user.assignedMonthlyQuota,
      createdByOpenId: PACKAGE_RESET_SYSTEM_ACTOR,
    })),
    { executionSource: "package_reset" },
  );
}
