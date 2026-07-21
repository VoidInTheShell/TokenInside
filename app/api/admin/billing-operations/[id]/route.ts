import { NextResponse } from "next/server";
import { isRootAdminScope, requireAdminScope } from "@/lib/admin";
import { findBillingOperationById } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  if (!isRootAdminScope(auth.scope)) {
    return NextResponse.json(
      { error: "计费操作状态仅允许 root 查看" },
      { status: 403 },
    );
  }

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
