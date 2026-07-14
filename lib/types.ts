import type { UsageFieldSources, UsageSemantic } from "./usage-metrics.ts";

export type ApprovalRouteReason =
  | "department_leader"
  | "parent_department_leader"
  | "applicant_is_department_admin"
  | "no_department"
  | "no_leader"
  | "directory_lookup_failed"
  | "manual_fallback";

export type TokenStatus =
  | "pending_activation"
  | "active"
  | "draining"
  | "settling"
  | "replaced"
  | "disabled"
  | "orphaned"
  | "revoked";

export type ProxyRequestStatus =
  | "pending"
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled";

export type FeishuUser = {
  id: string;
  tenantKey: string;
  openId: string;
  unionId?: string;
  feishuUserIdFromFeishu?: string;
  name?: string;
  avatarUrl?: string;
  departmentId?: string;
  departmentName?: string;
  status?: "active" | "disabled" | "deleted";
  disabledAt?: string;
  disabledReason?: string;
  deletedAt?: string;
  deletedReason?: string;
  createdAt: string;
  updatedAt: string;
};

export type TokenAccount = {
  id: string;
  feishuUserId: string;
  sourceRequestId: string;
  newapiTokenId?: string;
  keyHash: string;
  status: TokenStatus;
  billingPeriod: string;
  operationGeneration?: number;
  drainStartedAt?: string;
  settledThrough?: string;
  activatedAt?: string;
  prewarmedAt?: string;
  prewarmDepartmentId?: string;
  prewarmedCredentialCiphertext?: string;
  createdAt: string;
  disabledAt?: string;
  replacedByTokenAccountId?: string;
};

export type FeishuEvent = {
  id: string;
  eventUuid: string;
  eventType?: string;
  instanceCode?: string;
  approvalStatus?: string;
  cardRequestId?: string;
  cardAction?: string;
  operatorOpenId?: string;
  messageId?: string;
  processingStatus: "processed" | "ignored" | "failed";
  payloadJson: unknown;
  errorMessage?: string;
  createdAt: string;
};

export type ProxyRequestLog = {
  id: string;
  feishuUserId?: string;
  tokenAccountId?: string;
  departmentId?: string;
  departmentName?: string;
  requestPath: string;
  method: string;
  status?: ProxyRequestStatus;
  statusCode: number;
  durationMs: number;
  firstByteMs?: number;
  preparationMs?: number;
  billingContextMs?: number;
  upstreamFirstByteMs?: number;
  responseTimeUpdatedAt?: string;
  model?: string;
  provider?: string;
  providerKeyName?: string;
  apiFormat?: string;
  endpointApiFormat?: string;
  requestType?: "standard" | "stream";
  isStream?: boolean;
  upstreamIsStream?: boolean;
  clientRequestedStream?: boolean;
  clientIsStream?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  inputTokensTotal?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheCreationTokens5m?: number;
  cacheCreationTokens1h?: number;
  usageSemantic?: UsageSemantic;
  usageFieldSources?: UsageFieldSources;
  quota?: number;
  cost?: number;
  actualCost?: number;
  usageSource?: "proxy_json" | "proxy_stream" | "newapi_log" | "missing";
  usageSyncedAt?: string;
  newapiLogId?: string;
  newapiRequestId?: string;
  newapiResponseRequestId?: string;
  newapiUpstreamRequestId?: string;
  providerChannelName?: string;
  newapiUseTimeSeconds?: number;
  errorMessage?: string;
  clientFamily?: string;
  clientIp?: string;
  userAgent?: string;
  billingPeriod?: string;
  operationGeneration?: number;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  terminalStatus?: "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt?: string;
};

export type NewApiUsageMatchStatus =
  | "matched"
  | "unknown_token"
  | "no_proxy_match"
  | "malformed_log";

export type NewApiUsageRecord = {
  id: string;
  newapiLogId?: string;
  newapiRequestId?: string;
  newapiTokenId?: string;
  tokenAccountId?: string;
  feishuUserId?: string;
  departmentId?: string;
  departmentName?: string;
  matchedProxyLogId?: string;
  billingPeriod?: string;
  matchStatus: NewApiUsageMatchStatus;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  inputTokensTotal?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheCreationTokens5m?: number;
  cacheCreationTokens1h?: number;
  usageSemantic?: UsageSemantic;
  usageFieldSources?: UsageFieldSources;
  quota?: number;
  cost?: number;
  actualCost?: number;
  isStream?: boolean;
  newapiType?: string;
  newapiUpstreamRequestId?: string;
  providerChannelName?: string;
  newapiUseTimeSeconds?: number;
  newapiCreatedAt?: string;
  raw?: unknown;
  firstSeenAt: string;
  lastSyncedAt: string;
};

export type BillingOperationStatus = "dry_run" | "applied" | "partial_failed" | "failed";

export type UsageSyncCheckpoint = {
  id: string;
  scope: "newapi_usage_logs";
  pageStart: number;
  pageSize: number;
  maxPages: number;
  overlapMinutes: number;
  matchWindowMinutes: number;
  lastSeenNewapiLogId?: string;
  lastSeenNewapiCreatedAt?: string;
  lastRunAt?: string;
  lastRunStatus?: BillingOperationStatus;
  lastRunBy?: "manual" | "auto";
  lastRunSummary?: Record<string, string | number | boolean | undefined>;
  nextRunAfter?: string;
  runId?: string;
  runStartedAt?: string;
  scanStart?: string;
  scanEnd?: string;
  settledThrough?: string;
  cursorPage?: number;
  failureCount?: number;
  nextRetryAt?: string;
  updatedAt: string;
};

export type UsageSyncIssueType =
  | "unknown_token"
  | "no_proxy_match"
  | "missing_cost"
  | "malformed_log";

export type UsageSyncIssue = {
  id: string;
  issueType: UsageSyncIssueType;
  status: "open" | "closed";
  newapiLogId?: string;
  newapiRequestId?: string;
  newapiTokenId?: string;
  tokenAccountId?: string;
  feishuUserId?: string;
  matchedProxyLogId?: string;
  message: string;
  occurrences: number;
  raw?: unknown;
  firstSeenAt: string;
  lastSeenAt: string;
  lastSyncedAt: string;
};

export type AdminScope = {
  id: string;
  feishuUserId: string;
  scopeType: "global" | "department";
  departmentId?: string;
  source: "manual" | "department_supervisor" | "environment";
  role?: "root";
  status: "active" | "disabled";
  disabledReason?: "manual_revoke" | "user_deleted" | "auto_sync_lost";
  disabledByFeishuUserId?: string;
  disabledAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type UsageSyncPolicy = {
  enabled: boolean;
  intervalMinutes: number;
  pageSize: number;
  maxPagesPerRun: number;
  overlapMinutes: number;
  settlementLagMinutes?: number;
  matchWindowMinutes: number;
  retryBaseMinutes?: number;
  updatedAt?: string;
  updatedByFeishuUserId?: string;
  lastRunAt?: string;
  lastRunStatus?: BillingOperationStatus;
  lastRunMessage?: string;
  lastRunBy?: "manual" | "auto";
  nextRunAfter?: string;
};
