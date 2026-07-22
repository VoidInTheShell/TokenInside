import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  defaultPostLoginPath,
} from "../lib/auth-landing.ts";

test("所有管理员角色登录后默认进入用户后台", () => {
  assert.equal(
    defaultPostLoginPath({ scopeType: "global", source: "environment", role: "root" }),
    "/",
  );
  assert.equal(defaultPostLoginPath({ scopeType: "global", source: "manual" }), "/");
  assert.equal(
    defaultPostLoginPath({ scopeType: "department", source: "department_supervisor" }),
    "/",
  );
});

test("普通用户登录后默认进入用户后台", () => {
  assert.equal(defaultPostLoginPath(null), "/");
});

test("已有 session 的管理员留在用户后台", async () => {
  const source = await readFile(
    new URL("../components/experience-client.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /shouldRedirectToDefaultAdminPath/);
  assert.doesNotMatch(source, /location\.replace\(["']\/admin["']\)/);
});

test("管理后台返回入口明确返回用户后台", async () => {
  const source = await readFile(
    new URL("../components/admin-client.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /<a className="button button-outline" href="\/">[\s\S]*返回用户后台[\s\S]*<\/a>/,
  );
  assert.doesNotMatch(source, />\s*返回控制台\s*</);
});

test("session 查询不得创建申请或触发 Key 发放", async () => {
  const source = await readFile(new URL("../app/api/session/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /createTokenRequest/);
  assert.doesNotMatch(source, /provisionTokenForRequest/);
  assert.doesNotMatch(source, /ensureAdminActiveToken/);
  assert.doesNotMatch(source, /管理员默认额度自动发放/);
});
