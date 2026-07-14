import type { NormalizedNewApiUsageLog } from "./newapi.ts";
import type { ProxyRequestLog, TokenAccount } from "./types.ts";

const MAX_SAFE_TIME_DELTA_MS = 30_000;
const BILLABLE_PROXY_PATHS = new Set([
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/messages",
]);

function normalizedModel(value?: string) {
  const normalized = value?.trim().toLowerCase();
  return !normalized || normalized === "unknown" || normalized === "-" || normalized === "null"
    ? undefined
    : normalized;
}

function timestamp(value?: string) {
  if (!value) return undefined;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

function proxyLogFinishedAt(log: ProxyRequestLog) {
  return timestamp(log.responseTimeUpdatedAt) ?? timestamp(log.updatedAt) ?? timestamp(log.createdAt);
}

function usageLogCreatedAt(log: NormalizedNewApiUsageLog) {
  return timestamp(log.createdAt);
}

function normalizedProxyPath(value: string) {
  return value.split("?", 1)[0];
}

function hasCompleteProxyUsage(log: ProxyRequestLog) {
  return log.promptTokens !== undefined && log.completionTokens !== undefined;
}

function hasCompleteNewApiUsage(log: NormalizedNewApiUsageLog) {
  return log.promptTokens !== undefined && log.completionTokens !== undefined;
}

function usageMetricsMatch(log: ProxyRequestLog, usageLog: NormalizedNewApiUsageLog) {
  if (!hasCompleteProxyUsage(log) || !hasCompleteNewApiUsage(usageLog)) return false;
  return (
    log.promptTokens === usageLog.promptTokens &&
    log.completionTokens === usageLog.completionTokens
  );
}

export function proxyLogIsStream(log: ProxyRequestLog) {
  return Boolean(
    log.isStream ||
      log.upstreamIsStream ||
      log.clientRequestedStream ||
      log.clientIsStream ||
      log.requestType === "stream",
  );
}

export function isBillableProxyLog(log: ProxyRequestLog) {
  const status =
    log.status ??
    (log.statusCode === 499 ? "cancelled" : log.statusCode >= 400 ? "failed" : "completed");
  return (
    status === "completed" &&
    log.statusCode >= 200 &&
    log.statusCode < 400 &&
    log.method.toUpperCase() === "POST" &&
    BILLABLE_PROXY_PATHS.has(normalizedProxyPath(log.requestPath))
  );
}

function matchScore(input: {
  proxyLog: ProxyRequestLog;
  usageLog: NormalizedNewApiUsageLog;
  matchWindowMs: number;
}) {
  const { proxyLog, usageLog, matchWindowMs } = input;
  if (!isBillableProxyLog(proxyLog)) return undefined;

  const exactRequestId = Boolean(
    usageLog.newapiRequestId && proxyLog.newapiRequestId === usageLog.newapiRequestId,
  );
  const exactResponseRequestId = Boolean(
    proxyLog.newapiResponseRequestId &&
      (proxyLog.newapiResponseRequestId === usageLog.newapiRequestId ||
        proxyLog.newapiResponseRequestId === usageLog.newapiUpstreamRequestId),
  );
  const exactUpstreamRequestId = Boolean(
    usageLog.newapiUpstreamRequestId &&
      proxyLog.newapiUpstreamRequestId === usageLog.newapiUpstreamRequestId,
  );
  const exactLogId = Boolean(
    usageLog.newapiLogId &&
      proxyLog.newapiLogId === usageLog.newapiLogId &&
      (!usageLog.newapiRequestId || !proxyLog.newapiRequestId || exactRequestId),
  );

  const proxyModel = normalizedModel(proxyLog.model);
  const usageModel = normalizedModel(usageLog.model);
  if (proxyModel && usageModel && proxyModel !== usageModel) return undefined;
  if (usageLog.isStream !== undefined && proxyLogIsStream(proxyLog) !== usageLog.isStream) {
    return undefined;
  }

  const proxyTime = proxyLogFinishedAt(proxyLog);
  const usageTime = usageLogCreatedAt(usageLog);
  const timeDelta =
    proxyTime !== undefined && usageTime !== undefined
      ? Math.abs(proxyTime - usageTime)
      : Number.POSITIVE_INFINITY;
  const maxTimeDelta = Math.min(Math.max(matchWindowMs, 0), MAX_SAFE_TIME_DELTA_MS);

  if (exactRequestId) return Number.isFinite(timeDelta) ? timeDelta : 0;
  if (exactResponseRequestId || exactUpstreamRequestId) {
    return 50_000 + (Number.isFinite(timeDelta) ? timeDelta : 0);
  }
  if (exactLogId) return 100_000 + (Number.isFinite(timeDelta) ? timeDelta : 0);
  if (!Number.isFinite(timeDelta) || timeDelta > maxTimeDelta) return undefined;

  const exactUsage = usageMetricsMatch(proxyLog, usageLog);
  if (
    !proxyLogIsStream(proxyLog) &&
    proxyLog.usageSource === "proxy_json" &&
    hasCompleteProxyUsage(proxyLog) &&
    hasCompleteNewApiUsage(usageLog) &&
    !exactUsage
  ) {
    return undefined;
  }

  return (exactUsage ? 200_000 : 300_000) + timeDelta;
}

export function findProxyLogForNewApiUsage(input: {
  proxyLogs: ProxyRequestLog[];
  usageLog: NormalizedNewApiUsageLog;
  account: Pick<TokenAccount, "id" | "feishuUserId">;
  matchWindowMs: number;
  reservedProxyLogIds?: ReadonlySet<string>;
  allowReservedProxyLogId?: string;
  targetProxyLogIds?: ReadonlySet<string>;
}) {
  const {
    proxyLogs,
    usageLog,
    account,
    matchWindowMs,
    reservedProxyLogIds,
    allowReservedProxyLogId,
    targetProxyLogIds,
  } = input;

  return proxyLogs
    .filter((log) => !targetProxyLogIds || targetProxyLogIds.has(log.id))
    .filter(
      (log) =>
        !reservedProxyLogIds?.has(log.id) ||
        (allowReservedProxyLogId !== undefined && log.id === allowReservedProxyLogId),
    )
    .filter((log) => !log.feishuUserId || log.feishuUserId === account.feishuUserId)
    .filter(
      (log) =>
        log.tokenAccountId === account.id ||
        (usageLog.newapiTokenId !== undefined && log.providerKeyName === usageLog.newapiTokenId),
    )
    .map((log) => ({
      log,
      score: matchScore({ proxyLog: log, usageLog, matchWindowMs }),
    }))
    .filter((candidate): candidate is { log: ProxyRequestLog; score: number } =>
      Number.isFinite(candidate.score),
    )
    .sort((left, right) => left.score - right.score || left.log.id.localeCompare(right.log.id))[0]
    ?.log;
}
