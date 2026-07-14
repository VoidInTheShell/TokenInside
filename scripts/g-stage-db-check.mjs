import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const prefix = `gdb_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const now = new Date().toISOString();

async function expectConstraint(client, sql, values, pattern) {
  await client.query("savepoint expected_failure");
  let message = "";
  try {
    await client.query(sql, values);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  await client.query("rollback to savepoint expected_failure");
  await client.query("release savepoint expected_failure");
  assert.match(message, pattern);
}

async function run() {
  const client = await pool.connect();
  try {
    const required = [
      "billing_package_definitions",
      "billing_package_versions",
      "department_package_assignments",
      "billing_package_requests",
      "user_package_grants",
      "department_budget_periods",
      "department_budget_commitments",
      "request_billing_contexts",
      "usage_charge_allocations",
      "billing_operations",
      "newapi_quota_display_snapshots",
    ];
    const tableResult = await client.query(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name = any($1::text[])`,
      [required],
    );
    assert.equal(tableResult.rowCount, required.length, "G package tables are incomplete");
    const legacyTables = [
      "token_requests",
      "user_billing_periods",
      "department_quota_periods",
      "department_quota_requests",
      "quota_change_events",
      "user_quota_policies",
      "quota_operations",
      "quota_ledger_entries",
      "user_quota_states",
      "quota_reconciliation_records",
    ];
    const legacyResult = await client.query(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name = any($1::text[])`,
      [legacyTables],
    );
    assert.equal(legacyResult.rowCount, 0, "legacy quota tables must not exist after G migrations");
    const settingsResult = await client.query("select data from app_settings where id = 'default'");
    const settings = settingsResult.rows[0]?.data ?? {};
    assert.equal("defaultMonthlyQuota" in settings, false, "legacy defaultMonthlyQuota setting survived");
    assert.equal("quotaFeatureFlags" in settings, false, "legacy quotaFeatureFlags setting survived");
    assert.equal("billingOperations" in settings, false, "legacy billingOperations setting survived");
    const tokenAccountColumns = await client.query(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'token_accounts'`,
    );
    const tokenAccountColumnNames = new Set(tokenAccountColumns.rows.map((row) => row.column_name));
    assert.equal(tokenAccountColumnNames.has("source_request_id"), true, "package key source column is missing");
    assert.equal(tokenAccountColumnNames.has("token_request_id"), false, "legacy key source column survived");

    await client.query("begin");
    const userId = `${prefix}_user`;
    const definitionId = `${prefix}_definition`;
    const versionId = `${prefix}_version`;
    const requestId = `${prefix}_request`;
    const budgetId = `${prefix}_budget`;
    const commitmentId = `${prefix}_commitment`;
    const grantId = `${prefix}_grant`;
    const departmentId = `${prefix}_department`;

    await client.query(
      `insert into feishu_users
        (id, tenant_key, open_id, department_id, data, created_at, updated_at)
       values ($1,'tenant',$2,$3,$4,$5,$5)`,
      [userId, `${prefix}_open`, departmentId, { id: userId, tenantKey: "tenant", openId: `${prefix}_open`, departmentId, createdAt: now, updatedAt: now }, now],
    );
    await client.query(
      `insert into billing_package_definitions
       values ($1,'department',$2,'standard','标准套餐','测试','active',$3,$4,$4)`,
      [definitionId, departmentId, userId, now],
    );
    await client.query(
      `insert into billing_package_versions
        (id, definition_id, version, granted_quota, cycle_type, cycle_value, timezone,
         eligibility_policy_json, regrant_policy_json, status, created_by_user_id, created_at, published_at)
       values ($1,$2,1,100,'calendar_month',1,'Asia/Hong_Kong',$3,$4,'published',$5,$6,$6)`,
      [versionId, definitionId, { allowFirstRequest: true }, { mode: "exhausted" }, userId, now],
    );
    await expectConstraint(
      client,
      "update billing_package_versions set granted_quota = 101 where id = $1",
      [versionId],
      /immutable/i,
    );

    await client.query(
      `insert into department_package_assignments
       values ($1,$2,$3,true,'active',$4,$5,$5)`,
      [`${prefix}_assignment`, departmentId, versionId, userId, now],
    );
    await expectConstraint(
      client,
      `insert into department_package_assignments
       values ($1,$2,$3,true,'active',$4,$5,$5)`,
      [`${prefix}_assignment2`, departmentId, versionId, userId, now],
      /duplicate key|unique/i,
    );

    await client.query(
      `insert into billing_package_requests
        (id, request_kind, user_id, department_id_at_request, package_definition_id,
         package_version_id, status, reason, idempotency_key, created_at, updated_at)
       values ($1,'first',$2,$3,$4,$5,'approved','测试',$6,$7,$7)`,
      [requestId, userId, departmentId, definitionId, versionId, `${prefix}_first`, now],
    );
    await client.query(
      `insert into department_budget_periods
       values ($1,$2,'calendar_month','2026-07-01T00:00:00Z','2026-08-01T00:00:00Z',100,0,100,0,1,$3,$4,$4)`,
      [budgetId, departmentId, userId, now],
    );
    await expectConstraint(
      client,
      "update department_budget_periods set committed_quota = 1 where id = $1",
      [budgetId],
      /check constraint/i,
    );
    await client.query(
      `insert into department_budget_commitments
        (id, department_budget_period_id, department_id, request_id, package_version_id,
         quota, state, idempotency_key, created_at)
       values ($1,$2,$3,$4,$5,100,'reserved',$6,$7)`,
      [commitmentId, budgetId, departmentId, requestId, versionId, `${prefix}_reservation`, now],
    );
    await client.query(
      `insert into user_package_grants
        (id, user_id, department_id_at_grant, package_definition_id, package_version_id,
         snapshot_json, granted_quota, allocated_quota, starts_at, expires_at, status,
         source_request_id, budget_commitment_id, created_by_user_id, created_at)
       values ($1,$2,$3,$4,$5,$6,100,0,'2026-07-01T00:00:00Z','2026-08-01T00:00:00Z',
         'active',$7,$8,$9,$10)`,
      [grantId, userId, departmentId, definitionId, versionId, { packageCode: "standard", packageName: "标准套餐", version: 1, grantedQuota: 100 }, requestId, commitmentId, userId, now],
    );
    await expectConstraint(
      client,
      "update user_package_grants set allocated_quota = 101 where id = $1",
      [grantId],
      /check constraint/i,
    );
    await client.query(
      `update department_budget_commitments
       set grant_id = $2, state = 'committed', committed_at = $3
       where id = $1`,
      [commitmentId, grantId, now],
    );
    await client.query(
      `update department_budget_periods
       set pending_quota = 0, committed_quota = 100 where id = $1`,
      [budgetId],
    );
    const invariant = await client.query(
      `select budget_quota, committed_quota, pending_quota, consumed_quota
       from department_budget_periods where id = $1`,
      [budgetId],
    );
    assert.deepEqual(invariant.rows[0], {
      budget_quota: "100",
      committed_quota: "100",
      pending_quota: "0",
      consumed_quota: "0",
    });
    await client.query("rollback");

    console.log(JSON.stringify({
      status: "passed",
      checks: {
        tables: required.length,
        legacyTablesAbsent: legacyTables.length,
        legacySettingsAbsent: true,
        packageKeySourceNormalized: true,
        publishedVersionImmutable: true,
        oneDefaultPerDepartment: true,
        departmentBudgetInvariant: true,
        grantAllocationInvariant: true,
        deferredGrantCommitmentLink: true,
      },
    }));
  } finally {
    client.release();
  }
}

try {
  await run();
} finally {
  await pool.end();
}
