import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProxyErrorResponse,
  buildProxyStreamErrorChunk,
  retryableUpstreamStatus,
  upstreamRetryAfterSeconds,
} from "../lib/proxy-error.ts";

test("retryable proxy errors expose reason and retry metadata in headers and body", async () => {
  const response = buildProxyErrorResponse({
    status: 503,
    message: "TokenInside 当前请求过多，请在 3 秒后重试",
    code: "gateway_overloaded",
    requestId: "req_test",
    retryable: true,
    retryAfterSeconds: 3,
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "3");
  assert.equal(response.headers.get("x-tokeninside-request-id"), "req_test");
  const body = await response.json();
  assert.deepEqual(body, {
    error: {
      message: "TokenInside 当前请求过多，请在 3 秒后重试",
      type: "tokeninside_error",
      code: "gateway_overloaded",
      retryable: true,
      retry_after_seconds: 3,
      request_id: "req_test",
    },
    retryable: true,
    retry_after_seconds: 3,
    request_id: "req_test",
  });
});

test("non-retryable errors omit Retry-After and keep OpenAI-compatible error fields", async () => {
  const response = buildProxyErrorResponse({
    status: 403,
    message: "当前 Key 不可用",
    code: "inactive_key",
    requestId: "req_forbidden",
  });
  assert.equal(response.headers.get("retry-after"), null);
  const body = await response.json();
  assert.equal(body.error.message, "当前 Key 不可用");
  assert.equal(body.error.code, "inactive_key");
  assert.equal(body.error.retryable, false);
});

test("upstream retry policy preserves explicit retry seconds", () => {
  assert.equal(retryableUpstreamStatus(429), true);
  assert.equal(retryableUpstreamStatus(400), false);
  assert.equal(upstreamRetryAfterSeconds(new Response(null, { headers: { "Retry-After": "7" } })), 7);
});

test("stream failures carry the same readable retry contract in an SSE error event", () => {
  const chunk = buildProxyStreamErrorChunk({
    status: 502,
    message: "流式上游连接中断，请在 2 秒后重试",
    code: "upstream_stream_interrupted",
    requestId: "req_stream",
    retryable: true,
    retryAfterSeconds: 2,
  });
  const text = new TextDecoder().decode(chunk);
  assert.match(text, /^event: error\ndata: /);
  assert.match(text, /"code":"upstream_stream_interrupted"/);
  assert.match(text, /"retry_after_seconds":2/);
  assert.match(text, /"request_id":"req_stream"/);
});
