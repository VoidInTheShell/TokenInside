const ONE_DECIMAL = new Intl.NumberFormat("zh-CN", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

function finiteNonNegative(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(value, 0) : 0;
}

export function buildUsageOverview(input: {
  monthlyQuota?: number | null;
  quotaConsumed?: number | null;
  remainingQuota?: number | null;
}) {
  const monthlyQuota = finiteNonNegative(input.monthlyQuota);
  const quotaConsumed = finiteNonNegative(input.quotaConsumed);
  const remainingQuota =
    typeof input.remainingQuota === "number" && Number.isFinite(input.remainingQuota)
      ? Math.max(input.remainingQuota, 0)
      : Math.max(monthlyQuota - quotaConsumed, 0);
  const remainingPercent =
    monthlyQuota > 0 ? Math.min(Math.max((remainingQuota / monthlyQuota) * 100, 0), 100) : 0;

  return { monthlyQuota, quotaConsumed, remainingQuota, remainingPercent };
}

export function parseAuthoritativeResetAt(value?: string | null) {
  if (!value) return null;
  const resetAt = new Date(value);
  return Number.isFinite(resetAt.getTime()) ? resetAt : null;
}

export function formatPackagePeriod(period?: string | null) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period ?? "");
  return match ? `${match[1]}年${Number(match[2])}月套餐周期` : "当前套餐周期";
}

export function formatResetCountdown(resetAt: Date | null, nowMs: number) {
  if (!resetAt || !Number.isFinite(resetAt.getTime())) return "等待套餐周期信息";
  const diffMinutes = Math.max(Math.ceil((resetAt.getTime() - nowMs) / 60_000), 0);
  if (diffMinutes <= 0) return "即将刷新";
  const days = Math.floor(diffMinutes / (24 * 60));
  const hours = Math.floor((diffMinutes % (24 * 60)) / 60);
  const minutes = diffMinutes % 60;
  if (days > 0) return `${days}天 ${hours}小时`;
  if (hours > 0) return `${hours}小时 ${minutes}分钟`;
  return `${minutes}分钟`;
}

export function formatOneDecimal(value?: number | null) {
  return ONE_DECIMAL.format(finiteNonNegative(value));
}

export function formatTokensOneDecimal(value?: number | null) {
  const tokens = finiteNonNegative(value);
  if (tokens >= 1_000_000_000) return `${ONE_DECIMAL.format(tokens / 1_000_000_000)}B`;
  if (tokens >= 1_000_000) return `${ONE_DECIMAL.format(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${ONE_DECIMAL.format(tokens / 1_000)}K`;
  return ONE_DECIMAL.format(tokens);
}
