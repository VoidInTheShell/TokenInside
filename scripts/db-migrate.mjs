import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });

const GREENFIELD_BASELINE_VERSION = "20260717_001_greenfield_baseline";
const GREENFIELD_BUSINESS_TABLES = [
  "app_settings",
  "greenfield_installation_manifest",
  "billing_operations",
  "feishu_users",
  "token_requests",
  "token_accounts",
  "user_billing_periods",
  "department_quota_periods",
  "department_quota_requests",
  "quota_change_events",
  "user_quota_policies",
  "quota_operations",
  "quota_ledger_entries",
  "user_quota_states",
  "quota_reconciliation_records",
  "quota_balance_observer_state",
  "feishu_events",
  "proxy_request_logs",
  "newapi_usage_records",
  "usage_sync_checkpoints",
  "usage_sync_issues",
  "admin_scopes",
];

const statements = [
  `create table if not exists app_settings (
    id text primary key,
    data jsonb not null
  )`,
  `create table if not exists greenfield_installation_manifest (
    id text primary key,
    upstream_base_url text not null,
    configured_control_user_id text not null,
    observed_control_user_id text not null,
    checked_at timestamptz not null,
    cutover_at timestamptz not null,
    manifest_hash text not null,
    data jsonb not null,
    constraint greenfield_installation_manifest_singleton_check
      check (id = 'default'),
    constraint greenfield_installation_manifest_hash_check
      check (manifest_hash ~ '^[0-9a-f]{64}$')
  )`,
  `create table if not exists billing_operations (
    id text primary key,
    kind text not null,
    status text not null,
    dry_run boolean not null default false,
    operated_by_feishu_user_id text not null,
    period text,
    input jsonb not null default '{}'::jsonb,
    summary jsonb not null default '{}'::jsonb,
    error_message text,
    attempt_count integer not null default 0,
    lease_id text,
    lease_expires_at timestamptz,
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    constraint billing_operations_kind_check
      check (kind in ('usage_sync', 'department_member_sync')),
    constraint billing_operations_status_check
      check (status in ('pending', 'running', 'continuation_pending', 'dry_run', 'applied', 'partial_failed', 'failed')),
    constraint billing_operations_attempt_count_check
      check (attempt_count >= 0),
    constraint billing_operations_lease_check
      check (
        (status = 'running' and lease_id is not null and lease_expires_at is not null)
        or
        (status <> 'running' and lease_id is null and lease_expires_at is null)
      ),
    constraint billing_operations_completed_check
      check (
        (status in ('continuation_pending', 'dry_run', 'applied', 'partial_failed', 'failed') and completed_at is not null)
        or
        (status in ('pending', 'running') and completed_at is null)
      )
  )`,
  `alter table billing_operations
    drop constraint if exists billing_operations_kind_check`,
  `alter table billing_operations
    add constraint billing_operations_kind_check
      check (kind in ('usage_sync', 'department_member_sync'))`,
  `drop index if exists billing_operations_one_active_kind_idx`,
  `create unique index if not exists billing_operations_one_active_kind_idx
    on billing_operations (kind)
    where kind = 'usage_sync' and status in ('pending', 'running')`,
  `create unique index if not exists billing_operations_one_active_department_sync_idx
    on billing_operations (kind, (input->>'departmentId'))
    where kind = 'department_member_sync' and status in ('pending', 'running')`,
  `create index if not exists billing_operations_kind_status_created_idx
    on billing_operations (kind, status, created_at, id)`,
  `create index if not exists billing_operations_runnable_idx
    on billing_operations (kind, status, lease_expires_at, created_at, id)
    where status in ('pending', 'running')`,
  `create index if not exists billing_operations_lease_idx
    on billing_operations (lease_id, lease_expires_at)
    where status = 'running'`,
  `create index if not exists billing_operations_created_idx
    on billing_operations (created_at desc, id desc)`,
  `create index if not exists billing_operations_updated_idx
    on billing_operations (updated_at desc, id desc)`,
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
  `create index if not exists feishu_users_open_id_idx
    on feishu_users (open_id, created_at, id)`,
  `create index if not exists feishu_users_department_idx
    on feishu_users (department_id, id)`,
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
  `create table if not exists token_accounts (
    id text primary key,
    feishu_user_id text not null,
    token_request_id text not null,
    newapi_token_id text,
    key_hash text not null,
    status text not null,
    billing_period text not null,
    operation_generation integer not null default 0,
    drain_started_at timestamptz,
    settled_through timestamptz,
    activated_at timestamptz,
    data jsonb not null,
    created_at timestamptz not null,
    disabled_at timestamptz,
    unique (key_hash)
  )`,
  `create index if not exists token_accounts_user_status_idx
    on token_accounts (feishu_user_id, status)`,
  `create index if not exists token_accounts_user_period_idx
    on token_accounts (feishu_user_id, billing_period, created_at, id)`,
  `create index if not exists token_accounts_status_user_idx
    on token_accounts (status, feishu_user_id)`,
  `create index if not exists token_accounts_active_observer_idx
    on token_accounts (feishu_user_id, id)
    include (newapi_token_id, operation_generation)
    where status = 'active' and newapi_token_id is not null`,
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
  `create index if not exists user_billing_periods_period_user_idx
    on user_billing_periods (period, feishu_user_id)`,
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
    billing_period text,
    operation_generation integer not null default 0,
    lease_expires_at timestamptz,
    heartbeat_at timestamptz,
    data jsonb not null,
    created_at timestamptz not null
  )`,
  `create index if not exists proxy_request_logs_user_created_idx
    on proxy_request_logs (feishu_user_id, created_at)`,
  `create index if not exists proxy_request_logs_user_period_created_idx
    on proxy_request_logs (feishu_user_id, billing_period, created_at, id)`,
  `create index if not exists proxy_request_logs_period_user_created_idx
    on proxy_request_logs (billing_period, feishu_user_id, created_at, id)`,
  `create index if not exists proxy_request_logs_token_created_idx
    on proxy_request_logs (token_account_id, created_at)`,
  `create index if not exists proxy_request_logs_status_created_idx
    on proxy_request_logs (status_code, created_at)`,
  `create index if not exists proxy_request_logs_generation_inflight_idx
    on proxy_request_logs (feishu_user_id, operation_generation, lease_expires_at)
    where status_code = 0`,
  `create index if not exists proxy_request_logs_usage_pending_terminal_idx
    on proxy_request_logs (created_at)
    where data->>'usageSettlementStatus' in ('pending', 'retrying')
      and coalesce(data->>'terminalStatus', data->>'status', '')
        in ('completed', 'failed', 'cancelled')`,
  `create table if not exists newapi_usage_records (
    id text primary key,
    newapi_log_id text,
    newapi_request_id text,
    newapi_token_id text,
    token_account_id text,
    feishu_user_id text,
    billing_period text,
    match_status text not null,
    data jsonb not null,
    newapi_created_at timestamptz,
    first_seen_at timestamptz not null,
    last_synced_at timestamptz not null
  )`,
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
  `create index if not exists newapi_usage_records_user_period_created_idx
    on newapi_usage_records (feishu_user_id, billing_period, newapi_created_at, id)`,
  `create index if not exists newapi_usage_records_token_created_idx
    on newapi_usage_records (newapi_token_id, newapi_created_at)`,
  `create index if not exists newapi_usage_records_match_status_idx
    on newapi_usage_records (match_status, last_synced_at)`,
  `create index if not exists newapi_usage_records_billing_recent_authoritative_idx
    on newapi_usage_records (
      billing_period,
      coalesce(newapi_created_at, last_synced_at) desc,
      id
    )
    where match_status in ('matched', 'no_proxy_match')`,
  `create unique index if not exists newapi_usage_records_proxy_match_unique
    on newapi_usage_records ((data->>'matchedProxyLogId'))
    where match_status = 'matched'
      and data->>'matchedProxyLogId' is not null`,
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
  `create table if not exists admin_scopes (
    id text primary key,
    feishu_user_id text not null,
    scope_type text not null,
    department_id text,
    source text not null,
    status text not null,
    data jsonb not null,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    constraint admin_scopes_root_source_check
      check (
        coalesce(data->>'role', '') <> 'root'
        or (scope_type = 'global' and source = 'environment')
      )
  )`,
  `create index if not exists admin_scopes_user_status_idx
    on admin_scopes (feishu_user_id, status)`,
  `create index if not exists admin_scopes_department_status_idx
    on admin_scopes (department_id, status)`,
  `create table if not exists user_quota_policies (
    id text primary key,
    feishu_user_id text not null,
    department_id text,
    effective_from_period text not null,
    effective_to_period text,
    version integer not null,
    source_type text not null,
    source_id text not null,
    data jsonb not null,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    unique (feishu_user_id, version),
    constraint user_quota_policies_source_unique
      unique (source_type, source_id)
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
    worker_lease_id text,
    worker_lease_expires_at timestamptz,
    data jsonb not null,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    completed_at timestamptz,
    constraint quota_operations_type_check
      check (operation_type in ('first_provision', 'quota_adjust', 'key_rotation', 'monthly_open')),
    constraint quota_operations_worker_lease_pair_check
      check ((worker_lease_id is null) = (worker_lease_expires_at is null))
  )`,
  `create index if not exists quota_operations_worker_idx
    on quota_operations (state, next_retry_at, worker_lease_expires_at, updated_at)`,
  `create index if not exists quota_operations_user_created_idx
    on quota_operations (feishu_user_id, created_at desc)`,
  `create index if not exists quota_operations_updated_idx
    on quota_operations (updated_at desc, id)`,
  `create index if not exists quota_operations_user_updated_idx
    on quota_operations (feishu_user_id, updated_at desc, id)`,
  `create unique index if not exists quota_operations_one_open_per_user
    on quota_operations (feishu_user_id)
    where state not in ('completed', 'compensated', 'cancelled')`,
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
    unique (operation_id, entry_type),
    constraint quota_ledger_entries_type_check
      check (entry_type in (
        'period_open_authorization',
        'quota_adjust_grant',
        'quota_adjust_release',
        'admin_correction_debit',
        'admin_correction_credit',
        'operation_compensation'
      ))
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
  `create index if not exists user_quota_states_resume_recovery_idx
    on user_quota_states (updated_at, feishu_user_id)
    where admission = 'closed'
      and data->>'closedReason' = 'user_access_resume_pending'`,
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
  `create index if not exists quota_reconciliation_token_period_idx
    on quota_reconciliation_records (token_account_id, period, updated_at desc)
    where token_account_id is not null`,
  `create table if not exists quota_balance_observer_state (
    id text primary key,
    cursor_feishu_user_id text,
    last_run_at timestamptz,
    updated_at timestamptz not null
  )`,
  `insert into app_settings (id, data)
    values ('default', '{"defaultMonthlyQuota":200}'::jsonb)
    on conflict (id) do nothing`,
];

const baselineMigration = {
  version: GREENFIELD_BASELINE_VERSION,
  statements,
};

async function loadAdditionalMigrations() {
  const directory = resolve(fileURLToPath(new URL("./migrations/", import.meta.url)));
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return [];
    throw error;
  }

  const files = entries
    .filter((entry) => entry.isFile() && /^\d{8}_\d{3}_[a-z0-9_]+\.mjs$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const loaded = [];
  for (const file of files) {
    const moduleUrl = pathToFileURL(resolve(directory, file)).href;
    const module = await import(moduleUrl);
    if (!module.migration || typeof module.migration !== "object") {
      throw new Error(`Migration module ${file} must export a migration object`);
    }
    loaded.push(module.migration);
  }
  return loaded;
}

const migrations = [
  baselineMigration,
  ...(await loadAdditionalMigrations()),
];

const migrationLockName = "tokeninside_schema_migrations";

function checksumFor(statementsForMigration) {
  return createHash("sha256")
    .update(statementsForMigration.join("\n-- tokeninside migration statement --\n"), "utf8")
    .digest("hex");
}

function assertMigrationPlan(plan) {
  const versions = new Set();
  for (const migration of plan) {
    if (!/^\d{8}_\d{3}_[a-z0-9_]+$/.test(migration.version)) {
      throw new Error(`Invalid migration version: ${migration.version}`);
    }
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate migration version: ${migration.version}`);
    }
    if (!Array.isArray(migration.statements) || migration.statements.length === 0) {
      throw new Error(`Migration ${migration.version} has no statements`);
    }
    versions.add(migration.version);
  }
}

async function assertGreenfieldDatabase(client, plan, applied) {
  const knownVersions = new Set(plan.map((migration) => migration.version));
  const unknownVersions = [...applied.keys()].filter((version) => !knownVersions.has(version));
  if (unknownVersions.length > 0) {
    throw new Error(
      `Greenfield baseline refuses legacy or unknown schema_migrations: ${unknownVersions.join(", ")}`,
    );
  }
  if (applied.size > 0 && !applied.has(GREENFIELD_BASELINE_VERSION)) {
    throw new Error(
      `Greenfield baseline ${GREENFIELD_BASELINE_VERSION} is missing from the existing migration history`,
    );
  }
  if (applied.has(GREENFIELD_BASELINE_VERSION)) return;

  const existing = await client.query(
    `select table_name
     from information_schema.tables
     where table_schema = current_schema()
       and table_name = any($1::text[])
     order by table_name`,
    [GREENFIELD_BUSINESS_TABLES],
  );
  if (existing.rows.length > 0) {
    throw new Error(
      `Greenfield baseline requires a new empty PostgreSQL database; found existing TokenInside tables: ${existing.rows
        .map((row) => row.table_name)
        .join(", ")}`,
    );
  }
}

async function applyMigration(client, migration, checksum) {
  await client.query("begin");
  try {
    for (const statement of migration.statements) {
      await client.query(statement);
    }
    await client.query(
      `insert into schema_migrations (version, checksum)
       values ($1, $2)`,
      [migration.version, checksum],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

assertMigrationPlan(migrations);

const client = await pool.connect();
try {
  await client.query(
    `create table if not exists schema_migrations (
      version text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`,
  );
  await client.query("select pg_advisory_lock(hashtext($1))", [migrationLockName]);
  try {
    const appliedResult = await client.query(
      "select version, checksum, applied_at from schema_migrations order by version",
    );
    const applied = new Map(appliedResult.rows.map((row) => [row.version, row]));
    await assertGreenfieldDatabase(client, migrations, applied);
    let appliedCount = 0;

    for (const migration of migrations) {
      const checksum = checksumFor(migration.statements);
      const existing = applied.get(migration.version);
      if (existing) {
        if (existing.checksum !== checksum) {
          throw new Error(
            `Migration checksum mismatch for ${migration.version}; create a new migration instead of editing applied history`,
          );
        }
        console.log(`Migration ${migration.version} already applied at ${existing.applied_at.toISOString()}`);
        continue;
      }

      await applyMigration(client, migration, checksum);
      appliedCount += 1;
      console.log(`Applied migration ${migration.version} (${migration.statements.length} statements)`);
    }

    console.log(`Migration complete: ${appliedCount} applied, ${migrations.length - appliedCount} already recorded`);
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [migrationLockName]);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
