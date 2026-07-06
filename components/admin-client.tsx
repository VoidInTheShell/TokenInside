"use client";

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
import { FeishuSdkScript, loginWithFeishu } from "@/components/feishu-login";
import {
  UsageRecordsTable,
  type UsageRecordRow,
} from "@/components/usage-records-table";
import { formatDateTime, formatTokenAmount, maskSecret } from "@/lib/utils";

type AdminScopeSummary = {
  type: "global" | "department";
  departmentId?: string;
  source: "manual" | "department_supervisor" | "environment";
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
      currentPeriodRemainingQuota?: number;
      currentPeriodProxyLogs?: number;
      currentPeriodPromptTokens?: number;
      currentPeriodCompletionTokens?: number;
      currentPeriodTotalTokens?: number;
    };
    latestRequests: Array<{
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
      updatedAt: string;
      createdAt: string;
    }>;
  };
  settings?: {
    defaultMonthlyQuota: number;
    updatedAt?: string;
  };
};

type AdminPanel =
  | "overview"
  | "users"
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
  status: "active" | "disabled" | "deleted";
  role: string;
  activeTokenStatus?: string;
  activeTokenCreatedAt?: string;
  billingPeriod?: string;
  billingMonthlyQuota?: number;
  billingRemainingQuota?: number;
  billingTotalTokens?: number;
  billingPromptTokens?: number;
  billingCompletionTokens?: number;
  billingProxyLogCount?: number;
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

type UserStatsRow = {
  id: string;
  name?: string;
  openId: string;
  departmentId?: string;
  role: string;
  activeTokenStatus?: string;
  billingPeriod?: string;
  monthlyQuota: number;
  remainingQuota?: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  proxyLogCount: number;
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
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  proxyLogCount: number;
  usageShare: number;
  quotaUsageRate: number;
  latestProxyLogAt?: string;
};

type DepartmentStatsResponse = {
  departments: DepartmentStatsRow[];
  error?: string;
};

type UsageRecordsResponse = {
  records: UsageRecordRow[];
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
  key_reset: "key 重置",
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
  if (scope.type === "global") return "系统管理员";
  return "部门管理";
}

function displayName(user?: AdminOverviewResponse["user"]) {
  return user?.name || maskSecret(user?.openId) || "-";
}

function avatarInitial(user?: AdminOverviewResponse["user"]) {
  return displayName(user).trim().slice(0, 1).toUpperCase() || "T";
}

function canEditQuota(status: string) {
  return ["pending_card_send", "pending_card_approval", "approval_card_send_failed"].includes(status);
}

function canDecideRequest(status: string) {
  return [
    "pending_card_send",
    "pending_card_approval",
    "approval_card_send_failed",
    "approval_route_failed",
    "pending_feishu_approval",
    "approved_provision_failed",
  ].includes(status);
}

function formatRate(value?: number) {
  if (!Number.isFinite(value)) return "-";
  return `${Math.round((value ?? 0) * 1000) / 10}%`;
}

export function AdminClient() {
  const [data, setData] = useState<AdminOverviewResponse | null>(null);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [userStats, setUserStats] = useState<UserStatsRow[]>([]);
  const [departmentStats, setDepartmentStats] = useState<DepartmentStatsRow[]>([]);
  const [usageRecords, setUsageRecords] = useState<UsageRecordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [panelLoading, setPanelLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [panel, setPanel] = useState<AdminPanel>("overview");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [defaultQuotaDraft, setDefaultQuotaDraft] = useState("200");
  const [quotaDrafts, setQuotaDrafts] = useState<Record<string, string>>({});
  const [adminTargetOpenId, setAdminTargetOpenId] = useState("");
  const [adminDepartmentId, setAdminDepartmentId] = useState("");
  const [feishuSdkReady, setFeishuSdkReady] = useState(false);
  const [autoLoginAttempted, setAutoLoginAttempted] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/overview?mode=soft", { cache: "no-store" });
      const body = (await res.json()) as AdminOverviewResponse;
      setData(body);
      if (body.settings) {
        setDefaultQuotaDraft(String(body.settings.defaultMonthlyQuota));
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
      const body = (await res.json()) as AdminUsersResponse;
      if (!res.ok) throw new Error(body.error ?? "读取用户管理失败");
      setAdminUsers(body.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取用户管理失败");
    } finally {
      setPanelLoading(false);
    }
  }, []);

  const loadUserStats = useCallback(async () => {
    setPanelLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/user-stats", { cache: "no-store" });
      const body = (await res.json()) as UserStatsResponse;
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
      const body = (await res.json()) as DepartmentStatsResponse;
      if (!res.ok) throw new Error(body.error ?? "读取部门统计失败");
      setDepartmentStats(body.departments);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取部门统计失败");
    } finally {
      setPanelLoading(false);
    }
  }, []);

  const loadUsageRecords = useCallback(async () => {
    setPanelLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/usage-records?limit=200", { cache: "no-store" });
      const body = (await res.json()) as UsageRecordsResponse;
      if (!res.ok) throw new Error(body.error ?? "读取使用记录失败");
      setUsageRecords(body.records);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取使用记录失败");
    } finally {
      setPanelLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const overview = data?.overview;
  const totals = overview?.totals;
  const isSystemAdmin = overview?.scope.type === "global";

  useEffect(() => {
    if (!data?.authorized) return;
    if (panel === "users") void loadAdminUsers();
    if (panel === "userStats") void loadUserStats();
    if (panel === "departmentStats" && isSystemAdmin) void loadDepartmentStats();
    if (panel === "usageRecords") void loadUsageRecords();
  }, [
    data?.authorized,
    isSystemAdmin,
    loadAdminUsers,
    loadDepartmentStats,
    loadUsageRecords,
    loadUserStats,
    panel,
  ]);

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
      await refresh();
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
      await Promise.all([refresh(), loadAdminUsers()]);
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
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "调额失败");
      setMessage("额度已调整。");
      await Promise.all([refresh(), loadAdminUsers(), loadUserStats()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "调额失败");
    } finally {
      setBusy(false);
    }
  }

  async function assignAdmin(scopeType: "global" | "department") {
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
      await loadAdminUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "指派管理员失败");
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
              <div className="brand-mark">TI</div>
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
                  <span>{data?.user?.openId ? maskSecret(data.user.openId) : "-"}</span>
                </div>
                <div className="user-card-meta">
                  <span>管理范围</span>
                  <strong>{scopeLabel(overview?.scope)}</strong>
                </div>
                <div className="user-card-controls">
                  <Badge
                    className="identity-status"
                    aria-label={loading || busy ? "自动识别中" : data?.authenticated ? "飞书身份已识别" : "等待飞书身份"}
                    title={loading || busy ? "自动识别中" : data?.authenticated ? "飞书身份已识别" : "等待飞书身份"}
                    variant={data?.authenticated ? "success" : "warning"}
                  >
                    {loading || busy ? (
                      <LoaderCircleIcon className="spin-icon" data-icon="inline-start" />
                    ) : data?.authenticated ? (
                      <CheckCircle2Icon data-icon="inline-start" />
                    ) : (
                      <XCircleIcon data-icon="inline-start" />
                    )}
                  </Badge>
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
                      <span className="metric-value">{formatTokenAmount(totals?.currentPeriodMonthlyQuota, "0")}</span>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent>
                    <div className="metric">
                      <span className="metric-label">当前账期剩余额度</span>
                      <span className="metric-value">{formatTokenAmount(totals?.currentPeriodRemainingQuota, "0")}</span>
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
                        <Button variant="outline" disabled={busy} onClick={() => void assignAdmin("global")}>
                          <ShieldCheckIcon data-icon="inline-start" />
                          指派系统管理员
                        </Button>
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
                    <Button variant="outline" disabled={panelLoading} onClick={() => void loadAdminUsers()}>
                      <RefreshCwIcon data-icon="inline-start" />
                      刷新用户
                    </Button>
                    <Badge>{adminUsers.length} 个用户</Badge>
                  </div>
                  {!adminUsers.length ? (
                    <div className="empty">{panelLoading ? "读取用户中" : "暂无用户"}</div>
                  ) : (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>用户</th>
                            <th>部门</th>
                            <th>状态</th>
                            <th>角色</th>
                            <th>active key</th>
                            <th>账期</th>
                            <th>发放额度</th>
                            <th>剩余额度</th>
                            <th>已用</th>
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
                              <td>{maskSecret(user.departmentId) ?? "-"}</td>
                              <td>
                                <Badge variant={badgeVariant(user.status)}>{userStatusLabel[user.status]}</Badge>
                              </td>
                              <td>{user.role}</td>
                              <td>{user.activeTokenStatus ?? "-"}</td>
                              <td>{user.billingPeriod ?? "-"}</td>
                              <td>{formatTokenAmount(user.billingMonthlyQuota)}</td>
                              <td>{formatTokenAmount(user.billingRemainingQuota)}</td>
                              <td>{formatTokenAmount(user.billingTotalTokens, "0")}</td>
                              <td>{user.latestProxyLogAt ? formatDateTime(user.latestProxyLogAt) : "-"}</td>
                              <td>
                                <div className="toolbar toolbar-left">
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
                                      disabled={busy || user.activeTokenStatus !== "active"}
                                    />
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      disabled={busy || user.activeTokenStatus !== "active"}
                                      onClick={() => void adjustUserQuota(user.id)}
                                    >
                                      调额
                                    </Button>
                                  </div>
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
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={busy || user.activeTokenStatus !== "active"}
                                    onClick={() => void disableUser(user)}
                                  >
                                    禁用
                                  </Button>
                                  <Button variant="outline" size="sm" disabled={busy} onClick={() => void deleteUser(user)}>
                                    <Trash2Icon data-icon="inline-start" />
                                    删除
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          ))}
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
                          <th>已用</th>
                          <th>请求数</th>
                          <th>用量占比</th>
                          <th>消耗率</th>
                          <th>最近调用</th>
                        </tr>
                      </thead>
                      <tbody>
                        {departmentStats.map((item) => (
                          <tr key={item.departmentId}>
                            <td>{item.departmentName ?? maskSecret(item.departmentId) ?? "未知部门"}</td>
                            <td>{item.memberCount}</td>
                            <td>{item.keyedUsers}</td>
                            <td>{formatTokenAmount(item.monthlyQuota, "0")}</td>
                            <td>{formatTokenAmount(item.remainingQuota, "0")}</td>
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
                            <td>{maskSecret(user.departmentId) ?? "-"}</td>
                            <td>{user.role}</td>
                            <td>{user.billingPeriod ?? "-"}</td>
                            <td>{formatTokenAmount(user.monthlyQuota, "0")}</td>
                            <td>{formatTokenAmount(user.remainingQuota)}</td>
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
            <Card>
              <CardHeader>
                <CardTitle>使用记录</CardTitle>
                <CardDescription>
                  {isSystemAdmin ? "系统管理员查看全站调用记录。" : "部门管理员只查看本部门下属用户调用记录。"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <UsageRecordsTable records={usageRecords} />
              </CardContent>
            </Card>
          )}

          {panel === "approvals" && (
            <Card>
              <CardHeader>
                <CardTitle>审批处理</CardTitle>
                <CardDescription>仅展示当前管理范围内的申请记录，不显示 NewAPI 明文 key。</CardDescription>
              </CardHeader>
              <CardContent>
                {!overview?.latestRequests.length ? (
                  <div className="empty">暂无可查看申请</div>
                ) : (
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
                        {overview.latestRequests.map((request) => (
                          <tr key={request.id}>
                            <td>{request.requesterName ?? maskSecret(request.requesterOpenId)}</td>
                            <td>{requestTypeLabel[request.requestType] ?? request.requestType}</td>
                            <td>
                              <Badge variant={badgeVariant(request.status)}>
                                {statusLabel[request.status] ?? request.status}
                              </Badge>
                            </td>
                            <td>{formatTokenAmount(request.requestedMonthlyQuota)}</td>
                            <td>
                              <div className="quota-control">
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
                                  disabled={!canEditQuota(request.status) || busy}
                                />
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={!canEditQuota(request.status) || busy}
                                  onClick={() => void saveRequestQuota(request.id)}
                                >
                                  保存
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
                                  disabled={!canDecideRequest(request.status) || busy}
                                  onClick={() => void decideRequest(request.id, "approve")}
                                >
                                  通过
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={!canDecideRequest(request.status) || busy}
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
                )}
              </CardContent>
            </Card>
          )}

          {panel === "settings" && isSystemAdmin && (
            <Card>
              <CardHeader>
                <CardTitle>系统设置</CardTitle>
                <CardDescription>默认额度和全局设置只允许系统管理员修改。</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="field-group">
                  <div className="field">
                    <label htmlFor="defaultMonthlyQuota">默认申请额度</label>
                    <div className="quota-control">
                      <Input
                        id="defaultMonthlyQuota"
                        min={1}
                        step={1}
                        type="number"
                        value={defaultQuotaDraft}
                        onChange={(event) => setDefaultQuotaDraft(event.target.value)}
                        disabled={!data?.authorized || busy}
                      />
                      <Button variant="outline" size="sm" disabled={!data?.authorized || busy} onClick={() => void saveDefaultQuota()}>
                        <SaveIcon data-icon="inline-start" />
                        保存
                      </Button>
                    </div>
                    <span className="field-description">
                      当前值：{formatTokenAmount(data?.settings?.defaultMonthlyQuota ?? 200)}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </main>
      </div>
    </>
  );
}
