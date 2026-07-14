import assert from "node:assert/strict";
import test from "node:test";
import {
  availableDepartmentBudget,
  canUserRequestRegrant,
  issuablePackageCount,
  packageGrantWindow,
  planGrantAllocations,
  sortAllocatableGrants,
} from "../lib/billing/package-model.ts";
import type { UserPackageGrant } from "../lib/billing/package-types.ts";

function grant(input: Partial<UserPackageGrant> & Pick<UserPackageGrant, "id">): UserPackageGrant {
  return {
    id: input.id,
    userId: "u1",
    departmentIdAtGrant: "d1",
    packageDefinitionId: "pd1",
    packageVersionId: "pv1",
    snapshot: {
      packageCode: "standard",
      packageName: "标准套餐",
      packageDescription: "",
      version: 1,
      grantedQuota: input.grantedQuota ?? 100,
      cycleType: "calendar_month",
      cycleValue: 1,
      timezone: "Asia/Hong_Kong",
      eligibilityPolicy: { allowFirstRequest: true },
      regrantPolicy: { mode: "exhausted" },
    },
    grantedQuota: input.grantedQuota ?? 100,
    allocatedQuota: input.allocatedQuota ?? 0,
    startsAt: input.startsAt ?? "2026-07-01T00:00:00.000Z",
    expiresAt: input.expiresAt ?? "2026-08-01T00:00:00.000Z",
    status: input.status ?? "active",
    sourceRequestId: `request-${input.id}`,
    budgetCommitmentId: `commitment-${input.id}`,
    createdByUserId: "admin",
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

test("package cycles use Hong Kong natural month and quarter boundaries", () => {
  assert.deepEqual(
    packageGrantWindow({
      cycleType: "calendar_month",
      cycleValue: 1,
      startsAt: "2026-01-31T18:00:00.000Z",
    }),
    {
      startsAt: "2026-01-31T18:00:00.000Z",
      expiresAt: "2026-02-28T16:00:00.000Z",
    },
  );
  assert.equal(
    packageGrantWindow({
      cycleType: "calendar_quarter",
      cycleValue: 1,
      startsAt: "2026-05-20T12:00:00.000Z",
    }).expiresAt,
    "2026-06-30T16:00:00.000Z",
  );
});

test("fixed-day cycles preserve exact elapsed duration across leap day", () => {
  assert.equal(
    packageGrantWindow({
      cycleType: "fixed_days",
      cycleValue: 2,
      startsAt: "2028-02-28T10:00:00.000Z",
    }).expiresAt,
    "2028-03-01T10:00:00.000Z",
  );
});

test("multi-grant allocation is expiry-first and exactly covers authoritative quota", () => {
  const grants = [
    grant({ id: "late", expiresAt: "2026-09-01T00:00:00.000Z" }),
    grant({ id: "early-b", expiresAt: "2026-08-01T00:00:00.000Z", startsAt: "2026-07-02T00:00:00.000Z" }),
    grant({ id: "early-a", expiresAt: "2026-08-01T00:00:00.000Z", startsAt: "2026-07-01T00:00:00.000Z", allocatedQuota: 70 }),
  ];
  assert.deepEqual(sortAllocatableGrants(grants).map((item) => item.id), ["early-a", "early-b", "late"]);
  assert.deepEqual(planGrantAllocations(grants, 160), [
    { grantId: "early-a", quota: 30 },
    { grantId: "early-b", quota: 100 },
    { grantId: "late", quota: 30 },
  ]);
});

test("allocation refuses usage that cannot be covered by frozen grants", () => {
  assert.throws(
    () => planGrantAllocations([grant({ id: "g1", grantedQuota: 10 })], 11),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "insufficient_package_quota",
  );
});

test("department budget enforces K plus P and derives per-package issuable count", () => {
  const budget = {
    budgetQuota: 1000,
    committedQuota: 550,
    pendingQuota: 150,
  };
  assert.equal(availableDepartmentBudget(budget), 300);
  assert.equal(issuablePackageCount(budget, { grantedQuota: 128 }), 2);
  assert.throws(() => availableDepartmentBudget({ ...budget, pendingQuota: 451 }));
});

test("regrant policies use remaining quota without mutating grant history", () => {
  const current = grant({ id: "g1", grantedQuota: 100, allocatedQuota: 80 });
  assert.equal(canUserRequestRegrant({ grant: current, policy: { mode: "exhausted" } }), false);
  assert.equal(
    canUserRequestRegrant({
      grant: current,
      policy: { mode: "remaining_ratio", thresholdRatio: 0.2 },
    }),
    true,
  );
  assert.equal(
    canUserRequestRegrant({
      grant: current,
      policy: { mode: "remaining_quota", thresholdQuota: 19 },
    }),
    false,
  );
});
