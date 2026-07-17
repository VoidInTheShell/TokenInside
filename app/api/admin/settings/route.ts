import { NextResponse } from "next/server";
import { z } from "zod";
import { isRootAdminScope, requireAdminScope } from "@/lib/admin";
import { getConfig } from "@/lib/config";
import {
  invalidateEffectiveNewApiConfig,
  newApiAccessTokenSecretContext,
} from "@/lib/newapi-runtime";
import { sealAppSecret } from "@/lib/secret-box";
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
    newapiControl: z.object({
      baseUrl: z.string().url().max(500),
      controlUserId: z.string().trim().min(1).max(100),
      accessToken: z.string().trim().min(1).max(2000).optional(),
    }).optional(),
    usageSyncPolicy: usageSyncPolicySchema.optional(),
    quotaFeatureFlags: quotaFeatureFlagsSchema.optional(),
  })
  .refine(
    (value) =>
      value.defaultMonthlyQuota !== undefined ||
      value.newapiControl !== undefined ||
      value.usageSyncPolicy !== undefined ||
      value.quotaFeatureFlags !== undefined,
  );

function visibleSettings(
  settings: Awaited<ReturnType<typeof getAppSettings>>,
  root: boolean,
) {
  const { newapiControl, ...safeSettings } = settings;
  const fallback = getConfig().newapi;
  return {
    ...safeSettings,
    ...(root
      ? {
          newapiControl: {
            baseUrl: newapiControl?.baseUrl ?? fallback.baseUrl,
            controlUserId: newapiControl?.controlUserId ?? fallback.controlUserId,
            accessTokenConfigured: Boolean(
              newapiControl?.accessTokenCiphertext ||
                fallback.accessToken ||
                fallback.adminAccessToken ||
                fallback.systemAk,
            ),
            source: newapiControl ? "system_settings" : "environment",
            updatedAt: newapiControl?.updatedAt,
          },
        }
      : {}),
  };
}

export async function GET() {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  if (auth.scope.scopeType !== "global") {
    return NextResponse.json(
      { error: "系统设置只能由全局管理员访问" },
      { status: 403 },
    );
  }
  const settings = await getAppSettings();
  return NextResponse.json({ settings: visibleSettings(settings, isRootAdminScope(auth.scope)) });
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
  if (parsed.data.newapiControl && !isRootAdminScope(auth.scope)) {
    return NextResponse.json(
      { error: "NewAPI 上游连接只能由 root 管理员修改" },
      { status: 403 },
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
  const currentSettings = await getAppSettings();
  if (
    parsed.data.newapiControl &&
    !parsed.data.newapiControl.accessToken &&
    !currentSettings.newapiControl?.accessTokenCiphertext
  ) {
    return NextResponse.json(
      { error: "首次保存 NewAPI 上游连接时必须填写用户 AK" },
      { status: 400 },
    );
  }
  const newapiControl = parsed.data.newapiControl
    ? {
        baseUrl: parsed.data.newapiControl.baseUrl.replace(/\/+$/, ""),
        controlUserId: parsed.data.newapiControl.controlUserId,
        accessTokenCiphertext: parsed.data.newapiControl.accessToken
          ? sealAppSecret(
              parsed.data.newapiControl.accessToken,
              newApiAccessTokenSecretContext(),
            )
          : currentSettings.newapiControl?.accessTokenCiphertext,
        updatedAt: new Date().toISOString(),
        updatedByFeishuUserId: auth.user.id,
      }
    : undefined;
  const settings = await updateAppSettings({
    defaultMonthlyQuota: parsed.data.defaultMonthlyQuota,
    newapiControl,
    usageSyncPolicy: parsed.data.usageSyncPolicy,
    quotaFeatureFlags: parsed.data.quotaFeatureFlags,
    updatedByFeishuUserId: auth.user.id,
  });
  if (newapiControl) invalidateEffectiveNewApiConfig();
  return NextResponse.json({
    settings: visibleSettings(settings, isRootAdminScope(auth.scope)),
  });
}
