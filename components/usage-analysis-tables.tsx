"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatTokenAmount } from "@/lib/utils";

export type UsageAggregateRow = {
  id: string;
  label: string;
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheReadReportedRequests: number;
  cacheCreationReportedRequests: number;
  cost: number;
  actualCost: number;
  successRate: number;
  avgDurationMs: number;
  cacheHitRate?: number;
  costPerMillionTokens: number;
  issuedQuota?: number;
  usedQuota?: number;
  usageRate?: number;
};

type UsageAnalysisTableProps = {
  title: string;
  emptyText: string;
  rows: UsageAggregateRow[];
  terminalColumn?: "successRate" | "avgDuration" | "efficiency";
  showQuotaAllocation?: boolean;
  className?: string;
};

function formatQuotaFixed(value?: number) {
  if (!Number.isFinite(value)) return "0.00";
  return (value ?? 0).toFixed(2);
}

function formatRate(value?: number, fractionDigits = 1) {
  if (!Number.isFinite(value)) return "—";
  const percentage = (value ?? 0) * 100;
  return fractionDigits === 1
    ? `${Math.round(percentage * 10) / 10}%`
    : `${percentage.toFixed(fractionDigits)}%`;
}

function formatDuration(value?: number) {
  if (!Number.isFinite(value) || !value) return "-";
  if ((value ?? 0) < 1000) return `${Math.round(value ?? 0)}ms`;
  return `${((value ?? 0) / 1000).toFixed((value ?? 0) < 10_000 ? 2 : 1)}s`;
}

function terminalValue(row: UsageAggregateRow, terminalColumn: UsageAnalysisTableProps["terminalColumn"]) {
  switch (terminalColumn) {
    case "successRate":
      return formatRate(row.successRate);
    case "avgDuration":
      return formatDuration(row.avgDurationMs);
    case "efficiency":
      return row.totalTokens > 0 ? `${formatQuotaFixed(row.costPerMillionTokens)}/M` : "-";
    default:
      return formatDuration(row.avgDurationMs);
  }
}

function terminalLabel(terminalColumn: UsageAnalysisTableProps["terminalColumn"]) {
  switch (terminalColumn) {
    case "successRate":
      return "成功率";
    case "efficiency":
      return "效率";
    default:
      return "平均响应";
  }
}

export function UsageAnalysisTable({
  title,
  emptyText,
  rows,
  terminalColumn = "avgDuration",
  showQuotaAllocation = false,
  className,
}: UsageAnalysisTableProps) {
  const columnCount = showQuotaAllocation ? 9 : 6;

  return (
    <Card className={cn("usage-analysis-card", showQuotaAllocation && "usage-analysis-card-quota", className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="table-wrap usage-analysis-table-wrap">
          <table className={cn("table usage-analysis-table", showQuotaAllocation && "usage-analysis-table-quota")}>
            <colgroup>
              <col className="usage-analysis-col-label" />
              <col className="usage-analysis-col-count" />
              <col className="usage-analysis-col-tokens" />
              <col className="usage-analysis-col-cost" />
              {showQuotaAllocation && <col className="usage-analysis-col-issued" />}
              {showQuotaAllocation && <col className="usage-analysis-col-used" />}
              {showQuotaAllocation && <col className="usage-analysis-col-usage-rate" />}
              <col className="usage-analysis-col-rate" />
              <col className="usage-analysis-col-terminal" />
            </colgroup>
            <thead>
              <tr>
                <th>{title.replace(/^按/, "").replace(/分析$/, "")}</th>
                <th>请求数</th>
                <th>
                  <div className="usage-tokens usage-tokens-compact usage-token-labels">
                    <div>
                      <span>输入</span>
                      <span>/</span>
                      <span>输出</span>
                    </div>
                    <div>
                      <span>缓存读</span>
                      <span>/</span>
                      <span>缓存写</span>
                    </div>
                  </div>
                </th>
                <th>额度消耗</th>
                {showQuotaAllocation && <th>发放总额</th>}
                {showQuotaAllocation && <th>已用额度</th>}
                {showQuotaAllocation && <th>使用率</th>}
                <th>缓存命中率</th>
                <th>{terminalLabel(terminalColumn)}</th>
              </tr>
            </thead>
            <tbody>
              {!rows.length ? (
                <tr>
                  <td colSpan={columnCount} className="usage-empty-cell">
                    {emptyText}
                  </td>
                </tr>
              ) : (
                rows.slice(0, 12).map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.label}</strong>
                    </td>
                    <td>{row.requestCount}</td>
                    <td>
                      <div className="usage-tokens usage-tokens-compact">
                        <div>
                          <span>{formatTokenAmount(row.promptTokens, "0")}</span>
                          <span>/</span>
                          <span>{formatTokenAmount(row.completionTokens, "0")}</span>
                        </div>
                        <div>
                          <span title={`已上报 ${row.cacheReadReportedRequests}/${row.requestCount} 条请求`}>
                            {row.cacheReadReportedRequests > 0
                              ? formatTokenAmount(row.cacheReadTokens, "0")
                              : "—"}
                          </span>
                          <span>/</span>
                          <span title={`已上报 ${row.cacheCreationReportedRequests}/${row.requestCount} 条请求`}>
                            {row.cacheCreationReportedRequests > 0
                              ? formatTokenAmount(row.cacheCreationTokens, "0")
                              : "—"}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="usage-cost">
                        <span>{formatQuotaFixed(row.cost)}</span>
                        {row.actualCost > 0 && <span>{formatQuotaFixed(row.actualCost)}</span>}
                      </div>
                    </td>
                    {showQuotaAllocation && <td>{formatQuotaFixed(row.issuedQuota)}</td>}
                    {showQuotaAllocation && <td>{formatQuotaFixed(row.usedQuota)}</td>}
                    {showQuotaAllocation && <td>{formatRate(row.usageRate, 2)}</td>}
                    <td>{formatRate(row.cacheHitRate)}</td>
                    <td>{terminalValue(row, terminalColumn)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
