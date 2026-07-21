import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { listQuotaOperations } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Operation status is also the recovery surface while first provision or a
  // key rotation temporarily has no active TokenAccount. Keep it session +
  // owner scoped instead of applying the active-key workspace gate.
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
  const operations = (await listQuotaOperations({ feishuUserId: user.id, limit: 20 })).map(
    ({ credentialCiphertext: _credentialCiphertext, ...operation }) => ({
      ...operation,
      credentialPendingDelivery: Boolean(
        _credentialCiphertext && !operation.credentialDeliveredAt,
      ),
    }),
  );
  return NextResponse.json({ operations });
}
