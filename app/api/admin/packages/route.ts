import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import {
  createPackageDefinition,
  listPackageDefinitions,
} from "@/lib/package-repository";
import {
  nonNegativePageValue,
  packageRouteError,
  positivePageValue,
} from "@/lib/package-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  ownerScopeType: z.enum(["global", "department"]),
  ownerDepartmentId: z.string().min(1).max(200).optional(),
  code: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
});

export async function GET(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  if (status && status !== "active" && status !== "retired") {
    return NextResponse.json(
      { error: { code: "invalid_package_filter", message: "status 筛选无效", retryable: false } },
      { status: 400 },
    );
  }
  const packageStatus = status === "active" || status === "retired" ? status : undefined;
  try {
    return NextResponse.json(
      await listPackageDefinitions({
        scope: auth.scope,
        limit: positivePageValue(url.searchParams.get("limit"), 20),
        offset: nonNegativePageValue(url.searchParams.get("offset")),
        status: packageStatus,
      }),
    );
  } catch (error) {
    return packageRouteError(error);
  }
}

export async function POST(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "invalid_package_definition", message: "套餐定义参数无效", retryable: false } },
      { status: 400 },
    );
  }
  try {
    const definition = await createPackageDefinition({
      scope: auth.scope,
      userId: auth.user.id,
      ...parsed.data,
    });
    return NextResponse.json({ definition }, { status: 201 });
  } catch (error) {
    return packageRouteError(error);
  }
}
