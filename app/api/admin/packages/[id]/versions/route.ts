import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { createPackageVersion } from "@/lib/package-repository";
import { packageRouteError } from "@/lib/package-route";
import { getQuotaDisplaySnapshot } from "@/lib/quota-display";
import { parseDisplayQuota } from "@/lib/quota-display-model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const versionSchema = z.object({
  grantedQuotaDisplay: z.number().positive(),
  configVersion: z.string().min(1).max(128),
  cycleType: z.enum(["calendar_month", "calendar_quarter", "fixed_days"]),
  cycleValue: z.number().int().positive().max(3650),
  eligibilityPolicy: z.object({ allowFirstRequest: z.boolean() }).optional(),
  regrantPolicy: z.object({
    mode: z.enum(["exhausted", "remaining_ratio", "remaining_quota", "near_expiry"]),
    thresholdRatio: z.number().min(0).max(1).optional(),
    thresholdQuota: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    nearExpiryHours: z.number().int().min(0).max(24 * 365).optional(),
  }).optional(),
  effectiveFrom: z.string().datetime().optional(),
  effectiveUntil: z.string().datetime().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  const parsed = versionSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "invalid_package_version", message: "套餐版本参数无效", retryable: false } },
      { status: 400 },
    );
  }
  try {
    const { id } = await params;
    const snapshot = await getQuotaDisplaySnapshot({ refreshIfStale: true });
    if (!snapshot) {
      return NextResponse.json(
        { error: { code: "quota_display_config_unavailable", message: "没有可用的 NewAPI 额度显示配置", retryable: true } },
        { status: 503 },
      );
    }
    const { grantedQuotaDisplay, configVersion, ...versionInput } = parsed.data;
    const version = await createPackageVersion({
      scope: auth.scope,
      userId: auth.user.id,
      definitionId: id,
      ...versionInput,
      grantedQuota: parseDisplayQuota({
        displayValue: grantedQuotaDisplay,
        configVersion,
        snapshot,
      }),
    });
    return NextResponse.json({ version }, { status: 201 });
  } catch (error) {
    return packageRouteError(error);
  }
}
