"use client";

import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatTokenAmount, maskSecret } from "@/lib/utils";

export type UsageRecordRow = {
  id: string;
  userName?: string;
  userOpenId?: string;
  departmentId?: string;
  departmentName?: string;
  requestPath: string;
  method: string;
  statusCode: number;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  createdAt: string;
};

type UsageRecordsTableProps = {
  records: UsageRecordRow[];
  showUser?: boolean;
  showDepartment?: boolean;
  emptyText?: string;
};

function statusVariant(statusCode: number) {
  if (statusCode >= 200 && statusCode < 300) return "success";
  if (statusCode >= 400) return "danger";
  return "warning";
}

export function UsageRecordsTable({
  records,
  showUser = true,
  showDepartment = true,
  emptyText = "暂无使用记录",
}: UsageRecordsTableProps) {
  if (!records.length) {
    return <div className="empty">{emptyText}</div>;
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {showUser && <th>用户</th>}
            {showDepartment && <th>部门</th>}
            <th>接口</th>
            <th>状态</th>
            <th>耗时</th>
            <th>输入</th>
            <th>输出</th>
            <th>总量</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.id}>
              {showUser && (
                <td>{record.userName ?? maskSecret(record.userOpenId) ?? "-"}</td>
              )}
              {showDepartment && (
                <td>{record.departmentName ?? maskSecret(record.departmentId) ?? "-"}</td>
              )}
              <td>
                {record.method} {record.requestPath}
              </td>
              <td>
                <Badge variant={statusVariant(record.statusCode)}>{record.statusCode}</Badge>
              </td>
              <td>{record.durationMs} ms</td>
              <td>{formatTokenAmount(record.promptTokens, "0")}</td>
              <td>{formatTokenAmount(record.completionTokens, "0")}</td>
              <td>{formatTokenAmount(record.totalTokens, "0")}</td>
              <td>{formatDateTime(record.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
