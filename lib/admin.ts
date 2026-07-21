import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getAdminScopeForKnownUser } from "@/lib/store";
import type { AdminScope } from "@/lib/types";

export function isRootAdminScope(scope?: AdminScope | null) {
  return scope?.scopeType === "global" && scope.source === "environment" && scope.role === "root";
}

export function isSystemAdminScope(scope?: AdminScope | null) {
  return scope?.scopeType === "global";
}

export async function requireAdminScope() {
  const user = await getCurrentUser();
  if (!user) {
    return {
      error: NextResponse.json({ error: "需要飞书 OAuth 会话" }, { status: 401 }),
    };
  }
  if (user.status === "deleted") {
    return {
      error: NextResponse.json({ error: "该用户已删除，需要重新申请后才能访问后台" }, { status: 403 }),
    };
  }
  if (user.status === "disabled") {
    return {
      error: NextResponse.json({ error: "该用户已禁用，不能访问管理后台" }, { status: 403 }),
    };
  }

  // Admin GET handlers must remain read-only. Department hydration and
  // supervisor-scope synchronization belong to OAuth, explicit sync actions,
  // or background directory jobs; authorization reads only persisted state.
  const scope = await getAdminScopeForKnownUser(user);
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
