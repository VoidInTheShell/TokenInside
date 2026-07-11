import type { QuotaOperationState } from "./types";

const transitions: Record<QuotaOperationState, QuotaOperationState[]> = {
  planned: ["budget_reserved", "local_prepared", "retryable_failed", "manual_review"],
  budget_reserved: ["local_prepared", "retryable_failed", "compensating", "manual_review"],
  local_prepared: ["admission_closed", "retryable_failed", "compensating", "manual_review"],
  admission_closed: ["upstream_frozen", "draining", "snapshot_stable", "retryable_failed", "compensating", "manual_review"],
  upstream_frozen: ["draining", "snapshot_stable", "retryable_failed", "manual_review"],
  draining: ["snapshot_stable", "retryable_failed", "manual_review"],
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
  manual_review: ["compensating"],
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
