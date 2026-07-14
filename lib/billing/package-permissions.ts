import { PackageBillingError } from "./package-errors.ts";
import type { BillingPackageDefinition, PackageOwnerScopeType } from "./package-types";
import type { AdminScope } from "../types";

export function packageScopeDepartment(scope: AdminScope, requestedDepartmentId?: string) {
  if (scope.scopeType === "global") {
    if (!requestedDepartmentId) {
      throw new PackageBillingError(
        "package_department_required",
        "全局管理员操作部门资源时必须指定 departmentId",
        400,
      );
    }
    return requestedDepartmentId;
  }
  if (!scope.departmentId) {
    throw new PackageBillingError("package_scope_forbidden", "管理范围缺少部门", 403);
  }
  if (requestedDepartmentId && requestedDepartmentId !== scope.departmentId) {
    throw new PackageBillingError("package_scope_forbidden", "不能访问其他部门的套餐资源", 403);
  }
  return scope.departmentId;
}

export function assertCanCreatePackageDefinition(
  scope: AdminScope,
  ownerScopeType: PackageOwnerScopeType,
  ownerDepartmentId?: string,
) {
  if (ownerScopeType === "global") {
    if (scope.scopeType !== "global") {
      throw new PackageBillingError(
        "global_package_forbidden",
        "部门主管不能创建全局套餐",
        403,
      );
    }
    return undefined;
  }
  return packageScopeDepartment(scope, ownerDepartmentId);
}

export function assertPackageDefinitionInScope(
  scope: AdminScope,
  definition: Pick<BillingPackageDefinition, "ownerScopeType" | "ownerDepartmentId">,
) {
  if (scope.scopeType === "global") return;
  if (
    definition.ownerScopeType !== "department" ||
    !scope.departmentId ||
    definition.ownerDepartmentId !== scope.departmentId
  ) {
    throw new PackageBillingError("package_scope_forbidden", "套餐不在当前管理范围内", 403);
  }
}

export function assertCanConfigureDepartmentBudget(scope: AdminScope) {
  if (scope.scopeType !== "global") {
    throw new PackageBillingError(
      "department_budget_forbidden",
      "部门总预算只能由全局管理员配置",
      403,
    );
  }
}
