import { after, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { sha256Hex } from "@/lib/crypto";
import {
  createPackageRequestReservation,
  decidePackageRequest,
  listAdminPackageGrants,
} from "@/lib/package-repository";
import {
  nonNegativePageValue,
  packageRouteError,
  positivePageValue,
} from "@/lib/package-route";
import { provisionApprovedPackageRequest } from "@/lib/package-saga";
import { getScopedUser } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const grantSchema = z.object({
  userId: z.string().min(1).max(200),
  packageVersionId: z.string().min(1).max(200),
  reason: z.string().trim().min(4).max(500),
  clientRequestId: z.string().min(8).max(200),
});

export async function GET(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  const url = new URL(request.url);
  const statusValue = url.searchParams.get("status");
  const status = ["active", "exhausted", "expired", "revoked"].includes(statusValue ?? "")
    ? (statusValue as "active" | "exhausted" | "expired" | "revoked")
    : undefined;
  if (statusValue && !status) {
    return NextResponse.json(
      { error: { code: "invalid_package_filter", message: "grant status 筛选无效", retryable: false } },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(
      await listAdminPackageGrants({
        scope: auth.scope,
        userId: url.searchParams.get("userId") || undefined,
        status,
        limit: positivePageValue(url.searchParams.get("limit"), 20),
        offset: nonNegativePageValue(url.searchParams.get("offset")),
      }),
    );
  } catch (error) {
    return packageRouteError(error);
  }
}

export async function POST(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  const parsed = grantSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "invalid_admin_package_grant", message: "管理员套餐发放参数无效", retryable: false } },
      { status: 400 },
    );
  }
  try {
    const user = await getScopedUser(auth.scope, parsed.data.userId);
    if (!user?.departmentId) {
      return NextResponse.json(
        { error: { code: "package_resource_not_found", message: "用户不存在、无部门或不在当前管理范围内", retryable: false } },
        { status: 404 },
      );
    }
    const reserved = await createPackageRequestReservation({
      userId: user.id,
      departmentId: user.departmentId,
      packageVersionId: parsed.data.packageVersionId,
      requestKind: "admin_grant",
      reason: parsed.data.reason,
      clientRequestId: parsed.data.clientRequestId,
      approvalActionNonceHash: sha256Hex(`admin-grant:${parsed.data.clientRequestId}`),
    });
    const decided = await decidePackageRequest({
      scope: auth.scope,
      operatedByUserId: auth.user.id,
      operatedByOpenId: auth.user.openId,
      requestId: reserved.request.id,
      action: "approve",
    });
    after(() => provisionApprovedPackageRequest(reserved.request.id).catch(() => undefined));
    return NextResponse.json(decided, { status: 202 });
  } catch (error) {
    return packageRouteError(error);
  }
}
