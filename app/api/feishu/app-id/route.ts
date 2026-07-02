import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const appId = getConfig().feishu.appId;
  if (!appId) {
    return NextResponse.json(
      { error: "FEISHU_APP_ID is not configured" },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }

  return NextResponse.json(
    { appId },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
