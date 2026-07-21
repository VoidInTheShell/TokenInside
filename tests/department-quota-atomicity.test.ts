import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const overviewRoutePath = new URL(
  "../app/api/admin/department-quota/route.ts",
  import.meta.url,
);
const requestRoutePath = new URL(
  "../app/api/admin/department-quota/requests/route.ts",
  import.meta.url,
);
const decisionRoutePath = new URL(
  "../app/api/admin/department-quota/requests/[id]/decision/route.ts",
  import.meta.url,
);
const storePath = new URL("../lib/store.ts", import.meta.url);
const postgresPath = new URL("../lib/postgres-store.ts", import.meta.url);
const adminClientPath = new URL("../components/admin-client.tsx", import.meta.url);

function section(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

test("部门额度 GET 是纯读有界投影，不会在页面刷新时创建账期", async () => {
  const [route, store, postgres] = await Promise.all([
    readFile(overviewRoutePath, "utf8"),
    readFile(storePath, "utf8"),
    readFile(postgresPath, "utf8"),
  ]);
  const list = section(
    store,
    "export async function listDepartmentQuotaOverview(",
    "async function updateDepartmentQuotaPolicy(",
  );
  assert.match(route, /listDepartmentQuotaOverview/);
  assert.match(list, /getPostgresDepartmentQuotaOverview/);
  assert.doesNotMatch(list, /ensureDepartmentQuotaPeriod|persist|mutate\(/);
  const pgRead = section(
    postgres,
    "export async function getPostgresDepartmentQuotaOverview(",
    "export async function upsertPostgresQuotaChangeEvent(",
  );
  assert.match(pgRead, /withControlClient/);
  assert.match(pgRead, /limit 200/);
  assert.match(pgRead, /limit 100/);
  assert.doesNotMatch(pgRead, /insert into|update |delete from|for update/);
});

test("部门 policy、申请创建和审批均在 actor-aware 单事务内写入", async () => {
  const [overviewRoute, requestRoute, decisionRoute, postgres, store] =
    await Promise.all([
      readFile(overviewRoutePath, "utf8"),
      readFile(requestRoutePath, "utf8"),
      readFile(decisionRoutePath, "utf8"),
      readFile(postgresPath, "utf8"),
      readFile(storePath, "utf8"),
    ]);
  assert.match(overviewRoute, /updateDepartmentQuotaPolicyAsActor/);
  assert.match(requestRoute, /createDepartmentQuotaRequestAsActor/);
  assert.match(decisionRoute, /decideDepartmentQuotaRequestAsActor/);

  const update = section(
    postgres,
    "export async function updatePostgresDepartmentQuotaPolicyAsActor(",
    "export async function createPostgresDepartmentQuotaRequestAsActor(",
  );
  const create = section(
    postgres,
    "export async function createPostgresDepartmentQuotaRequestAsActor(",
    "export async function decidePostgresDepartmentQuotaRequestAsActor(",
  );
  const decide = section(
    postgres,
    "export async function decidePostgresDepartmentQuotaRequestAsActor(",
    "export async function getPostgresDepartmentQuotaOverview(",
  );
  for (const block of [update, create, decide]) {
    assert.match(block, /withControlTransaction/);
    assert.match(block, /lockAdminScopeUsersInTransaction/);
    assert.match(block, /resolvePostgresActorScopeInTransaction/);
    assert.match(block, /department-quota:/);
  }
  assert.match(update, /saveDepartmentQuotaPeriodRow/);
  assert.match(update, /saveQuotaChangeEventRow/);
  assert.match(create, /saveDepartmentQuotaRequestRow/);
  assert.match(decide, /saveDepartmentQuotaPeriodRow/);
  assert.match(decide, /saveQuotaChangeEventRow/);
  assert.match(decide, /saveDepartmentQuotaRequestRow/);
  assert.match(decide, /qce_department_request_/);
  assert.match(store, /export async function updateDepartmentQuotaPolicyAsActor/);
  assert.match(store, /export async function createDepartmentQuotaRequestAsActor/);
  assert.match(store, /export async function decideDepartmentQuotaRequestAsActor/);
  const storeUpdateDispatch = section(
    store,
    "export async function updateDepartmentQuotaPolicyAsActor(",
    "export async function createDepartmentQuotaRequestAsActor(",
  );
  assert.match(
    storeUpdateDispatch,
    /if \(isPostgresBackend\(\)\) \{\s*return updatePostgresDepartmentQuotaPolicyAsActor\(\{ \.\.\.input, period \}\);/,
  );
  assert.doesNotMatch(
    storeUpdateDispatch,
    /PostgreSQL 部门额度写入必须使用 actor-aware 原子事务入口/,
  );
});

test("非 root 不渲染任何系统管理员用户写操作", async () => {
  const source = await readFile(adminClientPath, "utf8");
  assert.match(source, /isGlobalAdmin\?: boolean/);
  assert.match(source, /!user\.isGlobalAdmin \|\| isRootAdmin/);
  assert.doesNotMatch(source, /仅 root 可操作/);
});
