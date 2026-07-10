export type RequestStatus =
  | "pending_card_send"
  | "pending_card_approval"
  | "approval_card_send_failed"
  | "approval_route_failed"
  | "pending_feishu_approval"
  | "approved"
  | "approved_provisioning"
  | "approved_provision_failed"
  | "provisioned"
  | "rejected"
  | "cancelled"
  | "invalidated"
  | "draft_pending_approval_config";

export type TokenStatus = "active" | "disabled" | "revoked" | "replaced";

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

export type TokenRequest = {
  id: string;
  feishuUserId: string;
  requestType: "first_apply" | "quota_reset" | "key_reset" | "quota_adjust" | "monthly_reset";
  status: RequestStatus;
  reason: string;
  requestedMonthlyQuota: number;
  approvedMonthlyQuota?: number;
  approvalCode?: string;
  approvalUuid: string;
  approvalInstanceCode?: string;
  approvalDepartmentId?: string;
  approvalMode?: "feishu_card" | "feishu_approval_legacy" | "manual";
  approvalTargetOpenId?: string;
  approvalTargetSource?:
    | "department_leader"
    | "parent_department_leader"
    | "manual_fallback"
    | "system_admin_fallback";
  approvalCardMessageId?: string;
  approvalActionNonceHash?: string;
  approvalOperatorOpenId?: string;
  approvalOperatedAt?: string;
  tokenAccountId?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type TokenAccount = {
  id: string;
  feishuUserId: string;
  tokenRequestId: string;
  newapiTokenId?: string;
  keyHash: string;
  status: TokenStatus;
  billingPeriod: string;
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
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  quota?: number;
  cost?: number;
  actualCost?: number;
  usageSource?: "proxy_json" | "proxy_stream" | "newapi_log" | "missing";
  usageSyncedAt?: string;
  newapiLogId?: string;
  newapiRequestId?: string;
  providerChannelName?: string;
  newapiUseTimeSeconds?: number;
  errorMessage?: string;
  clientFamily?: string;
  clientIp?: string;
  userAgent?: string;
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
  matchStatus: NewApiUsageMatchStatus;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  quota?: number;
  cost?: number;
  actualCost?: number;
  isStream?: boolean;
  newapiType?: string;
  providerChannelName?: string;
  newapiUseTimeSeconds?: number;
  newapiCreatedAt?: string;
  raw?: unknown;
  firstSeenAt: string;
  lastSyncedAt: string;
};

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

export type UserBillingPeriod = {
  id: string;
  feishuUserId: string;
  period: string;
  monthlyQuota: number;
  quotaConsumed: number;
  cost: number;
  remainingQuota: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  proxyLogCount: number;
  usageRecordCount: number;
  activeTokenAccountId?: string;
  tokenAccountIds: string[];
  updatedAt: string;
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

export type BillingOperationKind = "usage_sync" | "monthly_reset" | "settings_update";

export type BillingOperationStatus = "dry_run" | "applied" | "partial_failed" | "failed";

export type BillingOperationRecord = {
  id: string;
  kind: BillingOperationKind;
  status: BillingOperationStatus;
  dryRun: boolean;
  operatedByFeishuUserId: string;
  period?: string;
  input?: Record<string, unknown>;
  summary: Record<string, string | number | boolean | undefined>;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type UsageSyncPolicy = {
  enabled: boolean;
  intervalMinutes: number;
  pageSize: number;
  maxPagesPerRun: number;
  overlapMinutes: number;
  matchWindowMinutes: number;
  updatedAt?: string;
  updatedByFeishuUserId?: string;
  lastRunAt?: string;
  lastRunStatus?: BillingOperationStatus;
  lastRunMessage?: string;
  lastRunBy?: "manual" | "auto";
  nextRunAfter?: string;
};

export type AppSettings = {
  defaultMonthlyQuota: number;
  usageSyncPolicy?: UsageSyncPolicy;
  billingOperations?: BillingOperationRecord[];
  updatedAt?: string;
  updatedByFeishuUserId?: string;
};

export type StoreShape = {
  version: 1;
  settings: AppSettings;
  users: FeishuUser[];
  tokenRequests: TokenRequest[];
  tokenAccounts: TokenAccount[];
  userBillingPeriods: UserBillingPeriod[];
  feishuEvents: FeishuEvent[];
  proxyRequestLogs: ProxyRequestLog[];
  newapiUsageRecords: NewApiUsageRecord[];
  usageSyncCheckpoints: UsageSyncCheckpoint[];
  usageSyncIssues: UsageSyncIssue[];
  adminScopes: AdminScope[];
};
