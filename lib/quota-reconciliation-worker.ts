import { getConfig } from "@/lib/config";
import { nowIso } from "@/lib/crypto";
import { getQuotaFeatureFlags } from "@/lib/quota-guard";
import {
  buildQuotaShadowReconciliation,
  hasPriorStableQuotaObservation,
} from "@/lib/quota-reconciliation";
import { enqueueQuotaReconciliation } from "@/lib/quota-saga";
import { getStoreSnapshot } from "@/lib/store";
import { withPostgresAdvisoryLock } from "@/lib/postgres-store";
import type { AdminScope } from "@/lib/types";

const reconciliationLockKey = "quota_reconciliation:auto";
let jsonReconciliationRunning = false;
let schedulerStarted = false;
let schedulerTimer: ReturnType<typeof setTimeout> | undefined;

async function withReconciliationLock<T>(fn: () => Promise<T>) {
  if (getConfig().storeBackend === "postgres") {
    return withPostgresAdvisoryLock(reconciliationLockKey, fn);
  }
  if (jsonReconciliationRunning) {
    throw new Error(`${reconciliationLockKey} is already running`);
  }
  jsonReconciliationRunning = true;
  try {
    return await fn();
  } finally {
    jsonReconciliationRunning = false;
  }
}

export async function runAutomaticQuotaReconciliation(limit = 10) {
  const flags = await getQuotaFeatureFlags();
  if (!flags.quotaSagaWritesEnabled || !flags.reconciliationAutoDecreaseEnabled) {
    return { ran: false, reason: "disabled" as const, operations: [] };
  }
  return withReconciliationLock(async () => {
    const priorStore = await getStoreSnapshot();
    const now = nowIso();
    const systemScope: AdminScope = {
      id: "system:auto-reconciliation",
      feishuUserId: "system:auto-reconciliation",
      scopeType: "global",
      source: "environment",
      role: "root",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    const report = await buildQuotaShadowReconciliation({
      scope: systemScope,
      observeUpstream: true,
    });
    const operations = [];
    for (const row of report.rows) {
      if (operations.length >= Math.max(limit, 0)) break;
      if (
        row.status !== "excess_upstream" ||
        !row.observedStable ||
        !row.tokenAccountId ||
        !hasPriorStableQuotaObservation(
          priorStore.quotaReconciliationRecords,
          row,
        )
      ) {
        continue;
      }
      try {
        operations.push(
          await enqueueQuotaReconciliation({
            feishuUserId: row.feishuUserId,
            departmentId: row.departmentId,
            tokenAccountId: row.tokenAccountId,
            expectedAvailableQuota: row.expectedAvailableQuota,
            observedVersion: `${row.settledThrough ?? "unsettled"}:${row.observedRemainQuota}`,
            createdByOpenId: "system:auto-reconciliation",
          }),
        );
      } catch {
        // A concurrent user operation or the same idempotency key is expected to
        // win safely. The next scheduled observation will reconsider the row.
      }
    }
    return { ran: true, report, operations };
  });
}

function scheduleNextReconciliation(delayMs: number) {
  if (schedulerTimer) clearTimeout(schedulerTimer);
  schedulerTimer = setTimeout(async () => {
    try {
      await runAutomaticQuotaReconciliation();
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("is already running"))) {
        console.error(
          JSON.stringify({
            event: "tokeninside.quota.reconciliation_scheduler_failed",
            errorMessage:
              error instanceof Error ? error.message : "quota reconciliation failed",
          }),
        );
      }
    } finally {
      scheduleNextReconciliation(5 * 60_000);
    }
  }, Math.max(delayMs, 1_000));
  schedulerTimer.unref?.();
}

export function ensureQuotaReconciliationScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  scheduleNextReconciliation(60_000);
}
