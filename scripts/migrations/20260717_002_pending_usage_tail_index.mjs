export const migration = {
  version: "20260717_002_pending_usage_tail_index",
  statements: [
    `create index if not exists proxy_request_logs_usage_pending_terminal_idx
       on proxy_request_logs (created_at)
       where data->>'usageSettlementStatus' in ('pending', 'retrying')
         and coalesce(data->>'terminalStatus', data->>'status', '')
           in ('completed', 'failed', 'cancelled')`,
  ],
};
