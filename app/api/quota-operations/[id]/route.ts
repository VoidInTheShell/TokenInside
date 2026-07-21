import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { findQuotaOperationById } from "@/lib/store";
import {
  acknowledgeQuotaOperationCredential,
  claimQuotaOperationCredential,
} from "@/lib/quota-saga";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const acknowledgementSchema = z.object({
  deliveryToken: z.string().min(20).max(500),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // A key rotation deliberately moves the old account out of `active` before
  // the replacement credential is ready. The authenticated owner must still
  // be able to poll that already-accepted operation and collect its one-time
  // credential; ownership below remains the authorization boundary.
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: "需要飞书 OAuth 会话", code: "feishu_oauth_session_required" },
      { status: 401 },
    );
  }
  if (user.status && user.status !== "active") {
    return NextResponse.json(
      { error: "当前用户已禁用或删除", code: "user_inactive" },
      { status: 403 },
    );
  }
  const { id } = await params;
  const operation = await findQuotaOperationById(id);
  if (!operation || operation.feishuUserId !== user.id) {
    return NextResponse.json({ error: "额度操作不存在" }, { status: 404 });
  }
  const credentialReady =
    operation.state === "completed" &&
    Boolean(operation.credentialCiphertext) &&
    !operation.credentialDeliveredAt;
  const credential = credentialReady
    ? await claimQuotaOperationCredential(operation.id, user.id)
    : null;
  const { credentialCiphertext: _credentialCiphertext, ...visibleOperation } = operation;
  return NextResponse.json({
    operation: visibleOperation,
    key: credential?.key ?? null,
    deliveryToken: credential?.deliveryToken ?? null,
    credentialAvailable: Boolean(credential),
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: "需要飞书 OAuth 会话", code: "feishu_oauth_session_required" },
      { status: 401 },
    );
  }
  if (user.status && user.status !== "active") {
    return NextResponse.json(
      { error: "当前用户已禁用或删除", code: "user_inactive" },
      { status: 403 },
    );
  }
  const parsed = acknowledgementSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "凭据交付确认无效" }, { status: 400 });
  }
  const { id } = await params;
  const acknowledged = await acknowledgeQuotaOperationCredential({
    operationId: id,
    feishuUserId: user.id,
    deliveryToken: parsed.data.deliveryToken,
  });
  if (!acknowledged) {
    return NextResponse.json(
      { error: "凭据交付确认已失效或不属于当前用户" },
      { status: 409 },
    );
  }
  return NextResponse.json({ acknowledged: true });
}
