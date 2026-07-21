export type QuotaWriteAction =
  | "first_provision"
  | "quota_adjust"
  | "key_rotation"
  | "monthly_open";

const pausedValues = new Set(["1", "true", "yes", "on"]);

export class QuotaWritesPausedError extends Error {
  readonly code = "quota_writes_paused";
  readonly action: QuotaWriteAction;

  constructor(action: QuotaWriteAction) {
    super(`额度写入已由紧急只停写开关暂停: ${action}`);
    this.name = "QuotaWritesPausedError";
    this.action = action;
  }
}

export function quotaWritesPaused() {
  return pausedValues.has(
    (process.env.TOKENINSIDE_QUOTA_WRITES_PAUSED ?? "").trim().toLowerCase(),
  );
}

export async function assertQuotaWriteActionEnabled(action: QuotaWriteAction) {
  if (quotaWritesPaused()) {
    console.warn(
      JSON.stringify({
        event: "tokeninside.quota.writes_paused",
        action,
      }),
    );
    throw new QuotaWritesPausedError(action);
  }
}

export function quotaFeatureErrorStatus(error: unknown) {
  return error instanceof QuotaWritesPausedError ? 503 : undefined;
}
