import { NextResponse } from "next/server";
import { getEffectiveAdminScopeForUser, hydrateUserDepartment } from "@/lib/admin-sync";
import { getConfig } from "@/lib/config";
import { getNewApiTokenKey } from "@/lib/newapi";
import { getCurrentUser } from "@/lib/session";
import { getActiveTokenForUser } from "@/lib/store";
import { maskApiKey } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await hydrateUserDepartment(await getCurrentUser());
  const config = getConfig();
  if (!user) {
    return NextResponse.json({
      authenticated: false,
      baseUrl: config.publicBaseUrl,
    });
  }

  const [activeToken, adminScope] = await Promise.all([
    getActiveTokenForUser(user.id),
    getEffectiveAdminScopeForUser(user),
  ]);
  let activeTokenResponse:
    | (typeof activeToken & {
        maskedKey?: string;
      })
    | null = activeToken;
  if (activeToken?.newapiTokenId) {
    try {
      const key = await getNewApiTokenKey(activeToken.newapiTokenId);
      activeTokenResponse = { ...activeToken, maskedKey: maskApiKey(key) };
    } catch {
      activeTokenResponse = { ...activeToken };
    }
  }

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
      departmentName: user.departmentName,
    },
    activeToken: activeTokenResponse,
    adminScope: adminScope
      ? {
          type: adminScope.scopeType,
          departmentId: adminScope.departmentId,
          departmentName:
            adminScope.departmentId === user.departmentId ? user.departmentName : undefined,
          source: adminScope.source,
          role: adminScope.role,
        }
      : null,
  });
}
