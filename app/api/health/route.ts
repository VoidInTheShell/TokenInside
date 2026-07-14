import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { proxyConcurrencySnapshot } from "@/lib/proxy-concurrency";
import { checkPostgresSchema, postgresPoolSnapshot } from "@/lib/postgres-store";
import { ensureUsageSyncScheduler } from "@/lib/usage-sync";
import { checkRedisConnection, redisRuntimeSnapshot } from "@/lib/redis-runtime";
import { proxyPrincipalCacheSnapshot } from "@/lib/proxy-principal-cache";

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

export async function GET(request: Request) {
  void ensureUsageSyncScheduler().catch(() => undefined);
  const config = getConfig();
  const runtimeMetrics = {
    timestamp: new Date().toISOString(),
    proxyConcurrency: proxyConcurrencySnapshot(),
    postgresPools:
      config.storeBackend === "postgres" ? postgresPoolSnapshot() : undefined,
    redis: redisRuntimeSnapshot(),
    proxyPrincipalCache: proxyPrincipalCacheSnapshot(),
  };
  if (new URL(request.url).searchParams.get("scope") === "runtime") {
    return NextResponse.json(runtimeMetrics, {
      headers: { "Cache-Control": "no-store" },
    });
  }
  const postgresSchema =
    config.storeBackend === "postgres"
      ? await checkPostgresSchema().catch(() => ({
          ready: false,
          missingTables: [],
          tableCount: 0,
          error: "connection_failed" as const,
        }))
      : undefined;
  const redis = await checkRedisConnection();
  const storeWritable =
    config.storeBackend === "postgres"
      ? postgresSchema?.error !== "connection_failed"
      : await canWriteStoreDirectory(config.storePath);
  const storeReady =
    config.storeBackend === "postgres" ? storeWritable && postgresSchema?.ready : storeWritable;
  const runtimeReady = storeReady && (!redis.required || redis.ready);
  const status = runtimeReady ? "ok" : "degraded";

  return NextResponse.json(
    {
      service: "tokeninside",
      status,
      timestamp: new Date().toISOString(),
      publicBaseUrlHost: hostFromUrl(config.publicBaseUrl),
      newapiHost: hostFromUrl(config.newapi.baseUrl),
      store: {
        type: config.storeBackend,
        writable: storeWritable,
        databaseConfigured: config.storeBackend === "postgres" ? configured(config.databaseUrl) : undefined,
        schema:
          config.storeBackend === "postgres"
            ? {
                ready: Boolean(postgresSchema?.ready),
                missingTables: postgresSchema?.missingTables ?? [],
                tableCount: postgresSchema?.tableCount ?? 0,
                error: postgresSchema?.error,
              }
            : undefined,
        postgresPool:
          config.storeBackend === "postgres"
            ? {
                max: config.postgres.poolMax,
                lockMax: config.postgres.lockPoolMax,
                idleTimeoutMs: config.postgres.poolIdleTimeoutMs,
                connectionTimeoutMs: config.postgres.poolConnectionTimeoutMs,
              }
            : undefined,
        proxyConcurrency: runtimeMetrics.proxyConcurrency,
        postgresPoolRuntime: runtimeMetrics.postgresPools,
      },
      redis,
      configuration: {
        sessionSecret: configured(config.sessionSecret),
        feishuApp: configured(config.feishu.appId) && configured(config.feishu.appSecret),
        approvalEventVerification: configured(config.feishu.eventVerificationToken),
        approvalEventEncryption: configured(config.feishu.eventEncryptKey),
        newapiControl:
          configured(config.newapi.systemAk) ||
          configured(config.newapi.accessToken) ||
          configured(config.newapi.adminAccessToken),
        newapiControlUserId: configured(config.newapi.controlUserId),
        newapiMock: config.newapi.mock,
        newapiQuotaPerUnit: config.newapi.quotaPerUnit,
        newapiRequestTimeoutMs: config.newapi.requestTimeoutMs,
        proxyQueueTimeoutMs: config.proxy.queueTimeoutMs,
        proxyQueueMax: config.proxy.queueMax,
        proxyPreparationQueueMax: config.proxy.preparationQueueMax,
        redisRequired: config.redis.required,
        redisPrincipalTtlSeconds: config.redis.principalTtlSeconds,
        systemAdmins: config.admin.systemAdminOpenIds.length,
        environmentAdmins: config.admin.systemAdminOpenIds.length > 0,
      },
    },
    {
      status: runtimeReady ? 200 : 503,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
