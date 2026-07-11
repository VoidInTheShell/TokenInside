import { NextResponse } from "next/server";
import { z } from "zod";
import { isSystemAdminScope, requireAdminScope } from "@/lib/admin";
import { decideDepartmentQuotaRequest } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const decisionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  approvedQuotaLimit: z.number().int().min(0).max(1_000_000).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  if (!isSystemAdminScope(auth.scope)) {
    return NextResponse.json({ error: "只有系统管理员可以审批部门额度申请" }, { status: 403 });
  }
  const parsed = decisionSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "审批动作或部门额度无效" }, { status: 400 });
  }
  const { id } = await params;
  try {
    const result = await decideDepartmentQuotaRequest({
      requestId: id,
      action: parsed.data.action,
      approvedQuotaLimit: parsed.data.approvedQuotaLimit,
      operatedByFeishuUserId: auth.user.id,
      approvalOperatorOpenId: auth.user.openId,
    });
    if (!result) {
      return NextResponse.json({ error: "部门额度申请不存在或已处理" }, { status: 409 });
    }
    return NextResponse.json({ request: result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "处理部门额度审批失败" },
      { status: 409 },
    );
  }
}
