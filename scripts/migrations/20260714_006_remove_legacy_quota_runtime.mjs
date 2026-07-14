export const migration = {
  version: "20260714_006_remove_legacy_quota_runtime",
  statements: [
    `drop table if exists quota_reconciliation_records`,
    `drop table if exists user_quota_states`,
    `drop table if exists quota_ledger_entries`,
    `drop table if exists quota_operations`,
    `drop table if exists user_quota_policies`,
    `drop table if exists quota_change_events`,
    `drop table if exists department_quota_requests`,
    `drop table if exists department_quota_periods`,
    `drop table if exists user_billing_periods`,
    `drop table if exists token_requests`,
    `update app_settings
     set data = (data - 'defaultMonthlyQuota' - 'quotaFeatureFlags' - 'billingOperations')
     where id = 'default'`,
  ],
};
