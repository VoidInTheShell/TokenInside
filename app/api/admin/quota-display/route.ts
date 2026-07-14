import { NextResponse } from "next/server";
import { requireAdminScope } from "@/lib/admin";
import {
  getQuotaDisplaySnapshot,
  refreshQuotaDisplaySnapshot,
} from "@/lib/quota-display";
import { packageRouteError } from "@/lib/package-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  try {
    return NextResponse.json({ snapshot: await getQuotaDisplaySnapshot() });
  } catch (error) {
    return packageRouteError(error);
  }
}

export async function POST() {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  if (auth.scope.scopeType !== "global") {
    return NextResponse.json(
      { error: { code: "package_scope_forbidden", message: "只有全局管理员可以刷新显示配置", retryable: false } },
      { status: 403 },
    );
  }
  try {
    return NextResponse.json({ snapshot: await refreshQuotaDisplaySnapshot() });
  } catch (error) {
    return packageRouteError(error);
  }
}
