# TokenInside database migrations

`scripts/db-migrate.mjs` applies migrations in lexical version order and records each version plus a SHA-256 checksum in PostgreSQL's `schema_migrations` table.

Create every schema or data change as a new module named `YYYYMMDD_NNN_descriptive_name.mjs`.

```js
export const migration = {
  version: "20260712_001_add_example_column",
  statements: ["alter table example add column if not exists example_value text"],
};
```

- Never edit an applied migration, including `20260711_001_baseline`; checksum mismatches intentionally stop deployment.
- Use additive, backward-compatible changes first. Remove legacy schema only after old application images are no longer needed.
- Every normal migration must be safe in a transaction. Do not add `CREATE INDEX CONCURRENTLY` without explicitly extending the runner.
- The deploy script creates a PostgreSQL dump before migration. It may roll back the application image, but never restores a database dump automatically.
