import { sha256Hex } from "@/lib/crypto";
import { createNewApiToken } from "@/lib/newapi";
import {
  addTokenAccount,
  getActiveTokenForUser,
  updateTokenRequest,
} from "@/lib/store";
import type { TokenRequest } from "@/lib/types";

export async function provisionTokenForRequest(request: TokenRequest) {
  const existing = await getActiveTokenForUser(request.feishuUserId);
  if (existing) {
    await updateTokenRequest(request.id, { status: "provisioned" });
    return existing;
  }

  await updateTokenRequest(request.id, { status: "approved_provisioning" });

  try {
    const token = await createNewApiToken({
      name: `TokenInside ${request.feishuUserId} ${request.id}`,
      remainQuota: request.requestedMonthlyQuota,
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

    await updateTokenRequest(request.id, { status: "provisioned" });
    return account;
  } catch (err) {
    await updateTokenRequest(request.id, {
      status: "approved_provision_failed",
      errorMessage: err instanceof Error ? err.message : "NewAPI token provisioning failed",
    });
    throw err;
  }
}
