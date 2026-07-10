import { NextResponse } from "next/server";
import { getEffectiveAdminScopeForUser, hydrateUserDepartment } from "@/lib/admin-sync";
import { getConfig } from "@/lib/config";
import { nowIso } from "@/lib/crypto";
import {
  fromNewApiQuota,
  getNewApiTokenKey,
  getNewApiTokenRemainQuota,
} from "@/lib/newapi";
import { provisionTokenForRequest } from "@/lib/provisioning";
import { getCurrentUser } from "@/lib/session";
import {
  createTokenRequest,
  getActiveTokenForUser,
  getStoreSnapshot,
  getUserBillingPeriod,
  listUserTokenRequests,
} from "@/lib/store";
import { maskApiKey } from "@/lib/utils";
import type { AdminScope, FeishuUser, TokenAccount, TokenRequest } from "@/lib/types";

export const runtime = "nodejs";

const ADMIN_AUTO_PROVISION_REASON = "管理员默认额度自动发放";

async function ensureAdminActiveToken(input: {
  user: FeishuUser;
  activeToken: TokenAccount | null;
  adminScope: AdminScope | null;
  requests: TokenRequest[];
  defaultMonthlyQuota: number;
}) {
  if (input.activeToken || !input.adminScope) return input.activeToken;

  const reusableRequest = input.requests.find(
    (request) =>
      request.requestType === "first_apply" &&
      request.approvalMode === "manual" &&
      request.reason === ADMIN_AUTO_PROVISION_REASON &&
      (request.status === "approved" || request.status === "approved_provision_failed"),
  );
  const operatedAt = nowIso();
  const tokenRequest =
    reusableRequest ??
    (await createTokenRequest({
      feishuUserId: input.user.id,
      requestType: "first_apply",
      status: "approved",
      reason: ADMIN_AUTO_PROVISION_REASON,
      requestedMonthlyQuota: input.defaultMonthlyQuota,
      approvedMonthlyQuota: input.defaultMonthlyQuota,
      approvalMode: "manual",
      approvalOperatorOpenId: input.user.openId,
      approvalOperatedAt: operatedAt,
    }));

  await provisionTokenForRequest(tokenRequest);
  return getActiveTokenForUser(input.user.id);
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

  let [requests, activeToken, adminScope, store] = await Promise.all([
    listUserTokenRequests(user.id),
    getActiveTokenForUser(user.id),
    getEffectiveAdminScopeForUser(user),
    getStoreSnapshot(),
  ]);
  if (adminScope && !activeToken) {
    try {
      activeToken = await ensureAdminActiveToken({
        user,
        activeToken,
        adminScope,
        requests,
        defaultMonthlyQuota: store.settings.defaultMonthlyQuota,
      });
      requests = await listUserTokenRequests(user.id);
      store = await getStoreSnapshot();
    } catch {
      requests = await listUserTokenRequests(user.id);
      store = await getStoreSnapshot();
    }
  }
  const billingPeriod = activeToken
    ? await getUserBillingPeriod(user.id, activeToken.billingPeriod)
    : null;
  let activeTokenResponse:
    | (typeof activeToken & {
        maskedKey?: string;
        remainingQuota?: number;
      })
    | null = activeToken;
  let remainingQuota: number | undefined;
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
    try {
      const remainQuota = await getNewApiTokenRemainQuota(activeToken.newapiTokenId);
      remainingQuota =
        remainQuota === undefined ? undefined : Math.max(0, Math.round(fromNewApiQuota(remainQuota)));
      activeTokenResponse = {
        ...activeTokenResponse,
        remainingQuota,
      };
    } catch {
      activeTokenResponse = { ...activeTokenResponse };
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
      departmentName: user.departmentName,
    },
    activeToken: activeTokenResponse,
    billingPeriod: billingPeriod
      ? {
          ...billingPeriod,
          upstreamRemainingQuota: remainingQuota,
        }
      : null,
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
    requests,
    proxyLogCount: store.proxyRequestLogs.length,
  });
}
