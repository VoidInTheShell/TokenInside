import { NextResponse } from "next/server";
import { requireAdminScope } from "@/lib/admin";
import { listNewApiDepartmentStats } from "@/lib/newapi-reporting";
import { newApiReportingFailure } from "@/lib/newapi-reporting-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  if (auth.scope.scopeType !== "global") {
    return NextResponse.json({ error: "只有系统管理员可以查看部门统计" }, { status: 403 });
  }

  try {
    const result = await listNewApiDepartmentStats(auth.scope);
    return NextResponse.json(result ?? { source: "newapi", departments: [] });
  } catch (error) {
    return newApiReportingFailure(error, "NewAPI 部门统计读取失败");
  }
}
