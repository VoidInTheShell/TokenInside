import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const runtimePath = new URL("../lib/newapi-runtime.ts", import.meta.url);
const postgresPath = new URL("../lib/postgres-store.ts", import.meta.url);

type RuntimeApi = {
  getEffectiveNewApiConfig(): Promise<{
    baseUrl: string;
    controlUserId?: string;
    accessToken?: string;
  }>;
  invalidateEffectiveNewApiConfig(): void;
};

async function loadRuntimeHarness(settings: Record<string, unknown>) {
  const source = await readFile(runtimePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: "newapi-runtime.ts",
  }).outputText;
  let reads = 0;
  const module = { exports: {} as RuntimeApi };
  const imports: Record<string, Record<string, unknown>> = {
    "@/lib/config": {
      getConfig: () => ({
        newapi: {
          baseUrl: "https://newapi.example.com",
          publicBaseUrl: "https://newapi.example.com",
          controlUserId: "42",
          accessToken: "environment-credential",
          quotaPerUnit: 500000,
          requestTimeoutMs: 15000,
          mock: false,
        },
      }),
    },
    "@/lib/secret-box": { openAppSecret: () => "stored-credential" },
    "@/lib/store": {
      getNewApiRuntimeBindingSnapshot: async () => {
        reads += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { settings };
      },
    },
  };
  runInNewContext(transpiled, {
    module,
    exports: module.exports,
    require: (specifier: string) => {
      const dependency = imports[specifier];
      if (!dependency) throw new Error(`unexpected runtime import: ${specifier}`);
      return dependency;
    },
    globalThis: {},
    fetch,
    Headers,
    AbortSignal,
    setTimeout,
    clearTimeout,
    console,
  });
  return {
    api: module.exports,
    get reads() {
      return reads;
    },
  };
}

test("concurrent runtime reads share one settings query until invalidated", async () => {
  const harness = await loadRuntimeHarness({
    defaultMonthlyQuota: 200,
    newapiControl: {
      baseUrl: "https://control.example.com/",
      controlUserId: "77",
      accessTokenCiphertext: "sealed",
    },
  });
  const first = await Promise.all(
    Array.from({ length: 200 }, () => harness.api.getEffectiveNewApiConfig()),
  );
  assert.equal(harness.reads, 1);
  assert.equal(first[0].baseUrl, "https://control.example.com");
  assert.equal(first[0].controlUserId, "77");
  assert.equal(first[0].accessToken, "stored-credential");
  await Promise.all(
    Array.from({ length: 200 }, () => harness.api.getEffectiveNewApiConfig()),
  );
  assert.equal(harness.reads, 1);
  harness.api.invalidateEffectiveNewApiConfig();
  await Promise.all(
    Array.from({ length: 200 }, () => harness.api.getEffectiveNewApiConfig()),
  );
  assert.equal(harness.reads, 2);
});

test("runtime settings snapshot uses one control query", async () => {
  const [runtime, postgres] = await Promise.all([
    readFile(runtimePath, "utf8"),
    readFile(postgresPath, "utf8"),
  ]);
  assert.match(runtime, /getNewApiRuntimeBindingSnapshot/);
  assert.match(runtime, /refreshPromise/);
  assert.match(runtime, /runtime\.cached/);
  assert.doesNotMatch(runtime, /greenfield|manifest/i);
  assert.match(postgres, /getPostgresNewApiRuntimeBindingSnapshot/);
  assert.match(postgres, /select data as settings[\s\S]*?from app_settings/);
});
