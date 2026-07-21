import { NextResponse } from "next/server";
import { requireAdminScope } from "@/lib/admin";
import { getBillingHealth } from "@/lib/billing-health";
import { getCurrentPackageBillingPeriod } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireAdminScope();
  if ("error" in auth) return auth.error;

  const requestedPeriod = new URL(request.url).searchParams.get("period");
  const period = requestedPeriod ?? (await getCurrentPackageBillingPeriod());
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    return NextResponse.json({ error: "账期参数无效" }, { status: 400 });
  }

  try {
    const response = await getBillingHealth(auth.scope, period);
    return NextResponse.json(response, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取账务健康快照失败" },
      { status: 500 },
    );
  }
}
