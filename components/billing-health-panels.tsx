"use client";

import { AlertTriangleIcon, CheckCircle2Icon, RefreshCwIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { BillingHealthResponse } from "@/lib/billing-health";
import { formatDateTime, formatQuotaAmount, maskSecret } from "@/lib/utils";

export type { BillingHealthResponse } from "@/lib/billing-health";

const operationTypeLabels: Record<string, string> = {
  first_provision: "首次发放",
  quota_adjust: "额度调整",
  key_rotation: "Key 更换",
  monthly_open: "月度开账",
};

const operationStateLabels: Record<string, string> = {
  planned: "等待执行",
  budget_reserved: "已预留预算",
  local_prepared: "本地准备完成",
  admission_closed: "请求准入已暂停",
  upstream_frozen: "上游 Key 已冻结",
  draining: "等待在途请求结束",
  snapshot_stable: "消费快照已稳定",
  upstream_applying: "正在更新上游",
  upstream_applied: "上游已更新",
  upstream_activated: "新 Key 已启用",
  local_finalized: "本地账务已落账",
  reconciling: "正在确认结果",
  completed: "已完成",
  retryable_failed: "等待重试",
  compensating: "正在补偿",
  compensated: "补偿完成",
  cancelled: "已取消",
  manual_review: "需要人工检查",
};

const entryTypeLabels: Record<string, string> = {
  period_open_authorization: "账期授权",
  quota_adjust_grant: "追加授权",
  quota_adjust_release: "释放授权",
  admin_correction_debit: "授权纠错扣减",
  admin_correction_credit: "授权纠错增加",
  operation_compensation: "操作补偿",
};

const consumptionMatchLabels: Record<string, string> = {
  matched: "已关联请求",
  no_proxy_match: "已归属 Key（未关联请求）",
};

const issueTypeLabels: Record<string, string> = {
  unknown_token: "发现非 TokenInside 管理的上游 Key",
  no_proxy_match: "消费未关联到请求记录",
  missing_cost: "消费记录缺少费用字段",
  malformed_log: "上游消费记录格式异常",
};

function displayUser(userName: string | undefined, feishuUserId: string) {
  return userName ?? maskSecret(feishuUserId) ?? "-";
}

function operationStateVariant(state: string) {
  if (state === "completed") return "success" as const;
  if (state === "cancelled" || state === "compensated") return "default" as const;
  if (state === "manual_review" || state === "retryable_failed") return "danger" as const;
  return "warning" as const;
}

function reconciliationLabel(status: string) {
  if (status === "healthy") return "余额一致";
  if (status === "excess_upstream") return "上游余额偏高";
  if (status === "deficit_upstream") return "上游余额偏低";
  if (status === "manual_review") return "需要人工检查";
  return "证据尚未稳定";
}

function reconciliationVariant(status: string) {
  if (status === "healthy") return "success" as const;
  if (status === "deficit_upstream" || status === "manual_review") return "danger" as const;
  return "warning" as const;
}

function ingestionStatusLabel(status: string) {
  if (status === "continuation_pending") return "等待继续扫描";
  if (status === "applied") return "已追平稳定水位";
  if (status === "partial_failed") return "部分记录等待重试";
  if (status === "failed") return "采集失败";
  if (status === "running") return "正在采集";
  return "状态待确认";
}

function ingestionStatusVariant(status: string) {
  if (status === "applied") return "success" as const;
  if (status === "failed" || status === "partial_failed") return "danger" as const;
  return "warning" as const;
}

function HealthRefreshButton(props: { loading: boolean; onRefresh: () => void }) {
  return (
    <Button variant="outline" disabled={props.loading} onClick={props.onRefresh}>
      <RefreshCwIcon data-icon="inline-start" />
      刷新只读快照
    </Button>
  );
}

export function BillingAuditPanel(props: {
  data: BillingHealthResponse | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const data = props.data;
  return (
    <div className="stack">
      <Card>
        <CardHeader>
          <CardTitle>账务审计</CardTitle>
          <CardDescription>
            本地额度策略和追加式授权分录是授权事实；NewAPI 消费只进入消费事实与账期汇总。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="toolbar toolbar-left">
            <HealthRefreshButton loading={props.loading} onRefresh={props.onRefresh} />
            <Badge>账期 {data?.period ?? "-"}</Badge>
            <Badge variant="success">授权账本唯一模式</Badge>
          </div>
          <div className="metric-grid">
            {[
              ["额度策略", data?.totals.policies ?? 0],
              ["账期汇总", data?.totals.billingPeriods ?? 0],
              ["授权分录", data?.totals.ledgerEntries ?? 0],
              ["未结账务任务", data?.totals.unfinishedTasks ?? 0],
            ].map(([label, value]) => (
              <Card key={label}>
                <CardContent>
                  <div className="metric">
                    <span className="metric-label">{label}</span>
                    <strong className="metric-value">{value}</strong>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>已结算消费记录</CardTitle>
          <CardDescription>NewAPI 消费事实按已知 Key 归属计费；未关联到代理请求只影响诊断，不影响消费入账。</CardDescription>
        </CardHeader>
        <CardContent>
          {!data?.consumptionRecords.length ? <div className="empty">当前账期暂无已结算消费</div> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>用户</th><th>归属状态</th><th>模型</th><th>消费额度</th><th>输入 Tokens</th><th>输出 Tokens</th><th>总 Tokens</th><th>模式</th><th>发生时间</th></tr></thead>
                <tbody>{data.consumptionRecords.map((record) => (
                  <tr key={record.id}>
                    <td>{displayUser(record.userName, record.feishuUserId)}</td>
                    <td>{consumptionMatchLabels[record.matchStatus] ?? "已结算"}</td>
                    <td>{record.model ?? "-"}</td>
                    <td>{formatQuotaAmount(record.consumedQuota)}</td>
                    <td>{record.promptTokens.toLocaleString()}</td>
                    <td>{record.completionTokens.toLocaleString()}</td>
                    <td>{record.totalTokens.toLocaleString()}</td>
                    <td>{record.isStream === undefined ? "-" : record.isStream ? "SSE" : "非 SSE"}</td>
                    <td>{formatDateTime(record.occurredAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>用户账期汇总</CardTitle>
          <CardDescription>由额度策略、授权账本和已结算消费物化，可安全重新生成。</CardDescription>
        </CardHeader>
        <CardContent>
          {!data?.periods.length ? <div className="empty">当前账期暂无汇总</div> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>用户</th><th>月度额度策略</th><th>累计授权</th><th>已结算消费</th><th>本地可用额度</th><th>消费记录</th><th>更新时间</th></tr></thead>
                <tbody>{data.periods.map((item) => (
                  <tr key={item.feishuUserId}>
                    <td>{displayUser(item.userName, item.feishuUserId)}</td>
                    <td>{formatQuotaAmount(item.monthlyQuota)}</td>
                    <td>{formatQuotaAmount(item.authorizedQuota)}</td>
                    <td>{formatQuotaAmount(item.quotaConsumed)}</td>
                    <td>{formatQuotaAmount(item.remainingQuota)}</td>
                    <td>{item.usageRecordCount}</td>
                    <td>{formatDateTime(item.updatedAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>授权账本分录</CardTitle>
          <CardDescription>历史分录不可更新或删除；纠错只能追加反向分录。</CardDescription>
        </CardHeader>
        <CardContent>
          {!data?.ledgerEntries.length ? <div className="empty">当前账期暂无授权分录</div> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>用户</th><th>授权事项</th><th>授权变化</th><th>账务任务</th><th>时间</th></tr></thead>
                <tbody>{data.ledgerEntries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{displayUser(entry.userName, entry.feishuUserId)}</td>
                    <td>{entryTypeLabels[entry.entryType] ?? "其他授权变更"}</td>
                    <td>{entry.signedQuota > 0 ? "+" : ""}{formatQuotaAmount(entry.quotaValue)}</td>
                    <td>{maskSecret(entry.operationId)}</td>
                    <td>{formatDateTime(entry.createdAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>账务任务</CardTitle>
          <CardDescription>后台自动恢复；等待重试或需要人工检查的任务会在系统健康中告警。</CardDescription>
        </CardHeader>
        <CardContent>
          {!data?.operations.length ? <div className="empty">暂无账务任务</div> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>任务</th><th>任务事项</th><th>用户</th><th>状态</th><th>已尝试次数</th><th>失败原因</th><th>更新时间</th></tr></thead>
                <tbody>{data.operations.map((operation) => (
                  <tr key={operation.id}>
                    <td>{maskSecret(operation.id)}</td>
                    <td>{operationTypeLabels[operation.operationType] ?? "其他账务任务"}</td>
                    <td>{displayUser(operation.userName, operation.feishuUserId)}</td>
                    <td><Badge variant={operationStateVariant(operation.state)}>{operationStateLabels[operation.state] ?? "状态待确认"}</Badge></td>
                    <td>{operation.attemptCount}</td>
                    <td>{operation.lastErrorMessage ?? "-"}</td>
                    <td>{formatDateTime(operation.updatedAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function SystemHealthPanel(props: {
  data: BillingHealthResponse | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const data = props.data;
  const blocking = data?.totals.blockingIssues ?? 0;
  const manualReviewTasks = data?.totals.manualReviewTasks ?? 0;
  const staleAccessResumeTasks = data?.totals.staleAccessResumeTasks ?? 0;
  const balanceObservationGaps = data?.totals.balanceObservationGaps ?? 0;
  const unhealthy =
    blocking > 0 ||
    (data?.totals.retryTasks ?? 0) > 0 ||
    manualReviewTasks > 0 ||
    staleAccessResumeTasks > 0 ||
    balanceObservationGaps > 0 ||
    (data?.totals.balanceDrifts ?? 0) > 0;
  return (
    <div className="stack">
      <Card>
        <CardHeader>
          <CardTitle>系统健康</CardTitle>
          <CardDescription>只读展示消费结算、账务任务和上游余额投影状态；刷新不访问上游，也不写入数据库。</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="toolbar toolbar-left">
            <HealthRefreshButton loading={props.loading} onRefresh={props.onRefresh} />
            <Badge variant={unhealthy ? "danger" : "success"}>
              {unhealthy ? <AlertTriangleIcon data-icon="inline-start" /> : <CheckCircle2Icon data-icon="inline-start" />}
              {unhealthy ? "存在需要检查的异常" : "未发现阻断异常"}
            </Badge>
            <span className="field-description">快照时间：{data?.observedAt ? formatDateTime(data.observedAt) : "-"}</span>
          </div>
          <div className="metric-grid">
            {[
              ["严重完整性异常", blocking],
              ["开放消费异常", data?.totals.openIssues ?? 0],
              ["等待重试任务", data?.totals.retryTasks ?? 0],
              ["需要人工检查任务", manualReviewTasks],
              ["等待恢复用户访问", staleAccessResumeTasks],
              ["余额观察待覆盖", balanceObservationGaps],
              ["余额投影偏差", data?.totals.balanceDrifts ?? 0],
            ].map(([label, value]) => (
              <Card key={label}>
                <CardContent>
                  <div className="metric">
                    <span className="metric-label">{label}</span>
                    <strong className="metric-value">{value}</strong>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>消费结算水位</CardTitle>
          <CardDescription>采集水位可以继续前进；出现未知 Key 时，完整结算水位会停在异常之前。</CardDescription>
        </CardHeader>
        <CardContent>
          {data?.checkpoint?.lastRunStatus && (
            <div className="toolbar toolbar-left">
              <Badge variant={ingestionStatusVariant(data.checkpoint.lastRunStatus)}>
                最近采集：{ingestionStatusLabel(data.checkpoint.lastRunStatus)}
              </Badge>
            </div>
          )}
          <div className="metric-grid">
            {[
              ["已采集至", data?.checkpoint?.ingestedThrough ? formatDateTime(data.checkpoint.ingestedThrough) : "-"],
              ["已完整结算至", data?.checkpoint?.settledThrough ? formatDateTime(data.checkpoint.settledThrough) : "-"],
              ["完整性阻断点", data?.checkpoint?.integrityBlockedAt ? formatDateTime(data.checkpoint.integrityBlockedAt) : "无"],
              ["下次补采", data?.checkpoint?.nextRunAfter ? formatDateTime(data.checkpoint.nextRunAfter) : "-"],
            ].map(([label, value]) => (
              <Card key={label}>
                <CardContent>
                  <div className="metric">
                    <span className="metric-label">{label}</span>
                    <strong className="metric-value">{value}</strong>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>消费完整性异常</CardTitle>
          <CardDescription>未知 Key 不会自动归属；必须查明上游污染或映射丢失后再解除异常。</CardDescription>
        </CardHeader>
        <CardContent>
          {!data?.issues.length ? <div className="empty">暂无开放异常</div> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>等级</th><th>异常</th><th>用户</th><th>阻断结算</th><th>发生时间</th><th>更新时间</th></tr></thead>
                <tbody>{data.issues.map((issue) => (
                  <tr key={issue.id}>
                    <td><Badge variant={issue.severity === "critical" ? "danger" : "warning"}>{issue.severity === "critical" ? "严重" : "警告"}</Badge></td>
                    <td>{issueTypeLabels[issue.issueType] ?? "其他消费异常"}</td>
                    <td>{issue.feishuUserId ? maskSecret(issue.feishuUserId) : "未知上游 Key"}</td>
                    <td>{issue.blocksSettlement ? "是" : "否"}</td>
                    <td>{formatDateTime(issue.occurredAt ?? issue.updatedAt)}</td>
                    <td>{formatDateTime(issue.updatedAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>上游余额投影</CardTitle>
          <CardDescription>这里只展示最近已记录的观测结果；上游余额偏低只告警，不自动补额。</CardDescription>
        </CardHeader>
        <CardContent>
          {!data?.reconciliationRecords.length ? <div className="empty">暂无已记录的余额观测</div> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>用户</th><th>本地应有余额</th><th>上游当前余额</th><th>差额</th><th>结论</th><th>观测时间</th></tr></thead>
                <tbody>{data.reconciliationRecords.map((record) => (
                  <tr key={record.id}>
                    <td>{displayUser(record.userName, record.feishuUserId)}</td>
                    <td>{formatQuotaAmount(record.expectedAvailableQuota)}</td>
                    <td>{record.observedRemainQuota === undefined ? "-" : formatQuotaAmount(record.observedRemainQuota)}</td>
                    <td>{record.delta === undefined ? "-" : formatQuotaAmount(record.delta)}</td>
                    <td><Badge variant={reconciliationVariant(record.status)}>{reconciliationLabel(record.status)}</Badge></td>
                    <td>{formatDateTime(record.updatedAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
