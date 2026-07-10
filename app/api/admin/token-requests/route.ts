import { NextResponse } from "next/server";
import { requireAdminScope } from "@/lib/admin";
import { listAdminTokenRequests } from "@/lib/store";

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

export async function GET(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const result = await listAdminTokenRequests({
    scope: auth.scope,
    limit: positiveInt(url.searchParams.get("limit"), 20),
    offset: nonNegativeInt(url.searchParams.get("offset"), 0),
  });

  return NextResponse.json(result);
}
