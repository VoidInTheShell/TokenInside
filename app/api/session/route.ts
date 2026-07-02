import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/session";
import {
  getActiveTokenForUser,
  getAdminScopeForUser,
  getStoreSnapshot,
  listUserTokenRequests,
} from "@/lib/store";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  const config = getConfig();
  if (!user) {
    const store = await getStoreSnapshot();
    return NextResponse.json({
      authenticated: false,
      baseUrl: config.publicBaseUrl,
      requests: [],
      proxyLogCount: store.proxyRequestLogs.length,
    });
  }

  const [requests, activeToken, adminScope, store] = await Promise.all([
    listUserTokenRequests(user.id),
    getActiveTokenForUser(user.id),
    getAdminScopeForUser(user.id),
    getStoreSnapshot(),
  ]);

  return NextResponse.json({
    authenticated: true,
    baseUrl: config.publicBaseUrl,
    user: {
      id: user.id,
      name: user.name,
      avatarUrl: user.avatarUrl,
      tenantKey: user.tenantKey,
      openId: user.openId,
      departmentId: user.departmentId,
    },
    activeToken,
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
