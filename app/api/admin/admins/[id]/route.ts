import { NextResponse } from "next/server";
import { z } from "zod";
import { isRootAdminScope, isSystemAdminScope, requireAdminScope } from "@/lib/admin";
import { getAdminScopeById, revokeAdminScopesForUser, updateManualAdminScope } from "@/lib/store";

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
  const current = await getAdminScopeById(id);
  if (!current || current.source === "environment") {
    return NextResponse.json(
      { error: "管理员范围不存在，或该范围来自环境变量不能在页面中修改" },
      { status: 404 },
    );
  }
  if (current.scopeType === "global" && !isRootAdminScope(auth.scope)) {
    return NextResponse.json({ error: "只有 root 管理员可以修改系统管理员" }, { status: 403 });
  }

  const input = updateAdminSchema.parse(await request.json());
  const admin = await updateManualAdminScope({
    scopeId: id,
    status: input.status,
    departmentId: input.departmentId,
  });
  if (!admin) {
    return NextResponse.json(
      { error: "管理员范围不存在，或该范围来自环境变量不能在页面中修改" },
      { status: 404 },
    );
  }

  return NextResponse.json({ admin });
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
  const current = await getAdminScopeById(id);
  if (!current || current.source === "environment") {
    return NextResponse.json(
      { error: "管理员范围不存在，或该范围来自环境变量不能在页面中取消" },
      { status: 404 },
    );
  }
  if (current.scopeType === "global" && !isRootAdminScope(auth.scope)) {
    return NextResponse.json({ error: "只有 root 管理员可以取消系统管理员" }, { status: 403 });
  }

  const revoked = await revokeAdminScopesForUser({
    feishuUserId: current.feishuUserId,
    reason: "manual_revoke",
    disabledByFeishuUserId: auth.user.id,
  });
  const admin = revoked.find((scope) => scope.id === id) ?? revoked[0] ?? null;
  if (!admin) {
    return NextResponse.json({ error: "取消管理员失败" }, { status: 404 });
  }

  return NextResponse.json({ admin });
}
