import { NextResponse } from "next/server";
import { randomId, sha256Hex } from "@/lib/crypto";
import {
  resolveApprovalTargetForUser,
  sendTokenApprovalCard,
} from "@/lib/feishu";
import { hydrateUserDepartment } from "@/lib/admin-sync";
import { getCurrentUser } from "@/lib/session";
import {
  createTokenRequest,
  getActiveTokenForUser,
  getEffectiveUserGrantQuota,
  updateTokenRequest,
} from "@/lib/store";
import { tokenRequestSchema } from "@/lib/token-request-input";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await hydrateUserDepartment(await getCurrentUser());
    if (!user) {
      return NextResponse.json({ error: "Feishu OAuth session required" }, { status: 401 });
    }
    if (user.status === "disabled") {
      return NextResponse.json(
        {
          error: "当前用户已被禁用，请等待管理员解禁",
          code: "workspace_user_disabled",
        },
        { status: 403 },
      );
    }

    const activeToken = await getActiveTokenForUser(user.id);
    if (activeToken) {
      return NextResponse.json(
        { error: "Current Feishu user already has an active NewAPI key" },
        { status: 409 },
      );
    }

    const input = tokenRequestSchema.parse(await request.json());
    const requestedMonthlyQuota = await getEffectiveUserGrantQuota(user.id);
    const nonce = randomId("card");
    const tokenRequest = await createTokenRequest({
      feishuUserId: user.id,
      reason: input.reason ?? "",
      requestedMonthlyQuota,
      approvalMode: "feishu_card",
      approvalActionNonceHash: sha256Hex(nonce),
      status: "pending_card_send",
    });

    let routeResolved = false;
    try {
      const target = await resolveApprovalTargetForUser(user.openId, user.departmentId);
      routeResolved = true;
      await updateTokenRequest(tokenRequest.id, {
        approvalDepartmentId: target.departmentId,
        approvalTargetOpenId: target.leaderOpenId,
        approvalTargetSource: target.source,
        approvalRouteReason: target.reason,
        approvalRouteNotice: target.notice,
      });

      const message = await sendTokenApprovalCard({
        receiveOpenId: target.leaderOpenId,
        requestId: tokenRequest.id,
        nonce,
        applicantName: user.name,
        applicantOpenId: user.openId,
        requestedMonthlyQuota,
        reason: input.reason || "未填写",
      });
      const updated = await updateTokenRequest(tokenRequest.id, {
        approvalCardMessageId: message.message_id,
        status: "pending_card_approval",
      });

      return NextResponse.json({ request: updated, notice: target.notice });
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Send Feishu approval card failed";
      const updated = await updateTokenRequest(tokenRequest.id, {
        status: routeResolved ? "approval_card_send_failed" : "approval_route_failed",
        errorMessage,
      });
      return NextResponse.json({ request: updated, error: errorMessage }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Create token request failed" },
      { status: 400 },
    );
  }
}
