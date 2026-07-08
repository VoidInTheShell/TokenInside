import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { enableNewApiToken } from "@/lib/newapi";
import { enableUserAccess, getDisabledTokenForUser, getScopedUser } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const enableSchema = z.object({
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
  if (targetUser.status !== "disabled") {
    return NextResponse.json({ error: "只有已禁用用户可以启用" }, { status: 409 });
  }

  const disabledToken = await getDisabledTokenForUser(targetUser.id);
  if (!disabledToken) {
    return NextResponse.json({ error: "目标用户没有可启用的 disabled NewAPI key" }, { status: 409 });
  }

  const parsed = enableSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "启用原因无效" }, { status: 400 });
  }

  if (disabledToken.newapiTokenId) {
    await enableNewApiToken(disabledToken.newapiTokenId);
  }
  const result = await enableUserAccess({
    feishuUserId: targetUser.id,
    reason: parsed.data.reason ?? `管理员 ${auth.user.openId} 启用用户`,
  });
  if (!result) {
    return NextResponse.json({ error: "目标用户状态已变化，无法启用" }, { status: 409 });
  }

  return NextResponse.json({ user: result.user, tokenAccount: result.tokenAccount });
}
