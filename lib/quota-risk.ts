import type { StoreShape } from "./types";

export function buildLegacyQuotaRiskReport(store: StoreShape) {
  const accountsById = new Map(store.tokenAccounts.map((item) => [item.id, item]));
  const usersById = new Map(store.users.map((item) => [item.id, item]));
  const riskyRequests = store.tokenRequests
    .filter((request) => {
      if (request.requestType === "key_reset") return true;
      return (
        request.status === "provisioned" &&
        (request.requestType === "quota_reset" ||
          request.requestType === "quota_adjust" ||
          request.requestType === "monthly_reset")
      );
    })
    .map((request) => {
      const account = request.tokenAccountId
        ? accountsById.get(request.tokenAccountId)
        : store.tokenAccounts.find((item) => item.tokenRequestId === request.id);
      const user = usersById.get(request.feishuUserId);
      return {
        requestId: request.id,
        requestType: request.requestType,
        status: request.status,
        feishuUserId: request.feishuUserId,
        departmentId: user?.departmentId,
        billingPeriod: account?.billingPeriod ?? request.updatedAt.slice(0, 7),
        tokenAccountId: account?.id,
        approvedMonthlyQuota:
          request.approvedMonthlyQuota ?? request.requestedMonthlyQuota,
        updatedAt: request.updatedAt,
      };
    })
    .sort((a, b) => a.requestId.localeCompare(b.requestId));
  return {
    generatedAt: new Date().toISOString(),
    counts: {
      riskyRequests: riskyRequests.length,
      users: new Set(riskyRequests.map((item) => item.feishuUserId)).size,
      departments: new Set(
        riskyRequests.map((item) => item.departmentId).filter(Boolean),
      ).size,
      billingPeriods: new Set(riskyRequests.map((item) => item.billingPeriod)).size,
    },
    riskyRequests,
  };
}
