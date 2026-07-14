import { NextResponse } from "next/server";
import { z } from "zod";
import { hydrateUserDepartment } from "@/lib/admin-sync";
import { randomId, sha256Hex } from "@/lib/crypto";
import { resolveApprovalTargetForUser, sendPackageApprovalCard } from "@/lib/feishu";
import {
  createPackageRequestReservation,
  listUserPackageRequests,
  updatePackageRequestDelivery,
} from "@/lib/package-repository";
import { packageRouteError } from "@/lib/package-route";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  packageVersionId: z.string().min(1).max(200),
  requestKind: z.enum(["first", "regrant"]),
  reason: z.string().trim().max(500).optional().default(""),
  clientRequestId: z.string().min(8).max(200),
});

function cycleLabel(type: "calendar_month" | "calendar_quarter" | "fixed_days", value: number) {
  if (type === "calendar_month") return `${value} 个自然月`;
  if (type === "calendar_quarter") return `${value} 个自然季度`;
  return `${value} 天`;
}

export async function GET() {
  const user = await hydrateUserDepartment(await getCurrentUser());
  if (!user) {
    return NextResponse.json(
      { error: { code: "feishu_session_required", message: "需要飞书 OAuth 会话", retryable: false } },
      { status: 401 },
    );
  }
  try {
    return NextResponse.json({ items: await listUserPackageRequests(user.id) });
  } catch (error) {
    return packageRouteError(error);
  }
}

export async function POST(request: Request) {
  const user = await hydrateUserDepartment(await getCurrentUser());
  if (!user) {
    return NextResponse.json(
      { error: { code: "feishu_session_required", message: "需要飞书 OAuth 会话", retryable: false } },
      { status: 401 },
    );
  }
  if (!user.departmentId) {
    return NextResponse.json(
      { error: { code: "user_department_required", message: "当前飞书用户没有可用部门", retryable: false } },
      { status: 409 },
    );
  }
  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "invalid_package_request", message: "套餐申请参数无效", retryable: false } },
      { status: 400 },
    );
  }
  const nonce = randomId("package-card");
  try {
    const reserved = await createPackageRequestReservation({
      userId: user.id,
      departmentId: user.departmentId,
      approvalActionNonceHash: sha256Hex(nonce),
      ...parsed.data,
    });
    if (reserved.reused) {
      return NextResponse.json({ request: reserved.request, reused: true });
    }
    const target = await resolveApprovalTargetForUser(
      user.openId,
      user.departmentId,
      parsed.data.requestKind,
    );
    try {
      const message = await sendPackageApprovalCard({
        receiveOpenId: target.leaderOpenId,
        requestId: reserved.request.id,
        nonce,
        applicantName: user.name,
        applicantOpenId: user.openId,
        requestKind: parsed.data.requestKind,
        packageName: reserved.definition.name,
        packageVersion: reserved.version.version,
        quotaLabel: `${reserved.version.grantedQuota} 点额度`,
        cycleLabel: cycleLabel(reserved.version.cycleType, reserved.version.cycleValue),
        reason: parsed.data.reason,
      });
      const updated = await updatePackageRequestDelivery({
        requestId: reserved.request.id,
        approvalTargetOpenId: target.leaderOpenId,
        approvalTargetSource: target.source,
        approvalCardMessageId: message.message_id,
      });
      return NextResponse.json({ request: updated, notice: target.notice }, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "飞书套餐审批卡片发送失败";
      await updatePackageRequestDelivery({
        requestId: reserved.request.id,
        approvalTargetOpenId: target.leaderOpenId,
        approvalTargetSource: target.source,
        errorCode: "package_approval_card_send_failed",
        errorMessage: message,
      });
      throw error;
    }
  } catch (error) {
    return packageRouteError(error);
  }
}
