import path from "node:path";

export type RuntimeConfig = {
  publicBaseUrl: string;
  storeBackend: "json" | "postgres";
  sessionSecret?: string;
  storePath: string;
  databaseUrl?: string;
  postgres: {
    poolMax: number;
    controlPoolMax: number;
    quotaSubmitPoolMax: number;
    quotaSubmitConnectionTimeoutMs: number;
    quotaSubmitStatementTimeoutMs: number;
    quotaSubmitLockTimeoutMs: number;
    lockPoolMax: number;
    poolIdleTimeoutMs: number;
    poolConnectionTimeoutMs: number;
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
    publicBaseUrl: string;
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
  };
  quotaControl: {
    operationConcurrencyMax: number;
    directConsumptionDrainGraceMs: number;
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
      poolMax: positiveIntegerFromEnv(process.env.DATABASE_POOL_MAX, 8),
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
    feishu: {
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      approvalCodeTokenRequest: process.env.FEISHU_APPROVAL_CODE_TOKEN_REQUEST,
      eventEncryptKey: process.env.FEISHU_APPROVAL_EVENT_ENCRYPT_KEY,
      eventVerificationToken: process.env.FEISHU_APPROVAL_EVENT_VERIFICATION_TOKEN,
    },
    newapi: {
      baseUrl: trimSlash(process.env.NEWAPI_BASE_URL ?? "https://new-api.550w.link"),
      publicBaseUrl: trimSlash(
        process.env.NEWAPI_PUBLIC_BASE_URL ??
          process.env.NEWAPI_BASE_URL ??
          "https://new-api.550w.link",
      ),
      controlUserId: process.env.NEWAPI_CONTROL_USER_ID,
      accessToken: process.env.NEWAPI_ACCESS_TOKEN,
      adminAccessToken: process.env.NEWAPI_ADMIN_ACCESS_TOKEN,
      systemAk: process.env.NEWAPI_SYSTEM_AK,
      quotaPerUnit: positiveIntegerFromEnv(process.env.NEWAPI_QUOTA_PER_UNIT, 500000),
      requestTimeoutMs: positiveIntegerFromEnv(process.env.NEWAPI_REQUEST_TIMEOUT_MS, 15000),
      mock: process.env.TOKENINSIDE_MOCK_NEWAPI === "true",
    },
    admin: {
      systemAdminOpenIds: csvFromEnv(process.env.TOKENINSIDE_SYSTEM_ADMIN_OPEN_IDS),
    },
    quotaControl: {
      operationConcurrencyMax: positiveIntegerFromEnv(
        process.env.TOKENINSIDE_QUOTA_OPERATION_CONCURRENCY_MAX,
        1,
      ),
      directConsumptionDrainGraceMs: positiveIntegerFromEnv(
        process.env.TOKENINSIDE_DIRECT_CONSUMPTION_DRAIN_GRACE_MS,
        60_000,
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
