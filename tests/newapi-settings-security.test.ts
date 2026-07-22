import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
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

test("所有 NewAPI 控制与报表调用使用运行时绑定，TI 不注册 LLM 数据面", async () => {
  const [newapi, reporting] = await Promise.all([
    readFile(new URL("../lib/newapi.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/newapi-reporting.ts", import.meta.url), "utf8"),
  ]);
  assert.match(newapi, /getEffectiveNewApiConfig/);
  assert.match(reporting, /listNewApiUsageLogs/);
  assert.match(reporting, /getNewApiTokenControlState/);
  await assert.rejects(
    access(new URL("../app/v1/[...path]/route.ts", import.meta.url)),
  );
});

test("管理端不注册账务健康入口", async () => {
  await assert.rejects(
    access(new URL("../app/api/admin/billing-health/route.ts", import.meta.url)),
  );
});
