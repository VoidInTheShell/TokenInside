import type { RequestStatus, TokenRequest } from "./types";

const humanApprovalRequestTypes = new Set<TokenRequest["requestType"]>([
  "first_apply",
  "quota_adjust",
]);

export const openQuotaAdjustmentRequestStatuses = new Set<RequestStatus>([
  "pending_card_send",
  "pending_card_approval",
  "approval_card_send_failed",
  "approval_route_failed",
  "pending_feishu_approval",
  "approved",
  "approved_provisioning",
  "approved_provision_failed",
  "draft_pending_approval_config",
]);

export class PendingQuotaAdjustmentRequestError extends Error {
  readonly code = "quota_adjust_request_pending";

  constructor() {
    super("已有套餐额度申请正在处理，请等待审批完成后再提交");
    this.name = "PendingQuotaAdjustmentRequestError";
  }
}

export const adminDecidableRequestStatuses = new Set<RequestStatus>([
  "pending_card_send",
  "pending_card_approval",
  "approval_card_send_failed",
  "approval_route_failed",
  "pending_feishu_approval",
  "approved_provision_failed",
]);

export function tokenRequestRequiresAdminDecision(
  request: { requestType: string; status: string },
) {
  return (
    humanApprovalRequestTypes.has(request.requestType as TokenRequest["requestType"]) &&
    adminDecidableRequestStatuses.has(request.status as RequestStatus)
  );
}

const quotaEditableRequestStatuses = new Set<RequestStatus>([
  "pending_card_send",
  "pending_card_approval",
  "approval_card_send_failed",
]);

export function tokenRequestAllowsQuotaEdit(request: {
  requestType: string;
  status: string;
}) {
  return (
    humanApprovalRequestTypes.has(request.requestType as TokenRequest["requestType"]) &&
    quotaEditableRequestStatuses.has(request.status as RequestStatus)
  );
}
