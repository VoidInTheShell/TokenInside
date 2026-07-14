import { sha256Hex } from "@/lib/crypto";
import {
  createPrewarmedNewApiTokens,
  deleteNewApiTokens,
} from "@/lib/newapi";
import { openQuotaCredential, sealQuotaCredential } from "@/lib/secret-box";
import {
  addTokenAccount,
  getStoreSnapshot,
  updateTokenAccount,
  withUserKeyLifecycleLock,
} from "@/lib/store";
import type { TokenAccount } from "@/lib/types";

type KeyStoreSnapshot = Awaited<ReturnType<typeof getStoreSnapshot>>;

function userHasTokenReservation(store: KeyStoreSnapshot, feishuUserId: string) {
  return store.tokenAccounts.some(
    (account) =>
      account.feishuUserId === feishuUserId &&
      ["pending_activation", "active", "draining", "settling"].includes(account.status),
  );
}

function eligibleDepartmentUsers(store: KeyStoreSnapshot, departmentId: string) {
  return store.users
    .filter(
      (user) =>
        user.departmentId === departmentId &&
        (!user.status || user.status === "active") &&
        !userHasTokenReservation(store, user.id),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function prewarmDepartmentMemberKeys(input: {
  departmentId: string;
  limit?: number;
}) {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), 100);
  const initialStore = await getStoreSnapshot();
  const eligible = eligibleDepartmentUsers(initialStore, input.departmentId);
  const candidates = eligible.slice(0, limit);
  if (candidates.length === 0) {
    return {
      eligible: 0,
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
  const unusedTokenIds: string[] = [];
  let prewarmed = 0;
  let skippedAfterRace = 0;
  let failed = 0;

  for (const [index, user] of candidates.entries()) {
    const upstream = warmed[index];
    try {
      const stored = await withUserKeyLifecycleLock(user.id, async () => {
        const currentStore = await getStoreSnapshot();
        if (
          userHasTokenReservation(currentStore, user.id)
        ) {
          return null;
        }
        const account = await addTokenAccount({
          feishuUserId: user.id,
          sourceRequestId: `prewarm:${upstream.newapiTokenId}`,
          newapiTokenId: upstream.newapiTokenId,
          keyHash: sha256Hex(upstream.key),
          status: "pending_activation",
          billingPeriod: new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Hong_Kong",
            year: "numeric",
            month: "2-digit",
          }).format(new Date()),
          operationGeneration: 0,
          prewarmedAt: new Date().toISOString(),
          prewarmDepartmentId: input.departmentId,
        });
        const updated = await updateTokenAccount(account.id, {
          prewarmedCredentialCiphertext: sealQuotaCredential(upstream.key, account.id),
        });
        if (!updated) {
          await updateTokenAccount(account.id, { status: "orphaned" }).catch(() => undefined);
          throw new Error("预热 Key 本地凭据封装失败");
        }
        return updated;
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
    eligible: eligible.length,
    prewarmed,
    skippedAfterRace,
    failed,
    capped: eligible.length > candidates.length,
  };
}

export async function claimPrewarmedTokenForProvision(input: {
  feishuUserId: string;
  sourceRequestId: string;
  billingPeriod: string;
  operationGeneration?: number;
}) {
  return withUserKeyLifecycleLock(input.feishuUserId, async () => {
    const store = await getStoreSnapshot();
    const account = store.tokenAccounts.find(
      (item) =>
        item.feishuUserId === input.feishuUserId &&
        item.status === "pending_activation" &&
        Boolean(item.newapiTokenId) &&
        Boolean(item.prewarmedCredentialCiphertext),
    );
    if (!account?.newapiTokenId || !account.prewarmedCredentialCiphertext) return null;
    const key = openQuotaCredential(account.prewarmedCredentialCiphertext, account.id);
    const updated = await updateTokenAccount(account.id, {
      sourceRequestId: input.sourceRequestId,
      billingPeriod: input.billingPeriod,
      operationGeneration: input.operationGeneration ?? account.operationGeneration,
    });
    if (!updated) return null;
    return { account: updated as TokenAccount, key };
  });
}

export async function clearClaimedPrewarmedCredential(accountId: string) {
  return updateTokenAccount(accountId, {
    prewarmedCredentialCiphertext: undefined,
  });
}
