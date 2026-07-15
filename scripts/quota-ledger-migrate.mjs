import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { buildQuotaMigrationPlan } from "../lib/quota-migration.ts";

const backend = (process.env.TOKENINSIDE_STORE_BACKEND ?? "json").trim().toLowerCase();
const apply = process.argv.includes("--apply");
const confirmed = process.argv.includes("--confirm-apply");
const verbose = process.argv.includes("--verbose");
const periodArgument = process.argv.find((item) => /^--period=\d{4}-(0[1-9]|1[0-2])$/.test(item));
const period = periodArgument
  ? periodArgument.slice("--period=".length)
  : new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Hong_Kong",
      year: "numeric",
      month: "2-digit",
    }).format(new Date()).slice(0, 7);
const quotaPerUnit = Number(process.env.NEWAPI_QUOTA_PER_UNIT ?? "500000");
if (!Number.isInteger(quotaPerUnit) || quotaPerUnit <= 0) {
  throw new Error("NEWAPI_QUOTA_PER_UNIT must be a positive integer");
}
if (apply && !confirmed) {
  throw new Error("Refusing to apply quota migration without --confirm-apply");
}

const emptyArrays = {
  departmentQuotaPeriods: [],
  departmentQuotaRequests: [],
  quotaChangeEvents: [],
  userQuotaPolicies: [],
  quotaOperations: [],
  quotaLedgerEntries: [],
  userQuotaStates: [],
  quotaReconciliationRecords: [],
  feishuEvents: [],
  proxyRequestLogs: [],
  newapiUsageRecords: [],
  usageSyncCheckpoints: [],
  usageSyncIssues: [],
  adminScopes: [],
};

async function postgresSnapshot(pool) {
  const client = await pool.connect();
  try {
    const settings = await client.query("select data from app_settings where id = 'default'");
    const tableNames = [
      ["users", "feishu_users", "created_at, id"],
      ["tokenRequests", "token_requests", "created_at, id"],
      ["tokenAccounts", "token_accounts", "created_at, id"],
      ["userBillingPeriods", "user_billing_periods", "period, id"],
      ["departmentQuotaPeriods", "department_quota_periods", "period, id"],
      ["newapiUsageRecords", "newapi_usage_records", "last_synced_at, id"],
      ["userQuotaPolicies", "user_quota_policies", "feishu_user_id, version, id"],
      ["quotaOperations", "quota_operations", "created_at, id"],
      ["quotaLedgerEntries", "quota_ledger_entries", "created_at, id"],
    ];
    const snapshot = {
      version: 1,
      settings: settings.rows[0]?.data ?? { defaultMonthlyQuota: 200 },
      ...emptyArrays,
      users: [],
      tokenRequests: [],
      tokenAccounts: [],
      userBillingPeriods: [],
    };
    for (const [key, table, order] of tableNames) {
      const result = await client.query(`select data from ${table} order by ${order}`);
      snapshot[key] = result.rows.map((row) => row.data);
    }
    return snapshot;
  } finally {
    client.release();
  }
}

async function applyPostgres(pool, plan) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `quota-ledger-migration:${plan.period}`,
    ]);
    const settingsResult = await client.query(
      "select data from app_settings where id = 'default' for update",
    );
    const settings = settingsResult.rows[0]?.data ?? { defaultMonthlyQuota: 200 };
    if (
      settings.quotaMigration &&
      (settings.quotaMigration.period !== plan.period ||
        settings.quotaMigration.planHash !== plan.planHash)
    ) {
      throw new Error("A different quota migration is already registered");
    }
    for (const policy of plan.policies) {
      await client.query(
        `insert into user_quota_policies
          (id, feishu_user_id, department_id, effective_from_period, effective_to_period,
           version, data, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (id) do nothing`,
        [
          policy.id,
          policy.feishuUserId,
          policy.departmentId ?? null,
          policy.effectiveFromPeriod,
          policy.effectiveToPeriod ?? null,
          policy.version,
          policy,
          policy.createdAt,
          policy.updatedAt,
        ],
      );
      const verified = await client.query(
        "select data = $2::jsonb as same from user_quota_policies where id = $1",
        [policy.id, policy],
      );
      if (!verified.rows[0]?.same) {
        throw new Error(`Divergent migration policy already exists: ${policy.id}`);
      }
    }
    for (const operation of plan.operations) {
      await client.query(
        `insert into quota_operations
          (id, operation_type, idempotency_key, feishu_user_id, department_id,
           billing_period, state, operation_generation, next_retry_at, data,
           created_at, updated_at, completed_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         on conflict (idempotency_key) do nothing`,
        [
          operation.id,
          operation.operationType,
          operation.idempotencyKey,
          operation.feishuUserId,
          operation.departmentId ?? null,
          operation.billingPeriod,
          operation.state,
          operation.operationGeneration,
          operation.nextRetryAt ?? null,
          operation,
          operation.createdAt,
          operation.updatedAt,
          operation.completedAt ?? null,
        ],
      );
      const verified = await client.query(
        "select data = $2::jsonb as same from quota_operations where idempotency_key = $1",
        [operation.idempotencyKey, operation],
      );
      if (!verified.rows[0]?.same) {
        throw new Error(`Divergent migration operation already exists: ${operation.id}`);
      }
    }
    for (const entry of plan.ledgerEntries) {
      await client.query(
        `insert into quota_ledger_entries
          (id, operation_id, feishu_user_id, department_id, period, entry_type,
           signed_quota, data, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (operation_id, entry_type) do nothing`,
        [
          entry.id,
          entry.operationId,
          entry.feishuUserId,
          entry.departmentId ?? null,
          entry.period,
          entry.entryType,
          entry.signedQuota,
          entry,
          entry.createdAt,
        ],
      );
      const verified = await client.query(
        `select data = $3::jsonb as same from quota_ledger_entries
         where operation_id = $1 and entry_type = $2`,
        [entry.operationId, entry.entryType, entry],
      );
      if (!verified.rows[0]?.same) {
        throw new Error(`Divergent migration ledger entry already exists: ${entry.id}`);
      }
    }
    settings.quotaMigration = {
      period: plan.period,
      appliedAt: settings.quotaMigration?.appliedAt ?? new Date().toISOString(),
      planHash: plan.planHash,
      users: plan.users,
      estimatedUsers: plan.estimatedUsers,
    };
    await client.query(
      `insert into app_settings (id, data) values ('default', $1)
       on conflict (id) do update set data = excluded.data`,
      [settings],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function mergeJsonArtifacts(store, plan) {
  if (
    store.settings?.quotaMigration &&
    (store.settings.quotaMigration.period !== plan.period ||
      store.settings.quotaMigration.planHash !== plan.planHash)
  ) {
    throw new Error("A different quota migration is already registered");
  }
  const byId = (rows) => new Set(rows.map((item) => item.id));
  const policyIds = byId(store.userQuotaPolicies ?? []);
  const operationKeys = new Set((store.quotaOperations ?? []).map((item) => item.idempotencyKey));
  const ledgerKeys = new Set(
    (store.quotaLedgerEntries ?? []).map((item) => `${item.operationId}:${item.entryType}`),
  );
  const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  for (const policy of plan.policies) {
    const existing = (store.userQuotaPolicies ?? []).find((item) => item.id === policy.id);
    if (existing && !sameJson(existing, policy)) {
      throw new Error(`Divergent migration policy already exists: ${policy.id}`);
    }
  }
  for (const operation of plan.operations) {
    const existing = (store.quotaOperations ?? []).find(
      (item) => item.idempotencyKey === operation.idempotencyKey,
    );
    if (existing && !sameJson(existing, operation)) {
      throw new Error(`Divergent migration operation already exists: ${operation.id}`);
    }
  }
  for (const entry of plan.ledgerEntries) {
    const existing = (store.quotaLedgerEntries ?? []).find(
      (item) => item.operationId === entry.operationId && item.entryType === entry.entryType,
    );
    if (existing && !sameJson(existing, entry)) {
      throw new Error(`Divergent migration ledger entry already exists: ${entry.id}`);
    }
  }
  store.userQuotaPolicies = [
    ...(store.userQuotaPolicies ?? []),
    ...plan.policies.filter((item) => !policyIds.has(item.id)),
  ];
  store.quotaOperations = [
    ...(store.quotaOperations ?? []),
    ...plan.operations.filter((item) => !operationKeys.has(item.idempotencyKey)),
  ];
  store.quotaLedgerEntries = [
    ...(store.quotaLedgerEntries ?? []),
    ...plan.ledgerEntries.filter(
      (item) => !ledgerKeys.has(`${item.operationId}:${item.entryType}`),
    ),
  ];
  store.settings = store.settings ?? { defaultMonthlyQuota: 200 };
  store.settings.quotaMigration = {
    period: plan.period,
    appliedAt: store.settings.quotaMigration?.appliedAt ?? new Date().toISOString(),
    planHash: plan.planHash,
    users: plan.users,
    estimatedUsers: plan.estimatedUsers,
  };
  return store;
}

let pool;
let storePath;
let store;
try {
  if (backend === "postgres") {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    store = await postgresSnapshot(pool);
  } else {
    storePath = resolve(
      process.cwd(),
      process.env.TOKENINSIDE_STORE_PATH ?? ".local-data/tokeninside.json",
    );
    store = { ...emptyArrays, ...JSON.parse(await readFile(storePath, "utf8")) };
  }
  const plan = buildQuotaMigrationPlan(store, {
    period,
    quotaPerUnit,
    now: new Date().toISOString(),
  });
  if (apply) {
    if (backend === "postgres") {
      await applyPostgres(pool, plan);
    } else {
      const nextStore = mergeJsonArtifacts(store, plan);
      const tempPath = `${storePath}.${process.pid}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(nextStore, null, 2)}\n`, "utf8");
      await rename(tempPath, storePath);
    }
  }
  const output = {
    dryRun: !apply,
    backend,
    period: plan.period,
    planHash: plan.planHash,
    users: plan.users,
    estimatedUsers: plan.estimatedUsers,
    policies: plan.policies.length,
    operations: plan.operations.length,
    ledgerEntries: plan.ledgerEntries.length,
    warnings: plan.warnings,
    ...(verbose ? { plan } : {}),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} finally {
  await pool?.end();
}
