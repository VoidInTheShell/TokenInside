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
  assertFirstProvisionDepartmentCapacity,
  createTokenRequest,
  findQuotaOperationByIdempotencyKey,
  getActiveTokenForUser,
  getAppSettings,
  completeDepartmentQuotaReservation,
  failDepartmentQuotaReservation,
  invalidateOtherOpenFirstApplyRequests,
  replaceActiveTokenAccount,
  reserveDepartmentQuotaForTokenRequest,
  transitionTokenRequestStatus,
  updateTokenRequest,
  getStoreSnapshot,
} from "@/lib/store";
import type { FeishuUser, TokenRequest } from "@/lib/types";
import { assertLegacyAbsoluteQuotaWriteEnabled } from "@/lib/quota-guard";
import {
  enqueueFirstProvision,
  enqueueQuotaAdjustment,
  enqueueQuotaRestoreForRequest,
  runQuotaOperation,
} from "@/lib/quota-saga";

async function invalidateOtherFirstApplyRequestsAfterProvision(request: TokenRequest) {
  if (request.requestType !== "first_apply") return;
  await invalidateOtherOpenFirstApplyRequests({
    feishuUserId: request.feishuUserId,
    approvedRequestId: request.id,
    approvalOperatorOpenId: request.approvalOperatorOpenId,
    approvalOperatedAt: request.approvalOperatedAt,
  });
}

const reusableFirstApplyStatuses = new Set([
  "approved",
  "approved_provisioning",
  "approved_provision_failed",
]);

export async function findReusableFirstApplyRequest(
  requests: TokenRequest[],
  reason?: string,
) {
  const candidates = requests.filter(
    (request) =>
      request.requestType === "first_apply" &&
      reusableFirstApplyStatuses.has(request.status) &&
      (!reason || request.reason === reason),
  );
  for (const candidate of candidates) {
    const operation = await findQuotaOperationByIdempotencyKey(
      `quota-operation:${candidate.id}`,
    );
    if (operation) return candidate;
  }
  return candidates.at(-1) ?? null;
}

async function updateActiveTokenQuotaForRequest(request: TokenRequest) {
  const action =
    request.requestType === "quota_adjust"
      ? "quota_adjust"
      : request.requestType === "monthly_reset"
        ? "monthly_open"
        : "quota_restore";
  await assertLegacyAbsoluteQuotaWriteEnabled(action);
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
  if (request.requestType === "quota_reset" || request.requestType === "quota_restore") {
    const operation = await enqueueQuotaRestoreForRequest(request);
    await updateTokenRequest(request.id, {
      status: "approved_provisioning",
      errorMessage: undefined,
    });
    await runQuotaOperation(operation.id);
    return getActiveTokenForUser(request.feishuUserId);
  }
  if (request.requestType === "quota_adjust") {
    const store = await getStoreSnapshot();
    const user = store.users.find((item) => item.id === request.feishuUserId);
    const operation = await enqueueQuotaAdjustment({
      feishuUserId: request.feishuUserId,
      departmentId: user?.departmentId,
      approvedMonthlyQuota:
        request.approvedMonthlyQuota ?? request.requestedMonthlyQuota,
      clientRequestId: request.id,
      requestId: request.id,
      createdByOpenId: request.approvalOperatorOpenId,
    });
    await runQuotaOperation(operation.id);
    return getActiveTokenForUser(request.feishuUserId);
  }
  if (request.requestType === "first_apply") {
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
    const settings = await getAppSettings();
    if (settings.quotaMigration?.appliedAt) {
      try {
        const approvedMonthlyQuota =
          request.approvedMonthlyQuota ?? request.requestedMonthlyQuota;
        await assertFirstProvisionDepartmentCapacity({
          feishuUserId: request.feishuUserId,
          requestedMonthlyQuota: approvedMonthlyQuota,
          requestId: request.id,
        });
        const store = await getStoreSnapshot();
        const user = store.users.find((item) => item.id === request.feishuUserId);
        const operation = await enqueueFirstProvision({
          feishuUserId: request.feishuUserId,
          departmentId: user?.departmentId,
          approvedMonthlyQuota,
          requestId: request.id,
          createdByOpenId: request.approvalOperatorOpenId,
        });
        await updateTokenRequest(request.id, {
          status: "approved_provisioning",
          errorMessage: undefined,
        });
        const completed = await runQuotaOperation(operation.id);
        if (completed.state !== "completed") {
          throw new Error(
            completed.lastErrorMessage ?? `首次发放尚未完成: ${completed.state}`,
          );
        }
        const account = await getActiveTokenForUser(request.feishuUserId);
        if (!account) throw new Error("首次发放完成后未找到 active Key");
        await invalidateOtherFirstApplyRequestsAfterProvision(request);
        return account;
      } catch (error) {
        const message = error instanceof Error ? error.message : "首次发放失败";
        await updateTokenRequest(request.id, {
          status: "approved_provision_failed",
          errorMessage: message,
        }).catch(() => undefined);
        throw error;
      }
    }
  }
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
  await assertLegacyAbsoluteQuotaWriteEnabled("key_rotation");
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
