import { NextResponse } from "next/server";
import { getEffectiveAdminScopeForUser, hydrateUserDepartment } from "@/lib/admin-sync";
import { getConfig } from "@/lib/config";
import { getNewApiTokenKey } from "@/lib/newapi";
import { getCurrentUser } from "@/lib/session";
import {
  getActiveTokenForUser,
  getStoreSnapshot,
  getUserBillingPeriod,
  listUserTokenRequests,
} from "@/lib/store";
import { maskApiKey } from "@/lib/utils";

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
  let activeTokenResponse:
    | (typeof activeToken & {
        maskedKey?: string;
      })
    | null = activeToken;
  if (activeToken?.newapiTokenId) {
    try {
      const key = await getNewApiTokenKey(activeToken.newapiTokenId);
      activeTokenResponse = {
        ...activeToken,
        maskedKey: maskApiKey(key),
      };
    } catch {
      activeTokenResponse = { ...activeToken };
    }
  }
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
    activeToken: activeTokenResponse,
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
