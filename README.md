# ai-multi-agent-ctrl

`ai-multi-agent-ctrl` 是一个面向 AI 模型、AI Agent 和机器执行器的多 Agent 项目全生命周期自治控制系统。

系统不是给非系统执行路径操作的项目管理方案，也不是“阅读文档后再分配任务”的流程。系统的设计对象是可编程的 Orchestrator、Decision Center、Scheduler、Agent Runtime、MCP Proxy、Policy Engine、Reviewer Agent、QA Agent、Release Agent 和 Monitor Agent。

入口总控会话只接收目标、边界和不可绕过的外部能力信号。目标进入系统后，项目拆解、任务组创建、角色实例化、模型选择、会话派发、代码修改、测试、复验、提交、推送、发布准备、权限阻断处理、证据校验、规则沉淀和关闭判断都必须由 AI Agent 和程序自动执行。

## 文档入口

| 文档 | 定位 |
| --- | --- |
| [多 Agent 多会话项目全生命周期协作系统设计](docs/multi-agent-project-orchestration-system-design.md) | 终态架构基线、核心对象、状态机、调度、MCP、安全、质量和关闭不变量 |
| [终态自动执行范围](docs/terminal-autonomous-execution-scope.md) | 全系统终态能力边界、自动执行原则、不可降级能力和完成条件 |
| [核心控制平面规格](docs/core-control-plane-spec.md) | 终态控制平面对象、数据库表、API/MCP tools、事件模型和事务边界 |
| [Agent Runtime 协议](docs/agent-runtime-protocol.md) | Agent 入网、心跳、probe、session、artifact、权限阻断和恢复协议 |
| [机器可执行制品说明](docs/machine-executable-artifacts.md) | `spec/` 下 schema、manifest、state machine 和 event contract 的用途 |
| [AI 执行图](docs/autonomous-execution-graph.md) | 由 AI Agent 自动执行的 DAG、优先级、依赖、验收信号和提交策略 |

## 机器可执行规格

| 文件 | 用途 |
| --- | --- |
| [spec/terminal-execution-manifest.yaml](spec/terminal-execution-manifest.yaml) | 系统终态能力 manifest，供 Orchestrator 读取和校验 |
| [spec/state-machines.yaml](spec/state-machines.yaml) | TaskGroup、WorkItem、WorkSession、Command、PermissionRequest 等状态机 |
| [spec/state-machines.schema.json](spec/state-machines.schema.json) | 状态机规格自身的 schema |
| [spec/gates.yaml](spec/gates.yaml) | 状态机 `requires` 的机器 gate resolver 和失败码 |
| [spec/gate-catalog.schema.json](spec/gate-catalog.schema.json) | gate catalog 的 schema |
| [spec/terminal-execution-manifest.schema.json](spec/terminal-execution-manifest.schema.json) | 终态执行 manifest 的 schema |
| [spec/agent-skill-source.schema.json](spec/agent-skill-source.schema.json) | 外部角色 skill 源仓库、同步、信任和 overlay 策略 schema |
| [spec/agent-role-skill.schema.json](spec/agent-role-skill.schema.json) | 解析后的角色 skill、能力、digest 和模型需求 schema |
| [spec/role-skill-overlay.schema.json](spec/role-skill-overlay.schema.json) | 项目/任务组覆盖默认 role skill 的 digest、范围和决策 schema |
| [spec/model-capability.schema.json](spec/model-capability.schema.json) | 常用模型供应商/模型能力画像 schema |
| [spec/model-selection-policy.schema.json](spec/model-selection-policy.schema.json) | 按角色 skill 和任务需求自动选择模型/Agent 的策略 schema |
| [spec/model-selection-decision.schema.json](spec/model-selection-decision.schema.json) | 每次模型/Agent 选择的候选排序、硬约束、score 和审计 schema |
| [spec/session-placement-policy.schema.json](spec/session-placement-policy.schema.json) | 长任务新会话、小短任务子 agent 的调度策略 schema |
| [spec/session-placement-decision.schema.json](spec/session-placement-decision.schema.json) | 新 WorkSession 或子 agent 放置决策及 subagent 安全证明 schema |
| [spec/effective-instruction-packet.schema.json](spec/effective-instruction-packet.schema.json) | 总控强化后的有效指令包 schema，阻止 raw 输出直接驱动任务 |
| [spec/role-drift-guard.schema.json](spec/role-drift-guard.schema.json) | 总控、调度、监测和普通角色的任务焦点锁定与纠偏 schema |
| [spec/external-capability-boundary.schema.json](spec/external-capability-boundary.schema.json) | OS/OAuth/账号/云组织等外部能力边界 schema |
| [spec/execution-topology.schema.json](spec/execution-topology.schema.json) | 并行/串行/降级执行拓扑、branch 边界和父级串行合并 schema |
| [spec/derived-task-request.schema.json](spec/derived-task-request.schema.json) | worker/review/monitor 产生的派生任务请求 schema |
| [spec/review-plan.schema.json](spec/review-plan.schema.json) | 独立互审的 review item、batch、coverage matrix 和关闭门 schema |
| [spec/review-bundle.schema.json](spec/review-bundle.schema.json) | 外部/旁路 AI review bundle 的 redaction、digest 和本地核验 schema |
| [spec/rule-source-resolution.schema.json](spec/rule-source-resolution.schema.json) | MGP/ai-skills/review 等外部材料能否成为规则的来源解析 schema |
| [spec/completion-readiness.schema.json](spec/completion-readiness.schema.json) | WorkSession/TaskGroup final 前完成就绪检查 schema |
| [spec/runtime-issue-pattern.schema.json](spec/runtime-issue-pattern.schema.json) | 运行期重复问题聚合、证据和收集限定 schema |
| [spec/system-upgrade-candidate.schema.json](spec/system-upgrade-candidate.schema.json) | 重复运行问题收集和独立系统升级候选 schema |
| [spec/agent-task-contract.schema.json](spec/agent-task-contract.schema.json) | 总控派发给 WorkSession 的任务契约 schema |
| [spec/control-events.schema.json](spec/control-events.schema.json) | Room/Command/Checkpoint/Permission 等控制事件 envelope schema |
| [spec/checkpoint.schema.json](spec/checkpoint.schema.json) | checkpoint、commitRefs、pushRefs 和 evidenceRefs 的终态输出 schema |
| [spec/commit-ref.schema.json](spec/commit-ref.schema.json) | Git commit 证据引用 schema |
| [spec/push-ref.schema.json](spec/push-ref.schema.json) | Git push 远端验证证据 schema |
| [spec/mcp-grant.schema.json](spec/mcp-grant.schema.json) | MCP tool grant 的最小权限、参数策略、结果过滤和过期 schema |
| [spec/git-automation-policy.schema.json](spec/git-automation-policy.schema.json) | Agent 自动 commit/push 的凭据、分支、路径和远端校验策略 |
| [spec/git-command.schema.json](spec/git-command.schema.json) | Agent Git status/commit/push 命令的 payload、路径匹配和证据输出 schema |
| [spec/close-barrier.schema.json](spec/close-barrier.schema.json) | TaskGroup 关闭屏障的机器判定 schema |
| [scripts/validate-specs.rb](scripts/validate-specs.rb) | 只读校验 manifest、状态机、gate、关闭屏障和关键 schema 覆盖 |

## 终态原则

1. 所有可程序化动作都由 AI Agent 或系统服务执行，不设计成外部执行步骤。
2. 总控不是项目经理岗位，而是唯一目标入口和权威调度器。
3. Decision Center 默认由 AI Agent 运行，输出可审计 `DecisionRecord`。
4. Reviewer、QA、Security、Release、Rule Steward 都是角色化 Agent，不是外部岗位。
5. 审批不是外部点击确认，而是 `ApprovalRequest` + policy/quorum + AI decision + audit 的状态机。
6. 权限阻断不是等待非系统路径处理，而是 `PermissionRequest` + capability routing + service grant + reassign + retry 的自动流程。
7. 对 OS、OAuth、第三方平台明确禁止自动化越权的场景，系统只把它建模为外部能力边界事件；这不是项目执行步骤，也不能伪装成自动批准。
8. 所有状态以 PostgreSQL、event log、checkpoint、artifact digest、schema 和 state machine 为准，不以聊天文本为准。
9. 所有写入型动作必须经过 policy、lease、idempotency、command effect 和 audit。
10. 角色 skill 默认从 `DlenoDing/agency-agents-zh` pinned commit 自动加载，项目/任务组特殊要求通过 overlay 对象覆盖。
11. 模型选择由 Model Registry 和 Scheduler 基于角色 skill、任务能力、成本、速度、额度、可靠性和风险自动决定。
12. Scheduler 对持续多轮、长耗时、有状态、拥有写入面的角色任务优先创建新 WorkSession；短小、只读、无持久上下文的任务才使用子 agent。
13. 运行期重复问题只生成 RuntimeIssuePattern、SystemUpgradeCandidate 和系统外升级证据包；系统运行时不得自动自修改规则、策略、角色、grant 或控制面代码，升级改造由人独立在系统外处理。
14. 总控、调度和监测等元控制角色必须绑定 RoleDriftGuard；一旦目标、职责、边界或证据链跑偏，立即暂停副作用并由父级总控重发有效任务契约。
15. MGP、ai-skills、外部 review 和工具结果只能作为来源材料；是否吸收为本系统规则必须经过 RuleSourceResolution，本地核验前不能直接执行。
16. 外部/旁路 AI review 结果只具 advisory 属性；必须经 ReviewBundle redaction、ReviewPlan coverage 和本地核验后才可转为 Finding、WorkItem 或 DecisionRecord。
17. 最终关闭由 Orchestrator 根据 CompletionReadinessCheck 和 CloseBarrier 的完整 gate 结果完成。

## 终态技术路线

| 层 | 终态要求 |
| --- | --- |
| 控制服务 | TypeScript/Node.js 控制平面，可按负载拆分服务但协议不变 |
| 系统库 | PostgreSQL 权威状态、event log、lease、audit、rules、artifact metadata |
| Agent Runtime | 可远程加入、探测、执行、隔离、恢复、上报证据的机器执行器 |
| 实时通道 | WebSocket 负责实时性，PostgreSQL outbox/inbox/DLQ 负责可靠性 |
| MCP | 系统级、项目级、Agent-local MCP 全部经 MCP Proxy 授权和审计 |
| Artifact | digest、sensitivity、retention、redaction、verify、GC、backup 全流程机器处理 |
| Policy/Secret | policy table/engine、secret lease、credential helper、grant revoke、audit |
| UI | 只作为后台管理、观察和入口总控会话界面，不作为执行依赖 |

## 执行方式

系统内所有工作都应按 [AI 执行图](docs/autonomous-execution-graph.md) 和 `spec/terminal-execution-manifest.yaml` 执行。每个 Agent 接到任务时必须读取：

1. 对应 schema。
2. 当前 stateVersion。
3. ruleset digest。
4. input digest。
5. write scope 和 lease。
6. stop/return 条件。
7. checkpoint 和 evidence 要求。

任务完成后由 Agent 自动提交 checkpoint、更新状态、运行验证、提交 Git commit 并按策略 push。不能把“需要非系统路径后续执行”作为完成结果。
