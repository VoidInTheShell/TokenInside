import assert from "node:assert/strict";
import test from "node:test";
import {
  assertQuotaOperationTransition,
  buildMonthlyOpenAccessReopenEvidence,
  canAutoResumeKeyRotationObservationFailure,
  canCompensateKeyRotationBeforeUpstream,
  canReopenFirstProvisionAfterAccessRevoke,
  canReopenMonthlyOpenAfterAccessRevoke,
  canTransitionQuotaOperation,
  quotaOperationRetryResumeState,
  reopenFirstProvisionAfterAccessRevoke,
  reopenMonthlyOpenAfterAccessRevoke,
} from "../lib/quota-saga-state.ts";
import type { QuotaOperation } from "../lib/types.ts";

test("quota saga accepts the normal path and rejects reopening completion", () => {
  const path = [
    "planned",
    "local_prepared",
    "admission_closed",
    "draining",
    "snapshot_stable",
    "upstream_applying",
    "upstream_applied",
    "local_finalized",
    "reconciling",
    "completed",
  ] as const;
  for (let index = 1; index < path.length; index += 1) {
    assert.equal(canTransitionQuotaOperation(path[index - 1], path[index]), true);
  }
  assert.throws(
    () => assertQuotaOperationTransition("completed", "planned"),
    /invalid quota operation transition/,
  );
});

test("quota saga resumes the exact durable phase after a retryable failure", () => {
  assert.equal(quotaOperationRetryResumeState("upstream_applying"), "upstream_applying");
  assert.equal(quotaOperationRetryResumeState("local_finalized"), "local_finalized");
  assert.equal(quotaOperationRetryResumeState("completed"), "local_prepared");
});

test("manual review can reopen only through an explicit recovery transition", () => {
  assert.equal(canTransitionQuotaOperation("manual_review", "planned"), true);
  assert.equal(canTransitionQuotaOperation("manual_review", "completed"), false);
});

test("pre-switch key rotation failures can compensate and legacy observation failures auto-resume", () => {
  assert.equal(canTransitionQuotaOperation("draining", "compensating"), true);
  assert.equal(
    canCompensateKeyRotationBeforeUpstream({
      operationType: "key_rotation",
      state: "draining",
    }),
    true,
  );
  assert.equal(
    canCompensateKeyRotationBeforeUpstream({
      operationType: "key_rotation",
      state: "upstream_applying",
    }),
    false,
  );
  assert.equal(
    canAutoResumeKeyRotationObservationFailure({
      operationType: "key_rotation",
      state: "manual_review",
      lastErrorMessage: "NewAPI token 余额观测不稳定",
      evidence: { retryFromState: "draining" },
    }),
    true,
  );
});

test("only access-revoked pre-upstream administrator first-provision can reopen", () => {
  const cancelled: QuotaOperation = {
    id: "qo-admin-first-cancelled",
    operationType: "first_provision",
    idempotencyKey: "admin-default-first-provision:user-admin:2099-01",
    feishuUserId: "user-admin",
    departmentId: "department-old",
    billingPeriod: "2099-01",
    requestedAssignedQuota: 10,
    assignedQuotaBefore: 0,
    targetRemainQuota: 10,
    reservedDepartmentQuota: 0,
    operationGeneration: 1,
    state: "cancelled",
    attemptCount: 1,
    nextRetryAt: "2099-01-01T00:01:00.000Z",
    workerLeaseId: "lease-old",
    workerLeaseExpiresAt: "2099-01-01T00:02:00.000Z",
    requestId: "request-admin",
    evidence: {
      cancelledFromState: "local_prepared",
      userAccessRevokedAt: "2099-01-01T00:00:00.000Z",
      consumptionBarrierStatus: "waiting",
      authorizationDelta: 10,
    },
    lastErrorCode: "user_access_revoked",
    lastErrorMessage: "disabled",
    createdAt: "2098-12-01T00:00:00.000Z",
    updatedAt: "2099-01-01T00:00:00.000Z",
    completedAt: "2099-01-01T00:00:00.000Z",
  };

  assert.equal(canReopenFirstProvisionAfterAccessRevoke(cancelled), true);
  assert.equal(
    canReopenFirstProvisionAfterAccessRevoke({
      ...cancelled,
      state: "manual_review",
    }),
    false,
  );
  assert.equal(
    canReopenFirstProvisionAfterAccessRevoke({
      ...cancelled,
      upstreamTokenIdAfter: "upstream-created",
    }),
    false,
  );
  assert.equal(
    canReopenFirstProvisionAfterAccessRevoke({
      ...cancelled,
      evidence: {
        ...cancelled.evidence,
        cancelledFromState: "upstream_applying",
      },
    }),
    false,
  );

  const reopenedAt = "2099-01-02T00:00:00.000Z";
  const reopened = reopenFirstProvisionAfterAccessRevoke(cancelled, {
    departmentId: "department-current",
    requestedAssignedQuota: 84,
    operationGeneration: 5,
    requestId: "request-admin",
    reopenedAt,
  });
  assert.equal(reopened.id, cancelled.id);
  assert.equal(reopened.idempotencyKey, cancelled.idempotencyKey);
  assert.equal(reopened.state, "planned");
  assert.equal(reopened.requestedAssignedQuota, 84);
  assert.equal(reopened.operationGeneration, 5);
  assert.equal(reopened.reservedDepartmentQuota, 0);
  assert.equal(reopened.completedAt, undefined);
  assert.equal(reopened.workerLeaseId, undefined);
  assert.equal(reopened.lastErrorCode, undefined);
  assert.equal(reopened.evidence?.accessRevokeReopenedAt, reopenedAt);
  assert.equal(reopened.evidence?.reopenedCancelledFromState, "local_prepared");
  assert.equal(reopened.evidence?.consumptionBarrierStatus, undefined);
  assert.equal(reopened.evidence?.authorizationDelta, undefined);
});

test("only pre-upstream access-revoked monthly-open cancellations can reopen", () => {
  const cancelled: QuotaOperation = {
    id: "qo-monthly-cancelled",
    operationType: "monthly_open",
    idempotencyKey: "monthly-open:2099-01:user-1",
    feishuUserId: "user-1",
    departmentId: "department-old",
    billingPeriod: "2099-01",
    requestedAssignedQuota: 10,
    assignedQuotaBefore: 8,
    observedRemainBefore: 7,
    targetRemainQuota: 9,
    reservedDepartmentQuota: 0,
    operationGeneration: 1,
    state: "cancelled",
    attemptCount: 2,
    nextRetryAt: "2099-01-01T00:01:00.000Z",
    workerLeaseId: "lease-old",
    workerLeaseExpiresAt: "2099-01-01T00:02:00.000Z",
    upstreamTokenIdBefore: "upstream-old",
    tokenAccountIdBefore: "account-old",
    evidence: {
      cancelledFromState: "snapshot_stable",
      userAccessRevokedAt: "2099-01-01T00:00:00.000Z",
      consumptionBarrierStatus: "satisfied",
      consumptionBarrierCutoffAt: "2099-01-01T00:00:30.000Z",
      ledgerDelta: 10,
    },
    credentialCiphertext: "cipher-old",
    lastErrorCode: "user_access_revoked",
    lastErrorMessage: "disabled",
    createdAt: "2098-12-01T00:00:00.000Z",
    updatedAt: "2099-01-01T00:00:00.000Z",
    completedAt: "2099-01-01T00:00:00.000Z",
  };

  assert.equal(canReopenMonthlyOpenAfterAccessRevoke(cancelled), true);
  assert.equal(
    canReopenMonthlyOpenAfterAccessRevoke({
      ...cancelled,
      evidence: {
        ...cancelled.evidence,
        upstreamBalanceWriteAttemptedAt: "2099-01-01T00:00:00.000Z",
      },
    }),
    false,
  );
  assert.equal(
    canReopenMonthlyOpenAfterAccessRevoke({
      ...cancelled,
      upstreamTokenIdAfter: "upstream-new",
    }),
    false,
  );
  assert.equal(
    canReopenMonthlyOpenAfterAccessRevoke({
      ...cancelled,
      evidence: {
        ...cancelled.evidence,
        cancelledFromState: "upstream_applying",
      },
    }),
    false,
  );

  const reopenedAt = "2099-01-02T00:00:00.000Z";
  const reopened = reopenMonthlyOpenAfterAccessRevoke(cancelled, {
    departmentId: "department-current",
    assignedMonthlyQuota: 20,
    operationGeneration: 5,
    reopenedAt,
  });
  assert.equal(reopened.id, cancelled.id);
  assert.equal(reopened.idempotencyKey, cancelled.idempotencyKey);
  assert.equal(reopened.state, "budget_reserved");
  assert.equal(reopened.departmentId, "department-current");
  assert.equal(reopened.requestedAssignedQuota, 20);
  assert.equal(reopened.reservedDepartmentQuota, 20);
  assert.equal(reopened.operationGeneration, 5);
  assert.equal(reopened.attemptCount, 0);
  assert.equal(reopened.completedAt, undefined);
  assert.equal(reopened.workerLeaseId, undefined);
  assert.equal(reopened.lastErrorCode, undefined);
  assert.equal(reopened.upstreamTokenIdBefore, undefined);
  assert.equal(reopened.tokenAccountIdBefore, undefined);
  assert.equal(reopened.credentialCiphertext, undefined);
  assert.equal(reopened.evidence?.accessRevokeReopenedAt, reopenedAt);
  assert.equal(reopened.evidence?.accessRevokeReopenCount, 1);
  assert.equal(reopened.evidence?.reopenedCancelledFromState, "snapshot_stable");
  assert.equal(reopened.evidence?.consumptionBarrierStatus, undefined);
  assert.equal(reopened.evidence?.ledgerDelta, undefined);

  assert.equal(
    buildMonthlyOpenAccessReopenEvidence(
      { evidence: reopened.evidence },
      "2099-01-03T00:00:00.000Z",
    ).accessRevokeReopenCount,
    2,
  );
});
