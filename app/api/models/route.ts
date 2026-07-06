import { NextResponse } from "next/server";
import { listModelsForNewApiToken } from "@/lib/newapi";
import { getCurrentUser } from "@/lib/session";
import { getActiveTokenForUser } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Feishu OAuth session required" }, { status: 401 });
    }

    const activeToken = await getActiveTokenForUser(user.id);
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
