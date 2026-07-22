# TokenInside database initialization

`scripts/db-migrate.mjs` 在空 PostgreSQL 数据库中安装 `20260722_001_control_plane_baseline`，并将版本和 SHA-256 校验值写入 `schema_migrations`。

执行：

```bash
DATABASE_URL=postgresql://... npm run db:migrate
```

初始化过程由 PostgreSQL advisory lock 串行保护；同一版本重复执行是幂等的。已经记录的版本必须保持校验值一致。
