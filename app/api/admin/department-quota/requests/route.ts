import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { randomId, sha256Hex } from "@/lib/crypto";
import {
  getPrimarySystemAdminOpenId,
  sendDepartmentQuotaApprovalCard,
} from "@/lib/feishu";
import {
  createDepartmentQuotaRequestAsActor,
  updateDepartmentQuotaRequest,
} from "@/lib/store";
import { isAdminUserActionAuthorizationError } from "@/lib/postgres-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("increase"),
    requestedQuotaLimit: z.number().int().min(0).max(1_000_000),
    reason: z.string().min(4).max(500),
  }),
  z.object({
    action: z.literal("reset"),
    reason: z.string().min(4).max(500),
  }),
]);

export async function POST(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  if (auth.scope.scopeType !== "department" || !auth.scope.departmentId) {
    return NextResponse.json(
      { error: "系统管理员可直接设置部门额度；只有部门管理员需要提交额度申请" },
      { status: 403 },
    );
  }
  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "部门额度申请参数无效" }, { status: 400 });
  }

  try {
    const approvalTargetOpenId = getPrimarySystemAdminOpenId();
    const nonce = randomId("department-quota-card");
    const quotaRequest = await createDepartmentQuotaRequestAsActor({
      actorFeishuUserId: auth.user.id,
      departmentId: auth.scope.departmentId,
      departmentName:
        auth.scope.departmentId === auth.user.departmentId
          ? auth.user.departmentName
          : undefined,
      action: parsed.data.action,
      reason: parsed.data.reason,
      requestedQuotaLimit:
        parsed.data.action === "increase"
          ? parsed.data.requestedQuotaLimit
          : undefined,
      approvalTargetOpenId,
      approvalActionNonceHash: sha256Hex(nonce),
    });
    try {
      const message = await sendDepartmentQuotaApprovalCard({
        receiveOpenId: approvalTargetOpenId,
        requestId: quotaRequest.id,
        nonce,
        applicantName: auth.user.name,
        applicantOpenId: auth.user.openId,
        departmentName: quotaRequest.departmentName,
        departmentId: quotaRequest.departmentId,
        action: quotaRequest.action,
        currentQuotaLimit: quotaRequest.currentQuotaLimit,
        requestedQuotaLimit: quotaRequest.requestedQuotaLimit,
        reason: quotaRequest.reason,
      });
      const updated = await updateDepartmentQuotaRequest(
        quotaRequest.id,
        {
          status: "pending_card_approval",
          approvalCardMessageId: message.message_id,
          errorMessage: undefined,
        },
        ["pending_card_send"],
      );
      return NextResponse.json({
        request: updated,
        notice: "您的部门额度申请将发送给系统管理员审批。",
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "发送部门额度审批卡片失败";
      const updated = await updateDepartmentQuotaRequest(
        quotaRequest.id,
        { status: "approval_card_send_failed", errorMessage },
        ["pending_card_send"],
      );
      return NextResponse.json({ request: updated, error: errorMessage }, { status: 502 });
    }
  } catch (err) {
    if (isAdminUserActionAuthorizationError(err)) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "创建部门额度申请失败" },
      { status: 409 },
    );
  }
}
