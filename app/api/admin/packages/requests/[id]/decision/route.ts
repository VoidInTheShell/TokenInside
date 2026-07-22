import { NextResponse } from "next/server";
import { z } from "zod";
import { isSystemAdminScope, requireAdminScope } from "@/lib/admin";
import { isAdminUserActionAuthorizationError } from "@/lib/postgres-store";
import { decideDepartmentQuotaRequestAsActor } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const decisionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  approvedQuotaLimit: z.number().int().positive().max(1_000_000).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  if (!isSystemAdminScope(auth.scope)) {
    return NextResponse.json(
      { error: "只有 root 或系统管理员可以审批总额度上限提升申请" },
      { status: 403 },
    );
  }
  const parsed = decisionSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "审批动作或总额度上限无效" }, { status: 400 });
  }
  const { id } = await params;
  try {
    const result = await decideDepartmentQuotaRequestAsActor({
      requestId: id,
      action: parsed.data.action,
      approvedQuotaLimit: parsed.data.approvedQuotaLimit,
      actorFeishuUserId: auth.user.id,
    });
    if (!result) {
      return NextResponse.json({ error: "总额度上限提升申请不存在或已处理" }, { status: 409 });
    }
    return NextResponse.json({ request: result });
  } catch (error) {
    if (isAdminUserActionAuthorizationError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "处理总额度上限提升申请失败" },
      { status: 409 },
    );
  }
}
