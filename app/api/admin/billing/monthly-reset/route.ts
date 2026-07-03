import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { runMonthlyBillingReset } from "@/lib/billing";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const monthlyResetSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  dryRun: z.boolean().default(true),
  limit: z.number().int().positive().max(500).optional(),
});

export async function POST(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  if (auth.scope.scopeType !== "global") {
    return NextResponse.json(
      { error: "月度账期重置只能由全局管理员执行" },
      { status: 403 },
    );
  }

  const parsed = monthlyResetSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "period 必须是 YYYY-MM，dryRun 必须是布尔值" },
      { status: 400 },
    );
  }

  const config = getConfig();
  if (!parsed.data.dryRun && !config.billing.monthlyResetEnabled) {
    return NextResponse.json(
      {
        error: "月度账期重置当前未启用",
        hint: "确认备份、PostgreSQL/JSON 状态和维护窗口后，将 TOKENINSIDE_MONTHLY_RESET_ENABLED=true 写入服务器环境变量再执行非 dry-run。",
      },
      { status: 403 },
    );
  }

  const result = await runMonthlyBillingReset({
    period: parsed.data.period,
    dryRun: parsed.data.dryRun,
    limit: parsed.data.limit,
    operatedByFeishuUserId: auth.user.id,
  });
  return NextResponse.json(result);
}
