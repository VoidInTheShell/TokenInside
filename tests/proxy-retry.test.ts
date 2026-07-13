import assert from "node:assert/strict";
import test from "node:test";
import { fetchUpstreamWithRetry } from "../lib/proxy-retry.ts";

const zeroDelay = { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 };

test("upstream retry succeeds before any response reaches the client", async () => {
  const statuses = [503, 200];
  const result = await fetchUpstreamWithRetry(
    async () => new Response("test", { status: statuses.shift() }),
    zeroDelay,
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.attempts, 2);
});

test("upstream retry returns the final structured HTTP failure source", async () => {
  const result = await fetchUpstreamWithRetry(
    async () => new Response("busy", { status: 503 }),
    zeroDelay,
  );
  assert.equal(result.response.status, 503);
  assert.equal(result.attempts, 2);
});

test("upstream retry never retries a non-retryable client error", async () => {
  let calls = 0;
  const result = await fetchUpstreamWithRetry(async () => {
    calls += 1;
    return new Response("bad request", { status: 400 });
  }, zeroDelay);
  assert.equal(result.response.status, 400);
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1);
});
