import { getConfig } from "./config.ts";
import {
  getOptionalRedisClient,
  recordRedisCommandFailure,
  redisKey,
} from "./redis-runtime.ts";
import type { FeishuUser, TokenAccount } from "./types.ts";

export type ProxyPrincipal = {
  tokenAccount: TokenAccount;
  user: FeishuUser;
};

const inFlight = new Map<string, Promise<ProxyPrincipal | null>>();
let hits = 0;
let misses = 0;
let postgresFallbacks = 0;
let writes = 0;
let invalidations = 0;

function cacheKey(keyHash: string) {
  return redisKey("proxy-principal", keyHash);
}

function validCachedPrincipal(value: unknown, keyHash: string): value is ProxyPrincipal {
  if (!value || typeof value !== "object") return false;
  const principal = value as Partial<ProxyPrincipal>;
  return Boolean(
    principal.tokenAccount &&
      principal.tokenAccount.keyHash === keyHash &&
      principal.tokenAccount.status === "active" &&
      principal.user &&
      principal.user.id === principal.tokenAccount.feishuUserId,
  );
}

export async function primeProxyPrincipalCache(keyHash: string, principal: ProxyPrincipal) {
  const redis = await getOptionalRedisClient();
  if (!redis) return false;
  try {
    await redis.set(cacheKey(keyHash), JSON.stringify(principal), {
      EX: getConfig().redis.principalTtlSeconds,
    });
    writes += 1;
    return true;
  } catch (error) {
    recordRedisCommandFailure(error);
    return false;
  }
}

async function readCachedPrincipal(keyHash: string) {
  const redis = await getOptionalRedisClient();
  if (!redis) return undefined;
  try {
    const raw = await redis.getEx(cacheKey(keyHash), {
      EX: getConfig().redis.principalTtlSeconds,
    });
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    if (!validCachedPrincipal(parsed, keyHash)) {
      await redis.del(cacheKey(keyHash));
      return undefined;
    }
    return parsed;
  } catch (error) {
    recordRedisCommandFailure(error);
    return undefined;
  }
}

export async function findActiveTokenPrincipalCached(
  keyHash: string,
  loader: () => Promise<{ tokenAccount: TokenAccount; user: FeishuUser | null } | null>,
) {
  const cached = await readCachedPrincipal(keyHash);
  if (cached) {
    hits += 1;
    return cached;
  }
  misses += 1;
  const existing = inFlight.get(keyHash);
  if (existing) return existing;
  const lookup = (async () => {
    postgresFallbacks += 1;
    const principal = await loader();
    if (!principal?.user) return null;
    const resolved: ProxyPrincipal = {
      tokenAccount: principal.tokenAccount,
      user: principal.user,
    };
    await primeProxyPrincipalCache(keyHash, resolved);
    return resolved;
  })().finally(() => {
    inFlight.delete(keyHash);
  });
  inFlight.set(keyHash, lookup);
  return lookup;
}

export async function invalidateProxyPrincipalCache(keyHash: string) {
  const redis = await getOptionalRedisClient();
  if (!redis) return false;
  try {
    await redis.del(cacheKey(keyHash));
    invalidations += 1;
    return true;
  } catch (error) {
    recordRedisCommandFailure(error);
    return false;
  }
}

export function proxyPrincipalCacheSnapshot() {
  return {
    hits,
    misses,
    postgresFallbacks,
    writes,
    invalidations,
    inFlight: inFlight.size,
  };
}
