import type { RequestStatus, TokenRequest } from "./types";

const humanApprovalRequestTypes = new Set<TokenRequest["requestType"]>([
  "first_apply",
  "quota_reset",
  "quota_restore",
]);

export const adminDecidableRequestStatuses = new Set<RequestStatus>([
  "pending_card_send",
  "pending_card_approval",
  "approval_card_send_failed",
  "approval_route_failed",
  "pending_feishu_approval",
  "approved_provision_failed",
]);

export function tokenRequestRequiresAdminDecision(
  request: Pick<TokenRequest, "requestType" | "status">,
) {
  return (
    humanApprovalRequestTypes.has(request.requestType) &&
    adminDecidableRequestStatuses.has(request.status)
  );
}
