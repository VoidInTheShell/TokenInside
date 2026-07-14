import { getConfig } from "./config.ts";
import { PackageBillingError } from "./package-errors.ts";
import type { NewApiQuotaDisplaySnapshot } from "./package-types.ts";
import { withPostgresClient, withPostgresTransaction } from "./postgres-store.ts";
import { normalizeNewApiQuotaDisplayStatus } from "./quota-display-model.ts";

let cached: NewApiQuotaDisplaySnapshot | null = null;
const CACHE_MS = 5 * 60 * 1000;

function snapshotFromRow(row: Record<string, unknown>): NewApiQuotaDisplaySnapshot {
  return {
    configVersion: String(row.config_version),
    quotaPerUnit: Number(row.quota_per_unit),
    displayInCurrency: row.display_in_currency === true,
    displayType: row.display_type as NewApiQuotaDisplaySnapshot["displayType"],
    usdExchangeRate: Number(row.usd_exchange_rate),
    customCurrencySymbol: String(row.custom_currency_symbol),
    customCurrencyExchangeRate: Number(row.custom_currency_exchange_rate),
    fetchedAt: new Date(String(row.fetched_at)).toISOString(),
    sourceStatus: row.source_status as NewApiQuotaDisplaySnapshot["sourceStatus"],
  };
}

export async function getLatestQuotaDisplaySnapshot() {
  if (cached) return cached;
  const snapshot = await withPostgresClient(async (client) => {
    const result = await client.query(
      `select * from newapi_quota_display_snapshots
       order by fetched_at desc limit 1`,
    );
    return result.rows[0] ? snapshotFromRow(result.rows[0]) : null;
  });
  cached = snapshot;
  return snapshot;
}

async function saveQuotaDisplaySnapshot(snapshot: NewApiQuotaDisplaySnapshot) {
  const stored = await withPostgresTransaction(async (client) => {
    const result = await client.query(
      `insert into newapi_quota_display_snapshots
        (config_version, quota_per_unit, display_in_currency, display_type,
         usd_exchange_rate, custom_currency_symbol, custom_currency_exchange_rate,
         fetched_at, source_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (config_version) do update set
         fetched_at = excluded.fetched_at,
         source_status = excluded.source_status
       returning *`,
      [
        snapshot.configVersion,
        snapshot.quotaPerUnit,
        snapshot.displayInCurrency,
        snapshot.displayType,
        snapshot.usdExchangeRate,
        snapshot.customCurrencySymbol,
        snapshot.customCurrencyExchangeRate,
        snapshot.fetchedAt,
        snapshot.sourceStatus,
      ],
    );
    return snapshotFromRow(result.rows[0]);
  });
  cached = stored;
  return stored;
}

export async function refreshQuotaDisplaySnapshot() {
  const config = getConfig();
  let response: Response;
  try {
    response = await fetch(`${config.newapi.baseUrl}/api/status`, {
      cache: "no-store",
      signal: AbortSignal.timeout(config.newapi.requestTimeoutMs),
    });
  } catch (error) {
    throw new PackageBillingError(
      "quota_display_config_unavailable",
      error instanceof Error ? error.message : "NewAPI /api/status 不可用",
      503,
      true,
    );
  }
  const body = (await response.json().catch(() => null)) as
    | { success?: boolean; data?: Record<string, unknown>; message?: string }
    | null;
  if (!response.ok || !body || body.success === false || !body.data) {
    throw new PackageBillingError(
      "quota_display_config_unavailable",
      body?.message ?? `NewAPI /api/status 返回 ${response.status}`,
      503,
      true,
    );
  }
  return saveQuotaDisplaySnapshot(normalizeNewApiQuotaDisplayStatus(body.data));
}

export async function getQuotaDisplaySnapshot(options: { refreshIfStale?: boolean } = {}) {
  const latest = await getLatestQuotaDisplaySnapshot();
  const stale = !latest || Date.now() - new Date(latest.fetchedAt).getTime() > CACHE_MS;
  if (options.refreshIfStale && stale) {
    try {
      return await refreshQuotaDisplaySnapshot();
    } catch (error) {
      if (!latest) throw error;
      return { ...latest, sourceStatus: "stale" as const };
    }
  }
  return latest;
}

export function clearQuotaDisplayCacheForTest() {
  cached = null;
}
