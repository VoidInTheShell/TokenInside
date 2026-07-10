import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/config";
import { nowIso, randomId } from "@/lib/crypto";
import type { NormalizedNewApiUsageLog } from "@/lib/newapi";
import {
  enablePostgresUserAccess,
  findPostgresActiveTokenByHash,
  getPostgresDisabledTokenForUser,
  getPostgresActiveTokenForUser,
  getPostgresAppSettings,
  getPostgresFeishuEventByUuid,
  insertPostgresProxyLog,
  insertPostgresTokenAccount,
  insertPostgresTokenRequest,
  invalidatePostgresOpenFirstApplyRequests,
  mutatePostgresAppSettings,
  recordPostgresMonthlyResetApplied,
  replacePostgresActiveTokenAccount,
  readPostgresStore,
  revokePostgresAdminScopesForUser,
  syncPostgresDepartmentSupervisorAdminScope,
  transitionPostgresTokenRequest,
  updatePostgresManualAdminScope,
  updatePostgresProxyLog,
  updatePostgresTokenRequest,
  updatePostgresUserAccessStatus,
  upsertPostgresFeishuEvent,
  upsertPostgresFeishuUser,
  upsertPostgresNewApiUsageRecord,
  upsertPostgresUsageSyncCheckpoint,
  upsertPostgresUsageSyncIssue,
  upsertPostgresManualAdminScope,
} from "@/lib/postgres-store";
import type {
  AdminScope,
  BillingOperationKind,
  BillingOperationRecord,
  BillingOperationStatus,
  FeishuEvent,
  FeishuUser,
  NewApiUsageMatchStatus,
  NewApiUsageRecord,
  ProxyRequestLog,
  RequestStatus,
  StoreShape,
  TokenAccount,
  TokenStatus,
  TokenRequest,
  UsageSyncCheckpoint,
  UsageSyncIssue,
  UsageSyncIssueType,
  UsageSyncPolicy,
  UserBillingPeriod,
} from "@/lib/types";

export function defaultUsageSyncPolicy(): UsageSyncPolicy {
  return {
    enabled: true,
    intervalMinutes: 60,
    pageSize: 100,
    maxPagesPerRun: 3,
    overlapMinutes: 120,
    matchWindowMinutes: 30,
  };
}

const initialStore: StoreShape = {
  version: 1,
  settings: {
    defaultMonthlyQuota: 200,
    usageSyncPolicy: defaultUsageSyncPolicy(),
    billingOperations: [],
  },
  users: [],
  tokenRequests: [],
  tokenAccounts: [],
  userBillingPeriods: [],
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
  const legacyImplicitDisabled =
    policy?.enabled === false && !policy.updatedAt && !policy.updatedByFeishuUserId;
  return {
    ...defaults,
    ...policy,
    enabled: legacyImplicitDisabled ? true : policy?.enabled ?? defaults.enabled,
    intervalMinutes: Math.min(Math.max(Math.trunc(policy?.intervalMinutes ?? defaults.intervalMinutes), 1), 24 * 60),
    pageSize: Math.min(Math.max(Math.trunc(policy?.pageSize ?? defaults.pageSize), 1), 100),
    maxPagesPerRun: Math.min(Math.max(Math.trunc(policy?.maxPagesPerRun ?? defaults.maxPagesPerRun), 1), 20),
    overlapMinutes: Math.min(Math.max(Math.trunc(policy?.overlapMinutes ?? defaults.overlapMinutes), 0), 7 * 24 * 60),
    matchWindowMinutes: Math.min(Math.max(Math.trunc(policy?.matchWindowMinutes ?? defaults.matchWindowMinutes), 1), 24 * 60),
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
  return periodFromIso(record.newapiCreatedAt ?? record.lastSyncedAt ?? record.firstSeenAt);
}

function syncBillingPeriods(store: StoreShape) {
  let changed = false;
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
        monthlyQuota: existing?.monthlyQuota ?? initialStore.settings.defaultMonthlyQuota,
        quotaConsumed: 0,
        cost: 0,
        remainingQuota: existing?.monthlyQuota ?? initialStore.settings.defaultMonthlyQuota,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        proxyLogCount: 0,
        usageRecordCount: 0,
        activeTokenAccountId: undefined,
        tokenAccountIds: [],
        updatedAt: existing?.updatedAt ?? nowIso(),
        quotaUpdatedAt: undefined,
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
    if (request) {
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
      (request.requestType !== "quota_reset" &&
        request.requestType !== "quota_adjust" &&
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
    if (record.matchedProxyLogId) {
      proxyLogIdsBackedByNewApiRecords.add(record.matchedProxyLogId);
    }
    if (!record.feishuUserId) continue;
    if (record.matchStatus === "unknown_token" || record.matchStatus === "malformed_log") continue;
    const quotaConsumed = usageRecordQuotaConsumed(record);
    const period = usageRecordPeriod(record);
    const summary = ensure(record.feishuUserId, period);
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
    const period = periodFromIso(log.createdAt);
    const summary = ensure(log.feishuUserId, period);
    summary.promptTokens += log.promptTokens ?? 0;
    summary.completionTokens += log.completionTokens ?? 0;
    summary.totalTokens += log.totalTokens ?? 0;
    summary.proxyLogCount += 1;
    if (!proxyLogIdsBackedByNewApiRecords.has(log.id)) {
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
      billingOperations: settings.billingOperations ?? [],
    };
  }
  const store = await readStore();
  return store.settings;
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
      store.settings = {
        ...store.settings,
        defaultMonthlyQuota: nextDefaultMonthlyQuota,
        usageSyncPolicy: nextUsageSyncPolicy,
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
        },
        summary: {
          previousDefaultMonthlyQuota,
          defaultMonthlyQuota: nextDefaultMonthlyQuota,
          usageSyncPolicyUpdated: Boolean(input.usageSyncPolicy),
        },
      });
      Object.assign(settings, store.settings);
      return store.settings;
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
      usageSyncPolicy: nextUsageSyncPolicy,
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
      },
      summary: {
        previousDefaultMonthlyQuota,
        defaultMonthlyQuota: nextDefaultMonthlyQuota,
        usageSyncPolicyUpdated: Boolean(input.usageSyncPolicy),
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
  const store = await readStore();
  return (
    store.userBillingPeriods.find(
      (item) => item.feishuUserId === feishuUserId && item.period === period,
    ) ?? null
  );
}

export async function findActiveTokenByHash(keyHash: string) {
  if (isPostgresBackend()) return findPostgresActiveTokenByHash(keyHash);

  const store = await readStore();
  return (
    store.tokenAccounts.find(
      (account) => account.keyHash === keyHash && account.status === "active",
    ) ?? null
  );
}

export async function addTokenAccount(input: {
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
    return insertPostgresTokenAccount(account);
  }

  return mutate((store) => {
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
    store.tokenAccounts.push(account);
    return account;
  });
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

function proxyLogIsStream(log: ProxyRequestLog) {
  return Boolean(log.isStream || log.upstreamIsStream || log.clientRequestedStream || log.clientIsStream);
}

function usageLogTime(log: NormalizedNewApiUsageLog) {
  if (!log.createdAt) return undefined;
  const time = new Date(log.createdAt).getTime();
  return Number.isFinite(time) ? time : undefined;
}

function proxyLogTime(log: ProxyRequestLog) {
  const time = new Date(log.createdAt).getTime();
  return Number.isFinite(time) ? time : undefined;
}

function buildUsagePatch(
  usageLog: NormalizedNewApiUsageLog,
  currentLog: ProxyRequestLog,
) {
  const patch: Partial<Omit<ProxyRequestLog, "id" | "createdAt">> = {
    usageSource: "newapi_log",
  };

  if (usageLog.newapiLogId) patch.newapiLogId = usageLog.newapiLogId;
  if (usageLog.newapiRequestId) patch.newapiRequestId = usageLog.newapiRequestId;
  if (usageLog.providerChannelName) patch.providerChannelName = usageLog.providerChannelName;
  if (usageLog.newapiUseTimeSeconds !== undefined) {
    patch.newapiUseTimeSeconds = usageLog.newapiUseTimeSeconds;
  }
  if (usageLog.quota !== undefined) patch.quota = usageLog.quota;
  if (usageLog.cost !== undefined) patch.cost = usageLog.cost;
  if (usageLog.promptTokens !== undefined) patch.promptTokens = usageLog.promptTokens;
  if (usageLog.completionTokens !== undefined) patch.completionTokens = usageLog.completionTokens;
  if (usageLog.totalTokens !== undefined) patch.totalTokens = usageLog.totalTokens;
  if (usageLog.isStream !== undefined) {
    patch.isStream = usageLog.isStream;
    patch.upstreamIsStream = usageLog.isStream;
  }
  if (usageLog.model && isUnknownModel(currentLog.model)) {
    patch.model = usageLog.model;
  }
  if (
    (currentLog.status === "pending" || currentLog.status === "streaming") &&
    currentLog.statusCode < 400
  ) {
    patch.status = "completed";
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

function findProxyLogForNewApiUsage(input: {
  store: StoreShape;
  usageLog: NormalizedNewApiUsageLog;
  account: TokenAccount;
  matchWindowMs: number;
}) {
  const { store, usageLog, account, matchWindowMs } = input;
  const existingByLogId =
    usageLog.newapiLogId &&
    store.proxyRequestLogs.find((log) => log.newapiLogId === usageLog.newapiLogId);
  if (existingByLogId) return existingByLogId;

  const existingByRequestId =
    usageLog.newapiRequestId &&
    store.proxyRequestLogs.find((log) => log.newapiRequestId === usageLog.newapiRequestId);
  if (existingByRequestId) return existingByRequestId;

  const targetTime = usageLogTime(usageLog);
  const candidates = store.proxyRequestLogs
    .map((log) => {
      const logTime = proxyLogTime(log);
      const timeDelta =
        targetTime !== undefined && logTime !== undefined
          ? Math.abs(targetTime - logTime)
          : Number.POSITIVE_INFINITY;
      return { log, timeDelta };
    })
    .filter(({ log, timeDelta }) => {
      if (usageLog.newapiLogId && log.newapiLogId && log.newapiLogId !== usageLog.newapiLogId) {
        return false;
      }
      if (usageLog.newapiRequestId && log.newapiRequestId && log.newapiRequestId !== usageLog.newapiRequestId) {
        return false;
      }
      if (log.feishuUserId && log.feishuUserId !== account.feishuUserId) return false;
      const tokenMatches =
        log.tokenAccountId === account.id ||
        (usageLog.newapiTokenId !== undefined && log.providerKeyName === usageLog.newapiTokenId);
      if (!tokenMatches) return false;
      if (usageLog.model && !isUnknownModel(log.model) && log.model !== usageLog.model) return false;
      if (usageLog.isStream !== undefined && proxyLogIsStream(log) !== usageLog.isStream) return false;
      if (targetTime !== undefined && !Number.isFinite(timeDelta)) return false;
      if (targetTime !== undefined && timeDelta > matchWindowMs) return false;
      return true;
    })
    .sort((left, right) => {
      const leftHasUsage = left.log.totalTokens !== undefined || left.log.usageSource === "newapi_log";
      const rightHasUsage = right.log.totalTokens !== undefined || right.log.usageSource === "newapi_log";
      if (leftHasUsage !== rightHasUsage) return leftHasUsage ? 1 : -1;
      if (left.log.newapiLogId !== right.log.newapiLogId) return left.log.newapiLogId ? 1 : -1;
      return left.timeDelta - right.timeDelta;
    });

  return candidates[0]?.log;
}

function stableUsageIdentity(usageLog: NormalizedNewApiUsageLog) {
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

function stableRecordId(prefix: string, identity: string) {
  return `${prefix}_${identity.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 180) || randomId(prefix)}`;
}

function usageRecordIdFromLog(usageLog: NormalizedNewApiUsageLog) {
  return stableRecordId("nur", stableUsageIdentity(usageLog));
}

function usageIssueIdFromLog(type: UsageSyncIssueType, usageLog: NormalizedNewApiUsageLog) {
  return stableRecordId(`usi_${type}`, stableUsageIdentity(usageLog));
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
    newapiTokenId: input.usageLog.newapiTokenId,
    tokenAccountId: input.proxyLog?.tokenAccountId ?? input.account?.id,
    feishuUserId: input.proxyLog?.feishuUserId ?? input.account?.feishuUserId,
    departmentId: input.proxyLog?.departmentId ?? user?.departmentId,
    departmentName: input.proxyLog?.departmentName ?? user?.departmentName,
    matchedProxyLogId: input.proxyLog?.id,
    matchStatus: input.matchStatus,
    model: input.usageLog.model,
    promptTokens: input.usageLog.promptTokens,
    completionTokens: input.usageLog.completionTokens,
    totalTokens: input.usageLog.totalTokens,
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
  if (right.newapiLogId && left.newapiLogId === right.newapiLogId) return true;
  if (right.newapiRequestId && left.newapiRequestId === right.newapiRequestId) return true;
  return left.id === right.id;
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
  const index = store.usageSyncIssues.findIndex((item) => {
    if (item.issueType !== issue.issueType) return false;
    if (issue.newapiLogId && item.newapiLogId === issue.newapiLogId) return true;
    if (issue.newapiRequestId && item.newapiRequestId === issue.newapiRequestId) return true;
    return item.id === issue.id;
  });
  if (index === -1) {
    store.usageSyncIssues.push(issue);
    return issue;
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
    status: "open",
  };
  store.usageSyncIssues[index] = updated;
  return updated;
}

export async function backfillProxyLogsFromNewApiUsage(
  usageLogs: NormalizedNewApiUsageLog[],
  input: {
    dryRun?: boolean;
    matchWindowMs?: number;
  } = {},
): Promise<NewApiUsageBackfillResult> {
  const dryRun = input.dryRun ?? true;
  const matchWindowMs = input.matchWindowMs ?? 30 * 60 * 1000;

  const runBackfill = async (
    store: StoreShape,
    persistLog?: (
      proxyLog: ProxyRequestLog,
      patch: Partial<Omit<ProxyRequestLog, "id" | "createdAt">>,
      syncedAt: string,
    ) => Promise<void>,
    persistUsageRecord?: (record: NewApiUsageRecord) => Promise<NewApiUsageRecord>,
    persistIssue?: (issue: UsageSyncIssue) => Promise<UsageSyncIssue>,
  ) => {
    const syncedAt = nowIso();
    const accountByNewApiTokenId = new Map(
      store.tokenAccounts
        .filter((account) => account.newapiTokenId)
        .map((account) => [account.newapiTokenId as string, account] as const),
    );
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
          message: "NewAPI token_id is not bound to a TokenInside token account",
        });
        await persistRecord(record);
        await persistSyncIssue(issue);
        result.skippedUnknownToken += 1;
        result.items.push({
          action: "skipped_unknown_token",
          newapiLogId: usageLog.newapiLogId,
          newapiRequestId: usageLog.newapiRequestId,
          newapiTokenId: usageLog.newapiTokenId,
          usageRecordId: record.id,
          issueId: issue.id,
          cost: usageLog.cost,
          quota: usageLog.quota,
          reason: "NewAPI token_id is not bound to a TokenInside token account",
        });
        continue;
      }

      const proxyLog = findProxyLogForNewApiUsage({
        store,
        usageLog,
        account,
        matchWindowMs,
      });
      if (!proxyLog) {
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
          message: "No proxy request log matched token, model, stream flag and time window",
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
          reason: "No proxy request log matched token, model, stream flag and time window",
        });
        continue;
      }

      result.matched += 1;
      const record = buildNewApiUsageRecord({
        store,
        usageLog,
        matchStatus: "matched",
        syncedAt,
        account,
        proxyLog,
      });
      await persistRecord(record);
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
      const patch = buildUsagePatch(usageLog, proxyLog);
      const changed = patchChangesLog(proxyLog, patch);
      if (changed) {
        result.updated += 1;
        if (!dryRun) {
          if (persistLog) {
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
        usageRecordId: record.id,
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
    const store = await readPostgresStore();
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
    );
  }

  return mutate((store) => runBackfill(store));
}

export async function getAdminScopeForUser(feishuUserId: string) {
  const store = await readStore();
  const user = store.users.find((item) => item.id === feishuUserId);
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

  const storedScope =
    store.adminScopes.find(
      (scope) => scope.feishuUserId === feishuUserId && scope.status === "active",
    ) ?? null;
  if (storedScope) return storedScope;

  const assignedRequest = store.tokenRequests
    .filter((request) => request.approvalTargetOpenId === user.openId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (assignedRequest?.approvalDepartmentId) {
    const blockedByGlobalRevocation = store.adminScopes.some(
      (scope) =>
        scope.feishuUserId === feishuUserId && blocksAllAutomaticAdminRestoreForUser(scope),
    );
    if (blockedByGlobalRevocation) return null;

    const blockedByRevokedScope = store.adminScopes.some(
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

function tokenRequestInScope(
  request: TokenRequest,
  scope: AdminScope,
  usersById: Map<string, FeishuUser>,
) {
  if (scope.scopeType === "global") return true;
  const adminUser = usersById.get(scope.feishuUserId);
  if (request.approvalTargetOpenId) {
    return request.approvalTargetOpenId === adminUser?.openId;
  }
  const user = usersById.get(request.feishuUserId);
  return Boolean(user?.departmentId && user.departmentId === scope.departmentId);
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
  const store = await readStore();
  const request = store.tokenRequests.find((item) => item.id === requestId);
  if (!request) return null;
  const usersById = new Map(store.users.map((user) => [user.id, user]));
  return tokenRequestInScope(request, scope, usersById) ? request : null;
}

export async function getScopedUser(scope: AdminScope, feishuUserId: string) {
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
    cacheReadTokens: log.cacheReadTokens,
    cacheCreationTokens: log.cacheCreationTokens,
    quota: log.usageSource === "newapi_log" ? log.quota : undefined,
    cost: log.usageSource === "newapi_log" ? log.cost : undefined,
    actualCost: log.actualCost,
    usageSource: log.usageSource,
    usageSyncedAt: log.usageSyncedAt,
    newapiLogId: log.newapiLogId,
    newapiRequestId: log.newapiRequestId,
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

function usageCacheHitRate(inputTokens: number, cacheReadTokens: number, cacheCreationTokens: number) {
  const totalInputContext = inputTokens + cacheReadTokens + cacheCreationTokens;
  return totalInputContext > 0 ? cacheReadTokens / totalInputContext : 0;
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
    row.cacheReadTokens += log.cacheReadTokens ?? 0;
    row.cacheCreationTokens += log.cacheCreationTokens ?? 0;
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
      cost: row.cost,
      actualCost: row.actualCost,
      successRate: row.requestCount > 0 ? row.successCount / row.requestCount : 0,
      avgDurationMs: row.durationCount > 0 ? row.durationTotalMs / row.durationCount : 0,
      cacheHitRate: usageCacheHitRate(
        row.promptTokens,
        row.cacheReadTokens,
        row.cacheCreationTokens,
      ),
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
  const scopedLogs = store.proxyRequestLogs.filter((log) =>
    proxyLogInScope(log, input.scope, usersById),
  );
  const dateScopedLogs = scopedLogs.filter((log) => matchesDateRange(log, input));
  const filteredLogs = filterUsageLogs(scopedLogs, usersById, input).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const limit = boundedLimit(input.limit, 100);
  const offset = boundedOffset(input.offset);
  const pageLogs = filteredLogs.slice(offset, offset + limit);
  const userIdsWithLogs = new Set(dateScopedLogs.map((log) => log.feishuUserId).filter(Boolean));

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
    departmentStats: aggregateUsage(filteredLogs, usersById, (log, user) => {
      const id = logDepartmentId(log, user) ?? "unknown";
      const name = logDepartmentName(log, user) ?? departmentNameForId(store, id);
      return {
        key: id,
        label: name ?? id,
      };
    }),
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
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, bounded)
    .map((log) => mapUsageRecord(log, usersById));
}

export async function listUserUsageReport(input: UsageRecordFilters & {
  feishuUserId: string;
}) {
  const store = await readStore();
  const usersById = new Map(store.users.map((user) => [user.id, user]));
  const scopedLogs = store.proxyRequestLogs.filter((log) => log.feishuUserId === input.feishuUserId);
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
}) {
  const store = await readStore();
  const usersById = new Map(store.users.map((user) => [user.id, user]));
  const scopedRequests = store.tokenRequests
    .filter((request) => tokenRequestInScope(request, input.scope, usersById))
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
  const scopedUsers =
    scope.scopeType === "global"
      ? store.users
      : store.users.filter((user) => user.departmentId === scope.departmentId);
  const scopedRequests = store.tokenRequests.filter((request) =>
    tokenRequestInScope(request, scope, usersById),
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
