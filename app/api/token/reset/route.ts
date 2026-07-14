import { NextResponse } from "next/server";
import { z } from "zod";
import { hydrateUserDepartment } from "@/lib/admin-sync";
import { randomId } from "@/lib/crypto";
import { packageRouteError } from "@/lib/package-route";
import { rotatePackageKey } from "@/lib/package-saga";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const resetSchema = z.object({
  reason: z.string().trim().min(4).max(500).optional(),
  clientRequestId: z.string().min(8).max(120).optional(),
});

export async function POST(request: Request) {
  const user = await hydrateUserDepartment(await getCurrentUser());
  if (!user) {
    return NextResponse.json(
      { error: { code: "feishu_session_required", message: "需要飞书 OAuth 会话", retryable: false } },
      { status: 401 },
    );
  }
  if (!user.departmentId) {
    return NextResponse.json(
      { error: { code: "user_department_required", message: "当前飞书用户没有可用部门", retryable: false } },
      { status: 409 },
    );
  }
  const parsed = resetSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "invalid_key_rotation", message: "Key 更换理由无效", retryable: false } },
      { status: 400 },
    );
  }
  try {
    const result = await rotatePackageKey({
      userId: user.id,
      departmentId: user.departmentId,
      clientRequestId:
        parsed.data.clientRequestId ?? request.headers.get("idempotency-key") ?? randomId("rotation"),
      reason: parsed.data.reason ?? "用户在 TokenInside 用户后台发起 Key 更换",
    });
    return NextResponse.json(result, { status: result.reused ? 200 : 201 });
  } catch (error) {
    return packageRouteError(error);
  }
}
