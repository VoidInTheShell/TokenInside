import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("prewarmed inventory is excluded from billing materialization", async () => {
  const source = await readFile(new URL("../lib/store.ts", import.meta.url), "utf8");
  assert.match(source, /A prewarmed account is inventory, not an issued entitlement/);
  assert.match(source, /account\.tokenRequestId\.startsWith\("prewarm:"\)/);
  assert.match(source, /billing\.monthlyQuota = 0/);
});

test("migration repairs only prewarm-only billing periods", async () => {
  const source = await readFile(
    new URL("../scripts/migrations/20260717_005_zero_prewarm_only_billing_periods.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /account\.status = 'pending_activation'/);
  assert.match(source, /account\.token_request_id like 'prewarm:%'/);
  assert.match(source, /request\.status = 'provisioned'/);
  assert.match(source, /ledger\.signed_quota <> 0/);
});
