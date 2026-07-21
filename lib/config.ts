import path from "node:path";

export type RuntimeConfig = {
  publicBaseUrl: string;
  storeBackend: "json" | "postgres";
  sessionSecret?: string;
  storePath: string;
  databaseUrl?: string;
  postgres: {
    poolMax: number;
    settlementPoolMax: number;
    controlPoolMax: number;
    quotaSubmitPoolMax: number;
    quotaSubmitConnectionTimeoutMs: number;
    quotaSubmitStatementTimeoutMs: number;
    quotaSubmitLockTimeoutMs: number;
    lockPoolMax: number;
    poolIdleTimeoutMs: number;
    poolConnectionTimeoutMs: number;
  };
  proxy: {
    maxConcurrency: number;
    queueTimeoutMs: number;
    preparationMaxConcurrency: number;
    preparationQueueTimeoutMs: number;
    persistenceMaxConcurrency: number;
    upstreamMaxAttempts: number;
    upstreamRetryBaseMs: number;
    upstreamRetryMaxDelayMs: number;
  };
  feishu: {
    appId?: string;
    appSecret?: string;
    approvalCodeTokenRequest?: string;
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
  billing: {
    operationConcurrencyMax: number;
    settlementConcurrencyMax: number;
    materializationConcurrencyMax: number;
    usageSyncContinuationDelayMs: number;
    directConsumptionDrainGraceMs: number;
    balanceObservationIntervalMs: number;
    balanceObservationBatchSize: number;
    balanceObservationReadTimeoutMs: number;
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
      // The settlement pool is carved out of the historical ten-connection
      // default rather than added on top of it. This keeps the single-process
      // PostgreSQL budget stable while preventing proxy preparation and
      // persistence from starving authoritative usage writes.
      poolMax: positiveIntegerFromEnv(process.env.DATABASE_POOL_MAX, 8),
      settlementPoolMax: positiveIntegerFromEnv(
        process.env.DATABASE_SETTLEMENT_POOL_MAX,
        2,
      ),
      controlPoolMax: positiveIntegerFromEnv(process.env.DATABASE_CONTROL_POOL_MAX, 4),
      quotaSubmitPoolMax: positiveIntegerFromEnv(
        process.env.DATABASE_QUOTA_SUBMIT_POOL_MAX,
        2,
      ),
      quotaSubmitConnectionTimeoutMs: positiveIntegerFromEnv(
        process.env.DATABASE_QUOTA_SUBMIT_CONNECTION_TIMEOUT_MS,
        1000,
      ),
      quotaSubmitStatementTimeoutMs: positiveIntegerFromEnv(
        process.env.DATABASE_QUOTA_SUBMIT_STATEMENT_TIMEOUT_MS,
        3000,
      ),
      quotaSubmitLockTimeoutMs: positiveIntegerFromEnv(
        process.env.DATABASE_QUOTA_SUBMIT_LOCK_TIMEOUT_MS,
        1000,
      ),
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
    proxy: {
      maxConcurrency: positiveIntegerFromEnv(
        process.env.TOKENINSIDE_PROXY_CONCURRENCY_MAX,
        480,
      ),
      queueTimeoutMs: positiveIntegerFromEnv(
        process.env.TOKENINSIDE_PROXY_QUEUE_TIMEOUT_MS,
        30000,
      ),
      preparationMaxConcurrency: positiveIntegerFromEnv(
        process.env.TOKENINSIDE_PROXY_PREPARATION_CONCURRENCY_MAX,
        8,
      ),
      preparationQueueTimeoutMs: positiveIntegerFromEnv(
        process.env.TOKENINSIDE_PROXY_PREPARATION_QUEUE_TIMEOUT_MS,
        30000,
      ),
      persistenceMaxConcurrency: positiveIntegerFromEnv(
        process.env.TOKENINSIDE_PROXY_PERSISTENCE_CONCURRENCY_MAX,
        8,
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
      approvalCodeTokenRequest: process.env.FEISHU_APPROVAL_CODE_TOKEN_REQUEST,
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
      requestTimeoutMs: positiveIntegerFromEnv(process.env.NEWAPI_REQUEST_TIMEOUT_MS, 15000),
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
    billing: {
      operationConcurrencyMax: positiveIntegerFromEnv(
        process.env.TOKENINSIDE_QUOTA_OPERATION_CONCURRENCY_MAX,
        1,
      ),
      settlementConcurrencyMax: positiveIntegerFromEnv(
        process.env.TOKENINSIDE_USAGE_SETTLEMENT_CONCURRENCY_MAX,
        16,
      ),
      materializationConcurrencyMax: positiveIntegerFromEnv(
        process.env.TOKENINSIDE_BILLING_MATERIALIZATION_CONCURRENCY_MAX,
        4,
      ),
      usageSyncContinuationDelayMs: positiveIntegerFromEnv(
        process.env.TOKENINSIDE_USAGE_SYNC_CONTINUATION_DELAY_MS,
        250,
      ),
      directConsumptionDrainGraceMs: positiveIntegerFromEnv(
        process.env.TOKENINSIDE_DIRECT_CONSUMPTION_DRAIN_GRACE_MS,
        60_000,
      ),
      // Balance observation is deliberately slower and smaller than the
      // settlement loop. It uses the isolated control/lock pools and can never
      // turn an environment value into an unbounded account scan.
      balanceObservationIntervalMs: Math.max(
        positiveIntegerFromEnv(
          process.env.TOKENINSIDE_BALANCE_OBSERVATION_INTERVAL_MS,
          300_000,
        ),
        60_000,
      ),
      balanceObservationBatchSize: Math.min(
        positiveIntegerFromEnv(
          process.env.TOKENINSIDE_BALANCE_OBSERVATION_BATCH_SIZE,
          20,
        ),
        20,
      ),
      balanceObservationReadTimeoutMs: positiveIntegerFromEnv(
        process.env.TOKENINSIDE_BALANCE_OBSERVATION_READ_TIMEOUT_MS,
        3_000,
      ),
    },
  };
}

export function effectiveBillingMaterializationConcurrencyMax(
  config: Pick<RuntimeConfig, "storeBackend" | "postgres" | "billing"> = getConfig(),
) {
  const configuredMax = Math.max(
    Math.trunc(config.billing.materializationConcurrencyMax),
    1,
  );
  if (config.storeBackend !== "postgres") return configuredMax;

  // PostgreSQL materialization shares the settlement pool with authoritative
  // source/checkpoint writes. Leave one connection available whenever the pool
  // has that capacity; the floor of one keeps derived work progressing for an
  // explicitly configured single-connection pool.
  const materializationPoolCapacity = Math.max(
    Math.trunc(config.postgres.settlementPoolMax) - 1,
    1,
  );
  return Math.min(configuredMax, materializationPoolCapacity);
}

export function requireSessionSecret() {
  const secret = getConfig().sessionSecret;
  if (!secret) {
    throw new Error("TOKENINSIDE_SESSION_SECRET is required for Feishu session cookies");
  }
  return secret;
}
