import type {
  ApprovalRouteReason,
  DepartmentQuotaPeriod,
  QuotaChangeEvent,
} from "./types.ts";

export const MAX_QUOTA_AMOUNT = 1_000_000;
export const DEFAULT_DEPARTMENT_QUOTA_LIMIT = 1_000;

export function initialDepartmentQuotaLimit(allocatedQuota: number) {
  const normalizedAllocatedQuota = Number.isFinite(allocatedQuota)
    ? Math.max(Math.round(allocatedQuota), 0)
    : 0;
  return Math.max(DEFAULT_DEPARTMENT_QUOTA_LIMIT, normalizedAllocatedQuota);
}

export type DepartmentQuotaUsage = {
  quotaLimit: number;
  allocatedQuota: number;
  pendingReservedQuota: number;
  availableQuota: number;
};

export function currentQuotaPeriod(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

export function isPendingQuotaReservation(
  event: QuotaChangeEvent,
  now = new Date(),
) {
  return (
    event.status === "pending" &&
    event.delta > 0 &&
    (!event.expiresAt || event.expiresAt.localeCompare(now.toISOString()) > 0)
  );
}

export function summarizeDepartmentQuota(input: {
  policy: Pick<DepartmentQuotaPeriod, "quotaLimit">;
  allocatedQuota: number;
  events?: QuotaChangeEvent[];
  now?: Date;
}): DepartmentQuotaUsage {
  const pendingReservedQuota = (input.events ?? [])
    .filter((event) => isPendingQuotaReservation(event, input.now))
    .reduce((sum, event) => sum + event.delta, 0);
  const quotaLimit = Math.max(0, input.policy.quotaLimit);
  const allocatedQuota = Math.max(0, input.allocatedQuota);
  return {
    quotaLimit,
    allocatedQuota,
    pendingReservedQuota,
    availableQuota: Math.max(quotaLimit - allocatedQuota - pendingReservedQuota, 0),
  };
}

export function validateDepartmentQuotaLimit(quotaLimit: number, allocatedQuota: number) {
  if (!Number.isInteger(quotaLimit) || quotaLimit < 0 || quotaLimit > MAX_QUOTA_AMOUNT) {
    return "部门额度上限必须是 0 到 1000000 之间的整数";
  }
  if (quotaLimit < allocatedQuota) {
    return `部门额度上限不能低于当前已分配额度 ${allocatedQuota}`;
  }
  return null;
}

export function validateDepartmentAllocation(input: {
  nextQuota: number;
  previousQuota: number;
  availableQuota: number;
}) {
  if (
    !Number.isInteger(input.nextQuota) ||
    input.nextQuota < 0 ||
    input.nextQuota > MAX_QUOTA_AMOUNT
  ) {
    return "成员额度必须是 0 到 1000000 之间的整数";
  }
  const delta = input.nextQuota - input.previousQuota;
  if (delta > input.availableQuota) {
    return `部门可用额度不足：本次需要 ${delta}，当前可用 ${input.availableQuota}`;
  }
  return null;
}

const pendingRouteStatuses = new Set<string>([
  "pending_card_send",
  "pending_card_approval",
  "approval_card_send_failed",
  "approval_route_failed",
  "pending_feishu_approval",
]);

export function pendingApprovalRouteNotice(
  request:
    | {
        status: string;
        approvalTargetSource?: string;
        approvalRouteNotice?: string;
        approvalRouteReason?: ApprovalRouteReason;
      }
    | null
    | undefined,
  isDepartmentAdmin = false,
) {
  if (
    !request ||
    !pendingRouteStatuses.has(request.status) ||
    request.approvalTargetSource !== "system_admin_fallback"
  ) {
    return null;
  }
  if (request.approvalRouteNotice) return request.approvalRouteNotice;
  if (request.approvalRouteReason === "applicant_is_department_admin" || isDepartmentAdmin) {
    return "您的个人提额请求将发送给系统管理员审批。";
  }
  return "您的请求将发送给系统管理员审批。";
}
