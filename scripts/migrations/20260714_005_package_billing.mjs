export const migration = {
  version: "20260714_005_package_billing",
  statements: [
    `create table if not exists billing_package_definitions (
      id text primary key,
      owner_scope_type text not null check (owner_scope_type in ('global', 'department')),
      owner_department_id text,
      code text not null,
      name text not null,
      description text not null default '',
      status text not null check (status in ('active', 'retired')),
      created_by_user_id text not null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      check ((owner_scope_type = 'global' and owner_department_id is null) or
             (owner_scope_type = 'department' and owner_department_id is not null))
    )`,
    `create unique index if not exists billing_package_definitions_owner_code_unique
      on billing_package_definitions (owner_scope_type, coalesce(owner_department_id, ''), code)`,
    `create table if not exists billing_package_versions (
      id text primary key,
      definition_id text not null references billing_package_definitions(id),
      version integer not null check (version > 0),
      granted_quota bigint not null check (granted_quota > 0 and granted_quota <= 9007199254740991),
      cycle_type text not null check (cycle_type in ('calendar_month', 'calendar_quarter', 'fixed_days')),
      cycle_value integer not null check (cycle_value > 0),
      timezone text not null check (timezone = 'Asia/Hong_Kong'),
      eligibility_policy_json jsonb not null,
      regrant_policy_json jsonb not null,
      status text not null check (status in ('draft', 'published', 'retired')),
      effective_from timestamptz,
      effective_until timestamptz,
      created_by_user_id text not null,
      created_at timestamptz not null,
      published_at timestamptz,
      retired_at timestamptz,
      unique (definition_id, version),
      check (effective_until is null or effective_from is null or effective_until > effective_from)
    )`,
    `create or replace function tokeninside_enforce_package_version_immutable()
      returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' and old.status in ('published', 'retired') then
          raise exception 'published package versions are immutable';
        end if;
        if tg_op = 'UPDATE' and old.status in ('published', 'retired') and
           (new.definition_id, new.version, new.granted_quota, new.cycle_type, new.cycle_value,
            new.timezone, new.eligibility_policy_json, new.regrant_policy_json,
            new.effective_from, new.effective_until, new.created_by_user_id, new.created_at)
           is distinct from
           (old.definition_id, old.version, old.granted_quota, old.cycle_type, old.cycle_value,
            old.timezone, old.eligibility_policy_json, old.regrant_policy_json,
            old.effective_from, old.effective_until, old.created_by_user_id, old.created_at) then
          raise exception 'published package versions are immutable';
        end if;
        return case when tg_op = 'DELETE' then old else new end;
      end; $$`,
    `drop trigger if exists billing_package_versions_immutable on billing_package_versions`,
    `create trigger billing_package_versions_immutable before update or delete on billing_package_versions
      for each row execute function tokeninside_enforce_package_version_immutable()`,
    `create table if not exists department_package_assignments (
      id text primary key,
      department_id text not null,
      package_version_id text not null references billing_package_versions(id),
      is_default boolean not null default false,
      status text not null check (status in ('active', 'disabled')),
      assigned_by_user_id text not null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      unique (department_id, package_version_id)
    )`,
    `create unique index if not exists department_package_assignments_one_default
      on department_package_assignments (department_id)
      where is_default and status = 'active'`,
    `create table if not exists billing_package_requests (
      id text primary key,
      request_kind text not null check (request_kind in ('first', 'regrant', 'admin_grant')),
      user_id text not null references feishu_users(id),
      department_id_at_request text not null,
      package_definition_id text not null references billing_package_definitions(id),
      package_version_id text not null references billing_package_versions(id),
      status text not null check (status in ('pending_card_send', 'pending_card_approval',
        'approval_card_send_failed', 'approved', 'approved_provisioning', 'provisioned',
        'rejected', 'cancelled', 'failed')),
      reason text not null default '',
      idempotency_key text not null unique,
      approval_target_open_id text,
      approval_target_source text,
      approval_action_nonce_hash text,
      approval_card_message_id text,
      approval_operator_open_id text,
      approval_operated_at timestamptz,
      billing_operation_id text,
      grant_id text,
      error_code text,
      error_message text,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )`,
    `create unique index if not exists billing_package_requests_approval_nonce_unique
      on billing_package_requests (approval_action_nonce_hash)
      where approval_action_nonce_hash is not null`,
    `create index if not exists billing_package_requests_scope_status_idx
      on billing_package_requests (department_id_at_request, status, created_at desc)`,
    `create unique index if not exists billing_package_requests_one_open_user
      on billing_package_requests (user_id)
      where status in ('pending_card_send', 'pending_card_approval', 'approved', 'approved_provisioning')`,
    `create table if not exists department_budget_periods (
      id text primary key,
      department_id text not null,
      period_type text not null check (period_type in ('calendar_month', 'calendar_quarter', 'fixed_range')),
      period_start timestamptz not null,
      period_end timestamptz not null,
      budget_quota bigint not null check (budget_quota >= 0 and budget_quota <= 9007199254740991),
      committed_quota bigint not null default 0 check (committed_quota >= 0),
      pending_quota bigint not null default 0 check (pending_quota >= 0),
      consumed_quota bigint not null default 0 check (consumed_quota >= 0),
      version integer not null default 1 check (version > 0),
      configured_by_user_id text not null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      unique (department_id, period_start, period_end),
      check (period_end > period_start),
      check (committed_quota + pending_quota <= budget_quota),
      check (consumed_quota <= committed_quota)
    )`,
    `create index if not exists department_budget_periods_active_idx
      on department_budget_periods (department_id, period_start, period_end)`,
    `create table if not exists department_budget_commitments (
      id text primary key,
      department_budget_period_id text not null references department_budget_periods(id),
      department_id text not null,
      request_id text not null references billing_package_requests(id),
      package_version_id text not null references billing_package_versions(id),
      grant_id text,
      quota bigint not null check (quota > 0 and quota <= 9007199254740991),
      state text not null check (state in ('reserved', 'committed', 'released')),
      idempotency_key text not null unique,
      created_at timestamptz not null,
      committed_at timestamptz,
      released_at timestamptz
    )`,
    `create unique index if not exists department_budget_commitments_one_active_request
      on department_budget_commitments (request_id)
      where state in ('reserved', 'committed')`,
    `create table if not exists user_package_grants (
      id text primary key,
      user_id text not null references feishu_users(id),
      department_id_at_grant text not null,
      package_definition_id text not null references billing_package_definitions(id),
      package_version_id text not null references billing_package_versions(id),
      snapshot_json jsonb not null,
      granted_quota bigint not null check (granted_quota > 0 and granted_quota <= 9007199254740991),
      allocated_quota bigint not null default 0 check (allocated_quota >= 0),
      starts_at timestamptz not null,
      expires_at timestamptz not null,
      status text not null check (status in ('active', 'exhausted', 'expired', 'revoked')),
      source_request_id text not null references billing_package_requests(id) unique,
      budget_commitment_id text not null references department_budget_commitments(id) unique,
      created_by_user_id text not null,
      created_at timestamptz not null,
      revoked_at timestamptz,
      expired_at timestamptz,
      check (expires_at > starts_at),
      check (allocated_quota <= granted_quota)
    )`,
    `alter table department_budget_commitments
      add constraint department_budget_commitments_grant_fk
      foreign key (grant_id) references user_package_grants(id) deferrable initially deferred`,
    `create index if not exists user_package_grants_user_status_expiry_idx
      on user_package_grants (user_id, status, expires_at, starts_at, id)`,
    `create table if not exists request_billing_contexts (
      id text primary key,
      source_identity text unique,
      proxy_request_id text not null unique,
      user_id text not null references feishu_users(id),
      department_id_at_request text not null,
      token_account_id text not null references token_accounts(id),
      key_generation integer not null check (key_generation >= 0),
      candidate_grant_ids jsonb not null,
      started_at timestamptz not null,
      finalized_at timestamptz
    )`,
    `create table if not exists usage_charge_allocations (
      id text primary key,
      source_identity text not null,
      request_billing_context_id text not null references request_billing_contexts(id),
      user_id text not null references feishu_users(id),
      department_id_at_request text not null,
      package_grant_id text not null references user_package_grants(id),
      quota bigint not null check (quota > 0 and quota <= 9007199254740991),
      occurred_at timestamptz not null,
      stabilized_at timestamptz not null,
      idempotency_key text not null,
      unique (source_identity, package_grant_id),
      unique (idempotency_key, package_grant_id)
    )`,
    `create index if not exists usage_charge_allocations_report_idx
      on usage_charge_allocations (department_id_at_request, occurred_at desc)`,
    `create table if not exists billing_operations (
      id text primary key,
      operation_type text not null,
      user_id text not null references feishu_users(id),
      department_id text not null,
      state text not null,
      idempotency_key text not null unique,
      request_payload_hash text not null,
      current_step text not null,
      lease_owner text,
      lease_until timestamptz,
      last_error_code text,
      last_error_message text,
      data jsonb not null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      completed_at timestamptz
    )`,
    `create index if not exists billing_operations_worker_idx
      on billing_operations (state, lease_until, updated_at)`,
    `create table if not exists newapi_quota_display_snapshots (
      config_version text primary key,
      quota_per_unit bigint not null check (quota_per_unit > 0 and quota_per_unit <= 9007199254740991),
      display_in_currency boolean not null,
      display_type text not null check (display_type in ('USD', 'CNY', 'CUSTOM', 'RAW_QUOTA')),
      usd_exchange_rate double precision not null check (usd_exchange_rate > 0),
      custom_currency_symbol text not null,
      custom_currency_exchange_rate double precision not null check (custom_currency_exchange_rate > 0),
      fetched_at timestamptz not null,
      source_status text not null check (source_status in ('current', 'stale', 'unavailable'))
    )`,
    `create index if not exists newapi_quota_display_snapshots_latest_idx
      on newapi_quota_display_snapshots (fetched_at desc)`,
  ],
};
