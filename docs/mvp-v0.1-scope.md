# MVP v0.1 范围定义

## 1. 目标

MVP v0.1 的目标是做出一个单机可运行的多 Agent 协作控制闭环，验证以下核心能力：

1. 总控可以创建项目、任务组、工作项和会话。
2. Agent Runtime 可以一键加入系统并上报资源、模型、工具和权限画像。
3. Room Broker 可以可靠传递结构化事件、ACK、cursor 和 wake。
4. Scheduler 可以按 write scope、Agent 资源和模型策略派发 work session。
5. WorkSession 可以提交 checkpoint、evidence、finding 和 completion。
6. 写入型操作必须经过 lease、idempotency、audit 和 command effect 记录。
7. 权限阻断可以转成 PermissionRequest 并由总控裁决后恢复或改派。

MVP v0.1 不追求完整自动化项目交付，只追求控制面可靠闭环。

## 2. 必做范围

| 模块 | v0.1 必做能力 |
| --- | --- |
| Project | 创建、读取、状态、默认 ruleset、runtime config locator |
| TaskGroup | 创建、阶段、`goalExecutionStatus`、`controlStateVersion`、关闭屏障 |
| WorkItem | 输入 locator、写入面、依赖、验收条件、状态流转 |
| WorkSession | session 创建、状态、当前 work、最后心跳、模型分配 |
| Room Broker | `room_join`、`room_send`、`room_wait`、`room_ack`、消息持久化 |
| Command Bus | command、attempt、timeout、retry、cancel、resultRef、DLQ |
| Lease | 项目级资源唯一锁、TTL、fencing token、释放和转交 |
| Agent Gateway | join token、node register、heartbeat、resource/model/tool probe |
| MCP Proxy | 系统内置 MCP 工具注册、schema digest、tool grant、审计 |
| Evidence | artifact metadata、digest、runId、owner、sensitivity、retention |
| Permission | permission probe、permission request、resolution delta、安全重试点 |
| Monitor | heartbeat 中断、DLQ 堆积、lease 超时、artifact 写入失败告警 |

## 3. 明确不做

v0.1 不做以下事项：

1. 不做多租户商业化计费。
2. 不做 Kubernetes 部署。
3. 不接 Temporal、NATS、Vault、OPA、OpenFGA、MinIO、Prometheus/Grafana/Loki。
4. 不做完整 UI 设计系统，只做可操作的管理台骨架。
5. 不做全自动生产发布，生产动作只记录协议和审批对象。
6. 不做跨仓原子提交，只记录 run-level manifest 和可恢复 checkpoint。
7. 不让 Agent 自动点击 OS 高风险权限弹窗。

## 4. 验收场景

### 4.1 单 Agent 文档工作

1. 总控创建 Project 和 TaskGroup。
2. 创建一个只读 WorkItem。
3. Agent 加入并上报资源、模型和 MCP 画像。
4. Scheduler 分配 WorkSession。
5. WorkSession 读取任务、提交 checkpoint 和 evidence。
6. 总控关闭 WorkItem。

通过条件：状态、room message、checkpoint、artifact、audit 均可查询。

### 4.2 两 Agent 写入冲突

1. 两个 WorkItem 声明同一 `file_path` write scope。
2. Scheduler 只允许一个 session 获取 lease。
3. 另一个 session 进入等待或被拆 scope。
4. lease 释放后第二个 session 才能继续。

通过条件：不存在两个 active owner 同时持有同一 `project_id + resource_type + resource_key`。

### 4.3 权限阻断恢复

1. Agent 执行中遇到缺少 Git/MCP/OS 权限。
2. Runtime 生成 PermissionRequest。
3. Session 暂停新副作用。
4. 总控选择 grant、manual action、reassign、reject 中的一种。
5. Runtime 收到 resolution delta 后从 safe retry point 恢复或中止。

通过条件：阻断不会变成沉默卡死，且 audit 中有完整决策链。

### 4.4 断线恢复

1. Agent 在 session 执行中断线。
2. 本地 outbox 保存未上传 checkpoint 或 permission event。
3. 重连后先 flush outbox，再按 cursor 拉取最新 state。
4. 若 `controlStateVersion` 过期，返回 `STALE_STATE`，不产生新副作用。

通过条件：消息不丢失、不重复生效、过期状态不继续写。

### 4.5 MCP 写工具幂等

1. WorkSession 调用一个写入型 MCP tool。
2. MCP Proxy 校验 grant、参数策略、lease 和 idempotencyKey。
3. 第一次调用写入 `command_effects`。
4. 重复调用同一 idempotencyKey 返回同一结果或拒绝重复副作用。

通过条件：不会因为重试产生重复提交、重复部署或重复写库。

## 5. 阶段切分

| 阶段 | 交付 |
| --- | --- |
| v0.1.0 | TypeScript monorepo、PostgreSQL migration、基础配置、健康检查 |
| v0.1.1 | Project/TaskGroup/WorkItem/Room API 和数据库 |
| v0.1.2 | Command/outbox/inbox/DLQ、lease、audit |
| v0.1.3 | Agent Runtime join、heartbeat、probe、本地 SQLite |
| v0.1.4 | session_start、checkpoint、artifact、finding |
| v0.1.5 | MCP Proxy、tool grant、permission request |
| v0.1.6 | 总控调度循环、最小管理台、端到端验收 |

## 6. v0.1 关闭条件

1. 五个验收场景全部有自动化或可重复手工脚本。
2. 所有核心写入接口都有 idempotencyKey。
3. 所有状态变更写 audit。
4. 所有 WS 消息都可从 PostgreSQL 按 cursor 补读。
5. Agent 断线恢复不会丢失本地 outbox。
6. 文档、schema、API、MCP tool 名称一致。
