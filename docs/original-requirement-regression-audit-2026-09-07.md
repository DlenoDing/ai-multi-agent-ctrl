# 初始需求回归检查与修复记录（2026-09-07）

## 检查范围

本轮按最初设计文档、后续 AI-native 修订要求、控制面规格、Agent Runtime 协议和当前代码实现逐项对齐，重点检查多轮 UI 与模块拆分过程中是否丢失功能入口或执行闭环。

已核对的核心需求：

1. AI-native 执行：总控、调度、角色会话、实时回送、纠偏和检查点由 AI Agent 执行；人工只保留后台管理、入口总控、审核和定稿。
2. 集中式服务：MCP 服务运行在系统服务器，Agent 端只运行轻量 Runtime，通过一次性 join token 注册、心跳、自检、长轮询和事件回送与服务端交互。
3. Skill 来源：服务端可同步 `DlenoDing/agency-agents-zh`，项目和任务组可覆盖角色 skill，派发时下发最小 Skill 工作集。
4. 模型选择：派发必须显式指定 `model`、`reasoning`、`modelDecision`；不使用固定 profile 表作为派发依据。
5. 管理层级：系统管理只管组织、初始组织管理员、配额、启停、系统能力和审计；组织管理管成员、组织级 Agent 和项目；项目管理管项目成员、项目 Agent、任务组、任务、审核、指令和监控。
6. 运行期问题策略：系统运行时只收集重复问题并形成升级候选，不自动修改系统；真正升级必须在系统外独立完成，再由系统管理员导入和激活。
7. 进度与实时性：项目、任务组、任务、派发、工作会话和执行事件均有实时或准实时观察入口；Agent 执行过程中持续回送事件，不等完成后才回送。
8. 产出归属：任务产出写入对应项目 Git 仓库，不另建控制面文件管理系统。
9. 公共定义：跨子系统共享语义、接口、规则、错误码和质量标准由 `SharedDefinitionContract` 指定归属与生产角色。

## 发现的功能回归

### 系统外升级结果导入缺少管理闭环

需求要求运行时问题“收集但不自改”，后续由人在线下或系统外完成升级，再通过系统管理导入升级结果。当前实现中：

1. MCP 层已有 `governance-mcp.system_upgrade_external_import`。
2. 设计文档要求系统管理支持“系统外升级结果导入”。
3. 但控制台服务没有 `POST /api/system-upgrade-candidates/import-external-result` REST 路由。
4. 系统管理界面没有外部升级导入表单和导入记录页。
5. `docs/core-control-plane-spec.md` 仍把该路由标为后续扩展，`scripts/contract-check.mjs` 也把它登记为可缺失接口。

这会造成：运行时问题可以被采集和导出，但系统外维护完成后没有后台管理入口登记结果，功能链路在“回填”阶段断开。

### MCP 与 REST 的真人专属边界不对等

系统外升级结果导入属于系统管理动作，必须由真人系统管理员执行。补上 REST 入口后，`human-only-parity-gate` 继续发现 MCP 同名工具仍可由机器主体进入。若不修复，服务令牌或 Agent 节点可绕过管理界面导入升级记录，破坏“运行时只收集问题、不进行系统升级”的边界。

## 已完成修复

1. 新增系统管理员 REST 入口 `POST /api/system-upgrade-candidates/import-external-result`。
2. 新动作 `system_upgrade_external_import` 已加入真人专属写动作清单，权限要求为 `system:*`。
3. 导入记录写入 `state.externalUpgradeImports`，最多保留 2000 条。
4. 导入记录固定包含：
   - `schemaVersion: external-upgrade-import/v1`
   - `status: imported_pending_admin_activation`
   - `forbidsActiveRuntimeSelfMutation: true`
   - `packageRef`
   - `evidenceRefs`
   - `createdAt`
5. 系统管理 → 平台能力新增“外部升级导入”独立栏目。
6. 系统设置总览、操作看板和治理流程新增外部升级入口与导入数量。
7. 新增导入表单和导入记录台账展示。
8. 中文错误码、审计动作和集合标签已补齐。
9. `docs/core-control-plane-spec.md` 不再把导入路由标为后续项。
10. `scripts/contract-check.mjs` 不再允许该路由缺失。
11. `scripts/console-behaviour-check.mjs` 新增系统导航和 UI 表单断言，防止入口再次被删掉。
12. `governance-mcp.system_upgrade_external_import` 增加白名单式真人系统管理员守卫，机器主体统一返回 `system_upgrade_external_import_forbidden_for_machine_principal`。
13. `scripts/lib/known-second-doors.mjs` 与 `scripts/contract-check.mjs` 增加该 MCP 第二道门登记，防止 REST/MCP 同权边界再次漂移。

## 当前结论

本轮发现的明确回归已修复。其余核心链路在代码中仍可找到对应实现和校验：

1. Agent 注册、心跳、自检、长轮询控制、执行事件回送和 checkpoint 提交通道仍存在。
2. 项目与组织级 Agent 档案、运行节点、join token 和安装脚本入口仍存在。
3. 任务组语言策略、指令信封、模型决策、共享定义和仓库产出目标仍存在。
4. 项目/任务组/任务/派发/会话/事件监控入口仍存在。
5. 运行期问题仍为 collect-only，真正升级仍在系统外完成。

后续若再做 UI 或模块拆分，应先运行 `npm run validate`。其中 `node scripts/contract-check.mjs` 会检查文档接口是否真实存在，`node scripts/console-behaviour-check.mjs` 会检查系统管理入口是否再次漂移。
