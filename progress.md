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
