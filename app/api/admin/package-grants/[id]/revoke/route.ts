import { after, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { revokePackageGrant } from "@/lib/package-repository";
import { packageRouteError } from "@/lib/package-route";
import { reconcilePackageWatermark } from "@/lib/package-saga";

export const runtime = "nodejs";

const revokeSchema = z.object({
  reason: z.string().trim().min(4).max(500),
  revision: z.string().min(8).max(200),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  const parsed = revokeSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "invalid_package_revoke", message: "套餐撤销参数无效", retryable: false } },
      { status: 400 },
    );
  }
  try {
    const { id } = await params;
    const result = await revokePackageGrant({
      scope: auth.scope,
      grantId: id,
      operatedByUserId: auth.user.id,
      ...parsed.data,
    });
    after(() => reconcilePackageWatermark(result.grant.userId).catch(() => undefined));
    return NextResponse.json(result);
  } catch (error) {
    return packageRouteError(error);
  }
}
