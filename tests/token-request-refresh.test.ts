import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  TOKEN_REQUEST_REFRESH_INTERVAL_MS,
  tokenRequestsNeedAutoRefresh,
} from "../lib/token-request-refresh.ts";

test("auto refresh stays active while a package request can still progress", () => {
  for (const status of [
    "pending_card_send",
    "pending_card_approval",
    "pending_feishu_approval",
    "approved",
    "approved_provisioning",
  ]) {
    assert.equal(tokenRequestsNeedAutoRefresh([{ status }]), true, status);
  }
  assert.equal(TOKEN_REQUEST_REFRESH_INTERVAL_MS, 1000);
});

test("auto refresh stops for terminal or failed package requests", () => {
  for (const status of [
    "provisioned",
    "rejected",
    "cancelled",
    "invalidated",
    "approval_card_send_failed",
    "approval_route_failed",
    "approved_provision_failed",
  ]) {
    assert.equal(tokenRequestsNeedAutoRefresh([{ status }]), false, status);
  }
});

test("package application UI omits the fixed quota and legacy Token wording", async () => {
  const source = await readFile(
    new URL("../components/experience-client.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /<CardTitle>申请套餐<\/CardTitle>/);
  assert.match(source, />\s*申请套餐\s*<\/Button>/);
  assert.doesNotMatch(source, /默认申请额度/);
  assert.doesNotMatch(source, /申请 Token/);
  assert.doesNotMatch(source, /确认默认申请额度后即可提交/);
});
