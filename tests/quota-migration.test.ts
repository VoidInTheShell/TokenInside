import assert from "node:assert/strict";
import test from "node:test";
import { buildQuotaMigrationPlan } from "../lib/quota-migration.ts";
import type { StoreShape } from "../lib/types.ts";

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

test("migration uses explicit grants and excludes key and quota reset baselines", () => {
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

test("migration preserves the settled billing policy after a legacy quota reset", () => {
  const store = {
    version: 1,
    settings: { defaultMonthlyQuota: 200 },
    ...emptyArrays,
    users: [
      {
        id: "u",
        tenantKey: "t",
        openId: "o",
        departmentId: "d",
        status: "active",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z",
      },
    ],
    tokenRequests: [
      {
        id: "apply",
        feishuUserId: "u",
        requestType: "first_apply",
        status: "provisioned",
        reason: "apply",
        requestedMonthlyQuota: 200,
        approvedMonthlyQuota: 200,
        approvalUuid: "a",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
      {
        id: "quota-reset",
        feishuUserId: "u",
        requestType: "quota_reset",
        status: "provisioned",
        reason: "legacy reset",
        requestedMonthlyQuota: 400,
        approvedMonthlyQuota: 400,
        approvalUuid: "b",
        tokenAccountId: "active-account",
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z",
      },
    ],
    tokenAccounts: [
      {
        id: "active-account",
        feishuUserId: "u",
        tokenRequestId: "quota-reset",
        newapiTokenId: "57",
        keyHash: "hash",
        status: "active",
        billingPeriod: "2026-07",
        createdAt: "2026-07-10T00:00:00.000Z",
      },
    ],
    userBillingPeriods: [
      {
        id: "billing",
        feishuUserId: "u",
        period: "2026-07",
        monthlyQuota: 400,
        quotaConsumed: 4.294458,
        cost: 4.294458,
        remainingQuota: 395.705542,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        proxyLogCount: 0,
        usageRecordCount: 1,
        activeTokenAccountId: "active-account",
        tokenAccountIds: ["active-account"],
        updatedAt: "2026-07-11T00:00:00.000Z",
      },
    ],
    newapiUsageRecords: [
      {
        id: "usage",
        newapiTokenId: "54",
        tokenAccountId: "active-account",
        feishuUserId: "u",
        matchStatus: "no_proxy_match",
        quota: 2_147_229,
        newapiCreatedAt: "2026-07-10T12:00:00.000Z",
        firstSeenAt: "2026-07-10T12:00:00.000Z",
        lastSyncedAt: "2026-07-10T12:00:00.000Z",
      },
    ],
  } satisfies StoreShape;

  const plan = buildQuotaMigrationPlan(store, {
    period: "2026-07",
    quotaPerUnit: 500_000,
    now: "2026-07-11T00:00:00.000Z",
  });

  assert.equal(plan.policies[0]?.assignedMonthlyQuota, 200_000_000);
  assert.equal(plan.policies[0]?.sourceId, "billing");
  assert.equal(plan.ledgerEntries[0]?.signedQuota, 200_000_000);
  assert.equal(plan.operations[0]?.evidence?.authoritativeConsumedQuota, 2_147_229);
  assert.equal(plan.operations[0]?.evidence?.observedRemainEstimate, 197_852_771);
  assert.equal(plan.warnings.some((item) => item.sourceId === "quota-reset"), true);
});
