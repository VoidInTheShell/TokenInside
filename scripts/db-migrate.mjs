import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });

const statements = [
  `create table if not exists app_settings (
    id text primary key,
    data jsonb not null
  )`,
  `create table if not exists feishu_users (
    id text primary key,
    tenant_key text not null,
    open_id text not null,
    department_id text,
    data jsonb not null,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    unique (tenant_key, open_id)
  )`,
  `create table if not exists token_requests (
    id text primary key,
    feishu_user_id text not null,
    request_type text not null,
    status text not null,
    approval_action_nonce_hash text,
    approval_instance_code text,
    approval_department_id text,
    approval_target_open_id text,
    data jsonb not null,
    created_at timestamptz not null,
    updated_at timestamptz not null
  )`,
  `create unique index if not exists token_requests_approval_action_nonce_unique
    on token_requests (approval_action_nonce_hash)
    where approval_action_nonce_hash is not null`,
  `create index if not exists token_requests_target_status_idx
    on token_requests (approval_target_open_id, status)`,
  `create index if not exists token_requests_department_created_idx
    on token_requests (approval_department_id, created_at)`,
  `create index if not exists token_requests_instance_idx
    on token_requests (approval_instance_code)`,
  `create index if not exists token_requests_user_created_idx
    on token_requests (feishu_user_id, created_at)`,
  `update token_requests request
   set approval_department_id = user_row.department_id,
       data = jsonb_set(
         request.data,
         '{approvalDepartmentId}',
         to_jsonb(user_row.department_id),
         true
       )
   from feishu_users user_row
   where request.feishu_user_id = user_row.id
     and request.approval_department_id is null
     and user_row.department_id is not null`,
  `create table if not exists token_accounts (
    id text primary key,
    feishu_user_id text not null,
    token_request_id text not null,
    newapi_token_id text,
    key_hash text not null,
    status text not null,
    billing_period text not null,
    data jsonb not null,
    created_at timestamptz not null,
    disabled_at timestamptz,
    unique (key_hash)
  )`,
  `create index if not exists token_accounts_user_status_idx
    on token_accounts (feishu_user_id, status)`,
  `create unique index if not exists token_accounts_one_active_per_user
    on token_accounts (feishu_user_id)
    where status = 'active'`,
  `create table if not exists user_billing_periods (
    id text primary key,
    feishu_user_id text not null,
    period text not null,
    data jsonb not null,
    updated_at timestamptz not null,
    unique (feishu_user_id, period)
  )`,
  `create table if not exists department_quota_periods (
    id text primary key,
    department_id text not null,
    period text not null,
    data jsonb not null,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    unique (department_id, period)
  )`,
  `create index if not exists department_quota_periods_period_idx
    on department_quota_periods (period, department_id)`,
  `create table if not exists department_quota_requests (
    id text primary key,
    department_id text not null,
    requester_feishu_user_id text not null,
    period text not null,
    status text not null,
    approval_target_open_id text not null,
    approval_action_nonce_hash text not null,
    data jsonb not null,
    created_at timestamptz not null,
    updated_at timestamptz not null
  )`,
  `create unique index if not exists department_quota_requests_nonce_unique
    on department_quota_requests (approval_action_nonce_hash)`,
  `create index if not exists department_quota_requests_target_status_idx
    on department_quota_requests (approval_target_open_id, status)`,
  `create index if not exists department_quota_requests_department_created_idx
    on department_quota_requests (department_id, created_at)`,
  `create table if not exists quota_change_events (
    id text primary key,
    department_id text not null,
    feishu_user_id text,
    period text not null,
    status text not null,
    related_token_request_id text,
    data jsonb not null,
    created_at timestamptz not null,
    updated_at timestamptz not null
  )`,
  `create unique index if not exists quota_change_events_token_request_unique
    on quota_change_events (related_token_request_id)
    where related_token_request_id is not null`,
  `create index if not exists quota_change_events_department_period_status_idx
    on quota_change_events (department_id, period, status)`,
  `create table if not exists feishu_events (
    id text primary key,
    event_uuid text not null unique,
    event_type text,
    instance_code text,
    card_request_id text,
    card_action text,
    operator_open_id text,
    message_id text,
    processing_status text not null,
    data jsonb not null,
    created_at timestamptz not null
  )`,
  `create index if not exists feishu_events_card_idx
    on feishu_events (card_request_id, card_action, operator_open_id)`,
  `create index if not exists feishu_events_operator_created_idx
    on feishu_events (operator_open_id, created_at)`,
  `create index if not exists feishu_events_instance_status_idx
    on feishu_events (instance_code, processing_status)`,
  `create table if not exists proxy_request_logs (
    id text primary key,
    feishu_user_id text,
    token_account_id text,
    request_path text not null,
    method text not null,
    status_code integer not null,
    data jsonb not null,
    created_at timestamptz not null
  )`,
  `create index if not exists proxy_request_logs_user_created_idx
    on proxy_request_logs (feishu_user_id, created_at)`,
  `create index if not exists proxy_request_logs_token_created_idx
    on proxy_request_logs (token_account_id, created_at)`,
  `create index if not exists proxy_request_logs_status_created_idx
    on proxy_request_logs (status_code, created_at)`,
  `create table if not exists newapi_usage_records (
    id text primary key,
    newapi_log_id text,
    newapi_request_id text,
    newapi_token_id text,
    token_account_id text,
    feishu_user_id text,
    match_status text not null,
    data jsonb not null,
    newapi_created_at timestamptz,
    first_seen_at timestamptz not null,
    last_synced_at timestamptz not null
  )`,
  `drop index if exists newapi_usage_records_log_unique`,
  `drop index if exists newapi_usage_records_source_unique`,
  `with ranked as (
     select id,
            row_number() over (
              partition by newapi_token_id, newapi_request_id
              order by last_synced_at desc, first_seen_at asc, id asc
            ) as row_number
     from newapi_usage_records
     where newapi_token_id is not null
       and newapi_request_id is not null
   )
   delete from newapi_usage_records target
   using ranked
   where target.id = ranked.id
     and ranked.row_number > 1`,
  `with ranked as (
     select id,
            row_number() over (
              partition by newapi_token_id, newapi_log_id
              order by last_synced_at desc, first_seen_at asc, id asc
            ) as row_number
     from newapi_usage_records
     where newapi_token_id is not null
       and newapi_request_id is null
       and newapi_log_id is not null
   )
   delete from newapi_usage_records target
   using ranked
   where target.id = ranked.id
     and ranked.row_number > 1`,
  `create unique index if not exists newapi_usage_records_request_unique
    on newapi_usage_records (newapi_token_id, newapi_request_id)
    where newapi_token_id is not null
      and newapi_request_id is not null`,
  `create unique index if not exists newapi_usage_records_log_fallback_unique
    on newapi_usage_records (newapi_token_id, newapi_log_id)
    where newapi_token_id is not null
      and newapi_request_id is null
      and newapi_log_id is not null`,
  `create index if not exists newapi_usage_records_user_created_idx
    on newapi_usage_records (feishu_user_id, newapi_created_at)`,
  `create index if not exists newapi_usage_records_token_created_idx
    on newapi_usage_records (newapi_token_id, newapi_created_at)`,
  `create index if not exists newapi_usage_records_match_status_idx
    on newapi_usage_records (match_status, last_synced_at)`,
  `create table if not exists usage_sync_checkpoints (
    id text primary key,
    scope text not null unique,
    data jsonb not null,
    updated_at timestamptz not null
  )`,
  `create table if not exists usage_sync_issues (
    id text primary key,
    issue_type text not null,
    status text not null,
    newapi_log_id text,
    newapi_request_id text,
    newapi_token_id text,
    data jsonb not null,
    first_seen_at timestamptz not null,
    last_seen_at timestamptz not null,
    last_synced_at timestamptz not null
  )`,
  `create index if not exists usage_sync_issues_status_seen_idx
    on usage_sync_issues (status, last_seen_at)`,
  `create index if not exists usage_sync_issues_log_idx
    on usage_sync_issues (newapi_log_id)
    where newapi_log_id is not null`,
  `update usage_sync_issues
   set status = 'closed',
       data = jsonb_set(data, '{status}', to_jsonb('closed'::text), true)
   where issue_type = 'unknown_token'
     and status = 'open'`,
  `create table if not exists admin_scopes (
    id text primary key,
    feishu_user_id text not null,
    scope_type text not null,
    department_id text,
    source text not null,
    status text not null,
    data jsonb not null,
    created_at timestamptz not null,
    updated_at timestamptz not null
  )`,
  `create index if not exists admin_scopes_user_status_idx
    on admin_scopes (feishu_user_id, status)`,
  `create index if not exists admin_scopes_department_status_idx
    on admin_scopes (department_id, status)`,
  `insert into app_settings (id, data)
    values ('default', '{"defaultMonthlyQuota":200}'::jsonb)
    on conflict (id) do nothing`,
  `insert into department_quota_periods
    (id, department_id, period, data, created_at, updated_at)
   select
     'dqp_' || md5(user_row.department_id || ':' || to_char(current_date, 'YYYY-MM')),
     user_row.department_id,
     to_char(current_date, 'YYYY-MM'),
     jsonb_build_object(
       'id', 'dqp_' || md5(user_row.department_id || ':' || to_char(current_date, 'YYYY-MM')),
       'departmentId', user_row.department_id,
       'departmentName', max(user_row.data->>'departmentName'),
       'period', to_char(current_date, 'YYYY-MM'),
       'quotaLimit', coalesce(sum((billing.data->>'monthlyQuota')::numeric), 0)::int,
       'defaultGrantQuota', coalesce(
         (select (settings.data->>'defaultMonthlyQuota')::int
            from app_settings settings where settings.id = 'default'),
         200
       ),
       'createdAt', now(),
       'updatedAt', now()
     ),
     now(),
     now()
   from feishu_users user_row
   left join user_billing_periods billing
     on billing.feishu_user_id = user_row.id
    and billing.period = to_char(current_date, 'YYYY-MM')
   where user_row.department_id is not null
   group by user_row.department_id
   on conflict (department_id, period) do nothing`,
];

const client = await pool.connect();
try {
  await client.query("begin");
  for (const statement of statements) {
    await client.query(statement);
  }
  await client.query("commit");
  console.log(`Applied ${statements.length} migration statements`);
} catch (err) {
  await client.query("rollback");
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
