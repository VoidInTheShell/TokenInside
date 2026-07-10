import assert from "node:assert/strict";
import test from "node:test";
import {
  newApiUsageIdentityLockKeys,
  sameNewApiUsageSource,
} from "../lib/newapi-usage-identity.ts";

test("does not treat reused NewAPI log ids from different tokens as the same source", () => {
  assert.equal(
    sameNewApiUsageSource(
      { newapiLogId: "1", newapiRequestId: "request-old", newapiTokenId: "49" },
      { newapiLogId: "1", newapiRequestId: "request-current", newapiTokenId: "54" },
    ),
    false,
  );
});

test("uses request identity within a token before falling back to a log id", () => {
  assert.equal(
    sameNewApiUsageSource(
      { newapiLogId: "1", newapiRequestId: "request-a", newapiTokenId: "54" },
      { newapiLogId: "1", newapiRequestId: "request-b", newapiTokenId: "54" },
    ),
    false,
  );
  assert.equal(
    sameNewApiUsageSource(
      { newapiLogId: "1", newapiRequestId: "request-a", newapiTokenId: "54" },
      { newapiLogId: "99", newapiRequestId: "request-a", newapiTokenId: "54" },
    ),
    true,
  );
});

test("locks request and log identities in a stable order before an upsert", () => {
  assert.deepEqual(
    newApiUsageIdentityLockKeys({
      id: "nur_test",
      newapiTokenId: "54",
      newapiRequestId: "request-a",
      newapiLogId: "9",
    }),
    ["newapi_usage:54:log:9", "newapi_usage:54:request:request-a"],
  );
});
