import { NextResponse } from "next/server";
import { getQuotaDisplaySnapshot } from "@/lib/quota-display";
import { packageRouteError } from "@/lib/package-route";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await getCurrentUser())) {
    return NextResponse.json(
      { error: { code: "feishu_session_required", message: "需要飞书 OAuth 会话", retryable: false } },
      { status: 401 },
    );
  }
  try {
    const snapshot = await getQuotaDisplaySnapshot({ refreshIfStale: true });
    return NextResponse.json({
      snapshot,
      fallback: snapshot ? null : { displayType: "RAW_QUOTA", unitLabel: "点额度" },
    });
  } catch (error) {
    return packageRouteError(error);
  }
}
