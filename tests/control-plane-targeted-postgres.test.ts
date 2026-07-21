import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";

const keyPrewarmPath = new URL("../lib/key-prewarm.ts", import.meta.url);
const storePath = new URL("../lib/store.ts", import.meta.url);
const postgresQueriesPath = new URL(
  "../lib/postgres-control-queries.ts",
  import.meta.url,
);
const postgresStorePath = new URL("../lib/postgres-store.ts", import.meta.url);
const baselinePath = new URL("../scripts/db-migrate.mjs", import.meta.url);

function section(source: string, startMarker: string, endMarker: string) {
  const normalized = source.replace(/\r\n/g, "\n");
  const start = normalized.indexOf(startMarker);
  const end = normalized.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return normalized.slice(start, end);
}

test("key prewarm uses bounded targeted PostgreSQL reads and atomic per-user writes", async () => {
  const [keyPrewarm, store, queries, postgresStore] = await Promise.all([
    readFile(keyPrewarmPath, "utf8"),
    readFile(storePath, "utf8"),
    readFile(postgresQueriesPath, "utf8"),
    readFile(postgresStorePath, "utf8"),
  ]);

  assert.doesNotMatch(keyPrewarm, /getStoreSnapshot|addTokenAccount/);
  assert.match(keyPrewarm, /listDepartmentPrewarmCandidates/);
  assert.match(keyPrewarm, /withUserQuotaOperationLock\(user\.id/);
  assert.match(keyPrewarm, /reservePrewarmedTokenAccountUnderUserFence/);
  assert.match(keyPrewarm, /claimStoredPrewarmedTokenAccountUnderUserFence/);
  assert.match(
    keyPrewarm,
    /prewarmedCredentialCiphertext: sealQuotaCredential\(upstream\.key, accountId\)/,
  );

  const candidateDispatch = section(
    store,
    "export async function listDepartmentPrewarmCandidates(",
    "export async function reservePrewarmedTokenAccountUnderUserFence(",
  );
  assert.ok(
    candidateDispatch.indexOf("listPostgresPrewarmDepartmentCandidates") <
      candidateDispatch.indexOf("const store = await readStore();"),
  );
  assert.doesNotMatch(
    candidateDispatch.slice(0, candidateDispatch.indexOf("const store = await readStore();")),
    /readStore\(/,
  );

  const reserveDispatch = section(
    store,
    "export async function reservePrewarmedTokenAccountUnderUserFence(",
    "export async function claimStoredPrewarmedTokenAccountUnderUserFence(",
  );
  assert.match(reserveDispatch, /insertPostgresPrewarmedTokenAccountIfEligible/);
  assert.match(reserveDispatch, /return mutate\(\(store\) =>/);
  assert.match(reserveDispatch, /userHasPrewarmReservation/);
  assert.match(reserveDispatch, /userHasOpenPrewarmQuotaOperation/);
  assert.match(reserveDispatch, /store\.tokenAccounts\.push\(input\.account\)/);

  const claimDispatch = section(
    store,
    "export async function claimStoredPrewarmedTokenAccountUnderUserFence(",
    "type AddTokenAccountInput",
  );
  assert.match(claimDispatch, /claimPostgresPrewarmedTokenAccount/);
  assert.match(claimDispatch, /return mutate\(\(store\) =>/);
  assert.doesNotMatch(claimDispatch, /readStore\(/);

  const candidateSql = section(
    queries,
    "export async function listPostgresPrewarmDepartmentCandidates(",
    "export async function listPostgresAdminScopeProjections(",
  );
  assert.match(candidateSql, /withPostgresControlClient/);
  assert.match(candidateSql, /candidate\.department_id = \$1/);
  assert.match(candidateSql, /coalesce\(candidate\.data->>'status', 'active'\) = 'active'/);
  assert.match(candidateSql, /account\.status in \('pending_activation', 'active', 'draining', 'settling'\)/);
  assert.match(candidateSql, /operation\.state not in \('completed', 'compensated', 'cancelled'\)/);
  assert.match(candidateSql, /order by eligible\.id[\s\S]*limit \$2/);
  assert.doesNotMatch(
    candidateSql,
    /proxy_request_logs|newapi_usage_records|quota_ledger_entries|readPostgresStore/,
  );

  const reserveSql = section(
    postgresStore,
    "export async function insertPostgresPrewarmedTokenAccountIfEligible(",
    "export async function claimPostgresPrewarmedTokenAccount(",
  );
  assert.match(reserveSql, /withControlTransaction/);
  assert.match(reserveSql, /from feishu_users/);
  assert.match(reserveSql, /department_id = \$2/);
  assert.match(reserveSql, /for update/);
  assert.match(reserveSql, /from token_accounts/);
  assert.match(reserveSql, /from quota_operations/);
  assert.equal(
    reserveSql.match(/saveTokenAccountRow\(client, input\.account\)/g)?.length,
    1,
    "the prewarmed credential and account must be persisted once",
  );
  assert.doesNotMatch(reserveSql, /readPostgresStore|syncPostgresBillingPeriodForUser/);

  const claimSql = section(
    postgresStore,
    "export async function claimPostgresPrewarmedTokenAccount(",
    "export async function insertPostgresTokenAccountForQuotaOperation(",
  );
  assert.match(claimSql, /withControlTransaction/);
  assert.match(claimSql, /where feishu_user_id = \$1/);
  assert.match(claimSql, /status = 'pending_activation'/);
  assert.match(claimSql, /order by created_at, id[\s\S]*limit 1[\s\S]*for update/);
  assert.match(claimSql, /saveTokenAccountRow/);
  assert.doesNotMatch(claimSql, /readPostgresStore|getStoreSnapshot/);
});

test("admin control reads dispatch to isolated PostgreSQL projections before JSON fallback", async () => {
  const [store, queries] = await Promise.all([
    readFile(storePath, "utf8"),
    readFile(postgresQueriesPath, "utf8"),
  ]);
  for (const [startMarker, endMarker, targetedCall] of [
    [
      "export async function getUserByOpenId(",
      "export async function createTokenRequest(",
      "getPostgresUserByOpenId",
    ],
    [
      "export async function listAdminScopes(",
      "export async function upsertManualAdminScope(",
      "listPostgresAdminScopeProjections",
    ],
    [
      "export async function getAdminScopeById(",
      "export async function syncDepartmentSupervisorAdminScope(",
      "getPostgresAdminScopeById",
    ],
    [
      "export async function listDepartmentStats(",
      "function mapAdminTokenRequest(",
      "listPostgresDepartmentStats",
    ],
    [
      "export async function listAdminTokenRequests(",
      "export async function getAdminOverview(",
      "listPostgresAdminTokenRequestRows",
    ],
  ] as const) {
    const body = section(store, startMarker, endMarker);
    const targeted = body.indexOf(targetedCall);
    const fallback = body.indexOf("readStore(");
    assert.notEqual(targeted, -1, `missing targeted dispatch ${targetedCall}`);
    assert.notEqual(fallback, -1, `missing JSON fallback for ${startMarker}`);
    assert.ok(targeted < fallback, `${targetedCall} must run before JSON fallback`);
    assert.doesNotMatch(body.slice(0, fallback), /readPostgresStore|getStoreSnapshot/);
  }

  for (const [startMarker, endMarker] of [
    [
      "export async function getPostgresUserByOpenId(",
      "export async function listPostgresPrewarmDepartmentCandidates(",
    ],
    [
      "export async function listPostgresAdminScopeProjections(",
      "export async function getPostgresAdminScopeById(",
    ],
    [
      "export async function getPostgresAdminScopeById(",
      "export async function listPostgresAdminTokenRequestRows(",
    ],
    [
      "export async function listPostgresAdminTokenRequestRows(",
      "export async function listPostgresDepartmentStats(",
    ],
    [
      "export async function listPostgresDepartmentStats(",
      "",
    ],
  ] as const) {
    const body = endMarker
      ? section(queries, startMarker, endMarker)
      : queries.slice(queries.indexOf(startMarker));
    assert.match(body, /withPostgresControlClient/);
    assert.doesNotMatch(body, /readPostgresStore|readStore\(|getStoreSnapshot/);
  }

  const requestRows = section(
    queries,
    "export async function listPostgresAdminTokenRequestRows(",
    "export async function listPostgresDepartmentStats(",
  );
  assert.match(requestRows, /limit \$7 offset \$8/);
  assert.match(requestRows, /count\(\*\)::integer from scoped/);
  assert.match(requestRows, /request\.request_type = 'first_apply'/);
  assert.match(requestRows, /request\.status = any\(\$6::text\[\]\)/);

  const departmentRows = queries.slice(
    queries.indexOf("export async function listPostgresDepartmentStats("),
  );
  assert.match(departmentRows, /where period\.period = \$1/);
  assert.match(departmentRows, /where log\.billing_period = \$1/);
  assert.doesNotMatch(departmentRows, /newapi_usage_records|quota_ledger_entries/);
});

test("greenfield baseline provides leading indexes for targeted prewarm and period stats", async () => {
  const baseline = await readFile(baselinePath, "utf8");
  for (const contract of [
    /feishu_users_open_id_idx[\s\S]*on feishu_users \(open_id, created_at, id\)/,
    /feishu_users_department_idx[\s\S]*on feishu_users \(department_id, id\)/,
    /token_accounts_user_status_idx[\s\S]*on token_accounts \(feishu_user_id, status\)/,
    /quota_operations_one_open_per_user[\s\S]*on quota_operations \(feishu_user_id\)[\s\S]*where state not in \('completed', 'compensated', 'cancelled'\)/,
    /token_accounts_status_user_idx[\s\S]*on token_accounts \(status, feishu_user_id\)/,
    /user_billing_periods_period_user_idx[\s\S]*on user_billing_periods \(period, feishu_user_id\)/,
    /proxy_request_logs_period_user_created_idx[\s\S]*on proxy_request_logs \(billing_period, feishu_user_id, created_at, id\)/,
  ]) {
    assert.match(baseline, contract);
  }
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "real PostgreSQL baseline exposes every targeted control-plane index",
  { skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const expected = [
      "feishu_users_open_id_idx",
      "feishu_users_department_idx",
      "token_accounts_user_status_idx",
      "quota_operations_one_open_per_user",
      "token_accounts_status_user_idx",
      "user_billing_periods_period_user_idx",
      "proxy_request_logs_period_user_created_idx",
    ];
    const pool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
    try {
      const result = await pool.query<{ indexname: string }>(
        `select indexname
         from pg_indexes
         where schemaname = current_schema()
           and indexname = any($1::text[])`,
        [expected],
      );
      assert.deepEqual(
        new Set(result.rows.map((row) => row.indexname)),
        new Set(expected),
      );
    } finally {
      await pool.end();
    }
  },
);
