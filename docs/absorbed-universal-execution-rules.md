# 吸收的通用执行规则（默认系统规则来源）

版本：absorbed-universal-rules/v1
来源：从 `MGP` 真实交易平台 monorepo 的 agent 规则体系（`AGENTS.md`、`agent-rules/00|40|60`、`agent-rules/history/*`、`trade-docs/system/task/2026-07-core-init/development-verification-operating-model.md`、`agent-sync/README.md`）提取的**领域无关**通用规则（已剔除交易/行情/provider/kafka 等业务细节）。

本文件是 §4.4 三类规则体系中**默认系统规则集（defaultSystemRules）**的来源与依据。53 条通用规则分两类落地：

- **A. 已由控制面机制强制（enforced）**——系统运行时行为已实现，不需要靠"规则文本"约束会话。
- **B. 作为默认系统规则下发（delivered）**——属于执行会话必须遵守的行为纪律，编入 `defaultSystemRules` 经内容包 `system` 分类下发给每个 dispatch。

## A. 已由控制面强制的规则（映射到现有实现）

| 通用规则 | 控制面实现 |
|---|---|
| 20 会话级自动 git checkpoint | runtime 在 checkpoint 处 add 精确路径→commit→安全 push；outbox 重放 |
| 21/22/24 单写者·精确暂存·安全推送·主分支 symref | runtime git 逻辑 + validateCheckpointGitEvidence（fencing/push 校验、ls-remote symref） |
| 34/35/36 独立互审分离与闭环 | `performIndependentReview`（checkpoint 只到 review_requested；reviewer/qa 独立推进 verified；不通过则返工） |
| 14/15/16 每次显式 model+reasoning+modelDecision·分析实现拆分·envelope 压缩 | `selectModel` + 契约 `model.modelDecision`；内容包 + inputLocators 引用；拆分混合工作项 |
| 6/7/8 单一 owner·有限变更图·正交状态机 | orchestrator + taskGroup + workItem 状态机；readiness/close-barrier 逐门计算 |
| 18/17 reality-first 正交维度准入·按真实 snapshot 并行 | `runAutonomousCycle` 每轮重读 state；`expireStale*`/`recycleExpiredClaims` |
| 13 不可变派发契约 + worker 边界隔离 | `agentTaskContracts` + dispatch package + roleDriftGuard + MCP grant dispatch 绑定 |
| 37/38/39 supersession 生命周期 | workItem `superseded` 终态 + repositoryOutputTarget `superseded` |
| 45/46/47 findingDisposition·根因·P0 | findings + `finding_resolve`；close-barrier `all_findings_terminal` 门 |
| 41/42/43/44 agent-sync 是恢复入口非消息总线·分片·写锁·归属 | 状态持久化 + 长轮询（非聊天总线）；project-event JSONL append-only + 目录锁；审计哈希链 |
| 25/26 命名空间化验证状态·目标层级绑定 | checkpoint git 证据分层校验；progressSnapshot/completionReadiness 分项 |
| 53 中文协作·机器字段保留原文 | languagePolicy（zh-CN 默认）+ i18n 映射；契约/枚举/commit 保留原文 |
| 50/51/52 薄入口·history 非规范·证据目录镜像 | docs 分层；project-event/evidence 分离；审计 JSONL |
| 33 owner 身份可迁移且旧身份硬冻结 | 节点 revoke/shutdown finalize + draining/read_only；组织 disabled 撤销 session |

## B. 编入默认系统规则下发（defaultSystemRules 内容依据）

以下行为纪律无法仅靠控制面状态强制，必须作为**默认系统规则**由内容包 `system` 分类下发给执行会话，会话必须加载并遵守（且可按项目/任务组层级调整）：

1. **行为语义风险分级 [C01]**（rule 1）：按真实影响面（L0–L3）而非文件路径定级，动手前明确"级别+影响面+允许动作+验证方式+互审要求"。
2. **中断恢复七问 [C02]**（rule 4/5）：接手/压缩/恢复后先重校主线目标、权威规则、真实运行状态、是否走偏，纠偏时冻结争议分支保留证据回主线。
3. **临时测试插桩生命周期 [T11]**（rule 31/32/33）：临时 debug 代码须唯一 temp_id + 成对 marker + run 级 manifest 登记；默认关闭、有界、精确清理；active 临时 hunk 不进普通提交；正式复验前必须移除并按污染范围重建；不得整文件回退或按 TODO 泛词删除。
4. **证据新鲜度 [T08]**（rule 27）：证据必须晚于变更真实生效点并带时间戳/generation；过期或只剩历史观测标 `historical_unverified`，不能支撑当前完成结论，重测生成新证据。
5. **验证目标层级绑定 [T08]**（rule 26/25）：每条验证状态绑定对象+层级+claimScope；方案/文档层"已修"不等于代码接线/运行/数据/客户端/生产达标，跨层完成须分别引证。
6. **完成声明边界 [T10]**（rule 30）：页面打开/接口 200/编译通过/无新报错**不能单独作为完成证据**；required 项存在待窗口/外部阻断只能给受限结论。
7. **观察通道正对照 + 可逆变异 [T07]**（rule 29）：断言"0/无"前先证明观察通道有效；重要守卫交付前做可逆变异检验（造缺陷转红、还原转绿）。
8. **精确暂存禁 add . [G01/G02]**（rule 22）：`git add <具体路径>` 或 `-p`，提交前 status/diff 核对归属，禁止 `git add .`/`-A`，不提交他人 hunk/secret/原始证据/冲突标记。
9. **根因落 canonical owner [C04]**（rule 46/47）：修复点落在被违反不变量的上游 owner，不在症状点加默认值/吞异常/兼容分支掩盖；普通问题批量按根因收敛，P0 先止血留证。
10. **环境由配置表达 [C07]**（rule 48）：环境只由配置枚举表达，不用 hostname/IP/容器名/分支/路径推断；不擅自清理凭据。
11. **五类时间语义 [C07]**（rule 49）：比较时间前先分类 instant/civilTime/businessCalendar/elapsedDuration/logicalOrder，不同 role 不因都能转 UTC 就互换；因果顺序用 sequence/version 不用时间戳。
12. **变更范围收敛 [C10]**（rule 7/28）：图冻结后仅四类证据可扩图，禁止"继续看看"式无界扫描；全量验证建覆盖矩阵、批量按根因收敛，不以"无新增可疑点"为无限目标。

### 增量吸收（2026-07-26 复读 operating-model §4.5/§4.6 后新增，来自 Ruleset .38/.225 演进）

13. **运行事实全链路溯源 [sys.full-chain-diagnosis]**（operating-model §4.5.1）：把运行事实判定为缺陷前先沿业务→helper→framework/SDK→依赖默认→env/config→容器→原始存储→应用回读全链路溯源；同一 canonical owner path 写入+回读通过时"物理名≠逻辑名"先归类 evidence_probe_mismatch，不据单点 raw 观测升级 blocker/擅改全局。补 `sys.observation-control`（观察通道有效性）与 `sys.root-cause-owner`（在哪修）之外的"raw 观测是否真是缺陷"一环。
14. **服务内 owner-path 终判 [sys.owner-path-verification]**（§4.5.2）：pass/fail 与修复验证必须在完整服务实例内经真实程序路径完成，raw 技术栈探针只作辅助/负对照不作终判。补 `sys.completion-boundary` 的"正向验证方法"缺口。
15. **弱证据结论重分类 [sys.evidence-qualification]**（§4.5.2 既往结论回扫）：load-bearing 的 raw/单点证据结论按影响面重分类并经正确路径复验；证据"方法强度"决定可承载结论范围（与 `sys.evidence-freshness` 的"时间新鲜度"正交）。
16. **昂贵前置 guard 复用纪律 [sys.guard-reuse]**（§4.6 buildChainGuard）：输入不变可复用昂贵 guard 但须登记依据、"跳过≠通过"、输入变化或正式 pass 前重跑。

### 已落地为控制面机制（2026-07-26 实现）

- ~~可复用 worker lane 模型 + lane registry~~（§2.2）**已实现**：`state.workerLanes` + `acquireWorkerLane`/`rotateWorkerLane`/`maintainWorkerLanes`/`laneReusePrecheck`（角色 1:N、复用/漂移归档）。
- ~~每派发机器可读 admissionDecision 记录~~（§4.5）**已实现**：`recordAdmissionDecision`/`state.admissionDecisions`（单一互斥 outcome + 派生布尔恰一 true + cellClass + 正交 dimensions + whyThisCellNow + workerCarrierDecision + modelDecisionRef）。
- ~~单 cell 阻断防升格全局门 + 正交调度维度~~（§4.5）**已实现**：`recomputeTaskGroup.singleCellEscalationGuard`（有可执行 cell 不升格）+ A6 `NON_ESCALATING_WAIT_CLASSES` 最小作用域白名单 + A1 `ADMISSION_PRIORITY_TIERS`/`cellAdmissionPriority` 优先级排序 + A2 `admissibleCellClass` 8 类分类 + A8 `recordAdmissionScan` 周期级候选扫描。
- ~~findingDisposition 闭合枚举强化~~（§4.6）**已实现**：close-barrier `all_findings_terminal` 要求 dispositionClass ∈ {fixed_verified/not_applicable/scope_adjusted/blocked_external}，`findingResolve` 对无证据/缺 owner 降级。

### 2026-07-26 第二轮吸收（调度/分配规则调整，commit 4f9e2ab）

从 development-verification-operating-model.md §2.2/§4.5/§4.6.0 通用化吸收（市场/session→条件窗口，Provider 额度→外部资源）：A1 优先级排序、A2/A5 cellClass+正交维度、A3/A4/A9 条件窗口准入（`conditionWindowGate`，按 environment 独立、每周期重采样、defer 记 wakeTrigger、恒 continue）、A6 最小作用域 blocker 白名单、A7 载体 4 选1+nonSelectedCarriers/nonReuseReason/retireOrArchiveCondition、A8 周期级 admissionScan、A10 规则 `sys.layered-admission`（分层准入+最小复验+禁混用 gating 状态）。全部 work-item 描述符可选，缺省=旧行为。

> 说明：默认系统规则可被项目/任务组按 §4.4 三级机制启用/停用/改写单条。控制面对 A 类规则已有硬约束；B 类规则通过内容包硬性下发（不靠指令措辞），会话开始前摘要校验不符即拒绝执行。

### 2026-08-03 第五轮吸收（MGP 规则源 8/2–8/3 更新后复读）

来源：`agent-rules/00-common.md`（[C04]/[C05]/[C10]/[C11]）、`agent-rules/40-testing-and-evidence.md`（[T01]/[T02]/[T07]/[T10]）、
`agent-rules/60-git-docs-and-review.md`（[G06]/[G07]/[G08]）。上一轮吸收是 2026-07-27，这三册在 8/2–8/3 有实质更新。

**新增 6 条默认系统规则（26 → 32）**：

| 规则 | 来源 | 为什么必须下发（本仓机制无法强制） |
|---|---|---|
| `sys.optimal-end-state-first` | [C04] 最优终态三问 | 先问"该不该存在"再问"在哪修"；症状级修复的共同特征是让错误的事情做得更好 |
| `sys.falsifiable-design-gate` | [C05] 定案顺序 | 推演→可证伪断言→互审→定案→才发指令；推演五问针对正式环境触发条件 |
| `sys.prior-art-required` | [C05] 业界依据 | 核心机制先查标准做法并写可追溯依据；查不到须标注"无外部先例，本地推导" |
| `sys.admission-predicate-shape` | [C11] 判据形态 | required-present + shape-valid；补白名单属症状级修复，须改判据形态本身 |
| `sys.reject-disposition` | [C11] 四种归宿 | 逐写入目标判定；运行状态不得决定"是否处理"；负载指标不得成为丢弃触发 |
| `sys.oracle-independence` | [T07] 验证方法纪律 | 期望值须独立于被测实现；不复制会静默过期的样例；扫描断言须有命中下限 |

**对既有规则的修正（语义过窄 / 过宽 / 冲突）**：

- `sys.review-dual-track`（**过窄**）：判准由三项扩为**六项**——真实功能、数据正确性、已证实适用的外部使用边界、简单、高性能、稳定（含恢复与 SLO）。
  前三项是底线，明确禁止用降低真实覆盖/频率/正确性冒充高性能、用阻断/降级/人工看护冒充稳定。来源 [C05]/[G06]。
- `sys.review-dual-track`（**过宽**）：原文要求每次互审都完整走轨道二并给替代方案，会把定向 diff 复核变成开放式发散。
  按 [G06] 改为**深度按评审类型分层**：定稿类完整比较；定向/只读/范围冻结的复验仍须回到原始问题，但未发现更优路径时写明考察项与不展开原因即可。**缺轨仍永远不合格**。
- `sys.review-dual-track`（**补漏**）：新增"互审结论是输入不是裁决"（须逐条复核后采纳）与闭环要求（finding 落到改动或文档、驳回须有证据）。来源 [C05]/[G08]。
- `sys.independent-review-depth`（**冲突/重复**）：与 review-dual-track 重复定义判准。按 [C09]"每条长期规则只在一个 owner 分册完整定义"收编为**交叉引用**。
- `sys.product-intelligence-first`（**悬空引用**）：原文"冲突时以最新 core-init 结论为准"引用的是**未随内容包下发的外部文档**——会话拿不到的东西不能充当判据。改为以本规则集内部可判定的表述裁决。
- `sys.completion-boundary`（**过窄**）：补 [T07]"lint/编译/容器启动/类存在/配置声明 ≠ 运行时真的接上了"，新增注册须由真实调用或 smoke 证明命中。
- `sys.observation-control`（**过窄**）：补 [T07] 两条——不在共享文件上做整文件变异/还原（本仓实测多次因此销毁未提交改动）；两个配置来源恰好同值时须刻意造不同值证明读的是正确 owner。
- `sys.root-cause-owner`（**过窄**）：补 [C04] 链路修复自上游向下游逐层推进、每层改完验一层，且不为迁就而在任一端造第二套事实。
- `sys.guard-reuse`（**过窄**）：补 [T07] 例外清单纪律——每项写明理由、缺陷修复后必须删除、过期例外必须报错。
- `sys.evidence-qualification`（**过窄**）：补 [T07] 指标语义与口径一致；不得用一个维度的观测推另一个维度的结论。
- `sys.scope-convergence`（**权威副本**）：收编 [C11] 末条"不做过度兼容"，review-dual-track 交叉引用不再重复定义。

**未吸收及理由**：MGP 的市场/行情/K线/KYC/支付/Provider/Kafka-topic/DcsLock/MySQL 权限矩阵等属领域细节；
`agent-sync` 目录结构、`MGP-LIFECYCLE` 标记格式、Ruleset-Version 治理属该仓工程约定，本仓已有等价机制（项目事件存储、状态机终态、规则三级继承）。
