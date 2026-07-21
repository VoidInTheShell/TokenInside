import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import {
  isUserAccessControlError,
  suspendUserAccess,
} from "@/lib/user-access-control";

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
  const parsed = disableSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "禁用原因无效" }, { status: 400 });
  }

  let result;
  try {
    result = await suspendUserAccess({
      actorFeishuUserId: auth.user.id,
      feishuUserId: id,
      status: "disabled",
      reason: parsed.data.reason ?? `管理员 ${auth.user.openId} 禁用用户`,
      tokenStatus: "disabled",
      requireIssuedToken: true,
    });
  } catch (error) {
    if (isUserAccessControlError(error)) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    throw error;
  }

  return NextResponse.json({ user: result?.user, tokenAccount: result?.tokenAccount });
}
