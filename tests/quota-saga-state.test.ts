import assert from "node:assert/strict";
import test from "node:test";
import {
  assertQuotaOperationTransition,
  canTransitionQuotaOperation,
  quotaOperationRetryResumeState,
} from "../lib/quota-saga-state.ts";

test("quota saga accepts the normal path and rejects reopening completion", () => {
  const path = [
    "planned",
    "local_prepared",
    "admission_closed",
    "draining",
    "snapshot_stable",
    "upstream_applying",
    "upstream_applied",
    "local_finalized",
    "reconciling",
    "completed",
  ] as const;
  for (let index = 1; index < path.length; index += 1) {
    assert.equal(canTransitionQuotaOperation(path[index - 1], path[index]), true);
  }
  assert.throws(
    () => assertQuotaOperationTransition("completed", "planned"),
    /invalid quota operation transition/,
  );
});

test("quota saga resumes the exact durable phase after a retryable failure", () => {
  assert.equal(quotaOperationRetryResumeState("upstream_applying"), "upstream_applying");
  assert.equal(quotaOperationRetryResumeState("local_finalized"), "local_finalized");
  assert.equal(quotaOperationRetryResumeState("completed"), "local_prepared");
});

test("manual review can reopen only through an explicit recovery transition", () => {
  assert.equal(canTransitionQuotaOperation("manual_review", "planned"), true);
  assert.equal(canTransitionQuotaOperation("manual_review", "completed"), false);
});
