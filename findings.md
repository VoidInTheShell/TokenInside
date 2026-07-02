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
