import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import {
  listDepartmentPackageAssignments,
  upsertDepartmentPackageAssignment,
} from "@/lib/package-repository";
import { packageRouteError } from "@/lib/package-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const assignmentSchema = z.object({
  departmentId: z.string().min(1).max(200).optional(),
  packageVersionId: z.string().min(1).max(200),
  isDefault: z.boolean().default(false),
  status: z.enum(["active", "disabled"]).default("active"),
});

export async function GET(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  try {
    const url = new URL(request.url);
    return NextResponse.json({
      items: await listDepartmentPackageAssignments({
        scope: auth.scope,
        departmentId: url.searchParams.get("departmentId") || undefined,
      }),
    });
  } catch (error) {
    return packageRouteError(error);
  }
}

export async function PUT(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  const parsed = assignmentSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "invalid_package_assignment", message: "部门套餐指派参数无效", retryable: false } },
      { status: 400 },
    );
  }
  try {
    const assignment = await upsertDepartmentPackageAssignment({
      scope: auth.scope,
      userId: auth.user.id,
      ...parsed.data,
    });
    return NextResponse.json({ assignment });
  } catch (error) {
    return packageRouteError(error);
  }
}
