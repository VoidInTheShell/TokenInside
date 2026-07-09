import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { disableNewApiToken } from "@/lib/newapi";
import { getActiveTokenForUser, getScopedUser, updateUserAccessStatus } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deleteSchema = z.object({
  reason: z.string().min(2).max(500).optional(),
});

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;

  const { id } = await params;
  const targetUser = await getScopedUser(auth.scope, id);
  if (!targetUser) {
    return NextResponse.json({ error: "用户不存在或不在当前管理范围内" }, { status: 404 });
  }

  const activeToken = await getActiveTokenForUser(targetUser.id);
  const parsed = deleteSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "删除原因无效" }, { status: 400 });
  }

  if (activeToken?.newapiTokenId) {
    await disableNewApiToken(activeToken.newapiTokenId);
  }
  const result = await updateUserAccessStatus({
    feishuUserId: targetUser.id,
    status: "deleted",
    reason: parsed.data.reason ?? `管理员 ${auth.user.openId} 删除用户，需重新申请`,
    tokenStatus: "revoked",
    adminRevokedByFeishuUserId: auth.user.id,
  });

  return NextResponse.json({
    user: result?.user,
    tokenAccount: result?.tokenAccount,
    reapplyRequired: true,
  });
}
