import { NextResponse } from "next/server";
import { z } from "zod";
import { isSystemAdminScope, requireAdminScope } from "@/lib/admin";
import { ensureAdminDefaultProvisioning } from "@/lib/admin-default-provisioning";
import { isAdminUserActionAuthorizationError } from "@/lib/postgres-store";
import { updateManualAdminScopeAsActor } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateAdminSchema = z.object({
  status: z.enum(["active", "disabled"]).optional(),
  departmentId: z.string().min(1).max(128).optional(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminScope();
  if ("error" in auth) return auth.error;
  if (!isSystemAdminScope(auth.scope)) {
    return NextResponse.json({ error: "只有系统管理员可以管理管理员范围" }, { status: 403 });
  }

  const { id } = await context.params;
  const input = updateAdminSchema.parse(await request.json());
  let admin;
  try {
    admin = await updateManualAdminScopeAsActor({
      actorFeishuUserId: auth.user.id,
      scopeId: id,
      status: input.status,
      departmentId: input.departmentId,
    });
  } catch (error) {
    if (isAdminUserActionAuthorizationError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    throw error;
  }
  if (!admin) {
    return NextResponse.json(
      { error: "管理员范围不存在，或该范围来自环境变量不能在页面中修改" },
      { status: 404 },
    );
  }

  const provisioning =
    admin.status === "active"
      ? await ensureAdminDefaultProvisioning({
          feishuUserId: admin.feishuUserId,
          trustedScope: admin,
        })
      : undefined;
  return NextResponse.json({ admin, provisioning });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminScope();
  if ("error" in auth) return auth.error;
  if (!isSystemAdminScope(auth.scope)) {
    return NextResponse.json({ error: "只有系统管理员可以取消管理员" }, { status: 403 });
  }

  const { id } = await context.params;
  let admin;
  try {
    admin = await updateManualAdminScopeAsActor({
      actorFeishuUserId: auth.user.id,
      scopeId: id,
      status: "disabled",
      disabledReason: "manual_revoke",
    });
  } catch (error) {
    if (isAdminUserActionAuthorizationError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    throw error;
  }
  if (!admin) {
    return NextResponse.json({ error: "取消管理员失败" }, { status: 404 });
  }

  return NextResponse.json({ admin });
}
