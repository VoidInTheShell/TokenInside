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

## 本地计划文档

1. `.agent-docs/TokenInside-实施总路线图.md`
2. `.agent-docs/TokenInside-B阶段真实链路实测计划.md`
3. `.agent-docs/TokenInside-B1飞书H5免登修复计划.md`
4. `.agent-docs/TokenInside-C阶段数据库生产化计划.md`
5. `.agent-docs/TokenInside-D阶段部署运维计划.md`
6. `.agent-docs/TokenInside-E阶段管理后台与用量统计计划.md`
7. `.agent-docs/TokenInside-真实链路实测记录.md`
