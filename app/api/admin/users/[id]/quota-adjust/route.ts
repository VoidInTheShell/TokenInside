import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { nowIso } from "@/lib/crypto";
import { provisionTokenForRequest } from "@/lib/provisioning";
import {
  assignDepartmentUserQuota,
  createTokenRequest,
  getActiveTokenForUser,
  getScopedUser,
  updateTokenRequest,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const quotaAdjustSchema = z.object({
  approvedMonthlyQuota: z.number().int().positive().max(1000000),
  reason: z.string().min(4).max(500).optional(),
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
  if (targetUser.status && targetUser.status !== "active") {
    return NextResponse.json({ error: "目标用户当前不是启用状态" }, { status: 409 });
  }

  const parsed = quotaAdjustSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "调额额度或理由无效" }, { status: 400 });
  }

  const approvedMonthlyQuota = parsed.data.approvedMonthlyQuota;
  const activeToken = await getActiveTokenForUser(targetUser.id);
  if (!activeToken) {
    if (!targetUser.departmentId) {
      return NextResponse.json(
        { error: "无 active key 的用户必须先归属部门，才能预分配额度" },
        { status: 409 },
      );
    }
    try {
      const assignment = await assignDepartmentUserQuota({
        departmentId: targetUser.departmentId,
        departmentName: targetUser.departmentName,
        feishuUserId: targetUser.id,
        nextQuota: approvedMonthlyQuota,
        operatedByFeishuUserId: auth.user.id,
      });
      return NextResponse.json({ assignment, preallocated: true });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "预分配额度失败" },
        { status: 409 },
      );
    }
  }

  const operatedAt = nowIso();
  const quotaRequest = await createTokenRequest({
    feishuUserId: targetUser.id,
    requestType: "quota_adjust",
    status: "approved",
    reason: parsed.data.reason ?? `管理员调额为 ${approvedMonthlyQuota}`,
    requestedMonthlyQuota: approvedMonthlyQuota,
    approvedMonthlyQuota,
    approvalMode: "manual",
    approvalOperatorOpenId: auth.user.openId,
    approvalOperatedAt: operatedAt,
  });

  try {
    const account = await provisionTokenForRequest(quotaRequest);
    const updated = await updateTokenRequest(quotaRequest.id, {});
    return NextResponse.json({ request: updated, account });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "NewAPI quota adjust failed" },
      { status: 502 },
    );
  }
}
