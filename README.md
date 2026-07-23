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
| [spec/agent-task-contract.schema.json](spec/agent-task-contract.schema.json) | 总控派发给 WorkSession 的任务契约 schema |
| [spec/control-events.schema.json](spec/control-events.schema.json) | Room/Command/Checkpoint/Permission 等控制事件 envelope schema |

## 终态原则

1. 所有可程序化动作都由 AI Agent 或系统服务执行，不设计成外部执行步骤。
2. 总控不是项目经理岗位，而是唯一目标入口和权威调度器。
3. Decision Center 默认由 AI Agent 运行，输出可审计 `DecisionRecord`。
4. Reviewer、QA、Security、Release、Rule Steward 都是角色化 Agent，不是外部岗位。
5. 审批不是“人点同意”，而是 `ApprovalRequest` + policy/quorum + AI decision + audit 的状态机。
6. 权限阻断不是“等人处理”，而是 `PermissionRequest` + capability routing + service grant + reassign + retry 的自动流程。
7. 对 OS、OAuth、第三方平台明确禁止自动化越权的场景，系统只把它建模为外部能力边界事件；这不是项目执行步骤，也不能伪装成自动批准。
8. 所有状态以 PostgreSQL、event log、checkpoint、artifact digest、schema 和 state machine 为准，不以聊天文本为准。
9. 所有写入型动作必须经过 policy、lease、idempotency、command effect 和 audit。
10. 最终关闭由 Orchestrator 根据机器可判定关闭屏障完成。

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

所有后续工作都应按 [AI 执行图](docs/autonomous-execution-graph.md) 和 `spec/terminal-execution-manifest.yaml` 执行。每个 Agent 接到任务时必须读取：

1. 对应 schema。
2. 当前 stateVersion。
3. ruleset digest。
4. input digest。
5. write scope 和 lease。
6. stop/return 条件。
7. checkpoint 和 evidence 要求。

任务完成后由 Agent 自动提交 checkpoint、更新状态、运行验证、提交 Git commit 并按策略 push。不能把“需要人后续执行”作为完成结果。
