import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { findQuotaOperationById } from "@/lib/store";
import { takeQuotaOperationCredential } from "@/lib/quota-saga";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Feishu OAuth session required" }, { status: 401 });
  }
  const { id } = await params;
  const operation = await findQuotaOperationById(id);
  if (!operation || operation.feishuUserId !== user.id) {
    return NextResponse.json({ error: "额度操作不存在" }, { status: 404 });
  }
  const key = await takeQuotaOperationCredential(operation.id, user.id);
  const refreshed = (await findQuotaOperationById(operation.id)) ?? operation;
  const { credentialCiphertext: _credentialCiphertext, ...visibleOperation } = refreshed;
  return NextResponse.json({
    operation: visibleOperation,
    key,
    credentialAvailable: Boolean(key),
  });
}
