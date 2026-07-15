import { createHash } from "node:crypto";
import { resolveUsageBillingPeriod } from "./quota-model.ts";
import type {
  QuotaLedgerEntry,
  QuotaOperation,
  StoreShape,
  UserQuotaPolicy,
} from "./types";

function stableId(prefix: string, value: string) {
  return `${prefix}_${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 28)}`;
}

function quotaFromUsage(store: StoreShape, feishuUserId: string, period: string, quotaPerUnit: number) {
  return store.newapiUsageRecords
    .filter(
      (item) =>
        item.feishuUserId === feishuUserId &&
        resolveUsageBillingPeriod({
          billingPeriod: item.billingPeriod,
          occurredAt: item.newapiCreatedAt ?? item.lastSyncedAt ?? item.firstSeenAt,
        }) === period &&
        item.matchStatus !== "unknown_token" &&
        item.matchStatus !== "malformed_log",
    )
    .reduce((sum, item) => {
      if (Number.isFinite(item.quota)) return sum + Math.max(Math.round(item.quota as number), 0);
      if (Number.isFinite(item.cost)) {
        return sum + Math.max(Math.round((item.cost as number) * quotaPerUnit), 0);
      }
      return sum;
    }, 0);
}

export function buildQuotaMigrationPlan(
  store: StoreShape,
  input: {
    period: string;
    quotaPerUnit: number;
    now: string;
  },
) {
  const policies: UserQuotaPolicy[] = [];
  const operations: QuotaOperation[] = [];
  const ledgerEntries: QuotaLedgerEntry[] = [];
  const warnings: Array<{
    type: string;
    feishuUserId?: string;
    sourceId?: string;
    message: string;
  }> = [];
  let estimatedUsers = 0;
  const artifactAt = `${input.period}-01T00:00:00.000Z`;

  const users = store.users
    .filter((item) => item.status !== "deleted")
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const user of users) {
    const explicitRequest = store.tokenRequests
      .filter(
        (item) =>
          item.feishuUserId === user.id &&
          item.status === "provisioned" &&
          (item.requestType === "first_apply" || item.requestType === "quota_adjust"),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const billing = store.userBillingPeriods.find(
      (item) => item.feishuUserId === user.id && item.period === input.period,
    );
    const assignedDisplayQuota =
      billing?.monthlyQuota ??
      explicitRequest?.approvedMonthlyQuota ??
      explicitRequest?.requestedMonthlyQuota ??
      store.settings.defaultMonthlyQuota;
    const assignedMonthlyQuota = Math.max(
      Math.round(assignedDisplayQuota * input.quotaPerUnit),
      0,
    );
    const sourceId = billing?.id ?? explicitRequest?.id ?? `default:${input.period}:${user.id}`;
    const previousVersion = store.userQuotaPolicies
      .filter((item) => item.feishuUserId === user.id)
      .reduce((max, item) => Math.max(max, item.version), 0);
    const policyId = stableId("uqp", `migration:${input.period}:${user.id}`);
    const existingMigrationPolicy = store.userQuotaPolicies.find(
      (item) => item.id === policyId,
    );
    policies.push({
      id: policyId,
      feishuUserId: user.id,
      assignedMonthlyQuota,
      departmentId: user.departmentId,
      effectiveFromPeriod: input.period,
      sourceType: "migration",
      sourceId,
      version: existingMigrationPolicy?.version ?? previousVersion + 1,
      quotaPerUnitSnapshot: input.quotaPerUnit,
      createdAt: existingMigrationPolicy?.createdAt ?? artifactAt,
      updatedAt: existingMigrationPolicy?.updatedAt ?? artifactAt,
      updatedByOpenId: "system:migration",
    });

    const activeAccount = store.tokenAccounts.find(
      (item) => item.feishuUserId === user.id && item.status === "active",
    );
    const consumedQuota = quotaFromUsage(store, user.id, input.period, input.quotaPerUnit);
    const observedRemainEstimate = activeAccount
      ? Math.max(Math.round((billing?.remainingQuota ?? 0) * input.quotaPerUnit), 0)
      : assignedMonthlyQuota;
    const authorizedQuota = activeAccount
      ? consumedQuota + observedRemainEstimate
      : assignedMonthlyQuota;
    const estimated = Boolean(activeAccount);
    if (estimated) {
      estimatedUsers += 1;
      warnings.push({
        type: "estimated_opening",
        feishuUserId: user.id,
        sourceId: activeAccount?.id,
        message: "migration_opening 使用已结算消费加本地观测余额估计，启用写回前必须以 shadow 对账复核",
      });
    }
    const operationId = stableId("qo", `migration:${input.period}:${user.id}`);
    operations.push({
      id: operationId,
      operationType: "migration",
      idempotencyKey: `migration-opening:${input.period}:${user.id}`,
      feishuUserId: user.id,
      departmentId: user.departmentId,
      billingPeriod: input.period,
      requestedAssignedQuota: assignedMonthlyQuota,
      assignedQuotaBefore: assignedMonthlyQuota,
      reservedDepartmentQuota: 0,
      operationGeneration: activeAccount?.operationGeneration ?? 0,
      state: "completed",
      attemptCount: 1,
      tokenAccountIdBefore: activeAccount?.id,
      upstreamTokenIdBefore: activeAccount?.newapiTokenId,
      evidence: {
        migrationEstimated: estimated,
        authoritativeConsumedQuota: consumedQuota,
        observedRemainEstimate,
      },
      createdByOpenId: "system:migration",
      createdAt: artifactAt,
      updatedAt: artifactAt,
      completedAt: artifactAt,
    });
    ledgerEntries.push({
      id: stableId("qle", `${operationId}:migration_opening`),
      operationId,
      feishuUserId: user.id,
      departmentId: user.departmentId,
      period: input.period,
      signedQuota: authorizedQuota,
      entryType: "migration_opening",
      quotaPerUnitSnapshot: input.quotaPerUnit,
      sourceType: "migration",
      sourceId,
      estimated,
      createdAt: artifactAt,
    });
  }

  for (const request of store.tokenRequests
    .filter(
      (item) => item.requestType === "key_reset" || item.requestType === "quota_reset",
    )
    .sort((a, b) => a.id.localeCompare(b.id))) {
    warnings.push({
      type: "excluded_legacy_request",
      feishuUserId: request.feishuUserId,
      sourceId: request.id,
      message: `${request.requestType} 不作为授权迁移来源`,
    });
  }

  const canonical = JSON.stringify({
    period: input.period,
    policies,
    operations,
    ledgerEntries,
    warnings,
  });
  return {
    period: input.period,
    quotaPerUnit: input.quotaPerUnit,
    generatedAt: input.now,
    planHash: createHash("sha256").update(canonical, "utf8").digest("hex"),
    users: users.length,
    estimatedUsers,
    policies,
    operations,
    ledgerEntries,
    warnings,
  };
}
