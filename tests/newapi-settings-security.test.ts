import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("NewAPI settings are root-only and never return the stored ciphertext", async () => {
  const settingsRoute = await readFile(
    new URL("../app/api/admin/settings/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(settingsRoute, /isRootAdminScope\(auth\.scope\)/);
  assert.match(settingsRoute, /NewAPI 上游连接只能由 root 管理员修改/);
  assert.match(settingsRoute, /accessTokenConfigured/);
  assert.match(settingsRoute, /const \{ newapiControl, \.\.\.safeSettings \} = settings/);
  assert.doesNotMatch(settingsRoute, /accessTokenCiphertext:\s*newapiControl\?\.accessTokenCiphertext/);
});

test("all NewAPI calls and the proxy URL use the effective runtime settings", async () => {
  const newapi = await readFile(new URL("../lib/newapi.ts", import.meta.url), "utf8");
  const proxy = await readFile(
    new URL("../app/v1/[...path]/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(newapi, /getEffectiveNewApiConfig/);
  assert.match(newapi, /export async function buildNewApiProxyUrl/);
  assert.match(proxy, /await buildNewApiProxyUrl/);
});

test("quota-control responses strip encrypted NewAPI settings", async () => {
  const source = await readFile(
    new URL("../app/api/admin/quota-control/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /const \{ newapiControl: _newapiControl, \.\.\.visibleSettings \} = settings/);
});
