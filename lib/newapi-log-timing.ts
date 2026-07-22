export function reliableNewApiFirstByteMs(input: {
  isStream?: boolean;
  firstResponseTimeMs?: number;
  durationMs: number;
}) {
  const first = input.firstResponseTimeMs;
  if (
    input.isStream !== true ||
    first === undefined ||
    !Number.isFinite(first) ||
    first < 0 ||
    !Number.isFinite(input.durationMs) ||
    input.durationMs <= 0 ||
    first >= input.durationMs
  ) {
    return undefined;
  }
  return Math.round(first);
}

export function newApiLogHttpStatus(input: {
  logType?: string;
  statusCode?: number;
}) {
  if (input.logType !== "5") return 200;
  const statusCode = Math.trunc(input.statusCode ?? 500);
  return statusCode >= 400 && statusCode <= 599 ? statusCode : 500;
}

export function newApiLogMetadata(other: unknown) {
  let value = other;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      value = undefined;
    }
  }
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const numberValue = (candidate: unknown) => {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate !== "string" || !candidate.trim()) return undefined;
    const parsed = Number(candidate);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return {
    requestPath:
      typeof record?.request_path === "string" && record.request_path.trim()
        ? record.request_path.trim()
        : undefined,
    firstResponseTimeMs: numberValue(record?.frt),
    statusCode: numberValue(record?.status_code),
  };
}
