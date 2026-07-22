import {
  fromNewApiQuota,
  getNewApiTokenControlState,
  listNewApiUsageLogs,
  type NormalizedNewApiUsageLog,
} from "@/lib/newapi";
import {
  newApiLogHttpStatus,
  reliableNewApiFirstByteMs,
} from "@/lib/newapi-log-timing";
import {
  queryAdminDirectory,
  type AdminDirectoryQuery,
  type AdminUserSortKey,
} from "@/lib/admin-directory-query";
import { packageWindow } from "@/lib/package-reset";
import {
  getAppSettings,
  getNewApiReportingBindings,
  listAdminUsers,
  listDepartmentQuotaOverview,
} from "@/lib/store";
import type {
  AdminScope,
  FeishuUser,
  ProxyRequestLog,
  TokenAccount,
  UserQuotaPolicy,
} from "@/lib/types";
import { normalizedInputTokensTotal } from "@/lib/usage-metrics";

const NEWAPI_LOG_PAGE_SIZE = 100;
const NEWAPI_LOG_MAX_PAGES = 100;
const REPORTING_CACHE_MS = 5_000;
const TOKEN_STATE_CONCURRENCY = 8;

export type NewApiUsageRecordFilters = {
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

export type { AdminDirectoryQuery, AdminUserSortKey } from "@/lib/admin-directory-query";

type ReportingBindings = Awaited<ReturnType<typeof getNewApiReportingBindings>>;

type CachedLogPage = {
  expiresAt: number;
  promise: Promise<{
    items: NormalizedNewApiUsageLog[];
    truncated: boolean;
    upstreamTotal: number;
  }>;
};

type TokenControlSnapshot = {
  status?: number;
  remainingQuota?: number;
};

type CachedTokenState = {
  expiresAt: number;
  promise: Promise<TokenControlSnapshot>;
};

type ReportingRuntime = {
  logPages: Map<string, CachedLogPage>;
  tokenStates: Map<string, CachedTokenState>;
};

type ReportingGlobal = typeof globalThis & {
  __tokenInsideNewApiReportingV1?: ReportingRuntime;
};

const reportingGlobal = globalThis as ReportingGlobal;
const reportingRuntime =
  (reportingGlobal.__tokenInsideNewApiReportingV1 ??= {
    logPages: new Map(),
    tokenStates: new Map(),
  });

function boundedLimit(value: number | undefined, fallback: number) {
  return Math.min(Math.max(value ?? fallback, 1), 500);
}

function boundedOffset(value: number | undefined) {
  return Math.max(value ?? 0, 0);
}

function normalizeFilter(value?: string) {
  if (!value || value === "__all__") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function uniqueSorted(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())))].sort(
    (a, b) => a.localeCompare(b, "zh-CN"),
  );
}

function dateBoundary(value: string | undefined, endOfDay: boolean) {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(
      `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`,
    ).getTime();
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

function usageDateRange(filters: NewApiUsageRecordFilters) {
  const preset = presetDateRange(filters.preset);
  return {
    start: dateBoundary(filters.startDate, false) ?? preset.start,
    end: dateBoundary(filters.endDate, true) ?? preset.end,
  };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(concurrency, 1), values.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= values.length) return;
        results[index] = await fn(values[index]);
      }
    }),
  );
  return results;
}

async function fetchLogType(input: {
  logType: 2 | 5;
  startTimestamp?: number;
  endTimestamp?: number;
}) {
  const first = await listNewApiUsageLogs({
    page: 0,
    size: NEWAPI_LOG_PAGE_SIZE,
    logType: input.logType,
    startTimestamp: input.startTimestamp,
    endTimestamp: input.endTimestamp,
  });
  const visibleTotal = Math.max(first.total, first.items.length);
  const requestedPages = Math.max(Math.ceil(visibleTotal / NEWAPI_LOG_PAGE_SIZE), 1);
  const pageCount = Math.min(requestedPages, NEWAPI_LOG_MAX_PAGES);
  const remainingPages = Array.from({ length: Math.max(pageCount - 1, 0) }, (_, index) => index + 1);
  const remaining = await mapWithConcurrency(remainingPages, 4, (page) =>
    listNewApiUsageLogs({
      page,
      size: NEWAPI_LOG_PAGE_SIZE,
      logType: input.logType,
      startTimestamp: input.startTimestamp,
      endTimestamp: input.endTimestamp,
    }),
  );
  return {
    items: [first, ...remaining].flatMap((page) => page.items),
    total: visibleTotal,
    truncated:
      requestedPages > NEWAPI_LOG_MAX_PAGES ||
      visibleTotal >= NEWAPI_LOG_PAGE_SIZE * NEWAPI_LOG_MAX_PAGES,
  };
}

function logCacheKey(startTimestamp?: number, endTimestamp?: number) {
  return `${startTimestamp ?? "all"}:${endTimestamp ?? "all"}`;
}

async function loadAuthoritativeLogs(input: {
  startAtMs?: number;
  endAtMs?: number;
  forceRefresh?: boolean;
}) {
  const startTimestamp =
    input.startAtMs === undefined ? undefined : Math.floor(input.startAtMs / 1000);
  const endTimestamp =
    input.endAtMs === undefined ? undefined : Math.ceil(input.endAtMs / 1000);
  const key = logCacheKey(startTimestamp, endTimestamp);
  const now = Date.now();
  const cached = reportingRuntime.logPages.get(key);
  if (!input.forceRefresh && cached && cached.expiresAt > now) return cached.promise;

  const promise = Promise.all([
    fetchLogType({ logType: 2, startTimestamp, endTimestamp }),
    fetchLogType({ logType: 5, startTimestamp, endTimestamp }),
  ]).then(([consume, error]) => {
    const deduped = new Map<string, NormalizedNewApiUsageLog>();
    for (const item of [...consume.items, ...error.items]) {
      const identity = [
        item.type,
        item.newapiLogId ?? item.newapiRequestId ?? item.newapiUpstreamRequestId,
        item.newapiTokenId,
        item.createdAt,
      ].join(":");
      deduped.set(identity, item);
    }
    return {
      items: [...deduped.values()].sort((a, b) =>
        (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
      ),
      truncated: consume.truncated || error.truncated,
      upstreamTotal: consume.total + error.total,
    };
  });
  reportingRuntime.logPages.set(key, {
    expiresAt: now + REPORTING_CACHE_MS,
    promise,
  });
  try {
    return await promise;
  } catch (error) {
    if (reportingRuntime.logPages.get(key)?.promise === promise) {
      reportingRuntime.logPages.delete(key);
    }
    throw error;
  }
}

function tokenState(newapiTokenId: string) {
  const now = Date.now();
  const cached = reportingRuntime.tokenStates.get(newapiTokenId);
  if (cached && cached.expiresAt > now) return cached.promise;
  const promise = getNewApiTokenControlState(newapiTokenId).then((state) => ({
    status: state.status,
    remainingQuota:
      state.remainQuota === undefined ? undefined : fromNewApiQuota(state.remainQuota),
  }));
  reportingRuntime.tokenStates.set(newapiTokenId, {
    expiresAt: now + REPORTING_CACHE_MS,
    promise,
  });
  promise.catch(() => {
    if (reportingRuntime.tokenStates.get(newapiTokenId)?.promise === promise) {
      reportingRuntime.tokenStates.delete(newapiTokenId);
    }
  });
  return promise;
}

async function activeTokenStates(bindings: ReportingBindings) {
  const activeAccounts = bindings.tokenAccounts.filter(
    (account) => account.status === "active" && account.newapiTokenId,
  );
  const states = await mapWithConcurrency(
    activeAccounts,
    TOKEN_STATE_CONCURRENCY,
    async (account) => [account.feishuUserId, await tokenState(account.newapiTokenId!)] as const,
  );
  return new Map(states);
}

function apiFormatFromPath(path?: string) {
  const normalized = path?.split("?")[0].replace(/\/+$/, "");
  switch (normalized) {
    case "/v1/chat/completions":
      return "openai:chat/completions";
    case "/v1/responses":
      return "openai:responses";
    case "/v1/messages":
      return "claude:messages";
    default:
      return normalized ? `newapi:${normalized.replace(/^\/+/, "")}` : "newapi:unknown";
  }
}

function mapAuthoritativeLogs(
  source: NormalizedNewApiUsageLog[],
  bindings: ReportingBindings,
) {
  const usersById = new Map(bindings.users.map((user) => [user.id, user]));
  const accountByNewApiTokenId = new Map<string, TokenAccount>();
  for (const account of bindings.tokenAccounts) {
    if (!account.newapiTokenId) continue;
    const existing = accountByNewApiTokenId.get(account.newapiTokenId);
    if (!existing || account.createdAt.localeCompare(existing.createdAt) > 0) {
      accountByNewApiTokenId.set(account.newapiTokenId, account);
    }
  }

  const mapped: ProxyRequestLog[] = [];
  for (const log of source) {
    const account = log.newapiTokenId
      ? accountByNewApiTokenId.get(log.newapiTokenId)
      : undefined;
    const user = account ? usersById.get(account.feishuUserId) : undefined;
    if (!account || !user || !log.createdAt) continue;
    const failed = log.type === "5";
    const statusCode = newApiLogHttpStatus({
      logType: log.type,
      statusCode: log.statusCode,
    });
    const durationMs = Math.max(Math.round((log.newapiUseTimeSeconds ?? 0) * 1000), 0);
    const requestPath = log.requestPath ?? "/v1/unknown";
    const apiFormat = apiFormatFromPath(requestPath);
    mapped.push({
      id: `newapi:${log.newapiLogId ?? log.newapiRequestId ?? `${account.id}:${log.createdAt}`}`,
      feishuUserId: user.id,
      tokenAccountId: account.id,
      departmentId: user.departmentId,
      departmentName: user.departmentName,
      requestPath,
      method: "POST",
      status: failed ? "failed" : "completed",
      statusCode,
      upstreamStatusCode: statusCode,
      durationMs,
      firstByteMs: reliableNewApiFirstByteMs({
        isStream: log.isStream,
        firstResponseTimeMs: log.firstResponseTimeMs,
        durationMs,
      }),
      model: log.model,
      provider: "NewAPI",
      providerKeyName: log.tokenName ?? log.newapiTokenId,
      apiFormat,
      endpointApiFormat: apiFormat,
      requestType: log.isStream ? "stream" : "standard",
      isStream: log.isStream,
      upstreamIsStream: log.isStream,
      clientRequestedStream: log.isStream,
      clientIsStream: log.isStream,
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
      quota: log.quota,
      cost: log.cost,
      actualCost: log.actualCost,
      usageSource: "newapi_log",
      newapiLogId: log.newapiLogId,
      newapiRequestId: log.newapiRequestId,
      newapiUpstreamRequestId: log.newapiUpstreamRequestId,
      providerChannelName: log.providerChannelName,
      newapiUseTimeSeconds: log.newapiUseTimeSeconds,
      errorMessage: log.errorMessage,
      clientIp: log.clientIp,
      createdAt: log.createdAt,
    });
  }
  return mapped;
}

function logDisplayStatus(log: ProxyRequestLog) {
  if (log.status) return log.status;
  return log.statusCode >= 400 ? "failed" : "completed";
}

function logIsStream(log: ProxyRequestLog) {
  return Boolean(
    log.isStream ||
      log.upstreamIsStream ||
      log.clientRequestedStream ||
      log.clientIsStream,
  );
}

function usageRecordView(log: ProxyRequestLog, usersById: Map<string, FeishuUser>) {
  const user = log.feishuUserId ? usersById.get(log.feishuUserId) : undefined;
  return {
    id: log.id,
    feishuUserId: log.feishuUserId,
    tokenAccountId: log.tokenAccountId,
    userName: user?.name,
    userOpenId: user?.openId,
    departmentId: log.departmentId ?? user?.departmentId,
    departmentName: log.departmentName ?? user?.departmentName,
    requestPath: log.requestPath,
    method: log.method,
    status: logDisplayStatus(log),
    rawStatus: log.status,
    statusCode: log.statusCode,
    durationMs: log.durationMs,
    firstByteMs: log.firstByteMs,
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
    quota: log.quota,
    cost: log.cost,
    actualCost: log.actualCost,
    usageSource: log.usageSource,
    newapiLogId: log.newapiLogId,
    newapiRequestId: log.newapiRequestId,
    newapiUpstreamRequestId: log.newapiUpstreamRequestId,
    providerChannelName: log.providerChannelName,
    newapiUseTimeSeconds: log.newapiUseTimeSeconds,
    errorMessage: log.errorMessage,
    clientIp: log.clientIp,
    createdAt: log.createdAt,
  };
}

function isUnknownUsageValue(value?: string) {
  const normalized = value?.trim().toLowerCase();
  return !normalized || normalized === "unknown" || normalized === "-" || normalized === "null";
}

function matchesStatus(log: ProxyRequestLog, status?: string) {
  if (!status) return true;
  switch (status) {
    case "stream":
      return logIsStream(log);
    case "standard":
      return !logIsStream(log);
    case "active":
    case "pending":
    case "streaming":
    case "cancelled":
    case "has_retry":
    case "has_fallback":
      return false;
    default:
      return logDisplayStatus(log) === status;
  }
}

function filterLogs(
  logs: ProxyRequestLog[],
  usersById: Map<string, FeishuUser>,
  filters: NewApiUsageRecordFilters,
) {
  const userId = normalizeFilter(filters.userId);
  const departmentId = normalizeFilter(filters.departmentId);
  const model = normalizeFilter(filters.model);
  const provider = normalizeFilter(filters.provider);
  const apiFormat = normalizeFilter(filters.apiFormat);
  const status = normalizeFilter(filters.status);
  const userAgent = normalizeFilter(filters.userAgent);
  const clientFamily = normalizeFilter(filters.clientFamily);
  const search = normalizeFilter(filters.search)?.toLowerCase();

  return logs.filter((log) => {
    const user = log.feishuUserId ? usersById.get(log.feishuUserId) : undefined;
    if (userId && log.feishuUserId !== userId) return false;
    if (departmentId && (log.departmentId ?? user?.departmentId) !== departmentId) return false;
    if (model && log.model !== model) return false;
    if (provider && log.provider !== provider) return false;
    if (apiFormat && log.apiFormat !== apiFormat) return false;
    if (userAgent && log.userAgent !== userAgent) return false;
    if (!userAgent && clientFamily && log.clientFamily !== clientFamily) return false;
    if (!matchesStatus(log, status)) return false;
    if (
      filters.hideUnknownRecords &&
      (isUnknownUsageValue(log.model) ||
        isUnknownUsageValue(log.provider) ||
        isUnknownUsageValue(log.apiFormat))
    ) {
      return false;
    }
    if (!search) return true;
    return [
      user?.name,
      user?.openId,
      log.requestPath,
      log.model,
      log.provider,
      log.providerKeyName,
      log.departmentName,
      log.apiFormat,
      log.clientIp,
      log.errorMessage,
      log.newapiRequestId,
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(search));
  });
}

function aggregateUsage(
  logs: ProxyRequestLog[],
  usersById: Map<string, FeishuUser>,
  keyFor: (log: ProxyRequestLog, user?: FeishuUser) => { key: string; label: string },
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
    const key = keyFor(log, user);
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
    const inputTokens = normalizedInputTokensTotal({
      promptTokens: log.promptTokens,
      inputTokensTotal: log.inputTokensTotal,
      cacheReadTokens: log.cacheReadTokens,
      cacheCreationTokens: log.cacheCreationTokens,
      usageSemantic: log.usageSemantic,
      apiFormat: log.apiFormat,
    });
    if (log.cacheReadTokens !== undefined && inputTokens !== undefined && inputTokens > 0) {
      row.cacheRateReadTokens += log.cacheReadTokens;
      row.cacheRateInputTokens += inputTokens;
    }
    row.cost += log.cost ?? 0;
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
      costPerMillionTokens:
        row.totalTokens > 0 ? (row.cost / row.totalTokens) * 1_000_000 : 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.requestCount - a.requestCount);
}

function usageTotals(logs: ProxyRequestLog[]) {
  return logs.reduce(
    (total, log) => {
      total.cost += log.cost ?? 0;
      total.promptTokens += log.promptTokens ?? 0;
      total.completionTokens += log.completionTokens ?? 0;
      total.totalTokens += log.totalTokens ?? 0;
      total.requestCount += 1;
      if (logDisplayStatus(log) === "completed") total.usageRecordCount += 1;
      if (!total.latestAt || log.createdAt.localeCompare(total.latestAt) > 0) {
        total.latestAt = log.createdAt;
      }
      return total;
    },
    {
      cost: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      requestCount: 0,
      usageRecordCount: 0,
      latestAt: undefined as string | undefined,
    },
  );
}

function effectivePoliciesByUser(
  policies: UserQuotaPolicy[],
  period: string,
) {
  const result = new Map<string, UserQuotaPolicy>();
  for (const policy of [...policies].sort(
    (left, right) => right.version - left.version || right.createdAt.localeCompare(left.createdAt),
  )) {
    if (policy.effectiveFromPeriod > period) continue;
    if (policy.effectiveToPeriod && policy.effectiveToPeriod < period) continue;
    if (!result.has(policy.feishuUserId)) result.set(policy.feishuUserId, policy);
  }
  return result;
}

async function currentPackageContext(
  bindings: ReportingBindings,
  options: { forceRefresh?: boolean } = {},
) {
  const settings = await getAppSettings();
  const window = packageWindow(settings.packageReset);
  const source = await loadAuthoritativeLogs({
    startAtMs: new Date(window.startAt).getTime(),
    endAtMs: Date.now(),
    forceRefresh: options.forceRefresh,
  });
  return {
    window,
    logs: mapAuthoritativeLogs(source.items, bindings),
    truncated: source.truncated,
  };
}

function buildUsageOverview(input: {
  feishuUserId: string;
  period: string;
  logs: ProxyRequestLog[];
  remainingQuota?: number;
  assignedMonthlyQuota?: number;
  nextResetAt?: string;
}) {
  const totals = usageTotals(input.logs);
  const packageQuota =
    input.assignedMonthlyQuota ??
    (input.remainingQuota === undefined
      ? totals.cost
      : Math.max(input.remainingQuota, 0) + totals.cost);
  return {
    id: `newapi:${input.feishuUserId}:${input.period}`,
    feishuUserId: input.feishuUserId,
    period: input.period,
    nextResetAt: input.nextResetAt,
    packageQuota,
    quotaConsumed: totals.cost,
    cost: totals.cost,
    remainingQuota: input.remainingQuota ?? 0,
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    totalTokens: totals.totalTokens,
    requestCount: totals.requestCount,
    usageRecordCount: totals.usageRecordCount,
    tokenAccountIds: [],
    sourceVersion: "newapi-direct-v1",
    updatedAt: new Date().toISOString(),
  };
}

async function userOverview(
  feishuUserId: string,
  bindings: ReportingBindings,
  current?: Awaited<ReturnType<typeof currentPackageContext>>,
) {
  const context = current ?? (await currentPackageContext(bindings));
  const active = bindings.tokenAccounts.find(
    (account) => account.feishuUserId === feishuUserId && account.status === "active",
  );
  const state = active?.newapiTokenId ? await tokenState(active.newapiTokenId) : undefined;
  const logs = context.logs.filter((log) => log.feishuUserId === feishuUserId);
  const policy = effectivePoliciesByUser(
    bindings.userQuotaPolicies,
    context.window.period,
  ).get(feishuUserId);
  return buildUsageOverview({
    feishuUserId,
    period: context.window.period,
    logs,
    remainingQuota: state?.remainingQuota,
    assignedMonthlyQuota:
      policy === undefined ? undefined : fromNewApiQuota(policy.assignedMonthlyQuota),
    nextResetAt: context.window.nextResetAt,
  });
}

export async function listNewApiAdminUsageRecords(
  input: NewApiUsageRecordFilters & { scope: AdminScope },
) {
  const bindings = await getNewApiReportingBindings({ scope: input.scope });
  const usersById = new Map(bindings.users.map((user) => [user.id, user]));
  const range = usageDateRange(input);
  const source = await loadAuthoritativeLogs({ startAtMs: range.start, endAtMs: range.end });
  const dateScopedLogs = mapAuthoritativeLogs(source.items, bindings);
  const filteredLogs = filterLogs(dateScopedLogs, usersById, input).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const limit = boundedLimit(input.limit, 100);
  const offset = boundedOffset(input.offset);
  const modelStats = aggregateUsage(filteredLogs, usersById, (log) => ({
    key: log.model ?? "unknown",
    label: log.model ?? "unknown",
  }));
  const departmentStats = aggregateUsage(filteredLogs, usersById, (log, user) => ({
    key: log.departmentId ?? user?.departmentId ?? "unknown",
    label:
      log.departmentName ??
      user?.departmentName ??
      log.departmentId ??
      user?.departmentId ??
      "unknown",
  }));
  return {
    source: "newapi" as const,
    truncated: source.truncated,
    records: filteredLogs
      .slice(offset, offset + limit)
      .map((log) => usageRecordView(log, usersById)),
    total: filteredLogs.length,
    limit,
    offset,
    filters: {
      users: bindings.users
        .filter((user) => dateScopedLogs.some((log) => log.feishuUserId === user.id))
        .map((user) => ({
          id: user.id,
          name: user.name,
          openId: user.openId,
          departmentId: user.departmentId,
          departmentName: user.departmentName,
        }))
        .sort((a, b) => (a.name ?? a.openId).localeCompare(b.name ?? b.openId, "zh-CN")),
      departments: [
        ...new Map(
          dateScopedLogs.map((log) => [
            log.departmentId ?? "unknown",
            { id: log.departmentId ?? "unknown", name: log.departmentName },
          ]),
        ).values(),
      ].sort((a, b) => a.id.localeCompare(b.id)),
      models: uniqueSorted(dateScopedLogs.map((log) => log.model)),
      providers: uniqueSorted(dateScopedLogs.map((log) => log.provider)),
      apiFormats: uniqueSorted(dateScopedLogs.map((log) => log.apiFormat)),
      userAgents: [],
      clientFamilies: [],
    },
    modelStats,
    departmentStats,
    apiFormatStats: aggregateUsage(filteredLogs, usersById, (log) => ({
      key: log.apiFormat ?? "unknown",
      label: log.apiFormat ?? "unknown",
    })),
  };
}

export async function listNewApiUserUsageReport(
  input: NewApiUsageRecordFilters & { feishuUserId: string },
) {
  const bindings = await getNewApiReportingBindings({
    feishuUserId: input.feishuUserId,
  });
  const usersById = new Map(bindings.users.map((user) => [user.id, user]));
  const range = usageDateRange(input);
  const [source, current] = await Promise.all([
    loadAuthoritativeLogs({ startAtMs: range.start, endAtMs: range.end }),
    currentPackageContext(bindings),
  ]);
  const dateScopedLogs = mapAuthoritativeLogs(source.items, bindings);
  const filteredLogs = filterLogs(dateScopedLogs, usersById, input).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const limit = boundedLimit(input.limit, 100);
  const offset = boundedOffset(input.offset);
  const overview = await userOverview(input.feishuUserId, bindings, current);
  return {
    source: "newapi" as const,
    truncated: source.truncated || current.truncated,
    records: filteredLogs
      .slice(offset, offset + limit)
      .map((log) => usageRecordView(log, usersById)),
    total: filteredLogs.length,
    limit,
    offset,
    filters: {
      models: uniqueSorted(dateScopedLogs.map((log) => log.model)),
      providers: uniqueSorted(dateScopedLogs.map((log) => log.provider)),
      apiFormats: uniqueSorted(dateScopedLogs.map((log) => log.apiFormat)),
      userAgents: [],
      clientFamilies: [],
    },
    modelStats: aggregateUsage(filteredLogs, usersById, (log) => ({
      key: log.model ?? "unknown",
      label: log.model ?? "unknown",
    })),
    apiFormatStats: aggregateUsage(filteredLogs, usersById, (log) => ({
      key: log.apiFormat ?? "unknown",
      label: log.apiFormat ?? "unknown",
    })),
    usageOverview: overview,
  };
}

async function buildAdminUserRows(scope: AdminScope) {
  const [baseUsers, bindings] = await Promise.all([
    listAdminUsers(scope),
    getNewApiReportingBindings({ scope }),
  ]);
  const [current, states] = await Promise.all([
    currentPackageContext(bindings),
    activeTokenStates(bindings),
  ]);
  const policiesByUser = effectivePoliciesByUser(
    bindings.userQuotaPolicies,
    current.window.period,
  );
  const logsByUser = new Map<string, ProxyRequestLog[]>();
  for (const log of current.logs) {
    if (!log.feishuUserId) continue;
    const logs = logsByUser.get(log.feishuUserId) ?? [];
    logs.push(log);
    logsByUser.set(log.feishuUserId, logs);
  }
  return {
    truncated: current.truncated,
    users: baseUsers.map((user) => {
      const totals = usageTotals(logsByUser.get(user.id) ?? []);
      const remaining = states.get(user.id)?.remainingQuota;
      const policy = policiesByUser.get(user.id);
      return {
        ...user,
        packagePeriod: current.window.period,
        packageQuota:
          policy === undefined
            ? remaining === undefined
              ? totals.cost
              : Math.max(remaining, 0) + totals.cost
            : fromNewApiQuota(policy.assignedMonthlyQuota),
        remainingQuota: remaining,
        quotaConsumed: totals.cost,
        cost: totals.cost,
        totalTokens: totals.totalTokens,
        promptTokens: totals.promptTokens,
        completionTokens: totals.completionTokens,
        requestCount: totals.requestCount,
        usageRecordCount: totals.usageRecordCount,
        latestActivityAt: totals.latestAt,
      };
    }),
  };
}

function directoryFilters(rows: Array<{ departmentId?: string; departmentName?: string }>) {
  return {
    departments: [
      ...new Map(
        rows
          .filter((row) => row.departmentId)
          .map((row) => [
            row.departmentId!,
            { id: row.departmentId!, name: row.departmentName },
          ]),
      ).values(),
    ].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id, "zh-CN")),
  };
}

export async function listNewApiAdminUsers(scope: AdminScope, query: AdminDirectoryQuery) {
  const built = await buildAdminUserRows(scope);
  const page = queryAdminDirectory({
    rows: built.users,
    query,
    defaultSortBy: "latestActivity",
  });
  return {
    source: "newapi" as const,
    truncated: built.truncated,
    users: page.rows,
    total: page.total,
    limit: page.limit,
    offset: page.offset,
    sortBy: page.sortBy,
    sortOrder: page.sortOrder,
    filters: directoryFilters(built.users),
  };
}

export async function getNewApiAdminOverviewMetrics(scope: AdminScope) {
  const built = await buildAdminUserRows(scope);
  const totals = built.users.reduce(
    (sum, user) => ({
      packageQuota: sum.packageQuota + Math.max(user.packageQuota ?? 0, 0),
      remainingQuota:
        sum.remainingQuota + Math.max(user.remainingQuota ?? 0, 0),
      consumedQuota: sum.consumedQuota + Math.max(user.quotaConsumed ?? 0, 0),
      promptTokens: sum.promptTokens + Math.max(user.promptTokens ?? 0, 0),
      completionTokens:
        sum.completionTokens + Math.max(user.completionTokens ?? 0, 0),
      totalTokens: sum.totalTokens + Math.max(user.totalTokens ?? 0, 0),
      requestCount: sum.requestCount + Math.max(user.requestCount ?? 0, 0),
      usageRecordCount:
        sum.usageRecordCount + Math.max(user.usageRecordCount ?? 0, 0),
    }),
    {
      packageQuota: 0,
      remainingQuota: 0,
      consumedQuota: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      requestCount: 0,
      usageRecordCount: 0,
    },
  );
  return {
    source: "newapi" as const,
    period: built.users[0]?.packagePeriod ?? packageWindow(
      (await getAppSettings()).packageReset,
    ).period,
    truncated: built.truncated,
    ...totals,
  };
}

export async function listNewApiAdminUserStats(
  scope: AdminScope,
  query: AdminDirectoryQuery,
) {
  const built = await buildAdminUserRows(scope);
  const stats = built.users.map((user) => ({
    id: user.id,
    name: user.name,
    openId: user.openId,
    departmentId: user.departmentId,
    departmentName: user.departmentName,
    status: user.status,
    role: user.role,
    activeTokenStatus: user.activeTokenStatus,
    packagePeriod: user.packagePeriod,
    packageQuota: user.packageQuota ?? 0,
    remainingQuota: user.remainingQuota,
    quotaConsumed: user.quotaConsumed ?? 0,
    cost: user.cost ?? 0,
    promptTokens: user.promptTokens ?? 0,
    completionTokens: user.completionTokens ?? 0,
    totalTokens: user.totalTokens ?? 0,
    requestCount: user.requestCount ?? 0,
    usageRecordCount: user.usageRecordCount ?? 0,
    quotaUsageRate:
      user.packageQuota && user.packageQuota > 0
        ? (user.quotaConsumed ?? 0) / user.packageQuota
        : 0,
    latestActivityAt: user.latestActivityAt,
  }));
  const page = queryAdminDirectory({
    rows: stats,
    query,
    defaultSortBy: "quotaConsumed",
  });
  return {
    source: "newapi" as const,
    truncated: built.truncated,
    stats: page.rows,
    total: page.total,
    limit: page.limit,
    offset: page.offset,
    sortBy: page.sortBy,
    sortOrder: page.sortOrder,
    filters: directoryFilters(stats),
  };
}

export async function listNewApiDepartmentStats(scope: AdminScope) {
  if (scope.scopeType !== "global") return null;
  const bindings = await getNewApiReportingBindings({ scope });
  const [current, states] = await Promise.all([
    currentPackageContext(bindings),
    activeTokenStates(bindings),
  ]);
  const quotaOverview = await listDepartmentQuotaOverview(
    scope,
    current.window.period,
  );
  const quotaByDepartment = new Map(
    quotaOverview.departments.map((department) => [
      department.departmentId,
      department,
    ]),
  );
  const policiesByUser = effectivePoliciesByUser(
    bindings.userQuotaPolicies,
    current.window.period,
  );
  const activeUserIds = new Set(
    bindings.tokenAccounts
      .filter((account) => account.status === "active")
      .map((account) => account.feishuUserId),
  );
  const logsByDepartment = new Map<string, ProxyRequestLog[]>();
  for (const log of current.logs) {
    if (!log.departmentId) continue;
    const id = log.departmentId;
    const logs = logsByDepartment.get(id) ?? [];
    logs.push(log);
    logsByDepartment.set(id, logs);
  }
  const usersByDepartment = new Map<string, FeishuUser[]>();
  for (const user of bindings.users) {
    if (!user.departmentId) continue;
    const id = user.departmentId;
    const users = usersByDepartment.get(id) ?? [];
    users.push(user);
    usersByDepartment.set(id, users);
  }
  const departmentIds = new Set([
    ...usersByDepartment.keys(),
    ...logsByDepartment.keys(),
    ...quotaByDepartment.keys(),
  ]);
  const rows = [...departmentIds].map((departmentId) => {
    const users = usersByDepartment.get(departmentId) ?? [];
    const logs = logsByDepartment.get(departmentId) ?? [];
    const quota = quotaByDepartment.get(departmentId);
    const totals = usageTotals(logs);
    const remainingQuota = users.reduce(
      (sum, user) => sum + (states.get(user.id)?.remainingQuota ?? 0),
      0,
    );
    const fallbackIssuedQuota = users.reduce((sum, user) => {
      const policy = policiesByUser.get(user.id);
      return (
        sum +
        (policy
          ? fromNewApiQuota(policy.assignedMonthlyQuota)
          : (states.get(user.id)?.remainingQuota ?? 0) +
            usageTotals(logs.filter((log) => log.feishuUserId === user.id)).cost)
      );
    }, 0);
    const issuedQuota = quota?.allocatedQuota ?? fallbackIssuedQuota;
    return {
      departmentId,
      departmentName:
        quota?.departmentName ??
        users.find((user) => user.departmentName)?.departmentName,
      memberCount:
        quota?.memberCount ?? users.filter((user) => user.status !== "deleted").length,
      keyedUsers:
        quota?.keyedUsers ?? users.filter((user) => activeUserIds.has(user.id)).length,
      issuedQuota,
      totalQuotaLimit: quota?.quotaLimit ?? issuedQuota,
      remainingQuota,
      quotaConsumed: totals.cost,
      cost: totals.cost,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      totalTokens: totals.totalTokens,
      requestCount: totals.requestCount,
      usageRecordCount: totals.usageRecordCount,
      quotaUsageRate: issuedQuota > 0 ? totals.cost / issuedQuota : 0,
      latestActivityAt: totals.latestAt,
    };
  });
  return {
    source: "newapi" as const,
    truncated: current.truncated,
    departments: rows.sort(
      (a, b) => b.quotaConsumed - a.quotaConsumed || b.totalTokens - a.totalTokens,
    ),
  };
}

export async function getNewApiUserOverview(feishuUserId: string) {
  const bindings = await getNewApiReportingBindings({ feishuUserId });
  if (!bindings.users.some((user) => user.id === feishuUserId)) return null;
  return userOverview(feishuUserId, bindings);
}

export async function getNewApiUserAuthoritativeQuotaSnapshot(feishuUserId: string) {
  const bindings = await getNewApiReportingBindings({ feishuUserId });
  const activeAccount = bindings.tokenAccounts.find(
    (account) => account.feishuUserId === feishuUserId && account.status === "active",
  );
  const current = await currentPackageContext(bindings, { forceRefresh: true });
  const logs = current.logs.filter(
    (log) =>
      log.feishuUserId === feishuUserId &&
      log.status === "completed" &&
      Number.isFinite(log.quota),
  );
  const state = activeAccount?.newapiTokenId
    ? await getNewApiTokenControlState(activeAccount.newapiTokenId)
    : undefined;
  return {
    period: current.window.period,
    windowStartAt: current.window.startAt,
    windowEndAt: current.window.endAt,
    activeAccount: activeAccount ?? null,
    observedRemainQuota: state?.remainQuota,
    consumedQuota: logs.reduce((sum, log) => sum + Math.max(log.quota ?? 0, 0), 0),
    requestCount: logs.length,
    truncated: current.truncated,
  };
}
