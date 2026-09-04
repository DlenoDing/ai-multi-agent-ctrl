# 系统程序文件拆分审计与实施记录

审计时间：2026-09-04

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

`app.js` 现在只从这些模块读取公共能力，保留会话状态、API、页面渲染、弹窗、表单和事件装配。

### 服务端公共模块

新增模块：

- `apps/control-plane-ui/lib/http-utils.mjs`：`json`、`jsonString`、`parseBody`。
- `apps/control-plane-ui/lib/static-assets.mjs`：静态资源安全路径、ETag、gzip、缓存和安全响应头。
- `apps/control-plane-ui/lib/model-catalog.mjs`：模型供应商、默认模型、角色登记、角色能力提示、内置服务和 MCP 逻辑服务目录。
- `apps/control-plane-ui/lib/language-policy.mjs`：任务组语言策略、语言别名、语言策略下发指令。
- `apps/control-plane-ui/lib/skill-source-catalog.mjs`：默认 `DlenoDing/agency-agents-zh` skill 源、同步策略、覆盖层级和完整性要求。
- `apps/control-plane-ui/lib/management-surface-catalog.mjs`：系统管理系统与用户管理系统的默认界面分区、能力项和风险提示。

`server.mjs` 继续保留业务路由、鉴权、状态读写、MCP、实时通道和编排循环。
`control-plane-core.mjs` 继续作为兼容门面导出模型目录、语言策略、skill 源和管理界面目录相关符号，避免破坏现有调用方。

### 行为门同步

`scripts/console-behaviour-check.mjs` 已增加统一的控制台源码加载器：

- 浏览器加载：`i18n-zh.js` → 公共模块 → `app.js`。
- 行为门加载：同样顺序注入 VM。
- 页面元数据扫描改读 `modules/navigation.js`，避免继续从 `app.js` 读取已经迁出的 `PAGE_META`。
- 权限、集合、默认组织、语言和资源类型扫描改读 `modules/ui-config.js`，避免继续从 `app.js` 读取已经迁出的界面配置。
- 执行角色清单扫描改读 `lib/model-catalog.mjs`，避免角色登记迁移后行为门空转。
- 契约检查的产品源码集合已纳入前端公共模块、服务端 HTTP/静态模块，避免 i18n、标签和静态资源检查漏扫。

## 当前模块边界

- 前端公共展示真相源在 `public/modules/`。
- 前端业务装配和页面渲染仍在 `public/app.js`。
- 服务端 HTTP 基础设施在 `lib/http-utils.mjs`、`lib/static-assets.mjs`。
- 服务端业务控制仍在 `server.mjs`。
- 核心模型/角色目录在 `lib/model-catalog.mjs`。
- 核心语言策略在 `lib/language-policy.mjs`。
- 核心 skill 源目录在 `lib/skill-source-catalog.mjs`。
- 核心管理界面目录在 `lib/management-surface-catalog.mjs`。
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
