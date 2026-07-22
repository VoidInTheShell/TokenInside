# TokenInside

TokenInside 是飞书与 NewAPI 之间的业务控制面。飞书用户在 TokenInside 完成登录、套餐申请和审批后，获得归属于 NewAPI 同一承载用户的独立 Key；模型请求、余额扣减和用量日志均由 NewAPI 直接承载。

## 系统边界

- TokenInside：飞书 OAuth、组织与管理员范围、审批、Key 生命周期、套餐策略、套餐重置、用户与部门管理、NewAPI 数据可视化。
- NewAPI：Key 实际余额、模型请求、用量计费、请求日志与消费记录的权威数据源。
- 客户端：使用 TokenInside 展示的 NewAPI 地址与个人 Key 直接调用 NewAPI。
- 套餐重置：更新用户在 NewAPI 中的套餐额度上限，不删除 NewAPI 请求和消费日志。

TokenInside 不提供 `/v1/*` 模型请求入口，也不维护独立的消费账本或二次计费链路。

## 主要能力

- 飞书 OAuth 登录、会话绑定和组织信息同步。
- 飞书审批与管理后台审批处理。
- NewAPI Key 创建、查看、启用、禁用、轮换和删除。
- 用户套餐额度调整与按配置日自动重置。
- 用户管理、套餐管理、用户统计、部门统计和使用记录。
- 使用记录的搜索、筛选、排序、分页和首字/总耗时展示。
- PostgreSQL 状态存储、运行健康检查与 Docker Compose 部署。

## 目录

```text
app/          Next.js 页面与 API 路由
components/   React 与 shadcn 风格组件
lib/          飞书、NewAPI、权限、套餐和存储逻辑
scripts/      数据库初始化、部署检查与发布脚本
tests/        单元、契约和 PostgreSQL 功能测试
```

## 本地开发

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

开发服务默认监听 `127.0.0.1:16878`。

## Docker 部署

镜像发布到：

```text
ghcr.io/voidintheshell/tokeninside
```

常用标签包括 `staging`、`production`、`sha-<commit>` 和 `v<release>`。

独立 Compose 部署：

```bash
cp tokeninside.env.example .env
docker compose -f docker-compose.example.yml up -d --wait postgres
docker compose -f docker-compose.example.yml run --rm --no-deps --entrypoint node tokeninside scripts/db-migrate.mjs
docker compose -f docker-compose.example.yml run --rm --no-deps --entrypoint node tokeninside scripts/production-preflight.mjs
docker compose -f docker-compose.example.yml up -d --wait tokeninside
```

运行密钥只写入服务端环境文件，不写入镜像、前端资源或仓库。`NEWAPI_BASE_URL` 是 TokenInside 后端访问地址；当浏览器和客户端应使用不同地址时，通过 `NEWAPI_PUBLIC_BASE_URL` 单独配置。

## CI/CD

`.github/workflows/tokeninside-ci-cd.yml` 负责校验、构建和发布 Linux/AMD64 镜像。推送到 `main` 后，LA 专用 self-hosted runner 拉取不可变的 `sha-<commit>` 镜像，执行数据库初始化检查并更新应用容器。运行环境 `.env` 保留在服务端，GitHub 不托管服务端 SSH 私钥。

生产发布使用版本标签和受保护的 GitHub `production` Environment。

## 配置

以 `tokeninside.env.example` 为配置入口，重点包括：

- 飞书应用凭据、审批定义和事件校验配置。
- NewAPI 后端/公开地址、控制用户 ID 与服务端凭据。
- TokenInside 会话密钥和系统管理员 open_id。
- PostgreSQL 连接串、连接池与资源限制。
- 套餐操作并发和请求完成等待时间。

## License

当前未声明开源许可证。
