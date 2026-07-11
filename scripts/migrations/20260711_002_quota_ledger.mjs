export const migration = {
  version: "20260711_002_quota_ledger",
  statements: [
    `create table if not exists user_quota_policies (
      id text primary key,
      feishu_user_id text not null,
      department_id text,
      effective_from_period text not null,
      effective_to_period text,
      version integer not null,
      data jsonb not null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      unique (feishu_user_id, version)
    )`,
    `create index if not exists user_quota_policies_effective_idx
      on user_quota_policies (feishu_user_id, effective_from_period, effective_to_period)`,
    `create table if not exists quota_operations (
      id text primary key,
      operation_type text not null,
      idempotency_key text not null unique,
      feishu_user_id text not null,
      department_id text,
      billing_period text not null,
      state text not null,
      operation_generation integer not null,
      next_retry_at timestamptz,
      data jsonb not null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      completed_at timestamptz
    )`,
    `create index if not exists quota_operations_worker_idx
      on quota_operations (state, next_retry_at, updated_at)`,
    `create index if not exists quota_operations_user_created_idx
      on quota_operations (feishu_user_id, created_at desc)`,
    `create unique index if not exists quota_operations_one_open_per_user
      on quota_operations (feishu_user_id)
      where state not in ('completed', 'compensated')`,
    `create table if not exists quota_ledger_entries (
      id text primary key,
      operation_id text not null,
      feishu_user_id text not null,
      department_id text,
      period text not null,
      entry_type text not null,
      signed_quota bigint not null,
      data jsonb not null,
      created_at timestamptz not null,
      unique (operation_id, entry_type)
    )`,
    `create index if not exists quota_ledger_entries_user_period_idx
      on quota_ledger_entries (feishu_user_id, period, created_at)`,
    `create index if not exists quota_ledger_entries_department_period_idx
      on quota_ledger_entries (department_id, period, created_at)
      where department_id is not null`,
    `create or replace function tokeninside_reject_quota_ledger_mutation()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception 'quota_ledger_entries are immutable; write a reversing entry';
      end;
      $$`,
    `drop trigger if exists quota_ledger_entries_immutable on quota_ledger_entries`,
    `create trigger quota_ledger_entries_immutable
      before update or delete on quota_ledger_entries
      for each row execute function tokeninside_reject_quota_ledger_mutation()`,
    `create table if not exists user_quota_states (
      feishu_user_id text primary key,
      admission text not null,
      active_generation integer not null,
      operation_id text,
      data jsonb not null,
      updated_at timestamptz not null
    )`,
    `create table if not exists quota_reconciliation_records (
      id text primary key,
      feishu_user_id text not null,
      token_account_id text,
      period text not null,
      status text not null,
      operation_id text,
      data jsonb not null,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )`,
    `create index if not exists quota_reconciliation_status_updated_idx
      on quota_reconciliation_records (status, updated_at desc)`,
    `create index if not exists quota_reconciliation_user_period_idx
      on quota_reconciliation_records (feishu_user_id, period, updated_at desc)`,
    `alter table token_accounts
      add column if not exists operation_generation integer not null default 0`,
    `alter table token_accounts add column if not exists drain_started_at timestamptz`,
    `alter table token_accounts add column if not exists settled_through timestamptz`,
    `alter table token_accounts add column if not exists activated_at timestamptz`,
    `alter table proxy_request_logs add column if not exists billing_period text`,
    `alter table proxy_request_logs
      add column if not exists operation_generation integer not null default 0`,
    `alter table proxy_request_logs add column if not exists lease_expires_at timestamptz`,
    `alter table proxy_request_logs add column if not exists heartbeat_at timestamptz`,
    `create index if not exists proxy_request_logs_generation_inflight_idx
      on proxy_request_logs (feishu_user_id, operation_generation, lease_expires_at)
      where status_code = 0`,
  ],
};
