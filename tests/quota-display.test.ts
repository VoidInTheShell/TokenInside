import assert from "node:assert/strict";
import test from "node:test";
import {
  formatRawQuota,
  normalizeNewApiQuotaDisplayStatus,
  parseDisplayQuota,
} from "../lib/quota-display-model.ts";

function status(type: "USD" | "CNY" | "CUSTOM" | "TOKENS") {
  return normalizeNewApiQuotaDisplayStatus(
    {
      quota_per_unit: 500_000,
      display_in_currency: type !== "TOKENS",
      quota_display_type: type,
      usd_exchange_rate: 7,
      custom_currency_symbol: "€",
      custom_currency_exchange_rate: 0.9,
    },
    "2026-07-14T00:00:00.000Z",
  );
}

test("quota display matches NewAPI USD CNY and custom formulas", () => {
  assert.equal(formatRawQuota(5_000_000, status("USD")).display.formatted, "$10");
  assert.equal(formatRawQuota(5_000_000, status("CNY")).display.formatted, "¥70");
  assert.equal(formatRawQuota(5_000_000, status("CUSTOM")).display.formatted, "€ 9");
});

test("NewAPI TOKENS display is normalized to unambiguous raw quota", () => {
  const snapshot = status("TOKENS");
  assert.equal(snapshot.displayType, "RAW_QUOTA");
  assert.deepEqual(formatRawQuota(5_000_000, snapshot).display, {
    formatted: "5,000,000 点额度",
    unitLabel: "点额度",
    displayType: "RAW_QUOTA",
    configVersion: snapshot.configVersion,
  });
});

test("display input conversion requires the current exact config version", () => {
  const snapshot = status("CNY");
  assert.equal(
    parseDisplayQuota({ displayValue: 70, configVersion: snapshot.configVersion, snapshot }),
    5_000_000,
  );
  assert.throws(
    () => parseDisplayQuota({ displayValue: 70, configVersion: "old", snapshot }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "quota_display_config_changed",
  );
  assert.throws(() =>
    parseDisplayQuota({
      displayValue: 70,
      configVersion: snapshot.configVersion,
      snapshot: { ...snapshot, sourceStatus: "stale" },
    }),
  );
});
