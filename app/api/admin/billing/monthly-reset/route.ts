import { after, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import {
  buildMonthlyPeriodOpenPlan,
  enqueueMonthlyPeriodOpenPlan,
} from "@/lib/billing";
import { getConfig } from "@/lib/config";
import {
  assertQuotaWriteActionEnabled,
  quotaFeatureErrorStatus,
} from "@/lib/quota-guard";
import { runQuotaOperation } from "@/lib/quota-saga";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const monthlyResetSchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
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
      { error: "period 必须是有效 YYYY-MM，dryRun 必须是布尔值" },
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

  if (!parsed.data.dryRun) {
    try {
      await assertQuotaWriteActionEnabled("monthly_open");
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "月度开账当前未启用" },
        { status: quotaFeatureErrorStatus(err) ?? 503 },
      );
    }
  }

  const plan = await buildMonthlyPeriodOpenPlan({ period: parsed.data.period });
  if (parsed.data.dryRun) return NextResponse.json(plan);
  if (plan.blocked) {
    return NextResponse.json(
      { error: "月度开账 preflight 存在阻塞项", plan },
      { status: 409 },
    );
  }
  let operations;
  try {
    operations = await enqueueMonthlyPeriodOpenPlan({
      plan,
      createdByOpenId: auth.user.openId,
      limit: parsed.data.limit,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "月度开账批量创建失败",
        plan,
      },
      { status: 409 },
    );
  }
  for (const operation of operations) {
    after(() => runQuotaOperation(operation.id).catch(() => undefined));
  }
  return NextResponse.json({ ...plan, dryRun: false, operations }, { status: 202 });
}
