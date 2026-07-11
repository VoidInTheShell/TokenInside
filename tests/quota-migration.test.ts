import assert from "node:assert/strict";
import test from "node:test";
import { buildQuotaMigrationPlan } from "../lib/quota-migration.ts";
import type { StoreShape } from "../lib/types.ts";

test("migration uses explicit grants and excludes key and quota reset baselines", () => {
  const emptyArrays = {
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
  };
  const store = {
    version: 1,
    settings: { defaultMonthlyQuota: 200 },
    users: [
      {
        id: "u",
        tenantKey: "t",
        openId: "o",
        departmentId: "d",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ],
    tokenRequests: [
      {
        id: "apply",
        feishuUserId: "u",
        requestType: "first_apply",
        status: "provisioned",
        reason: "apply",
        requestedMonthlyQuota: 100,
        approvedMonthlyQuota: 100,
        approvalUuid: "a",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
      {
        id: "key-reset",
        feishuUserId: "u",
        requestType: "key_reset",
        status: "provisioned",
        reason: "reset",
        requestedMonthlyQuota: 12,
        approvedMonthlyQuota: 12,
        approvalUuid: "b",
        createdAt: "2026-07-02T00:00:00.000Z",
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
    ],
    tokenAccounts: [],
    userBillingPeriods: [],
    ...emptyArrays,
  } satisfies StoreShape;
  const first = buildQuotaMigrationPlan(store, {
    period: "2026-07",
    quotaPerUnit: 1000,
    now: "2026-07-11T00:00:00.000Z",
  });
  const second = buildQuotaMigrationPlan(store, {
    period: "2026-07",
    quotaPerUnit: 1000,
    now: "2026-07-11T00:00:00.000Z",
  });
  assert.equal(first.policies[0]?.assignedMonthlyQuota, 100_000);
  assert.equal(first.ledgerEntries[0]?.signedQuota, 100_000);
  assert.equal(first.warnings.some((item) => item.sourceId === "key-reset"), true);
  assert.equal(first.planHash, second.planHash);
});
