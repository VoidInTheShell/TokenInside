import {
  disableNewApiTokenAndVerify,
  enableNewApiTokenAndVerify,
} from "@/lib/newapi";
import {
  authorizeAdminUserActionUnderScopeLocks,
  enableUserAccessUnderUserFence,
  finalizeUserAccessResumeUnderUserFence,
  getUserById,
  getUserQuotaState,
  listStaleUserAccessResumeCandidates,
  listTokenAccountsForUser,
  markUserAccessResumeEnableAttemptUnderUserFence,
  rollbackUserAccessResumeUnderUserFence,
  updateUserAccessStatusUnderUserFence,
  withAdminScopeUserLocks,
  withUserQuotaOperationLock,
} from "@/lib/store";
import { getConfig } from "@/lib/config";
import { nowIso } from "@/lib/crypto";
import {
  assertAdminScopeAllowsUserTarget,
  isAdminUserActionAuthorizationError,
} from "@/lib/postgres-store";
import {
  isCompletedUserAccessResume,
  isPendingUserAccessResume,
  shouldRestoreIssuedUpstreamAfterFailedAccessRevoke,
} from "@/lib/user-access-state";
import type { AdminScope, FeishuUser, TokenAccount, TokenStatus } from "@/lib/types";

const operationalStatuses = new Set<TokenStatus>([
  "pending_activation",
  "active",
  "draining",
  "settling",
]);

const issuedStatuses = new Set<TokenStatus>(["active", "draining", "settling"]);
const staleResumeRecoveryAgeMs = 15_000;
const staleResumeRecoveryIntervalMs = 15_000;
const staleResumeRecoveryLimit = 25;
const staleResumeRecoveryConcurrency = 4;

type UserAccessRecoveryRuntime = {
  version: 1;
  started: boolean;
  running: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

type UserAccessRecoveryGlobal = typeof globalThis & {
  __tokenInsideUserAccessRecoveryRuntimeV1?: UserAccessRecoveryRuntime;
};

const userAccessRecoveryGlobal = globalThis as UserAccessRecoveryGlobal;
const userAccessRecoveryRuntime =
  (userAccessRecoveryGlobal.__tokenInsideUserAccessRecoveryRuntimeV1 ??= {
    version: 1,
    started: false,
    running: false,
  });

export class UserAccessControlError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UserAccessControlError";
  }
}

export function isUserAccessControlError(
  error: unknown,
): error is UserAccessControlError {
  return error instanceof UserAccessControlError;
}

export function assertAdminUserActionTargetAllowed(input: {
  actorFeishuUserId: string;
  scope: AdminScope;
  targetUser: FeishuUser;
  destructiveAccessRevoke?: boolean;
}) {
  try {
    assertAdminScopeAllowsUserTarget(input.scope, input.targetUser, {
      actorFeishuUserId: input.actorFeishuUserId,
      destructiveAccessRevoke: input.destructiveAccessRevoke,
      // The exact last-root count is revalidated under the durable store lock.
      // Non-destructive route guards only need the canonical root-only check.
      activeEnvironmentRootCount: Number.POSITIVE_INFINITY,
    });
  } catch (error) {
    throw accessControlError(error);
  }
}

function accessControlError(error: unknown) {
  if (isAdminUserActionAuthorizationError(error)) {
    return new UserAccessControlError(error.status, error.code, error.message);
  }
  return error;
}

async function runWithCurrentAdminAuthorization<T>(
  input: {
    actorFeishuUserId: string;
    targetFeishuUserId: string;
    destructiveAccessRevoke?: boolean;
  },
  fn: (targetUser: FeishuUser) => Promise<T>,
) {
  try {
    return await withAdminScopeUserLocks(
      [input.actorFeishuUserId, input.targetFeishuUserId],
      async () => {
        const authorized = await authorizeAdminUserActionUnderScopeLocks(input);
        if (!authorized) {
          throw new UserAccessControlError(
            404,
            "user_not_found",
            "目标用户不存在",
          );
        }
        return fn(authorized.targetUser);
      },
    );
  } catch (error) {
    throw accessControlError(error);
  }
}

function latestDisabledAccount(accounts: TokenAccount[]) {
  return [...accounts]
    .filter((account) => account.status === "disabled")
    .sort((a, b) =>
      (b.disabledAt ?? b.createdAt).localeCompare(a.disabledAt ?? a.createdAt),
    )[0] ?? null;
}

type UpstreamAccountIdentity = Pick<
  TokenAccount,
  "id" | "feishuUserId" | "newapiTokenId"
>;

async function restoreIssuedAccountsAfterFailedSuspend(
  feishuUserId: string,
  attemptedAccounts: UpstreamAccountIdentity[],
) {
  const uniqueAccounts = [
    ...new Map(
      attemptedAccounts.map((account) => [account.id, account]),
    ).values(),
  ];
  if (uniqueAccounts.length === 0) {
    return { status: "nothing_to_restore" as const };
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await withUserQuotaOperationLock(feishuUserId, async (fence) => {
        fence?.assertHeld();
        const [user, quotaState, currentAccounts] = await Promise.all([
          getUserById(feishuUserId),
          getUserQuotaState(feishuUserId),
          listTokenAccountsForUser(feishuUserId),
        ]);
        fence?.assertHeld();
        if (
          !shouldRestoreIssuedUpstreamAfterFailedAccessRevoke({
            user,
            quotaState,
          })
        ) {
          return { status: "local_revoke_committed" as const };
        }

        const currentById = new Map(
          currentAccounts.map((account) => [account.id, account]),
        );
        const restorable = uniqueAccounts.filter((attempted) => {
          const current = currentById.get(attempted.id);
          if (!current) return false;
          return (
            current.newapiTokenId === attempted.newapiTokenId &&
            issuedStatuses.has(current.status)
          );
        });
        const failures: unknown[] = [];
        for (const account of restorable) {
          try {
            fence?.assertHeld();
            await enableNewApiTokenAndVerify(account.newapiTokenId!);
          } catch (error) {
            failures.push(error);
          }
        }
        fence?.assertHeld();
        if (failures.length > 0) {
          throw new Error(
            `${failures.length} 个上游 Key 恢复失败`,
            { cause: failures[0] },
          );
        }
        return { status: "restored" as const, count: restorable.length };
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function compensateFailedResume(
  feishuUserId: string,
  expectedAccount: UpstreamAccountIdentity,
  options: { waitForFence?: boolean } = {},
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await withUserQuotaOperationLock(feishuUserId, async (fence) => {
        fence?.assertHeld();
        const [user, quotaState, accounts] = await Promise.all([
          getUserById(feishuUserId),
          getUserQuotaState(feishuUserId),
          listTokenAccountsForUser(feishuUserId),
        ]);
        fence?.assertHeld();
        const account = accounts.find(
          (item) =>
            item.id === expectedAccount.id &&
            item.newapiTokenId === expectedAccount.newapiTokenId,
        );
        if (
          isCompletedUserAccessResume({
            user,
            quotaState,
            accountStatus: account?.status,
          })
        ) {
          return {
            status: "already_completed" as const,
            result: { user: user!, tokenAccount: account!, quotaState },
          };
        }
        if (
          !account?.newapiTokenId ||
          !isPendingUserAccessResume({
            user,
            quotaState,
            accountStatus: account.status,
          })
        ) {
          return { status: "state_already_fail_closed" as const };
        }

        await disableNewApiTokenAndVerify(account.newapiTokenId);
        fence?.assertHeld();
        const upstreamDisabledAt = nowIso();
        const consumptionBarrierCutoffAt = new Date(
          Date.parse(upstreamDisabledAt) +
            getConfig().quotaControl.directConsumptionDrainGraceMs,
        ).toISOString();
        const rolledBack = await rollbackUserAccessResumeUnderUserFence({
          feishuUserId,
          expectedTokenAccountId: account.id,
          upstreamDisabledAt,
          consumptionBarrierCutoffAt,
          reason: "上游 Key 启用后本地恢复未完成，已自动回滚",
        });
        fence?.assertHeld();
        if (rolledBack) {
          return { status: "rolled_back" as const, result: rolledBack };
        }

        // Defensive CAS-miss handling: a completed finalizer must win. Since
        // the Key was just disabled, restore it before returning the durable
        // open projection to the caller.
        const [currentUser, currentState, currentAccounts] = await Promise.all([
          getUserById(feishuUserId),
          getUserQuotaState(feishuUserId),
          listTokenAccountsForUser(feishuUserId),
        ]);
        const currentAccount = currentAccounts.find(
          (item) =>
            item.id === expectedAccount.id &&
            item.newapiTokenId === expectedAccount.newapiTokenId,
        );
        if (
          currentAccount?.newapiTokenId &&
          isCompletedUserAccessResume({
            user: currentUser,
            quotaState: currentState,
            accountStatus: currentAccount.status,
          })
        ) {
          await enableNewApiTokenAndVerify(currentAccount.newapiTokenId);
          fence?.assertHeld();
          return {
            status: "already_completed" as const,
            result: {
              user: currentUser!,
              tokenAccount: currentAccount,
              quotaState: currentState,
            },
          };
        }
        if (
          currentUser?.status === "disabled" &&
          currentState.closedReason === "user_access_revoked"
        ) {
          return { status: "rolled_back" as const };
        }
        throw new Error("用户恢复安全回滚 CAS 失败，当前状态不明确");
      }, { wait: options.waitForFence ?? true });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function suspendUserAccess(input: {
  actorFeishuUserId: string;
  feishuUserId: string;
  status: "disabled" | "deleted";
  reason?: string;
  tokenStatus: Extract<TokenStatus, "disabled" | "revoked">;
  adminRevokedByFeishuUserId?: string;
  requireIssuedToken?: boolean;
}) {
  const attemptedIssuedAccounts: UpstreamAccountIdentity[] = [];
  try {
    return await runWithCurrentAdminAuthorization(
      {
        actorFeishuUserId: input.actorFeishuUserId,
        targetFeishuUserId: input.feishuUserId,
        destructiveAccessRevoke: true,
      },
      () =>
        withUserQuotaOperationLock(input.feishuUserId, async (fence) => {
          fence?.assertHeld();
          const allAccounts = await listTokenAccountsForUser(input.feishuUserId);
          const accounts = allAccounts.filter((account) =>
            input.status === "deleted"
              ? Boolean(account.newapiTokenId) && account.status !== "revoked"
              : operationalStatuses.has(account.status),
          );
          if (
            input.requireIssuedToken &&
            !accounts.some((account) => issuedStatuses.has(account.status))
          ) {
            throw new UserAccessControlError(
              409,
              "issued_token_required",
              "目标用户没有可禁用的已发放 NewAPI Key",
            );
          }

          for (const account of accounts) {
            if (!account.newapiTokenId) continue;
            // Record before the remote mutation. A transport/fence error may
            // happen after NewAPI committed the disable but before it replied.
            if (issuedStatuses.has(account.status)) {
              attemptedIssuedAccounts.push(account);
            }
            await disableNewApiTokenAndVerify(account.newapiTokenId);
          }
          const upstreamDisabledAt = accounts.some(
            (account) => account.newapiTokenId,
          )
            ? nowIso()
            : undefined;
          const consumptionBarrierCutoffAt = upstreamDisabledAt
            ? new Date(
                Date.parse(upstreamDisabledAt) +
                  getConfig().quotaControl.directConsumptionDrainGraceMs,
              ).toISOString()
            : undefined;
          fence?.assertHeld();
          const result = await updateUserAccessStatusUnderUserFence({
            ...input,
            upstreamDisabledAt,
            consumptionBarrierCutoffAt,
            adminScopeLocksHeld: true,
          });
          if (!result) {
            throw new UserAccessControlError(
              409,
              "user_state_changed",
              "目标用户状态已变化，未完成访问撤销",
            );
          }
          return result;
        }),
    );
  } catch (error) {
    try {
      await restoreIssuedAccountsAfterFailedSuspend(
        input.feishuUserId,
        attemptedIssuedAccounts,
      );
    } catch (compensationError) {
      throw new Error(
        `访问撤销失败，且上游 Key 恢复失败: ${
          compensationError instanceof Error
            ? compensationError.message
            : "unknown compensation failure"
        }`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function resumeUserAccess(input: {
  actorFeishuUserId: string;
  feishuUserId: string;
  reason?: string;
}) {
  let recoveryAccount: UpstreamAccountIdentity | null = null;
  let upstreamEnableAttempted = false;
  const run = () =>
    runWithCurrentAdminAuthorization(
      {
        actorFeishuUserId: input.actorFeishuUserId,
        targetFeishuUserId: input.feishuUserId,
      },
      (targetUser) =>
        withUserQuotaOperationLock(input.feishuUserId, async (fence) => {
          fence?.assertHeld();
          let user = targetUser;
          let accounts = await listTokenAccountsForUser(input.feishuUserId);
          let account: TokenAccount | null = null;
          if (user.status === "disabled") {
            account = latestDisabledAccount(accounts);
            if (!account?.newapiTokenId) {
              throw new UserAccessControlError(
                409,
                "disabled_token_required",
                "目标用户没有可启用的 disabled NewAPI Key",
              );
            }
            const prepared = await enableUserAccessUnderUserFence({
              actorFeishuUserId: input.actorFeishuUserId,
              feishuUserId: input.feishuUserId,
              reason: input.reason,
              expectedTokenAccountId: account.id,
              adminScopeLocksHeld: true,
            });
            if (!prepared) {
              throw new UserAccessControlError(
                409,
                "user_state_changed",
                "目标用户状态已变化，无法准备启用",
              );
            }
            user = prepared.user;
            account = prepared.tokenAccount;
          } else if (user.status === "active") {
            const quotaState = await getUserQuotaState(input.feishuUserId);
            if (
              quotaState.admission === "closed" &&
              quotaState.closedReason === "user_access_resume_pending"
            ) {
              account = accounts.find((item) => item.status === "active") ?? null;
            }
          }
          if (!account?.newapiTokenId || user.status !== "active") {
            throw new UserAccessControlError(
              409,
              "user_not_resumable",
              "当前用户不处于可恢复的禁用或启用中状态",
            );
          }

          recoveryAccount = account;
          upstreamEnableAttempted = true;
          const attempted =
            await markUserAccessResumeEnableAttemptUnderUserFence({
              feishuUserId: input.feishuUserId,
              expectedTokenAccountId: account.id,
            });
          if (!attempted) {
            throw new UserAccessControlError(
              409,
              "resume_attempt_state_changed",
              "目标用户恢复状态已变化，未启用上游 Key",
            );
          }
          fence?.assertHeld();
          // Set this before the remote call: NewAPI can commit the enable and
          // lose the response or the session fence immediately afterwards.
          await enableNewApiTokenAndVerify(account.newapiTokenId);
          fence?.assertHeld();
          const finalized = await finalizeUserAccessResumeUnderUserFence({
            actorFeishuUserId: input.actorFeishuUserId,
            feishuUserId: input.feishuUserId,
            expectedTokenAccountId: account.id,
            adminScopeLocksHeld: true,
          });
          if (!finalized) {
            throw new UserAccessControlError(
              409,
              "resume_finalize_failed",
              "上游 Key 已启用，但本地准入尚未开放；请重试完成恢复",
            );
          }
          return finalized;
        }),
    );

  try {
    return await run();
  } catch (firstError) {
    if (
      !upstreamEnableAttempted &&
      isUserAccessControlError(firstError) &&
      firstError.code !== "resume_finalize_failed"
    ) {
      throw firstError;
    }
    // A process/connection failure may happen after the durable local prepare
    // or after the upstream enable. A fresh session fence resumes from that
    // fail-closed state; it never compensates inside a lost ALS scope.
    try {
      return await run();
    } catch (secondError) {
      if (!upstreamEnableAttempted || !recoveryAccount) {
        throw secondError;
      }
      let recovery;
      try {
        // Deliberately outside runWithCurrentAdminAuthorization: this is a
        // safety-only compensation, not a new privileged business action.
        recovery = await compensateFailedResume(
          input.feishuUserId,
          recoveryAccount,
        );
      } catch (recoveryError) {
        throw new Error(
          `用户启用未完成，且 fail-closed 安全补偿失败: ${
            recoveryError instanceof Error
              ? recoveryError.message
              : "unknown recovery failure"
          }`,
          { cause: secondError },
        );
      }
      if (recovery.status === "already_completed") {
        return recovery.result;
      }
      throw new Error(
        `用户启用未完成，已重新禁用上游 Key 并回滚本地访问: ${
          secondError instanceof Error ? secondError.message : "unknown resume failure"
        }`,
        { cause: firstError },
      );
    }
  }
}

export async function recoverStaleUserAccessResumesOnce(input: {
  nowEpochMs?: number;
  limit?: number;
} = {}) {
  const nowEpochMs = input.nowEpochMs ?? Date.now();
  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? staleResumeRecoveryLimit), 1),
    100,
  );
  const staleBefore = new Date(
    nowEpochMs - staleResumeRecoveryAgeMs,
  ).toISOString();
  const candidates = await listStaleUserAccessResumeCandidates({
    staleBefore,
    limit,
  });
  let rolledBack = 0;
  let alreadyCompleted = 0;
  let alreadyFailClosed = 0;
  let failed = 0;
  for (
    let offset = 0;
    offset < candidates.length;
    offset += staleResumeRecoveryConcurrency
  ) {
    const batch = candidates.slice(
      offset,
      offset + staleResumeRecoveryConcurrency,
    );
    const results = await Promise.allSettled(
      batch.map((candidate) =>
        compensateFailedResume(candidate.user.id, candidate.tokenAccount, {
          waitForFence: false,
        }),
      ),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        failed += 1;
      } else if (result.value.status === "rolled_back") {
        rolledBack += 1;
      } else if (result.value.status === "already_completed") {
        alreadyCompleted += 1;
      } else {
        alreadyFailClosed += 1;
      }
    }
  }
  return {
    scanned: candidates.length,
    rolledBack,
    alreadyCompleted,
    alreadyFailClosed,
    failed,
    hasMore: candidates.length >= limit,
  };
}

function scheduleUserAccessRecovery(delayMs: number) {
  if (userAccessRecoveryRuntime.timer) {
    clearTimeout(userAccessRecoveryRuntime.timer);
  }
  userAccessRecoveryRuntime.timer = setTimeout(async () => {
    userAccessRecoveryRuntime.timer = undefined;
    if (userAccessRecoveryRuntime.running) {
      scheduleUserAccessRecovery(staleResumeRecoveryIntervalMs);
      return;
    }
    userAccessRecoveryRuntime.running = true;
    let nextDelayMs = staleResumeRecoveryIntervalMs;
    try {
      const result = await recoverStaleUserAccessResumesOnce();
      if (result.hasMore) nextDelayMs = 1_000;
      if (result.failed > 0) {
        console.error(
          JSON.stringify({
            event: "tokeninside.user_access_resume_recovery_partial_failure",
            failed: result.failed,
            scanned: result.scanned,
          }),
        );
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "tokeninside.user_access_resume_recovery_failed",
          error: error instanceof Error ? error.message : "unknown failure",
        }),
      );
    } finally {
      userAccessRecoveryRuntime.running = false;
      scheduleUserAccessRecovery(nextDelayMs);
    }
  }, Math.max(Math.trunc(delayMs), 0));
  userAccessRecoveryRuntime.timer.unref?.();
}

export function ensureUserAccessRecoveryWorker() {
  if (userAccessRecoveryRuntime.started) return;
  userAccessRecoveryRuntime.started = true;
  scheduleUserAccessRecovery(0);
}
