import path from "node:path";

export type RuntimeConfig = {
  publicBaseUrl: string;
  sessionSecret?: string;
  storePath: string;
  feishu: {
    appId?: string;
    appSecret?: string;
    approvalCodeTokenRequest?: string;
    eventEncryptKey?: string;
    eventVerificationToken?: string;
  };
  newapi: {
    baseUrl: string;
    accessToken?: string;
    adminAccessToken?: string;
    systemAk?: string;
    mock: boolean;
  };
};

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function getConfig(): RuntimeConfig {
  const publicBaseUrl =
    process.env.TOKENINSIDE_PUBLIC_BASE_URL ?? "http://127.0.0.1:16878";

  return {
    publicBaseUrl: trimSlash(publicBaseUrl),
    sessionSecret: process.env.TOKENINSIDE_SESSION_SECRET,
    storePath: path.resolve(
      /* turbopackIgnore: true */ process.cwd(),
      process.env.TOKENINSIDE_STORE_PATH ?? ".local-data/tokeninside.json",
    ),
    feishu: {
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      approvalCodeTokenRequest: process.env.FEISHU_APPROVAL_CODE_TOKEN_REQUEST,
      eventEncryptKey: process.env.FEISHU_APPROVAL_EVENT_ENCRYPT_KEY,
      eventVerificationToken: process.env.FEISHU_APPROVAL_EVENT_VERIFICATION_TOKEN,
    },
    newapi: {
      baseUrl: trimSlash(process.env.NEWAPI_BASE_URL ?? "https://new-api.550w.link"),
      accessToken: process.env.NEWAPI_ACCESS_TOKEN,
      adminAccessToken: process.env.NEWAPI_ADMIN_ACCESS_TOKEN,
      systemAk: process.env.NEWAPI_SYSTEM_AK,
      mock: process.env.TOKENINSIDE_MOCK_NEWAPI === "true",
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
