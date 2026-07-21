import { createDecipheriv, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

const manifestVersion = 1;
const manifestId = "default";
const manifestLock = "tokeninside_greenfield_installation_manifest";
const pageSize = 100;
const maxPages = 100;
const maxItems = pageSize * maxPages;
const appSecretContext = "app-settings:newapi-access-token";
const operationalTables = ["quota_balance_observer_state"];
const businessFactTables = [
  "billing_operations",
  "feishu_users",
  "token_requests",
  "token_accounts",
  "user_billing_periods",
  "department_quota_periods",
  "department_quota_requests",
  "quota_change_events",
  "user_quota_policies",
  "quota_operations",
  "quota_ledger_entries",
  "user_quota_states",
  "quota_reconciliation_records",
  "feishu_events",
  "proxy_request_logs",
  "newapi_usage_records",
  "usage_sync_checkpoints",
  "usage_sync_issues",
  "admin_scopes",
];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizeBaseUrl(value) {
  return new URL(value).toString().replace(/\/+$/, "");
}

export function parseCutover(value, requiredForBinding) {
  if (!value?.trim()) {
    if (requiredForBinding) {
      throw new Error(
        "TOKENINSIDE_GREENFIELD_CUTOVER_AT is required for the first greenfield binding",
      );
    }
    return undefined;
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || millis % 1000 !== 0) {
    throw new Error(
      "TOKENINSIDE_GREENFIELD_CUTOVER_AT must be a valid whole-second timestamp",
    );
  }
  if (millis > Date.now()) {
    throw new Error("TOKENINSIDE_GREENFIELD_CUTOVER_AT cannot be in the future");
  }
  return new Date(millis).toISOString();
}

function appSecretKey(sessionSecret) {
  return createHash("sha256")
    .update(sessionSecret, "utf8")
    .update("\0tokeninside-app-secret\0", "utf8")
    .update(appSecretContext, "utf8")
    .digest();
}

function openStoredAccessToken(ciphertext) {
  const sessionSecret = required("TOKENINSIDE_SESSION_SECRET");
  const [ivText, tagText, encryptedText] = ciphertext.split(".");
  if (!ivText || !tagText || !encryptedText) {
    throw new Error("stored NewAPI access token has an invalid secret envelope");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    appSecretKey(sessionSecret),
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAAD(Buffer.from(appSecretContext, "utf8"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function manifestPayload(manifest) {
  return JSON.stringify({
    version: manifest.version,
    upstreamBaseUrl: normalizeBaseUrl(manifest.upstreamBaseUrl),
    configuredControlUserId: manifest.configuredControlUserId,
    observedControlUserId: manifest.observedControlUserId,
    checkedAt: manifest.checkedAt,
    cutoverAt: manifest.cutoverAt,
  });
}

export function manifestHash(manifest) {
  return createHash("sha256").update(manifestPayload(manifest)).digest("hex");
}

function verifyManifestShape(manifest) {
  if (!manifest || manifest.version !== manifestVersion) {
    throw new Error("greenfield installation manifest is missing or unsupported");
  }
  if (manifestHash(manifest) !== manifest.manifestHash) {
    throw new Error("greenfield installation manifest hash is invalid");
  }
}

async function assertSchema(client) {
  const requiredTables = [
    "app_settings",
    "greenfield_installation_manifest",
    ...operationalTables,
    ...businessFactTables,
  ];
  const result = await client.query(
    `select relname
     from unnest($1::text[]) relname
     where to_regclass(current_schema() || '.' || relname) is null
     order by relname`,
    [requiredTables],
  );
  if (result.rows.length > 0) {
    throw new Error(
      `greenfield preflight requires migrated schema; missing tables: ${result.rows
        .map((row) => row.relname)
        .join(", ")}`,
    );
  }
}

async function readBusinessFactCounts(client) {
  const sql = businessFactTables
    .map(
      (table) =>
        `select '${table}'::text as table_name, count(*)::text as row_count from "${table}"`,
    )
    .join(" union all ");
  const result = await client.query(sql);
  return Object.fromEntries(
    result.rows.map((row) => [row.table_name, Number(row.row_count)]),
  );
}

function nonEmptyFacts(counts) {
  return Object.entries(counts).filter(([, count]) => count > 0);
}

async function readManifest(client) {
  const result = await client.query(
    `select data
     from greenfield_installation_manifest
     where id = $1
     limit 1`,
    [manifestId],
  );
  return result.rows[0]?.data ?? null;
}

async function resolveEffectiveNewApiConfig(client) {
  if (process.env.TOKENINSIDE_MOCK_NEWAPI === "true") {
    throw new Error("greenfield preflight refuses TOKENINSIDE_MOCK_NEWAPI=true");
  }
  const result = await client.query(
    "select data from app_settings where id = 'default' limit 1",
  );
  const override = result.rows[0]?.data?.newapiControl;
  const baseUrl = normalizeBaseUrl(
    override?.baseUrl || required("NEWAPI_BASE_URL"),
  );
  const controlUserId = String(
    override?.controlUserId || required("NEWAPI_CONTROL_USER_ID"),
  );
  const storedAccessToken = override?.accessTokenCiphertext
    ? openStoredAccessToken(override.accessTokenCiphertext)
    : undefined;
  const credential = [
    storedAccessToken || process.env.NEWAPI_ACCESS_TOKEN,
    process.env.NEWAPI_ADMIN_ACCESS_TOKEN,
    process.env.NEWAPI_SYSTEM_AK,
  ].find((value) => typeof value === "string" && value.trim().length > 0);
  if (!credential) {
    throw new Error(
      "NEWAPI_ACCESS_TOKEN, NEWAPI_ADMIN_ACCESS_TOKEN or NEWAPI_SYSTEM_AK is required",
    );
  }
  const requestTimeoutMs = Number(process.env.NEWAPI_REQUEST_TIMEOUT_MS ?? "15000");
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000) {
    throw new Error("NEWAPI_REQUEST_TIMEOUT_MS must be an integer of at least 1000");
  }
  return { baseUrl, controlUserId, credential, requestTimeoutMs };
}

async function newApiFetch(config, path) {
  const response = await fetch(`${config.baseUrl}${path}`, {
    headers: {
      authorization: config.credential,
      "New-Api-User": config.controlUserId,
      "LLMAPI-User": config.controlUserId,
      "content-type": "application/json; charset=utf-8",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`NewAPI returned non-JSON response: ${response.status}`);
  }
  if (!response.ok || body.success === false) {
    throw new Error(
      body.message ?? body.error ?? `NewAPI request failed: ${response.status}`,
    );
  }
  return body.data ?? body;
}

async function readControlIdentity(config) {
  const identity = await newApiFetch(config, "/api/user/self");
  const observedControlUserId = String(identity?.id ?? "");
  if (!observedControlUserId) {
    throw new Error("NewAPI /api/user/self did not return a control user id");
  }
  if (observedControlUserId !== config.controlUserId) {
    throw new Error(
      `NewAPI control identity mismatch: configured=${config.controlUserId}, observed=${observedControlUserId}`,
    );
  }
  return { observedControlUserId };
}

function pageShape(value, label) {
  const total = Number(value?.total);
  const items = Array.isArray(value?.items) ? value.items : null;
  if (!Number.isInteger(total) || total < 0 || !items) {
    throw new Error(`${label} page is missing an authoritative total/items shape`);
  }
  if (items.length > pageSize) {
    throw new Error(`${label} page exceeded the requested page size`);
  }
  return { total, items };
}

function firstIdentity(page) {
  if (page.items.length === 0) return null;
  return createHash("sha256")
    .update(JSON.stringify(page.items[0]))
    .digest("hex");
}

export async function assertStableEmptyCollection(label, fetchPage) {
  const baseline = pageShape(await fetchPage(0), label);
  const baselineFirst = firstIdentity(baseline);
  if (baseline.total > maxItems) {
    const confirmation = pageShape(await fetchPage(0), label);
    if (
      confirmation.total !== baseline.total ||
      firstIdentity(confirmation) !== baselineFirst
    ) {
      throw new Error(`${label} total changed during the bounded preflight read`);
    }
    throw new Error(`${label} total ${baseline.total} exceeds bounded limit ${maxItems}`);
  }
  const pages = Math.max(Math.ceil(baseline.total / pageSize), 1);
  if (pages > maxPages) throw new Error(`${label} requires too many pages`);
  let observed = 0;
  for (let page = 0; page < pages; page += 1) {
    const current = page === 0 ? baseline : pageShape(await fetchPage(page), label);
    if (current.total !== baseline.total) {
      throw new Error(`${label} total changed while paging`);
    }
    observed += current.items.length;
    if (observed > maxItems) throw new Error(`${label} exceeded bounded item limit`);
  }
  const confirmation = pageShape(await fetchPage(0), label);
  if (
    confirmation.total !== baseline.total ||
    firstIdentity(confirmation) !== baselineFirst ||
    observed !== baseline.total
  ) {
    throw new Error(`${label} was unstable during the preflight double read`);
  }
  if (baseline.total !== 0 || observed !== 0) {
    throw new Error(`${label} is polluted: ${baseline.total} existing records`);
  }
  return { total: 0, pagesRead: pages + 1 };
}

async function tokenPage(config, page) {
  const params = new URLSearchParams({
    p: String(page + 1),
    size: String(pageSize),
  });
  return newApiFetch(config, `/api/token/?${params.toString()}`);
}

async function usagePage(config, cutoverAt, page) {
  const cutoverSeconds = Math.trunc(Date.parse(cutoverAt) / 1000);
  const params = new URLSearchParams({
    p: String(page + 1),
    page_size: String(pageSize),
    type: "2",
    end_timestamp: String(cutoverSeconds - 1),
  });
  return newApiFetch(config, `/api/log/self?${params.toString()}`);
}

async function verifyExistingBinding(config, manifest) {
  verifyManifestShape(manifest);
  if (normalizeBaseUrl(manifest.upstreamBaseUrl) !== config.baseUrl) {
    throw new Error("greenfield manifest upstream base URL has drifted");
  }
  if (manifest.configuredControlUserId !== config.controlUserId) {
    throw new Error("greenfield manifest control user id has drifted");
  }
  const requestedCutover = parseCutover(
    process.env.TOKENINSIDE_GREENFIELD_CUTOVER_AT,
    false,
  );
  if (requestedCutover && requestedCutover !== manifest.cutoverAt) {
    throw new Error("configured greenfield cutover timestamp differs from the manifest");
  }
  const identity = await readControlIdentity(config);
  if (identity.observedControlUserId !== manifest.observedControlUserId) {
    throw new Error("greenfield manifest observed control identity has drifted");
  }
  return {
    ok: true,
    mode: "binding_verified",
    fullUpstreamScan: false,
    checkedAt: manifest.checkedAt,
    cutoverAt: manifest.cutoverAt,
  };
}

async function createInitialBinding(client, config) {
  const initialFacts = await readBusinessFactCounts(client);
  const pollutedFacts = nonEmptyFacts(initialFacts);
  if (pollutedFacts.length > 0) {
    throw new Error(
      `greenfield manifest is missing but local business facts exist: ${pollutedFacts
        .map(([table, count]) => `${table}=${count}`)
        .join(", ")}`,
    );
  }
  const cutoverAt = parseCutover(
    process.env.TOKENINSIDE_GREENFIELD_CUTOVER_AT,
    true,
  );
  const identity = await readControlIdentity(config);
  const tokenScan = await assertStableEmptyCollection(
    "NewAPI tokens",
    (page) => tokenPage(config, page),
  );
  const usageScan = await assertStableEmptyCollection(
    "NewAPI usage before cutover",
    (page) => usagePage(config, cutoverAt, page),
  );
  // Close the cross-collection race after both bounded scans.
  if (pageShape(await tokenPage(config, 0), "NewAPI tokens").total !== 0) {
    throw new Error("NewAPI tokens changed after the stable empty scan");
  }
  if (
    pageShape(
      await usagePage(config, cutoverAt, 0),
      "NewAPI usage before cutover",
    ).total !== 0
  ) {
    throw new Error("NewAPI usage changed after the stable empty scan");
  }

  const checkedAt = new Date().toISOString();
  const manifestWithoutHash = {
    version: manifestVersion,
    upstreamBaseUrl: config.baseUrl,
    configuredControlUserId: config.controlUserId,
    observedControlUserId: identity.observedControlUserId,
    checkedAt,
    cutoverAt,
  };
  const manifest = {
    ...manifestWithoutHash,
    manifestHash: manifestHash(manifestWithoutHash),
  };
  await client.query("begin");
  try {
    const concurrentManifest = await readManifest(client);
    if (concurrentManifest) {
      throw new Error("greenfield manifest appeared during initial preflight");
    }
    const finalFacts = await readBusinessFactCounts(client);
    const finalPollution = nonEmptyFacts(finalFacts);
    if (finalPollution.length > 0) {
      throw new Error("local business facts appeared during initial preflight");
    }
    await client.query(
      `insert into greenfield_installation_manifest
        (id, upstream_base_url, configured_control_user_id,
         observed_control_user_id, checked_at, cutover_at, manifest_hash, data)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        manifestId,
        manifest.upstreamBaseUrl,
        manifest.configuredControlUserId,
        manifest.observedControlUserId,
        manifest.checkedAt,
        manifest.cutoverAt,
        manifest.manifestHash,
        manifest,
      ],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
  return {
    ok: true,
    mode: "initial_binding_created",
    fullUpstreamScan: true,
    checkedAt,
    cutoverAt,
    tokenScan,
    usageScan,
    manifestHash: manifest.manifestHash,
  };
}

export async function runGreenfieldPreflight() {
  if ((process.env.TOKENINSIDE_STORE_BACKEND ?? "json") !== "postgres") {
    throw new Error("greenfield preflight requires TOKENINSIDE_STORE_BACKEND=postgres");
  }
  const pool = new Pool({
    connectionString: required("DATABASE_URL"),
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext($1)::bigint)", [
      manifestLock,
    ]);
    try {
      await assertSchema(client);
      const config = await resolveEffectiveNewApiConfig(client);
      const manifest = await readManifest(client);
      const result = manifest
        ? await verifyExistingBinding(config, manifest)
        : await createInitialBinding(client, config);
      console.log(JSON.stringify(result));
    } finally {
      await client.query("select pg_advisory_unlock(hashtext($1)::bigint)", [
        manifestLock,
      ]);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runGreenfieldPreflight().catch((error) => {
    console.error(
      JSON.stringify({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "unknown greenfield preflight failure",
      }),
    );
    process.exitCode = 1;
  });
}
