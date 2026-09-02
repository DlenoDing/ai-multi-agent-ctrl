# 系统全量复验与优化清单

本文记录 2026-09-02 对 `ai-multi-agent-ctrl` 的系统级复验结论、待处理问题和优化准则。它面向 Orchestrator、Scheduler、Agent Runtime、Monitor、MCP Proxy 和后续系统外维护任务，不是人工项目执行步骤。

## 1. 复验准则

所有优化同时按三条原则裁决：

1. **简单**：优先减少入口歧义、重复协议和非必要操作面；新增能力必须复用现有鉴权、scope、audit、state-store、schema 和状态机。
2. **稳定**：所有写入保持 fail-closed、idempotency、lease/fencing、checkpoint、Git 远端复验和审计；禁止绕过 Agent Gateway 代替 Agent 完成任务。
3. **性能**：热路径不传大对象、不重复水合全状态、不广播大载荷；项目数据继续按项目分片，执行事件继续按项目 JSONL/索引/轮转处理。

## 2. 当前已验证能力

| 能力 | 当前状态 | 证据 |
| --- | --- | --- |
| npm / shell / Docker 启动 | 已实现 | `npm run init`、`npm start`、`npm run docker:up`、`npm run shell:start` 均在文档和脚本中存在；Docker doctor 已验证 PostgreSQL 形态。 |
| Agent 一次性入网 | 已实现 | 项目 UI/API 生成 join token；Agent Runtime 调 `/api/agent/v1/register` 注册，服务端签发 node token。 |
| 集中式 MCP | 已实现 | `/mcp` 由控制平面托管；Agent 只访问远程 MCP，不运行本地 MCP server。 |
| 执行过程实时回送 | 已实现 | Agent Runtime 持续提交 `AgentExecutionEvent`，UI 通过 WebSocket wake + 详情事件端点读取。 |
| 模型动态选择 | 已实现 | 派发契约强制包含 `model`、`reasoning`、短 `modelDecision`；不使用固定 profile 作为派发依据。 |
| 多供应商模型 | 已实现 | provider class 覆盖 OpenAI、Anthropic、Google、xAI、Meta、Mistral、DeepSeek、Qwen、Moonshot、Zhipu、Baidu、Tencent、OpenRouter、Azure OpenAI、Bedrock、Vertex、Ollama、vLLM、custom。 |
| Skill 默认源与覆盖 | 已实现 | `DlenoDing/agency-agents-zh` pinned snapshot；项目/任务组 overlay 优先级高于 upstream default。 |
| 项目级存储隔离 | 已实现 | 中央 state + 项目 state shard + 项目执行事件 JSONL/索引/轮转。 |
| 管理 UI | 已实现 | 系统管理、组织/用户管理、项目管理、任务组、审核、指令、监控、设置等页面存在。 |

## 3. 待处理问题与优化项

| 优先级 | 项目 | 问题 | 简单 | 稳定 | 性能 | 处理状态 |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | HTTP 规格入口歧义 | 核心规格表把多条“设计意向但未实现”的 API 混在主 HTTP API 表内，AI Agent 可能把它们误当成可调用入口。 | 已补齐 `GET /api/projects/:projectId` 与 `GET /api/task-groups/:taskGroupId` 两个低风险只读别名；其余明确改为非入口设计项。 | 别名复用现有 `readableProjectOr403` / `requireRead` / scope 过滤，不新增绕权路径。 | 只读别名返回有窗口上限的详情摘要，避免全量 state dump。 | 已处理 |
| P1 | 生产横向扩展 | 当前已支持 PostgreSQL、CAS、项目分片和事件轮转，但 WebSocket 订阅与后台 tick 仍是单控制面进程形态。 | 不在当前单机代码里强行引入复杂集群；先把生产扩展边界写成明确路线。 | 多实例前必须引入 outbox / LISTEN-NOTIFY / leader election 或外部调度锁。 | 需要压测和横向 fanout，避免所有实例重复编排。 | 待处理 |
| P2 | Room 自动回复防风暴 | `hopCount` 尚未实现；当前没有 Agent 自动回复 room message，所以只是未来风险。 | 当前不补复杂 room 自动应答；先增加“启用自动回复前必须实现”的硬规则。 | 防止未来接入自动应答后两个 Agent 循环互刷。 | hop/TTL/capacity 共同限制消息风暴。 | 待处理 |
| P2 | 外部 review bundle | 当前 review bundle 是控制面内部引用式记录，不是完整外发脱敏投递系统。 | 保持当前引用式实现；把真实外发定义为后续独立扩展，不让 Agent 误以为已外发。 | 外部结果仍只能 advisory，经本地核验后进入 Finding/Decision。 | 外发包不能把大证据直接塞进状态。 | 待处理 |
| P2 | Two-factor 登录 | `requiresTwoFactor` 目前 fail-closed，启用后不会签发 session，但没有完整 2FA 流程。 | 在完整 2FA 实现前，文档和接口声明其为禁用能力。 | 保持 fail-closed，不降级成忽略 2FA。 | 不影响热路径。 | 待处理 |
| P2 | 任务类型分类 | 模型分档依赖启发式关键词，能覆盖常见任务，但难以识别“未明说架构/方案”的隐含高风险决策。 | 增加轻量结构化风险信号，不引入长篇模型选择理由。 | 防止高风险任务被误判为普通实现。 | 分类仍保持本地 O(文本长度)，不调用模型。 | 待处理 |
| P3 | MCP tools/list 成本 | 默认服务令牌可见 44 个工具约 31KB，全量 85 个工具约 63KB，仍有 token 成本。 | 继续用 allowlist；后续可按 dispatch 生成 capability catalog。 | 不减少必要工具，不影响 grant/fencing。 | 减少 inputSchema 重复传输，提高缓存命中。 | 待处理 |
| P3 | 大文件维护风险 | `control-plane-core.mjs`、`server.mjs`、`app.js` 文件较大。 | 后续按领域拆模块，保持导出协议不变。 | 拆分必须由现有 mutation/contract gates 覆盖。 | 模块化本身不追求运行时性能收益，主要降低维护风险。 | 待处理 |

## 4. 本轮处理顺序

1. 先消除 HTTP 规格入口歧义：补齐低风险只读别名，并把仍非入口的设计项归档为不可调用设计意向。
2. 明确生产扩展边界：单实例已验证，高并发生产需要 PostgreSQL、外部反代、明确服务 token scope；多实例需要后续 outbox/leader/fanout 扩展。
3. 对 `hopCount`、外部 review、2FA、任务分类、MCP token 成本和大文件模块化做最小且可验证的修正或文档约束。

## 5. 不做的事

1. 不把运行中的系统升级改造成项目内自动任务。
2. 不让服务器代替生产 Agent 执行代码任务。
3. 不把 MCP server、数据库、Skill Registry 下沉到 Agent 主机。
4. 不把未实现的设计意向写成已实现入口。
