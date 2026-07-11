import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { getAppSettings, getStoreSnapshot, updateAppSettings } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const usageSyncPolicySchema = z.object({
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().min(1).max(24 * 60).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  maxPagesPerRun: z.number().int().min(1).max(20).optional(),
  overlapMinutes: z.number().int().min(0).max(7 * 24 * 60).optional(),
  settlementLagMinutes: z.number().int().min(0).max(24 * 60).optional(),
  matchWindowMinutes: z.number().int().min(1).max(24 * 60).optional(),
  retryBaseMinutes: z.number().int().min(1).max(24 * 60).optional(),
});

const quotaFeatureFlagsSchema = z.object({
  legacyAbsoluteQuotaWritesEnabled: z.literal(false).optional(),
  quotaLedgerShadowRead: z.boolean().optional(),
  quotaSagaWritesEnabled: z.boolean().optional(),
  keyRotationSagaEnabled: z.boolean().optional(),
  quotaRestoreEnabled: z.boolean().optional(),
  monthlyPeriodOpenEnabled: z.boolean().optional(),
  reconciliationAutoDecreaseEnabled: z.boolean().optional(),
  reconciliationAutoIncreaseEnabled: z.literal(false).optional(),
});

const settingsSchema = z
  .object({
    defaultMonthlyQuota: z.number().int().positive().max(1000000).optional(),
    usageSyncPolicy: usageSyncPolicySchema.optional(),
    quotaFeatureFlags: quotaFeatureFlagsSchema.optional(),
  })
  .refine(
    (value) =>
      value.defaultMonthlyQuota !== undefined ||
      value.usageSyncPolicy !== undefined ||
      value.quotaFeatureFlags !== undefined,
  );

export async function GET() {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  if (auth.scope.scopeType !== "global") {
    return NextResponse.json(
      { error: "系统设置只能由全局管理员访问" },
      { status: 403 },
    );
  }
  return NextResponse.json({ settings: await getAppSettings() });
}

export async function PATCH(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  if (auth.scope.scopeType !== "global") {
    return NextResponse.json(
      { error: "系统设置只能由全局管理员访问" },
      { status: 403 },
    );
  }
  const parsed = settingsSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "默认额度必须是正整数，同步周期/页数/窗口必须在允许范围内" },
      { status: 400 },
    );
  }
  if (parsed.data.quotaFeatureFlags) {
    const current = await getAppSettings();
    const next = {
      ...current.quotaFeatureFlags,
      ...parsed.data.quotaFeatureFlags,
      legacyAbsoluteQuotaWritesEnabled: false,
      reconciliationAutoIncreaseEnabled: false,
    };
    const writeFeatureEnabled = Boolean(
      next.quotaSagaWritesEnabled ||
        next.keyRotationSagaEnabled ||
        next.quotaRestoreEnabled ||
        next.monthlyPeriodOpenEnabled ||
        next.reconciliationAutoDecreaseEnabled,
    );
    if (writeFeatureEnabled && !current.quotaMigration?.appliedAt) {
      return NextResponse.json(
        { error: "历史额度账本迁移未登记，不能启用 F 阶段写功能" },
        { status: 409 },
      );
    }
    if (
      !next.quotaSagaWritesEnabled &&
      (next.keyRotationSagaEnabled ||
        next.quotaRestoreEnabled ||
        next.monthlyPeriodOpenEnabled ||
        next.reconciliationAutoDecreaseEnabled)
    ) {
      return NextResponse.json(
        { error: "具体额度动作依赖统一 Saga 写入开关" },
        { status: 400 },
      );
    }
    if (
      current.quotaFeatureFlags?.quotaSagaWritesEnabled &&
      !next.quotaSagaWritesEnabled
    ) {
      const store = await getStoreSnapshot();
      const openOperation = store.quotaOperations.find(
        (item) => item.state !== "completed" && item.state !== "compensated",
      );
      if (openOperation) {
        return NextResponse.json(
          { error: `存在未结额度操作 ${openOperation.id}，不能关闭 Saga worker` },
          { status: 409 },
        );
      }
    }
  }
  const settings = await updateAppSettings({
    defaultMonthlyQuota: parsed.data.defaultMonthlyQuota,
    usageSyncPolicy: parsed.data.usageSyncPolicy,
    quotaFeatureFlags: parsed.data.quotaFeatureFlags,
    updatedByFeishuUserId: auth.user.id,
  });
  return NextResponse.json({ settings });
}
