import { NextResponse } from "next/server";
import { requireAdminScope } from "@/lib/admin";
import { getPackageBillingReport } from "@/lib/package-repository";
import {
  nonNegativePageValue,
  packageRouteError,
  positivePageValue,
} from "@/lib/package-route";
import { getQuotaDisplaySnapshot } from "@/lib/quota-display";
import { formatRawQuota } from "@/lib/quota-display-model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  const url = new URL(request.url);
  try {
    const [report, snapshot] = await Promise.all([
      getPackageBillingReport({
        scope: auth.scope,
        limit: positivePageValue(url.searchParams.get("limit"), 20),
        offset: nonNegativePageValue(url.searchParams.get("offset")),
      }),
      getQuotaDisplaySnapshot({ refreshIfStale: true }),
    ]);
    return NextResponse.json({
      ...report,
      summary: {
        ...report.summary,
        granted: formatRawQuota(report.summary.grantedQuota, snapshot),
        allocated: formatRawQuota(report.summary.allocatedQuota, snapshot),
        available: formatRawQuota(report.summary.availableQuota, snapshot),
        authoritativeConsumed: formatRawQuota(
          report.summary.authoritativeConsumedQuota,
          snapshot,
        ),
      },
      items: report.items.map((item) => ({
        ...item,
        quota: formatRawQuota(item.allocation.quota, snapshot),
      })),
      quotaDisplay: snapshot,
    });
  } catch (error) {
    return packageRouteError(error);
  }
}
