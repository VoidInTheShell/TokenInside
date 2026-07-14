import { NextResponse } from "next/server";
import { getEffectiveAdminScopeForUser, hydrateUserDepartment } from "@/lib/admin-sync";
import {
  getPackageBillingReport,
  listAdminPackageGrants,
  listAdminPackageRequests,
  listPackageDefinitions,
} from "@/lib/package-repository";
import { getQuotaDisplaySnapshot } from "@/lib/quota-display";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function responseStatus(request: Request, status: 401 | 403) {
  return new URL(request.url).searchParams.get("mode") === "soft" ? 200 : status;
}

export async function GET(request: Request) {
  const user = await hydrateUserDepartment(await getCurrentUser());
  if (!user) {
    return NextResponse.json(
      { authenticated: false, authorized: false, error: "需要飞书 OAuth 会话" },
      { status: responseStatus(request, 401) },
    );
  }
  const scope = await getEffectiveAdminScopeForUser(user);
  if (!scope) {
    return NextResponse.json(
      {
        authenticated: true,
        authorized: false,
        error: "当前飞书用户没有启用的 TokenInside 管理范围",
        user,
      },
      { status: responseStatus(request, 403) },
    );
  }
  const [definitions, requests, grants, report, quotaDisplay] = await Promise.all([
    listPackageDefinitions({ scope, limit: 1 }),
    listAdminPackageRequests({ scope, limit: 1 }),
    listAdminPackageGrants({ scope, limit: 1 }),
    getPackageBillingReport({ scope, limit: 1 }),
    getQuotaDisplaySnapshot({ refreshIfStale: true }),
  ]);
  return NextResponse.json({
    authenticated: true,
    authorized: true,
    user: {
      id: user.id,
      name: user.name,
      avatarUrl: user.avatarUrl,
      openId: user.openId,
      departmentId: user.departmentId,
      departmentName: user.departmentName,
    },
    scope: {
      type: scope.scopeType,
      departmentId: scope.departmentId,
      departmentName: scope.departmentId === user.departmentId ? user.departmentName : undefined,
      source: scope.source,
      role: scope.role,
    },
    totals: {
      packageDefinitions: definitions.total,
      packageRequests: requests.total,
      packageGrants: grants.total,
      grantedQuota: report.summary.grantedQuota,
      allocatedQuota: report.summary.allocatedQuota,
      availableQuota: report.summary.availableQuota,
      authoritativeConsumedQuota: report.summary.authoritativeConsumedQuota,
    },
    quotaDisplay,
  });
}
