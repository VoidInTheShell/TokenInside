import assert from "node:assert/strict";
import test from "node:test";
import { calculateOutputTokensPerSecond } from "../lib/usage-rate.ts";
import { formatQuotaAmount } from "../lib/utils.ts";

test("non-stream TPS uses end-to-end duration instead of JSON body read time", () => {
  const rate = calculateOutputTokensPerSecond({
    completionTokens: 5,
    durationMs: 4_649,
    firstByteMs: 4_648,
    isStream: false,
  });
  assert.ok(rate);
  assert.equal(rate.toFixed(1), "1.1");
});

test("synced TPS prefers NewAPI use_time for stream and non-stream records", () => {
  const rate = calculateOutputTokensPerSecond({
    completionTokens: 5,
    durationMs: 4_649,
    firstByteMs: 4_648,
    newapiUseTimeSeconds: 3,
    isStream: false,
  });
  assert.ok(rate);
  assert.equal(rate.toFixed(1), "1.7");
});

test("short buffered stream windows fall back to total duration", () => {
  const rate = calculateOutputTokensPerSecond({
    completionTokens: 7,
    durationMs: 6_441,
    firstByteMs: 6_376,
    isStream: true,
  });
  assert.ok(rate);
  assert.equal(rate.toFixed(1), "1.1");
});

test("small quota values retain meaningful precision", () => {
  assert.equal(formatQuotaAmount(0.000018, "0"), "0.000018");
  assert.equal(formatQuotaAmount(0.000132, "0"), "0.000132");
  assert.equal(formatQuotaAmount(199.99984, "0"), "199.99984");
});
