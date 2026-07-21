import { after, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { getConfig } from "@/lib/config";
import { nowIso } from "@/lib/crypto";
import { provisionTokenForRequest } from "@/lib/provisioning";
import {
  QuotaSubmissionError,
  rejectPostgresTokenRequestAsActor,
  submitPostgresFirstProvisionDecision,
} from "@/lib/quota-operation-submit";
import { ensureQuotaOperationWorker } from "@/lib/quota-saga";
import { getCurrentSessionIdentity } from "@/lib/session";
import {
  getScopedTokenRequest,
  JsonQuotaSubmissionError,
  rejectJsonTokenRequestAsActor,
  updateTokenRequest,
} from "@/lib/store";
import {
  assertQuotaWriteActionEnabled,
  quotaFeatureErrorStatus,
} from "@/lib/quota-guard";
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
  const identity = await getCurrentSessionIdentity();
  if (!identity) {
    return NextResponse.json({ error: "需要飞书 OAuth 会话" }, { status: 401 });
  }
  const parsed = decisionSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "审批动作或最终额度无效" }, { status: 400 });
  }
  const { id } = await params;

  if (getConfig().storeBackend === "postgres" && parsed.data.action === "approve") {
    try {
      await assertQuotaWriteActionEnabled("first_provision");
      const submitted = await submitPostgresFirstProvisionDecision({
        actorUserId: identity.userId,
        requestId: id,
        approvedMonthlyQuota: parsed.data.approvedMonthlyQuota,
      });
      after(() => ensureQuotaOperationWorker());
      return NextResponse.json(submitted, { status: 202 });
    } catch (err) {
      if (err instanceof QuotaSubmissionError) {
        return NextResponse.json(
          { error: err.message, code: err.code },
          {
            status: err.status,
            headers: err.retryAfterSeconds
              ? { "Retry-After": String(err.retryAfterSeconds) }
              : undefined,
          },
        );
      }
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "首次发放操作受理失败" },
        { status: quotaFeatureErrorStatus(err) ?? 502 },
      );
    }
  }

  if (parsed.data.action === "reject") {
    try {
      const updated =
        getConfig().storeBackend === "postgres"
          ? await rejectPostgresTokenRequestAsActor({
              actorUserId: identity.userId,
              requestId: id,
            })
          : await rejectJsonTokenRequestAsActor({
              actorUserId: identity.userId,
              requestId: id,
            });
      return NextResponse.json({ request: updated });
    } catch (error) {
      if (
        error instanceof QuotaSubmissionError ||
        error instanceof JsonQuotaSubmissionError
      ) {
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: error.status },
        );
      }
      throw error;
    }
  }

  const auth = await requireAdminScope();
  if (auth.error) return auth.error;

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

  const operatedAt = nowIso();
  const approvedMonthlyQuota =
    parsed.data.approvedMonthlyQuota ??
    tokenRequest.approvedMonthlyQuota ??
    tokenRequest.requestedMonthlyQuota;

  try {
    await assertQuotaWriteActionEnabled("first_provision");
  } catch (err) {
    if (err instanceof QuotaSubmissionError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        {
          status: err.status,
          headers: err.retryAfterSeconds
            ? { "Retry-After": String(err.retryAfterSeconds) }
            : undefined,
        },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "首次发放操作受理失败" },
      { status: quotaFeatureErrorStatus(err) ?? 502 },
    );
  }

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
      { status: quotaFeatureErrorStatus(err) ?? 502 },
    );
  }
}
