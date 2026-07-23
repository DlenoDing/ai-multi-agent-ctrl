# 实施待办拆分

## 1. 拆分原则

1. 先打通单机闭环，再扩展复杂治理。
2. 先实现权威状态和可靠事件，再实现 UI 美化。
3. 先实现系统内 MCP 和 Agent Runtime，再接第三方项目 MCP。
4. 每个任务都必须有验收脚本或可重复手工验收步骤。
5. 所有写入面相关任务必须同时交付 audit 和 idempotency。

## 2. P0 任务

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| P0-001 | 初始化 TypeScript monorepo、lint、test、build、Docker Compose | 无 | `npm test`、`npm run build`、compose healthcheck 通过 |
| P0-002 | PostgreSQL migration 基础设施和核心表 | P0-001 | 可创建 schema，可回滚，可 seed admin/project |
| P0-003 | Project/TaskGroup/WorkItem CRUD service | P0-002 | API 创建项目、任务组、work item 后可查询 |
| P0-004 | Room Broker 表、HTTP API、WS、ACK、cursor | P0-002 | 断开 WS 后能按 cursor 补读 |
| P0-005 | Command Bus、attempt、timeout、retry、DLQ | P0-002 | command 失败重试后进入 DLQ 并告警 |
| P0-006 | 项目级 Lease Manager | P0-002 | 同一资源不能被两个 active session 同时持有 |
| P0-007 | Audit service 和 append-only 写入 | P0-002 | 所有写 API 产生 audit row |
| P0-008 | Agent join token、node_register、heartbeat | P0-003 | Agent 一条命令加入并显示 online |
| P0-009 | Agent resource/model/tool/permission probe | P0-008 | 节点画像入库并生成 digest |
| P0-010 | session_start 和 WorkSession 状态流转 | P0-004, P0-006, P0-008 | 总控能派发 session 并收到 checkpoint |
| P0-011 | Checkpoint 和 Artifact metadata | P0-010 | checkpoint 绑定 artifact digest 和 runId |
| P0-012 | MCP Proxy 最小实现和系统 MCP tools | P0-004, P0-007 | MCP 调用经过 grant、audit 和 idempotency |
| P0-013 | PermissionRequest 流程 | P0-010, P0-012 | Agent 缺权后回传、暂停、处理、恢复 |
| P0-014 | 最小 Scheduler | P0-006, P0-009, P0-010 | 按 ready work、lease、Agent 画像派发 |
| P0-015 | Monitor 和基础告警 | P0-004, P0-005, P0-008 | heartbeat 中断、DLQ、lease 超时可见 |

## 3. P1 任务

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| P1-001 | Ruleset version 和 rules_get | P0-003 | session 启动携带 ruleset digest |
| P1-002 | Git profile 和 repository checkout metadata | P0-008 | Agent 可按授权 repo profile 准备 checkout |
| P1-003 | 基础 Git MCP tools | P1-002, P0-012 | status/diff/commit/push 都有 audit |
| P1-004 | Contract Registry 最小表和 compatibility placeholder | P0-002 | WorkItem 可绑定 contract digest |
| P1-005 | Finding lifecycle | P0-011 | finding 可进入 triage、fixed、reverified |
| P1-006 | Command Effects | P0-005, P0-012 | 写操作记录 before/after 和 rollback ref |
| P1-007 | Agent trust score 和 admission 降级 | P0-009 | 违规节点自动 read_only 或 quarantine |
| P1-008 | 管理台骨架 | P0-003, P0-004, P0-008 | 可查看项目、任务组、room、agent、lease、DLQ |
| P1-009 | Artifact verify 和 GC | P0-011 | digest 校验和 TTL 清理可执行 |
| P1-010 | 备份恢复 runbook 和 smoke test | P0-002, P0-011 | 恢复临时库后核心 API 可用 |

## 4. P2 任务

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| P2-001 | IntegrationBatch 和 merge queue | P1-002, P1-006 | 多 ChangeSet 可进入 batch CI |
| P2-002 | ExecutionEnvironment snapshot | P0-011 | 测试证据绑定环境 snapshot |
| P2-003 | ApprovalRequest 状态机 | P0-007 | 高风险 action 需要 quorum 后执行 |
| P2-004 | Knowledge Index | P1-001, P0-011 | rules/docs/checkpoint/evidence 可检索 |
| P2-005 | 细粒度 policy UI | P0-012, P0-013 | tool grant 可按 repo/path/table/domain 限制 |

## 5. 第一批编码建议

第一批 commit 应只包含工程骨架：

1. `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`。
2. `apps/control-plane`。
3. `apps/agent-runtime`。
4. `packages/protocol`。
5. `packages/db`。
6. `docker-compose.yml`。
7. 初始 migration 和 seed。

第二批 commit 再做 Project/TaskGroup/Room/Command/Lease，不要一次塞入 Agent 和 MCP。

## 6. 风险记录

| 风险 | 处理 |
| --- | --- |
| P0 范围过大 | 按 v0.1.0 到 v0.1.6 拆小批，每批可运行 |
| PostgreSQL outbox 被误当消息中间件无限扩展 | 明确吞吐阈值，达到后再引入 NATS JetStream |
| MCP tool 直接暴露给 session | 所有 MCP 调用必须经过 proxy service |
| Agent 权限弹窗导致卡死 | Runtime 必须实现 permission_report 和 safe retry point |
| 多会话互相覆盖文件 | 所有写入型 work 必须先获取 project-level lease |
| 文档和代码漂移 | protocol package 中 schema 为准，文档链接到 schema 文件 |
