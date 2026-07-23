"use client";

import { useEffect, useMemo, useState } from "react";
import { Clock3Icon } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  buildUsageOverview,
  formatPackagePeriod,
  formatOneDecimal,
  formatResetCountdown,
  formatTokensOneDecimal,
  parseAuthoritativeResetAt,
} from "@/lib/usage-overview";

type UsageOverviewCardProps = {
  period?: string | null;
  nextResetAt?: string | null;
  monthlyQuota?: number | null;
  quotaConsumed?: number | null;
  remainingQuota?: number | null;
  totalTokens?: number | null;
};

export function UsageOverviewCard({
  period,
  nextResetAt,
  monthlyQuota,
  quotaConsumed,
  remainingQuota,
  totalTokens,
}: UsageOverviewCardProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const overview = buildUsageOverview({ monthlyQuota, quotaConsumed, remainingQuota });
  const resetAt = useMemo(
    () => parseAuthoritativeResetAt(nextResetAt),
    [nextResetAt],
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <Card className="usage-overview-card">
      <CardHeader className="usage-overview-header">
        <div className="usage-overview-heading">
          <CardTitle>用量概览</CardTitle>
          <CardDescription>
            {formatPackagePeriod(period)} · 套餐额度 {formatOneDecimal(overview.monthlyQuota)}
          </CardDescription>
        </div>
        <div className="usage-overview-reset">
          <Clock3Icon aria-hidden="true" />
          <span>距离套餐重置</span>
          <strong>{formatResetCountdown(resetAt, nowMs)}</strong>
        </div>
      </CardHeader>
      <CardContent>
        <div className="usage-overview-layout">
          <div className="usage-overview-progress-area">
            <div className="usage-overview-percentage">
              <strong>{formatOneDecimal(overview.remainingPercent)}%</strong>
              <span>剩余用量</span>
            </div>
            <Progress
              aria-label="套餐剩余用量"
              aria-valuetext={`${formatOneDecimal(overview.remainingPercent)}%`}
              value={overview.remainingPercent}
            />
            <div className="usage-overview-caption">
              <span>
                剩余额度 {formatOneDecimal(overview.remainingQuota)} / {formatOneDecimal(overview.monthlyQuota)}
              </span>
              <span>以套餐额度为基准</span>
            </div>
          </div>
          <div className="usage-overview-metrics" aria-label="套餐周期已用数据">
            <div className="usage-overview-metric">
              <span>套餐周期已用 Tokens</span>
              <strong>{formatTokensOneDecimal(totalTokens)}</strong>
            </div>
            <div className="usage-overview-metric">
              <span>已用额度</span>
              <strong>{formatOneDecimal(overview.quotaConsumed)}</strong>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
