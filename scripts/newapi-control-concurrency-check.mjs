import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const baseUrl = process.env.NEWAPI_BASE_URL?.replace(/\/+$/, "");
const credential =
  process.env.NEWAPI_ACCESS_TOKEN ||
  process.env.NEWAPI_ADMIN_ACCESS_TOKEN ||
  process.env.NEWAPI_SYSTEM_AK;
const controlUserId = process.env.NEWAPI_CONTROL_USER_ID;
const concurrency = Number(process.env.NEWAPI_CONTROL_LOAD_CONCURRENCY ?? "60");
const timeoutMs = Number(process.env.NEWAPI_CONTROL_LOAD_TIMEOUT_MS ?? "15000");

if (!baseUrl) throw new Error("NEWAPI_BASE_URL is required");
if (!credential) throw new Error("A NewAPI control credential is required");
if (!controlUserId) throw new Error("NEWAPI_CONTROL_USER_ID is required");
if (!Number.isInteger(concurrency) || concurrency < 2 || concurrency > 100) {
  throw new Error("NEWAPI_CONTROL_LOAD_CONCURRENCY must be between 2 and 100");
}

const prefix = `tictrl-${Date.now().toString(36).slice(-6)}-${randomUUID().slice(0, 5)}`;

function headers() {
  return {
    "content-type": "application/json; charset=utf-8",
    authorization: credential,
    "New-Api-User": controlUserId,
    "LLMAPI-User": controlUserId,
  };
}

async function request(path, init = {}) {
  const startedAt = performance.now();
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...headers(), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = {};
      }
    }
    return {
      ok: response.ok && body.success !== false,
      status: response.status,
      body: body.data ?? body,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: {},
      durationMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.name : "UnknownError",
    };
  }
}

function percentile(values, value) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((value / 100) * sorted.length) - 1)];
}

function summarize(results, wallMs) {
  const statusCounts = Object.fromEntries(
    [...new Set(results.map((item) => item.status))]
      .sort((a, b) => a - b)
      .map((status) => [String(status), results.filter((item) => item.status === status).length]),
  );
  const durations = results.map((item) => item.durationMs);
  return {
    requests: results.length,
    succeeded: results.filter((item) => item.ok).length,
    wallMs,
    throughputRps: Number(((results.length * 1000) / Math.max(wallMs, 1)).toFixed(2)),
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    maxMs: Math.max(...durations, 0),
    statusCounts,
  };
}

async function searchCreatedTokens() {
  const items = [];
  for (let page = 1; page <= 5; page += 1) {
    const params = new URLSearchParams({
      keyword: `${prefix}%`,
      p: String(page),
      size: "20",
    });
    const result = await request(`/api/token/search?${params.toString()}`);
    if (!result.ok) throw new Error(`NewAPI token search failed with HTTP ${result.status}`);
    const pageItems = result.body.items ?? [];
    items.push(...pageItems);
    if (pageItems.length === 0 || items.length >= Number(result.body.total ?? items.length)) break;
  }
  return items;
}

async function batchDelete(ids) {
  if (ids.length === 0) return;
  const result = await request("/api/token/batch", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
  if (!result.ok) throw new Error(`NewAPI batch cleanup failed with HTTP ${result.status}`);
}

let tokenIds = [];
let createSummary;
let deleteSummary;
try {
  const names = Array.from(
    { length: concurrency },
    (_, index) => `${prefix}-${String(index).padStart(3, "0")}`,
  );
  const createStartedAt = performance.now();
  const createResults = await Promise.all(
    names.map((name) =>
      request("/api/token", {
        method: "POST",
        body: JSON.stringify({
          name,
          remain_quota: 1,
          unlimited_quota: false,
          expired_time: -1,
        }),
      }),
    ),
  );
  createSummary = summarize(createResults, Math.round(performance.now() - createStartedAt));

  const created = await searchCreatedTokens();
  const byName = new Map(created.map((item) => [item.name, item]));
  tokenIds = names.map((name) => Number(byName.get(name)?.id)).filter(Number.isInteger);

  if (tokenIds.length > 0) {
    const keyResult = await request("/api/token/batch/keys", {
      method: "POST",
      body: JSON.stringify({ ids: tokenIds }),
    });
    assert.equal(keyResult.ok, true, "NewAPI batch key read failed");
    assert.equal(Object.keys(keyResult.body.keys ?? {}).length, tokenIds.length);
  }

  const deleteStartedAt = performance.now();
  const deleteResults = await Promise.all(
    tokenIds.map((id) => request(`/api/token/${id}`, { method: "DELETE" })),
  );
  deleteSummary = summarize(deleteResults, Math.round(performance.now() - deleteStartedAt));
  tokenIds = tokenIds.filter((_, index) => !deleteResults[index]?.ok);

  assert.equal(createSummary.succeeded, concurrency);
  assert.equal(deleteSummary.succeeded, concurrency);
} finally {
  await batchDelete(tokenIds);
}

console.log(
  JSON.stringify({
    ok: true,
    upstream: new URL(baseUrl).host,
    concurrency,
    create: createSummary,
    delete: deleteSummary,
    fixturesCleaned: true,
  }),
);
