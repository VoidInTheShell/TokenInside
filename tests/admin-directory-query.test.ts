import assert from "node:assert/strict";
import test from "node:test";
import { queryAdminDirectory } from "../lib/admin-directory-query.ts";

const rows = [
  {
    id: "u1",
    name: "Alice",
    openId: "ou_alice",
    departmentId: "engineering",
    departmentName: "研发部",
    status: "active",
    role: "普通用户",
    packageQuota: 200,
    remainingQuota: 120,
    quotaConsumed: 80,
    totalTokens: 8_000,
    requestCount: 8,
    latestActivityAt: "2026-07-22T08:00:00.000Z",
  },
  {
    id: "u2",
    name: "Bob",
    openId: "ou_bob",
    departmentId: "sales",
    departmentName: "销售部",
    status: "disabled",
    role: "普通用户",
    packageQuota: 100,
    remainingQuota: 75,
    quotaConsumed: 25,
    totalTokens: 2_500,
    requestCount: 3,
    latestActivityAt: "2026-07-20T08:00:00.000Z",
  },
  {
    id: "u3",
    name: "Carol",
    openId: "ou_carol",
    departmentId: "engineering",
    departmentName: "研发部",
    status: "active",
    role: "部门管理员",
    packageQuota: 300,
    remainingQuota: 250,
    quotaConsumed: 50,
    totalTokens: 5_000,
    requestCount: 5,
    latestActivityAt: "2026-07-21T08:00:00.000Z",
  },
];

test("admin directory combines search, department, status, and role filters", () => {
  const result = queryAdminDirectory({
    rows,
    query: {
      search: "carol",
      departmentId: "engineering",
      status: "active",
      role: "部门管理员",
    },
    defaultSortBy: "latestActivity",
  });
  assert.deepEqual(result.rows.map((row) => row.id), ["u3"]);
  assert.equal(result.total, 1);
});

test("admin directory sorts numeric fields and paginates after filtering", () => {
  const first = queryAdminDirectory({
    rows,
    query: { sortBy: "packageQuota", sortOrder: "desc", limit: 2 },
    defaultSortBy: "latestActivity",
  });
  assert.deepEqual(first.rows.map((row) => row.id), ["u3", "u1"]);
  assert.equal(first.total, 3);
  const second = queryAdminDirectory({
    rows,
    query: { sortBy: "requestCount", sortOrder: "asc", limit: 1, offset: 1 },
    defaultSortBy: "latestActivity",
  });
  assert.deepEqual(second.rows.map((row) => row.id), ["u3"]);
  assert.deepEqual(
    { total: second.total, limit: second.limit, offset: second.offset },
    { total: 3, limit: 1, offset: 1 },
  );
});
