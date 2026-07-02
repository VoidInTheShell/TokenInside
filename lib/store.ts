import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/config";
import { nowIso, randomId } from "@/lib/crypto";
import type {
  FeishuEvent,
  FeishuUser,
  ProxyRequestLog,
  StoreShape,
  TokenAccount,
  TokenRequest,
} from "@/lib/types";

const initialStore: StoreShape = {
  version: 1,
  users: [],
  tokenRequests: [],
  tokenAccounts: [],
  feishuEvents: [],
  proxyRequestLogs: [],
};

async function readStore(): Promise<StoreShape> {
  const filePath = getConfig().storePath;
  try {
    const raw = await readFile(filePath, "utf8");
    return { ...initialStore, ...(JSON.parse(raw) as StoreShape) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await writeStore(initialStore);
    return structuredClone(initialStore);
  }
}

async function writeStore(store: StoreShape) {
  const filePath = getConfig().storePath;
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

async function mutate<T>(fn: (store: StoreShape) => T | Promise<T>) {
  const store = await readStore();
  const result = await fn(store);
  await writeStore(store);
  return result;
}

export async function getStoreSnapshot() {
  return readStore();
}

export async function upsertFeishuUser(input: {
  tenantKey: string;
  openId: string;
  unionId?: string;
  feishuUserIdFromFeishu?: string;
  name?: string;
  avatarUrl?: string;
  departmentId?: string;
}) {
  return mutate((store) => {
    const existing = store.users.find(
      (user) => user.tenantKey === input.tenantKey && user.openId === input.openId,
    );
    const now = nowIso();
    if (existing) {
      Object.assign(existing, {
        unionId: input.unionId ?? existing.unionId,
        feishuUserIdFromFeishu:
          input.feishuUserIdFromFeishu ?? existing.feishuUserIdFromFeishu,
        name: input.name ?? existing.name,
        avatarUrl: input.avatarUrl ?? existing.avatarUrl,
        departmentId: input.departmentId ?? existing.departmentId,
        updatedAt: now,
      });
      return existing;
    }

    const user: FeishuUser = {
      id: randomId("fu"),
      tenantKey: input.tenantKey,
      openId: input.openId,
      unionId: input.unionId,
      feishuUserIdFromFeishu: input.feishuUserIdFromFeishu,
      name: input.name,
      avatarUrl: input.avatarUrl,
      departmentId: input.departmentId,
      createdAt: now,
      updatedAt: now,
    };
    store.users.push(user);
    return user;
  });
}

export async function getUserById(id: string) {
  const store = await readStore();
  return store.users.find((user) => user.id === id) ?? null;
}

export async function createTokenRequest(input: {
  feishuUserId: string;
  reason: string;
  requestedMonthlyQuota: number;
  approvalCode?: string;
  approvalDepartmentId?: string;
  status?: TokenRequest["status"];
}) {
  return mutate((store) => {
    const now = nowIso();
    const request: TokenRequest = {
      id: randomId("tr"),
      feishuUserId: input.feishuUserId,
      requestType: "first_apply",
      status: input.status ?? "pending_feishu_approval",
      reason: input.reason,
      requestedMonthlyQuota: input.requestedMonthlyQuota,
      approvalCode: input.approvalCode,
      approvalUuid: randomId("approval"),
      approvalDepartmentId: input.approvalDepartmentId,
      createdAt: now,
      updatedAt: now,
    };
    store.tokenRequests.push(request);
    return request;
  });
}

export async function updateTokenRequest(
  id: string,
  patch: Partial<Omit<TokenRequest, "id" | "createdAt">>,
) {
  return mutate((store) => {
    const request = store.tokenRequests.find((item) => item.id === id);
    if (!request) return null;
    Object.assign(request, patch, { updatedAt: nowIso() });
    return request;
  });
}

export async function findTokenRequestByInstance(instanceCode: string) {
  const store = await readStore();
  return (
    store.tokenRequests.find((request) => request.approvalInstanceCode === instanceCode) ??
    null
  );
}

export async function listUserTokenRequests(feishuUserId: string) {
  const store = await readStore();
  return store.tokenRequests
    .filter((request) => request.feishuUserId === feishuUserId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getActiveTokenForUser(feishuUserId: string) {
  const store = await readStore();
  return (
    store.tokenAccounts.find(
      (account) => account.feishuUserId === feishuUserId && account.status === "active",
    ) ?? null
  );
}

export async function findActiveTokenByHash(keyHash: string) {
  const store = await readStore();
  return (
    store.tokenAccounts.find(
      (account) => account.keyHash === keyHash && account.status === "active",
    ) ?? null
  );
}

export async function addTokenAccount(input: {
  feishuUserId: string;
  tokenRequestId: string;
  keyHash: string;
  newapiTokenId?: string;
  billingPeriod?: string;
}) {
  return mutate((store) => {
    const now = nowIso();
    const account: TokenAccount = {
      id: randomId("ta"),
      feishuUserId: input.feishuUserId,
      tokenRequestId: input.tokenRequestId,
      keyHash: input.keyHash,
      newapiTokenId: input.newapiTokenId,
      status: "active",
      billingPeriod: input.billingPeriod ?? now.slice(0, 7),
      createdAt: now,
    };
    store.tokenAccounts.push(account);
    return account;
  });
}

export async function addFeishuEvent(event: Omit<FeishuEvent, "id" | "createdAt">) {
  return mutate((store) => {
    const existing = store.feishuEvents.find(
      (item) => item.eventUuid === event.eventUuid,
    );
    if (existing) {
      Object.assign(existing, event);
      return existing;
    }

    const stored: FeishuEvent = {
      id: randomId("fe"),
      createdAt: nowIso(),
      ...event,
    };
    store.feishuEvents.push(stored);
    return stored;
  });
}

export async function getFeishuEventByUuid(eventUuid: string) {
  const store = await readStore();
  return store.feishuEvents.find((event) => event.eventUuid === eventUuid) ?? null;
}

export async function addProxyLog(log: Omit<ProxyRequestLog, "id" | "createdAt">) {
  return mutate((store) => {
    const stored: ProxyRequestLog = {
      id: randomId("pl"),
      createdAt: nowIso(),
      ...log,
    };
    store.proxyRequestLogs.push(stored);
    return stored;
  });
}
