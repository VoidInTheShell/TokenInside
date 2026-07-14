import { sha256Hex } from "./crypto.ts";
import { PackageBillingError } from "./package-errors.ts";
import { assertPositiveRawQuota, assertRawQuota } from "./package-model.ts";
import type {
  DisplayQuota,
  NewApiQuotaDisplaySnapshot,
  QuotaDisplayType,
} from "./package-types.ts";

type StatusData = Record<string, unknown>;

function finitePositive(value: unknown, field: string) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new PackageBillingError(
      "quota_display_config_invalid",
      `NewAPI ${field} 必须是正数`,
      502,
      true,
    );
  }
  return parsed;
}

function displayType(data: StatusData): QuotaDisplayType {
  const raw = typeof data.quota_display_type === "string"
    ? data.quota_display_type.toUpperCase()
    : undefined;
  if (raw === "USD" || raw === "CNY" || raw === "CUSTOM") return raw;
  if (raw === "TOKENS") return "RAW_QUOTA";
  if (raw !== undefined) {
    throw new PackageBillingError(
      "quota_display_config_invalid",
      "NewAPI quota_display_type 无效",
      502,
      true,
    );
  }
  return data.display_in_currency === true ? "USD" : "RAW_QUOTA";
}

export function normalizeNewApiQuotaDisplayStatus(
  data: StatusData,
  fetchedAt = new Date().toISOString(),
): NewApiQuotaDisplaySnapshot {
  const quotaPerUnit = finitePositive(data.quota_per_unit, "quota_per_unit");
  assertPositiveRawQuota(quotaPerUnit, "quotaPerUnit");
  const normalized = {
    quotaPerUnit,
    displayInCurrency: data.display_in_currency === true,
    displayType: displayType(data),
    usdExchangeRate: finitePositive(data.usd_exchange_rate ?? 1, "usd_exchange_rate"),
    customCurrencySymbol:
      typeof data.custom_currency_symbol === "string" && data.custom_currency_symbol.trim()
        ? data.custom_currency_symbol.trim()
        : "$",
    customCurrencyExchangeRate: finitePositive(
      data.custom_currency_exchange_rate ?? 1,
      "custom_currency_exchange_rate",
    ),
  };
  const configVersion = sha256Hex(JSON.stringify(normalized));
  return {
    configVersion,
    ...normalized,
    fetchedAt,
    sourceStatus: "current",
  };
}

function displayMeta(snapshot: NewApiQuotaDisplaySnapshot) {
  switch (snapshot.displayType) {
    case "CNY":
      return { kind: "currency" as const, currency: "CNY", exchangeRate: snapshot.usdExchangeRate };
    case "CUSTOM":
      return {
        kind: "custom" as const,
        symbol: snapshot.customCurrencySymbol,
        exchangeRate: snapshot.customCurrencyExchangeRate,
      };
    case "RAW_QUOTA":
      return { kind: "raw" as const, exchangeRate: 1 };
    case "USD":
      return { kind: "currency" as const, currency: "USD", exchangeRate: 1 };
  }
}

function fractionDigits(value: number) {
  return Math.abs(value) >= 1 ? 2 : 4;
}

export function formatRawQuota(
  rawQuota: number,
  snapshot?: NewApiQuotaDisplaySnapshot | null,
): DisplayQuota {
  assertRawQuota(rawQuota);
  if (!snapshot || snapshot.displayType === "RAW_QUOTA") {
    const configVersion = snapshot?.configVersion ?? "raw-quota-fallback";
    return {
      rawQuota,
      display: {
        formatted: `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(rawQuota)} 点额度`,
        unitLabel: "点额度",
        displayType: "RAW_QUOTA",
        configVersion,
      },
    };
  }
  const meta = displayMeta(snapshot);
  const amount = (rawQuota / snapshot.quotaPerUnit) * meta.exchangeRate;
  const digits = fractionDigits(amount);
  let formatted: string;
  let unitLabel: string;
  if (meta.kind === "currency") {
    formatted = new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: meta.currency,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 0,
      maximumFractionDigits: digits,
    }).format(amount);
    unitLabel = meta.currency;
  } else if (meta.kind === "custom") {
    const decimal = new Intl.NumberFormat("zh-CN", {
      minimumFractionDigits: 0,
      maximumFractionDigits: digits,
    }).format(amount);
    formatted = `${meta.symbol} ${decimal}`;
    unitLabel = meta.symbol;
  } else {
    formatted = `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(rawQuota)} 点额度`;
    unitLabel = "点额度";
  }
  return {
    rawQuota,
    display: {
      formatted,
      unitLabel,
      displayType: snapshot.displayType,
      configVersion: snapshot.configVersion,
    },
  };
}

export function parseDisplayQuota(input: {
  displayValue: number;
  configVersion: string;
  snapshot: NewApiQuotaDisplaySnapshot;
}) {
  if (input.configVersion !== input.snapshot.configVersion) {
    throw new PackageBillingError(
      "quota_display_config_changed",
      "NewAPI 额度显示配置已变化，请刷新后重新确认",
      409,
    );
  }
  if (input.snapshot.sourceStatus !== "current") {
    throw new PackageBillingError(
      "quota_display_config_unavailable",
      "当前没有可验证的 NewAPI 额度显示配置，不能提交额度写操作",
      503,
      true,
    );
  }
  if (!Number.isFinite(input.displayValue) || input.displayValue < 0) {
    throw new PackageBillingError("invalid_display_quota", "显示额度必须是非负数", 400);
  }
  const meta = displayMeta(input.snapshot);
  const raw =
    meta.kind === "raw"
      ? Math.round(input.displayValue)
      : Math.round((input.displayValue / meta.exchangeRate) * input.snapshot.quotaPerUnit);
  return assertRawQuota(raw);
}
