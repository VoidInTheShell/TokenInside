import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
const confirmReplace =
  process.argv.includes("--confirm-replace") ||
  process.env.TOKENINSIDE_CONFIRM_REPLACE_IMPORT === "true";
const dryRun = process.argv.includes("--dry-run");
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

async function insertRows(client, rows, build) {
  for (const row of rows ?? []) {
    const { sql, values } = build(row);
    await client.query(sql, values);
  }
}

function count(name) {
  return Array.isArray(store[name]) ? store[name].length : 0;
}

const summary = {
  users: count("users"),
  tokenRequests: count("tokenRequests"),
  tokenAccounts: count("tokenAccounts"),
  userBillingPeriods: count("userBillingPeriods"),
  feishuEvents: count("feishuEvents"),
  proxyRequestLogs: count("proxyRequestLogs"),
  adminScopes: count("adminScopes"),
};

if (dryRun) {
  console.log(JSON.stringify({ dryRun: true, wouldImport: summary }));
  process.exit(0);
}

if (!confirmReplace) {
  console.error(
    "Refusing to replace PostgreSQL tables. Re-run with --confirm-replace after backing up JSON and PostgreSQL.",
  );
  console.error(JSON.stringify({ wouldImport: summary }));
  process.exit(1);
}

const client = await pool.connect();
try {
  await client.query("begin");
  await client.query("delete from app_settings");
  await client.query("delete from admin_scopes");
  await client.query("delete from proxy_request_logs");
  await client.query("delete from feishu_events");
  await client.query("delete from user_billing_periods");
  await client.query("delete from token_accounts");
  await client.query("delete from token_requests");
  await client.query("delete from feishu_users");

  await client.query("insert into app_settings (id, data) values ('default', $1)", [
    store.settings ?? { defaultMonthlyQuota: 200 },
  ]);

  await insertRows(client, store.users, (user) => ({
    sql: `insert into feishu_users
      (id, tenant_key, open_id, department_id, data, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7)`,
    values: [
      user.id,
      user.tenantKey,
      user.openId,
      user.departmentId ?? null,
      user,
      user.createdAt,
      user.updatedAt,
    ],
  }));

  await insertRows(client, store.tokenRequests, (request) => ({
    sql: `insert into token_requests
      (id, feishu_user_id, request_type, status, approval_action_nonce_hash,
       approval_instance_code, approval_department_id, approval_target_open_id,
       data, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    values: [
      request.id,
      request.feishuUserId,
      request.requestType,
      request.status,
      request.approvalActionNonceHash ?? null,
      request.approvalInstanceCode ?? null,
      request.approvalDepartmentId ?? null,
      request.approvalTargetOpenId ?? null,
      request,
      request.createdAt,
      request.updatedAt,
    ],
  }));

  await insertRows(client, store.tokenAccounts, (account) => ({
    sql: `insert into token_accounts
      (id, feishu_user_id, token_request_id, newapi_token_id, key_hash,
       status, billing_period, data, created_at, disabled_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    values: [
      account.id,
      account.feishuUserId,
      account.tokenRequestId,
      account.newapiTokenId ?? null,
      account.keyHash,
      account.status,
      account.billingPeriod,
      account,
      account.createdAt,
      account.disabledAt ?? null,
    ],
  }));

  await insertRows(client, store.userBillingPeriods, (period) => ({
    sql: `insert into user_billing_periods
      (id, feishu_user_id, period, data, updated_at)
      values ($1, $2, $3, $4, $5)`,
    values: [period.id, period.feishuUserId, period.period, period, period.updatedAt],
  }));

  await insertRows(client, store.feishuEvents, (event) => ({
    sql: `insert into feishu_events
      (id, event_uuid, event_type, instance_code, card_request_id, card_action,
       operator_open_id, message_id, processing_status, data, created_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    values: [
      event.id,
      event.eventUuid,
      event.eventType ?? null,
      event.instanceCode ?? null,
      event.cardRequestId ?? null,
      event.cardAction ?? null,
      event.operatorOpenId ?? null,
      event.messageId ?? null,
      event.processingStatus,
      event,
      event.createdAt,
    ],
  }));

  await insertRows(client, store.proxyRequestLogs, (log) => ({
    sql: `insert into proxy_request_logs
      (id, feishu_user_id, token_account_id, request_path, method, status_code,
       data, created_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    values: [
      log.id,
      log.feishuUserId ?? null,
      log.tokenAccountId ?? null,
      log.requestPath,
      log.method,
      log.statusCode,
      log,
      log.createdAt,
    ],
  }));

  await insertRows(client, store.adminScopes, (scope) => ({
    sql: `insert into admin_scopes
      (id, feishu_user_id, scope_type, department_id, source, status,
       data, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    values: [
      scope.id,
      scope.feishuUserId,
      scope.scopeType,
      scope.departmentId ?? null,
      scope.source,
      scope.status,
      scope,
      scope.createdAt,
      scope.updatedAt,
    ],
  }));

  await client.query("commit");
  console.log(
    JSON.stringify({
      imported: summary,
    }),
  );
} catch (err) {
  await client.query("rollback");
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
