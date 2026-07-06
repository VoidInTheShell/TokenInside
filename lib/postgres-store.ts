import { Pool, type PoolClient } from "pg";
import { getConfig } from "@/lib/config";
import type {
  AdminScope,
  FeishuEvent,
  FeishuUser,
  ProxyRequestLog,
  StoreShape,
  TokenAccount,
  TokenRequest,
  UserBillingPeriod,
} from "@/lib/types";

let pool: Pool | undefined;

export const REQUIRED_POSTGRES_TABLES = [
  "app_settings",
  "feishu_users",
  "token_requests",
  "token_accounts",
  "user_billing_periods",
  "feishu_events",
  "proxy_request_logs",
  "admin_scopes",
] as const;

function getPool() {
  if (pool) return pool;
  const config = getConfig();
  const databaseUrl = config.databaseUrl;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required when TOKENINSIDE_STORE_BACKEND=postgres");
  }
  pool = new Pool({
    connectionString: databaseUrl,
    max: config.postgres.poolMax,
    idleTimeoutMillis: config.postgres.poolIdleTimeoutMs,
    connectionTimeoutMillis: config.postgres.poolConnectionTimeoutMs,
  });
  return pool;
}

async function readDataRows<T>(client: PoolClient, table: string, orderBy: string) {
  const result = await client.query<{ data: T }>(`select data from ${table} order by ${orderBy}`);
  return result.rows.map((row) => row.data);
}

async function insertJsonRows<T>(
  client: PoolClient,
  table: string,
  rows: T[],
  insert: (row: T) => { sql: string; values: unknown[] },
) {
  for (const row of rows) {
    const { sql, values } = insert(row);
    await client.query(sql, values);
  }
}

export async function checkPostgresConnection() {
  const client = await getPool().connect();
  try {
    await client.query("select 1");
    return true;
  } finally {
    client.release();
  }
}

export async function checkPostgresSchema() {
  const client = await getPool().connect();
  try {
    const result = await client.query<{ table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = 'public' and table_name = any($1::text[])`,
      [REQUIRED_POSTGRES_TABLES],
    );
    const existing = new Set(result.rows.map((row) => row.table_name));
    const missingTables = REQUIRED_POSTGRES_TABLES.filter((table) => !existing.has(table));
    return {
      ready: missingTables.length === 0,
      missingTables,
      tableCount: result.rows.length,
      error: undefined as string | undefined,
    };
  } finally {
    client.release();
  }
}

export async function readPostgresStore(): Promise<StoreShape> {
  const client = await getPool().connect();
  try {
    const settings = await client.query<{ data: StoreShape["settings"] }>(
      "select data from app_settings where id = 'default'",
    );
    return {
      version: 1,
      settings: settings.rows[0]?.data ?? { defaultMonthlyQuota: 200 },
      users: await readDataRows<FeishuUser>(client, "feishu_users", "created_at, id"),
      tokenRequests: await readDataRows<TokenRequest>(
        client,
        "token_requests",
        "created_at, id",
      ),
      tokenAccounts: await readDataRows<TokenAccount>(
        client,
        "token_accounts",
        "created_at, id",
      ),
      userBillingPeriods: await readDataRows<UserBillingPeriod>(
        client,
        "user_billing_periods",
        "period, id",
      ),
      feishuEvents: await readDataRows<FeishuEvent>(client, "feishu_events", "created_at, id"),
      proxyRequestLogs: await readDataRows<ProxyRequestLog>(
        client,
        "proxy_request_logs",
        "created_at, id",
      ),
      adminScopes: await readDataRows<AdminScope>(client, "admin_scopes", "created_at, id"),
    };
  } finally {
    client.release();
  }
}

export async function writePostgresStore(store: StoreShape) {
  const client = await getPool().connect();
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
      store.settings,
    ]);

    await insertJsonRows(client, "feishu_users", store.users, (user) => ({
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

    await insertJsonRows(client, "token_requests", store.tokenRequests, (request) => ({
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

    await insertJsonRows(client, "token_accounts", store.tokenAccounts, (account) => ({
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

    await insertJsonRows(
      client,
      "user_billing_periods",
      store.userBillingPeriods,
      (period) => ({
        sql: `insert into user_billing_periods
          (id, feishu_user_id, period, data, updated_at)
          values ($1, $2, $3, $4, $5)`,
        values: [period.id, period.feishuUserId, period.period, period, period.updatedAt],
      }),
    );

    await insertJsonRows(client, "feishu_events", store.feishuEvents, (event) => ({
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

    await insertJsonRows(client, "proxy_request_logs", store.proxyRequestLogs, (log) => ({
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

    await insertJsonRows(client, "admin_scopes", store.adminScopes, (scope) => ({
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
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
