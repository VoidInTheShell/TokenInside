import type { ProxyRequestLog } from "@/lib/types";

const usageRecordPaths = new Set([
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/messages",
]);

export function isUsageRecordRequest(
  request: Pick<ProxyRequestLog, "method" | "requestPath">,
) {
  const pathname = request.requestPath.split("?", 1)[0].replace(/\/+$/, "");
  return request.method.toUpperCase() === "POST" && usageRecordPaths.has(pathname);
}
