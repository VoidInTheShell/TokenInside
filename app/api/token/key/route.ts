import { NextResponse } from "next/server";
import { getNewApiTokenKey } from "@/lib/newapi";
import { requireActiveWorkspaceAccess } from "@/lib/workspace-access";

export const runtime = "nodejs";

export async function GET() {
  try {
    const access = await requireActiveWorkspaceAccess();
    if ("error" in access) return access.error;
    const activeToken = access.activeToken;
    if (!activeToken?.newapiTokenId) {
      return NextResponse.json({ error: "No active NewAPI token" }, { status: 404 });
    }
    const key = await getNewApiTokenKey(activeToken.newapiTokenId);
    if (!key) {
      return NextResponse.json({ error: "NewAPI did not return token key" }, { status: 502 });
    }
    return NextResponse.json({ key });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Read token key failed" },
      { status: 400 },
    );
  }
}
