import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { listUserUsageReport } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function positiveInt(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function optionalParam(url: URL, key: string) {
  const value = url.searchParams.get(key);
  return value && value !== "__all__" ? value : undefined;
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "需要飞书 OAuth 会话" }, { status: 401 });
  }

  const url = new URL(request.url);
  const result = await listUserUsageReport({
    feishuUserId: user.id,
    model: optionalParam(url, "model"),
    provider: optionalParam(url, "provider"),
    apiFormat: optionalParam(url, "apiFormat"),
    status: optionalParam(url, "status"),
    userAgent: optionalParam(url, "userAgent"),
    clientFamily: optionalParam(url, "clientFamily"),
    search: optionalParam(url, "search"),
    preset: optionalParam(url, "preset"),
    startDate: optionalParam(url, "startDate"),
    endDate: optionalParam(url, "endDate"),
    hideUnknownRecords: url.searchParams.get("hideUnknownRecords") === "true",
    limit: positiveInt(url.searchParams.get("limit"), 100),
    offset: nonNegativeInt(url.searchParams.get("offset"), 0),
  });
  return NextResponse.json(result);
}
