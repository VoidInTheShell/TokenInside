import { NextResponse } from "next/server";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { createApprovalInstance } from "@/lib/feishu";
import { getCurrentUser } from "@/lib/session";
import {
  createTokenRequest,
  getActiveTokenForUser,
  updateTokenRequest,
} from "@/lib/store";

export const runtime = "nodejs";

const requestSchema = z.object({
  reason: z.string().min(4).max(500),
  requestedMonthlyQuota: z.number().positive().max(1000000),
  departmentId: z.string().optional(),
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
    const approvalCode = getConfig().feishu.approvalCodeTokenRequest;
    const tokenRequest = await createTokenRequest({
      feishuUserId: user.id,
      reason: input.reason,
      requestedMonthlyQuota: input.requestedMonthlyQuota,
      approvalCode,
      approvalDepartmentId: input.departmentId ?? user.departmentId,
      status: approvalCode ? "pending_feishu_approval" : "draft_pending_approval_config",
    });

    if (!approvalCode) {
      return NextResponse.json({
        request: tokenRequest,
        warning: "FEISHU_APPROVAL_CODE_TOKEN_REQUEST is not configured",
      });
    }

    const approval = await createApprovalInstance({
      approvalCode,
      openId: user.openId,
      departmentId: input.departmentId ?? user.departmentId,
      uuid: tokenRequest.approvalUuid,
      reason: input.reason,
      requestedMonthlyQuota: input.requestedMonthlyQuota,
    });
    const updated = await updateTokenRequest(tokenRequest.id, {
      approvalInstanceCode: approval.instance_code,
      status: "pending_feishu_approval",
    });

    return NextResponse.json({ request: updated });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Create token request failed" },
      { status: 400 },
    );
  }
}
