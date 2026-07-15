const AUTO_REFRESH_REQUEST_STATUSES = new Set([
  "pending_card_send",
  "pending_card_approval",
  "pending_feishu_approval",
  "approved",
  "approved_provisioning",
]);

export const TOKEN_REQUEST_REFRESH_INTERVAL_MS = 3000;

export function tokenRequestsNeedAutoRefresh(requests: Array<{ status: string }>) {
  return requests.some((request) => AUTO_REFRESH_REQUEST_STATUSES.has(request.status));
}
