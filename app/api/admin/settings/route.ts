import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { getAppSettings, updateAppSettings } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const usageSyncPolicySchema = z.object({
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().min(1).max(24 * 60).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  maxPagesPerRun: z.number().int().min(1).max(20).optional(),
  overlapMinutes: z.number().int().min(0).max(7 * 24 * 60).optional(),
  matchWindowMinutes: z.number().int().min(1).max(24 * 60).optional(),
});

const settingsSchema = z
  .object({
    defaultMonthlyQuota: z.number().int().positive().max(1000000).optional(),
    usageSyncPolicy: usageSyncPolicySchema.optional(),
  })
  .refine((value) => value.defaultMonthlyQuota !== undefined || value.usageSyncPolicy !== undefined);

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
  const settings = await updateAppSettings({
    defaultMonthlyQuota: parsed.data.defaultMonthlyQuota,
    usageSyncPolicy: parsed.data.usageSyncPolicy,
    updatedByFeishuUserId: auth.user.id,
  });
  return NextResponse.json({ settings });
}
