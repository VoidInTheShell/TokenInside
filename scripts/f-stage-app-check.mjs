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
const tenantKey = `${runId}_tenant`;
const openId = "ou_f_local_admin";
const departmentId = `${runId}_department`;
const firstRequestId = `${runId}_first_apply`;
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const checks = [];
let sessionCookie;
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

function createSessionCookie() {
  const payload = {
    userId,
    tenantKey,
    openId,
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
  if (options.auth !== false) headers.set("cookie", sessionCookie);
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

async function waitForOperation(operationId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = "unknown";
  while (Date.now() < deadline) {
    const response = await appRequest(`/api/quota-operations/${encodeURIComponent(operationId)}`);
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
    quotaLimit: 1000,
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

async function insertFirstApplyRequest() {
  const now = new Date().toISOString();
  const request = {
    id: firstRequestId,
    feishuUserId: userId,
    requestType: "first_apply",
    status: "pending_card_send",
    reason: "F-stage local first provision",
    requestedMonthlyQuota: 10,
    approvalUuid: `${runId}_approval`,
    approvalDepartmentId: departmentId,
    approvalMode: "manual",
    approvalTargetOpenId: openId,
    createdAt: now,
    updatedAt: now,
  };
  await pool.query(
    `insert into token_requests
      (id, feishu_user_id, request_type, status, approval_department_id,
       approval_target_open_id, data, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      request.id,
      request.feishuUserId,
      request.requestType,
      request.status,
      request.approvalDepartmentId,
      request.approvalTargetOpenId,
      request,
      now,
      now,
    ],
  );
}

async function operationByIdempotencyKey(idempotencyKey) {
  const result = await pool.query(
    "select data from quota_operations where idempotency_key = $1",
    [idempotencyKey],
  );
  return result.rows[0]?.data;
}

async function quotaSnapshot() {
  const ledger = await pool.query(
    `select coalesce(sum(signed_quota), 0)::text as total, count(*)::integer as entries
     from quota_ledger_entries where feishu_user_id = $1 and period = $2`,
    [userId, period],
  );
  const policy = await pool.query(
    `select data from user_quota_policies
     where feishu_user_id = $1
     order by version desc limit 1`,
    [userId],
  );
  return {
    total: Number(ledger.rows[0]?.total ?? 0),
    entries: Number(ledger.rows[0]?.entries ?? 0),
    policy: policy.rows[0]?.data,
  };
}

async function tokenAccounts() {
  const result = await pool.query(
    `select newapi_token_id, status, data
     from token_accounts where feishu_user_id = $1 order by created_at`,
    [userId],
  );
  return result.rows;
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

async function billingSnapshot() {
  const result = await pool.query(
    `select data from user_billing_periods
     where feishu_user_id = $1 and period = $2`,
    [userId, period],
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
  const accounts = await tokenAccounts();
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
     join feishu_users user_row on user_row.id = account.feishu_user_id
     where user_row.data->>'name' = 'F-stage local Docker check'
       and account.newapi_token_id is not null`,
  );
  return result.rows.map((row) => String(row.newapi_token_id));
}

async function verifyCreatedUpstreamTokensDisabled() {
  const accounts = await tokenAccounts();
  const currentTokenIds = [
    ...new Set(accounts.map((row) => row.newapi_token_id).filter(Boolean).map(String)),
  ];
  assert(
    currentTokenIds.length === 2,
    `expected two isolated upstream tokens, got ${currentTokenIds.length}`,
  );
  const tokenIds = await allFStageTestTokenIds();
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
    currentTokens: currentTokenIds.length,
    sessionTestTokens: tokenIds.length,
    repaired,
    status: "disabled",
  });
}

async function run() {
  sessionCookie = createSessionCookie();
  await seedLocalScenario();

  const health = await appRequest("/api/health", { auth: false });
  assert(health.json?.status === "ok", "application health is not ok");
  assert(health.json?.store?.type === "postgres", "application is not using PostgreSQL");
  assert(health.json?.store?.schema?.ready === true, "PostgreSQL schema is not ready");
  assert(health.json?.configuration?.newapiMock === false, "NewAPI mock must be disabled");
  pass("docker_app_health", { store: "postgres", newapi: "real-test-gateway" });

  const preallocation = await appRequest(
    `/api/admin/users/${encodeURIComponent(userId)}/quota-adjust`,
    {
      method: "POST",
      expectedStatus: 202,
      body: {
        approvedMonthlyQuota: 10,
        reason: "F-stage local preallocation",
        clientRequestId: `${runId}_preallocate`,
      },
    },
  );
  const preallocationId = preallocation.json?.operation?.id;
  assert(preallocationId, "preallocation operation id is missing");
  const preallocationResult = await waitForOperation(preallocationId);
  assert(!preallocationResult.key, "preallocation unexpectedly returned a credential");
  let snapshot = await quotaSnapshot();
  assert(snapshot.total === 10 * quotaPerUnit, "preallocation ledger total is incorrect");
  assert(
    snapshot.policy?.assignedMonthlyQuota === 10 * quotaPerUnit,
    "preallocation policy is incorrect",
  );
  pass("no_key_preallocation", { ledgerQuota: snapshot.total, credential: false });

  await insertFirstApplyRequest();
  const decision = await appRequest(
    `/api/admin/token-requests/${encodeURIComponent(firstRequestId)}/decision`,
    {
      method: "POST",
      expectedStatus: [200, 502],
      body: { action: "approve", approvedMonthlyQuota: 10 },
    },
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
  assert(firstCompleted?.evidence?.authorizationDelta === 0, "first provision granted twice");
  snapshot = await quotaSnapshot();
  assert(snapshot.total === 10 * quotaPerUnit, "first provision changed preallocated total");
  const periodOpenMarker = await pool.query(
    `select signed_quota from quota_ledger_entries
     where operation_id = $1 and entry_type = 'period_open_authorization'`,
    [firstOperation.id],
  );
  assert(periodOpenMarker.rowCount === 1, "first provision did not write a period-open marker");
  assert(Number(periodOpenMarker.rows[0].signed_quota) === 0, "period-open marker is not zero");
  const firstAccounts = await tokenAccounts();
  assert(
    firstAccounts.filter((row) => row.status === "active").length === 1,
    "first provision did not create exactly one active account",
  );
  pass("first_provision_reuses_allocation", {
    decisionStatus: decision.status,
    authorizationDelta: 0,
    periodOpenMarker: true,
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
    Number(activeUpstream.remain_quota) === 10 * quotaPerUnit,
    `rotated key inherited ${activeUpstream.remain_quota} instead of the settled user remainder`,
  );
  snapshot = await quotaSnapshot();
  assert(snapshot.total === 12 * quotaPerUnit, "rotation changed ledger authorization");
  const billing = await billingSnapshot();
  assert(
    billing?.authorizedQuota === 12 * quotaPerUnit,
    "rotation changed the user-period authorization",
  );
  assert(
    billing?.authoritativeConsumedQuota === 2 * quotaPerUnit,
    "rotation did not preserve authoritative settled usage",
  );
  assert(
    billing?.expectedAvailableQuota === 10 * quotaPerUnit,
    "rotation materialized an incorrect user-period remainder",
  );
  assert(
    Array.isArray(billing?.tokenAccountIds) && billing.tokenAccountIds.length === 2,
    "rotation did not keep both token generations in the user period",
  );
  const department = await departmentSnapshot();
  assert(
    department?.committedAuthorizedQuota === 12 * quotaPerUnit,
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
  });

  const monthly = await appRequest("/api/admin/billing/monthly-reset", {
    method: "POST",
    body: { period, dryRun: true },
  });
  const departmentPlan = monthly.json?.departments?.find(
    (item) => item.departmentId === departmentId,
  );
  assert(monthly.json?.blocked === false, "monthly preflight is unexpectedly blocked");
  assert(departmentPlan?.alreadyOpenedUsers === 1, "monthly preflight missed prior opening");
  assert(departmentPlan?.users?.length === 0, "monthly preflight would authorize the user twice");
  pass("monthly_open_idempotency", { alreadyOpenedUsers: 1, pendingUsers: 0 });

  const reconciliation = await appRequest("/api/admin/quota-control?observe=true");
  const row = reconciliation.json?.report?.rows?.find(
    (item) => item.feishuUserId === userId,
  );
  assert(row?.status === "healthy", `reconciliation status is ${row?.status ?? "missing"}`);
  assert(row?.observedStable === true, "reconciliation did not obtain two stable reads");
  assert(row?.expectedAvailableQuota === 10 * quotaPerUnit, "reconciliation expected quota is wrong");
  assert(row?.observedRemainQuota === 10 * quotaPerUnit, "reconciliation observed quota is wrong");
  pass("shadow_reconciliation", {
    status: "healthy",
    stableReads: 2,
    expectedQuota: row.expectedAvailableQuota,
  });

  await appRequest(`/api/admin/users/${encodeURIComponent(userId)}/disable`, {
    method: "POST",
    body: { reason: "F-stage local check cleanup" },
  });
  cleanupComplete = true;
  const activeAfterCleanup = await pool.query(
    `select count(*)::integer as count from token_accounts
     where feishu_user_id = $1 and status = 'active'`,
    [userId],
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
      if (sessionCookie) {
        await appRequest(`/api/admin/users/${encodeURIComponent(userId)}/disable`, {
          method: "POST",
          expectedStatus: [200, 403, 404, 409],
          body: { reason: "F-stage failed-check cleanup" },
          timeoutMs: 30_000,
        });
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
