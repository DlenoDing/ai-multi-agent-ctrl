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

`npm run dev` 与 `npm run mcp:start` 都与 `npm start` 是同一条命令（没有热重载之类的区别；MCP 与控制台同端启动），留给习惯敲这两个名字的人。

默认控制台地址：

```text
http://127.0.0.1:4317
```

登录需要**两样**：登录账号和令牌。`npm run init` 会把它们一起打印出来：

```text
system admin login: system.admin@local  (在登录页「登录账号」处填它)
local bootstrap token: ...              (与上面的登录账号配合使用)
```

登录账号填 `system.admin@local`（或用 `AIMAC_SYSTEM_ADMIN_EMAIL` 指定的邮箱），令牌填 bootstrap token。
本机访问时登录页也会显示这两项的提示；远程部署不显示（在公开页面上点名管理员账号等于把凭据的一半交出去）。

其他入口：

```bash
npm run doctor
npm run mcp:doctor
npm run agent:doctor
npm run agentctl -- doctor --server=http://127.0.0.1:4317
npm run skills:sync
npm run shell:start
npm run docker:up
```

`npm run doctor` 是**全量**验收，按顺序跑六段：`npm run validate`（十一道快门，约 70 秒）→
控制平面 e2e → 远程 Streamable HTTP MCP e2e → 公网 Agent Runtime e2e →
**docker compose e2e（要装 Docker：它会构建镜像并起一台 PostgreSQL）** → **完整变异门（约 7 分钟，
870+ 条，逐条验证「守卫失效时确实有东西变红」）**。整条跑完大约半小时，且**没有 Docker 会在第五段失败**。
平时改完代码想快速自证，跑 `npm run validate` 加那三条 e2e 就够（本仓的提交脚本就是这么做的）。
Agent 验收覆盖项目管理 UI/API 生成一次性 join token、服务端脚本下载与 SHA256 校验、自动注册、初始化、自检、远程 MCP 鉴权、按任务同步最小 Skill 工作集、模型 executor、Git commit/push、服务端远端 Git 复验和 checkpoint。`npm run skills:sync` 只在系统服务器同步 `DlenoDing/agency-agents-zh` pinned commit，并通过共享 state-store 建立 Skill Registry；Agent 主机不运行此命令，也不保存完整 Skill 仓库。

服务器级环境变量只放系统服务自身需要的 secret：

```bash
export AIMAC_PUBLIC_URL=https://control.example.com
export AIMAC_BOOTSTRAP_TOKEN='<system-admin-bootstrap-token>'
export AIMAC_MCP_SERVICE_TOKEN='<central-mcp-service-token>'
```

运维会用到的运行参数（其余的都是内部调参，改它们之前先读源码里那一处的注释）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AIMAC_HOST` | `127.0.0.1` | 监听地址。对外监听（`0.0.0.0`）时必须同时给 `AIMAC_PUBLIC_URL`，否则启动会被拒 |
| `AIMAC_PORT` | `4317` | 监听端口（写 0 则随机挑一个可用端口，启动横幅会显示真正绑上的端口；下限 0） |
| `AIMAC_PUBLIC_URL` | 按监听地址推导 | 对外访问地址。它会进安装命令与 MCP 端点，明文远程地址会被拒 |
| `AIMAC_RUNTIME_DIR` | `.runtime` | 运行态落盘目录（状态、项目分片、审计台账、锁） |
| `AIMAC_REPOSITORY_ROOT` | 仓库根 | 核验档位下本机工作副本的根目录 |
| `AIMAC_EXECUTION_PROFILE` | `production` | `verification` 时控制面自己跑工作器（只用于本机核验） |
| `AIMAC_ORCHESTRATOR_INTERVAL_MS` | `60000` | 后台自治周期。**写 0 关掉它**：关掉后不再产生新派发，但【已排队的派发仍会被在线 agent 领走】，要连它们一起停到任务组页「暂停执行」（下限 5000，更小的值按它生效） |
| `AIMAC_TRANSITION_STRICT` | `true` | 非法状态迁移一律拒绝；`false` 是宽松模式（放行但记账） |
| `AIMAC_TRUST_PROXY` | `false` | 置于反向代理之后时才开，决定是否采信 `X-Forwarded-*` |
| `AIMAC_MAX_EXECUTION_ATTEMPTS` | `3` | 同一工作项连续失败多少次后停止自动重派（停下来之后由人在「人工指令」页处置）（下限 1，更小的值按它生效） |

本地演示/验收账号可选用 seed 覆盖变量；生产环境应在管理界面里创建用户、项目成员、任务组授权和服务账号授权，不把用户或项目凭证作为统一服务器 secret：

```bash
export AIMAC_LOCAL_SEED_WORKSPACE_OWNER_TOKEN='<local-dev-only-owner-token>'
export AIMAC_LOCAL_SEED_REVIEWER_TOKEN='<local-dev-only-reviewer-token>'
export AIMAC_LOCAL_SEED_AGENT_RUNTIME_TOKEN='<local-dev-only-service-token>'
```

MCP 是控制平面服务器的一部分，由 `npm start` 或 Docker 同端启动，固定入口为：

```text
https://control.example.com/mcp
```

MCP 请求必须携带节点 token、系统管理员 session 或服务 token；Agent 节点只能看到并调用 join token 所授予的工具，服务 token 默认只绑定 `prj_control_plane`，生产环境用 `AIMAC_MCP_SERVICE_PROJECT_IDS` 明确配置可见项目。生产 MCP 不提供服务端代执行 Agent 任务的工具，任务必须由已注册节点从 Agent Gateway claim。

Agent 加入必须在管理界面完成：系统管理员或有项目 `agent:activate` 权限的账号登录后，进入「项目管理」→「项目设置」→「智能体接入」，生成绑定该项目、角色范围、MCP allowlist、有效期和一次使用次数的 join token。界面返回直接执行命令和 SHA256 校验版命令，典型形式如下：

```bash
curl -fsSL https://control.example.com/install-agent.sh | sh -s -- \
  --server https://control.example.com \
  --join-token-file /path/to/0600.join-token
```

安装脚本只下载轻量 `agent-runtime.mjs`，校验服务端发布的 SHA256，注册节点、探测本机模型/工具、自动生成并维护 `$AIMAC_AGENT_WORK_DIR/mcp-client-configs/` 下的远程 MCP 配置、执行自检并启动轮询进程。它不会安装或启动 MCP server、PostgreSQL、控制平面、Skill Registry，也不会同步完整 Skill 仓库。默认不会把长期 node token 写入 Codex/Claude/Cursor 等用户全局配置；只有显式传 `--configure-global-clients` 时才把远程 MCP 配置合并到本机全局客户端配置。总控为每个 dispatch 解析有效 role skill 和项目/任务组 overlay，Agent 只下载摘要绑定的最小工作集；下级角色必须取得总控单独签发的工作集，不能隐式继承或自行选择。

注册后交互链路固定为服务器集中式：Agent Runtime 使用一次性 join token 调用 `/api/agent/v1/register`，服务端签发唯一 node token 并只保存 digest；后续用 node token 调用 `/api/agent/v1/heartbeat`、`/self-check`、`/dispatches/next`、`/skill-worksets/:id`、`/control`、`/events`、`/checkpoint` 和 `/fail`。执行中的 MCP 工具调用统一走公网 `/mcp` Streamable HTTP，并受 node/project/dispatch 绑定的 MCP grant 限制。节点 token 可按节点撤销或轮换，服务端撤销节点时会停止后续 claim、冻结运行中的 dispatch、立即撤销 dispatch MCP grant，并在 Agent ACK 停止后重新入队。

服务端对 Agent 的实时控制不依赖反连 Agent 主机。Agent 通过 node token 长轮询 `/api/agent/v1/control`，拉取持久化 `AgentControlCommand`；命令被拉取后进入 `delivered`，Agent 先 ACK `received`，对 `pause_dispatch`、`cancel_dispatch`、`revoke`、`shutdown` 会终止执行器进程组并在停止确认后 ACK `completed` 或 `failed`。服务端在投递 pause/cancel/revoke/shutdown 时立即冻结对应 dispatch/session/work item，撤销该 dispatch 的 MCP grant，后续 checkpoint 会被拒绝，不能等 Agent 最终回传才生效；只有 Runtime 完成 ACK 后才 requeue 或 offline/revoked。Agent 执行过程中不会等到最终 checkpoint 才回送结果，而是持续向 `/api/agent/v1/events` 提交带 `eventKey` 的幂等 `AgentExecutionEvent`，覆盖 dispatch 接收、Skill 同步、模型启动、模型输出摘要、仓库变更、commit、push、checkpoint 准备和提交等阶段。管理界面默认只显示汇总，点击任务组详情、work session 或某个 dispatch 后长轮询实时事件流。

项目数据按项目隔离落盘：任务组、session、dispatch、contract、checkpoint、仓库输出目标、控制命令和近期事件投影写入 `.runtime/project-db/p_<projectId_sha256>.<generation>.state.json`，PostgreSQL 模式写入 `aimac_project_state_shards` 的项目行；中央 control-plane state 只保留系统级数据、项目 shard 索引和非项目对象，并以 generation、payload digest 和 size 指向当前有效 shard。完整执行事件追加到 `.runtime/project-db/p_<projectId_sha256>.execution-events.jsonl` 当前段，超过阈值后轮转为 `.runtime/project-db/p_<projectId_sha256>.execution-events.<firstSeq>-<lastSeq>.<sealedAt>.jsonl`，并维护 `.runtime/project-db/p_<projectId_sha256>.execution-events.manifest.json`、按 `dispatchId + eventKey` 作用域的 KV 索引和 tail-window 读取，避免项目多、任务多或模型过程输出多时撑爆单个全局状态文件或单个项目事件文件。旧 eventKey-only 索引首次触碰项目时会在项目事件锁内重建为 v5；大项目可能在第一笔事件追加上多花一次重建时间，之后回到 tail-window/KV 热路径。

Codex/Claude/Cursor 等 Agent 侧远程 MCP 配置由安装脚本和 Runtime 使用该节点的 node token 自动生成、刷新和维护。不要把 `scripts/register-mcp-client.mjs` 当作 Agent 入网步骤；它只保留给内部协议诊断，并且必须显式传入 bearer token。

容器以**非 root**（镜像自带的 `node` 用户）运行，端口只发布控制面自己那一个；
PostgreSQL 只绑回环 `127.0.0.1:55432`（Docker 的端口发布会绕过宿主防火墙，绑 0.0.0.0
等于把整份状态所在的库放到公网上）。
**从更早的版本升级时**：那时容器是 root 跑的，已存在的 `aimac-runtime` 卷属主是 root，
换成非 root 之后写不进去。升级前执行一次
`docker run --rm -v aimac-runtime:/v alpine chown -R 1000:1000 /v`（`node` 用户的 uid 是 1000），
或者干脆删掉这个卷让它重建（里面是运行时配置与技能源缓存，权威状态在 PostgreSQL 里）。

Docker 镜像不在 build 阶段执行 bootstrap init，避免随机管理 token 写入镜像层。`npm run docker:up` 会在 `.runtime/docker.env` 生成缺失的本地验证 token 和 `POSTGRES_PASSWORD`，再由 Compose 在容器运行时注入 `AIMAC_PUBLIC_URL`、`AIMAC_BOOTSTRAP_TOKEN`、`AIMAC_MCP_SERVICE_TOKEN`、本地 seed 账号 token 和 `DATABASE_URL`，通过 `shell:start` 初始化并启动控制面、Agent Gateway、Skill Registry 与远程 MCP。共享环境必须用真实外部 secret 和 HTTPS 反向代理覆盖这些本地生成值。

`npm run init` 会生成本地系统 bootstrap token、本地 seed 用户账号 token 和中央 MCP service token。系统管理员账号使用 bootstrap token；普通用户、项目管理员和服务账号使用各自账号 token 或后续管理界面生成的授权，不能用 bootstrap token 直接登录任意账号。Agent 可见的凭证不是这些 seed token，而是每次项目 join token 消费后由服务端签发的唯一 node token。

常规 Agent Runtime 必须具备选中模型 provider 的凭证。Runtime 会优先调用已探测到的 Codex、Claude 或 Gemini CLI，也可在安装时用 `--executor-command` 绑定其他模型/Agent 适配器；executor 接收 task contract、有效指令包、远程 MCP 和 Skill 工作集路径。`AIMAC_EXECUTION_PROFILE=verification` 才能使用服务器内的确定性验证 worker；生产 profile 永远由远程注册节点执行，缺少模型适配器或凭证时只能上报失败，不能在服务器伪造完成。

## 模型选择与精确钉模型

默认是**按能力自动选型**：控制面对模型能力注册表按角色技能、任务性质（深度分析/实现/验证等）、模型天花板打分，选出合格的最高分模型，并留一条 `ModelSelectionDecision` 审计。系统内置约 19 个 provider 的默认模型（OpenAI、Anthropic、Google、xAI、Meta、Mistral、DeepSeek、通义千问、月之暗面、智谱、百度文心、腾讯混元、OpenRouter、Azure OpenAI、AWS Bedrock、Google Vertex AI、Ollama、vLLM、自定义），可在管理界面「系统管理」→「系统设置」→「模型能力注册」查看，或读 `/api/model-registry`；也可通过模型注册端点新增/覆盖模型（含 `custom` 类接入自有模型）。

需要**精确指定某个模型**时用 `pinnedModelId`（取值可以是注册表里的 modelId、providerId 或别名，如 `anthropic:claude-sonnet-4-5`），三条入口：

- **界面**：任务组页「创建工作项」表单的「指定模型（可选）」下拉。默认「自动」；选定后写在工作项上，回显在工作项卡的「指定模型」一行。
- **MCP**：给 `model_select` 传 `pinnedModelId` 立即钉住本次选型；给 `work_item_create` 传 `pinnedModelId` 把模型钉在工作项上，该工作项**每次派发都只用这个模型**。
- **REST**：建工作项与选型决定的请求体都接受 `pinnedModelId`。

语义要点：钉模型只把候选收窄到那一个，**被钉的模型仍要满足其余硬性约束与任务天花板**——钉一个不满足的模型不会绕过治理，而是判定无候选、把工作项挂成阻塞交人工处置，绝不会静默换成别的模型。取值优先级为「本次调用显式传的 > 请求硬约束里带的 > 工作项上钉的」。填的模型不在注册表里会当场拒绝（`pinned_model_not_registered`），不会被当作没填。

## 生产高并发边界

当前代码路径按“简单可运行的单控制面进程 + PostgreSQL 权威状态 + 项目事件分片”实现。它适合单实例生产、小集群前验证和中等并发任务编排；高并发高流量部署必须使用 PostgreSQL，前置 HTTPS 反向代理，并明确收窄系统、项目、Agent node 与 MCP service token 的 scope。

多控制面实例不是简单把同一镜像横向复制即可完成的能力。启用多实例前必须补齐并压测：跨实例 WebSocket fanout、后台自治 tick 的 leader election 或外部调度锁、可靠 outbox、LISTEN/NOTIFY 或消息队列、agent dispatch claim 的全局 fencing 指标，以及失败实例恢复后的幂等重放。未补齐前，生产部署应保持一个写入控制面实例，读流量通过缓存、摘要端点、项目事件索引和 MCP allowlist 控制成本。

## 会放宽默认限制的开关

下面这些环境变量【降低】默认的安全/隔离强度。默认全都不开；审计一套部署时，先看这几个。
每一条的判定都在代码里，不是文档里的约定 —— 下面写的就是那处判定在做什么。

| 开关 | 不设时（默认） | 设了之后 |
| --- | --- | --- |
| `AIMAC_ALLOW_INSECURE_PUBLIC_URL=true` | 非本机的公开地址必须是 HTTPS，否则启动就拒 | 允许用明文 HTTP 作为公开地址 |
| `AIMAC_AGENT_ALLOW_INSECURE_HTTP=true` | agent 连非本机网关必须走 HTTPS | 允许 agent 用明文 HTTP 连网关 |
| `AIMAC_ALLOW_INSECURE_REMOTE_MCP=true` | 生成 MCP 客户端配置时，非本机地址必须 HTTPS | 允许把明文 HTTP 的 MCP 地址写进客户端配置 |
| `AIMAC_MCP_ALLOW_FULL_STATE=true` | MCP 的 `scope=full` 一律拒（连租户内也拒：整份转储远超 agent 所需） | 允许经 MCP 取回整份（脱敏后的）状态 |
| `AIMAC_ALLOW_LOCAL_DETERMINISTIC_WORKER=true` | 请求里的 `allowDeterministicLocalWorker` 无效 | 允许用本地确定性工作器代替真实 agent 执行 |
| `AIMAC_PROJECT_EVENT_ALLOW_FULL_KEY_SCAN=true` | 事件索引取不到键时不做全量扫描（避免大目录上的长停顿） | 允许全量扫描键空间 |
| `AIMAC_ALLOWED_PUBLIC_HOSTS=a,b` | 只接受本机 Host 头 | 额外接受列出的这些 Host |

反方向的一个（**收紧**，不是放宽，列在这里是免得有人以为它和上面同族）：

| 开关 | 作用 |
| --- | --- |
| `AIMAC_ALLOW_LOCAL_GIT_REMOTE=false` | 默认允许 `file://` 与本地路径作为仓库地址（本地部署与自检要用）。多租户托管部署应当设成 `false`：否则租户自填的 repositoryUrl 能让共享宿主去 fetch 宿主上的任意本地仓库 |
| `AIMAC_MCP_SERVICE_ALLOWED_TOOLS=...` | 收窄服务令牌能调的 MCP 工具集 |

## 容量与保留期旋钮

系统里有一批**只增不减的历史**（策略决策、准入判决、协作消息、幂等记录…）。它们都有上限：
到量之后**最老的会被丢掉**，控制台会如实说出来 —— 「这些历史记录已被容量上限丢弃，不在系统里了
（还在跑或还等着人处置的从不淘汰）」。看到那句话而觉得留得太少时，调这里的环境变量再重启。

这些值**没有界面入口**，环境变量是唯一的杠杆，所以列在这里；默认值由 `scripts/contract-check.mjs`
逐个对着代码核对，改了代码不改这张表会报红。

| 环境变量 | 默认 | 它兜住什么 | 到量时人看到什么 |
| --- | --- | --- | --- |
| `AIMAC_POLICY_DECISIONS_CAP` | `500` | 策略决策（每次受守卫的写入一条）；被活跃授权引用的从不淘汰（下限 100，更小的值按它生效） | 授权的「凭什么发的」查不到更早的 |
| `AIMAC_ADMISSION_DECISION_CAP` | `400` | 准入判决；每个活单元的最新一条从不淘汰（下限 50，更小的值按它生效） | 更早的「为什么这一轮没跑它」查不到 |
| `AIMAC_ADMISSION_SCAN_CAP` | `200` | 每轮编排的准入扫描快照 | 同上，按任务组保留 |
| `AIMAC_TASK_GROUP_BLOCKER_CAP` | `50` | 单个任务组同时挂着的阻塞项（下限 10，更小的值按它生效） | 阻塞项列表下方说明有多少条没列出 |
| `AIMAC_ACTIVE_SESSION_CAP` | `5000` | 活跃工作会话总数（下限 200，更小的值按它生效） | 超出后新会话建不出来 |
| `AIMAC_IDEMPOTENCY_MAX_RECORDS` | `5000` | 幂等记录条数（写路径与落盘用同一个值）（下限 100，更小的值按它生效） | 太老的幂等键会被当成新请求（重放不再去重） |
| `AIMAC_MCP_SUMMARY_CAP` | `25` | MCP 摘要视图每个集合的条数 | agent 拿到的摘要只含最近若干条 |
| `AIMAC_MCP_SUMMARY_WORK_ITEM_CAP` | `20` | MCP 摘要里每个任务组内嵌的工作项数（下限 5，更小的值按它生效） | 同上 |
| `AIMAC_MCP_AUDIT_MAX_BYTES` | `67108864` | MCP 调用台账单文件大小（64 MiB），到量轮转（下限 1048576，更小的值按它生效） | 更早的调用记录进了轮转文件 |
| `AIMAC_MCP_AUDIT_ROTATIONS` | `20` | 保留多少份轮转出去的 MCP 调用台账；超过的按最旧删除（默认约 1.28 GiB 之后开始丢最早的 agent 调用记录，不告警） | 更早的记录不在任何地方了 |
| `AIMAC_ALLOW_INSECURE_PUBLIC_URL` | `false` | 允许 `AIMAC_PUBLIC_URL` 用 http 指向非本机主机（否则启动被拒，且对外地址回落成本机） | 会话令牌、入网令牌明文走网络 |
| `AIMAC_ALLOWED_PUBLIC_HOSTS` | 空 | 逗号分隔的 Host 头白名单；不在名单里的 Host 一律按本机地址算，防止把对外地址算成攻击者给的域名 | 反代域名没登记时装机地址会错 |
| `AIMAC_ALLOW_LOCAL_GIT_REMOTE` | `true` | 允许项目仓库指向本机路径/`file://`（本地部署与 e2e 用它）；托管多租户部署应设 `false`，否则租户填的仓库地址能让共享主机去 fetch 任意本地仓库 | 关掉后本地仓库目标一律被拒 |
| `AIMAC_ALLOW_LOCAL_DETERMINISTIC_WORKER` | `false` | 允许控制面用本机确定性执行器（只给 e2e/排障）；生产不要开 | 开了就有一条不经 agent 节点的执行路径 |
| `AIMAC_AGENT_RUNTIME_EXECUTOR_COMMAND` | 无 | 控制面【本机】执行工作项时用的模型执行器命令（只给本地部署/排障；生产把活派给远程节点，不设它） | 不设且本机确定性执行器也没开时，本机路径上的派发阻塞为 agent_runtime_executor_required，等远程节点来领 |
| `AIMAC_AGENT_ALLOW_INSECURE_HTTP` | `false` | （agent 节点侧）允许用 http 连非本机的控制面 | 节点凭据明文走网络 |
| `AIMAC_ORG_DEFAULT_MAX_MEMBERS` | `50` | 新组织的成员配额缺省（下限 1，更小的值按它生效） | 组织管理员可在「组织管理」页改 |
| `AIMAC_ORG_DEFAULT_MAX_PROJECTS` | `20` | 新组织的项目配额缺省（下限 1，更小的值按它生效） | 同上 |
| `AIMAC_ORG_DEFAULT_MAX_TASK_GROUPS` | `200` | 新组织的任务组配额缺省（下限 1，更小的值按它生效） | 同上 |
| `AIMAC_ORG_DEFAULT_MAX_AGENTS` | `100` | 新组织的智能体节点配额缺省（节点＋未用掉的入网令牌一起算） | 同上 |
| `AIMAC_PG_POOL_MAX` | `10` | PostgreSQL 连接池上限 | 并发写多时排队 |
| `AIMAC_PG_POOL_IDLE_MS` | `30000` | 空闲连接回收时间 | — |
| `AIMAC_PG_POOL_CONNECT_TIMEOUT_MS` | `10000` | 建连超时 | 数据库不可达时多久报错 |
| `AIMAC_PG_QUERY_TIMEOUT_MS` | 不限 | 单条查询超时（不设即不限） | 慢查询会一直等 |
| `AIMAC_LOGIN_ATTEMPTS_PER_MINUTE` | `10` | 同一来源每分钟允许的登录尝试次数（最低 3） | 超过后登录被限流 |
| `AIMAC_NODE_HEARTBEAT_TIMEOUT_MS` | `900000` | 节点多久没心跳算离线（15 分钟；允许 1 分钟到 24 小时）。健康检查的在线数与节点页的「心跳已超时」用同一阈值 | 过短会把慢网络的节点误判离线 |
| `AIMAC_NODE_RETIRE_TIMEOUT_MS` | `604800000` | 离线多久后节点被退役、名额释放（7 天；允许 1 小时到 30 天） | 退役后要重新入网 |
| `AIMAC_GIT_COMMAND_TIMEOUT_MS` | `600000` | 控制面侧命中网络的 git（远端检查点验证 fetch、技能源 clone·fetch、ls-remote）单次墙钟超时（10 分钟；下限 1 分钟，更小的值按它生效） | 太小会让大仓/慢网超时；不设则挂死的远端会冻住自治周期或悬挂验证请求 |
| `AIMAC_ROOM_PARTICIPANTS_MAX` | `5000` | 房间参与者总数（下限 100，更小的值按它生效） | 超出后新参与者加不进来 |
| `AIMAC_ROOM_SEQUENCE_MAX_ROOMS` | `5000` | 记着序号的房间数（下限 100，更小的值按它生效） | 太老的房间序号从头开始 |
| `AIMAC_PROJECT_EVENT_KEY_FILE_CAP` | `5000` | 项目事件的幂等键文件条数 | 更早的事件重放不再去重 |
| `AIMAC_REVIEW_MAX_REWORK_ATTEMPTS` | `3` | 一个工作项最多返工几次 | 到量后转人工处置，不再自动重来 |
| `AIMAC_STATE_VIEW_CACHE_MAX_ENTRIES` | `200` | 视图缓存条目数 | 只影响命中率，不影响内容 |
| `AIMAC_STATE_VIEW_CACHE_TTL_MS` | `60000` | 视图缓存存活时间（60 秒） | 同上 |
| `AIMAC_IDEMPOTENCY_TTL_MS` | `604800000` | 幂等记录保留期（7 天）（下限 3600000，更小的值按它生效） | 同上 |
| `AIMAC_IDEMPOTENCY_PAYLOAD_TTL_MS` | `600000` | 幂等**回执内容**保留期（10 分钟）；键还在，重放会回 `idempotent_result_expired` | 重放拿不回原来的回执 |
| `AIMAC_ROOM_MESSAGES_MAX_PER_ROOM` | `1000` | 单个房间的协作消息条数 | 协作记录只显示最近若干条 |
| `AIMAC_ROOM_MESSAGES_MAX_TOTAL` | `10000` | 全部房间的消息总条数 | 同上 |
| `AIMAC_ROOM_MESSAGES_MAX_TOTAL_BYTES` | `67108864` | 协作消息总体积（64 MiB）（下限 1048576，更小的值按它生效） | 同上 |
| `AIMAC_ROOM_MESSAGES_TTL_MS` | `604800000` | 协作消息保留期（7 天）（下限 60000，更小的值按它生效） | 同上 |
| `AIMAC_ROOM_MESSAGE_MAX_BYTES` | `32768` | 单条协作消息大小（32 KiB）（下限 1024，更小的值按它生效） | 超长的消息会被拒收 |
| `AIMAC_PROJECT_EVENT_SEGMENT_MAX_BYTES` | `67108864` | 项目事件库单段大小（64 MiB），到量轮转（下限 1024，更小的值按它生效） | 轮转时要重建索引，段越大重建越久 |
| `AIMAC_WORKER_LANE_MAX_REUSE` | `50` | 一条执行载体最多复用多少代 | 到量后退役、下次建新的 |
| `AIMAC_VIEW_LEDGER_LIMIT` | `60` | 视图里台账类集合的下发条数（下限 1，更小的值按它生效） | 名单顶部横幅说「只加载了最近的若干条」 |
| `AIMAC_PROGRESS_WORK_ITEM_CAP` | `300` | 任务组明细一次下发的工作项数（下限 20，更小的值按它生效） | 明细页说清总数与当前展示数 |
| `AIMAC_VIEW_EMBEDDED_WORK_ITEM_CAP` | `20` | 任务组列表里内嵌的工作项数（下限 5，更小的值按它生效） | 列表页说清总数与当前展示数 |

改这些值只影响**保留多少**，不影响正确性：还在跑的、还等着人处置的记录从不被淘汰
（这条由契约门的「容量裁剪必须说明它凭什么不裁掉还在用的记录」守着）。

## 出事的时候它怎么说话

这些是运维真会碰到、且【不看文档就会误判】的几条：

- **存储配置写错会拒绝启动，不会退回默认值。** `AIMAC_STATE_STORE` 只认 `runtime_json` 与
  `postgresql`；写成 `postgres`、或 `postgresql` 却没给 `DATABASE_URL`，进程会打印原因并退出 1。
  这是有意的：静默退回本地 JSON 会让你接在一个空存储上，而控制台一切看起来都正常，
  在上面建的东西等你改回来之后全都不见。
- **`/api/health` 的 ok 包含"状态读得出来"，不只是"进程还活着"。** 状态文件损坏、
  运行目录被清掉、状态被按种子重建、数据库中途掉线，都会让它回 503 `degraded`（`status` 字段）
  并指出是哪一份文件出了问题。文件损坏后还原回去，它会自己转回 ok；
  而目录被换 / 状态被重建这两种【必须重启进程】——当前进程已经接在另一份数据上，
  光把数据恢复回去救不了它，报文里会明说。
- **备份用 `npm run backup [运行目录] [备份目录]`，不必停机 —— 但别只 `cp -R`。**
  不给备份目录时落在运行目录的同级 `.runtime-backup-<时间戳>/`（已在 `.gitignore` 里：备份里有引导令牌与 MCP 服务令牌，不能进仓库）；
  拷贝撞上正在改名的临时文件会重试，次数由 `AIMAC_BACKUP_ATTEMPTS` 控制（默认 5）。
  项目分片按 generation 命名，写入方写出新一代之后【立刻】删掉旧的那一份。于是不停机拷贝有一个
  真实的竞态：中央索引在 T1 被拷走（指着 G1），T2 有人写入并删掉 G1，T3 拷到 `project-db/` 时只剩 G2 ——
  拷出来的那份"看着完整"，还原时才发现分片对不上。换个拷贝顺序也躲不掉（反过来就是分片旧、索引新）。
  `cp` 本身也会撞上正在改名的临时文件而报 ENOENT（实测三次里中一次）。
  所以 `npm run backup` 的做法是【拷完按索引核一遍，不对就重拷】：中央索引点名的每个分片、
  段清单点名的每个事件段都必须在，正文长度也要对得上（用的是存储层读取时的同一个判据）。
  还原：**先 `npm run backup -- --verify <备份目录>` 核一遍**，再停机把它整个拷回去
  （或让 `AIMAC_RUNTIME_DIR` 指向它）启动。核对这一步值得做：备份是在【拷的那一刻】核过的，
  而手里那份未必出自这个命令 —— 用 `cp -R` 拷出来的目录"看着完整"，
  问题只在还原之后启动时才暴露，而那时通常已经是出事之后了。
  **不要只拷 `control-plane-state.json`**：项目的任务组、派发、会话、确认单都在 `project-db/` 里，
  只拷中央文件等于备份了一个没有任何项目数据的壳。真这么还原时 `/api/health` 会回 503 并指名
  `project-db` 不在（此前它会照回 ok，人以为还原成功了）。崩溃一致性门里这三件事各有一条在守。
- **盘写不进去（满盘 / 只读挂载 / 权限 / 配额）回 503 `state_storage_unavailable`，读不受影响。**
  报文里不带服务器路径（原始报错在服务端日志里），恢复可写之后不必重启。
- **端口被占、缺权限、地址不存在**，启动时会按具体原因给一句人话（含该查什么），退出码 1。
- **装 Agent 时入网票不对/过期/已用过/角色越界**，安装命令会给出人话与下一步，
  而不是一段 Node 崩溃栈；要看完整堆栈用 `AIMAC_AGENT_DEBUG=1` 重跑。
- **git 失败会带上 git 自己说的原因**（被拒的非快进、认证失败、连不上远端），
  以 `git_command_failed:` 打头显示在派发的失败原因里，不带任何机器上的绝对路径。
  控制台把这类"码 + 细节"拆开显示：前缀翻成中文，细节原样保留；认不出的前缀原样显示，
  这样你至少还能拿它去搜。
- **技能源接错了可以退役**（技能源表上的「退役」）。退役会摘掉这个源带来的全部角色技能，
  用到它们的角色回退到系统内置技能（派发照常进行，界面上标出"套用了别人的技能"），
  指向这些技能的叠加规则一并终态化，自治周期不再重试它。同步失败的源会显示失败原因，
  而不只是一个 `stale` 徽章。
- **界面上的时间按你这台机器的时区显示，而服务端日志（`audit-log.jsonl`、执行事件）用的是 UTC。**
  顶栏标着当前时区，拿屏幕上的时间去对日志时按它换算。相对时间（"已 N 分钟没有心跳"）一律按
  服务器时钟算 —— 你这台机器的表快了也不会把在线节点误报成失联；偏差超过两分钟顶栏会直接说出来。
- **审计台账把三条路径的改动记在一起**：控制台、REST、以及 MCP 工具
  （记为「MCP 工具调用」，执行者形如 `mcp:主体类型:id`）。每次 MCP 调用的入参与返回摘要
  另存于 `mcp-audit.jsonl`。内存里只留最近 80 条，更早的在归档里，控制台有查看入口。
- **名单被视图截断时屏幕上会说**，并逐个点名是哪几份 —— 不要拿一张被截断的表判断"没有别的了"。
- **判过"不予处理"的问题不会再回来。** 在「执行监控」页把系统升级候选项判为不予处理，
  它背后的问题模式随之压制：以后同样的事只静默计数，不再重新聚类、不再升级。
  判为已解决之后若又发生，会另起一条新记录 —— 不会把你判过的那条改回去。

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
| [spec/review-bundle.schema.json](spec/review-bundle.schema.json) | 控制面内引用式 advisory review bundle schema；真实外发 redaction、digest 和 provider grant 需要外部适配器实现后再扩展 |
| [spec/rule-source-resolution.schema.json](spec/rule-source-resolution.schema.json) | MGP/ai-skills/review 等外部材料能否成为规则的来源解析 schema |
| [spec/completion-readiness.schema.json](spec/completion-readiness.schema.json) | WorkSession/TaskGroup final 前完成就绪检查 schema |
| [spec/runtime-issue-pattern.schema.json](spec/runtime-issue-pattern.schema.json) | 运行期重复问题聚合、证据和收集限定 schema |
| [spec/system-upgrade-candidate.schema.json](spec/system-upgrade-candidate.schema.json) | 重复运行问题收集和独立系统升级候选 schema |
| [spec/language-policy.schema.json](spec/language-policy.schema.json) | 任务组统一交互、指令、执行事件、checkpoint、仓库输出和 review 材料语言策略 schema |
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
| [spec/agent-join-token.schema.json](spec/agent-join-token.schema.json) | 一次性 Agent 入网令牌、项目/角色/MCP scope 和有效期 schema |
| [spec/agent-runtime-node.schema.json](spec/agent-runtime-node.schema.json) | 远程 Agent 节点身份、能力、自检、准入和心跳 schema |
| [spec/agent-skill-workset.schema.json](spec/agent-skill-workset.schema.json) | 总控按任务下发的最小 Skill 工作集、摘要、overlay 和强制使用指令 schema |
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
11. 模型选择由 Model Registry 和 Scheduler 基于角色 skill、任务能力、成本、速度、额度、可靠性和风险自动决定；调度使用供应商中立档位 `standard/frontier_economy/frontier_standard/frontier_plus` 与 `low/standard/medium/high/max/ultra` 推理层级，默认不超过 `frontier_standard + high`，只有特殊风险信号才允许越级。
12. Scheduler 对持续多轮、长耗时、有状态、拥有广义写入面的角色任务优先创建新 WorkSession；短小、单轮、无持久上下文的任务可使用子 agent，但仍必须绑定 bounded repository lease、commit、push 和 checkpoint 证据。
13. 运行期重复问题只生成 RuntimeIssuePattern、SystemUpgradeCandidate 和系统外升级证据包；系统运行时不得自动自修改规则、策略、角色、grant 或控制面代码，升级改造由人独立在系统外处理。
14. 总控、调度和监测等元控制角色必须绑定 RoleDriftGuard；一旦目标、职责、边界或证据链跑偏，立即暂停副作用并由父级总控重发有效任务契约。
15. MGP、ai-skills、外部 review 和工具结果只能作为来源材料；是否吸收为本系统规则必须经过 RuleSourceResolution，本地核验前不能直接执行。
16. 外部/旁路 AI review 结果只具 advisory 属性；当前 ReviewBundle 只登记控制面内证据引用和采纳/驳回留痕，必须经 ReviewPlan coverage 和本地核验后才可转为 Finding、WorkItem 或 DecisionRecord；真实外发 redaction、payload digest 和 provider grant 必须随外部适配器一起实现。
17. 最终关闭由 Orchestrator 根据 CompletionReadinessCheck 和 CloseBarrier 的完整 gate 结果完成。
18. 共享定义、标准、术语、状态语义、接口、数据模型、错误码和指令格式必须由 SharedDefinitionContract 明确 canonical owner、producer、consumer 和 digest。
19. 任务产出文件只写入 Orchestrator 选定的项目 Git 仓库目标；系统不另建项目产出文件管理层。

## 终态技术路线

| 层 | 终态要求 |
| --- | --- |
| 控制服务 | TypeScript/Node.js 控制平面，可按负载拆分服务但协议不变 |
| 系统库 | 本地 npm/shell 默认 `runtime_json` 中央状态 + 项目级 state shard；Docker Compose 设置 `AIMAC_STATE_STORE=postgresql` 并使用 Postgres JSONB 中央状态表和项目 shard 表存储权威状态、event log、lease、audit、rules 和 Git-backed artifact manifest metadata |
| Agent Runtime | 可远程加入、探测、执行、隔离、恢复、上报证据的机器执行器 |
| 实时通道 | 控制台经认证的 WebSocket（`/api/realtime`）接收 state/agent-control 频道的实时 wake 帧（仅信号、无载荷，客户端经既有已鉴权作用域端点重取），并回退到 Agent Gateway 长轮询 + 写入通知；持久 command/event log 负责断线重放；PostgreSQL 部署可接入 LISTEN/NOTIFY 和 outbox/DLQ 扩展横向扩容 |
| MCP | 全部 MCP server 集中运行在控制平面服务器；Agent 仅以节点凭证访问远程 MCP，不允许运行 Agent-local MCP server |
| Evidence/Artifact | 证据 locator、digest、sensitivity、retention、redaction、verify、GC、backup；项目交付文件以 Git 仓库 commit/push 为准 |
| Policy/Secret | policy table/engine、secret lease、credential helper、grant revoke、audit |
| UI | 只作为后台管理、观察和入口总控会话界面，不作为执行依赖 |

## 本地控制平面实现

当前实现提供无依赖 Node 控制服务、SaaS 管理控制台和 AI Runtime 视图。核心运行逻辑位于 `apps/control-plane-ui/lib/control-plane-core.mjs`，覆盖：

1. 常用模型 provider class 的能力 registry 和自动模型选择。
2. `agency-agents-zh` pinned snapshot 的 skill source 同步、frontmatter 解析和 digest 索引。
3. 长任务新 WorkSession、短任务 subagent 的 session placement 决策。
4. AgentTaskContract、AgentDispatch durable outbox、EffectiveInstructionPacket、RoleDriftGuard、Checkpoint、ProgressSnapshot、CompletionReadiness 和 CloseBarrier 的本地生成。
5. 远程 Agent Runtime 从 Agent Gateway 原子 claim dispatch，按摘要同步 Skill 工作集，实际写入项目 Git 仓库、commit、push；控制平面从远端仓库独立 fetch 后再校验 commit、remote ref、artifact manifest、changed path 和 lease 证据。
6. 运行期重复问题的 collect-only 聚合和 SystemUpgradeCandidate 生成。
7. 项目、任务组、Agent、账号、授权、审计和仓库输出目标的受控 API。
8. `apps/mcp-server/server.mjs` 是由控制平面 `/mcp` 托管的 Streamable HTTP MCP 处理器，暴露各逻辑工具面，并对写入型调用执行输入校验、idempotency、远程 principal scope、lease/fencing、policy decision、audit 和 untrusted result 标记；直接启动本地 stdio server 默认失败。
9. `apps/control-plane-ui/lib/state-store.mjs` 提供同步 state store；本地默认 `.runtime/control-plane-state.json` + `.runtime/project-db/p_<projectId_sha256>.<generation>.state.json`，Docker Compose 设 `AIMAC_STATE_STORE=postgresql`，通过连接池化的 `pg` 客户端（node-postgres 运行在 worker 线程，主线程经 `Atomics.wait` + `receiveMessageOnPort` 同步取结果，保持 state store 同步 API 不变）使用 `aimac_control_plane_state` 和 `aimac_project_state_shards` 作为 HTTP、MCP 和 CLI skill sync 的共同权威状态；写入按 `stateVersion` 做版本守卫 CAS（冲突则回滚且不触碰 shard），避免多 agent 并发静默覆盖。首次运行需 `npm install` 安装 `pg` 依赖（本地默认 `runtime_json` 文件态零外部依赖、不加载 pg）。

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
