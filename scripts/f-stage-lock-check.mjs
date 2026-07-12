import assert from "node:assert/strict";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const businessPoolMax = Number(process.env.DATABASE_POOL_MAX ?? "10");
const lockPoolMax = Number(process.env.DATABASE_LOCK_POOL_MAX ?? "10");
const connectionTimeoutMillis = Number(
  process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS ?? "5000",
);

const businessPool = new Pool({
  connectionString: databaseUrl,
  max: businessPoolMax,
  connectionTimeoutMillis,
});
const lockPool = new Pool({
  connectionString: databaseUrl,
  max: lockPoolMax,
  connectionTimeoutMillis,
});

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withAdvisoryLock(key, fn) {
  const client = await lockPool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext($1)::bigint)", [key]);
    return await fn();
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1)::bigint)", [key]);
    client.release();
  }
}

try {
  const parallelism = Math.max(2, Math.min(lockPoolMax, businessPoolMax, 6));
  const parallelStartedAt = Date.now();
  await withTimeout(
    Promise.all(
      Array.from({ length: parallelism }, (_, index) =>
        withAdvisoryLock(`f-stage-lock-check:user:${index}`, async () => {
          const result = await businessPool.query(
            "select $1::integer as worker, pg_sleep(0.1)",
            [index],
          );
          return result.rows[0]?.worker;
        }),
      ),
    ),
    connectionTimeoutMillis + 5000,
    "parallel lock/data-pool check",
  );
  const parallelDurationMs = Date.now() - parallelStartedAt;

  const order = [];
  await withTimeout(
    Promise.all([
      withAdvisoryLock("f-stage-lock-check:serial-user", async () => {
        order.push("first:start");
        await businessPool.query("select pg_sleep(0.2)");
        order.push("first:end");
      }),
      new Promise((resolve) => setTimeout(resolve, 25)).then(() =>
        withAdvisoryLock("f-stage-lock-check:serial-user", async () => {
          order.push("second:start");
          await businessPool.query("select 1");
          order.push("second:end");
        }),
      ),
    ]),
    connectionTimeoutMillis + 5000,
    "same-user serialization check",
  );
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);

  const health = await businessPool.query("select 1 as ok");
  assert.equal(health.rows[0]?.ok, 1);

  console.log(
    JSON.stringify({
      ok: true,
      businessPoolMax,
      lockPoolMax,
      parallelism,
      parallelDurationMs,
      sameUserOrder: order,
      businessPoolResponsive: true,
    }),
  );
} finally {
  await Promise.allSettled([businessPool.end(), lockPool.end()]);
}
