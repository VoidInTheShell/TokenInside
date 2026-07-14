import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCanConfigureDepartmentBudget,
  assertCanCreatePackageDefinition,
  assertPackageDefinitionInScope,
  packageScopeDepartment,
} from "../lib/package-permissions.ts";
import type { AdminScope } from "../lib/types.ts";

const globalScope: AdminScope = {
  id: "global",
  feishuUserId: "admin",
  scopeType: "global",
  source: "manual",
  status: "active",
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z",
};

const departmentScope: AdminScope = {
  ...globalScope,
  id: "department",
  scopeType: "department",
  departmentId: "d1",
};

test("global administrators can govern any department and budgets", () => {
  assert.equal(packageScopeDepartment(globalScope, "d2"), "d2");
  assert.equal(assertCanCreatePackageDefinition(globalScope, "global"), undefined);
  assert.equal(assertCanConfigureDepartmentBudget(globalScope), undefined);
});

test("department supervisors are pinned to their own department", () => {
  assert.equal(packageScopeDepartment(departmentScope), "d1");
  assert.equal(assertCanCreatePackageDefinition(departmentScope, "department", "d1"), "d1");
  assert.throws(
    () => packageScopeDepartment(departmentScope, "d2"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "package_scope_forbidden",
  );
  assert.throws(() => assertCanCreatePackageDefinition(departmentScope, "global"));
  assert.throws(() => assertCanConfigureDepartmentBudget(departmentScope));
});

test("department supervisors cannot manage global or cross-department definitions", () => {
  assert.throws(() =>
    assertPackageDefinitionInScope(departmentScope, {
      ownerScopeType: "global",
    }),
  );
  assert.throws(() =>
    assertPackageDefinitionInScope(departmentScope, {
      ownerScopeType: "department",
      ownerDepartmentId: "d2",
    }),
  );
  assert.equal(
    assertPackageDefinitionInScope(departmentScope, {
      ownerScopeType: "department",
      ownerDepartmentId: "d1",
    }),
    undefined,
  );
});
