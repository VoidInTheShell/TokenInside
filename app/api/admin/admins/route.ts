import { NextResponse } from "next/server";
import { z } from "zod";
import { isRootAdminScope, isSystemAdminScope, requireAdminScope } from "@/lib/admin";
import { listAdminScopes, upsertManualAdminScope } from "@/lib/store";

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

  const result = await upsertManualAdminScope({
    targetOpenId: input.targetOpenId,
    scopeType: input.scopeType,
    departmentId: input.departmentId,
  });
  if (result.error === "target_user_not_found") {
    return NextResponse.json(
      { error: "目标用户尚未登录过 TokenInside，无法指派管理员" },
      { status: 404 },
    );
  }

  return NextResponse.json({ admin: result.scope });
}
