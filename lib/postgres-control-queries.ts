import { createAsyncSnapshotCache } from "@/lib/async-snapshot-cache";
import { getConfig } from "@/lib/config";
import { nowIso } from "@/lib/crypto";
import { withPostgresControlClient } from "@/lib/postgres-store";
import type {
  AdminScope,
  AppSettings,
  DepartmentQuotaPeriod,
  FeishuUser,
  ProxyRequestLog,
  TokenAccount,
  TokenRequest,
  UserBillingPeriod,
  UsageSyncCheckpoint,
} from "@/lib/types";

export async function getPostgresSessionStoreSummary() {
  return withPostgresControlClient(async (client) => {
    const result = await client.query<{
      default_monthly_quota: number;
      proxy_log_count: number;
    }>(
      `select
         coalesce(
           (select (data->>'defaultMonthlyQuota')::integer
            from app_settings
            where id = 'default'),
           200
         ) as default_monthly_quota,
         (select count(*)::integer from proxy_request_logs) as proxy_log_count`,
    );
    return {
      settings: {
        defaultMonthlyQuota: result.rows[0]?.default_monthly_quota ?? 200,
      },
      proxyLogCount: result.rows[0]?.proxy_log_count ?? 0,
    };
  });
}

type PostgresAuthenticatedSessionProjectionRow = {
  requests: TokenRequest[];
  active_token: TokenAccount | null;
  current_billing: UserBillingPeriod | null;
  active_token_billing: UserBillingPeriod | null;
  active_admin_scope: AdminScope | null;
  assigned_request: TokenRequest | null;
  admin_scopes: AdminScope[];
  department_quota_period: DepartmentQuotaPeriod | null;
  default_monthly_quota: number;
  proxy_log_count: number;
};

export async function getPostgresAuthenticatedSessionProjection(input: {
  feishuUserId: string;
  approvalTargetOpenId: string;
  departmentId?: string;
  currentPeriod: string;
}) {
  return withPostgresControlClient(async (client) => {
    const result = await client.query<PostgresAuthenticatedSessionProjectionRow>(
      `with active_token as materialized (
         select account.data, account.billing_period
         from token_accounts account
         where account.feishu_user_id = $1
           and account.status = 'active'
         order by account.created_at desc, account.id desc
         limit 1
       )
       select
         coalesce(
           (select jsonb_agg(request.data order by request.created_at desc, request.id)
            from token_requests request
            where request.feishu_user_id = $1),
           '[]'::jsonb
         ) as requests,
         (select token.data from active_token token) as active_token,
         (select billing.data
          from user_billing_periods billing
          where billing.feishu_user_id = $1
            and billing.period = $4
          limit 1) as current_billing,
         (select billing.data
          from user_billing_periods billing
          where billing.feishu_user_id = $1
            and billing.period = (select token.billing_period from active_token token)
          limit 1) as active_token_billing,
         (select scope.data
          from admin_scopes scope
          where scope.feishu_user_id = $1
            and scope.status = 'active'
          order by case when scope.scope_type = 'global' then 0 else 1 end,
                   scope.updated_at desc,
                   scope.id
          limit 1) as active_admin_scope,
         (select request.data
          from token_requests request
          where request.approval_target_open_id = $2
          order by request.updated_at desc, request.id
          limit 1) as assigned_request,
         coalesce(
           (select jsonb_agg(scope.data order by scope.updated_at desc, scope.id)
            from admin_scopes scope
            where scope.feishu_user_id = $1),
           '[]'::jsonb
         ) as admin_scopes,
         (select quota_period.data
          from department_quota_periods quota_period
          where quota_period.department_id = $3
            and quota_period.period = $4
          limit 1) as department_quota_period,
         coalesce(
           (select (settings.data->>'defaultMonthlyQuota')::integer
            from app_settings settings
            where settings.id = 'default'),
           200
         ) as default_monthly_quota,
         (select count(*)::integer from proxy_request_logs) as proxy_log_count`,
      [
        input.feishuUserId,
        input.approvalTargetOpenId,
        input.departmentId ?? null,
        input.currentPeriod,
      ],
    );
    const row = result.rows[0];
    return {
      requests: row?.requests ?? [],
      activeToken: row?.active_token ?? null,
      currentBilling: row?.current_billing ?? null,
      activeTokenBilling: row?.active_token_billing ?? null,
      activeAdminScope: row?.active_admin_scope ?? null,
      assignedRequest: row?.assigned_request ?? null,
      adminScopes: row?.admin_scopes ?? [],
      departmentQuotaPeriod: row?.department_quota_period ?? null,
      defaultMonthlyQuota: row?.default_monthly_quota ?? 200,
      proxyLogCount: row?.proxy_log_count ?? 0,
    };
  });
}

type PostgresAdminUserRow = {
  user_data: FeishuUser;
  account_data: TokenAccount | null;
  billing_data: UserBillingPeriod | null;
  request_data: TokenRequest | null;
  log_data: ProxyRequestLog | null;
  role_label: string;
};

export async function listPostgresAdminUsers(scope: AdminScope, currentPeriod: string) {
  const systemAdminOpenIds = getConfig().admin.systemAdminOpenIds;
  return withPostgresControlClient(async (client) => {
    const result = await client.query<PostgresAdminUserRow>(
      `select
         user_row.data as user_data,
         account_row.data as account_data,
         billing_row.data as billing_data,
         request_row.data as request_data,
         log_row.data as log_data,
         case
           when coalesce(user_row.data->>'status', 'active') <> 'active' then '普通用户'
           when user_row.open_id = any($3::text[])
             or exists (
               select 1
               from admin_scopes admin_scope
               where admin_scope.feishu_user_id = user_row.id
                 and admin_scope.status = 'active'
                 and admin_scope.scope_type = 'global'
             ) then '系统管理员'
           when exists (
             select 1
             from admin_scopes admin_scope
             where admin_scope.feishu_user_id = user_row.id
               and admin_scope.status = 'active'
               and admin_scope.scope_type = 'department'
           ) then '部门管理员'
           else '普通用户'
         end as role_label
       from feishu_users user_row
       left join lateral (
         select account.data, account.status
         from token_accounts account
         where account.feishu_user_id = user_row.id
         order by case when account.status = 'active' then 0 else 1 end,
                  account.created_at desc,
                  account.id
         limit 1
       ) account_row on true
       left join lateral (
         select billing.data
         from user_billing_periods billing
         where billing.feishu_user_id = user_row.id
           and billing.period = case
             when account_row.status = 'active'
               then coalesce(account_row.data->>'billingPeriod', $4)
             else $4
           end
         limit 1
       ) billing_row on true
       left join lateral (
         select request.data
         from token_requests request
         where request.feishu_user_id = user_row.id
         order by request.updated_at desc, request.id
         limit 1
       ) request_row on true
       left join lateral (
         select log.data
         from proxy_request_logs log
         where log.feishu_user_id = user_row.id
         order by log.created_at desc, log.id
         limit 1
       ) log_row on true
       where $1::text = 'global' or user_row.department_id = $2
       order by coalesce(
         log_row.data->>'createdAt',
         request_row.data->>'updatedAt',
         user_row.data->>'updatedAt'
       ) desc,
       user_row.id`,
      [scope.scopeType, scope.departmentId ?? null, systemAdminOpenIds, currentPeriod],
    );

    return result.rows.map((row) => {
      const user = row.user_data;
      const account = row.account_data;
      const billing = row.billing_data;
      const latestRequest = row.request_data;
      const latestLog = row.log_data;
      const billingPeriod = account?.status === "active" ? account.billingPeriod : currentPeriod;
      return {
        id: user.id,
        name: user.name,
        openId: user.openId,
        departmentId: user.departmentId,
        departmentName: user.departmentName,
        status: user.status ?? "active",
        role: row.role_label,
        activeTokenStatus: account?.status,
        activeTokenCreatedAt: account?.createdAt,
        billingPeriod,
        billingMonthlyQuota: billing?.monthlyQuota,
        billingRemainingQuota:
          billing?.monthlyQuota === undefined
            ? undefined
            : billing.remainingQuota ??
              Math.max(billing.monthlyQuota - (billing.quotaConsumed ?? 0), 0),
        billingQuotaConsumed: billing?.quotaConsumed ?? 0,
        billingCost: billing?.cost ?? billing?.quotaConsumed ?? 0,
        billingTotalTokens: billing?.totalTokens,
        billingPromptTokens: billing?.promptTokens,
        billingCompletionTokens: billing?.completionTokens,
        billingProxyLogCount: billing?.proxyLogCount,
        billingUsageRecordCount: billing?.usageRecordCount ?? 0,
        latestRequestStatus: latestRequest?.status,
        latestRequestType: latestRequest?.requestType,
        latestRequestUpdatedAt: latestRequest?.updatedAt,
        latestProxyLogAt: latestLog?.createdAt,
        updatedAt: user.updatedAt,
        createdAt: user.createdAt,
      };
    });
  });
}

type PostgresAdminOverviewTotals = {
  users: number;
  keyed_users: number;
  token_requests: number;
  pending_requests: number;
  provisioned_requests: number;
  failed_requests: number;
  active_tokens: number;
  proxy_logs: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  current_period_monthly_quota: number;
  current_period_quota_consumed: number;
  current_period_cost: number;
  current_period_remaining_quota: number;
  current_period_usage_records: number;
  current_period_proxy_logs: number;
  current_period_prompt_tokens: number;
  current_period_completion_tokens: number;
  current_period_total_tokens: number;
};

type PostgresAdminOverviewUserRow = {
  user_data: FeishuUser;
  account_data: TokenAccount | null;
  billing_data: UserBillingPeriod | null;
  request_count: number;
  proxy_log_count: number;
  total_tokens: number;
};

const adminOverviewRequestScopeSql = `(
  $1::text = 'global'
  or (
    $2::text is not null
    and coalesce(request.data->>'approvalTargetSource', '') <> 'system_admin_fallback'
    and not (
      requester.open_id = any($3::text[])
      or exists (
        select 1
        from admin_scopes requester_scope
        where requester_scope.feishu_user_id = request.feishu_user_id
          and requester_scope.status = 'active'
          and requester_scope.scope_type = 'global'
      )
    )
    and coalesce(request.approval_department_id, requester.department_id) = $2
  )
)`;

async function loadPostgresAdminOverview(scope: AdminScope, currentPeriod: string) {
  const commonValues = [
    scope.scopeType,
    scope.departmentId ?? null,
    getConfig().admin.systemAdminOpenIds,
    currentPeriod,
  ];
  return withPostgresControlClient(async (client) => {
    const totals = await client.query<PostgresAdminOverviewTotals>(
      `with scoped_users as materialized (
         select user_row.*
         from feishu_users user_row
         where $1::text = 'global' or user_row.department_id = $2
       ),
       scoped_requests as materialized (
         select request.*
         from token_requests request
         left join feishu_users requester on requester.id = request.feishu_user_id
         where ${adminOverviewRequestScopeSql}
       ),
       scoped_accounts as materialized (
         select account.*
         from token_accounts account
         join feishu_users account_user on account_user.id = account.feishu_user_id
         where $1::text = 'global' or account_user.department_id = $2
       ),
       scoped_logs as materialized (
         select log.*
         from proxy_request_logs log
         left join feishu_users log_user on log_user.id = log.feishu_user_id
         where $1::text = 'global'
            or coalesce(nullif(log.data->>'departmentId', ''), log_user.department_id) = $2
       ),
       current_billing as materialized (
         select billing.*
         from user_billing_periods billing
         join feishu_users billing_user on billing_user.id = billing.feishu_user_id
         where billing.period = $4
           and ($1::text = 'global' or billing_user.department_id = $2)
       )
       select
         (select count(*)::integer from scoped_users) as users,
         (select count(distinct feishu_user_id)::integer from scoped_accounts where status = 'active') as keyed_users,
         (select count(*)::integer from scoped_requests) as token_requests,
         (select count(*)::integer from scoped_requests where status in (
           'pending_feishu_approval', 'pending_card_send', 'pending_card_approval'
         )) as pending_requests,
         (select count(*)::integer from scoped_requests where status = 'provisioned') as provisioned_requests,
         (select count(*)::integer from scoped_requests where status = 'approved_provision_failed') as failed_requests,
         (select count(*)::integer from scoped_accounts where status = 'active') as active_tokens,
         (select count(*)::integer from scoped_logs) as proxy_logs,
         coalesce((select sum(coalesce(nullif(data->>'promptTokens', '')::double precision, 0)) from scoped_logs), 0)::double precision as prompt_tokens,
         coalesce((select sum(coalesce(nullif(data->>'completionTokens', '')::double precision, 0)) from scoped_logs), 0)::double precision as completion_tokens,
         coalesce((select sum(coalesce(nullif(data->>'totalTokens', '')::double precision, 0)) from scoped_logs), 0)::double precision as total_tokens,
         coalesce((select sum(coalesce(nullif(data->>'monthlyQuota', '')::double precision, 0)) from current_billing), 0)::double precision as current_period_monthly_quota,
         coalesce((select sum(coalesce(nullif(data->>'quotaConsumed', '')::double precision, 0)) from current_billing), 0)::double precision as current_period_quota_consumed,
         coalesce((select sum(coalesce(
           nullif(data->>'cost', '')::double precision,
           nullif(data->>'quotaConsumed', '')::double precision,
           0
         )) from current_billing), 0)::double precision as current_period_cost,
         coalesce((select sum(coalesce(
           nullif(data->>'remainingQuota', '')::double precision,
           greatest(
             coalesce(nullif(data->>'monthlyQuota', '')::double precision, 0)
               - coalesce(nullif(data->>'quotaConsumed', '')::double precision, 0),
             0
           )
         )) from current_billing), 0)::double precision as current_period_remaining_quota,
         coalesce((select sum(coalesce(nullif(data->>'usageRecordCount', '')::integer, 0)) from current_billing), 0)::integer as current_period_usage_records,
         coalesce((select sum(coalesce(nullif(data->>'proxyLogCount', '')::integer, 0)) from current_billing), 0)::integer as current_period_proxy_logs,
         coalesce((select sum(coalesce(nullif(data->>'promptTokens', '')::double precision, 0)) from current_billing), 0)::double precision as current_period_prompt_tokens,
         coalesce((select sum(coalesce(nullif(data->>'completionTokens', '')::double precision, 0)) from current_billing), 0)::double precision as current_period_completion_tokens,
         coalesce((select sum(coalesce(nullif(data->>'totalTokens', '')::double precision, 0)) from current_billing), 0)::double precision as current_period_total_tokens`,
      commonValues,
    );

    const latestRequests = await client.query<{
      request_data: TokenRequest;
      user_data: FeishuUser | null;
    }>(
      `select request.data as request_data, requester.data as user_data
       from token_requests request
       left join feishu_users requester on requester.id = request.feishu_user_id
       where ${adminOverviewRequestScopeSql}
       order by request.updated_at desc, request.id
       limit 20`,
      commonValues.slice(0, 3),
    );

    const users = await client.query<PostgresAdminOverviewUserRow>(
      `select
         user_row.data as user_data,
         account_row.data as account_data,
         billing_row.data as billing_data,
         coalesce(request_count.value, 0)::integer as request_count,
         coalesce(log_stats.request_count, 0)::integer as proxy_log_count,
         coalesce(log_stats.total_tokens, 0)::double precision as total_tokens
       from feishu_users user_row
       left join lateral (
         select account.data
         from token_accounts account
         where account.feishu_user_id = user_row.id and account.status = 'active'
         order by account.created_at desc, account.id
         limit 1
       ) account_row on true
       left join lateral (
         select billing.data
         from user_billing_periods billing
         where billing.feishu_user_id = user_row.id
           and billing.period = coalesce(account_row.data->>'billingPeriod', $4)
         limit 1
       ) billing_row on true
       left join lateral (
         select count(*)::integer as value
         from token_requests request
         where request.feishu_user_id = user_row.id
           and (
             $1::text = 'global'
             or (
               coalesce(request.data->>'approvalTargetSource', '') <> 'system_admin_fallback'
               and user_row.open_id <> all($3::text[])
               and not exists (
                 select 1
                 from admin_scopes requester_scope
                 where requester_scope.feishu_user_id = user_row.id
                   and requester_scope.status = 'active'
                   and requester_scope.scope_type = 'global'
               )
               and coalesce(request.approval_department_id, user_row.department_id) = $2
             )
           )
       ) request_count on true
       left join lateral (
         select
           count(*)::integer as request_count,
           coalesce(sum(coalesce(nullif(log.data->>'totalTokens', '')::double precision, 0)), 0)::double precision as total_tokens
         from proxy_request_logs log
         where log.feishu_user_id = user_row.id
           and (
             $1::text = 'global'
             or coalesce(nullif(log.data->>'departmentId', ''), user_row.department_id) = $2
           )
       ) log_stats on true
       where $1::text = 'global' or user_row.department_id = $2
       order by user_row.updated_at desc, user_row.id
       limit 50`,
      commonValues,
    );

    const latestProxyLogs = await client.query<{
      log_data: ProxyRequestLog;
      user_data: FeishuUser | null;
    }>(
      `select log.data as log_data, log_user.data as user_data
       from proxy_request_logs log
       left join feishu_users log_user on log_user.id = log.feishu_user_id
       where $1::text = 'global'
          or coalesce(nullif(log.data->>'departmentId', ''), log_user.department_id) = $2
       order by log.created_at desc, log.id
       limit 50`,
      commonValues.slice(0, 2),
    );

    const departmentName = scope.departmentId
      ? await client.query<{ name: string | null }>(
          `select coalesce(
             (select data->>'departmentName'
              from feishu_users
              where department_id = $1 and nullif(data->>'departmentName', '') is not null
              limit 1),
             (select data->>'departmentName'
              from proxy_request_logs
              where data->>'departmentId' = $1
                and nullif(data->>'departmentName', '') is not null
              order by created_at desc
              limit 1)
           ) as name`,
          [scope.departmentId],
        )
      : null;

    return {
      departmentName: departmentName?.rows[0]?.name ?? undefined,
      totals: totals.rows[0],
      latestRequests: latestRequests.rows,
      users: users.rows,
      latestProxyLogs: latestProxyLogs.rows,
    };
  });
}

const postgresAdminOverviewSnapshots = createAsyncSnapshotCache<
  string,
  Awaited<ReturnType<typeof loadPostgresAdminOverview>>
>({
  // The overview is an observational read model only. Authorization, quota
  // transitions and billing writes always reread their authoritative rows.
  // A short completed-value window absorbs dashboard fan-out after auth, and
  // stale-while-revalidate prevents an expensive refresh from blocking UI.
  freshMs: 5_000,
  staleMs: 30_000,
  maxEntries: 256,
});

export async function getPostgresAdminOverview(scope: AdminScope, currentPeriod: string) {
  const key = `${scope.scopeType}\u0000${scope.departmentId ?? ""}\u0000${currentPeriod}`;
  const cached = await postgresAdminOverviewSnapshots.get(key, () =>
    loadPostgresAdminOverview(scope, currentPeriod),
  );
  return {
    snapshot: cached.value,
    overviewAsOf: new Date(cached.loadedAtMs).toISOString(),
    overviewCacheState: cached.state,
  };
}

export async function getPostgresAdminOverviewMetadata() {
  return withPostgresControlClient(async (client) => {
    const result = await client.query<{
      settings: AppSettings | null;
      usage_sync_checkpoint: UsageSyncCheckpoint | null;
    }>(
      `select
         coalesce(
           (select data from app_settings where id = 'default'),
           '{"defaultMonthlyQuota":200}'::jsonb
         ) as settings,
         (select data
          from usage_sync_checkpoints
          where scope = 'newapi_usage_logs'
          limit 1) as usage_sync_checkpoint`,
    );
    return {
      settings: result.rows[0]?.settings ?? { defaultMonthlyQuota: 200 },
      usageSyncCheckpoint: result.rows[0]?.usage_sync_checkpoint ?? null,
    };
  });
}

export type PostgresUsageReportInput = {
  scope?: AdminScope;
  feishuUserId?: string;
  userId?: string;
  departmentId?: string;
  model?: string;
  provider?: string;
  apiFormat?: string;
  status?: string;
  userAgent?: string;
  clientFamily?: string;
  search?: string;
  hideUnknownRecords?: boolean;
  startAt?: string;
  endAt?: string;
  limit: number;
  offset: number;
};

type PostgresUsageAggregateRow = {
  category: "model" | "department" | "apiFormat";
  id: string;
  label: string;
  request_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cache_read_reported_requests: number;
  cache_creation_reported_requests: number;
  cache_rate_read_tokens: number;
  cache_rate_input_tokens: number;
  cost: number;
  actual_cost: number;
  success_count: number;
  duration_total_ms: number;
  duration_count: number;
  issued_quota?: number;
  used_quota?: number;
};

type PostgresUsageReportRow = {
  page: Array<{ log: ProxyRequestLog; user: FeishuUser | null }>;
  total: number;
  filter_users: Array<{
    id: string;
    name?: string;
    openId: string;
    departmentId?: string;
    departmentName?: string;
  }>;
  filter_departments: Array<{ id: string; name?: string }>;
  filter_models: string[];
  filter_providers: string[];
  filter_api_formats: string[];
  filter_user_agents: string[];
  filter_client_families: string[];
  aggregates: PostgresUsageAggregateRow[];
};

function escapePostgresLikePattern(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function mapPostgresUsageAggregate(row: PostgresUsageAggregateRow) {
  const requestCount = Number(row.request_count) || 0;
  const totalTokens = Number(row.total_tokens) || 0;
  const cost = Number(row.cost) || 0;
  const durationCount = Number(row.duration_count) || 0;
  const cacheRateInputTokens = Number(row.cache_rate_input_tokens) || 0;
  return {
    id: row.id,
    label: row.label,
    requestCount,
    promptTokens: Number(row.prompt_tokens) || 0,
    completionTokens: Number(row.completion_tokens) || 0,
    totalTokens,
    cacheReadTokens: Number(row.cache_read_tokens) || 0,
    cacheCreationTokens: Number(row.cache_creation_tokens) || 0,
    cacheReadReportedRequests: Number(row.cache_read_reported_requests) || 0,
    cacheCreationReportedRequests: Number(row.cache_creation_reported_requests) || 0,
    cost,
    actualCost: Number(row.actual_cost) || 0,
    successRate: requestCount > 0 ? (Number(row.success_count) || 0) / requestCount : 0,
    avgDurationMs:
      durationCount > 0 ? (Number(row.duration_total_ms) || 0) / durationCount : 0,
    cacheHitRate:
      cacheRateInputTokens > 0
        ? (Number(row.cache_rate_read_tokens) || 0) / cacheRateInputTokens
        : undefined,
    costPerMillionTokens: totalTokens > 0 ? (cost / totalTokens) * 1_000_000 : 0,
  };
}

function postgresUsageReportQueryParts(input: PostgresUsageReportInput) {
  const values: unknown[] = [];
  const parameter = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const baseConditions = [
    "upper(log.method) = 'POST'",
    "regexp_replace(split_part(log.request_path, '?', 1), '/+$', '') = any(array['/v1/chat/completions', '/v1/responses', '/v1/messages'])",
  ];
  if (input.feishuUserId) {
    baseConditions.push(`log.feishu_user_id = ${parameter(input.feishuUserId)}`);
  }
  if (input.scope?.scopeType === "department") {
    baseConditions.push(
      `coalesce(nullif(log.data->>'departmentId', ''), user_row.department_id) = ${parameter(input.scope.departmentId ?? "")}`,
    );
  }
  const dateConditions: string[] = [];
  if (input.startAt) dateConditions.push(`created_at >= ${parameter(input.startAt)}::timestamptz`);
  if (input.endAt) dateConditions.push(`created_at <= ${parameter(input.endAt)}::timestamptz`);
  const filteredConditions: string[] = [];
  if (input.userId) filteredConditions.push(`feishu_user_id = ${parameter(input.userId)}`);
  if (input.departmentId) {
    filteredConditions.push(`department_id = ${parameter(input.departmentId)}`);
  }
  if (input.model) filteredConditions.push(`model = ${parameter(input.model)}`);
  if (input.provider) filteredConditions.push(`provider = ${parameter(input.provider)}`);
  if (input.apiFormat) filteredConditions.push(`api_format = ${parameter(input.apiFormat)}`);
  if (input.userAgent) {
    filteredConditions.push(`user_agent = ${parameter(input.userAgent)}`);
  } else if (input.clientFamily) {
    filteredConditions.push(`client_family = ${parameter(input.clientFamily)}`);
  }
  if (input.status) {
    switch (input.status) {
      case "stream":
        filteredConditions.push("is_stream");
        break;
      case "standard":
        filteredConditions.push("not is_stream");
        break;
      case "active":
        filteredConditions.push("display_status in ('pending', 'streaming')");
        break;
      case "has_retry":
      case "has_fallback":
        filteredConditions.push("false");
        break;
      default:
        filteredConditions.push(`display_status = ${parameter(input.status)}`);
    }
  }
  if (input.hideUnknownRecords) {
    filteredConditions.push(
      "lower(trim(coalesce(model, ''))) not in ('', 'unknown', '-', 'null')",
      "lower(trim(coalesce(provider, ''))) not in ('', 'unknown', '-', 'null')",
      "lower(trim(coalesce(api_format, ''))) not in ('', 'unknown', '-', 'null')",
    );
  }
  if (input.search?.trim()) {
    const search = parameter(`%${escapePostgresLikePattern(input.search.trim().toLowerCase())}%`);
    filteredConditions.push(
      `lower(concat_ws(' ',
        user_data->>'name', user_data->>'openId', token_account_id, request_path,
        method, model, provider, provider_key_name, department_name, api_format,
        client_family, client_ip, user_agent, error_message
      )) like ${search} escape '\\'`,
    );
  }
  const currentPeriodParameter = parameter(nowIso().slice(0, 7));
  const limitParameter = parameter(input.limit);
  const offsetParameter = parameter(input.offset);
  return {
    values,
    baseWhere: baseConditions.join(" and "),
    dateWhere: dateConditions.length ? `where ${dateConditions.join(" and ")}` : "",
    filteredWhere: filteredConditions.length
      ? `where ${filteredConditions.join(" and ")}`
      : "",
    currentPeriodParameter,
    limitParameter,
    offsetParameter,
  };
}

export async function listPostgresUsageReport(input: PostgresUsageReportInput) {
  const query = postgresUsageReportQueryParts(input);
  return withPostgresControlClient(async (client) => {
    const result = await client.query<PostgresUsageReportRow>(
      `with base as materialized (
         select
           log.id,
           log.feishu_user_id,
           log.token_account_id,
           log.request_path,
           log.method,
           log.status_code,
           log.created_at,
           log.data as log_data,
           user_row.data as user_data,
           coalesce(nullif(log.data->>'departmentId', ''), user_row.department_id) as department_id,
           coalesce(nullif(log.data->>'departmentName', ''), user_row.data->>'departmentName') as department_name,
           log.data->>'model' as model,
           log.data->>'provider' as provider,
           log.data->>'providerKeyName' as provider_key_name,
           log.data->>'apiFormat' as api_format,
           log.data->>'clientFamily' as client_family,
           log.data->>'clientIp' as client_ip,
           log.data->>'userAgent' as user_agent,
           log.data->>'errorMessage' as error_message,
           case
             when log.data->>'status' in ('pending', 'streaming') then
               case
                 when log.status_code >= 400 or nullif(log.data->>'errorMessage', '') is not null then 'failed'
                 when log.data->>'status' = 'streaming' and log.data->>'firstByteMs' is null then 'pending'
                 else log.data->>'status'
               end
             when nullif(log.data->>'status', '') is not null then log.data->>'status'
             when log.status_code = 499 then 'cancelled'
             when log.status_code >= 400 then 'failed'
             else 'completed'
           end as display_status,
           (
             log.data->>'isStream' = 'true'
             or log.data->>'upstreamIsStream' = 'true'
             or log.data->>'clientRequestedStream' = 'true'
             or log.data->>'clientIsStream' = 'true'
           ) as is_stream,
           coalesce(nullif(log.data->>'promptTokens', '')::double precision, 0) as prompt_tokens,
           coalesce(nullif(log.data->>'completionTokens', '')::double precision, 0) as completion_tokens,
           coalesce(nullif(log.data->>'totalTokens', '')::double precision, 0) as total_tokens,
           nullif(log.data->>'cacheReadTokens', '')::double precision as cache_read_tokens,
           nullif(log.data->>'cacheCreationTokens', '')::double precision as cache_creation_tokens,
           case
             when nullif(log.data->>'inputTokensTotal', '') is not null
               then (log.data->>'inputTokensTotal')::double precision
             when coalesce(
               nullif(log.data->>'usageSemantic', ''),
               case
                 when log.data->>'apiFormat' like 'openai:%' then 'openai'
                 when log.data->>'apiFormat' = 'claude:messages' then 'anthropic'
               end
             ) = 'openai' then nullif(log.data->>'promptTokens', '')::double precision
             when coalesce(
               nullif(log.data->>'usageSemantic', ''),
               case
                 when log.data->>'apiFormat' like 'openai:%' then 'openai'
                 when log.data->>'apiFormat' = 'claude:messages' then 'anthropic'
               end
             ) = 'anthropic'
               and log.data->>'promptTokens' is not null
               and log.data->>'cacheReadTokens' is not null
               and log.data->>'cacheCreationTokens' is not null
               then (log.data->>'promptTokens')::double precision
                  + (log.data->>'cacheReadTokens')::double precision
                  + (log.data->>'cacheCreationTokens')::double precision
           end as input_tokens_total,
           case when log.data->>'usageSource' = 'newapi_log'
             then coalesce(nullif(log.data->>'cost', '')::double precision, 0)
             else 0
           end as cost,
           coalesce(nullif(log.data->>'actualCost', '')::double precision, 0) as actual_cost,
           coalesce(nullif(log.data->>'durationMs', '')::double precision, 0) as duration_ms
         from proxy_request_logs log
         left join feishu_users user_row on user_row.id = log.feishu_user_id
         where ${query.baseWhere}
       ),
       date_scoped as materialized (
         select * from base ${query.dateWhere}
       ),
       filtered as materialized (
         select * from date_scoped ${query.filteredWhere}
       ),
       aggregate_rows as materialized (
         select
           dimension.category,
           dimension.id,
           max(dimension.label) as label,
           count(*)::integer as request_count,
           sum(prompt_tokens)::double precision as prompt_tokens,
           sum(completion_tokens)::double precision as completion_tokens,
           sum(total_tokens)::double precision as total_tokens,
           coalesce(sum(cache_read_tokens), 0)::double precision as cache_read_tokens,
           coalesce(sum(cache_creation_tokens), 0)::double precision as cache_creation_tokens,
           count(cache_read_tokens)::integer as cache_read_reported_requests,
           count(cache_creation_tokens)::integer as cache_creation_reported_requests,
           coalesce(sum(cache_read_tokens) filter (
             where cache_read_tokens is not null and input_tokens_total > 0
           ), 0)::double precision as cache_rate_read_tokens,
           coalesce(sum(input_tokens_total) filter (
             where cache_read_tokens is not null and input_tokens_total > 0
           ), 0)::double precision as cache_rate_input_tokens,
           sum(cost)::double precision as cost,
           sum(actual_cost)::double precision as actual_cost,
           count(*) filter (where display_status = 'completed')::integer as success_count,
           coalesce(sum(duration_ms) filter (where duration_ms > 0), 0)::double precision as duration_total_ms,
           count(*) filter (where duration_ms > 0)::integer as duration_count
         from filtered
         cross join lateral (
           values
             ('model', coalesce(nullif(model, ''), 'unknown'), coalesce(nullif(model, ''), 'unknown')),
             ('department', coalesce(nullif(department_id, ''), 'unknown'), coalesce(nullif(department_name, ''), nullif(department_id, ''), 'unknown')),
             ('apiFormat', coalesce(nullif(api_format, ''), 'unknown'), coalesce(nullif(api_format, ''), 'unknown'))
         ) as dimension(category, id, label)
         group by dimension.category, dimension.id
       ),
       department_quota as materialized (
         select
           coalesce(nullif(user_row.department_id, ''), 'unknown') as department_id,
           sum(coalesce(nullif(billing.data->>'monthlyQuota', '')::double precision, 0))::double precision as issued_quota,
           sum(coalesce(nullif(billing.data->>'quotaConsumed', '')::double precision, 0))::double precision as used_quota
         from user_billing_periods billing
         left join feishu_users user_row on user_row.id = billing.feishu_user_id
         where billing.period = ${query.currentPeriodParameter}
         group by coalesce(nullif(user_row.department_id, ''), 'unknown')
       )
       select
         coalesce((
           select jsonb_agg(jsonb_build_object('log', page.log_data, 'user', page.user_data)
                            order by page.created_at desc, page.id)
           from (
             select id, created_at, log_data, user_data
             from filtered
             order by created_at desc, id
             limit ${query.limitParameter} offset ${query.offsetParameter}
           ) page
         ), '[]'::jsonb) as page,
         (select count(*)::integer from filtered) as total,
         coalesce((
           select jsonb_agg(user_filter.value order by coalesce(user_filter.value->>'name', user_filter.value->>'openId'))
           from (
             select distinct jsonb_strip_nulls(jsonb_build_object(
               'id', feishu_user_id,
               'name', user_data->>'name',
               'openId', user_data->>'openId',
               'departmentId', user_data->>'departmentId',
               'departmentName', user_data->>'departmentName'
             )) as value
             from date_scoped
             where feishu_user_id is not null and user_data is not null
           ) user_filter
         ), '[]'::jsonb) as filter_users,
         coalesce((
           select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', department_id, 'name', department_name))
                            order by department_id)
           from (
             select
               coalesce(nullif(department_id, ''), 'unknown') as department_id,
               max(nullif(department_name, '')) as department_name
             from date_scoped
             group by coalesce(nullif(department_id, ''), 'unknown')
           ) department_filter
         ), '[]'::jsonb) as filter_departments,
         coalesce((select jsonb_agg(value order by value) from (
           select distinct model as value from date_scoped where nullif(trim(model), '') is not null
         ) model_values), '[]'::jsonb) as filter_models,
         coalesce((select jsonb_agg(value order by value) from (
           select distinct provider as value from date_scoped where nullif(trim(provider), '') is not null
         ) provider_values), '[]'::jsonb) as filter_providers,
         coalesce((select jsonb_agg(value order by value) from (
           select distinct api_format as value from date_scoped where nullif(trim(api_format), '') is not null
         ) api_format_values), '[]'::jsonb) as filter_api_formats,
         coalesce((select jsonb_agg(value order by value) from (
           select distinct user_agent as value from date_scoped where nullif(trim(user_agent), '') is not null
         ) user_agent_values), '[]'::jsonb) as filter_user_agents,
         coalesce((select jsonb_agg(value order by value) from (
           select distinct client_family as value from date_scoped where nullif(trim(client_family), '') is not null
         ) client_family_values), '[]'::jsonb) as filter_client_families,
         coalesce((
           select jsonb_agg(
             to_jsonb(aggregate_row) || case
               when aggregate_row.category = 'department' then jsonb_build_object(
                 'issued_quota', coalesce(department_quota.issued_quota, 0),
                 'used_quota', coalesce(department_quota.used_quota, 0)
               )
               else '{}'::jsonb
             end
             order by aggregate_row.category, aggregate_row.total_tokens desc, aggregate_row.request_count desc
           )
           from aggregate_rows aggregate_row
           left join department_quota
             on aggregate_row.category = 'department'
            and department_quota.department_id = aggregate_row.id
         ), '[]'::jsonb) as aggregates`,
      query.values,
    );
    const row = result.rows[0] ?? {
      page: [],
      total: 0,
      filter_users: [],
      filter_departments: [],
      filter_models: [],
      filter_providers: [],
      filter_api_formats: [],
      filter_user_agents: [],
      filter_client_families: [],
      aggregates: [],
    };
    const mappedAggregates = row.aggregates.map((aggregate) => ({
      category: aggregate.category,
      stats: mapPostgresUsageAggregate(aggregate),
      issuedQuota: Number(aggregate.issued_quota) || 0,
      usedQuota: Number(aggregate.used_quota) || 0,
    }));
    return {
      page: row.page,
      total: Number(row.total) || 0,
      limit: input.limit,
      offset: input.offset,
      filters: {
        users: row.filter_users,
        departments: row.filter_departments,
        models: row.filter_models,
        providers: row.filter_providers,
        apiFormats: row.filter_api_formats,
        userAgents: row.filter_user_agents,
        clientFamilies: row.filter_client_families,
      },
      modelStats: mappedAggregates
        .filter((aggregate) => aggregate.category === "model")
        .map((aggregate) => aggregate.stats),
      departmentStats: mappedAggregates
        .filter((aggregate) => aggregate.category === "department")
        .map((aggregate) => ({
          ...aggregate.stats,
          issuedQuota: aggregate.issuedQuota,
          usedQuota: aggregate.usedQuota,
          usageRate:
            aggregate.issuedQuota > 0 ? aggregate.usedQuota / aggregate.issuedQuota : 0,
        })),
      apiFormatStats: mappedAggregates
        .filter((aggregate) => aggregate.category === "apiFormat")
        .map((aggregate) => aggregate.stats),
    };
  });
}
