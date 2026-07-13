import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  defaultPostLoginPath,
  shouldRedirectToDefaultAdminPath,
} from "../lib/auth-landing.ts";

test("管理员角色登录后默认进入管理后台", () => {
  assert.equal(
    defaultPostLoginPath({ scopeType: "global", source: "environment", role: "root" }),
    "/admin",
  );
  assert.equal(defaultPostLoginPath({ scopeType: "global", source: "manual" }), "/admin");
  assert.equal(
    defaultPostLoginPath({ scopeType: "department", source: "department_supervisor" }),
    "/admin",
  );
});

test("普通用户登录后默认进入用户后台", () => {
  assert.equal(defaultPostLoginPath(null), "/");
});

test("已有 session 的管理员默认进入管理后台，但可显式返回用户后台", () => {
  const scope = { scopeType: "global" as const, source: "manual" as const };
  assert.equal(
    shouldRedirectToDefaultAdminPath({ scope, currentPath: "/", search: "" }),
    true,
  );
  assert.equal(
    shouldRedirectToDefaultAdminPath({ scope, currentPath: "/", search: "?view=user" }),
    false,
  );
  assert.equal(
    shouldRedirectToDefaultAdminPath({ scope, currentPath: "/admin", search: "" }),
    false,
  );
});

test("session 查询不得创建申请或触发 Key 发放", async () => {
  const source = await readFile(new URL("../app/api/session/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /createTokenRequest/);
  assert.doesNotMatch(source, /provisionTokenForRequest/);
  assert.doesNotMatch(source, /ensureAdminActiveToken/);
  assert.doesNotMatch(source, /管理员默认额度自动发放/);
});
