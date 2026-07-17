import { getConfig, type RuntimeConfig } from "@/lib/config";
import { openAppSecret } from "@/lib/secret-box";
import { getAppSettings } from "@/lib/store";

const secretContext = "app-settings:newapi-access-token";
const cacheTtlMs = 5_000;

let cached:
  | { expiresAt: number; value: RuntimeConfig["newapi"] }
  | undefined;

export function newApiAccessTokenSecretContext() {
  return secretContext;
}

export function invalidateEffectiveNewApiConfig() {
  cached = undefined;
}

export async function getEffectiveNewApiConfig() {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const fallback = getConfig().newapi;
  let override: Awaited<ReturnType<typeof getAppSettings>>["newapiControl"];
  try {
    override = (await getAppSettings()).newapiControl;
  } catch {
    // Keep the environment-backed route available during a transient settings read failure.
    cached = { expiresAt: Date.now() + cacheTtlMs, value: fallback };
    return fallback;
  }
  const value = {
    ...fallback,
    baseUrl: override?.baseUrl?.replace(/\/+$/, "") || fallback.baseUrl,
    controlUserId: override?.controlUserId || fallback.controlUserId,
    accessToken: override?.accessTokenCiphertext
      ? openAppSecret(override.accessTokenCiphertext, secretContext)
      : fallback.accessToken,
  };
  cached = { expiresAt: Date.now() + cacheTtlMs, value };
  return value;
}
