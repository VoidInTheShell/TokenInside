import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adminClientPath = new URL("../components/admin-client.tsx", import.meta.url);
const requestRoutePath = new URL(
  "../app/api/admin/department-quota/requests/route.ts",
  import.meta.url,
);
const storePath = new URL("../lib/store.ts", import.meta.url);
const feishuPath = new URL("../lib/feishu.ts", import.meta.url);

test("部门额度重置申请只提交理由，目标额度由系统管理员审批时确定", async () => {
  const [client, route, store, feishu] = await Promise.all([
    readFile(adminClientPath, "utf8"),
    readFile(requestRoutePath, "utf8"),
    readFile(storePath, "utf8"),
    readFile(feishuPath, "utf8"),
  ]);

  assert.match(
    client,
    /departmentQuotaRequestAction === "increase" && \([\s\S]*departmentQuotaRequestLimit/,
  );
  assert.match(client, /\? "申请重置额度"\s*: "申请提高额度"/);
  assert.match(client, /htmlFor="departmentQuotaRequestReason">申请理由<\/label>/);
  assert.match(
    client,
    /requestedQuotaLimit === undefined \? \{\} : \{ requestedQuotaLimit \}/,
  );
  assert.match(route, /z\.discriminatedUnion\("action"/);
  assert.match(
    route,
    /action: z\.literal\("reset"\),\s*reason: z\.string\(\)\.min\(4\)\.max\(500\)/,
  );
  assert.match(
    store,
    /if \(approvedQuotaLimit === undefined\) \{\s*throw new Error\("重置额度申请需要系统管理员填写审批额度"\)/,
  );
  assert.match(
    feishu,
    /input\.action === "increase"\s*\? `\*\*申请上限\*\*：\$\{input\.requestedQuotaLimit\}`\s*: "\*\*审批额度\*\*：请系统管理员在 TokenInside 管理后台填写"/,
  );
  assert.match(feishu, /\.\.\.\(input\.action === "increase" \? \[\{/);
});
