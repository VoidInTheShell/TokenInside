"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart3Icon,
  ClipboardCopyIcon,
  HistoryIcon,
  KeyRoundIcon,
  Layers3Icon,
  ListFilterIcon,
  MenuIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  XIcon,
} from "lucide-react";
import { PackageBalanceCard } from "@/components/package-balance-card";
import type {
  ClientAvailablePackage,
  ClientPackageMe,
} from "@/components/package-client-types";
import { PackageGrantList } from "@/components/package-grant-list";
import { PackageRequestForm } from "@/components/package-request-form";
import { FeishuSdkScript, loginWithFeishu } from "@/components/feishu-login";
import { LoginWaitingScreen } from "@/components/login-waiting-screen";
import { UsageRecordsTable, type UsageRecordFiltersState, type UsageRecordRow } from "@/components/usage-records-table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { shouldRedirectToDefaultAdminPath } from "@/lib/auth-landing";
import { formatDateTime, formatDepartmentName, maskSecret } from "@/lib/utils";

type SessionResponse = {
  authenticated: boolean;
  baseUrl: string;
  user?: {
    id: string;
    name?: string;
    avatarUrl?: string;
    openId: string;
    departmentId?: string;
    departmentName?: string;
  };
  activeToken?: {
    id: string;
    status: string;
    maskedKey?: string;
    createdAt: string;
    operationGeneration?: number;
  } | null;
  adminScope?: {
    type: "global" | "department";
    departmentId?: string;
    departmentName?: string;
    source: string;
    role?: string;
  } | null;
};

type ModelsResponse = { models?: Array<{ id: string; object?: string; ownedBy?: string }>; error?: string };
type UsageResponse = {
  records?: UsageRecordRow[];
  total?: number;
  filters?: { models?: string[]; apiFormats?: string[]; userAgents?: string[] };
  error?: string;
};
type Panel = "packages" | "usage" | "models" | "history";

const openPackageStatuses = new Set([
  "pending_card_send",
  "pending_card_approval",
  "approved",
  "approved_provisioning",
]);

const packageRequestStatus: Record<string, string> = {
  pending_card_send: "发送审批卡片中",
  pending_card_approval: "等待审批",
  approval_card_send_failed: "审批卡片发送失败",
  approved: "审批通过",
  approved_provisioning: "套餐发放中",
  provisioned: "已发放",
  rejected: "已拒绝",
  cancelled: "已取消",
  failed: "处理失败",
};

const packageRequestKind: Record<string, string> = {
  first: "首次套餐",
  regrant: "重发套餐",
  admin_grant: "管理员发放",
};

function apiError(body: unknown, fallback: string) {
  if (!body || typeof body !== "object") return fallback;
  const record = body as { error?: string | { message?: string } };
  if (typeof record.error === "string") return record.error;
  return record.error?.message ?? fallback;
}

function displayName(session: SessionResponse | null) {
  return session?.user?.name || maskSecret(session?.user?.openId) || "-";
}

function avatarInitial(session: SessionResponse | null) {
  return displayName(session).trim().slice(0, 1).toUpperCase() || "T";
}

export function ExperienceClient() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [packageMe, setPackageMe] = useState<ClientPackageMe | null>(null);
  const [availablePackages, setAvailablePackages] = useState<ClientAvailablePackage[]>([]);
  const [panel, setPanel] = useState<Panel>("packages");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [packageLoading, setPackageLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [feishuSdkReady, setFeishuSdkReady] = useState(false);
  const [autoLoginAttempted, setAutoLoginAttempted] = useState(false);
  const [models, setModels] = useState<NonNullable<ModelsResponse["models"]>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [usageRecords, setUsageRecords] = useState<UsageRecordRow[]>([]);
  const [usageTotal, setUsageTotal] = useState(0);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usagePage, setUsagePage] = useState(1);
  const [usagePageSize, setUsagePageSize] = useState(20);
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
  const [usageOptions, setUsageOptions] = useState({ models: [] as string[], apiFormats: [] as string[], userAgents: [] as string[] });

  const loadPackages = useCallback(async () => {
    setPackageLoading(true);
    try {
      const [meResponse, availableResponse] = await Promise.all([
        fetch("/api/packages/me", { cache: "no-store" }),
        fetch("/api/packages/available", { cache: "no-store" }),
      ]);
      const [meBody, availableBody] = await Promise.all([
        meResponse.json().catch(() => ({})),
        availableResponse.json().catch(() => ({})),
      ]);
      if (!meResponse.ok) throw new Error(apiError(meBody, "读取套餐账本失败"));
      if (!availableResponse.ok) throw new Error(apiError(availableBody, "读取可申请套餐失败"));
      setPackageMe(meBody as ClientPackageMe);
      setAvailablePackages((availableBody as { items?: ClientAvailablePackage[] }).items ?? []);
    } finally {
      setPackageLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/session", { cache: "no-store" });
      const data = (await response.json()) as SessionResponse;
      if (
        data.authenticated &&
        shouldRedirectToDefaultAdminPath({
          scope: data.adminScope ? { scopeType: data.adminScope.type } : null,
          currentPath: window.location.pathname,
          search: window.location.search,
        })
      ) {
        window.location.replace("/admin");
        return;
      }
      setSession(data);
      setKey(null);
      if (data.authenticated) await loadPackages();
      else {
        setPackageMe(null);
        setAvailablePackages([]);
      }
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "读取会话失败");
    } finally {
      setLoading(false);
    }
  }, [loadPackages]);

  useEffect(() => { void refresh(); }, [refresh]);

  const connectFeishu = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await loginWithFeishu();
      if (result.redirectTo !== window.location.pathname) {
        window.location.replace(result.redirectTo);
        return;
      }
      await refresh();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "飞书登录失败");
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  useEffect(() => {
    if (loading || busy || autoLoginAttempted || !feishuSdkReady || session?.authenticated) return;
    setAutoLoginAttempted(true);
    void connectFeishu();
  }, [autoLoginAttempted, busy, connectFeishu, feishuSdkReady, loading, session?.authenticated]);

  const loadModels = useCallback(async () => {
    if (!session?.activeToken) return;
    setModelsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/models", { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as ModelsResponse;
      if (!response.ok) throw new Error(body.error ?? "读取模型列表失败");
      setModels(body.models ?? []);
    } catch (modelError) {
      setError(modelError instanceof Error ? modelError.message : "读取模型列表失败");
    } finally {
      setModelsLoading(false);
    }
  }, [session?.activeToken]);

  const loadUsage = useCallback(async () => {
    if (!session?.activeToken) return;
    setUsageLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        limit: String(usagePageSize),
        offset: String((usagePage - 1) * usagePageSize),
        preset: usageFilters.preset,
      });
      for (const key of ["search", "model", "apiFormat", "status", "userAgent"] as const) {
        const value = usageFilters[key];
        if (value && value !== "__all__") params.set(key, value);
      }
      const response = await fetch(`/api/usage-records?${params.toString()}`, { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as UsageResponse;
      if (!response.ok) throw new Error(body.error ?? "读取使用记录失败");
      setUsageRecords(body.records ?? []);
      setUsageTotal(body.total ?? body.records?.length ?? 0);
      setUsageOptions({
        models: body.filters?.models ?? [],
        apiFormats: body.filters?.apiFormats ?? [],
        userAgents: body.filters?.userAgents ?? [],
      });
    } catch (usageError) {
      setError(usageError instanceof Error ? usageError.message : "读取使用记录失败");
    } finally {
      setUsageLoading(false);
    }
  }, [session?.activeToken, usageFilters, usagePage, usagePageSize]);

  useEffect(() => { if (panel === "models") void loadModels(); }, [loadModels, panel]);
  useEffect(() => { if (panel === "usage") void loadUsage(); }, [loadUsage, panel]);
  useEffect(() => { setUsagePage(1); }, [usageFilters, usagePageSize]);

  const pendingRequest = useMemo(
    () => packageMe?.requests.find((request) => openPackageStatuses.has(request.status)),
    [packageMe?.requests],
  );
  const hasGrant = Boolean(packageMe?.grants.some((grant) => grant.status === "active" || grant.status === "exhausted"));

  async function submitPackageRequest(input: { packageVersionId: string; requestKind: "first" | "regrant"; reason: string }) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/packages/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, clientRequestId: window.crypto.randomUUID() }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiError(body, "提交套餐申请失败"));
      setMessage((body as { notice?: string }).notice ?? "套餐申请已提交，请在飞书审批卡片中跟踪进度。");
      await loadPackages();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "提交套餐申请失败");
    } finally {
      setBusy(false);
    }
  }

  async function revealKey() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/token/key", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiError(body, "读取 Key 失败"));
      const fullKey = (body as { key?: string }).key;
      if (!fullKey) throw new Error("服务端未返回 Key");
      setKey(fullKey);
      await navigator.clipboard.writeText(fullKey).catch(() => undefined);
      setMessage("当前 active key 已展示，并已尝试复制到剪贴板。");
    } catch (keyError) {
      setError(keyError instanceof Error ? keyError.message : "读取 Key 失败");
    } finally {
      setBusy(false);
    }
  }

  async function rotateKey() {
    if (!window.confirm("更换只改变凭证和 generation，不会重发套餐或清空历史用量。确认继续？")) return;
    setBusy(true);
    setError(null);
    setMessage("正在排空旧 generation 并核对替换 Key 水位，请保持页面打开。");
    try {
      const response = await fetch("/api/token/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "用户在 TokenInside 套餐后台发起 Key 更换",
          clientRequestId: window.crypto.randomUUID(),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiError(body, "Key 更换失败"));
      const deliveredKey = (body as { key?: string }).key;
      if (deliveredKey) {
        setKey(deliveredKey);
        await navigator.clipboard.writeText(deliveredKey).catch(() => undefined);
      }
      setMessage(deliveredKey ? "Key 更换完成，新 Key 已展示并尝试复制。" : "Key 更换操作已幂等完成。");
      await refresh();
    } catch (rotationError) {
      setError(rotationError instanceof Error ? rotationError.message : "Key 更换失败");
    } finally {
      setBusy(false);
    }
  }

  async function copyBaseUrl() {
    await navigator.clipboard.writeText(`${session?.baseUrl ?? ""}/v1`);
    setMessage("Base URL 已复制。");
  }

  function selectPanel(next: Panel) {
    setPanel(next);
    setMobileNavOpen(false);
  }

  if (loading || (!session?.authenticated && busy)) {
    return (
      <>
        <FeishuSdkScript onReady={() => setFeishuSdkReady(true)} onError={setError} />
        <LoginWaitingScreen />
      </>
    );
  }

  return (
    <>
      <FeishuSdkScript onReady={() => setFeishuSdkReady(true)} onError={setError} />
      <div className="app-shell">
        <aside className={mobileNavOpen ? "sidebar sidebar-open" : "sidebar"}>
          <div className="sidebar-head">
            <div className="brand">
              <Image className="brand-mark" src="/icon.svg" alt="" aria-hidden="true" width={36} height={36} priority />
              <div><h1 className="brand-title">TokenInside</h1><p className="brand-subtitle">共绩科技</p></div>
            </div>
            <button className="sidebar-toggle" type="button" aria-label="切换菜单" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen((value) => !value)}>
              {mobileNavOpen ? <XIcon /> : <MenuIcon />}
            </button>
          </div>
          <div className="sidebar-menu">
            <nav className="nav-list" aria-label="用户后台菜单">
              <button className={panel === "packages" ? "nav-item active nav-button" : "nav-item nav-button"} type="button" onClick={() => selectPanel("packages")}>
                <Layers3Icon data-icon="inline-start" />套餐与 Key
              </button>
              <button className={panel === "usage" ? "nav-item active nav-button" : "nav-item nav-button"} type="button" onClick={() => selectPanel("usage")} disabled={!session?.activeToken}>
                <BarChart3Icon data-icon="inline-start" />用量记录
              </button>
              <button className={panel === "models" ? "nav-item active nav-button" : "nav-item nav-button"} type="button" onClick={() => selectPanel("models")} disabled={!session?.activeToken}>
                <ListFilterIcon data-icon="inline-start" />模型列表
              </button>
              <button className={panel === "history" ? "nav-item active nav-button" : "nav-item nav-button"} type="button" onClick={() => selectPanel("history")}>
                <HistoryIcon data-icon="inline-start" />处理记录
              </button>
            </nav>
          </div>
        </aside>

        <main className="main">
          <header className="topbar">
            <div><h2 className="page-title">套餐工作台</h2><p className="page-description">套餐 grant 是唯一额度授权；Key 只是承载调用的可轮换凭证。</p></div>
            <div className="toolbar">
              {session?.adminScope && <a className="button button-outline" href="/admin"><ShieldCheckIcon data-icon="inline-start" />管理后台</a>}
              <Button variant="outline" onClick={() => void refresh()} disabled={busy || packageLoading}><RefreshCwIcon data-icon="inline-start" />刷新</Button>
            </div>
          </header>

          {error && <Alert variant="destructive"><AlertTitle>操作未完成</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
          {message && <Alert><AlertTitle>状态更新</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>}

          <Card>
            <CardContent className="package-user-strip">
              <div className="user-avatar" aria-hidden="true">
                {session?.user?.avatarUrl ? <img src={session.user.avatarUrl} alt="" /> : <span>{avatarInitial(session)}</span>}
              </div>
              <div className="user-card-main"><span className="user-card-label">当前飞书用户</span><strong>{displayName(session)}</strong><small>{formatDepartmentName(session?.user?.departmentName, session?.user?.departmentId)}</small></div>
              <Badge variant={session?.activeToken ? "success" : "warning"}>{session?.activeToken ? "active key" : "尚无 active key"}</Badge>
            </CardContent>
          </Card>

          {packageLoading && !packageMe ? (
            <div className="package-skeleton-grid"><Skeleton className="h-52" /><Skeleton className="h-52" /></div>
          ) : panel === "packages" ? (
            <div className="stack">
              {packageMe && <PackageBalanceCard data={packageMe} />}
              <div className="package-two-column">
                {packageMe && <PackageGrantList grants={packageMe.grants} />}
                <PackageRequestForm items={availablePackages} hasGrant={hasGrant} pending={Boolean(pendingRequest)} busy={busy} onSubmit={submitPackageRequest} />
              </div>
              <Card>
                <CardHeader><CardTitle>调用凭证</CardTitle><CardDescription>Key 更换不改变 grants、部门预算承诺或历史 allocation。</CardDescription></CardHeader>
                <CardContent className="package-key-panel">
                  <div><span>Base URL</span><code>{session?.baseUrl}/v1</code></div>
                  <Button variant="outline" onClick={() => void copyBaseUrl()}><ClipboardCopyIcon data-icon="inline-start" />复制地址</Button>
                  <div><span>active key</span><code>{key ?? session?.activeToken?.maskedKey ?? "套餐发放后可查看"}</code></div>
                  <Button variant="outline" disabled={busy || !session?.activeToken} onClick={() => void revealKey()}><KeyRoundIcon data-icon="inline-start" />查看并复制</Button>
                  <Button variant="outline" disabled={busy || !session?.activeToken || !packageMe?.balance.availableQuota} onClick={() => void rotateKey()}>
                    {busy ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}更换
                  </Button>
                </CardContent>
              </Card>
            </div>
          ) : panel === "usage" ? (
            <Card>
              <CardHeader><CardTitle>权威用量记录</CardTitle><CardDescription>额度消耗与输入、输出、缓存 Tokens 分栏展示。</CardDescription></CardHeader>
              <CardContent>
                <UsageRecordsTable
                  records={usageRecords}
                  showUser={false}
                  loading={usageLoading}
                  showControls
                  filters={usageFilters}
                  onFiltersChange={setUsageFilters}
                  availableModels={usageOptions.models}
                  availableApiFormats={usageOptions.apiFormats}
                  availableUserAgents={usageOptions.userAgents}
                  totalRecords={usageTotal}
                  currentPage={usagePage}
                  pageSize={usagePageSize}
                  onPageChange={setUsagePage}
                  onPageSizeChange={setUsagePageSize}
                  onRefresh={() => void loadUsage()}
                />
              </CardContent>
            </Card>
          ) : panel === "models" ? (
            <Card>
              <CardHeader><CardTitle>可用模型</CardTitle><CardDescription>使用当前 active key 从 NewAPI 实时读取。</CardDescription></CardHeader>
              <CardContent>
                {modelsLoading ? <div className="package-loading"><Spinner />读取模型列表</div> : !models.length ? (
                  <Empty><EmptyHeader><EmptyTitle>暂无模型</EmptyTitle><EmptyDescription>请确认 Key 已启用且 NewAPI 已配置可用渠道。</EmptyDescription></EmptyHeader></Empty>
                ) : <div className="model-grid">{models.map((model) => <div className="model-item" key={model.id}><strong>{model.id}</strong><span>{model.ownedBy ?? model.object ?? "NewAPI"}</span></div>)}</div>}
              </CardContent>
            </Card>
          ) : (
            <div className="package-history-grid">
              <Card>
                <CardHeader><CardTitle>套餐申请</CardTitle><CardDescription>首次申请、重发和管理员发放的审批状态。</CardDescription></CardHeader>
                <CardContent>
                  {!packageMe?.requests.length ? <Empty><EmptyHeader><EmptyTitle>暂无申请记录</EmptyTitle></EmptyHeader></Empty> : (
                    <div className="package-history-list">{packageMe.requests.map((request) => (
                      <article key={request.id}><div><strong>{packageRequestKind[request.requestKind] ?? request.requestKind}</strong><Badge variant={request.status === "provisioned" ? "success" : request.status === "failed" || request.status === "rejected" ? "danger" : "warning"}>{packageRequestStatus[request.status] ?? request.status}</Badge></div><p>{request.reason || "未填写申请理由"}</p><small>{formatDateTime(request.updatedAt)}{request.errorMessage ? ` · ${request.errorMessage}` : ""}</small></article>
                    ))}</div>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>计费操作</CardTitle><CardDescription>发放、分摊、撤销、对账与 Key 更换的统一 operation。</CardDescription></CardHeader>
                <CardContent>
                  {!packageMe?.operations.length ? <Empty><EmptyHeader><EmptyTitle>暂无操作记录</EmptyTitle></EmptyHeader></Empty> : (
                    <div className="package-history-list">{packageMe.operations.map((operation) => (
                      <article key={operation.id}><div><strong>{operation.operationType}</strong><Badge variant={operation.state === "completed" ? "success" : operation.state === "manual_review" ? "danger" : "warning"}>{operation.state}</Badge></div><p>{operation.currentStep}</p><small>{formatDateTime(operation.updatedAt)}{operation.lastErrorMessage ? ` · ${operation.lastErrorMessage}` : ""}</small></article>
                    ))}</div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </main>
      </div>
    </>
  );
}
