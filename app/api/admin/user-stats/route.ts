import { NextResponse } from "next/server";
import { requireAdminScope } from "@/lib/admin";
import { listAdminUserStats } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;

  const stats = await listAdminUserStats(auth.scope);
  return NextResponse.json({
    scope: {
      type: auth.scope.scopeType,
      departmentId: auth.scope.departmentId,
      source: auth.scope.source,
    },
    stats,
  });
}
