export const migration = {
  version: "20260715_001_unique_proxy_usage_match",
  statements: [
    `with ranked as (
       select usage.id,
              usage.data->>'matchedProxyLogId' as matched_proxy_log_id,
              row_number() over (
                partition by usage.data->>'matchedProxyLogId'
                order by
                  case
                    when proxy.data->>'newapiLogId' = usage.newapi_log_id then 0
                    when proxy.data->>'newapiResponseRequestId' = usage.newapi_request_id then 1
                    when proxy.data->>'newapiResponseRequestId' = usage.data->>'newapiUpstreamRequestId' then 1
                    when proxy.data->>'promptTokens' = usage.data->>'promptTokens'
                     and proxy.data->>'completionTokens' = usage.data->>'completionTokens' then 2
                    else 3
                  end,
                  usage.last_synced_at desc,
                  usage.first_seen_at,
                  usage.id
              ) as row_number
       from newapi_usage_records usage
       left join proxy_request_logs proxy
         on proxy.id = usage.data->>'matchedProxyLogId'
       where usage.match_status = 'matched'
         and usage.data->>'matchedProxyLogId' is not null
     )
     update newapi_usage_records target
     set match_status = 'no_proxy_match',
         data =
           (target.data - 'matchedProxyLogId') ||
           jsonb_build_object(
             'matchStatus', 'no_proxy_match',
             'deduplicatedMatchedProxyLogId', ranked.matched_proxy_log_id,
             'deduplicatedReason', 'duplicate_proxy_usage_match',
             'deduplicatedAt', now()
           ),
         last_synced_at = now()
     from ranked
     where target.id = ranked.id
       and ranked.row_number > 1`,
    `create unique index if not exists newapi_usage_records_proxy_match_unique
       on newapi_usage_records ((data->>'matchedProxyLogId'))
       where match_status = 'matched'
         and data->>'matchedProxyLogId' is not null`,
  ],
};
