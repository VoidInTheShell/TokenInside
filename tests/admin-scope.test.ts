import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSessionAdminScopeProjection,
  tokenRequestInAdminScope,
} from "../lib/admin-scope.ts";
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

function projectedScope(input: {
  scopeType: AdminScope["scopeType"];
  departmentId?: string;
  status?: AdminScope["status"];
  disabledReason?: AdminScope["disabledReason"];
}): AdminScope {
  return {
    id: `projected-${input.scopeType}-${input.departmentId ?? "global"}`,
    feishuUserId: "manager",
    scopeType: input.scopeType,
    departmentId: input.departmentId,
    source: input.scopeType === "global" ? "manual" : "department_supervisor",
    status: input.status ?? "active",
    disabledReason: input.disabledReason,
    createdAt: now,
    updatedAt: now,
  };
}

function resolveProjectedScope(input: {
  projectedUser?: FeishuUser;
  systemAdminOpenIds?: string[];
  activeScope?: AdminScope | null;
  assignedRequest?: TokenRequest | null;
  scopes?: AdminScope[];
}) {
  return resolveSessionAdminScopeProjection({
    user: input.projectedUser ?? users.get("manager")!,
    systemAdminOpenIds: new Set(input.systemAdminOpenIds ?? []),
    activeScope: input.activeScope ?? null,
    assignedRequest: input.assignedRequest ?? null,
    scopes: input.scopes ?? [],
    now,
  });
}

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

test("department administrators cannot approve requests explicitly routed to system administrators", () => {
  const systemAdminRequest = request({
    feishuUserId: "requester-a",
    approvalDepartmentId: "department-a",
    approvalTargetSource: "system_admin_fallback",
    approvalRouteReason: "applicant_is_department_admin",
  });

  assert.equal(
    tokenRequestInAdminScope(systemAdminRequest, departmentScope("department-a"), users),
    false,
  );
  assert.equal(
    tokenRequestInAdminScope(
      systemAdminRequest,
      {
        id: "global",
        feishuUserId: "global-admin",
        scopeType: "global",
        source: "manual",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      users,
    ),
    true,
  );
});

test("department administrators cannot read a system administrator request from their own department", () => {
  const systemAdminRequest = request({
    feishuUserId: "requester-a",
    approvalDepartmentId: "department-a",
  });
  const systemAdminOpenIds = new Set(["open-requester-a"]);

  assert.equal(
    tokenRequestInAdminScope(systemAdminRequest, departmentScope("department-a"), users, systemAdminOpenIds),
    false,
  );
  assert.equal(
    tokenRequestInAdminScope(
      systemAdminRequest,
      { ...departmentScope("department-a"), scopeType: "global", departmentId: undefined },
      users,
      systemAdminOpenIds,
    ),
    true,
  );
});

test("session projection gives environment administrators precedence and rejects inactive users", () => {
  const manager = users.get("manager")!;
  const active = projectedScope({ scopeType: "department", departmentId: "department-a" });
  const environment = resolveProjectedScope({
    systemAdminOpenIds: [manager.openId],
    activeScope: active,
  });

  assert.equal(environment?.scopeType, "global");
  assert.equal(environment?.source, "environment");
  assert.equal(environment?.role, "root");
  assert.equal(
    resolveProjectedScope({
      projectedUser: { ...manager, status: "disabled" },
      systemAdminOpenIds: [manager.openId],
      activeScope: active,
    }),
    null,
  );
});

test("session projection returns an active stored scope before assigned-request fallback", () => {
  const active = projectedScope({ scopeType: "department", departmentId: "department-a" });
  const resolved = resolveProjectedScope({
    activeScope: active,
    assignedRequest: request({ approvalDepartmentId: "department-b" }),
    scopes: [
      projectedScope({
        scopeType: "global",
        status: "disabled",
        disabledReason: "manual_revoke",
      }),
    ],
  });

  assert.equal(resolved, active);
});

test("session projection synthesizes assigned department scope when no revocation blocks it", () => {
  const resolved = resolveProjectedScope({
    assignedRequest: request({ approvalDepartmentId: "department-a" }),
    scopes: [
      projectedScope({
        scopeType: "global",
        status: "disabled",
        disabledReason: "auto_sync_lost",
      }),
      projectedScope({
        scopeType: "department",
        departmentId: "department-b",
        status: "disabled",
        disabledReason: "manual_revoke",
      }),
    ],
  });

  assert.equal(resolved?.scopeType, "department");
  assert.equal(resolved?.departmentId, "department-a");
  assert.equal(resolved?.source, "department_supervisor");
});

test("session projection honors global and matching-department revocation blockers", () => {
  const assignedRequest = request({ approvalDepartmentId: "department-a" });
  for (const disabledReason of [undefined, "manual_revoke", "user_deleted"] as const) {
    assert.equal(
      resolveProjectedScope({
        assignedRequest,
        scopes: [
          projectedScope({
            scopeType: "global",
            status: "disabled",
            disabledReason,
          }),
        ],
      }),
      null,
    );
  }

  assert.equal(
    resolveProjectedScope({
      assignedRequest,
      scopes: [
        projectedScope({
          scopeType: "department",
          departmentId: "department-a",
          status: "disabled",
          disabledReason: "manual_revoke",
        }),
      ],
    }),
    null,
  );
});
