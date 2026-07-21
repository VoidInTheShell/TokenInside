import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { Pool } from "pg";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
function runScript(script: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        cwd: new URL("..", import.meta.url),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    },
  );
}

test(
  "real PostgreSQL greenfield preflight binds once and later avoids token and usage scans",
  { skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const adminPool = new Pool({ connectionString: testDatabaseUrl, max: 2 });
    const schema = `test_greenfield_${process.pid}_${Date.now()}`;
    const scopedUrl = new URL(testDatabaseUrl!);
    scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
    let tokenMode: "empty" | "polluted" = "empty";
    const calls = { identity: 0, tokens: 0, usage: 0 };
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.startsWith("/api/user/self")) {
        calls.identity += 1;
        response.end(JSON.stringify({ success: true, data: { id: 42 } }));
        return;
      }
      if (request.url?.startsWith("/api/token/")) {
        calls.tokens += 1;
        response.end(
          JSON.stringify({
            success: true,
            data:
              tokenMode === "empty"
                ? { total: 0, items: [] }
                : { total: 1, items: [{ id: 7, name: "pollution" }] },
          }),
        );
        return;
      }
      if (request.url?.startsWith("/api/log/self")) {
        calls.usage += 1;
        response.end(
          JSON.stringify({ success: true, data: { total: 0, items: [] } }),
        );
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ success: false, message: "not found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      await adminPool.query(`create schema "${schema}"`);
      const env = {
        ...process.env,
        DATABASE_URL: scopedUrl.toString(),
        TOKENINSIDE_STORE_BACKEND: "postgres",
        TOKENINSIDE_SESSION_SECRET: "test-session-secret-not-production",
        TOKENINSIDE_GREENFIELD_CUTOVER_AT: "2020-01-01T00:00:00.000Z",
        NEWAPI_BASE_URL: baseUrl,
        NEWAPI_CONTROL_USER_ID: "42",
        NEWAPI_ACCESS_TOKEN: "test-control-credential",
        NEWAPI_ADMIN_ACCESS_TOKEN: "",
        NEWAPI_SYSTEM_AK: "",
        TOKENINSIDE_MOCK_NEWAPI: "false",
      };
      const migrated = await runScript("scripts/db-migrate.mjs", env);
      assert.equal(migrated.code, 0, migrated.stderr);
      const first = await runScript("scripts/greenfield-preflight.mjs", env);
      assert.equal(first.code, 0, first.stderr);
      assert.match(first.stdout, /"mode":"initial_binding_created"/);
      assert.deepEqual(calls, { identity: 1, tokens: 3, usage: 3 });
      const stored = await adminPool.query<{ data: Record<string, unknown> }>(
        `select data from "${schema}".greenfield_installation_manifest`,
      );
      assert.equal(stored.rowCount, 1);
      assert.equal(JSON.stringify(stored.rows[0].data).includes("credential"), false);
      assert.equal(JSON.stringify(stored.rows[0].data).includes("test-control"), false);

      await adminPool.query(
        `insert into "${schema}".feishu_users
          (id, tenant_key, open_id, department_id, data, created_at, updated_at)
         values (
           'business-user', 'tenant', 'open-business', null,
           '{"id":"business-user","tenantKey":"tenant","openId":"open-business","createdAt":"2020-01-01T00:00:00.000Z","updatedAt":"2020-01-01T00:00:00.000Z"}'::jsonb,
           '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'
         )`,
      );
      const second = await runScript("scripts/greenfield-preflight.mjs", env);
      assert.equal(second.code, 0, second.stderr);
      assert.match(second.stdout, /"mode":"binding_verified"/);
      assert.deepEqual(calls, { identity: 2, tokens: 3, usage: 3 });

      await adminPool.query(
        `delete from "${schema}".greenfield_installation_manifest`,
      );
      const missingWithFacts = await runScript(
        "scripts/greenfield-preflight.mjs",
        env,
      );
      assert.equal(missingWithFacts.code, 1);
      assert.match(missingWithFacts.stderr, /local business facts exist/);
      assert.deepEqual(calls, { identity: 2, tokens: 3, usage: 3 });

      await adminPool.query(`delete from "${schema}".feishu_users`);
      tokenMode = "polluted";
      const polluted = await runScript("scripts/greenfield-preflight.mjs", env);
      assert.equal(polluted.code, 1);
      assert.match(polluted.stderr, /NewAPI tokens is polluted/);
      const absent = await adminPool.query(
        `select count(*)::integer as count
         from "${schema}".greenfield_installation_manifest`,
      );
      assert.equal(absent.rows[0].count, 0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await adminPool
        .query(`drop schema if exists "${schema}" cascade`)
        .catch(() => undefined);
      await adminPool.end();
    }
  },
);
