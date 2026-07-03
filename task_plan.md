# TokenInside 实现方案完善计划

## 目标

将飞书官方文档确认的网页应用免登、用户信息字段权限、飞书卡片请求回调、指定用户消息发送、通讯录部门负责人字段、`offline_access`、敏感通讯录字段权限等结论，补充进 TokenInside 实现方案，形成可落地的权限边界和实现链路。

## 当前优先级（2026-07-03 调整）

当前 P0 目标仍然要求真实飞书卡片审批流程闭环，并把飞书侧审批动作与 TokenInside App 内申请状态、NewAPI 发放状态保持同步。用户最新提出的系统管理员兜底、管理员治理、用户后台额度展示和 UI 收口问题，已经调整为审批闭环后的立即优先修复包；其中“部门主管无法识别时发送给系统管理员”直接影响审批路由，优先级等同 P0 兜底链路。

| 优先级 | 状态 | 内容 |
|---|---|---|
| P0 | in_progress | 真实审批闭环：申请人提交申请 -> 服务端解析部门领导 -> 飞书卡片发送给审批目标 -> 审批目标在飞书内通过/拒绝 -> `/api/feishu/events` 写入事件审计 -> App 申请单同步为 `provisioned` / `rejected` / `approved_provision_failed` -> 通过/失败结果在 App 管理端可追踪 |
| P0 | in_progress | 飞书与 App 状态一致性：飞书卡片点击必须返回 HTTP 200 toast；通过后若 NewAPI 发放成功，App 必须变为 `provisioned` 并生成 active key；若发放失败，App 必须保留 `approved_provision_failed` 和错误原因，不能让飞书端只看到 `200671`；拒绝后 App 必须变为 `rejected` 且不得发放 key |
| P0 | complete_local | 系统管理员兜底审批：全局管理角色统一命名为“系统管理员”；初始化环境变量已支持 `TOKENINSIDE_SYSTEM_ADMIN_OPEN_IDS` 手动配置并兼容旧 `TOKENINSIDE_ADMIN_OPEN_IDS`；当用户不属于任何组织、部门负责人缺失、负责人等于申请人或通讯录无法安全解析主管时，不再静默不发送请求，而是把申请发送给系统管理员，并在用户界面提示“您当前不属于任何组织，请求将发送给系统管理员，请联系系统管理员审批” |
| P1 | pending | 用真实卡片审批发放出来的 key 复测 `/v1/models`、`/v1/chat/completions`、`/v1/responses`、`/v1/messages`，确认数据面不再只依赖管理端人工兜底发放证据 |
| P1 | in_progress | 管理员治理与用户后台收口：系统管理员可查看全部管理员、指派管理员；用户后台补当前账期剩余额度，调整 active key 提示、刷新按钮、自动识别动画、管理入口、最新审批请求显示位置、品牌副标题和模型列表说明文案；E8-8 前端细节修复包已本地落地并部署到 LA，公开 `/admin` 与 `/api/health` 已返回 200 |
| P2 | pending | 审批闭环完成后再继续管理员取消用户权限、部门归属历史快照、真实月度重置和更完整报表；这些任务保留在 E 阶段，但暂不抢占 P0 |

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
| B | in_progress | P0：服务器优先真实链路当前聚焦审批闭环与状态同步；`ti.kumiko-love.com` 当前调试入口仍以可访问公网链路为准，必须完成真实飞书卡片点击、事件审计、App 状态回写、NewAPI 发放/失败补偿和 `/v1` 复测后才能把 B3/B5 视为闭环 |
| C | in_progress | PostgreSQL foundation 已落地并在生产机切换启用：新增 schema 迁移脚本、JSON 导入脚本、可选 Postgres store、健康检查和 2C2G 默认容器/连接池参数；后续仍需补齐行级事务状态机和备份/恢复运维 |
| D | pulled_forward | 部署运维工作前置并合入 B0；当前生产机使用统一 compose 管理 PG/app、Nginx Proxy Manager 内网反代 `tokeninside:16878`，后续发布路径为本地构建、推送 Docker Hub、生产机通过 `production-docker-pull-with-mihomo.sh` 临时启用 mihomo 拉镜像后立即停用，再 compose up；save/load 仅作回退 |
| E | in_progress | P1/P2：已按最新口径前置补齐申请界面/用户后台分流、用户后台模型列表、管理员入口权限展示、`/admin` 入口壳、管理范围数据结构和只读概览 API；已继续补齐默认额度配置、审批单额度覆盖、管理端审批、基础用量统计、用户后台 key 头尾省略展示与点击查看复制、key 重置、用户侧额度重置申请、部门主管自动同步、管理端主动调额、基础账期同步汇总和默认关闭的月度账期重置执行入口；已补入管理员取消用户权限/禁用 active key 的计划任务、被取消资格触发条件和跨部门调动额度继承规则。E8 近期优先修复包已本地落地并部署到 LA：系统管理员兜底审批、系统管理员配置/命名/指派能力、用户后台剩余额度、UI 文案布局收口、`.env` 中文变量说明，以及 token/额度按 K/M/B/T 紧凑单位展示；E8-8 前端细节修复包已本地落地并部署到 LA，覆盖对齐、管理范围卡片和指标卡片口径 |

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
56. 用户后台 key 展示细节已落地并部署到 LA：隐藏态由服务端实时读取 NewAPI key 后返回 `maskedKey`，前端展示 key 头尾省略形式，不再展示数字 token id；点击“查看”会展示完整 key 并尝试自动复制到剪切板。当前 LA 运行镜像为 `voidintheshell/tokeninside:key-mask-copy-20260703`，digest `sha256:17da0640f6adfe1ab32f9e137b999536415f0e511728058692df2cb1fb5dba56`，远端和公网 `/api/health` 均返回 200。
57. LA 调试入口和生产机均已收敛到 PostgreSQL backend：LA 已新增 `tokeninside-postgres`，从原 JSON store 备份导入 PG 并通过 `db:verify-import` 计数校验；生产机继续使用 `tokeninside-postgres`，并已修正 compose 对 `POSTGRES_PASSWORD` 插值的依赖。两边 app 镜像均同步为 `voidintheshell/tokeninside:key-mask-copy-20260703`，两边 `/api/health` 均显示 `store.type=postgres`、`schema.ready=true`、`tableCount=8`、`postgresPool.max=10`。
58. P0 审批同步代码收口已本地落地：飞书卡片通过/拒绝分支会把审批操作人 `approvalOperatorOpenId` 和操作时间 `approvalOperatedAt` 写回申请单；重复卡片回调返回飞书卡片 toast 而不是普通 `{ ok: true }` JSON，避免重复事件触发响应体格式风险。本地 `npm run typecheck`、`npm run build` 和 Next MCP `get_errors` 已通过；仍需真实审批目标领导点击卡片完成外部验收。
59. P0 审批同步修复已部署到当前公网调试入口：镜像 `voidintheshell/tokeninside:p0-approval-sync-20260703` 与 `latest` 均推送到 Docker Hub，digest 为 `sha256:36a5f6e200df0778c5c0950795398eadd8d465191528c9b2fda1f63024d11afe`；LA `docker-compose.yml` 已备份为 `docker-compose.yml.before-p0-approval-sync-20260703` 并切换到新 tag，容器 healthy，远端本机和公网 `/api/health` 均返回 `status: ok`。公网模拟同一 `card.action.trigger` 事件两次均返回 HTTP 200，第一次为参数不完整 error toast，第二次为重复事件 success toast。
60. P0 审批回调入口层观测修复已部署到当前公网调试入口：镜像 `voidintheshell/tokeninside:p0-feishu-invalid-payload-20260703` 与 `latest` 均推送到 Docker Hub，digest 为 `sha256:7044e3e27e2424405024d32a667faf4965725f114539c2d1203d4ce130d88a17`；LA `docker-compose.yml` 已备份为 `docker-compose.yml.before-p0-feishu-invalid-payload-20260703` 并切换到新 tag，容器 healthy，远端本机和公网 `/api/health` 均返回 200。
61. 当前入口已把 raw JSON / 解密 payload 解析失败从 HTTP 400 改为 HTTP 200 toast + `invalid_payload` 审计记录；公网 `text/plain` 模拟已写入 PG `feishu_events`，BunkerWeb 同一请求状态码为 200。下一次袁旗真实点击如果仍失败，应优先查最新 `invalid_payload` 或 `card.action.trigger` 记录，而不是只依赖飞书客户端错误码。
62. P0 飞书真实加密体解密修复已部署到当前公网调试入口：镜像 `voidintheshell/tokeninside:p0-feishu-decrypt-20260703` 与 `latest` 均推送到 Docker Hub，digest 为 `sha256:1beadd69edc3fc6060faacf900cf52cdafddef9fb97faaaad0ecd3ed57d23059`；LA `docker-compose.yml` 已备份为 `docker-compose.yml.before-p0-feishu-decrypt-20260703` 并切换到新 tag，容器 healthy，远端本机和公网 `/api/health` 均返回 200。
63. 最新根因已收敛：飞书真实请求为 `{ encrypt }` 加密体，项目旧 AES 解密实现使用错误 IV；已按飞书官方 Node SDK 改为使用密文 base64 解码后的前 16 字节作为 IV。部署后公网官方 IV 规则加密 challenge 返回正确 challenge，加密 `card.action.trigger` 缺字段返回卡片 toast 并写入 `card.action.trigger` 事件，不再写 `invalid_payload`。
64. 用户最新真实点击返回飞书端 `200341`，但远端 PG 显示本次审批业务已成功闭环：事件 `card.action.trigger` 为 `processed`，申请 `tr_8efb4f5f2001b5fc5a49138a` 已 `provisioned` 并绑定 `ta_f8ac4cce23bbcd445baf4b61`；BunkerWeb 对真实请求记录 HTTP `499`，说明问题是响应超时而不是审批/发放失败。
65. P0 快速 ACK 修复已部署：`/api/feishu/events` 的卡片 approve 分支现在先写 App 审批状态和飞书事件审计，再返回 HTTP 200 toast；NewAPI 发放通过 Next 16 `after()` 在响应后继续执行，失败时保留 `approved_provision_failed` 和派生 `eventUuid:provision` 记录。当前运行镜像为 `voidintheshell/tokeninside:p0-feishu-fast-card-20260703`，digest `sha256:f50343d940c64f063c9b7bf1f0c8dd93ba0ccb517dfdf639e5bb939760a30799`。
66. 部署验收通过：RemoteUSDMITLA `tokeninside-tokeninside-1` healthy，远端本机和公网 `/api/health` 均返回 200，公网官方 IV 加密 challenge 返回 `{\"challenge\":\"ti-fast-card-check-20260703\"}`。下一步需用新的真实点击验证飞书端不再出现 `200341`，并继续核对后台发放最终状态。
67. 2026-07-03 新增前端细节修复计划：PC 用户卡片右侧“管理后台”入口需要与右侧三个组件垂直居中对齐；移动端管理后台页同类组件与刷新按钮需要落在右下方，并与左侧“管理范围”下方文字视觉对齐；管理范围不再单独做独立卡片；顶部数据展示由长条形改为紧凑正方形；“当前账期额度”改为“当前账期发放额度”，新增“当前账期剩余额度”；“管理用户”改为“总用户数”，统计当前已获得 key 的用户数量。
68. E8-8 前端细节修复已本地落地：`/api/admin/overview` totals 新增 `keyedUsers` 与 `currentPeriodRemainingQuota`；管理后台状态总览改为正方形紧凑指标块；“管理用户”改为“总用户数”；“当前账期额度”改为“当前账期发放额度”并新增“当前账期剩余额度”；独立“管理范围”卡片移除，管理范围保留在用户卡片内；PC 用户卡片右侧控件改为居中对齐，移动端右侧状态/刷新按钮移到右下方并与管理范围文字同列。
69. E8-8 已按本地构建、Docker Hub 推送、RemoteUSDMITLA pull-only 路径部署到 LA：远端容器使用 `voidintheshell/tokeninside:e8-8-admin-layout-20260703` 并进入 healthy；本机公开域名验证 `/admin` 与 `/api/health` 均返回 200，公开 `/admin` HTML 已包含“总用户数”“当前账期发放额度”“当前账期剩余额度”。

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

当前优先级改为审批闭环优先：

1. P0-1：已完成一条真实 approve 业务闭环证据：`tr_8efb4f5f2001b5fc5a49138a` 由袁旗点击后写入 `card.action.trigger processed`，申请最终为 `provisioned`，绑定 `ta_f8ac4cce23bbcd445baf4b61`。本次飞书端仍显示 `200341` 的原因是响应超时，已通过快速 ACK 修复。
2. P0-2：当前仍可复用旧真实 `pending_card_approval` 申请 `tr_e51e61df74ed36cccdf11b06`，申请人为高成，审批目标已通过飞书通讯录 API 和部门接口确认是袁旗；也可以重新由高成发起一条新申请。下一次袁旗点击时，预期飞书端应快速收到 HTTP 200 toast，不再出现 `200341`。
3. P0-3：继续核对 App 状态与飞书动作同步：通过后申请单必须先进入 `approved`，随后后台发放最终进入 `provisioned` 并绑定 active key；若 NewAPI 发放失败，则申请单必须为 `approved_provision_failed`，派生事件记录发放错误，飞书端仍收到 HTTP 200 toast；拒绝后申请单必须为 `rejected` 且不得发放 key。
4. P0-4：执行反向和幂等检查：非审批目标点击不能改变申请状态；重复点击或飞书重试不能重复发放 NewAPI key；旧版/重复订阅若产生多路回调，必须以本地幂等状态为准。
5. P1：用真实卡片审批通过后发放的 key 复测 `GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses`、`POST /v1/messages`，并确认代理日志、账期 usage 和管理概览均归属到同一飞书用户。
6. E8-1：系统管理员兜底审批已本地落地。`TOKENINSIDE_SYSTEM_ADMIN_OPEN_IDS` 作为新的初始化配置，兼容旧 `TOKENINSIDE_ADMIN_OPEN_IDS`；服务端审批目标解析失败时会发送给系统管理员，不再让申请停在不发送状态。
7. E8-2：系统管理员治理页/API 已本地落地。系统管理员可查看全部管理员范围记录，并可指派系统管理员或部门管理员；普通部门主管不能越权指派系统管理员。
8. E8-3：用户后台 UI 收口已本地落地：管理后台入口只保留在用户卡片处；最新审批请求只在管理员用户后台首屏、用户卡片下方展示，切换到账户/额度/模型/申请记录子菜单后不常驻；底部小字移除；左上副标题改为“共绩科技”；模型列表说明改为“当前可用的模型ID”。
9. E8-4：额度展示已本地落地：用户后台当前账期卡片既显示账期额度，也显示当前账期剩余额度；剩余额度优先读取 NewAPI 当前 active token 的 `remain_quota` 并按 `NEWAPI_QUOTA_PER_UNIT` 换算，避免直接用 token usage 相减。
10. E8-5：用户卡片交互细节已本地落地：已有 key 用户的“当前用户已有 active key”提示移动到用户卡片刷新按钮旁绿色小勾左侧；刷新按钮固定在用户卡片右下方；“自动识别中”文字改为不越界的旋转动画状态，组件尺寸保持稳定。
11. E8-6：`.env.example` 与 `.env.production.example` 已改为中文变量说明，补清变量用途和获取位置，尤其是飞书、NewAPI、PostgreSQL、系统管理员 open_id 和账期相关变量。
12. E8-7：token/额度读数紧凑展示已本地落地，参考 Aether 的十进制 K/M/B/T 格式化口径；用户后台和管理后台的只读 token、账期额度、剩余额度、审批额度和使用记录 tokens 已统一按量展示，输入框仍保留原始数字。
13. E8-8：前端布局与指标信息密度微调已落地并部署到 LA：PC 用户卡片右侧管理后台入口与右侧组件居中对齐；移动端管理后台页状态/刷新按钮放到右下方并与管理范围文字同列；独立管理范围卡片已移除；顶部数据改为正方形紧凑指标块；“当前账期额度”已改名“当前账期发放额度”；已补“当前账期剩余额度”；“管理用户”已改为“总用户数”，统计当前获得 key 的用户数。
14. P2：审批闭环、数据面复测、E8 近期优先修复包部署验收完成后，再继续管理员取消用户权限/禁用 active key、部门归属历史快照、真实月度账期重置和部门报表。

## 当前外部阻塞

1. 真实 approve 业务链路已经跑通过一次，但飞书端当时仍显示 `200341`；当前阻塞已变成“用快速 ACK 新版本复测飞书客户端体验”。下一次袁旗点击后应同时确认飞书端 toast、BunkerWeb HTTP 状态、`feishu_events`、`token_requests` 和 NewAPI 发放结果。
2. 当前必须把“飞书审批动作”和“App 申请状态”作为同一个验收项：飞书点击通过、TokenInside 事件审计、申请单状态、NewAPI 发放结果、用户 active key 和 `/v1` 可用性必须能串成同一条链路。管理端人工审批只保留为兜底，不能替代真实飞书卡片审批同步证据。
3. 飞书后台建议只保留新版 `card.action.trigger`，移除旧版/重复卡片回调订阅并发布应用版本，避免同一次点击产生多路请求干扰排障。用户已确认后台目前只保留 `card.action.trigger`，当前代码也已兼容真实新版加密回调。

继续 B 阶段外部实测前必须准备服务器私有环境变量，且不得将真实密钥写入仓库。
