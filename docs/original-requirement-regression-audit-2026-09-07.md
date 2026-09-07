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

### checkpoint 证据 schema 在运行时没有落到入口

原始 AI-native 要求强调“机器可执行制品优先”，尤其是任务产出必须写入项目 Git 仓库，并由 checkpoint 证据闭环进入总控和审核。当前实现已有大量手写校验，也有 `spec/checkpoint.schema.json` 引用 `commit-ref` 与 `push-ref`，但运行入口在归一化后没有对最终落库 checkpoint 跑 schema：

1. `commitRefs`、`pushRefs` 由调用方对象展开后再补写核心字段，额外字段可能被一起落库。
2. `commit-ref.schema.json` 与 `push-ref.schema.json` 的 `additionalProperties:false` 因此只在事后扫产物时生效，不能在接受入口形成稳定边界。
3. `docs/machine-executable-artifacts.md` 仍写着 commit/push 引用没有消费者，已与当前 validator 和入口职责不一致。

这类问题不一定立刻导致执行失败，但会让机器契约从“运行时强制”退化成“事后发现”，容易在多轮修改中再次漂移。

### 主动告警仍停在设计文本里

最初设计明确要求系统必须内置主动告警，不只是提供看板，至少覆盖 Agent 心跳中断、DLQ 增长、outbox backlog、lease 长期未释放、磁盘水位、DB 连接耗尽、Artifact 写入失败、备份失败、错误率突增和模型/工具连续限流，并且告警要有 owner、severity、静默窗口、升级策略、处理记录和关闭证据。当前实现中：

1. `spec/state-machines.yaml` 已登记 `Alert` 状态机，`spec/terminal-execution-manifest.yaml` 已把 `Alert` 当终态执行对象列入清单。
2. 主设计文档仍要求 `alert_rules` 和 `alerts` 数据表。
3. `scripts/barrier-liveness-gate.mjs` 却把 `Alert` 登记为“告警子系统尚未实现，没有任何代码产生 Alert 对象”。
4. 运行时没有 `state.alertRules` / `state.alerts` 集合，也没有规格文件、分片持久化、租户过滤和监控界面。

这会造成：监控页能显示已有事件、派发、会话和关闭门禁，但对服务端可主动判定的运行异常没有稳定对象，总控和监测角色只能从别的表里间接推断，需求中的“主动告警”实际丢失。

### IntegrationBatch 控制对象被声明但没有生产路径

最初设计要求多会话并行产物必须经 `ChangeSet -> MergeQueueItem -> IntegrationBatch` 进入主线，并在批次内完成 rebase、batch CI、冲突处理、release manifest、merge / rollback / abort。当前实现中：

1. `spec/terminal-execution-manifest.yaml` 与 `spec/state-machines.yaml` 已把 `IntegrationBatch` 登记为终态执行控制对象。
2. 主设计文档和核心控制面规格多处要求并行 ChangeSet 合入前必须进入 `IntegrationBatch`。
3. 运行时集合 `state.integrationBatches` 已声明，但服务端和 MCP 投影都把它清空。
4. 没有 `spec/integration-batch.schema.json`，也没有 `createIntegrationBatch` / `advanceIntegrationBatch` 生产和推进函数。
5. `docs/core-control-plane-spec.md` 与 `scripts/contract-check.mjs` 仍把 `/api/integration-batches` 标为未实现。
6. 任务组关闭门没有检查未终态集成批次。

这会造成：并行任务可以有执行拓扑和分支回报，但并行产物进入主线的批量集成过程没有权威对象承接；最坏情况下任务组可能在批次集成、批量 CI 或冲突处理尚未完成时被误判为可关闭。

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
14. `acceptAgentCheckpoint` 在落库前校验完整 `spec/checkpoint.schema.json`，使 `commit-ref`、`push-ref` 的 `$ref` 与 `additionalProperties:false` 在运行入口生效。
15. checkpoint 证据归一化改为白名单字段写入，执行方额外字段不会进入 `commitRefs` 或 `pushRefs`。
16. `spec/push-ref.schema.json` 补齐远端分支已前进但仍包含本次提交时由控制面写入的 `remoteAdvancedContained` 与 `observedRemoteSha` 字段。
17. `scripts/contract-check.mjs` 增加“额外字段不污染 checkpoint 证据”的回归断言。
18. `docs/machine-executable-artifacts.md` 已更正 checkpoint、commit-ref、push-ref 的消费者说明。
19. 主设计文档和 README 中残留的“Agent 侧本地库增量镜像”已改为“Agent 端仅保留运行配置、缓存和 outbox，不承载项目数据库服务或权威数据镜像”。
20. 主设计文档和自治范围文档中容易被误解为运行期自动改规则的“规则沉淀”口径已收敛为“规则候选收集、来源解析、互审、系统外升级导入和版本治理”；系统级重复问题只能形成 `RuntimeIssuePattern`、`SystemUpgradeCandidate` 和系统外升级证据包。
21. 新增 `spec/alert-rule.schema.json` 和 `spec/alert.schema.json`，告警规则与告警实例均有 schemaVersion、负责人、等级、路由、升级策略、处理记录和关闭证据字段。
22. `ensureRuntimeCollections` 初始化默认告警规则；`reconcileAlerts` 在服务端自治周期内发现心跳超期、活跃 DLQ 和自治周期连续失败，按 dedupeKey 去重生成 `Alert.routed`，条件解除后自动转为 `Alert.resolved` 并写入 `resolutionEvidenceRefs`。
23. 告警变化写入事件流 `alert_raised` / `alert_resolved`，满足总控、监控角色和用户界面的准实时观察要求。
24. `alertRules` / `alerts` 纳入项目分片持久化集合，项目级告警随项目分片隔离；活跃规则和非终态告警不会被容量裁剪误删。
25. `scopedStateForAccount` 与 `tasks/runtime` 视图已下发过滤后的告警；任务组、项目、组织和系统级告警按可见范围过滤，避免跨组织泄漏。
26. 执行监控页新增“主动告警”看板卡片和明细表，活跃告警不再被隐藏在事件/死信/节点表里。
27. `scripts/barrier-liveness-gate.mjs` 撤销 `Alert` 未实现豁免，状态机活性门会要求告警对象真实产生并可终结。
28. `scripts/contract-check.mjs` 增加主动告警生产、去重、关闭证据和终态回收断言；`scripts/mutation-gate.mjs` 增加对应变异。
29. 新增 `spec/integration-batch.schema.json`，覆盖批次 id、项目/任务组归属、ChangeSet refs、baseline commit、rebase / conflict / batch CI / release manifest / merge / rollback / abort 证据字段。
30. 新增 `createIntegrationBatch` 与 `advanceIntegrationBatch`，按 `spec/state-machines.yaml` 的 `IntegrationBatch` 状态机推进，所有状态变更写入 `TransitionEvidence`，并在落库前运行 schema 校验。
31. 新增 REST 路由 `POST /api/integration-batches` 与 `POST /api/integration-batches/:batchId/advance`，走幂等、权限和任务组作用域守卫，推进后即时重算关闭门。
32. 新增 MCP 工具 `scheduler-mcp.integration_batch_create` 与 `scheduler-mcp.integration_batch_advance`，`advance` 先按 batch 反查任务组再做 bounded principal 作用域校验。
33. `integrationBatches` 纳入项目分片持久化；未终态批次不会被容量裁剪误删，且控制台/MCP 只下发可见任务组内的批次。
34. 任务组完成就绪与关闭门均新增未终态集成批次阻塞，`CloseBarrier` schema、中文词表和关闭门处置指引同步更新。
35. `docs/core-control-plane-spec.md` 不再把 `/api/integration-batches` 标为未实现，并补充批次推进路由。
36. `scripts/contract-check.mjs` 增加集成批次生命周期断言：未终态阻塞、happy path merged、冲突重试、CI 失败重试、rollback、abort、缺证据拒绝；`scripts/mutation-gate.mjs` 更新接口存在性锚点。

## 当前结论

本轮发现的明确回归已修复。其余核心链路在代码中仍可找到对应实现和校验：

1. Agent 注册、心跳、自检、长轮询控制、执行事件回送和 checkpoint 提交通道仍存在。
2. 项目与组织级 Agent 档案、运行节点、join token 和安装脚本入口仍存在。
3. 任务组语言策略、指令信封、模型决策、共享定义和仓库产出目标仍存在。
4. 项目/任务组/任务/派发/会话/事件监控入口仍存在。
5. 运行期问题仍为 collect-only，真正升级仍在系统外完成。
6. 文档基线不再要求或暗示 Agent 本地承载项目数据库镜像，避免后续实现把服务性组件下沉到 Agent 端。
7. 主动告警已从“设计已写、代码未产出”修复为运行时对象、事件流、项目分片、租户视图和监控界面均可观察的闭环；当前先覆盖已有运行态可稳定判定的心跳、DLQ、自治周期错误三类，其余磁盘/DB/备份/限流类可沿同一规则与对象模型接入具体采样源。
8. `IntegrationBatch` 已从“设计已写、状态集合空置”修复为可创建、可推进、可审计、可分片、可经 REST/MCP 调用、可阻塞关闭门的真实控制对象；并行产物进入主线的底线链路不再只靠文档约束。

后续若再做 UI 或模块拆分，应先运行 `npm run validate`。其中 `node scripts/contract-check.mjs` 会检查文档接口是否真实存在，`node scripts/console-behaviour-check.mjs` 会检查系统管理入口是否再次漂移。
