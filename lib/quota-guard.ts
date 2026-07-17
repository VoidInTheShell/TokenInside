import {
  defaultQuotaFeatureFlags,
  getAppSettings,
  getAppSettingsForQuotaOperation,
} from "./store";
import type { QuotaFeatureFlags } from "./types";

export type QuotaWriteAction =
  | "first_provision"
  | "quota_adjust"
  | "key_rotation"
  | "quota_restore"
  | "monthly_open"
  | "reconcile";

export class QuotaFeatureDisabledError extends Error {
  readonly code = "quota_feature_disabled";
  readonly action: QuotaWriteAction;

  constructor(action: QuotaWriteAction, reason?: string) {
    super(reason ?? `F 阶段 ${action} 写入尚未启用；旧式绝对余额写入已关闭`);
    this.name = "QuotaFeatureDisabledError";
    this.action = action;
  }
}

export function quotaWriteActionEnabled(
  flags: QuotaFeatureFlags,
  action: QuotaWriteAction,
) {
  if (action === "reconcile") {
    return flags.quotaSagaWritesEnabled && flags.reconciliationAutoDecreaseEnabled;
  }
  if (flags.legacyAbsoluteQuotaWritesEnabled) return true;
  if (!flags.quotaSagaWritesEnabled) return false;
  if (action === "first_provision" || action === "quota_adjust") return true;
  if (action === "key_rotation") return flags.keyRotationSagaEnabled;
  if (action === "quota_restore") return flags.quotaRestoreEnabled;
  return flags.monthlyPeriodOpenEnabled;
}

export async function getQuotaFeatureFlags() {
  const settings = await getAppSettingsForQuotaOperation();
  return {
    ...defaultQuotaFeatureFlags(),
    ...settings.quotaFeatureFlags,
    reconciliationAutoIncreaseEnabled: false,
  };
}

export async function assertQuotaWriteActionEnabled(action: QuotaWriteAction) {
  const settings =
    action === "quota_restore" || action === "key_rotation"
      ? await getAppSettingsForQuotaOperation()
      : await getAppSettings();
  const flags = {
    ...defaultQuotaFeatureFlags(),
    ...settings.quotaFeatureFlags,
    reconciliationAutoIncreaseEnabled: false,
  };
  if (!quotaWriteActionEnabled(flags, action)) {
    console.warn(
      JSON.stringify({
        event: "tokeninside.quota.legacy_write_blocked",
        action,
      }),
    );
    throw new QuotaFeatureDisabledError(action);
  }
  if (!flags.legacyAbsoluteQuotaWritesEnabled && !settings.quotaMigration?.appliedAt) {
    throw new QuotaFeatureDisabledError(
      action,
      `F 阶段 ${action} 写入尚未就绪：历史额度账本迁移未完成`,
    );
  }
  return flags;
}

export async function assertLegacyAbsoluteQuotaWriteEnabled(action: QuotaWriteAction) {
  const flags = await getQuotaFeatureFlags();
  if (!flags.legacyAbsoluteQuotaWritesEnabled) {
    console.warn(
      JSON.stringify({
        event: "tokeninside.quota.legacy_absolute_write_blocked",
        action,
      }),
    );
    throw new QuotaFeatureDisabledError(action);
  }
  return flags;
}

export function quotaFeatureErrorStatus(error: unknown) {
  return error instanceof QuotaFeatureDisabledError ? 503 : undefined;
}
