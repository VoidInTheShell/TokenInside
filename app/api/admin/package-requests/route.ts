import { NextResponse } from "next/server";
import { requireAdminScope } from "@/lib/admin";
import { listAdminPackageRequests } from "@/lib/package-repository";
import {
  nonNegativePageValue,
  packageRouteError,
  positivePageValue,
} from "@/lib/package-route";
import type { BillingPackageRequest } from "@/lib/package-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const statuses = new Set<BillingPackageRequest["status"]>([
  "pending_card_send",
  "pending_card_approval",
  "approval_card_send_failed",
  "approved",
  "approved_provisioning",
  "provisioned",
  "rejected",
  "cancelled",
  "failed",
]);

export async function GET(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  const url = new URL(request.url);
  const statusValue = url.searchParams.get("status");
  const status = statusValue && statuses.has(statusValue as BillingPackageRequest["status"])
    ? (statusValue as BillingPackageRequest["status"])
    : undefined;
  if (statusValue && !status) {
    return NextResponse.json(
      { error: { code: "invalid_package_filter", message: "status 筛选无效", retryable: false } },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(
      await listAdminPackageRequests({
        scope: auth.scope,
        status,
        limit: positivePageValue(url.searchParams.get("limit"), 20),
        offset: nonNegativePageValue(url.searchParams.get("offset")),
      }),
    );
  } catch (error) {
    return packageRouteError(error);
  }
}
