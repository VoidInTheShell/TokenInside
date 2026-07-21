import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminScope } from "@/lib/admin";
import { isAdminUserActionAuthorizationError } from "@/lib/postgres-store";
import {
  enqueueDepartmentMemberSyncOperationAsActor,
  listDepartmentMemberSyncOperations,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const syncSchema = z.object({
  departmentId: z.string().min(1).max(200).optional(),
});

function visibleOperation<T extends { leaseId?: string; leaseExpiresAt?: string }>(
  operation: T,
) {
  const {
    leaseId: _leaseId,
    leaseExpiresAt: _leaseExpiresAt,
    ...visible
  } = operation;
  return visible;
}

export async function GET() {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  const operations = await listDepartmentMemberSyncOperations({
    departmentId:
      auth.scope.scopeType === "department" ? auth.scope.departmentId : undefined,
    limit: 100,
  });
  return NextResponse.json({ operations: operations.map(visibleOperation) });
}

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
    const submitted = await enqueueDepartmentMemberSyncOperationAsActor({
      actorFeishuUserId: auth.user.id,
      departmentId,
    });
    if (submitted.conflicted) {
      return NextResponse.json(
        {
          error: "该部门已有不同参数的成员同步任务正在执行，请等待任务结束后重试",
          operation: visibleOperation(submitted.operation),
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      {
        accepted: true,
        created: submitted.created,
        operation: visibleOperation(submitted.operation),
      },
      { status: 202 },
    );
  } catch (error) {
    if (isAdminUserActionAuthorizationError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "提交部门成员同步任务失败" },
      { status: 400 },
    );
  }
}
