import assert from "node:assert/strict";
import test from "node:test";
import { createRerunSingleFlight } from "../lib/rerun-single-flight.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a caller arriving during a run shares the promise and forces a final rerun", async () => {
  const gates = [deferred<number>(), deferred<number>()];
  let runs = 0;
  const request = createRerunSingleFlight(
    (key: string) => key,
    () => {
      const run = runs;
      runs += 1;
      return gates[run].promise;
    },
  );

  const first = request("department:period");
  const concurrent = request("department:period");
  assert.strictEqual(concurrent, first);
  gates[0].resolve(1);
  await Promise.resolve();
  assert.equal(runs, 2);
  gates[1].resolve(2);
  assert.deepEqual(await Promise.all([first, concurrent]), [2, 2]);
});

test("a tail caller after the final await starts a fresh run instead of joining a stale entry", async () => {
  const gates = [deferred<number>(), deferred<number>()];
  let runs = 0;
  const request = createRerunSingleFlight(
    (key: string) => key,
    () => {
      const run = runs;
      runs += 1;
      return gates[run].promise;
    },
  );

  const first = request("department:period");
  gates[0].resolve(1);
  // The run continuation deletes its Map entry synchronously before this
  // continuation. The former `.finally(delete)` implementation deleted later.
  await Promise.resolve();
  const tail = request("department:period");
  assert.notStrictEqual(tail, first);
  assert.equal(runs, 2);
  gates[1].resolve(2);
  assert.deepEqual(await Promise.all([first, tail]), [1, 2]);
});
