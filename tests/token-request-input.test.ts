import assert from "node:assert/strict";
import test from "node:test";
import { tokenRequestSchema } from "../lib/token-request-input.ts";

test("accepts a missing or blank token request reason", () => {
  assert.equal(tokenRequestSchema.parse({}).reason, undefined);
  assert.equal(tokenRequestSchema.parse({ reason: "" }).reason, "");
  assert.equal(tokenRequestSchema.parse({ reason: "   " }).reason, "");
});

test("trims an optional token request reason and enforces its length limit", () => {
  assert.equal(tokenRequestSchema.parse({ reason: "  自动化测试  " }).reason, "自动化测试");
  assert.throws(() => tokenRequestSchema.parse({ reason: "a".repeat(501) }));
});
