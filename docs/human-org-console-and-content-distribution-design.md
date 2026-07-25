# 人机协同、组织化管理与内容分发设计（可执行版）

版本：human-org-console/v1
状态：已批准，可执行
关联文档：`docs/multi-agent-project-orchestration-system-design.md`（总设计）、`docs/core-control-plane-spec.md`（核心规格）、`docs/agent-runtime-protocol.md`（运行时协议）、`docs/runtime-management-ui-and-repository-output.md`（运行管理界面）

本文件对以下八个能力域给出可直接实施的设计，凡与既有文档冲突之处，以本文件为准：

1. 人工审核节点（任务组内收集需人工确认的问题，AI 给出可选项 + 强制"不选择"，由人工确认）
2. 人工指令独立通道（总控/调度会话不接受人工直接输入）
3. Agent 主机统一会话文件根地址与层级隔离
4. 双规则体系（角色规则 / 业务规则）与执行内容包分发（长期公共 / 任务临时）
5. 组织模型与配额（系统管理员 → 组织超管 → 组织成员三级）
6. 组织资源管理（成员 / AI-Agent / 项目）
7. 项目视图与任务组配置继承（默认角色、技能规则、自动加入角色）
8. 事项分解与执行回写；全中文管理界面信息架构

---

## 1. 组织与账号模型

### 1.1 数据模型

新增顶层集合 `organizations`（中央状态，非项目分片）：

```json
{
  "schemaVersion": "organization/v1",
  "orgId": "org_xxx",
  "name": "示例组织",
  "status": "active | suspended",
  "quotas": {
    "maxMembers": 50,
    "maxProjects": 20,
    "maxTaskGroups": 200,
    "maxAgents": 100
  },
  "usage": {
    "members": 0, "projects": 0, "taskGroups": 0, "agents": 0
  },
  "initialAdminAccountId": "acct_xxx",
  "createdBy": "acct_system_owner",
  "createdAt": "...", "updatedAt": "..."
}
```

账号（`account/v1` 扩展，向后兼容）：

| 字段 | 说明 |
|---|---|
| `accountType` | `system_admin`（系统管理员，不属于任何组织）/ `org_admin`（组织管理员）/ `user_account`（组织成员）/ `service_account` |
| `organizationId` | `org_admin` 与 `user_account` 必填；`system_admin`/`service_account` 为空 |
| `authPolicy.method` | 新增 `password`；成员登录后可改密码 |
| `passwordDigest` | `sha256(account-password:<accountId>:<password>)`，仅 `password` 方式使用 |
| `defaultProjectId` | 成员登录后的默认项目 |

**归属与迁移**：存量数据自动迁移到默认组织 `org_default`（名称"默认组织"，配额取环境默认），存量 `system_admin` 保持系统级，存量项目 / agents / 节点全部打上 `organizationId: "org_default"`。迁移在 `ensureRuntimeCollections` 内幂等完成。

### 1.2 三级职责边界

| 角色 | 能做 | 不能做 |
|---|---|---|
| 系统管理员 | 组织 CRUD、为每个组织签发**一个**初始超管账号、设置组织配额、查看系统概览（服务器信息、进程资源、状态库体量、能耗估算、运行指标、审计链） | 不直接管理组织内成员/项目/任务组（只读可见用于支持排障） |
| 组织管理员 | 组织内成员账号创建与权限分配、AI-Agent 管理（加入令牌、吊销、控制）、项目创建与基础配置、查看组织用量与配额 | 跨组织任何操作；修改自身组织配额 |
| 组织成员 | 按分配权限操作：进入默认项目、顶部切换有权限的项目、项目内任务组/人工审核/执行监控等 | 组织级管理（除非被授予）|

### 1.3 配额强制

创建成员 / 项目 / 任务组 / Agent（加入令牌签发即计数预占，注册成功落实）时校验 `usage.<x> < quotas.max<X>`，超限返回 `409 org_quota_exceeded`，响应带 `{quota, usage}`。`usage` 由控制面在对应创建/删除/吊销路径同步维护，`ensureRuntimeCollections` 定期按实际集合重算纠偏。

### 1.4 API 清单（系统管理域，均需 `system:*`）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/orgs` | 创建组织 + 初始超管账号（一次性返回超管登录令牌） |
| GET | `/api/orgs` | 组织列表（含配额与用量） |
| POST | `/api/orgs/:orgId/quotas` | 更新配额 |
| POST | `/api/orgs/:orgId/status` | 启用/停用组织 |
| GET | `/api/system/overview` | 系统概览：进程 CPU/内存、状态库大小、事件库大小、在线节点数、24h 请求/写入计数、能耗估算（`功率系数×CPU时间`，系数可配 `AIMAC_ENERGY_WATTS_PER_CPU`）、Node 版本、主机信息 |

组织管理域（需 `org:admin`，隐含于 `org_admin`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/org/members` | 创建成员（分配权限集合，返回一次性登录令牌） |
| POST | `/api/org/members/:id/permissions` | 调整成员权限 |
| POST | `/api/org/members/:id/status` | 停用/启用成员 |
| POST | `/api/auth/change-password` | 本人改密（任何已登录账号） |
| GET | `/api/org/agents` | 组织 Agent 列表（见 §6.2 展示字段） |
| POST | `/api/org/projects` | 创建项目（组织范围，校验配额） |

既有 `/api/accounts`、`/api/projects` 保留兼容，但内部按组织边界过滤与校验。

---

## 2. 人工审核节点（HumanConfirmationRequest）

### 2.1 原则

- 任务执行过程中任何需要人工确认的决策，**不允许**由执行会话直接向人索要输入；必须提交为结构化"人工确认请求"，由控制台的"人工审核"页面集中呈现，由人专门确认。
- 每个待确认问题必须携带 **AI 给出的可选项（≥1 个）**；系统**强制追加**一个 `none`（"不选择/自定义"）选项；人工可选择任一选项，并且**必须/可以**输入确认内容文本（选 `none` 时必填）。

### 2.2 数据模型（项目分片集合 `humanConfirmationRequests`）

```json
{
  "schemaVersion": "human-confirmation-request/v1",
  "requestId": "hcr_xxx",
  "projectId": "...", "taskGroupId": "...", "workItemId": "...",
  "sessionId": "...", "dispatchId": "...", "nodeId": "...",
  "question": {"summary": "≤300字", "detail": "≤4000字", "evidenceRefs": ["..."]},
  "options": [
    {"optionId": "opt_1", "label": "...", "description": "...", "recommended": true},
    {"optionId": "none", "label": "不选择（自定义输入）", "system": true}
  ],
  "blocking": true,
  "status": "pending | answered | consumed | expired | cancelled",
  "decision": {
    "selectedOptionId": "opt_1 | none",
    "inputText": "人工输入的确认内容",
    "decidedBy": "acct_xxx", "decidedAt": "..."
  },
  "expiresAt": "...", "createdAt": "...", "updatedAt": "..."
}
```

状态机：`pending → answered →（执行方读取后）consumed`；`pending → expired | cancelled`。`options` 提交时若缺少 `none` 由服务端自动补齐；`selectedOptionId=none` 时 `inputText` 必填。

### 2.3 阻塞语义

- `blocking=true` 的请求创建时：对应 dispatch → `blocked/awaiting_human_confirmation`，session → 同理；任务组健康 → `attention`。
- 人工作答后：dispatch 重新入队（`queued`），执行方通过 §4 内容包或 MCP 读取 `decision` 继续。
- 完成度门禁新增 `no_pending_human_confirmations`（readiness 与 close barrier 同步加入，按真实集合计算）。

### 2.4 接口

- MCP（agent 默认授权组新增）：`human-review-mcp.confirmation_request_submit` / `confirmation_status` / `confirmation_consume`
- 网关 HTTP（节点侧）：`POST /api/agent/v1/confirmations`、`GET /api/agent/v1/confirmations/:id`
- 控制台 HTTP：`GET /api/task-groups/:id/human-confirmations`、`POST /api/human-confirmations/:id/decide`（权限 `task_group:review` 或项目负责人）

---

## 3. 人工指令独立通道（HumanDirective）

### 3.1 原则

任务总控（orchestrator）与调度类会话**不开放**人工直接输入。人工要对系统下达操作，一律通过独立的"人工指令"通道：控制台专页输入 → 生成结构化指令记录 → 由编排周期作为**决策输入**消费并执行，全程留审计。

### 3.2 数据模型（项目分片集合 `humanDirectives`）

```json
{
  "schemaVersion": "human-directive/v1",
  "directiveId": "hd_xxx",
  "projectId": "...", "taskGroupId": "...",
  "directiveType": "pause | resume | cancel | adjust_priority | add_requirement | free_text",
  "instruction": "人工输入的原文（≤4000字）",
  "issuedBy": "acct_xxx",
  "status": "queued | acknowledged | applied | rejected",
  "appliedActions": [{"action": "task_group_pause", "ref": "..."}],
  "rejectReason": "...",
  "createdAt": "...", "updatedAt": "..."
}
```

### 3.3 消费流程

1. `POST /api/human-directives`（权限 `task_group:control`）→ `queued`。
2. `runAutonomousCycle` 开头消费：结构化类型直接映射为既有控制动作（pause/resume/cancel → 任务组控制；add_requirement → 追加 workItem 需求）并记 `appliedActions`；`free_text` 转为一条 `pending` 的人工确认逆向澄清或作为编排上下文写入 `taskGroup.humanGuidance`（追加，不覆盖）。
3. 每次状态迁移写审计（哈希链）。指令绝不直接注入执行会话的 prompt；只影响控制面状态与后续签发的契约内容。

---

## 4. Agent 主机文件布局与内容分发

### 4.1 统一会话文件根地址（按操作系统）

| OS | 根地址（`AIMAC_AGENT_DATA_ROOT` 可覆盖） |
|---|---|
| linux | `~/.local/share/aimac-agent` |
| darwin | `~/Library/Application Support/aimac-agent` |
| win32 | `%LOCALAPPDATA%\aimac-agent` |

同一 OS 的所有 Agent 主机路径完全一致；bootstrap 时按 `platform()` 自动决定，注册时上报 `profile.dataRoot` 供控制台展示。

### 4.2 层级隔离

```
<root>/
  bin/                                   # 运行时程序
  agent-config.json                      # 节点凭证配置（0600）
  library/                               # 长期公共内容（跨任务保留）
    skills/<contentDigest>/SKILL.md      # digest 寻址，天然去重与校验
    docs/<contentDigest>/<name>
  orgs/<orgId>/
    projects/<projectId>/
      repository/                        # 项目 git 仓库检出（长期，随项目）
      task-groups/<taskGroupId>/
        sessions/<sessionId>/            # 任务临时（会话工作目录、内容包、提示词）
          bundle/                        # 本次执行内容包解包处
          workspace/
  outbox/                                # checkpoint 待重放（沿用现有）
```

隔离规则：不同项目/任务组/会话之间只能通过各自 id 目录访问自己的内容；运行时写文件前必须校验目标路径落在本会话目录或 library（路径前缀 + `..` 拒绝，沿用现有 `inside()` 检查）。

### 4.3 清理策略

- `sessions/<sessionId>/`：dispatch 达终态（checkpoint 已受理 / failed / cancelled）后由运行时**自动删除**；异常残留由运行时启动时按 `mtime > AIMAC_AGENT_SESSION_TTL_HOURS`（默认 72h）清扫。
- `library/`：digest 寻址长期保留；LRU 清理阈值 `AIMAC_AGENT_LIBRARY_MAX_MB`（默认 2048）。
- `projects/<id>/repository/`：长期保留，项目在控制面删除后由 revoke/shutdown 流程提示清理。

### 4.4 双规则体系

| 类型 | 定义 | 存储 | 作用 |
|---|---|---|---|
| 角色规则（roleSkill） | 会话身份定义："你是谁、职责边界、禁区"（对应 agency-agents-zh 角色） | 既有 `roleSkills` + 项目/任务组默认角色配置 | 契约 `roleSkill` 引用，内容包 `role` 分类下发 |
| 业务规则（businessRule） | 项目/任务组的业务约束："必须怎么做、验收标准、领域规范" | **v1 实现**：内联于 `project.config.businessRules` / `taskGroup.configOverrides.businessRules`（`{ruleId?, title, content}` 数组，随项目/任务组分片落盘），经 `effectiveTaskGroupConfig` 合并；独立分片集合 `businessRules`（含 contentDigest/retention/status）为后续演进项 | 内容包 `business` 分类下发（`buildExecutionContentBundle`）；契约通过内容包摘要绑定 |

约束不靠指令原文传达：契约与提示词只携带**引用与摘要**，正文一律走内容包（见 4.5）。执行会话在开始前必须完成内容包同步校验，摘要不符即拒绝执行（`content_bundle_digest_mismatch`）。

### 4.5 执行内容包（ExecutionContentBundle）

沿既有 skill workset 机制扩展为统一内容包，会话启动前一次性同步：

```json
{
  "schemaVersion": "execution-content-bundle/v1",
  "bundleId": "ecb_xxx",
  "bundleDigest": "sha256:...",
  "projectId": "...", "taskGroupId": "...", "sessionId": "...",
  "entries": [
    {"path": "role/SKILL.md",        "category": "role",     "retention": "durable", "contentDigest": "sha256:..."},
    {"path": "business/rules.md",    "category": "business", "retention": "durable", "contentDigest": "sha256:..."},
    {"path": "task/context.md",      "category": "task",     "retention": "task",    "contentDigest": "sha256:..."},
    {"path": "task/confirmations.json", "category": "task",  "retention": "task",    "contentDigest": "sha256:..."}
  ],
  "gitTransfer": {"enabled": true, "repositoryUrl": "...", "ref": "...", "paths": ["docs/**"]}
}
```

分发规则：

1. **系统能力优先**：内容包经网关 `GET /api/agent/v1/content-bundles/:sessionId` 下载（含正文），不通过指令文本传递。**v1 实现**：全部条目走内容包正文内联下发并逐条摘要校验；`gitTransfer` 字段由网关产出、作为大文件走既有 git 仓库通道的**预留能力**，运行时暂未消费（后续演进：条目声明 `gitTransfer` 时由运行时 `git fetch` 拉取，跳过正文内联）。
2. **归档规则**：`retention=durable` 条目按 `contentDigest` 存入 `library/`（已存在则跳过下载，实现增量同步）；`retention=task` 条目存入会话目录 `bundle/`，随会话清理自动删除。
3. **隔离**：条目 `path` 只允许相对路径且解包目标限定在会话 `bundle/` 或 `library/` 内。
4. 内容包由**派发包**携带下载地址（`remoteServices.contentBundlePath`），不冻结进契约——因为内容包包含"已答人工确认"等随执行推进而变化的任务态内容，契约级摘要冻结会造成必然失配。运行时校验每个条目摘要后方可启动执行器（下载失败或摘要不符即终止执行并上报失败）；执行器通过环境变量 `AIMAC_CONTENT_BUNDLE_DIR` 获得解包目录。

---

## 5. 项目与任务组配置继承

### 5.1 项目配置（`project.config`）

```json
{
  "repositories": [{"id": "...", "url": "...", "defaultBranch": "main", "credentialSecretRef": "env:AIMAC_REPO_TOKEN_xxx"}],
  "baselineData": [{"name": "...", "locator": "git:docs/baseline/...", "digest": "sha256:..."}],
  "businessRuleRefs": ["br_xxx"],
  "defaultRoles": [
    {"roleId": "orchestrator", "roleSkillRef": "rs_xxx", "skillRuleOverride": null},
    {"roleId": "backend-developer", "roleSkillRef": "rs_yyy", "skillRuleOverride": "br_zzz"}
  ]
}
```

仓库访问凭证只存**引用**（环境变量名 / 秘钥管理地址），状态库不落明文。

### 5.2 任务组继承与覆盖

- 任务组默认 `configSource: "inherited"`，读取时实时合并项目配置。
- 修改任何项即生成 `taskGroup.configOverrides`（仅存差异），`configSource: "customized"`。
- `POST /api/task-groups/:id/config/reset` 删除 overrides，回到继承。
- **自动加入角色**：执行中需要新角色时，调度从基础角色库（agency-agents-zh 同步结果）选取，追加进 `taskGroup.roles`，标记 `addedBy: "auto"`（用户添加为 `"user"`，继承为 `"inherited"`），UI 以"自动加入"徽标展示。

### 5.3 事项分解（taskAnalysis）

任务组执行前，编排先生成完整事项清单（目的：让用户看清要做什么；与执行顺序无关）：

```json
{
  "schemaVersion": "task-analysis/v1",
  "taskGroupId": "...",
  "items": [
    {"itemId": "ta_1", "title": "大项标题", "kind": "major",
     "children": [{"itemId": "ta_1_1", "title": "小项", "kind": "minor", "workItemRefs": ["work_x"]}]}
  ],
  "generatedBy": "orchestrator", "generatedAt": "..."
}
```

执行回写：workItem 状态/进度/说明变化时，同步聚合到关联事项（`status`：待执行/执行中/已完成/受阻，`progress`，`note` 取最近一次执行事件摘要）。事项清单展示顺序 = 分析顺序，**与调度并行/串行顺序无关**。

---

## 6. 中文管理界面信息架构

### 6.1 总原则

- 面向人的页面完全中文：菜单、模块标题、字段名、状态、按钮、提示；系统内部标识保持英文，通过**映射字典**（`statusLabels`）渲染，杜绝英文裸露。
- 布局遵循中文管理后台习惯：左侧菜单 + 顶部栏（组织/项目切换、账号）；列表页"筛选区-表格-详情抽屉"；重要状态用色徽标（绿=正常、蓝=进行中、橙=需关注、红=失败/阻塞、灰=停用）。
- 危险操作二次确认；表格支持关键字过滤；时间显示本地时区"YYYY-MM-DD HH:mm"。

### 6.2 三种视角菜单树

**系统管理员**
- 系统概览（服务器信息、进程资源、能耗估算、状态库/事件库体量、在线节点、审计链校验状态）
- 组织管理（列表：名称/状态/配额/用量；创建组织=组织信息+初始超管账号，一次性令牌展示）
- 系统设置（运行参数只读展示、模型能力注册）

**组织管理员**
- 组织概览（配额用量、活跃项目/任务组统计）
- 成员管理（创建成员、权限分配、停用；成员登录令牌一次性展示）
- AI 智能体（列表/卡片双视图。默认列显示：名称、运行状态、地区、健康度、当前任务；悬浮显示：资源（CPU/内存/磁盘）、支持模型、网络速度、累计完成/失败、数据根路径。操作：签发加入令牌、暂停/恢复/吊销）
- 项目管理（创建、基础配置、成员授权）

**组织成员**（登录进默认项目，顶栏项目切换器，全页面为所选项目范围）
- 项目概览（进度、健康、事项完成度、待人工确认数）
- 任务组（列表 → 详情：事项清单（大项/小项+状态回写）、角色（含"自动加入"标识）、配置（继承/自定义/重置）、执行控制）
- 人工审核（待确认问题列表：问题、AI 选项单选 + "不选择（自定义输入）"、确认输入框、提交；历史已答列表）
- 人工指令（指令输入 + 类型选择；指令流水与执行结果）
- 执行监控（会话/派发/执行事件流，中文状态）
- 项目设置（仓库与凭证引用、基线数据、业务规则、默认角色与技能规则——按权限显示）

### 6.3 中英映射字典（节选，实施时置于 `public/i18n-zh.js`，全量覆盖所有出现的枚举）

| 内部值 | 展示 |
|---|---|
| queued / running / blocked / completed / failed / cancelled | 排队中 / 执行中 / 受阻 / 已完成 / 失败 / 已取消 |
| online / offline / degraded / draining / revoked / initializing | 在线 / 离线 / 降级 / 撤出中 / 已吊销 / 初始化中 |
| pending / answered / consumed / expired | 待确认 / 已确认 / 已采纳 / 已过期 |
| review_requested / review_passed / verified / superseded | 待评审 / 评审通过 / 已验证 / 已拆分替代 |
| active / attention / ok | 进行中 / 需关注 / 正常 |
| clear / blocked（readiness） | 可关闭 / 存在阻塞 |

未映射值兜底显示原文并在控制台告警（开发期发现遗漏）。

---

## 7. 完成度门禁与状态机增量

- readiness 检查项新增：`no_pending_human_confirmations`、`no_pending_human_directives`。
- close barrier 门新增同名两项，按真实集合计算。
- WorkSession/AgentDispatch 阻塞原因新增 `awaiting_human_confirmation`。
- 新 schema：`spec/human-confirmation-request.schema.json`、`spec/human-directive.schema.json`、`spec/organization.schema.json`、`spec/execution-content-bundle.schema.json`、`spec/task-analysis.schema.json`。

---

## 8. 迁移与验证

1. **迁移**：`ensureRuntimeCollections` 幂等创建 `org_default` 并为存量账号/项目/节点补 `organizationId`；不改变现有登录方式；doctor 全链路保持通过。
2. **验证扩展**：
   - contract-check：人工确认请求强制含 `none` 选项；配额超限 409；内容包条目摘要校验；任务组配置 reset 后与项目一致。
   - doctor：新增"创建组织→初始超管登录→建成员→建项目→提交人工确认→作答→dispatch 恢复"链路断言。
3. **实施顺序**：
   ① 组织/账号/配额（core + server + seed 迁移）→ ② 人工确认 + 人工指令（core/gateway/MCP/server + 门禁）→ ③ 内容包 + 文件布局（runtime + gateway + 契约字段）→ ④ 项目/任务组配置继承 + 事项分解 → ⑤ 中文控制台整体重写（i18n 字典 + 三视角 IA）→ ⑥ schema/doctor/contract-check 扩展。
