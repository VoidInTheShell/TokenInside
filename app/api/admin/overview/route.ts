import { NextResponse } from "next/server";
import { getFeishuDepartmentNameById } from "@/lib/feishu";
import { getCurrentUser } from "@/lib/session";
import { getAdminOverview, getAdminScopeForUser } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function responseStatus(request: Request, status: 401 | 403) {
  const url = new URL(request.url);
  return url.searchParams.get("mode") === "soft" ? 200 : status;
}

async function resolveDepartmentName(departmentId?: string) {
  try {
    return await getFeishuDepartmentNameById(departmentId);
  } catch {
    return undefined;
  }
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      {
        authenticated: false,
        authorized: false,
        error: "需要飞书 OAuth 会话",
      },
      { status: responseStatus(request, 401) },
    );
  }

  const scope = await getAdminScopeForUser(user.id);
  const userDepartmentName = await resolveDepartmentName(user.departmentId);
  if (!scope) {
    return NextResponse.json(
      {
        authenticated: true,
        authorized: false,
        error: "当前飞书用户没有启用的 TokenInside 管理范围",
        user: {
          id: user.id,
          name: user.name,
          avatarUrl: user.avatarUrl,
          tenantKey: user.tenantKey,
          openId: user.openId,
          departmentId: user.departmentId,
          departmentName: userDepartmentName,
        },
      },
      { status: responseStatus(request, 403) },
    );
  }

  const overview = await getAdminOverview(scope);
  const scopeDepartmentName = await resolveDepartmentName(overview.scope.departmentId);
  return NextResponse.json({
    authenticated: true,
    authorized: true,
    user: {
      id: user.id,
      name: user.name,
      avatarUrl: user.avatarUrl,
      tenantKey: user.tenantKey,
      openId: user.openId,
      departmentId: user.departmentId,
      departmentName: userDepartmentName,
    },
    overview: {
      ...overview,
      scope: {
        ...overview.scope,
        departmentName: scopeDepartmentName,
      },
    },
  });
}
