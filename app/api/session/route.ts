import { NextResponse } from "next/server";
import { getEffectiveAdminScopeForUser, hydrateUserDepartment } from "@/lib/admin-sync";
import { getConfig } from "@/lib/config";
import { getNewApiUserOverview } from "@/lib/newapi-reporting";
import { getEffectiveNewApiConfig } from "@/lib/newapi-runtime";
import { getCurrentUser } from "@/lib/session";
import {
  getAuthenticatedSessionProjection,
  getActiveTokenForUser,
  getEffectiveUserGrantQuota,
  getSessionStoreSummary,
  listUserTokenRequests,
} from "@/lib/store";
import type {
  AdminScope,
  FeishuUser,
  TokenAccount,
  TokenRequest,
} from "@/lib/types";
import { resolveWorkspaceAccess, type WorkspaceAccess } from "@/lib/workspace-access";

export const runtime = "nodejs";

type AuthenticatedSessionData = {
  settings: {
    defaultMonthlyQuota: number;
  };
  requests: TokenRequest[];
  activeToken: TokenAccount | null;
  adminScope: AdminScope | null;
};

async function authenticatedSessionResponse(
  _applicationBaseUrl: string,
  user: FeishuUser,
  session: AuthenticatedSessionData,
) {
  let reportingError: string | undefined;
  const upstream = await getEffectiveNewApiConfig().catch((error) => {
    reportingError = error instanceof Error ? error.message : "NewAPI 配置读取失败";
    return null;
  });
  const usageOverview = session.activeToken
    ? await getNewApiUserOverview(user.id).catch((error) => {
        reportingError = error instanceof Error ? error.message : "NewAPI 用量读取失败";
        return null;
      })
    : null;
  return NextResponse.json({
    authenticated: true,
    workspaceAccess: resolveWorkspaceAccess({
      user,
      activeToken: session.activeToken,
      requests: session.requests,
    }),
    baseUrl: upstream?.publicBaseUrl ?? "",
    settings: session.settings,
    user: {
      id: user.id,
      name: user.name,
      avatarUrl: user.avatarUrl,
      tenantKey: user.tenantKey,
      openId: user.openId,
      departmentId: user.departmentId,
      departmentName: user.departmentName,
      status: user.status ?? "active",
    },
    activeToken: session.activeToken,
    usageOverview,
    reportingSource: "newapi",
    reportingError,
    adminScope: session.adminScope
      ? {
          type: session.adminScope.scopeType,
          departmentId: session.adminScope.departmentId,
          departmentName:
            session.adminScope.departmentId === user.departmentId
              ? user.departmentName
              : undefined,
          source: session.adminScope.source,
          role: session.adminScope.role,
        }
      : null,
    requests: session.requests,
    requestCount: usageOverview?.requestCount ?? 0,
  });
}

export async function GET() {
  const config = getConfig();
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    const store = await getSessionStoreSummary();
    return NextResponse.json({
      authenticated: false,
      workspaceAccess: "application_only" satisfies WorkspaceAccess,
      baseUrl: config.publicBaseUrl,
      settings: store.settings,
      requests: [],
      requestCount: 0,
    });
  }

  const postgresSession = await getAuthenticatedSessionProjection(currentUser);
  if (postgresSession) {
    return authenticatedSessionResponse(config.publicBaseUrl, currentUser, postgresSession);
  }

  const user = await hydrateUserDepartment(currentUser);

  const [requests, activeToken, adminScope, store] = await Promise.all([
    listUserTokenRequests(user.id),
    getActiveTokenForUser(user.id),
    getEffectiveAdminScopeForUser(user),
    getSessionStoreSummary(),
  ]);
  const effectiveGrantQuota = await getEffectiveUserGrantQuota(user.id).catch(
    () => store.settings.defaultMonthlyQuota,
  );
  return authenticatedSessionResponse(config.publicBaseUrl, user, {
    settings: {
      ...store.settings,
      defaultMonthlyQuota: effectiveGrantQuota,
    },
    activeToken,
    adminScope,
    requests,
  });
}
