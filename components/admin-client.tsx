"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeftIcon,
  BarChart3Icon,
  Building2Icon,
  CheckCircle2Icon,
  ClipboardListIcon,
  Layers3Icon,
  MenuIcon,
  PackagePlusIcon,
  RefreshCwIcon,
  SendIcon,
  ShieldCheckIcon,
  Trash2Icon,
  XCircleIcon,
  XIcon,
} from "lucide-react";
import { FeishuSdkScript, loginWithFeishu } from "@/components/feishu-login";
import { LoginWaitingScreen } from "@/components/login-waiting-screen";
import { PageSelector } from "@/components/page-selector";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime, formatDepartmentName, maskSecret } from "@/lib/utils";

type Panel = "overview" | "catalog" | "governance" | "requests" | "grants" | "report";
type Scope = { type: "global" | "department"; departmentId?: string; departmentName?: string; source: string; role?: string };
type AdminUser = { id: string; name?: string; openId: string; departmentId?: string; departmentName?: string };
type DisplaySnapshot = {
  configVersion: string;
  displayType: "USD" | "CNY" | "CUSTOM" | "RAW_QUOTA";
  sourceStatus: "current" | "stale" | "unavailable";
  fetchedAt: string;
  customCurrencySymbol: string;
};
type Overview = {
  authenticated: boolean;
  authorized: boolean;
  error?: string;
  user?: AdminUser;
  scope?: Scope;
  totals?: {
    packageDefinitions: number;
    packageRequests: number;
    packageGrants: number;
    grantedQuota: number;
    allocatedQuota: number;
    availableQuota: number;
    authoritativeConsumedQuota: number;
  };
  quotaDisplay?: DisplaySnapshot | null;
};
type Definition = {
  id: string;
  ownerScopeType: "global" | "department";
  ownerDepartmentId?: string;
  code: string;
  name: string;
  description: string;
  status: "active" | "retired";
  updatedAt: string;
};
type Version = {
  id: string;
  definitionId: string;
  version: number;
  grantedQuota: number;
  cycleType: "calendar_month" | "calendar_quarter" | "fixed_days";
  cycleValue: number;
  status: "draft" | "published" | "retired";
  createdAt: string;
};
type DefinitionDetail = { definition: Definition; versions: Version[] };
type AdminRequest = {
  request: { id: string; requestKind: string; status: string; reason: string; departmentIdAtRequest: string; errorMessage?: string; createdAt: string };
  package: { code: string; name: string; version: number; grantedQuota: number };
  user: AdminUser;
};
type AdminGrant = {
  grant: { id: string; status: string; snapshot: { packageName: string; version: number }; grantedQuota: number; allocatedQuota: number; expiresAt: string; departmentIdAtGrant: string };
  user: AdminUser;
};
type Assignment = {
  assignment: { id: string; departmentId: string; packageVersionId: string; isDefault: boolean; status: string };
  package: { code: string; name: string; grantedQuota: number; cycleType: string; cycleValue: number; versionStatus: string };
};
type BudgetOverview = {
  budget: null | { id: string; departmentId: string; periodStart: string; periodEnd: string; budgetQuota: number; committedQuota: number; pendingQuota: number; consumedQuota: number };
  availableQuota: number;
  packages: Array<{ packageVersionId: string; code: string; name: string; grantedQuota: number; issuableCount: number }>;
};
type BillingReport = {
  summary: {
    grantedQuota: number; allocatedQuota: number; availableQuota: number; authoritativeConsumedQuota: number;
    granted: { display: { formatted: string } }; allocated: { display: { formatted: string } };
    available: { display: { formatted: string } }; authoritativeConsumed: { display: { formatted: string } };
  };
  items: Array<{
    allocation: { id: string; sourceIdentity: string; userId: string; departmentIdAtRequest: string; packageGrantId: string; quota: number; occurredAt: string };
    quota: { display: { formatted: string } };
    grant: { snapshot: { packageName: string; version: number } };
  }>;
  total: number; limit: number; offset: number;
};
type DirectoryUser = { id: string; name?: string; openId?: string; departmentId?: string; departmentName?: string };

const terminalStates = new Set(["provisioned", "rejected", "cancelled", "failed"]);
const requestStatus: Record<string, string> = {
  pending_card_send: "发送卡片中", pending_card_approval: "等待审批", approval_card_send_failed: "卡片失败",
  approved: "审批通过", approved_provisioning: "发放中", provisioned: "已发放", rejected: "已拒绝", cancelled: "已取消", failed: "失败",
};

function apiError(body: unknown, fallback: string) {
  if (!body || typeof body !== "object") return fallback;
  const error = (body as { error?: string | { message?: string } }).error;
  return typeof error === "string" ? error : error?.message ?? fallback;
}

function cycleLabel(version: Version) {
  if (version.cycleType === "calendar_month") return `${version.cycleValue} 月`;
  if (version.cycleType === "calendar_quarter") return `${version.cycleValue} 季度`;
  return `${version.cycleValue} 天`;
}

function formatRaw(value?: number) {
  return Number.isFinite(value) ? new Intl.NumberFormat("zh-CN").format(value ?? 0) : "0";
}

export function AdminClient() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [panel, setPanel] = useState<Panel>("overview");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [sdkReady, setSdkReady] = useState(false);
  const [autoLoginAttempted, setAutoLoginAttempted] = useState(false);
  const [definitions, setDefinitions] = useState<DefinitionDetail[]>([]);
  const [requests, setRequests] = useState<AdminRequest[]>([]);
  const [requestTotal, setRequestTotal] = useState(0);
  const [requestPage, setRequestPage] = useState(1);
  const [grants, setGrants] = useState<AdminGrant[]>([]);
  const [grantTotal, setGrantTotal] = useState(0);
  const [grantPage, setGrantPage] = useState(1);
  const [report, setReport] = useState<BillingReport | null>(null);
  const [reportPage, setReportPage] = useState(1);
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [budget, setBudget] = useState<BudgetOverview | null>(null);
  const [departmentId, setDepartmentId] = useState("");
  const [definitionDraft, setDefinitionDraft] = useState({ ownerScopeType: "global", ownerDepartmentId: "", code: "", name: "", description: "" });
  const [versionDraft, setVersionDraft] = useState({ definitionId: "", grantedQuotaDisplay: "", cycleType: "calendar_month", cycleValue: "1" });
  const [assignmentDraft, setAssignmentDraft] = useState({ packageVersionId: "", isDefault: true });
  const [budgetDraft, setBudgetDraft] = useState({ periodStart: "", periodEnd: "", budgetQuotaDisplay: "" });
  const [grantDraft, setGrantDraft] = useState({ userId: "", packageVersionId: "", reason: "管理员按业务需要发放套餐" });

  const pageSize = 20;
  const publishedVersions = useMemo(
    () => definitions.flatMap((item) => item.versions.filter((version) => version.status === "published").map((version) => ({ version, definition: item.definition }))),
    [definitions],
  );
  const departments = useMemo(() => {
    const map = new Map<string, string>();
    for (const user of users) if (user.departmentId) map.set(user.departmentId, formatDepartmentName(user.departmentName, user.departmentId));
    if (overview?.scope?.departmentId) map.set(overview.scope.departmentId, formatDepartmentName(overview.scope.departmentName, overview.scope.departmentId));
    return [...map.entries()].map(([id, label]) => ({ id, label }));
  }, [overview?.scope, users]);

  const loadOverview = useCallback(async () => {
    const response = await fetch("/api/admin/overview?mode=soft", { cache: "no-store" });
    const body = (await response.json().catch(() => ({}))) as Overview;
    setOverview(body);
    if (body.authorized && body.scope?.departmentId) setDepartmentId((current) => current || body.scope?.departmentId || "");
    return body;
  }, []);

  const loadCatalog = useCallback(async () => {
    const response = await fetch("/api/admin/packages?limit=100", { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(apiError(body, "读取套餐目录失败"));
    const items = (body as { items?: Definition[] }).items ?? [];
    const details = await Promise.all(items.map(async (item) => {
      const detailResponse = await fetch(`/api/admin/packages/${encodeURIComponent(item.id)}`, { cache: "no-store" });
      const detailBody = await detailResponse.json().catch(() => ({}));
      if (!detailResponse.ok) throw new Error(apiError(detailBody, "读取套餐版本失败"));
      return detailBody as DefinitionDetail;
    }));
    setDefinitions(details);
  }, []);

  const loadUsers = useCallback(async () => {
    const response = await fetch("/api/admin/users", { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(apiError(body, "读取管理范围用户失败"));
    setUsers((body as { users?: DirectoryUser[] }).users ?? []);
  }, []);

  const loadRequests = useCallback(async () => {
    const response = await fetch(`/api/admin/package-requests?limit=${pageSize}&offset=${(requestPage - 1) * pageSize}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(apiError(body, "读取套餐审批失败"));
    setRequests((body as { items?: AdminRequest[] }).items ?? []);
    setRequestTotal((body as { total?: number }).total ?? 0);
  }, [requestPage]);

  const loadGrants = useCallback(async () => {
    const response = await fetch(`/api/admin/package-grants?limit=${pageSize}&offset=${(grantPage - 1) * pageSize}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(apiError(body, "读取套餐 grants 失败"));
    setGrants((body as { items?: AdminGrant[] }).items ?? []);
    setGrantTotal((body as { total?: number }).total ?? 0);
  }, [grantPage]);

  const loadReport = useCallback(async () => {
    const response = await fetch(`/api/admin/billing-report?limit=${pageSize}&offset=${(reportPage - 1) * pageSize}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(apiError(body, "读取套餐计费报表失败"));
    setReport(body as BillingReport);
  }, [reportPage]);

  const loadGovernance = useCallback(async (targetDepartmentId: string) => {
    if (!targetDepartmentId) { setAssignments([]); setBudget(null); return; }
    const query = `departmentId=${encodeURIComponent(targetDepartmentId)}`;
    const [assignmentResponse, budgetResponse] = await Promise.all([
      fetch(`/api/admin/package-assignments?${query}`, { cache: "no-store" }),
      fetch(`/api/admin/department-budgets?${query}`, { cache: "no-store" }),
    ]);
    const [assignmentBody, budgetBody] = await Promise.all([assignmentResponse.json().catch(() => ({})), budgetResponse.json().catch(() => ({}))]);
    if (!assignmentResponse.ok) throw new Error(apiError(assignmentBody, "读取套餐指派失败"));
    if (!budgetResponse.ok) throw new Error(apiError(budgetBody, "读取部门预算失败"));
    setAssignments((assignmentBody as { items?: Assignment[] }).items ?? []);
    setBudget(budgetBody as BudgetOverview);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const head = await loadOverview();
      if (head.authorized) await Promise.all([loadCatalog(), loadUsers(), loadRequests(), loadGrants(), loadReport()]);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "读取管理后台失败");
    } finally { setLoading(false); }
  }, [loadCatalog, loadGrants, loadOverview, loadReport, loadRequests, loadUsers]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (overview?.authorized) void loadRequests().catch((e) => setError(e.message)); }, [loadRequests, overview?.authorized]);
  useEffect(() => { if (overview?.authorized) void loadGrants().catch((e) => setError(e.message)); }, [loadGrants, overview?.authorized]);
  useEffect(() => { if (overview?.authorized) void loadReport().catch((e) => setError(e.message)); }, [loadReport, overview?.authorized]);
  useEffect(() => { if (overview?.authorized) void loadGovernance(departmentId).catch((e) => setError(e.message)); }, [departmentId, loadGovernance, overview?.authorized]);

  const connectFeishu = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const result = await loginWithFeishu();
      if (result.redirectTo !== window.location.pathname) { window.location.replace(result.redirectTo); return; }
      await refresh();
    } catch (loginError) { setError(loginError instanceof Error ? loginError.message : "飞书登录失败"); }
    finally { setBusy(false); }
  }, [refresh]);

  useEffect(() => {
    if (loading || busy || autoLoginAttempted || !sdkReady || overview?.authenticated) return;
    setAutoLoginAttempted(true); void connectFeishu();
  }, [autoLoginAttempted, busy, connectFeishu, loading, overview?.authenticated, sdkReady]);

  async function mutate(url: string, method: "POST" | "PUT", body?: unknown, success = "操作完成") {
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await fetch(url, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiError(payload, "管理操作失败"));
      setMessage(success);
      await Promise.all([loadOverview(), loadCatalog(), loadRequests(), loadGrants(), loadReport(), loadGovernance(departmentId)]);
      return payload;
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : "管理操作失败");
      return null;
    } finally { setBusy(false); }
  }

  async function createDefinition() {
    const body = {
      ownerScopeType: definitionDraft.ownerScopeType,
      ownerDepartmentId: definitionDraft.ownerScopeType === "department" ? (definitionDraft.ownerDepartmentId || departmentId) : undefined,
      code: definitionDraft.code.trim(), name: definitionDraft.name.trim(), description: definitionDraft.description.trim(),
    };
    const result = await mutate("/api/admin/packages", "POST", body, "套餐定义已创建，可继续创建不可变版本。");
    if (result) setDefinitionDraft((current) => ({ ...current, code: "", name: "", description: "" }));
  }

  async function createVersion() {
    if (!overview?.quotaDisplay?.configVersion) { setError("当前没有可验证的 NewAPI 显示配置，不能创建版本"); return; }
    await mutate(`/api/admin/packages/${encodeURIComponent(versionDraft.definitionId)}/versions`, "POST", {
      grantedQuotaDisplay: Number(versionDraft.grantedQuotaDisplay), configVersion: overview.quotaDisplay.configVersion,
      cycleType: versionDraft.cycleType, cycleValue: Number(versionDraft.cycleValue),
      eligibilityPolicy: { allowFirstRequest: true }, regrantPolicy: { mode: "exhausted" },
    }, "draft 套餐版本已创建。");
  }

  async function saveAssignment() {
    await mutate("/api/admin/package-assignments", "PUT", { departmentId, packageVersionId: assignmentDraft.packageVersionId, isDefault: assignmentDraft.isDefault, status: "active" }, "部门套餐指派已保存。");
  }

  async function saveBudget() {
    if (!overview?.quotaDisplay?.configVersion) { setError("当前没有可验证的显示配置，不能写预算"); return; }
    await mutate("/api/admin/department-budgets", "PUT", {
      departmentId, periodType: "fixed_range", periodStart: new Date(budgetDraft.periodStart).toISOString(), periodEnd: new Date(budgetDraft.periodEnd).toISOString(),
      budgetQuotaDisplay: Number(budgetDraft.budgetQuotaDisplay), configVersion: overview.quotaDisplay.configVersion,
    }, "部门预算已保存。");
  }

  if (loading || (!overview?.authenticated && busy)) return <><FeishuSdkScript onReady={() => setSdkReady(true)} onError={setError} /><LoginWaitingScreen /></>;

  const scope = overview?.scope;
  const quotaUnit = overview?.quotaDisplay?.displayType === "CUSTOM" ? overview.quotaDisplay.customCurrencySymbol : overview?.quotaDisplay?.displayType ?? "点额度";

  return (
    <>
      <FeishuSdkScript onReady={() => setSdkReady(true)} onError={setError} />
      <div className="app-shell">
        <aside className={mobileNavOpen ? "sidebar sidebar-open" : "sidebar"}>
          <div className="sidebar-head">
            <div className="brand"><Image className="brand-mark" src="/icon.svg" alt="" aria-hidden="true" width={36} height={36} priority /><div><h1 className="brand-title">TokenInside</h1><p className="brand-subtitle">套餐治理</p></div></div>
            <button className="sidebar-toggle" type="button" aria-label="切换菜单" onClick={() => setMobileNavOpen((value) => !value)}>{mobileNavOpen ? <XIcon /> : <MenuIcon />}</button>
          </div>
          <div className="sidebar-menu"><nav className="nav-list" aria-label="套餐管理菜单">
            {([
              ["overview", ShieldCheckIcon, "套餐总览"], ["catalog", Layers3Icon, "套餐目录"], ["governance", Building2Icon, "部门指派与预算"],
              ["requests", ClipboardListIcon, "套餐审批"], ["grants", PackagePlusIcon, "Grants"], ["report", BarChart3Icon, "分摊报表"],
            ] as const).map(([id, Icon, label]) => <button key={id} type="button" className={panel === id ? "nav-item active nav-button" : "nav-item nav-button"} onClick={() => { setPanel(id); setMobileNavOpen(false); }}><Icon data-icon="inline-start" />{label}</button>)}
          </nav></div>
        </aside>

        <main className="main">
          <header className="topbar"><div><h2 className="page-title">套餐治理后台</h2><p className="page-description">{scope?.type === "global" ? "全局管理范围" : `部门范围 · ${formatDepartmentName(scope?.departmentName, scope?.departmentId)}`}；所有额度写入均使用当前 NewAPI 显示配置反算原始 quota。</p></div><div className="toolbar"><a className="button button-outline" href="/"><ArrowLeftIcon data-icon="inline-start" />用户后台</a><Button variant="outline" disabled={busy} onClick={() => void refresh()}><RefreshCwIcon data-icon="inline-start" />刷新</Button></div></header>
          {!overview?.authorized && <Alert variant="destructive"><AlertTitle>没有管理权限</AlertTitle><AlertDescription>{overview?.error ?? "当前用户没有启用的管理范围"}</AlertDescription></Alert>}
          {error && <Alert variant="destructive"><AlertTitle>操作未完成</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
          {message && <Alert><AlertTitle>状态更新</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>}
          {overview?.authorized && overview.quotaDisplay?.sourceStatus !== "current" && <Alert variant="destructive"><AlertTitle>显示配置不可用于写入</AlertTitle><AlertDescription>可继续读取 raw quota，但创建套餐版本和修改预算会被阻止。</AlertDescription></Alert>}

          {!overview?.authorized ? null : panel === "overview" ? (
            <div className="stack">
              <div className="admin-package-metrics">
                {[
                  ["套餐定义", overview.totals?.packageDefinitions], ["套餐申请", overview.totals?.packageRequests], ["有效与历史 grants", overview.totals?.packageGrants],
                  ["已发放 raw quota", overview.totals?.grantedQuota], ["已分摊 raw quota", overview.totals?.allocatedQuota], ["当前可用 raw quota", overview.totals?.availableQuota],
                ].map(([label, value]) => <Card key={String(label)}><CardHeader><CardDescription>{label}</CardDescription><CardTitle>{formatRaw(Number(value ?? 0))}</CardTitle></CardHeader></Card>)}
              </div>
              <Card><CardHeader><CardTitle>NewAPI 显示配置</CardTitle><CardDescription>写操作必须携带当前 configVersion；stale 只允许读取。</CardDescription></CardHeader><CardContent className="admin-display-config"><Badge variant={overview.quotaDisplay?.sourceStatus === "current" ? "success" : "danger"}>{overview.quotaDisplay?.sourceStatus ?? "unavailable"}</Badge><div><span>显示类型</span><strong>{quotaUnit}</strong></div><div><span>configVersion</span><code>{overview.quotaDisplay?.configVersion ?? "-"}</code></div><div><span>抓取时间</span><strong>{formatDateTime(overview.quotaDisplay?.fetchedAt)}</strong></div>{scope?.type === "global" && <Button variant="outline" disabled={busy} onClick={() => void mutate("/api/admin/quota-display", "POST", undefined, "显示配置已刷新。")}>刷新显示配置</Button>}</CardContent></Card>
            </div>
          ) : panel === "catalog" ? (
            <div className="stack">
              <div className="package-two-column">
                <Card><CardHeader><CardTitle>创建套餐定义</CardTitle><CardDescription>全局或部门逻辑身份；额度和周期在版本中冻结。</CardDescription></CardHeader><CardContent><FieldGroup><Field><FieldLabel>范围</FieldLabel><Select value={definitionDraft.ownerScopeType} onValueChange={(value) => setDefinitionDraft((current) => ({ ...current, ownerScopeType: value }))}><SelectTrigger className="package-select-trigger"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="global">全局套餐</SelectItem><SelectItem value="department">部门套餐</SelectItem></SelectContent></Select></Field>{definitionDraft.ownerScopeType === "department" && <Field><FieldLabel>所属部门</FieldLabel><Input value={definitionDraft.ownerDepartmentId || departmentId} disabled={scope?.type === "department"} onChange={(event) => setDefinitionDraft((current) => ({ ...current, ownerDepartmentId: event.target.value }))} /></Field>}<Field><FieldLabel>Code</FieldLabel><Input value={definitionDraft.code} onChange={(event) => setDefinitionDraft((current) => ({ ...current, code: event.target.value }))} /></Field><Field><FieldLabel>名称</FieldLabel><Input value={definitionDraft.name} onChange={(event) => setDefinitionDraft((current) => ({ ...current, name: event.target.value }))} /></Field><Field><FieldLabel>说明</FieldLabel><Textarea value={definitionDraft.description} onChange={(event) => setDefinitionDraft((current) => ({ ...current, description: event.target.value }))} /></Field><Button disabled={busy || !definitionDraft.code.trim() || !definitionDraft.name.trim()} onClick={() => void createDefinition()}><PackagePlusIcon data-icon="inline-start" />创建定义</Button></FieldGroup></CardContent></Card>
                <Card><CardHeader><CardTitle>创建 draft 版本</CardTitle><CardDescription>输入单位：{quotaUnit}；发布后版本不可修改。</CardDescription></CardHeader><CardContent><FieldGroup><Field><FieldLabel>套餐定义</FieldLabel><Select value={versionDraft.definitionId} onValueChange={(value) => setVersionDraft((current) => ({ ...current, definitionId: value }))}><SelectTrigger className="package-select-trigger"><SelectValue placeholder="选择定义" /></SelectTrigger><SelectContent>{definitions.filter((item) => item.definition.status === "active").map((item) => <SelectItem key={item.definition.id} value={item.definition.id}>{item.definition.name}</SelectItem>)}</SelectContent></Select></Field><Field><FieldLabel>套餐额度（{quotaUnit}）</FieldLabel><Input type="number" min="0" step="any" value={versionDraft.grantedQuotaDisplay} onChange={(event) => setVersionDraft((current) => ({ ...current, grantedQuotaDisplay: event.target.value }))} /><FieldDescription>服务端使用当前 configVersion 转为整数 raw quota。</FieldDescription></Field><Field><FieldLabel>周期</FieldLabel><Select value={versionDraft.cycleType} onValueChange={(value) => setVersionDraft((current) => ({ ...current, cycleType: value }))}><SelectTrigger className="package-select-trigger"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="calendar_month">自然月</SelectItem><SelectItem value="calendar_quarter">自然季度</SelectItem><SelectItem value="fixed_days">固定天数</SelectItem></SelectContent></Select></Field><Field><FieldLabel>周期值</FieldLabel><Input type="number" min="1" value={versionDraft.cycleValue} onChange={(event) => setVersionDraft((current) => ({ ...current, cycleValue: event.target.value }))} /></Field><Button disabled={busy || overview.quotaDisplay?.sourceStatus !== "current" || !versionDraft.definitionId || !Number(versionDraft.grantedQuotaDisplay)} onClick={() => void createVersion()}><Layers3Icon data-icon="inline-start" />创建 draft</Button></FieldGroup></CardContent></Card>
              </div>
              {definitions.map((item) => <Card key={item.definition.id}><CardHeader className="package-balance-heading"><div><CardTitle>{item.definition.name}</CardTitle><CardDescription>{item.definition.code} · {item.definition.ownerScopeType === "global" ? "全局" : `部门 ${item.definition.ownerDepartmentId}`}</CardDescription></div><Badge variant={item.definition.status === "active" ? "success" : "warning"}>{item.definition.status}</Badge></CardHeader><CardContent><div className="table-wrap table-scroll"><table className="table"><thead><tr><th>版本</th><th>raw quota</th><th>周期</th><th>状态</th><th>创建时间</th><th>动作</th></tr></thead><tbody>{!item.versions.length ? <tr><td colSpan={6}>暂无版本</td></tr> : item.versions.map((version) => <tr key={version.id}><td>v{version.version}</td><td>{formatRaw(version.grantedQuota)}</td><td>{cycleLabel(version)}</td><td><Badge variant={version.status === "published" ? "success" : version.status === "retired" ? "warning" : "default"}>{version.status}</Badge></td><td>{formatDateTime(version.createdAt)}</td><td>{version.status === "draft" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void mutate(`/api/admin/package-versions/${encodeURIComponent(version.id)}/publish`, "POST", undefined, "套餐版本已发布且不可修改。")}>发布</Button> : version.status === "published" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void mutate(`/api/admin/package-versions/${encodeURIComponent(version.id)}/retire`, "POST", undefined, "套餐版本已下架，相关指派已停用。")}>下架</Button> : "-"}</td></tr>)}</tbody></table></div></CardContent></Card>)}
            </div>
          ) : panel === "governance" ? (
            <div className="stack">
              <Card><CardHeader><CardTitle>目标部门</CardTitle><CardDescription>部门主管固定为自己的管理部门；全局管理员可切换。</CardDescription></CardHeader><CardContent><Select value={departmentId} onValueChange={setDepartmentId} disabled={scope?.type === "department"}><SelectTrigger className="package-select-trigger"><SelectValue placeholder="选择部门" /></SelectTrigger><SelectContent>{departments.map((department) => <SelectItem key={department.id} value={department.id}>{department.label}</SelectItem>)}</SelectContent></Select></CardContent></Card>
              <div className="package-two-column">
                <Card><CardHeader><CardTitle>套餐指派</CardTitle><CardDescription>每个部门最多一个 active default。</CardDescription></CardHeader><CardContent><FieldGroup><Field><FieldLabel>已发布版本</FieldLabel><Select value={assignmentDraft.packageVersionId} onValueChange={(value) => setAssignmentDraft((current) => ({ ...current, packageVersionId: value }))}><SelectTrigger className="package-select-trigger"><SelectValue placeholder="选择套餐版本" /></SelectTrigger><SelectContent>{publishedVersions.map(({ version, definition }) => <SelectItem key={version.id} value={version.id}>{definition.name} · v{version.version} · {formatRaw(version.grantedQuota)}</SelectItem>)}</SelectContent></Select></Field><Field orientation="horizontal"><input id="assignment-default" type="checkbox" checked={assignmentDraft.isDefault} onChange={(event) => setAssignmentDraft((current) => ({ ...current, isDefault: event.target.checked }))} /><FieldLabel htmlFor="assignment-default">设为部门默认套餐</FieldLabel></Field><Button disabled={busy || !departmentId || !assignmentDraft.packageVersionId} onClick={() => void saveAssignment()}><SendIcon data-icon="inline-start" />保存指派</Button></FieldGroup><div className="package-history-list admin-assignment-list">{assignments.map((item) => <article key={item.assignment.id}><div><strong>{item.package.name}</strong><Badge variant={item.assignment.status === "active" ? "success" : "warning"}>{item.assignment.isDefault ? "默认" : item.assignment.status}</Badge></div><small>{item.package.code} · {formatRaw(item.package.grantedQuota)} raw quota</small></article>)}</div></CardContent></Card>
                <Card><CardHeader><CardTitle>部门总预算</CardTitle><CardDescription>满足 committed + pending ≤ budget；只有全局管理员可写。</CardDescription></CardHeader><CardContent><div className="admin-budget-metrics"><div><span>总预算</span><strong>{formatRaw(budget?.budget?.budgetQuota)}</strong></div><div><span>已承诺</span><strong>{formatRaw(budget?.budget?.committedQuota)}</strong></div><div><span>审批中</span><strong>{formatRaw(budget?.budget?.pendingQuota)}</strong></div><div><span>已消费</span><strong>{formatRaw(budget?.budget?.consumedQuota)}</strong></div><div><span>可发额度</span><strong>{formatRaw(budget?.availableQuota)}</strong></div></div>{scope?.type === "global" && <FieldGroup><Field><FieldLabel>周期开始</FieldLabel><Input type="datetime-local" value={budgetDraft.periodStart} onChange={(event) => setBudgetDraft((current) => ({ ...current, periodStart: event.target.value }))} /></Field><Field><FieldLabel>周期结束</FieldLabel><Input type="datetime-local" value={budgetDraft.periodEnd} onChange={(event) => setBudgetDraft((current) => ({ ...current, periodEnd: event.target.value }))} /></Field><Field><FieldLabel>总预算（{quotaUnit}）</FieldLabel><Input type="number" min="0" step="any" value={budgetDraft.budgetQuotaDisplay} onChange={(event) => setBudgetDraft((current) => ({ ...current, budgetQuotaDisplay: event.target.value }))} /></Field><Button disabled={busy || overview.quotaDisplay?.sourceStatus !== "current" || !departmentId || !budgetDraft.periodStart || !budgetDraft.periodEnd} onClick={() => void saveBudget()}>保存预算</Button></FieldGroup>}<div className="package-history-list admin-assignment-list">{budget?.packages.map((item) => <article key={item.packageVersionId}><div><strong>{item.name}</strong><Badge>{item.issuableCount} 份可发</Badge></div><small>{formatRaw(item.grantedQuota)} raw quota / 份</small></article>)}</div></CardContent></Card>
              </div>
            </div>
          ) : panel === "requests" ? (
            <Card><CardHeader><CardTitle>套餐审批</CardTitle><CardDescription>服务端真实分页，并按管理 scope 裁剪。</CardDescription></CardHeader><CardContent><div className="table-wrap table-scroll"><table className="table"><thead><tr><th>申请人</th><th>部门</th><th>套餐</th><th>类型</th><th>状态</th><th>理由</th><th>时间</th><th>动作</th></tr></thead><tbody>{requests.map((item) => <tr key={item.request.id}><td>{item.user.name ?? maskSecret(item.user.openId)}</td><td>{formatDepartmentName(item.user.departmentName, item.request.departmentIdAtRequest)}</td><td>{item.package.name} · v{item.package.version}<br /><small>{formatRaw(item.package.grantedQuota)} raw</small></td><td>{item.request.requestKind}</td><td><Badge variant={item.request.status === "provisioned" ? "success" : terminalStates.has(item.request.status) ? "danger" : "warning"}>{requestStatus[item.request.status] ?? item.request.status}</Badge></td><td>{item.request.reason || "-"}</td><td>{formatDateTime(item.request.createdAt)}</td><td><div className="toolbar toolbar-left"><Button size="sm" variant="outline" disabled={busy || terminalStates.has(item.request.status)} onClick={() => void mutate(`/api/admin/package-requests/${encodeURIComponent(item.request.id)}/decision`, "POST", { action: "approve" }, "审批已通过，套餐发放已进入 operation。") }><CheckCircle2Icon data-icon="inline-start" />通过</Button><Button size="sm" variant="outline" disabled={busy || terminalStates.has(item.request.status)} onClick={() => void mutate(`/api/admin/package-requests/${encodeURIComponent(item.request.id)}/decision`, "POST", { action: "reject" }, "套餐申请已拒绝，预算 reservation 已释放。") }><XCircleIcon data-icon="inline-start" />拒绝</Button></div></td></tr>)}</tbody></table></div><PageSelector currentPage={requestPage} pageCount={Math.max(Math.ceil(requestTotal / pageSize), 1)} totalRecords={requestTotal} onPageChange={setRequestPage} /></CardContent></Card>
          ) : panel === "grants" ? (
            <div className="stack">
              <Card><CardHeader><CardTitle>管理员发放套餐</CardTitle><CardDescription>仍受部门指派、版本状态和预算门禁；不会覆盖历史 grant。</CardDescription></CardHeader><CardContent><div className="admin-inline-form"><Select value={grantDraft.userId} onValueChange={(value) => setGrantDraft((current) => ({ ...current, userId: value }))}><SelectTrigger><SelectValue placeholder="选择用户" /></SelectTrigger><SelectContent>{users.map((user) => <SelectItem key={user.id} value={user.id}>{user.name ?? maskSecret(user.openId)} · {formatDepartmentName(user.departmentName, user.departmentId)}</SelectItem>)}</SelectContent></Select><Select value={grantDraft.packageVersionId} onValueChange={(value) => setGrantDraft((current) => ({ ...current, packageVersionId: value }))}><SelectTrigger><SelectValue placeholder="选择套餐" /></SelectTrigger><SelectContent>{publishedVersions.map(({ version, definition }) => <SelectItem key={version.id} value={version.id}>{definition.name} · v{version.version}</SelectItem>)}</SelectContent></Select><Input value={grantDraft.reason} onChange={(event) => setGrantDraft((current) => ({ ...current, reason: event.target.value }))} /><Button disabled={busy || !grantDraft.userId || !grantDraft.packageVersionId || grantDraft.reason.trim().length < 4} onClick={() => void mutate("/api/admin/package-grants", "POST", { ...grantDraft, clientRequestId: window.crypto.randomUUID() }, "管理员套餐发放已进入 operation。") }><SendIcon data-icon="inline-start" />发放</Button></div></CardContent></Card>
              <Card><CardHeader><CardTitle>用户 grants</CardTitle><CardDescription>撤销默认不释放已承诺预算；水位只允许向下收敛。</CardDescription></CardHeader><CardContent><div className="table-wrap table-scroll"><table className="table"><thead><tr><th>用户</th><th>部门</th><th>套餐</th><th>已发/已用/剩余 raw</th><th>状态</th><th>到期</th><th>动作</th></tr></thead><tbody>{grants.map((item) => <tr key={item.grant.id}><td>{item.user.name ?? maskSecret(item.user.openId)}</td><td>{formatDepartmentName(item.user.departmentName, item.grant.departmentIdAtGrant)}</td><td>{item.grant.snapshot.packageName} · v{item.grant.snapshot.version}</td><td>{formatRaw(item.grant.grantedQuota)} / {formatRaw(item.grant.allocatedQuota)} / {formatRaw(item.grant.grantedQuota - item.grant.allocatedQuota)}</td><td><Badge variant={item.grant.status === "active" ? "success" : "warning"}>{item.grant.status}</Badge></td><td>{formatDateTime(item.grant.expiresAt)}</td><td><Button size="sm" variant="outline" disabled={busy || item.grant.status === "revoked" || item.grant.status === "expired"} onClick={() => void mutate(`/api/admin/package-grants/${encodeURIComponent(item.grant.id)}/revoke`, "POST", { reason: "管理员在套餐治理后台撤销 grant", revision: window.crypto.randomUUID() }, "Grant 已撤销，预算承诺按首版策略保留。") }><Trash2Icon data-icon="inline-start" />撤销</Button></td></tr>)}</tbody></table></div><PageSelector currentPage={grantPage} pageCount={Math.max(Math.ceil(grantTotal / pageSize), 1)} totalRecords={grantTotal} onPageChange={setGrantPage} /></CardContent></Card>
            </div>
          ) : (
            <div className="stack">
              {report ? <div className="admin-package-metrics">{[["已发放", report.summary.granted.display.formatted], ["已分摊", report.summary.allocated.display.formatted], ["当前可用", report.summary.available.display.formatted], ["权威消费", report.summary.authoritativeConsumed.display.formatted]].map(([label, value]) => <Card key={label}><CardHeader><CardDescription>{label}</CardDescription><CardTitle>{value}</CardTitle></CardHeader></Card>)}</div> : <Skeleton className="h-36" />}
              <Card><CardHeader><CardTitle>Usage → grant allocation</CardTitle><CardDescription>每条权威消费按冻结 context、到期优先顺序确定性分摊。</CardDescription></CardHeader><CardContent><div className="table-wrap table-scroll"><table className="table"><thead><tr><th>时间</th><th>用户</th><th>部门</th><th>套餐 grant</th><th>额度</th><th>Source identity</th></tr></thead><tbody>{report?.items.map((item) => <tr key={item.allocation.id}><td>{formatDateTime(item.allocation.occurredAt)}</td><td>{item.allocation.userId}</td><td>{item.allocation.departmentIdAtRequest}</td><td>{item.grant.snapshot.packageName} · v{item.grant.snapshot.version}<br /><small>{item.allocation.packageGrantId}</small></td><td>{item.quota.display.formatted}</td><td><code>{item.allocation.sourceIdentity}</code></td></tr>)}</tbody></table></div><PageSelector currentPage={reportPage} pageCount={Math.max(Math.ceil((report?.total ?? 0) / pageSize), 1)} totalRecords={report?.total ?? 0} onPageChange={setReportPage} /></CardContent></Card>
            </div>
          )}
          {busy && <div className="admin-busy-indicator"><Spinner />正在提交并重新读取权威状态</div>}
        </main>
      </div>
    </>
  );
}
