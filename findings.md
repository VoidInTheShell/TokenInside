# TokenInside 飞书权限研究发现

## 飞书官方文档结论

1. 网页应用开发的必要配置是创建并发布自建应用；如果要获取客户端已登录用户身份，需要配置应用免登流程。
2. `tt.requestAccess` 支持网页应用，`scopeList: []` 表示仅授予应用获取登录用户信息权限。
3. 获取授权码接口、获取 `user_access_token` v3 接口、获取用户信息接口本身均不要求额外 API 权限。
4. `offline_access` 只在需要 `refresh_token` 并长期刷新 `user_access_token` 时申请。
5. `authen/v1/user_info` 默认可用于获取基础身份信息；邮箱、手机号、user_id、工号、企业邮箱等字段存在单独字段权限要求。
6. 飞书官方提醒手机号和邮箱为管理员导入联系方式，未经过用户本人实时验证，不建议直接作为业务系统登录凭证。
7. 除 `requestAuthCode`、`closeWindow`、`requestAccess` 外，其它 H5 JSAPI 一般需要先完成 JSSDK 鉴权。
8. 创建审批实例接口 `/approval/v4/instances` 使用 `tenant_access_token`，所需权限开启 `approval:instance` 或更宽的 `approval:approval` 任一即可。
9. 创建审批定义接口不推荐企业自建应用通过 API 调用，审批定义应优先由企业管理员在飞书审批后台创建，再把 `approval_code` 配置给 TokenInside。
10. TokenInside 自动化提交审批申请的正确方式是服务端用 `tenant_access_token` 创建审批实例，并在请求体中传当前飞书用户的 `open_id` 或 `user_id` 作为审批发起人；这不是系统代主管审批。
11. 用户有多个部门且审批定义依赖部门负责人链路时，创建审批实例应传 `department_id`，否则飞书会按默认部门行为流转，可能找错主管。
12. 审批结果自动回写需要两层前置：应用后台订阅 `approval_instance` 事件，并调用订阅审批事件接口绑定目标 `approval_code`。
13. TokenInside 不应默认申请 `approval:task`，除非未来明确要由系统代审批人执行同意、拒绝、退回或加签。
14. 获取子部门列表接口可用 `tenant_access_token`，如需读取部门名称、父子关系、负责人等字段，颗粒度权限应包含部门基础信息和部门组织架构信息。
15. 获取部门直属用户列表接口可用 `tenant_access_token`，如需读取成员姓名、头像、所属部门等字段，颗粒度权限应包含用户基础信息和用户组织架构信息。
16. 使用应用身份读取根部门 `0` 下的部门或成员时，飞书会校验应用通讯录数据权限范围；如需全量同步，数据权限范围需要覆盖全部成员。
17. 飞书移动端主页建议直接配置为业务自身域名，并在业务页面中通过 `requestAccess` 和登录态管理完成免登，避免把主页直接配置成授权接口导致重复重定向和加载变慢。

## 对 TokenInside 的设计影响

1. 个人 Token 管理能力需要网页应用免登基础能力、创建审批实例所需的 `approval:instance`，以及审批结果回写所需的事件订阅配置；不需要默认申请通讯录宽权限、消息、云文档、多维表格等权限。
2. TokenInside 用户主身份应使用 `tenant_key + open_id`，`union_id` 作为跨应用辅助字段。
3. `email`、`mobile`、`employee_no`、`feishu_user_id` 不应作为 MVP 必填字段；如后续需要展示或组织统计，再追加对应字段权限。
4. 管理员身份优先使用配置化 `tenant_key + open_id` 白名单，不应为了管理员判断而默认申请通讯录权限。
5. TokenInside 创建审批实例时优先传当前用户 `open_id`，不要为了发起审批默认申请 `contact:user.employee_id:readonly`。
6. 审批定义应在飞书审批后台配置直属主管或部门负责人节点；主管审批动作由飞书流转完成，TokenInside 只处理发起和结果回写。
7. 如果 MVP 包含部门主管后台，或需要稳定处理多部门用户主管链路，需要追加 `contact:department.base:readonly`、`contact:department.organize:readonly`、`contact:user.base:readonly`、`contact:user.department:readonly`，并配置通讯录数据权限范围。
8. 通讯录宽权限如 `contact:contact:readonly_as_app` 或 `contact:contact:readonly` 不应默认申请，只有颗粒度权限无法满足接口时再评估。
9. TokenInside 控制面前端已确认采用 shadcn/ui 风格和组件体系；后续页面、表单、表格、反馈组件和主题样式应按该约束实现。
10. Next.js 16.2.10 本地文档确认 App Router 的 route handler `params` 为异步 Promise，`cookies()` 也按异步 API 使用；`/v1/[...path]` 代理路由已按该约束实现。
11. `npm audit` 初次报告 Next 依赖链中的 `postcss@8.4.31` 存在 moderate 漏洞；`npm audit fix --force` 会错误降级到 Next 9.3.3，因此采用 npm `overrides` 固定 `postcss@^8.5.10`，复查为 0 vulnerabilities。
12. Next/Turbopack 构建对动态 `process.cwd()` store path 产生 NFT 追踪警告；在 `lib/config.ts` 给 `process.cwd()` 添加 `turbopackIgnore` 注释后，生产构建无警告通过。
13. 本次落地采用 JSON 文件 store 跑通状态机，不作为最终生产数据库方案；生产阶段仍应按实现方案第 14 节迁移到 PostgreSQL 并补唯一 active key 的数据库约束。
14. 后续执行已拆为 B/C/D/E 四个阶段：B 先实测飞书和 NewAPI 真实契约，C 再做 PostgreSQL 生产化，D 做 USLA 部署和反代，E 最后补管理后台和用量统计。
15. B 阶段需要优先确认 NewAPI token 创建、查询完整 key、禁用 token、更新 quota、查询 logs 的真实接口和凭据边界；这些契约会直接影响 `lib/newapi.ts` 和数据库字段设计。
16. 飞书审批事件 payload、事件签名、可选加密、审批状态枚举和 `instance_code` 字段路径必须通过真实回调确认；当前 `/api/feishu/events` 只能作为骨架。
17. 部署阶段必须新增健康检查和网络层防绕过策略；否则用户可能直连 NewAPI，导致 TokenInside 代理审计和策略控制失效。
18. 管理后台应排在真实链路、数据库和部署之后，避免在 NewAPI logs 字段和部门权限未确认前过早设计复杂统计页面。
19. 本机 `C:\0.01.Project\0.0.00.CompanyProject` 下未发现 NewAPI 源码目录；通过 upstream `QuantumNous/new-api` 源码确认 token 管理路由。
20. NewAPI `/api/token` 创建接口返回成功状态，不返回 token id 或明文 key；创建后需要按唯一 name 搜索 token，再调用 `POST /api/token/:id/key` 获取完整 key。
21. NewAPI `/api/token` 控制面路由使用用户态鉴权，除 `Authorization` 外还需要 `New-Api-User` 请求头；本项目新增 `NEWAPI_CONTROL_USER_ID` 作为服务端环境变量。
22. NewAPI token name 有长度校验，TokenInside 发放时需要使用短名称，避免包含完整飞书用户 id 和申请单 id 导致创建失败。
23. 飞书事件入口已补齐加密事件解包、verification token 校验、challenge 返回、审批字段多路径提取和 `event_id` 幂等处理；真实字段路径仍需飞书后台回调确认。
24. 当前仓库没有 `.env.local`，`npm run b:check` 只能完成环境 readiness 检查，外部 Feishu/NewAPI 网络实测需在填入真实密钥后执行。
25. 飞书事件订阅 Request URL 需要公网服务完成 challenge 验证，本地端到端测试会和飞书后台事件配置形成死循环；B 阶段应改为服务器优先，先产出 Docker 镜像部署到 USLA，再用 `https://ti.kumiko-love.com` 完成飞书 OAuth、审批事件和 NewAPI 控制面真实调试。
26. Next.js 16.2.10 的 standalone 输出适合 B0 Docker 镜像：`next.config.ts` 设置 `output: "standalone"` 后，Docker 可直接复制 `.next/standalone` 与 `.next/static`，并通过 `HOSTNAME=0.0.0.0`、`PORT=16878` 运行 `server.js`。
27. B0 本地 Docker 基线已验证：镜像 `tokeninside:latest` 可重复构建，容器生产模式可访问首页、`/api/session`、`/api/health`、飞书 challenge 和 `/v1` 代理校验；临时容器日志未出现密钥类信息。
28. `.env.production.example` 已作为可提交占位符放行，真实 `.env.production` 仍被 `.gitignore` 忽略；服务器部署时必须使用私有 `.env.production`，不能直接复用示例占位符。
29. 当前 `.env` 已足够完成 B1 基础飞书凭据探测和 B4 NewAPI 控制面探测；飞书审批实例创建和事件订阅仍缺 `FEISHU_APPROVAL_CODE_TOKEN_REQUEST` 与 `FEISHU_APPROVAL_EVENT_VERIFICATION_TOKEN`。
30. 测试 NewAPI 实例要求 `LLMAPI-User` 请求头；为兼容 NewAPI upstream 与该测试实例，控制面请求需要同时发送 `New-Api-User` 和 `LLMAPI-User`，值均来自 `NEWAPI_CONTROL_USER_ID`。
31. NewAPI token 管理真实契约已初步确认：`/api/token` 可创建 token，`/api/token/search` 可按 name 找到 id，`POST /api/token/:id/key` 可取完整 key，`PUT /api/token/?status_only=true` 可禁用 token。
32. B0 部署路径已按用户要求固定为本地 Docker 构建并推送 Docker Hub，服务器只执行 pull-only compose；当前镜像为 `voidintheshell/tokeninside:b0-20260702-1526`，digest `sha256:77faf6da8a61fac4f5033582563af3f8c7305fe31ed4f7ea158a0c324a25d3d7`。
33. 当前 GreenJP/BunkerWeb 到 USLA 的反代拓扑要求容器端口发布到宿主 `0.0.0.0:16878`；仅绑定 `127.0.0.1:16878` 时公网反代会返回 502。
34. `/api/feishu/events` 路由已写入并在公网可用；有效 JSON challenge 经 `https://ti.kumiko-love.com/api/feishu/events` 返回 200 JSON。此前公网 400 来自本地 PowerShell curl 构造了无效 JSON，并非 BunkerWeb 拦截有效飞书 challenge。
35. 已在 BunkerWeb `ti.kumiko-love.com` service 上设置 `REVERSE_PROXY_INTERCEPT_ERRORS=no`；公网 `/v1/models` 的 401/403 和事件入口无效 payload 的 400 均保留 TokenInside 上游 JSON，OpenAI-compatible 错误体兼容性已恢复。
36. 线上 `/api/health` 当前显示 NewAPI 控制面配置已就绪、JSON store 可写；`approvalCode` 与 `approvalEventVerification` 仍为 false，对应缺少 `FEISHU_APPROVAL_CODE_TOKEN_REQUEST` 和 `FEISHU_APPROVAL_EVENT_VERIFICATION_TOKEN`。
37. 本地 `.env` 已补齐飞书审批 code、事件 verification token 和事件 encrypt key；本地 `npm run b:check -- --all` 已验证飞书 tenant token 与 NewAPI token 只读访问。
38. 本地 `.env` 的 `TOKENINSIDE_SESSION_SECRET` 仍是占位符时，不能整文件覆盖远端 `.env.production`；应只合并新增密钥项或在远端单独维护生产 session secret。
39. 飞书审批事件订阅接口为 `POST /open-apis/approval/v4/approvals/:approval_code/subscribe`；首次订阅返回 `code=0 msg=success`，重复订阅可能返回 `subscription existed` 且 HTTP 非 2xx，脚本应按幂等成功处理。
40. 远端启用 `FEISHU_APPROVAL_EVENT_ENCRYPT_KEY` 后，明文无签名 challenge 不再是有效测试方式；应使用带 `x-lark-request-timestamp`、`x-lark-request-nonce`、`x-lark-signature` 的加密事件 payload 测试。
41. 线上 `https://ti.kumiko-love.com/api/feishu/events` 已通过签名加密 challenge 测试，说明 TokenInside 事件入口、AES 解密、verification token 校验和 GreenJP/BunkerWeb POST 链路均可用于飞书事件回调。
42. B2/B3 当前不再受配置变量阻塞；剩余不可由普通浏览器完成的部分是飞书客户端端内 OAuth、真实用户提交审批、主管审批动作和飞书实际 `approval_instance` payload 字段确认。
43. 飞书“管理员后台”入口应作为 `https://ti.kumiko-love.com/admin` 的快捷深链，不应作为 TokenInside 管理权限来源。
44. TokenInside 管理员权限必须由服务端基于飞书 OAuth 当前用户、飞书部门主管同步结果和 `admin_scopes` 计算；前端跳转和入口可见性不能替代授权。
45. 普通入口、移动端入口和管理员入口应使用同一业务域名 `ti.kumiko-love.com`；移动端差异通过响应式布局处理，避免新增域名带来的 OAuth、Cookie、H5 可信域名和反代复杂度。
46. 管理员也是普通用户；识别到管理范围后应显示管理入口或恢复上次工作区，不应无条件强制跳转管理员后台。
47. `/admin` 入口已本地落地为最小管理后台壳：未登录可从同页触发飞书免登，已登录后由服务端 `adminScopes` 范围判断是否授权；这不是新的认证方式。
48. `GET /api/admin/overview` 直接访问保留 401/403 语义，前端使用 `?mode=soft` 读取相同状态体并返回 HTTP 200，避免未登录/未授权的正常 UI 状态污染浏览器 console。
49. JSON MVP store 已加入 `adminScopes`，当前支持 `global` 与 `department` 两种范围；申请、token account 和 proxy log 统计都按同一范围过滤，避免部门主管看到全局代理日志数量。
50. 本地 Next 路由已包含 `/admin` 与 `/api/admin/overview`；`npm run typecheck`、`npm run build`、直接 API 401、soft API 200、浏览器 `/admin` 快照和 console 检查均已通过。
51. 不要并行执行 `npm run typecheck` 与 `npm run build`：当前 `tsconfig.json` include 了 `.next/types/**/*.ts`，`next build` 会重写 `.next/types`，并行时 `tsc` 可能遇到临时缺失文件；单独复跑 `typecheck` 可通过。
52. E0 管理入口镜像已发布并部署：`voidintheshell/tokeninside:e0-admin-20260702-1710` / `latest` 指向 digest `sha256:23e6d5e9ba9fea04d77e18a2a0cb49a5659ab858c151ac496728f37cb86f56f1`；远端 `docker-compose.yml.before-e0-admin-20260702-1710` 是替换镜像 tag 前的备份。
53. 公网 `https://ti.kumiko-love.com/admin` 已返回 200 HTML；公网 `/api/admin/overview` 未登录返回 401 JSON，`/api/admin/overview?mode=soft` 返回 200 JSON，`/v1/models` 无 key 仍返回 TokenInside JSON 401。

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

## 本地计划文档

1. `.agent-docs/TokenInside-实施总路线图.md`
2. `.agent-docs/TokenInside-B阶段真实链路实测计划.md`
3. `.agent-docs/TokenInside-C阶段数据库生产化计划.md`
4. `.agent-docs/TokenInside-D阶段部署运维计划.md`
5. `.agent-docs/TokenInside-E阶段管理后台与用量统计计划.md`
6. `.agent-docs/TokenInside-真实链路实测记录.md`
