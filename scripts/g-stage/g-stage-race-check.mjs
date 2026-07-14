import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 24 });
const prefix = `grace_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const departmentId = `${prefix}_department`;
const adminId = `${prefix}_admin`;
const definitionId = `${prefix}_definition`;
const versionId = `${prefix}_version`;
const budgetId = `${prefix}_budget`;
const now = new Date();
const periodStart = new Date(now.getTime() - 60_000).toISOString();
const periodEnd = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
const nowIso = now.toISOString();
const userIds = Array.from({ length: 20 }, (_, index) => `${prefix}_user_${index}`);
let repository;
let postgresStore;

async function seed() {
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const [index, userId] of [adminId, ...userIds].entries()) {
      const openId = `${prefix}_open_${index}`;
      const data = {
        id: userId,
        tenantKey: `${prefix}_tenant`,
        openId,
        departmentId,
        status: "active",
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await client.query(
        `insert into feishu_users
          (id, tenant_key, open_id, department_id, data, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$6)`,
        [userId, `${prefix}_tenant`, openId, departmentId, data, nowIso],
      );
    }
    await client.query(
      `insert into billing_package_definitions
       values ($1,'department',$2,$3,'G Race Package','race check','active',$4,$5,$5)`,
      [definitionId, departmentId, `${prefix}_package`, adminId, nowIso],
    );
    await client.query(
      `insert into billing_package_versions
        (id, definition_id, version, granted_quota, cycle_type, cycle_value, timezone,
         eligibility_policy_json, regrant_policy_json, status, created_by_user_id,
         created_at, published_at)
       values ($1,$2,1,100,'fixed_days',7,'Asia/Hong_Kong',$3,$4,'published',$5,$6,$6)`,
      [versionId, definitionId, { allowFirstRequest: true }, { mode: "exhausted" }, adminId, nowIso],
    );
    await client.query(
      `insert into department_package_assignments
       values ($1,$2,$3,true,'active',$4,$5,$5)`,
      [`${prefix}_assignment`, departmentId, versionId, adminId, nowIso],
    );
    await client.query(
      `insert into department_budget_periods
        (id, department_id, period_type, period_start, period_end, budget_quota,
         committed_quota, pending_quota, consumed_quota, version,
         configured_by_user_id, created_at, updated_at)
       values ($1,$2,'fixed_range',$3,$4,100,0,0,0,1,$5,$6,$6)`,
      [budgetId, departmentId, periodStart, periodEnd, adminId, nowIso],
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
    await client.query("delete from usage_charge_allocations where id like $1", [`${prefix}%`]);
    await client.query("delete from request_billing_contexts where id like $1", [`${prefix}%`]);
    await client.query("delete from token_accounts where feishu_user_id = any($1::text[])", [[adminId, ...userIds]]);
    await client.query("delete from billing_operations where user_id = any($1::text[])", [[adminId, ...userIds]]);
    await client.query("delete from user_package_grants where user_id = any($1::text[])", [[adminId, ...userIds]]);
    await client.query("delete from department_budget_commitments where department_id = $1", [departmentId]);
    await client.query("delete from billing_package_requests where user_id = any($1::text[])", [[adminId, ...userIds]]);
    await client.query("delete from department_budget_periods where department_id = $1", [departmentId]);
    await client.query("delete from department_package_assignments where department_id = $1", [departmentId]);
    await client.query("delete from billing_package_versions where id = $1", [versionId]);
    await client.query("delete from billing_package_definitions where id = $1", [definitionId]);
    await client.query("delete from feishu_users where id = any($1::text[])", [[adminId, ...userIds]]);
    const leftovers = await client.query(
      `select
        (select count(*)::int from billing_package_requests where id like $1) as requests,
        (select count(*)::int from department_budget_commitments where id like $1) as commitments,
        (select count(*)::int from feishu_users where id like $1) as users`,
      [`${prefix}%`],
    );
    assert.deepEqual(leftovers.rows[0], { requests: 0, commitments: 0, users: 0 });
  } finally {
    await client.query("set session_replication_role = origin").catch(() => undefined);
    client.release();
  }
}

try {
  await seed();
  repository = await import("../../lib/billing/package-repository.ts");
  postgresStore = await import("../../lib/postgres-store.ts");
  const inputs = userIds.map((userId, index) => ({
    userId,
    departmentId,
    packageVersionId: versionId,
    requestKind: "first",
    reason: "G race final budget package",
    clientRequestId: `${prefix}_client_${index}`,
    approvalActionNonceHash: `${prefix}_nonce_${index}`,
  }));
  const race = await Promise.allSettled(
    inputs.map((input) => repository.createPackageRequestReservation(input)),
  );
  const winners = race.filter((item) => item.status === "fulfilled");
  const losers = race.filter((item) => item.status === "rejected");
  assert.equal(winners.length, 1, "last package budget must have one winner");
  assert.equal(losers.length, 19, "last package budget must reject the other contenders");
  for (const loser of losers) {
    assert.equal(loser.reason?.code, "department_budget_exhausted");
  }
  const winner = winners[0].value;
  const winnerInput = inputs.find((input) => input.userId === winner.request.userId);
  assert.ok(winnerInput);
  const duplicates = await Promise.all(
    Array.from({ length: 20 }, () => repository.createPackageRequestReservation(winnerInput)),
  );
  assert.equal(duplicates.every((item) => item.reused && item.request.id === winner.request.id), true);
  const beforeRelease = await pool.query(
    `select budget_quota, committed_quota, pending_quota
     from department_budget_periods where id = $1`,
    [budgetId],
  );
  assert.deepEqual(beforeRelease.rows[0], {
    budget_quota: "100",
    committed_quota: "0",
    pending_quota: "100",
  });
  await repository.decidePackageRequest({
    scope: {
      id: `${prefix}_scope`,
      feishuUserId: adminId,
      scopeType: "global",
      source: "manual",
      status: "active",
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    operatedByUserId: adminId,
    operatedByOpenId: `${prefix}_admin_open`,
    requestId: winner.request.id,
    action: "reject",
  });
  const terminal = await pool.query(
    `select
       (select pending_quota from department_budget_periods where id = $1) as pending_quota,
       (select count(*)::int from department_budget_commitments where department_id = $2 and state = 'reserved') as open_reservations,
       (select count(*)::int from user_package_grants where department_id_at_grant = $2) as grants`,
    [budgetId, departmentId],
  );
  assert.deepEqual(terminal.rows[0], { pending_quota: "0", open_reservations: 0, grants: 0 });
  console.log(JSON.stringify({
    status: "passed",
    checks: {
      contenders: 20,
      exactBudgetWinner: 1,
      deterministicBudgetRejections: 19,
      duplicateSubmissions: 20,
      duplicateBusinessEffects: 0,
      reservationReleased: true,
      fixtureCleanup: true,
    },
  }));
} finally {
  await cleanup();
  await postgresStore?.closePostgresPools?.();
  await pool.end();
}
