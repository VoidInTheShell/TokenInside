import { NextResponse } from "next/server";
import { getEffectiveAdminScopeForUser, hydrateUserDepartment } from "@/lib/admin-sync";
import { getConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/session";
import {
  getAuthenticatedSessionProjection,
  getActiveTokenForUser,
  getEffectiveUserGrantQuota,
  getSessionStoreSummary,
  getUserBillingPeriod,
  listUserTokenRequests,
} from "@/lib/store";
import type {
  AdminScope,
  FeishuUser,
  TokenAccount,
  TokenRequest,
  UserBillingPeriod,
} from "@/lib/types";
import { resolveWorkspaceAccess, type WorkspaceAccess } from "@/lib/workspace-access";

export const runtime = "nodejs";

type AuthenticatedSessionData = {
  settings: {
    defaultMonthlyQuota: number;
  };
  requests: TokenRequest[];
  activeToken: TokenAccount | null;
  billingPeriod: UserBillingPeriod | null;
  adminScope: AdminScope | null;
  proxyLogCount: number;
};

function authenticatedSessionResponse(
  baseUrl: string,
  user: FeishuUser,
  session: AuthenticatedSessionData,
) {
  return NextResponse.json({
    authenticated: true,
    workspaceAccess: resolveWorkspaceAccess({
      user,
      activeToken: session.activeToken,
      requests: session.requests,
    }),
    baseUrl,
    settings: session.settings,
    user: {
      id: user.id,
      name: user.name,
      avatarUrl: user.avatarUrl,
      tenantKey: user.tenantKey,
      openId: user.openId,
      departmentId: user.departmentId,
      departmentName: user.departmentName,
    },
    activeToken: session.activeToken,
    billingPeriod: session.billingPeriod,
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
    proxyLogCount: session.proxyLogCount,
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
      proxyLogCount: store.proxyLogCount,
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
  const billingPeriod = activeToken
    ? await getUserBillingPeriod(user.id, activeToken.billingPeriod)
    : null;
  return authenticatedSessionResponse(config.publicBaseUrl, user, {
    settings: {
      ...store.settings,
      defaultMonthlyQuota: effectiveGrantQuota,
    },
    activeToken,
    billingPeriod,
    adminScope,
    requests,
    proxyLogCount: store.proxyLogCount,
  });
}
