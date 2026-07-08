import { NextResponse } from "next/server";
import { requireAdminScope } from "@/lib/admin";
import { listAdminUsageRecords } from "@/lib/store";

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
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const result = await listAdminUsageRecords({
    scope: auth.scope,
    userId: optionalParam(url, "userId"),
    departmentId: optionalParam(url, "departmentId"),
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
