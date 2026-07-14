import type { PoolClient } from "pg";
import { getConfig } from "./config.ts";
import { nowIso, randomId } from "./crypto.ts";
import type { NormalizedNewApiUsageLog } from "./newapi.ts";
import { stableNewApiUsageRecordId } from "./newapi-usage-identity.ts";
import { withPostgresAdvisoryLock, withPostgresClient, withPostgresTransaction } from "./postgres-store.ts";
import { findProxyLogForNewApiUsage } from "./usage-matching.ts";
import {
  invalidateProxyPrincipalCache,
  primeProxyPrincipalCache,
} from "./proxy-principal-cache.ts";
import type {
  AdminScope,
  FeishuEvent,
  FeishuUser,
  NewApiUsageRecord,
  ProxyRequestLog,
  TokenAccount,
  TokenStatus,
  UsageSyncCheckpoint,
  UsageSyncIssue,
  UsageSyncPolicy,
} from "./types.ts";

function activeUser(user?: FeishuUser | null) {
  return Boolean(user && (!user.status || user.status === "active"));
}

async function refreshProxyPrincipalCache(account: TokenAccount, user?: FeishuUser | null) {
  await invalidateProxyPrincipalCache(account.keyHash);
  if (account.status !== "active") return;
  const resolvedUser = user ?? await getUserById(account.feishuUserId);
  if (!resolvedUser || !activeUser(resolvedUser)) return;
  await primeProxyPrincipalCache(account.keyHash, {
    tokenAccount: account,
    user: resolvedUser,
  });
}

async function refreshProxyPrincipalCachesForUser(user: FeishuUser) {
  const accounts = await withPostgresClient(async (client) => {
    const result = await client.query<{ data: TokenAccount }>(
      "select data from token_accounts where feishu_user_id = $1",
      [user.id],
    );
    return result.rows.map((row) => row.data);
  });
  await Promise.all(accounts.map((account) => refreshProxyPrincipalCache(account, user)));
}

async function readData<T>(client: PoolClient, table: string, order = "id") {
  const result = await client.query<{ data: T }>(`select data from ${table} order by ${order}`);
  return result.rows.map((row) => row.data);
}

async function saveUser(client: PoolClient, user: FeishuUser) {
  const result = await client.query<{ data: FeishuUser }>(
    `insert into feishu_users
      (id, tenant_key, open_id, department_id, data, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (tenant_key, open_id) do update set
       department_id = excluded.department_id,
       data = excluded.data,
       updated_at = excluded.updated_at
     returning data`,
    [user.id, user.tenantKey, user.openId, user.departmentId ?? null, user, user.createdAt, user.updatedAt],
  );
  return result.rows[0].data;
}

async function saveToken(client: PoolClient, account: TokenAccount) {
  const result = await client.query<{ data: TokenAccount }>(
    `insert into token_accounts
      (id, feishu_user_id, source_request_id, newapi_token_id, key_hash,
       status, billing_period, data, created_at, disabled_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (id) do update set
       newapi_token_id = excluded.newapi_token_id,
       status = excluded.status,
       billing_period = excluded.billing_period,
       data = excluded.data,
       disabled_at = excluded.disabled_at
     returning data`,
    [
      account.id,
      account.feishuUserId,
      account.sourceRequestId,
      account.newapiTokenId ?? null,
      account.keyHash,
      account.status,
      account.billingPeriod,
      account,
      account.createdAt,
      account.disabledAt ?? null,
    ],
  );
  return result.rows[0].data;
}

async function saveAdminScope(client: PoolClient, scope: AdminScope) {
  const result = await client.query<{ data: AdminScope }>(
    `insert into admin_scopes
      (id, feishu_user_id, scope_type, department_id, source, status, data, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (id) do update set
       department_id = excluded.department_id,
       status = excluded.status,
       data = excluded.data,
       updated_at = excluded.updated_at
     returning data`,
    [scope.id, scope.feishuUserId, scope.scopeType, scope.departmentId ?? null, scope.source, scope.status, scope, scope.createdAt, scope.updatedAt],
  );
  return result.rows[0].data;
}

async function saveProxy(client: PoolClient, log: ProxyRequestLog) {
  const result = await client.query<{ data: ProxyRequestLog }>(
    `insert into proxy_request_logs
      (id, feishu_user_id, token_account_id, request_path, method, status_code, data, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (id) do update set
       feishu_user_id = excluded.feishu_user_id,
       token_account_id = excluded.token_account_id,
       status_code = excluded.status_code,
       data = excluded.data
     returning data`,
    [log.id, log.feishuUserId ?? null, log.tokenAccountId ?? null, log.requestPath, log.method, log.statusCode, log, log.createdAt],
  );
  return result.rows[0].data;
}

export async function getUserById(id: string) {
  return withPostgresClient(async (client) => {
    const result = await client.query<{ data: FeishuUser }>("select data from feishu_users where id = $1", [id]);
    return result.rows[0]?.data ?? null;
  });
}

export async function getUserByOpenId(openId: string) {
  return withPostgresClient(async (client) => {
    const result = await client.query<{ data: FeishuUser }>(
      "select data from feishu_users where open_id = $1 order by updated_at desc limit 1",
      [openId],
    );
    return result.rows[0]?.data ?? null;
  });
}

export async function upsertFeishuUser(input: Omit<FeishuUser, "id" | "createdAt" | "updatedAt">) {
  const user = await withPostgresTransaction(async (client) => {
    const existing = await client.query<{ data: FeishuUser }>(
      "select data from feishu_users where tenant_key = $1 and open_id = $2 for update",
      [input.tenantKey, input.openId],
    );
    const now = nowIso();
    const previous = existing.rows[0]?.data;
    return saveUser(client, {
      ...previous,
      ...input,
      id: previous?.id ?? randomId("fu"),
      status: previous?.status ?? "active",
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    });
  });
  await refreshProxyPrincipalCachesForUser(user);
  return user;
}

export async function getActiveTokenForUser(feishuUserId: string) {
  return withPostgresClient(async (client) => {
    const result = await client.query<{ data: TokenAccount }>(
      `select data from token_accounts
       where feishu_user_id = $1 and status = 'active'
       order by created_at desc, id desc limit 1`,
      [feishuUserId],
    );
    return result.rows[0]?.data ?? null;
  });
}

export async function getDisabledTokenForUser(feishuUserId: string) {
  return withPostgresClient(async (client) => {
    const result = await client.query<{ data: TokenAccount }>(
      `select data from token_accounts
       where feishu_user_id = $1 and status = 'disabled'
       order by created_at desc, id desc limit 1`,
      [feishuUserId],
    );
    return result.rows[0]?.data ?? null;
  });
}

export async function findActiveTokenByHash(keyHash: string) {
  return withPostgresClient(async (client) => {
    const result = await client.query<{ data: TokenAccount }>(
      "select data from token_accounts where key_hash = $1 and status = 'active' limit 1",
      [keyHash],
    );
    return result.rows[0]?.data ?? null;
  });
}

export async function findActiveTokenPrincipalByHash(keyHash: string) {
  return withPostgresClient(async (client) => {
    const result = await client.query<{
      token_account: TokenAccount;
      feishu_user: FeishuUser | null;
    }>(
      `select account.data as token_account, app_user.data as feishu_user
         from token_accounts account
         left join feishu_users app_user on app_user.id = account.feishu_user_id
        where account.key_hash = $1 and account.status = 'active'
        limit 1`,
      [keyHash],
    );
    const row = result.rows[0];
    return row
      ? { tokenAccount: row.token_account, user: row.feishu_user ?? null }
      : null;
  });
}

export async function addTokenAccount(input: {
  feishuUserId: string;
  sourceRequestId: string;
  keyHash: string;
  newapiTokenId?: string;
  billingPeriod?: string;
  status?: TokenStatus;
  operationGeneration?: number;
  activatedAt?: string;
  prewarmedAt?: string;
  prewarmDepartmentId?: string;
  prewarmedCredentialCiphertext?: string;
}) {
  const account = await withPostgresTransaction(async (client) => {
    const now = nowIso();
    return saveToken(client, {
      id: randomId("ta"),
      feishuUserId: input.feishuUserId,
      sourceRequestId: input.sourceRequestId,
      keyHash: input.keyHash,
      newapiTokenId: input.newapiTokenId,
      status: input.status ?? "active",
      billingPeriod: input.billingPeriod ?? now.slice(0, 7),
      operationGeneration: input.operationGeneration,
      activatedAt: input.activatedAt ?? (input.status && input.status !== "active" ? undefined : now),
      prewarmedAt: input.prewarmedAt,
      prewarmDepartmentId: input.prewarmDepartmentId,
      prewarmedCredentialCiphertext: input.prewarmedCredentialCiphertext,
      createdAt: now,
    });
  });
  await refreshProxyPrincipalCache(account);
  return account;
}

export async function updateTokenAccount(accountId: string, patch: Partial<TokenAccount>, allowedStatuses?: TokenStatus[]) {
  const account = await withPostgresTransaction(async (client) => {
    const result = await client.query<{ data: TokenAccount }>("select data from token_accounts where id = $1 for update", [accountId]);
    const account = result.rows[0]?.data;
    if (!account || (allowedStatuses && !allowedStatuses.includes(account.status))) return null;
    return saveToken(client, { ...account, ...patch, id: account.id, feishuUserId: account.feishuUserId, keyHash: account.keyHash });
  });
  if (account) await refreshProxyPrincipalCache(account);
  return account;
}

export async function finalizeTokenRotation(input: {
  feishuUserId: string;
  oldTokenAccountId: string;
  newTokenAccountId: string;
  operationGeneration: number;
  operationId: string;
}) {
  const result = await withPostgresTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`user-key:${input.feishuUserId}`]);
    const result = await client.query<{ data: TokenAccount }>(
      "select data from token_accounts where id = any($1::text[]) order by id for update",
      [[input.oldTokenAccountId, input.newTokenAccountId]],
    );
    const accounts = new Map(result.rows.map((row) => [row.data.id, row.data]));
    const oldAccount = accounts.get(input.oldTokenAccountId);
    const newAccount = accounts.get(input.newTokenAccountId);
    if (!oldAccount || !newAccount) throw new Error("Key 轮换本地账号记录不完整");
    const now = nowIso();
    const storedOld = await saveToken(client, { ...oldAccount, status: "replaced", disabledAt: now, replacedByTokenAccountId: newAccount.id });
    const storedNew = await saveToken(client, { ...newAccount, status: "active", operationGeneration: input.operationGeneration, activatedAt: now });
    return { oldAccount: storedOld, newAccount: storedNew };
  });
  await Promise.all([
    refreshProxyPrincipalCache(result.oldAccount),
    refreshProxyPrincipalCache(result.newAccount),
  ]);
  return result;
}

export function withUserKeyLifecycleLock<T>(feishuUserId: string, fn: () => Promise<T>) {
  return withPostgresAdvisoryLock(`user-key-fence:${feishuUserId}`, fn, { wait: true });
}

export async function getStoreSnapshot() {
  return withPostgresClient(async (client) => ({
    users: await readData<FeishuUser>(client, "feishu_users", "created_at, id"),
    tokenAccounts: await readData<TokenAccount>(client, "token_accounts", "created_at, id"),
  }));
}

export async function addFeishuEvent(event: Omit<FeishuEvent, "id" | "createdAt">) {
  return withPostgresTransaction(async (client) => {
    const existing = await client.query<{ data: FeishuEvent }>("select data from feishu_events where event_uuid = $1 for update", [event.eventUuid]);
    const stored: FeishuEvent = existing.rows[0]?.data
      ? { ...existing.rows[0].data, ...event }
      : { id: randomId("fe"), createdAt: nowIso(), ...event };
    const result = await client.query<{ data: FeishuEvent }>(
      `insert into feishu_events
        (id, event_uuid, event_type, instance_code, card_request_id, processing_status, data, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (event_uuid) do update set
         event_type = excluded.event_type,
         instance_code = excluded.instance_code,
         card_request_id = excluded.card_request_id,
         processing_status = excluded.processing_status,
         data = excluded.data
       returning data`,
      [stored.id, stored.eventUuid, stored.eventType ?? null, stored.instanceCode ?? null, stored.cardRequestId ?? null, stored.processingStatus, stored, stored.createdAt],
    );
    return result.rows[0].data;
  });
}

export async function getFeishuEventByUuid(eventUuid: string) {
  return withPostgresClient(async (client) => {
    const result = await client.query<{ data: FeishuEvent }>("select data from feishu_events where event_uuid = $1", [eventUuid]);
    return result.rows[0]?.data ?? null;
  });
}

export async function addProxyLog(log: Omit<ProxyRequestLog, "id" | "createdAt">) {
  return withPostgresTransaction(async (client) => {
    const now = nowIso();
    return saveProxy(client, {
      id: randomId("pl"), createdAt: now, updatedAt: now, ...log,
      status: log.status ?? (log.statusCode === 499 ? "cancelled" : log.statusCode >= 400 ? "failed" : "completed"),
    });
  });
}

export async function beginProxyLog(
  log: Omit<ProxyRequestLog, "id" | "createdAt" | "statusCode" | "durationMs"> &
    Partial<Pick<ProxyRequestLog, "statusCode" | "durationMs">>,
  identity?: { id: string; createdAt: string },
) {
  return withPostgresTransaction(async (client) => {
    const now = identity?.createdAt ?? nowIso();
    return saveProxy(client, {
      id: identity?.id ?? randomId("pl"), createdAt: now, updatedAt: now,
      statusCode: log.statusCode ?? 0, durationMs: log.durationMs ?? 0, ...log, status: log.status ?? "pending",
    });
  });
}

export async function updateProxyLog(id: string, patch: Partial<Omit<ProxyRequestLog, "id" | "createdAt">>) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{ data: ProxyRequestLog }>("select data from proxy_request_logs where id = $1 for update", [id]);
    const existing = result.rows[0]?.data;
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: nowIso() };
    if (updated.totalTokens === undefined && updated.promptTokens !== undefined && updated.completionTokens !== undefined) {
      updated.totalTokens = updated.promptTokens + updated.completionTokens;
    }
    return saveProxy(client, updated);
  });
}

export async function listInflightProxyRequests(feishuUserId: string, operationGeneration: number, at = nowIso()) {
  return withPostgresClient(async (client) => {
    const logs = await readData<ProxyRequestLog>(client, "proxy_request_logs", "created_at, id");
    return logs.filter((log) =>
      log.feishuUserId === feishuUserId &&
      (log.operationGeneration ?? 0) === operationGeneration &&
      (log.status === "pending" || log.status === "streaming") &&
      (!log.leaseExpiresAt || log.leaseExpiresAt > at));
  });
}

function environmentAdminScope(user: FeishuUser): AdminScope | null {
  if (!getConfig().admin.systemAdminOpenIds.includes(user.openId)) return null;
  const now = nowIso();
  return { id: `env-admin-${user.id}`, feishuUserId: user.id, scopeType: "global", source: "environment", role: "root", status: "active", createdAt: now, updatedAt: now };
}

export async function getAdminScopeForUser(feishuUserId: string) {
  const user = await getUserById(feishuUserId);
  if (!activeUser(user)) return null;
  const environment = environmentAdminScope(user!);
  if (environment) return environment;
  return withPostgresClient(async (client) => {
    const result = await client.query<{ data: AdminScope }>(
      "select data from admin_scopes where feishu_user_id = $1 and status = 'active' order by updated_at desc limit 1",
      [feishuUserId],
    );
    return result.rows[0]?.data ?? null;
  });
}

export async function syncDepartmentSupervisorAdminScope(input: { feishuUserId: string; departmentId: string; isSupervisor: boolean }) {
  return withPostgresTransaction(async (client) => {
    const existing = await client.query<{ data: AdminScope }>(
      `select data from admin_scopes
       where feishu_user_id = $1 and source = 'department_supervisor' and department_id = $2
       order by updated_at desc limit 1 for update`,
      [input.feishuUserId, input.departmentId],
    );
    const now = nowIso();
    const current = existing.rows[0]?.data;
    if (!input.isSupervisor) {
      return current ? saveAdminScope(client, { ...current, status: "disabled", disabledReason: "auto_sync_lost", disabledAt: now, updatedAt: now }) : null;
    }
    return saveAdminScope(client, {
      ...current,
      id: current?.id ?? randomId("as"),
      feishuUserId: input.feishuUserId,
      scopeType: "department",
      departmentId: input.departmentId,
      source: "department_supervisor",
      status: "active",
      disabledReason: undefined,
      disabledAt: undefined,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    });
  });
}

export async function listAdminScopes() {
  const [users, scopes] = await withPostgresClient(async (client) => Promise.all([
    readData<FeishuUser>(client, "feishu_users", "created_at, id"),
    readData<AdminScope>(client, "admin_scopes", "created_at, id"),
  ]));
  const usersById = new Map(users.map((user) => [user.id, user]));
  const stored = scopes.map((scope) => ({ ...scope, user: usersById.get(scope.feishuUserId) ?? null, readonly: false }));
  const synthetic = getConfig().admin.systemAdminOpenIds.map((openId) => {
    const user = users.find((item) => item.openId === openId);
    const now = nowIso();
    return {
      id: `env-admin-${user?.id ?? openId}`,
      feishuUserId: user?.id ?? `open_id:${openId}`,
      scopeType: "global" as const,
      source: "environment" as const,
      role: "root" as const,
      status: "active" as const,
      configuredOpenId: openId,
      readonly: true,
      user: user ?? null,
      createdAt: now,
      updatedAt: now,
    };
  });
  return [...synthetic, ...stored];
}

export async function getAdminScopeById(id: string) {
  if (id.startsWith("env-admin-")) return (await listAdminScopes()).find((scope) => scope.id === id) ?? null;
  return withPostgresClient(async (client) => {
    const result = await client.query<{ data: AdminScope }>("select data from admin_scopes where id = $1", [id]);
    return result.rows[0]?.data ?? null;
  });
}

export async function upsertManualAdminScope(input: { targetOpenId: string; scopeType: AdminScope["scopeType"]; departmentId?: string }) {
  return withPostgresTransaction(async (client) => {
    const userResult = await client.query<{ data: FeishuUser }>("select data from feishu_users where open_id = $1 order by updated_at desc limit 1 for update", [input.targetOpenId]);
    const user = userResult.rows[0]?.data;
    if (!user) return { scope: null, error: "target_user_not_found" as const };
    const existing = await client.query<{ data: AdminScope }>(
      `select data from admin_scopes where feishu_user_id = $1 and source = 'manual'
       and scope_type = $2 and department_id is not distinct from $3 order by updated_at desc limit 1 for update`,
      [user.id, input.scopeType, input.departmentId ?? null],
    );
    const now = nowIso();
    const current = existing.rows[0]?.data;
    const scope = await saveAdminScope(client, {
      ...current,
      id: current?.id ?? randomId("as"),
      feishuUserId: user.id,
      scopeType: input.scopeType,
      departmentId: input.scopeType === "department" ? input.departmentId : undefined,
      source: "manual",
      status: "active",
      disabledReason: undefined,
      disabledAt: undefined,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    });
    return { scope, error: undefined };
  });
}

export async function updateManualAdminScope(input: { scopeId: string; status?: AdminScope["status"]; departmentId?: string }) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{ data: AdminScope }>("select data from admin_scopes where id = $1 and source = 'manual' for update", [input.scopeId]);
    const scope = result.rows[0]?.data;
    if (!scope) return null;
    const now = nowIso();
    return saveAdminScope(client, { ...scope, status: input.status ?? scope.status, departmentId: scope.scopeType === "department" ? input.departmentId ?? scope.departmentId : undefined, disabledAt: input.status === "disabled" ? now : undefined, updatedAt: now });
  });
}

export async function revokeAdminScopesForUser(input: { feishuUserId: string; reason: NonNullable<AdminScope["disabledReason"]>; disabledByFeishuUserId?: string }) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{ data: AdminScope }>("select data from admin_scopes where feishu_user_id = $1 and source <> 'environment' for update", [input.feishuUserId]);
    const now = nowIso();
    return Promise.all(result.rows.map((row) => saveAdminScope(client, { ...row.data, status: "disabled", disabledReason: input.reason, disabledByFeishuUserId: input.disabledByFeishuUserId, disabledAt: now, updatedAt: now })));
  });
}

export async function getScopedUser(scope: AdminScope, userId: string) {
  const user = await getUserById(userId);
  if (!user) return null;
  if (scope.scopeType === "department" && user.departmentId !== scope.departmentId) return null;
  return user;
}

function roleForUser(user: FeishuUser, scopes: AdminScope[]) {
  if (getConfig().admin.systemAdminOpenIds.includes(user.openId)) return "root";
  const scope = scopes.find((item) => item.feishuUserId === user.id && item.status === "active");
  return scope?.scopeType === "global" ? "system_admin" : scope ? "department_supervisor" : "user";
}

export async function listAdminUsers(scope: AdminScope) {
  return withPostgresClient(async (client) => {
    const [users, accounts, scopes, logs] = await Promise.all([
      readData<FeishuUser>(client, "feishu_users", "created_at, id"),
      readData<TokenAccount>(client, "token_accounts", "created_at, id"),
      readData<AdminScope>(client, "admin_scopes", "created_at, id"),
      readData<ProxyRequestLog>(client, "proxy_request_logs", "created_at, id"),
    ]);
    return users
      .filter((user) => scope.scopeType === "global" || user.departmentId === scope.departmentId)
      .map((user) => {
        const latestAccount = accounts.filter((item) => item.feishuUserId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        const latestLog = logs.filter((item) => item.feishuUserId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        return { id: user.id, name: user.name, openId: user.openId, departmentId: user.departmentId, departmentName: user.departmentName, status: user.status ?? "active", role: roleForUser(user, scopes), activeTokenStatus: latestAccount?.status, activeTokenCreatedAt: latestAccount?.createdAt, latestProxyLogAt: latestLog?.createdAt, updatedAt: user.updatedAt, createdAt: user.createdAt };
      })
      .sort((a, b) => (b.latestProxyLogAt ?? b.updatedAt).localeCompare(a.latestProxyLogAt ?? a.updatedAt));
  });
}

export async function updateUserAccessStatus(input: { feishuUserId: string; status: "disabled" | "deleted"; reason: string; tokenStatus: TokenStatus; adminRevokedByFeishuUserId?: string }) {
  const result = await withPostgresTransaction(async (client) => {
    const userResult = await client.query<{ data: FeishuUser }>("select data from feishu_users where id = $1 for update", [input.feishuUserId]);
    const user = userResult.rows[0]?.data;
    if (!user) return null;
    const tokenResult = await client.query<{ data: TokenAccount }>("select data from token_accounts where feishu_user_id = $1 and status = 'active' order by created_at desc limit 1 for update", [user.id]);
    const now = nowIso();
    const storedUser = await saveUser(client, { ...user, status: input.status, disabledAt: now, disabledReason: input.reason, updatedAt: now });
    const token = tokenResult.rows[0]?.data;
    const storedToken = token ? await saveToken(client, { ...token, status: input.tokenStatus, disabledAt: now }) : null;
    if (input.status === "deleted") {
      const scopes = await client.query<{ data: AdminScope }>("select data from admin_scopes where feishu_user_id = $1 for update", [user.id]);
      for (const row of scopes.rows) await saveAdminScope(client, { ...row.data, status: "disabled", disabledReason: "user_deleted", disabledByFeishuUserId: input.adminRevokedByFeishuUserId, disabledAt: now, updatedAt: now });
    }
    return { user: storedUser, tokenAccount: storedToken };
  });
  if (result) await refreshProxyPrincipalCachesForUser(result.user);
  return result;
}

export async function enableUserAccess(input: { feishuUserId: string; reason: string }) {
  const result = await withPostgresTransaction(async (client) => {
    const userResult = await client.query<{ data: FeishuUser }>("select data from feishu_users where id = $1 and data->>'status' = 'disabled' for update", [input.feishuUserId]);
    const tokenResult = await client.query<{ data: TokenAccount }>("select data from token_accounts where feishu_user_id = $1 and status = 'disabled' order by created_at desc limit 1 for update", [input.feishuUserId]);
    const user = userResult.rows[0]?.data;
    const token = tokenResult.rows[0]?.data;
    if (!user || !token) return null;
    const now = nowIso();
    return {
      user: await saveUser(client, { ...user, status: "active", disabledAt: undefined, disabledReason: undefined, updatedAt: now }),
      tokenAccount: await saveToken(client, { ...token, status: "active", disabledAt: undefined }),
    };
  });
  if (result) await refreshProxyPrincipalCache(result.tokenAccount, result.user);
  return result;
}

type UsageFilters = {
  userId?: string; departmentId?: string; model?: string; provider?: string; apiFormat?: string;
  status?: string; userAgent?: string; clientFamily?: string; search?: string; preset?: string;
  startDate?: string; endDate?: string; hideUnknownRecords?: boolean; limit?: number; offset?: number;
};

function filterUsage(log: ProxyRequestLog, filters: UsageFilters) {
  if (filters.userId && log.feishuUserId !== filters.userId) return false;
  if (filters.departmentId && log.departmentId !== filters.departmentId) return false;
  if (filters.model && log.model !== filters.model) return false;
  if (filters.provider && log.provider !== filters.provider) return false;
  if (filters.apiFormat && log.apiFormat !== filters.apiFormat) return false;
  if (filters.userAgent && log.userAgent !== filters.userAgent) return false;
  if (filters.clientFamily && log.clientFamily !== filters.clientFamily) return false;
  if (filters.status && filters.status !== "__all__") {
    const status = log.status ?? (log.statusCode >= 400 ? "failed" : "completed");
    if (filters.status === "stream" ? !log.isStream : filters.status === "standard" ? log.isStream : status !== filters.status) return false;
  }
  if (filters.hideUnknownRecords && (!log.model || log.model === "unknown")) return false;
  if (filters.search) {
    const needle = filters.search.toLowerCase();
    if (![log.model, log.providerKeyName, log.requestPath, log.userAgent].some((value) => value?.toLowerCase().includes(needle))) return false;
  }
  const created = new Date(log.createdAt).getTime();
  if (filters.startDate && created < new Date(filters.startDate).getTime()) return false;
  if (filters.endDate && created > new Date(filters.endDate).getTime()) return false;
  if (filters.preset && filters.preset !== "__all__") {
    const now = new Date();
    const days = filters.preset === "today" ? 0 : filters.preset === "yesterday" ? 1 : filters.preset === "last7days" ? 7 : filters.preset === "last30days" ? 30 : filters.preset === "last90days" ? 90 : undefined;
    if (days !== undefined) {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).getTime();
      const end = filters.preset === "yesterday" ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() : Number.POSITIVE_INFINITY;
      if (created < start || created >= end) return false;
    }
  }
  return true;
}

function usageFilterOptions(logs: ProxyRequestLog[]) {
  const unique = (values: Array<string | undefined>) => [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
  return { models: unique(logs.map((log) => log.model)), providers: unique(logs.map((log) => log.provider)), apiFormats: unique(logs.map((log) => log.apiFormat)), clientFamilies: unique(logs.map((log) => log.clientFamily)), userAgents: unique(logs.map((log) => log.userAgent)) };
}

export async function listUserUsageReport(input: UsageFilters & { feishuUserId: string }) {
  return withPostgresClient(async (client) => {
    const all = (await readData<ProxyRequestLog>(client, "proxy_request_logs", "created_at desc, id desc")).filter((log) => log.feishuUserId === input.feishuUserId);
    const filtered = all.filter((log) => filterUsage(log, input));
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const offset = Math.max(input.offset ?? 0, 0);
    return { records: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset, filters: usageFilterOptions(all), modelStats: [], apiFormatStats: [] };
  });
}

export async function listAdminUsageRecords(input: UsageFilters & { scope: AdminScope }) {
  return withPostgresClient(async (client) => {
    const [logs, users] = await Promise.all([
      readData<ProxyRequestLog>(client, "proxy_request_logs", "created_at desc, id desc"),
      readData<FeishuUser>(client, "feishu_users", "created_at, id"),
    ]);
    const usersById = new Map(users.map((user) => [user.id, user]));
    const scoped = logs.filter((log) => input.scope.scopeType === "global" || log.departmentId === input.scope.departmentId);
    const filtered = scoped.filter((log) => filterUsage(log, input));
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const offset = Math.max(input.offset ?? 0, 0);
    const records = filtered.slice(offset, offset + limit).map((log) => {
      const user = log.feishuUserId ? usersById.get(log.feishuUserId) : undefined;
      return { ...log, userName: user?.name, userOpenId: user?.openId, departmentName: log.departmentName ?? user?.departmentName };
    });
    return {
      records, total: filtered.length, limit, offset, filters: usageFilterOptions(scoped), modelStats: [], apiFormatStats: [],
      users: users.filter((user) => input.scope.scopeType === "global" || user.departmentId === input.scope.departmentId).map((user) => ({ id: user.id, label: user.name ?? user.openId })),
      departments: [...new Map(users.filter((user) => user.departmentId).map((user) => [user.departmentId!, { id: user.departmentId!, label: user.departmentName ?? user.departmentId! }])).values()],
    };
  });
}

export function defaultUsageSyncPolicy(): UsageSyncPolicy {
  return { enabled: false, intervalMinutes: 60, pageSize: 100, maxPagesPerRun: 3, overlapMinutes: 120, settlementLagMinutes: 5, matchWindowMinutes: 30, retryBaseMinutes: 5 };
}

export async function getAppSettings() {
  return withPostgresClient(async (client) => {
    const result = await client.query<{ data: { usageSyncPolicy?: UsageSyncPolicy } }>("select data from app_settings where id = 'default'");
    return result.rows[0]?.data ?? {};
  });
}

export async function getUsageSyncCheckpoint() {
  return withPostgresClient(async (client) => {
    const result = await client.query<{ data: UsageSyncCheckpoint }>("select data from usage_sync_checkpoints where scope = 'newapi_usage_logs'");
    return result.rows[0]?.data ?? null;
  });
}

export async function saveUsageSyncCheckpoint(input: Omit<UsageSyncCheckpoint, "id" | "updatedAt"> & Partial<Pick<UsageSyncCheckpoint, "id" | "updatedAt">>) {
  return withPostgresTransaction(async (client) => {
    const stored: UsageSyncCheckpoint = { ...input, id: input.id ?? "newapi_usage_logs", updatedAt: input.updatedAt ?? nowIso() } as UsageSyncCheckpoint;
    const result = await client.query<{ data: UsageSyncCheckpoint }>(
      `insert into usage_sync_checkpoints (id, scope, data, updated_at)
       values ($1,$2,$3,$4)
       on conflict (scope) do update set data = excluded.data, updated_at = excluded.updated_at
       returning data`,
      [stored.id, stored.scope, stored, stored.updatedAt],
    );
    return result.rows[0].data;
  });
}

export type NewApiUsageBackfillItem = {
  action: "updated" | "matched_no_change" | "skipped_unknown_token" | "skipped_no_match";
  newapiLogId?: string; newapiRequestId?: string; newapiTokenId?: string; proxyLogId?: string;
  feishuUserId?: string; tokenAccountId?: string; usageRecordId?: string; issueId?: string;
  cost?: number; quota?: number; reason?: string;
};

export type NewApiUsageBackfillResult = {
  dryRun: boolean; seen: number; matched: number; updated: number; skippedUnknownToken: number;
  skippedNoMatch: number; recordsUpserted: number; issuesUpserted: number; items: NewApiUsageBackfillItem[];
};

function usageIdentity(log: NormalizedNewApiUsageLog) {
  if (log.newapiTokenId && log.newapiRequestId) return `request:${log.newapiTokenId}:${log.newapiRequestId}`;
  if (log.newapiTokenId && log.newapiLogId) return `log:${log.newapiTokenId}:${log.newapiLogId}`;
  return undefined;
}

async function saveUsageRecord(client: PoolClient, record: NewApiUsageRecord) {
  const result = await client.query<{ data: NewApiUsageRecord }>(
    `insert into newapi_usage_records
      (id, newapi_log_id, newapi_request_id, newapi_token_id, token_account_id,
       feishu_user_id, match_status, data, newapi_created_at, first_seen_at, last_synced_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (id) do update set
       match_status = case when newapi_usage_records.match_status = 'matched' then newapi_usage_records.match_status else excluded.match_status end,
       token_account_id = case when newapi_usage_records.match_status = 'matched' then newapi_usage_records.token_account_id else excluded.token_account_id end,
       feishu_user_id = case when newapi_usage_records.match_status = 'matched' then newapi_usage_records.feishu_user_id else excluded.feishu_user_id end,
       data = case when newapi_usage_records.match_status = 'matched' then newapi_usage_records.data else excluded.data end,
       last_synced_at = excluded.last_synced_at
     returning data`,
    [record.id, record.newapiLogId ?? null, record.newapiRequestId ?? null, record.newapiTokenId ?? null, record.tokenAccountId ?? null, record.feishuUserId ?? null, record.matchStatus, record, record.newapiCreatedAt ?? null, record.firstSeenAt, record.lastSyncedAt],
  );
  return result.rows[0].data;
}

export async function backfillProxyLogsFromNewApiUsage(
  usageLogs: NormalizedNewApiUsageLog[],
  options: { dryRun?: boolean; matchWindowMs?: number; persistUnmatched?: boolean; reservedProxyLogIds?: string[]; targetProxyLogIds?: string[] } = {},
): Promise<NewApiUsageBackfillResult> {
  const dryRun = options.dryRun ?? true;
  return withPostgresTransaction(async (client) => {
    const [accounts, proxyLogs, existingUsageRecords] = await Promise.all([
      readData<TokenAccount>(client, "token_accounts", "created_at, id"),
      readData<ProxyRequestLog>(client, "proxy_request_logs", "created_at, id"),
      readData<NewApiUsageRecord>(client, "newapi_usage_records", "first_seen_at, id"),
    ]);
    const usageRecordsById = new Map(existingUsageRecords.map((record) => [record.id, record]));
    const reserved = new Set(options.reservedProxyLogIds ?? []);
    const targets = options.targetProxyLogIds ? new Set(options.targetProxyLogIds) : undefined;
    const result: NewApiUsageBackfillResult = { dryRun, seen: usageLogs.length, matched: 0, updated: 0, skippedUnknownToken: 0, skippedNoMatch: 0, recordsUpserted: 0, issuesUpserted: 0, items: [] };
    for (const usage of usageLogs) {
      const identity = usageIdentity(usage);
      if (!identity) {
        result.skippedNoMatch += 1;
        result.items.push({ action: "skipped_no_match", reason: "missing_source_identity" });
        continue;
      }
      const usageRecordId = stableNewApiUsageRecordId(identity);
      const existingUsageRecord = usageRecordsById.get(usageRecordId);
      if (existingUsageRecord?.matchStatus === "matched" && existingUsageRecord.matchedProxyLogId) {
        result.matched += 1;
        result.items.push({
          action: "matched_no_change",
          newapiLogId: existingUsageRecord.newapiLogId,
          newapiRequestId: existingUsageRecord.newapiRequestId,
          newapiTokenId: existingUsageRecord.newapiTokenId,
          proxyLogId: existingUsageRecord.matchedProxyLogId,
          feishuUserId: existingUsageRecord.feishuUserId,
          tokenAccountId: existingUsageRecord.tokenAccountId,
          cost: existingUsageRecord.cost,
          quota: existingUsageRecord.quota,
        });
        continue;
      }
      const account = accounts.find((item) => item.newapiTokenId === usage.newapiTokenId);
      if (!account) {
        result.skippedUnknownToken += 1;
        result.items.push({ action: "skipped_unknown_token", newapiLogId: usage.newapiLogId, newapiRequestId: usage.newapiRequestId, newapiTokenId: usage.newapiTokenId, reason: "unknown_token" });
        continue;
      }
      const proxy = findProxyLogForNewApiUsage({ proxyLogs, usageLog: usage, account, matchWindowMs: options.matchWindowMs ?? 30 * 60_000, reservedProxyLogIds: reserved, targetProxyLogIds: targets });
      if (!proxy) {
        result.skippedNoMatch += 1;
        result.items.push({ action: "skipped_no_match", newapiLogId: usage.newapiLogId, newapiRequestId: usage.newapiRequestId, newapiTokenId: usage.newapiTokenId, tokenAccountId: account.id, feishuUserId: account.feishuUserId, reason: "no_proxy_match" });
        continue;
      }
      reserved.add(proxy.id);
      const syncedAt = nowIso();
      const record: NewApiUsageRecord = {
        id: usageRecordId,
        newapiLogId: usage.newapiLogId,
        newapiRequestId: usage.newapiRequestId,
        newapiTokenId: usage.newapiTokenId,
        tokenAccountId: account.id,
        feishuUserId: account.feishuUserId,
        departmentId: proxy.departmentId,
        departmentName: proxy.departmentName,
        matchedProxyLogId: proxy.id,
        matchStatus: "matched",
        model: usage.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        inputTokensTotal: usage.inputTokensTotal,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        cacheCreationTokens5m: usage.cacheCreationTokens5m,
        cacheCreationTokens1h: usage.cacheCreationTokens1h,
        usageSemantic: usage.usageSemantic,
        usageFieldSources: usage.usageFieldSources,
        quota: usage.quota,
        cost: usage.cost,
        actualCost: usage.actualCost,
        isStream: usage.isStream,
        newapiType: usage.type,
        newapiUpstreamRequestId: usage.newapiUpstreamRequestId,
        providerChannelName: usage.providerChannelName,
        newapiUseTimeSeconds: usage.newapiUseTimeSeconds,
        newapiCreatedAt: usage.createdAt,
        firstSeenAt: syncedAt,
        lastSyncedAt: syncedAt,
      };
      if (!dryRun) {
        const savedRecord = await saveUsageRecord(client, record);
        usageRecordsById.set(usageRecordId, savedRecord);
        await saveProxy(client, {
          ...proxy,
          promptTokens: usage.promptTokens ?? proxy.promptTokens,
          completionTokens: usage.completionTokens ?? proxy.completionTokens,
          totalTokens: usage.totalTokens ?? proxy.totalTokens,
          inputTokensTotal: usage.inputTokensTotal ?? proxy.inputTokensTotal,
          cacheReadTokens: usage.cacheReadTokens ?? proxy.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens ?? proxy.cacheCreationTokens,
          quota: usage.quota,
          cost: usage.cost,
          actualCost: usage.actualCost,
          newapiLogId: usage.newapiLogId,
          newapiRequestId: usage.newapiRequestId ?? proxy.newapiRequestId,
          newapiUpstreamRequestId: usage.newapiUpstreamRequestId,
          providerChannelName: usage.providerChannelName,
          newapiUseTimeSeconds: usage.newapiUseTimeSeconds,
          usageSource: "newapi_log",
          usageSyncedAt: syncedAt,
          updatedAt: syncedAt,
        });
      }
      result.matched += 1;
      result.updated += dryRun ? 0 : 1;
      result.recordsUpserted += dryRun ? 0 : 1;
      result.items.push({ action: dryRun ? "matched_no_change" : "updated", newapiLogId: usage.newapiLogId, newapiRequestId: usage.newapiRequestId, newapiTokenId: usage.newapiTokenId, proxyLogId: proxy.id, feishuUserId: account.feishuUserId, tokenAccountId: account.id, usageRecordId, cost: usage.cost, quota: usage.quota });
    }
    if (dryRun) await client.query("rollback").catch(() => undefined);
    return result;
  });
}
