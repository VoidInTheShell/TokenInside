import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { randomId, sha256Hex } from "@/lib/crypto";
import { sendPackageQuotaLimitApprovalCard } from "@/lib/feishu";
import { isAdminUserActionAuthorizationError } from "@/lib/postgres-store";
import {
  createDepartmentQuotaRequestAsActor,
  listAdminScopes,
  updateDepartmentQuotaRequest,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  requestedQuotaLimit: z.number().int().positive().max(1_000_000),
  reason: z.string().min(4).max(500),
});

export async function POST(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  if (auth.scope.scopeType !== "department" || !auth.scope.departmentId) {
    return NextResponse.json(
      { error: "系统管理员可直接设置总额度上限，只有部门管理员需要提交提升申请" },
      { status: 403 },
    );
  }
  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "总额度上限提升申请无效" }, { status: 400 });
  }

  try {
    const adminScopes = await listAdminScopes();
    const approvalTargetOpenIds = [
      ...new Set(
        adminScopes
          .filter(
            (scope) =>
              scope.status === "active" && scope.scopeType === "global",
          )
          .map(
            (scope) =>
              scope.user?.openId ??
              ("configuredOpenId" in scope ? scope.configuredOpenId : undefined),
          )
          .filter((openId): openId is string => Boolean(openId)),
      ),
    ];
    const approvalTargetOpenId = approvalTargetOpenIds[0];
    if (!approvalTargetOpenId) {
      return NextResponse.json(
        { error: "当前没有可接收申请的 root 或系统管理员" },
        { status: 409 },
      );
    }
    const nonce = randomId("package-limit-card");
    const quotaRequest = await createDepartmentQuotaRequestAsActor({
      actorFeishuUserId: auth.user.id,
      departmentId: auth.scope.departmentId,
      departmentName:
        auth.scope.departmentId === auth.user.departmentId
          ? auth.user.departmentName
          : undefined,
      action: "increase",
      reason: parsed.data.reason,
      requestedQuotaLimit: parsed.data.requestedQuotaLimit,
      approvalTargetOpenId,
      approvalActionNonceHash: sha256Hex(nonce),
    });
    await updateDepartmentQuotaRequest(
      quotaRequest.id,
      { approvalTargetOpenIds },
      ["pending_card_send"],
    );

    const deliveries = await Promise.allSettled(
      approvalTargetOpenIds.map(async (receiveOpenId) => ({
        receiveOpenId,
        message: await sendPackageQuotaLimitApprovalCard({
          receiveOpenId,
          requestId: quotaRequest.id,
          nonce,
          applicantName: auth.user.name,
          applicantOpenId: auth.user.openId,
          departmentName: quotaRequest.departmentName,
          departmentId: quotaRequest.departmentId,
          currentQuotaLimit: quotaRequest.currentQuotaLimit,
          requestedQuotaLimit: parsed.data.requestedQuotaLimit,
          reason: quotaRequest.reason,
        }),
      })),
    );
    const delivered = deliveries
      .filter(
        (result): result is PromiseFulfilledResult<{
          receiveOpenId: string;
          message: { message_id?: string };
        }> => result.status === "fulfilled",
      )
      .map((result) => result.value)
      .filter((result) => Boolean(result.message.message_id));
    if (!delivered.length) {
      const errorMessage = "向 root 和系统管理员发送总额度申请失败";
      const updated = await updateDepartmentQuotaRequest(
        quotaRequest.id,
        {
          status: "approval_card_send_failed",
          errorMessage,
          approvalTargetOpenIds,
        },
        ["pending_card_send"],
      );
      return NextResponse.json(
        { request: updated, error: errorMessage },
        { status: 502 },
      );
    }
    const messageIds = delivered
      .map((result) => result.message.message_id)
      .filter((messageId): messageId is string => Boolean(messageId));
    const updated = await updateDepartmentQuotaRequest(
      quotaRequest.id,
      {
        status: "pending_card_approval",
        approvalTargetOpenIds,
        approvalCardMessageId: messageIds[0],
        approvalCardMessageIds: messageIds,
        errorMessage:
          delivered.length < approvalTargetOpenIds.length
            ? `已送达 ${delivered.length}/${approvalTargetOpenIds.length} 位管理员`
            : undefined,
      },
      ["pending_card_send"],
    );
    return NextResponse.json({
      request: updated,
      notice: `申请已发送给 ${delivered.length} 位 root/系统管理员。`,
    });
  } catch (error) {
    if (isAdminUserActionAuthorizationError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "创建总额度上限提升申请失败" },
      { status: 409 },
    );
  }
}
