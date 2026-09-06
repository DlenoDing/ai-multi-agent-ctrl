# 系统程序文件拆分审计与实施记录

审计时间：2026-09-04
最终复验：2026-09-06

## 问题

当前系统存在多个单文件过大的程序入口：

- `apps/control-plane-ui/public/app.js`：承载会话状态、菜单、API、弹窗、通用组件、页面渲染和事件处理。
- `apps/control-plane-ui/server.mjs`：承载启动配置、鉴权、读写状态、API 路由、静态资源、MCP 转发、实时通道和编排循环。
- `apps/control-plane-ui/lib/control-plane-core.mjs`：承载核心状态机、模型选择、任务编排、角色技能、仓库产出、关闭门和运行时治理。
- `scripts/contract-check.mjs` / `scripts/console-behaviour-check.mjs`：承载大量验证门。

这些文件太大时，后续 AI agent 执行定向修改容易出现三个问题：

- 修改定位成本高，容易在无关区域引入变更。
- 公共配置和展示词表散在业务文件里，容易形成第二真相源。
- 测试门和运行时加载方式不一致时，容易出现浏览器能跑、验证门失真的情况。

## 本轮拆分原则

- 只拆低耦合、可独立验证的公共模块。
- 不改变 API、权限、状态文件、MCP 网关、Agent Gateway、任务执行协议和数据库分片结构。
- 前端不引入打包器，继续由服务端静态文件直接提供，浏览器按脚本顺序加载。
- 行为门 VM 探针必须按真实浏览器同样的顺序加载公共模块。
- 核心编排文件暂不做强拆；后续拆分应按“状态集合初始化、模型选择、任务编排、关闭门、角色技能、仓库产出、容量裁剪”逐块迁移，并保持 `control-plane-core.mjs` 对外导出兼容。

## 已实施拆分

### 前端公共模块

新增目录：`apps/control-plane-ui/public/modules/`

- `i18n-utils.js`：控制台国际化入口和 `code:detail` 错误码解释。
- `dom-utils.js`：浏览器 UUID、剪贴板降级、HTML 转义。
- `navigation.js`：系统/组织/项目菜单、项目菜单分组、页面标题与菜单说明、视角切换逻辑。
- `labels.js`：状态色、对象状态中文名、授权角色名、模型能力标签、执行类别和模型决策摘要。
- `time-format.js`：服务器时钟偏差、时区标签、时间格式化、字节格式化、时长文本。
- `ui-config.js`：前端集合中文名、权限中文名、资源类型中文名、成员权限选项、语言选项、规则阈值和默认组织归属口径。
- `ui-primitives.js`：进度条、配额条、面板、表格行等低耦合 UI 基础件。
- `context-navigation.js`：管理空间选择、当前项目/任务组/任务持续上下文和对象级操作入口。
- `workspace-route.js`：系统、组织、项目、任务组、任务、成员与 Agent 档案的安全 URL 编解码及浏览器历史监听。
- `project-command-center.js`：项目当前主操作的状态优先级和单一操作区。
- `agent-profile-workspace.js`：Agent 档案表格、对象详情与编辑表单。
- `operational-stats.js`：按状态快照缓存的任务组运行、待审和受阻统计索引。
- `execution-object-workspace.js`：工作会话／Agent 派发对象头、关系链、调度决定、规则、事件、控制 ACK 与证据工作区。
- `monitor-workspace.js`：项目执行总览与任务组执行监控的范围对象头和关键运行指标。
- `runtime-node-workspace.js`：运行节点健康、调配边界、能力、活动派发、Agent 档案、控制命令与事件详情。
- `project-settings-workspace.js`：项目设置总览、操作看板、职责分区、生效流程和规则治理概览；主程序只装配当前项目状态与表单依赖。
- `task-group-insights.js`：任务组执行时间线、项目／任务组监控矩阵和任务组详情图形化阅读路径。
- `task-group-detail-workspace.js`：任务组事项、角色、配置、Skill、规则、控制、工作项、阻塞与协作记录的对象页模板；主程序只传入已加载快照和 helper。
- `monitor-dashboard-workspace.js`：项目／任务组范围内的会话、派发、节点、实时事件、模型决策、检查点、质量门、人工收口和关闭门监控视图。

`app.js` 从这些模块读取公共能力和对象级功能，保留历史会话状态、API、尚未拆出的页面渲染、弹窗、表单和事件装配。2026-09-06 继续迁移项目设置、任务组详情和完整监控模板后为 9,158 行。主文件已形成可持续迁移边界，但仍是兼容门面，不能宣称已经彻底拆完；后续新增功能不得回填已经划出的领域模块。

### 服务端公共模块

新增模块：

- `apps/control-plane-ui/lib/http-utils.mjs`：`json`、`jsonString`、`parseBody`。
- `apps/control-plane-ui/lib/static-assets.mjs`：静态资源安全路径、ETag、gzip、缓存和安全响应头。
- `apps/control-plane-ui/lib/collection-utils.mjs`：跨核心模块复用的集合去重等小型纯函数。
- `apps/control-plane-ui/lib/digest-utils.mjs`：稳定 JSON、深拷贝和 `sha256:` 内容摘要。
- `apps/control-plane-ui/lib/git-utils.mjs`：控制面 Git 子进程封装、墙钟超时、失败原因净化、编排周期 Git 事实缓存、状态路径解析。
- `apps/control-plane-ui/lib/path-policy.mjs`：Git 路径白名单、引用名安全、强制禁区、项目仓库读取口径和仓库 URL 规范化。
- `apps/control-plane-ui/lib/idempotency-records.mjs`：REST/MCP 共用幂等回执、过期正文清理和记录上限淘汰。
- `apps/control-plane-ui/lib/model-catalog.mjs`：模型供应商、默认模型、角色登记、角色能力提示、内置服务和 MCP 逻辑服务目录。
- `apps/control-plane-ui/lib/language-policy.mjs`：任务组语言策略、语言别名、语言策略下发指令。
- `apps/control-plane-ui/lib/skill-source-catalog.mjs`：默认 `DlenoDing/agency-agents-zh` skill 源、同步策略、覆盖层级和完整性要求。
- `apps/control-plane-ui/lib/management-surface-catalog.mjs`：系统管理系统与用户管理系统的默认界面分区、能力项和风险提示。
- `apps/control-plane-ui/lib/execution-object-detail.mjs`：会话／派发单对象的有界关联投影，不加载无限事件历史。
- `apps/control-plane-ui/lib/runtime-node-detail.mjs`：组织／项目作用域的运行节点详情投影，按项目过滤负载、命令、事件和档案。
- `apps/control-plane-ui/lib/command-bus.mjs`：Command、CommandEffect 与 DLQEntry 的完整状态机、超时清扫、重试、对账和人工死信处置。
- `apps/control-plane-ui/lib/runtime-issue-tracker.mjs`：运行问题样本／模式聚类、升级候选生成，以及外部维护结论向问题模式的终态传导；运行中只收集，不自改系统。

`server.mjs` 继续保留业务路由、鉴权、状态读写、MCP、实时通道和编排循环。
`control-plane-core.mjs` 继续作为兼容门面导出既有 Command Bus 与运行问题追踪符号，内部通过依赖注入装配领域模块。2026-09-06 两项迁移后核心门面为 8,328 行；调用方无须修改导入路径。

### 行为门同步

`scripts/console-behaviour-check.mjs` 已增加统一的控制台源码加载器：

- 浏览器加载：`i18n-zh.js` → 公共模块 → `app.js`。
- 行为门加载：同样顺序注入 VM。
- 被裁字段和顶层视图字段检查扫描浏览器实际加载的全部产品脚本，不再只扫描 `app.js`；拆出的模块读取仍受视图契约约束。
- Ruby 规范门与 Node 契约门从 `index.html` 解析真实前端脚本清单；表格截断、真人杠杆、提示目标、语言策略和状态字段检查不会因模板迁出 `app.js` 而失明。
- 核心容量、状态集合、错误码、i18n 和活性检查同时扫描兼容门面、`command-bus.mjs` 与 `runtime-issue-tracker.mjs`。
- 页面元数据扫描改读 `modules/navigation.js`，避免继续从 `app.js` 读取已经迁出的 `PAGE_META`。
- 权限、集合、默认组织、语言和资源类型扫描改读 `modules/ui-config.js`，避免继续从 `app.js` 读取已经迁出的界面配置。
- 执行角色清单扫描改读 `lib/model-catalog.mjs`，避免角色登记迁移后行为门空转。
- 契约检查的产品源码集合已纳入前端公共模块、服务端 HTTP/静态模块，避免 i18n、标签和静态资源检查漏扫。

## 当前模块边界

- 前端公共展示真相源在 `public/modules/`。
- 前端业务装配和页面渲染仍在 `public/app.js`。
- 服务端 HTTP 基础设施在 `lib/http-utils.mjs`、`lib/static-assets.mjs`。
- 服务端业务控制仍在 `server.mjs`。
- 核心摘要/深拷贝在 `lib/digest-utils.mjs`。
- 核心幂等回执在 `lib/idempotency-records.mjs`。
- 核心 Git 操作在 `lib/git-utils.mjs`。
- 核心路径/仓库策略在 `lib/path-policy.mjs`。
- 核心模型/角色目录在 `lib/model-catalog.mjs`。
- 核心语言策略在 `lib/language-policy.mjs`。
- 核心 skill 源目录在 `lib/skill-source-catalog.mjs`。
- 核心管理界面目录在 `lib/management-surface-catalog.mjs`。
- Command／CommandEffect／DLQ 状态机在 `lib/command-bus.mjs`，核心门面保留兼容导出。
- 运行问题收集与系统外升级候选在 `lib/runtime-issue-tracker.mjs`，模块本身没有运行时自升级动作。
- 核心 AI-native 编排规则仍在 `control-plane-core.mjs`，作为对外兼容门面暂时保留。

## 后续拆分约束

- 新增页面元数据必须改 `navigation.js`，不得在 `app.js` 另写标题或菜单说明。
- 新增状态、模型、角色或执行类别展示词必须优先改 `labels.js`。
- 新增时间/容量格式化逻辑必须优先改 `time-format.js`。
- 新增权限、资源类型、集合、语言选项、规则阈值或默认组织归属展示逻辑必须优先改 `ui-config.js`。
- 新增通用 DOM、剪贴板、HTML 转义逻辑必须优先改 `dom-utils.js`。
- 新增面板、进度、配额、基础表格行组件必须优先改 `ui-primitives.js`。
- 新增服务端 JSON 响应或请求体读取逻辑必须复用 `http-utils.mjs`。
- 新增静态资源响应逻辑必须复用 `static-assets.mjs`，不得在业务路由里另写一套路径拼接或缓存逻辑。
- 新增稳定摘要、稳定 JSON 或深拷贝逻辑必须优先改 `digest-utils.mjs`。
- 新增幂等回执重放、过期正文清理或记录上限逻辑必须优先改 `idempotency-records.mjs`。
- 新增 Git 子进程、Git 失败原因净化、HEAD/remote 查询或工作树状态解析逻辑必须优先改 `git-utils.mjs`。
- 新增 Git 路径、引用名、路径白名单、强制禁区、项目仓库读取或仓库 URL 规范化逻辑必须优先改 `path-policy.mjs`。
- 新增模型供应商、模型默认值、角色能力提示、执行角色登记，必须优先改 `model-catalog.mjs`。
- 新增任务组语言策略解析、语言别名、语言指令格式，必须优先改 `language-policy.mjs`。
- 新增默认 skill 源、同步策略、覆盖层级或完整性规则，必须优先改 `skill-source-catalog.mjs`。
- 新增管理界面默认分区、能力项或风险提示，必须优先改 `management-surface-catalog.mjs`。
- 拆核心编排文件时必须保持现有导出兼容，先迁移纯函数和常量，再迁移有副作用的状态推进函数。

## 验收

- 前端拆分后 `app.js` 行数下降，公共模块可以按功能独立查看。
- 服务端拆分后 `server.mjs` 去掉基础 HTTP 和静态资源重复实现。
- 行为门与真实浏览器加载顺序一致。
- 不引入新依赖，不引入构建步骤，不改变部署命令。
