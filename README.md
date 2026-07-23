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
| [运行启动、管理界面、共享定义和仓库产出规范](docs/runtime-management-ui-and-repository-output.md) | npm/Docker/Shell 启动、系统/用户管理、进度视图、指令压缩、共享定义归属和 Git 仓库产出目标 |
| [机器可执行制品说明](docs/machine-executable-artifacts.md) | `spec/` 下 schema、manifest、state machine 和 event contract 的用途 |
| [AI 执行图](docs/autonomous-execution-graph.md) | 由 AI Agent 自动执行的 DAG、优先级、依赖、验收信号和提交策略 |

## 本地启动

```bash
npm run init
npm start
```

默认控制台地址：

```text
http://127.0.0.1:4317
```

其他入口：

```bash
npm run doctor
npm run mcp:register
npm run mcp:start
npm run mcp:doctor
npm run skills:sync
./scripts/start.sh
npm run docker:up
```

`npm run doctor` 会启动隔离的临时控制平面并执行 AI-native 冒烟链路：模型选择、session placement、仓库路径阻断、Orchestrator 自治循环、AgentDispatch outbox、受控 executor、Git commit/push 证据、CompletionReadiness、CloseBarrier、MCP stdio 握手、`tools/list`、读写工具调用、输入校验、idempotency 拒绝路径，以及启用后的 MCP `runtime_run` 正向 dispatch/executor/commit/push/checkpoint 链路。`npm run skills:sync` 会同步 `DlenoDing/agency-agents-zh` pinned commit 并通过共享 state-store 生成角色 skill 索引；本地默认写 `.runtime/control-plane-state.json`，Postgres 模式写 `aimac_control_plane_state.state`。

MCP 客户端注册：

```bash
npm run mcp:register
```

默认会在 `.runtime/mcp-client-configs/` 生成 `mcp-server.json`、`codex_config.toml`、`claude_desktop_config.json` 和 `cursor_mcp.json`。输出目录可通过 `--output-dir=...` 或 `AIMAC_MCP_CONFIG_DIR` 覆盖。需要直接合并到指定客户端配置时使用：

```bash
node scripts/register-mcp-client.mjs --client=codex --apply --config=/path/to/config.toml
node scripts/register-mcp-client.mjs --client=claude --apply --config=/path/to/claude_desktop_config.json
node scripts/register-mcp-client.mjs --client=cursor --apply --config=/path/to/mcp.json
```

MCP server 是 stdio 进程，由客户端按配置自动拉起：

```bash
npm run mcp:start
```

本地 `npm` 和 `shell` 入口会在执行目标脚本前加载项目根目录 `.env`，已有进程环境变量优先级更高。`.env.example` 给出完整变量名。`npm run mcp:register` 生成的客户端配置会设置 `AIMAC_MCP_TOKEN` 和 `AIMAC_MCP_LOCAL_WRITE_ENABLE=true`，从而启用本地 stdio 写 grant；没有该配置时 MCP 写工具默认拒绝。`agent-control-mcp.runtime_run` 还需要显式设置 `AIMAC_MCP_ENABLE_RUNTIME_RUN=true`，否则不能从 MCP 入口触发 Agent Runtime worker。

Docker 镜像不在 build 阶段执行 bootstrap init，避免随机管理 token 写入镜像层。`npm run docker:up` 由 Compose 在容器运行时注入 `AIMAC_BOOTSTRAP_TOKEN`、`AIMAC_WORKSPACE_OWNER_TOKEN`、`AIMAC_REVIEWER_TOKEN`、`AIMAC_AGENT_RUNTIME_TOKEN` 和 `DATABASE_URL`，再通过 `shell:start` 初始化并启动控制面。Compose 默认 token 和数据库口令只适合本地验证，共享环境必须用外部 secret 覆盖。

`npm run init` 会生成本地系统 bootstrap token 和用户管理账号 token。系统管理员账号使用 bootstrap token；普通用户、项目管理员和服务账号使用各自账号 token，不能用 bootstrap token 直接登录任意账号。

常规 Agent Runtime 必须具备选中模型 provider 的凭证，并通过 `AIMAC_AGENT_RUNTIME_EXECUTOR_COMMAND` 指向受控 executor；executor 接收 task contract JSON，输出 Git 路径化产物和 artifact manifest。`AIMAC_EXECUTION_PROFILE=verification` 加 `.aimac-verification-repository` 仓库标记时，才可配合 `AIMAC_ALLOW_LOCAL_DETERMINISTIC_WORKER=true` 走本地确定性验证 fallback；生产 profile 缺少凭证或 executor 时只能阻断，不能伪造完成。

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
| [spec/runtime-bootstrap.schema.json](spec/runtime-bootstrap.schema.json) | npm/Docker/Shell 运行启动和初始化 profile schema |
| [spec/account.schema.json](spec/account.schema.json) | 系统管理员、用户账号、服务账号和 Agent identity schema |
| [spec/access-control-grant.schema.json](spec/access-control-grant.schema.json) | 系统、用户、项目、任务组和 Agent 权限授权 schema |
| [spec/management-console-surface.schema.json](spec/management-console-surface.schema.json) | 系统管理和用户管理界面 schema |
| [spec/progress-snapshot.schema.json](spec/progress-snapshot.schema.json) | 项目/任务组进度、阻塞、角色活动和仓库输出快照 schema |
| [spec/agent-dispatch.schema.json](spec/agent-dispatch.schema.json) | Orchestrator 投递给 Agent Runtime 的 durable dispatch/outbox schema |
| [spec/instruction-envelope.schema.json](spec/instruction-envelope.schema.json) | 指令稳定前缀、delta、cache key、token budget 和输出契约 schema |
| [spec/shared-definition-contract.schema.json](spec/shared-definition-contract.schema.json) | 多子系统共享定义 canonical owner、producer、consumer 和 digest schema |
| [spec/repository-output-target.schema.json](spec/repository-output-target.schema.json) | 任务产出写入项目 Git 仓库的目标仓库、分支、路径和提交证据 schema |
| [scripts/validate-specs.rb](scripts/validate-specs.rb) | 只读校验 manifest、状态机、gate、关闭屏障和关键 schema 覆盖 |

## 终态原则

1. 所有可程序化动作都由 AI Agent 或系统服务执行，不设计成外部执行步骤。
2. 总控不是非系统执行角色，而是唯一目标入口和权威调度器。
3. Decision Center 默认由 AI Agent 运行，输出可审计 `DecisionRecord`。
4. Reviewer、QA、Security、Release、Rule Steward 都是角色化 Agent，不是外部岗位。
5. 审批不是外部点击确认，而是 `ApprovalRequest` + policy/quorum + AI decision + audit 的状态机。
6. 权限阻断不是等待非系统路径处理，而是 `PermissionRequest` + capability routing + service grant + reassign + retry 的自动流程。
7. 对 OS、OAuth、第三方平台明确禁止自动化越权的场景，系统只把它建模为外部能力边界事件；这不是项目执行步骤，也不能伪装成自动批准。
8. 所有状态以 PostgreSQL、event log、checkpoint、Git-backed artifact manifest digest、schema 和 state machine 为准，不以聊天文本为准。
9. 所有写入型动作必须经过 policy、lease、idempotency、command effect 和 audit。
10. 角色 skill 默认从 `DlenoDing/agency-agents-zh` pinned commit 自动加载，项目/任务组特殊要求通过 overlay 对象覆盖。
11. 模型选择由 Model Registry 和 Scheduler 基于角色 skill、任务能力、成本、速度、额度、可靠性和风险自动决定。
12. Scheduler 对持续多轮、长耗时、有状态、拥有广义写入面的角色任务优先创建新 WorkSession；短小、单轮、无持久上下文的任务可使用子 agent，但仍必须绑定 bounded repository lease、commit、push 和 checkpoint 证据。
13. 运行期重复问题只生成 RuntimeIssuePattern、SystemUpgradeCandidate 和系统外升级证据包；系统运行时不得自动自修改规则、策略、角色、grant 或控制面代码，升级改造由人独立在系统外处理。
14. 总控、调度和监测等元控制角色必须绑定 RoleDriftGuard；一旦目标、职责、边界或证据链跑偏，立即暂停副作用并由父级总控重发有效任务契约。
15. MGP、ai-skills、外部 review 和工具结果只能作为来源材料；是否吸收为本系统规则必须经过 RuleSourceResolution，本地核验前不能直接执行。
16. 外部/旁路 AI review 结果只具 advisory 属性；必须经 ReviewBundle redaction、ReviewPlan coverage 和本地核验后才可转为 Finding、WorkItem 或 DecisionRecord。
17. 最终关闭由 Orchestrator 根据 CompletionReadinessCheck 和 CloseBarrier 的完整 gate 结果完成。
18. 共享定义、标准、术语、状态语义、接口、数据模型、错误码和指令格式必须由 SharedDefinitionContract 明确 canonical owner、producer、consumer 和 digest。
19. 任务产出文件只写入 Orchestrator 选定的项目 Git 仓库目标；系统不另建项目产出文件管理层。

## 终态技术路线

| 层 | 终态要求 |
| --- | --- |
| 控制服务 | TypeScript/Node.js 控制平面，可按负载拆分服务但协议不变 |
| 系统库 | 本地 npm/shell 默认 `runtime_json`；Docker Compose 设置 `AIMAC_STATE_STORE=postgresql` 并使用 Postgres JSONB 存储权威状态、event log、lease、audit、rules 和 Git-backed artifact manifest metadata |
| Agent Runtime | 可远程加入、探测、执行、隔离、恢复、上报证据的机器执行器 |
| 实时通道 | WebSocket 负责实时性，PostgreSQL outbox/inbox/DLQ 负责可靠性 |
| MCP | 系统级、项目级、Agent-local MCP 全部经 MCP Proxy 授权和审计 |
| Evidence/Artifact | 证据 locator、digest、sensitivity、retention、redaction、verify、GC、backup；项目交付文件以 Git 仓库 commit/push 为准 |
| Policy/Secret | policy table/engine、secret lease、credential helper、grant revoke、audit |
| UI | 只作为后台管理、观察和入口总控会话界面，不作为执行依赖 |

## 本地控制平面实现

当前实现提供无依赖 Node 控制服务、SaaS 管理控制台和 AI Runtime 视图。核心运行逻辑位于 `apps/control-plane-ui/lib/control-plane-core.mjs`，覆盖：

1. 常用模型 provider class 的能力 registry 和自动模型选择。
2. `agency-agents-zh` pinned snapshot 的 skill source 同步、frontmatter 解析和 digest 索引。
3. 长任务新 WorkSession、短任务 subagent 的 session placement 决策。
4. AgentTaskContract、AgentDispatch durable outbox、EffectiveInstructionPacket、RoleDriftGuard、Checkpoint、ProgressSnapshot、CompletionReadiness 和 CloseBarrier 的本地生成。
5. Agent Runtime worker 消费 dispatch 后实际写入项目 Git 仓库、commit、push，并用 Git commit、remote ref、artifact manifest、changed path 和 lease 证据校验 checkpoint。
6. 运行期重复问题的 collect-only 聚合和 SystemUpgradeCandidate 生成。
7. 项目、任务组、Agent、账号、授权、审计和仓库输出目标的受控 API。
8. `apps/mcp-server/server.mjs` 提供内置 MCP stdio server，暴露 `orchestration-mcp`、`agent-control-mcp`、`scheduler-mcp`、`model-mcp`、`skill-mcp`、`evidence-mcp`、`permission-mcp`、`review-mcp`、`governance-mcp`、`identity-mcp`、`ui-console-mcp`、`definition-mcp`、`instruction-mcp`、`repository-mcp` 等逻辑工具面，并对写入型调用执行输入校验、idempotency、token-bound grant、lease/fencing、policy decision、audit 和 untrusted result 标记。
9. `apps/control-plane-ui/lib/state-store.mjs` 提供同步 state store；本地默认 `.runtime/control-plane-state.json`，Docker Compose 通过 `psql` 使用 `aimac_control_plane_state.state jsonb` 作为 HTTP、MCP 和 CLI skill sync 的共同权威状态；写入按 `stateVersion` 做冲突检测，避免多 agent 并发静默覆盖。

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
