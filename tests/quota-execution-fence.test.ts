import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertQuotaExecutionFenceHeld,
  createQuotaExecutionFence,
  isQuotaExecutionFenceLostError,
  runWithQuotaExecutionFence,
} from "../lib/quota-execution-fence.ts";

const postgresStorePath = new URL("../lib/postgres-store.ts", import.meta.url);
const migrationPath = new URL("../scripts/db-migrate.mjs", import.meta.url);
const newApiPath = new URL("../lib/newapi.ts", import.meta.url);
const sagaPath = new URL("../lib/quota-saga.ts", import.meta.url);
const usageSyncPath = new URL("../lib/usage-sync.ts", import.meta.url);

test("quota execution fence fails closed across async descendants", async () => {
  const fence = createQuotaExecutionFence("user-quota-fence:fu_test");
  await runWithQuotaExecutionFence(fence, async () => {
    assertQuotaExecutionFenceHeld();
    await Promise.resolve();
    fence.markLost(new Error("lock connection closed"));
    assert.throws(
      () => assertQuotaExecutionFenceHeld(),
      (error) => isQuotaExecutionFenceLostError(error),
    );
  });
  assert.equal(fence.lost, true);
  assert.doesNotThrow(() => assertQuotaExecutionFenceHeld());

  const completedFence = createQuotaExecutionFence("user-quota-fence:fu_complete");
  let afterScopeError: unknown;
  const detached = new Promise<void>((resolve) => {
    void runWithQuotaExecutionFence(completedFence, async () => {
      setTimeout(() => {
        try {
          assertQuotaExecutionFenceHeld();
        } catch (error) {
          afterScopeError = error;
        }
        resolve();
      }, 0);
    });
  });
  completedFence.close();
  await detached;
  assert.equal(isQuotaExecutionFenceLostError(afterScopeError), true);
});

test("quota execution ownership uses DB-time scalar leases and a live session guard", async () => {
  const [postgres, migration, newapi, saga, usageSync] = await Promise.all([
    readFile(postgresStorePath, "utf8"),
    readFile(migrationPath, "utf8"),
    readFile(newApiPath, "utf8"),
    readFile(sagaPath, "utf8"),
    readFile(usageSyncPath, "utf8"),
  ]);

  assert.match(migration, /worker_lease_id text/);
  assert.match(migration, /worker_lease_expires_at timestamptz/);
  assert.match(migration, /quota_operations_worker_lease_pair_check/);
  assert.match(postgres, /worker_lease_expires_at <= statement_timestamp\(\)/);
  assert.match(postgres, /worker_lease_expires_at > statement_timestamp\(\)/);
  assert.match(postgres, /\$3::bigint \* interval '1 millisecond'/);
  assert.match(postgres, /client\.on\("error", onClientError\)/);
  assert.match(postgres, /client\.on\("end", onClientEnd\)/);
  assert.match(postgres, /PostgreSQL 栅栏心跳超时/);
  assert.match(postgres, /fence\?\.close\(\)/);
  assert.match(postgres, /where id = \$1 and worker_lease_id = \$2/);
  assert.match(postgres, /data - 'workerLeaseId' - 'workerLeaseExpiresAt'/);
  assert.match(postgres, /setInterval\(\(\) => \{/);
  assert.match(postgres, /runWithQuotaExecutionFence\(fence/);
  assert.match(postgres, /assertQuotaExecutionFenceHeld\(\);[\s\S]*client\.query\("commit"\)/);
  assert.match(newapi, /assertQuotaExecutionFenceHeld\(\);[\s\S]*await fetch/);
  assert.match(newapi, /await res\.text\(\)[\s\S]*assertQuotaExecutionFenceHeld\(\)/);
  assert.match(saga, /if \(!renewed\)[\s\S]*executionFence\?\.markLost/);
  assert.match(saga, /if \(inFlightRenewal\) await inFlightRenewal/);
  assert.match(saga, /isQuotaExecutionFenceLostError\(error\)/);
  assert.match(usageSync, /withPostgresAdvisoryLock\(usageSyncLockKey, fn, \{\s*executionFence: true/);
  assert.match(usageSync, /await finalizeBackfillBillingPeriods\(/);
  assert.doesNotMatch(usageSync, /observeUsageSyncBillingPeriodFinalization/);
});
