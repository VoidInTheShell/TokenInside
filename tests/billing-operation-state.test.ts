import assert from "node:assert/strict";
import test from "node:test";
import {
  canClaimBillingOperation,
  isTerminalBillingOperationStatus,
  retainBillingOperationRecords,
  sameBillingOperationInput,
} from "../lib/billing-operation-state.ts";

test("billing operations distinguish queued work from terminal audit records", () => {
  assert.equal(isTerminalBillingOperationStatus("pending"), false);
  assert.equal(isTerminalBillingOperationStatus("running"), false);
  assert.equal(isTerminalBillingOperationStatus("continuation_pending"), true);
  assert.equal(isTerminalBillingOperationStatus("dry_run"), true);
  assert.equal(isTerminalBillingOperationStatus("applied"), true);
  assert.equal(isTerminalBillingOperationStatus("partial_failed"), true);
  assert.equal(isTerminalBillingOperationStatus("failed"), true);
});

test("billing operation claim allows queued and expired work but protects an active lease", () => {
  const now = new Date("2026-07-16T08:00:00.000Z");
  assert.equal(canClaimBillingOperation({ status: "pending" }, now), true);
  assert.equal(
    canClaimBillingOperation(
      { status: "running", leaseExpiresAt: "2026-07-16T08:01:00.000Z" },
      now,
    ),
    false,
  );
  assert.equal(
    canClaimBillingOperation(
      { status: "running", leaseExpiresAt: "2026-07-16T07:59:59.000Z" },
      now,
    ),
    true,
  );
  assert.equal(canClaimBillingOperation({ status: "applied" }, now), false);
});

test("history retention never evicts pending or running durable operations", () => {
  const now = "2026-07-16T00:00:00.000Z";
  const active = ["pending", "running"].map((status, index) => ({
    id: `active-${index}`,
    kind: "usage_sync" as const,
    status: status as "pending" | "running",
    dryRun: false,
    operatedByFeishuUserId: "fu_admin",
    summary: {},
    createdAt: now,
    updatedAt: now,
  }));
  const terminal = Array.from({ length: 60 }, (_, index) => ({
    id: `terminal-${index}`,
    kind: "usage_sync" as const,
    status: "applied" as const,
    dryRun: false,
    operatedByFeishuUserId: "fu_admin",
    summary: {},
    createdAt: now,
    updatedAt: now,
  }));

  const retained = retainBillingOperationRecords([...active, ...terminal], 50);
  assert.deepEqual(retained.slice(0, 2).map((item) => item.id), ["active-0", "active-1"]);
  assert.equal(retained.length, 50);
  assert.equal(retained.filter((item) => item.status === "applied").length, 48);
});

test("operation input deduplication survives PostgreSQL JSONB key reordering", () => {
  assert.equal(
    sameBillingOperationInput(
      { dryRun: true, page: 0, nested: { size: 1, maxPages: 2 } },
      { nested: { maxPages: 2, size: 1 }, page: 0, dryRun: true },
    ),
    true,
  );
  assert.equal(
    sameBillingOperationInput(
      { dryRun: true, page: undefined },
      { dryRun: true },
    ),
    true,
  );
  assert.equal(
    sameBillingOperationInput({ dryRun: true, size: 1 }, { dryRun: true, size: 2 }),
    false,
  );
});
