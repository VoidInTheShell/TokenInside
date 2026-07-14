"use client";

import { CircleDollarSignIcon, Layers3Icon, RefreshCwIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import type { ClientPackageMe } from "@/components/package/package-client-types";
import { formatDateTime } from "@/lib/utils";

export function PackageBalanceCard({ data }: { data: ClientPackageMe }) {
  const ratio = data.balance.grantedQuota > 0
    ? Math.max(0, Math.min(100, (data.balance.availableQuota / data.balance.grantedQuota) * 100))
    : 0;
  const activeCount = data.grants.filter((grant) => grant.status === "active").length;
  return (
    <Card className="package-balance-card">
      <CardHeader className="package-balance-heading">
        <div>
          <CardTitle>套餐可用额度</CardTitle>
          <CardDescription>由有效套餐 grant 汇总；消费以 NewAPI usage record 为最终事实。</CardDescription>
        </div>
        <Badge variant={data.quotaDisplay.sourceStatus === "current" ? "success" : "warning"}>
          {data.quotaDisplay.sourceStatus === "current" ? "显示配置已同步" : "显示配置降级"}
        </Badge>
      </CardHeader>
      <CardContent className="package-balance-content">
        <div className="package-balance-primary">
          <span>当前总剩余</span>
          <strong>{data.balance.available.display.formatted}</strong>
          <Progress value={ratio} aria-label="套餐总剩余额度比例" aria-valuetext={`${ratio.toFixed(1)}%`} />
          <small>
            已用 {data.balance.allocated.display.formatted} / 已发放 {data.balance.granted.display.formatted}
          </small>
        </div>
        <div className="package-balance-metrics">
          <div>
            <Layers3Icon aria-hidden="true" />
            <span>有效套餐</span>
            <strong>{activeCount} 份</strong>
          </div>
          <div>
            <CircleDollarSignIcon aria-hidden="true" />
            <span>额度单位</span>
            <strong>{data.balance.available.display.unitLabel}</strong>
          </div>
          <div>
            <RefreshCwIcon aria-hidden="true" />
            <span>配置抓取</span>
            <strong>{formatDateTime(data.quotaDisplay.fetchedAt)}</strong>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
