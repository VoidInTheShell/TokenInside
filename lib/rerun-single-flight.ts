type RerunSingleFlightEntry<Input, Result> = {
  input: Input;
  rerun: boolean;
  promise: Promise<Result>;
};

/**
 * Coalesce equal work while guaranteeing that every caller which arrives
 * during a run causes one final pass after that caller's preceding writes.
 */
export function createRerunSingleFlight<Input, Result>(
  keyOf: (input: Input) => string,
  run: (input: Input) => Promise<Result>,
) {
  const entries = new Map<string, RerunSingleFlightEntry<Input, Result>>();

  return (input: Input) => {
    const key = keyOf(input);
    const existing = entries.get(key);
    if (existing) {
      existing.input = input;
      existing.rerun = true;
      return existing.promise;
    }

    const entry: RerunSingleFlightEntry<Input, Result> = {
      input,
      rerun: false,
      promise: undefined as unknown as Promise<Result>,
    };
    entry.promise = (async () => {
      try {
        for (;;) {
          entry.rerun = false;
          const result = await run(entry.input);
          if (entry.rerun) continue;

          // Delete before returning, without an await between the state check
          // and deletion. A trailing caller therefore either requests a rerun
          // above or observes no entry and starts a fresh authoritative pass.
          if (entries.get(key) === entry) entries.delete(key);
          return result;
        }
      } catch (error) {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      }
    })();
    entries.set(key, entry);
    return entry.promise;
  };
}
