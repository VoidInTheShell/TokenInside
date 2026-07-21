import crypto from "node:crypto";
import type {
  QuotaReconciliationRecord,
  QuotaReconciliationStatus,
} from "./types.ts";

export type QuotaBalanceObservationCandidate = {
  id: string;
  feishuUserId: string;
  newapiTokenId: string;
  operationGeneration: number;
};

export function quotaBalanceObservationRecordId(
  feishuUserId: string,
  period: string,
) {
  const digest = crypto
    .createHash("sha256")
    .update(`${feishuUserId}:${period}`)
    .digest("hex");
  return `qbo_${digest.slice(0, 32)}`;
}

function evidenceString(
  evidence: QuotaReconciliationRecord["evidence"],
  key: string,
) {
  const value = evidence?.[key];
  return typeof value === "string" ? value : undefined;
}

function evidenceNumber(
  evidence: QuotaReconciliationRecord["evidence"],
  key: string,
) {
  const value = evidence?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Converts one observation into the durable two-round confirmation state.
 * Unstable observations always reset the chain. Healthy is immediately
 * authoritative; a stable drift needs two consecutive observations of the
 * same class before it becomes a final non-healthy status.
 */
export function buildQuotaBalanceObservationRecord(input: {
  id: string;
  candidate: QuotaBalanceObservationCandidate;
  period: string;
  expectedAvailableQuota: number;
  observedRemainQuota?: number;
  firstObservedRemainQuota?: number;
  secondObservedRemainQuota?: number;
  classifiedStatus: QuotaReconciliationStatus;
  stable: boolean;
  reason: string;
  settledThrough?: string;
  previous?: QuotaReconciliationRecord | null;
  observedAt: string;
}): QuotaReconciliationRecord {
  const previousCandidate = evidenceString(
    input.previous?.evidence,
    "observerCandidateStatus",
  );
  const previousWasStable =
    input.previous?.evidence?.observerObservationStable === true;
  const sameStableCandidate =
    input.stable &&
    input.classifiedStatus !== "provisional" &&
    previousWasStable &&
    previousCandidate === input.classifiedStatus;

  let stableRounds = 0;
  let status: QuotaReconciliationStatus = "provisional";
  if (input.stable && input.classifiedStatus === "healthy") {
    stableRounds = 1;
    status = "healthy";
  } else if (input.stable && input.classifiedStatus !== "provisional") {
    stableRounds = sameStableCandidate
      ? Math.min(
          Math.max(
            evidenceNumber(input.previous?.evidence, "observerStableRounds"),
            1,
          ) + 1,
          2,
        )
      : 1;
    status = stableRounds >= 2 ? input.classifiedStatus : "provisional";
  }

  const evidence: NonNullable<QuotaReconciliationRecord["evidence"]> = {
    observerVersion: 1,
    observerObservationStable: input.stable,
    observerReason: input.reason,
    observerStableRounds: stableRounds,
    observerCandidateStatus:
      input.stable && input.classifiedStatus !== "provisional"
        ? input.classifiedStatus
        : undefined,
    observerFirstRemainQuota: input.firstObservedRemainQuota,
    observerSecondRemainQuota: input.secondObservedRemainQuota,
  };

  return {
    id: input.id,
    feishuUserId: input.candidate.feishuUserId,
    tokenAccountId: input.candidate.id,
    period: input.period,
    expectedAvailableQuota: input.expectedAvailableQuota,
    observedRemainQuota: input.observedRemainQuota,
    delta:
      input.observedRemainQuota === undefined
        ? undefined
        : input.observedRemainQuota - input.expectedAvailableQuota,
    status,
    settledThrough: input.settledThrough,
    evidence,
    createdAt: input.previous?.createdAt ?? input.observedAt,
    updatedAt: input.observedAt,
  };
}
