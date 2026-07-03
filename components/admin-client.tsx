"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeftIcon,
  BarChart3Icon,
  CheckCircle2Icon,
  ClipboardListIcon,
  GaugeIcon,
  LoaderCircleIcon,
  MenuIcon,
  RefreshCwIcon,
  SaveIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
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
import { formatDateTime, formatTokenAmount, maskSecret } from "@/lib/utils";

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
    scope: {
      type: "global" | "department";
      departmentId?: string;
      source: "manual" | "department_supervisor" | "environment";
    };
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
    users: Array<{
      id: string;
      name?: string;
      openId: string;
      departmentId?: string;
      activeTokenStatus?: string;
      activeTokenCreatedAt?: string;
      billingPeriod?: string;
      billingMonthlyQuota?: number;
      billingPromptTokens?: number;
      billingCompletionTokens?: number;
      billingTotalTokens?: number;
      billingProxyLogCount?: number;
      requestCount: number;
      proxyLogCount: number;
      totalTokens?: number;
      updatedAt: string;
      createdAt: string;
    }>;
    latestProxyLogs: Array<{
      id: string;
      requestPath: string;
      method: string;
      statusCode: number;
      durationMs: number;
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      clientIp?: string;
      userAgent?: string;
      requesterName?: string;
      requesterOpenId?: string;
      createdAt: string;
    }>;
  };
  settings?: {
    defaultMonthlyQuota: number;
    updatedAt?: string;
  };
};

type AdminScopeSummary = NonNullable<AdminOverviewResponse["overview"]>["scope"];

type AdminPanel = "overview" | "approvals" | "quotas" | "quotaStats" | "usageLogs" | "admins";

type AdminRecord = {
  id: string;
  feishuUserId: string;
  scopeType: "global" | "department";
  departmentId?: string;
  source: "manual" | "department_supervisor" | "environment";
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
  configuredOpenId?: string;
  readonly?: boolean;
  user?: {
    id: string;
    name?: string;
    openId: string;
    departmentId?: string;
  } | null;
};

type AdminsResponse = {
  admins: AdminRecord[];
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

function badgeVariant(status?: string) {
  if (!status) return "default";
  if (["provisioned", "approved"].includes(status)) return "success";
  if (["rejected", "cancelled", "invalidated", "approved_provision_failed"].includes(status)) {
    return "danger";
  }
  return "warning";
}

function scopeLabel(scope?: AdminScopeSummary) {
  if (!scope) return "无管理范围";
  if (scope.type === "global") return "系统管理员";
  return "部门管理";
}

function adminScopeLabel(scopeType: AdminRecord["scopeType"]) {
  return scopeType === "global" ? "系统管理员" : "部门管理员";
}

function adminSourceLabel(source: AdminRecord["source"]) {
  if (source === "environment") return "初始化环境变量";
  if (source === "department_supervisor") return "部门主管自动识别";
  return "手动指派";
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

export function AdminClient() {
  const [data, setData] = useState<AdminOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [panel, setPanel] = useState<AdminPanel>("overview");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [defaultQuotaDraft, setDefaultQuotaDraft] = useState("200");
  const [quotaDrafts, setQuotaDrafts] = useState<Record<string, string>>({});
  const [adminRecords, setAdminRecords] = useState<AdminRecord[]>([]);
  const [adminLoading, setAdminLoading] = useState(false);
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
        setQuotaDrafts(
          Object.fromEntries(
            body.overview.latestRequests.map((request) => [
              request.id,
              String(request.approvedMonthlyQuota ?? request.requestedMonthlyQuota),
            ]),
          ),
        );
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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const overview = data?.overview;
  const totals = overview?.totals;
  const isSystemAdmin = overview?.scope.type === "global";

  const loadAdmins = useCallback(async () => {
    if (!isSystemAdmin) {
      setAdminRecords([]);
      return;
    }
    setAdminLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/admins", { cache: "no-store" });
      const body = (await res.json()) as AdminsResponse;
      if (!res.ok) throw new Error(body.error ?? "读取管理员列表失败");
      setAdminRecords(body.admins);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取管理员列表失败");
    } finally {
      setAdminLoading(false);
    }
  }, [isSystemAdmin]);

  useEffect(() => {
    if (panel === "admins") {
      void loadAdmins();
    }
  }, [loadAdmins, panel]);

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
      const res = await fetch(
        `/api/admin/token-requests/${encodeURIComponent(requestId)}/quota`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ approvedMonthlyQuota }),
        },
      );
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
      const res = await fetch(
        `/api/admin/token-requests/${encodeURIComponent(requestId)}/decision`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action,
            approvedMonthlyQuota: action === "approve" ? approvedMonthlyQuota : undefined,
          }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "处理审批失败");
      setMessage(action === "approve" ? "审批已通过，已触发发放。" : "申请已拒绝。");
      await refresh();
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
      const res = await fetch(
        `/api/admin/users/${encodeURIComponent(userId)}/quota-adjust`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            approvedMonthlyQuota,
            reason: `管理后台调额为 ${approvedMonthlyQuota}`,
          }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "调额失败");
      setMessage("额度已调整。");
      await refresh();
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
      await loadAdmins();
    } catch (err) {
      setError(err instanceof Error ? err.message : "指派管理员失败");
    } finally {
      setBusy(false);
    }
  }

  async function updateAdminStatus(adminId: string, status: "active" | "disabled") {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/admins/${encodeURIComponent(adminId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "更新管理员状态失败");
      setMessage(status === "active" ? "管理员范围已启用。" : "管理员范围已停用。");
      await loadAdmins();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新管理员状态失败");
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
              状态总览
            </button>
            <button
              className={panel === "approvals" ? "nav-item active nav-button" : "nav-item nav-button"}
              type="button"
              onClick={() => selectPanel("approvals")}
            >
              <ClipboardListIcon data-icon="inline-start" />
              请求审批
            </button>
            <button
              className={panel === "quotas" ? "nav-item active nav-button" : "nav-item nav-button"}
              type="button"
              onClick={() => selectPanel("quotas")}
            >
              <SlidersHorizontalIcon data-icon="inline-start" />
              额度管理
            </button>
            <button
              className={panel === "quotaStats" ? "nav-item active nav-button" : "nav-item nav-button"}
              type="button"
              onClick={() => selectPanel("quotaStats")}
            >
              <UsersRoundIcon data-icon="inline-start" />
              额度统计
            </button>
            <button
              className={panel === "usageLogs" ? "nav-item active nav-button" : "nav-item nav-button"}
              type="button"
              onClick={() => selectPanel("usageLogs")}
            >
              <BarChart3Icon data-icon="inline-start" />
              使用记录
            </button>
            {isSystemAdmin && (
              <button
                className={panel === "admins" ? "nav-item active nav-button" : "nav-item nav-button"}
                type="button"
                onClick={() => selectPanel("admins")}
              >
                <ShieldCheckIcon data-icon="inline-start" />
                管理员
              </button>
            )}
          </nav>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h2 className="page-title">TokenInside 管理后台</h2>
            <p className="page-description">
              面向飞书部门主管和 TokenInside 管理员的审批、发放、用量与异常处理工作区。
            </p>
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
                  aria-label={
                    loading || busy
                      ? "自动识别中"
                      : data?.authenticated
                        ? "飞书身份已识别"
                        : "等待飞书身份"
                  }
                  title={
                    loading || busy
                      ? "自动识别中"
                      : data?.authenticated
                        ? "飞书身份已识别"
                        : "等待飞书身份"
                  }
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
                    <span className="metric-value">
                      {formatTokenAmount(totals?.currentPeriodTotalTokens, "0")}
                    </span>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent>
                  <div className="metric">
                    <span className="metric-label">当前账期发放额度</span>
                    <span className="metric-value">
                      {formatTokenAmount(totals?.currentPeriodMonthlyQuota, "0")}
                    </span>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent>
                  <div className="metric">
                    <span className="metric-label">当前账期剩余额度</span>
                    <span className="metric-value">
                      {formatTokenAmount(totals?.currentPeriodRemainingQuota, "0")}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </section>

            <section className="grid">
              <Card>
                <CardHeader>
                  <CardTitle>状态概览</CardTitle>
                  <CardDescription>审批与发放状态来自 TokenInside 本地状态机。</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="meta-list">
                    <div className="meta-row">
                      <span>申请总数</span>
                      <strong>{totals?.tokenRequests ?? 0}</strong>
                    </div>
                    <div className="meta-row">
                      <span>已发放</span>
                      <strong>{totals?.provisionedRequests ?? 0}</strong>
                    </div>
                    <div className="meta-row">
                      <span>发放失败</span>
                      <strong>{totals?.failedRequests ?? 0}</strong>
                    </div>
                    <div className="meta-row">
                      <span>输入 tokens</span>
                      <strong>{formatTokenAmount(totals?.promptTokens, "0")}</strong>
                    </div>
                    <div className="meta-row">
                      <span>输出 tokens</span>
                      <strong>{formatTokenAmount(totals?.completionTokens, "0")}</strong>
                    </div>
                    <div className="meta-row">
                      <span>当前账期</span>
                      <strong>{totals?.currentBillingPeriod ?? "-"}</strong>
                    </div>
                    <div className="meta-row">
                      <span>账期请求</span>
                      <strong>{totals?.currentPeriodProxyLogs ?? 0}</strong>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </section>
          </>
        )}

        {panel === "approvals" && (
          <Card>
            <CardHeader>
              <CardTitle>请求审批</CardTitle>
              <CardDescription>仅展示当前管理范围内的申请记录，不显示 NewAPI 明文 key。</CardDescription>
            </CardHeader>
            <CardContent>
              {!overview?.latestRequests.length ? (
                <div className="empty">
                  <UsersRoundIcon data-icon="inline-start" />
                  暂无可查看申请
                </div>
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
                                <SlidersHorizontalIcon data-icon="inline-start" />
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
                                <CheckCircle2Icon data-icon="inline-start" />
                                通过
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={!canDecideRequest(request.status) || busy}
                                onClick={() => void decideRequest(request.id, "reject")}
                              >
                                <XCircleIcon data-icon="inline-start" />
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

        {panel === "quotas" && (
          <section className="grid grid-2">
            <Card>
              <CardHeader>
                <CardTitle>额度配置</CardTitle>
                <CardDescription>申请单会保存提交时的默认额度快照。</CardDescription>
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
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!data?.authorized || busy}
                        onClick={() => void saveDefaultQuota()}
                      >
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

            <Card>
              <CardHeader>
                <CardTitle>分用户调整额度</CardTitle>
                <CardDescription>仅 active key 用户可直接调整当前账期额度。</CardDescription>
              </CardHeader>
              <CardContent>
                {!overview?.users.length ? (
                  <div className="empty">暂无可调整用户</div>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>用户</th>
                          <th>active key</th>
                          <th>当前额度</th>
                          <th>调额</th>
                          <th>更新时间</th>
                        </tr>
                      </thead>
                      <tbody>
                        {overview.users.map((user) => (
                          <tr key={user.id}>
                            <td>{user.name ?? maskSecret(user.openId)}</td>
                            <td>{user.activeTokenStatus ?? "-"}</td>
                            <td>{formatTokenAmount(user.billingMonthlyQuota)}</td>
                            <td>
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
                                  调整
                                </Button>
                              </div>
                            </td>
                            <td>{formatDateTime(user.updatedAt)}</td>
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

        {panel === "quotaStats" && (
          <Card>
            <CardHeader>
              <CardTitle>用户统计</CardTitle>
              <CardDescription>按当前管理范围展示部门内成员的当前账期额度、已用 tokens 和剩余额度。</CardDescription>
            </CardHeader>
            <CardContent>
              {!overview?.users.length ? (
                <div className="empty">暂无用户统计</div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>用户</th>
                        <th>active key</th>
                        <th>账期</th>
                        <th>当前额度</th>
                        <th>已用 tokens</th>
                        <th>剩余额度</th>
                        <th>请求数</th>
                        <th>申请数</th>
                        <th>更新时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.users.map((user) => {
                        const quota = user.billingMonthlyQuota ?? 0;
                        const usedTokens = user.billingTotalTokens ?? 0;
                        const remainingQuota = Math.max(quota - usedTokens, 0);
                        return (
                          <tr key={user.id}>
                            <td>{user.name ?? maskSecret(user.openId)}</td>
                            <td>{user.activeTokenStatus ?? "-"}</td>
                            <td>{user.billingPeriod ?? "-"}</td>
                            <td>{formatTokenAmount(user.billingMonthlyQuota)}</td>
                            <td>{formatTokenAmount(usedTokens, "0")}</td>
                            <td>{user.billingMonthlyQuota == null ? "-" : formatTokenAmount(remainingQuota)}</td>
                            <td>{user.billingProxyLogCount ?? user.proxyLogCount}</td>
                            <td>{user.requestCount}</td>
                            <td>{formatDateTime(user.updatedAt)}</td>
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

        {panel === "admins" && (
          <section className="grid grid-2">
            <Card>
              <CardHeader>
                <CardTitle>指派管理员</CardTitle>
                <CardDescription>目标用户需要先通过飞书进入过 TokenInside。</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="field-group">
                  <div className="field">
                    <label htmlFor="adminTargetOpenId">目标 open_id</label>
                    <Input
                      id="adminTargetOpenId"
                      value={adminTargetOpenId}
                      onChange={(event) => setAdminTargetOpenId(event.target.value)}
                      disabled={!isSystemAdmin || busy}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="adminDepartmentId">部门 departmentId</label>
                    <Input
                      id="adminDepartmentId"
                      value={adminDepartmentId}
                      onChange={(event) => setAdminDepartmentId(event.target.value)}
                      disabled={!isSystemAdmin || busy}
                      placeholder="仅部门管理员需要"
                    />
                  </div>
                  <div className="toolbar toolbar-left">
                    <Button
                      variant="outline"
                      disabled={!isSystemAdmin || busy}
                      onClick={() => void assignAdmin("global")}
                    >
                      <ShieldCheckIcon data-icon="inline-start" />
                      指派系统管理员
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!isSystemAdmin || busy}
                      onClick={() => void assignAdmin("department")}
                    >
                      <UsersRoundIcon data-icon="inline-start" />
                      指派部门管理员
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>全部管理员</CardTitle>
                <CardDescription>包含初始化环境变量、手动指派和部门主管自动识别。</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="toolbar toolbar-left">
                  <Button variant="outline" disabled={adminLoading} onClick={() => void loadAdmins()}>
                    <RefreshCwIcon data-icon="inline-start" />
                    刷新
                  </Button>
                  <Badge variant={isSystemAdmin ? "success" : "warning"}>
                    {adminRecords.length} 条范围
                  </Badge>
                </div>
                {!adminRecords.length ? (
                  <div className="empty">{adminLoading ? "读取管理员列表中" : "暂无管理员记录"}</div>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>管理员</th>
                          <th>角色</th>
                          <th>部门</th>
                          <th>来源</th>
                          <th>状态</th>
                          <th>更新时间</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {adminRecords.map((admin) => {
                          const openId = admin.user?.openId ?? admin.configuredOpenId;
                          return (
                            <tr key={admin.id}>
                              <td>
                                <div className="meta-stack">
                                  <strong>{admin.user?.name ?? maskSecret(openId)}</strong>
                                  <span>{openId ? maskSecret(openId) : "-"}</span>
                                </div>
                              </td>
                              <td>{adminScopeLabel(admin.scopeType)}</td>
                              <td>{admin.departmentId ?? "-"}</td>
                              <td>{adminSourceLabel(admin.source)}</td>
                              <td>
                                <Badge variant={admin.status === "active" ? "success" : "warning"}>
                                  {admin.status === "active" ? "启用" : "停用"}
                                </Badge>
                              </td>
                              <td>{formatDateTime(admin.updatedAt)}</td>
                              <td>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={busy || admin.readonly}
                                  onClick={() =>
                                    void updateAdminStatus(
                                      admin.id,
                                      admin.status === "active" ? "disabled" : "active",
                                    )
                                  }
                                >
                                  {admin.status === "active" ? "停用" : "启用"}
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
          </section>
        )}

        {panel === "usageLogs" && (
          <Card>
            <CardHeader>
              <CardTitle>使用记录</CardTitle>
              <CardDescription>展示当前管理范围内的最近代理请求，不显示 Authorization。</CardDescription>
            </CardHeader>
            <CardContent>
              {!overview?.latestProxyLogs.length ? (
                <div className="empty">暂无使用记录</div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>用户</th>
                        <th>路径</th>
                        <th>状态</th>
                        <th>耗时</th>
                        <th>tokens</th>
                        <th>时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.latestProxyLogs.map((log) => (
                        <tr key={log.id}>
                          <td>{log.requesterName ?? maskSecret(log.requesterOpenId)}</td>
                          <td>{log.method} {log.requestPath}</td>
                          <td>{log.statusCode}</td>
                          <td>{log.durationMs} ms</td>
                          <td>{formatTokenAmount(log.totalTokens)}</td>
                          <td>{formatDateTime(log.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

      </main>
      </div>
    </>
  );
}
