import { NextResponse } from "next/server";
import { requireAdminScope } from "@/lib/admin";
import { ensureAdminDefaultProvisioning } from "@/lib/admin-default-provisioning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;

  const provisioning = await ensureAdminDefaultProvisioning({
    feishuUserId: auth.user.id,
    trustedScope: auth.scope,
  });
  return NextResponse.json(provisioning, {
    status:
      provisioning.status === "provisioning" || provisioning.status === "deferred"
        ? 202
        : 200,
  });
}
