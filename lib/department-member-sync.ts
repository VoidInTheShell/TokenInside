import { nowIso, randomId } from "@/lib/crypto";
import {
  getFeishuDepartmentNameById,
  getTenantAccessToken,
  listFeishuDepartmentUsersPage,
} from "@/lib/feishu";
import { isPostgresAdvisoryLockBusyError } from "@/lib/postgres-store";
import {
  assertDepartmentMemberSyncExecutionAuthorized,
  batchUpsertDepartmentMembersForSync,
  claimBillingOperationExecution,
  findBillingOperationById,
  getUserById,
  listRunnableBillingOperations,
  recordBillingOperation,
  renewBillingOperationExecution,
  withDepartmentMemberSyncWorkerFence,
} from "@/lib/store";
import type { BillingOperationRecord, BillingOperationStatus } from "@/lib/types";

const directorySyncLeaseMs = 5 * 60_000;
const directorySyncHeartbeatMs = 60_000;
const directorySyncIdlePollMs = 5_000;
const directorySyncBusyPollMs = 250;
const maxDirectoryPages = 100;

type DepartmentMemberSyncRuntime = {
  started: boolean;
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
};

type DepartmentMemberSyncRuntimeGlobal = typeof globalThis & {
  __tokenInsideDepartmentMemberSyncRuntimeV1?: DepartmentMemberSyncRuntime;
};

const runtimeGlobal = globalThis as DepartmentMemberSyncRuntimeGlobal;
const directorySyncRuntime =
  runtimeGlobal.__tokenInsideDepartmentMemberSyncRuntimeV1 ??=
    { started: false, running: false };

function directorySyncLeaseExpiresAt() {
  return new Date(Date.now() + directorySyncLeaseMs).toISOString();
}

function operationDepartmentId(operation: BillingOperationRecord) {
  const departmentId = operation.input?.departmentId;
  if (typeof departmentId !== "string" || !departmentId.trim()) {
    throw new Error("部门成员同步任务缺少有效部门 ID");
  }
  return departmentId;
}

export async function runDepartmentMemberSyncOperation(operationId: string) {
  const leaseId = randomId("bol");
  const claimed = await claimBillingOperationExecution({
    operationId,
    kind: "department_member_sync",
    leaseId,
    leaseExpiresAt: directorySyncLeaseExpiresAt(),
  });
  if (!claimed) return findBillingOperationById(operationId);

  const heartbeat = setInterval(() => {
    void renewBillingOperationExecution({
      operationId,
      leaseId,
      leaseExpiresAt: directorySyncLeaseExpiresAt(),
    }).catch((error) => {
      console.error(
        JSON.stringify({
          event: "tokeninside.department_member_sync.lease_renew_failed",
          operationId,
          errorMessage: error instanceof Error ? error.message : "lease renew failed",
        }),
      );
    });
  }, directorySyncHeartbeatMs);
  heartbeat.unref?.();

  let synced = 0;
  let skipped = 0;
  let pages = 0;
  let departmentName: string | undefined;
  let completionStatus: BillingOperationStatus = "applied";
  let completionError: string | undefined;

  try {
    const authorized = await assertDepartmentMemberSyncExecutionAuthorized({
      operationId,
      leaseId,
    });
    const departmentId = operationDepartmentId(authorized.operation);
    const actor = await getUserById(claimed.operatedByFeishuUserId);
    if (!actor || actor.status !== "active") {
      throw new Error("同步任务提交人已不存在或被禁用");
    }
    departmentName = await getFeishuDepartmentNameById(departmentId).catch(
      () => undefined,
    );
    const tenantAccessToken = await getTenantAccessToken();
    const seenOpenIds = new Set<string>();
    let pageToken: string | undefined;
    let reachedEnd = false;

    for (let page = 0; page < maxDirectoryPages; page += 1) {
      await assertDepartmentMemberSyncExecutionAuthorized({ operationId, leaseId });
      const pageResult = await listFeishuDepartmentUsersPage(departmentId, {
        pageToken,
        tenantAccessToken,
      });
      pages += 1;
      const contacts: Parameters<typeof batchUpsertDepartmentMembersForSync>[0]["contacts"] = [];
      for (const contact of pageResult.items) {
        const openId = contact.open_id?.trim();
        if (!openId || seenOpenIds.has(openId)) {
          skipped += 1;
          continue;
        }
        seenOpenIds.add(openId);
        contacts.push({
          openId,
          unionId: contact.union_id,
          feishuUserIdFromFeishu: contact.user_id,
          name: contact.name,
          avatarUrl:
            contact.avatar?.avatar_origin ??
            contact.avatar?.avatar_640 ??
            contact.avatar?.avatar_240 ??
            contact.avatar?.avatar_72,
        });
      }
      const batch = await batchUpsertDepartmentMembersForSync({
        operationId,
        leaseId,
        tenantKey: actor.tenantKey,
        departmentName,
        contacts,
      });
      synced += batch.synced;
      skipped += batch.skipped;
      if (!pageResult.hasMore) {
        reachedEnd = true;
        break;
      }
      if (!pageResult.pageToken) {
        completionStatus = "partial_failed";
        completionError = "飞书返回 has_more=true 但未提供下一页游标";
        break;
      }
      pageToken = pageResult.pageToken;
    }

    if (!reachedEnd && !completionError) {
      completionStatus = "partial_failed";
      completionError = "部门成员超过单任务 5000 人上限，未将窗口错误标记为完整同步";
    }

    await recordBillingOperation({
      id: operationId,
      expectedLeaseId: leaseId,
      kind: "department_member_sync",
      status: completionStatus,
      dryRun: false,
      operatedByFeishuUserId: claimed.operatedByFeishuUserId,
      input: claimed.input,
      summary: {
        departmentId,
        departmentName,
        pages,
        synced,
        skipped,
        finishedAt: nowIso(),
      },
      errorMessage: completionError,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "飞书部门成员同步失败";
    const current = await findBillingOperationById(operationId).catch(() => null);
    if (current?.status === "running" && current.leaseId === leaseId) {
      await recordBillingOperation({
        id: operationId,
        expectedLeaseId: leaseId,
        kind: "department_member_sync",
        status: synced > 0 ? "partial_failed" : "failed",
        dryRun: false,
        operatedByFeishuUserId: claimed.operatedByFeishuUserId,
        input: claimed.input,
        summary: {
          departmentId: String(claimed.input?.departmentId ?? ""),
          departmentName,
          pages,
          synced,
          skipped,
          failedAt: nowIso(),
        },
        errorMessage,
      }).catch(() => undefined);
    }
  } finally {
    clearInterval(heartbeat);
  }
  return findBillingOperationById(operationId);
}

export async function runRunnableDepartmentMemberSyncOperation() {
  return withDepartmentMemberSyncWorkerFence(async () => {
    const operations = await listRunnableBillingOperations({
      kind: "department_member_sync",
      limit: 1,
    });
    if (!operations[0]) return null;
    return runDepartmentMemberSyncOperation(operations[0].id);
  });
}

function scheduleDepartmentMemberSyncWorker(delayMs: number) {
  if (directorySyncRuntime.timer) clearTimeout(directorySyncRuntime.timer);
  directorySyncRuntime.timer = setTimeout(async () => {
    directorySyncRuntime.timer = undefined;
    if (directorySyncRuntime.running) {
      scheduleDepartmentMemberSyncWorker(directorySyncIdlePollMs);
      return;
    }
    directorySyncRuntime.running = true;
    let ran = false;
    try {
      ran = Boolean(await runRunnableDepartmentMemberSyncOperation());
    } catch (error) {
      if (!isPostgresAdvisoryLockBusyError(error)) {
        console.error(
          JSON.stringify({
            event: "tokeninside.department_member_sync.worker_failed",
            errorMessage:
              error instanceof Error ? error.message : "directory sync worker failed",
          }),
        );
      }
    } finally {
      directorySyncRuntime.running = false;
      scheduleDepartmentMemberSyncWorker(
        ran ? directorySyncBusyPollMs : directorySyncIdlePollMs,
      );
    }
  }, Math.max(delayMs, 10));
  directorySyncRuntime.timer.unref?.();
}

export function ensureDepartmentMemberSyncWorker() {
  if (directorySyncRuntime.started) return;
  directorySyncRuntime.started = true;
  scheduleDepartmentMemberSyncWorker(1_000);
}
