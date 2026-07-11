export const migration = {
  version: "20260711_003_quota_ledger_maintenance_guard",
  statements: [
    `create or replace function tokeninside_reject_quota_ledger_mutation()
      returns trigger
      language plpgsql
      as $$
      begin
        if current_setting('tokeninside.allow_ledger_rewrite', true) = 'on' then
          if tg_op = 'DELETE' then
            return old;
          end if;
          return new;
        end if;
        raise exception 'quota_ledger_entries are immutable; write a reversing entry';
      end;
      $$`,
  ],
};
