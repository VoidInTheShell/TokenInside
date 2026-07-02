# TokenInside 实现方案完善计划

## 目标

将飞书官方文档确认的网页应用免登、用户信息字段权限、审批实例创建、审批事件订阅、`offline_access`、敏感通讯录字段权限等结论，补充进 TokenInside 实现方案，形成可落地的权限边界和实现链路。

## 阶段

| 阶段 | 状态 | 内容 |
|---|---|---|
| 1 | complete | 读取现有实现方案与原始需求文档 |
| 2 | complete | 梳理飞书官方文档权限结论 |
| 3 | complete | 编辑实现方案，补充飞书应用配置、权限矩阵、免登/OAuth 链路 |
| 4 | complete | 复查文档一致性并输出总结 |
| 5 | complete | 根据用户澄清完善审批方案：TokenInside 自动以当前飞书用户为发起人创建审批实例，部门主管在飞书审批 |
| 6 | complete | 补充前端实现约束：TokenInside 控制面已确认采用 shadcn/ui 风格和组件体系 |

## 待补充重点

1. 明确 MVP 最小权限不申请通讯录宽权限、消息、云文档等无关 OpenAPI 权限。
2. 明确网页应用入口、H5 可信域名、OAuth redirect URL、可用范围是应用配置要求。
3. 明确 `requestAccess({ scopeList: [] })` 用于端内网页应用免登和基础用户信息授权。
4. 明确默认主身份采用 `tenant_key + open_id`，邮箱和手机号不得作为唯一登录凭证。
5. 明确 `offline_access`、邮箱、手机号、user_id、工号、通讯录权限均为按需扩展。
6. 将飞书权限边界影响到数据库字段、管理员身份、MVP 范围和安全边界。
7. 明确审批链路不是系统代主管审批，而是 TokenInside 使用 `tenant_access_token` 创建审批实例，并指定当前飞书用户为审批发起人。
8. 明确审批结果回写需要应用后台订阅 `approval_instance` 事件，并调用审批事件订阅接口绑定 `approval_code`。
9. 明确飞书普通入口、移动端主页和管理员后台入口均使用 `ti.kumiko-love.com` 同一业务域名，TokenInside 通过 `/` 与 `/admin` 做路由分流，管理权限由服务端计算。

## 风险

1. 当前仓库基本只有文档，前端已确认采用 shadcn/ui；后续实现前仍需确认后端技术栈和 NewAPI 接口实测结果。
2. 飞书审批实例创建已纳入 MVP，最小权限为 `approval:instance`；审批结果自动回写还需要审批事件订阅相关权限和配置。
3. 不默认申请 `approval:task`，避免把方案误实现为系统代部门主管同意或拒绝审批。

## 落地执行计划

| 阶段 | 状态 | 内容 |
|---|---|---|
| A1 | complete | 初始化 Next.js 16 + React 19 + shadcn 风格控制面工程骨架 |
| A2 | complete | 实现服务端配置、签名 session、JSON MVP store、飞书和 NewAPI 客户端封装 |
| A3 | complete | 实现飞书 OAuth 回调、当前会话、Token 申请、key 查看、审批事件回写 API |
| A4 | complete | 实现根路径 `/v1/[...path]` NewAPI 透传代理、key hash 绑定校验和代理审计 |
| A5 | complete | 完成依赖安装、类型检查、生产构建、依赖审计和本地页面/API 冒烟验证 |
| B | in_progress | 服务器优先真实链路：先产出 Docker 镜像并部署 USLA，再在 `ti.kumiko-love.com` 完成飞书 OAuth、审批事件、NewAPI token 管理和 `/v1` 代理实测 |
| C | planned | 将 JSON MVP store 迁移到 PostgreSQL，并补齐唯一 active key、事件幂等和事务状态机 |
| D | pulled_forward | 部署运维工作前置并合入 B0；测试阶段先用 Docker + USLA 公网域名解决飞书回调验证闭环 |
| E | partially_pulled_forward | 已前置补齐 `/admin` 管理入口壳、管理范围数据结构和只读概览 API；用户后台、部门主管同步、用量统计、调额、额度重置和 key 重置仍待后续阶段 |

## 当前落地状态

1. 本地服务已启动在 `http://127.0.0.1:16878`。
2. 首版使用 `.local-data/tokeninside.json` 作为 MVP 状态存储；后续生产化应替换为 PostgreSQL。
3. `.env.example` 只保留占位符，没有写入真实 NewAPI System AK、飞书密钥或其他私密凭据。
4. 依赖审计通过 `postcss` override 修复为 0 vulnerabilities。
5. 外部飞书审批定义、飞书事件订阅、NewAPI token 创建接口改为在 USLA 公网测试环境实测，避免飞书事件订阅 URL 必须公网验证导致本地死循环。
6. B 阶段已补齐真实链路承接代码：飞书事件加密解包、verification token 校验、事件幂等、NewAPI token 创建后搜索取 key、禁用和额度更新封装。
7. 当前仓库未发现 `.env.local`；后续真实密钥优先写入服务器环境变量或服务器私有 `.env.production`，本地只做构建和脚本 readiness。
8. B 阶段本地验证已通过：`npm run typecheck`、`npm run build`、`npm run b:check` readiness、无密钥 API 冒烟和密钥落盘检查。
9. B 阶段策略已调整为服务器优先：最终阶段产物是 Docker 镜像，所有飞书事件、审批回调和 NewAPI 控制面实测直接在 `https://ti.kumiko-love.com` 上调试。
10. B0 本地 Docker 基线已完成：已新增 Dockerfile、`.dockerignore`、`.env.production.example`、compose 示例和 `/api/health`；`tokeninside:latest` 镜像构建成功，本地生产容器冒烟通过。
11. `.env` 已可被本地检查脚本加载；B1 基础飞书凭据检查通过，B4 NewAPI token 控制面只读和变更探测通过。
12. B2/B3 仍等待飞书审批配置变量：`FEISHU_APPROVAL_CODE_TOKEN_REQUEST` 与 `FEISHU_APPROVAL_EVENT_VERIFICATION_TOKEN`。
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
23. 飞书入口策略已补入计划：普通入口和移动端主页使用 `https://ti.kumiko-love.com`，飞书“管理员后台”使用 `https://ti.kumiko-love.com/admin`，但管理员权限仍由 TokenInside 服务端基于部门主管关系和 `admin_scopes` 判断。
24. E0 管理入口已前置落地：新增 `/admin` 页面、`/api/admin/overview`、JSON store `adminScopes` 结构、管理范围过滤和首页到管理后台的导航；直接访问管理 API 保持 401/403，页面 soft 请求避免未登录状态产生浏览器 console error。
25. E0 管理入口已部署到 USLA：新镜像 `voidintheshell/tokeninside:e0-admin-20260702-1710` 与 `latest` 已推送，digest `sha256:23e6d5e9ba9fea04d77e18a2a0cb49a5659ab858c151ac496728f37cb86f56f1`；远端 compose 已 pull-only 重建，容器 healthy，公网 `/admin` 返回 200。

## 计划文档索引

| 文档 | 用途 |
|---|---|
| `.agent-docs/TokenInside-实施总路线图.md` | A 到 E 阶段总路线、风险排序和下一步入口 |
| `.agent-docs/TokenInside-B阶段真实链路实测计划.md` | 飞书 OAuth、审批、事件、NewAPI token 管理、`/v1` 代理真实链路实测 |
| `.agent-docs/TokenInside-C阶段数据库生产化计划.md` | PostgreSQL schema、约束、迁移、事务和 JSON 数据导入 |
| `.agent-docs/TokenInside-D阶段部署运维计划.md` | Docker、USLA 部署、反代、健康检查、日志和防绕过网络策略 |
| `.agent-docs/TokenInside-E阶段管理后台与用量统计计划.md` | 用户后台、管理员后台、飞书入口分流、部门权限、用量同步、调额和重置 |
| `.agent-docs/TokenInside-真实链路实测记录.md` | B 阶段本地落地结果、待实测项和外部阻塞项 |

## 下一阶段入口

B 阶段优先执行顺序已调整为服务器优先：

1. B0 代码、镜像、Hub 推送、USLA pull-only 部署和 BunkerWeb 错误体透传配置已完成；当前运行镜像为 `voidintheshell/tokeninside:e0-admin-20260702-1710`，上一稳定镜像为 `voidintheshell/tokeninside:b0-20260702-1526`。
2. B1 在飞书后台把网页入口、移动端主页、管理员后台入口、H5 可信域名、OAuth 和事件订阅 URL 都切到 `ti.kumiko-love.com`；其中管理员后台入口指向 `https://ti.kumiko-love.com/admin`，从飞书客户端工作台完成端内免登。
3. B2/B3 已不再缺配置变量；下一步需要真实飞书用户登录后提交 Token 申请，并由审批人完成一次通过/拒绝来确认审批实例字段、事件 payload 和状态枚举。
4. B5 使用审批通过后发放的 key 访问 `https://ti.kumiko-love.com/v1` 完成数据面透传验证。
5. E0 `/admin` 已部署到公网；后续 E 阶段应继续补 `admin_scopes` 写入/同步、部门主管范围展开、用量统计、调额和 key/额度重置，不能把当前入口壳当成完整管理后台。

继续 B 阶段外部实测前必须准备服务器私有环境变量，且不得将真实密钥写入仓库。
