import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { getFeishuContactUserByOpenId } from "@/lib/feishu";
import { getCurrentUser } from "@/lib/session";
import {
  getActiveTokenForUser,
  getAdminScopeForUser,
  getStoreSnapshot,
  listUserTokenRequests,
  upsertFeishuUser,
} from "@/lib/store";

export const runtime = "nodejs";

function firstDepartmentId(value?: string[]) {
  return value?.find((item) => item.length > 0);
}

async function hydrateUserDepartment<T extends Awaited<ReturnType<typeof getCurrentUser>>>(user: T) {
  if (!user || user.departmentId) return user;
  try {
    const contactUser = await getFeishuContactUserByOpenId(user.openId);
    const departmentId = firstDepartmentId(contactUser.department_ids);
    if (!departmentId) return user;
    return upsertFeishuUser({
      tenantKey: user.tenantKey,
      openId: user.openId,
      unionId: user.unionId,
      feishuUserIdFromFeishu: user.feishuUserIdFromFeishu,
      name: user.name,
      avatarUrl: user.avatarUrl,
      departmentId,
    });
  } catch {
    return user;
  }
}

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
    getAdminScopeForUser(user.id),
    getStoreSnapshot(),
  ]);
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
