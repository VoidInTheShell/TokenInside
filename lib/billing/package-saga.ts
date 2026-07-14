import { sha256Hex } from "../crypto.ts";
import {
  clearClaimedPrewarmedCredential,
  claimPrewarmedTokenForProvision,
} from "../key-prewarm.ts";
import {
  createNewApiToken,
  disableNewApiToken,
  enableNewApiToken,
  getNewApiTokenKey,
  getNewApiTokenRemainQuota,
  updateNewApiTokenQuota,
} from "../newapi.ts";
import {
  createPackageKeyRotationOperation,
  getUserPackageBalance,
  getPackageProvisioningContext,
  updatePackageBillingOperation,
  updatePackageProvisioningState,
} from "./package-repository.ts";
import {
  addTokenAccount,
  finalizeTokenRotation,
  getActiveTokenForUser,
  getStoreSnapshot,
  listInflightProxyRequests,
  updateTokenAccount,
  withUserKeyLifecycleLock,
} from "../store.ts";

export async function provisionApprovedPackageRequest(requestId: string) {
  let context = await getPackageProvisioningContext(requestId);
  if (context.request.status === "provisioned") return context;
  if (!context.grant || !context.operation) {
    throw new Error("套餐申请尚未完成 grant/operation 准备");
  }
  await updatePackageProvisioningState({
    requestId,
    state: "upstream_applying",
    currentStep: "apply_newapi_watermark",
  });
  try {
    let account = await getActiveTokenForUser(context.request.userId);
    if (account?.newapiTokenId) {
      await updateNewApiTokenQuota({
        newapiTokenId: account.newapiTokenId,
        remainQuota: context.availableQuota,
      });
    } else {
      const pending = (await getStoreSnapshot()).tokenAccounts.find(
        (item) =>
          item.feishuUserId === context.request.userId &&
          item.sourceRequestId === context.request.id &&
          item.status === "pending_activation" &&
          Boolean(item.newapiTokenId),
      );
      let key: string | undefined;
      if (pending?.newapiTokenId) {
        account = pending;
        key = await getNewApiTokenKey(pending.newapiTokenId);
      } else {
        const prewarmed = await claimPrewarmedTokenForProvision({
          feishuUserId: context.request.userId,
          sourceRequestId: context.request.id,
          billingPeriod: context.grant.startsAt.slice(0, 7),
          operationGeneration: 0,
        });
        if (prewarmed) {
          account = prewarmed.account;
          key = prewarmed.key;
        } else {
          const created = await createNewApiToken({
            name: `TI package ${context.request.id.slice(0, 18)} ${context.request.userId.slice(0, 10)}`,
            remainQuota: 0,
          });
          if (!created.key) {
            throw new Error("NewAPI 创建套餐 Key 后未返回可绑定凭据");
          }
          await disableNewApiToken(created.newapiTokenId);
          account = await addTokenAccount({
            feishuUserId: context.request.userId,
            sourceRequestId: context.request.id,
            newapiTokenId: created.newapiTokenId,
            keyHash: sha256Hex(created.key),
            status: "pending_activation",
            billingPeriod: context.grant.startsAt.slice(0, 7),
            operationGeneration: 0,
          });
          key = created.key;
        }
      }
      if (!account?.newapiTokenId || !key) {
        throw new Error("套餐发放未取得可激活的 NewAPI Key");
      }
      await updateNewApiTokenQuota({
        newapiTokenId: account.newapiTokenId,
        remainQuota: context.availableQuota,
      });
      await enableNewApiToken(account.newapiTokenId);
      const activatedAccount = await updateTokenAccount(account.id, {
        status: "active",
        activatedAt: new Date().toISOString(),
        operationGeneration: account.operationGeneration ?? 0,
      });
      if (!activatedAccount) throw new Error("套餐发放激活后本地 Key 状态更新失败");
      account = activatedAccount;
      await clearClaimedPrewarmedCredential(account.id).catch(() => undefined);
    }
    await updatePackageProvisioningState({
      requestId,
      state: "upstream_applied",
      currentStep: "newapi_watermark_verified",
      tokenAccountId: account.id,
    });
    await updatePackageProvisioningState({
      requestId,
      state: "completed",
      currentStep: "completed",
      tokenAccountId: account.id,
    });
    context = await getPackageProvisioningContext(requestId);
    return context;
  } catch (error) {
    const message = error instanceof Error ? error.message : "套餐发放 NewAPI 水位更新失败";
    await updatePackageProvisioningState({
      requestId,
      state: "retryable_failed",
      currentStep: "apply_newapi_watermark",
      errorCode: "newapi_watermark_apply_failed",
      errorMessage: message,
    }).catch(() => undefined);
    throw error;
  }
}

export async function reconcilePackageWatermark(userId: string) {
  const [balance, account] = await Promise.all([
    getUserPackageBalance(userId),
    getActiveTokenForUser(userId),
  ]);
  if (!account?.newapiTokenId) {
    return { status: "no_active_key" as const, expected: balance.availableQuota };
  }
  const observed = await getNewApiTokenRemainQuota(account.newapiTokenId);
  if (observed === undefined) {
    throw new Error("NewAPI active Key 当前 remain_quota 不可用");
  }
  if (observed > balance.availableQuota) {
    await updateNewApiTokenQuota({
      newapiTokenId: account.newapiTokenId,
      remainQuota: balance.availableQuota,
    });
    return {
      status: "decreased" as const,
      expected: balance.availableQuota,
      observedBefore: observed,
    };
  }
  if (observed < balance.availableQuota) {
    return {
      status: "deficit_manual_review" as const,
      expected: balance.availableQuota,
      observedBefore: observed,
    };
  }
  return { status: "healthy" as const, expected: balance.availableQuota, observedBefore: observed };
}

async function waitForPackageRotationDrain(input: {
  userId: string;
  generation: number;
  timeoutMs?: number;
}) {
  const timeoutAt = Date.now() + (input.timeoutMs ?? 15_000);
  while (Date.now() < timeoutAt) {
    const inflight = await listInflightProxyRequests(input.userId, input.generation);
    if (inflight.length === 0) return { drained: true as const, inflight: 0 };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const inflight = await listInflightProxyRequests(input.userId, input.generation);
  return { drained: inflight.length === 0, inflight: inflight.length };
}

export async function rotatePackageKey(input: {
  userId: string;
  departmentId: string;
  clientRequestId: string;
  reason: string;
}) {
  return withUserKeyLifecycleLock(input.userId, async () => {
    const [oldAccount, initialBalance] = await Promise.all([
      getActiveTokenForUser(input.userId),
      getUserPackageBalance(input.userId),
    ]);
    if (!oldAccount?.newapiTokenId) {
      throw new Error("当前飞书用户没有可更换的 active NewAPI Key");
    }
    if (initialBalance.availableQuota <= 0) {
      throw new Error("当前用户没有可用于 Key 更换的套餐余额");
    }
    const oldGeneration = oldAccount.operationGeneration ?? 0;
    const prepared = await createPackageKeyRotationOperation({
      ...input,
      oldTokenAccountId: oldAccount.id,
      oldGeneration,
      targetAvailableQuota: initialBalance.availableQuota,
    });
    if (prepared.operation.state === "completed") {
      return { operation: prepared.operation, key: undefined, reused: true as const };
    }
    if (
      prepared.reused &&
      prepared.operation.data.oldTokenAccountId !== oldAccount.id
    ) {
      throw new Error("Key 更换幂等请求对应的 active generation 已发生变化");
    }

    let newAccountId: string | undefined;
    let newApiTokenId: string | undefined;
    let oldDisabled = false;
    try {
      const created = await createNewApiToken({
        name: `TI package rotation ${prepared.operation.id.slice(0, 18)} ${input.userId.slice(0, 10)}`,
        remainQuota: 0,
      });
      if (!created.key) throw new Error("NewAPI 创建替换 Key 后未返回凭据");
      newApiTokenId = created.newapiTokenId;
      await disableNewApiToken(created.newapiTokenId);
      const newAccount = await addTokenAccount({
        feishuUserId: input.userId,
        sourceRequestId: prepared.operation.id,
        newapiTokenId: created.newapiTokenId,
        keyHash: sha256Hex(created.key),
        status: "pending_activation",
        billingPeriod: oldAccount.billingPeriod,
        operationGeneration: oldGeneration + 1,
      });
      newAccountId = newAccount.id;
      await updatePackageBillingOperation({
        operationId: prepared.operation.id,
        userId: input.userId,
        state: "upstream_applying",
        currentStep: "replacement_key_created_disabled",
        data: {
          newTokenAccountId: newAccount.id,
          newapiTokenId: created.newapiTokenId,
          newGeneration: oldGeneration + 1,
        },
      });

      const drain = await waitForPackageRotationDrain({
        userId: input.userId,
        generation: oldGeneration,
      });
      if (!drain.drained) {
        throw new Error(`旧 generation 仍有 ${drain.inflight} 个在途请求，Key 更换暂缓`);
      }
      const stableBalance = await getUserPackageBalance(input.userId);
      await updateNewApiTokenQuota({
        newapiTokenId: created.newapiTokenId,
        remainQuota: stableBalance.availableQuota,
      });
      const verified = await getNewApiTokenRemainQuota(created.newapiTokenId);
      if (verified !== stableBalance.availableQuota) {
        throw new Error("替换 Key 的 NewAPI 水位核对失败");
      }
      await disableNewApiToken(oldAccount.newapiTokenId);
      oldDisabled = true;
      await enableNewApiToken(created.newapiTokenId);
      await finalizeTokenRotation({
        feishuUserId: input.userId,
        oldTokenAccountId: oldAccount.id,
        newTokenAccountId: newAccount.id,
        operationGeneration: oldGeneration + 1,
        operationId: prepared.operation.id,
      });
      const operation = await updatePackageBillingOperation({
        operationId: prepared.operation.id,
        userId: input.userId,
        state: "completed",
        currentStep: "completed",
        data: {
          targetAvailableQuota: stableBalance.availableQuota,
          oldTokenAccountId: oldAccount.id,
          newTokenAccountId: newAccount.id,
        },
      });
      return { operation, key: created.key, reused: false as const };
    } catch (error) {
      const message = error instanceof Error ? error.message : "套餐 Key 更换失败";
      if (newApiTokenId) await disableNewApiToken(newApiTokenId).catch(() => undefined);
      if (newAccountId) {
        await updateTokenAccount(newAccountId, { status: "orphaned", disabledAt: new Date().toISOString() })
          .catch(() => undefined);
      }
      let state: "retryable_failed" | "manual_review" = "retryable_failed";
      if (oldDisabled) {
        try {
          await enableNewApiToken(oldAccount.newapiTokenId);
        } catch {
          state = "manual_review";
        }
      }
      await updatePackageBillingOperation({
        operationId: prepared.operation.id,
        userId: input.userId,
        state,
        currentStep: oldDisabled ? "old_key_restore" : "replacement_key_prepare",
        errorCode: state === "manual_review" ? "key_rotation_compensation_failed" : "key_rotation_failed",
        errorMessage: message,
        data: { failedNewTokenAccountId: newAccountId, failedNewApiTokenId: newApiTokenId },
      }).catch(() => undefined);
      throw error;
    }
  });
}
