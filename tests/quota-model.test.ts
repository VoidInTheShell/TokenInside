import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateKeyRotationTarget,
  calculateQuotaAdjustment,
  calculateFirstProvision,
  classifyQuotaReconciliation,
  conservativeRemainQuotaObservation,
  fixedUsageSyncWindow,
  shanghaiBillingPeriod,
  initialUnassignedMonthlyQuota,
  isSettlementWatermarkFresh,
  materializeDepartmentQuota,
  materializeUserQuota,
  resolveUsageBillingPeriod,
} from "../lib/quota-model.ts";

test("unassigned users always start at zero instead of inheriting the global grant", () => {
  assert.equal(
    initialUnassignedMonthlyQuota(),
    0,
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

test("quota adjustment derives ledger delta only from local authorization facts", () => {
  assert.deepEqual(
    calculateQuotaAdjustment({
      observedRemainBefore: 40,
      authorizedQuotaBefore: 100,
      authoritativeConsumedQuota: 60,
      assignedQuotaAfter: 160,
    }),
    {
      targetRemainQuota: 100,
      deltaAuthorizedQuota: 60,
      expectedAvailableQuota: 100,
      overageQuota: 0,
    },
  );
  assert.deepEqual(
    calculateQuotaAdjustment({
      observedRemainBefore: 30,
      authorizedQuotaBefore: 100,
      authoritativeConsumedQuota: 80,
      assignedQuotaAfter: 20,
    }),
    {
      targetRemainQuota: 0,
      deltaAuthorizedQuota: -80,
      expectedAvailableQuota: 0,
      overageQuota: 60,
    },
  );

  const localFacts = {
    authorizedQuotaBefore: 100,
    authoritativeConsumedQuota: 80,
    assignedQuotaAfter: 50,
  };
  const healthyProjection = calculateQuotaAdjustment({
    ...localFacts,
    observedRemainBefore: 20,
  });
  const deficitProjection = calculateQuotaAdjustment({
    ...localFacts,
    observedRemainBefore: 10,
  });
  assert.equal(healthyProjection.deltaAuthorizedQuota, -50);
  assert.equal(deficitProjection.deltaAuthorizedQuota, -50);
  assert.equal(healthyProjection.targetRemainQuota, 0);
  assert.equal(deficitProjection.targetRemainQuota, 0);

  assert.deepEqual(
    calculateQuotaAdjustment({
      authorizedQuotaBefore: 100,
      authoritativeConsumedQuota: 80,
      assignedQuotaAfter: 150,
      observedRemainBefore: 10,
    }),
    {
      targetRemainQuota: 60,
      deltaAuthorizedQuota: 50,
      expectedAvailableQuota: 70,
      overageQuota: 0,
    },
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
  assert.deepEqual(
    calculateFirstProvision({
      assignedMonthlyQuota: 50,
      authorizedQuotaBefore: 100,
      authoritativeConsumedQuota: 20,
    }),
    { authorizationDelta: -50, targetRemainQuota: 30 },
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

test("billing periods and sync windows use Shanghai time and a frozen end", () => {
  assert.equal(shanghaiBillingPeriod(new Date("2026-06-30T16:00:00.000Z")), "2026-07");
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

test("matched usage keeps the proxy period while unmatched usage uses Shanghai time", () => {
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
