import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { billingPeriodFinalizationSnapshot } from "@/lib/billing-period-finalizer";
import { getConfig } from "@/lib/config";
import { verifyGreenfieldInstallationBinding } from "@/lib/greenfield-installation";
import { getNewApiRuntimeBindingForHealth } from "@/lib/newapi-runtime";
import { proxyConcurrencySnapshot } from "@/lib/proxy-concurrency";
import {
  checkPostgresSchema,
  postgresPoolRuntimeSnapshot,
} from "@/lib/postgres-store";
import { quotaOperationExecutionSnapshot } from "@/lib/quota-saga";
import { quotaSubmitPoolRuntimeSnapshot } from "@/lib/quota-operation-submit";
import {
  billingMaterializationRecoverySnapshot,
  usageSettlementTailSnapshot,
} from "@/lib/usage-sync";

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
  const runtimeBinding = await getNewApiRuntimeBindingForHealth().catch(() => ({
    value: config.newapi,
    manifest: null,
  }));
  const effectiveNewApi = runtimeBinding.value;
  const postgresSchema =
    config.storeBackend === "postgres"
      ? await checkPostgresSchema().catch(() => ({
          ready: false,
          missingTables: [],
          tableCount: 0,
          error: "connection_failed" as const,
        }))
      : undefined;
  const storeWritable =
    config.storeBackend === "postgres"
      ? postgresSchema?.error !== "connection_failed"
      : await canWriteStoreDirectory(config.storePath);
  const greenfieldManifest = runtimeBinding.manifest;
  const greenfieldBinding =
    config.storeBackend === "postgres"
      ? verifyGreenfieldInstallationBinding({
          manifest: greenfieldManifest,
          upstreamBaseUrl: effectiveNewApi.baseUrl,
          configuredControlUserId: effectiveNewApi.controlUserId,
        })
      : { ready: true as const, reason: undefined };
  const storeReady =
    config.storeBackend === "postgres"
      ? storeWritable && postgresSchema?.ready && greenfieldBinding.ready
      : storeWritable;
  const status = storeReady ? "ok" : "degraded";

  return NextResponse.json(
    {
      service: "tokeninside",
      status,
      timestamp: new Date().toISOString(),
      publicBaseUrlHost: hostFromUrl(config.publicBaseUrl),
      newapiHost: hostFromUrl(effectiveNewApi.baseUrl),
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
        greenfieldInstallation:
          config.storeBackend === "postgres"
            ? {
                ready: greenfieldBinding.ready,
                reason: greenfieldBinding.reason,
                checkedAt: greenfieldManifest?.checkedAt,
                cutoverAt: greenfieldManifest?.cutoverAt,
              }
            : undefined,
        postgresPool:
          config.storeBackend === "postgres"
              ? {
                max: config.postgres.poolMax,
                settlementMax: config.postgres.settlementPoolMax,
                controlMax: config.postgres.controlPoolMax,
                quotaSubmitMax: config.postgres.quotaSubmitPoolMax,
                lockMax: config.postgres.lockPoolMax,
                idleTimeoutMs: config.postgres.poolIdleTimeoutMs,
                connectionTimeoutMs: config.postgres.poolConnectionTimeoutMs,
                runtime: {
                  ...postgresPoolRuntimeSnapshot(),
                  quotaSubmit: quotaSubmitPoolRuntimeSnapshot(),
                },
              }
            : undefined,
        proxyConcurrency: proxyConcurrencySnapshot(),
        quotaOperations: quotaOperationExecutionSnapshot(),
        billingMaterialization: billingPeriodFinalizationSnapshot(),
        billingMaterializationRecovery: billingMaterializationRecoverySnapshot(),
        usageSettlementTail: usageSettlementTailSnapshot(),
      },
      configuration: {
        sessionSecret: configured(config.sessionSecret),
        feishuApp: configured(config.feishu.appId) && configured(config.feishu.appSecret),
        approvalCode: configured(config.feishu.approvalCodeTokenRequest),
        approvalEventVerification: configured(config.feishu.eventVerificationToken),
        approvalEventEncryption: configured(config.feishu.eventEncryptKey),
        newapiControl:
          configured(effectiveNewApi.systemAk) ||
          configured(effectiveNewApi.accessToken) ||
          configured(effectiveNewApi.adminAccessToken),
        newapiControlUserId: configured(effectiveNewApi.controlUserId),
        newapiMock: config.newapi.mock,
        newapiQuotaPerUnit: config.newapi.quotaPerUnit,
        newapiRequestTimeoutMs: config.newapi.requestTimeoutMs,
        proxyQueueTimeoutMs: config.proxy.queueTimeoutMs,
        systemAdmins: config.admin.systemAdminOpenIds.length,
        environmentAdmins: config.admin.systemAdminOpenIds.length > 0,
        quotaOperationConcurrencyMax: config.billing.operationConcurrencyMax,
        quotaSubmitConnectionTimeoutMs: config.postgres.quotaSubmitConnectionTimeoutMs,
        quotaSubmitStatementTimeoutMs: config.postgres.quotaSubmitStatementTimeoutMs,
        quotaSubmitLockTimeoutMs: config.postgres.quotaSubmitLockTimeoutMs,
        usageSettlementConcurrencyMax: config.billing.settlementConcurrencyMax,
        billingMaterializationConcurrencyMax:
          config.billing.materializationConcurrencyMax,
        usageSyncContinuationDelayMs:
          config.billing.usageSyncContinuationDelayMs,
      },
    },
    {
      status: storeReady ? 200 : 503,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
