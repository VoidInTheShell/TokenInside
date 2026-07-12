import { createHmac, randomBytes } from "node:crypto";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
const appBaseUrl = (process.env.TOKENINSIDE_APP_BASE_URL ?? "http://127.0.0.1:16880").replace(
  /\/+$/,
  "",
);
const sessionSecret = process.env.TOKENINSIDE_SESSION_SECRET;
const quotaPerUnit = Number(process.env.NEWAPI_QUOTA_PER_UNIT ?? 500000);
const newApiBaseUrl = (process.env.NEWAPI_BASE_URL ?? "https://new-api.550w.link").replace(
  /\/+$/,
  "",
);
const newApiControlUserId = process.env.NEWAPI_CONTROL_USER_ID;
const newApiControlCredential = [
  process.env.NEWAPI_ACCESS_TOKEN,
  process.env.NEWAPI_ADMIN_ACCESS_TOKEN,
  process.env.NEWAPI_SYSTEM_AK,
].find((value) => typeof value === "string" && value.length > 0);

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!sessionSecret) throw new Error("TOKENINSIDE_SESSION_SECRET is required");
if (!Number.isInteger(quotaPerUnit) || quotaPerUnit <= 0) {
  throw new Error("NEWAPI_QUOTA_PER_UNIT must be a positive integer");
}

const runId = `fapp_${Date.now()}_${randomBytes(4).toString("hex")}`;
const userId = `${runId}_user`;
const ordinaryUserId = `${runId}_ordinary_user`;
const tenantKey = `${runId}_tenant`;
const openId = "ou_f_local_admin";
const ordinaryOpenId = `${runId}_ordinary_open`;
const departmentId = `${runId}_department`;
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const checks = [];
let sessionCookie;
let ordinarySessionCookie;
let cleanupComplete = false;

function hongKongPeriod(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("failed to resolve Hong Kong billing period");
  return `${year}-${month}`;
}

const period = hongKongPeriod();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function pass(name, detail) {
  checks.push({ name, ok: true, detail });
}

function redact(value) {
  return String(value)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "sk-[redacted]")
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, "[redacted]")
    .slice(0, 1000);
}

function createSessionCookie(feishuUserId = userId, feishuOpenId = openId) {
  const payload = {
    userId: feishuUserId,
    tenantKey,
    openId: feishuOpenId,
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", sessionSecret).update(body).digest("base64url");
  return `ti_session=${body}.${signature}`;
}

async function appRequest(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 180_000);
  const headers = new Headers(options.headers);
  headers.set("user-agent", "TokenInside-F-stage-local-check/1.0");
  if (options.auth !== false) headers.set("cookie", options.cookie ?? sessionCookie);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  try {
    const response = await fetch(`${appBaseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    const expected = Array.isArray(options.expectedStatus)
      ? options.expectedStatus
      : [options.expectedStatus ?? 200];
    if (!expected.includes(response.status)) {
      const message = json?.error ?? json?.message ?? text ?? "empty response";
      throw new Error(
        `${options.method ?? "GET"} ${path} returned ${response.status}: ${redact(message)}`,
      );
    }
    return { status: response.status, json, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForOperation(operationId, timeoutMs = 180_000, cookie = sessionCookie) {
  const deadline = Date.now() + timeoutMs;
  let lastState = "unknown";
  while (Date.now() < deadline) {
    const response = await appRequest(`/api/quota-operations/${encodeURIComponent(operationId)}`, {
      cookie,
    });
    const operation = response.json?.operation;
    assert(operation?.id === operationId, `operation ${operationId} was not returned`);
    lastState = operation.state;
    if (lastState === "completed") return response.json;
    if (lastState === "compensated" || lastState === "manual_review") {
      throw new Error(`operation ${operationId} terminated in ${lastState}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`operation ${operationId} timed out in ${lastState}`);
}

async function modelsWithRetry(key, label, maxAttempts = 5) {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await appRequest("/v1/models", {
      auth: false,
      expectedStatus: [200, 429, 502, 503, 504],
      headers: { authorization: `Bearer ${key}` },
    });
    lastStatus = response.status;
    if (response.status === 200) {
      assert(Array.isArray(response.json?.data), `${label} did not return a model list`);
      return { ...response, attempts: attempt };
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
  throw new Error(`${label} remained unavailable after ${maxAttempts} attempts: ${lastStatus}`);
}

async function seedLocalScenario() {
  const now = new Date();
  const nowIso = now.toISOString();
  const settledThrough = new Date(now.getTime() - 60_000).toISOString();
  const settings = {
    defaultMonthlyQuota: 200,
    usageSyncPolicy: {
      enabled: false,
      intervalMinutes: 60,
      pageSize: 100,
      maxPagesPerRun: 3,
      overlapMinutes: 120,
      settlementLagMinutes: 5,
      matchWindowMinutes: 30,
      retryBaseMinutes: 5,
      updatedAt: nowIso,
      updatedByFeishuUserId: userId,
    },
    quotaFeatureFlags: {
      legacyAbsoluteQuotaWritesEnabled: false,
      quotaLedgerShadowRead: true,
      quotaSagaWritesEnabled: true,
      keyRotationSagaEnabled: true,
      quotaRestoreEnabled: true,
      monthlyPeriodOpenEnabled: true,
      reconciliationAutoDecreaseEnabled: false,
      reconciliationAutoIncreaseEnabled: false,
    },
    quotaMigration: {
      period,
      appliedAt: nowIso,
      planHash: `${runId}_local_only`,
      users: 0,
      estimatedUsers: 0,
    },
    billingOperations: [],
    updatedAt: nowIso,
    updatedByFeishuUserId: userId,
  };
  const user = {
    id: userId,
    tenantKey,
    openId,
    name: "F-stage local Docker check",
    departmentId,
    departmentName: "F-stage isolated department",
    status: "active",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const adminScope = {
    id: `${runId}_admin_scope`,
    feishuUserId: userId,
    scopeType: "global",
    source: "manual",
    status: "active",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const department = {
    id: `${runId}_department_period`,
    departmentId,
    departmentName: user.departmentName,
    period,
    quotaLimit: 0,
    defaultGrantQuota: 200,
    createdAt: nowIso,
    updatedAt: nowIso,
    updatedByFeishuUserId: userId,
  };
  const checkpoint = {
    id: `${runId}_checkpoint`,
    scope: "newapi_usage_logs",
    pageStart: 0,
    pageSize: 100,
    maxPages: 3,
    overlapMinutes: 120,
    matchWindowMinutes: 30,
    lastRunAt: nowIso,
    lastRunStatus: "applied",
    lastRunBy: "manual",
    lastRunSummary: { localFStageCheck: true },
    scanStart: new Date(now.getTime() - 120 * 60_000).toISOString(),
    scanEnd: settledThrough,
    settledThrough,
    cursorPage: 0,
    failureCount: 0,
    updatedAt: nowIso,
  };

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into app_settings (id, data) values ('default', $1)
       on conflict (id) do update set data = excluded.data`,
      [settings],
    );
    await client.query(
      `insert into feishu_users
        (id, tenant_key, open_id, department_id, data, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [user.id, user.tenantKey, user.openId, user.departmentId, user, nowIso, nowIso],
    );
    const ordinaryUser = {
      ...user,
      id: ordinaryUserId,
      openId: ordinaryOpenId,
      name: "F-stage synced ordinary user",
    };
    await client.query(
      `insert into feishu_users
        (id, tenant_key, open_id, department_id, data, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        ordinaryUser.id,
        ordinaryUser.tenantKey,
        ordinaryUser.openId,
        ordinaryUser.departmentId,
        ordinaryUser,
        nowIso,
        nowIso,
      ],
    );
    await client.query(
      `insert into admin_scopes
        (id, feishu_user_id, scope_type, department_id, source, status,
         data, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        adminScope.id,
        adminScope.feishuUserId,
        adminScope.scopeType,
        null,
        adminScope.source,
        adminScope.status,
        adminScope,
        nowIso,
        nowIso,
      ],
    );
    await client.query(
      `insert into department_quota_periods
        (id, department_id, period, data, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6)`,
      [department.id, department.departmentId, department.period, department, nowIso, nowIso],
    );
    await client.query(
      `insert into usage_sync_checkpoints (id, scope, data, updated_at)
       values ($1,$2,$3,$4)
       on conflict (scope) do update set data = excluded.data, updated_at = excluded.updated_at`,
      [checkpoint.id, checkpoint.scope, checkpoint, checkpoint.updatedAt],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  pass("isolated_seed", { period, user: "unique", department: "unique" });
}

async function operationByIdempotencyKey(idempotencyKey) {
  const result = await pool.query(
    "select data from quota_operations where idempotency_key = $1",
    [idempotencyKey],
  );
  return result.rows[0]?.data;
}

async function quotaSnapshot(feishuUserId = userId) {
  const ledger = await pool.query(
    `select coalesce(sum(signed_quota), 0)::text as total, count(*)::integer as entries
     from quota_ledger_entries where feishu_user_id = $1 and period = $2`,
    [feishuUserId, period],
  );
  const policy = await pool.query(
    `select data from user_quota_policies
     where feishu_user_id = $1
     order by version desc limit 1`,
    [feishuUserId],
  );
  return {
    total: Number(ledger.rows[0]?.total ?? 0),
    entries: Number(ledger.rows[0]?.entries ?? 0),
    policy: policy.rows[0]?.data,
  };
}

async function tokenAccounts(feishuUserId = userId) {
  const result = await pool.query(
    `select newapi_token_id, status, data
     from token_accounts where feishu_user_id = $1 order by created_at`,
    [feishuUserId],
  );
  return result.rows;
}

async function insertInflightRequestForActiveToken(
  feishuUserId = userId,
  label = "rotation",
) {
  const accounts = await tokenAccounts(feishuUserId);
  const active = accounts.find((row) => row.status === "active");
  assert(active?.data?.id, "active token is unavailable for inflight fixture");
  const now = new Date();
  const log = {
    id: `${runId}_${feishuUserId === userId ? "admin" : "ordinary"}_${label}_inflight`,
    feishuUserId,
    tokenAccountId: active.data.id,
    requestPath: "/v1/chat/completions",
    method: "POST",
    statusCode: 0,
    status: "streaming",
    billingPeriod: period,
    operationGeneration: active.data.operationGeneration ?? 0,
    heartbeatAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + 120_000).toISOString(),
    createdAt: now.toISOString(),
  };
  await pool.query(
    `insert into proxy_request_logs
      (id, feishu_user_id, token_account_id, request_path, method, status_code,
       billing_period, operation_generation, lease_expires_at, heartbeat_at, data, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      log.id,
      log.feishuUserId,
      log.tokenAccountId,
      log.requestPath,
      log.method,
      log.statusCode,
      log.billingPeriod,
      log.operationGeneration,
      log.leaseExpiresAt,
      log.heartbeatAt,
      log,
      log.createdAt,
    ],
  );
  return log;
}

async function completeInflightRequest(logId) {
  await pool.query(
    `update proxy_request_logs
     set lease_expires_at = null,
         data = data || $2::jsonb
     where id = $1`,
    [
      logId,
      JSON.stringify({
        status: "completed",
        terminalStatus: "completed",
        statusCode: 200,
        leaseExpiresAt: null,
        heartbeatAt: new Date().toISOString(),
      }),
    ],
  );
}

async function waitForOperationPhase(operationId, expectedStates, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const operation = await operationById(operationId);
    if (operation && expectedStates.includes(operation.state)) return operation;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`operation ${operationId} did not reach ${expectedStates.join(",")}`);
}

async function operationById(operationId) {
  const result = await pool.query("select data from quota_operations where id = $1", [operationId]);
  return result.rows[0]?.data;
}

async function simulateLegacyObservationManualReview(operationId) {
  const operation = await operationById(operationId);
  assert(operation?.state === "draining", "legacy observation fixture requires draining state");
  const updatedAt = new Date().toISOString();
  const legacyOperation = {
    ...operation,
    state: "manual_review",
    nextRetryAt: undefined,
    lastErrorCode: "newapi_observation_unstable",
    lastErrorMessage: "NewAPI token 余额观测不稳定",
    updatedAt,
    evidence: {
      ...operation.evidence,
      retryFromState: "draining",
    },
  };
  await pool.query(
    `update quota_operations
     set state = 'manual_review', next_retry_at = null, data = $2::jsonb, updated_at = $3
     where id = $1`,
    [operationId, JSON.stringify(legacyOperation), updatedAt],
  );
}

async function insertSettledUsageForActiveToken(quota) {
  const accounts = await tokenAccounts();
  const active = accounts.find((row) => row.status === "active");
  assert(active?.newapi_token_id, "active token is unavailable for settled usage fixture");
  const now = new Date().toISOString();
  const record = {
    id: `${runId}_rotation_usage`,
    newapiLogId: `${runId}_rotation_log`,
    newapiRequestId: `${runId}_rotation_request`,
    newapiTokenId: String(active.newapi_token_id),
    tokenAccountId: active.data.id,
    feishuUserId: userId,
    departmentId,
    billingPeriod: period,
    matchStatus: "no_proxy_match",
    model: "f-stage-settled-fixture",
    quota,
    cost: quota / quotaPerUnit,
    newapiType: "2",
    newapiCreatedAt: now,
    firstSeenAt: now,
    lastSyncedAt: now,
  };
  await pool.query(
    `insert into newapi_usage_records
      (id, newapi_log_id, newapi_request_id, newapi_token_id, token_account_id,
       feishu_user_id, match_status, data, newapi_created_at, first_seen_at, last_synced_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      record.id,
      record.newapiLogId,
      record.newapiRequestId,
      record.newapiTokenId,
      record.tokenAccountId,
      record.feishuUserId,
      record.matchStatus,
      record,
      record.newapiCreatedAt,
      record.firstSeenAt,
      record.lastSyncedAt,
    ],
  );
  return record;
}

async function billingSnapshot(feishuUserId = userId) {
  const result = await pool.query(
    `select data from user_billing_periods
     where feishu_user_id = $1 and period = $2`,
    [feishuUserId, period],
  );
  return result.rows[0]?.data;
}

async function departmentSnapshot() {
  const result = await pool.query(
    `select data from department_quota_periods
     where department_id = $1 and period = $2`,
    [departmentId, period],
  );
  return result.rows[0]?.data;
}

function newApiControlHeaders() {
  if (!newApiControlCredential || !newApiControlUserId) {
    throw new Error("NewAPI control credentials are required for scoped test cleanup verification");
  }
  return {
    authorization: newApiControlCredential,
    "New-Api-User": newApiControlUserId,
    "LLMAPI-User": newApiControlUserId,
    "content-type": "application/json; charset=utf-8",
  };
}

async function getUpstreamTokenState(tokenId) {
  const response = await fetch(`${newApiBaseUrl}/api/token/${encodeURIComponent(tokenId)}`, {
    headers: newApiControlHeaders(),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(`failed to verify scoped NewAPI test token ${tokenId}: ${response.status}`);
  }
  return body.data ?? body;
}

async function disableUpstreamToken(tokenId) {
  const normalizedId = Number.isNaN(Number(tokenId)) ? tokenId : Number(tokenId);
  const response = await fetch(`${newApiBaseUrl}/api/token/?status_only=true`, {
    method: "PUT",
    headers: newApiControlHeaders(),
    body: JSON.stringify({ id: normalizedId, status: 2 }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(`failed to disable scoped NewAPI test token ${tokenId}: ${response.status}`);
  }
}

async function forceDisableCreatedUpstreamTokens() {
  const accounts = (
    await Promise.all([tokenAccounts(userId), tokenAccounts(ordinaryUserId)])
  ).flat();
  const tokenIds = [
    ...new Set(accounts.map((row) => row.newapi_token_id).filter(Boolean).map(String)),
  ];
  for (const tokenId of tokenIds) await disableUpstreamToken(tokenId);
  return tokenIds.length;
}

async function allFStageTestTokenIds() {
  const result = await pool.query(
    `select distinct account.newapi_token_id
     from token_accounts account
     where account.feishu_user_id = any($1::text[])
       and account.newapi_token_id is not null`,
    [[userId, ordinaryUserId]],
  );
  return result.rows.map((row) => String(row.newapi_token_id));
}

async function verifyCreatedUpstreamTokensDisabled() {
  const [rootAccounts, ordinaryAccounts] = await Promise.all([
    tokenAccounts(userId),
    tokenAccounts(ordinaryUserId),
  ]);
  const rootTokenIds = [
    ...new Set(rootAccounts.map((row) => row.newapi_token_id).filter(Boolean).map(String)),
  ];
  const ordinaryTokenIds = [
    ...new Set(
      ordinaryAccounts.map((row) => row.newapi_token_id).filter(Boolean).map(String),
    ),
  ];
  assert(
    rootTokenIds.length === 3,
    `expected three root upstream tokens across two changes, got ${rootTokenIds.length}`,
  );
  assert(
    ordinaryTokenIds.length === 2,
    `expected two ordinary-user upstream tokens across one change, got ${ordinaryTokenIds.length}`,
  );
  const tokenIds = await allFStageTestTokenIds();
  assert(tokenIds.length === 5, `expected five isolated upstream tokens, got ${tokenIds.length}`);
  let repaired = 0;
  for (const tokenId of tokenIds) {
    let state = await getUpstreamTokenState(tokenId);
    if (state.status !== 2) {
      await disableUpstreamToken(tokenId);
      repaired += 1;
      state = await getUpstreamTokenState(tokenId);
    }
    assert(state.status === 2, `scoped upstream test token ${tokenId} is not disabled`);
  }
  pass("upstream_cleanup_verified", {
    rootTokens: rootTokenIds.length,
    ordinaryTokens: ordinaryTokenIds.length,
    sessionTestTokens: tokenIds.length,
    repaired,
    status: "disabled",
  });
}

async function waitForTestOperationsToSettle(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `select count(*)::integer as count
       from quota_operations
       where feishu_user_id = any($1::text[])
         and state not in ('completed', 'compensated', 'manual_review')`,
      [[userId, ordinaryUserId]],
    );
    if (result.rows[0]?.count === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function run() {
  sessionCookie = createSessionCookie();
  ordinarySessionCookie = createSessionCookie(ordinaryUserId, ordinaryOpenId);
  await seedLocalScenario();

  const health = await appRequest("/api/health", { auth: false });
  assert(health.json?.status === "ok", "application health is not ok");
  assert(health.json?.store?.type === "postgres", "application is not using PostgreSQL");
  assert(health.json?.store?.schema?.ready === true, "PostgreSQL schema is not ready");
  assert(health.json?.configuration?.newapiMock === false, "NewAPI mock must be disabled");
  pass("docker_app_health", { store: "postgres", newapi: "real-test-gateway" });

  const blockedAllocation = await appRequest(
    `/api/admin/users/${encodeURIComponent(userId)}/quota-adjust`,
    {
      method: "POST",
      expectedStatus: 502,
      body: {
        approvedMonthlyQuota: 10,
        reason: "F-stage zero-budget allocation",
        clientRequestId: `${runId}_blocked_allocate`,
      },
    },
  );
  assert(
    String(blockedAllocation.json?.error ?? "").includes("部门可用额度不足"),
    "zero-budget allocation did not return the department budget error",
  );
  const blockedRequests = await pool.query(
    `select data from token_requests
     where feishu_user_id = $1 and request_type = 'first_apply'
     order by created_at`,
    [userId],
  );
  assert(blockedRequests.rowCount === 1, "zero-budget allocation created duplicate requests");
  assert(
    blockedRequests.rows[0]?.data?.status === "approved_provision_failed",
    "zero-budget allocation was not recorded as failed",
  );
  const blockedAccounts = await tokenAccounts();
  assert(blockedAccounts.length === 0, "zero-budget allocation created a token account");
  pass("zero_budget_fails_without_false_success", {
    status: blockedAllocation.status,
    requests: blockedRequests.rowCount,
    tokenAccounts: 0,
  });

  await appRequest("/api/admin/department-quota", {
    method: "PATCH",
    body: { departmentId, quotaLimit: 1000 },
  });

  const firstAllocation = await appRequest(
    `/api/admin/users/${encodeURIComponent(userId)}/quota-adjust`,
    {
      method: "POST",
      expectedStatus: [200, 502],
      body: {
        approvedMonthlyQuota: 10,
        reason: "F-stage local first allocation",
        clientRequestId: `${runId}_preallocate`,
      },
    },
  );
  if (firstAllocation.status === 200) {
    assert(firstAllocation.json?.mode === "first_provision", "no-key allocation used the wrong mode");
    assert(firstAllocation.json?.account?.status === "active", "no-key allocation did not return an active account");
  } else {
    assert(
      String(firstAllocation.json?.error ?? "").includes("NewAPI request failed"),
      "transient first-provision failure was not reported as an upstream error",
    );
  }
  const firstRequestId = firstAllocation.json?.request?.id ?? blockedRequests.rows[0]?.data?.id;
  assert(firstRequestId, "first-provision request id is missing");
  assert(
    firstRequestId === blockedRequests.rows[0]?.data?.id,
    "budget recovery did not reuse the failed first-apply request",
  );
  const recoveredRequestCount = await pool.query(
    `select count(*)::integer as count from token_requests
     where feishu_user_id = $1 and request_type = 'first_apply'`,
    [userId],
  );
  assert(
    recoveredRequestCount.rows[0]?.count === 1,
    "budget recovery created a duplicate first-apply request",
  );
  const firstOperation = await operationByIdempotencyKey(
    `quota-operation:${firstRequestId}`,
  );
  assert(firstOperation?.id, "first-provision operation was not created");
  const firstResult = await waitForOperation(firstOperation.id);
  const firstKey = firstResult.key;
  assert(typeof firstKey === "string" && firstKey.length > 0, "first credential is unavailable");
  const firstCompleted = await operationByIdempotencyKey(
    `quota-operation:${firstRequestId}`,
  );
  assert(
    firstCompleted?.evidence?.authorizationDelta === 10 * quotaPerUnit,
    "first allocation authorization delta is incorrect",
  );
  let snapshot = await quotaSnapshot();
  assert(snapshot.total === 10 * quotaPerUnit, "first allocation ledger total is incorrect");
  assert(
    snapshot.policy?.assignedMonthlyQuota === 10 * quotaPerUnit,
    "first allocation policy is incorrect",
  );
  const periodOpenMarker = await pool.query(
    `select signed_quota from quota_ledger_entries
     where operation_id = $1 and entry_type = 'period_open_authorization'`,
    [firstOperation.id],
  );
  assert(periodOpenMarker.rowCount === 1, "first provision did not write a period-open marker");
  assert(
    Number(periodOpenMarker.rows[0].signed_quota) === 10 * quotaPerUnit,
    "period-open marker does not contain the first authorization",
  );
  const firstAccounts = await tokenAccounts();
  assert(
    firstAccounts.filter((row) => row.status === "active").length === 1,
    "first provision did not create exactly one active account",
  );
  pass("no_key_allocation_provisions_key", {
    allocationStatus: firstAllocation.status,
    recoveredFromTransientUpstreamFailure: firstAllocation.status === 502,
    authorizationDelta: 10 * quotaPerUnit,
    periodOpenMarker: true,
  });
  const ordinaryBilling = await pool.query(
    `select data from user_billing_periods
     where feishu_user_id = $1 and period = $2`,
    [ordinaryUserId, period],
  );
  const ordinaryAccounts = await pool.query(
    "select count(*)::integer as count from token_accounts where feishu_user_id = $1",
    [ordinaryUserId],
  );
  assert(
    ordinaryBilling.rows[0]?.data?.monthlyQuota === 0 &&
      ordinaryBilling.rows[0]?.data?.remainingQuota === 0,
    "synced ordinary user inherited quota without approval",
  );
  assert(ordinaryAccounts.rows[0]?.count === 0, "synced ordinary user received a key");
  pass("synced_user_remains_unassigned", {
    monthlyQuota: 0,
    remainingQuota: 0,
    tokenAccounts: 0,
  });
  const firstModels = await modelsWithRetry(firstKey, "first key model discovery");
  pass("gateway_first_key", {
    status: 200,
    attempts: firstModels.attempts,
    models: firstModels.json.data.length,
  });

  const adjustment = await appRequest(
    `/api/admin/users/${encodeURIComponent(userId)}/quota-adjust`,
    {
      method: "POST",
      expectedStatus: 202,
      body: {
        approvedMonthlyQuota: 12,
        reason: "F-stage local active adjustment",
        clientRequestId: `${runId}_active_adjust`,
      },
    },
  );
  const adjustmentId = adjustment.json?.operation?.id;
  assert(adjustmentId, "active adjustment operation id is missing");
  await waitForOperation(adjustmentId);
  snapshot = await quotaSnapshot();
  assert(snapshot.total === 12 * quotaPerUnit, "active adjustment ledger total is incorrect");
  assert(
    snapshot.policy?.assignedMonthlyQuota === 12 * quotaPerUnit,
    "active adjustment policy is incorrect",
  );
  pass("active_quota_adjustment", { ledgerQuota: snapshot.total, policyQuota: 12 * quotaPerUnit });

  const settledUsage = await insertSettledUsageForActiveToken(2 * quotaPerUnit);
  pass("rotation_settled_usage_fixture", {
    quota: settledUsage.quota,
    expectedAvailableQuota: 10 * quotaPerUnit,
  });

  const resetUpperLimit = await appRequest(
    `/api/admin/users/${encodeURIComponent(userId)}/quota-adjust`,
    {
      method: "POST",
      expectedStatus: 202,
      body: {
        approvedMonthlyQuota: 14,
        reason: "F-stage reset upper limit without clearing consumption",
        clientRequestId: `${runId}_reset_upper_limit`,
      },
    },
  );
  await waitForOperation(resetUpperLimit.json?.operation?.id);
  const afterUpperLimitReset = await billingSnapshot();
  assert(
    afterUpperLimitReset?.authorizedQuota === 14 * quotaPerUnit,
    "upper-limit reset did not update authorization",
  );
  assert(
    afterUpperLimitReset?.authoritativeConsumedQuota === 2 * quotaPerUnit,
    "upper-limit reset cleared settled consumption",
  );
  assert(
    afterUpperLimitReset?.expectedAvailableQuota === 12 * quotaPerUnit,
    "upper-limit reset produced the wrong available quota",
  );
  pass("quota_limit_reset_preserves_consumption", {
    authorizedQuota: afterUpperLimitReset.authorizedQuota,
    authoritativeConsumedQuota: afterUpperLimitReset.authoritativeConsumedQuota,
  });

  const inflight = await insertInflightRequestForActiveToken();
  const rotation = await appRequest("/api/token/reset", {
    method: "POST",
    expectedStatus: 202,
    body: {
      reason: "F-stage local safe key rotation",
      clientRequestId: `${runId}_rotation`,
    },
  });
  const rotationId = rotation.json?.operation?.id;
  assert(rotationId, "rotation operation id is missing");
  await waitForOperationPhase(rotationId, ["draining"]);
  await simulateLegacyObservationManualReview(rotationId);
  await appRequest("/v1/models", {
    auth: false,
    expectedStatus: 409,
    headers: { authorization: `Bearer ${firstKey}` },
  });
  await completeInflightRequest(inflight.id);
  await waitForOperationPhase(
    rotationId,
    [
      "planned",
      "local_prepared",
      "admission_closed",
      "upstream_frozen",
      "draining",
      "snapshot_stable",
      "upstream_applying",
      "upstream_applied",
      "upstream_activated",
      "local_finalized",
      "reconciling",
      "completed",
    ],
    60_000,
  );
  const rotationResult = await waitForOperation(rotationId);
  const rotatedKey = rotationResult.key;
  assert(typeof rotatedKey === "string" && rotatedKey.length > 0, "rotated credential is unavailable");

  await appRequest("/v1/models", {
    auth: false,
    expectedStatus: 403,
    headers: { authorization: `Bearer ${firstKey}` },
  });
  const rotatedModels = await modelsWithRetry(rotatedKey, "rotated key model discovery");
  const rotatedAccounts = await tokenAccounts();
  assert(rotatedAccounts.length === 2, "rotation did not retain two account generations");
  assert(
    rotatedAccounts.filter((row) => row.status === "active").length === 1,
    "rotation did not leave exactly one active account",
  );
  const oldAccount = rotatedAccounts.find((row) => row.status === "replaced");
  const activeAccount = rotatedAccounts.find((row) => row.status === "active");
  assert(oldAccount?.newapi_token_id, "rotation did not retain the old upstream token id");
  assert(activeAccount?.newapi_token_id, "rotation did not persist the new upstream token id");
  const [oldUpstream, activeUpstream] = await Promise.all([
    getUpstreamTokenState(oldAccount.newapi_token_id),
    getUpstreamTokenState(activeAccount.newapi_token_id),
  ]);
  assert(Number(oldUpstream.status) !== 1, "rotation left the old upstream key enabled");
  assert(Number(activeUpstream.status) === 1, "rotation did not enable the new upstream key");
  assert(
    Number(activeUpstream.remain_quota) === 12 * quotaPerUnit,
    `rotated key inherited ${activeUpstream.remain_quota} instead of the settled user remainder`,
  );
  snapshot = await quotaSnapshot();
  assert(snapshot.total === 14 * quotaPerUnit, "rotation changed ledger authorization");
  const billing = await billingSnapshot();
  assert(
    billing?.authorizedQuota === 14 * quotaPerUnit,
    "rotation changed the user-period authorization",
  );
  assert(
    billing?.authoritativeConsumedQuota === 2 * quotaPerUnit,
    "rotation did not preserve authoritative settled usage",
  );
  assert(
    billing?.expectedAvailableQuota === 12 * quotaPerUnit,
    "rotation materialized an incorrect user-period remainder",
  );
  assert(
    Array.isArray(billing?.tokenAccountIds) && billing.tokenAccountIds.length === 2,
    "rotation did not keep both token generations in the user period",
  );
  const department = await departmentSnapshot();
  assert(
    department?.committedAuthorizedQuota === 14 * quotaPerUnit,
    "rotation changed department committed authorization",
  );
  assert(
    department?.pendingReservedQuota === 0,
    "rotation left a department budget reservation behind",
  );
  const approvalBoundary = encodeURIComponent(
    new Date(Date.now() - 60 * 60_000).toISOString(),
  );
  const approvalQueue = await appRequest(
    `/api/admin/token-requests?createdAfter=${approvalBoundary}&decisionRequired=true&limit=100`,
  );
  assert(
    approvalQueue.json?.requests?.every((request) => request.requestType !== "key_reset"),
    "approval handling still includes key rotation records",
  );
  const rotationRequestId = rotation.json?.request?.id;
  assert(rotationRequestId, "rotation request id is missing");
  const accountCountBeforeRejectedDecision = rotatedAccounts.length;
  await pool.query(
    `update token_requests
     set status = 'approved_provision_failed',
         data = data || $2::jsonb
     where id = $1`,
    [
      rotationRequestId,
      JSON.stringify({
        status: "approved_provision_failed",
        errorMessage: "isolated approval hard-gate fixture",
      }),
    ],
  );
  await appRequest(
    `/api/admin/token-requests/${encodeURIComponent(rotationRequestId)}/decision`,
    {
      method: "POST",
      expectedStatus: 409,
      body: { action: "approve", approvedMonthlyQuota: 14 },
    },
  );
  await appRequest(
    `/api/admin/token-requests/${encodeURIComponent(rotationRequestId)}/quota`,
    {
      method: "PATCH",
      expectedStatus: 409,
      body: { approvedMonthlyQuota: 14 },
    },
  );
  assert(
    (await tokenAccounts()).length === accountCountBeforeRejectedDecision,
    "rejected key-change approval created another token account",
  );
  await pool.query(
    `update token_requests
     set status = 'provisioned',
         data = data || $2::jsonb
     where id = $1`,
    [
      rotationRequestId,
      JSON.stringify({ status: "provisioned", errorMessage: null }),
    ],
  );
  pass("safe_key_rotation", {
    oldLocalStatus: 403,
    newLocalStatus: 200,
    newKeyAttempts: rotatedModels.attempts,
    activeAccounts: 1,
    ledgerUnchanged: true,
    inheritedRemainQuota: Number(activeUpstream.remain_quota),
    authoritativeConsumedQuota: billing.authoritativeConsumedQuota,
    departmentAuthorizationUnchanged: true,
    keyResetExcludedFromApprovals: true,
    keyResetDecisionHardBlocked: true,
    oldKeyBlockedWhileInflight: true,
    legacyObservationFailureAutoResumed: true,
  });

  const ordinaryAllocation = await appRequest(
    `/api/admin/users/${encodeURIComponent(ordinaryUserId)}/quota-adjust`,
    {
      method: "POST",
      expectedStatus: [200, 502],
      body: {
        approvedMonthlyQuota: 5,
        reason: "F-stage ordinary-user first approval",
        clientRequestId: `${runId}_ordinary_first_apply`,
      },
    },
  );
  const ordinaryRequestRow = ordinaryAllocation.json?.request?.id
    ? undefined
    : await pool.query(
        `select id from token_requests
         where feishu_user_id = $1 and request_type = 'first_apply'
         order by created_at desc limit 1`,
        [ordinaryUserId],
      );
  const ordinaryRequestId =
    ordinaryAllocation.json?.request?.id ?? ordinaryRequestRow?.rows[0]?.id;
  assert(ordinaryRequestId, "ordinary-user first request id is missing");
  const ordinaryFirstOperation = await operationByIdempotencyKey(
    `quota-operation:${ordinaryRequestId}`,
  );
  assert(ordinaryFirstOperation?.id, "ordinary-user first operation is missing");
  const ordinaryFirstResult = await waitForOperation(
    ordinaryFirstOperation.id,
    180_000,
    ordinarySessionCookie,
  );
  const ordinaryFirstKey = ordinaryFirstResult.key;
  assert(typeof ordinaryFirstKey === "string", "ordinary-user first Key is unavailable");
  await modelsWithRetry(ordinaryFirstKey, "ordinary-user first key model discovery");
  const ordinarySession = await appRequest("/api/session", {
    cookie: ordinarySessionCookie,
  });
  assert(
    ordinarySession.json?.activeToken?.status === "active",
    "ordinary user cannot enter the active Key interface after approval",
  );

  const adminRaceInflight = await insertInflightRequestForActiveToken(userId, "race");
  const ordinaryRaceInflight = await insertInflightRequestForActiveToken(
    ordinaryUserId,
    "race",
  );
  const [adminRace, ordinaryRaceA, ordinaryRaceB] = await Promise.all([
    appRequest("/api/token/reset", {
      method: "POST",
      expectedStatus: 202,
      body: {
        reason: "F-stage global-admin self key change race",
        clientRequestId: `${runId}_admin_race_rotation`,
      },
    }),
    appRequest("/api/token/reset", {
      method: "POST",
      cookie: ordinarySessionCookie,
      expectedStatus: [202, 400, 409],
      body: {
        reason: "F-stage ordinary-user key change race A",
        clientRequestId: `${runId}_ordinary_race_a`,
      },
    }),
    appRequest("/api/token/reset", {
      method: "POST",
      cookie: ordinarySessionCookie,
      expectedStatus: [202, 400, 409],
      body: {
        reason: "F-stage ordinary-user key change race B",
        clientRequestId: `${runId}_ordinary_race_b`,
      },
    }),
  ]);
  const ordinaryAccepted = [ordinaryRaceA, ordinaryRaceB].filter(
    (response) => response.status === 202,
  );
  const ordinaryRejected = [ordinaryRaceA, ordinaryRaceB].filter(
    (response) => response.status !== 202,
  );
  assert(
    ordinaryAccepted.length === 1 && ordinaryRejected.length === 1,
    "same-user concurrent Key changes did not produce exactly one winner",
  );
  const adminRaceOperationId = adminRace.json?.operation?.id;
  const ordinaryRaceOperationId = ordinaryAccepted[0].json?.operation?.id;
  assert(adminRaceOperationId && ordinaryRaceOperationId, "race operation ids are missing");
  await Promise.all([
    waitForOperationPhase(adminRaceOperationId, ["draining"]),
    waitForOperationPhase(ordinaryRaceOperationId, ["draining"]),
  ]);
  await Promise.all([
    appRequest("/v1/models", {
      auth: false,
      expectedStatus: 409,
      headers: { authorization: `Bearer ${rotatedKey}` },
    }),
    appRequest("/v1/models", {
      auth: false,
      expectedStatus: 409,
      headers: { authorization: `Bearer ${ordinaryFirstKey}` },
    }),
  ]);
  await Promise.all([
    completeInflightRequest(adminRaceInflight.id),
    completeInflightRequest(ordinaryRaceInflight.id),
  ]);
  const [adminRaceResult, ordinaryRaceResult] = await Promise.all([
    waitForOperation(adminRaceOperationId),
    waitForOperation(ordinaryRaceOperationId, 180_000, ordinarySessionCookie),
  ]);
  await Promise.all([
    modelsWithRetry(adminRaceResult.key, "global-admin replacement key"),
    modelsWithRetry(ordinaryRaceResult.key, "ordinary-user replacement key"),
  ]);
  assert(
    (await tokenAccounts(userId)).filter((account) => account.status === "active").length === 1,
    "global admin did not retain exactly one active Key after concurrent changes",
  );
  assert(
    (await tokenAccounts(ordinaryUserId)).filter((account) => account.status === "active").length === 1,
    "ordinary user did not retain exactly one active Key after concurrent changes",
  );
  assert(
    (await quotaSnapshot(userId)).total === 14 * quotaPerUnit,
    "global-admin Key change race changed authorization",
  );
  assert(
    (await quotaSnapshot(ordinaryUserId)).total === 5 * quotaPerUnit,
    "ordinary-user Key change race changed authorization",
  );
  pass("ordinary_admin_and_multi_user_rotation", {
    ordinaryEnteredActiveInterface: true,
    sameUserWinners: 1,
    differentUsersCompleted: 2,
    oldKeysBlockedDuringDrain: 2,
    authorizationUnchanged: true,
  });

  const monthly = await appRequest("/api/admin/billing/monthly-reset", {
    method: "POST",
    body: { period, dryRun: true },
  });
  const departmentPlan = monthly.json?.departments?.find(
    (item) => item.departmentId === departmentId,
  );
  assert(monthly.json?.blocked === false, "monthly preflight is unexpectedly blocked");
  assert(departmentPlan?.alreadyOpenedUsers === 2, "monthly preflight missed prior opening");
  assert(departmentPlan?.users?.length === 0, "monthly preflight would authorize the user twice");
  pass("monthly_open_idempotency", { alreadyOpenedUsers: 2, pendingUsers: 0 });

  const reconciliation = await appRequest("/api/admin/quota-control?observe=true");
  const row = reconciliation.json?.report?.rows?.find(
    (item) => item.feishuUserId === userId,
  );
  assert(row?.status === "healthy", `reconciliation status is ${row?.status ?? "missing"}`);
  assert(row?.observedStable === true, "reconciliation did not obtain two stable reads");
  assert(row?.expectedAvailableQuota === 12 * quotaPerUnit, "reconciliation expected quota is wrong");
  assert(row?.observedRemainQuota === 12 * quotaPerUnit, "reconciliation observed quota is wrong");
  pass("shadow_reconciliation", {
    status: "healthy",
    stableReads: 2,
    expectedQuota: row.expectedAvailableQuota,
  });

  await appRequest(`/api/admin/users/${encodeURIComponent(ordinaryUserId)}/disable`, {
    method: "POST",
    body: { reason: "F-stage ordinary-user local check cleanup" },
  });
  await appRequest(`/api/admin/users/${encodeURIComponent(userId)}/disable`, {
    method: "POST",
    body: { reason: "F-stage local check cleanup" },
  });
  cleanupComplete = true;
  const activeAfterCleanup = await pool.query(
    `select count(*)::integer as count from token_accounts
     where feishu_user_id = any($1::text[]) and status = 'active'`,
    [[userId, ordinaryUserId]],
  );
  assert(activeAfterCleanup.rows[0].count === 0, "local active account remained after cleanup");
  await verifyCreatedUpstreamTokensDisabled();
  pass("local_cleanup_verified", { activeAccounts: 0, userStatus: "disabled" });

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        runId,
        period,
        checks,
        safety: {
          isolatedUser: true,
          credentialsPrinted: false,
          createdUpstreamTokensDisabled: true,
          productionFlagsChanged: false,
        },
      },
      null,
      2,
    )}\n`,
  );
}

let runError;
try {
  await run();
} catch (error) {
  runError = error;
} finally {
  if (!cleanupComplete) {
    try {
      await waitForTestOperationsToSettle();
      if (sessionCookie) {
        await Promise.allSettled(
          [userId, ordinaryUserId].map((feishuUserId) =>
            appRequest(`/api/admin/users/${encodeURIComponent(feishuUserId)}/disable`, {
              method: "POST",
              expectedStatus: [200, 403, 404, 409],
              body: { reason: "F-stage failed-check cleanup" },
              timeoutMs: 30_000,
            }),
          ),
        );
      }
    } catch {
      // The scoped direct-control fallback below does not depend on app health.
    }
    try {
      await forceDisableCreatedUpstreamTokens();
    } catch (cleanupError) {
      if (!runError) runError = cleanupError;
      else {
        runError = new Error(
          `${redact(runError.message)}; scoped upstream cleanup also failed: ${redact(cleanupError.message)}`,
        );
      }
    }
  }
  await pool.end();
}

if (runError) throw runError;
