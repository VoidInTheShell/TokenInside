import { NextResponse } from "next/server";
import { z } from "zod";
import { randomId, sha256Hex } from "@/lib/crypto";
import {
  resolveApprovalTargetForUser,
  sendTokenApprovalCard,
} from "@/lib/feishu";
import { getCurrentUser } from "@/lib/session";
import {
  createTokenRequest,
  getActiveTokenForUser,
  getAppSettings,
  listUserTokenRequests,
  updateTokenRequest,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const quotaResetSchema = z.object({
  reason: z.string().min(4).max(500),
});

const pendingQuotaResetStatuses = new Set([
  "pending_card_send",
  "pending_card_approval",
  "approval_card_send_failed",
  "approval_route_failed",
  "pending_feishu_approval",
  "approved",
  "approved_provisioning",
  "approved_provision_failed",
]);

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Feishu OAuth session required" }, { status: 401 });
    }

    const activeToken = await getActiveTokenForUser(user.id);
    if (!activeToken) {
      return NextResponse.json(
        { error: "当前飞书用户没有可重置额度的 active NewAPI key" },
        { status: 409 },
      );
    }

    const existingRequests = await listUserTokenRequests(user.id);
    const pendingQuotaReset = existingRequests.find(
      (item) =>
        item.requestType === "quota_reset" && pendingQuotaResetStatuses.has(item.status),
    );
    if (pendingQuotaReset) {
      return NextResponse.json(
        { error: "已有额度重置申请正在处理，请等待审批完成" },
        { status: 409 },
      );
    }

    const input = quotaResetSchema.parse(await request.json());
    const settings = await getAppSettings();
    const requestedMonthlyQuota = settings.defaultMonthlyQuota;
    const nonce = randomId("card");
    const tokenRequest = await createTokenRequest({
      feishuUserId: user.id,
      requestType: "quota_reset",
      reason: input.reason,
      requestedMonthlyQuota,
      approvalMode: "feishu_card",
      approvalActionNonceHash: sha256Hex(nonce),
      status: "pending_card_send",
    });

    let routeResolved = false;
    try {
      const target = await resolveApprovalTargetForUser(user.openId);
      routeResolved = true;
      await updateTokenRequest(tokenRequest.id, {
        approvalDepartmentId: target.departmentId,
        approvalTargetOpenId: target.leaderOpenId,
        approvalTargetSource: target.source,
      });

      const message = await sendTokenApprovalCard({
        receiveOpenId: target.leaderOpenId,
        requestId: tokenRequest.id,
        nonce,
        applicantName: user.name,
        applicantOpenId: user.openId,
        requestedMonthlyQuota,
        reason: input.reason,
      });
      const updated = await updateTokenRequest(tokenRequest.id, {
        approvalCardMessageId: message.message_id,
        status: "pending_card_approval",
      });

      return NextResponse.json({ request: updated, notice: target.notice });
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Send Feishu quota reset approval card failed";
      const updated = await updateTokenRequest(tokenRequest.id, {
        status: routeResolved ? "approval_card_send_failed" : "approval_route_failed",
        errorMessage,
      });
      return NextResponse.json({ request: updated, error: errorMessage }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Create quota reset request failed" },
      { status: 400 },
    );
  }
}
