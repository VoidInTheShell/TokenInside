import { NextResponse } from "next/server";
import { z } from "zod";
import { resetActiveTokenForUser } from "@/lib/provisioning";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const resetSchema = z.object({
  reason: z.string().min(4).max(500).optional(),
});

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Feishu OAuth session required" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const parsed = resetSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "key reset 理由无效" }, { status: 400 });
    }

    const result = await resetActiveTokenForUser(user, parsed.data.reason);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Reset NewAPI key failed" },
      { status: 400 },
    );
  }
}
