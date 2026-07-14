import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import {
  getDepartmentBudgetOverview,
  upsertDepartmentBudget,
} from "@/lib/package-repository";
import { packageRouteError } from "@/lib/package-route";
import { getQuotaDisplaySnapshot } from "@/lib/quota-display";
import { parseDisplayQuota } from "@/lib/quota-display-model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const budgetSchema = z.object({
  departmentId: z.string().min(1).max(200),
  periodType: z.enum(["calendar_month", "calendar_quarter", "fixed_range"]),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  budgetQuotaDisplay: z.number().min(0),
  configVersion: z.string().min(1).max(128),
});

export async function GET(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  try {
    const url = new URL(request.url);
    return NextResponse.json(
      await getDepartmentBudgetOverview({
        scope: auth.scope,
        departmentId: url.searchParams.get("departmentId") || undefined,
        at: url.searchParams.get("at") || undefined,
      }),
    );
  } catch (error) {
    return packageRouteError(error);
  }
}

export async function PUT(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  const parsed = budgetSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "invalid_department_budget", message: "部门预算参数无效", retryable: false } },
      { status: 400 },
    );
  }
  try {
    const snapshot = await getQuotaDisplaySnapshot({ refreshIfStale: true });
    if (!snapshot) {
      return NextResponse.json(
        { error: { code: "quota_display_config_unavailable", message: "没有可用的 NewAPI 额度显示配置", retryable: true } },
        { status: 503 },
      );
    }
    const { budgetQuotaDisplay, configVersion, ...budgetInput } = parsed.data;
    return NextResponse.json({
      budget: await upsertDepartmentBudget({
        scope: auth.scope,
        userId: auth.user.id,
        ...budgetInput,
        budgetQuota: parseDisplayQuota({
          displayValue: budgetQuotaDisplay,
          configVersion,
          snapshot,
        }),
      }),
    });
  } catch (error) {
    return packageRouteError(error);
  }
}
