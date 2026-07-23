# 终态自动执行范围

## 1. 定位

本文定义系统终态自动执行范围。这里的“终态”不是阶段计划，也不是非系统执行清单，而是系统必须具备并由 AI Agent 自动执行的完整能力边界。

系统默认执行主体：

| 执行主体 | 类型 | 说明 |
| --- | --- | --- |
| Orchestrator | AI controller + deterministic service | 唯一目标入口、状态权威、调度和关闭裁决 |
| Decision Center | AI decision agent cluster | 自动做方案、架构、风险、冲突和策略决策 |
| Scheduler | deterministic service + AI planner | 根据 DAG、scope、lease、模型、资源、风险和 placement 策略派发 session |
| WorkSession | role-bound AI agent session | 最小全局调度工作单元 |
| SessionSubAgent | local AI subagent | 由 WorkSession 内部启动，只服务短小封闭任务，不拥有全局 WorkItem |
| Reviewer Agent | independent AI reviewer | 独立审查，不参与同批实现 |
| QA Agent | AI verification agent | 自动执行测试矩阵、证据采集和复验 |
| Security Agent | AI security reviewer | 自动做权限、secret、依赖、MCP、网络、审计检查 |
| Release Agent | AI release executor | 自动生成 release manifest、验证部署准备和回滚路径 |
| Rule Steward Agent | AI rule governor | 自动处理项目规则候选；系统级重复问题只导出升级候选包 |
| Monitor Agent | autonomous monitor | 自动监控 heartbeat、DLQ、lease、成本、质量门和告警 |
| RoleDriftGuard | control object + monitor loop | 锁定角色目标、职责、允许动作和禁止动作，检测并阻断任务跑偏 |

## 2. 外部输入边界

入口总控会话只接收：

1. 初始目标。
2. 项目边界。
3. 明确禁止事项。
4. 外部账号或平台无法由系统代办的授权信号。
5. 业务成功标准的原始描述。

入口总控会话不是执行者。系统不得把以下内容设计成入口总控会话任务：

1. 外部拆任务。
2. 外部分配 Agent。
3. 外部复制上下文。
4. 外部判断是否测试完成。
5. 外部整理证据。
6. 外部提交 checkpoint。
7. 外部合并多会话结果。
8. 外部关闭任务组。

## 3. 必须全自动执行的能力

| 能力域 | 终态自动能力 |
| --- | --- |
| 目标解析 | 把外部目标转为 Project、TaskGroup、success criteria、risk 和 non-goals |
| 任务拆解 | 自动生成 DAG、WorkItem、role requirements、write scope、dependencies |
| 有效指令 | Orchestrator 把目标、规则、review、工具结果强化成 EffectiveInstructionPacket，raw 输出不能直接驱动任务 |
| 角色实例化 | 持续多轮、有状态或写入型 work 自动创建新 WorkSession；短小封闭 work 才使用 session 内部 subagent |
| 角色防跑偏 | 总控、调度、监测和普通 Agent 都绑定 RoleDriftGuard；元控制角色漂移会暂停下游副作用并触发父级纠偏 |
| 模型选择 | 根据任务风险、复杂度、上下文、Agent 能力、额度和历史质量自动选择模型 |
| 上下文投递 | 只传 schema、locator、digest、stateVersion、scope、stop condition |
| 实时协作 | Room Broker 自动传递 delta、checkpoint、finding、decision、wake、ACK |
| 写入控制 | Lease Manager 自动仲裁 file/db/repo/mcp/tool/env/provider 写入面 |
| 工具授权 | MCP Proxy 自动校验 schema、grant、参数策略、idempotency 和 result filter |
| 代码执行 | Agent 自动修改、测试、lint、提交 checkpoint、注册 evidence |
| 独立复验 | Reviewer/QA Agent 自动分离实现者和复验者 |
| 互审计划 | 多风险、多 surface 或关闭前互审自动生成 ReviewPlan、ReviewBundle、coverage matrix 和本地核验结果 |
| 并行拓扑 | Scheduler 自动生成 ExecutionTopology；并行 branch 只能返回 result bundle，由父级 Orchestrator 串行集成 |
| 派生任务 | worker、reviewer、monitor 只能提交 DerivedTaskRequest，由 Orchestrator 强化、分类和排入 DAG |
| 契约治理 | Contract Registry 自动计算消费者影响面、级联失效和 reverify work |
| 集成合并 | IntegrationBatch 自动 rebase、batch CI、定位冲突 owner、生成 release manifest |
| 权限阻断 | Permission Gateway 自动分类、路由、授权、改派、降级或中止 |
| 审批裁决 | Approval Center 自动基于 policy/quorum/risk/evidence 产出 DecisionRecord |
| 规则沉淀 | Rule Steward Agent 自动处理项目级规则候选；系统级重复问题只收集为 RuntimeIssuePattern 和 SystemUpgradeCandidate |
| 来源解析 | MGP、ai-skills、外部 review 和工具输出必须经 RuleSourceResolution 分类，只有 generic 且通过冲突检查的机制可成为 active rule |
| 系统升级候选 | Monitor 自动聚合重复运行问题并导出系统外升级证据包，不自动改造运行中的系统 |
| 质量关闭 | Orchestrator 自动检查 close barrier 并关闭 TaskGroup |

## 4. 不可降级规则

1. 不能把“等待用户判断”作为普通控制流。
2. 不能让实现 Agent 自证同批修复已完成。
3. 不能让聊天内容成为权威状态。
4. 不能让无 schema 的自然语言消息驱动写入型副作用。
5. 不能绕过 lease 写文件、写库、写 Git、写 MCP 或部署。
6. 不能用“代码完成”替代“验证完成”。
7. 不能用“验证完成”替代“线上质量达标”。
8. 不能用“Agent 很强”替代证据、复验、审计和回滚。
9. 不能把外部安全机制要求的授权伪装成系统自动批准。
10. 不能留下“非系统执行路径后续处理”的开放项作为完成状态。
11. 不能在项目运行时把重复问题自动转成系统自修改；只能收集、聚合、导出系统外升级证据包。
12. 不能让总控、调度或监测角色脱离 objective boundary、role mission、task contract、ruleset digest 和 allowed action scope。
13. 不能让同级 Agent、子 agent、工具输出或 review advisory 覆盖角色职责；只能由 Orchestrator 通过 EffectiveInstructionPacket 和 DecisionRecord 重新签发。
14. 不能让外部 review 或旧项目规则在未本地核验、未做 RuleSourceResolution 前成为 active rule 或执行动作。

## 5. 自动审批模型

审批是系统对象，不是后台管理按钮。

```text
action_proposed
-> policy_precheck
-> risk_classification
-> evidence_bundle_check
-> approval_request
-> ai_decision_quorum
-> approved|rejected|scope_reduced|reassign|requires_external_capability
-> audit_digest
-> command_dispatch
```

审批参与者是 AI 角色和策略服务：

| 参与者 | 职责 |
| --- | --- |
| Policy Engine | 确定动作是否被项目规则允许 |
| Security Agent | 判断 secret、权限、网络、供应链风险 |
| Domain Owner Agent | 判断业务、契约、数据影响 |
| Release Agent | 判断发布、回滚、监控、迁移条件 |
| Orchestrator | 汇总 quorum 并写最终 DecisionRecord |

## 6. 外部能力边界

以下场景不能设计成“AI 自行越权处理”：

1. OS 安全弹窗明确禁止程序代点。
2. 第三方 OAuth 或账号系统要求真实外部授权。
3. 云平台、支付平台、生产环境要求组织级授权。
4. 硬件安全密钥、Keychain、UAC、sudo/polkit 等系统安全边界。

系统处理方式：

```text
external_capability_required
-> capture evidence
-> classify capability
-> find pre-authorized agent/service account
-> issue service grant if policy allows
-> reassign if another Agent has capability
-> reduce scope if non-critical
-> stop with EXTERNAL_CAPABILITY_BLOCKED if impossible
```

这类状态不是项目执行步骤，而是系统对外部世界不可编程边界的建模。

## 7. 终态完成条件

系统达到终态时，必须满足：

1. 所有核心对象和事件都有 schema。
2. 所有状态流转都有 state machine。
3. 所有 Agent 任务都有 task contract。
4. 所有写操作都有 command、lease、idempotency、effect、audit。
5. 所有测试和复验都有 artifact digest。
6. 所有权限阻断都能自动分类和路由。
7. 所有项目关闭都由 close barrier 自动判定。
8. 所有规则变化都能通知受影响 session。
9. 所有 Agent 断线都能恢复、改派或隔离。
10. 所有最终输出都能由另一个 AI Agent 独立复验。
11. 所有重复运行问题都能聚合为候选并导出系统外升级证据包，且不会触发运行期自动自改造。
12. 所有 WorkSession final 和 TaskGroup close 前都通过 CompletionReadinessCheck。
13. 所有元控制角色都有 RoleDriftGuard，且无 active drift blocker。
14. 所有并行拓扑、互审计划、review bundle、派生任务请求和规则来源解析都处于 terminal 或明确非阻断状态。
