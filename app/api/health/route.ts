import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function hostFromUrl(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

async function canWriteStoreDirectory(storePath: string) {
  try {
    const directory = path.dirname(storePath);
    await mkdir(directory, { recursive: true });
    await access(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function configured(value: unknown) {
  return typeof value === "string" && value.length > 0;
}

export async function GET() {
  const config = getConfig();
  const storeWritable = await canWriteStoreDirectory(config.storePath);
  const status = storeWritable ? "ok" : "degraded";

  return NextResponse.json(
    {
      service: "tokeninside",
      status,
      timestamp: new Date().toISOString(),
      publicBaseUrlHost: hostFromUrl(config.publicBaseUrl),
      newapiHost: hostFromUrl(config.newapi.baseUrl),
      store: {
        type: "json",
        writable: storeWritable,
      },
      configuration: {
        sessionSecret: configured(config.sessionSecret),
        feishuApp: configured(config.feishu.appId) && configured(config.feishu.appSecret),
        approvalCode: configured(config.feishu.approvalCodeTokenRequest),
        approvalEventVerification: configured(config.feishu.eventVerificationToken),
        approvalEventEncryption: configured(config.feishu.eventEncryptKey),
        newapiControl:
          configured(config.newapi.systemAk) ||
          configured(config.newapi.accessToken) ||
          configured(config.newapi.adminAccessToken),
        newapiControlUserId: configured(config.newapi.controlUserId),
        newapiMock: config.newapi.mock,
      },
    },
    {
      status: storeWritable ? 200 : 503,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
