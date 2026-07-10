"use client";

import { useEffect, useMemo, useState } from "react";
import { EyeOffIcon, RefreshCcwIcon, SearchIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime, formatDepartmentName, formatQuotaAmount, formatTokenAmount, maskSecret } from "@/lib/utils";

export type UsageRequestStatus =
  | "pending"
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled";

export type UsageRecordRow = {
  id: string;
  feishuUserId?: string;
  tokenAccountId?: string;
  userName?: string;
  userOpenId?: string;
  departmentId?: string;
  departmentName?: string;
  requestPath: string;
  method: string;
  status?: UsageRequestStatus;
  rawStatus?: UsageRequestStatus;
  statusCode: number;
  durationMs: number;
  firstByteMs?: number;
  responseTimeUpdatedAt?: string;
  model?: string;
  provider?: string;
  providerKeyName?: string;
  apiFormat?: string;
  endpointApiFormat?: string;
  requestType?: "standard" | "stream";
  isStream?: boolean;
  upstreamIsStream?: boolean;
  clientRequestedStream?: boolean;
  clientIsStream?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  quota?: number;
  cost?: number;
  actualCost?: number;
  usageSource?: "proxy_json" | "proxy_stream" | "newapi_log" | "missing";
  usageSyncedAt?: string;
  newapiLogId?: string;
  newapiRequestId?: string;
  providerChannelName?: string;
  newapiUseTimeSeconds?: number;
  errorMessage?: string;
  clientFamily?: string;
  clientIp?: string;
  userAgent?: string;
  createdAt: string;
  updatedAt?: string;
};

export type UsageOption = {
  id: string;
  label: string;
};

export type UsageRecordFiltersState = {
  preset: string;
  search: string;
  userId: string;
  departmentId: string;
  model: string;
  apiFormat: string;
  status: string;
  userAgent: string;
};

type UsageRecordsTableProps = {
  records: UsageRecordRow[];
  showUser?: boolean;
  showDepartment?: boolean;
  emptyText?: string;
  loading?: boolean;
  showControls?: boolean;
  filters?: UsageRecordFiltersState;
  onFiltersChange?: (filters: UsageRecordFiltersState) => void;
  availableUsers?: UsageOption[];
  availableDepartments?: UsageOption[];
  availableModels?: string[];
  availableApiFormats?: string[];
  availableUserAgents?: string[];
  totalRecords?: number;
  currentPage?: number;
  pageSize?: number;
  pageSizeOptions?: number[];
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  autoRefresh?: boolean;
  onAutoRefreshChange?: (value: boolean) => void;
  hideUnknownRecords?: boolean;
  onHideUnknownRecordsChange?: (value: boolean) => void;
  onRefresh?: () => void;
};

type UsageColumnId =
  | "time"
  | "user"
  | "department"
  | "model"
  | "apiFormat"
  | "status"
  | "tokens"
  | "cost"
  | "performance"
  | "clientFamily";

const DEFAULT_COLUMNS: UsageColumnId[] = [
  "time",
  "user",
  "model",
  "apiFormat",
  "status",
  "tokens",
  "cost",
  "performance",
];

const COLUMN_LABELS: Record<UsageColumnId, string> = {
  time: "时间",
  user: "用户",
  department: "部门",
  model: "模型",
  apiFormat: "API格式",
  status: "类型",
  tokens: "Tokens",
  cost: "额度消耗",
  performance: "首字/总耗时",
  clientFamily: "客户端UA",
};

const PRESET_OPTIONS = [
  { value: "today", label: "今天" },
  { value: "yesterday", label: "昨天" },
  { value: "last7days", label: "最近7天" },
  { value: "last30days", label: "最近30天" },
  { value: "last90days", label: "最近90天" },
  { value: "__all__", label: "全部时间" },
];

const STATUS_OPTIONS = [
  { value: "__all__", label: "全部状态" },
  { value: "stream", label: "流式" },
  { value: "standard", label: "标准" },
  { value: "active", label: "活跃" },
  { value: "failed", label: "失败" },
  { value: "cancelled", label: "已取消" },
];

function statusVariant(record: UsageRecordRow) {
  const status = displayStatus(record);
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  return "warning";
}

function displayStatus(record: UsageRecordRow): UsageRequestStatus {
  if (record.status) return record.status;
  if (record.statusCode === 499) return "cancelled";
  if (record.statusCode >= 400) return "failed";
  return "completed";
}

function requestIsStream(record: UsageRecordRow) {
  return Boolean(
    record.isStream ||
      record.upstreamIsStream ||
      record.clientRequestedStream ||
      record.clientIsStream ||
      record.requestType === "stream",
  );
}

function statusLabel(record: UsageRecordRow) {
  const status = displayStatus(record);
  if (status === "failed") return "失败";
  if (status === "pending") return "等待中";
  if (status === "streaming") return "传输中";
  if (status === "cancelled") return "已取消";
  return requestIsStream(record) ? "流式" : "标准";
}

function formatQuota(value?: number) {
  if (!Number.isFinite(value)) return "0";
  const amount = value ?? 0;
  if (amount === 0) return "0";
  if (Math.abs(amount) < 0.01) return amount.toFixed(4);
  return formatQuotaAmount(amount, "0");
}

function formatMs(value?: number) {
  if (value === undefined || value === null || !Number.isFinite(value)) return "-";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)}s`;
}

function formatApiFormat(value?: string) {
  if (!value) return "-";
  const labels: Record<string, string> = {
    "openai:models": "OpenAI Models",
    "openai:chat": "OpenAI Chat",
    "openai:responses": "OpenAI Responses",
    "claude:messages": "Claude Messages",
  };
  return labels[value] ?? value;
}

function usageSourceLabel(value?: UsageRecordRow["usageSource"]) {
  if (value === "newapi_log") return "NewAPI";
  if (value === "proxy_json") return "代理JSON";
  if (value === "proxy_stream") return "代理流式";
  if (value === "missing") return "缺用量";
  return "未记录";
}

function formatUserAgent(value?: string) {
  if (!value) return "-";
  return value.length > 44 ? `${value.slice(0, 41)}...` : value;
}

function formatOutputRate(record: UsageRecordRow) {
  const output = record.completionTokens ?? 0;
  const durationMs = Math.max((record.durationMs ?? 0) - (record.firstByteMs ?? 0), 0);
  if (!output || !durationMs) return "-";
  return `${(output / (durationMs / 1000)).toFixed(1)} tok/s`;
}

function formatShortDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { time: "-", date: "-" };
  return {
    time: new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date),
    date: new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date),
  };
}

function elapsedMs(record: UsageRecordRow) {
  const status = displayStatus(record);
  if (status !== "pending" && status !== "streaming") return record.durationMs;
  return Math.max(Date.now() - new Date(record.createdAt).getTime(), 0);
}

function visibleColumnDefaults(showUser: boolean, showDepartment: boolean) {
  return DEFAULT_COLUMNS.filter((column) => {
    if (column === "user" && !showUser) return false;
    if (column === "department" && !showDepartment) return false;
    return true;
  });
}

function usageSelect(
  label: string,
  value: string,
  options: Array<{ value: string; label: string }>,
  onChange: (value: string) => void,
) {
  return (
    <label className="usage-filter">
      <span>{label}</span>
      <select className="input usage-select" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TokensCell({ record }: { record: UsageRecordRow }) {
  return (
    <div className="usage-tokens">
      <div>
        <span>{formatTokenAmount(record.promptTokens, "0")}</span>
        <span>/</span>
        <span>{formatTokenAmount(record.completionTokens, "0")}</span>
      </div>
      <div>
        <span>{formatTokenAmount(record.cacheReadTokens, "0")}</span>
        <span>/</span>
        <span>{formatTokenAmount(record.cacheCreationTokens, "0")}</span>
      </div>
    </div>
  );
}

function StatusCell({ record }: { record: UsageRecordRow }) {
  const status = displayStatus(record);
  return (
    <div className="usage-status-cell">
      <Badge
        variant={statusVariant(record)}
        className={status === "pending" || status === "streaming" ? "usage-status-live" : undefined}
      >
        {statusLabel(record)}
      </Badge>
      {record.statusCode > 0 && <span>{record.statusCode}</span>}
    </div>
  );
}

function PerformanceCell({ record }: { record: UsageRecordRow }) {
  const total = elapsedMs(record);
  return (
    <div className="usage-performance">
      <span>
        {formatMs(record.firstByteMs)}
        <span className="usage-muted"> / </span>
        {formatMs(total)}
      </span>
      <span>{formatOutputRate(record)}</span>
    </div>
  );
}

export function UsageRecordsTable({
  records,
  showUser = true,
  showDepartment = false,
  emptyText = "暂无使用记录",
  loading = false,
  showControls = false,
  filters,
  onFiltersChange,
  availableUsers = [],
  availableDepartments = [],
  availableModels = [],
  availableApiFormats = [],
  availableUserAgents = [],
  totalRecords,
  currentPage = 1,
  pageSize = 20,
  pageSizeOptions = [10, 20, 50, 100],
  onPageChange,
  onPageSizeChange,
  autoRefresh = false,
  onAutoRefreshChange,
  hideUnknownRecords = false,
  onHideUnknownRecordsChange,
  onRefresh,
}: UsageRecordsTableProps) {
  const defaultColumns = useMemo(
    () => visibleColumnDefaults(showUser, showDepartment),
    [showDepartment, showUser],
  );
  const [visibleColumns, setVisibleColumns] = useState<UsageColumnId[]>(defaultColumns);

  useEffect(() => {
    setVisibleColumns((current) => {
      const allowed = new Set(visibleColumnDefaults(showUser, showDepartment));
      const next = current.filter((column) => allowed.has(column));
      return next.length ? next : [...allowed];
    });
  }, [showDepartment, showUser]);

  useEffect(() => {
    if (!records.some((record) => displayStatus(record) === "pending" || displayStatus(record) === "streaming")) {
      return;
    }
    const timer = window.setInterval(() => {
      setVisibleColumns((current) => [...current]);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [records]);

  const visibleSet = useMemo(() => new Set(visibleColumns), [visibleColumns]);
  const pageCount =
    totalRecords !== undefined && pageSize > 0 ? Math.max(Math.ceil(totalRecords / pageSize), 1) : 1;

  const updateFilter = (key: keyof UsageRecordFiltersState, value: string) => {
    if (!filters || !onFiltersChange) return;
    onFiltersChange({ ...filters, [key]: value });
  };

  return (
    <div className="usage-records">
      {showControls && filters && (
        <div className="usage-records-controls">
          <div className="usage-records-control-row usage-records-primary-row">
            {usageSelect("时间", filters.preset, PRESET_OPTIONS, (value) => updateFilter("preset", value))}
            <label className="usage-filter usage-search-filter">
              <span>搜索</span>
              <div className="usage-search">
                <SearchIcon size={14} />
                <Input
                  value={filters.search}
                  placeholder={showUser ? "搜索用户/密钥/模型" : "搜索密钥/模型"}
                  onChange={(event) => updateFilter("search", event.target.value)}
                />
              </div>
            </label>
            {showUser &&
              usageSelect(
                "用户",
                filters.userId,
                [{ value: "__all__", label: "全部用户" }, ...availableUsers.map((user) => ({
                  value: user.id,
                  label: user.label,
                }))],
                (value) => updateFilter("userId", value),
              )}
            {showDepartment &&
              usageSelect(
                "部门",
                filters.departmentId,
                [{ value: "__all__", label: "全部部门" }, ...availableDepartments.map((department) => ({
                  value: department.id,
                  label: department.label,
                }))],
                (value) => updateFilter("departmentId", value),
              )}
          </div>
          <div className="usage-records-control-row usage-records-secondary-row">
            {usageSelect(
              "模型",
              filters.model,
              [{ value: "__all__", label: "全部模型" }, ...availableModels.map((model) => ({
                value: model,
                label: model,
              }))],
              (value) => updateFilter("model", value),
            )}
            {usageSelect(
              "格式",
              filters.apiFormat,
              [{ value: "__all__", label: "全部格式" }, ...availableApiFormats.map((format) => ({
                value: format,
                label: formatApiFormat(format),
              }))],
              (value) => updateFilter("apiFormat", value),
            )}
            {usageSelect("状态", filters.status, STATUS_OPTIONS, (value) => updateFilter("status", value))}
            {usageSelect(
              "客户端 UA",
              filters.userAgent,
              [{ value: "__all__", label: "全部 UA" }, ...availableUserAgents.map((userAgent) => ({
                value: userAgent,
                label: formatUserAgent(userAgent),
              }))],
              (value) => updateFilter("userAgent", value),
            )}
            <div className="usage-records-actions">
            <details className="usage-columns">
              <summary>显示列</summary>
              <div>
                {Object.entries(COLUMN_LABELS)
                  .filter(([column]) => {
                    if (column === "user" && !showUser) return false;
                    if (column === "department" && !showDepartment) return false;
                    return true;
                  })
                  .map(([column, label]) => (
                    <label key={column}>
                      <input
                        type="checkbox"
                        checked={visibleSet.has(column as UsageColumnId)}
                        onChange={(event) => {
                          const id = column as UsageColumnId;
                          setVisibleColumns((current) => {
                            if (event.target.checked) return [...current, id];
                            const next = current.filter((item) => item !== id);
                            return next.length ? next : current;
                          });
                        }}
                      />
                      <span>{label}</span>
                    </label>
                  ))}
              </div>
            </details>
            <Button
              variant="ghost"
              size="sm"
              className={hideUnknownRecords ? "usage-toggle-active" : undefined}
              onClick={() => onHideUnknownRecordsChange?.(!hideUnknownRecords)}
              title={hideUnknownRecords ? "显示 unknown 请求" : "隐藏 unknown 请求"}
            >
              <EyeOffIcon data-icon="inline-start" />
              unknown
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={autoRefresh ? "usage-toggle-active" : undefined}
              onClick={() => onAutoRefreshChange?.(!autoRefresh)}
              title={autoRefresh ? "关闭自动刷新" : "开启自动刷新"}
            >
              <RefreshCcwIcon data-icon="inline-start" className={autoRefresh ? "spin" : undefined} />
              自动刷新
            </Button>
            <Button variant="outline" size="sm" disabled={loading} onClick={onRefresh}>
              <RefreshCcwIcon data-icon="inline-start" />
              刷新
            </Button>
            <Badge variant={loading ? "warning" : "default"}>
              {loading ? "读取中" : `${totalRecords ?? records.length} 条`}
            </Badge>
            </div>
          </div>
        </div>
      )}

      <div className="usage-records-mobile">
        {!records.length ? (
          <div className="empty">{loading ? "读取使用记录中" : emptyText}</div>
        ) : (
          records.map((record) => {
            const dateTime = formatShortDateTime(record.createdAt);
            return (
              <article className="usage-record-card" key={record.id}>
                <div className="usage-record-card-main">
                  <div>
                    <strong>{record.model ?? "unknown"}</strong>
                    <span>{formatApiFormat(record.apiFormat)}</span>
                  </div>
                  <div>
                    <span>{formatQuota(record.cost)}</span>
                    <StatusCell record={record} />
                  </div>
                </div>
                {showUser && (
                  <div className="usage-record-card-line">
                    {record.userName ?? maskSecret(record.userOpenId) ?? "-"}
                  </div>
                )}
                {showDepartment && (
                  <div className="usage-record-card-line">
                    {formatDepartmentName(record.departmentName, record.departmentId)}
                  </div>
                )}
                <div className="usage-record-card-line">
                  {dateTime.time} · {dateTime.date} · {record.method} {record.requestPath}
                </div>
                <div className="usage-record-card-metrics">
                  <TokensCell record={record} />
                  <PerformanceCell record={record} />
                </div>
              </article>
            );
          })
        )}
      </div>

      <div className="table-wrap table-scroll table-scroll-usage usage-records-desktop">
        <table className="table usage-table">
          <thead>
            <tr>
              {visibleSet.has("time") && <th>时间</th>}
              {showUser && visibleSet.has("user") && <th>用户</th>}
              {showDepartment && visibleSet.has("department") && <th>部门</th>}
              {visibleSet.has("model") && <th>模型</th>}
              {visibleSet.has("apiFormat") && <th>API格式</th>}
              {visibleSet.has("status") && <th>类型</th>}
              {visibleSet.has("tokens") && <th className="usage-number-heading">Tokens</th>}
              {visibleSet.has("cost") && <th className="usage-number-heading">额度消耗</th>}
              {visibleSet.has("performance") && (
                <th>
                  <div className="usage-th-stack">
                    <span>首字/总耗时</span>
                    <span>输出速度</span>
                  </div>
                </th>
              )}
              {visibleSet.has("clientFamily") && <th>客户端UA</th>}
            </tr>
          </thead>
          <tbody>
            {!records.length ? (
              <tr>
                <td colSpan={visibleColumns.length} className="usage-empty-cell">
                  {loading ? "读取使用记录中" : emptyText}
                </td>
              </tr>
            ) : (
              records.map((record) => {
                const dateTime = formatShortDateTime(record.createdAt);
                return (
                  <tr key={record.id} title={record.errorMessage ?? undefined}>
                    {visibleSet.has("time") && (
                      <td>
                        <div className="usage-time">
                          <span>{dateTime.time}</span>
                          <span>{dateTime.date}</span>
                        </div>
                      </td>
                    )}
                    {showUser && visibleSet.has("user") && (
                      <td>
                        <div className="meta-stack">
                          <strong>{record.userName ?? maskSecret(record.userOpenId) ?? "-"}</strong>
                          <span>{maskSecret(record.tokenAccountId) ?? "-"}</span>
                        </div>
                      </td>
                    )}
                    {showDepartment && visibleSet.has("department") && (
                      <td>{formatDepartmentName(record.departmentName, record.departmentId)}</td>
                    )}
                    {visibleSet.has("model") && (
                      <td>
                        <div className="meta-stack">
                          <strong>{record.model ?? "unknown"}</strong>
                          <span>{record.method} {record.requestPath}</span>
                        </div>
                      </td>
                    )}
                    {visibleSet.has("apiFormat") && <td>{formatApiFormat(record.apiFormat)}</td>}
                    {visibleSet.has("status") && (
                      <td>
                        <StatusCell record={record} />
                      </td>
                    )}
                    {visibleSet.has("tokens") && (
                      <td className="usage-number-cell">
                        <TokensCell record={record} />
                      </td>
                    )}
                    {visibleSet.has("cost") && (
                      <td className="usage-number-cell">
                        <div
                          className="usage-cost"
                          title={[
                            record.usageSyncedAt ? `同步时间：${formatDateTime(record.usageSyncedAt)}` : undefined,
                            record.newapiLogId ? `NewAPI log：${record.newapiLogId}` : undefined,
                            record.newapiRequestId ? `NewAPI request：${record.newapiRequestId}` : undefined,
                            record.providerChannelName ? `渠道：${record.providerChannelName}` : undefined,
                          ].filter(Boolean).join("\n") || undefined}
                        >
                          <span>{formatQuota(record.cost)}</span>
                          {record.actualCost !== undefined && <span>{formatQuota(record.actualCost)}</span>}
                          {record.quota !== undefined && <span>{formatQuotaAmount(record.quota, "0")} quota</span>}
                          <span>{usageSourceLabel(record.usageSource)}</span>
                        </div>
                      </td>
                    )}
                    {visibleSet.has("performance") && (
                      <td>
                        <PerformanceCell record={record} />
                      </td>
                    )}
                    {visibleSet.has("clientFamily") && (
                      <td>
                        <Badge title={record.userAgent ?? record.clientFamily ?? undefined}>
                          {formatUserAgent(record.userAgent ?? record.clientFamily)}
                        </Badge>
                      </td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {showControls && totalRecords !== undefined && totalRecords > 0 && (
        <div className="usage-pagination">
          <span>
            第 {currentPage} / {pageCount} 页
          </span>
          <div className="toolbar toolbar-left">
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage <= 1 || loading}
              onClick={() => onPageChange?.(currentPage - 1)}
            >
              上一页
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage >= pageCount || loading}
              onClick={() => onPageChange?.(currentPage + 1)}
            >
              下一页
            </Button>
            <select
              className="input usage-select"
              value={pageSize}
              onChange={(event) => onPageSizeChange?.(Number(event.target.value))}
            >
              {pageSizeOptions.map((option) => (
                <option key={option} value={option}>
                  {option} / 页
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}
