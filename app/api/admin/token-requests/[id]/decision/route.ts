import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { nowIso } from "@/lib/crypto";
import { provisionTokenForRequest } from "@/lib/provisioning";
import { getScopedTokenRequest, updateTokenRequest } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const decisionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  approvedMonthlyQuota: z.number().int().positive().max(1000000).optional(),
});

const decidableStatuses = new Set([
  "pending_card_send",
  "pending_card_approval",
  "approval_card_send_failed",
  "approval_route_failed",
  "pending_feishu_approval",
  "approved_provision_failed",
]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;

  const { id } = await params;
  const tokenRequest = await getScopedTokenRequest(auth.scope, id);
  if (!tokenRequest) {
    return NextResponse.json({ error: "申请单不存在或不在当前管理范围内" }, { status: 404 });
  }

  if (!decidableStatuses.has(tokenRequest.status)) {
    return NextResponse.json(
      { error: "当前申请状态不允许管理端审批处理" },
      { status: 409 },
    );
  }

  const parsed = decisionSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "审批动作或最终额度无效" }, { status: 400 });
  }

  const operatedAt = nowIso();
  if (parsed.data.action === "reject") {
    const updated = await updateTokenRequest(tokenRequest.id, {
      status: "rejected",
      approvalOperatorOpenId: auth.user.openId,
      approvalOperatedAt: operatedAt,
    });
    return NextResponse.json({ request: updated });
  }

  const approvedMonthlyQuota =
    parsed.data.approvedMonthlyQuota ??
    tokenRequest.approvedMonthlyQuota ??
    tokenRequest.requestedMonthlyQuota;
  const approved = await updateTokenRequest(tokenRequest.id, {
    status: "approved",
    approvedMonthlyQuota,
    approvalOperatorOpenId: auth.user.openId,
    approvalOperatedAt: operatedAt,
  });
  if (!approved) {
    return NextResponse.json({ error: "申请单不存在" }, { status: 404 });
  }

  try {
    const account = await provisionTokenForRequest(approved);
    return NextResponse.json({ request: await updateTokenRequest(tokenRequest.id, {}), account });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "NewAPI token provisioning failed" },
      { status: 502 },
    );
  }
}
