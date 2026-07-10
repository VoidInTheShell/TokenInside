import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDateTime(value?: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

const COMPACT_NUMBER_UNITS = [
  { value: 1_000_000_000_000, suffix: "T" },
  { value: 1_000_000_000, suffix: "B" },
  { value: 1_000_000, suffix: "M" },
  { value: 1_000, suffix: "K" },
] as const;

function trimTrailingDecimalZeros(value: string) {
  return value.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function compactFractionDigits(scaled: number, fixedFractionDigits?: number) {
  if (fixedFractionDigits !== undefined) return fixedFractionDigits;
  if (scaled >= 100) return 0;
  if (scaled >= 10) return 1;
  return 2;
}

function formatCompactScaledValue(
  absValue: number,
  unitIndex: number,
  fixedFractionDigits?: number,
): string {
  const unit = COMPACT_NUMBER_UNITS[unitIndex];
  const scaled = absValue / unit.value;
  const fractionDigits = compactFractionDigits(scaled, fixedFractionDigits);
  const rounded = Number(scaled.toFixed(fractionDigits));

  if (rounded >= 1000 && unitIndex > 0) {
    return formatCompactScaledValue(absValue, unitIndex - 1, fixedFractionDigits);
  }

  return `${trimTrailingDecimalZeros(scaled.toFixed(fractionDigits))}${unit.suffix}`;
}

export function formatCompactNumber(
  value: number | null | undefined,
  options: { fractionDigits?: number; nullLabel?: string } = {},
) {
  if (value === undefined || value === null) return options.nullLabel ?? "0";

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return options.nullLabel ?? "0";

  const sign = numericValue < 0 ? "-" : "";
  const absValue = Math.abs(numericValue);

  if (absValue < 1_000) {
    return `${sign}${
      Number.isInteger(absValue) ? absValue.toString() : trimTrailingDecimalZeros(absValue.toFixed(1))
    }`;
  }

  const unitIndex = COMPACT_NUMBER_UNITS.findIndex((unit) => absValue >= unit.value);
  if (unitIndex === -1) return `${sign}${Math.round(absValue)}`;

  return `${sign}${formatCompactScaledValue(absValue, unitIndex, options.fractionDigits)}`;
}

export function formatTokenAmount(value: number | null | undefined, nullLabel = "-") {
  return formatCompactNumber(value, { nullLabel });
}

export function formatQuotaAmount(value: number | null | undefined, nullLabel = "-") {
  if (value === undefined || value === null) return nullLabel;
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return nullLabel;
  if (numericValue === 0) return "0";

  const sign = numericValue < 0 ? "-" : "";
  const absValue = Math.abs(numericValue);
  if (absValue < 1_000) {
    const fractionDigits = absValue < 0.000001 ? 10 : absValue < 0.01 ? 8 : 6;
    return `${sign}${trimTrailingDecimalZeros(absValue.toFixed(fractionDigits))}`;
  }
  return formatCompactNumber(value, { nullLabel });
}

export function maskSecret(value?: string | null) {
  if (!value) return "未发放";
  if (value.length <= 12) return value;
  return `${value.slice(0, 7)}...${value.slice(-5)}`;
}

export function formatDepartmentName(
  departmentName?: string | null,
  departmentId?: string | null,
  fallback = "-",
) {
  const name = departmentName?.trim();
  if (name) return name;
  return departmentId ? maskSecret(departmentId) : fallback;
}

export function maskApiKey(value?: string | null) {
  if (!value) return "未发放";
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}
