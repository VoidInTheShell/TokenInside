import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
const newApiBaseUrl = process.env.NEWAPI_BASE_URL?.replace(/\/+$/, "");
const controlCredential =
  process.env.NEWAPI_ACCESS_TOKEN ||
  process.env.NEWAPI_ADMIN_ACCESS_TOKEN ||
  process.env.NEWAPI_SYSTEM_AK;
const controlUserId = process.env.NEWAPI_CONTROL_USER_ID;
const targetUrl = (process.env.TOKENINSIDE_LOAD_TARGET_URL ?? "http://127.0.0.1:16878")
  .replace(/\/+$/, "");
const concurrency = Number(process.env.TOKENINSIDE_LOAD_CONCURRENCY ?? "60");
const userCount = Number(process.env.TOKENINSIDE_LOAD_USERS ?? String(concurrency));
const setupConcurrency = Number(process.env.TOKENINSIDE_LOAD_SETUP_CONCURRENCY ?? "3");
const requestTimeoutMs = Number(process.env.TOKENINSIDE_LOAD_REQUEST_TIMEOUT_MS ?? "15000");
const p95LimitMs = Number(process.env.TOKENINSIDE_LOAD_P95_LIMIT_MS ?? "5000");
const billable = process.env.TOKENINSIDE_LOAD_BILLABLE === "true";
const billingModel = process.env.TOKENINSIDE_LOAD_MODEL ?? "gpt-4o-mini";
const streamMode = process.env.TOKENINSIDE_LOAD_STREAM_MODE ?? "nonstream";
const billingSyncTimeoutMs = Number(
  process.env.TOKENINSIDE_LOAD_BILLING_SYNC_TIMEOUT_MS ?? "60000",
);
const quotaPerUnit = Number(process.env.NEWAPI_QUOTA_PER_UNIT ?? "500000");
const minSuccessRate = Number(process.env.TOKENINSIDE_LOAD_MIN_SUCCESS_RATE ?? "1");

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!newApiBaseUrl) throw new Error("NEWAPI_BASE_URL is required");
if (!controlCredential) {
  throw new Error(
    "NEWAPI_ACCESS_TOKEN, NEWAPI_ADMIN_ACCESS_TOKEN or NEWAPI_SYSTEM_AK is required",
  );
}
if (!controlUserId) throw new Error("NEWAPI_CONTROL_USER_ID is required");
if (!Number.isInteger(concurrency) || concurrency < 2 || concurrency > 1200) {
  throw new Error("TOKENINSIDE_LOAD_CONCURRENCY must be an integer between 2 and 1200");
}
if (!Number.isInteger(userCount) || userCount < 1 || userCount > Math.min(concurrency, 200)) {
  throw new Error("TOKENINSIDE_LOAD_USERS must be between 1 and min(concurrency, 200)");
}
if (!Number.isInteger(setupConcurrency) || setupConcurrency < 1 || setupConcurrency > 30) {
  throw new Error("TOKENINSIDE_LOAD_SETUP_CONCURRENCY must be an integer between 1 and 30");
}
if (!new Set(["nonstream", "stream", "mixed"]).has(streamMode)) {
  throw new Error("TOKENINSIDE_LOAD_STREAM_MODE must be nonstream, stream or mixed");
}
if (!Number.isFinite(minSuccessRate) || minSuccessRate <= 0 || minSuccessRate > 1) {
  throw new Error("TOKENINSIDE_LOAD_MIN_SUCCESS_RATE must be greater than 0 and at most 1");
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: Math.min(Math.max(setupConcurrency, 2), 20),
});
const runId = `gwload_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
const upstreamPrefix = `gwload-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
const createdTokens = [];
const fixtures = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

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
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(`${newApiBaseUrl}${path}`, {
        ...init,
        headers: {
          ...controlHeaders(),
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const text = await response.text();
      let body = {};
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new Error(`NewAPI control API returned non-JSON HTTP ${response.status}`);
        }
      }
      if (response.ok && body.success !== false) return body.data ?? body;
      const error = new Error(
        body.message ?? body.error ?? `NewAPI control API failed with HTTP ${response.status}`,
      );
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /HTTP 4\d\d/.test(error.message)) throw error;
    }
    if (attempt < 4) await sleep(250 * 2 ** (attempt - 1));
  }
  throw lastError;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  const failed = workers.find((item) => item.status === "rejected");
  if (failed) throw failed.reason;
  return results;
}

async function createUpstreamFixtures(count) {
  const names = Array.from(
    { length: count },
    (_, index) => `${upstreamPrefix}-${String(index).padStart(3, "0")}`,
  );
  await mapLimit(names, setupConcurrency, async (name) => {
    await controlFetch("/api/token", {
      method: "POST",
      body: JSON.stringify({
        name,
        remain_quota: billable ? 100_000_000 : 1,
        unlimited_quota: false,
        expired_time: -1,
      }),
    });
  });

  const foundTokens = await searchUpstreamTokens(`${upstreamPrefix}%`, count);
  const byName = new Map(foundTokens.map((item) => [item.name, item]));
  const orderedTokens = names.map((name) => {
    const token = byName.get(name);
    if (!token?.id) throw new Error(`Created NewAPI token ${name} was not found`);
    return token;
  });
  const numericTokenIds = orderedTokens.map((token) => Number(token.id));
  if (numericTokenIds.some((id) => !Number.isInteger(id))) {
    throw new Error("NewAPI batch key API requires numeric token IDs");
  }
  createdTokens.push(...numericTokenIds.map(String));

  const keys = {};
  for (let index = 0; index < numericTokenIds.length; index += 100) {
    const keyBody = await controlFetch("/api/token/batch/keys", {
      method: "POST",
      body: JSON.stringify({ ids: numericTokenIds.slice(index, index + 100) }),
    });
    Object.assign(keys, keyBody.keys ?? {});
  }
  return orderedTokens.map((token, index) => {
    const tokenId = String(token.id);
    const key = keys[tokenId];
    if (!key) throw new Error(`NewAPI token ${token.name} did not return a batch key`);
    const userId = `${runId}_user_${index}`;
    const accountId = `${runId}_account_${index}`;
    return {
      name: token.name,
      tokenId,
      key,
      userId,
      accountId,
      requestId: `${runId}_request_${index}`,
    };
  });
}

async function insertLocalFixtures(items) {
  const client = await pool.connect();
  const now = new Date().toISOString();
  const period = now.slice(0, 7);
  try {
    await client.query("begin");
    for (const [index, item] of items.entries()) {
      const user = {
        id: item.userId,
        tenantKey: runId,
        openId: `${runId}_open_${index}`,
        name: `Gateway load user ${index}`,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      const account = {
        id: item.accountId,
        feishuUserId: item.userId,
        tokenRequestId: item.requestId,
        newapiTokenId: item.tokenId,
        keyHash: sha256Hex(item.key),
        status: "active",
        billingPeriod: period,
        operationGeneration: 0,
        activatedAt: now,
        createdAt: now,
      };
      const state = {
        feishuUserId: item.userId,
        admission: "open",
        activeGeneration: 0,
        updatedAt: now,
      };
      await client.query(
        `insert into feishu_users
          (id, tenant_key, open_id, department_id, data, created_at, updated_at)
         values ($1, $2, $3, null, $4, $5, $6)`,
        [user.id, user.tenantKey, user.openId, user, user.createdAt, user.updatedAt],
      );
      await client.query(
        `insert into token_accounts
          (id, feishu_user_id, token_request_id, newapi_token_id, key_hash,
           status, billing_period, operation_generation, drain_started_at,
           settled_through, activated_at, data, created_at, disabled_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, null, null, $9, $10, $11, null)`,
        [
          account.id,
          account.feishuUserId,
          account.tokenRequestId,
          account.newapiTokenId,
          account.keyHash,
          account.status,
          account.billingPeriod,
          account.operationGeneration,
          account.activatedAt,
          account,
          account.createdAt,
        ],
      );
      await client.query(
        `insert into user_quota_states
          (feishu_user_id, admission, active_generation, operation_id, data, updated_at)
         values ($1, $2, $3, null, $4, $5)`,
        [state.feishuUserId, state.admission, state.activeGeneration, state, state.updatedAt],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sortedValues.length) - 1),
  );
  return sortedValues[index];
}

async function runLoad(items) {
  const startedAt = performance.now();
  const results = await Promise.all(
    items.map(async (item) => {
      const requestStartedAt = performance.now();
      const isStream = streamMode === "stream" || (streamMode === "mixed" && item.loadIndex % 2 === 0);
      try {
        const response = await fetch(
          billable ? `${targetUrl}/v1/chat/completions` : `${targetUrl}/v1/models`,
          {
          method: billable ? "POST" : "GET",
          headers: {
            authorization: `Bearer ${item.key}`,
            "user-agent": "tokeninside-gateway-concurrency-check/1.0",
            ...(billable ? { "content-type": "application/json; charset=utf-8" } : {}),
          },
          body: billable
            ? JSON.stringify({
                model: billingModel,
                messages: [
                  { role: "user", content: `load request ${item.userId}:${item.loadIndex}` },
                ],
                max_tokens: 8,
                stream: isStream,
              })
            : undefined,
          cache: "no-store",
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        const firstByteMs = Math.round(performance.now() - requestStartedAt);
        const responseBuffer = await response.arrayBuffer();
        let errorContract;
        if (response.status >= 400) {
          let responseJson;
          try {
            responseJson = JSON.parse(new TextDecoder().decode(responseBuffer));
          } catch {
            responseJson = undefined;
          }
          const error = responseJson?.error;
          const headerRequestId = response.headers.get("x-tokeninside-request-id");
          const retryAfter = response.headers.get("retry-after");
          const retryable = error?.retryable === true;
          errorContract = {
            code: typeof error?.code === "string" ? error.code : undefined,
            message: typeof error?.message === "string" ? error.message : undefined,
            requestId: typeof error?.request_id === "string" ? error.request_id : undefined,
            retryable: typeof error?.retryable === "boolean" ? error.retryable : undefined,
            retryAfterSeconds: error?.retry_after_seconds,
            headerRequestId,
            retryAfter,
            complete:
              typeof error?.code === "string" &&
              typeof error?.message === "string" &&
              typeof error?.request_id === "string" &&
              error.request_id === headerRequestId &&
              typeof error?.retryable === "boolean" &&
              (!retryable || (typeof error?.retry_after_seconds === "number" && retryAfter !== null)),
          };
        }
        return {
          status: response.status,
          isStream,
          firstByteMs,
          durationMs: Math.round(performance.now() - requestStartedAt),
          errorContract,
        };
      } catch (error) {
        return {
          status: 0,
          isStream,
          firstByteMs: 0,
          durationMs: Math.round(performance.now() - requestStartedAt),
          error: error instanceof Error ? error.name : "UnknownError",
        };
      }
    }),
  );
  const wallMs = Math.round(performance.now() - startedAt);
  const durations = results.map((item) => item.durationMs).sort((a, b) => a - b);
  const firstBytes = results
    .filter((item) => item.firstByteMs > 0)
    .map((item) => item.firstByteMs)
    .sort((a, b) => a - b);
  const modeMetrics = Object.fromEntries(
    [true, false].map((isStream) => {
      const subset = results.filter((item) => item.isStream === isStream);
      const subsetDurations = subset.map((item) => item.durationMs).sort((a, b) => a - b);
      const subsetFirstBytes = subset
        .filter((item) => item.firstByteMs > 0)
        .map((item) => item.firstByteMs)
        .sort((a, b) => a - b);
      return [
        isStream ? "stream" : "nonstream",
        {
          requests: subset.length,
          succeeded: subset.filter((item) => item.status === 200).length,
          failed: subset.filter((item) => item.status !== 200).length,
          ttftP50Ms: percentile(subsetFirstBytes, 50),
          ttftP95Ms: percentile(subsetFirstBytes, 95),
          totalP50Ms: percentile(subsetDurations, 50),
          totalP95Ms: percentile(subsetDurations, 95),
        },
      ];
    }),
  );
  const statusCounts = Object.fromEntries(
    [...new Set(results.map((item) => item.status))]
      .sort((a, b) => a - b)
      .map((status) => [String(status), results.filter((item) => item.status === status).length]),
  );
  const failures = results.filter((item) => item.status !== 200);
  const errorContracts = {
    failures: failures.length,
    complete: failures.filter((item) => item.errorContract?.complete).length,
    retryable: failures.filter((item) => item.errorContract?.retryable === true).length,
    codes: Object.fromEntries(
      [...new Set(failures.map((item) => item.errorContract?.code ?? item.error ?? "missing"))]
        .sort()
        .map((code) => [
          code,
          failures.filter(
            (item) => (item.errorContract?.code ?? item.error ?? "missing") === code,
          ).length,
        ]),
    ),
  };
  return {
    results,
    summary: {
      concurrency: items.length,
      wallMs,
      throughputRps: Number(((items.length * 1000) / Math.max(wallMs, 1)).toFixed(2)),
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      p99Ms: percentile(durations, 99),
      maxMs: durations.at(-1) ?? 0,
      ttftP50Ms: percentile(firstBytes, 50),
      ttftP95Ms: percentile(firstBytes, 95),
      ttftP99Ms: percentile(firstBytes, 99),
      ttftMaxMs: firstBytes.at(-1) ?? 0,
      modeMetrics,
      statusCounts,
      errorContracts,
    },
  };
}

async function billingSnapshot(items) {
  const userIds = items.map((item) => item.userId);
  const result = await pool.query(
    `select data
       from proxy_request_logs
      where feishu_user_id = any($1::text[])
        and request_path = '/v1/chat/completions'
      order by created_at`,
    [userIds],
  );
  const logs = result.rows.map((row) => row.data);
  const synced = logs.filter(
    (log) => log.usageSource === "newapi_log" && typeof log.usageSyncedAt === "string",
  );
  const syncDelays = synced
    .map((log) => new Date(log.usageSyncedAt).getTime() - new Date(log.createdAt).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const settlementDelays = synced
    .map(
      (log) =>
        new Date(log.usageSyncedAt).getTime() -
        new Date(log.responseTimeUpdatedAt ?? log.createdAt).getTime(),
    )
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const sourceRecords = await pool.query(
    `select count(*)::integer as count,
            coalesce(sum((data->>'totalTokens')::bigint), 0)::text as total_tokens,
            coalesce(sum((data->>'quota')::bigint), 0)::text as total_quota
       from newapi_usage_records
      where feishu_user_id = any($1::text[])
        and match_status = 'matched'`,
    [userIds],
  );
  const periods = await pool.query(
    `select count(*)::integer as count,
            coalesce(sum((data->>'totalTokens')::bigint), 0)::text as total_tokens,
            coalesce(round(sum((data->>'quotaConsumed')::numeric) * $2), 0)::text as consumed_quota
       from user_billing_periods
      where feishu_user_id = any($1::text[])`,
    [userIds, quotaPerUnit],
  );
  return {
    proxyLogs: logs.length,
    completed: logs.filter((log) => log.statusCode === 200 && log.status === "completed").length,
    synced: synced.length,
    failedUnbilled: logs.filter((log) => log.statusCode !== 200).length,
    unsyncedCompleted: logs.filter((log) => log.statusCode === 200).length - synced.length,
    sourceRecords: sourceRecords.rows[0]?.count ?? 0,
    sourceTotalTokens: Number(sourceRecords.rows[0]?.total_tokens ?? 0),
    sourceTotalQuota: Number(sourceRecords.rows[0]?.total_quota ?? 0),
    billingPeriods: periods.rows[0]?.count ?? 0,
    periodTotalTokens: Number(periods.rows[0]?.total_tokens ?? 0),
    periodConsumedQuota: Number(periods.rows[0]?.consumed_quota ?? 0),
    syncP50Ms: percentile(syncDelays, 50),
    syncP95Ms: percentile(syncDelays, 95),
    syncP99Ms: percentile(syncDelays, 99),
    syncMaxMs: syncDelays.at(-1) ?? 0,
    settlementP50Ms: percentile(settlementDelays, 50),
    settlementP95Ms: percentile(settlementDelays, 95),
    settlementP99Ms: percentile(settlementDelays, 99),
    settlementMaxMs: settlementDelays.at(-1) ?? 0,
  };
}

async function waitForBilling(items, expectedCompleted) {
  const startedAt = performance.now();
  let snapshot;
  while (performance.now() - startedAt < billingSyncTimeoutMs) {
    snapshot = await billingSnapshot(items);
    if (
      snapshot.completed === expectedCompleted &&
      snapshot.synced === expectedCompleted &&
      snapshot.sourceRecords === expectedCompleted &&
      snapshot.sourceTotalTokens === snapshot.periodTotalTokens &&
      snapshot.sourceTotalQuota === snapshot.periodConsumedQuota
    ) {
      return { ...snapshot, convergenceMs: Math.round(performance.now() - startedAt) };
    }
    await sleep(250);
  }
  return {
    ...(snapshot ?? (await billingSnapshot(items))),
    convergenceMs: Math.round(performance.now() - startedAt),
  };
}

async function localCleanup(items) {
  if (items.length === 0) return;
  const userIds = items.map((item) => item.userId);
  const accountIds = items.map((item) => item.accountId);
  const tokenIds = items.map((item) => item.tokenId);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("delete from usage_sync_issues where newapi_token_id = any($1::text[])", [tokenIds]);
    await client.query(
      "delete from newapi_usage_records where token_account_id = any($1::text[]) or feishu_user_id = any($2::text[])",
      [accountIds, userIds],
    );
    // Ledger entries are intentionally immutable. Run this destructive load
    // harness only against a disposable database; its ledger evidence remains.
    await client.query("delete from quota_reconciliation_records where feishu_user_id = any($1::text[])", [userIds]);
    await client.query("delete from quota_operations where feishu_user_id = any($1::text[])", [userIds]);
    await client.query("delete from proxy_request_logs where feishu_user_id = any($1::text[])", [userIds]);
    await client.query("delete from user_billing_periods where feishu_user_id = any($1::text[])", [userIds]);
    await client.query("delete from user_quota_policies where feishu_user_id = any($1::text[])", [userIds]);
    await client.query("delete from user_quota_states where feishu_user_id = any($1::text[])", [userIds]);
    await client.query("delete from token_accounts where id = any($1::text[])", [accountIds]);
    await client.query("delete from feishu_users where id = any($1::text[])", [userIds]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function upstreamCleanup(tokenIds) {
  const ids = tokenIds.map(Number).filter(Number.isInteger);
  if (ids.length === 0) return;
  for (let index = 0; index < ids.length; index += 100) {
    const chunk = ids.slice(index, index + 100);
    let lastError;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        await controlFetch("/api/token/batch", {
          method: "POST",
          body: JSON.stringify({ ids: chunk }),
        });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (!(error instanceof Error) || !error.message.includes("HTTP 429") || attempt === 4) {
          throw error;
        }
        await sleep(60_000);
      }
    }
    if (lastError) throw lastError;
  }
}

async function searchUpstreamTokens(keyword, expectedCount = 0) {
  const items = [];
  const maxPages = Math.max(10, Math.ceil(expectedCount / 20) + 2);
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const params = new URLSearchParams({
      keyword,
      p: String(pageNumber),
      size: "20",
    });
    const page = await controlFetch(`/api/token/search?${params.toString()}`);
    items.push(...(page.items ?? []));
    if ((page.items ?? []).length === 0 || items.length >= Number(page.total ?? items.length)) {
      break;
    }
  }
  return items;
}

async function staleUpstreamTokenIds() {
  return (await searchUpstreamTokens("gwload%"))
    .filter((item) => typeof item.name === "string" && item.name.startsWith("gwload"))
    .map((item) => String(item.id))
    .filter(Boolean);
}

async function staleLocalFixtures() {
  const result = await pool.query(
    `select user_row.id as user_id, account.id as account_id,
            account.newapi_token_id as token_id
       from feishu_users user_row
       left join token_accounts account on account.feishu_user_id = user_row.id
      where user_row.id like 'gwload\\_%' escape '\\'`,
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    accountId: row.account_id,
    tokenId: row.token_id,
  }));
}

async function cleanupStaleFixtures() {
  const [localItems, upstreamTokenIds] = await Promise.all([
    staleLocalFixtures(),
    staleUpstreamTokenIds(),
  ]);
  if (localItems.length > 0) await localCleanup(localItems);
  if (upstreamTokenIds.length > 0) await upstreamCleanup(upstreamTokenIds);
  return {
    local: localItems.length,
    upstream: upstreamTokenIds.length,
  };
}

let loadSummary;
let billingSummary;
try {
  await cleanupStaleFixtures();
  fixtures.push(...(await createUpstreamFixtures(userCount)));
  await insertLocalFixtures(fixtures);
  const loadItems = Array.from({ length: concurrency }, (_, index) => ({
    ...fixtures[index % fixtures.length],
    loadIndex: index,
  }));
  const load = await runLoad(loadItems);
  loadSummary = load.summary;
  const successCount = load.results.filter((item) => item.status === 200).length;
  const minimumSuccessCount = Math.ceil(concurrency * minSuccessRate);
  if (billable) billingSummary = await waitForBilling(loadItems, successCount);

  console.log(
    JSON.stringify({
      event: "gateway-load-measurement",
      target: new URL(targetUrl).host,
      upstream: new URL(newApiBaseUrl).host,
      billable,
      streamMode,
      users: userCount,
      requestsPerUser: Number((concurrency / userCount).toFixed(2)),
      minSuccessRate,
      minimumSuccessCount,
      ...loadSummary,
      billing: billingSummary,
    }),
  );

  assert.ok(
    successCount >= minimumSuccessCount,
    `success ${successCount}/${concurrency} is below required rate ${minSuccessRate}`,
  );
  if (billable) {
    assert.equal(billingSummary.completed, successCount);
    assert.equal(billingSummary.synced, successCount);
    assert.equal(billingSummary.sourceRecords, successCount);
    assert.equal(billingSummary.unsyncedCompleted, 0);
    assert.equal(billingSummary.sourceTotalTokens, billingSummary.periodTotalTokens);
    assert.equal(billingSummary.sourceTotalQuota, billingSummary.periodConsumedQuota);
  }
  assert.ok(
    load.summary.p95Ms <= p95LimitMs,
    `p95 ${load.summary.p95Ms}ms exceeded ${p95LimitMs}ms`,
  );
} finally {
  await sleep(1500);
  const cleanupResults = await Promise.allSettled([
    upstreamCleanup([...new Set(createdTokens)]),
    localCleanup(fixtures),
  ]);
  await pool.end();
  const cleanupErrors = cleanupResults
    .filter((item) => item.status === "rejected")
    .map((item) => (item.reason instanceof Error ? item.reason.message : String(item.reason)));
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Gateway load fixture cleanup failed");
  }
}

console.log(
  JSON.stringify({
    ok: true,
    target: new URL(targetUrl).host,
    upstream: new URL(newApiBaseUrl).host,
    scenario: "distinct-users-real-upstream",
    billable,
    streamMode,
    users: userCount,
    requestsPerUser: Number((concurrency / userCount).toFixed(2)),
    billingModel: billable ? billingModel : undefined,
    p95LimitMs,
    minSuccessRate,
    ...loadSummary,
    billing: billingSummary,
    fixturesCleaned: true,
  }),
);
