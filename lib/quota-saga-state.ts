import type { QuotaOperation, QuotaOperationState } from "./types";

const transitions: Record<QuotaOperationState, QuotaOperationState[]> = {
  planned: ["budget_reserved", "local_prepared", "retryable_failed", "manual_review"],
  budget_reserved: ["local_prepared", "retryable_failed", "compensating", "manual_review"],
  local_prepared: ["admission_closed", "retryable_failed", "compensating", "manual_review"],
  admission_closed: ["upstream_frozen", "draining", "snapshot_stable", "retryable_failed", "compensating", "manual_review"],
  upstream_frozen: ["draining", "snapshot_stable", "retryable_failed", "compensating", "manual_review"],
  draining: ["snapshot_stable", "retryable_failed", "compensating", "manual_review"],
  snapshot_stable: ["upstream_applying", "local_finalized", "compensating", "manual_review"],
  upstream_applying: ["upstream_applied", "retryable_failed", "compensating", "manual_review"],
  upstream_applied: ["upstream_activated", "local_finalized", "retryable_failed", "compensating", "manual_review"],
  upstream_activated: ["local_finalized", "retryable_failed", "compensating", "manual_review"],
  local_finalized: ["reconciling", "completed", "retryable_failed", "manual_review"],
  reconciling: ["completed", "retryable_failed", "manual_review"],
  retryable_failed: [
    "planned",
    "budget_reserved",
    "local_prepared",
    "admission_closed",
    "upstream_frozen",
    "draining",
    "snapshot_stable",
    "upstream_applying",
    "upstream_applied",
    "upstream_activated",
    "local_finalized",
    "reconciling",
    "manual_review",
  ],
  compensating: ["compensated", "manual_review"],
  compensated: [],
  cancelled: [],
  manual_review: ["planned", "compensating"],
  completed: [],
};

const retryResumeStates = new Set<QuotaOperationState>([
  "planned",
  "budget_reserved",
  "local_prepared",
  "admission_closed",
  "upstream_frozen",
  "draining",
  "snapshot_stable",
  "upstream_applying",
  "upstream_applied",
  "upstream_activated",
  "local_finalized",
  "reconciling",
]);

export function quotaOperationRetryResumeState(value: unknown): QuotaOperationState {
  return typeof value === "string" && retryResumeStates.has(value as QuotaOperationState)
    ? (value as QuotaOperationState)
    : "local_prepared";
}

const preSwitchKeyRotationStates = new Set<QuotaOperationState>([
  "local_prepared",
  "admission_closed",
  "upstream_frozen",
  "draining",
  "snapshot_stable",
]);

const accessRevokeCancellableStates = new Set<QuotaOperationState>([
  "planned",
  "budget_reserved",
  "local_prepared",
  "admission_closed",
  "upstream_frozen",
  "draining",
  "snapshot_stable",
]);

export function canCancelQuotaOperationForAccessRevoke(
  operation: Pick<
    QuotaOperation,
    "state" | "evidence" | "upstreamTokenIdAfter" | "tokenAccountIdAfter"
  >,
) {
  const effectiveState =
    operation.state === "retryable_failed" || operation.state === "manual_review"
      ? quotaOperationRetryResumeState(operation.evidence?.retryFromState)
      : operation.state;
  return (
    accessRevokeCancellableStates.has(effectiveState) &&
    !operation.evidence?.upstreamBalanceWriteAttemptedAt &&
    !operation.upstreamTokenIdAfter &&
    !operation.tokenAccountIdAfter
  );
}

export function canReopenMonthlyOpenAfterAccessRevoke(
  operation: Pick<
    QuotaOperation,
    | "operationType"
    | "state"
    | "lastErrorCode"
    | "evidence"
    | "upstreamTokenIdAfter"
    | "tokenAccountIdAfter"
  >,
) {
  const cancelledFromState = operation.evidence?.cancelledFromState;
  return (
    operation.operationType === "monthly_open" &&
    operation.state === "cancelled" &&
    operation.lastErrorCode === "user_access_revoked" &&
    typeof operation.evidence?.userAccessRevokedAt === "string" &&
    typeof cancelledFromState === "string" &&
    canCancelQuotaOperationForAccessRevoke({
      ...operation,
      state: cancelledFromState as QuotaOperationState,
    })
  );
}

export function canReopenFirstProvisionAfterAccessRevoke(
  operation: Pick<
    QuotaOperation,
    | "operationType"
    | "state"
    | "lastErrorCode"
    | "evidence"
    | "upstreamTokenIdAfter"
    | "tokenAccountIdAfter"
  >,
) {
  const cancelledFromState = operation.evidence?.cancelledFromState;
  return (
    operation.operationType === "first_provision" &&
    operation.state === "cancelled" &&
    operation.lastErrorCode === "user_access_revoked" &&
    typeof operation.evidence?.userAccessRevokedAt === "string" &&
    typeof cancelledFromState === "string" &&
    canCancelQuotaOperationForAccessRevoke({
      ...operation,
      state: cancelledFromState as QuotaOperationState,
    })
  );
}

const monthlyOpenReopenTransientEvidenceKeys = new Set([
  "retryFromState",
  "lastFailureAt",
  "authorizationDelta",
  "authorizedQuotaBefore",
  "ledgerDelta",
  "oldUpstreamDisabledAt",
  "accessRevokedUpstreamDisabledAt",
  "upstreamBalanceWriteAttemptedAt",
  "credentialDeliveryTokenHash",
]);

export function buildMonthlyOpenAccessReopenEvidence(
  operation: Pick<QuotaOperation, "evidence">,
  reopenedAt: string,
): NonNullable<QuotaOperation["evidence"]> {
  const previous = operation.evidence ?? {};
  const preserved = Object.fromEntries(
    Object.entries(previous).filter(
      ([key]) =>
        !key.startsWith("consumptionBarrier") &&
        !monthlyOpenReopenTransientEvidenceKeys.has(key),
    ),
  );
  const previousReopenCount = Number(previous.accessRevokeReopenCount ?? 0);
  return {
    ...preserved,
    accessRevokeReopenedAt: reopenedAt,
    accessRevokeReopenCount:
      (Number.isSafeInteger(previousReopenCount) && previousReopenCount >= 0
        ? previousReopenCount
        : 0) + 1,
    reopenedCancelledFromState:
      typeof previous.cancelledFromState === "string"
        ? previous.cancelledFromState
        : "unknown",
  } satisfies NonNullable<QuotaOperation["evidence"]>;
}

export function reopenMonthlyOpenAfterAccessRevoke(
  operation: QuotaOperation,
  input: {
    departmentId?: string;
    assignedMonthlyQuota: number;
    operationGeneration: number;
    createdByOpenId?: string;
    reopenedAt: string;
  },
) {
  if (!canReopenMonthlyOpenAfterAccessRevoke(operation)) {
    throw new Error("cancelled monthly-open operation is not safe to reopen");
  }
  return {
    ...operation,
    departmentId: input.departmentId,
    requestedAssignedQuota: input.assignedMonthlyQuota,
    assignedQuotaBefore: undefined,
    observedRemainBefore: undefined,
    targetRemainQuota: undefined,
    observedRemainAfter: undefined,
    reservedDepartmentQuota: input.departmentId ? input.assignedMonthlyQuota : 0,
    operationGeneration: input.operationGeneration,
    state: input.departmentId ? ("budget_reserved" as const) : ("planned" as const),
    attemptCount: 0,
    nextRetryAt: undefined,
    workerLeaseId: undefined,
    workerLeaseExpiresAt: undefined,
    upstreamTokenIdBefore: undefined,
    upstreamTokenIdAfter: undefined,
    tokenAccountIdBefore: undefined,
    tokenAccountIdAfter: undefined,
    credentialCiphertext: undefined,
    credentialDeliveredAt: undefined,
    lastErrorCode: undefined,
    lastErrorMessage: undefined,
    createdByOpenId: input.createdByOpenId ?? operation.createdByOpenId,
    evidence: buildMonthlyOpenAccessReopenEvidence(operation, input.reopenedAt),
    updatedAt: input.reopenedAt,
    completedAt: undefined,
  } satisfies QuotaOperation;
}

export function reopenFirstProvisionAfterAccessRevoke(
  operation: QuotaOperation,
  input: {
    departmentId?: string;
    requestedAssignedQuota: number;
    operationGeneration: number;
    requestId: string;
    reopenedAt: string;
  },
) {
  if (!canReopenFirstProvisionAfterAccessRevoke(operation)) {
    throw new Error("cancelled first-provision operation is not safe to reopen");
  }
  return {
    ...operation,
    departmentId: input.departmentId,
    requestedAssignedQuota: input.requestedAssignedQuota,
    assignedQuotaBefore: undefined,
    observedRemainBefore: undefined,
    targetRemainQuota: undefined,
    observedRemainAfter: undefined,
    reservedDepartmentQuota: 0,
    operationGeneration: input.operationGeneration,
    state: "planned" as const,
    attemptCount: 0,
    nextRetryAt: undefined,
    workerLeaseId: undefined,
    workerLeaseExpiresAt: undefined,
    upstreamTokenIdBefore: undefined,
    upstreamTokenIdAfter: undefined,
    tokenAccountIdBefore: undefined,
    tokenAccountIdAfter: undefined,
    credentialCiphertext: undefined,
    credentialDeliveredAt: undefined,
    lastErrorCode: undefined,
    lastErrorMessage: undefined,
    requestId: input.requestId,
    evidence: buildMonthlyOpenAccessReopenEvidence(operation, input.reopenedAt),
    updatedAt: input.reopenedAt,
    completedAt: undefined,
  } satisfies QuotaOperation;
}

export function canCompensateKeyRotationBeforeUpstream(
  operation: Pick<
    QuotaOperation,
    "operationType" | "state" | "upstreamTokenIdAfter" | "tokenAccountIdAfter"
  >,
) {
  return (
    operation.operationType === "key_rotation" &&
    preSwitchKeyRotationStates.has(operation.state) &&
    !operation.upstreamTokenIdAfter &&
    !operation.tokenAccountIdAfter
  );
}

export function canAutoResumeKeyRotationObservationFailure(
  operation: Pick<
    QuotaOperation,
    | "operationType"
    | "state"
    | "lastErrorMessage"
    | "upstreamTokenIdAfter"
    | "tokenAccountIdAfter"
    | "evidence"
  >,
) {
  return (
    operation.operationType === "key_rotation" &&
    operation.state === "manual_review" &&
    operation.lastErrorMessage === "NewAPI token 余额观测不稳定" &&
    !operation.upstreamTokenIdAfter &&
    !operation.tokenAccountIdAfter &&
    preSwitchKeyRotationStates.has(
      quotaOperationRetryResumeState(operation.evidence?.retryFromState),
    )
  );
}

export function canTransitionQuotaOperation(
  from: QuotaOperationState,
  to: QuotaOperationState,
) {
  return (
    from === to ||
    (to === "cancelled" && !["completed", "compensated", "cancelled"].includes(from)) ||
    transitions[from].includes(to)
  );
}

export function assertQuotaOperationTransition(
  from: QuotaOperationState,
  to: QuotaOperationState,
) {
  if (!canTransitionQuotaOperation(from, to)) {
    throw new Error(`invalid quota operation transition: ${from} -> ${to}`);
  }
}
