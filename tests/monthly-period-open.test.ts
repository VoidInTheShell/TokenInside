import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { Pool, type PoolClient } from "pg";
import ts from "typescript";
import {
  initialDepartmentQuotaLimit,
  validateDepartmentQuotaLimit,
} from "../lib/department-quota.ts";
import {
  lockDepartmentMemberSyncUsersSql,
  upsertDepartmentMembersSql,
} from "../lib/department-member-sync-sql.ts";
import { verifyGreenfieldInstallationBinding } from "../lib/greenfield-installation.ts";
import {
  assertPackageResetExecutionAllowed,
  normalizePackageResetPolicy,
  PACKAGE_RESET_SYSTEM_ACTOR,
} from "../lib/package-reset.ts";
import {
  canReopenMonthlyOpenAfterAccessRevoke,
  reopenMonthlyOpenAfterAccessRevoke,
} from "../lib/quota-saga-state.ts";
import {
  listStaleUserAccessResumeCandidatesSql,
  markUserAccessResumeEnableAttemptSql,
  rollbackPendingUserAccessResumeSql,
} from "../lib/user-access-recovery-sql.ts";
import { preserveUserAccessRevocationBarrier } from "../lib/user-access-state.ts";

const billingPath = new URL("../lib/billing.ts", import.meta.url);
const postgresStorePath = new URL("../lib/postgres-store.ts", import.meta.url);
const storePath = new URL("../lib/store.ts", import.meta.url);
const quotaSagaPath = new URL("../lib/quota-saga.ts", import.meta.url);
const baselinePath = new URL("../scripts/db-migrate.mjs", import.meta.url);

function section(source: string, startMarker: string, endMarker: string) {
  const normalized = source.replace(/\r\n/g, "\n");
  const start = normalized.indexOf(startMarker);
  const end = normalized.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return normalized.slice(start, end);
}

type PeriodOpenSnapshot = {
  candidates: Array<{
    feishuUserId: string;
    departmentId?: string;
    assignedMonthlyQuota: number;
    activeTokenCount: number;
    isGlobalAdmin: boolean;
    alreadyOpened: boolean;
  }>;
  departmentQuotaPeriods: Array<{
    departmentId: string;
    period: string;
    quotaLimit: number;
  }>;
  quotaOperations: Array<{
    id: string;
    feishuUserId: string;
    departmentId?: string;
  }>;
  settings: {
    usageSyncPolicy?: {
      intervalMinutes: number;
      settlementLagMinutes?: number;
    };
  };
  usageSyncCheckpoint: {
    settledThrough?: string;
    integrityBlockedAt?: string;
    lastRunStatus?: string;
  } | null;
};

type MonthlyOpenInput = {
  feishuUserId: string;
  departmentId?: string;
  period: string;
  assignedMonthlyQuota: number;
  createdByOpenId?: string;
};

type BillingApi = {
  buildMonthlyPeriodOpenPlan(input: { period?: string }): Promise<{
    period: string;
    blocked: boolean;
    blockers: Array<{ type: string; feishuUserId?: string }>;
    departments: Array<{
      departmentId: string;
      users: Array<{ feishuUserId: string }>;
    }>;
    unscoped: {
      scope: "global";
      users: Array<{ feishuUserId: string }>;
    };
  }>;
  enqueueMonthlyPeriodOpenPlan(input: {
    plan: Awaited<ReturnType<BillingApi["buildMonthlyPeriodOpenPlan"]>>;
    createdByOpenId: string;
    limit?: number;
  }): Promise<unknown>;
};

async function loadBillingHarness(input: {
  backend: "json" | "postgres";
  snapshot: PeriodOpenSnapshot;
  enqueue?: (items: MonthlyOpenInput[]) => Promise<unknown>;
}) {
  const source = await readFile(billingPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: "billing.ts",
  }).outputText;
  let postgresReads = 0;
  let jsonReads = 0;
  const enqueued: MonthlyOpenInput[][] = [];
  const module = { exports: {} as BillingApi };
  const imports: Record<string, Record<string, unknown>> = {
    "@/lib/config": {
      getConfig: () => ({
        storeBackend: input.backend,
        newapi: { quotaPerUnit: 1 },
        admin: { systemAdminOpenIds: ["open-root"] },
      }),
    },
    "@/lib/quota-model": {
      hongKongBillingPeriod: () => "2099-01",
      isSettlementWatermarkFresh: () => true,
    },
    "@/lib/package-reset": {
      PACKAGE_RESET_SYSTEM_ACTOR,
    },
    "@/lib/postgres-store": {
      getPostgresMonthlyPeriodOpenSnapshot: async () => {
        postgresReads += 1;
        return input.snapshot;
      },
    },
    "@/lib/quota-saga": {
      enqueueMonthlyOpenBatch: async (items: MonthlyOpenInput[]) => {
        enqueued.push(items);
        return input.enqueue ? input.enqueue(items) : items;
      },
    },
    "@/lib/store": {
      getStoreSnapshot: async () => {
        jsonReads += 1;
        throw new Error("JSON fallback was not supplied to this harness");
      },
    },
  };
  runInNewContext(transpiled, {
    module,
    exports: module.exports,
    require: (specifier: string) => {
      const dependency = imports[specifier];
      if (!dependency) throw new Error(`unexpected billing import: ${specifier}`);
      return dependency;
    },
    console,
  });
  return {
    api: module.exports,
    enqueued,
    get postgresReads() {
      return postgresReads;
    },
    get jsonReads() {
      return jsonReads;
    },
  };
}

test("period-open planning uses one minimal control query and retains only a JSON fallback", async () => {
  const [billing, postgres, store, saga, baseline] = await Promise.all([
    readFile(billingPath, "utf8"),
    readFile(postgresStorePath, "utf8"),
    readFile(storePath, "utf8"),
    readFile(quotaSagaPath, "utf8"),
    readFile(baselinePath, "utf8"),
  ]);
  const billingSnapshot = section(
    billing,
    "async function getMonthlyPeriodOpenSnapshot(",
    "export async function buildMonthlyPeriodOpenPlan",
  );
  const postgresSnapshot = section(
    postgres,
    "export async function getPostgresMonthlyPeriodOpenSnapshot(",
    "export async function readPostgresStore",
  );
  const jsonBatch = section(
    store,
    "export async function createMonthlyOpenQuotaOperations(",
    "export async function findQuotaOperationById",
  );
  const postgresBatch = section(
    postgres,
    "export async function createPostgresMonthlyOpenOperations(",
    "export async function updatePostgresQuotaOperation(",
  );
  const sagaBatch = section(
    saga,
    "export async function enqueueMonthlyOpenBatch(",
    "export async function claimQuotaOperationCredential(",
  );

  assert.ok(
    billingSnapshot.indexOf('config.storeBackend === "postgres"') <
      billingSnapshot.indexOf("getStoreSnapshot()"),
  );
  assert.match(billingSnapshot, /getPostgresMonthlyPeriodOpenSnapshot\(period\)/);
  assert.match(billingSnapshot, /const store = await getStoreSnapshot\(\)/);

  assert.match(postgresSnapshot, /withControlClient/);
  assert.equal(postgresSnapshot.match(/client\.query/g)?.length, 1);
  assert.match(postgresSnapshot, /distinct on \(policy\.feishu_user_id\)/);
  assert.match(postgresSnapshot, /policy\.effective_from_period <= \$1/);
  assert.match(postgresSnapshot, /latest_policy\.department_id/);
  assert.match(postgresSnapshot, /account\.status = 'active'/);
  assert.match(postgresSnapshot, /scope\.scope_type = 'global'/);
  assert.match(postgresSnapshot, /entry\.entry_type = 'period_open_authorization'/);
  assert.match(postgresSnapshot, /quota_period\.period = \$1/);
  assert.match(
    postgresSnapshot,
    /operation\.state not in \('completed', 'compensated', 'cancelled'\)/,
  );
  assert.match(postgresSnapshot, /usageSyncPolicy,intervalMinutes/);
  assert.match(postgresSnapshot, /checkpoint\.data->>'settledThrough'/);
  assert.match(postgresSnapshot, /checkpoint\.data->>'integrityBlockedAt'/);
  assert.doesNotMatch(postgresSnapshot, /readPostgresStore|readDataRows/);
  assert.doesNotMatch(postgresSnapshot, /proxy_request_logs|newapi_usage_records/);
  assert.doesNotMatch(postgresSnapshot, /operation\.data|select settings\.data|select checkpoint\.data/);
  assert.doesNotMatch(postgresSnapshot, /credentialCiphertext|accessTokenCiphertext/);

  assert.match(jsonBatch, /departmentId\?: string/);
  assert.match(jsonBatch, /getConfig\(\)\.admin\.systemAdminOpenIds/);
  assert.match(jsonBatch, /套餐重置仅允许有效 root 用户执行/);
  assert.match(jsonBatch, /userLockKeys/);
  assert.match(jsonBatch, /currentPolicy = store\.userQuotaPolicies/);
  assert.match(jsonBatch, /entry\.entryType === "period_open_authorization"/);
  assert.match(jsonBatch, /currentPolicy\.assignedMonthlyQuota/);
  assert.match(jsonBatch, /currentPolicy\.departmentId/);
  assert.match(jsonBatch, /checkpoint\.integrityBlockedAt/);
  assert.match(jsonBatch, /issue\.blocksSettlement/);
  assert.match(jsonBatch, /canReopenMonthlyOpenAfterAccessRevoke\(idempotent\)/);
  assert.match(jsonBatch, /reopenMonthlyOpenAfterAccessRevoke/);
  assert.match(jsonBatch, /item\.state !== "cancelled"/);
  assert.match(jsonBatch, /reservedDepartmentQuota: input\.departmentId[\s\S]*?\? input\.assignedMonthlyQuota[\s\S]*?: 0/);
  assert.match(jsonBatch, /state: input\.departmentId \? "budget_reserved" : "planned"/);

  assert.match(postgresBatch, /departmentId\?: string/);
  assert.match(postgresBatch, /withControlTransaction/);
  assert.match(postgresBatch, /lockAdminScopeUsersInTransaction/);
  assert.match(postgresBatch, /getConfig\(\)\.admin\.systemAdminOpenIds/);
  assert.match(postgresBatch, /套餐重置仅允许 root 执行/);
  assert.match(postgresBatch, /pg_try_advisory_xact_lock\([\s\S]*?usage_sync:newapi_logs/);
  assert.ok(postgresBatch.indexOf("user-quota:") < postgresBatch.indexOf("resolvedResult"));
  assert.match(postgresBatch, /quota_policy\.effective_from_period <= request\.billing_period/);
  assert.match(postgresBatch, /entry\.entry_type = 'period_open_authorization'/);
  assert.match(postgresBatch, /policy_department_id/);
  assert.match(postgresBatch, /row\.policy_data\.assignedMonthlyQuota/);
  assert.match(postgresBatch, /checkpoint\.integrityBlockedAt/);
  assert.match(postgresBatch, /data->>'blocksSettlement'/);
  assert.match(postgresBatch, /canReopenMonthlyOpenAfterAccessRevoke\(idempotent\)/);
  assert.match(postgresBatch, /reopenMonthlyOpenAfterAccessRevoke/);
  assert.match(postgresBatch, /operation_generation = \$4/);
  assert.match(postgresBatch, /completed_at = null/);
  assert.match(postgresBatch, /pg_try_advisory_xact_lock\(hashtext\(\$1\)::bigint\)/);
  assert.match(
    postgresBatch,
    /state not in \('completed', 'compensated', 'cancelled'\)/,
  );
  assert.match(postgresBatch, /reservedDepartmentQuota: input\.departmentId[\s\S]*?\? input\.assignedMonthlyQuota[\s\S]*?: 0/);
  assert.match(postgresBatch, /state: input\.departmentId \? "budget_reserved" : "planned"/);
  assert.match(sagaBatch, /departmentId\?: string/);

  for (const index of [
    "token_accounts_user_status_idx",
    "admin_scopes_user_status_idx",
    "department_quota_periods_period_idx",
    "user_quota_policies_effective_idx",
    "quota_ledger_entries_user_period_idx",
    "quota_operations_one_open_per_user",
  ]) {
    assert.match(baseline, new RegExp(index));
  }
});

test("unscoped global users plan and enqueue in stable user order without a fake department", async () => {
  const snapshot: PeriodOpenSnapshot = {
    candidates: [
      {
        feishuUserId: "user-z",
        assignedMonthlyQuota: 20,
        activeTokenCount: 0,
        isGlobalAdmin: true,
        alreadyOpened: false,
      },
      {
        feishuUserId: "user-a",
        assignedMonthlyQuota: 10,
        activeTokenCount: 1,
        isGlobalAdmin: true,
        alreadyOpened: false,
      },
    ],
    departmentQuotaPeriods: [],
    quotaOperations: [],
    settings: { usageSyncPolicy: { intervalMinutes: 5, settlementLagMinutes: 1 } },
    usageSyncCheckpoint: {
      settledThrough: "2099-01-31T00:00:00.000Z",
      lastRunStatus: "applied",
    },
  };
  const harness = await loadBillingHarness({ backend: "postgres", snapshot });
  const plan = await harness.api.buildMonthlyPeriodOpenPlan({ period: "2099-01" });

  assert.equal(plan.blocked, false);
  assert.equal(plan.blockers.some((blocker) => blocker.type === "missing_department"), false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(plan.unscoped.users.map((user) => user.feishuUserId))),
    ["user-a", "user-z"],
  );
  assert.equal(harness.postgresReads, 1);
  assert.equal(harness.jsonReads, 0);

  await harness.api.enqueueMonthlyPeriodOpenPlan({
    plan,
    createdByOpenId: "open-root",
    limit: 1,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(harness.enqueued[0])), [
    {
      feishuUserId: "user-a",
      period: "2099-01",
      assignedMonthlyQuota: 10,
      createdByOpenId: "open-root",
    },
  ]);
});

test("period-open preflight exposes an integrity-blocked checkpoint as a hard blocker", async () => {
  const snapshot: PeriodOpenSnapshot = {
    candidates: [
      {
        feishuUserId: "root-integrity-blocked",
        assignedMonthlyQuota: 10,
        activeTokenCount: 1,
        isGlobalAdmin: true,
        alreadyOpened: false,
      },
    ],
    departmentQuotaPeriods: [],
    quotaOperations: [],
    settings: { usageSyncPolicy: { intervalMinutes: 5, settlementLagMinutes: 1 } },
    usageSyncCheckpoint: {
      settledThrough: "2099-01-31T00:00:00.000Z",
      integrityBlockedAt: "2099-01-30T23:59:59.000Z",
      lastRunStatus: "applied",
    },
  };
  const harness = await loadBillingHarness({ backend: "postgres", snapshot });
  const plan = await harness.api.buildMonthlyPeriodOpenPlan({ period: "2099-01" });

  assert.equal(plan.blocked, true);
  assert.equal(
    plan.blockers.some((blocker) => blocker.type === "usage_integrity_blocked"),
    true,
  );
  await assert.rejects(
    harness.api.enqueueMonthlyPeriodOpenPlan({
      plan,
      createdByOpenId: "open-root",
    }),
    /preflight 存在阻塞项/,
  );
  assert.equal(harness.enqueued.length, 0);
});

test("period-open accepts a fresh continuation watermark but blocks failed settlement runs", async () => {
  const baseSnapshot: PeriodOpenSnapshot = {
    candidates: [
      {
        feishuUserId: "root-continuation",
        assignedMonthlyQuota: 10,
        activeTokenCount: 1,
        isGlobalAdmin: true,
        alreadyOpened: false,
      },
    ],
    departmentQuotaPeriods: [],
    quotaOperations: [],
    settings: { usageSyncPolicy: { intervalMinutes: 5, settlementLagMinutes: 1 } },
    usageSyncCheckpoint: {
      settledThrough: "2099-01-31T00:00:00.000Z",
      lastRunStatus: "continuation_pending",
    },
  };
  const continuationHarness = await loadBillingHarness({
    backend: "postgres",
    snapshot: baseSnapshot,
  });
  const continuationPlan = await continuationHarness.api.buildMonthlyPeriodOpenPlan({
    period: "2099-01",
  });
  assert.equal(continuationPlan.blocked, false);
  assert.equal(
    continuationPlan.blockers.some((blocker) => blocker.type === "usage_unsettled"),
    false,
  );

  const failedHarness = await loadBillingHarness({
    backend: "postgres",
    snapshot: {
      ...baseSnapshot,
      usageSyncCheckpoint: {
        ...baseSnapshot.usageSyncCheckpoint,
        lastRunStatus: "partial_failed",
      },
    },
  });
  const failedPlan = await failedHarness.api.buildMonthlyPeriodOpenPlan({
    period: "2099-01",
  });
  assert.equal(failedPlan.blocked, true);
  assert.equal(
    failedPlan.blockers.some((blocker) => blocker.type === "usage_unsettled"),
    true,
  );
});

test("period-open limit never splits a department batch", async () => {
  const snapshot: PeriodOpenSnapshot = {
    candidates: [
      {
        feishuUserId: "department-user-a",
        departmentId: "department-a",
        assignedMonthlyQuota: 10,
        activeTokenCount: 1,
        isGlobalAdmin: false,
        alreadyOpened: false,
      },
      {
        feishuUserId: "department-user-b",
        departmentId: "department-a",
        assignedMonthlyQuota: 10,
        activeTokenCount: 1,
        isGlobalAdmin: false,
        alreadyOpened: false,
      },
    ],
    departmentQuotaPeriods: [
      { departmentId: "department-a", period: "2099-01", quotaLimit: 20 },
    ],
    quotaOperations: [],
    settings: { usageSyncPolicy: { intervalMinutes: 5, settlementLagMinutes: 1 } },
    usageSyncCheckpoint: {
      settledThrough: "2099-01-31T00:00:00.000Z",
      lastRunStatus: "applied",
    },
  };
  const harness = await loadBillingHarness({ backend: "postgres", snapshot });
  const plan = await harness.api.buildMonthlyPeriodOpenPlan({ period: "2099-01" });
  assert.equal(plan.blocked, false);
  await assert.rejects(
    harness.api.enqueueMonthlyPeriodOpenPlan({
      plan,
      createdByOpenId: "open-root",
      limit: 1,
    }),
    /会拆分部门 department-a/,
  );
  assert.equal(harness.enqueued.length, 0);
});

type PostgresPeriodOpenApi = {
  getPostgresMonthlyPeriodOpenSnapshot(period: string): Promise<PeriodOpenSnapshot>;
  createPostgresMonthlyOpenOperations(
    inputs: Array<{
      feishuUserId: string;
      departmentId?: string;
      billingPeriod: string;
      assignedMonthlyQuota: number;
      createdByOpenId?: string;
    }>,
  ): Promise<Array<{ id: string }>>;
  postgresPoolRuntimeSnapshot(): {
    business: { total: number };
    control: { total: number };
  };
};

async function loadPostgresPeriodOpenHarness(input: {
  databaseUrl: string;
  rootOpenId: string;
  idSuffix: string;
}) {
  const source = await readFile(postgresStorePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: "postgres-store.ts",
  }).outputText;
  let nextId = 0;
  class TestError extends Error {}
  const sharedGlobal: Record<string, unknown> = {};
  const module = { exports: {} as PostgresPeriodOpenApi };
  const imports: Record<string, Record<string, unknown>> = {
    pg: { Pool },
    "@/lib/admin-scope": {
      resolveSessionAdminScopeProjection: () => null,
    },
    "@/lib/config": {
      getConfig: () => ({
        databaseUrl: input.databaseUrl,
        postgres: {
          poolMax: 1,
          settlementPoolMax: 1,
          controlPoolMax: 2,
          lockPoolMax: 1,
          poolIdleTimeoutMs: 30_000,
          poolConnectionTimeoutMs: 1_000,
        },
        newapi: { quotaPerUnit: 1 },
        admin: { systemAdminOpenIds: [input.rootOpenId] },
      }),
    },
    "@/lib/crypto": {
      nowIso: () => "2099-01-01T00:00:00.000Z",
      randomId: (prefix: string) => `${prefix}-${input.idSuffix}-${++nextId}`,
    },
    "@/lib/department-quota": {
      initialDepartmentQuotaLimit,
      validateDepartmentQuotaLimit,
    },
    "@/lib/department-member-sync-sql": {
      lockDepartmentMemberSyncUsersSql,
      upsertDepartmentMembersSql,
    },
    "@/lib/greenfield-installation": {
      verifyGreenfieldInstallationBinding,
    },
    "@/lib/billing-operation-state": {
      isTerminalBillingOperationStatus: () => false,
    },
    "@/lib/quota-execution-fence": {
      assertQuotaExecutionFenceHeld: () => undefined,
      createQuotaExecutionFence: (key: string) => ({
        key,
        lost: false,
        markLost() {},
        assertHeld() {},
      }),
      runWithQuotaExecutionFence: async (
        _fence: unknown,
        fn: () => Promise<unknown>,
      ) => fn(),
    },
    "@/lib/newapi-usage-identity": {
      hasConflictingProxyMatch: () => false,
      newApiUsageIdentityLockKeys: () => [],
      sameNewApiUsageSource: () => false,
    },
    "@/lib/quota-model": {
      initialUnassignedMonthlyQuota: () => 0,
      isSettlementWatermarkFresh: () => true,
      materializeDepartmentQuota: () => ({}),
      materializeUserQuota: () => ({}),
      resolveUsageBillingPeriod: () => "2099-01",
    },
    "@/lib/package-reset": {
      assertPackageResetExecutionAllowed,
      normalizePackageResetPolicy,
      PACKAGE_RESET_SYSTEM_ACTOR,
    },
    "@/lib/quota-saga-state": {
      assertQuotaOperationTransition: () => undefined,
      canReopenMonthlyOpenAfterAccessRevoke,
      reopenMonthlyOpenAfterAccessRevoke,
    },
    "@/lib/quota-admission": {
      assertQuotaAdmission: () => undefined,
      QuotaAdmissionClosedError: TestError,
      QuotaOperationBusyError: TestError,
      StaleTokenGenerationError: TestError,
    },
    "@/lib/usage-matching": {
      findProxyLogForNewApiUsage: () => null,
      isBillableProxyLog: () => false,
      isNewApiUsageMatchEligibleProxyLog: () => false,
    },
    "@/lib/user-access-recovery-sql": {
      listStaleUserAccessResumeCandidatesSql,
      markUserAccessResumeEnableAttemptSql,
      rollbackPendingUserAccessResumeSql,
    },
    "@/lib/user-access-state": {
      preserveUserAccessRevocationBarrier,
    },
  };
  runInNewContext(transpiled, {
    module,
    exports: module.exports,
    require: (specifier: string) => {
      const dependency = imports[specifier];
      if (!dependency) throw new Error(`unexpected postgres-store import: ${specifier}`);
      return dependency;
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    globalThis: sharedGlobal,
  });
  return {
    api: module.exports,
    async close() {
      const registry = sharedGlobal.__tokenInsidePostgresPoolRegistry as
        | {
            business?: Pool;
            settlement?: Pool;
            control?: Pool;
            advisoryLock?: Pool;
          }
        | undefined;
      await Promise.allSettled(
        [
          registry?.business,
          registry?.settlement,
          registry?.control,
          registry?.advisoryLock,
        ]
          .filter((pool): pool is Pool => Boolean(pool))
          .map((pool) => pool.end()),
      );
    },
  };
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "real PostgreSQL period-open plan progresses on control pool and creates an unscoped operation under the user lock",
  { skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(testDatabaseUrl);
    const suffix = `${process.pid}_${Date.now()}`;
    const schema = `test_period_open_${suffix}`;
    const period = "2099-01";
    const rootUserId = `period-open-root-${suffix}`;
    const rootOpenId = `period-open-root-open-${suffix}`;
    const blockedUserId = `period-open-blocked-${suffix}`;
    const adminPool = new Pool({ connectionString: testDatabaseUrl, max: 2 });
    const schemaUrl = new URL(testDatabaseUrl);
    schemaUrl.searchParams.set("options", `-csearch_path=${schema},public`);
    let fixturePool: Pool | undefined;
    let blocker: PoolClient | undefined;
    let postgresHarness:
      | Awaited<ReturnType<typeof loadPostgresPeriodOpenHarness>>
      | undefined;
    let blockedBatch: Promise<Array<{ id: string }>> | undefined;
    let rootBatch: Promise<unknown> | undefined;
    try {
      await adminPool.query(`create schema "${schema}"`);
      for (const table of [
        "app_settings",
        "feishu_users",
        "token_accounts",
        "department_quota_periods",
        "user_quota_policies",
        "quota_operations",
        "quota_ledger_entries",
        "user_quota_states",
        "usage_sync_checkpoints",
        "usage_sync_issues",
        "admin_scopes",
      ]) {
        await adminPool.query(
          `create table "${schema}"."${table}" (like public."${table}" including all)`,
        );
      }
      fixturePool = new Pool({ connectionString: schemaUrl.toString(), max: 3 });
      const now = "2099-01-01T00:00:00.000Z";
      const user = {
        id: rootUserId,
        tenantKey: `tenant-${suffix}`,
        openId: rootOpenId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      await fixturePool.query(
        `insert into feishu_users
          (id, tenant_key, open_id, department_id, data, created_at, updated_at)
         values ($1, $2, $3, null, $4, $5, $5)`,
        [user.id, user.tenantKey, user.openId, user, now],
      );
      const blockedUser = {
        id: blockedUserId,
        tenantKey: `tenant-${suffix}`,
        openId: `period-open-blocked-open-${suffix}`,
        departmentId: `period-open-department-${suffix}`,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      await fixturePool.query(
        `insert into feishu_users
          (id, tenant_key, open_id, department_id, data, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $6)`,
        [
          blockedUser.id,
          blockedUser.tenantKey,
          blockedUser.openId,
          blockedUser.departmentId,
          blockedUser,
          now,
        ],
      );
      const policy = {
        id: `policy-${suffix}`,
        feishuUserId: rootUserId,
        assignedMonthlyQuota: 42,
        effectiveFromPeriod: period,
        sourceType: "first_apply",
        sourceId: `source-${suffix}`,
        version: 1,
        quotaPerUnitSnapshot: 1,
        createdAt: now,
        updatedAt: now,
      };
      await fixturePool.query(
        `insert into user_quota_policies
          (id, feishu_user_id, department_id, effective_from_period,
           effective_to_period, version, source_type, source_id, data,
           created_at, updated_at)
         values ($1, $2, null, $3, null, 1, 'first_apply', $4, $5, $6, $6)`,
        [policy.id, rootUserId, period, policy.sourceId, policy, now],
      );
      const blockedPolicy = {
        id: `policy-blocked-${suffix}`,
        feishuUserId: blockedUserId,
        departmentId: blockedUser.departmentId,
        assignedMonthlyQuota: 7,
        effectiveFromPeriod: period,
        sourceType: "first_apply",
        sourceId: `source-blocked-${suffix}`,
        version: 1,
        quotaPerUnitSnapshot: 1,
        createdAt: now,
        updatedAt: now,
      };
      await fixturePool.query(
        `insert into user_quota_policies
          (id, feishu_user_id, department_id, effective_from_period,
           effective_to_period, version, source_type, source_id, data,
           created_at, updated_at)
         values ($1, $2, $3, $4, null, 1, 'first_apply', $5, $6, $7, $7)`,
        [
          blockedPolicy.id,
          blockedUserId,
          blockedUser.departmentId,
          period,
          blockedPolicy.sourceId,
          blockedPolicy,
          now,
        ],
      );
      const departmentPeriod = {
        id: `department-period-${suffix}`,
        departmentId: blockedUser.departmentId,
        period,
        quotaLimit: 100,
        defaultGrantQuota: 7,
        createdAt: now,
        updatedAt: now,
      };
      await fixturePool.query(
        `insert into department_quota_periods
          (id, department_id, period, data, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $5)`,
        [
          departmentPeriod.id,
          blockedUser.departmentId,
          period,
          departmentPeriod,
          now,
        ],
      );
      await fixturePool.query(
        `insert into app_settings (id, data)
         values ('default', $1)`,
        [
          {
            defaultMonthlyQuota: 200,
            usageSyncPolicy: { intervalMinutes: 5, settlementLagMinutes: 1 },
          },
        ],
      );
      await fixturePool.query(
        `insert into usage_sync_checkpoints (id, scope, data, updated_at)
         values ($1, 'newapi_usage_logs', $2, $3)`,
        [
          `checkpoint-${suffix}`,
          {
            settledThrough: "2099-01-31T00:00:00.000Z",
            lastRunStatus: "continuation_pending",
          },
          now,
        ],
      );

      // Durable access-revoke sequence: the original monthly-open operation
      // was cancelled before any upstream write, then the user was enabled
      // again. Rerunning the same period must reopen this exact idempotency row
      // instead of returning the terminal cancellation forever.
      const cancelledMonthlyOpen = {
        id: `monthly-open-cancelled-${suffix}`,
        operationType: "monthly_open",
        idempotencyKey: `monthly-open:${period}:${rootUserId}`,
        feishuUserId: rootUserId,
        billingPeriod: period,
        requestedAssignedQuota: 42,
        assignedQuotaBefore: 30,
        observedRemainBefore: 20,
        targetRemainQuota: 40,
        reservedDepartmentQuota: 0,
        operationGeneration: 1,
        state: "cancelled",
        attemptCount: 2,
        upstreamTokenIdBefore: `upstream-before-${suffix}`,
        tokenAccountIdBefore: `account-before-${suffix}`,
        evidence: {
          cancelledFromState: "snapshot_stable",
          userAccessRevokedAt: now,
          userAccessStatus: "disabled",
          consumptionBarrierStatus: "satisfied",
          consumptionBarrierCutoffAt: "2099-01-01T00:00:30.000Z",
          ledgerDelta: 42,
        },
        credentialCiphertext: "revoked-ciphertext",
        lastErrorCode: "user_access_revoked",
        lastErrorMessage: "disabled",
        createdByOpenId: rootOpenId,
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      };
      await fixturePool.query(
        `update feishu_users
         set data = $2, updated_at = $3
         where id = $1`,
        [rootUserId, { ...user, status: "disabled" }, now],
      );
      await fixturePool.query(
        `insert into quota_operations
          (id, operation_type, idempotency_key, feishu_user_id, department_id,
           billing_period, state, operation_generation, next_retry_at,
           worker_lease_id, worker_lease_expires_at, data,
           created_at, updated_at, completed_at)
         values ($1, 'monthly_open', $2, $3, null, $4, 'cancelled', 1,
                 null, null, null, $5, $6, $6, $6)`,
        [
          cancelledMonthlyOpen.id,
          cancelledMonthlyOpen.idempotencyKey,
          rootUserId,
          period,
          cancelledMonthlyOpen,
          now,
        ],
      );
      const quotaState = {
        feishuUserId: rootUserId,
        admission: "open",
        activeGeneration: 4,
        updatedAt: now,
      };
      await fixturePool.query(
        `insert into user_quota_states
          (feishu_user_id, admission, active_generation, operation_id, data, updated_at)
         values ($1, 'open', 4, null, $2, $3)`,
        [rootUserId, quotaState, now],
      );
      await fixturePool.query(
        `update feishu_users
         set data = $2, updated_at = $3
         where id = $1`,
        [rootUserId, { ...user, status: "active" }, now],
      );

      postgresHarness = await loadPostgresPeriodOpenHarness({
        databaseUrl: schemaUrl.toString(),
        rootOpenId,
        idSuffix: suffix,
      });
      const blockerClient = await fixturePool.connect();
      blocker = blockerClient;
      await blockerClient.query("begin");
      await blockerClient.query("select pg_advisory_xact_lock(hashtext($1))", [
        `user-quota:${blockedUserId}`,
      ]);
      let blockedBatchSettled = false;
      blockedBatch = postgresHarness.api
        .createPostgresMonthlyOpenOperations([
          {
            feishuUserId: blockedUserId,
            departmentId: "stale-plan-department",
            billingPeriod: period,
            assignedMonthlyQuota: 1,
            createdByOpenId: rootOpenId,
          },
        ])
        .finally(() => {
          blockedBatchSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(blockedBatchSettled, false);
      assert.equal(postgresHarness.api.postgresPoolRuntimeSnapshot().business.total, 0);
      assert.equal(postgresHarness.api.postgresPoolRuntimeSnapshot().control.total, 1);

      const snapshot = await Promise.race([
        postgresHarness.api.getPostgresMonthlyPeriodOpenSnapshot(period),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("period-open control snapshot was starved by control write")),
            1_000,
          ),
        ),
      ]);
      assert.equal(postgresHarness.api.postgresPoolRuntimeSnapshot().control.total, 2);
      assert.deepEqual(JSON.parse(JSON.stringify(snapshot.candidates)), [
        {
          feishuUserId: blockedUserId,
          departmentId: blockedUser.departmentId,
          assignedMonthlyQuota: 7,
          activeTokenCount: 0,
          isGlobalAdmin: false,
          alreadyOpened: false,
        },
        {
          feishuUserId: rootUserId,
          assignedMonthlyQuota: 42,
          activeTokenCount: 0,
          isGlobalAdmin: true,
          alreadyOpened: false,
        },
      ]);
      assert.equal(snapshot.quotaOperations.length, 0);

      const billingHarness = await loadBillingHarness({
        backend: "postgres",
        snapshot,
        enqueue: (items) =>
          postgresHarness!.api.createPostgresMonthlyOpenOperations(
            items.map((item) => ({
              feishuUserId: item.feishuUserId,
              departmentId: "stale-plan-department",
              billingPeriod: item.period,
              assignedMonthlyQuota: 1,
              createdByOpenId: item.createdByOpenId,
            })),
          ),
      });
      const plan = await billingHarness.api.buildMonthlyPeriodOpenPlan({ period });
      assert.equal(plan.blocked, false);
      assert.deepEqual(
        JSON.parse(
          JSON.stringify(
            plan.departments.flatMap((department) =>
              department.users.map((item) => item.feishuUserId),
            ),
          ),
        ),
        [blockedUserId],
      );
      assert.deepEqual(
        JSON.parse(JSON.stringify(plan.unscoped.users.map((item) => item.feishuUserId))),
        [rootUserId],
      );

      const marker = {
        id: `period-open-marker-${suffix}`,
        operationId: `first-provision-completed-${suffix}`,
        feishuUserId: blockedUserId,
        departmentId: blockedUser.departmentId,
        period,
        signedQuota: 7,
        entryType: "period_open_authorization",
        quotaPerUnitSnapshot: 1,
        sourceType: "quota_operation",
        sourceId: `first-provision-completed-${suffix}`,
        createdAt: now,
      };
      await blockerClient.query(
        `insert into quota_ledger_entries
          (id, operation_id, feishu_user_id, department_id, period,
           entry_type, signed_quota, data, created_at)
         values ($1, $2, $3, $4, $5, 'period_open_authorization', 7, $6, $7)`,
        [
          marker.id,
          marker.operationId,
          blockedUserId,
          blockedUser.departmentId,
          period,
          marker,
          now,
        ],
      );
      await blockerClient.query("commit");
      assert.deepEqual(JSON.parse(JSON.stringify(await blockedBatch)), []);
      blockedBatch = undefined;

      await fixturePool.query(
        `update usage_sync_checkpoints
         set data = jsonb_set(data, '{lastRunStatus}', '"partial_failed"'::jsonb)
         where scope = 'newapi_usage_logs'`,
      );
      await assert.rejects(
        billingHarness.api.enqueueMonthlyPeriodOpenPlan({
          plan,
          createdByOpenId: rootOpenId,
        }),
        /结算状态不安全/,
      );
      await fixturePool.query(
        `update usage_sync_checkpoints
         set data = jsonb_set(data, '{lastRunStatus}', '"continuation_pending"'::jsonb)
         where scope = 'newapi_usage_logs'`,
      );

      await fixturePool.query(
        `update usage_sync_checkpoints
         set data = data || $1::jsonb
         where scope = 'newapi_usage_logs'`,
        [{ integrityBlockedAt: "2099-01-01T00:00:01.000Z" }],
      );
      await assert.rejects(
        billingHarness.api.enqueueMonthlyPeriodOpenPlan({
          plan,
          createdByOpenId: rootOpenId,
        }),
        /结算状态不安全/,
      );
      const operationCountAfterIntegrityBlock = await fixturePool.query<{
        count: string;
      }>(
        `select count(*)::text as count
         from quota_operations
         where state <> 'cancelled'`,
      );
      assert.equal(operationCountAfterIntegrityBlock.rows[0]?.count, "0");
      await fixturePool.query(
        `update usage_sync_checkpoints
         set data = data - 'integrityBlockedAt' - 'integrityBlockedIssueId'
         where scope = 'newapi_usage_logs'`,
      );

      await blockerClient.query("begin");
      await blockerClient.query("select pg_advisory_xact_lock(hashtext($1))", [
        `user-quota:${rootUserId}`,
      ]);
      let rootBatchSettled = false;
      rootBatch = billingHarness.api
        .enqueueMonthlyPeriodOpenPlan({ plan, createdByOpenId: rootOpenId })
        .finally(() => {
          rootBatchSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(rootBatchSettled, false, "unscoped users must still take the user lock");
      const updatedPolicy = {
        ...policy,
        id: `policy-updated-${suffix}`,
        assignedMonthlyQuota: 84,
        sourceType: "quota_adjust",
        sourceId: `source-updated-${suffix}`,
        version: 2,
      };
      await blockerClient.query(
        `insert into user_quota_policies
          (id, feishu_user_id, department_id, effective_from_period,
           effective_to_period, version, source_type, source_id, data,
           created_at, updated_at)
         values ($1, $2, null, $3, null, 2, 'quota_adjust', $4, $5, $6, $6)`,
        [
          updatedPolicy.id,
          rootUserId,
          period,
          updatedPolicy.sourceId,
          updatedPolicy,
          now,
        ],
      );
      await blockerClient.query("commit");
      const operations = (await rootBatch) as Array<{ id: string }>;
      rootBatch = undefined;
      assert.equal(operations.length, 1);

      const stored = await fixturePool.query<{
        department_id: string | null;
        state: string;
        operation_generation: number;
        completed_at: Date | null;
        worker_lease_id: string | null;
        data: {
          departmentId?: string;
          reservedDepartmentQuota: number;
          requestedAssignedQuota: number;
          operationGeneration: number;
          state: string;
          completedAt?: string;
          lastErrorCode?: string;
          upstreamTokenIdBefore?: string;
          tokenAccountIdBefore?: string;
          credentialCiphertext?: string;
          evidence?: Record<string, string | number | boolean | undefined>;
        };
      }>(
        `select department_id, state, operation_generation, completed_at,
                worker_lease_id, data
         from quota_operations
         where id = $1`,
        [operations[0].id],
      );
      assert.equal(stored.rows[0]?.department_id, null);
      assert.equal(stored.rows[0]?.state, "planned");
      assert.equal(stored.rows[0]?.data.departmentId, undefined);
      assert.equal(stored.rows[0]?.data.reservedDepartmentQuota, 0);
      assert.equal(stored.rows[0]?.data.requestedAssignedQuota, 84);
      assert.equal(stored.rows[0]?.operation_generation, 5);
      assert.equal(stored.rows[0]?.data.operationGeneration, 5);
      assert.equal(stored.rows[0]?.data.state, "planned");
      assert.equal(stored.rows[0]?.completed_at, null);
      assert.equal(stored.rows[0]?.worker_lease_id, null);
      assert.equal(stored.rows[0]?.data.completedAt, undefined);
      assert.equal(stored.rows[0]?.data.lastErrorCode, undefined);
      assert.equal(stored.rows[0]?.data.upstreamTokenIdBefore, undefined);
      assert.equal(stored.rows[0]?.data.tokenAccountIdBefore, undefined);
      assert.equal(stored.rows[0]?.data.credentialCiphertext, undefined);
      assert.equal(
        stored.rows[0]?.data.evidence?.accessRevokeReopenedAt,
        "2099-01-01T00:00:00.000Z",
      );
      assert.equal(stored.rows[0]?.data.evidence?.accessRevokeReopenCount, 1);
      assert.equal(
        stored.rows[0]?.data.evidence?.reopenedCancelledFromState,
        "snapshot_stable",
      );
      assert.equal(
        stored.rows[0]?.data.evidence?.consumptionBarrierStatus,
        undefined,
      );
      assert.equal(operations[0].id, cancelledMonthlyOpen.id);
      const idempotent = await postgresHarness.api.createPostgresMonthlyOpenOperations([
        {
          feishuUserId: rootUserId,
          departmentId: "another-stale-department",
          billingPeriod: period,
          assignedMonthlyQuota: 999,
          createdByOpenId: rootOpenId,
        },
      ]);
      assert.deepEqual(
        JSON.parse(JSON.stringify(idempotent.map((item) => item.id))),
        [operations[0].id],
      );
    } finally {
      await blocker?.query("rollback").catch(() => undefined);
      blocker?.release();
      await Promise.allSettled(
        [blockedBatch, rootBatch].filter(
          (promise): promise is Promise<unknown> => Boolean(promise),
        ),
      );
      await postgresHarness?.close();
      await fixturePool?.end();
      await adminPool
        .query(`drop schema if exists "${schema}" cascade`)
        .catch(() => undefined);
      await adminPool.end();
    }
  },
);
