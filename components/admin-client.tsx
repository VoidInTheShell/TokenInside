"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeftIcon,
  BarChart3Icon,
  Building2Icon,
  CheckCircle2Icon,
  ClipboardListIcon,
  GaugeIcon,
  LoaderCircleIcon,
  MenuIcon,
  RefreshCwIcon,
  SaveIcon,
  SendIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  UserCogIcon,
  UsersRoundIcon,
  XCircleIcon,
  XIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FeishuSdkScript, loginWithFeishu } from "@/components/feishu-login";
import { LoginWaitingScreen } from "@/components/login-waiting-screen";
import {
  UsageRecordsTable,
  type UsageOption,
  type UsageRecordRow,
  type UsageRecordFiltersState,
} from "@/components/usage-records-table";
import {
  UsageAnalysisTable,
  type UsageAggregateRow,
} from "@/components/usage-analysis-tables";
import { PageSelector } from "@/components/page-selector";
import { formatDateTime, formatDepartmentName, formatQuotaAmount, formatTokenAmount, maskSecret } from "@/lib/utils";
import {
  tokenRequestAllowsQuotaEdit,
  tokenRequestRequiresAdminDecision,
} from "@/lib/token-request-policy";

type AdminScopeSummary = {
  type: "global" | "department";
  departmentId?: string;
  departmentName?: string;
  source: "manual" | "department_supervisor" | "environment";
  role?: "root";
};

type AdminScopeRecord = {
  id: string;
  feishuUserId: string;
  scopeType: "global" | "department";
  departmentId?: string;
  departmentName?: string;
  source: "manual" | "department_supervisor" | "environment";
  role?: "root";
  status: "active" | "disabled";
  disabledReason?: "manual_revoke" | "user_deleted" | "auto_sync_lost";
  disabledByFeishuUserId?: string;
  disabledAt?: string;
  configuredOpenId?: string;
  readonly?: boolean;
  user?: {
    id: string;
    name?: string;
    openId?: string;
    departmentId?: string;
    departmentName?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
};

type BillingOperationRecord = {
  id: string;
  kind: "usage_sync" | "monthly_reset" | "settings_update";
  status: "dry_run" | "applied" | "partial_failed" | "failed";
  dryRun: boolean;
  operatedByFeishuUserId: string;
  period?: string;
  input?: Record<string, unknown>;
  summary: Record<string, string | number | boolean | undefined>;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

type AdminTokenRequestRow = {
  id: string;
  requestType: string;
  status: string;
  reason: string;
  requestedMonthlyQuota: number;
  approvedMonthlyQuota?: number;
  approvalInstanceCode?: string;
  approvalTargetSource?: string;
  approvalTargetOpenId?: string;
  approvalCardMessageId?: string;
  approvalOperatorOpenId?: string;
  approvalOperatedAt?: string;
  tokenAccountId?: string;
  errorMessage?: string;
  requesterName?: string;
  requesterOpenId?: string;
  departmentId?: string;
  departmentName?: string;
  updatedAt: string;
  createdAt: string;
};

type AdminOverviewResponse = {
  authenticated: boolean;
  authorized: boolean;
  error?: string;
  user?: {
    id: string;
    name?: string;
    avatarUrl?: string;
    tenantKey: string;
    openId: string;
    departmentId?: string;
    departmentName?: string;
  };
  overview?: {
    scope: AdminScopeSummary;
    totals: {
      users: number;
      keyedUsers?: number;
      tokenRequests: number;
      pendingRequests: number;
      provisionedRequests: number;
      failedRequests: number;
      activeTokens: number;
      proxyLogs: number;
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      currentBillingPeriod?: string;
      currentPeriodMonthlyQuota?: number;
      currentPeriodQuotaConsumed?: number;
      currentPeriodCost?: number;
      currentPeriodRemainingQuota?: number;
      currentPeriodUsageRecords?: number;
      currentPeriodProxyLogs?: number;
      currentPeriodPromptTokens?: number;
      currentPeriodCompletionTokens?: number;
      currentPeriodTotalTokens?: number;
    };
    latestRequests: AdminTokenRequestRow[];
  };
  settings?: {
    defaultMonthlyQuota: number;
    usageSyncPolicy?: {
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
      lastRunStatus?: BillingOperationRecord["status"];
      lastRunMessage?: string;
      lastRunBy?: "manual" | "auto";
      nextRunAfter?: string;
    };
    usageSyncCheckpoint?: {
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
      lastRunStatus?: BillingOperationRecord["status"];
      lastRunBy?: "manual" | "auto";
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
    } | null;
    billingOperations?: BillingOperationRecord[];
    quotaFeatureFlags?: QuotaControlResponse["settings"]["quotaFeatureFlags"];
    quotaMigration?: QuotaControlResponse["settings"]["quotaMigration"];
    updatedAt?: string;
  };
};

type AdminPanel =
  | "overview"
  | "users"
  | "departmentQuota"
  | "departmentStats"
  | "userStats"
  | "usageRecords"
  | "quotaControl"
  | "approvals"
  | "settings";

type AdminUser = {
  id: string;
  name?: string;
  openId: string;
  departmentId?: string;
  departmentName?: string;
  status: "active" | "disabled" | "deleted";
  role: string;
  activeTokenStatus?: string;
  activeTokenCreatedAt?: string;
  billingPeriod?: string;
  billingMonthlyQuota?: number;
  billingRemainingQuota?: number;
  billingQuotaConsumed?: number;
  billingCost?: number;
  billingTotalTokens?: number;
  billingPromptTokens?: number;
  billingCompletionTokens?: number;
  billingProxyLogCount?: number;
  billingUsageRecordCount?: number;
  latestRequestStatus?: string;
  latestRequestType?: string;
  latestRequestUpdatedAt?: string;
  latestProxyLogAt?: string;
  updatedAt: string;
  createdAt: string;
};

type AdminUsersResponse = {
  users: AdminUser[];
  error?: string;
};

type AdminScopesResponse = {
  admins: AdminScopeRecord[];
  error?: string;
};

type UserStatsRow = {
  id: string;
  name?: string;
  openId: string;
  departmentId?: string;
  departmentName?: string;
  role: string;
  activeTokenStatus?: string;
  billingPeriod?: string;
  monthlyQuota: number;
  remainingQuota?: number;
  quotaConsumed: number;
  cost: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  proxyLogCount: number;
  usageRecordCount: number;
  quotaUsageRate: number;
  latestProxyLogAt?: string;
};

type UserStatsResponse = {
  stats: UserStatsRow[];
  error?: string;
};

type DepartmentStatsRow = {
  departmentId: string;
  departmentName?: string;
  memberCount: number;
  keyedUsers: number;
  monthlyQuota: number;
  remainingQuota: number;
  quotaConsumed: number;
  cost: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  proxyLogCount: number;
  usageRecordCount: number;
  usageShare: number;
  quotaUsageRate: number;
  latestProxyLogAt?: string;
};

type DepartmentStatsResponse = {
  departments: DepartmentStatsRow[];
  error?: string;
};

type DepartmentQuotaSummary = {
  id: string;
  departmentId: string;
  departmentName?: string;
  period: string;
  quotaLimit: number;
  defaultGrantQuota: number;
  allocatedQuota: number;
  pendingReservedQuota: number;
  availableQuota: number;
  quotaConsumed: number;
  remainingQuota: number;
  memberCount: number;
  keyedUsers: number;
  prewarmedKeys: number;
  updatedAt: string;
};

type DepartmentQuotaRequestRow = {
  id: string;
  departmentId: string;
  departmentName?: string;
  period: string;
  action: "increase" | "reset";
  status: string;
  reason: string;
  currentQuotaLimit: number;
  requestedQuotaLimit: number;
  approvedQuotaLimit?: number;
  requesterName?: string;
  requesterOpenId?: string;
  approvalCardMessageId?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

type DepartmentQuotaResponse = {
  period: string;
  departments: DepartmentQuotaSummary[];
  requests: DepartmentQuotaRequestRow[];
  recentEvents: Array<{
    id: string;
    departmentId: string;
    kind: string;
    status: string;
    previousValue: number;
    nextValue: number;
    updatedAt: string;
  }>;
  error?: string;
};

type UsageRecordsResponse = {
  records: UsageRecordRow[];
  total?: number;
  limit?: number;
  offset?: number;
  filters?: {
    users?: Array<{ id: string; name?: string; openId?: string; departmentId?: string; departmentName?: string }>;
    departments?: Array<{ id: string; name?: string }>;
    models?: string[];
    providers?: string[];
    apiFormats?: string[];
    clientFamilies?: string[];
    userAgents?: string[];
  };
  modelStats?: UsageAggregateRow[];
  departmentStats?: UsageAggregateRow[];
  apiFormatStats?: UsageAggregateRow[];
  error?: string;
};

type AdminTokenRequestsResponse = {
  requests: AdminTokenRequestRow[];
  total?: number;
  limit?: number;
  offset?: number;
  error?: string;
};

type UsageSyncDraft = {
  page: string;
  size: string;
  maxPages: string;
  overlapMinutes: string;
  matchWindowMinutes: string;
};

type UsageSyncPolicyDraft = {
  enabled: boolean;
  intervalMinutes: string;
  pageSize: string;
  maxPagesPerRun: string;
  overlapMinutes: string;
  settlementLagMinutes: string;
  matchWindowMinutes: string;
  retryBaseMinutes: string;
};

type MonthlyResetDraft = {
  period: string;
  limit: string;
};

type UsageSyncResult = {
  dryRun: boolean;
  pageStart: number;
  size: number;
  maxPages: number;
  totals: {
    fetched: number;
    seen: number;
    matched: number;
    updated: number;
    skippedUnknownToken: number;
    skippedNoMatch: number;
    recordsUpserted: number;
    issuesUpserted: number;
  };
};

type MonthlyResetResult = {
  period: string;
  dryRun: boolean;
  blocked: boolean;
  blockers: Array<{ type: string; message: string }>;
  departments: Array<{
    departmentId: string;
    budgetQuota: number;
    assignedQuota: number;
    blocked: boolean;
    alreadyOpenedUsers?: number;
    users: Array<{ feishuUserId: string }>;
  }>;
  operations?: Array<{ id: string; state: string }>;
};

type QuotaControlResponse = {
  quotaPerUnit: number;
  report: {
    period: string;
    observedUpstream: boolean;
    settledThrough?: string;
    totals: {
      users: number;
      healthy: number;
      excessUpstream: number;
      deficitUpstream: number;
      provisional: number;
    };
    rows: Array<{
      feishuUserId: string;
      userName?: string;
      departmentId?: string;
      tokenAccountId?: string;
      assignedMonthlyQuota: number;
      authorizedQuota: number;
      authoritativeConsumedQuota: number;
      expectedAvailableQuota: number;
      overageQuota: number;
      observedRemainQuota?: number;
      delta?: number;
      observedStable: boolean;
      status: "healthy" | "excess_upstream" | "deficit_upstream" | "provisional" | "manual_review";
      activeGeneration: number;
      settledThrough?: string;
    }>;
  };
  operations: Array<{
    id: string;
    operationType: string;
    feishuUserId: string;
    state: string;
    attemptCount: number;
    operationGeneration: number;
    targetRemainQuota?: number;
    observedRemainBefore?: number;
    lastErrorMessage?: string;
    nextRetryAt?: string;
    updatedAt: string;
  }>;
  ledgerEntries: Array<{
    id: string;
    operationId: string;
    feishuUserId: string;
    entryType: string;
    signedQuota: number;
    quotaValue: number;
    estimated?: boolean;
    createdAt: string;
  }>;
  reconciliationRecords: Array<{
    id: string;
    feishuUserId: string;
    status: string;
    delta?: number;
    updatedAt: string;
  }>;
  settings: {
    quotaFeatureFlags?: {
      legacyAbsoluteQuotaWritesEnabled: boolean;
      quotaLedgerShadowRead: boolean;
      quotaSagaWritesEnabled: boolean;
      keyRotationSagaEnabled: boolean;
      quotaRestoreEnabled: boolean;
      monthlyPeriodOpenEnabled: boolean;
      reconciliationAutoDecreaseEnabled: boolean;
      reconciliationAutoIncreaseEnabled: boolean;
    };
    quotaMigration?: {
      period: string;
      appliedAt: string;
      planHash: string;
      users: number;
      estimatedUsers: number;
    };
  };
  error?: string;
};

const statusLabel: Record<string, string> = {
  pending_card_send: "发送审批卡片中",
  pending_card_approval: "卡片审批中",
  approval_card_send_failed: "审批卡片发送失败",
  approval_route_failed: "审批路由失败",
  pending_feishu_approval: "飞书审批中",
  approved: "审批通过",
  approved_provisioning: "发放中",
  approved_provision_failed: "发放失败",
  provisioned: "已发放",
  rejected: "已拒绝",
  cancelled: "已取消",
  invalidated: "其他请求已通过",
  draft_pending_approval_config: "待配置审批",
};

const requestTypeLabel: Record<string, string> = {
  first_apply: "首次申请",
  quota_reset: "额度重置",
  key_reset: "Key 更换",
  quota_adjust: "额度调整",
  monthly_reset: "月度重置",
};

const userStatusLabel: Record<AdminUser["status"], string> = {
  active: "正常",
  disabled: "已禁用",
  deleted: "需重新申请",
};

function badgeVariant(status?: string) {
  if (!status) return "default";
  if (["active", "provisioned", "approved"].includes(status)) return "success";
  if (
    ["deleted", "disabled", "rejected", "cancelled", "invalidated", "approved_provision_failed"].includes(
      status,
    )
  ) {
    return "danger";
  }
  return "warning";
}

function scopeLabel(scope?: AdminScopeSummary) {
  if (!scope) return "无管理范围";
  if (scope.role === "root") return "root 管理员";
  if (scope.type === "global") return "系统管理员";
  return "部门管理";
}

function adminScopeLabel(scope: AdminScopeRecord) {
  if (scope.role === "root") return "root 管理员";
  if (scope.scopeType === "global") return "系统管理员";
  return "部门管理员";
}

const adminScopeSourceLabel: Record<AdminScopeRecord["source"], string> = {
  manual: "手动指派",
  department_supervisor: "部门主管同步",
  environment: "环境变量 root",
};

const adminScopeDisabledReasonLabel: Record<NonNullable<AdminScopeRecord["disabledReason"]>, string> = {
  manual_revoke: "root 取消",
  user_deleted: "用户删除",
  auto_sync_lost: "主管变更",
};

function displayName(user?: AdminOverviewResponse["user"]) {
  return user?.name || maskSecret(user?.openId) || "-";
}

function avatarInitial(user?: AdminOverviewResponse["user"]) {
  return displayName(user).trim().slice(0, 1).toUpperCase() || "T";
}

function canEditQuota(request: { requestType: string; status: string }) {
  return tokenRequestAllowsQuotaEdit(request);
}

function canDecideRequest(request: { requestType: string; status: string }) {
  return tokenRequestRequiresAdminDecision(request);
}

function formatRate(value?: number) {
  if (!Number.isFinite(value)) return "-";
  return `${Math.round((value ?? 0) * 1000) / 10}%`;
}

function currentBillingPeriod() {
  return new Date().toISOString().slice(0, 7);
}

function parseIntegerDraft(value: string, label: string, input: { min: number; max?: number }) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < input.min || (input.max !== undefined && parsed > input.max)) {
    throw new Error(
      input.max === undefined
        ? `${label}必须是不小于 ${input.min} 的整数`
        : `${label}必须是 ${input.min}-${input.max} 的整数`,
    );
  }
  return parsed;
}

function billingKindLabel(kind: BillingOperationRecord["kind"]) {
  if (kind === "usage_sync") return "用量同步";
  if (kind === "monthly_reset") return "月度重置";
  return "设置变更";
}

function billingStatusLabel(status: BillingOperationRecord["status"]) {
  if (status === "dry_run") return "试算";
  if (status === "partial_failed") return "部分失败";
  if (status === "failed") return "失败";
  return "已执行";
}

function billingStatusVariant(status: BillingOperationRecord["status"]) {
  if (status === "applied") return "success";
  if (status === "failed" || status === "partial_failed") return "danger";
  return "warning";
}

function quotaReconciliationLabel(status: string) {
  if (status === "healthy") return "一致";
  if (status === "excess_upstream") return "上游多余额";
  if (status === "deficit_upstream") return "上游少余额";
  if (status === "manual_review") return "人工处置";
  return "暂定数据";
}

function quotaReconciliationVariant(status: string) {
  if (status === "healthy") return "success";
  if (status === "deficit_upstream" || status === "manual_review") return "danger";
  return "warning";
}

function quotaOperationVariant(state: string) {
  if (state === "completed") return "success";
  if (state === "manual_review" || state === "compensated") return "danger";
  return "warning";
}

function billingSummaryText(operation: BillingOperationRecord) {
  const summary = operation.summary ?? {};
  if (operation.kind === "usage_sync") {
    return `取回 ${summary.fetched ?? 0}，匹配 ${summary.matched ?? 0}，更新 ${summary.updated ?? 0}，记录 ${summary.recordsUpserted ?? 0}，异常 ${summary.issuesUpserted ?? 0}`;
  }
  if (operation.kind === "settings_update") {
    return `默认额度 ${summary.previousDefaultMonthlyQuota ?? "-"} -> ${summary.defaultMonthlyQuota ?? "-"}${summary.usageSyncPolicyUpdated ? "，同步策略已更新" : ""}`;
  }
  return `计划 ${summary.planned ?? 0}，应用 ${summary.applied ?? 0}，失败 ${summary.failed ?? 0}`;
}

function usageSyncDraftSignature(draft: UsageSyncDraft) {
  return JSON.stringify({
    page: draft.page.trim(),
    size: draft.size.trim(),
    maxPages: draft.maxPages.trim(),
    overlapMinutes: draft.overlapMinutes.trim(),
    matchWindowMinutes: draft.matchWindowMinutes.trim(),
  });
}

function monthlyResetDraftSignature(draft: MonthlyResetDraft) {
  return JSON.stringify({
    period: draft.period.trim(),
    limit: draft.limit.trim(),
  });
}

async function readJsonResponse<T>(res: Response): Promise<T & { error?: string }> {
  const text = await res.text();
  if (!text.trim()) return {} as T & { error?: string };
  try {
    return JSON.parse(text) as T & { error?: string };
  } catch {
    return { error: text } as T & { error?: string };
  }
}

function appendUsageParam(params: URLSearchParams, key: string, value?: string) {
  if (!value || value === "__all__") return;
  params.set(key, value);
}

export function AdminClient() {
  const [data, setData] = useState<AdminOverviewResponse | null>(null);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [adminScopes, setAdminScopes] = useState<AdminScopeRecord[]>([]);
  const [userStats, setUserStats] = useState<UserStatsRow[]>([]);
  const [departmentStats, setDepartmentStats] = useState<DepartmentStatsRow[]>([]);
  const [departmentQuotaData, setDepartmentQuotaData] =
    useState<DepartmentQuotaResponse | null>(null);
  const [quotaControlData, setQuotaControlData] =
    useState<QuotaControlResponse | null>(null);
  const [departmentPolicyDrafts, setDepartmentPolicyDrafts] = useState<
    Record<string, { quotaLimit: string; defaultGrantQuota: string }>
  >({});
  const [departmentQuotaRequestDrafts, setDepartmentQuotaRequestDrafts] = useState<
    Record<string, string>
  >({});
  const [departmentQuotaRequestAction, setDepartmentQuotaRequestAction] =
    useState<"increase" | "reset">("increase");
  const [departmentQuotaRequestLimit, setDepartmentQuotaRequestLimit] = useState("");
  const [departmentQuotaRequestReason, setDepartmentQuotaRequestReason] = useState("");
  const [prewarmKeysOnMemberSync, setPrewarmKeysOnMemberSync] = useState(false);
  const [prewarmingDepartmentId, setPrewarmingDepartmentId] = useState<string | null>(null);
  const [approvalRequests, setApprovalRequests] = useState<AdminTokenRequestRow[]>([]);
  const [approvalTotalRequests, setApprovalTotalRequests] = useState(0);
  const [usageRecords, setUsageRecords] = useState<UsageRecordRow[]>([]);
  const [usageModelStats, setUsageModelStats] = useState<UsageAggregateRow[]>([]);
  const [usageDepartmentStats, setUsageDepartmentStats] = useState<UsageAggregateRow[]>([]);
  const [usageApiFormatStats, setUsageApiFormatStats] = useState<UsageAggregateRow[]>([]);
  const [usageTotalRecords, setUsageTotalRecords] = useState(0);
  const [usagePage, setUsagePage] = useState(1);
  const [usagePageSize, setUsagePageSize] = useState(20);
  const [usageStatsExpanded, setUsageStatsExpanded] = useState(true);
  const [usageAutoRefresh, setUsageAutoRefresh] = useState(true);
  const [usageHideUnknownRecords, setUsageHideUnknownRecords] = useState(false);
  const [usageFilters, setUsageFilters] = useState<UsageRecordFiltersState>({
    preset: "today",
    search: "",
    userId: "__all__",
    departmentId: "__all__",
    model: "__all__",
    apiFormat: "__all__",
    status: "__all__",
    userAgent: "__all__",
  });
  const [usageFilterOptions, setUsageFilterOptions] = useState<{
    users: UsageOption[];
    departments: UsageOption[];
    models: string[];
    apiFormats: string[];
    userAgents: string[];
  }>({
    users: [],
    departments: [],
    models: [],
    apiFormats: [],
    userAgents: [],
  });
  const [loading, setLoading] = useState(true);
  const [panelLoading, setPanelLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [panel, setPanel] = useState<AdminPanel>("overview");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [defaultQuotaDraft, setDefaultQuotaDraft] = useState("200");
  const [usageSyncDraft, setUsageSyncDraft] = useState({
    page: "0",
    size: "100",
    maxPages: "1",
    overlapMinutes: "120",
    matchWindowMinutes: "30",
  } satisfies UsageSyncDraft);
  const [usageSyncPolicyDraft, setUsageSyncPolicyDraft] = useState<UsageSyncPolicyDraft>({
    enabled: true,
    intervalMinutes: "60",
    pageSize: "100",
    maxPagesPerRun: "3",
    overlapMinutes: "120",
    settlementLagMinutes: "5",
    matchWindowMinutes: "30",
    retryBaseMinutes: "5",
  });
  const [quotaFeatureDraft, setQuotaFeatureDraft] = useState({
    quotaLedgerShadowRead: true,
    quotaSagaWritesEnabled: false,
    keyRotationSagaEnabled: false,
    quotaRestoreEnabled: false,
    monthlyPeriodOpenEnabled: false,
    reconciliationAutoDecreaseEnabled: false,
  });
  const [monthlyResetDraft, setMonthlyResetDraft] = useState({
    period: currentBillingPeriod(),
    limit: "",
  } satisfies MonthlyResetDraft);
  const [billingResult, setBillingResult] = useState<string | null>(null);
  const [lastUsageSyncDryRunSignature, setLastUsageSyncDryRunSignature] = useState<string | null>(null);
  const [lastUsageSyncDryRunSummary, setLastUsageSyncDryRunSummary] = useState<string | null>(null);
  const [lastMonthlyResetDryRunSignature, setLastMonthlyResetDryRunSignature] = useState<string | null>(null);
  const [lastMonthlyResetDryRunSummary, setLastMonthlyResetDryRunSummary] = useState<string | null>(null);
  const [quotaDrafts, setQuotaDrafts] = useState<Record<string, string>>({});
  const [adminUsersPage, setAdminUsersPage] = useState(1);
  const [adminUsersPageSize, setAdminUsersPageSize] = useState(10);
  const [approvalPage, setApprovalPage] = useState(1);
  const [approvalPageSize, setApprovalPageSize] = useState(10);
  const [adminTargetOpenId, setAdminTargetOpenId] = useState("");
  const [adminDepartmentId, setAdminDepartmentId] = useState("");
  const [feishuSdkReady, setFeishuSdkReady] = useState(false);
  const [autoLoginAttempted, setAutoLoginAttempted] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/overview?mode=soft", { cache: "no-store" });
      const body = await readJsonResponse<AdminOverviewResponse>(res);
      setData(body);
      if (body.settings) {
        setDefaultQuotaDraft(String(body.settings.defaultMonthlyQuota));
        const policy = body.settings.usageSyncPolicy;
        if (policy) {
          setUsageSyncPolicyDraft({
            enabled: Boolean(policy.enabled),
            intervalMinutes: String(policy.intervalMinutes ?? 60),
            pageSize: String(policy.pageSize ?? 100),
            maxPagesPerRun: String(policy.maxPagesPerRun ?? 3),
            overlapMinutes: String(policy.overlapMinutes ?? 120),
            settlementLagMinutes: String(policy.settlementLagMinutes ?? 5),
            matchWindowMinutes: String(policy.matchWindowMinutes ?? 30),
            retryBaseMinutes: String(policy.retryBaseMinutes ?? 5),
          });
          setUsageSyncDraft((current) => ({
            ...current,
            size: String(policy.pageSize ?? current.size),
            maxPages: String(policy.maxPagesPerRun ?? current.maxPages),
            overlapMinutes: String(policy.overlapMinutes ?? current.overlapMinutes),
            matchWindowMinutes: String(policy.matchWindowMinutes ?? current.matchWindowMinutes),
          }));
        }
        const quotaFlags = body.settings.quotaFeatureFlags;
        if (quotaFlags) {
          setQuotaFeatureDraft({
            quotaLedgerShadowRead: Boolean(quotaFlags.quotaLedgerShadowRead),
            quotaSagaWritesEnabled: Boolean(quotaFlags.quotaSagaWritesEnabled),
            keyRotationSagaEnabled: Boolean(quotaFlags.keyRotationSagaEnabled),
            quotaRestoreEnabled: Boolean(quotaFlags.quotaRestoreEnabled),
            monthlyPeriodOpenEnabled: Boolean(quotaFlags.monthlyPeriodOpenEnabled),
            reconciliationAutoDecreaseEnabled: Boolean(
              quotaFlags.reconciliationAutoDecreaseEnabled,
            ),
          });
        }
      }
      if (body.overview?.latestRequests) {
        setQuotaDrafts((current) => ({
          ...Object.fromEntries(
            body.overview!.latestRequests.map((request) => [
              request.id,
              current[request.id] ?? String(request.approvedMonthlyQuota ?? request.requestedMonthlyQuota),
            ]),
          ),
          ...current,
        }));
      }
      if (!res.ok || (body.error && body.authenticated)) {
        setError(body.error ?? "读取管理概览失败");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取管理概览失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAdminUsers = useCallback(async () => {
    setPanelLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/users", { cache: "no-store" });
      const body = await readJsonResponse<AdminUsersResponse>(res);
      if (!res.ok) throw new Error(body.error ?? "读取用户管理失败");
      setAdminUsers(body.users);
      setQuotaDrafts((current) => ({
        ...Object.fromEntries(
          body.users.map((user) => [
            user.id,
            current[user.id] ?? String(user.billingMonthlyQuota ?? ""),
          ]),
        ),
        ...current,
      }));
      setAdminUsersPage(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取用户管理失败");
    } finally {
      setPanelLoading(false);
    }
  }, []);

  const loadAdminScopes = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/admins", { cache: "no-store" });
      const body = await readJsonResponse<AdminScopesResponse>(res);
      if (!res.ok) throw new Error(body.error ?? "读取管理员范围失败");
      setAdminScopes(body.admins);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取管理员范围失败");
    }
  }, []);

  const loadUserStats = useCallback(async () => {
    setPanelLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/user-stats", { cache: "no-store" });
      const body = await readJsonResponse<UserStatsResponse>(res);
      if (!res.ok) throw new Error(body.error ?? "读取用户统计失败");
      setUserStats(body.stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取用户统计失败");
    } finally {
      setPanelLoading(false);
    }
  }, []);

  const loadDepartmentStats = useCallback(async () => {
    setPanelLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/department-stats", { cache: "no-store" });
      const body = await readJsonResponse<DepartmentStatsResponse>(res);
      if (!res.ok) throw new Error(body.error ?? "读取部门统计失败");
      setDepartmentStats(body.departments);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取部门统计失败");
    } finally {
      setPanelLoading(false);
    }
  }, []);

  const loadDepartmentQuota = useCallback(async () => {
    setPanelLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/department-quota", { cache: "no-store" });
      const body = await readJsonResponse<DepartmentQuotaResponse>(res);
      if (!res.ok) throw new Error(body.error ?? "读取部门额度失败");
      setDepartmentQuotaData(body);
      setDepartmentPolicyDrafts((current) => ({
        ...Object.fromEntries(
          body.departments.map((department) => [
            department.departmentId,
            current[department.departmentId] ?? {
              quotaLimit: String(department.quotaLimit),
              defaultGrantQuota: String(department.defaultGrantQuota),
            },
          ]),
        ),
        ...current,
      }));
      setDepartmentQuotaRequestDrafts((current) => ({
        ...Object.fromEntries(
          body.requests.map((quotaRequest) => [
            quotaRequest.id,
            current[quotaRequest.id] ??
              String(quotaRequest.approvedQuotaLimit ?? quotaRequest.requestedQuotaLimit),
          ]),
        ),
        ...current,
      }));
      if (body.departments.length === 1) {
        setDepartmentQuotaRequestLimit(
          (current) => current || String(body.departments[0].quotaLimit),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取部门额度失败");
    } finally {
      setPanelLoading(false);
    }
  }, []);

  const loadUsageRecords = useCallback(async (options: { quiet?: boolean } = {}) => {
    if (!options.quiet) setPanelLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(usagePageSize));
      params.set("offset", String((usagePage - 1) * usagePageSize));
      params.set("hideUnknownRecords", String(usageHideUnknownRecords));
      appendUsageParam(params, "preset", usageFilters.preset);
      appendUsageParam(params, "search", usageFilters.search);
      appendUsageParam(params, "userId", usageFilters.userId);
      appendUsageParam(params, "departmentId", usageFilters.departmentId);
      appendUsageParam(params, "model", usageFilters.model);
      appendUsageParam(params, "apiFormat", usageFilters.apiFormat);
      appendUsageParam(params, "status", usageFilters.status);
      appendUsageParam(params, "userAgent", usageFilters.userAgent);
      const res = await fetch(`/api/admin/usage-records?${params.toString()}`, { cache: "no-store" });
      const body = await readJsonResponse<UsageRecordsResponse>(res);
      if (!res.ok) throw new Error(body.error ?? "读取使用记录失败");
      setUsageRecords(body.records);
      setUsageTotalRecords(body.total ?? body.records.length);
      setUsageModelStats(body.modelStats ?? []);
      setUsageDepartmentStats(body.departmentStats ?? []);
      setUsageApiFormatStats(body.apiFormatStats ?? []);
      if (body.filters) {
        setUsageFilterOptions({
          users: (body.filters.users ?? []).map((user) => ({
            id: user.id,
            label: user.name ?? maskSecret(user.openId) ?? user.id,
          })),
          departments: (body.filters.departments ?? []).map((department) => ({
            id: department.id,
            label: formatDepartmentName(department.name, department.id),
          })),
          models: body.filters.models ?? [],
          apiFormats: body.filters.apiFormats ?? [],
          userAgents: body.filters.userAgents ?? [],
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取使用记录失败");
    } finally {
      if (!options.quiet) setPanelLoading(false);
    }
  }, [usageFilters, usageHideUnknownRecords, usagePage, usagePageSize]);

  const loadApprovalRequests = useCallback(async (options: { quiet?: boolean } = {}) => {
    if (!options.quiet) setPanelLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(approvalPageSize));
      params.set("offset", String((approvalPage - 1) * approvalPageSize));
      const res = await fetch(`/api/admin/token-requests?${params.toString()}`, { cache: "no-store" });
      const body = await readJsonResponse<AdminTokenRequestsResponse>(res);
      if (!res.ok) throw new Error(body.error ?? "读取审批申请失败");
      setApprovalRequests(body.requests);
      setApprovalTotalRequests(body.total ?? body.requests.length);
      setQuotaDrafts((current) => ({
        ...Object.fromEntries(
          body.requests.map((request) => [
            request.id,
            String(request.approvedMonthlyQuota ?? request.requestedMonthlyQuota),
          ]),
        ),
        ...current,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取审批申请失败");
    } finally {
      if (!options.quiet) setPanelLoading(false);
    }
  }, [approvalPage, approvalPageSize]);

  const loadQuotaControl = useCallback(async (observe = false) => {
    setPanelLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/quota-control?observe=${observe}`, {
        cache: "no-store",
      });
      const body = await readJsonResponse<QuotaControlResponse>(res);
      if (!res.ok) throw new Error(body.error ?? "读取额度一致性中心失败");
      setQuotaControlData(body);
      if (observe) setMessage("已完成 NewAPI 余额双读，仅生成影子对账结论。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取额度一致性中心失败");
    } finally {
      setPanelLoading(false);
    }
  }, []);

  const runQuotaControlAction = useCallback(async (body: Record<string, string>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/quota-control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const response = await readJsonResponse<{ operation?: { id: string } }>(res);
      if (!res.ok) throw new Error(response.error ?? "额度操作提交失败");
      setMessage(`额度操作已受理${response.operation?.id ? `：${response.operation.id}` : ""}`);
      await loadQuotaControl(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "额度操作提交失败");
    } finally {
      setBusy(false);
    }
  }, [loadQuotaControl]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const overview = data?.overview;
  const totals = overview?.totals;
  const isSystemAdmin = overview?.scope.type === "global";
  const isRootAdmin = overview?.scope.role === "root";

  useEffect(() => {
    if (!data?.authorized) return;
    if (panel === "users") {
      void loadAdminUsers();
      if (isSystemAdmin) void loadAdminScopes();
    }
    if (panel === "userStats") void loadUserStats();
    if (panel === "departmentQuota") void loadDepartmentQuota();
    if (panel === "departmentStats" && isSystemAdmin) void loadDepartmentStats();
    if (panel === "usageRecords") void loadUsageRecords();
    if (panel === "quotaControl") void loadQuotaControl(false);
    if (panel === "approvals") void loadApprovalRequests();
  }, [
    data?.authorized,
    isSystemAdmin,
    loadApprovalRequests,
    loadAdminScopes,
    loadAdminUsers,
    loadDepartmentStats,
    loadDepartmentQuota,
    loadQuotaControl,
    loadUsageRecords,
    loadUserStats,
    panel,
  ]);

  useEffect(() => {
    setUsagePage(1);
  }, [usageFilters, usageHideUnknownRecords, usagePageSize]);

  useEffect(() => {
    if (!data?.authorized || panel !== "usageRecords" || !usageAutoRefresh) return;
    const timer = window.setInterval(() => {
      void loadUsageRecords({ quiet: true });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [data?.authorized, loadUsageRecords, panel, usageAutoRefresh]);

  const connectFeishu = useCallback(async () => {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const result = await loginWithFeishu();
      setMessage(
        result.method === "requestAuthCode"
          ? "已通过飞书身份自动登录（兼容模式）。"
          : "已通过飞书身份自动登录。",
      );
      if (result.redirectTo !== window.location.pathname) {
        window.location.replace(result.redirectTo);
        return;
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "飞书登录失败");
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  useEffect(() => {
    if (loading || busy || autoLoginAttempted || !feishuSdkReady || data?.authenticated) {
      return;
    }
    setAutoLoginAttempted(true);
    void connectFeishu();
  }, [autoLoginAttempted, busy, connectFeishu, data?.authenticated, feishuSdkReady, loading]);

  async function saveDefaultQuota() {
    const defaultMonthlyQuota = Number(defaultQuotaDraft);
    if (!Number.isInteger(defaultMonthlyQuota) || defaultMonthlyQuota <= 0) {
      setError("默认额度必须是正整数");
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaultMonthlyQuota }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "保存默认额度失败");
      setMessage("默认额度已保存。");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存默认额度失败");
    } finally {
      setBusy(false);
    }
  }

  async function saveUsageSyncPolicy() {
    try {
      const intervalMinutes = parseIntegerDraft(usageSyncPolicyDraft.intervalMinutes, "自动同步周期", {
        min: 1,
        max: 24 * 60,
      });
      const pageSize = parseIntegerDraft(usageSyncPolicyDraft.pageSize, "自动同步每页数量", {
        min: 1,
        max: 100,
      });
      const maxPagesPerRun = parseIntegerDraft(usageSyncPolicyDraft.maxPagesPerRun, "自动同步最大页数", {
        min: 1,
        max: 20,
      });
      const overlapMinutes = parseIntegerDraft(usageSyncPolicyDraft.overlapMinutes, "自动同步重叠窗口", {
        min: 0,
        max: 7 * 24 * 60,
      });
      const matchWindowMinutes = parseIntegerDraft(usageSyncPolicyDraft.matchWindowMinutes, "自动同步匹配窗口", {
        min: 1,
        max: 24 * 60,
      });
      const settlementLagMinutes = parseIntegerDraft(
        usageSyncPolicyDraft.settlementLagMinutes,
        "自动同步结算延迟",
        { min: 0, max: 24 * 60 },
      );
      const retryBaseMinutes = parseIntegerDraft(
        usageSyncPolicyDraft.retryBaseMinutes,
        "自动同步重试基数",
        { min: 1, max: 24 * 60 },
      );

      setBusy(true);
      setError(null);
      setMessage(null);
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          usageSyncPolicy: {
            enabled: usageSyncPolicyDraft.enabled,
            intervalMinutes,
            pageSize,
            maxPagesPerRun,
            overlapMinutes,
            settlementLagMinutes,
            matchWindowMinutes,
            retryBaseMinutes,
          },
        }),
      });
      const body = await readJsonResponse<AdminOverviewResponse>(res);
      if (!res.ok) throw new Error(body.error ?? "保存自动同步策略失败");
      setMessage("自动同步策略已保存。");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存自动同步策略失败");
    } finally {
      setBusy(false);
    }
  }

  async function saveQuotaFeatureFlags() {
    if (
      !data?.settings?.quotaMigration &&
      (quotaFeatureDraft.quotaSagaWritesEnabled ||
        quotaFeatureDraft.keyRotationSagaEnabled ||
        quotaFeatureDraft.quotaRestoreEnabled ||
        quotaFeatureDraft.monthlyPeriodOpenEnabled ||
        quotaFeatureDraft.reconciliationAutoDecreaseEnabled)
    ) {
      setError("历史额度账本迁移未登记，不能启用 F 阶段写功能");
      return;
    }
    if (
      !quotaFeatureDraft.quotaSagaWritesEnabled &&
      (quotaFeatureDraft.keyRotationSagaEnabled ||
        quotaFeatureDraft.quotaRestoreEnabled ||
        quotaFeatureDraft.monthlyPeriodOpenEnabled ||
        quotaFeatureDraft.reconciliationAutoDecreaseEnabled)
    ) {
      setError("启用具体额度动作前必须先启用统一 Saga 写入");
      return;
    }
    if (
      !window.confirm(
        "确认保存 F 阶段功能开关？自动向上补额始终保持关闭；启用写功能前应完成影子对账。",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          quotaFeatureFlags: {
            legacyAbsoluteQuotaWritesEnabled: false,
            ...quotaFeatureDraft,
            reconciliationAutoIncreaseEnabled: false,
          },
        }),
      });
      const body = await readJsonResponse<AdminOverviewResponse>(res);
      if (!res.ok) throw new Error(body.error ?? "保存额度功能开关失败");
      setMessage("F 阶段功能开关已保存；自动向上补额保持关闭。");
      await Promise.all([refresh(), loadQuotaControl(false)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存额度功能开关失败");
    } finally {
      setBusy(false);
    }
  }

  async function runUsageSync(dryRun: boolean) {
    try {
      const signature = usageSyncDraftSignature(usageSyncDraft);
      const page = parseIntegerDraft(usageSyncDraft.page, "起始页", { min: 0 });
      const size = parseIntegerDraft(usageSyncDraft.size, "每页数量", { min: 1, max: 100 });
      const maxPages = parseIntegerDraft(usageSyncDraft.maxPages, "最大页数", { min: 1, max: 20 });
      const overlapMinutes = parseIntegerDraft(usageSyncDraft.overlapMinutes, "重叠窗口", {
        min: 0,
        max: 7 * 24 * 60,
      });
      const matchWindowMinutes = parseIntegerDraft(usageSyncDraft.matchWindowMinutes, "匹配窗口", {
        min: 1,
        max: 24 * 60,
      });
      if (!dryRun && lastUsageSyncDryRunSignature !== signature) {
        throw new Error("执行同步前必须先用相同参数完成一次试算同步");
      }
      if (
        !dryRun &&
        !window.confirm(
          `确认把 NewAPI 日志回填到 TokenInside 使用记录？\n${lastUsageSyncDryRunSummary ?? ""}`,
        )
      ) {
        return;
      }

      setBusy(true);
      setError(null);
      setMessage(null);
      setBillingResult(null);
      const res = await fetch("/api/admin/usage-sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dryRun,
          page,
          size,
          maxPages,
          overlapMinutes,
          matchWindowMinutes,
        }),
      });
      const body = await readJsonResponse<UsageSyncResult>(res);
      if (!res.ok) throw new Error(body.error ?? "同步 NewAPI 用量失败");
      const summary = `取回 ${body.totals.fetched}，匹配 ${body.totals.matched}，更新 ${body.totals.updated}，记录 ${body.totals.recordsUpserted}，异常 ${body.totals.issuesUpserted}，未绑定 ${body.totals.skippedUnknownToken}，未匹配 ${body.totals.skippedNoMatch}`;
      setBillingResult(`NewAPI 用量${dryRun ? "试算" : "同步"}完成：${summary}`);
      setMessage(`NewAPI 用量${dryRun ? "试算" : "同步"}完成。`);
      if (dryRun) {
        setLastUsageSyncDryRunSignature(signature);
        setLastUsageSyncDryRunSummary(summary);
      } else {
        setLastUsageSyncDryRunSignature(null);
        setLastUsageSyncDryRunSummary(null);
      }
      await Promise.all([refresh(), loadUsageRecords({ quiet: true })]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "同步 NewAPI 用量失败");
    } finally {
      setBusy(false);
    }
  }

  async function runMonthlyReset(dryRun: boolean) {
    try {
      const signature = monthlyResetDraftSignature(monthlyResetDraft);
      const period = monthlyResetDraft.period.trim();
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
        throw new Error("账期必须是 YYYY-MM");
      }
      const limit = monthlyResetDraft.limit.trim()
        ? parseIntegerDraft(monthlyResetDraft.limit, "处理上限", { min: 1, max: 500 })
        : undefined;
      if (!dryRun && lastMonthlyResetDryRunSignature !== signature) {
        throw new Error("执行月度开账前必须先用相同参数完成一次 preflight");
      }
      if (
        !dryRun &&
        !window.confirm(
          `确认执行 ${period} 月度开账？\n${lastMonthlyResetDryRunSummary ?? ""}`,
        )
      ) {
        return;
      }

      setBusy(true);
      setError(null);
      setMessage(null);
      setBillingResult(null);
      const res = await fetch("/api/admin/billing/monthly-reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dryRun,
          period,
          limit,
        }),
      });
      const body = await readJsonResponse<MonthlyResetResult>(res);
      if (!res.ok) throw new Error(body.error ?? "月度开账失败");
      const plannedUsers = body.departments.reduce((sum, item) => sum + item.users.length, 0);
      const alreadyOpenedUsers = body.departments.reduce(
        (sum, item) => sum + (item.alreadyOpenedUsers ?? 0),
        0,
      );
      const summary = `部门 ${body.departments.length}，待开账用户 ${plannedUsers}，已开账跳过 ${alreadyOpenedUsers}，阻塞 ${body.blockers.length}，已受理操作 ${body.operations?.length ?? 0}`;
      setBillingResult(`${body.period} 月度开账${dryRun ? " preflight" : "执行"}：${summary}`);
      setMessage(`月度开账${dryRun ? " preflight" : "操作创建"}完成。`);
      if (dryRun) {
        setLastMonthlyResetDryRunSignature(signature);
        setLastMonthlyResetDryRunSummary(summary);
      } else {
        setLastMonthlyResetDryRunSignature(null);
        setLastMonthlyResetDryRunSummary(null);
      }
      await Promise.all([refresh(), loadAdminUsers(), loadUserStats()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "月度开账失败");
    } finally {
      setBusy(false);
    }
  }

  async function saveRequestQuota(requestId: string) {
    const approvedMonthlyQuota = Number(quotaDrafts[requestId]);
    if (!Number.isInteger(approvedMonthlyQuota) || approvedMonthlyQuota <= 0) {
      setError("最终额度必须是正整数");
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/token-requests/${encodeURIComponent(requestId)}/quota`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvedMonthlyQuota }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "保存最终额度失败");
      setMessage("最终额度已保存。");
      await Promise.all([refresh(), loadApprovalRequests({ quiet: true })]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存最终额度失败");
    } finally {
      setBusy(false);
    }
  }

  async function decideRequest(requestId: string, action: "approve" | "reject") {
    const approvedMonthlyQuota = Number(quotaDrafts[requestId]);
    if (action === "approve" && (!Number.isInteger(approvedMonthlyQuota) || approvedMonthlyQuota <= 0)) {
      setError("通过审批前需要填写正整数最终额度");
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/token-requests/${encodeURIComponent(requestId)}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          approvedMonthlyQuota: action === "approve" ? approvedMonthlyQuota : undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "处理审批失败");
      setMessage(action === "approve" ? "审批已通过，已触发发放。" : "申请已拒绝。");
      await Promise.all([refresh(), loadAdminUsers(), loadApprovalRequests({ quiet: true })]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "处理审批失败");
    } finally {
      setBusy(false);
    }
  }

  async function adjustUserQuota(userId: string) {
    const approvedMonthlyQuota = Number(quotaDrafts[userId]);
    if (!Number.isInteger(approvedMonthlyQuota) || approvedMonthlyQuota <= 0) {
      setError("调额额度必须是正整数");
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/quota-adjust`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          approvedMonthlyQuota,
          reason: `管理后台调额为 ${approvedMonthlyQuota}`,
          clientRequestId: window.crypto.randomUUID(),
        }),
      });
      const body = await res.json().catch(() => ({})) as {
        error?: string;
        mode?: "first_provision" | "quota_adjust";
      };
      if (!res.ok) throw new Error(body.error ?? "调额失败");
      setMessage(
        body.mode === "first_provision"
          ? "首次 Key 与额度已完成发放。"
          : "账本化调额已受理；仅在申请状态变为“已发放”后生效。",
      );
      await Promise.all([refresh(), loadAdminUsers(), loadUserStats(), loadDepartmentQuota()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "调额失败");
    } finally {
      setBusy(false);
    }
  }

  async function saveDepartmentPolicy(
    departmentId: string,
    field: "quotaLimit" | "defaultGrantQuota",
  ) {
    const draft = departmentPolicyDrafts[departmentId];
    const value = Number(draft?.[field]);
    if (!Number.isInteger(value) || value < (field === "quotaLimit" ? 0 : 1)) {
      setError(field === "quotaLimit" ? "部门额度上限必须是非负整数" : "默认发放额度必须是正整数");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/department-quota", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          departmentId,
          [field]: value,
        }),
      });
      const body = await readJsonResponse<{ department?: DepartmentQuotaSummary }>(res);
      if (!res.ok) throw new Error(body.error ?? "保存部门额度设置失败");
      setMessage(field === "quotaLimit" ? "部门额度上限已保存。" : "部门默认发放额度已保存。");
      await loadDepartmentQuota();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存部门额度设置失败");
    } finally {
      setBusy(false);
    }
  }

  async function submitDepartmentQuotaRequest() {
    const requestedQuotaLimit = Number(departmentQuotaRequestLimit);
    if (!Number.isInteger(requestedQuotaLimit) || requestedQuotaLimit < 0) {
      setError("申请的部门额度上限必须是非负整数");
      return;
    }
    if (departmentQuotaRequestReason.trim().length < 4) {
      setError("请填写至少 4 个字符的申请说明");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/department-quota/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: departmentQuotaRequestAction,
          requestedQuotaLimit,
          reason: departmentQuotaRequestReason.trim(),
        }),
      });
      const body = await readJsonResponse<{ notice?: string }>(res);
      if (!res.ok) throw new Error(body.error ?? "提交部门额度申请失败");
      setMessage(body.notice ?? "部门额度申请已提交。");
      setDepartmentQuotaRequestReason("");
      await loadDepartmentQuota();
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交部门额度申请失败");
    } finally {
      setBusy(false);
    }
  }

  async function decideDepartmentQuota(
    requestId: string,
    action: "approve" | "reject",
  ) {
    const approvedQuotaLimit = Number(departmentQuotaRequestDrafts[requestId]);
    if (action === "approve" && (!Number.isInteger(approvedQuotaLimit) || approvedQuotaLimit < 0)) {
      setError("通过部门额度申请前需要填写非负整数额度上限");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(
        `/api/admin/department-quota/requests/${encodeURIComponent(requestId)}/decision`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action,
            approvedQuotaLimit: action === "approve" ? approvedQuotaLimit : undefined,
          }),
        },
      );
      const body = await readJsonResponse<Record<string, unknown>>(res);
      if (!res.ok) throw new Error(body.error ?? "处理部门额度申请失败");
      setMessage(action === "approve" ? "部门额度申请已通过并更新预算。" : "部门额度申请已拒绝。");
      await loadDepartmentQuota();
    } catch (err) {
      setError(err instanceof Error ? err.message : "处理部门额度申请失败");
    } finally {
      setBusy(false);
    }
  }

  async function syncDepartmentMembers(departmentId: string) {
    setBusy(true);
    if (prewarmKeysOnMemberSync) setPrewarmingDepartmentId(departmentId);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/departments/sync-members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ departmentId, prewarmKeys: prewarmKeysOnMemberSync }),
      });
      const body = await readJsonResponse<{
        synced?: number;
        skipped?: number;
        prewarm?: {
          eligible?: number;
          prewarmed?: number;
          skippedAfterRace?: number;
          failed?: number;
          capped?: boolean;
          error?: string;
        };
      }>(res);
      if (!res.ok) throw new Error(body.error ?? "同步部门成员失败");
      const syncNotice = `已同步 ${body.synced ?? 0} 位部门成员${body.skipped ? `，跳过 ${body.skipped} 条无 open_id 记录` : ""}`;
      if (body.prewarm?.error) {
        setMessage(`${syncNotice}。`);
        setError(`成员同步成功，但 Key 预热失败：${body.prewarm.error}`);
      } else if (body.prewarm) {
        setMessage(
          `${syncNotice}；新增预热 Key ${body.prewarm.prewarmed ?? 0} 个${body.prewarm.skippedAfterRace ? `，竞态跳过 ${body.prewarm.skippedAfterRace} 个` : ""}${body.prewarm.failed ? `，失败回收 ${body.prewarm.failed} 个` : ""}${body.prewarm.capped ? "，本批已达 100 个上限" : ""}。`,
        );
      } else {
        setMessage(`${syncNotice}。`);
      }
      await Promise.all([loadAdminUsers(), loadDepartmentQuota()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "同步部门成员失败");
    } finally {
      setPrewarmingDepartmentId(null);
      setBusy(false);
    }
  }

  async function assignAdmin(scopeType: "global" | "department") {
    if (scopeType === "global" && !isRootAdmin) {
      setError("只有 root 管理员可以指派系统管理员");
      return;
    }
    if (!adminTargetOpenId.trim()) {
      setError("需要填写目标用户 open_id");
      return;
    }
    if (scopeType === "department" && !adminDepartmentId.trim()) {
      setError("指派部门管理员需要填写 departmentId");
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/admins", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetOpenId: adminTargetOpenId.trim(),
          scopeType,
          departmentId: scopeType === "department" ? adminDepartmentId.trim() : undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "指派管理员失败");
      setMessage("管理员已指派。");
      setAdminTargetOpenId("");
      setAdminDepartmentId("");
      await Promise.all([loadAdminUsers(), loadAdminScopes(), refresh()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "指派管理员失败");
    } finally {
      setBusy(false);
    }
  }

  async function cancelAdmin(scope: AdminScopeRecord) {
    const target = scope.user?.name ?? maskSecret(scope.user?.openId ?? scope.configuredOpenId) ?? scope.id;
    if (!window.confirm(`确认取消 ${target} 的${adminScopeLabel(scope)}权限？`)) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/admins/${encodeURIComponent(scope.id)}`, {
        method: "DELETE",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "取消管理员失败");
      setMessage("管理员权限已取消。");
      await Promise.all([loadAdminScopes(), loadAdminUsers(), refresh()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "取消管理员失败");
    } finally {
      setBusy(false);
    }
  }

  async function disableUser(user: AdminUser) {
    if (!window.confirm(`确认禁用 ${user.name ?? maskSecret(user.openId)} 的 active key？`)) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}/disable`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "管理后台禁用用户 active key" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "禁用用户失败");
      setMessage("用户 active key 已禁用。");
      await Promise.all([refresh(), loadAdminUsers(), loadUserStats()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "禁用用户失败");
    } finally {
      setBusy(false);
    }
  }

  async function enableUser(user: AdminUser) {
    if (!window.confirm(`确认启用 ${user.name ?? maskSecret(user.openId)} 的 key？`)) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}/enable`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "管理后台启用用户 key" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "启用用户失败");
      setMessage("用户 key 已启用。");
      await Promise.all([refresh(), loadAdminUsers(), loadUserStats()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "启用用户失败");
    } finally {
      setBusy(false);
    }
  }

  async function deleteUser(user: AdminUser) {
    if (!window.confirm(`确认删除 ${user.name ?? maskSecret(user.openId)}？删除后用户需要重新发起申请。`)) {
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "管理后台删除用户，需重新申请" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "删除用户失败");
      setMessage("用户已删除，历史记录已保留，重新使用需再次申请。");
      await Promise.all([refresh(), loadAdminUsers(), loadUserStats()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除用户失败");
    } finally {
      setBusy(false);
    }
  }

  function selectPanel(nextPanel: AdminPanel) {
    setPanel(nextPanel);
    setMobileNavOpen(false);
  }

  const adminUsersPageCount = Math.max(Math.ceil(adminUsers.length / adminUsersPageSize), 1);
  const currentAdminUsersPage = Math.min(adminUsersPage, adminUsersPageCount);
  const pagedAdminUsers = adminUsers.slice(
    (currentAdminUsersPage - 1) * adminUsersPageSize,
    currentAdminUsersPage * adminUsersPageSize,
  );
  const approvalPageCount = Math.max(Math.ceil(approvalTotalRequests / approvalPageSize), 1);
  const currentApprovalPage = Math.min(approvalPage, approvalPageCount);
  const usageSyncReadyToExecute =
    lastUsageSyncDryRunSignature === usageSyncDraftSignature(usageSyncDraft);
  const monthlyResetReadyToExecute =
    lastMonthlyResetDryRunSignature === monthlyResetDraftSignature(monthlyResetDraft);
  const usageSyncPolicy = data?.settings?.usageSyncPolicy;
  const usageSyncCheckpoint = data?.settings?.usageSyncCheckpoint;
  const quotaPerUnit = quotaControlData?.quotaPerUnit ?? 500000;

  const loginInProgress = loading || (!data?.authenticated && busy);

  if (loginInProgress) {
    return (
      <>
        <FeishuSdkScript
          onReady={() => setFeishuSdkReady(true)}
          onError={(sdkError) => setError(sdkError)}
        />
        <LoginWaitingScreen />
      </>
    );
  }

  if (!loading && data && !data.authorized) {
    return (
      <>
        <FeishuSdkScript
          onReady={() => setFeishuSdkReady(true)}
          onError={(sdkError) => setError(sdkError)}
        />
        <div className="app-shell">
          <main className="main-panel">
            <Card>
              <CardHeader>
                <CardTitle>管理权限已收回</CardTitle>
                <CardDescription>{data.error ?? "当前飞书用户没有启用的管理范围。"}</CardDescription>
              </CardHeader>
              <CardContent>
                {error && <div className="alert alert-danger">{error}</div>}
                {message && <div className="alert">{message}</div>}
                <div className="toolbar toolbar-left">
                  <a className="button button-outline" href="/">
                    回到用户后台
                  </a>
                  {!data.authenticated && (
                    <Button variant="outline" disabled={busy} onClick={() => void connectFeishu()}>
                      飞书登录
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          </main>
        </div>
      </>
    );
  }

  return (
    <>
      <FeishuSdkScript
        onReady={() => setFeishuSdkReady(true)}
        onError={(sdkError) => setError(sdkError)}
      />
      <div className="app-shell">
        <aside className={mobileNavOpen ? "sidebar sidebar-open" : "sidebar"}>
          <div className="sidebar-head">
            <div className="brand">
              <Image
                className="brand-mark"
                src="/icon.svg"
                alt=""
                aria-hidden="true"
                width={36}
                height={36}
                priority
              />
              <div>
                <h1 className="brand-title">TokenInside</h1>
                <p className="brand-subtitle">共绩科技</p>
              </div>
            </div>
            <button
              className="sidebar-toggle"
              type="button"
              aria-label={mobileNavOpen ? "收起菜单" : "展开菜单"}
              aria-expanded={mobileNavOpen}
              onClick={() => setMobileNavOpen((open) => !open)}
            >
              {mobileNavOpen ? <XIcon /> : <MenuIcon />}
            </button>
          </div>

          <div className="sidebar-menu">
            <nav className="nav-list" aria-label="管理后台菜单">
              <button
                className={panel === "overview" ? "nav-item active nav-button" : "nav-item nav-button"}
                type="button"
                onClick={() => selectPanel("overview")}
              >
                <GaugeIcon data-icon="inline-start" />
                概览
              </button>
              <button
                className={panel === "users" ? "nav-item active nav-button" : "nav-item nav-button"}
                type="button"
                onClick={() => selectPanel("users")}
              >
                <UsersRoundIcon data-icon="inline-start" />
                用户管理
              </button>
              <button
                className={
                  panel === "departmentQuota" ? "nav-item active nav-button" : "nav-item nav-button"
                }
                type="button"
                onClick={() => selectPanel("departmentQuota")}
              >
                <Building2Icon data-icon="inline-start" />
                部门额度
              </button>
              {isSystemAdmin && (
                <button
                  className={
                    panel === "departmentStats" ? "nav-item active nav-button" : "nav-item nav-button"
                  }
                  type="button"
                  onClick={() => selectPanel("departmentStats")}
                >
                  <Building2Icon data-icon="inline-start" />
                  部门统计
                </button>
              )}
              <button
                className={panel === "userStats" ? "nav-item active nav-button" : "nav-item nav-button"}
                type="button"
                onClick={() => selectPanel("userStats")}
              >
                <BarChart3Icon data-icon="inline-start" />
                用户统计
              </button>
              <button
                className={panel === "usageRecords" ? "nav-item active nav-button" : "nav-item nav-button"}
                type="button"
                onClick={() => selectPanel("usageRecords")}
              >
                <ClipboardListIcon data-icon="inline-start" />
                使用记录
              </button>
              <button
                className={panel === "quotaControl" ? "nav-item active nav-button" : "nav-item nav-button"}
                type="button"
                onClick={() => selectPanel("quotaControl")}
              >
                <GaugeIcon data-icon="inline-start" />
                额度一致性
              </button>
              <button
                className={panel === "approvals" ? "nav-item active nav-button" : "nav-item nav-button"}
                type="button"
                onClick={() => selectPanel("approvals")}
              >
                <CheckCircle2Icon data-icon="inline-start" />
                审批处理
              </button>
              {isSystemAdmin && (
                <button
                  className={panel === "settings" ? "nav-item active nav-button" : "nav-item nav-button"}
                  type="button"
                  onClick={() => selectPanel("settings")}
                >
                  <SlidersHorizontalIcon data-icon="inline-start" />
                  系统设置
                </button>
              )}
            </nav>
          </div>
        </aside>

        <main className="main">
          <header className="topbar">
            <div>
              <h2 className="page-title">TokenInside 管理后台</h2>
              <p className="page-description">用户、额度、管理员、统计和调用记录统一工作台。</p>
            </div>
            <a className="button button-outline" href="/">
              <ArrowLeftIcon data-icon="inline-start" />
              返回控制台
            </a>
          </header>

          <Card>
            <CardContent>
              <div className="user-card">
                <div className="user-avatar" aria-hidden="true">
                  {data?.user?.avatarUrl ? (
                    <img src={data.user.avatarUrl} alt="" />
                  ) : (
                    <span>{avatarInitial(data?.user)}</span>
                  )}
                </div>
                <div className="user-card-main">
                  <span className="user-card-label">当前飞书用户</span>
                  <strong>{data?.authenticated ? displayName(data.user) : "等待飞书身份"}</strong>
                </div>
                <div className="user-card-meta">
                  <span>管理范围</span>
                  <strong>{scopeLabel(overview?.scope)}</strong>
                </div>
                <div className="user-card-controls">
                  <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={busy}>
                    <RefreshCwIcon data-icon="inline-start" />
                    刷新
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {error && <div className="alert alert-danger">{error}</div>}
          {message && <div className="alert">{message}</div>}

          {panel === "overview" && (
            <>
              <section className="metric-grid" aria-label="管理概览数据">
                <Card>
                  <CardContent>
                    <div className="metric">
                      <span className="metric-label">总用户数</span>
                      <span className="metric-value">{totals?.keyedUsers ?? totals?.activeTokens ?? 0}</span>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent>
                    <div className="metric">
                      <span className="metric-label">待审批</span>
                      <span className="metric-value">{totals?.pendingRequests ?? 0}</span>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent>
                    <div className="metric">
                      <span className="metric-label">active key</span>
                      <span className="metric-value">{totals?.activeTokens ?? 0}</span>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent>
                    <div className="metric">
                      <span className="metric-label">代理请求</span>
                      <span className="metric-value">{totals?.proxyLogs ?? 0}</span>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent>
                    <div className="metric">
                      <span className="metric-label">总 tokens</span>
                      <span className="metric-value">{formatTokenAmount(totals?.totalTokens, "0")}</span>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent>
                    <div className="metric">
                      <span className="metric-label">当前账期 tokens</span>
                      <span className="metric-value">{formatTokenAmount(totals?.currentPeriodTotalTokens, "0")}</span>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent>
                    <div className="metric">
                      <span className="metric-label">当前账期发放额度</span>
                      <span className="metric-value">{formatQuotaAmount(totals?.currentPeriodMonthlyQuota, "0")}</span>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent>
                    <div className="metric">
                      <span className="metric-label">当前账期已用额度</span>
                      <span className="metric-value">{formatQuotaAmount(totals?.currentPeriodQuotaConsumed, "0")}</span>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent>
                    <div className="metric">
                      <span className="metric-label">当前账期剩余额度</span>
                      <span className="metric-value">{formatQuotaAmount(totals?.currentPeriodRemainingQuota, "0")}</span>
                    </div>
                  </CardContent>
                </Card>
              </section>
            </>
          )}

          {panel === "users" && (
            <section className="grid">
              {isSystemAdmin && (
                <Card>
                  <CardHeader>
                    <CardTitle>指派管理员</CardTitle>
                    <CardDescription>从用户行选择 open_id，也可以手动输入。</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="field-group">
                      <div className="field">
                        <label htmlFor="adminTargetOpenId">目标 open_id</label>
                        <Input
                          id="adminTargetOpenId"
                          value={adminTargetOpenId}
                          onChange={(event) => setAdminTargetOpenId(event.target.value)}
                          disabled={busy}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="adminDepartmentId">部门 departmentId</label>
                        <Input
                          id="adminDepartmentId"
                          value={adminDepartmentId}
                          onChange={(event) => setAdminDepartmentId(event.target.value)}
                          disabled={busy}
                          placeholder="仅部门管理员需要"
                        />
                      </div>
                      <div className="toolbar toolbar-left">
                        {isRootAdmin && (
                          <Button variant="outline" disabled={busy} onClick={() => void assignAdmin("global")}>
                            <ShieldCheckIcon data-icon="inline-start" />
                            指派系统管理员
                          </Button>
                        )}
                        <Button variant="outline" disabled={busy} onClick={() => void assignAdmin("department")}>
                          <UserCogIcon data-icon="inline-start" />
                          指派部门管理员
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader>
                  <CardTitle>用户管理</CardTitle>
                  <CardDescription>
                    调整额度、指派管理员、禁用和删除都在这里处理。部门管理员只能看到本部门下属用户。
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="toolbar toolbar-left">
                    <Button variant="outline" size="sm" disabled={panelLoading} onClick={() => void loadAdminUsers()}>
                      <RefreshCwIcon data-icon="inline-start" />
                      刷新用户
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => selectPanel("approvals")}>
                      <CheckCircle2Icon data-icon="inline-start" />
                      审批处理
                    </Button>
                    <Badge>{adminUsers.length} 个用户</Badge>
                    {adminUsers.length > 0 && (
                      <Badge>
                        第 {currentAdminUsersPage} / {adminUsersPageCount} 页
                      </Badge>
                    )}
                  </div>
                  {!adminUsers.length ? (
                    <div className="empty">{panelLoading ? "读取用户中" : "暂无用户"}</div>
                  ) : (
                    <>
                      <div className="table-wrap table-scroll table-scroll-users">
                        <table className="table admin-users-table">
                          <colgroup>
                            <col className="admin-users-col-user" />
                            <col className="admin-users-col-department" />
                            <col className="admin-users-col-status" />
                            <col className="admin-users-col-role" />
                            <col className="admin-users-col-quota" />
                            <col className="admin-users-col-quota" />
                            <col className="admin-users-col-quota" />
                            <col className="admin-users-col-tokens" />
                            <col className="admin-users-col-latest" />
                            <col className="admin-users-col-actions" />
                          </colgroup>
                          <thead>
                            <tr>
                              <th>用户</th>
                              <th>部门</th>
                              <th>状态</th>
                              <th>角色</th>
                              <th>发放额度</th>
                              <th>剩余额度</th>
                              <th>已用额度</th>
                              <th>Tokens</th>
                              <th>最近调用</th>
                              <th>操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pagedAdminUsers.map((user) => (
                              <tr key={user.id}>
                                <td>
                                  <div className="meta-stack">
                                    <strong>{user.name ?? maskSecret(user.openId)}</strong>
                                    <span>{maskSecret(user.openId)}</span>
                                  </div>
                                </td>
                                <td>{formatDepartmentName(user.departmentName, user.departmentId)}</td>
                                <td>
                                  <Badge variant={badgeVariant(user.status)}>{userStatusLabel[user.status]}</Badge>
                                </td>
                                <td>{user.role}</td>
                                <td>{formatQuotaAmount(user.billingMonthlyQuota)}</td>
                                <td>{formatQuotaAmount(user.billingRemainingQuota)}</td>
                                <td>{formatQuotaAmount(user.billingQuotaConsumed, "0")}</td>
                                <td>{formatTokenAmount(user.billingTotalTokens, "0")}</td>
                                <td>{user.latestProxyLogAt ? formatDateTime(user.latestProxyLogAt) : "-"}</td>
                                <td>
                                  <div className="user-management-actions">
                                    <div className="user-management-action-primary">
                                      <div className="quota-control">
                                        <Input
                                          min={1}
                                          step={1}
                                          type="number"
                                          value={quotaDrafts[user.id] ?? ""}
                                          placeholder="额度"
                                          onChange={(event) =>
                                            setQuotaDrafts((current) => ({
                                              ...current,
                                              [user.id]: event.target.value,
                                            }))
                                          }
                                          disabled={busy || user.status !== "active"}
                                        />
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          disabled={busy || user.status !== "active"}
                                          onClick={() => void adjustUserQuota(user.id)}
                                        >
                                          分配
                                        </Button>
                                      </div>
                                    </div>
                                    <div className="user-management-status-actions">
                                      {isSystemAdmin && (
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          disabled={busy}
                                          onClick={() => {
                                            setAdminTargetOpenId(user.openId);
                                            setAdminDepartmentId(user.departmentId ?? "");
                                          }}
                                        >
                                          <UserCogIcon data-icon="inline-start" />
                                          指派
                                        </Button>
                                      )}
                                      {user.status === "disabled" ? (
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          disabled={busy || user.activeTokenStatus !== "disabled"}
                                          onClick={() => void enableUser(user)}
                                        >
                                          启用
                                        </Button>
                                      ) : (
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          disabled={busy || user.status !== "active" || user.activeTokenStatus !== "active"}
                                          onClick={() => void disableUser(user)}
                                        >
                                          禁用
                                        </Button>
                                      )}
                                      <Button variant="outline" size="sm" disabled={busy} onClick={() => void deleteUser(user)}>
                                        <Trash2Icon data-icon="inline-start" />
                                        删除
                                      </Button>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="usage-pagination">
                        <span>
                          第 {currentAdminUsersPage} / {adminUsersPageCount} 页，共 {adminUsers.length} 个用户
                        </span>
                        <div className="toolbar toolbar-left">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={currentAdminUsersPage <= 1 || panelLoading}
                            onClick={() => setAdminUsersPage(currentAdminUsersPage - 1)}
                          >
                            上一页
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={currentAdminUsersPage >= adminUsersPageCount || panelLoading}
                            onClick={() => setAdminUsersPage(currentAdminUsersPage + 1)}
                          >
                            下一页
                          </Button>
                          <select
                            className="input usage-select"
                            value={adminUsersPageSize}
                            onChange={(event) => {
                              setAdminUsersPageSize(Number(event.target.value));
                              setAdminUsersPage(1);
                            }}
                          >
                            {[10, 20, 50, 100].map((option) => (
                              <option key={option} value={option}>
                                {option} / 页
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              {isSystemAdmin && (
                <Card>
                  <CardHeader>
                    <CardTitle>管理员范围</CardTitle>
                    <CardDescription>
                      root 来自环境变量，系统管理员权限只能由 root 指派或取消。
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="toolbar toolbar-left">
                      <Button variant="outline" disabled={busy} onClick={() => void loadAdminScopes()}>
                        <RefreshCwIcon data-icon="inline-start" />
                        刷新管理员
                      </Button>
                      <Badge>{adminScopes.length} 条范围</Badge>
                    </div>
                    {!adminScopes.length ? (
                      <div className="empty">暂无管理员范围</div>
                    ) : (
                      <div className="table-wrap">
                        <table className="table">
                          <thead>
                            <tr>
                              <th>管理员</th>
                              <th>角色</th>
                              <th>来源</th>
                              <th>部门</th>
                              <th>状态</th>
                              <th>更新时间</th>
                              <th>操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {adminScopes.map((scope) => {
                              const canCancel =
                                !scope.readonly &&
                                scope.status === "active" &&
                                (scope.scopeType !== "global" || isRootAdmin);
                              return (
                                <tr key={scope.id}>
                                  <td>
                                    <div className="meta-stack">
                                      <strong>{scope.user?.name ?? maskSecret(scope.configuredOpenId) ?? "-"}</strong>
                                      <span>{maskSecret(scope.user?.openId ?? scope.configuredOpenId) ?? "-"}</span>
                                    </div>
                                  </td>
                                  <td>{adminScopeLabel(scope)}</td>
                                  <td>{adminScopeSourceLabel[scope.source]}</td>
                                  <td>
                                    {formatDepartmentName(
                                      scope.departmentName ?? scope.user?.departmentName,
                                      scope.departmentId,
                                    )}
                                  </td>
                                  <td>
                                    <div className="meta-stack">
                                      <Badge variant={badgeVariant(scope.status)}>
                                        {scope.status === "active" ? "启用" : "已取消"}
                                      </Badge>
                                      {scope.status === "disabled" && scope.disabledReason && (
                                        <span>{adminScopeDisabledReasonLabel[scope.disabledReason]}</span>
                                      )}
                                    </div>
                                  </td>
                                  <td>{formatDateTime(scope.updatedAt)}</td>
                                  <td>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      disabled={busy || !canCancel}
                                      onClick={() => void cancelAdmin(scope)}
                                    >
                                      <XCircleIcon data-icon="inline-start" />
                                      取消管理员
                                    </Button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

            </section>
          )}

          {panel === "departmentQuota" && (
            <section className="grid">
              <Card>
                <CardHeader>
                  <CardTitle>部门额度</CardTitle>
                  <CardDescription>
                    {isSystemAdmin
                      ? "设置每个部门的当期总额度上限与默认发放额度；已分配额度不能被新上限反向突破。"
                      : "查看本部门预算、配置默认发放额度，并在用户管理中为任意本部门成员（含自己）分配额度。"}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="toolbar toolbar-left">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={panelLoading || busy}
                      onClick={() => void loadDepartmentQuota()}
                    >
                      <RefreshCwIcon data-icon="inline-start" />
                      刷新额度
                    </Button>
                    <Badge>{departmentQuotaData?.period ?? currentBillingPeriod()}</Badge>
                    <Badge>{departmentQuotaData?.departments.length ?? 0} 个部门</Badge>
                    <label className="prewarm-option">
                      <input
                        type="checkbox"
                        checked={prewarmKeysOnMemberSync}
                        disabled={panelLoading || busy}
                        onChange={(event) => setPrewarmKeysOnMemberSync(event.target.checked)}
                      />
                      <span>同步后为无 Key 成员预热</span>
                    </label>
                  </div>
                  {!departmentQuotaData?.departments.length ? (
                    <div className="empty">{panelLoading ? "读取部门额度中" : "暂无可管理的部门额度"}</div>
                  ) : (
                    <div className="table-wrap">
                      <table className="table department-quota-table">
                        <colgroup>
                          <col className="department-quota-col-name" />
                          <col className="department-quota-col-members" />
                          <col className="department-quota-col-control" />
                          <col className="department-quota-col-number" />
                          <col className="department-quota-col-number" />
                          <col className="department-quota-col-number" />
                          <col className="department-quota-col-control" />
                          <col className="department-quota-col-action" />
                        </colgroup>
                        <thead>
                          <tr>
                            <th>部门</th>
                            <th>成员 / 已发 Key / 已预热</th>
                            <th>总额度上限</th>
                            <th>已分配</th>
                            <th>预留</th>
                            <th>可用</th>
                            <th>默认发放</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {departmentQuotaData.departments.map((department) => {
                            const draft = departmentPolicyDrafts[department.departmentId] ?? {
                              quotaLimit: String(department.quotaLimit),
                              defaultGrantQuota: String(department.defaultGrantQuota),
                            };
                            return (
                              <tr key={department.departmentId}>
                                <td>
                                  <div className="meta-stack">
                                    <strong>
                                      {formatDepartmentName(
                                        department.departmentName,
                                        department.departmentId,
                                      )}
                                    </strong>
                                    <span>{department.departmentId}</span>
                                  </div>
                                </td>
                                <td>
                                  {department.memberCount} / {department.keyedUsers} / {department.prewarmedKeys}
                                </td>
                                <td>
                                  {isSystemAdmin ? (
                                    <div className="quota-control quota-control-icon-action">
                                      <Input
                                        aria-label={`${department.departmentName ?? department.departmentId} 总额度上限`}
                                        min={0}
                                        max={1_000_000}
                                        step={1}
                                        type="number"
                                        value={draft.quotaLimit}
                                        disabled={busy}
                                        onChange={(event) =>
                                          setDepartmentPolicyDrafts((current) => ({
                                            ...current,
                                            [department.departmentId]: {
                                              ...draft,
                                              quotaLimit: event.target.value,
                                            },
                                          }))
                                        }
                                      />
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        aria-label="保存部门总额度上限"
                                        title="保存部门总额度上限"
                                        disabled={busy}
                                        onClick={() =>
                                          void saveDepartmentPolicy(department.departmentId, "quotaLimit")
                                        }
                                      >
                                        <SaveIcon data-icon="inline-start" />
                                      </Button>
                                    </div>
                                  ) : (
                                    formatQuotaAmount(department.quotaLimit, "0")
                                  )}
                                </td>
                                <td>{formatQuotaAmount(department.allocatedQuota, "0")}</td>
                                <td>{formatQuotaAmount(department.pendingReservedQuota, "0")}</td>
                                <td>{formatQuotaAmount(department.availableQuota, "0")}</td>
                                <td>
                                  <div className="quota-control quota-control-icon-action">
                                    <Input
                                      aria-label={`${department.departmentName ?? department.departmentId} 默认发放额度`}
                                      min={1}
                                      max={1_000_000}
                                      step={1}
                                      type="number"
                                      value={draft.defaultGrantQuota}
                                      disabled={busy}
                                      onChange={(event) =>
                                        setDepartmentPolicyDrafts((current) => ({
                                          ...current,
                                          [department.departmentId]: {
                                            ...draft,
                                            defaultGrantQuota: event.target.value,
                                          },
                                        }))
                                      }
                                    />
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      aria-label="保存部门默认发放额度"
                                      title="保存部门默认发放额度"
                                      disabled={busy}
                                      onClick={() =>
                                        void saveDepartmentPolicy(
                                          department.departmentId,
                                          "defaultGrantQuota",
                                        )
                                      }
                                    >
                                      <SaveIcon data-icon="inline-start" />
                                    </Button>
                                  </div>
                                </td>
                                <td>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() => void syncDepartmentMembers(department.departmentId)}
                                  >
                                    {prewarmingDepartmentId === department.departmentId ? (
                                      <LoaderCircleIcon className="spin-icon" data-icon="inline-start" />
                                    ) : (
                                      <RefreshCwIcon data-icon="inline-start" />
                                    )}
                                    {prewarmingDepartmentId === department.departmentId
                                      ? "正在预热…"
                                      : prewarmKeysOnMemberSync
                                        ? "同步并预热"
                                        : "同步成员"}
                                  </Button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>

              {!isSystemAdmin && (
                <Card>
                  <CardHeader>
                    <CardTitle>申请调整部门总额度</CardTitle>
                    <CardDescription>
                      申请固定发送给系统管理员。重置表示设置新的绝对上限，不会批量改写成员额度。
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="field-group">
                      <div className="field">
                        <label htmlFor="departmentQuotaRequestAction">申请动作</label>
                        <select
                          id="departmentQuotaRequestAction"
                          className="input"
                          value={departmentQuotaRequestAction}
                          disabled={busy}
                          onChange={(event) =>
                            setDepartmentQuotaRequestAction(
                              event.target.value as "increase" | "reset",
                            )
                          }
                        >
                          <option value="increase">提高部门总额度</option>
                          <option value="reset">重置部门总额度</option>
                        </select>
                      </div>
                      <div className="field">
                        <label htmlFor="departmentQuotaRequestLimit">申请后的总额度上限</label>
                        <Input
                          id="departmentQuotaRequestLimit"
                          min={0}
                          max={1_000_000}
                          step={1}
                          type="number"
                          value={departmentQuotaRequestLimit}
                          disabled={busy}
                          onChange={(event) => setDepartmentQuotaRequestLimit(event.target.value)}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="departmentQuotaRequestReason">申请说明</label>
                        <Textarea
                          id="departmentQuotaRequestReason"
                          value={departmentQuotaRequestReason}
                          disabled={busy}
                          placeholder="说明业务变化和需要调整额度的原因"
                          onChange={(event) => setDepartmentQuotaRequestReason(event.target.value)}
                        />
                      </div>
                      <div className="toolbar toolbar-left">
                        <Button disabled={busy} onClick={() => void submitDepartmentQuotaRequest()}>
                          <SendIcon data-icon="inline-start" />
                          发送给系统管理员
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader>
                  <CardTitle>部门额度申请记录</CardTitle>
                  <CardDescription>
                    {isSystemAdmin
                      ? "系统管理员在这里审批所有部门的总额度申请。"
                      : "这里显示本部门提交给系统管理员的额度申请及终态。"}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {!departmentQuotaData?.requests.length ? (
                    <div className="empty">暂无部门额度申请</div>
                  ) : (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>部门</th>
                            <th>申请人</th>
                            <th>动作</th>
                            <th>当前 / 申请</th>
                            <th>审批额度</th>
                            <th>状态</th>
                            <th>说明</th>
                            <th>更新时间</th>
                            {isSystemAdmin && <th>操作</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {departmentQuotaData.requests.map((quotaRequest) => {
                            const decidable = [
                              "pending_card_send",
                              "pending_card_approval",
                              "approval_card_send_failed",
                            ].includes(quotaRequest.status);
                            return (
                              <tr key={quotaRequest.id}>
                                <td>
                                  {formatDepartmentName(
                                    quotaRequest.departmentName,
                                    quotaRequest.departmentId,
                                  )}
                                </td>
                                <td>{quotaRequest.requesterName ?? maskSecret(quotaRequest.requesterOpenId)}</td>
                                <td>{quotaRequest.action === "increase" ? "提高" : "重置"}</td>
                                <td>
                                  {formatQuotaAmount(quotaRequest.currentQuotaLimit, "0")} / {formatQuotaAmount(quotaRequest.requestedQuotaLimit, "0")}
                                </td>
                                <td>
                                  {isSystemAdmin ? (
                                    <Input
                                      aria-label="部门审批额度"
                                      min={0}
                                      max={1_000_000}
                                      step={1}
                                      type="number"
                                      value={
                                        departmentQuotaRequestDrafts[quotaRequest.id] ??
                                        String(quotaRequest.requestedQuotaLimit)
                                      }
                                      disabled={!decidable || busy}
                                      onChange={(event) =>
                                        setDepartmentQuotaRequestDrafts((current) => ({
                                          ...current,
                                          [quotaRequest.id]: event.target.value,
                                        }))
                                      }
                                    />
                                  ) : (
                                    formatQuotaAmount(quotaRequest.approvedQuotaLimit, "-")
                                  )}
                                </td>
                                <td>
                                  <div className="meta-stack">
                                    <Badge variant={badgeVariant(quotaRequest.status)}>
                                      {statusLabel[quotaRequest.status] ?? quotaRequest.status}
                                    </Badge>
                                    {quotaRequest.errorMessage && (
                                      <span>{maskSecret(quotaRequest.errorMessage)}</span>
                                    )}
                                  </div>
                                </td>
                                <td>{quotaRequest.reason}</td>
                                <td>{formatDateTime(quotaRequest.updatedAt)}</td>
                                {isSystemAdmin && (
                                  <td>
                                    <div className="toolbar toolbar-left">
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={!decidable || busy}
                                        onClick={() =>
                                          void decideDepartmentQuota(quotaRequest.id, "approve")
                                        }
                                      >
                                        通过
                                      </Button>
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={!decidable || busy}
                                        onClick={() =>
                                          void decideDepartmentQuota(quotaRequest.id, "reject")
                                        }
                                      >
                                        拒绝
                                      </Button>
                                    </div>
                                  </td>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </section>
          )}

          {panel === "departmentStats" && isSystemAdmin && (
            <Card>
              <CardHeader>
                <CardTitle>部门统计</CardTitle>
                <CardDescription>仅系统管理员可见，展示部门当前账期和历史代理日志聚合。</CardDescription>
              </CardHeader>
              <CardContent>
                {!departmentStats.length ? (
                  <div className="empty">{panelLoading ? "读取部门统计中" : "暂无部门统计"}</div>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>部门</th>
                          <th>成员</th>
                          <th>key 用户</th>
                          <th>发放额度</th>
                          <th>剩余额度</th>
                          <th>已用额度</th>
                          <th>Tokens</th>
                          <th>请求数</th>
                          <th>用量占比</th>
                          <th>消耗率</th>
                          <th>最近调用</th>
                        </tr>
                      </thead>
                      <tbody>
                        {departmentStats.map((item) => (
                          <tr key={item.departmentId}>
                            <td>{formatDepartmentName(item.departmentName, item.departmentId, "未知部门")}</td>
                            <td>{item.memberCount}</td>
                            <td>{item.keyedUsers}</td>
                            <td>{formatQuotaAmount(item.monthlyQuota, "0")}</td>
                            <td>{formatQuotaAmount(item.remainingQuota, "0")}</td>
                            <td>{formatQuotaAmount(item.quotaConsumed, "0")}</td>
                            <td>{formatTokenAmount(item.totalTokens, "0")}</td>
                            <td>{item.proxyLogCount}</td>
                            <td>{formatRate(item.usageShare)}</td>
                            <td>{formatRate(item.quotaUsageRate)}</td>
                            <td>{item.latestProxyLogAt ? formatDateTime(item.latestProxyLogAt) : "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {panel === "userStats" && (
            <Card>
              <CardHeader>
                <CardTitle>用户统计</CardTitle>
                <CardDescription>
                  {isSystemAdmin ? "系统管理员查看全站用户统计。" : "部门管理员仅查看本部门下属用户统计。"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!userStats.length ? (
                  <div className="empty">{panelLoading ? "读取用户统计中" : "暂无用户统计"}</div>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>用户</th>
                          <th>部门</th>
                          <th>角色</th>
                          <th>账期</th>
                          <th>发放额度</th>
                          <th>剩余额度</th>
                          <th>已用额度</th>
                          <th>输入</th>
                          <th>输出</th>
                          <th>总量</th>
                          <th>请求数</th>
                          <th>消耗率</th>
                          <th>最近调用</th>
                        </tr>
                      </thead>
                      <tbody>
                        {userStats.map((user) => (
                          <tr key={user.id}>
                            <td>{user.name ?? maskSecret(user.openId)}</td>
                            <td>{formatDepartmentName(user.departmentName, user.departmentId)}</td>
                            <td>{user.role}</td>
                            <td>{user.billingPeriod ?? "-"}</td>
                            <td>{formatQuotaAmount(user.monthlyQuota, "0")}</td>
                            <td>{formatQuotaAmount(user.remainingQuota)}</td>
                            <td>{formatQuotaAmount(user.quotaConsumed, "0")}</td>
                            <td>{formatTokenAmount(user.promptTokens, "0")}</td>
                            <td>{formatTokenAmount(user.completionTokens, "0")}</td>
                            <td>{formatTokenAmount(user.totalTokens, "0")}</td>
                            <td>{user.proxyLogCount}</td>
                            <td>{formatRate(user.quotaUsageRate)}</td>
                            <td>{user.latestProxyLogAt ? formatDateTime(user.latestProxyLogAt) : "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {panel === "usageRecords" && (
            <section className="stack">
              <Card>
                <CardHeader>
                  <div className="usage-section-header">
                    <div>
                      <CardTitle>用量分析</CardTitle>
                      <CardDescription>
                        {isSystemAdmin ? "系统管理员查看全站调用记录。" : "部门管理员只查看本部门下属用户调用记录。"}
                      </CardDescription>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setUsageStatsExpanded((current) => !current)}
                    >
                      <BarChart3Icon data-icon="inline-start" />
                      {usageStatsExpanded ? "收起" : "展开"}
                    </Button>
                  </div>
                </CardHeader>
                {usageStatsExpanded && (
                  <CardContent>
                    <div className="usage-analysis-grid usage-analysis-grid-admin">
                      <UsageAnalysisTable
                        title="按模型分析"
                        emptyText="暂无模型统计数据"
                        rows={usageModelStats}
                        terminalColumn="efficiency"
                      />
                      <UsageAnalysisTable
                        title="按API格式分析"
                        emptyText="暂无API格式统计数据"
                        rows={usageApiFormatStats}
                        terminalColumn="avgDuration"
                      />
                      <UsageAnalysisTable
                        className="usage-analysis-card-department"
                        title="按部门分析"
                        emptyText="暂无部门统计数据"
                        rows={usageDepartmentStats}
                        terminalColumn="successRate"
                        showQuotaAllocation
                      />
                    </div>
                  </CardContent>
                )}
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>使用记录</CardTitle>
                  <CardDescription>按 Aether 维度展示请求、tokens、额度消耗和首字/总耗时。</CardDescription>
                </CardHeader>
                <CardContent>
                  <UsageRecordsTable
                    records={usageRecords}
                    loading={panelLoading}
                    showUser
                    showDepartment
                    showControls
                    filters={usageFilters}
                    onFiltersChange={setUsageFilters}
                    availableUsers={usageFilterOptions.users}
                    availableDepartments={usageFilterOptions.departments}
                    availableModels={usageFilterOptions.models}
                    availableApiFormats={usageFilterOptions.apiFormats}
                    availableUserAgents={usageFilterOptions.userAgents}
                    totalRecords={usageTotalRecords}
                    currentPage={usagePage}
                    pageSize={usagePageSize}
                    onPageChange={setUsagePage}
                    onPageSizeChange={setUsagePageSize}
                    autoRefresh={usageAutoRefresh}
                    onAutoRefreshChange={setUsageAutoRefresh}
                    hideUnknownRecords={usageHideUnknownRecords}
                    onHideUnknownRecordsChange={setUsageHideUnknownRecords}
                    onRefresh={() => void loadUsageRecords()}
                  />
                </CardContent>
              </Card>
            </section>
          )}

          {panel === "approvals" && (
            <Card>
              <CardHeader>
                <CardTitle>审批处理</CardTitle>
                <CardDescription>仅展示当前管理范围内的申请记录，不显示 NewAPI 明文 key。</CardDescription>
              </CardHeader>
              <CardContent>
                {!approvalRequests.length ? (
                  <div className="empty">暂无可查看申请</div>
                ) : (
                  <>
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>申请人</th>
                            <th>类型</th>
                            <th>状态</th>
                            <th>额度</th>
                            <th>最终额度</th>
                            <th>审批消息</th>
                            <th>错误</th>
                            <th>更新时间</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {approvalRequests.map((request) => (
                            <tr key={request.id}>
                              <td>{request.requesterName ?? maskSecret(request.requesterOpenId)}</td>
                              <td>{requestTypeLabel[request.requestType] ?? request.requestType}</td>
                              <td>
                                <Badge variant={badgeVariant(request.status)}>
                                  {statusLabel[request.status] ?? request.status}
                                </Badge>
                              </td>
                              <td>{formatQuotaAmount(request.requestedMonthlyQuota)}</td>
                              <td>
                                <div className="quota-control quota-control-icon-action">
                                  <Input
                                    aria-label="最终额度"
                                    min={1}
                                    step={1}
                                    type="number"
                                    value={quotaDrafts[request.id] ?? String(request.requestedMonthlyQuota)}
                                    onChange={(event) =>
                                      setQuotaDrafts((current) => ({
                                        ...current,
                                        [request.id]: event.target.value,
                                      }))
                                    }
                                    disabled={!canEditQuota(request) || busy}
                                  />
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    aria-label="保存最终额度"
                                    title="保存最终额度"
                                    disabled={!canEditQuota(request) || busy}
                                    onClick={() => void saveRequestQuota(request.id)}
                                  >
                                    <SaveIcon data-icon="inline-start" />
                                  </Button>
                                </div>
                              </td>
                              <td>{maskSecret(request.approvalCardMessageId ?? request.approvalInstanceCode)}</td>
                              <td>{request.errorMessage ? maskSecret(request.errorMessage) : "-"}</td>
                              <td>{formatDateTime(request.updatedAt)}</td>
                              <td>
                                <div className="toolbar toolbar-left">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={!canDecideRequest(request) || busy}
                                    onClick={() => void decideRequest(request.id, "approve")}
                                  >
                                    通过
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={!canDecideRequest(request) || busy}
                                    onClick={() => void decideRequest(request.id, "reject")}
                                  >
                                    拒绝
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <PageSelector
                      className="approval-pagination"
                      currentPage={currentApprovalPage}
                      pageCount={approvalPageCount}
                      pageSize={approvalPageSize}
                      pageSizeOptions={[10, 20, 50]}
                      totalRecords={approvalTotalRequests}
                      loading={busy}
                      onPageChange={setApprovalPage}
                      onPageSizeChange={(pageSize) => {
                        setApprovalPageSize(pageSize);
                        setApprovalPage(1);
                      }}
                    />
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {panel === "quotaControl" && (
            <div className="stack">
              <Card>
                <CardHeader>
                  <CardTitle>额度一致性中心</CardTitle>
                  <CardDescription>
                    分离授权账本、NewAPI 消费事实和上游观测余额。未知负向漂移只告警，不自动补额。
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="toolbar toolbar-left">
                    <Button
                      variant="outline"
                      disabled={panelLoading || busy}
                      onClick={() => void loadQuotaControl(false)}
                    >
                      <RefreshCwIcon data-icon="inline-start" />
                      重建影子快照
                    </Button>
                    <Button
                      variant="outline"
                      disabled={panelLoading || busy}
                      onClick={() => void loadQuotaControl(true)}
                    >
                      <GaugeIcon data-icon="inline-start" />
                      双读上游余额
                    </Button>
                    <Badge>
                      账期 {quotaControlData?.report.period ?? currentBillingPeriod()}
                    </Badge>
                    <Badge variant={quotaControlData?.settings.quotaMigration ? "success" : "warning"}>
                      {quotaControlData?.settings.quotaMigration ? "历史迁移已登记" : "历史迁移未登记"}
                    </Badge>
                  </div>
                  <div className="metric-grid">
                    <div className="metric-card">
                      <span>影子用户</span>
                      <strong>{quotaControlData?.report.totals.users ?? 0}</strong>
                    </div>
                    <div className="metric-card">
                      <span>一致</span>
                      <strong>{quotaControlData?.report.totals.healthy ?? 0}</strong>
                    </div>
                    <div className="metric-card">
                      <span>上游多余额</span>
                      <strong>{quotaControlData?.report.totals.excessUpstream ?? 0}</strong>
                    </div>
                    <div className="metric-card">
                      <span>上游少余额</span>
                      <strong>{quotaControlData?.report.totals.deficitUpstream ?? 0}</strong>
                    </div>
                    <div className="metric-card">
                      <span>暂定数据</span>
                      <strong>{quotaControlData?.report.totals.provisional ?? 0}</strong>
                    </div>
                  </div>
                  <div className="toolbar toolbar-left">
                    {Object.entries(quotaControlData?.settings.quotaFeatureFlags ?? {}).map(
                      ([name, enabled]) => (
                        <Badge key={name} variant={enabled ? "success" : "warning"}>
                          {name}: {enabled ? "on" : "off"}
                        </Badge>
                      ),
                    )}
                  </div>
                  <p className="field-description">
                    settledThrough：
                    {quotaControlData?.report.settledThrough
                      ? formatDateTime(quotaControlData.report.settledThrough)
                      : "尚无稳定水位"}
                    {quotaControlData?.settings.quotaMigration
                      ? `；迁移估算用户 ${quotaControlData.settings.quotaMigration.estimatedUsers}/${quotaControlData.settings.quotaMigration.users}`
                      : ""}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>用户额度勾稽</CardTitle>
                  <CardDescription>A 授权策略、G 净授权、C 权威消费、E 预期可用、R 上游观测。</CardDescription>
                </CardHeader>
                <CardContent>
                  {!quotaControlData?.report.rows.length ? (
                    <div className="empty">暂无额度影子数据</div>
                  ) : (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>用户</th>
                            <th>A</th>
                            <th>G</th>
                            <th>C</th>
                            <th>E</th>
                            <th>R</th>
                            <th>差额</th>
                            <th>generation</th>
                            <th>结论</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {quotaControlData.report.rows.map((row) => (
                            <tr key={row.feishuUserId}>
                              <td>{row.userName ?? maskSecret(row.feishuUserId)}</td>
                              <td>{formatQuotaAmount(row.assignedMonthlyQuota / quotaPerUnit, "0")}</td>
                              <td>{formatQuotaAmount(row.authorizedQuota / quotaPerUnit, "0")}</td>
                              <td>{formatQuotaAmount(row.authoritativeConsumedQuota / quotaPerUnit, "0")}</td>
                              <td>{formatQuotaAmount(row.expectedAvailableQuota / quotaPerUnit, "0")}</td>
                              <td>
                                {row.observedRemainQuota === undefined
                                  ? "-"
                                  : formatQuotaAmount(row.observedRemainQuota / quotaPerUnit, "0")}
                              </td>
                              <td>
                                {row.delta === undefined
                                  ? "-"
                                  : formatQuotaAmount(row.delta / quotaPerUnit, "0")}
                              </td>
                              <td>{row.activeGeneration}</td>
                              <td>
                                <Badge variant={quotaReconciliationVariant(row.status)}>
                                  {quotaReconciliationLabel(row.status)}
                                </Badge>
                              </td>
                              <td>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={
                                    busy ||
                                    row.status !== "excess_upstream" ||
                                    !row.observedStable ||
                                    !row.tokenAccountId
                                  }
                                  onClick={() =>
                                    void runQuotaControlAction({
                                      action: "reconcile_decrease",
                                      feishuUserId: row.feishuUserId,
                                    })
                                  }
                                >
                                  安全向下校准
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Saga 操作中心</CardTitle>
                  <CardDescription>统一查看调额、Key 更换、余额恢复、月度开账和对账状态。</CardDescription>
                </CardHeader>
                <CardContent>
                  {!quotaControlData?.operations.length ? (
                    <div className="empty">暂无额度操作</div>
                  ) : (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>操作</th>
                            <th>类型</th>
                            <th>用户</th>
                            <th>状态</th>
                            <th>代际</th>
                            <th>尝试</th>
                            <th>错误</th>
                            <th>更新时间</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {quotaControlData.operations.map((operation) => (
                            <tr key={operation.id}>
                              <td>{maskSecret(operation.id)}</td>
                              <td>{operation.operationType}</td>
                              <td>{maskSecret(operation.feishuUserId)}</td>
                              <td>
                                <Badge variant={quotaOperationVariant(operation.state)}>
                                  {operation.state}
                                </Badge>
                              </td>
                              <td>{operation.operationGeneration}</td>
                              <td>{operation.attemptCount}</td>
                              <td>{operation.lastErrorMessage ? maskSecret(operation.lastErrorMessage) : "-"}</td>
                              <td>{formatDateTime(operation.updatedAt)}</td>
                              <td>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={
                                    busy ||
                                    (operation.state !== "retryable_failed" &&
                                      operation.state !== "draining")
                                  }
                                  onClick={() =>
                                    void runQuotaControlAction({
                                      action: "retry",
                                      operationId: operation.id,
                                    })
                                  }
                                >
                                  重试
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>不可变授权账本</CardTitle>
                  <CardDescription>纠错通过反向分录完成；普通更新或删除会被数据库拒绝。</CardDescription>
                </CardHeader>
                <CardContent>
                  {!quotaControlData?.ledgerEntries.length ? (
                    <div className="empty">当前账期暂无账本分录</div>
                  ) : (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>用户</th>
                            <th>分录类型</th>
                            <th>额度</th>
                            <th>估算</th>
                            <th>operation</th>
                            <th>时间</th>
                          </tr>
                        </thead>
                        <tbody>
                          {quotaControlData.ledgerEntries.map((entry) => (
                            <tr key={entry.id}>
                              <td>{maskSecret(entry.feishuUserId)}</td>
                              <td>{entry.entryType}</td>
                              <td>{formatQuotaAmount(entry.quotaValue, "0")}</td>
                              <td>
                                <Badge variant={entry.estimated ? "warning" : "success"}>
                                  {entry.estimated ? "估算" : "已确认"}
                                </Badge>
                              </td>
                              <td>{maskSecret(entry.operationId)}</td>
                              <td>{formatDateTime(entry.createdAt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {panel === "settings" && isSystemAdmin && (
            <Card>
              <CardHeader>
                <CardTitle>系统设置</CardTitle>
                <CardDescription>默认额度和全局设置只允许系统管理员修改。</CardDescription>
              </CardHeader>
              <CardContent>
                {billingResult && <div className="alert">{billingResult}</div>}
                <section className="settings-section">
                  <div>
                    <h3>默认额度</h3>
                    <p>新申请、调额基准和月度重置会使用该值。</p>
                  </div>
                  <div className="field">
                    <label htmlFor="defaultMonthlyQuota">默认申请额度</label>
                    <div className="quota-control quota-control-icon-action">
                      <Input
                        id="defaultMonthlyQuota"
                        min={1}
                        step={1}
                        type="number"
                        value={defaultQuotaDraft}
                        onChange={(event) => setDefaultQuotaDraft(event.target.value)}
                        disabled={!data?.authorized || busy}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label="保存默认申请额度"
                        title="保存默认申请额度"
                        disabled={!data?.authorized || busy}
                        onClick={() => void saveDefaultQuota()}
                      >
                        <SaveIcon data-icon="inline-start" />
                      </Button>
                    </div>
                    <span className="field-description">
                      当前值：{formatQuotaAmount(data?.settings?.defaultMonthlyQuota ?? 200)}
                    </span>
                  </div>
                </section>

                <section className="settings-section">
                  <div>
                    <h3>NewAPI 用量同步</h3>
                    <p>从 NewAPI 日志回填 tokens、额度消耗和渠道字段。</p>
                    <span className="field-description">
                      上次同步：{usageSyncCheckpoint?.lastRunAt ? formatDateTime(usageSyncCheckpoint.lastRunAt) : "-"}
                      {" · "}
                      下次同步：{usageSyncCheckpoint?.nextRunAfter ? formatDateTime(usageSyncCheckpoint.nextRunAfter) : "-"}
                      {" · "}
                      最近日志：{usageSyncCheckpoint?.lastSeenNewapiLogId ? maskSecret(usageSyncCheckpoint.lastSeenNewapiLogId) : "-"}
                      {" · "}
                      稳定水位：{usageSyncCheckpoint?.settledThrough ? formatDateTime(usageSyncCheckpoint.settledThrough) : "-"}
                      {" · "}
                      固定窗口：{usageSyncCheckpoint?.scanStart ? formatDateTime(usageSyncCheckpoint.scanStart) : "-"}
                      {" → "}
                      {usageSyncCheckpoint?.scanEnd ? formatDateTime(usageSyncCheckpoint.scanEnd) : "-"}
                    </span>
                  </div>
                  <div className="billing-control-grid">
                    <label className="field">
                      <span>自动同步</span>
                      <input
                        type="checkbox"
                        checked={usageSyncPolicyDraft.enabled}
                        disabled={!data?.authorized || busy}
                        onChange={(event) =>
                          setUsageSyncPolicyDraft((current) => ({
                            ...current,
                            enabled: event.target.checked,
                          }))
                        }
                      />
                    </label>
                    <div className="field">
                      <label htmlFor="usageSyncPolicyInterval">同步周期(分钟)</label>
                      <Input
                        id="usageSyncPolicyInterval"
                        min={1}
                        max={1440}
                        step={1}
                        type="number"
                        value={usageSyncPolicyDraft.intervalMinutes}
                        disabled={!data?.authorized || busy}
                        onChange={(event) =>
                          setUsageSyncPolicyDraft((current) => ({
                            ...current,
                            intervalMinutes: event.target.value,
                          }))
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="usageSyncPolicyPageSize">每页数量</label>
                      <Input
                        id="usageSyncPolicyPageSize"
                        min={1}
                        max={100}
                        step={1}
                        type="number"
                        value={usageSyncPolicyDraft.pageSize}
                        disabled={!data?.authorized || busy}
                        onChange={(event) =>
                          setUsageSyncPolicyDraft((current) => ({
                            ...current,
                            pageSize: event.target.value,
                          }))
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="usageSyncPolicyMaxPages">每轮页数</label>
                      <Input
                        id="usageSyncPolicyMaxPages"
                        min={1}
                        max={20}
                        step={1}
                        type="number"
                        value={usageSyncPolicyDraft.maxPagesPerRun}
                        disabled={!data?.authorized || busy}
                        onChange={(event) =>
                          setUsageSyncPolicyDraft((current) => ({
                            ...current,
                            maxPagesPerRun: event.target.value,
                          }))
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="usageSyncPolicyOverlap">重叠窗口(分钟)</label>
                      <Input
                        id="usageSyncPolicyOverlap"
                        min={0}
                        max={10080}
                        step={1}
                        type="number"
                        value={usageSyncPolicyDraft.overlapMinutes}
                        disabled={!data?.authorized || busy}
                        onChange={(event) =>
                          setUsageSyncPolicyDraft((current) => ({
                            ...current,
                            overlapMinutes: event.target.value,
                          }))
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="usageSyncPolicyMatchWindow">匹配窗口(分钟)</label>
                      <Input
                        id="usageSyncPolicyMatchWindow"
                        min={1}
                        max={1440}
                        step={1}
                        type="number"
                        value={usageSyncPolicyDraft.matchWindowMinutes}
                        disabled={!data?.authorized || busy}
                        onChange={(event) =>
                          setUsageSyncPolicyDraft((current) => ({
                            ...current,
                            matchWindowMinutes: event.target.value,
                          }))
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="usageSyncPolicySettlementLag">结算延迟(分钟)</label>
                      <Input
                        id="usageSyncPolicySettlementLag"
                        min={0}
                        max={1440}
                        step={1}
                        type="number"
                        value={usageSyncPolicyDraft.settlementLagMinutes}
                        disabled={!data?.authorized || busy}
                        onChange={(event) =>
                          setUsageSyncPolicyDraft((current) => ({
                            ...current,
                            settlementLagMinutes: event.target.value,
                          }))
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="usageSyncPolicyRetryBase">失败重试基数(分钟)</label>
                      <Input
                        id="usageSyncPolicyRetryBase"
                        min={1}
                        max={1440}
                        step={1}
                        type="number"
                        value={usageSyncPolicyDraft.retryBaseMinutes}
                        disabled={!data?.authorized || busy}
                        onChange={(event) =>
                          setUsageSyncPolicyDraft((current) => ({
                            ...current,
                            retryBaseMinutes: event.target.value,
                          }))
                        }
                      />
                    </div>
                  </div>
                  <div className="toolbar toolbar-left">
                    <Button variant="outline" size="sm" disabled={!data?.authorized || busy} onClick={() => void saveUsageSyncPolicy()}>
                      <SaveIcon data-icon="inline-start" />
                      保存自动同步
                    </Button>
                    <Badge variant={usageSyncPolicy?.enabled ? "success" : "warning"}>
                      {usageSyncPolicy?.enabled ? "自动同步已开启" : "自动同步未开启"}
                    </Badge>
                    {usageSyncCheckpoint?.lastRunStatus && (
                      <Badge variant={billingStatusVariant(usageSyncCheckpoint.lastRunStatus)}>
                        {billingStatusLabel(usageSyncCheckpoint.lastRunStatus)}
                      </Badge>
                    )}
                  </div>
                  <div>
                    <h3>手动同步</h3>
                    <p>试算确认后把 NewAPI 日志写入 source records 并回填请求额度消耗。</p>
                  </div>
                  <div className="billing-control-grid">
                    <div className="field">
                      <label htmlFor="usageSyncPage">起始页</label>
                      <Input
                        id="usageSyncPage"
                        min={0}
                        step={1}
                        type="number"
                        value={usageSyncDraft.page}
                        disabled={!data?.authorized || busy}
                        onChange={(event) =>
                          setUsageSyncDraft((current) => ({ ...current, page: event.target.value }))
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="usageSyncSize">每页数量</label>
                      <Input
                        id="usageSyncSize"
                        min={1}
                        max={100}
                        step={1}
                        type="number"
                        value={usageSyncDraft.size}
                        disabled={!data?.authorized || busy}
                        onChange={(event) =>
                          setUsageSyncDraft((current) => ({ ...current, size: event.target.value }))
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="usageSyncMaxPages">最大页数</label>
                      <Input
                        id="usageSyncMaxPages"
                        min={1}
                        max={20}
                        step={1}
                        type="number"
                        value={usageSyncDraft.maxPages}
                        disabled={!data?.authorized || busy}
                        onChange={(event) =>
                          setUsageSyncDraft((current) => ({ ...current, maxPages: event.target.value }))
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="usageSyncOverlap">重叠窗口(分钟)</label>
                      <Input
                        id="usageSyncOverlap"
                        min={0}
                        max={10080}
                        step={1}
                        type="number"
                        value={usageSyncDraft.overlapMinutes}
                        disabled={!data?.authorized || busy}
                        onChange={(event) =>
                          setUsageSyncDraft((current) => ({ ...current, overlapMinutes: event.target.value }))
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="usageSyncWindow">匹配窗口(分钟)</label>
                      <Input
                        id="usageSyncWindow"
                        min={1}
                        max={1440}
                        step={1}
                        type="number"
                        value={usageSyncDraft.matchWindowMinutes}
                        disabled={!data?.authorized || busy}
                        onChange={(event) =>
                          setUsageSyncDraft((current) => ({
                            ...current,
                            matchWindowMinutes: event.target.value,
                          }))
                        }
                      />
                    </div>
                  </div>
                  <div className="toolbar toolbar-left">
                    <Button variant="outline" size="sm" disabled={!data?.authorized || busy} onClick={() => void runUsageSync(true)}>
                      <RefreshCwIcon data-icon="inline-start" />
                      试算同步
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!data?.authorized || busy || !usageSyncReadyToExecute}
                      title={usageSyncReadyToExecute ? "执行同步" : "请先用相同参数试算同步"}
                      onClick={() => void runUsageSync(false)}
                    >
                      <ShieldCheckIcon data-icon="inline-start" />
                      执行同步
                    </Button>
                  </div>
                </section>

                <section className="settings-section">
                  <div>
                    <h3>Asia/Hong_Kong 月度开账</h3>
                    <p>先校验用户策略、部门预算、同步水位和未结操作；任何部门不足时整批阻塞。</p>
                  </div>
                  <div className="billing-control-grid">
                    <div className="field">
                      <label htmlFor="monthlyResetPeriod">目标账期</label>
                      <Input
                        id="monthlyResetPeriod"
                        value={monthlyResetDraft.period}
                        disabled={!data?.authorized || busy}
                        onChange={(event) =>
                          setMonthlyResetDraft((current) => ({ ...current, period: event.target.value }))
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="monthlyResetLimit">处理上限</label>
                      <Input
                        id="monthlyResetLimit"
                        min={1}
                        max={500}
                        step={1}
                        type="number"
                        placeholder="全部"
                        value={monthlyResetDraft.limit}
                        disabled={!data?.authorized || busy}
                        onChange={(event) =>
                          setMonthlyResetDraft((current) => ({ ...current, limit: event.target.value }))
                        }
                      />
                    </div>
                  </div>
                  <div className="toolbar toolbar-left">
                    <Button variant="outline" size="sm" disabled={!data?.authorized || busy} onClick={() => void runMonthlyReset(true)}>
                      <RefreshCwIcon data-icon="inline-start" />
                      开账 preflight
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!data?.authorized || busy || !monthlyResetReadyToExecute}
                      title={monthlyResetReadyToExecute ? "执行开账" : "请先用相同参数完成开账 preflight"}
                      onClick={() => void runMonthlyReset(false)}
                    >
                      <ShieldCheckIcon data-icon="inline-start" />
                      执行开账
                    </Button>
                  </div>
                </section>

                <section className="settings-section">
                  <div>
                    <h3>F 阶段功能开关</h3>
                    <p>写能力依赖历史账本迁移和统一 Saga；自动向上补额固定关闭且不可在界面开启。</p>
                    <span className="field-description">
                      迁移状态：
                      {data?.settings?.quotaMigration
                        ? `${data.settings.quotaMigration.period}，${data.settings.quotaMigration.estimatedUsers}/${data.settings.quotaMigration.users} 个用户为估算 opening`
                        : "未登记"}
                    </span>
                  </div>
                  <div className="billing-control-grid">
                    {(
                      [
                        ["quotaLedgerShadowRead", "影子账本读取"],
                        ["quotaSagaWritesEnabled", "统一 Saga 写入"],
                        ["keyRotationSagaEnabled", "Key 更换"],
                        ["quotaRestoreEnabled", "恢复可用额度"],
                        ["monthlyPeriodOpenEnabled", "月度开账"],
                        ["reconciliationAutoDecreaseEnabled", "自动向下校准"],
                      ] as const
                    ).map(([key, label]) => (
                      <label className="field" key={key}>
                        <span>{label}</span>
                        <input
                          type="checkbox"
                          checked={quotaFeatureDraft[key]}
                          disabled={!data?.authorized || busy}
                          onChange={(event) =>
                            setQuotaFeatureDraft((current) => ({
                              ...current,
                              [key]: event.target.checked,
                            }))
                          }
                        />
                      </label>
                    ))}
                    <div className="field" data-disabled>
                      <span>自动向上补额</span>
                      <input type="checkbox" checked={false} disabled />
                      <span className="field-description">长期固定关闭；未知负向漂移进入人工处置。</span>
                    </div>
                  </div>
                  <div className="toolbar toolbar-left">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!data?.authorized || busy}
                      onClick={() => void saveQuotaFeatureFlags()}
                    >
                      <SaveIcon data-icon="inline-start" />
                      保存 F 开关
                    </Button>
                    <Badge variant={data?.settings?.quotaMigration ? "success" : "warning"}>
                      {data?.settings?.quotaMigration ? "迁移门禁满足" : "迁移门禁未满足"}
                    </Badge>
                  </div>
                </section>

                <section className="settings-section">
                  <div>
                    <h3>计费操作</h3>
                    <p>最近 50 次计费同步和重置操作会持久化到设置审计中。</p>
                  </div>
                  <div className="table-wrap table-scroll billing-operation-table">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>时间</th>
                          <th>类型</th>
                          <th>状态</th>
                          <th>账期</th>
                          <th>摘要</th>
                          <th>操作者</th>
                        </tr>
                      </thead>
                      <tbody>
                        {!(data?.settings?.billingOperations ?? []).length ? (
                          <tr>
                            <td colSpan={6} className="usage-empty-cell">
                              暂无计费操作
                            </td>
                          </tr>
                        ) : (
                          (data?.settings?.billingOperations ?? []).slice(0, 50).map((operation) => (
                            <tr key={operation.id} title={operation.errorMessage ?? undefined}>
                              <td>{formatDateTime(operation.createdAt)}</td>
                              <td>{billingKindLabel(operation.kind)}</td>
                              <td>
                                <Badge variant={billingStatusVariant(operation.status)}>
                                  {billingStatusLabel(operation.status)}
                                </Badge>
                              </td>
                              <td>{operation.period ?? "-"}</td>
                              <td>{billingSummaryText(operation)}</td>
                              <td>{maskSecret(operation.operatedByFeishuUserId) ?? "-"}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>
              </CardContent>
            </Card>
          )}
        </main>
      </div>
    </>
  );
}
