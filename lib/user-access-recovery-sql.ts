/**
 * Fail-closed CAS used only after the upstream Key has been disabled and while
 * the caller owns the user's session-level quota execution fence.
 *
 * The three local projections move together or not at all. In particular, a
 * concurrent/previous resume finalizer changes admission to `open`, causing
 * the locked CTE to return no row and protecting the completed resume.
 */
export const rollbackPendingUserAccessResumeSql = `
with locked as materialized (
  select
    u.data as user_data,
    a.data as account_data,
    q.data as quota_state_data
  from feishu_users u
  join token_accounts a
    on a.id = $2
   and a.feishu_user_id = u.id
  join user_quota_states q
    on q.feishu_user_id = u.id
  where u.id = $1
    and u.data->>'status' = 'active'
    and a.status = 'active'
    and q.admission = 'closed'
    and q.data->>'closedReason' = 'user_access_resume_pending'
  for update of u, a, q
),
updated_user as (
  update feishu_users u
  set data = locked.user_data || jsonb_build_object(
        'status', 'disabled',
        'updatedAt', $3::text,
        'disabledAt', $3::text,
        'disabledReason', $5::text
      ),
      updated_at = $3::timestamptz
  from locked
  where u.id = $1
  returning u.data
),
updated_account as (
  update token_accounts a
  set status = 'disabled',
      disabled_at = $3::timestamptz,
      data = locked.account_data || jsonb_build_object(
        'status', 'disabled',
        'disabledAt', $3::text
      )
  from locked, updated_user
  where a.id = $2
  returning a.data
),
updated_state as (
  update user_quota_states q
  set admission = 'closed',
      operation_id = null,
      data = (
        locked.quota_state_data
        - 'operationId'
        - 'resumeTokenAccountId'
        - 'resumePreparedAt'
        - 'resumeUpstreamEnableAttemptedAt'
      ) || jsonb_build_object(
        'admission', 'closed',
        'closedReason', 'user_access_revoked',
        'upstreamDisabledAt', $3::text,
        'consumptionBarrierCutoffAt', $4::text,
        'updatedAt', $3::text
      ),
      updated_at = $3::timestamptz
  from locked, updated_account
  where q.feishu_user_id = $1
  returning q.data
)
select
  updated_user.data as user,
  updated_account.data as account,
  updated_state.data as quota_state
from updated_user, updated_account, updated_state`;

export const listStaleUserAccessResumeCandidatesSql = `
select u.data as user, account.data as account, q.data as quota_state
from user_quota_states q
join feishu_users u on u.id = q.feishu_user_id
join lateral (
  select a.data
  from token_accounts a
  where a.feishu_user_id = q.feishu_user_id
    and a.status = 'active'
    and (
      q.data->>'resumeTokenAccountId' is null
      or a.id = q.data->>'resumeTokenAccountId'
    )
  order by a.created_at desc, a.id desc
  limit 1
) account on true
where q.admission = 'closed'
  and q.data->>'closedReason' = 'user_access_resume_pending'
  and q.updated_at <= $1
  and u.data->>'status' = 'active'
order by q.updated_at, q.feishu_user_id
limit $2`;

export const markUserAccessResumeEnableAttemptSql = `
with locked as materialized (
  select q.data as quota_state_data
  from user_quota_states q
  join feishu_users u on u.id = q.feishu_user_id
  join token_accounts a
    on a.id = $2
   and a.feishu_user_id = q.feishu_user_id
  where q.feishu_user_id = $1
    and q.admission = 'closed'
    and q.data->>'closedReason' = 'user_access_resume_pending'
    and (
      q.data->>'resumeTokenAccountId' is null
      or q.data->>'resumeTokenAccountId' = $2
    )
    and u.data->>'status' = 'active'
    and a.status = 'active'
  for update of q, u, a
)
update user_quota_states q
set operation_id = null,
    data = (locked.quota_state_data - 'operationId') || jsonb_build_object(
      'resumeTokenAccountId', $2::text,
      'resumePreparedAt', coalesce(
        locked.quota_state_data->>'resumePreparedAt',
        locked.quota_state_data->>'updatedAt',
        $3::text
      ),
      'resumeUpstreamEnableAttemptedAt', $3::text,
      'updatedAt', $3::text
    ),
    updated_at = $3::timestamptz
from locked
where q.feishu_user_id = $1
returning q.data`;
