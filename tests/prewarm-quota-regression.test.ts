import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("prewarmed inventory is excluded from billing materialization", async () => {
  const source = await readFile(new URL("../lib/store.ts", import.meta.url), "utf8");
  assert.match(source, /A prewarmed account is inventory, not an issued entitlement/);
  assert.match(source, /account\.tokenRequestId\.startsWith\("prewarm:"\)/);
});
