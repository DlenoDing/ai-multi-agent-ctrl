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

### 待落地为控制面机制（A 类候选，记入 known-design-gaps）

- **可复用 worker lane 模型 + lane registry**（§2.2）：把顶层会话建模为可复用 lane（laneId/reuseMode/reusePrecheck/rotate-retire），当前 placement 仅 subagent|new_session（一次性），无 lane/registry/复用前置校验。
- **每派发机器可读 admissionDecision 记录**（§4.5）：候选/选定/deferred/blocked/resourceQueued/evidenceQualification/whyThisCellNow/workerCarrierDecision/modelDecision 一条持久化记录 + 正交状态字段互斥。
- **单 cell 阻断防升格全局门 + 正交调度维度**（§4.5）：存在可执行 cell 时禁止 overall_blocked，defer 后强制全局重扫。
- **findingDisposition 闭合枚举强化**（§4.6）：`verification_incomplete/no_pass_preflift/"已记录"/"后续再看"` 不是闭合状态；close-barrier 终态集（现 resolved/closed/dismissed/wontfix）宜收敛为需绑定受限终态+证据，避免"无修复即闭合"。

> 说明：默认系统规则可被项目/任务组按 §4.4 三级机制启用/停用/改写单条。控制面对 A 类规则已有硬约束；B 类规则通过内容包硬性下发（不靠指令措辞），会话开始前摘要校验不符即拒绝执行。
