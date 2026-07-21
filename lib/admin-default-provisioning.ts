import { getConfig } from "@/lib/config";
import { nowIso } from "@/lib/crypto";
import { toNewApiQuota } from "@/lib/newapi";
import {
  adminDefaultProvisioningIdempotencyKey,
  QuotaSubmissionError,
  submitPostgresAdminDefaultProvisioning,
  type AdminDefaultProvisioningSubmission,
} from "@/lib/quota-operation-submit";
import { ensureQuotaOperationWorker } from "@/lib/quota-saga";
import {
  createQuotaOperation,
  createTokenRequest,
  findQuotaOperationByIdempotencyKey,
  getActiveTokenForUser,
  getAdminScopeForKnownUser,
  getCurrentPackageBillingPeriod,
  getStoreSnapshot,
  getUserById,
  listQuotaOperations,
  listUserTokenRequests,
  reopenJsonAdminDefaultProvisioningAfterAccessRevoke,
  updateTokenRequest,
} from "@/lib/store";
import type { AdminScope, QuotaOperation, TokenRequest } from "@/lib/types";

const adminDefaultApprovalOpenId = "system:admin-default";
const reusableFirstApplyStatuses = new Set([
  "pending_card_send",
  "pending_card_approval",
  "approval_card_send_failed",
  "approval_route_failed",
  "pending_feishu_approval",
  "approved",
  "approved_provisioning",
  "approved_provision_failed",
]);
const terminalOperationStates = new Set(["completed", "compensated", "cancelled", "manual_review"]);

export type AdminDefaultProvisioningResult =
  | {
      status: "active";
      tokenAccountId: string;
      deduplicated: true;
    }
  | {
      status: "provisioning";
      requestId?: string;
      operationId: string;
      operationState: string;
      deduplicated: boolean;
    }
  | {
      status: "deferred";
      requestId?: string;
      operationId?: string;
      operationState?: string;
      reason: "conflicting_operation" | "terminal_operation_without_active_key";
      deduplicated: true;
    }
  | {
      status: "skipped";
      reason: "inactive_user" | "admin_scope_missing";
      deduplicated: true;
    }
  | {
      status: "failed";
      code: string;
      error: string;
      retryAfterSeconds?: number;
      deduplicated: false;
    };

function visibleSubmission(
  submission: AdminDefaultProvisioningSubmission,
): AdminDefaultProvisioningResult {
  if (submission.status === "active") {
    return {
      status: "active",
      tokenAccountId: submission.tokenAccount.id,
      deduplicated: true,
    };
  }
  if (submission.status === "provisioning") {
    return {
      status: "provisioning",
      requestId: submission.request?.id ?? submission.operation.requestId,
      operationId: submission.operation.id,
      operationState: submission.operation.state,
      deduplicated: submission.deduplicated,
    };
  }
  if (submission.status === "deferred") {
    return {
      status: "deferred",
      requestId: submission.request?.id ?? submission.operation?.requestId,
      operationId: submission.operation?.id,
      operationState: submission.operation?.state,
      reason: submission.reason,
      deduplicated: true,
    };
  }
  return submission;
}

function visibleExistingOperation(
  operation: QuotaOperation,
  request: TokenRequest | null,
): AdminDefaultProvisioningResult {
  if (terminalOperationStates.has(operation.state)) {
    return {
      status: "deferred",
      requestId: request?.id ?? operation.requestId,
      operationId: operation.id,
      operationState: operation.state,
      reason: "terminal_operation_without_active_key",
      deduplicated: true,
    };
  }
  return {
    status: "provisioning",
    requestId: request?.id ?? operation.requestId,
    operationId: operation.id,
    operationState: operation.state,
    deduplicated: true,
  };
}

async function submitJsonAdminDefaultProvisioning(input: {
  feishuUserId: string;
  trustedScope: AdminScope;
}): Promise<AdminDefaultProvisioningResult> {
  const user = await getUserById(input.feishuUserId);
  if (!user || (user.status && user.status !== "active")) {
    return { status: "skipped", reason: "inactive_user", deduplicated: true };
  }
  const currentScope = await getAdminScopeForKnownUser(user);
  if (
    input.trustedScope.status !== "active" ||
    !currentScope ||
    currentScope.status !== "active"
  ) {
    return { status: "skipped", reason: "admin_scope_missing", deduplicated: true };
  }

  const activeToken = await getActiveTokenForUser(user.id);
  if (activeToken) {
    return { status: "active", tokenAccountId: activeToken.id, deduplicated: true };
  }

  const period = await getCurrentPackageBillingPeriod();
  const idempotencyKey = adminDefaultProvisioningIdempotencyKey(user.id, period);
  const idempotent = await findQuotaOperationByIdempotencyKey(idempotencyKey);
  if (idempotent) {
    if (idempotent.state === "cancelled") {
      const reopened = await reopenJsonAdminDefaultProvisioningAfterAccessRevoke({
        feishuUserId: user.id,
        billingPeriod: period,
        idempotencyKey,
      });
      if (reopened) {
        return {
          status: "provisioning",
          requestId: reopened.request.id,
          operationId: reopened.operation.id,
          operationState: reopened.operation.state,
          deduplicated: true,
        };
      }
    }
    const requests = await listUserTokenRequests(user.id);
    return visibleExistingOperation(
      idempotent,
      requests.find((request) => request.id === idempotent.requestId) ?? null,
    );
  }

  const operations = await listQuotaOperations({ feishuUserId: user.id, limit: 50 });
  const openOperation = operations.find(
    (operation) =>
      operation.state !== "completed" &&
      operation.state !== "compensated" &&
      operation.state !== "cancelled",
  );
  if (openOperation) {
    const requests = await listUserTokenRequests(user.id);
    const request = requests.find((item) => item.id === openOperation.requestId) ?? null;
    if (openOperation.operationType === "first_provision") {
      return visibleExistingOperation(openOperation, request);
    }
    return {
      status: "deferred",
      requestId: request?.id ?? openOperation.requestId,
      operationId: openOperation.id,
      operationState: openOperation.state,
      reason: "conflicting_operation",
      deduplicated: true,
    };
  }

  const snapshot = await getStoreSnapshot();
  const departmentPeriod = snapshot.departmentQuotaPeriods.find(
    (item) => item.departmentId === user.departmentId && item.period === period,
  );
  const monthlyQuota = Math.round(
    departmentPeriod?.defaultGrantQuota ?? snapshot.settings.defaultMonthlyQuota,
  );
  if (!Number.isFinite(monthlyQuota) || monthlyQuota <= 0) {
    throw new Error("管理员默认发放额度未配置为正整数");
  }

  const requests = await listUserTokenRequests(user.id);
  const reusable = requests.find(
    (request) =>
      request.requestType === "first_apply" && reusableFirstApplyStatuses.has(request.status),
  );
  const now = nowIso();
  const request = reusable
    ? await updateTokenRequest(reusable.id, {
        status: "approved_provisioning",
        requestedMonthlyQuota: monthlyQuota,
        approvedMonthlyQuota: monthlyQuota,
        approvalDepartmentId: user.departmentId,
        approvalMode: "manual",
        approvalOperatorOpenId: adminDefaultApprovalOpenId,
        approvalOperatedAt: now,
        errorMessage: undefined,
      })
    : await createTokenRequest({
        feishuUserId: user.id,
        requestType: "first_apply",
        status: "approved_provisioning",
        reason: "管理员默认 Key 自动发放",
        requestedMonthlyQuota: monthlyQuota,
        approvedMonthlyQuota: monthlyQuota,
        approvalDepartmentId: user.departmentId,
        approvalMode: "manual",
        approvalOperatorOpenId: adminDefaultApprovalOpenId,
        approvalOperatedAt: now,
      });
  if (!request) throw new Error("管理员默认发放申请未能持久化");

  let operation: QuotaOperation;
  try {
    operation = await createQuotaOperation({
      operationType: "first_provision",
      idempotencyKey,
      feishuUserId: user.id,
      departmentId: user.departmentId,
      billingPeriod: period,
      requestedAssignedQuota: toNewApiQuota(monthlyQuota),
      requestId: request.id,
      createdByOpenId: adminDefaultApprovalOpenId,
    });
  } catch (error) {
    const raced = await findQuotaOperationByIdempotencyKey(idempotencyKey);
    if (!raced) {
      await updateTokenRequest(request.id, {
        status: "approved_provision_failed",
        errorMessage: error instanceof Error ? error.message : "管理员默认发放任务受理失败",
      }).catch(() => undefined);
      throw error;
    }
    operation = raced;
  }
  if (operation.requestId !== request.id) {
    await updateTokenRequest(request.id, {
      status: "invalidated",
      errorMessage: undefined,
    }).catch(() => undefined);
  }
  return {
    status: "provisioning",
    requestId: operation.requestId,
    operationId: operation.id,
    operationState: operation.state,
    deduplicated: operation.requestId !== request.id,
  };
}

export async function ensureAdminDefaultProvisioning(input: {
  feishuUserId: string;
  trustedScope: AdminScope;
}): Promise<AdminDefaultProvisioningResult> {
  try {
    const result =
      getConfig().storeBackend === "postgres"
        ? visibleSubmission(
            await submitPostgresAdminDefaultProvisioning({
              feishuUserId: input.feishuUserId,
            }),
          )
        : await submitJsonAdminDefaultProvisioning(input);
    if (result.status === "provisioning" || result.status === "deferred") {
      ensureQuotaOperationWorker();
    }
    return result;
  } catch (error) {
    const code =
      error instanceof QuotaSubmissionError
        ? error.code
        : "admin_default_provisioning_failed";
    const message = error instanceof Error ? error.message : "管理员默认发放任务受理失败";
    console.error(
      JSON.stringify({
        event: "tokeninside.admin.default_provisioning_submission_failed",
        feishuUserId: input.feishuUserId,
        code,
        errorMessage: message,
      }),
    );
    return {
      status: "failed",
      code,
      error: message,
      retryAfterSeconds:
        error instanceof QuotaSubmissionError ? error.retryAfterSeconds : undefined,
      deduplicated: false,
    };
  }
}
