import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { getConfig } from "@/lib/config";
import {
  QuotaSubmissionError,
  updatePostgresTokenRequestQuotaAsActor,
} from "@/lib/quota-operation-submit";
import {
  JsonQuotaSubmissionError,
  updateJsonTokenRequestQuotaAsActor,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const quotaSchema = z.object({
  approvedMonthlyQuota: z.number().int().positive().max(1000000),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;

  const parsed = quotaSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "最终额度必须是正整数" }, { status: 400 });
  }
  const { id } = await params;
  let updated;
  try {
    updated =
      getConfig().storeBackend === "postgres"
        ? await updatePostgresTokenRequestQuotaAsActor({
            actorUserId: auth.user.id,
            requestId: id,
            approvedMonthlyQuota: parsed.data.approvedMonthlyQuota,
          })
        : await updateJsonTokenRequestQuotaAsActor({
            actorUserId: auth.user.id,
            requestId: id,
            approvedMonthlyQuota: parsed.data.approvedMonthlyQuota,
          });
  } catch (error) {
    if (
      error instanceof QuotaSubmissionError ||
      error instanceof JsonQuotaSubmissionError
    ) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    throw error;
  }
  return NextResponse.json({ request: updated });
}
