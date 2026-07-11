import type { AdminScope, FeishuUser, TokenRequest } from "@/lib/types";

export function tokenRequestInAdminScope(
  request: TokenRequest,
  scope: AdminScope,
  usersById: ReadonlyMap<string, FeishuUser>,
) {
  if (scope.scopeType === "global") return true;
  if (!scope.departmentId) return false;

  const requesterDepartmentId = usersById.get(request.feishuUserId)?.departmentId;
  const requestDepartmentId = request.approvalDepartmentId ?? requesterDepartmentId;
  return Boolean(requestDepartmentId && requestDepartmentId === scope.departmentId);
}
