export type ClientDisplayQuota = {
  rawQuota: number;
  display: {
    formatted: string;
    unitLabel: string;
    displayType: "USD" | "CNY" | "CUSTOM" | "RAW_QUOTA";
    configVersion: string;
  };
};

export type ClientPackageGrant = {
  id: string;
  status: "active" | "exhausted" | "expired" | "revoked";
  snapshot: {
    packageCode: string;
    packageName: string;
    packageDescription: string;
    version: number;
    cycleType: "calendar_month" | "calendar_quarter" | "fixed_days";
    cycleValue: number;
  };
  grantedQuota: number;
  allocatedQuota: number;
  startsAt: string;
  expiresAt: string;
  granted: ClientDisplayQuota;
  allocated: ClientDisplayQuota;
  available: ClientDisplayQuota;
};

export type ClientPackageRequest = {
  id: string;
  requestKind: "first" | "regrant" | "admin_grant";
  status: string;
  reason: string;
  packageVersionId: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type ClientBillingOperation = {
  id: string;
  operationType: string;
  state: string;
  currentStep: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type ClientPackageMe = {
  balance: {
    grantedQuota: number;
    allocatedQuota: number;
    availableQuota: number;
    granted: ClientDisplayQuota;
    allocated: ClientDisplayQuota;
    available: ClientDisplayQuota;
  };
  grants: ClientPackageGrant[];
  requests: ClientPackageRequest[];
  operations: ClientBillingOperation[];
  quotaDisplay: {
    configVersion: string;
    sourceStatus: "current" | "stale" | "unavailable";
    fetchedAt: string;
  };
};

export type ClientAvailablePackage = {
  assignment: {
    id: string;
    isDefault: boolean;
  };
  definition: {
    id: string;
    code: string;
    name: string;
    description: string;
    ownerScopeType: "global" | "department";
  };
  version: {
    id: string;
    version: number;
    grantedQuota: number;
    cycleType: "calendar_month" | "calendar_quarter" | "fixed_days";
    cycleValue: number;
    regrantPolicy: {
      mode: "exhausted" | "remaining_ratio" | "remaining_quota" | "near_expiry";
      thresholdRatio?: number;
      thresholdQuota?: number;
      nearExpiryHours?: number;
    };
  };
  quota: ClientDisplayQuota;
};
