import {
  assertFirstProvisionDepartmentCapacity,
  findQuotaOperationByIdempotencyKey,
  getActiveTokenForUser,
  getUserById,
  invalidateOtherOpenFirstApplyRequests,
  updateTokenRequest,
} from "@/lib/store";
import type { TokenRequest } from "@/lib/types";
import {
  enqueueFirstProvision,
  enqueueQuotaAdjustment,
  runQuotaOperation,
} from "@/lib/quota-saga";

async function invalidateOtherFirstApplyRequestsAfterProvision(request: TokenRequest) {
  if (request.requestType !== "first_apply") return;
  await invalidateOtherOpenFirstApplyRequests({
    feishuUserId: request.feishuUserId,
    approvedRequestId: request.id,
    approvalOperatorOpenId: request.approvalOperatorOpenId,
    approvalOperatedAt: request.approvalOperatedAt,
  });
}

const reusableFirstApplyStatuses = new Set([
  "approved",
  "approved_provisioning",
  "approved_provision_failed",
]);

export async function findReusableFirstApplyRequest(
  requests: TokenRequest[],
  reason?: string,
) {
  const candidates = requests.filter(
    (request) =>
      request.requestType === "first_apply" &&
      reusableFirstApplyStatuses.has(request.status) &&
      (!reason || request.reason === reason),
  );
  for (const candidate of candidates) {
    const operation = await findQuotaOperationByIdempotencyKey(
      `quota-operation:${candidate.id}`,
    );
    if (operation) return candidate;
  }
  return candidates.at(-1) ?? null;
}

async function provisionFirstApply(request: TokenRequest) {
  const existing = await getActiveTokenForUser(request.feishuUserId);
  if (existing) {
    await updateTokenRequest(request.id, {
      status: "provisioned",
      tokenAccountId: existing.id,
      errorMessage: undefined,
    });
    await invalidateOtherFirstApplyRequestsAfterProvision(request);
    return existing;
  }

  try {
    const approvedMonthlyQuota =
      request.approvedMonthlyQuota ?? request.requestedMonthlyQuota;
    await assertFirstProvisionDepartmentCapacity({
      feishuUserId: request.feishuUserId,
      requestedMonthlyQuota: approvedMonthlyQuota,
      requestId: request.id,
    });
    const user = await getUserById(request.feishuUserId);
    const operation = await enqueueFirstProvision({
      feishuUserId: request.feishuUserId,
      departmentId: user?.departmentId,
      approvedMonthlyQuota,
      requestId: request.id,
      createdByOpenId: request.approvalOperatorOpenId,
    });
    await updateTokenRequest(request.id, {
      status: "approved_provisioning",
      errorMessage: undefined,
    });
    const completed = await runQuotaOperation(operation.id);
    if (completed.state !== "completed") {
      throw new Error(
        completed.lastErrorMessage ?? `首次发放尚未完成: ${completed.state}`,
      );
    }
    const account = await getActiveTokenForUser(request.feishuUserId);
    if (!account) throw new Error("首次发放完成后未找到 active Key");
    await invalidateOtherFirstApplyRequestsAfterProvision(request);
    return account;
  } catch (error) {
    const message = error instanceof Error ? error.message : "首次发放失败";
    await updateTokenRequest(request.id, {
      status: "approved_provision_failed",
      errorMessage: message,
    }).catch(() => undefined);
    throw error;
  }
}

export async function provisionTokenForRequest(request: TokenRequest) {
  if (request.requestType === "first_apply") {
    return provisionFirstApply(request);
  }

  if (request.requestType === "quota_adjust") {
    const user = await getUserById(request.feishuUserId);
    const operation = await enqueueQuotaAdjustment({
      feishuUserId: request.feishuUserId,
      departmentId: user?.departmentId,
      approvedMonthlyQuota:
        request.approvedMonthlyQuota ?? request.requestedMonthlyQuota,
      clientRequestId: request.id,
      requestId: request.id,
      createdByOpenId: request.approvalOperatorOpenId,
    });
    await runQuotaOperation(operation.id);
    return getActiveTokenForUser(request.feishuUserId);
  }

  throw new Error(`不支持的发放申请类型: ${request.requestType}`);
}
