import assert from "node:assert/strict";
import test from "node:test";
import {
  createSseUsageCollector,
  extractUsageFromJson,
  extractUsageFromNewApiOther,
  normalizedInputTokensTotal,
} from "../lib/usage-metrics.ts";

test("normalizes OpenAI cached input without double-counting it", () => {
  const metrics = extractUsageFromJson(
    {
      usage: {
        prompt_tokens: 19_209,
        completion_tokens: 11,
        total_tokens: 19_220,
        prompt_tokens_details: { cached_tokens: 19_200 },
      },
    },
    { source: "proxy_json", fallbackSemantic: "openai" },
  );

  assert.equal(metrics.promptTokens, 19_209);
  assert.equal(metrics.inputTokensTotal, 19_209);
  assert.equal(metrics.cacheReadTokens, 19_200);
  assert.equal(metrics.totalTokens, 19_220);
  assert.equal(metrics.usageSemantic, "openai");
  assert.equal(metrics.usageFieldSources?.cacheReadTokens, "proxy_json");
});

test("preserves explicit zero cache values instead of treating them as missing", () => {
  const metrics = extractUsageFromJson(
    {
      usage: {
        input_tokens: 14,
        output_tokens: 6,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    { source: "proxy_json", fallbackSemantic: "anthropic" },
  );

  assert.equal(metrics.cacheReadTokens, 0);
  assert.equal(metrics.cacheCreationTokens, 0);
  assert.equal(metrics.inputTokensTotal, 14);
});

test("normalizes Anthropic cache writes and uses separate-input semantics", () => {
  const metrics = extractUsageFromJson(
    {
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 200,
        cache_creation: {
          ephemeral_5m_input_tokens: 30,
          ephemeral_1h_input_tokens: 20,
        },
      },
    },
    { source: "proxy_json", fallbackSemantic: "anthropic" },
  );

  assert.equal(metrics.cacheCreationTokens5m, 30);
  assert.equal(metrics.cacheCreationTokens1h, 20);
  assert.equal(metrics.cacheCreationTokens, 50);
  assert.equal(metrics.inputTokensTotal, 350);
  assert.equal(metrics.totalTokens, 120);
  assert.equal(metrics.usageSemantic, "anthropic");
});

test("collects split Claude SSE usage into one complete record", () => {
  const collector = createSseUsageCollector({
    source: "proxy_stream",
    fallbackSemantic: "anthropic",
  });
  collector.ingest(
    new TextEncoder().encode(
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":100,"cache_read_input_tokens":200,"cache_creation_input_tokens":50}}}\n\n',
    ),
  );
  collector.ingest(
    new TextEncoder().encode(
      'event: message_delta\ndata: {"usage":{"output_tokens":20}}\n\nevent: done\ndata: [DONE]\n\n',
    ),
  );
  const metrics = collector.finish();

  assert.equal(metrics.promptTokens, 100);
  assert.equal(metrics.completionTokens, 20);
  assert.equal(metrics.totalTokens, 120);
  assert.equal(metrics.inputTokensTotal, 350);
  assert.equal(metrics.cacheReadTokens, 200);
  assert.equal(metrics.cacheCreationTokens, 50);
});

test("collects nested OpenAI Responses SSE usage and ignores malformed events", () => {
  const collector = createSseUsageCollector({
    source: "proxy_stream",
    fallbackSemantic: "openai",
  });
  collector.ingest(new TextEncoder().encode("data: {not-json}\n\n"));
  collector.ingest(
    new TextEncoder().encode(
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":100,"output_tokens":10,"input_tokens_details":{"cached_tokens":80}}}}\n\n',
    ),
  );
  const metrics = collector.finish();

  assert.equal(metrics.promptTokens, 100);
  assert.equal(metrics.completionTokens, 10);
  assert.equal(metrics.totalTokens, 110);
  assert.equal(metrics.inputTokensTotal, 100);
  assert.equal(metrics.cacheReadTokens, 80);
  assert.equal(metrics.usageFieldSources?.cacheReadTokens, "proxy_stream");
});

test("reads cache metadata from a NewAPI other object or JSON string", () => {
  const metrics = extractUsageFromNewApiOther({
    promptTokens: 100,
    completionTokens: 20,
    other: JSON.stringify({
      cache_tokens: 200,
      cache_creation_tokens: 99,
      cache_creation_tokens_5m: 30,
      cache_creation_tokens_1h: 20,
      cache_write_tokens: 50,
      input_tokens_total: 350,
      usage_semantic: "anthropic",
    }),
  });

  assert.equal(metrics.cacheReadTokens, 200);
  assert.equal(metrics.cacheCreationTokens, 50);
  assert.equal(metrics.cacheCreationTokens5m, 30);
  assert.equal(metrics.cacheCreationTokens1h, 20);
  assert.equal(metrics.inputTokensTotal, 350);
  assert.equal(metrics.usageSemantic, "anthropic");
  assert.equal(metrics.usageFieldSources?.cacheCreationTokens, "newapi_log");
});

test("reproduces the live OpenAI cache hit rate baseline at 49.98 percent", () => {
  const cachedReads = [0, 19_200, 0, 0, 19_200, 19_200, 19_200, 0];
  const totals = cachedReads.map((cacheReadTokens) =>
    normalizedInputTokensTotal({
      promptTokens: 19_209,
      cacheReadTokens,
      cacheCreationTokens: 0,
      usageSemantic: "openai",
    }),
  );
  const inputTotal = totals.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const cacheReadTotal = cachedReads.reduce((sum, value) => sum + value, 0);

  assert.equal(inputTotal, 153_672);
  assert.equal(cacheReadTotal, 76_800);
  assert.equal((cacheReadTotal / inputTotal * 100).toFixed(2), "49.98");
});

test("does not invent an input denominator when usage semantics are unknown", () => {
  assert.equal(
    normalizedInputTokensTotal({
      promptTokens: 100,
      cacheReadTokens: 20,
      cacheCreationTokens: 0,
    }),
    undefined,
  );
});
