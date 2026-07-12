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
  return from === to || transitions[from].includes(to);
}

export function assertQuotaOperationTransition(
  from: QuotaOperationState,
  to: QuotaOperationState,
) {
  if (!canTransitionQuotaOperation(from, to)) {
    throw new Error(`invalid quota operation transition: ${from} -> ${to}`);
  }
}
