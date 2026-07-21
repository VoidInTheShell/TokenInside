import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getActiveTokenForUser, listUserTokenRequests } from "@/lib/store";
import type { FeishuUser, TokenAccount, TokenRequest } from "@/lib/types";

export type WorkspaceAccess = "application_only" | "provisioning" | "active";

const firstApplyProvisioningStatuses = new Set([
  "pending_card_send",
  "pending_card_approval",
  "approval_card_send_failed",
  "approval_route_failed",
  "pending_feishu_approval",
  "approved",
  "approved_provisioning",
  "approved_provision_failed",
  "provisioned",
  "draft_pending_approval_config",
]);

export function resolveWorkspaceAccess(input: {
  user?: Pick<FeishuUser, "status"> | null;
  activeToken?: TokenAccount | null;
  requests?: TokenRequest[];
}): WorkspaceAccess {
  if (input.user?.status && input.user.status !== "active") return "application_only";
  if (input.activeToken?.status === "active") return "active";
  if (
    input.requests?.some(
      (request) =>
        request.requestType === "first_apply" &&
        firstApplyProvisioningStatuses.has(request.status),
    )
  ) {
    return "provisioning";
  }
  return "application_only";
}

export async function requireActiveWorkspaceAccess() {
  const user = await getCurrentUser();
  if (!user) {
    return {
      error: NextResponse.json(
        {
          error: "需要飞书 OAuth 会话",
          code: "feishu_oauth_session_required",
          workspaceAccess: "application_only" satisfies WorkspaceAccess,
        },
        { status: 401 },
      ),
    };
  }

  // Active users stay on the hot path: no request-history query is needed.
  const activeToken = await getActiveTokenForUser(user.id);
  if (resolveWorkspaceAccess({ user, activeToken }) === "active" && activeToken) {
    return {
      user,
      activeToken,
      workspaceAccess: "active" as const,
    };
  }

  const requests = await listUserTokenRequests(user.id);
  const workspaceAccess = resolveWorkspaceAccess({ user, activeToken, requests });
  return {
    error: NextResponse.json(
      {
        error: "申请通过并完成 Key 发放后才能访问用户后台",
        code: "active_workspace_access_required",
        workspaceAccess,
      },
      { status: 403 },
    ),
  };
}
