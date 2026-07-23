import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { Pool, type PoolClient } from "pg";
import ts from "typescript";
import { resolveSessionAdminScopeProjection } from "../lib/admin-scope.ts";
import { packagePeriod } from "../lib/package-reset.ts";
import {
  canReopenFirstProvisionAfterAccessRevoke,
  reopenFirstProvisionAfterAccessRevoke,
} from "../lib/quota-saga-state.ts";

const submitPath = new URL("../lib/quota-operation-submit.ts", import.meta.url);
const storePath = new URL("../lib/store.ts", import.meta.url);
const routePath = new URL(
  "../app/api/admin/users/[id]/quota-adjust/route.ts",
  import.meta.url,
);

function section(source: string, startMarker: string, endMarker?: string) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  if (!endMarker) return source.slice(start);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

function assertOrdered(source: string, markers: string[]) {
  let cursor = -1;
  for (const marker of markers) {
    const next = source.indexOf(marker, cursor + 1);
    assert.ok(next > cursor, `${marker} must follow the previous atomic-submit step`);
    cursor = next;
  }
}

test("active-Key 调额在 PG/JSON 都原子重验管理员范围并一次写入 request+operation", async () => {
  const [submitSource, storeSource, routeSource] = await Promise.all([
    readFile(submitPath, "utf8"),
    readFile(storePath, "utf8"),
    readFile(routePath, "utf8"),
  ]);
  const postgresSubmit = section(
    submitSource,
    "export async function submitPostgresAdminQuotaAdjustment(",
    "export async function submitPostgresKeyRotation(",
  );
  const jsonSubmit = section(
    storeSource,
    "export async function submitJsonAdminQuotaAdjustment(",
    "export async function createQuotaOperation(",
  );
  const activeRoute = section(
    routeSource,
    'await assertQuotaWriteActionEnabled("quota_adjust")',
  );

  assert.match(postgresSubmit, /return withQuotaSubmitTransaction\(async \(client\) =>/);
  assertOrdered(postgresSubmit, [
    "lockAdminScopeUsersForSubmission(client",
    "`user-quota:${input.targetUserId}`",
    "readAdminActorScope(client, input.actorUserId)",
    "select data from feishu_users where id = $1 for update",
    "assertAdminActorCanTargetUser(actor, scope, targetUser)",
    "readOperationSubmissionState(client",
    "assertNoConflictingOperation(state",
    "where feishu_user_id = $1 and status = 'active'",
    "saveTokenRequestRow(client, quotaRequest)",
    "insertQuotaOperationRow(client, operation)",
  ]);
  assert.match(submitSource, /`admin-scope-user:\$\{feishuUserId\}`/);
  assert.match(submitSource, /environmentRoot && !actorIsRoot/);
  assert.match(submitSource, /scope\.source === "environment"/);
  assert.match(postgresSubmit, /readOptionalAdminScopeForUser\(client, targetUser\)/);
  assert.match(postgresSubmit, /\?\.scopeType !== "global"/);
  assert.match(postgresSubmit, /upstreamTokenIdBefore: activeAccount\.newapiTokenId/);
  assert.match(postgresSubmit, /tokenAccountIdBefore: activeAccount\.id/);
  assert.match(postgresSubmit, /operationGeneration: \(state\?\.generation \?\? 0\) \+ 1/);

  assertOrdered(jsonSubmit, [
    "withAdminScopeUserLocks(",
    "withUserQuotaOperationLock(input.targetUserId",
    "mutate(async (store) =>",
    "authorizeJsonAdminUserAction(store",
    "const idempotent = store.quotaOperations.find(",
    "const openOperation = store.quotaOperations.find(",
    "const activeAccount = [...store.tokenAccounts]",
    "store.tokenRequests.push(request)",
    "store.quotaOperations.push(operation)",
  ]);
  assert.match(jsonSubmit, /error instanceof AdminUserActionAuthorizationError/);
  assert.match(jsonSubmit, /resolveAdminScopeForKnownUser\(targetUser, store\)/);
  assert.match(jsonSubmit, /upstreamTokenIdBefore: activeAccount\.newapiTokenId/);
  assert.match(jsonSubmit, /tokenAccountIdBefore: activeAccount\.id/);

  assert.match(activeRoute, /await submitAndScheduleDurableQuotaWork\(/);
  assert.match(activeRoute, /submitPostgresAdminQuotaAdjustment\(/);
  assert.match(activeRoute, /submitJsonAdminQuotaAdjustment\(/);
  assert.match(activeRoute, /scheduleAfter: after/);
  assert.match(activeRoute, /wakeWorker: ensureQuotaOperationWorker/);
  assert.match(routeSource, /getAdminScopeForKnownUser\(targetUser\)/);
  assert.match(routeSource, /!activeToken && explicitClientRequestId/);
  assert.match(routeSource, /`quota-adjust:\$\{explicitClientRequestId\}`/);
  assert.match(routeSource, /if \(!activeToken && !existingAdjustment\)/);
  assert.doesNotMatch(
    activeRoute,
    /enqueueQuotaAdjustment|runQuotaOperation|await createTokenRequest|approved_provision_failed/,
  );
});

type QuotaAdjustmentSubmitApi = {
  QuotaSubmissionError: new (...args: never[]) => Error;
  submitPostgresAdminQuotaAdjustment(input: {
    actorUserId: string;
    targetUserId: string;
    approvedMonthlyQuota: number;
    reason: string;
    clientRequestId: string;
  }): Promise<{
    request: { id: string; feishuUserId: string; requestedMonthlyQuota: number };
    operation: {
      id: string;
      requestId?: string;
      feishuUserId: string;
      requestedAssignedQuota?: number;
      operationGeneration: number;
      tokenAccountIdBefore?: string;
      departmentId?: string;
      reservedDepartmentQuota: number;
    };
    deduplicated: boolean;
  }>;
};

async function loadQuotaAdjustmentHarness(input: {
  databaseUrl: string;
  environmentRootOpenIds: string[];
  fixedQuotaOperationId?: string;
}) {
  const source = await readFile(submitPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: "quota-operation-submit.ts",
  }).outputText;
  let nextId = 0;
  const sharedGlobal: Record<string, unknown> = {};
  const module = { exports: {} as QuotaAdjustmentSubmitApi };
  const config = {
    databaseUrl: input.databaseUrl,
    storeBackend: "postgres",
    postgres: {
      quotaSubmitPoolMax: 2,
      poolIdleTimeoutMs: 30_000,
      quotaSubmitConnectionTimeoutMs: 1_000,
      quotaSubmitLockTimeoutMs: 5_000,
      quotaSubmitStatementTimeoutMs: 5_000,
    },
    admin: { systemAdminOpenIds: input.environmentRootOpenIds },
    newapi: { quotaPerUnit: 10 },
  };
  const imports: Record<string, Record<string, unknown>> = {
    pg: { Pool },
    "@/lib/admin-scope": {
      resolveSessionAdminScopeProjection,
      tokenRequestInAdminScope: () => false,
    },
    "@/lib/config": { getConfig: () => config },
    "@/lib/department-quota": {
      initialDepartmentQuotaLimit: (allocatedQuota: number) =>
        Math.max(1000, Math.max(Math.round(allocatedQuota), 0)),
    },
    "@/lib/crypto": {
      nowIso: () => "2099-01-15T00:00:00.000Z",
      randomId: (prefix: string) =>
        prefix === "qo" && input.fixedQuotaOperationId
          ? input.fixedQuotaOperationId
          : `${prefix}_atomic_${++nextId}`,
      sha256Hex: (value: string) =>
        createHash("sha256").update(value).digest("hex"),
    },
    "@/lib/newapi": { toNewApiQuota: (quota: number) => Math.round(quota * 10) },
    "@/lib/package-reset": { packagePeriod },
    "@/lib/quota-model": { shanghaiBillingPeriod: () => "2099-01" },
    "@/lib/quota-saga-state": {
      canReopenFirstProvisionAfterAccessRevoke,
      reopenFirstProvisionAfterAccessRevoke,
    },
    "@/lib/token-request-policy": {
      tokenRequestRequiresAdminDecision: () => false,
    },
  };
  runInNewContext(transpiled, {
    module,
    exports: module.exports,
    require: (specifier: string) => {
      const dependency = imports[specifier];
      if (!dependency) throw new Error(`unexpected quota-submit import: ${specifier}`);
      return dependency;
    },
    console,
    setTimeout,
    clearTimeout,
    globalThis: sharedGlobal,
  });
  return {
    api: module.exports,
    async close() {
      const pool = sharedGlobal.__tokenInsideQuotaSubmitPool as Pool | undefined;
      await pool?.end();
    },
  };
}

async function createIsolatedQuotaSubmitSchema(testDatabaseUrl: string, name: string) {
  const adminPool = new Pool({ connectionString: testDatabaseUrl, max: 2 });
  await adminPool.query(`create schema "${name}"`);
  for (const table of [
    "feishu_users",
    "admin_scopes",
    "token_requests",
    "token_accounts",
    "quota_operations",
    "user_quota_states",
  ]) {
    await adminPool.query(
      `create table "${name}"."${table}" (like public."${table}" including all)`,
    );
  }
  const schemaUrl = new URL(testDatabaseUrl);
  schemaUrl.searchParams.set("options", `-csearch_path=${name},public`);
  return {
    adminPool,
    pool: new Pool({ connectionString: schemaUrl.toString(), max: 4 }),
    databaseUrl: schemaUrl.toString(),
    async close() {
      await this.pool.end();
      await adminPool.query(`drop schema "${name}" cascade`);
      await adminPool.end();
    },
  };
}

async function insertUser(
  client: Pool | PoolClient,
  input: { id: string; openId: string; departmentId?: string },
) {
  const now = "2099-01-01T00:00:00.000Z";
  const user = {
    id: input.id,
    tenantKey: "tenant-atomic-submit",
    openId: input.openId,
    departmentId: input.departmentId,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  await client.query(
    `insert into feishu_users
      (id, tenant_key, open_id, department_id, data, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $6)`,
    [user.id, user.tenantKey, user.openId, user.departmentId ?? null, user, now],
  );
  return user;
}

async function insertActiveAccount(
  client: Pool | PoolClient,
  input: { id: string; userId: string; generation: number },
) {
  const now = "2099-01-01T00:00:00.000Z";
  const account = {
    id: input.id,
    feishuUserId: input.userId,
    tokenRequestId: `request-${input.id}`,
    newapiTokenId: `upstream-${input.id}`,
    keyHash: `hash-${input.id}`,
    status: "active",
    billingPeriod: "2099-01",
    operationGeneration: input.generation,
    activatedAt: now,
    createdAt: now,
  };
  await client.query(
    `insert into token_accounts
      (id, feishu_user_id, token_request_id, newapi_token_id, key_hash,
       status, billing_period, operation_generation, activated_at, data, created_at)
     values ($1,$2,$3,$4,$5,'active','2099-01',$6,$7,$8,$7)`,
    [
      account.id,
      account.feishuUserId,
      account.tokenRequestId,
      account.newapiTokenId,
      account.keyHash,
      account.operationGeneration,
      now,
      account,
    ],
  );
  return account;
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "real PostgreSQL active-Key 调额提交幂等且 scope 撤销竞态不会留下孤儿 request",
  { skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(testDatabaseUrl);
    const suffix = `${process.pid}_${Date.now()}`;
    const schema = await createIsolatedQuotaSubmitSchema(
      testDatabaseUrl,
      `test_quota_adjust_atomic_${suffix}`,
    );
    const rootOpenId = `root-open-${suffix}`;
    const unscopedRootOpenId = `unscoped-root-open-${suffix}`;
    const rootUserId = `root-user-${suffix}`;
    const targetUserId = `target-user-${suffix}`;
    const harness = await loadQuotaAdjustmentHarness({
      databaseUrl: schema.databaseUrl,
      environmentRootOpenIds: [rootOpenId, unscopedRootOpenId],
    });
    let blocker: PoolClient | undefined;
    try {
      await insertUser(schema.pool, { id: rootUserId, openId: rootOpenId });
      await insertUser(schema.pool, {
        id: targetUserId,
        openId: `target-open-${suffix}`,
        departmentId: `department-${suffix}`,
      });
      const account = await insertActiveAccount(schema.pool, {
        id: `account-${suffix}`,
        userId: targetUserId,
        generation: 7,
      });
      await schema.pool.query(
        `insert into user_quota_states
          (feishu_user_id, admission, active_generation, operation_id, data, updated_at)
         values ($1, 'open', 7, null, $2, $3)`,
        [
          targetUserId,
          {
            feishuUserId: targetUserId,
            admission: "open",
            activeGeneration: 7,
            updatedAt: "2099-01-01T00:00:00.000Z",
          },
          "2099-01-01T00:00:00.000Z",
        ],
      );

      const first = await harness.api.submitPostgresAdminQuotaAdjustment({
        actorUserId: rootUserId,
        targetUserId,
        approvedMonthlyQuota: 12,
        reason: "atomic adjustment",
        clientRequestId: `idem-${suffix}`,
      });
      assert.equal(first.deduplicated, false);
      assert.equal(first.operation.requestId, first.request.id);
      assert.equal(first.operation.operationGeneration, 8);
      assert.equal(first.operation.requestedAssignedQuota, 120);
      assert.equal(first.operation.tokenAccountIdBefore, account.id);

      const repeated = await harness.api.submitPostgresAdminQuotaAdjustment({
        actorUserId: rootUserId,
        targetUserId,
        approvedMonthlyQuota: 12,
        reason: "same atomic adjustment",
        clientRequestId: `idem-${suffix}`,
      });
      assert.equal(repeated.deduplicated, true);
      assert.equal(repeated.request.id, first.request.id);
      assert.equal(repeated.operation.id, first.operation.id);
      const committed = await schema.pool.query<{ requests: number; operations: number }>(
        `select
           (select count(*)::integer from token_requests where feishu_user_id = $1) as requests,
           (select count(*)::integer from quota_operations where feishu_user_id = $1) as operations`,
        [targetUserId],
      );
      assert.deepEqual(committed.rows[0], { requests: 1, operations: 1 });

      const unscopedRootUserId = `unscoped-root-user-${suffix}`;
      await insertUser(schema.pool, {
        id: unscopedRootUserId,
        openId: unscopedRootOpenId,
      });
      await insertActiveAccount(schema.pool, {
        id: `unscoped-root-account-${suffix}`,
        userId: unscopedRootUserId,
        generation: 3,
      });
      const unscoped = await harness.api.submitPostgresAdminQuotaAdjustment({
        actorUserId: rootUserId,
        targetUserId: unscopedRootUserId,
        approvedMonthlyQuota: 21,
        reason: "unscoped environment root adjustment",
        clientRequestId: `unscoped-root-${suffix}`,
      });
      assert.equal(unscoped.operation.departmentId, undefined);
      assert.equal(unscoped.operation.reservedDepartmentQuota, 0);
      assert.equal(unscoped.operation.requestedAssignedQuota, 210);

      const manualGlobalActorId = `manual-global-actor-${suffix}`;
      await insertUser(schema.pool, {
        id: manualGlobalActorId,
        openId: `manual-global-actor-open-${suffix}`,
      });
      const manualGlobalScope = {
        id: `manual-global-scope-${suffix}`,
        feishuUserId: manualGlobalActorId,
        scopeType: "global",
        source: "manual",
        status: "active",
        createdAt: "2099-01-01T00:00:00.000Z",
        updatedAt: "2099-01-01T00:00:00.000Z",
      };
      await schema.pool.query(
        `insert into admin_scopes
          (id, feishu_user_id, scope_type, department_id, source, status,
           data, created_at, updated_at)
         values ($1,$2,'global',null,'manual','active',$3,$4,$4)`,
        [
          manualGlobalScope.id,
          manualGlobalActorId,
          manualGlobalScope,
          manualGlobalScope.createdAt,
        ],
      );
      await assert.rejects(
        harness.api.submitPostgresAdminQuotaAdjustment({
          actorUserId: manualGlobalActorId,
          targetUserId: unscopedRootUserId,
          approvedMonthlyQuota: 22,
          reason: "manual global must not adjust environment root",
          clientRequestId: `manual-global-root-${suffix}`,
        }),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "root_required",
      );

      const scopedActorId = `scoped-actor-${suffix}`;
      const scopedTargetId = `scoped-target-${suffix}`;
      const departmentId = `scoped-department-${suffix}`;
      await insertUser(schema.pool, {
        id: scopedActorId,
        openId: `scoped-actor-open-${suffix}`,
        departmentId,
      });
      await insertUser(schema.pool, {
        id: scopedTargetId,
        openId: `scoped-target-open-${suffix}`,
        departmentId,
      });
      await insertActiveAccount(schema.pool, {
        id: `scoped-account-${suffix}`,
        userId: scopedTargetId,
        generation: 2,
      });
      const scope = {
        id: `scope-${suffix}`,
        feishuUserId: scopedActorId,
        scopeType: "department",
        departmentId,
        source: "manual",
        status: "active",
        createdAt: "2099-01-01T00:00:00.000Z",
        updatedAt: "2099-01-01T00:00:00.000Z",
      };
      await schema.pool.query(
        `insert into admin_scopes
          (id, feishu_user_id, scope_type, department_id, source, status,
           data, created_at, updated_at)
         values ($1,$2,'department',$3,'manual','active',$4,$5,$5)`,
        [scope.id, scopedActorId, departmentId, scope, scope.createdAt],
      );

      blocker = await schema.pool.connect();
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
        `admin-scope-user:${scopedActorId}`,
      ]);
      const disabledScope = {
        ...scope,
        status: "disabled",
        disabledReason: "manual_revoke",
        updatedAt: "2099-01-02T00:00:00.000Z",
      };
      await blocker.query(
        `update admin_scopes
         set status = 'disabled', data = $2, updated_at = $3
         where id = $1`,
        [scope.id, disabledScope, disabledScope.updatedAt],
      );
      const raced = harness.api.submitPostgresAdminQuotaAdjustment({
        actorUserId: scopedActorId,
        targetUserId: scopedTargetId,
        approvedMonthlyQuota: 9,
        reason: "must observe revoked scope",
        clientRequestId: `revoked-${suffix}`,
      });
      const beforeCommit = await Promise.race([
        raced.then(
          () => "settled",
          () => "settled",
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 40)),
      ]);
      assert.equal(beforeCommit, "blocked");
      await blocker.query("commit");
      blocker.release();
      blocker = undefined;
      await assert.rejects(
        raced,
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "admin_scope_required",
      );
      const rejected = await schema.pool.query<{ requests: number; operations: number }>(
        `select
           (select count(*)::integer from token_requests where feishu_user_id = $1) as requests,
           (select count(*)::integer from quota_operations where feishu_user_id = $1) as operations`,
        [scopedTargetId],
      );
      assert.deepEqual(rejected.rows[0], { requests: 0, operations: 0 });
    } finally {
      if (blocker) {
        await blocker.query("rollback").catch(() => undefined);
        blocker.release();
      }
      await harness.close();
      await schema.close();
    }
  },
);

test(
  "real PostgreSQL operation insert failure rolls the quota-adjust request back",
  { skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(testDatabaseUrl);
    const suffix = `${process.pid}_${Date.now()}`;
    const schema = await createIsolatedQuotaSubmitSchema(
      testDatabaseUrl,
      `test_quota_adjust_rollback_${suffix}`,
    );
    const rootOpenId = `rollback-root-open-${suffix}`;
    const rootUserId = `rollback-root-user-${suffix}`;
    const targetUserId = `rollback-target-user-${suffix}`;
    const collisionId = `quota-operation-collision-${suffix}`;
    const harness = await loadQuotaAdjustmentHarness({
      databaseUrl: schema.databaseUrl,
      environmentRootOpenIds: [rootOpenId],
      fixedQuotaOperationId: collisionId,
    });
    try {
      await insertUser(schema.pool, { id: rootUserId, openId: rootOpenId });
      await insertUser(schema.pool, {
        id: targetUserId,
        openId: `rollback-target-open-${suffix}`,
        departmentId: `rollback-department-${suffix}`,
      });
      await insertActiveAccount(schema.pool, {
        id: `rollback-account-${suffix}`,
        userId: targetUserId,
        generation: 1,
      });
      const collision = {
        id: collisionId,
        operationType: "quota_adjust",
        idempotencyKey: `unrelated-${suffix}`,
        feishuUserId: `unrelated-user-${suffix}`,
        billingPeriod: "2099-01",
        reservedDepartmentQuota: 0,
        operationGeneration: 1,
        state: "completed",
        attemptCount: 0,
        createdAt: "2099-01-01T00:00:00.000Z",
        updatedAt: "2099-01-01T00:00:00.000Z",
        completedAt: "2099-01-01T00:00:00.000Z",
      };
      await schema.pool.query(
        `insert into quota_operations
          (id, operation_type, idempotency_key, feishu_user_id, department_id,
           billing_period, state, operation_generation, data, created_at,
           updated_at, completed_at)
         values ($1,'quota_adjust',$2,$3,null,'2099-01','completed',1,$4,$5,$5,$5)`,
        [
          collision.id,
          collision.idempotencyKey,
          collision.feishuUserId,
          collision,
          collision.createdAt,
        ],
      );

      await assert.rejects(
        harness.api.submitPostgresAdminQuotaAdjustment({
          actorUserId: rootUserId,
          targetUserId,
          approvedMonthlyQuota: 15,
          reason: "force operation insert rollback",
          clientRequestId: `rollback-${suffix}`,
        }),
      );
      const persisted = await schema.pool.query<{ requests: number; operations: number }>(
        `select
           (select count(*)::integer from token_requests where feishu_user_id = $1) as requests,
           (select count(*)::integer from quota_operations where idempotency_key = $2) as operations`,
        [targetUserId, `quota-adjust:rollback-${suffix}`],
      );
      assert.deepEqual(persisted.rows[0], { requests: 0, operations: 0 });
    } finally {
      await harness.close();
      await schema.close();
    }
  },
);
