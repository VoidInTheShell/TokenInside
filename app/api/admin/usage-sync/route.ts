import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { syncNewApiUsageLogs } from "@/lib/usage-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const usageSyncSchema = z.object({
  dryRun: z.boolean().default(true),
  page: z.number().int().min(0).optional(),
  size: z.number().int().positive().max(100).default(100),
  maxPages: z.number().int().positive().max(20).default(1),
  overlapMinutes: z.number().int().min(0).max(7 * 24 * 60).default(120),
  settlementLagMinutes: z.number().int().min(0).max(24 * 60).default(5),
  matchWindowMinutes: z.number().positive().max(24 * 60).default(30),
  retryBaseMinutes: z.number().int().min(1).max(24 * 60).default(5),
});

export async function POST(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  if (auth.scope.scopeType !== "global") {
    return NextResponse.json(
      { error: "NewAPI 用量同步只能由全局管理员执行" },
      { status: 403 },
    );
  }

  const parsed = usageSyncSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "dryRun 必须是布尔值，page/size/maxPages 必须是有效整数，同步窗口和重试参数必须在允许范围内",
      },
      { status: 400 },
    );
  }

  const result = await syncNewApiUsageLogs({
    dryRun: parsed.data.dryRun,
    page: parsed.data.page,
    size: parsed.data.size,
    maxPages: parsed.data.maxPages,
    overlapMinutes: parsed.data.overlapMinutes,
    settlementLagMinutes: parsed.data.settlementLagMinutes,
    matchWindowMs: parsed.data.matchWindowMinutes * 60 * 1000,
    retryBaseMinutes: parsed.data.retryBaseMinutes,
    operatedByFeishuUserId: auth.user.id,
    trigger: "manual",
  });
  return NextResponse.json(result);
}
