# ai-multi-agent-ctrl

`ai-multi-agent-ctrl` 是一个多 Agent、多会话、多子 Agent 的项目全生命周期协作控制系统设计与实现仓库。

系统目标不是让多个 Agent 只在聊天室里交换消息，而是提供一个可调度、可恢复、可审计的协作运行时：由总控作为唯一人工入口，统一管理项目、任务组、工作项、会话、Agent 节点、MCP 工具、Git 写入面、规则、证据、审批、权限阻断和最终关闭。

## 当前状态

当前仓库处于设计落地初期，已经形成终态架构设计，并开始拆分为可实施规格。

| 文档 | 用途 |
| --- | --- |
| [多 Agent 多会话项目全生命周期协作系统设计](docs/multi-agent-project-orchestration-system-design.md) | 总体蓝图、核心对象、状态机、调度策略、MCP、安全、MVP 和终态约束 |
| [MVP v0.1 范围定义](docs/mvp-v0.1-scope.md) | 第一版必须做什么、不做什么、验收条件和阶段拆分 |
| [核心控制平面规格](docs/core-control-plane-spec.md) | 数据库核心表、API/MCP 工具、事件模型、事务边界和可靠性规则 |
| [Agent Runtime 协议](docs/agent-runtime-protocol.md) | Agent 入网、心跳、probe、session、artifact、权限阻断和恢复协议 |
| [实施待办拆分](docs/implementation-backlog.md) | 从设计到编码的任务拆分、优先级和依赖顺序 |

## 第一版原则

1. 先做低成本可运行闭环，不引入过重基础设施。
2. PostgreSQL 是权威状态库，WebSocket 只负责实时唤醒。
3. Agent 不是最小执行单位，`WorkSession` 才是调度、状态和回收的基本单元。
4. 所有写入型动作必须经过 scope、lease、policy、idempotency 和 audit。
5. 开发完成不等于验收完成，验收完成不等于线上质量达标。
6. 权限弹窗和授权缺失必须转为 `PermissionRequest`，不能让 Agent 自行越权或长期卡死。

## MVP 技术栈

| 层 | 选择 |
| --- | --- |
| 语言和仓库 | TypeScript monorepo |
| 控制服务 | Node.js + Fastify |
| 系统库 | PostgreSQL |
| Agent 本地库 | SQLite WAL |
| 实时通道 | WebSocket + PostgreSQL outbox/LISTEN-NOTIFY 唤醒 |
| MCP | 控制服务内置 MCP server/client adapter 和 MCP proxy |
| Artifact | 本地文件系统 + PostgreSQL metadata/digest/retention |
| UI | React + TanStack Query |
| 部署 | 单机 Docker Compose 起步 |

## 推荐实施顺序

1. 建立 TypeScript monorepo、数据库迁移和基础 CI。
2. 实现 Project、TaskGroup、Room、WorkItem、WorkSession、Command、Lease 的最小表和 API。
3. 实现 Room Broker HTTP/WS 和 outbox/inbox/DLQ。
4. 实现 Agent Runtime join、heartbeat、probe、session_start、checkpoint_submit。
5. 接入基础 MCP server 和 MCP proxy。
6. 接入 Git profile、artifact registry、permission request。
7. 实现总控 MVP 调度循环和操作台。

## 关键判断

当前阶段不要继续扩写大而全的蓝图。下一步应把 `docs/mvp-v0.1-scope.md`、`docs/core-control-plane-spec.md` 和 `docs/agent-runtime-protocol.md` 固化成代码结构、数据库迁移、接口 schema 和最小端到端用例。
