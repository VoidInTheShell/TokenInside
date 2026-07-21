import { NextResponse } from "next/server";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import {
  QuotaSubmissionError,
  submitPostgresKeyRotation,
} from "@/lib/quota-operation-submit";
import {
  assertQuotaWriteActionEnabled,
  quotaFeatureErrorStatus,
} from "@/lib/quota-guard";
import { nowIso, randomId } from "@/lib/crypto";
import {
  createTokenRequest,
  findQuotaOperationByIdempotencyKey,
  getEffectiveUserGrantQuota,
  updateTokenRequestForQuotaOperation,
} from "@/lib/store";
import { enqueueKeyRotation, ensureQuotaOperationWorker } from "@/lib/quota-saga";
import { requireActiveWorkspaceAccess } from "@/lib/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const resetSchema = z.object({
  reason: z.string().min(4).max(500).optional(),
  clientRequestId: z.string().min(8).max(120).optional(),
});

export async function POST(request: Request) {
  try {
    const access = await requireActiveWorkspaceAccess();
    if ("error" in access) return access.error;
    const { user, activeToken } = access;

    const body = await request.json().catch(() => ({}));
    const parsed = resetSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Key 更换理由无效" }, { status: 400 });
    }

    const clientRequestId =
      parsed.data.clientRequestId ?? request.headers.get("idempotency-key") ?? randomId("reset");
    await assertQuotaWriteActionEnabled("key_rotation");
    if (getConfig().storeBackend === "postgres") {
      const submitted = await submitPostgresKeyRotation({
        feishuUserId: user.id,
        reason: parsed.data.reason ?? "用户发起 Key 更换",
        clientRequestId,
      });
      ensureQuotaOperationWorker();
      return NextResponse.json(submitted, { status: 202 });
    }

    const idempotencyKey = `key-reset:${clientRequestId}`;
    const existing = await findQuotaOperationByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.feishuUserId !== user.id || existing.operationType !== "key_rotation") {
        return NextResponse.json({ error: "幂等键已被其他额度操作使用" }, { status: 409 });
      }
      return NextResponse.json({ operation: existing }, { status: 202 });
    }
    const monthlyQuota = await getEffectiveUserGrantQuota(user.id);
    const operatedAt = nowIso();
    const tokenRequest = await createTokenRequest({
      feishuUserId: user.id,
      requestType: "key_reset",
      status: "approved_provisioning",
      reason: parsed.data.reason ?? "用户发起 Key 更换",
      requestedMonthlyQuota: monthlyQuota,
      approvalMode: "manual",
      approvalOperatorOpenId: user.openId,
      approvalOperatedAt: operatedAt,
    });
    let operation;
    try {
      operation = await enqueueKeyRotation({
        feishuUserId: user.id,
        departmentId: user.departmentId,
        clientRequestId,
        requestId: tokenRequest.id,
        createdByOpenId: user.openId,
      });
    } catch (error) {
      await updateTokenRequestForQuotaOperation(tokenRequest.id, {
        status: "approved_provision_failed",
        errorMessage: error instanceof Error ? error.message : "Key 更换操作创建失败",
      });
      throw error;
    }
    // The committed quota_operations row is the durable queue. The process
    // worker started by instrumentation claims it independently, so the first
    // accepted request cannot launch a long Saga that delays later 202 ACKs.
    return NextResponse.json({ request: tokenRequest, operation }, { status: 202 });
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
      { error: err instanceof Error ? err.message : "Reset NewAPI key failed" },
      { status: quotaFeatureErrorStatus(err) ?? 400 },
    );
  }
}
