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
  completeDepartmentQuotaReservation,
  failDepartmentQuotaReservation,
  invalidateOtherOpenFirstApplyRequests,
  replaceActiveTokenAccount,
  reserveDepartmentQuotaForTokenRequest,
  transitionTokenRequestStatus,
  updateTokenRequest,
} from "@/lib/store";
import type { FeishuUser, TokenRequest } from "@/lib/types";

async function invalidateOtherFirstApplyRequestsAfterProvision(request: TokenRequest) {
  if (request.requestType !== "first_apply") return;
  await invalidateOtherOpenFirstApplyRequests({
    feishuUserId: request.feishuUserId,
    approvedRequestId: request.id,
    approvalOperatorOpenId: request.approvalOperatorOpenId,
    approvalOperatedAt: request.approvalOperatedAt,
  });
}

async function updateActiveTokenQuotaForRequest(request: TokenRequest) {
  const existing = await getActiveTokenForUser(request.feishuUserId);
  if (!existing?.newapiTokenId) {
    throw new Error("当前飞书用户没有可调整额度的 active NewAPI key");
  }

  const provisioningRequest = await transitionTokenRequestStatus(
    request.id,
    {
      status: "approved_provisioning",
      errorMessage: undefined,
    },
    ["approved", "approved_provision_failed"],
  );
  if (!provisioningRequest) {
    throw new Error("申请单已在发放中或已处理");
  }

  try {
    const finalMonthlyQuota =
      provisioningRequest.approvedMonthlyQuota ?? provisioningRequest.requestedMonthlyQuota;
    await updateNewApiTokenQuota({
      newapiTokenId: existing.newapiTokenId,
      remainQuota: toNewApiQuota(finalMonthlyQuota),
    });
    await updateTokenRequest(request.id, {
      status: "provisioned",
      tokenAccountId: existing.id,
      errorMessage: undefined,
    });
    await invalidateOtherFirstApplyRequestsAfterProvision(request);
    return existing;
  } catch (err) {
    await updateTokenRequest(request.id, {
      status: "approved_provision_failed",
      errorMessage: err instanceof Error ? err.message : "NewAPI quota update failed",
    });
    throw err;
  }
}

async function provisionTokenForRequestWithoutDepartmentReservation(request: TokenRequest) {
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
    await invalidateOtherFirstApplyRequestsAfterProvision(request);
    return existing;
  }

  const provisioningRequest = await transitionTokenRequestStatus(
    request.id,
    {
      status: "approved_provisioning",
      errorMessage: undefined,
    },
    ["approved", "approved_provision_failed"],
  );
  if (!provisioningRequest) {
    const existingAfterRace = await getActiveTokenForUser(request.feishuUserId);
    if (existingAfterRace) {
      await updateTokenRequest(request.id, {
        status: "provisioned",
        tokenAccountId: existingAfterRace.id,
        errorMessage: undefined,
      });
      await invalidateOtherFirstApplyRequestsAfterProvision(request);
      return existingAfterRace;
    }
    throw new Error("申请单已在发放中或已处理");
  }

  let createdNewApiTokenId: string | undefined;
  let accountSaved = false;
  try {
    const finalMonthlyQuota =
      provisioningRequest.approvedMonthlyQuota ?? provisioningRequest.requestedMonthlyQuota;
    const token = await createNewApiToken({
      name: `TI ${provisioningRequest.id.slice(0, 18)} ${provisioningRequest.feishuUserId.slice(0, 12)}`,
      remainQuota: toNewApiQuota(finalMonthlyQuota),
    });
    createdNewApiTokenId = token.newapiTokenId;
    if (!token.key) {
      throw new Error("NewAPI did not return a token key; cannot create proxy hash mapping");
    }

    const account = await addTokenAccount({
      feishuUserId: provisioningRequest.feishuUserId,
      tokenRequestId: provisioningRequest.id,
      newapiTokenId: token.newapiTokenId,
      keyHash: sha256Hex(token.key),
    });
    accountSaved = true;

    await updateTokenRequest(provisioningRequest.id, {
      status: "provisioned",
      tokenAccountId: account.id,
      errorMessage: undefined,
    });
    await invalidateOtherFirstApplyRequestsAfterProvision(provisioningRequest);
    return account;
  } catch (err) {
    if (createdNewApiTokenId && !accountSaved) {
      await disableNewApiToken(createdNewApiTokenId).catch((disableErr) => {
        console.error("Failed to disable orphaned NewAPI token", disableErr);
      });
    }
    const existingAfterRace = await getActiveTokenForUser(request.feishuUserId);
    if (existingAfterRace) {
      await updateTokenRequest(request.id, {
        status: "provisioned",
        tokenAccountId: existingAfterRace.id,
        errorMessage: undefined,
      });
      await invalidateOtherFirstApplyRequestsAfterProvision(request);
      return existingAfterRace;
    }
    await updateTokenRequest(provisioningRequest.id, {
      status: "approved_provision_failed",
      errorMessage: err instanceof Error ? err.message : "NewAPI token provisioning failed",
    });
    throw err;
  }
}

export async function provisionTokenForRequest(request: TokenRequest) {
  const existingBeforeProvision = await getActiveTokenForUser(request.feishuUserId);
  const shouldReserve = !(request.requestType === "first_apply" && existingBeforeProvision);
  let reservation: Awaited<ReturnType<typeof reserveDepartmentQuotaForTokenRequest>> = null;
  try {
    reservation = shouldReserve ? await reserveDepartmentQuotaForTokenRequest(request) : null;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "部门可用额度校验失败";
    await updateTokenRequest(request.id, {
      status: "approved_provision_failed",
      errorMessage,
    });
    throw err;
  }

  let account: Awaited<ReturnType<typeof provisionTokenForRequestWithoutDepartmentReservation>>;
  try {
    account = await provisionTokenForRequestWithoutDepartmentReservation(request);
  } catch (err) {
    if (reservation) {
      await failDepartmentQuotaReservation(
        reservation.id,
        err instanceof Error ? err.message : "NewAPI token provisioning failed",
      ).catch(() => undefined);
    }
    throw err;
  }
  if (reservation) await completeDepartmentQuotaReservation(reservation.id);
  return account;
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

  let createdNewApiTokenId: string | undefined;
  let accountSaved = false;
  try {
    const token = await createNewApiToken({
      name: `TI reset ${resetRequest.id.slice(0, 14)} ${user.id.slice(0, 10)}`,
      remainQuota,
    });
    createdNewApiTokenId = token.newapiTokenId;
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
    accountSaved = true;

    await disableNewApiToken(existing.newapiTokenId);
    const request = await updateTokenRequest(resetRequest.id, {
      status: "provisioned",
      tokenAccountId: account.id,
      errorMessage: undefined,
    });
    return { request, account, key: token.key };
  } catch (err) {
    if (createdNewApiTokenId && !accountSaved) {
      await disableNewApiToken(createdNewApiTokenId).catch((disableErr) => {
        console.error("Failed to disable orphaned reset NewAPI token", disableErr);
      });
    }
    await updateTokenRequest(resetRequest.id, {
      status: "approved_provision_failed",
      errorMessage: err instanceof Error ? err.message : "NewAPI key reset failed",
    });
    throw err;
  }
}
