import assert from "node:assert/strict";
import test from "node:test";
import { findActiveTokenPrincipalCached } from "../lib/proxy-principal-cache.ts";
import type { FeishuUser, TokenAccount } from "../lib/types.ts";

test("coalesces concurrent PostgreSQL fallbacks for the same uncached key", async () => {
  const previousRedisUrl = process.env.TOKENINSIDE_REDIS_URL;
  delete process.env.TOKENINSIDE_REDIS_URL;
  const keyHash = `test-cache-${Date.now()}`;
  const user = {
    id: "fu_cache_test",
    tenantKey: "tenant",
    openId: "open",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } satisfies FeishuUser;
  const tokenAccount = {
    id: "ta_cache_test",
    feishuUserId: user.id,
    sourceRequestId: "request",
    keyHash,
    status: "active",
    billingPeriod: "package",
    createdAt: new Date().toISOString(),
  } satisfies TokenAccount;
  let lookups = 0;
  const loader = async () => {
    lookups += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { tokenAccount, user };
  };
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => findActiveTokenPrincipalCached(keyHash, loader)),
    );
    assert.equal(lookups, 1);
    assert.ok(results.every((principal) => principal?.user.id === user.id));
  } finally {
    if (previousRedisUrl === undefined) delete process.env.TOKENINSIDE_REDIS_URL;
    else process.env.TOKENINSIDE_REDIS_URL = previousRedisUrl;
  }
});
