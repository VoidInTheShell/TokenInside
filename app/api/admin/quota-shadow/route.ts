import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { buildQuotaShadowReconciliation } from "@/lib/quota-reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  observe: z.enum(["true", "false"]).default("false"),
});

export async function GET(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    period: url.searchParams.get("period") ?? undefined,
    observe: url.searchParams.get("observe") ?? "false",
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "period 或 observe 参数无效" }, { status: 400 });
  }
  const report = await buildQuotaShadowReconciliation({
    scope: auth.scope,
    period: parsed.data.period,
    observeUpstream: parsed.data.observe === "true",
  });
  return NextResponse.json(report);
}
