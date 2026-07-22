import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUsageOverview,
  formatPackagePeriod,
  formatOneDecimal,
  formatResetCountdown,
  formatTokensOneDecimal,
  nextHongKongBillingResetAt,
} from "../lib/usage-overview.ts";

test("builds remaining percentage from the monthly quota baseline", () => {
  assert.deepEqual(
    buildUsageOverview({ monthlyQuota: 200, quotaConsumed: 1.728086, remainingQuota: 198.271914 }),
    {
      monthlyQuota: 200,
      quotaConsumed: 1.728086,
      remainingQuota: 198.271914,
      remainingPercent: 99.135957,
    },
  );
});

test("falls back to monthly quota minus consumed quota and clamps percentage", () => {
  assert.equal(
    buildUsageOverview({ monthlyQuota: 100, quotaConsumed: 35 }).remainingPercent,
    65,
  );
  assert.equal(
    buildUsageOverview({ monthlyQuota: 100, quotaConsumed: 0, remainingQuota: 120 })
      .remainingPercent,
    100,
  );
});

test("computes the next Hong Kong month boundary", () => {
  assert.equal(nextHongKongBillingResetAt("2026-07")?.toISOString(), "2026-07-31T16:00:00.000Z");
  assert.equal(nextHongKongBillingResetAt("invalid"), null);
  assert.equal(formatPackagePeriod("2026-07"), "2026年7月套餐周期");
});

test("formats countdown and required one-decimal metrics", () => {
  const resetAt = new Date("2026-07-31T16:00:00.000Z");
  assert.equal(formatResetCountdown(resetAt, Date.parse("2026-07-12T10:00:00.000Z")), "19天 6小时");
  assert.equal(formatOneDecimal(1.728086), "1.7");
  assert.equal(formatTokensOneDecimal(748_000), "748.0K");
});
