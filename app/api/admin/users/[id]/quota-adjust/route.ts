import { after, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { getConfig } from "@/lib/config";
import { nowIso, randomId } from "@/lib/crypto";
import { submitAndScheduleDurableQuotaWork } from "@/lib/durable-quota-submission";
import { fromNewApiQuota, toNewApiQuota } from "@/lib/newapi";
import { getNewApiUserAuthoritativeQuotaSnapshot } from "@/lib/newapi-reporting";
import {
  QuotaSubmissionError,
  submitPostgresAdminFirstProvisionAllocation,
  submitPostgresAdminQuotaAdjustment,
} from "@/lib/quota-operation-submit";
import {
  createTokenRequest,
  findQuotaOperationByIdempotencyKey,
  getAdminScopeForKnownUser,
  getActiveTokenForUser,
  getScopedUser,
  JsonQuotaSubmissionError,
  listUserTokenRequests,
  submitJsonAdminQuotaAdjustment,
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
import {
  ensureQuotaOperationWorker,
} from "@/lib/quota-saga";
import {
  assertAdminUserActionTargetAllowed,
  isUserAccessControlError,
} from "@/lib/user-access-control";

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
  try {
    assertAdminUserActionTargetAllowed({
      actorFeishuUserId: auth.user.id,
      scope: auth.scope,
      targetUser,
    });
  } catch (error) {
    if (isUserAccessControlError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    throw error;
  }
  if (targetUser.status && targetUser.status !== "active") {
    return NextResponse.json({ error: "目标用户当前不是启用状态" }, { status: 409 });
  }

  const parsed = quotaAdjustSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "调额额度或理由无效" }, { status: 400 });
  }

  const approvedMonthlyQuota = parsed.data.approvedMonthlyQuota;
  const targetAdminScope = targetUser.departmentId
    ? null
    : await getAdminScopeForKnownUser(targetUser);
  if (!targetUser.departmentId && targetAdminScope?.scopeType !== "global") {
    return NextResponse.json(
      { error: "目标用户必须先归属部门，或拥有有效的全局管理员身份" },
      { status: 409 },
    );
  }

  try {
    const authoritative = await getNewApiUserAuthoritativeQuotaSnapshot(targetUser.id);
    if (authoritative.truncated) {
      return NextResponse.json(
        { error: "NewAPI 当前套餐周期日志达到查询上限，无法安全更改额度上限" },
        { status: 409 },
      );
    }
    if (toNewApiQuota(approvedMonthlyQuota) < authoritative.consumedQuota) {
      return NextResponse.json(
        {
          error: `额度上限不能低于当前周期已消费额度 ${fromNewApiQuota(authoritative.consumedQuota)}`,
          code: "quota_below_consumed",
          consumedQuota: fromNewApiQuota(authoritative.consumedQuota),
        },
        { status: 409 },
      );
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取 NewAPI 当前周期消费失败" },
      { status: 502 },
    );
  }

  const explicitClientRequestId =
    parsed.data.clientRequestId ?? request.headers.get("idempotency-key") ?? undefined;
  const activeToken = await getActiveTokenForUser(targetUser.id);
  const existingAdjustment =
    !activeToken && explicitClientRequestId
      ? await findQuotaOperationByIdempotencyKey(
          `quota-adjust:${explicitClientRequestId}`,
        )
      : null;
  if (!activeToken && !existingAdjustment) {
    if (getConfig().storeBackend === "postgres") {
      try {
        await assertQuotaWriteActionEnabled("first_provision");
        const clientRequestId =
          explicitClientRequestId ??
          `admin-first-provision:${targetUser.id}:${approvedMonthlyQuota}`;
        const submitted = await submitAndScheduleDurableQuotaWork({
          submit: () =>
            submitPostgresAdminFirstProvisionAllocation({
              actorUserId: auth.user.id,
              targetUserId: targetUser.id,
              approvedMonthlyQuota,
              reason:
                parsed.data.reason ?? `管理员设置额度上限为 ${approvedMonthlyQuota}`,
              clientRequestId,
            }),
          scheduleAfter: after,
          wakeWorker: ensureQuotaOperationWorker,
        });
        return NextResponse.json(
          { mode: "first_provision", ...submitted },
          { status: 202 },
        );
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
          reason: parsed.data.reason ?? `管理员设置额度上限为 ${approvedMonthlyQuota}`,
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
          reason: parsed.data.reason ?? `管理员设置额度上限为 ${approvedMonthlyQuota}`,
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

  const clientRequestId = explicitClientRequestId ?? randomId("adjust");
  try {
    const reason = parsed.data.reason ?? `管理员设置额度上限为 ${approvedMonthlyQuota}`;
    const submitted = await submitAndScheduleDurableQuotaWork({
      submit: () =>
        getConfig().storeBackend === "postgres"
          ? submitPostgresAdminQuotaAdjustment({
              actorUserId: auth.user.id,
              targetUserId: targetUser.id,
              approvedMonthlyQuota,
              reason,
              clientRequestId,
            })
          : submitJsonAdminQuotaAdjustment({
              actorUserId: auth.user.id,
              targetUserId: targetUser.id,
              approvedMonthlyQuota,
              reason,
              clientRequestId,
            }),
      scheduleAfter: after,
      wakeWorker: ensureQuotaOperationWorker,
    });
    return NextResponse.json(
      { mode: "quota_adjust", ...submitted },
      { status: 202 },
    );
  } catch (err) {
    if (err instanceof QuotaSubmissionError || err instanceof JsonQuotaSubmissionError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        {
          status: err.status,
          headers:
            err instanceof QuotaSubmissionError && err.retryAfterSeconds
              ? { "Retry-After": String(err.retryAfterSeconds) }
              : undefined,
        },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "额度调节操作受理失败" },
      { status: quotaFeatureErrorStatus(err) ?? 502 },
    );
  }
}
