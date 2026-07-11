import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import {
  getFeishuDepartmentNameById,
  listFeishuDepartmentUsers,
} from "@/lib/feishu";
import { getUserByOpenId, upsertFeishuUser } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const syncSchema = z.object({
  departmentId: z.string().min(1).max(200).optional(),
});

export async function POST(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  const parsed = syncSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "部门成员同步参数无效" }, { status: 400 });
  }
  const departmentId =
    auth.scope.scopeType === "global" ? parsed.data.departmentId : auth.scope.departmentId;
  if (!departmentId) {
    return NextResponse.json({ error: "缺少可同步的部门 ID" }, { status: 400 });
  }
  if (
    auth.scope.scopeType === "department" &&
    parsed.data.departmentId &&
    parsed.data.departmentId !== auth.scope.departmentId
  ) {
    return NextResponse.json({ error: "不能同步其他部门的成员" }, { status: 403 });
  }

  try {
    const departmentName =
      departmentId === auth.user.departmentId && auth.user.departmentName
        ? auth.user.departmentName
        : await getFeishuDepartmentNameById(departmentId).catch(() => undefined);
    const contacts = await listFeishuDepartmentUsers(departmentId);
    let synced = 0;
    let skipped = 0;
    for (const contact of contacts) {
      if (!contact.open_id) {
        skipped += 1;
        continue;
      }
      const existing = await getUserByOpenId(contact.open_id);
      if (existing?.departmentId && existing.departmentId !== departmentId) {
        skipped += 1;
        continue;
      }
      await upsertFeishuUser({
        tenantKey: auth.user.tenantKey,
        openId: contact.open_id,
        unionId: contact.union_id,
        feishuUserIdFromFeishu: contact.user_id,
        name: contact.name,
        avatarUrl:
          contact.avatar?.avatar_origin ??
          contact.avatar?.avatar_640 ??
          contact.avatar?.avatar_240 ??
          contact.avatar?.avatar_72,
        departmentId,
        departmentName,
      });
      synced += 1;
    }
    return NextResponse.json({ departmentId, departmentName, synced, skipped });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "同步飞书部门成员失败" },
      { status: 502 },
    );
  }
}
