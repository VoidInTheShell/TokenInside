import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateKeyRotationTarget,
  calculateQuotaAdjustment,
  calculateFirstProvision,
  calculateQuotaRestore,
  classifyQuotaReconciliation,
  conservativeRemainQuotaObservation,
  fixedUsageSyncWindow,
  hongKongBillingPeriod,
  initialUnassignedMonthlyQuota,
  isSettlementWatermarkFresh,
  materializeDepartmentQuota,
  materializeUserQuota,
  resolveUsageBillingPeriod,
} from "../lib/quota-model.ts";

test("ledger-migrated users start unassigned instead of inheriting the global grant", () => {
  assert.equal(
    initialUnassignedMonthlyQuota({
      defaultMonthlyQuota: 200,
      quotaMigrationApplied: true,
    }),
    0,
  );
  assert.equal(
    initialUnassignedMonthlyQuota({
      defaultMonthlyQuota: 200,
      quotaMigrationApplied: false,
    }),
    200,
  );
});

test("key rotation inherits the conservative user-period remainder", () => {
  assert.deepEqual(
    calculateKeyRotationTarget({
      expectedAvailableQuota: 197_852_771,
      observedRemainQuota: 200_000_000,
    }),
    {
      targetRemainQuota: 197_852_771,
      expectedAvailableQuota: 197_852_771,
      observedRemainQuota: 200_000_000,
      upstreamDelta: 2_147_229,
      limitedBy: "ledger",
    },
  );
  assert.deepEqual(
    calculateKeyRotationTarget({
      expectedAvailableQuota: 200_000_000,
      observedRemainQuota: 197_852_771,
    }),
    {
      targetRemainQuota: 197_852_771,
      expectedAvailableQuota: 200_000_000,
      observedRemainQuota: 197_852_771,
      upstreamDelta: -2_147_229,
      limitedBy: "upstream",
    },
  );
});

test("key rotation accepts decreasing post-drain observations conservatively", () => {
  assert.deepEqual(conservativeRemainQuotaObservation([100, 98, 99]), {
    remainQuota: 98,
    observations: [100, 98, 99],
  });
  assert.throws(
    () => conservativeRemainQuotaObservation([100, undefined, 98]),
    /余额观测不可用/,
  );
});

test("quota adjustment applies the policy delta to the observed balance", () => {
  assert.deepEqual(
    calculateQuotaAdjustment({
      observedRemainBefore: 40,
      assignedQuotaBefore: 100,
      assignedQuotaAfter: 160,
    }),
    { targetRemainQuota: 100, deltaAuthorizedQuota: 60 },
  );
  assert.deepEqual(
    calculateQuotaAdjustment({
      observedRemainBefore: 30,
      assignedQuotaBefore: 100,
      assignedQuotaAfter: 20,
    }),
    { targetRemainQuota: 0, deltaAuthorizedQuota: -30 },
  );
});

test("first provision reuses a no-key ledger allocation instead of granting twice", () => {
  assert.deepEqual(
    calculateFirstProvision({
      assignedMonthlyQuota: 100,
      authorizedQuotaBefore: 100,
      authoritativeConsumedQuota: 0,
    }),
    { authorizationDelta: 0, targetRemainQuota: 100 },
  );
  assert.deepEqual(
    calculateFirstProvision({
      assignedMonthlyQuota: 100,
      authorizedQuotaBefore: 40,
      authoritativeConsumedQuota: 10,
    }),
    { authorizationDelta: 60, targetRemainQuota: 90 },
  );
});

test("settlement watermarks must be recent and cannot point into the future", () => {
  assert.equal(
    isSettlementWatermarkFresh({
      settledThrough: "2026-07-11T09:55:00.000Z",
      now: "2026-07-11T10:00:00.000Z",
      maxLagMinutes: 10,
    }),
    true,
  );
  assert.equal(
    isSettlementWatermarkFresh({
      settledThrough: "2026-07-11T09:00:00.000Z",
      now: "2026-07-11T10:00:00.000Z",
      maxLagMinutes: 10,
    }),
    false,
  );
  assert.equal(
    isSettlementWatermarkFresh({
      settledThrough: "2026-07-11T10:01:00.000Z",
      now: "2026-07-11T10:00:00.000Z",
      maxLagMinutes: 10,
    }),
    false,
  );
});

test("quota restore only grants the amount below the policy line", () => {
  assert.deepEqual(
    calculateQuotaRestore({ observedRemainBefore: 35, assignedMonthlyQuota: 100 }),
    { targetRemainQuota: 100, grantDelta: 65 },
  );
  assert.deepEqual(
    calculateQuotaRestore({ observedRemainBefore: 120, assignedMonthlyQuota: 100 }),
    { targetRemainQuota: 120, grantDelta: 0 },
  );
});

test("user and department materialization preserves F-stage invariants", () => {
  assert.deepEqual(
    materializeUserQuota({
      assignedMonthlyQuota: 100,
      authoritativeConsumedQuota: 115,
      ledgerEntries: [{ signedQuota: 100 }],
    }),
    {
      assignedMonthlyQuotaSnapshot: 100,
      authorizedQuota: 100,
      authoritativeConsumedQuota: 115,
      expectedAvailableQuota: 0,
      overageQuota: 15,
    },
  );
  assert.deepEqual(
    materializeDepartmentQuota({
      budgetQuota: 200,
      committedAuthorizedQuota: 170,
      pendingReservedQuota: 50,
    }),
    {
      budgetQuota: 200,
      committedAuthorizedQuota: 170,
      pendingReservedQuota: 50,
      availableQuota: 0,
      overcommittedQuota: 20,
    },
  );
});

test("reconciliation never treats unstable or unsettled reads as repairable", () => {
  const base = {
    expectedAvailableQuota: 80,
    settled: true,
    hasInflightRequests: false,
    hasNonTerminalOperation: false,
    observedStable: true,
  };
  assert.equal(classifyQuotaReconciliation({ ...base, observedRemainQuota: 80 }), "healthy");
  assert.equal(
    classifyQuotaReconciliation({ ...base, observedRemainQuota: 90 }),
    "excess_upstream",
  );
  assert.equal(
    classifyQuotaReconciliation({ ...base, observedRemainQuota: 70 }),
    "deficit_upstream",
  );
  assert.equal(
    classifyQuotaReconciliation({ ...base, observedRemainQuota: 70, settled: false }),
    "provisional",
  );
});

test("billing periods and sync windows use Hong Kong time and a frozen end", () => {
  assert.equal(hongKongBillingPeriod(new Date("2026-06-30T16:00:00.000Z")), "2026-07");
  assert.deepEqual(
    fixedUsageSyncWindow({
      runStartedAt: "2026-07-11T10:00:00.000Z",
      settledThrough: "2026-07-11T09:30:00.000Z",
      overlapMinutes: 10,
      settlementLagMinutes: 5,
    }),
    {
      scanStart: "2026-07-11T09:20:00.000Z",
      scanEnd: "2026-07-11T09:55:00.000Z",
    },
  );
});

test("matched usage keeps the proxy period while unmatched usage uses Hong Kong time", () => {
  const delayedLogTime = "2026-06-30T16:30:00.000Z";
  assert.equal(
    resolveUsageBillingPeriod({
      billingPeriod: "2026-06",
      occurredAt: delayedLogTime,
    }),
    "2026-06",
  );
  assert.equal(resolveUsageBillingPeriod({ occurredAt: delayedLogTime }), "2026-07");
});
