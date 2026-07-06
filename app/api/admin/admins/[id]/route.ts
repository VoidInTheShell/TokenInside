import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { updateManualAdminScope } from "@/lib/store";

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
  if (auth.scope.scopeType !== "global") {
    return NextResponse.json({ error: "只有系统管理员可以管理管理员范围" }, { status: 403 });
  }

  const { id } = await context.params;
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
