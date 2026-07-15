import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import {
  listDepartmentQuotaOverview,
  updateDepartmentQuotaPolicy,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const policySchema = z
  .object({
    departmentId: z.string().min(1).max(200).optional(),
    quotaLimit: z.number().int().min(0).max(1_000_000).optional(),
    defaultGrantQuota: z.number().int().positive().max(1_000_000).optional(),
  })
  .refine(
    (value) => value.quotaLimit !== undefined || value.defaultGrantQuota !== undefined,
    "至少需要提交一项额度设置",
  );

export async function GET() {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  return NextResponse.json(await listDepartmentQuotaOverview(auth.scope));
}

export async function PATCH(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  const parsed = policySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "部门额度设置无效" }, { status: 400 });
  }

  const departmentId =
    auth.scope.scopeType === "global" ? parsed.data.departmentId : auth.scope.departmentId;
  if (!departmentId) {
    return NextResponse.json({ error: "缺少可管理的部门 ID" }, { status: 409 });
  }
  if (
    auth.scope.scopeType === "department" &&
    parsed.data.departmentId &&
    parsed.data.departmentId !== auth.scope.departmentId
  ) {
    return NextResponse.json({ error: "不能修改其他部门的额度设置" }, { status: 403 });
  }
  if (auth.scope.scopeType === "department" && parsed.data.quotaLimit !== undefined) {
    return NextResponse.json(
      { error: "部门总额度上限只能由系统管理员直接设置，部门管理员请提交额度申请" },
      { status: 403 },
    );
  }
  if (auth.scope.scopeType === "global" && !parsed.data.departmentId) {
    return NextResponse.json({ error: "系统管理员需要指定 departmentId" }, { status: 400 });
  }

  try {
    const department = await updateDepartmentQuotaPolicy({
      departmentId,
      departmentName:
        departmentId === auth.user.departmentId ? auth.user.departmentName : undefined,
      quotaLimit: parsed.data.quotaLimit,
      defaultGrantQuota: parsed.data.defaultGrantQuota,
      operatedByFeishuUserId: auth.user.id,
    });
    return NextResponse.json({ department });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "保存部门额度设置失败" },
      { status: 409 },
    );
  }
}
