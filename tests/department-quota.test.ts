import assert from "node:assert/strict";
import test from "node:test";
import {
  pendingApprovalRouteNotice,
  summarizeDepartmentQuota,
  validateDepartmentAllocation,
  validateDepartmentQuotaLimit,
} from "../lib/department-quota.ts";
import type { DepartmentQuotaPeriod, QuotaChangeEvent } from "../lib/types.ts";

const now = new Date("2026-07-11T10:00:00.000Z");

function policy(quotaLimit = 1_000): DepartmentQuotaPeriod {
  return {
    id: "department-period-1",
    departmentId: "department-a",
    period: "2026-07",
    quotaLimit,
    defaultGrantQuota: 200,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function reservation(input: Partial<QuotaChangeEvent> = {}): QuotaChangeEvent {
  return {
    id: "quota-event-1",
    departmentId: "department-a",
    period: "2026-07",
    feishuUserId: "user-a",
    operatedByFeishuUserId: "manager-a",
    kind: "user_quota_allocate",
    status: "pending",
    previousValue: 100,
    nextValue: 250,
    delta: 150,
    expiresAt: "2026-07-11T10:20:00.000Z",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...input,
  };
}

test("department availability subtracts assigned quota and live positive reservations", () => {
  assert.deepEqual(
    summarizeDepartmentQuota({
      policy: policy(),
      allocatedQuota: 600,
      events: [
        reservation(),
        reservation({ id: "expired", delta: 80, expiresAt: "2026-07-11T09:59:59.000Z" }),
        reservation({ id: "decrease", delta: -40, nextValue: 60 }),
        reservation({ id: "failed", delta: 90, status: "failed" }),
      ],
      now,
    }),
    {
      quotaLimit: 1_000,
      allocatedQuota: 600,
      pendingReservedQuota: 150,
      availableQuota: 250,
    },
  );
});

test("member allocation validates only the additional department budget", () => {
  assert.equal(
    validateDepartmentAllocation({ nextQuota: 350, previousQuota: 200, availableQuota: 150 }),
    null,
  );
  assert.match(
    validateDepartmentAllocation({ nextQuota: 351, previousQuota: 200, availableQuota: 150 }) ?? "",
    /部门可用额度不足/,
  );
  assert.equal(
    validateDepartmentAllocation({ nextQuota: 100, previousQuota: 200, availableQuota: 0 }),
    null,
  );
});

test("department limit cannot be lower than assignments already made", () => {
  assert.equal(validateDepartmentQuotaLimit(600, 600), null);
  assert.match(validateDepartmentQuotaLimit(599, 600) ?? "", /不能低于当前已分配额度/);
});

test("system-admin routing notice is shown only while approval routing is active", () => {
  assert.equal(
    pendingApprovalRouteNotice(
      {
        status: "pending_card_approval",
        approvalTargetSource: "system_admin_fallback",
        approvalRouteReason: "applicant_is_department_admin",
      },
      true,
    ),
    "您的个人提额请求将发送给系统管理员审批。",
  );
  assert.equal(
    pendingApprovalRouteNotice(
      {
        status: "provisioned",
        approvalTargetSource: "system_admin_fallback",
        approvalRouteReason: "applicant_is_department_admin",
      },
      true,
    ),
    null,
  );
  assert.equal(
    pendingApprovalRouteNotice(
      {
        status: "pending_card_approval",
        approvalTargetSource: "system_admin_fallback",
        approvalRouteReason: "no_department",
        approvalRouteNotice: "您当前不属于任何组织，请求将发送给系统管理员，请联系系统管理员审批",
      },
      false,
    ),
    "您当前不属于任何组织，请求将发送给系统管理员，请联系系统管理员审批",
  );
});
