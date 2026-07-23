# 核心控制平面规格

## 1. 范围

本文档把总体设计收敛为终态控制平面规格，覆盖数据库核心表、HTTP API、MCP tools、事件模型、事务边界和可靠性规则。该规格的消费者是 Orchestrator、Agent Runtime、MCP Proxy、Scheduler、Monitor Agent 和自动化验证器，不是外部操作流程。

控制平面是系统权威状态来源。Agent Runtime、本地 SQLite、Room WS、MCP Proxy、UI 和外部脚本都不能越过控制平面直接改变权威状态。

## 2. 核心实体

```text
Project
  TaskGroup
    WorkItem
      WorkSession

AgentNode
Room
RoomMessage
Command
Lease
Checkpoint
Artifact
PermissionRequest
ApprovalRequest
DecisionRecord
AuditLog
```

终态规格不区分“先做/后做”的非系统执行阶段。所有实体都必须在 schema、state machine 和事件模型中拥有明确边界。具体编码时可以由 Orchestrator 按依赖 DAG 自动分批提交，但不能把未实现实体设计成需要非系统执行路径补齐的开放项。

## 3. 数据库核心表

### 3.1 projects

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| name | text | not null |
| status | text | active, archived |
| default_ruleset_ref | text | nullable |
| runtime_config | jsonb | not null default `{}` |
| created_at | timestamptz | not null |
| updated_at | timestamptz | not null |

### 3.2 task_groups

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| project_id | text | references projects |
| name | text | not null |
| delivery_stage | text | not null |
| goal_execution_status | text | not null |
| risk_level | text | L0, L1, L2, L3 |
| control_state_version | bigint | not null default 1 |
| owner_session_id | text | nullable |
| close_barrier | jsonb | not null default `{}` |
| created_at | timestamptz | not null |
| updated_at | timestamptz | not null |

### 3.3 work_items

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| project_id | text | references projects |
| task_group_id | text | references task_groups |
| title | text | not null |
| status | text | not null |
| priority | integer | not null default 100 |
| role_id | text | not null |
| input_locators | jsonb | not null default `[]` |
| input_digests | jsonb | not null default `{}` |
| write_scope | jsonb | not null default `[]` |
| dependencies | jsonb | not null default `[]` |
| acceptance | jsonb | not null default `{}` |
| assigned_session_id | text | nullable |
| created_at | timestamptz | not null |
| updated_at | timestamptz | not null |

### 3.4 work_sessions

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| project_id | text | references projects |
| task_group_id | text | references task_groups |
| agent_node_id | text | references agent_nodes |
| role_id | text | not null |
| status | text | not null |
| current_work_id | text | nullable |
| state_version | bigint | not null |
| model_assignment | jsonb | not null default `{}` |
| last_seen_at | timestamptz | nullable |
| created_at | timestamptz | not null |
| updated_at | timestamptz | not null |

### 3.5 agent_nodes

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| node_name | text | not null |
| status | text | joining, online, offline, read_only, quarantine |
| protocol_version | text | not null |
| runtime_version | text | not null |
| resource_profile | jsonb | not null default `{}` |
| model_profile | jsonb | not null default `{}` |
| tool_profile | jsonb | not null default `{}` |
| permission_profile | jsonb | not null default `{}` |
| trust_score | integer | not null default 100 |
| last_heartbeat_at | timestamptz | nullable |
| created_at | timestamptz | not null |
| updated_at | timestamptz | not null |

### 3.6 rooms 和 room_messages

`rooms`：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| project_id | text | references projects |
| task_group_id | text | nullable |
| type | text | project, task_group, sub |
| status | text | active, closed |
| next_sequence | bigint | not null default 1 |

`room_messages`：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| room_id | text | references rooms |
| sequence | bigint | not null |
| type | text | not null |
| priority | text | normal, important, p0 |
| sender_session_id | text | nullable |
| recipients | jsonb | not null default `[]` |
| state_version | bigint | not null |
| correlation_id | text | nullable |
| idempotency_key | text | not null |
| body | jsonb | not null |
| created_at | timestamptz | not null |

唯一约束：

```text
unique(room_id, sequence)
unique(room_id, idempotency_key)
```

### 3.7 commands

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| project_id | text | references projects |
| task_group_id | text | nullable |
| session_id | text | nullable |
| type | text | not null |
| status | text | created, admitted, dispatched, running, succeeded, failed, timed_out, cancelled, dlq |
| payload | jsonb | not null |
| idempotency_key | text | not null |
| attempt | integer | not null default 0 |
| max_attempts | integer | not null default 3 |
| timeout_at | timestamptz | nullable |
| result_ref | text | nullable |
| created_by | text | not null |
| created_at | timestamptz | not null |
| updated_at | timestamptz | not null |

唯一约束：

```text
unique(project_id, idempotency_key)
```

### 3.8 leases

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| project_id | text | references projects |
| task_group_id | text | nullable |
| resource_type | text | not null |
| resource_key | text | not null |
| owner_session_id | text | references work_sessions |
| fencing_token | bigint | not null |
| status | text | active, released, expired, transferred |
| expires_at | timestamptz | not null |
| created_at | timestamptz | not null |
| updated_at | timestamptz | not null |

唯一约束：

```text
unique(project_id, resource_type, resource_key) where status = 'active'
```

### 3.9 checkpoints 和 artifacts

`checkpoints`：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| project_id | text | references projects |
| task_group_id | text | references task_groups |
| work_item_id | text | references work_items |
| session_id | text | references work_sessions |
| state_version | bigint | not null |
| summary | text | not null |
| commit_refs | jsonb | not null default `[]` |
| evidence_refs | jsonb | not null default `[]` |
| next_steps | jsonb | not null default `[]` |
| created_at | timestamptz | not null |

`artifacts`：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| project_id | text | references projects |
| run_id | text | not null |
| type | text | not null |
| uri | text | not null |
| digest | text | not null |
| owner_session_id | text | nullable |
| sensitivity | text | public, internal, confidential, secret |
| metadata | jsonb | not null default `{}` |
| created_at | timestamptz | not null |

### 3.10 permission_requests

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| project_id | text | references projects |
| task_group_id | text | nullable |
| work_item_id | text | nullable |
| session_id | text | nullable |
| agent_node_id | text | references agent_nodes |
| status | text | observed, classified, routed_to_controller, approved, rejected, manual_action_required, reassigned, resolved, aborted |
| prompt_type | text | not null |
| requested_capability | text | not null |
| requested_resource | text | nullable |
| risk_level | text | not null |
| artifact_ref | text | nullable |
| safe_retry_point | jsonb | not null default `{}` |
| suggested_actions | jsonb | not null default `[]` |
| created_at | timestamptz | not null |
| updated_at | timestamptz | not null |

### 3.11 audit_logs

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | text | primary key |
| project_id | text | nullable |
| actor | text | not null |
| action | text | not null |
| resource | text | not null |
| params_digest | text | not null |
| result | text | not null |
| prev_hash | text | nullable |
| row_hash | text | not null |
| created_at | timestamptz | not null |

## 4. HTTP API

HTTP API 供 Orchestrator、Agent Runtime、系统 MCP adapter、自动化验证器和只读观察 UI 使用。所有写接口必须接收 `Idempotency-Key` header，并写入 audit。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/projects` | 创建项目 |
| GET | `/api/projects/:projectId` | 读取项目 |
| POST | `/api/task-groups` | 创建任务组 |
| GET | `/api/task-groups/:taskGroupId` | 读取任务组快照 |
| POST | `/api/work-items` | 创建 work item |
| POST | `/api/work-items/:workItemId/assign` | 分配或改派 |
| POST | `/api/rooms/:roomId/messages` | 发送 room message |
| GET | `/api/rooms/:roomId/messages?after=` | 按 cursor 补读消息 |
| POST | `/api/commands` | 创建 command |
| POST | `/api/leases/claim` | 获取 lease |
| POST | `/api/leases/:leaseId/release` | 释放 lease |
| POST | `/api/checkpoints` | 提交 checkpoint |
| POST | `/api/artifacts` | 注册 artifact |
| POST | `/api/permission-requests` | 提交权限阻断 |
| POST | `/api/agents/join` | 使用 join token 初始化 Agent |
| POST | `/api/agents/:nodeId/heartbeat` | Agent 心跳 |

## 5. MCP tools

系统必须内置以下 MCP tools。MCP tool 与 HTTP API 可以共用 service layer，但 MCP 调用必须经过 MCP Proxy、policy、lease、idempotency 和 audit。

| MCP server | tools |
| --- | --- |
| `orchestration-mcp` | `project_create`、`task_group_create`、`work_item_create`、`work_assign`、`state_get` |
| `room-mcp` | `room_join`、`room_send`、`room_wait`、`room_ack` |
| `agent-control-mcp` | `node_register`、`node_probe`、`session_start`、`session_pause`、`session_cancel`、`session_recover` |
| `resource-mcp` | `lease_claim`、`lease_release`、`resource_snapshot` |
| `model-mcp` | `model_capabilities`、`model_policy_get`、`model_select` |
| `evidence-mcp` | `artifact_register`、`checkpoint_submit`、`test_result_submit` |
| `permission-mcp` | `permission_probe`、`permission_request_submit`、`permission_status`、`permission_resolve` |

## 6. 事件模型

所有重要变化都写入 `room_messages` 或 `commands/outbox`，WS 只推送事件 ID。

事件 envelope：

```json
{
  "eventId": "evt_...",
  "projectId": "prj_...",
  "taskGroupId": "tg_...",
  "type": "checkpoint_submitted",
  "stateVersion": 12,
  "correlationId": "corr_...",
  "idempotencyKey": "checkpoint-work-1-run-1",
  "payloadRef": "db:checkpoints/chk_...",
  "createdAt": "2026-07-23T08:00:00Z"
}
```

## 7. 事务边界

| 操作 | 必须同事务完成 |
| --- | --- |
| 发送 room message | 插入 message、递增 room sequence、插入 outbox、写 audit |
| 创建 command | 插入 command、插入 outbox、写 audit |
| 获取 lease | 检查唯一 active lease、插入 lease、递增 fencing token、写 audit |
| 提交 checkpoint | 插入 checkpoint、更新 work/session 状态、递增 stateVersion、发送 checkpoint message、写 audit |
| PermissionRequest | 插入 request、更新 session 为 `permission_required`、发送事件、写 audit |

## 8. 可靠性规则

1. PostgreSQL 是权威状态，WS 掉线不能丢消息。
2. 所有消费者按 cursor 或 command id 补读。
3. 所有写接口必须有 idempotencyKey。
4. 所有副作用必须记录 command effect 或至少记录 resultRef。
5. lease 写入必须校验 fencing token。
6. `controlStateVersion` 变化后，旧 session 必须 rebind 或返回 `STALE_STATE`。
7. DLQ 不能静默堆积，必须出现在关闭屏障和告警中。
8. MCP tool result 进入上下文前标记为 untrusted。
9. Artifact 只在消息中传 locator 和 digest，不传大内容。
10. Secret 只以 secret ref 表达，不进入 room message、artifact 正文或普通日志。
