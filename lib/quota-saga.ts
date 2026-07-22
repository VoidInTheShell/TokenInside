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
import { getNewApiUserAuthoritativeQuotaSnapshot } from "@/lib/newapi-reporting";
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
  getUserById,
  getUserQuotaState,
  listDueQuotaOperations,
  listTokenAccountsForUser,
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
      getConfig().quotaControl.operationConcurrencyMax ||
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
    maxConcurrency: getConfig().quotaControl.operationConcurrencyMax,
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

async function assignedQuotaForUser(feishuUserId: string, period: string) {
  const policy = await getEffectiveUserQuotaPolicy(feishuUserId, period);
  return policy?.assignedMonthlyQuota ?? 0;
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

async function prepareDirectNewApiControl(
  operation: QuotaOperation,
  account?: TokenAccount | null,
) {
  let current = (await findQuotaOperationById(operation.id)) ?? operation;
  if (current.state === "planned" || current.state === "budget_reserved") {
    current =
      (await transitionQuotaOperation(current.id, "local_prepared", {
        upstreamTokenIdBefore: account?.newapiTokenId,
        tokenAccountIdBefore: account?.id,
        evidence: {
          ...current.evidence,
          controlPlaneMode: "newapi_direct",
        },
      })) ?? current;
  }
  if (current.state === "local_prepared") {
    await saveUserQuotaState({
      feishuUserId: current.feishuUserId,
      admission: "closed",
      activeGeneration: current.operationGeneration,
      operationId: current.id,
      closedReason: "newapi_control_update",
      updatedAt: nowIso(),
    });
    current =
      (await transitionQuotaOperation(current.id, "admission_closed")) ?? current;
  }
  if (current.state === "admission_closed") {
    if (!account?.newapiTokenId) {
      current =
        (await transitionQuotaOperation(current.id, "snapshot_stable", {
          nextRetryAt: undefined,
        })) ?? current;
      return { ready: true as const, operation: current };
    }
    await disableNewApiTokenAndVerify(account.newapiTokenId);
    const disabledAt = nowIso();
    const readyAt = addMilliseconds(
      disabledAt,
      getConfig().newapi.mock
        ? 0
        : getConfig().quotaControl.directConsumptionDrainGraceMs,
    );
    current =
      (await transitionQuotaOperation(current.id, "upstream_frozen", {
        nextRetryAt: readyAt,
        evidence: {
          ...current.evidence,
          upstreamDisabledAt: disabledAt,
          directDrainReadyAt: readyAt,
        },
      })) ?? current;
  }
  if (current.state === "upstream_frozen" || current.state === "draining") {
    if (account?.newapiTokenId) {
      const state = await getNewApiTokenControlState(account.newapiTokenId);
      if (state.status !== 2) await disableNewApiTokenAndVerify(account.newapiTokenId);
    }
    const readyAt =
      typeof current.evidence?.directDrainReadyAt === "string"
        ? current.evidence.directDrainReadyAt
        : nowIso();
    if (!getConfig().newapi.mock && Date.now() < new Date(readyAt).getTime()) {
      current =
        (await updateQuotaOperation(
          current.id,
          { nextRetryAt: readyAt },
          [current.state],
        )) ?? current;
      return { ready: false as const, operation: current };
    }
    current =
      (await updateQuotaOperation(
        current.id,
        { nextRetryAt: undefined },
        [current.state],
      )) ?? current;
  }
  return { ready: true as const, operation: current };
}

async function finalizeDirectControl(
  operation: QuotaOperation,
  account?: TokenAccount | null,
  accountPatch: Partial<TokenAccount> = {},
) {
  let current = (await findQuotaOperationById(operation.id)) ?? operation;
  await assertQuotaOperationUserActive(current);
  if (account) {
    const updated = await updateOperationTokenAccount(
      current,
      account.id,
      {
        ...accountPatch,
        operationGeneration: current.operationGeneration,
      },
      ["active", "draining", "settling"],
    );
    if (!updated) throw new Error("NewAPI 控制操作最终化时 Key 账户状态已变化");
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
      evidence: {
        ...current.evidence,
        reportingSource: "newapi",
      },
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
  if (!account?.newapiTokenId) throw new Error("当前用户没有可调额的 active NewAPI Key");
  assertFrozenOperationAccountBinding(operation, account);
  const assignedQuotaAfter = operation.requestedAssignedQuota;
  if (assignedQuotaAfter === undefined) throw new Error("调额操作缺少目标套餐额度");
  const assignedQuotaBefore =
    operation.assignedQuotaBefore ??
    (await assignedQuotaForUser(operation.feishuUserId, operation.billingPeriod));
  const delta = assignedQuotaAfter - assignedQuotaBefore;
  let current = operation;
  if (current.state === "local_finalized" || current.state === "reconciling") {
    return finalizeDirectControl(current, account, {
      status: "active",
      drainStartedAt: undefined,
    });
  }
  if (delta > 0 && current.reservedDepartmentQuota !== delta) {
    current =
      (await reserveQuotaOperationDepartmentBudget(current.id, delta)) ?? current;
  }
  current =
    (await updateQuotaOperation(current.id, {
      assignedQuotaBefore,
      upstreamTokenIdBefore: account.newapiTokenId,
      tokenAccountIdBefore: account.id,
      evidence: {
        ...current.evidence,
        allocationDelta: delta,
      },
    })) ?? current;
  const prepared = await prepareDirectNewApiControl(current, account);
  if (!prepared.ready) return prepared.operation;
  current = prepared.operation;
  const writeStarted = [
    "upstream_applying",
    "upstream_applied",
    "upstream_activated",
  ].includes(current.state);
  if (current.targetRemainQuota === undefined) {
    const authoritative = await getNewApiUserAuthoritativeQuotaSnapshot(
      current.feishuUserId,
    );
    if (authoritative.truncated) {
      throw new Error("NewAPI 当前套餐周期日志达到查询上限，拒绝更改额度上限");
    }
    if (authoritative.period !== current.billingPeriod) {
      throw new Error(
        `额度上限周期已变化：操作 ${current.billingPeriod}，NewAPI 视图 ${authoritative.period}`,
      );
    }
    if (assignedQuotaAfter < authoritative.consumedQuota) {
      throw new Error(
        `额度上限不能低于当前周期已消费额度 ${authoritative.consumedQuota}`,
      );
    }
    const observedRemainBefore = await stableRemainQuota(account.newapiTokenId);
    current = await freezeSnapshot(current, {
      observedRemainBefore,
      targetRemainQuota: assignedQuotaAfter - authoritative.consumedQuota,
      upstreamTokenIdBefore: account.newapiTokenId,
      tokenAccountIdBefore: account.id,
      evidence: {
        ...current.evidence,
        allocationDelta: delta,
        quotaAuthority: "newapi_log",
        consumedInPackagePeriod: authoritative.consumedQuota,
        authoritativeRequestCount: authoritative.requestCount,
        authoritativeWindowStartAt: authoritative.windowStartAt,
      },
    });
  } else if (!writeStarted && current.state !== "snapshot_stable") {
    current = await freezeSnapshot(current, {});
  }
  if (current.state !== "upstream_applied" && current.state !== "upstream_activated") {
    current = await applyAndVerifyBalance(current);
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
  if (current.state === "upstream_applied") {
    await enableNewApiTokenAndVerify(account.newapiTokenId);
    current =
      (await transitionQuotaOperation(current.id, "upstream_activated")) ?? current;
  }
  return finalizeDirectControl(current, account, {
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
  if (assignedMonthlyQuota === undefined) throw new Error("首次发放缺少套餐额度");
  let current = operation;
  const unexpectedActive = await getActiveTokenForUser(current.feishuUserId);
  if (unexpectedActive && unexpectedActive.id !== current.tokenAccountIdAfter) {
    throw new Error("首次发放期间用户已存在其他 active Key");
  }
  if (
    current.state === "upstream_activated" ||
    current.state === "local_finalized" ||
    current.state === "reconciling"
  ) {
    const account = await firstProvisionAccount(current);
    if (!account) throw new Error("首次发放恢复时找不到新 TokenAccount");
    return finalizeFirstProvision(current, account, assignedMonthlyQuota, assignedMonthlyQuota);
  }
  if (
    current.departmentId &&
    current.reservedDepartmentQuota !== assignedMonthlyQuota
  ) {
    current =
      (await reserveQuotaOperationDepartmentBudget(
        current.id,
        assignedMonthlyQuota,
      )) ?? current;
  }
  const prepared = await prepareDirectNewApiControl(current);
  if (!prepared.ready) return prepared.operation;
  current = prepared.operation;
  if (current.targetRemainQuota === undefined) {
    const authoritative = await getNewApiUserAuthoritativeQuotaSnapshot(
      current.feishuUserId,
    );
    if (authoritative.truncated) {
      throw new Error("NewAPI 当前套餐周期日志达到查询上限，拒绝执行首次发放");
    }
    if (authoritative.period !== current.billingPeriod) {
      throw new Error(
        `首次发放周期已变化：操作 ${current.billingPeriod}，NewAPI 视图 ${authoritative.period}`,
      );
    }
    if (assignedMonthlyQuota < authoritative.consumedQuota) {
      throw new Error(
        `额度上限不能低于当前周期已消费额度 ${authoritative.consumedQuota}`,
      );
    }
    current = await freezeSnapshot(current, {
      observedRemainBefore: 0,
      targetRemainQuota: assignedMonthlyQuota - authoritative.consumedQuota,
      evidence: {
        ...current.evidence,
        quotaAuthority: "newapi_log",
        allocationDelta: assignedMonthlyQuota,
        consumedInPackagePeriod: authoritative.consumedQuota,
        authoritativeRequestCount: authoritative.requestCount,
        authoritativeWindowStartAt: authoritative.windowStartAt,
      },
    });
  }
  if (current.state !== "snapshot_stable") {
    current = await freezeSnapshot(current, {});
  }
  if (current.state === "snapshot_stable") {
    current =
      (await transitionQuotaOperation(current.id, "upstream_applying")) ?? current;
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
    const existing = await findNewApiTokenByName(tokenName);
    if (existing?.id !== undefined) {
      upstreamTokenIdAfter = String(existing.id);
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
      accounts.find((item) => item.newapiTokenId === upstreamTokenIdAfter) ??
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

  const targetRemainQuota = current.targetRemainQuota ?? assignedMonthlyQuota;
  if (current.state !== "upstream_applied" && current.state !== "upstream_activated") {
    await updateNewApiTokenQuota({
      newapiTokenId: upstreamTokenIdAfter,
      remainQuota: targetRemainQuota,
    });
    const observedRemainAfter = await getNewApiTokenRemainQuota(upstreamTokenIdAfter);
    if (observedRemainAfter !== targetRemainQuota) {
      throw new Error("首次发放余额写后校验失败");
    }
    current =
      (await transitionQuotaOperation(current.id, "upstream_applied", {
        observedRemainAfter,
      })) ?? current;
  }
  if (current.state === "upstream_applied") {
    await enableNewApiTokenAndVerify(upstreamTokenIdAfter);
    current =
      (await transitionQuotaOperation(current.id, "upstream_activated")) ?? current;
  }
  return finalizeFirstProvision(
    current,
    account,
    assignedMonthlyQuota,
    assignedMonthlyQuota,
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
  const oldAccount = await accountBeforeRotation(current);
  if (!oldAccount?.newapiTokenId) {
    throw new Error("当前用户没有可轮换的 active NewAPI Key");
  }
  if (!current.tokenAccountIdBefore || !current.upstreamTokenIdBefore) {
    current =
      (await updateQuotaOperation(current.id, {
        tokenAccountIdBefore: oldAccount.id,
        upstreamTokenIdBefore: oldAccount.newapiTokenId,
      })) ?? current;
  }
  current = await quarantineUnexpectedRotationAccounts(current, oldAccount);
  if (current.state === "local_finalized" || current.state === "reconciling") {
    const accounts = await listTokenAccountsForUser(current.feishuUserId);
    const newAccount = accounts.find((item) => item.id === current.tokenAccountIdAfter);
    if (!newAccount) throw new Error("Key 更换最终化时找不到新 TokenAccount");
    if (current.state === "local_finalized") {
      current =
        (await transitionQuotaOperation(current.id, "reconciling")) ?? current;
    }
    if (current.requestId) {
      await updateOperationTokenRequestAfterMaterialization(current, current.requestId, {
        status: "provisioned",
        tokenAccountId: newAccount.id,
        errorMessage: undefined,
      });
    }
    return (
      (await transitionQuotaOperation(current.id, "completed", {
        nextRetryAt: undefined,
      })) ?? current
    );
  }

  const prepared = await prepareDirectNewApiControl(current, oldAccount);
  if (!prepared.ready) return prepared.operation;
  current = prepared.operation;
  if (current.targetRemainQuota === undefined) {
    const observedRemainBefore = await stableRemainQuota(oldAccount.newapiTokenId);
    current = await freezeSnapshot(current, {
      observedRemainBefore,
      targetRemainQuota: observedRemainBefore,
      upstreamTokenIdBefore: oldAccount.newapiTokenId,
      tokenAccountIdBefore: oldAccount.id,
      evidence: {
        ...current.evidence,
        quotaAuthority: "newapi_token",
        rotationPreservesObservedBalance: true,
      },
    });
  } else if (
    current.state === "upstream_frozen" ||
    current.state === "draining" ||
    current.state === "admission_closed"
  ) {
    current = await freezeSnapshot(current, {});
  }
  if (current.state === "snapshot_stable") {
    current =
      (await transitionQuotaOperation(current.id, "upstream_applying")) ?? current;
  }

  const tokenName = `TI rotation ${current.id}`.slice(0, 50);
  let upstreamTokenIdAfter = current.upstreamTokenIdAfter;
  let key: string | undefined;
  if (!upstreamTokenIdAfter) {
    const existing = await findNewApiTokenByName(tokenName);
    if (existing?.id !== undefined) {
      upstreamTokenIdAfter = String(existing.id);
      key = await getNewApiTokenKey(upstreamTokenIdAfter);
    } else {
      const created = await createNewApiToken({ name: tokenName, remainQuota: 0 });
      upstreamTokenIdAfter = created.newapiTokenId;
      key = created.key;
    }
    await disableNewApiTokenAndVerify(upstreamTokenIdAfter);
  }
  if (!key && current.credentialCiphertext) {
    key = openQuotaCredential(current.credentialCiphertext, current.id);
  }
  if (!key) key = await getNewApiTokenKey(upstreamTokenIdAfter);
  if (!key) throw new Error("NewAPI 未返回可恢复的新 Key 明文");

  const accounts = await listTokenAccountsForUser(current.feishuUserId);
  let newAccount = current.tokenAccountIdAfter
    ? accounts.find((item) => item.id === current.tokenAccountIdAfter)
    : accounts.find((item) => item.newapiTokenId === upstreamTokenIdAfter);
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
    throw new Error("Key 更换缺少冻结的 NewAPI 余额");
  }
  if (current.state !== "upstream_applied" && current.state !== "upstream_activated") {
    await updateNewApiTokenQuota({
      newapiTokenId: upstreamTokenIdAfter,
      remainQuota: targetRemainQuota,
    });
    const observed = await getNewApiTokenRemainQuota(upstreamTokenIdAfter);
    if (observed !== targetRemainQuota) throw new Error("新 Key 余额写后校验失败");
    current =
      (await transitionQuotaOperation(current.id, "upstream_applied", {
        observedRemainAfter: observed,
      })) ?? current;
  }
  await disableNewApiTokenAndVerify(oldAccount.newapiTokenId);
  if (current.state === "upstream_applied") {
    await enableNewApiTokenAndVerify(upstreamTokenIdAfter);
    current =
      (await transitionQuotaOperation(current.id, "upstream_activated")) ?? current;
  }
  const finalized = await finalizeTokenRotationForQuotaOperation({
    feishuUserId: current.feishuUserId,
    oldTokenAccountId: oldAccount.id,
    newTokenAccountId: newAccount.id,
    operationGeneration: current.operationGeneration,
    operationId: current.id,
  });
  if (current.state === "upstream_activated") {
    current =
      (await transitionQuotaOperation(current.id, "local_finalized")) ?? current;
  }
  if (current.state === "local_finalized") {
    current = (await transitionQuotaOperation(current.id, "reconciling")) ?? current;
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
      nextRetryAt: undefined,
      evidence: {
        ...current.evidence,
        reportingSource: "newapi",
      },
    })) ?? current
  );
}

async function handleMonthlyOpen(operation: QuotaOperation) {
  const assignedMonthlyQuota = operation.requestedAssignedQuota;
  if (assignedMonthlyQuota === undefined) throw new Error("套餐重置缺少用户额度上限");
  let current = operation;
  const activeAccount = await getActiveTokenForUser(current.feishuUserId);
  const account =
    activeAccount ??
    (current.tokenAccountIdBefore
      ? (await listTokenAccountsForUser(current.feishuUserId)).find(
          (item) => item.id === current.tokenAccountIdBefore,
        ) ?? null
      : null);
  if (!account?.newapiTokenId) {
    throw new Error("套餐重置目标用户没有 active NewAPI Key");
  }
  assertFrozenOperationAccountBinding(operation, account);
  if (current.state === "local_finalized" || current.state === "reconciling") {
    return finalizeDirectControl(current, account, {
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
      (await reserveQuotaOperationDepartmentBudget(
        current.id,
        assignedMonthlyQuota,
      )) ?? current;
  }
  current =
    (await updateQuotaOperation(current.id, {
      upstreamTokenIdBefore: account.newapiTokenId,
      tokenAccountIdBefore: account.id,
    })) ?? current;
  const prepared = await prepareDirectNewApiControl(current, account);
  if (!prepared.ready) return prepared.operation;
  current = prepared.operation;
  if (current.targetRemainQuota === undefined) {
    const authoritative = await getNewApiUserAuthoritativeQuotaSnapshot(
      current.feishuUserId,
    );
    if (authoritative.truncated) {
      throw new Error("NewAPI 当前套餐周期日志达到查询上限，拒绝执行不完整重置");
    }
    if (authoritative.period !== current.billingPeriod) {
      throw new Error(
        `套餐重置周期已变化：操作 ${current.billingPeriod}，NewAPI 视图 ${authoritative.period}`,
      );
    }
    const observedRemainBefore = await stableRemainQuota(account.newapiTokenId);
    const targetRemainQuota = Math.max(
      assignedMonthlyQuota - authoritative.consumedQuota,
      0,
    );
    current = await freezeSnapshot(current, {
      observedRemainBefore,
      targetRemainQuota,
      upstreamTokenIdBefore: account.newapiTokenId,
      tokenAccountIdBefore: account.id,
      evidence: {
        ...current.evidence,
        quotaAuthority: "newapi_log",
        consumedInPackagePeriod: authoritative.consumedQuota,
        authoritativeRequestCount: authoritative.requestCount,
        authoritativeWindowStartAt: authoritative.windowStartAt,
      },
    });
  } else if (
    current.state === "upstream_frozen" ||
    current.state === "draining" ||
    current.state === "admission_closed"
  ) {
    current = await freezeSnapshot(current, {});
  }
  if (current.state !== "upstream_applied" && current.state !== "upstream_activated") {
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
  if (current.state === "upstream_applied") {
    await enableNewApiTokenAndVerify(account.newapiTokenId);
    current =
      (await transitionQuotaOperation(current.id, "upstream_activated")) ?? current;
  }
  return finalizeDirectControl(current, account, {
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
              observationRetryFromState: quotaOperationRetryResumeState(
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
