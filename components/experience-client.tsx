"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIcon,
  CheckCircle2Icon,
  ClipboardCopyIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  RouteIcon,
  SendIcon,
  ShieldCheckIcon,
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
    createdAt: string;
  };
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

const statusLabel: Record<string, string> = {
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

export function ExperienceClient() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("申请个人 LLM 调用 Token，用于共绩内部工具接入。");
  const [quota, setQuota] = useState("200");
  const [key, setKey] = useState<string | null>(null);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取会话失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const usageRows = useMemo(() => session?.requests ?? [], [session]);

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
          reason,
          requestedMonthlyQuota: Number(quota),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "提交申请失败");
      setMessage("申请已提交，后续由飞书审批流处理。");
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
      setMessage("已从后端读取当前 active key。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取 key 失败");
    } finally {
      setBusy(false);
    }
  }

  async function copyBaseUrl() {
    await navigator.clipboard.writeText(`${session?.baseUrl ?? ""}/v1`);
    setMessage("已复制 OpenAI-compatible Base URL。");
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
            <p className="brand-subtitle">Feishu + NewAPI Gateway</p>
          </div>
        </div>

        <nav className="nav-list" aria-label="主导航">
          <a className="nav-item active" href="/">
            <KeyRoundIcon data-icon="inline-start" />
            Token 控制台
          </a>
          <div className="nav-item">
            <RouteIcon data-icon="inline-start" />
            /v1 透传网关
          </div>
          <div className="nav-item">
            <ActivityIcon data-icon="inline-start" />
            审计与用量
          </div>
          <a className="nav-item" href="/admin">
            <ShieldCheckIcon data-icon="inline-start" />
            管理后台
          </a>
        </nav>

        <div className="sidebar-footer">
          对外 Base URL 固定为 TokenInside 域名；NewAPI 直连地址与系统凭据只保存在服务端环境变量。
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h2 className="page-title">共绩 Token 申请与透传控制面</h2>
            <p className="page-description">
              使用飞书 OAuth 绑定真实用户，通过飞书审批发放 NewAPI 原生 key，并强制客户端请求走 TokenInside
              的 OpenAI-compatible 代理入口。
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

        {session?.authenticated && (
          <Card>
            <CardContent>
              <div className="user-card">
                <div className="user-avatar" aria-hidden="true">
                  {session.user?.avatarUrl ? (
                    <img src={session.user.avatarUrl} alt="" />
                  ) : (
                    <span>{avatarInitial(session.user)}</span>
                  )}
                </div>
                <div className="user-card-main">
                  <span className="user-card-label">当前飞书用户</span>
                  <strong>{displayName(session.user)}</strong>
                  <span>{session.user?.openId ? maskSecret(session.user.openId) : "-"}</span>
                </div>
                <div className="user-card-meta">
                  <span>租户</span>
                  <strong>{session.user?.tenantKey ?? "-"}</strong>
                </div>
                <div className="user-card-meta">
                  <span>部门</span>
                  <strong>{session.user?.departmentId ?? "-"}</strong>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {error && <div className="alert alert-danger">{error}</div>}
        {message && <div className="alert">{message}</div>}

        <section className="grid grid-4">
          <Card>
            <CardContent>
              <div className="metric">
                <span className="metric-label">当前 active key</span>
                <span className="metric-value">{session?.activeToken ? "1" : "0"}</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <div className="metric">
                <span className="metric-label">申请记录</span>
                <span className="metric-value">{session?.requests.length ?? 0}</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <div className="metric">
                <span className="metric-label">代理审计日志</span>
                <span className="metric-value">{session?.proxyLogCount ?? 0}</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <div className="metric">
                <span className="metric-label">网关状态</span>
                <span className="metric-value">/v1</span>
              </div>
            </CardContent>
          </Card>
        </section>

        <section className="grid grid-2">
          <Card>
            <CardHeader>
              <CardTitle>Token 申请</CardTitle>
              <CardDescription>
                申请会进入飞书审批实例。审批通过后，后端再发放 NewAPI token。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="field-group">
                <div className="field">
                  <label htmlFor="quota">月额度</label>
                  <Input
                    id="quota"
                    inputMode="numeric"
                    value={quota}
                    onChange={(event) => setQuota(event.target.value)}
                    disabled={!session?.authenticated || busy}
                  />
                  <span className="field-description">
                    额度单位按 NewAPI 当前实例配置换算，审批记录是 TokenInside 侧权威口径。
                  </span>
                </div>
                <div className="field">
                  <label htmlFor="reason">申请说明</label>
                  <Textarea
                    id="reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    disabled={!session?.authenticated || busy}
                  />
                </div>
                <Button
                  onClick={() => void requestToken()}
                  disabled={!session?.authenticated || busy}
                >
                  <SendIcon data-icon="inline-start" />
                  提交飞书审批
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>客户端接入</CardTitle>
              <CardDescription>
                客户端使用 NewAPI 原生 key，但 Base URL 必须指向 TokenInside。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="field">
                <label>OpenAI-compatible Base URL</label>
                <div className="key-box">
                  <span>{session?.baseUrl ? `${session.baseUrl}/v1` : "-"}</span>
                  <Button variant="ghost" size="sm" onClick={() => void copyBaseUrl()}>
                    <ClipboardCopyIcon data-icon="inline-start" />
                    复制
                  </Button>
                </div>
              </div>
              <div className="field">
                <label>当前 key</label>
                <div className="key-box">
                  <span>{key ? maskSecret(key) : maskSecret(session?.activeToken?.newapiTokenId)}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!session?.activeToken || busy}
                    onClick={() => void revealKey()}
                  >
                    <KeyRoundIcon data-icon="inline-start" />
                    查看
                  </Button>
                </div>
              </div>
              <div className="alert">
                后端只按请求中的 Bearer key 做 hash 反查和归属校验，不给 LLM 客户端签发 TokenInside
                自有凭证。
              </div>
            </CardContent>
          </Card>
        </section>

        <Card>
          <CardHeader>
            <CardTitle>审批与发放记录</CardTitle>
            <CardDescription>审批状态由飞书 approval_instance 事件回写，NewAPI 发放过程做幂等保护。</CardDescription>
          </CardHeader>
          <CardContent>
            {usageRows.length === 0 ? (
              <div className="empty">暂无申请记录</div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>类型</th>
                      <th>状态</th>
                      <th>说明</th>
                      <th>创建时间</th>
                      <th>更新时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usageRows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.requestType}</td>
                        <td>
                          <Badge variant={badgeVariant(row.status)}>
                            {statusLabel[row.status] ?? row.status}
                          </Badge>
                        </td>
                        <td>{row.reason}</td>
                        <td>{formatDateTime(row.createdAt)}</td>
                        <td>{formatDateTime(row.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {session?.activeToken && (
          <div className="alert">
            <CheckCircle2Icon data-icon="inline-start" /> 当前用户已有 active key。再次申请不会绕过唯一
            key 约束，key 重置和调额会走独立审批状态机。
          </div>
        )}
      </main>
      </div>
    </>
  );
}
