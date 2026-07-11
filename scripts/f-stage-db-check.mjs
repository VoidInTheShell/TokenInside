import { randomBytes } from "node:crypto";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const runId = `fcheck_${randomBytes(6).toString("hex")}`;
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const checks = [];
let artifactsCleaned = false;

function pass(name, detail) {
  checks.push({ name, ok: true, detail });
}

async function expectPgError(name, expectedCode, fn) {
  try {
    await fn();
    throw new Error(`${name} unexpectedly succeeded`);
  } catch (error) {
    if (error?.code !== expectedCode) throw error;
    pass(name, expectedCode);
  }
}

async function cleanupArtifacts() {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local tokeninside.allow_ledger_rewrite = 'on'");
    await client.query("delete from quota_ledger_entries where id like $1", [`${runId}%`]);
    await client.query("delete from quota_operations where id like $1", [`${runId}%`]);
    await client.query("commit");
    artifactsCleaned = true;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

try {
  const migrations = await pool.query(
    "select version from schema_migrations order by version",
  );
  const versions = migrations.rows.map((row) => row.version);
  for (const expected of [
    "20260711_001_baseline",
    "20260711_002_quota_ledger",
    "20260711_003_quota_ledger_maintenance_guard",
  ]) {
    if (!versions.includes(expected)) throw new Error(`missing migration ${expected}`);
  }
  pass("migration_versions", versions);

  const columns = await pool.query(
    `select table_name, column_name
     from information_schema.columns
     where (table_name = 'token_accounts' and column_name in
       ('operation_generation', 'drain_started_at', 'settled_through', 'activated_at'))
        or (table_name = 'proxy_request_logs' and column_name in
       ('billing_period', 'operation_generation', 'lease_expires_at', 'heartbeat_at'))`,
  );
  if (columns.rowCount !== 8) throw new Error(`expected 8 F columns, got ${columns.rowCount}`);
  pass("f_columns", columns.rowCount);

  const now = new Date().toISOString();
  const operation = {
    id: `${runId}_ledger_op`,
    operationType: "migration",
    idempotencyKey: `${runId}:ledger`,
    feishuUserId: `${runId}_ledger_user`,
    billingPeriod: "2026-07",
    reservedDepartmentQuota: 0,
    operationGeneration: 0,
    state: "completed",
    attemptCount: 1,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  };
  await pool.query(
    `insert into quota_operations
      (id, operation_type, idempotency_key, feishu_user_id, billing_period,
       state, operation_generation, data, created_at, updated_at, completed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      operation.id,
      operation.operationType,
      operation.idempotencyKey,
      operation.feishuUserId,
      operation.billingPeriod,
      operation.state,
      operation.operationGeneration,
      operation,
      now,
      now,
      now,
    ],
  );
  const ledger = {
    id: `${runId}_ledger`,
    operationId: operation.id,
    feishuUserId: operation.feishuUserId,
    period: "2026-07",
    entryType: "migration_opening",
    signedQuota: 100,
    quotaPerUnitSnapshot: 500000,
    sourceType: "f-stage-db-check",
    sourceId: runId,
    createdAt: now,
  };
  await pool.query(
    `insert into quota_ledger_entries
      (id, operation_id, feishu_user_id, period, entry_type, signed_quota, data, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      ledger.id,
      ledger.operationId,
      ledger.feishuUserId,
      ledger.period,
      ledger.entryType,
      ledger.signedQuota,
      ledger,
      now,
    ],
  );
  await expectPgError("ledger_update_rejected", "P0001", () =>
    pool.query("update quota_ledger_entries set signed_quota = 101 where id = $1", [ledger.id]),
  );
  await expectPgError("ledger_delete_rejected", "P0001", () =>
    pool.query("delete from quota_ledger_entries where id = $1", [ledger.id]),
  );
  await expectPgError("ledger_duplicate_rejected", "23505", () =>
    pool.query(
      `insert into quota_ledger_entries
        (id, operation_id, feishu_user_id, period, entry_type, signed_quota, data, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        `${ledger.id}_duplicate`,
        ledger.operationId,
        ledger.feishuUserId,
        ledger.period,
        ledger.entryType,
        ledger.signedQuota,
        ledger,
        now,
      ],
    ),
  );

  const maintenance = await pool.connect();
  try {
    await maintenance.query("begin");
    await maintenance.query("set local tokeninside.allow_ledger_rewrite = 'on'");
    await maintenance.query(
      "update quota_ledger_entries set signed_quota = 101 where id = $1",
      [ledger.id],
    );
    await maintenance.query("rollback");
    pass("ledger_maintenance_override", "transaction-local and rolled back");
  } finally {
    maintenance.release();
  }

  const openUser = `${runId}_open_user`;
  const openOperation = (suffix) => ({
    id: `${runId}_${suffix}`,
    operationType: "quota_adjust",
    idempotencyKey: `${runId}:${suffix}`,
    feishuUserId: openUser,
    billingPeriod: "2026-07",
    reservedDepartmentQuota: 0,
    operationGeneration: 1,
    state: "planned",
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  const firstOpen = openOperation("open_1");
  await pool.query(
    `insert into quota_operations
      (id, operation_type, idempotency_key, feishu_user_id, billing_period,
       state, operation_generation, data, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      firstOpen.id,
      firstOpen.operationType,
      firstOpen.idempotencyKey,
      firstOpen.feishuUserId,
      firstOpen.billingPeriod,
      firstOpen.state,
      firstOpen.operationGeneration,
      firstOpen,
      now,
      now,
    ],
  );
  const secondOpen = openOperation("open_2");
  await expectPgError("one_open_operation_per_user", "23505", () =>
    pool.query(
      `insert into quota_operations
        (id, operation_type, idempotency_key, feishu_user_id, billing_period,
         state, operation_generation, data, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        secondOpen.id,
        secondOpen.operationType,
        secondOpen.idempotencyKey,
        secondOpen.feishuUserId,
        secondOpen.billingPeriod,
        secondOpen.state,
        secondOpen.operationGeneration,
        secondOpen,
        now,
        now,
      ],
    ),
  );

  await cleanupArtifacts();
  pass("test_artifact_cleanup", "ledger and operation fixtures removed");
  process.stdout.write(`${JSON.stringify({ ok: true, runId, checks }, null, 2)}\n`);
} finally {
  if (!artifactsCleaned) await cleanupArtifacts();
  await pool.end();
}
