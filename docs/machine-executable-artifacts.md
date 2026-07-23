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
| `spec/model-capability.schema.json` | Model Registry、Scheduler、Agent Runtime | 校验市面常用模型供应商和模型能力画像 |
| `spec/model-selection-policy.schema.json` | Scheduler、Model Registry、Decision Center | 校验角色/任务驱动的模型与 Agent 自动选择策略 |
| `spec/session-placement-policy.schema.json` | Scheduler、Orchestrator、Agent Runtime | 校验长任务新会话、小短任务子 agent 的 placement 策略 |
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
10. Monitor 只能把重复问题聚合为 RuntimeIssuePattern 和 SystemUpgradeCandidate，并导出系统外升级证据包；运行中系统不能自动改写系统规则、策略、角色、grant 或控制面代码，也不能自动创建升级任务组。
11. MCP Proxy 执行 tool 前必须校验 grant、参数策略、结果过滤和过期时间。
12. Agent Runtime 执行 Git 副作用前必须校验 GitAutomationPolicy、writeScope 和 changedPathPolicy。
13. Orchestrator 关闭 TaskGroup 前必须生成并校验 CloseBarrier。
14. 不符合 schema 的消息只能进入 DLQ，不能被 Agent 自然语言猜测执行。

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
| model selection | provider capability profile、roleSkillFit、task capability fit、quota/cost/latency/reliability、decision refs |
| session placement | sustainedWorkSignals、shortTaskSignals、subagent capacity、task contract、modelSelectionDecisionRef、auditRef |
| runtime issue collection | issue fingerprint、recurrenceCount、evidenceRefs、sampleRefs、collect-only policy、externalUpgradePackageRef |
| command dispatch | idempotencyKey、policyDecisionRef、leaseRef、timeout、retry、commandEffect |
| mcp call | mcp-grant schema、tool schema digest、grant、param policy、result filter、risk gate、expiresAt |
| git side effect | git policy schema、git command schema、credentialProfileRef、changed paths、writeScope、remote SHA、pushRef |
| checkpoint | workId、sessionId、stateVersion、artifactRefs、commitRefs、pushRefs、nextSteps |
| close barrier | close-barrier schema、完整 required gate 集合、open findings、quality gates、DLQ、pending permission/approval、policy decisions、commands、command effects、secret leases、temporary grants、external capability boundaries、lease terminal 状态 |

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
