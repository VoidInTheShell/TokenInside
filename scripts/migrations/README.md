# TokenInside greenfield database migrations

`scripts/db-migrate.mjs` installs the immutable `20260717_001_greenfield_baseline`, then applies future schema migrations in lexical version order. Every applied version and SHA-256 checksum is recorded in PostgreSQL's `schema_migrations` table.

The baseline is intentionally greenfield-only. It refuses legacy or unknown migration histories and refuses a database that already contains TokenInside business tables. Provision a new PostgreSQL database instead of pointing this installer at an older TokenInside database.

Create every schema or data change as a new module named `YYYYMMDD_NNN_descriptive_name.mjs`.

```js
export const migration = {
  version: "20260712_001_add_example_column",
  statements: ["alter table example add column if not exists example_value text"],
};
```

- Never edit the applied greenfield baseline or an applied follow-up migration; checksum mismatches intentionally stop deployment.
- Use additive, backward-compatible changes first. Remove legacy schema only after old application images are no longer needed.
- Every normal migration must be safe in a transaction. Do not add `CREATE INDEX CONCURRENTLY` without explicitly extending the runner.
- The deploy script creates a PostgreSQL dump before migration. It may roll back the application image, but never restores a database dump automatically.
- `quota_ledger_entries` is immutable for the application database role. Corrections must be new reversing entries; migrations must not use a session flag to rewrite or delete ledger history.
