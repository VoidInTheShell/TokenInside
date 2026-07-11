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
  departmentQuotaPeriods: count("departmentQuotaPeriods"),
  departmentQuotaRequests: count("departmentQuotaRequests"),
  quotaChangeEvents: count("quotaChangeEvents"),
  userQuotaPolicies: count("userQuotaPolicies"),
  quotaOperations: count("quotaOperations"),
  quotaLedgerEntries: count("quotaLedgerEntries"),
  userQuotaStates: count("userQuotaStates"),
  quotaReconciliationRecords: count("quotaReconciliationRecords"),
  feishuEvents: count("feishuEvents"),
  proxyRequestLogs: count("proxyRequestLogs"),
  newapiUsageRecords: count("newapiUsageRecords"),
  usageSyncCheckpoints: count("usageSyncCheckpoints"),
  usageSyncIssues: count("usageSyncIssues"),
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
  await client.query("set local tokeninside.allow_ledger_rewrite = 'on'");
  await client.query("delete from app_settings");
  await client.query("delete from admin_scopes");
  await client.query("delete from usage_sync_issues");
  await client.query("delete from usage_sync_checkpoints");
  await client.query("delete from newapi_usage_records");
  await client.query("delete from proxy_request_logs");
  await client.query("delete from feishu_events");
  await client.query("delete from quota_change_events");
  await client.query("delete from quota_reconciliation_records");
  await client.query("delete from quota_ledger_entries");
  await client.query("delete from quota_operations");
  await client.query("delete from user_quota_states");
  await client.query("delete from user_quota_policies");
  await client.query("delete from department_quota_requests");
  await client.query("delete from department_quota_periods");
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
       status, billing_period, operation_generation, drain_started_at,
       settled_through, activated_at, data, created_at, disabled_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    values: [
      account.id,
      account.feishuUserId,
      account.tokenRequestId,
      account.newapiTokenId ?? null,
      account.keyHash,
      account.status,
      account.billingPeriod,
      account.operationGeneration ?? 0,
      account.drainStartedAt ?? null,
      account.settledThrough ?? null,
      account.activatedAt ?? null,
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

  await insertRows(client, store.departmentQuotaPeriods, (period) => ({
    sql: `insert into department_quota_periods
      (id, department_id, period, data, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6)`,
    values: [
      period.id,
      period.departmentId,
      period.period,
      period,
      period.createdAt,
      period.updatedAt,
    ],
  }));

  await insertRows(client, store.departmentQuotaRequests, (request) => ({
    sql: `insert into department_quota_requests
      (id, department_id, requester_feishu_user_id, period, status,
       approval_target_open_id, approval_action_nonce_hash, data, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    values: [
      request.id,
      request.departmentId,
      request.requesterFeishuUserId,
      request.period,
      request.status,
      request.approvalTargetOpenId,
      request.approvalActionNonceHash,
      request,
      request.createdAt,
      request.updatedAt,
    ],
  }));

  await insertRows(client, store.quotaChangeEvents, (event) => ({
    sql: `insert into quota_change_events
      (id, department_id, feishu_user_id, period, status,
       related_token_request_id, data, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    values: [
      event.id,
      event.departmentId,
      event.feishuUserId ?? null,
      event.period,
      event.status,
      event.relatedTokenRequestId ?? null,
      event,
      event.createdAt,
      event.updatedAt,
    ],
  }));

  await insertRows(client, store.userQuotaPolicies, (policy) => ({
    sql: `insert into user_quota_policies
      (id, feishu_user_id, department_id, effective_from_period, effective_to_period,
       version, data, created_at, updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    values: [policy.id, policy.feishuUserId, policy.departmentId ?? null,
      policy.effectiveFromPeriod, policy.effectiveToPeriod ?? null, policy.version,
      policy, policy.createdAt, policy.updatedAt],
  }));

  await insertRows(client, store.quotaOperations, (operation) => ({
    sql: `insert into quota_operations
      (id, operation_type, idempotency_key, feishu_user_id, department_id,
       billing_period, state, operation_generation, next_retry_at, data,
       created_at, updated_at, completed_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    values: [operation.id, operation.operationType, operation.idempotencyKey,
      operation.feishuUserId, operation.departmentId ?? null, operation.billingPeriod,
      operation.state, operation.operationGeneration, operation.nextRetryAt ?? null,
      operation, operation.createdAt, operation.updatedAt, operation.completedAt ?? null],
  }));

  await insertRows(client, store.quotaLedgerEntries, (entry) => ({
    sql: `insert into quota_ledger_entries
      (id, operation_id, feishu_user_id, department_id, period, entry_type,
       signed_quota, data, created_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    values: [entry.id, entry.operationId, entry.feishuUserId, entry.departmentId ?? null,
      entry.period, entry.entryType, entry.signedQuota, entry, entry.createdAt],
  }));

  await insertRows(client, store.userQuotaStates, (state) => ({
    sql: `insert into user_quota_states
      (feishu_user_id, admission, active_generation, operation_id, data, updated_at)
      values ($1,$2,$3,$4,$5,$6)`,
    values: [state.feishuUserId, state.admission, state.activeGeneration,
      state.operationId ?? null, state, state.updatedAt],
  }));

  await insertRows(client, store.quotaReconciliationRecords, (record) => ({
    sql: `insert into quota_reconciliation_records
      (id, feishu_user_id, token_account_id, period, status, operation_id,
       data, created_at, updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    values: [record.id, record.feishuUserId, record.tokenAccountId ?? null,
      record.period, record.status, record.operationId ?? null,
      record, record.createdAt, record.updatedAt],
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
       billing_period, operation_generation, lease_expires_at, heartbeat_at,
       data, created_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    values: [
      log.id,
      log.feishuUserId ?? null,
      log.tokenAccountId ?? null,
      log.requestPath,
      log.method,
      log.statusCode,
      log.billingPeriod ?? null,
      log.operationGeneration ?? 0,
      log.leaseExpiresAt ?? null,
      log.heartbeatAt ?? null,
      log,
      log.createdAt,
    ],
  }));

  await insertRows(client, store.newapiUsageRecords, (record) => ({
    sql: `insert into newapi_usage_records
      (id, newapi_log_id, newapi_request_id, newapi_token_id, token_account_id,
       feishu_user_id, match_status, data, newapi_created_at, first_seen_at, last_synced_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    values: [
      record.id,
      record.newapiLogId ?? null,
      record.newapiRequestId ?? null,
      record.newapiTokenId ?? null,
      record.tokenAccountId ?? null,
      record.feishuUserId ?? null,
      record.matchStatus,
      record,
      record.newapiCreatedAt ?? null,
      record.firstSeenAt,
      record.lastSyncedAt,
    ],
  }));

  await insertRows(client, store.usageSyncCheckpoints, (checkpoint) => ({
    sql: `insert into usage_sync_checkpoints
      (id, scope, data, updated_at)
      values ($1, $2, $3, $4)`,
    values: [checkpoint.id, checkpoint.scope, checkpoint, checkpoint.updatedAt],
  }));

  await insertRows(client, store.usageSyncIssues, (issue) => ({
    sql: `insert into usage_sync_issues
      (id, issue_type, status, newapi_log_id, newapi_request_id, newapi_token_id,
       data, first_seen_at, last_seen_at, last_synced_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    values: [
      issue.id,
      issue.issueType,
      issue.status,
      issue.newapiLogId ?? null,
      issue.newapiRequestId ?? null,
      issue.newapiTokenId ?? null,
      issue,
      issue.firstSeenAt,
      issue.lastSeenAt,
      issue.lastSyncedAt,
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
