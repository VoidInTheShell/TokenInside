import { NextResponse } from "next/server";
import { requireAdminScope } from "@/lib/admin";
import { findBillingOperationById } from "@/lib/store";
import { ensureUsageSyncScheduler } from "@/lib/usage-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  if (auth.scope.scopeType !== "global") {
    return NextResponse.json(
      { error: "计费操作状态只能由全局管理员查看" },
      { status: 403 },
    );
  }

  void ensureUsageSyncScheduler().catch(() => undefined);
  const { id } = await params;
  const operation = await findBillingOperationById(id);
  if (!operation) {
    return NextResponse.json({ error: "计费操作不存在" }, { status: 404 });
  }
  const {
    leaseId: _leaseId,
    leaseExpiresAt: _leaseExpiresAt,
    ...visibleOperation
  } = operation;
  return NextResponse.json({ operation: visibleOperation });
}
