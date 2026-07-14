import { createServer } from "node:http";

const host = process.env.G_STAGE_UPSTREAM_HOST ?? "0.0.0.0";
const port = Number(process.env.G_STAGE_UPSTREAM_PORT ?? "13002");
const model = "g-stage-deterministic";

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function fixtureIndex(body) {
  const content = body?.messages?.map((item) => item?.content).join(" ") ?? "";
  const match = content.match(/fixture\s+(\d+)/i);
  return Number(match?.[1] ?? 0);
}

function mix32(value) {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function timings(index) {
  const pairIndex = Math.floor(index / 2);
  const tailPosition = mix32(Math.floor(pairIndex / 20) + 0x51f15e) % 20;
  const normalTtft = pairIndex % 20 !== tailPosition;
  const ttftState = mix32(index + 0x9e3779b9);
  const ttftMs = normalTtft
    ? 500 + (ttftState % 2501)
    : 3001 + (ttftState % 1500);
  const totalMs = 5_000 + (mix32(index + 0x243f6a88) % 55_001);
  return { ttftMs, totalMs: Math.max(totalMs, ttftMs + 100) };
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/v1/models") {
    json(response, 200, { object: "list", data: [{ id: model, object: "model", owned_by: "tokeninside-g-stage" }] });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    json(response, 404, { error: { message: "not found", type: "invalid_request_error" } });
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      json(response, 400, { error: { message: "invalid json", type: "invalid_request_error" } });
      return;
    }
    const index = fixtureIndex(body);
    const { ttftMs, totalMs } = timings(index);
    const id = `chatcmpl-g-stage-${index}`;
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if (body.stream === true) {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      setTimeout(() => {
        response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
      }, ttftMs);
      setTimeout(() => {
        response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }] })}\n\n`);
      }, ttftMs + 25);
      setTimeout(() => {
        response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [], usage })}\n\n`);
        response.end("data: [DONE]\n\n");
      }, totalMs);
      return;
    }
    setTimeout(() => {
      json(response, 200, {
        id,
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage,
      });
    }, totalMs);
  });
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ status: "ready", service: "g-stage-deterministic-upstream", host, port, model }));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
