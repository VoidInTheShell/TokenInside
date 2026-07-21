import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  greenfieldInstallationManifestHash,
  verifyGreenfieldInstallationBinding,
} from "../lib/greenfield-installation.ts";

const runtimePath = new URL("../lib/newapi-runtime.ts", import.meta.url);
const postgresPath = new URL("../lib/postgres-store.ts", import.meta.url);

type RuntimeApi = {
  getEffectiveNewApiConfig(): Promise<{
    baseUrl: string;
    controlUserId?: string;
  }>;
  invalidateEffectiveNewApiConfig(): void;
};

async function loadRuntimeHarness(input: { manifest: Record<string, unknown> | null }) {
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
        storeBackend: "postgres",
        newapi: {
          baseUrl: "https://newapi.example.com",
          controlUserId: "42",
          accessToken: "credential",
          quotaPerUnit: 500000,
          requestTimeoutMs: 15000,
          mock: false,
        },
      }),
    },
    "@/lib/greenfield-installation": { verifyGreenfieldInstallationBinding },
    "@/lib/secret-box": { openAppSecret: () => "stored-credential" },
    "@/lib/store": {
      getNewApiRuntimeBindingSnapshot: async () => {
        reads += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          settings: { defaultMonthlyQuota: 200 },
          manifest: input.manifest,
        };
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

function validManifest() {
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

test("200 concurrent runtime config reads share one durable binding query until invalidated", async () => {
  const harness = await loadRuntimeHarness({ manifest: validManifest() });
  const first = await Promise.all(
    Array.from({ length: 200 }, () => harness.api.getEffectiveNewApiConfig()),
  );
  assert.equal(first.length, 200);
  assert.equal(harness.reads, 1);
  await Promise.all(
    Array.from({ length: 200 }, () => harness.api.getEffectiveNewApiConfig()),
  );
  assert.equal(harness.reads, 1, "a successful binding has no five-second refresh spike");
  harness.api.invalidateEffectiveNewApiConfig();
  await Promise.all(
    Array.from({ length: 200 }, () => harness.api.getEffectiveNewApiConfig()),
  );
  assert.equal(harness.reads, 2);
});

test("a missing manifest fails a concurrent runtime wave closed with one query", async () => {
  const harness = await loadRuntimeHarness({ manifest: null });
  const results = await Promise.allSettled(
    Array.from({ length: 200 }, () => harness.api.getEffectiveNewApiConfig()),
  );
  assert.equal(results.every((result) => result.status === "rejected"), true);
  assert.equal(harness.reads, 1);
});

test("runtime binding snapshot combines settings and manifest in one control query", async () => {
  const [runtime, postgres] = await Promise.all([
    readFile(runtimePath, "utf8"),
    readFile(postgresPath, "utf8"),
  ]);
  assert.match(runtime, /getNewApiRuntimeBindingSnapshot/);
  assert.match(runtime, /refreshPromise/);
  assert.match(runtime, /runtime\.cached/);
  assert.doesNotMatch(runtime, /cacheTtlMs|expiresAt/);
  assert.match(postgres, /getPostgresNewApiRuntimeBindingSnapshot/);
  assert.match(
    postgres,
    /select settings\.data as settings, manifest\.data as manifest/,
  );
});
