import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { listUserUsageRecords } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function positiveInt(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "需要飞书 OAuth 会话" }, { status: 401 });
  }

  const url = new URL(request.url);
  const records = await listUserUsageRecords(
    user.id,
    positiveInt(url.searchParams.get("limit"), 100),
  );
  return NextResponse.json({ records });
}
