import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import {
  isUserAccessControlError,
  suspendUserAccess,
} from "@/lib/user-access-control";

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
  const parsed = deleteSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "删除原因无效" }, { status: 400 });
  }

  let result;
  try {
    result = await suspendUserAccess({
      actorFeishuUserId: auth.user.id,
      feishuUserId: id,
      status: "deleted",
      reason: parsed.data.reason ?? `管理员 ${auth.user.openId} 删除用户，需重新申请`,
      tokenStatus: "revoked",
      adminRevokedByFeishuUserId: auth.user.id,
    });
  } catch (error) {
    if (isUserAccessControlError(error)) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    throw error;
  }

  return NextResponse.json({
    user: result?.user,
    tokenAccount: result?.tokenAccount,
    reapplyRequired: true,
  });
}
