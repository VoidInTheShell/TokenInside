export const migration = {
  version: "20260717_005_zero_prewarm_only_billing_periods",
  statements: [
    `update user_billing_periods billing
     set data =
       (billing.data - 'assignedQuotaUpdatedAt' - 'assignedQuotaUpdatedByFeishuUserId') ||
       jsonb_build_object(
         'monthlyQuota', 0,
         'remainingQuota', 0,
         'authorizedQuota', 0,
         'expectedAvailableQuota', 0,
         'overageQuota', 0,
         'materializedAt', now()
       ),
       updated_at = now()
     where coalesce(billing.data->>'assignedQuotaUpdatedAt', '') = ''
       and exists (
         select 1
         from token_accounts account
         where account.feishu_user_id = billing.feishu_user_id
           and account.billing_period = billing.period
           and account.status = 'pending_activation'
           and account.data->>'prewarmedAt' is not null
           and account.token_request_id like 'prewarm:%'
       )
       and not exists (
         select 1
         from token_accounts account
         where account.feishu_user_id = billing.feishu_user_id
           and account.billing_period = billing.period
           and not (
             account.status = 'pending_activation'
             and account.data->>'prewarmedAt' is not null
             and account.token_request_id like 'prewarm:%'
           )
       )
       and not exists (
         select 1
         from token_requests request
         join token_accounts issued_account
           on issued_account.token_request_id = request.id
         where request.feishu_user_id = billing.feishu_user_id
           and request.status = 'provisioned'
           and issued_account.billing_period = billing.period
       )
       and not exists (
         select 1 from quota_ledger_entries ledger
         where ledger.feishu_user_id = billing.feishu_user_id
           and ledger.period = billing.period
           and ledger.signed_quota <> 0
       )
       and coalesce(nullif(billing.data->>'quotaConsumed', '')::numeric, 0) = 0
       and coalesce(nullif(billing.data->>'proxyLogCount', '')::integer, 0) = 0
       and coalesce(nullif(billing.data->>'usageRecordCount', '')::integer, 0) = 0`,
  ],
};
