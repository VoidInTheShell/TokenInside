import { NextResponse } from "next/server";
import { requireAdminScope } from "@/lib/admin";
import {
  listNewApiAdminUserStats,
  type AdminUserSortKey,
} from "@/lib/newapi-reporting";
import { newApiReportingFailure } from "@/lib/newapi-reporting-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function positiveInt(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function optionalParam(url: URL, key: string) {
  const value = url.searchParams.get(key);
  return value && value !== "__all__" ? value : undefined;
}

export async function GET(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  const url = new URL(request.url);
  try {
    const result = await listNewApiAdminUserStats(auth.scope, {
      search: optionalParam(url, "search"),
      departmentId: optionalParam(url, "departmentId"),
      status: optionalParam(url, "status"),
      role: optionalParam(url, "role"),
      sortBy: optionalParam(url, "sortBy") as AdminUserSortKey | undefined,
      sortOrder: optionalParam(url, "sortOrder") === "asc" ? "asc" : "desc",
      limit: positiveInt(url.searchParams.get("limit"), 20),
      offset: nonNegativeInt(url.searchParams.get("offset"), 0),
    });
    return NextResponse.json({
      scope: {
        type: auth.scope.scopeType,
        departmentId: auth.scope.departmentId,
        source: auth.scope.source,
      },
      ...result,
    });
  } catch (error) {
    return newApiReportingFailure(error, "NewAPI 用户统计读取失败");
  }
}
