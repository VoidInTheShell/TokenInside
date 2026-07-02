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

## 当前落地状态

1. 本地服务已启动在 `http://127.0.0.1:16878`。
2. 首版使用 `.local-data/tokeninside.json` 作为 MVP 状态存储；后续生产化应替换为 PostgreSQL。
3. `.env.example` 只保留占位符，没有写入真实 NewAPI System AK、飞书密钥或其他私密凭据。
4. 依赖审计通过 `postcss` override 修复为 0 vulnerabilities。
5. 外部飞书审批定义、飞书事件订阅、NewAPI token 创建接口仍需用真实环境变量实测。
