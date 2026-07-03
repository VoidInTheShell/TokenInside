"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ActivityIcon,
  ArrowLeftIcon,
  CheckCircle2Icon,
  KeyRoundIcon,
  RefreshCwIcon,
  RouteIcon,
  SaveIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  UsersRoundIcon,
  XCircleIcon,
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
import { formatDateTime, maskSecret } from "@/lib/utils";

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
  if (["rejected", "cancelled", "approved_provision_failed"].includes(status)) {
    return "danger";
  }
  return "warning";
}

function scopeLabel(scope?: AdminScopeSummary) {
  if (!scope) return "无管理范围";
  if (scope.type === "global") return "全局管理";
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

export function AdminClient() {
  const [data, setData] = useState<AdminOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [defaultQuotaDraft, setDefaultQuotaDraft] = useState("200");
  const [quotaDrafts, setQuotaDrafts] = useState<Record<string, string>>({});
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

  const overview = data?.overview;
  const totals = overview?.totals;
  return (
    <>
      <FeishuSdkScript
        onReady={() => setFeishuSdkReady(true)}
        onError={(sdkError) => setError(sdkError)}
      />
      <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">TI</div>
          <div>
            <h1 className="brand-title">TokenInside</h1>
            <p className="brand-subtitle">Admin Workspace</p>
          </div>
        </div>

        <nav className="nav-list" aria-label="主导航">
          <a className="nav-item" href="/">
            <KeyRoundIcon data-icon="inline-start" />
            Token 控制台
          </a>
          <a className="nav-item active" href="/admin">
            <ShieldCheckIcon data-icon="inline-start" />
            管理后台
          </a>
          <div className="nav-item">
            <RouteIcon data-icon="inline-start" />
            /v1 透传网关
          </div>
          <div className="nav-item">
            <ActivityIcon data-icon="inline-start" />
            审计与用量
          </div>
        </nav>

        <div className="sidebar-footer">
          管理入口只复用当前飞书会话；管理范围由服务端保存的 TokenInside 管理范围记录决定。
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
                    "自动识别中"
                  ) : data?.authenticated ? (
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

        {error && <div className="alert alert-danger">{error}</div>}
        {message && <div className="alert">{message}</div>}

        <section className="grid grid-4">
          <Card>
            <CardContent>
              <div className="metric">
                <span className="metric-label">管理用户</span>
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
                <span className="metric-label">代理审计日志</span>
                <span className="metric-value">{totals?.proxyLogs ?? 0}</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <div className="metric">
                <span className="metric-label">总 tokens</span>
                <span className="metric-value">{totals?.totalTokens ?? 0}</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <div className="metric">
                <span className="metric-label">当前账期 tokens</span>
                <span className="metric-value">{totals?.currentPeriodTotalTokens ?? 0}</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <div className="metric">
                <span className="metric-label">当前账期额度</span>
                <span className="metric-value">{totals?.currentPeriodMonthlyQuota ?? 0}</span>
              </div>
            </CardContent>
          </Card>
        </section>

        <section className="grid grid-2">
          <Card>
            <CardHeader>
              <CardTitle>管理范围</CardTitle>
              <CardDescription>服务端基于当前飞书用户匹配 TokenInside 管理范围记录。</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="meta-list">
                <div className="meta-row">
                  <span>授权状态</span>
                  <Badge variant={data?.authorized ? "success" : "warning"}>
                    {data?.authorized ? "已授权" : "未授权"}
                  </Badge>
                </div>
                <div className="meta-row">
                  <span>范围</span>
                  <strong>{scopeLabel(overview?.scope)}</strong>
                </div>
                <div className="meta-row">
                  <span>来源</span>
                  <strong>{overview?.scope.source ?? "-"}</strong>
                </div>
                <div className="meta-row">
                  <span>当前用户</span>
                  <strong>{data?.user ? (data.user.name ?? maskSecret(data.user.openId)) : "-"}</strong>
                </div>
              </div>
            </CardContent>
          </Card>

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
                  <strong>{totals?.promptTokens ?? 0}</strong>
                </div>
                <div className="meta-row">
                  <span>输出 tokens</span>
                  <strong>{totals?.completionTokens ?? 0}</strong>
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
                    当前值：{data?.settings?.defaultMonthlyQuota ?? 200}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        <Card>
          <CardHeader>
            <CardTitle>最新申请</CardTitle>
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
                        <td>{request.requestedMonthlyQuota}</td>
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

        <section className="grid grid-2">
          <Card>
            <CardHeader>
              <CardTitle>可见用户</CardTitle>
              <CardDescription>按当前管理范围过滤后的用户、申请和代理日志摘要。</CardDescription>
            </CardHeader>
            <CardContent>
              {!overview?.users.length ? (
                <div className="empty">暂无可见用户</div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>用户</th>
                        <th>active key</th>
                        <th>申请</th>
                        <th>日志</th>
                        <th>tokens</th>
                        <th>账期</th>
                        <th>账期 tokens</th>
                        <th>调额</th>
                        <th>更新时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.users.map((user) => (
                        <tr key={user.id}>
                          <td>{user.name ?? maskSecret(user.openId)}</td>
                          <td>{user.activeTokenStatus ?? "-"}</td>
                          <td>{user.requestCount}</td>
                          <td>{user.proxyLogCount}</td>
                          <td>{user.totalTokens ?? 0}</td>
                          <td>
                            <div className="meta-stack">
                              <strong>{user.billingPeriod ?? "-"}</strong>
                              <span>额度 {user.billingMonthlyQuota ?? "-"}</span>
                            </div>
                          </td>
                          <td>
                            <div className="meta-stack">
                              <strong>{user.billingTotalTokens ?? 0}</strong>
                              <span>{user.billingProxyLogCount ?? 0} 次</span>
                            </div>
                          </td>
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

          <Card>
            <CardHeader>
              <CardTitle>代理日志</CardTitle>
              <CardDescription>只显示当前管理范围内的最近代理请求，不显示 Authorization。</CardDescription>
            </CardHeader>
            <CardContent>
              {!overview?.latestProxyLogs.length ? (
                <div className="empty">暂无代理日志</div>
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
                          <td>{log.totalTokens ?? "-"}</td>
                          <td>{formatDateTime(log.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        {data?.authorized && (
          <div className="alert">
            <CheckCircle2Icon data-icon="inline-start" /> 当前管理范围已由服务端确认。调额、重置和部门主管同步仍按 E
            阶段继续补齐。
          </div>
        )}
      </main>
      </div>
    </>
  );
}
