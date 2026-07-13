import assert from "node:assert/strict";
import test from "node:test";
import {
  hasConflictingProxyMatch,
  newApiUsageIdentityLockKeys,
  sameNewApiUsageSource,
  stableNewApiUsageRecordId,
} from "../lib/newapi-usage-identity.ts";

test("an authoritative source match cannot move to a competing proxy request", () => {
  assert.equal(
    hasConflictingProxyMatch(
      { matchedProxyLogId: "proxy-a" },
      { matchedProxyLogId: "proxy-b" },
    ),
    true,
  );
  assert.equal(
    hasConflictingProxyMatch(
      { matchedProxyLogId: "proxy-a" },
      { matchedProxyLogId: "proxy-a" },
    ),
    false,
  );
});

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

test("stable record ids do not collide after sanitization or long-prefix truncation", () => {
  assert.notEqual(
    stableNewApiUsageRecordId("request:54:request/a"),
    stableNewApiUsageRecordId("request:54:request?a"),
  );
  assert.notEqual(
    stableNewApiUsageRecordId(`request:54:${"a".repeat(220)}-one`),
    stableNewApiUsageRecordId(`request:54:${"a".repeat(220)}-two`),
  );
  assert.match(stableNewApiUsageRecordId("request:54:request-a"), /^nur_[a-f0-9]{64}$/);
});
