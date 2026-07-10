"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart3Icon,
  CheckCircle2Icon,
  ClipboardCopyIcon,
  HistoryIcon,
  KeyRoundIcon,
  ListFilterIcon,
  LoaderCircleIcon,
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
import {
  UsageRecordsTable,
  type UsageRecordRow,
  type UsageRecordFiltersState,
} from "@/components/usage-records-table";
import {
  UsageAnalysisTable,
  type UsageAggregateRow,
} from "@/components/usage-analysis-tables";
import { formatDateTime, formatDepartmentName, formatQuotaAmount, formatTokenAmount, maskSecret } from "@/lib/utils";

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
    maskedKey?: string;
    remainingQuota?: number;
    billingPeriod: string;
    createdAt: string;
  };
  billingPeriod?: {
    period: string;
    monthlyQuota: number;
    quotaConsumed: number;
    cost: number;
    remainingQuota: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    proxyLogCount: number;
    usageRecordCount: number;
    upstreamRemainingQuota?: number;
  } | null;
  adminScope?: {
    type: "global" | "department";
    departmentId?: string;
    departmentName?: string;
    source: "manual" | "department_supervisor" | "environment";
  } | null;
  requests: Array<{
    id: string;
    requestType: string;
    status: string;
    reason: string;
    approvalTargetSource?: string;
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

type UsageRecordsResponse = {
  records: UsageRecordRow[];
  total?: number;
  limit?: number;
  offset?: number;
  filters?: {
    models?: string[];
    providers?: string[];
    apiFormats?: string[];
    clientFamilies?: string[];
    userAgents?: string[];
  };
  modelStats?: UsageAggregateRow[];
  apiFormatStats?: UsageAggregateRow[];
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

type AdminTokenRequestsResponse = {
  requests: QuickApprovalRequest[];
  total?: number;
  limit?: number;
  offset?: number;
  error?: string;
};

type WorkspacePanel = "account" | "usage" | "models" | "requests";

const DEFAULT_REASON_PLACEHOLDER = "请说明使用场景、接入工具和预计调用方式。";
const FALLBACK_MONTHLY_QUOTA = 200;
const RECENT_APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_APPROVAL_LIMIT = 500;

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
  if (scope.type === "global") return "系统管理员";
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

function canEditQuota(status: string) {
  return ["pending_card_send", "pending_card_approval", "approval_card_send_failed"].includes(status);
}

function appendUsageParam(params: URLSearchParams, key: string, value?: string) {
  if (!value || value === "__all__") return;
  params.set(key, value);
}

export function ExperienceClient() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [models, setModels] = useState<ModelsResponse["models"]>([]);
  const [usageRecords, setUsageRecords] = useState<UsageRecordRow[]>([]);
  const [usageModelStats, setUsageModelStats] = useState<UsageAggregateRow[]>([]);
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
    models: string[];
    apiFormats: string[];
    userAgents: string[];
  }>({
    models: [],
    apiFormats: [],
    userAgents: [],
  });
  const [quickApprovals, setQuickApprovals] = useState<QuickApprovalRequest[]>([]);
  const [quickApprovalTotal, setQuickApprovalTotal] = useState(0);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [usageLoading, setUsageLoading] = useState(false);
  const [quickApprovalLoading, setQuickApprovalLoading] = useState(false);
  const [quickApprovalBusy, setQuickApprovalBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [quotaResetReason, setQuotaResetReason] = useState("");
  const [quickApprovalQuotaDrafts, setQuickApprovalQuotaDrafts] = useState<Record<string, string>>({});
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

  const loadUsageRecords = useCallback(async (options: { quiet?: boolean } = {}) => {
    if (!session?.activeToken) return;
    if (!options.quiet) setUsageLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(usagePageSize));
      params.set("offset", String((usagePage - 1) * usagePageSize));
      params.set("hideUnknownRecords", String(usageHideUnknownRecords));
      appendUsageParam(params, "preset", usageFilters.preset);
      appendUsageParam(params, "search", usageFilters.search);
      appendUsageParam(params, "model", usageFilters.model);
      appendUsageParam(params, "apiFormat", usageFilters.apiFormat);
      appendUsageParam(params, "status", usageFilters.status);
      appendUsageParam(params, "userAgent", usageFilters.userAgent);
      const res = await fetch(`/api/usage-records?${params.toString()}`, { cache: "no-store" });
      const data = (await res.json()) as UsageRecordsResponse;
      if (!res.ok) throw new Error(data.error ?? "读取使用记录失败");
      setUsageRecords(data.records);
      setUsageTotalRecords(data.total ?? data.records.length);
      setUsageModelStats(data.modelStats ?? []);
      setUsageApiFormatStats(data.apiFormatStats ?? []);
      if (data.filters) {
        setUsageFilterOptions({
          models: data.filters.models ?? [],
          apiFormats: data.filters.apiFormats ?? [],
          userAgents: data.filters.userAgents ?? [],
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取使用记录失败");
    } finally {
      if (!options.quiet) setUsageLoading(false);
    }
  }, [
    session?.activeToken,
    usageFilters,
    usageHideUnknownRecords,
    usagePage,
    usagePageSize,
  ]);

  const loadQuickApprovals = useCallback(async () => {
    if (!session?.adminScope) {
      setQuickApprovals([]);
      setQuickApprovalTotal(0);
      setQuickApprovalQuotaDrafts({});
      return;
    }

    setQuickApprovalLoading(true);
    try {
      const createdAfter = new Date(Date.now() - RECENT_APPROVAL_WINDOW_MS).toISOString();
      const requests: QuickApprovalRequest[] = [];
      let offset = 0;
      let total = 0;

      do {
        const params = new URLSearchParams();
        params.set("limit", String(RECENT_APPROVAL_LIMIT));
        params.set("offset", String(offset));
        params.set("createdAfter", createdAfter);
        const res = await fetch(`/api/admin/token-requests?${params.toString()}`, { cache: "no-store" });
        const data = (await res.json()) as AdminTokenRequestsResponse;
        if (!res.ok) throw new Error(data.error ?? "读取最近24小时审批请求失败");
        requests.push(...data.requests);
        total = data.total ?? requests.length;
        offset += data.requests.length;
        if (!data.requests.length) break;
      } while (offset < total);

      setQuickApprovals(requests);
      setQuickApprovalTotal(total);
      setQuickApprovalQuotaDrafts((current) => ({
        ...Object.fromEntries(
          requests.map((request) => [
            request.id,
            String(request.approvedMonthlyQuota ?? request.requestedMonthlyQuota),
          ]),
        ),
        ...current,
      }));
    } catch (err) {
      setQuickApprovals([]);
      setQuickApprovalTotal(0);
      setQuickApprovalQuotaDrafts({});
      setError(err instanceof Error ? err.message : "读取最近24小时审批请求失败");
    } finally {
      setQuickApprovalLoading(false);
    }
  }, [session?.adminScope]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void loadQuickApprovals();
  }, [loadQuickApprovals]);

  useEffect(() => {
    if (panel === "models" && session?.activeToken && !modelsLoaded && !modelsLoading) {
      void loadModels();
    }
  }, [loadModels, modelsLoaded, modelsLoading, panel, session?.activeToken]);

  useEffect(() => {
    if (panel === "usage" && session?.activeToken) {
      void loadUsageRecords();
    }
  }, [loadUsageRecords, panel, session?.activeToken]);

  useEffect(() => {
    setUsagePage(1);
  }, [usageFilters, usageHideUnknownRecords, usagePageSize]);

  useEffect(() => {
    if (panel !== "usage" || !session?.activeToken || !usageAutoRefresh) return;
    const timer = window.setInterval(() => {
      void loadUsageRecords({ quiet: true });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [loadUsageRecords, panel, session?.activeToken, usageAutoRefresh]);

  const requests = useMemo(() => session?.requests ?? [], [session]);
  const latestRequest = requests[0];
  const hasActiveToken = Boolean(session?.activeToken);
  const title = hasActiveToken ? "用户后台" : "Token 申请";
  const defaultMonthlyQuota = session?.settings?.defaultMonthlyQuota ?? FALLBACK_MONTHLY_QUOTA;
  const currentBillingPeriod = session?.billingPeriod ?? null;
  const currentBillingPeriodName =
    currentBillingPeriod?.period ?? session?.activeToken?.billingPeriod ?? "-";
  const remainingQuota =
    currentBillingPeriod?.remainingQuota ?? session?.activeToken?.remainingQuota;
  const upstreamRemainingQuota =
    currentBillingPeriod?.upstreamRemainingQuota ?? session?.activeToken?.remainingQuota;
  const fallbackNotice =
    latestRequest?.approvalTargetSource === "system_admin_fallback"
      ? "您当前不属于任何组织，请求将发送给系统管理员，请联系系统管理员审批"
      : null;

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
      setMessage(body.notice ?? "申请已提交。");
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
      setMessage(body.notice ?? "额度重置申请已提交。");
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

  async function saveQuickApprovalQuota(requestId: string) {
    const approvedMonthlyQuota = Number(quickApprovalQuotaDrafts[requestId]);
    if (!Number.isInteger(approvedMonthlyQuota) || approvedMonthlyQuota <= 0) {
      setError("最终额度必须是正整数");
      return;
    }

    setQuickApprovalBusy(true);
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
      await Promise.all([refresh(), loadQuickApprovals()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存最终额度失败");
    } finally {
      setQuickApprovalBusy(false);
    }
  }

  async function decideQuickApproval(requestId: string, action: "approve" | "reject") {
    const approvedMonthlyQuota = Number(quickApprovalQuotaDrafts[requestId]);
    if (action === "approve" && (!Number.isInteger(approvedMonthlyQuota) || approvedMonthlyQuota <= 0)) {
      setError("通过审批前需要填写正整数最终额度");
      return;
    }

    setQuickApprovalBusy(true);
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
      setMessage(action === "approve" ? "审批已通过，已触发发放。" : "审批请求已拒绝。");
      await Promise.all([refresh(), loadQuickApprovals()]);
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
            </nav>
          </div>
        </aside>

        <main className="main">
          <header className="topbar">
            <div>
              <h2 className="page-title">{title}</h2>
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
                  {(session?.user?.departmentName || session?.user?.departmentId) && (
                    <span>
                      部门：{formatDepartmentName(session.user.departmentName, session.user.departmentId)}
                    </span>
                  )}
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
                  {hasActiveToken && (
                    <Badge variant="success" className="active-key-status">
                      当前用户已有 active key
                    </Badge>
                  )}
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
                      <LoaderCircleIcon className="spin-icon" data-icon="inline-start" />
                    ) : session?.authenticated ? (
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

          {fallbackNotice && <div className="alert">{fallbackNotice}</div>}

          {session?.adminScope && panel === "account" && (
            <Card>
              <CardHeader>
                <CardTitle>审批处理</CardTitle>
                <CardDescription>
                  仅展示当前管理范围内最近 24 小时创建的审批请求，共 {quickApprovalTotal} 条。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="toolbar toolbar-left recent-approval-toolbar">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={quickApprovalLoading || quickApprovalBusy}
                    onClick={() => void loadQuickApprovals()}
                  >
                    <RefreshCwIcon data-icon="inline-start" />
                    刷新
                  </Button>
                  <Badge>{quickApprovalTotal} 条请求</Badge>
                  <a className="button button-outline button-sm" href="/admin">
                    <SlidersHorizontalIcon data-icon="inline-start" />
                    进入完整审批页
                  </a>
                </div>

                {quickApprovalLoading && !quickApprovals.length ? (
                  <div className="empty">读取最近 24 小时审批请求中</div>
                ) : !quickApprovals.length ? (
                  <div className="empty">最近 24 小时暂无审批请求</div>
                ) : (
                  <div className="table-wrap table-scroll recent-approval-viewport">
                    <table className="table recent-approval-table">
                      <thead>
                        <tr>
                          <th>申请人</th>
                          <th>类型</th>
                          <th>状态</th>
                          <th>申请额度</th>
                          <th>最终额度</th>
                          <th>申请理由</th>
                          <th>申请时间</th>
                          <th>快速审批</th>
                        </tr>
                      </thead>
                      <tbody>
                        {quickApprovals.map((request) => (
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
                              <div className="quota-control recent-approval-quota">
                                <Input
                                  aria-label={`最终额度-${request.id}`}
                                  min={1}
                                  step={1}
                                  type="number"
                                  value={
                                    quickApprovalQuotaDrafts[request.id] ??
                                    String(request.approvedMonthlyQuota ?? request.requestedMonthlyQuota)
                                  }
                                  onChange={(event) =>
                                    setQuickApprovalQuotaDrafts((current) => ({
                                      ...current,
                                      [request.id]: event.target.value,
                                    }))
                                  }
                                  disabled={!canEditQuota(request.status) || quickApprovalBusy}
                                />
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={!canEditQuota(request.status) || quickApprovalBusy}
                                  onClick={() => void saveQuickApprovalQuota(request.id)}
                                >
                                  保存
                                </Button>
                              </div>
                            </td>
                            <td>
                              <span className="recent-approval-reason" title={request.reason || undefined}>
                                {request.reason || "-"}
                              </span>
                            </td>
                            <td>{formatDateTime(request.createdAt)}</td>
                            <td>
                              <div className="toolbar toolbar-left recent-approval-actions">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={!canDecideRequest(request.status) || quickApprovalBusy}
                                  onClick={() => void decideQuickApproval(request.id, "approve")}
                                >
                                  <CheckCircle2Icon data-icon="inline-start" />
                                  通过
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={!canDecideRequest(request.status) || quickApprovalBusy}
                                  onClick={() => void decideQuickApproval(request.id, "reject")}
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
                <div className="stack">
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
                            <strong>{formatQuotaAmount(currentBillingPeriod?.monthlyQuota)}</strong>
                          </div>
                          <div className="meta-row">
                            <span>已用额度</span>
                            <strong>{formatQuotaAmount(currentBillingPeriod?.quotaConsumed, "0")}</strong>
                          </div>
                          <div className="meta-row">
                            <span>剩余额度</span>
                            <strong>{formatQuotaAmount(remainingQuota)}</strong>
                          </div>
                          <div className="meta-row">
                            <span>NewAPI 实时剩余</span>
                            <strong>{formatQuotaAmount(upstreamRemainingQuota)}</strong>
                          </div>
                          <div className="meta-row">
                            <span>总 tokens</span>
                            <strong>{formatTokenAmount(currentBillingPeriod?.totalTokens, "0")}</strong>
                          </div>
                          <div className="meta-row">
                            <span>输入 tokens</span>
                            <strong>{formatTokenAmount(currentBillingPeriod?.promptTokens, "0")}</strong>
                          </div>
                          <div className="meta-row">
                            <span>输出 tokens</span>
                            <strong>{formatTokenAmount(currentBillingPeriod?.completionTokens, "0")}</strong>
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

                  <Card>
                    <CardHeader>
                      <div className="usage-section-header">
                        <div>
                          <CardTitle>用量分析</CardTitle>
                          <CardDescription>当前飞书用户通过 TokenInside 产生的调用聚合。</CardDescription>
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
                        <div className="usage-analysis-grid usage-analysis-grid-user">
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
                        loading={usageLoading}
                        showUser={false}
                        showDepartment={false}
                        showControls
                        filters={usageFilters}
                        onFiltersChange={setUsageFilters}
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
                        emptyText="暂无个人使用记录"
                      />
                    </CardContent>
                  </Card>
                </div>
              )}

              {panel === "models" && (
                <Card>
                  <CardHeader>
                    <CardTitle>模型列表</CardTitle>
                    <CardDescription>当前可用的模型ID</CardDescription>
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
            </>
          )}
        </main>
      </div>
    </>
  );
}
