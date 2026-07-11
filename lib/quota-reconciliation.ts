import { sha256Hex } from "@/lib/crypto";
import { getNewApiTokenRemainQuota } from "@/lib/newapi";
import {
  classifyQuotaReconciliation,
  hongKongBillingPeriod,
  isSettlementWatermarkFresh,
} from "@/lib/quota-model";
import {
  getStoreSnapshot,
  rebuildQuotaMaterializedSnapshots,
  saveQuotaReconciliationRecord,
} from "@/lib/store";
import type { AdminScope, QuotaReconciliationRecord } from "@/lib/types";

export function hasPriorStableQuotaObservation(
  records: QuotaReconciliationRecord[],
  row: {
    feishuUserId: string;
    tokenAccountId?: string;
    expectedAvailableQuota: number;
    observedRemainQuota?: number;
  },
) {
  return records.some(
    (record) =>
      record.feishuUserId === row.feishuUserId &&
      record.tokenAccountId === row.tokenAccountId &&
      record.status === "excess_upstream" &&
      record.expectedAvailableQuota === row.expectedAvailableQuota &&
      record.observedRemainQuota === row.observedRemainQuota &&
      record.evidence?.observedStable === true,
  );
}

function userInScope(scope: AdminScope, departmentId?: string) {
  return scope.scopeType === "global" || Boolean(scope.departmentId && scope.departmentId === departmentId);
}

export async function buildQuotaShadowReconciliation(input: {
  scope: AdminScope;
  period?: string;
  observeUpstream?: boolean;
}) {
  const period = input.period ?? hongKongBillingPeriod();
  const materialized = await rebuildQuotaMaterializedSnapshots(period);
  const store = await getStoreSnapshot();
  const usersById = new Map(store.users.map((item) => [item.id, item]));
  const activeAccountsByUserId = new Map<string, typeof store.tokenAccounts>();
  for (const account of store.tokenAccounts.filter((item) => item.status === "active")) {
    const accounts = activeAccountsByUserId.get(account.feishuUserId) ?? [];
    accounts.push(account);
    activeAccountsByUserId.set(account.feishuUserId, accounts);
  }
  const checkpoint = store.usageSyncCheckpoints.find(
    (item) => item.scope === "newapi_usage_logs",
  );
  const now = new Date().toISOString();
  const syncPolicy = store.settings.usageSyncPolicy;
  const watermarkFresh =
    checkpoint?.lastRunStatus === "applied" &&
    isSettlementWatermarkFresh({
      settledThrough: checkpoint.settledThrough,
      now,
      maxLagMinutes:
        2 * (syncPolicy?.intervalMinutes ?? 60) +
        (syncPolicy?.settlementLagMinutes ?? 5),
    });
  const rows = [];

  for (const item of materialized.users) {
    const user = usersById.get(item.feishuUserId);
    if (!userInScope(input.scope, user?.departmentId)) continue;
    const activeAccounts = activeAccountsByUserId.get(item.feishuUserId) ?? [];
    const account = activeAccounts.length === 1 ? activeAccounts[0] : undefined;
    const inflight = store.proxyRequestLogs.some(
      (log) =>
        log.feishuUserId === item.feishuUserId &&
        (log.status === "pending" || log.status === "streaming") &&
        (!log.leaseExpiresAt || log.leaseExpiresAt > now),
    );
    const nonTerminalOperation = store.quotaOperations.some(
      (operation) =>
        operation.feishuUserId === item.feishuUserId &&
        operation.state !== "completed" &&
        operation.state !== "compensated",
    );
    const unresolvedUsageIssue = store.usageSyncIssues.some(
      (issue) =>
        issue.status === "open" &&
        (issue.feishuUserId === item.feishuUserId ||
          (!issue.feishuUserId && issue.issueType === "unknown_token")),
    );
    const modelComplete = item.policyPresent && item.ledgerEntries > 0;
    const activeGenerationUnique = activeAccounts.length <= 1;

    let observedRemainQuota: number | undefined;
    let observedStable = false;
    let observationError: string | undefined;
    if (input.observeUpstream && account?.newapiTokenId) {
      try {
        const first = await getNewApiTokenRemainQuota(account.newapiTokenId);
        const second = await getNewApiTokenRemainQuota(account.newapiTokenId);
        observedRemainQuota = second;
        observedStable = first !== undefined && first === second;
      } catch (error) {
        observationError = error instanceof Error ? error.message : "NewAPI balance read failed";
      }
    }

    const status = classifyQuotaReconciliation({
      expectedAvailableQuota: item.expectedAvailableQuota,
      observedRemainQuota,
      settled:
        watermarkFresh &&
        !unresolvedUsageIssue &&
        modelComplete &&
        activeGenerationUnique,
      hasInflightRequests: inflight,
      hasNonTerminalOperation: nonTerminalOperation,
      observedStable,
    });
    const delta =
      observedRemainQuota === undefined
        ? undefined
        : observedRemainQuota - item.expectedAvailableQuota;
    const row = {
      ...item,
      userName: user?.name,
      departmentId: user?.departmentId,
      tokenAccountId: account?.id,
      activeGeneration: account?.operationGeneration ?? 0,
      settledThrough: checkpoint?.settledThrough,
      observedRemainQuota,
      observedStable,
      delta,
      status,
      observationError,
      unresolvedUsageIssue,
      modelComplete,
      activeGenerationUnique,
    };
    rows.push(row);

    if (input.observeUpstream) {
      const record: QuotaReconciliationRecord = {
        id: `qr_${sha256Hex(`${item.feishuUserId}:${account?.id ?? "none"}:${period}:${now}`).slice(0, 28)}`,
        feishuUserId: item.feishuUserId,
        tokenAccountId: account?.id,
        period,
        expectedAvailableQuota: item.expectedAvailableQuota,
        observedRemainQuota,
        delta,
        status,
        settledThrough: checkpoint?.settledThrough,
        evidence: {
          observedStable,
          inflight,
          nonTerminalOperation,
          observationError,
          unresolvedUsageIssue,
          modelComplete,
          activeGenerationUnique,
          watermarkFresh,
        },
        createdAt: now,
        updatedAt: now,
      };
      await saveQuotaReconciliationRecord(record);
    }
  }

  return {
    period,
    materializedAt: materialized.materializedAt,
    observedUpstream: Boolean(input.observeUpstream),
    settledThrough: checkpoint?.settledThrough,
    rows,
    totals: {
      users: rows.length,
      healthy: rows.filter((item) => item.status === "healthy").length,
      excessUpstream: rows.filter((item) => item.status === "excess_upstream").length,
      deficitUpstream: rows.filter((item) => item.status === "deficit_upstream").length,
      provisional: rows.filter((item) => item.status === "provisional").length,
    },
  };
}
