import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { getAdminScopeForUser, getAppSettings, updateAppSettings } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const settingsSchema = z.object({
  defaultMonthlyQuota: z.number().int().positive().max(1000000),
});

async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user) {
    return { error: NextResponse.json({ error: "需要飞书 OAuth 会话" }, { status: 401 }) };
  }
  const scope = await getAdminScopeForUser(user.id);
  if (!scope) {
    return {
      error: NextResponse.json(
        { error: "当前飞书用户没有启用的 TokenInside 管理范围" },
        { status: 403 },
      ),
    };
  }
  return { user };
}

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  return NextResponse.json({ settings: await getAppSettings() });
}

export async function PATCH(request: Request) {
  const auth = await requireAdmin();
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
