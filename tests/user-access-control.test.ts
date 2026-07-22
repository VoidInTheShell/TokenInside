import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { canCancelQuotaOperationForAccessRevoke } from "../lib/quota-saga-state.ts";
import {
  isCompletedUserAccessResume,
  isPendingUserAccessResume,
  preserveUserAccessRevocationBarrier,
  shouldRestoreIssuedUpstreamAfterFailedAccessRevoke,
} from "../lib/user-access-state.ts";

const accessPath = new URL("../lib/user-access-control.ts", import.meta.url);
const postgresPath = new URL("../lib/postgres-store.ts", import.meta.url);
const storePath = new URL("../lib/store.ts", import.meta.url);
const sagaPath = new URL("../lib/quota-saga.ts", import.meta.url);
const submitPath = new URL("../lib/quota-operation-submit.ts", import.meta.url);
const detailRoutePath = new URL("../app/api/quota-operations/[id]/route.ts", import.meta.url);
const experiencePath = new URL("../components/experience-client.tsx", import.meta.url);
const deleteRoutePath = new URL("../app/api/admin/users/[id]/route.ts", import.meta.url);
const disableRoutePath = new URL("../app/api/admin/users/[id]/disable/route.ts", import.meta.url);
const enableRoutePath = new URL("../app/api/admin/users/[id]/enable/route.ts", import.meta.url);
const quotaAdjustRoutePath = new URL(
  "../app/api/admin/users/[id]/quota-adjust/route.ts",
  import.meta.url,
);
const adminUsersPath = new URL("../components/admin-client.tsx", import.meta.url);
const adminAssignmentRoutePath = new URL("../app/api/admin/admins/route.ts", import.meta.url);
const instrumentationPath = new URL("../instrumentation.ts", import.meta.url);
const baselinePath = new URL("../scripts/db-migrate.mjs", import.meta.url);

type UserAccessApi = {
  suspendUserAccess(input: Record<string, unknown>): Promise<unknown>;
  resumeUserAccess(input: Record<string, unknown>): Promise<unknown>;
  recoverStaleUserAccessResumesOnce(input?: Record<string, unknown>): Promise<{
    scanned: number;
    rolledBack: number;
    failed: number;
  }>;
};

async function loadUserAccessHarness(input: {
  store: Record<string, unknown>;
  newapi: Record<string, unknown>;
  nowIso?: () => string;
}) {
  const source = await readFile(accessPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: "user-access-control.ts",
  }).outputText;
  const module = { exports: {} as UserAccessApi };
  const imports: Record<string, Record<string, unknown>> = {
    "@/lib/newapi": input.newapi,
    "@/lib/store": {
      markUserAccessResumeEnableAttemptUnderUserFence: async () => ({
        marked: true,
      }),
      ...input.store,
    },
    "@/lib/config": {
      getConfig: () => ({
        quotaControl: { directConsumptionDrainGraceMs: 60_000 },
      }),
    },
    "@/lib/crypto": {
      nowIso: input.nowIso ?? (() => "2099-01-01T00:00:00.000Z"),
    },
    "@/lib/postgres-store": {
      assertAdminScopeAllowsUserTarget: () => undefined,
      isAdminUserActionAuthorizationError: (error: unknown) =>
        error instanceof Error && error.name === "AdminUserActionAuthorizationError",
    },
    "@/lib/user-access-state": {
      isCompletedUserAccessResume,
      isPendingUserAccessResume,
      shouldRestoreIssuedUpstreamAfterFailedAccessRevoke,
    },
  };
  runInNewContext(transpiled, {
    module,
    exports: module.exports,
    require: (specifier: string) => {
      const dependency = imports[specifier];
      if (!dependency) throw new Error(`unexpected user-access import: ${specifier}`);
      return dependency;
    },
    console,
    setTimeout,
    clearTimeout,
  });
  return module.exports;
}

test("access revoke only cancels pre-write operations and quarantines uncertain phases", () => {
  const base = {
    upstreamTokenIdAfter: undefined,
    tokenAccountIdAfter: undefined,
    evidence: {},
  };
  assert.equal(
    canCancelQuotaOperationForAccessRevoke({ ...base, state: "draining" }),
    true,
  );
  assert.equal(
    canCancelQuotaOperationForAccessRevoke({
      ...base,
      state: "retryable_failed",
      evidence: { retryFromState: "planned" },
    }),
    true,
  );
  assert.equal(
    canCancelQuotaOperationForAccessRevoke({
      ...base,
      state: "upstream_applying",
      evidence: { upstreamBalanceWriteAttemptedAt: "2026-07-18T00:00:00.000Z" },
    }),
    false,
  );
  assert.equal(
    canCancelQuotaOperationForAccessRevoke({
      ...base,
      state: "manual_review",
      evidence: { retryFromState: "upstream_applied" },
    }),
    false,
  );
});

test("repeated delete preserves the original direct-consumption cutoff", () => {
  const first = preserveUserAccessRevocationBarrier(
    {
      upstreamDisabledAt: "2026-07-18T01:00:00.000Z",
      consumptionBarrierCutoffAt: "2026-07-18T01:01:00.000Z",
    },
    undefined,
  );
  const repeated = preserveUserAccessRevocationBarrier(
    {},
    { ...first, closedReason: "user_access_revoked" },
  );
  assert.deepEqual(repeated, first);
  assert.deepEqual(
    preserveUserAccessRevocationBarrier(
      {},
      { ...first, closedReason: "quota_operation" },
    ),
    {
      upstreamDisabledAt: undefined,
      consumptionBarrierCutoffAt: undefined,
    },
  );
});

test("failed multi-key revoke recovery never restores after local revoke commits", () => {
  assert.equal(
    shouldRestoreIssuedUpstreamAfterFailedAccessRevoke({
      user: { status: "active" },
      quotaState: { admission: "open" },
    }),
    true,
  );
  assert.equal(
    shouldRestoreIssuedUpstreamAfterFailedAccessRevoke({
      user: { status: "active" },
      quotaState: {
        admission: "closed",
        closedReason: "user_access_revoked",
      },
    }),
    false,
  );
  assert.equal(
    shouldRestoreIssuedUpstreamAfterFailedAccessRevoke({
      user: { status: "disabled" },
      quotaState: { admission: "closed", closedReason: "quota_operation" },
    }),
    false,
  );
});

test("resume recovery distinguishes pending CAS from a completed open state", () => {
  assert.equal(
    isPendingUserAccessResume({
      user: { status: "active" },
      accountStatus: "active",
      quotaState: {
        admission: "closed",
        closedReason: "user_access_resume_pending",
      },
    }),
    true,
  );
  assert.equal(
    isPendingUserAccessResume({
      user: { status: "active" },
      accountStatus: "active",
      quotaState: { admission: "open" },
    }),
    false,
  );
  assert.equal(
    isCompletedUserAccessResume({
      user: { status: "active" },
      accountStatus: "active",
      quotaState: { admission: "open" },
    }),
    true,
  );
});

test("multi-key suspend failure restores attempted issued keys under a fresh fence", async () => {
  const user = {
    id: "user-1",
    openId: "open-user-1",
    status: "active" as const,
  };
  const quotaState = {
    feishuUserId: user.id,
    admission: "open" as const,
    activeGeneration: 1,
    updatedAt: "2099-01-01T00:00:00.000Z",
  };
  const accounts = [
    {
      id: "account-1",
      feishuUserId: user.id,
      newapiTokenId: "upstream-1",
      status: "active" as const,
      createdAt: "2099-01-01T00:00:00.000Z",
    },
    {
      id: "account-2",
      feishuUserId: user.id,
      newapiTokenId: "upstream-2",
      status: "active" as const,
      createdAt: "2099-01-01T00:00:01.000Z",
    },
  ];
  const fences: string[] = [];
  const enabled: string[] = [];
  let disableCalls = 0;
  const api = await loadUserAccessHarness({
    store: {
      withAdminScopeUserLocks: async (_ids: string[], fn: () => Promise<unknown>) => fn(),
      authorizeAdminUserActionUnderScopeLocks: async () => ({ targetUser: user }),
      withUserQuotaOperationLock: async (
        _id: string,
        fn: (fence: { assertHeld(): void }) => Promise<unknown>,
      ) => {
        const id = `fence-${fences.length + 1}`;
        fences.push(id);
        return fn({ assertHeld: () => undefined });
      },
      listTokenAccountsForUser: async () => accounts,
      getUserById: async () => user,
      getUserQuotaState: async () => quotaState,
      updateUserAccessStatusUnderUserFence: async () => {
        throw new Error("must not reach the local revoke after remote failure");
      },
    },
    newapi: {
      disableNewApiTokenAndVerify: async () => {
        disableCalls += 1;
        if (disableCalls === 2) {
          const error = new Error("old execution fence lost after remote disable");
          error.name = "QuotaExecutionFenceLostError";
          throw error;
        }
      },
      enableNewApiTokenAndVerify: async (id: string) => {
        enabled.push(id);
      },
    },
  });

  await assert.rejects(() =>
    api.suspendUserAccess({
      actorFeishuUserId: "root",
      feishuUserId: user.id,
      status: "disabled",
      tokenStatus: "disabled",
      requireIssuedToken: true,
    }),
  );
  assert.deepEqual(fences, ["fence-1", "fence-2"]);
  assert.deepEqual(enabled, ["upstream-1", "upstream-2"]);
});

test("resume failure after actor scope revocation disables upstream and rolls local state back", async () => {
  const user: {
    id: string;
    openId: string;
    status: "active" | "disabled";
    disabledAt?: string;
  } = { id: "user-2", openId: "open-user-2", status: "disabled" };
  const account: {
    id: string;
    feishuUserId: string;
    newapiTokenId: string;
    status: "active" | "disabled";
    createdAt: string;
    disabledAt?: string;
  } = {
    id: "account-2",
    feishuUserId: user.id,
    newapiTokenId: "upstream-resume",
    status: "disabled",
    createdAt: "2099-01-01T00:00:00.000Z",
  };
  const quotaState: {
    feishuUserId: string;
    admission: "open" | "closed";
    activeGeneration: number;
    closedReason?: string;
    upstreamDisabledAt?: string;
    consumptionBarrierCutoffAt?: string;
    updatedAt: string;
  } = {
    feishuUserId: user.id,
    admission: "closed",
    activeGeneration: 1,
    closedReason: "user_access_revoked",
    updatedAt: "2098-12-31T00:00:00.000Z",
  };
  let authorizationCalls = 0;
  let userFenceCalls = 0;
  const disabled: string[] = [];
  const api = await loadUserAccessHarness({
    store: {
      withAdminScopeUserLocks: async (_ids: string[], fn: () => Promise<unknown>) => fn(),
      authorizeAdminUserActionUnderScopeLocks: async () => {
        authorizationCalls += 1;
        if (authorizationCalls === 2) {
          const error = new Error("actor scope revoked");
          error.name = "AdminUserActionAuthorizationError";
          Object.assign(error, { status: 403, code: "actor_scope_missing" });
          throw error;
        }
        return { targetUser: user };
      },
      withUserQuotaOperationLock: async (
        _id: string,
        fn: (fence: { assertHeld(): void }) => Promise<unknown>,
      ) => {
        userFenceCalls += 1;
        return fn({ assertHeld: () => undefined });
      },
      listTokenAccountsForUser: async () => [account],
      getUserById: async () => user,
      getUserQuotaState: async () => quotaState,
      enableUserAccessUnderUserFence: async () => {
        user.status = "active";
        account.status = "active";
        quotaState.admission = "closed";
        quotaState.closedReason = "user_access_resume_pending";
        return { user, tokenAccount: account };
      },
      finalizeUserAccessResumeUnderUserFence: async () => {
        const error = new Error("old execution fence lost after upstream enable");
        error.name = "QuotaExecutionFenceLostError";
        throw error;
      },
      rollbackUserAccessResumeUnderUserFence: async (input: {
        upstreamDisabledAt: string;
        consumptionBarrierCutoffAt: string;
      }) => {
        if (
          user.status !== "active" ||
          account.status !== "active" ||
          quotaState.closedReason !== "user_access_resume_pending"
        ) {
          return null;
        }
        user.status = "disabled";
        account.status = "disabled";
        quotaState.closedReason = "user_access_revoked";
        quotaState.upstreamDisabledAt = input.upstreamDisabledAt;
        quotaState.consumptionBarrierCutoffAt = input.consumptionBarrierCutoffAt;
        return { user, tokenAccount: account, quotaState };
      },
    },
    newapi: {
      enableNewApiTokenAndVerify: async () => undefined,
      disableNewApiTokenAndVerify: async (id: string) => {
        disabled.push(id);
      },
    },
  });

  await assert.rejects(
    () =>
      api.resumeUserAccess({
        actorFeishuUserId: "root",
        feishuUserId: user.id,
      }),
    /已重新禁用上游 Key 并回滚本地访问/,
  );
  assert.equal(authorizationCalls, 2);
  assert.equal(userFenceCalls, 2);
  assert.deepEqual(disabled, ["upstream-resume"]);
  assert.equal(user.status, "disabled");
  assert.equal(account.status, "disabled");
  assert.equal(quotaState.closedReason, "user_access_revoked");
  assert.equal(quotaState.upstreamDisabledAt, "2099-01-01T00:00:00.000Z");
  assert.equal(quotaState.consumptionBarrierCutoffAt, "2099-01-01T00:01:00.000Z");
});

test("resume recovery never rolls back a finalize that committed open", async () => {
  const user = { id: "user-3", openId: "open-user-3", status: "disabled" as "active" | "disabled" };
  const account = {
    id: "account-3",
    feishuUserId: user.id,
    newapiTokenId: "upstream-completed",
    status: "disabled" as "active" | "disabled",
    createdAt: "2099-01-01T00:00:00.000Z",
  };
  const quotaState = {
    feishuUserId: user.id,
    admission: "closed" as "open" | "closed",
    activeGeneration: 1,
    closedReason: "user_access_revoked" as string | undefined,
    updatedAt: "2099-01-01T00:00:00.000Z",
  };
  let authorizationCalls = 0;
  let rollbackCalls = 0;
  let disableCalls = 0;
  const api = await loadUserAccessHarness({
    store: {
      withAdminScopeUserLocks: async (_ids: string[], fn: () => Promise<unknown>) => fn(),
      authorizeAdminUserActionUnderScopeLocks: async () => {
        authorizationCalls += 1;
        if (authorizationCalls === 2) {
          const error = new Error("actor scope revoked");
          error.name = "AdminUserActionAuthorizationError";
          Object.assign(error, { status: 403, code: "actor_scope_missing" });
          throw error;
        }
        return { targetUser: user };
      },
      withUserQuotaOperationLock: async (
        _id: string,
        fn: (fence: { assertHeld(): void }) => Promise<unknown>,
      ) => fn({ assertHeld: () => undefined }),
      listTokenAccountsForUser: async () => [account],
      getUserById: async () => user,
      getUserQuotaState: async () => quotaState,
      enableUserAccessUnderUserFence: async () => {
        user.status = "active";
        account.status = "active";
        quotaState.admission = "closed";
        quotaState.closedReason = "user_access_resume_pending";
        return { user, tokenAccount: account };
      },
      finalizeUserAccessResumeUnderUserFence: async () => {
        quotaState.admission = "open";
        quotaState.closedReason = undefined;
        throw new Error("finalize committed but response was lost");
      },
      rollbackUserAccessResumeUnderUserFence: async () => {
        rollbackCalls += 1;
        return null;
      },
    },
    newapi: {
      enableNewApiTokenAndVerify: async () => undefined,
      disableNewApiTokenAndVerify: async () => {
        disableCalls += 1;
      },
    },
  });

  const result = await api.resumeUserAccess({
    actorFeishuUserId: "root",
    feishuUserId: user.id,
  }) as { quotaState: { admission: string } };
  assert.equal(result.quotaState.admission, "open");
  assert.equal(rollbackCalls, 0);
  assert.equal(disableCalls, 0);
});

test("startup recovery closes a stale crash-state resume without actor authorization", async () => {
  const user = { id: "user-crash", openId: "open-crash", status: "active" as const };
  const account = {
    id: "account-crash",
    feishuUserId: user.id,
    newapiTokenId: "upstream-crash",
    status: "active" as "active" | "disabled",
    createdAt: "2098-12-31T00:00:00.000Z",
  };
  const quotaState = {
    feishuUserId: user.id,
    admission: "closed" as const,
    activeGeneration: 1,
    closedReason: "user_access_resume_pending",
    resumeTokenAccountId: account.id,
    resumePreparedAt: "2098-12-31T00:00:00.000Z",
    resumeUpstreamEnableAttemptedAt: "2098-12-31T00:00:01.000Z",
    updatedAt: "2098-12-31T00:00:01.000Z",
  };
  let authorizationCalls = 0;
  let staleBefore: string | undefined;
  const disabled: string[] = [];
  const api = await loadUserAccessHarness({
    store: {
      authorizeAdminUserActionUnderScopeLocks: async () => {
        authorizationCalls += 1;
        throw new Error("durable recovery must not authorize an actor");
      },
      withUserQuotaOperationLock: async (
        _id: string,
        fn: (fence: { assertHeld(): void }) => Promise<unknown>,
      ) => fn({ assertHeld: () => undefined }),
      listStaleUserAccessResumeCandidates: async (input: {
        staleBefore: string;
      }) => {
        staleBefore = input.staleBefore;
        return [{ user, tokenAccount: account, quotaState }];
      },
      listTokenAccountsForUser: async () => [account],
      getUserById: async () => user,
      getUserQuotaState: async () => quotaState,
      rollbackUserAccessResumeUnderUserFence: async () => {
        account.status = "disabled";
        quotaState.closedReason = "user_access_revoked";
        return { user, tokenAccount: account, quotaState };
      },
    },
    newapi: {
      disableNewApiTokenAndVerify: async (id: string) => {
        disabled.push(id);
      },
      enableNewApiTokenAndVerify: async () => undefined,
    },
  });

  const result = await api.recoverStaleUserAccessResumesOnce({
    nowEpochMs: Date.parse("2099-01-01T00:00:00.000Z"),
  });
  assert.equal(authorizationCalls, 0);
  assert.equal(staleBefore, "2098-12-31T23:59:45.000Z");
  assert.deepEqual(disabled, ["upstream-crash"]);
  assert.deepEqual(
    { scanned: result.scanned, rolledBack: result.rolledBack, failed: result.failed },
    { scanned: 1, rolledBack: 1, failed: 0 },
  );
});

test("disable delete and enable are scope-locked fenced fail-closed workflows", async () => {
  const [
    access,
    postgres,
    store,
    submit,
    deleteRoute,
    disableRoute,
    enableRoute,
    quotaAdjustRoute,
    adminUsers,
    adminAssignmentRoute,
    instrumentation,
    baseline,
  ] =
    await Promise.all([
      readFile(accessPath, "utf8"),
      readFile(postgresPath, "utf8"),
      readFile(storePath, "utf8"),
      readFile(submitPath, "utf8"),
      readFile(deleteRoutePath, "utf8"),
      readFile(disableRoutePath, "utf8"),
      readFile(enableRoutePath, "utf8"),
      readFile(quotaAdjustRoutePath, "utf8"),
      readFile(adminUsersPath, "utf8"),
      readFile(adminAssignmentRoutePath, "utf8"),
      readFile(instrumentationPath, "utf8"),
      readFile(baselinePath, "utf8"),
    ]);

  assert.match(access, /withUserQuotaOperationLock\(input\.feishuUserId/);
  assert.match(access, /withAdminScopeUserLocks/);
  assert.match(access, /authorizeAdminUserActionUnderScopeLocks/);
  assert.doesNotMatch(access, /getScopedUser\(input\.scope/);
  assert.match(access, /disableNewApiTokenAndVerify/);
  assert.match(access, /updateUserAccessStatusUnderUserFence/);
  assert.match(access, /adminScopeLocksHeld: true/);
  assert.match(access, /upstreamDisabledAt/);
  assert.match(access, /consumptionBarrierCutoffAt/);
  assert.match(access, /directConsumptionDrainGraceMs/);
  assert.match(access, /restoreIssuedAccountsAfterFailedSuspend/);
  assert.match(access, /compensateFailedResume/);
  assert.match(access, /rollbackUserAccessResumeUnderUserFence/);
  assert.match(access, /markUserAccessResumeEnableAttemptUnderUserFence/);
  assert.match(access, /recoverStaleUserAccessResumesOnce/);
  assert.match(access, /staleResumeRecoveryLimit = 25/);
  assert.match(access, /staleResumeRecoveryConcurrency = 4/);
  assert.match(access, /status: "already_completed"/);
  assert.match(access, /state_already_fail_closed/);
  const suspendStart = access.indexOf("export async function suspendUserAccess");
  const recordAttempt = access.indexOf("attemptedIssuedAccounts.push(account)", suspendStart);
  const disableAttempt = access.indexOf(
    "disableNewApiTokenAndVerify(account.newapiTokenId)",
    suspendStart,
  );
  const suspendCompensation = access.indexOf(
    "restoreIssuedAccountsAfterFailedSuspend(",
    disableAttempt,
  );
  assert.ok(
    suspendStart >= 0 &&
      recordAttempt > suspendStart &&
      recordAttempt < disableAttempt &&
      suspendCompensation > disableAttempt,
  );
  assert.match(postgres, /user-quota:\$\{input\.feishuUserId\}/);
  assert.match(postgres, /admin-scope-user:\$\{feishuUserId\}/);
  assert.match(postgres, /resolvePostgresActorScopeInTransaction/);
  assert.match(postgres, /authorizePostgresAdminUserAction/);
  assert.match(postgres, /root_required/);
  assert.match(postgres, /self_access_revoke_forbidden/);
  assert.match(postgres, /last_root_revoke_forbidden/);
  assert.match(store, /authorizeJsonAdminUserAction/);
  assert.match(postgres, /canCancelQuotaOperationForAccessRevoke/);
  assert.match(postgres, /state: cancellable \? "cancelled" : "manual_review"/);
  assert.match(postgres, /closedReason: "user_access_revoked"/);
  assert.match(
    postgres,
    /preserveUserAccessRevocationBarrier\(input, quotaState\)/,
  );
  assert.match(
    store,
    /preserveUserAccessRevocationBarrier\([\s\S]*?input,[\s\S]*?existingQuotaState/,
  );
  assert.match(postgres, /terminalCredentials/);
  assert.match(postgres, /credentialCiphertext: undefined/);

  const prepareAt = access.indexOf("enableUserAccessUnderUserFence");
  const upstreamEnableAt = access.indexOf("enableNewApiTokenAndVerify", prepareAt);
  const finalizeAt = access.indexOf("finalizeUserAccessResumeUnderUserFence", upstreamEnableAt);
  assert.ok(prepareAt >= 0 && prepareAt < upstreamEnableAt && upstreamEnableAt < finalizeAt);
  assert.match(postgres, /closedReason: "user_access_resume_pending"/);
  assert.match(postgres, /finalizePostgresUserAccessResumeUnderUserFence/);
  assert.match(postgres, /rollbackPostgresUserAccessResumeUnderUserFence/);
  assert.match(postgres, /rollbackPendingUserAccessResumeSql/);
  assert.match(postgres, /listPostgresStaleUserAccessResumeCandidates/);
  assert.match(postgres, /listStaleUserAccessResumeCandidatesSql/);
  assert.match(store, /finalizeUserAccessResumeUnderUserFence/);
  assert.match(store, /rollbackUserAccessResumeUnderUserFence/);
  assert.match(store, /quotaState\.closedReason !== "user_access_resume_pending"/);
  assert.match(store, /resumeUpstreamEnableAttemptedAt/);
  assert.match(instrumentation, /ensureUserAccessRecoveryWorker/);
  assert.match(baseline, /user_quota_states_resume_recovery_idx/);

  for (const route of [deleteRoute, disableRoute, enableRoute]) {
    assert.match(route, /actorFeishuUserId: auth\.user\.id/);
    assert.doesNotMatch(route, /scope: auth\.scope/);
    assert.doesNotMatch(route, /(?:enable|disable)NewApiToken\(/);
  }
  assert.match(quotaAdjustRoute, /assertAdminUserActionTargetAllowed/);
  assert.match(adminUsers, /!user\.isGlobalAdmin \|\| isRootAdmin/);
  assert.doesNotMatch(adminUsers, /仅 root 可操作/);
  assert.match(adminUsers, /data\?\.user\?\.id !== user\.id/);
  assert.match(adminAssignmentRoute, /target_user_inactive/);
  assert.match(postgres, /error: "target_user_inactive"/);
  assert.match(store, /error: "target_user_inactive"/);
  assert.match(submit, /target_user_inactive/);
  assert.match(submit, /lockedUserResult/);
  assert.match(postgres, /额度操作目标用户已禁用、删除或不存在/);
});

test("credential delivery is retryable until explicit active-user acknowledgement", async () => {
  const [saga, route, experience] = await Promise.all([
    readFile(sagaPath, "utf8"),
    readFile(detailRoutePath, "utf8"),
    readFile(experiencePath, "utf8"),
  ]);
  const claimStart = saga.indexOf("export async function claimQuotaOperationCredential(");
  const ackStart = saga.indexOf("export async function acknowledgeQuotaOperationCredential(");
  assert.ok(claimStart >= 0 && ackStart > claimStart);
  const claim = saga.slice(claimStart, ackStart);
  const acknowledgement = saga.slice(ackStart);
  assert.doesNotMatch(claim, /credentialCiphertext: undefined/);
  assert.match(claim, /deliveryToken/);
  assert.match(acknowledgement, /credentialCiphertext: undefined/);
  assert.match(acknowledgement, /credentialDeliveredAt: nowIso\(\)/);
  assert.match(acknowledgement, /credentialDeliveryTokenHash/);
  assert.match(route, /user\.status && user\.status !== "active"/);
  assert.match(route, /export async function POST/);
  assert.match(experience, /JSON\.stringify\(\{ deliveryToken: body\.deliveryToken \}\)/);
  assert.match(experience, /\[0, 200, 1_000\]/);
});

test("activated quota recovery accepts real consumption but never excess balance", async () => {
  const saga = await readFile(sagaPath, "utf8");
  assert.match(saga, /controlState\.remainQuota > targetRemainQuota/);
  assert.match(saga, /observedRemainOnActivatedResume/);
  assert.match(saga, /assertFrozenOperationAccountBinding/);
  assert.match(saga, /disableNewApiTokenAndVerify\(account\.newapiTokenId\)/);
});

test("existing-key quota changes use a direct NewAPI drain grace and authoritative refresh", async () => {
  const [saga, reporting] = await Promise.all([
    readFile(sagaPath, "utf8"),
    readFile(new URL("../lib/newapi-reporting.ts", import.meta.url), "utf8"),
  ]);
  assert.match(saga, /prepareDirectNewApiControl/);
  assert.match(saga, /directConsumptionDrainGraceMs/);
  assert.match(saga, /directDrainReadyAt/);
  assert.match(saga, /getNewApiUserAuthoritativeQuotaSnapshot/);
  assert.doesNotMatch(saga, /ingestQuotaBarrierUsage|rebuildOperationQuotaSnapshot/);
  assert.match(reporting, /currentPackageContext\(bindings, \{ forceRefresh: true \}\)/);
});
