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
