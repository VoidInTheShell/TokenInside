import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPackageResetExecutionAllowed,
  latestDuePackageReset,
  nextPackagePeriod,
  nextPackageResetAt,
  normalizePackageResetPolicy,
  PACKAGE_RESET_TIME_ZONE,
  packagePeriod,
} from "../lib/package-reset.ts";

test("package reset policy defaults to enabled day one in Asia/Shanghai", () => {
  assert.equal(PACKAGE_RESET_TIME_ZONE, "Asia/Shanghai");
  assert.deepEqual(normalizePackageResetPolicy(), {
    enabled: true,
    dayOfMonth: 1,
    updatedAt: undefined,
    updatedByFeishuUserId: undefined,
  });
  assert.equal(normalizePackageResetPolicy({ enabled: true, dayOfMonth: 99 }).dayOfMonth, 31);
  assert.equal(normalizePackageResetPolicy({ enabled: true, dayOfMonth: -5 }).dayOfMonth, 1);
});

test("disabled package reset preserves the Shanghai calendar month", () => {
  assert.equal(
    packagePeriod(
      { enabled: false, dayOfMonth: 15 },
      new Date("2026-07-31T15:59:59.999Z"),
    ),
    "2026-07",
  );
  assert.equal(
    packagePeriod(
      { enabled: false, dayOfMonth: 15 },
      new Date("2026-07-31T16:00:00.000Z"),
    ),
    "2026-08",
  );
});

test("a mid-month reset changes periods exactly at Shanghai midnight", () => {
  const policy = { enabled: true, dayOfMonth: 15 };
  const before = new Date("2026-07-14T15:59:59.999Z");
  const atReset = new Date("2026-07-14T16:00:00.000Z");

  assert.equal(packagePeriod(policy, before), "2026-07");
  assert.equal(packagePeriod(policy, atReset), "2026-08");
  assert.deepEqual(latestDuePackageReset(policy, atReset), {
    period: "2026-08",
    scheduledAt: "2026-07-14T16:00:00.000Z",
  });
  assert.equal(
    nextPackageResetAt(policy, atReset)?.toISOString(),
    "2026-08-14T16:00:00.000Z",
  );
});

test("next package quota is stored against the period opened by the next reset", () => {
  assert.equal(
    nextPackagePeriod(
      { enabled: true, dayOfMonth: 15 },
      new Date("2026-07-20T00:00:00.000Z"),
    ),
    "2026-09",
  );
  assert.equal(
    nextPackagePeriod(
      { enabled: false, dayOfMonth: 1 },
      new Date("2026-07-20T00:00:00.000Z"),
    ),
    "2026-08",
  );
});

test("custom reset periods do not collide with calendar-month provision markers", () => {
  const reset = latestDuePackageReset(
    { enabled: true, dayOfMonth: 15 },
    new Date("2026-07-20T00:00:00.000Z"),
  );
  assert.equal(reset?.period, "2026-08");
  assert.notEqual(reset?.period, "2026-07");
});

test("day 31 clamps to the final Shanghai day in short months", () => {
  const policy = { enabled: true, dayOfMonth: 31 };
  const beforeFebruaryReset = new Date("2027-02-27T15:59:59.999Z");
  const atFebruaryReset = new Date("2027-02-27T16:00:00.000Z");

  assert.equal(packagePeriod(policy, beforeFebruaryReset), "2027-02");
  assert.deepEqual(latestDuePackageReset(policy, atFebruaryReset), {
    period: "2027-03",
    scheduledAt: "2027-02-27T16:00:00.000Z",
  });
  assert.equal(
    nextPackageResetAt(policy, atFebruaryReset)?.toISOString(),
    "2027-03-30T16:00:00.000Z",
  );
});

test("the configured administrator reset day drives the authoritative next reset", () => {
  const now = new Date("2026-07-20T00:00:00.000Z");
  const expected = new Map([
    [1, "2026-07-31T16:00:00.000Z"],
    [15, "2026-08-14T16:00:00.000Z"],
    [29, "2026-07-28T16:00:00.000Z"],
    [30, "2026-07-29T16:00:00.000Z"],
    [31, "2026-07-30T16:00:00.000Z"],
  ]);
  for (const [dayOfMonth, nextResetAt] of expected) {
    assert.equal(
      nextPackageResetAt({ enabled: true, dayOfMonth }, now)?.toISOString(),
      nextResetAt,
    );
  }
});

test("days 29 and 30 clamp to the final Shanghai day in February", () => {
  assert.equal(
    nextPackageResetAt(
      { enabled: true, dayOfMonth: 29 },
      new Date("2028-02-01T00:00:00.000Z"),
    )?.toISOString(),
    "2028-02-28T16:00:00.000Z",
  );
  assert.equal(
    nextPackageResetAt(
      { enabled: true, dayOfMonth: 30 },
      new Date("2027-02-01T00:00:00.000Z"),
    )?.toISOString(),
    "2027-02-27T16:00:00.000Z",
  );
});

test("day one retains calendar-month identifiers", () => {
  const policy = { enabled: true, dayOfMonth: 1 };
  assert.deepEqual(
    latestDuePackageReset(policy, new Date("2026-07-01T00:00:00.000Z")),
    {
      period: "2026-07",
      scheduledAt: "2026-06-30T16:00:00.000Z",
    },
  );
  assert.equal(
    packagePeriod(policy, new Date("2026-07-31T15:59:59.999Z")),
    "2026-07",
  );
});

test("automatic execution rejects disabled or stale settings", () => {
  assert.throws(
    () =>
      assertPackageResetExecutionAllowed({
        policy: { enabled: false, dayOfMonth: 15 },
        period: "2026-08",
        now: new Date("2026-07-20T00:00:00.000Z"),
      }),
    /已关闭/,
  );
  assert.throws(
    () =>
      assertPackageResetExecutionAllowed({
        policy: { enabled: true, dayOfMonth: 15 },
        period: "2026-07",
        now: new Date("2026-07-20T00:00:00.000Z"),
      }),
    /当前应执行套餐周期为 2026-08/,
  );
});
