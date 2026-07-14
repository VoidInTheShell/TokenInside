import { createClient } from "redis";
import { getConfig } from "./config.ts";

type RedisClient = ReturnType<typeof createClient<{}, {}, {}, 3, {}>>;

let client: RedisClient | undefined;
let connecting: Promise<RedisClient> | undefined;
let lastError: string | undefined;
let connectedAt: string | undefined;
let commandFailures = 0;

function safeError(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message.replace(/redis(?:s)?:\/\/[^@\s]+@/gi, "redis://[redacted]@").slice(0, 300)
    : "Redis operation failed";
}

function createRuntimeClient() {
  const config = getConfig().redis;
  if (!config.url) return undefined;
  const created = createClient({
    url: config.url,
    socket: {
      connectTimeout: config.connectTimeoutMs,
      reconnectStrategy(retries) {
        return Math.min(50 * 2 ** Math.min(retries, 5), 1000);
      },
    },
  });
  created.on("error", (error) => {
    lastError = safeError(error);
  });
  created.on("ready", () => {
    connectedAt = new Date().toISOString();
    lastError = undefined;
  });
  return created;
}

export async function getRedisClient() {
  const config = getConfig().redis;
  if (!config.url) return undefined;
  if (!client) client = createRuntimeClient();
  if (!client) return undefined;
  if (client.isReady) return client;
  if (!connecting) {
    const target = client;
    connecting = target
      .connect()
      .then(() => target)
      .catch((error) => {
        lastError = safeError(error);
        commandFailures += 1;
        try {
          target.destroy();
        } catch {
          // The socket can already be closed after a failed connect.
        }
        if (client === target) client = undefined;
        throw error;
      })
      .finally(() => {
        connecting = undefined;
      });
  }
  return connecting;
}

export async function getOptionalRedisClient() {
  try {
    return await getRedisClient();
  } catch {
    return undefined;
  }
}

export function redisKey(namespace: string, identity: string) {
  const prefix = getConfig().redis.keyPrefix;
  return `${prefix}:${namespace}:${identity}`;
}

export function recordRedisCommandFailure(error: unknown) {
  commandFailures += 1;
  lastError = safeError(error);
}

export async function closeRedisClient() {
  const target = client;
  client = undefined;
  connecting = undefined;
  if (!target) return;
  try {
    if (target.isOpen) await target.close();
  } catch {
    target.destroy();
  }
}

export async function checkRedisConnection() {
  const config = getConfig().redis;
  if (!config.url) {
    return {
      configured: false,
      required: config.required,
      ready: false,
      latencyMs: undefined,
      error: config.required ? "not_configured" : undefined,
    };
  }
  const startedAt = performance.now();
  try {
    const target = await getRedisClient();
    if (!target) throw new Error("Redis is not configured");
    await target.ping();
    return {
      configured: true,
      required: config.required,
      ready: true,
      latencyMs: Math.max(performance.now() - startedAt, 0),
      error: undefined,
    };
  } catch (error) {
    recordRedisCommandFailure(error);
    return {
      configured: true,
      required: config.required,
      ready: false,
      latencyMs: Math.max(performance.now() - startedAt, 0),
      error: "connection_failed",
    };
  }
}

export function redisRuntimeSnapshot() {
  const config = getConfig().redis;
  return {
    configured: Boolean(config.url),
    required: config.required,
    ready: Boolean(client?.isReady),
    open: Boolean(client?.isOpen),
    connectedAt,
    commandFailures,
    lastError,
  };
}
