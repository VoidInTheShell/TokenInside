import assert from "node:assert/strict";
import test from "node:test";
import { findProxyLogForNewApiUsage } from "../lib/usage-matching.ts";
import type { NormalizedNewApiUsageLog } from "../lib/newapi.ts";
import type { ProxyRequestLog, TokenAccount } from "../lib/types.ts";

const account: TokenAccount = {
  id: "ta_test",
  feishuUserId: "fu_test",
  tokenRequestId: "tr_test",
  newapiTokenId: "54",
  keyHash: "hash",
  status: "active",
  billingPeriod: "2026-07",
  createdAt: "2026-07-10T06:00:00.000Z",
};

function proxy(overrides: Partial<ProxyRequestLog>): ProxyRequestLog {
  return {
    id: "pl_default",
    feishuUserId: account.feishuUserId,
    tokenAccountId: account.id,
    requestPath: "/v1/chat/completions",
    method: "POST",
    status: "completed",
    statusCode: 200,
    durationMs: 5_000,
    firstByteMs: 4_000,
    responseTimeUpdatedAt: "2026-07-10T06:00:05.000Z",
    model: "deepseek/deepseek-v3.2",
    providerKeyName: "54",
    isStream: false,
    usageSource: "proxy_json",
    promptTokens: 13,
    completionTokens: 5,
    totalTokens: 18,
    createdAt: "2026-07-10T06:00:00.000Z",
    ...overrides,
  };
}

function usage(overrides: Partial<NormalizedNewApiUsageLog>): NormalizedNewApiUsageLog {
  return {
    newapiLogId: "1",
    newapiRequestId: "newapi-log-request-id",
    newapiTokenId: "54",
    createdAt: "2026-07-10T06:00:05.000Z",
    model: "deepseek/deepseek-v3.2",
    promptTokens: 13,
    completionTokens: 5,
    totalTokens: 18,
    quota: 9,
    cost: 0.000018,
    isStream: false,
    ...overrides,
  };
}

test("matches a successful non-stream proxy by exact usage when request ids differ", () => {
  const failed = proxy({
    id: "pl_failed",
    status: "failed",
    statusCode: 502,
    usageSource: "missing",
    promptTokens: undefined,
    completionTokens: undefined,
    totalTokens: undefined,
  });
  const correct = proxy({ id: "pl_correct", newapiRequestId: "response-header-id" });

  const matched = findProxyLogForNewApiUsage({
    proxyLogs: [failed, correct],
    usageLog: usage({ newapiRequestId: "different-log-id" }),
    account,
    matchWindowMs: 30 * 60 * 1000,
  });

  assert.equal(matched?.id, "pl_correct");
});

test("matches the response header id against NewAPI upstream_request_id", () => {
  const exact = proxy({
    id: "pl_upstream_id",
    newapiResponseRequestId: "upstream-response-id",
    promptTokens: undefined,
    completionTokens: undefined,
    totalTokens: undefined,
    usageSource: "missing",
  });
  const matched = findProxyLogForNewApiUsage({
    proxyLogs: [exact],
    usageLog: usage({
      newapiRequestId: "newapi-log-request-id",
      newapiUpstreamRequestId: "upstream-response-id",
      promptTokens: 18,
      completionTokens: 10,
      totalTokens: 28,
    }),
    account,
    matchWindowMs: 30 * 60 * 1000,
  });

  assert.equal(matched?.id, exact.id);
});

test("does not attach a direct NewAPI non-stream request to a proxy with different usage", () => {
  const matched = findProxyLogForNewApiUsage({
    proxyLogs: [proxy({ id: "pl_other" })],
    usageLog: usage({ promptTokens: 18, completionTokens: 10, totalTokens: 28, quota: 14 }),
    account,
    matchWindowMs: 30 * 60 * 1000,
  });

  assert.equal(matched, undefined);
});

test("uses response completion time to repair incomplete streaming usage", () => {
  const messages = proxy({
    id: "pl_messages_stream",
    requestPath: "/v1/messages",
    isStream: true,
    usageSource: "proxy_stream",
    promptTokens: 13,
    completionTokens: 0,
    totalTokens: 13,
    createdAt: "2026-07-10T06:00:00.000Z",
    responseTimeUpdatedAt: "2026-07-10T06:02:00.000Z",
  });

  const matched = findProxyLogForNewApiUsage({
    proxyLogs: [messages],
    usageLog: usage({
      createdAt: "2026-07-10T06:02:01.000Z",
      isStream: true,
      promptTokens: 16,
      completionTokens: 8,
      totalTokens: 24,
    }),
    account,
    matchWindowMs: 30 * 60 * 1000,
  });

  assert.equal(matched?.id, "pl_messages_stream");
});

test("prevents one proxy log from being assigned to multiple NewAPI logs", () => {
  const onlyProxy = proxy({ id: "pl_reserved" });
  const matched = findProxyLogForNewApiUsage({
    proxyLogs: [onlyProxy],
    usageLog: usage({ newapiLogId: "second" }),
    account,
    matchWindowMs: 30 * 60 * 1000,
    reservedProxyLogIds: new Set([onlyProxy.id]),
  });

  assert.equal(matched, undefined);
});

test("keeps an already settled request matched when list queries renumber the log id", () => {
  const settled = proxy({
    id: "pl_settled",
    newapiLogId: "1",
    newapiRequestId: "stable-request-id",
    usageSource: "newapi_log",
  });
  const matched = findProxyLogForNewApiUsage({
    proxyLogs: [settled],
    usageLog: usage({ newapiLogId: "15", newapiRequestId: "stable-request-id" }),
    account,
    matchWindowMs: 30 * 60 * 1000,
    reservedProxyLogIds: new Set([settled.id]),
    allowReservedProxyLogId: settled.id,
  });

  assert.equal(matched?.id, settled.id);
});

test("reconciles the seven-log production shape one-to-one and leaves the direct call unmatched", () => {
  const proxyLogs = [
    proxy({
      id: "pl_chat_nonstream",
      newapiRequestId: "header-chat",
      promptTokens: 13,
      completionTokens: 5,
      totalTokens: 18,
      responseTimeUpdatedAt: "2026-07-10T06:06:26.000Z",
    }),
    proxy({
      id: "pl_failed_responses",
      requestPath: "/v1/responses",
      status: "failed",
      statusCode: 502,
      usageSource: "missing",
      promptTokens: undefined,
      completionTokens: undefined,
      totalTokens: undefined,
      responseTimeUpdatedAt: "2026-07-10T06:11:28.000Z",
    }),
    proxy({
      id: "pl_chat_stream",
      isStream: true,
      usageSource: "proxy_stream",
      promptTokens: 15,
      completionTokens: 7,
      totalTokens: 22,
      responseTimeUpdatedAt: "2026-07-10T06:13:15.000Z",
    }),
    proxy({
      id: "pl_responses_nonstream",
      requestPath: "/v1/responses",
      promptTokens: 15,
      completionTokens: 7,
      totalTokens: 22,
      responseTimeUpdatedAt: "2026-07-10T06:13:51.000Z",
    }),
    proxy({
      id: "pl_responses_stream",
      requestPath: "/v1/responses",
      isStream: true,
      usageSource: "proxy_stream",
      promptTokens: 17,
      completionTokens: 9,
      totalTokens: 26,
      responseTimeUpdatedAt: "2026-07-10T06:14:54.000Z",
    }),
    proxy({
      id: "pl_messages_nonstream",
      requestPath: "/v1/messages",
      promptTokens: 14,
      completionTokens: 6,
      totalTokens: 20,
      responseTimeUpdatedAt: "2026-07-10T06:15:13.000Z",
    }),
    proxy({
      id: "pl_messages_stream",
      requestPath: "/v1/messages",
      isStream: true,
      usageSource: "proxy_stream",
      promptTokens: 13,
      completionTokens: 0,
      totalTokens: 13,
      responseTimeUpdatedAt: "2026-07-10T06:15:58.000Z",
    }),
  ];
  const usageLogs = [
    usage({ newapiLogId: "1", createdAt: "2026-07-10T06:15:57.000Z", isStream: true, promptTokens: 16, completionTokens: 8, totalTokens: 24 }),
    usage({ newapiLogId: "2", createdAt: "2026-07-10T06:15:13.000Z", promptTokens: 14, completionTokens: 6, totalTokens: 20 }),
    usage({ newapiLogId: "3", createdAt: "2026-07-10T06:14:54.000Z", isStream: true, promptTokens: 17, completionTokens: 9, totalTokens: 26 }),
    usage({ newapiLogId: "4", createdAt: "2026-07-10T06:13:51.000Z", promptTokens: 15, completionTokens: 7, totalTokens: 22 }),
    usage({ newapiLogId: "5", createdAt: "2026-07-10T06:13:15.000Z", isStream: true, promptTokens: 15, completionTokens: 7, totalTokens: 22 }),
    usage({ newapiLogId: "6", createdAt: "2026-07-10T06:12:24.000Z", promptTokens: 18, completionTokens: 10, totalTokens: 28 }),
    usage({ newapiLogId: "7", createdAt: "2026-07-10T06:06:25.000Z", promptTokens: 13, completionTokens: 5, totalTokens: 18 }),
  ];
  const expected = new Map([
    ["1", "pl_messages_stream"],
    ["2", "pl_messages_nonstream"],
    ["3", "pl_responses_stream"],
    ["4", "pl_responses_nonstream"],
    ["5", "pl_chat_stream"],
    ["6", undefined],
    ["7", "pl_chat_nonstream"],
  ]);
  const reserved = new Set<string>();

  for (const usageLog of usageLogs) {
    const matched = findProxyLogForNewApiUsage({
      proxyLogs,
      usageLog,
      account,
      matchWindowMs: 30 * 60 * 1000,
      reservedProxyLogIds: reserved,
    });
    assert.equal(matched?.id, expected.get(usageLog.newapiLogId ?? ""));
    if (matched) reserved.add(matched.id);
  }

  assert.equal(reserved.size, 6);
  assert.equal(reserved.has("pl_failed_responses"), false);
});
