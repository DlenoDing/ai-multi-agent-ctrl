# 机器可执行制品说明

## 1. 目标

本文说明 `spec/` 目录中的机器可执行制品。自然语言文档只用于解释系统意图，真正驱动 AI Agent 执行的应是 schema、manifest、state machine 和 event contract。

## 2. 制品清单

| 文件 | 消费者 | 用途 |
| --- | --- | --- |
| `spec/terminal-execution-manifest.yaml` | Orchestrator、Scheduler、Monitor Agent | 声明终态系统能力、强制不变量、角色、质量门和执行策略 |
| `spec/state-machines.yaml` | Control Plane、Agent Runtime、Reviewer Agent | 校验 TaskGroup、WorkItem、WorkSession、Command、PermissionRequest 等状态流转 |
| `spec/agent-task-contract.schema.json` | Orchestrator、Agent Runtime、WorkSession | 校验每次 session_start 的任务契约 |
| `spec/control-events.schema.json` | Room Broker、Command Bus、MCP Proxy | 校验 room event、command event、checkpoint event 和 permission event envelope |

## 3. 执行规则

1. Orchestrator 创建任务前必须读取 manifest。
2. Scheduler 派发 session 前必须校验 task contract。
3. Agent Runtime 收到任务后必须先校验 schema，再启动 WorkSession。
4. Room Broker 写入消息前必须校验 event envelope。
5. Control Plane 状态流转前必须校验 state machine。
6. 不符合 schema 的消息只能进入 DLQ，不能被 Agent 自然语言猜测执行。

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
| state transition | source state、target state、allowed actor、required evidence |
| command dispatch | idempotencyKey、policyDecisionRef、leaseRef、timeout、retry |
| mcp call | tool schema digest、grant、param policy、result filter、risk gate |
| checkpoint | workId、sessionId、stateVersion、artifactRefs、nextSteps |
| close barrier | required gates、open findings、reverify_required、DLQ、pending permission |

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

## 7. 后续代码生成约束

后续实现代码时，应从 `spec/` 生成：

1. TypeScript types。
2. runtime validators。
3. API request/response validators。
4. MCP tool schemas。
5. state transition guards。
6. fixture builders。
7. contract tests。

不要让实现代码手写一套和 `spec/` 不一致的对象模型。
