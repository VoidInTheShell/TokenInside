import type {
  QuotaLedgerEntry,
  QuotaOperationState,
  QuotaReconciliationStatus,
} from "./types";

export const QUOTA_TIME_ZONE = "Asia/Hong_Kong";

const terminalOperationStates = new Set<QuotaOperationState>([
  "completed",
  "compensated",
  "manual_review",
]);

export function isQuotaOperationTerminal(state: QuotaOperationState) {
  return terminalOperationStates.has(state);
}

export function normalizeQuota(value: number, field = "quota") {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

export function calculateQuotaAdjustment(input: {
  observedRemainBefore: number;
  assignedQuotaBefore: number;
  assignedQuotaAfter: number;
}) {
  const observedRemainBefore = normalizeQuota(
    input.observedRemainBefore,
    "observedRemainBefore",
  );
  const assignedQuotaBefore = normalizeQuota(input.assignedQuotaBefore, "assignedQuotaBefore");
  const assignedQuotaAfter = normalizeQuota(input.assignedQuotaAfter, "assignedQuotaAfter");
  const targetRemainQuota = Math.max(
    observedRemainBefore + assignedQuotaAfter - assignedQuotaBefore,
    0,
  );
  return {
    targetRemainQuota,
    deltaAuthorizedQuota: targetRemainQuota - observedRemainBefore,
  };
}

export function calculateQuotaRestore(input: {
  observedRemainBefore: number;
  assignedMonthlyQuota: number;
}) {
  const observedRemainBefore = normalizeQuota(
    input.observedRemainBefore,
    "observedRemainBefore",
  );
  const assignedMonthlyQuota = normalizeQuota(
    input.assignedMonthlyQuota,
    "assignedMonthlyQuota",
  );
  const targetRemainQuota = Math.max(observedRemainBefore, assignedMonthlyQuota);
  return {
    targetRemainQuota,
    grantDelta: targetRemainQuota - observedRemainBefore,
  };
}

export function calculateFirstProvision(input: {
  assignedMonthlyQuota: number;
  authorizedQuotaBefore: number;
  authoritativeConsumedQuota: number;
}) {
  const assignedMonthlyQuota = normalizeQuota(
    input.assignedMonthlyQuota,
    "assignedMonthlyQuota",
  );
  const authorizedQuotaBefore = normalizeQuota(
    input.authorizedQuotaBefore,
    "authorizedQuotaBefore",
  );
  const authoritativeConsumedQuota = normalizeQuota(
    input.authoritativeConsumedQuota,
    "authoritativeConsumedQuota",
  );
  const authorizationDelta = Math.max(
    assignedMonthlyQuota - authorizedQuotaBefore,
    0,
  );
  return {
    authorizationDelta,
    targetRemainQuota: Math.max(
      authorizedQuotaBefore + authorizationDelta - authoritativeConsumedQuota,
      0,
    ),
  };
}

export function materializeUserQuota(input: {
  assignedMonthlyQuota: number;
  authoritativeConsumedQuota: number;
  ledgerEntries: Pick<QuotaLedgerEntry, "signedQuota">[];
}) {
  const assignedMonthlyQuota = normalizeQuota(
    input.assignedMonthlyQuota,
    "assignedMonthlyQuota",
  );
  const authoritativeConsumedQuota = normalizeQuota(
    input.authoritativeConsumedQuota,
    "authoritativeConsumedQuota",
  );
  const authorizedQuota = input.ledgerEntries.reduce((sum, entry) => {
    if (!Number.isInteger(entry.signedQuota)) {
      throw new Error("ledger signedQuota must be an integer");
    }
    return sum + entry.signedQuota;
  }, 0);
  const safeAuthorizedQuota = Math.max(authorizedQuota, 0);
  return {
    assignedMonthlyQuotaSnapshot: assignedMonthlyQuota,
    authorizedQuota: safeAuthorizedQuota,
    authoritativeConsumedQuota,
    expectedAvailableQuota: Math.max(safeAuthorizedQuota - authoritativeConsumedQuota, 0),
    overageQuota: Math.max(authoritativeConsumedQuota - safeAuthorizedQuota, 0),
  };
}

export function calculateKeyRotationTarget(input: {
  expectedAvailableQuota: number;
  observedRemainQuota: number;
}) {
  const expectedAvailableQuota = normalizeQuota(
    input.expectedAvailableQuota,
    "expectedAvailableQuota",
  );
  const observedRemainQuota = normalizeQuota(
    input.observedRemainQuota,
    "observedRemainQuota",
  );
  const targetRemainQuota = Math.min(
    expectedAvailableQuota,
    observedRemainQuota,
  );
  return {
    targetRemainQuota,
    expectedAvailableQuota,
    observedRemainQuota,
    upstreamDelta: observedRemainQuota - expectedAvailableQuota,
    limitedBy:
      expectedAvailableQuota <= observedRemainQuota
        ? ("ledger" as const)
        : ("upstream" as const),
  };
}

export function materializeDepartmentQuota(input: {
  budgetQuota: number;
  committedAuthorizedQuota: number;
  pendingReservedQuota: number;
}) {
  const budgetQuota = normalizeQuota(input.budgetQuota, "budgetQuota");
  const committedAuthorizedQuota = normalizeQuota(
    input.committedAuthorizedQuota,
    "committedAuthorizedQuota",
  );
  const pendingReservedQuota = normalizeQuota(
    input.pendingReservedQuota,
    "pendingReservedQuota",
  );
  const grossCommitted = committedAuthorizedQuota + pendingReservedQuota;
  return {
    budgetQuota,
    committedAuthorizedQuota,
    pendingReservedQuota,
    availableQuota: Math.max(budgetQuota - grossCommitted, 0),
    overcommittedQuota: Math.max(grossCommitted - budgetQuota, 0),
  };
}

export function classifyQuotaReconciliation(input: {
  expectedAvailableQuota: number;
  observedRemainQuota?: number;
  settled: boolean;
  hasInflightRequests: boolean;
  hasNonTerminalOperation: boolean;
  observedStable: boolean;
}): QuotaReconciliationStatus {
  const expectedAvailableQuota = normalizeQuota(
    input.expectedAvailableQuota,
    "expectedAvailableQuota",
  );
  if (
    !input.settled ||
    input.hasInflightRequests ||
    input.hasNonTerminalOperation ||
    !input.observedStable ||
    input.observedRemainQuota === undefined
  ) {
    return "provisional";
  }
  const observedRemainQuota = normalizeQuota(
    input.observedRemainQuota,
    "observedRemainQuota",
  );
  if (observedRemainQuota === expectedAvailableQuota) return "healthy";
  if (observedRemainQuota > expectedAvailableQuota) return "excess_upstream";
  return "deficit_upstream";
}

function datePart(date: Date, type: "year" | "month") {
  const part = new Intl.DateTimeFormat("en-CA", {
    timeZone: QUOTA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
  })
    .formatToParts(date)
    .find((item) => item.type === type)?.value;
  if (!part) throw new Error(`Unable to format ${type} in ${QUOTA_TIME_ZONE}`);
  return part;
}

export function hongKongBillingPeriod(date = new Date()) {
  return `${datePart(date, "year")}-${datePart(date, "month")}`;
}

export function resolveUsageBillingPeriod(input: {
  billingPeriod?: string;
  occurredAt?: string;
}) {
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(input.billingPeriod ?? "")) {
    return input.billingPeriod as string;
  }
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  return hongKongBillingPeriod(
    Number.isFinite(occurredAt.getTime()) ? occurredAt : new Date(),
  );
}

export function fixedUsageSyncWindow(input: {
  runStartedAt: string;
  settledThrough?: string;
  overlapMinutes: number;
  settlementLagMinutes: number;
}) {
  const runStartedAt = new Date(input.runStartedAt);
  if (!Number.isFinite(runStartedAt.getTime())) throw new Error("runStartedAt must be ISO time");
  const overlapMinutes = normalizeQuota(input.overlapMinutes, "overlapMinutes");
  const settlementLagMinutes = normalizeQuota(
    input.settlementLagMinutes,
    "settlementLagMinutes",
  );
  const scanEndMs = runStartedAt.getTime() - settlementLagMinutes * 60_000;
  const settledMs = input.settledThrough
    ? new Date(input.settledThrough).getTime()
    : scanEndMs;
  if (!Number.isFinite(settledMs)) throw new Error("settledThrough must be ISO time");
  const scanStartMs = Math.min(settledMs, scanEndMs) - overlapMinutes * 60_000;
  return {
    scanStart: new Date(scanStartMs).toISOString(),
    scanEnd: new Date(scanEndMs).toISOString(),
  };
}

export function isSettlementWatermarkFresh(input: {
  settledThrough?: string;
  now?: string;
  maxLagMinutes: number;
}) {
  if (!input.settledThrough) return false;
  const settledAt = new Date(input.settledThrough).getTime();
  const now = new Date(input.now ?? new Date().toISOString()).getTime();
  const maxLagMinutes = normalizeQuota(input.maxLagMinutes, "maxLagMinutes");
  if (!Number.isFinite(settledAt) || !Number.isFinite(now) || settledAt > now) return false;
  return now - settledAt <= maxLagMinutes * 60_000;
}
