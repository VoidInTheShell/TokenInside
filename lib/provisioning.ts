import { sha256Hex } from "@/lib/crypto";
import {
  createNewApiToken,
  disableNewApiToken,
  fromNewApiQuota,
  getNewApiTokenRemainQuota,
  toNewApiQuota,
  updateNewApiTokenQuota,
} from "@/lib/newapi";
import {
  addTokenAccount,
  createTokenRequest,
  getActiveTokenForUser,
  replaceActiveTokenAccount,
  updateTokenRequest,
} from "@/lib/store";
import type { FeishuUser, TokenRequest } from "@/lib/types";

async function updateActiveTokenQuotaForRequest(request: TokenRequest) {
  const existing = await getActiveTokenForUser(request.feishuUserId);
  if (!existing?.newapiTokenId) {
    throw new Error("当前飞书用户没有可调整额度的 active NewAPI key");
  }

  await updateTokenRequest(request.id, {
    status: "approved_provisioning",
    errorMessage: undefined,
  });

  try {
    const finalMonthlyQuota = request.approvedMonthlyQuota ?? request.requestedMonthlyQuota;
    await updateNewApiTokenQuota({
      newapiTokenId: existing.newapiTokenId,
      remainQuota: toNewApiQuota(finalMonthlyQuota),
    });
    await updateTokenRequest(request.id, {
      status: "provisioned",
      tokenAccountId: existing.id,
      errorMessage: undefined,
    });
    return existing;
  } catch (err) {
    await updateTokenRequest(request.id, {
      status: "approved_provision_failed",
      errorMessage: err instanceof Error ? err.message : "NewAPI quota update failed",
    });
    throw err;
  }
}

export async function provisionTokenForRequest(request: TokenRequest) {
  if (
    request.requestType === "quota_reset" ||
    request.requestType === "quota_adjust" ||
    request.requestType === "monthly_reset"
  ) {
    return updateActiveTokenQuotaForRequest(request);
  }

  const existing = await getActiveTokenForUser(request.feishuUserId);
  if (existing) {
    await updateTokenRequest(request.id, {
      status: "provisioned",
      tokenAccountId: existing.id,
      errorMessage: undefined,
    });
    return existing;
  }

  await updateTokenRequest(request.id, {
    status: "approved_provisioning",
    errorMessage: undefined,
  });

  try {
    const finalMonthlyQuota = request.approvedMonthlyQuota ?? request.requestedMonthlyQuota;
    const token = await createNewApiToken({
      name: `TI ${request.id.slice(0, 18)} ${request.feishuUserId.slice(0, 12)}`,
      remainQuota: toNewApiQuota(finalMonthlyQuota),
    });
    if (!token.key) {
      throw new Error("NewAPI did not return a token key; cannot create proxy hash mapping");
    }

    const account = await addTokenAccount({
      feishuUserId: request.feishuUserId,
      tokenRequestId: request.id,
      newapiTokenId: token.newapiTokenId,
      keyHash: sha256Hex(token.key),
    });

    await updateTokenRequest(request.id, {
      status: "provisioned",
      tokenAccountId: account.id,
      errorMessage: undefined,
    });
    return account;
  } catch (err) {
    await updateTokenRequest(request.id, {
      status: "approved_provision_failed",
      errorMessage: err instanceof Error ? err.message : "NewAPI token provisioning failed",
    });
    throw err;
  }
}

export async function resetActiveTokenForUser(user: FeishuUser, reason = "用户发起 key reset") {
  const existing = await getActiveTokenForUser(user.id);
  if (!existing?.newapiTokenId) {
    throw new Error("当前飞书用户没有可重置的 active NewAPI key");
  }

  const remainQuota = await getNewApiTokenRemainQuota(existing.newapiTokenId);
  if (remainQuota === undefined) {
    throw new Error("NewAPI token 当前剩余额度不可用，无法继承额度重置 key");
  }

  const displayRemainQuota = Math.max(0, Math.round(fromNewApiQuota(remainQuota)));
  const resetRequest = await createTokenRequest({
    feishuUserId: user.id,
    requestType: "key_reset",
    status: "approved_provisioning",
    reason,
    requestedMonthlyQuota: displayRemainQuota,
    approvedMonthlyQuota: displayRemainQuota,
    approvalMode: "manual",
  });

  try {
    const token = await createNewApiToken({
      name: `TI reset ${resetRequest.id.slice(0, 14)} ${user.id.slice(0, 10)}`,
      remainQuota,
    });
    if (!token.key) {
      throw new Error("NewAPI did not return a reset token key");
    }

    const account = await replaceActiveTokenAccount({
      oldTokenAccountId: existing.id,
      feishuUserId: user.id,
      tokenRequestId: resetRequest.id,
      newapiTokenId: token.newapiTokenId,
      keyHash: sha256Hex(token.key),
      billingPeriod: existing.billingPeriod,
    });
    if (!account) {
      throw new Error("Active token account was changed before key reset completed");
    }

    await disableNewApiToken(existing.newapiTokenId);
    const request = await updateTokenRequest(resetRequest.id, {
      status: "provisioned",
      tokenAccountId: account.id,
      errorMessage: undefined,
    });
    return { request, account, key: token.key };
  } catch (err) {
    await updateTokenRequest(resetRequest.id, {
      status: "approved_provision_failed",
      errorMessage: err instanceof Error ? err.message : "NewAPI key reset failed",
    });
    throw err;
  }
}
