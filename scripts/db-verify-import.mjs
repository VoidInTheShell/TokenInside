import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
const storePath =
  process.argv.find((arg) => !arg.startsWith("--") && arg !== process.argv[0] && arg !== process.argv[1]) ??
  process.env.TOKENINSIDE_STORE_PATH ??
  ".local-data/tokeninside.json";

if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const store = JSON.parse(await readFile(storePath, "utf8"));
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

const pairs = [
  ["users", "feishu_users"],
  ["tokenRequests", "token_requests"],
  ["tokenAccounts", "token_accounts"],
  ["userBillingPeriods", "user_billing_periods"],
  ["departmentQuotaPeriods", "department_quota_periods"],
  ["departmentQuotaRequests", "department_quota_requests"],
  ["quotaChangeEvents", "quota_change_events"],
  ["userQuotaPolicies", "user_quota_policies"],
  ["quotaOperations", "quota_operations"],
  ["quotaLedgerEntries", "quota_ledger_entries"],
  ["userQuotaStates", "user_quota_states"],
  ["quotaReconciliationRecords", "quota_reconciliation_records"],
  ["feishuEvents", "feishu_events"],
  ["proxyRequestLogs", "proxy_request_logs"],
  ["newapiUsageRecords", "newapi_usage_records"],
  ["usageSyncCheckpoints", "usage_sync_checkpoints"],
  ["usageSyncIssues", "usage_sync_issues"],
  ["adminScopes", "admin_scopes"],
];

function jsonCount(name) {
  return Array.isArray(store[name]) ? store[name].length : 0;
}

const client = await pool.connect();
try {
  const results = [];
  for (const [jsonName, tableName] of pairs) {
    const result = await client.query(`select count(*)::int as count from ${tableName}`);
    const json = jsonCount(jsonName);
    const postgres = result.rows[0]?.count ?? 0;
    results.push({
      name: jsonName,
      json,
      postgres,
      match: json === postgres,
    });
  }

  const ok = results.every((item) => item.match);
  console.log(JSON.stringify({ ok, counts: results }));
  if (!ok) process.exitCode = 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
