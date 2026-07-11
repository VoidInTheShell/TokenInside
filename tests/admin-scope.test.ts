import assert from "node:assert/strict";
import test from "node:test";
import { tokenRequestInAdminScope } from "../lib/admin-scope.ts";
import type { AdminScope, FeishuUser, TokenRequest } from "../lib/types.ts";

const now = "2026-07-11T00:00:00.000Z";

function user(id: string, departmentId?: string): FeishuUser {
  return {
    id,
    tenantKey: "tenant",
    openId: `open-${id}`,
    departmentId,
    createdAt: now,
    updatedAt: now,
  };
}

function request(input: Partial<TokenRequest> = {}): TokenRequest {
  return {
    id: "request-1",
    feishuUserId: "requester-a",
    requestType: "first_apply",
    status: "pending_card_approval",
    reason: "test",
    requestedMonthlyQuota: 200,
    approvalUuid: "approval-1",
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

function departmentScope(departmentId: string): AdminScope {
  return {
    id: `scope-${departmentId}`,
    feishuUserId: "manager",
    scopeType: "department",
    departmentId,
    source: "department_supervisor",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

const users = new Map<string, FeishuUser>([
  ["manager", user("manager", "department-a")],
  ["requester-a", user("requester-a", "department-a")],
  ["requester-b", user("requester-b", "department-b")],
]);

test("department administrators cannot use approver assignment to cross department boundaries", () => {
  const crossDepartment = request({
    feishuUserId: "requester-b",
    approvalDepartmentId: "department-b",
    approvalTargetOpenId: "open-manager",
  });

  assert.equal(tokenRequestInAdminScope(crossDepartment, departmentScope("department-a"), users), false);
  assert.equal(tokenRequestInAdminScope(crossDepartment, departmentScope("department-b"), users), true);
});

test("the request department snapshot wins over a requester's current department", () => {
  const movedRequester = request({
    feishuUserId: "requester-b",
    approvalDepartmentId: "department-a",
  });

  assert.equal(tokenRequestInAdminScope(movedRequester, departmentScope("department-a"), users), true);
  assert.equal(tokenRequestInAdminScope(movedRequester, departmentScope("department-b"), users), false);
});

test("legacy requests fall back to the requester department and unscoped requests stay hidden", () => {
  assert.equal(
    tokenRequestInAdminScope(request({ feishuUserId: "requester-a" }), departmentScope("department-a"), users),
    true,
  );
  assert.equal(
    tokenRequestInAdminScope(request({ feishuUserId: "missing-user" }), departmentScope("department-a"), users),
    false,
  );
});

test("global administrators retain access to every request", () => {
  const scope: AdminScope = {
    ...departmentScope("department-a"),
    scopeType: "global",
    departmentId: undefined,
    source: "manual",
  };
  assert.equal(tokenRequestInAdminScope(request({ feishuUserId: "missing-user" }), scope, users), true);
});
