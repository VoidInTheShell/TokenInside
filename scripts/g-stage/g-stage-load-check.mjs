import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
const newApiBaseUrl = process.env.NEWAPI_BASE_URL?.replace(/\/+$/, "");
const controlCredential = process.env.NEWAPI_ACCESS_TOKEN || process.env.NEWAPI_ADMIN_ACCESS_TOKEN || process.env.NEWAPI_SYSTEM_AK;
const controlUserId = process.env.NEWAPI_CONTROL_USER_ID;
const targetUrl = (process.env.TOKENINSIDE_LOAD_TARGET_URL ?? "http://127.0.0.1:16879").replace(/\/+$/, "");
const requestCount = Number(process.env.TOKENINSIDE_LOAD_REQUESTS ?? "4");
const userCount = Number(process.env.TOKENINSIDE_LOAD_USERS ?? String(Math.min(requestCount, 120)));
const clientConcurrency = Number(process.env.TOKENINSIDE_LOAD_CLIENT_CONCURRENCY ?? String(requestCount));
let model = process.env.TOKENINSIDE_LOAD_MODEL?.trim();
let modelProbeSummary = [];
const streamMode = process.env.TOKENINSIDE_LOAD_STREAM_MODE ?? "mixed";
const setupConcurrency = Number(process.env.TOKENINSIDE_LOAD_SETUP_CONCURRENCY ?? "3");
const prewarmConcurrency = Number(process.env.TOKENINSIDE_LOAD_PREWARM_CONCURRENCY ?? "20");
const requestTimeoutMs = Number(process.env.TOKENINSIDE_LOAD_REQUEST_TIMEOUT_MS ?? "90000");
const settlementTimeoutMs = Number(process.env.TOKENINSIDE_LOAD_SETTLEMENT_TIMEOUT_MS ?? "180000");
const grantQuota = Number(process.env.TOKENINSIDE_LOAD_GRANT_QUOTA ?? "5000000");
const expectedTokensPerRequest = Number(process.env.TOKENINSIDE_LOAD_EXPECT_TOKENS_PER_REQUEST ?? "0");
const expectedQuotaPerRequest = Number(process.env.TOKENINSIDE_LOAD_EXPECT_QUOTA_PER_REQUEST ?? "0");
const maxStreamTtftMs = Number(process.env.TOKENINSIDE_LOAD_MAX_STREAM_TTFT_MS ?? "0");
const absoluteMaxStreamTtftMs = Number(process.env.TOKENINSIDE_LOAD_ABSOLUTE_MAX_STREAM_TTFT_MS ?? "0");
const maxStreamTtftOverheadMs = Number(process.env.TOKENINSIDE_LOAD_MAX_STREAM_TTFT_OVERHEAD_MS ?? "0");
const cleanupOnly = process.env.TOKENINSIDE_LOAD_CLEANUP_ONLY === "true";
const requireNoUserQueue = process.env.TOKENINSIDE_LOAD_REQUIRE_NO_USER_QUEUE !== "false";
const requireRedisCache = process.env.TOKENINSIDE_LOAD_REQUIRE_REDIS_CACHE !== "false";
const runtimeSampleIntervalMs = Number(process.env.TOKENINSIDE_LOAD_RUNTIME_SAMPLE_INTERVAL_MS ?? "50");
const fixtureOffset = Number(process.env.TOKENINSIDE_LOAD_FIXTURE_OFFSET ?? "0");
const maxDurationMs = Number(process.env.TOKENINSIDE_LOAD_MAX_DURATION_MS ?? "85000");

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!newApiBaseUrl) throw new Error("NEWAPI_BASE_URL is required");
if (!controlCredential || !controlUserId) throw new Error("NewAPI control credential and user id are required");
if (!Number.isInteger(requestCount) || requestCount < 2 || requestCount > 4096) throw new Error("TOKENINSIDE_LOAD_REQUESTS must be 2..4096");
if (!Number.isInteger(userCount) || userCount < 1 || userCount > Math.min(120, requestCount)) throw new Error("TOKENINSIDE_LOAD_USERS must be 1..min(120, requests)");
if (!Number.isInteger(clientConcurrency) || clientConcurrency < 1 || clientConcurrency > requestCount) throw new Error("TOKENINSIDE_LOAD_CLIENT_CONCURRENCY must be 1..requests");
if (!new Set(["stream", "nonstream", "mixed"]).has(streamMode)) throw new Error("invalid stream mode");
if (!Number.isInteger(prewarmConcurrency) || prewarmConcurrency < 1 || prewarmConcurrency > 120) throw new Error("invalid prewarm concurrency");
if (!Number.isSafeInteger(grantQuota) || grantQuota <= 0) throw new Error("invalid grant quota");
if (!Number.isSafeInteger(expectedTokensPerRequest) || expectedTokensPerRequest < 0) throw new Error("invalid expected tokens per request");
if (!Number.isSafeInteger(expectedQuotaPerRequest) || expectedQuotaPerRequest < 0) throw new Error("invalid expected quota per request");
if (!Number.isFinite(maxStreamTtftMs) || maxStreamTtftMs < 0) throw new Error("invalid max stream TTFT");
if (!Number.isFinite(absoluteMaxStreamTtftMs) || absoluteMaxStreamTtftMs < 0) throw new Error("invalid absolute max stream TTFT");
if (!Number.isFinite(maxStreamTtftOverheadMs) || maxStreamTtftOverheadMs < 0) throw new Error("invalid max stream TTFT overhead");
if (!Number.isFinite(runtimeSampleIntervalMs) || runtimeSampleIntervalMs < 10) throw new Error("invalid runtime sample interval");
if (!Number.isSafeInteger(fixtureOffset) || fixtureOffset < 0) throw new Error("invalid fixture offset");
if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) throw new Error("invalid max duration");

const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const prefix = `gload_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
const upstreamPrefix = `gload-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
const departmentId = `${prefix}_department`;
const adminId = `${prefix}_admin`;
const definitionId = `${prefix}_definition`;
const versionId = `${prefix}_version`;
const budgetId = `${prefix}_budget`;
const now = new Date();
const nowIso = now.toISOString();
const periodStart = new Date(now.getTime() - 60_000).toISOString();
const periodEnd = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
const fixtures = [];
const createdTokenIds = [];
let probeFixture;

function controlHeaders() {
  return {
    "content-type": "application/json; charset=utf-8",
    authorization: controlCredential,
    "New-Api-User": controlUserId,
    "LLMAPI-User": controlUserId,
  };
}

async function controlFetch(path, init = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      const response = await fetch(`${newApiBaseUrl}${path}`, {
        ...init,
        headers: { ...controlHeaders(), ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) : {};
      if (response.ok && body.success !== false) return body.data ?? body;
      const error = new Error(body.message ?? body.error ?? `NewAPI control HTTP ${response.status}`);
      if (response.status < 500 && response.status !== 429) throw error;
      lastError = error;
      const retryAfter = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter * 1_000, 10_000)));
        continue;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(attempt * 750, 10_000)));
  }
  throw lastError;
}

async function mapLimit(items, limit, fn) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await fn(items[index], index);
    }
  }));
  return output;
}

async function searchTokens(keyword, expected = 0) {
  const items = [];
  for (let page = 1; page <= Math.max(10, Math.ceil(expected / 20) + 2); page += 1) {
    const params = new URLSearchParams({ keyword, p: String(page), size: "20" });
    const body = await controlFetch(`/api/token/search?${params.toString()}`);
    const pageItems = body.items ?? [];
    items.push(...pageItems);
    if (pageItems.length === 0 || items.length >= Number(body.total ?? items.length)) break;
  }
  return items;
}

async function batchKeys(ids) {
  const keys = {};
  for (let index = 0; index < ids.length; index += 100) {
    const chunk = ids.slice(index, index + 100);
    const body = await controlFetch("/api/token/batch/keys", { method: "POST", body: JSON.stringify({ ids: chunk }) });
    Object.assign(keys, body.keys ?? {});
  }
  return keys;
}

async function deleteUpstreamTokens() {
  const discovered = await searchTokens(`${upstreamPrefix}%`);
  const ids = [...new Set([...createdTokenIds, ...discovered.map((item) => Number(item.id)).filter(Number.isInteger)])];
  for (let index = 0; index < ids.length; index += 100) {
    await controlFetch("/api/token/batch", {
      method: "POST",
      body: JSON.stringify({ ids: ids.slice(index, index + 100) }),
    });
  }
}

async function cleanupStaleUpstreamFixtures() {
  const stale = (await searchTokens("gload%", 100_000))
    .filter((item) => typeof item.name === "string" && item.name.startsWith("gload-"))
    .map((item) => Number(item.id))
    .filter(Number.isInteger);
  for (let index = 0; index < stale.length; index += 100) {
    await controlFetch("/api/token/batch", {
      method: "POST",
      body: JSON.stringify({ ids: stale.slice(index, index + 100) }),
    });
  }
  return stale.length;
}

async function createUpstreamFixtures() {
  const fixtureCount = userCount + (model ? 0 : 1);
  const names = Array.from({ length: fixtureCount }, (_, index) => `${upstreamPrefix}-${String(index).padStart(3, "0")}`);
  await mapLimit(names, setupConcurrency, (name) => controlFetch("/api/token", {
    method: "POST",
    body: JSON.stringify({ name, remain_quota: grantQuota, unlimited_quota: false, expired_time: -1 }),
  }));
  const found = await searchTokens(`${upstreamPrefix}%`, fixtureCount);
  const byName = new Map(found.map((item) => [item.name, item]));
  const ordered = names.map((name) => {
    const token = byName.get(name);
    if (!token?.id) throw new Error(`created NewAPI fixture was not found: ${name}`);
    createdTokenIds.push(Number(token.id));
    return token;
  });
  const keys = await batchKeys(createdTokenIds);
  for (const [index, token] of ordered.entries()) {
    const tokenId = String(token.id);
    const key = keys[tokenId];
    if (!key) throw new Error(`NewAPI fixture key missing for ${tokenId}`);
    const fixture = {
      index,
      userId: `${prefix}_user_${index}`,
      accountId: `${prefix}_account_${index}`,
      requestId: `${prefix}_request_${index}`,
      commitmentId: `${prefix}_commitment_${index}`,
      grantId: `${prefix}_grant_${index}`,
      tokenId,
      key,
    };
    if (index === userCount) probeFixture = fixture;
    else fixtures.push(fixture);
  }
}

async function prewarmUpstreamFixtures() {
  const results = await mapLimit(fixtures, prewarmConcurrency, async (fixture) => {
    const response = await fetch(`${newApiBaseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${fixture.key}` },
      signal: AbortSignal.timeout(20_000),
    });
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`NewAPI key prewarm failed for token ${fixture.tokenId}: HTTP ${response.status}`);
    return response.status;
  });
  return results.filter((status) => status === 200).length;
}

async function resolveLoadModel() {
  if (model) return model;
  let body;
  let discoveryStatus = 0;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(`${newApiBaseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${probeFixture.key}` },
      signal: AbortSignal.timeout(20_000),
    });
    discoveryStatus = response.status;
    const text = await response.text();
    if (response.ok && text) {
      try {
        body = JSON.parse(text);
        break;
      } catch {
        // Retry a transient truncated NewAPI response.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  if (!body) throw new Error(`NewAPI model discovery failed with HTTP ${discoveryStatus}`);
  const ids = (body.data ?? [])
    .map((item) => item?.id)
    .filter((item) => typeof item === "string")
    .filter((item) => !/(embedding|rerank|image|tts|whisper|moderation)/i.test(item));
  const preferred = [
    "gpt-4.1-mini",
    "gemini-2.5-flash",
    "claude-3-5-haiku",
    "gpt-4o-mini",
  ];
  const candidates = [...new Set([...preferred.filter((item) => ids.includes(item)), ...ids])];
  const probes = await mapLimit(candidates.slice(0, 30), 5, async (candidate) => {
    const startedAt = performance.now();
    const probe = await fetch(`${newApiBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${probeFixture.key}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        model: candidate,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    await probe?.arrayBuffer().catch(() => undefined);
    return {
      candidate,
      ok: Boolean(probe?.ok),
      durationMs: Math.round(performance.now() - startedAt),
    };
  });
  modelProbeSummary = probes
    .filter((item) => item.ok)
    .sort((left, right) => left.durationMs - right.durationMs)
    .slice(0, 5);
  const fastest = modelProbeSummary[0];
  if (!fastest) throw new Error("NewAPI exposed models but none of the first 30 accepted a minimal generation request");
  model = fastest.candidate;
  return model;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function seedLocalFixtures() {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set constraints all deferred");
    const adminData = { id: adminId, tenantKey: `${prefix}_tenant`, openId: `${prefix}_admin_open`, departmentId, status: "active", createdAt: nowIso, updatedAt: nowIso };
    await client.query(
      `insert into feishu_users (id, tenant_key, open_id, department_id, data, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$6)`,
      [adminId, `${prefix}_tenant`, `${prefix}_admin_open`, departmentId, adminData, nowIso],
    );
    await client.query(
      `insert into billing_package_definitions
       values ($1,'department',$2,$3,'G Load Package','real NewAPI load','active',$4,$5,$5)`,
      [definitionId, departmentId, `${prefix}_package`, adminId, nowIso],
    );
    await client.query(
      `insert into billing_package_versions
        (id, definition_id, version, granted_quota, cycle_type, cycle_value, timezone,
         eligibility_policy_json, regrant_policy_json, status, created_by_user_id, created_at, published_at)
       values ($1,$2,1,$3,'fixed_days',7,'Asia/Hong_Kong',$4,$5,'published',$6,$7,$7)`,
      [versionId, definitionId, grantQuota, { allowFirstRequest: true }, { mode: "exhausted" }, adminId, nowIso],
    );
    const totalBudget = grantQuota * userCount;
    await client.query(
      `insert into department_budget_periods
        (id, department_id, period_type, period_start, period_end, budget_quota,
         committed_quota, pending_quota, consumed_quota, version, configured_by_user_id,
         created_at, updated_at)
       values ($1,$2,'fixed_range',$3,$4,$5,$5,0,0,1,$6,$7,$7)`,
      [budgetId, departmentId, periodStart, periodEnd, totalBudget, adminId, nowIso],
    );
    for (const item of fixtures) {
      const openId = `${prefix}_open_${item.index}`;
      const userData = { id: item.userId, tenantKey: `${prefix}_tenant`, openId, departmentId, status: "active", createdAt: nowIso, updatedAt: nowIso };
      await client.query(
        `insert into feishu_users (id, tenant_key, open_id, department_id, data, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$6)`,
        [item.userId, `${prefix}_tenant`, openId, departmentId, userData, nowIso],
      );
      await client.query(
        `insert into billing_package_requests
          (id, request_kind, user_id, department_id_at_request, package_definition_id,
           package_version_id, status, reason, idempotency_key, created_at, updated_at)
         values ($1,'admin_grant',$2,$3,$4,$5,'provisioned','load fixture',$6,$7,$7)`,
        [item.requestId, item.userId, departmentId, definitionId, versionId, `${prefix}_idem_${item.index}`, nowIso],
      );
      await client.query(
        `insert into department_budget_commitments
          (id, department_budget_period_id, department_id, request_id, package_version_id,
           grant_id, quota, state, idempotency_key, created_at, committed_at)
         values ($1,$2,$3,$4,$5,$6,$7,'committed',$8,$9,$9)`,
        [item.commitmentId, budgetId, departmentId, item.requestId, versionId, item.grantId, grantQuota, `${prefix}_commit_${item.index}`, nowIso],
      );
      const snapshot = { packageCode: `${prefix}_package`, packageName: "G Load Package", packageDescription: "real NewAPI load", version: 1, grantedQuota: grantQuota, cycleType: "fixed_days", cycleValue: 7, timezone: "Asia/Hong_Kong", eligibilityPolicy: { allowFirstRequest: true }, regrantPolicy: { mode: "exhausted" } };
      await client.query(
        `insert into user_package_grants
          (id, user_id, department_id_at_grant, package_definition_id, package_version_id,
           snapshot_json, granted_quota, allocated_quota, starts_at, expires_at, status,
           source_request_id, budget_commitment_id, created_by_user_id, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,'active',$10,$11,$12,$13)`,
        [item.grantId, item.userId, departmentId, definitionId, versionId, snapshot, grantQuota, periodStart, periodEnd, item.requestId, item.commitmentId, adminId, nowIso],
      );
      const account = { id: item.accountId, feishuUserId: item.userId, sourceRequestId: item.requestId, newapiTokenId: item.tokenId, keyHash: sha256(item.key), status: "active", billingPeriod: "package", operationGeneration: 0, activatedAt: nowIso, createdAt: nowIso };
      await client.query(
        `insert into token_accounts
          (id, feishu_user_id, source_request_id, newapi_token_id, key_hash,
           status, billing_period, data, created_at)
         values ($1,$2,$3,$4,$5,'active','package',$6,$7)`,
        [item.accountId, item.userId, item.requestId, item.tokenId, account.keyHash, account, nowIso],
      );
      item.principal = { tokenAccount: account, user: userData };
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function prewarmTokenInsidePrincipals() {
  if (!process.env.TOKENINSIDE_REDIS_URL) {
    return { configured: false, warmed: 0 };
  }
  const { primeProxyPrincipalCache } = await import("../../lib/proxy-principal-cache.ts");
  const { closeRedisClient } = await import("../../lib/redis-runtime.ts");
  try {
    const results = await mapLimit(fixtures, prewarmConcurrency, (fixture) => {
      if (!fixture.principal) throw new Error(`TokenInside principal missing for fixture ${fixture.index}`);
      return primeProxyPrincipalCache(fixture.principal.tokenAccount.keyHash, fixture.principal);
    });
    const warmed = results.filter(Boolean).length;
    assert.equal(warmed, fixtures.length, "TokenInside Redis principal prewarm was incomplete");
    return { configured: true, warmed };
  } finally {
    await closeRedisClient();
  }
}

async function cleanupTokenInsidePrincipals() {
  if (!process.env.TOKENINSIDE_REDIS_URL) return;
  const { invalidateProxyPrincipalCache } = await import("../../lib/proxy-principal-cache.ts");
  const { closeRedisClient } = await import("../../lib/redis-runtime.ts");
  try {
    await mapLimit(fixtures, prewarmConcurrency, (fixture) => (
      fixture.principal
        ? invalidateProxyPrincipalCache(fixture.principal.tokenAccount.keyHash)
        : Promise.resolve(false)
    ));
  } finally {
    await closeRedisClient();
  }
}

function percentile(values, percentileValue) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1)];
}

function mix32(value) {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function deterministicFixtureTimings(index) {
  const pairIndex = Math.floor(index / 2);
  const tailPosition = mix32(Math.floor(pairIndex / 20) + 0x51f15e) % 20;
  const normalTtft = pairIndex % 20 !== tailPosition;
  const ttftState = mix32(index + 0x9e3779b9);
  const ttftMs = normalTtft
    ? 500 + (ttftState % 2501)
    : 3001 + (ttftState % 1500);
  const totalMs = 5_000 + (mix32(index + 0x243f6a88) % 55_001);
  return { ttftMs, totalMs: Math.max(totalMs, ttftMs + 100) };
}

async function fetchRuntimeMetrics() {
  const response = await fetch(`${targetUrl}/api/health?scope=runtime`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`runtime metrics HTTP ${response.status}`);
  return response.json();
}

function counterDelta(after, before, key) {
  return Number(after?.[key] ?? 0) - Number(before?.[key] ?? 0);
}

function maxObserved(samples, read) {
  return samples.reduce((maximum, sample) => Math.max(maximum, Number(read(sample) ?? 0)), 0);
}

async function runLoadWithRuntimeSampling() {
  const before = await fetchRuntimeMetrics();
  const samples = [before];
  let stopped = false;
  const sampler = (async () => {
    while (!stopped) {
      await new Promise((resolve) => setTimeout(resolve, runtimeSampleIntervalMs));
      if (stopped) break;
      try {
        samples.push(await fetchRuntimeMetrics());
      } catch {
        // The load result and final metrics probe remain authoritative.
      }
    }
  })();
  let load;
  try {
    load = await runLoad();
  } finally {
    stopped = true;
    await sampler;
  }
  const after = await fetchRuntimeMetrics();
  samples.push(after);
  const beforeUpstream = before.proxyConcurrency;
  const afterUpstream = after.proxyConcurrency;
  const beforePreparation = beforeUpstream?.preparation;
  const afterPreparation = afterUpstream?.preparation;
  const beforeBusinessPool = before.postgresPools?.business;
  const afterBusinessPool = after.postgresPools?.business;
  const beforePrincipalCache = before.proxyPrincipalCache;
  const afterPrincipalCache = after.proxyPrincipalCache;
  return {
    load,
    runtime: {
      samples: samples.length,
      gateway: {
        upstream: {
          enqueued: counterDelta(afterUpstream, beforeUpstream, "enqueuedTotal"),
          rejected: counterDelta(afterUpstream, beforeUpstream, "rejectedTotal"),
          timedOut: counterDelta(afterUpstream, beforeUpstream, "timedOutTotal"),
          maxActive: maxObserved(samples, (item) => item.proxyConcurrency?.active),
          maxQueued: maxObserved(samples, (item) => item.proxyConcurrency?.queued),
        },
        preparation: {
          enqueued: counterDelta(afterPreparation, beforePreparation, "enqueuedTotal"),
          rejected: counterDelta(afterPreparation, beforePreparation, "rejectedTotal"),
          timedOut: counterDelta(afterPreparation, beforePreparation, "timedOutTotal"),
          maxActive: maxObserved(samples, (item) => item.proxyConcurrency?.preparation?.active),
          maxQueued: maxObserved(samples, (item) => item.proxyConcurrency?.preparation?.queued),
        },
      },
      postgresBusinessPool: {
        queuedAcquisitions: counterDelta(afterBusinessPool, beforeBusinessPool, "queuedTotal"),
        failedAcquisitions: counterDelta(afterBusinessPool, beforeBusinessPool, "failedTotal"),
        acquisitionMsMax: Number(afterBusinessPool?.acquisitionMsMax ?? 0),
        maxWaiting: maxObserved(samples, (item) => item.postgresPools?.business?.waiting),
        maxTotal: maxObserved(samples, (item) => item.postgresPools?.business?.total),
      },
      principalCache: {
        hits: counterDelta(afterPrincipalCache, beforePrincipalCache, "hits"),
        misses: counterDelta(afterPrincipalCache, beforePrincipalCache, "misses"),
        postgresFallbacks: counterDelta(afterPrincipalCache, beforePrincipalCache, "postgresFallbacks"),
        writes: counterDelta(afterPrincipalCache, beforePrincipalCache, "writes"),
      },
    },
  };
}

async function runLoad() {
  const items = Array.from({ length: requestCount }, (_, index) => ({
    ...fixtures[index % fixtures.length],
    loadIndex: index,
    fixtureIndex: index + fixtureOffset,
  }));
  const started = performance.now();
  const execute = async (item) => {
    const requestStarted = performance.now();
    const stream = streamMode === "stream" || (streamMode === "mixed" && item.loadIndex % 2 === 0);
    try {
      const response = await fetch(`${targetUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${item.key}`, "content-type": "application/json", "user-agent": "tokeninside-g-stage-load/1.0" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: `Reply with exactly OK. fixture ${item.fixtureIndex}` }], max_tokens: 5, stream }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const firstByteMs = Math.round(performance.now() - requestStarted);
      const preparationMs = Number(response.headers.get("x-tokeninside-preparation-ms"));
      const billingContextMs = Number(response.headers.get("x-tokeninside-billing-context-ms"));
      const upstreamFirstByteMs = Number(response.headers.get("x-tokeninside-upstream-first-byte-ms"));
      const responseBuffer = await response.arrayBuffer();
      let error;
      if (response.status >= 400) {
        try {
          const body = JSON.parse(new TextDecoder().decode(responseBuffer));
          error = {
            code: body?.error?.code,
            message: typeof body?.error?.message === "string" ? body.error.message.slice(0, 200) : undefined,
          };
        } catch {
          error = { code: "non_json_error" };
        }
      }
      return {
        status: response.status,
        stream,
        firstByteMs,
        preparationMs: Number.isFinite(preparationMs) ? preparationMs : undefined,
        billingContextMs: Number.isFinite(billingContextMs) ? billingContextMs : undefined,
        upstreamFirstByteMs: Number.isFinite(upstreamFirstByteMs) ? upstreamFirstByteMs : undefined,
        durationMs: Math.round(performance.now() - requestStarted),
        fixtureIndex: item.fixtureIndex,
        error,
      };
    } catch (error) {
      return { status: 0, stream, fixtureIndex: item.fixtureIndex, firstByteMs: 0, durationMs: Math.round(performance.now() - requestStarted), error: error instanceof Error ? error.name : "UnknownError" };
    }
  };
  const results = clientConcurrency === requestCount
    ? await Promise.all(items.map(execute))
    : await mapLimit(items, clientConcurrency, execute);
  return { items, results, wallMs: Math.round(performance.now() - started) };
}

async function waitForSettlement(expected) {
  const deadline = Date.now() + settlementTimeoutMs;
  let last;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `select
        (select count(*)::int from proxy_request_logs where feishu_user_id like $1 and status_code = 200) as completed,
        (select count(*)::int from request_billing_contexts where user_id like $1) as contexts,
        (select count(*)::int from newapi_usage_records where feishu_user_id like $1 and match_status = 'matched') as sources,
        (select count(distinct source_identity)::int from usage_charge_allocations where user_id like $1) as allocated_sources,
        (select coalesce(sum(quota),0)::bigint from usage_charge_allocations where user_id like $1) as allocated_quota,
        (select coalesce(sum((data->>'quota')::bigint),0)::bigint from newapi_usage_records where feishu_user_id like $1 and match_status = 'matched') as source_quota,
        (select coalesce(sum((data->>'totalTokens')::bigint),0)::bigint from newapi_usage_records where feishu_user_id like $1 and match_status = 'matched') as source_tokens,
        (select coalesce(min(requests),0)::int from (
           select count(*)::int as requests from proxy_request_logs
            where feishu_user_id like $1 and status_code = 200 group by feishu_user_id
         ) per_user) as min_requests_per_user,
        (select coalesce(max(requests),0)::int from (
           select count(*)::int as requests from proxy_request_logs
            where feishu_user_id like $1 and status_code = 200 group by feishu_user_id
         ) per_user) as max_requests_per_user`,
      [`${prefix}_user_%`],
    );
    last = result.rows[0];
    if (last.completed === expected && last.contexts === expected && last.sources === expected && last.allocated_sources === expected && last.allocated_quota === last.source_quota) {
      return Object.fromEntries(Object.entries(last).map(([key, value]) => [key, Number(value)]));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`settlement timeout: ${JSON.stringify(last)}`);
}

async function verifyWaterlines() {
  const startedAt = Date.now();
  const deadline = startedAt + settlementTimeoutMs;
  let mismatches = [];
  while (Date.now() < deadline) {
    const upstream = await searchTokens(`${upstreamPrefix}%`, userCount + 1).catch(() => null);
    if (!upstream) {
      mismatches = [{ reason: "newapi_control_rate_limited" }];
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    const upstreamById = new Map(upstream.map((item) => [String(item.id), Number(item.remain_quota)]));
    const balances = await pool.query(
      `select account.newapi_token_id,
              (grant_row.granted_quota - grant_row.allocated_quota)::bigint as available_quota
         from token_accounts account
         join user_package_grants grant_row on grant_row.user_id = account.feishu_user_id
        where account.feishu_user_id like $1 and account.status = 'active'`,
      [`${prefix}_user_%`],
    );
    assert.equal(balances.rowCount, userCount);
    mismatches = balances.rows
      .map((row) => ({
        upstream: upstreamById.get(String(row.newapi_token_id)),
        expected: Number(row.available_quota),
      }))
      .filter((item) => item.upstream !== item.expected);
    if (mismatches.length === 0) {
      return { matched: balances.rowCount, convergenceMs: Date.now() - startedAt };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`NewAPI waterline did not converge: ${JSON.stringify(mismatches.slice(0, 5))}`);
}

async function cleanupLocal() {
  const client = await pool.connect();
  try {
    await client.query("set session_replication_role = replica");
    const userPattern = `${prefix}_user_%`;
    await client.query("delete from usage_charge_allocations where user_id like $1", [userPattern]);
    await client.query("delete from request_billing_contexts where user_id like $1", [userPattern]);
    await client.query("delete from newapi_usage_records where feishu_user_id like $1", [userPattern]);
    await client.query("delete from usage_sync_issues where newapi_token_id = any($1::text[])", [createdTokenIds.map(String)]);
    await client.query("delete from proxy_request_logs where feishu_user_id like $1", [userPattern]);
    await client.query("delete from billing_operations where user_id like $1", [userPattern]);
    await client.query("delete from token_accounts where feishu_user_id like $1", [userPattern]);
    await client.query("delete from user_package_grants where user_id like $1", [userPattern]);
    await client.query("delete from department_budget_commitments where department_id = $1", [departmentId]);
    await client.query("delete from department_budget_periods where department_id = $1", [departmentId]);
    await client.query("delete from billing_package_requests where user_id like $1", [userPattern]);
    await client.query("delete from billing_package_versions where id = $1", [versionId]);
    await client.query("delete from billing_package_definitions where id = $1", [definitionId]);
    await client.query("delete from feishu_users where id = $1 or id like $2", [adminId, userPattern]);
  } finally {
    await client.query("set session_replication_role = origin").catch(() => undefined);
    client.release();
  }
}

async function cleanupStaleLocalFixtures() {
  const client = await pool.connect();
  const userPattern = "gload_%";
  try {
    await client.query("set session_replication_role = replica");
    const tokenIds = await client.query(
      "select newapi_token_id from token_accounts where feishu_user_id like $1",
      [userPattern],
    );
    const newapiTokenIds = tokenIds.rows.map((row) => String(row.newapi_token_id));
    await client.query("delete from usage_charge_allocations where user_id like $1", [userPattern]);
    await client.query("delete from request_billing_contexts where user_id like $1", [userPattern]);
    await client.query("delete from newapi_usage_records where feishu_user_id like $1", [userPattern]);
    if (newapiTokenIds.length > 0) {
      await client.query("delete from usage_sync_issues where newapi_token_id = any($1::text[])", [newapiTokenIds]);
    }
    await client.query("delete from proxy_request_logs where feishu_user_id like $1", [userPattern]);
    await client.query("delete from billing_operations where user_id like $1", [userPattern]);
    await client.query("delete from token_accounts where feishu_user_id like $1", [userPattern]);
    await client.query("delete from user_package_grants where user_id like $1", [userPattern]);
    await client.query("delete from department_budget_commitments where department_id like $1", [userPattern]);
    await client.query("delete from department_budget_periods where department_id like $1", [userPattern]);
    await client.query("delete from billing_package_requests where user_id like $1 or id like $1", [userPattern]);
    await client.query("delete from department_package_assignments where department_id like $1", [userPattern]);
    await client.query("delete from billing_package_versions where id like $1 or definition_id like $1", [userPattern]);
    await client.query("delete from billing_package_definitions where id like $1", [userPattern]);
    await client.query("delete from feishu_users where id like $1", [userPattern]);
    return { tokenAccounts: newapiTokenIds.length };
  } finally {
    await client.query("set session_replication_role = origin").catch(() => undefined);
    client.release();
  }
}

if (cleanupOnly) {
  const [local, upstream] = await Promise.all([
    cleanupStaleLocalFixtures(),
    cleanupStaleUpstreamFixtures(),
  ]);
  await pool.end();
  console.log(JSON.stringify({
    status: "cleaned",
    localTokenAccounts: local.tokenAccounts,
    upstreamTokens: upstream,
  }));
  process.exit(0);
}

let cleanupPassed = false;
try {
  await Promise.all([cleanupStaleLocalFixtures(), cleanupStaleUpstreamFixtures()]);
  await createUpstreamFixtures();
  const prewarmedKeys = await prewarmUpstreamFixtures();
  await resolveLoadModel();
  await seedLocalFixtures();
  const tokenInsideRedis = await prewarmTokenInsidePrincipals();
  const { load, runtime } = await runLoadWithRuntimeSampling();
  const success = load.results.filter((item) => item.status === 200).length;
  const statusCounts = Object.fromEntries(
    [...new Set(load.results.map((item) => item.status))]
      .sort((left, right) => left - right)
      .map((status) => [status, load.results.filter((item) => item.status === status).length]),
  );
  assert.equal(
    success,
    requestCount,
    `HTTP 200 ${success}/${requestCount}; statusCounts=${JSON.stringify(statusCounts)}; sampleErrors=${JSON.stringify(load.results.filter((item) => item.status !== 200).slice(0, 5))}`,
  );
  if (streamMode === "mixed") {
    assert.equal(load.results.filter((item) => item.stream && item.status === 200).length, Math.ceil(requestCount / 2));
    assert.equal(load.results.filter((item) => !item.stream && item.status === 200).length, Math.floor(requestCount / 2));
  }
  const settlement = await waitForSettlement(success);
  assert.equal(settlement.min_requests_per_user, Math.floor(requestCount / userCount));
  assert.equal(settlement.max_requests_per_user, Math.ceil(requestCount / userCount));
  if (expectedTokensPerRequest > 0) {
    assert.equal(settlement.source_tokens, requestCount * expectedTokensPerRequest);
  }
  if (expectedQuotaPerRequest > 0) {
    assert.equal(settlement.source_quota, requestCount * expectedQuotaPerRequest);
    assert.equal(settlement.allocated_quota, requestCount * expectedQuotaPerRequest);
  }
  const waterlines = await verifyWaterlines();
  const durations = load.results.map((item) => item.durationMs);
  const firstBytes = load.results.map((item) => item.firstByteMs);
  const streamTtft = load.results.filter((item) => item.stream).map((item) => item.firstByteMs);
  const streamTtftOverheads = load.results.filter((item) => item.stream).map((item) => (
    item.firstByteMs - deterministicFixtureTimings(item.fixtureIndex).ttftMs
  ));
  const streamPreparation = load.results
    .filter((item) => item.stream && item.preparationMs !== undefined)
    .map((item) => item.preparationMs);
  const streamUpstreamFirstByte = load.results
    .filter((item) => item.stream && item.upstreamFirstByteMs !== undefined)
    .map((item) => item.upstreamFirstByteMs);
  const streamBillingContext = load.results
    .filter((item) => item.stream && item.billingContextMs !== undefined)
    .map((item) => item.billingContextMs);
  const latencyMetrics = {
    streamTtftP95Ms: percentile(streamTtft, 95),
    streamTtftMaxMs: Math.max(...streamTtft),
    streamTtftOverheadP95Ms: percentile(streamTtftOverheads, 95),
    streamTtftOverheadMaxMs: Math.max(...streamTtftOverheads),
    streamPreparationP95Ms: percentile(streamPreparation, 95),
    streamPreparationMaxMs: Math.max(...streamPreparation),
    streamBillingContextP95Ms: percentile(streamBillingContext, 95),
    streamBillingContextMaxMs: Math.max(...streamBillingContext),
    streamUpstreamFirstByteP95Ms: percentile(streamUpstreamFirstByte, 95),
    streamUpstreamFirstByteMaxMs: Math.max(...streamUpstreamFirstByte),
    allRequestFirstByteP95Ms: percentile(firstBytes, 95),
    allRequestFirstByteMaxMs: Math.max(...firstBytes),
    durationP95Ms: percentile(durations, 95),
    durationMaxMs: Math.max(...durations),
  };
  for (const item of load.results) {
    const expectedTiming = deterministicFixtureTimings(item.fixtureIndex);
    assert.ok(
      item.durationMs >= expectedTiming.totalMs - 250,
      `request ${item.fixtureIndex} completed earlier than its deterministic total latency`,
    );
    if (item.stream) {
      assert.ok(
        item.firstByteMs >= expectedTiming.ttftMs - 250,
        `stream ${item.fixtureIndex} arrived earlier than its deterministic TTFT`,
      );
    }
  }
  const latencyFailures = [];
  if (maxStreamTtftMs > 0 && latencyMetrics.streamTtftP95Ms > maxStreamTtftMs) {
    latencyFailures.push(`stream TTFT p95 ${latencyMetrics.streamTtftP95Ms}ms > ${maxStreamTtftMs}ms`);
  }
  if (absoluteMaxStreamTtftMs > 0 && latencyMetrics.streamTtftMaxMs > absoluteMaxStreamTtftMs) {
    latencyFailures.push(`stream TTFT max ${latencyMetrics.streamTtftMaxMs}ms > ${absoluteMaxStreamTtftMs}ms`);
  }
  if (maxStreamTtftOverheadMs > 0 && latencyMetrics.streamTtftOverheadMaxMs > maxStreamTtftOverheadMs) {
    latencyFailures.push(`stream TTFT overhead max ${latencyMetrics.streamTtftOverheadMaxMs}ms > ${maxStreamTtftOverheadMs}ms`);
  }
  if (latencyMetrics.durationMaxMs > maxDurationMs) {
    latencyFailures.push(`request duration max ${latencyMetrics.durationMaxMs}ms > ${maxDurationMs}ms`);
  }
  if (latencyFailures.length > 0) {
    console.error(JSON.stringify({
      status: "failed",
      reason: "latency_gate",
      failures: latencyFailures,
      requests: requestCount,
      users: userCount,
      fixtureOffset,
      latency: latencyMetrics,
      runtime,
      settlement,
      waterlinesMatched: waterlines.matched,
      waterlineConvergenceMs: waterlines.convergenceMs,
    }));
    throw new Error(latencyFailures.join("; "));
  }
  if (requireNoUserQueue) {
    assert.deepEqual(
      {
        upstreamEnqueued: runtime.gateway.upstream.enqueued,
        upstreamRejected: runtime.gateway.upstream.rejected,
        upstreamTimedOut: runtime.gateway.upstream.timedOut,
        upstreamMaxQueued: runtime.gateway.upstream.maxQueued,
        preparationEnqueued: runtime.gateway.preparation.enqueued,
        preparationRejected: runtime.gateway.preparation.rejected,
        preparationTimedOut: runtime.gateway.preparation.timedOut,
        preparationMaxQueued: runtime.gateway.preparation.maxQueued,
      },
      {
        upstreamEnqueued: 0,
        upstreamRejected: 0,
        upstreamTimedOut: 0,
        upstreamMaxQueued: 0,
        preparationEnqueued: 0,
        preparationRejected: 0,
        preparationTimedOut: 0,
        preparationMaxQueued: 0,
      },
      "user request entered or was rejected by a TokenInside concurrency queue",
    );
  }
  if (requireRedisCache) {
    assert.deepEqual(
      tokenInsideRedis,
      { configured: true, warmed: userCount },
      "TokenInside Redis principal fixtures were not fully prewarmed",
    );
    assert.equal(runtime.principalCache.hits, requestCount, "not every proxy request hit the Redis principal cache");
    assert.equal(runtime.principalCache.misses, 0, "a proxy request missed the prewarmed Redis principal cache");
    assert.equal(runtime.principalCache.postgresFallbacks, 0, "a proxy principal lookup fell back to PostgreSQL");
  }
  assert.equal(runtime.postgresBusinessPool.failedAcquisitions, 0, "PostgreSQL pool acquisition failed during load");
  console.log(JSON.stringify({
    status: "passed",
    scenario: "real-newapi-package-data-plane",
    model,
    modelProbeSummary,
    requests: requestCount,
    users: userCount,
    clientConcurrency,
    streamMode,
    fixtureOffset,
    prewarmedKeys,
    tokenInsideRedis,
    http200: success,
    stream200: load.results.filter((item) => item.stream && item.status === 200).length,
    nonstream200: load.results.filter((item) => !item.stream && item.status === 200).length,
    wallMs: load.wallMs,
    ...latencyMetrics,
    runtime,
    settlement,
    waterlinesMatched: waterlines.matched,
    waterlineConvergenceMs: waterlines.convergenceMs,
    fixturesCleaned: true,
  }));
} finally {
  const cleanup = await Promise.allSettled([
    cleanupLocal(),
    deleteUpstreamTokens(),
    cleanupTokenInsidePrincipals(),
  ]);
  cleanupPassed = cleanup.every((item) => item.status === "fulfilled");
  await pool.end();
  if (!cleanupPassed) throw new Error(`fixture cleanup failed: ${cleanup.map((item) => item.status).join(",")}`);
}
