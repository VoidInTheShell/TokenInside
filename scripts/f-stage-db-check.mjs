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

async function expectPgTransactionError(name, expectedCode, client, fn) {
  await client.query("savepoint expected_error");
  try {
    await fn();
    throw new Error(`${name} unexpectedly succeeded`);
  } catch (error) {
    await client.query("rollback to savepoint expected_error");
    if (error?.code !== expectedCode) throw error;
    pass(name, expectedCode);
  } finally {
    await client.query("release savepoint expected_error");
  }
}

async function cleanupArtifacts() {
  const client = await pool.connect();
  try {
    await client.query("begin");
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
  for (const expected of ["20260717_001_greenfield_baseline"]) {
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
    operationType: "first_provision",
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
  const ledger = {
    id: `${runId}_ledger`,
    operationId: operation.id,
    feishuUserId: operation.feishuUserId,
    period: "2026-07",
    entryType: "period_open_authorization",
    signedQuota: 100,
    quotaPerUnitSnapshot: 500000,
    sourceType: "f-stage-db-check",
    sourceId: runId,
    createdAt: now,
  };
  const ledgerClient = await pool.connect();
  try {
    await ledgerClient.query("begin");
    await ledgerClient.query(
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
    await ledgerClient.query(
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
    await expectPgTransactionError("ledger_update_rejected", "P0001", ledgerClient, () =>
      ledgerClient.query("update quota_ledger_entries set signed_quota = 101 where id = $1", [ledger.id]),
    );
    await expectPgTransactionError("ledger_delete_rejected", "P0001", ledgerClient, () =>
      ledgerClient.query("delete from quota_ledger_entries where id = $1", [ledger.id]),
    );
    await expectPgTransactionError("ledger_duplicate_rejected", "23505", ledgerClient, () =>
      ledgerClient.query(
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
    await ledgerClient.query("rollback");
  } finally {
    await ledgerClient.query("rollback").catch(() => undefined);
    ledgerClient.release();
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
  pass("test_artifact_cleanup", "ledger fixture rolled back and operation fixtures removed");
  process.stdout.write(`${JSON.stringify({ ok: true, runId, checks }, null, 2)}\n`);
} finally {
  if (!artifactsCleaned) await cleanupArtifacts();
  await pool.end();
}
