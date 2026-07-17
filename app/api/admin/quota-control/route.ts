import { after, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { hongKongBillingPeriod } from "@/lib/quota-model";
import { getConfig } from "@/lib/config";
import {
  buildQuotaShadowReconciliation,
  hasPriorStableQuotaObservation,
} from "@/lib/quota-reconciliation";
import {
  enqueueQuotaReconciliation,
  runQuotaOperation,
} from "@/lib/quota-saga";
import {
  findQuotaOperationById,
  getAppSettings,
  getScopedUser,
  getStoreSnapshot,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("retry"), operationId: z.string().min(1) }),
  z.object({ action: z.literal("reconcile_decrease"), feishuUserId: z.string().min(1) }),
]);

function visibleOperation<T extends { credentialCiphertext?: string }>(operation: T) {
  const { credentialCiphertext: _credentialCiphertext, ...visible } = operation;
  return visible;
}

export async function GET(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  const url = new URL(request.url);
  const observe = url.searchParams.get("observe") === "true";
  const period = url.searchParams.get("period") ?? hongKongBillingPeriod();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    return NextResponse.json({ error: "period 参数无效" }, { status: 400 });
  }
  const report = await buildQuotaShadowReconciliation({
    scope: auth.scope,
    period,
    observeUpstream: observe,
  });
  const store = await getStoreSnapshot();
  const visibleUserIds = new Set(report.rows.map((item) => item.feishuUserId));
  const operations = store.quotaOperations
    .filter((item) => visibleUserIds.has(item.feishuUserId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 100)
    .map(visibleOperation);
  const ledgerEntries = store.quotaLedgerEntries
    .filter((item) => visibleUserIds.has(item.feishuUserId) && item.period === period)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 200)
    .map((item) => ({
      ...item,
      quotaValue: item.signedQuota / item.quotaPerUnitSnapshot,
    }));
  const reconciliationRecords = store.quotaReconciliationRecords
    .filter((item) => visibleUserIds.has(item.feishuUserId) && item.period === period)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 100);
  const settings = await getAppSettings();
  const { newapiControl: _newapiControl, ...visibleSettings } = settings;
  return NextResponse.json({
    report,
    operations,
    ledgerEntries,
    reconciliationRecords,
    settings: visibleSettings,
    quotaPerUnit: getConfig().newapi.quotaPerUnit,
  });
}

export async function POST(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  const parsed = actionSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "额度操作动作无效" }, { status: 400 });
  }

  if (parsed.data.action === "retry") {
    const operation = await findQuotaOperationById(parsed.data.operationId);
    if (!operation || !(await getScopedUser(auth.scope, operation.feishuUserId))) {
      return NextResponse.json({ error: "额度操作不存在或不在管理范围内" }, { status: 404 });
    }
    if (operation.state !== "retryable_failed" && operation.state !== "draining") {
      return NextResponse.json({ error: "当前额度操作状态不允许重试" }, { status: 409 });
    }
    after(() => runQuotaOperation(operation.id).catch(() => undefined));
    return NextResponse.json({ operation: visibleOperation(operation) }, { status: 202 });
  }

  const targetUser = await getScopedUser(auth.scope, parsed.data.feishuUserId);
  if (!targetUser) {
    return NextResponse.json({ error: "用户不存在或不在管理范围内" }, { status: 404 });
  }
  const priorStore = await getStoreSnapshot();
  const report = await buildQuotaShadowReconciliation({
    scope: auth.scope,
    observeUpstream: true,
  });
  const row = report.rows.find((item) => item.feishuUserId === targetUser.id);
  if (
    !row ||
    row.status !== "excess_upstream" ||
    !row.observedStable ||
    !row.tokenAccountId ||
    !hasPriorStableQuotaObservation(priorStore.quotaReconciliationRecords, row)
  ) {
    return NextResponse.json(
      { error: "当前用户缺少两次连续稳定的上游多余额证据" },
      { status: 409 },
    );
  }
  const operation = await enqueueQuotaReconciliation({
    feishuUserId: targetUser.id,
    departmentId: targetUser.departmentId,
    tokenAccountId: row.tokenAccountId,
    expectedAvailableQuota: row.expectedAvailableQuota,
    observedVersion: `${row.settledThrough ?? "unsettled"}:${row.observedRemainQuota}`,
    createdByOpenId: auth.user.openId,
  });
  after(() => runQuotaOperation(operation.id).catch(() => undefined));
  return NextResponse.json({ operation: visibleOperation(operation) }, { status: 202 });
}
