import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { getScopedTokenRequest, updateTokenRequest } from "@/lib/store";
import { tokenRequestAllowsQuotaEdit } from "@/lib/token-request-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const quotaSchema = z.object({
  approvedMonthlyQuota: z.number().int().positive().max(1000000),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;

  const { id } = await params;
  const tokenRequest = await getScopedTokenRequest(auth.scope, id);
  if (!tokenRequest) {
    return NextResponse.json({ error: "申请单不存在或不在当前管理范围内" }, { status: 404 });
  }

  if (!tokenRequestAllowsQuotaEdit(tokenRequest)) {
    return NextResponse.json(
      { error: "当前记录不是可修改额度的审批申请" },
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
