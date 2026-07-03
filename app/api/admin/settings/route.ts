import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { getAppSettings, updateAppSettings } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const settingsSchema = z.object({
  defaultMonthlyQuota: z.number().int().positive().max(1000000),
});

export async function GET() {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  return NextResponse.json({ settings: await getAppSettings() });
}

export async function PATCH(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  const parsed = settingsSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "默认额度必须是正整数" }, { status: 400 });
  }
  const settings = await updateAppSettings({
    defaultMonthlyQuota: parsed.data.defaultMonthlyQuota,
    updatedByFeishuUserId: auth.user.id,
  });
  return NextResponse.json({ settings });
}
