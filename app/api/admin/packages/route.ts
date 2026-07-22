import { after, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { getConfig } from "@/lib/config";
import { submitAndScheduleDurableQuotaWork } from "@/lib/durable-quota-submission";
import { nextPackagePeriod } from "@/lib/package-reset";
import { isAdminUserActionAuthorizationError } from "@/lib/postgres-store";
import {
  QuotaSubmissionError,
  submitPostgresCurrentPackageIncrease,
} from "@/lib/quota-operation-submit";
import { ensureQuotaOperationWorker } from "@/lib/quota-saga";
import {
  getAppSettings,
  getCurrentPackageBillingPeriod,
  JsonQuotaSubmissionError,
  listDepartmentQuotaOverview,
  submitJsonCurrentPackageIncrease,
  updateDepartmentQuotaPolicyAsActor,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const packageSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("set_total_limit"),
    departmentId: z.string().min(1).max(200).optional(),
    totalQuotaLimit: z.number().int().min(0).max(1_000_000),
  }),
  z.object({
    action: z.literal("increase_current_package"),
    departmentId: z.string().min(1).max(200).optional(),
    packageQuota: z.number().int().positive().max(1_000_000),
    clientRequestId: z.string().min(8).max(120),
  }),
  z.object({
    action: z.literal("set_next_package"),
    departmentId: z.string().min(1).max(200).optional(),
    packageQuota: z.number().int().positive().max(1_000_000),
  }),
]);

type DepartmentPackageSummary = {
  id: string;
  departmentId: string;
  departmentName?: string;
  period: string;
  quotaLimit: number;
  defaultGrantQuota: number;
  allocatedQuota?: number;
  pendingReservedQuota?: number;
  availableQuota?: number;
  memberCount?: number;
  keyedUsers?: number;
  prewarmedKeys?: number;
  updatedAt: string;
};

function packageView(
  current: DepartmentPackageSummary,
  next?: DepartmentPackageSummary,
) {
  return {
    id: current.id,
    departmentId: current.departmentId,
    departmentName: current.departmentName,
    currentPeriod: current.period,
    nextPeriod: next?.period,
    totalQuotaLimit: current.quotaLimit,
    currentPackageQuota: current.defaultGrantQuota,
    nextPackageQuota: next?.defaultGrantQuota ?? current.defaultGrantQuota,
    allocatedQuota: current.allocatedQuota ?? 0,
    pendingReservedQuota: current.pendingReservedQuota ?? 0,
    availableQuota: current.availableQuota ?? 0,
    memberCount: current.memberCount ?? 0,
    keyedUsers: current.keyedUsers ?? 0,
    prewarmedKeys: current.prewarmedKeys ?? 0,
    updatedAt: current.updatedAt,
    nextUpdatedAt: next?.updatedAt,
  };
}

function resolveDepartmentId(
  scope: { scopeType: "global" | "department"; departmentId?: string },
  requestedDepartmentId?: string,
) {
  return scope.scopeType === "global"
    ? requestedDepartmentId
    : scope.departmentId;
}

export async function GET() {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  const [settings, currentPeriod] = await Promise.all([
    getAppSettings(),
    getCurrentPackageBillingPeriod(),
  ]);
  const nextPeriod = nextPackagePeriod(settings.packageReset);
  const [currentOverview, nextOverview] = await Promise.all([
    listDepartmentQuotaOverview(auth.scope, currentPeriod),
    listDepartmentQuotaOverview(auth.scope, nextPeriod),
  ]);
  const nextByDepartment = new Map(
    nextOverview.departments.map((department) => [department.departmentId, department]),
  );
  return NextResponse.json({
    source: "package_policy",
    currentPeriod,
    nextPeriod,
    packages: currentOverview.departments.map((department) =>
      packageView(department, nextByDepartment.get(department.departmentId)),
    ),
    requests: currentOverview.requests,
  });
}

export async function PATCH(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  const parsed = packageSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "套餐设置无效" }, { status: 400 });
  }

  const departmentId = resolveDepartmentId(
    auth.scope,
    parsed.data.departmentId,
  );
  if (!departmentId) {
    return NextResponse.json({ error: "缺少可管理的部门 ID" }, { status: 409 });
  }
  if (
    auth.scope.scopeType === "department" &&
    parsed.data.departmentId &&
    parsed.data.departmentId !== auth.scope.departmentId
  ) {
    return NextResponse.json({ error: "不能修改其他部门的套餐" }, { status: 403 });
  }
  if (auth.scope.scopeType === "global" && !parsed.data.departmentId) {
    return NextResponse.json(
      { error: "系统管理员需要指定 departmentId" },
      { status: 400 },
    );
  }
  if (
    parsed.data.action === "set_total_limit" &&
    auth.scope.scopeType !== "global"
  ) {
    return NextResponse.json(
      { error: "部门总额度上限只能由 root 或系统管理员设置" },
      { status: 403 },
    );
  }

  try {
    const settings = await getAppSettings();
    const currentPeriod = await getCurrentPackageBillingPeriod();
    if (parsed.data.action === "increase_current_package") {
      const increase = parsed.data;
      const submitted = await submitAndScheduleDurableQuotaWork({
        submit: () =>
          getConfig().storeBackend === "postgres"
            ? submitPostgresCurrentPackageIncrease({
                actorUserId: auth.user.id,
                departmentId,
                departmentName:
                  departmentId === auth.user.departmentId
                    ? auth.user.departmentName
                    : undefined,
                period: currentPeriod,
                packageQuota: increase.packageQuota,
                clientRequestId: increase.clientRequestId,
              })
            : submitJsonCurrentPackageIncrease({
                actorUserId: auth.user.id,
                departmentId,
                departmentName:
                  departmentId === auth.user.departmentId
                    ? auth.user.departmentName
                    : undefined,
                period: currentPeriod,
                packageQuota: increase.packageQuota,
                clientRequestId: increase.clientRequestId,
              }),
        scheduleAfter: after,
        wakeWorker: ensureQuotaOperationWorker,
      });
      return NextResponse.json(
        { action: increase.action, ...submitted },
        { status: 202 },
      );
    }

    const period =
      parsed.data.action === "set_next_package"
        ? nextPackagePeriod(settings.packageReset)
        : currentPeriod;
    const updated = await updateDepartmentQuotaPolicyAsActor({
      actorFeishuUserId: auth.user.id,
      departmentId,
      departmentName:
        departmentId === auth.user.departmentId
          ? auth.user.departmentName
          : undefined,
      period,
      quotaLimit:
        parsed.data.action === "set_total_limit"
          ? parsed.data.totalQuotaLimit
          : undefined,
      defaultGrantQuota:
        parsed.data.action === "set_next_package"
          ? parsed.data.packageQuota
          : undefined,
    });
    return NextResponse.json({
      action: parsed.data.action,
      package: updated,
      period,
    });
  } catch (error) {
    if (
      error instanceof QuotaSubmissionError ||
      error instanceof JsonQuotaSubmissionError
    ) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        {
          status: error.status,
          headers:
            error instanceof QuotaSubmissionError && error.retryAfterSeconds
              ? { "Retry-After": String(error.retryAfterSeconds) }
              : undefined,
        },
      );
    }
    if (isAdminUserActionAuthorizationError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "保存套餐设置失败" },
      { status: 409 },
    );
  }
}
