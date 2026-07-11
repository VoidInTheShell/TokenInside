import type { AdminScope, FeishuUser, TokenRequest } from "@/lib/types";

export function tokenRequestInAdminScope(
  request: TokenRequest,
  scope: AdminScope,
  usersById: ReadonlyMap<string, FeishuUser>,
  globalAdminOpenIds: ReadonlySet<string> = new Set(),
) {
  if (scope.scopeType === "global") return true;
  if (!scope.departmentId) return false;

  const requester = usersById.get(request.feishuUserId);
  if (requester && globalAdminOpenIds.has(requester.openId)) return false;

  const requesterDepartmentId = requester?.departmentId;
  const requestDepartmentId = request.approvalDepartmentId ?? requesterDepartmentId;
  return Boolean(requestDepartmentId && requestDepartmentId === scope.departmentId);
}
