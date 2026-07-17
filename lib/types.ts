import type { UsageFieldSources, UsageSemantic } from "@/lib/usage-metrics";

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

export type TokenRequest = {
  id: string;
  feishuUserId: string;
  requestType:
    | "first_apply"
    | "quota_reset"
    | "quota_restore"
    | "key_reset"
    | "quota_adjust"
    | "monthly_reset";
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
  approvalRouteReason?: ApprovalRouteReason;
  approvalRouteNotice?: string;
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
  upstreamStatusCode?: number;
  upstreamResponseReceivedAt?: string;
  upstreamHeadersMs?: number;
  clientDeliveryStatus?: "completed" | "failed" | "cancelled";
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
  usageSettlementStatus?: "pending" | "retrying" | "matched" | "manual_review";
  usageSettlementAttempts?: number;
  usageSettlementImmediateAttempts?: number;
  usageSettlementScanAttempts?: number;
  usageSettlementLastError?: string;
  usageSettlementNextRetryAt?: string;
  usageSettledAt?: string;
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

export type ProxyAdmissionLogInput = Omit<
  ProxyRequestLog,
  | "id"
  | "feishuUserId"
  | "tokenAccountId"
  | "departmentId"
  | "departmentName"
  | "providerKeyName"
  | "status"
  | "statusCode"
  | "durationMs"
  | "billingPeriod"
  | "operationGeneration"
  | "leaseExpiresAt"
  | "heartbeatAt"
  | "createdAt"
  | "updatedAt"
> &
  Partial<Pick<ProxyRequestLog, "status" | "statusCode" | "durationMs">>;

export type ProxyRequestAdmissionResult =
  | {
      status: "admitted";
      account: TokenAccount;
      user: FeishuUser;
      proxyLog: ProxyRequestLog;
    }
  | { status: "inactive_token" }
  | { status: "bound_user_missing"; account: TokenAccount }
  | {
      status: "bound_user_inactive";
      account: TokenAccount;
      user: FeishuUser;
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
  scanTargetEnd?: string;
  scanMode?: "forward" | "repair";
  scanExpectedTotal?: number;
  scanFirstIdentity?: string;
  repairCursorThrough?: string;
  repairWindowStart?: string;
  repairWindowEnd?: string;
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
  closedAt?: string;
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
  assignedQuotaUpdatedAt?: string;
  assignedQuotaUpdatedByFeishuUserId?: string;
  assignedMonthlyQuotaSnapshot?: number;
  authorizedQuota?: number;
  authoritativeConsumedQuota?: number;
  expectedAvailableQuota?: number;
  overageQuota?: number;
  settledThrough?: string;
  sourceVersion?: string;
  materializedAt?: string;
  updatedAt: string;
};

export type DepartmentQuotaPeriod = {
  id: string;
  departmentId: string;
  departmentName?: string;
  period: string;
  quotaLimit: number;
  defaultGrantQuota: number;
  budgetQuota?: number;
  committedAuthorizedQuota?: number;
  pendingReservedQuota?: number;
  availableQuota?: number;
  overcommittedQuota?: number;
  materializedAt?: string;
  createdAt: string;
  updatedAt: string;
  updatedByFeishuUserId?: string;
};

export type DepartmentQuotaRequestStatus =
  | "pending_card_send"
  | "pending_card_approval"
  | "approval_card_send_failed"
  | "approved"
  | "rejected"
  | "cancelled";

export type DepartmentQuotaRequest = {
  id: string;
  departmentId: string;
  departmentName?: string;
  period: string;
  requesterFeishuUserId: string;
  action: "increase" | "reset";
  status: DepartmentQuotaRequestStatus;
  reason: string;
  currentQuotaLimit: number;
  requestedQuotaLimit: number;
  approvedQuotaLimit?: number;
  approvalTargetOpenId: string;
  approvalCardMessageId?: string;
  approvalActionNonceHash: string;
  approvalOperatorOpenId?: string;
  approvalOperatedAt?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type QuotaChangeEvent = {
  id: string;
  departmentId: string;
  departmentName?: string;
  period: string;
  feishuUserId?: string;
  operatedByFeishuUserId: string;
  kind: "department_limit_set" | "department_default_set" | "user_quota_allocate";
  status: "pending" | "applied" | "failed" | "expired";
  previousValue: number;
  nextValue: number;
  delta: number;
  relatedTokenRequestId?: string;
  relatedDepartmentQuotaRequestId?: string;
  expiresAt?: string;
  errorMessage?: string;
  createdAt: string;
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

export type QuotaOperationType =
  | "first_provision"
  | "quota_adjust"
  | "key_rotation"
  | "quota_restore"
  | "monthly_open"
  | "reconcile"
  | "migration";

export type QuotaOperationState =
  | "planned"
  | "budget_reserved"
  | "local_prepared"
  | "admission_closed"
  | "upstream_frozen"
  | "draining"
  | "snapshot_stable"
  | "upstream_applying"
  | "upstream_applied"
  | "upstream_activated"
  | "local_finalized"
  | "reconciling"
  | "completed"
  | "retryable_failed"
  | "compensating"
  | "compensated"
  | "manual_review";

export type UserQuotaPolicy = {
  id: string;
  feishuUserId: string;
  assignedMonthlyQuota: number;
  departmentId?: string;
  effectiveFromPeriod: string;
  effectiveToPeriod?: string;
  sourceType: "first_apply" | "quota_adjust" | "department_allocate" | "migration" | "admin_correction";
  sourceId: string;
  version: number;
  quotaPerUnitSnapshot: number;
  createdAt: string;
  updatedAt: string;
  updatedByOpenId?: string;
};

export type QuotaOperation = {
  id: string;
  operationType: QuotaOperationType;
  idempotencyKey: string;
  feishuUserId: string;
  departmentId?: string;
  billingPeriod: string;
  requestedAssignedQuota?: number;
  assignedQuotaBefore?: number;
  observedRemainBefore?: number;
  targetRemainQuota?: number;
  observedRemainAfter?: number;
  reservedDepartmentQuota: number;
  operationGeneration: number;
  state: QuotaOperationState;
  attemptCount: number;
  nextRetryAt?: string;
  workerLeaseId?: string;
  workerLeaseExpiresAt?: string;
  upstreamTokenIdBefore?: string;
  upstreamTokenIdAfter?: string;
  tokenAccountIdBefore?: string;
  tokenAccountIdAfter?: string;
  requestId?: string;
  evidence?: Record<string, string | number | boolean | undefined>;
  credentialCiphertext?: string;
  credentialDeliveredAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdByOpenId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type QuotaLedgerEntryType =
  | "period_open_authorization"
  | "quota_adjust_grant"
  | "quota_adjust_release"
  | "quota_restore_grant"
  | "admin_correction_debit"
  | "admin_correction_credit"
  | "migration_opening"
  | "operation_compensation";

export type QuotaLedgerEntry = {
  id: string;
  operationId: string;
  feishuUserId: string;
  departmentId?: string;
  period: string;
  signedQuota: number;
  entryType: QuotaLedgerEntryType;
  quotaPerUnitSnapshot: number;
  sourceType: string;
  sourceId: string;
  estimated?: boolean;
  createdAt: string;
};

export type UserQuotaState = {
  feishuUserId: string;
  admission: "open" | "closed";
  activeGeneration: number;
  operationId?: string;
  closedReason?: string;
  updatedAt: string;
};

export type QuotaReconciliationStatus =
  | "healthy"
  | "excess_upstream"
  | "deficit_upstream"
  | "provisional"
  | "manual_review";

export type QuotaReconciliationRecord = {
  id: string;
  feishuUserId: string;
  tokenAccountId?: string;
  period: string;
  expectedAvailableQuota: number;
  observedRemainQuota?: number;
  delta?: number;
  status: QuotaReconciliationStatus;
  settledThrough?: string;
  operationId?: string;
  evidence?: Record<string, string | number | boolean | undefined>;
  createdAt: string;
  updatedAt: string;
};

export type BillingOperationKind = "usage_sync" | "monthly_reset" | "settings_update";

export type BillingOperationStatus =
  | "pending"
  | "running"
  | "dry_run"
  | "applied"
  | "partial_failed"
  | "failed";

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
  attemptCount?: number;
  leaseId?: string;
  leaseExpiresAt?: string;
  startedAt?: string;
  completedAt?: string;
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

export type QuotaFeatureFlags = {
  legacyAbsoluteQuotaWritesEnabled: boolean;
  quotaLedgerShadowRead: boolean;
  quotaSagaWritesEnabled: boolean;
  keyRotationSagaEnabled: boolean;
  quotaRestoreEnabled: boolean;
  monthlyPeriodOpenEnabled: boolean;
  reconciliationAutoDecreaseEnabled: boolean;
  reconciliationAutoIncreaseEnabled: boolean;
};

export type AppSettings = {
  defaultMonthlyQuota: number;
  usageSyncPolicy?: UsageSyncPolicy;
  quotaFeatureFlags?: QuotaFeatureFlags;
  quotaMigration?: {
    period: string;
    appliedAt: string;
    planHash: string;
    users: number;
    estimatedUsers: number;
  };
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
  departmentQuotaPeriods: DepartmentQuotaPeriod[];
  departmentQuotaRequests: DepartmentQuotaRequest[];
  quotaChangeEvents: QuotaChangeEvent[];
  userQuotaPolicies: UserQuotaPolicy[];
  quotaOperations: QuotaOperation[];
  quotaLedgerEntries: QuotaLedgerEntry[];
  userQuotaStates: UserQuotaState[];
  quotaReconciliationRecords: QuotaReconciliationRecord[];
  feishuEvents: FeishuEvent[];
  proxyRequestLogs: ProxyRequestLog[];
  newapiUsageRecords: NewApiUsageRecord[];
  usageSyncCheckpoints: UsageSyncCheckpoint[];
  usageSyncIssues: UsageSyncIssue[];
  adminScopes: AdminScope[];
};
