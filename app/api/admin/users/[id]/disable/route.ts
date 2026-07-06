import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { disableNewApiToken } from "@/lib/newapi";
import { getActiveTokenForUser, getScopedUser, updateUserAccessStatus } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const disableSchema = z.object({
  reason: z.string().min(2).max(500).optional(),
});

export async function POST(
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
  if (!activeToken) {
    return NextResponse.json({ error: "目标用户没有 active NewAPI key" }, { status: 409 });
  }

  const parsed = disableSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "禁用原因无效" }, { status: 400 });
  }

  if (activeToken.newapiTokenId) {
    await disableNewApiToken(activeToken.newapiTokenId);
  }
  const result = await updateUserAccessStatus({
    feishuUserId: targetUser.id,
    status: "disabled",
    reason: parsed.data.reason ?? `管理员 ${auth.user.openId} 禁用用户`,
    tokenStatus: "disabled",
  });

  return NextResponse.json({ user: result?.user, tokenAccount: result?.tokenAccount });
}
