import { getConfig, requireSessionSecret } from "@/lib/config";
import {
  hmacSha256Base64Url,
  nowIso,
  randomId,
  safeEqual,
  sha256Hex,
} from "@/lib/crypto";
import {
  isQuotaExecutionFenceLostError,
  type QuotaExecutionFence,
} from "@/lib/quota-execution-fence";
import {
  claimPrewarmedTokenForProvisionUnderUserFence,
  clearClaimedPrewarmedCredential,
} from "@/lib/key-prewarm";
import {
  createNewApiToken,
  disableNewApiTokenAndVerify,
  enableNewApiTokenAndVerify,
  findNewApiTokenByName,
  getNewApiTokenControlState,
  getNewApiTokenKey,
  getNewApiTokenRemainQuota,
  toNewApiQuota,
  updateNewApiTokenQuota,
} from "@/lib/newapi";
import {
  calculateKeyRotationTarget,
  calculateFirstProvision,
  calculateQuotaAdjustment,
  conservativeRemainQuotaObservation,
} from "@/lib/quota-model";
import {
  assertQuotaWriteActionEnabled,
  quotaWritesPaused,
} from "@/lib/quota-guard";
import { openQuotaCredential, sealQuotaCredential } from "@/lib/secret-box";
import {
  addTokenAccount,
  addTokenAccountForQuotaOperation,
  appendQuotaLedgerEntry,
  claimQuotaOperationExecution,
  createQuotaOperation,
  createMonthlyOpenQuotaOperations,
  createUserQuotaPolicyVersion,
  finalizeTokenRotationForQuotaOperation,
  findQuotaOperationById,
  finalizeTokenProvision,
  getActiveTokenForUser,
  getEffectiveUserQuotaPolicy,
  getCurrentPackageBillingPeriod,
  getUserBillingPeriod,
  getUserById,
  getUserQuotaState,
  listInflightProxyRequests,
  listInflightProxyRequestsForQuotaOperation,
  listDueQuotaOperations,
  listTokenAccountsForUser,
  rebuildUserQuotaMaterializedSnapshot,
  rebuildUserQuotaMaterializedSnapshotForQuotaOperation,
  refreshUserBillingTokenMetadataForQuotaOperation,
  releaseQuotaOperationExecution,
  renewQuotaOperationExecution,
  reserveQuotaOperationDepartmentBudget,
  saveUserQuotaState,
  transitionQuotaOperation,
  updateQuotaOperation,
  updateTokenAccount,
  updateTokenAccountForQuotaOperation,
  updateTokenRequestAfterQuotaMaterialization,
  updateTokenRequest,
  updateTokenRequestForQuotaOperation,
  withUserQuotaOperationLock,
} from "@/lib/store";
import {
  canAutoResumeKeyRotationObservationFailure,
  canCompensateKeyRotationBeforeUpstream,
  quotaOperationRetryResumeState,
} from "@/lib/quota-saga-state";
import { ingestQuotaBarrierUsage } from "@/lib/usage-sync";
import type {
  QuotaOperation,
  TokenAccount,
  TokenRequest,
} from "@/lib/types";

const maxAttempts = 5;
const retryDelayMs = 2_000;
const quotaSagaRuntimeVersion = 1 as const;

type QuotaSagaRuntimeV1 = {
  version: typeof quotaSagaRuntimeVersion;
  workerStarted: boolean;
  workerTimer: ReturnType<typeof setTimeout> | undefined;
  activeQuotaOperations: number;
  quotaOperationWaiters: Array<() => void>;
};

class InactiveQuotaOperationUserError extends Error {
  constructor() {
    super("额度操作目标用户已禁用、删除或不存在");
    this.name = "InactiveQuotaOperationUserError";
  }
}

async function assertQuotaOperationUserActive(operation: QuotaOperation) {
  const user = await getUserById(operation.feishuUserId);
  if (!user || (user.status && user.status !== "active")) {
    throw new InactiveQuotaOperationUserError();
  }
  return user;
}

type QuotaSagaGlobalRuntime = typeof globalThis & {
  __tokenInsideQuotaSagaRuntimeV1?: QuotaSagaRuntimeV1;
};

// Next.js may emit the instrumentation worker and route handlers into separate
// server chunks. Their module scopes are independent even though they execute
// in one Node process, so the in-process worker and admission gate must share a
// versioned process-global runtime. PostgreSQL execution additionally holds a
// session advisory fence for the complete user Saga; the durable lease is the
// scheduling/recovery marker rather than the sole concurrency boundary.
const quotaSagaGlobalRuntime = globalThis as QuotaSagaGlobalRuntime;
const quotaSagaRuntime =
  quotaSagaGlobalRuntime.__tokenInsideQuotaSagaRuntimeV1 ??=
    {
      version: quotaSagaRuntimeVersion,
      workerStarted: false,
      workerTimer: undefined,
      activeQuotaOperations: 0,
      quotaOperationWaiters: [],
    };

async function acquireQuotaOperationSlot() {
  if (
    quotaSagaRuntime.activeQuotaOperations >=
      getConfig().billing.operationConcurrencyMax ||
    quotaSagaRuntime.quotaOperationWaiters.length > 0
  ) {
    await new Promise<void>((resolve) =>
      quotaSagaRuntime.quotaOperationWaiters.push(resolve),
    );
  } else {
    quotaSagaRuntime.activeQuotaOperations += 1;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = quotaSagaRuntime.quotaOperationWaiters.shift();
    if (next) next();
    else {
      quotaSagaRuntime.activeQuotaOperations = Math.max(
        quotaSagaRuntime.activeQuotaOperations - 1,
        0,
      );
    }
  };
}

export function quotaOperationExecutionSnapshot() {
  return {
    active: quotaSagaRuntime.activeQuotaOperations,
    queued: quotaSagaRuntime.quotaOperationWaiters.length,
    maxConcurrency: getConfig().billing.operationConcurrencyMax,
  };
}

function addMilliseconds(value: string, milliseconds: number) {
  return new Date(new Date(value).getTime() + milliseconds).toISOString();
}

async function stableRemainQuota(newapiTokenId: string) {
  const first = await getNewApiTokenRemainQuota(newapiTokenId);
  const second = await getNewApiTokenRemainQuota(newapiTokenId);
  if (first === undefined || second === undefined || first !== second) {
    throw new Error("NewAPI token 余额观测不稳定");
  }
  return second;
}

async function conservativeRemainQuotaAfterDrain(newapiTokenId: string) {
  const observations = [];
  for (let index = 0; index < 3; index += 1) {
    observations.push(await getNewApiTokenRemainQuota(newapiTokenId));
  }
  return conservativeRemainQuotaObservation(observations);
}

async function assignedQuotaForUser(feishuUserId: string, period: string) {
  const policy = await getEffectiveUserQuotaPolicy(feishuUserId, period);
  if (policy) return policy.assignedMonthlyQuota;
  const billing = await getUserBillingPeriod(feishuUserId, period);
  return toNewApiQuota(billing?.monthlyQuota ?? 0);
}

function usesIsolatedQuotaControlPool(operation: QuotaOperation) {
  return operation.operationType === "key_rotation";
}

function updateOperationTokenAccount(
  operation: QuotaOperation,
  accountId: string,
  patch: Partial<TokenAccount>,
  allowedStatuses?: TokenAccount["status"][],
) {
  const update = usesIsolatedQuotaControlPool(operation)
    ? updateTokenAccountForQuotaOperation
    : updateTokenAccount;
  return update(accountId, patch, allowedStatuses);
}

function assertFrozenOperationAccountBinding(
  operation: QuotaOperation,
  account: TokenAccount | null,
) {
  if (
    operation.tokenAccountIdBefore &&
    (!account || account.id !== operation.tokenAccountIdBefore)
  ) {
    throw new Error("额度操作冻结的本地 Key 账户已丢失或发生替换");
  }
  if (
    operation.upstreamTokenIdBefore &&
    (!account || account.newapiTokenId !== operation.upstreamTokenIdBefore)
  ) {
    throw new Error("额度操作冻结的上游 Key 绑定已丢失或发生替换");
  }
}

function updateOperationTokenRequest(
  operation: QuotaOperation,
  requestId: string,
  patch: Partial<Omit<TokenRequest, "id" | "createdAt">>,
) {
  const update = usesIsolatedQuotaControlPool(operation)
    ? updateTokenRequestForQuotaOperation
    : updateTokenRequest;
  return update(requestId, patch);
}

function updateOperationTokenRequestAfterMaterialization(
  operation: QuotaOperation,
  requestId: string,
  patch: Partial<Omit<TokenRequest, "id" | "createdAt">>,
) {
  if (usesIsolatedQuotaControlPool(operation)) {
    return updateTokenRequestAfterQuotaMaterialization(requestId, patch);
  }
  return updateOperationTokenRequest(operation, requestId, patch);
}

function listOperationInflightProxyRequests(
  operation: QuotaOperation,
  operationGeneration: number,
) {
  const list = usesIsolatedQuotaControlPool(operation)
    ? listInflightProxyRequestsForQuotaOperation
    : listInflightProxyRequests;
  return list(operation.feishuUserId, operationGeneration);
}

function rebuildOperationQuotaSnapshot(operation: QuotaOperation) {
  const rebuild = usesIsolatedQuotaControlPool(operation)
    ? rebuildUserQuotaMaterializedSnapshotForQuotaOperation
    : rebuildUserQuotaMaterializedSnapshot;
  return rebuild(
    operation.feishuUserId,
    operation.billingPeriod,
    operation.operationType === "key_rotation" ? undefined : operation.departmentId,
  );
}

async function clearCommittedDepartmentReservation(operation: QuotaOperation) {
  if ((operation.reservedDepartmentQuota ?? 0) <= 0) return operation;
  return (
    (await updateQuotaOperation(
      operation.id,
      { reservedDepartmentQuota: 0 },
      [operation.state],
    )) ?? operation
  );
}

async function reopenAdmission(operation: QuotaOperation) {
  const state = await getUserQuotaState(operation.feishuUserId);
  await saveUserQuotaState({
    feishuUserId: operation.feishuUserId,
    admission: "open",
    activeGeneration: state.activeGeneration,
    updatedAt: nowIso(),
  });
}

async function waitForAuthoritativeConsumptionBarrier(
  operation: QuotaOperation,
  upstreamDisabledAt: string,
  cutoffAt: string,
) {
  let current = (await findQuotaOperationById(operation.id)) ?? operation;
  if (
    current.evidence?.consumptionBarrierStatus === "satisfied" &&
    current.evidence?.consumptionBarrierCutoffAt === cutoffAt
  ) {
    return { ready: true as const, operation: current };
  }
  const cutoffTime = new Date(cutoffAt).getTime();
  if (!Number.isFinite(cutoffTime)) {
    throw new Error("额度操作消费结算屏障时间无效");
  }
  const now = Date.now();
  if (now < cutoffTime) {
    const retryAt = new Date(
      Math.min(cutoffTime, now + retryDelayMs),
    ).toISOString();
    current =
      (await updateQuotaOperation(
        current.id,
        {
          nextRetryAt: retryAt,
          evidence: {
            ...current.evidence,
            consumptionBarrierCutoffAt: cutoffAt,
            consumptionBarrierStatus: "drain_grace_pending",
          },
        },
        [current.state],
      )) ?? current;
    return { ready: false as const, operation: current };
  }

  // Direct callers can already possess the dedicated NewAPI Key. Disabling
  // it stops new requests, but an accepted SSE/non-SSE request may finish
  // later and create a delayed usage fact. A dedicated bounded scan avoids
  // waiting for the global two-hour low-priority repair cursor.
  const ingestion = await ingestQuotaBarrierUsage({
    upstreamDisabledAt,
    cutoffAt,
    billingPeriod: current.billingPeriod,
  });
  if (ingestion.status !== "completed") {
    const delayedRetry =
      ingestion.status === "integrity_blocked" ||
      ingestion.status === "too_large";
    const nextRetryAt =
      ingestion.status === "not_mature"
        ? ingestion.matureAt
        : addMilliseconds(nowIso(), delayedRetry ? 60_000 : retryDelayMs);
    current =
      (await updateQuotaOperation(
        current.id,
        {
          nextRetryAt,
          evidence: {
            ...current.evidence,
            consumptionBarrierCutoffAt: cutoffAt,
            consumptionBarrierScanStart: ingestion.scanStart,
            consumptionBarrierScanEnd: ingestion.scanEnd,
            consumptionBarrierMatureAt: ingestion.matureAt,
            consumptionBarrierScanTotal: ingestion.total,
            consumptionBarrierScanPages: ingestion.pages,
            consumptionBarrierIntegrityBlockedAt:
              ingestion.integrityBlockedAt,
            consumptionBarrierIntegrityBlockedIssueId:
              ingestion.integrityBlockedIssueId,
            consumptionBarrierIngestionStatus: ingestion.status,
            consumptionBarrierStatus: "settlement_pending",
          },
        },
        [current.state],
      )) ?? current;
    return { ready: false as const, operation: current };
  }
  await rebuildOperationQuotaSnapshot(current);
  const billingPeriod = await getUserBillingPeriod(
    current.feishuUserId,
    current.billingPeriod,
  );
  current =
    (await updateQuotaOperation(
      current.id,
      {
        nextRetryAt: undefined,
        evidence: {
          ...current.evidence,
          consumptionBarrierCutoffAt: cutoffAt,
          consumptionBarrierScanStart: ingestion.scanStart,
          consumptionBarrierScanEnd: ingestion.scanEnd,
          consumptionBarrierScanTotal: ingestion.total,
          consumptionBarrierScanPages: ingestion.pages,
          consumptionBarrierAffectedUsers: ingestion.affectedUsers,
          consumptionBarrierIngestionStatus: ingestion.status,
          consumptionBarrierMaterializedAt: billingPeriod?.materializedAt,
          consumptionBarrierSatisfiedAt: nowIso(),
          consumptionBarrierStatus: "satisfied",
        },
      },
      [current.state],
    )) ?? current;
  return { ready: true as const, operation: current };
}

async function waitForRevokedAccessBarrierBeforeFirstProvision(
  operation: QuotaOperation,
) {
  let current = (await findQuotaOperationById(operation.id)) ?? operation;
  let cutoffAt = current.evidence?.consumptionBarrierCutoffAt;
  let upstreamDisabledAt =
    current.evidence?.accessRevokedUpstreamDisabledAt;
  let hasRevokedAccessBarrier =
    typeof upstreamDisabledAt === "string";
  if (typeof cutoffAt !== "string") {
    const quotaState = await getUserQuotaState(current.feishuUserId);
    if (
      quotaState.admission !== "closed" ||
      quotaState.operationId ||
      quotaState.closedReason !== "user_access_revoked"
    ) {
      return { ready: true as const, operation: current };
    }
    hasRevokedAccessBarrier = true;
    if (
      typeof quotaState.upstreamDisabledAt !== "string" ||
      typeof quotaState.consumptionBarrierCutoffAt !== "string"
    ) {
      const historicalAccounts = await listTokenAccountsForUser(
        current.feishuUserId,
      );
      if (!historicalAccounts.some((account) => Boolean(account.newapiTokenId))) {
        return { ready: true as const, operation: current };
      }
      throw new Error("用户撤销状态缺少直连消费结算屏障，禁止重新发放 Key");
    }
    cutoffAt = quotaState.consumptionBarrierCutoffAt;
    upstreamDisabledAt = quotaState.upstreamDisabledAt;
    current =
      (await updateQuotaOperation(
        current.id,
        {
          evidence: {
            ...current.evidence,
            accessRevokedUpstreamDisabledAt: quotaState.upstreamDisabledAt,
            consumptionBarrierCutoffAt: cutoffAt,
            consumptionBarrierStatus: "drain_grace_pending",
          },
        },
        [current.state],
      )) ?? current;
  }
  if (
    hasRevokedAccessBarrier &&
    Date.now() >= new Date(cutoffAt).getTime() &&
    !getConfig().newapi.mock
  ) {
    const historicalAccounts = await listTokenAccountsForUser(
      current.feishuUserId,
    );
    let reDisabled = false;
    for (const account of historicalAccounts) {
      if (
        !account.newapiTokenId ||
        account.newapiTokenId === current.upstreamTokenIdAfter
      ) {
        continue;
      }
      const controlState = await getNewApiTokenControlState(
        account.newapiTokenId,
      );
      if (controlState.status === 2) continue;
      await disableNewApiTokenAndVerify(account.newapiTokenId);
      reDisabled = true;
    }
    if (reDisabled) {
      const upstreamDisabledAt = nowIso();
      cutoffAt = addMilliseconds(
        upstreamDisabledAt,
        getConfig().billing.directConsumptionDrainGraceMs,
      );
      const quotaState = await getUserQuotaState(current.feishuUserId);
      await saveUserQuotaState({
        ...quotaState,
        upstreamDisabledAt,
        consumptionBarrierCutoffAt: cutoffAt,
        updatedAt: nowIso(),
      });
      current =
        (await updateQuotaOperation(
          current.id,
          {
            nextRetryAt: addMilliseconds(nowIso(), retryDelayMs),
            evidence: {
              ...current.evidence,
              accessRevokedUpstreamDisabledAt: upstreamDisabledAt,
              consumptionBarrierCutoffAt: cutoffAt,
              consumptionBarrierStatus: "historical_upstream_re_disabled",
            },
          },
          [current.state],
        )) ?? current;
      return { ready: false as const, operation: current };
    }
  }
  if (typeof upstreamDisabledAt !== "string") {
    throw new Error("用户撤销状态缺少上游停用时间，禁止重新发放 Key");
  }
  return waitForAuthoritativeConsumptionBarrier(
    current,
    upstreamDisabledAt,
    cutoffAt,
  );
}

async function prepareAndDrain(
  operation: QuotaOperation,
  drainingAccount?: TokenAccount | null,
) {
  // runQuotaOperationInner owns the session-level user fence for the complete
  // Saga, including slow NewAPI calls. Keeping a second pooled advisory lock
  // here would wait on the operation's own outer lock.
  let current = await findQuotaOperationById(operation.id);
  if (!current) throw new Error("额度操作不存在");
    if (current.state === "planned" || current.state === "budget_reserved") {
      current = await transitionQuotaOperation(current.id, "local_prepared", {
        nextRetryAt: undefined,
        lastErrorCode: undefined,
        lastErrorMessage: undefined,
      });
    }
    if (!current) throw new Error("额度操作准备失败");

    const state = await getUserQuotaState(current.feishuUserId);
    const canTakeOverRevokedAdmission =
      current.operationType === "first_provision" &&
      state.admission === "closed" &&
      !state.operationId &&
      state.closedReason === "user_access_revoked";
    if (
      state.admission === "closed" &&
      state.operationId !== current.id &&
      !canTakeOverRevokedAdmission
    ) {
      throw new Error(`用户准入已被其他操作关闭: ${state.operationId ?? "unknown"}`);
    }
    if (state.admission !== "closed" || canTakeOverRevokedAdmission) {
      await saveUserQuotaState({
        feishuUserId: current.feishuUserId,
        admission: "closed",
        activeGeneration: state.activeGeneration,
        operationId: current.id,
        closedReason: current.operationType,
        updatedAt: nowIso(),
      });
    }
    if (current.state === "local_prepared") {
      current = await transitionQuotaOperation(current.id, "admission_closed");
    }
    if (!current) throw new Error("额度操作关闭准入失败");

    if (drainingAccount && drainingAccount.status === "active") {
      await updateOperationTokenAccount(
        current,
        drainingAccount.id,
        { status: "draining", drainStartedAt: nowIso() },
        ["active"],
      );
    }
    if (
      drainingAccount?.newapiTokenId &&
      current.state !== "upstream_activated" &&
      current.state !== "local_finalized" &&
      current.state !== "reconciling"
    ) {
      if (typeof current.evidence?.oldUpstreamDisabledAt !== "string") {
        await disableNewApiTokenAndVerify(drainingAccount.newapiTokenId);
        const disabledAt = nowIso();
        const evidence = {
          ...current.evidence,
          oldUpstreamDisabledAt: disabledAt,
          consumptionBarrierCutoffAt: addMilliseconds(
            disabledAt,
            getConfig().billing.directConsumptionDrainGraceMs,
          ),
        };
        if (current.state === "admission_closed") {
          current =
            (await transitionQuotaOperation(current.id, "upstream_frozen", {
              evidence,
            })) ?? current;
        } else {
          current =
            (await updateQuotaOperation(current.id, { evidence }, [current.state])) ?? current;
        }
      }
    }
    const inflight = await listOperationInflightProxyRequests(current, state.activeGeneration);
    if (inflight.length > 0) {
      if (current.state === "admission_closed" || current.state === "upstream_frozen") {
        current = await transitionQuotaOperation(current.id, "draining", {
          nextRetryAt: addMilliseconds(nowIso(), retryDelayMs),
          evidence: {
            ...current.evidence,
            inflightRequests: inflight.length,
          },
        });
      } else {
        current = await updateQuotaOperation(current.id, {
          nextRetryAt: addMilliseconds(nowIso(), retryDelayMs),
          evidence: {
            ...current.evidence,
            inflightRequests: inflight.length,
          },
        });
      }
      return { ready: false as const, operation: current ?? operation };
    }
    if (
      drainingAccount?.newapiTokenId &&
      current.operationType !== "first_provision" &&
      current.state !== "upstream_activated" &&
      current.state !== "local_finalized" &&
      current.state !== "reconciling"
    ) {
      let disabledAt = current.evidence?.oldUpstreamDisabledAt;
      if (typeof disabledAt !== "string") {
        throw new Error("额度操作缺少上游停用时间，无法建立消费结算屏障");
      }
      const storedCutoffAt = current.evidence?.consumptionBarrierCutoffAt;
      let cutoffAt =
        typeof storedCutoffAt === "string"
          ? storedCutoffAt
          : addMilliseconds(
              disabledAt,
              getConfig().billing.directConsumptionDrainGraceMs,
            );
      if (Date.now() >= new Date(cutoffAt).getTime() && !getConfig().newapi.mock) {
        const controlState = await getNewApiTokenControlState(
          drainingAccount.newapiTokenId,
        );
        if (controlState.status !== 2) {
          await disableNewApiTokenAndVerify(drainingAccount.newapiTokenId);
          disabledAt = nowIso();
          cutoffAt = addMilliseconds(
            disabledAt,
            getConfig().billing.directConsumptionDrainGraceMs,
          );
          current =
            (await updateQuotaOperation(
              current.id,
              {
                nextRetryAt: addMilliseconds(nowIso(), retryDelayMs),
                evidence: {
                  ...current.evidence,
                  oldUpstreamDisabledAt: disabledAt,
                  consumptionBarrierCutoffAt: cutoffAt,
                  consumptionBarrierStatus: "upstream_re_disabled",
                },
              },
              [current.state],
            )) ?? current;
          return { ready: false as const, operation: current };
        }
      }
      const barrier = await waitForAuthoritativeConsumptionBarrier(
        current,
        disabledAt,
        cutoffAt,
      );
      if (!barrier.ready) return barrier;
      current = barrier.operation;
    }
  return { ready: true as const, operation: current };
}

async function freezeSnapshot(
  operation: QuotaOperation,
  patch: Partial<QuotaOperation>,
) {
  const current = (await findQuotaOperationById(operation.id)) ?? operation;
  if (
    current.state === "snapshot_stable" ||
    current.state === "upstream_applying" ||
    current.state === "upstream_applied" ||
    current.state === "upstream_activated" ||
    current.state === "local_finalized" ||
    current.state === "reconciling"
  ) {
    return (await updateQuotaOperation(current.id, patch, [current.state])) ?? current;
  }
  return (
    (await transitionQuotaOperation(current.id, "snapshot_stable", patch)) ?? current
  );
}

async function applyAndVerifyBalance(operation: QuotaOperation) {
  let current = (await findQuotaOperationById(operation.id)) ?? operation;
  if (!current.upstreamTokenIdBefore || current.targetRemainQuota === undefined) {
    throw new Error("额度操作缺少冻结的上游 token 或目标余额");
  }
  const upstreamTokenId = current.upstreamTokenIdBefore;
  const targetRemainQuota = current.targetRemainQuota;
  if (
    current.state === "upstream_applied"
  ) {
    const observed = await getNewApiTokenRemainQuota(upstreamTokenId);
    if (observed !== targetRemainQuota) {
      throw new Error("已写入额度操作的上游状态发生漂移");
    }
    return current;
  }
  if (
    current.state === "upstream_activated" ||
    current.state === "local_finalized" ||
    current.state === "reconciling"
  ) {
    const controlState = await getNewApiTokenControlState(upstreamTokenId);
    if (controlState.status !== 1 || controlState.remainQuota === undefined) {
      throw new Error("已激活额度操作的上游 Key 状态不可确认");
    }
    if (controlState.remainQuota > targetRemainQuota) {
      throw new Error("已激活额度操作的上游余额高于冻结目标，需要人工复核");
    }
    return (
      (await updateQuotaOperation(current.id, {
        observedRemainAfter: controlState.remainQuota,
        evidence: {
          ...current.evidence,
          observedRemainOnActivatedResume: controlState.remainQuota,
          observedActivatedResumeAt: nowIso(),
        },
      }, [current.state])) ?? current
    );
  }
  if (current.state === "snapshot_stable") {
    current =
      (await transitionQuotaOperation(current.id, "upstream_applying")) ?? current;
  }
  if (current.state !== "upstream_applying") {
    throw new Error(`额度写入状态无效: ${current.state}`);
  }
  const observedBeforeRetry = await getNewApiTokenRemainQuota(upstreamTokenId);
  const writeWasAttempted = Boolean(current.evidence?.upstreamBalanceWriteAttemptedAt);
  if (observedBeforeRetry === targetRemainQuota && writeWasAttempted) {
    return (
      (await transitionQuotaOperation(current.id, "upstream_applied", {
        observedRemainAfter: observedBeforeRetry,
      })) ?? current
    );
  }
  if (
    observedBeforeRetry === undefined ||
    observedBeforeRetry !== current.observedRemainBefore
  ) {
    throw new Error("NewAPI 余额写入结果不确定，拒绝覆盖未知状态");
  }
  current =
    (await updateQuotaOperation(current.id, {
      evidence: {
        ...current.evidence,
        upstreamBalanceWriteAttemptedAt:
          current.evidence?.upstreamBalanceWriteAttemptedAt ?? nowIso(),
      },
    }, ["upstream_applying"])) ?? current;
  await updateNewApiTokenQuota({
    newapiTokenId: upstreamTokenId,
    remainQuota: targetRemainQuota,
  });
  const observedRemainAfter = await getNewApiTokenRemainQuota(upstreamTokenId);
  if (observedRemainAfter !== targetRemainQuota) {
    throw new Error("NewAPI 余额写后校验失败");
  }
  if (current.state === "upstream_applying") {
    current =
      (await transitionQuotaOperation(current.id, "upstream_applied", {
        observedRemainAfter,
      })) ?? current;
  }
  return current;
}

async function finalizeCommon(
  operation: QuotaOperation,
  account?: TokenAccount | null,
  accountPatch: Partial<TokenAccount> = {},
) {
  let current = (await findQuotaOperationById(operation.id)) ?? operation;
  await assertQuotaOperationUserActive(current);
  if (account) {
    const updatedAccount = await updateOperationTokenAccount(current, account.id, {
      ...accountPatch,
      operationGeneration: current.operationGeneration,
    }, ["active", "draining", "settling"]);
    if (!updatedAccount) {
      throw new Error("额度操作最终化时 Key 账户已被禁用、撤销或替换");
    }
  }
  await saveUserQuotaState({
    feishuUserId: current.feishuUserId,
    admission: "open",
    activeGeneration: current.operationGeneration,
    updatedAt: nowIso(),
  });
  if (current.state !== "local_finalized" && current.state !== "reconciling") {
    current =
      (await transitionQuotaOperation(current.id, "local_finalized")) ?? current;
  }
  if (current.state === "local_finalized") {
    current = (await transitionQuotaOperation(current.id, "reconciling")) ?? current;
  }
  current = await clearCommittedDepartmentReservation(current);
  await rebuildOperationQuotaSnapshot(current);
  if (current.requestId) {
    await updateOperationTokenRequestAfterMaterialization(current, current.requestId, {
      status: "provisioned",
      tokenAccountId: account?.id,
      errorMessage: undefined,
    });
  }
  return (
    (await transitionQuotaOperation(current.id, "completed", {
      reservedDepartmentQuota: 0,
      nextRetryAt: undefined,
    })) ?? current
  );
}

async function handleQuotaAdjustment(operation: QuotaOperation) {
  const activeAccount = await getActiveTokenForUser(operation.feishuUserId);
  const account =
    activeAccount ??
    (operation.tokenAccountIdBefore
      ? (await listTokenAccountsForUser(operation.feishuUserId)).find(
          (item) => item.id === operation.tokenAccountIdBefore,
        ) ?? null
      : null);
  assertFrozenOperationAccountBinding(operation, account);
  const assignedQuotaBefore =
    operation.assignedQuotaBefore ??
    (await assignedQuotaForUser(operation.feishuUserId, operation.billingPeriod));
  const assignedQuotaAfter = operation.requestedAssignedQuota;
  if (assignedQuotaAfter === undefined) throw new Error("调额操作缺少目标授权额度");

  let current = operation;
  if (current.state === "local_finalized" || current.state === "reconciling") {
    return finalizeCommon(current, account);
  }

  let ledgerDelta =
    typeof current.evidence?.ledgerDelta === "number"
      ? current.evidence.ledgerDelta
      : undefined;
  if (ledgerDelta === undefined) {
    await rebuildOperationQuotaSnapshot(current);
    const billingPeriod = await getUserBillingPeriod(
      current.feishuUserId,
      current.billingPeriod,
    );
    if (
      !billingPeriod ||
      typeof billingPeriod.authorizedQuota !== "number" ||
      !Number.isInteger(billingPeriod.authorizedQuota) ||
      typeof billingPeriod.authoritativeConsumedQuota !== "number" ||
      !Number.isInteger(billingPeriod.authoritativeConsumedQuota)
    ) {
      throw new Error("调额操作缺少已物化的本地账本快照");
    }
    const authorizedQuotaBefore = Math.max(billingPeriod.authorizedQuota, 0);
    const authoritativeConsumedQuotaBefore = Math.max(
      billingPeriod.authoritativeConsumedQuota,
      0,
    );
    ledgerDelta = assignedQuotaAfter - authorizedQuotaBefore;
    if (ledgerDelta > 0) {
      current =
        (await reserveQuotaOperationDepartmentBudget(
          current.id,
          ledgerDelta,
        )) ?? current;
    }
    current =
      (await updateQuotaOperation(current.id, {
        assignedQuotaBefore,
        upstreamTokenIdBefore: account?.newapiTokenId,
        tokenAccountIdBefore: account?.id,
        evidence: {
          ...current.evidence,
          authorizedQuotaBefore,
          authoritativeConsumedQuotaBefore,
          ledgerDelta,
          authorizationSourceVersion: billingPeriod.sourceVersion,
        },
      })) ?? current;
  }
  if (!Number.isInteger(ledgerDelta)) {
    throw new Error("调额操作缺少冻结的本地授权差额");
  }

  const prepared = await prepareAndDrain(current, account);
  if (!prepared.ready) return prepared.operation;
  current = prepared.operation;
  const upstreamWriteStarted =
    current.state === "upstream_applying" ||
    current.state === "upstream_applied" ||
    current.state === "upstream_activated";
  if (current.targetRemainQuota === undefined) {
    const observedRemainBefore = account?.newapiTokenId
      ? await stableRemainQuota(account.newapiTokenId)
      : 0;
    await rebuildOperationQuotaSnapshot(current);
    const billingPeriod = await getUserBillingPeriod(
      current.feishuUserId,
      current.billingPeriod,
    );
    if (
      !billingPeriod ||
      typeof billingPeriod.authorizedQuota !== "number" ||
      !Number.isInteger(billingPeriod.authorizedQuota) ||
      typeof billingPeriod.authoritativeConsumedQuota !== "number" ||
      !Number.isInteger(billingPeriod.authoritativeConsumedQuota)
    ) {
      throw new Error("调额操作排空后缺少已物化的本地账本快照");
    }
    const authorizedQuotaBefore = Number(current.evidence?.authorizedQuotaBefore);
    if (
      !Number.isInteger(authorizedQuotaBefore) ||
      billingPeriod.authorizedQuota !== authorizedQuotaBefore
    ) {
      throw new Error("调额操作排空期间本地授权账本发生变化");
    }
    const calculation = calculateQuotaAdjustment({
      observedRemainBefore,
      authorizedQuotaBefore,
      authoritativeConsumedQuota: Math.max(
        billingPeriod.authoritativeConsumedQuota,
        0,
      ),
      assignedQuotaAfter,
    });
    if (calculation.deltaAuthorizedQuota !== ledgerDelta) {
      throw new Error("调额操作冻结的授权差额与本地账本不一致");
    }
    current = await freezeSnapshot(current, {
      observedRemainBefore,
      targetRemainQuota: calculation.targetRemainQuota,
      upstreamTokenIdBefore: account?.newapiTokenId,
      tokenAccountIdBefore: account?.id,
      evidence: {
        ...current.evidence,
        authoritativeConsumedQuota: billingPeriod.authoritativeConsumedQuota,
        expectedAvailableQuota: calculation.expectedAvailableQuota,
        overageQuota: calculation.overageQuota,
        projectedRemainQuota: calculation.targetRemainQuota,
        quotaSourceVersion: billingPeriod.sourceVersion,
        quotaSettledThrough: billingPeriod.settledThrough,
      },
    });
  } else {
    if (account?.newapiTokenId && !upstreamWriteStarted) {
      const stable = await stableRemainQuota(account.newapiTokenId);
      if (stable !== current.observedRemainBefore) {
        throw new Error("关闭准入后上游余额已变化，需要新建操作版本");
      }
    }
    current = await freezeSnapshot(current, {});
  }
  if (account?.newapiTokenId) {
    current = await applyAndVerifyBalance(current);
  }
  const delta = Number(current.evidence?.ledgerDelta);
  if (!Number.isInteger(delta)) {
    throw new Error("调额操作缺少冻结的本地授权差额");
  }
  if (delta !== 0) {
    await appendQuotaLedgerEntry({
      operationId: current.id,
      feishuUserId: current.feishuUserId,
      departmentId: current.departmentId,
      period: current.billingPeriod,
      signedQuota: delta,
      entryType: delta > 0 ? "quota_adjust_grant" : "quota_adjust_release",
      sourceType: "quota_operation",
      sourceId: current.id,
    });
  }
  await createUserQuotaPolicyVersion({
    feishuUserId: current.feishuUserId,
    assignedMonthlyQuota: assignedQuotaAfter,
    departmentId: current.departmentId,
    effectiveFromPeriod: current.billingPeriod,
    sourceType: "quota_adjust",
    sourceId: current.id,
    updatedByOpenId: current.createdByOpenId,
  });
  // Keep the upstream Key disabled until the immutable ledger entry and its
  // policy source version are durable. If the process stops in this window,
  // retrying the same operation is idempotent and cannot expose an upstream
  // balance whose local authorization has not committed yet.
  if (account?.newapiTokenId && current.state === "upstream_applied") {
    await enableNewApiTokenAndVerify(account.newapiTokenId);
    if (!getConfig().newapi.mock) {
      const upstreamState = await getNewApiTokenControlState(account.newapiTokenId);
      if (upstreamState.status !== 1) {
        throw new Error("调额完成后无法重新启用 NewAPI Key");
      }
    }
    current =
      (await transitionQuotaOperation(current.id, "upstream_activated")) ?? current;
  }
  return finalizeCommon(current, account, {
    status: "active",
    drainStartedAt: undefined,
  });
}

async function firstProvisionAccount(operation: QuotaOperation) {
  if (!operation.tokenAccountIdAfter) return null;
  const accounts = await listTokenAccountsForUser(operation.feishuUserId);
  return accounts.find((item) => item.id === operation.tokenAccountIdAfter) ?? null;
}

async function finalizeFirstProvision(
  operation: QuotaOperation,
  account: TokenAccount,
  assignedMonthlyQuota: number,
  authorizationDelta: number,
) {
  let current = (await findQuotaOperationById(operation.id)) ?? operation;
  // Keep an immutable period-open marker even when a prior no-key adjustment
  // already authorized the full amount. The zero-value entry changes no
  // balance, but makes monthly-open retries deterministically skip this user.
  await appendQuotaLedgerEntry({
    operationId: current.id,
    feishuUserId: current.feishuUserId,
    departmentId: current.departmentId,
    period: current.billingPeriod,
    signedQuota: authorizationDelta,
    entryType: "period_open_authorization",
    sourceType: "quota_operation",
    sourceId: current.id,
  });
  await createUserQuotaPolicyVersion({
    feishuUserId: current.feishuUserId,
    assignedMonthlyQuota,
    departmentId: current.departmentId,
    effectiveFromPeriod: current.billingPeriod,
    sourceType: "first_apply",
    sourceId: current.requestId ?? current.id,
    updatedByOpenId: current.createdByOpenId,
  });
  if (current.state === "upstream_activated") {
    await finalizeTokenProvision({
      feishuUserId: current.feishuUserId,
      tokenAccountId: account.id,
      operationGeneration: current.operationGeneration,
    });
    current =
      (await transitionQuotaOperation(current.id, "local_finalized")) ?? current;
  }
  if (current.state === "local_finalized") {
    current = (await transitionQuotaOperation(current.id, "reconciling")) ?? current;
  }
  current = await clearCommittedDepartmentReservation(current);
  await rebuildOperationQuotaSnapshot(current);
  if (current.requestId) {
    await updateOperationTokenRequest(current, current.requestId, {
      status: "provisioned",
      tokenAccountId: account.id,
      errorMessage: undefined,
    });
  }
  return (
    (await transitionQuotaOperation(current.id, "completed", {
      reservedDepartmentQuota: 0,
      nextRetryAt: undefined,
    })) ?? current
  );
}

async function handleFirstProvision(operation: QuotaOperation) {
  const assignedMonthlyQuota = operation.requestedAssignedQuota;
  if (assignedMonthlyQuota === undefined) throw new Error("首次发放缺少授权额度");
  const unexpectedActive = await getActiveTokenForUser(operation.feishuUserId);
  let current = operation;
  if (
    unexpectedActive &&
    unexpectedActive.id !== current.tokenAccountIdAfter
  ) {
    throw new Error("首次发放期间用户已存在其他 active Key");
  }
  const accessRevocationBarrier =
    await waitForRevokedAccessBarrierBeforeFirstProvision(current);
  if (!accessRevocationBarrier.ready) return accessRevocationBarrier.operation;
  current = accessRevocationBarrier.operation;
  if (
    current.state === "upstream_activated" ||
    current.state === "local_finalized" ||
    current.state === "reconciling"
  ) {
    const account = await firstProvisionAccount(current);
    if (!account) throw new Error("首次发放恢复时找不到新 TokenAccount");
    return finalizeFirstProvision(
      current,
      account,
      assignedMonthlyQuota,
      Number(current.evidence?.authorizationDelta ?? 0),
    );
  }
  if (current.targetRemainQuota === undefined) {
    await rebuildOperationQuotaSnapshot(current);
    const period = await getUserBillingPeriod(
      current.feishuUserId,
      current.billingPeriod,
    );
    const authorizedQuotaBefore = Math.max(period?.authorizedQuota ?? 0, 0);
    const authoritativeConsumedQuota = Math.max(
      period?.authoritativeConsumedQuota ?? 0,
      0,
    );
    const calculation = calculateFirstProvision({
      assignedMonthlyQuota,
      authorizedQuotaBefore,
      authoritativeConsumedQuota,
    });
    current =
      (await updateQuotaOperation(current.id, {
        targetRemainQuota: calculation.targetRemainQuota,
        evidence: {
          ...current.evidence,
          authorizedQuotaBefore,
          authoritativeConsumedQuota,
          authorizationDelta: calculation.authorizationDelta,
        },
      })) ?? current;
  }
  const authorizationDelta = Number(current.evidence?.authorizationDelta ?? 0);
  if (
    current.departmentId &&
    current.reservedDepartmentQuota !== authorizationDelta &&
    authorizationDelta > 0
  ) {
    current =
      (await reserveQuotaOperationDepartmentBudget(current.id, authorizationDelta)) ??
      current;
  }
  const prepared = await prepareAndDrain(current);
  if (!prepared.ready) return prepared.operation;
  current = await freezeSnapshot(prepared.operation, {
    observedRemainBefore: 0,
    targetRemainQuota: current.targetRemainQuota,
  });
  if (current.state === "snapshot_stable") {
    current = (await transitionQuotaOperation(current.id, "upstream_applying")) ?? current;
  }

  const tokenName = `TI provision ${current.id}`.slice(0, 50);
  let upstreamTokenIdAfter = current.upstreamTokenIdAfter;
  let key: string | undefined;
  let account = await firstProvisionAccount(current);
  if (!upstreamTokenIdAfter && !account) {
    const prewarmed = await claimPrewarmedTokenForProvisionUnderUserFence({
      feishuUserId: current.feishuUserId,
      tokenRequestId: current.requestId ?? current.id,
      billingPeriod: current.billingPeriod,
      operationGeneration: current.operationGeneration,
    });
    if (prewarmed) {
      account = prewarmed.account;
      upstreamTokenIdAfter = prewarmed.account.newapiTokenId;
      key = prewarmed.key;
    }
  }
  if (!upstreamTokenIdAfter && account?.newapiTokenId) {
    upstreamTokenIdAfter = account.newapiTokenId;
  }
  if (!upstreamTokenIdAfter) {
    const existingUpstream = await findNewApiTokenByName(tokenName);
    if (existingUpstream?.id !== undefined) {
      upstreamTokenIdAfter = String(existingUpstream.id);
      key = await getNewApiTokenKey(upstreamTokenIdAfter);
    } else {
      const created = await createNewApiToken({ name: tokenName, remainQuota: 0 });
      upstreamTokenIdAfter = created.newapiTokenId;
      key = created.key;
    }
  }
  await disableNewApiTokenAndVerify(upstreamTokenIdAfter);
  if (!key && current.credentialCiphertext) {
    key = openQuotaCredential(current.credentialCiphertext, current.id);
  }
  if (!key && account?.prewarmedCredentialCiphertext) {
    key = openQuotaCredential(account.prewarmedCredentialCiphertext, account.id);
  }
  if (!key) key = await getNewApiTokenKey(upstreamTokenIdAfter);
  if (!key) throw new Error("NewAPI 未返回首次发放 Key 明文");

  if (!account) {
    const accounts = await listTokenAccountsForUser(current.feishuUserId);
    account =
      accounts.find(
        (item) =>
          item.feishuUserId === current.feishuUserId &&
          item.newapiTokenId === upstreamTokenIdAfter,
      ) ??
      (await addTokenAccount({
        feishuUserId: current.feishuUserId,
        tokenRequestId: current.requestId ?? current.id,
        newapiTokenId: upstreamTokenIdAfter,
        keyHash: sha256Hex(key),
        billingPeriod: current.billingPeriod,
        status: "pending_activation",
        operationGeneration: current.operationGeneration,
      }));
  }
  current =
    (await updateQuotaOperation(current.id, {
      upstreamTokenIdAfter,
      tokenAccountIdAfter: account.id,
      credentialCiphertext:
        current.credentialCiphertext ?? sealQuotaCredential(key, current.id),
    })) ?? current;
  if (account.prewarmedCredentialCiphertext) {
    await clearClaimedPrewarmedCredential(account.id);
  }

  await updateNewApiTokenQuota({
    newapiTokenId: upstreamTokenIdAfter,
    remainQuota: current.targetRemainQuota ?? 0,
  });
  const observedRemainAfter = await getNewApiTokenRemainQuota(upstreamTokenIdAfter);
  if (observedRemainAfter !== (current.targetRemainQuota ?? 0)) {
    throw new Error("首次发放余额写后校验失败");
  }
  current =
    (await transitionQuotaOperation(current.id, "upstream_applied", {
      observedRemainAfter,
    })) ?? current;
  await enableNewApiTokenAndVerify(upstreamTokenIdAfter);
  if (!getConfig().newapi.mock) {
    const state = await getNewApiTokenControlState(upstreamTokenIdAfter);
    if (state.status !== 1) throw new Error("首次发放 Key 启用状态校验失败");
  }
  current =
    (await transitionQuotaOperation(current.id, "upstream_activated")) ?? current;
  return finalizeFirstProvision(
    current,
    account,
    assignedMonthlyQuota,
    authorizationDelta,
  );
}

async function accountBeforeRotation(operation: QuotaOperation) {
  const accounts = await listTokenAccountsForUser(operation.feishuUserId);
  if (!operation.tokenAccountIdBefore) {
    return (
      accounts.find(
        (item) =>
          item.feishuUserId === operation.feishuUserId && item.status === "active",
      ) ??
      [...accounts]
        .filter(
          (item) =>
            item.feishuUserId === operation.feishuUserId &&
            ["draining", "settling"].includes(item.status),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ??
      null
    );
  }
  return accounts.find((item) => item.id === operation.tokenAccountIdBefore) ?? null;
}

async function quarantineUnexpectedRotationAccounts(
  operation: QuotaOperation,
  oldAccount: TokenAccount,
) {
  if (!operation.requestId) return operation;
  const accounts = await listTokenAccountsForUser(operation.feishuUserId);
  const candidates = accounts.filter(
    (account) =>
      account.feishuUserId === operation.feishuUserId &&
      account.id !== oldAccount.id &&
      account.id !== operation.tokenAccountIdAfter &&
      account.tokenRequestId === operation.requestId &&
      ["pending_activation", "active", "draining", "settling"].includes(account.status),
  );
  if (!candidates.length) return operation;
  for (const account of candidates) {
    if (account.newapiTokenId) await disableNewApiTokenAndVerify(account.newapiTokenId);
    await updateOperationTokenAccount(
      operation,
      account.id,
      { status: "orphaned", disabledAt: nowIso() },
      ["pending_activation", "active", "draining", "settling"],
    );
  }
  return (
    (await updateQuotaOperation(operation.id, {
      evidence: {
        ...operation.evidence,
        quarantinedUnexpectedTokenAccountIds: candidates.map((account) => account.id).join(","),
        quarantinedUnexpectedTokenAccountsAt: nowIso(),
      },
    })) ?? operation
  );
}

async function handleKeyRotation(operation: QuotaOperation) {
  let current = operation;
  let materializedPreDrainSnapshot = false;
  let oldAccount = await accountBeforeRotation(current);
  if (!oldAccount?.newapiTokenId) throw new Error("当前用户没有可轮换的 active NewAPI key");
  if (!current.tokenAccountIdBefore || !current.upstreamTokenIdBefore) {
    current =
      (await updateQuotaOperation(current.id, {
        tokenAccountIdBefore: oldAccount.id,
        upstreamTokenIdBefore: oldAccount.newapiTokenId,
      })) ?? current;
  }
  current = await quarantineUnexpectedRotationAccounts(current, oldAccount);
  if (
    current.state === "upstream_activated" ||
    current.state === "local_finalized" ||
    current.state === "reconciling"
  ) {
    const accounts = await listTokenAccountsForUser(current.feishuUserId);
    const newAccount = current.tokenAccountIdAfter
      ? accounts.find((item) => item.id === current.tokenAccountIdAfter)
      : undefined;
    if (!newAccount) throw new Error("Key 轮换恢复时找不到新 TokenAccount");
    if (current.state === "upstream_activated") {
      await finalizeTokenRotationForQuotaOperation({
        feishuUserId: current.feishuUserId,
        oldTokenAccountId: oldAccount.id,
        newTokenAccountId: newAccount.id,
        operationGeneration: current.operationGeneration,
        operationId: current.id,
      });
      current =
        (await transitionQuotaOperation(current.id, "local_finalized")) ?? current;
    }
    if (current.state === "local_finalized") {
      current = (await transitionQuotaOperation(current.id, "reconciling")) ?? current;
    }
    current = await clearCommittedDepartmentReservation(current);
    await rebuildOperationQuotaSnapshot(current);
    if (current.requestId) {
      await updateOperationTokenRequestAfterMaterialization(current, current.requestId, {
        status: "provisioned",
        tokenAccountId: newAccount.id,
        errorMessage: undefined,
      });
    }
    return (
      (await transitionQuotaOperation(current.id, "completed", {
        reservedDepartmentQuota: 0,
        nextRetryAt: undefined,
      })) ?? current
    );
  }
  const prepared = await prepareAndDrain(current, oldAccount);
  if (!prepared.ready) return prepared.operation;
  current = prepared.operation;
  oldAccount = await accountBeforeRotation(current);
  if (!oldAccount?.newapiTokenId) throw new Error("轮换前旧 Key 记录丢失");
  if (current.targetRemainQuota === undefined) {
    const observation = await conservativeRemainQuotaAfterDrain(oldAccount.newapiTokenId);
    await rebuildOperationQuotaSnapshot(current);
    materializedPreDrainSnapshot = true;
    const billingPeriod = await getUserBillingPeriod(
      current.feishuUserId,
      current.billingPeriod,
    );
    if (
      !billingPeriod ||
      typeof billingPeriod.expectedAvailableQuota !== "number" ||
      !Number.isInteger(billingPeriod.expectedAvailableQuota) ||
      typeof billingPeriod.authorizedQuota !== "number" ||
      !Number.isInteger(billingPeriod.authorizedQuota) ||
      typeof billingPeriod.authoritativeConsumedQuota !== "number" ||
      !Number.isInteger(billingPeriod.authoritativeConsumedQuota)
    ) {
      throw new Error("Key 轮换缺少已物化的账本额度快照");
    }
    const rotationTarget = calculateKeyRotationTarget({
      expectedAvailableQuota: billingPeriod.expectedAvailableQuota,
      observedRemainQuota: observation.remainQuota,
    });
    current = await freezeSnapshot(current, {
      observedRemainBefore: observation.remainQuota,
      targetRemainQuota: rotationTarget.targetRemainQuota,
      upstreamTokenIdBefore: oldAccount.newapiTokenId,
      tokenAccountIdBefore: oldAccount.id,
      evidence: {
        ...current.evidence,
        expectedAvailableQuota: rotationTarget.expectedAvailableQuota,
        authoritativeConsumedQuota: billingPeriod.authoritativeConsumedQuota,
        authorizedQuota: billingPeriod.authorizedQuota,
        observedRemainQuota: rotationTarget.observedRemainQuota,
        observedRemainQuotaSamples: observation.observations.join(","),
        upstreamDelta: rotationTarget.upstreamDelta,
        keyRotationTargetLimitedBy: rotationTarget.limitedBy,
        quotaSourceVersion: billingPeriod.sourceVersion,
        quotaSettledThrough: billingPeriod.settledThrough,
      },
    });
  } else {
    current = await freezeSnapshot(current, {});
  }
  if (current.state === "snapshot_stable") {
    current = (await transitionQuotaOperation(current.id, "upstream_applying")) ?? current;
  }

  const tokenName = `TI rotation ${current.id}`.slice(0, 50);
  let upstreamTokenIdAfter = current.upstreamTokenIdAfter;
  let key: string | undefined;
  if (!upstreamTokenIdAfter) {
    const existingUpstream = await findNewApiTokenByName(tokenName);
    if (existingUpstream?.id !== undefined) {
      upstreamTokenIdAfter = String(existingUpstream.id);
      key = await getNewApiTokenKey(upstreamTokenIdAfter);
    } else {
      const created = await createNewApiToken({ name: tokenName, remainQuota: 0 });
      upstreamTokenIdAfter = created.newapiTokenId;
      key = created.key;
    }
    await disableNewApiTokenAndVerify(upstreamTokenIdAfter);
  }
  if (!key) key = await getNewApiTokenKey(upstreamTokenIdAfter);
  if (!key) throw new Error("NewAPI 未返回可恢复的新 Key 明文");

  const accounts = await listTokenAccountsForUser(current.feishuUserId);
  let newAccount = current.tokenAccountIdAfter
    ? accounts.find((item) => item.id === current.tokenAccountIdAfter)
    : accounts.find(
        (item) =>
          item.feishuUserId === current.feishuUserId &&
          item.newapiTokenId === upstreamTokenIdAfter,
      );
  if (!newAccount) {
    newAccount = await addTokenAccountForQuotaOperation({
      feishuUserId: current.feishuUserId,
      tokenRequestId: current.requestId ?? current.id,
      newapiTokenId: upstreamTokenIdAfter,
      keyHash: sha256Hex(key),
      billingPeriod: oldAccount.billingPeriod,
      status: "pending_activation",
      operationGeneration: current.operationGeneration,
    });
  }
  current =
    (await updateQuotaOperation(current.id, {
      upstreamTokenIdAfter,
      tokenAccountIdAfter: newAccount.id,
      credentialCiphertext:
        current.credentialCiphertext ?? sealQuotaCredential(key, current.id),
    })) ?? current;

  const targetRemainQuota = current.targetRemainQuota;
  if (targetRemainQuota === undefined) {
    throw new Error("Key 轮换缺少冻结的新 Key 目标余额");
  }

  await updateNewApiTokenQuota({
    newapiTokenId: upstreamTokenIdAfter,
    remainQuota: targetRemainQuota,
  });
  const newRemain = await getNewApiTokenRemainQuota(upstreamTokenIdAfter);
  if (newRemain !== targetRemainQuota) {
    throw new Error("新 Key 余额写后校验失败");
  }
  current =
    (await transitionQuotaOperation(current.id, "upstream_applied", {
      observedRemainAfter: newRemain,
    })) ?? current;

  await disableNewApiTokenAndVerify(oldAccount.newapiTokenId);
  await enableNewApiTokenAndVerify(upstreamTokenIdAfter);
  if (!getConfig().newapi.mock) {
    const [oldState, newState] = await Promise.all([
      getNewApiTokenControlState(oldAccount.newapiTokenId),
      getNewApiTokenControlState(upstreamTokenIdAfter),
    ]);
    if (oldState.status === 1 || newState.status !== 1) {
      throw new Error("NewAPI Key 启停状态写后校验失败");
    }
  }
  current =
    (await transitionQuotaOperation(current.id, "upstream_activated")) ?? current;
  const finalized = await finalizeTokenRotationForQuotaOperation({
    feishuUserId: current.feishuUserId,
    oldTokenAccountId: oldAccount.id,
    newTokenAccountId: newAccount.id,
    operationGeneration: current.operationGeneration,
    operationId: current.id,
  });
  current =
    (await transitionQuotaOperation(current.id, "local_finalized")) ?? current;
  current = (await transitionQuotaOperation(current.id, "reconciling")) ?? current;
  current = await clearCommittedDepartmentReservation(current);
  if (materializedPreDrainSnapshot) {
    // The normal uninterrupted rotation path made an authoritative snapshot
    // after drain and key rotation itself adds no usage or ledger rows. Refresh
    // only token metadata here; retries/recovery retain the full rebuild below.
    const refreshed = await refreshUserBillingTokenMetadataForQuotaOperation(
      current.feishuUserId,
      current.billingPeriod,
    );
    if (!refreshed) await rebuildOperationQuotaSnapshot(current);
  } else {
    await rebuildOperationQuotaSnapshot(current);
  }
  if (current.requestId) {
    await updateOperationTokenRequestAfterMaterialization(current, current.requestId, {
      status: "provisioned",
      tokenAccountId: finalized.newAccount.id,
      errorMessage: undefined,
    });
  }
  return (
    (await transitionQuotaOperation(current.id, "completed", {
      reservedDepartmentQuota: 0,
      nextRetryAt: undefined,
    })) ?? current
  );
}

async function handleMonthlyOpen(operation: QuotaOperation) {
  const assignedMonthlyQuota = operation.requestedAssignedQuota;
  if (assignedMonthlyQuota === undefined) throw new Error("月度开账缺少用户策略额度");
  let current = operation;
  const activeAccount = await getActiveTokenForUser(current.feishuUserId);
  const account =
    activeAccount ??
    (current.tokenAccountIdBefore
      ? (await listTokenAccountsForUser(current.feishuUserId)).find(
          (item) => item.id === current.tokenAccountIdBefore,
        ) ?? null
      : null);
  assertFrozenOperationAccountBinding(operation, account);
  if (current.state === "local_finalized" || current.state === "reconciling") {
    return finalizeCommon(current, account, {
      billingPeriod: current.billingPeriod,
      status: "active",
      drainStartedAt: undefined,
    });
  }
  if (
    current.departmentId &&
    current.reservedDepartmentQuota !== assignedMonthlyQuota
  ) {
    current =
      (await reserveQuotaOperationDepartmentBudget(current.id, assignedMonthlyQuota)) ?? current;
  }
  if (
    account &&
    (!current.tokenAccountIdBefore || !current.upstreamTokenIdBefore)
  ) {
    current =
      (await updateQuotaOperation(current.id, {
        tokenAccountIdBefore: account.id,
        upstreamTokenIdBefore: account.newapiTokenId,
      })) ?? current;
  }
  const prepared = await prepareAndDrain(current, account);
  if (!prepared.ready) return prepared.operation;
  current = prepared.operation;
  const upstreamWriteStarted =
    current.state === "upstream_applying" ||
    current.state === "upstream_applied" ||
    current.state === "upstream_activated";
  if (current.targetRemainQuota === undefined) {
    await rebuildOperationQuotaSnapshot(current);
    const newPeriod = await getUserBillingPeriod(
      current.feishuUserId,
      current.billingPeriod,
    );
    const consumedInNewPeriod = Math.max(
      newPeriod?.authoritativeConsumedQuota ?? 0,
      0,
    );
    const targetRemainQuota = Math.max(
      assignedMonthlyQuota - consumedInNewPeriod,
      0,
    );
    const observedRemainBefore = account?.newapiTokenId
      ? await stableRemainQuota(account.newapiTokenId)
      : 0;
    current = await freezeSnapshot(current, {
      observedRemainBefore,
      targetRemainQuota,
      upstreamTokenIdBefore: account?.newapiTokenId,
      tokenAccountIdBefore: account?.id,
      evidence: {
        ...current.evidence,
        consumedInNewPeriod,
      },
    });
  } else {
    if (account?.newapiTokenId && !upstreamWriteStarted) {
      const stable = await stableRemainQuota(account.newapiTokenId);
      if (stable !== current.observedRemainBefore) {
        throw new Error("月度开账排空后上游余额已变化，需要人工复核");
      }
    }
    current = await freezeSnapshot(current, {});
  }
  if (
    account?.newapiTokenId &&
    current.state !== "upstream_applied" &&
    current.state !== "upstream_activated"
  ) {
    current = await applyAndVerifyBalance(current);
  }
  await appendQuotaLedgerEntry({
    operationId: current.id,
    feishuUserId: current.feishuUserId,
    departmentId: current.departmentId,
    period: current.billingPeriod,
    signedQuota: assignedMonthlyQuota,
    entryType: "period_open_authorization",
    sourceType: "quota_operation",
    sourceId: current.id,
  });
  if (account?.newapiTokenId && current.state === "upstream_applied") {
    await enableNewApiTokenAndVerify(account.newapiTokenId);
    if (!getConfig().newapi.mock) {
      const upstreamState = await getNewApiTokenControlState(account.newapiTokenId);
      if (upstreamState.status !== 1) {
        throw new Error("月度开账完成后无法重新启用 NewAPI Key");
      }
    }
    current =
      (await transitionQuotaOperation(current.id, "upstream_activated")) ?? current;
  }
  return finalizeCommon(current, account, {
    billingPeriod: current.billingPeriod,
    status: "active",
    drainStartedAt: undefined,
  });
}

async function compensateKeyRotationBeforeUpstream(
  operation: QuotaOperation,
  message: string,
) {
  if (!canCompensateKeyRotationBeforeUpstream(operation)) return null;
  const oldAccount = await accountBeforeRotation(operation);
  if (oldAccount?.newapiTokenId) {
    await enableNewApiTokenAndVerify(oldAccount.newapiTokenId);
    if (!getConfig().newapi.mock) {
      const state = await getNewApiTokenControlState(oldAccount.newapiTokenId);
      if (state.status !== 1) throw new Error("Key 更换补偿无法重新启用旧 Key");
    }
  }
  if (oldAccount && ["draining", "settling"].includes(oldAccount.status)) {
    await updateOperationTokenAccount(
      operation,
      oldAccount.id,
      { status: "active", drainStartedAt: undefined },
      ["draining", "settling"],
    );
  }
  await reopenAdmission(operation);
  const compensating =
    (await transitionQuotaOperation(operation.id, "compensating", {
      lastErrorCode: "pre_switch_failure",
      lastErrorMessage: message,
      nextRetryAt: undefined,
      evidence: {
        ...operation.evidence,
        compensatedFromState: operation.state,
        compensatedAt: nowIso(),
      },
    })) ?? operation;
  return (
    (await transitionQuotaOperation(compensating.id, "compensated", {
      reservedDepartmentQuota: 0,
      nextRetryAt: undefined,
    })) ?? compensating
  );
}

async function markOperationFailure(operationId: string, error: unknown) {
  const current = await findQuotaOperationById(operationId);
  if (
    !current ||
    current.state === "completed" ||
    current.state === "compensated" ||
    current.state === "cancelled"
  ) return current;
  const message = error instanceof Error ? error.message : "quota operation failed";
  const compensated = await compensateKeyRotationBeforeUpstream(current, message);
  if (compensated) {
    if (current.requestId) {
      await updateOperationTokenRequest(current, current.requestId, {
        status: "approved_provision_failed",
        errorMessage: message,
      }).catch(() => undefined);
    }
    return compensated;
  }
  const waitingForDepartmentBudget = message.includes("部门可用额度不足");
  const userInactive = error instanceof InactiveQuotaOperationUserError;
  const uncertain =
    userInactive || (!waitingForDepartmentBudget && current.attemptCount >= maxAttempts);
  const nextState = uncertain ? "manual_review" : "retryable_failed";
  const updated = await transitionQuotaOperation(current.id, nextState, {
    lastErrorCode: userInactive
      ? "user_inactive"
      : waitingForDepartmentBudget
      ? "department_budget_insufficient"
      : uncertain
        ? "upstream_state_uncertain"
        : "retryable_failure",
    lastErrorMessage: message,
    nextRetryAt: uncertain
      ? undefined
      : addMilliseconds(nowIso(), waitingForDepartmentBudget ? 60_000 : retryDelayMs),
    evidence: {
      ...current.evidence,
      retryFromState: current.state,
      lastFailureAt: nowIso(),
    },
  }).catch(async () =>
    updateQuotaOperation(current.id, {
      state: "manual_review",
      lastErrorCode: "state_transition_failure",
      lastErrorMessage: message,
      nextRetryAt: undefined,
    }),
  );
  if (current.requestId) {
    await updateOperationTokenRequest(current, current.requestId, {
      status: "approved_provision_failed",
      errorMessage: message,
    }).catch(() => undefined);
  }
  return updated;
}

export function canResumeBudgetBlockedOperation(operation: QuotaOperation) {
  return (
    operation.operationType === "first_provision" &&
    operation.state === "manual_review" &&
    !operation.upstreamTokenIdAfter &&
    !operation.tokenAccountIdAfter &&
    operation.lastErrorMessage?.includes("部门可用额度不足") === true &&
    operation.evidence?.retryFromState === "planned"
  );
}

async function runClaimedQuotaOperation(
  operationId: string,
  executionFence?: QuotaExecutionFence,
) {
  const leaseId = randomId("qow");
  const leaseMilliseconds = 2 * 60_000;
  const claimed = await claimQuotaOperationExecution({
    operationId,
    leaseId,
    leaseDurationMs: leaseMilliseconds,
  });
  if (!claimed) throw new Error("额度操作正在由其他 worker 执行");
  executionFence?.assertHeld();
  let leaseRenewal: Promise<void> | undefined;
  const leaseTimer = setInterval(() => {
    if (leaseRenewal) return;
    leaseRenewal = renewQuotaOperationExecution({
      operationId,
      leaseId,
      leaseDurationMs: leaseMilliseconds,
    })
      .then((renewed) => {
        if (!renewed) {
          executionFence?.markLost(new Error("额度操作 worker lease 续租被拒绝"));
        }
      })
      .catch((error) => executionFence?.markLost(error))
      .finally(() => {
        leaseRenewal = undefined;
      });
  }, 30_000);
  leaseTimer.unref?.();
  let operation = claimed;
  try {
    executionFence?.assertHeld();
    if (
      operation.state === "completed" ||
      operation.state === "compensated" ||
      operation.state === "cancelled"
    ) {
      return operation;
    }
    if (operation.state === "manual_review") {
      if (canAutoResumeKeyRotationObservationFailure(operation)) {
        operation =
          (await transitionQuotaOperation(operation.id, "planned", {
            nextRetryAt: undefined,
            lastErrorCode: undefined,
            lastErrorMessage: undefined,
            evidence: {
              ...operation.evidence,
              legacyObservationRetryFromState: quotaOperationRetryResumeState(
                operation.evidence?.retryFromState,
              ),
            },
          })) ?? operation;
      } else if (canResumeBudgetBlockedOperation(operation)) {
        operation =
          (await transitionQuotaOperation(operation.id, "planned", {
            nextRetryAt: undefined,
            lastErrorCode: undefined,
            lastErrorMessage: undefined,
          })) ?? operation;
      } else {
        return operation;
      }
    }
    if (operation.state === "retryable_failed") {
      operation =
        (await transitionQuotaOperation(
          operation.id,
          quotaOperationRetryResumeState(operation.evidence?.retryFromState),
          {
            nextRetryAt: undefined,
            lastErrorCode: undefined,
            lastErrorMessage: undefined,
          },
        )) ?? operation;
    }
    await assertQuotaOperationUserActive(operation);
    operation =
      (await updateQuotaOperation(
        operation.id,
        { attemptCount: operation.attemptCount + 1 },
        [operation.state],
      )) ?? operation;
    if (operation.operationType === "first_provision") return await handleFirstProvision(operation);
    if (operation.operationType === "quota_adjust") return await handleQuotaAdjustment(operation);
    if (operation.operationType === "key_rotation") return await handleKeyRotation(operation);
    if (operation.operationType === "monthly_open") return await handleMonthlyOpen(operation);
    throw new Error(`不支持的额度操作类型: ${operation.operationType}`);
  } catch (error) {
    if (isQuotaExecutionFenceLostError(error) || executionFence?.lost) {
      throw error;
    }
    await markOperationFailure(operation.id, error);
    throw error;
  } finally {
    clearInterval(leaseTimer);
    const inFlightRenewal = leaseRenewal;
    if (inFlightRenewal) await inFlightRenewal;
    executionFence?.assertHeld();
    await releaseQuotaOperationExecution({ operationId, leaseId }).catch(() => undefined);
  }
}

async function runQuotaOperationInner(
  operationId: string,
  options: { waitForFence?: boolean } = {},
) {
  const candidate = await findQuotaOperationById(operationId);
  if (!candidate) throw new Error("额度操作不存在");
  // The database session advisory lock is the cross-process execution fence.
  // It is acquired before the worker lease can be claimed and held across the
  // full Saga, so an expired scheduling lease cannot create two concurrent
  // owners. A process/connection death releases the fence automatically and a
  // new worker resumes from the durable phase and frozen targets.
  return withUserQuotaOperationLock(candidate.feishuUserId, (executionFence) =>
    runClaimedQuotaOperation(operationId, executionFence),
    { wait: options.waitForFence ?? true },
  );
}

export async function runQuotaOperation(
  operationId: string,
  options: { waitForFence?: boolean } = {},
) {
  const release = await acquireQuotaOperationSlot();
  try {
    return await runQuotaOperationInner(operationId, options);
  } finally {
    release();
  }
}

export async function runDueQuotaOperations(limit = 20) {
  const now = nowIso();
  // Shared store implementations must filter terminal/future rows in SQL via
  // quota_operations_worker_idx. Keeping this as a distinct interface avoids
  // starving an old retry behind a large tail of recently completed rows.
  const operations = (await listDueQuotaOperations({ now, limit: Math.max(limit * 4, limit) }))
    .filter(
      (item: QuotaOperation) =>
        (item.state !== "manual_review" ||
          canAutoResumeKeyRotationObservationFailure(item)),
    )
    .slice(0, limit);
  const results = [];
  for (const operation of operations) {
    try {
      results.push({
        operationId: operation.id,
        result: await runQuotaOperation(operation.id, { waitForFence: false }),
      });
    } catch (error) {
      results.push({
        operationId: operation.id,
        error: error instanceof Error ? error.message : "quota operation failed",
      });
    }
  }
  return results;
}

function scheduleQuotaWorker(delayMs: number) {
  if (quotaSagaRuntime.workerTimer) {
    clearTimeout(quotaSagaRuntime.workerTimer);
  }
  quotaSagaRuntime.workerTimer = setTimeout(async () => {
    try {
      if (!quotaWritesPaused()) await runDueQuotaOperations();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "tokeninside.quota.worker_failed",
          errorMessage: error instanceof Error ? error.message : "quota worker failed",
        }),
      );
    } finally {
      scheduleQuotaWorker(2_000);
    }
  }, Math.max(delayMs, 250));
  quotaSagaRuntime.workerTimer.unref?.();
}

export function ensureQuotaOperationWorker() {
  if (quotaSagaRuntime.workerStarted) return;
  quotaSagaRuntime.workerStarted = true;
  scheduleQuotaWorker(500);
}

export async function enqueueFirstProvision(input: {
  feishuUserId: string;
  departmentId?: string;
  approvedMonthlyQuota: number;
  requestId: string;
  createdByOpenId?: string;
}) {
  await assertQuotaWriteActionEnabled("first_provision");
  const billingPeriod = await getCurrentPackageBillingPeriod();
  const operation = await createQuotaOperation({
    operationType: "first_provision",
    idempotencyKey: `quota-operation:${input.requestId}`,
    feishuUserId: input.feishuUserId,
    departmentId: input.departmentId,
    billingPeriod,
    requestedAssignedQuota: toNewApiQuota(input.approvedMonthlyQuota),
    requestId: input.requestId,
    createdByOpenId: input.createdByOpenId,
  });
  ensureQuotaOperationWorker();
  return operation;
}

export async function enqueueQuotaAdjustment(input: {
  feishuUserId: string;
  departmentId?: string;
  approvedMonthlyQuota: number;
  clientRequestId: string;
  requestId?: string;
  createdByOpenId?: string;
}) {
  await assertQuotaWriteActionEnabled("quota_adjust");
  const activeAccount = await getActiveTokenForUser(input.feishuUserId);
  const billingPeriod =
    activeAccount?.billingPeriod ?? (await getCurrentPackageBillingPeriod());
  const operation = await createQuotaOperation({
    operationType: "quota_adjust",
    idempotencyKey: `quota-adjust:${input.clientRequestId}`,
    feishuUserId: input.feishuUserId,
    departmentId: input.departmentId,
    billingPeriod,
    requestedAssignedQuota: toNewApiQuota(input.approvedMonthlyQuota),
    requestId: input.requestId,
    createdByOpenId: input.createdByOpenId,
  });
  ensureQuotaOperationWorker();
  return operation;
}

export async function enqueueKeyRotation(input: {
  feishuUserId: string;
  departmentId?: string;
  clientRequestId: string;
  requestId: string;
  createdByOpenId?: string;
}) {
  await assertQuotaWriteActionEnabled("key_rotation");
  const activeAccount = await getActiveTokenForUser(input.feishuUserId);
  const billingPeriod =
    activeAccount?.billingPeriod ?? (await getCurrentPackageBillingPeriod());
  const operation = await createQuotaOperation({
    operationType: "key_rotation",
    idempotencyKey: `key-reset:${input.clientRequestId}`,
    feishuUserId: input.feishuUserId,
    departmentId: input.departmentId,
    billingPeriod,
    requestId: input.requestId,
    createdByOpenId: input.createdByOpenId,
  });
  ensureQuotaOperationWorker();
  return operation;
}

export async function enqueueMonthlyOpen(input: {
  feishuUserId: string;
  departmentId?: string;
  period: string;
  assignedMonthlyQuota: number;
  createdByOpenId?: string;
}) {
  await assertQuotaWriteActionEnabled("monthly_open");
  const operation = await createQuotaOperation({
    operationType: "monthly_open",
    idempotencyKey: `monthly-open:${input.period}:${input.feishuUserId}`,
    feishuUserId: input.feishuUserId,
    departmentId: input.departmentId,
    billingPeriod: input.period,
    requestedAssignedQuota: input.assignedMonthlyQuota,
    createdByOpenId: input.createdByOpenId,
  });
  ensureQuotaOperationWorker();
  return operation;
}

export async function enqueueMonthlyOpenBatch(
  inputs: Array<{
    feishuUserId: string;
    departmentId?: string;
    period: string;
    assignedMonthlyQuota: number;
    createdByOpenId?: string;
  }>,
  options: { executionSource?: "root" | "package_reset" } = {},
) {
  await assertQuotaWriteActionEnabled("monthly_open");
  const operations = await createMonthlyOpenQuotaOperations(
    inputs.map((input) => ({
      feishuUserId: input.feishuUserId,
      departmentId: input.departmentId,
      billingPeriod: input.period,
      assignedMonthlyQuota: input.assignedMonthlyQuota,
      createdByOpenId: input.createdByOpenId,
    })),
    options,
  );
  ensureQuotaOperationWorker();
  return operations;
}

function quotaCredentialDeliveryToken(operation: QuotaOperation) {
  if (!operation.credentialCiphertext) return undefined;
  return hmacSha256Base64Url(
    requireSessionSecret(),
    [
      "quota-credential-delivery-v1",
      operation.id,
      operation.feishuUserId,
      sha256Hex(operation.credentialCiphertext),
    ].join(":"),
  );
}

export async function claimQuotaOperationCredential(
  operationId: string,
  feishuUserId: string,
) {
  const candidate = await findQuotaOperationById(operationId);
  if (
    !candidate ||
    candidate.feishuUserId !== feishuUserId ||
    candidate.state !== "completed" ||
    !candidate.credentialCiphertext ||
    candidate.credentialDeliveredAt
  ) {
    return null;
  }
  return withUserQuotaOperationLock(feishuUserId, async () => {
    const user = await getUserById(feishuUserId);
    if (!user || (user.status && user.status !== "active")) return null;
    const operation = await findQuotaOperationById(operationId);
    if (!operation || operation.feishuUserId !== feishuUserId) return null;
    if (
      operation.state !== "completed" ||
      !operation.credentialCiphertext ||
      operation.credentialDeliveredAt
    ) {
      return null;
    }
    const key = openQuotaCredential(operation.credentialCiphertext, operation.id);
    const deliveryToken = quotaCredentialDeliveryToken(operation);
    if (!deliveryToken) return null;
    // Claim is deliberately read-only. A lost HTTP response can therefore be
    // retried and returns the exact same encrypted credential and token. The
    // client explicitly acknowledges only after it has received the body.
    return { key, deliveryToken };
  });
}

export async function acknowledgeQuotaOperationCredential(input: {
  operationId: string;
  feishuUserId: string;
  deliveryToken: string;
}) {
  return withUserQuotaOperationLock(input.feishuUserId, async () => {
    const user = await getUserById(input.feishuUserId);
    if (!user || (user.status && user.status !== "active")) return false;
    const operation = await findQuotaOperationById(input.operationId);
    if (!operation || operation.feishuUserId !== input.feishuUserId) {
      return false;
    }
    if (operation.credentialDeliveredAt) {
      const acknowledgedTokenHash = operation.evidence?.credentialDeliveryTokenHash;
      return (
        typeof acknowledgedTokenHash === "string" &&
        safeEqual(acknowledgedTokenHash, sha256Hex(input.deliveryToken))
      );
    }
    if (operation.state !== "completed" || !operation.credentialCiphertext) return false;
    const expected = quotaCredentialDeliveryToken(operation);
    if (!expected || !safeEqual(expected, input.deliveryToken)) return false;
    const updated = await updateQuotaOperation(operation.id, {
      credentialCiphertext: undefined,
      credentialDeliveredAt: nowIso(),
      evidence: {
        ...operation.evidence,
        credentialDeliveryTokenHash: sha256Hex(input.deliveryToken),
      },
    });
    return Boolean(updated?.credentialDeliveredAt);
  });
}
