import { NextResponse } from "next/server";
import { getEffectiveAdminScopeForUser, hydrateUserDepartment } from "@/lib/admin-sync";
import { getCurrentUser } from "@/lib/session";

export async function requireAdminScope() {
  const user = await hydrateUserDepartment(await getCurrentUser());
  if (!user) {
    return {
      error: NextResponse.json({ error: "需要飞书 OAuth 会话" }, { status: 401 }),
    };
  }

  const scope = await getEffectiveAdminScopeForUser(user);
  if (!scope) {
    return {
      error: NextResponse.json(
        { error: "当前飞书用户没有启用的 TokenInside 管理范围" },
        { status: 403 },
      ),
    };
  }

  return { user, scope };
}
