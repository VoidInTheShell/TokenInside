import { getConfig, type RuntimeConfig } from "@/lib/config";
import { openAppSecret } from "@/lib/secret-box";
import { getNewApiRuntimeBindingSnapshot } from "@/lib/store";

const secretContext = "app-settings:newapi-access-token";

type LoadedRuntimeBinding = {
  value: RuntimeConfig["newapi"];
};

type NewApiRuntimeCache = {
  version: 1;
  generation: number;
  cached?: RuntimeConfig["newapi"];
  refreshPromise?: Promise<{ generation: number; loaded: LoadedRuntimeBinding }>;
};

type NewApiRuntimeGlobal = typeof globalThis & {
  __tokenInsideNewApiRuntimeCacheV1?: NewApiRuntimeCache;
};

const newApiRuntimeGlobal = globalThis as NewApiRuntimeGlobal;
const runtime =
  (newApiRuntimeGlobal.__tokenInsideNewApiRuntimeCacheV1 ??= {
    version: 1,
    generation: 0,
  });

export function newApiAccessTokenSecretContext() {
  return secretContext;
}

export function invalidateEffectiveNewApiConfig() {
  runtime.generation += 1;
  runtime.cached = undefined;
}

export class NewApiControlIdentityError extends Error {
  readonly code = "newapi_control_identity_invalid";

  constructor(readonly reason: string) {
    super(`NewAPI 控制用户验证失败: ${reason}`);
    this.name = "NewApiControlIdentityError";
  }
}

async function loadRuntimeBinding(): Promise<LoadedRuntimeBinding> {
  const fallback = getConfig().newapi;
  const snapshot = await getNewApiRuntimeBindingSnapshot();
  const override = snapshot.settings.newapiControl;
  const baseUrl = override?.baseUrl?.replace(/\/+$/, "") || fallback.baseUrl;
  const value = {
    ...fallback,
    baseUrl,
    publicBaseUrl:
      fallback.publicBaseUrl && fallback.publicBaseUrl !== fallback.baseUrl
        ? fallback.publicBaseUrl
        : baseUrl,
    controlUserId: override?.controlUserId || fallback.controlUserId,
    accessToken: override?.accessTokenCiphertext
      ? openAppSecret(override.accessTokenCiphertext, secretContext)
      : fallback.accessToken,
  };
  return { value };
}

export async function getEffectiveNewApiConfigForBindingCheck() {
  return (await loadRuntimeBinding()).value;
}

export async function getNewApiRuntimeBindingForHealth() {
  return loadRuntimeBinding();
}

export async function getEffectiveNewApiConfig() {
  for (;;) {
    if (runtime.cached) return runtime.cached;
    const generation = runtime.generation;
    let refresh = runtime.refreshPromise;
    if (!refresh) {
      refresh = loadRuntimeBinding().then((loaded) => ({ generation, loaded }));
      runtime.refreshPromise = refresh;
    }
    try {
      const refreshed = await refresh;
      if (refreshed.generation !== runtime.generation) continue;
      const { value } = refreshed.loaded;
      runtime.cached = value;
      return value;
    } catch (error) {
      if (generation !== runtime.generation) continue;
      throw error;
    } finally {
      if (runtime.refreshPromise === refresh) runtime.refreshPromise = undefined;
    }
  }
}

export async function verifyNewApiControlIdentity(input: {
  baseUrl: string;
  controlUserId: string;
  credential: string;
  requestTimeoutMs: number;
}) {
  const response = await fetch(
    `${input.baseUrl.replace(/\/+$/, "")}/api/user/self`,
    {
      headers: {
        authorization: input.credential,
        "New-Api-User": input.controlUserId,
        "LLMAPI-User": input.controlUserId,
        "content-type": "application/json; charset=utf-8",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(input.requestTimeoutMs),
    },
  );
  const text = await response.text();
  let body: {
    success?: boolean;
    message?: string;
    error?: string;
    data?: { id?: string | number };
  };
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`NewAPI returned non-JSON identity response: ${response.status}`);
  }
  if (!response.ok || body.success === false) {
    throw new Error(
      body.message ?? body.error ?? `NewAPI identity request failed: ${response.status}`,
    );
  }
  const observedControlUserId = String(body.data?.id ?? "");
  if (!observedControlUserId || observedControlUserId !== input.controlUserId) {
    throw new NewApiControlIdentityError("control_credential_identity_mismatch");
  }
  return { observedControlUserId };
}
