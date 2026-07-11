import type { TokenAccount, UserQuotaState } from "./types";

export class QuotaAdmissionClosedError extends Error {
  readonly code = "quota_admission_closed";
  readonly operationId?: string;

  constructor(state: UserQuotaState) {
    super("额度操作正在结算，请稍后重试");
    this.name = "QuotaAdmissionClosedError";
    this.operationId = state.operationId;
  }
}

export class StaleTokenGenerationError extends Error {
  readonly code = "stale_token_generation";

  constructor() {
    super("当前 Key 已不属于活动额度代际");
    this.name = "StaleTokenGenerationError";
  }
}

export function assertQuotaAdmission(state: UserQuotaState, account: TokenAccount) {
  if (state.admission !== "open") throw new QuotaAdmissionClosedError(state);
  const accountGeneration = account.operationGeneration ?? 0;
  if (accountGeneration !== state.activeGeneration) throw new StaleTokenGenerationError();
}
