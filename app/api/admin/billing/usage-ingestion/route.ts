import { after, NextResponse } from "next/server";
import { z } from "zod";
import { isRootAdminScope, requireAdminScope } from "@/lib/admin";
import { isAdminUserActionAuthorizationError } from "@/lib/postgres-store";
import { defaultUsageSyncPolicy } from "@/lib/store";
import {
  enqueueManualUsageSyncOperation,
  runManualUsageSyncOperation,
} from "@/lib/usage-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  dryRun: z.boolean().default(true),
});

export async function POST(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  if (!isRootAdminScope(auth.scope)) {
    return NextResponse.json(
      { error: "消费补采仅允许 root 在维护场景执行" },
      { status: 403 },
    );
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "dryRun 必须是布尔值" }, { status: 400 });
  }

  try {
    const policy = defaultUsageSyncPolicy();
    const queued = await enqueueManualUsageSyncOperation({
      dryRun: parsed.data.dryRun,
      size: policy.pageSize,
      maxPages: policy.maxPagesPerRun,
      overlapMinutes: policy.overlapMinutes,
      settlementLagMinutes: policy.settlementLagMinutes ?? 1,
      matchWindowMinutes: policy.matchWindowMinutes,
      retryBaseMinutes: policy.retryBaseMinutes ?? 5,
      operatedByFeishuUserId: auth.user.id,
    });
    const { leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, ...operation } =
      queued.operation;
    if (queued.conflicted) {
      return NextResponse.json(
        { error: "已有消费采集任务正在执行", operation },
        { status: 409 },
      );
    }
    if (queued.created) {
      after(() => runManualUsageSyncOperation(queued.operation.id).catch(() => undefined));
    }
    return NextResponse.json(
      { operation, deduplicated: !queued.created },
      { status: 202 },
    );
  } catch (error) {
    if (isAdminUserActionAuthorizationError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "消费补采任务入队失败" },
      { status: 503 },
    );
  }
}
