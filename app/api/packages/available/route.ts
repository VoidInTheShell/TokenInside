import { NextResponse } from "next/server";
import { hydrateUserDepartment } from "@/lib/admin-sync";
import { listAvailablePackagesForDepartment } from "@/lib/package-repository";
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
  if (!user.departmentId) {
    return NextResponse.json(
      { error: { code: "user_department_required", message: "当前飞书用户没有可用部门", retryable: false } },
      { status: 409 },
    );
  }
  try {
    const [items, snapshot] = await Promise.all([
      listAvailablePackagesForDepartment(user.departmentId),
      getQuotaDisplaySnapshot({ refreshIfStale: true }),
    ]);
    return NextResponse.json({
      items: items.map((item) => ({
        ...item,
        quota: formatRawQuota(item.version.grantedQuota, snapshot),
      })),
      quotaDisplay: snapshot,
    });
  } catch (error) {
    return packageRouteError(error);
  }
}
