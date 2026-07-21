import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  greenfieldInstallationManifestHash,
  verifyGreenfieldInstallationBinding,
  verifyGreenfieldInstallationManifest,
} from "../lib/greenfield-installation.ts";
import {
  assertStableEmptyCollection,
  manifestHash as scriptManifestHash,
  parseCutover,
} from "../scripts/greenfield-preflight.mjs";

const scriptPath = new URL("../scripts/greenfield-preflight.mjs", import.meta.url);
const baselinePath = new URL("../scripts/db-migrate.mjs", import.meta.url);
const deployPath = new URL("../scripts/deploy-la.sh", import.meta.url);
const preflightPath = new URL("../scripts/production-preflight.mjs", import.meta.url);
const healthPath = new URL("../app/api/health/route.ts", import.meta.url);
const workflowPath = new URL(
  "../.github/workflows/tokeninside-ci-cd.yml",
  import.meta.url,
);
const packagePath = new URL("../package.json", import.meta.url);
const runtimePath = new URL("../lib/newapi-runtime.ts", import.meta.url);
const settingsRoutePath = new URL(
  "../app/api/admin/settings/route.ts",
  import.meta.url,
);
const postgresStorePath = new URL("../lib/postgres-store.ts", import.meta.url);
const envExamplePath = new URL("../.env.example", import.meta.url);
const envProductionExamplePath = new URL(
  "../.env.production.example",
  import.meta.url,
);

function manifest() {
  const value = {
    version: 1 as const,
    upstreamBaseUrl: "https://newapi.example.com",
    configuredControlUserId: "42",
    observedControlUserId: "42",
    checkedAt: "2026-07-18T00:00:01.000Z",
    cutoverAt: "2026-07-18T00:00:00.000Z",
  };
  return { ...value, manifestHash: greenfieldInstallationManifestHash(value) };
}

test("greenfield manifest hash is shared with the offline command and detects binding drift", () => {
  const value = manifest();
  assert.equal(scriptManifestHash(value), value.manifestHash);
  assert.deepEqual(verifyGreenfieldInstallationManifest(value), {
    ready: true,
    reason: undefined,
  });
  assert.equal(
    verifyGreenfieldInstallationBinding({
      manifest: value,
      upstreamBaseUrl: "https://newapi.example.com/",
      configuredControlUserId: "42",
    }).ready,
    true,
  );
  assert.equal(
    verifyGreenfieldInstallationBinding({
      manifest: value,
      upstreamBaseUrl: "https://other.example.com",
      configuredControlUserId: "42",
    }).reason,
    "upstream_base_url_drift",
  );
  assert.equal(
    verifyGreenfieldInstallationManifest({ ...value, checkedAt: value.cutoverAt })
      .reason,
    "manifest_hash_invalid",
  );
});

test("cutover must be a reached whole-second timestamp", () => {
  assert.equal(
    parseCutover("2026-07-18T00:00:00Z", true),
    "2026-07-18T00:00:00.000Z",
  );
  assert.throws(
    () => parseCutover("2026-07-18T00:00:00.123Z", true),
    /whole-second/,
  );
  assert.throws(() => parseCutover(undefined, true), /is required/);
  assert.throws(
    () => parseCutover("replace-with-actual-greenfield-cutover-at", true),
    /valid whole-second/,
  );
});

test("empty upstream collection uses a stable double read", async () => {
  let calls = 0;
  const result = await assertStableEmptyCollection("tokens", async (page: number) => {
    calls += 1;
    assert.equal(page, 0);
    return { total: 0, items: [] };
  });
  assert.deepEqual(result, { total: 0, pagesRead: 2 });
  assert.equal(calls, 2);
});

test("polluted and unstable upstream collections are bounded and rejected", async () => {
  const requestedPages: number[] = [];
  await assert.rejects(
    () =>
      assertStableEmptyCollection("usage", async (page: number) => {
        requestedPages.push(page);
        const start = page * 100;
        const count = Math.min(201 - start, 100);
        return {
          total: 201,
          items: Array.from({ length: Math.max(count, 0) }, (_, index) => ({
            id: start + index,
          })),
        };
      }),
    /polluted/,
  );
  assert.deepEqual(requestedPages, [0, 1, 2, 0]);

  let unstableCalls = 0;
  await assert.rejects(
    () =>
      assertStableEmptyCollection("tokens", async () => {
        unstableCalls += 1;
        return unstableCalls === 1
          ? { total: 0, items: [] }
          : { total: 1, items: [{ id: 1 }] };
      }),
    /unstable/,
  );
  assert.equal(unstableCalls, 2);
});

test("deployment enforces one-time greenfield binding without adding restart scans", async () => {
  const [
    script,
    baseline,
    deploy,
    preflight,
    health,
    workflow,
    packageJson,
    runtime,
    settingsRoute,
    postgresStore,
    envExample,
    envProductionExample,
  ] =
    await Promise.all([
      readFile(scriptPath, "utf8"),
      readFile(baselinePath, "utf8"),
      readFile(deployPath, "utf8"),
      readFile(preflightPath, "utf8"),
      readFile(healthPath, "utf8"),
      readFile(workflowPath, "utf8"),
      readFile(packagePath, "utf8"),
      readFile(runtimePath, "utf8"),
      readFile(settingsRoutePath, "utf8"),
      readFile(postgresStorePath, "utf8"),
      readFile(envExamplePath, "utf8"),
      readFile(envProductionExamplePath, "utf8"),
    ]);

  assert.match(packageJson, /"greenfield:preflight": "node scripts\/greenfield-preflight\.mjs"/);
  assert.match(baseline, /create table if not exists greenfield_installation_manifest/);
  assert.match(baseline, /manifest_hash text not null/);
  assert.match(script, /select pg_advisory_lock/);
  assert.match(script, /businessFactTables/);
  assert.match(script, /greenfield manifest is missing but local business facts exist/);
  assert.match(script, /\/api\/user\/self/);
  assert.match(script, /\/api\/token\//);
  assert.match(script, /\/api\/log\/self/);
  assert.match(script, /end_timestamp/);
  assert.match(script, /maxPages = 100/);
  assert.match(script, /maxItems = pageSize \* maxPages/);
  assert.match(script, /fullUpstreamScan: false/);
  const verifyExisting = script.slice(
    script.indexOf("async function verifyExistingBinding"),
    script.indexOf("async function createInitialBinding"),
  );
  assert.doesNotMatch(verifyExisting, /readBusinessFactCounts|tokenPage|usagePage/);
  assert.doesNotMatch(script, /method:\s*["'](?:POST|PUT|DELETE)/);
  assert.doesNotMatch(script, /credential.*manifest|accessTokenCiphertext.*manifest/i);

  const migration = deploy.indexOf("scripts/db-migrate.mjs");
  const greenfield = deploy.indexOf("scripts/greenfield-preflight.mjs");
  const production = deploy.indexOf("scripts/production-preflight.mjs");
  const replacement = deploy.indexOf(
    "compose up -d --no-deps --wait --force-recreate tokeninside",
    production,
  );
  assert.ok(
    migration >= 0 &&
      migration < greenfield &&
      greenfield < production &&
      production < replacement,
  );
  assert.match(workflow, /scripts\/greenfield-preflight\.mjs/);
  assert.match(preflight, /GREENFIELD_INSTALLATION_MANIFEST/);
  assert.match(health, /verifyGreenfieldInstallationBinding/);
  assert.match(health, /greenfieldBinding\.ready/);
  assert.doesNotMatch(health, /listNewApiUsageLogs|tokenPage|usagePage/);
  assert.match(runtime, /getNewApiRuntimeBindingSnapshot/);
  assert.match(runtime, /verifyGreenfieldInstallationBinding/);
  assert.match(runtime, /throw new GreenfieldInstallationBindingError/);
  assert.match(settingsRoute, /verifyNewApiControlIdentity/);
  assert.match(settingsRoute, /已绑定的绿地 NewAPI 地址和控制用户不可在线变更/);
  const identityCheck = settingsRoute.indexOf("await verifyNewApiControlIdentity");
  const settingsWrite = settingsRoute.indexOf("await updateAppSettingsAsActor");
  assert.ok(identityCheck >= 0 && identityCheck < settingsWrite);
  assert.match(postgresStore, /GreenfieldInstallationBindingWriteError/);
  assert.match(postgresStore, /from greenfield_installation_manifest/);
  for (const envFile of [envExample, envProductionExample]) {
    assert.match(
      envFile,
      /TOKENINSIDE_GREENFIELD_CUTOVER_AT=replace-with-actual-greenfield-cutover-at/,
    );
    assert.doesNotMatch(
      envFile,
      /TOKENINSIDE_GREENFIELD_CUTOVER_AT=20\d\d-/,
    );
  }
});
