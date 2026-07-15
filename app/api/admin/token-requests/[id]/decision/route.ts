import { after, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { nowIso } from "@/lib/crypto";
import { provisionTokenForRequest } from "@/lib/provisioning";
import { getScopedTokenRequest, updateTokenRequest } from "@/lib/store";
import { enqueueQuotaRestoreForRequest, runQuotaOperation } from "@/lib/quota-saga";
import { quotaFeatureErrorStatus } from "@/lib/quota-guard";
import { tokenRequestRequiresAdminDecision } from "@/lib/token-request-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const decisionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  approvedMonthlyQuota: z.number().int().positive().max(1000000).optional(),
});

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

  if (!tokenRequestRequiresAdminDecision(tokenRequest)) {
    return NextResponse.json(
      { error: "当前记录不是可人工处理的审批申请" },
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

  if (approved.requestType === "quota_reset" || approved.requestType === "quota_restore") {
    try {
      const operation = await enqueueQuotaRestoreForRequest(approved);
      await updateTokenRequest(approved.id, { status: "approved_provisioning" });
      after(() => runQuotaOperation(operation.id).catch(() => undefined));
      return NextResponse.json({ request: approved, operation }, { status: 202 });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "额度恢复操作创建失败" },
        { status: quotaFeatureErrorStatus(err) ?? 502 },
      );
    }
  }

  try {
    const account = await provisionTokenForRequest(approved);
    return NextResponse.json({ request: await updateTokenRequest(tokenRequest.id, {}), account });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "NewAPI token provisioning failed" },
      { status: quotaFeatureErrorStatus(err) ?? 502 },
    );
  }
}
