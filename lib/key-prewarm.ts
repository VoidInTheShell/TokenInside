import { nowIso, randomId, sha256Hex } from "@/lib/crypto";
import {
  createPrewarmedNewApiTokens,
  deleteNewApiTokens,
} from "@/lib/newapi";
import { openQuotaCredential, sealQuotaCredential } from "@/lib/secret-box";
import {
  claimStoredPrewarmedTokenAccountUnderUserFence,
  getCurrentPackageBillingPeriod,
  listDepartmentPrewarmCandidates,
  reservePrewarmedTokenAccountUnderUserFence,
  updateTokenAccount,
  withUserQuotaOperationLock,
} from "@/lib/store";
import type { TokenAccount } from "@/lib/types";

export async function prewarmDepartmentMemberKeys(input: {
  departmentId: string;
  limit?: number;
}) {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), 100);
  const selection = await listDepartmentPrewarmCandidates({
    departmentId: input.departmentId,
    limit,
  });
  const candidates = selection.candidates;
  if (candidates.length === 0) {
    return {
      eligible: selection.eligible,
      prewarmed: 0,
      skippedAfterRace: 0,
      failed: 0,
      capped: false,
    };
  }

  const warmed = await createPrewarmedNewApiTokens({
    count: candidates.length,
    batchLabel: input.departmentId,
  });
  const billingPeriod = await getCurrentPackageBillingPeriod();
  const unusedTokenIds: string[] = [];
  let prewarmed = 0;
  let skippedAfterRace = 0;
  let failed = 0;

  for (const [index, user] of candidates.entries()) {
    const upstream = warmed[index];
    try {
      const stored = await withUserQuotaOperationLock(user.id, async () => {
        const accountId = randomId("ta");
        const prewarmedAt = nowIso();
        const account: TokenAccount = {
          id: accountId,
          feishuUserId: user.id,
          tokenRequestId: `prewarm:${upstream.newapiTokenId}`,
          newapiTokenId: upstream.newapiTokenId,
          keyHash: sha256Hex(upstream.key),
          status: "pending_activation",
          billingPeriod,
          operationGeneration: 0,
          prewarmedAt,
          prewarmDepartmentId: input.departmentId,
          prewarmedCredentialCiphertext: sealQuotaCredential(upstream.key, accountId),
          createdAt: prewarmedAt,
        };
        return reservePrewarmedTokenAccountUnderUserFence({
          departmentId: input.departmentId,
          account,
        });
      });
      if (stored) prewarmed += 1;
      else {
        skippedAfterRace += 1;
        unusedTokenIds.push(upstream.newapiTokenId);
      }
    } catch {
      failed += 1;
      unusedTokenIds.push(upstream.newapiTokenId);
    }
  }

  await deleteNewApiTokens(unusedTokenIds);
  return {
    eligible: selection.eligible,
    prewarmed,
    skippedAfterRace,
    failed,
    capped: selection.eligible > candidates.length,
  };
}

type PrewarmedProvisionClaimInput = {
  feishuUserId: string;
  tokenRequestId: string;
  billingPeriod: string;
  operationGeneration?: number;
};

// The quota Saga already owns the complete user session fence. Reacquiring
// that advisory key through another pooled connection would deadlock against
// itself, so the Saga uses this explicitly pre-fenced entrypoint.
export async function claimPrewarmedTokenForProvisionUnderUserFence(
  input: PrewarmedProvisionClaimInput,
) {
  const account = await claimStoredPrewarmedTokenAccountUnderUserFence(input);
  if (!account?.newapiTokenId || !account.prewarmedCredentialCiphertext) return null;
  const key = openQuotaCredential(account.prewarmedCredentialCiphertext, account.id);
  return { account: account as TokenAccount, key };
}

export async function claimPrewarmedTokenForProvision(
  input: PrewarmedProvisionClaimInput,
) {
  return withUserQuotaOperationLock(input.feishuUserId, () =>
    claimPrewarmedTokenForProvisionUnderUserFence(input),
  );
}

export async function clearClaimedPrewarmedCredential(accountId: string) {
  return updateTokenAccount(accountId, {
    prewarmedCredentialCiphertext: undefined,
  });
}
