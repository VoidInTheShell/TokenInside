"use client";

import Image from "next/image";
import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
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
  SearchIcon,
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
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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
import { APP_TIME_ZONE } from "@/lib/time-zone";
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
  approvalOperatorName?: string;
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
      requestCount: number;
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      packagePeriod?: string;
      packageQuota?: number;
      quotaConsumed?: number;
      remainingQuota?: number;
      usageRecordCount?: number;
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
  | "packages"
  | "departmentStats"
  | "userStats"
  | "usageRecords"
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
  packagePeriod?: string;
  packageQuota?: number;
  remainingQuota?: number;
  quotaConsumed?: number;
  cost?: number;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  requestCount?: number;
  usageRecordCount?: number;
  latestRequestStatus?: string;
  latestRequestType?: string;
  latestRequestUpdatedAt?: string;
  latestActivityAt?: string;
  updatedAt: string;
  createdAt: string;
};

type AdminUsersResponse = {
  users: AdminUser[];
  total?: number;
  limit?: number;
  offset?: number;
  truncated?: boolean;
  filters?: {
    departments?: Array<{ id: string; name?: string }>;
  };
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
  status?: "active" | "disabled" | "deleted";
  role: string;
  activeTokenStatus?: string;
  packagePeriod?: string;
  packageQuota: number;
  remainingQuota?: number;
  quotaConsumed: number;
  cost: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestCount: number;
  usageRecordCount: number;
  quotaUsageRate: number;
  latestActivityAt?: string;
};

type UserStatsResponse = {
  stats: UserStatsRow[];
  total?: number;
  limit?: number;
  offset?: number;
  truncated?: boolean;
  filters?: {
    departments?: Array<{ id: string; name?: string }>;
  };
  error?: string;
};

type AdminUserSortKey =
  | "latestActivity"
  | "name"
  | "department"
  | "status"
  | "role"
  | "packageQuota"
  | "remainingQuota"
  | "quotaConsumed"
  | "totalTokens"
  | "requestCount";

type DirectoryFiltersState = {
  search: string;
  departmentId: string;
  status: string;
  role: string;
  sortBy: AdminUserSortKey;
  sortOrder: "asc" | "desc";
};

type DepartmentStatsRow = {
  departmentId: string;
  departmentName?: string;
  memberCount: number;
  keyedUsers: number;
  issuedQuota: number;
  totalQuotaLimit: number;
  remainingQuota: number;
  quotaConsumed: number;
  cost: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestCount: number;
  usageRecordCount: number;
  quotaUsageRate: number;
  latestActivityAt?: string;
};

type DepartmentStatsResponse = {
  departments: DepartmentStatsRow[];
  error?: string;
};

type PackageQuotaLimitRequest = {
  id: string;
  departmentId: string;
  departmentName?: string;
  period: string;
  status: string;
  reason: string;
  currentQuotaLimit: number;
  requestedQuotaLimit?: number;
  approvedQuotaLimit?: number;
  requesterName?: string;
  requesterOpenId?: string;
  approvalOperatorName?: string;
  approvalOperatorOpenId?: string;
  approvalOperatedAt?: string;
  errorMessage?: string;
  updatedAt: string;
  createdAt: string;
};

type PackageManagementResponse = {
  currentPeriod: string;
  nextPeriod: string;
  packages: Array<{
    id: string;
    departmentId: string;
    departmentName?: string;
    currentPeriod: string;
    nextPeriod?: string;
    totalQuotaLimit: number;
    currentPackageQuota: number;
    nextPackageQuota: number;
    allocatedQuota: number;
    pendingReservedQuota: number;
    availableQuota: number;
    memberCount: number;
    keyedUsers: number;
    prewarmedKeys: number;
    updatedAt: string;
    nextUpdatedAt?: string;
  }>;
  requests: PackageQuotaLimitRequest[];
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
  if (["active", "provisioned", "approved", "completed"].includes(status)) return "success";
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

function approvalOperatorLabel(input: {
  approvalOperatorName?: string;
  approvalOperatorOpenId?: string;
}) {
  if (input.approvalOperatorName?.trim()) return input.approvalOperatorName.trim();
  if (!input.approvalOperatorOpenId) return "未处理";
  if (input.approvalOperatorOpenId.startsWith("system:")) return "系统自动处理";
  return "未同步飞书姓名";
}

function currentBillingPeriod() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}` : "-";
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

function useDebouncedValue<T>(value: T, delayMs = 320) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return debouncedValue;
}

const directorySortOptions: Array<{ value: AdminUserSortKey; label: string }> = [
  { value: "latestActivity", label: "最近调用" },
  { value: "name", label: "用户名称" },
  { value: "department", label: "部门" },
  { value: "packageQuota", label: "套餐上限" },
  { value: "remainingQuota", label: "剩余额度" },
  { value: "quotaConsumed", label: "已用额度" },
  { value: "totalTokens", label: "Tokens" },
  { value: "requestCount", label: "请求数" },
];

function DirectoryFilters({
  value,
  departments,
  loading,
  defaultSortBy = "latestActivity",
  hideLabels = false,
  leading,
  onChange,
}: {
  value: DirectoryFiltersState;
  departments: Array<{ id: string; name?: string }>;
  loading?: boolean;
  defaultSortBy?: AdminUserSortKey;
  hideLabels?: boolean;
  leading?: ReactNode;
  onChange: (value: DirectoryFiltersState) => void;
}) {
  return (
    <div
      className={
        hideLabels
          ? "directory-filters directory-filters-labels-hidden usage-records-control-row"
          : "directory-filters usage-records-control-row"
      }
    >
      {leading}
      <label className="usage-filter">
        {!hideLabels && <span>状态</span>}
        <Select
          value={value.status}
          disabled={loading}
          onValueChange={(status: string) => onChange({ ...value, status })}
        >
          <SelectTrigger className="usage-select" aria-label="按用户状态筛选">
            <SelectValue placeholder="全部状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="__all__">全部状态</SelectItem>
              <SelectItem value="active">正常</SelectItem>
              <SelectItem value="disabled">已禁用</SelectItem>
              <SelectItem value="deleted">已删除</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </label>
      <label className="usage-filter">
        {!hideLabels && <span>角色</span>}
        <Select
          value={value.role}
          disabled={loading}
          onValueChange={(role: string) => onChange({ ...value, role })}
        >
          <SelectTrigger className="usage-select" aria-label="按用户角色筛选">
            <SelectValue placeholder="全部角色" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="__all__">全部角色</SelectItem>
              <SelectItem value="系统管理员">系统管理员</SelectItem>
              <SelectItem value="部门管理员">部门管理员</SelectItem>
              <SelectItem value="普通用户">普通用户</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </label>
      <label className="usage-filter">
        {!hideLabels && <span>部门</span>}
        <Select
          value={value.departmentId}
          disabled={loading}
          onValueChange={(departmentId: string) => onChange({ ...value, departmentId })}
        >
          <SelectTrigger className="usage-select" aria-label="按部门筛选">
            <SelectValue placeholder="全部部门" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="__all__">全部部门</SelectItem>
              {departments.map((department) => (
                <SelectItem key={department.id} value={department.id}>
                  {formatDepartmentName(department.name, department.id)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </label>
      <label className="usage-filter">
        {!hideLabels && <span>排序</span>}
        <Select
          value={value.sortBy}
          disabled={loading}
          onValueChange={(sortBy: string) =>
            onChange({ ...value, sortBy: sortBy as AdminUserSortKey })
          }
        >
          <SelectTrigger className="usage-select" aria-label="排序字段">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {directorySortOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </label>
      <label className="usage-filter">
        {!hideLabels && <span>顺序</span>}
        <Select
          value={value.sortOrder}
          disabled={loading}
          onValueChange={(sortOrder: string) =>
            onChange({ ...value, sortOrder: sortOrder as "asc" | "desc" })
          }
        >
          <SelectTrigger className="usage-select" aria-label="排序顺序">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="desc">降序</SelectItem>
              <SelectItem value="asc">升序</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </label>
      <div className="directory-filter-actions">
        <Button
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() =>
            onChange({
              search: "",
              departmentId: "__all__",
              status: "__all__",
              role: "__all__",
              sortBy: defaultSortBy,
              sortOrder: "desc",
            })
          }
        >
          清除筛选
        </Button>
      </div>
      <label className="usage-filter usage-search-filter">
        {!hideLabels && <span>搜索</span>}
        <div className="usage-search">
          <SearchIcon aria-hidden="true" />
          <Input
            aria-label="搜索用户、Open ID 或部门"
            value={value.search}
            placeholder="搜索用户、Open ID 或部门"
            onChange={(event) => onChange({ ...value, search: event.target.value })}
          />
        </div>
      </label>
    </div>
  );
}

export function AdminClient() {
  const [data, setData] = useState<AdminOverviewResponse | null>(null);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [adminUsersTotal, setAdminUsersTotal] = useState(0);
  const [adminUsersTruncated, setAdminUsersTruncated] = useState(false);
  const [adminUserDepartments, setAdminUserDepartments] = useState<
    Array<{ id: string; name?: string }>
  >([]);
  const [adminUserFilters, setAdminUserFilters] = useState<DirectoryFiltersState>({
    search: "",
    departmentId: "__all__",
    status: "__all__",
    role: "__all__",
    sortBy: "latestActivity",
    sortOrder: "desc",
  });
  const deferredAdminUserFilters = useDebouncedValue(adminUserFilters);
  const [adminScopes, setAdminScopes] = useState<AdminScopeRecord[]>([]);
  const [userStats, setUserStats] = useState<UserStatsRow[]>([]);
  const [userStatsTotal, setUserStatsTotal] = useState(0);
  const [userStatsTruncated, setUserStatsTruncated] = useState(false);
  const [userStatsDepartments, setUserStatsDepartments] = useState<
    Array<{ id: string; name?: string }>
  >([]);
  const [userStatsFilters, setUserStatsFilters] = useState<DirectoryFiltersState>({
    search: "",
    departmentId: "__all__",
    status: "__all__",
    role: "__all__",
    sortBy: "quotaConsumed",
    sortOrder: "desc",
  });
  const deferredUserStatsFilters = useDebouncedValue(userStatsFilters);
  const [departmentStats, setDepartmentStats] = useState<DepartmentStatsRow[]>([]);
  const [departmentQuotaData, setDepartmentQuotaData] =
    useState<PackageManagementResponse | null>(null);
  const [departmentPolicyDrafts, setDepartmentPolicyDrafts] = useState<
    Record<
      string,
      {
        quotaLimit: string;
        currentPackageQuota: string;
        nextPackageQuota: string;
      }
    >
  >({});
  const [packageLimitRequestDrafts, setPackageLimitRequestDrafts] = useState<
    Record<string, { requestedQuotaLimit: string; reason: string }>
  >({});
  const [packageLimitDecisionDrafts, setPackageLimitDecisionDrafts] = useState<
    Record<string, string>
  >({});
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
    enabled: true,
    dayOfMonth: "1",
  });
  const [newapiControlDraft, setNewapiControlDraft] = useState({
    baseUrl: "",
    controlUserId: "",
    accessToken: "",
  });
  const [quotaDrafts, setQuotaDrafts] = useState<Record<string, string>>({});
  const [adminUsersPage, setAdminUsersPage] = useState(1);
  const [adminUsersPageSize, setAdminUsersPageSize] = useState(10);
  const [userStatsPage, setUserStatsPage] = useState(1);
  const [userStatsPageSize, setUserStatsPageSize] = useState(20);
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
          enabled: body.settings.packageReset?.enabled ?? true,
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
      const params = new URLSearchParams({
        limit: String(adminUsersPageSize),
        offset: String((adminUsersPage - 1) * adminUsersPageSize),
        sortBy: deferredAdminUserFilters.sortBy,
        sortOrder: deferredAdminUserFilters.sortOrder,
      });
      appendUsageParam(params, "search", deferredAdminUserFilters.search);
      appendUsageParam(params, "departmentId", deferredAdminUserFilters.departmentId);
      appendUsageParam(params, "status", deferredAdminUserFilters.status);
      appendUsageParam(params, "role", deferredAdminUserFilters.role);
      const res = await fetch(`/api/admin/users?${params.toString()}`, {
        cache: "no-store",
      });
      const body = await readJsonResponse<AdminUsersResponse>(res);
      if (!res.ok) throw new Error(body.error ?? "读取用户管理失败");
      setAdminUsers(body.users);
      setAdminUsersTotal(body.total ?? body.users.length);
      setAdminUsersTruncated(body.truncated === true);
      setAdminUserDepartments(body.filters?.departments ?? []);
      setQuotaDrafts((current) => ({
        ...Object.fromEntries(
          body.users.map((user) => [
            user.id,
            current[user.id] ?? String(user.packageQuota ?? ""),
          ]),
        ),
        ...current,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取用户管理失败");
    } finally {
      setPanelLoading(false);
    }
  }, [deferredAdminUserFilters, adminUsersPage, adminUsersPageSize]);

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
      const params = new URLSearchParams({
        limit: String(userStatsPageSize),
        offset: String((userStatsPage - 1) * userStatsPageSize),
        sortBy: deferredUserStatsFilters.sortBy,
        sortOrder: deferredUserStatsFilters.sortOrder,
      });
      appendUsageParam(params, "search", deferredUserStatsFilters.search);
      appendUsageParam(params, "departmentId", deferredUserStatsFilters.departmentId);
      appendUsageParam(params, "status", deferredUserStatsFilters.status);
      appendUsageParam(params, "role", deferredUserStatsFilters.role);
      const res = await fetch(`/api/admin/user-stats?${params.toString()}`, {
        cache: "no-store",
      });
      const body = await readJsonResponse<UserStatsResponse>(res);
      if (!res.ok) throw new Error(body.error ?? "读取用户统计失败");
      setUserStats(body.stats);
      setUserStatsTotal(body.total ?? body.stats.length);
      setUserStatsTruncated(body.truncated === true);
      setUserStatsDepartments(body.filters?.departments ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取用户统计失败");
    } finally {
      setPanelLoading(false);
    }
  }, [deferredUserStatsFilters, userStatsPage, userStatsPageSize]);

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
  }, [adminUserFilters, adminUsersPage, adminUsersPageSize]);

  const applyDepartmentQuotaData = useCallback((body: PackageManagementResponse) => {
    setDepartmentQuotaData(body);
    setDepartmentPolicyDrafts((current) => ({
      ...Object.fromEntries(
        body.packages.map((department) => [
          department.departmentId,
          current[department.departmentId] ?? {
            quotaLimit: String(department.totalQuotaLimit),
            currentPackageQuota: String(department.currentPackageQuota),
            nextPackageQuota: String(department.nextPackageQuota),
          },
        ]),
      ),
      ...current,
    }));
    setPackageLimitRequestDrafts((current) => ({
      ...Object.fromEntries(
        body.packages.map((department) => [
          department.departmentId,
          current[department.departmentId] ?? {
            requestedQuotaLimit: String(
              Math.max(
                department.totalQuotaLimit + 1,
                Math.ceil(
                  department.allocatedQuota + department.pendingReservedQuota,
                ),
              ),
            ),
            reason: "",
          },
        ]),
      ),
      ...current,
    }));
    setPackageLimitDecisionDrafts((current) => ({
      ...Object.fromEntries(
        body.requests.map((quotaRequest) => [
          quotaRequest.id,
          current[quotaRequest.id] ??
            String(
              quotaRequest.approvedQuotaLimit ??
                quotaRequest.requestedQuotaLimit ??
                quotaRequest.currentQuotaLimit,
            ),
        ]),
      ),
      ...current,
    }));
  }, []);

  const loadDepartmentQuota = useCallback(async () => {
    setPanelLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/packages", { cache: "no-store" });
      const body = await readJsonResponse<PackageManagementResponse>(res);
      if (!res.ok) throw new Error(body.error ?? "读取部门额度失败");
      applyDepartmentQuotaData(body);
      await loadDepartmentMemberSyncOperations();
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取部门额度失败");
    } finally {
      setPanelLoading(false);
    }
  }, [applyDepartmentQuotaData, loadDepartmentMemberSyncOperations]);

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
      const [res, packageRes] = await Promise.all([
        fetch(`/api/admin/token-requests?${params.toString()}`, { cache: "no-store" }),
        fetch("/api/admin/packages", { cache: "no-store" }),
      ]);
      const [body, packageBody] = await Promise.all([
        readJsonResponse<AdminTokenRequestsResponse>(res),
        readJsonResponse<PackageManagementResponse>(packageRes),
      ]);
      if (!res.ok) throw new Error(body.error ?? "读取审批申请失败");
      if (!packageRes.ok) {
        throw new Error(packageBody.error ?? "读取总额度上限提升申请失败");
      }
      setApprovalRequests(body.requests);
      setApprovalTotalRequests(body.total ?? body.requests.length);
      applyDepartmentQuotaData(packageBody);
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
  }, [applyDepartmentQuotaData, approvalPage, approvalPageSize]);

  useEffect(() => {
    if (panel !== "packages") return;
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
    if (panel === "packages") void loadDepartmentQuota();
    if (panel === "departmentStats" && isSystemAdmin) void loadDepartmentStats();
    if (panel === "usageRecords") void loadUsageRecords();
    if (panel === "approvals") void loadApprovalRequests();
  }, [
    data?.authorized,
    isRootAdmin,
    isSystemAdmin,
    loadApprovalRequests,
    loadAdminScopes,
    loadAdminUsers,
    loadDepartmentStats,
    loadDepartmentQuota,
    loadUsageRecords,
    loadUserStats,
    panel,
  ]);

  useEffect(() => {
    setUsagePage(1);
  }, [usageFilters, usageHideUnknownRecords, usagePageSize]);

  useEffect(() => {
    setAdminUsersPage(1);
  }, [adminUserFilters, adminUsersPageSize]);

  useEffect(() => {
    setUserStatsPage(1);
  }, [userStatsFilters, userStatsPageSize]);

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
      setMessage("已通过飞书身份自动登录。");
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
    const approvalRequest = approvalRequests.find((request) => request.id === requestId);
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
      setMessage(
        action === "approve"
          ? approvalRequest?.requestType === "quota_adjust"
            ? "审批已通过，已触发额度调整。"
            : "审批已通过，已触发发放。"
          : "申请已拒绝。",
      );
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
      setError("额度上限必须是正整数");
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
          reason: `管理后台设置额度上限为 ${approvedMonthlyQuota}`,
          clientRequestId: window.crypto.randomUUID(),
        }),
      });
      const body = await res.json().catch(() => ({})) as {
        error?: string;
        mode?: "first_provision" | "quota_adjust";
      };
      if (!res.ok) throw new Error(body.error ?? "更改额度失败");
      setMessage(
        body.mode === "first_provision"
          ? "首次 Key 与额度已完成发放。"
          : "额度上限更改已受理；申请状态变为“已发放”后生效。",
      );
      await Promise.all([refresh(), loadAdminUsers(), loadUserStats(), loadDepartmentQuota()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "更改额度失败");
    } finally {
      setBusy(false);
    }
  }

  async function saveDepartmentPolicy(
    departmentId: string,
    field: "quotaLimit" | "currentPackageQuota" | "nextPackageQuota",
  ) {
    const draft = departmentPolicyDrafts[departmentId];
    const value = Number(draft?.[field]);
    if (!Number.isInteger(value) || value < (field === "quotaLimit" ? 0 : 1)) {
      setError(
        field === "quotaLimit"
          ? "部门总额度上限必须是非负整数"
          : "套餐额度必须是正整数",
      );
      return;
    }
    const currentPackage = departmentQuotaData?.packages.find(
      (item) => item.departmentId === departmentId,
    );
    if (
      field === "currentPackageQuota" &&
      currentPackage &&
      value <= currentPackage.currentPackageQuota
    ) {
      setError(`本周期套餐额度只能调高，当前为 ${currentPackage.currentPackageQuota}`);
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/packages", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          departmentId,
          action:
            field === "quotaLimit"
              ? "set_total_limit"
              : field === "currentPackageQuota"
                ? "increase_current_package"
                : "set_next_package",
          ...(field === "quotaLimit"
            ? { totalQuotaLimit: value }
            : { packageQuota: value }),
          ...(field === "currentPackageQuota"
            ? { clientRequestId: window.crypto.randomUUID() }
            : {}),
        }),
      });
      const body = await readJsonResponse<{ package?: unknown }>(res);
      if (!res.ok) throw new Error(body.error ?? "保存套餐设置失败");
      setMessage(
        field === "quotaLimit"
          ? "部门总额度上限已保存。"
          : field === "currentPackageQuota"
            ? "本周期套餐提高已受理，将按用户正差额即时更改额度上限并占用本周期预算。"
            : "下一周期套餐额度已保存，将在下个套餐周期生效。",
      );
      setDepartmentPolicyDrafts((current) => {
        const next = { ...current };
        delete next[departmentId];
        return next;
      });
      await loadDepartmentQuota();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存套餐设置失败");
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

  async function requestPackageLimitIncrease(departmentId: string) {
    const draft = packageLimitRequestDrafts[departmentId];
    const requestedQuotaLimit = Number(draft?.requestedQuotaLimit);
    if (!Number.isInteger(requestedQuotaLimit) || requestedQuotaLimit <= 0) {
      setError("申请的总额度上限必须是正整数");
      return;
    }
    if (!draft?.reason.trim() || draft.reason.trim().length < 4) {
      setError("请填写至少 4 个字的申请理由");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/packages/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestedQuotaLimit,
          reason: draft.reason.trim(),
        }),
      });
      const body = await readJsonResponse<{ notice?: string }>(res);
      if (!res.ok) throw new Error(body.error ?? "提交总额度上限提升申请失败");
      setMessage(body.notice ?? "总额度上限提升申请已发送给 root 和系统管理员。");
      setPackageLimitRequestDrafts((current) => ({
        ...current,
        [departmentId]: {
          requestedQuotaLimit: String(requestedQuotaLimit),
          reason: "",
        },
      }));
      await loadApprovalRequests();
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交总额度上限提升申请失败");
    } finally {
      setBusy(false);
    }
  }

  async function decidePackageLimitRequest(
    requestId: string,
    action: "approve" | "reject",
  ) {
    const approvedQuotaLimit = Number(packageLimitDecisionDrafts[requestId]);
    if (
      action === "approve" &&
      (!Number.isInteger(approvedQuotaLimit) || approvedQuotaLimit <= 0)
    ) {
      setError("通过申请前需要填写正整数总额度上限");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(
        `/api/admin/packages/requests/${encodeURIComponent(requestId)}/decision`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action,
            approvedQuotaLimit:
              action === "approve" ? approvedQuotaLimit : undefined,
          }),
        },
      );
      const body = await readJsonResponse<Record<string, never>>(res);
      if (!res.ok) throw new Error(body.error ?? "处理总额度上限提升申请失败");
      setMessage(action === "approve" ? "总额度上限提升申请已通过。" : "总额度上限提升申请已拒绝。");
      await loadApprovalRequests();
    } catch (err) {
      setError(err instanceof Error ? err.message : "处理总额度上限提升申请失败");
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
      setMessage("管理员权限已取消，用户已回退为普通已发 Key 用户。");
      await Promise.all([loadAdminScopes(), loadAdminUsers()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "取消管理员失败");
    } finally {
      setBusy(false);
    }
  }

  async function disableUser(user: AdminUser) {
    if (!window.confirm(`确认禁用 ${user.name ?? maskSecret(user.openId)}？用户将无法登录使用，需等待管理员解禁。`)) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}/disable`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "管理后台禁用用户" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "禁用用户失败");
      setMessage("用户已禁用；Key 与消费记录均已保留，等待管理员解禁。");
      await loadAdminUsers();
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
      await loadAdminUsers();
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
      setMessage("用户已删除，重新使用需再次申请。");
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

  const adminUsersPageCount = Math.max(Math.ceil(adminUsersTotal / adminUsersPageSize), 1);
  const currentAdminUsersPage = Math.min(adminUsersPage, adminUsersPageCount);
  const userStatsPageCount = Math.max(Math.ceil(userStatsTotal / userStatsPageSize), 1);
  const currentUserStatsPage = Math.min(userStatsPage, userStatsPageCount);
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
                className={panel === "approvals" ? "nav-item active nav-button" : "nav-item nav-button"}
                type="button"
                onClick={() => selectPanel("approvals")}
              >
                <CheckCircle2Icon data-icon="inline-start" />
                审批处理
              </button>
              <button
                className={
                  panel === "packages" ? "nav-item active nav-button" : "nav-item nav-button"
                }
                type="button"
                onClick={() => selectPanel("packages")}
              >
                <Building2Icon data-icon="inline-start" />
                部门额度管理
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
              返回用户后台
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
                      <span className="metric-value">{totals?.users ?? 0}</span>
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
                      <span className="metric-label">请求数</span>
                      <span className="metric-value">{totals?.requestCount ?? 0}</span>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent>
                    <div className="metric">
                      <span className="metric-label">当前套餐周期 tokens</span>
                      <span className="metric-value">{formatTokenAmount(totals?.totalTokens, "0")}</span>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent>
                    <div className="metric">
                      <span className="metric-label">当前套餐额度</span>
                      <span className="metric-value">{formatQuotaAmount(totals?.packageQuota, "0")}</span>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent>
                    <div className="metric">
                      <span className="metric-label">当前套餐周期已用额度</span>
                      <span className="metric-value">{formatQuotaAmount(totals?.quotaConsumed, "0")}</span>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent>
                    <div className="metric">
                      <span className="metric-label">当前套餐周期剩余额度</span>
                      <span className="metric-value">{formatQuotaAmount(totals?.remainingQuota, "0")}</span>
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
                    <Badge>{adminUsersTotal} 个用户</Badge>
                    {adminUsersTotal > 0 && (
                      <Badge>
                        第 {currentAdminUsersPage} / {adminUsersPageCount} 页
                      </Badge>
                    )}
                    {adminUsersTruncated && <Badge variant="warning">上游日志已达查询上限</Badge>}
                  </div>
                  <DirectoryFilters
                    value={adminUserFilters}
                    departments={adminUserDepartments}
                    loading={panelLoading}
                    onChange={setAdminUserFilters}
                  />
                  {!adminUsers.length ? (
                    <div className="empty">
                      {panelLoading ? "读取用户中" : "暂无符合当前筛选条件的用户"}
                    </div>
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
                              <th>套餐上限</th>
                              <th>剩余额度</th>
                              <th>已用额度</th>
                              <th>Tokens</th>
                              <th>最近调用</th>
                              <th>操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {adminUsers.map((user) => (
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
                                <td>{formatQuotaAmount(user.packageQuota)}</td>
                                <td>{formatQuotaAmount(user.remainingQuota)}</td>
                                <td>{formatQuotaAmount(user.quotaConsumed, "0")}</td>
                                <td>{formatTokenAmount(user.totalTokens, "0")}</td>
                                <td>{user.latestActivityAt ? formatDateTime(user.latestActivityAt) : "-"}</td>
                                <td>
                                  <div className="user-management-actions">
                                    {!user.isGlobalAdmin || isRootAdmin ? (
                                      <>
                                        <div className="user-management-action-primary">
                                          <div className="quota-control">
                                            <Input
                                              aria-label={`${user.name ?? user.openId} 额度上限`}
                                              min={Math.max(1, Math.ceil(user.quotaConsumed ?? 0))}
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
                                              更改额度
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
                      <PageSelector
                        className="admin-users-pagination"
                        currentPage={currentAdminUsersPage}
                        pageCount={adminUsersPageCount}
                        pageSize={adminUsersPageSize}
                        pageSizeOptions={[10, 20, 50, 100]}
                        totalRecords={adminUsersTotal}
                        loading={panelLoading}
                        onPageChange={setAdminUsersPage}
                        onPageSizeChange={(pageSize) => {
                          setAdminUsersPageSize(pageSize);
                          setAdminUsersPage(1);
                        }}
                      />
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

          {panel === "packages" && (
            <section className="stack department-quota-management">
              <Card className="compact-admin-card">
                <CardHeader>
                  <CardTitle>部门额度管理</CardTitle>
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
                    <Badge>{departmentQuotaData?.packages.length ?? 0} 个部门</Badge>
                  </div>
                  {!departmentQuotaData?.packages.length ? (
                    <div className="empty">{panelLoading ? "读取部门额度中" : "暂无可管理的部门"}</div>
                  ) : (
                    <div className="table-wrap">
                      <table className="table department-quota-summary-table">
                        <colgroup>
                          <col className="department-quota-col-name" />
                          <col className="department-quota-col-members" />
                          <col className="department-quota-col-control" />
                          <col className="department-quota-col-number" />
                          <col className="department-quota-col-number" />
                          <col className="department-quota-col-number" />
                        </colgroup>
                        <thead>
                          <tr>
                            <th>部门</th>
                            <th>成员 / 已发</th>
                            <th>当前总上限</th>
                            <th>已发放</th>
                            <th>可用</th>
                            <th>预留</th>
                          </tr>
                        </thead>
                        <tbody>
                          {departmentQuotaData.packages.map((department) => {
                            const draft = departmentPolicyDrafts[department.departmentId] ?? {
                              quotaLimit: String(department.totalQuotaLimit),
                              currentPackageQuota: String(department.currentPackageQuota),
                              nextPackageQuota: String(department.nextPackageQuota),
                            };
                            const departmentLabel =
                              department.departmentName?.trim() || "未命名部门";
                            const syncOperation =
                              departmentMemberSyncOperations[department.departmentId];
                            const syncActive = Boolean(
                              syncOperation &&
                                ["pending", "running"].includes(syncOperation.status),
                            );
                            return (
                              <tr key={department.departmentId}>
                                <td data-label="部门">
                                  <strong>{departmentLabel}</strong>
                                </td>
                                <td data-label="成员 / 已发">
                                  <div className="department-member-cell">
                                    <strong>{department.memberCount} / {department.keyedUsers}</strong>
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
                                  </div>
                                  {syncOperation && (
                                    <span className="department-member-status" title={syncOperation.errorMessage}>
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
                                </td>
                                <td data-label="当前总上限">
                                  {isSystemAdmin ? (
                                    <div className="quota-control quota-control-icon-action">
                                      <Input
                                        aria-label={departmentLabel + " 当前总额度上限"}
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
                                    formatQuotaAmount(department.totalQuotaLimit, "0")
                                  )}
                                </td>
                                <td data-label="已发放">{formatQuotaAmount(department.allocatedQuota, "0")}</td>
                                <td data-label="可用">{formatQuotaAmount(department.availableQuota, "0")}</td>
                                <td data-label="预留">{formatQuotaAmount(department.pendingReservedQuota, "0")}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                </CardContent>
              </Card>

              <Card className="compact-admin-card">
                <CardHeader>
                  <CardTitle>部门套餐额度</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="toolbar toolbar-left department-package-periods">
                    <Badge>本周期 {departmentQuotaData?.currentPeriod ?? currentBillingPeriod()}</Badge>
                    <Badge>下一周期 {departmentQuotaData?.nextPeriod ?? "-"}</Badge>
                  </div>
                  {!departmentQuotaData?.packages.length ? (
                    <div className="empty">{panelLoading ? "读取套餐额度中" : "暂无可管理的部门套餐"}</div>
                  ) : (
                    <div className="table-wrap">
                      <table className="table department-package-table">
                        <thead>
                          <tr>
                            <th>部门</th>
                            <th>本周期套餐额度</th>
                            <th>下一周期套餐额度</th>
                          </tr>
                        </thead>
                        <tbody>
                          {departmentQuotaData.packages.map((department) => {
                            const draft = departmentPolicyDrafts[department.departmentId] ?? {
                              quotaLimit: String(department.totalQuotaLimit),
                              currentPackageQuota: String(department.currentPackageQuota),
                              nextPackageQuota: String(department.nextPackageQuota),
                            };
                            const departmentLabel =
                              department.departmentName?.trim() || "未命名部门";
                            return (
                              <tr key={department.departmentId}>
                                <td data-label="部门">
                                  <strong>{departmentLabel}</strong>
                                </td>
                                <td data-label="本周期套餐额度">
                                  <div className="quota-control quota-control-icon-action">
                                    <Input
                                      aria-label={departmentLabel + " 本周期套餐额度"}
                                      min={department.currentPackageQuota + 1}
                                      max={1_000_000}
                                      step={1}
                                      type="number"
                                      value={draft.currentPackageQuota}
                                      disabled={busy}
                                      onChange={(event) =>
                                        setDepartmentPolicyDrafts((current) => ({
                                          ...current,
                                          [department.departmentId]: {
                                            ...draft,
                                            currentPackageQuota: event.target.value,
                                          },
                                        }))
                                      }
                                    />
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      aria-label="调高本周期套餐额度"
                                      title="调高本周期套餐额度并即时更改已发 Key 用户的额度上限"
                                      disabled={busy}
                                      onClick={() =>
                                        void saveDepartmentPolicy(
                                          department.departmentId,
                                          "currentPackageQuota",
                                        )
                                      }
                                    >
                                      <SaveIcon data-icon="inline-start" />
                                    </Button>
                                  </div>
                                </td>
                                <td data-label="下一周期套餐额度">
                                  <div className="quota-control quota-control-icon-action">
                                    <Input
                                      aria-label={departmentLabel + " 下一周期套餐额度"}
                                      min={1}
                                      max={1_000_000}
                                      step={1}
                                      type="number"
                                      value={draft.nextPackageQuota}
                                      disabled={busy}
                                      onChange={(event) =>
                                        setDepartmentPolicyDrafts((current) => ({
                                          ...current,
                                          [department.departmentId]: {
                                            ...draft,
                                            nextPackageQuota: event.target.value,
                                          },
                                        }))
                                      }
                                    />
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      aria-label="保存下一周期套餐额度"
                                      title="保存下一周期套餐额度"
                                      disabled={busy}
                                      onClick={() =>
                                        void saveDepartmentPolicy(
                                          department.departmentId,
                                          "nextPackageQuota",
                                        )
                                      }
                                    >
                                      <SaveIcon data-icon="inline-start" />
                                    </Button>
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
            </section>
          )}

          {panel === "departmentStats" && isSystemAdmin && (
            <Card>
              <CardHeader>
                <CardTitle>部门统计</CardTitle>
                <CardDescription>仅系统管理员可见，按当前套餐周期聚合 NewAPI 权威余额与日志。</CardDescription>
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
                          <th>已发放总额度</th>
                          <th>总额度上限</th>
                          <th>剩余额度</th>
                          <th>已用额度</th>
                          <th>Tokens</th>
                          <th>请求数</th>
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
                            <td>{formatQuotaAmount(item.issuedQuota, "0")}</td>
                            <td>{formatQuotaAmount(item.totalQuotaLimit, "0")}</td>
                            <td>{formatQuotaAmount(item.remainingQuota, "0")}</td>
                            <td>{formatQuotaAmount(item.quotaConsumed, "0")}</td>
                            <td>{formatTokenAmount(item.totalTokens, "0")}</td>
                            <td>{item.requestCount}</td>
                            <td>{formatRate(item.quotaUsageRate)}</td>
                            <td>{item.latestActivityAt ? formatDateTime(item.latestActivityAt) : "-"}</td>
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
            <Card className="compact-admin-card user-stats-card">
              <CardHeader>
                <CardTitle>用户统计</CardTitle>
              </CardHeader>
              <CardContent>
                <DirectoryFilters
                  value={userStatsFilters}
                  departments={userStatsDepartments}
                  loading={panelLoading}
                  defaultSortBy="quotaConsumed"
                  hideLabels
                  leading={
                    <div className="directory-filter-leading">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={panelLoading}
                        onClick={() => void loadUserStats()}
                      >
                        <RefreshCwIcon data-icon="inline-start" />
                        刷新统计
                      </Button>
                      <Badge>{userStatsTotal} 个用户</Badge>
                      {userStatsTruncated && (
                        <Badge variant="warning">上游日志已达查询上限</Badge>
                      )}
                    </div>
                  }
                  onChange={setUserStatsFilters}
                />
                {!userStats.length ? (
                  <div className="empty">
                    {panelLoading ? "读取用户统计中" : "暂无符合当前筛选条件的用户统计"}
                  </div>
                ) : (
                  <>
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>用户</th>
                            <th>部门</th>
                            <th>角色</th>
                            <th>周期</th>
                            <th>套餐上限</th>
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
                              <td>{user.packagePeriod ?? "-"}</td>
                              <td>{formatQuotaAmount(user.packageQuota, "0")}</td>
                              <td>{formatQuotaAmount(user.remainingQuota)}</td>
                              <td>{formatQuotaAmount(user.quotaConsumed, "0")}</td>
                              <td>{formatTokenAmount(user.promptTokens, "0")}</td>
                              <td>{formatTokenAmount(user.completionTokens, "0")}</td>
                              <td>{formatTokenAmount(user.totalTokens, "0")}</td>
                              <td>{user.requestCount}</td>
                              <td>{formatRate(user.quotaUsageRate)}</td>
                              <td>{user.latestActivityAt ? formatDateTime(user.latestActivityAt) : "-"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <PageSelector
                      className="user-stats-pagination"
                      currentPage={currentUserStatsPage}
                      pageCount={userStatsPageCount}
                      pageSize={userStatsPageSize}
                      pageSizeOptions={[10, 20, 50, 100]}
                      totalRecords={userStatsTotal}
                      loading={panelLoading}
                      onPageChange={setUserStatsPage}
                      onPageSizeChange={(pageSize) => {
                        setUserStatsPageSize(pageSize);
                        setUserStatsPage(1);
                      }}
                    />
                  </>
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
                      />
                    </div>
                  </CardContent>
                )}
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>使用记录</CardTitle>
                  <CardDescription>直接按 NewAPI 日志展示请求、tokens、额度消耗和首字/总耗时。</CardDescription>
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
            <section className="stack approval-management">
              {!isSystemAdmin && !!departmentQuotaData?.packages.length && (
                <Card className="compact-admin-card approval-limit-request-card">
                  <CardHeader>
                    <CardTitle>申请提升总额度上限</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {departmentQuotaData.packages.map((department) => {
                      const draft = packageLimitRequestDrafts[department.departmentId] ?? {
                        requestedQuotaLimit: String(department.totalQuotaLimit + 1),
                        reason: "",
                      };
                      const departmentLabel =
                        department.departmentName?.trim() || "未命名部门";
                      return (
                        <section
                          className="package-limit-request-panel approval-limit-request-panel"
                          key={"request-" + department.departmentId}
                        >
                          <div className="meta-stack">
                            <strong>{departmentLabel}</strong>
                            <span>
                              当前上限 {formatQuotaAmount(department.totalQuotaLimit, "0")}
                            </span>
                          </div>
                          <div className="package-limit-request-controls">
                            <label className="field">
                              <span>目标总额度上限</span>
                              <Input
                                aria-label={departmentLabel + " 目标总额度上限"}
                                type="number"
                                min={department.totalQuotaLimit + 1}
                                max={1_000_000}
                                step={1}
                                value={draft.requestedQuotaLimit}
                                disabled={busy}
                                onChange={(event) =>
                                  setPackageLimitRequestDrafts((current) => ({
                                    ...current,
                                    [department.departmentId]: {
                                      ...draft,
                                      requestedQuotaLimit: event.target.value,
                                    },
                                  }))
                                }
                              />
                            </label>
                            <label className="field package-limit-reason-field">
                              <span>申请理由</span>
                              <Input
                                aria-label={departmentLabel + " 总额度申请理由"}
                                value={draft.reason}
                                maxLength={500}
                                placeholder="说明预算不足的原因"
                                disabled={busy}
                                onChange={(event) =>
                                  setPackageLimitRequestDrafts((current) => ({
                                    ...current,
                                    [department.departmentId]: {
                                      ...draft,
                                      reason: event.target.value,
                                    },
                                  }))
                                }
                              />
                            </label>
                            <Button
                              disabled={busy}
                              onClick={() =>
                                void requestPackageLimitIncrease(department.departmentId)
                              }
                            >
                              发送申请
                            </Button>
                          </div>
                        </section>
                      );
                    })}
                  </CardContent>
                </Card>
              )}

              <Card className="approval-list-card">
                <CardHeader>
                  <div className="section-heading-row approval-heading-row">
                    <CardTitle>审批处理</CardTitle>
                    <Badge>
                      {approvalTotalRequests + (departmentQuotaData?.requests.length ?? 0)} 条
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  {!approvalRequests.length && !departmentQuotaData?.requests.length ? (
                    <div className="empty">
                      {panelLoading ? "读取审批申请中" : "暂无可查看申请"}
                    </div>
                  ) : (
                    <>
                      {!!approvalRequests.length && (
                        <section className="approval-group">
                          <div className="section-heading-row">
                            <h3>用户额度申请</h3>
                            <Badge>{approvalTotalRequests} 条</Badge>
                          </div>
                          <div className="table-wrap">
                            <table className="table approval-request-table">
                              <thead>
                                <tr>
                                  <th>申请人</th>
                                  <th>类型</th>
                                  <th>状态</th>
                                  <th>处理人</th>
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
                                    <td>{approvalOperatorLabel(request)}</td>
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
                        </section>
                      )}

                      {!!departmentQuotaData?.requests.length && (
                        <section className="approval-group">
                          <div className="section-heading-row">
                            <h3>总额度上限提升申请</h3>
                            <Badge>{departmentQuotaData.requests.length} 条</Badge>
                          </div>
                          <div className="table-wrap">
                            <table className="table package-limit-request-table">
                              <thead>
                                <tr>
                                  <th>申请人 / 部门</th>
                                  <th>类型</th>
                                  <th>状态</th>
                                  <th>处理人</th>
                                  <th>当前上限</th>
                                  <th>申请上限</th>
                                  <th>最终上限</th>
                                  <th>申请理由</th>
                                  <th>错误</th>
                                  <th>更新时间</th>
                                  {isSystemAdmin && <th>操作</th>}
                                </tr>
                              </thead>
                              <tbody>
                                {departmentQuotaData.requests.map((quotaRequest) => {
                                  const pending = [
                                    "pending_card_send",
                                    "pending_card_approval",
                                    "approval_card_send_failed",
                                  ].includes(quotaRequest.status);
                                  const departmentLabel =
                                    quotaRequest.departmentName?.trim() || "未命名部门";
                                  return (
                                    <tr key={quotaRequest.id}>
                                      <td>
                                        <div className="meta-stack">
                                          <strong>
                                            {quotaRequest.requesterName ??
                                              maskSecret(quotaRequest.requesterOpenId)}
                                          </strong>
                                          <span>{departmentLabel}</span>
                                        </div>
                                      </td>
                                      <td>总额度上限</td>
                                      <td>
                                        <Badge variant={badgeVariant(quotaRequest.status)}>
                                          {statusLabel[quotaRequest.status] ?? quotaRequest.status}
                                        </Badge>
                                      </td>
                                      <td>{approvalOperatorLabel(quotaRequest)}</td>
                                      <td>{formatQuotaAmount(quotaRequest.currentQuotaLimit, "0")}</td>
                                      <td>{formatQuotaAmount(quotaRequest.requestedQuotaLimit, "-")}</td>
                                      <td>
                                        {isSystemAdmin && pending ? (
                                          <Input
                                            aria-label={"批准总额度上限-" + quotaRequest.id}
                                            type="number"
                                            min={quotaRequest.currentQuotaLimit + 1}
                                            max={1_000_000}
                                            step={1}
                                            value={packageLimitDecisionDrafts[quotaRequest.id] ?? ""}
                                            disabled={busy}
                                            onChange={(event) =>
                                              setPackageLimitDecisionDrafts((current) => ({
                                                ...current,
                                                [quotaRequest.id]: event.target.value,
                                              }))
                                            }
                                          />
                                        ) : (
                                          formatQuotaAmount(quotaRequest.approvedQuotaLimit, "-")
                                        )}
                                      </td>
                                      <td title={quotaRequest.reason}>{quotaRequest.reason}</td>
                                      <td>
                                        {quotaRequest.errorMessage
                                          ? maskSecret(quotaRequest.errorMessage)
                                          : "-"}
                                      </td>
                                      <td>{formatDateTime(quotaRequest.updatedAt)}</td>
                                      {isSystemAdmin && (
                                        <td>
                                          <div className="toolbar toolbar-left">
                                            <Button
                                              variant="outline"
                                              size="sm"
                                              disabled={busy || !pending}
                                              onClick={() =>
                                                void decidePackageLimitRequest(
                                                  quotaRequest.id,
                                                  "approve",
                                                )
                                              }
                                            >
                                              通过
                                            </Button>
                                            <Button
                                              variant="outline"
                                              size="sm"
                                              disabled={busy || !pending}
                                              onClick={() =>
                                                void decidePackageLimitRequest(
                                                  quotaRequest.id,
                                                  "reject",
                                                )
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
                        </section>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            </section>
          )}


          {panel === "settings" && isSystemAdmin && (
            <Card>
              <CardHeader>
                <CardTitle>系统设置</CardTitle>
                <CardDescription>
                  管理 NewAPI 连接与套餐自动重置设置。
                </CardDescription>
              </CardHeader>
              <CardContent>
                {isRootAdmin && (
                  <section className="settings-section">
                    <div>
                      <h3>NewAPI 上游连接</h3>
                      <p>仅 root 可修改。保存后 Key 管理、余额与统计查询统一使用新配置。</p>
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
                        保存
                      </Button>
                    </div>
                  </section>
                )}

                <section className="settings-section">
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
                  </div>
                </section>

                <section className="settings-section">
                  <div>
                    <h3>套餐重置</h3>
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
