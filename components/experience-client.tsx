"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart3Icon,
  CheckCircle2Icon,
  ClipboardCopyIcon,
  HistoryIcon,
  KeyRoundIcon,
  ListFilterIcon,
  MenuIcon,
  RefreshCwIcon,
  SendIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
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
import { formatDateTime, maskSecret } from "@/lib/utils";

type SessionResponse = {
  authenticated: boolean;
  baseUrl: string;
  settings?: {
    defaultMonthlyQuota: number;
  };
  user?: {
    id: string;
    name?: string;
    avatarUrl?: string;
    tenantKey: string;
    openId: string;
    departmentId?: string;
  };
  activeToken?: {
    id: string;
    status: string;
    newapiTokenId?: string;
    maskedKey?: string;
    billingPeriod: string;
    createdAt: string;
  };
  billingPeriod?: {
    period: string;
    monthlyQuota: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    proxyLogCount: number;
  } | null;
  adminScope?: {
    type: "global" | "department";
    departmentId?: string;
    source: "manual" | "department_supervisor";
  } | null;
  requests: Array<{
    id: string;
    requestType: string;
    status: string;
    reason: string;
    createdAt: string;
    updatedAt: string;
  }>;
  proxyLogCount: number;
};

type ModelsResponse = {
  models: Array<{
    id: string;
    object?: string;
    ownedBy?: string;
  }>;
  error?: string;
};

type QuickApprovalRequest = {
  id: string;
  requestType: string;
  status: string;
  reason: string;
  requestedMonthlyQuota: number;
  approvedMonthlyQuota?: number;
  requesterName?: string;
  requesterOpenId?: string;
  errorMessage?: string;
  updatedAt: string;
  createdAt: string;
};

type AdminOverviewResponse = {
  authenticated: boolean;
  authorized: boolean;
  error?: string;
  overview?: {
    latestRequests: QuickApprovalRequest[];
  };
};

type WorkspacePanel = "account" | "usage" | "models" | "requests";

const DEFAULT_REASON_PLACEHOLDER = "请说明使用场景、接入工具和预计调用方式。";
const FALLBACK_MONTHLY_QUOTA = 200;

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

function displayName(user?: SessionResponse["user"]) {
  return user?.name || maskSecret(user?.openId) || "-";
}

function avatarInitial(user?: SessionResponse["user"]) {
  return displayName(user).trim().slice(0, 1).toUpperCase() || "T";
}

function scopeLabel(scope?: SessionResponse["adminScope"]) {
  if (!scope) return "";
  if (scope.type === "global") return "全局管理";
  return "部门管理";
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

export function ExperienceClient() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [models, setModels] = useState<ModelsResponse["models"]>([]);
  const [quickApproval, setQuickApproval] = useState<QuickApprovalRequest | null>(null);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [quickApprovalLoading, setQuickApprovalLoading] = useState(false);
  const [quickApprovalBusy, setQuickApprovalBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [quotaResetReason, setQuotaResetReason] = useState("");
  const [quickApprovalQuotaDraft, setQuickApprovalQuotaDraft] = useState("");
  const [panel, setPanel] = useState<WorkspacePanel>("account");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feishuSdkReady, setFeishuSdkReady] = useState(false);
  const [autoLoginAttempted, setAutoLoginAttempted] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/session", { cache: "no-store" });
      const data = (await res.json()) as SessionResponse;
      setSession(data);
      if (!data.activeToken) {
        setPanel("account");
        setKey(null);
        setModels([]);
        setModelsLoaded(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取会话失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadModels = useCallback(async () => {
    if (!session?.activeToken) return;
    setModelsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/models", { cache: "no-store" });
      const data = (await res.json()) as ModelsResponse;
      if (!res.ok) throw new Error(data.error ?? "读取模型列表失败");
      setModels(data.models);
      setModelsLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取模型列表失败");
    } finally {
      setModelsLoading(false);
    }
  }, [session?.activeToken]);

  const loadQuickApproval = useCallback(async () => {
    if (!session?.adminScope) {
      setQuickApproval(null);
      setQuickApprovalQuotaDraft("");
      return;
    }

    setQuickApprovalLoading(true);
    try {
      const res = await fetch("/api/admin/overview?mode=soft", { cache: "no-store" });
      const data = (await res.json()) as AdminOverviewResponse;
      if (!res.ok || (data.error && data.authenticated)) {
        throw new Error(data.error ?? "读取最新审批请求失败");
      }
      const latestRequest =
        data.overview?.latestRequests.find((request) => canDecideRequest(request.status)) ??
        data.overview?.latestRequests[0] ??
        null;
      setQuickApproval(latestRequest);
      setQuickApprovalQuotaDraft(
        latestRequest
          ? String(latestRequest.approvedMonthlyQuota ?? latestRequest.requestedMonthlyQuota)
          : "",
      );
    } catch (err) {
      setQuickApproval(null);
      setQuickApprovalQuotaDraft("");
      setError(err instanceof Error ? err.message : "读取最新审批请求失败");
    } finally {
      setQuickApprovalLoading(false);
    }
  }, [session?.adminScope]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void loadQuickApproval();
  }, [loadQuickApproval]);

  useEffect(() => {
    if (panel === "models" && session?.activeToken && !modelsLoaded && !modelsLoading) {
      void loadModels();
    }
  }, [loadModels, modelsLoaded, modelsLoading, panel, session?.activeToken]);

  const requests = useMemo(() => session?.requests ?? [], [session]);
  const latestRequest = requests[0];
  const hasActiveToken = Boolean(session?.activeToken);
  const title = hasActiveToken ? "用户后台" : "Token 申请";
  const defaultMonthlyQuota = session?.settings?.defaultMonthlyQuota ?? FALLBACK_MONTHLY_QUOTA;
  const currentBillingPeriod = session?.billingPeriod ?? null;
  const currentBillingPeriodName =
    currentBillingPeriod?.period ?? session?.activeToken?.billingPeriod ?? "-";
  const quickApprovalCanDecide = quickApproval ? canDecideRequest(quickApproval.status) : false;

  function selectPanel(nextPanel: WorkspacePanel) {
    setPanel(nextPanel);
    setMobileNavOpen(false);
  }

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
    if (loading || busy || autoLoginAttempted || !feishuSdkReady || session?.authenticated) {
      return;
    }
    setAutoLoginAttempted(true);
    void connectFeishu();
  }, [autoLoginAttempted, busy, connectFeishu, feishuSdkReady, loading, session?.authenticated]);

  async function requestToken() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/token/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: reason.trim(),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "提交申请失败");
      setMessage("申请已提交。");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交申请失败");
    } finally {
      setBusy(false);
    }
  }

  async function revealKey() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      let fullKey = key;
      if (!fullKey) {
        const res = await fetch("/api/token/key", { cache: "no-store" });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "读取 key 失败");
        fullKey = body.key;
      }
      if (!fullKey) throw new Error("读取 key 失败");
      setKey(fullKey);
      try {
        await navigator.clipboard.writeText(fullKey);
        setMessage("已复制并展示当前 active key。");
      } catch {
        setMessage("已展示当前 active key，浏览器未允许自动复制。");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取 key 失败");
    } finally {
      setBusy(false);
    }
  }

  async function resetKey() {
    if (!window.confirm("重置后旧 key 将失效，并生成新的 active key。")) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/token/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "用户在 TokenInside 用户后台发起 key reset" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "重置 key 失败");
      setKey(body.key ?? null);
      setModels([]);
      setModelsLoaded(false);
      setMessage("key 已重置。");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "重置 key 失败");
    } finally {
      setBusy(false);
    }
  }

  async function requestQuotaReset() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/token/quota-reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: quotaResetReason.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "提交额度重置申请失败");
      setQuotaResetReason("");
      setMessage("额度重置申请已提交。");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交额度重置申请失败");
    } finally {
      setBusy(false);
    }
  }

  async function copyBaseUrl() {
    await navigator.clipboard.writeText(`${session?.baseUrl ?? ""}/v1`);
    setMessage("已复制 Base URL。");
  }

  async function decideQuickApproval(action: "approve" | "reject") {
    if (!quickApproval) return;

    const approvedMonthlyQuota = Number(quickApprovalQuotaDraft);
    if (action === "approve" && (!Number.isInteger(approvedMonthlyQuota) || approvedMonthlyQuota <= 0)) {
      setError("通过审批前需要填写正整数最终额度");
      return;
    }

    setQuickApprovalBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(
        `/api/admin/token-requests/${encodeURIComponent(quickApproval.id)}/decision`,
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
      setMessage(action === "approve" ? "最新审批请求已通过，已触发发放。" : "最新审批请求已拒绝。");
      await Promise.all([refresh(), loadQuickApproval()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "处理审批失败");
    } finally {
      setQuickApprovalBusy(false);
    }
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
                <p className="brand-subtitle">Feishu + NewAPI</p>
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
            <nav className="nav-list" aria-label="用户后台菜单">
              <button
                className={panel === "account" ? "nav-item active nav-button" : "nav-item nav-button"}
                type="button"
                onClick={() => selectPanel("account")}
              >
                <KeyRoundIcon data-icon="inline-start" />
                {hasActiveToken ? "账户密钥" : title}
              </button>
              {hasActiveToken && (
                <>
                  <button
                    className={panel === "usage" ? "nav-item active nav-button" : "nav-item nav-button"}
                    type="button"
                    onClick={() => selectPanel("usage")}
                  >
                    <BarChart3Icon data-icon="inline-start" />
                    额度用量
                  </button>
                  <button
                    className={panel === "models" ? "nav-item active nav-button" : "nav-item nav-button"}
                    type="button"
                    onClick={() => selectPanel("models")}
                  >
                    <ListFilterIcon data-icon="inline-start" />
                    模型列表
                  </button>
                  <button
                    className={panel === "requests" ? "nav-item active nav-button" : "nav-item nav-button"}
                    type="button"
                    onClick={() => selectPanel("requests")}
                  >
                    <HistoryIcon data-icon="inline-start" />
                    申请记录
                  </button>
                </>
              )}
              {session?.adminScope && (
                <a className="nav-item" href="/admin">
                  <ShieldCheckIcon data-icon="inline-start" />
                  管理后台
                </a>
              )}
            </nav>

            <div className="sidebar-footer">
              {session?.adminScope
                ? `管理范围：${scopeLabel(session.adminScope)}`
                : "当前入口按飞书身份自动识别。"}
            </div>
          </div>
        </aside>

        <main className="main">
          <header className="topbar">
            <div>
              <h2 className="page-title">{title}</h2>
              <p className="page-description">
                {hasActiveToken ? "账户、key 与可用模型。" : "飞书用户身份与申请入口。"}
              </p>
            </div>
          </header>

          {error && <div className="alert alert-danger">{error}</div>}
          {message && <div className="alert">{message}</div>}

          <Card>
            <CardContent>
              <div className={session?.adminScope ? "user-card user-card-with-action" : "user-card"}>
                <div className="user-avatar" aria-hidden="true">
                  {session?.user?.avatarUrl ? (
                    <img src={session.user.avatarUrl} alt="" />
                  ) : (
                    <span>{avatarInitial(session?.user)}</span>
                  )}
                </div>
                <div className="user-card-main">
                  <span className="user-card-label">当前飞书用户</span>
                  <strong>{session?.authenticated ? displayName(session.user) : "等待飞书身份"}</strong>
                  <span>{session?.user?.openId ? maskSecret(session.user.openId) : "-"}</span>
                </div>
                {session?.adminScope && (
                  <div className="user-card-action">
                    <a className="button button-outline" href="/admin">
                      <ShieldCheckIcon data-icon="inline-start" />
                      管理后台
                    </a>
                  </div>
                )}
                <div className="user-card-controls">
                  <Badge
                    className="identity-status"
                    aria-label={
                      loading || busy
                        ? "自动识别中"
                        : session?.authenticated
                          ? "飞书身份已识别"
                          : "等待飞书身份"
                    }
                    title={
                      loading || busy
                        ? "自动识别中"
                        : session?.authenticated
                          ? "飞书身份已识别"
                          : "等待飞书身份"
                    }
                    variant={session?.authenticated ? "success" : "warning"}
                  >
                    {loading || busy ? (
                      "自动识别中"
                    ) : session?.authenticated ? (
                      <CheckCircle2Icon data-icon="inline-start" />
                    ) : (
                      "等待飞书身份"
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

          {session?.adminScope && (
            <Card>
              <CardHeader>
                <CardTitle>最新审批请求</CardTitle>
                <CardDescription>
                  {quickApproval
                    ? `更新时间：${formatDateTime(quickApproval.updatedAt)}`
                    : "当前管理范围内暂无可处理申请。"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {quickApprovalLoading ? (
                  <div className="empty">读取最新审批请求中</div>
                ) : !quickApproval ? (
                  <div className="empty">暂无审批请求</div>
                ) : (
                  <div className="quick-approval">
                    <div className="quick-approval-main">
                      <div className="meta-list">
                        <div className="meta-row">
                          <span>申请人</span>
                          <strong>
                            {quickApproval.requesterName ?? maskSecret(quickApproval.requesterOpenId)}
                          </strong>
                        </div>
                        <div className="meta-row">
                          <span>类型</span>
                          <strong>
                            {requestTypeLabel[quickApproval.requestType] ?? quickApproval.requestType}
                          </strong>
                        </div>
                        <div className="meta-row">
                          <span>状态</span>
                          <Badge variant={badgeVariant(quickApproval.status)}>
                            {statusLabel[quickApproval.status] ?? quickApproval.status}
                          </Badge>
                        </div>
                        <div className="meta-row">
                          <span>申请额度</span>
                          <strong>{quickApproval.requestedMonthlyQuota}</strong>
                        </div>
                        <div className="meta-row">
                          <span>申请理由</span>
                          <strong>{quickApproval.reason || "-"}</strong>
                        </div>
                      </div>
                    </div>

                    <div className="quick-approval-actions">
                      <div className="field">
                        <label htmlFor="quickApprovalQuota">最终额度</label>
                        <div className="quota-control">
                          <Input
                            id="quickApprovalQuota"
                            min={1}
                            step={1}
                            type="number"
                            value={quickApprovalQuotaDraft}
                            onChange={(event) => setQuickApprovalQuotaDraft(event.target.value)}
                            disabled={!quickApprovalCanDecide || quickApprovalBusy}
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!quickApprovalCanDecide || quickApprovalBusy}
                            onClick={() => void decideQuickApproval("approve")}
                          >
                            <CheckCircle2Icon data-icon="inline-start" />
                            通过
                          </Button>
                        </div>
                        <span className="field-description">
                          {quickApprovalCanDecide ? "通过时会按最终额度发放或更新。" : "该请求当前不可直接审批。"}
                        </span>
                      </div>
                      <div className="toolbar toolbar-left">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!quickApprovalCanDecide || quickApprovalBusy}
                          onClick={() => void decideQuickApproval("reject")}
                        >
                          <XCircleIcon data-icon="inline-start" />
                          拒绝
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={quickApprovalLoading || quickApprovalBusy}
                          onClick={() => void loadQuickApproval()}
                        >
                          <RefreshCwIcon data-icon="inline-start" />
                          刷新
                        </Button>
                        <a className="button button-outline button-sm" href="/admin">
                          <SlidersHorizontalIcon data-icon="inline-start" />
                          进入审批
                        </a>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {!hasActiveToken ? (
            <Card>
              <CardHeader>
                <CardTitle>申请 Token</CardTitle>
                <CardDescription>
                  {latestRequest
                    ? `最近状态：${statusLabel[latestRequest.status] ?? latestRequest.status}`
                    : "填写申请理由后提交。"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="field-group">
                  <div className="field">
                    <label htmlFor="requestedMonthlyQuota">默认申请额度</label>
                    <Input
                      id="requestedMonthlyQuota"
                      value={String(defaultMonthlyQuota)}
                      disabled
                    />
                    <span className="field-description">当前 MVP 固定额度，用户不可修改。</span>
                  </div>
                  <div className="field">
                    <label htmlFor="requestReason">申请理由</label>
                    <Textarea
                      id="requestReason"
                      placeholder={DEFAULT_REASON_PLACEHOLDER}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      disabled={!session?.authenticated || busy}
                    />
                  </div>
                  <div className="apply-panel">
                    <div className="apply-status">
                      <SparklesIcon data-icon="inline-start" />
                      <span>{latestRequest ? formatDateTime(latestRequest.updatedAt) : "首次申请"}</span>
                    </div>
                    <Button
                      onClick={() => void requestToken()}
                      disabled={!session?.authenticated || busy || reason.trim().length < 4}
                    >
                      <SendIcon data-icon="inline-start" />
                      申请 Token
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : (
            <>
              {panel === "account" && (
                <section className="grid grid-2">
                  <Card>
                    <CardHeader>
                      <CardTitle>当前 key</CardTitle>
                      <CardDescription>active key 只绑定当前飞书用户。</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="field">
                        <label>Base URL</label>
                        <div className="key-box">
                          <span>{session?.baseUrl ? `${session.baseUrl}/v1` : "-"}</span>
                          <Button variant="ghost" size="sm" onClick={() => void copyBaseUrl()}>
                            <ClipboardCopyIcon data-icon="inline-start" />
                            复制
                          </Button>
                        </div>
                      </div>
                      <div className="field">
                        <label>NewAPI key</label>
                        <div className="key-box">
                          <span>{key ?? session?.activeToken?.maskedKey ?? "已发放"}</span>
                          <div className="key-actions">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => void revealKey()}
                            >
                              <KeyRoundIcon data-icon="inline-start" />
                              查看
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => void resetKey()}
                            >
                              <RefreshCwIcon data-icon="inline-start" />
                              重置
                            </Button>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>代理范围</CardTitle>
                      <CardDescription>本期仅开放 MVP 数据面。</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="endpoint-list">
                        <Badge variant="success">GET /v1/models</Badge>
                        <Badge variant="success">POST /v1/chat/completions</Badge>
                        <Badge variant="success">POST /v1/responses</Badge>
                        <Badge variant="success">POST /v1/messages</Badge>
                      </div>
                    </CardContent>
                  </Card>
                </section>
              )}

              {panel === "usage" && (
                <section className="grid grid-2">
                  <Card>
                    <CardHeader>
                      <CardTitle>当前账期</CardTitle>
                      <CardDescription>{currentBillingPeriodName}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="meta-list">
                        <div className="meta-row">
                          <span>账期额度</span>
                          <strong>{currentBillingPeriod?.monthlyQuota ?? "-"}</strong>
                        </div>
                        <div className="meta-row">
                          <span>总 tokens</span>
                          <strong>{currentBillingPeriod?.totalTokens ?? 0}</strong>
                        </div>
                        <div className="meta-row">
                          <span>输入 tokens</span>
                          <strong>{currentBillingPeriod?.promptTokens ?? 0}</strong>
                        </div>
                        <div className="meta-row">
                          <span>输出 tokens</span>
                          <strong>{currentBillingPeriod?.completionTokens ?? 0}</strong>
                        </div>
                        <div className="meta-row">
                          <span>代理请求</span>
                          <strong>{currentBillingPeriod?.proxyLogCount ?? 0}</strong>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>额度重置</CardTitle>
                      <CardDescription>
                        提交后由部门负责人审批，审批通过后重置当前 active key 额度。
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="field-group">
                        <div className="field">
                          <label htmlFor="quotaResetAmount">重置目标额度</label>
                          <Input
                            id="quotaResetAmount"
                            value={String(defaultMonthlyQuota)}
                            disabled
                          />
                          <span className="field-description">以管理后台当前默认额度为准。</span>
                        </div>
                        <div className="field">
                          <label htmlFor="quotaResetReason">申请理由</label>
                          <Textarea
                            id="quotaResetReason"
                            placeholder="请说明额度用尽原因、当前业务场景和预期恢复时间。"
                            value={quotaResetReason}
                            onChange={(event) => setQuotaResetReason(event.target.value)}
                            disabled={busy}
                          />
                        </div>
                        <Button
                          variant="outline"
                          disabled={busy || quotaResetReason.trim().length < 4}
                          onClick={() => void requestQuotaReset()}
                        >
                          <RefreshCwIcon data-icon="inline-start" />
                          申请额度重置
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </section>
              )}

              {panel === "models" && (
                <Card>
                  <CardHeader>
                    <CardTitle>模型列表</CardTitle>
                    <CardDescription>来自当前 active key 的 NewAPI `/v1/models`。</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="toolbar toolbar-left">
                      <Button
                        variant="outline"
                        onClick={() => void loadModels()}
                        disabled={modelsLoading}
                      >
                        <RefreshCwIcon data-icon="inline-start" />
                        刷新模型
                      </Button>
                      <Badge variant={modelsLoaded ? "success" : "warning"}>
                        {modelsLoading ? "读取中" : `${models.length} 个模型`}
                      </Badge>
                    </div>
                    {models.length === 0 ? (
                      <div className="empty">暂无模型</div>
                    ) : (
                      <div className="model-grid">
                        {models.map((model) => (
                          <div className="model-item" key={model.id}>
                            <strong>{model.id}</strong>
                            <span>{model.ownedBy ?? model.object ?? "model"}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {panel === "requests" && (
                <Card>
                  <CardHeader>
                    <CardTitle>申请记录</CardTitle>
                    <CardDescription>
                      {latestRequest
                        ? `状态更新时间：${formatDateTime(latestRequest.updatedAt)}`
                        : "当前用户暂无申请记录。"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {!latestRequest ? (
                      <div className="empty">暂无申请记录</div>
                    ) : (
                      <div className="meta-list">
                        <div className="meta-row">
                          <span>类型</span>
                          <strong>
                            {requestTypeLabel[latestRequest.requestType] ?? latestRequest.requestType}
                          </strong>
                        </div>
                        <div className="meta-row">
                          <span>状态</span>
                          <Badge variant={badgeVariant(latestRequest.status)}>
                            {statusLabel[latestRequest.status] ?? latestRequest.status}
                          </Badge>
                        </div>
                        <div className="meta-row">
                          <span>申请理由</span>
                          <strong>{latestRequest.reason || "-"}</strong>
                        </div>
                        <div className="meta-row">
                          <span>创建时间</span>
                          <strong>{formatDateTime(latestRequest.createdAt)}</strong>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              <div className="alert">
                <CheckCircle2Icon data-icon="inline-start" /> 当前用户已有 active key。
              </div>
            </>
          )}
        </main>
      </div>
    </>
  );
}
