export const migration = {
  version: "20260714_007_package_key_source",
  statements: [
    `alter table token_accounts rename column token_request_id to source_request_id`,
    `update token_accounts
     set data = (data - 'tokenRequestId') || jsonb_build_object(
       'sourceRequestId', data->>'tokenRequestId'
     )
     where data ? 'tokenRequestId'`,
  ],
};
