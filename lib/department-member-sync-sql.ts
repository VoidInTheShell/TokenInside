export const lockDepartmentMemberSyncUsersSql = `
  with lock_keys as materialized (
    select lock_key
    from unnest($1::text[]) as keys(lock_key)
    order by lock_key
  )
  select pg_advisory_xact_lock(hashtext(lock_key)::bigint)
  from lock_keys
`;

export const upsertDepartmentMembersSql = `
  insert into feishu_users
    (id, tenant_key, open_id, department_id, data, created_at, updated_at)
  select row.id, row.tenant_key, row.open_id, row.department_id,
         row.data, row.created_at, row.updated_at
  from jsonb_to_recordset($1::jsonb) as row(
    id text,
    tenant_key text,
    open_id text,
    department_id text,
    data jsonb,
    created_at timestamptz,
    updated_at timestamptz
  )
  on conflict (tenant_key, open_id) do update set
    department_id = excluded.department_id,
    data = excluded.data,
    updated_at = excluded.updated_at
  where feishu_users.department_id is null
     or feishu_users.department_id = excluded.department_id
  returning id
`;
