# TokenInside 实现方案完善计划

## 目标

将飞书官方文档确认的网页应用免登、用户信息字段权限、飞书卡片请求回调、指定用户消息发送、通讯录部门负责人字段、`offline_access`、敏感通讯录字段权限等结论，补充进 TokenInside 实现方案，形成可落地的权限边界和实现链路。

## 阶段

| 阶段 | 状态 | 内容 |
|---|---|---|
| 1 | complete | 读取现有实现方案与原始需求文档 |
| 2 | complete | 梳理飞书官方文档权限结论 |
| 3 | complete | 编辑实现方案，补充飞书应用配置、权限矩阵、免登/OAuth 链路 |
| 4 | complete | 复查文档一致性并输出总结 |
| 5 | superseded | 旧审批实例方案已被飞书卡片请求回调方案替代，保留为备用路径 |
| 6 | complete | 补充前端实现约束：TokenInside 控制面已确认采用 shadcn/ui 风格和组件体系 |
| 7 | complete | 根据最新方案补充飞书卡片审批：TokenInside 解析用户所在部门领导，并把审批卡片点对点发送给该领导 |
| 8 | complete | 根据最新产品变更补充三页面信息架构、shadcn 白蓝主题、模型列表菜单和 LLM 透传接口范围 |

## 待补充重点

1. 明确 MVP 最小权限不申请通讯录宽权限、消息、云文档等无关 OpenAPI 权限。
2. 明确网页应用入口、H5 可信域名、OAuth redirect URL、可用范围是应用配置要求。
3. 明确 `requestAccess({ scopeList: [] })` 用于端内网页应用免登和基础用户信息授权。
4. 明确默认主身份采用 `tenant_key + open_id`，邮箱和手机号不得作为唯一登录凭证。
5. 明确 `offline_access`、邮箱、手机号、user_id、工号、通讯录权限均为按需扩展。
6. 将飞书权限边界影响到数据库字段、管理员身份、MVP 范围和安全边界。
7. 明确审批主链路改为 TokenInside 自管审批状态机 + 飞书交互卡片，不再以飞书原生审批实例作为 MVP 主路径。
8. 明确审批卡片必须发送给申请人所在部门的领导：服务端根据飞书通讯录解析申请人部门，再读取部门 `leader_user_id`，前端不能自报审批人。
9. 明确飞书普通入口、移动端主页和管理员后台入口均使用 `ti.kumiko-love.com` 同一业务域名，TokenInside 通过 `/` 与 `/admin` 做路由分流，管理权限由服务端计算。
10. 明确控制面只保留申请界面、用户后台、管理后台三页面；未申请普通用户进申请界面，已申请用户和管理员默认进用户后台。
11. 明确申请界面只展示用户卡片和申请按钮；用户后台增加模型列表菜单；管理后台入口只在管理员用户卡片旁展示。
12. 明确数据面 MVP 只透传 OpenAI Chat Completions、OpenAI Responses 和 Claude-compatible messages，不把 embeddings、images、audio、Gemini-compatible 作为本期范围。

## 风险

1. 当前仓库基本只有文档，前端已确认采用 shadcn/ui；后续实现前仍需确认后端技术栈和 NewAPI 接口实测结果。
2. 飞书卡片审批已纳入 MVP，主路径需要应用机器人点对点发送交互卡片、订阅 `card.action.trigger` 回调，并申请通讯录用户/部门只读字段权限以解析部门领导。
3. 不默认申请 `approval:task`，也不默认继续依赖 `approval:instance`；原生审批实例仅作为后备方案或历史实测记录保留。

## 落地执行计划

| 阶段 | 状态 | 内容 |
|---|---|---|
| A1 | complete | 初始化 Next.js 16 + React 19 + shadcn 风格控制面工程骨架 |
| A2 | complete | 实现服务端配置、签名 session、JSON MVP store、飞书和 NewAPI 客户端封装 |
| A3 | complete | 实现飞书 OAuth 回调、当前会话、Token 申请、key 查看、审批事件回写 API |
| A4 | complete | 实现根路径 `/v1/[...path]` NewAPI 透传代理、key hash 绑定校验和代理审计 |
| A5 | complete | 完成依赖安装、类型检查、生产构建、依赖审计和本地页面/API 冒烟验证 |
| B | in_progress | 服务器优先真实链路：`ti.kumiko-love.com` 已迁移到 `共绩TokenInside服务端机器`，后续在生产机完成飞书 OAuth、部门领导解析、卡片审批回调、NewAPI token 管理和 `/v1` 代理实测，不再使用 LA/USLA 继续开发 |
| C | in_progress | PostgreSQL foundation 已落地并在生产机切换启用：新增 schema 迁移脚本、JSON 导入脚本、可选 Postgres store、健康检查和 2C2G 默认容器/连接池参数；后续仍需补齐行级事务状态机和备份/恢复运维 |
| D | pulled_forward | 部署运维工作前置并合入 B0；当前生产机使用统一 compose 管理 PG/app、Nginx Proxy Manager 内网反代 `tokeninside:16878`，后续发布路径为本地构建、推送 Docker Hub、生产机通过 `production-docker-pull-with-mihomo.sh` 临时启用 mihomo 拉镜像后立即停用，再 compose up；save/load 仅作回退 |
| E | in_progress | 已按最新口径前置补齐申请界面/用户后台分流、用户后台模型列表、管理员入口权限展示、`/admin` 入口壳、管理范围数据结构和只读概览 API；已继续补齐默认额度配置、审批单额度覆盖、管理端审批、基础用量统计、key 重置、用户侧额度重置申请、部门主管自动同步、管理端主动调额、基础账期同步汇总和默认关闭的月度账期重置执行入口；后续仍需在生产维护窗口开启并实测真实月度重置 |

## 当前落地状态

1. 本地服务已启动在 `http://127.0.0.1:16878`。
2. 首版使用 `.local-data/tokeninside.json` 作为 MVP 状态存储；后续生产化应替换为 PostgreSQL。
3. `.env.example` 只保留占位符，没有写入真实 NewAPI System AK、飞书密钥或其他私密凭据。
4. 依赖审计通过 `postcss` override 修复为 0 vulnerabilities。
5. 外部飞书回调、卡片请求回调、NewAPI token 创建接口改为在 USLA 公网测试环境实测，避免飞书回调 URL 必须公网验证导致本地死循环。
6. B 阶段已补齐真实链路承接代码：飞书事件加密解包、verification token 校验、事件幂等、NewAPI token 创建后搜索取 key、禁用和额度更新封装。
7. 当前仓库未发现 `.env.local`；后续真实密钥优先写入服务器环境变量或服务器私有 `.env.production`，本地只做构建和脚本 readiness。
8. B 阶段本地验证已通过：`npm run typecheck`、`npm run build`、`npm run b:check` readiness、无密钥 API 冒烟和密钥落盘检查。
9. B 阶段策略已调整为服务器优先：最终阶段产物是 Docker 镜像，所有飞书事件、卡片审批回调和 NewAPI 控制面实测直接在 `https://ti.kumiko-love.com` 上调试。
10. B0 本地 Docker 基线已完成：已新增 Dockerfile、`.dockerignore`、`.env.production.example`、compose 示例和 `/api/health`；`tokeninside:latest` 镜像构建成功，本地生产容器冒烟通过。
11. `.env` 已可被本地检查脚本加载；B1 基础飞书凭据检查通过，B4 NewAPI token 控制面只读和变更探测通过。
12. B2/B3 主路径已改为飞书卡片审批：后续需要补齐消息发送权限、卡片回调订阅、通讯录用户/部门字段权限和部门领导解析实测；原 `FEISHU_APPROVAL_CODE_TOKEN_REQUEST` 仅作为旧审批实例路径配置保留。
13. B0 镜像已按“本地构建、推送 Docker Hub、服务器只拉取运行”的方式完成：`voidintheshell/tokeninside:b0-20260702-1526` 与 `voidintheshell/tokeninside:latest` 已推送，digest 为 `sha256:77faf6da8a61fac4f5033582563af3f8c7305fe31ed4f7ea158a0c324a25d3d7`。
14. USLA `/home/beihai/tokeninside` 已使用 pull-only compose 拉取并运行 Hub 镜像，容器 `tokeninside-tokeninside-1` 当前 `running` / `healthy`，端口为 `0.0.0.0:16878->16878/tcp`，服务器未执行源码构建。
15. 远端本机直连验证通过：`/api/health` 返回 `status: ok` 且 JSON store 可写，`/api/feishu/events` challenge 返回 200 JSON，`/v1/models` 无认证返回 401 JSON，未绑定 key 返回 403 JSON，首页返回 200。
16. 公网域名 `https://ti.kumiko-love.com` 链路已通：`/api/health`、`/api/session`、`/` 和 `POST /api/feishu/events` challenge 均返回预期 JSON/HTML。
17. GreenJP/BunkerWeb 已为 `ti.kumiko-love.com` 设置 `REVERSE_PROXY_INTERCEPT_ERRORS=no`，公网 `/v1/models` 的 401/403 和事件入口无效 payload 的 400 均能保留 TokenInside 上游 JSON 响应体。
18. 用户补齐审批相关 `.env` 后，本地 `npm run b:check -- --all` 已通过，飞书 tenant token 与 NewAPI token 只读接口均可用。
19. 已将审批 code、事件 verification token、事件 encrypt key 三项合并进远端 `/home/beihai/tokeninside/.env.production`，保留远端原有 session secret；变更前备份为 `.env.production.before-approval-20260702T082337Z`。
20. 远端容器已用同一 Hub 镜像重建并恢复 healthy，线上 `/api/health` 显示 `approvalCode`、`approvalEventVerification`、`approvalEventEncryption` 全部为 true。
21. 线上加密飞书事件 challenge 已通过签名、解密和 verification token 校验，返回 `{"challenge":"ti-encrypted-check"}`。
22. 飞书审批事件订阅已调用成功；`npm run b:check -- --subscribe-approval` 已支持幂等复跑，当前返回 `already subscribed`。
23. 飞书入口策略已补入计划：普通入口和移动端主页使用 `https://ti.kumiko-love.com`，飞书“管理员后台”使用 `https://ti.kumiko-love.com/admin`，但管理员权限仍由 TokenInside 服务端基于部门主管关系和 `admin_scopes` 判断；审批卡片收件人同样由服务端通讯录解析，不能由入口或前端决定。
24. E0 管理入口已前置落地：新增 `/admin` 页面、`/api/admin/overview`、JSON store `adminScopes` 结构、管理范围过滤和首页到管理后台的导航；直接访问管理 API 保持 401/403，页面 soft 请求避免未登录状态产生浏览器 console error。
25. E0 管理入口已部署到 USLA：新镜像 `voidintheshell/tokeninside:e0-admin-20260702-1710` 与 `latest` 已推送，digest `sha256:23e6d5e9ba9fea04d77e18a2a0cb49a5659ab858c151ac496728f37cb86f56f1`；远端 compose 已 pull-only 重建，容器 healthy，公网 `/admin` 返回 200。
26. B1 飞书端内免登出现新阻塞：用户在飞书 H5/客户端内打开页面仍报“没有检测到飞书 H5 JSAPI”。已新增 `.agent-docs/TokenInside-B1飞书H5免登修复计划.md`，并已本地落地 JSSDK loader、`appID`、`requestAuthCode` 回退、OAuth v3 code 换 token、自动免登和用户身份卡。
27. 按最新产品要求，首页和 `/admin` 已移除手动“飞书免登”按钮；端内入口只能走自动识别和自动登录流程，登录成功后展示飞书头像、姓名、open_id、租户/部门或管理范围。
28. B1 修复已部署到 USLA：当前远端容器运行 `voidintheshell/tokeninside:b1-feishu-h5-redirect-20260702`，digest `sha256:117e94f6074d3a36dfb6d51e838b4499a153b2f8f04ea3ffdb70071f643f9dab`，容器 healthy；公网 `/`、`/admin`、`/api/health`、`/api/feishu/app-id` 和 `/v1/models` 无 key JSON 错误体已复测通过。
29. B1 端内免登阻塞已解除：飞书后台重定向 URL 已配置成功，用户手动复测确认后台能够获取飞书用户信息；下一步可以基于真实飞书用户继续 B2/B3 卡片审批主链路。
30. 飞书事件回调地址当前可通过生产形态 challenge：容器内构造签名加密 payload 后，公网 `POST https://ti.kumiko-love.com/api/feishu/events` 返回 200 `{"challenge":"ti-deploy-check-20260702"}`。
31. 最新产品变更已补入文档：前端使用 shadcn 主题和白蓝配色；控制面只保留申请界面、用户后台、管理后台；申请界面只做申请和用户卡片；用户后台增加模型列表菜单并移除透传网关子菜单；管理后台入口只对管理员在用户卡片旁展示；数据面 MVP 只对接 NewAPI 的 OAI Chat、OAI Responses 和 Claude-compatible messages。
32. E1/E2 前端信息架构已开始代码落地：未发放 key 的普通用户首页只保留飞书用户卡片和申请按钮；已有 active key 的用户进入用户后台，可在“账户”和“模型列表”之间切换；管理后台入口只在 `/api/session` 返回管理范围时显示在用户卡片旁。
33. 已新增登录用户模型列表 API `/api/models`，服务端通过当前 active token 的 NewAPI token id 读取完整 key 后调用 NewAPI `/v1/models`，前端只接收模型元数据，不暴露明文 key。
34. 数据面 MVP 范围已在 `/v1/[...path]` 代码层收口：仅允许 `GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses`、`POST /v1/messages`；其它路径返回 404，已知路径方法不匹配返回 405。
35. JSON MVP store 写入临时文件名已改为每次写入唯一，修复并发代理日志写入时 `rename ENOENT` 的本地复现问题。
36. B2/B3 卡片审批主路径已本地代码落地：申请接口默认解析部门领导并发送交互卡片，事件入口新增 `card.action.trigger` 分支并校验 requestId、nonce 和审批人 open_id。
37. B2 通讯录权限阻塞已解除：用户调整飞书权限后，`npm run b:check -- --feishu-contact` 已通过，应用身份可读取成员列表、`department_ids`、用户详情和 `leader_user_id` 字段。
38. B2/B3 卡片审批代码已部署到 USLA：镜像 `voidintheshell/tokeninside:b2-card-20260702-2210` 与 `latest` 已推送并部署，digest 为 `sha256:388c7af2ee4c05ed2a7448d722b4e6cc2ceddf0bca85abcfc25574d79c8accb9`；远端容器 running/healthy。
39. 线上基础验证通过：公网 `/api/health` 200，公网 `/` 200 HTML，公网 `/v1/models` 无 key 返回 401 JSON，公网 `/v1/embeddings` 返回 TokenInside allowlist 404 JSON；签名加密事件 challenge 返回 `{"challenge":"ti-b2-card-check-20260702"}`，签名加密 `card.action.trigger` 缺字段模拟返回 200 错误 toast。
40. 用户真实测试发现三项问题：用户已加入部门但用户卡片部门仍显示占位符；点击申请时报 `Bot ability is not activated.`；申请理由需要用户填写，默认申请金额需要展示但不可修改。已本地修复部门懒同步、申请表单和机器人能力错误提示。
41. B2/B3 修复已部署到 USLA：镜像 `voidintheshell/tokeninside:b2-card-fix-20260702-2310` 与 `latest` 已推送并部署，digest 为 `sha256:52ab21f02022e0b0f7ed68e5cbce282a2bcbf5acf1e74629f34a3df5923e4ffa`；远端容器 running/healthy，公网 `/api/health`、`/`、`/v1/models` 无 key、`/v1/embeddings` allowlist 404 和签名加密事件 challenge 均复测通过。
42. 最新额度配置需求已补入计划：管理后台需要提供默认申请额度配置，初始化值为 `200`；普通用户申请页只展示该值且不可修改；审批每条申请时可手动确认或覆盖最终额度，审批通过后以最终额度发放和进入账期统计。
43. 用户卡片展示收尾已本地完成：首页用户卡移除“租户”，部门展示改为服务端从飞书部门详情解析出的 `departmentName`，管理后台当前用户与管理范围同样优先展示部门名称。
44. 用户卡片展示收尾已部署到 USLA：当前运行镜像为 `voidintheshell/tokeninside:b2-user-card-dept-20260702`，digest `sha256:a2593de49c3564e23fdc36dd19703e59329ae42c370b1b0831f322ea2332d98e`，公网健康、未登录 session、无 key `/v1/models` 和飞书事件签名 challenge 均已复测。
45. E 阶段额度配置已进入代码落地：默认申请额度改为 JSON store settings，由管理后台配置；普通申请接口只接受申请理由，额度从服务端默认值生成快照；管理后台可对待审批申请写入最终额度，发放时优先使用最终额度。
46. E 阶段额度配置已部署到 USLA：当前运行镜像为 `voidintheshell/tokeninside:e-quota-config-20260702` 的后续收尾镜像已被 `voidintheshell/tokeninside:hide-department-20260703` 替换；公网健康、未登录 session settings、管理设置 401 和飞书事件签名 challenge 均已复测。
47. 远端生产 `TOKENINSIDE_SESSION_SECRET` 已从示例占位符替换为服务器随机值，并重建容器恢复 healthy；新密钥只存在服务器私有 `.env.production`，未写入仓库。
48. E 阶段继续补齐管理能力：新增 `TOKENINSIDE_ADMIN_OPEN_IDS` 作为飞书 OAuth 后的服务端全局管理员授权白名单；新增 `POST /api/admin/token-requests/[id]/decision`，授权管理员可在当前管理范围内通过/拒绝申请，通过时按最终额度触发 NewAPI token 发放。
49. 管理概览已扩展可见用户、最近代理日志、申请错误、审批目标、操作人和操作时间；`pendingRequests` 已包含卡片审批中的申请，避免管理后台把 B2/B3 待处理项显示为 0。
50. `ti.kumiko-love.com` 已迁移到 `共绩TokenInside服务端机器` 生产机继续开发；生产机已部署 `tokeninside-postgres` 与 `tokeninside` 两个容器，NPM 通过内部网络访问 `tokeninside:16878`。
51. 生产 PostgreSQL 已按 2C2G 收敛参数启动：`max_connections=30`、`effective_cache_size=768MB`、`shared_buffers=256MB`、`work_mem=4MB`、`statement_timeout=30s`，app pool `max=10`。
52. 生产部署方式已调整：镜像同步推送到 `voidintheshell` Docker Hub；生产机 mihomo 部署后远端 pull 已恢复，后续优先 `docker pull` + `docker compose up -d`，本地 `docker save` 上传 tar 后 `docker load` 作为回退路径。
53. NPM 内部服务名解析已修复：在 NPM 数据卷持久化 Docker DNS resolver 后，`https://ti.kumiko-love.com/api/health` 在生产机公网路径返回 200。
54. 生产机实际部署已收敛为一份 `/home/ubuntu/tokeninside/docker-compose.yml`，统一管理 `tokeninside-postgres` 和 `tokeninside`；compose volume 显式固定为 `tokeninside_pg_data` 与 `tokeninside_app_data`。
55. PostgreSQL 生产备份/恢复护栏已落地：支持宿主机 `pg_dump -Fc` 备份和 sha256，恢复脚本默认拒绝执行并要求显式确认。

## 计划文档索引

| 文档 | 用途 |
|---|---|
| `.agent-docs/TokenInside-实施总路线图.md` | A 到 E 阶段总路线、风险排序和下一步入口 |
| `.agent-docs/TokenInside-B阶段真实链路实测计划.md` | 飞书 OAuth、审批、事件、NewAPI token 管理、`/v1` 代理真实链路实测 |
| `.agent-docs/TokenInside-B1飞书H5免登修复计划.md` | 修复飞书端内打开仍检测不到 H5 JSAPI，补齐 JSSDK loader、appID、requestAuthCode 回退和 OAuth token 交换 |
| `.agent-docs/TokenInside-C阶段数据库生产化计划.md` | PostgreSQL schema、约束、迁移、事务和 JSON 数据导入 |
| `.agent-docs/TokenInside-D阶段部署运维计划.md` | Docker、USLA 部署、反代、健康检查、日志和防绕过网络策略 |
| `.agent-docs/TokenInside-E阶段管理后台与用量统计计划.md` | 用户后台、管理员后台、飞书入口分流、部门权限、用量同步、调额和重置 |
| `.agent-docs/TokenInside-真实链路实测记录.md` | B 阶段本地落地结果、待实测项和外部阻塞项 |

## 下一阶段入口

B 阶段优先执行顺序已调整为服务器优先：

1. B0/D 生产部署保留在 `共绩TokenInside服务端机器`：当前生产镜像为 `voidintheshell/tokeninside:prod-health-schema-20260703`，digest `sha256:7655935ac1e539151cf61cb47db4ba2f8c49c72bc3cad13a489ffa82d9ee786b`；生产机运行统一 compose 管理 PG/app，NPM 内网反代上游为 `tokeninside:16878`，health 已检查 PostgreSQL schema readiness。因生产机域名接入/云厂商拦截问题，当前开发调试入口临时切回 GreenJP -> LA，LA 运行同一镜像但仍使用 JSON store；后续处理完 DNS/备案/接入后再切回生产机。
2. B1 当前代码层修复已本地和公网验证通过：H5 JSSDK 加载、`h5sdk.ready()`、`requestAccess.appID`、`requestAuthCode` 回退、OAuth token 交换、自动免登、用户身份卡、无按钮 UI 和 `20029 invalid redirect uri` 明确诊断均已部署；公网事件回调加密 challenge 已通过。用户已在飞书后台补齐重定向 URL，并手动确认后台可获取飞书用户信息。
3. B2/B3 主路径已调整为部门领导卡片审批；当前服务器已有 `pending_card_approval` 申请，说明发卡已通。本轮已按飞书官方卡片回调文档修复 `code:200671`：事件入口兼容明文 Verification Token、新版 `card.action.trigger` 和旧版 `card.action.trigger_v1`，toast 响应体收口为官方格式；LA 镜像 `voidintheshell/tokeninside:card-callback-200671-fix-20260703` 已部署，新旧卡片回调模拟均返回 HTTP 200。下一步仍必须由审批目标领导点击真实卡片，完成通过/拒绝和幂等状态机确认；管理端人工审批已作为兜底链路验证通过，但不能替代真实飞书卡片点击证据。
4. B5 数据面基础透传已通过管理端兜底发放的 key 完成公网验证：`GET /v1/models` 返回 200 且模型数量为 4，`POST /v1/chat/completions`、`POST /v1/responses`、`POST /v1/messages` 均返回 200；后续仍需在真实卡片审批通过后复测同一数据面链路。
5. E 阶段已从信息架构文档推进到可用代码和远端部署：申请界面、用户后台、模型列表、管理员入口可见性、数据面 allowlist、默认额度配置、审批单额度覆盖、环境管理员授权、管理端审批通过/拒绝、可见用户摘要、代理日志摘要、NewAPI 控制凭据非空选择、NewAPI 配额单位换算、已开通申请自愈归一化、代理 token usage 记录、历史 usage 总量回填、管理概览用量聚合、用户侧 key reset API/UI、用户侧额度重置申请 API/UI、部门主管自动同步、管理端主动调额、JSON store 基础账期同步汇总和默认关闭的月度账期重置执行入口均已完成代码落地；后续仍需在生产维护窗口开启并实测真实月度重置。生产 key reset 会禁用当前 active key，生产 quota reset 会发起真实审批并可能在通过后修改额度，生产管理端调额和月度重置会直接修改 active token quota，本轮只验证鉴权边界和 dry-run/关闭态，未擅自触发真实业务动作。

## 当前外部阻塞

1. 真实 B3 卡片审批仍等待审批目标领导在飞书内点击交互卡片；当前事件入口已完成 `code:200671` 兼容修复并通过新旧卡片回调模拟，但还没有真实管理员点击后的成功 payload 证据。飞书后台建议只保留新版 `card.action.trigger`，移除旧版/重复卡片回调订阅，避免同一次点击产生多路请求干扰排障。TokenInside 事件入口、发卡后待审批状态、管理端人工兜底发放、公网数据面四条 MVP 路径和基础用量统计已经验证通过。

继续 B 阶段外部实测前必须准备服务器私有环境变量，且不得将真实密钥写入仓库。
