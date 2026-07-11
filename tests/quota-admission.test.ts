import assert from "node:assert/strict";
import test from "node:test";
import {
  assertQuotaAdmission,
  QuotaAdmissionClosedError,
  StaleTokenGenerationError,
} from "../lib/quota-admission.ts";
import type { TokenAccount, UserQuotaState } from "../lib/types.ts";

const account = {
  id: "ta",
  feishuUserId: "u",
  tokenRequestId: "tr",
  keyHash: "h",
  status: "active",
  billingPeriod: "2026-07",
  operationGeneration: 2,
  createdAt: "2026-07-01T00:00:00.000Z",
} satisfies TokenAccount;

test("admission requires an open state and the active token generation", () => {
  const open = {
    feishuUserId: "u",
    admission: "open",
    activeGeneration: 2,
    updatedAt: "2026-07-01T00:00:00.000Z",
  } satisfies UserQuotaState;
  assert.doesNotThrow(() => assertQuotaAdmission(open, account));
  assert.throws(
    () => assertQuotaAdmission({ ...open, admission: "closed", operationId: "qo" }, account),
    QuotaAdmissionClosedError,
  );
  assert.throws(
    () => assertQuotaAdmission({ ...open, activeGeneration: 3 }, account),
    StaleTokenGenerationError,
  );
});
