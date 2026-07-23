# 运行启动、管理界面、共享定义和仓库产出规范

## 1. 定位

本文把系统运行、后台管理、用户管理、项目进度可视化、指令压缩、共享定义归属和任务产出仓库归属收敛为可实现规范。对应机器对象为：

| 对象 | Schema |
| --- | --- |
| RuntimeBootstrapProfile | `spec/runtime-bootstrap.schema.json` |
| Account | `spec/account.schema.json` |
| AccessControlGrant | `spec/access-control-grant.schema.json` |
| ManagementConsoleSurface | `spec/management-console-surface.schema.json` |
| ProgressSnapshot | `spec/progress-snapshot.schema.json` |
| InstructionEnvelope | `spec/instruction-envelope.schema.json` |
| SharedDefinitionContract | `spec/shared-definition-contract.schema.json` |
| RepositoryOutputTarget | `spec/repository-output-target.schema.json` |

这些对象不是说明材料。Orchestrator、Scheduler、Agent Runtime、Policy Engine、Monitor 和 UI Console Service 必须按 schema、state machine 和 event envelope 执行。

## 2. 启动和初始化

系统必须支持三类直接启动入口：

| 入口 | 命令 | 机器语义 |
| --- | --- | --- |
| npm | `npm run init && npm start` | 初始化运行态并启动控制台服务 |
| Docker | `npm run docker:up` | 生成缺失环境值并构建、启动容器内控制台服务 |
| Shell | `npm run shell:start` | npm 记录的 shell 封装入口，内部调用 `./scripts/start.sh` 完成初始化和启动 |

初始化写入本地 `.runtime/` 运行态目录。`.runtime/` 不是项目产出目录，不进入 Git。npm/shell 默认使用 `runtime_json`；Docker Compose 设置 `AIMAC_STATE_STORE=postgresql`，HTTP server 和 MCP server 通过同一个 state-store 抽象读写 Postgres JSONB 权威状态。Docker 镜像不在 build 阶段初始化账号 token；容器运行时由 Compose 注入 token 和 `DATABASE_URL` 后执行 `shell:start`。无论使用哪种 state store，项目任务产出仍不得写入控制面文件库。

`RuntimeBootstrapProfile` 必须记录：

1. 支持的启动方式。
2. 初始化、启动、自检、Docker 构建、Docker 启动和 Shell 启动命令。
3. 系统服务清单和健康状态。
4. 运行态存储位置。
5. 管理账号 seed 策略。
6. 文件产出策略 `project_git_repository_only`。

## 3. 管理面边界

系统有两个管理面：

| 管理面 | 范围 |
| --- | --- |
| 系统管理系统 | runtime bootstrap、系统管理员、系统策略导入、审计、系统外升级结果导入 |
| 用户管理系统 | 项目创建、项目成员、任务组控制、Agent 激活、项目进度、任务组进度 |

管理面是控制和观察界面，不是项目执行者。它可以触发受控动作，例如暂停任务组、恢复任务组、请求复验、纠偏、激活 Agent、授权成员；每个写动作必须转为 `AccessControlGrant`、`PolicyDecision`、`DecisionRecord`、`Command` 或对应状态机事件，并写入 audit。

项目和 Agent 属于用户管理系统。有权限的用户账号可以：

1. 创建项目。
2. 邀请账号加入项目。
3. 给项目、任务组和 Agent 分配权限。
4. 激活或停用项目内可用 Agent。
5. 查看项目、任务组、工作项、阻塞、角色活动和仓库产出目标。

系统管理系统只处理系统级能力，不直接拥有项目文件、任务执行或 Agent 角色输出。

## 4. 账号和权限

账号类型：

| 类型 | 用途 |
| --- | --- |
| system_admin | 管理系统运行、审计、策略导入和系统外升级结果 |
| user_account | 管理用户侧项目、任务组、Agent 和成员 |
| service_account | 系统服务调用和自动化集成 |
| agent_identity | Agent Runtime 或角色会话的机器身份 |

授权必须通过 `AccessControlGrant` 表达，授权资源包括 `system_console`、`user_console`、`project`、`task_group`、`agent`、`system_policy`、`shared_definition`。授权状态必须可撤销、可过期、可审计，不能只存在 UI session。

## 5. 项目和任务组进度

`ProgressSnapshot` 是 UI 展示和 Monitor 计算的统一对象。项目和任务组视图必须至少显示：

1. 当前阶段。
2. 百分比进度。
3. 健康度。
4. 工作项计数。
5. 阻塞数和阻塞摘要。
6. 角色活动。
7. 仓库产出目标、提交引用和推送引用。
8. 更新时间和快照 digest。

进度不是聊天摘要。Monitor 从事件、checkpoint、状态机、gate 结果、RepositoryOutputTarget、CommitRef 和 PushRef 计算，UI 只消费计算后的 snapshot。

## 6. 指令格式和 token/cache 策略

总控、角色会话和任务组房间之间的指令必须使用 `InstructionEnvelope`。默认格式：

```text
stable_prefix_digest=<ruleset/role/base protocol digest>
effective_instruction_packet_ref=<effective packet id>
shared_definition_refs=<contract ids and digests>
input_locators=<short list>
delta_payload=<only changed request>
output_contract_ref=<schema or checkpoint contract>
cache_key=<stable deterministic key>
token_budget=<input/output limits and target delta tokens>
```

规则：

1. 稳定规则、角色说明、状态机和共享定义尽量用 digest/ref 引用，不在每轮重复粘贴。
2. 变量内容使用 delta payload，限定 role、scope、stop condition 和 output contract。
3. 多角色广播不得发送无界自由文本，必须发送可消费的 event envelope 或 checkpoint/ref。
4. 需要共用的术语、状态、接口、数据模型、错误码、设计 token 和质量标准必须引用 `SharedDefinitionContract`。
5. Cache key 必须由 role、ruleset digest、shared definition digest、task contract digest 和 output contract 组成，降低重复上下文成本。

## 7. 共享定义归属

多子项目、多子系统、多端或多仓库任务中，以下内容属于共享定义：

| 类型 | 示例 |
| --- | --- |
| terminology | 业务术语、阶段名称、核心实体命名 |
| api_contract | HTTP/RPC 接口契约 |
| data_model | DB schema、领域模型、DTO |
| event_schema | Room、队列、事件 payload |
| status_semantics | 任务、会话、发布、账号状态语义 |
| error_code | 错误码、异常分类、重试语义 |
| design_token | 颜色、间距、组件状态 |
| quality_standard | 测试、验收、性能、安全标准 |
| permission_semantics | 角色、授权、审批、外部能力边界 |
| instruction_format | Agent 间指令信封、输出契约 |

总控执行流程：

```text
detect_shared_definition_need
-> create SharedDefinitionContract(draft)
-> assign canonicalOwnerRole and producerRole
-> producer publishes definition digest into selected Git repository
-> reviewer verifies consumers and compatibility
-> orchestrator activates contract
-> consumers bind by digest
```

任何角色发现自己需要定义共享语义时，必须先提交 `DerivedTaskRequest` 或 `decision_request`。在 `SharedDefinitionContract` 进入 `active` 之前，依赖 work 不能各自发明自己的术语、状态、接口或标准。发现分歧时，Monitor 把合同标为 `conflicted`，Orchestrator 阻断依赖分支并要求 canonical owner 重新发布。

## 8. 仓库产出目标

项目任务的产出文件只保存到对应项目 Git 仓库。多仓库项目中，具体仓库由 Orchestrator 通过 `RepositoryOutputTarget` 决定。

`RepositoryOutputTarget` 必须包含：

1. projectId、taskGroupId、workItemId。
2. repositoryId、remote 和 repositoryUrl。
3. branch 和 baseRef。
4. pathAllowlist 和 pathDenylist。
5. decisionRecordRef。
6. leaseRef。
7. commitRefs。
8. pushRefs。
9. artifactManifestPath。
10. outputPolicy=`project_git_repository_only`。

执行流程：

```text
candidate
-> selected
-> lease_bound
-> writing
-> committed
-> pushed
```

规则：

1. Control Plane 不实现独立项目文件管理系统。
2. UI 不提供“上传项目产出文件”的文件库。
3. 证据、截图、日志和测试报告可以登记为 evidence/artifact metadata，但最终交付文件必须以 Git 仓库中的路径、commit、push 和 manifest 为准。
4. WorkSession 或短任务 subagent checkout、edit、commit 和 push 前必须持有对应 target 的 active repository/path lease。
5. Checkpoint 必须引用 `RepositoryOutputTarget`、CommitRef、PushRef 和 artifact manifest，并且必须绑定 active `AgentDispatch`、runId 和 taskContractDigest。
6. 多仓库任务中，Orchestrator 可以为不同 WorkItem 选择不同 repository target，但每个 writing WorkItem 只能写入自己被分配的 target 和 path scope。
7. PushRef 的 remote 必须等于 `RepositoryOutputTarget.remote`，且运行时本地 Git remote URL 必须等于 target 记录的 repositoryUrl。

## 9. 本地控制平面

当前仓库提供可直接运行的本地控制平面：

```bash
npm run init
npm start
```

默认地址：

```text
http://127.0.0.1:4317
```

AI-native 运行入口：

| 命令 | 机器语义 |
| --- | --- |
| `npm run doctor` | 校验 schema、控制平面、远程 Streamable HTTP MCP、一次性 Agent 入网、初始化/自检、按任务 Skill 工作集、远程 dispatch、Git commit/push、服务端远端取证和 checkpoint |
| `npm run contract:check` | 按 JSON schema 校验 runtime seed、生成的 McpGrant、MCP tool definition contract 和 state-store 写冲突检测 |
| 项目 UI 生成 Agent join token 后运行安装命令 | Agent 入网唯一入口；安装脚本和 Runtime 自动维护该节点的 Codex、Claude、Cursor 远程 MCP 配置 |
| `npm run mcp:start` | 与 `npm start` 等价，启动承载管理 API、Agent Gateway、Skill Registry 和 `/mcp` 的系统服务器；Agent 端不运行此命令 |
| `npm run mcp:doctor` | 校验远程 MCP 鉴权、`initialize`、scoped `tools/list`、`tools/call`、输入校验、idempotency、lease/fencing，以及本地 stdio 默认禁用 |
| `npm run agent:doctor` | 验证服务端安装脚本、一次性 join token、节点自检、远程 MCP、按任务 Skill 工作集、dispatch、Git 和 checkpoint 全链路 |
| `npm run skills:sync` | 仅在系统服务器同步 `DlenoDing/agency-agents-zh` pinned snapshot，解析后写入集中式 Skill Registry |
| `POST /api/orchestrator/run` | 由 Orchestrator 执行当前任务组自动调度循环，只投递 `AgentDispatch`，不伪造完成 |
| `POST /api/agent/v1/dispatches/next` | 由已注册远程 Agent Runtime 原子 claim durable dispatch |
| `GET /api/agent/v1/skill-worksets/:id` | 下发总控为当前角色/任务解析的最小 Skill 工作集 |
| `POST /api/agent/v1/dispatches/:id/checkpoint` | 控制平面从远端 Git 独立取证后接受节点 checkpoint |
| `POST /api/model-selection/decide` | 由 Scheduler/Model Registry 生成 `ModelSelectionDecision` |
| `POST /api/session-placement/decide` | 按长任务新会话、短任务子 agent 规则生成 `SessionPlacementDecision` |
| `GET /api/task-groups/:taskGroupId/readiness` | 计算 `CompletionReadinessCheck` 和 `CloseBarrier` |

控制台实现文件：

| 文件 | 用途 |
| --- | --- |
| `apps/control-plane-ui/server.mjs` | Node HTTP 控制平面、管理 API、Agent Gateway、远程 MCP transport、幂等命令和权限 guard |
| `apps/control-plane-ui/lib/agent-gateway.mjs` | 一次性入网、节点凭证、心跳、自检、dispatch claim 和 Skill 工作集下发 |
| `apps/control-plane-ui/lib/control-plane-core.mjs` | 模型 registry、skill registry、session placement、task contract、dispatch outbox、worker、checkpoint Git 证据、readiness 和 close barrier 核心逻辑 |
| `apps/control-plane-ui/lib/state-store.mjs` | 本地 JSON 与 Postgres JSONB 共用 state-store，确保 HTTP、MCP 和 CLI skill sync 入口读写同一权威状态，并用 `stateVersion` 检测并发写冲突 |
| `apps/mcp-server/server.mjs` | 由控制平面 `/mcp` 托管的远程 MCP JSON-RPC 处理器，提供 principal scope、policy、idempotency、audit 和结果过滤 |
| `apps/agent-runtime/runtime.mjs` | Agent 端唯一常驻组件；访问远程 MCP、同步最小 Skill 工作集、启动模型 Agent、提交 Git/checkpoint |
| `apps/control-plane-ui/public/index.html` | 管理控制台入口 |
| `apps/control-plane-ui/public/styles.css` | SaaS 管理界面样式 |
| `apps/control-plane-ui/public/app.js` | 系统管理、用户管理、项目、任务组、AI Runtime 和指令协议交互 |
| `data/seed-state.json` | 本地运行态 seed state |
| `scripts/init-control-plane.mjs` | 初始化当前 state-store；本地 JSON 写 `.runtime/control-plane-state.json`，Postgres 模式写 `aimac_control_plane_state.state` |
| `scripts/run-with-env.mjs` | 加载项目 `.env` 后执行 Node 入口脚本，供 npm/shell/MCP 启动复用 |
| `scripts/contract-check.mjs` | RuntimeBootstrapProfile、McpGrant 和 MCP tool schema contract check |
| `scripts/docker-up.sh` | 兼容 `docker compose` 与 `docker-compose` 的 Compose 启动入口 |
| `scripts/register-mcp-client.mjs` | 内部 MCP 协议诊断用配置生成器；必须显式传入 bearer token，不作为 Agent 注册步骤 |
| `scripts/doctor-mcp.mjs` | MCP server 协议级、输入校验、idempotency、lease/fencing 自检 |
| `scripts/doctor-agent-remote.mjs` | 远程 Agent 安装、注册、自检、Skill、模型执行、Git 和 checkpoint 自检 |
| `scripts/install-agent.sh` | 控制平面公开发布、Agent 端直接执行的轻量安装脚本 |
| `scripts/sync-agent-skills.mjs` | 拉取并索引默认角色 skill 源 |
| `scripts/doctor.mjs` | 本地控制面端到端自检 |

本地 JSON 运行态和 PostgreSQL 部署形态共享同一对象边界：UI 只消费经认证和资源 scope 过滤后的控制面状态，并发送受控命令；执行推进由 Orchestrator、Scheduler、Model Registry、Skill Registry、Agent Runtime、Monitor 等系统角色完成。

常规执行中，Agent Runtime 必须具备选中模型 provider 的凭证和可用模型 adapter。控制面通过 dispatch 传入 task contract、有效指令包、模型选择、role Skill 工作集和 RepositoryOutputTarget；Agent Runtime 要求 worktree 干净，拒绝 allowlist 外改动，统一 commit、push，把 checkpoint 写入本地 outbox，再由控制平面从远端 Git 独立 fetch 和核验。MCP、Skill Registry、调度和数据库均不下沉到 Agent 主机。

`AIMAC_ALLOW_LOCAL_DETERMINISTIC_WORKER=true` 仅作为 `AIMAC_EXECUTION_PROFILE=verification` 且目标仓库存在 `.aimac-verification-repository` 标记时的本地验证 fallback，用于证明 dispatch、Git、push、manifest 和 checkpoint 校验链路。生产 profile 不启用该路径；缺少凭证或 executor 时只返回 `credential_required` / `agent_runtime_executor_required`，不得伪造完成。
