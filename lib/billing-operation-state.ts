import type { BillingOperationRecord, BillingOperationStatus } from "./types";

const terminalBillingOperationStatuses = new Set<BillingOperationStatus>([
  "continuation_pending",
  "dry_run",
  "applied",
  "partial_failed",
  "failed",
]);

export function isTerminalBillingOperationStatus(status: BillingOperationStatus) {
  return terminalBillingOperationStatuses.has(status);
}

export function canClaimBillingOperation(
  operation: Pick<BillingOperationRecord, "status" | "leaseExpiresAt">,
  now = new Date(),
) {
  if (operation.status === "pending") return true;
  if (operation.status !== "running" || !operation.leaseExpiresAt) return false;
  const leaseExpiresAt = new Date(operation.leaseExpiresAt).getTime();
  return !Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= now.getTime();
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJsonValue(item)]),
    );
  }
  return value;
}

export function sameBillingOperationInput(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
) {
  return JSON.stringify(canonicalJsonValue(left ?? {})) ===
    JSON.stringify(canonicalJsonValue(right ?? {}));
}

export function retainBillingOperationRecords(
  records: BillingOperationRecord[],
  maxHistory: number,
) {
  const active = records.filter(
    (operation) => !isTerminalBillingOperationStatus(operation.status),
  );
  const terminalBudget = Math.max(Math.trunc(maxHistory) - active.length, 0);
  const retainedTerminalIds = new Set(
    records
      .filter((operation) => isTerminalBillingOperationStatus(operation.status))
      .slice(0, terminalBudget)
      .map((operation) => operation.id),
  );
  return records.filter(
    (operation) =>
      !isTerminalBillingOperationStatus(operation.status) ||
      retainedTerminalIds.has(operation.id),
  );
}
