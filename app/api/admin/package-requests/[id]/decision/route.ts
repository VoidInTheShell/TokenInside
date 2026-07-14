import { after, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { decidePackageRequest } from "@/lib/package-repository";
import { packageRouteError } from "@/lib/package-route";
import { provisionApprovedPackageRequest } from "@/lib/package-saga";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const decisionSchema = z.object({
  action: z.enum(["approve", "reject", "cancel"]),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  const parsed = decisionSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "invalid_package_decision", message: "套餐审批动作无效", retryable: false } },
      { status: 400 },
    );
  }
  try {
    const { id } = await params;
    const result = await decidePackageRequest({
      scope: auth.scope,
      operatedByUserId: auth.user.id,
      operatedByOpenId: auth.user.openId,
      requestId: id,
      action: parsed.data.action,
    });
    if (parsed.data.action === "approve" && result.operation) {
      after(() => provisionApprovedPackageRequest(id).catch(() => undefined));
      return NextResponse.json(result, { status: 202 });
    }
    return NextResponse.json(result);
  } catch (error) {
    return packageRouteError(error);
  }
}
