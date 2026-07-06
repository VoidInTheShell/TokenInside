import { NextResponse } from "next/server";
import { z } from "zod";
import {
  exchangeFeishuCode,
  getFeishuContactUserByOpenId,
  getFeishuUserInfo,
} from "@/lib/feishu";
import { createSessionToken, setSessionCookie } from "@/lib/session";
import { upsertFeishuUser } from "@/lib/store";

export const runtime = "nodejs";

const callbackSchema = z.object({
  code: z.string().min(1),
});

function firstDepartmentId(value?: string[]) {
  return value?.find((item) => item.length > 0);
}

export async function POST(request: Request) {
  try {
    const input = callbackSchema.parse(await request.json());
    const token = await exchangeFeishuCode(input.code);
    const userInfo = await getFeishuUserInfo(token.access_token);
    let departmentId: string | undefined;
    try {
      const contactUser = await getFeishuContactUserByOpenId(userInfo.open_id);
      departmentId = firstDepartmentId(contactUser.department_ids);
    } catch {
      departmentId = undefined;
    }

    const user = await upsertFeishuUser({
      tenantKey: userInfo.tenant_key,
      openId: userInfo.open_id,
      unionId: userInfo.union_id,
      feishuUserIdFromFeishu: userInfo.user_id,
      name: userInfo.name,
      avatarUrl: userInfo.avatar_url,
      departmentId,
    });

    const sessionToken = createSessionToken({
      userId: user.id,
      tenantKey: user.tenantKey,
      openId: user.openId,
    });
    await setSessionCookie(sessionToken);

    return NextResponse.json({ ok: true, user });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Feishu callback failed" },
      { status: 400 },
    );
  }
}
