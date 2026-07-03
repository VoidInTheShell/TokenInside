import { NextResponse } from "next/server";
import { getEffectiveAdminScopeForUser, hydrateUserDepartment } from "@/lib/admin-sync";
import { getConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/session";
import {
  getActiveTokenForUser,
  getStoreSnapshot,
  getUserBillingPeriod,
  listUserTokenRequests,
} from "@/lib/store";

export const runtime = "nodejs";

export async function GET() {
  const user = await hydrateUserDepartment(await getCurrentUser());
  const config = getConfig();
  if (!user) {
    const store = await getStoreSnapshot();
    return NextResponse.json({
      authenticated: false,
      baseUrl: config.publicBaseUrl,
      settings: store.settings,
      requests: [],
      proxyLogCount: store.proxyRequestLogs.length,
    });
  }

  const [requests, activeToken, adminScope, store] = await Promise.all([
    listUserTokenRequests(user.id),
    getActiveTokenForUser(user.id),
    getEffectiveAdminScopeForUser(user),
    getStoreSnapshot(),
  ]);
  const billingPeriod = activeToken
    ? await getUserBillingPeriod(user.id, activeToken.billingPeriod)
    : null;
  return NextResponse.json({
    authenticated: true,
    baseUrl: config.publicBaseUrl,
    settings: store.settings,
    user: {
      id: user.id,
      name: user.name,
      avatarUrl: user.avatarUrl,
      tenantKey: user.tenantKey,
      openId: user.openId,
      departmentId: user.departmentId,
    },
    activeToken,
    billingPeriod,
    adminScope: adminScope
      ? {
          type: adminScope.scopeType,
          departmentId: adminScope.departmentId,
          source: adminScope.source,
        }
      : null,
    requests,
    proxyLogCount: store.proxyRequestLogs.length,
  });
}
