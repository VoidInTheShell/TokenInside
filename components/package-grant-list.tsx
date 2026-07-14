"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import type { ClientPackageGrant } from "@/components/package-client-types";
import { formatDateTime } from "@/lib/utils";

const statusLabel: Record<ClientPackageGrant["status"], string> = {
  active: "有效",
  exhausted: "已耗尽",
  expired: "已到期",
  revoked: "已撤销",
};

function cycleLabel(grant: ClientPackageGrant) {
  if (grant.snapshot.cycleType === "calendar_month") return `${grant.snapshot.cycleValue} 个自然月`;
  if (grant.snapshot.cycleType === "calendar_quarter") return `${grant.snapshot.cycleValue} 个自然季度`;
  return `${grant.snapshot.cycleValue} 天`;
}

export function PackageGrantList({ grants }: { grants: ClientPackageGrant[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>我的套餐</CardTitle>
        <CardDescription>每次首次发放或重发都会新增独立 grant，历史用量不会被覆盖。</CardDescription>
      </CardHeader>
      <CardContent>
        {!grants.length ? (
          <Empty className="package-empty">
            <EmptyHeader>
              <EmptyTitle>还没有套餐</EmptyTitle>
              <EmptyDescription>请选择部门已开放的默认套餐并提交申请。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="package-grant-grid">
            {grants.map((grant) => {
              const ratio = grant.grantedQuota > 0
                ? Math.max(0, Math.min(100, ((grant.grantedQuota - grant.allocatedQuota) / grant.grantedQuota) * 100))
                : 0;
              return (
                <article className="package-grant-item" key={grant.id}>
                  <div className="package-grant-title">
                    <div>
                      <strong>{grant.snapshot.packageName}</strong>
                      <span>{grant.snapshot.packageCode} · v{grant.snapshot.version}</span>
                    </div>
                    <Badge variant={grant.status === "active" ? "success" : grant.status === "revoked" ? "danger" : "warning"}>
                      {statusLabel[grant.status]}
                    </Badge>
                  </div>
                  <div className="package-grant-quota">
                    <strong>{grant.available.display.formatted}</strong>
                    <span>剩余 / {grant.granted.display.formatted}</span>
                  </div>
                  <Progress value={ratio} aria-label={`${grant.snapshot.packageName} 剩余额度比例`} />
                  <dl className="package-grant-meta">
                    <div><dt>周期</dt><dd>{cycleLabel(grant)}</dd></div>
                    <div><dt>生效</dt><dd>{formatDateTime(grant.startsAt)}</dd></div>
                    <div><dt>到期</dt><dd>{formatDateTime(grant.expiresAt)}</dd></div>
                  </dl>
                </article>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
