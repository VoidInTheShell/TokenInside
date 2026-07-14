import { NextResponse } from "next/server";
import { hydrateUserDepartment } from "@/lib/admin-sync";
import {
  getUserPackageBalance,
  listUserPackageOperations,
  listUserPackageGrants,
  listUserPackageRequests,
} from "@/lib/package-repository";
import { packageRouteError } from "@/lib/package-route";
import { getCurrentUser } from "@/lib/session";
import { getQuotaDisplaySnapshot } from "@/lib/quota-display";
import { formatRawQuota } from "@/lib/quota-display-model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await hydrateUserDepartment(await getCurrentUser());
  if (!user) {
    return NextResponse.json(
      { error: { code: "feishu_session_required", message: "需要飞书 OAuth 会话", retryable: false } },
      { status: 401 },
    );
  }
  try {
    const [balance, grants, requests, operations, snapshot] = await Promise.all([
      getUserPackageBalance(user.id),
      listUserPackageGrants({ userId: user.id, includeHistory: true }),
      listUserPackageRequests(user.id),
      listUserPackageOperations(user.id),
      getQuotaDisplaySnapshot({ refreshIfStale: true }),
    ]);
    return NextResponse.json({
      balance: {
        ...balance,
        granted: formatRawQuota(balance.grantedQuota, snapshot),
        allocated: formatRawQuota(balance.allocatedQuota, snapshot),
        available: formatRawQuota(balance.availableQuota, snapshot),
      },
      grants: grants.map((grant) => ({
        ...grant,
        granted: formatRawQuota(grant.grantedQuota, snapshot),
        allocated: formatRawQuota(grant.allocatedQuota, snapshot),
        available: formatRawQuota(grant.grantedQuota - grant.allocatedQuota, snapshot),
      })),
      requests,
      operations,
      quotaDisplay: snapshot,
    });
  } catch (error) {
    return packageRouteError(error);
  }
}
