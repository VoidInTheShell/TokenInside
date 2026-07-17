import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { tokenRequestInAdminScope } from "@/lib/admin-scope";
import { getConfig } from "@/lib/config";
import { nowIso, randomId } from "@/lib/crypto";
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
import { assertQuotaAdmission } from "@/lib/quota-admission";
import {
  hongKongBillingPeriod,
  initialUnassignedMonthlyQuota,
  materializeDepartmentQuota,
  materializeUserQuota,
  resolveUsageBillingPeriod,
} from "@/lib/quota-model";
import { assertQuotaOperationTransition } from "@/lib/quota-saga-state";
import { tokenRequestRequiresAdminDecision } from "@/lib/token-request-policy";
import {
  currentQuotaPeriod,
  initialDepartmentQuotaLimit,
  summarizeDepartmentQuota,
  validateDepartmentAllocation,
  validateDepartmentQuotaLimit,
} from "@/lib/department-quota";
import {
  enablePostgresUserAccess,
  claimPostgresQuotaOperationExecution,
  beginPostgresQuotaAwareProxyRequest,
  createPostgresMonthlyOpenOperations,
  createPostgresQuotaOperation,
  findPostgresQuotaOperationById,
  findPostgresQuotaOperationByIdempotencyKey,
  findPostgresActiveTokenByHash,
  finalizePostgresTokenProvision,
  finalizePostgresTokenRotation,
  finalizePostgresTokenRotationForQuotaOperation,
  getPostgresDisabledTokenForUser,
  getPostgresActiveTokenForUser,
  getPostgresActiveAdminScopeForUser,
  getPostgresAppSettings,
  getPostgresAppSettingsForQuotaOperation,
  getPostgresFeishuEventByUuid,
  getPostgresEffectiveUserQuotaPolicy,
  getPostgresTokenRequestById,
  getPostgresUserBillingPeriod,
  getPostgresUserById,
  getPostgresUserQuotaState,
  insertPostgresQuotaAwareProxyLog,
  insertPostgresProxyLog,
  insertPostgresQuotaLedgerEntry,
  insertPostgresTokenAccount,
  insertPostgresTokenAccountForQuotaOperation,
  insertPostgresTokenRequest,
  insertPostgresDepartmentQuotaRequest,
  invalidatePostgresOpenFirstApplyRequests,
  listPostgresInflightProxyRequests,
  listPostgresInflightProxyRequestsForQuotaOperation,
  listPostgresQuotaOperations,
  listPostgresTokenAccountsForUser,
  mutatePostgresAppSettings,
  recordPostgresMonthlyResetApplied,
  rebuildPostgresDepartmentQuotaMaterializedSnapshot,
  rebuildPostgresDepartmentQuotaMaterializedSnapshotForQuotaOperation,
  rebuildPostgresQuotaMaterializedUsers,
  replacePostgresActiveTokenAccount,
  readPostgresStore,
  readPostgresUsageMatchingSnapshot,
  reconcilePostgresBillingPeriodForUser,
  reconcilePostgresBillingPeriodForQuotaOperation,
  refreshPostgresBillingPeriodTokenMetadataForQuotaOperation,
  releasePostgresQuotaOperationExecution,
  renewPostgresQuotaOperationExecution,
  reservePostgresQuotaOperationDepartmentBudget,
  revokePostgresAdminScopesForUser,
  settlePostgresMatchedNewApiUsage,
  syncPostgresDepartmentSupervisorAdminScope,
  transitionPostgresQuotaOperation,
  transitionPostgresTokenRequest,
  updatePostgresManualAdminScope,
  updatePostgresProxyLog,
  updatePostgresTokenRequest,
  updatePostgresTokenRequestForQuotaOperation,
  updatePostgresTokenAccount,
  updatePostgresTokenAccountForQuotaOperation,
  updatePostgresDepartmentQuotaRequest,
  updatePostgresUserAccessStatus,
  updatePostgresQuotaOperation,
  upsertPostgresFeishuEvent,
  upsertPostgresFeishuUser,
  upsertPostgresDepartmentQuotaPeriod,
  upsertPostgresQuotaChangeEvent,
  upsertPostgresQuotaReconciliationRecord,
  upsertPostgresUserQuotaPolicy,
  upsertPostgresUserQuotaState,
  upsertPostgresUserBillingPeriod,
  upsertPostgresNewApiUsageRecord,
  upsertPostgresUsageSyncCheckpoint,
  upsertPostgresUsageSyncIssue,
  upsertPostgresManualAdminScope,
  withPostgresAdvisoryLock,
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
  QuotaFeatureFlags,
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

export function defaultUsageSyncPolicy(): UsageSyncPolicy {
  return {
    // Authoritative NewAPI usage is the recovery source for process restarts,
    // delayed control-plane logs and downstream cancellations. New installs
    // must not silently run without that durable repair loop.
    enabled: true,
    intervalMinutes: 5,
    pageSize: 100,
    maxPagesPerRun: 3,
    overlapMinutes: 120,
    settlementLagMinutes: 1,
    matchWindowMinutes: 30,
    retryBaseMinutes: 5,
  };
}

export function defaultQuotaFeatureFlags(): QuotaFeatureFlags {
  return {
    legacyAbsoluteQuotaWritesEnabled: false,
    quotaLedgerShadowRead: true,
    quotaSagaWritesEnabled: false,
    keyRotationSagaEnabled: false,
    quotaRestoreEnabled: false,
    monthlyPeriodOpenEnabled: false,
    reconciliationAutoDecreaseEnabled: false,
    reconciliationAutoIncreaseEnabled: false,
  };
}

const initialStore: StoreShape = {
  version: 1,
  settings: {
    defaultMonthlyQuota: 200,
    usageSyncPolicy: defaultUsageSyncPolicy(),
    quotaFeatureFlags: defaultQuotaFeatureFlags(),
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
    enabled: policy?.enabled ?? defaults.enabled,
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

function normalizeQuotaFeatureFlags(flags?: Partial<QuotaFeatureFlags>): QuotaFeatureFlags {
  return {
    ...defaultQuotaFeatureFlags(),
    ...flags,
    reconciliationAutoIncreaseEnabled: false,
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
  const normalizedQuotaFlags = normalizeQuotaFeatureFlags(store.settings.quotaFeatureFlags);
  if (
    JSON.stringify(store.settings.quotaFeatureFlags ?? null) !==
    JSON.stringify(normalizedQuotaFlags)
  ) {
    store.settings.quotaFeatureFlags = normalizedQuotaFlags;
    changed = true;
  }
  if (!Array.isArray(store.settings.billingOperations)) {
    store.settings.billingOperations = [];
    changed = true;
  }
  if (store.settings.billingOperations.length > maxBillingOperationRecords) {
    store.settings.billingOperations = store.settings.billingOperations.slice(
      0,
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

function usageRecordPeriod(record: NewApiUsageRecord) {
  return resolveUsageBillingPeriod({
    billingPeriod: record.billingPeriod,
    occurredAt: record.newapiCreatedAt ?? record.lastSyncedAt ?? record.firstSeenAt,
  });
}

function syncBillingPeriods(store: StoreShape) {
  let changed = false;
  const initialMonthlyQuota = initialUnassignedMonthlyQuota({
    defaultMonthlyQuota: store.settings.defaultMonthlyQuota,
    quotaMigrationApplied: Boolean(store.settings.quotaMigration?.appliedAt),
  });
  const existingByKey = new Map(
    store.userBillingPeriods.map((period) => [
      billingKey(period.feishuUserId, period.period),
      period,
    ]),
  );
  const requestById = new Map(store.tokenRequests.map((request) => [request.id, request]));
  const accountById = new Map(store.tokenAccounts.map((account) => [account.id, account]));
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

  function setQuota(summary: UserBillingPeriod & { quotaUpdatedAt?: string }, quota: number, at: string) {
    if (!Number.isFinite(quota) || quota <= 0) return;
    if (!summary.quotaUpdatedAt || at.localeCompare(summary.quotaUpdatedAt) >= 0) {
      summary.monthlyQuota = quota;
      summary.quotaUpdatedAt = at;
    }
  }

  for (const account of store.tokenAccounts) {
    const period = account.billingPeriod || periodFromIso(account.createdAt);
    const summary = ensure(account.feishuUserId, period);
    summary.tokenAccountIds.push(account.id);
    if (account.status === "active") {
      summary.activeTokenAccountId = account.id;
    }
    summary.sourceUpdatedAt = latestIso(summary.sourceUpdatedAt, account.createdAt, account.disabledAt);

    const request = requestById.get(account.tokenRequestId);
    if (
      request &&
      request.requestType !== "key_reset" &&
      request.requestType !== "quota_reset" &&
      request.requestType !== "quota_restore"
    ) {
      setQuota(
        summary,
        request.approvedMonthlyQuota ?? request.requestedMonthlyQuota,
        request.updatedAt,
      );
      summary.sourceUpdatedAt = latestIso(summary.sourceUpdatedAt, request.updatedAt);
    }
  }

  for (const request of store.tokenRequests) {
    if (
      request.status !== "provisioned" ||
      (request.requestType !== "quota_adjust" &&
        request.requestType !== "monthly_reset") ||
      !request.tokenAccountId
    ) {
      continue;
    }
    const account = accountById.get(request.tokenAccountId);
    if (!account) continue;
    const summary = ensure(account.feishuUserId, account.billingPeriod || periodFromIso(account.createdAt));
    setQuota(
      summary,
      request.approvedMonthlyQuota ?? request.requestedMonthlyQuota,
      request.updatedAt,
    );
    summary.sourceUpdatedAt = latestIso(summary.sourceUpdatedAt, request.updatedAt);
  }

  const proxyLogIdsBackedByNewApiRecords = new Set<string>();
  for (const record of store.newapiUsageRecords) {
    if (record.matchStatus !== "matched") continue;
    if (record.matchedProxyLogId) {
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
    summary.quotaConsumed = Number(summary.quotaConsumed.toFixed(8));
    summary.cost = Number(summary.cost.toFixed(8));
    summary.remainingQuota = Math.max(Number((summary.monthlyQuota - summary.quotaConsumed).toFixed(8)), 0);
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

export async function getAppSettings() {
  if (isPostgresBackend()) {
    const settings = await getPostgresAppSettings();
    return {
      ...settings,
      usageSyncPolicy: normalizeUsageSyncPolicy(settings.usageSyncPolicy),
      quotaFeatureFlags: normalizeQuotaFeatureFlags(settings.quotaFeatureFlags),
      billingOperations: settings.billingOperations ?? [],
    };
  }
  const store = await readStore();
  return store.settings;
}

export async function getAppSettingsForQuotaOperation() {
  if (isPostgresBackend()) {
    const settings = await getPostgresAppSettingsForQuotaOperation();
    return {
      ...settings,
      usageSyncPolicy: normalizeUsageSyncPolicy(settings.usageSyncPolicy),
      quotaFeatureFlags: normalizeQuotaFeatureFlags(settings.quotaFeatureFlags),
      billingOperations: settings.billingOperations ?? [],
    };
  }
  return getAppSettings();
}

function prependBillingOperation(
  store: StoreShape,
  input: {
    kind: BillingOperationKind;
    status: BillingOperationStatus;
    dryRun: boolean;
    operatedByFeishuUserId: string;
    period?: string;
    input?: Record<string, unknown>;
    summary: BillingOperationRecord["summary"];
    errorMessage?: string;
  },
) {
  const now = nowIso();
  const record: BillingOperationRecord = {
    id: randomId("bo"),
    createdAt: now,
    updatedAt: now,
    ...input,
  };
  const records = store.settings.billingOperations ?? [];
  store.settings.billingOperations = [record, ...records].slice(0, maxBillingOperationRecords);
  return record;
}

export async function updateAppSettings(input: {
  defaultMonthlyQuota?: number;
  usageSyncPolicy?: Partial<UsageSyncPolicy>;
  quotaFeatureFlags?: Partial<QuotaFeatureFlags>;
  updatedByFeishuUserId: string;
}) {
  if (isPostgresBackend()) {
    return mutatePostgresAppSettings((settings) => {
      const store = {
        ...structuredClone(initialStore),
        settings: {
          ...initialStore.settings,
          ...settings,
        },
      };
      const previousDefaultMonthlyQuota = store.settings.defaultMonthlyQuota;
      const previousUsageSyncPolicy = normalizeUsageSyncPolicy(store.settings.usageSyncPolicy);
      const previousQuotaFeatureFlags = normalizeQuotaFeatureFlags(
        store.settings.quotaFeatureFlags,
      );
      const nextDefaultMonthlyQuota =
        input.defaultMonthlyQuota ?? store.settings.defaultMonthlyQuota;
      const nextUsageSyncPolicy = input.usageSyncPolicy
        ? normalizeUsageSyncPolicy({
            ...previousUsageSyncPolicy,
            ...input.usageSyncPolicy,
            updatedAt: nowIso(),
            updatedByFeishuUserId: input.updatedByFeishuUserId,
          })
        : previousUsageSyncPolicy;
      const nextQuotaFeatureFlags = input.quotaFeatureFlags
        ? normalizeQuotaFeatureFlags({
            ...previousQuotaFeatureFlags,
            ...input.quotaFeatureFlags,
          })
        : previousQuotaFeatureFlags;
      store.settings = {
        ...store.settings,
        defaultMonthlyQuota: nextDefaultMonthlyQuota,
        usageSyncPolicy: nextUsageSyncPolicy,
        quotaFeatureFlags: nextQuotaFeatureFlags,
        updatedAt: nowIso(),
        updatedByFeishuUserId: input.updatedByFeishuUserId,
      };
      prependBillingOperation(store, {
        kind: "settings_update",
        status: "applied",
        dryRun: false,
        operatedByFeishuUserId: input.updatedByFeishuUserId,
        input: {
          previousDefaultMonthlyQuota,
          defaultMonthlyQuota: nextDefaultMonthlyQuota,
          usageSyncPolicyUpdated: Boolean(input.usageSyncPolicy),
          quotaFeatureFlagsUpdated: Boolean(input.quotaFeatureFlags),
        },
        summary: {
          previousDefaultMonthlyQuota,
          defaultMonthlyQuota: nextDefaultMonthlyQuota,
          usageSyncPolicyUpdated: Boolean(input.usageSyncPolicy),
          quotaFeatureFlagsUpdated: Boolean(input.quotaFeatureFlags),
        },
      });
      Object.assign(settings, store.settings);
      return store.settings;
    });
  }

  return mutate((store) => {
    const previousDefaultMonthlyQuota = store.settings.defaultMonthlyQuota;
    const previousUsageSyncPolicy = normalizeUsageSyncPolicy(store.settings.usageSyncPolicy);
    const previousQuotaFeatureFlags = normalizeQuotaFeatureFlags(
      store.settings.quotaFeatureFlags,
    );
    const nextDefaultMonthlyQuota = input.defaultMonthlyQuota ?? store.settings.defaultMonthlyQuota;
    const nextUsageSyncPolicy = input.usageSyncPolicy
      ? normalizeUsageSyncPolicy({
          ...previousUsageSyncPolicy,
          ...input.usageSyncPolicy,
          updatedAt: nowIso(),
          updatedByFeishuUserId: input.updatedByFeishuUserId,
        })
      : previousUsageSyncPolicy;
    const nextQuotaFeatureFlags = input.quotaFeatureFlags
      ? normalizeQuotaFeatureFlags({
          ...previousQuotaFeatureFlags,
          ...input.quotaFeatureFlags,
        })
      : previousQuotaFeatureFlags;
    store.settings = {
      ...store.settings,
      defaultMonthlyQuota: nextDefaultMonthlyQuota,
      usageSyncPolicy: nextUsageSyncPolicy,
      quotaFeatureFlags: nextQuotaFeatureFlags,
      updatedAt: nowIso(),
      updatedByFeishuUserId: input.updatedByFeishuUserId,
    };
    prependBillingOperation(store, {
      kind: "settings_update",
      status: "applied",
      dryRun: false,
      operatedByFeishuUserId: input.updatedByFeishuUserId,
      input: {
        previousDefaultMonthlyQuota,
        defaultMonthlyQuota: nextDefaultMonthlyQuota,
        usageSyncPolicyUpdated: Boolean(input.usageSyncPolicy),
        quotaFeatureFlagsUpdated: Boolean(input.quotaFeatureFlags),
      },
      summary: {
        previousDefaultMonthlyQuota,
        defaultMonthlyQuota: nextDefaultMonthlyQuota,
        usageSyncPolicyUpdated: Boolean(input.usageSyncPolicy),
        quotaFeatureFlagsUpdated: Boolean(input.quotaFeatureFlags),
      },
    });
    return store.settings;
  });
}

export async function recordBillingOperation(input: {
  kind: BillingOperationKind;
  status: BillingOperationStatus;
  dryRun: boolean;
  operatedByFeishuUserId: string;
  period?: string;
  input?: Record<string, unknown>;
  summary: BillingOperationRecord["summary"];
  errorMessage?: string;
}) {
  if (isPostgresBackend()) {
    return mutatePostgresAppSettings((settings) => {
      const store = {
        ...structuredClone(initialStore),
        settings: {
          ...initialStore.settings,
          ...settings,
        },
      };
      const record = prependBillingOperation(store, input);
      Object.assign(settings, store.settings);
      return record;
    });
  }

  return mutate((store) => {
    return prependBillingOperation(store, input);
  });
}

export async function listBillingOperations(limit = 20) {
  if (isPostgresBackend()) {
    const settings = await getPostgresAppSettings();
    return (settings.billingOperations ?? []).slice(0, Math.max(limit, 0));
  }
  const store = await readStore();
  return (store.settings.billingOperations ?? []).slice(0, Math.max(limit, 0));
}

export async function getUsageSyncCheckpoint(scope: UsageSyncCheckpoint["scope"] = "newapi_usage_logs") {
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
  const store = await readStore();
  return store.users.find((user) => user.openId === openId) ?? null;
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
  fn: () => Promise<T>,
) {
  // This session-level fence is intentionally distinct from the short
  // transaction lock used by user_quota_states. Reusing the same advisory key
  // across two pooled connections would make the outer callback wait on itself.
  const key = `user-quota-fence:${feishuUserId}`;
  if (isPostgresBackend()) {
    return withPostgresAdvisoryLock(key, fn, { wait: true });
  }
  return withJsonDepartmentQuotaLock(key, fn);
}

export async function getEffectiveUserQuotaPolicy(
  feishuUserId: string,
  period = currentQuotaPeriod(),
) {
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
  const period = input.effectiveFromPeriod ?? currentQuotaPeriod();
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
    assignedMonthlyQuota: Math.max(Math.trunc(input.assignedMonthlyQuota), 0),
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
  if (isPostgresBackend()) return upsertPostgresUserQuotaPolicy(policy);
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
  const operation: QuotaOperation = {
    id: randomId("qo"),
    operationType: input.operationType,
    idempotencyKey: input.idempotencyKey,
    feishuUserId: input.feishuUserId,
    departmentId: input.departmentId,
    billingPeriod: input.billingPeriod ?? currentQuotaPeriod(),
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
      const idempotent = store.quotaOperations.find(
        (item) => item.idempotencyKey === input.idempotencyKey,
      );
      if (idempotent) return idempotent;
      const open = store.quotaOperations.find(
        (item) =>
          item.feishuUserId === input.feishuUserId &&
          item.state !== "completed" &&
          item.state !== "compensated",
      );
      if (open) throw new Error(`用户已有未完成额度操作: ${open.id}`);
      store.quotaOperations.push(operation);
      return operation;
    }),
  );
}

export async function createMonthlyOpenQuotaOperations(
  inputs: Array<{
    feishuUserId: string;
    departmentId: string;
    billingPeriod: string;
    assignedMonthlyQuota: number;
    createdByOpenId?: string;
  }>,
) {
  if (!inputs.length) return [];
  if (isPostgresBackend()) return createPostgresMonthlyOpenOperations(inputs);
  return withJsonDepartmentQuotaLock(
    `monthly-open-batch:${inputs.map((item) => item.billingPeriod).sort().join(":")}`,
    () =>
      mutate((store) => {
        const operations: QuotaOperation[] = [];
        const newInputs: typeof inputs = [];
        for (const input of inputs) {
          const idempotencyKey = `monthly-open:${input.billingPeriod}:${input.feishuUserId}`;
          const idempotent = store.quotaOperations.find(
            (item) => item.idempotencyKey === idempotencyKey,
          );
          if (idempotent) {
            if (
              idempotent.requestedAssignedQuota !== input.assignedMonthlyQuota ||
              idempotent.departmentId !== input.departmentId
            ) {
              throw new Error(`月度开账幂等记录与当前策略不一致: ${idempotent.id}`);
            }
            operations.push(idempotent);
            continue;
          }
          const open = store.quotaOperations.find(
            (item) =>
              item.feishuUserId === input.feishuUserId &&
              item.state !== "completed" &&
              item.state !== "compensated",
          );
          if (open) throw new Error(`用户已有未完成额度操作: ${open.id}`);
          newInputs.push(input);
        }
        for (const departmentId of [...new Set(newInputs.map((item) => item.departmentId))]) {
          for (const period of [
            ...new Set(
              newInputs
                .filter((item) => item.departmentId === departmentId)
                .map((item) => item.billingPeriod),
            ),
          ]) {
            const requested = newInputs
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
                  item.state !== "compensated",
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
        for (const input of newInputs) {
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
          const operation: QuotaOperation = {
            id: randomId("qo"),
            operationType: "monthly_open",
            idempotencyKey: `monthly-open:${input.billingPeriod}:${input.feishuUserId}`,
            feishuUserId: input.feishuUserId,
            departmentId: input.departmentId,
            billingPeriod: input.billingPeriod,
            requestedAssignedQuota: input.assignedMonthlyQuota,
            reservedDepartmentQuota: input.assignedMonthlyQuota,
            operationGeneration: state + 1,
            state: "budget_reserved",
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
  leaseExpiresAt: string;
}) {
  if (isPostgresBackend()) return claimPostgresQuotaOperationExecution(input);
  return mutate((store) => {
    const operation = store.quotaOperations.find((item) => item.id === input.operationId);
    if (!operation) return null;
    if (
      operation.workerLeaseId &&
      operation.workerLeaseId !== input.leaseId &&
      operation.workerLeaseExpiresAt &&
      operation.workerLeaseExpiresAt > nowIso()
    ) {
      return null;
    }
    operation.workerLeaseId = input.leaseId;
    operation.workerLeaseExpiresAt = input.leaseExpiresAt;
    return operation;
  });
}

export async function renewQuotaOperationExecution(input: {
  operationId: string;
  leaseId: string;
  leaseExpiresAt: string;
}) {
  if (isPostgresBackend()) return renewPostgresQuotaOperationExecution(input);
  return mutate((store) => {
    const operation = store.quotaOperations.find((item) => item.id === input.operationId);
    if (!operation || operation.workerLeaseId !== input.leaseId) return null;
    operation.workerLeaseExpiresAt = input.leaseExpiresAt;
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
        state === "completed" || state === "compensated" ? nowIso() : patch.completedAt,
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
  if (!initial.departmentId) throw new Error("额度操作缺少部门，无法预占部门预算");
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
            item.state !== "compensated",
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
          item.state !== "compensated",
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
  const ledgerAuthoritative = Boolean(store.settings.quotaMigration?.appliedAt);
  const now = nowIso();
  const userRows: UserBillingPeriod[] = [];
  const shadowUsers: Array<{
    feishuUserId: string;
    period: string;
    legacyMonthlyQuota: number;
    legacyConsumedQuota: number;
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
        item.matchStatus === "matched",
    );
    const assignedMonthlyQuota = policy?.assignedMonthlyQuota ??
      (ledgerAuthoritative
        ? 0
        : Math.max(
            Math.round(
              (existing?.monthlyQuota ?? store.settings.defaultMonthlyQuota) * quotaPerUnit,
            ),
            0,
          ));
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
      monthlyQuota: ledgerAuthoritative
        ? assignedMonthlyQuota / quotaPerUnit
        : existing?.monthlyQuota ?? assignedMonthlyQuota / quotaPerUnit,
      quotaConsumed: existing?.quotaConsumed ?? authoritativeConsumedQuota / quotaPerUnit,
      cost: existing?.cost ?? authoritativeConsumedQuota / quotaPerUnit,
      remainingQuota: ledgerAuthoritative
        ? materialized.expectedAvailableQuota / quotaPerUnit
        : existing?.remainingQuota ?? materialized.expectedAvailableQuota / quotaPerUnit,
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
    shadowUsers.push({
      feishuUserId,
      period,
      legacyMonthlyQuota: Math.round((existing?.monthlyQuota ?? 0) * quotaPerUnit),
      legacyConsumedQuota: Math.round((existing?.quotaConsumed ?? 0) * quotaPerUnit),
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
    users: shadowUsers,
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
  const period = input.period ?? currentQuotaPeriod();
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

export async function listDepartmentQuotaOverview(scope: AdminScope, period = currentQuotaPeriod()) {
  const firstStore = await readStore();
  const departmentIds =
    scope.scopeType === "global"
      ? [
          ...new Set(
            [
              ...firstStore.users.map((user) => user.departmentId),
              ...firstStore.departmentQuotaPeriods
                .filter((item) => item.period === period)
                .map((item) => item.departmentId),
            ].filter((item): item is string => Boolean(item)),
          ),
        ]
      : scope.departmentId
        ? [scope.departmentId]
        : [];

  for (const departmentId of departmentIds) {
    await ensureDepartmentQuotaPeriod({ departmentId, period });
  }
  const store = await readStore();
  const departments = store.departmentQuotaPeriods
    .filter((item) => item.period === period && departmentIds.includes(item.departmentId))
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

export async function updateDepartmentQuotaPolicy(input: {
  departmentId: string;
  departmentName?: string;
  period?: string;
  quotaLimit?: number;
  defaultGrantQuota?: number;
  operatedByFeishuUserId: string;
}) {
  const period = input.period ?? currentQuotaPeriod();
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

const pendingDepartmentQuotaRequestStatuses = new Set<DepartmentQuotaRequest["status"]>([
  "pending_card_send",
  "pending_card_approval",
  "approval_card_send_failed",
]);

export async function createDepartmentQuotaRequest(input: {
  departmentId: string;
  departmentName?: string;
  period?: string;
  requesterFeishuUserId: string;
  action: DepartmentQuotaRequest["action"];
  reason: string;
  requestedQuotaLimit: number;
  approvalTargetOpenId: string;
  approvalActionNonceHash: string;
}) {
  const period = input.period ?? currentQuotaPeriod();
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
    const limitError = validateDepartmentQuotaLimit(input.requestedQuotaLimit, allocatedQuota);
    if (limitError) throw new Error(limitError);
    if (input.action === "increase" && input.requestedQuotaLimit <= policy.quotaLimit) {
      throw new Error("提高额度申请必须大于当前部门额度上限");
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

export async function decideDepartmentQuotaRequest(input: {
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

export async function getEffectiveUserGrantQuota(feishuUserId: string) {
  const period = currentQuotaPeriod();
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
  const period = currentQuotaPeriod();
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
        item.state !== "compensated",
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
  const period = currentQuotaPeriod();
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
  const period = input.period ?? currentQuotaPeriod();
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

export async function recordMonthlyResetApplied(input: {
  tokenAccountId: string;
  feishuUserId: string;
  period: string;
  monthlyQuota: number;
  operatedByFeishuUserId: string;
  approvalOperatorOpenId: string;
}) {
  if (isPostgresBackend()) {
    const now = nowIso();
    return recordPostgresMonthlyResetApplied({
      ...input,
      now,
      requestId: randomId("tr"),
      approvalUuid: randomId("approval"),
    });
  }

  return mutate((store) => {
    const account = store.tokenAccounts.find(
      (item) =>
        item.id === input.tokenAccountId &&
        item.feishuUserId === input.feishuUserId &&
        item.status === "active",
    );
    if (!account) {
      return {
        applied: false,
        reason: "active_token_not_found",
        account: null,
        request: null,
      };
    }
    if (account.billingPeriod === input.period) {
      return {
        applied: false,
        reason: "already_current_period",
        account,
        request: null,
      };
    }

    const now = nowIso();
    const request: TokenRequest = {
      id: randomId("tr"),
      feishuUserId: input.feishuUserId,
      requestType: "monthly_reset",
      status: "provisioned",
      reason: `monthly billing reset ${input.period}`,
      requestedMonthlyQuota: input.monthlyQuota,
      approvedMonthlyQuota: input.monthlyQuota,
      approvalUuid: randomId("approval"),
      approvalMode: "manual",
      approvalOperatorOpenId: input.approvalOperatorOpenId,
      approvalOperatedAt: now,
      tokenAccountId: account.id,
      createdAt: now,
      updatedAt: now,
    };
    account.billingPeriod = input.period;
    store.tokenRequests.push(request);
    return {
      applied: true,
      reason: "applied",
      account,
      request,
    };
  });
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

export type NewApiUsageBackfillItem = {
  action: "updated" | "matched_no_change" | "skipped_unknown_token" | "skipped_no_match";
  newapiLogId?: string;
  newapiRequestId?: string;
  newapiTokenId?: string;
  proxyLogId?: string;
  feishuUserId?: string;
  tokenAccountId?: string;
  billingPeriod?: string;
  usageRecordId?: string;
  issueId?: string;
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
    billingPeriod: input.proxyLog?.billingPeriod,
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
  return updated;
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
        result.skippedUnknownToken += 1;
        result.items.push({
          action: "skipped_unknown_token",
          newapiLogId: usageLog.newapiLogId,
          newapiRequestId: usageLog.newapiRequestId,
          newapiTokenId: usageLog.newapiTokenId,
          cost: usageLog.cost,
          quota: usageLog.quota,
          reason: "NewAPI token_id is outside the TokenInside account boundary",
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
          message: "No successful one-to-one proxy request matched token, model, stream flag, usage and completion time",
        });
        await persistRecord(record);
        await persistSyncIssue(issue);
        result.skippedNoMatch += 1;
        result.items.push({
          action: "skipped_no_match",
          newapiLogId: usageLog.newapiLogId,
          newapiRequestId: usageLog.newapiRequestId,
          newapiTokenId: usageLog.newapiTokenId,
          feishuUserId: account.feishuUserId,
          tokenAccountId: account.id,
          usageRecordId: record.id,
          issueId: issue.id,
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
      if (usageLog.cost === undefined && usageLog.quota === undefined) {
        const issue = buildUsageSyncIssue({
          issueType: "missing_cost",
          usageLog,
          syncedAt,
          account,
          proxyLog,
          message: "NewAPI log has no quota/cost field, so billing consumption cannot be corrected",
        });
        await persistSyncIssue(issue);
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
        cost: usageLog.cost,
        quota: usageLog.quota,
      });
    }

    if (!dryRun && (result.updated > 0 || result.recordsUpserted > 0) && !persistLog) {
      syncBillingPeriods(store);
    }
    return result;
  };

  if (isPostgresBackend()) {
    const matchingTimes = usageLogs
      .map((item) => item.createdAt && new Date(item.createdAt).getTime())
      .filter((item): item is number => Number.isFinite(item));
    const matchingWindowMs = input.matchWindowMs ?? 30 * 60 * 1000;
    const store = {
      ...structuredClone(initialStore),
      ...(await readPostgresUsageMatchingSnapshot({
        newapiTokenIds: usageLogs
          .map((item) => item.newapiTokenId)
          .filter((item): item is string => Boolean(item)),
        proxyLogIds: input.targetProxyLogIds ?? [],
        proxyCreatedAfter: matchingTimes.length
          ? new Date(Math.min(...matchingTimes) - matchingWindowMs).toISOString()
          : undefined,
        proxyCreatedBefore: matchingTimes.length
          ? new Date(Math.max(...matchingTimes) + matchingWindowMs).toISOString()
          : undefined,
      })),
    };
    return runBackfill(
      store,
      async (proxyLog, patch, syncedAt) => {
        const updated = await updatePostgresProxyLog(proxyLog.id, {
          ...patch,
          usageSyncedAt: syncedAt,
        });
        if (updated) Object.assign(proxyLog, updated);
      },
      upsertPostgresNewApiUsageRecord,
      upsertPostgresUsageSyncIssue,
      async (record, proxyLog, patch, syncedAt) => {
        const settled = await settlePostgresMatchedNewApiUsage({
          record,
          proxyLogId: proxyLog.id,
          patch,
          syncedAt,
        });
        return settled;
      },
    );
  }

  return mutate((store) => runBackfill(store));
}

export async function getAdminScopeForUser(feishuUserId: string) {
  const store = isPostgresBackend() ? undefined : await readStore();
  const user = isPostgresBackend()
    ? await getPostgresUserById(feishuUserId)
    : store!.users.find((item) => item.id === feishuUserId);
  if (!user) return null;
  if (isInactiveUser(user)) return null;

  if (getConfig().admin.systemAdminOpenIds.includes(user.openId)) {
    const now = nowIso();
    return {
      id: `env-admin-${feishuUserId}`,
      feishuUserId,
      scopeType: "global",
      source: "environment",
      role: "root",
      status: "active",
      createdAt: now,
      updatedAt: now,
    } satisfies AdminScope;
  }

  const storedScope = isPostgresBackend()
    ? await getPostgresActiveAdminScopeForUser(feishuUserId)
    : store!.adminScopes.find(
        (scope) => scope.feishuUserId === feishuUserId && scope.status === "active",
      ) ?? null;
  if (storedScope) return storedScope;

  const fallbackStore = store ?? await readStore();
  const assignedRequest = fallbackStore.tokenRequests
    .filter((request) => request.approvalTargetOpenId === user.openId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (assignedRequest?.approvalDepartmentId) {
    const blockedByGlobalRevocation = fallbackStore.adminScopes.some(
      (scope) =>
        scope.feishuUserId === feishuUserId && blocksAllAutomaticAdminRestoreForUser(scope),
    );
    if (blockedByGlobalRevocation) return null;

    const blockedByRevokedScope = fallbackStore.adminScopes.some(
      (scope) =>
        scope.feishuUserId === feishuUserId &&
        scope.scopeType === "department" &&
        scope.departmentId === assignedRequest.approvalDepartmentId &&
        blocksAutomaticAdminRestore(scope),
    );
    if (blockedByRevokedScope) return null;

    const now = nowIso();
    return {
      id: `assigned-admin-${feishuUserId}`,
      feishuUserId,
      scopeType: "department",
      departmentId: assignedRequest.approvalDepartmentId,
      source: "department_supervisor",
      status: "active",
      createdAt: now,
      updatedAt: now,
    } satisfies AdminScope;
  }
  return null;
}

export async function listAdminScopes() {
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

  return mutate((store) => {
    const targetUser = store.users.find((user) => user.openId === input.targetOpenId);
    if (!targetUser) {
      return {
        scope: null,
        error: "target_user_not_found" as const,
      };
    }

    const now = nowIso();
    if (isInactiveUser(targetUser)) {
      targetUser.status = "active";
      targetUser.disabledAt = undefined;
      targetUser.disabledReason = undefined;
      targetUser.deletedAt = undefined;
      targetUser.deletedReason = undefined;
      targetUser.updatedAt = now;
    }
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
  });
}

export async function updateManualAdminScope(input: {
  scopeId: string;
  status?: AdminScope["status"];
  departmentId?: string;
  disabledReason?: AdminScope["disabledReason"];
  disabledByFeishuUserId?: string;
}) {
  if (isPostgresBackend()) return updatePostgresManualAdminScope(input);

  return mutate((store) => {
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
  });
}

export async function getAdminScopeById(scopeId: string) {
  const store = await readStore();
  return store.adminScopes.find((item) => item.id === scopeId) ?? null;
}

export async function syncDepartmentSupervisorAdminScope(input: {
  feishuUserId: string;
  departmentId: string;
  isSupervisor: boolean;
}) {
  if (isPostgresBackend()) return syncPostgresDepartmentSupervisorAdminScope(input);

  return mutate((store) => {
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
  });
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

export async function updateUserAccessStatus(input: {
  feishuUserId: string;
  status: "disabled" | "deleted";
  reason?: string;
  tokenStatus: Extract<TokenStatus, "disabled" | "revoked">;
  adminRevokedByFeishuUserId?: string;
}) {
  if (isPostgresBackend()) return updatePostgresUserAccessStatus(input);

  return mutate((store) => {
    const now = nowIso();
    const user = store.users.find((item) => item.id === input.feishuUserId);
    if (!user) return null;

    const activeAccount =
      store.tokenAccounts.find(
        (account) => account.feishuUserId === input.feishuUserId && account.status === "active",
      ) ?? null;
    if (activeAccount) {
      activeAccount.status = input.tokenStatus;
      activeAccount.disabledAt = now;
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

    return { user, tokenAccount: activeAccount };
  });
}

export async function revokeAdminScopesForUser(input: {
  feishuUserId: string;
  reason: NonNullable<AdminScope["disabledReason"]>;
  disabledByFeishuUserId?: string;
}) {
  if (isPostgresBackend()) return revokePostgresAdminScopesForUser(input);

  return mutate((store) =>
    revokeAdminScopesForUserInStore(store, {
      ...input,
      now: nowIso(),
    }),
  );
}

export async function enableUserAccess(input: {
  feishuUserId: string;
  reason?: string;
}) {
  if (isPostgresBackend()) return enablePostgresUserAccess(input);

  return mutate((store) => {
    const now = nowIso();
    const user = store.users.find((item) => item.id === input.feishuUserId);
    if (!user || user.status !== "disabled") return null;

    const disabledAccount =
      [...store.tokenAccounts]
        .filter(
          (account) =>
            account.feishuUserId === input.feishuUserId && account.status === "disabled",
        )
        .sort((a, b) =>
          (b.disabledAt ?? b.createdAt).localeCompare(a.disabledAt ?? a.createdAt),
        )[0] ?? null;
    if (!disabledAccount) return null;

    disabledAccount.status = "active";
    disabledAccount.disabledAt = undefined;

    user.status = "active";
    user.updatedAt = now;
    user.disabledAt = undefined;
    user.disabledReason = undefined;

    return { user, tokenAccount: disabledAccount };
  });
}

export async function listAdminUsers(scope: AdminScope) {
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
  const store = await readStore();
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
  const currentPeriod = nowIso().slice(0, 7);
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
  const store = await readStore();
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
  };
}

export async function listDepartmentStats(scope: AdminScope) {
  if (scope.scopeType !== "global") return null;

  const store = await readStore();
  const currentPeriod = nowIso().slice(0, 7);
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
  const limit = boundedLimit(input.limit, 50);
  const offset = boundedOffset(input.offset);

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
