import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import {
  lockDepartmentMemberSyncUsersSql,
  upsertDepartmentMembersSql,
} from "../lib/department-member-sync-sql.ts";

const routePath = new URL(
  "../app/api/admin/departments/sync-members/route.ts",
  import.meta.url,
);
const workerPath = new URL("../lib/department-member-sync.ts", import.meta.url);
const storePath = new URL("../lib/store.ts", import.meta.url);
const postgresPath = new URL("../lib/postgres-store.ts", import.meta.url);
const instrumentationPath = new URL("../instrumentation.ts", import.meta.url);
const runtimeStartupPath = new URL("../lib/runtime-startup.ts", import.meta.url);
const adminClientPath = new URL("../components/admin-client.tsx", import.meta.url);
const migrationPath = new URL("../scripts/db-migrate.mjs", import.meta.url);

function section(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("department member sync HTTP is a durable 202 submission, not a directory workload", async () => {
  const [route, worker, instrumentation, runtimeStartup, client] = await Promise.all([
    readFile(routePath, "utf8"),
    readFile(workerPath, "utf8"),
    readFile(instrumentationPath, "utf8"),
    readFile(runtimeStartupPath, "utf8"),
    readFile(adminClientPath, "utf8"),
  ]);
  const post = section(route, "export async function POST", "\n}");
  assert.match(post, /enqueueDepartmentMemberSyncOperationAsActor/);
  assert.match(post, /status: 202/);
  assert.doesNotMatch(
    post,
    /listFeishuDepartmentUsers|getFeishuDepartmentNameById|upsertFeishuUser|prewarm|createPrewarmed/,
  );
  assert.match(route, /export async function GET/);
  assert.match(route, /listDepartmentMemberSyncOperations/);
  assert.match(worker, /listRunnableBillingOperations/);
  assert.match(worker, /claimBillingOperationExecution/);
  assert.match(worker, /renewBillingOperationExecution/);
  assert.match(worker, /withDepartmentMemberSyncWorkerFence/);
  assert.match(instrumentation, /ensureRuntimeStartup/);
  assert.match(runtimeStartup, /ensureDepartmentMemberSyncWorker/);
  assert.doesNotMatch(worker, /prewarmDepartmentMemberKeys|prewarmKeys/);
  assert.doesNotMatch(route, /prewarmKeys/);
  assert.doesNotMatch(client, /prewarmKeysOnMemberSync|同步并预热|无 Key 成员预热|已预热/);
  assert.match(client, /res\.status !== 202/);
  assert.match(client, /window\.setTimeout\([\s\S]*2_000/);
  assert.match(client, /任务已提交/);
});

test("directory pages are bounded and imported with one batch transaction per page", async () => {
  const [worker, postgres, feishu] = await Promise.all([
    readFile(workerPath, "utf8"),
    readFile(postgresPath, "utf8"),
    readFile(new URL("../lib/feishu.ts", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /const maxDirectoryPages = 100/);
  assert.match(worker, /listFeishuDepartmentUsersPage/);
  assert.match(worker, /batchUpsertDepartmentMembersForSync/);
  assert.match(feishu, /page_size: "50"/);
  assert.match(feishu, /items: \(data\.items \?\? \[\]\)\.slice\(0, 50\)/);
  assert.match(worker, /超过单任务 5000 人上限/);
  const batch = section(
    postgres,
    "export async function batchUpsertPostgresDepartmentMembersForSync",
    "export async function listPostgresDepartmentMemberSyncOperations",
  );
  assert.match(batch, /contacts\.length > 50/);
  assert.match(batch, /lockDepartmentMemberSyncUsersSql/);
  assert.match(batch, /select data[\s\S]*open_id = any\(\$2::text\[\]\)/);
  assert.match(batch, /upsertDepartmentMembersSql/);
  const contactLoop = section(
    batch,
    "for (const contact of input.contacts)",
    "if (rows.length === 0)",
  );
  assert.doesNotMatch(contactLoop, /client\.query/);
});

test("execution revalidates current actor scope under one lock order before every batch", async () => {
  const [postgres, store] = await Promise.all([
    readFile(postgresPath, "utf8"),
    readFile(storePath, "utf8"),
  ]);
  const execution = section(
    postgres,
    "async function getAuthorizedRunningDepartmentMemberSyncOperation",
    "export async function assertPostgresDepartmentMemberSyncExecutionAuthorized",
  );
  const identity = execution.indexOf("identityResult");
  const actor = execution.indexOf("assertPostgresDepartmentMemberSyncScope");
  const department = execution.indexOf("department-directory:");
  const operation = execution.indexOf("lockedResult");
  assert.ok(identity >= 0 && identity < actor);
  assert.ok(actor < department && department < operation);
  assert.match(execution, /status = 'running'/);
  assert.match(execution, /lease_id = \$2/);
  assert.match(execution, /lease_expires_at > statement_timestamp\(\)/);
  const scope = section(
    postgres,
    "async function assertPostgresDepartmentMemberSyncScope",
    "export async function enqueuePostgresDepartmentMemberSyncOperationAsActor",
  );
  assert.match(scope, /lockAdminScopeUsersInTransaction/);
  assert.match(scope, /resolvePostgresActorScopeInTransaction/);
  assert.match(scope, /actor\.status !== "active"/);
  assert.match(scope, /actorScope\.departmentId !== input\.departmentId/);
  assert.match(scope, /目标部门已不存在/);
  const jsonBatch = section(
    store,
    "export async function batchUpsertDepartmentMembersForSync",
    "export async function listDepartmentMemberSyncOperations",
  );
  assert.match(jsonBatch, /runningJsonDepartmentMemberSyncOperation/);
  assert.match(jsonBatch, /assertJsonDepartmentMemberSyncScope/);
});

test("control-plane baseline accepts durable per-department sync jobs and indexes status reads", async () => {
  const migration = await readFile(migrationPath, "utf8");
  assert.match(migration, /check \(kind = 'department_member_sync'\)/);
  assert.match(migration, /billing_operations_one_active_department_sync_idx/);
  assert.match(migration, /input->>'departmentId'/);
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "real PostgreSQL batches 50 members and shares the OAuth advisory fence",
  {
    skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is not configured",
    timeout: 15_000,
  },
  async () => {
    const admin = new Pool({ connectionString: testDatabaseUrl, max: 2 });
    const suffix = `${process.pid}_${Date.now()}`;
    const schema = `ti_directory_sync_${suffix}`;
    await admin.query(`create schema "${schema}"`);
    await admin.query(
      `create table "${schema}".feishu_users
       (like public.feishu_users including all)`,
    );
    const scopedUrl = new URL(testDatabaseUrl!);
    scopedUrl.searchParams.set("options", `-csearch_path=${schema},public`);
    const pool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
    try {
      const now = "2099-01-01T00:00:00.000Z";
      const tenantKey = `tenant_${suffix}`;
      const departmentId = `department_${suffix}`;
      const rows = Array.from({ length: 50 }, (_, index) => {
        const user = {
          id: `fu_${suffix}_${index}`,
          tenantKey,
          openId: `ou_${suffix}_${index}`,
          departmentId,
          status: "active",
          createdAt: now,
          updatedAt: now,
        };
        return {
          id: user.id,
          tenant_key: tenantKey,
          open_id: user.openId,
          department_id: departmentId,
          data: user,
          created_at: now,
          updated_at: now,
        };
      });
      const lockKeys = rows
        .map((row) => `feishu_user:${tenantKey}:${row.open_id}`)
        .sort();
      const started = performance.now();
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(lockDepartmentMemberSyncUsersSql, [lockKeys]);
        const inserted = await client.query(upsertDepartmentMembersSql, [
          JSON.stringify(rows),
        ]);
        await client.query("commit");
        assert.equal(inserted.rowCount, 50);
      } finally {
        client.release();
      }
      assert.ok(performance.now() - started < 1_500);

      const target = rows[0];
      const oauth = await pool.connect();
      const batch = await pool.connect();
      try {
        await oauth.query("begin");
        await oauth.query(
          "select pg_advisory_xact_lock(hashtext($1)::bigint)",
          [`feishu_user:${tenantKey}:${target.open_id}`],
        );
        const disabledAt = "2099-01-01T00:01:00.000Z";
        const disabled = { ...target.data, status: "disabled", updatedAt: disabledAt };
        await oauth.query(
          `update feishu_users set data = $2, updated_at = $3 where id = $1`,
          [target.id, disabled, disabledAt],
        );

        let acquired = false;
        const blockedBatch = (async () => {
          await batch.query("begin");
          await batch.query(lockDepartmentMemberSyncUsersSql, [[lockKeys[0]]]);
          acquired = true;
          const current = await batch.query<{ data: typeof disabled }>(
            "select data from feishu_users where id = $1 for update",
            [target.id],
          );
          const preserved = {
            ...current.rows[0].data,
            name: "directory refresh",
            updatedAt: "2099-01-01T00:02:00.000Z",
          };
          await batch.query(upsertDepartmentMembersSql, [
            JSON.stringify([{
              ...target,
              data: preserved,
              updated_at: preserved.updatedAt,
            }]),
          ]);
          await batch.query("commit");
        })();
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(acquired, false);
        await oauth.query("commit");
        await blockedBatch;
        const final = await pool.query<{
          data: typeof disabled & { name?: string };
        }>(
          "select data from feishu_users where id = $1",
          [target.id],
        );
        assert.equal(final.rows[0].data.status, "disabled");
        assert.equal(final.rows[0].data.name, "directory refresh");
      } finally {
        await oauth.query("rollback").catch(() => undefined);
        await batch.query("rollback").catch(() => undefined);
        oauth.release();
        batch.release();
      }

      const protectedRow = rows[1];
      const otherDepartment = `other_${suffix}`;
      await pool.query(
        `update feishu_users
         set department_id = $2::text,
             data = data || jsonb_build_object('departmentId', $2::text)
         where id = $1`,
        [protectedRow.id, otherDepartment],
      );
      const blocked = await pool.query(upsertDepartmentMembersSql, [
        JSON.stringify([protectedRow]),
      ]);
      assert.equal(blocked.rowCount, 0);
      const ownership = await pool.query<{ department_id: string }>(
        "select department_id from feishu_users where id = $1",
        [protectedRow.id],
      );
      assert.equal(ownership.rows[0].department_id, otherDepartment);
    } finally {
      await pool.end();
      await admin.query(`drop schema "${schema}" cascade`);
      await admin.end();
    }
  },
);
