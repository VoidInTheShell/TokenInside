export type PackageOwnerScopeType = "global" | "department";
export type PackageDefinitionStatus = "active" | "retired";
export type PackageVersionStatus = "draft" | "published" | "retired";
export type PackageCycleType = "calendar_month" | "calendar_quarter" | "fixed_days";
export type PackageAssignmentStatus = "active" | "disabled";
export type PackageGrantStatus = "active" | "exhausted" | "expired" | "revoked";
export type PackageRequestKind = "first" | "regrant" | "admin_grant";
export type PackageRequestStatus =
  | "pending_card_send"
  | "pending_card_approval"
  | "approval_card_send_failed"
  | "approved"
  | "approved_provisioning"
  | "provisioned"
  | "rejected"
  | "cancelled"
  | "failed";

export type BillingPackageDefinition = {
  id: string;
  ownerScopeType: PackageOwnerScopeType;
  ownerDepartmentId?: string;
  code: string;
  name: string;
  description: string;
  status: PackageDefinitionStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type PackageEligibilityPolicy = {
  allowFirstRequest: boolean;
};

export type PackageRegrantPolicy = {
  mode: "exhausted" | "remaining_ratio" | "remaining_quota" | "near_expiry";
  thresholdRatio?: number;
  thresholdQuota?: number;
  nearExpiryHours?: number;
};

export type BillingPackageVersion = {
  id: string;
  definitionId: string;
  version: number;
  grantedQuota: number;
  cycleType: PackageCycleType;
  cycleValue: number;
  timezone: "Asia/Hong_Kong";
  eligibilityPolicy: PackageEligibilityPolicy;
  regrantPolicy: PackageRegrantPolicy;
  status: PackageVersionStatus;
  effectiveFrom?: string;
  effectiveUntil?: string;
  createdByUserId: string;
  createdAt: string;
  publishedAt?: string;
  retiredAt?: string;
};

export type DepartmentPackageAssignment = {
  id: string;
  departmentId: string;
  packageVersionId: string;
  isDefault: boolean;
  status: PackageAssignmentStatus;
  assignedByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type BillingPackageRequest = {
  id: string;
  requestKind: PackageRequestKind;
  userId: string;
  departmentIdAtRequest: string;
  packageDefinitionId: string;
  packageVersionId: string;
  status: PackageRequestStatus;
  reason: string;
  idempotencyKey: string;
  approvalTargetOpenId?: string;
  approvalTargetSource?:
    | "department_leader"
    | "parent_department_leader"
    | "manual_fallback"
    | "system_admin_fallback";
  approvalActionNonceHash?: string;
  approvalCardMessageId?: string;
  approvalOperatorOpenId?: string;
  approvalOperatedAt?: string;
  billingOperationId?: string;
  grantId?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type PackageGrantSnapshot = {
  packageCode: string;
  packageName: string;
  packageDescription: string;
  version: number;
  grantedQuota: number;
  cycleType: PackageCycleType;
  cycleValue: number;
  timezone: "Asia/Hong_Kong";
  eligibilityPolicy: PackageEligibilityPolicy;
  regrantPolicy: PackageRegrantPolicy;
};

export type UserPackageGrant = {
  id: string;
  userId: string;
  departmentIdAtGrant: string;
  packageDefinitionId: string;
  packageVersionId: string;
  snapshot: PackageGrantSnapshot;
  grantedQuota: number;
  allocatedQuota: number;
  startsAt: string;
  expiresAt: string;
  status: PackageGrantStatus;
  sourceRequestId: string;
  budgetCommitmentId: string;
  createdByUserId: string;
  createdAt: string;
  revokedAt?: string;
  expiredAt?: string;
};

export type DepartmentBudgetPeriod = {
  id: string;
  departmentId: string;
  periodType: "calendar_month" | "calendar_quarter" | "fixed_range";
  periodStart: string;
  periodEnd: string;
  budgetQuota: number;
  committedQuota: number;
  pendingQuota: number;
  consumedQuota: number;
  version: number;
  configuredByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type DepartmentBudgetCommitment = {
  id: string;
  departmentBudgetPeriodId: string;
  departmentId: string;
  requestId: string;
  packageVersionId: string;
  grantId?: string;
  quota: number;
  state: "reserved" | "committed" | "released";
  idempotencyKey: string;
  createdAt: string;
  committedAt?: string;
  releasedAt?: string;
};

export type RequestBillingContext = {
  id: string;
  sourceIdentity?: string;
  proxyRequestId?: string;
  userId: string;
  departmentIdAtRequest: string;
  tokenAccountId: string;
  keyGeneration: number;
  candidateGrantIds: string[];
  startedAt: string;
  finalizedAt?: string;
};

export type UsageChargeAllocation = {
  id: string;
  sourceIdentity: string;
  requestBillingContextId: string;
  userId: string;
  departmentIdAtRequest: string;
  packageGrantId: string;
  quota: number;
  occurredAt: string;
  stabilizedAt: string;
  idempotencyKey: string;
};

export type BillingOperationType =
  | "first_grant"
  | "regrant"
  | "admin_grant"
  | "grant_revoke"
  | "key_rotation"
  | "usage_allocation"
  | "watermark_reconcile";

export type BillingOperationState =
  | "planned"
  | "budget_reserved"
  | "grant_committed"
  | "upstream_applying"
  | "upstream_applied"
  | "completed"
  | "retryable_failed"
  | "compensating"
  | "compensated"
  | "manual_review";

export type BillingOperation = {
  id: string;
  operationType: BillingOperationType;
  userId: string;
  departmentId: string;
  state: BillingOperationState;
  idempotencyKey: string;
  requestPayloadHash: string;
  currentStep: string;
  leaseOwner?: string;
  leaseUntil?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type QuotaDisplayType = "USD" | "CNY" | "CUSTOM" | "RAW_QUOTA";

export type NewApiQuotaDisplaySnapshot = {
  configVersion: string;
  quotaPerUnit: number;
  displayInCurrency: boolean;
  displayType: QuotaDisplayType;
  usdExchangeRate: number;
  customCurrencySymbol: string;
  customCurrencyExchangeRate: number;
  fetchedAt: string;
  sourceStatus: "current" | "stale" | "unavailable";
};

export type DisplayQuota = {
  rawQuota: number;
  display: {
    formatted: string;
    unitLabel: string;
    displayType: QuotaDisplayType;
    configVersion: string;
  };
};
