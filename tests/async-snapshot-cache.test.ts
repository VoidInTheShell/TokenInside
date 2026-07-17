import assert from "node:assert/strict";
import test from "node:test";
import { createAsyncSnapshotCache } from "../lib/async-snapshot-cache.ts";

test("snapshot cache shares a cold flight and reuses the fresh value", async () => {
  let now = 1_000;
  let loads = 0;
  let release!: (value: number) => void;
  const cache = createAsyncSnapshotCache<string, number>({
    freshMs: 5_000,
    staleMs: 30_000,
    now: () => now,
  });
  const load = () => {
    loads += 1;
    return new Promise<number>((resolve) => {
      release = resolve;
    });
  };

  const first = cache.get("global", load);
  const second = cache.get("global", load);
  release(42);
  const [cold, shared] = await Promise.all([first, second]);

  assert.equal(loads, 1);
  assert.equal(cold.state, "miss");
  assert.equal(shared.state, "shared");
  assert.equal(cold.value, 42);
  now += 4_000;
  assert.deepEqual(await cache.get("global", load), {
    value: 42,
    loadedAtMs: 1_000,
    state: "fresh",
  });
  assert.equal(loads, 1);
});

test("stale reads return immediately and start exactly one background refresh", async () => {
  let now = 0;
  let loads = 0;
  const resolvers: Array<(value: number) => void> = [];
  const cache = createAsyncSnapshotCache<string, number>({
    freshMs: 5_000,
    staleMs: 30_000,
    now: () => now,
  });
  const load = () => {
    loads += 1;
    return new Promise<number>((resolve) => resolvers.push(resolve));
  };

  const initial = cache.get("global", load);
  resolvers.shift()!(1);
  await initial;
  now = 6_000;

  const [firstStale, secondStale] = await Promise.all([
    cache.get("global", load),
    cache.get("global", load),
  ]);
  assert.equal(firstStale.state, "stale");
  assert.equal(secondStale.state, "stale");
  assert.equal(firstStale.value, 1);
  assert.equal(loads, 2);

  resolvers.shift()!(2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await cache.get("global", load), {
    value: 2,
    loadedAtMs: 6_000,
    state: "fresh",
  });
});

test("a failed background refresh keeps the last successful stale snapshot", async () => {
  let now = 0;
  let fail = false;
  let loads = 0;
  const cache = createAsyncSnapshotCache<string, number>({
    freshMs: 5_000,
    staleMs: 30_000,
    now: () => now,
  });
  const load = async () => {
    loads += 1;
    if (fail) throw new Error("refresh failed");
    return 7;
  };

  await cache.get("global", load);
  now = 6_000;
  fail = true;
  assert.equal((await cache.get("global", load)).value, 7);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await cache.get("global", load)).value, 7);
  assert.equal(loads, 3, "a later stale read may retry after the failed refresh");
});
