import assert from "node:assert/strict";
import test from "node:test";
import {
  newApiLogHttpStatus,
  newApiLogMetadata,
  reliableNewApiFirstByteMs,
} from "../lib/newapi-log-timing.ts";

test("NewAPI frt is shown only for a reliable streaming first-byte boundary", () => {
  assert.equal(
    reliableNewApiFirstByteMs({
      isStream: true,
      firstResponseTimeMs: 428,
      durationMs: 2_000,
    }),
    428,
  );
  assert.equal(
    reliableNewApiFirstByteMs({
      isStream: false,
      firstResponseTimeMs: 428,
      durationMs: 2_000,
    }),
    undefined,
  );
  assert.equal(
    reliableNewApiFirstByteMs({
      isStream: true,
      firstResponseTimeMs: 2_000,
      durationMs: 2_000,
    }),
    undefined,
  );
  assert.equal(
    reliableNewApiFirstByteMs({
      isStream: true,
      firstResponseTimeMs: 2_100,
      durationMs: 2_000,
    }),
    undefined,
  );
});

test("NewAPI error logs retain their upstream HTTP status", () => {
  assert.equal(newApiLogHttpStatus({ logType: "2", statusCode: 429 }), 200);
  assert.equal(newApiLogHttpStatus({ logType: "5", statusCode: 429 }), 429);
  assert.equal(newApiLogHttpStatus({ logType: "5" }), 500);
  assert.equal(newApiLogHttpStatus({ logType: "5", statusCode: 200 }), 500);
});

test("NewAPI log metadata reads millisecond frt, request path, and error status", () => {
  assert.deepEqual(
    newApiLogMetadata(
      JSON.stringify({
        request_path: "/v1/responses",
        frt: 735,
        status_code: 429,
      }),
    ),
    {
      requestPath: "/v1/responses",
      firstResponseTimeMs: 735,
      statusCode: 429,
    },
  );
  assert.deepEqual(newApiLogMetadata("not-json"), {
    requestPath: undefined,
    firstResponseTimeMs: undefined,
    statusCode: undefined,
  });
});
