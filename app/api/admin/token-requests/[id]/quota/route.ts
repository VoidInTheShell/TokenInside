import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import {
  getAdminScopeForUser,
  getScopedTokenRequest,
  updateTokenRequest,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const quotaSchema = z.object({
  approvedMonthlyQuota: z.number().int().positive().max(1000000),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "需要飞书 OAuth 会话" }, { status: 401 });
  }

  const scope = await getAdminScopeForUser(user.id);
  if (!scope) {
    return NextResponse.json(
      { error: "当前飞书用户没有启用的 TokenInside 管理范围" },
      { status: 403 },
    );
  }

  const { id } = await params;
  const tokenRequest = await getScopedTokenRequest(scope, id);
  if (!tokenRequest) {
    return NextResponse.json({ error: "申请单不存在或不在当前管理范围内" }, { status: 404 });
  }

  if (!["pending_card_send", "pending_card_approval", "approval_card_send_failed"].includes(tokenRequest.status)) {
    return NextResponse.json(
      { error: "只有待审批或发卡失败的申请可以修改最终额度" },
      { status: 409 },
    );
  }

  const parsed = quotaSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "最终额度必须是正整数" }, { status: 400 });
  }
  const updated = await updateTokenRequest(tokenRequest.id, {
    approvedMonthlyQuota: parsed.data.approvedMonthlyQuota,
  });
  return NextResponse.json({ request: updated });
}
