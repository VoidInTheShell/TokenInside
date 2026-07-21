export type UserAccessRevocationBarrier = {
  upstreamDisabledAt?: string;
  consumptionBarrierCutoffAt?: string;
};

export function preserveUserAccessRevocationBarrier(
  input: UserAccessRevocationBarrier,
  existing?: UserAccessRevocationBarrier & { closedReason?: string },
): UserAccessRevocationBarrier {
  const preserveExisting = existing?.closedReason === "user_access_revoked";
  return {
    upstreamDisabledAt:
      input.upstreamDisabledAt ??
      (preserveExisting ? existing.upstreamDisabledAt : undefined),
    consumptionBarrierCutoffAt:
      input.consumptionBarrierCutoffAt ??
      (preserveExisting ? existing.consumptionBarrierCutoffAt : undefined),
  };
}

type AccessRecoveryUser = {
  status?: "active" | "disabled" | "deleted";
} | null | undefined;

type AccessRecoveryQuotaState = {
  admission: "open" | "closed";
  closedReason?: string;
} | null | undefined;

export function shouldRestoreIssuedUpstreamAfterFailedAccessRevoke(input: {
  user: AccessRecoveryUser;
  quotaState: AccessRecoveryQuotaState;
}) {
  const userIsStillActive =
    Boolean(input.user) &&
    (!input.user?.status || input.user.status === "active");
  return (
    userIsStillActive &&
    input.quotaState?.closedReason !== "user_access_revoked"
  );
}

export function isPendingUserAccessResume(input: {
  user: AccessRecoveryUser;
  quotaState: AccessRecoveryQuotaState;
  accountStatus?: string;
}) {
  return (
    input.user?.status === "active" &&
    input.accountStatus === "active" &&
    input.quotaState?.admission === "closed" &&
    input.quotaState.closedReason === "user_access_resume_pending"
  );
}

export function isCompletedUserAccessResume(input: {
  user: AccessRecoveryUser;
  quotaState: AccessRecoveryQuotaState;
  accountStatus?: string;
}) {
  return (
    input.user?.status === "active" &&
    input.accountStatus === "active" &&
    input.quotaState?.admission === "open"
  );
}
