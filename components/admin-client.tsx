"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeftIcon,
  BarChart3Icon,
  BookOpenIcon,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { FeishuSdkScript, loginWithFeishu } from "@/components/feishu-login";
import { LoginWaitingScreen } from "@/components/login-waiting-screen";
import {
  BillingAuditPanel,
  SystemHealthPanel,
  type BillingHealthResponse,
} from "@/components/billing-health-panels";
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
    packageReset?: {
      enabled: boolean;
      dayOfMonth: number;
      nextResetAt?: string;
      updatedAt?: string;
    };
    newapiControl?: {
      baseUrl?: string;
      controlUserId?: string;
      accessTokenConfigured: boolean;
      source: "system_settings" | "environment";
      updatedAt?: string;
    };
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
  | "billingAudit"
  | "systemHealth"
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
  isGlobalAdmin?: boolean;
  isEnvironmentRoot?: boolean;
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
  requestedQuotaLimit?: number;
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

type DepartmentMemberSyncOperation = {
  id: string;
  kind: "department_member_sync";
  status: string;
  input?: { departmentId?: string };
  summary: {
    synced?: number;
    skipped?: number;
    pages?: number;
  };
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
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
  key_reset: "Key 更换",
  quota_adjust: "额度调整",
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
  const [departmentMemberSyncOperations, setDepartmentMemberSyncOperations] = useState<
    Record<string, DepartmentMemberSyncOperation>
  >({});
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
  const [packageResetDraft, setPackageResetDraft] = useState({
    enabled: false,
    dayOfMonth: "1",
  });
  const [newapiControlDraft, setNewapiControlDraft] = useState({
    baseUrl: "",
    controlUserId: "",
    accessToken: "",
  });
  const [billingHealthData, setBillingHealthData] =
    useState<BillingHealthResponse | null>(null);
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
        setPackageResetDraft({
          enabled: body.settings.packageReset?.enabled ?? false,
          dayOfMonth: String(body.settings.packageReset?.dayOfMonth ?? 1),
        });
        if (body.settings.newapiControl) {
          setNewapiControlDraft((current) => ({
            ...current,
            baseUrl: body.settings?.newapiControl?.baseUrl ?? "",
            controlUserId: body.settings?.newapiControl?.controlUserId ?? "",
            accessToken: "",
          }));
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

  const loadDepartmentMemberSyncOperations = useCallback(async () => {
    const res = await fetch("/api/admin/departments/sync-members", {
      cache: "no-store",
    });
    const body = await readJsonResponse<{
      operations?: DepartmentMemberSyncOperation[];
    }>(res);
    if (!res.ok) throw new Error(body.error ?? "读取成员同步任务失败");
    const latestByDepartment: Record<string, DepartmentMemberSyncOperation> = {};
    for (const operation of body.operations ?? []) {
      const departmentId = operation.input?.departmentId;
      if (departmentId && !latestByDepartment[departmentId]) {
        latestByDepartment[departmentId] = operation;
      }
    }
    setDepartmentMemberSyncOperations(latestByDepartment);
    return latestByDepartment;
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
              (quotaRequest.approvedQuotaLimit ?? quotaRequest.requestedQuotaLimit)?.toString() ?? "",
          ]),
        ),
        ...current,
      }));
      if (body.departments.length === 1) {
        setDepartmentQuotaRequestLimit(
          (current) => current || String(body.departments[0].quotaLimit),
        );
      }
      await loadDepartmentMemberSyncOperations();
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取部门额度失败");
    } finally {
      setPanelLoading(false);
    }
  }, [loadDepartmentMemberSyncOperations]);

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

  const loadBillingHealth = useCallback(async () => {
    setPanelLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/billing-health", { cache: "no-store" });
      const body = await readJsonResponse<BillingHealthResponse>(res);
      if (!res.ok) throw new Error(body.error ?? "读取账务健康快照失败");
      setBillingHealthData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取账务健康快照失败");
    } finally {
      setPanelLoading(false);
    }
  }, []);

  useEffect(() => {
    if (panel !== "departmentQuota") return;
    if (
      !Object.values(departmentMemberSyncOperations).some((operation) =>
        ["pending", "running"].includes(operation.status),
      )
    ) {
      return;
    }
    const activeDepartmentIds = Object.entries(departmentMemberSyncOperations)
      .filter(([, operation]) => ["pending", "running"].includes(operation.status))
      .map(([departmentId]) => departmentId);
    const timer = window.setTimeout(() => {
      void loadDepartmentMemberSyncOperations()
        .then((next) => {
          if (
            activeDepartmentIds.some(
              (departmentId) =>
                next[departmentId] &&
                !["pending", "running"].includes(next[departmentId].status),
            )
          ) {
            void loadDepartmentQuota();
          }
        })
        .catch((error) => {
          setError(error instanceof Error ? error.message : "读取成员同步任务失败");
        });
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [
    departmentMemberSyncOperations,
    loadDepartmentMemberSyncOperations,
    loadDepartmentQuota,
    panel,
  ]);

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
    if (
      (panel === "billingAudit" || (panel === "systemHealth" && isRootAdmin)) &&
      !billingHealthData
    ) {
      void loadBillingHealth();
    }
    if (panel === "approvals") void loadApprovalRequests();
  }, [
    data?.authorized,
    isRootAdmin,
    isSystemAdmin,
    loadApprovalRequests,
    loadAdminScopes,
    loadAdminUsers,
    loadBillingHealth,
    loadDepartmentStats,
    loadDepartmentQuota,
    loadUsageRecords,
    loadUserStats,
    billingHealthData,
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

  async function saveNewapiControl() {
    const baseUrl = newapiControlDraft.baseUrl.trim().replace(/\/+$/, "");
    const controlUserId = newapiControlDraft.controlUserId.trim();
    if (!baseUrl || !controlUserId) {
      setError("请填写完整的 NewAPI 链接和用户 ID");
      return;
    }
    try {
      new URL(baseUrl);
    } catch {
      setError("NewAPI 链接格式无效");
      return;
    }
    if (
      !newapiControlDraft.accessToken.trim() &&
      data?.settings?.newapiControl?.source !== "system_settings"
    ) {
      setError("首次切换到系统设置时必须填写用户 AK");
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
          newapiControl: {
            baseUrl,
            controlUserId,
            ...(newapiControlDraft.accessToken.trim()
              ? { accessToken: newapiControlDraft.accessToken.trim() }
              : {}),
          },
        }),
      });
      const body = await readJsonResponse<{ error?: string }>(res);
      if (!res.ok) throw new Error(body.error ?? "保存 NewAPI 上游连接失败");
      setNewapiControlDraft((current) => ({ ...current, accessToken: "" }));
      setMessage("NewAPI 上游连接已保存，新请求将使用新配置。");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存 NewAPI 上游连接失败");
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
    const requestedQuotaLimit =
      departmentQuotaRequestAction === "increase"
        ? Number(departmentQuotaRequestLimit)
        : undefined;
    if (
      departmentQuotaRequestAction === "increase" &&
      (!Number.isInteger(requestedQuotaLimit) || (requestedQuotaLimit ?? -1) < 0)
    ) {
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
          ...(requestedQuotaLimit === undefined ? {} : { requestedQuotaLimit }),
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
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/departments/sync-members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ departmentId }),
      });
      const body = await readJsonResponse<{
        operation?: DepartmentMemberSyncOperation;
      }>(res);
      if (res.status !== 202 || !body.operation) {
        throw new Error(body.error ?? "提交部门成员同步任务失败");
      }
      setDepartmentMemberSyncOperations((current) => ({
        ...current,
        [departmentId]: body.operation!,
      }));
      setMessage("已提交成员同步任务，后台将自动执行；本页会持续刷新任务状态。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交部门成员同步任务失败");
    } finally {
      setBusy(false);
    }
  }

  async function savePackageReset() {
    const dayOfMonth = Number(packageResetDraft.dayOfMonth);
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
      setError("套餐重置日必须在 1 到 31 日之间");
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
          packageReset: {
            enabled: packageResetDraft.enabled,
            dayOfMonth,
          },
        }),
      });
      const body = await readJsonResponse<{ error?: string }>(res);
      if (!res.ok) throw new Error(body.error ?? "保存套餐重置设置失败");
      setMessage(
        packageResetDraft.enabled
          ? `套餐重置已启用，每月 ${dayOfMonth} 日自动执行。`
          : "套餐重置已关闭。",
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存套餐重置设置失败");
    } finally {
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
                className={panel === "billingAudit" ? "nav-item active nav-button" : "nav-item nav-button"}
                type="button"
                onClick={() => selectPanel("billingAudit")}
              >
                <BookOpenIcon data-icon="inline-start" />
                账务审计
              </button>
              {isRootAdmin && (
                <button
                  className={panel === "systemHealth" ? "nav-item active nav-button" : "nav-item nav-button"}
                  type="button"
                  onClick={() => selectPanel("systemHealth")}
                >
                  <ShieldCheckIcon data-icon="inline-start" />
                  系统健康
                </button>
              )}
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
                                    {!user.isGlobalAdmin || isRootAdmin ? (
                                      <>
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
                                          {data?.user?.id !== user.id &&
                                            (user.status === "disabled" ? (
                                              <Button
                                                variant="outline"
                                                size="sm"
                                                disabled={
                                                  busy || user.activeTokenStatus !== "disabled"
                                                }
                                                onClick={() => void enableUser(user)}
                                              >
                                                启用
                                              </Button>
                                            ) : (
                                              <Button
                                                variant="outline"
                                                size="sm"
                                                disabled={
                                                  busy ||
                                                  user.status !== "active" ||
                                                  user.activeTokenStatus !== "active"
                                                }
                                                onClick={() => void disableUser(user)}
                                              >
                                                禁用
                                              </Button>
                                            ))}
                                          {data?.user?.id !== user.id && (
                                            <Button
                                              variant="outline"
                                              size="sm"
                                              disabled={busy}
                                              onClick={() => void deleteUser(user)}
                                            >
                                              <Trash2Icon data-icon="inline-start" />
                                              删除
                                            </Button>
                                          )}
                                        </div>
                                      </>
                                    ) : null}
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
                                    {scope.scopeType !== "global" || isRootAdmin ? (
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={busy || !canCancel}
                                        onClick={() => void cancelAdmin(scope)}
                                      >
                                        <XCircleIcon data-icon="inline-start" />
                                        取消管理员
                                      </Button>
                                    ) : (
                                      "-"
                                    )}
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
                            <th>成员 / 已发 Key</th>
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
                            const syncOperation =
                              departmentMemberSyncOperations[department.departmentId];
                            const syncActive = Boolean(
                              syncOperation &&
                                ["pending", "running"].includes(syncOperation.status),
                            );
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
                                  {department.memberCount} / {department.keyedUsers}
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
                                  <div className="meta-stack">
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      disabled={busy || syncActive}
                                      onClick={() => void syncDepartmentMembers(department.departmentId)}
                                    >
                                      {syncActive ? (
                                        <LoaderCircleIcon className="spin-icon" data-icon="inline-start" />
                                      ) : (
                                        <RefreshCwIcon data-icon="inline-start" />
                                      )}
                                      {syncOperation?.status === "pending"
                                        ? "任务已提交"
                                        : syncOperation?.status === "running"
                                          ? "同步中…"
                                          : "同步成员"}
                                    </Button>
                                    {syncOperation && (
                                      <span title={syncOperation.errorMessage}>
                                        {syncOperation.status === "applied"
                                          ? `已完成：同步 ${syncOperation.summary.synced ?? 0}，跳过 ${syncOperation.summary.skipped ?? 0}`
                                          : syncOperation.status === "partial_failed"
                                            ? "部分完成，需查看错误"
                                            : syncOperation.status === "failed"
                                              ? "同步失败"
                                              : syncOperation.status === "running"
                                                ? `后台执行中${syncOperation.summary.pages ? `（${syncOperation.summary.pages} 页）` : ""}`
                                                : "等待后台执行"}
                                      </span>
                                    )}
                                  </div>
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
                      申请固定发送给系统管理员。重置申请无需填写目标额度，由系统管理员审批时确定新的绝对上限。
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
                      {departmentQuotaRequestAction === "increase" && (
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
                      )}
                      <div className="field">
                        <label htmlFor="departmentQuotaRequestReason">申请理由</label>
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
                          {departmentQuotaRequestAction === "reset"
                            ? "申请重置额度"
                            : "申请提高额度"}
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
                                  {formatQuotaAmount(quotaRequest.currentQuotaLimit, "0")} / {quotaRequest.requestedQuotaLimit === undefined
                                    ? "待系统管理员确定"
                                    : formatQuotaAmount(quotaRequest.requestedQuotaLimit, "0")}
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
                                        (quotaRequest.requestedQuotaLimit?.toString() ?? "")
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

          {panel === "billingAudit" && (
            <BillingAuditPanel
              data={billingHealthData}
              loading={panelLoading}
              onRefresh={() => void loadBillingHealth()}
            />
          )}

          {panel === "systemHealth" && isRootAdmin && (
            <SystemHealthPanel
              data={billingHealthData}
              loading={panelLoading}
              onRefresh={() => void loadBillingHealth()}
            />
          )}
          {panel === "settings" && isSystemAdmin && (
            <Card>
              <CardHeader>
                <CardTitle>系统设置</CardTitle>
                <CardDescription>
                  只保留稳定业务配置；消费采集、重试和账期任务由后台按固定安全策略运行。
                </CardDescription>
              </CardHeader>
              <CardContent>
                {isRootAdmin && (
                  <section className="settings-section">
                    <div>
                      <h3>NewAPI 上游连接</h3>
                      <p>仅 root 可修改。保存后代理、Key 管理和后台消费采集会统一使用新配置。</p>
                    </div>
                    <div className="field-group">
                      <div className="field">
                        <label htmlFor="newapiBaseUrl">上游 NewAPI 链接</label>
                        <Input
                          id="newapiBaseUrl"
                          type="url"
                          value={newapiControlDraft.baseUrl}
                          placeholder="https://new-api.example.com"
                          disabled={busy}
                          onChange={(event) =>
                            setNewapiControlDraft((current) => ({
                              ...current,
                              baseUrl: event.target.value,
                            }))
                          }
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="newapiControlUserId">NewAPI 用户 ID</label>
                        <Input
                          id="newapiControlUserId"
                          value={newapiControlDraft.controlUserId}
                          placeholder="例如 33"
                          disabled={busy}
                          onChange={(event) =>
                            setNewapiControlDraft((current) => ({
                              ...current,
                              controlUserId: event.target.value,
                            }))
                          }
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="newapiAccessToken">NewAPI 用户 AK</label>
                        <Input
                          id="newapiAccessToken"
                          type="password"
                          autoComplete="new-password"
                          value={newapiControlDraft.accessToken}
                          placeholder={
                            data?.settings?.newapiControl?.accessTokenConfigured
                              ? "已配置；留空则保持不变"
                              : "请输入用户 AK"
                          }
                          disabled={busy}
                          onChange={(event) =>
                            setNewapiControlDraft((current) => ({
                              ...current,
                              accessToken: event.target.value,
                            }))
                          }
                        />
                        <span className="field-description">
                          AK 只会加密保存，管理接口不会回传明文。
                        </span>
                      </div>
                      <Button disabled={busy} onClick={() => void saveNewapiControl()}>
                        <SaveIcon data-icon="inline-start" />
                        保存上游连接
                      </Button>
                    </div>
                  </section>
                )}

                <section className="settings-section">
                  <div>
                    <h3>默认申请额度</h3>
                    <p>新申请、首次授权和后续额度调整会以该值作为默认建议。</p>
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
                    <h3>套餐重置</h3>
                    <p>按香港时区在选定日期更新所有有效用户的套餐额度。</p>
                  </div>
                  <div className="settings-reset-controls">
                    <div className="settings-inline-control">
                      <div>
                        <label htmlFor="packageResetEnabled">自动重置</label>
                        <span className="field-description">
                          {packageResetDraft.enabled ? "已启用" : "已关闭"}
                        </span>
                      </div>
                      <Switch
                        id="packageResetEnabled"
                        checked={packageResetDraft.enabled}
                        disabled={!data?.authorized || busy}
                        onCheckedChange={(enabled: boolean) =>
                          setPackageResetDraft((current) => ({ ...current, enabled }))
                        }
                      />
                    </div>
                    <div className="field settings-reset-day-field">
                      <label htmlFor="packageResetDay">重置日</label>
                      <Select
                        value={packageResetDraft.dayOfMonth}
                        disabled={!data?.authorized || busy}
                        onValueChange={(dayOfMonth: string) =>
                          setPackageResetDraft((current) => ({
                            ...current,
                            dayOfMonth,
                          }))
                        }
                      >
                        <SelectTrigger id="packageResetDay" aria-label="选择套餐重置日">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Array.from({ length: 31 }, (_, index) => {
                            const day = String(index + 1);
                            return (
                              <SelectItem key={day} value={day}>
                                每月 {day} 日
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                      <span className="field-description">
                        {packageResetDraft.enabled && data?.settings?.packageReset?.nextResetAt
                          ? `下次执行：${formatDateTime(data.settings.packageReset.nextResetAt)}`
                          : "自动重置关闭时不会执行。"}
                      </span>
                    </div>
                    <Button
                      className="settings-reset-save"
                      disabled={!data?.authorized || busy}
                      onClick={() => void savePackageReset()}
                    >
                      <SaveIcon data-icon="inline-start" />
                      保存套餐重置
                    </Button>
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
