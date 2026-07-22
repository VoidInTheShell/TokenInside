import type { PackageResetPolicy } from "./types";

const HONG_KONG_OFFSET_MS = 8 * 60 * 60 * 1000;

export const DEFAULT_PACKAGE_RESET_DAY = 1;
export const PACKAGE_RESET_SYSTEM_ACTOR = "system:package-reset";

export function defaultPackageResetPolicy(): PackageResetPolicy {
  return {
    enabled: false,
    dayOfMonth: DEFAULT_PACKAGE_RESET_DAY,
  };
}

export function normalizePackageResetPolicy(
  policy?: Partial<PackageResetPolicy>,
): PackageResetPolicy {
  const day = Math.trunc(Number(policy?.dayOfMonth ?? DEFAULT_PACKAGE_RESET_DAY));
  return {
    enabled: policy?.enabled === true,
    dayOfMonth: Math.min(Math.max(Number.isFinite(day) ? day : DEFAULT_PACKAGE_RESET_DAY, 1), 31),
    updatedAt: policy?.updatedAt,
    updatedByFeishuUserId: policy?.updatedByFeishuUserId,
  };
}

function hongKongParts(date: Date) {
  const shifted = new Date(date.getTime() + HONG_KONG_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
  };
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function resetOccurrence(year: number, month: number, dayOfMonth: number) {
  const day = Math.min(dayOfMonth, daysInMonth(year, month));
  return new Date(Date.UTC(year, month - 1, day, -8, 0, 0, 0));
}

function shiftMonth(year: number, month: number, delta: number) {
  const shifted = new Date(Date.UTC(year, month - 1 + delta, 1));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
  };
}

function periodId(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function periodAfterResetOccurrence(
  year: number,
  month: number,
  dayOfMonth: number,
) {
  // Day 1 keeps the existing calendar-month identifier. For any later reset
  // day, label the cycle by the month in which it ends. This avoids colliding
  // with calendar-month first-provision markers created before the reset day.
  const target = dayOfMonth === 1 ? { year, month } : shiftMonth(year, month, 1);
  return periodId(target.year, target.month);
}

export type DuePackageReset = {
  period: string;
  scheduledAt: string;
};

export function latestDuePackageReset(
  policy: Partial<PackageResetPolicy> | undefined,
  now = new Date(),
): DuePackageReset | null {
  const normalized = normalizePackageResetPolicy(policy);
  if (!normalized.enabled) return null;

  const current = hongKongParts(now);
  let occurrence = resetOccurrence(
    current.year,
    current.month,
    normalized.dayOfMonth,
  );
  let occurrenceMonth = current;
  if (occurrence.getTime() > now.getTime()) {
    occurrenceMonth = shiftMonth(current.year, current.month, -1);
    occurrence = resetOccurrence(
      occurrenceMonth.year,
      occurrenceMonth.month,
      normalized.dayOfMonth,
    );
  }

  return {
    period: periodAfterResetOccurrence(
      occurrenceMonth.year,
      occurrenceMonth.month,
      normalized.dayOfMonth,
    ),
    scheduledAt: occurrence.toISOString(),
  };
}

export function nextPackageResetAt(
  policy: Partial<PackageResetPolicy> | undefined,
  now = new Date(),
) {
  const normalized = normalizePackageResetPolicy(policy);
  if (!normalized.enabled) return null;

  const current = hongKongParts(now);
  let occurrenceMonth = current;
  let occurrence = resetOccurrence(
    current.year,
    current.month,
    normalized.dayOfMonth,
  );
  if (occurrence.getTime() <= now.getTime()) {
    occurrenceMonth = shiftMonth(current.year, current.month, 1);
    occurrence = resetOccurrence(
      occurrenceMonth.year,
      occurrenceMonth.month,
      normalized.dayOfMonth,
    );
  }
  return occurrence;
}

export function packagePeriod(
  policy: Partial<PackageResetPolicy> | undefined,
  now = new Date(),
) {
  const normalized = normalizePackageResetPolicy(policy);
  const current = hongKongParts(now);
  if (!normalized.enabled) return periodId(current.year, current.month);

  const due = latestDuePackageReset(normalized, now);
  return due?.period ?? periodId(current.year, current.month);
}

export function nextPackagePeriod(
  policy: Partial<PackageResetPolicy> | undefined,
  now = new Date(),
) {
  const normalized = normalizePackageResetPolicy(policy);
  const nextReset = nextPackageResetAt(normalized, now);
  if (nextReset) {
    return packagePeriod(normalized, new Date(nextReset.getTime() + 1));
  }

  const current = hongKongParts(now);
  const next = shiftMonth(current.year, current.month, 1);
  return periodId(next.year, next.month);
}

export function packageWindow(
  policy: Partial<PackageResetPolicy> | undefined,
  now = new Date(),
) {
  const normalized = normalizePackageResetPolicy(policy);
  if (normalized.enabled) {
    const due = latestDuePackageReset(normalized, now);
    const next = nextPackageResetAt(normalized, now);
    if (due && next) {
      return {
        period: due.period,
        startAt: due.scheduledAt,
        endAt: new Date(next.getTime() - 1).toISOString(),
        nextResetAt: next.toISOString(),
      };
    }
  }

  const current = hongKongParts(now);
  const start = resetOccurrence(current.year, current.month, 1);
  const nextMonth = shiftMonth(current.year, current.month, 1);
  const next = resetOccurrence(nextMonth.year, nextMonth.month, 1);
  return {
    period: periodId(current.year, current.month),
    startAt: start.toISOString(),
    endAt: new Date(next.getTime() - 1).toISOString(),
    nextResetAt: next.toISOString(),
  };
}

export function assertPackageResetExecutionAllowed(input: {
  policy: Partial<PackageResetPolicy> | undefined;
  period: string;
  now?: Date;
}) {
  const due = latestDuePackageReset(input.policy, input.now);
  if (!due) throw new Error("套餐重置自动任务已关闭");
  if (due.period !== input.period) {
    throw new Error(`套餐重置配置已变化，当前应执行套餐周期为 ${due.period}`);
  }
  return due;
}
