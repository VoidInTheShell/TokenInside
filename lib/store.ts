import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  resolveSessionAdminScopeProjection,
  tokenRequestInAdminScope,
} from "@/lib/admin-scope";
import {
  canClaimBillingOperation,
  isTerminalBillingOperationStatus,
  retainBillingOperationRecords,
  sameBillingOperationInput,
} from "@/lib/billing-operation-state";
import { getConfig } from "@/lib/config";
import { nowIso, randomId, sha256Hex } from "@/lib/crypto";
import { isAtOrAfterIsoTimestamp } from "@/lib/iso-time";
import { createRerunSingleFlight } from "@/lib/rerun-single-flight";
import type { NormalizedNewApiUsageLog } from "@/lib/newapi";
import {
  sameNewApiUsageSource,
  stableNewApiUsageRecordId,
} from "@/lib/newapi-usage-identity";
import { findProxyLogForNewApiUsage, isBillableProxyLog } from "@/lib/usage-matching";
import { isUsageRecordRequest } from "@/lib/usage-record-visibility";
import { normalizedInputTokensTotal } from "@/lib/usage-metrics";
import { preserveUserAccessRevocationBarrier } from "@/lib/user-access-state";
import {
  getPostgresAdminScopeById,
  getPostgresAdminOverview,
  getPostgresAdminOverviewMetadata,
  getPostgresAuthenticatedSessionProjection,
  getPostgresSessionStoreSummary,
  getPostgresUserByOpenId,
  listPostgresAdminScopeProjections,
  listPostgresAdminTokenRequestRows,
  listPostgresAdminUsers,
  listPostgresDepartmentStats,
  listPostgresPrewarmDepartmentCandidates,
  listPostgresUsageReport,
} from "@/lib/postgres-control-queries";
import { assertQuotaAdmission } from "@/lib/quota-admission";
import {
  hongKongBillingPeriod,
  initialUnassignedMonthlyQuota,
  isSettlementWatermarkFresh,
  materializeDepartmentQuota,
  materializeUserQuota,
  resolveUsageBillingPeriod,
} from "@/lib/quota-model";
import {
  assertPackageResetExecutionAllowed,
  defaultPackageResetPolicy,
  normalizePackageResetPolicy,
  PACKAGE_RESET_SYSTEM_ACTOR,
  packageBillingPeriod,
} from "@/lib/package-reset";
import {
  assertQuotaOperationTransition,
  canAutoResumeKeyRotationObservationFailure,
  canCancelQuotaOperationForAccessRevoke,
  canReopenFirstProvisionAfterAccessRevoke,
  canReopenMonthlyOpenAfterAccessRevoke,
  reopenFirstProvisionAfterAccessRevoke,
  reopenMonthlyOpenAfterAccessRevoke,
} from "@/lib/quota-saga-state";
import {
  adminDecidableRequestStatuses,
  tokenRequestAllowsQuotaEdit,
  tokenRequestRequiresAdminDecision,
} from "@/lib/token-request-policy";
import {
  currentQuotaPeriod,
  initialDepartmentQuotaLimit,
  summarizeDepartmentQuota,
  validateDepartmentAllocation,
  validateDepartmentQuotaLimit,
} from "@/lib/department-quota";
import {
  AdminUserActionAuthorizationError,
  assertAdminScopeAllowsUserTarget,
  authorizePostgresAdminUserActionUnderScopeLocks,
  enablePostgresUserAccess,
  enablePostgresUserAccessUnderUserFence,
  claimPostgresBillingOperationExecution,
  claimPostgresPrewarmedTokenAccount,
  claimPostgresQuotaOperationExecution,
  beginPostgresQuotaAwareProxyRequest,
  batchUpsertPostgresDepartmentMembersForSync,
  createPostgresMonthlyOpenOperations,
  createPostgresQuotaOperation,
  createPostgresUserQuotaPolicyVersion,
  enqueuePostgresBillingOperation,
  enqueuePostgresDepartmentMemberSyncOperationAsActor,
  findPostgresBillingOperationById,
  findPostgresQuotaOperationById,
  findPostgresQuotaOperationByIdempotencyKey,
  findPostgresActiveTokenByHash,
  finalizePostgresTokenProvision,
  finalizePostgresTokenRotation,
  finalizePostgresTokenRotationForQuotaOperation,
  finalizePostgresUserAccessResumeUnderUserFence,
  getPostgresDisabledTokenForUser,
  getPostgresActiveTokenForUser,
  getPostgresActiveAdminScopeForUser,
  getPostgresAdminScopeFallbackData,
  getPostgresAppSettings,
  getPostgresAppSettingsForQuotaOperation,
  getPostgresFeishuEventByUuid,
  getPostgresGreenfieldInstallationManifest,
  getPostgresNewApiRuntimeBindingSnapshot,
  getPostgresEffectiveUserQuotaPolicy,
  getPostgresTokenRequestById,
  getPostgresUserBillingPeriod,
  getPostgresUserById,
  getPostgresUserQuotaState,
  getPostgresUsageSyncCheckpoint,
  getPostgresEarliestOpenBlockingUsageIssue,
  getPostgresDepartmentQuotaOverview,
  insertPostgresQuotaAwareProxyLog,
  insertPostgresProxyLog,
  insertPostgresQuotaLedgerEntry,
  insertPostgresPrewarmedTokenAccountIfEligible,
  insertPostgresTokenAccount,
  insertPostgresTokenAccountForQuotaOperation,
  insertPostgresTokenRequest,
  insertPostgresDepartmentQuotaRequest,
  invalidatePostgresOpenFirstApplyRequests,
  listPostgresInflightProxyRequests,
  listPostgresInflightProxyRequestsForQuotaOperation,
  listPostgresStaleUserAccessResumeCandidates,
  listPostgresDueQuotaOperations,
  listPostgresBillingOperations,
  listPostgresDepartmentMemberSyncOperations,
  listPostgresQuotaOperations,
  listPostgresRunnableBillingOperations,
  listPostgresTokenRequestsForUser,
  listPostgresTokenAccountsForUser,
  mutatePostgresAppSettings,
  preparePostgresPackageResetPeriod,
  markPostgresUserAccessResumeEnableAttemptUnderUserFence,
  rebuildPostgresDepartmentQuotaMaterializedSnapshot,
  rebuildPostgresDepartmentQuotaMaterializedSnapshotForQuotaOperation,
  rebuildPostgresQuotaMaterializedUsers,
  replacePostgresActiveTokenAccount,
  rollbackPostgresUserAccessResumeUnderUserFence,
  readPostgresStore,
  readPostgresUsageMatchingSnapshot,
  recordPostgresBillingOperation,
  reconcilePostgresBillingPeriodForUser,
  reconcilePostgresBillingPeriodForQuotaOperation,
  refreshPostgresBillingPeriodTokenMetadataForQuotaOperation,
  releasePostgresQuotaOperationExecution,
  renewPostgresQuotaOperationExecution,
  renewPostgresBillingOperationExecution,
  reservePostgresQuotaOperationDepartmentBudget,
  revokePostgresAdminScopesForUser,
  syncPostgresDepartmentSupervisorAdminScope,
  transitionPostgresQuotaOperation,
  transitionPostgresTokenRequest,
  transitionPostgresTokenRequestAfterQuotaMaterialization,
  updatePostgresManualAdminScope,
  updatePostgresManualAdminScopeAsActor,
  updatePostgresAppSettingsAsActor,
  updatePostgresProxyLog,
  updatePostgresProxyUsageSettlementRetryIfUnsettled,
  updatePostgresTokenRequest,
  updatePostgresTokenRequestForQuotaOperation,
  updatePostgresTokenAccount,
  updatePostgresTokenAccountForQuotaOperation,
  updatePostgresDepartmentQuotaRequest,
  updatePostgresDepartmentQuotaPolicyAsActor,
  decidePostgresDepartmentQuotaRequestAsActor,
  createPostgresDepartmentQuotaRequestAsActor,
  updatePostgresUserAccessStatus,
  updatePostgresUserAccessStatusUnderUserFence,
  updatePostgresQuotaOperation,
  upsertPostgresFeishuEvent,
  upsertPostgresFeishuUser,
  upsertPostgresDepartmentQuotaPeriod,
  upsertPostgresQuotaChangeEvent,
  upsertPostgresQuotaReconciliationRecord,
  upsertPostgresUserQuotaState,
  upsertPostgresUserBillingPeriod,
  upsertPostgresUsageSyncCheckpoint,
  upsertPostgresManualAdminScope,
  upsertPostgresManualAdminScopeAsActor,
  assertPostgresDepartmentMemberSyncExecutionAuthorized,
  withPostgresAdvisoryLock,
  withPostgresUsageSettlementBatch,
} from "@/lib/postgres-store";
import type {
  AdminScope,
  BillingOperationKind,
  BillingOperationRecord,
  BillingOperationStatus,
  DepartmentQuotaPeriod,
  DepartmentQuotaRequest,
  FeishuEvent,
  FeishuUser,
  NewApiUsageMatchStatus,
  NewApiUsageRecord,
  ProxyAdmissionLogInput,
  ProxyRequestLog,
  ProxyRequestAdmissionResult,
  QuotaChangeEvent,
  QuotaLedgerEntry,
  QuotaOperation,
  QuotaReconciliationRecord,
  RequestStatus,
  StoreShape,
  TokenAccount,
  TokenStatus,
  TokenRequest,
  UserQuotaPolicy,
  UserQuotaState,
  UsageSyncCheckpoint,
  UsageSyncIssue,
  UsageSyncIssueType,
  UsageSyncPolicy,
  UserBillingPeriod,
} from "@/lib/types";
import type { QuotaExecutionFence } from "@/lib/quota-execution-fence";

export function defaultUsageSyncPolicy(): UsageSyncPolicy {
  return {
    // Authoritative NewAPI usage is the recovery source for process restarts,
    // delayed control-plane logs and downstream cancellations. New installs
    // must not silently run without that durable repair loop.
    intervalMinutes: 5,
    pageSize: 100,
    maxPagesPerRun: 3,
    overlapMinutes: 120,
    settlementLagMinutes: 1,
    matchWindowMinutes: 30,
    retryBaseMinutes: 5,
  };
}

const initialStore: StoreShape = {
  version: 1,
  settings: {
    defaultMonthlyQuota: 200,
    usageSyncPolicy: defaultUsageSyncPolicy(),
    packageReset: defaultPackageResetPolicy(),
    billingOperations: [],
  },
  users: [],
  tokenRequests: [],
  tokenAccounts: [],
  userBillingPeriods: [],
  departmentQuotaPeriods: [],
  departmentQuotaRequests: [],
  quotaChangeEvents: [],
  userQuotaPolicies: [],
  quotaOperations: [],
  quotaLedgerEntries: [],
  userQuotaStates: [],
  quotaReconciliationRecords: [],
  feishuEvents: [],
  proxyRequestLogs: [],
  newapiUsageRecords: [],
  usageSyncCheckpoints: [],
  usageSyncIssues: [],
  adminScopes: [],
};

const maxBillingOperationRecords = 50;

const invalidatableFirstApplyStatuses = new Set<RequestStatus>([
  "pending_card_send",
  "pending_card_approval",
  "approval_card_send_failed",
  "approval_route_failed",
  "pending_feishu_approval",
  "approved",
  "approved_provisioning",
  "approved_provision_failed",
]);

function isInactiveUser(user: FeishuUser) {
  return Boolean(user.status && user.status !== "active");
}

function blocksAutomaticAdminRestore(scope: AdminScope) {
  if (scope.status !== "disabled") return false;
  return (
    scope.disabledReason === "manual_revoke" ||
    scope.disabledReason === "user_deleted" ||
    scope.disabledReason === undefined
  );
}

function blocksAllAutomaticAdminRestoreForUser(scope: AdminScope) {
  return scope.scopeType === "global" && blocksAutomaticAdminRestore(scope);
}

function disableAdminScope(
  scope: AdminScope,
  input: {
    now: string;
    reason: NonNullable<AdminScope["disabledReason"]>;
    disabledByFeishuUserId?: string;
  },
) {
  scope.status = "disabled";
  scope.disabledReason = input.reason;
  scope.disabledByFeishuUserId = input.disabledByFeishuUserId;
  scope.disabledAt = input.now;
  scope.updatedAt = input.now;
}

function activateAdminScope(scope: AdminScope, now: string) {
  scope.status = "active";
  scope.disabledReason = undefined;
  scope.disabledByFeishuUserId = undefined;
  scope.disabledAt = undefined;
  scope.updatedAt = now;
}

function revokeAdminScopesForUserInStore(
  store: StoreShape,
  input: {
    feishuUserId: string;
    reason: NonNullable<AdminScope["disabledReason"]>;
    disabledByFeishuUserId?: string;
    now: string;
  },
) {
  const revoked: AdminScope[] = [];
  for (const scope of store.adminScopes) {
    if (scope.feishuUserId !== input.feishuUserId || scope.source === "environment") continue;
    disableAdminScope(scope, input);
    revoked.push(scope);
  }
  return revoked;
}

function isPostgresBackend() {
  return getConfig().storeBackend === "postgres";
}

async function readStore(): Promise<StoreShape> {
  const config = getConfig();
  if (config.storeBackend === "postgres") {
    return readPostgresStore();
  }

  const filePath = config.storePath;
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    const store = {
      ...initialStore,
      ...parsed,
      settings: {
        ...initialStore.settings,
        ...parsed.settings,
      },
    };
    if (normalizeStore(store)) {
      await writeStore(store);
    }
    return store;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await writeStore(initialStore);
    return structuredClone(initialStore);
  }
}

function normalizeUsageSyncPolicy(policy?: Partial<UsageSyncPolicy>): UsageSyncPolicy {
  const defaults = defaultUsageSyncPolicy();
  return {
    ...defaults,
    ...policy,
    intervalMinutes: Math.min(Math.max(Math.trunc(policy?.intervalMinutes ?? defaults.intervalMinutes), 1), 24 * 60),
    pageSize: Math.min(Math.max(Math.trunc(policy?.pageSize ?? defaults.pageSize), 1), 100),
    maxPagesPerRun: Math.min(Math.max(Math.trunc(policy?.maxPagesPerRun ?? defaults.maxPagesPerRun), 1), 20),
    overlapMinutes: Math.min(Math.max(Math.trunc(policy?.overlapMinutes ?? defaults.overlapMinutes), 0), 7 * 24 * 60),
    settlementLagMinutes: Math.min(
      Math.max(Math.trunc(policy?.settlementLagMinutes ?? defaults.settlementLagMinutes ?? 5), 0),
      24 * 60,
    ),
    matchWindowMinutes: Math.min(Math.max(Math.trunc(policy?.matchWindowMinutes ?? defaults.matchWindowMinutes), 1), 24 * 60),
    retryBaseMinutes: Math.min(
      Math.max(Math.trunc(policy?.retryBaseMinutes ?? defaults.retryBaseMinutes ?? 5), 1),
      24 * 60,
    ),
  };
}

function normalizeStore(store: StoreShape) {
  let changed = false;
  if (!store.settings) {
    store.settings = structuredClone(initialStore.settings);
    changed = true;
  }
  const normalizedPolicy = normalizeUsageSyncPolicy(store.settings.usageSyncPolicy);
  if (JSON.stringify(store.settings.usageSyncPolicy ?? null) !== JSON.stringify(normalizedPolicy)) {
    store.settings.usageSyncPolicy = normalizedPolicy;
    changed = true;
  }
  const normalizedPackageReset = normalizePackageResetPolicy(
    store.settings.packageReset,
  );
  if (
    JSON.stringify(store.settings.packageReset ?? null) !==
    JSON.stringify(normalizedPackageReset)
  ) {
    store.settings.packageReset = normalizedPackageReset;
    changed = true;
  }
  if (!Array.isArray(store.settings.billingOperations)) {
    store.settings.billingOperations = [];
    changed = true;
  }
  if (store.settings.billingOperations.length > maxBillingOperationRecords) {
    store.settings.billingOperations = retainBillingOperationRecords(
      store.settings.billingOperations,
      maxBillingOperationRecords,
    );
    changed = true;
  }
  if (!Array.isArray(store.newapiUsageRecords)) {
    store.newapiUsageRecords = [];
    changed = true;
  }
  if (!Array.isArray(store.usageSyncCheckpoints)) {
    store.usageSyncCheckpoints = [];
    changed = true;
  }
  if (!Array.isArray(store.usageSyncIssues)) {
    store.usageSyncIssues = [];
    changed = true;
  }
  if (!Array.isArray(store.departmentQuotaPeriods)) {
    store.departmentQuotaPeriods = [];
    changed = true;
  }
  if (!Array.isArray(store.departmentQuotaRequests)) {
    store.departmentQuotaRequests = [];
    changed = true;
  }
  if (!Array.isArray(store.quotaChangeEvents)) {
    store.quotaChangeEvents = [];
    changed = true;
  }
  for (const key of [
    "userQuotaPolicies",
    "quotaOperations",
    "quotaLedgerEntries",
    "userQuotaStates",
    "quotaReconciliationRecords",
  ] as const) {
    if (!Array.isArray(store[key])) {
      store[key] = [];
      changed = true;
    }
  }
  const accountsByRequestId = new Map(
    store.tokenAccounts.map((account) => [account.tokenRequestId, account]),
  );

  for (const request of store.tokenRequests) {
    if (request.status !== "provisioned") continue;
    const account = accountsByRequestId.get(request.id);
    if (account && request.tokenAccountId !== account.id) {
      request.tokenAccountId = account.id;
      changed = true;
    }
    if (request.errorMessage) {
      delete request.errorMessage;
      changed = true;
    }
  }

  for (const log of store.proxyRequestLogs) {
    if (!log.status) {
      if (log.statusCode === 0) {
        log.status = "pending";
      } else if (log.statusCode === 499) {
        log.status = "cancelled";
      } else if (log.statusCode >= 400) {
        log.status = "failed";
      } else {
        log.status = "completed";
      }
      changed = true;
    }
    if (log.durationMs === undefined) {
      log.durationMs = 0;
      changed = true;
    }
    if (
      log.totalTokens === undefined &&
      log.promptTokens !== undefined &&
      log.completionTokens !== undefined
    ) {
      log.totalTokens = log.promptTokens + log.completionTokens;
      changed = true;
    }
    if (!log.updatedAt) {
      log.updatedAt = log.createdAt;
      changed = true;
    }
  }

  if (syncBillingPeriods(store)) {
    changed = true;
  }

  return changed;
}

function periodFromIso(value?: string) {
  return value?.slice(0, 7) || nowIso().slice(0, 7);
}

function latestIso(...values: Array<string | undefined>) {
  const sorted = values.filter(Boolean).sort();
  return sorted.length ? sorted[sorted.length - 1] : nowIso();
}

function billingKey(feishuUserId: string, period: string) {
  return `${feishuUserId}:${period}`;
}

function sameStringArray(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function finiteUsageAmount(value?: number) {
  return Number.isFinite(value) ? (value as number) : 0;
}

function proxyLogQuotaConsumed(log: ProxyRequestLog) {
  if (log.usageSource !== "newapi_log") return 0;
  return finiteUsageAmount(log.cost ?? log.quota);
}

function usageRecordQuotaConsumed(record: NewApiUsageRecord) {
  return finiteUsageAmount(record.cost ?? record.quota);
}

function isAuthoritativeUsageRecord(record: NewApiUsageRecord) {
  return Boolean(
    record.feishuUserId &&
      record.tokenAccountId &&
      (record.matchStatus === "matched" || record.matchStatus === "no_proxy_match"),
  );
}

function usageRecordPeriod(record: NewApiUsageRecord) {
  return resolveUsageBillingPeriod({
    billingPeriod: record.billingPeriod,
    occurredAt: record.newapiCreatedAt ?? record.lastSyncedAt ?? record.firstSeenAt,
  });
}

function syncBillingPeriods(store: StoreShape) {
  let changed = false;
  const initialMonthlyQuota = initialUnassignedMonthlyQuota();
  const existingByKey = new Map(
    store.userBillingPeriods.map((period) => [
      billingKey(period.feishuUserId, period.period),
      period,
    ]),
  );
  const computed = new Map<
    string,
    UserBillingPeriod & { quotaUpdatedAt?: string; sourceUpdatedAt?: string }
  >();

  function ensure(feishuUserId: string, period: string) {
    const key = billingKey(feishuUserId, period);
    const existing = existingByKey.get(key);
    let summary = computed.get(key);
    if (!summary) {
      summary = {
        id: existing?.id ?? randomId("bp"),
        feishuUserId,
        period,
        monthlyQuota: existing?.monthlyQuota ?? initialMonthlyQuota,
        quotaConsumed: 0,
        cost: 0,
        remainingQuota: existing?.monthlyQuota ?? initialMonthlyQuota,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        proxyLogCount: 0,
        usageRecordCount: 0,
        activeTokenAccountId: undefined,
        tokenAccountIds: [],
        assignedQuotaUpdatedAt: existing?.assignedQuotaUpdatedAt,
        assignedQuotaUpdatedByFeishuUserId: existing?.assignedQuotaUpdatedByFeishuUserId,
        updatedAt: existing?.updatedAt ?? nowIso(),
        quotaUpdatedAt: existing?.assignedQuotaUpdatedAt,
        sourceUpdatedAt: existing?.updatedAt,
      };
      computed.set(key, summary);
    }
    return summary;
  }

  for (const account of store.tokenAccounts) {
    // A prewarmed account is inventory, not an issued entitlement. It must not
    // create a user billing row or inherit the default application quota.
    if (
      account.status === "pending_activation" &&
      Boolean(account.prewarmedAt) &&
      account.tokenRequestId.startsWith("prewarm:")
    ) {
      continue;
    }
    const period = account.billingPeriod || periodFromIso(account.createdAt);
    const summary = ensure(account.feishuUserId, period);
    summary.tokenAccountIds.push(account.id);
    if (account.status === "active") {
      summary.activeTokenAccountId = account.id;
    }
    summary.sourceUpdatedAt = latestIso(summary.sourceUpdatedAt, account.createdAt, account.disabledAt);

  }

  for (const policy of store.userQuotaPolicies) {
    ensure(policy.feishuUserId, policy.effectiveFromPeriod);
  }
  for (const entry of store.quotaLedgerEntries) {
    ensure(entry.feishuUserId, entry.period);
  }

  const proxyLogIdsBackedByNewApiRecords = new Set<string>();
  for (const record of store.newapiUsageRecords) {
    if (!isAuthoritativeUsageRecord(record)) continue;
    if (record.matchStatus === "matched" && record.matchedProxyLogId) {
      proxyLogIdsBackedByNewApiRecords.add(record.matchedProxyLogId);
    }
    if (!record.feishuUserId) continue;
    const quotaConsumed = usageRecordQuotaConsumed(record);
    const period = usageRecordPeriod(record);
    const summary = ensure(record.feishuUserId, period);
    summary.promptTokens += record.promptTokens ?? 0;
    summary.completionTokens += record.completionTokens ?? 0;
    summary.totalTokens +=
      record.totalTokens ?? (record.promptTokens ?? 0) + (record.completionTokens ?? 0);
    summary.quotaConsumed += quotaConsumed;
    summary.cost += quotaConsumed;
    summary.usageRecordCount += 1;
    summary.sourceUpdatedAt = latestIso(
      summary.sourceUpdatedAt,
      record.newapiCreatedAt,
      record.lastSyncedAt,
      record.firstSeenAt,
    );
  }

  for (const log of store.proxyRequestLogs) {
    if (!log.feishuUserId) continue;
    if (!isBillableProxyLog(log)) continue;
    const period = resolveUsageBillingPeriod({
      billingPeriod: log.billingPeriod,
      occurredAt: log.createdAt,
    });
    const summary = ensure(log.feishuUserId, period);
    summary.proxyLogCount += 1;
    if (!proxyLogIdsBackedByNewApiRecords.has(log.id)) {
      summary.promptTokens += log.promptTokens ?? 0;
      summary.completionTokens += log.completionTokens ?? 0;
      summary.totalTokens +=
        log.totalTokens ?? (log.promptTokens ?? 0) + (log.completionTokens ?? 0);
      const quotaConsumed = proxyLogQuotaConsumed(log);
      if (quotaConsumed || log.cost !== undefined || log.quota !== undefined) {
        summary.quotaConsumed += quotaConsumed;
        summary.cost += quotaConsumed;
        summary.usageRecordCount += 1;
      }
    }
    summary.sourceUpdatedAt = latestIso(summary.sourceUpdatedAt, log.createdAt);
  }

  for (const summary of computed.values()) {
    summary.tokenAccountIds = [...new Set(summary.tokenAccountIds)].sort();
    const policy = store.userQuotaPolicies
      .filter(
        (item) =>
          item.feishuUserId === summary.feishuUserId &&
          item.effectiveFromPeriod <= summary.period &&
          (!item.effectiveToPeriod || item.effectiveToPeriod >= summary.period),
      )
      .sort((left, right) => right.version - left.version)[0];
    const ledgerEntries = store.quotaLedgerEntries.filter(
      (item) =>
        item.feishuUserId === summary.feishuUserId && item.period === summary.period,
    );
    const quotaPerUnit = getConfig().newapi.quotaPerUnit;
    const authoritativeConsumedQuota = store.newapiUsageRecords
      .filter(
        (item) =>
          item.feishuUserId === summary.feishuUserId &&
          usageRecordPeriod(item) === summary.period &&
          isAuthoritativeUsageRecord(item),
      )
      .reduce(
        (total, item) => total + authoritativeQuotaFromRecord(item, quotaPerUnit),
        0,
      );
    const materialized = materializeUserQuota({
      assignedMonthlyQuota: policy?.assignedMonthlyQuota ?? 0,
      authoritativeConsumedQuota,
      ledgerEntries,
    });
    summary.monthlyQuota = (policy?.assignedMonthlyQuota ?? 0) / quotaPerUnit;
    summary.quotaConsumed = authoritativeConsumedQuota / quotaPerUnit;
    summary.cost = summary.quotaConsumed;
    summary.remainingQuota = materialized.expectedAvailableQuota / quotaPerUnit;
    Object.assign(summary, materialized, {
      settledThrough: store.usageSyncCheckpoints.find(
        (item) => item.scope === "newapi_usage_logs",
      )?.settledThrough,
      sourceVersion: `${policy?.version ?? 0}:${ledgerEntries.length}:${summary.usageRecordCount}`,
      materializedAt: nowIso(),
    });
    summary.updatedAt = summary.sourceUpdatedAt ?? summary.updatedAt;
    delete summary.quotaUpdatedAt;
    delete summary.sourceUpdatedAt;
  }

  for (const summary of computed.values()) {
    const key = billingKey(summary.feishuUserId, summary.period);
    const existing = existingByKey.get(key);
    if (!existing) {
      store.userBillingPeriods.push(summary);
      changed = true;
      continue;
    }
    const patch: Partial<UserBillingPeriod> = {};
    if (existing.monthlyQuota !== summary.monthlyQuota) patch.monthlyQuota = summary.monthlyQuota;
    if (existing.quotaConsumed !== summary.quotaConsumed) patch.quotaConsumed = summary.quotaConsumed;
    if (existing.cost !== summary.cost) patch.cost = summary.cost;
    if (existing.remainingQuota !== summary.remainingQuota) patch.remainingQuota = summary.remainingQuota;
    if (existing.promptTokens !== summary.promptTokens) patch.promptTokens = summary.promptTokens;
    if (existing.completionTokens !== summary.completionTokens) {
      patch.completionTokens = summary.completionTokens;
    }
    if (existing.totalTokens !== summary.totalTokens) patch.totalTokens = summary.totalTokens;
    if (existing.proxyLogCount !== summary.proxyLogCount) patch.proxyLogCount = summary.proxyLogCount;
    if (existing.usageRecordCount !== summary.usageRecordCount) {
      patch.usageRecordCount = summary.usageRecordCount;
    }
    if (existing.activeTokenAccountId !== summary.activeTokenAccountId) {
      patch.activeTokenAccountId = summary.activeTokenAccountId;
    }
    if (!sameStringArray(existing.tokenAccountIds, summary.tokenAccountIds)) {
      patch.tokenAccountIds = summary.tokenAccountIds;
    }
    if (existing.assignedQuotaUpdatedAt !== summary.assignedQuotaUpdatedAt) {
      patch.assignedQuotaUpdatedAt = summary.assignedQuotaUpdatedAt;
    }
    if (
      existing.assignedQuotaUpdatedByFeishuUserId !==
      summary.assignedQuotaUpdatedByFeishuUserId
    ) {
      patch.assignedQuotaUpdatedByFeishuUserId = summary.assignedQuotaUpdatedByFeishuUserId;
    }
    if (existing.updatedAt !== summary.updatedAt) patch.updatedAt = summary.updatedAt;
    if (Object.keys(patch).length) {
      Object.assign(existing, patch);
      changed = true;
    }
  }

  return changed;
}

async function writeStore(store: StoreShape) {
  const config = getConfig();
  if (config.storeBackend === "postgres") {
    throw new Error("PostgreSQL store writes must use row-level helpers, not writeStore()");
  }

  const filePath = config.storePath;
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomId("tmp")}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

async function mutate<T>(fn: (store: StoreShape) => T | Promise<T>) {
  const store = await readStore();
  const result = await fn(store);
  await writeStore(store);
  return result;
}

export async function getStoreSnapshot() {
  return readStore();
}

export async function getSessionStoreSummary() {
  if (isPostgresBackend()) {
    return getPostgresSessionStoreSummary();
  }
  const store = await readStore();
  return {
    settings: {
      defaultMonthlyQuota: store.settings.defaultMonthlyQuota,
    },
    proxyLogCount: store.proxyRequestLogs.length,
  };
}

export async function getAuthenticatedSessionProjection(user: FeishuUser) {
  if (!isPostgresBackend()) return null;

  const projection = await getPostgresAuthenticatedSessionProjection({
    feishuUserId: user.id,
    approvalTargetOpenId: user.openId,
    departmentId: user.departmentId,
    currentPeriod: currentQuotaPeriod(),
  });
  const adminScope = resolveSessionAdminScopeProjection({
    user,
    systemAdminOpenIds: new Set(getConfig().admin.systemAdminOpenIds),
    activeScope: projection.activeAdminScope,
    assignedRequest: projection.assignedRequest,
    scopes: projection.adminScopes,
    now: nowIso(),
  });
  const effectiveGrantQuota =
    projection.currentBilling?.monthlyQuota ??
    projection.departmentQuotaPeriod?.defaultGrantQuota ??
    projection.defaultMonthlyQuota;

  return {
    settings: {
      defaultMonthlyQuota: effectiveGrantQuota,
    },
    requests: projection.requests,
    activeToken: projection.activeToken,
    billingPeriod: projection.activeTokenBilling,
    adminScope,
    proxyLogCount: projection.proxyLogCount,
  };
}

export async function getAppSettings() {
  if (isPostgresBackend()) {
    const settings = await getPostgresAppSettings();
    return {
      ...settings,
      usageSyncPolicy: normalizeUsageSyncPolicy(settings.usageSyncPolicy),
      packageReset: normalizePackageResetPolicy(settings.packageReset),
    };
  }
  const store = await readStore();
  return store.settings;
}

export async function getCurrentPackageBillingPeriod(now = new Date()) {
  const settings = await getAppSettings();
  return packageBillingPeriod(settings.packageReset, now);
}

export async function getAppSettingsForQuotaOperation() {
  if (isPostgresBackend()) {
    const settings = await getPostgresAppSettingsForQuotaOperation();
    return {
      ...settings,
      usageSyncPolicy: normalizeUsageSyncPolicy(settings.usageSyncPolicy),
      packageReset: normalizePackageResetPolicy(settings.packageReset),
    };
  }
  return getAppSettings();
}

export async function getAdminOverviewMetadata() {
  if (isPostgresBackend()) {
    const metadata = await getPostgresAdminOverviewMetadata();
    const { billingOperations: _legacyBillingOperations, ...settings } = metadata.settings as
      typeof metadata.settings & { billingOperations?: unknown };
    return {
      settings: {
        ...settings,
        usageSyncPolicy: normalizeUsageSyncPolicy(settings.usageSyncPolicy),
      },
      usageSyncCheckpoint: metadata.usageSyncCheckpoint,
    };
  }
  const [settings, usageSyncCheckpoint] = await Promise.all([
    getAppSettings(),
    getUsageSyncCheckpoint(),
  ]);
  return { settings, usageSyncCheckpoint };
}

type BillingOperationWrite = {
  id?: string;
  kind: BillingOperationKind;
  status: BillingOperationStatus;
  dryRun: boolean;
  operatedByFeishuUserId: string;
  period?: string;
  input?: Record<string, unknown>;
  summary: BillingOperationRecord["summary"];
  errorMessage?: string;
};

function upsertBillingOperation(
  settings: StoreShape["settings"],
  input: BillingOperationWrite,
) {
  const now = nowIso();
  const records = settings.billingOperations ?? [];
  const existing = input.id ? records.find((item) => item.id === input.id) : undefined;
  const terminal = isTerminalBillingOperationStatus(input.status);
  const record: BillingOperationRecord = {
    ...existing,
    ...input,
    id: input.id ?? existing?.id ?? randomId("bo"),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    attemptCount: existing?.attemptCount,
    leaseId: terminal ? undefined : existing?.leaseId,
    leaseExpiresAt: terminal ? undefined : existing?.leaseExpiresAt,
    startedAt: existing?.startedAt,
    completedAt: terminal ? now : undefined,
  };
  settings.billingOperations = retainBillingOperationRecords(
    [record, ...records.filter((item) => item.id !== record.id)],
    maxBillingOperationRecords,
  );
  return record;
}

async function mutateBillingOperations<T>(
  fn: (settings: StoreShape["settings"]) => T | Promise<T>,
) {
  return mutate((store) => fn(store.settings));
}

export async function getGreenfieldInstallationManifest() {
  if (isPostgresBackend()) {
    return getPostgresGreenfieldInstallationManifest();
  }
  return null;
}

export async function getNewApiRuntimeBindingSnapshot() {
  if (isPostgresBackend()) {
    return getPostgresNewApiRuntimeBindingSnapshot();
  }
  return {
    settings: await getAppSettings(),
    manifest: null,
  };
}

export async function enqueueBillingOperation(input: {
  kind: BillingOperationKind;
  dryRun: boolean;
  operatedByFeishuUserId: string;
  period?: string;
  input?: Record<string, unknown>;
  requireRootActor?: boolean;
}) {
  const { requireRootActor = false, ...operationInput } = input;
  if (isPostgresBackend()) {
    const now = nowIso();
    const submitted = await enqueuePostgresBillingOperation({
      ...operationInput,
      id: randomId("bo"),
      status: "pending",
      summary: {},
      createdAt: now,
      updatedAt: now,
    }, { requireRootActor });
    const sameInput =
      submitted.operation.dryRun === operationInput.dryRun &&
      sameBillingOperationInput(submitted.operation.input, operationInput.input);
    return {
      operation: submitted.operation,
      created: submitted.created,
      conflicted: !submitted.created && !sameInput,
    };
  }
  const enqueueJson = (settings: StoreShape["settings"]) => {
    const existing = (settings.billingOperations ?? []).find(
      (operation) =>
        operation.kind === operationInput.kind &&
        !isTerminalBillingOperationStatus(operation.status),
    );
    if (existing) {
      const sameInput =
        existing.dryRun === operationInput.dryRun &&
        sameBillingOperationInput(existing.input, operationInput.input);
      return { operation: existing, created: false, conflicted: !sameInput };
    }
    return {
      operation: upsertBillingOperation(settings, {
        ...operationInput,
        status: "pending",
        summary: {},
      }),
      created: true,
      conflicted: false,
    };
  };
  if (!requireRootActor) return mutateBillingOperations(enqueueJson);
  return withAdminScopeUserLocks([operationInput.operatedByFeishuUserId], () =>
    mutate(async (store) => {
      const actor = store.users.find(
        (user) => user.id === operationInput.operatedByFeishuUserId,
      );
      const actorScope = actor
        ? await resolveAdminScopeForKnownUser(actor, store)
        : null;
      if (
        !actorScope ||
        actorScope.scopeType !== "global" ||
        actorScope.source !== "environment" ||
        actorScope.role !== "root"
      ) {
        throw new AdminUserActionAuthorizationError(
          "root_required",
          403,
          "该维护操作仅允许 root 执行",
        );
      }
      return enqueueJson(store.settings);
    }),
  );
}

async function assertJsonDepartmentMemberSyncScope(
  store: StoreShape,
  input: { actorFeishuUserId: string; departmentId: string },
) {
  const actor = store.users.find((user) => user.id === input.actorFeishuUserId);
  const actorScope = actor
    ? await resolveAdminScopeForKnownUser(actor, store)
    : null;
  if (!actor || actor.status !== "active" || !actorScope) {
    throw new AdminUserActionAuthorizationError(
      "actor_scope_missing",
      403,
      "当前管理员用户或管理范围已变化，同步任务已安全停止",
    );
  }
  if (
    actorScope.scopeType === "department" &&
    actorScope.departmentId !== input.departmentId
  ) {
    throw new AdminUserActionAuthorizationError(
      "target_out_of_scope",
      403,
      "当前管理员已无权同步该部门",
    );
  }
  const departmentPresent =
    store.users.some((user) => user.departmentId === input.departmentId) ||
    store.departmentQuotaPeriods.some(
      (period) => period.departmentId === input.departmentId,
    );
  if (!departmentPresent) {
    throw new AdminUserActionAuthorizationError(
      "target_out_of_scope",
      403,
      "目标部门已不存在或不在 TokenInside 管理范围内",
    );
  }
  return { actor, actorScope };
}

export async function enqueueDepartmentMemberSyncOperationAsActor(input: {
  actorFeishuUserId: string;
  departmentId: string;
}) {
  const now = nowIso();
  const operation: BillingOperationRecord = {
    id: randomId("bo"),
    kind: "department_member_sync",
    status: "pending",
    dryRun: false,
    operatedByFeishuUserId: input.actorFeishuUserId,
    input: {
      departmentId: input.departmentId,
    },
    summary: {},
    createdAt: now,
    updatedAt: now,
  };
  if (isPostgresBackend()) {
    const submitted = await enqueuePostgresDepartmentMemberSyncOperationAsActor(
      operation,
    );
    return {
      operation: submitted.operation,
      created: submitted.created,
      conflicted:
        !submitted.created &&
        !sameBillingOperationInput(submitted.operation.input, operation.input),
    };
  }
  return withAdminScopeUserLocks([input.actorFeishuUserId], () =>
    withJsonDepartmentQuotaLock(
      `department-member-sync-submit:${input.departmentId}`,
      () =>
        mutate(async (store) => {
          await assertJsonDepartmentMemberSyncScope(store, input);
          const existing = (store.settings.billingOperations ?? []).find(
            (candidate) =>
              candidate.kind === "department_member_sync" &&
              candidate.input?.departmentId === input.departmentId &&
              !isTerminalBillingOperationStatus(candidate.status),
          );
          if (existing) {
            return {
              operation: existing,
              created: false,
              conflicted: !sameBillingOperationInput(existing.input, operation.input),
            };
          }
          return {
            operation: upsertBillingOperation(store.settings, {
              ...operation,
              status: "pending",
              summary: {},
            }),
            created: true,
            conflicted: false,
          };
        }),
    ),
  );
}

function runningJsonDepartmentMemberSyncOperation(
  store: StoreShape,
  input: { operationId: string; leaseId: string },
) {
  const operation = (store.settings.billingOperations ?? []).find(
    (candidate) => candidate.id === input.operationId,
  );
  const departmentId = String(operation?.input?.departmentId ?? "");
  if (
    !operation ||
    operation.kind !== "department_member_sync" ||
    operation.status !== "running" ||
    operation.leaseId !== input.leaseId ||
    !operation.leaseExpiresAt ||
    new Date(operation.leaseExpiresAt).getTime() <= Date.now() ||
    !departmentId
  ) {
    throw new Error(`department member sync lease lost: ${input.operationId}`);
  }
  return { operation, departmentId };
}

export async function assertDepartmentMemberSyncExecutionAuthorized(input: {
  operationId: string;
  leaseId: string;
}) {
  if (isPostgresBackend()) {
    return assertPostgresDepartmentMemberSyncExecutionAuthorized(input);
  }
  return mutate(async (store) => {
    const running = runningJsonDepartmentMemberSyncOperation(store, input);
    await assertJsonDepartmentMemberSyncScope(store, {
      actorFeishuUserId: running.operation.operatedByFeishuUserId,
      departmentId: running.departmentId,
    });
    return running;
  });
}

export async function batchUpsertDepartmentMembersForSync(input: {
  operationId: string;
  leaseId: string;
  tenantKey: string;
  departmentName?: string;
  contacts: Array<{
    openId: string;
    unionId?: string;
    feishuUserIdFromFeishu?: string;
    name?: string;
    avatarUrl?: string;
  }>;
}) {
  if (input.contacts.length > 50) {
    throw new Error("单批部门成员导入不得超过 50 人");
  }
  const contacts = input.contacts.map((contact) => ({
    ...contact,
    id: randomId("fu"),
  }));
  if (isPostgresBackend()) {
    return batchUpsertPostgresDepartmentMembersForSync({
      ...input,
      contacts,
      now: nowIso(),
    });
  }
  return mutate(async (store) => {
    const running = runningJsonDepartmentMemberSyncOperation(store, input);
    await assertJsonDepartmentMemberSyncScope(store, {
      actorFeishuUserId: running.operation.operatedByFeishuUserId,
      departmentId: running.departmentId,
    });
    const now = nowIso();
    let synced = 0;
    let skipped = 0;
    for (const contact of contacts) {
      const existing = store.users.find(
        (user) => user.tenantKey === input.tenantKey && user.openId === contact.openId,
      );
      if (existing?.departmentId && existing.departmentId !== running.departmentId) {
        skipped += 1;
        continue;
      }
      if (existing) {
        Object.assign(existing, {
          unionId: contact.unionId ?? existing.unionId,
          feishuUserIdFromFeishu:
            contact.feishuUserIdFromFeishu ?? existing.feishuUserIdFromFeishu,
          name: contact.name ?? existing.name,
          avatarUrl: contact.avatarUrl ?? existing.avatarUrl,
          departmentId: running.departmentId,
          departmentName: input.departmentName ?? existing.departmentName,
          updatedAt: now,
        });
      } else {
        store.users.push({
          id: contact.id,
          tenantKey: input.tenantKey,
          openId: contact.openId,
          unionId: contact.unionId,
          feishuUserIdFromFeishu: contact.feishuUserIdFromFeishu,
          name: contact.name,
          avatarUrl: contact.avatarUrl,
          departmentId: running.departmentId,
          departmentName: input.departmentName,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
      }
      synced += 1;
    }
    return { synced, skipped };
  });
}

export async function listDepartmentMemberSyncOperations(input: {
  departmentId?: string;
  limit?: number;
}) {
  if (isPostgresBackend()) {
    return listPostgresDepartmentMemberSyncOperations(input);
  }
  const store = await readStore();
  return (store.settings.billingOperations ?? [])
    .filter(
      (operation) =>
        operation.kind === "department_member_sync" &&
        (!input.departmentId || operation.input?.departmentId === input.departmentId),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
    .slice(0, Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), 100));
}

export function withDepartmentMemberSyncWorkerFence<T>(fn: () => Promise<T>) {
  const key = "department-member-sync-worker";
  if (isPostgresBackend()) {
    return withPostgresAdvisoryLock(key, fn, { wait: false });
  }
  return withJsonDepartmentQuotaLock(key, fn);
}

export function withPackageResetSchedulerFence<T>(fn: () => Promise<T>) {
  const key = "package-reset-scheduler";
  if (isPostgresBackend()) {
    return withPostgresAdvisoryLock(key, fn, { wait: false });
  }
  return withJsonDepartmentQuotaLock(key, fn);
}

export async function updateAppSettings(input: {
  defaultMonthlyQuota?: number;
  newapiControl?: StoreShape["settings"]["newapiControl"];
  usageSyncPolicy?: Partial<UsageSyncPolicy>;
  packageReset?: StoreShape["settings"]["packageReset"];
  updatedByFeishuUserId: string;
}) {
  if (isPostgresBackend()) {
    return mutatePostgresAppSettings((settings) => {
      const previousDefaultMonthlyQuota = settings.defaultMonthlyQuota;
      const previousUsageSyncPolicy = normalizeUsageSyncPolicy(settings.usageSyncPolicy);
      const nextDefaultMonthlyQuota =
        input.defaultMonthlyQuota ?? settings.defaultMonthlyQuota;
      const nextUsageSyncPolicy = input.usageSyncPolicy
        ? normalizeUsageSyncPolicy({
            ...previousUsageSyncPolicy,
            ...input.usageSyncPolicy,
            updatedAt: nowIso(),
            updatedByFeishuUserId: input.updatedByFeishuUserId,
          })
        : previousUsageSyncPolicy;
      const now = nowIso();
      const nextSettings = {
        ...settings,
        defaultMonthlyQuota: nextDefaultMonthlyQuota,
        newapiControl: input.newapiControl ?? settings.newapiControl,
        usageSyncPolicy: nextUsageSyncPolicy,
        packageReset: input.packageReset
          ? normalizePackageResetPolicy({
              ...input.packageReset,
              updatedAt: now,
              updatedByFeishuUserId: input.updatedByFeishuUserId,
            })
          : normalizePackageResetPolicy(settings.packageReset),
        updatedAt: now,
        updatedByFeishuUserId: input.updatedByFeishuUserId,
      };
      delete (nextSettings as typeof nextSettings & { billingOperations?: unknown })
        .billingOperations;
      Object.assign(settings, nextSettings);
      return nextSettings;
    });
  }

  return mutate((store) => {
    const previousDefaultMonthlyQuota = store.settings.defaultMonthlyQuota;
    const previousUsageSyncPolicy = normalizeUsageSyncPolicy(store.settings.usageSyncPolicy);
    const nextDefaultMonthlyQuota = input.defaultMonthlyQuota ?? store.settings.defaultMonthlyQuota;
    const nextUsageSyncPolicy = input.usageSyncPolicy
      ? normalizeUsageSyncPolicy({
          ...previousUsageSyncPolicy,
          ...input.usageSyncPolicy,
          updatedAt: nowIso(),
          updatedByFeishuUserId: input.updatedByFeishuUserId,
        })
      : previousUsageSyncPolicy;
    store.settings = {
      ...store.settings,
      defaultMonthlyQuota: nextDefaultMonthlyQuota,
      newapiControl: input.newapiControl ?? store.settings.newapiControl,
      usageSyncPolicy: nextUsageSyncPolicy,
      packageReset: input.packageReset
        ? normalizePackageResetPolicy({
            ...input.packageReset,
            updatedAt: nowIso(),
            updatedByFeishuUserId: input.updatedByFeishuUserId,
          })
        : normalizePackageResetPolicy(store.settings.packageReset),
      updatedAt: nowIso(),
      updatedByFeishuUserId: input.updatedByFeishuUserId,
    };
    return store.settings;
  });
}

export async function updateAppSettingsAsActor(input: {
  actorFeishuUserId: string;
  defaultMonthlyQuota?: number;
  newapiControl?: StoreShape["settings"]["newapiControl"];
  packageReset?: StoreShape["settings"]["packageReset"];
}) {
  if (isPostgresBackend()) return updatePostgresAppSettingsAsActor(input);

  return withAdminScopeUserLocks([input.actorFeishuUserId], () =>
    mutate(async (store) => {
      const actor = store.users.find(
        (user) => user.id === input.actorFeishuUserId,
      );
      const actorScope = actor
        ? await resolveAdminScopeForKnownUser(actor, store)
        : null;
      if (!actorScope || actorScope.scopeType !== "global") {
        throw new AdminUserActionAuthorizationError(
          "actor_scope_missing",
          403,
          "当前全局管理员权限已变化，请刷新后重试",
        );
      }
      if (
        input.newapiControl &&
        !(actorScope.source === "environment" && actorScope.role === "root")
      ) {
        throw new AdminUserActionAuthorizationError(
          "root_required",
          403,
          "NewAPI 上游连接只能由 root 管理员修改",
        );
      }
      const now = nowIso();
      let newapiControl = store.settings.newapiControl;
      if (input.newapiControl) {
        const accessTokenCiphertext =
          input.newapiControl.accessTokenCiphertext ??
          store.settings.newapiControl?.accessTokenCiphertext;
        if (!accessTokenCiphertext) {
          const error = new Error("首次保存 NewAPI 上游连接时必须填写用户 AK");
          error.name = "NewApiControlSecretRequiredError";
          throw error;
        }
        newapiControl = {
          ...input.newapiControl,
          accessTokenCiphertext,
          updatedAt: now,
          updatedByFeishuUserId: input.actorFeishuUserId,
        };
      }
      store.settings = {
        ...store.settings,
        defaultMonthlyQuota:
          input.defaultMonthlyQuota ?? store.settings.defaultMonthlyQuota,
        newapiControl,
        packageReset: input.packageReset
          ? normalizePackageResetPolicy({
              ...input.packageReset,
              updatedAt: now,
              updatedByFeishuUserId: input.actorFeishuUserId,
            })
          : normalizePackageResetPolicy(store.settings.packageReset),
        updatedAt: now,
        updatedByFeishuUserId: input.actorFeishuUserId,
      };
      return store.settings;
    }),
  );
}

export async function recordBillingOperation(input: {
  id?: string;
  expectedLeaseId?: string;
  kind: BillingOperationKind;
  status: BillingOperationStatus;
  dryRun: boolean;
  operatedByFeishuUserId: string;
  period?: string;
  input?: Record<string, unknown>;
  summary: BillingOperationRecord["summary"];
  errorMessage?: string;
}) {
  if (isPostgresBackend()) return recordPostgresBillingOperation(input);
  const { expectedLeaseId, ...write } = input;
  return mutateBillingOperations((settings) => {
    if (expectedLeaseId) {
      const current = (settings.billingOperations ?? []).find(
        (operation) => operation.id === input.id,
      );
      if (
        !current ||
        current.status !== "running" ||
        current.leaseId !== expectedLeaseId ||
        !current.leaseExpiresAt ||
        new Date(current.leaseExpiresAt).getTime() <= Date.now()
      ) {
        throw new Error(`billing operation lease lost: ${input.id ?? "unknown"}`);
      }
      if (!isTerminalBillingOperationStatus(input.status)) {
        throw new Error("billing operation completion requires a terminal status");
      }
      return upsertBillingOperation(settings, {
        id: current.id,
        kind: current.kind,
        status: input.status,
        dryRun: current.dryRun,
        operatedByFeishuUserId: current.operatedByFeishuUserId,
        period: current.period,
        input: current.input,
        summary: input.summary,
        errorMessage: input.errorMessage,
      });
    }
    if (input.id || !isTerminalBillingOperationStatus(input.status)) {
      throw new Error("billing operation records require a terminal status without an id");
    }
    return upsertBillingOperation(settings, write);
  });
}

export async function findBillingOperationById(operationId: string) {
  if (isPostgresBackend()) return findPostgresBillingOperationById(operationId);
  const settings = await getAppSettings();
  return (settings.billingOperations ?? []).find((item) => item.id === operationId) ?? null;
}

export async function listRunnableBillingOperations(input: {
  kind: BillingOperationKind;
  limit?: number;
  now?: Date;
}) {
  if (isPostgresBackend()) {
    return listPostgresRunnableBillingOperations({
      kind: input.kind,
      limit: input.limit,
      now: (input.now ?? new Date()).toISOString(),
    });
  }
  const settings = await getAppSettings();
  const now = input.now ?? new Date();
  return (settings.billingOperations ?? [])
    .filter(
      (operation) =>
        operation.kind === input.kind && canClaimBillingOperation(operation, now),
    )
    .slice(0, Math.max(input.limit ?? 1, 0));
}

export async function claimBillingOperationExecution(input: {
  operationId: string;
  kind: BillingOperationKind;
  leaseId: string;
  leaseExpiresAt: string;
  now?: Date;
}) {
  if (isPostgresBackend()) {
    return claimPostgresBillingOperationExecution({
      operationId: input.operationId,
      kind: input.kind,
      leaseId: input.leaseId,
      leaseExpiresAt: input.leaseExpiresAt,
    });
  }
  return mutateBillingOperations((settings) => {
    const records = settings.billingOperations ?? [];
    const operation = records.find((item) => item.id === input.operationId);
    const now = input.now ?? new Date();
    if (
      !operation ||
      operation.kind !== input.kind ||
      !canClaimBillingOperation(operation, now)
    ) {
      return null;
    }
    const claimed: BillingOperationRecord = {
      ...operation,
      status: "running",
      attemptCount: (operation.attemptCount ?? 0) + 1,
      leaseId: input.leaseId,
      leaseExpiresAt: input.leaseExpiresAt,
      startedAt: operation.startedAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    };
    settings.billingOperations = retainBillingOperationRecords(
      [claimed, ...records.filter((item) => item.id !== claimed.id)],
      maxBillingOperationRecords,
    );
    return claimed;
  });
}

export async function renewBillingOperationExecution(input: {
  operationId: string;
  leaseId: string;
  leaseExpiresAt: string;
}) {
  if (isPostgresBackend()) {
    return renewPostgresBillingOperationExecution(input);
  }
  return mutateBillingOperations((settings) => {
    const records = settings.billingOperations ?? [];
    const operation = records.find((item) => item.id === input.operationId);
    if (
      !operation ||
      operation.status !== "running" ||
      operation.leaseId !== input.leaseId
    ) {
      return null;
    }
    const renewed: BillingOperationRecord = {
      ...operation,
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: nowIso(),
    };
    settings.billingOperations = retainBillingOperationRecords(
      [renewed, ...records.filter((item) => item.id !== renewed.id)],
      maxBillingOperationRecords,
    );
    return renewed;
  });
}

export async function listBillingOperations(limit = 20) {
  if (isPostgresBackend()) return listPostgresBillingOperations(limit);
  const store = await readStore();
  return (store.settings.billingOperations ?? []).slice(0, Math.max(limit, 0));
}

export async function getUsageSyncCheckpoint(scope: UsageSyncCheckpoint["scope"] = "newapi_usage_logs") {
  if (isPostgresBackend()) return getPostgresUsageSyncCheckpoint(scope);
  const store = await readStore();
  return store.usageSyncCheckpoints.find((checkpoint) => checkpoint.scope === scope) ?? null;
}

export async function saveUsageSyncCheckpoint(
  checkpoint: Omit<UsageSyncCheckpoint, "id" | "updatedAt"> &
    Partial<Pick<UsageSyncCheckpoint, "id" | "updatedAt">>,
) {
  const stored: UsageSyncCheckpoint = {
    ...checkpoint,
    id: checkpoint.id ?? `usc_${checkpoint.scope}`,
    updatedAt: checkpoint.updatedAt ?? nowIso(),
  };
  if (isPostgresBackend()) return upsertPostgresUsageSyncCheckpoint(stored);

  return mutate((store) => {
    const index = store.usageSyncCheckpoints.findIndex((item) => item.scope === stored.scope);
    if (index === -1) {
      store.usageSyncCheckpoints.push(stored);
    } else {
      store.usageSyncCheckpoints[index] = {
        ...store.usageSyncCheckpoints[index],
        ...stored,
        id: store.usageSyncCheckpoints[index].id,
        updatedAt: stored.updatedAt,
      };
    }
    return store.usageSyncCheckpoints.find((item) => item.scope === stored.scope) ?? stored;
  });
}

export async function upsertFeishuUser(input: {
  tenantKey: string;
  openId: string;
  unionId?: string;
  feishuUserIdFromFeishu?: string;
  name?: string;
  avatarUrl?: string;
  departmentId?: string;
  departmentName?: string;
}) {
  if (isPostgresBackend()) {
    return upsertPostgresFeishuUser({
      ...input,
      id: randomId("fu"),
      now: nowIso(),
    });
  }

  return mutate((store) => {
    const existing = store.users.find(
      (user) => user.tenantKey === input.tenantKey && user.openId === input.openId,
    );
    const now = nowIso();
    if (existing) {
      Object.assign(existing, {
        unionId: input.unionId ?? existing.unionId,
        feishuUserIdFromFeishu:
          input.feishuUserIdFromFeishu ?? existing.feishuUserIdFromFeishu,
        name: input.name ?? existing.name,
        avatarUrl: input.avatarUrl ?? existing.avatarUrl,
        departmentId: input.departmentId ?? existing.departmentId,
        departmentName: input.departmentName ?? existing.departmentName,
        updatedAt: now,
      });
      return existing;
    }

    const user: FeishuUser = {
      id: randomId("fu"),
      tenantKey: input.tenantKey,
      openId: input.openId,
      unionId: input.unionId,
      feishuUserIdFromFeishu: input.feishuUserIdFromFeishu,
      name: input.name,
      avatarUrl: input.avatarUrl,
      departmentId: input.departmentId,
      departmentName: input.departmentName,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    store.users.push(user);
    return user;
  });
}

export async function getUserById(id: string) {
  if (isPostgresBackend()) return getPostgresUserById(id);
  const store = await readStore();
  return store.users.find((user) => user.id === id) ?? null;
}

export async function getUserByOpenId(openId: string) {
  if (isPostgresBackend()) return getPostgresUserByOpenId(openId);
  const store = await readStore();
  return store.users.find((user) => user.openId === openId) ?? null;
}

export async function getEarliestOpenBlockingUsageIssue() {
  if (isPostgresBackend()) {
    return getPostgresEarliestOpenBlockingUsageIssue();
  }
  const store = await readStore();
  return (
    store.usageSyncIssues
      .filter((issue) => issue.status === "open" && issue.blocksSettlement)
      .sort((left, right) =>
        (left.occurredAt ?? left.firstSeenAt).localeCompare(
          right.occurredAt ?? right.firstSeenAt,
        ),
      )[0] ?? null
  );
}

export async function createTokenRequest(input: {
  feishuUserId: string;
  requestType?: TokenRequest["requestType"];
  reason: string;
  requestedMonthlyQuota: number;
  approvedMonthlyQuota?: number;
  approvalCode?: string;
  approvalDepartmentId?: string;
  approvalMode?: TokenRequest["approvalMode"];
  approvalTargetOpenId?: string;
  approvalTargetSource?: TokenRequest["approvalTargetSource"];
  approvalActionNonceHash?: string;
  approvalOperatorOpenId?: string;
  approvalOperatedAt?: string;
  status?: TokenRequest["status"];
}) {
  if (isPostgresBackend()) {
    const now = nowIso();
    const requestType = input.requestType ?? "first_apply";
    const request: TokenRequest = {
      id: randomId("tr"),
      feishuUserId: input.feishuUserId,
      requestType,
      status: input.status ?? "pending_feishu_approval",
      reason: input.reason,
      requestedMonthlyQuota: input.requestedMonthlyQuota,
      approvedMonthlyQuota: input.approvedMonthlyQuota,
      approvalCode: input.approvalCode,
      approvalUuid: randomId("approval"),
      approvalDepartmentId: input.approvalDepartmentId,
      approvalMode: input.approvalMode,
      approvalTargetOpenId: input.approvalTargetOpenId,
      approvalTargetSource: input.approvalTargetSource,
      approvalActionNonceHash: input.approvalActionNonceHash,
      approvalOperatorOpenId: input.approvalOperatorOpenId,
      approvalOperatedAt: input.approvalOperatedAt,
      createdAt: now,
      updatedAt: now,
    };
    return insertPostgresTokenRequest(request);
  }

  return mutate((store) => {
    const now = nowIso();
    const requestType = input.requestType ?? "first_apply";
    const request: TokenRequest = {
      id: randomId("tr"),
      feishuUserId: input.feishuUserId,
      requestType,
      status: input.status ?? "pending_feishu_approval",
      reason: input.reason,
      requestedMonthlyQuota: input.requestedMonthlyQuota,
      approvedMonthlyQuota: input.approvedMonthlyQuota,
      approvalCode: input.approvalCode,
      approvalUuid: randomId("approval"),
      approvalDepartmentId: input.approvalDepartmentId,
      approvalMode: input.approvalMode,
      approvalTargetOpenId: input.approvalTargetOpenId,
      approvalTargetSource: input.approvalTargetSource,
      approvalActionNonceHash: input.approvalActionNonceHash,
      approvalOperatorOpenId: input.approvalOperatorOpenId,
      approvalOperatedAt: input.approvalOperatedAt,
      createdAt: now,
      updatedAt: now,
    };
    store.tokenRequests.push(request);
    if (requestType === "first_apply") {
      const user = store.users.find((item) => item.id === input.feishuUserId);
      if (user?.status === "deleted") {
        user.status = "active";
        user.deletedAt = undefined;
        user.deletedReason = undefined;
        user.updatedAt = now;
      }
    }
    return request;
  });
}

export async function updateTokenRequest(
  id: string,
  patch: Partial<Omit<TokenRequest, "id" | "createdAt">>,
) {
  if (isPostgresBackend()) return updatePostgresTokenRequest(id, patch);

  return mutate((store) => {
    const request = store.tokenRequests.find((item) => item.id === id);
    if (!request) return null;
    Object.assign(request, patch, { updatedAt: nowIso() });
    return request;
  });
}

export async function updateTokenRequestForQuotaOperation(
  id: string,
  patch: Partial<Omit<TokenRequest, "id" | "createdAt">>,
) {
  if (isPostgresBackend()) return updatePostgresTokenRequestForQuotaOperation(id, patch);
  return updateTokenRequest(id, patch);
}

export async function updateTokenRequestAfterQuotaMaterialization(
  id: string,
  patch: Partial<Omit<TokenRequest, "id" | "createdAt">>,
) {
  if (isPostgresBackend()) {
    return transitionPostgresTokenRequestAfterQuotaMaterialization(id, patch);
  }
  return updateTokenRequest(id, patch);
}

export async function transitionTokenRequestStatus(
  id: string,
  patch: Partial<Omit<TokenRequest, "id" | "createdAt">>,
  allowedStatuses: RequestStatus[],
) {
  if (isPostgresBackend()) {
    return transitionPostgresTokenRequest(id, patch, allowedStatuses);
  }

  return mutate((store) => {
    const request = store.tokenRequests.find((item) => item.id === id);
    if (!request || !allowedStatuses.includes(request.status)) return null;
    Object.assign(request, patch, { updatedAt: nowIso() });
    return request;
  });
}

export async function invalidateOtherOpenFirstApplyRequests(input: {
  feishuUserId: string;
  approvedRequestId: string;
  approvalOperatorOpenId?: string;
  approvalOperatedAt?: string;
}) {
  if (isPostgresBackend()) {
    return invalidatePostgresOpenFirstApplyRequests({
      ...input,
      statuses: [...invalidatableFirstApplyStatuses],
    });
  }

  return mutate((store) => {
    const now = nowIso();
    const invalidated: TokenRequest[] = [];
    for (const request of store.tokenRequests) {
      if (
        request.feishuUserId !== input.feishuUserId ||
        request.id === input.approvedRequestId ||
        request.requestType !== "first_apply" ||
        !invalidatableFirstApplyStatuses.has(request.status)
      ) {
        continue;
      }

      request.status = "invalidated";
      request.errorMessage = undefined;
      request.approvalOperatorOpenId =
        request.approvalOperatorOpenId ?? input.approvalOperatorOpenId;
      request.approvalOperatedAt =
        request.approvalOperatedAt ?? input.approvalOperatedAt ?? now;
      request.updatedAt = now;
      invalidated.push(request);
    }
    return invalidated;
  });
}

export async function findTokenRequestByInstance(instanceCode: string) {
  const store = await readStore();
  return (
    store.tokenRequests.find((request) => request.approvalInstanceCode === instanceCode) ??
    null
  );
}

export async function findTokenRequestById(id: string) {
  if (isPostgresBackend()) return getPostgresTokenRequestById(id);
  const store = await readStore();
  return store.tokenRequests.find((request) => request.id === id) ?? null;
}

export async function listUserTokenRequests(feishuUserId: string) {
  if (isPostgresBackend()) return listPostgresTokenRequestsForUser(feishuUserId);
  const store = await readStore();
  return store.tokenRequests
    .filter((request) => request.feishuUserId === feishuUserId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getActiveTokenForUser(feishuUserId: string) {
  if (isPostgresBackend()) return getPostgresActiveTokenForUser(feishuUserId);

  const store = await readStore();
  return (
    store.tokenAccounts.find(
      (account) => account.feishuUserId === feishuUserId && account.status === "active",
    ) ?? null
  );
}

export async function getDisabledTokenForUser(feishuUserId: string) {
  if (isPostgresBackend()) return getPostgresDisabledTokenForUser(feishuUserId);

  const store = await readStore();
  return (
    [...store.tokenAccounts]
      .filter((account) => account.feishuUserId === feishuUserId && account.status === "disabled")
      .sort((a, b) => (b.disabledAt ?? b.createdAt).localeCompare(a.disabledAt ?? a.createdAt))[0] ??
    null
  );
}

export async function listTokenAccountsForUser(feishuUserId: string) {
  if (isPostgresBackend()) {
    return listPostgresTokenAccountsForUser(feishuUserId);
  }
  const store = await readStore();
  return store.tokenAccounts.filter((account) => account.feishuUserId === feishuUserId);
}

export async function listActiveTokenAccounts() {
  const store = await readStore();
  const usersById = new Map(store.users.map((user) => [user.id, user]));
  return store.tokenAccounts
    .filter((account) => account.status === "active")
    .map((account) => ({
      account,
      user: usersById.get(account.feishuUserId) ?? null,
    }));
}

export async function getUserBillingPeriod(feishuUserId: string, period: string) {
  if (isPostgresBackend()) {
    return getPostgresUserBillingPeriod(feishuUserId, period);
  }
  const store = await readStore();
  return (
    store.userBillingPeriods.find(
      (item) => item.feishuUserId === feishuUserId && item.period === period,
    ) ?? null
  );
}

const jsonDepartmentQuotaLocks = new Map<string, Promise<void>>();

async function withJsonDepartmentQuotaLock<T>(key: string, fn: () => Promise<T>) {
  const previous = jsonDepartmentQuotaLocks.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(fn);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  jsonDepartmentQuotaLocks.set(key, tail);
  try {
    return await result;
  } finally {
    if (jsonDepartmentQuotaLocks.get(key) === tail) jsonDepartmentQuotaLocks.delete(key);
  }
}

function withJsonQuotaLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const [key, ...remaining] = keys;
  if (!key) return fn();
  return withJsonDepartmentQuotaLock(key, () => withJsonQuotaLocks(remaining, fn));
}

function withDepartmentQuotaLock<T>(
  departmentId: string,
  period: string,
  fn: () => Promise<T>,
) {
  const key = `department-quota:${departmentId}:${period}`;
  if (isPostgresBackend()) {
    return withPostgresAdvisoryLock(key, fn, { wait: true });
  }
  return withJsonDepartmentQuotaLock(key, fn);
}

export async function updateTokenAccount(
  accountId: string,
  patch: Partial<TokenAccount>,
  allowedStatuses?: TokenStatus[],
) {
  if (isPostgresBackend()) {
    return updatePostgresTokenAccount(accountId, patch, allowedStatuses);
  }
  return mutate((store) => {
    const account = store.tokenAccounts.find((item) => item.id === accountId);
    if (!account || (allowedStatuses && !allowedStatuses.includes(account.status))) return null;
    Object.assign(account, patch, {
      id: account.id,
      feishuUserId: account.feishuUserId,
      keyHash: account.keyHash,
    });
    return account;
  });
}

export async function updateTokenAccountForQuotaOperation(
  accountId: string,
  patch: Partial<TokenAccount>,
  allowedStatuses?: TokenStatus[],
) {
  if (isPostgresBackend()) {
    return updatePostgresTokenAccountForQuotaOperation(accountId, patch, allowedStatuses);
  }
  return updateTokenAccount(accountId, patch, allowedStatuses);
}

export function withUserQuotaOperationLock<T>(
  feishuUserId: string,
  fn: (fence?: QuotaExecutionFence) => Promise<T>,
  options: { wait?: boolean } = {},
) {
  // This session-level fence is intentionally distinct from the short
  // transaction lock used by user_quota_states. Reusing the same advisory key
  // across two pooled connections would make the outer callback wait on itself.
  const key = `user-quota-fence:${feishuUserId}`;
  if (isPostgresBackend()) {
    return withPostgresAdvisoryLock(key, fn, {
      wait: options.wait ?? true,
      executionFence: true,
    });
  }
  if (options.wait === false && jsonDepartmentQuotaLocks.has(key)) {
    const error = new Error(`额度操作执行栅栏正忙: ${key}`);
    error.name = "QuotaOperationFenceBusyError";
    throw error;
  }
  return withJsonDepartmentQuotaLock(key, fn);
}

export async function getEffectiveUserQuotaPolicy(
  feishuUserId: string,
  period?: string,
) {
  period ??= await getCurrentPackageBillingPeriod();
  if (isPostgresBackend()) {
    return getPostgresEffectiveUserQuotaPolicy(feishuUserId, period);
  }
  const store = await readStore();
  return (
    store.userQuotaPolicies
      .filter(
        (policy) =>
          policy.feishuUserId === feishuUserId &&
          policy.effectiveFromPeriod <= period &&
          (!policy.effectiveToPeriod || policy.effectiveToPeriod >= period),
      )
      .sort((a, b) => b.version - a.version)[0] ?? null
  );
}

export async function createUserQuotaPolicyVersion(input: {
  feishuUserId: string;
  assignedMonthlyQuota: number;
  departmentId?: string;
  effectiveFromPeriod?: string;
  sourceType: UserQuotaPolicy["sourceType"];
  sourceId: string;
  updatedByOpenId?: string;
}) {
  const period =
    input.effectiveFromPeriod ?? (await getCurrentPackageBillingPeriod());
  const assignedMonthlyQuota = Math.max(Math.trunc(input.assignedMonthlyQuota), 0);
  if (isPostgresBackend()) {
    return createPostgresUserQuotaPolicyVersion({
      ...input,
      assignedMonthlyQuota,
      effectiveFromPeriod: period,
      quotaPerUnitSnapshot: getConfig().newapi.quotaPerUnit,
    });
  }
  const store = await readStore();
  const idempotent = store.userQuotaPolicies.find(
    (item) => item.sourceType === input.sourceType && item.sourceId === input.sourceId,
  );
  if (idempotent) return idempotent;
  const previous = store.userQuotaPolicies
    .filter((item) => item.feishuUserId === input.feishuUserId)
    .sort((a, b) => b.version - a.version)[0];
  const now = nowIso();
  const policy: UserQuotaPolicy = {
    id: randomId("uqp"),
    feishuUserId: input.feishuUserId,
    assignedMonthlyQuota,
    departmentId: input.departmentId,
    effectiveFromPeriod: period,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    version: (previous?.version ?? 0) + 1,
    quotaPerUnitSnapshot: getConfig().newapi.quotaPerUnit,
    createdAt: now,
    updatedAt: now,
    updatedByOpenId: input.updatedByOpenId,
  };
  return mutate((current) => {
    const existing = current.userQuotaPolicies.find(
      (item) => item.sourceType === policy.sourceType && item.sourceId === policy.sourceId,
    );
    if (existing) return existing;
    current.userQuotaPolicies.push(policy);
    return policy;
  });
}

export async function getUserQuotaState(feishuUserId: string) {
  if (isPostgresBackend()) return getPostgresUserQuotaState(feishuUserId);
  const store = await readStore();
  return (
    store.userQuotaStates.find((item) => item.feishuUserId === feishuUserId) ?? {
      feishuUserId,
      admission: "open" as const,
      activeGeneration: Math.max(
        0,
        ...store.tokenAccounts
          .filter((item) => item.feishuUserId === feishuUserId)
          .map((item) => item.operationGeneration ?? 0),
      ),
      updatedAt: nowIso(),
    }
  );
}

export async function saveUserQuotaState(state: UserQuotaState) {
  if (isPostgresBackend()) return upsertPostgresUserQuotaState(state);
  return mutate((store) => {
    const index = store.userQuotaStates.findIndex(
      (item) => item.feishuUserId === state.feishuUserId,
    );
    if (index === -1) store.userQuotaStates.push(state);
    else store.userQuotaStates[index] = state;
    return state;
  });
}

export class JsonQuotaSubmissionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JsonQuotaSubmissionError";
  }
}

export async function updateJsonTokenRequestQuotaAsActor(input: {
  actorUserId: string;
  requestId: string;
  approvedMonthlyQuota: number;
}) {
  if (isPostgresBackend()) {
    throw new JsonQuotaSubmissionError(
      500,
      "json_submission_backend_mismatch",
      "JSON 申请额度更新不能用于 PostgreSQL 后端",
    );
  }
  if (
    !Number.isInteger(input.approvedMonthlyQuota) ||
    input.approvedMonthlyQuota <= 0 ||
    input.approvedMonthlyQuota > 1_000_000
  ) {
    throw new JsonQuotaSubmissionError(400, "quota_invalid", "最终额度必须是正整数");
  }
  const snapshot = await readStore();
  const targetUserId = snapshot.tokenRequests.find(
    (request) => request.id === input.requestId,
  )?.feishuUserId;
  if (!targetUserId) {
    throw new JsonQuotaSubmissionError(
      404,
      "token_request_not_found",
      "申请单不存在或不在当前管理范围内",
    );
  }
  return withAdminScopeUserLocks([input.actorUserId, targetUserId], () =>
    withUserQuotaOperationLock(targetUserId, () =>
      mutate(async (store) => {
        const request = store.tokenRequests.find(
          (item) => item.id === input.requestId,
        );
        const actor = store.users.find((user) => user.id === input.actorUserId);
        const actorScope = actor
          ? await resolveAdminScopeForKnownUser(actor, store)
          : null;
        if (!request || !actorScope) {
          throw new JsonQuotaSubmissionError(
            404,
            "token_request_not_found",
            "申请单不存在或不在当前管理范围内",
          );
        }
        const usersById = new Map(store.users.map((user) => [user.id, user]));
        if (
          !tokenRequestInScope(
            request,
            actorScope,
            usersById,
            globalAdminOpenIds(store, usersById),
          )
        ) {
          throw new JsonQuotaSubmissionError(
            404,
            "token_request_not_found",
            "申请单不存在或不在当前管理范围内",
          );
        }
        if (!tokenRequestAllowsQuotaEdit(request)) {
          throw new JsonQuotaSubmissionError(
            409,
            "token_request_quota_not_editable",
            "当前记录不是可修改额度的审批申请",
          );
        }
        if (
          store.quotaOperations.some(
            (operation) => operation.idempotencyKey === `quota-operation:${request.id}`,
          )
        ) {
          throw new JsonQuotaSubmissionError(
            409,
            "token_request_operation_exists",
            "额度操作已经受理，不能再修改申请额度",
          );
        }
        request.approvedMonthlyQuota = input.approvedMonthlyQuota;
        request.updatedAt = nowIso();
        return request;
      }),
    ),
  );
}

export async function rejectJsonTokenRequestAsActor(input: {
  actorUserId: string;
  requestId: string;
}) {
  if (isPostgresBackend()) {
    throw new JsonQuotaSubmissionError(
      500,
      "json_submission_backend_mismatch",
      "JSON 申请拒绝不能用于 PostgreSQL 后端",
    );
  }
  const snapshot = await readStore();
  const targetUserId = snapshot.tokenRequests.find(
    (request) => request.id === input.requestId,
  )?.feishuUserId;
  if (!targetUserId) {
    throw new JsonQuotaSubmissionError(
      404,
      "token_request_not_found",
      "申请单不存在或不在当前管理范围内",
    );
  }
  return withAdminScopeUserLocks([input.actorUserId, targetUserId], () =>
    withUserQuotaOperationLock(targetUserId, () =>
      mutate(async (store) => {
        const request = store.tokenRequests.find(
          (item) => item.id === input.requestId,
        );
        const actor = store.users.find((user) => user.id === input.actorUserId);
        const actorScope = actor
          ? await resolveAdminScopeForKnownUser(actor, store)
          : null;
        if (!request || !actor || !actorScope) {
          throw new JsonQuotaSubmissionError(
            404,
            "token_request_not_found",
            "申请单不存在或不在当前管理范围内",
          );
        }
        const usersById = new Map(store.users.map((user) => [user.id, user]));
        if (
          !tokenRequestInScope(
            request,
            actorScope,
            usersById,
            globalAdminOpenIds(store, usersById),
          )
        ) {
          throw new JsonQuotaSubmissionError(
            404,
            "token_request_not_found",
            "申请单不存在或不在当前管理范围内",
          );
        }
        if (!tokenRequestRequiresAdminDecision(request)) {
          throw new JsonQuotaSubmissionError(
            409,
            "token_request_not_actionable",
            "当前记录不是可人工处理的审批申请",
          );
        }
        if (
          store.quotaOperations.some(
            (operation) => operation.idempotencyKey === `quota-operation:${request.id}`,
          )
        ) {
          throw new JsonQuotaSubmissionError(
            409,
            "token_request_operation_exists",
            "额度操作已经受理，不能再拒绝该申请",
          );
        }
        const now = nowIso();
        request.status = "rejected";
        request.approvalOperatorOpenId = actor.openId;
        request.approvalOperatedAt = now;
        request.updatedAt = now;
        return request;
      }),
    ),
  );
}

/**
 * JSON-store fallback for administrator quota adjustment acceptance.
 *
 * The production greenfield backend is PostgreSQL, but the fallback preserves
 * the same all-or-nothing authorization/request/operation contract for local
 * development and tests.
 */
export async function submitJsonAdminQuotaAdjustment(input: {
  actorUserId: string;
  targetUserId: string;
  approvedMonthlyQuota: number;
  reason: string;
  clientRequestId: string;
}) {
  if (isPostgresBackend()) {
    throw new JsonQuotaSubmissionError(
      500,
      "json_submission_backend_mismatch",
      "JSON 调额提交不能用于 PostgreSQL 后端",
    );
  }
  if (!Number.isInteger(input.approvedMonthlyQuota) || input.approvedMonthlyQuota <= 0) {
    throw new JsonQuotaSubmissionError(400, "quota_invalid", "调额额度必须为正整数");
  }

  return withAdminScopeUserLocks(
    [input.actorUserId, input.targetUserId],
    () =>
      withUserQuotaOperationLock(input.targetUserId, () =>
        mutate(async (store) => {
          let authorized: Awaited<ReturnType<typeof authorizeJsonAdminUserAction>>;
          try {
            authorized = await authorizeJsonAdminUserAction(store, {
              actorFeishuUserId: input.actorUserId,
              targetFeishuUserId: input.targetUserId,
            });
          } catch (error) {
            if (error instanceof AdminUserActionAuthorizationError) {
              throw new JsonQuotaSubmissionError(
                error.status,
                error.code,
                error.message,
              );
            }
            throw error;
          }
          const targetUser = authorized?.targetUser;
          if (!targetUser) {
            throw new JsonQuotaSubmissionError(
              404,
              "target_user_not_found",
              "用户不存在或不在当前管理范围内",
            );
          }
          if (targetUser.status && targetUser.status !== "active") {
            throw new JsonQuotaSubmissionError(
              409,
              "target_user_inactive",
              "目标用户当前不是启用状态",
            );
          }
          const targetAdminScope = targetUser.departmentId
            ? null
            : await resolveAdminScopeForKnownUser(targetUser, store);
          if (!targetUser.departmentId && targetAdminScope?.scopeType !== "global") {
            throw new JsonQuotaSubmissionError(
              409,
              "target_department_missing",
              "目标用户必须先归属部门，或拥有有效的全局管理员身份",
            );
          }

          const idempotencyKey = `quota-adjust:${input.clientRequestId}`;
          const requestedAssignedQuota = Math.round(
            input.approvedMonthlyQuota * getConfig().newapi.quotaPerUnit,
          );
          const idempotent = store.quotaOperations.find(
            (operation) => operation.idempotencyKey === idempotencyKey,
          );
          if (idempotent) {
            if (
              idempotent.feishuUserId !== targetUser.id ||
              idempotent.operationType !== "quota_adjust" ||
              idempotent.requestedAssignedQuota !== requestedAssignedQuota
            ) {
              throw new JsonQuotaSubmissionError(
                409,
                "idempotency_conflict",
                "调额幂等键已被其他用户、操作或额度使用",
              );
            }
            const existingRequest = idempotent.requestId
              ? store.tokenRequests.find((request) => request.id === idempotent.requestId)
              : undefined;
            if (
              !existingRequest ||
              existingRequest.feishuUserId !== targetUser.id ||
              existingRequest.requestType !== "quota_adjust"
            ) {
              throw new JsonQuotaSubmissionError(
                409,
                "idempotency_conflict",
                "调额幂等操作缺少匹配申请记录",
              );
            }
            return {
              request: existingRequest,
              operation: idempotent,
              deduplicated: true,
            };
          }

          const openOperation = store.quotaOperations.find(
            (operation) =>
              operation.feishuUserId === targetUser.id &&
              !["completed", "compensated", "cancelled"].includes(operation.state),
          );
          if (openOperation) {
            throw new JsonQuotaSubmissionError(
              409,
              "quota_operation_open",
              `用户已有未完成额度操作: ${openOperation.id}`,
            );
          }
          const activeAccount = [...store.tokenAccounts]
            .filter(
              (account) =>
                account.feishuUserId === targetUser.id &&
                account.status === "active" &&
                Boolean(account.newapiTokenId),
            )
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
          if (!activeAccount?.newapiTokenId) {
            throw new JsonQuotaSubmissionError(
              409,
              "active_token_required",
              "目标用户没有可调额的 active NewAPI Key",
            );
          }

          const now = nowIso();
          const digest = sha256Hex(`${targetUser.id}:${input.clientRequestId}`).slice(0, 28);
          const actorUser = store.users.find((user) => user.id === input.actorUserId);
          if (!actorUser) {
            throw new JsonQuotaSubmissionError(
              403,
              "admin_scope_required",
              "当前管理员权限已变化，请刷新后重试",
            );
          }
          const request: TokenRequest = {
            id: `tr_admin_adjust_${digest}`,
            feishuUserId: targetUser.id,
            requestType: "quota_adjust",
            status: "approved_provisioning",
            reason: input.reason,
            requestedMonthlyQuota: input.approvedMonthlyQuota,
            approvedMonthlyQuota: input.approvedMonthlyQuota,
            approvalUuid: `approval_admin_adjust_${digest}`,
            approvalDepartmentId: targetUser.departmentId,
            approvalMode: "manual",
            approvalOperatorOpenId: actorUser.openId,
            approvalOperatedAt: now,
            createdAt: now,
            updatedAt: now,
          };
          const operationGeneration =
            Math.max(
              0,
              store.userQuotaStates.find(
                (state) => state.feishuUserId === targetUser.id,
              )?.activeGeneration ?? 0,
              ...store.tokenAccounts
                .filter((account) => account.feishuUserId === targetUser.id)
                .map((account) => account.operationGeneration ?? 0),
            ) + 1;
          const operation: QuotaOperation = {
            id: randomId("qo"),
            operationType: "quota_adjust",
            idempotencyKey,
            feishuUserId: targetUser.id,
            departmentId: targetUser.departmentId,
            billingPeriod: activeAccount.billingPeriod,
            requestedAssignedQuota,
            reservedDepartmentQuota: 0,
            operationGeneration,
            state: "planned",
            attemptCount: 0,
            upstreamTokenIdBefore: activeAccount.newapiTokenId,
            tokenAccountIdBefore: activeAccount.id,
            requestId: request.id,
            createdByOpenId: request.approvalOperatorOpenId,
            createdAt: now,
            updatedAt: now,
          };
          store.tokenRequests.push(request);
          store.quotaOperations.push(operation);
          return { request, operation, deduplicated: false };
        }),
      ),
  );
}

export async function createQuotaOperation(input: {
  operationType: QuotaOperation["operationType"];
  idempotencyKey: string;
  feishuUserId: string;
  departmentId?: string;
  billingPeriod?: string;
  requestedAssignedQuota?: number;
  assignedQuotaBefore?: number;
  observedRemainBefore?: number;
  targetRemainQuota?: number;
  reservedDepartmentQuota?: number;
  upstreamTokenIdBefore?: string;
  tokenAccountIdBefore?: string;
  requestId?: string;
  createdByOpenId?: string;
  evidence?: QuotaOperation["evidence"];
}) {
  const state = await getUserQuotaState(input.feishuUserId);
  const now = nowIso();
  const billingPeriod =
    input.billingPeriod ?? (await getCurrentPackageBillingPeriod());
  const operation: QuotaOperation = {
    id: randomId("qo"),
    operationType: input.operationType,
    idempotencyKey: input.idempotencyKey,
    feishuUserId: input.feishuUserId,
    departmentId: input.departmentId,
    billingPeriod,
    requestedAssignedQuota: input.requestedAssignedQuota,
    assignedQuotaBefore: input.assignedQuotaBefore,
    observedRemainBefore: input.observedRemainBefore,
    targetRemainQuota: input.targetRemainQuota,
    reservedDepartmentQuota: input.reservedDepartmentQuota ?? 0,
    operationGeneration: state.activeGeneration + 1,
    state: "planned",
    attemptCount: 0,
    upstreamTokenIdBefore: input.upstreamTokenIdBefore,
    tokenAccountIdBefore: input.tokenAccountIdBefore,
    requestId: input.requestId,
    evidence: input.evidence,
    createdByOpenId: input.createdByOpenId,
    createdAt: now,
    updatedAt: now,
  };
  if (isPostgresBackend()) return createPostgresQuotaOperation(operation);
  return withUserQuotaOperationLock(input.feishuUserId, () =>
    mutate((store) => {
      const user = store.users.find((item) => item.id === input.feishuUserId);
      if (!user || (user.status && user.status !== "active")) {
        throw new Error("额度操作目标用户已禁用、删除或不存在");
      }
      const idempotent = store.quotaOperations.find(
        (item) => item.idempotencyKey === input.idempotencyKey,
      );
      if (idempotent) return idempotent;
      const open = store.quotaOperations.find(
        (item) =>
          item.feishuUserId === input.feishuUserId &&
          item.state !== "completed" &&
          item.state !== "compensated" &&
          item.state !== "cancelled",
      );
      if (open) throw new Error(`用户已有未完成额度操作: ${open.id}`);
      store.quotaOperations.push(operation);
      return operation;
    }),
  );
}

export async function reopenJsonAdminDefaultProvisioningAfterAccessRevoke(input: {
  feishuUserId: string;
  billingPeriod: string;
  idempotencyKey: string;
}) {
  if (isPostgresBackend()) {
    throw new Error("JSON administrator provisioning reopen cannot run on PostgreSQL");
  }
  return withAdminScopeUserLocks([input.feishuUserId], () =>
    withUserQuotaOperationLock(input.feishuUserId, () =>
      mutate(async (store) => {
        const user = store.users.find((item) => item.id === input.feishuUserId);
        if (!user || (user.status && user.status !== "active")) return null;
        const currentScope = await resolveAdminScopeForKnownUser(user, store);
        if (!currentScope || currentScope.status !== "active") return null;
        if (
          store.tokenAccounts.some(
            (account) =>
              account.feishuUserId === user.id && account.status === "active",
          )
        ) {
          return null;
        }
        const operation = store.quotaOperations.find(
          (item) => item.idempotencyKey === input.idempotencyKey,
        );
        if (!operation || !canReopenFirstProvisionAfterAccessRevoke(operation)) {
          return null;
        }
        const conflicting = store.quotaOperations.find(
          (item) =>
            item.id !== operation.id &&
            item.feishuUserId === user.id &&
            !["completed", "compensated", "cancelled"].includes(item.state),
        );
        if (conflicting) return null;

        const departmentPeriod = store.departmentQuotaPeriods.find(
          (item) =>
            item.departmentId === user.departmentId &&
            item.period === input.billingPeriod,
        );
        const monthlyQuota = Math.round(
          departmentPeriod?.defaultGrantQuota ?? store.settings.defaultMonthlyQuota,
        );
        if (!Number.isFinite(monthlyQuota) || monthlyQuota <= 0) {
          throw new Error("管理员默认发放额度未配置为正整数");
        }
        const request = operation.requestId
          ? store.tokenRequests.find((item) => item.id === operation.requestId)
          : undefined;
        if (!request) {
          throw new Error("管理员默认发放取消任务缺少原申请，拒绝自动恢复");
        }
        const now = nowIso();
        Object.assign(request, {
          status: "approved_provisioning" as const,
          requestedMonthlyQuota: monthlyQuota,
          approvedMonthlyQuota: monthlyQuota,
          approvalDepartmentId: user.departmentId,
          approvalMode: "manual" as const,
          approvalOperatorOpenId: "system:admin-default",
          approvalOperatedAt: now,
          errorMessage: undefined,
          updatedAt: now,
        });
        const operationGeneration =
          Math.max(
            0,
            store.userQuotaStates.find(
              (state) => state.feishuUserId === user.id,
            )?.activeGeneration ?? 0,
            ...store.tokenAccounts
              .filter((account) => account.feishuUserId === user.id)
              .map((account) => account.operationGeneration ?? 0),
          ) + 1;
        const reopened = reopenFirstProvisionAfterAccessRevoke(operation, {
          departmentId: user.departmentId,
          requestedAssignedQuota: Math.max(
            Math.round(monthlyQuota * getConfig().newapi.quotaPerUnit),
            0,
          ),
          operationGeneration,
          requestId: request.id,
          reopenedAt: now,
        });
        Object.assign(operation, reopened);
        return { request, operation };
      }),
    ),
  );
}

export async function preparePackageResetPeriod(period: string) {
  if (isPostgresBackend()) return preparePostgresPackageResetPeriod(period);

  return mutate((store) => {
    assertPackageResetExecutionAllowed({
      policy: store.settings.packageReset,
      period,
    });
    const policies = store.userQuotaPolicies
      .filter(
        (policy) =>
          policy.effectiveFromPeriod <= period &&
          (!policy.effectiveToPeriod || policy.effectiveToPeriod >= period),
      )
      .sort((a, b) => b.version - a.version || b.id.localeCompare(a.id));
    const latestPolicyByUser = new Map<string, UserQuotaPolicy>();
    for (const policy of policies) {
      if (!latestPolicyByUser.has(policy.feishuUserId)) {
        latestPolicyByUser.set(policy.feishuUserId, policy);
      }
    }

    const departments = new Map<
      string,
      { departmentName?: string; assignedQuota: number }
    >();
    for (const user of store.users) {
      if (user.status && user.status !== "active") continue;
      const policy = latestPolicyByUser.get(user.id);
      if (!policy?.departmentId) continue;
      const current = departments.get(policy.departmentId) ?? {
        departmentName: user.departmentName,
        assignedQuota: 0,
      };
      current.departmentName ??= user.departmentName;
      current.assignedQuota += Math.max(policy.assignedMonthlyQuota, 0);
      departments.set(policy.departmentId, current);
    }

    const created: DepartmentQuotaPeriod[] = [];
    for (const [departmentId, department] of [...departments].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (
        store.departmentQuotaPeriods.some(
          (item) => item.departmentId === departmentId && item.period === period,
        )
      ) {
        continue;
      }
      const previous = store.departmentQuotaPeriods
        .filter((item) => item.departmentId === departmentId && item.period < period)
        .sort((a, b) => b.period.localeCompare(a.period) || b.id.localeCompare(a.id))[0];
      const assignedUnits = Math.ceil(
        department.assignedQuota / getConfig().newapi.quotaPerUnit,
      );
      const now = nowIso();
      const quotaPeriod: DepartmentQuotaPeriod = {
        id: randomId("dqp"),
        departmentId,
        departmentName: previous?.departmentName ?? department.departmentName,
        period,
        quotaLimit:
          previous?.quotaLimit ?? initialDepartmentQuotaLimit(assignedUnits),
        defaultGrantQuota:
          previous?.defaultGrantQuota ?? store.settings.defaultMonthlyQuota,
        createdAt: now,
        updatedAt: now,
        updatedByFeishuUserId: PACKAGE_RESET_SYSTEM_ACTOR,
      };
      store.departmentQuotaPeriods.push(quotaPeriod);
      created.push(quotaPeriod);
    }
    return created;
  });
}

export async function createMonthlyOpenQuotaOperations(
  inputs: Array<{
    feishuUserId: string;
    departmentId?: string;
    billingPeriod: string;
    assignedMonthlyQuota: number;
    createdByOpenId?: string;
  }>,
  options: { executionSource?: "root" | "package_reset" } = {},
) {
  if (!inputs.length) return [];
  if (isPostgresBackend()) {
    return createPostgresMonthlyOpenOperations(inputs, options);
  }
  const uniqueInputs = [
    ...new Map(
      inputs.map((input) => [
        `${input.feishuUserId}\u0000${input.billingPeriod}`,
        input,
      ]),
    ).values(),
  ];
  const userLockKeys = [
    ...new Set(uniqueInputs.map((item) => `user-quota:${item.feishuUserId}`)),
  ].sort();
  return withJsonQuotaLocks(
    userLockKeys,
    () =>
      mutate((store) => {
        if (options.executionSource === "package_reset") {
          if (
            uniqueInputs.some(
              (item) => item.createdByOpenId !== PACKAGE_RESET_SYSTEM_ACTOR,
            )
          ) {
            throw new Error("套餐重置自动任务的审计身份无效");
          }
          for (const period of new Set(uniqueInputs.map((item) => item.billingPeriod))) {
            assertPackageResetExecutionAllowed({
              policy: store.settings.packageReset,
              period,
            });
          }
        } else {
          const creatorOpenIds = [
            ...new Set(uniqueInputs.map((item) => item.createdByOpenId).filter(Boolean)),
          ] as string[];
          const rootActor =
            creatorOpenIds.length === 1 &&
            getConfig().admin.systemAdminOpenIds.includes(creatorOpenIds[0])
              ? store.users.find(
                  (user) =>
                    user.openId === creatorOpenIds[0] &&
                    (!user.status || user.status === "active"),
                )
              : undefined;
          if (!rootActor) {
            throw new AdminUserActionAuthorizationError(
              "root_required",
              403,
              "套餐重置仅允许有效 root 用户执行",
            );
          }
        }
        const operations: QuotaOperation[] = [];
        const resolvedInputs: Array<{
          feishuUserId: string;
          departmentId?: string;
          billingPeriod: string;
          assignedMonthlyQuota: number;
          createdByOpenId?: string;
          reopenOperation?: QuotaOperation;
        }> = [];
        const systemAdminOpenIds = new Set(getConfig().admin.systemAdminOpenIds);
        for (const input of uniqueInputs) {
          const idempotencyKey = `monthly-open:${input.billingPeriod}:${input.feishuUserId}`;
          const idempotent = store.quotaOperations.find(
            (item) => item.idempotencyKey === idempotencyKey,
          );
          if (idempotent && idempotent.state !== "cancelled") {
            operations.push(idempotent);
            continue;
          }
          if (
            store.quotaLedgerEntries.some(
              (entry) =>
                entry.feishuUserId === input.feishuUserId &&
                entry.period === input.billingPeriod &&
                entry.entryType === "period_open_authorization",
            )
          ) {
            continue;
          }
          const user = store.users.find((item) => item.id === input.feishuUserId);
          if (!user || (user.status && user.status !== "active")) {
            throw new Error(
              `月度开账用户已禁用、删除或不存在: ${input.feishuUserId}`,
            );
          }
          const currentPolicy = store.userQuotaPolicies
            .filter(
              (policy) =>
                policy.feishuUserId === input.feishuUserId &&
                policy.effectiveFromPeriod <= input.billingPeriod &&
                (!policy.effectiveToPeriod ||
                  policy.effectiveToPeriod >= input.billingPeriod),
            )
            .sort((a, b) => b.version - a.version || b.id.localeCompare(a.id))[0];
          if (!currentPolicy) {
            throw new Error(
              `月度开账用户缺少当前有效额度策略: ${input.feishuUserId}`,
            );
          }
          const activeTokenCount = store.tokenAccounts.filter(
            (account) =>
              account.feishuUserId === input.feishuUserId &&
              account.status === "active",
          ).length;
          if (activeTokenCount > 1) {
            throw new Error(`月度开账用户存在多个 active Key: ${input.feishuUserId}`);
          }
          const isGlobalAdmin =
            systemAdminOpenIds.has(user.openId) ||
            store.adminScopes.some(
              (scope) =>
                scope.feishuUserId === input.feishuUserId &&
                scope.scopeType === "global" &&
                scope.status === "active",
            );
          if (!currentPolicy.departmentId && !isGlobalAdmin) {
            throw new Error(`月度开账用户缺少部门归属: ${input.feishuUserId}`);
          }
          const open = store.quotaOperations.find(
            (item) =>
              item.feishuUserId === input.feishuUserId &&
              item.state !== "completed" &&
              item.state !== "compensated" &&
              item.state !== "cancelled",
          );
          if (open) throw new Error(`用户已有未完成额度操作: ${open.id}`);
          if (
            idempotent &&
            !canReopenMonthlyOpenAfterAccessRevoke(idempotent)
          ) {
            throw new Error(
              `已取消的月度开账操作存在不安全副作用，禁止自动恢复: ${idempotent.id}`,
            );
          }
          const assignedMonthlyQuota = Number(currentPolicy.assignedMonthlyQuota);
          if (
            !Number.isSafeInteger(assignedMonthlyQuota) ||
            assignedMonthlyQuota < 0
          ) {
            throw new Error(`月度开账用户当前额度策略无效: ${input.feishuUserId}`);
          }
          resolvedInputs.push({
            feishuUserId: input.feishuUserId,
            departmentId: currentPolicy.departmentId,
            billingPeriod: input.billingPeriod,
            assignedMonthlyQuota,
            createdByOpenId: input.createdByOpenId,
            reopenOperation: idempotent,
          });
        }
        if (!resolvedInputs.length) return operations;

        const checkpoint = store.usageSyncCheckpoints.find(
          (item) => item.scope === "newapi_usage_logs",
        );
        const syncPolicy = store.settings.usageSyncPolicy;
        const blockingIssue = store.usageSyncIssues.some(
          (issue) =>
            issue.status === "open" &&
            (issue.blocksSettlement ?? false),
        );
        if (
          !checkpoint ||
          checkpoint.lastRunStatus !== "applied" ||
          checkpoint.integrityBlockedAt ||
          checkpoint.integrityBlockedIssueId ||
          blockingIssue ||
          !isSettlementWatermarkFresh({
            settledThrough: checkpoint.settledThrough,
            maxLagMinutes:
              2 * (syncPolicy?.intervalMinutes ?? 60) +
              (syncPolicy?.settlementLagMinutes ?? 5),
          })
        ) {
          throw new Error("月度开账结算状态不安全：稳定水位或完整性门禁未通过");
        }

        for (const departmentId of [
          ...new Set(
            resolvedInputs
              .map((item) => item.departmentId)
              .filter((item): item is string => Boolean(item)),
          ),
        ]) {
          for (const period of [
            ...new Set(
              resolvedInputs
                .filter((item) => item.departmentId === departmentId)
                .map((item) => item.billingPeriod),
            ),
          ]) {
            const requested = resolvedInputs
              .filter(
                (item) =>
                  item.departmentId === departmentId && item.billingPeriod === period,
              )
              .reduce((sum, item) => sum + item.assignedMonthlyQuota, 0);
            const policy = store.departmentQuotaPeriods.find(
              (item) => item.departmentId === departmentId && item.period === period,
            );
            if (!policy) throw new Error(`部门 ${departmentId} 缺少 ${period} 账期预算`);
            const budgetQuota = Math.max(
              Math.round(policy.quotaLimit * getConfig().newapi.quotaPerUnit),
              0,
            );
            const committed = store.quotaLedgerEntries
              .filter(
                (item) => item.departmentId === departmentId && item.period === period,
              )
              .reduce((sum, item) => sum + item.signedQuota, 0);
            const pending = store.quotaOperations
              .filter(
                (item) =>
                  item.departmentId === departmentId &&
                  item.billingPeriod === period &&
                  item.state !== "completed" &&
                  item.state !== "compensated" &&
                  item.state !== "cancelled",
              )
              .reduce(
                (sum, item) => sum + Math.max(item.reservedDepartmentQuota, 0),
                0,
              );
            const available = Math.max(
              budgetQuota - Math.max(committed, 0) - Math.max(pending, 0),
              0,
            );
            if (requested > available) {
              throw new Error(`部门 ${departmentId} 可用额度不足，月度开账整批未创建`);
            }
          }
        }
        for (const input of resolvedInputs) {
          const state =
            store.userQuotaStates.find(
              (item) => item.feishuUserId === input.feishuUserId,
            )?.activeGeneration ??
            Math.max(
              0,
              ...store.tokenAccounts
                .filter((item) => item.feishuUserId === input.feishuUserId)
                .map((item) => item.operationGeneration ?? 0),
            );
          const now = nowIso();
          if (input.reopenOperation) {
            const reopened = reopenMonthlyOpenAfterAccessRevoke(
              input.reopenOperation,
              {
                departmentId: input.departmentId,
                assignedMonthlyQuota: input.assignedMonthlyQuota,
                operationGeneration: state + 1,
                createdByOpenId: input.createdByOpenId,
                reopenedAt: now,
              },
            );
            Object.assign(input.reopenOperation, reopened);
            operations.push(input.reopenOperation);
            continue;
          }
          const operation: QuotaOperation = {
            id: randomId("qo"),
            operationType: "monthly_open",
            idempotencyKey: `monthly-open:${input.billingPeriod}:${input.feishuUserId}`,
            feishuUserId: input.feishuUserId,
            departmentId: input.departmentId,
            billingPeriod: input.billingPeriod,
            requestedAssignedQuota: input.assignedMonthlyQuota,
            reservedDepartmentQuota: input.departmentId
              ? input.assignedMonthlyQuota
              : 0,
            operationGeneration: state + 1,
            state: input.departmentId ? "budget_reserved" : "planned",
            attemptCount: 0,
            createdByOpenId: input.createdByOpenId,
            createdAt: now,
            updatedAt: now,
          };
          store.quotaOperations.push(operation);
          operations.push(operation);
        }
        return operations;
      }),
  );
}

export async function findQuotaOperationById(operationId: string) {
  if (isPostgresBackend()) return findPostgresQuotaOperationById(operationId);
  const store = await readStore();
  return store.quotaOperations.find((item) => item.id === operationId) ?? null;
}

export async function findQuotaOperationByIdempotencyKey(idempotencyKey: string) {
  if (isPostgresBackend()) {
    return findPostgresQuotaOperationByIdempotencyKey(idempotencyKey);
  }
  const store = await readStore();
  return store.quotaOperations.find((item) => item.idempotencyKey === idempotencyKey) ?? null;
}

export async function updateQuotaOperation(
  operationId: string,
  patch: Partial<QuotaOperation>,
  allowedStates?: QuotaOperation["state"][],
) {
  if (isPostgresBackend()) {
    return updatePostgresQuotaOperation(operationId, patch, allowedStates);
  }
  return mutate((store) => {
    const operation = store.quotaOperations.find((item) => item.id === operationId);
    if (!operation || (allowedStates && !allowedStates.includes(operation.state))) return null;
    Object.assign(operation, patch, {
      id: operation.id,
      idempotencyKey: operation.idempotencyKey,
      updatedAt: patch.updatedAt ?? nowIso(),
    });
    return operation;
  });
}

export async function claimQuotaOperationExecution(input: {
  operationId: string;
  leaseId: string;
  leaseDurationMs: number;
}) {
  if (isPostgresBackend()) return claimPostgresQuotaOperationExecution(input);
  return mutate((store) => {
    const operation = store.quotaOperations.find((item) => item.id === input.operationId);
    if (!operation) return null;
    if (["completed", "compensated", "cancelled"].includes(operation.state)) return null;
    if (
      operation.workerLeaseId &&
      operation.workerLeaseId !== input.leaseId &&
      operation.workerLeaseExpiresAt &&
      operation.workerLeaseExpiresAt > nowIso()
    ) {
      return null;
    }
    operation.workerLeaseId = input.leaseId;
    operation.workerLeaseExpiresAt = new Date(
      Date.now() + Math.max(Math.trunc(input.leaseDurationMs), 1),
    ).toISOString();
    return operation;
  });
}

export async function renewQuotaOperationExecution(input: {
  operationId: string;
  leaseId: string;
  leaseDurationMs: number;
}) {
  if (isPostgresBackend()) return renewPostgresQuotaOperationExecution(input);
  return mutate((store) => {
    const operation = store.quotaOperations.find((item) => item.id === input.operationId);
    if (
      !operation ||
      ["completed", "compensated", "cancelled"].includes(operation.state) ||
      operation.workerLeaseId !== input.leaseId
    ) return null;
    operation.workerLeaseExpiresAt = new Date(
      Date.now() + Math.max(Math.trunc(input.leaseDurationMs), 1),
    ).toISOString();
    return operation;
  });
}

export async function releaseQuotaOperationExecution(input: {
  operationId: string;
  leaseId: string;
}) {
  if (isPostgresBackend()) return releasePostgresQuotaOperationExecution(input);
  return mutate((store) => {
    const operation = store.quotaOperations.find((item) => item.id === input.operationId);
    if (!operation || operation.workerLeaseId !== input.leaseId) return operation ?? null;
    delete operation.workerLeaseId;
    delete operation.workerLeaseExpiresAt;
    return operation;
  });
}

export async function transitionQuotaOperation(
  operationId: string,
  state: QuotaOperation["state"],
  patch: Partial<QuotaOperation> = {},
) {
  if (isPostgresBackend()) {
    return transitionPostgresQuotaOperation(operationId, state, patch);
  }
  const current = await findQuotaOperationById(operationId);
  if (!current) return null;
  assertQuotaOperationTransition(current.state, state);
  return updateQuotaOperation(
    operationId,
    {
      ...patch,
      state,
      completedAt:
        state === "completed" || state === "compensated" || state === "cancelled"
          ? nowIso()
          : patch.completedAt,
    },
    [current.state],
  );
}

export async function reserveQuotaOperationDepartmentBudget(
  operationId: string,
  reservedDepartmentQuota: number,
) {
  const initial = await findQuotaOperationById(operationId);
  if (!initial) throw new Error("额度操作不存在");
  if (reservedDepartmentQuota <= 0) return initial;
  // Global administrators can legitimately have no Feishu department. Their
  // default grant uses the global policy and must not invent a fake department.
  if (!initial.departmentId) return initial;
  await ensureDepartmentQuotaPeriod({
    departmentId: initial.departmentId,
    period: initial.billingPeriod,
  });
  if (isPostgresBackend()) {
    return reservePostgresQuotaOperationDepartmentBudget(
      operationId,
      reservedDepartmentQuota,
    );
  }
  return withDepartmentQuotaLock(
    initial.departmentId,
    initial.billingPeriod,
    async () => {
      const store = await readStore();
      const operation = store.quotaOperations.find((item) => item.id === operationId);
      if (!operation) throw new Error("额度操作不存在");
      if (operation.reservedDepartmentQuota === reservedDepartmentQuota) return operation;
      const policy = store.departmentQuotaPeriods.find(
        (item) =>
          item.departmentId === operation.departmentId &&
          item.period === operation.billingPeriod,
      );
      if (!policy) throw new Error("部门账期预算不存在");
      const quotaPerUnit = getConfig().newapi.quotaPerUnit;
      const budgetQuota = Math.max(Math.round(policy.quotaLimit * quotaPerUnit), 0);
      const committedAuthorizedQuota = store.quotaLedgerEntries
        .filter(
          (item) =>
            item.departmentId === operation.departmentId &&
            item.period === operation.billingPeriod,
        )
        .reduce((sum, item) => sum + item.signedQuota, 0);
      const pendingReservedQuota = store.quotaOperations
        .filter(
          (item) =>
            item.id !== operation.id &&
            item.departmentId === operation.departmentId &&
            item.billingPeriod === operation.billingPeriod &&
            item.state !== "completed" &&
            item.state !== "compensated" &&
            item.state !== "cancelled",
        )
        .reduce((sum, item) => sum + Math.max(item.reservedDepartmentQuota, 0), 0);
      const availableQuota = Math.max(
        budgetQuota - Math.max(committedAuthorizedQuota, 0) - pendingReservedQuota,
        0,
      );
      if (reservedDepartmentQuota > availableQuota) {
        throw new Error("部门可用额度不足，无法预占本次额度操作");
      }
      return transitionQuotaOperation(operation.id, "budget_reserved", {
        reservedDepartmentQuota,
      });
    },
  );
}

export async function listQuotaOperations(input: {
  feishuUserId?: string;
  state?: QuotaOperation["state"];
  limit?: number;
} = {}) {
  if (isPostgresBackend()) return listPostgresQuotaOperations(input);
  const store = await readStore();
  return store.quotaOperations
    .filter(
      (item) =>
        (!input.feishuUserId || item.feishuUserId === input.feishuUserId) &&
        (!input.state || item.state === input.state),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, input.limit ?? 100);
}

export async function listDueQuotaOperations(input: {
  now: string;
  limit?: number;
}) {
  if (isPostgresBackend()) return listPostgresDueQuotaOperations(input);
  const store = await readStore();
  const nowMs = new Date(input.now).getTime();
  return store.quotaOperations
    .filter(
      (item) =>
        item.state !== "completed" &&
        item.state !== "compensated" &&
        item.state !== "cancelled" &&
        (item.state !== "manual_review" ||
          canAutoResumeKeyRotationObservationFailure(item)) &&
        (!item.nextRetryAt || new Date(item.nextRetryAt).getTime() <= nowMs) &&
        (!item.workerLeaseExpiresAt ||
          new Date(item.workerLeaseExpiresAt).getTime() <= nowMs),
    )
    .sort((a, b) => {
      const nextRetryOrder = (a.nextRetryAt ?? "").localeCompare(b.nextRetryAt ?? "");
      if (nextRetryOrder !== 0) return nextRetryOrder;
      return a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id);
    })
    .slice(0, Math.max(Math.trunc(input.limit ?? 100), 0));
}

export async function appendQuotaLedgerEntry(
  input: Omit<QuotaLedgerEntry, "id" | "createdAt" | "quotaPerUnitSnapshot"> & {
    quotaPerUnitSnapshot?: number;
  },
) {
  const entry: QuotaLedgerEntry = {
    ...input,
    id: randomId("qle"),
    quotaPerUnitSnapshot: input.quotaPerUnitSnapshot ?? getConfig().newapi.quotaPerUnit,
    createdAt: nowIso(),
  };
  if (isPostgresBackend()) return insertPostgresQuotaLedgerEntry(entry);
  return mutate((store) => {
    const existing = store.quotaLedgerEntries.find(
      (item) => item.operationId === entry.operationId && item.entryType === entry.entryType,
    );
    if (existing) return existing;
    store.quotaLedgerEntries.push(entry);
    return entry;
  });
}

export async function listQuotaLedgerEntries(input: {
  feishuUserId?: string;
  departmentId?: string;
  period?: string;
} = {}) {
  const store = await readStore();
  return store.quotaLedgerEntries.filter(
    (item) =>
      (!input.feishuUserId || item.feishuUserId === input.feishuUserId) &&
      (!input.departmentId || item.departmentId === input.departmentId) &&
      (!input.period || item.period === input.period),
  );
}

export async function saveQuotaReconciliationRecord(record: QuotaReconciliationRecord) {
  if (isPostgresBackend()) return upsertPostgresQuotaReconciliationRecord(record);
  return mutate((store) => {
    const index = store.quotaReconciliationRecords.findIndex((item) => item.id === record.id);
    if (index === -1) store.quotaReconciliationRecords.push(record);
    else store.quotaReconciliationRecords[index] = record;
    return record;
  });
}

function quotaRecordPeriod(record: NewApiUsageRecord) {
  return resolveUsageBillingPeriod({
    billingPeriod: record.billingPeriod,
    occurredAt: record.newapiCreatedAt ?? record.lastSyncedAt ?? record.firstSeenAt,
  });
}

function authoritativeQuotaFromRecord(record: NewApiUsageRecord, quotaPerUnit: number) {
  if (Number.isFinite(record.quota)) return Math.max(Math.round(record.quota as number), 0);
  if (Number.isFinite(record.cost)) {
    return Math.max(Math.round((record.cost as number) * quotaPerUnit), 0);
  }
  return 0;
}

async function rebuildDepartmentQuotaMaterializedSnapshots(
  period: string,
  quotaPerUnit: number,
  materializedAt: string,
) {
  const refreshed = await readStore();
  const departmentRows: DepartmentQuotaPeriod[] = [];
  for (const existing of refreshed.departmentQuotaPeriods.filter((item) => item.period === period)) {
    const departmentUserIds = new Set(
      refreshed.users
        .filter((item) => item.departmentId === existing.departmentId && item.status !== "deleted")
        .map((item) => item.id),
    );
    const committedAuthorizedQuota = refreshed.quotaLedgerEntries
      .filter(
        (item) =>
          item.period === period &&
          (item.departmentId === existing.departmentId || departmentUserIds.has(item.feishuUserId)),
      )
      .reduce((sum, item) => sum + item.signedQuota, 0);
    const pendingReservedQuota = refreshed.quotaOperations
      .filter(
        (item) =>
          item.departmentId === existing.departmentId &&
          item.billingPeriod === period &&
          item.state !== "completed" &&
          item.state !== "compensated" &&
          item.state !== "cancelled",
      )
      .reduce((sum, item) => sum + Math.max(item.reservedDepartmentQuota, 0), 0);
    const materialized = materializeDepartmentQuota({
      budgetQuota: Math.max(Math.round(existing.quotaLimit * quotaPerUnit), 0),
      committedAuthorizedQuota: Math.max(committedAuthorizedQuota, 0),
      pendingReservedQuota,
    });
    const row: DepartmentQuotaPeriod = {
      ...existing,
      ...materialized,
      materializedAt,
      updatedAt: existing.updatedAt,
    };
    departmentRows.push(row);
    await persistDepartmentQuotaPeriod(row);
  }
  return departmentRows;
}

async function rebuildQuotaMaterializedSnapshotsNow(
  period = hongKongBillingPeriod(),
) {
  const quotaPerUnit = getConfig().newapi.quotaPerUnit;
  if (isPostgresBackend()) {
    // PostgreSQL must never persist UserBillingPeriod objects computed from the
    // lock-free readStore snapshot. Each user row is rebuilt from base tables
    // inside the same billing-period-finalize transaction fence as settlement.
    const rebuilt = await rebuildPostgresQuotaMaterializedUsers(period);
    const departmentRows = await rebuildDepartmentQuotaMaterializedSnapshots(
      period,
      quotaPerUnit,
      rebuilt.materializedAt,
    );
    return {
      period,
      materializedAt: rebuilt.materializedAt,
      users: rebuilt.users,
      departments: departmentRows.map((item) => ({
        departmentId: item.departmentId,
        budgetQuota: item.budgetQuota ?? 0,
        committedAuthorizedQuota: item.committedAuthorizedQuota ?? 0,
        pendingReservedQuota: item.pendingReservedQuota ?? 0,
        availableQuota: item.availableQuota ?? 0,
        overcommittedQuota: item.overcommittedQuota ?? 0,
      })),
    };
  }

  const store = await readStore();
  const now = nowIso();
  const userRows: UserBillingPeriod[] = [];
  const materializedUsers: Array<{
    feishuUserId: string;
    period: string;
    assignedMonthlyQuota: number;
    authorizedQuota: number;
    authoritativeConsumedQuota: number;
    expectedAvailableQuota: number;
    overageQuota: number;
    ledgerEntries: number;
    policyPresent: boolean;
  }> = [];

  const relevantUserIds = new Set([
    ...store.users.map((item) => item.id),
    ...store.userBillingPeriods
      .filter((item) => item.period === period)
      .map((item) => item.feishuUserId),
    ...store.userQuotaPolicies.map((item) => item.feishuUserId),
    ...store.quotaLedgerEntries
      .filter((item) => item.period === period)
      .map((item) => item.feishuUserId),
  ]);

  for (const feishuUserId of relevantUserIds) {
    const existing = store.userBillingPeriods.find(
      (item) => item.feishuUserId === feishuUserId && item.period === period,
    );
    const policy = store.userQuotaPolicies
      .filter(
        (item) =>
          item.feishuUserId === feishuUserId &&
          item.effectiveFromPeriod <= period &&
          (!item.effectiveToPeriod || item.effectiveToPeriod >= period),
      )
      .sort((a, b) => b.version - a.version)[0];
    const ledgerEntries = store.quotaLedgerEntries.filter(
      (item) => item.feishuUserId === feishuUserId && item.period === period,
    );
    const usageRecords = store.newapiUsageRecords.filter(
      (item) =>
        item.feishuUserId === feishuUserId &&
        quotaRecordPeriod(item) === period &&
        isAuthoritativeUsageRecord(item),
    );
    const assignedMonthlyQuota = policy?.assignedMonthlyQuota ?? 0;
    const authoritativeConsumedQuota = usageRecords.reduce(
      (sum, item) => sum + authoritativeQuotaFromRecord(item, quotaPerUnit),
      0,
    );
    const materialized = materializeUserQuota({
      assignedMonthlyQuota,
      authoritativeConsumedQuota,
      ledgerEntries,
    });
    const row: UserBillingPeriod = {
      id: existing?.id ?? randomId("bp"),
      feishuUserId,
      period,
      monthlyQuota: assignedMonthlyQuota / quotaPerUnit,
      quotaConsumed: authoritativeConsumedQuota / quotaPerUnit,
      cost: authoritativeConsumedQuota / quotaPerUnit,
      remainingQuota: materialized.expectedAvailableQuota / quotaPerUnit,
      promptTokens: existing?.promptTokens ?? 0,
      completionTokens: existing?.completionTokens ?? 0,
      totalTokens: existing?.totalTokens ?? 0,
      proxyLogCount: existing?.proxyLogCount ?? 0,
      usageRecordCount: existing?.usageRecordCount ?? usageRecords.length,
      activeTokenAccountId: existing?.activeTokenAccountId,
      tokenAccountIds: existing?.tokenAccountIds ?? [],
      assignedQuotaUpdatedAt: existing?.assignedQuotaUpdatedAt,
      assignedQuotaUpdatedByFeishuUserId: existing?.assignedQuotaUpdatedByFeishuUserId,
      ...materialized,
      settledThrough: store.usageSyncCheckpoints.find(
        (item) => item.scope === "newapi_usage_logs",
      )?.settledThrough,
      sourceVersion: `${policy?.version ?? 0}:${ledgerEntries.length}:${usageRecords.length}`,
      materializedAt: now,
      updatedAt: existing?.updatedAt ?? now,
    };
    userRows.push(row);
    materializedUsers.push({
      feishuUserId,
      period,
      assignedMonthlyQuota,
      authorizedQuota: materialized.authorizedQuota,
      authoritativeConsumedQuota,
      expectedAvailableQuota: materialized.expectedAvailableQuota,
      overageQuota: materialized.overageQuota,
      ledgerEntries: ledgerEntries.length,
      policyPresent: Boolean(policy),
    });
  }

  for (const row of userRows) await persistUserBillingPeriod(row);
  const departmentRows = await rebuildDepartmentQuotaMaterializedSnapshots(
    period,
    quotaPerUnit,
    now,
  );

  return {
    period,
    materializedAt: now,
    users: materializedUsers,
    departments: departmentRows.map((item) => ({
      departmentId: item.departmentId,
      budgetQuota: item.budgetQuota ?? 0,
      committedAuthorizedQuota: item.committedAuthorizedQuota ?? 0,
      pendingReservedQuota: item.pendingReservedQuota ?? 0,
      availableQuota: item.availableQuota ?? 0,
      overcommittedQuota: item.overcommittedQuota ?? 0,
    })),
  };
}

type QuotaMaterializationResult = Awaited<
  ReturnType<typeof rebuildQuotaMaterializedSnapshotsNow>
>;

type QuotaMaterializationRun = {
  rerun: boolean;
  promise: Promise<QuotaMaterializationResult>;
};

const quotaMaterializationRuns = new Map<string, QuotaMaterializationRun>();

export function rebuildQuotaMaterializedSnapshots(period = hongKongBillingPeriod()) {
  const existing = quotaMaterializationRuns.get(period);
  if (existing) {
    existing.rerun = true;
    return existing.promise;
  }

  const entry = {
    rerun: false,
    promise: undefined as unknown as Promise<QuotaMaterializationResult>,
  } satisfies QuotaMaterializationRun;
  entry.promise = (async () => {
    let result: QuotaMaterializationResult;
    do {
      entry.rerun = false;
      result = await rebuildQuotaMaterializedSnapshotsNow(period);
    } while (entry.rerun);
    return result;
  })().finally(() => {
    if (quotaMaterializationRuns.get(period) === entry) {
      quotaMaterializationRuns.delete(period);
    }
  });
  quotaMaterializationRuns.set(period, entry);
  return entry.promise;
}

export async function rebuildUserQuotaMaterializedSnapshot(
  feishuUserId: string,
  period = hongKongBillingPeriod(),
  departmentId?: string,
) {
  if (isPostgresBackend()) {
    const [billingPeriod, departmentPeriod] = await Promise.all([
      reconcilePostgresBillingPeriodForUser(feishuUserId, period),
      departmentId
        ? rebuildPostgresDepartmentQuotaMaterializedSnapshot(departmentId, period)
        : Promise.resolve(null),
    ]);
    return { billingPeriod, departmentPeriod };
  }
  return rebuildQuotaMaterializedSnapshots(period);
}

const rebuildQuotaOperationDepartmentMaterializedSnapshot = createRerunSingleFlight(
  (input: { departmentId: string; period: string }) =>
    `${input.departmentId}\u0000${input.period}`,
  ({ departmentId, period }) =>
    rebuildPostgresDepartmentQuotaMaterializedSnapshotForQuotaOperation(
      departmentId,
      period,
    ),
);

export async function rebuildUserQuotaMaterializedSnapshotForQuotaOperation(
  feishuUserId: string,
  period = hongKongBillingPeriod(),
  departmentId?: string,
) {
  if (isPostgresBackend()) {
    // Keep at most one control-pool checkout per operation. With four saga
    // workers and an eight-connection control pool, the former concurrent fan-out
    // could consume the whole pool and starve submit/poll requests.
    const billingPeriod = await reconcilePostgresBillingPeriodForQuotaOperation(
      feishuUserId,
      period,
    );
    const departmentPeriod = departmentId
      ? await rebuildQuotaOperationDepartmentMaterializedSnapshot({ departmentId, period })
      : null;
    return { billingPeriod, departmentPeriod };
  }
  return rebuildUserQuotaMaterializedSnapshot(feishuUserId, period, departmentId);
}

export async function refreshUserBillingTokenMetadataForQuotaOperation(
  feishuUserId: string,
  period = hongKongBillingPeriod(),
) {
  if (isPostgresBackend()) {
    return refreshPostgresBillingPeriodTokenMetadataForQuotaOperation(
      feishuUserId,
      period,
    );
  }
  await rebuildUserQuotaMaterializedSnapshot(feishuUserId, period);
  return getUserBillingPeriod(feishuUserId, period);
}

async function persistDepartmentQuotaPeriod(period: DepartmentQuotaPeriod) {
  if (isPostgresBackend()) return upsertPostgresDepartmentQuotaPeriod(period);
  return mutate((store) => {
    const index = store.departmentQuotaPeriods.findIndex(
      (item) => item.departmentId === period.departmentId && item.period === period.period,
    );
    if (index === -1) store.departmentQuotaPeriods.push(period);
    else store.departmentQuotaPeriods[index] = period;
    return period;
  });
}

async function persistDepartmentQuotaRequest(request: DepartmentQuotaRequest) {
  if (isPostgresBackend()) return insertPostgresDepartmentQuotaRequest(request);
  return mutate((store) => {
    const index = store.departmentQuotaRequests.findIndex((item) => item.id === request.id);
    if (index === -1) store.departmentQuotaRequests.push(request);
    else store.departmentQuotaRequests[index] = request;
    return request;
  });
}

async function persistQuotaChangeEvent(event: QuotaChangeEvent) {
  if (isPostgresBackend()) return upsertPostgresQuotaChangeEvent(event);
  return mutate((store) => {
    const index = store.quotaChangeEvents.findIndex((item) => item.id === event.id);
    if (index === -1) store.quotaChangeEvents.push(event);
    else store.quotaChangeEvents[index] = event;
    return event;
  });
}

async function persistUserBillingPeriod(period: UserBillingPeriod) {
  if (isPostgresBackend()) return upsertPostgresUserBillingPeriod(period);
  return mutate((store) => {
    const index = store.userBillingPeriods.findIndex(
      (item) => item.feishuUserId === period.feishuUserId && item.period === period.period,
    );
    if (index === -1) store.userBillingPeriods.push(period);
    else store.userBillingPeriods[index] = period;
    return period;
  });
}

function departmentUsersForPeriod(store: StoreShape, departmentId: string) {
  return store.users.filter(
    (user) => user.departmentId === departmentId && user.status !== "deleted",
  );
}

function allocatedDepartmentQuota(store: StoreShape, departmentId: string, period: string) {
  const userIds = new Set(
    departmentUsersForPeriod(store, departmentId).map((user) => user.id),
  );
  return store.userBillingPeriods
    .filter((item) => item.period === period && userIds.has(item.feishuUserId))
    .reduce((sum, item) => sum + Math.max(item.monthlyQuota, 0), 0);
}

async function ensureDepartmentQuotaPeriodUnlocked(
  departmentId: string,
  period: string,
  departmentName?: string,
) {
  const store = await readStore();
  const existing = store.departmentQuotaPeriods.find(
    (item) => item.departmentId === departmentId && item.period === period,
  );
  if (existing) return existing;

  const now = nowIso();
  const inferredDepartmentName =
    departmentName ??
    store.users.find((user) => user.departmentId === departmentId)?.departmentName;
  const quotaPeriod: DepartmentQuotaPeriod = {
    id: randomId("dqp"),
    departmentId,
    departmentName: inferredDepartmentName,
    period,
    quotaLimit: initialDepartmentQuotaLimit(
      allocatedDepartmentQuota(store, departmentId, period),
    ),
    defaultGrantQuota: store.settings.defaultMonthlyQuota,
    createdAt: now,
    updatedAt: now,
  };
  return persistDepartmentQuotaPeriod(quotaPeriod);
}

export async function ensureDepartmentQuotaPeriod(input: {
  departmentId: string;
  departmentName?: string;
  period?: string;
}) {
  const period = input.period ?? (await getCurrentPackageBillingPeriod());
  return withDepartmentQuotaLock(input.departmentId, period, () =>
    ensureDepartmentQuotaPeriodUnlocked(input.departmentId, period, input.departmentName),
  );
}

function mapDepartmentQuotaSummary(store: StoreShape, policy: DepartmentQuotaPeriod) {
  const users = departmentUsersForPeriod(store, policy.departmentId);
  const userIds = new Set(users.map((user) => user.id));
  const billingPeriods = store.userBillingPeriods.filter(
    (item) => item.period === policy.period && userIds.has(item.feishuUserId),
  );
  const events = store.quotaChangeEvents.filter(
    (event) => event.departmentId === policy.departmentId && event.period === policy.period,
  );
  const allocatedQuota = billingPeriods.reduce(
    (sum, item) => sum + Math.max(item.monthlyQuota, 0),
    0,
  );
  const usage = summarizeDepartmentQuota({ policy, allocatedQuota, events });
  const keyedUsers = new Set(
    store.tokenAccounts
      .filter((account) => account.status === "active" && userIds.has(account.feishuUserId))
      .map((account) => account.feishuUserId),
  ).size;
  const prewarmedKeys = store.tokenAccounts.filter(
    (account) =>
      account.status === "pending_activation" &&
      Boolean(account.prewarmedAt) &&
      userIds.has(account.feishuUserId),
  ).length;
  return {
    id: policy.id,
    departmentId: policy.departmentId,
    departmentName:
      policy.departmentName ?? users.find((user) => user.departmentName)?.departmentName,
    period: policy.period,
    quotaLimit: usage.quotaLimit,
    defaultGrantQuota: policy.defaultGrantQuota,
    allocatedQuota: usage.allocatedQuota,
    pendingReservedQuota: usage.pendingReservedQuota,
    availableQuota: usage.availableQuota,
    quotaConsumed: billingPeriods.reduce((sum, item) => sum + (item.quotaConsumed ?? 0), 0),
    remainingQuota: billingPeriods.reduce((sum, item) => sum + (item.remainingQuota ?? 0), 0),
    memberCount: users.length,
    keyedUsers,
    prewarmedKeys,
    updatedAt: policy.updatedAt,
    updatedByFeishuUserId: policy.updatedByFeishuUserId,
  };
}

export async function listDepartmentQuotaOverview(scope: AdminScope, period?: string) {
  period ??= await getCurrentPackageBillingPeriod();
  if (isPostgresBackend()) {
    return getPostgresDepartmentQuotaOverview(scope, period);
  }
  const store = await readStore();
  const departmentIds =
    scope.scopeType === "global"
      ? [
          ...new Set(
            [
              ...store.users.map((user) => user.departmentId),
              ...store.departmentQuotaPeriods
                .filter((item) => item.period === period)
                .map((item) => item.departmentId),
            ].filter((item): item is string => Boolean(item)),
          ),
        ]
      : scope.departmentId
        ? [scope.departmentId]
        : [];

  const departments = departmentIds
    .map((departmentId) => {
      const existing = store.departmentQuotaPeriods.find(
        (item) => item.departmentId === departmentId && item.period === period,
      );
      if (existing) return existing;
      const allocatedQuota = allocatedDepartmentQuota(store, departmentId, period);
      const now = nowIso();
      return {
        id: `virtual:${departmentId}:${period}`,
        departmentId,
        departmentName: store.users.find(
          (user) => user.departmentId === departmentId,
        )?.departmentName,
        period,
        quotaLimit: initialDepartmentQuotaLimit(allocatedQuota),
        defaultGrantQuota: store.settings.defaultMonthlyQuota,
        createdAt: now,
        updatedAt: now,
      } satisfies DepartmentQuotaPeriod;
    })
    .map((item) => mapDepartmentQuotaSummary(store, item))
    .sort((a, b) =>
      (a.departmentName ?? a.departmentId).localeCompare(
        b.departmentName ?? b.departmentId,
        "zh-CN",
      ),
    );
  const usersById = new Map(store.users.map((user) => [user.id, user]));
  const requests = store.departmentQuotaRequests
    .filter(
      (request) =>
        request.period === period &&
        (scope.scopeType === "global" || request.departmentId === scope.departmentId),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((request) => ({
      ...request,
      requesterName: usersById.get(request.requesterFeishuUserId)?.name,
      requesterOpenId: usersById.get(request.requesterFeishuUserId)?.openId,
    }));
  const recentEvents = store.quotaChangeEvents
    .filter(
      (event) =>
        event.period === period &&
        (scope.scopeType === "global" || event.departmentId === scope.departmentId),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 100);
  return { period, departments, requests, recentEvents };
}

async function updateDepartmentQuotaPolicy(input: {
  departmentId: string;
  departmentName?: string;
  period?: string;
  quotaLimit?: number;
  defaultGrantQuota?: number;
  operatedByFeishuUserId: string;
}) {
  const period = input.period ?? (await getCurrentPackageBillingPeriod());
  return withDepartmentQuotaLock(input.departmentId, period, async () => {
    const policy = await ensureDepartmentQuotaPeriodUnlocked(
      input.departmentId,
      period,
      input.departmentName,
    );
    const store = await readStore();
    const allocatedQuota = allocatedDepartmentQuota(store, input.departmentId, period);
    const pendingReservedQuota = summarizeDepartmentQuota({
      policy,
      allocatedQuota,
      events: store.quotaChangeEvents.filter(
        (event) => event.departmentId === input.departmentId && event.period === period,
      ),
    }).pendingReservedQuota;
    if (input.quotaLimit !== undefined) {
      const error = validateDepartmentQuotaLimit(
        input.quotaLimit,
        allocatedQuota + pendingReservedQuota,
      );
      if (error) throw new Error(error);
    }
    if (
      input.defaultGrantQuota !== undefined &&
      (!Number.isInteger(input.defaultGrantQuota) ||
        input.defaultGrantQuota <= 0 ||
        input.defaultGrantQuota > 1_000_000)
    ) {
      throw new Error("部门默认发放额度必须是 1 到 1000000 之间的整数");
    }
    const now = nowIso();
    const updated: DepartmentQuotaPeriod = {
      ...policy,
      departmentName: input.departmentName ?? policy.departmentName,
      quotaLimit: input.quotaLimit ?? policy.quotaLimit,
      defaultGrantQuota: input.defaultGrantQuota ?? policy.defaultGrantQuota,
      updatedAt: now,
      updatedByFeishuUserId: input.operatedByFeishuUserId,
    };
    await persistDepartmentQuotaPeriod(updated);
    const changes: QuotaChangeEvent[] = [];
    if (input.quotaLimit !== undefined && input.quotaLimit !== policy.quotaLimit) {
      changes.push({
        id: randomId("qce"),
        departmentId: input.departmentId,
        departmentName: updated.departmentName,
        period,
        operatedByFeishuUserId: input.operatedByFeishuUserId,
        kind: "department_limit_set",
        status: "applied",
        previousValue: policy.quotaLimit,
        nextValue: input.quotaLimit,
        delta: input.quotaLimit - policy.quotaLimit,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (
      input.defaultGrantQuota !== undefined &&
      input.defaultGrantQuota !== policy.defaultGrantQuota
    ) {
      changes.push({
        id: randomId("qce"),
        departmentId: input.departmentId,
        departmentName: updated.departmentName,
        period,
        operatedByFeishuUserId: input.operatedByFeishuUserId,
        kind: "department_default_set",
        status: "applied",
        previousValue: policy.defaultGrantQuota,
        nextValue: input.defaultGrantQuota,
        delta: input.defaultGrantQuota - policy.defaultGrantQuota,
        createdAt: now,
        updatedAt: now,
      });
    }
    await Promise.all(changes.map((event) => persistQuotaChangeEvent(event)));
    return mapDepartmentQuotaSummary(await readStore(), updated);
  });
}

export async function updateDepartmentQuotaPolicyAsActor(input: {
  actorFeishuUserId: string;
  departmentId: string;
  departmentName?: string;
  period?: string;
  quotaLimit?: number;
  defaultGrantQuota?: number;
}) {
  const period = input.period ?? (await getCurrentPackageBillingPeriod());
  if (isPostgresBackend()) {
    return updatePostgresDepartmentQuotaPolicyAsActor({ ...input, period });
  }
  return withAdminScopeUserLocks([input.actorFeishuUserId], () =>
    withDepartmentQuotaLock(input.departmentId, period, () =>
      mutate(async (store) => {
        const actor = store.users.find((user) => user.id === input.actorFeishuUserId);
        const actorScope = actor
          ? await resolveAdminScopeForKnownUser(actor, store)
          : null;
        if (!actorScope) {
          throw new AdminUserActionAuthorizationError(
            "actor_scope_missing",
            403,
            "当前管理员权限已变化，请刷新后重试",
          );
        }
        if (
          actorScope.scopeType === "department" &&
          actorScope.departmentId !== input.departmentId
        ) {
          throw new AdminUserActionAuthorizationError(
            "target_out_of_scope",
            403,
            "不能修改其他部门的额度设置",
          );
        }
        if (actorScope.scopeType === "department" && input.quotaLimit !== undefined) {
          throw new AdminUserActionAuthorizationError(
            "target_out_of_scope",
            403,
            "部门总额度上限只能由系统管理员直接设置",
          );
        }
        const allocatedQuota = allocatedDepartmentQuota(store, input.departmentId, period);
        const now = nowIso();
        let policy = store.departmentQuotaPeriods.find(
          (item) => item.departmentId === input.departmentId && item.period === period,
        );
        if (!policy) {
          policy = {
            id: randomId("dqp"),
            departmentId: input.departmentId,
            departmentName:
              input.departmentName ??
              store.users.find((user) => user.departmentId === input.departmentId)
                ?.departmentName,
            period,
            quotaLimit: initialDepartmentQuotaLimit(allocatedQuota),
            defaultGrantQuota: store.settings.defaultMonthlyQuota,
            createdAt: now,
            updatedAt: now,
          };
          store.departmentQuotaPeriods.push(policy);
        }
        const pendingReservedQuota = summarizeDepartmentQuota({
          policy,
          allocatedQuota,
          events: store.quotaChangeEvents.filter(
            (event) =>
              event.departmentId === input.departmentId && event.period === period,
          ),
        }).pendingReservedQuota;
        if (input.quotaLimit !== undefined) {
          const error = validateDepartmentQuotaLimit(
            input.quotaLimit,
            allocatedQuota + pendingReservedQuota,
          );
          if (error) throw new Error(error);
        }
        if (
          input.defaultGrantQuota !== undefined &&
          (!Number.isInteger(input.defaultGrantQuota) ||
            input.defaultGrantQuota <= 0 ||
            input.defaultGrantQuota > 1_000_000)
        ) {
          throw new Error("部门默认发放额度必须是 1 到 1000000 之间的整数");
        }
        const previous = { ...policy };
        Object.assign(policy, {
          departmentName: input.departmentName ?? policy.departmentName,
          quotaLimit: input.quotaLimit ?? policy.quotaLimit,
          defaultGrantQuota: input.defaultGrantQuota ?? policy.defaultGrantQuota,
          updatedAt: now,
          updatedByFeishuUserId: input.actorFeishuUserId,
        });
        if (input.quotaLimit !== undefined && input.quotaLimit !== previous.quotaLimit) {
          store.quotaChangeEvents.push({
            id: randomId("qce"),
            departmentId: input.departmentId,
            departmentName: policy.departmentName,
            period,
            operatedByFeishuUserId: input.actorFeishuUserId,
            kind: "department_limit_set",
            status: "applied",
            previousValue: previous.quotaLimit,
            nextValue: input.quotaLimit,
            delta: input.quotaLimit - previous.quotaLimit,
            createdAt: now,
            updatedAt: now,
          });
        }
        if (
          input.defaultGrantQuota !== undefined &&
          input.defaultGrantQuota !== previous.defaultGrantQuota
        ) {
          store.quotaChangeEvents.push({
            id: randomId("qce"),
            departmentId: input.departmentId,
            departmentName: policy.departmentName,
            period,
            operatedByFeishuUserId: input.actorFeishuUserId,
            kind: "department_default_set",
            status: "applied",
            previousValue: previous.defaultGrantQuota,
            nextValue: input.defaultGrantQuota,
            delta: input.defaultGrantQuota - previous.defaultGrantQuota,
            createdAt: now,
            updatedAt: now,
          });
        }
        return mapDepartmentQuotaSummary(store, policy);
      }),
    ),
  );
}

const pendingDepartmentQuotaRequestStatuses = new Set<DepartmentQuotaRequest["status"]>([
  "pending_card_send",
  "pending_card_approval",
  "approval_card_send_failed",
]);

async function createDepartmentQuotaRequest(input: {
  departmentId: string;
  departmentName?: string;
  period?: string;
  requesterFeishuUserId: string;
  action: DepartmentQuotaRequest["action"];
  reason: string;
  requestedQuotaLimit?: number;
  approvalTargetOpenId: string;
  approvalActionNonceHash: string;
}) {
  const period = input.period ?? (await getCurrentPackageBillingPeriod());
  return withDepartmentQuotaLock(input.departmentId, period, async () => {
    const policy = await ensureDepartmentQuotaPeriodUnlocked(
      input.departmentId,
      period,
      input.departmentName,
    );
    const store = await readStore();
    const duplicate = store.departmentQuotaRequests.find(
      (request) =>
        request.departmentId === input.departmentId &&
        request.period === period &&
        pendingDepartmentQuotaRequestStatuses.has(request.status),
    );
    if (duplicate) throw new Error("当前部门已有总额度申请正在处理");
    const allocatedQuota = allocatedDepartmentQuota(store, input.departmentId, period);
    if (input.action === "increase") {
      if (input.requestedQuotaLimit === undefined) {
        throw new Error("提高额度申请必须填写目标额度上限");
      }
      const limitError = validateDepartmentQuotaLimit(
        input.requestedQuotaLimit,
        allocatedQuota,
      );
      if (limitError) throw new Error(limitError);
      if (input.requestedQuotaLimit <= policy.quotaLimit) {
        throw new Error("提高额度申请必须大于当前部门额度上限");
      }
    }
    const now = nowIso();
    return persistDepartmentQuotaRequest({
      id: randomId("dqr"),
      departmentId: input.departmentId,
      departmentName: input.departmentName ?? policy.departmentName,
      period,
      requesterFeishuUserId: input.requesterFeishuUserId,
      action: input.action,
      status: "pending_card_send",
      reason: input.reason,
      currentQuotaLimit: policy.quotaLimit,
      requestedQuotaLimit: input.requestedQuotaLimit,
      approvalTargetOpenId: input.approvalTargetOpenId,
      approvalActionNonceHash: input.approvalActionNonceHash,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function createDepartmentQuotaRequestAsActor(input: {
  actorFeishuUserId: string;
  departmentId: string;
  departmentName?: string;
  period?: string;
  action: DepartmentQuotaRequest["action"];
  reason: string;
  requestedQuotaLimit?: number;
  approvalTargetOpenId: string;
  approvalActionNonceHash: string;
}) {
  if (isPostgresBackend()) {
    throw new Error(
      "PostgreSQL 部门额度申请必须使用 actor-aware 原子事务入口",
    );
  }
  const period = input.period ?? (await getCurrentPackageBillingPeriod());
  if (isPostgresBackend()) {
    return createPostgresDepartmentQuotaRequestAsActor({ ...input, period });
  }
  return withAdminScopeUserLocks([input.actorFeishuUserId], () =>
    withDepartmentQuotaLock(input.departmentId, period, () =>
      mutate(async (store) => {
        const actor = store.users.find((user) => user.id === input.actorFeishuUserId);
        const actorScope = actor
          ? await resolveAdminScopeForKnownUser(actor, store)
          : null;
        if (
          !actor ||
          !actorScope ||
          actorScope.scopeType !== "department" ||
          actorScope.departmentId !== input.departmentId
        ) {
          throw new AdminUserActionAuthorizationError(
            "target_out_of_scope",
            403,
            "当前部门管理员权限已变化，请刷新后重试",
          );
        }
        const duplicate = store.departmentQuotaRequests.find(
          (request) =>
            request.departmentId === input.departmentId &&
            request.period === period &&
            pendingDepartmentQuotaRequestStatuses.has(request.status),
        );
        if (duplicate) throw new Error("当前部门已有总额度申请正在处理");
        const allocatedQuota = allocatedDepartmentQuota(store, input.departmentId, period);
        const now = nowIso();
        let policy = store.departmentQuotaPeriods.find(
          (item) => item.departmentId === input.departmentId && item.period === period,
        );
        if (!policy) {
          policy = {
            id: randomId("dqp"),
            departmentId: input.departmentId,
            departmentName: input.departmentName ?? actor.departmentName,
            period,
            quotaLimit: initialDepartmentQuotaLimit(allocatedQuota),
            defaultGrantQuota: store.settings.defaultMonthlyQuota,
            createdAt: now,
            updatedAt: now,
          };
          store.departmentQuotaPeriods.push(policy);
        }
        if (input.action === "increase") {
          if (input.requestedQuotaLimit === undefined) {
            throw new Error("提高额度申请必须填写目标额度上限");
          }
          const error = validateDepartmentQuotaLimit(
            input.requestedQuotaLimit,
            allocatedQuota,
          );
          if (error) throw new Error(error);
          if (input.requestedQuotaLimit <= policy.quotaLimit) {
            throw new Error("提高额度申请必须大于当前部门额度上限");
          }
        }
        const request: DepartmentQuotaRequest = {
          id: randomId("dqr"),
          departmentId: input.departmentId,
          departmentName: input.departmentName ?? policy.departmentName,
          period,
          requesterFeishuUserId: actor.id,
          action: input.action,
          status: "pending_card_send",
          reason: input.reason,
          currentQuotaLimit: policy.quotaLimit,
          requestedQuotaLimit: input.requestedQuotaLimit,
          approvalTargetOpenId: input.approvalTargetOpenId,
          approvalActionNonceHash: input.approvalActionNonceHash,
          createdAt: now,
          updatedAt: now,
        };
        store.departmentQuotaRequests.push(request);
        return request;
      }),
    ),
  );
}

export async function findDepartmentQuotaRequestById(id: string) {
  const store = await readStore();
  return store.departmentQuotaRequests.find((request) => request.id === id) ?? null;
}

export async function updateDepartmentQuotaRequest(
  id: string,
  patch: Partial<Omit<DepartmentQuotaRequest, "id" | "createdAt">>,
  allowedStatuses?: DepartmentQuotaRequest["status"][],
) {
  if (isPostgresBackend()) {
    return updatePostgresDepartmentQuotaRequest(id, patch, allowedStatuses);
  }
  return mutate((store) => {
    const request = store.departmentQuotaRequests.find((item) => item.id === id);
    if (!request || (allowedStatuses && !allowedStatuses.includes(request.status))) return null;
    Object.assign(request, patch, { updatedAt: nowIso() });
    return request;
  });
}

async function decideDepartmentQuotaRequest(input: {
  requestId: string;
  action: "approve" | "reject";
  approvedQuotaLimit?: number;
  operatedByFeishuUserId: string;
  approvalOperatorOpenId: string;
}) {
  const initial = await findDepartmentQuotaRequestById(input.requestId);
  if (!initial) return null;
  return withDepartmentQuotaLock(initial.departmentId, initial.period, async () => {
    const request = await findDepartmentQuotaRequestById(input.requestId);
    if (!request || !pendingDepartmentQuotaRequestStatuses.has(request.status)) return null;
    const operatedAt = nowIso();
    if (input.action === "reject") {
      return updateDepartmentQuotaRequest(
        request.id,
        {
          status: "rejected",
          approvalOperatorOpenId: input.approvalOperatorOpenId,
          approvalOperatedAt: operatedAt,
          errorMessage: undefined,
        },
        [...pendingDepartmentQuotaRequestStatuses],
      );
    }

    const policy = await ensureDepartmentQuotaPeriodUnlocked(
      request.departmentId,
      request.period,
      request.departmentName,
    );
    const store = await readStore();
    const allocatedQuota = allocatedDepartmentQuota(store, request.departmentId, request.period);
    const pendingReservedQuota = summarizeDepartmentQuota({
      policy,
      allocatedQuota,
      events: store.quotaChangeEvents.filter(
        (event) =>
          event.departmentId === request.departmentId && event.period === request.period,
      ),
    }).pendingReservedQuota;
    const approvedQuotaLimit = input.approvedQuotaLimit ?? request.requestedQuotaLimit;
    if (approvedQuotaLimit === undefined) {
      throw new Error("重置额度申请需要系统管理员填写审批额度");
    }
    const limitError = validateDepartmentQuotaLimit(
      approvedQuotaLimit,
      allocatedQuota + pendingReservedQuota,
    );
    if (limitError) throw new Error(limitError);
    if (request.action === "increase" && approvedQuotaLimit <= policy.quotaLimit) {
      throw new Error("提高额度审批值必须大于当前部门额度上限");
    }
    const updatedPolicy: DepartmentQuotaPeriod = {
      ...policy,
      quotaLimit: approvedQuotaLimit,
      updatedAt: operatedAt,
      updatedByFeishuUserId: input.operatedByFeishuUserId,
    };
    await persistDepartmentQuotaPeriod(updatedPolicy);
    await persistQuotaChangeEvent({
      id: randomId("qce"),
      departmentId: request.departmentId,
      departmentName: request.departmentName,
      period: request.period,
      operatedByFeishuUserId: input.operatedByFeishuUserId,
      kind: "department_limit_set",
      status: "applied",
      previousValue: policy.quotaLimit,
      nextValue: approvedQuotaLimit,
      delta: approvedQuotaLimit - policy.quotaLimit,
      relatedDepartmentQuotaRequestId: request.id,
      createdAt: operatedAt,
      updatedAt: operatedAt,
    });
    return updateDepartmentQuotaRequest(
      request.id,
      {
        status: "approved",
        approvedQuotaLimit,
        approvalOperatorOpenId: input.approvalOperatorOpenId,
        approvalOperatedAt: operatedAt,
        errorMessage: undefined,
      },
      [...pendingDepartmentQuotaRequestStatuses],
    );
  });
}

export async function decideDepartmentQuotaRequestAsActor(input: {
  requestId: string;
  action: "approve" | "reject";
  approvedQuotaLimit?: number;
  actorFeishuUserId: string;
}) {
  if (isPostgresBackend()) {
    throw new Error(
      "PostgreSQL 部门额度审批必须使用 actor-aware 原子事务入口",
    );
  }
  if (isPostgresBackend()) {
    const result = await decidePostgresDepartmentQuotaRequestAsActor(input);
    return result && "request" in result ? result.request : result;
  }
  const snapshot = await readStore();
  const identity = snapshot.departmentQuotaRequests.find(
    (request) => request.id === input.requestId,
  );
  if (!identity) return null;
  return withAdminScopeUserLocks([input.actorFeishuUserId], () =>
    withDepartmentQuotaLock(identity.departmentId, identity.period, () =>
      mutate(async (store) => {
        const actor = store.users.find((user) => user.id === input.actorFeishuUserId);
        const actorScope = actor
          ? await resolveAdminScopeForKnownUser(actor, store)
          : null;
        if (!actor || !actorScope || actorScope.scopeType !== "global") {
          throw new AdminUserActionAuthorizationError(
            "actor_scope_missing",
            403,
            "只有当前有效的系统管理员可以审批部门额度申请",
          );
        }
        const request = store.departmentQuotaRequests.find(
          (item) => item.id === input.requestId,
        );
        if (!request || !pendingDepartmentQuotaRequestStatuses.has(request.status)) {
          return null;
        }
        const now = nowIso();
        if (input.action === "reject") {
          Object.assign(request, {
            status: "rejected" as const,
            approvalOperatorOpenId: actor.openId,
            approvalOperatedAt: now,
            errorMessage: undefined,
            updatedAt: now,
          });
          return request;
        }
        const allocatedQuota = allocatedDepartmentQuota(
          store,
          request.departmentId,
          request.period,
        );
        let policy = store.departmentQuotaPeriods.find(
          (item) =>
            item.departmentId === request.departmentId && item.period === request.period,
        );
        if (!policy) {
          policy = {
            id: randomId("dqp"),
            departmentId: request.departmentId,
            departmentName: request.departmentName,
            period: request.period,
            quotaLimit: initialDepartmentQuotaLimit(allocatedQuota),
            defaultGrantQuota: store.settings.defaultMonthlyQuota,
            createdAt: now,
            updatedAt: now,
          };
          store.departmentQuotaPeriods.push(policy);
        }
        const pendingReservedQuota = summarizeDepartmentQuota({
          policy,
          allocatedQuota,
          events: store.quotaChangeEvents.filter(
            (event) =>
              event.departmentId === request.departmentId &&
              event.period === request.period,
          ),
        }).pendingReservedQuota;
        const approvedQuotaLimit =
          input.approvedQuotaLimit ?? request.requestedQuotaLimit;
        if (approvedQuotaLimit === undefined) {
          throw new Error("重置额度申请需要系统管理员填写审批额度");
        }
        const error = validateDepartmentQuotaLimit(
          approvedQuotaLimit,
          allocatedQuota + pendingReservedQuota,
        );
        if (error) throw new Error(error);
        if (request.action === "increase" && approvedQuotaLimit <= policy.quotaLimit) {
          throw new Error("提高额度审批值必须大于当前部门额度上限");
        }
        const previousValue = policy.quotaLimit;
        policy.quotaLimit = approvedQuotaLimit;
        policy.updatedAt = now;
        policy.updatedByFeishuUserId = input.actorFeishuUserId;
        store.quotaChangeEvents.push({
          id: `qce_department_request_${request.id}`,
          departmentId: request.departmentId,
          departmentName: request.departmentName,
          period: request.period,
          operatedByFeishuUserId: input.actorFeishuUserId,
          kind: "department_limit_set",
          status: "applied",
          previousValue,
          nextValue: approvedQuotaLimit,
          delta: approvedQuotaLimit - previousValue,
          relatedDepartmentQuotaRequestId: request.id,
          createdAt: now,
          updatedAt: now,
        });
        Object.assign(request, {
          status: "approved" as const,
          approvedQuotaLimit,
          approvalOperatorOpenId: actor.openId,
          approvalOperatedAt: now,
          errorMessage: undefined,
          updatedAt: now,
        });
        return request;
      }),
    ),
  );
}

export async function getEffectiveUserGrantQuota(feishuUserId: string) {
  const period = await getCurrentPackageBillingPeriod();
  if (isPostgresBackend()) {
    // Existing users almost always have a current billing row. Read it first
    // so a key-reset submit consumes one control checkout instead of two.
    const billing = await getPostgresUserBillingPeriod(feishuUserId, period);
    if (billing) return billing.monthlyQuota;
    const user = await getPostgresUserById(feishuUserId);
    if (!user?.departmentId) {
      return (await getAppSettingsForQuotaOperation()).defaultMonthlyQuota;
    }
    const policy = await ensureDepartmentQuotaPeriod({
      departmentId: user.departmentId,
      departmentName: user.departmentName,
      period,
    });
    return policy.defaultGrantQuota;
  }
  const store = await readStore();
  const user = store.users.find((item) => item.id === feishuUserId);
  const billing = store.userBillingPeriods.find(
    (item) => item.feishuUserId === feishuUserId && item.period === period,
  );
  if (billing && (billing.monthlyQuota > 0 || billing.assignedQuotaUpdatedAt)) {
    return billing.monthlyQuota;
  }
  if (!user?.departmentId) return store.settings.defaultMonthlyQuota;
  const policy = await ensureDepartmentQuotaPeriod({
    departmentId: user.departmentId,
    departmentName: user.departmentName,
    period,
  });
  return policy.defaultGrantQuota;
}

export async function assertFirstProvisionDepartmentCapacity(input: {
  feishuUserId: string;
  requestedMonthlyQuota: number;
  requestId?: string;
}) {
  const initialStore = await readStore();
  const user = initialStore.users.find((item) => item.id === input.feishuUserId);
  if (!user?.departmentId) return;
  const period = await getCurrentPackageBillingPeriod();
  await ensureDepartmentQuotaPeriod({
    departmentId: user.departmentId,
    departmentName: user.departmentName,
    period,
  });
  const store = await readStore();
  const policy = store.departmentQuotaPeriods.find(
    (item) => item.departmentId === user.departmentId && item.period === period,
  );
  if (!policy) throw new Error("部门账期预算不存在");
  const quotaPerUnit = getConfig().newapi.quotaPerUnit;
  const requestedQuota = Math.max(Math.round(input.requestedMonthlyQuota * quotaPerUnit), 0);
  const billing = store.userBillingPeriods.find(
    (item) => item.feishuUserId === user.id && item.period === period,
  );
  const authorizedQuotaBefore = Math.max(billing?.authorizedQuota ?? 0, 0);
  const requiredQuota = Math.max(requestedQuota - authorizedQuotaBefore, 0);
  const existingOperation = input.requestId
    ? store.quotaOperations.find(
        (item) => item.idempotencyKey === `quota-operation:${input.requestId}`,
      )
    : undefined;
  if ((existingOperation?.reservedDepartmentQuota ?? 0) >= requiredQuota) return;
  const committedQuota = store.quotaLedgerEntries
    .filter(
      (item) => item.departmentId === user.departmentId && item.period === period,
    )
    .reduce((sum, item) => sum + item.signedQuota, 0);
  const pendingQuota = store.quotaOperations
    .filter(
      (item) =>
        item.id !== existingOperation?.id &&
        item.departmentId === user.departmentId &&
        item.billingPeriod === period &&
        item.state !== "completed" &&
        item.state !== "compensated" &&
        item.state !== "cancelled",
    )
    .reduce((sum, item) => sum + Math.max(item.reservedDepartmentQuota, 0), 0);
  const availableQuota = Math.max(
    Math.round(policy.quotaLimit * quotaPerUnit) -
      Math.max(committedQuota, 0) -
      Math.max(pendingQuota, 0),
    0,
  );
  if (requiredQuota > availableQuota) {
    throw new Error(
      `部门可用额度不足：首次发放需要 ${requiredQuota / quotaPerUnit}，当前可用 ${availableQuota / quotaPerUnit}`,
    );
  }
}

export async function reserveDepartmentQuotaForTokenRequest(request: TokenRequest) {
  if (request.requestType === "key_reset") return null;
  const initialStore = await readStore();
  const user = initialStore.users.find((item) => item.id === request.feishuUserId);
  if (!user?.departmentId) return null;
  const period = await getCurrentPackageBillingPeriod();
  return withDepartmentQuotaLock(user.departmentId, period, async () => {
    const policy = await ensureDepartmentQuotaPeriodUnlocked(
      user.departmentId!,
      period,
      user.departmentName,
    );
    const store = await readStore();
    const existing = store.quotaChangeEvents.find(
      (event) => event.relatedTokenRequestId === request.id,
    );
    if (existing?.status === "applied") return existing;
    const billing = store.userBillingPeriods.find(
      (item) => item.feishuUserId === user.id && item.period === period,
    );
    const previousValue = billing?.monthlyQuota ?? 0;
    const nextValue = request.approvedMonthlyQuota ?? request.requestedMonthlyQuota;
    const usage = summarizeDepartmentQuota({
      policy,
      allocatedQuota: allocatedDepartmentQuota(store, user.departmentId!, period),
      events: store.quotaChangeEvents.filter(
        (event) =>
          event.departmentId === user.departmentId &&
          event.period === period &&
          event.id !== existing?.id,
      ),
    });
    const allocationError = validateDepartmentAllocation({
      nextQuota: nextValue,
      previousQuota: previousValue,
      availableQuota: usage.availableQuota,
    });
    if (allocationError) throw new Error(allocationError);
    const now = nowIso();
    const operator = request.approvalOperatorOpenId
      ? store.users.find((item) => item.openId === request.approvalOperatorOpenId)
      : undefined;
    const event: QuotaChangeEvent = {
      id: existing?.id ?? randomId("qce"),
      departmentId: user.departmentId!,
      departmentName: user.departmentName,
      period,
      feishuUserId: user.id,
      operatedByFeishuUserId: operator?.id ?? request.feishuUserId,
      kind: "user_quota_allocate",
      status: "pending",
      previousValue,
      nextValue,
      delta: nextValue - previousValue,
      relatedTokenRequestId: request.id,
      expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return persistQuotaChangeEvent(event);
  });
}

export async function completeDepartmentQuotaReservation(eventId: string) {
  const firstStore = await readStore();
  const first = firstStore.quotaChangeEvents.find((event) => event.id === eventId);
  if (!first) return null;
  return withDepartmentQuotaLock(first.departmentId, first.period, async () => {
    const store = await readStore();
    const event = store.quotaChangeEvents.find((item) => item.id === eventId);
    if (!event) return null;
    if (event.status === "applied") return event;
    if (!event.feishuUserId) throw new Error("额度预留缺少目标用户");
    const existing = store.userBillingPeriods.find(
      (item) => item.feishuUserId === event.feishuUserId && item.period === event.period,
    );
    const now = nowIso();
    const billing: UserBillingPeriod = {
      id: existing?.id ?? randomId("bp"),
      feishuUserId: event.feishuUserId,
      period: event.period,
      monthlyQuota: event.nextValue,
      quotaConsumed: existing?.quotaConsumed ?? 0,
      cost: existing?.cost ?? 0,
      remainingQuota: Math.max(event.nextValue - (existing?.quotaConsumed ?? 0), 0),
      promptTokens: existing?.promptTokens ?? 0,
      completionTokens: existing?.completionTokens ?? 0,
      totalTokens: existing?.totalTokens ?? 0,
      proxyLogCount: existing?.proxyLogCount ?? 0,
      usageRecordCount: existing?.usageRecordCount ?? 0,
      activeTokenAccountId: existing?.activeTokenAccountId,
      tokenAccountIds: existing?.tokenAccountIds ?? [],
      assignedQuotaUpdatedAt: now,
      assignedQuotaUpdatedByFeishuUserId: event.operatedByFeishuUserId,
      updatedAt: now,
    };
    await persistUserBillingPeriod(billing);
    return persistQuotaChangeEvent({
      ...event,
      status: "applied",
      expiresAt: undefined,
      errorMessage: undefined,
      updatedAt: now,
    });
  });
}

export async function failDepartmentQuotaReservation(eventId: string, errorMessage: string) {
  const firstStore = await readStore();
  const first = firstStore.quotaChangeEvents.find((event) => event.id === eventId);
  if (!first) return null;
  return withDepartmentQuotaLock(first.departmentId, first.period, async () => {
    const store = await readStore();
    const event = store.quotaChangeEvents.find((item) => item.id === eventId);
    if (!event || event.status === "applied") return event ?? null;
    return persistQuotaChangeEvent({
      ...event,
      status: "failed",
      expiresAt: undefined,
      errorMessage,
      updatedAt: nowIso(),
    });
  });
}

export async function assignDepartmentUserQuota(input: {
  departmentId: string;
  departmentName?: string;
  feishuUserId: string;
  nextQuota: number;
  operatedByFeishuUserId: string;
  period?: string;
}) {
  const period = input.period ?? (await getCurrentPackageBillingPeriod());
  return withDepartmentQuotaLock(input.departmentId, period, async () => {
    const policy = await ensureDepartmentQuotaPeriodUnlocked(
      input.departmentId,
      period,
      input.departmentName,
    );
    const store = await readStore();
    const user = store.users.find((item) => item.id === input.feishuUserId);
    if (!user || user.departmentId !== input.departmentId || user.status === "deleted") {
      throw new Error("用户不存在、不属于当前部门或已删除");
    }
    const existing = store.userBillingPeriods.find(
      (item) => item.feishuUserId === user.id && item.period === period,
    );
    const previousValue = existing?.monthlyQuota ?? 0;
    const usage = summarizeDepartmentQuota({
      policy,
      allocatedQuota: allocatedDepartmentQuota(store, input.departmentId, period),
      events: store.quotaChangeEvents.filter(
        (event) => event.departmentId === input.departmentId && event.period === period,
      ),
    });
    const allocationError = validateDepartmentAllocation({
      nextQuota: input.nextQuota,
      previousQuota: previousValue,
      availableQuota: usage.availableQuota,
    });
    if (allocationError) throw new Error(allocationError);
    const now = nowIso();
    const billing: UserBillingPeriod = {
      id: existing?.id ?? randomId("bp"),
      feishuUserId: user.id,
      period,
      monthlyQuota: input.nextQuota,
      quotaConsumed: existing?.quotaConsumed ?? 0,
      cost: existing?.cost ?? 0,
      remainingQuota: Math.max(input.nextQuota - (existing?.quotaConsumed ?? 0), 0),
      promptTokens: existing?.promptTokens ?? 0,
      completionTokens: existing?.completionTokens ?? 0,
      totalTokens: existing?.totalTokens ?? 0,
      proxyLogCount: existing?.proxyLogCount ?? 0,
      usageRecordCount: existing?.usageRecordCount ?? 0,
      activeTokenAccountId: existing?.activeTokenAccountId,
      tokenAccountIds: existing?.tokenAccountIds ?? [],
      assignedQuotaUpdatedAt: now,
      assignedQuotaUpdatedByFeishuUserId: input.operatedByFeishuUserId,
      updatedAt: now,
    };
    await persistUserBillingPeriod(billing);
    const event = await persistQuotaChangeEvent({
      id: randomId("qce"),
      departmentId: input.departmentId,
      departmentName: input.departmentName ?? policy.departmentName,
      period,
      feishuUserId: user.id,
      operatedByFeishuUserId: input.operatedByFeishuUserId,
      kind: "user_quota_allocate",
      status: "applied",
      previousValue,
      nextValue: input.nextQuota,
      delta: input.nextQuota - previousValue,
      createdAt: now,
      updatedAt: now,
    });
    return { billing, event };
  });
}

export async function findActiveTokenByHash(keyHash: string) {
  if (isPostgresBackend()) return findPostgresActiveTokenByHash(keyHash);

  const store = await readStore();
  return (
    store.tokenAccounts.find(
      (account) =>
        account.keyHash === keyHash &&
        (account.status === "active" ||
          account.status === "draining" ||
          account.status === "settling"),
    ) ?? null
  );
}

const prewarmTokenReservationStatuses = new Set<TokenStatus>([
  "pending_activation",
  "active",
  "draining",
  "settling",
]);

function userHasPrewarmReservation(store: StoreShape, feishuUserId: string) {
  return store.tokenAccounts.some(
    (account) =>
      account.feishuUserId === feishuUserId &&
      prewarmTokenReservationStatuses.has(account.status),
  );
}

function userHasOpenPrewarmQuotaOperation(
  store: StoreShape,
  feishuUserId: string,
) {
  return store.quotaOperations.some(
    (operation) =>
      operation.feishuUserId === feishuUserId &&
      !["completed", "compensated", "cancelled"].includes(operation.state),
  );
}

export async function listDepartmentPrewarmCandidates(input: {
  departmentId: string;
  limit: number;
}) {
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 100);
  if (isPostgresBackend()) {
    return listPostgresPrewarmDepartmentCandidates({
      departmentId: input.departmentId,
      limit,
    });
  }
  const store = await readStore();
  const eligibleUsers = store.users
    .filter(
      (user) =>
        user.departmentId === input.departmentId &&
        (!user.status || user.status === "active") &&
        !userHasPrewarmReservation(store, user.id) &&
        !userHasOpenPrewarmQuotaOperation(store, user.id),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    candidates: eligibleUsers.slice(0, limit),
    eligible: eligibleUsers.length,
  };
}

export async function reservePrewarmedTokenAccountUnderUserFence(input: {
  departmentId: string;
  account: TokenAccount;
}) {
  if (
    input.account.status !== "pending_activation" ||
    input.account.prewarmDepartmentId !== input.departmentId ||
    !input.account.newapiTokenId ||
    !input.account.prewarmedCredentialCiphertext
  ) {
    throw new Error("预热 Key 本地账户不完整");
  }
  if (isPostgresBackend()) {
    return insertPostgresPrewarmedTokenAccountIfEligible(input);
  }
  return mutate((store) => {
    const user = store.users.find(
      (candidate) =>
        candidate.id === input.account.feishuUserId &&
        candidate.departmentId === input.departmentId &&
        (!candidate.status || candidate.status === "active"),
    );
    if (
      !user ||
      userHasPrewarmReservation(store, user.id) ||
      userHasOpenPrewarmQuotaOperation(store, user.id)
    ) {
      return null;
    }
    store.tokenAccounts.push(input.account);
    return input.account;
  });
}

export async function claimStoredPrewarmedTokenAccountUnderUserFence(input: {
  feishuUserId: string;
  tokenRequestId: string;
  billingPeriod: string;
  operationGeneration?: number;
}) {
  if (isPostgresBackend()) return claimPostgresPrewarmedTokenAccount(input);
  return mutate((store) => {
    const account = store.tokenAccounts.find(
      (candidate) =>
        candidate.feishuUserId === input.feishuUserId &&
        candidate.status === "pending_activation" &&
        Boolean(candidate.newapiTokenId) &&
        Boolean(candidate.prewarmedCredentialCiphertext),
    );
    if (!account?.newapiTokenId || !account.prewarmedCredentialCiphertext) return null;
    Object.assign(account, {
      tokenRequestId: input.tokenRequestId,
      billingPeriod: input.billingPeriod,
      operationGeneration:
        input.operationGeneration ?? account.operationGeneration,
    });
    return account;
  });
}

type AddTokenAccountInput = {
  feishuUserId: string;
  tokenRequestId: string;
  keyHash: string;
  newapiTokenId?: string;
  billingPeriod?: string;
  status?: TokenStatus;
  operationGeneration?: number;
  activatedAt?: string;
  prewarmedAt?: string;
  prewarmDepartmentId?: string;
  prewarmedCredentialCiphertext?: string;
};

function tokenAccountFromInput(input: AddTokenAccountInput) {
  const now = nowIso();
  return {
    id: randomId("ta"),
    feishuUserId: input.feishuUserId,
    tokenRequestId: input.tokenRequestId,
    keyHash: input.keyHash,
    newapiTokenId: input.newapiTokenId,
    status: input.status ?? "active",
    billingPeriod: input.billingPeriod ?? now.slice(0, 7),
    operationGeneration: input.operationGeneration,
    activatedAt: input.activatedAt ?? (input.status && input.status !== "active" ? undefined : now),
    prewarmedAt: input.prewarmedAt,
    prewarmDepartmentId: input.prewarmDepartmentId,
    prewarmedCredentialCiphertext: input.prewarmedCredentialCiphertext,
    createdAt: now,
  } satisfies TokenAccount;
}

export async function addTokenAccount(input: AddTokenAccountInput) {
  if (isPostgresBackend()) {
    return insertPostgresTokenAccount(tokenAccountFromInput(input));
  }

  return mutate((store) => {
    const account = tokenAccountFromInput(input);
    store.tokenAccounts.push(account);
    return account;
  });
}

export async function addTokenAccountForQuotaOperation(input: AddTokenAccountInput) {
  if (isPostgresBackend()) {
    return insertPostgresTokenAccountForQuotaOperation(tokenAccountFromInput(input));
  }
  return addTokenAccount(input);
}

export async function replaceActiveTokenAccount(input: {
  oldTokenAccountId: string;
  feishuUserId: string;
  tokenRequestId: string;
  keyHash: string;
  newapiTokenId?: string;
  billingPeriod?: string;
}) {
  if (isPostgresBackend()) {
    const now = nowIso();
    const account: TokenAccount = {
      id: randomId("ta"),
      feishuUserId: input.feishuUserId,
      tokenRequestId: input.tokenRequestId,
      keyHash: input.keyHash,
      newapiTokenId: input.newapiTokenId,
      status: "active",
      billingPeriod: input.billingPeriod ?? now.slice(0, 7),
      createdAt: now,
    };
    return replacePostgresActiveTokenAccount({
      oldTokenAccountId: input.oldTokenAccountId,
      account,
    });
  }

  return mutate((store) => {
    const oldAccount = store.tokenAccounts.find(
      (account) =>
        account.id === input.oldTokenAccountId &&
        account.feishuUserId === input.feishuUserId &&
        account.status === "active",
    );
    if (!oldAccount) return null;

    const now = nowIso();
    const account: TokenAccount = {
      id: randomId("ta"),
      feishuUserId: input.feishuUserId,
      tokenRequestId: input.tokenRequestId,
      keyHash: input.keyHash,
      newapiTokenId: input.newapiTokenId,
      status: "active",
      billingPeriod: input.billingPeriod ?? oldAccount.billingPeriod ?? now.slice(0, 7),
      createdAt: now,
    };
    oldAccount.status = "replaced";
    oldAccount.disabledAt = now;
    oldAccount.replacedByTokenAccountId = account.id;
    store.tokenAccounts.push(account);
    return account;
  });
}

export async function addFeishuEvent(event: Omit<FeishuEvent, "id" | "createdAt">) {
  if (isPostgresBackend()) return upsertPostgresFeishuEvent(event);

  return mutate((store) => {
    const existing = store.feishuEvents.find(
      (item) => item.eventUuid === event.eventUuid,
    );
    if (existing) {
      Object.assign(existing, event);
      return existing;
    }

    const stored: FeishuEvent = {
      id: randomId("fe"),
      createdAt: nowIso(),
      ...event,
    };
    store.feishuEvents.push(stored);
    return stored;
  });
}

export async function getFeishuEventByUuid(eventUuid: string) {
  if (isPostgresBackend()) return getPostgresFeishuEventByUuid(eventUuid);

  const store = await readStore();
  return store.feishuEvents.find((event) => event.eventUuid === eventUuid) ?? null;
}

export async function addProxyLog(log: Omit<ProxyRequestLog, "id" | "createdAt">) {
  if (isPostgresBackend()) {
    const now = nowIso();
    const stored: ProxyRequestLog = {
      id: randomId("pl"),
      createdAt: now,
      updatedAt: now,
      ...log,
      status:
        log.status ??
        (log.statusCode === 499
          ? "cancelled"
          : log.statusCode >= 400
            ? "failed"
            : "completed"),
    };
    return insertPostgresProxyLog(stored);
  }

  return mutate((store) => {
    const now = nowIso();
    const stored: ProxyRequestLog = {
      id: randomId("pl"),
      createdAt: now,
      updatedAt: now,
      ...log,
      status:
        log.status ??
        (log.statusCode === 499
          ? "cancelled"
          : log.statusCode >= 400
            ? "failed"
            : "completed"),
    };
    store.proxyRequestLogs.push(stored);
    return stored;
  });
}

export async function beginProxyLog(
  log: Omit<ProxyRequestLog, "id" | "createdAt" | "statusCode" | "durationMs"> &
    Partial<Pick<ProxyRequestLog, "statusCode" | "durationMs">>,
) {
  if (isPostgresBackend()) {
    const now = nowIso();
    const stored: ProxyRequestLog = {
      id: randomId("pl"),
      createdAt: now,
      updatedAt: now,
      statusCode: log.statusCode ?? 0,
      durationMs: log.durationMs ?? 0,
      ...log,
      status: log.status ?? "pending",
    };
    return insertPostgresProxyLog(stored);
  }

  return mutate((store) => {
    const now = nowIso();
    const stored: ProxyRequestLog = {
      id: randomId("pl"),
      createdAt: now,
      updatedAt: now,
      statusCode: log.statusCode ?? 0,
      durationMs: log.durationMs ?? 0,
      ...log,
      status: log.status ?? "pending",
    };
    store.proxyRequestLogs.push(stored);
    return stored;
  });
}

export async function finalizeTokenRotation(input: {
  feishuUserId: string;
  oldTokenAccountId: string;
  newTokenAccountId: string;
  operationGeneration: number;
  operationId: string;
}) {
  const now = nowIso();
  if (isPostgresBackend()) {
    return finalizePostgresTokenRotation({ ...input, now });
  }
  return mutate((store) => {
    const oldAccount = store.tokenAccounts.find(
      (item) =>
        item.id === input.oldTokenAccountId && item.feishuUserId === input.feishuUserId,
    );
    const newAccount = store.tokenAccounts.find(
      (item) =>
        item.id === input.newTokenAccountId && item.feishuUserId === input.feishuUserId,
    );
    if (!oldAccount || !newAccount) throw new Error("Key 轮换本地账号记录不完整");
    oldAccount.status = "replaced";
    oldAccount.disabledAt = now;
    oldAccount.replacedByTokenAccountId = newAccount.id;
    newAccount.status = "active";
    newAccount.operationGeneration = input.operationGeneration;
    newAccount.activatedAt = now;
    const state: UserQuotaState = {
      feishuUserId: input.feishuUserId,
      admission: "open",
      activeGeneration: input.operationGeneration,
      updatedAt: now,
    };
    const stateIndex = store.userQuotaStates.findIndex(
      (item) => item.feishuUserId === input.feishuUserId,
    );
    if (stateIndex === -1) store.userQuotaStates.push(state);
    else store.userQuotaStates[stateIndex] = state;
    return { oldAccount, newAccount, state };
  });
}

export async function finalizeTokenRotationForQuotaOperation(input: {
  feishuUserId: string;
  oldTokenAccountId: string;
  newTokenAccountId: string;
  operationGeneration: number;
  operationId: string;
}) {
  if (isPostgresBackend()) {
    return finalizePostgresTokenRotationForQuotaOperation({ ...input, now: nowIso() });
  }
  return finalizeTokenRotation(input);
}

export async function finalizeTokenProvision(input: {
  feishuUserId: string;
  tokenAccountId: string;
  operationGeneration: number;
}) {
  const now = nowIso();
  if (isPostgresBackend()) {
    return finalizePostgresTokenProvision({ ...input, now });
  }
  return mutate((store) => {
    const account = store.tokenAccounts.find(
      (item) =>
        item.id === input.tokenAccountId && item.feishuUserId === input.feishuUserId,
    );
    if (!account) throw new Error("首次发放本地 TokenAccount 不存在");
    const otherActive = store.tokenAccounts.find(
      (item) =>
        item.feishuUserId === input.feishuUserId &&
        item.id !== input.tokenAccountId &&
        item.status === "active",
    );
    if (otherActive) throw new Error("首次发放期间用户已出现其他 active Key");
    account.status = "active";
    account.operationGeneration = input.operationGeneration;
    account.activatedAt ??= now;
    const state: UserQuotaState = {
      feishuUserId: input.feishuUserId,
      admission: "open",
      activeGeneration: input.operationGeneration,
      updatedAt: now,
    };
    const stateIndex = store.userQuotaStates.findIndex(
      (item) => item.feishuUserId === input.feishuUserId,
    );
    if (stateIndex === -1) store.userQuotaStates.push(state);
    else store.userQuotaStates[stateIndex] = state;
    return { account, state };
  });
}

export async function beginQuotaAwareProxyLog(
  account: TokenAccount,
  log: Omit<ProxyRequestLog, "id" | "createdAt" | "statusCode" | "durationMs"> &
    Partial<Pick<ProxyRequestLog, "statusCode" | "durationMs">>,
) {
  if (isPostgresBackend()) {
    const now = nowIso();
    return insertPostgresQuotaAwareProxyLog(account, {
      id: randomId("pl"),
      createdAt: now,
      updatedAt: now,
      statusCode: log.statusCode ?? 0,
      durationMs: log.durationMs ?? 0,
      ...log,
      status: log.status ?? "pending",
      billingPeriod: account.billingPeriod,
      heartbeatAt: now,
      leaseExpiresAt: new Date(new Date(now).getTime() + 2 * 60_000).toISOString(),
    });
  }
  return withUserQuotaOperationLock(account.feishuUserId, async () => {
    const state = await getUserQuotaState(account.feishuUserId);
    assertQuotaAdmission(state, account);
    const now = nowIso();
    return beginProxyLog({
      ...log,
      billingPeriod: account.billingPeriod,
      operationGeneration: state.activeGeneration,
      heartbeatAt: now,
      leaseExpiresAt: new Date(new Date(now).getTime() + 2 * 60_000).toISOString(),
    });
  });
}

export async function beginQuotaAwareProxyRequest(
  keyHash: string,
  log: ProxyAdmissionLogInput,
): Promise<ProxyRequestAdmissionResult> {
  if (isPostgresBackend()) {
    return beginPostgresQuotaAwareProxyRequest(keyHash, log);
  }

  const account = await findActiveTokenByHash(keyHash);
  if (!account) return { status: "inactive_token" };
  const user = await getUserById(account.feishuUserId);
  if (!user) return { status: "bound_user_missing", account };
  if (user.status === "disabled" || user.status === "deleted") {
    return { status: "bound_user_inactive", account, user };
  }
  const proxyLog = await beginQuotaAwareProxyLog(account, {
    ...log,
    feishuUserId: user.id,
    tokenAccountId: account.id,
    departmentId: user.departmentId,
    departmentName: user.departmentName,
    providerKeyName: account.newapiTokenId,
  });
  return { status: "admitted", account, user, proxyLog };
}

export async function listInflightProxyRequests(
  feishuUserId: string,
  operationGeneration: number,
  at = nowIso(),
) {
  if (isPostgresBackend()) {
    return listPostgresInflightProxyRequests(
      feishuUserId,
      operationGeneration,
      at,
    );
  }
  const store = await readStore();
  return store.proxyRequestLogs.filter(
    (log) =>
      log.feishuUserId === feishuUserId &&
      (log.operationGeneration ?? 0) === operationGeneration &&
      (log.status === "pending" || log.status === "streaming") &&
      (!log.leaseExpiresAt || log.leaseExpiresAt > at),
  );
}

export async function listInflightProxyRequestsForQuotaOperation(
  feishuUserId: string,
  operationGeneration: number,
  at = nowIso(),
) {
  if (isPostgresBackend()) {
    return listPostgresInflightProxyRequestsForQuotaOperation(
      feishuUserId,
      operationGeneration,
      at,
    );
  }
  return listInflightProxyRequests(feishuUserId, operationGeneration, at);
}

export async function updateProxyLog(
  id: string,
  patch: Partial<Omit<ProxyRequestLog, "id" | "createdAt">>,
) {
  if (isPostgresBackend()) return updatePostgresProxyLog(id, patch);

  return mutate((store) => {
    const log = store.proxyRequestLogs.find((item) => item.id === id);
    if (!log) return null;
    Object.assign(log, patch, { updatedAt: nowIso() });
    if (
      log.totalTokens === undefined &&
      log.promptTokens !== undefined &&
      log.completionTokens !== undefined
    ) {
      log.totalTokens = log.promptTokens + log.completionTokens;
    }
    syncBillingPeriods(store);
    return log;
  });
}

export async function updateProxyUsageSettlementRetryIfUnsettled(
  id: string,
  patch: Partial<Omit<ProxyRequestLog, "id" | "createdAt">>,
) {
  if (isPostgresBackend()) {
    return updatePostgresProxyUsageSettlementRetryIfUnsettled(id, patch);
  }

  return mutate((store) => {
    const log = store.proxyRequestLogs.find((item) => item.id === id);
    if (
      !log ||
      (log.usageSettlementStatus !== "pending" &&
        log.usageSettlementStatus !== "retrying")
    ) {
      return null;
    }
    Object.assign(log, patch, { updatedAt: nowIso() });
    return log;
  });
}

export type NewApiUsageBackfillItem = {
  action:
    | "updated"
    | "matched_no_change"
    | "quarantined_unknown_token"
    | "skipped_no_match";
  newapiLogId?: string;
  newapiRequestId?: string;
  newapiTokenId?: string;
  proxyLogId?: string;
  feishuUserId?: string;
  tokenAccountId?: string;
  billingPeriod?: string;
  usageRecordId?: string;
  issueId?: string;
  newapiCreatedAt?: string;
  blocksSettlement?: boolean;
  cost?: number;
  quota?: number;
  reason?: string;
};

export type NewApiUsageBackfillResult = {
  dryRun: boolean;
  seen: number;
  matched: number;
  updated: number;
  skippedUnknownToken: number;
  skippedNoMatch: number;
  recordsUpserted: number;
  issuesUpserted: number;
  items: NewApiUsageBackfillItem[];
  snapshot?: {
    usageSources: number;
    tokenAccounts: number;
    exactProxyCandidates: number;
    fallbackSources: number;
    fallbackProxyCandidates: number;
    proxyCandidates: number;
    usageRecords: number;
  };
};

function isUnknownModel(value?: string) {
  const normalized = value?.trim().toLowerCase();
  return !normalized || normalized === "unknown" || normalized === "-" || normalized === "null";
}

function buildUsagePatch(
  usageLog: NormalizedNewApiUsageLog,
  currentLog: ProxyRequestLog,
) {
  const patch: Partial<Omit<ProxyRequestLog, "id" | "createdAt">> = {
    usageSource: "newapi_log",
    usageSettlementStatus: "matched",
    usageSettlementLastError: undefined,
    usageSettlementNextRetryAt: undefined,
    usageSettledAt: nowIso(),
  };

  if (usageLog.newapiLogId) patch.newapiLogId = usageLog.newapiLogId;
  if (usageLog.newapiRequestId) {
    if (
      currentLog.newapiRequestId &&
      currentLog.newapiRequestId !== usageLog.newapiRequestId &&
      !currentLog.newapiResponseRequestId
    ) {
      patch.newapiResponseRequestId = currentLog.newapiRequestId;
    }
    patch.newapiRequestId = usageLog.newapiRequestId;
  }
  if (usageLog.newapiUpstreamRequestId) {
    patch.newapiUpstreamRequestId = usageLog.newapiUpstreamRequestId;
  }
  if (usageLog.providerChannelName) patch.providerChannelName = usageLog.providerChannelName;
  if (usageLog.newapiUseTimeSeconds !== undefined) {
    patch.newapiUseTimeSeconds = usageLog.newapiUseTimeSeconds;
  }
  if (usageLog.quota !== undefined) patch.quota = usageLog.quota;
  if (usageLog.cost !== undefined) patch.cost = usageLog.cost;
  if (usageLog.promptTokens !== undefined) patch.promptTokens = usageLog.promptTokens;
  if (usageLog.completionTokens !== undefined) patch.completionTokens = usageLog.completionTokens;
  if (usageLog.totalTokens !== undefined) patch.totalTokens = usageLog.totalTokens;
  if (usageLog.inputTokensTotal !== undefined) {
    patch.inputTokensTotal = usageLog.inputTokensTotal;
  }
  if (usageLog.cacheReadTokens !== undefined) {
    patch.cacheReadTokens = usageLog.cacheReadTokens;
  }
  if (usageLog.cacheCreationTokens !== undefined) {
    patch.cacheCreationTokens = usageLog.cacheCreationTokens;
  }
  if (usageLog.cacheCreationTokens5m !== undefined) {
    patch.cacheCreationTokens5m = usageLog.cacheCreationTokens5m;
  }
  if (usageLog.cacheCreationTokens1h !== undefined) {
    patch.cacheCreationTokens1h = usageLog.cacheCreationTokens1h;
  }
  if (usageLog.usageSemantic !== undefined) {
    patch.usageSemantic = usageLog.usageSemantic;
  }
  if (usageLog.usageFieldSources) {
    patch.usageFieldSources = {
      ...currentLog.usageFieldSources,
      ...usageLog.usageFieldSources,
    };
  }
  if (usageLog.isStream !== undefined) {
    patch.isStream = usageLog.isStream;
    patch.upstreamIsStream = usageLog.isStream;
  }
  if (usageLog.model && isUnknownModel(currentLog.model)) {
    patch.model = usageLog.model;
  }
  if (
    (currentLog.status === "pending" || currentLog.status === "streaming") &&
    (currentLog.upstreamStatusCode ?? currentLog.statusCode) < 400
  ) {
    patch.status = "completed";
    patch.terminalStatus = "completed";
    if (currentLog.statusCode === 0 && currentLog.upstreamStatusCode !== undefined) {
      patch.statusCode = currentLog.upstreamStatusCode;
    }
  }

  return patch;
}

function patchChangesLog(
  log: ProxyRequestLog,
  patch: Partial<Omit<ProxyRequestLog, "id" | "createdAt">>,
) {
  return Object.entries(patch).some(([key, value]) => {
    if (value === undefined) return false;
    return log[key as keyof ProxyRequestLog] !== value;
  });
}

function stableUsageIdentity(usageLog: NormalizedNewApiUsageLog) {
  if (usageLog.newapiTokenId && usageLog.newapiRequestId) {
    return `request:${usageLog.newapiTokenId}:${usageLog.newapiRequestId}`;
  }
  if (usageLog.newapiTokenId && usageLog.newapiLogId) {
    return `log:${usageLog.newapiTokenId}:${usageLog.newapiLogId}`;
  }
  return [
    usageLog.newapiLogId,
    usageLog.newapiRequestId,
    usageLog.newapiTokenId,
    usageLog.createdAt,
    usageLog.model,
    usageLog.quota,
  ]
    .filter((value) => value !== undefined && value !== null && String(value).length > 0)
    .join(":");
}

function stableIssueId(prefix: string, identity: string) {
  return `${prefix}_${identity.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 180) || randomId(prefix)}`;
}

function usageRecordIdFromLog(usageLog: NormalizedNewApiUsageLog) {
  const identity = stableUsageIdentity(usageLog);
  return identity ? stableNewApiUsageRecordId(identity) : randomId("nur");
}

function usageIssueIdFromLog(type: UsageSyncIssueType, usageLog: NormalizedNewApiUsageLog) {
  return stableIssueId(`usi_${type}`, stableUsageIdentity(usageLog));
}

function buildNewApiUsageRecord(input: {
  store: StoreShape;
  usageLog: NormalizedNewApiUsageLog;
  matchStatus: NewApiUsageMatchStatus;
  syncedAt: string;
  account?: TokenAccount;
  proxyLog?: ProxyRequestLog;
}): NewApiUsageRecord {
  const user = input.account ? input.store.users.find((item) => item.id === input.account?.feishuUserId) : undefined;
  return {
    id: usageRecordIdFromLog(input.usageLog),
    newapiLogId: input.usageLog.newapiLogId,
    newapiRequestId: input.usageLog.newapiRequestId,
    newapiUpstreamRequestId: input.usageLog.newapiUpstreamRequestId,
    newapiTokenId: input.usageLog.newapiTokenId,
    tokenAccountId: input.proxyLog?.tokenAccountId ?? input.account?.id,
    feishuUserId: input.proxyLog?.feishuUserId ?? input.account?.feishuUserId,
    departmentId: input.proxyLog?.departmentId ?? user?.departmentId,
    departmentName: input.proxyLog?.departmentName ?? user?.departmentName,
    matchedProxyLogId: input.proxyLog?.id,
    billingPeriod:
      input.proxyLog?.billingPeriod ??
      input.account?.billingPeriod ??
      resolveUsageBillingPeriod({
        occurredAt:
          input.usageLog.createdAt ?? input.syncedAt,
      }),
    matchStatus: input.matchStatus,
    model: input.usageLog.model,
    promptTokens: input.usageLog.promptTokens,
    completionTokens: input.usageLog.completionTokens,
    totalTokens: input.usageLog.totalTokens,
    inputTokensTotal: input.usageLog.inputTokensTotal,
    cacheReadTokens: input.usageLog.cacheReadTokens,
    cacheCreationTokens: input.usageLog.cacheCreationTokens,
    cacheCreationTokens5m: input.usageLog.cacheCreationTokens5m,
    cacheCreationTokens1h: input.usageLog.cacheCreationTokens1h,
    usageSemantic: input.usageLog.usageSemantic,
    usageFieldSources: input.usageLog.usageFieldSources,
    quota: input.usageLog.quota,
    cost: input.usageLog.cost,
    isStream: input.usageLog.isStream,
    newapiType: input.usageLog.type,
    providerChannelName: input.usageLog.providerChannelName,
    newapiUseTimeSeconds: input.usageLog.newapiUseTimeSeconds,
    newapiCreatedAt: input.usageLog.createdAt,
    raw: input.usageLog,
    firstSeenAt: input.syncedAt,
    lastSyncedAt: input.syncedAt,
  };
}

function buildUsageSyncIssue(input: {
  issueType: UsageSyncIssueType;
  usageLog: NormalizedNewApiUsageLog;
  syncedAt: string;
  message: string;
  severity?: "warning" | "critical";
  blocksSettlement?: boolean;
  account?: TokenAccount;
  proxyLog?: ProxyRequestLog;
}): UsageSyncIssue {
  return {
    id: usageIssueIdFromLog(input.issueType, input.usageLog),
    issueType: input.issueType,
    status: "open",
    newapiLogId: input.usageLog.newapiLogId,
    newapiRequestId: input.usageLog.newapiRequestId,
    newapiTokenId: input.usageLog.newapiTokenId,
    tokenAccountId: input.proxyLog?.tokenAccountId ?? input.account?.id,
    feishuUserId: input.proxyLog?.feishuUserId ?? input.account?.feishuUserId,
    matchedProxyLogId: input.proxyLog?.id,
    severity: input.severity ?? "warning",
    blocksSettlement: input.blocksSettlement ?? false,
    occurredAt: input.usageLog.createdAt,
    message: input.message,
    occurrences: 1,
    raw: input.usageLog,
    firstSeenAt: input.syncedAt,
    lastSeenAt: input.syncedAt,
    lastSyncedAt: input.syncedAt,
  };
}

function sameUsageSourceRecord(left: NewApiUsageRecord, right: NewApiUsageRecord) {
  return sameNewApiUsageSource(left, right);
}

function upsertUsageRecordInStore(store: StoreShape, record: NewApiUsageRecord) {
  const index = store.newapiUsageRecords.findIndex((item) => sameUsageSourceRecord(item, record));
  if (index === -1) {
    store.newapiUsageRecords.push(record);
    closeResolvedMissingCostIssuesInStore(store, record);
    return record;
  }
  const existing = store.newapiUsageRecords[index];
  const updated: NewApiUsageRecord = {
    ...existing,
    ...record,
    id: existing.id,
    firstSeenAt: existing.firstSeenAt,
    lastSyncedAt: record.lastSyncedAt,
  };
  store.newapiUsageRecords[index] = updated;
  closeResolvedMissingCostIssuesInStore(store, updated);
  return updated;
}

function closeResolvedMissingCostIssuesInStore(
  store: StoreShape,
  record: NewApiUsageRecord,
) {
  if (!hasAuthoritativeBillingAmount(record)) return;
  for (const issue of store.usageSyncIssues) {
    if (
      issue.issueType !== "missing_cost" ||
      issue.status !== "open" ||
      !sameNewApiUsageSource(issue, record)
    ) {
      continue;
    }
    issue.status = "closed";
    issue.lastSyncedAt = record.lastSyncedAt;
    issue.closedAt = record.lastSyncedAt;
  }
}

function upsertUsageIssueInStore(store: StoreShape, issue: UsageSyncIssue) {
  const resolvedRecord =
    issue.issueType === "no_proxy_match"
      ? store.newapiUsageRecords.find(
          (record) =>
            record.matchStatus === "matched" &&
            Boolean(record.matchedProxyLogId) &&
            sameNewApiUsageSource(record, issue),
        )
      : undefined;
  const index = store.usageSyncIssues.findIndex((item) => {
    if (item.issueType !== issue.issueType) return false;
    return sameNewApiUsageSource(item, issue);
  });
  if (index === -1) {
    const created: UsageSyncIssue = resolvedRecord
      ? {
          ...issue,
          status: "closed",
          matchedProxyLogId: resolvedRecord.matchedProxyLogId,
          closedAt: issue.lastSyncedAt,
        }
      : issue;
    store.usageSyncIssues.push(created);
    return created;
  }
  const existing = store.usageSyncIssues[index];
  const updated: UsageSyncIssue = {
    ...existing,
    ...issue,
    id: existing.id,
    firstSeenAt: existing.firstSeenAt,
    occurrences: existing.occurrences + 1,
    lastSeenAt: issue.lastSeenAt,
    lastSyncedAt: issue.lastSyncedAt,
    status: resolvedRecord ? "closed" : "open",
    matchedProxyLogId: resolvedRecord?.matchedProxyLogId ?? issue.matchedProxyLogId,
    closedAt: resolvedRecord ? issue.lastSyncedAt : undefined,
  };
  store.usageSyncIssues[index] = updated;
  return updated;
}

function closeResolvedNoProxyMatchIssuesInStore(
  store: StoreShape,
  record: NewApiUsageRecord,
  syncedAt: string,
) {
  for (const issue of store.usageSyncIssues) {
    if (
      issue.issueType !== "no_proxy_match" ||
      issue.status !== "open" ||
      !sameNewApiUsageSource(issue, record)
    ) {
      continue;
    }
    Object.assign(issue, {
      status: "closed",
      matchedProxyLogId: record.matchedProxyLogId,
      lastSyncedAt: syncedAt,
      closedAt: syncedAt,
    } satisfies Partial<UsageSyncIssue>);
  }
}

export async function backfillProxyLogsFromNewApiUsage(
  usageLogs: NormalizedNewApiUsageLog[],
  input: {
    dryRun?: boolean;
    matchWindowMs?: number;
    persistUnmatched?: boolean;
    reservedProxyLogIds?: string[];
    targetProxyLogIds?: string[];
  } = {},
): Promise<NewApiUsageBackfillResult> {
  const dryRun = input.dryRun ?? true;
  const matchWindowMs = input.matchWindowMs ?? 30 * 60 * 1000;
  const persistUnmatched = input.persistUnmatched ?? true;

  const runBackfill = async (
    store: StoreShape,
    persistLog?: (
      proxyLog: ProxyRequestLog,
      patch: Partial<Omit<ProxyRequestLog, "id" | "createdAt">>,
      syncedAt: string,
    ) => Promise<void>,
    persistUsageRecord?: (record: NewApiUsageRecord) => Promise<NewApiUsageRecord>,
    persistIssue?: (issue: UsageSyncIssue) => Promise<UsageSyncIssue>,
    persistMatched?: (
      record: NewApiUsageRecord,
      proxyLog: ProxyRequestLog,
      patch: Partial<Omit<ProxyRequestLog, "id" | "createdAt">>,
      syncedAt: string,
    ) => Promise<{ usageRecord: NewApiUsageRecord; proxyLog: ProxyRequestLog | null }>,
  ) => {
    const syncedAt = nowIso();
    const accountByNewApiTokenId = new Map(
      store.tokenAccounts
        .filter((account) => account.newapiTokenId)
        .map((account) => [account.newapiTokenId as string, account] as const),
    );
    const reservedProxyLogIds = new Set(input.reservedProxyLogIds ?? []);
    for (const record of store.newapiUsageRecords) {
      if (record.matchStatus === "matched" && record.matchedProxyLogId) {
        reservedProxyLogIds.add(record.matchedProxyLogId);
      }
    }
    const targetProxyLogIds = input.targetProxyLogIds
      ? new Set(input.targetProxyLogIds)
      : undefined;
    const result: NewApiUsageBackfillResult = {
      dryRun,
      seen: usageLogs.length,
      matched: 0,
      updated: 0,
      skippedUnknownToken: 0,
      skippedNoMatch: 0,
      recordsUpserted: 0,
      issuesUpserted: 0,
      items: [],
    };

    async function persistRecord(record: NewApiUsageRecord) {
      if (dryRun) return record;
      result.recordsUpserted += 1;
      if (persistUsageRecord) return persistUsageRecord(record);
      return upsertUsageRecordInStore(store, record);
    }

    async function persistSyncIssue(issue: UsageSyncIssue) {
      if (dryRun) return issue;
      result.issuesUpserted += 1;
      if (persistIssue) return persistIssue(issue);
      return upsertUsageIssueInStore(store, issue);
    }

    for (const usageLog of usageLogs) {
      const account =
        usageLog.newapiTokenId === undefined
          ? undefined
          : accountByNewApiTokenId.get(usageLog.newapiTokenId);
      if (!account) {
        const record = buildNewApiUsageRecord({
          store,
          usageLog,
          matchStatus: "unknown_token",
          syncedAt,
        });
        const issue = buildUsageSyncIssue({
          issueType: "unknown_token",
          usageLog,
          syncedAt,
          severity: "critical",
          blocksSettlement: true,
          message: "NewAPI token_id is outside the dedicated TokenInside account boundary",
        });
        await persistRecord(record);
        await persistSyncIssue(issue);
        result.skippedUnknownToken += 1;
        result.items.push({
          action: "quarantined_unknown_token",
          newapiLogId: usageLog.newapiLogId,
          newapiRequestId: usageLog.newapiRequestId,
          newapiTokenId: usageLog.newapiTokenId,
          billingPeriod: record.billingPeriod,
          usageRecordId: record.id,
          issueId: issue.id,
          newapiCreatedAt: record.newapiCreatedAt,
          blocksSettlement: true,
          cost: usageLog.cost,
          quota: usageLog.quota,
          reason: "NewAPI token_id is outside the dedicated TokenInside account boundary",
        });
        continue;
      }

      const existingRecord = store.newapiUsageRecords.find((record) =>
        sameNewApiUsageSource(record, usageLog),
      );
      const proxyLog = findProxyLogForNewApiUsage({
        proxyLogs: store.proxyRequestLogs,
        usageLog,
        account,
        matchWindowMs,
        reservedProxyLogIds,
        allowReservedProxyLogId: existingRecord?.matchedProxyLogId,
        targetProxyLogIds,
      });
      if (!proxyLog) {
        if (!persistUnmatched) {
          result.skippedNoMatch += 1;
          result.items.push({
            action: "skipped_no_match",
            newapiLogId: usageLog.newapiLogId,
            newapiRequestId: usageLog.newapiRequestId,
            newapiTokenId: usageLog.newapiTokenId,
            feishuUserId: account.feishuUserId,
            tokenAccountId: account.id,
            cost: usageLog.cost,
            quota: usageLog.quota,
            reason: "No safe target proxy request match yet",
          });
          continue;
        }
        const record = buildNewApiUsageRecord({
          store,
          usageLog,
          matchStatus: "no_proxy_match",
          syncedAt,
          account,
        });
        const issue = buildUsageSyncIssue({
          issueType: "no_proxy_match",
          usageLog,
          syncedAt,
          account,
          severity: "warning",
          blocksSettlement: false,
          message: "No successful one-to-one proxy request matched token, model, stream flag, usage and completion time",
        });
        const missingBillingAmount = !hasAuthoritativeBillingAmount(usageLog);
        const billingIssue = missingBillingAmount
          ? buildUsageSyncIssue({
              issueType: "missing_cost",
              usageLog,
              syncedAt,
              account,
              severity: "critical",
              blocksSettlement: true,
              message:
                "Known NewAPI token usage has no valid quota/cost field; authoritative consumption is incomplete",
            })
          : undefined;
        await persistRecord(record);
        await persistSyncIssue(issue);
        if (billingIssue) await persistSyncIssue(billingIssue);
        result.skippedNoMatch += 1;
        result.items.push({
          action: "skipped_no_match",
          newapiLogId: usageLog.newapiLogId,
          newapiRequestId: usageLog.newapiRequestId,
          newapiTokenId: usageLog.newapiTokenId,
          feishuUserId: account.feishuUserId,
          tokenAccountId: account.id,
          billingPeriod: record.billingPeriod,
          usageRecordId: record.id,
          issueId: billingIssue?.id ?? issue.id,
          newapiCreatedAt: record.newapiCreatedAt,
          blocksSettlement: missingBillingAmount,
          cost: usageLog.cost,
          quota: usageLog.quota,
          reason: "No successful one-to-one proxy request matched token, model, stream flag, usage and completion time",
        });
        continue;
      }

      reservedProxyLogIds.add(proxyLog.id);
      const record = buildNewApiUsageRecord({
        store,
        usageLog,
        matchStatus: "matched",
        syncedAt,
        account,
        proxyLog,
      });
      const patch = buildUsagePatch(usageLog, proxyLog);
      const changed = patchChangesLog(proxyLog, patch);
      let storedRecord: NewApiUsageRecord;
      let atomicallyStoredProxyLog: ProxyRequestLog | null | undefined;
      if (!dryRun && persistMatched) {
        const settled = await persistMatched(record, proxyLog, patch, syncedAt);
        storedRecord = settled.usageRecord;
        atomicallyStoredProxyLog = settled.proxyLog;
      } else {
        storedRecord = await persistRecord(record);
      }
      if (!sameNewApiUsageSource(storedRecord, usageLog)) {
        result.skippedNoMatch += 1;
        result.items.push({
          action: "skipped_no_match",
          newapiLogId: usageLog.newapiLogId,
          newapiRequestId: usageLog.newapiRequestId,
          newapiTokenId: usageLog.newapiTokenId,
          feishuUserId: account.feishuUserId,
          tokenAccountId: account.id,
          usageRecordId: storedRecord.id,
          reason: "Proxy request already has a different authoritative NewAPI source",
        });
        continue;
      }
      if (
        storedRecord.matchedProxyLogId &&
        storedRecord.matchedProxyLogId !== proxyLog.id
      ) {
        result.skippedNoMatch += 1;
        result.items.push({
          action: "skipped_no_match",
          newapiLogId: usageLog.newapiLogId,
          newapiRequestId: usageLog.newapiRequestId,
          newapiTokenId: usageLog.newapiTokenId,
          feishuUserId: account.feishuUserId,
          tokenAccountId: account.id,
          usageRecordId: storedRecord.id,
          reason: "NewAPI source is already bound to another proxy request",
        });
        continue;
      }
      if (!dryRun && !persistMatched) {
        closeResolvedNoProxyMatchIssuesInStore(store, storedRecord, syncedAt);
      }
      result.matched += 1;
      if (!dryRun) result.recordsUpserted += persistMatched ? 1 : 0;
      let billingIssue: UsageSyncIssue | undefined;
      if (!hasAuthoritativeBillingAmount(usageLog)) {
        billingIssue = buildUsageSyncIssue({
          issueType: "missing_cost",
          usageLog,
          syncedAt,
          account,
          proxyLog,
          severity: "critical",
          blocksSettlement: true,
          message:
            "Known NewAPI token usage has no valid quota/cost field; authoritative consumption is incomplete",
        });
        await persistSyncIssue(billingIssue);
      }
      if (changed) {
        result.updated += 1;
        if (!dryRun) {
          if (atomicallyStoredProxyLog) {
            Object.assign(proxyLog, atomicallyStoredProxyLog);
          } else if (persistLog) {
            await persistLog(proxyLog, patch, syncedAt);
          } else {
            Object.assign(proxyLog, patch, {
              usageSyncedAt: syncedAt,
              updatedAt: syncedAt,
            });
          }
        }
      }
      result.items.push({
        action: changed ? "updated" : "matched_no_change",
        newapiLogId: usageLog.newapiLogId,
        newapiRequestId: usageLog.newapiRequestId,
        newapiTokenId: usageLog.newapiTokenId,
        proxyLogId: proxyLog.id,
        feishuUserId: proxyLog.feishuUserId ?? account.feishuUserId,
        tokenAccountId: proxyLog.tokenAccountId ?? account.id,
        billingPeriod:
          proxyLog.billingPeriod ?? resolveUsageBillingPeriod({ occurredAt: proxyLog.createdAt }),
        usageRecordId: storedRecord.id,
        issueId: billingIssue?.id,
        blocksSettlement: Boolean(billingIssue),
        cost: usageLog.cost,
        quota: usageLog.quota,
      });
    }

    if (
      !dryRun &&
      (result.updated > 0 || result.recordsUpserted > 0) &&
      !persistLog &&
      !persistMatched
    ) {
      syncBillingPeriods(store);
    }
    return result;
  };

  if (isPostgresBackend()) {
    // The matcher itself caps non-identity fallback at 30 seconds around the
    // proxy finishedAt timestamp. Exact request/upstream identities are read
    // independently, so long-running streams remain recoverable without
    // loading a ±30 minute proxy history on every 100-row NewAPI page.
    const fallbackMatchingWindowMs = Math.min(
      Math.max(input.matchWindowMs ?? 30 * 60 * 1000, 0),
      30_000,
    );
    const usageSources = usageLogs.map((usageLog) => ({
      recordId: usageRecordIdFromLog(usageLog),
      usageLog,
    }));
    const matchingSnapshot = await readPostgresUsageMatchingSnapshot({
      usageSources,
      proxyLogIds: input.targetProxyLogIds ?? [],
      fallbackWindowMs: fallbackMatchingWindowMs,
    });
    const store = {
      ...structuredClone(initialStore),
      ...matchingSnapshot,
    };
    const withSnapshotStats = (result: NewApiUsageBackfillResult) => ({
      ...result,
      snapshot: matchingSnapshot.stats,
    });
    if (dryRun) return withSnapshotStats(await runBackfill(store));
    // Matching remains strictly ordered inside runBackfill so its in-memory
    // reservation set chooses at most one source for each proxy request. All
    // authoritative writes for this NewAPI page then share one transaction:
    // a failure rolls the whole page back and the usage cursor cannot advance.
    return withSnapshotStats(
      await withPostgresUsageSettlementBatch(
        (writer, lockedSnapshot) =>
          runBackfill(
            lockedSnapshot
              ? {
                  ...store,
                  newapiUsageRecords: lockedSnapshot.newapiUsageRecords,
                  proxyRequestLogs: lockedSnapshot.proxyRequestLogs,
                }
              : store,
            undefined,
            writer.upsertUsageRecord,
            writer.upsertUsageIssue,
            async (record, proxyLog, patch, syncedAt) =>
              writer.settleMatchedUsage({
                record,
                proxyLogId: proxyLog.id,
                patch,
                syncedAt,
              }),
        ),
        {
          usageSources,
          proxyLogIds: matchingSnapshot.proxyRequestLogs.map(
            (proxyLog) => proxyLog.id,
          ),
        },
      ),
    );
  }

  return mutate((store) => runBackfill(store));
}

async function resolveAdminScopeForKnownUser(
  user: FeishuUser,
  jsonStore?: StoreShape,
) {
  if (isInactiveUser(user)) return null;
  const systemAdminOpenIds = new Set(getConfig().admin.systemAdminOpenIds);

  // Environment administrators need no second database lookup after session
  // authentication. Other users retain the exact stored/fallback/revocation
  // semantics, but the already-authenticated user row is reused.
  if (systemAdminOpenIds.has(user.openId)) {
    return resolveSessionAdminScopeProjection({
      user,
      systemAdminOpenIds,
      activeScope: null,
      assignedRequest: null,
      scopes: [],
    });
  }

  const activeScope = isPostgresBackend()
    ? await getPostgresActiveAdminScopeForUser(user.id)
    : jsonStore!.adminScopes.find(
        (scope) => scope.feishuUserId === user.id && scope.status === "active",
      ) ?? null;
  if (activeScope) return activeScope;

  const fallback = isPostgresBackend()
    ? await getPostgresAdminScopeFallbackData(user.id, user.openId)
    : {
        assignedRequest: jsonStore!.tokenRequests
          .filter((request) => request.approvalTargetOpenId === user.openId)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null,
        scopes: jsonStore!.adminScopes.filter((scope) => scope.feishuUserId === user.id),
      };
  return resolveSessionAdminScopeProjection({
    user,
    systemAdminOpenIds,
    activeScope: null,
    assignedRequest: fallback.assignedRequest,
    scopes: fallback.scopes,
  });
}

export async function getAdminScopeForKnownUser(user: FeishuUser) {
  const store = isPostgresBackend() ? undefined : await readStore();
  return resolveAdminScopeForKnownUser(user, store);
}

export async function getAdminScopeForUser(feishuUserId: string) {
  const store = isPostgresBackend() ? undefined : await readStore();
  const user = isPostgresBackend()
    ? await getPostgresUserById(feishuUserId)
    : store!.users.find((item) => item.id === feishuUserId);
  if (!user) return null;
  return resolveAdminScopeForKnownUser(user, store);
}

type AdminScopeLockGlobal = typeof globalThis & {
  __tokenInsideJsonAdminScopeLocks?: Map<string, Promise<void>>;
};

const adminScopeLockGlobal = globalThis as AdminScopeLockGlobal;
const jsonAdminScopeLocks =
  (adminScopeLockGlobal.__tokenInsideJsonAdminScopeLocks ??= new Map());

async function withJsonAdminScopeLock<T>(key: string, fn: () => Promise<T>) {
  const previous = jsonAdminScopeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  jsonAdminScopeLocks.set(key, queued);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (jsonAdminScopeLocks.get(key) === queued) {
      jsonAdminScopeLocks.delete(key);
    }
  }
}

export async function withAdminScopeUserLocks<T>(
  feishuUserIds: string[],
  fn: () => Promise<T>,
) {
  const ids = [...new Set(feishuUserIds)].sort();
  const run = (index: number): Promise<T> => {
    if (index >= ids.length) return fn();
    const key = `admin-scope-user:${ids[index]}`;
    if (isPostgresBackend()) {
      return withPostgresAdvisoryLock(
        key,
        () => run(index + 1),
        { wait: true },
      );
    }
    return withJsonAdminScopeLock(key, () => run(index + 1));
  };
  return run(0);
}

async function authorizeJsonAdminUserAction(
  store: StoreShape,
  input: {
    actorFeishuUserId: string;
    targetFeishuUserId: string;
    destructiveAccessRevoke?: boolean;
  },
) {
  const targetUser = store.users.find(
    (user) => user.id === input.targetFeishuUserId,
  );
  if (!targetUser) return null;
  const actorUser = store.users.find(
    (user) => user.id === input.actorFeishuUserId,
  );
  const actorScope = actorUser
    ? await resolveAdminScopeForKnownUser(actorUser, store)
    : null;
  const configuredRootOpenIds = new Set(getConfig().admin.systemAdminOpenIds);
  const activeEnvironmentRootCount = store.users.filter(
    (user) =>
      configuredRootOpenIds.has(user.openId) &&
      (!user.status || user.status === "active"),
  ).length;
  assertAdminScopeAllowsUserTarget(actorScope, targetUser, {
    actorFeishuUserId: input.actorFeishuUserId,
    destructiveAccessRevoke: input.destructiveAccessRevoke,
    activeEnvironmentRootCount,
    targetHasActiveGlobalAdminScope:
      configuredRootOpenIds.has(targetUser.openId) ||
      store.adminScopes.some(
        (scope) =>
          scope.feishuUserId === targetUser.id &&
          scope.status === "active" &&
          scope.scopeType === "global",
      ),
  });
  return { actorScope, targetUser };
}

export async function authorizeAdminUserActionUnderScopeLocks(input: {
  actorFeishuUserId: string;
  targetFeishuUserId: string;
  destructiveAccessRevoke?: boolean;
}) {
  if (isPostgresBackend()) {
    return authorizePostgresAdminUserActionUnderScopeLocks(input);
  }
  const store = await readStore();
  return authorizeJsonAdminUserAction(store, input);
}

export async function listAdminScopes() {
  if (isPostgresBackend()) return listPostgresAdminScopeProjections();
  const store = await readStore();
  const usersById = new Map(store.users.map((user) => [user.id, user]));
  const stored = store.adminScopes.map((scope) => ({
    ...scope,
    departmentName: departmentNameForId(store, scope.departmentId),
    user: usersById.get(scope.feishuUserId) ?? null,
    readonly: false,
  }));
  const configuredOpenIds = getConfig().admin.systemAdminOpenIds;
  const synthetic = configuredOpenIds.map((openId) => {
    const user = store.users.find((item) => item.openId === openId) ?? null;
    const now = nowIso();
    return {
      id: user ? `env-admin-${user.id}` : `env-admin-open-id-${openId}`,
      feishuUserId: user?.id ?? "",
      scopeType: "global" as const,
      source: "environment" as const,
      role: "root" as const,
      status: "active" as const,
      createdAt: user?.createdAt ?? now,
      updatedAt: user?.updatedAt ?? now,
      user,
      configuredOpenId: openId,
      readonly: true,
    };
  });
  return [...synthetic, ...stored].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function upsertManualAdminScope(input: {
  targetOpenId: string;
  scopeType: AdminScope["scopeType"];
  departmentId?: string;
}) {
  if (isPostgresBackend()) return upsertPostgresManualAdminScope(input);

  const snapshot = await readStore();
  const targetUserId = snapshot.users.find(
    (user) => user.openId === input.targetOpenId,
  )?.id;
  if (!targetUserId) {
    return {
      scope: null,
      error: "target_user_not_found" as const,
    };
  }
  return withAdminScopeUserLocks([targetUserId], () => mutate((store) => {
    const targetUser = store.users.find((user) => user.openId === input.targetOpenId);
    if (!targetUser) {
      return {
        scope: null,
        error: "target_user_not_found" as const,
      };
    }
    if (isInactiveUser(targetUser)) {
      return {
        scope: null,
        error: "target_user_inactive" as const,
      };
    }

    const now = nowIso();
    const existing = store.adminScopes.find(
      (scope) =>
        scope.feishuUserId === targetUser.id &&
        scope.source === "manual" &&
        scope.scopeType === input.scopeType &&
        (input.scopeType === "global" || scope.departmentId === input.departmentId),
    );

    if (existing) {
      activateAdminScope(existing, now);
      existing.departmentId = input.scopeType === "department" ? input.departmentId : undefined;
      return { scope: existing, error: null };
    }

    const scope: AdminScope = {
      id: randomId("as"),
      feishuUserId: targetUser.id,
      scopeType: input.scopeType,
      departmentId: input.scopeType === "department" ? input.departmentId : undefined,
      source: "manual",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    store.adminScopes.push(scope);
    return { scope, error: null };
  }));
}

export async function upsertManualAdminScopeAsActor(input: {
  actorFeishuUserId: string;
  targetOpenId: string;
  scopeType: AdminScope["scopeType"];
  departmentId?: string;
}) {
  if (isPostgresBackend()) return upsertPostgresManualAdminScopeAsActor(input);

  const snapshot = await readStore();
  const targetUserId = snapshot.users.find(
    (user) => user.openId === input.targetOpenId,
  )?.id;
  if (!targetUserId) {
    return { scope: null, error: "target_user_not_found" as const };
  }
  return withAdminScopeUserLocks(
    [input.actorFeishuUserId, targetUserId],
    () =>
      mutate(async (store) => {
        const actor = store.users.find(
          (user) => user.id === input.actorFeishuUserId,
        );
        const actorScope = actor
          ? await resolveAdminScopeForKnownUser(actor, store)
          : null;
        if (!actorScope || actorScope.scopeType !== "global") {
          throw new AdminUserActionAuthorizationError(
            "actor_scope_missing",
            403,
            "当前系统管理员权限已变化，请刷新后重试",
          );
        }
        const actorIsRoot =
          actorScope.source === "environment" && actorScope.role === "root";
        if (input.scopeType === "global" && !actorIsRoot) {
          throw new AdminUserActionAuthorizationError(
            "root_required",
            403,
            "只有 root 管理员可以指派系统管理员",
          );
        }
        if (
          getConfig().admin.systemAdminOpenIds.includes(input.targetOpenId) &&
          !actorIsRoot
        ) {
          throw new AdminUserActionAuthorizationError(
            "root_required",
            403,
            "环境变量 root 用户仅允许 root 管理员操作",
          );
        }
        const targetUser = store.users.find(
          (user) => user.openId === input.targetOpenId,
        );
        if (!targetUser) {
          return { scope: null, error: "target_user_not_found" as const };
        }
        if (isInactiveUser(targetUser)) {
          return { scope: null, error: "target_user_inactive" as const };
        }
        if (input.scopeType === "department" && !input.departmentId) {
          throw new Error("指派部门管理员需要 departmentId");
        }
        const now = nowIso();
        const existing = store.adminScopes.find(
          (scope) =>
            scope.feishuUserId === targetUser.id &&
            scope.source === "manual" &&
            scope.scopeType === input.scopeType &&
            (input.scopeType === "global" ||
              scope.departmentId === input.departmentId),
        );
        if (existing) {
          activateAdminScope(existing, now);
          existing.departmentId =
            input.scopeType === "department" ? input.departmentId : undefined;
          return { scope: existing, error: null };
        }
        const scope: AdminScope = {
          id: randomId("as"),
          feishuUserId: targetUser.id,
          scopeType: input.scopeType,
          departmentId:
            input.scopeType === "department" ? input.departmentId : undefined,
          source: "manual",
          status: "active",
          createdAt: now,
          updatedAt: now,
        };
        store.adminScopes.push(scope);
        return { scope, error: null };
      }),
  );
}

export async function updateManualAdminScope(input: {
  scopeId: string;
  status?: AdminScope["status"];
  departmentId?: string;
  disabledReason?: AdminScope["disabledReason"];
  disabledByFeishuUserId?: string;
}) {
  if (isPostgresBackend()) return updatePostgresManualAdminScope(input);

  const snapshot = await readStore();
  const targetScope = snapshot.adminScopes.find((item) => item.id === input.scopeId);
  if (!targetScope || targetScope.source === "environment") return null;
  return withAdminScopeUserLocks([targetScope.feishuUserId], () => mutate((store) => {
    const scope = store.adminScopes.find((item) => item.id === input.scopeId);
    if (!scope || scope.source === "environment") return null;
    const now = nowIso();
    if (input.status === "active") {
      activateAdminScope(scope, now);
    } else if (input.status === "disabled") {
      disableAdminScope(scope, {
        now,
        reason: input.disabledReason ?? "manual_revoke",
        disabledByFeishuUserId: input.disabledByFeishuUserId,
      });
    }
    if (scope.scopeType === "department" && input.departmentId !== undefined) {
      scope.departmentId = input.departmentId;
    }
    scope.updatedAt = now;
    return scope;
  }));
}

export async function updateManualAdminScopeAsActor(input: {
  actorFeishuUserId: string;
  scopeId: string;
  status?: AdminScope["status"];
  departmentId?: string;
  disabledReason?: AdminScope["disabledReason"];
}) {
  if (isPostgresBackend()) return updatePostgresManualAdminScopeAsActor(input);

  const snapshot = await readStore();
  const targetScope = snapshot.adminScopes.find((item) => item.id === input.scopeId);
  if (!targetScope || targetScope.source === "environment") return null;
  return withAdminScopeUserLocks(
    [input.actorFeishuUserId, targetScope.feishuUserId],
    () =>
      mutate(async (store) => {
        const scope = store.adminScopes.find((item) => item.id === input.scopeId);
        if (!scope || scope.source === "environment") return null;
        const actor = store.users.find(
          (user) => user.id === input.actorFeishuUserId,
        );
        const actorScope = actor
          ? await resolveAdminScopeForKnownUser(actor, store)
          : null;
        if (!actorScope || actorScope.scopeType !== "global") {
          throw new AdminUserActionAuthorizationError(
            "actor_scope_missing",
            403,
            "当前系统管理员权限已变化，请刷新后重试",
          );
        }
        const actorIsRoot =
          actorScope.source === "environment" && actorScope.role === "root";
        if (scope.scopeType === "global" && !actorIsRoot) {
          throw new AdminUserActionAuthorizationError(
            "root_required",
            403,
            "只有 root 管理员可以修改或取消系统管理员",
          );
        }
        const now = nowIso();
        if (input.status === "active") {
          activateAdminScope(scope, now);
        } else if (input.status === "disabled") {
          disableAdminScope(scope, {
            now,
            reason: input.disabledReason ?? "manual_revoke",
            disabledByFeishuUserId: input.actorFeishuUserId,
          });
        }
        if (scope.scopeType === "department" && input.departmentId !== undefined) {
          scope.departmentId = input.departmentId;
        }
        scope.updatedAt = now;
        return scope;
      }),
  );
}

export async function getAdminScopeById(scopeId: string) {
  if (isPostgresBackend()) return getPostgresAdminScopeById(scopeId);
  const store = await readStore();
  return store.adminScopes.find((item) => item.id === scopeId) ?? null;
}

export async function syncDepartmentSupervisorAdminScope(input: {
  feishuUserId: string;
  departmentId: string;
  isSupervisor: boolean;
}) {
  if (isPostgresBackend()) return syncPostgresDepartmentSupervisorAdminScope(input);

  return withAdminScopeUserLocks([input.feishuUserId], () => mutate((store) => {
    const now = nowIso();
    const user = store.users.find((item) => item.id === input.feishuUserId);
    if (!user || isInactiveUser(user)) return null;
    const existing = store.adminScopes.find(
      (scope) =>
        scope.feishuUserId === input.feishuUserId &&
        scope.scopeType === "department" &&
        scope.departmentId === input.departmentId &&
        scope.source === "department_supervisor",
    );
    const blockedByGlobalRevocation = store.adminScopes.some(
      (scope) =>
        scope.feishuUserId === input.feishuUserId && blocksAllAutomaticAdminRestoreForUser(scope),
    );
    if (blockedByGlobalRevocation) return null;

    if (!input.isSupervisor) {
      if (existing) {
        if (blocksAutomaticAdminRestore(existing)) return null;
        disableAdminScope(existing, {
          now,
          reason: "auto_sync_lost",
        });
      }
      return null;
    }

    if (existing) {
      if (blocksAutomaticAdminRestore(existing)) return null;
      activateAdminScope(existing, now);
      return existing;
    }

    const blockedByRevokedScope = store.adminScopes.some(
      (scope) =>
        scope.feishuUserId === input.feishuUserId &&
        scope.scopeType === "department" &&
        scope.departmentId === input.departmentId &&
        blocksAutomaticAdminRestore(scope),
    );
    if (blockedByRevokedScope) return null;

    const scope: AdminScope = {
      id: randomId("as"),
      feishuUserId: input.feishuUserId,
      scopeType: "department",
      departmentId: input.departmentId,
      source: "department_supervisor",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    store.adminScopes.push(scope);
    return scope;
  }));
}

function tokenAccountInScope(
  account: TokenAccount,
  scope: AdminScope,
  usersById: Map<string, FeishuUser>,
) {
  if (scope.scopeType === "global") return true;
  const user = usersById.get(account.feishuUserId);
  return Boolean(user?.departmentId && user.departmentId === scope.departmentId);
}

function proxyLogInScope(
  log: ProxyRequestLog,
  scope: AdminScope,
  usersById: Map<string, FeishuUser>,
) {
  if (scope.scopeType === "global") return true;
  if (log.departmentId) return log.departmentId === scope.departmentId;
  if (!log.feishuUserId) return false;
  const user = usersById.get(log.feishuUserId);
  return Boolean(user?.departmentId && user.departmentId === scope.departmentId);
}

function userInAdminScope(user: FeishuUser, scope: AdminScope) {
  if (scope.scopeType === "global") return true;
  return Boolean(user.departmentId && user.departmentId === scope.departmentId);
}

function activeAdminScopesForUser(user: FeishuUser, store: StoreShape) {
  if (isInactiveUser(user)) return [];
  const scopes = store.adminScopes.filter(
    (scope) => scope.feishuUserId === user.id && scope.status === "active",
  );
  if (getConfig().admin.systemAdminOpenIds.includes(user.openId)) {
    scopes.push({
      id: `env-admin-${user.id}`,
      feishuUserId: user.id,
      scopeType: "global",
      source: "environment",
      role: "root",
      status: "active",
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    });
  }
  return scopes;
}

function userRoleLabel(user: FeishuUser, store: StoreShape) {
  const scopes = activeAdminScopesForUser(user, store);
  if (scopes.some((scope) => scope.scopeType === "global")) return "系统管理员";
  if (scopes.some((scope) => scope.scopeType === "department")) return "部门管理员";
  return "普通用户";
}

function globalAdminOpenIds(store: StoreShape, usersById: ReadonlyMap<string, FeishuUser>) {
  const openIds = new Set(getConfig().admin.systemAdminOpenIds);
  for (const scope of store.adminScopes) {
    if (scope.status !== "active" || scope.scopeType !== "global") continue;
    const user = usersById.get(scope.feishuUserId);
    if (user) openIds.add(user.openId);
  }
  return openIds;
}

function tokenRequestInScope(
  request: TokenRequest,
  scope: AdminScope,
  usersById: ReadonlyMap<string, FeishuUser>,
  systemAdminOpenIds: ReadonlySet<string>,
) {
  return tokenRequestInAdminScope(request, scope, usersById, systemAdminOpenIds);
}

function latestByUser<T extends { feishuUserId: string; updatedAt?: string; createdAt?: string }>(
  rows: T[],
) {
  const byUser = new Map<string, T>();
  for (const row of rows) {
    const current = byUser.get(row.feishuUserId);
    const rowTime = row.updatedAt ?? row.createdAt ?? "";
    const currentTime = current?.updatedAt ?? current?.createdAt ?? "";
    if (!current || rowTime.localeCompare(currentTime) > 0) byUser.set(row.feishuUserId, row);
  }
  return byUser;
}

function scopedUsersForStore(store: StoreShape, scope: AdminScope) {
  return store.users.filter((user) => userInAdminScope(user, scope));
}

export async function getScopedTokenRequest(scope: AdminScope, requestId: string) {
  if (isPostgresBackend()) {
    const request = await getPostgresTokenRequestById(requestId);
    if (!request) return null;
    if (scope.scopeType === "global") return request;

    const [requester, requesterAdminScope] = await Promise.all([
      getPostgresUserById(request.feishuUserId),
      getPostgresActiveAdminScopeForUser(request.feishuUserId),
    ]);
    const usersById = new Map<string, FeishuUser>();
    const systemAdminOpenIds = new Set(getConfig().admin.systemAdminOpenIds);
    if (requester) {
      usersById.set(requester.id, requester);
      if (requesterAdminScope?.scopeType === "global") {
        systemAdminOpenIds.add(requester.openId);
      }
    }
    return tokenRequestInScope(request, scope, usersById, systemAdminOpenIds) ? request : null;
  }
  const store = await readStore();
  const request = store.tokenRequests.find((item) => item.id === requestId);
  if (!request) return null;
  const usersById = new Map(store.users.map((user) => [user.id, user]));
  return tokenRequestInScope(request, scope, usersById, globalAdminOpenIds(store, usersById)) ? request : null;
}

export async function getScopedUser(scope: AdminScope, feishuUserId: string) {
  if (isPostgresBackend()) {
    const user = await getPostgresUserById(feishuUserId);
    if (!user) return null;
    return userInAdminScope(user, scope) ? user : null;
  }
  const store = await readStore();
  const user = store.users.find((item) => item.id === feishuUserId);
  if (!user) return null;
  return userInAdminScope(user, scope) ? user : null;
}

type UpdateUserAccessStatusInput = {
  actorFeishuUserId: string;
  feishuUserId: string;
  status: "disabled" | "deleted";
  reason?: string;
  tokenStatus: Extract<TokenStatus, "disabled" | "revoked">;
  adminRevokedByFeishuUserId?: string;
  adminScopeLocksHeld?: boolean;
  upstreamDisabledAt?: string;
  consumptionBarrierCutoffAt?: string;
};

export async function updateUserAccessStatus(input: UpdateUserAccessStatusInput) {
  if (isPostgresBackend()) return updatePostgresUserAccessStatus(input);

  return mutate(async (store) => {
    const authorized = await authorizeJsonAdminUserAction(store, {
      actorFeishuUserId: input.actorFeishuUserId,
      targetFeishuUserId: input.feishuUserId,
      destructiveAccessRevoke: true,
    });
    if (!authorized) return null;
    const now = nowIso();
    const user = authorized.targetUser;

    const operationalAccounts = store.tokenAccounts.filter((account) => {
      if (account.feishuUserId !== input.feishuUserId) return false;
      if (input.tokenStatus === "revoked") return account.status !== "revoked";
      return ["pending_activation", "active", "draining", "settling"].includes(
        account.status,
      );
    });
    for (const account of operationalAccounts) {
      account.status =
        input.tokenStatus === "disabled" && account.status === "pending_activation"
          ? "orphaned"
          : input.tokenStatus;
      account.disabledAt = now;
      if (account.status === "orphaned" || account.status === "revoked") {
        account.prewarmedCredentialCiphertext = undefined;
      }
    }

    const terminatedOperationIds: string[] = [];
    const manualReviewOperationIds: string[] = [];
    for (const operation of store.quotaOperations) {
      if (operation.feishuUserId !== input.feishuUserId) continue;
      if (operation.credentialCiphertext && !operation.credentialDeliveredAt) {
        operation.credentialCiphertext = undefined;
        operation.evidence = {
          ...operation.evidence,
          credentialRevokedAt: now,
          userAccessStatus: input.status,
        };
      }
      if (["completed", "compensated", "cancelled"].includes(operation.state)) continue;
      const previousState = operation.state;
      const cancellable = canCancelQuotaOperationForAccessRevoke(operation);
      if (cancellable) terminatedOperationIds.push(operation.id);
      else manualReviewOperationIds.push(operation.id);
      Object.assign(operation, {
        state: cancellable ? ("cancelled" as const) : ("manual_review" as const),
        reservedDepartmentQuota: cancellable ? 0 : operation.reservedDepartmentQuota,
        nextRetryAt: undefined,
        workerLeaseId: undefined,
        workerLeaseExpiresAt: undefined,
        lastErrorCode: cancellable
          ? "user_access_revoked"
          : "user_access_revoked_manual_review",
        lastErrorMessage:
          input.reason ??
          (input.status === "deleted" ? "用户已删除，额度操作已终止" : "用户已禁用，额度操作已终止"),
        evidence: {
          ...operation.evidence,
          userAccessRevokedAt: now,
          userAccessStatus: input.status,
          ...(cancellable
            ? { cancelledFromState: previousState }
            : { manualReviewFromState: previousState }),
        },
        updatedAt: now,
        completedAt: cancellable ? now : undefined,
      });
      const request = operation.requestId
        ? store.tokenRequests.find((item) => item.id === operation.requestId)
        : undefined;
      if (request && request.status !== "provisioned") {
        request.status = "approved_provision_failed";
        request.errorMessage =
          input.status === "deleted"
            ? "用户已删除，原账务任务已终止；重新申请后将创建新任务"
            : "用户已禁用，原账务任务已终止";
        request.updatedAt = now;
      }
    }

    user.status = input.status;
    user.updatedAt = now;
    if (input.status === "disabled") {
      user.disabledAt = now;
      user.disabledReason = input.reason;
    } else {
      user.deletedAt = now;
      user.deletedReason = input.reason;
      user.disabledAt = user.disabledAt ?? now;
      user.disabledReason = user.disabledReason ?? input.reason;
      revokeAdminScopesForUserInStore(store, {
        feishuUserId: input.feishuUserId,
        reason: "user_deleted",
        disabledByFeishuUserId: input.adminRevokedByFeishuUserId,
        now,
      });
    }

    const quotaStateIndex = store.userQuotaStates.findIndex(
      (state) => state.feishuUserId === input.feishuUserId,
    );
    const existingQuotaState = store.userQuotaStates[quotaStateIndex];
    const revocationBarrier = preserveUserAccessRevocationBarrier(
      input,
      existingQuotaState,
    );
    const quotaState: UserQuotaState = {
      feishuUserId: input.feishuUserId,
      admission: "closed",
      activeGeneration:
        existingQuotaState?.activeGeneration ??
        Math.max(
          0,
          ...store.tokenAccounts
            .filter((account) => account.feishuUserId === input.feishuUserId)
            .map((account) => account.operationGeneration ?? 0),
        ),
      operationId: undefined,
      closedReason: "user_access_revoked",
      ...revocationBarrier,
      updatedAt: now,
    };
    if (quotaStateIndex === -1) store.userQuotaStates.push(quotaState);
    else store.userQuotaStates[quotaStateIndex] = quotaState;

    const resumableAccount = [...operationalAccounts]
      .reverse()
      .find((account) => account.status === input.tokenStatus) ?? null;
    return {
      user,
      tokenAccount: resumableAccount,
      tokenAccounts: operationalAccounts,
      terminatedOperationIds,
      manualReviewOperationIds,
    };
  });
}

export async function updateUserAccessStatusUnderUserFence(
  input: UpdateUserAccessStatusInput,
) {
  if (isPostgresBackend()) {
    return updatePostgresUserAccessStatusUnderUserFence(input);
  }
  return updateUserAccessStatus(input);
}

export async function revokeAdminScopesForUser(input: {
  feishuUserId: string;
  reason: NonNullable<AdminScope["disabledReason"]>;
  disabledByFeishuUserId?: string;
}) {
  if (isPostgresBackend()) return revokePostgresAdminScopesForUser(input);

  return withAdminScopeUserLocks(
    [input.feishuUserId],
    () => mutate((store) =>
      revokeAdminScopesForUserInStore(store, {
        ...input,
        now: nowIso(),
      }),
    ),
  );
}

type EnableUserAccessInput = {
  actorFeishuUserId: string;
  feishuUserId: string;
  reason?: string;
  expectedTokenAccountId?: string;
  adminScopeLocksHeld?: boolean;
};

export async function enableUserAccess(input: EnableUserAccessInput) {
  if (isPostgresBackend()) return enablePostgresUserAccess(input);

  return mutate(async (store) => {
    const authorized = await authorizeJsonAdminUserAction(store, {
      actorFeishuUserId: input.actorFeishuUserId,
      targetFeishuUserId: input.feishuUserId,
    });
    if (!authorized) return null;
    const now = nowIso();
    const user = authorized.targetUser;
    if (!user || user.status !== "disabled") return null;

    const disabledAccount =
      [...store.tokenAccounts]
        .filter(
          (account) =>
            account.feishuUserId === input.feishuUserId &&
            account.status === "disabled" &&
            (!input.expectedTokenAccountId || account.id === input.expectedTokenAccountId),
        )
        .sort((a, b) =>
          (b.disabledAt ?? b.createdAt).localeCompare(a.disabledAt ?? a.createdAt),
        )[0] ?? null;
    if (!disabledAccount) return null;
    if (
      store.quotaOperations.some(
        (operation) =>
          operation.feishuUserId === input.feishuUserId &&
          !["completed", "compensated", "cancelled"].includes(operation.state),
      )
    ) {
      return null;
    }

    disabledAccount.status = "active";
    disabledAccount.disabledAt = undefined;

    user.status = "active";
    user.updatedAt = now;
    user.disabledAt = undefined;
    user.disabledReason = undefined;

    const quotaStateIndex = store.userQuotaStates.findIndex(
      (state) => state.feishuUserId === input.feishuUserId,
    );
    const existingQuotaState = store.userQuotaStates[quotaStateIndex];
    const quotaState: UserQuotaState = {
      feishuUserId: input.feishuUserId,
      admission: "closed",
      activeGeneration: Math.max(
        existingQuotaState?.activeGeneration ?? 0,
        disabledAccount.operationGeneration ?? 0,
      ),
      operationId: undefined,
      closedReason: "user_access_resume_pending",
      resumeTokenAccountId: disabledAccount.id,
      resumePreparedAt: now,
      updatedAt: now,
    };
    if (quotaStateIndex === -1) store.userQuotaStates.push(quotaState);
    else store.userQuotaStates[quotaStateIndex] = quotaState;

    return { user, tokenAccount: disabledAccount };
  });
}

export async function enableUserAccessUnderUserFence(input: EnableUserAccessInput) {
  if (isPostgresBackend()) return enablePostgresUserAccessUnderUserFence(input);
  return enableUserAccess(input);
}

export async function markUserAccessResumeEnableAttemptUnderUserFence(input: {
  feishuUserId: string;
  expectedTokenAccountId: string;
}) {
  if (isPostgresBackend()) {
    return markPostgresUserAccessResumeEnableAttemptUnderUserFence(input);
  }
  return mutate((store) => {
    const user = store.users.find((item) => item.id === input.feishuUserId);
    const account = store.tokenAccounts.find(
      (item) =>
        item.id === input.expectedTokenAccountId &&
        item.feishuUserId === input.feishuUserId &&
        item.status === "active",
    );
    const quotaState = store.userQuotaStates.find(
      (state) => state.feishuUserId === input.feishuUserId,
    );
    if (
      user?.status !== "active" ||
      !account ||
      quotaState?.admission !== "closed" ||
      quotaState.closedReason !== "user_access_resume_pending" ||
      (quotaState.resumeTokenAccountId &&
        quotaState.resumeTokenAccountId !== input.expectedTokenAccountId)
    ) {
      return null;
    }
    const now = nowIso();
    Object.assign(quotaState, {
      operationId: undefined,
      resumeTokenAccountId: input.expectedTokenAccountId,
      resumePreparedAt: quotaState.resumePreparedAt ?? quotaState.updatedAt,
      resumeUpstreamEnableAttemptedAt: now,
      updatedAt: now,
    });
    return quotaState;
  });
}

export async function listStaleUserAccessResumeCandidates(input: {
  staleBefore: string;
  limit?: number;
}) {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 25), 1), 100);
  if (isPostgresBackend()) {
    return listPostgresStaleUserAccessResumeCandidates({
      staleBefore: input.staleBefore,
      limit,
    });
  }
  const store = await readStore();
  const usersById = new Map(store.users.map((user) => [user.id, user]));
  const accountsById = new Map(
    store.tokenAccounts.map((account) => [account.id, account]),
  );
  return store.userQuotaStates
    .filter(
      (state) =>
        state.admission === "closed" &&
        state.closedReason === "user_access_resume_pending" &&
        state.updatedAt <= input.staleBefore,
    )
    .sort((a, b) =>
      a.updatedAt.localeCompare(b.updatedAt) ||
      a.feishuUserId.localeCompare(b.feishuUserId),
    )
    .flatMap((quotaState) => {
      const user = usersById.get(quotaState.feishuUserId);
      const tokenAccount = quotaState.resumeTokenAccountId
        ? accountsById.get(quotaState.resumeTokenAccountId)
        : [...store.tokenAccounts]
            .filter(
              (account) =>
                account.feishuUserId === quotaState.feishuUserId &&
                account.status === "active",
            )
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (
        user?.status !== "active" ||
        tokenAccount?.status !== "active" ||
        tokenAccount.feishuUserId !== quotaState.feishuUserId
      ) {
        return [];
      }
      return [{ user, tokenAccount, quotaState }];
    })
    .slice(0, limit);
}

export async function finalizeUserAccessResumeUnderUserFence(input: {
  actorFeishuUserId: string;
  feishuUserId: string;
  expectedTokenAccountId: string;
  adminScopeLocksHeld?: boolean;
}) {
  if (isPostgresBackend()) {
    return finalizePostgresUserAccessResumeUnderUserFence(input);
  }
  return mutate(async (store) => {
    const authorized = await authorizeJsonAdminUserAction(store, {
      actorFeishuUserId: input.actorFeishuUserId,
      targetFeishuUserId: input.feishuUserId,
    });
    if (!authorized) return null;
    const user = authorized.targetUser;
    const account = store.tokenAccounts.find(
      (item) =>
        item.id === input.expectedTokenAccountId &&
        item.feishuUserId === input.feishuUserId &&
        item.status === "active",
    );
    const openOperation = store.quotaOperations.find(
      (operation) =>
        operation.feishuUserId === input.feishuUserId &&
        !["completed", "compensated", "cancelled"].includes(operation.state),
    );
    const quotaStateIndex = store.userQuotaStates.findIndex(
      (state) => state.feishuUserId === input.feishuUserId,
    );
    const quotaState = store.userQuotaStates[quotaStateIndex];
    if (
      !user ||
      user.status !== "active" ||
      !account ||
      openOperation ||
      quotaState?.admission !== "closed" ||
      quotaState.closedReason !== "user_access_resume_pending"
    ) {
      return null;
    }
    const opened: UserQuotaState = {
      feishuUserId: input.feishuUserId,
      admission: "open",
      activeGeneration: Math.max(
        quotaState.activeGeneration,
        account.operationGeneration ?? 0,
      ),
      operationId: undefined,
      closedReason: undefined,
      updatedAt: nowIso(),
    };
    store.userQuotaStates[quotaStateIndex] = opened;
    return { user, tokenAccount: account, quotaState: opened };
  });
}

export async function rollbackUserAccessResumeUnderUserFence(input: {
  feishuUserId: string;
  expectedTokenAccountId: string;
  upstreamDisabledAt: string;
  consumptionBarrierCutoffAt: string;
  reason: string;
}) {
  if (isPostgresBackend()) {
    return rollbackPostgresUserAccessResumeUnderUserFence(input);
  }
  return mutate((store) => {
    const user = store.users.find((item) => item.id === input.feishuUserId);
    const account = store.tokenAccounts.find(
      (item) =>
        item.id === input.expectedTokenAccountId &&
        item.feishuUserId === input.feishuUserId,
    );
    const quotaStateIndex = store.userQuotaStates.findIndex(
      (state) => state.feishuUserId === input.feishuUserId,
    );
    const quotaState = store.userQuotaStates[quotaStateIndex];
    if (
      user?.status !== "active" ||
      account?.status !== "active" ||
      quotaState?.admission !== "closed" ||
      quotaState.closedReason !== "user_access_resume_pending"
    ) {
      return null;
    }

    const now = input.upstreamDisabledAt;
    user.status = "disabled";
    user.updatedAt = now;
    user.disabledAt = now;
    user.disabledReason = input.reason;
    account.status = "disabled";
    account.disabledAt = now;
    const rolledBackState: UserQuotaState = {
      feishuUserId: input.feishuUserId,
      admission: "closed",
      activeGeneration: Math.max(
        quotaState.activeGeneration,
        account.operationGeneration ?? 0,
      ),
      operationId: undefined,
      closedReason: "user_access_revoked",
      upstreamDisabledAt: input.upstreamDisabledAt,
      consumptionBarrierCutoffAt: input.consumptionBarrierCutoffAt,
      updatedAt: now,
    };
    store.userQuotaStates[quotaStateIndex] = rolledBackState;
    return { user, tokenAccount: account, quotaState: rolledBackState };
  });
}

export async function listAdminUsers(scope: AdminScope) {
  if (isPostgresBackend()) {
    return listPostgresAdminUsers(scope, nowIso().slice(0, 7));
  }
  const store = await readStore();
  const users = scopedUsersForStore(store, scope);
  const activeAccountsByUserId = new Map(
    store.tokenAccounts
      .filter((account) => account.status === "active")
      .map((account) => [account.feishuUserId, account]),
  );
  const latestAccountsByUserId = latestByUser(store.tokenAccounts);
  const latestRequestsByUserId = latestByUser(store.tokenRequests);
  const latestLogsByUserId = latestByUser(
    store.proxyRequestLogs.filter((log): log is ProxyRequestLog & { feishuUserId: string } =>
      Boolean(log.feishuUserId),
    ),
  );
  const currentPeriod = nowIso().slice(0, 7);
  const billingByUserAndPeriod = new Map(
    store.userBillingPeriods.map((period) => [
      billingKey(period.feishuUserId, period.period),
      period,
    ]),
  );

  return users
    .map((user) => {
      const activeAccount = activeAccountsByUserId.get(user.id);
      const latestAccount = activeAccount ?? latestAccountsByUserId.get(user.id);
      const billingPeriod = activeAccount?.billingPeriod ?? currentPeriod;
      const billing = billingByUserAndPeriod.get(billingKey(user.id, billingPeriod));
      const latestRequest = latestRequestsByUserId.get(user.id);
      const latestLog = latestLogsByUserId.get(user.id);
      return {
        id: user.id,
        name: user.name,
        openId: user.openId,
        departmentId: user.departmentId,
        departmentName: user.departmentName,
        status: user.status ?? "active",
        role: userRoleLabel(user, store),
        isGlobalAdmin: activeAdminScopesForUser(user, store).some(
          (adminScope) => adminScope.scopeType === "global",
        ),
        isEnvironmentRoot: getConfig().admin.systemAdminOpenIds.includes(user.openId),
        activeTokenStatus: latestAccount?.status,
        activeTokenCreatedAt: latestAccount?.createdAt,
        billingPeriod,
        billingMonthlyQuota: billing?.monthlyQuota,
        billingRemainingQuota:
          billing?.monthlyQuota === undefined
            ? undefined
            : billing.remainingQuota ?? Math.max(billing.monthlyQuota - (billing.quotaConsumed ?? 0), 0),
        billingQuotaConsumed: billing?.quotaConsumed ?? 0,
        billingCost: billing?.cost ?? billing?.quotaConsumed ?? 0,
        billingTotalTokens: billing?.totalTokens,
        billingPromptTokens: billing?.promptTokens,
        billingCompletionTokens: billing?.completionTokens,
        billingProxyLogCount: billing?.proxyLogCount,
        billingUsageRecordCount: billing?.usageRecordCount ?? 0,
        latestRequestStatus: latestRequest?.status,
        latestRequestType: latestRequest?.requestType,
        latestRequestUpdatedAt: latestRequest?.updatedAt,
        latestProxyLogAt: latestLog?.createdAt,
        updatedAt: user.updatedAt,
        createdAt: user.createdAt,
      };
    })
    .sort((a, b) => {
      const left = a.latestProxyLogAt ?? a.latestRequestUpdatedAt ?? a.updatedAt;
      const right = b.latestProxyLogAt ?? b.latestRequestUpdatedAt ?? b.updatedAt;
      return right.localeCompare(left);
    });
}

export async function listAdminUserStats(scope: AdminScope) {
  const users = await listAdminUsers(scope);
  return users
    .map((user) => ({
      id: user.id,
      name: user.name,
      openId: user.openId,
      departmentId: user.departmentId,
      departmentName: user.departmentName,
      role: user.role,
      activeTokenStatus: user.activeTokenStatus,
      billingPeriod: user.billingPeriod,
      monthlyQuota: user.billingMonthlyQuota ?? 0,
      remainingQuota: user.billingRemainingQuota,
      quotaConsumed: user.billingQuotaConsumed ?? 0,
      cost: user.billingCost ?? user.billingQuotaConsumed ?? 0,
      promptTokens: user.billingPromptTokens ?? 0,
      completionTokens: user.billingCompletionTokens ?? 0,
      totalTokens: user.billingTotalTokens ?? 0,
      proxyLogCount: user.billingProxyLogCount ?? 0,
      usageRecordCount: user.billingUsageRecordCount ?? 0,
      quotaUsageRate:
        user.billingMonthlyQuota && user.billingMonthlyQuota > 0
          ? (user.billingQuotaConsumed ?? 0) / user.billingMonthlyQuota
          : 0,
      latestProxyLogAt: user.latestProxyLogAt,
    }))
    .sort((a, b) => b.quotaConsumed - a.quotaConsumed || b.totalTokens - a.totalTokens);
}

type UsageRecordFilters = {
  userId?: string;
  departmentId?: string;
  model?: string;
  provider?: string;
  apiFormat?: string;
  status?: string;
  userAgent?: string;
  clientFamily?: string;
  search?: string;
  preset?: string;
  startDate?: string;
  endDate?: string;
  hideUnknownRecords?: boolean;
  limit?: number;
  offset?: number;
};

function boundedLimit(value: number | undefined, fallback: number) {
  return Math.min(Math.max(value ?? fallback, 1), 500);
}

function boundedOffset(value: number | undefined) {
  return Math.max(value ?? 0, 0);
}

function normalizeFilter(value?: string) {
  if (!value || value === "__all__") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isUnknownUsageValue(value?: string) {
  const normalized = value?.trim().toLowerCase();
  return !normalized || normalized === "unknown" || normalized === "-" || normalized === "null";
}

function logDisplayStatus(log: ProxyRequestLog) {
  if (log.status === "pending" || log.status === "streaming") {
    if (log.statusCode >= 400 || log.errorMessage) return "failed";
    if (log.status === "streaming" && log.firstByteMs === undefined) return "pending";
    return log.status;
  }
  if (log.status) return log.status;
  if (log.statusCode === 499) return "cancelled";
  if (log.statusCode >= 400) return "failed";
  return "completed";
}

function logIsStream(log: ProxyRequestLog) {
  return Boolean(log.isStream || log.upstreamIsStream || log.clientRequestedStream || log.clientIsStream);
}

function logDepartmentId(log: ProxyRequestLog, user?: FeishuUser) {
  return log.departmentId ?? user?.departmentId;
}

function logDepartmentName(log: ProxyRequestLog, user?: FeishuUser) {
  return log.departmentName ?? user?.departmentName;
}

function departmentNameForId(store: StoreShape, departmentId?: string) {
  if (!departmentId) return undefined;
  const user = store.users.find((item) => item.departmentId === departmentId && item.departmentName);
  if (user?.departmentName) return user.departmentName;
  return store.proxyRequestLogs.find((item) => item.departmentId === departmentId && item.departmentName)
    ?.departmentName;
}

function matchesStatusFilter(log: ProxyRequestLog, status?: string) {
  if (!status) return true;
  const displayStatus = logDisplayStatus(log);
  switch (status) {
    case "stream":
      return logIsStream(log);
    case "standard":
      return !logIsStream(log);
    case "active":
      return displayStatus === "pending" || displayStatus === "streaming";
    case "failed":
      return displayStatus === "failed";
    case "cancelled":
      return displayStatus === "cancelled";
    case "has_retry":
    case "has_fallback":
      return false;
    default:
      return displayStatus === status;
  }
}

function dateBoundary(value: string | undefined, endOfDay: boolean) {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`).getTime();
  }
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : undefined;
}

function presetDateRange(preset?: string) {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);

  switch (preset) {
    case "yesterday":
      start.setDate(start.getDate() - 1);
      end.setDate(end.getDate() - 1);
      return { start: start.getTime(), end: end.getTime() };
    case "last7days":
      start.setDate(start.getDate() - 6);
      return { start: start.getTime(), end: now.getTime() };
    case "last30days":
      start.setDate(start.getDate() - 29);
      return { start: start.getTime(), end: now.getTime() };
    case "last90days":
      start.setDate(start.getDate() - 89);
      return { start: start.getTime(), end: now.getTime() };
    case "today":
      return { start: start.getTime(), end: now.getTime() };
    default:
      return {};
  }
}

function matchesDateRange(log: ProxyRequestLog, filters: UsageRecordFilters) {
  const preset = presetDateRange(filters.preset);
  const start = dateBoundary(filters.startDate, false) ?? preset.start;
  const end = dateBoundary(filters.endDate, true) ?? preset.end;
  const createdAt = new Date(log.createdAt).getTime();
  if (!Number.isFinite(createdAt)) return true;
  if (start !== undefined && createdAt < start) return false;
  if (end !== undefined && createdAt > end) return false;
  return true;
}

function postgresUsageDateRange(filters: UsageRecordFilters) {
  const preset = presetDateRange(filters.preset);
  const start = dateBoundary(filters.startDate, false) ?? preset.start;
  const end = dateBoundary(filters.endDate, true) ?? preset.end;
  return {
    startAt: start === undefined ? undefined : new Date(start).toISOString(),
    endAt: end === undefined ? undefined : new Date(end).toISOString(),
  };
}

function postgresUsageFilters(filters: UsageRecordFilters) {
  return {
    userId: normalizeFilter(filters.userId),
    departmentId: normalizeFilter(filters.departmentId),
    model: normalizeFilter(filters.model),
    provider: normalizeFilter(filters.provider),
    apiFormat: normalizeFilter(filters.apiFormat),
    status: normalizeFilter(filters.status),
    userAgent: normalizeFilter(filters.userAgent),
    clientFamily: normalizeFilter(filters.clientFamily),
    search: normalizeFilter(filters.search),
    hideUnknownRecords: filters.hideUnknownRecords,
    ...postgresUsageDateRange(filters),
  };
}

function mapPostgresUsagePage(
  page: Array<{ log: ProxyRequestLog; user: FeishuUser | null }>,
) {
  const usersById = new Map(
    page
      .map((item) => item.user)
      .filter((user): user is FeishuUser => Boolean(user))
      .map((user) => [user.id, user]),
  );
  return page.map((item) => mapUsageRecord(item.log, usersById));
}

function matchesSearch(log: ProxyRequestLog, user: FeishuUser | undefined, search?: string) {
  const normalized = search?.trim().toLowerCase();
  if (!normalized) return true;
  return [
    user?.name,
    user?.openId,
    log.tokenAccountId,
    log.requestPath,
    log.method,
    log.model,
    log.provider,
    log.providerKeyName,
    user?.departmentName,
    log.departmentName,
    log.apiFormat,
    log.clientFamily,
    log.clientIp,
    log.userAgent,
    log.errorMessage,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(normalized));
}

function mapUsageRecord(log: ProxyRequestLog, usersById: Map<string, FeishuUser>) {
  const user = log.feishuUserId ? usersById.get(log.feishuUserId) : undefined;
  return {
    id: log.id,
    feishuUserId: log.feishuUserId,
    tokenAccountId: log.tokenAccountId,
    userName: user?.name,
    userOpenId: user?.openId,
    departmentId: logDepartmentId(log, user),
    departmentName: logDepartmentName(log, user),
    requestPath: log.requestPath,
    method: log.method,
    status: logDisplayStatus(log),
    rawStatus: log.status,
    statusCode: log.statusCode,
    durationMs: log.durationMs,
    firstByteMs: log.firstByteMs,
    responseTimeUpdatedAt: log.responseTimeUpdatedAt,
    model: log.model,
    provider: log.provider,
    providerKeyName: log.providerKeyName,
    apiFormat: log.apiFormat,
    endpointApiFormat: log.endpointApiFormat,
    requestType: log.requestType,
    isStream: log.isStream,
    upstreamIsStream: log.upstreamIsStream,
    clientRequestedStream: log.clientRequestedStream,
    clientIsStream: log.clientIsStream,
    promptTokens: log.promptTokens,
    completionTokens: log.completionTokens,
    totalTokens: log.totalTokens,
    inputTokensTotal: log.inputTokensTotal,
    cacheReadTokens: log.cacheReadTokens,
    cacheCreationTokens: log.cacheCreationTokens,
    cacheCreationTokens5m: log.cacheCreationTokens5m,
    cacheCreationTokens1h: log.cacheCreationTokens1h,
    usageSemantic: log.usageSemantic,
    usageFieldSources: log.usageFieldSources,
    quota: log.usageSource === "newapi_log" ? log.quota : undefined,
    cost: log.usageSource === "newapi_log" ? log.cost : undefined,
    actualCost: log.actualCost,
    usageSource: log.usageSource,
    usageSyncedAt: log.usageSyncedAt,
    newapiLogId: log.newapiLogId,
    newapiRequestId: log.newapiRequestId,
    newapiResponseRequestId: log.newapiResponseRequestId,
    newapiUpstreamRequestId: log.newapiUpstreamRequestId,
    providerChannelName: log.providerChannelName,
    newapiUseTimeSeconds: log.newapiUseTimeSeconds,
    errorMessage: log.errorMessage,
    clientFamily: log.clientFamily,
    clientIp: log.clientIp,
    userAgent: log.userAgent,
    createdAt: log.createdAt,
    updatedAt: log.updatedAt,
  };
}

function uniqueSorted(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())))]
    .sort((a, b) => a.localeCompare(b));
}

function aggregateUsage(
  logs: ProxyRequestLog[],
  usersById: Map<string, FeishuUser>,
  getKey: (log: ProxyRequestLog, user: FeishuUser | undefined) => { key: string; label: string },
) {
  const rows = new Map<
    string,
    {
      id: string;
      label: string;
      requestCount: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      cacheReadReportedRequests: number;
      cacheCreationReportedRequests: number;
      cacheRateReadTokens: number;
      cacheRateInputTokens: number;
      cost: number;
      actualCost: number;
      successCount: number;
      durationTotalMs: number;
      durationCount: number;
    }
  >();

  for (const log of logs) {
    const user = log.feishuUserId ? usersById.get(log.feishuUserId) : undefined;
    const key = getKey(log, user);
    let row = rows.get(key.key);
    if (!row) {
      row = {
        id: key.key,
        label: key.label,
        requestCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        cacheReadReportedRequests: 0,
        cacheCreationReportedRequests: 0,
        cacheRateReadTokens: 0,
        cacheRateInputTokens: 0,
        cost: 0,
        actualCost: 0,
        successCount: 0,
        durationTotalMs: 0,
        durationCount: 0,
      };
      rows.set(key.key, row);
    }
    row.requestCount += 1;
    row.promptTokens += log.promptTokens ?? 0;
    row.completionTokens += log.completionTokens ?? 0;
    row.totalTokens += log.totalTokens ?? 0;
    if (log.cacheReadTokens !== undefined) {
      row.cacheReadTokens += log.cacheReadTokens;
      row.cacheReadReportedRequests += 1;
    }
    if (log.cacheCreationTokens !== undefined) {
      row.cacheCreationTokens += log.cacheCreationTokens;
      row.cacheCreationReportedRequests += 1;
    }
    const inputTokensTotal = normalizedInputTokensTotal({
      promptTokens: log.promptTokens,
      inputTokensTotal: log.inputTokensTotal,
      cacheReadTokens: log.cacheReadTokens,
      cacheCreationTokens: log.cacheCreationTokens,
      usageSemantic: log.usageSemantic,
      apiFormat: log.apiFormat,
    });
    if (
      log.cacheReadTokens !== undefined &&
      inputTokensTotal !== undefined &&
      inputTokensTotal > 0
    ) {
      row.cacheRateReadTokens += log.cacheReadTokens;
      row.cacheRateInputTokens += inputTokensTotal;
    }
    row.cost += log.usageSource === "newapi_log" ? log.cost ?? 0 : 0;
    row.actualCost += log.actualCost ?? 0;
    if (logDisplayStatus(log) === "completed") row.successCount += 1;
    if (log.durationMs > 0) {
      row.durationTotalMs += log.durationMs;
      row.durationCount += 1;
    }
  }

  return [...rows.values()]
    .map((row) => ({
      id: row.id,
      label: row.label,
      requestCount: row.requestCount,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      totalTokens: row.totalTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheCreationTokens: row.cacheCreationTokens,
      cacheReadReportedRequests: row.cacheReadReportedRequests,
      cacheCreationReportedRequests: row.cacheCreationReportedRequests,
      cost: row.cost,
      actualCost: row.actualCost,
      successRate: row.requestCount > 0 ? row.successCount / row.requestCount : 0,
      avgDurationMs: row.durationCount > 0 ? row.durationTotalMs / row.durationCount : 0,
      cacheHitRate:
        row.cacheRateInputTokens > 0
          ? row.cacheRateReadTokens / row.cacheRateInputTokens
          : undefined,
      costPerMillionTokens: row.totalTokens > 0 ? (row.cost / row.totalTokens) * 1_000_000 : 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.requestCount - a.requestCount);
}

function filterUsageLogs(
  logs: ProxyRequestLog[],
  usersById: Map<string, FeishuUser>,
  filters: UsageRecordFilters,
) {
  const userId = normalizeFilter(filters.userId);
  const departmentId = normalizeFilter(filters.departmentId);
  const model = normalizeFilter(filters.model);
  const provider = normalizeFilter(filters.provider);
  const apiFormat = normalizeFilter(filters.apiFormat);
  const status = normalizeFilter(filters.status);
  const userAgent = normalizeFilter(filters.userAgent);
  const clientFamily = normalizeFilter(filters.clientFamily);

  return logs
    .filter((log) => matchesDateRange(log, filters))
    .filter((log) => {
      const user = log.feishuUserId ? usersById.get(log.feishuUserId) : undefined;
      if (userId && log.feishuUserId !== userId) return false;
      if (departmentId && logDepartmentId(log, user) !== departmentId) return false;
      if (model && log.model !== model) return false;
      if (provider && log.provider !== provider) return false;
      if (apiFormat && log.apiFormat !== apiFormat) return false;
      if (userAgent && log.userAgent !== userAgent) return false;
      if (!userAgent && clientFamily && log.clientFamily !== clientFamily) return false;
      if (!matchesStatusFilter(log, status)) return false;
      if (filters.hideUnknownRecords && (
        isUnknownUsageValue(log.model) ||
        isUnknownUsageValue(log.provider) ||
        isUnknownUsageValue(log.apiFormat)
      )) {
        return false;
      }
      return matchesSearch(log, user, filters.search);
    });
}

export async function listAdminUsageRecords(input: UsageRecordFilters & {
  scope: AdminScope;
}) {
  if (isPostgresBackend()) {
    const limit = boundedLimit(input.limit, 100);
    const offset = boundedOffset(input.offset);
    const currentPeriod = await getCurrentPackageBillingPeriod();
    const report = await listPostgresUsageReport({
      scope: input.scope,
      currentPeriod,
      ...postgresUsageFilters(input),
      limit,
      offset,
    });
    return {
      records: mapPostgresUsagePage(report.page),
      total: report.total,
      limit,
      offset,
      filters: report.filters,
      modelStats: report.modelStats,
      departmentStats: report.departmentStats,
      apiFormatStats: report.apiFormatStats,
    };
  }
  const store = await readStore();
  const currentPeriod = packageBillingPeriod(store.settings.packageReset);
  const usersById = new Map(store.users.map((user) => [user.id, user]));
  const scopedLogs = store.proxyRequestLogs
    .filter((log) => proxyLogInScope(log, input.scope, usersById))
    .filter(isUsageRecordRequest);
  const dateScopedLogs = scopedLogs.filter((log) => matchesDateRange(log, input));
  const filteredLogs = filterUsageLogs(scopedLogs, usersById, input).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const limit = boundedLimit(input.limit, 100);
  const offset = boundedOffset(input.offset);
  const pageLogs = filteredLogs.slice(offset, offset + limit);
  const userIdsWithLogs = new Set(dateScopedLogs.map((log) => log.feishuUserId).filter(Boolean));
  const departmentQuotaById = new Map<string, { issuedQuota: number; usedQuota: number }>();

  for (const period of store.userBillingPeriods.filter((item) => item.period === currentPeriod)) {
    const user = usersById.get(period.feishuUserId);
    const departmentId = user?.departmentId ?? "unknown";
    const quota = departmentQuotaById.get(departmentId) ?? { issuedQuota: 0, usedQuota: 0 };
    quota.issuedQuota += period.monthlyQuota ?? 0;
    quota.usedQuota += period.quotaConsumed ?? 0;
    departmentQuotaById.set(departmentId, quota);
  }

  const departmentStats = aggregateUsage(filteredLogs, usersById, (log, user) => {
    const id = logDepartmentId(log, user) ?? "unknown";
    const name = logDepartmentName(log, user) ?? departmentNameForId(store, id);
    return {
      key: id,
      label: name ?? id,
    };
  }).map((row) => {
    const quota = departmentQuotaById.get(row.id) ?? { issuedQuota: 0, usedQuota: 0 };
    return {
      ...row,
      issuedQuota: quota.issuedQuota,
      usedQuota: quota.usedQuota,
      usageRate: quota.issuedQuota > 0 ? quota.usedQuota / quota.issuedQuota : 0,
    };
  });

  return {
    records: pageLogs.map((log) => mapUsageRecord(log, usersById)),
    total: filteredLogs.length,
    limit,
    offset,
    filters: {
      users: [...userIdsWithLogs]
        .map((userId) => {
          const user = userId ? usersById.get(userId) : undefined;
          return user
            ? {
                id: user.id,
                name: user.name,
                openId: user.openId,
                departmentId: user.departmentId,
                departmentName: user.departmentName,
              }
            : null;
        })
        .filter(Boolean)
        .sort((a, b) => (a?.name ?? a?.openId ?? "").localeCompare(b?.name ?? b?.openId ?? "")),
      departments: [...new Map(
        dateScopedLogs.map((log) => {
          const user = log.feishuUserId ? usersById.get(log.feishuUserId) : undefined;
          const id = logDepartmentId(log, user) ?? "unknown";
          const name = logDepartmentName(log, user) ?? departmentNameForId(store, id);
          return [
            id,
            {
              id,
              name,
            },
          ] as const;
        }),
      ).values()].sort((a, b) => a.id.localeCompare(b.id)),
      models: uniqueSorted(dateScopedLogs.map((log) => log.model)),
      providers: uniqueSorted(dateScopedLogs.map((log) => log.provider)),
      apiFormats: uniqueSorted(dateScopedLogs.map((log) => log.apiFormat)),
      userAgents: uniqueSorted(dateScopedLogs.map((log) => log.userAgent)),
      clientFamilies: uniqueSorted(dateScopedLogs.map((log) => log.clientFamily)),
    },
    modelStats: aggregateUsage(filteredLogs, usersById, (log) => ({
      key: log.model ?? "unknown",
      label: log.model ?? "unknown",
    })),
    departmentStats,
    apiFormatStats: aggregateUsage(filteredLogs, usersById, (log) => ({
      key: log.apiFormat ?? "unknown",
      label: log.apiFormat ?? "unknown",
    })),
  };
}

export async function listUserUsageRecords(feishuUserId: string, limit = 100) {
  if (isPostgresBackend()) {
    const bounded = boundedLimit(limit, 100);
    const currentPeriod = await getCurrentPackageBillingPeriod();
    const report = await listPostgresUsageReport({
      feishuUserId,
      currentPeriod,
      limit: bounded,
      offset: 0,
    });
    return mapPostgresUsagePage(report.page);
  }
  const store = await readStore();
  const usersById = new Map(store.users.map((user) => [user.id, user]));
  const bounded = boundedLimit(limit, 100);
  return store.proxyRequestLogs
    .filter((log) => log.feishuUserId === feishuUserId)
    .filter(isUsageRecordRequest)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, bounded)
    .map((log) => mapUsageRecord(log, usersById));
}

export async function listUserUsageReport(input: UsageRecordFilters & {
  feishuUserId: string;
}) {
  if (isPostgresBackend()) {
    const limit = boundedLimit(input.limit, 100);
    const offset = boundedOffset(input.offset);
    const currentPeriod = await getCurrentPackageBillingPeriod();
    const report = await listPostgresUsageReport({
      feishuUserId: input.feishuUserId,
      currentPeriod,
      ...postgresUsageFilters(input),
      limit,
      offset,
    });
    return {
      records: mapPostgresUsagePage(report.page),
      total: report.total,
      limit,
      offset,
      filters: {
        models: report.filters.models,
        providers: report.filters.providers,
        apiFormats: report.filters.apiFormats,
        userAgents: report.filters.userAgents,
        clientFamilies: report.filters.clientFamilies,
      },
      modelStats: report.modelStats,
      apiFormatStats: report.apiFormatStats,
      usageOverview: report.usageOverview,
    };
  }
  const store = await readStore();
  const currentPeriod = packageBillingPeriod(store.settings.packageReset);
  const usersById = new Map(store.users.map((user) => [user.id, user]));
  const scopedLogs = store.proxyRequestLogs
    .filter((log) => log.feishuUserId === input.feishuUserId)
    .filter(isUsageRecordRequest);
  const dateScopedLogs = scopedLogs.filter((log) => matchesDateRange(log, input));
  const filteredLogs = filterUsageLogs(scopedLogs, usersById, input).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const limit = boundedLimit(input.limit, 100);
  const offset = boundedOffset(input.offset);
  const pageLogs = filteredLogs.slice(offset, offset + limit);

  return {
    records: pageLogs.map((log) => mapUsageRecord(log, usersById)),
    total: filteredLogs.length,
    limit,
    offset,
    filters: {
      models: uniqueSorted(dateScopedLogs.map((log) => log.model)),
      providers: uniqueSorted(dateScopedLogs.map((log) => log.provider)),
      apiFormats: uniqueSorted(dateScopedLogs.map((log) => log.apiFormat)),
      userAgents: uniqueSorted(dateScopedLogs.map((log) => log.userAgent)),
      clientFamilies: uniqueSorted(dateScopedLogs.map((log) => log.clientFamily)),
    },
    modelStats: aggregateUsage(filteredLogs, usersById, (log) => ({
      key: log.model ?? "unknown",
      label: log.model ?? "unknown",
    })),
    apiFormatStats: aggregateUsage(filteredLogs, usersById, (log) => ({
      key: log.apiFormat ?? "unknown",
      label: log.apiFormat ?? "unknown",
    })),
    usageOverview:
      store.userBillingPeriods.find(
        (period) =>
          period.feishuUserId === input.feishuUserId &&
          period.period === currentPeriod,
      ) ?? null,
  };
}

function hasAuthoritativeBillingAmount(usageLog: NormalizedNewApiUsageLog) {
  return [usageLog.quota, usageLog.cost].some(
    (value) => Number.isFinite(value) && (value as number) >= 0,
  );
}

export async function listDepartmentStats(scope: AdminScope) {
  if (scope.scopeType !== "global") return null;
  const currentPeriod = await getCurrentPackageBillingPeriod();
  if (isPostgresBackend()) {
    return listPostgresDepartmentStats(currentPeriod);
  }

  const store = await readStore();
  const usersById = new Map(store.users.map((user) => [user.id, user]));
  const activeAccounts = store.tokenAccounts.filter((account) => account.status === "active");
  const stats = new Map<
    string,
    {
      departmentId: string;
      departmentName?: string;
      memberCount: number;
      keyedUsers: Set<string>;
      monthlyQuota: number;
      remainingQuota: number;
      quotaConsumed: number;
      cost: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      proxyLogCount: number;
      usageRecordCount: number;
      latestProxyLogAt?: string;
    }
  >();

  function ensure(departmentId?: string, departmentName?: string) {
    const id = departmentId || "unknown";
    let item = stats.get(id);
    if (!item) {
      item = {
        departmentId: id,
        departmentName,
        memberCount: 0,
        keyedUsers: new Set<string>(),
        monthlyQuota: 0,
        remainingQuota: 0,
        quotaConsumed: 0,
        cost: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        proxyLogCount: 0,
        usageRecordCount: 0,
      };
      stats.set(id, item);
    }
    if (!item.departmentName && departmentName) item.departmentName = departmentName;
    return item;
  }

  for (const user of store.users) {
    ensure(user.departmentId, user.departmentName).memberCount += 1;
  }

  for (const account of activeAccounts) {
    const user = usersById.get(account.feishuUserId);
    ensure(user?.departmentId, user?.departmentName).keyedUsers.add(account.feishuUserId);
  }

  for (const period of store.userBillingPeriods.filter((item) => item.period === currentPeriod)) {
    const user = usersById.get(period.feishuUserId);
    const item = ensure(user?.departmentId, user?.departmentName);
    item.monthlyQuota += period.monthlyQuota;
    item.remainingQuota += period.remainingQuota ?? Math.max(period.monthlyQuota - (period.quotaConsumed ?? 0), 0);
    item.quotaConsumed += period.quotaConsumed ?? 0;
    item.cost += period.cost ?? period.quotaConsumed ?? 0;
    item.usageRecordCount += period.usageRecordCount ?? 0;
  }

  for (const log of store.proxyRequestLogs) {
    const user = log.feishuUserId ? usersById.get(log.feishuUserId) : undefined;
    const item = ensure(logDepartmentId(log, user), logDepartmentName(log, user));
    item.promptTokens += log.promptTokens ?? 0;
    item.completionTokens += log.completionTokens ?? 0;
    item.totalTokens += log.totalTokens ?? 0;
    item.proxyLogCount += 1;
    if (!item.latestProxyLogAt || log.createdAt.localeCompare(item.latestProxyLogAt) > 0) {
      item.latestProxyLogAt = log.createdAt;
    }
  }

  const totalQuotaConsumed = [...stats.values()].reduce((sum, item) => sum + item.quotaConsumed, 0);
  return [...stats.values()]
    .map((item) => ({
      departmentId: item.departmentId,
      departmentName: item.departmentName,
      memberCount: item.memberCount,
      keyedUsers: item.keyedUsers.size,
      monthlyQuota: item.monthlyQuota,
      remainingQuota: item.remainingQuota,
      quotaConsumed: item.quotaConsumed,
      cost: item.cost,
      promptTokens: item.promptTokens,
      completionTokens: item.completionTokens,
      totalTokens: item.totalTokens,
      proxyLogCount: item.proxyLogCount,
      usageRecordCount: item.usageRecordCount,
      usageShare: totalQuotaConsumed > 0 ? item.quotaConsumed / totalQuotaConsumed : 0,
      quotaUsageRate: item.monthlyQuota > 0 ? item.quotaConsumed / item.monthlyQuota : 0,
      latestProxyLogAt: item.latestProxyLogAt,
    }))
    .sort((a, b) => b.quotaConsumed - a.quotaConsumed || b.totalTokens - a.totalTokens);
}

function mapAdminTokenRequest(request: TokenRequest, user?: FeishuUser) {
  return {
    id: request.id,
    requestType: request.requestType,
    status: request.status,
    reason: request.reason,
    requestedMonthlyQuota: request.requestedMonthlyQuota,
    approvedMonthlyQuota: request.approvedMonthlyQuota,
    approvalInstanceCode: request.approvalInstanceCode,
    approvalTargetSource: request.approvalTargetSource,
    approvalTargetOpenId: request.approvalTargetOpenId,
    approvalCardMessageId: request.approvalCardMessageId,
    approvalOperatorOpenId: request.approvalOperatorOpenId,
    approvalOperatedAt: request.approvalOperatedAt,
    tokenAccountId: request.tokenAccountId,
    errorMessage: request.errorMessage,
    requesterName: user?.name,
    requesterOpenId: user?.openId,
    departmentId: user?.departmentId,
    departmentName: user?.departmentName,
    updatedAt: request.updatedAt,
    createdAt: request.createdAt,
  };
}

export async function listAdminTokenRequests(input: {
  scope: AdminScope;
  limit?: number;
  offset?: number;
  createdAfter?: string;
  decisionRequired?: boolean;
}) {
  const limit = boundedLimit(input.limit, 50);
  const offset = boundedOffset(input.offset);
  if (isPostgresBackend()) {
    const result = await listPostgresAdminTokenRequestRows({
      scope: input.scope,
      limit,
      offset,
      createdAfter: input.createdAfter,
      decisionRequired: input.decisionRequired,
      decisionStatuses: [...adminDecidableRequestStatuses],
    });
    return {
      requests: result.page.map(({ request, user }) =>
        mapAdminTokenRequest(request, user ?? undefined),
      ),
      total: result.total,
      limit,
      offset,
    };
  }
  const store = await readStore();
  const usersById = new Map(store.users.map((user) => [user.id, user]));
  const systemAdminOpenIds = globalAdminOpenIds(store, usersById);
  const scopedRequests = store.tokenRequests
    .filter(
      (request) =>
        tokenRequestInScope(request, input.scope, usersById, systemAdminOpenIds) &&
        isAtOrAfterIsoTimestamp(request.createdAt, input.createdAfter) &&
        (!input.decisionRequired || tokenRequestRequiresAdminDecision(request)),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    requests: scopedRequests
      .slice(offset, offset + limit)
      .map((request) => mapAdminTokenRequest(request, usersById.get(request.feishuUserId))),
    total: scopedRequests.length,
    limit,
    offset,
  };
}

export async function getAdminOverview(scope: AdminScope) {
  if (isPostgresBackend()) {
    const currentPeriod = nowIso().slice(0, 7);
    const cached = await getPostgresAdminOverview(scope, currentPeriod);
    const snapshot = cached.snapshot;
    const totals = snapshot.totals;
    if (!totals) throw new Error("PostgreSQL admin overview returned no totals row");
    return {
      overviewAsOf: cached.overviewAsOf,
      overviewCacheState: cached.overviewCacheState,
      scope: {
        type: scope.scopeType,
        departmentId: scope.departmentId,
        departmentName: snapshot.departmentName,
        source: scope.source,
        role: scope.role,
      },
      totals: {
        users: Number(totals.users) || 0,
        keyedUsers: Number(totals.keyed_users) || 0,
        tokenRequests: Number(totals.token_requests) || 0,
        pendingRequests: Number(totals.pending_requests) || 0,
        provisionedRequests: Number(totals.provisioned_requests) || 0,
        failedRequests: Number(totals.failed_requests) || 0,
        activeTokens: Number(totals.active_tokens) || 0,
        proxyLogs: Number(totals.proxy_logs) || 0,
        promptTokens: Number(totals.prompt_tokens) || 0,
        completionTokens: Number(totals.completion_tokens) || 0,
        totalTokens: Number(totals.total_tokens) || 0,
        currentBillingPeriod: currentPeriod,
        currentPeriodMonthlyQuota: Number(totals.current_period_monthly_quota) || 0,
        currentPeriodQuotaConsumed: Number(totals.current_period_quota_consumed) || 0,
        currentPeriodCost: Number(totals.current_period_cost) || 0,
        currentPeriodRemainingQuota: Number(totals.current_period_remaining_quota) || 0,
        currentPeriodUsageRecords: Number(totals.current_period_usage_records) || 0,
        currentPeriodProxyLogs: Number(totals.current_period_proxy_logs) || 0,
        currentPeriodPromptTokens: Number(totals.current_period_prompt_tokens) || 0,
        currentPeriodCompletionTokens:
          Number(totals.current_period_completion_tokens) || 0,
        currentPeriodTotalTokens: Number(totals.current_period_total_tokens) || 0,
      },
      latestRequests: snapshot.latestRequests.map((row) =>
        mapAdminTokenRequest(row.request_data, row.user_data ?? undefined),
      ),
      users: snapshot.users.map((row) => {
        const user = row.user_data;
        const activeAccount = row.account_data;
        const billingPeriod = activeAccount?.billingPeriod ?? currentPeriod;
        const billing = row.billing_data;
        return {
          id: user.id,
          name: user.name,
          openId: user.openId,
          departmentId: user.departmentId,
          departmentName: user.departmentName,
          activeTokenStatus: activeAccount?.status,
          activeTokenCreatedAt: activeAccount?.createdAt,
          billingPeriod,
          billingMonthlyQuota: billing?.monthlyQuota,
          billingPromptTokens: billing?.promptTokens,
          billingCompletionTokens: billing?.completionTokens,
          billingTotalTokens: billing?.totalTokens,
          billingQuotaConsumed: billing?.quotaConsumed,
          billingCost: billing?.cost,
          billingRemainingQuota: billing?.remainingQuota,
          billingProxyLogCount: billing?.proxyLogCount,
          billingUsageRecordCount: billing?.usageRecordCount,
          requestCount: Number(row.request_count) || 0,
          proxyLogCount: Number(row.proxy_log_count) || 0,
          totalTokens: Number(row.total_tokens) || 0,
          updatedAt: user.updatedAt,
          createdAt: user.createdAt,
        };
      }),
      latestProxyLogs: snapshot.latestProxyLogs.map((row) => ({
        id: row.log_data.id,
        requestPath: row.log_data.requestPath,
        method: row.log_data.method,
        statusCode: row.log_data.statusCode,
        durationMs: row.log_data.durationMs,
        promptTokens: row.log_data.promptTokens,
        completionTokens: row.log_data.completionTokens,
        totalTokens: row.log_data.totalTokens,
        clientIp: row.log_data.clientIp,
        userAgent: row.log_data.userAgent,
        requesterName: row.user_data?.name,
        requesterOpenId: row.user_data?.openId,
        createdAt: row.log_data.createdAt,
      })),
    };
  }
  const store = await readStore();
  const currentPeriod = nowIso().slice(0, 7);
  const usersById = new Map(store.users.map((user) => [user.id, user]));
  const systemAdminOpenIds = globalAdminOpenIds(store, usersById);
  const scopedUsers =
    scope.scopeType === "global"
      ? store.users
      : store.users.filter((user) => user.departmentId === scope.departmentId);
  const scopedRequests = store.tokenRequests.filter((request) =>
    tokenRequestInScope(request, scope, usersById, systemAdminOpenIds),
  );
  const scopedAccounts = store.tokenAccounts.filter((account) =>
    tokenAccountInScope(account, scope, usersById),
  );
  const scopedProxyLogs = store.proxyRequestLogs.filter((log) =>
    proxyLogInScope(log, scope, usersById),
  );
  const scopedBillingPeriods =
    scope.scopeType === "global"
      ? store.userBillingPeriods
      : store.userBillingPeriods.filter((period) => {
          const user = usersById.get(period.feishuUserId);
          return user?.departmentId === scope.departmentId;
        });
  const billingByUserAndPeriod = new Map(
    scopedBillingPeriods.map((period) => [
      billingKey(period.feishuUserId, period.period),
      period,
    ]),
  );
  const currentBillingPeriods = scopedBillingPeriods.filter(
    (period) => period.period === currentPeriod,
  );
  const activeAccountsByUserId = new Map(
    scopedAccounts
      .filter((account) => account.status === "active")
      .map((account) => [account.feishuUserId, account]),
  );
  const requestCountsByUserId = new Map<string, number>();
  for (const request of scopedRequests) {
    requestCountsByUserId.set(
      request.feishuUserId,
      (requestCountsByUserId.get(request.feishuUserId) ?? 0) + 1,
    );
  }
  const proxyLogCountsByUserId = new Map<string, number>();
  const tokenUsageByUserId = new Map<string, number>();
  for (const log of scopedProxyLogs) {
    if (!log.feishuUserId) continue;
    proxyLogCountsByUserId.set(
      log.feishuUserId,
      (proxyLogCountsByUserId.get(log.feishuUserId) ?? 0) + 1,
    );
    tokenUsageByUserId.set(
      log.feishuUserId,
      (tokenUsageByUserId.get(log.feishuUserId) ?? 0) + (log.totalTokens ?? 0),
    );
  }
  const totalPromptTokens = scopedProxyLogs.reduce(
    (sum, log) => sum + (log.promptTokens ?? 0),
    0,
  );
  const totalCompletionTokens = scopedProxyLogs.reduce(
    (sum, log) => sum + (log.completionTokens ?? 0),
    0,
  );
  const totalTokens = scopedProxyLogs.reduce(
    (sum, log) => sum + (log.totalTokens ?? 0),
    0,
  );
  const activeScopedAccounts = scopedAccounts.filter((account) => account.status === "active");
  const currentPeriodMonthlyQuota = currentBillingPeriods.reduce(
    (sum, period) => sum + period.monthlyQuota,
    0,
  );
  const currentPeriodTotalTokens = currentBillingPeriods.reduce(
    (sum, period) => sum + period.totalTokens,
    0,
  );
  const currentPeriodQuotaConsumed = currentBillingPeriods.reduce(
    (sum, period) => sum + (period.quotaConsumed ?? 0),
    0,
  );
  const currentPeriodCost = currentBillingPeriods.reduce(
    (sum, period) => sum + (period.cost ?? period.quotaConsumed ?? 0),
    0,
  );
  const currentPeriodRemainingQuota = currentBillingPeriods.reduce(
    (sum, period) =>
      sum + (period.remainingQuota ?? Math.max(period.monthlyQuota - (period.quotaConsumed ?? 0), 0)),
    0,
  );

  return {
    overviewAsOf: nowIso(),
    overviewCacheState: "uncached" as const,
    scope: {
      type: scope.scopeType,
      departmentId: scope.departmentId,
      departmentName: departmentNameForId(store, scope.departmentId),
      source: scope.source,
      role: scope.role,
    },
    totals: {
      users: scopedUsers.length,
      keyedUsers: new Set(activeScopedAccounts.map((account) => account.feishuUserId)).size,
      tokenRequests: scopedRequests.length,
      pendingRequests: scopedRequests.filter(
        (request) =>
          request.status === "pending_feishu_approval" ||
          request.status === "pending_card_send" ||
          request.status === "pending_card_approval",
      ).length,
      provisionedRequests: scopedRequests.filter(
        (request) => request.status === "provisioned",
      ).length,
      failedRequests: scopedRequests.filter(
        (request) => request.status === "approved_provision_failed",
      ).length,
      activeTokens: activeScopedAccounts.length,
      proxyLogs: scopedProxyLogs.length,
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      totalTokens,
      currentBillingPeriod: currentPeriod,
      currentPeriodMonthlyQuota,
      currentPeriodQuotaConsumed,
      currentPeriodCost,
      currentPeriodRemainingQuota,
      currentPeriodUsageRecords: currentBillingPeriods.reduce(
        (sum, period) => sum + (period.usageRecordCount ?? 0),
        0,
      ),
      currentPeriodProxyLogs: currentBillingPeriods.reduce(
        (sum, period) => sum + period.proxyLogCount,
        0,
      ),
      currentPeriodPromptTokens: currentBillingPeriods.reduce(
        (sum, period) => sum + period.promptTokens,
        0,
      ),
      currentPeriodCompletionTokens: currentBillingPeriods.reduce(
        (sum, period) => sum + period.completionTokens,
        0,
      ),
      currentPeriodTotalTokens,
    },
    latestRequests: [...scopedRequests]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 20)
      .map((request) => mapAdminTokenRequest(request, usersById.get(request.feishuUserId))),
    users: [...scopedUsers]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 50)
      .map((user) => {
        const activeAccount = activeAccountsByUserId.get(user.id);
        const billingPeriod = activeAccount?.billingPeriod ?? currentPeriod;
        const billingSummary = billingByUserAndPeriod.get(billingKey(user.id, billingPeriod));
        return {
          id: user.id,
          name: user.name,
          openId: user.openId,
          departmentId: user.departmentId,
          departmentName: user.departmentName,
          activeTokenStatus: activeAccount?.status,
          activeTokenCreatedAt: activeAccount?.createdAt,
          billingPeriod,
          billingMonthlyQuota: billingSummary?.monthlyQuota,
          billingPromptTokens: billingSummary?.promptTokens,
          billingCompletionTokens: billingSummary?.completionTokens,
          billingTotalTokens: billingSummary?.totalTokens,
          billingQuotaConsumed: billingSummary?.quotaConsumed,
          billingCost: billingSummary?.cost,
          billingRemainingQuota: billingSummary?.remainingQuota,
          billingProxyLogCount: billingSummary?.proxyLogCount,
          billingUsageRecordCount: billingSummary?.usageRecordCount,
          requestCount: requestCountsByUserId.get(user.id) ?? 0,
          proxyLogCount: proxyLogCountsByUserId.get(user.id) ?? 0,
          totalTokens: tokenUsageByUserId.get(user.id) ?? 0,
          updatedAt: user.updatedAt,
          createdAt: user.createdAt,
        };
      }),
    latestProxyLogs: [...scopedProxyLogs]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50)
      .map((log) => {
        const user = log.feishuUserId ? usersById.get(log.feishuUserId) : undefined;
        return {
          id: log.id,
          requestPath: log.requestPath,
          method: log.method,
          statusCode: log.statusCode,
          durationMs: log.durationMs,
          promptTokens: log.promptTokens,
          completionTokens: log.completionTokens,
          totalTokens: log.totalTokens,
          clientIp: log.clientIp,
          userAgent: log.userAgent,
          requesterName: user?.name,
          requesterOpenId: user?.openId,
          createdAt: log.createdAt,
        };
      }),
  };
}
