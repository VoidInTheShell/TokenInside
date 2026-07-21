import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";

const baselinePath = new URL("../scripts/db-migrate.mjs", import.meta.url);
const postgresStorePath = new URL("../lib/postgres-store.ts", import.meta.url);
const storePath = new URL("../lib/store.ts", import.meta.url);

function section(source: string, startMarker: string, endMarker: string) {
  const normalized = source.replace(/\r\n/g, "\n");
  const start = normalized.indexOf(startMarker);
  const end = normalized.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return normalized.slice(start, end);
}

test("greenfield quota policies keep source idempotency in scalar PostgreSQL columns", async () => {
  const [baseline, postgresStore] = await Promise.all([
    readFile(baselinePath, "utf8"),
    readFile(postgresStorePath, "utf8"),
  ]);
  const table = section(
    baseline,
    "create table if not exists user_quota_policies",
    "create index if not exists user_quota_policies_effective_idx",
  );
  assert.match(table, /source_type text not null/);
  assert.match(table, /source_id text not null/);
  assert.match(
    table,
    /user_quota_policies_source_unique[\s\S]*unique \(source_type, source_id\)/,
  );

  const scalarWrite = section(
    postgresStore,
    "async function saveUserQuotaPolicyRow(",
    "async function saveQuotaOperationRow(",
  );
  assert.match(scalarWrite, /version, source_type, source_id, data/);
  assert.match(scalarWrite, /policy\.sourceType/);
  assert.match(scalarWrite, /policy\.sourceId/);
  assert.match(scalarWrite, /source_type = excluded\.source_type/);
  assert.match(scalarWrite, /source_id = excluded\.source_id/);

  const wholeStoreFixture = postgresStore.slice(
    postgresStore.indexOf("export async function writePostgresStore("),
  );
  assert.match(wholeStoreFixture, /delete from user_quota_policies/);
  assert.match(
    wholeStoreFixture,
    /for \(const policy of store\.userQuotaPolicies \?\? \[\]\)[\s\S]*saveUserQuotaPolicyRow\(client, policy\)/,
  );
});

test("PostgreSQL policy version creation is a targeted serialized control transaction", async () => {
  const [postgresStore, store] = await Promise.all([
    readFile(postgresStorePath, "utf8"),
    readFile(storePath, "utf8"),
  ]);
  const createPostgres = section(
    postgresStore,
    "export async function createPostgresUserQuotaPolicyVersion(",
    "export async function findPostgresQuotaOperationById(",
  );
  assert.match(createPostgres, /withControlTransaction/);
  assert.match(
    createPostgres,
    /pg_advisory_xact_lock\(hashtext\(\$1\)::bigint\)/,
  );
  assert.match(
    createPostgres,
    /where source_type = \$1 and source_id = \$2/,
  );
  assert.match(
    createPostgres,
    /where feishu_user_id = \$1[\s\S]*order by version desc, id desc[\s\S]*for update/,
  );
  assert.match(createPostgres, /\(previous\.rows\[0\]\?\.version \?\? 0\) \+ 1/);
  assert.match(
    createPostgres,
    /on conflict \(source_type, source_id\) do nothing/,
  );
  assert.match(createPostgres, /concurrentlyInserted/);
  assert.doesNotMatch(createPostgres, /readStore|readPostgresStore/);
  assert.ok(
    createPostgres.indexOf("pg_advisory_xact_lock") <
      createPostgres.indexOf("where source_type = $1"),
    "the user advisory fence must precede source and version reads",
  );

  const dispatch = section(
    store,
    "export async function createUserQuotaPolicyVersion(",
    "export async function getUserQuotaState(",
  );
  const postgresDispatch = dispatch.indexOf("createPostgresUserQuotaPolicyVersion(");
  const wholeStoreRead = dispatch.indexOf("const store = await readStore();");
  assert.notEqual(postgresDispatch, -1);
  assert.notEqual(wholeStoreRead, -1);
  assert.ok(
    postgresDispatch < wholeStoreRead,
    "PostgreSQL must dispatch before the JSON whole-store read",
  );
  assert.doesNotMatch(dispatch.slice(0, wholeStoreRead), /readStore\(/);
});

test("only auto-resumable manual review operations enter the due-operation limit", async () => {
  const [postgresStore, store] = await Promise.all([
    readFile(postgresStorePath, "utf8"),
    readFile(storePath, "utf8"),
  ]);
  const postgresDue = section(
    postgresStore,
    "export async function listPostgresDueQuotaOperations(",
    "export async function createPostgresQuotaOperation(",
  );
  assert.match(
    postgresDue,
    /state not in \('completed', 'compensated', 'cancelled', 'manual_review'\)/,
  );
  assert.match(postgresDue, /operation_type = 'key_rotation'/);
  assert.match(postgresDue, /NewAPI token 余额观测不稳定/);
  assert.match(postgresDue, /data->>'upstreamTokenIdAfter'/);
  assert.match(postgresDue, /data->>'tokenAccountIdAfter'/);
  assert.ok(postgresDue.indexOf("manual_review") < postgresDue.indexOf("limit $2"));

  const jsonDue = section(
    store,
    "export async function listDueQuotaOperations(",
    "export async function appendQuotaLedgerEntry(",
  );
  assert.match(jsonDue, /item\.state !== "manual_review"/);
  assert.match(jsonDue, /canAutoResumeKeyRotationObservationFailure\(item\)/);
  assert.ok(jsonDue.indexOf("manual_review") < jsonDue.indexOf(".slice("));
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "real PostgreSQL due selector cannot starve a planned operation behind 81 manual reviews",
  { skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const postgresStore = await readFile(postgresStorePath, "utf8");
    const postgresDue = section(
      postgresStore,
      "export async function listPostgresDueQuotaOperations(",
      "export async function createPostgresQuotaOperation(",
    );
    const sqlMatch = postgresDue.match(/`(select data[\s\S]*?limit \$2)`/);
    assert.ok(sqlMatch?.[1], "could not extract the production due-operation SQL");

    const pool = new Pool({ connectionString: testDatabaseUrl, max: 2 });
    const suffix = `${process.pid}_${Date.now()}`;
    const manualCreatedAt = "1999-01-01T00:00:00.000Z";
    const plannedCreatedAt = "2000-01-01T00:00:00.000Z";
    const dueAt = "2100-01-01T00:00:00.000Z";
    const manualIds = Array.from(
      { length: 81 },
      (_, index) => `test_manual_starvation_${suffix}_${index}`,
    );
    const autoResumeId = `test_manual_auto_resume_${suffix}`;
    const plannedId = `test_planned_after_manual_${suffix}`;
    const allIds = [...manualIds, autoResumeId, plannedId];

    async function insertOperation(input: {
      id: string;
      state: "manual_review" | "planned";
      createdAt: string;
      index: number;
      operationType?: "quota_adjust" | "key_rotation";
      autoResume?: boolean;
    }) {
      const feishuUserId = `test_due_user_${suffix}_${input.index}`;
      const operation = {
        id: input.id,
        operationType: input.operationType ?? "quota_adjust",
        idempotencyKey: `test_due_source_${suffix}_${input.index}`,
        feishuUserId,
        billingPeriod: "2099-01",
        requestedAssignedQuota: 1,
        reservedDepartmentQuota: 0,
        operationGeneration: 1,
        state: input.state,
        attemptCount: 0,
        ...(input.autoResume
          ? {
              lastErrorMessage: "NewAPI token 余额观测不稳定",
              evidence: { retryFromState: "draining" },
            }
          : {}),
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
      await pool.query(
        `insert into quota_operations
          (id, operation_type, idempotency_key, feishu_user_id, department_id,
           billing_period, state, operation_generation, next_retry_at, data,
           created_at, updated_at, completed_at)
         values ($1, $2, $3, $4, null, '2099-01', $5, 1, null, $6, $7, $7, null)`,
        [
          input.id,
          operation.operationType,
          operation.idempotencyKey,
          feishuUserId,
          input.state,
          operation,
          input.createdAt,
        ],
      );
    }

    try {
      for (let index = 0; index < manualIds.length; index += 1) {
        await insertOperation({
          id: manualIds[index],
          state: "manual_review",
          createdAt: manualCreatedAt,
          index,
        });
      }
      await insertOperation({
        id: autoResumeId,
        state: "manual_review",
        createdAt: manualCreatedAt,
        index: manualIds.length,
        operationType: "key_rotation",
        autoResume: true,
      });
      await insertOperation({
        id: plannedId,
        state: "planned",
        createdAt: plannedCreatedAt,
        index: manualIds.length + 1,
      });

      const selected = await pool.query<{ data: { id: string } }>(sqlMatch[1], [
        dueAt,
        80,
      ]);
      assert.ok(
        selected.rows.some((row) => row.data.id === plannedId),
        "the planned operation must survive the production LIMIT",
      );
      assert.ok(
        selected.rows.some((row) => row.data.id === autoResumeId),
        "the exact legacy key-rotation observation failure must auto-resume",
      );
      assert.equal(
        selected.rows.some((row) => manualIds.includes(row.data.id)),
        false,
      );
    } finally {
      await pool
        .query("delete from quota_operations where id = any($1::text[])", [allIds])
        .catch(() => undefined);
      await pool.end();
    }
  },
);
