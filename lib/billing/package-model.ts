import { PackageBillingError } from "./package-errors.ts";
import type {
  BillingPackageVersion,
  DepartmentBudgetPeriod,
  PackageCycleType,
  PackageRegrantPolicy,
  UserPackageGrant,
} from "./package-types";

export const MAX_RAW_QUOTA = Number.MAX_SAFE_INTEGER;
export const PACKAGE_TIMEZONE = "Asia/Hong_Kong" as const;
const HONG_KONG_OFFSET_MS = 8 * 60 * 60 * 1000;

export function assertRawQuota(value: number, field = "rawQuota") {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PackageBillingError(
      "invalid_raw_quota",
      `${field} 必须是 JavaScript 安全整数范围内的非负 raw quota`,
      400,
    );
  }
  return value;
}

export function assertPositiveRawQuota(value: number, field = "rawQuota") {
  assertRawQuota(value, field);
  if (value === 0) {
    throw new PackageBillingError("invalid_raw_quota", `${field} 必须大于 0`, 400);
  }
  return value;
}

function hongKongParts(value: Date) {
  const shifted = new Date(value.getTime() + HONG_KONG_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    millisecond: shifted.getUTCMilliseconds(),
  };
}

function fromHongKongParts(parts: {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  millisecond?: number;
}) {
  return new Date(
    Date.UTC(
      parts.year,
      parts.month,
      parts.day,
      parts.hour ?? 0,
      parts.minute ?? 0,
      parts.second ?? 0,
      parts.millisecond ?? 0,
    ) - HONG_KONG_OFFSET_MS,
  );
}

export function packageGrantWindow(input: {
  cycleType: PackageCycleType;
  cycleValue: number;
  startsAt?: string;
  timezone?: string;
}) {
  if (input.timezone && input.timezone !== PACKAGE_TIMEZONE) {
    throw new PackageBillingError(
      "unsupported_package_timezone",
      "首版套餐只支持 Asia/Hong_Kong 时区",
      400,
    );
  }
  if (!Number.isInteger(input.cycleValue) || input.cycleValue <= 0) {
    throw new PackageBillingError("invalid_package_cycle", "套餐周期值必须是正整数", 400);
  }
  const start = input.startsAt ? new Date(input.startsAt) : new Date();
  if (Number.isNaN(start.getTime())) {
    throw new PackageBillingError("invalid_package_cycle", "套餐生效时间无效", 400);
  }
  let expiresAt: Date;
  if (input.cycleType === "fixed_days") {
    expiresAt = new Date(start.getTime() + input.cycleValue * 24 * 60 * 60 * 1000);
  } else {
    const parts = hongKongParts(start);
    const targetMonth =
      input.cycleType === "calendar_month"
        ? parts.month + input.cycleValue
        : Math.floor(parts.month / 3) * 3 + input.cycleValue * 3;
    expiresAt = fromHongKongParts({
      year: parts.year,
      month: targetMonth,
      day: 1,
    });
  }
  return { startsAt: start.toISOString(), expiresAt: expiresAt.toISOString() };
}

export function remainingGrantQuota(grant: Pick<UserPackageGrant, "grantedQuota" | "allocatedQuota">) {
  assertPositiveRawQuota(grant.grantedQuota, "grantedQuota");
  assertRawQuota(grant.allocatedQuota, "allocatedQuota");
  if (grant.allocatedQuota > grant.grantedQuota) {
    throw new PackageBillingError(
      "grant_overallocated",
      "套餐 grant 已分摊额度不能超过发放额度",
      409,
    );
  }
  return grant.grantedQuota - grant.allocatedQuota;
}

export function sortAllocatableGrants(grants: UserPackageGrant[]) {
  return grants
    .filter((grant) => grant.status === "active" && remainingGrantQuota(grant) > 0)
    .sort((left, right) =>
      left.expiresAt.localeCompare(right.expiresAt) ||
      left.startsAt.localeCompare(right.startsAt) ||
      left.id.localeCompare(right.id),
    );
}

export function planGrantAllocations(grants: UserPackageGrant[], authoritativeQuota: number) {
  assertRawQuota(authoritativeQuota, "authoritativeQuota");
  let remaining = authoritativeQuota;
  const allocations: Array<{ grantId: string; quota: number }> = [];
  for (const grant of sortAllocatableGrants(grants)) {
    if (remaining === 0) break;
    const quota = Math.min(remainingGrantQuota(grant), remaining);
    if (quota > 0) allocations.push({ grantId: grant.id, quota });
    remaining -= quota;
  }
  if (remaining !== 0) {
    throw new PackageBillingError(
      "insufficient_package_quota",
      "权威消费超过请求冻结时可分摊的套餐额度",
      409,
    );
  }
  return allocations;
}

export function availableDepartmentBudget(
  budget: Pick<DepartmentBudgetPeriod, "budgetQuota" | "committedQuota" | "pendingQuota">,
) {
  const total = assertRawQuota(budget.budgetQuota, "budgetQuota");
  const committed = assertRawQuota(budget.committedQuota, "committedQuota");
  const pending = assertRawQuota(budget.pendingQuota, "pendingQuota");
  if (committed + pending > total) {
    throw new PackageBillingError(
      "department_budget_invariant_broken",
      "部门预算已承诺额度与审批中额度之和超过总预算",
      500,
    );
  }
  return total - committed - pending;
}

export function issuablePackageCount(
  budget: Pick<DepartmentBudgetPeriod, "budgetQuota" | "committedQuota" | "pendingQuota">,
  version: Pick<BillingPackageVersion, "grantedQuota">,
) {
  return Math.floor(availableDepartmentBudget(budget) / assertPositiveRawQuota(version.grantedQuota));
}

export function canUserRequestRegrant(input: {
  grant?: UserPackageGrant | null;
  policy: PackageRegrantPolicy;
  now?: string;
}) {
  const grant = input.grant;
  if (!grant) return true;
  const remaining = remainingGrantQuota(grant);
  switch (input.policy.mode) {
    case "exhausted":
      return remaining === 0;
    case "remaining_ratio":
      return remaining / grant.grantedQuota <= (input.policy.thresholdRatio ?? 0);
    case "remaining_quota":
      return remaining <= (input.policy.thresholdQuota ?? 0);
    case "near_expiry": {
      const now = new Date(input.now ?? Date.now()).getTime();
      const expires = new Date(grant.expiresAt).getTime();
      return expires - now <= (input.policy.nearExpiryHours ?? 0) * 60 * 60 * 1000;
    }
  }
}
