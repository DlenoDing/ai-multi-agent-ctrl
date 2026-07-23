# 机器可执行制品说明

## 1. 目标

本文说明 `spec/` 目录中的机器可执行制品。自然语言文档只用于解释系统意图，真正驱动 AI Agent 执行的应是 schema、manifest、state machine 和 event contract。

## 2. 制品清单

| 文件 | 消费者 | 用途 |
| --- | --- | --- |
| `spec/terminal-execution-manifest.yaml` | Orchestrator、Scheduler、Monitor Agent | 声明终态系统能力、强制不变量、角色、质量门和执行策略 |
| `spec/state-machines.yaml` | Control Plane、Agent Runtime、Reviewer Agent | 校验 TaskGroup、WorkItem、WorkSession、Command、PermissionRequest 等状态流转 |
| `spec/terminal-execution-manifest.schema.json` | Control Plane、Spec Validator | 校验终态 manifest 的结构和必需控制对象 |
| `spec/state-machines.schema.json` | Control Plane、Spec Validator | 校验状态机文件结构、状态集合和跃迁字段 |
| `spec/gates.yaml` | Control Plane、Gate Validator、Orchestrator | 把状态机 `requires` 映射为可执行 gate resolver、输入源、证据类型和失败码 |
| `spec/gate-catalog.schema.json` | Control Plane、Spec Validator | 校验 gate catalog 结构 |
| `spec/agent-skill-source.schema.json` | Skill Registry、Scheduler、Orchestrator | 校验 `agency-agents-zh` 等角色 skill 源、同步、信任和 overlay 策略 |
| `spec/agent-role-skill.schema.json` | Skill Registry、Scheduler、WorkSession | 校验解析后的角色 skill、能力、digest 和模型需求 |
| `spec/role-skill-overlay.schema.json` | Skill Registry、Rule Steward、Orchestrator | 校验项目/任务组 role skill 覆盖范围、digest 和决策记录 |
| `spec/model-capability.schema.json` | Model Registry、Scheduler、Agent Runtime | 校验市面常用模型供应商和模型能力画像 |
| `spec/model-selection-policy.schema.json` | Scheduler、Model Registry、Decision Center | 校验角色/任务驱动的模型与 Agent 自动选择策略 |
| `spec/model-selection-decision.schema.json` | Model Registry、Scheduler、Agent Runtime | 校验每次模型/Agent 选择的候选排序、硬约束、score、选中模型和审计 |
| `spec/session-placement-policy.schema.json` | Scheduler、Orchestrator、Agent Runtime | 校验长任务新会话、小短任务子 agent 的 placement 策略 |
| `spec/session-placement-decision.schema.json` | Scheduler、Agent Runtime | 校验每次新 WorkSession/subagent 放置决策和 subagent 安全证明 |
| `spec/effective-instruction-packet.schema.json` | Orchestrator、Policy Engine、Agent Runtime | 校验强化后的有效指令包、来源分类、active rule 和 forbidden action |
| `spec/role-drift-guard.schema.json` | Orchestrator、Scheduler、Monitor Agent | 校验角色任务焦点锁、漂移信号、纠偏动作和元控制角色保护 |
| `spec/external-capability-boundary.schema.json` | Permission Gateway、Policy Engine、Agent Runtime | 校验外部能力边界、不可 AI 批准范围、可接受 resolution mode 和证据 |
| `spec/execution-topology.schema.json` | Scheduler、Orchestrator、Agent Runtime | 校验并行拓扑、branch 隔离、owned path、result bundle 和父级串行合并 |
| `spec/derived-task-request.schema.json` | Orchestrator、Scheduler、Reviewer Agent、Monitor Agent | 校验派生任务请求、插入模式、拓扑影响和审计证据 |
| `spec/review-plan.schema.json` | Reviewer Agent、Orchestrator、QA Agent | 校验互审计划、batch、coverage matrix 和 closure gate |
| `spec/review-bundle.schema.json` | Reviewer Agent、Security Agent、External Review Adapter | 校验 review bundle redaction、payload digest、provider grant 和本地核验 |
| `spec/rule-source-resolution.schema.json` | Rule Steward、Orchestrator、Policy Engine | 校验 MGP/ai-skills/review 等来源是否可成为 active rule |
| `spec/completion-readiness.schema.json` | Orchestrator、Monitor Agent、Agent Runtime | 校验 WorkSession/TaskGroup final 前所有未闭合对象和证据覆盖 |
| `spec/runtime-issue-pattern.schema.json` | Monitor Agent、Rule Steward、Orchestrator | 校验运行期重复问题聚合、证据和收集限定 |
| `spec/system-upgrade-candidate.schema.json` | Monitor Agent、Rule Steward、Orchestrator | 校验重复运行问题收集、候选归档和系统外升级证据包 |
| `spec/agent-task-contract.schema.json` | Orchestrator、Agent Runtime、WorkSession | 校验每次 session_start 的任务契约 |
| `spec/control-events.schema.json` | Room Broker、Command Bus、MCP Proxy | 校验 room event、command event、checkpoint event 和 permission event envelope |
| `spec/checkpoint.schema.json` | Evidence MCP、Agent Runtime、Close Barrier | 校验 checkpoint、commitRefs、pushRefs 和 evidenceRefs |
| `spec/commit-ref.schema.json` | Git Command、Evidence MCP | 校验 commit ref 证据 |
| `spec/push-ref.schema.json` | Git Command、Evidence MCP | 校验 push ref 和远端 SHA 证据 |
| `spec/mcp-grant.schema.json` | MCP Proxy、Permission Gateway、Security Agent | 校验 MCP tool grant 的参数策略、结果过滤、风险和过期 |
| `spec/git-automation-policy.schema.json` | Agent Runtime、Command Bus、Release Agent | 校验自动 commit/push 凭据、分支、路径范围和远端 SHA |
| `spec/git-command.schema.json` | Agent Runtime、Command Bus、Release Agent | 校验 Git status/commit/push 命令 payload、路径匹配和证据输出 |
| `spec/close-barrier.schema.json` | Orchestrator、Monitor Agent、Release Agent | 校验 TaskGroup 关闭屏障、质量门结果和阻断对象 |
| `spec/runtime-bootstrap.schema.json` | Agent Runtime、UI Console Service、Spec Validator | 校验 npm/Docker/Shell 启动、初始化、自检和文件产出策略 |
| `spec/account.schema.json` | Identity Service、Policy Engine、UI Console Service | 校验系统管理员、用户账号、服务账号和 Agent identity |
| `spec/access-control-grant.schema.json` | Identity Service、Policy Engine、UI Console Service | 校验系统、用户、项目、任务组和 Agent 授权 |
| `spec/management-console-surface.schema.json` | UI Console Service、Security Agent、Spec Validator | 校验系统管理和用户管理界面、guarded action 和视觉质量门 |
| `spec/progress-snapshot.schema.json` | Monitor Agent、Orchestrator、UI Console Service | 校验项目/任务组进度、阻塞、角色活动和仓库输出快照 |
| `spec/instruction-envelope.schema.json` | Orchestrator、Room Broker、Instruction Optimizer、Agent Runtime | 校验稳定前缀、delta、cache key、token budget 和输出契约 |
| `spec/shared-definition-contract.schema.json` | Orchestrator、Decision Center、Reviewer Agent、Monitor Agent | 校验共享定义 canonical owner、producer、consumer、digest 和冲突策略 |
| `spec/repository-output-target.schema.json` | Orchestrator、Scheduler、Repository Router、Agent Runtime | 校验任务产出目标仓库、分支、路径、lease、commit、push 和 manifest |
| `scripts/validate-specs.rb` | CI、Spec Validator、Orchestrator preflight | 只读验证 manifest、状态机、gate resolver、CloseBarrier、CompletionReadiness 和关键 schema 覆盖 |

## 3. 执行规则

1. Orchestrator 创建任务前必须读取 manifest。
2. Scheduler 派发 session 前必须校验 task contract。
3. Agent Runtime 收到任务后必须先校验 schema，再启动 WorkSession。
4. Room Broker 写入消息前必须校验 event envelope。
5. Control Plane 状态流转前必须校验 state machine，并用 gate catalog 解析每个 `requires`。
6. 未匹配 gate resolver 的状态转移必须拒绝，不能由 Agent 自然语言解释通过。
7. Skill Registry 必须从 `agency-agents-zh` pinned commit 加载默认角色 skill，并按 taskGroup overlay、project overlay、upstream default 的顺序解析。
8. Model Registry 必须探测常用模型供应商能力画像，Scheduler 必须按角色 skill、任务能力和策略输出 `ModelSelectionDecision`。
9. Scheduler 必须按 SessionPlacementPolicy 输出 `SessionPlacementDecision`，持续多轮任务优先新 WorkSession，短小封闭任务才可用子 agent。
10. Orchestrator 派发任何 WorkSession 前必须生成 `EffectiveInstructionPacket`，并把 role skill、model decision、placement decision、RoleDriftGuard 和 action basis 写入 task contract。
11. Scheduler 对 subagent placement 必须证明单轮、无持久状态、无全局任务 owner、无 write scope owner、无外部能力流且容量可用；任何 sustained signal 都必须落到新 WorkSession。
12. Monitor 和 Orchestrator 必须持续校验 RoleDriftGuard。总控、调度或监测角色漂移时，系统先暂停副作用，再生成 Finding/DerivedTaskRequest/DecisionRecord 完成父级纠偏。
13. Monitor 只能把重复问题聚合为 RuntimeIssuePattern 和 SystemUpgradeCandidate，并导出系统外升级证据包；运行中系统不能自动改写系统规则、策略、角色、grant 或控制面代码，也不能自动创建升级任务组。
14. MGP、ai-skills、外部 review、工具输出和旧规则文本必须先进入 RuleSourceResolution 或 ReviewBundle；本地核验和来源解析完成前不能成为 active rule 或执行动作。
15. MCP Proxy 执行 tool 前必须校验 grant、参数策略、结果过滤和过期时间。
16. Agent Runtime 执行 Git 副作用前必须校验 GitAutomationPolicy、writeScope 和 changedPathPolicy。
17. Orchestrator 派发会产生文件的 WorkItem 前必须创建 `RepositoryOutputTarget`，明确仓库、分支、路径范围、lease 和 artifact manifest；项目产出文件只能写入该 Git target。
18. Orchestrator 识别到跨子项目、跨子系统或多端共享术语、状态、接口、数据模型、错误码、设计 token、质量标准、权限语义或指令格式时，必须先创建 `SharedDefinitionContract` 并分配 canonical owner 和 producer。
19. Room Broker 下发任务指令必须使用 `InstructionEnvelope`，优先传 stable prefix digest、locator、delta、cache key 和 output contract，降低 token 消耗并提高缓存命中。
20. Monitor 计算项目和任务组进度时必须输出 `ProgressSnapshot`，UI 只能展示 snapshot，不能用自由文本覆盖状态机。
21. Orchestrator 关闭 TaskGroup 前必须生成并校验 CompletionReadinessCheck 和 CloseBarrier。
22. 不符合 schema 的消息只能进入 DLQ，不能被 Agent 自然语言猜测执行。

## 4. schema 优先级

优先级从高到低：

```text
System instruction
-> user objective boundary
-> spec/*.schema.json and spec/*.yaml
-> current ruleset digest
-> task contract
-> room delta
-> natural language explanation
```

如果自然语言文档和 schema 冲突，AI Agent 必须以 schema 和 state machine 为准，并提交 `decision_request` 或 `spec_drift_finding`。

## 5. 机器校验点

| 校验点 | 必须检查 |
| --- | --- |
| task dispatch | task contract schema、stateVersion、rulesetDigest、writeScope、stopCondition |
| state transition | source state、target state、allowed actor、gate resolver、required evidence、failureCode |
| role skill selection | skill source digest、role skill digest、project overlay、taskGroup overlay、model requirements |
| model selection | provider capability profile、roleSkillFit、task capability fit、candidate rankings、hard constraints、quota/cost/latency/reliability、decision refs |
| session placement | sustainedWorkSignals、shortTaskSignals、subagent capacity、subagent safety proof、task contract、modelSelectionDecisionRef、auditRef |
| effective instruction | source classification、nextActionDraftDigest、activeRuleRefs、nonActiveMaterialRefs、contextIntakeRefs、forbiddenActions |
| role drift guard | objectiveBoundaryDigest、roleMissionDigest、taskContractDigest、allowed/forbidden action scope、driftScore、correctiveActions |
| execution topology | branch boundaries、owned/forbidden paths、resource scopes、runner isolation、result bundle contract、parent serial merge |
| review plan/bundle | review items、batches、coverage matrix、redaction、payload digest、advisory result、本地核验证据 |
| rule source resolution | sourceScope、authorityLevel、sourceDigest、conflictCheck、activeRuleRefs、referenceOnlyRefs、excludedSourceRefs |
| runtime issue collection | issue fingerprint、recurrenceCount、evidenceRefs、sampleRefs、collect-only policy、externalUpgradePackageRef |
| runtime bootstrap | RuntimeBootstrapProfile、npm/Docker/Shell entrypoint、health check、admin seed、fileOutputPolicy |
| account/access control | Account、AccessControlGrant、role、permission、resource scope、policyDecisionRef、auditRef |
| management console | ManagementConsoleSurface、guardedActions、visualQualityGates、audit trace、system/user boundary |
| progress snapshot | ProgressSnapshot、phase、percent、health、work counters、role activity、repository outputs |
| instruction envelope | stablePrefixDigest、deltaRefs、cacheKey、tokenBudget、outputContractRef、sharedDefinitionRefs |
| shared definition | SharedDefinitionContract、canonicalOwnerRole、producerRole、definitionDigest、consumer bindings、conflict policy |
| repository output target | RepositoryOutputTarget、repositoryId、branch、pathAllowlist、leaseRef、commitRefs、pushRefs、artifactManifestPath |
| command dispatch | idempotencyKey、policyDecisionRef、leaseRef、timeout、retry、commandEffect |
| mcp call | mcp-grant schema、tool schema digest、grant、param policy、result filter、risk gate、expiresAt |
| git side effect | git policy schema、git command schema、credentialProfileRef、changed paths、writeScope、remote SHA、pushRef |
| checkpoint | workId、sessionId、stateVersion、artifactRefs、commitRefs、pushRefs、nextSteps、openMachineActionIds、derivedWorkRequests、returnPointRef |
| completion readiness | requiredChecks 完整覆盖、blockingObjects、evidenceRefs、open topology/review/derived task/external review/role drift |
| close barrier | close-barrier schema、按 gate 名称索引的完整 gateResults、open findings、quality gates、DLQ、pending permission/approval、policy decisions、commands、command effects、secret leases、temporary grants、external capability boundaries、lease terminal 状态 |

## 6. drift 处理

当 Agent 发现文档、schema、状态机、数据库和实际行为不一致时，不允许自行猜测。

必须执行：

```text
drift_detected
-> submit finding(type=spec_drift)
-> stop side effects
-> request decision
-> wait decision delta
-> rebind contract
-> continue or abort
```

## 7. 代码生成约束

实现代码、运行时 validator、MCP schema 和 contract tests 必须从 `spec/` 生成：

1. TypeScript types。
2. runtime validators。
3. API request/response validators。
4. MCP tool schemas。
5. state transition guards。
6. fixture builders。
7. contract tests。

不要让实现代码手写一套和 `spec/` 不一致的对象模型。
