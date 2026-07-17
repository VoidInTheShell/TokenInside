import { NextResponse } from "next/server";
import { getEffectiveAdminScopeForUser, hydrateUserDepartment } from "@/lib/admin-sync";
import { getCurrentUser } from "@/lib/session";
import { getAdminOverview, getAdminOverviewMetadata } from "@/lib/store";
import { ensureUsageSyncScheduler } from "@/lib/usage-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function responseStatus(request: Request, status: 401 | 403) {
  const url = new URL(request.url);
  return url.searchParams.get("mode") === "soft" ? 200 : status;
}

function settingsForScope<
  T extends Awaited<ReturnType<typeof getAdminOverviewMetadata>>["settings"],
>(
  settings: T,
  scope: Awaited<ReturnType<typeof getEffectiveAdminScopeForUser>>,
) {
  if (scope?.scopeType === "global") return settings;
  const { billingOperations: _billingOperations, ...visibleSettings } = settings;
  return visibleSettings;
}

export async function GET(request: Request) {
  void ensureUsageSyncScheduler().catch(() => undefined);
  const user = await hydrateUserDepartment(await getCurrentUser());
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

  const scope = await getEffectiveAdminScopeForUser(user);
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
          departmentName: user.departmentName,
        },
      },
      { status: responseStatus(request, 403) },
    );
  }

  const [overview, metadata] = await Promise.all([
    getAdminOverview(scope),
    getAdminOverviewMetadata(),
  ]);
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
      departmentName: user.departmentName,
    },
    overview,
    settings: settingsForScope(
      scope.scopeType === "global"
        ? { ...metadata.settings, usageSyncCheckpoint: metadata.usageSyncCheckpoint }
        : metadata.settings,
      scope,
    ),
  });
}
