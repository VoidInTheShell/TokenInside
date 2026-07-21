import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("NewAPI settings are root-only and never return the stored ciphertext", async () => {
  const [settingsRoute, store, postgres] = await Promise.all([
    readFile(new URL("../app/api/admin/settings/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/store.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/postgres-store.ts", import.meta.url), "utf8"),
  ]);
  assert.match(settingsRoute, /isRootAdminScope\(auth\.scope\)/);
  assert.match(settingsRoute, /NewAPI 上游连接只能由 root 管理员修改/);
  assert.match(settingsRoute, /accessTokenConfigured/);
  assert.match(settingsRoute, /defaultMonthlyQuota: settings\.defaultMonthlyQuota/);
  assert.doesNotMatch(settingsRoute, /\.\.\.settings/);
  assert.doesNotMatch(settingsRoute, /accessTokenCiphertext:\s*newapiControl\?\.accessTokenCiphertext/);
  assert.match(settingsRoute, /updateAppSettingsAsActor/);
  assert.match(store, /export async function updateAppSettingsAsActor/);
  assert.match(store, /withAdminScopeUserLocks\(\[input\.actorFeishuUserId\]/);
  assert.match(postgres, /export async function updatePostgresAppSettingsAsActor/);
  assert.match(postgres, /lockAdminScopeUsersInTransaction\(client, \[input\.actorFeishuUserId\]\)/);
  assert.match(postgres, /select data from app_settings where id = 'default' for update/);
  assert.match(postgres, /actorScope\.source === "environment" && actorScope\.role === "root"/);
});

test("all NewAPI calls and the proxy URL use the effective runtime settings", async () => {
  const newapi = await readFile(new URL("../lib/newapi.ts", import.meta.url), "utf8");
  const proxy = await readFile(
    new URL("../app/v1/[...path]/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(newapi, /getEffectiveNewApiConfig/);
  assert.match(newapi, /export async function buildNewApiProxyUrl/);
  assert.match(
    proxy,
    /await resolveProxyRuntimeBinding\(\(\) =>[\s\S]*?buildNewApiProxyUrl/,
  );
});

test("billing health is pure read-only and never exposes NewAPI settings", async () => {
  const source = await readFile(
    new URL("../app/api/admin/billing-health/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /export async function GET/);
  assert.doesNotMatch(source, /newapiControl|accessToken|POST|fetch\(|updateNewApiTokenQuota/);
});
