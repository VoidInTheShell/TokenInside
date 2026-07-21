import { getConfig } from "@/lib/config";
import { nowIso } from "@/lib/crypto";
import { withPostgresControlClient } from "@/lib/postgres-store";
import { hongKongBillingPeriod } from "@/lib/quota-model";
import { getStoreSnapshot } from "@/lib/store";
import type {
  AdminScope,
  QuotaLedgerEntry,
  QuotaOperation,
  QuotaReconciliationRecord,
  UsageSyncCheckpoint,
  UsageSyncIssue,
  UserBillingPeriod,
  UserQuotaPolicy,
} from "@/lib/types";

export type BillingHealthResponse = {
  period: string;
  observedAt: string;
  checkpoint: {
    lastRunAt?: string;
    lastRunStatus?: string;
    ingestedThrough?: string;
    settledThrough?: string;
    integrityBlockedAt?: string;
    nextRunAfter?: string;
    updatedAt: string;
  } | null;
  totals: {
    policies: number;
    billingPeriods: number;
    ledgerEntries: number;
    unfinishedTasks: number;
    retryTasks: number;
    manualReviewTasks: number;
    staleAccessResumeTasks: number;
    openIssues: number;
    blockingIssues: number;
    balanceDrifts: number;
    balanceObservationGaps: number;
  };
  periods: Array<{
    feishuUserId: string;
    userName?: string;
    monthlyQuota: number;
    authorizedQuota: number;
    quotaConsumed: number;
    remainingQuota: number;
    usageRecordCount: number;
    updatedAt: string;
  }>;
  ledgerEntries: Array<{
    id: string;
    operationId: string;
    feishuUserId: string;
    userName?: string;
    entryType: string;
    signedQuota: number;
    quotaValue: number;
    createdAt: string;
  }>;
  consumptionRecords: Array<{
    id: string;
    feishuUserId: string;
    userName?: string;
    matchStatus: "matched" | "no_proxy_match";
    model?: string;
    consumedQuota: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    isStream?: boolean;
    occurredAt: string;
  }>;
  operations: Array<{
    id: string;
    operationType: string;
    feishuUserId: string;
    userName?: string;
    state: string;
    attemptCount: number;
    lastErrorMessage?: string;
    nextRetryAt?: string;
    updatedAt: string;
  }>;
  issues: Array<{
    id: string;
    issueType: string;
    severity?: "warning" | "critical";
    status: string;
    blocksSettlement?: boolean;
    feishuUserId?: string;
    tokenAccountId?: string;
    occurredAt?: string;
    updatedAt: string;
  }>;
  reconciliationRecords: Array<{
    id: string;
    feishuUserId: string;
    userName?: string;
    status: string;
    expectedAvailableQuota: number;
    observedRemainQuota?: number;
    delta?: number;
    updatedAt: string;
  }>;
};

type BillingHealthTotals = BillingHealthResponse["totals"];

type PostgresBillingHealthRow = {
  checkpoint: BillingHealthResponse["checkpoint"];
  totals: BillingHealthTotals;
  periods: BillingHealthResponse["periods"];
  ledger_entries: BillingHealthResponse["ledgerEntries"];
  consumption_records: BillingHealthResponse["consumptionRecords"];
  operations: BillingHealthResponse["operations"];
  issues: BillingHealthResponse["issues"];
  reconciliation_records: BillingHealthResponse["reconciliationRecords"];
};

function visibleCheckpoint(
  checkpoint: UsageSyncCheckpoint | null | undefined,
  includeIntegrityDetails: boolean,
): BillingHealthResponse["checkpoint"] {
  if (!checkpoint) return null;
  return {
    lastRunAt: checkpoint.lastRunAt,
    lastRunStatus: checkpoint.lastRunStatus,
    ingestedThrough: checkpoint.ingestedThrough,
    settledThrough: checkpoint.settledThrough,
    integrityBlockedAt: includeIntegrityDetails
      ? checkpoint.integrityBlockedAt
      : undefined,
    nextRunAfter: checkpoint.nextRunAfter ?? checkpoint.nextRetryAt,
    updatedAt: checkpoint.updatedAt,
  };
}

function isEffectivePolicy(policy: UserQuotaPolicy, period: string) {
  return (
    policy.effectiveFromPeriod <= period &&
    (!policy.effectiveToPeriod || policy.effectiveToPeriod >= period)
  );
}

function latestPolicies(policies: UserQuotaPolicy[], period: string) {
  const latest = new Map<string, UserQuotaPolicy>();
  for (const policy of policies) {
    if (!isEffectivePolicy(policy, period)) continue;
    const current = latest.get(policy.feishuUserId);
    if (
      !current ||
      policy.version > current.version ||
      (policy.version === current.version && policy.updatedAt > current.updatedAt)
    ) {
      latest.set(policy.feishuUserId, policy);
    }
  }
  return [...latest.values()];
}

function latestReconciliationRecords(records: QuotaReconciliationRecord[]) {
  const latest = new Map<string, QuotaReconciliationRecord>();
  for (const record of [...records].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    if (!latest.has(record.feishuUserId)) latest.set(record.feishuUserId, record);
  }
  return [...latest.values()];
}

function visibleOperation(
  operation: QuotaOperation,
  userName?: string,
): BillingHealthResponse["operations"][number] {
  return {
    id: operation.id,
    operationType: operation.operationType,
    feishuUserId: operation.feishuUserId,
    userName,
    state: operation.state,
    attemptCount: operation.attemptCount,
    lastErrorMessage: operation.lastErrorMessage,
    nextRetryAt: operation.nextRetryAt,
    updatedAt: operation.updatedAt,
  };
}

function visibleIssue(issue: UsageSyncIssue): BillingHealthResponse["issues"][number] {
  return {
    id: issue.id,
    issueType: issue.issueType,
    severity: issue.severity,
    status: issue.status,
    blocksSettlement: issue.blocksSettlement,
    feishuUserId: issue.feishuUserId,
    tokenAccountId: issue.tokenAccountId,
    occurredAt: issue.occurredAt,
    updatedAt: issue.lastSyncedAt,
  };
}

function displayQuota(value: number | undefined, quotaPerUnit: number) {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return value / quotaPerUnit;
}

async function getPostgresBillingHealth(
  scope: AdminScope,
  period: string,
): Promise<BillingHealthResponse> {
  const config = getConfig();
  const quotaPerUnit = config.newapi.quotaPerUnit;
  const includeSystemHealth =
    scope.scopeType === "global" &&
    scope.source === "environment" &&
    scope.role === "root";
  return withPostgresControlClient(async (client) => {
    const result = await client.query<PostgresBillingHealthRow>(
       `with scoped_users as materialized (
         select user_row.id, user_row.data
         from feishu_users user_row
         where $1::text = 'global' or user_row.department_id = $2
       ), scoped_active_accounts as materialized (
         select account.id, account.feishu_user_id
         from token_accounts account
         join scoped_users scoped_user on scoped_user.id = account.feishu_user_id
         where account.status = 'active'
           and account.newapi_token_id is not null
       ), current_policies as materialized (
         select distinct on (policy.feishu_user_id) policy.*
         from user_quota_policies policy
         join scoped_users scoped_user on scoped_user.id = policy.feishu_user_id
         where policy.effective_from_period <= $3
           and (policy.effective_to_period is null or policy.effective_to_period >= $3)
         order by policy.feishu_user_id, policy.version desc, policy.updated_at desc
       ), current_periods as materialized (
         select billing.*, scoped_user.data as user_data
         from user_billing_periods billing
         join scoped_users scoped_user on scoped_user.id = billing.feishu_user_id
         where billing.period = $3
       ), current_ledger as materialized (
         select ledger.*, scoped_user.data as user_data
         from quota_ledger_entries ledger
         join scoped_users scoped_user on scoped_user.id = ledger.feishu_user_id
         where ledger.period = $3
       ), current_consumption as materialized (
         select usage_record.*, scoped_user.data as user_data
         from newapi_usage_records usage_record
         join scoped_users scoped_user on scoped_user.id = usage_record.feishu_user_id
         where usage_record.billing_period = $3
           and usage_record.match_status in ('matched', 'no_proxy_match')
         order by coalesce(
           usage_record.newapi_created_at,
           usage_record.last_synced_at
         ) desc, usage_record.id
         limit 100
       ), operation_counts as materialized (
         select
           (count(*) filter (
             where operation.state not in ('completed', 'compensated', 'cancelled')
           ))::integer as unfinished_tasks,
           (count(*) filter (
             where operation.state = 'retryable_failed'
           ))::integer as retry_tasks,
           (count(*) filter (
             where operation.state = 'manual_review'
           ))::integer as manual_review_tasks
         from quota_operations operation
         join scoped_users scoped_user on scoped_user.id = operation.feishu_user_id
         where operation.state not in ('completed', 'compensated', 'cancelled')
       ), recent_operations as materialized (
         select operation.*, scoped_user.data as user_data
         from quota_operations operation
         join scoped_users scoped_user on scoped_user.id = operation.feishu_user_id
         order by operation.updated_at desc, operation.id
         limit 100
       ), stale_access_resumes as materialized (
         select quota_state.feishu_user_id
         from user_quota_states quota_state
         join scoped_users scoped_user
           on scoped_user.id = quota_state.feishu_user_id
         where $5::boolean
           and quota_state.admission = 'closed'
           and quota_state.data->>'closedReason' = 'user_access_resume_pending'
           and quota_state.updated_at <= statement_timestamp() - interval '15 seconds'
           and scoped_user.data->>'status' = 'active'
           and exists (
             select 1
             from token_accounts account
             where account.feishu_user_id = quota_state.feishu_user_id
               and account.status = 'active'
               and (
                 quota_state.data->>'resumeTokenAccountId' is null
                 or account.id = quota_state.data->>'resumeTokenAccountId'
               )
           )
         order by quota_state.updated_at, quota_state.feishu_user_id
         limit 100
       ), scoped_open_issues as materialized (
         select issue.*
         from usage_sync_issues issue
         left join scoped_users scoped_user
           on scoped_user.id = nullif(issue.data->>'feishuUserId', '')
         where $5::boolean
           and issue.status = 'open'
           and ($1::text = 'global' or scoped_user.id is not null)
       ), current_reconciliations as materialized (
         select distinct on (record.feishu_user_id)
           record.*, scoped_user.data as user_data
         from quota_reconciliation_records record
         join scoped_users scoped_user on scoped_user.id = record.feishu_user_id
         join token_accounts reconciliation_account
           on reconciliation_account.id = record.token_account_id
          and reconciliation_account.feishu_user_id = record.feishu_user_id
          and reconciliation_account.status = 'active'
         where $5::boolean
           and record.period = $3
         order by record.feishu_user_id, record.updated_at desc, record.id
       ), balance_observation_window as materialized (
         select statement_timestamp() - (
           (
             greatest(
               ceil(count(*)::numeric / greatest($7::numeric, 1)),
               1
             )::bigint + 1
           ) * greatest($6::bigint, 60000) * interval '1 millisecond'
         ) as stale_before
         from scoped_active_accounts
       ), balance_observation_coverage as materialized (
         select (count(*) filter (
           where observation.id is null
              or observation.updated_at < observation_window.stale_before
         ))::integer as gaps
         from scoped_active_accounts account
         cross join balance_observation_window observation_window
         left join quota_reconciliation_records observation
          on observation.token_account_id = account.id
          and observation.feishu_user_id = account.feishu_user_id
          and observation.period = $3
          and left(observation.id, 4) = 'qbo_'
       )
       select
         (select jsonb_strip_nulls(jsonb_build_object(
            'lastRunAt', checkpoint.data->>'lastRunAt',
            'lastRunStatus', checkpoint.data->>'lastRunStatus',
            'ingestedThrough', checkpoint.data->>'ingestedThrough',
            'settledThrough', checkpoint.data->>'settledThrough',
            'integrityBlockedAt', case when $1::text = 'global'
              then checkpoint.data->>'integrityBlockedAt' else null end,
            'nextRunAfter', coalesce(
              checkpoint.data->>'nextRunAfter',
              checkpoint.data->>'nextRetryAt'
            ),
            'updatedAt', coalesce(checkpoint.data->>'updatedAt', checkpoint.updated_at::text)
          ))
          from usage_sync_checkpoints checkpoint
          where $5::boolean
            and checkpoint.scope = 'newapi_usage_logs'
          order by checkpoint.updated_at desc
          limit 1) as checkpoint,
         jsonb_build_object(
           'policies', (select count(*)::integer from current_policies),
           'billingPeriods', (select count(*)::integer from current_periods),
           'ledgerEntries', (select count(*)::integer from current_ledger),
           'unfinishedTasks', coalesce(
             (select unfinished_tasks from operation_counts), 0
           ),
           'retryTasks', case when $5::boolean
             then coalesce((select retry_tasks from operation_counts), 0)
             else 0 end,
           'manualReviewTasks', case when $5::boolean
             then coalesce((select manual_review_tasks from operation_counts), 0)
             else 0 end,
           'staleAccessResumeTasks', case when $5::boolean
             then (select count(*)::integer from stale_access_resumes)
             else 0 end,
           'openIssues', (select count(*)::integer from scoped_open_issues),
           'blockingIssues', (select count(*)::integer from scoped_open_issues
             where coalesce((data->>'blocksSettlement')::boolean, false)),
           'balanceDrifts', (select count(*)::integer from current_reconciliations
             where status in ('excess_upstream', 'deficit_upstream', 'manual_review')),
           'balanceObservationGaps', case when $5::boolean
             then coalesce((select gaps from balance_observation_coverage), 0)
             else 0 end
         ) as totals,
         coalesce((select jsonb_agg(limited.item order by limited.sort_at desc, limited.id)
           from (
             select billing.id, billing.updated_at as sort_at,
               jsonb_strip_nulls(jsonb_build_object(
                 'feishuUserId', billing.feishu_user_id,
                 'userName', billing.user_data->>'name',
                 'monthlyQuota', coalesce((billing.data->>'monthlyQuota')::double precision, 0),
                 'authorizedQuota', coalesce(
                   (billing.data->>'authorizedQuota')::double precision / $4,
                   (billing.data->>'monthlyQuota')::double precision,
                   0
                 ),
                 'quotaConsumed', coalesce((billing.data->>'quotaConsumed')::double precision, 0),
                 'remainingQuota', coalesce((billing.data->>'remainingQuota')::double precision, 0),
                 'usageRecordCount', coalesce((billing.data->>'usageRecordCount')::integer, 0),
                 'updatedAt', coalesce(billing.data->>'updatedAt', billing.updated_at::text)
               )) as item
             from current_periods billing
             order by billing.updated_at desc, billing.id
             limit 100
           ) limited), '[]'::jsonb) as periods,
         coalesce((select jsonb_agg(limited.item order by limited.sort_at desc, limited.id)
           from (
             select ledger.id, ledger.created_at as sort_at,
               jsonb_strip_nulls(jsonb_build_object(
                 'id', ledger.id,
                 'operationId', ledger.operation_id,
                 'feishuUserId', ledger.feishu_user_id,
                 'userName', ledger.user_data->>'name',
                 'entryType', ledger.entry_type,
                 'signedQuota', ledger.signed_quota::double precision /
                   greatest(coalesce((ledger.data->>'quotaPerUnitSnapshot')::double precision, $4), 1),
                 'quotaValue', ledger.signed_quota::double precision /
                   greatest(coalesce((ledger.data->>'quotaPerUnitSnapshot')::double precision, $4), 1),
                 'createdAt', coalesce(ledger.data->>'createdAt', ledger.created_at::text)
               )) as item
             from current_ledger ledger
             order by ledger.created_at desc, ledger.id
             limit 200
           ) limited), '[]'::jsonb) as ledger_entries,
         coalesce((select jsonb_agg(limited.item order by limited.sort_at desc, limited.id)
           from (
             select usage_record.id,
               coalesce(usage_record.newapi_created_at, usage_record.last_synced_at) as sort_at,
               jsonb_strip_nulls(jsonb_build_object(
                 'id', usage_record.id,
                 'feishuUserId', usage_record.feishu_user_id,
                 'userName', usage_record.user_data->>'name',
                 'matchStatus', usage_record.match_status,
                 'model', usage_record.data->>'model',
                 'consumedQuota', coalesce(
                   (usage_record.data->>'cost')::double precision,
                   (usage_record.data->>'quota')::double precision / $4,
                   0
                 ),
                 'promptTokens', coalesce((usage_record.data->>'promptTokens')::integer, 0),
                 'completionTokens', coalesce((usage_record.data->>'completionTokens')::integer, 0),
                 'totalTokens', coalesce((usage_record.data->>'totalTokens')::integer, 0),
                 'isStream', (usage_record.data->>'isStream')::boolean,
                 'occurredAt', coalesce(
                   usage_record.data->>'newapiCreatedAt',
                   usage_record.newapi_created_at::text,
                   usage_record.data->>'lastSyncedAt',
                   usage_record.last_synced_at::text
                 )
               )) as item
             from current_consumption usage_record
             order by coalesce(
               usage_record.newapi_created_at,
               usage_record.last_synced_at
             ) desc, usage_record.id
           ) limited), '[]'::jsonb) as consumption_records,
         coalesce((select jsonb_agg(limited.item order by limited.sort_at desc, limited.id)
           from (
             select operation.id, operation.updated_at as sort_at,
               jsonb_strip_nulls(jsonb_build_object(
                 'id', operation.id,
                 'operationType', operation.operation_type,
                 'feishuUserId', operation.feishu_user_id,
                 'userName', operation.user_data->>'name',
                 'state', operation.state,
                 'attemptCount', coalesce((operation.data->>'attemptCount')::integer, 0),
                 'lastErrorMessage', operation.data->>'lastErrorMessage',
                 'nextRetryAt', coalesce(operation.data->>'nextRetryAt', operation.next_retry_at::text),
                 'updatedAt', coalesce(operation.data->>'updatedAt', operation.updated_at::text)
               )) as item
             from recent_operations operation
             order by operation.updated_at desc, operation.id
           ) limited), '[]'::jsonb) as operations,
         coalesce((select jsonb_agg(limited.item order by limited.sort_at desc, limited.id)
           from (
             select issue.id, issue.last_synced_at as sort_at,
               jsonb_strip_nulls(jsonb_build_object(
                 'id', issue.id,
                 'issueType', issue.issue_type,
                 'severity', issue.data->>'severity',
                 'status', issue.status,
                 'blocksSettlement', coalesce((issue.data->>'blocksSettlement')::boolean, false),
                 'feishuUserId', issue.data->>'feishuUserId',
                 'tokenAccountId', issue.data->>'tokenAccountId',
                 'occurredAt', issue.data->>'occurredAt',
                 'updatedAt', coalesce(issue.data->>'lastSyncedAt', issue.last_synced_at::text)
               )) as item
             from scoped_open_issues issue
             order by issue.last_synced_at desc, issue.id
             limit 100
           ) limited), '[]'::jsonb) as issues,
         coalesce((select jsonb_agg(limited.item order by limited.sort_at desc, limited.id)
           from (
             select record.id, record.updated_at as sort_at,
               jsonb_strip_nulls(jsonb_build_object(
                 'id', record.id,
                 'feishuUserId', record.feishu_user_id,
                 'userName', record.user_data->>'name',
                 'status', record.status,
                 'expectedAvailableQuota', coalesce(
                   (record.data->>'expectedAvailableQuota')::double precision / $4,
                   0
                 ),
                 'observedRemainQuota',
                   (record.data->>'observedRemainQuota')::double precision / $4,
                 'delta', (record.data->>'delta')::double precision / $4,
                 'updatedAt', coalesce(record.data->>'updatedAt', record.updated_at::text)
               )) as item
             from current_reconciliations record
             order by record.updated_at desc, record.id
             limit 100
           ) limited), '[]'::jsonb) as reconciliation_records`,
      [
        scope.scopeType,
        scope.departmentId ?? null,
        period,
        quotaPerUnit,
        includeSystemHealth,
        config.billing.balanceObservationIntervalMs,
        config.billing.balanceObservationBatchSize,
      ],
    );
    const row = result.rows[0];
    return {
      period,
      observedAt: nowIso(),
      checkpoint: row?.checkpoint ?? null,
      totals: row?.totals ?? {
        policies: 0,
        billingPeriods: 0,
        ledgerEntries: 0,
        unfinishedTasks: 0,
        retryTasks: 0,
        manualReviewTasks: 0,
        staleAccessResumeTasks: 0,
        openIssues: 0,
        blockingIssues: 0,
        balanceDrifts: 0,
        balanceObservationGaps: 0,
      },
      periods: row?.periods ?? [],
      ledgerEntries: row?.ledger_entries ?? [],
      consumptionRecords: row?.consumption_records ?? [],
      operations: row?.operations ?? [],
      issues: row?.issues ?? [],
      reconciliationRecords: row?.reconciliation_records ?? [],
    };
  });
}

async function getJsonBillingHealth(
  scope: AdminScope,
  period: string,
): Promise<BillingHealthResponse> {
  const store = await getStoreSnapshot();
  const config = getConfig();
  const quotaPerUnit = config.newapi.quotaPerUnit;
  const includeSystemHealth = scope.scopeType === "global" && scope.role === "root";
  const scopedUsers = store.users.filter(
    (user) => scope.scopeType === "global" || user.departmentId === scope.departmentId,
  );
  const scopedUserIds = new Set(scopedUsers.map((user) => user.id));
  const scopedUsersById = new Map(scopedUsers.map((user) => [user.id, user]));
  const userNames = new Map(scopedUsers.map((user) => [user.id, user.name]));
  const policies = latestPolicies(
    store.userQuotaPolicies.filter((policy) => scopedUserIds.has(policy.feishuUserId)),
    period,
  );
  const periods = store.userBillingPeriods
    .filter((item) => scopedUserIds.has(item.feishuUserId) && item.period === period)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const ledgerEntries = store.quotaLedgerEntries
    .filter((entry) => scopedUserIds.has(entry.feishuUserId) && entry.period === period)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const consumptionRecords = store.newapiUsageRecords
    .filter(
      (record) =>
        Boolean(record.feishuUserId && scopedUserIds.has(record.feishuUserId)) &&
        record.billingPeriod === period &&
        (record.matchStatus === "matched" || record.matchStatus === "no_proxy_match"),
    )
    .sort((a, b) =>
      (b.newapiCreatedAt ?? b.lastSyncedAt).localeCompare(
        a.newapiCreatedAt ?? a.lastSyncedAt,
      ),
    );
  const operations = store.quotaOperations
    .filter((operation) => scopedUserIds.has(operation.feishuUserId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const issues = (includeSystemHealth ? store.usageSyncIssues : [])
    .filter(
      (issue) =>
        issue.status === "open" &&
        (scope.scopeType === "global" ||
          Boolean(issue.feishuUserId && scopedUserIds.has(issue.feishuUserId))),
    )
    .sort((a, b) => b.lastSyncedAt.localeCompare(a.lastSyncedAt));
  const reconciliationRecords = latestReconciliationRecords(
    (includeSystemHealth ? store.quotaReconciliationRecords : []).filter(
      (record) =>
        scopedUserIds.has(record.feishuUserId) &&
        record.period === period &&
        Boolean(
          record.tokenAccountId &&
            store.tokenAccounts.some(
              (account) =>
                account.id === record.tokenAccountId &&
                account.feishuUserId === record.feishuUserId &&
                account.status === "active",
            ),
        ),
    ),
  ).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const terminalStates = new Set(["completed", "compensated", "cancelled"]);
  const activeBalanceAccounts = includeSystemHealth
    ? store.tokenAccounts.filter(
        (account) =>
          scopedUserIds.has(account.feishuUserId) &&
          account.status === "active" &&
          Boolean(account.newapiTokenId),
      )
    : [];
  const observationWindowMs =
    (Math.max(
      Math.ceil(
        activeBalanceAccounts.length /
          Math.max(config.billing.balanceObservationBatchSize, 1),
      ),
      1,
    ) +
      1) *
    Math.max(config.billing.balanceObservationIntervalMs, 60_000);
  const observationStaleBeforeMs = Date.now() - observationWindowMs;
  const observerRecordsByAccount = new Map(
    store.quotaReconciliationRecords
      .filter(
        (record) =>
          record.period === period &&
          record.tokenAccountId &&
          record.evidence?.observerVersion === 1,
      )
      .map((record) => [record.tokenAccountId as string, record]),
  );
  const balanceObservationGaps = activeBalanceAccounts.filter((account) => {
    const record = observerRecordsByAccount.get(account.id);
    return (
      !record || new Date(record.updatedAt).getTime() < observationStaleBeforeMs
    );
  }).length;
  let staleAccessResumeTasks = 0;
  if (includeSystemHealth) {
    const staleBeforeEpochMs = Date.now() - 15_000;
    for (const quotaState of store.userQuotaStates) {
      if (staleAccessResumeTasks >= 100) break;
      const user = scopedUsersById.get(quotaState.feishuUserId);
      if (
        !user ||
        user.status !== "active" ||
        quotaState.admission !== "closed" ||
        quotaState.closedReason !== "user_access_resume_pending" ||
        new Date(quotaState.updatedAt).getTime() > staleBeforeEpochMs
      ) {
        continue;
      }
      const hasRecoverableAccount = store.tokenAccounts.some(
        (account) =>
          account.feishuUserId === quotaState.feishuUserId &&
          account.status === "active" &&
          (!quotaState.resumeTokenAccountId ||
            account.id === quotaState.resumeTokenAccountId),
      );
      if (hasRecoverableAccount) staleAccessResumeTasks += 1;
    }
  }

  return {
    period,
    observedAt: nowIso(),
    checkpoint: visibleCheckpoint(
      includeSystemHealth
        ? store.usageSyncCheckpoints.find((item) => item.scope === "newapi_usage_logs")
        : null,
      includeSystemHealth,
    ),
    totals: {
      policies: policies.length,
      billingPeriods: periods.length,
      ledgerEntries: ledgerEntries.length,
      unfinishedTasks: operations.filter((item) => !terminalStates.has(item.state)).length,
      retryTasks: includeSystemHealth
        ? operations.filter((item) => item.state === "retryable_failed").length
        : 0,
      manualReviewTasks: includeSystemHealth
        ? operations.filter((item) => item.state === "manual_review").length
        : 0,
      staleAccessResumeTasks,
      openIssues: issues.length,
      blockingIssues: issues.filter((item) => item.blocksSettlement).length,
      balanceDrifts: reconciliationRecords.filter((item) =>
        ["excess_upstream", "deficit_upstream", "manual_review"].includes(
          item.status,
        ),
      ).length,
      balanceObservationGaps,
    },
    periods: periods.slice(0, 100).map((item: UserBillingPeriod) => ({
      feishuUserId: item.feishuUserId,
      userName: userNames.get(item.feishuUserId),
      monthlyQuota: item.monthlyQuota,
      authorizedQuota:
        displayQuota(item.authorizedQuota, quotaPerUnit) ?? item.monthlyQuota,
      quotaConsumed: item.quotaConsumed,
      remainingQuota: item.remainingQuota,
      usageRecordCount: item.usageRecordCount,
      updatedAt: item.updatedAt,
    })),
    ledgerEntries: ledgerEntries.slice(0, 200).map((entry: QuotaLedgerEntry) => {
      const quotaValue =
        entry.signedQuota / Math.max(entry.quotaPerUnitSnapshot || quotaPerUnit, 1);
      return {
        id: entry.id,
        operationId: entry.operationId,
        feishuUserId: entry.feishuUserId,
        userName: userNames.get(entry.feishuUserId),
        entryType: entry.entryType,
        signedQuota: quotaValue,
        quotaValue,
        createdAt: entry.createdAt,
      };
    }),
    consumptionRecords: consumptionRecords.slice(0, 100).map((record) => ({
      id: record.id,
      feishuUserId: record.feishuUserId!,
      userName: userNames.get(record.feishuUserId!),
      matchStatus: record.matchStatus as "matched" | "no_proxy_match",
      model: record.model,
      consumedQuota:
        record.cost ?? displayQuota(record.quota, quotaPerUnit) ?? 0,
      promptTokens: record.promptTokens ?? 0,
      completionTokens: record.completionTokens ?? 0,
      totalTokens: record.totalTokens ?? 0,
      isStream: record.isStream,
      occurredAt: record.newapiCreatedAt ?? record.lastSyncedAt,
    })),
    operations: operations
      .slice(0, 100)
      .map((operation) => visibleOperation(operation, userNames.get(operation.feishuUserId))),
    issues: issues.slice(0, 100).map(visibleIssue),
    reconciliationRecords: reconciliationRecords.slice(0, 100).map((record) => ({
      id: record.id,
      feishuUserId: record.feishuUserId,
      userName: userNames.get(record.feishuUserId),
      status: record.status,
      expectedAvailableQuota:
        displayQuota(record.expectedAvailableQuota, quotaPerUnit) ?? 0,
      observedRemainQuota: displayQuota(record.observedRemainQuota, quotaPerUnit),
      delta: displayQuota(record.delta, quotaPerUnit),
      updatedAt: record.updatedAt,
    })),
  };
}

export async function getBillingHealth(
  scope: AdminScope,
  period = hongKongBillingPeriod(),
): Promise<BillingHealthResponse> {
  if (getConfig().storeBackend === "postgres") {
    return getPostgresBillingHealth(scope, period);
  }
  return getJsonBillingHealth(scope, period);
}
