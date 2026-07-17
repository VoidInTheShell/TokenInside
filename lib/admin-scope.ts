import type { AdminScope, FeishuUser, TokenRequest } from "@/lib/types";

function blocksAutomaticAdminRestore(scope: AdminScope) {
  if (scope.status !== "disabled") return false;
  return (
    scope.disabledReason === "manual_revoke" ||
    scope.disabledReason === "user_deleted" ||
    scope.disabledReason === undefined
  );
}

export function resolveSessionAdminScopeProjection(input: {
  user: FeishuUser;
  systemAdminOpenIds: ReadonlySet<string>;
  activeScope: AdminScope | null;
  assignedRequest: TokenRequest | null;
  scopes: AdminScope[];
  now?: string;
}) {
  const { user } = input;
  if (user.status && user.status !== "active") return null;

  const now = input.now ?? new Date().toISOString();
  if (input.systemAdminOpenIds.has(user.openId)) {
    return {
      id: `env-admin-${user.id}`,
      feishuUserId: user.id,
      scopeType: "global",
      source: "environment",
      role: "root",
      status: "active",
      createdAt: now,
      updatedAt: now,
    } satisfies AdminScope;
  }

  if (input.activeScope) return input.activeScope;

  const departmentId = input.assignedRequest?.approvalDepartmentId;
  if (!departmentId) return null;

  const blockedByGlobalRevocation = input.scopes.some(
    (scope) => scope.scopeType === "global" && blocksAutomaticAdminRestore(scope),
  );
  if (blockedByGlobalRevocation) return null;

  const blockedByDepartmentRevocation = input.scopes.some(
    (scope) =>
      scope.scopeType === "department" &&
      scope.departmentId === departmentId &&
      blocksAutomaticAdminRestore(scope),
  );
  if (blockedByDepartmentRevocation) return null;

  return {
    id: `assigned-admin-${user.id}`,
    feishuUserId: user.id,
    scopeType: "department",
    departmentId,
    source: "department_supervisor",
    status: "active",
    createdAt: now,
    updatedAt: now,
  } satisfies AdminScope;
}

export function tokenRequestInAdminScope(
  request: TokenRequest,
  scope: AdminScope,
  usersById: ReadonlyMap<string, FeishuUser>,
  globalAdminOpenIds: ReadonlySet<string> = new Set(),
) {
  if (scope.scopeType === "global") return true;
  if (!scope.departmentId) return false;
  if (request.approvalTargetSource === "system_admin_fallback") return false;

  const requester = usersById.get(request.feishuUserId);
  if (requester && globalAdminOpenIds.has(requester.openId)) return false;

  const requesterDepartmentId = requester?.departmentId;
  const requestDepartmentId = request.approvalDepartmentId ?? requesterDepartmentId;
  return Boolean(requestDepartmentId && requestDepartmentId === scope.departmentId);
}
