import assert from "node:assert/strict";
import test from "node:test";
import { buildLegacyQuotaRiskReport } from "../lib/quota-risk.ts";
import type { StoreShape } from "../lib/types.ts";

test("legacy risk scan reports key resets without treating first apply as risky", () => {
  const base = {
    version: 1,
    settings: { defaultMonthlyQuota: 200 },
    users: [
      {
        id: "u1",
        tenantKey: "t",
        openId: "o",
        departmentId: "d1",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ],
    tokenRequests: [
      {
        id: "first",
        feishuUserId: "u1",
        requestType: "first_apply",
        status: "provisioned",
        reason: "first",
        requestedMonthlyQuota: 100,
        approvalUuid: "a1",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
      {
        id: "reset",
        feishuUserId: "u1",
        requestType: "key_reset",
        status: "provisioned",
        reason: "reset",
        requestedMonthlyQuota: 42,
        approvedMonthlyQuota: 42,
        approvalUuid: "a2",
        tokenAccountId: "ta2",
        createdAt: "2026-07-02T00:00:00.000Z",
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
    ],
    tokenAccounts: [
      {
        id: "ta2",
        feishuUserId: "u1",
        tokenRequestId: "reset",
        keyHash: "hash",
        status: "active",
        billingPeriod: "2026-07",
        createdAt: "2026-07-02T00:00:00.000Z",
      },
    ],
    userBillingPeriods: [],
    departmentQuotaPeriods: [],
    departmentQuotaRequests: [],
    quotaChangeEvents: [],
    userQuotaPolicies: [],
    quotaOperations: [],
    quotaLedgerEntries: [],
    userQuotaStates: [],
    quotaReconciliationRecords: [],
    feishuEvents: [],
    proxyRequestLogs: [],
    newapiUsageRecords: [],
    usageSyncCheckpoints: [],
    usageSyncIssues: [],
    adminScopes: [],
  } satisfies StoreShape;
  const report = buildLegacyQuotaRiskReport(base);
  assert.equal(report.counts.riskyRequests, 1);
  assert.equal(report.riskyRequests[0]?.requestId, "reset");
  assert.equal(report.counts.departments, 1);
});
