import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const baselinePath = new URL("../scripts/db-migrate.mjs", import.meta.url);
const postgresStorePath = new URL("../lib/postgres-store.ts", import.meta.url);
const storePath = new URL("../lib/store.ts", import.meta.url);
const typesPath = new URL("../lib/types.ts", import.meta.url);

function section(source: string, startMarker: string, endMarker: string) {
  const normalized = source.replace(/\r\n/g, "\n");
  const start = normalized.indexOf(startMarker);
  const end = normalized.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return normalized.slice(start, end);
}

test("greenfield baseline owns a normalized and indexed billing operation table", async () => {
  const [baseline, postgresStore, types] = await Promise.all([
    readFile(baselinePath, "utf8"),
    readFile(postgresStorePath, "utf8"),
    readFile(typesPath, "utf8"),
  ]);

  assert.match(baseline, /"billing_operations"/);
  assert.match(baseline, /create table if not exists billing_operations/);
  assert.match(baseline, /kind text not null/);
  assert.match(baseline, /status text not null/);
  assert.match(baseline, /lease_id text/);
  assert.match(baseline, /lease_expires_at timestamptz/);
  assert.match(baseline, /created_at timestamptz not null/);
  assert.match(baseline, /updated_at timestamptz not null/);
  assert.match(baseline, /billing_operations_kind_check[\s\S]*kind = 'usage_sync'/);
  assert.match(
    baseline,
    /billing_operations_status_check[\s\S]*continuation_pending/,
  );
  assert.doesNotMatch(
    section(
      baseline,
      "create table if not exists billing_operations",
      "create unique index if not exists billing_operations_one_active_kind_idx",
    ),
    /settings_update|monthly_reset/,
  );
  for (const index of [
    "billing_operations_one_active_kind_idx",
    "billing_operations_kind_status_created_idx",
    "billing_operations_runnable_idx",
    "billing_operations_lease_idx",
    "billing_operations_created_idx",
    "billing_operations_updated_idx",
  ]) {
    assert.match(baseline, new RegExp(index));
  }
  assert.match(
    baseline,
    /billing_operations_one_active_kind_idx[\s\S]*where status in \('pending', 'running'\)/,
  );
  const requiredTables = section(
    postgresStore,
    "export const REQUIRED_POSTGRES_TABLES = [",
    "] as const;",
  );
  assert.match(requiredTables, /"billing_operations"/);

  const appSettings = section(types, "export type AppSettings = {", "export type JsonStoreSettings");
  const jsonSettings = section(types, "export type JsonStoreSettings", "export type StoreShape");
  assert.doesNotMatch(appSettings, /billingOperations/);
  assert.match(jsonSettings, /billingOperations\?: BillingOperationRecord\[\]/);
});

test("PostgreSQL billing operations use targeted control SQL instead of app settings JSON", async () => {
  const [postgresStore, store] = await Promise.all([
    readFile(postgresStorePath, "utf8"),
    readFile(storePath, "utf8"),
  ]);
  const operations = section(
    postgresStore,
    "export async function enqueuePostgresBillingOperation(",
    "export async function upsertPostgresUserQuotaPolicy(",
  );
  assert.match(operations, /from billing_operations/);
  assert.match(operations, /insertPostgresBillingOperationRow/);
  assert.match(postgresStore, /insert into billing_operations/);
  assert.match(operations, /update billing_operations/);
  assert.match(operations, /withControlClient/);
  assert.match(operations, /withControlTransaction/);
  assert.doesNotMatch(operations, /app_settings|mutatePostgresAppSettings/);

  const jsonMutation = section(
    store,
    "async function mutateBillingOperations<",
    "export async function getGreenfieldInstallationManifest(",
  );
  assert.doesNotMatch(jsonMutation, /mutatePostgresAppSettings|isPostgresBackend/);
  for (const targetedCall of [
    "enqueuePostgresBillingOperation",
    "findPostgresBillingOperationById",
    "listPostgresRunnableBillingOperations",
    "claimPostgresBillingOperationExecution",
    "renewPostgresBillingOperationExecution",
    "recordPostgresBillingOperation",
    "listPostgresBillingOperations",
  ]) {
    assert.match(store, new RegExp(targetedCall));
  }
});

test("claim renew and completion enforce lease ownership with database CAS", async () => {
  const source = await readFile(postgresStorePath, "utf8");
  const claim = section(
    source,
    "export async function claimPostgresBillingOperationExecution(",
    "export async function renewPostgresBillingOperationExecution(",
  );
  const renew = section(
    source,
    "export async function renewPostgresBillingOperationExecution(",
    "export async function recordPostgresBillingOperation(",
  );
  const record = section(
    source,
    "export async function recordPostgresBillingOperation(",
    "export async function listPostgresBillingOperations(",
  );
  const leasedUpdate = section(
    source,
    "async function updatePostgresBillingOperationRowWithLease(",
    "async function saveFeishuUserRow(",
  );

  assert.match(claim, /update billing_operations set/);
  assert.match(claim, /where id = \$1[\s\S]*and kind = \$2/);
  assert.match(claim, /status = 'pending'/);
  assert.match(claim, /status = 'running'[\s\S]*lease_expires_at <= statement_timestamp\(\)/);
  assert.match(claim, /updated_at = statement_timestamp\(\)/);
  assert.match(claim, /returning \$\{billingOperationColumns\}/);

  assert.match(renew, /update billing_operations set/);
  assert.match(renew, /status = 'running'/);
  assert.match(renew, /lease_id = \$2/);
  assert.match(renew, /lease_expires_at > statement_timestamp\(\)/);
  assert.match(renew, /\$3::timestamptz > lease_expires_at/);
  assert.match(renew, /updated_at = statement_timestamp\(\)/);
  assert.match(renew, /returning \$\{billingOperationColumns\}/);

  assert.match(record, /status = 'running'[\s\S]*lease_id = \$2[\s\S]*lease_expires_at > statement_timestamp\(\)/);
  assert.match(record, /updatePostgresBillingOperationRowWithLease/);
  assert.match(leasedUpdate, /where id = \$1[\s\S]*kind = \$2[\s\S]*input = \$7::jsonb/);
  assert.match(leasedUpdate, /status = 'running'[\s\S]*lease_id = \$10[\s\S]*lease_expires_at > statement_timestamp\(\)/);
  assert.match(leasedUpdate, /completed_at = statement_timestamp\(\)/);
  assert.doesNotMatch(leasedUpdate, /kind = \$2,|dry_run = \$4,|input = \$7,/);
  assert.match(record, /billing operation lease lost/);
});

test("settings writes do not impersonate billing tasks and history listing obeys SQL limit", async () => {
  const [postgresStore, store] = await Promise.all([
    readFile(postgresStorePath, "utf8"),
    readFile(storePath, "utf8"),
  ]);
  const updateSettings = section(
    store,
    "export async function updateAppSettings(",
    "export async function recordBillingOperation(",
  );
  const mutateSettings = section(
    postgresStore,
    "export async function mutatePostgresAppSettings<",
    "export async function enqueuePostgresBillingOperation(",
  );
  const list = section(
    postgresStore,
    "export async function listPostgresBillingOperations(",
    "export async function upsertPostgresUserQuotaPolicy(",
  );

  assert.match(updateSettings, /return mutatePostgresAppSettings/);
  assert.doesNotMatch(updateSettings, /recordPostgresBillingOperation|settings_update/);
  assert.doesNotMatch(mutateSettings, /billingOperations/);
  assert.match(list, /order by updated_at desc, id desc/);
  assert.match(list, /limit \$1/);
  assert.match(list, /10_000/);
  assert.doesNotMatch(list, /app_settings|50/);
});
