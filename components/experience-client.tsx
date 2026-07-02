"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2Icon,
  ClipboardCopyIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  ListFilterIcon,
  RefreshCwIcon,
  SendIcon,
  ShieldCheckIcon,
  SparklesIcon,
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
    departmentName?: string;
  };
  activeToken?: {
    id: string;
    status: string;
    newapiTokenId?: string;
    createdAt: string;
  };
  adminScope?: {
    type: "global" | "department";
    departmentId?: string;
    departmentName?: string;
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

type WorkspacePanel = "account" | "models";

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
  draft_pending_approval_config: "待配置审批",
};

function badgeVariant(status?: string) {
  if (!status) return "default";
  if (["provisioned", "approved"].includes(status)) return "success";
  if (["rejected", "cancelled", "approved_provision_failed"].includes(status)) {
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
  return `部门 ${scope.departmentName ?? scope.departmentId ?? "-"}`;
}

function departmentLabel(user?: SessionResponse["user"]) {
  return user?.departmentName ?? user?.departmentId ?? "-";
}

export function ExperienceClient() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [models, setModels] = useState<ModelsResponse["models"]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [panel, setPanel] = useState<WorkspacePanel>("account");
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

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      const res = await fetch("/api/token/key", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "读取 key 失败");
      setKey(body.key);
      setMessage("已读取当前 active key。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取 key 失败");
    } finally {
      setBusy(false);
    }
  }

  async function copyBaseUrl() {
    await navigator.clipboard.writeText(`${session?.baseUrl ?? ""}/v1`);
    setMessage("已复制 Base URL。");
  }

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
              <p className="brand-subtitle">Feishu + NewAPI</p>
            </div>
          </div>

          <nav className="nav-list" aria-label="主导航">
            <button
              className={panel === "account" ? "nav-item active nav-button" : "nav-item nav-button"}
              type="button"
              onClick={() => setPanel("account")}
            >
              <KeyRoundIcon data-icon="inline-start" />
              {title}
            </button>
            {hasActiveToken && (
              <button
                className={panel === "models" ? "nav-item active nav-button" : "nav-item nav-button"}
                type="button"
                onClick={() => setPanel("models")}
              >
                <ListFilterIcon data-icon="inline-start" />
                模型列表
              </button>
            )}
          </nav>

          <div className="sidebar-footer">
            {session?.adminScope
              ? `管理范围：${scopeLabel(session.adminScope)}`
              : "当前入口按飞书身份自动识别。"}
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
            <div className="toolbar">
              <Badge variant={session?.authenticated ? "success" : "warning"}>
                {loading || busy
                  ? "自动识别中"
                  : session?.authenticated
                    ? displayName(session.user)
                    : "等待飞书身份"}
              </Badge>
              <Button variant="outline" onClick={() => void refresh()} disabled={busy}>
                <RefreshCwIcon data-icon="inline-start" />
                刷新
              </Button>
            </div>
          </header>

          {error && <div className="alert alert-danger">{error}</div>}
          {message && <div className="alert">{message}</div>}

          <Card>
            <CardContent>
              <div className="user-card">
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
                <div className="user-card-meta">
                  <span>部门</span>
                  <strong>{departmentLabel(session?.user)}</strong>
                </div>
                {session?.adminScope && (
                  <div className="user-card-action">
                    <a className="button button-outline" href="/admin">
                      <ShieldCheckIcon data-icon="inline-start" />
                      管理后台
                    </a>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

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
              <div className="subnav" aria-label="用户后台菜单">
                <Button
                  variant={panel === "account" ? "default" : "outline"}
                  onClick={() => setPanel("account")}
                >
                  <LayoutDashboardIcon data-icon="inline-start" />
                  账户
                </Button>
                <Button
                  variant={panel === "models" ? "default" : "outline"}
                  onClick={() => setPanel("models")}
                >
                  <ListFilterIcon data-icon="inline-start" />
                  模型列表
                </Button>
              </div>

              {panel === "account" ? (
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
                          <span>{key ? maskSecret(key) : maskSecret(session?.activeToken?.newapiTokenId)}</span>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => void revealKey()}
                          >
                            <KeyRoundIcon data-icon="inline-start" />
                            查看
                          </Button>
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
              ) : (
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

              {latestRequest && (
                <Card>
                  <CardHeader>
                    <CardTitle>最近申请</CardTitle>
                    <CardDescription>状态更新时间：{formatDateTime(latestRequest.updatedAt)}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="meta-list">
                      <div className="meta-row">
                        <span>类型</span>
                        <strong>{latestRequest.requestType}</strong>
                      </div>
                      <div className="meta-row">
                        <span>状态</span>
                        <Badge variant={badgeVariant(latestRequest.status)}>
                          {statusLabel[latestRequest.status] ?? latestRequest.status}
                        </Badge>
                      </div>
                    </div>
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
