import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const prefix = `gaudit_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const ids = Object.fromEntries(
  ["user", "definition", "version", "budget", "request1", "request2", "commitment1", "commitment2", "grant1", "grant2", "token", "proxy", "proxy2", "usage", "syncUsageA", "syncUsageB"].map((name) => [name, `${prefix}_${name}`]),
);
const departmentId = `${prefix}_department`;
const now = new Date();
const nowIso = now.toISOString();
const startsAt = new Date(now.getTime() - 60_000).toISOString();
const expiresAt1 = new Date(now.getTime() + 60 * 60_000).toISOString();
const expiresAt2 = new Date(now.getTime() + 2 * 60 * 60_000).toISOString();
const keyHash = createHash("sha256").update(`${prefix}_key`).digest("hex");
let repository;
let postgresStore;
let store;

function userData() {
  return {
    id: ids.user,
    tenantKey: `${prefix}_tenant`,
    openId: `${prefix}_open`,
    departmentId,
    status: "active",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function grantSnapshot() {
  return {
    packageCode: `${prefix}_package`,
    packageName: "G Audit Package",
    packageDescription: "cross-grant allocation audit",
    version: 1,
    grantedQuota: 10,
    cycleType: "fixed_days",
    cycleValue: 7,
    timezone: "Asia/Hong_Kong",
    eligibilityPolicy: { allowFirstRequest: true },
    regrantPolicy: { mode: "exhausted" },
  };
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set constraints all deferred");
    await client.query(
      `insert into feishu_users
        (id, tenant_key, open_id, department_id, data, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$6)`,
      [ids.user, `${prefix}_tenant`, `${prefix}_open`, departmentId, userData(), nowIso],
    );
    await client.query(
      `insert into billing_package_definitions
       values ($1,'department',$2,$3,'G Audit Package','allocation audit','active',$4,$5,$5)`,
      [ids.definition, departmentId, `${prefix}_package`, ids.user, nowIso],
    );
    await client.query(
      `insert into billing_package_versions
        (id, definition_id, version, granted_quota, cycle_type, cycle_value, timezone,
         eligibility_policy_json, regrant_policy_json, status, created_by_user_id,
         created_at, published_at)
       values ($1,$2,1,10,'fixed_days',7,'Asia/Hong_Kong',$3,$4,'published',$5,$6,$6)`,
      [ids.version, ids.definition, { allowFirstRequest: true }, { mode: "exhausted" }, ids.user, nowIso],
    );
    for (const requestId of [ids.request1, ids.request2]) {
      await client.query(
        `insert into billing_package_requests
          (id, request_kind, user_id, department_id_at_request, package_definition_id,
           package_version_id, status, reason, idempotency_key, created_at, updated_at)
         values ($1,'admin_grant',$2,$3,$4,$5,'provisioned','audit fixture',$6,$7,$7)`,
        [requestId, ids.user, departmentId, ids.definition, ids.version, `${prefix}_idem_${requestId}`, nowIso],
      );
    }
    await client.query(
      `insert into department_budget_periods
        (id, department_id, period_type, period_start, period_end, budget_quota,
         committed_quota, pending_quota, consumed_quota, version,
         configured_by_user_id, created_at, updated_at)
       values ($1,$2,'fixed_range',$3,$4,20,20,0,0,1,$5,$6,$6)`,
      [ids.budget, departmentId, startsAt, expiresAt2, ids.user, nowIso],
    );
    for (const [commitmentId, requestId, grantId] of [
      [ids.commitment1, ids.request1, ids.grant1],
      [ids.commitment2, ids.request2, ids.grant2],
    ]) {
      await client.query(
        `insert into department_budget_commitments
          (id, department_budget_period_id, department_id, request_id, package_version_id,
           grant_id, quota, state, idempotency_key, created_at, committed_at)
         values ($1,$2,$3,$4,$5,$6,10,'committed',$7,$8,$8)`,
        [commitmentId, ids.budget, departmentId, requestId, ids.version, grantId, `${prefix}_commit_${commitmentId}`, nowIso],
      );
    }
    await client.query(
      `insert into user_package_grants
        (id, user_id, department_id_at_grant, package_definition_id, package_version_id,
         snapshot_json, granted_quota, allocated_quota, starts_at, expires_at, status,
         source_request_id, budget_commitment_id, created_by_user_id, created_at)
       values
        ($1,$3,$4,$5,$6,$7,10,7,$8,$9,'active',$10,$11,$3,$12),
        ($2,$3,$4,$5,$6,$7,10,0,$8,$13,'active',$14,$15,$3,$12)`,
      [ids.grant1, ids.grant2, ids.user, departmentId, ids.definition, ids.version, grantSnapshot(), startsAt, expiresAt1, ids.request1, ids.commitment1, nowIso, expiresAt2, ids.request2, ids.commitment2],
    );
    const tokenData = {
      id: ids.token,
      feishuUserId: ids.user,
      sourceRequestId: ids.request1,
      newapiTokenId: `${prefix}_newapi_token`,
      keyHash,
      status: "active",
      billingPeriod: "package",
      operationGeneration: 0,
      createdAt: nowIso,
      activatedAt: nowIso,
    };
    await client.query(
      `insert into token_accounts
        (id, feishu_user_id, source_request_id, newapi_token_id, key_hash,
         status, billing_period, data, created_at)
       values ($1,$2,$3,$4,$5,'active','package',$6,$7)`,
      [ids.token, ids.user, ids.request1, `${prefix}_newapi_token`, keyHash, tokenData, nowIso],
    );
    const proxyData = {
      id: ids.proxy,
      feishuUserId: ids.user,
      tokenAccountId: ids.token,
      departmentId,
      requestPath: "/v1/chat/completions",
      method: "POST",
      status: "completed",
      statusCode: 200,
      durationMs: 100,
      model: "g-stage-sync",
      newapiResponseRequestId: ids.syncUsageA,
      responseTimeUpdatedAt: nowIso,
      createdAt: nowIso,
    };
    await client.query(
      `insert into proxy_request_logs
        (id, feishu_user_id, token_account_id, request_path, method, status_code, data, created_at)
       values ($1,$2,$3,'/v1/chat/completions','POST',200,$4,$5)`,
      [ids.proxy, ids.user, ids.token, proxyData, nowIso],
    );
    const proxy2Data = {
      ...proxyData,
      id: ids.proxy2,
      newapiResponseRequestId: ids.syncUsageB,
    };
    await client.query(
      `insert into proxy_request_logs
        (id, feishu_user_id, token_account_id, request_path, method, status_code, data, created_at)
       values ($1,$2,$3,'/v1/chat/completions','POST',200,$4,$5)`,
      [ids.proxy2, ids.user, ids.token, proxy2Data, nowIso],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query("set session_replication_role = replica");
    await client.query("delete from newapi_usage_records where feishu_user_id = $1", [ids.user]);
    for (const table of [
      "usage_charge_allocations",
      "request_billing_contexts",
      "newapi_usage_records",
      "proxy_request_logs",
      "billing_operations",
      "token_accounts",
      "user_package_grants",
      "department_budget_commitments",
      "department_budget_periods",
      "billing_package_requests",
      "billing_package_versions",
      "billing_package_definitions",
      "feishu_users",
    ]) {
      await client.query(`delete from ${table} where id like $1`, [`${prefix}%`]);
    }
    const leftovers = await client.query(
      `select
        (select count(*)::int from usage_charge_allocations where id like $1) as allocations,
        (select count(*)::int from request_billing_contexts where id like $1) as contexts,
        (select count(*)::int from feishu_users where id like $1) as users`,
      [`${prefix}%`],
    );
    assert.deepEqual(leftovers.rows[0], { allocations: 0, contexts: 0, users: 0 });
  } finally {
    await client.query("set session_replication_role = origin").catch(() => undefined);
    client.release();
  }
}

try {
  await seed();
  repository = await import("../../lib/billing/package-repository.ts");
  postgresStore = await import("../../lib/postgres-store.ts");
  store = await import("../../lib/store.ts");
  const tokenAccount = {
    id: ids.token,
    feishuUserId: ids.user,
    sourceRequestId: ids.request1,
    newapiTokenId: `${prefix}_newapi_token`,
    keyHash,
    status: "active",
    billingPeriod: "package",
    operationGeneration: 0,
    createdAt: nowIso,
    activatedAt: nowIso,
  };
  const context = await repository.beginRequestBillingContext({
    proxyRequestId: ids.proxy,
    userId: ids.user,
    departmentId,
    tokenAccount,
    startedAt: nowIso,
  });
  assert.deepEqual(context.candidateGrantIds, [ids.grant1, ids.grant2]);
  const syncUsageA = {
    newapiLogId: `${prefix}_sync_log_a`,
    newapiRequestId: ids.syncUsageA,
    newapiTokenId: `${prefix}_newapi_token`,
    createdAt: nowIso,
    model: "g-stage-sync",
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    quota: 2,
    isStream: false,
  };
  const syncUsageB = {
    ...syncUsageA,
    newapiLogId: `${prefix}_sync_log_b`,
    newapiRequestId: ids.syncUsageB,
  };
  const firstSync = await store.backfillProxyLogsFromNewApiUsage([syncUsageA], {
    dryRun: false,
    targetProxyLogIds: [ids.proxy, ids.proxy2],
  });
  assert.equal(firstSync.items.find((item) => item.newapiRequestId === ids.syncUsageA)?.proxyLogId, ids.proxy);
  const retrySync = await store.backfillProxyLogsFromNewApiUsage([syncUsageA, syncUsageB], {
    dryRun: false,
    targetProxyLogIds: [ids.proxy2],
  });
  assert.equal(retrySync.items.find((item) => item.newapiRequestId === ids.syncUsageA)?.proxyLogId, ids.proxy);
  assert.equal(retrySync.items.find((item) => item.newapiRequestId === ids.syncUsageB)?.proxyLogId, ids.proxy2);
  const syncState = await pool.query(
    `select data->>'newapiRequestId' as request_id, data->>'matchedProxyLogId' as proxy_id
       from newapi_usage_records where feishu_user_id = $1 order by request_id`,
    [ids.user],
  );
  assert.deepEqual(syncState.rows, [
    { request_id: ids.syncUsageA, proxy_id: ids.proxy },
    { request_id: ids.syncUsageB, proxy_id: ids.proxy2 },
  ]);
  const usage = {
    id: ids.usage,
    newapiLogId: `${prefix}_log`,
    newapiRequestId: `${prefix}_request`,
    newapiTokenId: `${prefix}_newapi_token`,
    tokenAccountId: ids.token,
    feishuUserId: ids.user,
    departmentId,
    matchedProxyLogId: ids.proxy,
    matchStatus: "matched",
    quota: 8,
    cost: 999,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    newapiCreatedAt: nowIso,
    firstSeenAt: nowIso,
    lastSyncedAt: nowIso,
  };
  await pool.query(
    `insert into newapi_usage_records
      (id, newapi_log_id, newapi_request_id, newapi_token_id, token_account_id,
       feishu_user_id, match_status, data, newapi_created_at, first_seen_at, last_synced_at)
     values ($1,$2,$3,$4,$5,$6,'matched',$7,$8,$8,$8)`,
    [ids.usage, usage.newapiLogId, usage.newapiRequestId, usage.newapiTokenId, ids.token, ids.user, usage, nowIso],
  );
  const first = await repository.allocateAuthoritativeUsageRecord(ids.usage);
  assert.equal(first.authoritativeQuota, 8, "raw quota must win over currency cost");
  assert.deepEqual(first.allocations.map((item) => ({ grantId: item.packageGrantId, quota: item.quota })), [
    { grantId: ids.grant1, quota: 3 },
    { grantId: ids.grant2, quota: 5 },
  ]);
  const second = await repository.allocateAuthoritativeUsageRecord(ids.usage);
  assert.equal(second.reused, true);
  const state = await pool.query(
    `select
       (select allocated_quota from user_package_grants where id = $1) as first_allocated,
       (select allocated_quota from user_package_grants where id = $2) as second_allocated,
       (select consumed_quota from department_budget_periods where id = $3) as department_consumed,
       (select count(*)::int from usage_charge_allocations where source_identity = $4) as allocation_rows,
       (select coalesce(sum(quota),0)::bigint from usage_charge_allocations where source_identity = $4) as allocation_quota`,
    [ids.grant1, ids.grant2, ids.budget, `request:${usage.newapiTokenId}:${usage.newapiRequestId}`],
  );
  assert.deepEqual(state.rows[0], {
    first_allocated: "10",
    second_allocated: "5",
    department_consumed: "8",
    allocation_rows: 2,
    allocation_quota: "8",
  });
  const scope = {
    id: `${prefix}_scope`,
    feishuUserId: ids.user,
    scopeType: "department",
    departmentId,
    source: "manual",
    status: "active",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const report = await repository.getPackageBillingReport({ scope });
  assert.deepEqual(report.summary, {
    grantedQuota: 20,
    allocatedQuota: 15,
    availableQuota: 5,
    authoritativeConsumedQuota: 8,
    grantCount: 2,
    openRequestCount: 0,
  });
  console.log(JSON.stringify({
    status: "passed",
    checks: {
      frozenContext: true,
      authoritativeRawQuota: 8,
      crossGrantAllocation: [3, 5],
      duplicateSourceEffects: 0,
      repeatedSameKeySourcesRemainDistinct: true,
      departmentConsumption: 8,
      reportReconstruction: true,
      fixtureCleanup: true,
    },
  }));
} finally {
  await cleanup();
  await postgresStore?.closePostgresPools?.();
  await pool.end();
}
