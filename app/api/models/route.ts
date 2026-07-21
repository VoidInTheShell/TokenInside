import { NextResponse } from "next/server";
import { listModelsForNewApiToken } from "@/lib/newapi";
import { requireActiveWorkspaceAccess } from "@/lib/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await requireActiveWorkspaceAccess();
    if ("error" in access) return access.error;
    const { activeToken } = access;
    if (!activeToken?.newapiTokenId) {
      return NextResponse.json({ models: [] });
    }

    const models = await listModelsForNewApiToken(activeToken.newapiTokenId);
    return NextResponse.json({
      models: models.map((model) => ({
        id: model.id,
        object: model.object,
        ownedBy: model.owned_by,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Read models failed" },
      { status: 400 },
    );
  }
}
