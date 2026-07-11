import { NextResponse } from "next/server";
import { requireAdminScope } from "@/lib/admin";
import { normalizeOptionalIsoTimestamp } from "@/lib/iso-time";
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
  const createdAfterInput = url.searchParams.get("createdAfter");
  const decisionRequiredInput = url.searchParams.get("decisionRequired");
  const createdAfter = normalizeOptionalIsoTimestamp(createdAfterInput);
  if (createdAfterInput && !createdAfter) {
    return NextResponse.json(
      { error: "createdAfter 必须是有效的 ISO 时间" },
      { status: 400 },
    );
  }
  if (
    decisionRequiredInput &&
    decisionRequiredInput !== "true" &&
    decisionRequiredInput !== "false"
  ) {
    return NextResponse.json(
      { error: "decisionRequired 必须是 true 或 false" },
      { status: 400 },
    );
  }
  const result = await listAdminTokenRequests({
    scope: auth.scope,
    limit: positiveInt(url.searchParams.get("limit"), 20),
    offset: nonNegativeInt(url.searchParams.get("offset"), 0),
    createdAfter: createdAfter ?? undefined,
    decisionRequired: decisionRequiredInput === "true",
  });

  return NextResponse.json(result);
}
