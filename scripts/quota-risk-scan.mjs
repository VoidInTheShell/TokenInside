import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { buildLegacyQuotaRiskReport } from "../lib/quota-risk.ts";

const backend = (process.env.TOKENINSIDE_STORE_BACKEND ?? "json").trim().toLowerCase();

async function readPostgresSnapshot() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for the PostgreSQL risk scan");
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const [users, requests, accounts] = await Promise.all([
      pool.query("select data from feishu_users order by id"),
      pool.query("select data from token_requests order by id"),
      pool.query("select data from token_accounts order by id"),
    ]);
    return {
      version: 1,
      settings: { defaultMonthlyQuota: 200 },
      users: users.rows.map((row) => row.data),
      tokenRequests: requests.rows.map((row) => row.data),
      tokenAccounts: accounts.rows.map((row) => row.data),
      userBillingPeriods: [],
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
  } finally {
    await pool.end();
  }
}

async function readJsonSnapshot() {
  const storePath = resolve(
    process.cwd(),
    process.env.TOKENINSIDE_STORE_PATH ?? ".local-data/tokeninside.json",
  );
  return JSON.parse(await readFile(storePath, "utf8"));
}

try {
  const store = backend === "postgres" ? await readPostgresSnapshot() : await readJsonSnapshot();
  process.stdout.write(`${JSON.stringify(buildLegacyQuotaRiskReport(store), null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
