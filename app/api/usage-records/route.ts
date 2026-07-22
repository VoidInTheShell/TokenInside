import { NextResponse } from "next/server";
import { listNewApiUserUsageReport } from "@/lib/newapi-reporting";
import { newApiReportingFailure } from "@/lib/newapi-reporting-response";
import { requireActiveWorkspaceAccess } from "@/lib/workspace-access";

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
  const access = await requireActiveWorkspaceAccess();
  if ("error" in access) return access.error;
  const { user } = access;

  const url = new URL(request.url);
  try {
    const result = await listNewApiUserUsageReport({
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
  } catch (error) {
    return newApiReportingFailure(error, "NewAPI 使用记录读取失败");
  }
}
