import assert from "node:assert/strict";
import test from "node:test";
import {
  tokenRequestAllowsQuotaEdit,
  tokenRequestRequiresAdminDecision,
} from "../lib/token-request-policy.ts";

test("approval handling only includes requests that need a human decision", () => {
  assert.equal(
    tokenRequestRequiresAdminDecision({
      requestType: "first_apply",
      status: "pending_card_approval",
    }),
    true,
  );
  assert.equal(
    tokenRequestRequiresAdminDecision({
      requestType: "quota_adjust",
      status: "approved_provision_failed",
    }),
    true,
  );
  assert.equal(
    tokenRequestRequiresAdminDecision({
      requestType: "key_reset",
      status: "approved_provisioning",
    }),
    false,
  );
  assert.equal(
    tokenRequestRequiresAdminDecision({
      requestType: "key_reset",
      status: "provisioned",
    }),
    false,
  );
  assert.equal(
    tokenRequestRequiresAdminDecision({
      requestType: "quota_adjust",
      status: "provisioned",
    }),
    false,
  );
});

test("key changes cannot be approved or edited from complete admin history", () => {
  const failedKeyChange = {
    requestType: "key_reset",
    status: "approved_provision_failed",
  };
  assert.equal(tokenRequestRequiresAdminDecision(failedKeyChange), false);
  assert.equal(tokenRequestAllowsQuotaEdit(failedKeyChange), false);
  assert.equal(
    tokenRequestAllowsQuotaEdit({
      requestType: "first_apply",
      status: "pending_card_approval",
    }),
    true,
  );
  assert.equal(
    tokenRequestAllowsQuotaEdit({
      requestType: "quota_adjust",
      status: "pending_card_approval",
    }),
    true,
  );
});
