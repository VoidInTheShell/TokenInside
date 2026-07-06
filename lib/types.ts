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

export type FeishuUser = {
  id: string;
  tenantKey: string;
  openId: string;
  unionId?: string;
  feishuUserIdFromFeishu?: string;
  name?: string;
  avatarUrl?: string;
  departmentId?: string;
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
  statusCode: number;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  clientIp?: string;
  userAgent?: string;
  createdAt: string;
};

export type UserBillingPeriod = {
  id: string;
  feishuUserId: string;
  period: string;
  monthlyQuota: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  proxyLogCount: number;
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
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
};

export type AppSettings = {
  defaultMonthlyQuota: number;
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
  adminScopes: AdminScope[];
};
