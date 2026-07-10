const MIN_STREAM_RATE_WINDOW_MS = 250;

export type OutputRateInput = {
  completionTokens?: number;
  durationMs?: number;
  firstByteMs?: number;
  newapiUseTimeSeconds?: number;
  isStream?: boolean;
};

export function calculateOutputTokensPerSecond(input: OutputRateInput) {
  const output = input.completionTokens ?? 0;
  if (!Number.isFinite(output) || output <= 0) return undefined;

  let durationSeconds: number | undefined;
  if (Number.isFinite(input.newapiUseTimeSeconds) && (input.newapiUseTimeSeconds ?? 0) > 0) {
    durationSeconds = input.newapiUseTimeSeconds;
  } else if (input.isStream) {
    const streamDurationMs = Math.max(
      (input.durationMs ?? 0) - (input.firstByteMs ?? 0),
      0,
    );
    const selectedDurationMs =
      streamDurationMs >= MIN_STREAM_RATE_WINDOW_MS ? streamDurationMs : input.durationMs;
    if (Number.isFinite(selectedDurationMs) && (selectedDurationMs ?? 0) > 0) {
      durationSeconds = (selectedDurationMs as number) / 1000;
    }
  } else if (Number.isFinite(input.durationMs) && (input.durationMs ?? 0) > 0) {
    durationSeconds = (input.durationMs as number) / 1000;
  }

  if (!durationSeconds || !Number.isFinite(durationSeconds)) return undefined;
  const rate = output / durationSeconds;
  return Number.isFinite(rate) && rate >= 0 ? rate : undefined;
}
