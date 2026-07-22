import { NextResponse } from "next/server";
import { z } from "zod";
import { hydrateUserDepartment } from "@/lib/admin-sync";
import { randomId, sha256Hex } from "@/lib/crypto";
import {
  resolveApprovalTargetForUser,
  sendTokenApprovalCard,
} from "@/lib/feishu";
import { getCurrentUser } from "@/lib/session";
import {
  createTokenRequest,
  getActiveTokenForUser,
  getEffectiveUserGrantQuota,
  listAdminScopes,
  updateTokenRequest,
} from "@/lib/store";
import { PendingQuotaAdjustmentRequestError } from "@/lib/token-request-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const quotaRequestSchema = z.object({
  requestedMonthlyQuota: z.number().int().positive().max(1_000_000),
  reason: z.string().max(500).optional().default(""),
});

function globalApprovalTargets(
  scopes: Awaited<ReturnType<typeof listAdminScopes>>,
) {
  return [
    ...new Set(
      scopes
        .filter((scope) => scope.status === "active" && scope.scopeType === "global")
        .map(
          (scope) =>
            scope.user?.openId ??
            ("configuredOpenId" in scope ? scope.configuredOpenId : undefined),
        )
        .filter((openId): openId is string => Boolean(openId)),
    ),
  ];
}

export async function POST(request: Request) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "需要飞书 OAuth 会话" }, { status: 401 });
  }
  const user = await hydrateUserDepartment(currentUser);
  if (user.status === "disabled") {
    return NextResponse.json(
      { error: "当前用户已被禁用，请等待管理员解禁", code: "workspace_user_disabled" },
      { status: 403 },
    );
  }
  if (user.status === "deleted") {
    return NextResponse.json(
      { error: "当前用户需要重新申请套餐后才能提升额度", code: "workspace_user_deleted" },
      { status: 403 },
    );
  }

  const parsed = quotaRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "目标套餐额度必须是 1 至 1000000 的整数，理由最多 500 字" },
      { status: 400 },
    );
  }

  const activeToken = await getActiveTokenForUser(user.id);
  if (!activeToken) {
    return NextResponse.json(
      { error: "当前用户还没有可调整额度的 active Key" },
      { status: 409 },
    );
  }
  const currentMonthlyQuota = await getEffectiveUserGrantQuota(user.id);
  if (parsed.data.requestedMonthlyQuota <= currentMonthlyQuota) {
    return NextResponse.json(
      {
        error: `目标套餐额度必须高于当前额度 ${currentMonthlyQuota}`,
        code: "quota_increase_required",
        currentMonthlyQuota,
      },
      { status: 409 },
    );
  }

  const nonce = randomId("quota-card");
  let tokenRequest;
  try {
    tokenRequest = await createTokenRequest({
      feishuUserId: user.id,
      requestType: "quota_adjust",
      reason: parsed.data.reason.trim(),
      requestedMonthlyQuota: parsed.data.requestedMonthlyQuota,
      approvalMode: "feishu_card",
      approvalActionNonceHash: sha256Hex(nonce),
      status: "pending_card_send",
    });
  } catch (error) {
    if (error instanceof PendingQuotaAdjustmentRequestError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 409 },
      );
    }
    throw error;
  }

  let routeResolved = false;
  try {
    const target = await resolveApprovalTargetForUser(user.openId, user.departmentId);
    routeResolved = true;
    const approvalTargetOpenIds =
      target.source === "system_admin_fallback"
        ? globalApprovalTargets(await listAdminScopes())
        : [target.leaderOpenId];
    if (!approvalTargetOpenIds.length) approvalTargetOpenIds.push(target.leaderOpenId);
    const uniqueTargets = [...new Set(approvalTargetOpenIds)];
    await updateTokenRequest(tokenRequest.id, {
      approvalDepartmentId: target.departmentId,
      approvalTargetOpenId: uniqueTargets[0],
      approvalTargetOpenIds: uniqueTargets,
      approvalTargetSource: target.source,
      approvalRouteReason: target.reason,
      approvalRouteNotice: target.notice,
    });

    const deliveries = await Promise.allSettled(
      uniqueTargets.map(async (receiveOpenId) => ({
        receiveOpenId,
        message: await sendTokenApprovalCard({
          receiveOpenId,
          requestId: tokenRequest.id,
          nonce,
          applicantName: user.name,
          applicantOpenId: user.openId,
          requestedMonthlyQuota: parsed.data.requestedMonthlyQuota,
          reason: parsed.data.reason.trim() || "未填写",
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
      const errorMessage = "套餐额度申请审批卡片发送失败";
      const updated = await updateTokenRequest(tokenRequest.id, {
        status: "approval_card_send_failed",
        errorMessage,
      });
      return NextResponse.json(
        { request: updated, error: errorMessage },
        { status: 502 },
      );
    }

    const messageIds = delivered
      .map((result) => result.message.message_id)
      .filter((messageId): messageId is string => Boolean(messageId));
    const updated = await updateTokenRequest(tokenRequest.id, {
      status: "pending_card_approval",
      approvalCardMessageId: messageIds[0],
      approvalCardMessageIds: messageIds,
      errorMessage:
        delivered.length < uniqueTargets.length
          ? `已送达 ${delivered.length}/${uniqueTargets.length} 位审批人`
          : undefined,
    });
    return NextResponse.json(
      {
        request: updated,
        notice:
          target.source === "system_admin_fallback"
            ? `申请已发送给 ${delivered.length} 位 root/系统管理员。`
            : "申请已发送给部门管理员。",
      },
      { status: 201 },
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "套餐额度申请审批路由失败";
    const updated = await updateTokenRequest(tokenRequest.id, {
      status: routeResolved ? "approval_card_send_failed" : "approval_route_failed",
      errorMessage,
    });
    return NextResponse.json(
      { request: updated, error: errorMessage },
      { status: routeResolved ? 502 : 409 },
    );
  }
}
