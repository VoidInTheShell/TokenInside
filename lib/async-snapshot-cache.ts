export type AsyncSnapshotCacheState = "fresh" | "stale" | "miss" | "shared";

export type AsyncSnapshot<T> = {
  value: T;
  loadedAtMs: number;
  state: AsyncSnapshotCacheState;
};

type SnapshotValue<T> = {
  value: T;
  loadedAtMs: number;
};

export function createAsyncSnapshotCache<Key, Value>(options: {
  freshMs: number;
  staleMs: number;
  maxEntries?: number;
  now?: () => number;
}) {
  const freshMs = Math.max(Math.trunc(options.freshMs), 0);
  const staleMs = Math.max(Math.trunc(options.staleMs), freshMs);
  const maxEntries = Math.max(Math.trunc(options.maxEntries ?? 256), 1);
  const now = options.now ?? Date.now;
  const values = new Map<Key, SnapshotValue<Value>>();
  const flights = new Map<Key, Promise<SnapshotValue<Value>>>();

  function retainBounded(key: Key, snapshot: SnapshotValue<Value>) {
    if (!values.has(key) && values.size >= maxEntries) {
      let oldestKey: Key | undefined;
      let oldestLoadedAt = Number.POSITIVE_INFINITY;
      for (const [candidateKey, candidate] of values) {
        if (candidate.loadedAtMs < oldestLoadedAt) {
          oldestKey = candidateKey;
          oldestLoadedAt = candidate.loadedAtMs;
        }
      }
      if (oldestKey !== undefined) values.delete(oldestKey);
    }
    values.set(key, snapshot);
  }

  function startLoad(key: Key, load: () => Promise<Value>) {
    const pending = load().then((value) => {
      const snapshot = { value, loadedAtMs: now() };
      retainBounded(key, snapshot);
      return snapshot;
    });
    flights.set(key, pending);
    void pending.finally(() => {
      if (flights.get(key) === pending) flights.delete(key);
    }).catch(() => undefined);
    return pending;
  }

  return {
    async get(key: Key, load: () => Promise<Value>): Promise<AsyncSnapshot<Value>> {
      const cached = values.get(key);
      const ageMs = cached ? Math.max(now() - cached.loadedAtMs, 0) : Number.POSITIVE_INFINITY;
      if (cached && ageMs <= freshMs) {
        return { ...cached, state: "fresh" };
      }

      if (cached && ageMs <= staleMs) {
        if (!flights.has(key)) {
          // Stale dashboard data is safe to serve because it is never used as
          // an authorization, quota, or billing write precondition. Refresh
          // failures deliberately retain the last successful snapshot.
          void startLoad(key, load).catch(() => undefined);
        }
        return { ...cached, state: "stale" };
      }

      const shared = flights.get(key);
      const snapshot = await (shared ?? startLoad(key, load));
      return { ...snapshot, state: shared ? "shared" : "miss" };
    },
    clear(key?: Key) {
      if (key === undefined) {
        values.clear();
        return;
      }
      values.delete(key);
    },
  };
}
