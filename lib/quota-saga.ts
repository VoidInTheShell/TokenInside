import { getConfig } from "@/lib/config";
import { nowIso, randomId, sha256Hex } from "@/lib/crypto";
import {
  createNewApiToken,
  disableNewApiToken,
  enableNewApiToken,
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
  calculateQuotaRestore,
  hongKongBillingPeriod,
} from "@/lib/quota-model";
import {
  assertQuotaWriteActionEnabled,
  getQuotaFeatureFlags,
} from "@/lib/quota-guard";
import { openQuotaCredential, sealQuotaCredential } from "@/lib/secret-box";
import {
  addTokenAccount,
  appendQuotaLedgerEntry,
  claimQuotaOperationExecution,
  createQuotaOperation,
  createMonthlyOpenQuotaOperations,
  createUserQuotaPolicyVersion,
  finalizeTokenRotation,
  findQuotaOperationById,
  finalizeTokenProvision,
  getActiveTokenForUser,
  getEffectiveUserQuotaPolicy,
  getStoreSnapshot,
  getUserBillingPeriod,
  getUserQuotaState,
  listInflightProxyRequests,
  listQuotaOperations,
  rebuildQuotaMaterializedSnapshots,
  releaseQuotaOperationExecution,
  renewQuotaOperationExecution,
  reserveQuotaOperationDepartmentBudget,
  saveUserQuotaState,
  transitionQuotaOperation,
  updateQuotaOperation,
  updateTokenAccount,
  updateTokenRequest,
  withUserQuotaOperationLock,
} from "@/lib/store";
import { quotaOperationRetryResumeState } from "@/lib/quota-saga-state";
import type {
  QuotaOperation,
  TokenAccount,
  TokenRequest,
} from "@/lib/types";

const maxAttempts = 5;
const retryDelayMs = 2_000;
let workerStarted = false;
let workerTimer: ReturnType<typeof setTimeout> | undefined;

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
  if (policy) return policy.assignedMonthlyQuota;
  const billing = await getUserBillingPeriod(feishuUserId, period);
  return toNewApiQuota(billing?.monthlyQuota ?? 0);
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

async function prepareAndDrain(
  operation: QuotaOperation,
  drainingAccount?: TokenAccount | null,
) {
  return withUserQuotaOperationLock(operation.feishuUserId, async () => {
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
    if (state.admission === "closed" && state.operationId !== current.id) {
      throw new Error(`用户准入已被其他操作关闭: ${state.operationId ?? "unknown"}`);
    }
    if (state.admission !== "closed") {
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
      await updateTokenAccount(
        drainingAccount.id,
        { status: "draining", drainStartedAt: nowIso() },
        ["active"],
      );
    }
    const inflight = await listInflightProxyRequests(
      current.feishuUserId,
      state.activeGeneration,
    );
    if (inflight.length > 0) {
      if (current.state === "admission_closed") {
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
    return { ready: true as const, operation: current };
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
    current.state === "upstream_applied" ||
    current.state === "upstream_activated" ||
    current.state === "local_finalized" ||
    current.state === "reconciling"
  ) {
    const observed = await getNewApiTokenRemainQuota(upstreamTokenId);
    if (observed !== targetRemainQuota) {
      throw new Error("已写入额度操作的上游状态发生漂移");
    }
    return current;
  }
  if (current.state === "snapshot_stable") {
    current =
      (await transitionQuotaOperation(current.id, "upstream_applying")) ?? current;
  }
  if (current.state !== "upstream_applying") {
    throw new Error(`额度写入状态无效: ${current.state}`);
  }
  const observedBeforeRetry = await getNewApiTokenRemainQuota(upstreamTokenId);
  if (observedBeforeRetry === targetRemainQuota) {
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
  if (account) {
    await updateTokenAccount(account.id, {
      ...accountPatch,
      operationGeneration: current.operationGeneration,
    });
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
  await rebuildQuotaMaterializedSnapshots(current.billingPeriod);
  if (current.requestId) {
    await updateTokenRequest(current.requestId, {
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
  const account = await getActiveTokenForUser(operation.feishuUserId);
  const assignedQuotaBefore =
    operation.assignedQuotaBefore ??
    (await assignedQuotaForUser(operation.feishuUserId, operation.billingPeriod));
  const assignedQuotaAfter = operation.requestedAssignedQuota;
  if (assignedQuotaAfter === undefined) throw new Error("调额操作缺少目标授权额度");

  let current = operation;
  if (current.state === "local_finalized" || current.state === "reconciling") {
    return finalizeCommon(current, account);
  }
  if (current.targetRemainQuota === undefined) {
    const observedRemainBefore = account?.newapiTokenId
      ? await stableRemainQuota(account.newapiTokenId)
      : 0;
    const calculation = calculateQuotaAdjustment({
      observedRemainBefore,
      assignedQuotaBefore,
      assignedQuotaAfter,
    });
    if (calculation.deltaAuthorizedQuota > 0) {
      current =
        (await reserveQuotaOperationDepartmentBudget(
          current.id,
          calculation.deltaAuthorizedQuota,
        )) ?? current;
    }
    current =
      (await updateQuotaOperation(current.id, {
        assignedQuotaBefore,
        observedRemainBefore,
        targetRemainQuota: calculation.targetRemainQuota,
        upstreamTokenIdBefore: account?.newapiTokenId,
        tokenAccountIdBefore: account?.id,
      })) ?? current;
  }

  const prepared = await prepareAndDrain(current);
  if (!prepared.ready) return prepared.operation;
  current = prepared.operation;
  const upstreamWriteStarted =
    current.state === "upstream_applying" ||
    current.state === "upstream_applied" ||
    current.state === "upstream_activated";
  if (account?.newapiTokenId && !upstreamWriteStarted) {
    const stable = await stableRemainQuota(account.newapiTokenId);
    if (stable !== current.observedRemainBefore) {
      throw new Error("关闭准入后上游余额已变化，需要新建操作版本");
    }
  }
  current = await freezeSnapshot(current, {});
  if (
    account &&
    current.targetRemainQuota !== current.observedRemainBefore
  ) {
    current = await applyAndVerifyBalance(current);
  }
  const delta = (current.targetRemainQuota ?? 0) - (current.observedRemainBefore ?? 0);
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
  return finalizeCommon(current, account);
}

async function handleQuotaRestore(operation: QuotaOperation) {
  const account = await getActiveTokenForUser(operation.feishuUserId);
  if (!account?.newapiTokenId) throw new Error("当前用户没有 active NewAPI key");
  const assignedMonthlyQuota = await assignedQuotaForUser(
    operation.feishuUserId,
    operation.billingPeriod,
  );
  let current = operation;
  if (current.state === "local_finalized" || current.state === "reconciling") {
    return finalizeCommon(current, account);
  }
  if (current.targetRemainQuota === undefined) {
    const observedRemainBefore = await stableRemainQuota(account.newapiTokenId);
    const calculation = calculateQuotaRestore({
      observedRemainBefore,
      assignedMonthlyQuota,
    });
    if (calculation.grantDelta > 0) {
      current =
        (await reserveQuotaOperationDepartmentBudget(current.id, calculation.grantDelta)) ??
        current;
    }
    current =
      (await updateQuotaOperation(current.id, {
        assignedQuotaBefore: assignedMonthlyQuota,
        observedRemainBefore,
        targetRemainQuota: calculation.targetRemainQuota,
        upstreamTokenIdBefore: account.newapiTokenId,
        tokenAccountIdBefore: account.id,
      })) ?? current;
  }
  const prepared = await prepareAndDrain(current);
  if (!prepared.ready) return prepared.operation;
  current = prepared.operation;
  const upstreamWriteStarted =
    current.state === "upstream_applying" ||
    current.state === "upstream_applied" ||
    current.state === "upstream_activated";
  if (
    !upstreamWriteStarted &&
    (await stableRemainQuota(account.newapiTokenId)) !== current.observedRemainBefore
  ) {
    throw new Error("关闭准入后上游余额已变化，需要新建操作版本");
  }
  current = await freezeSnapshot(current, {});
  const grantDelta =
    (current.targetRemainQuota ?? current.observedRemainBefore ?? 0) -
    (current.observedRemainBefore ?? 0);
  if (grantDelta > 0) {
    current = await applyAndVerifyBalance(current);
  }
  if (grantDelta > 0) {
    await appendQuotaLedgerEntry({
      operationId: current.id,
      feishuUserId: current.feishuUserId,
      departmentId: current.departmentId,
      period: current.billingPeriod,
      signedQuota: grantDelta,
      entryType: "quota_restore_grant",
      sourceType: "quota_operation",
      sourceId: current.id,
    });
  }
  return finalizeCommon(current, account);
}

async function firstProvisionAccount(operation: QuotaOperation) {
  if (!operation.tokenAccountIdAfter) return null;
  const store = await getStoreSnapshot();
  return store.tokenAccounts.find((item) => item.id === operation.tokenAccountIdAfter) ?? null;
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
  await rebuildQuotaMaterializedSnapshots(current.billingPeriod);
  if (current.requestId) {
    await updateTokenRequest(current.requestId, {
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
    await rebuildQuotaMaterializedSnapshots(current.billingPeriod);
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
  if (current.reservedDepartmentQuota !== authorizationDelta && authorizationDelta > 0) {
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
  await disableNewApiToken(upstreamTokenIdAfter);
  if (!key) key = await getNewApiTokenKey(upstreamTokenIdAfter);
  if (!key) throw new Error("NewAPI 未返回首次发放 Key 明文");

  let account = await firstProvisionAccount(current);
  if (!account) {
    const store = await getStoreSnapshot();
    account =
      store.tokenAccounts.find(
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
  await enableNewApiToken(upstreamTokenIdAfter);
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
  if (!operation.tokenAccountIdBefore) return getActiveTokenForUser(operation.feishuUserId);
  const store = await getStoreSnapshot();
  return store.tokenAccounts.find((item) => item.id === operation.tokenAccountIdBefore) ?? null;
}

async function handleKeyRotation(operation: QuotaOperation) {
  let current = operation;
  let oldAccount = await accountBeforeRotation(current);
  if (!oldAccount?.newapiTokenId) throw new Error("当前用户没有可轮换的 active NewAPI key");
  if (
    current.state === "upstream_activated" ||
    current.state === "local_finalized" ||
    current.state === "reconciling"
  ) {
    const store = await getStoreSnapshot();
    const newAccount = current.tokenAccountIdAfter
      ? store.tokenAccounts.find((item) => item.id === current.tokenAccountIdAfter)
      : undefined;
    if (!newAccount) throw new Error("Key 轮换恢复时找不到新 TokenAccount");
    if (current.state === "upstream_activated") {
      await finalizeTokenRotation({
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
    await rebuildQuotaMaterializedSnapshots(current.billingPeriod);
    if (current.requestId) {
      await updateTokenRequest(current.requestId, {
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
  if (current.observedRemainBefore === undefined) {
    const observedRemainBefore = await stableRemainQuota(oldAccount.newapiTokenId);
    current =
      (await updateQuotaOperation(current.id, {
        observedRemainBefore,
        upstreamTokenIdBefore: oldAccount.newapiTokenId,
        tokenAccountIdBefore: oldAccount.id,
      })) ?? current;
  }
  const prepared = await prepareAndDrain(current, oldAccount);
  if (!prepared.ready) return prepared.operation;
  current = prepared.operation;
  oldAccount = await accountBeforeRotation(current);
  if (!oldAccount?.newapiTokenId) throw new Error("轮换前旧 Key 记录丢失");
  const stable = await stableRemainQuota(oldAccount.newapiTokenId);
  if (stable !== current.observedRemainBefore) {
    throw new Error("旧 Key 排空后余额变化，需要新建操作版本");
  }
  if (current.targetRemainQuota === undefined) {
    await rebuildQuotaMaterializedSnapshots(current.billingPeriod);
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
      observedRemainQuota: stable,
    });
    current = await freezeSnapshot(current, {
      targetRemainQuota: rotationTarget.targetRemainQuota,
      evidence: {
        ...current.evidence,
        expectedAvailableQuota: rotationTarget.expectedAvailableQuota,
        authoritativeConsumedQuota: billingPeriod.authoritativeConsumedQuota,
        authorizedQuota: billingPeriod.authorizedQuota,
        observedRemainQuota: rotationTarget.observedRemainQuota,
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
    await disableNewApiToken(upstreamTokenIdAfter);
  }
  if (!key) key = await getNewApiTokenKey(upstreamTokenIdAfter);
  if (!key) throw new Error("NewAPI 未返回可恢复的新 Key 明文");

  const store = await getStoreSnapshot();
  let newAccount = current.tokenAccountIdAfter
    ? store.tokenAccounts.find((item) => item.id === current.tokenAccountIdAfter)
    : store.tokenAccounts.find(
        (item) =>
          item.feishuUserId === current.feishuUserId &&
          item.newapiTokenId === upstreamTokenIdAfter,
      );
  if (!newAccount) {
    newAccount = await addTokenAccount({
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

  await disableNewApiToken(oldAccount.newapiTokenId);
  await enableNewApiToken(upstreamTokenIdAfter);
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
  const finalized = await finalizeTokenRotation({
    feishuUserId: current.feishuUserId,
    oldTokenAccountId: oldAccount.id,
    newTokenAccountId: newAccount.id,
    operationGeneration: current.operationGeneration,
    operationId: current.id,
  });
  current =
    (await transitionQuotaOperation(current.id, "local_finalized")) ?? current;
  current = (await transitionQuotaOperation(current.id, "reconciling")) ?? current;
  await rebuildQuotaMaterializedSnapshots(current.billingPeriod);
  if (current.requestId) {
    await updateTokenRequest(current.requestId, {
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
  const existingAccount = await getActiveTokenForUser(current.feishuUserId);
  if (current.state === "local_finalized" || current.state === "reconciling") {
    return finalizeCommon(current, existingAccount, { billingPeriod: current.billingPeriod });
  }
  if (current.reservedDepartmentQuota !== assignedMonthlyQuota) {
    current =
      (await reserveQuotaOperationDepartmentBudget(current.id, assignedMonthlyQuota)) ?? current;
  }
  const account = existingAccount;
  const prepared = await prepareAndDrain(current);
  if (!prepared.ready) return prepared.operation;
  current = prepared.operation;
  await rebuildQuotaMaterializedSnapshots(current.billingPeriod);
  const newPeriod = await getUserBillingPeriod(
    current.feishuUserId,
    current.billingPeriod,
  );
  const consumedInNewPeriod = Math.max(
    newPeriod?.authoritativeConsumedQuota ?? 0,
    0,
  );
  const targetRemainQuota = Math.max(assignedMonthlyQuota - consumedInNewPeriod, 0);
  const upstreamWriteStarted =
    current.state === "upstream_applying" ||
    current.state === "upstream_applied" ||
    current.state === "upstream_activated";
  let observedRemainBefore = current.observedRemainBefore ?? 0;
  if (account?.newapiTokenId && !upstreamWriteStarted) {
    const stable = await stableRemainQuota(account.newapiTokenId);
    if (
      current.observedRemainBefore !== undefined &&
      stable !== current.observedRemainBefore
    ) {
      throw new Error("月度开账排空后上游余额已变化，需要人工复核");
    }
    observedRemainBefore = stable;
  }
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
  return finalizeCommon(current, account, { billingPeriod: current.billingPeriod });
}

async function handleReconciliation(operation: QuotaOperation) {
  const account = await getActiveTokenForUser(operation.feishuUserId);
  if (!account?.newapiTokenId || operation.targetRemainQuota === undefined) {
    throw new Error("对账操作缺少 active Key 或目标余额");
  }
  const targetRemainQuota = operation.targetRemainQuota;
  if (operation.state === "local_finalized" || operation.state === "reconciling") {
    return finalizeCommon(operation, account);
  }
  const prepared = await prepareAndDrain(operation);
  if (!prepared.ready) return prepared.operation;
  let current = prepared.operation;
  const observed = await stableRemainQuota(account.newapiTokenId);
  current = await freezeSnapshot(current, {
    observedRemainBefore: observed,
    upstreamTokenIdBefore: account.newapiTokenId,
    tokenAccountIdBefore: account.id,
  });
  if (observed < targetRemainQuota) {
    await reopenAdmission(current);
    return (
      (await transitionQuotaOperation(current.id, "manual_review", {
        lastErrorCode: "deficit_upstream",
        lastErrorMessage: "未知负向漂移禁止自动向上补额",
      })) ?? current
    );
  }
  const flags = await getQuotaFeatureFlags();
  if (observed > targetRemainQuota && !flags.reconciliationAutoDecreaseEnabled) {
    await reopenAdmission(current);
    return (
      (await transitionQuotaOperation(current.id, "manual_review", {
        lastErrorCode: "auto_decrease_disabled",
        lastErrorMessage: "自动向下校准尚未启用",
      })) ?? current
    );
  }
  if (observed !== targetRemainQuota) current = await applyAndVerifyBalance(current);
  return finalizeCommon(current, account);
}

async function markOperationFailure(operationId: string, error: unknown) {
  const current = await findQuotaOperationById(operationId);
  if (!current || current.state === "completed" || current.state === "compensated") return current;
  const message = error instanceof Error ? error.message : "quota operation failed";
  const uncertain = current.attemptCount >= maxAttempts;
  const nextState = uncertain ? "manual_review" : "retryable_failed";
  const updated = await transitionQuotaOperation(current.id, nextState, {
    lastErrorCode: uncertain ? "upstream_state_uncertain" : "retryable_failure",
    lastErrorMessage: message,
    nextRetryAt: uncertain ? undefined : addMilliseconds(nowIso(), retryDelayMs),
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
    await updateTokenRequest(current.requestId, {
      status: "approved_provision_failed",
      errorMessage: message,
    }).catch(() => undefined);
  }
  return updated;
}

export async function runQuotaOperation(operationId: string) {
  const leaseId = randomId("qow");
  const leaseMilliseconds = 2 * 60_000;
  const claimed = await claimQuotaOperationExecution({
    operationId,
    leaseId,
    leaseExpiresAt: addMilliseconds(nowIso(), leaseMilliseconds),
  });
  if (!claimed) throw new Error("额度操作正在由其他 worker 执行");
  const leaseTimer = setInterval(() => {
    void renewQuotaOperationExecution({
      operationId,
      leaseId,
      leaseExpiresAt: addMilliseconds(nowIso(), leaseMilliseconds),
    }).catch(() => undefined);
  }, 30_000);
  leaseTimer.unref?.();
  let operation = claimed;
  try {
    operation = (await findQuotaOperationById(operationId)) ?? claimed;
    if (operation.state === "completed" || operation.state === "compensated") {
      return operation;
    }
    if (operation.state === "manual_review") return operation;
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
    operation =
      (await updateQuotaOperation(
        operation.id,
        { attemptCount: operation.attemptCount + 1 },
        [operation.state],
      )) ?? operation;
    if (operation.operationType === "first_provision") return await handleFirstProvision(operation);
    if (operation.operationType === "quota_adjust") return await handleQuotaAdjustment(operation);
    if (operation.operationType === "quota_restore") return await handleQuotaRestore(operation);
    if (operation.operationType === "key_rotation") return await handleKeyRotation(operation);
    if (operation.operationType === "monthly_open") return await handleMonthlyOpen(operation);
    if (operation.operationType === "reconcile") return await handleReconciliation(operation);
    throw new Error(`不支持的额度操作类型: ${operation.operationType}`);
  } catch (error) {
    await markOperationFailure(operation.id, error);
    throw error;
  } finally {
    clearInterval(leaseTimer);
    await releaseQuotaOperationExecution({ operationId, leaseId }).catch(() => undefined);
  }
}

export async function runDueQuotaOperations(limit = 20) {
  const now = nowIso();
  const operations = (await listQuotaOperations({ limit: 200 }))
    .filter(
      (item) =>
        item.state !== "completed" &&
        item.state !== "compensated" &&
        item.state !== "manual_review" &&
        (!item.nextRetryAt || item.nextRetryAt <= now),
    )
    .slice(0, limit);
  const results = [];
  for (const operation of operations) {
    try {
      results.push({ operationId: operation.id, result: await runQuotaOperation(operation.id) });
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
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = setTimeout(async () => {
    try {
      const flags = await getQuotaFeatureFlags();
      if (flags.quotaSagaWritesEnabled) await runDueQuotaOperations();
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
  workerTimer.unref?.();
}

export function ensureQuotaOperationWorker() {
  if (workerStarted) return;
  workerStarted = true;
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
  const operation = await createQuotaOperation({
    operationType: "first_provision",
    idempotencyKey: `quota-operation:${input.requestId}`,
    feishuUserId: input.feishuUserId,
    departmentId: input.departmentId,
    billingPeriod: hongKongBillingPeriod(),
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
  const operation = await createQuotaOperation({
    operationType: "quota_adjust",
    idempotencyKey: `quota-adjust:${input.clientRequestId}`,
    feishuUserId: input.feishuUserId,
    departmentId: input.departmentId,
    billingPeriod: hongKongBillingPeriod(),
    requestedAssignedQuota: toNewApiQuota(input.approvedMonthlyQuota),
    requestId: input.requestId,
    createdByOpenId: input.createdByOpenId,
  });
  ensureQuotaOperationWorker();
  return operation;
}

export async function enqueueQuotaRestoreForRequest(request: TokenRequest) {
  await assertQuotaWriteActionEnabled("quota_restore");
  const store = await getStoreSnapshot();
  const user = store.users.find((item) => item.id === request.feishuUserId);
  const operation = await createQuotaOperation({
    operationType: "quota_restore",
    idempotencyKey: `quota-operation:${request.id}`,
    feishuUserId: request.feishuUserId,
    departmentId: user?.departmentId,
    billingPeriod: hongKongBillingPeriod(),
    requestId: request.id,
    createdByOpenId: request.approvalOperatorOpenId,
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
  const operation = await createQuotaOperation({
    operationType: "key_rotation",
    idempotencyKey: `key-reset:${input.clientRequestId}`,
    feishuUserId: input.feishuUserId,
    departmentId: input.departmentId,
    billingPeriod: hongKongBillingPeriod(),
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
    departmentId: string;
    period: string;
    assignedMonthlyQuota: number;
    createdByOpenId?: string;
  }>,
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
  );
  ensureQuotaOperationWorker();
  return operations;
}

export async function enqueueQuotaReconciliation(input: {
  feishuUserId: string;
  departmentId?: string;
  tokenAccountId: string;
  expectedAvailableQuota: number;
  observedVersion: string;
  createdByOpenId?: string;
}) {
  await assertQuotaWriteActionEnabled("reconcile");
  const operation = await createQuotaOperation({
    operationType: "reconcile",
    idempotencyKey: `reconcile:${input.tokenAccountId}:${input.observedVersion}:${input.expectedAvailableQuota}`,
    feishuUserId: input.feishuUserId,
    departmentId: input.departmentId,
    billingPeriod: hongKongBillingPeriod(),
    targetRemainQuota: input.expectedAvailableQuota,
    tokenAccountIdBefore: input.tokenAccountId,
    createdByOpenId: input.createdByOpenId,
  });
  ensureQuotaOperationWorker();
  return operation;
}

export async function takeQuotaOperationCredential(
  operationId: string,
  feishuUserId: string,
) {
  return withUserQuotaOperationLock(feishuUserId, async () => {
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
    await updateQuotaOperation(operation.id, {
      credentialCiphertext: undefined,
      credentialDeliveredAt: nowIso(),
    });
    return key;
  });
}
