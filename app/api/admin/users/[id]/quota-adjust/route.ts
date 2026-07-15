import { after, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { nowIso, randomId } from "@/lib/crypto";
import {
  createTokenRequest,
  findQuotaOperationByIdempotencyKey,
  getActiveTokenForUser,
  getScopedUser,
  listUserTokenRequests,
  updateTokenRequest,
} from "@/lib/store";
import {
  findReusableFirstApplyRequest,
  provisionTokenForRequest,
} from "@/lib/provisioning";
import {
  assertQuotaWriteActionEnabled,
  quotaFeatureErrorStatus,
} from "@/lib/quota-guard";
import { enqueueQuotaAdjustment, runQuotaOperation } from "@/lib/quota-saga";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const quotaAdjustSchema = z.object({
  approvedMonthlyQuota: z.number().int().positive().max(1000000),
  reason: z.string().min(4).max(500).optional(),
  clientRequestId: z.string().min(8).max(120).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;

  const { id } = await params;
  const targetUser = await getScopedUser(auth.scope, id);
  if (!targetUser) {
    return NextResponse.json({ error: "用户不存在或不在当前管理范围内" }, { status: 404 });
  }
  if (targetUser.status && targetUser.status !== "active") {
    return NextResponse.json({ error: "目标用户当前不是启用状态" }, { status: 409 });
  }

  const parsed = quotaAdjustSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "调额额度或理由无效" }, { status: 400 });
  }

  const approvedMonthlyQuota = parsed.data.approvedMonthlyQuota;
  if (!targetUser.departmentId) {
    return NextResponse.json(
      { error: "目标用户必须先归属部门，才能执行账本化调额" },
      { status: 409 },
    );
  }

  const activeToken = await getActiveTokenForUser(targetUser.id);
  if (!activeToken) {
    const requests = await listUserTokenRequests(targetUser.id);
    const reusableRequest = await findReusableFirstApplyRequest(requests);
    const existingFirstProvisionOperation = reusableRequest
      ? await findQuotaOperationByIdempotencyKey(
          `quota-operation:${reusableRequest.id}`,
        )
      : null;
    const reusableQuota = reusableRequest
      ? reusableRequest.approvedMonthlyQuota ?? reusableRequest.requestedMonthlyQuota
      : undefined;
    if (existingFirstProvisionOperation && reusableQuota !== approvedMonthlyQuota) {
      return NextResponse.json(
        {
          error: `该用户已有 ${reusableQuota} 额度的首次发放操作，请先完成或处置该操作`,
        },
        { status: 409 },
      );
    }
    const operatedAt = nowIso();
    const firstApplyRequest = reusableRequest
      ? await updateTokenRequest(reusableRequest.id, {
          status: "approved",
          reason: parsed.data.reason ?? `管理员首次分配额度为 ${approvedMonthlyQuota}`,
          requestedMonthlyQuota: approvedMonthlyQuota,
          approvedMonthlyQuota,
          approvalOperatorOpenId: auth.user.openId,
          approvalOperatedAt: operatedAt,
          errorMessage: undefined,
        })
      : await createTokenRequest({
          feishuUserId: targetUser.id,
          requestType: "first_apply",
          status: "approved",
          reason: parsed.data.reason ?? `管理员首次分配额度为 ${approvedMonthlyQuota}`,
          requestedMonthlyQuota: approvedMonthlyQuota,
          approvedMonthlyQuota,
          approvalMode: "manual",
          approvalOperatorOpenId: auth.user.openId,
          approvalOperatedAt: operatedAt,
        });
    if (!firstApplyRequest) {
      return NextResponse.json({ error: "首次发放申请不存在" }, { status: 404 });
    }
    try {
      const account = await provisionTokenForRequest(firstApplyRequest);
      if (!account || account.status !== "active") {
        throw new Error("首次分配未生成 active Key");
      }
      return NextResponse.json({
        mode: "first_provision",
        request: await updateTokenRequest(firstApplyRequest.id, {}),
        account,
      });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "首次 Key 与额度发放失败" },
        { status: quotaFeatureErrorStatus(err) ?? 502 },
      );
    }
  }

  try {
    await assertQuotaWriteActionEnabled("quota_adjust");
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "额度调节当前未启用" },
      { status: quotaFeatureErrorStatus(err) ?? 503 },
    );
  }

  const clientRequestId =
    parsed.data.clientRequestId ?? request.headers.get("idempotency-key") ?? randomId("adjust");
  const existingOperation = await findQuotaOperationByIdempotencyKey(
    `quota-adjust:${clientRequestId}`,
  );
  if (existingOperation) {
    if (
      existingOperation.feishuUserId !== targetUser.id ||
      existingOperation.operationType !== "quota_adjust"
    ) {
      return NextResponse.json({ error: "幂等键已被其他额度操作使用" }, { status: 409 });
    }
    return NextResponse.json({ operation: existingOperation }, { status: 202 });
  }

  const operatedAt = nowIso();
  const quotaRequest = await createTokenRequest({
    feishuUserId: targetUser.id,
    requestType: "quota_adjust",
    status: "approved_provisioning",
    reason: parsed.data.reason ?? `管理员调额为 ${approvedMonthlyQuota}`,
    requestedMonthlyQuota: approvedMonthlyQuota,
    approvedMonthlyQuota,
    approvalMode: "manual",
    approvalOperatorOpenId: auth.user.openId,
    approvalOperatedAt: operatedAt,
  });

  try {
    const operation = await enqueueQuotaAdjustment({
      feishuUserId: targetUser.id,
      departmentId: targetUser.departmentId,
      approvedMonthlyQuota,
      clientRequestId,
      requestId: quotaRequest.id,
      createdByOpenId: auth.user.openId,
    });
    after(() => runQuotaOperation(operation.id).catch(() => undefined));
    return NextResponse.json(
      { mode: "quota_adjust", request: quotaRequest, operation },
      { status: 202 },
    );
  } catch (err) {
    await updateTokenRequest(quotaRequest.id, {
      status: "approved_provision_failed",
      errorMessage: err instanceof Error ? err.message : "额度调节操作创建失败",
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "NewAPI quota adjust failed" },
      { status: quotaFeatureErrorStatus(err) ?? 502 },
    );
  }
}
