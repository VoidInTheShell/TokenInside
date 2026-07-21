import { NextResponse } from "next/server";
import { z } from "zod";
import { isRootAdminScope, isSystemAdminScope, requireAdminScope } from "@/lib/admin";
import { ensureAdminDefaultProvisioning } from "@/lib/admin-default-provisioning";
import { isAdminUserActionAuthorizationError } from "@/lib/postgres-store";
import { listAdminScopes, upsertManualAdminScopeAsActor } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const assignAdminSchema = z.object({
  targetOpenId: z.string().min(4).max(128),
  scopeType: z.enum(["global", "department"]),
  departmentId: z.string().min(1).max(128).optional(),
});

function systemAdminOnly(scopeType?: string) {
  if (scopeType === "global") return null;
  return NextResponse.json({ error: "只有系统管理员可以管理管理员范围" }, { status: 403 });
}

export async function GET() {
  const auth = await requireAdminScope();
  if ("error" in auth) return auth.error;

  const systemAdminError = systemAdminOnly(auth.scope.scopeType);
  if (systemAdminError) return systemAdminError;

  return NextResponse.json({
    admins: await listAdminScopes(),
  });
}

export async function POST(request: Request) {
  const auth = await requireAdminScope();
  if ("error" in auth) return auth.error;

  const systemAdminError = systemAdminOnly(auth.scope.scopeType);
  if (systemAdminError) return systemAdminError;

  const input = assignAdminSchema.parse(await request.json());
  if (!isSystemAdminScope(auth.scope)) {
    return NextResponse.json({ error: "只有系统管理员可以管理管理员范围" }, { status: 403 });
  }
  if (input.scopeType === "global" && !isRootAdminScope(auth.scope)) {
    return NextResponse.json({ error: "只有 root 管理员可以指派系统管理员" }, { status: 403 });
  }
  if (input.scopeType === "department" && !input.departmentId) {
    return NextResponse.json({ error: "指派部门管理员需要 departmentId" }, { status: 400 });
  }

  let result;
  try {
    result = await upsertManualAdminScopeAsActor({
      actorFeishuUserId: auth.user.id,
      targetOpenId: input.targetOpenId,
      scopeType: input.scopeType,
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
  if (result.error === "target_user_not_found") {
    return NextResponse.json(
      { error: "目标用户尚未登录过 TokenInside，无法指派管理员" },
      { status: 404 },
    );
  }
  if (result.error === "target_user_inactive") {
    return NextResponse.json(
      { error: "目标用户已禁用或删除，不能通过指派管理员隐式恢复访问" },
      { status: 409 },
    );
  }

  const provisioning = result.scope
    ? await ensureAdminDefaultProvisioning({
        feishuUserId: result.scope.feishuUserId,
        trustedScope: result.scope,
      })
    : undefined;
  return NextResponse.json({ admin: result.scope, provisioning });
}
