import assert from "node:assert/strict";
import test from "node:test";
import {
  isAtOrAfterIsoTimestamp,
  normalizeOptionalIsoTimestamp,
} from "../lib/iso-time.ts";

test("normalizes an optional approval-window timestamp", () => {
  assert.equal(normalizeOptionalIsoTimestamp(null), undefined);
  assert.equal(normalizeOptionalIsoTimestamp("not-a-date"), null);
  assert.equal(
    normalizeOptionalIsoTimestamp("2026-07-10T08:00:00+08:00"),
    "2026-07-10T00:00:00.000Z",
  );
});

test("keeps only requests created at or after the approval-window boundary", () => {
  const lowerBound = "2026-07-10T00:00:00.000Z";

  assert.equal(isAtOrAfterIsoTimestamp("2026-07-09T23:59:59.999Z", lowerBound), false);
  assert.equal(isAtOrAfterIsoTimestamp(lowerBound, lowerBound), true);
  assert.equal(isAtOrAfterIsoTimestamp("2026-07-10T00:00:00.001Z", lowerBound), true);
  assert.equal(isAtOrAfterIsoTimestamp("2020-01-01T00:00:00.000Z"), true);
});
