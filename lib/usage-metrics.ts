export type UsageSemantic = "openai" | "anthropic";

export type UsageMetricSource = "proxy_json" | "proxy_stream" | "newapi_log";

export type UsageMetricField =
  | "promptTokens"
  | "completionTokens"
  | "totalTokens"
  | "inputTokensTotal"
  | "cacheReadTokens"
  | "cacheCreationTokens"
  | "cacheCreationTokens5m"
  | "cacheCreationTokens1h"
  | "cost"
  | "actualCost"
  | "usageSemantic";

export type UsageFieldSources = Partial<Record<UsageMetricField, UsageMetricSource>>;

export type UsageMetrics = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  inputTokensTotal?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheCreationTokens5m?: number;
  cacheCreationTokens1h?: number;
  cost?: number;
  actualCost?: number;
  usageSemantic?: UsageSemantic;
  usageFieldSources?: UsageFieldSources;
};

type ExtractUsageOptions = {
  source: UsageMetricSource;
  fallbackSemantic?: UsageSemantic;
};

const usageMetricFields: UsageMetricField[] = [
  "promptTokens",
  "completionTokens",
  "totalTokens",
  "inputTokensTotal",
  "cacheReadTokens",
  "cacheCreationTokens",
  "cacheCreationTokens5m",
  "cacheCreationTokens1h",
  "cost",
  "actualCost",
  "usageSemantic",
];

export function numberFromUsage(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseJsonText(text: string) {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function objectFromUnknown(value: unknown) {
  if (typeof value === "string") return objectValue(parseJsonText(value));
  return objectValue(value);
}

export function sumDefinedNumbers(...values: Array<number | undefined>) {
  const defined = values.filter((value): value is number => value !== undefined);
  if (!defined.length) return undefined;
  return defined.reduce((sum, value) => sum + value, 0);
}

function usageSemanticFrom(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "claude") return "anthropic" as const;
  if (normalized === "openai" || normalized === "openai_compatible") return "openai" as const;
  return undefined;
}

function withSources(metrics: UsageMetrics, source: UsageMetricSource) {
  const usageFieldSources: UsageFieldSources = {};
  for (const field of usageMetricFields) {
    if (metrics[field] !== undefined) usageFieldSources[field] = source;
  }
  return Object.keys(usageFieldSources).length ? { ...metrics, usageFieldSources } : metrics;
}

function normalizedUsageMetrics(input: {
  promptTokens?: number;
  completionTokens?: number;
  explicitTotalTokens?: number;
  explicitInputTokensTotal?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheCreationTokens5m?: number;
  cacheCreationTokens1h?: number;
  cost?: number;
  actualCost?: number;
  usageSemantic?: UsageSemantic;
}) {
  const inputTokensTotal =
    input.explicitInputTokensTotal ??
    (input.usageSemantic === "anthropic"
      ? input.promptTokens !== undefined &&
        input.cacheReadTokens !== undefined &&
        input.cacheCreationTokens !== undefined
        ? input.promptTokens + input.cacheReadTokens + input.cacheCreationTokens
        : undefined
      : input.usageSemantic === "openai"
        ? input.promptTokens
        : undefined);
  return {
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    totalTokens:
      input.explicitTotalTokens ??
      (input.promptTokens !== undefined && input.completionTokens !== undefined
        ? input.promptTokens + input.completionTokens
        : undefined),
    inputTokensTotal,
    cacheReadTokens: input.cacheReadTokens,
    cacheCreationTokens: input.cacheCreationTokens,
    cacheCreationTokens5m: input.cacheCreationTokens5m,
    cacheCreationTokens1h: input.cacheCreationTokens1h,
    cost: input.cost,
    actualCost: input.actualCost,
    usageSemantic: input.usageSemantic,
  } satisfies UsageMetrics;
}

export function extractUsageFromJson(body: unknown, options: ExtractUsageOptions): UsageMetrics {
  const root = objectValue(body);
  const usage = objectValue(root?.usage);
  if (!usage) return {};

  const promptDetails = objectValue(usage.prompt_tokens_details ?? usage.input_tokens_details);
  const cacheCreation = objectValue(usage.cache_creation);
  const promptTokens = numberFromUsage(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = numberFromUsage(usage.completion_tokens ?? usage.output_tokens);
  const cacheReadTokens = numberFromUsage(
    usage.cache_read_tokens ??
      usage.cache_read_input_tokens ??
      usage.prompt_cache_hit_tokens ??
      promptDetails?.cached_tokens,
  );
  const cacheCreationTokens5m = numberFromUsage(
    usage.cache_creation_ephemeral_5m_input_tokens ??
      cacheCreation?.ephemeral_5m_input_tokens ??
      cacheCreation?.ephemeral_5m,
  );
  const cacheCreationTokens1h = numberFromUsage(
    usage.cache_creation_ephemeral_1h_input_tokens ??
      cacheCreation?.ephemeral_1h_input_tokens ??
      cacheCreation?.ephemeral_1h,
  );
  const splitCacheCreationTokens = sumDefinedNumbers(
    cacheCreationTokens5m,
    cacheCreationTokens1h,
  );
  const directCacheCreationTokens = numberFromUsage(
    usage.cache_write_tokens ??
      usage.cache_creation_tokens ??
      usage.cache_creation_input_tokens,
  );
  const cacheCreationTokens = splitCacheCreationTokens ?? directCacheCreationTokens;
  const usageSemantic =
    usageSemanticFrom(usage.usage_semantic) ??
    (usage.cache_read_input_tokens !== undefined ||
    usage.cache_creation_input_tokens !== undefined ||
    cacheCreationTokens5m !== undefined ||
    cacheCreationTokens1h !== undefined
      ? "anthropic"
      : options.fallbackSemantic);

  return withSources(
    normalizedUsageMetrics({
      promptTokens,
      completionTokens,
      explicitTotalTokens: numberFromUsage(usage.total_tokens),
      explicitInputTokensTotal: numberFromUsage(usage.input_tokens_total),
      cacheReadTokens,
      cacheCreationTokens,
      cacheCreationTokens5m,
      cacheCreationTokens1h,
      cost: numberFromUsage(root?.cost ?? root?.total_cost ?? usage.cost ?? usage.total_cost),
      actualCost: numberFromUsage(root?.actual_cost ?? usage.actual_cost),
      usageSemantic,
    }),
    options.source,
  );
}

export function mergeUsageMetrics(target: UsageMetrics, patch: UsageMetrics) {
  for (const field of usageMetricFields) {
    const value = patch[field];
    if (value !== undefined) {
      (target as Record<UsageMetricField, unknown>)[field] = value;
    }
  }
  if (patch.usageFieldSources) {
    target.usageFieldSources = {
      ...target.usageFieldSources,
      ...patch.usageFieldSources,
    };
  }
  if (
    target.totalTokens === undefined &&
    target.promptTokens !== undefined &&
    target.completionTokens !== undefined
  ) {
    target.totalTokens = target.promptTokens + target.completionTokens;
    const source =
      target.usageFieldSources?.completionTokens ?? target.usageFieldSources?.promptTokens;
    if (source) {
      target.usageFieldSources = { ...target.usageFieldSources, totalTokens: source };
    }
  }
}

export function extractUsageFromJsonDeep(body: unknown, options: ExtractUsageOptions) {
  const metrics: UsageMetrics = {};
  const root = objectValue(body);
  const candidates = [body, root?.response, root?.message, root?.delta, root?.event];
  for (const candidate of candidates) {
    mergeUsageMetrics(metrics, extractUsageFromJson(candidate, options));
  }
  return metrics;
}

export function hasUsageMetrics(metrics: UsageMetrics) {
  return usageMetricFields.some(
    (field) => field !== "usageSemantic" && metrics[field] !== undefined,
  );
}

export function createSseUsageCollector(options: ExtractUsageOptions) {
  const decoder = new TextDecoder();
  const usage: UsageMetrics = {};
  let pendingText = "";
  let eventLines: string[] = [];

  function flushEvent() {
    if (!eventLines.length) return;
    const data = eventLines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    eventLines = [];
    if (!data || data === "[DONE]") return;
    const json = parseJsonText(data);
    if (json === undefined) return;
    mergeUsageMetrics(usage, extractUsageFromJsonDeep(json, options));
  }

  function ingest(chunk: Uint8Array) {
    pendingText += decoder.decode(chunk, { stream: true });
    const lines = pendingText.split(/\r?\n/);
    pendingText = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) flushEvent();
      else eventLines.push(line);
    }
  }

  function finish() {
    pendingText += decoder.decode();
    if (pendingText) {
      eventLines.push(pendingText);
      pendingText = "";
    }
    flushEvent();
    return usage;
  }

  return { ingest, finish };
}

export function extractUsageFromNewApiOther(input: {
  other: unknown;
  promptTokens?: number;
  completionTokens?: number;
  source?: UsageMetricSource;
}) {
  const other = objectFromUnknown(input.other);
  const cacheReadTokens = numberFromUsage(other?.cache_tokens ?? other?.cache_read_tokens);
  const cacheCreationTokens5m = numberFromUsage(
    other?.cache_creation_tokens_5m ?? other?.cache_creation_ephemeral_5m_input_tokens,
  );
  const cacheCreationTokens1h = numberFromUsage(
    other?.cache_creation_tokens_1h ?? other?.cache_creation_ephemeral_1h_input_tokens,
  );
  const splitCacheCreationTokens = sumDefinedNumbers(
    cacheCreationTokens5m,
    cacheCreationTokens1h,
  );
  const normalizedCacheWriteTokens = numberFromUsage(other?.cache_write_tokens);
  const directCacheCreationTokens = numberFromUsage(other?.cache_creation_tokens);
  const cacheCreationTokens =
    normalizedCacheWriteTokens ?? splitCacheCreationTokens ?? directCacheCreationTokens;
  const usageSemantic = usageSemanticFrom(other?.usage_semantic) ?? (other ? "openai" : undefined);

  return withSources(
    normalizedUsageMetrics({
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      explicitInputTokensTotal: numberFromUsage(other?.input_tokens_total),
      cacheReadTokens,
      cacheCreationTokens,
      cacheCreationTokens5m,
      cacheCreationTokens1h,
      usageSemantic,
    }),
    input.source ?? "newapi_log",
  );
}

export function usageSemanticFromApiFormat(apiFormat?: string): UsageSemantic | undefined {
  if (apiFormat === "claude:messages") return "anthropic";
  if (apiFormat?.startsWith("openai:")) return "openai";
  return undefined;
}

export function normalizedInputTokensTotal(input: Pick<
  UsageMetrics,
  | "promptTokens"
  | "inputTokensTotal"
  | "cacheReadTokens"
  | "cacheCreationTokens"
  | "usageSemantic"
> & { apiFormat?: string }) {
  if (input.inputTokensTotal !== undefined) return input.inputTokensTotal;
  const semantic = input.usageSemantic ?? usageSemanticFromApiFormat(input.apiFormat);
  if (semantic === "openai") return input.promptTokens;
  if (
    semantic === "anthropic" &&
    input.promptTokens !== undefined &&
    input.cacheReadTokens !== undefined &&
    input.cacheCreationTokens !== undefined
  ) {
    return input.promptTokens + input.cacheReadTokens + input.cacheCreationTokens;
  }
  return undefined;
}
