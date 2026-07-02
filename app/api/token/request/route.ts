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
  updateTokenRequest,
} from "@/lib/store";

export const runtime = "nodejs";

const requestSchema = z.object({
  reason: z.string().min(4).max(500),
});

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Feishu OAuth session required" }, { status: 401 });
    }

    const activeToken = await getActiveTokenForUser(user.id);
    if (activeToken) {
      return NextResponse.json(
        { error: "Current Feishu user already has an active NewAPI key" },
        { status: 409 },
      );
    }

    const input = requestSchema.parse(await request.json());
    const settings = await getAppSettings();
    const requestedMonthlyQuota = settings.defaultMonthlyQuota;
    const nonce = randomId("card");
    const tokenRequest = await createTokenRequest({
      feishuUserId: user.id,
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

      return NextResponse.json({ request: updated });
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
