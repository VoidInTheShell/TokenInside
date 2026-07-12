export const migration = {
  version: "20260712_004_zero_unassigned_billing_periods",
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
     where exists (
       select 1
       from app_settings settings
       where settings.id = 'default'
         and settings.data #>> '{quotaMigration,appliedAt}' is not null
     )
       and not exists (
         select 1
         from user_quota_policies policy
         where policy.feishu_user_id = billing.feishu_user_id
           and policy.effective_from_period <= billing.period
           and (policy.effective_to_period is null or policy.effective_to_period >= billing.period)
       )
       and not exists (
         select 1
         from quota_ledger_entries ledger
         where ledger.feishu_user_id = billing.feishu_user_id
           and ledger.period = billing.period
       )
       and not exists (
         select 1
         from token_accounts account
         where account.feishu_user_id = billing.feishu_user_id
           and account.status = 'active'
       )`,
  ],
};
