import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const quotaSubmitPath = new URL("../lib/quota-operation-submit.ts", import.meta.url);
const sessionPath = new URL("../lib/session.ts", import.meta.url);
const quotaDecisionRoutePath = new URL(
  "../app/api/admin/token-requests/[id]/decision/route.ts",
  import.meta.url,
);
const keyResetRoutePath = new URL("../app/api/token/reset/route.ts", import.meta.url);
const instrumentationPath = new URL("../instrumentation.ts", import.meta.url);

function section(source: string, startMarker: string, endMarker?: string) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  if (!endMarker) return source.slice(start);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

function assertOrdered(source: string, markers: string[]) {
  let previous = -1;
  for (const marker of markers) {
    const current = source.indexOf(marker);
    assert.ok(current > previous, `${marker} must follow the previous durable-submission step`);
    previous = current;
  }
}

test("quota submission owns a small bounded pool independent from business and control work", async () => {
  const [source, instrumentation] = await Promise.all([
    readFile(quotaSubmitPath, "utf8"),
    readFile(instrumentationPath, "utf8"),
  ]);
  const pool = section(source, "function getQuotaSubmitPool()", "export function quotaSubmitPoolRuntimeSnapshot");

  assert.equal(source.match(/new Pool\(/g)?.length, 1);
  assert.match(pool, /connectionString: config\.databaseUrl/);
  assert.match(pool, /max: config\.postgres\.quotaSubmitPoolMax/);
  assert.match(pool, /min: config\.postgres\.quotaSubmitPoolMax/);
  assert.match(pool, /idleTimeoutMillis: config\.postgres\.poolIdleTimeoutMs/);
  assert.match(
    pool,
    /connectionTimeoutMillis: config\.postgres\.quotaSubmitConnectionTimeoutMs/,
  );
  assert.match(source, /const quotaSubmitRuntime = globalThis as QuotaSubmitRuntime/);
  assert.match(source, /__tokenInsideQuotaSubmitPool/);
  assert.match(source, /__tokenInsideQuotaSubmitWarmPromise/);
  assert.doesNotMatch(source, /from "@\/lib\/(?:postgres-store|store|quota-saga)"/);
  assert.match(source, /export async function warmQuotaSubmitPool\(\)/);
  assert.match(
    source,
    /Array\.from\(\{ length: config\.postgres\.quotaSubmitPoolMax \}/,
  );
  assert.match(
    source,
    /Promise\.all\(clients\.map\(\(client\) => client\.query\("select 1"\)\)\)/,
  );
  assert.match(instrumentation, /await warmQuotaSubmitPool\(\)/);
  assert.ok(
    instrumentation.indexOf("await warmQuotaSubmitPool()") <
      instrumentation.indexOf("await ensureUsageSyncScheduler()"),
  );
});

test("session identity and submit authorization avoid shared store and external control-plane calls", async () => {
  const [submitSource, sessionSource] = await Promise.all([
    readFile(quotaSubmitPath, "utf8"),
    readFile(sessionPath, "utf8"),
  ]);
  const identity = section(
    sessionSource,
    "export async function getCurrentSessionIdentity()",
    "export async function setSessionCookie",
  );
  const adminAuth = section(
    submitSource,
    "async function readAdminActorScope(",
    "async function readRequestAndUser(",
  );
  const keySubmit = section(submitSource, "export async function submitPostgresKeyRotation(");

  assert.match(identity, /await cookies\(\)/);
  assert.match(identity, /verifySessionToken/);
  assert.doesNotMatch(identity, /getUserById|readStore|fetch\(/);

  assert.match(adminAuth, /client\.query/);
  assert.match(adminAuth, /from feishu_users/);
  assert.match(adminAuth, /from admin_scopes/);
  assert.match(adminAuth, /from token_requests request/);
  assert.match(adminAuth, /resolveSessionAdminScopeProjection/);
  assert.match(keySubmit, /select data from feishu_users where id = \$1 for share/);
  assert.doesNotMatch(
    submitSource,
    /requireAdminScope|getCurrentUser|getUserById|readStore|fetch\(|newapi-client|feishu-client/,
  );
});

test("quota request and durable operation commit atomically before submission resolves", async () => {
  const source = await readFile(quotaSubmitPath, "utf8");
  const transaction = section(
    source,
    "async function withQuotaSubmitTransaction<",
    "async function saveTokenRequestRow(",
  );
  const firstProvision = section(
    source,
    "export async function submitPostgresFirstProvisionDecision(",
    "export async function submitPostgresKeyRotation(",
  );
  const firstProvisionPersist = section(
    source,
    "async function persistFirstProvisionSubmission(",
    "export type FirstProvisionDecisionSubmission",
  );
  const keyRotation = section(source, "export async function submitPostgresKeyRotation(");
  const requestRead = section(
    source,
    "async function readRequestAndUser(",
    "function assertRequestScope(",
  );

  assertOrdered(transaction, [
    'await client.query("begin")',
    "set local lock_timeout",
    "set local statement_timeout",
    "const result = await fn(client)",
    'await client.query("commit")',
    "return result",
  ]);
  assert.match(transaction, /await client\.query\("rollback"\)/);
  assert.match(transaction, /finally[\s\S]*client\.release\(\)/);

  for (const submission of [firstProvision, keyRotation]) {
    assert.match(submission, /return withQuotaSubmitTransaction\(async \(client\) =>/);
    assert.match(submission, /pg_advisory_xact_lock/);
    assert.doesNotMatch(submission, /enqueueQuota|runQuotaOperation|ensureQuotaOperationWorker/);
  }
  assert.match(firstProvision, /return persistFirstProvisionSubmission\(client/);
  assertOrdered(firstProvisionPersist, [
    "saveTokenRequestRow(client",
    "insertQuotaOperationRow(client",
  ]);
  assertOrdered(keyRotation, ["saveTokenRequestRow(client", "insertQuotaOperationRow(client"]);
  assert.match(keyRotation.slice(keyRotation.indexOf("insertQuotaOperationRow(client")), /return/);

  assert.match(requestRead, /lock \? "for update of request, request_user" : ""/);
  assert.match(firstProvision, /readRequestAndUser\(client, input\.requestId, true\)/);
  assert.match(firstProvisionPersist, /idempotencyKey = `quota-operation:\$\{input\.request\.id\}`/);
  assert.match(firstProvisionPersist, /operationType: "first_provision"/);
  assert.match(keyRotation, /idempotencyKey = `key-reset:\$\{input\.clientRequestId\}`/);
  assert.match(source, /insert into quota_operations/);
  assert.match(source, /idempotency_key/);
});

test("busy submission is bounded as 503 and routes preserve Retry-After", async () => {
  const [submitSource, decisionSource, resetSource] = await Promise.all([
    readFile(quotaSubmitPath, "utf8"),
    readFile(quotaDecisionRoutePath, "utf8"),
    readFile(keyResetRoutePath, "utf8"),
  ]);
  const transaction = section(
    submitSource,
    "async function withQuotaSubmitTransaction<",
    "async function saveTokenRequestRow(",
  );

  assert.match(transaction, /getQuotaSubmitPool\(\)\.connect\(\)/);
  assert.match(transaction, /503,[\s\S]*"quota_submission_busy"[\s\S]*1/);
  assert.match(submitSource, /"55P03"/);
  assert.match(submitSource, /"57014"/);
  assert.match(submitSource, /timeout\|too many clients\|connection terminated/i);

  for (const route of [decisionSource, resetSource]) {
    assert.match(route, /err instanceof QuotaSubmissionError/);
    assert.match(route, /status: err\.status/);
    assert.match(route, /"Retry-After": String\(err\.retryAfterSeconds\)/);
  }
});

test("Postgres routes await atomic commit, then wake the worker and return 202 without inline Saga", async () => {
  const [decisionSource, resetSource] = await Promise.all([
    readFile(quotaDecisionRoutePath, "utf8"),
    readFile(keyResetRoutePath, "utf8"),
  ]);
  const decisionFastPath = section(
    decisionSource,
    'if (getConfig().storeBackend === "postgres" && parsed.data.action === "approve")',
    "const auth = await requireAdminScope()",
  );
  const resetFastPath = section(
    resetSource,
    'if (getConfig().storeBackend === "postgres")',
    "const idempotencyKey = `key-reset:${clientRequestId}`",
  );

  assertOrdered(decisionFastPath, [
    "await submitPostgresFirstProvisionDecision(",
    "after(() => ensureQuotaOperationWorker())",
    "return NextResponse.json(",
    "{ status: 202 }",
  ]);
  assertOrdered(resetFastPath, [
    "await submitPostgresKeyRotation(",
    "ensureQuotaOperationWorker()",
    "return NextResponse.json(submitted, { status: 202 })",
  ]);

  assert.doesNotMatch(
    decisionFastPath,
    /runQuotaOperation|enqueueQuotaAdjustment|enqueueFirstProvision|enqueueKeyRotation|await ensureQuotaOperationWorker/,
  );
  assert.doesNotMatch(
    resetFastPath,
    /\bafter\(|runQuotaOperation|enqueueQuotaAdjustment|enqueueFirstProvision|enqueueKeyRotation|await ensureQuotaOperationWorker/,
  );
  assert.doesNotMatch(decisionFastPath, /requireAdminScope|getScopedTokenRequest|provisionTokenForRequest/);
  assert.doesNotMatch(resetFastPath, /getCurrentUser|getActiveTokenForUser|getEffectiveUserGrantQuota/);
});
