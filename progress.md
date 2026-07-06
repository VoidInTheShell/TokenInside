# TokenInside 实现方案完善进度

## 2026-07-02

1. 读取 `AGENTS.md`，确认项目边界：不新增认证方式、认证对接 NewAPI 后端、key 归属到飞书用户、TokenInside 负责透传。
2. 查阅飞书官方文档，确认 MVP 最小权限只需要网页应用免登与基础用户信息链路，不需要默认申请通讯录、消息、审批、云文档权限。
3. 读取 `.agent-docs/共绩内部团队申请Token方案.md` 和 `.agent-docs/TokenInside-飞书NewAPI单用户多Key透传实现方案.md`。
4. 创建规划文件前第一次 `apply_patch` 因补丁结束标记写错失败，未产生文件；修正后继续。
5. 进一步查阅飞书审批官方文档，确认创建审批实例需要 `tenant_access_token`，权限建议使用较小的 `approval:instance`，审批定义建议由管理员在飞书审批后台预先创建。
6. 查阅飞书通讯录部门和用户接口文档，确认部门主管后台需要部门树、负责人、用户基础信息和用户部门归属的颗粒度只读权限。
7. 更新 `.agent-docs/TokenInside-飞书NewAPI单用户多Key透传实现方案.md`：新增飞书应用后台配置、权限申请矩阵、免登/OAuth 链路、审批实例最小权限、部门主管通讯录权限、飞书侧实测清单、MVP 权限交付项和最终建议。
8. 同步更新 `findings.md` 和 `task_plan.md`，并用只读搜索确认旧的 `feishu_open_id UNIQUE` 约束没有残留。
9. 根据计费规则讨论，补充 `.agent-docs/TokenInside-飞书NewAPI单用户多Key透传实现方案.md` 的 `13.3 计费、key 重置与月度账期规则`：明确计费按飞书用户聚合，key 重置只轮换凭证不重置额度，旧 key 禁用但保留，新 key 继承当期剩余额度，月度重置只初始化新账期 active key 可用额度，不改写历史用量，并新增 5 分钟同步校准规则。
10. 同步补充数据库设计：`token_accounts` 增加 `billing_period`、`replaced_by_token_account_id`、`disabled_at`、`reset_request_id` 等字段，新增建议表 `user_billing_periods`，并在最终建议中明确个人额度权威口径为 TokenInside 审批记录 + NewAPI logs 聚合。
11. 根据澄清后的审批口径完善总方案：用户在 TokenInside 发起申请后，TokenInside 以应用身份创建飞书审批实例，并指定当前飞书用户为发起人；部门主管在飞书中审批，TokenInside 通过 `approval_instance` 事件回写结果并发放 NewAPI key。
12. 更新总方案第 7 节，补充审批定义前置配置、`department_id` 多部门处理、审批事件订阅、审批状态机、key 发放失败补偿、额度重置/key 重置扩展路径。
13. 更新权限矩阵、数据库字段、安全边界、飞书实测清单、MVP 范围和最终建议，明确不默认申请 `approval:task`，不实现系统代主管审批。
14. 根据 `AGENTS.md` 新增后端环境信息同步总方案：客户端 Base URL 改为 `https://ti.kumiko-love.com/v1`，补充测试 NewAPI 端点 `https://new-api.550w.link`、`NEWAPI_SYSTEM_AK` 后端密钥边界、USLA 测试部署、`16878` 服务端口以及 GreenJP / BunkerWeb 反代链路。
15. 确认当前方案此前没有明确前端技术约束；已在总方案新增 `2.1 前端实现约束`，明确 TokenInside 控制面前端采用 shadcn/ui 风格和组件体系，并同步更新最终建议与计划风险项。
16. 开始方案落地，初始化 Next.js 16 + React 19 工程，新增 `package.json`、`next.config.ts`、`tsconfig.json`、`components.json`、`.env.example`、App Router 页面和全局样式。
17. 新增 shadcn 风格本地 UI 组件和 `components/experience-client.tsx`，完成 Token 申请、客户端 Base URL、active key、审批记录和未登录飞书状态的控制面首屏。
18. 新增服务端核心模块：`lib/config.ts`、`lib/crypto.ts`、`lib/types.ts`、`lib/store.ts`、`lib/session.ts`、`lib/feishu.ts`、`lib/newapi.ts`、`lib/provisioning.ts`。
19. 新增 API 路由：飞书 OAuth 回调、当前会话、Token 申请、key 查看、飞书审批事件回写，以及 `/v1/[...path]` NewAPI 透传代理。
20. 运行 `npm install` 成功安装依赖；初次 `npm audit` 报 Next 间接依赖 `postcss` moderate 漏洞，因 `--force` 会降级 Next，改用 `overrides.postcss=^8.5.10` 后重新安装并确认 0 vulnerabilities。
21. 运行 `npm run typecheck` 通过；运行 `npm run build` 通过。初次构建有 Turbopack NFT 追踪警告，已通过 `turbopackIgnore` 注释修复，二次构建无警告。
22. 启动本地开发服务 `http://127.0.0.1:16878`，浏览器打开首页成功，控制台无 error/warn；`/api/session` 返回未登录会话，`/v1/models` 携带未绑定 key 返回 403，符合代理绑定校验预期。
23. 根据“先把所有计划文档全部落地”要求，新增 `.agent-docs/TokenInside-实施总路线图.md`，固化 A 到 E 阶段总路线、风险排序、推荐执行顺序和文档维护规则。
24. 新增 `.agent-docs/TokenInside-B阶段真实链路实测计划.md`，细化飞书 OAuth、审批实例、审批事件、NewAPI token 管理和 `/v1` 代理的实测任务、验收标准和需确认契约。
25. 新增 `.agent-docs/TokenInside-C阶段数据库生产化计划.md`，细化 PostgreSQL 表结构、唯一约束、ORM 选择、store 迁移、事务状态机和 JSON 导入。
26. 新增 `.agent-docs/TokenInside-D阶段部署运维计划.md`，细化 Docker/Compose、USLA `16878` 部署、`ti.kumiko-love.com` 反代、健康检查、日志和 NewAPI 防绕过策略。
27. 新增 `.agent-docs/TokenInside-E阶段管理后台与用量统计计划.md`，细化用户后台、管理员范围、部门同步、用量同步、管理页面、调额和 key/额度重置。
28. 更新 `task_plan.md` 增加 B/C/D/E 总控阶段、计划文档索引和下一阶段入口；更新 `findings.md` 记录阶段拆分和关键实测风险。
29. 继续 B 阶段落地，确认本地 Next.js dev server 在 `16878`，Next MCP `get_errors` 无 config/session 错误，路由包含 `/api/auth/feishu/callback`、`/api/feishu/events`、`/api/token/request`、`/api/token/key` 和 `/v1/[...path]`。
30. 读取 B 阶段计划，确认当前仓库缺少 `.env.local`，因此真实飞书 OAuth、审批创建、审批回调和 NewAPI token 变更调用不能在本机直接完成。
31. 查阅 upstream NewAPI 源码，确认 `/api/token` 创建不返回 id/key，完整 key 需 `POST /api/token/:id/key`，控制面 API 需要 `Authorization` 与 `New-Api-User`。
32. 更新 `lib/newapi.ts`：新增 `NEWAPI_CONTROL_USER_ID` 请求头支持，创建 token 后按唯一 name 搜索 id，再获取完整 key；补齐禁用 token 和更新 quota 的封装。
33. 更新 `lib/feishu.ts`、`lib/crypto.ts` 和 `/api/feishu/events`：支持飞书加密事件解包、verification token 校验、challenge、字段多路径提取、事件幂等和失败记录。
34. 新增 `scripts/b-stage-check.mjs` 与 `npm run b:check`，用于本地检查 B 阶段环境变量 readiness，并可在填入真实 `.env.local` 后按参数执行 Feishu/NewAPI 读写探测。
35. 运行 `npm run typecheck` 通过；首次直接运行检查脚本因沙箱启动限制失败，使用已批准的 `npm run b:check` 后成功执行，输出当前缺少 B 阶段真实环境变量。
36. 运行 `npm run build` 通过，Next.js 16.2.10 生产构建成功，动态路由包含所有 API 和 `/v1/[...path]`。
37. 本地 API 冒烟：`/api/session` 未登录返回正常；`/api/feishu/events` challenge 返回 `{"challenge":"ti-check"}`；`/v1/models` 未携带 Bearer key 返回 401，符合预期。
38. Next MCP `get_errors` 复查仍无 config/session 错误。
39. 执行密钥落盘检查，排除 `AGENTS.md` 和 `.agent-docs` 后未发现用户提供的 NewAPI System AK 写入源码、示例配置或脚本。
40. `next-env.d.ts` 因 `next build` 自动从 `.next/dev/types/routes.d.ts` 切换为 `.next/types/routes.d.ts`，这是 Next 生成文件变化；未手写修改。
41. 根据用户要求推进 B1/B4 前置梳理，读取 B 阶段计划、`.env.example`、`scripts/b-stage-check.mjs`、`lib/config.ts`、`lib/feishu.ts`、`lib/newapi.ts`、飞书 OAuth 回调、Token 申请、key 查看、发放和 `/v1` 代理代码。
42. 通过 Next MCP 确认本地 dev server 位于 `http://127.0.0.1:16878`，`get_errors` 无 config/session 错误，App Router 路由包含 B1/B4 所需入口。
43. 执行 `npm run b:check`，确认当前没有可用 `.env.local` 被加载，B1/B4 所需 `TOKENINSIDE_SESSION_SECRET`、飞书应用凭据、NewAPI base URL、`NEWAPI_CONTROL_USER_ID` 和 NewAPI 控制面凭据均缺失。
44. 读取 `.gitignore`，确认 `.env` 与 `.env.*` 已忽略，真实密钥可写入 `.env.local` 而不进入 git。
45. 更新 `.agent-docs/TokenInside-真实链路实测记录.md`，补充 B1/B4 推进前置清单、当前本地状态和建议执行顺序。
46. 根据飞书事件订阅 Request URL 必须公网验证的问题，调整计划为服务器优先：D 阶段部署工作前置合入 B0，最终调试产物改为 Docker 镜像，真实链路直接在 USLA + `ti.kumiko-love.com` 上验证。
47. 继续 B0，新增 Docker 部署基础件：`Dockerfile`、`.dockerignore`、`.env.production.example`、`docker-compose.example.yml`、`app/api/health/route.ts`，并将 `next.config.ts` 配置为 `output: "standalone"`，`npm start` 监听 `0.0.0.0:16878`。
48. 运行 `npm run typecheck` 通过；运行 `npm run build` 通过，生产路由新增 `/api/health`。
49. 本机 Docker Desktop 启动后运行 `docker build -t tokeninside:latest .` 成功，Dockerfile 内部 `npm ci` 审计 0 vulnerabilities，容器构建阶段 `npm run build` 通过。
50. 以 `tokeninside:latest` 启动本地临时容器，宿主 `127.0.0.1:16879` 映射容器 `16878`，使用 `.env.production.example` 验证生产容器启动。
51. 本地容器 B0 冒烟通过：`/api/health` 返回 `status: ok` 且 JSON store 可写，`/api/session` 未登录返回 JSON，`/api/feishu/events` challenge 返回 `{"challenge":"ti-check"}`，`/v1/models` 无 Authorization 返回 401，未绑定 Bearer key 返回 403，首页返回 200。
52. 查看本地容器日志，只包含 Next.js 启动和 Ready 信息，未打印 NewAPI key、System AK、飞书 App Secret 或 session secret；随后停止并移除临时容器。
53. 用户将认证信息放入 `.env` 后，执行 `npm run b:check`，确认 `.env` 可被脚本加载；当前具备 `TOKENINSIDE_SESSION_SECRET`、飞书 App ID/Secret、NewAPI base URL、`NEWAPI_CONTROL_USER_ID` 和 NewAPI 控制面凭据。
54. 执行 `npm run b:check -- --feishu` 通过，飞书 `tenant_access_token` 可正常获取。
55. 首次执行 `npm run b:check -- --newapi` 失败，NewAPI 返回 `LLMAPI-User not provided`；据此更新 `lib/newapi.ts` 与 `scripts/b-stage-check.mjs`，在控制面请求中同时发送 `New-Api-User` 和 `LLMAPI-User`。
56. 重新执行 `npm run b:check -- --newapi` 通过，NewAPI `/api/token` 只读访问成功。
57. 执行 `npm run b:check -- --mutate-newapi` 通过，创建 `TI-bcheck-*` 测试 token、搜索 token id、确认完整 key 可读取并立刻禁用测试 token；脚本未打印明文 key。
58. 将 `FEISHU_APPROVAL_EVENT_ENCRYPT_KEY` 在 readiness 输出中改为可选项，避免未启用飞书事件加密时误判；`FEISHU_APPROVAL_CODE_TOKEN_REQUEST` 和 `FEISHU_APPROVAL_EVENT_VERIFICATION_TOKEN` 仍缺失，B2/B3 审批链路暂不能闭环。
59. 运行 `npm run typecheck`、`npm run build` 和 `docker build -t tokeninside:latest .` 均通过；Next MCP `get_errors` 无 config/session 错误。
60. 按用户要求改为本地构建并推送 Docker Hub，服务器不做源码构建；已将本地镜像标记并推送为 `voidintheshell/tokeninside:b0-20260702-1526` 与 `voidintheshell/tokeninside:latest`。
61. Docker Hub 镜像 digest 为 `sha256:77faf6da8a61fac4f5033582563af3f8c7305fe31ed4f7ea158a0c324a25d3d7`，本地 `docker images` 显示两个 tag 指向同一 image id，大小约 279MB。
62. 上传服务器私有 `.env.production` 到 `/home/beihai/tokeninside/.env.production` 并设置 `chmod 600`；未将真实密钥写入仓库或文档。
63. 上传 pull-only `docker-compose.yml` 到 `/home/beihai/tokeninside`，执行 `sudo -n docker compose pull` 与 `up -d` 后容器 `tokeninside-tokeninside-1` 使用 Hub 镜像运行，状态为 `running` / `healthy`。
64. 首次公网反代因 compose 仅绑定 `127.0.0.1:16878` 返回 502；将端口发布改为 `16878:16878` 后，宿主监听 `0.0.0.0:16878`，公网 GET 链路恢复。
65. 远端本机直连验证通过：`/api/health` 返回 `status: ok` 且 store writable，`/api/feishu/events` challenge 返回 200 JSON，`/v1/models` 无认证返回 401 JSON，未绑定 key 返回 403 JSON，首页返回 200。
66. 公网 `https://ti.kumiko-love.com/api/health`、`/api/session` 和 `/` 当前返回 200；`/v1/models` 无认证返回 401、未绑定 key 返回 403，但响应体被 BunkerWeb 替换为 HTML。
67. 公网 POST `/api/feishu/events` challenge 当前返回 BunkerWeb 400 HTML；同一请求服务器本机直连返回 200 JSON，说明应用路由可用，飞书事件订阅前需修正 BunkerWeb 对该 POST 路径的处理。
68. B0 当前结论：代码、镜像、本地生产容器、Docker Hub 推送和 USLA pull-only 部署已完成；继续 B1/B2/B3 前需要补齐飞书审批环境变量，并修复 BunkerWeb 对事件 POST 与 `/v1` JSON 错误体的拦截。
69. 根据用户追问复查 `/api/feishu/events`，确认路由文件存在且实现为 `POST`；使用 Linux curl 发送有效 JSON challenge 到公网域名返回 200 `application/json`，此前 400 是 PowerShell curl 引号导致无效 JSON 的测试误差。
70. 在 `RemoteJPGreenSB` 备份 BunkerWeb 配置相关表到 `/home/beihai/docker/bunkerweb/backups/ti-kumiko-bw-before-20260702T080825Z.sql.gz`。
71. 给 BunkerWeb live DB 中 `ti.kumiko-love.com` service 增加 `REVERSE_PROXY_INTERCEPT_ERRORS=no`，重启 `bw-scheduler` 后生成配置，确认 `/etc/nginx/ti.kumiko-love.com/server-http/reverse-proxy.conf` 为 `proxy_intercept_errors off;`。
72. 公网复测通过：`/v1/models` 无认证返回 401 `application/json`，未绑定 key 返回 403 `application/json`，`POST /api/feishu/events` challenge 返回 200 `application/json`，无效 JSON payload 返回 TokenInside 自身的 400 `application/json`。
73. B0 反代层结论更新：事件入口无需额外 WAF 放行；已完成错误体透传配置，后续 B1/B2/B3 的剩余外部阻塞仍是飞书审批 code 与事件 verification token。
74. 用户补齐所需 key 后，执行 `npm run b:check`，确认 `FEISHU_APPROVAL_CODE_TOKEN_REQUEST`、`FEISHU_APPROVAL_EVENT_VERIFICATION_TOKEN` 和 `FEISHU_APPROVAL_EVENT_ENCRYPT_KEY` 已配置；未打印密钥值。
75. 执行 `npm run b:check -- --all` 通过，飞书 `tenant_access_token` 可获取，NewAPI `/api/token` 只读访问成功。
76. 检查线上 `/api/health`，确认远端在更新前仍显示 `approvalCode=false`、`approvalEventVerification=false`、`approvalEventEncryption=false`。
77. 发现本地 `.env` 的 `TOKENINSIDE_SESSION_SECRET` 仍是占位符，因此未整文件覆盖远端环境；只把三项飞书审批变量合并到 `/home/beihai/tokeninside/.env.production`，并保留远端原有 session secret。
78. 远端 `.env.production` 更新前备份为 `.env.production.before-approval-20260702T082337Z`；容器 `tokeninside-tokeninside-1` 已用同一 Hub 镜像 `voidintheshell/tokeninside:b0-20260702-1526` 重建并恢复 healthy。
79. 复测远端本机和公网 `/api/health`，确认 `approvalCode`、`approvalEventVerification`、`approvalEventEncryption` 均为 true。
80. 在远端容器内构造签名加密飞书 challenge，经 `https://ti.kumiko-love.com/api/feishu/events` 返回 200 `{"challenge":"ti-encrypted-check"}`，验证线上签名校验、AES 解密、verification token 和反代 POST 链路均可用。
81. 调用飞书审批事件订阅接口绑定当前 `approval_code`，首次返回 `code=0 msg=success`；随后将该动作沉淀为 `npm run b:check -- --subscribe-approval`。
82. `npm run b:check -- --subscribe-approval` 首次复跑遇到飞书返回 `subscription existed`，已将脚本改为幂等成功；最终复跑输出 `Feishu approval event subscribe - already subscribed`。
83. 执行 `npm run typecheck` 通过；执行公网 `GET https://ti.kumiko-love.com/v1/models` 无 key 仍返回 401 `application/json`，反代错误体透传保持正常。
84. 收尾验证：`npm run build`、`npm run b:check -- --all`、`npm run b:check -- --subscribe-approval` 均通过；远端容器 healthy，线上 `/api/health` 所有关键配置为 true，近期容器日志只有 Next.js 启动 Ready 信息。
85. 提交前将 `scripts/b-stage-check.mjs` 改为识别 `TOKENINSIDE_SESSION_SECRET` 占位符；本地 `.env` 会显示该项 missing，但飞书 tenant token、NewAPI 只读和审批订阅幂等检查仍通过，远端生产 session secret 未被覆盖。
86. 根据飞书“管理员后台”和移动端入口讨论更新计划文档：普通入口与移动端主页统一为 `https://ti.kumiko-love.com`，管理员后台入口为 `https://ti.kumiko-love.com/admin`，但管理权限仍由 TokenInside 服务端基于飞书 OAuth、部门主管关系和 `admin_scopes` 计算；同步更新总方案、E 阶段计划、实施路线图、`task_plan.md` 和 `findings.md`。
87. 本次使用 `planning-with-files-zh` 恢复上下文时，`session-catchup.py` 在 Windows 沙箱中触发 `CreateProcessWithLogonW failed: 1326`；已直接读取 `task_plan.md`、`findings.md` 和 `progress.md` 继续，未影响文档修改。
88. 本轮继续使用 `planning-with-files-zh` 恢复计划；再次运行 `session-catchup.py` 仍因 Windows 沙箱触发 `CreateProcessWithLogonW failed: 1326`，已沿用直接读取计划文件的方式继续。
89. 通过 Next MCP 确认 dev server 位于 `http://localhost:16878`，初始路由没有 `/admin`，与飞书后台管理员入口计划不一致；决定前置 E0 管理入口壳。
90. 新增 `AdminScope` 类型、JSON store `adminScopes` 字段、`getAdminScopeForUser` 与 `getAdminOverview`，管理概览按 `global` 或 `department` 范围过滤 users、token requests、token accounts 和 proxy logs。
91. 新增 `GET /api/admin/overview`：未登录直接访问返回 401，已登录但无管理范围返回 403，有管理范围返回只读概览；页面可用 `?mode=soft` 读取状态体且不产生浏览器 console error。
92. 新增 `components/admin-client.tsx` 和 `app/admin/page.tsx`，实现 shadcn 风格管理后台入口壳，复用飞书免登、显示管理范围、状态概览和最新申请；首页侧边栏已增加 `/admin` 导航。
93. 首次类型检查发现两个问题：`AdminOverviewResponse["overview"]["scope"]` 未处理可选字段，以及 ES2022 lib 不支持 `toSorted`；已改为 `NonNullable` 类型别名和 `[...array].sort(...)`。
94. 浏览器首次打开 `/admin` 时，未登录 API 401 被 Chrome 记录为 console error；已给管理 API 增加 `mode=soft`，保留直接 API 401/403，同时让页面正常未登录状态无 console error。
95. 验证结果：`npm run build` 通过，路由包含 `/admin` 与 `/api/admin/overview`；直接 `GET /api/admin/overview` 返回 401 JSON；soft 请求返回 200 JSON；Next MCP `get_errors` 无 config/session 错误。
96. 一次并行执行 `npm run typecheck` 和 `npm run build` 时，`tsc` 因 `.next/types/cache-life.d.ts`、`.next/types/validator.ts` 被 build 重写而短暂缺失失败；单独复跑 `npm run typecheck` 已通过。
97. 浏览器最终复查 `/admin`：快照显示中文未登录/未授权状态、当前用户为 `-`，console 无 error/warn；截图保存为 `.local-data/admin-page-final.png`。
98. 按“本地构建、推送 Docker Hub、服务端只拉取运行”的约束构建新镜像：`tokeninside:e0-admin-20260702-1710`、`voidintheshell/tokeninside:e0-admin-20260702-1710` 和 `voidintheshell/tokeninside:latest`；Docker 构建阶段 `npm run build` 通过，路由包含 `/admin` 与 `/api/admin/overview`。
99. 已推送 Docker Hub：`voidintheshell/tokeninside:e0-admin-20260702-1710` 与 `voidintheshell/tokeninside:latest`，digest 均为 `sha256:23e6d5e9ba9fea04d77e18a2a0cb49a5659ab858c151ac496728f37cb86f56f1`。
100. 中断恢复后确认远端 compose 已指向新 tag，但容器仍运行旧 `b0-20260702-1526`；随后执行 `sudo -n docker compose pull` 和 `sudo -n docker compose up -d`，未在服务器执行源码构建。
101. 远端 compose 替换前备份为 `/home/beihai/tokeninside/docker-compose.yml.before-e0-admin-20260702-1710`；当前容器 `tokeninside-tokeninside-1` 使用 `voidintheshell/tokeninside:e0-admin-20260702-1710`，镜像 digest `sha256:23e6d5e9ba9fea04d77e18a2a0cb49a5659ab858c151ac496728f37cb86f56f1`，状态 running/healthy。
102. 远端本机验证通过：`/api/health` 200 JSON 且所有关键配置为 true，`/admin` 200 HTML，`/api/admin/overview` 未登录返回 401 JSON。
103. 公网验证通过：`https://ti.kumiko-love.com/api/health` 200 JSON，`/admin` 200 HTML，`/api/admin/overview` 未登录 401 JSON，`/api/admin/overview?mode=soft` 200 JSON，`/v1/models` 无 key 保持 TokenInside JSON 401。
104. 用户反馈当前已在飞书 H5/客户端内打开 TokenInside，但仍报“当前浏览器没有检测到飞书 H5 JSAPI，请从飞书工作台应用入口打开。”；据此将 B1 从等待端内实测改为先处理 H5 JSSDK/JSAPI 初始化阻塞。
105. 新增 `.agent-docs/TokenInside-B1飞书H5免登修复计划.md`，覆盖 JSSDK loader、`h5sdk.ready()`、`requestAccess.appID`、`requestAuthCode.appId` 回退、OAuth v3 token 交换、自动免登、验证和 Docker Hub/USLA pull-only 部署复测。
106. 同步更新 `task_plan.md` 计划文档索引、当前落地状态和下一阶段入口；同步更新 `findings.md` 记录飞书端内 H5 JSAPI 检测失败的根因边界与修复方向。
107. 同步更新 `.agent-docs/TokenInside-B阶段真实链路实测计划.md` 的 B1 小节，把当前阻塞改为先执行 B1 H5 免登专项修复，再继续审批申请实测。
108. 继续 B1 修复落地，新增 `components/feishu-login.tsx`：按飞书/Lark 端内环境加载 H5 JSSDK，等待 `h5sdk.ready()`，优先调用 `tt.requestAccess({ appID, scopeList: [] })`，并在旧客户端/`errno=103` 时回退 `tt.requestAuthCode({ appId })`。
109. 新增 `GET /api/feishu/app-id`，只读返回 `FEISHU_APP_ID`，不暴露 App Secret、tenant token、user token 或 NewAPI key。
110. 修改 `lib/feishu.ts`：`exchangeFeishuCode()` 改用 `https://accounts.feishu.cn/oauth/v3/token`，按顶层 `access_token` 响应解析，并兼容 `msg`、`message`、`error`、`error_description`。
111. 修改 `/api/auth/feishu/callback` 与 `/api/token/request`：不再接受客户端 `departmentId` 写入用户或审批部门，部门只能来自服务端当前飞书用户会话。
112. 修改 `components/experience-client.tsx` 与 `components/admin-client.tsx`：移除手动“飞书免登”按钮，页面进入后在 H5 JSSDK ready 且未登录时自动尝试一次飞书登录；登录成功后刷新会话。
113. `/api/session` 与 `/api/admin/overview` 已返回 `avatarUrl` 和部门字段；首页和 `/admin` 新增用户身份卡，展示头像、姓名、open_id、租户/部门或管理范围。
114. 运行 `npm run typecheck` 通过；运行 `npm run build` 通过，生产构建路由包含新增 `/api/feishu/app-id`。
115. 本地普通浏览器刷新 `/` 和 `/admin`，控制台无 error/warn；Next MCP `get_errors` 返回 `configErrors: []`、`sessionErrors: []`；页面快照确认不再显示“飞书免登”按钮，普通浏览器保持“等待飞书身份”状态。
116. 更新 `task_plan.md`、`findings.md`、`.agent-docs/TokenInside-B1飞书H5免登修复计划.md` 和 `.agent-docs/TokenInside-B阶段真实链路实测计划.md`，将 B1 口径改为完全自动识别/自动登录，记录本地验证完成，飞书端内真实复测与 Docker/USLA 更新仍待执行。
117. 根据最新审批方案，确认 MVP 主路径从飞书原生审批实例切换为“TokenInside 自管审批状态机 + 飞书交互卡片请求回调”；旧 `approval_instance` 路径保留为备用/历史实测记录。
118. 根据“审批需要发给用户所在部门的领导”，更新方案为服务端通过飞书通讯录解析申请人 `department_ids` 和部门 `leader_user_id`，多部门用户必须选择申请所属部门并由后端校验，前端不能自报审批人。
119. 更新 `.agent-docs/TokenInside-飞书NewAPI单用户多Key透传实现方案.md`：重写第 7 节为卡片审批链路，补充审批目标解析、卡片发送、`card.action.trigger` 回调、状态机、数据字段、安全边界、MVP 范围和最终建议。
120. 更新 `.agent-docs/TokenInside-B阶段真实链路实测计划.md`、`.agent-docs/TokenInside-实施总路线图.md`、`.agent-docs/TokenInside-C阶段数据库生产化计划.md`、`.agent-docs/TokenInside-D阶段部署运维计划.md` 和 `.agent-docs/TokenInside-E阶段管理后台与用量统计计划.md`，把 B2/B3、部署变量、生产 schema 和后续管理功能改为卡片审批主路径。
121. 同步更新 `task_plan.md` 和 `findings.md`，记录所需飞书能力：应用机器人发送交互卡片、`card.action.trigger` 回调、通讯录用户部门归属、部门负责人字段、应用可用范围和回调操作者校验。
122. 为 B1 修复构建并推送 `voidintheshell/tokeninside:b1-feishu-h5-auto-20260702` 与 `latest`，digest `sha256:c02c43e2732d8df05dc643a78a0741d3c15e89cc1006c96c6e494a259618bd57`；随后部署到 RemoteUSDMITLA，容器 healthy，远端本机 `/api/health`、`/admin`、`/api/session` 通过。
123. 公网浏览器验证发现缺少 favicon 导致 `/favicon.ico` 404 console error；新增 `app/icon.svg` 并在 `app/layout.tsx` metadata 中显式声明 `/icon.svg`，重新运行 `npm run typecheck` 和 `npm run build` 均通过。
124. 重新构建并推送 `voidintheshell/tokeninside:b1-feishu-h5-auto-20260702-2` 与 `latest`，digest `sha256:a26b20e2277cdcbe64cc9cd8fa3d5f38c45fccaa107d17cbcb2087c45e977fd4`；第一次 Docker build 因 Docker Hub metadata 网络超时失败，按网络失败重试后成功。
125. RemoteUSDMITLA `/home/beihai/tokeninside/docker-compose.yml` 已备份为 `docker-compose.yml.before-b1-feishu-h5-auto-20260702` 和 `docker-compose.yml.before-b1-feishu-h5-auto-20260702-2`；当前 compose image 为 `voidintheshell/tokeninside:b1-feishu-h5-auto-20260702-2`，服务器只执行 Docker Hub pull 和 compose up，未进行源码构建。
126. 远端最终验证：容器 `tokeninside-tokeninside-1` running/healthy，imageId `sha256:a26b20e2277cdcbe64cc9cd8fa3d5f38c45fccaa107d17cbcb2087c45e977fd4`；远端本机 `/api/health` 200，`/icon.svg` 200 image/svg+xml，`/admin` 200。
127. 公网最终验证：`https://ti.kumiko-love.com/icon.svg` 200 image/svg+xml，`/api/feishu/app-id` 200 JSON，`/admin` 200 HTML，`/v1/models` 无 key 401 JSON；隔离浏览器打开 `/` 和 `/admin` 均无 console error/warn，页面快照确认只显示“等待飞书身份”和“刷新”，没有“飞书免登”按钮。
128. 用户在飞书 H5 端内复测已从“没有检测到 H5 JSAPI”推进到 `requestAccess` 返回 `20029 invalid redirect uri in h5 case`；查阅飞书重定向 URL 官方文档确认，调用 `tt.requestAccess` 的当前页面地址也必须加入应用安全设置的重定向 URL 列表。已在 `components/feishu-login.tsx` 增加 `20029/invalid redirect uri` 识别，页面会提示需要添加的当前 URL；飞书后台需补 `https://ti.kumiko-love.com/` 和 `https://ti.kumiko-love.com/admin` 后再端内复测。
129. 用户纠正当前应先部署 Docker，使飞书后台回调地址可以通过 challenge 验证；本地 Docker Desktop 起初未运行，启动 Docker Desktop 后 `docker info` 正常。
130. 本地构建 `tokeninside:b1-feishu-h5-redirect-20260702` 成功，Docker 构建阶段 `npm run build` 通过；推送 `voidintheshell/tokeninside:b1-feishu-h5-redirect-20260702` 与 `latest` 到 Docker Hub，digest 均为 `sha256:117e94f6074d3a36dfb6d51e838b4499a153b2f8f04ea3ffdb70071f643f9dab`。
131. RemoteUSDMITLA `/home/beihai/tokeninside/docker-compose.yml` 已备份为 `docker-compose.yml.before-b1-feishu-h5-redirect-20260702`，compose image 已切换到 `voidintheshell/tokeninside:b1-feishu-h5-redirect-20260702`，远端只执行 Docker Hub pull 和 compose up，未执行源码构建。
132. 远端容器 `tokeninside-tokeninside-1` 已 running/healthy，镜像 digest 为 `sha256:117e94f6074d3a36dfb6d51e838b4499a153b2f8f04ea3ffdb70071f643f9dab`；远端本机与公网 `/api/health` 均返回 `status: ok`，配置项 `sessionSecret`、`feishuApp`、`approvalEventVerification`、`approvalEventEncryption`、`newapiControl` 均为 true。
133. 在容器内使用生产环境变量构造签名加密飞书 challenge，经公网 `POST https://ti.kumiko-love.com/api/feishu/events` 返回 200 `{"challenge":"ti-deploy-check-20260702"}`，确认当前部署的回调地址可通过加密 challenge 链路。
134. 公网基础验证：`/` 200 HTML，`/admin` 200 HTML，`/api/feishu/app-id` 200 JSON，`/v1/models` 无 key 返回 `{"error":"Bearer NewAPI key is required"}`，反代仍透传 TokenInside JSON 错误体。
135. 根据最新需求变更，先读取 `task_plan.md`、`findings.md`、`progress.md` 和 `.agent-docs` 方案索引，确认当前文档仍保留 `/admin` 入口壳、旧用户后台和泛 `/v1/*` 透传范围。
136. 更新 `.agent-docs/TokenInside-飞书NewAPI单用户多Key透传实现方案.md`：补充 shadcn 白蓝主题、申请界面/用户后台/管理后台三页面、按身份分流、申请界面只保留用户卡片和申请按钮、用户后台模型列表菜单、管理入口只对管理员展示、移除透传网关子菜单，以及数据面 MVP 只透传 OpenAI Chat Completions、OpenAI Responses、Claude-compatible messages。
137. 更新 `.agent-docs/TokenInside-E阶段管理后台与用量统计计划.md`：重排 E1-E7，新增申请界面，扩展用户后台模型列表，调整管理员默认进入用户后台和用户卡片旁管理入口，取消四个统计卡片作为管理后台首屏必需项。
138. 更新 `.agent-docs/TokenInside-B阶段真实链路实测计划.md` 与 `.agent-docs/TokenInside-D阶段部署运维计划.md`：把 B5/D 阶段数据面验证范围同步为 `/v1/models`、`/v1/chat/completions`、`/v1/responses` 和 Claude-compatible messages，明确 embeddings、images、audio、Gemini-compatible 不属于本期 MVP 验收。
139. 更新 `.agent-docs/TokenInside-实施总路线图.md`、`task_plan.md` 和 `findings.md`：将最新产品变更写入总路线、当前落地状态、下一阶段入口和研究结论；本轮未修改前端或服务端代码。
140. 本轮继续使用 `planning-with-files-zh` 恢复计划；记忆库未发现 TokenInside 直接命中记录，后续依据项目内 `task_plan.md`、`findings.md`、`progress.md` 继续。
141. Next MCP 初次自动发现未找到运行中的 dev server；后续启动本地 `npm run dev` 后使用端口 `16878` 连接成功，`get_errors` 返回 `configErrors: []`、`sessionErrors: []`。
142. 根据最新产品口径开始 E 阶段代码落地：新增 `/api/models`，`lib/newapi.ts` 新增 `listModelsForNewApiToken()`，通过当前 active token 的 NewAPI token id 在服务端读取完整 key 并请求 `/v1/models`，前端只接收模型 id/object/ownedBy。
143. 更新 `/api/session`，为已登录用户返回 `adminScope` 摘要；首页管理后台入口改为只在服务端确认管理范围时显示在用户卡片旁。
144. 重写 `components/experience-client.tsx`：未发放 key 的用户首页只保留飞书用户卡片和申请按钮；已有 active key 的用户进入用户后台，支持“账户”和“模型列表”本地菜单；旧 `/v1 透传网关`、`审计与用量` 和全员可见 `/admin` 侧边入口已移除。
145. 更新 `app/globals.css`：将主题调整为白蓝工作台风格，补齐模型列表、子菜单、申请面板和用户卡片管理入口布局样式。
146. 更新 `/v1/[...path]` 代理 allowlist：仅允许 `GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses`、`POST /v1/messages`；其它路径返回 404 JSON，已知路径方法不匹配返回 405 JSON。
147. 初次并发 HTTP 冒烟时发现 `GET /v1/chat/completions` 返回 500，读取 `next-dev.err` 确认为 JSON MVP store 并发写代理日志时两个请求共用 `tokeninside.json.<pid>.tmp`，其中一个请求 rename 后另一个请求 ENOENT。
148. 修复 `lib/store.ts`：写 store 的临时文件名改为 `process.pid + randomId("tmp")`，避免并发写入抢同一 tmp 文件。
149. 验证通过：`npm run typecheck` 通过；`npm run build` 通过，路由表包含新增 `/api/models`；本地 `GET /api/session` 未登录返回 200 JSON；`GET /api/models` 未登录返回 401 JSON；`GET /v1/models` 无 key 返回 401 JSON；`GET /v1/embeddings` 返回 404 JSON；`GET /v1/chat/completions` 返回 405 JSON；`POST /v1/responses` 无 key 返回 401 JSON。
150. 浏览器验证通过：`http://127.0.0.1:16878/` 首页快照显示未登录态只有 Token 申请、用户身份卡和禁用的申请按钮；桌面/移动宽度 console 均无 error/warn；截图工具本轮超时，未保存截图。
151. 用户确认飞书后台重定向 URL 已配置成功，手动测试能够在后台获取到用户信息；据此将 B1 从 `20029 invalid redirect uri` 配置阻塞推进为可继续 B2/B3 卡片审批真实链路。
152. 按用户要求先提交收尾 commit：`c13de87 feat(control-plane): add user workspace model view`，提交内容包含 E1/E2 首页/用户后台/模型列表、`/v1` allowlist、JSON store 并发写修复和计划文件更新。
153. 继续 B2/B3 代码推进：扩展 `RequestStatus` 和 `TokenRequest` 字段，增加 `approvalMode`、`approvalTargetOpenId`、`approvalTargetSource`、`approvalCardMessageId`、`approvalActionNonceHash`；`FeishuEvent` 增加卡片 request/action/operator/message 字段。
154. 更新 `lib/feishu.ts`：新增通讯录用户详情、部门详情、部门负责人解析和 `sendTokenApprovalCard()`，通过应用机器人向部门领导发送 `msg_type=interactive` 审批卡片。
155. 更新 `/api/token/request`：默认走 `feishu_card` 主路径，创建申请单后解析部门领导并发送审批卡片；解析失败进入 `approval_route_failed`，发送失败进入 `approval_card_send_failed`，发送成功进入 `pending_card_approval`。
156. 更新 `/api/feishu/events`：保留旧 `approval_instance` 备用处理，同时新增 `card.action.trigger` 分支，提取 `operator.open_id`、`action.value.requestId`、`action.value.action`、`action.value.nonce` 和 `message_id`，校验审批目标和 nonce 后执行通过/拒绝。
157. 运行 `npm run typecheck` 和 `npm run build` 均通过。无签名事件 curl 返回 401 `Invalid Feishu event signature`，符合当前 `.env` 启用签名校验的安全预期；尝试用本地 Node 构造签名测试请求时被 Windows 沙箱 `CreateProcessWithLogonW failed: 1326` 拦截，未完成本地签名事件模拟。
158. 运行 `npm run b:check -- --feishu-contact` 未通过：飞书 `tenant_access_token` 可获取，但通讯录 `users.find_by_department` 返回 `99991672 Access denied`，提示缺少应用身份通讯录权限 `[contact:contact.base:readonly, contact:department.organize:readonly, contact:contact:access_as_app, contact:contact:readonly, contact:contact:readonly_as_app]` 中至少一个；真实 B2/B3 申请发卡前需先开通权限和通讯录数据范围。
159. 用户调整飞书相关权限后，重新运行 `npm run b:check -- --feishu-contact` 通过：飞书 `tenant_access_token` 可获取，通讯录成员列表返回 `items=3`，列表字段包含 `department_ids` 和 `leader_user_id`，用户详情字段同样包含 `department_ids` 和 `leader_user_id`。本地 `.env` 的 `TOKENINSIDE_SESSION_SECRET` 仍是占位符提醒，但不影响本次飞书通讯录权限探测。
160. 构建 B2/B3 镜像 `tokeninside:b2-card-20260702-2210` 成功，Docker 构建阶段 `npm run build` 通过，路由表包含 `/api/models` 和 `/api/feishu/events` 等入口。
161. 推送 Docker Hub 成功：`voidintheshell/tokeninside:b2-card-20260702-2210` 与 `voidintheshell/tokeninside:latest` 均指向 digest `sha256:388c7af2ee4c05ed2a7448d722b4e6cc2ceddf0bca85abcfc25574d79c8accb9`。
162. USLA `/home/beihai/tokeninside/docker-compose.yml` 已备份为 `docker-compose.yml.before-b2-card-20260702-2210`，compose image 已切换到 `voidintheshell/tokeninside:b2-card-20260702-2210`；远端只执行 `sudo -n docker compose pull` 与 `up -d`，未进行源码构建。
163. 远端容器 `tokeninside-tokeninside-1` 当前 `running/healthy`，镜像 ID 为 `sha256:388c7af2ee4c05ed2a7448d722b4e6cc2ceddf0bca85abcfc25574d79c8accb9`，端口仍为 `0.0.0.0:16878->16878/tcp`。
164. 远端本机验证通过：`/api/health` 200 JSON 且关键配置均为 true，`/api/session` 200 未登录 JSON，`/v1/models` 无 key 返回 401 JSON，`/v1/embeddings` 返回 TokenInside allowlist 404 JSON。
165. 公网验证通过：`https://ti.kumiko-love.com/api/health` 200 JSON，`/` 200 HTML，`/v1/models` 无 key 返回 401 JSON，`/v1/embeddings` 返回 404 JSON 且错误体由 TokenInside 返回。
166. 在远端容器内使用生产环境变量构造签名加密飞书 challenge，经公网 `POST https://ti.kumiko-love.com/api/feishu/events` 返回 200 `{"challenge":"ti-b2-card-check-20260702"}`。
167. 在远端容器内构造签名加密 `card.action.trigger` 缺字段模拟 payload，经公网事件入口返回 200 `{"ok":false,"toast":{"type":"error","content":"审批卡片参数不完整"}}`，说明卡片事件分支已部署并能安全处理异常 payload。
168. 用户真实测试反馈：用户已加入部门但用户卡片部门仍显示占位符；点击申请时报 `Bot ability is not activated.`；申请理由应该由用户填写，默认申请金额应该展示但不能修改。
169. 修复部门显示：`/api/auth/feishu/callback` 在 OAuth 登录后 best-effort 读取通讯录用户详情并写入第一个 `department_ids`；`/api/session` 在已有用户缺少 `departmentId` 时做懒同步，刷新页面也可补写部门。
170. 修复申请表单：`components/experience-client.tsx` 恢复申请理由 `Textarea`，默认月额度 `200` 用禁用 `Input` 展示，提交按钮在理由少于 4 个字符时禁用。
171. 修复飞书发卡错误提示：`lib/feishu.ts` 将 `Bot ability is not activated` 转换为中文提示，说明需要在飞书开放平台应用后台启用 Bot/机器人能力并确认发布生效。
172. 验证：`npm run typecheck` 通过；`npm run build` 通过。
173. 提交代码修复：`9d4ded4 fix(feishu): sync department and restore request reason`。
174. 构建 Docker 镜像 `tokeninside:b2-card-fix-20260702-2310` 成功，Docker 构建阶段 `npm run build` 通过；推送 `voidintheshell/tokeninside:b2-card-fix-20260702-2310` 与 `voidintheshell/tokeninside:latest`，digest 均为 `sha256:52ab21f02022e0b0f7ed68e5cbce282a2bcbf5acf1e74629f34a3df5923e4ffa`。
175. RemoteUSDMITLA `/home/beihai/tokeninside/docker-compose.yml` 已备份为 `docker-compose.yml.before-b2-card-fix-20260702-2310`，compose image 已切换到 `voidintheshell/tokeninside:b2-card-fix-20260702-2310`；远端只执行 `sudo -n docker compose pull` 与 `up -d`，未进行源码构建。
176. 远端容器 `tokeninside-tokeninside-1` running/healthy，端口保持 `0.0.0.0:16878->16878/tcp`，运行镜像 digest 为 `sha256:52ab21f02022e0b0f7ed68e5cbce282a2bcbf5acf1e74629f34a3df5923e4ffa`。
177. 远端和公网复测通过：`/api/health` 200 JSON，`/api/session` 未登录 200 JSON，公网 `/` 200 HTML，`/v1/models` 无 key 401 JSON，`/v1/embeddings` allowlist 404 JSON；容器内构造签名加密飞书 challenge，经公网事件入口返回 200 `{"challenge":"ti-b2-card-fix-check-20260702"}`；容器日志仅有 Next.js Ready 信息。
178. 根据新增需求查看现有计划后，补充管理后台额度配置口径：默认申请额度改为管理后台配置项，初始化值 `200`；申请页只展示不可改；审批每条申请时支持手动确认或覆盖最终额度。已同步更新 E 阶段计划、总实现方案、实施总路线图、`task_plan.md` 和 `findings.md`；本轮未修改业务代码。
179. 收尾用户卡片展示细节：首页用户卡不再展示“租户”；`/api/session` 与 `/api/admin/overview` 增加 `departmentName` 派生字段，前端部门展示优先使用飞书部门名称，失败时才回退原始部门 ID。已运行 `npm run typecheck`、`npm run build` 和 `npm run b:check -- --feishu-contact` 通过。
180. 构建并推送 `voidintheshell/tokeninside:b2-user-card-dept-20260702` 与 `latest`，digest 均为 `sha256:a2593de49c3564e23fdc36dd19703e59329ae42c370b1b0831f322ea2332d98e`；RemoteUSDMITLA compose 已备份为 `docker-compose.yml.before-b2-user-card-dept-20260702` 并切换到新镜像，容器 running/healthy。远端本机与公网 `/api/health`、`/api/session`、`/v1/models` 无 key 401 均通过，公网飞书事件签名 challenge 返回 `{"challenge":"ti-user-card-dept-check-20260702"}`。
181. 继续 E 阶段额度配置代码落地：JSON store 增加 `settings.defaultMonthlyQuota`，旧数据默认补 `200`；申请接口不再接受客户端提交额度，而是读取服务端默认额度并写入申请快照；管理后台新增默认额度配置和每条待审批申请的最终额度覆盖；发放 NewAPI token 时优先使用 `approvedMonthlyQuota`。已运行 `npm run build`、单独复跑 `npm run typecheck` 通过，本地未登录 `/api/session` 返回 settings，管理写接口未登录返回 401，浏览器 `/admin` 快照和 console 检查通过。
182. 构建并推送额度配置镜像 `voidintheshell/tokeninside:e-quota-config-20260702` 与 `latest`，digest 均为 `sha256:fd3ddce9088e7cd8ff5edc09b70900183981981bd473e1b219ca8e86b25a3557`；RemoteUSDMITLA compose 已备份为 `docker-compose.yml.before-e-quota-config-20260702` 并切换到新镜像，容器 running/healthy。远端本机与公网 `/api/health`、`/api/session` settings、`/api/admin/settings` 未登录 401 均通过，公网飞书事件签名 challenge 返回 `{"challenge":"ti-quota-config-check-20260702"}`；容器日志仅有 Next.js Ready 信息。
183. 恢复续跑时复核远端实际状态，当前 USLA 容器运行镜像为 `voidintheshell/tokeninside:hide-department-20260703`，容器 healthy，公网 `/api/health` 和 `/api/session` 正常；远端 store 中已有 2 条 `pending_card_approval` 申请，说明飞书机器人发卡已恢复，B3 仍等待真实 `card.action.trigger` 回调后才能发放 NewAPI key。
184. 发现远端 `.env.production` 的 `TOKENINSIDE_SESSION_SECRET` 仍为示例占位值；已在服务器上备份 `.env.production`，生成新的随机会话密钥写入私有环境文件，重建容器后恢复 healthy。新密钥未打印或写入仓库。
185. 继续 E 阶段管理能力落地：新增环境变量 `TOKENINSIDE_ADMIN_OPEN_IDS`，作为飞书 OAuth 后的服务端授权白名单，不新增认证方式；健康检查新增 `environmentAdmins` 配置状态，`.env.example` 与 `.env.production.example` 只写占位说明。
186. 新增管理端审批决策接口 `POST /api/admin/token-requests/[id]/decision`：授权管理员可对当前管理范围内待处理申请执行通过或拒绝；通过时使用申请单最终额度触发 NewAPI token 发放，拒绝时只更新申请状态；所有管理 API 仍要求飞书 session 和服务端管理范围。
187. 扩展管理概览：修正卡片审批中的待审批计数，返回可见用户摘要、最近代理日志、申请错误、审批目标和实际审批操作字段；`/admin` 增加通过/拒绝按钮、可见用户列表和代理日志列表。已运行 `npm run typecheck`、`npm run build` 通过，本地 `/api/health`、未登录管理 API 401、浏览器 `/admin` 快照和 console 检查通过。
188. 远端部署管理端审批镜像后，首次人工通过申请触发 NewAPI 发放失败，原因是远端 `.env.production` 中 `NEWAPI_ACCESS_TOKEN=` 和 `NEWAPI_ADMIN_ACCESS_TOKEN=` 为空字符串，旧逻辑使用 `??` 时会把空字符串当作有效凭据并遮蔽 `NEWAPI_SYSTEM_AK`。
189. 修复 `lib/newapi.ts` 控制面凭据选择逻辑，改为从 `NEWAPI_ACCESS_TOKEN`、`NEWAPI_ADMIN_ACCESS_TOKEN`、`NEWAPI_SYSTEM_AK` 中选第一个非空字符串；构建并部署 `voidintheshell/tokeninside:e-admin-decision-fix-20260703` 后，管理端重新通过申请成功发放 active token。
190. 使用管理端人工兜底完成一条申请的 NewAPI token 发放后，远端 `/api/token/key` 返回 200 且不打印明文 key；公网 `https://ti.kumiko-love.com/v1/models` 使用该 key 返回 200，模型数量为 4，代理日志增长，证明数据面透传链路已可用。
191. 发现已开通申请缺少 `tokenAccountId` 且保留了旧失败 `errorMessage`，已修复 `provisionTokenForRequest()` 成功路径回填 token account、清理旧错误，并在 store 读取时对历史 `provisioned` 申请做轻量自愈归一化。
192. 最终构建并推送 `voidintheshell/tokeninside:e-admin-decision-normalize-20260703` 与 `latest`，digest 均为 `sha256:f59936168a60efcd5afdc8fcb82a31a48ee620a6af72a177d14106d54d71d700`；RemoteUSDMITLA `/home/beihai/tokeninside/docker-compose.yml` 已备份并切换到该镜像，服务器仍只执行 Docker Hub pull 和 compose up。
193. 最终远端验收通过：容器 `tokeninside-tokeninside-1` running/healthy，远端本机 `/api/health` 返回 `status: ok` 且 `environmentAdmins: true`；容器日志仅有 Next.js Ready 信息。
194. 公网事件入口验收通过：容器内按当前项目签名规则构造 Feishu challenge，经 `POST https://ti.kumiko-love.com/api/feishu/events` 返回 200 且 challenge 匹配。
195. 管理端授权和数据一致性验收通过：临时飞书 session 访问 `/api/admin/overview?mode=soft` 返回 authenticated/authorized 均为 true，scope 为 `global/environment`，totals 为 users=2、tokenRequests=8、pendingRequests=1、provisionedRequests=1、failedRequests=0、activeTokens=1、proxyLogs=13；最新 provisioned 申请已回填 `tokenAccountId`、无错误、带审批操作人。
196. 真实飞书卡片 `card.action.trigger` 仍未由审批目标领导实际点击验证；当前已验证的是事件入口 challenge、异常 payload 安全处理、管理端人工兜底发放和公网 `/v1/models` 数据面透传。
197. 继续 B5/E 阶段收尾时发现 NewAPI 内部额度单位不是展示额度本身；本地 NewAPI 源码 `common/constants.go` 显示 `QuotaPerUnit = 500 * 1000.0`，直接写入 `remain_quota=200` 实际只剩约 `$0.000400`，导致 Chat/Responses/Messages 测试返回额度不足。
198. 新增 `NEWAPI_QUOTA_PER_UNIT` 配置，默认值 `500000`；发放 NewAPI token 时将 TokenInside 展示月额度乘以该单位写入 `remain_quota`，健康检查返回 `newapiQuotaPerUnit`，示例环境文件同步补占位说明。
199. 已在远端用 NewAPI 控制面修复现有 active token 的 `remain_quota`：从 `200` 更新为 `100000000`，对应 TokenInside 默认展示额度 `200`；修复过程未打印 NewAPI key 或控制凭据。
200. B5 数据面 POST 路径在公网实测通过：`POST /v1/chat/completions` 返回 200 `chat.completion`，`POST /v1/responses` 返回 200 `response`，`POST /v1/messages` 返回 200 且有响应 id；三者均使用现有 active key 通过 TokenInside 代理访问 `https://ti.kumiko-love.com`。
201. E 阶段用量统计基础已落地：代理日志新增 `promptTokens`、`completionTokens`、`totalTokens`，管理概览聚合总输入/输出/总 token，并在管理后台展示总 tokens、输入 tokens、输出 tokens、用户 token 汇总和代理日志 token 列。
202. 上游 Claude-compatible `/v1/messages` 响应可能不返回 `total_tokens`；TokenInside 已在代理日志中用 `prompt/input + completion/output` 补算 `totalTokens`，并在 store 读取归一化时回填历史缺失的 message 日志总量。
203. 最终本地验证通过：`npm run typecheck`、`npm run build`、`docker build -t tokeninside:e-quota-unit-usage-3-20260703 .` 均成功；Docker 构建阶段的 Next 生产构建同样通过。
204. 最终镜像已按本地构建、Docker Hub 推送、服务器 pull-only 路径部署：`voidintheshell/tokeninside:e-quota-unit-usage-3-20260703` 与 `latest` 均指向 digest `sha256:5a91b949118e1a97e92f6c264756e8cc918f774aed8ae0a84d680e55a86565cf`；RemoteUSDMITLA compose 已备份并切换到该 tag，容器 `tokeninside-tokeninside-1` running/healthy。
205. 最终远端验收：`/api/health` 返回 `status: ok`、`newapiQuotaPerUnit: 500000`、`environmentAdmins: true`；公网 B5 三条 POST 路径均 200；管理概览返回 authenticated/authorized 均为 true，聚合 `proxyLogs=27`、`promptTokens=99`、`completionTokens=14`、`totalTokens=113`，证明历史回填和新日志补算均生效。
206. 继续 E7 key 重置落地：`lib/newapi.ts` 新增 NewAPI token 剩余额度读取和内部额度转展示额度换算；`lib/store.ts` 新增 active token account 替换逻辑，会把旧 account 标记为 `replaced` 并保留历史归属。
207. `lib/provisioning.ts` 新增 `resetActiveTokenForUser()`：当前飞书用户已有 active key 时，读取旧 NewAPI token 当前 `remain_quota`，创建继承相同剩余额度的新 token，替换 TokenInside active 映射，并调用 NewAPI 禁用旧 token；失败时写入 `key_reset` 申请单错误状态。
208. 新增 `POST /api/token/reset`，仍要求飞书 OAuth session，不新增认证方式；用户后台当前 key 卡片新增“重置”按钮，重置成功后直接展示新 key 并刷新 session。
209. 本地验证通过：`npm run typecheck`、`npm run build`、本地未登录 `POST /api/token/reset` 返回 401；Docker 构建 `tokeninside:e-key-reset-20260703` 成功，构建阶段生产路由包含 `/api/token/reset`。
210. key reset 镜像已按本地构建、Docker Hub 推送、服务器 pull-only 路径部署：`voidintheshell/tokeninside:e-key-reset-20260703` 与 `latest` 均指向 digest `sha256:7cdf25a5287df668cf55c7b9a33b40e49c200b83548d3a169334d6785607d67c`；远端容器 running/healthy，公网 `/api/health` 正常，公网未登录 `POST /api/token/reset` 返回 401。出于避免擅自禁用生产 active key，本轮未实际触发生产 key reset。
211. 继续 E7 额度重置落地：新增 `POST /api/token/quota-reset`，仍要求飞书 OAuth session 和当前 active key；用户提交理由后按当前默认额度创建 `quota_reset` 申请单，并复用部门负责人飞书卡片审批链路，不直接修改生产额度。
212. `provisionTokenForRequest()` 已按 `requestType` 分支处理 `quota_reset` / `quota_adjust`：审批通过后只更新当前 active NewAPI token 的 `remain_quota`，按 `NEWAPI_QUOTA_PER_UNIT` 做内部额度换算，不生成新 key，也不替换 active key 映射。
213. 用户后台账户页新增“额度重置”表单，展示管理后台当前默认额度且不可修改；最近申请类型增加中文展示，区分首次申请、额度重置、key 重置和额度调整。
214. 本地验证通过：`npm run typecheck`、`npm run build`、Next MCP 路由表包含 `/api/token/quota-reset` 且无 config/session 错误；浏览器 fetch 未登录 `POST /api/token/quota-reset` 返回 401。PowerShell `curl.exe` 本轮两次被 Windows 1909 启动层拦截，未作为接口失败处理。
215. 额度重置镜像已按本地构建、Docker Hub 推送、服务器 pull-only 路径部署：`voidintheshell/tokeninside:e-quota-reset-20260703` 与 `latest` 均指向 digest `sha256:12da5c45cfdcf1348288bd75c794ee1cede971e2e08cc8c1b28cb2a2abcf7687`；RemoteUSDMITLA compose 已备份为 `docker-compose.yml.before-e-quota-reset-20260703` 并切换到新 tag，容器 running/healthy。
216. 远端和公网验收通过：远端本机 `/api/health` 返回 `status: ok`、`newapiQuotaPerUnit: 500000`、`environmentAdmins: true`；远端本机和公网未登录 `POST /api/token/quota-reset` 均返回 401，公网首页返回 200。出于避免擅自发起真实审批或修改生产额度，本轮未实际提交生产 quota reset 申请。
217. 继续 E 阶段部门主管自动同步落地：新增 `lib/admin-sync.ts`，将飞书用户部门懒同步从 `/api/session` 抽成共享逻辑，并新增部门主管管理范围同步逻辑。
218. `lib/store.ts` 新增 `syncDepartmentSupervisorAdminScope()`：当当前用户是其部门 `leader_user_id` 时自动写入或激活 `source=department_supervisor`、`scopeType=department` 的管理范围；当不再匹配时禁用对应自动范围，不影响 `manual` 和 `environment` 管理范围。
219. `/api/session`、`/api/admin/overview` 和 `requireAdminScope()` 已改为在读取管理范围前先补齐部门并尝试同步部门主管范围；这样部门负责人登录后可自动获得本部门管理后台范围，不再只依赖环境白名单或手工写入 `adminScopes`。
220. 本地验证通过：`npm run typecheck`、`npm run build`、`git diff --check` 和 Next MCP `get_errors` 均通过；未登录 `/api/session` 返回 200，直接 `/api/admin/overview` 返回 401，soft 模式返回 200，未破坏未登录 UI 状态。
221. 部门主管同步镜像已按本地构建、Docker Hub 推送、服务器 pull-only 路径部署：`voidintheshell/tokeninside:e-dept-sync-20260703` 与 `latest` 均指向 digest `sha256:124d44165aaf13f028b6e33a64990238735bba52148a6174da1efbcc784d9618`；RemoteUSDMITLA compose 已备份为 `docker-compose.yml.before-e-dept-sync-20260703` 并切换到新 tag，容器 running/healthy。
222. 远端和公网验收通过：远端本机与公网 `/api/health` 均返回 `status: ok`、`newapiQuotaPerUnit: 500000`、`environmentAdmins: true`；远端本机与公网直接 `/api/admin/overview` 未登录返回 401，`?mode=soft` 返回 200，容器日志仅有 Next Ready 信息。
223. 继续 E 阶段管理端调额落地：新增 `POST /api/admin/users/[id]/quota-adjust`，授权管理员可对当前管理范围内已有 active key 的用户直接调整额度；接口创建 `requestType=quota_adjust` 的本地申请记录，再复用 `provisionTokenForRequest()` 更新 active NewAPI token quota。
224. 管理后台“可见用户”表新增调额列，只有 active key 用户的额度输入和“调整”按钮可用；提交后刷新管理概览。调额仍走飞书 session + 服务端管理范围，不新增认证方式。
225. 管理端设置接口和审批单额度覆盖接口已统一改为 `requireAdminScope()`，因此环境管理员、手工管理范围和自动部门主管范围都走同一授权入口。
226. 本地验证通过：`npm run typecheck`、`npm run build`、Next MCP 路由表包含 `/api/admin/users/[id]/quota-adjust` 且无 config/session 错误；浏览器 fetch 未登录 `POST /api/admin/users/fu_test/quota-adjust` 和 `GET /api/admin/settings` 均返回 401。
227. 管理端调额镜像已按本地构建、Docker Hub 推送、服务器 pull-only 路径部署：`voidintheshell/tokeninside:e-quota-adjust-20260703` 与 `latest` 均指向 digest `sha256:406a8d9d8b64b2e9eb2dcccdde2d5e6ca1abc021e819738a778334bfb549b63b`；RemoteUSDMITLA compose 已备份为 `docker-compose.yml.before-e-quota-adjust-20260703` 并切换到新 tag，容器 running/healthy。
228. 远端和公网验收通过：远端本机与公网 `/api/health` 均返回 `status: ok`、`newapiQuotaPerUnit: 500000`、`environmentAdmins: true`；远端本机与公网未登录 `POST /api/admin/users/fu_test/quota-adjust` 均返回 401。本轮未擅自对生产 active key 触发真实管理端调额。
229. 继续 E 阶段账期同步落地：新增 JSON store `userBillingPeriods` 汇总结构，由 store 读取归一化时从 `tokenAccounts.billingPeriod`、已发放的 `quota_reset` / `quota_adjust` 申请和代理日志 token usage 同步生成每用户每月账期摘要。
230. `/api/session` 已返回当前 active key 对应的账期摘要；用户后台新增“当前账期”卡片，展示账期、额度、输入/输出/总 tokens 和代理请求数。
231. 管理概览新增当前账期 totals 与每用户账期字段；管理后台新增当前账期 tokens、当前账期额度、每用户账期额度和账期 tokens 展示。本轮只同步和展示账期统计，不自动重置或修改生产 NewAPI quota。
232. 本地验证通过：`npm run typecheck`、`npm run build`、Next MCP `get_errors`、Next MCP `get_routes`、未登录 `/api/session`、未登录 `/api/admin/overview` 401、soft 模式 200、`git diff --check` 和密钥扫描均通过。
233. 账期同步镜像已按本地构建、Docker Hub 推送、服务器 pull-only 路径部署：`voidintheshell/tokeninside:e-billing-sync-20260703` 与 `latest` 均指向 digest `sha256:b444712f9bd62f15718a059231708300a901f1c2919345c3a1479f78fcc169ed`；RemoteUSDMITLA compose 已备份为 `docker-compose.yml.before-e-billing-sync-20260703` 并切换到新 tag，容器 running/healthy。
234. 远端和公网验收通过：远端本机 `/api/health`、`/api/session`、未登录 `/api/admin/overview` 401、soft 模式 200 均正常；公网 `/api/health`、`/api/session`、`/`、未登录 `/api/admin/overview` 401 和 soft 模式 200 均正常。远端 JSON store 已生成 `userBillingPeriods=1`，当前 `2026-07` 账期为 `monthlyQuota=200`、`proxyLogCount=17`、`totalTokens=113`，且绑定 active token account。
235. 按用户要求确认最终生产服务器不是 USLA 测试机：SSH MCP 配置中的生产目标为 `共绩TokenInside服务端机器`，此前 USLA/RemoteUSDMITLA 只继续作为当前测试部署与公网回调验证环境。
236. 已基于 2C2G、约 60 人总用户、峰值并发 100 的规模口径收敛 PG 默认参数：应用侧 PG pool 默认 10，PostgreSQL `max_connections=50`，默认不引入 PgBouncer，容器内存上限先控制在 768m。
237. 代码层已把 PostgreSQL 连接池从固定 `max: 5` 改为运行时配置：新增 `DATABASE_POOL_MAX`、`DATABASE_POOL_IDLE_TIMEOUT_MS`、`DATABASE_POOL_CONNECTION_TIMEOUT_MS`，默认分别为 `10`、`30000`、`5000`；健康检查在 postgres 模式下返回这些非敏感 pool 参数。
238. 新增 `docker-compose.postgres.example.yml`，固化 2C2G 默认 PostgreSQL 容器参数和 TokenInside + Postgres 双服务拓扑；`.env.example` 与 `.env.production.example` 已同步新增 PG pool 变量和 Postgres 容器密码占位符。
239. 本地验证通过：`npm run typecheck`、`npm run build`、`npm audit` 0 vulnerabilities、Next MCP `get_errors` 无 config/session 错误；临时 `postgres:16-alpine` 容器中 `npm run db:migrate` 成功应用 24 条迁移语句，`npm run db:import-json -- .local-data/tokeninside.json` 成功导入统计，输出不包含明文 key。
240. `git diff --check` 无空白错误，仅有 Windows CRLF 提示。敏感扫描命令和 `docker compose -f docker-compose.postgres.example.yml config --quiet` 本轮被本地 Windows `CreateProcessWithLogonW failed: 1326` 启动层拦截，未得到命令级结果；该错误不是代码或 compose 解析错误。
241. 构建 Docker 镜像 `tokeninside:c-postgres-pool-20260703` 成功，Docker 构建阶段 Next 生产构建通过；推送 `voidintheshell/tokeninside:c-postgres-pool-20260703` 与 `voidintheshell/tokeninside:latest`，两者 digest 均为 `sha256:44ef9befca97ff5678d0f1000bc12d6a850b29d35478f778a882ca563e51adbc`。
242. RemoteUSDMITLA `/home/beihai/tokeninside/docker-compose.yml` 已备份为 `docker-compose.yml.before-c-postgres-pool-20260703`，compose image 已切换为 `voidintheshell/tokeninside:c-postgres-pool-20260703`；远端只执行 Docker Hub pull 和 compose up，未进行源码构建。
243. 远端和公网验收通过：容器 `tokeninside-tokeninside-1` running/healthy，镜像 digest 为 `sha256:44ef9befca97ff5678d0f1000bc12d6a850b29d35478f778a882ca563e51adbc`；远端本机 `/api/health` 和 `/api/session` 正常；公网 `/api/health`、`/api/session`、`/`、`/api/admin/overview?mode=soft` 正常，未登录 `/api/admin/overview` 仍返回 401；容器日志仅有 Next Ready 信息。
244. 对最终生产机 `共绩TokenInside服务端机器` 做只读巡检：主机 `VM-6-5-ubuntu`，当前用户 `ubuntu` 在 sudo 组；`docker` 和 `docker compose` 不可用；内存约 1.9GiB、available 约 1.4GiB、无 swap；根盘 50G 已用约 4.8G；监听端口为 22 和现有 8088 服务。本轮未在生产机安装软件、写入 compose 或改动系统状态。
245. 继续 E 阶段自动账期切换策略落地：新增 `TOKENINSIDE_MONTHLY_RESET_ENABLED`，默认 `false`；`/api/health` 返回 `monthlyResetEnabled` 便于部署验收。
246. 新增 `POST /api/admin/billing/monthly-reset`：复用飞书 OAuth session 和 `requireAdminScope()`，只允许全局管理员调用；dry-run 可在开关关闭时计算计划，非 dry-run 必须先启用 `TOKENINSIDE_MONTHLY_RESET_ENABLED=true`，避免误改生产 NewAPI quota。
247. 新增 `lib/billing.ts` 和 store 侧 `recordMonthlyResetApplied()`：按 active token account 计算候选，目标账期相同则跳过；执行时先更新 NewAPI `remain_quota` 为当前默认月额度，再写入 `requestType=monthly_reset` 审计记录，并把 active account `billingPeriod` 切到目标账期。
248. 月度重置本地验证通过：`npm run typecheck`、`npm run build`、`npm audit` 0 vulnerabilities、Next MCP `get_errors` 无错误；生产构建路由表包含 `/api/admin/billing/monthly-reset`。浏览器 fetch 验证未登录 dry-run 返回 401，`/api/health` 显示 `monthlyResetEnabled=false`。`git diff --check` 无空白错误，仅有 Windows CRLF 提示。
249. 构建 Docker 镜像 `tokeninside:e-monthly-reset-20260703` 成功，Docker 构建阶段 Next 生产构建通过；推送 `voidintheshell/tokeninside:e-monthly-reset-20260703` 与 `voidintheshell/tokeninside:latest`，两者 digest 均为 `sha256:8626a69ae09421ab181fbfb6e233f4996053e94aaca522ed92332aa19f7f8c9f`。
250. RemoteUSDMITLA `/home/beihai/tokeninside/docker-compose.yml` 已备份为 `docker-compose.yml.before-e-monthly-reset-20260703`，compose image 已切换为 `voidintheshell/tokeninside:e-monthly-reset-20260703`；远端只执行 Docker Hub pull 和 compose up，未进行源码构建。
251. 远端和公网验收通过：容器 `tokeninside-tokeninside-1` running/healthy，镜像 digest 为 `sha256:8626a69ae09421ab181fbfb6e233f4996053e94aaca522ed92332aa19f7f8c9f`；远端本机和公网 `/api/health` 均返回 `status: ok`、`monthlyResetEnabled=false`；远端本机和公网未登录 `POST /api/admin/billing/monthly-reset` dry-run 均返回 401；公网 `/api/session` 和 `/` 正常；容器日志仅有 Next Ready 信息。
252. 对最终生产机继续做只读部署前检查：系统为 Ubuntu 22.04，`apt-get`、`curl`、`ufw` 可用，`sudo -n` 可用，16878 当前未监听；Docker/Compose 仍不可用。本轮仍未安装软件、开放端口、写入文件或启动服务。
253. 补齐 PostgreSQL 生产切换护栏：`db:import-json` 默认拒绝替换式导入，必须传 `--confirm-replace` 或设置 `TOKENINSIDE_CONFIRM_REPLACE_IMPORT=true`；新增 `--dry-run` 只输出 JSON 集合计数；新增 `npm run db:verify-import` 对比 JSON 与 PostgreSQL 表计数；新增 `npm run production:preflight` 检查生产关键环境和数据库连接且不打印密钥。
254. 脚本回归通过：Docker Node 容器运行 `npm run db:import-json -- --dry-run .local-data/tokeninside.json` 输出计数；不带 `--confirm-replace` 的真实导入按预期拒绝；临时 `postgres:16-alpine` 中 `npm run db:migrate` 成功应用 24 条迁移语句，带 `--confirm-replace` 的导入成功，`npm run db:verify-import` 返回 `ok:true` 且所有集合/表计数一致。临时 PG 容器已停止。
255. 用户更新生产边界：`ti.kumiko-love.com` 已迁移到 `共绩TokenInside服务端机器`，后续 TokenInside 开发和部署不再使用 LA/USLA；生产机现有 Nginx Proxy Manager 上游为内部 `tokeninside:16878`。
256. 生产机已安装 `docker-compose-v2`，创建 `tokeninside_net`，并把 `nginx-proxy-manager` 接入该网络；生产目录 `/home/ubuntu/tokeninside` 已写入统一 `docker-compose.yml` 管理 PG/app。
257. 按 2C2G/PG 768m 复核结果修正生产 PG 参数：`max_connections=30`、`effective_cache_size=768MB`、`shared_buffers=256MB`、`work_mem=4MB`、`autovacuum_max_workers=2`；应用 PG pool 为 `DATABASE_POOL_MAX=10`、idle 30s、connection timeout 5s，默认不引入 PgBouncer。
258. 为支持生产镜像内执行数据库迁移，Dockerfile runner 层已拷贝 `scripts/`；构建并推送 `voidintheshell/tokeninside:prod-compose-20260703`，digest 为 `sha256:874848cc66149e68620861a6a2829348e1a00d79232034370add55970ed83aac`。
259. 本次曾因生产机无法可靠访问 Docker Hub/官方 Docker registry，改为本地 `docker save` 导出 `.deploy/tokeninside-prod-compose-20260703.tar`，通过 SSH MCP 上传到生产机后 `docker load`；该路径保留为远端 pull 失败时的回退方案。
260. 生产机 `tokeninside-postgres` 已启动并健康，`node scripts/db-migrate.mjs` 成功应用 24 条迁移语句；`tokeninside` app 容器使用内部网络暴露 `16878/tcp`，容器健康检查通过。
261. 生产健康验证通过：PG/app 均 `healthy`，PG settings 显示 `max_connections=30`、`effective_cache_size=768MB`、`statement_timeout=30s`；app `/api/health` 显示 `store.type=postgres`、`databaseConfigured=true`、`postgresPool.max=10`、`monthlyResetEnabled=false`。
262. NPM 容器直接访问 `http://tokeninside:16878/api/health` 返回 200；HTTPS 502 定位为 NPM nginx resolver 使用外部 DNS 无法解析 Docker 服务名，已在 `/data/nginx/custom/server_proxy.conf` 写入 Docker DNS resolver 并 reload nginx。
263. 生产机自身公网验证 `https://ti.kumiko-love.com/api/health` 返回 200，远端 DNS 解析到 `49.233.85.67`；本机 Windows DNS 当前解析到 `198.18.10.116` 代理假 IP，导致本机 `curl.exe` schannel 握手失败，不能作为生产链路失败证据。
264. 仓库示例已同步生产拓扑：新增统一 `docker-compose.production.example.yml`，共享外部 `tokeninside_net`，app 容器名和网络别名固定为 `tokeninside`；`.deploy/` 已加入 `.gitignore`，避免镜像 tar 进入版本控制。
265. 按用户要求将生产机实际部署收敛为一份 `/home/ubuntu/tokeninside/docker-compose.yml` 统一管理 PG/app；compose 使用显式 volume 名 `tokeninside_pg_data` 与 `tokeninside_app_data`，避免 project name 变化导致误启空库。切换后已补跑 `db-migrate`，PG 表数量为 8，NPM 内部上游和生产机公网 `/api/health` 均返回 200。
266. 新增生产 PG 运维脚本：`scripts/production-pg-backup.sh` 生成 `pg_dump -Fc` 备份和 sha256，`scripts/production-pg-restore.sh` 默认拒绝恢复，必须设置 `TOKENINSIDE_CONFIRM_RESTORE=true`，并支持 `TOKENINSIDE_DOCKER_CMD='sudo -n docker'` 适配生产机 sudo Docker。
267. 生产机已上传并实测 PG 备份脚本，生成 `/home/ubuntu/tokeninside/backups/postgres/tokeninside-postgres-20260703T045924Z.dump` 和对应 `.sha256`；恢复脚本护栏验证通过，未设置确认变量时退出 1 并拒绝执行，容器仍 healthy。
268. 用户部署 mihomo 后，生产机 Docker Hub 拉取恢复正常：`sudo -n docker pull voidintheshell/tokeninside:prod-compose-20260703` 与 `sudo -n docker pull hello-world:latest` 均成功。后续生产发布优先使用远端 pull + compose up，save/load 仅作为回退路径。
269. 复查生产健康检查路径：容器仍 healthy，NPM 内部 `http://tokeninside:16878/api/health` 和宿主机本地 SNI `https://ti.kumiko-love.com/api/health` 均返回 200；但 mihomo/TUN 使宿主机公网回环域名解析到 `198.18.*` 时会 TLS EOF，后续不以该路径判断服务故障。
270. 生产健康检查已补强为 PostgreSQL schema readiness：postgres 模式下 `/api/health` 除连接可用外，还检查 required tables，返回 `schema.ready`、`missingTables` 与 `tableCount`，避免“能连库但未迁移/误挂空卷”被误判为健康。
271. 构建并推送 `voidintheshell/tokeninside:prod-health-schema-20260703`，digest 为 `sha256:7655935ac1e539151cf61cb47db4ba2f8c49c72bc3cad13a489ffa82d9ee786b`；生产机 `/home/ubuntu/tokeninside/docker-compose.yml` 已备份为 `docker-compose.yml.before-prod-health-schema-20260703T051724Z` 并切换到该 tag。
272. 生产机已按新策略通过 Docker Hub pull 部署新镜像，未使用本地 tar 上传回退路径；`tokeninside` 与 `tokeninside-postgres` 均 healthy，NPM 内部上游和宿主机本地 SNI HTTPS `/api/health` 均返回 200，health 显示 `store.schema.ready=true`、`missingTables=[]`、`tableCount=8`、`postgresPool.max=10`。
273. 排查外部访问生产机失败：`mihomo.service` 常驻时生产机存在 `Meta` TUN、`198.18.*` DNS/路由和 table 2022 policy rules，外部 HTTPS 从超时变为停止 mihomo 后 reset；`mihomo.service` 已 `disable --now`，后续只在生产机需要拉镜像时临时启用。
274. 停止 mihomo 后，生产机 TokenInside/NPM 内部链路仍正常，国内移动来源曾能打到生产 NPM 并返回 200；但海外外部主机访问 `49.233.85.67` 时 HTTP 80 被腾讯云/DNSPod webblock 改写，HTTPS TLS 被 reset，判断剩余问题属于生产机云厂商/域名接入拦截，不是 TokenInside 容器或 NPM upstream。
275. 按用户要求临时把开发/调试入口切回 LA：用户已将 `ti.kumiko-love.com` 解析回 GreenJP `45.129.9.128`，由 GreenJP 反代至 RemoteUSDMITLA 的 `16878`；LA compose 已备份为 `docker-compose.yml.before-prod-health-schema-devla-20260703T052609Z` 并切到 `voidintheshell/tokeninside:prod-health-schema-20260703`。
276. LA 开发链路验收通过：`tokeninside-tokeninside-1` healthy，LA 本机 `http://127.0.0.1:16878/api/health` 返回 200 且 `store.type=json`；从 LA 和生产机访问 `https://ti.kumiko-love.com/api/health` 均返回 200，首页 HEAD 返回 200。生产机 PG/app/NPM 未回滚，仍保持 `prod-health-schema-20260703` healthy，等待后续 DNS/备案处理后再切回。
277. 固化生产机拉镜像代理流程：新增 `scripts/production-docker-pull-with-mihomo.sh` 和 `npm run production:docker-pull`，脚本会临时启动 `mihomo.service`、执行一个或多个 `docker pull`，并通过 `trap` 在成功或失败后停止并禁用 mihomo，避免 TUN/policy routing 常驻影响公网入站。
278. 已将 `production-docker-pull-with-mihomo.sh` 上传到生产机 `/home/ubuntu/tokeninside/scripts/` 和 LA `/home/beihai/tokeninside/scripts/`，两端 `bash -n` 语法检查通过；生产机用 `TOKENINSIDE_DOCKER_CMD='sudo -n docker' TOKENINSIDE_SYSTEMCTL_CMD='sudo -n systemctl'` 拉取 `hello-world:latest` 成功，结束后 `mihomo.service` 为 `inactive/disabled`，无 `Meta`/2022 路由残留，`tokeninside` 仍 healthy。
279. 本地验证通过：`npm run typecheck`、`npm run build`、`git diff --check` 均通过；`git diff --check` 仅输出 Windows CRLF 提示，无空白错误。
280. 根据用户反馈排查飞书卡片审批 `code:200671`：官方文档确认该错误表示卡片回调服务返回了非 HTTP 200；GreenJP/BunkerWeb 日志显示飞书 `Go-http-client/1.1` 对 `POST /api/feishu/events` 返回过 401/400，说明请求已到达公网入口但被 TokenInside 入口层拦截，未写入 `feishuEvents`。
281. 已更新 `/api/feishu/events`：明文卡片回调可用 Verification Token 通过入口校验；同时兼容新版 `card.action.trigger` 的 `header.token`、`event.operator.open_id`、`event.action.value`、`event.context.open_message_id`，以及旧版 `card.action.trigger_v1` 的 top-level `token`、`open_id`、`open_message_id`、`action`/`action_value`；`action.value` 若为 JSON 字符串会尝试解析。
282. 卡片回调响应体已收窄为官方允许的 `{ "toast": { "type": "...", "content": "..." } }`，移除非官方 `ok` 字段，降低后续触发 `200672` 响应体格式错误的风险；加密事件 challenge 仍保持签名、解密和 verification token 校验。
283. 本地验证通过：`npm run typecheck`、`npm run build`、Docker 构建 `tokeninside:card-callback-200671-fix-20260703` 成功；本地新版与旧版卡片回调模拟均返回 HTTP 200 和 toast。两次普通沙箱 Node 模拟被 Windows `CreateProcessWithLogonW failed: 1326` 启动层拦截，改用非沙箱只读/本地请求验证完成。
284. 镜像已按本地构建、Docker Hub 推送、LA 服务器 pull-only 路径部署：`voidintheshell/tokeninside:card-callback-200671-fix-20260703` 与 `latest` 均指向 digest `sha256:b77686b1a09ae5fd2b27de1590885e5e239d8f8f6759e51e767a88873bc4b038`；RemoteUSDMITLA compose 已备份为 `docker-compose.yml.before-card-callback-200671-fix-20260703` 并切到新 tag，容器 running/healthy。
285. 远端和公网验收通过：远端本机与公网 `/api/health` 返回 `status: ok`；从容器内经公网域名模拟新版和旧版卡片回调均返回 HTTP 200 + toast；签名加密 challenge 返回 `{"challenge":"ti-card-callback-fix-check-20260703"}`；BunkerWeb 最近三条 `/api/feishu/events` 模拟请求均为 200。
286. 官方文档对照结论已同步：飞书后台最好在 `开发配置 -> 事件与回调 -> 回调配置` 中只保留新版 `card.action.trigger`，删除 `card.action.trigger_v1` 和重复订阅并发布应用版本；代码已兼容新旧两种结构，但后台减少重复回调可以降低边缘风险。

## 2026-07-03

287. 按用户后台 key 展示细节要求完成窄范围修复：新增 `maskApiKey()`，`/api/session` 为 active token 返回 `maskedKey`，用户后台隐藏态不再展示 NewAPI token 数字 ID，而是展示完整 key 的头尾省略形式。
288. 用户点击“查看”时仍走 `/api/token/key` 实时读取完整 key；前端读取成功后展示完整 key，并尝试自动写入剪切板。若浏览器拒绝剪切板权限，会保留完整 key 展示并提示“浏览器未允许自动复制”。
289. 本地验证通过：`npm run typecheck`、`npm run build`、Docker 构建均成功；Next MCP `get_errors` 无 config/session 错误。
290. 本地构建并推送镜像 `voidintheshell/tokeninside:key-mask-copy-20260703`，digest 为 `sha256:17da0640f6adfe1ab32f9e137b999536415f0e511728058692df2cb1fb5dba56`。
291. LA/RemoteUSDMITLA `/home/beihai/tokeninside/docker-compose.yml` 已备份为 `docker-compose.yml.before-key-mask-copy-20260703`，compose image 已切换为 `voidintheshell/tokeninside:key-mask-copy-20260703`；远端只执行 Docker Hub pull 和 compose up，未进行源码构建。
292. 远端和公网验收通过：容器 `tokeninside-tokeninside-1` healthy；远端本机 `/api/health` 返回 200；公网 `https://ti.kumiko-love.com/api/health` 返回 200，配置显示 `newapiMock=false`、`publicBaseUrlHost=ti.kumiko-love.com`；容器日志仅有 Next Ready 信息。
293. 按用户要求将后续开发两边全部转向 PG：确认 LA 端原先只有 app 容器且 `/api/health` 为 `store.type=json`，生产机已是 PG；决定迁移 LA 并修正生产机 compose env 插值风险。
294. LA/RemoteUSDMITLA 迁移前已备份 `docker-compose.yml`、`.env.production` 和 JSON store，备份时间戳为 `20260703T070055Z`；新增 `tokeninside-postgres` 服务，PG 参数与生产机一致，app 镜像同步为 `voidintheshell/tokeninside:key-mask-copy-20260703`。
295. LA 迁移执行通过：`npm run db:migrate` 应用 24 条迁移语句，`npm run db:import-json -- --confirm-replace .local-data/tokeninside.json` 导入 users=3、tokenRequests=10、tokenAccounts=2、userBillingPeriods=2、feishuEvents=3、proxyRequestLogs=28、adminScopes=0；`npm run db:verify-import -- .local-data/tokeninside.json` 返回 `ok:true`。
296. LA 验收通过：`tokeninside-postgres` 与 `tokeninside-tokeninside-1` 均 healthy，PostgreSQL `16.14`，`max_connections=30`、`shared_buffers=256MB`、`effective_cache_size=768MB`、`work_mem=4MB`、`statement_timeout=30s`、`table_count=8`；远端本机和公网 `/api/health` 均显示 `store.type=postgres`、`schema.ready=true`、`postgresPool.max=10`。
297. 生产机 `/home/ubuntu/tokeninside` 已备份 compose/env，修正 compose 为 postgres 服务通过 `env_file: .env.production` 接收 `POSTGRES_PASSWORD`，并补齐 `POSTGRES_PASSWORD` 与 PG pool 变量；第一次脚本因 `set -u` 下 `dburl` 未初始化退出，未写入 compose 或重建容器，第二次修正变量初始化后执行成功。
298. 生产机 app 镜像同步为 `voidintheshell/tokeninside:key-mask-copy-20260703`，通过 `production-docker-pull-with-mihomo.sh` 拉取后 compose up；`tokeninside` 与 `tokeninside-postgres` 均 healthy，PostgreSQL `16.14`，`table_count=8`，app `/api/health` 显示 `store.type=postgres`、`schema.ready=true`、`postgresPool.max=10`。
299. 仓库 `docker-compose.production.example.yml` 已同步生产机写法：postgres 服务增加 `env_file: .env.production` 并移除 `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}` 插值，避免后续部署模板继续产生空变量警告。
300. 继续处理飞书卡片点击 `code:200671`：确认当前 LA PostgreSQL `feishu_events` 为空时仍出现飞书报错，说明真实点击请求大概率在入口层签名/token/解密/JSON 解析前置分支返回 401/400，或审批通过后同步 `provisionTokenForRequest()` 失败冒泡为 HTTP 500。
301. 已收窄修改 `/api/feishu/events`：新增 `addFeishuEventBestEffort()`，卡片回调认证调整为签名、明文 verification token、解密后 verification token 任一可信即可继续；识别为卡片回调但校验失败时尽量写入 `feishuEvents` 并返回 HTTP 200 toast，避免飞书把业务/配置失败显示为 `200671`。
302. 卡片审批通过分支已改为捕获 NewAPI 发放异常：先将申请写为 `approved`，再执行发放；若发放失败，记录 `feishuEvents.processingStatus=failed` 并返回 HTTP 200 toast `审批已通过，但发放失败，请到管理后台处理`，把后续处理交给管理后台兜底。
303. 本地验证通过：`npm run typecheck`、`npm run build`、Docker 构建 `tokeninside:card-callback-200671-final-20260703` 均成功；镜像 `voidintheshell/tokeninside:card-callback-200671-final-20260703` 与 `latest` 已推送到 Docker Hub，digest 均为 `sha256:87047f4db4df1860513bede62d9728421261be999b51752ca965e19e1af86c54`。
304. 按用户最新边界只在 LA 测试部署运行该修复：RemoteUSDMITLA `/home/beihai/tokeninside/docker-compose.yml` 已备份为 `docker-compose.yml.before-card-callback-200671-final-20260703`，compose image 切到 `voidintheshell/tokeninside:card-callback-200671-final-20260703`；LA 不使用 mihomo，`mihomo.service` 为 inactive。
305. LA 验收通过：`tokeninside-tokeninside-1` 运行 `voidintheshell/tokeninside:card-callback-200671-final-20260703` 且 healthy；LA 本机 `/api/health` 返回 200；LA 本机与公网 `https://ti.kumiko-love.com/api/feishu/events` 的新版 `card.action.trigger` 缺字段模拟均返回 HTTP 200 + `{ "toast": { "type": "error", "content": "审批卡片参数不完整" } }`；`feishu_events` 已写入测试回调记录。
306. 根据用户确认补充管理员后台“取消用户权限”任务：核对当前 `app/api/admin` 路由后确认还没有 revoke/disable 用户 active key 的独立管理端 API，现有能力只覆盖审批、设置、调额和月度账期重置。
307. 已更新 `task_plan.md`、`.agent-docs/TokenInside-E阶段管理后台与用量统计计划.md` 和 `findings.md`：新增管理员取消用户权限/禁用 active key 的计划任务，明确必须复用飞书 OAuth + `requireAdminScope()`，禁用后不得删除用户、token account、proxy logs、账期汇总或 NewAPI 历史 logs 归属，历史耗费继续留存在原飞书用户名下；本轮未修改业务代码，未触发生产禁用动作。
308. 按用户要求优先使用 `fast_context_search` 语义搜索“被取消资格/取消用户权限/禁用 active key/历史耗费保留”相关上下文；搜索结果确认现有代码有 token 状态、管理范围和禁用封装，但计划尚未成体系定义取消资格触发条件。
309. 已补充被取消资格触发条件到 E 阶段计划、总实现方案、`task_plan.md` 和 `findings.md`：强触发包括成员主动离职、被动离职、被解除劳动关系、飞书账号停用/删除、调离允许服务范围、管理员手动取消、安全事件/key 泄露、违规使用、误审批/误发放和成员主动停用；非触发包括额度用完、单次请求失败、上游/网络临时错误、主管权限变化本身、仍在允许服务范围内的普通调岗、通讯录临时读取失败或数据权限不足。本轮仍未修改业务代码，未触发任何生产禁用动作。
310. 根据用户补充，进一步明确组织变更口径：主动离职和被动离职都是取消资格强信号；被调离部门/转岗先触发资格复核，只有不再属于 TokenInside 允许服务范围时才进入取消资格候选，仍在允许范围内只更新部门归属和管理范围。
311. 按用户要求继续用 `fast_context_search` 语义搜索调离部门、额度继承、部门总额度、账期和部门归属相关代码；搜索确认当前实现以用户 `departmentId`、`userBillingPeriods` 和 active key quota 为主，没有部门预算池，也没有部门归属历史快照。
312. 已补充跨部门调动额度继承规则到 E 阶段计划、总实现方案、`task_plan.md` 和 `findings.md`：个人 active key 剩余额度默认随仍有资格的用户进入新部门；调动前历史已用按调用发生时部门快照留在原部门；部门总额度拆分为历史已用、当前剩余和调入调出调整；未来若有部门预算池，只迁移未用余额，不复制额度；后续实现需要部门归属历史或调用时部门快照。
313. 根据用户要求重新调整计划优先级：当前 P0 改为先走通真实飞书卡片审批，并要求飞书审批动作与 TokenInside App 申请状态、NewAPI 发放状态同步；E 阶段剩余管理员取消权限、部门历史快照、真实月度重置和报表能力降为审批闭环后的 P2。
314. 使用 `fast_context_search` 和精确代码搜索核对审批实现：`/api/token/request` 已创建申请、解析部门领导、发送飞书卡片并写入 `pending_card_approval`；`/api/feishu/events` 已处理新版/旧版 `card.action.trigger`、nonce、审批人 open_id、toast 和 NewAPI 发放；管理端 `decision` 路由可作为兜底，但不能替代真实飞书点击证据。
315. 使用 Next MCP 检查本地运行态：当前路由包含 `/api/token/request`、`/api/feishu/events`、`/api/admin/token-requests/[id]/decision`、`/api/admin/token-requests/[id]/quota`、`/api/token/quota-reset` 和 `/v1/[...path]`；`get_errors` 返回 config/session 均为空。
316. 已更新 `task_plan.md`、`.agent-docs/TokenInside-B阶段真实链路实测计划.md` 和 `findings.md`：新增审批同步硬门槛，明确真实 B3 必须把飞书点击、`feishu_events`、申请单状态、NewAPI 发放/失败、active key 和 `/v1` 可用性串成同一条证据链；飞书端业务失败也必须 HTTP 200 toast，避免再次表现为 `200671`。
317. 开始落地 P0 审批同步缺口：修改 `app/api/feishu/events/route.ts`，真实卡片 approve/reject 分支 now 会写入 `approvalOperatorOpenId` 和 `approvalOperatedAt`；卡片回调重复事件不再返回普通 `{ ok: true, duplicate: true }`，改为返回飞书卡片 toast `该申请已处理`。
318. 本地验证通过：`npm run typecheck` 成功；`npm run build` 成功，生产路由包含 `/api/feishu/events`、`/api/token/request`、`/api/admin/token-requests/[id]/decision` 和 `/v1/[...path]`；Next MCP `get_errors` 返回 config/session 均为空；`git diff --check` 无空白错误，仅有 Windows CRLF 提示。
319. Docker 构建 `tokeninside:p0-approval-sync-20260703` 成功，构建阶段 Next 生产构建通过；已推送 `voidintheshell/tokeninside:p0-approval-sync-20260703` 和 `voidintheshell/tokeninside:latest`，digest 均为 `sha256:36a5f6e200df0778c5c0950795398eadd8d465191528c9b2fda1f63024d11afe`。
320. RemoteUSDMITLA `/home/beihai/tokeninside/docker-compose.yml` 已备份为 `docker-compose.yml.before-p0-approval-sync-20260703`，compose image 已切换为 `voidintheshell/tokeninside:p0-approval-sync-20260703`；远端通过 `sudo -n docker compose pull tokeninside` 与 `up -d tokeninside` 更新，`tokeninside-tokeninside-1` 当前 healthy。
321. 远端和公网验收通过：远端本机 `/api/health` 返回 `status: ok`，公网 `https://ti.kumiko-love.com/api/health` 返回 `status: ok`，两者均显示 `store.type=postgres`、`schema.ready=true`、`tableCount=8`、`postgresPool.max=10`。容器日志仅有 Next Ready 信息。
322. 公网卡片回调重复事件模拟通过：容器内使用远端私有 verification token 构造同一 `card.action.trigger` 事件两次请求公网 `/api/feishu/events`，第一次返回 HTTP 200 `{\"toast\":{\"type\":\"error\",\"content\":\"审批卡片参数不完整\"}}`，第二次返回 HTTP 200 `{\"toast\":{\"type\":\"success\",\"content\":\"该申请已处理\"}}`，确认重复卡片事件不再返回普通 `{ ok: true }` JSON。
323. 用户反馈仍出现飞书卡片 `200671` 后，继续核对真实链路：GreenJP/BunkerWeb 真实日志曾显示飞书 IP 对 `POST /api/feishu/events` 收到上游 `400 51`，响应长度与旧代码 `Invalid Feishu event payload` 一致，说明请求已到公网入口但在 raw JSON 或解密解析阶段早返回，且未写入 `feishu_events`。
324. 已继续修改 `app/api/feishu/events/route.ts`：新增 raw/form payload 解析兜底、raw preview 脱敏、`recordInvalidFeishuPayload()`，对 raw parse 或 encrypt/payload parse 失败写入 `event_type=invalid_payload` 审计，并返回 HTTP 200 card toast `审批回调格式无法识别，已记录`，避免继续只给飞书 `200671` 而本地无证据。
325. 本地验证通过：`npm run typecheck`、`npm run build` 和 Next MCP `get_errors` 均通过；镜像 `voidintheshell/tokeninside:p0-feishu-invalid-payload-20260703` 与 `latest` 已推送到 Docker Hub，digest 为 `sha256:7044e3e27e2424405024d32a667faf4965725f114539c2d1203d4ce130d88a17`。
326. RemoteUSDMITLA `/home/beihai/tokeninside/docker-compose.yml` 已备份为 `docker-compose.yml.before-p0-feishu-invalid-payload-20260703`，compose image 切换到 `voidintheshell/tokeninside:p0-feishu-invalid-payload-20260703` 并 pull-only 更新；当前 `tokeninside-tokeninside-1` healthy，远端本机和公网 `/api/health` 均返回 200，`store.type=postgres`、`schema.ready=true`。
327. 公网不可解析 payload 模拟验证通过：`POST https://ti.kumiko-love.com/api/feishu/events` 使用 `content-type: text/plain` 返回 HTTP 200 + `{"toast":{"type":"error","content":"审批回调格式无法识别，已记录"}}`；PG `feishu_events` 写入 `invalid_payload`，`stage=raw_parse`，`contentType=text/plain`，`rawPreview=not-json-from-p0-invalid-payload-test`。BunkerWeb 同一请求日志状态码为 200。
328. 子 agent 查阅飞书官方文档结论已合并：`200671` 官方含义是卡片回调服务返回非 HTTP 200；`200672/200673` 才分别偏响应体格式或返回卡片错误。新版卡片回调应在 `开发配置 -> 事件与回调 -> 回调配置` 配置 Webhook 并添加 `卡片回传交互`，修改后需要发布应用版本；旧版 `应用能力 -> 机器人 -> 消息卡片请求网址` 属于历史路径，当前主路径应优先新版 `card.action.trigger`。
329. 按用户确认“部门主管账号是袁旗”复核当前真实申请：最新待审批单 `tr_e51e61df74ed36cccdf11b06` 为高成发起，状态 `pending_card_approval`，审批部门 `od-d8521bd193d26e3ccf9e6bec08b5bff1`，审批目标 `ou_9ca199a8a099f88b32d337e7c714062f`。飞书通讯录 API 确认该 open_id 姓名为袁旗，部门接口确认该部门 `leader_user_id` 也是袁旗 open_id。
330. 用户重新测试后飞书端显示“审批回调格式无法识别，已记录”，说明公网回调已经返回 HTTP 200 toast，不再是 `200671`；BunkerWeb 日志显示真实飞书请求均为 `POST /api/feishu/events` HTTP 200，PG 记录 `invalid_payload` 的 `contentType=application/json`、`wrapperKeys=[\"encrypt\"]`、`hasEncrypt=true`、`encryptLength=1004`、`stage=payload_parse`。
331. 对照飞书官方 Node SDK `@larksuiteoapi/node-sdk` 1.68.0，确认真实加密体解密规则为：`key=sha256(encryptKey)`，IV 使用 base64 解码后密文的前 16 字节，后续字节才是 AES-256-CBC ciphertext。项目旧实现错误使用 `sha256(encryptKey)` 的前 16 字节作为 IV，导致真实飞书 `{ encrypt }` 解密失败；此前自造加密 challenge 只验证了旧算法，不代表真实飞书算法。
332. 已修复 `lib/crypto.ts` 的 `decryptAes256CbcBase64()`：优先使用飞书 SDK 同款“密文前 16 字节作为 IV”规则，失败后 fallback 到旧 IV 规则以兼容历史自造测试样本。本地 `npm run typecheck` 和 `npm run build` 均通过。
333. 已构建并推送 `voidintheshell/tokeninside:p0-feishu-decrypt-20260703` 与 `latest`，digest 均为 `sha256:1beadd69edc3fc6060faacf900cf52cdafddef9fb97faaaad0ecd3ed57d23059`；首次版本 tag push 因 Docker Desktop 直连 auth.docker.io 超时失败，单独重试后成功。
334. RemoteUSDMITLA `/home/beihai/tokeninside/docker-compose.yml` 已备份为 `docker-compose.yml.before-p0-feishu-decrypt-20260703`，compose image 已切换到 `voidintheshell/tokeninside:p0-feishu-decrypt-20260703` 并 pull-only 更新；`tokeninside-tokeninside-1` healthy，远端本机和公网 `/api/health` 均返回 200。
335. 部署后使用容器内真实环境变量构造飞书官方 IV 规则的加密 payload，经公网 `/api/feishu/events` 验证通过：加密 challenge 返回 HTTP 200 `{\"challenge\":\"ti-official-iv-check-20260703\"}`；加密 `card.action.trigger` 缺字段返回 HTTP 200 `{\"toast\":{\"type\":\"error\",\"content\":\"审批卡片参数不完整\"}}`，PG 写入 `event_type=card.action.trigger` / `processing_status=ignored`，没有新增 `invalid_payload`。
336. 用户最新反馈飞书端显示 `200341` 后，远端证据显示业务链路实际已经成功：真实事件 `event_type=card.action.trigger`、`processing_status=processed`、`card_request_id=tr_8efb4f5f2001b5fc5a49138a`、`card_action=approve`、`operator_open_id=ou_9ca199a8a099f88b32d337e7c714062f`；同一申请已进入 `status=provisioned` 并绑定 `token_account_id=ta_f8ac4cce23bbcd445baf4b61`。
337. `200341` 根因定位为飞书客户端等待回调响应超时：BunkerWeb 对真实飞书请求记录为 HTTP `499`，说明客户端提前断开；结合 `approvalOperatedAt=2026-07-03T09:56:44.295Z` 与事件写入 `2026-07-03 09:56:46.706+00`，当前代码同步等待 NewAPI 发放完成后才返回 toast，超过飞书卡片回调等待窗口。
338. 已修复 `app/api/feishu/events/route.ts`：卡片 approve 分支先把申请写为 `approved`、记录原始飞书事件为 `processed` 并快速返回 HTTP 200 toast；NewAPI 发放改用 Next 16 `after()` 在响应完成后继续执行。若后台发放失败，`provisionTokenForRequest()` 会把申请写为 `approved_provision_failed`，并额外写入派生 `eventUuid:provision` 故障事件，不再覆盖原始飞书点击事件。
339. 本地验证通过：`npm run typecheck`、`npm run build`、`git diff --check` 均通过；`git diff --check` 仅有 Windows CRLF 提示。Docker 构建 `tokeninside:p0-feishu-fast-card-20260703` 成功，构建阶段 Next 生产构建通过。
340. 已推送 `voidintheshell/tokeninside:p0-feishu-fast-card-20260703` 与 `latest`，digest 均为 `sha256:f50343d940c64f063c9b7bf1f0c8dd93ba0ccb517dfdf639e5bb939760a30799`；RemoteUSDMITLA compose 已备份为 `docker-compose.yml.before-p0-feishu-fast-card-20260703`，并切换到该固定 tag 后 pull-only 重建 `tokeninside` 服务，Postgres 未重建。
341. 远端部署验收通过：`tokeninside-tokeninside-1` 当前运行 `voidintheshell/tokeninside:p0-feishu-fast-card-20260703` 且 healthy；远端本机和公网 `https://ti.kumiko-love.com/api/health` 均返回 200，显示 `store.type=postgres`、`schema.ready=true`、`approvalEventEncryption=true`。使用容器内真实环境变量构造官方 IV 规则加密 challenge，经公网 `/api/feishu/events` 返回 HTTP 200 `{\"challenge\":\"ti-fast-card-check-20260703\"}`。
342. 管理者默认用户后台、管理入口、快速审批、管理员默认发放 key、同用户多条首次申请状态收敛等收尾改动已本地验证：`npm run typecheck`、`npm run build` 和 Docker 构建均通过。
343. 已构建并推送 `voidintheshell/tokeninside:manager-user-closeout-20260703` 与 `latest`，两者 digest 均为 `sha256:9790af3beec86587f3cc05e683b32ee7e811ba6f69783ea20e37552501038973`。
344. 正式实例 `共绩TokenInside服务端机器` `/home/ubuntu/tokeninside` 已切换到 `voidintheshell/tokeninside:manager-user-closeout-20260703`，只重建 app 容器，PostgreSQL 未重建；容器内 `/api/health` 与公网 `/api/health` 均返回 `status: ok`、`store.type=postgres`、`schema.ready=true`。
345. LA `RemoteUSDMITLA` 已按用户要求重置为新环境：在确认主机 `DMIT-11tzJADpLQ`、目录 `/home/beihai/tokeninside`、compose 项目和 volume 名后，执行限定于该 compose 项目的 `docker compose down --volumes --remove-orphans`，删除 `tokeninside_pg_data` 与 `tokeninside_tokeninside_data`，未执行全局 prune。
346. LA 已用同一镜像 `voidintheshell/tokeninside:manager-user-closeout-20260703` 从空数据卷重建；仅执行 schema migration，不导入任何旧 JSON 或 PG 数据。空库计数确认：`feishu_users=0`、`token_requests=0`、`token_accounts=0`、`feishu_events=0`、`proxy_request_logs=0`、`admin_scopes=0`。
347. LA 本机和公网 `https://ti.kumiko-love.com/api/health` 均返回 `status: ok`、`store.type=postgres`、`schema.ready=true`、`tableCount=8`；LA app 和 postgres 容器均 healthy。
348. 已按用户要求补齐可公开提交的部署模板：`.env.example` 改为带注释的 PostgreSQL compose 部署入口，覆盖 Feishu、NewAPI、管理员、数据库、session、账期和 mock 开关等初始变量；`docker-compose.example.yml` 改为 app + postgres 双容器样例，用户可复制 `.env.example` 为 `.env` 后直接 compose 启动并运行 `npm run db:migrate`。同步更新 `.env.production.example` 和 `docker-compose.production.example.yml`，生产 compose 默认仍读 `.env.production`，也可通过 `TOKENINSIDE_ENV_FILE` 指向示例文件做配置校验。`docker compose --env-file .env.example -f docker-compose.example.yml config --quiet` 与生产模板校验均通过。
349. 本轮根据用户最新反馈只做分析和规划更新，未修改业务代码、未构建镜像、未部署。使用 `planning-with-files-zh` 恢复根目录 `task_plan.md`、`findings.md`、`progress.md`；其中一次 memory/计划辅助命令因 Windows 沙箱 `CreateProcessWithLogonW failed: 1326` 失败，已继续使用已读计划文件和代码语义搜索结果推进。
350. 使用 `fast_context_search` 搜索系统管理员、额度、用户后台、active key 提示、刷新按钮、自动识别、最新审批请求、模型列表和管理员环境变量相关实现，定位到 `components/experience-client.tsx`、`components/admin-client.tsx`、`lib/admin-sync.ts`、`lib/store.ts`、`lib/config.ts` 等文件。
351. 分析结论：计划中已有账期额度、基础用量统计和管理后台额度统计，但用户后台当前只展示账期额度、tokens 和代理请求，没有按产品口径展示当前账期剩余额度；管理后台统计里已有剩余额度概念，但还需统一单位和权威口径，不能简单把 display quota 与 tokens 相减。
352. 分析结论：现有全局管理员配置为 `TOKENINSIDE_ADMIN_OPEN_IDS`，代码层映射为 `scopeType=global` / `source=environment`；用户最新口径要求前端和产品概念统一叫“系统管理员”，并要求初始化环境变量可手动配置系统管理员。计划已写入新增 `TOKENINSIDE_SYSTEM_ADMIN_OPEN_IDS` 并兼容旧变量的建议。
353. 分析结论：当前部门主管自动同步只覆盖“当前登录用户是其部门负责人”的管理员授权；申请审批目标解析失败、无组织或主管不可识别时，需要新增系统管理员兜底审批，不能静默不发送请求。计划已补入固定 UI 提示文案和系统管理员兜底发送要求。
354. 已更新 `task_plan.md`：把系统管理员兜底审批加入 P0 pending，把管理员治理与用户后台收口加入 P1 pending，并在下一阶段入口加入 E8-1 到 E8-5 优先修复包。
355. 已更新 `.agent-docs/TokenInside-E阶段管理后台与用量统计计划.md`：新增边界 15-18、用户后台 UI 收口优先项、系统管理员初始化/查看/指派管理员规格、系统管理员兜底审批规格，并把交付物扩展为系统管理员兜底、管理员初始化配置和用户后台剩余额度/布局收口。
356. 已更新 `findings.md`：记录“全局管理”改名“系统管理员”、系统管理员兜底审批、固定用户提示文案、查看/指派管理员、用户后台剩余额度单位风险和 UI 收口要求。本轮未触发任何生产审批、调额、key reset 或管理员变更动作。
357. 按用户要求开始落地 E8 近期优先修复包：新增 `TOKENINSIDE_SYSTEM_ADMIN_OPEN_IDS` 配置并兼容旧 `TOKENINSIDE_ADMIN_OPEN_IDS`；服务端管理范围展示统一为“系统管理员”，环境变量系统管理员优先级高于存储中的手动/部门管理员范围。
358. 已本地实现系统管理员兜底审批：部门主管解析失败、用户无组织、无负责人、负责人等于申请人或通讯录读取异常时，`resolveApprovalTargetForUser()` 回退到系统管理员 open_id；申请和额度重置接口会把固定提示随响应返回给前端。
359. 已本地实现系统管理员查看和指派管理员：新增 `/api/admin/admins` 与 `/api/admin/admins/[id]`，系统管理员可查看全部管理员来源并指派系统管理员或部门管理员；环境变量管理员为只读来源，不能被接口修改。
360. 已本地收口用户后台：管理后台入口只保留在用户卡片处；最新审批请求只在管理员用户后台首屏展示；active key 状态提示移动到用户卡片状态区；刷新按钮固定在用户卡片右下方；自动识别状态改为旋转动画；用户后台底部小字移除；品牌副标题改为“共绩科技”；模型列表说明改为“当前可用的模型ID”。
361. 已本地补齐用户后台剩余额度：`/api/session` 在 active key 存在且有 `newapiTokenId` 时读取 NewAPI 当前 token `remain_quota`，按 `NEWAPI_QUOTA_PER_UNIT` 换算后写入 `activeToken.remainingQuota` 和 `billingPeriod.remainingQuota`，用户后台当前账期卡片展示账期额度与剩余额度。
362. 已按用户要求把 `.env.example` 和 `.env.production.example` 改为中文变量说明，逐项说明变量用途和获取位置，覆盖飞书凭证/事件、系统管理员 open_id、NewAPI 控制凭证、PostgreSQL、session、账期和 mock 开关。
363. 本地验证通过：`npm run typecheck` 成功；`npm run build` 成功，路由表包含新增 `/api/admin/admins` 和 `/api/admin/admins/[id]`；Next MCP `get_errors` 返回 `configErrors=[]`、`sessionErrors=[]`。本轮尚未构建 Docker 镜像、推送 Docker Hub 或部署到公网实例。
364. 按用户补充要求，将 token/额度只读展示改为参考 Aether 的紧凑单位口径：新增 `formatCompactNumber()` / `formatTokenAmount()`，按十进制 K/M/B/T 自动缩写大数，1000 以下保持原样。
365. 已替换用户后台和管理后台展示点：当前账期额度、剩余额度、总/输入/输出 tokens、管理概览总 tokens、当前账期 tokens、当前账期额度、审批申请额度、默认额度当前值、用户额度统计和使用记录 tokens 均改为紧凑展示；输入框和请求体仍保持原始数字。
366. 补充验证通过：`npm run typecheck` 成功；`npm run build` 成功；Next MCP `get_errors` 返回 `configErrors=[]`、`sessionErrors=[]`。本轮仍未构建 Docker 镜像、推送 Docker Hub 或部署到公网实例。
367. 已按本地构建、Docker Hub 推送、LA pull-only 路径部署 E8 修复包：本地 `docker build -t tokeninside:e8-system-admin-compact-tokens-20260703 .` 成功，构建阶段 Next 生产构建通过；已推送 `voidintheshell/tokeninside:e8-system-admin-compact-tokens-20260703` 和 `voidintheshell/tokeninside:latest`，digest 均为 `sha256:b127d76d4edd7cbba6fd251d1f59a249f91c8b18f4e4cbb84458b35fe423e70e`。
368. RemoteUSDMITLA `/home/beihai/tokeninside/docker-compose.yml` 已备份为 `docker-compose.yml.before-e8-system-admin-compact-tokens-20260703`，compose image 已切换到 `voidintheshell/tokeninside:e8-system-admin-compact-tokens-20260703`；远端只执行 `sudo -n docker compose pull tokeninside` 和 `up -d tokeninside`，PostgreSQL 容器与数据卷未重建。
369. LA 部署验收通过：`tokeninside-tokeninside-1` 运行新 tag 且 healthy；远端本机和公网 `https://ti.kumiko-love.com/api/health` 均返回 `status: ok`，`store.type=postgres`、`schema.ready=true`、`systemAdmins=1`、`newapiQuotaPerUnit=500000`；公网 `/` 和 `/admin` 均返回 HTTP 200；公网 `/v1/models` 无认证返回 HTTP 401 JSON `Bearer NewAPI key is required`；公网 `/api/session` 未登录返回正常 JSON。
370. 本轮根据用户最新前端细节反馈只做计划更新，未修改业务代码、未构建镜像、未部署。使用 `planning-with-files-zh` 恢复根目录规划文件，并按 AGENTS 要求优先使用 `fast_context_search` 定位到 `components/admin-client.tsx`、`task_plan.md` 和 `lib/admin.ts` 等相关上下文。
371. 已更新 `task_plan.md`、`.agent-docs/TokenInside-E阶段管理后台与用量统计计划.md` 和 `findings.md`：新增 E8-8 前端细节修复包，覆盖 PC 用户卡片右侧管理后台入口对齐、移动端管理后台按钮/刷新按钮位置、移除独立管理范围卡片、顶部数据改为正方形指标块、“当前账期发放额度/剩余额度”和“总用户数”统计口径。
372. 按用户要求落地 E8-8：修改 `lib/store.ts`，`getAdminOverview()` totals 新增 `keyedUsers` 和 `currentPeriodRemainingQuota`；修改 `components/admin-client.tsx`，管理后台状态总览改为 `metric-grid`，文案改为“总用户数”“当前账期发放额度”“当前账期剩余额度”，并移除独立“管理范围”卡片；修改 `app/globals.css`，让用户卡片右侧 action/controls 居中，移动端管理范围与状态/刷新按钮同列且按钮右下对齐，指标卡固定为紧凑方形布局。
373. E8-8 本地验证通过：`npm run typecheck` 成功；`npm run build` 成功，Next.js 16.2.10 生产构建通过且路由包含 `/admin`、`/api/admin/overview` 和管理相关 API；Next MCP `get_errors` 返回 `configErrors=[]`、`sessionErrors=[]`；浏览器打开 `http://localhost:16878/admin` 后桌面快照显示新指标文案且无独立管理范围卡片，移动端 390x844 截图显示管理范围文字与右下刷新/状态按钮同列对齐，控制台无 error/warn。
374. E8-8 镜像已按项目部署约束完成本地构建和 Docker Hub 推送：`docker build -t tokeninside:e8-8-admin-layout-20260703 .` 成功；已推送 `voidintheshell/tokeninside:e8-8-admin-layout-20260703` 与 `voidintheshell/tokeninside:latest`，镜像 digest 为 `sha256:afbec682e0ad23bde848cba13cc6dead09424e6bbd3baede59afd0ad5d014aa2`。
375. E8-8 已部署到 RemoteUSDMITLA/LA：远端 `/home/beihai/tokeninside/docker-compose.yml` 已备份为 `docker-compose.yml.before-e8-8-admin-layout-20260703`，app image 已切到 `voidintheshell/tokeninside:e8-8-admin-layout-20260703` 并 `docker compose pull/up -d tokeninside`；`docker compose ps` 显示 `tokeninside-tokeninside-1` healthy，远端 `http://127.0.0.1:16878/api/health` 返回 `200 application/json`，公开 `https://ti.kumiko-love.com/admin` 与 `https://ti.kumiko-love.com/api/health` 均返回 200，公开 `/admin` HTML 已包含“总用户数”“当前账期发放额度”“当前账期剩余额度”。

## 2026-07-04

376. 用户要求管理后台重做计划马上落地，并补充部门管理员的“用户统计”只能是该部门下属用户。本轮按要求先使用 `fast_context_search` 定位文件，再更新计划文档，然后开始实现。
377. 已更新 `task_plan.md`：新增 E9 管理后台重做立即落地阶段，明确将旧“额度管理”“管理员”“额度统计”合并为“用户管理”，新增系统管理员专用“部门统计”、部门管理员范围内“用户统计”、用户侧/管理侧“使用记录”和禁用/删除重新申请链路。
378. 已更新 `.agent-docs/TokenInside-E阶段管理后台与用量统计计划.md`：新增边界 19-25 和 E9 专项计划，写清页面信息架构、用户管理字段、系统管理员/部门管理员权限规则、部门统计、用户统计、使用记录、API、数据模型和验收标准。
379. 已更新 `findings.md`：记录 fast-context 定位结果、Aether 参考文件、部门管理员统计范围、删除用户软删除语义和部门快照字段需求。下一步开始落地后端 scope/list/stats/usage/revoke API 与管理后台 UI。
380. E9 后端首轮已本地落地：新增 `FeishuUser.status`、禁用/删除字段和 proxy log 部门快照字段；新增用户管理、用户统计、部门统计、管理侧使用记录、用户侧使用记录、用户禁用和用户删除 API；部门统计仅系统管理员可用，部门管理员直接访问返回 403。
381. E9 权限边界已服务端收口：用户管理、用户统计和管理侧使用记录均通过 admin scope 裁剪后返回；部门管理员只能看到本部门下属用户；删除为软删除/撤销资格，用户重新申请时清除删除标记并走新申请；`/v1/[...path]` 增加 disabled/deleted 用户状态兜底 403。
382. E9 前端首轮已本地落地：`/admin` 旧“额度管理”“管理员”“额度统计”合并为“用户管理”；新增系统管理员可见的“部门统计”、系统/部门范围内的“用户统计”、管理侧“使用记录”；用户后台“使用记录”迁入 Aether 风格表格组件。
383. 本地验证通过：`npm run typecheck` 成功；`npm run build` 成功；`git diff --check` 无空白错误，仅有 Windows LF/CRLF 提示；Docker 构建 `tokeninside:e9-admin-redesign-20260704` 成功，构建阶段 Next 生产构建通过。
384. 已推送 `voidintheshell/tokeninside:e9-admin-redesign-20260704` 与 `voidintheshell/tokeninside:latest`，两者 digest 均为 `sha256:238326535896e792dab490bc6571a5d7d8b01e1e4420ba7887293945e5bb0b75`。
385. 已更新 LA/RemoteUSDMITLA 部署：`/home/beihai/tokeninside/docker-compose.yml` 已备份为 `docker-compose.yml.before-e9-admin-redesign-20260704`，app image 已切到 `voidintheshell/tokeninside:e9-admin-redesign-20260704`；远端执行 `sudo -n docker compose pull tokeninside` 和 `up -d tokeninside`，PostgreSQL 未重建。
386. LA 验收通过：`tokeninside-tokeninside-1` 运行 E9 镜像且 healthy；远端本机 `/api/health` 返回 200；公网 `https://ti.kumiko-love.com/api/health` 返回 200 且 `store.type=postgres`、`schema.ready=true`、`systemAdmins=1`；公网 `/admin` 返回 200；本机 `/api/admin/users` 未登录返回 401 JSON。
