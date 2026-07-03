# TokenInside 飞书权限研究发现

## 飞书官方文档结论

1. 网页应用开发的必要配置是创建并发布自建应用；如果要获取客户端已登录用户身份，需要配置应用免登流程。
2. `tt.requestAccess` 支持网页应用，`scopeList: []` 表示仅授予应用获取登录用户信息权限。
3. 获取授权码接口、获取 `user_access_token` v3 接口、获取用户信息接口本身均不要求额外 API 权限。
4. `offline_access` 只在需要 `refresh_token` 并长期刷新 `user_access_token` 时申请。
5. `authen/v1/user_info` 默认可用于获取基础身份信息；邮箱、手机号、user_id、工号、企业邮箱等字段存在单独字段权限要求。
6. 飞书官方提醒手机号和邮箱为管理员导入联系方式，未经过用户本人实时验证，不建议直接作为业务系统登录凭证。
7. 除 `requestAuthCode`、`closeWindow`、`requestAccess` 外，其它 H5 JSAPI 一般需要先完成 JSSDK 鉴权。
8. 创建审批实例接口 `/approval/v4/instances` 使用 `tenant_access_token`，所需权限开启 `approval:instance` 或更宽的 `approval:approval` 任一即可；该方案已降级为备用路径，不作为 MVP 主路径。
9. 创建审批定义接口不推荐企业自建应用通过 API 调用；如未来回退到飞书原生审批，审批定义应优先由企业管理员在飞书审批后台创建，再把 `approval_code` 配置给 TokenInside。
10. 飞书卡片支持请求回调，用户点击卡片按钮后会向应用配置的回调地址发送 `card.action.trigger` 事件；TokenInside 可在该回调内完成审批状态转换。
11. 卡片请求回调应在 3 秒内返回 HTTP 200；NewAPI key 发放应做成快速状态变更后的异步/补偿流程，避免飞书回调超时。
12. 卡片请求回调的操作者字段可拿到 `operator.open_id` 等身份；TokenInside 必须校验该操作者与本地申请单保存的审批目标一致。
13. 向指定用户发送交互卡片应使用飞书应用机器人发送消息能力，`receive_id_type=open_id`、`msg_type=interactive`，而不是自定义群机器人 webhook。
14. 获取单个用户信息接口可通过 `GET /open-apis/contact/v3/users/:user_id` 读取用户部门字段；应用身份读取时受通讯录数据权限范围和字段权限约束。
15. 用户资源字段中 `department_ids` 表示所属部门列表，`leader_user_id` 表示直属主管；当前“发给用户所在部门领导”的口径应优先用部门资源的负责人字段，而不是直接把用户直属主管等同于部门领导。
16. 部门资源字段中 `leader_user_id` 表示部门负责人，`parent_department_id` 可用于负责人缺失或负责人等于申请人时向上级部门兜底。
17. TokenInside 不应默认申请 `approval:task`，除非未来明确要由系统代审批人执行同意、拒绝、退回或加签。
18. 获取子部门列表接口可用 `tenant_access_token`，如需读取部门名称、父子关系、负责人等字段，颗粒度权限应包含部门基础信息和部门组织架构信息。
19. 获取部门直属用户列表接口可用 `tenant_access_token`，如需读取成员姓名、头像、所属部门等字段，颗粒度权限应包含用户基础信息和用户组织架构信息。
20. 使用应用身份读取根部门 `0` 下的部门或成员时，飞书会校验应用通讯录数据权限范围；如需全量同步，数据权限范围需要覆盖全部成员。
21. 飞书移动端主页建议直接配置为业务自身域名，并在业务页面中通过 `requestAccess` 和登录态管理完成免登，避免把主页直接配置成授权接口导致重复重定向和加载变慢。
22. `requestAccess` 的网页应用场景需要传 `appID`；历史兼容链路中 `requestAuthCode` 使用字段名 `appId`，两者大小写不同，前端封装必须分别处理。
23. 飞书免登示例要求页面引入 H5 JSSDK，取得 `window.h5sdk` 与 `window.tt`，并在 `window.h5sdk.ready()` 后调用登录 JSAPI；普通浏览器或错误入口不会注入这些端内对象。
24. 飞书重定向 URL 文档明确：前端页面调用 `tt.requestAccess` 获取临时登录凭证 code 时，调用该 JSAPI 的页面地址必须加入应用的重定向 URL 列表；建议按 `window.location.href.split("?")[0].split("#")[0]` 取得当前页面地址，动态路由不支持。

## 对 TokenInside 的设计影响

1. 个人 Token 管理能力需要网页应用免登基础能力、通讯录用户/部门只读字段、应用机器人发送交互卡片、卡片请求回调订阅配置；不需要默认申请通讯录宽权限、云文档、多维表格等权限。
2. TokenInside 用户主身份应使用 `tenant_key + open_id`，`union_id` 作为跨应用辅助字段。
3. `email`、`mobile`、`employee_no`、`feishu_user_id` 不应作为 MVP 必填字段；如后续需要展示或组织统计，再追加对应字段权限。
4. 管理员身份优先使用配置化 `tenant_key + open_id` 白名单，不应为了管理员判断而默认申请通讯录权限。
5. TokenInside 发送审批卡片前必须服务端解析审批目标：先按登录用户 `open_id` 获取其 `department_ids`，多部门时要求用户选择本次申请所属部门并由服务端校验归属；不能由前端直接提交审批人。
6. 审批目标优先取所选部门的 `leader_user_id`；若为空、等于申请人或不在应用可用范围内，再沿 `parent_department_id` 向上查找，最终仍失败时进入人工兜底队列。
7. 卡片回调只能由本地保存的 `approval_target_open_id` 操作通过/拒绝；其它用户点击应返回 toast/错误提示并保持申请状态不变。
8. 如果 MVP 包含部门领导卡片审批或部门主管后台，需要追加 `contact:department.base:readonly`、`contact:department.organize:readonly`、`contact:user.base:readonly`、`contact:user.department:readonly`，并配置通讯录数据权限范围。
9. 通讯录宽权限如 `contact:contact:readonly_as_app` 或 `contact:contact:readonly` 不应默认申请，只有颗粒度权限无法满足接口时再评估。
10. TokenInside 控制面前端已确认采用 shadcn/ui 风格和组件体系；后续页面、表单、表格、反馈组件和主题样式应按该约束实现。
11. Next.js 16.2.10 本地文档确认 App Router 的 route handler `params` 为异步 Promise，`cookies()` 也按异步 API 使用；`/v1/[...path]` 代理路由已按该约束实现。
12. `npm audit` 初次报告 Next 依赖链中的 `postcss@8.4.31` 存在 moderate 漏洞；`npm audit fix --force` 会错误降级到 Next 9.3.3，因此采用 npm `overrides` 固定 `postcss@^8.5.10`，复查为 0 vulnerabilities。
13. Next/Turbopack 构建对动态 `process.cwd()` store path 产生 NFT 追踪警告；在 `lib/config.ts` 给 `process.cwd()` 添加 `turbopackIgnore` 注释后，生产构建无警告通过。
14. 本次落地采用 JSON 文件 store 跑通状态机，不作为最终生产数据库方案；生产阶段仍应按实现方案第 14 节迁移到 PostgreSQL 并补唯一 active key 的数据库约束。
15. 后续执行已拆为 B/C/D/E 四个阶段：B 先实测飞书和 NewAPI 真实契约，C 再做 PostgreSQL 生产化，D 做 USLA 部署和反代，E 最后补管理后台和用量统计。
16. B 阶段需要优先确认 NewAPI token 创建、查询完整 key、禁用 token、更新 quota、查询 logs 的真实接口和凭据边界；这些契约会直接影响 `lib/newapi.ts` 和数据库字段设计。
17. 飞书卡片回调 payload、事件签名、可选加密、`operator.open_id` 字段路径、消息 ID 和 action value 字段路径必须通过真实回调确认；当前 `/api/feishu/events` 需要从审批事件骨架扩展为同时处理 `card.action.trigger`。
18. 部署阶段必须新增健康检查和网络层防绕过策略；否则用户可能直连 NewAPI，导致 TokenInside 代理审计和策略控制失效。
19. 管理后台应排在真实链路、数据库和部署之后，避免在 NewAPI logs 字段和部门权限未确认前过早设计复杂统计页面。
20. 本机 `C:\0.01.Project\0.0.00.CompanyProject` 下未发现 NewAPI 源码目录；通过 upstream `QuantumNous/new-api` 源码确认 token 管理路由。
21. NewAPI `/api/token` 创建接口返回成功状态，不返回 token id 或明文 key；创建后需要按唯一 name 搜索 token，再调用 `POST /api/token/:id/key` 获取完整 key。
22. NewAPI `/api/token` 控制面路由使用用户态鉴权，除 `Authorization` 外还需要 `New-Api-User` 请求头；本项目新增 `NEWAPI_CONTROL_USER_ID` 作为服务端环境变量。
23. NewAPI token name 有长度校验，TokenInside 发放时需要使用短名称，避免包含完整飞书用户 id 和申请单 id 导致创建失败。
24. 飞书事件入口已补齐加密事件解包、verification token 校验、challenge 返回、审批字段多路径提取和 `event_id` 幂等处理；真实字段路径仍需飞书后台回调确认。
25. 当前仓库没有 `.env.local`，`npm run b:check` 只能完成环境 readiness 检查，外部 Feishu/NewAPI 网络实测需在填入真实密钥后执行。
26. 飞书事件/卡片回调 Request URL 需要公网服务完成 challenge 验证，本地端到端测试会和飞书后台事件配置形成死循环；B 阶段应改为服务器优先，先产出 Docker 镜像部署到 USLA，再用 `https://ti.kumiko-love.com` 完成飞书 OAuth、卡片回调和 NewAPI 控制面真实调试。
27. Next.js 16.2.10 的 standalone 输出适合 B0 Docker 镜像：`next.config.ts` 设置 `output: "standalone"` 后，Docker 可直接复制 `.next/standalone` 与 `.next/static`，并通过 `HOSTNAME=0.0.0.0`、`PORT=16878` 运行 `server.js`。
28. B0 本地 Docker 基线已验证：镜像 `tokeninside:latest` 可重复构建，容器生产模式可访问首页、`/api/session`、`/api/health`、飞书 challenge 和 `/v1` 代理校验；临时容器日志未出现密钥类信息。
29. `.env.production.example` 已作为可提交占位符放行，真实 `.env.production` 仍被 `.gitignore` 忽略；服务器部署时必须使用私有 `.env.production`，不能直接复用示例占位符。
30. 当前 `.env` 已足够完成 B1 基础飞书凭据探测和 B4 NewAPI 控制面探测；卡片审批主路径仍需要补齐/确认消息发送、卡片回调、通讯录字段和应用可用范围配置，旧飞书审批实例配置不再是主阻塞。
31. 测试 NewAPI 实例要求 `LLMAPI-User` 请求头；为兼容 NewAPI upstream 与该测试实例，控制面请求需要同时发送 `New-Api-User` 和 `LLMAPI-User`，值均来自 `NEWAPI_CONTROL_USER_ID`。
32. NewAPI token 管理真实契约已初步确认：`/api/token` 可创建 token，`/api/token/search` 可按 name 找到 id，`POST /api/token/:id/key` 可取完整 key，`PUT /api/token/?status_only=true` 可禁用 token。
33. B0 部署路径已按用户要求固定为本地 Docker 构建并推送 Docker Hub，服务器只执行 pull-only compose；当前镜像为 `voidintheshell/tokeninside:b0-20260702-1526`，digest `sha256:77faf6da8a61fac4f5033582563af3f8c7305fe31ed4f7ea158a0c324a25d3d7`。
34. 当前 GreenJP/BunkerWeb 到 USLA 的反代拓扑要求容器端口发布到宿主 `0.0.0.0:16878`；仅绑定 `127.0.0.1:16878` 时公网反代会返回 502。
35. `/api/feishu/events` 路由已写入并在公网可用；有效 JSON challenge 经 `https://ti.kumiko-love.com/api/feishu/events` 返回 200 JSON。此前公网 400 来自本地 PowerShell curl 构造了无效 JSON，并非 BunkerWeb 拦截有效飞书 challenge。
36. 已在 BunkerWeb `ti.kumiko-love.com` service 上设置 `REVERSE_PROXY_INTERCEPT_ERRORS=no`；公网 `/v1/models` 的 401/403 和事件入口无效 payload 的 400 均保留 TokenInside 上游 JSON，OpenAI-compatible 错误体兼容性已恢复。
37. 线上 `/api/health` 当前显示 NewAPI 控制面配置已就绪、JSON store 可写；`approvalCode` 与 `approvalEventVerification` 仍为 false，对应缺少 `FEISHU_APPROVAL_CODE_TOKEN_REQUEST` 和 `FEISHU_APPROVAL_EVENT_VERIFICATION_TOKEN`。
38. 本地 `.env` 已补齐飞书审批 code、事件 verification token 和事件 encrypt key；本地 `npm run b:check -- --all` 已验证飞书 tenant token 与 NewAPI token 只读访问。
39. 本地 `.env` 的 `TOKENINSIDE_SESSION_SECRET` 仍是占位符时，不能整文件覆盖远端 `.env.production`；应只合并新增密钥项或在远端单独维护生产 session secret。
40. 飞书审批事件订阅接口为 `POST /open-apis/approval/v4/approvals/:approval_code/subscribe`；首次订阅返回 `code=0 msg=success`，重复订阅可能返回 `subscription existed` 且 HTTP 非 2xx，脚本应按幂等成功处理。
41. 远端启用 `FEISHU_APPROVAL_EVENT_ENCRYPT_KEY` 后，明文无签名 challenge 不再是有效测试方式；应使用带 `x-lark-request-timestamp`、`x-lark-request-nonce`、`x-lark-signature` 的加密事件 payload 测试。
42. 线上 `https://ti.kumiko-love.com/api/feishu/events` 已通过签名加密 challenge 测试，说明 TokenInside 事件入口、AES 解密、verification token 校验和 GreenJP/BunkerWeb POST 链路均可用于飞书事件回调。
43. B2/B3 主路径已改为飞书卡片审批；剩余不可由普通浏览器完成的部分是飞书客户端端内 OAuth、真实用户提交申请、服务端解析申请人部门领导、向该领导发送交互卡片、领导点击通过/拒绝以及 `card.action.trigger` payload 字段确认。
44. 飞书“管理员后台”入口应作为 `https://ti.kumiko-love.com/admin` 的快捷深链，不应作为 TokenInside 管理权限来源。
45. TokenInside 管理员权限必须由服务端基于飞书 OAuth 当前用户、飞书部门主管同步结果和 `admin_scopes` 计算；前端跳转和入口可见性不能替代授权。
46. 普通入口、移动端入口和管理员入口应使用同一业务域名 `ti.kumiko-love.com`；移动端差异通过响应式布局处理，避免新增域名带来的 OAuth、Cookie、H5 可信域名和反代复杂度。
47. 管理员也是普通用户；识别到管理范围后应显示管理入口或恢复上次工作区，不应无条件强制跳转管理员后台。
48. `/admin` 入口已本地落地为最小管理后台壳：未登录可从同页触发飞书免登，已登录后由服务端 `adminScopes` 范围判断是否授权；这不是新的认证方式。
49. `GET /api/admin/overview` 直接访问保留 401/403 语义，前端使用 `?mode=soft` 读取相同状态体并返回 HTTP 200，避免未登录/未授权的正常 UI 状态污染浏览器 console。
50. JSON MVP store 已加入 `adminScopes`，当前支持 `global` 与 `department` 两种范围；申请、token account 和 proxy log 统计都按同一范围过滤，避免部门主管看到全局代理日志数量。
51. 本地 Next 路由已包含 `/admin` 与 `/api/admin/overview`；`npm run typecheck`、`npm run build`、直接 API 401、soft API 200、浏览器 `/admin` 快照和 console 检查均已通过。
52. 不要并行执行 `npm run typecheck` 与 `npm run build`：当前 `tsconfig.json` include 了 `.next/types/**/*.ts`，`next build` 会重写 `.next/types`，并行时 `tsc` 可能遇到临时缺失文件；单独复跑 `typecheck` 可通过。
53. E0 管理入口镜像已发布并部署：`voidintheshell/tokeninside:e0-admin-20260702-1710` / `latest` 指向 digest `sha256:23e6d5e9ba9fea04d77e18a2a0cb49a5659ab858c151ac496728f37cb86f56f1`；远端 `docker-compose.yml.before-e0-admin-20260702-1710` 是替换镜像 tag 前的备份。
54. 公网 `https://ti.kumiko-love.com/admin` 已返回 200 HTML；公网 `/api/admin/overview` 未登录返回 401 JSON，`/api/admin/overview?mode=soft` 返回 200 JSON，`/v1/models` 无 key 仍返回 TokenInside JSON 401。
55. B1 端内免登出现真实阻塞：用户在飞书 H5/客户端内打开 TokenInside 后仍报“没有检测到飞书 H5 JSAPI”。当前优先排查和修复前端是否加载 H5 JSSDK、是否等待 `h5sdk.ready()`、`requestAccess` 是否传 `appID`、旧客户端是否回退 `requestAuthCode`，以及服务端 code 换 token 是否对齐当前 OAuth v3 接口。
56. 该阻塞不是 NewAPI、审批事件或 BunkerWeb 问题；公网 `/`、`/admin`、`/api/health`、`/api/session` 已可访问，问题集中在飞书端内容器 JSAPI 注入/调用链和前端实现。
57. B1 本地修复结论：前端必须主动加载飞书 H5 JSSDK，并等待 `h5sdk.ready()` 后再通过 `tt.requestAccess({ appID, scopeList: [] })` 获取 code；旧客户端或 `requestAccess` 不可用时回退 `tt.requestAuthCode({ appId })`。
58. 普通浏览器中无飞书 bridge，若无条件加载 H5 JSSDK 会触发 `【H5-JS-SDK】: cannot find pc bridge` 控制台错误；当前实现按 Feishu/Lark UA 或已存在端内全局对象判断后再加载 SDK，普通浏览器保持“等待飞书身份”状态且不显示手动登录按钮。
59. 按最新产品要求，TokenInside 不再展示“飞书免登”按钮；首页和 `/admin` 均在端内 SDK ready 后自动尝试一次登录，登录成功后由服务端会话返回头像、姓名、open_id、租户/部门或管理范围并用卡片展示。
60. `/api/auth/feishu/callback` 和 `/api/token/request` 已收紧客户端可控字段：不再接受客户端传入 `departmentId` 写入用户或审批部门，部门来源只能是服务端会话里的飞书用户数据。
61. 最新方案要求审批请求发送到“用户所在部门的领导”：TokenInside 应使用服务端通讯录接口确认申请人的部门归属和部门 `leader_user_id`，把审批卡片点对点发送给该领导，并在回调中校验点击人 `operator.open_id` 与保存的目标一致。
62. B1 自动免登修复已部署到 `ti.kumiko-love.com`，远端容器镜像 digest 为 `sha256:a26b20e2277cdcbe64cc9cd8fa3d5f38c45fccaa107d17cbcb2087c45e977fd4`；普通浏览器公网验证显示 `/` 与 `/admin` 无 console error/warn，`icon.svg` 200，`/api/feishu/app-id` 200，`/v1/models` 无 key 保持 401 JSON。剩余验证必须在飞书客户端端内完成。
63. 飞书端内真实复测进入下一层配置阻塞：`requestAccess` 返回 `20029 invalid redirect uri in h5 case`，说明 H5 JSAPI 已可调用，但当前页面未通过重定向 URL 安全校验。飞书后台安全设置需要至少加入 `https://ti.kumiko-love.com/` 和 `https://ti.kumiko-love.com/admin`；仅配置 `https://ti.kumiko-love.com/api/auth/feishu/callback` 不足以让当前页面调用 `requestAccess`。
64. 最新产品口径要求前端统一 shadcn 主题和白蓝配色；控制面只保留申请界面、用户后台、管理后台三个业务页面。
65. 未申请普通用户默认进入申请界面；申请界面只展示用户身份卡片和申请按钮，不展示统计卡片、模型列表、透传网关子菜单或管理后台入口。
66. 已申请用户和管理员默认进入用户后台；管理员也是普通用户，管理后台入口只在具备管理范围时显示在用户身份卡片旁，不能向所有用户展示。
67. 用户后台必须增加模型列表子菜单，展示当前用户可用模型；信息密度参考 NewAPI 模型列表，但使用 TokenInside 的 shadcn 白蓝主题实现。
68. 数据面 MVP 范围收缩为 NewAPI 的 OpenAI Chat Completions、OpenAI Responses 和 Claude-compatible messages；embeddings、images、audio、Gemini-compatible 等不作为本期透传和验收范围。
69. 现有 E0 `/admin` 入口壳和只读概览仍是已部署状态，但后续实现应先按三页面信息架构调整导航、入口可见性和旧统计卡片首屏，再继续完整管理能力。
70. E1/E2 本地代码落地后，普通未发放 key 用户首页只保留飞书身份卡和申请按钮；已有 active key 用户进入用户后台，用户后台通过本地菜单切换“账户”和“模型列表”；旧侧边栏中的 `/v1 透传网关`、`审计与用量` 和全员可见 `/admin` 入口已从首页移除。
71. `/api/session` 现在返回当前登录用户的 `adminScope` 摘要，前端只在服务端确认管理范围时在用户卡片旁显示“管理后台”入口；入口可见性不改变 `/api/admin/overview` 的 401/403 服务端授权语义。
72. `/api/models` 是登录用户后台的模型列表接口：后端先确认飞书 session 和 active token，再通过 NewAPI token id 读取完整 key 并请求 NewAPI `/v1/models`；响应只返回模型 id/object/ownedBy，不返回明文 key。
73. `/v1/[...path]` 已加入 MVP 数据面 allowlist：`GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses`、`POST /v1/messages`；未纳入路径返回 404 JSON，已知路径方法不匹配返回 405 JSON。
74. 本地并发冒烟暴露 JSON MVP store 写入临时文件名只用 `process.pid` 会导致并发 `rename ENOENT`；已改为 `process.pid + randomId("tmp")`，避免并发代理日志写入抢同一 tmp 文件。
75. B1 飞书端内免登已由用户手动确认通过：飞书后台重定向 URL 配置成功，后台可以获取到飞书用户信息；后续真实链路应转入 B2/B3 的部门领导卡片审批和 `card.action.trigger` 回调实测。
76. B2/B3 代码主路径已从旧 `approval_instance` 切到飞书交互卡片：`/api/token/request` 创建本地申请单后解析申请人部门负责人并发送 `msg_type=interactive` 卡片，`/api/feishu/events` 增加 `card.action.trigger` 分支，按 requestId、nonce 和 `operator.open_id` 做审批人校验。
77. 当前飞书通讯录权限实测未通过：`npm run b:check -- --feishu-contact` 在 `users.find_by_department` 返回 `99991672 Access denied`，提示缺少 `[contact:contact.base:readonly, contact:department.organize:readonly, contact:contact:access_as_app, contact:contact:readonly, contact:contact:readonly_as_app]` 中至少一个应用身份通讯录权限；真实提交申请前必须先在飞书后台开通权限并配置通讯录数据范围。
78. 用户调整飞书权限后，`npm run b:check -- --feishu-contact` 已通过：应用身份可读取通讯录成员列表，样本返回 `department_ids` 和 `leader_user_id`；用户详情同样返回 `department_ids` 和 `leader_user_id`。B2 可以继续进入真实申请发卡测试。
79. B2/B3 镜像 `voidintheshell/tokeninside:b2-card-20260702-2210` 已部署到 USLA，digest `sha256:388c7af2ee4c05ed2a7448d722b4e6cc2ceddf0bca85abcfc25574d79c8accb9`。线上签名加密 challenge 和签名加密 `card.action.trigger` 缺字段模拟均能返回 200，说明事件入口可承接飞书卡片回调。
80. 真实申请测试暴露 `Bot ability is not activated.`，这说明应用机器人能力本身未启用或未发布生效；通讯录权限已通过，但发交互卡片还依赖飞书应用后台 Bot/机器人能力开关。代码侧已将该错误转换为中文可操作提示。
81. 用户卡片部门显示占位符的原因是 OAuth 基础用户信息不返回部门字段，已有 session 的用户也不会自动写回 `departmentId`；已改为登录回调和 `/api/session` 懒加载时通过通讯录 `department_ids` 补写本地用户部门。
82. 申请表单口径已修正：申请理由由用户填写；默认月额度固定显示为 `200` 且禁用，不允许用户修改，提交时按服务端校验的固定值传入。
83. B2/B3 修复镜像 `voidintheshell/tokeninside:b2-card-fix-20260702-2310` 已部署到 USLA，digest `sha256:52ab21f02022e0b0f7ed68e5cbce282a2bcbf5acf1e74629f34a3df5923e4ffa`；远端 compose 已备份为 `docker-compose.yml.before-b2-card-fix-20260702-2310`，服务器仍只执行 Docker Hub pull 和 compose up。
84. 公网验证显示新版首页 HTML 已包含“默认申请额度”禁用输入、申请理由文本框和未登录禁用提交状态；`/api/health` 200，`/v1/models` 无 key 401，`/v1/embeddings` 404，签名加密 challenge 返回 `{"challenge":"ti-b2-card-fix-check-20260702"}`。
85. 代码侧只能把 `Bot ability is not activated.` 转换为清晰中文提示；真正恢复交互卡片发送仍需要飞书开放平台应用后台启用 Bot/机器人能力，并确认应用发布或配置生效。
86. 新增额度管理需求：默认申请额度不能继续只写死在申请表单中，管理后台应提供配置项，初始化值为 `200`；申请单创建时保存默认额度快照，审批每条申请时可手动确认或覆盖最终额度，审批通过后以最终额度创建 NewAPI token 并进入用户账期额度。
87. 飞书用户卡片不需要展示租户信息；部门字段可通过已获取的 `departmentId` 再读取飞书部门详情并展示 `name`，前端不应把 `od-...` 一类原始部门 ID 作为正常用户可读展示。
88. B2 用户卡片展示收尾镜像 `voidintheshell/tokeninside:b2-user-card-dept-20260702` 已部署到 USLA，digest `sha256:a2593de49c3564e23fdc36dd19703e59329ae42c370b1b0831f322ea2332d98e`；远端 compose 已备份为 `docker-compose.yml.before-b2-user-card-dept-20260702`，服务器仍只执行 Docker Hub pull 和 compose up。
89. 默认申请额度应以服务端设置为权威来源，不能由普通前端请求提交；审批覆盖额度应作为申请单独立字段保存，并在 NewAPI token 发放时覆盖申请快照额度。
90. E 阶段额度配置镜像 `voidintheshell/tokeninside:e-quota-config-20260702` 已部署到 USLA，digest `sha256:fd3ddce9088e7cd8ff5edc09b70900183981981bd473e1b219ca8e86b25a3557`；远端 compose 已备份为 `docker-compose.yml.before-e-quota-config-20260702`，服务器仍只执行 Docker Hub pull 和 compose up。
91. 续跑时远端实际镜像已是 `voidintheshell/tokeninside:hide-department-20260703`，容器 healthy，store 中已有 `pending_card_approval` 申请；这证明飞书机器人发卡已通过，B3 剩余关键证据是审批目标领导真实点击卡片后的 `card.action.trigger` 回调、NewAPI key 发放和 `/v1` 成功代理。
92. 远端生产 session secret 曾为示例占位值，已在服务器私有 `.env.production` 生成随机值并重建容器；后续部署检查必须把 `TOKENINSIDE_SESSION_SECRET` 是否为占位符纳入验收，而不仅检查 `/api/health` 的布尔值。
93. `TOKENINSIDE_ADMIN_OPEN_IDS` 是飞书 OAuth 后的服务端授权白名单，只决定当前飞书用户是否有 TokenInside 全局管理范围，不新增用户名密码、magic link 或其它认证方式；管理 API 仍必须先通过飞书 session。
94. E 阶段管理端审批决策接口允许授权管理员在当前管理范围内通过/拒绝申请；通过时以 `approvedMonthlyQuota ?? requestedMonthlyQuota` 触发 NewAPI token 发放。该路径可作为卡片审批不可操作时的人工兜底，但不能替代 B 阶段真实 `card.action.trigger` payload 验证。
95. NewAPI 控制面凭据不能用 nullish coalescing 直接选择：空字符串环境变量会遮蔽后续有效 `NEWAPI_SYSTEM_AK`。当前实现必须选择第一个非空字符串，否则 `/api/health` 的 `newapiControl: true` 也可能掩盖实际发放失败。
96. 管理端人工审批兜底已在远端真实发放过一条 active token，且公网 `GET /v1/models` 使用该 key 返回 200、模型数量为 4；数据面代理、key hash 绑定和代理日志写入链路已经有线上证据。
97. 已开通申请应回填 `tokenAccountId` 并清理旧 `errorMessage`，否则管理后台会显示“已开通但仍带错误”的混合状态；当前代码在发放成功路径和 store 读取自愈中都处理了该一致性问题。
98. 当前运行镜像为 `voidintheshell/tokeninside:e-admin-decision-normalize-20260703`，digest `sha256:f59936168a60efcd5afdc8fcb82a31a48ee620a6af72a177d14106d54d71d700`；远端容器 healthy，事件 challenge、管理概览授权、token key 获取和公网 `/v1/models` 均已复测通过。
99. B 阶段尚不能标记真实卡片审批完成：缺少审批目标领导真实点击产生的 `card.action.trigger` 成功回调证据。管理端兜底成功只能证明 NewAPI 发放和数据面可用，不能证明飞书卡片回调主路径闭环。
100. NewAPI quota 需要按内部单位写入：upstream 默认 `QuotaPerUnit=500000`，因此 TokenInside 的展示额度 `200` 应写入 `remain_quota=100000000`；直接写 `200` 会让新 token 只剩极小余额并触发模型调用额度不足。
101. `NEWAPI_QUOTA_PER_UNIT` 应保留为环境配置，默认 `500000`，便于未来 NewAPI 实例若调整单位时不需要改业务代码；健康检查展示该单位有助于部署验收。
102. B5 MVP 数据面在当前 active key 上已覆盖 `GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses`、`POST /v1/messages`；embeddings/images/audio/Gemini-compatible 仍按计划不纳入本期 allowlist。
103. NewAPI/OpenAI-compatible usage 字段不完全一致：Chat/Responses 返回 `prompt_tokens`、`completion_tokens`、`total_tokens`，Claude-compatible messages 可能只返回 `input_tokens` 与 `output_tokens`，TokenInside 应在代理层统一映射并在缺少总量时补算。
104. 管理概览的 token 聚合应以代理日志为基础，先作为 E 阶段基础用量统计；更完整的额度重置、账期统计和 NewAPI logs 校准仍属于后续生产化工作。
105. 当前运行镜像为 `voidintheshell/tokeninside:e-quota-unit-usage-3-20260703`，digest `sha256:5a91b949118e1a97e92f6c264756e8cc918f774aed8ae0a84d680e55a86565cf`；远端容器 healthy，公网 B5 三条 POST 路径和管理概览 usage 聚合均已复测通过。
106. key 重置应以旧 NewAPI token 的当前 `remain_quota` 为继承来源，而不是重新发放默认月额度；否则 key reset 会意外重置额度，违反“key 重置只轮换凭证不重置额度”的计费口径。
107. TokenInside 侧替换 active key 时，应把旧 `token_accounts` 标记为 `replaced` 并保留 `replacedByTokenAccountId`，这样旧 key 的代理日志仍能归属到同一飞书用户，新 key 成为唯一 active 映射。
108. 生产环境实际触发 `POST /api/token/reset` 会禁用当前 active key，属于破坏性业务动作；除非用户明确要求或测试窗口确认，否则只验证部署健康和未登录 401，不擅自对生产 active key 执行真实 reset。
109. 当前运行镜像为 `voidintheshell/tokeninside:e-key-reset-20260703`，digest `sha256:7cdf25a5287df668cf55c7b9a33b40e49c200b83548d3a169334d6785607d67c`；远端容器 healthy，公网 `/api/health` 正常，公网未登录 `POST /api/token/reset` 返回 401。
110. 额度重置和 key 重置是不同业务动作：key 重置轮换凭证并继承当前剩余额度；额度重置不轮换凭证，只在审批通过后把当前 active NewAPI token 的 `remain_quota` 更新为审批最终额度。
111. 额度重置应复用既有飞书卡片审批和管理端兜底审批状态机，不新增认证方式，也不允许用户自报审批人；申请路由只生成 `quota_reset` 待审批单，实际 quota update 必须发生在审批通过后的 `provisionTokenForRequest()` 分支中。
112. 当前运行镜像为 `voidintheshell/tokeninside:e-quota-reset-20260703`，digest `sha256:12da5c45cfdcf1348288bd75c794ee1cede971e2e08cc8c1b28cb2a2abcf7687`；远端容器 healthy，远端本机和公网未登录 `POST /api/token/quota-reset` 均返回 401。本轮未擅自提交生产 quota reset 申请或修改生产额度。
113. 部门主管自动同步应只授予当前用户所在部门的 department scope：TokenInside 读取飞书部门详情并比较 `department.leader_user_id` 与当前 OAuth 用户 `openId`，匹配才写入 `department_supervisor` 范围；这不引入新认证方式，也不相信前端传入的管理范围。
114. 自动同步范围必须和手工/环境授权分离：`department_supervisor` 可由同步禁用或激活，但不得覆盖 `manual` 或 `environment` 管理范围，否则会破坏已有兜底管理员路径。
115. 当前运行镜像为 `voidintheshell/tokeninside:e-dept-sync-20260703`，digest `sha256:124d44165aaf13f028b6e33a64990238735bba52148a6174da1efbcc784d9618`；远端容器 healthy，公网 `/api/health` 正常，公网 `/api/admin/overview` 未登录 401、soft 200 均正常。
116. 管理端主动调额应记录为 `quota_adjust` 申请单，而不是只直接改 NewAPI quota；这样管理后台和后续数据库迁移能保留操作人、操作时间、目标用户和最终额度的审计轨迹。
117. 所有管理端写接口应统一使用 `requireAdminScope()`，否则部门主管自动同步后的管理范围无法覆盖设置、审批额度覆盖和调额等写路径。
118. 当前运行镜像为 `voidintheshell/tokeninside:e-quota-adjust-20260703`，digest `sha256:406a8d9d8b64b2e9eb2dcccdde2d5e6ca1abc021e819738a778334bfb549b63b`；远端容器 healthy，公网 `/api/health` 正常，公网未登录管理端调额返回 401。
119. JSON MVP 阶段的账期同步可以先做成派生汇总：从 `tokenAccounts.billingPeriod` 确定账期归属，从已发放的首次申请、额度重置和管理端调额申请确定账期额度，从代理日志聚合 usage；这样能为用户后台和管理后台提供当前账期视图，同时避免自动月度重置误改生产 quota。
120. `userBillingPeriods` 作为 JSON store 内的同步结果应使用源数据最新时间作为 `updatedAt`，不能每次 read 用当前时间刷新，否则会导致读取 API 反复写文件。
121. 当前运行镜像为 `voidintheshell/tokeninside:e-billing-sync-20260703`，digest `sha256:b444712f9bd62f15718a059231708300a901f1c2919345c3a1479f78fcc169ed`；远端容器 healthy，公网 `/api/health` 正常，远端 store 已生成当前 `2026-07` 账期汇总。本轮仍未启用自动月度 quota reset。
122. PostgreSQL 生产目标机不是 USLA 测试机，而是 SSH MCP 配置中的 `共绩TokenInside服务端机器`；USLA/RemoteUSDMITLA 仍作为 `ti.kumiko-love.com` 当前测试部署机使用，不能据此推导最终生产 PG 容器参数。
123. `共绩TokenInside服务端机器` 当前硬件画像为 2 vCPU、约 2GiB 内存、约 50G 根盘，空闲负载很低且无 swap；PG 默认参数应按 2C2G 小机保守配置，避免 PostgreSQL 与 Next.js 应用争抢内存。
124. 60 人左右、峰值并发 100 的 TokenInside 场景不需要默认引入 PgBouncer；应用侧 PG pool 默认 `10`，PostgreSQL `max_connections=30` 更适合 2C2G 且 PG 容器 `mem_limit=768m` 的生产初始值，后续如果出现连接等待、多 app 副本或短连接膨胀，再单独评估 PgBouncer。
125. 2C2G 默认 PostgreSQL 容器参数采用 `postgres:16-alpine`、`shared_buffers=256MB`、`effective_cache_size=768MB`、`work_mem=4MB`、`maintenance_work_mem=64MB`、`max_connections=30`、`autovacuum_max_workers=2`、`statement_timeout=30s`、`lock_timeout=5s`、`log_min_duration_statement=500ms`，容器建议 `cpus: "1.0"`、`mem_limit: 768m`、`shm_size: 128m`。
126. 历史状态：运行镜像曾为 `voidintheshell/tokeninside:c-postgres-pool-20260703`，digest `sha256:44ef9befca97ff5678d0f1000bc12d6a850b29d35478f778a882ca563e51adbc`；当时远端容器 healthy，测试部署仍使用 JSON store，PostgreSQL 生产参数已进入代码/env/compose 模板但尚未在最终生产机切换启用。
127. `共绩TokenInside服务端机器` 只读巡检确认当前没有可用 `docker` / `docker compose` 命令；内存可用约 1.4GiB、根盘可用约 43G，监听端口包含 22 和现有 `gongji-newapi-g` 的 8088。生产部署前必须先确认是否允许安装 Docker，或提供已有容器运行环境。
128. 月度账期重置应默认关闭并显式开启：`TOKENINSIDE_MONTHLY_RESET_ENABLED=false` 时只允许全局管理员做 dry-run，不允许真实修改 NewAPI active token quota；开启后才允许执行非 dry-run。
129. 月度账期重置当前以 active token account 的 `billingPeriod` 作为幂等标记：目标账期相同则跳过，目标账期不同才把 NewAPI `remain_quota` 重置为当前默认月额度并写入 `requestType=monthly_reset` 审计记录，然后把 account `billingPeriod` 切到目标账期。
130. 月度账期重置仍不新增认证方式：执行入口复用飞书 OAuth session + TokenInside 全局管理员授权，部门管理员不能执行全局账期重置；机器级定时触发要等生产运维路径明确后再接入，不能先引入独立 secret auth。
131. 当前运行镜像为 `voidintheshell/tokeninside:e-monthly-reset-20260703`，digest `sha256:8626a69ae09421ab181fbfb6e233f4996053e94aaca522ed92332aa19f7f8c9f`；测试部署 health 显示 `monthlyResetEnabled=false`，未登录月度重置 dry-run 返回 401，本轮未触发真实月度重置或修改 NewAPI quota。
132. `共绩TokenInside服务端机器` 生产部署前置条件：系统为 Ubuntu 22.04，`apt-get`、`curl`、`ufw` 可用，`sudo -n` 可用，端口 16878 当前未监听；但 Docker/Compose 仍不可用，需要用户确认后才能安装或接入现有容器运行环境。
133. JSON 到 PostgreSQL 导入脚本是替换式导入，不能默认可执行；当前已改为必须 `--confirm-replace`，并新增 dry-run 与 `db:verify-import`，把“备份后显式确认导入”和“导入后计数校验”变成生产切换验收条件。
134. `ti.kumiko-love.com` 已迁移到 `共绩TokenInside服务端机器` 继续开发；后续不再使用 LA/USLA 作为 TokenInside 开发部署目标。生产机通过 Nginx Proxy Manager 反代内部上游 `tokeninside:16878`，TokenInside 统一 compose 必须保持 app 容器名/网络别名 `tokeninside` 且不需要发布宿主机 16878。
135. 生产机已通过 mihomo 恢复 Docker Hub/官方 Docker registry 拉取能力；后续部署仍按本地构建并推送 `voidintheshell` Docker Hub，生产机优先 `docker pull` + `docker compose up -d`，只有远端 pull 失败时才回退到本地 `docker save`、上传 tar、生产机 `docker load`。
136. 生产 NPM 容器已接入 `tokeninside_net` 后，nginx 仍一度返回 502；原因是 NPM 生成的 nginx resolver 使用外部 DNS，不能解析 Docker 服务名 `tokeninside`。已在 NPM 数据卷 `/data/nginx/custom/server_proxy.conf` 持久化 `resolver 127.0.0.11 valid=10s ipv6=off;`，让 proxy host 能解析内部容器名。
137. 生产 PostgreSQL 备份应从宿主机对 `tokeninside-postgres` 执行 `pg_dump -Fc`，并保存 sha256 校验文件；恢复必须要求显式 `TOKENINSIDE_CONFIRM_RESTORE=true`，默认拒绝执行，避免误覆盖生产库。
138. 生产机启用 mihomo 后，宿主机解析自身域名可能得到 `198.18.*` 代理假 IP，直接 `curl https://ti.kumiko-love.com` 可能出现 TLS EOF；生产自测应优先使用 NPM 容器访问 `http://tokeninside:16878/api/health`，或宿主机用 `curl --resolve ti.kumiko-love.com:443:127.0.0.1 https://ti.kumiko-love.com/api/health` 验证 NPM HTTPS/SNI。
139. PostgreSQL 健康检查不能只验证连接成功；compose project name 或 volume 名变化可能让应用连到空库。生产 health 必须包含 schema readiness，至少检查 required tables 并在缺表时返回 degraded/503。
140. 历史状态：生产运行镜像曾为 `voidintheshell/tokeninside:prod-health-schema-20260703`，digest `sha256:7655935ac1e539151cf61cb47db4ba2f8c49c72bc3cad13a489ffa82d9ee786b`；远端通过 Docker Hub pull 部署成功，schema health 显示 8 张 required tables 均就绪。
141. 生产机上的 mihomo 不能常驻：TUN 模式会创建 `Meta` 接口、`198.18.*` DNS/路由和 policy routing，可能影响公网入站连接回包。生产发布需要拉 Docker Hub 镜像时才临时启用，拉取完成后应停止并禁用。
142. 历史状态：`ti.kumiko-love.com` 临时开发入口曾切回 GreenJP -> LA，且 LA 当时仍使用 JSON store 开发数据；该状态已被后续 LA PG 迁移取代。
143. 生产机 Docker Hub 拉取必须使用 `scripts/production-docker-pull-with-mihomo.sh` 或等价流程，而不是手工 `systemctl start mihomo` 后直接操作；脚本已验证能在 pull 成功后自动恢复 `mihomo inactive/disabled`，避免再次留下 `Meta` TUN 和 policy routing。
144. 飞书卡片交互错误 `code:200671` 的官方含义是卡片回调服务返回了非 HTTP 200 状态码；`code:200672` 才是响应体格式错误。因此若飞书端点击卡片出现 `200671`，优先查 `/api/feishu/events` 在公网反代日志中的状态码，重点定位 401 签名/token、400 payload/解密或 500 业务异常。
145. 飞书新版卡片回传交互 `card.action.trigger` 的请求体使用 `schema=2.0`、`header.token`、`header.event_type`、`event.operator.open_id`、`event.action.value`、`event.context.open_message_id` 等字段；旧版 `card.action.trigger_v1` 结构不同。若同时订阅新旧回调，飞书会发送两类请求，官方建议删除多余请求方式。
146. TokenInside `/api/feishu/events` 已兼容新版与旧版卡片回调字段路径：新版/旧版明文卡片回调均可在 verification token 正确时返回 HTTP 200 + 官方 toast，签名加密 challenge 链路仍保持 AES 解密与签名校验。历史 LA 镜像曾为 `voidintheshell/tokeninside:card-callback-200671-fix-20260703`，digest `sha256:b77686b1a09ae5fd2b27de1590885e5e239d8f8f6759e51e767a88873bc4b038`。
147. 为降低卡片点击边缘风险，飞书后台 `开发配置 -> 事件与回调 -> 回调配置` 应只保留新版 `card.action.trigger`，移除 `card.action.trigger_v1` 和重复订阅后发布应用版本；代码层兼容旧版只是兜底，不应依赖重复回调作为主路径。
148. 北海管理员在飞书内置浏览器打开 `/admin` 报 `ERR_CONNECTION_RESET(-6)` 与卡片 `200671` 不属于同一类问题；前者更像端内浏览器到域名/反代/TLS/网络链路重置。排查时应让飞书内置浏览器分别打开 `/api/health`、`/` 和 `/admin`，并对照 BunkerWeb 是否出现访问日志。
149. 用户后台隐藏 key 时不能展示 NewAPI token 数字 ID；数字 ID 不是用户可用凭证，展示它会造成“已隐藏但看到数字”的误导。隐藏态应展示完整 key 的头尾省略形式，当前实现由 `/api/session` 后端实时读取 key 后返回 `maskedKey`，不返回明文 key。
150. 用户点击“查看”key 时，完整 key 仍通过 `/api/token/key` 实时读取；前端读取成功后展示完整 key 并尝试写入剪切板。浏览器拒绝剪切板权限时不应把动作误报成读取失败，而是保留完整 key 展示并提示未允许自动复制。
151. `maskSecret()` 仍用于 open_id、错误信息等普通脱敏场景；NewAPI key 使用独立 `maskApiKey()`，避免不同标识符的脱敏展示规则互相影响。
152. 当前 LA 运行镜像已更新为 `voidintheshell/tokeninside:key-mask-copy-20260703`，digest `sha256:17da0640f6adfe1ab32f9e137b999536415f0e511728058692df2cb1fb5dba56`；公网 `/api/health` 返回 200，容器 healthy。
153. LA 调试入口已从单 app + JSON store 切换为 PG/app 双容器：`tokeninside-postgres` 使用 `postgres:16-alpine` / PostgreSQL `16.14`，app 使用 `voidintheshell/tokeninside:key-mask-copy-20260703`；原 JSON store 已备份到 `/home/beihai/tokeninside/backups/json/tokeninside-20260703T070055Z.json`，并导入 PG。
154. LA JSON -> PG 导入校验通过：`db:import-json -- --confirm-replace` 导入 users=3、tokenRequests=10、tokenAccounts=2、userBillingPeriods=2、feishuEvents=3、proxyRequestLogs=28、adminScopes=0；`db:verify-import` 返回 `ok:true` 且所有集合/表计数匹配。
155. LA 与生产机当前均已使用 PostgreSQL backend，`/api/health` 均显示 `store.type=postgres`、`schema.ready=true`、`missingTables=[]`、`tableCount=8`、`postgresPool.max=10`；两边 PG 参数均为 `max_connections=30`、`shared_buffers=256MB`、`effective_cache_size=768MB`、`work_mem=4MB`、`statement_timeout=30s`。
156. 生产机 compose 已修正为 postgres 服务通过 `env_file: .env.production` 接收 `POSTGRES_PASSWORD`，不再依赖 `${POSTGRES_PASSWORD}` 插值；仓库 `docker-compose.production.example.yml` 已同步同样写法，避免后续普通 `docker compose` 操作出现空密码插值警告或重建风险。

## 官方文档来源

1. `https://open.feishu.cn/document/client-docs/h5/development-guide/basic-concepts`
2. `https://open.feishu.cn/document/uYjL24iN/uMTMuMTMuMTM/development-guide/step-3`
3. `https://open.feishu.cn/document/uYjL24iN/uUzMuUzMuUzM/requestaccess`
4. `https://open.feishu.cn/document/common-capabilities/sso/api/obtain-oauth-code`
5. `https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3`
6. `https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/user_info/get`
7. `https://open.feishu.cn/document/uYjL24iN/uEzM4YjLxMDO24SMzgjN`
8. `https://open.feishu.cn/document/server-docs/approval-v4/instance/create`
9. `https://open.feishu.cn/document/server-docs/approval-v4/approval/create`
10. `https://open.feishu.cn/document/server-docs/approval-v4/event/common-event/approval-instance-event`
11. `https://open.feishu.cn/document/server-docs/approval-v4/event/event-interface/subscribe`
12. `https://open.feishu.cn/document/server-docs/approval-v4/task/approve`
13. `https://open.feishu.cn/document/server-docs/contact-v3/department/children`
14. `https://open.feishu.cn/document/server-docs/contact-v3/user/find_by_department`
15. `https://github.com/QuantumNous/new-api/blob/main/router/api-router.go`
16. `https://github.com/QuantumNous/new-api/blob/main/controller/token.go`
17. `https://github.com/QuantumNous/new-api/blob/main/middleware/auth.go`
18. `https://open.feishu.cn/document/best-practices/how-to-configure-the-mobile-end-homepage`
19. `https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/handle-card-callbacks`
20. `https://open.feishu.cn/document/server-docs/im-v1/message/create`
21. `https://open.feishu.cn/document/server-docs/contact-v3/user/get`
22. `https://open.feishu.cn/document/server-docs/contact-v3/user/field-overview`
23. `https://open.feishu.cn/document/server-docs/contact-v3/department/field-overview`
24. `https://open.feishu.cn/document/uYjL24iN/uYjN3QjL2YzN04iN2cDN`
25. `https://open.feishu.cn/document/feishu-cards/card-callback-communication`
26. `https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/event-card-faq`
27. `https://open.feishu.cn/document/event-subscription-guide/callback-subscription/add-callback`
28. `https://open.feishu.cn/document/event-subscription-guide/callback-subscription/receive-and-handle-callbacks`
29. `https://open.feishu.cn/document/event-subscription-guide/callback-subscription/step-1-choose-a-subscription-mode/send-callbacks-to-developers-server`
30. `https://open.feishu.cn/document/feishu-cards/configuring-card-interactions`
31. `https://open.feishu.cn/document/server-docs/im-v1/message/create`

## 2026-07-03 补充发现

1. 飞书卡片 `code:200671` 仍应按“回调服务返回非 HTTP 200”优先排查；本轮确认 LA 上若 `feishu_events` 没有新增记录而飞书端报错，说明请求可能在签名、verification token、解密或 JSON 解析等入口层分支被 401/400 拦截。
2. 卡片审批通过后同步调用 NewAPI 发放也是 `200671` 风险点：`provisionTokenForRequest()` 抛错会被外层 catch 转成 HTTP 500，飞书端只看到回调非 200。卡片回调应把业务发放失败记录为本地 failed 事件和申请错误，并对飞书返回 HTTP 200 toast。
3. 当前 `/api/feishu/events` 已调整为卡片回调优先返回 HTTP 200：签名、明文 verification token、解密后 verification token 任一可信即可继续；识别为卡片回调但认证失败、发放失败或处理异常时尽量写入 `feishuEvents` 并返回 toast，避免再次触发 `200671`。
4. LA 当前运行镜像为 `voidintheshell/tokeninside:card-callback-200671-final-20260703`，digest `sha256:87047f4db4df1860513bede62d9728421261be999b51752ca965e19e1af86c54`；LA 本机和公网新版 `card.action.trigger` 缺字段模拟均返回 HTTP 200 + toast，且 PG `feishu_events` 已写入测试记录。
5. 该修复只证明回调接口不会因入口层/业务层常见异常向飞书返回非 200；真实 B3 完成仍需要审批目标领导在飞书内点击真实卡片，验证真实 payload、`operator.open_id`、nonce 幂等、状态回写和审批通过后的 NewAPI 发放。
6. 当前管理后台缺失“取消用户权限”独立能力：现有路由只有 overview、settings、审批 decision/quota、用户 quota-adjust 和月度账期重置，没有 revoke/disable 用户 active key 的管理端 API。该任务已补入 E 阶段计划，口径为管理员禁用或撤销目标用户当前 active key，但保留用户、token account 历史映射、代理日志、账期汇总和 NewAPI 历史 logs 归属，确保取消权限后历史耗费仍可归属原飞书用户。
7. 被取消资格触发条件此前未完善进计划；已补充为：成员主动离职、被动离职、被解除劳动关系、飞书账号停用/删除、调离 TokenInside 允许服务范围且无其它有效范围、管理员手动取消、安全事件或 key 泄露、违规使用、误审批/误发放修正、成员主动要求停用。额度用完、单次请求失败、上游或网络临时错误、部门主管权限变化本身、仍在允许服务范围内的普通调岗或汇报线变化、通讯录临时读取失败或数据权限不足，不应直接触发取消资格。
8. 用户调离部门后的额度继承此前未完善进计划；已补充为：TokenInside key 和额度按飞书用户绑定，调离后仍有资格时 active key 不轮换，当前账期剩余额度默认随用户进入新部门；调动前已发生调用和已消耗额度按调用发生时部门快照留在原部门。部门总额度不能按当前部门成员追溯重算，应拆成历史已用、当前剩余和调入调出调整；未来若有部门预算池，调动只迁移未用余额，不复制额度。
9. 本轮按“审批流程优先”重新核对代码与路由：`/api/token/request` 已按服务端默认额度创建申请，解析部门领导并发送飞书卡片，成功后进入 `pending_card_approval`；失败时区分 `approval_route_failed` 与 `approval_card_send_failed`。`/api/feishu/events` 已处理 `card.action.trigger` / `card.action.trigger_v1`，会校验 requestId、nonce hash 和审批人 open_id。
10. 当前审批与飞书同步的 P0 缺口不是“没有代码入口”，而是缺少真实飞书卡片点击后的同链路证据：飞书点击动作、`feishu_events` 新增记录、申请单状态、NewAPI 发放结果、用户 active key 和 `/v1` 可用性必须指向同一条申请。管理端人工审批已经可作为兜底，但不能替代真实飞书审批同步验收。
11. 审批通过后的同步语义已明确为三种结果：`provisioned` 表示飞书通过且 NewAPI 发放成功；`approved_provision_failed` 表示飞书通过但 NewAPI 发放失败，需要 App 留存错误并由管理后台兜底；`rejected` 表示飞书拒绝且不得发放 key。飞书端无论业务成功或失败都应收到 HTTP 200 toast，避免再次表现为 `200671`。
12. Next MCP 当前可发现审批相关路由：`/api/token/request`、`/api/feishu/events`、`/api/admin/token-requests/[id]/decision`、`/api/admin/token-requests/[id]/quota`、`/api/token/quota-reset` 和 `/v1/[...path]`；`get_errors` 返回 config/session 均为空。后续若继续实现，仍需在代码变更后单独跑 `npm run typecheck` 和 `npm run build`。
13. 代码核对发现真实飞书卡片审批分支此前只更新申请状态，未把卡片操作者和操作时间写回申请单；这会削弱 App 侧审计和“飞书动作与 App 状态同步”的可追踪性。已在 `/api/feishu/events` 的通过/拒绝分支补写 `approvalOperatorOpenId` 与 `approvalOperatedAt`。
14. 代码核对还发现卡片回调重复事件会在进入 card handler 前返回普通 `{ ok: true, duplicate: true }` JSON；已改为卡片事件重复时返回官方 toast 格式，继续保持飞书端 HTTP 200 且降低响应体格式风险。
15. 用户再次反馈真实卡片点击仍为 `200671` 后，GreenJP/BunkerWeb 日志显示飞书 `Go-http-client/1.1` 请求 `/api/feishu/events` 曾收到 `400 51`；这与旧代码 raw JSON / 解密 payload 解析失败返回 `{"error":"Invalid Feishu event payload"}` 的响应体长度吻合。该问题不是发卡失败，发卡已经产生 `approvalCardMessageId`，而是点击回调早期解析阶段没有给飞书 HTTP 200。
16. 当前入口已补强为可观测失败：raw parse 或 payload decrypt/parse 失败时写入 `feishu_events.event_type=invalid_payload`，记录脱敏 `rawPreview`、`contentType`、`userAgent`、`wrapperKeys`、`hasEncrypt` 和 `encryptLength`，并对飞书返回 HTTP 200 toast。公网 `text/plain` 模拟已证明 BunkerWeb 最终状态码为 200，PG 留下 `invalid_payload` 记录。
17. 子 agent 查阅飞书官方文档后确认：`200671` 的官方含义是回调服务返回非 HTTP 200；`200340` 更偏未配置/地址无效，`200341` 是超时，`200342/200343` 是连接/DNS，`200672` 是响应体格式，`200673` 是返回卡片错误。因此本轮代码修复方向应继续围绕“所有卡片点击路径都先 200 并落审计”，而不是先怀疑 action.value 或 NewAPI 发放本身。
18. 官方配置前置条件应逐项复核：新版 `card.action.trigger` 在飞书开放平台 `开发配置 -> 事件与回调 -> 回调配置` 中选择 Webhook 回调地址，并在页面底部 `已订阅的回调` 添加 `卡片回传交互`；保存 URL 时会发送 `url_verification`，服务端需 1 秒内返回 challenge；回调处理需 3 秒内返回 HTTP 200；配置变更需要创建并发布应用版本后生效。
19. 官方文档同时说明旧版 `card.action.trigger_v1` / 历史消息卡片请求网址在 `应用能力 -> 机器人 -> 消息卡片回调请求方式`，属于历史路径；如果同时配置新版和旧版，会产生两类请求。TokenInside 当前兼容新旧结构，但飞书后台主路径建议只保留新版 `card.action.trigger`，清掉旧版/重复订阅并发布版本，避免同一次点击出现多路结构干扰。
20. 机器人发卡和用户点击回调是两条链路：应用机器人能点对点发送 `interactive` 卡片，只能证明发卡能力、机器人可用范围和消息接口可用；用户点击按钮触发的是 `卡片回传交互` 回调订阅，仍依赖回调 URL、事件订阅、verification token / encrypt key / signature、响应码和响应体格式。
21. 当前高成申请的审批目标与用户补充一致：`tr_e51e61df74ed36cccdf11b06` 的 `approval_target_open_id=ou_9ca199a8a099f88b32d337e7c714062f`，飞书通讯录用户接口确认姓名为袁旗，部门 `od-d8521bd193d26e3ccf9e6bec08b5bff1` 的部门接口确认 `leader_user_id` 也是袁旗 open_id。数据库本地 `feishu_users` 只缓存了高成，不缓存袁旗；审批目标确认需要依赖飞书通讯录 API 或申请单里的 open_id。
22. 用户最新测试显示“审批回调格式无法识别，已记录”后，PG 真实记录明确为 `contentType=application/json`、`wrapperKeys=[\"encrypt\"]`、`hasEncrypt=true`、`encryptLength=1004`、`stage=payload_parse`。因此飞书后台订阅模式已正确进入新版加密回调，问题不是 `card.action.trigger` 未保留，而是服务端 AES 解密算法不匹配真实飞书加密体。
23. 飞书官方 Node SDK `@larksuiteoapi/node-sdk` 1.68.0 的 `AESCipher` 实现显示：`key=sha256(encryptKey)`，IV 取 `Buffer.from(encrypt, 'base64').slice(0, 16)`，ciphertext 取第 16 字节之后再 AES-256-CBC 解密。TokenInside 旧实现使用 `sha256(encryptKey).slice(0, 16)` 作为 IV，导致真实 `{ encrypt }` 解密失败；旧本地加密 challenge 是按错误算法自造的，只能证明反代可达，不能证明真实飞书解密正确。
24. 当前 `lib/crypto.ts` 已改为优先使用飞书 SDK 同款 IV 规则，并保留旧规则 fallback；部署后用官方 IV 规则构造的公网加密 challenge 能返回正确 challenge，加密 `card.action.trigger` 缺字段能返回 `审批卡片参数不完整` toast，并在 PG 写入 `event_type=card.action.trigger` 而不是 `invalid_payload`。
25. 飞书端 `200341` 在本次真实点击中不是业务失败：PG 已显示真实 `card.action.trigger` 事件 `processed`，申请 `tr_8efb4f5f2001b5fc5a49138a` 已 `provisioned` 并绑定 `ta_f8ac4cce23bbcd445baf4b61`。BunkerWeb 同一请求为 HTTP `499`，说明飞书客户端等待过久后断开；根因是回调中同步等待 NewAPI 发放完成才返回 toast。
26. 卡片点击回调的正确工程策略应为“快速 ACK + 后台发放”：飞书点击动作先同步落库为 App 侧审批状态和事件审计，并立刻返回 HTTP 200 toast；NewAPI 创建/调额等慢操作放到响应后的后台任务。TokenInside 当前已用 Next 16 `after()` 实现该策略，发放失败仍由申请状态 `approved_provision_failed` 和派生事件保留可观测性。
27. 子 agent 查阅飞书官方文档后确认：`200341` 表示卡片回调服务未在规定时间内响应飞书卡片服务端，官方要求 `card.action.trigger` 在 3 秒内返回 HTTP 200；Webhook 回调是同步操作，超时会被判定失败并在飞书客户端展示错误。官方响应体允许返回 `{}`、toast，或 toast + card；返回非 200 对应 `200671`，响应体格式错误对应 `200672`。
28. 用户最新产品口径要求把“全局管理”统一改为“系统管理员”。现有代码和配置中 `scopeType=global`、`TOKENINSIDE_ADMIN_OPEN_IDS` 可作为内部兼容实现，但前端显示、计划文档、初始化环境变量说明和管理员能力应使用“系统管理员”。
29. 当前 `lib/admin-sync.ts` 的部门主管自动同步只在用户有 `departmentId` 且部门 `leader_user_id` 等于当前用户时授予部门管理员范围；当申请人无组织、无部门、部门无负责人、负责人等于申请人或通讯录读取失败时，现有主链路需要补系统管理员兜底，不能继续让申请停在不发送请求或无法路由状态。
30. 系统管理员兜底审批应优先进入近期实现：初始化环境变量应支持手动配置系统管理员，建议新增 `TOKENINSIDE_SYSTEM_ADMIN_OPEN_IDS` 并兼容旧 `TOKENINSIDE_ADMIN_OPEN_IDS`；审批目标解析失败时写入 `approvalTargetSource=system_admin_fallback`，并把卡片发送给系统管理员。
31. 用户界面必须在无组织/主管不可识别兜底时提示固定文案：“您当前不属于任何组织，请求将发送给系统管理员，请联系系统管理员审批”。该提示是业务状态提示，不是错误 toast，用户仍应能提交申请。
32. 系统管理员能力需要补“查看全部管理员”和“指派管理员”：系统管理员可查看环境变量、手动和自动同步产生的全部管理员范围；可指派系统管理员或部门管理员；部门主管不能越权创建系统管理员或扩大自己的部门范围。
33. 当前用户后台已经有账期额度、token usage 和代理请求统计，但用户要求补“剩余额度”。实现时不能简单用 `monthlyQuota - totalTokens`，因为 display quota、NewAPI 内部 quota 和 token usage 不是同一单位；应按 TokenInside 账期额度口径和 NewAPI quota 单位换算后展示。
34. 当前用户后台代码中“最新审批请求”卡片只要存在 `adminScope` 就常驻，且管理后台入口同时存在于用户卡片和子菜单；用户要求收口为：管理后台入口只在用户卡片处展示，最新审批请求只在管理员用户后台首屏用户卡片下方展示，切换子菜单后不常驻。
35. 当前用户卡片状态在 loading/busy 时直接显示“自动识别中”，用户指出文字会超出圆圈边界；应改为加载动画或旋转图标，保持组件尺寸稳定，并通过 aria-label/title 表达自动识别状态。
36. 用户后台 UI 收口还包括：左上 TokenInside 下方小字改为“共绩科技”；用户后台底部小字去掉；已有 active key 的提示移动到用户卡片刷新按钮旁绿色小勾左侧；刷新按钮固定在用户卡片右下方；模型列表下方小字改为“当前可用的模型ID”。

## 本地计划文档

1. `.agent-docs/TokenInside-实施总路线图.md`
2. `.agent-docs/TokenInside-B阶段真实链路实测计划.md`
3. `.agent-docs/TokenInside-B1飞书H5免登修复计划.md`
4. `.agent-docs/TokenInside-C阶段数据库生产化计划.md`
5. `.agent-docs/TokenInside-D阶段部署运维计划.md`
6. `.agent-docs/TokenInside-E阶段管理后台与用量统计计划.md`
7. `.agent-docs/TokenInside-真实链路实测记录.md`
