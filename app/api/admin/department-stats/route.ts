import { NextResponse } from "next/server";
import { requireAdminScope } from "@/lib/admin";
import { listDepartmentStats } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  if (auth.scope.scopeType !== "global") {
    return NextResponse.json({ error: "只有系统管理员可以查看部门统计" }, { status: 403 });
  }

  const departments = await listDepartmentStats(auth.scope);
  return NextResponse.json({ departments: departments ?? [] });
}
