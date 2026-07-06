import { NextResponse } from "next/server";
import { requireAdminScope } from "@/lib/admin";
import { listAdminUsageRecords } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function positiveInt(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function GET(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const records = await listAdminUsageRecords({
    scope: auth.scope,
    userId: url.searchParams.get("userId") ?? undefined,
    departmentId: url.searchParams.get("departmentId") ?? undefined,
    limit: positiveInt(url.searchParams.get("limit"), 100),
  });
  return NextResponse.json({ records });
}
