import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { submitAndScheduleDurableQuotaWork } from "../lib/durable-quota-submission.ts";

const submitPath = new URL("../lib/quota-operation-submit.ts", import.meta.url);
const cardRoutePath = new URL("../app/api/feishu/events/route.ts", import.meta.url);
const allocationRoutePath = new URL(
  "../app/api/admin/users/[id]/quota-adjust/route.ts",
  import.meta.url,
);

function section(source: string, start: string, end?: string) {
  const startAt = source.indexOf(start);
  assert.notEqual(startAt, -1, `missing ${start}`);
  if (!end) return source.slice(startAt);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(endAt, -1, `missing ${end}`);
  return source.slice(startAt, endAt);
}

function assertOrdered(source: string, markers: string[]) {
  let cursor = -1;
  for (const marker of markers) {
    const next = source.indexOf(marker, cursor + 1);
    assert.ok(next > cursor, `${marker} must follow the previous durable step`);
    cursor = next;
  }
}

test("card approval commits request and operation before a captured after callback can run", async () => {
  const [submitSource, routeSource] = await Promise.all([
    readFile(submitPath, "utf8"),
    readFile(cardRoutePath, "utf8"),
  ]);
  const cardSubmit = section(
    submitSource,
    "export async function submitPostgresFirstProvisionCardApproval(",
    "export async function submitPostgresAdminFirstProvisionAllocation(",
  );
  const persist = section(
    submitSource,
    "async function persistFirstProvisionSubmission(",
    "export type FirstProvisionDecisionSubmission",
  );
  const approveBranch = section(
    routeSource,
    'if (getConfig().storeBackend === "postgres")',
    "} else {",
  );

  assert.match(cardSubmit, /return withQuotaSubmitTransaction\(async \(client\) =>/);
  assert.match(cardSubmit, /sha256Hex\(input\.nonce\)/);
  assert.match(cardSubmit, /request\.approvalTargetOpenId !== input\.operatorOpenId/);
  assert.match(cardSubmit, /request\.status === "pending_card_approval"/);
  assertOrdered(persist, [
    "const storedRequest = await saveTokenRequestRow(client, updatedRequest)",
    "const storedOperation = await insertQuotaOperationRow(client, operation)",
    "return {",
  ]);
  assert.match(approveBranch, /await submitAndScheduleDurableQuotaWork\(/);
  assert.match(approveBranch, /submitPostgresFirstProvisionCardApproval\(/);
  assert.match(approveBranch, /scheduleAfter: after/);
  assert.match(approveBranch, /wakeWorker: ensureQuotaOperationWorker/);
  const capturedAfter = section(approveBranch, "scheduleAfter: after");
  assert.doesNotMatch(
    capturedAfter,
    /provisionTokenForRequest|runQuotaOperation|createNewApiToken|updateNewApiTokenQuota|fetch\(/,
  );
});

test("admin allocation returns 202 after local atomic submit without waiting for upstream", async () => {
  const [submitSource, routeSource] = await Promise.all([
    readFile(submitPath, "utf8"),
    readFile(allocationRoutePath, "utf8"),
  ]);
  const allocationSubmit = section(
    submitSource,
    "export async function submitPostgresAdminFirstProvisionAllocation(",
    "export async function submitPostgresKeyRotation(",
  );
  const postgresBranch = section(
    routeSource,
    'if (getConfig().storeBackend === "postgres")',
    "const requests = await listUserTokenRequests",
  );

  assert.match(allocationSubmit, /return withQuotaSubmitTransaction\(async \(client\) =>/);
  assert.match(allocationSubmit, /readAdminActorScope\(client, input\.actorUserId\)/);
  assert.match(allocationSubmit, /`user-quota:\$\{input\.targetUserId\}`/);
  assert.match(allocationSubmit, /status = 'active'/);
  assert.doesNotMatch(allocationSubmit, /readStore|assertFirstProvisionDepartmentCapacity/);
  assert.match(postgresBranch, /await submitAndScheduleDurableQuotaWork\(/);
  assert.match(postgresBranch, /submitPostgresAdminFirstProvisionAllocation\(/);
  assert.match(postgresBranch, /scheduleAfter: after/);
  assert.match(postgresBranch, /wakeWorker: ensureQuotaOperationWorker/);
  assertOrdered(postgresBranch, ["return NextResponse.json(", '{ status: 202 }']);
  assert.doesNotMatch(
    postgresBranch,
    /provisionTokenForRequest|runQuotaOperation|createNewApiToken|updateNewApiTokenQuota|fetch\(/,
  );
});

test("captured after defers a slow worker and upstream while the committed operation is returned", async () => {
  const operation = { id: "qo_committed", state: "planned" };
  let persistedOperation: typeof operation | undefined;
  let capturedAfter: (() => void | Promise<void>) | undefined;
  let upstreamCalls = 0;
  let submitCalls = 0;
  const submit = async () => {
    submitCalls += 1;
    persistedOperation ??= operation;
    return { operation: persistedOperation, deduplicated: submitCalls > 1 };
  };
  const slowUpstream = async () => {
    upstreamCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
  };

  const accepted = await submitAndScheduleDurableQuotaWork({
    submit,
    scheduleAfter: (callback) => {
      capturedAfter = callback;
    },
    wakeWorker: () => {
      void slowUpstream();
    },
  });
  assert.strictEqual(accepted.operation, operation);
  assert.strictEqual(persistedOperation, operation);
  assert.equal(upstreamCalls, 0);
  assert.equal(typeof capturedAfter, "function");

  const repeated = await submitAndScheduleDurableQuotaWork({
    submit,
    scheduleAfter: () => undefined,
    wakeWorker: () => {
      void slowUpstream();
    },
  });
  assert.strictEqual(repeated.operation, operation);
  assert.equal(repeated.deduplicated, true);
  assert.equal(upstreamCalls, 0);
});

test("repeated first-provision submissions reuse the durable idempotent operation", async () => {
  const source = await readFile(submitPath, "utf8");
  const persist = section(
    source,
    "async function persistFirstProvisionSubmission(",
    "export type FirstProvisionDecisionSubmission",
  );
  const allocationSubmit = section(
    source,
    "export async function submitPostgresAdminFirstProvisionAllocation(",
    "export async function submitPostgresKeyRotation(",
  );

  assert.match(persist, /readOperationSubmissionState\(client/);
  assert.match(persist, /assertNoConflictingOperation\(state/);
  assert.match(persist, /if \(existing\)/);
  assert.match(persist, /deduplicated: true/);
  assert.match(persist, /existing\.requestedAssignedQuota !== requestedAssignedQuota/);
  assert.match(allocationSubmit, /sha256Hex\([\s\S]*targetUser\.id[\s\S]*input\.clientRequestId/);
  assert.match(allocationSubmit, /for update/);
});
