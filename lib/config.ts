import path from "node:path";

export type RuntimeConfig = {
  publicBaseUrl: string;
  storeBackend: "json" | "postgres";
  sessionSecret?: string;
  storePath: string;
  databaseUrl?: string;
  postgres: {
    poolMax: number;
    lockPoolMax: number;
    poolIdleTimeoutMs: number;
    poolConnectionTimeoutMs: number;
  };
  redis: {
    url?: string;
    required: boolean;
    keyPrefix: string;
    principalTtlSeconds: number;
    connectTimeoutMs: number;
  };
  proxy: {
    maxConcurrency: number;
    queueMax: number;
    queueTimeoutMs: number;
    preparationMaxConcurrency: number;
    preparationQueueMax: number;
    preparationQueueTimeoutMs: number;
    upstreamMaxAttempts: number;
    upstreamRetryBaseMs: number;
    upstreamRetryMaxDelayMs: number;
  };
  feishu: {
    appId?: string;
    appSecret?: string;
    eventEncryptKey?: string;
    eventVerificationToken?: string;
  };
  newapi: {
    baseUrl: string;
    controlUserId?: string;
    accessToken?: string;
    adminAccessToken?: string;
    systemAk?: string;
    quotaPerUnit: number;
    requestTimeoutMs: number;
    mock: boolean;
  };
  admin: {
    systemAdminOpenIds: string[];
    globalOpenIds: string[];
  };
};

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function positiveIntegerFromEnv(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function nonNegativeIntegerFromEnv(value: string | undefined, fallback: number) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

function storeBackendFromEnv(value: string | undefined): RuntimeConfig["storeBackend"] {
  return value === "postgres" ? "postgres" : "json";
}

function csvFromEnv(...values: Array<string | undefined>) {
  return [
    ...new Set(
      values
        .flatMap((value) => (value ?? "").split(","))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function getConfig(): RuntimeConfig {
  const publicBaseUrl =
    process.env.TOKENINSIDE_PUBLIC_BASE_URL ?? "http://127.0.0.1:16878";

  return {
    publicBaseUrl: trimSlash(publicBaseUrl),
    storeBackend: storeBackendFromEnv(process.env.TOKENINSIDE_STORE_BACKEND),
    sessionSecret: process.env.TOKENINSIDE_SESSION_SECRET,
    storePath: path.resolve(
      /* turbopackIgnore: true */ process.cwd(),
      process.env.TOKENINSIDE_STORE_PATH ?? ".local-data/tokeninside.json",
    ),
    databaseUrl: process.env.DATABASE_URL,
    postgres: {
      poolMax: positiveIntegerFromEnv(process.env.DATABASE_POOL_MAX, 10),
      lockPoolMax: positiveIntegerFromEnv(process.env.DATABASE_LOCK_POOL_MAX, 10),
      poolIdleTimeoutMs: positiveIntegerFromEnv(
        process.env.DATABASE_POOL_IDLE_TIMEOUT_MS,
        30000,
      ),
      poolConnectionTimeoutMs: positiveIntegerFromEnv(
        process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
        5000,
      ),
    },
    redis: {
      url: process.env.TOKENINSIDE_REDIS_URL,
      required: process.env.TOKENINSIDE_REDIS_REQUIRED === "true",
      keyPrefix: process.env.TOKENINSIDE_REDIS_KEY_PREFIX?.trim() || "tokeninside",
      principalTtlSeconds: positiveIntegerFromEnv(
        process.env.TOKENINSIDE_REDIS_PRINCIPAL_TTL_SECONDS,
        300,
      ),
      connectTimeoutMs: positiveIntegerFromEnv(
        process.env.TOKENINSIDE_REDIS_CONNECT_TIMEOUT_MS,
        1000,
      ),
    },
    proxy: {
      maxConcurrency: positiveIntegerFromEnv(
        process.env.TOKENINSIDE_PROXY_CONCURRENCY_MAX,
        480,
      ),
      queueMax: nonNegativeIntegerFromEnv(
        process.env.TOKENINSIDE_PROXY_QUEUE_MAX,
        0,
      ),
      queueTimeoutMs: positiveIntegerFromEnv(
        process.env.TOKENINSIDE_PROXY_QUEUE_TIMEOUT_MS,
        30000,
      ),
      preparationMaxConcurrency: positiveIntegerFromEnv(
        process.env.TOKENINSIDE_PROXY_PREPARATION_CONCURRENCY_MAX,
        8,
      ),
      preparationQueueMax: nonNegativeIntegerFromEnv(
        process.env.TOKENINSIDE_PROXY_PREPARATION_QUEUE_MAX,
        0,
      ),
      preparationQueueTimeoutMs: positiveIntegerFromEnv(
        process.env.TOKENINSIDE_PROXY_PREPARATION_QUEUE_TIMEOUT_MS,
        30000,
      ),
      upstreamMaxAttempts: positiveIntegerFromEnv(
        process.env.TOKENINSIDE_PROXY_UPSTREAM_MAX_ATTEMPTS,
        2,
      ),
      upstreamRetryBaseMs: positiveIntegerFromEnv(
        process.env.TOKENINSIDE_PROXY_UPSTREAM_RETRY_BASE_MS,
        250,
      ),
      upstreamRetryMaxDelayMs: positiveIntegerFromEnv(
        process.env.TOKENINSIDE_PROXY_UPSTREAM_RETRY_MAX_DELAY_MS,
        2000,
      ),
    },
    feishu: {
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      eventEncryptKey: process.env.FEISHU_APPROVAL_EVENT_ENCRYPT_KEY,
      eventVerificationToken: process.env.FEISHU_APPROVAL_EVENT_VERIFICATION_TOKEN,
    },
    newapi: {
      baseUrl: trimSlash(process.env.NEWAPI_BASE_URL ?? "https://new-api.550w.link"),
      controlUserId: process.env.NEWAPI_CONTROL_USER_ID,
      accessToken: process.env.NEWAPI_ACCESS_TOKEN,
      adminAccessToken: process.env.NEWAPI_ADMIN_ACCESS_TOKEN,
      systemAk: process.env.NEWAPI_SYSTEM_AK,
      quotaPerUnit: positiveIntegerFromEnv(process.env.NEWAPI_QUOTA_PER_UNIT, 500000),
      requestTimeoutMs: positiveIntegerFromEnv(process.env.NEWAPI_REQUEST_TIMEOUT_MS, 90000),
      mock: process.env.TOKENINSIDE_MOCK_NEWAPI === "true",
    },
    admin: {
      systemAdminOpenIds: csvFromEnv(
        process.env.TOKENINSIDE_SYSTEM_ADMIN_OPEN_IDS,
        process.env.TOKENINSIDE_ADMIN_OPEN_IDS,
      ),
      globalOpenIds: csvFromEnv(
        process.env.TOKENINSIDE_SYSTEM_ADMIN_OPEN_IDS,
        process.env.TOKENINSIDE_ADMIN_OPEN_IDS,
      ),
    },
  };
}

export function requireSessionSecret() {
  const secret = getConfig().sessionSecret;
  if (!secret) {
    throw new Error("TOKENINSIDE_SESSION_SECRET is required for Feishu session cookies");
  }
  return secret;
}
