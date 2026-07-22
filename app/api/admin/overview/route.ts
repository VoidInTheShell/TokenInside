import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import {
  nextPackageResetAt,
  normalizePackageResetPolicy,
} from "@/lib/package-reset";
import { getCurrentUser } from "@/lib/session";
import { getNewApiAdminOverviewMetrics } from "@/lib/newapi-reporting";
import {
  getAdminControlOverview,
  getAppSettings,
  getAdminScopeForKnownUser,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function responseStatus(request: Request, status: 401 | 403) {
  const url = new URL(request.url);
  return url.searchParams.get("mode") === "soft" ? 200 : status;
}

function settingsForScope<
  T extends Awaited<ReturnType<typeof getAppSettings>>,
>(
  settings: T,
  scope: Awaited<ReturnType<typeof getAdminScopeForKnownUser>>,
) {
  const { newapiControl } = settings;
  const fallback = getConfig().newapi;
  const packageReset = normalizePackageResetPolicy(settings.packageReset);
  const nextResetAt = nextPackageResetAt(packageReset);
  return {
    defaultMonthlyQuota: settings.defaultMonthlyQuota,
    packageReset: {
      ...packageReset,
      nextResetAt: nextResetAt?.toISOString(),
    },
    updatedAt: settings.updatedAt,
    ...(scope?.role === "root"
      ? {
          newapiControl: {
            baseUrl: newapiControl?.baseUrl ?? fallback.baseUrl,
            controlUserId: newapiControl?.controlUserId ?? fallback.controlUserId,
            accessTokenConfigured: Boolean(
              newapiControl?.accessTokenCiphertext ||
                fallback.accessToken ||
                fallback.adminAccessToken ||
                fallback.systemAk,
            ),
            source: newapiControl ? "system_settings" : "environment",
            updatedAt: newapiControl?.updatedAt,
          },
        }
      : {}),
  };
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      {
        authenticated: false,
        authorized: false,
        error: "需要飞书 OAuth 会话",
      },
      { status: responseStatus(request, 401) },
    );
  }

  const scope = await getAdminScopeForKnownUser(user);
  if (!scope) {
    return NextResponse.json(
      {
        authenticated: true,
        authorized: false,
        error: "当前飞书用户没有启用的 TokenInside 管理范围",
        user: {
          id: user.id,
          name: user.name,
          avatarUrl: user.avatarUrl,
          tenantKey: user.tenantKey,
          openId: user.openId,
          departmentId: user.departmentId,
          departmentName: user.departmentName,
        },
      },
      { status: responseStatus(request, 403) },
    );
  }

  const [controlOverview, usageMetrics, settings] = await Promise.all([
    getAdminControlOverview(scope),
    getNewApiAdminOverviewMetrics(scope),
    getAppSettings(),
  ]);
  const overview = {
    ...controlOverview,
    reportingSource: usageMetrics.source,
    reportingTruncated: usageMetrics.truncated,
    totals: {
      ...controlOverview.totals,
      requestCount: usageMetrics.requestCount,
      promptTokens: usageMetrics.promptTokens,
      completionTokens: usageMetrics.completionTokens,
      totalTokens: usageMetrics.totalTokens,
      packagePeriod: usageMetrics.period,
      packageQuota: usageMetrics.packageQuota,
      quotaConsumed: usageMetrics.consumedQuota,
      remainingQuota: usageMetrics.remainingQuota,
      usageRecordCount: usageMetrics.usageRecordCount,
    },
  };
  return NextResponse.json({
    authenticated: true,
    authorized: true,
    user: {
      id: user.id,
      name: user.name,
      avatarUrl: user.avatarUrl,
      tenantKey: user.tenantKey,
      openId: user.openId,
      departmentId: user.departmentId,
      departmentName: user.departmentName,
    },
    overview,
    settings: settingsForScope(settings, scope),
  });
}
