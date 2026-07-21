import { NextResponse } from "next/server";
import { z } from "zod";
import { isRootAdminScope, requireAdminScope } from "@/lib/admin";
import {
  buildMonthlyPeriodOpenPlan,
  enqueueMonthlyPeriodOpenPlan,
} from "@/lib/billing";
import { isAdminUserActionAuthorizationError } from "@/lib/postgres-store";
import {
  assertQuotaWriteActionEnabled,
  quotaFeatureErrorStatus,
} from "@/lib/quota-guard";
import { ensureQuotaOperationWorker } from "@/lib/quota-saga";
import { getCurrentPackageBillingPeriod } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const periodOpenSchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  dryRun: z.boolean().default(true),
  limit: z.number().int().positive().max(500).optional(),
});

export async function POST(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  if (!isRootAdminScope(auth.scope)) {
    return NextResponse.json(
      { error: "套餐重置维护入口仅允许 root 执行" },
      { status: 403 },
    );
  }

  const parsed = periodOpenSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "period 必须是有效 YYYY-MM，dryRun 必须是布尔值" },
      { status: 400 },
    );
  }

  if (!parsed.data.dryRun) {
    try {
      await assertQuotaWriteActionEnabled("monthly_open");
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "套餐重置已暂停" },
        { status: quotaFeatureErrorStatus(error) ?? 503 },
      );
    }
  }

  const period = parsed.data.period ?? (await getCurrentPackageBillingPeriod());
  const plan = await buildMonthlyPeriodOpenPlan({ period });
  if (parsed.data.dryRun) return NextResponse.json(plan);
  if (plan.blocked) {
    return NextResponse.json(
      { error: "套餐重置 preflight 存在阻塞项", plan },
      { status: 409 },
    );
  }
  try {
    const operations = await enqueueMonthlyPeriodOpenPlan({
      plan,
      createdByOpenId: auth.user.openId,
      limit: parsed.data.limit,
    });
    ensureQuotaOperationWorker();
    return NextResponse.json({ ...plan, dryRun: false, operations }, { status: 202 });
  } catch (error) {
    if (isAdminUserActionAuthorizationError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "套餐重置批量创建失败",
        plan,
      },
      { status: 409 },
    );
  }
}
