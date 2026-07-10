import assert from "node:assert/strict";
import test from "node:test";
import { isUsageRecordRequest } from "../lib/usage-record-visibility.ts";

test("usage records include supported generation requests", () => {
  assert.equal(
    isUsageRecordRequest({ method: "POST", requestPath: "/v1/chat/completions" }),
    true,
  );
  assert.equal(
    isUsageRecordRequest({ method: "post", requestPath: "/v1/responses" }),
    true,
  );
  assert.equal(
    isUsageRecordRequest({ method: "POST", requestPath: "/v1/messages?beta=true" }),
    true,
  );
});

test("usage records exclude model discovery and non-generation requests", () => {
  assert.equal(
    isUsageRecordRequest({ method: "GET", requestPath: "/v1/models" }),
    false,
  );
  assert.equal(
    isUsageRecordRequest({ method: "POST", requestPath: "/v1/models" }),
    false,
  );
  assert.equal(
    isUsageRecordRequest({ method: "GET", requestPath: "/v1/chat/completions" }),
    false,
  );
});
