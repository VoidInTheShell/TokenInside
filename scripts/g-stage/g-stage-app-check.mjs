import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { formatRawQuota, parseDisplayQuota } from "../../lib/billing/quota-display-model.ts";

const databaseUrl = process.env.DATABASE_URL;
const baseUrl = process.env.G_STAGE_BASE_URL ?? "http://127.0.0.1:16879";
const sessionSecret = process.env.TOKENINSIDE_SESSION_SECRET;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!sessionSecret) throw new Error("TOKENINSIDE_SESSION_SECRET is required");

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const prefix = `gapp_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const userId = `${prefix}_user`;
const openId = process.env.G_STAGE_ADMIN_OPEN_ID?.trim() ||
  process.env.TOKENINSIDE_SYSTEM_ADMIN_OPEN_IDS?.split(",").map((value) => value.trim()).find(Boolean);
if (!openId) {
  throw new Error("G_STAGE_ADMIN_OPEN_ID or TOKENINSIDE_SYSTEM_ADMIN_OPEN_IDS is required");
}
const departmentId = `${prefix}_department`;
const now = new Date().toISOString();

function sessionToken() {
  const body = Buffer.from(JSON.stringify({
    userId,
    tenantKey: "g-stage-tenant",
    openId,
    exp: Math.floor(Date.now() / 1000) + 3600,
  }), "utf8").toString("base64url");
  const signature = createHmac("sha256", sessionSecret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      cookie: `ti_session=${sessionToken()}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function poll(check, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for package operation");
}

async function seed() {
  await pool.query(
    `insert into feishu_users
      (id, tenant_key, open_id, department_id, data, created_at, updated_at)
     values ($1,'g-stage-tenant',$2,$3,$4,$5,$5)`,
    [userId, openId, departmentId, {
      id: userId,
      tenantKey: "g-stage-tenant",
      openId,
      name: "G Stage User",
      departmentId,
      departmentName: "G Stage Department",
      status: "active",
      createdAt: now,
      updatedAt: now,
    }, now],
  );
}

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query("set session_replication_role = replica");
    await client.query("delete from usage_charge_allocations where id like $1", [`${prefix}%`]);
    await client.query("delete from request_billing_contexts where id like $1", [`${prefix}%`]);
    await client.query("delete from token_accounts where feishu_user_id = $1", [userId]);
    await client.query("delete from billing_operations where user_id = $1", [userId]);
    await client.query("delete from user_package_grants where user_id = $1", [userId]);
    await client.query("delete from department_budget_commitments where department_id = $1", [departmentId]);
    await client.query("delete from billing_package_requests where user_id = $1", [userId]);
    await client.query("delete from department_budget_periods where department_id = $1", [departmentId]);
    await client.query("delete from department_package_assignments where department_id = $1", [departmentId]);
    await client.query("delete from billing_package_versions where created_by_user_id = $1", [userId]);
    await client.query("delete from billing_package_definitions where created_by_user_id = $1", [userId]);
    await client.query("delete from admin_scopes where feishu_user_id = $1", [userId]);
    await client.query("delete from feishu_events where id like $1", [`${prefix}%`]);
    await client.query("delete from proxy_request_logs where feishu_user_id = $1", [userId]);
    await client.query("delete from newapi_usage_records where feishu_user_id = $1", [userId]);
    await client.query("delete from feishu_users where id = $1", [userId]);
  } finally {
    await client.query("set session_replication_role = origin").catch(() => undefined);
    client.release();
  }
}

async function run() {
  await seed();
  const unauthenticated = await fetch(`${baseUrl}/api/session`).then((response) => response.json());
  assert.equal(unauthenticated.authenticated, false);
  const session = await api("/api/session");
  assert.equal(session.authenticated, true);
  assert.equal(session.user.id, userId);

  const overview = await api("/api/admin/overview");
  assert.equal(overview.authorized, true);
  assert.equal(overview.scope.type, "global");
  const { snapshot: displaySnapshot } = await api("/api/admin/quota-display");
  const expectedGrantQuota = parseDisplayQuota({
    displayValue: 10,
    configVersion: displaySnapshot.configVersion,
    snapshot: displaySnapshot,
  });
  const expectedGrantDisplay = formatRawQuota(expectedGrantQuota, displaySnapshot);

  const createdDefinition = await api("/api/admin/packages", {
    method: "POST",
    body: JSON.stringify({ ownerScopeType: "global", code: prefix, name: "G App 套餐", description: "G stage app check" }),
  });
  const definitionId = createdDefinition.definition.id;
  const createdVersion = await api(`/api/admin/packages/${definitionId}/versions`, {
    method: "POST",
    body: JSON.stringify({
      grantedQuotaDisplay: 10,
      configVersion: displaySnapshot.configVersion,
      cycleType: "calendar_month",
      cycleValue: 1,
      eligibilityPolicy: { allowFirstRequest: true },
      regrantPolicy: { mode: "exhausted" },
    }),
  });
  const versionId = createdVersion.version.id;
  assert.equal(createdVersion.version.grantedQuota, expectedGrantQuota);
  await api(`/api/admin/package-versions/${versionId}/publish`, { method: "POST" });
  await api("/api/admin/package-assignments", {
    method: "PUT",
    body: JSON.stringify({ departmentId, packageVersionId: versionId, isDefault: true, status: "active" }),
  });
  await api("/api/admin/department-budgets", {
    method: "PUT",
    body: JSON.stringify({
      departmentId,
      periodType: "fixed_range",
      periodStart: "2026-07-01T00:00:00.000Z",
      periodEnd: "2026-08-01T00:00:00.000Z",
      budgetQuotaDisplay: 100,
      configVersion: displaySnapshot.configVersion,
    }),
  });

  const available = await api("/api/packages/available");
  assert.equal(available.items.length, 1);
  assert.equal(available.items[0].assignment.isDefault, true);
  assert.equal(available.items[0].quota.rawQuota, expectedGrantQuota);

  await api("/api/admin/package-grants", {
    method: "POST",
    body: JSON.stringify({
      userId,
      packageVersionId: versionId,
      reason: "G stage app check admin grant",
      clientRequestId: randomUUID(),
    }),
  });
  const packageMe = await poll(async () => {
    const value = await api("/api/packages/me");
    return value.grants.some((grant) => grant.status === "active") ? value : null;
  });
  assert.equal(packageMe.balance.grantedQuota, expectedGrantQuota);
  assert.equal(packageMe.balance.availableQuota, expectedGrantQuota);
  assert.equal(packageMe.balance.available.display.formatted, expectedGrantDisplay.display.formatted);

  const activeSession = await poll(async () => {
    const value = await api("/api/session");
    return value.activeToken?.status === "active" ? value : null;
  });
  assert.equal(activeSession.activeToken.status, "active");
  const oldTokenAccountId = activeSession.activeToken.id;
  const key = await api("/api/token/key");
  assert.equal(typeof key.key, "string");
  assert.ok(key.key.trim().length > 0, "NewAPI returned an empty active key");

  const beforeRotation = await pool.query(
    `select
       (select count(*)::int from user_package_grants where user_id = $1) as grants,
       (select count(*)::int from usage_charge_allocations where user_id = $1) as allocations,
       (select coalesce(sum(quota),0)::bigint from department_budget_commitments where department_id = $2 and state = 'committed') as committed`,
    [userId, departmentId],
  );
  const rotation = await api("/api/token/reset", {
    method: "POST",
    body: JSON.stringify({ reason: "G stage app check key rotation", clientRequestId: randomUUID() }),
  });
  assert.equal(rotation.operation.state, "completed");
  assert.equal(typeof rotation.key, "string");
  assert.ok(rotation.key.trim().length > 0, "NewAPI returned an empty rotated key");
  assert.notEqual(rotation.key, key.key, "Key rotation returned the previous NewAPI key");
  const rotatedKey = await api("/api/token/key");
  assert.equal(rotatedKey.key, rotation.key);
  const afterRotationSession = await api("/api/session");
  assert.notEqual(afterRotationSession.activeToken.id, oldTokenAccountId);
  assert.equal(afterRotationSession.activeToken.operationGeneration, 1);
  const activeCount = await pool.query(
    "select count(*)::int as count from token_accounts where feishu_user_id = $1 and status = 'active'",
    [userId],
  );
  assert.equal(activeCount.rows[0].count, 1);
  const afterRotation = await pool.query(
    `select
       (select count(*)::int from user_package_grants where user_id = $1) as grants,
       (select count(*)::int from usage_charge_allocations where user_id = $1) as allocations,
       (select coalesce(sum(quota),0)::bigint from department_budget_commitments where department_id = $2 and state = 'committed') as committed`,
    [userId, departmentId],
  );
  assert.deepEqual(afterRotation.rows[0], beforeRotation.rows[0]);

  const report = await api("/api/admin/billing-report");
  assert.equal(report.summary.grantedQuota, expectedGrantQuota);
  assert.equal(report.summary.availableQuota, expectedGrantQuota);
  const schema = await pool.query(
    "select to_regclass('public.quota_operations') as quota_operations, to_regclass('public.user_billing_periods') as user_billing_periods",
  );
  assert.deepEqual(schema.rows[0], { quota_operations: null, user_billing_periods: null });

  console.log(JSON.stringify({
    status: "passed",
    checks: {
      auth: true,
      packageCatalog: true,
      immutableVersionPublish: true,
      assignmentAndBudget: true,
      adminGrantProvision: true,
      packageBalanceDisplay: true,
      keyRotationConservation: true,
      oneActiveKey: true,
      legacySchemaAbsent: true,
    },
  }));
}

try {
  await run();
} finally {
  await cleanup().catch((error) => console.error("G app fixture cleanup failed", error));
  await pool.end();
}
