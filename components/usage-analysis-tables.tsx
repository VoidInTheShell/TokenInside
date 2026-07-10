"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatQuotaAmount, formatTokenAmount } from "@/lib/utils";

export type UsageAggregateRow = {
  id: string;
  label: string;
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cost: number;
  actualCost: number;
  successRate: number;
  avgDurationMs: number;
  cacheHitRate: number;
  costPerMillionTokens: number;
};

type UsageAnalysisTableProps = {
  title: string;
  emptyText: string;
  rows: UsageAggregateRow[];
  terminalColumn?: "successRate" | "avgDuration" | "efficiency";
};

function formatQuota(value?: number) {
  return formatQuotaAmount(value, "0");
}

function formatRate(value?: number) {
  if (!Number.isFinite(value)) return "-";
  return `${Math.round((value ?? 0) * 1000) / 10}%`;
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
      return row.totalTokens > 0 ? `${formatQuota(row.costPerMillionTokens)}/M tok` : "-";
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
}: UsageAnalysisTableProps) {
  return (
    <Card className="usage-analysis-card">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="table-wrap usage-analysis-table-wrap">
          <table className="table usage-analysis-table">
            <colgroup>
              <col className="usage-analysis-col-label" />
              <col className="usage-analysis-col-count" />
              <col className="usage-analysis-col-tokens" />
              <col className="usage-analysis-col-cost" />
              <col className="usage-analysis-col-rate" />
              <col className="usage-analysis-col-terminal" />
            </colgroup>
            <thead>
              <tr>
                <th>{title.replace(/^按/, "").replace(/分析$/, "")}</th>
                <th>请求数</th>
                <th>
                  <div className="usage-th-stack">
                    <span>输入/输出</span>
                    <span>缓存</span>
                  </div>
                </th>
                <th>额度消耗</th>
                <th>缓存命中率</th>
                <th>{terminalLabel(terminalColumn)}</th>
              </tr>
            </thead>
            <tbody>
              {!rows.length ? (
                <tr>
                  <td colSpan={6} className="usage-empty-cell">
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
                          <span>{formatTokenAmount(row.cacheReadTokens, "0")}</span>
                          <span>/</span>
                          <span>{formatTokenAmount(row.cacheCreationTokens, "0")}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="usage-cost">
                        <span>{formatQuota(row.cost)}</span>
                        {row.actualCost > 0 && <span>{formatQuota(row.actualCost)}</span>}
                      </div>
                    </td>
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
