import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const packagePath = new URL("../package.json", import.meta.url);
const baselinePath = new URL("../scripts/db-migrate.mjs", import.meta.url);
const importPath = new URL("../scripts/db-import-json.mjs", import.meta.url);
const verifyImportPath = new URL("../scripts/db-verify-import.mjs", import.meta.url);
const postgresStorePath = new URL("../lib/postgres-store.ts", import.meta.url);
const usageSyncPath = new URL("../lib/usage-sync.ts", import.meta.url);
const periodOpenRoutePath = new URL(
  "../app/api/admin/billing/period-open/route.ts",
  import.meta.url,
);
const usageIngestionRoutePath = new URL(
  "../app/api/admin/billing/usage-ingestion/route.ts",
  import.meta.url,
);
const billingOperationRoutePath = new URL(
  "../app/api/admin/billing-operations/[id]/route.ts",
  import.meta.url,
);

function section(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

test("greenfield install exposes no legacy whole-business JSON import", async () => {
  const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(pkg.scripts?.["db:import-json"], undefined);
  assert.equal(pkg.scripts?.["db:verify-import"], undefined);
  await assert.rejects(access(importPath));
  await assert.rejects(access(verifyImportPath));
});

test("greenfield baseline rejects legacy operation, ledger, and forged root shapes", async () => {
  const baseline = await readFile(baselinePath, "utf8");
  assert.match(
    baseline,
    /quota_operations_type_check[\s\S]*first_provision[\s\S]*quota_adjust[\s\S]*key_rotation[\s\S]*monthly_open/,
  );
  assert.match(
    baseline,
    /quota_ledger_entries_type_check[\s\S]*period_open_authorization[\s\S]*operation_compensation/,
  );
  assert.doesNotMatch(
    section(
      baseline,
      "constraint quota_operations_type_check",
      "create index if not exists quota_operations_worker_idx",
    ),
    /migration|quota_restore/,
  );
  assert.match(
    baseline,
    /admin_scopes_root_source_check[\s\S]*scope_type = 'global'[\s\S]*source = 'environment'/,
  );
});

test("billing materialization is period-bounded and isolated from the proxy business pool", async () => {
  const [baseline, postgres] = await Promise.all([
    readFile(baselinePath, "utf8"),
    readFile(postgresStorePath, "utf8"),
  ]);
  for (const index of [
    "token_accounts_user_period_idx",
    "proxy_request_logs_user_period_created_idx",
    "newapi_usage_records_user_period_created_idx",
  ]) {
    assert.match(baseline, new RegExp(index));
  }
  const materializer = section(
    postgres,
    "async function syncPostgresBillingPeriodForUser(",
    "export async function reconcilePostgresBillingPeriodForUser(",
  );
  assert.match(materializer, /token_accounts[\s\S]*billing_period = \$2/);
  assert.match(materializer, /proxy_request_logs[\s\S]*billing_period = \$2/);
  assert.match(materializer, /newapi_usage_records[\s\S]*billing_period = \$2/);
  const entrypoint = section(
    postgres,
    "export async function reconcilePostgresBillingPeriodForUser(",
    "export async function reconcilePostgresBillingPeriodForQuotaOperation(",
  );
  assert.match(entrypoint, /withSettlementTransaction/);
  assert.doesNotMatch(entrypoint, /withTransaction\(/);
});

test("all hidden maintenance APIs enforce the canonical root scope helper", async () => {
  const routes = await Promise.all([
    readFile(periodOpenRoutePath, "utf8"),
    readFile(usageIngestionRoutePath, "utf8"),
    readFile(billingOperationRoutePath, "utf8"),
  ]);
  for (const route of routes) {
    assert.match(route, /isRootAdminScope/);
    assert.match(route, /!isRootAdminScope\(auth\.scope\)/);
    assert.doesNotMatch(route, /scope\.role !== "root"|scopeType !== "global"/);
  }
});

test("bounded ingestion reports continuation instead of claiming full application", async () => {
  const usageSync = await readFile(usageSyncPath, "utf8");
  assert.match(
    usageSync,
    /const successfulStatus[\s\S]*continuation_pending/,
  );
  assert.match(
    usageSync,
    /status: dryRun \? "dry_run" : successfulStatus/,
  );
});
