"use client";

import { useEffect, useMemo, useState } from "react";
import { SendIcon } from "lucide-react";
import type { ClientAvailablePackage } from "@/components/package/package-client-types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

function cycleLabel(item: ClientAvailablePackage) {
  if (item.version.cycleType === "calendar_month") return `${item.version.cycleValue} 个自然月`;
  if (item.version.cycleType === "calendar_quarter") return `${item.version.cycleValue} 个自然季度`;
  return `${item.version.cycleValue} 天`;
}

export function PackageRequestForm({
  items,
  hasGrant,
  pending,
  busy,
  onSubmit,
}: {
  items: ClientAvailablePackage[];
  hasGrant: boolean;
  pending: boolean;
  busy: boolean;
  onSubmit: (input: { packageVersionId: string; requestKind: "first" | "regrant"; reason: string }) => Promise<void>;
}) {
  const defaultItem = useMemo(() => items.find((item) => item.assignment.isDefault) ?? items[0], [items]);
  const [packageVersionId, setPackageVersionId] = useState(defaultItem?.version.id ?? "");
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (!items.some((item) => item.version.id === packageVersionId)) {
      setPackageVersionId(defaultItem?.version.id ?? "");
    }
  }, [defaultItem?.version.id, items, packageVersionId]);
  const selected = items.find((item) => item.version.id === packageVersionId);
  const requestKind = hasGrant ? "regrant" : "first";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{hasGrant ? "申请重发套餐" : "申请首份套餐"}</CardTitle>
        <CardDescription>
          用户不填写自由额度；审批通过后按所选版本新增一份固定 grant。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!items.length ? (
          <Alert variant="destructive">
            <AlertTitle>当前部门没有可申请套餐</AlertTitle>
            <AlertDescription>请联系部门主管或系统管理员完成套餐指派并设置默认套餐。</AlertDescription>
          </Alert>
        ) : (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="package-version">套餐</FieldLabel>
              <Select value={packageVersionId} onValueChange={setPackageVersionId} disabled={busy || pending}>
                <SelectTrigger id="package-version" className="package-select-trigger">
                  <SelectValue placeholder="选择套餐" />
                </SelectTrigger>
                <SelectContent>
                  {items.map((item) => (
                    <SelectItem key={item.version.id} value={item.version.id}>
                      {item.definition.name} · {item.quota.display.formatted} · {cycleLabel(item)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selected && (
                <FieldDescription>
                  {selected.definition.description || "未填写套餐说明"}；版本 v{selected.version.version}，
                  {selected.definition.ownerScopeType === "global" ? "全局套餐" : "部门套餐"}。
                </FieldDescription>
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor="package-reason">申请理由（选填）</FieldLabel>
              <Textarea
                id="package-reason"
                value={reason}
                maxLength={500}
                placeholder="说明使用场景或为什么需要重发套餐。"
                disabled={busy || pending}
                onChange={(event) => setReason(event.target.value)}
              />
              <FieldDescription>重发资格、部门预算和套餐状态均由服务端再次校验。</FieldDescription>
            </Field>
            {pending && (
              <Alert>
                <AlertTitle>已有套餐申请处理中</AlertTitle>
                <AlertDescription>同一用户同一时间只允许一笔未完成套餐申请。</AlertDescription>
              </Alert>
            )}
            <Button
              disabled={busy || pending || !packageVersionId}
              onClick={() => void onSubmit({ packageVersionId, requestKind, reason: reason.trim() })}
            >
              <SendIcon data-icon="inline-start" />
              {pending ? "等待审批" : hasGrant ? "提交重发申请" : "提交套餐申请"}
            </Button>
          </FieldGroup>
        )}
      </CardContent>
    </Card>
  );
}
