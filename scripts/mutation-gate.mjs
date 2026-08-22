#!/usr/bin/env node
/*
 * 判别力门（mutation gate）
 *
 * 问题：一条"测试通过"并不能证明它护住了任何东西。在人工定稿闸门这一系列改动里，我自己写的验证
 * 有一半是【假绿】——断言含宽泛的析取项、种子里本来就有别的失败源、只做单向断言（只证明坏结果没
 * 发生，不证明好结果发生了）。这些测试在守卫被删掉之后照样通过，等于门自己在空转。
 *
 * 做法：对每个关键守卫，把它【故意改坏】（mutation），然后要求 contract-check 必须失败，并且失败
 * 信息里要出现那条守卫对应的断言。改坏之后仍然全绿 = 那条测试没有判别力，本门直接报错。
 *
 * 这是把"还原修复→确认测试失败"这套一直靠手工执行的纪律固化成 CI 可执行的检查。
 */
import { execFile, execFileSync } from "node:child_process";
import { cpus, tmpdir } from "node:os";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describePendingWreckage } from "./lib/mutation-wreckage.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = "apps/control-plane-ui/lib/control-plane-core.mjs";
const MCP = "apps/mcp-server/server.mjs";
const GATEWAY = "apps/control-plane-ui/lib/agent-gateway.mjs";
const PGSTORE = "apps/control-plane-ui/lib/pg-sync-store.mjs";
const STORE = "apps/control-plane-ui/lib/state-store.mjs";
const SERVER = "apps/control-plane-ui/server.mjs";
const APP = "apps/control-plane-ui/public/app.js";
const I18N = "apps/control-plane-ui/public/i18n-zh.js";
const CONSOLE_GATE = "scripts/console-behaviour-check.mjs";

// 每条 mutation：把守卫改坏，期望 contract-check 失败且输出里出现 expect 片段。
const MUTATIONS = [
  // ── 本段会话新加的守卫：手工变异验过一次不算数，要每次全量 doctor 都重验 ─────────────
  {
    name: "取消/回收必须了结格子名下的资源",
    check: "verifyCancelSettlesTheCellsResources",
    file: CORE,
    from: "    settleCellOwnedResources(state, dispatch.taskGroupId, dispatch.workItemId, dispatch.failureReason);",
    to: "",
    expect: "旧输出目标仍然可用"
  },
  {
    name: "每个对象一条的派生记录不得上限抖动",
    check: "verifyPerScopeRecordsSurviveTheirCap",
    file: CORE,
    from: "  state.completionReadiness = capPerTaskGroupRecords([readiness, ...state.completionReadiness.filter((item) => item.taskGroupId !== taskGroupId)], state, 80);",
    to: "  state.completionReadiness = [readiness, ...state.completionReadiness.filter((item) => item.taskGroupId !== taskGroupId)].slice(0, 80);",
    expect: "规模下的编排循环停不下来"
  },
  {
    name: "准入账本不得随反复受阻线性增长",
    check: "verifyAdmissionLedgerDoesNotGrowWithFlapping",
    from: `    if (seenCells.has(item.workItemId)) continue;
    seenCells.add(item.workItemId);`,
    file: CORE,
    to: "",
    expect: "准入账本随反复受阻线性增长"
  },
  {
    name: "执行事件必须续上认领（长任务不得白干）",
    check: "verifyLongRunningWorkKeepsItsClaim",
    file: GATEWAY,
    from: "      dispatch.claimExpiresAt = renewed;",
    to: "",
    expect: "没有续上认领"
  },
  {
    name: "中央态不得当成完整状态写回",
    check: "verifyCentralOnlyStateCannotBeWritten",
    file: STORE,
    from: `  if (state && state.__centralOnly) {
    throw Object.assign(new Error("refusing_to_write_central_only_state"), {code: "AIMAC_CENTRAL_ONLY_WRITE"});
  }`,
    to: "",
    expect: "竟然被接受了"
  },
  {
    name: "认不出的状态版本必须拒读",
    check: "verifyUnknownStateSchemaIsRefused",
    file: STORE,
    from: "  if (SUPPORTED_STATE_SCHEMA_VERSIONS.has(declared)) return state;",
    to: "  return state;",
    expect: "竟然照读不误"
  },
  {
    name: "报文只给对象 id 时也要核对归属",
    check: "verifyGrantScopeCoversObjectsNamedOnlyById",
    file: MCP,
    from: `  if (args.contractId) {
    const definition = (state.sharedDefinitions || []).find((item) => item.contractId === args.contractId);
    if (definition && definition.projectId && definition.projectId !== grant.projectId) return false;
  }`,
    to: "",
    expect: "MCP 授权匹配"
  },
  {
    name: "核心决策必须真人定稿",
    check: "verifyHumanAndOrganizationContracts",
    file: CORE,
    from: 'if (request.decisionClass === "major" && !isHumanConfirmationActor(state, options.actor))',
    to: "if (false)",
    expect: "机器主体（service_account）竟然可以定稿核心决策"
  },
  {
    name: "AI 互审不得直接验收",
    check: "verifyHumanAndOrganizationContracts",
    file: CORE,
    from: 'workItem.status = "verification_ready";',
    to: 'workItem.status = "verified";',
    expect: "AI 互审仍然直接把工作项标记为 verified"
  },
  {
    name: "AI 再分析不得终结决策",
    check: "verifyHumanAndOrganizationContracts",
    file: CORE,
    from: 'if (!request.awaitingAiAnalysis && Number(request.round || 1) > 1)',
    to: "if (false)",
    expect: "AI 可连续刷新候选方案推进轮次"
  },
  {
    name: "定稿对象不得被掉包",
    check: "verifyHumanAndOrganizationContracts",
    file: CORE,
    from: "if (request.subjectContentDigest) {",
    to: "if (false) {",
    expect: "方案在人点确认前被改掉，定稿却仍然生效"
  },
  {
    name: "承载授权的记录 id 必须唯一",
    check: "verifyHumanAndOrganizationContracts",
    file: CORE,
    from: "if ((collection || []).some((item) => item?.[idField] === id)) {",
    to: "if (false) {",
    expect: "允许重复 id（冒名记录可顶替人批准的那一份）"
  },
  {
    name: "写入边界一个工作项只能有一份",
    check: "verifyHumanAndOrganizationContracts",
    file: MCP,
    from: "if (activeExisting) return {repositoryOutputTarget: activeExisting, deduplicated: true};",
    to: "",
    expect: "同一工作项出现了多份生效的写入边界"
  },
  {
    name: "确认单去重键按类别隔离",
    check: "verifyHumanAndOrganizationContracts",
    file: CORE,
    from: "const dedupeKey = `${decisionType}:` + (String(input.requestKey",
    to: 'const dedupeKey = "" + (String(input.requestKey',
    expect: "运行时确认单顶掉了核心决策单"
  },
  {
    name: "执行证据去重限定本次派发",
    check: "verifyHumanAndOrganizationContracts",
    file: GATEWAY,
    from: "item.eventKey === eventKey && item.dispatchId === dispatchId",
    to: "item.eventKey === eventKey",
    expect: "执行事件按全局 eventKey 去重"
  },
  {
    name: "技能绑定不得被冒名顶替且不得回退占位",
    check: "verifyHumanAndOrganizationContracts",
    file: CORE,
    from: "skillBasename(skill) === hint.skillRef",
    to: 'String(skill.roleSkillId || "").endsWith("/" + hint.skillRef)',
    expect: "真实同步技能没有被绑定"
  },
  // 本次会话新增的守卫。它们的判别力当时都手工验过，但手工验证不可重复 —— 而"守卫在，
  // 而它的测试是假绿"正是本门存在的理由。只收有 contract-check 断言的那几条（本门只跑它）。
  {
    name: "已关闭的任务组不得被再关一次（覆盖定稿归属）",
    check: "verifyHumanAndOrganizationContracts",
    file: CORE,
    from: 'if (request.mutate === true && taskGroup && ["closed", "aborted"].includes(taskGroup.status)) {',
    to: "if (false) {",
    expect: "already-closed"
  },
  // 「人确认的定稿方案，AI 不会再默认自动改变；有分歧则回到人工确认」是这套系统的立身规则，
  // 它落在这三处：AI 不得自行降级、不得自行取消、不得在方案实质变过之后照常往下执行。
  // 三处此前都只有 contract-check 断言，没有一条被判别力验证过——而这正是最不该假绿的地方。
  {
    // 同一个漏传，在 runtime_json 上是当场抛错、零损失，在 PostgreSQL 上是删光整张分片表并提交。
    // 安全的那个行为落在没人在生产上跑的后端上，所以这条必须钉死。
    name: "漏传分片不得被当成空分片（PG 上等于删光）",
    check: "verifyRuntimeJsonConflict",
    file: PGSTORE,
    from: "    shards: assertProjectShardsArray(projectShards),",
    to: "    shards: Array.isArray(projectShards) ? projectShards : [],",
    expect: "没有接在 PostgreSQL 写入路径上"
  },
  {
    name: "被降级的状态机保证不得对人隐身",
    check: "verifyHumanAndOrganizationContracts",
    file: CORE,
    from: "  state.runtime.transitionEnforcement = transitionEnforcementMode(state);",
    to: "  state.runtime.transitionEnforcement ||= transitionEnforcementMode(state);",
    expect: "没有被重算覆盖"
  },
  {
    name: "定稿后方案实质变过就不得照常执行",
    check: "verifyHumanAndOrganizationContracts",
    file: CORE,
    from: 'if (["start", "merge"].includes(action) && topology.humanFinalization?.subjectContentDigest) {',
    to: "if (false) {",
    expect: "实质内容被改动"
  },
  {
    name: "AI 不得自行降级已定稿方案",
    check: "verifyHumanAndOrganizationContracts",
    file: CORE,
    from: 'if (topology.humanFinalization?.outcome === "confirmed" && !downgradeApproved) {',
    to: "if (false) {",
    expect: "自行降级"
  },
  {
    name: "AI 不得自行取消已定稿方案",
    check: "verifyHumanAndOrganizationContracts",
    file: CORE,
    from: 'if (topology.humanFinalization?.outcome === "confirmed" && !cancelApproved) {',
    to: "if (false) {",
    expect: "自行取消"
  },
  {
    name: "人要据以定稿的文本被截断时必须留痕",
    check: "verifyHumanAndOrganizationContracts",
    file: CORE,
    from: "return `${text.slice(0, Math.max(0, max - marker.length))}${marker}`;",
    to: "return text.slice(0, max);",
    expect: "静默截断"
  },
  {
    name: "执行器凭据不得等同于节点令牌",
    check: "verifyAgentGatewayContracts",
    file: GATEWAY,
    from: 'if (dispatch.status !== "running" || !dispatch.executorTokenDigest || !dispatch.assignedNodeId) continue;',
    to: "if (!dispatch.executorTokenDigest || !dispatch.assignedNodeId) continue;",
    expect: "executor credential"
  },
  {
    name: "规则标题必须进摘要（否则改标题＝改模型读到的内容而漂移检测失明）",
    check: "verifyHumanAndOrganizationContracts",
    file: CORE,
    from: "const digest = digestOf({ruleId, category, title, content});",
    to: "const digest = digestOf({ruleId, category, content});",
    expect: "effective-rules digest"
  },
  {
    name: "草稿契约不得锁死关闭门（人无杠杆）",
    check: "verifyHumanAndOrganizationContracts",
    file: CORE,
    // 必须唯一匹配：这个片段在 core 里出现三次（派发循环 / completion readiness / close barrier），
    // 而被测的是 computeCloseBarrier 那一处。只写片段会改坏派发循环，于是本门报出"你的测试是假绿"，
    // 而那条测试其实好好的 —— 一个把人派去删掉有用断言的假阳性。连上下文一起写。
    // 瞄准 computeCompletionReadiness 里那一处：带 objectType:"SharedDefinitionContract" 的阻塞对象
    // 由它产出（checkFailures.shared_definitions_active → blockers.push），而断言检查的正是那些对象。
    // 关闭门里同名的 all_shared_definitions_active 是另一条腿，改它不会影响这条断言。
    // 我为这条 mutation 瞄错过两次（先是派发循环，再是关闭门），两次的症状都是"你的测试是假绿" ——
    // 用代码片段钉住突变本身就容易瞄错，而它的误报方向恰好是最会误导人的那个。
    from: 'shared_definitions_active: relatedSharedDefinitions(state, taskGroup).some((definition) => SHARED_DEFINITION_BLOCKING_STATUSES.includes(definition.status)),\n    repository_output_target_terminal',
    to: 'shared_definitions_active: relatedSharedDefinitions(state, taskGroup).some((definition) => definition.status !== "active"),\n    repository_output_target_terminal',
    expect: "AI 能建出的草稿契约就锁死了关闭门"
  },
  {
    name: "裸 Project 通配不得横扫全项目",
    check: "verifyHumanAndOrganizationContracts",
    file: CORE,
    from: "const projectRefs = [`Project:${taskGroup.projectId}`, taskGroup.projectId];",
    to: 'const projectRefs = [`Project:${taskGroup.projectId}`, taskGroup.projectId, "Project"];',
    expect: "裸 Project 通配锁死了别的任务组"
  },
  {
    name: "合法发布必须真的激活",
    check: "verifyHumanAndOrganizationContracts",
    file: CORE,
    from: "args.allowDirectActivation === true",
    to: "false",
    expect: "合法发布未能激活"
  },
  {
    name: "技能绑定读的是生产者真实字段",
    check: "verifyHumanAndOrganizationContracts",
    file: CORE,
    from: 'String(skill.sourcePath || "")',
    to: 'String(skill.relativePath || "")',
    expect: "真实同步技能没有被绑定"
  },
  {
    name: "共享定义状态不得由调用方声称",
    check: "verifyHumanAndOrganizationContracts",
    file: CORE,
    from: "      : (SHARED_DEFINITION_CREATABLE_STATUSES.includes(args.status) ? args.status : \"draft\"),",
    to: '      : (args.status || "draft"),',
    expect: "调用方可直接把共享定义声明为生效/冲突"
  },
  {
    // 原先这条是空转的：to 只在行尾追加一句注释（什么也没改坏），skip 说"由 validate-specs 的源码
    // 断言覆盖"、而那句断言在整份文件里找一行 consumerBind 也有的字符串，锚点还因此撞成了两处。
    // 契约门里本来就有真行为断言（传未知 contractId，要求 ok===false），直接接上它。
    name: "publish 不得铸造未知契约",
    file: MCP,
    check: "verifyHumanAndOrganizationContracts",
    from: 'if (!definition) return {ok: false, error: "shared_definition_not_found"};\n  // 生效的共享定义会被分发进每个 agent 的任务契约和指令包',
    to: 'if (!definition) return {sharedDefinition: {contractId: args.contractId, status: "active"}};\n  // 生效的共享定义会被分发进每个 agent 的任务契约和指令包',
    expect: "publish 铸造并激活了一个未知契约"
  },
  {
    name: "越权访问必须被漂移门定性阻断",
    check: "verifyHumanAndOrganizationContracts",
    file: CORE,
    from: "const hardViolation = signals.some",
    to: "const hardViolation = [].some",
    expect: "单条越权访问未被角色漂移门拦下"
  },
  // ── 2026-08-03 本轮新增的守卫。它们的判别力都在加入时手工验过一次，但手工验证不可重复：
  // 一次重构悄悄让某道门失效，不会有任何东西发现。这七条都护着【安全边界】或【不可逆的数据损失】，
  // 所以必须把"改坏它会红"这件事变成可重复的记录。
  {
    name: "人工定稿锁只看状态，不得挂在展示用数值上",
    check: "verifyHumanAndOrganizationContracts",
    file: CORE,
    from: '      if (["verified", "closed"].includes(workItem.status)) {',
    to: '      if (["verified", "closed"].includes(workItem.status) && workItem.progress >= 100) {',
    expect: "已被人验收定稿的工作项又被派发出去了"
  },
  {
    name: "容量淘汰不得删掉还开着的任务组",
    check: "verifyHumanAndOrganizationContracts",
    file: STORE,
    from: '  taskGroups: (item) => !["closed", "aborted"].includes(item.status)',
    to: "  taskGroups: () => false",
    expect: "里最老的【未了结】记录被容量淘汰"
  },
  {
    name: "容量淘汰不得删掉人已经作出的决定",
    check: "verifyHumanAndOrganizationContracts",
    file: STORE,
    from: '  humanConfirmationRequests: (item) => !["consumed", "expired", "cancelled"].includes(item.status),',
    to: '  humanConfirmationRequests: (item) => item.status === "pending",',
    expect: "把【非终态】HumanConfirmationRequest.answered 当成可淘汰的历史"
  },
  {
    name: "MCP 租户边界必须覆盖每一个对象地址",
    check: "verifyEveryProjectScopedIdIsScopeChecked",
    file: MCP,
    from: '  "envelopeId", "grantId", "nodeId", "reviewBundleId", "reviewPlanId", "topologyId"',
    to: '  "envelopeId", "grantId", "nodeId", "reviewBundleId", "reviewPlanId"',
    expect: "topologyId 是一个项目级对象地址"
  },
  {
    name: "读侧每个集合都要么被过滤、要么登记为全局",
    check: "verifyEveryStateCollectionIsTenantScoped",
    file: SERVER,
    from: "  cloned.reviewBundles = (state.reviewBundles || []).filter((item) => visibleTaskGroupIds.has(item.taskGroupId));\n",
    to: "",
    expect: "既没有在 scopedStateForAccount 里按可见性过滤"
  },
  {
    name: "幂等重放必须绑定到当初那个调用方",
    check: "verifyIdempotencyReplayIsPrincipalBound",
    file: MCP,
    from: "        || existingRecord.principalRef !== principalRef))",
    to: "))",
    expect: "另一个主体用同一把幂等键拿到了上一个主体的执行结果"
  },
  {
    name: "分片拆合不得丢字段",
    check: "verifyShardRoundTripKeepsEveryRecord",
    file: STORE,
    from: "      shard.collections[collection].push(item);",
    to: "      const {updatedAt, ...rest} = item;\n      shard.collections[collection].push(rest);",
    expect: "落盘再读回后对不上"
  },
  // ↓ 本会话新增的守卫。它们此前只被手工变异验证过一次，而"验证过一次"与"以后一直有效"是两件事。
  {
    name: "控制命令重试用尽后不得还说「进行中」",
    check: "verifyExhaustedControlRetriesTellTheTruth",
    file: GATEWAY,
    from: "      dispatch.blockedReason = rejectedReason;",
    to: '      dispatch.blockedReason = "control_pause_requested";',
    expect: "重试用尽后，派发原因仍是"
  },
  {
    name: "人批准的路径边界必须压在 git 算出的真实变更上",
    check: "verifyHumanApprovedPathsBindTheCommit",
    file: CORE,
    from: "  if (approvedPaths.length) {",
    to: "  if (false) {",
    expect: "人批的边界只由 agent 自报来守"
  },
  {
    name: "人在方案里划的禁区必须被强制",
    check: "verifyHumanApprovedPathsBindTheCommit",
    file: CORE,
    from: "  if (forbiddenApproved.length) {",
    to: "  if (false) {",
    expect: "禁区只是记录里的一行字"
  },
  {
    name: "人批准时看到的验收项必须有证据",
    check: "verifyApprovedAcceptanceChecksHaveEvidence",
    file: CORE,
    from: "      && (branch.acceptanceChecks || []).length && !(branch.validationEvidenceRefs || []).length) {",
    to: "      && false) {",
    expect: "跑没跑从来没有人对账"
  },
  {
    name: "任务组读摘要的记忆化必须按 stateVersion 失效",
    check: "verifyPerformanceCachesStayCorrect",
    file: CORE,
    from: "  if (!perState || perState.stateVersion !== stateVersion) {",
    to: "  if (!perState) {",
    expect: "记忆化把变化盖住了"
  },
  {
    name: "一轮结束必须补上被推迟的历史裁剪",
    file: CORE,
    from: "    try { capBoundedHistories(state); } catch { /* 裁剪失败不该掩盖本轮真正的异常 */ }",
    to: "",
    check: "verifyPerformanceCachesStayCorrect",
    expect: "没有被裁回上限"
  },
  // ── 非契约门的守卫。它们此前只在写下的当天被手工变异过一次，之后再没有任何东西
  //    证明它们仍有判别力 —— 而本会话两次写出"按构造永远为真"的断言，都是靠变异才发现的。
  {
    name: "每条推进路径都要先对账（否则死节点永远在线）",
    file: SERVER,
    gate: "specs",
    from: "    recycleExpiredClaims(state);\n    const result = runAutonomousCycle(state, {root: repositoryRoot, runtimeDir, endpoint: publicEndpoint(req)",
    to: "    const result = runAutonomousCycle(state, {root: repositoryRoot, runtimeDir, endpoint: publicEndpoint(req)",
    expect: "没有先 recycleExpiredClaims"
  },
  {
    name: "给人看的房间那一屏要取最近的几条",
    check: "verifyRoomWaitTailAndTruncationHonesty",
    file: CORE,
    from: "  const messages = args.tail ? pending.slice(-limit) : pending.slice(0, limit);",
    to: "  const messages = pending.slice(0, limit);",
    expect: "错过谈成结论的那一段"
  },
  {
    name: "房间消息截断要如实报数",
    check: "verifyRoomWaitTailAndTruncationHonesty",
    file: CORE,
    from: "    total: pending.length, truncated: pending.length > messages.length};",
    to: "  };",
    expect: "看不出还有更多"
  },
  {
    name: "房间消息被截断时界面要说清共有多少条",
    file: APP,
    gate: "console",
    from: "          ${tgDetail.roomMessagesTruncated",
    to: "          ${false && tgDetail.roomMessagesTruncated",
    expect: "被截断却不报总数"
  },
  {
    name: "没有可用模型时要给人挂 S1 阻塞",
    check: "verifyNoModelFallbackMatchesWhatEngineDoes",
    file: CORE,
    from: '        addBlocker(taskGroup, "S1", `没有可运行的模型满足工作项 ${workItem.id} 的硬性约束。`);',
    to: "",
    expect: "没有给人挂 S1 阻塞"
  },
  {
    name: "模型选择策略的声明必须与引擎实际做的一致",
    check: "verifyNoModelFallbackMatchesWhatEngineDoes",
    file: CORE,
    from: 'fallbackPolicy: {onNoModel: "request_decision"',
    to: 'fallbackPolicy: {onNoModel: "split_task"',
    expect: "声明与实现不一致"
  },
  {
    name: "人工补充要求要有上限（否则每次派发都背着它）",
    check: "verifyHumanGuidanceIsBoundedAndHonest",
    file: CORE,
    from: "  taskGroup.humanGuidance = next.slice(-HUMAN_GUIDANCE_LIMIT);",
    to: "  taskGroup.humanGuidance = next;",
    expect: "没有上限"
  },
  {
    name: "补充要求被丢掉就必须报数",
    check: "verifyHumanGuidanceIsBoundedAndHonest",
    file: CORE,
    from: "    taskGroup.humanGuidanceDroppedCount = Number(taskGroup.humanGuidanceDroppedCount || 0) + (next.length - HUMAN_GUIDANCE_LIMIT);",
    to: "",
    expect: "悄悄丢掉人下达的要求"
  },
  {
    name: "人工补充要求要在任务组页看得见",
    file: APP,
    gate: "console",
    from: "        ${(taskGroup.humanGuidance || []).length ? `",
    to: "        ${false ? `",
    expect: "任务组页不显示人工补充要求"
  },
  {
    name: "运行时提交不得改用户仓库的 git 配置",
    check: "verifyCommitWorksWithoutConfiguredIdentity",
    file: CORE,
    from: "  try {\n    return gitStrict(root, [\"commit\", \"-m\", message]);",
    to: "  if (!git(root, [\"config\", \"user.email\"], \"\")) gitStrict(root, [\"config\", \"user.email\", \"agent-runtime@local\"]);\n  try {\n    return gitStrict(root, [\"commit\", \"-m\", message]);",
    expect: "写了东西"
  },
  {
    name: "阻塞类型指引：清单要按 core 全量取，不是手写",
    file: CONSOLE_GATE,
    gate: "console",
    from: '[...coreSource.matchAll(/objectType:\\s*"([A-Za-z]+)"/gu)]',
    to: '[...coreSource.matchAll(/objectTypeXX:\\s*"([A-Za-z]+)"/gu)]',
    expect: "本条在空转"
  },
  {
    // idle 这道门此前那条登记变异其实测的是视图过滤（它借这道门起真实服务）。
    // 它自己的核心判据——"空转的自治循环会收敛到不再落盘"——从没被人看着红过。
    // 每拍都落盘不是浪费磁盘那么简单：状态每写一次就重排一次历史，等于系统自己删自己的证据。
    name: "空转的自治循环必须收敛到不再落盘",
    file: SERVER,
    gate: "idle",
    from: "    if (digestAfter === digestBefore) {",
    to: "    if (false) {",
    expect: "仍在每拍推进"
  },
  {
    // 核心决策必须带轮次令牌：可选校验等于没校验。round_stale 那条只在带了轮次时才生效，
    // 所以"不带会被拒"这一支同样要有反面用例，否则整道防 TOCTOU 是可绕过的。
    name: "核心决策不带轮次令牌不得放行",
    file: CORE,
    check: "verifyHumanAndOrganizationContracts",
    from: '  if (request.decisionClass === "major" && decision.expectedRound === undefined) {',
    to: '  if (false && request.decisionClass === "major" && decision.expectedRound === undefined) {',
    expect: "不带 expectedRound 也能定稿"
  },
  {
    // 树摘要标的是"这次提交到底改出了什么内容"。谎报能过的话，提交里的东西就与它自称的无关了。
    name: "提交的树摘要必须与真实提交对得上",
    file: CORE,
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: '    if (!actualTree || `git-tree:${actualTree}` !== String(commitRef.treeDigest)) {',
    to: "    if (false) {",
    expect: "内容摘要可以随便写"
  },
  {
    // "AI 给自己判分"的核心边界：控制面自己去 git 里查这个 commit 在不在，不信 agent 自报。
    // 塌了就等于关闭门可以拿凭空的提交过。注意不能变异那句 if (!fullCommit) ——
    // 同一个错误码有两道守卫接着，关掉一道错误码不变，看起来像"改坏了也没事"。
    name: "凭空的 commit 不得被当成检查点证据",
    file: CORE,
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: '    const fullCommit = git(root, ["rev-parse", "--verify", `${commitRef.commit}^{commit}`], "");',
    to: "    const fullCommit = commitRef.commit;",
    expect: "拿凭空的提交过关闭门"
  },
  {
    // 技能源取不下来时只抛 git 原始报错、状态一动不动：人点完同步只看到一条会消失的 toast，
    // 那张表还写着 configured —— 看不出这个源从来没同步成功过，而它决定 agent 会做什么。
    name: "技能源同步失败要在状态上留下痕迹",
    file: CORE,
    check: "verifySkillSourceSyncFailureIsVisible",
    from: '    throw Object.assign(new Error(`skill_source_sync_failed:${source.sourceId}：${source.lastSyncError}`), {cause: error});',
    to: "    throw error;",
    expect: "原始 git 报错"
  },
  {
    // 认不出的存储名会被静默当成 runtime_json（postgres / postgresql 是最容易写错的一对）。
    // 后果不是启动失败，而是【启动成功但接在另一个存储上】：一切看起来正常，人却在空状态上工作。
    name: "认不出的存储名不得静默退回本地 JSON",
    file: STORE,
    from: "  if (!KNOWN_STATE_STORES.includes(configured)) {",
    to: "  if (false) {",
    check: "verifyStateStoreConfigIsNotSilentlyDowngraded",
    expect: "被默默接受了"
  },
  {
    // 技能源那张表此前不显示仓库地址：人看不出这个源钉的到底是什么，
    // 而"钉住哪一份"正是它存在的理由。
    name: "技能源要显示它钉的是哪个仓库",
    file: APP,
    gate: "console",
    from: '<div class="small muted mono">${esc(source.repositoryUrl || "-")}',
    to: '<div class="small muted mono">${esc("")}',
    expect: "不显示仓库地址"
  },
  {
    // 控制面挂掉时这一屏此前只弹一次 toast：toast 消失之后，画面还挂着上一次成功时的数据，
    // 而屏幕上没有任何迹象说"这已经不是现在的样子了"。监控台最要紧的恰恰是这一刻。
    name: "加载失败要常驻说明这是旧数据",
    file: APP,
    gate: "console",
    from: "        ${lastError ? `<div class=\"notice warn-notice\">${lastErrorIsRequest\n",
    to: "        ${false ? `<div class=\"notice warn-notice\">${lastErrorIsRequest\n",
    expect: "人对着一屏冻住的数据看不出任何异常"
  },
  {
    // 故障标记只置不清：修好之后还一直报 degraded，人很快就会开始无视这个信号 ——
    // 而提示里还写着"恢复之后会自动转回 ok"，那句话就成了假的。
    name: "存储故障修好之后健康检查要自己转回 ok",
    file: SERVER,
    gate: "crash",
    from: "      if (recovered) {\n        lastStorageFault = null;",
    to: "      if (false) {\n        lastStorageFault = null;",
    expect: "自动转回 ok"
  },
  {
    // 只删状态文件（目录还在）：存储层按种子重建一份空的，登录全失败而健康检查照样 ok。
    // 目录 inode 那条判据认不出这种，所以要靠存储层把"我刚重建过"说出来。
    name: "状态被按种子重建过要算故障",
    file: STORE,
    gate: "crash",
    from: "  if (!existsSync(options.statePath)) {\n    lastRebuiltFromSeedAt = new Date().toISOString();",
    to: "  if (!existsSync(options.statePath)) {\n    lastRebuiltFromSeedAt = null;",
    expect: "健康检查要认这是故障"
  },
  {
    // 运行目录被清掉时，存储层会静默重建一份空状态：登录全失败、数据全没了，而健康检查照样 200。
    // 只查"文件在不在"没用（请求管线里的 ensureState 已经把它重建出来了），所以按 inode 认。
    name: "运行目录被清掉之后健康检查必须转 degraded",
    file: SERVER,
    gate: "crash",
    from: '    if (!lastStorageFault && stateStoreKind() === "runtime_json" && runtimeDirIdentity) {',
    to: "    if (false) {",
    expect: "健康检查转成 degraded"
  },
  {
    // 状态文件损坏时若原样抛 SyntaxError：中央文件坏了只看到 "Unterminated string in JSON at
    // position 31584"，分片坏了更糟 —— 服务照常起、健康检查一路 200，监控绿着而读数据全挂。
    name: "状态文件损坏要说清是哪一份，并把健康检查压成 degraded",
    file: STORE,
    gate: "crash",
    from: "  catch { throw new Error(`control_plane_state_corrupt:${basename(path)}`); }",
    to: "  catch (error) { throw error; }",
    expect: "健康检查报 degraded"
  },
  {
    // 盘写不进去是真实运维故障（满盘 / 只读挂载 / 权限 / 配额）。此前回的是 500 加一句 Node 的
    // 原始英文错误，报文里还带着服务器的绝对路径：中文界面上看不懂，运维不知道该查什么。
    name: "盘写不进去要给稳定错误码，且不回服务器路径",
    file: SERVER,
    gate: "crash",
    from: '  if (["EACCES", "EPERM", "ENOSPC", "EROFS", "EDQUOT", "EMFILE", "ENFILE"].includes(error?.code)) {',
    to: "  if (false) {",
    expect: "给的是稳定错误码"
  },
  {
    // crash 这道门此前只有一条登记变异。它最要紧的那条"硬杀之后仍是完整 JSON"其实是抽查：
    // 实测把原子替换整个拿掉、连跑五次仍然全绿（文件小、写得快，SIGKILL 撞不进写窗口）。
    // 所以原子性改用结构判据来钉，而这一条是确定性的 —— 连跑两次都稳定报红。
    name: "持久写入必须写临时文件再 rename（不得就地改目标文件）",
    file: STORE,
    gate: "crash",
    from: '  const temporary = `${options.statePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;',
    to: "  const temporary = options.statePath;",
    expect: "临时路径必须是另一条路径"
  },
  {
    // writer 这道门此前也只有一条登记变异（丢更新）。并发下"同一张定稿卡恰好一个人定成"
    // 是人工闸门在多进程部署下的立足点，而它从没被人看着红过：拿掉"已非待确认"这道守卫，
    // 两个进程会各自定稿成功，两份都写进磁盘 —— 谁批的、批了哪一版，从此说不清。
    name: "同一张定稿卡不得被两个进程同时定成",
    file: CORE,
    gate: "writer",
    from: '  if (request.status !== "pending") {\n',
    to: "  if (false) {\n",
    expect: "恰好一个成功"
  },
  {
    // 上一条验的是"没登记会被点名"，这条验的是【排除验证代码这一步本身是承重的】：
    // 把它去掉，整族登记会立刻被判成"已接上"，也就是收紧之前那种隐身状态。
    name: "死导出语料必须排除验证代码",
    file: "scripts/barrier-liveness-gate.mjs",
    gate: "barrier",
    from: "        && !verification.has(full)) files.push(full);",
    to: "        ) files.push(full);",
    expect: "failCommand 已经被接上了，但仍登记"
  },
  {
    // 一条源码字符串断言若能匹配到多处，它就指认不出自己守的是哪一处：隔壁复制粘贴出的同形代码
    // 会替真守卫喂饱它。这里真的造一处同形代码，要求 specs 门当场点名。
    name: "源码断言不得被同形代码喂饱",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    gate: "specs",
    from: "if (!providers.size) return false",
    to: "if (!providers.size) return false; // 同形代码：if (!providers.size) return false",
    expect: "能匹配 2 处"
  },
  {
    // 上面那道扫描被打瞎时会静默变成"核对了 0 条"而一片绿 —— 空转下限必须自己也能报红。
    name: "断言搜索面自查不得空转",
    file: "scripts/validate-specs.rb",
    gate: "specs",
    from: "next unless needle.length >= 22 &&",
    to: "next unless needle.length >= 2200 &&",
    expect: "这道扫描在空转"
  },
  {
    // agent 侧那半是结构判据，同样要能被改坏后报红。
    name: "agent 运行时每处起 git 子进程的地方都要取失败原因",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyGitFailureSaysWhyWithoutLeakingPaths",
    from: 'new Error(`git_command_failed:git clone（${gitFailureDetail(error)}）`)',
    to: 'new Error(`git_command_failed:git clone`)',
    expect: "直接起 git 子进程却不取失败原因"
  },
  {
    name: "报错要说清是哪一次请求失败的",
    file: APP,
    gate: "console",
    from: "${hint}（${requestPath}）`));",
    to: "${hint}`));",
    expect: "报错里没有出请求路径"
  },
  {
    // 渲染那条与 API 报错这条走的是两处调用点，各自守一条。
    name: "API 报错也要拆开翻译",
    file: APP,
    gate: "console",
    from: "${detail ? explainCoded(detail) : response.statusText}",
    to: "${detail ? t(detail) : response.statusText}",
    expect: "弹给人的提示还是一串英文键"
  },
  {
    name: "带细节的失败原因要拆开翻译",
    file: APP,
    gate: "console",
    from: "  if (prefix && Object.prototype.hasOwnProperty.call(dict, prefix)) return `${t(prefix)}：${text.slice(at + 1)}`;",
    to: "  if (false) return text;",
    expect: "屏幕上摆着一串英文键"
  },
  {
    // agent 运行时抛的失败会走进控制台同一列。这条守的是"那一族也在核对范围里"。
    name: "agent 运行时的失败原因也要有中文",
    file: I18N,
    check: "verifyEveryCloseGateHasHumanGuidance",
    from: '    executor_not_installed: "这台节点上没有可用的执行器",',
    to: '    executor_not_installed_x: "这台节点上没有可用的执行器",',
    expect: "executor_not_installed"
  },
  {
    // 面向人的错误码漏了中文，人在屏幕上看到的就是英文键。摘掉一条登记即等价于新增一个漏译。
    name: "面向人的 API 错误码必须有中文",
    file: "scripts/contract-check.mjs",
    check: "verifyEveryCloseGateHasHumanGuidance",
    from: "  room_task_group_mismatch: \"只在房间 POST 上返回",
    to: "  room_task_group_mismatchX: \"只在房间 POST 上返回",
    expect: "room_task_group_mismatch"
  },
  {
    // 压制不能被容量悄悄撤销：被压制的那条原地不动，够多新指纹就会掉出窗口。
    name: "被压制的模式不许被容量裁掉",
    file: CORE,
    check: "verifyRuntimeIssuePatternCanBeSettled",
    from: '      ...state.runtimeIssuePatterns.filter((item) => item.status === "suppressed"),',
    to: "      ...[],",
    expect: "人的判断被容量悄悄撤销了"
  },
  {
    // 人的判断必须传导到模式那一层，否则判过的事会一直被重新聚类。
    name: "候选被判不予处理时问题模式要压制",
    file: CORE,
    check: "verifyRuntimeIssuePatternCanBeSettled",
    from: '  const disposition = {dismissed: "suppressed", closed: "closed"}[candidateStatus];',
    to: "  const disposition = null;",
    expect: "状态机里那个终态还是没有生产者"
  },
  {
    // 压制之后不许被同一件事顶起来 —— 复活终态是另一类缺陷。
    name: "已压制的模式不许被重新顶起来",
    file: CORE,
    check: "verifyRuntimeIssuePatternCanBeSettled",
    from: '    item.issueFingerprint === fingerprint && item.status === "suppressed" && sameOwner(item));',
    to: '    item.issueFingerprint === fingerprint && item.status === "never-matches" && sameOwner(item));',
    expect: "人判过的事又回来了"
  },
  {
    name: "相对时间要按服务器时钟算",
    file: APP,
    gate: "console",
    from: "  return serverNow() - new Date(node.lastHeartbeatAt).getTime();",
    to: "  return Date.now() - new Date(node.lastHeartbeatAt).getTime();",
    expect: "所有健康节点都会显示已失联"
  },
  {
    name: "时钟偏差要告诉人，不能悄悄校正",
    file: APP,
    gate: "console",
    from: '  return `本机时钟比服务器${minutes > 0 ? "快" : "慢"} ${Math.abs(minutes)} 分钟`;',
    to: '  return "";',
    expect: "人就永远不知道自己这台机器的表是错的"
  },
  {
    name: "界面要说清时间按哪个时区显示",
    file: APP,
    gate: "console",
    from: '<span class="small muted" title="界面时间按本机时区显示；服务端日志用的是 UTC">${esc(localZoneLabel())}</span>',
    to: "",
    expect: "对日志的人会差几个小时"
  },
  {
    name: "已吊销节点不计入配额这件事要说出来",
    file: APP,
    gate: "console",
    from: "            return revoked ? `<div class=\"small muted\">另有 ${revoked} 个已吊销，不计入配额</div>` : \"\";",
    to: '            return "";',
    expect: "两个数对不上，人找不出原因"
  },
  {
    // 用量与列表算的必须是同一批人。把服务账号放回用量里，对照立刻不成立。
    name: "服务账号不算组织成员",
    file: CORE,
    check: "verifyOrganizationMembershipHasOneAuthority",
    from: '  if (!account || account.accountType === "service_account") return null;',
    to: "  if (!account) return null;",
    expect: "服务账号不是人"
  },
  {
    name: "成员列表必须走那处共用归属判据",
    file: SERVER,
    check: "verifyOrganizationMembershipHasOneAuthority",
    from: "      .filter((item) => organizationMembershipOf(item) === orgId)",
    to: '      .filter((item) => item.organizationId === orgId && item.accountType !== "service_account")',
    expect: "没有走那处共用判据"
  },
  {
    name: "处置候选的路由必须把判断传导给问题模式",
    file: SERVER,
    check: "verifyRuntimeIssuePatternCanBeSettled",
    from: "    settleRuntimeIssuePatternForCandidate(state, candidate, nextStatus);",
    to: "    void nextStatus;",
    expect: "没有任何调用方"
  },
  {
    name: "成员状态路由要走共用归属判据",
    file: SERVER,
    check: "verifyOrganizationMembershipHasOneAuthority",
    from: "    member: target && organizationMembershipOf(target) === orgId ? target : null,",
    to: "    member: target && (target.organizationId ?? null) === orgId ? target : null,",
    expect: "仍在直接读 target.organizationId"
  },
  {
    // 退役后自治周期还去同步它，"拿下去"就只是界面上的说法。
    name: "自治周期不许再同步已退役的技能源",
    file: CORE,
    check: "verifySkillSourceRetireCascades",
    from: ' && source.status !== "retired") {',
    to: ") {",
    expect: "自治周期把它又同步了一遍"
  },
  {
    // 退役的价值全在级联：只改状态不摘技能，等于退役了个寂寞。
    name: "技能源退役要摘掉它带来的角色技能",
    file: CORE,
    check: "verifySkillSourceRetireCascades",
    from: "  state.roleSkills = (state.roleSkills || []).filter((skill) => skill.sourceId !== sourceId);",
    to: "  state.roleSkills = state.roleSkills || [];",
    expect: "还留在注册表里"
  },
  {
    name: "指向被摘技能的叠加规则要终态化",
    file: CORE,
    check: "verifySkillSourceRetireCascades",
    from: '    overlay.status = "superseded";',
    to: '    overlay.status = overlay.status;',
    expect: "永远在等一个不存在的基底"
  },
  {
    name: "MCP 铸造授权要挡住查无此人的主体",
    file: "apps/mcp-server/server.mjs",
    check: "verifyCrossOrgGrantIsRefusedOnBothDoors",
    from: '    return {grant: null, declinedReason: "grant_subject_account_not_found"};',
    to: "    void subjectRef;",
    expect: "主体查无此人，MCP 仍然铸出了授权"
  },
  {
    // 「不许跨组织授权」原先只有 REST 那扇门守着。去掉 MCP 铸造点这道，必须当场报红。
    name: "MCP 铸造授权也要挡住跨组织",
    file: "apps/mcp-server/server.mjs",
    check: "verifyCrossOrgGrantIsRefusedOnBothDoors",
    from: '    return {grant: null, declinedReason: "cross_org_grant_not_allowed"};',
    to: "    void subjectAccount;",
    expect: "仍然铸出了 grant"
  },
  {
    // 孪生分支：MCP 侧退回降级写法，"两条路同规"那条判据必须当场报红。
    name: "MCP 侧建工作项也不得降级未知状态",
    file: "apps/mcp-server/server.mjs",
    check: "verifyUnknownEnumValuesAreRefusedNotCoerced",
    from: "    status: mcpWorkItemCreateStatus(args.status),",
    to: '    status: ["draft", "ready"].includes(args.status) ? args.status : "ready",',
    expect: "降级成 ready"
  },
  {
    // 人写的问责性文字超长时不能悄悄截断（存下的与人写的不一致）。
    name: "超长的人写文字必须拒绝而不是截断",
    file: CORE,
    check: "verifyUnknownEnumValuesAreRefusedNotCoerced",
    from: "  if (text.length <= limit) return text.trim();",
    to: "  if (true) return text.slice(0, limit).trim();",
    expect: "超长没有被拒"
  },
  {
    // 发现处置：认不出的状态降级成 resolved 是【有利结果】，且直接喂给关闭门。
    name: "认不出的发现状态不得降级成已解决",
    file: CORE,
    check: "verifyUnknownEnumValuesAreRefusedNotCoerced",
    from: '    return {ok: false, error: "finding_status_unknown", status: String(args.status).slice(0, 60), supported: terminal};',
    to: "    void args;",
    expect: "没有被拒"
  },
  {
    // 决策处置：reopen / abandon 是相反的两件事。
    name: "认不出的处置方式不得当成重开",
    file: CORE,
    check: "verifyUnknownEnumValuesAreRefusedNotCoerced",
    from: '  throw Object.assign(new Error("human_directive_resolution_unknown"),',
    to: '  if (false) throw Object.assign(new Error("human_directive_resolution_unknown"),',
    expect: "没有被拒"
  },
  {
    // 运维在自己机器上敲命令，不该收到一段 Node 崩溃栈。判别力由远程 agent e2e 覆盖
    // （它会真的 spawn 这个 CLI 打错子命令、连错地址）。
    name: "agentctl 失败时要给人话而不是崩溃栈",
    file: "scripts/agentctl.mjs",
    skip: "判别力由远程 agent e2e 覆盖（真的 spawn 这个 CLI 走失败路径）",
    from: "  fail(`认不出这个子命令${action ? `：${action}` : \"（一个都没给）\"}`,",
    to: "  throw new Error(`unknown subcommand: ${action}`);\n  fail(`认不出这个子命令${action ? `：${action}` : \"（一个都没给）\"}`,",
    expect: "认不出子命令时"
  },
  {
    // npm start 起不来是运维最常撞到的失败时刻。此前这一族是裸 throw + 机器码。
    name: "启动期拒绝要说清规则和下一步",
    file: "apps/control-plane-ui/server.mjs",
    skip: "判别力由控制面 e2e 覆盖（已用 mutate-probe 实证：换回机器码那道门变红）",
    from: "      throw startupError(`${envName} 这个密钥不安全，拒绝启动`, [",
    to: "      throw new Error(`${envName}_is_unsafe_default_or_too_short`);",
    expect: "没说清原因"
  },
  {
    // 装机的人是在一台新机器上 curl | sh，手上没有别的上下文。这三条都由远程 agent e2e 覆盖
    // （它真的把这个脚本跑失败）。登记在这里只是把"谁覆盖了它"写在明处 ——
    // 注意 skip 的条目【锚点不强制】，所以这份登记挡不住文案漂走，挡住它的是 e2e 里的断言本身。
    name: "装机脚本参数被截断时要给人话",
    file: "scripts/install-agent.sh",
    skip: "判别力由远程 agent e2e 覆盖（真的用截断的参数跑这个脚本）",
    from: '    printf \'%s\\n\' "install-agent: $1 后面少了取值" >&2',
    to: '    printf \'%s\\n\' "$2" >&2',
    expect: "后面少了取值"
  },
  {
    name: "装机脚本下载失败时要说清在下什么",
    file: "scripts/install-agent.sh",
    skip: "判别力由远程 agent e2e 覆盖（真的指向一个连不上的地址）",
    from: '    printf \'%s\\n\' "install-agent: 下载不到$3" >&2',
    to: '    printf \'%s\\n\' "download failed" >&2',
    expect: "下载不到"
  },
  {
    // 起完就宣布已启动 —— 进程当场退出也照说不误，控制面那边永远等不到这个节点。
    name: "装机脚本宣布已启动前要确认它还活着",
    file: "scripts/install-agent.sh",
    skip: "判别力由远程 agent e2e 覆盖（已用 mutate-probe 实证：守护进程当场死掉时那道门变红）",
    from: '  if ! kill -0 "$AGENT_PID" 2>/dev/null; then',
    to: "  if false; then",
    expect: "起来之后立刻退出了"
  },
  {
    // 检查点验收这条路上此前有 19 道门零覆盖。这三道是其中最要紧的：失效时伪造的检查点直接【已受理】。
    name: "空手不得宣布干完",
    file: CORE,
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: 'return {accepted: false, status: 409, error: "checkpoint_missing_git_evidence"};',
    to: "{ /* 守卫失效 */ }",
    expect: "一条提交证据都没给"
  },
  {
    name: "远端停在上一版不得算交付",
    file: CORE,
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: "if (recordedRemoteSha !== sourceCommit || recordedRemoteSha !== finalCommit) {\n      return {valid: false, status: 409, error: \"push_ref_must_point_to_final_commit\"};\n    }",
    to: 'if (false) { throw new Error("unreachable"); }',
    expect: "人在分支上复核的不是这次交上来的那一版"
  },
  {
    name: "改动不得越出产出目标的路径白名单",
    file: CORE,
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: "if (!changedPaths.every((path) => canUseGitPath(path) && pathMatchesAllowlist(path, target.pathAllowlist || []))) {\n    return {valid: false, status: 409, error: \"changed_paths_outside_repository_target_allowlist\"};\n  }",
    to: 'if (false) { throw new Error("unreachable"); }',
    expect: "这个目标可以改仓库里的任何东西"
  },
  {
    // 这道网平时【无事可抓】，没有任何产品代码的变异能证明它 —— 只能靠它自己的加载期自检。
    name: "报文里的 undefined 网不得是空的",
    file: "scripts/lib/no-undefined-payload.mjs",
    skip: "判别力由三个 e2e 的加载期自检覆盖（已用 mutate-probe 实证：判据改坏后当场报'这道网是空的'）",
    from: "if (/undefined/u.test(text)) {",
    to: "if (false) {",
    expect: "这道网是空的"
  },
  {
    // 派发绑定的授权：工具在白名单里，但入参指向别的任务组。守卫失效时节点真的把消息发进了隔壁房间。
    name: "受限节点不得对别的任务组说话",
    file: MCP,
    skip: "判别力由 MCP e2e 覆盖（已用 mutate-probe 实证：真实节点往隔壁房间发言时那道门变红）",
    from: "const scopedGrants = activeGrants.filter((grant) => grantMatchesArgs(state, grant, args));",
    to: "const scopedGrants = activeGrants;",
    expect: "没有被按作用域拒掉"
  },
  {
    // 认领返回的是整个派发包，取错一层不会报错，只会静静少验一种入参形态。
    name: "跨租户扫描的第三种入参不得退化成空参",
    file: "scripts/doctor-mcp.mjs",
    skip: "判别力由 MCP e2e 覆盖（已用 mutate-probe 实证：取错一层时那条自证变红）",
    from: "const grantedTaskGroupId = claimed.dispatch.dispatch?.taskGroupId;",
    to: "const grantedTaskGroupId = claimed.dispatch.taskGroupId;",
    expect: "少验一种形态"
  },
  {
    // 能替别人释放租约，就等于没有互斥。这条守卫失效时是"已受理"。
    name: "不得替别人释放租约",
    file: CORE,
    check: "verifyHumanAndOrganizationContracts",
    from: 'if (args.holderRef && lease.holderRef !== args.holderRef) return {ok: false, error: "lease_holder_mismatch"};',
    to: "/* 守卫失效 */",
    expect: "能替别人释放就等于没有互斥"
  },
  {
    // 申领侧那三条原先只判 `ok !== false`：换一道门拒它照样绿。收紧成点名错误码之后才有这条判别力。
    name: "租约持有者判据要认得出是哪道门拒的",
    file: CORE,
    check: "verifyHumanAndOrganizationContracts",
    from: 'return {ok: false, error: "lease_holder_scope_mismatch", holderRef};',
    to: 'return {ok: false, error: "lease_something_else", holderRef};',
    expect: "谁也回收不了的永久租约"
  },
  {
    // 新增一道守卫却不配判据 —— 它失效时不会有任何东西变红。棘轮就是拦这个的。
    name: "新增拒绝码必须带判据",
    file: CORE,
    check: "verifyRefusalCodeCoverageRatchet",
    from: 'if (!finalCommit) return {valid: false, status: 409, error: "commit_ref_not_found"};',
    to: 'if (!finalCommit) return {valid: false, status: 409, error: "brand_new_uncovered_guard_code"};',
    expect: "新增的守卫没有配判据"
  },
  {
    // 棘轮的通过条件是一个数字，提取一失配它就永远数出 0 而一片绿。
    name: "拒绝码棘轮不得空转",
    file: "scripts/contract-check.mjs",
    check: "verifyRefusalCodeCoverageRatchet",
    from: "    for (const match of src.matchAll(REFUSAL_CODE_FORMS)) codes.add(match[1]);",
    to: "    for (const match of src.matchAll(/nosuchthing:\\s*\"([a-z0-9_]{6,})\"/gu)) codes.add(match[1]);",
    expect: "这道门在空转"
  },
  {
    // "不修就放行"这两类处置由 AI 自己下，等于它能把自己造出来的问题一笔勾销、关闭门随之通过。
    name: "不修就放行的处置只能由真人下",
    file: CORE,
    check: "verifyHumanAndOrganizationContracts",
    from: "if (NON_REMEDIATION_DISPOSITIONS.includes(disposition) && !humanActor) {",
    to: "if (false) {",
    expect: "一笔勾销"
  },
  {
    // 闸门必须有出口：写成"一律拒绝"时，真人也过不去 —— 那是把这条路彻底堵死。
    name: "真人处置的出口不得被堵死",
    file: CORE,
    check: "verifyHumanAndOrganizationContracts",
    from: "if (NON_REMEDIATION_DISPOSITIONS.includes(disposition) && !humanActor) {\n    return {ok: false, error: \"finding_disposition_requires_human\", dispositionClass: disposition};",
    to: "if (NON_REMEDIATION_DISPOSITIONS.includes(disposition)) {\n    return {ok: false, error: \"finding_disposition_requires_human\", dispositionClass: disposition};",
    expect: "把出口一起堵死了"
  },
  {
    // 把一份来源标成 active＝宣布"本项目认它"，AI 自行采纳等于自己给自己定规范。
    name: "规则来源采纳只能由真人定",
    file: CORE,
    check: "verifyHumanAndOrganizationContracts",
    from: 'if (wantsAdoption && !humanActor) return {ok: false, error: "rule_source_adoption_requires_human"};',
    to: "/* 守卫失效 */",
    expect: "自行宣布"
  },
  {
    // 同一处守卫的另一种改坏法：连真人也拒。用 `wantsAdoption = true` 会先在别处报红
    // （AI 本可做的了结也被拒），变异门当场判它"红得不是地方"——那正是它该做的事。
    name: "真人采纳的出口不得被堵死",
    file: CORE,
    check: "verifyHumanAndOrganizationContracts",
    from: 'if (wantsAdoption && !humanActor) return {ok: false, error: "rule_source_adoption_requires_human"};',
    to: 'if (wantsAdoption) return {ok: false, error: "rule_source_adoption_requires_human"};',
    expect: "闸门没有出口"
  },
  {
    // 一次真实的间歇红只留下 `TypeError: fetch failed` + 一个端口号，看不出出自哪道门。
    name: "门里 fetch 失败要说清哪道门、哪个地址、以及这一轮还算不算数",
    file: "scripts/lib/gate-fetch.mjs",
    check: "verifyGateFetchFailuresNameTheGate",
    from: "本轮结论不可信",
    to: "连不上",
    expect: "没说清这一轮什么也没验"
  },
  {
    name: "起真实服务端的门都要装上那层自述",
    file: "scripts/idle-tick-gate.mjs",
    check: "verifyGateFetchFailuresNameTheGate",
    from: 'installGateFetch("空转门");',
    to: "// 没装",
    expect: "起了真实服务端却没装"
  },
  {
    // 它自己那套分类只盖住批量写那一段，后面几段是裸 fetch —— 这道门也必须装上。
    name: "并发写入门也要装上那层自述",
    file: "scripts/concurrent-writer-gate.mjs",
    check: "verifyGateFetchFailuresNameTheGate",
    from: "installGateFetch(\"并发写入门\");",
    to: "// 没装",
    expect: "起了真实服务端却没装"
  },
  {
    // async 检查用 run() 注册＝它推进 errors 时报告早就打完了，那条检查永远是绿的（本轮实撞）。
    name: "async 检查误用 run 必须当场拦住",
    file: "scripts/contract-check.mjs",
    check: "verifyGateFetchFailuresNameTheGate",
    from: "await runAsync(verifyGateFetchFailuresNameTheGate);",
    to: "run(verifyGateFetchFailuresNameTheGate);",
    expect: "必须用 runAsync 注册"
  },
  {
    // "接口下发了、界面没接"这一族已经漏过两次真事实（归档写失败、哈希链只校验尾窗）。
    // 一条变异同时验两个方向：字段没人读要报红，机器面登记过期也要报红。
    name: "下发给人的字段必须有人读",
    file: "scripts/contract-check.mjs",
    check: "verifyServerFieldsReachThePerson",
    from: '    tokenSource: "启动诊断：令牌来自环境变量还是本地配置，运维看日志"',
    to: '    tokenSourceGone: "已经不存在的字段"',
    expect: "而控制台全站没有一处读它"
  },
  {
    // 归档只按尾部一窗（512KB）读取与校验。文件几百 MB 时这一屏说"未发现改动"，
    // 而窗口之外的记录一条都没查过 —— 人恰恰是为了查有没有被改动才打开这一屏的。
    name: "只校验了尾窗时这一屏要说出来",
    file: APP,
    gate: "console",
    from: "      const windowNotice = archive.windowTruncated",
    to: "      const windowNotice = false",
    expect: "却没说窗口之外的记录一条都没查过"
  },
  {
    // 只说"截断了"而不给量级，人判断不了漏掉的是十条还是几百万条。
    name: "截断要给出量级",
    file: APP,
    gate: "console",
    from: "只读了归档末尾 ${esc(scannedMb(archive.bytesScanned))}（全文 ${esc(scannedMb(archive.fileBytes))}）",
    to: "只读了归档末尾一部分",
    expect: "人判断不了漏掉的是十条还是几百万条"
  },
  {
    // 这一类只有跑到那一行才炸，而"那一行"多半在错误处理支上 —— 平时永远跑不到。
    // 这条变异正好复现那个真 bug：兜底日志引用它没拿到的 req。
    name: "顶层函数不得引用没拿到的请求变量",
    file: SERVER,
    check: "verifyNoRequestScopedLeaks",
    from: '    const where = requestLabel ? ` ${requestLabel}` : "";',
    to: "    const where = req.method;",
    expect: "引用了它没拿到的 req"
  },
  {
    // 判据自己失配时会扫到 0 个函数、然后一片绿。
    name: "请求作用域判据不得空转",
    file: "scripts/contract-check.mjs",
    check: "verifyNoRequestScopedLeaks",
    from: "const header = lines[index].match(/^(?:export )?(?:async )?function ([A-Za-z0-9_]+)\\(([^)]*)\\)\\s*\\{/);",
    to: "const header = lines[index].match(/^NOPE ([A-Za-z0-9_]+)\\(([^)]*)\\)/);",
    expect: "这道判据在空转"
  },
  {
    // 锁的 owner.json 是【给别的进程读的】：撕裂读会被当成"还没写"，据此给短宽限期，
    // 把一个活着的持有者的锁提前破掉。
    name: "锁持有者文件必须原子写（状态库）",
    file: STORE,
    check: "verifySharedJsonWritesAreAtomic",
    from: '        renameSync(ownerTemporary, join(lockDir, "owner.json"));',
    to: "        void ownerTemporary;",
    expect: "找不到那次改名"
  },
  {
    name: "锁持有者文件必须原子写（MCP）",
    file: MCP,
    check: "verifySharedJsonWritesAreAtomic",
    from: '        renameSync(ownerTemporary, join(lockPath, "owner.json"));',
    to: "        void ownerTemporary;",
    expect: "找不到那次改名"
  },
  {
    // 兜底错误处理里那行日志引用了不在作用域的 req/url —— 每一个走到兜底的请求都会让服务端进程
    // 直接退出。症状只是偶发 ECONNREFUSED，追了三轮。请求信息必须显式传参。
    name: "兜底错误处理不得引用作用域外的变量",
    file: SERVER,
    gate: "writer",
    from: "    const requestLabel = `${req.method} ${req.url}`;",
    to: "    const requestLabel = `${req.method} ${url.pathname}`;",
    // 它红成的样子是"整道门被未捕获异常打断"：服务端在健康检查阶段就崩了，门连起都起不来。
    // 这比"服务端死过"更早、更响 —— 期望串按实际那句写，别按想象中那句。
    expect: "未捕获异常"
  },
  {
    // 运行时配置原先是直接 writeFileSync：另一个进程会读到只写了一半的 JSON，随机 500。
    // 这条曾登记为跑并发门（"它验的是真实后果"）。完整变异门跑下来它没红 ——
    // 那个后果是【概率性】的：两个进程要恰好在写到一半时互读。单跑碰巧红过一次，不等于有判别力。
    // 判别力证明必须是确定性的，所以改指静态判据；真实后果那一面由并发门日常跑着，不靠它证明。
    name: "运行时配置必须原子写",
    file: SERVER,
    check: "verifySharedJsonWritesAreAtomic",
    from: "    const temporary = `${configPath}.${process.pid}.tmp`;\n    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\\n`);\n    renameSync(temporary, configPath);",
    to: "    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\\n`);",
    expect: "直接写了一份跨进程共享的 JSON"
  },
  {
    // 五种阻塞态必须被算进 blocked 计数：不算的话概览上那个"阻塞 N 项"永远是 0，
    // 人从总览看过去一切正常，而下面五个工作项谁也动不了。
    name: "阻塞态必须被算进阻塞计数",
    file: CORE,
    check: "verifyWorkStatusEnumConvergence",
    from: "  blocked: active.filter((item) => BLOCKED_OR_FAILED_WORKITEM_STATUSES.includes(item.status)).length",
    to: "  blocked: 0",
    expect: "counters.blocked 0 !="
  },
  {
    // 缺省不得等于有利结果：认不出的状态若按默认值处理，`status` 打错一个字母就是一次真实的激活。
    // 守卫失效时会落到后一道"处置必须写理由"的门上 —— 断言点名了码，所以照样报红。
    name: "认不出的处置状态必须拒绝",
    file: SERVER,
    skip: "判别力由控制面 e2e 覆盖（已用 mutate-probe 实证：改成按默认值处理后码不再是它自己的）",
    from: '    const nextStatus = ["active", "superseded", "retired", "rejected"].includes(body.status) ? body.status : null;',
    to: '    const nextStatus = body.status || "active";',
    expect: "没有回 shared_definition_status_invalid"
  },
  {
    // "为什么还没验"那份登记会过期：某项后来补上变异了，说明还留着就是在替一个不成立的结论背书。
    name: "待验登记过期要报红",
    file: "scripts/contract-check.mjs",
    check: "verifyContractChecksAreThemselvesTested",
    // 登记册现在是空的（每一项都配上变异了）。仍要证明"往里塞一条过期的登记会被抓住"：
    // 塞一个【已经有变异】的检查名进去，判据必须指出它其实不需要豁免。
    from: "  const UNTESTED_WITH_REASON = {};",
    to: '  const UNTESTED_WITH_REASON = {verifyTransitionEngine: "这一条其实已经有变异了"};',
    expect: "已经有变异指向了"
  },
  {
    // 状态机迁移必须按【建模过的执行者】判权：不判的话，AI 角色能自行把工作项验收为 verified ——
    // 那是整套"人工定稿"在状态机这一层的落点。
    name: "状态机迁移必须按建模的执行者判权",
    file: "apps/control-plane-ui/lib/transition-engine.mjs",
    check: "verifyTransitionEngine",
    from: "  const modeled = candidates.find((transition) => transition.actor === actor);",
    to: "  const modeled = candidates[0];",
    expect: "expected rejection for AI 角色自行把工作项验收为 verified"
  },
  {
    // 活跃派发引用的契约不得被裁掉：裁了之后 acceptAgentCheckpoint 按 sessionId+runId 找不到契约，
    // 永远报 agent_dispatch_contract_mismatch，派发再也终结不了、关闭门永久不可满足。
    name: "活跃派发的契约不得被裁掉",
    file: CORE,
    check: "verifyActiveDispatchesKeepTheirContracts",
    from: "  const activeSessionIds = new Set((dispatches || []).filter((item) => !terminal.has(item.status)).map((item) => item.sessionId).filter(Bo",
    to: "  const activeSessionIds = new Set((dispatches || []).filter(() => false).map((item) => item.sessionId).filter(Bo",
    expect: "活跃派发缺契约"
  },
  {
    // 编排里的 git 事实必须【一轮一次】备忘：去掉备忘之后 200 单元一轮就是 401 次 git 子进程，
    // 每次约 40ms，而编排同步占着主线程 —— 规模一上来控制面整段不响应。
    name: "编排不得按单元起 git 子进程",
    file: CORE,
    check: "verifyOrchestrationDoesNotShellOutPerCell",
    from: "  return memoizedGitFact(`head\\u0000${root}`, () => git(root, [\"rev-parse\", \"--short=12\", \"HEAD\"], \"000000000000\"));",
    to: '  return git(root, ["rev-parse", "--short=12", "HEAD"], "000000000000");',
    expect: "个单元的一轮编排调了"
  },
  {
    // 摘要要真是摘要：单元一多，全量带上就把 agent 的上下文占满了。
    name: "MCP 摘要必须裁工作单元",
    file: MCP,
    check: "verifyMcpSummaryIsActuallyASummary",
    from: "    return {...taskGroup, workItems: items.slice(0, MCP_SUMMARY_WORK_ITEM_CAP),",
    to: "    return {...taskGroup, workItems: items,",
    expect: "把全部工作单元都带上了"
  },
  {
    // 内容包降级（缺角色技能文件）必须在控制台上看得见，否则人会把这次产出当正常产出来验收。
    name: "内容包降级要在控制台留痕",
    file: GATEWAY,
    check: "verifyDegradedContentBundleIsVisible",
    from: '        degradedGroup.blockers.push({id: `blk_skill_${dispatch.dispatchId}`, severity: "S2", summary});',
    to: "        void summary;",
    expect: "内容包降级在控制台上一个字都没有"
  },
  {
    // 内容包里必须点名本次的工作项：不点名的话 agent 只能从一份只有标题的清单里自己对应，
    // 对错了就是改错东西 —— 而它改完照样交检查点。
    name: "内容包必须点名本次工作项",
    file: GATEWAY,
    check: "verifyContentBundleNamesTheDispatchedItem",
    from: "    contract.workId ? `\\n## 本次派发\\n工作项：${contract.workId}${",
    to: "    false ? `\\n## 本次派发\\n工作项：${contract.workId}${",
    expect: "整包里找不到本次的工作项"
  },
  {
    // 记录声称遵守某份规范，而那份规范不存在 —— 这类记录第一次真正出现时，没有任何东西会核对它。
    name: "声称的 schemaVersion 必须有规范文件",
    file: CORE,
    check: "verifyEverySchemaVersionHasASpec",
    from: 'schemaVersion: "access-control-grant/v1"',
    to: 'schemaVersion: "access-control-grant-renamed/v1"',
    expect: "不存在，也没有登记它为什么不需要"
  },
  {
    // 信封说成功、内层却带 error：调用方（多半是 agent）按信封判断，就会把失败当成功继续往下走。
    name: "MCP 信封不得把带 error 的结果说成成功",
    file: MCP,
    check: "verifyMcpEnvelopeNeverCallsAnErrorSuccess",
    from: '    ok: result.ok !== false && !(result && typeof result === "object" && result.error),',
    to: "    ok: result.ok !== false,",
    expect: "在信封上说成功、内层却带 error"
  },
  {
    // "连续失败几次"正是"要不要现在管它"的判据；只记 1 次等于把这个判断废掉。
    name: "编排连续失败要累计次数",
    file: CORE,
    check: "verifyOrchestratorReportsItsOwnOutcome",
    from: "    consecutiveErrors: failed ? Number(previous.consecutiveErrors || 0) + 1 : 0,",
    to: "    consecutiveErrors: failed ? 1 : 0,",
    expect: "连续两拍失败却只记了"
  },
  {
    // 连续失败停派之后，台账里必须留下原因 —— 否则事后查不到它为什么停了。
    name: "连续失败停派要在台账留痕",
    file: CORE,
    check: "verifyRepeatedExecutionFailureStops",
    from: '        recordAdmissionDecision(state, {taskGroup, workItem, outcome: "blocked", reasonCode: "execution_failed_repeatedly",',
    to: '        false && recordAdmissionDecision(state, {taskGroup, workItem, outcome: "blocked", reasonCode: "execution_failed_repeatedly",',
    expect: "事后查不到它为什么停了"
  },
  {
    // 心跳并不重做自检：靠心跳把节点改回在线，界面上会出现"在线 + 自检未通过 + 只读"这种自相矛盾的一行。
    name: "心跳不得掩盖自检失败",
    file: GATEWAY,
    check: "verifyHeartbeatDoesNotHideFailedSelfCheck",
    from: "  if (missing.length) node.selfCheckMissing = missing;",
    to: "  if (false) node.selfCheckMissing = missing;",
    expect: "一次心跳就把自检失败的节点改回了在线"
  },
  {
    // 提示到上限被丢弃时要记下丢了多少；而问题清掉之后那句"还有 N 条"必须消失。
    name: "被丢弃的阻塞提示要记数",
    file: CORE,
    check: "verifyTaskGroupBlockersStayBounded",
    from: "      taskGroup.blockersDroppedCount = Number(taskGroup.blockersDroppedCount || 0) + dropped;",
    to: "      void dropped;",
    expect: "却没有记下丢了多少"
  },
  {
    name: "健康之后不得还挂着未保留提示",
    file: CORE,
    check: "verifyTaskGroupBlockersStayBounded",
    from: '  if (taskGroup.health === "ok") delete taskGroup.blockersDroppedCount;',
    to: "  void taskGroup;",
    expect: "常亮的提示等于没有提示"
  },
  {
    // 人下了取消，在跑的派发必须真的停住 —— 否则 agent 会跑完、推 git、交检查点，
    // 而人以为自己已经叫停了。
    name: "取消指令必须停住在跑的派发",
    file: CORE,
    check: "verifyCancelDirectiveStopsRunningWork",
    from: '          dispatch.status = "cancelled";',
    to: "          void dispatch;",
    expect: "在跑的派发仍是 running"
  },
  {
    // 暂停必须可逆：只会停不会起的话，界面上只是一个 blocked，没人看得出它再也不会自己起来。
    name: "暂停指令必须可逆",
    file: CORE,
    check: "verifyPauseDirectiveIsReversible",
    from: '          running.blockedReason = "task_group_pause";',
    to: "          void running;",
    expect: "暂停一次就永久卡住了"
  },
  {
    // 有副作用的命令要留下 CommandEffect 并对账到 verified；没对账的必须挡住关闭门。
    name: "命令效果必须被记录并对账",
    file: CORE,
    check: "verifyCommandBusLifecycle",
    from: "  state.commandEffects.unshift(effect);",
    to: "  void effect;",
    expect: "did not block all_command_effects_terminal"
  },
  {
    // 确认卡过期后，挂卡时标记的三处（派发/会话/工作项）都要跟着改 —— 否则它们指向一张
    // 不存在也不会再挂出来的卡，而未了结的会话还会一直算活跃、把关闭门永久挡住。
    name: "确认卡过期后派发的停放要清掉",
    file: CORE,
    check: "verifyExpiredConfirmationLeavesNoStaleParking",
    from: '      if (dispatch && dispatch.status === "blocked" && dispatch.blockedReason === "awaiting_human_confirmation") {',
    to: "      if (false) {",
    expect: "仍有 1 处记录停在 awaiting_human_confirmation"
  },
  {
    name: "确认卡过期后工作项不得再指向那张卡",
    file: CORE,
    check: "verifyExpiredConfirmationRetargetsTheWorkItem",
    from: "    const expiredWorkItem = request.workItemId ? (taskGroup?.workItems || []).find((item) => item.id === request.workItemId) : null;",
    to: "    const expiredWorkItem = null;",
    expect: "人打开这个工作项，被告知等一个永远不来的确认"
  },
  {
    // 权限申请【批准】之后必须把会话放出来：停在 permission_required 的会话一直算活跃，
    // 会把关闭门挡住，而人看到的是一个已经处置完的申请，找不到还卡在哪里。
    name: "权限批准必须释放会话",
    file: MCP,
    check: "verifyPermissionOutcomeReleasesTheSession",
    from: '    session.status = "active";\n    session.permissionRequestRef = `PermissionRequest:${request.requestId}`;\n    session.updatedAt = at;\n    return;',
    to: '    session.permissionRequestRef = `PermissionRequest:${request.requestId}`;\n    session.updatedAt = at;\n    return;',
    expect: "申请已 approved，会话不得再停在 permission_required"
  },
  {
    // 拒绝那一支是对称的：驳回同样不能把会话留在非终态。
    name: "权限拒绝同样必须释放会话",
    file: MCP,
    check: "verifyPermissionOutcomeReleasesTheSession",
    from: '  if ((!session || session.status !== "permission_required") && !timedOutDispatch) return;',
    to: "  if (true) return;",
    expect: "申请已 rejected，会话不得再停在 permission_required"
  },
  {
    // 组织被停用之后，编排必须停住派发。守卫失效时【真的照常派发】—— agent 继续跑、模型额度继续烧，
    // 而控制台上写着"已停用"。注意判据不在配额那道（organizationQuotaCheck）上：
    // 把那一处删掉这条照样绿，真正生效的是编排循环里按 suspendedOrgIds 跳过的那一段。
    name: "组织停用必须停住派发",
    file: CORE,
    check: "verifySuspendedOrganizationHaltsExecution",
    from: "    if (projectOrgId && suspendedOrgIds.has(projectOrgId.get(taskGroup.projectId))) {",
    to: "    if (false) {",
    expect: "这一轮仍派发了"
  },
  {
    // 已暂停/已停用的任务组，节点不得把排队中的派发领走。
    name: "已叫停的任务组不得被认领",
    file: GATEWAY,
    check: "verifyHaltedTaskGroupsAreNotClaimable",
    from: '    const paused = ["active_paused_by_freeze", "active_paused_by_control"].includes(taskGroup.goalExecutionStatus);',
    to: "    const paused = false;",
    expect: "节点仍把排队中的派发领走了"
  },
  {
    // 这道判据自己也要能红：提取一失配它会数出 0 项、然后一片绿。
    // （它上线那一刻自己就在"没有变异指向"的名单里 —— 这条变异同时也是它给自己摘牌。）
    name: "判据自查不得空转",
    file: "scripts/contract-check.mjs",
    check: "verifyContractChecksAreThemselvesTested",
    from: 'const registered = new Set([...self.matchAll(/run(?:Async)?\\((verify[A-Za-z0-9]+)\\)/gu)].map((m) => m[1]));',
    to: "const registered = new Set();",
    expect: "这道判据在空转"
  },
  {
    // 缺省不得等于有利结果：不给结论 = 批准，而法定人数与禁止自批都建立在这道闸门上。
    name: "审批必须显式给出结论",
    file: MCP,
    check: "verifyApprovalDecisionRequired",
    from: '    return {ok: false, error: "approval_decision_required",',
    to: "    return {ok: true, approvalRequest: request,",
    expect: "缺省被当成了批准"
  },
  {
    // 同族：缺信息被当成通过，而质量门正是人看到「全通过」时的唯一依据。
    name: "测试结果必须带状态",
    file: MCP,
    check: "verifyTestResultStatusRequired",
    from: 'error: "test_result_status_required"',
    to: 'error: "test_result_status_missing"',
    expect: "缺信息被当成了通过"
  },
  {
    // 这项检查守的是【MCP 那一层】的白名单，不是 core 那道（名字容易让人以为是后者）。
    name: "通向定稿的 MCP 工具必须用白名单判主体",
    file: MCP,
    check: "verifyOnlyHumanSessionsCanFinalize",
    // 五道机器主体守卫现在写法相同（都白名单化了），锚点必须带上各自的拒绝码才唯一。
    from: "      if (context?.principal?.kind !== \"system_admin\") {\n        return {ok: false, error: \"human_confirmation_decision_forbidden_for_machine_principal\"};",
    to: "      if (false) {\n        return {ok: false, error: \"human_confirmation_decision_forbidden_for_machine_principal\"};",
    expect: "主体判据不是白名单"
  },
  {
    // 围栏令牌是「这次持有」与「上一次持有」的唯一区别。core 那道此前只有源码断言 ——
    // MCP e2e 里那条看似在验它，实际被 mcp_ 前缀那道顶掉了（两个码是子串关系，判据又用 includes）。
    name: "错的围栏令牌不得释放租约（core）",
    file: CORE,
    check: "verifyHumanAndOrganizationContracts",
    from: 'if (String(lease.fencingToken) !== String(args.fencingToken)) return {ok: false, error: "lease_fencing_token_mismatch"};',
    to: "/* 守卫失效 */",
    expect: "拿一个错的围栏令牌就释放掉了租约"
  },
  {
    // 人工定稿闸门落在【写入层】的那一处：机器主体不得执行真人专属动作。
    // 守卫失效时会落到后面的权限门（policy_denied）—— 断言点名了码，所以照样报红。
    name: "机器主体不得执行真人专属动作",
    file: SERVER,
    skip: "判别力由控制面 e2e 覆盖（已用 mutate-probe 实证：改成一律放行后落到 policy_denied，码不再是它自己的）",
    from: "  if (HUMAN_ONLY_ACTIONS.includes(action)) return HUMAN_ACCOUNT_TYPES_FOR_ACTIONS.includes(account.accountType);",
    to: "  if (HUMAN_ONLY_ACTIONS.includes(action)) return true;",
    expect: "服务账号执行了真人专属动作"
  },
  {
    // 既有断言只判 403，换一道门拒它照样绿；收紧成点名码之后才有这条判别力。
    name: "非系统账号不得替别人挂项目负责人",
    file: SERVER,
    skip: "判别力由控制面 e2e 覆盖（已用 mutate-probe 实证：守卫删掉后建项目直接 201）",
    from: "    if (requestedOwnerAccountId !== authenticatedAccountId && !isSystemAccount(authenticated.account)) {",
    to: "    if (false) {",
    expect: "not to assign another owner"
  },
  {
    // 两侧各抄一份上限字面量：值一样只是巧合，改一处另一处不会跟，
    // 症状是"同一份数据经控制台收得下、经 agent 被拒"，没人会立刻想到是两个常量分叉了。
    name: "字符串清单上限不得各抄一份",
    file: MCP,
    check: "verifyStringListCapsShareOneSource",
    from: "// 上限取自 core 那份唯一真相源 —— 与 REST 侧同一个常量，不在这里另抄一份。",
    to: "const STRING_LIST_MAX_ITEMS_LOCAL = 200;",
    expect: "自己又定义了一份字符串清单上限"
  },
  {
    // 项目负责人授权有两份实现：MCP 那侧会把既有授权的权限集刷新到当前，REST 那侧原样返回 ——
    // 权限集扩过一项之后，同一个人在两个项目里能做的事不一样，而没有任何地方会告诉他为什么。
    name: "既有的负责人授权要对齐当前权限集（REST）",
    file: SERVER,
    check: "verifyBothOwnerGrantWritersRefreshPermissions",
    from: "    existing.permissions = [...projectOwnerGrantPermissions];\n    existing.updatedAt = now();\n    return existing;",
    to: "    return existing;",
    expect: "没有把权限集对齐到当前"
  },
  {
    name: "既有的负责人授权要对齐当前权限集（MCP）",
    file: MCP,
    check: "verifyBothOwnerGrantWritersRefreshPermissions",
    from: "    existing.permissions = [...projectOwnerGrantPermissions];",
    to: "    void projectOwnerGrantPermissions;",
    expect: "没有把权限集对齐到当前"
  },
  {
    // 建工作项有两份实现，少接一份等于没接。这一族上一轮刚在"建组"那对上漏过一次。
    name: "终结的任务组里不得再建工作项（REST）",
    file: SERVER,
    check: "verifyBothWorkItemWritersHonourSettledTaskGroups",
    from: "  const settledRejection = taskGroupSettledRejection(state, taskGroup.id);\n  if (settledRejection) return {...settledRejection, status: 409};",
    to: "  void taskGroupSettledRejection;",
    expect: "没有调 taskGroupSettledRejection"
  },
  {
    name: "终结的任务组里不得再建工作项（MCP）",
    file: MCP,
    check: "verifyBothWorkItemWritersHonourSettledTaskGroups",
    from: '  const settledRejection = taskGroupSettledRejection(state, taskGroup.id);\n  if (settledRejection) return settledRejection;\n  const workItemId = args.workItemId || createId("work");',
    to: '  const workItemId = args.workItemId || createId("work");',
    expect: "没有调 taskGroupSettledRejection"
  },
  {
    // 归档路由要求先把所有任务组关掉（不级联，让人自己收尾）；归档后还能建新组，那次收尾就白做了。
    name: "归档的项目不得再建任务组（REST）",
    file: SERVER,
    skip: "判别力由控制面 e2e 覆盖（已用 mutate-probe 实证：MCP 那份同形变异当场变红）",
    from: '  if (project.status === "archived") {\n    return {ok: false, status: 409, error: "project_archived",',
    to: '  if (false) {\n    return {ok: false, status: 409, error: "project_archived",',
    expect: "归档前那次逐个关闭白做了"
  },
  {
    // 建组有两份实现，只补一份是本仓最常见的洞。
    name: "归档的项目不得再建任务组（MCP）",
    file: MCP,
    skip: "判别力由 MCP e2e 覆盖（已用 mutate-probe 实证：去掉判据后归档项目里真的建出了任务组）",
    from: '  if (project.status === "archived") return {ok: false, error: "project_archived"};',
    to: "  void project;",
    expect: "两份建组实现只补了 REST 那一份"
  },
  {
    // 任务组终结之后仍能往里面加新东西：六个写入口原先全部照收，其中人工确认单会造出
    // 一张永远没人看得见也点不动的待办。
    name: "任务组终结后不得再加新东西",
    file: CORE,
    check: "verifyHumanAndOrganizationContracts",
    from: "export function createHumanConfirmationRequest(state, input = {}) {\n  const settledRejection = taskGroupSettledRejection(state, input.taskGroupId);\n  if (settledRejection) return settledRejection;",
    to: "export function createHumanConfirmationRequest(state, input = {}) {",
    expect: "仍然往它里面写了新东西"
  },
  {
    // 这道锁不能把还开着的任务组也锁住 —— 正面对照六条会同时报红。
    name: "已终结的判据不得把正常任务组一起锁住",
    file: CORE,
    check: "verifyHumanAndOrganizationContracts",
    from: 'export const TASK_GROUP_SETTLED_STATUSES = ["closed", "aborted"];',
    to: 'export const TASK_GROUP_SETTLED_STATUSES = ["closed", "aborted", "active"];',
    expect: "这道锁把正常路径一起堵死"
  },
  {
    // 真缺陷：active 不在规则来源的终态集里，于是【人已经采纳的来源，AI 一次调用就能改成 rejected】。
    name: "人采纳过的规则来源不得被机器改掉",
    file: CORE,
    check: "verifyHumanAndOrganizationContracts",
    from: "  if (RULE_SOURCE_HUMAN_ONLY_STATUSES.includes(resolution.status) && !humanActor) {\n    return {ok: false, error: \"rule_source_adoption_requires_human\", currentStatus: resolution.status};\n  }",
    to: "/* 守卫失效 */",
    expect: "人定过的事可以被后来的调用翻掉"
  },
  {
    // 这道锁不能把人自己也锁在里面：真人撤回必须走得通。
    name: "人自己撤回采纳的出口不得被锁死",
    file: CORE,
    check: "verifyHumanAndOrganizationContracts",
    from: "  if (RULE_SOURCE_HUMAN_ONLY_STATUSES.includes(resolution.status) && !humanActor) {",
    to: "  if (RULE_SOURCE_HUMAN_ONLY_STATUSES.includes(resolution.status)) {",
    expect: "锁把人一起锁在里面了"
  },
  {
    name: "已定稿的确认单不得被二次定稿",
    file: CORE,
    check: "verifyHumanAndOrganizationContracts",
    from: '  if (request.status !== "pending") {',
    to: "  if (false) {",
    expect: "人定过的事可以被后来的调用翻掉"
  },
  {
    name: "已终态的执行方案不得再被推进",
    file: CORE,
    check: "verifyHumanAndOrganizationContracts",
    from: "  if (TOPOLOGY_TERMINAL_STATUSES.includes(topology.status)) return {topology, alreadyTerminal: true};",
    to: "/* 守卫失效 */",
    expect: "人定过的事可以被后来的调用翻掉"
  },
  {
    // 写路由的判权点在存在检查之后，两种"看不见"会落到不同的码上 —— 入口处那道可见性判据不能少。
    name: "项目配置写入不得泄露别处有没有这个项目",
    file: SERVER,
    skip: "判别力由控制面 e2e 覆盖（已用 mutate-probe 实证：去掉入口判据后落回 policy_denied，两者可分辨）",
    from: '    if (projectHiddenFromActor(req, state, projectConfigMatch[1])) return json(res, 403, {error: "permission_denied"});',
    to: "    void projectHiddenFromActor;",
    expect: "写路由同样是一台跨租户存在性探针"
  },
  {
    name: "成员写入不得泄露别处有没有这个项目",
    file: SERVER,
    skip: "判别力由控制面 e2e 覆盖（已用 mutate-probe 实证：去掉入口判据后一路走到 account_not_found）",
    from: '    if (projectHiddenFromActor(req, state, memberMatch[1])) return json(res, 403, {error: "permission_denied"});',
    to: "    void projectHiddenFromActor;",
    expect: "写路由同样是一台跨租户存在性探针"
  },
  {
    // REST 侧同一条不变式：受限账号问一个项目 id，两种"找不到"必须给同一个答案。
    name: "受限账号不得分辨出别处有没有某个项目",
    file: SERVER,
    skip: "判别力由控制面 e2e 覆盖（已用 mutate-probe 实证：退回旧行为时那两条断言变红）",
    from: '  return {denial: {status: 403, payload: {error: "permission_denied"}}};',
    to: '  return {denial: {status: 404, payload: {error: "project_not_found"}}};',
    expect: "跨租户存在性探针"
  },
  {
    // 不能靠"一律回同一个码"蒙混：系统账号必须仍拿得到准确的 404。
    name: "系统账号仍要分得清打错 id 和没权限",
    file: SERVER,
    skip: "判别力由控制面 e2e 覆盖（已用 mutate-probe 实证：条件改成恒假时正面对照变红）",
    from: '  if (isSystemAccount(reader.account)) return {denial: {status: 404, payload: {error: "project_not_found"}}};',
    to: '  if (false) return {denial: {status: 404, payload: {error: "project_not_found"}}};',
    expect: "越权与打错 id 被一锅端"
  },
  {
    // 受限主体问一个 id 时，"查无此物"与"存在但不属于你"必须给同一个答案，
    // 否则报文就是一台跨租户存在性探针：拿一批 id 试一遍就知道别的租户有没有它们。
    name: "受限主体不得分辨出别的租户有没有某个东西",
    file: MCP,
    skip: "判别力由 MCP e2e 覆盖（已用 mutate-probe 实证：条件改成恒假时两个答案又分得开了）",
    from: '    const boundedPrincipal = principal.kind === "agent_node";',
    to: "    const boundedPrincipal = false;",
    expect: "跨租户存在性探针"
  },
  {
    // "已查明不可达的第二道门"这份登记会过期：守卫改名或变得可达时必须报红，
    // 否则它会一直替一个不存在的结论背书。
    name: "第二道门登记过期要报红",
    file: "scripts/lib/known-second-doors.mjs",
    check: "verifyRefusalCodeCoverageRatchet",
    from: "  agent_checkpoint_must_use_gateway:",
    to: "  agent_checkpoint_must_use_gateway_renamed:",
    expect: "在产品代码里已经不存在了"
  },
  {
    // 不给任务组时按工作项反查归属那一维 —— 这一族最后一个没被点过名的码。
    name: "工作项的项目维度要单独报",
    file: MCP,
    skip: "判别力由 MCP e2e 覆盖（十条表驱动断言里对应的一条）",
    from: 'return {allowed: false, error: "work_item_project_scope_mismatch", required: `${projectId}:${workItemId}`};',
    to: 'return {allowed: true};',
    expect: "没有被拒成 work_item_project_scope_mismatch"
  },
  {
    // 跨参数作用域这一族九个码，判据要能分清是哪一维对不上 —— 分不清的话，人只能逐个试。
    name: "产出目标的工作项维度要单独报",
    file: MCP,
    skip: "判别力由 MCP e2e 覆盖（已用 mutate-probe 实证：那九条表驱动断言里对应的一条变红）",
    from: 'if (workItemId && target.workItemId !== workItemId) return {allowed: false, error: "repository_target_work_item_scope_mismatch"',
    to: 'if (false) return {allowed: false, error: "repository_target_work_item_scope_mismatch"',
    expect: "没有被拒成 repository_target_work_item_scope_mismatch"
  },
  {
    name: "资源的任务组维度要单独报",
    file: MCP,
    skip: "判别力由 MCP e2e 覆盖（已用 mutate-probe 实证：守卫删掉后落到主体作用域那道门，码不再是它自己的）",
    from: "if (taskGroupId && taskGroupId !== explicitResource.resourceId) {\n      return {allowed: false, error: \"resource_task_group_scope_mismatch\", required: `${taskGroupId}:${explicitResource.resourceId}`};\n    }",
    to: "/* 守卫失效 */",
    expect: "没有被拒成 resource_task_group_scope_mismatch"
  },
  {
    // 谎报归属：产出目标登记在别的工作项名下。守卫失效时是"已受理"。
    name: "产出目标必须属于这个工作项",
    file: CORE,
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: 'const targetScopeMismatch = target.projectId !== taskGroup.projectId ? "projectId"\n    : target.taskGroupId !== taskGroup.id ? "taskGroupId"\n    : target.workItemId !== workItem.id ? "workItemId" : null;',
    to: "const targetScopeMismatch = null;",
    expect: "这次提交被算进了另一个工作项的产出"
  },
  {
    // 夹带一个不属于本会话的产出目标，先响的是角色漂移门（按 actionScopeRefs 判权）。
    // 它塌了会落到后面那道"目标引用必须恰好一个"，所以这条变异也顺带证明了第二道门还在。
    name: "夹带别的产出目标要被角色漂移门拦下",
    file: CORE,
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: '  if (!drift.allowed) {\n    return {accepted: false, status: 409, error: "role_drift_guard_not_clear"};\n  }',
    to: '  if (false) { throw new Error("unreachable"); }',
    expect: "一个会话可以顺手把别的目标也写进自己的证据里"
  },
  {
    // 这份证据到底属于哪件事：挂上别的工作项的会话，成果就算到了它没做过的那件事上。
    name: "检查点的会话必须属于这个工作项",
    file: CORE,
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: "if (!session || session.workItemId !== workItem.id) {",
    to: "if (!session) {",
    expect: "证据被挂到它没做过的那件事上"
  },
  {
    name: "语言策略摘要不带就不许过",
    file: CORE,
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: "if (!checkpointInput.languagePolicyDigest) {\n      return {accepted: false, status: 409, error: \"checkpoint_language_policy_digest_required\"};\n    }",
    to: "/* 守卫失效 */",
    expect: "契约里对产出语言的约定形同虚设"
  },
  {
    // 这一条失效时直接"已受理"。
    name: "语言策略摘要谎报不许过",
    file: CORE,
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: "if (checkpointInput.languagePolicyDigest !== expectedLanguagePolicyDigest) {\n      return {accepted: false, status: 409, error: \"checkpoint_language_policy_digest_mismatch\"};\n    }",
    to: "/* 守卫失效 */",
    expect: "换一份语言约定就能让不合约定的产出过关"
  },
  {
    // 同样失效即"已受理"：已经推送定案的产出目标，可以被后来的检查点覆盖。
    name: "已推送定案的目标不得再交检查点",
    file: CORE,
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: 'if (target.status === "pushed") return {valid: false, status: 409, error: "repository_output_target_already_pushed"};',
    to: "/* 守卫失效 */",
    expect: "既成事实可以被后来的检查点覆盖"
  },
  {
    // 谎报范围：指向的清单在仓库里找得到，只是不属于这次提交 —— 一份旧清单给这一轮背书。
    name: "旧清单不得给这一轮背书",
    file: CORE,
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: "if (!changedPaths.includes(manifestPath)) {\n      // 白名单就是\"这次提交实际改了哪些路径\"。带上它，agent 一眼看出自己漏了 stage；\n      // 不带的话它只知道\"不在里面\"，不知道里面有什么（上一行的 deniedPaths 早就是这么做的）。\n      return {valid: false, status: 409, error: \"artifact_manifest_not_changed_in_commit\",\n        manifestPath, changedPaths: changedPaths.slice(0, 20)};\n    }",
    to: 'if (false) { throw new Error("unreachable"); }',
    expect: "一份旧清单就能给这一轮背书"
  },
  {
    // 这一条被改坏时直接"已受理"：交付清单可以虚报，而人正是照着它验收。
    name: "上一轮的产出不得算进本轮清单",
    file: CORE,
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: "if (!changedPaths.includes(outputRef)) {\n        // 同上：把这次提交实际改了哪些路径一并给出去。\n        return {valid: false, status: 409, error: \"artifact_output_ref_not_changed_in_commit\",\n          outputRef, changedPaths: changedPaths.slice(0, 20)};\n      }",
    to: 'if (false) { throw new Error("unreachable"); }',
    expect: "交付清单可以虚报"
  },
  {
    name: "清单不是 JSON 时不得继续",
    file: CORE,
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: '      return {valid: false, status: 409, error: "artifact_manifest_not_json"};',
    to: "      manifest = {};",
    expect: "后面所有按字段比对的绑定校验都会被跳过"
  },
  {
    // 后台刷新失败被吞 = 屏幕停在旧数据上却看起来还活着，人照着一屏冻住的数据做决定。
    name: "控制台后台刷新失败不得静默",
    file: APP,
    gate: "specs",
    from: "loadPage().catch(reportBackgroundRefreshFailure);\n}, 5000);",
    to: "loadPage().catch(() => {});\n}, 5000);",
    expect: "屏幕会停在旧数据上却看起来还活着"
  },
  {
    name: "后台刷新失败要说出来、并说清屏幕停在多久以前",
    file: APP,
    gate: "console",
    from: "  toast.error(`后台刷新失败，界面停在${lastLoadedAgo()}的数据：${message}`);",
    to: "  toast.error(`后台刷新失败`);",
    expect: "只说刷新失败，人不知道眼前这屏还能不能照着做决定"
  },
  {
    // 本机清了会话、界面说"已登出"，而服务端那边这次会话仍然有效到过期为止。
    name: "服务端没确认登出时必须说出来",
    file: APP,
    gate: "console",
    from: "        toast.error(`本机已登出，但服务端未确认作废这次会话：${error?.message || error}。若这是共用设备，请让管理员吊销该会话。`);",
    to: "        void error;",
    expect: "人以为凭据已经失效"
  },
  {
    // 上报失败被吞 = 控制面永远不知道，派发一直挂在 running，人看到的是"还在跑"。
    name: "向控制面上报失败的调用不得吞错",
    file: "apps/agent-runtime/runtime.mjs",
    gate: "specs",
    from: ".catch(\n        (ackError) => process.stderr.write(`control command failure ack failed:",
    to: ".catch(() => {}); // (ackError) => process.stderr.write(`control command failure ack failed:",
    expect: "把自己的错误吞掉了"
  },
  {
    // 这道门的通过条件是"0 处吞错"，族名一改就会永远数出 0 而一片绿。
    name: "上报族名必须自证仍在",
    file: "apps/agent-runtime/runtime.mjs",
    gate: "specs",
    from: 'ackControlCommand(config, command, "failed", {reason:',
    to: 'ackControlCommand(config, command, "failed_renamed", {reason:',
    expect: "这一族从此不被检验"
  },
  {
    // 孪生分支：陈旧会话目录清不掉时同样只有"若干天后盘满"这一个症状。
    name: "陈旧会话清不掉时必须出声",
    file: "apps/agent-runtime/runtime.mjs",
    skip: "判别力由远程 agent e2e 覆盖（已用 mutate-probe 实证：只读 sessions 目录下那道门变红）",
    from: "  if (sweepFaults) {\n    // 清不掉就意味着盘会一直涨",
    to: "  if (false) {\n    // 清不掉就意味着盘会一直涨",
    expect: "运行时一个字都没说"
  },
  {
    // 淘汰全都失败（目录只读、文件被占用）时原先静默返回，下一拍原样再来：盘一直涨，
    // 而系统明明算出来自己超了上限，一个字都没对人说过。
    name: "清不动的时候必须出声",
    file: "apps/agent-runtime/runtime.mjs",
    skip: "判别力由远程 agent e2e 覆盖（已用 mutate-probe 实证：只读 library 目录下那道门变红）",
    from: "  if (total > maxBytes) {\n    const mb = (bytes) => Math.round(bytes / (1024 * 1024));",
    to: "  if (false) {\n    const mb = (bytes) => Math.round(bytes / (1024 * 1024));",
    expect: "运行时一个字都没说"
  },
  {
    // 隔离（改名）本身会失败：目录只读、盘满、同名占用。文件仍在原地、下一拍还会再读到它，
    // 而报文照旧说"已隔离到 <path>.corrupt-<时间戳>" —— 人按那个路径去找只会扑空。
    name: "隔离失败时不许宣称已隔离",
    file: "apps/agent-runtime/runtime.mjs",
    skip: "判别力由远程 agent e2e 覆盖（已用 mutate-probe 实证：只读 outbox 目录下那道门变红）",
    from: "      process.stderr.write(quarantineFault\n        ? `checkpoint outbox item corrupt and quarantine failed: ${filename} still at ${path} (${error.message}; rename: ${quarantineFault})\\n`\n        : ",
    to: "      process.stderr.write(",
    expect: "隔离失败了，报文却没说文件还在哪"
  },
  {
    // 同上，另一个运维入口。判别力由 mcp:doctor 覆盖（它真的 spawn 这个脚本走三条失败路径）。
    name: "register-mcp-client 失败时要给人话而不是崩溃栈",
    file: "scripts/register-mcp-client.mjs",
    skip: "判别力由 mcp:doctor 覆盖（真的 spawn 这个脚本走失败路径）",
    from: "    fail(`控制面地址不是一个合法的 URL：${value}`,",
    to: "    throw new Error(`invalid url: ${value}`);\n    fail(`控制面地址不是一个合法的 URL：${value}`,",
    expect: "不是一个合法的 URL"
  },
  {
    // 认不出的指令类型降级成便条 = pause 拼错就变成一条 free_text，活照跑。
    name: "认不出的人工指令类型必须拒绝",
    file: CORE,
    skip: "判别力由控制面 e2e 覆盖（真实 HTTP 路径上打这条路由）",
    from: '    throw Object.assign(new Error("human_directive_type_unknown"),',
    to: "    if (false) throw Object.assign(new Error(\"human_directive_type_unknown\"),",
    expect: "human_directive_type_unknown"
  },
  {
    // 命令接口不许猜：退回 `=== true`，字段缺省就变成相反的决定，而理由照记。
    // 这条守卫由控制面 e2e 覆盖（真实 HTTP 路径），此处只核对锚点仍在。
    name: "方案定稿要求必须显式给出",
    file: SERVER,
    skip: "判别力由控制面 e2e 覆盖（真实 HTTP 路径上打这条路由）",
    from: '    if (typeof body.requiresPlanFinalization !== "boolean") {',
    to: "    if (false) {",
    expect: "plan_finalization_requirement_required"
  },
  {
    // 提示里的数字必须算出来。写死一个，白名单一改它就说谎（此前 46 vs 真实 44）。
    name: "init 里的工具数不得写死",
    file: "scripts/init-control-plane.mjs",
    check: "verifyInitPrintsTheToolCountClientsActuallySee",
    from: "默认放行 ${mcpServiceToolFacts().count} 个工具",
    to: "默认放行 46 个工具",
    expect: "是写死的字面量"
  },
  {
    // 合流的三件事各守一条：这条守"条目进得了主台账"。
    name: "MCP 的写入要进主审计台账",
    file: "apps/mcp-server/server.mjs",
    check: "verifyMcpWritesLandInTheMainAuditLedger",
    from: '        action: "mcp_tool_call",',
    to: '        action: "mcp_tool_call_disabled",',
    expect: "没有进主审计台账"
  },
  {
    // 这条守"归档也收到了"：只落内存台账（80 条上限）而不落归档，
    // 是控制台看得见、问责凭据里没有 —— 比两边都没有更糟。
    name: "MCP 的审计条目也要落进归档",
    file: "apps/mcp-server/server.mjs",
    check: "verifyMcpWritesLandInTheMainAuditLedger",
    from: '  flushPendingAuditAppends(state, join(runtimeDir, "audit-log.jsonl"));',
    to: "  void state;",
    expect: "没进归档"
  },
  {
    name: "审计页要说清台账只覆盖到哪",
    file: APP,
    gate: "console",
    from: "（MCP 的记为「MCP 工具调用」，执行者形如 <span class=\"mono\">mcp:主体类型:id</span>）。",
    to: "。",
    expect: "页面要说清这件事"
  },
  {
    // 篡改告警只列前 3 处不一致，而原先没说这是"前 3 处" —— 查篡改的人以为看到的就是全部。
    name: "篡改告警要说清只列了前几处",
    file: APP,
    gate: "console",
    from: "${chain.breaks.length > 3 ? `，仅列前 3 处，其余 ${chain.breaks.length - 3} 处在服务端归档文件里` : \"\"}",
    to: "",
    expect: "只列了 3 处却不说这是前 3 处"
  },
  {
    // 枚举面含 shell 入口：人敲的是哪种脚本，跟这个洞长不长没关系。
    name: "shell 运维入口也要拦认不出的参数",
    check: "verifyOperatorCliRejectsUnknownFlags",
    file: "scripts/start.sh",
    from: '  printf \'%s\\n\' "start.sh: 认不出这个参数：$1" >&2',
    to: '  printf \'%s\\n\' "start.sh: bad arg" >&2',
    expect: "不拦截认不出的参数"
  },
  {
    // 运维入口是逐个枚举的，任何一个不拦认不出的参数都要被点名（不能只有 agentctl 有）。
    name: "每个运维入口都要拦认不出的参数",
    check: "verifyOperatorCliRejectsUnknownFlags",
    file: "scripts/init-control-plane.mjs",
    from: "if (unknownFlags.length) {",
    to: "if (false) {",
    expect: "不拦截认不出的参数"
  },
  {
    // 白名单里留着代码已经不读的名字 → 那个参数被收下然后忽略，正是这套白名单要防的洞。
    name: "agentctl 登记的参数必须真的被读",
    check: "verifyAgentctlFlagNamesMatchWhatItReads",
    file: "scripts/agentctl.mjs",
    from: '"max-uses", "idempotency-key", "verified"',
    to: '"max-uses", "idempotency-key", "verifed"',
    expect: "却从不读取"
  },
  {
    // 名单再齐，"拒绝"这个动作没接上也一样白搭。
    name: "agentctl 认不出的参数必须真的被拒",
    check: "verifyAgentctlFlagNamesMatchWhatItReads",
    file: "scripts/agentctl.mjs",
    from: "  fail(`认不出这些参数：${unknownFlags.map((key) => `--${key}`).join(\" \")}`,",
    to: "  console.error(`认不出这些参数：${unknownFlags.map((key) => `--${key}`).join(\" \")}`, [",
    expect: "没人用的局部变量"
  },
  {
    // 谎报分支 = 把一份别处的提交算成本目标的成果，而关闭门认的就是这份成果。
    name: "提交必须落在产出目标钉住的分支上",
    check: "verifyHumanApprovedPathsBindTheCommit",
    file: CORE,
    from: "    if (commitRefMismatch) {",
    to: "    if (false) {",
    expect: "声称落在别的分支上"
  },
  {
    // 互斥没了 = 两个 agent 能同时往同一个产出目标上写。
    name: "租约被别的会话持有时不得受理检查点",
    check: "verifyHumanApprovedPathsBindTheCommit",
    file: CORE,
    from: "  if (leaseProblem) {",
    to: "  if (false) {",
    expect: "互斥没了"
  },
  {
    // 没有租约要去申请、被别人持有要等 —— 两种下一步完全不同，报文必须分得开。
    name: "租约被拒要说清是哪一种",
    check: "verifyHumanApprovedPathsBindTheCommit",
    file: CORE,
    from: '    return {valid: false, status: 409, error: "active_session_lease_required", leaseProblem};',
    to: '    return {valid: false, status: 409, error: "active_session_lease_required"};',
    expect: "没说清是哪一种"
  },
  {
    // 跨组织授权失效时同组织的授权照旧成功，只有那一次把外人放进项目会悄悄通过。
    name: "别的组织的账号不得被授权进本项目",
    file: "apps/control-plane-ui/server.mjs",
    skip: "判别力由控制面 e2e 覆盖（真拿另一个组织的管理员去授权本项目，要求 400）",
    // 变异要【整块放行】而不是只删发送响应那一行：后者会让处理器不回响应就 return，
    // 客户端挂到超时 —— 门是红了，但红的原因是超时，不是被测性质（第一版就是这样）。
    from: '    if ((inviteeAccount.organizationId || DEFAULT_ORGANIZATION_ID) !== (project.organizationId || DEFAULT_ORGANIZATION_ID)) {',
    to: "    if (false) {",
    expect: "租户边界在成员授权这条路上是敞开的"
  },
  {
    // 正面对照必须钉死"真的被受理"：只断言"某个码没出现"的写法，会在因别的原因被拒时静默变绿。
    // 这里改坏一处与被测性质【无关】的守卫 —— 旧写法看不见它，新写法会红。
    name: "正面对照要钉死被受理",
    check: "verifyHumanApprovedPathsBindTheCommit",
    file: CORE,
    from: '      return {valid: false, status: 409, error: "artifact_manifest_missing_output_refs"};',
    to: '      return {valid: false, status: 409, error: "artifact_manifest_missing_output_refs"};\n    }\n    if (outputRefs.length) {\n      return {valid: false, status: 409, error: "unrelated_probe_rejection"};',
    expect: "没有被受理"
  },
  {
    // 一个错误码盖着五个字段，不点名的话调用方只能逐个试。
    name: "绑定不一致要点名是哪个字段",
    check: "verifyHumanApprovedPathsBindTheCommit",
    file: CORE,
    from: '        mismatchedField: bindingMismatch};',
    to: "      };",
    expect: "没说清是哪个字段"
  },
  {
    // 产出清单谎报它属于哪个项目 = 把一份真实提交的证据挂到别的项目名下。
    name: "产出清单的绑定字段要核对",
    check: "verifyHumanApprovedPathsBindTheCommit",
    file: CORE,
    from: '      return {valid: false, status: 409, error: "artifact_manifest_binding_mismatch",\n        mismatchedField: bindingMismatch};',
    to: "      void 0;",
    expect: "谎报它属于哪个项目"
  },
  {
    // 正面对照：如实上报必须被受理。它空转过很久（清单缺绑定字段，每个用例都在同一处被拒），
    // 而正面对照空转比反面用例缺失更难发现 —— 它一直是绿的。
    name: "如实上报的检查点必须被受理",
    check: "verifyHumanApprovedPathsBindTheCommit",
    file: CORE,
    from: '      return {valid: false, status: 409, error: "artifact_manifest_contract_digest_mismatch"};\n    }',
    to: '      return {valid: false, status: 409, error: "artifact_manifest_contract_digest_mismatch"};\n    }\n    if (true) return {valid: false, status: 409, error: "forced_reject_probe"};',
    expect: "没有被受理"
  },
  {
    // 谎报任务契约摘要 = 把一份真实的提交挂到它没做过的那件事上，而检查点是关闭门认账的证据。
    name: "检查点必须钉在它声称的那份契约上",
    check: "verifyHumanApprovedPathsBindTheCommit",
    file: CORE,
    from: '    return {accepted: false, status: 409, error: "checkpoint_task_contract_digest_mismatch"};',
    to: "    void 0;",
    expect: "没被拦下"
  },
  {
    // 拿自己有权的项目配上别人的任务组 id —— 失效时所有正常调用照旧成功，只有跨租户那次悄悄通过。
    name: "跨参数的作用域一致性要守住",
    file: "apps/mcp-server/server.mjs",
    skip: "判据由 mcp:doctor 覆盖（真拿隔壁项目的任务组配本项目 projectId，并要求一致时照常放行）",
    from: '    return {allowed: false, error: "task_group_project_scope_mismatch", required: `${projectId}:${taskGroupId}`};',
    to: "    return {allowed: true};",
    expect: "居然通过了"
  },
  {
    // 限流失效是静默的：所有正常登录照旧成功，只有"猜口令"变得没有代价。
    name: "登录要限流",
    file: "apps/control-plane-ui/server.mjs",
    skip: "判别力由控制面 e2e 覆盖（连打 12 次错口令要求 429，且限流期间正确凭据同样被挡）",
    from: "    if (loginRateLimited(req)) {",
    to: "    if (false) {",
    expect: "都没被限流"
  },
  {
    // 摘要串的前缀一提成变量，这处签发点就从判据视野里消失 —— 原先本条只认这一行里
    // 写着 "account-invite:" 的，实测这么改并同时去掉过期时间，判据全绿放行了一张永不过期的票。
    name: "换个写法签发凭据不得从过期核对里溜走",
    check: "verifyIssuedCredentialsAlwaysExpire",
    file: "apps/control-plane-ui/server.mjs",
    from: "      credentialDigest: digestOf(`account-invite:${accountId}:${accountToken}`),\n      credentialIssuedAt: at,\n      credentialExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),",
    to: "      credentialDigest: digestOf(`${INVITE_PREFIX}${accountId}:${accountToken}`),\n      credentialIssuedAt: at,\n      credentialNeverExpires: true,",
    expect: "却没写过期时间"
  },
  {
    // 签发时漏写过期时间 = 那张一次性邀请票永远有效，而且所有正常登录照旧成功（静默）。
    name: "签发邀请必须同时写过期时间",
    check: "verifyIssuedCredentialsAlwaysExpire",
    file: "apps/control-plane-ui/server.mjs",
    // 顺序是 摘要 → 签发时间 → 过期时间；第一版把前两行写反了，锚点匹配不上（门当场说
    // "找不到要改坏的代码片段"，这提示比默默跳过有用得多）。
    // 这一族有三处写法一样（邀请账号 / 建组织的管理员 / 建组织成员），必须连上下文写成唯一匹配。
    from: "      credentialDigest: digestOf(`account-invite:${accountId}:${accountToken}`),\n      credentialIssuedAt: at,\n      credentialExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),",
    to: "      credentialDigest: digestOf(`account-invite:${accountId}:${accountToken}`),\n      credentialIssuedAt: at,",
    expect: "却没写过期时间"
  },
  {
    // 过期检查失效是静默的：正常登录全部照旧成功，只有过期的那张票会悄悄继续可用。
    name: "过期的一次性邀请不得再登录",
    file: "apps/control-plane-ui/server.mjs",
    skip: "判别力由控制面 e2e 覆盖（把一份真实邀请改成已过期再登录，要求 401）",
    from: "&& (!account.credentialExpiresAt || new Date(account.credentialExpiresAt).getTime() > Date.now())",
    to: "",
    expect: "仍然能登录"
  },
  {
    // 惰性字段被人接上却没改登记 = 读代码的人继续以为它不生效（反过来也一样害人）。
    name: "信任分被人碰过时登记要过期",
    check: "verifyInertMechanismsStayRegistered",
    file: CORE,
    from: 'status: "active", trustScore: 0.9,',
    to: 'status: "active", trustScore: 0.9, trustScoreEcho: 0.9 + (0 * 1), /* trustScore */',
    expect: "有人动过它"
  },
  {
    // 节点名会被嵌进给人复制的安装命令里，而且常驻状态 —— 人写的字段超长要拒。
    name: "节点名超长要拒而不是收下",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    skip: "判别力由远程 agent e2e 覆盖（真发一个 5000 字的节点名）",
    from: '      String(input.nodeName || input.expectedNodeName || "").trim(), "agent_node_name", 200) || null,',
    to: '      String(input.nodeName || input.expectedNodeName || "").trim(), "agent_node_name", 100000) || null,',
    expect: "被收下了"
  },
  {
    // 条数截了、条目里的字符串没截：100 个工具 × 20KB 名字 = 2MB profile 常驻中央状态。
    name: "节点 profile 里的字符串也要截断",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    skip: "判别力由远程 agent e2e 覆盖（真发一次超长 profile 心跳并读回存下的长度）",
    from: 'name: String(item.name || "").slice(0, 200)',
    to: 'name: String(item.name || "")',
    expect: "字的字符串"
  },
  {
    // 数组是同一个洞的另一扇门：两条请求把状态从 63KB 撑到 6.4MB。
    name: "字符串清单要有条数与单条上限",
    file: "apps/control-plane-ui/server.mjs",
    skip: "判别力由控制面 e2e 覆盖（真发 5 万条 + 一条 30 万字，并要求正常清单照常收下）",
    from: "  if (source.length > STRING_LIST_MAX_ITEMS) {",
    to: "  if (false) {",
    expect: "被收下了"
  },
  {
    // 一次请求就能把状态从 56KB 撑到 1.8MB，而每次写入的成本正比于状态大小。
    name: "任务组目标要有长度上限",
    file: "apps/control-plane-ui/server.mjs",
    skip: "判别力由控制面 e2e 覆盖（真发一份 30 万字的目标，并核对被拒后状态没被撑大）",
    from: '    objective: assertHumanTextWithinLimit(input.objective || input.title || input.name || "Machine-executed task group", "task_group_objective", 4000),',
    to: '    objective: input.objective || input.title || input.name || "Machine-executed task group",',
    expect: "被收下了"
  },
  {
    // MCP 侧少补 = agent 一样能把状态撑大（孪生分支只补一半）。
    name: "MCP 侧的任务组目标也要有上限",
    file: "apps/mcp-server/server.mjs",
    skip: "判别力由 mcp:doctor 覆盖（真发一份 30 万字的目标）",
    from: '    objective: assertHumanTextWithinLimit(args.objective || args.title || "Machine-executed task group", "task_group_objective", 4000),',
    to: '    objective: args.objective || args.title || "Machine-executed task group",',
    expect: "MCP 侧收下了"
  },
  {
    // 明文一次性凭据落进审计归档：视图层那道凭据扫描看不见它（归档不经视图下发）。
    name: "一次性凭据不得落盘",
    file: "apps/control-plane-ui/server.mjs",
    skip: "判别力由控制面 e2e 覆盖（用本轮真发出去的令牌去搜落盘文件，已用 mutate-probe 实证）",
    from: '    audit(state, guard.actor, "org_create", `Organization:${orgId}`);',
    to: '    audit(state, guard.actor, "org_create", `Organization:${orgId}:${adminToken}`);',
    expect: "里存着明文的"
  },
  {
    // 少了几个项目的写入被静默放行 = 那些租户的数据当场没了。
    name: "项目分片不得被静默丢弃",
    check: "verifyProjectShardsAreNeverSilentlyDropped",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    from: "    if (removedProjectIds.length && !options.allowProjectShardRemoval) {",
    to: "    if (false) {",
    expect: "没有被拒"
  },
  {
    // 反向：合法的重置也被堵死，等于把唯一正当的路砍掉。
    name: "带开关的重置仍要能清掉分片",
    check: "verifyProjectShardsAreNeverSilentlyDropped",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    from: "    if (removedProjectIds.length && !options.allowProjectShardRemoval) {",
    to: "    if (removedProjectIds.length) {",
    expect: "项目分片守卫"
  },
  {
    // 读了却没人赋值的 state 字段 = 那条信息永远到不了人眼前（今天抓到两个真的）。
    // 同一处变异另有控制面 e2e 覆盖（真的把归档文件改成只读、写一次、读接口，再恢复并要求标记自清）；
    // 曾为此单列过一条 skip 条目，但同 file/from/to 的两行登记只会让人以为守的是两处不同的东西。
    name: "服务端读的 state 字段必须有人赋值",
    check: "verifyServerStateFieldsHaveProducers",
    file: "apps/control-plane-ui/server.mjs",
    from: "      archiveFault: sharedAuditArchiveFault(),",
    to: "      archiveFault: state.auditArchiveFault || null,",
    expect: "没有任何地方给它们赋值"
  },
  {
    // 词表里多一个产品代码里不存在的名字 = 每个工具的 inputSchema 都摆着一个假旋钮。
    name: "MCP 入参词表不得有幽灵",
    check: "verifyMcpInputDictionaryHasNoGhosts",
    file: "apps/mcp-server/server.mjs",
    from: "    dryRun: boolean,",
    to: "    dryRun: boolean,\n    phantomKnob: string,",
    expect: "根本不存在"
  },
  {
    // 有人接上生产者却没改登记 = 读代码的人继续以为这道闸不生效（反过来也一样害人）。
    name: "惰性机制被接上时登记要过期",
    check: "verifyInertMechanismsStayRegistered",
    file: CORE,
    from: "  const conditionSource = request.conditionSource || state.conditionSource || null;",
    to: "  state.conditionSource = state.conditionSource || null;\n  const conditionSource = request.conditionSource || state.conditionSource || null;",
    expect: "已经有人接上生产者了"
  },
  {
    // 查历史的那一屏不说自己不完整 = 最害人的一种"看起来完整"。
    name: "归档不完整要在查历史那一屏说出来",
    file: APP,
    gate: "console",
    from: "          ${faultNotice}",
    to: "",
    expect: "却不知道有条目从没落盘"
  },
  {
    // 文档里写死的数字与代码常量漂开 = 运维照着旧数字去归档里找一份不存在的记录。
    name: "README 里的数字要跟着代码走",
    file: "apps/control-plane-ui/lib/audit-ledger.mjs",
    gate: "specs",
    from: "export const AUDIT_LOG_CAP = 80;",
    to: "export const AUDIT_LOG_CAP = 120;",
    expect: "运维照着文档里的数字判断会判错"
  },
  {
    // 扫掉在飞的临时文件 = 把一次正在进行的好写入毁掉。这条安全前提此前从没被确定性验过。
    name: "在飞的临时文件不得被扫",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    gate: "crash",
    from: "      if (statSync(full).mtimeMs < cutoff) unlinkSync(full);",
    to: "      unlinkSync(full);",
    expect: "绝不能碰"
  },
  {
    // 按 pid 破的那条：写入者已死的临时文件不必等够 60 秒。
    name: "写入者已死的临时文件要立刻清掉",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    gate: "crash",
    from: "    try { process.kill(pid, 0); continue; } catch (error) { if (error?.code === \"EPERM\") continue; }",
    to: "    continue;",
    expect: "写入者进程已死的临时文件被清掉"
  },
  {
    // 请求体读取阶段的四个码在任何路由之前就产生，原先一个中文都没有。
    name: "请求体读取失败的码要有中文",
    file: "apps/control-plane-ui/public/i18n-zh.js",
    gate: "specs",
    from: '    request_body_too_large: "提交的内容超过 2MB 上限，请分批提交或精简内容",',
    to: "",
    expect: "没有中文"
  },
  {
    // 追查依据从源码里消失 = 登记过时，门必须当场说出来，而不是继续照着旧结论放行。
    name: "变量来源的原因码登记要跟着源码走",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    gate: "specs",
    // 换成一个【本来就有中文】的码：漏译那条检查照样全绿，只有"登记过时"这条会响 ——
    // 否则先红的是漏译检查，验到的就不是这条守卫（第一版变异就是这样）。
    from: 'reasonCode: "condition_window_deferred"',
    to: 'reasonCode: "resource_queued"',
    expect: "追查依据已经不在源码里了"
  },
  {
    // 把 core 的 resolveRoleSkill 从导入里去掉 = 又变回本地一份，判据必须点名。
    name: "core 导出的东西 MCP 不得再实现一遍",
    check: "verifyMcpDoesNotReimplementCore",
    file: "apps/mcp-server/server.mjs",
    from: "  resolveRoleSkill,\n  REGISTERED_OWNER_ROLES",
    to: "  REGISTERED_OWNER_ROLES",
    expect: "又实现了一遍"
  },
  {
    // 自己再实现一遍"按角色找技能"：子串命中 + roleSkills[0] 兜底 + 回退不留痕。
    name: "角色技能解析要走 core 那一份",
    file: "apps/mcp-server/server.mjs",
    skip: "判别力由 mcp:doctor 覆盖（未登记角色要拒、无专属技能要留痕、有专属技能不许误标）",
    from: "  const resolved = resolveRoleSkill(state, roleId,\n    {skillRef: args.roleSkillRef, taskGroupId: args.taskGroupId, projectId: args.projectId});",
    to: "  const resolved = state.roleSkills.find((skill) => skill.roleSkillId === args.roleSkillRef)\n    || state.roleSkills.find((skill) => skill.roleSkillId?.includes(roleId)) || state.roleSkills[0];",
    expect: "未登记的角色被解析出了技能"
  },
  {
    // 未登记的角色被收下 → 派发时静默绑上 orchestrator 的技能，agent 按别人的规则干活。
    name: "MCP 侧也要拒未登记的执行角色",
    file: "apps/mcp-server/server.mjs",
    skip: "判别力由 mcp:doctor 覆盖（真的用一个未登记的角色建工作项）",
    from: "    ownerRole: mcpWorkItemOwnerRole(args.roleId || args.ownerRole),",
    to: '    ownerRole: args.roleId || args.ownerRole || "orchestrator",',
    expect: "收下了未登记的角色"
  },
  {
    // details 被整层丢掉 = 特意写好的合法取值清单一次都没送出去。
    name: "MCP 拒绝报文要带上合法取值",
    file: "apps/mcp-server/server.mjs",
    skip: "判别力由 mcp:doctor 覆盖（真的填一个不存在的状态并检查 supported 清单）",
    from: "        ...(error.details ? {details: error.details} : {})}, true)};",
    to: "      }, true)};",
    expect: "没把合法取值回给调用方"
  },
  {
    // "一个项目都没有"被说成"当前项目暂无任务组" —— 人会去找是哪个项目空着。
    name: "没有项目要说清是没有项目",
    file: APP,
    gate: "console",
    from: "  if (hasNoVisibleProject()) return panel(\"任务组\", noVisibleProjectNotice(), {wide: true});",
    to: "",
    expect: "而不是项目空着"
  },
  {
    // 反向：有项目、只是里面还没有任务组，那句区分不能被吃掉。
    name: "项目里没有任务组的提示不能被吃掉",
    file: APP,
    gate: "console",
    from: "function hasNoVisibleProject() {\n  return !visibleProjects().length;",
    to: "function hasNoVisibleProject() {\n  return true;",
    expect: "仍要说的是"
  },
  {
    // 真正挡住"把自己停用"的是渲染这一层：自己那一行不发任何操作按钮。
    // 注意条件有两个（不是 user_account、不是自己），对组织管理员而言先命中的是前者 ——
    // 所以变异要把整个守卫放开，只删 !isSelf 的话组织管理员那一行照样没按钮，判据看不出差别。
    name: "成员表不给自己那一行发操作按钮",
    file: APP,
    gate: "console",
    from: '    const manageable = account.accountType === "user_account" && !isSelf;',
    to: "    const manageable = true;",
    expect: "点下去就是把自己登出"
  },
  {
    // 自己那一行和别人那一行走同一段话 —— 人不知道自己正在把自己登出。
    name: "停用成员要认出这一行是你自己",
    file: APP,
    gate: "console",
    from: "      const isSelf = Boolean(currentAccount?.accountId) && target.dataset.account === currentAccount.accountId;",
    to: "      const isSelf = false;",
    expect: "自己那一行和别人那一行走同一段话"
  },
  {
    // 改完密码留在一条已经死掉的会话里：下一次点击才 401，弹的还是"会话已过期"。
    name: "改密后要当场清掉本地会话",
    file: APP,
    gate: "console",
    from: '      clearSession();\n      openModal("修改密码"',
    to: '      openModal("修改密码"',
    expect: "已经死掉的会话"
  },
  {
    // 提示不能暗示"你可以接着用" —— 这一台此刻已经被登出了。
    name: "改密提示不得暗示会话还能用",
    file: APP,
    gate: "console",
    from: "这个账号的所有登录会话（包括当前这一台）都已失效 —— 请用新密码重新登录。",
    to: "下次登录可使用新密码。",
    expect: "暗示当前会话还能接着用"
  },
  {
    // 空下拉的表单点了必然失败；这是全新组织的第一屏。
    name: "没有项目时不摆出必然失败的表单",
    file: APP,
    gate: "console",
    from: '  if (!(state.projects || []).length) return noProjectYetNotice("智能体加入令牌");',
    to: "",
    expect: "点了必然失败的加入令牌表单"
  },
  {
    // 反向：守卫不能把有项目时的入口也吃掉。
    name: "有项目时这两个入口必须还在",
    file: APP,
    gate: "console",
    from: '  if (!(state.projects || []).length) return noProjectYetNotice("项目成员授权");',
    to: "  if (true) return noProjectYetNotice(\"项目成员授权\");",
    expect: "被守卫吃掉了"
  },
  {
    // 手机键盘默认首字母大写：严格比较＝人拿自己的邮箱登不进来，且只回一句统一的 401。
    name: "邮箱比对要按大小写归一",
    file: "apps/control-plane-ui/server.mjs",
    skip: "判别力由控制面 e2e 覆盖（真的换大小写+带空格登录一次）",
    from: "      || state.accounts.find((item) => sameEmail(item.email, email));",
    to: "      || null;",
    expect: "换个大小写"
  },
  {
    // 登录与"是否已注册"只改一边 → 两个只差大小写的账号，登录时不知道匹配谁。
    name: "是否已注册要和登录同一口径",
    file: "apps/control-plane-ui/server.mjs",
    skip: "判别力由控制面 e2e 覆盖（真的建两个只差大小写的账号）",
    from: "    if (body.admin?.email && (state.accounts || []).some((item) => sameEmail(item.email, body.admin.email))) {",
    to: "    if (body.admin?.email && (state.accounts || []).some((item) => item.email === String(body.admin.email))) {",
    expect: "只差大小写的第二个账号"
  },
  {
    // 初始组织管理员的邮箱是登录身份，不能替人编一个。
    name: "建组织必须指定管理员邮箱",
    file: "apps/control-plane-ui/server.mjs",
    skip: "判别力由控制面 e2e 覆盖（真的用平铺字段建组织，要求 400 且点名 admin.email）",
    from: "    if (!requestedAdminEmail || !requestedAdminEmail.includes(\"@\")) {",
    to: "    if (false) {",
    expect: "没给 admin.email 也把组织建出来了"
  },
  {
    // 没被挤掉却宣称"更早的在归档里" = 凭空造出一次截断，还把人支去看空归档。
    name: "台账脚注不得凭空宣称有记录被挤掉",
    file: APP,
    gate: "console",
    from: "  return `台账共 ${shown} 条，都在这一屏内；归档文件里是同一份完整记录。`;",
    to: "  return `这一屏只保留最近 ${shown} 条；更早的记录在归档文件里，不在这一屏内。`;",
    expect: "不许暗示有更早的记录"
  },
  {
    // 上限写死在界面里，服务端一改这句话就开始说谎。
    name: "台账上限只能来自服务端下发",
    file: APP,
    gate: "console",
    from: "  const cap = Number(state.runtime?.auditLogCap || 0);",
    to: "  const cap = 80;",
    expect: "不许自己编一个"
  },
  {
    // 表脚少了第三个参数，"共 N 条"就成了把截断后的条数当总数报给人。
    name: "表脚不得把截断后的条数当总数",
    check: "verifyTableFootersAdmitTruncation",
    file: APP,
    from: "moreText: moreText((state.auditLog || []).length, 15, \"auditLog\")",
    to: "moreText: moreText((state.auditLog || []).length, 15)",
    expect: "当成了总数"
  },
  {
    // 整屏那条横幅要真的接在外壳上，且要逐个点名（只说"有名单被截断"，人不知道是哪一份）。
    name: "被截断的名单要逐个点名",
    file: APP,
    gate: "console",
    from: "  const names = fields.map((field) => COLLECTION_LABELS[field] || t(field)).join(\"、\");",
    to: '  const names = "";',
    expect: "人不知道是哪一份"
  },
  {
    // "必须先定稿方案"那条提示原先只说事实。而这种情况下编排既不改工作项状态、也留不下任务组阻塞，
    // 所以除了这一句，屏幕上再没有别的地方讲它在等什么 —— 去掉出口，人就被留在原地。
    name: "要求先定稿方案的单元要给出口",
    file: APP,
    gate: "console",
    from: "              等 agent 提出执行方案后，到「人工审核」页定稿它；没有在线 agent 时不会有人提方案。",
    to: "",
    expect: "只说了在等什么、没说怎么往下走"
  },
  {
    name: "没有可用技能源时要说清后果",
    file: APP,
    gate: "console",
    from: '        return `<div class="notice warn-notice">${esc(why)}，所有角色都在用系统内置技能（共 ${builtIn} 个）。`',
    to: '        return "" || `<div class="notice">${esc("")}${builtIn}`',
    expect: "人看不出所有角色已经落到系统内置技能上"
  },
  {
    name: "技能源退役要有界面入口",
    file: APP,
    gate: "console",
    from: 'data-action="retire-skill-source"',
    to: 'data-action="retire-skill-source-disabled"',
    expect: "没有任何拿下去的出口"
  },
  {
    name: "技能源同步失败要写清为什么",
    file: CORE,
    check: "verifySkillSourceSyncFailureIsVisible",
    from: "    source.lastSyncError = `同步失败（${gitFailureDetail(error)}）`;",
    to: '    source.lastSyncError = "";',
    expect: "记录上没有 lastSyncError"
  },
  {
    name: "技能源失败原因要出现在表上",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: '    statusBadge("skillSource", source.status) + (source.status === "stale" && source.lastSyncError',
    to: '    statusBadge("skillSource", source.status) + (false',
    expect: "原因没有出现在表上"
  },
  {
    // 退回 execFileSync 原样抛出：报文会变回 "Command failed: git -C <服务器绝对路径> …"，
    // 既不说原因、又泄露路径，而它会原样显示在控制台的失败原因里。
    name: "git 失败要说原因且不带服务器路径",
    file: CORE,
    check: "verifyGitFailureSaysWhyWithoutLeakingPaths",
    from: `    throw Object.assign(new Error(\`git_command_failed:\${gitFailureText(args, error)}\`),
      {cause: error, stderr: error?.stderr, status: error?.status});`,
    to: "    throw error;",
    expect: "报文里带着服务器的绝对路径"
  },
  {
    // "有规范却没人声明"这条在当前数据上为空，靠契约门里的注入自证。把判据关掉，
    // 那次注入必须报出"这道判据不会响"——否则自证本身也是摆设。
    name: "整个集合退出规范校验必须被点名",
    file: "scripts/lib/schema-validate.mjs",
    check: "verifySeedRecordsMatchTheirDeclaredSchemas",
    from: "    if (spec) {",
    to: "    if (false) {",
    expect: "这道判据不会响"
  },
  {
    // 不走守卫的路由必须逐条登记：把认证那族从例外里去掉，三条路由立刻被点名。
    name: "没有守卫的改状态路由必须被点名",
    file: "scripts/auth-placement-gate.mjs",
    gate: "auth",
    from: '    || /"\\/api\\/auth\\/(login|logout|change-password)"/u.test(header);',
    to: "    || false;",
    expect: "既不走 beginGuardedWrite、也不属于已登记的例外"
  },
  {
    // 最外层防线：机器主体的工具白名单里不能有真人专属工具。把定稿工具塞进控制角色工具包，
    // 必须当场被点名 —— 否则机器就拿到了定稿权，只剩工具内部那道【真实部署里够不到】的判据兜着。
    name: "真人专属工具不得授给机器主体",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    gate: "parity",
    from: '  "orchestration-mcp.orchestrator_run",',
    to: '  "human-review-mcp.confirmation_decide",\n  "orchestration-mcp.orchestrator_run",',
    expect: "被授给了机器主体"
  },
  {
    // 定义了却没注册的断言，看起来就是覆盖。把一条注册摘掉，本条必须点名它。
    name: "定义了却没注册的断言必须被点名",
    file: "scripts/contract-check.mjs",
    check: "verifyEveryAssertionIsActuallyRegistered",
    from: "run(verifyCrossOrgGrantIsRefusedOnBothDoors);",
    to: "",
    expect: "没有注册进运行清单"
  },
  {
    // 自述的账必须加得起来：旧账把"有 core 函数但 MCP 侧没有同名工具"的动作算成已覆盖，
    // 于是 22 个动作只交代了 16 个，剩下的既不在已核对里也不在够不到里。
    name: "真人专属动作的覆盖账必须加得起来",
    file: "scripts/human-only-parity-gate.mjs",
    gate: "parity",
    from: "    .filter((action) => !functionVerifiedActions.has(action) && !nameCoveredActions.has(action));",
    to: "    .filter((action) => !humanOnlyFunctions.size && !nameCoveredActions.has(action));",
    expect: "没进任何一栏"
  },
  {
    // 死导出检查此前把 scripts/ 也算成调用方，于是"只有门在调"的整族机制隐身。
    // 收紧之后要能认出来：摘掉一条登记，那个函数必须当场被点名。
    name: "只有门在调的导出不算接上了",
    file: "scripts/barrier-liveness-gate.mjs",
    gate: "barrier",
    from: '  toDlq: "只有契约门在调',
    to: '  toDlqRenamed: "只有契约门在调',
    expect: "导出的 toDlq 没有任何地方调用或引用"
  },
  {
    // 这道门此前也只有一条登记变异。它真正要防的是"某类对象在生产中永远无法终结"，
    // 而那条判据依赖状态生产者的提取 —— 提取一旦失效，门会一片绿地放过所有状态机。
    name: "机器活性检查：状态生产者提取失效必须报出来",
    file: "scripts/barrier-liveness-gate.mjs",
    gate: "barrier",
    from: "function loadProducedStatuses() {\n  const produced = new Set();",
    to: "function loadProducedStatuses() {\n  const produced = new Set();\n  if (true) return produced;",
    expect: "的状态一个都没有被代码写入过"
  },
  {
    // 这道门此前只有一条登记变异（MCP 定稿白名单），其余四条失败路径从没被人看着红过。
    // 下面三条分别钉住：REST 侧守卫失踪、按函数比对的越权检测、以及提取失效必须报空转。
    name: "真人专属动作在 REST 侧失踪要被发现",
    file: SERVER,
    gate: "parity",
    from: 'beginGuardedWrite(req, state, "project_archive"',
    to: 'beginGuardedWrite(req, state, "project_archive_x"',
    expect: "在 REST 侧找不到对应的守卫调用"
  },
  {
    name: "MCP 工具通向真人专属核心函数要被发现",
    file: MCP,
    gate: "parity",
    from: '    case "model-mcp.model_capabilities":\n      return {modelCapabilities: state.modelCapabilities};',
    to: '    case "model-mcp.model_capabilities":\n      if (args.__probe) return contractPublish(state, args);\n      return {modelCapabilities: state.modelCapabilities};',
    expect: "通向 contractPublish"
  },
  {
    name: "真人专属对等门：REST 侧提取失效必须报空转",
    file: "scripts/human-only-parity-gate.mjs",
    gate: "parity",
    from: "const CORE_CALL = /\\b([a-z][A-Za-z0-9]{3,})\\(\\s*state\\s*[,)]/g;",
    to: "const CORE_CALL = /\\b(zzz[a-z]+)\\(\\s*state\\s*[,)]/g;",
    expect: "提取逻辑已与代码脱节"
  },
  {
    name: "走接口取数的那几页也要在漏译扫描的覆盖里",
    file: I18N,
    gate: "console",
    from: '    project_member: "项目成员",',
    to: "",
    expect: "「project_member」（出现在 有指令与授权(走接口)/org-members）"
  },
  {
    name: "定稿页的协商记录也要在漏译扫描的覆盖里",
    file: I18N,
    gate: "console",
    from: '    revise: "提交修改意见",',
    to: "",
    expect: "「revise」（出现在 待定稿的核心决策/review）"
  },
  {
    name: "漏译扫描：真的 t 渲染一遍，界面上不许出现英文枚举",
    file: I18N,
    gate: "console",
    from: '    active_paused_by_freeze: "已被冻结暂停",',
    to: "",
    expect: "中文界面上会显示英文枚举"
  },
  {
    // 词表类的门各自按权威来源核对，但答不了"这个值会不会出现在某一屏上"。这一段是唯一
    // 从渲染结果反向看的判据，它自己空转了就没有任何东西能发现 —— 所以空转必须报红。
    name: "漏译扫描：加载不到真的 i18n 时必须报空转",
    file: CONSOLE_GATE,
    gate: "console",
    from: "    const real = context.window.AIMAC_I18N;",
    to: "    const real = null;",
    expect: "本段在空转"
  },
  {
    // 同形状第二次：文件名带连字符和点，同样会逃过提取，而运维一节正是靠它们指路。
    name: "README 里的文件名也要被核对到",
    file: "README.md",
    gate: "specs",
    from: "`mcp-audit.jsonl`",
    to: "`mcp-audit-gone.jsonl`",
    expect: "代码里已经没有了"
  },
  {
    // 上一条用的是光秃秃的标识符。带结尾冒号的写法（"码 + 细节"的前缀）此前会静默逃逸提取，
    // 改坏它门也不红 —— 同一形状本仓已经撞过四次，所以单独守一条。
    name: "README 里带冒号的标识符也要被核对到",
    file: "README.md",
    gate: "specs",
    from: "`git_command_failed:`",
    to: "`git_command_gone:`",
    expect: "代码里已经没有了"
  },
  {
    // README 那节写的是"出事的时候它怎么说话"（存储配置写错会退出、健康检查报 degraded、
    // 盘写不进去回哪个码、入网失败给人话）。这类描述最容易随代码漂，而运维照着它判断会判错。
    name: "README 运维一节点名的东西必须还在代码里",
    file: "README.md",
    gate: "specs",
    from: "`state_storage_unavailable`",
    to: "`state_storage_gone`",
    expect: "代码里已经没有了"
  },
  {
    name: "权限码本地化：授权列表里的权限码要有中文",
    file: APP,
    gate: "specs",
    from: '  "task_group:control": "任务组执行控制",',
    to: "",
    expect: "task_group:control"
  },
  {
    // 与审计动作那条同理：标签块换个名字，这道门就再也提取不到任何权限码，而它一片绿。
    name: "权限码本地化：标签块取不到时必须报空转",
    file: APP,
    gate: "specs",
    from: "const MEMBER_PERMISSION_OPTIONS = [",
    to: "const MEMBER_PERM_OPTIONS = [",
    expect: "本条在空转"
  },
  {
    name: "审计动作本地化：拼接出来的动作名也要有中文",
    file: I18N,
    gate: "specs",
    from: '    agent_control_shutdown: "下发关停节点",',
    to: "",
    expect: "agent_control_shutdown"
  },
  {
    // 这一条防的不是"少了个中文"，而是"这一族从此不被检验了"——闭集换个名字，
    // 门就再也展开不出 task_group_*，而它仍然一片绿。空转的门比没有门更糟。
    name: "审计动作本地化：闭集取不到时必须报空转",
    file: SERVER,
    gate: "specs",
    from: "const TASK_GROUP_CONTROL_ACTIONS = [",
    to: "const TASK_GROUP_CONTROL_ACTION_LIST = [",
    expect: "这一族在空转"
  },
  {
    name: "本地化门必须看得见三元写法里的原因码",
    file: I18N,
    gate: "specs",
    from: '    assigned_node_shutdown_pending_stop: "节点关停待停止",',
    to: "",
    expect: "assigned_node_shutdown_pending_stop"
  },
  {
    name: "本地化门必须看得见 || 兜底写法里的错误码",
    file: I18N,
    gate: "specs",
    from: "    repository_output_target_unsafe_branch: ",
    to: "    repository_output_target_unsafe_branch_renamed: ",
    expect: "repository_output_target_unsafe_branch"
  },
  {
    name: "未达法定人数的审批必须继续挡住关闭门",
    file: CORE,
    gate: "specs",
    from: 'export const APPROVAL_REQUEST_PENDING_STATUSES = ["requested", "quorum_collecting"];',
    to: 'export const APPROVAL_REQUEST_PENDING_STATUSES = ["requested"];',
    expect: "未达法定人数的审批不再挡住关闭"
  },
  {
    name: "两处关闭门判定必须共用同一个待处理集合（各写各的必然漂）",
    file: CORE,
    gate: "specs",
    from: "      (state.approvalRequests || []).some((item) => item.taskGroupId === taskGroupId && APPROVAL_REQUEST_PENDING_STATUSES.includes(item.status)),",
    to: '      (state.approvalRequests || []).some((item) => item.taskGroupId === taskGroupId && ["requested", "quorum_collecting"].includes(item.status)),',
    expect: "各写各的清单必然漂"
  },
  {
    name: "check 参数写反必须当场报错（否则断言恒真、门与变异一起全绿）",
    file: CONSOLE_GATE,
    gate: "console",
    from: "  check(\"项目数没到上限时不需要索引，行为不变\",\n    small.kept === \"p3\" && small.options.length === 1,",
    to: "  check(small.kept === \"p3\" && small.options.length === 1,\n    \"项目数没到上限时不需要索引，行为不变\",",
    expect: "参数错位"
  },
  {
    name: "并发写入必须靠 CAS 拦住丢更新",
    file: STORE,
    gate: "writer",
    from: `function throwStateStoreConflict(message) {
  const error = new Error(message);`,
    to: `function throwStateStoreConflict(message) {
  return; // eslint-disable-line
  const error = new Error(message);`,
    // CAS 失效的【表现】变了：存储层后来多了一道"项目分片只增不减"的防线，
    // 它会把陈旧写入拒掉，所以不再表现为"丢更新"，而是表现为并发写入出现了第三种结局
    // （500，既不是成功也不是版本冲突）。原先门只统计 ok 与 409，500 被静默忽略，
    // 于是这条变异一度完全失去判别力 —— 全量变异门抓到的就是这个。
    expect: "第三种结局"
  },
  {
    name: "崩溃后要按持锁进程是否还活着破锁（只靠时间兜底会把系统锁死）",
    file: STORE,
    gate: "crash",
    from: `    const alive = lockOwnerAlive(lockDir);
    if (alive === false) {`,
    to: `    const alive = lockOwnerAlive(lockDir);
    if (false) {`,
    expect: "立刻恢复"
  },
  {
    name: "关闭门里不得混入状态机没有的状态名",
    file: CORE,
    gate: "barrier",
    from: 'no_pending_review_bundle: (state.reviewBundles || []).some((item) => item.taskGroupId === taskGroupId && !["consumed", "rejected"].includes(item.status)),',
    to: 'no_pending_review_bundle: (state.reviewBundles || []).some((item) => item.taskGroupId === taskGroupId && !["consumed", "rejected", "nonexistent_state"].includes(item.status)),',
    expect: "不存在的状态"
  },
  {
    name: "真人专属动作在 MCP 侧必须拒绝机器主体",
    file: MCP,
    gate: "parity",
    from: "      // \u9009\u4e2d\u3002REST \u4fa7\u5df2\u628a\u4e24\u8005\u5b9a\u4e3a\u771f\u4eba\u4e13\u5c5e\uff0c\u914d\u7f6e\u9762\u4e5f\u6321\u4e86\u670d\u52a1\u4ee4\u724c \u2014\u2014 \u4f46\u914d\u7f6e\u662f\u914d\u7f6e\uff0c\u9501\u8981\u843d\u5728\u51b3\u7b56\u70b9\u4e0a\u3002\n      // \u767d\u540d\u5355\u5f0f\uff0c\u4e0e\u300c\u66ff\u4eba\u5b9a\u7a3f\u300d\u90a3\u9053\u540c\u89c4\uff1a\u653e\u884c\u63a7\u5236\u53f0\u4ee3\u8868\u7684\u771f\u4eba\u4f1a\u8bdd\uff08system_admin\uff09\uff0c\u5176\u4f59\u4e00\u5f8b\u62d2\u3002\n      // \u539f\u5148\u662f\u9ed1\u540d\u5355\uff08\u5217\u4e3e agent_node / system_service\uff09\u2014\u2014 \u90a3\u6761\u8bed\u4e49\u662f\"\u6ca1\u5217\u5230\u7684\u4e00\u5f8b\u653e\u884c\"\uff0c\n      // \u4ee5\u540e\u65b0\u589e\u4efb\u4f55\u673a\u5668\u4e3b\u4f53\uff0c\u9ed8\u8ba4\u5c31\u80fd\u505a\u8fd9\u4ef6\u4e8b\uff0c\u800c\u4e14\u4e0d\u4f1a\u6709\u4efb\u4f55\u4e1c\u897f\u62a5\u8b66\u3002\n      if (context?.principal?.kind !== \"system_admin\") {",
    to: "      // \u9009\u4e2d\u3002REST \u4fa7\u5df2\u628a\u4e24\u8005\u5b9a\u4e3a\u771f\u4eba\u4e13\u5c5e\uff0c\u914d\u7f6e\u9762\u4e5f\u6321\u4e86\u670d\u52a1\u4ee4\u724c \u2014\u2014 \u4f46\u914d\u7f6e\u662f\u914d\u7f6e\uff0c\u9501\u8981\u843d\u5728\u51b3\u7b56\u70b9\u4e0a\u3002\n      // \u767d\u540d\u5355\u5f0f\uff0c\u4e0e\u300c\u66ff\u4eba\u5b9a\u7a3f\u300d\u90a3\u9053\u540c\u89c4\uff1a\u653e\u884c\u63a7\u5236\u53f0\u4ee3\u8868\u7684\u771f\u4eba\u4f1a\u8bdd\uff08system_admin\uff09\uff0c\u5176\u4f59\u4e00\u5f8b\u62d2\u3002\n      // \u539f\u5148\u662f\u9ed1\u540d\u5355\uff08\u5217\u4e3e agent_node / system_service\uff09\u2014\u2014 \u90a3\u6761\u8bed\u4e49\u662f\"\u6ca1\u5217\u5230\u7684\u4e00\u5f8b\u653e\u884c\"\uff0c\n      // \u4ee5\u540e\u65b0\u589e\u4efb\u4f55\u673a\u5668\u4e3b\u4f53\uff0c\u9ed8\u8ba4\u5c31\u80fd\u505a\u8fd9\u4ef6\u4e8b\uff0c\u800c\u4e14\u4e0d\u4f1a\u6709\u4efb\u4f55\u4e1c\u897f\u62a5\u8b66\u3002\n      if (false) {",
    expect: "没有拒绝机器主体"
  },
  {
    name: "路径定位的对象，作用域不得取自操作者自己",
    file: SERVER,
    gate: "auth",
    from: '"org_member_status_update", `Account:${orgMemberStatusMatch[1]}`, target.scope)',
    to: '"org_member_status_update", `Account:${orgMemberStatusMatch[1]}`, {resourceType: "organization", resourceId: actorAccount?.organizationId})',
    expect: "授权作用域却取自操作者自己"
  },
  {
    name: "审计必须记真人（服务名会把责任人抹掉）",
    file: SERVER,
    gate: "auth",
    from: 'audit(state, guard.actor, "access_grant_create"',
    to: 'audit(state, "ui-console-service", "access_grant_create"',
    expect: "记成了服务名"
  },
  {
    name: "受守卫写路由必须在审计里留痕",
    file: SERVER,
    gate: "auth",
    from: '    audit(state, guard.actor, "task_group_create"',
    to: "    void 0; //",
    expect: "没有在 auditLog 里留痕"
  },
  {
    name: "准入判决 token 必须有中文（台账里那一栏就是回答'为什么不动'的）",
    file: APP,
    gate: "specs",
    from: '  cell_yielding_to_higher_priority: "让路给更高优先级的单元",',
    to: '  ignored_key: "x",',
    expect: "cell_yielding_to_higher_priority"
  },
  {
    name: "状态集合常量不得含状态机查无此名的状态",
    file: CORE,
    gate: "specs",
    from: 'export const RETIRED_NODE_STATUSES = new Set(["revoked"]);',
    to: 'export const RETIRED_NODE_STATUSES = new Set(["revoked", "decommissioned"]);',
    expect: "查无此名的状态：decommissioned"
  },
  {
    name: "项目切换器必须能选到下发上限之外的项目",
    file: APP,
    gate: "console",
    from: "return (state.projectIndex && state.projectIndex.length) ? state.projectIndex : visibleProjects();",
    to: "return visibleProjects();",
    expect: "静默切走"
  },
  {
    name: "占额度的活自己卡在等人时，不许说会自动继续",
    file: APP,
    gate: "console",
    from: "  const blocked = Number(wip.blocked || 0);",
    to: "  const blocked = 0;",
    expect: "不许说会自动继续"
  },
  {
    name: "视图基底也要按项目过滤（否则监控页拿到全部项目的任务组）",
    file: SERVER,
    gate: "idle",
    from: "projectTaskGroupsForView(sliceItems(scopeCollection(scoped.taskGroups), capped))",
    to: "projectTaskGroupsForView(sliceItems(scoped.taskGroups, capped))",
    expect: "混进来："
  },
  {
    name: "集合 schema 覆盖：记录不得悄悄丢掉 schemaVersion",
    file: CORE,
    check: "verifyEveryStateCollectionIsSchemaChecked",
    from: '    schemaVersion: "worker-lane/v1",',
    to: "",
    expect: "schemaVersion"
  },
  {
    name: "容量快照：节点计数不得按不存在的字段过滤（那会恒为 0）",
    file: MCP,
    check: "verifyCapacitySnapshotCountsAreNotAlwaysZero",
    from: "? state.agentRuntimeNodes.filter((item) => (item.projectIds || []).some((id) => filter.has(id))).length",
    to: "? state.agentRuntimeNodes.filter((item) => item.projectId && filter.has(item.projectId)).length",
    expect: "调度方据此判定没有容量"
  },
  {
    name: "视图作用域：agent 节点按复数 projectIds 归属（否则舰队计数会串项目）",
    file: CORE,
    check: "verifyProjectScopePredicateResolvesOwnership",
    from: "    if (Array.isArray(item.projectIds)) return item.projectIds.includes(scopeProjectId);",
    to: "",
    expect: "节点只服务别的项目"
  },
  {
    name: "视图作用域：不带 projectId 的记录要按 taskGroupId 反查归属",
    file: CORE,
    check: "verifyProjectScopePredicateResolvesOwnership",
    from: "      return projectIdOf.get(item.taskGroupId) === scopeProjectId;",
    to: "      return true;",
    expect: "别的项目的记录会出现在这个项目的页面上"
  },
  {
    name: "在制品上限：已吊销的节点不得继续撑着队头",
    file: CORE,
    check: "verifyQuietProjectsDoNotHoardSlots",
    from: "if (!RETIRED_NODE_STATUSES.has(node.status)) registered += 1;",
    to: "registered += 1;",
    expect: "永远不会有人来领"
  },
  {
    name: "在制品上限：从未注册过节点的项目不得占着完整队头",
    file: CORE,
    check: "verifyQuietProjectsDoNotHoardSlots",
    from: "(registered ? 16 : 2)",
    to: "16",
    expect: "纯浪费"
  },
  {
    name: "在制品上限：额度必须按项目算，不得跨项目共享",
    check: "verifyWipCapacityIsPerProject",
    file: CORE,
    from: "const wipNow = wipInFlight.get(taskGroup.projectId) || 0;",
    to: "const wipNow = [...wipInFlight.values()].reduce((sum, value) => sum + value, 0);",
    expect: "跨项目共享"
  },
  {
    name: "优先级预留：靠后组的 P0 不得被靠前组的普通活饿死",
    check: "verifyHighPriorityCellsAreNotStarvedByEarlierGroups",
    file: CORE,
    from: "if (wipNow + wipReserved >= wipCap) {",
    to: "if (wipNow >= wipCap) {",
    expect: "永远轮不上"
  },
  {
    name: "优先级预留：扫到之后必须把名额还回去",
    file: CORE,
    from: "        consumePending(taskGroup.projectId, cellAdmissionPriority(workItem));",
    to: "        void 0;",
    check: "verifyHighPriorityCellsAreNotStarvedByEarlierGroups",
    expect: "扣住了没还回来"
  },
  {
    name: "优先级预留：让路与额度真满不得记成同一件事",
    check: "verifyHighPriorityCellsAreNotStarvedByEarlierGroups",
    file: CORE,
    from: 'whyThisCellNow: wipNow >= wipCap ? "cell_waiting_for_wip_capacity" : "cell_yielding_to_higher_priority"',
    to: 'whyThisCellNow: "cell_waiting_for_wip_capacity"',
    expect: "人无从分辨"
  },
  {
    name: "在制品上限：闸必须真的挡住",
    file: CORE,
    from: "      if (wipNow + wipReserved >= wipCap) {",
    to: "      if (false) {",
    check: "verifyWipCapacityBackpressure",
    expect: "闸没生效"
  },
  {
    name: "在制品上限：额度不得算成 0（否则永远派不出第一个活）",
    file: CORE,
    from: "  return queueHead + online * perNode;",
    to: "  return 0;",
    check: "verifyWipCapacityBackpressure",
    expect: "额度算成了 0"
  },
  {
    name: "在制品上限：等额度是背压，不得记成 blocked",
    check: "verifyWipCapacityBackpressure",
    file: CORE,
    from: 'outcome: "resource_queued", reasonCode: "wip_capacity_reached"',
    to: 'outcome: "blocked", reasonCode: "wip_capacity_reached"',
    expect: "resource_queued"
  },
  {
    name: "在制品上限：在飞状态集合必须与 AgentDispatch 状态机一致",
    check: "verifyWipCapacityBackpressure",
    file: CORE,
    from: '["queued", "running", "blocked"]',
    to: '["queued", "running"]',
    expect: "漏了非终态"
  },
  {
    name: "租约索引必须核对状态，不得把已释放的租约当成活的",
    check: "verifyPerformanceCachesStayCorrect",
    file: CORE,
    from: '  if (cached && cached.status === "active" && cached.resourceRef === resourceRef) return cached;',
    to: "  if (cached) return cached;",
    expect: "写锁形同虚设"
  },
  {
    name: "请求作用域泄漏门：提取失配要自报空转",
    file: "scripts/contract-check.mjs",
    check: "verifyNoRequestScopedLeaks",
    from: "      const header = lines[index].match(/^(?:export )?(?:async )?function ([A-Za-z0-9_]+)\\(([^)]*)\\)\\s*\\{/);",
    to: "      const header = lines[index].match(/^ZZZ(?:export )?function ([A-Za-z0-9_]+)\\(([^)]*)\\)\\s*\\{/);",
    expect: "提取多半失配"
  },
  {
    name: "文案换了写法，点名字段那道门要报红而不是无事可做",
    file: "apps/control-plane-ui/public/i18n-zh.js",
    check: "verifyMessagesDoNotPointAtInvisibleFields",
    from: "报文里的 file 指出是哪一份",
    to: "响应中的 file 指出是哪一份",
    expect: "一个「报文里的 X」都没认出来"
  },
  {
    name: "认不出的升级候选状态必须拒绝",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: '    if (!nextStatus) return json(res, 400, {error: "system_upgrade_candidate_status_invalid"});',
    to: '    if (false) return json(res, 400, {error: "system_upgrade_candidate_status_invalid"});',
    expect: "认不出的升级候选状态必须拒绝"
  },
  {
    name: "启动期拒绝时不得把密钥原样打进日志",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: "`当前给的是 ${String(process.env[envName]).trim().length} 个字符`,",
    to: "`当前给的是 ${String(process.env[envName]).trim()}`,",
    expect: "把不安全的密钥原样打进了日志"
  },
  {
    name: "登录失败不得记成「已驳回」（那是审批用语）",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: 'audit(state, "auth-service", "auth_login", `Account:${email}`, "credentials_invalid");',
    to: 'audit(state, "auth-service", "auth_login", `Account:${email}`, "denied");',
    expect: "台账上记成"
  },
  {
    name: "技能源接了但一条都没取下来时要说出来（新部署撞的就是这个）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "        const usable = (state.skillSources || []).filter((source) => source.status !== \"retired\"\n          && ((state.roleSkillCountBySource || {})[source.sourceId] || 0) > 0);",
    to: "        const usable = (state.skillSources || []).filter((source) => source.status !== \"retired\");",
    expect: "未同步时说的是"
  },
  {
    name: "文档里让人敲的命令必须真存在（第一条命令失败人就进不去门）",
    file: "README.md",
    check: "verifyDocumentedApiPathsExist",
    from: "npm run mcp:doctor",
    to: "npm run mcp:doctor-x",
    expect: "package.json 里没有"
  },
  {
    name: "文档点名的仓内文件必须真存在",
    file: "docs/machine-executable-artifacts.md",
    check: "verifyDocumentedApiPathsExist",
    from: "`spec/state-machines.yaml`",
    to: "`spec/state-machines-v2.yaml`",
    expect: "仓内文件不存在"
  },
  {
    name: "产出目标的策略决策不得被容量挤掉（调用方自带引用那一支）",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    check: "verifyOutputTargetKeepsItsPolicyDecision",
    from: "    ...(state.repositoryOutputs || []).flatMap((item) => [item.policyDecisionRef, item.decisionRecordRef])",
    to: "    ...(state.repositoryOutputs || []).map((item) => item.decisionRecordRef)",
    expect: "被容量挤掉"
  },
  {
    name: "这条用例必须真的触发容量淘汰（不淘汰就该报空转）",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    check: "verifyOutputTargetKeepsItsPolicyDecision",
    from: "  if (!Array.isArray(state?.policyDecisions) || state.policyDecisions.length <= cap) return;",
    to: "  if (!Array.isArray(state?.policyDecisions) || state.policyDecisions.length <= cap * 100) return;",
    expect: "本条在空转"
  },
  {
    name: "配了不存在的项目 id 要在启动时说出来（否则每次调用都莫名越权失败）",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyServiceAllowlistSaysWhatItDropped",
    from: "  if (configuredProjectIds.length) {",
    to: "  if (false) {",
    expect: "一个字都没说"
  },
  {
    name: "服务令牌白名单里配错的名字要说出来（否则当成有效工具放行）",
    file: "apps/control-plane-ui/lib/mcp-service-allowlist.mjs",
    check: "verifyServiceAllowlistSaysWhatItDropped",
    from: "      ? allowed.filter((tool) => !knownToolNames.includes(tool)) : [];",
    to: "      ? [] : [];",
    expect: "配了不存在的工具名却没说"
  },
  {
    name: "默认白名单下不得无中生有地报警",
    file: "apps/control-plane-ui/lib/mcp-service-allowlist.mjs",
    check: "verifyServiceAllowlistSaysWhatItDropped",
    from: "  } else {\n    lastServiceAllowlistNotice = \"\";\n  }",
    to: "  } else {\n    lastServiceAllowlistNotice = \"无中生有\";\n  }",
    expect: "没有自定义白名单却报了警"
  },
  {
    name: "阻塞卡片上的人工出口被抹掉要报红（本门原先认的页名根本不存在）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "它等待的资源尚未就绪：让系统管理员到「系统设置」页核对模型与技能源状态。",
    to: "它等待的资源尚未就绪。",
    expect: "阻塞状态出口"
  },
  {
    name: "每个 moreText 使用点都要传 field（否则截断后的长度被当成总数）",
    file: "apps/control-plane-ui/public/app.js",
    check: "verifyTruncationHonestyIsWiredAtEveryCallSite",
    from: 'moreText(overlays.length, 20, "roleSkillOverlays")',
    to: "moreText(overlays.length, 20)",
    expect: "没传 field"
  },
  {
    name: "moreText 提取脱节要自报空转",
    file: "scripts/contract-check.mjs",
    check: "verifyTruncationHonestyIsWiredAtEveryCallSite",
    from: "for (const match of app.matchAll(/moreText\\(/gu)) {",
    to: "for (const match of app.matchAll(/moreTextX\\(/gu)) {",
    expect: "本条在空转"
  },
  {
    name: "已归档项目不计入配额这件事要写在同一屏上",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: '          return archived ? `<div class="small muted">另有 ${archived} 个已归档，不计入配额</div>` : "";',
    to: '          return "";',
    expect: "已归档的项目不计入配额这件事要写出来"
  },
  {
    name: "没有已归档项目时不许多挂一句",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "          return archived ?",
    to: "          return true ?",
    expect: "没有已归档项目时不要多说一句"
  },
  {
    name: "未使用的入网令牌必须算成配额占位",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyOutstandingJoinTokensHoldTheirQuotaSlot",
    from: '    if (token.status !== "issued") continue;',
    to: '    if (token.status !== "issuedX") continue;',
    expect: "没有被算成占位"
  },
  {
    name: "占位不得并进 agents（否则节点被自己那张令牌顶掉一格）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyOutstandingJoinTokensHoldTheirQuotaSlot",
    from: '    bump(token.organizationId || DEFAULT_ORGANIZATION_ID, "agentsReserved");',
    to: '    bump(token.organizationId || DEFAULT_ORGANIZATION_ID, "agents");',
    expect: "没有被算成占位"
  },
  {
    name: "页面要显出占位并给出合计（否则还剩一格却签不出来）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: '${Number(reserved) > 0 ? `（另有 ${esc(reserved)} 张未使用的入网令牌占着位，合计 ${held}/${max ?? 0}）` : ""}',
    to: "",
    expect: "未使用的入网令牌占着配额，页面要显出来并给出合计"
  },
  {
    name: "没有待用令牌时页面不许多挂一句",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "${Number(reserved) > 0 ?",
    to: "${true ?",
    expect: "没有未使用的令牌时不要多说一句"
  },
  {
    name: "配额报文要拆开说是节点还是待用令牌占的位",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "    const breakdown = payload.outstandingJoinTokens",
    to: "    const breakdown = false && payload.outstandingJoinTokens",
    expect: "要拆开说清是节点还是没用掉的令牌"
  },
  {
    name: "配额里的 kind 不得被当成故障类型再打一遍",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: 'payload.kind && payload.quota === undefined ? `故障类型：${t(payload.kind)}` : "",',
    to: 'payload.kind ? `故障类型：${t(payload.kind)}` : "",',
    expect: "不能被当成「故障类型」再打一遍"
  },
  {
    name: "排除故障类型时不许把存储故障那一族一起挡掉",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "payload.kind && payload.quota === undefined ?",
    to: "payload.kind && false ?",
    expect: "存储故障那一族仍要打出故障类型"
  },
  {
    name: "智能体配额要说清只有吊销才腾得出额度",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: '? "或吊销一台不再用的节点（关停、停用档案都不减用量；未签发出去用掉的入网令牌也占着额度）"',
    to: '? "或先关掉/归档不再需要的"',
    expect: "只有吊销才腾得出来"
  },
  {
    name: "危险确认必须说清按下去会发生什么",
    file: "apps/control-plane-ui/public/app.js",
    check: "verifyDangerousConfirmsStateTheConsequence",
    from: '        sub: "该账号下一次请求就会失去这项授权；已经登录的会话不会被登出。需要时可以重新授权 —— 这一步可逆。",\n',
    to: "",
    expect: "通篇只有"
  },
  {
    name: "danger 弹窗提取脱节要自报空转",
    file: "scripts/contract-check.mjs",
    check: "verifyDangerousConfirmsStateTheConsequence",
    from: 'if (!call.includes("danger: true")) continue;',
    to: 'if (!call.includes("danger: TRUE")) continue;',
    expect: "本条在空转"
  },
  {
    name: "整个读不动的条目目录也要计数（只补里层会漏掉这一半）",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifySizeAccountingDoesNotSwallowFailures",
    from: "      unsizedEntries += 1;",
    to: "      void 0;",
    expect: "没有计数"
  },
  {
    name: "量不到的条目目录数了要报出来",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifySizeAccountingDoesNotSwallowFailures",
    from: "  if (unsizedFiles || unsizedEntries) {",
    to: "  if (unsizedFiles) {",
    expect: "数了却没报出来"
  },
  {
    name: "按幂等键查找读到坏行不许静默（第三条读路径）",
    file: "apps/control-plane-ui/lib/project-event-store.mjs",
    check: "verifyCorruptEventLinesAreReported",
    from: "      corrupt += 1;",
    to: "      corrupt += 0;",
    expect: "按幂等键查找时读到解析不了的行，一声不吭"
  },
  {
    name: "多种损坏成因要各记一条，后来的不许顶掉先前的",
    file: "apps/control-plane-ui/lib/project-event-store.mjs",
    check: "verifyCorruptEventLinesAreReported",
    from: "  if (!eventLogFaults.has(cause)) eventLogFaults.set(cause, text);",
    to: "  eventLogFaults.clear(); eventLogFaults.set(cause, text);",
    expect: "只报了后撞上的那条成因"
  },
  {
    name: "系统规则一条不剩要当成故障说，不能与业务规则共用一句「暂无规则」",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: '          || (category === "system"',
    to: "          || (false",
    expect: "一条系统规则都没有时要当成故障说"
  },
  {
    name: "没传 emptyText 的表在加载失败时不许说「暂无数据」",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: '${esc(options.emptyText || (lastError ? "这张表没能加载出来（原因见页面顶部的横幅）—— 不是「一条都没有」" : "暂无数据"))}',
    to: '${esc(options.emptyText || "暂无数据")}',
    expect: "加载失败时也不许说「暂无数据」"
  },
  {
    name: "项目设置页三块配置为空时必须自己说话",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "  const cfgEmpty = (list, text) => (Array.isArray(list) && list.length)",
    to: "  const cfgEmpty = (list, text) => (true)",
    expect: "没配仓库时要说清空着会怎样"
  },
  {
    name: "高频免留痕登记要有过期校验",
    file: "scripts/contract-check.mjs",
    check: "verifyGuardedWritesAreAudited",
    from: "  const staleExcuses = Object.keys(HIGH_FREQUENCY_NO_AUDIT).filter((path) => !excused.has(path));",
    to: "  const staleExcuses = Object.keys(HIGH_FREQUENCY_NO_AUDIT).filter((path) => !excused.has(path) || true);",
    expect: "登记要摘掉"
  },
  {
    name: "同步豁免登记指向的判据函数必须还在",
    file: "scripts/contract-check.mjs",
    check: "verifyGatesDoNotCloneFromTheNetwork",
    from: "    verifySkillSourceRetireCascades:",
    to: "    verifySkillSourceRetireCascadesGone:",
    expect: "登记过期了"
  },
  {
    name: "白名单免列登记的前缀必须还真的出现在被测代码里",
    file: "scripts/contract-check.mjs",
    check: "verifyWhitelistRefusalsCarryTheWhitelist",
    from: '    "Unknown tool: ": "工具表 85 个',
    to: '    "Unknown toolX: ": "工具表 85 个',
    expect: "登记过期了"
  },
  {
    name: "登记为「只给机器看」的字段，界面一旦读了就该摘登记",
    file: "scripts/contract-check.mjs",
    check: "verifyServerFieldsReachThePerson",
    from: '    method: "404 回显调用方自己发的方法，给直接调接口的人/agent 排障用；控制台横幅另有 requestPath",',
    to: '    method: "404 回显调用方自己发的方法",\n    path: "同上，404 回显的请求路径",',
    expect: "真的读了它们"
  },
  {
    name: "登记册里已不存在的字段要被逮出来（否则它替同名新字段永久豁免）",
    file: "scripts/contract-check.mjs",
    check: "verifyServerFieldsReachThePerson",
    from: '    retryable: "重试建议，agent 运行时据此决定要不要退避",',
    to: '    retryable: "重试建议，agent 运行时据此决定要不要退避",\n    zzzGoneField: "早就不存在了",',
    expect: "已经不在任何拒绝报文里"
  },
  {
    name: "init 第一步失败不许抛裸栈（新人装第一次读的就是这几行）",
    file: "scripts/init-control-plane.mjs",
    check: "verifyInitFailsWithWordsNotAStackTrace",
    from: "try {\n  mkdirSync(runtimeDir, { recursive: true });\n} catch (error) {",
    to: "if (false) {\n  mkdirSync(runtimeDir, { recursive: true });\n} else if (mkdirSync(runtimeDir, { recursive: true })) {",
    expect: "抛的是裸栈"
  },
  {
    name: "init 失败要说清本机现在是什么状态",
    file: "scripts/init-control-plane.mjs",
    check: "verifyInitFailsWithWordsNotAStackTrace",
    from: '  console.error("  · 这一步之前没有写过任何东西；排掉原因后重跑 npm run init 即可，不需要先清理");',
    to: '  console.error("  · 排掉原因后重跑");',
    expect: "本机现在是什么状态"
  },
  {
    name: "装机失败出口要交代本机被改成什么样了",
    file: "scripts/install-agent.sh",
    check: "verifyInstallScriptSaysWhatItLeftBehind",
    from: '  printf \'%s\\n\' "  · 装好 Node 20+ 后重跑这条安装命令即可；本机什么都没有被安装" >&2',
    to: '  printf \'%s\\n\' "  · 装好 Node 20+ 后重跑这条安装命令即可" >&2',
    expect: "没说清本机被改成什么样"
  },
  {
    name: "finally 里不许有不受守卫的 throw（会盖掉真正的失败原因）",
    file: "scripts/doctor.mjs",
    check: "verifyFinallyBlocksDoNotMaskFailures",
    from: '  if (!mainBodyCompleted) {\n    console.error("  --  主体断言已经失败，登录限流这一组本轮跳过（跑它只会用新的错误盖掉真正的原因）");\n  } else {',
    to: "  {",
    expect: "不受守卫的 throw"
  },
  {
    name: "finally 提取脱节要自报空转",
    file: "scripts/contract-check.mjs",
    check: "verifyFinallyBlocksDoNotMaskFailures",
    from: "for (const match of text.matchAll(/\\}\\s*finally\\s*\\{/gu)) {",
    to: "for (const match of text.matchAll(/\\}\\s*finallyX\\s*\\{/gu)) {",
    expect: "本条在空转"
  },
  {
    // 审计链断掉＝篡改检测作废。这条判据此前一直在空转：探针只写一条记录，
    // 而链校验在"少于两条"时恒真 —— 把 prevHash 改成常量它照样绿。
    name: "审计链断掉要被逮到（prevHash 必须接上一条）",
    file: "apps/control-plane-ui/lib/audit-ledger.mjs",
    check: "verifyMcpWritesLandInTheMainAuditLedger",
    from: '    prevHash: state.auditLog[0]?.rowHash || state.auditChainHead || "sha256:genesis"',
    to: '    prevHash: "sha256:genesis"',
    expect: "没有接上 prevHash 链"
  },
  {
    name: "台账不足两条时要自报空转（链校验在那时恒真）",
    file: "scripts/contract-check.mjs",
    check: "verifyMcpWritesLandInTheMainAuditLedger",
    from: "await handleMcpJsonRpc({\n  jsonrpc: \"2.0\", id: 2, method: \"tools/call\",",
    to: "if (false) await handleMcpJsonRpc({\n  jsonrpc: \"2.0\", id: 2, method: \"tools/call\",",
    expect: "链校验在空转"
  },
  {
    // 规则状态认不出来时原先【默认成 active】：把 disabled 打错一个字母，那条规则不是被停用
    // 而是照旧生效，而人以为自己关掉了它。安全规则上"以为关了其实没关"是最坏的一种默认。
    name: "认不出的规则状态必须拒绝，不许默认成生效",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: '    if (rule.status !== undefined && !RULE_STATUSES.includes(rule.status)) return "rule_status_unknown";',
    to: "    void 0;",
    expect: "规则状态认不出来必须被拒"
  },
  {
    name: "认不出的规则状态被拒时要给出合法清单",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: '        ...(ruleErr === "rule_status_unknown" ? {allowedStatuses: RULE_STATUSES} : {})});\n    }\n    const guard = beginGuardedWrite(req, state, "project_config_update"',
    to: '        ...({})});\n    }\n    const guard = beginGuardedWrite(req, state, "project_config_update"',
    expect: "没给出合法的状态清单"
  },
  {
    // 任务组上选的统一语言必须真的传到 agent 的技能工作集里，否则界面上选了日语、
    // 执行方照旧按默认语言干活，而两边都不会报错。
    name: "任务组选的语言必须传到 agent（不许写死）",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyAgentGatewayContracts",
    from: "  const languagePolicy = normalizeTaskGroupLanguagePolicy(contract.languagePolicy);",
    to: '  const languagePolicy = normalizeTaskGroupLanguagePolicy({languageTag: "en"});',
    expect: "did not carry the task-group language policy"
  },
  {
    name: "加入令牌不存在时不得放行",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyAgentJoinTokenIsSpentExactlyOnce",
    from: "  if (!record) throw gatewayError(\"join_token_invalid\", 401);",
    to: "  if (!record) return {nodeToken: \"x\"};",
    expect: "编造的令牌拿到的不是 join_token_invalid"
  },
  {
    name: "用过的加入令牌不得再兑一台节点",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyAgentJoinTokenIsSpentExactlyOnce",
    from: "  if (record.status === \"consumed\") throw gatewayError(\"join_token_consumed\", 409, {tokenStatus: record.status});",
    to: "  if (false) throw gatewayError(\"join_token_consumed\", 409, {tokenStatus: record.status});",
    expect: "已经兑换过的令牌拿到的不是 join_token_consumed"
  },
  {
    name: "过期令牌第二次也要照实说过期",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyAgentJoinTokenIsSpentExactlyOnce",
    from: "  if (record.status === \"expired\") throw gatewayError(\"join_token_expired\", 401, {tokenStatus: record.status});",
    to: "  if (false) throw gatewayError(\"join_token_expired\", 401, {tokenStatus: record.status});",
    expect: "第二次拿同一张过期令牌拿到的不是 join_token_expired"
  },
  {
    name: "指名给某台机器的加入令牌不得被别人用",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyAgentJoinTokenIsSpentExactlyOnce",
    from: "  if (record.expectedNodeName && record.expectedNodeName !== nodeName) throw gatewayError(\"join_token_node_name_mismatch\", 403);",
    to: "  if (false) throw gatewayError(\"join_token_node_name_mismatch\", 403);",
    expect: "指名给别人的令牌拿到的不是 join_token_node_name_mismatch"
  },
  {
    name: "提交之后工作树必须复查一次",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutorBackedWorkerRefusesUnsafeOutput",
    from: "  if (gitStatusPaths(root).length) throw new Error(\"agent_runtime_executor_uncommitted_changes_after_commit\");",
    to: "  if (false) throw new Error(\"agent_runtime_executor_uncommitted_changes_after_commit\");",
    expect: "agent_runtime_executor_uncommitted_changes_after_commit"
  },
  {
    name: "推完必须核对远端 SHA（执行器）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutorBackedWorkerRefusesUnsafeOutput",
    from: "  if (remoteSha !== commit) throw new Error(\"agent_runtime_executor_push_remote_sha_mismatch\");",
    to: "  if (false) throw new Error(\"agent_runtime_executor_push_remote_sha_mismatch\");",
    expect: "agent_runtime_executor_push_remote_sha_mismatch"
  },
  {
    name: "推完必须核对远端 SHA（本地工作器）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyLocalGitWorkerRefusesUnsafeRepositoryState",
    from: "  if (remoteSha !== commit) throw new Error(\"agent_runtime_push_remote_sha_mismatch\");",
    to: "  if (false) throw new Error(\"agent_runtime_push_remote_sha_mismatch\");",
    expect: "agent_runtime_push_remote_sha_mismatch"
  },
  {
    name: "产出一字未变时不得算作干完了活",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyLocalGitWorkerRefusesUnsafeRepositoryState",
    from: "        return {valid: false, status: 409, error: \"artifact_output_ref_not_changed_in_commit\",",
    to: "        return {valid: false, status: 409, error: \"artifact_output_ref_not_changed_in_commit_x\",",
    expect: "也被当成干完了活"
  },
  {
    name: "执行器声称改了的文件必须真的变过",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutorBackedWorkerRefusesUnsafeOutput",
    from: "  if (missingDeclaredChanges.length) throw new Error(`agent_runtime_executor_declared_unchanged_paths:${missingDeclaredChanges.slice(0, 5).join(\",\")}`);",
    to: "  if (false) throw new Error(`agent_runtime_executor_declared_unchanged_paths:${missingDeclaredChanges.slice(0, 5).join(\",\")}`);",
    expect: "一行都没改却上报成功"
  },
  {
    name: "中央态不得被写回存储",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    check: "verifyRuntimeJsonConflict",
    from: "  if (state && state.__centralOnly) {",
    to: "  if (false) {",
    expect: "拿中央态写回存储没有被拒"
  },
  {
    name: "技能集只发给认领了这次派发的那个节点",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyAgentGatewayContracts",
    from: "  if (!dispatch) throw gatewayError(\"skill_workset_not_found\", 404);",
    to: "  const dispatchOr = dispatch || (state.agentDispatches || [])[0];\n  if (!dispatchOr) throw gatewayError(\"skill_workset_not_found\", 404);",
    expect: "能下载技能集"
  },
  {
    name: "定稿不得提交卡片上没有的选项",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanCollaborationEntryPointsRefuseEmptyInput",
    from: "  if (!option) throw Object.assign(new Error(\"human_confirmation_option_invalid\"), {status: 400});",
    to: "  if (!option) return {ok: true};",
    expect: "卡片上没有的选项"
  },
  {
    name: "没有任务合同的会话不得跑执行器",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutorBackedWorkerRefusesUnsafeOutput",
    from: "  if (!contract) throw new Error(\"task_contract_missing_for_executor\");",
    to: "  if (!contract) return {ok: true};",
    expect: "task_contract_missing_for_executor"
  },
  {
    name: "执行器启动前工作树必须干净",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutorBackedWorkerRefusesUnsafeOutput",
    from: "  if (gitStatusPaths(root).length) throw new Error(\"agent_runtime_executor_requires_clean_worktree\");",
    to: "  if (false) throw new Error(\"agent_runtime_executor_requires_clean_worktree\");",
    expect: "agent_runtime_executor_requires_clean_worktree"
  },
  {
    name: "执行器吐的不是 JSON 时必须拒",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutorBackedWorkerRefusesUnsafeOutput",
    from: "    throw new Error(\"agent_runtime_executor_output_not_json\");",
    to: "    output = {};",
    expect: "agent_runtime_executor_output_not_json"
  },
  {
    name: "执行器必须交出产出清单",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutorBackedWorkerRefusesUnsafeOutput",
    from: "  if (!Array.isArray(output.artifactManifestRefs) || output.artifactManifestRefs.length === 0) throw new Error(\"agent_runtime_executor_missing_artifact_manifest_refs\");",
    to: "  if (false) throw new Error(\"agent_runtime_executor_missing_artifact_manifest_refs\");",
    expect: "agent_runtime_executor_missing_artifact_manifest_refs"
  },
  {
    name: "执行器的产出必须落在白名单内",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutorBackedWorkerRefusesUnsafeOutput",
    from: "    if (!canUseGitPath(outputPath) || !pathMatchesAllowlist(outputPath, target.pathAllowlist || [])) throw new Error(\"agent_runtime_executor_output_outside_allowlist\");",
    to: "    if (false) throw new Error(\"agent_runtime_executor_output_outside_allowlist\");",
    expect: "agent_runtime_executor_output_outside_allowlist"
  },
  {
    name: "工作树不干净时不得替人提交",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyLocalGitWorkerRefusesUnsafeRepositoryState",
    from: "  if (gitStatusPaths(root).length) throw new Error(\"agent_runtime_worker_requires_clean_worktree\");",
    to: "  if (false) throw new Error(\"agent_runtime_worker_requires_clean_worktree\");",
    expect: "工作树里有没提交的改动"
  },
  {
    name: "产出路径必须落在白名单内",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyLocalGitWorkerRefusesUnsafeRepositoryState",
    from: "  if (!pathMatchesAllowlist(outputPath, target.pathAllowlist || [])) throw new Error(\"agent_runtime_output_outside_allowlist\");",
    to: "  if (false) throw new Error(\"agent_runtime_output_outside_allowlist\");",
    expect: "白名单不含产出目录"
  },
  {
    name: "清单路径必须落在白名单内",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyLocalGitWorkerRefusesUnsafeRepositoryState",
    from: "  if (!pathMatchesAllowlist(manifestPath, target.pathAllowlist || [])) throw new Error(\"artifact_manifest_outside_allowlist\");",
    to: "  if (false) throw new Error(\"artifact_manifest_outside_allowlist\");",
    expect: "清单路径落在白名单之外"
  },
  {
    name: "确认单必须有问题正文",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanCollaborationEntryPointsRefuseEmptyInput",
    from: "  if (!summary) throw Object.assign(new Error(\"human_confirmation_question_required\"), {status: 400});",
    to: "  if (false) throw Object.assign(new Error(\"human_confirmation_question_required\"), {status: 400});",
    expect: "没有问题正文的确认单"
  },
  {
    name: "确认单必须至少有一个选项",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanCollaborationEntryPointsRefuseEmptyInput",
    from: "  if (!aiOptions.length) throw Object.assign(new Error(\"human_confirmation_options_required\"), {status: 400});",
    to: "  if (false) throw Object.assign(new Error(\"human_confirmation_options_required\"), {status: 400});",
    expect: "一个选项都没有的确认单"
  },
  {
    name: "人工指令必须属于某个项目",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanCollaborationEntryPointsRefuseEmptyInput",
    from: "  if (!projectId) throw Object.assign(new Error(\"human_directive_project_required\"), {status: 400});",
    to: "  if (false) throw Object.assign(new Error(\"human_directive_project_required\"), {status: 400});",
    expect: "不属于任何项目的人工指令"
  },
  {
    name: "自由文本指令必须有内容",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanCollaborationEntryPointsRefuseEmptyInput",
    from: "  if (!instruction && directiveType === \"free_text\") throw Object.assign(new Error(\"human_directive_instruction_required\"), {status: 400});",
    to: "  if (false) throw Object.assign(new Error(\"human_directive_instruction_required\"), {status: 400});",
    expect: "没有内容的人工指令"
  },
  {
    name: "AI 的分析意见必须有正文",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanCollaborationEntryPointsRefuseEmptyInput",
    from: "  if (!summary) throw Object.assign(new Error(\"ai_analysis_summary_required\"), {status: 400});",
    to: "  if (false) throw Object.assign(new Error(\"ai_analysis_summary_required\"), {status: 400});",
    expect: "没有正文的分析意见"
  },
  {
    name: "人已处理完的卡片不得再收 AI 分析",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanCollaborationEntryPointsRefuseEmptyInput",
    from: "  if (request.status !== \"pending\") throw Object.assign(new Error(\"human_confirmation_not_pending\"), {status: 409});",
    to: "  if (false) throw Object.assign(new Error(\"human_confirmation_not_pending\"), {status: 409});",
    expect: "还能被 AI 追加分析"
  },
  {
    name: "界面说生产可点时服务端不得偷偷拦掉",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyWipeWarningMatchesTheServerGuard",
    from: "  if (req.method === \"POST\" && url.pathname === \"/api/bootstrap/init\") {",
    to: "  if (req.method === \"POST\" && url.pathname === \"/api/bootstrap/init\") {\n    if (executionProfile === \"production\") return json(res, 409, {error: \"not_here\"});",
    expect: "而服务端已经按 executionProfile 拦住了"
  },
  {
    name: "界面承诺的打字确认门必须真的在",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyWipeWarningMatchesTheServerGuard",
    from: "        error: \"bootstrap_init_requires_explicit_confirmation\",",
    to: "        error: \"bootstrap_init_needs_nothing\",",
    expect: "那道确认门不见了"
  },
  {
    name: "界面承诺看工作量时服务端不得退回只数三集合",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyWipeWarningMatchesTheServerGuard",
    from: "      || grownCollections.length > 0 || grownWorkItems;",
    to: "      ;",
    expect: "服务端已经不看这些了"
  },
  {
    name: "确认单的定稿表单必须按组判权",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: '      ${hasGroupPerm(request.taskGroupId, "task_group:review") ? `<form class="form-grid" data-form="hcr-decide"',
    to: '      ${canReview ? `<form class="form-grid" data-form="hcr-decide"',
    expect: "别人那张也有"
  },
  {
    name: "关闭任务组按钮必须按行判权",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: '    (barrier.satisfied && hasGroupPerm(barrier.taskGroupId, "task_group:control")',
    to: "    (barrier.satisfied && canCloseTaskGroup",
    expect: "按钮出现了 2 个"
  },
  {
    name: "人工指令的目标任务组下拉必须按权限过滤",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: '${taskGroupSelector(directiveTaskGroupId, "directive-tg", "task_group:control")}',
    to: '${taskGroupSelector(directiveTaskGroupId, "directive-tg")}',
    expect: "下拉列出了没有控制权的任务组"
  },
  {
    name: "任务组列表的控制按钮必须按组判权",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: '${hasGroupPerm(taskGroup.id, "task_group:control") ? `<button class="secondary-button" data-action="task-control"',
    to: '${canControl ? `<button class="secondary-button" data-action="task-control"',
    expect: "别人那段也有"
  },
  {
    name: "被裁字段的豁免必须可核（读取点确实来自声明的来源）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "specs",
    from: "  const analysis = progressData.taskAnalysis;",
    to: "  const analysis = progressData.taskAnalysis; const stray = tgDetail.taskAnalysis;",
    expect: "实际还有 tgDetail 这样的读取点"
  },
  {
    name: "内容包 git 引用名必须先判安全",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentRuntimeGuardsRefuseRealAttacks",
    from: 'if (ref.startsWith("-") || ref.includes("..") || /[\\s^~:?*[\\\\]/u.test(ref)) {',
    to: "if (false) {",
    expect: "引用名以横杠开头时拿到的是"
  },
  {
    name: "产出清单不得写到仓库之外",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentRuntimeGuardsRefuseRealAttacks",
    from: 'if (!inside(repositoryRoot, target)) throw new Error("artifact_manifest_path_escapes_repository',
    to: 'if (false) throw new Error("artifact_manifest_path_escapes_repository',
    expect: "产出清单的路径爬到仓库之外却没被拦下"
  },
  {
    name: "根本不像状态的中央态必须拒读（否则下一次写入把空的落盘）",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    check: "verifyStateFilesRefuseUnknownSchemaVersions",
    from: "  if (!declared && looksLikeState) return state;",
    to: "  if (!declared) return state;",
    expect: "却照读不误"
  },
  {
    // 心跳早就超过判死阈值时，行上不许还写着「在线」—— status 只有扫描跑过才翻成 offline，
    // 而扫描挂在编排拍上；真实运行态上读到过【在线 + 已 175 分钟没有心跳】同行并排。
    name: "心跳超时的节点不许还显示在线",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "    `${heartbeatTimedOut(node)",
    to: "    `${false",
    expect: "行上不许还写着「在线」"
  },
  {
    // 类型写错（该字符串的给了数组）不许把服务端打成 500：手写校验最容易在 trim/map/length 上当场抛。
    name: "字段类型写错不得让服务端 5xx",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: '  const missing = fields.filter((field) => !String(body?.[field] ?? "").trim());',
    to: "  const missing = fields.filter((field) => !body?.[field]?.trim());",
    expect: "收到【类型写错】的字段就 5xx"
  },
  {
    // 组织这一层同形，爆炸半径更大：停用会级联停掉名下所有在跑的执行。
    name: "改组织状态的缺省不得等于启用",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: '    if (!["active", "suspended"].includes(String(body.status || ""))) {',
    to: "    if (false) {",
    expect: "缺省不得等于启用"
  },
  {
    // 空 body 打到「改成员状态」上原先会置成 active —— 一个被停用的账号就这么被静默恢复。
    name: "改成员状态的缺省不得等于启用",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: '    if (!["active", "disabled"].includes(String(body.status || ""))) {',
    to: "    if (false) {",
    expect: "一个字段都不给】也成功了"
  },
  {
    // 带 id 的那批路由要用【真 id】才扫得到，取不到 id 就只是在验 404。
    name: "带 id 的空 body 扫描要用真 id（不许退化成验 404）",
    file: "scripts/doctor.mjs",
    gate: "doctor",
    from: '        const chunks = literal.replace(/\\(\\?:([^|)]+)\\|[^)]*\\)/gu, "$1").split("([^/]+)");',
    to: "        const chunks = [literal];",
    expect: "只解析出 0 条"
  },
  {
    // 空 body 打过去照样 201：凭空给种子账号发一份授权。同族还有铸账号、挂审批单、建产物记录。
    name: "发授权必须点名主体与资源（不许替人挑一个）",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: '    if (requireBodyFields(res, body, ["subjectId", "resourceId"], "access_grant_subject_and_resource_required")) return;',
    to: "    void requireBodyFields;",
    expect: "一个字段都不给】也成功了"
  },
  {
    // 「少填了一个字段」不该报成「系统坏了」：原先落进通用出口成了 500 server_error，
    // 真实原因埋在 message 里 —— 监控当事故、人去查服务端日志，而他要做的只是补上 projectId。
    name: "缺 projectId 的加入令牌请求不得报成 500",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    gate: "doctor",
    from: '  if (!tokenProject) throw gatewayError("join_token_project_not_found", 404, {projectId: projectId || null});',
    to: '  if (!tokenProject) throw new Error("join_token_project_not_found");',
    expect: "收到空 body 就 5xx"
  },
  {
    // 刚装完那条横幅要指【这个账号菜单里有的那一页】：系统管理员的入口在「账号与授权」，
    // 组织管理员才在「AI 智能体」。指错的话，照着做的人在自己的菜单里找一个不存在的入口。
    name: "刚装完的指路要指这个账号点得到的那一页",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: '    system: "「账号与授权」页的「智能体入网令牌」面板",',
    to: '    system: "「AI 智能体」页的「加入令牌管理」面板",',
    expect: "而这一屏的导航里没有这几页"
  },
  {
    name: "够不着的审核卡要说清是哪个任务组不给你动",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: '          </form>` : noRightOnThisGroup(item.taskGroupId, "人工审核（审批）")}',
    to: '          </form>` : ""}',
    expect: "只有 2 张说了"
  },
  {
    name: "任务组一览的受阻数要说出被挡住的派发",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: '      return stuck ? `${blocked} <span class="warn-text">· 派发被挡 ${stuck}</span>` : String(blocked);',
    to: "      return String(blocked);",
    expect: "行上要说出来"
  },
  {
    name: "已了结的派发不许说「还没被领走」",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "      : terminalDispatchStatuses.has(dispatch.status)",
    to: "      : false",
    expect: "已了结的派发不许说"
  },
  {
    name: "「上一次加载成功」要按页记",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "  const at = pageLoadedAt[page];",
    to: "  const at = lastLoadedAt;",
    expect: "从没加载成功过的页不许说"
  },
  {
    // 发件箱里那份检查点声称的提交在远端没了（别人强推／分支重置／镜像回滚）：必须在【重放之前】
    // 认出来，挪进恢复区并报回控制面。拆掉之后重放会继续往下走、控制面回 404 —— 而 404 同样算
    // 终局错误，同一个码照样出现，所以判据点的是【具体那句原因】而不只是码（只判码时实测不红）。
    name: "重放前必须认出「推上去的提交在远端没了」",
    file: "apps/agent-runtime/runtime.mjs",
    gate: "agent",
    from: "    throw new Error(`checkpoint_replay_recover_required:已推送的提交在远端 ${pushRef.ref} 上找不到了`);",
    to: "    return;",
    expect: "没有在【重放之前】认出来"
  },
  {
    // 推上去之后远端不是我推的那个（并发强推／镜像同步拨回去／服务端钩子改写引用）。
    // agent 不发现的话，它会带着"已推送"的检查点回去，而那份产出并不在远端。
    // 拆掉这一道之后控制面会在检查点上回 push_ref_must_point_to_final_commit —— 第二道门。
    name: "推完必须核对远端就是自己推的那个",
    file: "apps/agent-runtime/runtime.mjs",
    gate: "agent",
    from: '  if (remoteSha !== commit) throw new Error("push_verification_failed:推上去之后远端的提交与本地对不上");',
    to: '  if (false) throw new Error("push_verification_failed:推上去之后远端的提交与本地对不上");',
    expect: "agent 没有发现"
  },
  {
    // 只写了产物清单、没有任何任务输出：比"一个字都没改"更隐蔽（git 看得到改动、提交也能成，
    // 而提交里除了 agent 自己要写的那份清单什么都没有）。拆掉这一道之后控制面会在检查点上
    // 回 artifact_manifest_missing_output_refs —— 断言点的是具体哪个码，所以照样红。
    name: "只写产物清单没有任务输出必须判失败",
    file: "apps/agent-runtime/runtime.mjs",
    gate: "agent",
    from: '  if (!outputRefs.length) throw new Error("executor_produced_no_output:除了产物清单没有任何任务输出");',
    to: '  if (false) throw new Error("executor_produced_no_output:除了产物清单没有任何任务输出");',
    expect: "没有报出 executor_produced_no_output"
  },
  {
    // 执行器跑完一个字都没改＝模型空转（额度烧了、活没动）。它必须被判成失败并如实报回控制面，
    // 而不是当成做完了去提交一个空 commit。拆掉这一道之后会落到下一道（no_output），
    // 断言点的是【具体是哪一个码】，所以照样红。
    name: "执行器一个字都没改必须判失败",
    file: "apps/agent-runtime/runtime.mjs",
    gate: "agent",
    from: '  if (!changedBeforeManifest.length) throw new Error("executor_produced_no_changes:仓库里一个文件都没改");',
    to: '  if (false) throw new Error("executor_produced_no_changes:仓库里一个文件都没改");',
    expect: "没有报出 executor_produced_no_changes"
  },
  {
    name: "开工前工作树不干净必须拒绝开工",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentRuntimeGuardsRefuseRealAttacks",
    from: '  if (gitStatusPaths(root).length) throw new Error("agent_worktree_not_clean',
    to: '  if (false) throw new Error("agent_worktree_not_clean',
    expect: "却照常开工"
  },
  {
    name: "派发的模型决策三样缺一都不许开工",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentRuntimeGuardsRefuseRealAttacks",
    from: "  if (!model.modelDecision || !(model.model || model.modelId) || !(model.reasoning || model.reasoningLevel)) {",
    to: "  if (!model.modelDecision) {",
    expect: "派发的模型决策"
  },
  {
    name: "ollama 没有模型名不得把空名交给它猜",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentRuntimeGuardsRefuseRealAttacks",
    from: '    if (!ollamaModel) throw new Error("executor_model_id_required',
    to: '    if (false) throw new Error("executor_model_id_required',
    expect: "应当明确说缺什么"
  },
  {
    // 判据侧：没分类的动作要被拦下来（模板串 `task_group_${action}` 这一支也要看得见）。
    name: "受守卫的写动作必须逐个回答过机器能不能做",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyEveryGuardedActionIsClassified",
    from: '  "task_group_cancel", "task_group_abort",',
    to: '  "task_group_cancel",',
    expect: "没有回答过「机器主体能不能做」"
  },
  {
    // 行为侧：把一条真实路由的动作名改成没登记的，请求当场 403。
    // 这条证的是"缺省不放行"本身 —— 原先那句 `return true` 下，改名之后一切照跑。
    name: "没登记过的写动作一律拒绝（不是默认交给机器）",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: 'beginGuardedWrite(req, state, "orchestrator_run", `TaskGroup:${body.taskGroupId || "all"}`',
    to: 'beginGuardedWrite(req, state, "orchestrator_run_unregistered", `TaskGroup:${body.taskGroupId || "all"}`',
    expect: "orchestrator permission"
  },
  {
    // 备份脚本的承诺是"拷完按索引核一遍"。拿掉核对之后，对着一份明知残缺的运行目录它也会报成功 ——
    // 而运维要到还原那一刻才发现这份备份用不了。
    name: "备份脚本必须真的核对拷出来那份",
    file: "scripts/backup-runtime.mjs",
    gate: "crash",
    from: "  lastProblems = verify(target);",
    to: "  lastProblems = [];",
    expect: "对着一份残缺的运行目录必须拒绝"
  },
  {
    // 只拷了中央文件、漏掉 project-db 的"半份备份"必须报出来。原先整目录不在时读取端直接返回
    // 空数组，控制面带着一份没有任何项目数据的状态照常起来、健康检查还回 ok。
    name: "只拷了一半的备份必须报出来",
    file: "apps/control-plane-ui/server.mjs",
    gate: "crash",
    from: "  const shardFault = projectShardStorageFault({root, runtimeDir, statePath, seedPath, buildInitialState}, state);",
    to: "  const shardFault = null;",
    expect: "不许带着空项目照常起来"
  },
  {
    // 写侧的跨租户：授权必须比对【入参里的作用域】。拆掉这一句，绑在项目 A 上的节点
    // 拿隔壁项目的 id 就能写进去（实测 26 个写工具真的执行了，隔壁记录 1→25 条）。
    name: "授权必须比对入参的作用域（写侧跨租户）",
    file: "apps/mcp-server/server.mjs",
    check: "verifyBoundedNodeCannotWriteIntoAnotherProject",
    from: "    const scopedGrants = activeGrants.filter((grant) => grantMatchesArgs(state, grant, args));",
    to: "    const scopedGrants = activeGrants;",
    expect: "拿【隔壁项目】的 id 调这些写工具居然执行了"
  },
  {
    // 没点名对象也照答的那几个只读工具，回答里必须说清答的是谁。
    name: "默认答的工具要说清答的是哪一个对象",
    file: "apps/mcp-server/server.mjs",
    check: "verifyEveryMcpToolAnswersAnEmptyCall",
    from: '      return boundedTaskGroupGuard(state, args, context) || computeCloseBarrier(state, args.taskGroupId || "tg_runtime_management", args);',
    to: '      return boundedTaskGroupGuard(state, args, context) || {ok: true, note: "no object"};',
    expect: "没说】它答的是哪一个"
  },
  {
    // 写/决策类工具绝不许在一个参数都不给时成功 —— 「缺省即批准」最贵的那一种。
    // 这条变异把只读标记整体翻掉，等于宣称那 19 个空参也答的工具都是写工具。
    name: "空参也能答的必须都是只读工具",
    file: "apps/mcp-server/server.mjs",
    check: "verifyEveryMcpToolAnswersAnEmptyCall",
    from: "      readOnlyHint: isReadOnlyTool(name),",
    to: "      readOnlyHint: false,",
    expect: "却在一个参数都不给时成功了"
  },
  {
    // 轮询探路那条路只读，所以拿缓存里那份原样用（2MB 状态省掉每请求 4.84ms 的克隆）。
    name: "轮询探路不得退回每请求克隆整份状态",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    check: "verifyPollingPeekDoesNotCloneOrMutate",
    from: "  return options.shared ? entry.value : structuredClone(entry.value);",
    to: "  return structuredClone(entry.value);",
    expect: "那就是还在克隆"
  },
  {
    // 写完只让缓存失效，不再顺手填一份（填一份要克隆两次整份状态）。
    name: "写完不得再克隆整份状态去填缓存",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    check: "verifyStateWriteDoesNotCloneTheWorld",
    from: "    centralStateCache.clear();",
    to: "    cacheStoredState(centralStateCache, options.statePath, centralState, statCacheKey(options.statePath));",
    expect: "克隆了 3 次整份状态"
  },
  {
    // 冻的只能是【留在缓存里那一份】。把冻结的原件递给会改它的调用方，健康检查一进门就
    // "Cannot assign to read only property" —— 这一次是崩溃一致性门先抓到的，太贵了，钉进契约门。
    name: "冻结的那份不得递给会改它的调用方",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    check: "verifyPollingPeekDoesNotCloneOrMutate",
    from: "    if (!readOptions.shared) return structuredClone(central);",
    to: "    if (false) return structuredClone(central);",
    expect: "拿到的是【冻结】的那一份"
  },
  {
    // 共用出去的那份必须是冻的：谁写它一笔，污染的是此后所有人的读。
    name: "共用出去的中央态必须冻结",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    check: "verifyPollingPeekDoesNotCloneOrMutate",
    from: "    deepFreeze(central);",
    to: "    void deepFreeze;",
    expect: "没有被冻结"
  },
  {
    // 落盘策略按写入种类分：日志必须按次 fsync（唯一的事实来源）。
    // 这条变异在它前面插一句 return —— 源码里那行 fsyncSync 还在，所以"搜源码"型的判据骗得过，
    // 真数一遍就骗不过（判据把模块复制一份、把 fsyncSync 换成记账壳来数）。
    name: "事件日志必须按次 fsync",
    file: "apps/control-plane-ui/lib/project-event-store.mjs",
    check: "verifyEventIndexRebuildKeepsItsPromises",
    from: '  if (process.env.AIMAC_PROJECT_EVENT_FSYNC === "false") return;\n  const fd = openSync(path, "r");',
    to: '  return;\n  const fd = openSync(path, "r");',
    expect: "没有对日志按过 fsync"
  },
  {
    name: "派生文件不得按次 fsync（每次追加 7ms→24ms）",
    file: "apps/control-plane-ui/lib/project-event-store.mjs",
    check: "verifyEventIndexRebuildKeepsItsPromises",
    from: "  }, {durable: false});   // 派生数据：崩了退到索引与日志扫描",
    to: "  });",
    expect: "对派生文件按了"
  },
  {
    name: "段清单不得被标成派生数据",
    file: "apps/control-plane-ui/lib/project-event-store.mjs",
    check: "verifyEventIndexRebuildKeepsItsPromises",
    from: '  appendSafeJson(projectExecutionEventManifestPath(runtimeDir, projectId, {forWrite: true}), {\n    schemaVersion: "project-execution-event-manifest/v1",',
    to: '  appendSafeJson(projectExecutionEventManifestPath(runtimeDir, projectId, {forWrite: true}), {\n    durable: false,\n    schemaVersion: "project-execution-event-manifest/v1",',
    expect: "被标成了派生数据"
  },
  {
    // 重建【从新往旧】扫、攒够淘汰上限就停。方向反过来就会把最新那段漏掉 ——
    // 序号上界随之算小，下一条事件重用已经用过的号。
    name: "索引重建要从最新往回扫（否则序号被重用）",
    file: "apps/control-plane-ui/lib/project-event-store.mjs",
    check: "verifyEventIndexRebuildKeepsItsPromises",
    from: "  for (let index = currentPaths.length - 1; index >= 0; index -= 1) {",
    to: "  for (let index = 0; index < currentPaths.length; index += 1) {",
    expect: "序号被重用"
  },
  {
    name: "重建不得重写已经存在的键文件",
    file: "apps/control-plane-ui/lib/project-event-store.mjs",
    check: "verifyEventIndexRebuildKeepsItsPromises",
    from: "    if (existsSync(projectExecutionEventKeyPath(runtimeDir, event.projectId, event.eventKey))) continue;",
    to: "    if (false) continue;",
    expect: "重写了一遍"
  },
  {
    name: "键文件真丢了时重建要把它补回来",
    file: "apps/control-plane-ui/lib/project-event-store.mjs",
    check: "verifyEventIndexRebuildKeepsItsPromises",
    from: "    writeProjectExecutionEventKey(runtimeDir, event, path);\n  }\n  rebuilt.eventsByKey",
    to: "    void event; void path;\n  }\n  rebuilt.eventsByKey",
    expect: "没被补回来"
  },
  {
    // 策略决策台账里有两种记录形状（REST 守卫写 id、MCP 那条路写 decisionId）。
    // 保留逻辑只认一种的话，被活跃授权引用着的那一半照样被容量挤掉：授权还在、依据没了。
    name: "容量保护要认两种形状的决策 id",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    check: "verifyOutputTargetKeepsItsPolicyDecision",
    from: "  const decisionIdOf = (item) => item.id || item.decisionId;",
    to: "  const decisionIdOf = (item) => item.id;",
    expect: "被容量挤掉了"
  },
  {
    // 问责台账此前【不受任何规范约束】：813 条真实记录一条都没被校验过。
    // 这条变异只改一个字段的类型（既有断言都看不见），规范才管得着。
    name: "审计行的字段类型要被规范钉住",
    file: "apps/control-plane-ui/lib/audit-ledger.mjs",
    gate: "doctor",
    from: "    stateVersion: Number(state.stateVersion || 0),",
    to: "    stateVersion: String(state.stateVersion || 0),",
    expect: "auditLog[0].stateVersion expected integer"
  },
  {
    name: "段清单里记着却不在盘上的事件段必须说出来",
    file: "apps/control-plane-ui/lib/project-event-store.mjs",
    check: "verifySealedEventSegmentsAreNotSilentlyLost",
    from: "      if (!existsSync(path)) {",
    to: "      if (false) {",
    expect: "读出来的事件少了却一声不吭"
  },
  {
    name: "已封存事件段的长度必须比过段清单",
    file: "apps/control-plane-ui/lib/project-event-store.mjs",
    check: "verifySealedEventSegmentsAreNotSilentlyLost",
    from: "  if (segment.size && Number(segment.size) !== stat.size) {",
    to: "  if (false) {",
    expect: "没人比过段清单里记着的字节数"
  },
  {
    name: "已封存事件段的摘要必须真的核过",
    file: "apps/control-plane-ui/lib/project-event-store.mjs",
    check: "verifySealedEventSegmentsAreNotSilentlyLost",
    from: "  if (digestFile(path) !== segment.digest) {",
    to: "  if (false) {",
    expect: "摘要又没人核"
  },
  {
    name: "存储故障归类不得退回写死的码白名单",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyStorageFaultCodesReachTheOperator",
    from: "  /^(control_plane_state_[a-z_]+|project_state_shard_[a-z_]+|unsupported_(?:state|project_shard)_schema_version):(.+)$/u;",
    to: "  /^(control_plane_state_corrupt|project_state_shard_corrupt|project_state_shard_missing):(.+)$/u;",
    expect: "没人认得"
  },
  {
    name: "被认成存储故障的码都要有中文说明",
    file: "apps/control-plane-ui/public/i18n-zh.js",
    check: "verifyStorageFaultCodesReachTheOperator",
    from: '    project_state_shard_identity_mismatch: "索引里记着的项目分片，内容对不上它自己的名字（多半被覆盖过）",',
    to: '    project_state_shard_identity_mismatch_typo: "索引里记着的项目分片，内容对不上它自己的名字（多半被覆盖过）",',
    expect: "却没有它的中文说明"
  },
  {
    name: "索引里记着、摘要却缺席的分片没读到也要拒绝",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    check: "verifyRuntimeJsonConflict",
    from: "    if (!present.has(projectId)) {",
    to: "    if (entry.storagePayloadDigest && !present.has(projectId)) {",
    expect: "摘要却缺席的分片一个都没读到时被放行"
  },
  {
    name: "索引里记着的分片被写成空壳不得静默丢弃",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    check: "verifyRuntimeJsonConflict",
    from: "        if (indexedEntry) throw new Error(`project_state_shard_identity_mismatch:${name}`);",
    to: "        if (false) throw new Error(`project_state_shard_identity_mismatch:${name}`);",
    expect: "被写成空壳后仍被静默接受"
  },
  {
    name: "PostgreSQL 上分片整行被删也必须拒绝开工",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    gate: "docker",
    from: "      throw new Error(`project_state_shard_missing:${projectId}`);",
    to: "      void projectId;",
    expect: "整行被删掉之后控制面照常开工"
  },
  {
    // 这条挂在 docker 门上（要一台真 PostgreSQL）。分片防篡改此前只在 runtime_json 上验过，
    // 而生产用的是 PG —— 那道守卫存在的全部理由就是"有 DB 写权限的人直接改分片行"。
    name: "PostgreSQL 上的分片防篡改必须真的生效",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    gate: "docker",
    from: '  if (stateStoreKind() === "postgresql") assertProjectShardsMatchCentralIndex(shards, centralState);',
    to: "  if (false) assertProjectShardsMatchCentralIndex(shards, centralState);",
    expect: "控制面照读照用"
  },
  {
    name: "种子与编排产出的不受约束集合数也要棘轮住",
    file: "scripts/contract-check.mjs",
    check: "verifySeedRecordsMatchTheirDeclaredSchemas",
    from: '{"种子数据": 4, "编排产出": 7}',
    to: '{"种子数据": 3, "编排产出": 7}',
    expect: "不受规范约束的集合从 3 涨到 4"
  },
  {
    // 「这条断言指不指得出自己守的是哪一处」现在按【运行时记下的真实目标串】核（原先解析本文件源码，
    // 看不见插值拼出来的那 9 条）。记账一断，整道自查就静静地变成"核对了 0 条"。
    name: "断言搜索面自查的记账不得断掉",
    file: "scripts/validate-specs.rb",
    gate: "specs",
    from: "    @probes << needle\n    super",
    to: "    super",
    expect: "这道扫描在空转"
  },
  {
    // 源文件必须经 read_source 读进来，否则它上面的 include? 不会被记账。
    name: "源文件不得绕过 read_source 直接读",
    file: "scripts/validate-specs.rb",
    gate: "specs",
    from: 'console_source = read_source("apps/control-plane-ui/public/app.js")',
    to: 'console_source = File.read(File.join(ROOT, "apps/control-plane-ui/public/app.js"))',
    expect: "没走 read_source"
  },
  {
    name: "不受规范约束的集合数要棘轮住",
    file: "scripts/doctor.mjs",
    gate: "doctor",
    from: "maxUncovered: 18});",
    to: "maxUncovered: 17});",
    // 期望要挑【这道门自己会打印的那一句】：控制面 e2e 的前缀是"控制面 e2e 产出："，
    // 契约门那两处（种子/编排产出）用的是别的前缀 —— 只写公共部分会被判成"挂错了门"。
    expect: "控制面 e2e 产出：不受规范约束的集合"
  },
  {
    name: "运维要用的运行参数不许没写进文档",
    file: "README.md",
    check: "verifyOperatorEnvVarsAreDocumented",
    from: "| `AIMAC_PORT` | `4317` | 监听端口 |",
    to: "",
    expect: "文档里一个字都没写"
  },
  {
    name: "授给 agent 的工具名打错要被查出来",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyGrantedAgentToolsAllExist",
    from: '  "agent-control-mcp.node_probe",',
    to: '  "agent-control-mcp.node_prob",',
    expect: "MCP 侧根本没有它们"
  },
  {
    name: "新长出来的死路由要被查出来",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyEveryRouteHasSomeoneWhoCallsIt",
    from: '  if (req.method === "GET" && url.pathname === "/api/agent-nodes") {',
    to: '  if (req.method === "GET" && url.pathname === "/api/nobody-calls-this") { json(res, 200, {}); return; }\n  if (req.method === "GET" && url.pathname === "/api/agent-nodes") {',
    expect: "没有任何调用方，也没写进文档"
  },
  {
    // 只验这条断言【不是空转】：真实产出里把契约集合清空，它必须报出来。
    // 淘汰那一支在这套 e2e 里走不到（契约数远不到 160），由契约门那条单独守。
    name: "e2e 产出的引用完整性断言不得空转",
    file: "scripts/doctor.mjs",
    gate: "doctor",
    from: "  const contracts = new Set((doctorProducedState.agentTaskContracts || []).map((item) => `${item.sessionId}:${item.runId}`));",
    to: "  const contracts = new Set();",
    expect: "指不到实物的引用"
  },
  {
    name: "agentctl 参数值写错不得静默退回默认",
    file: "scripts/agentctl.mjs",
    gate: "agent",
    from: "    maxUses: parseMaxUses(args[\"max-uses\"])}",
    to: '    maxUses: Number(args["max-uses"] || 1)}',
    // 去掉校验之后它自然就跑去联网了 —— 这一情形下最先报的是「先去联网了」那句。
    expect: "先去联网了"
  },
  {
    name: "agentctl 拒绝参数值时要点名是哪个参数",
    file: "scripts/agentctl.mjs",
    gate: "agent",
    from: "    fail(`--max-uses 认不出：${raw}`,",
    to: "    fail(`这个参数有问题`,",
    expect: "应当场拒绝并点名"
  },
  {
    name: "不许再从任务组上读已被视图剥掉的字段",
    file: "apps/control-plane-ui/public/app.js",
    check: "verifyConsoleDoesNotReadStrippedTaskGroupFields",
    from: "  const roles = (progressData.roles || []).map((role) => `",
    to: "  const roles = (progressData.roles || taskGroup.roles || []).map((role) => `",
    expect: "控制台仍从任务组上读 roles"
  },
  {
    name: "语言标签读错字段会静默回落成中文",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "  const tag = policy?.languageTag;",
    to: "  const tag = policy?.tag;",
    expect: "界面显示的仍是那门语言"
  },
  {
    name: "任务组的角色数必须用服务端给的那个数",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "          <span>角色数：${taskGroup.roleCount ?? 0}</span>",
    to: "          <span>角色数：${(taskGroup.roles || []).length}</span>",
    expect: "界面必须用服务端给的 roleCount"
  },
  {
    name: "只有一页读的大块不许放回视图基底",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyViewDropsCollectionsNobodyReads",
    from: "    // modelCapabilities 不进基底：只有系统设置那一页读它（实测 15.8 KB），而基底意味着",
    to: "    modelCapabilities: sliceItems(scoped.modelCapabilities, capped),\n    // modelCapabilities 不进基底：只有系统设置那一页读它（实测 15.8 KB），而基底意味着",
    expect: "又被放回视图基底了"
  },
  {
    name: "「待你处理」必须按任务组判权而不是并集",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "  const granted = map[taskGroupId] || state.taskGroupPermissionsDefault;",
    to: "  const granted = null;",
    expect: "只算你在【那个任务组】上真有权处置的"
  },
  {
    name: "tasks 视图必须按任务组下发真实权限",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: "    base.taskGroupPermissions = taskGroupPermissions;",
    to: "    void taskGroupPermissions;",
    expect: "没有带 taskGroupPermissions"
  },
  {
    name: "依赖被放弃时必须升级成需要人处置",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyAutoResumeHintsReallyAutoResume",
    from: "        if (abandonedDep) {",
    to: "        if (false) {",
    expect: "它永远等不到验收，又不是 needs_decision"
  },
  {
    name: "失败计数必须真的累加",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutionFailureCapSurvivesHistoryAndReopen",
    from: "  workItem.executionFailureCount = Number(workItem.executionFailureCount || 0) + 1;",
    to: "  workItem.executionFailureCount = 1;",
    expect: "工作项上的计数却是 1"
  },
  {
    name: "agent 上报失败那条路也要记账",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyExecutionFailureCapSurvivesHistoryAndReopen",
    from: '    if (reportedStatus === "failed") noteWorkItemExecutionFailure(state, dispatch);',
    to: "",
    expect: "把派发标成失败时没有记账"
  },
  {
    name: "人重开之后不许按老账把它打回去",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutionFailureCapSurvivesHistoryAndReopen",
    from: "            delete workItem.executionFailureCount;",
    to: "",
    expect: "这个杠杆按了等于没按"
  },
  {
    name: "连续失败计数不得从有上限的派发历史现数",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutionFailureCapSurvivesHistoryAndReopen",
    from: "      const failureCount = Number(workItem.executionFailureCount || 0);",
    to: "      const failureCount = failedRuns.length;",
    expect: "被历史上限顶光之后这条上限就不挡了"
  },
  {
    name: "不许再说「关了自治周期派发就不会被领走」",
    file: "apps/control-plane-ui/public/app.js",
    check: "verifyOrchestratorOffWordingMatchesWhatStillRuns",
    from: "但【已经排队的派发仍会被在线 agent 领走并执行】—— 认领走的是网关，与自治周期无关。",
    to: "派发不会被领走。",
    expect: "控制台仍在说「派发不会被领走」"
  },
  {
    name: "界面读了视图不下发的字段要被查出来",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyConsoleReadsOnlyWhatItsViewDelivers",
    from: "    base.roleSkillCountBySource = roleSkillCountBySource;",
    to: "    void roleSkillCountBySource;",
    expect: "读了它取的那个视图【不下发】的字段"
  },
  {
    name: "字段名打错也要被查出来（不是只认删字段）",
    file: "apps/control-plane-ui/public/app.js",
    check: "verifyConsoleReadsOnlyWhatItsViewDelivers",
    from: "skillSources: runtimeState.skillSources || [],",
    to: "skillSources: runtimeState.skillSourcesTypo || [],",
    expect: "skillSourcesTypo"
  },
  {
    name: "技能源的角色数必须真的下发到那一页",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: '  if (view === "runtime") {',
    to: "  if (false) {",
    expect: "没有带 roleSkillCountBySource"
  },
  {
    name: "概览受阻项为 0 时要说出被挡住的派发",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: 'const stuck = (state.agentDispatches || []).filter((item) => item.status === "blocked").length;',
    to: "const stuck = 0;",
    expect: "概览要把这件事说出来"
  },
  {
    name: "清过期目录不得碰不该碰的东西",
    file: "scripts/lib/stale-runtime-dirs.mjs",
    check: "verifyStaleE2eRuntimeDirsGetSwept",
    from: "if (!entry.isDirectory() || !entry.name.startsWith(DOCTOR_RUNTIME_DIR_PREFIX)) continue;",
    to: "if (!entry.isDirectory()) continue;",
    expect: "顺手清理把不该动的东西删了"
  },
  {
    name: "保留期内的目录不得被清掉",
    file: "scripts/lib/stale-runtime-dirs.mjs",
    check: "verifyStaleE2eRuntimeDirsGetSwept",
    from: "if (!Number.isFinite(ageMs) || ageMs < staleAfterMs) { result.keptRecent.push(entry.name); continue; }",
    to: "",
    expect: "还在保留期内的被清掉了"
  },
  {
    name: "agent 失败码零覆盖回升要被拦住",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentFailureCodeCoverageRatchet",
    // 改名不行：一个零覆盖的码换成另一个零覆盖的码，总数不变。要【新增】一个才测得出。
    from: "function ensureCleanWorktree(root) {",
    to: 'function ensureCleanWorktree(root) {\n  if (root === "never") throw new Error("brand_new_uncovered_code:凑数用");',
    // 期望里【不要写死数字】：这个棘轮今天从 12 一路降到 4，每降一次这条就过期一次
    //（完整变异门跑出来的"失败了但不是因为预期断言"，其中两条就是这么来的）。
    expect: "零覆盖从"
  },
  {
    name: "机器上那份仓库指向别处时必须拒绝开工",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentRuntimeGuardsRefuseRealAttacks",
    from: 'if (configuredUrl !== target.repositoryUrl) throw new Error("local_repository_remote_mismatch',
    to: 'if (false) throw new Error("local_repository_remote_mismatch',
    expect: "remote 指向别处时拿到的是"
  },
  {
    name: "克隆前必须先判传输方式安不安全",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentRuntimeGuardsRefuseRealAttacks",
    from: 'if (!isSafeCloneUrl(target.repositoryUrl)) throw new Error("dispatch_repository_url_unsafe_transport',
    to: 'if (false) throw new Error("dispatch_repository_url_unsafe_transport',
    expect: "地址用了能跑命令的传输方式时拿到的是"
  },
  {
    name: "认不出的权限处置状态不许当成批准",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentRuntimeGuardsRefuseRealAttacks",
    from: 'if (["grant_issued", "approved", "granted"].includes(status)) {',
    to: 'if (!["reassign", "denied"].includes(status)) {',
    expect: "认不出的状态的结果是"
  },
  {
    name: "控制面拒绝了工具调用不得当成成功",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentRuntimeGuardsRefuseRealAttacks",
    from: "if (payload.ok === false) throw new Error(`agent_mcp_call_refused",
    to: "if (false) throw new Error(`agent_mcp_call_refused",
    expect: "工具明确拒绝时拿到的是 成功"
  },
  {
    name: "技能集里的路径不得指向缓存目录之外",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentRuntimeGuardsRefuseRealAttacks",
    from: 'if (!inside(directory, target)) throw new Error("skill_workset_path_escape:技能集里有路径指向缓存目录之外");',
    to: "",
    expect: "技能文件路径爬到缓存目录之外"
  },
  {
    name: "下回来的技能集摘要必须与派发里说的一致",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentRuntimeGuardsRefuseRealAttacks",
    from: 'if (workset.worksetDigest !== expected.worksetDigest) throw new Error("skill_workset_digest_mismatch',
    to: 'if (false) throw new Error("skill_workset_digest_mismatch',
    expect: "下回来的摘要与派发里说的对不上"
  },
  {
    name: "内容包写入前必须先清掉上一轮的文件",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentRuntimeGuardsRefuseRealAttacks",
    from: "try { rmSync(bundleDir, {recursive: true, force: true}); } catch { /* 首次执行时它本就不存在 */ }",
    to: "",
    expect: "人删掉的规则会在下一次执行里复活"
  },
  {
    name: "内容包整包摘要不得形同虚设",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentRuntimeGuardsRefuseRealAttacks",
    from: "if (recomputed !== bundle.bundleDigest) {",
    to: "if (false) {",
    expect: "有条目被整个丢掉时拿到的是 放行"
  },
  {
    name: "内容包条目不得写到会话目录之外",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentRuntimeGuardsRefuseRealAttacks",
    from: "if (!inside(bundleDir, sessionTarget)) throw new Error(`content_bundle_path_escapes_session: ${entry.path}`);",
    to: "",
    expect: "路径爬到会话目录之外时拿到的是 放行"
  },
  {
    name: "答复了的错误不得再拿报文猜是不是暂时故障",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentRuntimeGuardsRefuseRealAttacks",
    from: "if (status) return status === 409 || status === 429 || (status >= 500 && status <= 599);",
    to: "if (status === 409 || status === 429 || (status >= 500 && status <= 599)) return true;",
    expect: "码里带 timeout"
  },
  {
    name: "重试次数写坏了不得变成一次都不试",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentRuntimeGuardsRefuseRealAttacks",
    from: "const attempts = Number.isFinite(configuredAttempts) && configuredAttempts >= 1\n    ? Math.floor(configuredAttempts) : 4;",
    to: "const attempts = Number(process.env.AIMAC_AGENT_RETRY_ATTEMPTS || 4);",
    expect: "一次都没试就失败了"
  },
  {
    name: "产出路径必须拦住「白名单前缀 + 爬出去」",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentRuntimeGuardsRefuseRealAttacks",
    from: 'path.split("/").includes("..")',
    to: 'path.includes(" ")',
    expect: "白名单前缀 + 爬出去"
  },
  {
    name: "任意 helper:: 传输方式不得当成安全地址",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentRuntimeGuardsRefuseRealAttacks",
    from: 'if (/^[a-z0-9+.-]*::/iu.test(value) || value.startsWith("ext:") || value.startsWith("fd:")) return false;',
    to: 'if (value.startsWith("ext:") || value.startsWith("fd:")) return false;',
    expect: "任意 helper::被判成安全了"
  },
  {
    name: "缓存里被改过的技能文件不得当成有效",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentRuntimeGuardsRefuseRealAttacks",
    from: "return inside(directory, target) && existsSync(target) && sha256(readFileSync(target, \"utf8\")) === file.contentDigest;",
    to: "return inside(directory, target) && existsSync(target);",
    expect: "内容与摘要对不上却被当成有效"
  },
  {
    name: "审计动作名的另一种写法也要被中文门看见",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    gate: "specs",
    from: 'action: "transition_rejected_in_warn_mode",',
    to: 'action: "transition_waved_through_in_warn_mode",',
    expect: "审计动作名在中文审计页上会显示成原始英文"
  },
  {
    name: "请求作用域泄漏要扫到网关那份源码",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyNoRequestScopedLeaks",
    from: "function appendGatewayEvent(state, eventType, subjectId, payload) {",
    to: "function appendGatewayEvent(state, eventType, subjectId, payload) {\n  if (req.method === \"POST\") { /* 这个函数没有 req */ }",
    expect: "引用了它没拿到的 req"
  },
  {
    name: "agent 的失败原因不得是没码的英文",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentFailureReasonsAreCoded",
    from: 'throw new Error("agent_worktree_not_clean:',
    to: 'throw new Error("worktree is dirty before dispatch, please clean it:',
    expect: "没带码，会原样变成控制台上那句「原因」"
  },
  {
    name: "起服务端的进程死了服务端要跟着退",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyTestServersDieWithTheirParent",
    from: "if (process.ppid === bornTo) return;",
    to: "if (true) return;",
    expect: "服务端还活着"
  },
  {
    name: "真实的推送被拒必须走 §8 而不是直接失败",
    file: "apps/agent-runtime/runtime.mjs",
    gate: "agent",
    from: "    if (!promptType) throw pushError;",
    to: "    throw pushError;",
    expect: "没有走 §8 上报权限单"
  },
  {
    // 认得出「这是权限问题」这件事本身是承重的：把整张表清空，被拒的推送就又变回一条普通失败。
    // （逐条改单个签名不行 —— 这个夹具同时命中「remote: permission to … denied」和
    // 「pre-receive hook declined」两条，改掉一条另一条会接住，看起来像"改坏了也没事"。）
    name: "推送被拒的分类不得把权限当成普通失败",
    file: "apps/agent-runtime/runtime.mjs",
    gate: "agent",
    from: "const hit = PUSH_PERMISSION_DENIALS.find((item) => item.re.test(value));",
    to: "const hit = PUSH_PERMISSION_DENIALS.slice(0, 0).find((item) => item.re.test(value));",
    expect: "没有走 §8 上报权限单"
  },
  {
    name: "检查点不带契约摘要不得整道跳过",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: '  if (dispatch.taskContractDigest && !checkpointInput.taskContractDigest) {\n    return {accepted: false, status: 409, error: "checkpoint_task_contract_digest_required"};\n  }\n',
    to: "",
    expect: "不带任务契约摘要就被受理了"
  },
  {
    name: "正在跑的派发要说出上次动静是多久以前",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "      ? esc(sinceText(dispatch.lastExecutionEventAt))",
    to: '      ? ""',
    expect: "上一次有动静是多久以前"
  },
  {
    name: "认不出的时间不得显示成刚刚",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: 'if (!Number.isFinite(at)) return value ? "时间无法识别" : "";',
    to: 'if (!Number.isFinite(at)) return "";',
    expect: "认不出的时间不得显示成「刚刚」"
  },
  {
    name: "领走了却没动静的派发不得留空",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "`领走 ${esc(sinceText(dispatch.claimedAt))}，还没有过动静`",
    to: '""',
    expect: "「还没有过动静」而不是留空"
  },
  {
    name: "派发包合同摘要缺失必须当不匹配",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentRuntimeGuardsRefuseRealAttacks",
    from: "if (!contractDigest || value.dispatch?.taskContractDigest !== contractDigest)",
    to: "if (value.dispatch?.taskContractDigest !== contractDigest)",
    expect: "两边都没有合同摘要"
  },
  {
    name: "派发包绑定不得只判非空",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentRuntimeGuardsRefuseRealAttacks",
    from: "if (!worksetId || value.skillWorkset?.worksetId !== worksetId)",
    to: "if (!worksetId)",
    expect: "技能集对不上"
  },
  {
    name: "控制面下发的派发包必须带齐绑定",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    gate: "doctor",
    from: "      worksetId: skillWorkset.worksetId,",
    to: "      worksetId: undefined,",
    expect: "缺了绑定字段"
  },
  {
    name: "顶层 await 之后不得声明模块级常量",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyRuntimeConstantsSitBeforeItsTopLevelAwait",
    from: "function pathMatches(rule, path) {",
    to: "const LATE_CONST_PROBE = 1;\nfunction pathMatches(rule, path) {",
    expect: "顶层 await 之后声明了模块级常量"
  },
  {
    name: "起了子进程之后的异常必须先收掉子进程",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyRuntimeConstantsSitBeforeItsTopLevelAwait",
    from: "    } catch (error) { failFast(error); }",
    to: "    } catch (error) { throw error; }",
    expect: "起了子进程之后不再兜住异常"
  },
  {
    name: "失败原因被砍短必须说出砍了多少",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutorBackedWorkerRefusesUnsafeOutput",
    from: `const detail = truncateForHuman((result?.stderr || result?.stdout || "").trim(), 300, "执行器输出");`,
    to: `const detail = (result?.stderr || result?.stdout || "").trim().slice(0, 300);`,
    expect: "失败原因被砍短了却没说砍了多少"
  },
  {
    name: "运行时侧失败原因也要说出砍了多少",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyTruncatedExecutorOutputSaysSo",
    from: '${tailForHuman(result.stderr || result.stdout || "", 4000)}',
    to: '${String(result.stderr || result.stdout || "").slice(-4000)}',
    expect: "执行器非零退出的失败原因被砍短时不再说明砍了多少"
  },
  {
    name: "执行器输出超内存上限时丢了多少要记下来",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyTruncatedExecutorOutputSaysSo",
    from: "dropped += text.length - limit;",
    to: "dropped += 0;",
    expect: "执行器输出超过内存上限时开头被悄悄丢掉"
  },
  {
    name: "输出上限认不出时不得当成 0",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyTruncatedExecutorOutputSaysSo",
    from: "return Number.isFinite(configured) && configured >= 1024 ? Math.floor(configured) : OUTPUT_CAPTURE_MAX_CHARS_DEFAULT;",
    to: "return Math.floor(configured) || OUTPUT_CAPTURE_MAX_CHARS_DEFAULT;",
    expect: "执行器输出上限认不出时不再回默认"
  },
  {
    name: "停执行器必须按进程组杀",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyStoppingAnExecutorTellsTheTruth",
    from: "process.kill(-child.pid, signal);",
    to: "process.kill(child.pid, signal);",
    expect: "停执行器时不再按进程组杀"
  },
  {
    name: "停执行器必须先礼后兵",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyStoppingAnExecutorTellsTheTruth",
    from: `const killTimer = setTimeout(() => {\n      killChildProcessGroup(child, "SIGKILL");`,
    to: `const killTimer = setTimeout(() => {\n      killChildProcessGroup(child, "SIGTERM");`,
    expect: "停执行器时不再先发 SIGTERM 再补 SIGKILL"
  },
  {
    name: "停不掉的执行器不许谎报已停止",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyStoppingAnExecutorTellsTheTruth",
    from: `resolveStop({stopped: false, reason: "child_stop_timeout"});`,
    to: `resolveStop({stopped: true, reason: "child_stop_timeout"});`,
    expect: "停执行器超时后不再如实回 stopped:false"
  },
  {
    name: "文档写了不存在的环境变量要被查出来",
    file: "docs/human-org-console-and-content-distribution-design.md",
    check: "verifyDocumentedEnvVarsAreRealKnobs",
    from: "AIMAC_AGENT_LIBRARY_MAX_MB",
    to: "AIMAC_AGENT_LIBRARY_MAX_MEGABYTES",
    expect: "代码里【一处都没有】"
  },
  {
    name: "代码里把环境变量改名要被查出来",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyDocumentedEnvVarsAreRealKnobs",
    from: "AIMAC_AGENT_SESSION_TTL_HOURS",
    to: "AIMAC_AGENT_SESSION_TTL_H",
    expect: "代码里【一处都没有】"
  },
  {
    name: "重放核对不得退化成只比 SHA 相等",
    file: "scripts/contract-check.mjs",
    check: "verifyReplayRemoteCheckDistinguishesLostFromMovedOn",
    from: "        execFileSync(\"git\", [\"merge-base\", \"--is-ancestor\", sha, \"FETCH_HEAD\"], {cwd: repo});\n        return true;",
    to: "        return lsRemote() === sha;",
    expect: "就被判成「提交不见了」"
  },
  {
    name: "造不出「提交真的不见了」时要自报空转",
    file: "scripts/contract-check.mjs",
    check: "verifyReplayRemoteCheckDistinguishesLostFromMovedOn",
    from: "    git(\"reset\", \"-q\", \"--hard\", baseCommit);",
    to: "    git(\"reset\", \"-q\", \"--hard\", pushed);",
    expect: "情形三这条断言在空转"
  },
  {
    name: "证据脱敏必须挡住 Cookie",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyEvidenceRedactionCoversKnownSecrets",
    from: "  text = text.replace(/((?:set-)?cookie\\s*[:=]\\s*)[^\\n\\r]+/giu, \"$1[redacted]\");",
    to: "  text = text.replace(/never-matches-cookie/giu, \"$1[redacted]\");",
    expect: "证据脱敏漏掉了"
  },
  {
    name: "证据脱敏必须挡住私钥整块",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyEvidenceRedactionCoversKnownSecrets",
    from: "  text = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, \"[redacted-private-key]\");",
    to: "  text = text.replace(/never-matches-key/gu, \"[redacted-private-key]\");",
    expect: "证据脱敏漏掉了"
  },
  {
    name: "证据脱敏必须挡住 URL 里的口令",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyEvidenceRedactionCoversKnownSecrets",
    from: "  text = text.replace(/([a-z][a-z0-9+.-]*:\\/\\/)[^@/\\s]+@/giu, \"$1[redacted]@\");",
    to: "  text = text.replace(/(never-matches-url)/giu, \"$1[redacted]@\");",
    expect: "证据脱敏漏掉了"
  },
  {
    name: "文档里写了不存在的 npm 脚本要被查出来",
    file: "README.md",
    check: "verifyDocumentedCommandsStillExist",
    from: "npm run doctor\nnpm run mcp:doctor",
    to: "npm run doctor-full\nnpm run mcp:doctor",
    expect: "package.json 里没有"
  },
  {
    name: "脚本改名时文档要跟着改",
    file: "package.json",
    check: "verifyDocumentedCommandsStillExist",
    from: "\"mcp:doctor\":",
    to: "\"mcp:doctor-renamed\":",
    expect: "package.json 里没有"
  },
  {
    name: "协议文档不得漏列 runtime 会发的事件",
    file: "docs/agent-runtime-protocol.md",
    check: "verifyProtocolEventListMatchesReality",
    from: "\u3001`heartbeat`\uff08\u957f\u4efb\u52a1\u7684\u4fdd\u6d3b\u5fc3\u8df3\uff0c\u5e26 `progressPercent: 0`\uff09\u3002",
    to: "\u3002",
    expect: "而协议文档没列"
  },
  {
    name: "协议文档不得列出 schema 不认的事件",
    file: "docs/agent-runtime-protocol.md",
    check: "verifyProtocolEventListMatchesReality",
    from: "\u4e8b\u4ef6\u8986\u76d6 `dispatch_received`",
    to: "\u4e8b\u4ef6\u8986\u76d6 `never_defined_event`\u3001`dispatch_received`",
    expect: "而 schema 不认"
  },
  {
    name: "协议文档的版本示例不得低于要求",
    file: "docs/agent-runtime-protocol.md",
    check: "verifyProtocolDocMatchesRequiredRuntimeVersion",
    from: "  \"runtimeVersion\": \"0.3.0\",",
    to: "  \"runtimeVersion\": \"0.2.0\",",
    expect: "低于要求的"
  },
  {
    name: "抬高版本要求时协议文档要跟着改",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyProtocolDocMatchesRequiredRuntimeVersion",
    from: "export const REQUIRED_AGENT_RUNTIME_VERSION = \"0.3.0\";",
    to: "export const REQUIRED_AGENT_RUNTIME_VERSION = \"0.9.0\";",
    expect: "协议文档里没有出现当前要求的运行时版本"
  },
  {
    name: "自带 agent 运行时不得自己就过期",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyProtocolDocMatchesRequiredRuntimeVersion",
    from: "const RUNTIME_VERSION = \"0.3.0\";",
    to: "const RUNTIME_VERSION = \"0.2.0\";",
    expect: "官方那份自己就是"
  },
  {
    name: "文档写了不存在的接口要被查出来",
    file: "docs/core-control-plane-spec.md",
    check: "verifyDocumentedApiPathsExist",
    from: "| POST | `/api/work-items/:workItemId/assign` | \u5206\u914d\u6216\u6539\u6d3e | scheduler\u3001orchestrator |",
    to: "| POST | `/api/work-items/:workItemId/reassign-now` | \u5206\u914d\u6216\u6539\u6d3e | scheduler\u3001orchestrator |",
    expect: "在服务端不存在"
  },
  {
    name: "产品删掉文档写着的路由要被查出来",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyDocumentedApiPathsExist",
    from: "  const upgradeCandidateResolveMatch = url.pathname.match(/^\\/api\\/system-upgrade-candidates\\/([^/]+)\\/resolve$/);",
    to: "  const upgradeCandidateResolveMatch = url.pathname.match(/^\\/api\\/gone\\/([^/]+)\\/resolve$/);",
    expect: "在服务端不存在"
  },
  {
    name: "跨组织授权必须真的被拒（不只是源码里有那个码）",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: "    return {ok: false, status: 400, error: \"cross_org_grant_not_allowed\"};",
    to: "    if (false) return {ok: false, status: 400, error: \"cross_org_grant_not_allowed\"};",
    expect: "把本组织资源的权授给了别组织的账号"
  },
  {
    name: "两条存储路共用的合并处也要核分片版本",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    check: "verifyStateFilesRefuseUnknownSchemaVersions",
    from: "    if (shard?.schemaVersion && !SUPPORTED_PROJECT_SHARD_SCHEMA_VERSIONS.has(shard.schemaVersion)) {",
    to: "    if (false) {",
    expect: "合并处没有核分片的 schemaVersion"
  },
  {
    name: "认不出版本的项目分片必须拒开工",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    check: "verifyStateFilesRefuseUnknownSchemaVersions",
    from: "        if (shard.schemaVersion && !SUPPORTED_PROJECT_SHARD_SCHEMA_VERSIONS.has(shard.schemaVersion)) {",
    to: "        if (false) {",
    expect: "却照读不误"
  },
  {
    name: "没有版本字段的旧分片仍要能读",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    check: "verifyStateFilesRefuseUnknownSchemaVersions",
    from: "        if (shard.schemaVersion && !SUPPORTED_PROJECT_SHARD_SCHEMA_VERSIONS.has(shard.schemaVersion)) {",
    to: "        if (!SUPPORTED_PROJECT_SHARD_SCHEMA_VERSIONS.has(shard.schemaVersion)) {",
    expect: "没有 schemaVersion 的旧分片被拒了"
  },
  {
    name: "读不出的运行时版本必须按过旧处理",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyOutdatedRuntimeIsFlaggedFailClosed",
    from: "  if (a.some((part) => !Number.isFinite(part)) || a.length < b.length) return true; // \u7248\u672c\u53f7\u8bfb\u4e0d\u51fa\u6765\uff0c\u6309\u8fc7\u65e7\u5904\u7406",
    to: "  if (a.some((part) => !Number.isFinite(part)) || a.length < b.length) return false;",
    expect: "应为过旧"
  },
  {
    name: "版本过旧的标签必须带到对外投影上",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyOutdatedRuntimeIsFlaggedFailClosed",
    from: "  safe.runtimeOutdated = agentRuntimeOutdated(node);",
    to: "  safe.runtimeOutdatedX = agentRuntimeOutdated(node);",
    expect: "没有把 runtimeOutdated 带出去"
  },
  {
    name: "主视图不得带上界面从不读的大集合",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyViewDropsCollectionsNobodyReads",
    from: "  cloned.roleSkills = [];",
    to: "  cloned.roleSkillsKept = [];",
    expect: "主视图又开始带上 roleSkills"
  },
  {
    name: "界面读被清空的集合要被查出来",
    file: "apps/control-plane-ui/public/app.js",
    check: "verifyViewDropsCollectionsNobodyReads",
    from: "    modelSelectionPolicies: [],",
    to: "    modelSelectionPolicies: [], _probe: (state.modelProviders || []).length,",
    expect: "而主视图把它清空了"
  },
  {
    name: "技能源那一页不得整份下发技能正文",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyConsoleDoesNotPullSkillBodies",
    from: "      roleSkillCountBySource,",
    to: "      roleSkills: scoped.roleSkills,",
    expect: "又在整份下发 roleSkills"
  },
  {
    name: "界面不得再读技能正文",
    file: "apps/control-plane-ui/public/app.js",
    check: "verifyConsoleDoesNotPullSkillBodies",
    from: "    {v: String((state.roleSkillCountBySource || {})[source.sourceId] || 0), c: \"num\"},",
    to: "    {v: String((state.roleSkills || []).length), c: \"num\"},",
    expect: "处读 state.roleSkills"
  },
  {
    name: "机器主体守卫必须是白名单式",
    file: "apps/mcp-server/server.mjs",
    check: "verifyMachinePrincipalGuardsAreAllowlists",
    from: "      if (context?.principal?.kind !== \"system_admin\") {\n        return {ok: false, error: \"account_invite_forbidden_for_machine_principal\"};",
    to: "      if (context?.principal?.kind === \"agent_node\") {\n        return {ok: false, error: \"account_invite_forbidden_for_machine_principal\"};",
    expect: "那道守卫写成了黑名单"
  },
  {
    name: "自报别人的项目要被授权比对拦下",
    file: "apps/mcp-server/server.mjs",
    check: "verifyGrantScopeCoversObjectsNamedOnlyById",
    from: "  if (args.projectId && args.projectId !== grant.projectId) return false;",
    to: "  if (false) return false;",
    expect: "自报别人的 projectId"
  },
  {
    name: "自报别人的任务组要被授权比对拦下",
    file: "apps/mcp-server/server.mjs",
    check: "verifyGrantScopeCoversObjectsNamedOnlyById",
    from: "  if (args.taskGroupId && args.taskGroupId !== grant.taskGroupId) return false;",
    to: "  if (false) return false;",
    expect: "自报别人的 taskGroupId"
  },
  {
    name: "自报别人的会话要被授权比对拦下",
    file: "apps/mcp-server/server.mjs",
    check: "verifyGrantScopeCoversObjectsNamedOnlyById",
    from: "  if (args.sessionId && args.sessionId !== grant.sessionId) return false;",
    to: "  if (false) return false;",
    expect: "自报别人的 sessionId"
  },
  {
    name: "新增受阻原因必须有中文",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyBlockedReasonsAllHaveChinese",
    from: "          workItem.blockedReason = \"dependency_abandoned\";",
    to: "          workItem.blockedReason = \"brand_new_reason_code\";",
    expect: "受阻原因没有中文"
  },
  {
    name: "词表里摘掉受阻原因要被查出来",
    file: "apps/control-plane-ui/public/i18n-zh.js",
    check: "verifyBlockedReasonsAllHaveChinese",
    from: "    dependency_abandoned: \"\u4f9d\u8d56\u5df2\u88ab\u653e\u5f03\",",
    to: "    dependency_abandoned_x: \"\u4f9d\u8d56\u5df2\u88ab\u653e\u5f03\",",
    expect: "受阻原因没有中文"
  },
  {
    name: "在制品提示要说清额度按什么算",
    file: "apps/control-plane-ui/public/app.js",
    check: "verifyWipHintMatchesHowCapacityIsCounted",
    from: "    + `\u60f3\u8ba9\u5b83\u8dd1\u5f97\u66f4\u5bbd\uff0c\u5c31\u5230\u300cAI \u667a\u80fd\u4f53\u300d\u9875\u591a\u63a5\u5165\u51e0\u53f0\u8282\u70b9\uff1a\u989d\u5ea6\u6309\u3010\u5728\u7ebf\u4e14\u5df2\u901a\u8fc7\u81ea\u68c0\u3011\u7684\u8282\u70b9\u6570\u4e0a\u8c03 \u2014\u2014 `",
    to: "    + `\u60f3\u8ba9\u5b83\u8dd1\u5f97\u66f4\u5bbd\uff0c\u5c31\u5230\u300cAI \u667a\u80fd\u4f53\u300d\u9875\u591a\u63a5\u5165\u51e0\u53f0\u8282\u70b9\uff08\u6bcf\u591a\u4e00\u53f0\u5728\u7ebf\u8282\u70b9\uff0c\u989d\u5ea6\u81ea\u52a8\u4e0a\u8c03\uff09\u3002`",
    expect: "而提示只说「在线节点」"
  },
  {
    name: "额度算法改了提示要跟着改",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyWipHintMatchesHowCapacityIsCounted",
    from: "    if (node.status === \"online\" && node.admission === \"full\") online += 1;",
    to: "    if (node.status === \"online\") online += 1;",
    expect: "已经不看 admission 了"
  },
  {
    name: "临时授权的指引必须指向真能解开门的那个动作",
    file: "apps/control-plane-ui/public/app.js",
    check: "verifyTempGrantGuidePointsAtTheRightLever",
    from: "\u8981\u7acb\u523b\u6536\u56de\u5c31\u5230\u300c\u4eba\u5de5\u6307\u4ee4\u300d\u9875\u53d6\u6d88\u5bf9\u5e94\u7684\u6d3e\u53d1\uff08\u64a4\u9500\u8be5\u6d3e\u53d1\u7684\u8282\u70b9\u7ed1\u5b9a\u65f6\u4f1a\u4e00\u5e76\u6536\u56de\u8fd9\u4e9b\u6388\u6743\uff09\u3002",
    to: "\u8981\u7acb\u523b\u6536\u56de\u5c31\u5230\u300c\u8d26\u53f7\u4e0e\u6388\u6743\u300d\u9875\u64a4\u9500\u3002",
    expect: "人撤了一圈，门照样挡着"
  },
  {
    name: "门读的集合与指引说的必须是同一个",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyTempGrantGuidePointsAtTheRightLever",
    from: "    no_active_temp_grants: (state.mcpGrants || []).some",
    to: "    no_active_temp_grants: (state.accessGrants || []).some",
    expect: "两处漂开了"
  },
  {
    name: "编排节奏要按真实间隔说不能写死",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "\uff08${orchestratorCadenceText()}\uff09\uff0c",
    to: "\uff08\u9ed8\u8ba4\u6bcf\u5206\u949f\u4e00\u6b21\uff09\uff0c",
    expect: "界面还在说别的"
  },
  {
    name: "自治关掉时要说清不会自动跑",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "  if (!status.enabled) return \"\u5f53\u524d\u8fd9\u53f0\u6ca1\u6709\u5f00\u81ea\u6cbb\u5468\u671f\uff0c\u4e0d\u4f1a\u81ea\u52a8\u8dd1\";",
    to: "  if (!status.enabled) return \"\u6309\u56fa\u5b9a\u5468\u671f\";",
    expect: "人会一直等下去"
  },
  {
    name: "清空按钮的说明不得暗示生产点不了",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "<strong>\u751f\u4ea7\u73af\u5883\u540c\u6837\u70b9\u5f97\u52a8</strong>",
    to: "\u4ec5\u7528\u4e8e\u672c\u5730\u73af\u5883\u6392\u969c",
    expect: "没说清拦住它的是下一步的打字确认"
  },
  {
    name: "项目概览要说出别处还有多少事等人处理",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "            const todo = pendingForMe();\n            const others = Math.max(0, todo.total - pendingConfirmCount);",
    to: "            const todo = pendingForMe();\n            const others = 0;",
    expect: "必须在同一格里说出来"
  },
  {
    name: "读不出的配额必须按超额处理",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: "  if (!Number.isFinite(quota) || !Number.isFinite(usage)) {\n    return {allowed: false, error: \"org_quota_unreadable\", quota, usage, kind};\n  }",
    to: "  if (false) {\n    return {allowed: false, error: \"org_quota_unreadable\", quota, usage, kind};\n  }",
    expect: "配额被写成非数字时仍然放行"
  },
  {
    name: "写坏的到期时间必须按已过期处理",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyAgentJoinTokenIsSpentExactlyOnce",
    from: "  if (!Number.isFinite(joinTokenExpiryMs) || joinTokenExpiryMs <= Date.now()) {",
    to: "  if (joinTokenExpiryMs <= Date.now()) {",
    expect: "到期时间是个认不出的串"
  },
  {
    name: "时间字段漏声明格式要被查出来",
    file: "spec/agent-dispatch.schema.json",
    check: "verifyTimestampFieldsDeclareTheirFormat",
    from: "    \"claimExpiresAt\": {\n      \"type\": \"string\",\n      \"format\": \"date-time\"",
    to: "    \"claimExpiresAt\": {\n      \"type\": \"string\"",
    expect: "没有声明 format: date-time"
  },
  {
    name: "幂等命中要比对写的是哪个对象",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: "    const subjectChanged = existingRecord.subject !== undefined && existingRecord.subject !== subject;",
    to: "    const subjectChanged = false;",
    expect: "拿到的不是 409/idempotency_key_reuse_conflict"
  },
  {
    name: "幂等记录必须记下写的是哪个对象",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: "action: guard.command.type, subject: guard.command.subject, bodyDigest: guard.bodyDigest",
    to: "action: guard.command.type, bodyDigest: guard.bodyDigest",
    expect: "拿到的不是 409/idempotency_key_reuse_conflict"
  },
  {
    name: "选型决策的归属必须从任务组推出来",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyTaskGroupScopedWritesDeriveTheirProject",
    from: "    projectId: modelDecisionOwner?.projectId || workItem.projectId || request.projectId || \"prj_control_plane\",",
    to: "    projectId: request.projectId || workItem.projectId || \"prj_control_plane\",",
    expect: "选型决策落在了调用方自己填的项目名下"
  },
  {
    name: "会话放置决策的归属必须从任务组推出来",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyTaskGroupScopedWritesDeriveTheirProject",
    from: "    // \u540c\u4e0a\uff1a\u8fd9\u4e2a\u52a8\u4f5c\u4e5f\u662f\u6309\u4efb\u52a1\u7ec4\u5224\u7684\u6743\uff08session_placement_decide \u2192 taskGroupScope\uff09\u3002\n    projectId: taskGroup?.projectId || request.projectId || \"prj_control_plane\",",
    to: "    projectId: request.projectId || taskGroup?.projectId || \"prj_control_plane\",",
    expect: "会话放置决策落在了调用方自己填的项目名下"
  },
  {
    name: "推归属不得变成丢弃这个字段",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyTaskGroupScopedWritesDeriveTheirProject",
    from: "    // \u540c\u4e0a\uff1a\u8fd9\u4e2a\u52a8\u4f5c\u4e5f\u662f\u6309\u4efb\u52a1\u7ec4\u5224\u7684\u6743\uff08session_placement_decide \u2192 taskGroupScope\uff09\u3002\n    projectId: taskGroup?.projectId || request.projectId || \"prj_control_plane\",",
    to: "    projectId: \"prj_wrong_always\",",
    expect: "推不出正确归属"
  },
  {
    name: "角色定制的归属必须从它挂的任务组推出来",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyOverlayOwnershipComesFromItsTaskGroup",
    from: "    projectId: overlayTaskGroup?.projectId || body.projectId || \"prj_control_plane\",",
    to: "    projectId: body.projectId || \"prj_control_plane\",",
    expect: "却落在 prj_somebody_elses 名下"
  },
  {
    name: "从任务组推归属不得波及项目级那一支",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyOverlayOwnershipComesFromItsTaskGroup",
    from: "    projectId: overlayTaskGroup?.projectId || body.projectId || \"prj_control_plane\",",
    to: "    projectId: (state.taskGroups || [])[0]?.projectId || \"prj_control_plane\",",
    expect: "项目级 overlay 的归属被改坏了"
  },
  {
    name: "agent 通道不得透传自选字段",
    file: "apps/control-plane-ui/server.mjs",
    gate: "agent",
    from: "      request = createHumanConfirmationRequest(state, {\n        nodeId: node.nodeId,\n        dispatchId: body.dispatchId,",
    to: "      request = createHumanConfirmationRequest(state, {\n        ...body,\n        nodeId: node.nodeId,\n        dispatchId: body.dispatchId,",
    expect: "被采纳了"
  },
  {
    name: "派发卡住时要说清在等哪张卡",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "      dispatch.humanConfirmationRef\n        ? `<div class=\"small muted\">\u5728\u7b49\u8fd9\u5f20\u5361\uff1a<span class=\"mono\">${esc(dispatch.humanConfirmationRef)}</span></div>`\n        : \"\",",
    to: "      \"\",",
    expect: "没说是哪一张"
  },
  {
    name: "重新初始化必须带确认串",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: "    if (hasTenantData && String(body.confirmDestroy || \"\") !== `${liveOrgs}/${liveProjects}/${liveTaskGroups}`) {",
    to: "    if (false) {",
    expect: "不带确认就能重新初始化运行态"
  },
  {
    name: "判断有没有真实数据要看集合超没超种子",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: "    const WORK_EVIDENCE = [\"accounts\", \"workSessions\", \"agentDispatches\", \"humanConfirmationRequests\",\n      \"artifacts\", \"repositoryOutputs\", \"agentRuntimeNodes\", \"checkpoints\", \"executionTopologies\"];",
    to: "    const WORK_EVIDENCE = [];",
    expect: "没有任何【集合】超出种子的证据"
  },
  {
    name: "判断有没有真实数据要把工作项算进去",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: "    const grownWorkItems = countWorkItems(state) > countWorkItems(bootstrapBaseline);",
    to: "    const grownWorkItems = false;",
    expect: "没把【工作项】算进证据"
  },
  {
    name: "文案说了不可逆就必须标 danger",
    file: "apps/control-plane-ui/public/app.js",
    check: "verifyHarshWordingImpliesDangerFlag",
    from: "        danger: true,\n        confirmText: \"\u91cd\u53d1\"",
    to: "        confirmText: \"\u91cd\u53d1\"",
    expect: "却没标 danger"
  },
  {
    name: "不可逆措辞词表脱节要报空转",
    file: "scripts/contract-check.mjs",
    check: "verifyHarshWordingImpliesDangerFlag",
    from: "const IRREVERSIBLE_WORDING = [\"\u5f53\u573a\u5931\u6548\", \"\u4e0d\u53ef\u64a4\u9500\", \"\u4e0d\u53ef\u9006\", \"\u65e0\u6cd5\u6062\u590d\", \"\u8fdb\u5165\u7ec8\u6001\", \"\u4f1a\u88ab\u5220\u9664\", \"\u6c38\u4e45\"];",
    to: "const IRREVERSIBLE_WORDING = [\"\u4e0d\u4f1a\u51fa\u73b0\u7684\u8bcd\"];",
    expect: "这条判据在空转"
  },
  {
    name: "改用户配置的写入必须原子（带标记的段落）",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyRuntimeFileWritesAreRegistered",
    from: "  writeDurableText(path, next.endsWith(\"\\n\") ? next : `${next}\\n`, {mode: 0o600});",
    to: "  writeFileSync(path, next.endsWith(\"\\n\") ? next : `${next}\\n`, {mode: 0o600});",
    expect: "直写文件而没有登记理由"
  },
  {
    name: "新增直写文件的函数必须登记理由",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyRuntimeFileWritesAreRegistered",
    from: "function writeArtifactManifest",
    to: "function writeSomethingNew(p, v) { writeFileSync(p, v); }\nfunction writeArtifactManifest",
    expect: "直写文件而没有登记理由"
  },
  {
    name: "新增写路由必须走守卫或登记替代鉴权",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyEveryWriteRouteIsGuardedOrRegistered",
    from: "  if (req.method === \"POST\" && url.pathname === \"/api/auth/logout\") {",
    to: "  if (req.method === \"POST\" && url.pathname === \"/api/danger/wipe\") {\n    state.projects = [];\n    json(res, 200, {ok: true});\n    return;\n  }\n  if (req.method === \"POST\" && url.pathname === \"/api/auth/logout\") {",
    expect: "既没走 beginGuardedWrite、也没登记"
  },
  {
    name: "已有写路由的守卫被拿掉要报红",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyEveryWriteRouteIsGuardedOrRegistered",
    from: "    const guard = beginGuardedWrite(req, state, \"execution_topology_advance\"",
    to: "    const guard = beginNothing(req, state, \"execution_topology_advance\"",
    expect: "既没走 beginGuardedWrite、也没登记"
  },
  {
    name: "新增容量裁剪必须登记它保住什么",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyEveryCapExplainsWhatItKeeps",
    from: "function capLeaseHistory(leases, limit = 2000) {",
    to: "function capNaiveSlice(items, limit) { return items.slice(0, limit); }\nfunction capLeaseHistory(leases, limit = 2000) {",
    expect: "没有登记它凭什么不裁掉还在用的记录"
  },
  {
    name: "容量裁剪登记判据自己不得空转",
    file: "scripts/contract-check.mjs",
    check: "verifyEveryCapExplainsWhatItKeeps",
    from: "  const found = [...core.matchAll(/^(?:export )?function (cap[A-Z]\\w*)\\(/gum)].map((match) => match[1]);",
    to: "  const found = [...core.matchAll(/^(?:export )?function (nope[A-Z]\\w*)\\(/gum)].map((match) => match[1]);",
    expect: "它在空转"
  },
  {
    name: "未变动的项目分片必须被跳过",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    check: "verifyOneProjectWriteTouchesOneShard",
    from: "      if (reusable) {",
    to: "      if (false) {",
    expect: "却重写了 13 个项目分片"
  },
  {
    name: "变动的项目分片必须真的落盘",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    check: "verifyOneProjectWriteTouchesOneShard",
    from: "      if (reusable) {",
    to: "      if (previousName) {",
    expect: "这次改动没有落盘"
  },
  {
    name: "界面权限名写错时那道门形同虚设",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "  const canOrchestrate = hasPerm(\"task_group:orchestrate\");",
    to: "  const canOrchestrate = hasPerm(\"task_group:orchestrate_typo\");",
    expect: "页一字不变"
  },
  {
    name: "没有编排权限的人不得看到编排入口",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "  const canOrchestrate = hasPerm(\"task_group:orchestrate\");",
    to: "  const canOrchestrate = true;",
    expect: "看得到按钮却按不动"
  },
  {
    name: "资格检查没过的方案必须在界面上看得见",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "    .filter((item) => inScope(item) && item.status === \"eligibility_checked\" && (item.blockers || []).length)",
    to: "    .filter(() => false)",
    expect: "界面上找不到它"
  },
  {
    name: "面板总开关漏掉一块等于那块没加",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "openUpgradeCandidates.length || stuckTopologies.length\n      || downgradableTopologies.length) ? panel(\"\u963b\u585e\u9879\u4eba\u5de5\u5904\u7f6e\", `",
    to: "openUpgradeCandidates.length || stuckTopologies.length) ? panel(\"\u963b\u585e\u9879\u4eba\u5de5\u5904\u7f6e\", `",
    expect: "界面上找不到它"
  },
  {
    name: "面板开关判据自己不得空转",
    file: "scripts/contract-check.mjs",
    check: "verifyPanelGatesCoverEveryBlockInside",
    from: "  const blockSets = new Set([...body.matchAll(/&&\\s*(\\w+)\\.length\\s*\\?/gu)].map((match) => match[1]));",
    to: "  const blockSets = new Set([...body.matchAll(/&&\\s*(\\w+)\\.nosuchthing\\s*\\?/gu)].map((match) => match[1]));",
    expect: "这条判据的正则形状没对上"
  },
  {
    name: "阻塞项的英文尾码必须翻成人话",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "    .map((part) => (Object.prototype.hasOwnProperty.call(dict, part) ? t(part) : part))",
    to: "    .map((part) => part)",
    expect: "不能出现英文尾码"
  },
  {
    name: "阻塞项里的分支 id 不得被翻掉",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "  const detail = rest.filter(Boolean)\n    .map((part) => (Object.prototype.hasOwnProperty.call(dict, part) ? t(part) : part))\n    .join(\" \u00b7 \");",
    to: "  const detail = \"\";",
    expect: "分支 id 不见了"
  },
  {
    name: "阻塞项尾码没中文要被门查出来",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyTopologyBlockerPartsAllHaveChinese",
    from: "    if (!branch.objective) blockers.push(`independent_deliverables:${branch.branchId}:missing_objective`);",
    to: "    if (!branch.objective) blockers.push(`independent_deliverables:${branch.branchId}:brand_new_reason`);",
    expect: "尾码没有中文"
  },
  {
    name: "方案必须挂在一件真实工作项上",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutionTopologyStateMachineRefusesBadTransitions",
    from: "  if (!workItemId) throw topologyError(\"execution_topology_requires_work_item\", 400);",
    to: "  if (false) throw topologyError(\"execution_topology_requires_work_item\", 400);",
    expect: "不指明工作项也能建方案"
  },
  {
    name: "外部运行器必须带授权与本地验证",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutionTopologyStateMachineRefusesBadTransitions",
    from: "    throw topologyError(\"execution_topology_external_runner_requires_grant_and_local_verification\", 400);",
    to: "    void 0;",
    expect: "用外部运行器却不要授权凭据"
  },
  {
    name: "带着阻塞项不得启动方案",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutionTopologyStateMachineRefusesBadTransitions",
    from: "    if (topology.blockers.length) throw topologyError(\"execution_topology_eligibility_blocked\");",
    to: "    if (false) throw topologyError(\"execution_topology_eligibility_blocked\");",
    expect: "带着阻塞项就启动了"
  },
  {
    name: "方案降级必须写理由",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutionTopologyStateMachineRefusesBadTransitions",
    from: "    if (!reason) throw topologyError(\"execution_topology_downgrade_requires_reason\", 400);",
    to: "    if (false) throw topologyError(\"execution_topology_downgrade_requires_reason\", 400);",
    expect: "不写理由就把并行方案降级"
  },
  {
    name: "合并必须有终验证据",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutionTopologyStateMachineRefusesBadTransitions",
    from: "    if (!validation.length) throw topologyError(\"execution_topology_merge_requires_final_validation_evidence\", 400);",
    to: "    if (false) throw topologyError(\"execution_topology_merge_requires_final_validation_evidence\", 400);",
    expect: "不给终验证据就能合"
  },
  {
    name: "带着阻塞项不得合并",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutionTopologyStateMachineRefusesBadTransitions",
    from: "    if (topology.blockers.length) throw topologyError(\"execution_topology_merge_blocked_by_topology_blockers\");",
    to: "    if (false) throw topologyError(\"execution_topology_merge_blocked_by_topology_blockers\");",
    expect: "带着阻塞项就合了"
  },
  {
    name: "有分支没跑成不得合并",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutionTopologyStateMachineRefusesBadTransitions",
    from: "    if (unfinished.length) throw topologyError(\"execution_topology_merge_requires_all_branches_reported\");",
    to: "    if (false) throw topologyError(\"execution_topology_merge_requires_all_branches_reported\");",
    expect: "方案却被合了"
  },
  {
    name: "挂起方案必须说清在等哪件事",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutionTopologyStateMachineRefusesBadTransitions",
    from: "    if (!ref) throw topologyError(\"execution_topology_block_requires_derived_task_request_ref\", 400);",
    to: "    if (false) throw topologyError(\"execution_topology_block_requires_derived_task_request_ref\", 400);",
    expect: "不说因为哪件事就把方案挂起"
  },
  {
    name: "解除挂起必须说清解决了哪一条",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutionTopologyStateMachineRefusesBadTransitions",
    from: "    if (!ref) throw topologyError(\"execution_topology_unblock_requires_resolved_ref\", 400);",
    to: "    if (false) throw topologyError(\"execution_topology_unblock_requires_resolved_ref\", 400);",
    expect: "不说解决了哪一条就解除挂起"
  },
  {
    name: "对不上的引用不得解除挂起",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutionTopologyStateMachineRefusesBadTransitions",
    from: "    if (topology.blockers.length === before) throw topologyError(\"execution_topology_blocker_not_found\", 409);",
    to: "    if (false) throw topologyError(\"execution_topology_blocker_not_found\", 409);",
    expect: "用一个对不上的引用解除了挂起"
  },
  {
    name: "运行载体对账必须有证据",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutionTopologyStateMachineRefusesBadTransitions",
    from: "    if (!evidence) throw topologyError(\"execution_topology_reconcile_requires_evidence\", 400);",
    to: "    if (false) throw topologyError(\"execution_topology_reconcile_requires_evidence\", 400);",
    expect: "不给证据就宣布对账完成"
  },
  {
    name: "终止方案必须写理由",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutionTopologyStateMachineRefusesBadTransitions",
    from: "    if (!ref) throw topologyError(\"execution_topology_cancel_requires_ref\", 400);",
    to: "    if (false) throw topologyError(\"execution_topology_cancel_requires_ref\", 400);",
    expect: "不写理由就终止方案"
  },
  {
    name: "只能替自己那条控制命令回执",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyAgentGatewayContracts",
    from: "  if (!command) throw gatewayError(\"agent_control_command_not_found\", 404);",
    to: "  if (!command) return {command: {status: \"completed\"}};",
    expect: "agent_control_command_not_found"
  },
  {
    name: "已终结的控制命令不得被改写",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyAgentGatewayContracts",
    from: "  if (currentRank >= 4) throw gatewayError(\"agent_control_command_already_terminal\", 409);",
    to: "  if (false) throw gatewayError(\"agent_control_command_already_terminal\", 409);",
    expect: "agent_control_command_already_terminal"
  },
  {
    name: "控制命令回执状态不得倒退",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyAgentGatewayContracts",
    from: "  if ((controlAckRank[status] ?? 0) < currentRank) throw gatewayError(\"agent_control_command_ack_regression\", 409);",
    to: "  if (false) throw gatewayError(\"agent_control_command_ack_regression\", 409);",
    expect: "agent_control_command_ack_regression"
  },
  {
    name: "认不出的控制命令类型不得建出来",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyAgentGatewayContracts",
    from: "  throw gatewayError(\"agent_control_command_type_invalid\", 400);",
    to: "  return \"refresh_profile\";",
    expect: "认不出的命令类型被建出来了"
  },
  {
    name: "运行时确认单必须绑在自己那次派发的节点上",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: "  if (dispatch && input.nodeId && dispatch.assignedNodeId !== input.nodeId) throw Object.assign(new Error(\"confirmation_dispatch_node_mismatch\"), {status: 403});",
    to: "  if (false) throw Object.assign(new Error(\"confirmation_dispatch_node_mismatch\"), {status: 403});",
    expect: "拿到的不是 confirmation_dispatch_node_mismatch"
  },
  {
    name: "运行时确认单不得挂到别的任务组名下",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: "  if (dispatch && input.taskGroupId && input.taskGroupId !== dispatch.taskGroupId) throw Object.assign(new Error(\"confirmation_task_group_mismatch\"), {status: 409});",
    to: "  if (false) throw Object.assign(new Error(\"confirmation_task_group_mismatch\"), {status: 409});",
    expect: "拿到的不是 confirmation_task_group_mismatch"
  },
  {
    name: "不在册的角色技能不得发包",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: "  if (!skill) throw gatewayError(\"role_skill_not_found\", 409);",
    to: "  if (!skill) return {files: [], worksetId: \"x\"};",
    expect: "拿到的不是 role_skill_not_found"
  },
  {
    name: "技能源路径必须在技能目录内且文件真在",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: "    if (!inside(sourceRoot, target) || !existsSync(target)) throw gatewayError(\"role_skill_source_missing\", 409);",
    to: "    if (false) throw gatewayError(\"role_skill_source_missing\", 409);",
    expect: "拿到的不是 role_skill_source_missing"
  },
  {
    name: "盘上的技能正文必须与登记的摘要一致",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: "    if (digestOf(content) !== skill.contentDigest) {",
    to: "    if (false) {",
    expect: "技能包却照样发了"
  },
  {
    name: "角色技能注册表空了必须拒而不是回退",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: "    throw Object.assign(new Error(\"role_skill_registry_empty\"), {status: 409, roleId});",
    to: "    return {roleSkillId: \"fallback\", skill: {roleSkillId: \"fallback\"}};",
    expect: "注册表空了却没拒"
  },
  {
    name: "不安全的分支名不得存进产出目标",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: "    if (!isSafeGitRef(String(body.branch || \"main\"))) {\n      json(res, 400, {error: \"repository_output_target_unsafe_branch\", branch: String(body.branch || \"\").slice(0, 80)});",
    to: "    if (false) {\n      json(res, 400, {error: \"repository_output_target_unsafe_branch\", branch: String(body.branch || \"\").slice(0, 80)});",
    expect: "被存进产出目标了"
  },
  {
    name: "不安全的 remote 名不得存进产出目标",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: "    if (!/^[A-Za-z0-9._-]+$/u.test(requestedRemote) || requestedRemote.startsWith(\"-\")) {",
    to: "    if (false) {",
    expect: "被存进产出目标了"
  },
  {
    name: "门内断言写半截拒绝码要被查出来",
    file: "scripts/contract-check.mjs",
    check: "verifyGateAssertionsMatchWholeRefusalCodes",
    from: "} catch (error) { wildcardBlocked = error.message === \"permission_request_permission_not_delegable\"; }",
    to: "} catch (error) { wildcardBlocked = /permission_not_delegable/.test(error.message); }",
    expect: "用半截拒绝码"
  },
  {
    name: "权限请求的资源类型必须在册",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: "  if (!PERMISSION_REQUEST_RESOURCE_TYPES.includes(request.resource.resourceType)) {",
    to: "  if (false) {",
    expect: "permission_request_resource_type_not_allowed"
  },
  {
    name: "权限请求不得铸出通配或 system 权限",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: "  if (!isDelegatableGrantPermission(request.permission)) {",
    to: "  if (false) {",
    expect: "permission_request_permission_not_delegable"
  },
  {
    name: "解析不出所属项目的权限请求必须拒",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: "  if (request.taskGroupId && request.resource.resourceType !== \"external_capability\" && !resourceProjectId) {",
    to: "  if (false) {",
    expect: "permission_request_resource_scope_unresolvable"
  },
  {
    name: "已了结的会话不得被权限请求复活",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: "    if (session && WORK_SESSION_SETTLED_STATUSES.includes(session.status)) {",
    to: "    if (false) {",
    expect: "permission_request_session_already_settled"
  },
  {
    name: "权限请求带的会话必须属于本任务组",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: "    if (session && request.taskGroupId && session.taskGroupId !== request.taskGroupId) {",
    to: "    if (false) {",
    expect: "permission_request_session_scope_mismatch"
  },
  {
    name: "权限请求带的工作项必须属于本任务组",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: "    if (!(owningGroup?.workItems || []).some((item) => item.id === request.workId)) {",
    to: "    if (false) {",
    expect: "permission_request_work_item_scope_mismatch"
  },
  {
    name: "已吊销的节点不得再收控制命令",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyAgentGatewayContracts",
    from: "  if (!node || node.status === \"revoked\") throw gatewayError(\"agent_node_not_active\", 409);",
    to: "  if (!node) throw gatewayError(\"agent_node_not_active\", 409);",
    expect: "拿到的不是 agent_node_not_active"
  },
  {
    name: "控制命令必须对得上一次真在跑的派发",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyAgentGatewayContracts",
    from: "  if (!dispatch) throw gatewayError(\"control_dispatch_not_active\", 409);",
    to: "  if (false) throw gatewayError(\"control_dispatch_not_active\", 409);",
    expect: "拿到的不是 control_dispatch_not_active"
  },
  {
    name: "内容包只发给正在跑这次派发的那个节点",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: "  const dispatch = (state.agentDispatches || []).find((item) => item.sessionId === sessionId && item.assignedNodeId === node.nodeId && item.status === \"running\");",
    to: "  const dispatch = (state.agentDispatches || [])[0];",
    expect: "拿到的不是 content_bundle_dispatch_not_active"
  },
  {
    name: "上下文缺了就不许发半份内容包",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: "  if (!contract || !taskGroup) throw gatewayError(\"content_bundle_context_missing\", 409);",
    to: "  if (false) throw gatewayError(\"content_bundle_context_missing\", 409);",
    expect: "拿到的不是 content_bundle_context_missing"
  },
  {
    name: "邀请提权的两道门必须共用同一个谓词",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyInviteEscalationGuardsShareOnePredicate",
    from: "const systemScopedInvite = requestedSystemAccountInvite(body);",
    to: "const systemScopedInvite = isSystemAccount(body);",
    expect: "两处口径一旦漂开"
  },
  {
    name: "识别系统邀请时不得漏看权限前缀",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyInviteEscalationGuardsShareOnePredicate",
    from: "    permissions.some((permission) => permission === \"system:*\" || permission.startsWith(\"system:\"));",
    to: "    false;",
    expect: "不再看权限前缀"
  },
  {
    name: "认不出的令牌状态必须拒绝注册",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyAgentJoinTokenIsSpentExactlyOnce",
    from: "  if (record.status !== \"issued\") throw gatewayError(\"join_token_not_active\", 409, {tokenStatus: record.status});",
    to: "  if (false) throw gatewayError(\"join_token_not_active\", 409, {tokenStatus: record.status});",
    expect: "状态是认不出的值拿到的不是 join_token_not_active"
  },
  {
    name: "新增抛错工厂时拒绝码扫描面必须跟上",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyRefusalCodeScanSeesEveryThrowHelper",
    from: "function topologyError(code, status = 409, details = {})",
    to: "function policyError(code, status = 409) { throw Object.assign(new Error(code), {status}); }\nfunction topologyError(code, status = 409, details = {})",
    expect: "不在拒绝码扫描面里"
  },
  {
    name: "拒绝码扫描面被摘掉一种写法要报红",
    file: "scripts/contract-check.mjs",
    check: "verifyRefusalCodeScanSeesEveryThrowHelper",
    from: "const REFUSAL_CODE_THROW_HELPERS = [\"topologyError\", \"gatewayError\"];",
    to: "const REFUSAL_CODE_THROW_HELPERS = [\"topologyError\"];",
    expect: "不在拒绝码扫描面里"
  },
  {
    name: "没有执行载体的方案要在资格检查就说出来",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: "  if (topology.runnerKind === \"none\" || topology.isolation === \"none\") {\n    blockers.push(`runner_isolated:${topology.topologyId}:runner_or_isolation_none`);",
    to: "  if (branches.length > 1 && (topology.runnerKind === \"none\" || topology.isolation === \"none\")) {\n    blockers.push(`runner_isolated:${topology.topologyId}:runner_or_isolation_none`);",
    expect: "资格检查说没有阻塞项"
  },
  {
    name: "生产 profile 下服务端不得自己跑 agent（核心函数）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyServerSideAgentExecutionStaysOffOutsideVerification",
    from: "  if (state.runtime?.executionProfile !== \"verification\") {",
    to: "  if (false) {",
    expect: "服务端仍然自己把 agent 跑了"
  },
  {
    name: "生产 profile 下服务端不得自己跑 agent（HTTP 路由）",
    file: "apps/control-plane-ui/server.mjs",
    gate: "agent",
    from: "    if (executionProfile !== \"verification\") {",
    to: "    if (false) {",
    expect: "没有按 profile 拒绝"
  },
  {
    name: "提交不得改到人没批准的路径",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: "    const outside = changedPaths.filter((path) => !pathMatchesAllowlist(path, approvedPaths));",
    to: "    const outside = [];",
    expect: "人批的边界只由 agent 自报来守"
  },
  {
    name: "提交不得踩到人划的禁区",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: "    const trespassed = changedPaths.filter((path) => pathMatchesAllowlist(path, forbiddenApproved));",
    to: "    const trespassed = [];",
    expect: "禁区只是记录里的一行字"
  },
  {
    // 产品的招牌承诺："人定稿之后，AI 不得擅自改变这个方案"。三道守卫都有断言抓得住，
    // 但从没登记过判别力证明 —— 招牌不变式尤其不该只靠"我记得有测过"。
    name: "定稿后方案的实质内容变了就不许照常启动",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: '  if (["start", "merge"].includes(action) && topology.humanFinalization?.subjectContentDigest) {',
    to: "  if (false) {",
    expect: "定稿后方案的实质内容被改动"
  },
  {
    name: "AI 不得自行取消人已定稿的方案",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: '    if (topology.humanFinalization?.outcome === "confirmed" && !cancelApproved) {',
    to: "    if (false) {",
    expect: "AI 可自行取消已被人定稿的执行方案"
  },
  {
    name: "AI 不得自行降级人已定稿的方案",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: '    if (topology.humanFinalization?.outcome === "confirmed" && !downgradeApproved) {',
    to: "    if (false) {",
    expect: "已定稿方案被 AI 自行降级"
  },
  {
    // 人是照着这段字定稿的。截断本身要写在人看得见的那段字里，不能无痕。
    name: "AI 写给人读的问题正文截断必须留痕",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: '      detail: truncateForHuman(String(input.question?.detail || input.detail || ""), 4000, "问题正文"),',
    to: '      detail: String(input.question?.detail || input.detail || "").slice(0, 4000),',
    expect: "被无痕截断"
  },
  {
    name: "证据引用截断后要记下总数",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: "        return refs.length > 20\n          ? {evidenceRefs: refs.slice(0, 20), evidenceRefsTotal: refs.length}\n          : {evidenceRefs: refs};",
    to: "        return {evidenceRefs: refs.slice(0, 20)};",
    expect: "没有记下总数"
  },
  {
    name: "卡片上要说出证据引用的总数（界面这一层也截了一次）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "          const carded = Number(request.question?.evidenceRefsTotal || evidence.length);",
    to: "          const carded = evidence.length;",
    expect: "要说出总数"
  },
  {
    name: "人写的处置依据不许静默截断（规则源）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanWrittenTextIsNeverSilentlyTruncated",
    from: '    resolution.settlementJustification =\n      assertHumanTextWithinLimit(args.justification, "rule_source_settlement_justification", 2000);',
    to: "    resolution.settlementJustification = String(args.justification).slice(0, 2000);",
    expect: "被 slice 静默截断"
  },
  {
    name: "人写的处置依据不许静默截断（共享定义）",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyHumanWrittenTextIsNeverSilentlyTruncated",
    from: '    definition.resolutionJustification =\n      assertHumanTextWithinLimit(definitionJustification, "shared_definition_resolution_justification", 2000);',
    to: "    definition.resolutionJustification = definitionJustification.slice(0, 2000);",
    expect: "被 slice 静默截断"
  },
  {
    name: "人写文本判据的分母塌了要自报空转",
    file: "scripts/contract-check.mjs",
    check: "verifyHumanWrittenTextIsNeverSilentlyTruncated",
    from: 'sum + [...readFileSync(join(root, file), "utf8").matchAll(/assertHumanTextWithinLimit\\(/gu)].length, 0);',
    to: "sum + 0, 0);",
    expect: "本条在空转"
  },
  {
    // 定稿意见是人自己写下的那句话（"不选择（自定义输入）"那条路上它就是决定本身）。
    // 原先超过 4000 字是 slice 静默截断：台账上记的与人写的不是一句话，
    // 而人工闸门的全部意义就是"这句话是这个人说的"。
    name: "超长的定稿意见要拒，不许悄悄截断",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: '  const inputText = assertHumanTextWithinLimit(decision.inputText || "", "human_confirmation_input", 4000);',
    to: '  const inputText = String(decision.inputText || "").trim().slice(0, 4000);',
    expect: "超长的定稿意见没有被拒"
  },
  {
    name: "正常长度的定稿意见必须原样存下",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: "  request.decision = {selectedOptionId, selectedLabel: option.label, inputText, decidedBy: actor, decidedAt: at, action};",
    to: "  request.decision = {selectedOptionId, selectedLabel: option.label, inputText: String(inputText).slice(0, 10), decidedBy: actor, decidedAt: at, action};",
    expect: "没有被原样存下"
  },
  {
    name: "超长被拒时要说清超出多少",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: "    details: {limit, actual: text.length, over: text.length - limit,",
    to: "    details: {",
    expect: "没说超出多少"
  },
  {
    // 在界面上停用一条规则，agent 就不该再收到它。这条端到端的性质此前零覆盖：
    // 把内容包里的 activeSystemRules 换成 systemRules，契约门 138 条全过 ——
    // 人关掉一条安全规则、界面写着"已停用"，而执行方的提示词里它还在。
    name: "停用的系统规则不许出现在 agent 的内容包里",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyContentBundleNamesTheDispatchedItem",
    from: '  const systemRulesText = renderRules(config.activeSystemRules, "系统规则");',
    to: '  const systemRulesText = renderRules(config.systemRules, "系统规则");',
    expect: "仍然出现在 agent 的内容包里"
  },
  {
    name: "停用的业务规则同样不许出现（种子里没有业务规则，这一半要自己造）",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyContentBundleNamesTheDispatchedItem",
    from: '  const businessRulesText = renderRules(config.activeBusinessRules, "业务规则");',
    to: '  const businessRulesText = renderRules(config.businessRules, "业务规则");',
    expect: "停用的业务规则仍然出现"
  },
  {
    name: "业务规则必须真的下发（正面对照：不下发也要报红）",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyContentBundleNamesTheDispatchedItem",
    from: '  const businessRulesText = renderRules(config.activeBusinessRules, "业务规则");',
    to: '  const businessRulesText = "";',
    expect: "没有出现在 agent 的内容包里"
  },
  {
    // 派发与会话都存着 modelSelectionDecisionRef。被指着的那条决策一旦被容量裁掉，
    // 引用就悬空：人点进去看"这次为什么选了这个模型"只会看到空白。
    name: "容量裁剪必须留住仍被指着的记录",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyCapsKeepRecordsThatAreStillPointedAt",
    from: "  return stillReferenced.length ? [...kept, ...stillReferenced] : kept;",
    to: "  return kept;",
    expect: "被容量裁掉了"
  },
  {
    name: "容量上限不许形同虚设（没人引用时也不能全留）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyCapsKeepRecordsThatAreStillPointedAt",
    from: "  const kept = items.slice(0, cap);",
    to: "  const kept = items.slice(0);",
    expect: "裁剪结果不对"
  },
  {
    // push 前的 claim 复核是另一扇门：checkpoint 路由自己也有一道陈旧代次检查，
    // 所以这一支此前零覆盖。它失效＝失联后恢复的节点先把提交推上去，事后才被拒。
    name: "push 前的 claim 复核必须拒陈旧代次",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    gate: "agent",
    from: "  if (claimEpoch !== undefined && Number(claimEpoch) !== Number(dispatch.claimEpoch || 0)) {",
    to: "  if (false) {",
    expect: "放过了陈旧代次"
  },
  {
    // 去掉版本比对＝两个并发写互相覆盖，后写的静默吞掉前一个人的改动。
    name: "状态存储的版本比对（CAS）不得去掉",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    gate: "writer",
    from: "    throwStateStoreConflict(`runtime_json state version conflict; expected ${expectedStateVersion}, found ${central.stateVersion}`);",
    to: "    void 0;",
    expect: "没有第三种结局"
  },
  {
    name: "项目读授权失效要被逮到（存在性预言机那条抓得住）",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: '  if (resourceScope.resourceType === "project") return canReadProject(state, account, resourceScope.resourceId);',
    to: '  if (resourceScope.resourceType === "project") return true;',
    expect: "两者可分辨"
  },
  {
    // 口令比对失效＝任何口令都能登进系统管理员账号。此前它确实会被"限流没生效"那条撞出来，
    // 但那句话把人支去修限流 —— 归错因的报文比不报更坏。现在有一条点名的断言。
    name: "错的口令必须被拒（点名 invalid_credentials，不靠限流那条顺带撞出来）",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: '    const bootstrapOk = method === "bootstrap_token" && digestOf(`bootstrap:${token}`) === config.bootstrapTokenHash;',
    to: '    const bootstrapOk = method === "bootstrap_token";',
    expect: "错的口令被放行了"
  },
  {
    // 会话令牌比对失效＝任何令牌都会命中【第一个还活着的会话】，等于随便谁都能登进别人的账号。
    // 这条有覆盖（退出登录后旧令牌必须失效那条断言抓得到），但一直没登记过判别力证明。
    name: "会话令牌必须逐个比对摘要（否则任何令牌都命中第一个活会话）",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: "function authenticateRequest(req, state) {\n  const token = bearerToken(req);\n  if (!token) return null;\n  const tokenDigest = digestOf(`session:${token}`);\n  const session = (state.authSessions || []).find((item) => item.tokenDigest === tokenDigest",
    to: "function authenticateRequest(req, state) {\n  const token = bearerToken(req);\n  if (!token) return null;\n  const tokenDigest = digestOf(`session:${token}`);\n  const session = (state.authSessions || []).find((item) => true",
    expect: "expected revoked bearer to be rejected after logout"
  },
  {
    // 节点凭据摘要比对失效＝任何 aimac_node_ 开头的串都能冒充某个节点。
    // 此前三套 e2e 无一报红（只测了"不带令牌"）。
    name: "形状对、内容错的节点令牌不得被放行",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    gate: "agent",
    from: "  return (currentValid && node.credentialDigest === presentedDigest) || previousValid;",
    to: "  return currentValid || previousValid;",
    expect: "形状对、内容错的节点令牌被放行了"
  },
  {
    // 服务令牌摘要比对失效＝任何令牌都被当成 system_service 主体，整个 MCP 面免鉴权。
    // 此前三套 e2e 无一报红（只测了"不带令牌"，没测"带一个错的令牌"）。
    name: "带一个错的令牌不得被当成 MCP 服务主体",
    file: "apps/control-plane-ui/server.mjs",
    gate: "mcp",
    from: "  if (config.mcpServiceTokenHash === digestOf(`mcp-service:${token}`)) {",
    to: "  if (true) {",
    expect: "带一个错的令牌也被放行了"
  },
  {
    name: "「必须被拒」的断言只判「不是 200」要被逮到",
    file: "scripts/doctor.mjs",
    check: "verifyRejectionAssertionsNameTheirCode",
    from: '  if (configWhileSuspended.response.status !== 403\n    || configWhileSuspended.payload?.error !== "policy_denied") {',
    to: "  if (configWhileSuspended.response.status === 200) {",
    expect: "没点名拒绝码"
  },
  {
    name: "拒绝断言点名：提取脱节要自报空转",
    file: "scripts/contract-check.mjs",
    check: "verifyRejectionAssertionsNameTheirCode",
    from: "/\\.response\\.status\\s*(?:===|!==|>=|<)/gu",
    to: "/\\.responseX\\.status\\s*(?:===|!==|>=|<)/gu",
    expect: "本条在空转"
  },
  {
    // 组织被停用后，它的管理员不能再改配置/推执行。这条守卫此前【零覆盖】：
    // e2e 里那条断言只判"不是 200"，而它的请求没带 expectedConfigVersion，
    // 实际被 428 挡下 —— 把守卫整个删掉照样绿。
    name: "组织被停用后其管理员不得再改配置",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: '    if (scopedOrg && scopedOrg.status === "suspended") return false;',
    to: "    if (false) return false;",
    expect: "组织被暂停后其管理员仍能改配置"
  },
  {
    // 同一个幂等键配上不同的内容/动作/主体时必须 409。放过的话，第二笔【不同的】写请求
    // 会拿到第一笔的成功回执：调用方以为做成了，实际什么都没发生。
    name: "幂等键配了另一笔内容必须 409（否则拿到的是上一次的成功回执）",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: "    if (existingRecord.actor !== actor || existingRecord.action !== action\n      || subjectChanged || existingRecord.bodyDigest !== bodyDigest) {",
    to: "    if (false) {",
    expect: "expected idempotency conflict 409"
  },
  {
    // 作用域状态是按请求缓存的。缓存键里少了账号，第二个人就会拿到第一个人那份 ——
    // 整份跨租户数据，而单人自测完全看不出来（同一个账号命中的永远是自己那份）。
    // 这是本系统最致命的一条不变式，此前没有任何变异证明过它被守着。
    name: "作用域状态的缓存键必须含账号（少了就是整份跨租户串数据）",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: "  const key = `${account.accountId}:${session.sessionId}:${state.stateVersion}`;",
    to: "  const key = `shared:${state.stateVersion}`;",
    expect: "出现了别的租户的对象"
  },
  {
    name: "调用方给的 [null] 不许变成名为 null 的角色",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyGitRemoteGuardTwinsAgree",
    from: '  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];',
    to: '  return [...new Set((values || []).map((value) => String(value).trim()).filter(Boolean))];',
    expect: "变成了字符串留下来"
  },
  {
    name: "两侧的 git 失败原因要拼成同一句话",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyGitRemoteGuardTwinsAgree",
    from: '  const prefix = conclusions.length || !detail ? "" : "只有进度输出：";',
    to: '  const prefix = "";',
    expect: "不是同一句话"
  },
  {
    name: "控制面解析 git status 必须用 -z（否则中文文件名让提交走不通）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyGitStatusParsingSurvivesRealFilenames",
    from: '  const fields = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], "").split("\\0");',
    to: '  const fields = git(root, ["status", "--porcelain", "--untracked-files=all"], "").split("\\n");',
    expect: "没有用 -z"
  },
  {
    name: "agent 那份解析 git status 同样必须用 -z",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyGitStatusParsingSurvivesRealFilenames",
    from: '  const raw = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);',
    to: '  const raw = git(root, ["status", "--porcelain", "--untracked-files=all"]);',
    expect: "没有用 -z"
  },
  {
    name: "agent 那份 git 远端守卫落后于控制面就要被逮到",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyGitRemoteGuardTwinsAgree",
    from: '  const beforeSlash = value.split("/")[0];\n  if (beforeSlash.includes("::") && !beforeSlash.includes("[")) return false;\n  // Reject a host segment',
    to: "  // Reject a host segment",
    expect: "两份孪生实现不一致"
  },
  {
    name: "远端 agent 不许接受本地路径（会去读它自己主机上的仓库）",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyGitRemoteGuardTwinsAgree",
    from: "  return /^https?:\\/\\//iu.test(value) || /^git:\\/\\//iu.test(value);",
    to: "  return true;",
    expect: "读它自己主机上的仓库"
  },
  {
    name: "提不出 agent 那份远端守卫时要自报空转",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyGitRemoteGuardTwinsAgree",
    from: "function isSafeGitRemoteUrl(url) {",
    to: "function isSafeGitRemoteUrlX(url) {",
    expect: "在空转"
  },
  {
    name: "引用名以 - 开头 / 含 .. 要拒（字符集白名单挡不住这两种）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyGitRefGuardsAgree",
    from: '  if (value.startsWith("-") || value.includes("..")) return false;',
    to: "  if (false) return false;",
    expect: "判成安全"
  },
  {
    name: "agent 那份孪生实现放宽了就要被交叉核对逮到",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyGitRefGuardsAgree",
    from: '  if (ref.startsWith("-") || ref.includes("..") || /[\\s^~:?*[\\\\]/u.test(ref)) {',
    to: '  if (ref.startsWith("-") || /[\\s^~:?*[\\\\]/u.test(ref)) {',
    expect: "判断不一致"
  },
  {
    name: "正常分支名不许被拒（拒了项目配不出产出目标）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyGitRefGuardsAgree",
    from: "return /^[A-Za-z0-9._/-]+$/u.test(value);",
    to: "return /^[A-Za-z0-9._]+$/u.test(value);",
    expect: "正常分支名"
  },
  {
    name: "提不出 agent 那份检查时要自报空转",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyGitRefGuardsAgree",
    from: '  const ref = String(transfer.ref || "main");',
    to: '  const ref = String(transfer.refX || "main");',
    expect: "在空转"
  },
  {
    name: "产出路径不许向上穿越（写到仓库外面去）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyGitPathGuardRejectsEscapes",
    from: '!path.includes("..");',
    to: "true;",
    expect: "向上穿越"
  },
  {
    name: "白名单要逐条校验（夹带一条 ../ 就能扩大写入范围）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyGitPathGuardRejectsEscapes",
    from: "  return Array.isArray(paths) && paths.length > 0 && paths.every(canUseGitPath);",
    to: "  return Array.isArray(paths) && paths.length > 0;",
    expect: "夹带了一条"
  },
  {
    name: "通配模式不许把穿越的目标路径一起放行",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyGitPathGuardRejectsEscapes",
    from: "  if (!canUseGitPath(path)) return false;\n  return (allowlist || []).some((pattern) => {",
    to: "  return (allowlist || []).some((pattern) => {",
    expect: "通配模式不能把穿越一起放行"
  },
  {
    name: "带 @ 的 remote-helper 写法也要拒（user@host::payload）",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyGitRemoteGuardRejectsCommandTransports",
    from: '  if (beforeSlash.includes("::") && !beforeSlash.includes("[")) return false;',
    to: "  if (false) return false;",
    expect: "remote helper"
  },
  {
    name: "IPv6 地址不许被误伤（:: 在方括号内）",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyGitRemoteGuardRejectsCommandTransports",
    from: '  if (beforeSlash.includes("::") && !beforeSlash.includes("[")) return false;',
    to: '  if (beforeSlash.includes("::")) return false;',
    expect: "IPv6 的 scp 写法"
  },
  {
    name: "scp 写法里以 - 开头的主机名要拒（会被 ssh 当选项）",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyGitRemoteGuardRejectsCommandTransports",
    from: '  if (scp) return !scp[1].startsWith("-");',
    to: "  if (scp) return true;",
    expect: "会被 ssh 当选项"
  },
  {
    name: "正常 https 地址不许被拒（拒了这个项目根本推不上去）",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    check: "verifyGitRemoteGuardRejectsCommandTransports",
    from: '  if (/^(https?|git|file):\\/\\//iu.test(value)) return true;',
    to: '  if (/^(https?|git|file):\\/\\//iu.test(value)) return false;',
    expect: "正常地址被拒"
  },
  {
    name: "定稿人必须是【生效中】的账号（挂起的人不能定稿）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyOnlyLiveHumanAccountsCanFinalize",
    from: '  if (account.status !== "active") return false;',
    to: "  if (false) return false;",
    expect: "被挂起的人"
  },
  {
    name: "定稿人必须是人（服务账号不算）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyOnlyLiveHumanAccountsCanFinalize",
    from: "  return HUMAN_ACCOUNT_TYPES.includes(account.accountType);",
    to: "  return true;",
    expect: "服务账号"
  },
  {
    name: "账号不存在要干脆回 false，不是抛异常（定稿路由会 500）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyOnlyLiveHumanAccountsCanFinalize",
    from: "  if (!account) return false;",
    to: "  if (false) return false;",
    expect: "直接抛了异常"
  },
  {
    name: "并排的两个百分比要各自说清算法（73% 与 75% 同屏）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: '<div class="metric"><span>任务组平均进度</span>',
    to: '<div class="metric"><span>事项完成度</span>',
    expect: "要各自说清是怎么算的"
  },
  {
    name: "刚装完的监控页十一张空表要有一句话说清这是正常的",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "    nothingRanYetNotice,",
    to: '    "",',
    expect: "监控页要说清这是正常的以及下一步"
  },
  {
    name: "有执行记录时不许还挂着「还没有任何执行记录」",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "  const nothingRanYet = !eventsShown.length && !sessionsAll.length",
    to: "  const nothingRanYet = true || (!eventsShown.length && !sessionsAll.length)",
    expect: "有记录时不挂这条"
  },
  {
    name: "设置页那张仓库表也要走统一入口（否则同屏两处自相矛盾）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    gate: "console",
    from: "    repositories: projectRepositories(project),",
    to: "    repositories: base.repositories ?? [],",
    expect: "没被 effectiveProjectConfig 认出来"
  },
  {
    name: "派发终态副本少写一个＝已取消的派发会被当成还在跑",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    check: "verifyTerminalStatusListsAgree",
    from: '  agentDispatches: (item) => !["completed", "failed", "cancelled"].includes(item.status)',
    to: '  agentDispatches: (item) => !["completed", "failed"].includes(item.status)',
    expect: "被改短了"
  },
  {
    name: "终态副本少写一个状态＝那个状态上的任务组仍被当成活的",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    check: "verifyTerminalStatusListsAgree",
    from: '  taskGroups: (item) => !["closed", "aborted"].includes(item.status)',
    to: '  taskGroups: (item) => !["closed"].includes(item.status)',
    expect: "被改短了"
  },
  {
    name: "真人专属动作被改名＝那条保护静默失效",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyHumanOnlyActionNamesStillExist",
    from: '      systemScopedInvite ? "system_account_invite" : "account_invite",',
    to: '      systemScopedInvite ? "system_account_inviteX" : "account_inviteX",',
    expect: "已经没有对应的受守卫写入"
  },
  {
    name: "提取认不出三元写法就会把活的保护误报成失效",
    file: "scripts/contract-check.mjs",
    check: "verifyHumanOnlyActionNamesStillExist",
    from: 'for (const literal of server.slice(match.index, end).matchAll(/"([a-z_]+)"/gu)) guarded.add(literal[1]);',
    to: 'guarded.add(String(/beginGuardedWrite\\([^,]+,[^,]+,\\s*"([a-z_]+)"/u.exec(server.slice(match.index, end))?.[1] || ""));',
    expect: "已经没有对应的受守卫写入"
  },
  {
    name: "决策类型没归类＝悄悄落进运行级，人工闸门对它不存在",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyEveryDecisionTypeIsClassified",
    from: '  "task_split",               // 任务拆分',
    to: '  "task_splitX",               // 任务拆分',
    expect: "两边都没登记"
  },
  {
    name: "整份替换的字段漏进清单＝那个字段没有并发保护",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyWholesaleFieldListMatchesTheWrites",
    from: 'const REPLACING_CONFIG_FIELDS = ["systemRules", "businessRules", "repositories", "baselineData", "defaultRoles"];',
    to: 'const REPLACING_CONFIG_FIELDS = ["systemRules", "businessRules", "repositories", "baselineData"];',
    expect: "没有乐观并发保护"
  },
  {
    name: "记录上不许带表单不回传的字段（保存一次就会悄悄消失）",
    file: "data/seed-state.json",
    check: "verifySeedLooksLikeSomethingTheProductMade",
    from: '"defaultBranch": "main"',
    to: '"defaultBranch": "main", "purpose": "control_plane_specs_and_runtime"',
    expect: "表单不回传的字段"
  },
  {
    name: "种子缺时间戳要被逮到（任务组这一半）",
    file: "scripts/contract-check.mjs",
    check: "verifySeedLooksLikeSomethingTheProductMade",
    from: 'for (const field of ["createdAt", "updatedAt"]) {',
    to: 'for (const field of ["createdAt", "auditRef"]) {',
    expect: "缺时间戳"
  },
  {
    name: "种子缺时间戳要被逮到（工作项这一半）",
    file: "scripts/contract-check.mjs",
    check: "verifySeedLooksLikeSomethingTheProductMade",
    from: "if (!item.updatedAt) missing.push(`${group.id}/${item.id}.updatedAt`);",
    to: "if (!item.auditRef) missing.push(`${group.id}/${item.id}.updatedAt`);",
    expect: "缺时间戳"
  },
  {
    name: "读项目仓库不许绕开统一入口（两个字段会再次分叉）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyProjectRepositoriesHaveOneReader",
    from: '  const repository = projectRepositories(project)[0] || {id: "repo_control_plane"',
    to: '  const repository = project?.repositories?.[0] || {id: "repo_control_plane"',
    expect: "绕开了统一入口"
  },
  {
    name: "项目仓库要认界面写的那个字段（否则界面上有入口却接错线）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: "  const configured = project?.config?.repositories;",
    to: "  const configured = null;",
    expect: "接的却不是这根线"
  },
  {
    name: "只认配置层会让只有顶层字段的老项目集体卡死",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: "  return Array.isArray(project?.repositories) ? project.repositories : [];",
    to: "  return [];",
    expect: "老项目被判成没登记"
  },
  {
    name: "agentctl 指的入口要写成页+面板+按钮（否则判据看不见它）",
    file: "scripts/agentctl.mjs",
    check: "verifyGuidanceNamesRealPages",
    from: "到「AI 智能体」页的「加入令牌管理」面板点「签发一次性加入令牌」，",
    to: "项目管理界面上点「发加入令牌」，",
    expect: "没有这个按钮"
  },
  {
    name: "docker 启动失败要说清 .env 已经写好了（含密钥，不必删）",
    file: "scripts/docker-up.sh",
    check: "verifyInstallScriptSaysWhatItLeftBehind",
    from: `  printf '%s\\n' "  · 已经生成 $ENV_FILE（含随机密钥，权限 600）：装好 compose 后直接重跑即可，不必删它" >&2`,
    to: `  printf '%s\\n' "  · 装好 compose 后重跑" >&2`,
    expect: "没说清本机被改成什么样"
  },
  {
    name: "装机失败出口提取脱节要自报空转",
    file: "scripts/contract-check.mjs",
    check: "verifyInstallScriptSaysWhatItLeftBehind",
    from: "if (!/^\\s*exit 1\\s*$/u.test(line)) continue;",
    to: "if (!/^\\s*exit 11\\s*$/u.test(line)) continue;",
    expect: "本条在空转"
  },
  {
    name: "拒绝报文要说清这次到底执行了没有",
    file: "apps/control-plane-ui/public/i18n-zh.js",
    check: "verifyAmbiguousOutcomeRefusalsSayWhetherItTookEffect",
    from: "这次写请求没有带幂等键，因此没有执行：写接口要求每一笔都带 Idempotency-Key",
    to: "缺少幂等键：写接口要求每一笔都带 Idempotency-Key",
    expect: "没说【这次到底改没改成】"
  },
  {
    name: "原样重发注定失败的码不许把「请重试」当出口",
    file: "apps/control-plane-ui/public/i18n-zh.js",
    check: "verifyAmbiguousOutcomeRefusalsSayWhetherItTookEffect",
    from: "另一处同时改了同一份状态，你这次的改动没有写进去（是整笔被拒，不会只写一半）：刷新看一眼当前状态，再决定要不要重做",
    to: "状态写入冲突，没有写进去，请重试",
    expect: "无用的重试"
  },
  {
    name: "词条不见了要自报空转（拒绝结果确定性）",
    file: "apps/control-plane-ui/public/i18n-zh.js",
    check: "verifyAmbiguousOutcomeRefusalsSayWhetherItTookEffect",
    from: "    state_write_conflict:",
    to: "    state_write_conflictX:",
    expect: "这条判据在空转"
  },
  {
    name: "不许用没加书名号的英文页名指路（「到 agent 页」实测 4 处）",
    file: "apps/control-plane-ui/public/app.js",
    check: "verifyGuidanceNamesRealPages",
    from: "要么先到「AI 智能体」页把节点恢复",
    to: "要么先到 agent 页把节点恢复",
    expect: "没加书名号"
  },
  {
    name: "停摆提示要指出同一页上就能手动推一拍（连续失败那条）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "`请先看服务端日志定位原因。` + manualTickExit()",
    to: "`请先看服务端日志定位原因。`",
    expect: "停摆提示要指出本页就能手动推一拍"
  },
  {
    name: "静默停摆那条也要指出手动出口（两条分支各写各的会漏一条）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "      + manualTickExit() + `恢复之前，需要人推进的事只能手动来。</div>`;",
    to: "      + `恢复之前，需要人推进的事只能手动来。</div>`;",
    expect: "静默停摆那条也要指出手动推一拍的出口"
  },
  {
    name: "已吊销的节点必须离开舰队分母（否则叫人去修一台不存在的机器）",
    file: "apps/control-plane-ui/server.mjs",
    gate: "agent",
    from: 'total: (scopeCollection(scoped.agentRuntimeNodes) || []).filter((node) => node.status !== "revoked").length',
    to: "total: (scopeCollection(scoped.agentRuntimeNodes) || []).length",
    expect: "舰队分母把已吊销的节点也算了进去"
  },
  {
    name: "在线节点的分母不许把已吊销的算进去（同屏两个分母各算各的）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: 'const alive = (orgAgentNodes || []).filter((node) => node.status !== "revoked");',
    to: "const alive = (orgAgentNodes || []);",
    expect: "在线节点的分母不含已吊销的"
  },
  {
    name: "限流要报真实剩余秒数（写死 60 会让人白等满一分钟）",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: "retryAfterSeconds: loginRetryAfterSeconds(req)",
    to: "retryAfterSeconds: 60",
    expect: "不会随时间变小"
  },
  {
    name: "「X」处 这一说法也要被认成指路（登录页那句就是这么漏掉的）",
    file: "scripts/contract-check.mjs",
    check: "verifyGuidanceNamesRealPages",
    from: '(?:点[「“]([^」”]{2,16})[」”]|[「“]([^」”]{2,16})[」”](?:处|按钮))',
    to: '(?:点[「“]([^」”]{2,16})[」”])',
    expect: "本条在空转"
  },
  {
    name: "指路点名的控件不存在要报红（「X」处 形状）",
    file: "apps/control-plane-ui/public/app.js",
    check: "verifyGuidanceNamesRealPages",
    from: "可在顶栏「设置密码」处设置个人密码",
    to: "可在顶栏「修改口令」处设置个人密码",
    expect: "没有这个按钮"
  },
  {
    name: "三元里的按钮文字判据也要看得见（否则把对的指路判成错）",
    file: "scripts/contract-check.mjs",
    check: "verifyGuidanceNamesRealPages",
    from: 'for (const literal of body.matchAll(/"([^"]{2,32})"/gu)) labels.add(literal[1]);',
    to: "void body;",
    expect: "没有这个按钮"
  },
  {
    name: "报文让人去点的按钮必须真在界面上",
    file: "apps/control-plane-ui/public/app.js",
    check: "verifyGuidanceNamesRealPages",
    from: "整个任务组被人暂停了：到该任务组页点「恢复执行」",
    to: "整个任务组被人暂停了：到该任务组页点「重新开工」",
    expect: "没有这个按钮"
  },
  {
    name: "产品报文不得指路到界面上没有的页（实测「运行时」页 10 处）",
    file: "apps/control-plane-ui/public/app.js",
    check: "verifyGuidanceNamesRealPages",
    from: "让组织管理员到「AI 智能体」页核对该节点的自检结果",
    to: "到「运行时」页核对节点自检结果",
    expect: "界面上没有这个"
  },
  {
    name: "页名权威表提不出来要自报空转（否则 0 个页名＝谁都合法）",
    file: "scripts/contract-check.mjs",
    check: "verifyGuidanceNamesRealPages",
    from: 'app.matchAll(/^\\s*"[a-z-]+": \\["([^"]+)",/gmu)',
    to: 'app.matchAll(/^\\s*"[a-z-]+": \\[`([^`]+)`,/gmu)',
    expect: "本条在空转"
  },
  {
    name: "同一张表里同一个键写两遍要被逮住（后写的静默胜出）",
    file: "apps/control-plane-ui/public/app.js",
    check: "verifyHintMapsHaveNoDuplicateKeys",
    from: '  task_group_pause: "整个任务组被人暂停了：到该任务组页点「恢复执行」"',
    to: '  task_group_pause: "重复的第一条",\n  task_group_pause: "整个任务组被人暂停了：到该任务组页点「恢复执行」"',
    expect: "写了两遍"
  },
  {
    name: "只扫顶层字面量会漏掉 i18n 那张 966 条的 dict（缩进的）",
    file: "scripts/contract-check.mjs",
    check: "verifyHintMapsHaveNoDuplicateKeys",
    from: "      const open = line.match(/^(\\s*)const (\\w+) = \\{$/u);",
    to: "      const open = line.match(/^()const (\\w+) = \\{$/u);",
    expect: "本条在空转"
  },
  {
    name: "锁冲突时必须交代还有一份改坏的源码没还原",
    file: "scripts/lib/mutation-wreckage.mjs",
    check: "verifyLockConflictAdmitsTheWreckage",
    from: '  if (onDisk === note.original) return "";',
    to: '  if (onDisk !== "zzz") return "";',
    expect: "没说清"
  },
  {
    name: "已经还原好了就不许再吓人（假警报同样是坏报文）",
    file: "scripts/lib/mutation-wreckage.mjs",
    check: "verifyLockConflictAdmitsTheWreckage",
    from: "  if (onDisk === note.original) return \"\";",
    to: "  if (false) return \"\";",
    expect: "不该提残局"
  },
  {
    name: "残局描述写对了也得真被锁冲突分支念出来",
    file: "scripts/mutation-gate.mjs",
    check: "verifyLockConflictAdmitsTheWreckage",
    // 锚点拼起来写：本条改的是【本文件】里的真代码，而整串若原样出现在这一行，
    // 唯一性检查就会同时命中真代码和登记项自己（2 次）—— 拼接后本行不含完整串。
    from: "      + describePending" + "Wreckage(pendingNotePath));",
    to: '      + "");',
    expect: "没人念出来"
  },
  {
    name: "首屏指引不得点名界面上没有的页（我第一版就写错了这句）",
    file: "scripts/init-control-plane.mjs",
    check: "verifyFirstScreenPointsAtRealPlaces",
    from: "「账号与授权」页 → 在「智能体入网令牌」面板",
    to: "「智能体」页 → 在「一次性入网」面板",
    expect: "界面上没有的位置"
  },
  {
    name: "首屏界面名提取脱节要自报空转（否则 0 个名字＝永远绿）",
    file: "scripts/contract-check.mjs",
    check: "verifyFirstScreenPointsAtRealPlaces",
    from: "[...init.matchAll(/「([^」]{2,20})」/gu)]",
    to: "[...init.matchAll(/『([^』]{2,20})』/gu)]",
    expect: "本条在空转"
  },
  {
    name: "MCP 侧命中幂等记录必须直接回原结果（否则写工具会再跑一次）",
    file: "apps/mcp-server/server.mjs",
    check: "verifySideEffectsComeAfterTheGuard",
    from: "      } else if (existingRecord) {",
    to: "      } else if (false) {",
    expect: "MCP 侧找不到"
  },
  {
    name: "副作用必须在守卫之后（守卫前的写入不受重放保护）",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifySideEffectsComeAfterTheGuard",
    from: "  if (req.method === \"POST\" && url.pathname === \"/api/projects\") {",
    to: "  if (req.method === \"POST\" && url.pathname === \"/api/projects\") {\n    state.__probeTouched = true;",
    expect: "守卫之前】就改了状态"
  },
  {
    name: "副作用位置扫描打不到时必须红（不得绿着空转）",
    file: "scripts/contract-check.mjs",
    check: "verifySideEffectsComeAfterTheGuard",
    from: "const starts = [...server.matchAll(/if \\(req\\.method === \"(?:POST|PUT|PATCH|DELETE)\"/gu)].map((m) => m.index);\n  const early = [];",
    to: "const starts = [...server.matchAll(/if \\(req\\.methodX === \"(?:POST|PUT|PATCH|DELETE)\"/gu)].map((m) => m.index);\n  const early = [];",
    expect: "只扫到 0 条"
  },
  {
    name: "幂等重放不得真的写第二次（返回同 id 不等于没做两次）",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: "    state.projects.push({\n      id,\n      organizationId: projectOrgId,",
    to: "    state.projects.push({id: `${id}_dup`, organizationId: projectOrgId, name: body.name, status: \"active\"});\n    state.projects.push({\n      id,\n      organizationId: projectOrgId,",
    expect: "幂等重放把项目建了"
  },
  {
    name: "取消通道断了必须说出后果（人按了取消，节点照常推送）",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentSaysWhyItStoppedTakingWork",
    from: "    process.stderr.write(`control watcher stopped: ${error.message}`\n      + \" —— 本次派发从此收不到取消/暂停信号（agent 会照常跑完并推送），\"\n      + \"认领也不再续期，到期后可能被重排给别人；建议尽快重启本节点\\n\");",
    to: "    process.stderr.write(`control watcher stopped: ${error.message}\\n`);",
    expect: "取消通道断了"
  },
  {
    name: "节点主动停活必须说出后果（否则与'角色不匹配'长得一样）",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentSaysWhyItStoppedTakingWork",
    from: "        + \" —— 本节点在 outbox 清空前不再领新活；控制台上它仍显示在线，\"",
    to: "        + \" \"",
    expect: "没说这对人意味着什么"
  },
  {
    name: "节点告警的 marker 变了要报空转（判据不得绿着找不到）",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifyAgentSaysWhyItStoppedTakingWork",
    from: "dispatch claim deferred: ${outboxPending}",
    to: "dispatch claim postponed: ${outboxPending}",
    expect: "本条在空转"
  },
  {
    name: "算容量时量不到的文件不得当成 0（淘汰会因此不触发）",
    file: "apps/agent-runtime/runtime.mjs",
    check: "verifySizeAccountingDoesNotSwallowFailures",
    from: "try { size += statSync(join(dir, file)).size; } catch { unsizedFiles += 1; }",
    to: "try { size += statSync(join(dir, file)).size; } catch {}",
    expect: "静默当成 0"
  },
  {
    name: "事件日志的损坏行不得静默跳过（序号会被重用、幂等键会失效）",
    file: "apps/control-plane-ui/lib/project-event-store.mjs",
    check: "verifyCorruptEventLinesAreReported",
    from: "        corruptLines += 1;",
    to: "        corruptLines += 0;",
    expect: "静默跳过了"
  },
  {
    name: "损坏报文必须说清后果（只说'跳过了几行'不够）",
    file: "apps/control-plane-ui/lib/project-event-store.mjs",
    check: "verifyCorruptEventLinesAreReported",
    from: "      + `（样例 ${corruptSample}）—— 序号可能被重用、幂等键可能失效，请核对该文件`);",
    to: "      + \"\");",
    expect: "没说清后果"
  },
  {
    name: "宽松模式的非法转移必须进审计台账（只记在有上限的集合里会被顶掉）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyWarnModeRejectionsSurviveChurn",
    from: "    appendAuditEntry(state, {actor, action: \"transition_rejected_in_warn_mode\",",
    to: "    void 0 || ((x) => x)({actor, action: \"transition_rejected_in_warn_mode\",",
    expect: "没有进审计台账"
  },
  {
    name: "这条用例必须真的复现'被日常流量顶掉'（上限变大就该报空转）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyWarnModeRejectionsSurviveChurn",
    from: "  state.transitionEvidence = state.transitionEvidence.slice(0, 240);",
    to: "  state.transitionEvidence = state.transitionEvidence.slice(0, 24000);",
    expect: "本条在空转"
  },
  {
    name: "行号引用判据的文件枚举走空要报（找违规型判据会安静地全绿）",
    file: "scripts/contract-check.mjs",
    check: "verifyCommentsDoNotCiteLineNumbers",
    from: "    .filter((file) => /\\.(mjs|js|rb|sh)$/u.test(file) && !file.endsWith(\"mutation-gate.mjs\"));",
    to: "    .filter((file) => /\\.(mjsX|js|rb|sh)$/u.test(file) && !file.endsWith(\"mutation-gate.mjs\"));",
    expect: "本条在空转"
  },
  {
    name: "判据引用的提取走空要报（同上）",
    file: "scripts/contract-check.mjs",
    check: "verifyGateReferencesResolve",
    from: "for (const match of src.matchAll(/function\\s+(verify[A-Za-z0-9]+)/gu)) declared.add(match[1]);",
    to: "for (const match of src.matchAll(/functionX\\s+(verify[A-Za-z0-9]+)/gu)) declared.add(match[1]);",
    expect: "本条在空转"
  },
  {
    name: "兜底轮询要在实时通道正常时让路（否则双份负载）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "  if (Date.now() - realtimeLastMessageAt < 15000) return;",
    to: "  if (false) return;",
    expect: "兜底轮询无条件跑"
  },
  {
    name: "「最近收到过消息」这个时刻只能在 message 事件里打",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "    realtimeLastMessageAt = Date.now();\n    let message;",
    to: "    let message;",
    expect: "不是在 message 事件里打的"
  },
  {
    name: "每一句「正在加载」都要有对应的「取失败了」说法",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "function filterInput(placeholder = \"关键字过滤…\", key = \"\") {",
    to: "function filterInput(placeholder = \"正在加载关键字…\", key = \"\") {",
    expect: "没有失败态说法"
  },
  {
    name: "加载提示扫描打不到时必须红（不得绿着空转）",
    file: "scripts/console-behaviour-check.mjs",
    gate: "console",
    from: "const spots = [...appForLoading.matchAll(/正在加载[^`\"<]{0,24}/gu)];",
    to: "const spots = [...appForLoading.matchAll(/正在加載[^`\"<]{0,24}/gu)];",
    expect: "只找到 0 处"
  },
  {
    name: "任务组详情取失败时不许还说'正在加载'（第三处同形）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "  if (tgDetail.loadFailed) {",
    to: "  if (false) {",
    expect: "取失败时不许还说"
  },
  {
    name: "详情取失败必须记进 tgDetail（不记就永远停在'正在加载'）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "    loadFailed: Boolean(progressFailure),",
    to: "    loadFailed: false,",
    expect: "没有把失败记进"
  },
  {
    name: "详情的失败不得被吞（横幅要说清原因）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "  if (progressFailure) throw progressFailure;",
    to: "  void progressFailure;",
    expect: "失败被吞了"
  },
  {
    name: "账号退役一旦被接上，登记必须当场过期",
    file: "apps/mcp-server/server.mjs",
    check: "verifyInertMechanismsStayRegistered",
    from: "  account.status = \"suspended\";",
    to: "  account.status = \"retired\";",
    expect: "已经有人接上生产者"
  },
  {
    name: "账号退役登记的依据没了要报（登记不得指着不存在的东西）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyInertMechanismsStayRegistered",
    from: "    if ([\"disabled\", \"suspended\", \"retired\"].includes(account.status)) continue;",
    to: "    if ([\"disabled\", \"suspended\"].includes(account.status)) continue;",
    expect: "那条 retired 排除已经不在了"
  },
  {
    name: "夹具传的值不得被产品钳掉（钳掉就测到了别的值）",
    file: "scripts/doctor-agent-remote.mjs",
    check: "verifyEnvValuesAreNotSilentlyClamped",
    from: "  const capMb = 64;",
    to: "  const capMb = 32;",
    expect: "处会被改写"
  },
  {
    name: "钳制提取源缩小时必须报空转（分母静静变小看不出来）",
    file: "scripts/contract-check.mjs",
    check: "verifyEnvValuesAreNotSilentlyClamped",
    from: "\"apps/control-plane-ui/lib/control-plane-core.mjs\", \"apps/agent-runtime/runtime.mjs\"]) {",
    to: "\"apps/control-plane-ui/lib/control-plane-core.mjs\"]) {",
    expect: "这道门在空转"
  },
  {
    name: "不走守卫的写路由也要留痕（否则事后完全无迹可循）",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyGuardedWritesAreAudited",
    from: "    audit(state, \"auth-service\", \"auth_logout\"",
    to: "    void (\"auth-service\", \"auth_logout\"",
    expect: "既不走守卫、也不留痕"
  },
  {
    name: "写路由枚举打不到时必须红（不得绿着空转）",
    file: "scripts/contract-check.mjs",
    check: "verifyGuardedWritesAreAudited",
    from: "const writeStarts = [...server.matchAll(/if \\(req\\.method === \"(?:POST|PUT|PATCH|DELETE)\"/gu)].map((m) => m.index);",
    to: "const writeStarts = [...server.matchAll(/if \\(req\\.methodX === \"(?:POST|PUT|PATCH|DELETE)\"/gu)].map((m) => m.index);",
    expect: "只扫到 0 条"
  },
  {
    name: "每一次守卫写入都要留痕（事后要答得出谁改的）",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyGuardedWritesAreAudited",
    from: "    audit(state, guard.actor, \"project_config_update\", `Project:${project.id}`);",
    to: "    void 0;",
    expect: "没有留下审计条目"
  },
  {
    name: "守卫写入扫描打不到时必须红（不得绿着空转）",
    file: "scripts/contract-check.mjs",
    check: "verifyGuardedWritesAreAudited",
    from: "const guards = [...server.matchAll(/beginGuardedWrite\\(\\s*\\n?\\s*req,",
    to: "const guards = [...server.matchAll(/beginGuardedWriteX\\(\\s*\\n?\\s*req,",
    expect: "只扫到 0 处"
  },
  {
    name: "白名单拒绝必须带上白名单（否则调用方只能穷举重试）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyWhitelistRefusalsCarryTheWhitelist",
    from: "        manifestPath, changedPaths: changedPaths.slice(0, 20)};",
    to: "        manifestPath};",
    expect: "没把白名单给出去"
  },
  {
    name: "白名单扫描打不到时必须红（不得绿着空转）",
    file: "scripts/contract-check.mjs",
    check: "verifyWhitelistRefusalsCarryTheWhitelist",
    from: "    \"apps/control-plane-ui/lib/state-store.mjs\", \"apps/control-plane-ui/lib/transition-engine.mjs\",",
    to: "",
    expect: "只扫到 9 处"
  },
  {
    name: "产出目标被拒要说出是哪条路径（裸码让 agent 无从自纠）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "    payload.path ? `涉及的路径：${payload.path}` : \"\",",
    to: "        \"\",",
    expect: "没有到达人"
  },
  {
    name: "race 里的长超时必须 unref（否则活儿做完了进程还吊在上限）",
    file: "scripts/doctor-mcp.mjs",
    check: "verifyRaceTimeoutsDoNotHoldTheProcess",
    from: "setTimeout(resolveWait, 3000).unref())]);",
    to: "setTimeout(resolveWait, 3000))]);",
    expect: "会把进程吊到上限"
  },
  {
    name: "长超时扫描打不到时必须红（不得绿着空转）",
    file: "scripts/contract-check.mjs",
    check: "verifyRaceTimeoutsDoNotHoldTheProcess",
    from: "for (const race of source.matchAll(/Promise\\.race\\(\\[/gu)) {",
    to: "for (const race of source.matchAll(/PromiseX\\.race\\(\\[/gu)) {",
    expect: "只扫到 0 处"
  },
  {
    name: "文档点名的接口必须真存在（照着它接入的人会撞 404）",
    file: "docs/core-control-plane-spec.md",
    check: "verifyDocumentedApiPathsExist",
    from: "| POST | `/api/integration-batches` | 创建集成批次 | release、orchestrator |",
    to: "| POST | `/api/integration-batches-v2` | 创建集成批次 | release、orchestrator |",
    expect: "撞 404"
  },
  {
    name: "已经建好的接口要从'还没建'清单里摘掉（留着会骗人）",
    file: "scripts/contract-check.mjs",
    check: "verifyDocumentedApiPathsExist",
    from: "    \"/api/integration-batches\": \"集成批次实体尚未落地\",",
    to: "    \"/api/orchestrator/run\": \"假装它还没建\",",
    expect: "已经建好了"
  },
  {
    name: "暂停要说出叫停了几个在跑的派发（停住了与本来就没有是两件事）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "        toast.success(stopped ? `已暂停任务组，并叫停了 ${stopped} 个在跑的派发` : \"已暂停任务组：当前没有在跑的派发\");",
    to: "        toast.success(\"已暂停任务组\");",
    expect: "暂停时说的是"
  },
  {
    name: "编排这一拍被挡住时不得说成'已触发'（人会以为成功了）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "      const blocked = (cycle?.changed || []).filter((item) => item?.status === \"blocked_resource\");",
    to: "      const blocked = [];",
    expect: "被挡住时说的是"
  },
  {
    name: "'跑了没事做'与'推进了N项'不得共用一句话",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "      toast.success(advanced ? `已触发编排循环，推进了 ${advanced} 项` : \"已触发编排循环：本轮没有可推进的事项\");",
    to: "      toast.success(\"已触发编排循环\");",
    expect: "空转一拍说的是"
  },
  {
    name: "引用字段登记里的名字打错要被抓到（打错＝静默不查）",
    file: "scripts/contract-check.mjs",
    check: "verifyLongLivedRecordsDoNotPointAtCappedOnes",
    from: "    decisionRecordRef: \"decisionRecords\",",
    to: "    decisionRef: \"decisionRecords\",",
    expect: "根本不存在"
  },
  {
    name: "长期记录不得指向有上限的集合（改对名字后这一项真的在查）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyLongLivedRecordsDoNotPointAtCappedOnes",
    from: "  state.repositoryOutputs.push(target);",
    to: "  state.repositoryOutputs.push({...target, decisionRecordRef: \"dr_x\"});",
    expect: "指向有上限的 decisionRecords"
  },
  {
    name: "门里的编排周期不得联网同步（静态门不该依赖外网）",
    file: "scripts/contract-check.mjs",
    check: "verifyGatesDoNotCloneFromTheNetwork",
    from: "core.runAutonomousCycle(probe, {root, mode: \"all\", autoSyncSkills: false});",
    to: "core.runAutonomousCycle(probe, {root, mode: \"all\"});",
    expect: "没关技能同步"
  },
  {
    name: "联网同步扫描打不到时必须红（不得绿着空转）",
    file: "scripts/contract-check.mjs",
    check: "verifyGatesDoNotCloneFromTheNetwork",
    from: "for (const match of source.matchAll(/runAutonomousCycle\\(/gu)) {",
    to: "for (const match of source.matchAll(/runAutonomousCycIe\\(/gu)) {",
    expect: "只扫到 0 处"
  },
  {
    name: "每个分片集合都必须真的比对过（漏一个就没人验它的拆合）",
    file: "scripts/contract-check.mjs",
    check: "verifyShardRoundTripKeepsEveryRecord",
    from: "  if (probe[collection].length) return;",
    to: "  if (probe[collection].length || collection === \"humanDirectives\") return;",
    expect: "一条记录都没比对到"
  },
  {
    name: "空转期间心跳必须真的往前走（合并等待窗口后仍要能红）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    gate: "idle",
    from: "    lastTickAt: at,",
    to: "    lastTickAt: \"2026-01-01T00:00:00.000Z\",",
    expect: "空转期间控制台仍看得到自治循环在跑"
  },
  {
    name: "整份替换配置必须带版本前置条件（后保存的会静默盖掉前一个人）",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyWholesaleConfigWritesArePreconditioned",
    from: "    const taskGroupPrecondition = configPreconditionFailure(body, taskGroup.config",
    to: "    const taskGroupPrecondition = noPrecondition(body, taskGroup.config",
    expect: "没有版本前置条件"
  },
  {
    name: "整份替换的提取形状失效必须报空转（不得静静少查）",
    file: "scripts/contract-check.mjs",
    check: "verifyWholesaleConfigWritesArePreconditioned",
    from: "const writes = [...server.matchAll(/\\{(\\w+): Array\\.isArray\\(body\\.(\\w+)\\) \\? body\\.\\2 : \\[\\]\\}/gu)];",
    to: "const writes = [...server.matchAll(/\\{(\\w+): ArrayX\\.isArray\\(body\\.(\\w+)\\) \\? body\\.\\2 : \\[\\]\\}/gu)];",
    expect: "只提取到 0 处"
  },
  {
    name: "加载失败的空表不得说'暂无数据'（那是在断言确实没有）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "  return lastError ? `${what}没能加载出来（原因见页面顶部的横幅）` : \"暂无数据\";",
    to: "  return \"暂无数据\";",
    expect: "失败时空表说的是"
  },
  {
    name: "三张独立取数的表都要接上（漏一张就照旧说暂无数据）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "      {emptyText: listEmptyText(\"组织列表\")})",
    to: "      {})",
    expect: "只被用了"
  },
  {
    name: "系统概览取失败时不许还说'正在加载'（人会一直等）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "  ].join(\"\") : panel(\"系统概览\", `<div class=\"notice\">${systemOverviewStatus === \"failed\"",
    to: "  ].join(\"\") : panel(\"系统概览\", `<div class=\"notice\">${false",
    expect: "取失败时不许还说"
  },
  {
    name: "取概览失败必须置成 failed（不置就永远停在'正在加载'）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "      systemOverviewStatus = overviewResult ? \"loaded\" : \"failed\";",
    to: "      systemOverviewStatus = \"unloaded\";",
    expect: "没有置 failed 的接线"
  },
  {
    name: "控制台自身缺陷不得说成'连不上控制面'（会把人支去查网络）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "        ${lastError ? `<div class=\"notice warn-notice\">${lastErrorIsRequest",
    to: "        ${lastError ? `<div class=\"notice warn-notice\">${true",
    expect: "控制台自身缺陷被说成了"
  },
  {
    name: "请求级失败必须都打记号（漏一处就会被说成控制台的缺陷）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "    throw requestFailure(new Error(`${response.status}",
    to: "    throw (new Error(`${response.status}",
    expect: "处请求级抛出打了记号"
  },
  {
    name: "组织/账号的 active 不能说成'进行中'（一个全局键盖住了别的意思）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "  const label = STATUS_LABEL_BY_KIND[kind]?.[value];",
    to: "  const label = null;",
    expect: "说的是它自己的那个词"
  },
  {
    name: "状态格必须真走按对象那层（覆盖表写了没人用＝白写）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "    statusBadge(\"organization\", org.status),",
    to: "    badge(org.status),",
    expect: "还在走全局 badge()"
  },
  {
    name: "要不到的那一页必须说出来（不得默默换一页给人）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "    if (requestedPage && requestedPage !== page) {",
    to: "    if (false) {",
    expect: "换页时什么都没说"
  },
  {
    name: "首次进入不得打扰（对照：默认页本来就是正确答案）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "    if (requestedPage && requestedPage !== page) {\n",
    to: "    if (true) {\n",
    expect: "首次进入却弹了提示"
  },
  {
    name: "没有工作项的任务组不得算作 100%（新建的组会显示'已完成'）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyEmptyTaskGroupIsNotComplete",
    from: "    : 0;",
    to: "    : 100;",
    expect: "人会以为它已经做完了"
  },
  {
    name: "进度不得一律返回 0（正面对照：有活时要算平均）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyEmptyTaskGroupIsNotComplete",
    from: "  taskGroup.progress = items.length\n",
    to: "  taskGroup.progress = false\n",
    expect: "应为 80"
  },
  {
    name: "种子里存的进度必须与它自己的工作项对得上",
    file: "data/seed-state.json",
    check: "verifyEmptyTaskGroupIsNotComplete",
    from: "\"progress\": 80,",
    to: "\"progress\": 71,",
    expect: "存的进度是 71%"
  },
  {
    name: "变量转发的拒绝码也要有中文（控制台真会显示它们）",
    file: "apps/control-plane-ui/public/i18n-zh.js",
    check: "verifyEveryCloseGateHasHumanGuidance",
    from: "    high_risk_no_self_approval: \"高风险变更不能由提出人自己批准：请另找一位有批准权限的人\",\n",
    to: "",
    expect: "原样显示英文"
  },
  {
    name: "转发路径的码必须进入核对面（收集了没人用＝静静少查）",
    file: "scripts/contract-check.mjs",
    check: "verifyEveryCloseGateHasHumanGuidance",
    from: "    ...forwardedCodes\n",
    to: "    ...[]\n",
    expect: "没有进入核对面"
  },
  {
    name: "导入名提取失效必须报空转（不得静静少查一整条路）",
    file: "scripts/contract-check.mjs",
    check: "verifyEveryCloseGateHasHumanGuidance",
    from: "mcp-server\\/server\\.mjs\";/u",
    to: "mcp-serverX\\/server\\.mjs\";/u",
    expect: "一个都没提取到"
  },
  {
    name: "每种状态故障类型都要有中文（出事那一刻不能甩英文码）",
    file: "apps/control-plane-ui/public/i18n-zh.js",
    check: "verifyStorageFaultKindsHaveChinese",
    from: "    runtime_dir_replaced: \"运行目录已被换成另一份，不是启动时那个\",\n",
    to: "",
    expect: "没有中文"
  },
  {
    name: "界面必须把故障类型翻成中文（词表有而界面不查＝白写）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "payload.kind && payload.quota === undefined ? `故障类型：${t(payload.kind)}` : \"\",",
    to: "payload.kind ? `故障类型：${payload.kind}` : \"\",",
    expect: "出事那一刻甩给人一个英文标识符"
  },
  {
    name: "真词表对照要能红（词表没加载时上面那条会误判）",
    file: "scripts/console-behaviour-check.mjs",
    gate: "console",
    from: "const realProbe = loadConsole(el(\"div\"), {realI18n: true});",
    to: "const realProbe = loadConsole(el(\"div\"));",
    expect: "真词表没加载上"
  },
  {
    name: "输出超上限要说是超上限（不能混进通用失败让人去查网络）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutorFailuresSayWhichKind",
    from: "if (result?.error?.code === \"ENOBUFS\") {",
    to: "if (false) {",
    expect: "「输出超上限」报的码不对"
  },
  {
    name: "执行器没留下原因时要说出来（不能给个冒号后什么都没有的码）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutorFailuresSayWhichKind",
    from: "return `agent_runtime_executor_failed:${detail || `执行器以退出码 ${result?.status} 结束，stderr 与 stdout 都是空的`}`;",
    to: "return `agent_runtime_executor_failed:${detail}`;",
    expect: "没有说清原因"
  },
  {
    name: "失败分类必须真接在子进程之后（写了没人用＝白写）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyExecutorFailuresSayWhichKind",
    from: "const spawnFailure = classifyExecutorSpawnFailure(result);",
    to: "const spawnFailure = null;",
    expect: "没有接上 classifyExecutorSpawnFailure"
  },
  {
    name: "租约必须按可见产出过滤（一条租约会说出那边有人正持着写入边界）",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: "cloned.leases = (state.leases || []).filter((lease) => visibleOutputRefs.has(lease.resourceRef));",
    to: "cloned.leases = (state.leases || []);",
    expect: "拿到了它的租约"
  },
  {
    name: "租约的正面对照要落在被过滤的那条分支上（清空就该红）",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: "cloned.leases = (state.leases || []).filter((lease) => visibleOutputRefs.has(lease.resourceRef));\n",
    to: "cloned.leases = [];\n",
    expect: "其实在空转"
  },
  {
    name: "「当前展示 N 条」必须等于真实截断数（两处写死的数会各走各的）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "moreText(eventsInScope.length, 10, \"agentExecutionEvents\")",
    to: "moreText(eventsInScope.length, 25, \"agentExecutionEvents\")",
    expect: "真实截到 10 条，提示说 25 条"
  },
  {
    name: "两数配对打不到时必须红（不得绿着空转）",
    file: "scripts/console-behaviour-check.mjs",
    gate: "console",
    from: "const notice = /moreText\\(/u.exec(call);",
    to: "const notice = /moreTexx\\(/u.exec(call);",
    expect: "只配上 0 对数"
  },
  {
    name: "有展示上限的表必须报总数（静默截断＝以为看到的就是全部）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "      {moreText: moreText(eventsInScope.length, 10, \"agentExecutionEvents\")})),",
    to: "      {})),",
    expect: "静默截断"
  },
  {
    name: "静默截断扫描打不到时必须红（不得绿着空转）",
    file: "scripts/console-behaviour-check.mjs",
    gate: "console",
    from: "for (const match of appSource.matchAll(/\\btable\\(/gu)) {",
    to: "for (const match of appSource.matchAll(/\\btabIe\\(/gu)) {",
    expect: "扫描没打到该打的地方"
  },
  {
    name: "字符串截断是被规则排除、不是碰巧没撞上（不切 .map 就该误报）",
    file: "scripts/console-behaviour-check.mjs",
    gate: "console",
    from: "const beforeMap = definition.split(\".map(\")[0];",
    to: "const beforeMap = definition;",
    expect: "静默截断"
  },
  {
    name: "过滤筛光时要说'没有匹配某词的行'，不能只说'暂无数据'",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "return `没有匹配「${query}」的行${hiddenCount > 0 ? `（${hiddenCount} 行被过滤条件隐藏）` : \"\"}`;",
    to: "return \"暂无数据\";",
    expect: "过滤没匹配时说的是"
  },
  {
    name: "文案必须真挂到空表上（纯函数写了没人用＝人看不到）",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "row.querySelector(\".empty-cell\").textContent = filteredEmptyText(raw, hidden.length);",
    to: "row.querySelector(\".empty-cell\").textContent = \"\";",
    expect: "根本没调这个文案函数"
  },
  {
    name: "点名的判据必须真存在（失效的覆盖承诺＝以为有人管）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyGateReferencesResolve",
    from: "见 applyHumanFinalization",
    to: "见 verifyHumanFinalizationIsLocked",
    expect: "点名了一条【不存在】的判据"
  },
  {
    name: "历史注记是被规则豁免、不是被扫描漏掉（去掉'已删除'就该红）",
    file: "scripts/contract-check.mjs",
    check: "verifyGateReferencesResolve",
    from: "已删除：它测的是本文件自造的一段模拟",
    to: "不再有：它测的是本文件自造的一段模拟",
    expect: "点名了一条【不存在】的判据"
  },
  {
    name: "注释不得用行号指代代码（行号会漂，引用却看着仍权威）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyCommentsDoNotCiteLineNumbers",
    from: "见 parseRoleSkillFile 的返回值",
    to: "parseRoleSkillFile 第 3271 行",
    expect: "用【行号】指代代码"
  },
  {
    name: "百分比不得裸用 0 兜底（没上报过≠上报了 0）",
    file: "apps/control-plane-ui/public/app.js",
    check: "verifyMeasurementsDoNotFakeZero",
    from: '{v: percentCell(dispatch.progressPercent), c: "num"},',
    to: '{v: `${esc(dispatch.progressPercent || 0)}%`, c: "num"},',
    expect: "percentCell 只被用了"
  },
  {
    name: "语种名要显示中文，不能把后端的英文名摆上去",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: '  return known ? known[1] : (policy?.languageName || tag || "中文");',
    to: '  return policy?.languageName || tag || "中文";',
    expect: "语种名要显示中文"
  },
  {
    name: "没上报过进度不得显示成 0%",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: '  return value === undefined || value === null || value === "" ? "—" : `${esc(value)}%`;',
    to: "  return `${esc(value || 0)}%`;",
    expect: "没上报过进度"
  },
  {
    name: "变异挂错门要被静态门看见（不必等 565 秒的全量跑）",
    file: "scripts/mutation-gate.mjs",
    check: "verifyMutationsAreRegisteredAgainstTheRightGate",
    from: '    name: "认不出的控制命令回执状态不得当成已接受",\n    file: "apps/control-plane-ui/lib/agent-gateway.mjs",\n    gate: "agent",',
    to: '    name: "认不出的控制命令回执状态不得当成已接受",\n    file: "apps/control-plane-ui/lib/agent-gateway.mjs",\n    gate: "doctor",',
    expect: "挂错了门"
  },
  {
    name: "指一个不存在的产出目标必须当场拒",
    file: "apps/mcp-server/server.mjs",
    gate: "mcp",
    from: 'if (!target) return {allowed: false, error: "repository_output_target_not_found", required: targetRef};',
    to: 'if (!target) return {allowed: false, error: "generic_rejected", required: targetRef};',
    expect: "没有给出该给的拒绝码"
  },
  {
    name: "查无此人工确认卡必须给出该给的拒绝码",
    file: "apps/mcp-server/server.mjs",
    gate: "mcp",
    from: 'if (!confirmation || !confirmationReadableByPrincipal(confirmation, context)) return {ok: false, error: "human_confirmation_not_found"};\n      return {request: confirmation};',
    to: 'if (!confirmation) return {ok: false, error: "generic_rejected"};\n      return {request: confirmation};',
    expect: "没有给出该给的拒绝码"
  },
  {
    name: "传了却会被钳制的环境变量要被门看见",
    file: "scripts/idle-tick-gate.mjs",
    check: "verifyEnvValuesAreNotSilentlyClamped",
    from: "const requestedTickMs = 5000;",
    to: "const requestedTickMs = 3000;",
    expect: "传了却会被静默改写"
  },
  {
    name: "多传的参数会被静默丢掉，要被门看见",
    file: "scripts/contract-check.mjs",
    check: "verifyCallsDoNotPassIgnoredArguments",
    from: "const freezeResult = runAutonomousCycle(freezeState, {taskGroupId: freezeTg.id, root});",
    to: "const freezeResult = runAutonomousCycle(freezeState, {taskGroupId: freezeTg.id}, {root});",
    expect: "多传了参数"
  },
  {
    name: "淘汰要和写入在同一侧（MCP 写、只有 UI 淘汰＝那条路径上无限长）",
    file: "apps/mcp-server/server.mjs",
    check: "verifyLongLivedRecordsDoNotPointAtCappedOnes",
    from: "export function assignWorkItem(state, args) {",
    to: 'export function assignWorkItem(state, args) {\n  state.decisionRecords.push({decisionId: "probe"});',
    expect: "只在 server.mjs 里淘汰"
  },
  {
    name: "仍被引用的决策不许被容量挤掉（静态门与 e2e 各守一半）",
    check: "verifyLongLivedRecordsDoNotPointAtCappedOnes",
    file: "apps/control-plane-ui/lib/state-store.mjs",
    from: "  state.policyDecisions = stillReferenced.length ? [...kept, ...stillReferenced] : kept;",
    to: "  state.policyDecisions = kept;",
    expect: "会变成悬空引用"
  },
  {
    name: "项目属主必须是真实存在的账号",
    file: "apps/mcp-server/server.mjs",
    gate: "mcp",
    from: '    return {ok: false, error: "owner_account_not_found"};',
    to: '    return {ok: false, error: "generic_rejected"};',
    expect: "同一个 id 建两次没有被拒"
  },
  {
    name: "版本冲突退回的必须是 state_write_conflict",
    file: "apps/control-plane-ui/server.mjs",
    gate: "writer",
    from: '    json(res, 409, {error: "state_write_conflict", retryable: true, message: error.message});',
    to: '    json(res, 409, {error: "write_conflict", retryable: true, message: error.message});',
    expect: "版本冲突退回的必须是 state_write_conflict"
  },
  {
    name: "清单路径必须是 git 跟得住的",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: '    return {accepted: false, status: 400, error: "artifact_manifest_must_be_git_trackable"};',
    to: '    return {accepted: false, status: 400, error: "generic_rejected"};',
    expect: "清单路径用绝对路径"
  },
  {
    name: "定下方案定稿要求必须写理由",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: '    if (!justification) return json(res, 400, {error: "plan_finalization_justification_required"});',
    to: '    if (false) return json(res, 400, {error: "plan_finalization_justification_required"});',
    expect: "不写理由就定下方案定稿要求"
  },
  {
    name: "畸形 URL 必须当场拒，不得打断请求处理",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: '      json(res, 400, {error: "invalid_request_url"});',
    to: '      json(res, 400, {error: "bad_request"});',
    expect: "畸形 URL 没有被当场拒"
  },
  {
    name: "404 要回显是哪一次请求",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: '  json(res, 404, {error: "api_not_found", method: req.method, path: url.pathname,',
    to: '  json(res, 404, {error: "api_not_found", method: req.method,',
    expect: "404 报文没有回显是哪一次请求"
  },
  {
    name: "不报产出目标必须拒（没人知道这次提交该落到哪个仓库）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: '    return {accepted: false, status: 409, error: "repository_output_target_missing"};',
    to: '    return {accepted: false, status: 409, error: "generic_rejected"};',
    expect: "一个产出目标都不报"
  },
  {
    name: "认不出的拓扑动作必须拒",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: '    return {ok: false, error: "execution_topology_unknown_action"',
    to: '    return {ok: false, error: "generic_rejected"',
    expect: "认不出的动作没有被拒"
  },
  {
    name: "往不存在的分支上写结果必须拒",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: '    if (!branch) return {ok: false, error: "execution_topology_branch_not_found"',
    to: '    if (!branch) return {ok: false, error: "generic_rejected"',
    expect: "不存在的分支没有被拒"
  },
  {
    name: "core 的 alreadyTerminal 标志必须在 REST 层翻成拒绝码",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: '    if (result.alreadyTerminal) return json(res, 409, {error: "execution_topology_already_terminal", topology: result.topology});',
    to: "    if (result.alreadyTerminal) return json(res, 200, result.topology);",
    expect: "没有在 REST 层被翻成"
  },
  {
    name: "报错了当前口令就不许改密",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: '      if (!currentOk) return json(res, 403, {error: "current_password_incorrect"});',
    to: '      if (false) return json(res, 403, {error: "current_password_incorrect"});',
    expect: "报错了当前口令就不许改密"
  },
  {
    name: "同一个 id 建两次必须撞，不得静默覆盖",
    file: "apps/mcp-server/server.mjs",
    gate: "mcp",
    from: "  if (state.projects.some((item) => item.id === projectId)) ret",
    to: "  if (false) ret",
    expect: "同一个 id 建两次没有被拒"
  },
  {
    name: "MCP 工具拿到不存在的 id 必须给出该给的拒绝码",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    gate: "mcp",
    from: '  if (!finding) return {ok: false, error: "finding_not_found"};',
    to: '  if (false) return {ok: false, error: "finding_not_found"};',
    expect: "没有给出该给的拒绝码"
  },
  {
    name: "派发绑定的授权必须把省掉的作用域补成自己那条",
    file: "apps/mcp-server/server.mjs",
    gate: "mcp",
    from: "    taskGroupId: args.taskGroupId || grantCheck.scope.taskGroupId,",
    to: "    taskGroupId: args.taskGroupId,",
    expect: "服务端没有把它补成这条派发自己的房间"
  },
  {
    name: "自治循环静默停摆（不报错只是不跑了）也要说出来",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: "  if (failures < 2 && Number.isFinite(tickAgeMs) && intervalMs > 0\n    && tickAgeMs > Math.max(intervalMs * 5, 3 * 60 * 1000)) {",
    to: "  if (false) {",
    expect: "自治循环静默停摆"
  },
  {
    name: "盘写不进去时健康页必须转 degraded",
    file: "apps/control-plane-ui/server.mjs",
    gate: "crash",
    from: '    lastStorageFault = {kind: "state_storage_unavailable", file: basename(statePath), code: error.code, at: now()};',
    to: "    // 不登记",
    expect: "盘不可写时健康页必须转 degraded"
  },
  {
    name: "盘不可写的复核要按可写性，不能问读得出来吗",
    file: "apps/control-plane-ui/server.mjs",
    gate: "crash",
    from: "          try { accessSync(dirname(statePath), fsConstants.W_OK); recovered = true; } catch { recovered = false; }",
    to: "          try { readHealthState(); recovered = true; } catch { recovered = false; }",
    expect: "盘不可写时健康页必须转 degraded"
  },
  {
    name: "tools/list 成本判据的空转守卫要能红",
    file: "apps/control-plane-ui/lib/mcp-service-allowlist.mjs",
    check: "verifyMcpToolListCostStaysVisible",
    from: "  const tools = configured.length ? configured : defaultMcpServiceToolAllowlist;",
    to: "  const tools = configured.length ? configured : [];",
    expect: "取不到服务令牌的默认放行清单"
  },
  {
    name: "登记成机器面的错误码，控制台不得调得到那条路由",
    file: "scripts/contract-check.mjs",
    check: "verifyMachineFacingErrorsAreOutOfConsoleReach",
    from: '  room_task_group_mismatch: "只在房间 POST 上返回，控制台对房间只读（GET），发消息的是 agent"',
    to: '  room_task_group_mismatch: "只在房间 POST 上返回，控制台对房间只读（GET），发消息的是 agent",\n  dispatch_not_assigned_to_node: "agent 网关：派发不属于这个节点"',
    expect: "而控制台就在调这条路由"
  },
  {
    name: "登记里点名的读取方必须真的读它",
    file: "scripts/contract-check.mjs",
    check: "verifyServerFieldsReachThePerson",
    from: '    transport: "入网自检读它（agentctl 比对 streamable-http），不是给人看的",',
    to: '    transport: "MCP 客户端据此选传输方式",',
    expect: "理由不成立"
  },
  {
    name: "文案点名的字段界面必须真的显示",
    file: "apps/control-plane-ui/public/app.js",
    check: "verifyMessagesDoNotPointAtInvisibleFields",
    from: '    payload.file ? `涉及的文件：${payload.file}` : "",',
    to: '        "",',
    expect: "指向一个他看不到的东西"
  },
  {
    name: "抛错展开进报文的字段也要被门扫到",
    file: "apps/control-plane-ui/public/app.js",
    check: "verifyServerFieldsReachThePerson",
    from: '    Array.isArray(payload.deniedPaths) && payload.deniedPaths.length\n      ? `踩到禁区的路径：${payload.deniedPaths.join("、")}` : "",',
    to: '        "",',
    expect: "拒绝报文里带了 deniedPaths"
  },
  {
    name: "拒绝报文里给人看的字段，前端不读要被门看见",
    file: "apps/control-plane-ui/public/app.js",
    check: "verifyServerFieldsReachThePerson",
    from: "    payload.hint,",
    to: '        "",',
    expect: "拒绝报文里带了 hint"
  },
  {
    name: "服务端算好的合法清单必须到达人眼前",
    file: "apps/control-plane-ui/public/app.js",
    gate: "console",
    from: '    Array.isArray(payload.supported) && payload.supported.length\n      ? `可用的取值：${payload.supported.join("、")}` : ""',
    to: '    ""',
    expect: "服务端写的说明没有到达人"
  },
  {
    name: "认不出的分支状态不得降级成已上报",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: '  if (args.branchStatus !== undefined\n    && !["reported", "failed", "rejected", "blocked"].includes(args.branchStatus)) {',
    to: "  if (false) {",
    expect: "认不出的分支状态没有被拒"
  },
  {
    name: "认不出的 AI 评估不得降级成 concerns",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanAndOrganizationContracts",
    from: '  if (input.assessment !== undefined\n    && !["agree", "concerns", "better_alternative", "incorrect"].includes(input.assessment)) {',
    to: "  if (false) {",
    expect: "认不出的 AI 评估没有被拒"
  },
  {
    name: "认不出的控制命令回执状态不得当成已接受",
    file: "apps/control-plane-ui/lib/agent-gateway.mjs",
    gate: "agent",
    from: "  if (input.status !== undefined && !nodeReportable.includes(input.status)) {",
    to: "  if (false) {",
    expect: "认不出的控制命令回执状态没有被拒"
  },
  {
    name: "认不出的失败上报状态不得降级成终态 failed",
    file: "apps/control-plane-ui/server.mjs",
    gate: "agent",
    from: "    if (body.status !== undefined && !FAIL_REPORT_STATUSES.includes(body.status)) {",
    to: "    if (false) {",
    expect: "认不出的失败上报状态没有被拒"
  },
  {
    name: "被叫停的派发不许再交检查点",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: '  if (!dispatch || dispatch.status !== "running") {',
    to: '  if (!dispatch || !["running", "blocked"].includes(dispatch.status)) {',
    expect: "派发已经被叫停（blocked），交上来的检查点没有被按"
  },
  {
    name: "人叫停之后 agent 的失败上报不许把这个决定抹掉",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: '    if (dispatch.status === "blocked"\n      && HUMAN_CONTROL_BLOCK_REASONS.includes(dispatch.blockedReason)) {',
    to: "    if (false) {",
    expect: "人已叫停的派发接受了 agent 的失败上报"
  },
  {
    name: "读视图缓存的键必须带 stateVersion（别的进程写入时只有它兜得住）",
    file: "apps/control-plane-ui/server.mjs",
    gate: "writer",
    from: '  return `${account.accountId}:${session.sessionId}:${stateVersion}:${view || "full"}:${limit || "default"}:${projectId || "all"}`',
    to: '  return `${account.accountId}:${session.sessionId}:${view || "full"}:${limit || "default"}:${projectId || "all"}`',
    expect: "别的进程写入之后，这一台立刻读得到"
  },
  {
    name: "按 id 取记录的读路由不得把别的租户的内容发出来",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    // 只放开【跨租户】那一支、保留未认证拦阻：否则先撞上的是"未认证必须 401"那条断言，
    // 这条读泄漏断言的判别力就没被单独证明过（第一版换了两个路由才找到不被抢的那个）。
    from: '    const reader = requireRead(req, state, taskGroupScope(state, humanDirectiveListMatch[1]));\n    if (reader.status) return json(res, reader.status, reader.payload);',
    to: '    const reader = requireRead(req, state, taskGroupScope(state, humanDirectiveListMatch[1]));\n    if (reader.status && !accountFromRequest(req, state)) return json(res, reader.status, reader.payload);',
    expect: "组织管理员读到了别的租户的内容"
  },
  {
    name: "租约释放要核对持有者，不能只看围栏令牌",
    file: "apps/mcp-server/server.mjs",
    gate: "mcp",
    from: '    if (args.holderRef && lease.holderRef !== args.holderRef) return {allowed: false, error: "mcp_lease_holder_mismatch", grantRef};',
    to: '    if (false) return {allowed: false, error: "mcp_lease_holder_mismatch", grantRef};',
    expect: "报了别人的持有者"
  },
  {
    name: "arguments 不是对象必须当场拒绝",
    file: "apps/mcp-server/server.mjs",
    gate: "mcp",
    from: '    return {ok: false, error: "mcp_input_must_be_object"};',
    to: '    return {ok: false, error: "mcp_input_rejected"};',
    expect: "传成数组没有被拒"
  },
  {
    name: "按内容指纹归并也要分租户",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    gate: "doctor",
    from: "  const sameOwner = (item) => (item.taskGroupId || null) === (request.taskGroupId || null);",
    to: "  const sameOwner = () => true;",
    expect: "就被并进了"
  },
  {
    name: "守卫作用域要取自被改的那条记录，不能取自请求体",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: 'taskGroupScope(state, assignTarget?.id || body.taskGroupId || "tg_runtime_management"));',
    to: 'taskGroupScope(state, body.taskGroupId || "tg_runtime_management"));',
    expect: "拒它的不是守卫而是别的东西"
  },
  {
    name: "无上限地等子进程退出要被门看见",
    file: "scripts/doctor-mcp.mjs",
    check: "verifyChildExitWaitsAreBounded",
    from: '  await Promise.race([once(child, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 3000).unref())]);',
    to: '  await once(child, "exit");',
    expect: "无上限地等子进程退出"
  },
  {
    name: "清单声称的产出不在提交里必须被拒（删掉的文件也算不在）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: '        return {valid: false, status: 409, error: "artifact_output_ref_not_in_commit"};',
    to: '        return {valid: false, status: 409, error: "generic_rejected"};',
    expect: "artifact_output_ref_not_in_commit 拦下"
  },
  {
    name: "空提交不得当成交付（我提交了≠我改了东西）",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: '  if (!changedPaths.length) return {valid: false, status: 409, error: "checkpoint_commit_has_no_changed_paths"};',
    to: '  if (false) return {valid: false, status: 409, error: "checkpoint_commit_has_no_changed_paths"};',
    expect: "checkpoint_commit_has_no_changed_paths 拦下"
  },
  {
    name: "另两套 e2e 的 4xx 断言没点名拒绝码要被门看见",
    file: "scripts/doctor-agent-remote.mjs",
    check: "verifyRefusalAssertionsNameTheCode",
    from: '  if (reuse.response.status !== 409 || reuse.payload?.error !== "join_token_consumed") {',
    to: "  if (reuse.response.status !== 409) {",
    expect: "只判了状态码，没点名拒绝码"
  },
  {
    name: "4xx 断言必须点名拒绝码，只判状态码要被棘轮咬住",
    file: "scripts/doctor.mjs",
    gate: "doctor",
    from: ', "work assign deny", "policy_denied");',
    to: ', "work assign deny");',
    expect: "只判状态码不判拒绝码的 4xx 断言从 0 涨到"
  },
  {
    name: "点名拒绝码要抓得住守卫串位",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    gate: "doctor",
    from: 'new Error("task_group_close_requires_human_actor")',
    to: 'new Error("policy_denied")',
    expect: "拒了不等于拒对了"
  },
  {
    name: "已定案的规则源不得被再次改写",
    file: "apps/control-plane-ui/lib/control-plane-core.mjs",
    gate: "doctor",
    from: "  if (RULE_SOURCE_TERMINAL_STATUSES.includes(resolution.status)) return {ruleSourceResolution: resolution, alreadySettled: true};",
    to: "  if (false) return {ruleSourceResolution: resolution, alreadySettled: true};",
    expect: "已定案的规则源不得被再次改写"
  },
  {
    name: "认不出的处置状态必须拒绝，不得静默接受",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: '    if (!nextStatus) return json(res, 400, {error: "review_bundle_status_invalid"});',
    to: '    if (false) return json(res, 400, {error: "review_bundle_status_invalid"});',
    expect: "认不出的评审包状态必须拒绝"
  },
  {
    name: "第二道门登记册必须被实测校验，过期要报红",
    file: "scripts/lib/known-second-doors.mjs",
    gate: "mcp",
    from: '  "identity-mcp.account_invite": "account_invite_forbidden_for_machine_principal"',
    to: '  "identity-mcp.account_invite": "account_invite_forbidden_for_machine_principal_x"',
    expect: "没登记进第二道门册"
  },
  {
    name: "守卫之前无条件回 404 必须被门看见",
    file: "apps/control-plane-ui/server.mjs",
    check: "verifyMissingRecordsLookLikeInvisibleOnes",
    from: '      const denial = missingRecordDenial(req, state, "agent_join_token_not_found", "policy_denied");\n      return json(res, denial.status, denial.payload);',
    to: '      return json(res, 404, {error: "agent_join_token_not_found"});',
    expect: "守卫之前就回了 404"
  },
  {
    name: "系统级作用域只认 system: 权限，认不出的 resourceType 不得掉进 return true",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: '    return permission.startsWith("system:");',
    to: "    return true;",
    expect: "越权写入成功"
  },
  {
    name: "查无此物与看不见必须给同一个答案",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: '  if (isSystemAccount(accountFromRequest(req, state)?.account)) return {status: 404, payload: {error: code}};',
    to: "  if (true) return {status: 404, payload: {error: code}};",
    expect: "越租户探测能分辨"
  },
  {
    name: "不存在的 id 必须走到 404，不得掉进后面的代码",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: '    if (!gate) return json(res, 404, {error: "quality_gate_not_found"});',
    to: '    if (false) return json(res, 404, {error: "quality_gate_not_found"});',
    expect: "不存在的 id 没有得到该给的 404 拒绝码"
  },
  {
    name: "停用必须叫停在跑的执行：暂停不得放过任何一个未终结的派发",
    file: "apps/control-plane-ui/server.mjs",
    gate: "doctor",
    from: '    ? "pause_dispatch"',
    to: "    ? null",
    // 这个变异先撞上【halt 那段的前置检查】（它要求暂停之后派发必须是 blocked），
    // 而不是后面那条"逐个派发都要被处置"的断言 —— 两条断言盯的是同一件事，
    // 先撞上哪一条取决于 e2e 里的先后。按【实际先红的那一句】写 expect，
    // 否则变异门会报"红了但不是预期原因"，看起来像偶发失败（实测追了一轮）。
    expect: "人暂停之后这个派发不是 blocked"
  },
];

// 崩溃安全：这个脚本会把真实源文件改坏再还原。一旦中途被打断（Ctrl-C / 被杀 / 抛错），
// 工作树里就会留下【闸门守卫被禁用】的代码 —— 那比它要防的问题更危险。所以把待还原的内容
// 登记在进程级，并在所有退出路径上还原。
// 记的是「原内容」与「我写下的那份改坏内容」两样。还原前必须确认磁盘上仍是后者 ——
// 否则就是别人在这期间改了这个文件，把它覆盖回去等于销毁别人未提交的改动。
// 本次会话真的发生过：这道门在后台跑，我同时在改同一个文件，跑完它把我的改动抹掉了。
// 这与用 git checkout 撤销临时改动是同一类事故，只是这次是我自己的工具做的。
// 被硬杀时也要能恢复。退出钩子挂在信号上，而 execFileSync 会阻塞事件循环 ——
// 超时被 SIGKILL 时处理器根本来不及跑，源码就留在改坏状态里（实测发生过：一次超时之后
// control-plane-core.mjs 带着 `status: false` 留在工作区）。所以把"我正在改坏哪个文件"
// 落到磁盘上：下次启动先看这张便条，能恢复就恢复，恢复不了就拒绝运行而不是继续改坏别的。
// 【被硬杀之后怎么办】：信号钩子在 SIGKILL 下跑不了（工具超时、kill -9 都会走到这里），
// 于是工作区里会留着一份被改坏的源码。**先原样再跑一次本门**，它会读这张便条把文件恢复回去；
// 不要先手工 git checkout —— 那会把便条和它要恢复的对象一起丢掉，
// 也就永远看不出到底是哪一条变异没收尾（2026-08-14 我自己就这么干了一次）。
const pendingNotePath = join(root, ".runtime", "mutation-gate-pending.json");

function writePendingNote(path, original, mutated) {
  try {
    mkdirSync(dirname(pendingNotePath), {recursive: true});
    writeFileSync(pendingNotePath, JSON.stringify({path, original, mutated}));
  } catch { /* 便条写不成不该挡住本门；它只是恢复用的兜底 */ }
}

function clearPendingNote() {
  try { rmSync(pendingNotePath, {force: true}); } catch { /* 尽力而为 */ }
}

// 两个本门实例同时跑，会互相覆盖对方改坏/还原到一半的源码：A 改坏文件、B 读到这份坏内容当作
// "原内容"、A 还原、B 再还原成那份坏的 —— 源码就永久留在改坏状态。实测发生过（一次误启的实例
// 与正常运行的实例并发，防覆盖检查连续拒绝还原）。所以同一时刻只允许一个实例。
const lockPath = join(root, ".runtime", "mutation-gate.lock");
let lockHeld = false;

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function acquireLock() {
  let holder = null;
  try { holder = JSON.parse(readFileSync(lockPath, "utf8")); } catch { holder = null; }
  if (holder?.pid && holder.pid !== process.pid && processAlive(holder.pid)) {
    console.error(`mutation gate: 另一个实例正在运行（pid ${holder.pid}，起于 ${holder.startedAt || "未知"}）。`
      + "\n  两个实例会互相覆盖对方改坏的源码，因此本次拒绝启动。"
      + `\n  若确认那个进程已死，删除 ${lockPath} 后重试。`
      + describePendingWreckage(pendingNotePath));
    process.exit(1);
  }
  try {
    mkdirSync(dirname(lockPath), {recursive: true});
    writeFileSync(lockPath, JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()}));
    lockHeld = true;
  } catch (error) {
    // 锁写不成就无法排除并发，而并发的代价是源码被永久改坏 —— 宁可不跑。
    console.error(`mutation gate: 无法写入互斥锁 ${lockPath}：${error?.message || error}`);
    process.exit(1);
  }
}

function releaseLock() {
  if (!lockHeld) return;
  lockHeld = false;
  try { rmSync(lockPath, {force: true}); } catch { /* 尽力而为；下次靠 pid 存活判断兜底 */ }
}

function recoverFromPreviousRun() {
  let note = null;
  try { note = JSON.parse(readFileSync(pendingNotePath, "utf8")); } catch { return; }
  if (!note?.path) { clearPendingNote(); return; }
  let onDisk = "";
  try { onDisk = readFileSync(note.path, "utf8"); } catch { clearPendingNote(); return; }
  if (onDisk === note.original) { clearPendingNote(); return; } // 已经是好的，便条过期
  if (onDisk !== note.mutated) {
    // 磁盘上既不是原样也不是我改坏的那份 —— 有人在这中间改过它，绝不覆盖。
    console.error(`mutation gate: 上一轮被中断，${note.path} 现在既不是原内容也不是它改坏的那份 —— `
      + "已放弃自动恢复以免覆盖你的改动。请对照 git diff 手工确认后删除 .runtime/mutation-gate-pending.json");
    process.exit(1);
  }
  writeFileSync(note.path, note.original);
  clearPendingNote();
  console.error(`mutation gate: 上一轮被中断，已把 ${note.path} 恢复为原内容。`);
}

const pendingRestores = new Map();
function restoreAll() {
  for (const [path, {original, mutated}] of pendingRestores) {
    try {
      const onDisk = readFileSync(path, "utf8");
      if (onDisk !== mutated) {
        process.stderr.write(`mutation gate: ${path} 在本门运行期间被改动过，已放弃还原以免覆盖它。\n`
          + "  若这不是你的改动，请对照 git diff 手工确认；本门不再自动写回。\n");
        continue;
      }
      writeFileSync(path, original);
    } catch { /* 尽力而为 */ }
  }
  pendingRestores.clear();
  releaseLock();
}
process.on("exit", restoreAll);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { restoreAll(); process.exit(130); });
}
process.on("uncaughtException", (error) => { restoreAll(); console.error(error); process.exit(1); });

// ── 并行执行 ────────────────────────────────────────────────────────────────
//
// 每条变异都要完整跑一遍 contract-check（本机 58s）。39 条串行 ≈ 78 分钟，而且【全程独占源码】：
// 它逐条改坏真实文件再还原，期间任何别的检查或编辑都会读到、或被覆盖掉。
//
// 用 git worktree 而不是复制目录：contract-check 里有一批断言依赖 git（gitHead、
// 每单元子进程计数的 PATH shim、真实临时仓库+bare 远端的检查点证据），复制到没有 .git 的
// 目录里它们会以【另一种理由】通过 —— 那是最坏的绿。
//
// 前置条件：工作区必须干净。worktree 检出的是 HEAD，带不上未提交改动；脏的时候并行测到的
// 不是本地这份代码，所以此时明说原因并退回串行，而不是"尽量并行"。
const WORKTREE_PREFIX = "aimac-mutation-w";
// 这些门要起真实服务，而 worktree 里没有 node_modules —— 只能在真实工作区跑。
// doctor/mcp 同样如此：它们起的是真的 HTTP 服务，worktree 里连 node_modules 都没有，
// 接上 node_modules 软链之后，起真实服务的门在 worktree 里也跑得起来（idle/crash/writer/doctor/mcp
// 逐个实测过）。它们只杀自己 spawn 的子进程、端口一律取临时口，并行互不干扰，
// 于是这份"必须在真实工作区串行"的清单空了 —— 留着这个开关是为了下一个发现例外的人有地方写。
// 工作区不干净时仍然整体退回串行，那是另一条路径（worktree 取的是 HEAD，带不上未提交改动）。
const NEEDS_REAL_TREE = new Set([]);

function workingTreeIsClean() {
  try {
    return execFileSync("git", ["status", "--porcelain"], {cwd: root, encoding: "utf8"}).trim() === "";
  } catch {
    return false;
  }
}

// 残留清理按 git 自己的 worktree 列表扫前缀，不依赖本进程记得什么 —— 被 SIGKILL 时它什么也记不住。
function pruneStaleWorktrees() {
  let listing = "";
  try { listing = execFileSync("git", ["worktree", "list", "--porcelain"], {cwd: root, encoding: "utf8"}); } catch { return; }
  for (const line of listing.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const dir = line.slice("worktree ".length).trim();
    if (!dir.includes(WORKTREE_PREFIX)) continue;
    const owner = Number(dir.split(WORKTREE_PREFIX)[1]?.split("-")[0] || 0);
    if (owner === process.pid || processAlive(owner)) continue;
    try { execFileSync("git", ["worktree", "remove", "--force", dir], {cwd: root, stdio: "ignore"}); } catch { /* 尽力而为 */ }
  }
  try { execFileSync("git", ["worktree", "prune"], {cwd: root, stdio: "ignore"}); } catch { /* 尽力而为 */ }
}

// worktree 只有被 git 跟踪的文件，没有 node_modules —— 起真实服务的门（doctor/mcp 要用 ws）
// 因此必跑失败，而失败原因不是被测守卫，门会报"红了但不是预期原因"（实测撞到过）。
// 一条软链就够：真实工作区的 node_modules 本来就是只读依赖，不必每个 worktree 各装一份
// （装一份约 15 个包，8 个 worktree 就是 8 次 npm ci —— 那比省下的时间贵得多）。
function linkNodeModules(dir) {
  const source = join(root, "node_modules");
  if (!existsSync(source)) return;
  try { symlinkSync(source, join(dir, "node_modules"), "dir"); } catch { /* 已存在就算了 */ }
}

function removeWorktrees(dirs) {
  for (const dir of dirs) {
    try { execFileSync("git", ["worktree", "remove", "--force", dir], {cwd: root, stdio: "ignore"}); } catch { /* 尽力而为 */ }
  }
}

// 必须是异步子进程：execFileSync 会阻塞整个进程，用它做"池"等于串行。
// mutation.check 指名"该抓它的那条检查"时，只跑那一条。契约门的固定开销实测 0.1s，
// 完整一遍 41.3s —— 另外 44 条检查对这条变异毫无判别力，只是陪跑，而守卫每加一条就更贵。
// 没指名的条目照旧跑全量：这是能力，不是义务，漏填只是慢，不会让判据失真。
// 本门原先只驱动 contract-check，于是 validate-specs / 控制台门 / 空转门里的断言
// 【从来没有自动化的判别力证明】——全靠人每次手工变异一次。而本会话两次写出"按构造永远为真"的
// 断言（check 参数顺序写反、把一个恒真的兜底当成满足条件），两次都是靠"变异跑不出红"才发现的。
// 手工验过一次不等于以后还成立：判据会随代码漂，而漂之后它只是安静地不再报红。
// mutation.gate 指定要跑哪道门（默认契约门）；AIMAC_CONTRACT_ONLY 只对契约门有意义。
const GATE_COMMANDS = {
  contract: "scripts/contract-check.mjs",
  auth: "scripts/auth-placement-gate.mjs",
  parity: "scripts/human-only-parity-gate.mjs",
  barrier: "scripts/barrier-liveness-gate.mjs",
  invariants: "scripts/system-invariants-gate.mjs",
  crash: "scripts/crash-consistency-gate.mjs",
  writer: "scripts/concurrent-writer-gate.mjs",
  console: "scripts/console-behaviour-check.mjs",
  idle: "scripts/idle-tick-gate.mjs",
  specs: "scripts/validate-specs.rb",
  // 控制面 e2e（约 94 秒，其中九成在等 I/O，与别的变异并行几乎不占额外墙钟）。
  // 只给那些【非走真实 HTTP 不可】的不变式用 —— 快门能守的一律别挂这里。
  doctor: "scripts/doctor.mjs",
  // MCP e2e（约 40 秒）。同样只给非走真实 MCP 调用不可的不变式用。
  mcp: "scripts/doctor-mcp.mjs",
  // 远程 agent e2e。断言写在哪套 e2e 里，变异就得挂哪个门 ——
  // 挂错门的表现是"单独跑那套 e2e 时红、进了全量门却绿"（实测：一条变异因此假绿）。
  agent: "scripts/doctor-agent-remote.mjs",
  // docker compose e2e（要起一台真 PostgreSQL，几分钟）。只给【非在真数据库上跑就验不到】
  // 的不变式用 —— 分片防篡改就是这一类：runtime_json 那条路有三道校验且被契约门钉着，
  // 而生产用的是 PG，那道守卫存在的全部理由就是"有 DB 写权限的人直接改分片行"。
  docker: "scripts/doctor-docker-compose.mjs"
};
function gateInvocation(mutation, workdir) {
  const key = mutation.gate || "contract";
  const script = GATE_COMMANDS[key];
  if (!script) throw new Error(`mutation ${mutation.name}: 未知的 gate "${key}"（可选：${Object.keys(GATE_COMMANDS).join("、")}）`);
  const command = script.endsWith(".rb") ? "ruby" : "node";
  const env = key === "contract" && mutation.check
    ? {...process.env, AIMAC_CONTRACT_ONLY: mutation.check}
    : process.env;
  return {command, args: [join(workdir, script)], env};
}

function runContractCheck(workdir, mutation) {
  const {command, args, env} = gateInvocation(mutation, workdir);
  return new Promise((resolve) => {
    execFile(command, args, {cwd: workdir, maxBuffer: 64 * 1024 * 1024, env},
      (error, stdout, stderr) => resolve({failed: Boolean(error), output: `${stdout || ""}${stderr || ""}`}));
  });
}

// 变异被抓住时，契约门会打印 failing-checks: —— 用它自动建立"变异 → 检查"的映射，
// 免得人去手工维护一张对照表（手工表一定会漂，而漂了之后只是变慢，不会有人发现）。
const discoveredChecks = new Map();
function recordDiscovery(mutation, output) {
  const match = /failing-checks: (.+)/u.exec(output);
  if (match) discoveredChecks.set(mutation.name, match[1].trim());
}

function reportDiscovery() {
  if (!process.env.AIMAC_MUTATION_DISCOVER || !discoveredChecks.size) return;
  console.log("discovered check mapping:");
  for (const [name, checks] of discoveredChecks) console.log(`  ${JSON.stringify(name)} => ${checks}`);
}

// 判据与串行逐字相同：必须失败，且失败信息里出现这条守卫对应的断言。
async function judgeMutation(mutation, workdir) {
  const target = join(workdir, mutation.file);
  const original = readFileSync(target, "utf8");
  if (!original.includes(mutation.from)) {
    return `${mutation.name}: 找不到要改坏的代码片段 —— 守卫可能已被重写，mutation 需同步更新`;
  }
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) {
    return `${mutation.name}: 要改坏的代码片段在 ${mutation.file} 里出现了 ${occurrences} 次 —— `
      + "无法确定改的是被测的那一处，mutation 必须写成唯一匹配（连上下文一起写）";
  }
  writeFileSync(target, original.replace(mutation.from, mutation.to));
  let result = {failed: false, output: ""};
  try {
    result = await runContractCheck(workdir, mutation);
  } finally {
    writeFileSync(target, original); // 只动副本，真实工作区全程未被触碰
  }
  recordDiscovery(mutation, result.output);
  // 门跑完却一个字都没输出 = 它根本没执行（本仓库真发生过：入口判断按 `file://${argv[1]}` 比较，
  // 而 worktree 在 /var/folders/... 这条符号链接下，主块一次都不跑，静默退出 0）。
  // 这种"通过"必须与真的通过区分开，否则变异门会替一个从不运行的门作证。
  if (!String(result.output || "").trim()) {
    return `${mutation.name}: 门跑完没有任何输出 —— 它多半根本没执行（入口判断/路径解析问题），`
      + "这不是'守卫通过'，而是没人检查过";
  }
  if (!result.failed) {
    return `${mutation.name}: 守卫被改坏后 ${mutation.gate || "contract"} 门仍然通过 —— 该守卫的测试是假绿，没有判别力`
      + (mutation.check ? `（本条只跑了 ${mutation.check}；若这条守卫其实由别的检查覆盖，改正 check 字段而不是删掉它）` : "");
  }
  if (!result.output.includes(mutation.expect)) {
    // 报文必须带上【它到底为什么红的】：只说"不是预期原因"的话，并发下的偶发失败与
    // "变异锚点指错了地方"长得一模一样，只能靠重跑去猜（本仓追间歇红追过三轮，
    // 每次卡住都是因为出事那一刻的证据没留下来）。
    const tail = result.output.split("\n").filter((line) => line.trim())
      .slice(-6).map((line) => `      ${line.slice(0, 160)}`).join("\n");
    return `${mutation.name}: 失败了但不是因为预期断言（期望出现「${mutation.expect}」）`
      + `—— 测试可能在别处偶然失败，并未真正覆盖这条守卫。实际输出末尾：\n${tail}`;
  }
  return null;
}

async function runParallel(mutations) {
  // 并行度封在 4：不是随手写的，是量过的。2026-08-14 在 18 核机器上实测 287 条变异 ——
  // 4 路 393 秒；8 路超过 600 秒（更慢）。8 份并发只是在抢 CPU 和磁盘。**别再调大它。**
  //
  // 这 389 秒的构成也量过了，省得下一个人再算一遍：
  //  · 走 worktree 的 219 条（契约 156 / 控制台 41 / 规范 22）单条只要 0.1–0.5 秒，合计几十秒；
  //  · 真正的长尾是**必须在真实工作区串行**的 14 条（空转 2×35s + 并发 3×20s + 崩溃 9×12s ≈ 238 秒），
  //    它们要起真实服务端，而 worktree 里没有 node_modules。
  // 也就是说：**并行那半早就跑完了，剩下的时间都在等那 14 条串行。**
  //
  // 想过的优化：让串行队列与并行阶段【叠起来跑】（两者资源不重叠：worktree 取 HEAD，串行改工作区），
  // 理论上能省约 2.5 分钟。**有意不做** —— runSerial 是同步的，改成异步就意味着
  // "逐条改写真实源文件"这件事要和 worktree 建置并发进行，而这个工具的自并发危险是有过教训的。
  // 一道只在发版前跑的门，不值得为 2.5 分钟往它身上加并发。
  const workers = Math.max(1, Math.min(4, cpus().length - 2));
  pruneStaleWorktrees();
  const dirs = [];
  for (let index = 0; index < workers; index += 1) {
    const dir = join(tmpdir(), `${WORKTREE_PREFIX}${process.pid}-${index}`);
    try { rmSync(dir, {recursive: true, force: true}); } catch { /* 尽力而为 */ }
    execFileSync("git", ["worktree", "add", "--detach", "--quiet", dir, "HEAD"], {cwd: root, stdio: "ignore"});
    linkNodeModules(dir);
    dirs.push(dir);
  }
  process.on("exit", () => removeWorktrees(dirs));
  // worktree 里【跑不了要起服务的门】：worktree 只有被 git 跟踪的文件，没有 node_modules，
  // 服务起不来。空转门在那里会红在"init 之后 npm start 能直接起来"这条上 ——
  // 于是变异门报"失败了但不是预期断言"，看起来像守卫失效，实际是环境不完整。
  //（我第一版把它归因成"4 路并发压超时"，改成串行仍然红，才查出真因是 worktree。
  //  归因错了的代价不是白改一次，是把一条真实的环境限制解释成了偶发抖动。）
  // 所以这类门必须在【真实工作区】跑，走既有的串行路径（带崩溃便条与还原保护）。
  const parallelQueue = mutations.filter((mutation) => !NEEDS_REAL_TREE.has(mutation.gate || "contract"));
  const serialQueue = mutations.filter((mutation) => NEEDS_REAL_TREE.has(mutation.gate || "contract"));
  const queue = [...parallelQueue];
  const failures = [];
  const checked = [];
  await Promise.all(dirs.map(async (dir) => {
    for (;;) {
      const mutation = queue.shift();
      if (!mutation) return;
      if (mutation.skip) { checked.push(`- ${mutation.name}（跳过：${mutation.skip}）`); continue; }
      const failure = await judgeMutation(mutation, dir);
      process.stdout.write(`  · ${mutation.name} …\n`);
      if (failure) failures.push(failure); else checked.push(`- ${mutation.name}`);
    }
  }));
  removeWorktrees(dirs);
  return {failures, checked, workers, serialQueue};
}

// 锚点体检：只核对每条变异的 from 片段在目标文件里仍然【正好出现一次】，不跑任何 contract-check。
// 纯文本、毫秒级，因此可以进快速链。
//
// 为什么需要它：完整变异门只在 npm run doctor（约 22 分钟）里跑，而守卫被改写、锚点随之失配
// 是很平常的事 —— 本次就是：给闸加了优先级预留，改掉了 `if (wipNow >= wipCap)` 这一行，
// 却没同步指向它的那条变异。全量门确实会报（"找不到要改坏的代码片段"），但要等一次长跑才知道，
// 而这中间每一次"validate 全绿"都在暗示那条守卫仍然被验着。
// 锚点失配不是小事：它意味着那条守卫【当前没有任何判别力证明】。
// 登记项自身写错（门名打错、没有 expect、from 与 to 相同）时，真跑起来的表现是
// "失败了但不是预期断言"—— 红是红了，可它指的方向完全不对：人会去查被测代码，而错在登记项。
// 这类核对不用读文件，毫秒级，所以【锚点体检和真跑都要做】。
// 原先只有锚点体检做，于是单跑一条时（AIMAC_MUTATION_ONLY）这道拦截根本不生效 ——
// 2026-08-21 我把 gate 写成 "console-behaviour"、又写成路径常量，两次都只看到那句误导的话。
function registryShapeFailures(mutations) {
  const failures = [];
  for (const mutation of mutations) {
    if (mutation.from === mutation.to) failures.push(`${mutation.name}: from 与 to 相同 —— 这条变异什么也没改坏`);
    if (mutation.gate && !GATE_COMMANDS[mutation.gate]) {
      failures.push(`${mutation.name}: gate "${mutation.gate}" 不存在（可选：${Object.keys(GATE_COMMANDS).join("、")}）`);
    }
    if (mutation.check && (mutation.gate || "contract") !== "contract") {
      failures.push(`${mutation.name}: check 只对契约门有意义，而这条指向 ${mutation.gate} 门 —— 它不会生效，留着会让人以为已经收窄了范围`);
    }
    if (!mutation.expect) failures.push(`${mutation.name}: 没有 expect —— 只看退出码的话，任何一处偶然失败都会被当成"守卫有效"`);
  }
  return failures;
}

function checkAnchorsOnly() {
  const failures = [];
  const seen = new Set();
  // skip 掉的条目不【执行】变异，但锚点唯一性是纯文本核对，跟执不执行无关：放过它们，就等于
  // 这些条目"判别力由某某门覆盖"那句声明再也没人核 —— 被测代码改写后锚点失配，册子上却照旧写着
  // 它守着什么。所以一样要求锚点存在且唯一，只是它们不参与真跑。
  const skipped = MUTATIONS.filter((mutation) => mutation.skip);
  for (const mutation of MUTATIONS) {
    const key = `${mutation.file}::${mutation.from}::${mutation.to}`;
    if (seen.has(key)) failures.push(`重复条目：${mutation.name} 与前面某条的 file/from/to 完全相同 —— 其中一条必然验的不是它自己声称的那个守卫`);
    seen.add(key);
    let source = "";
    try {
      source = readFileSync(join(root, mutation.file), "utf8");
    } catch {
      failures.push(`${mutation.name}: 读不到 ${mutation.file}`);
      continue;
    }
    const occurrences = source.split(mutation.from).length - 1;
    if (occurrences !== 1) {
      failures.push(`${mutation.name}: 锚点在 ${mutation.file} 里出现 ${occurrences} 次（要求正好 1 次）—— `
        + (occurrences ? "改不准被测的那一处" : "守卫已被改写而变异没跟上，这条守卫目前没有任何判别力证明"));
    }
    failures.push(...registryShapeFailures([mutation]));
  }
  if (failures.length) {
    console.error("mutation anchor check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(`mutation anchor check ok: ${MUTATIONS.length} 条变异的锚点都仍然唯一匹配`
    + `${skipped.length ? `；其中 ${skipped.length} 条不在变异门里真跑（锚点一样要求唯一，判别力由各自注明的其它门覆盖）：${skipped.map((mutation) => mutation.name).join("、")}` : ""}`
    + "（只核对锚点，没有验判别力 —— 那要跑完整变异门）");
  process.exit(0);
}

if (process.argv.includes("--anchors-only")) {
  // 锚点体检原先不做恢复：上一轮被硬杀留下的便条会一直躺着，而它守的那个文件也一直是改坏的 ——
  // 而锚点体检恰恰是每次 validate 都跑的第一道门，它最该先把残局收掉。
  // （不收的话还有更坏的一面：锚点是拿【改坏后的】源码去比对的，本身就不作数。）
  recoverFromPreviousRun();
  checkAnchorsOnly();
}

// 只跑名字里含某个片段的那几条。调单条变异时不必陪跑全量（本机全量并行约 24 分钟），
// 也让"把 expect 改成绝不会出现的串、它必须报失败"这类自证做得起。
// 筛不到任何一条时必须报错退出：静悄悄地跑了 0 条然后打印"全绿"，正是本门最该防的那种绿。
function selectedMutations() {
  const filter = String(process.env.AIMAC_MUTATION_ONLY || "").trim();
  if (!filter) return MUTATIONS;
  const selected = MUTATIONS.filter((mutation) => mutation.name.includes(filter));
  if (!selected.length) {
    console.error(`mutation gate: AIMAC_MUTATION_ONLY="${filter}" 没有匹配到任何一条变异 —— 拒绝把"跑了 0 条"报成通过。`);
    process.exit(1);
  }
  console.error(`mutation gate: 只跑名字含「${filter}」的 ${selected.length} 条（AIMAC_MUTATION_ONLY）。`);
  return selected;
}

function refuseMalformedRegistry(mutations) {
  const failures = registryShapeFailures(mutations);
  if (!failures.length) return;
  console.error("mutation gate: 登记项本身写错了，拒绝开跑（跑了也只会报一句指错方向的话）：");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

// 门自证：本门的判据是"改坏守卫后 contract-check 必须失败【且报的是那一条】"。
// 后半句很容易退化成只看退出码 —— 那样任何一处偶然失败都会被当成"守卫有效"。
// 这里拿一条真实变异跑两遍：期望片段写成绝不会出现的串时必须被判失败，写成真实片段时必须通过。
// 它验的是本门自己，所以不该藏在文档里靠人记得跑：AIMAC_MUTATION_SELFTEST=1 随时可验。
async function runSelfTest() {
  const sample = MUTATIONS.find((mutation) => !mutation.skip);
  if (!sample) { console.error("mutation gate 自证: 没有可用的变异条目"); process.exit(1); }
  pruneStaleWorktrees();
  const dir = join(tmpdir(), `${WORKTREE_PREFIX}${process.pid}-selftest`);
  try { rmSync(dir, {recursive: true, force: true}); } catch { /* 尽力而为 */ }
  execFileSync("git", ["worktree", "add", "--detach", "--quiet", dir, "HEAD"], {cwd: root, stdio: "ignore"});
  linkNodeModules(dir);
  process.on("exit", () => removeWorktrees([dir]));
  const problems = [];
  const impossible = await judgeMutation({...sample, expect: "这句话不会出现在任何输出里-selftest"}, dir);
  if (!impossible || !impossible.includes("不是因为预期断言")) {
    problems.push(`期望片段写成绝不会出现的串时，本门没有把它判成失败（得到：${impossible || "通过"}）—— 它只看了退出码`);
  }
  const real = await judgeMutation(sample, dir);
  if (real) problems.push(`同一条变异用真实期望片段却被判失败（${real}）—— 自证的对照组不成立`);
  removeWorktrees([dir]);
  if (problems.length) {
    console.error("mutation gate 自证失败:");
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log(`mutation gate 自证 ok: 以「${sample.name}」为样本，期望片段对不上时会被判失败，对得上时通过`);
}

async function run() {
  if (process.env.AIMAC_MUTATION_SELFTEST === "1") {
    if (!workingTreeIsClean()) {
      console.error("mutation gate 自证: 工作区不干净（自证要在 worktree 里跑，取的是 HEAD）");
      process.exit(1);
    }
    await runSelfTest();
    return;
  }
  const mutations = selectedMutations();
  refuseMalformedRegistry(mutations);
  if (workingTreeIsClean()) {
    const {failures, checked, workers, serialQueue} = await runParallel(mutations);
    if (failures.length) {
      console.error("mutation gate failed:");
      for (const failure of failures) console.error(`- ${failure}`);
      process.exit(1);
    }
    if (serialQueue.length) {
      console.error(`mutation gate: 另有 ${serialQueue.length} 条登记为必须在真实工作区跑（见 NEEDS_REAL_TREE 上方说明），`
        + "改在真实工作区串行跑 —— 期间不要编辑源文件。");
      const serial = runSerial(serialQueue, {silentOk: true});
      if (serial.failures.length) {
        console.error("mutation gate failed:");
        for (const failure of serial.failures) console.error(`- ${failure}`);
        process.exit(1);
      }
      checked.push(...serial.checked);
    }
    reportDiscovery();
    console.log(`mutation gate ok（并行 ${workers} 路 worktree${serialQueue.length ? ` + ${serialQueue.length} 条真实工作区串行` : ""}）: ${checked.length} 条守卫均已证明其测试具备判别力`);
    for (const line of checked) console.log(line);
    return;
  }
  console.error("mutation gate: 工作区不干净，改用串行模式（worktree 取的是 HEAD，带不上未提交改动，"
    + "并行会测到与本地不同的代码）。"
    + "\n  ⚠ 串行模式会【逐条改写工作区里的真实源文件】再还原：运行期间不要编辑这些文件，"
    + "否则会读到改坏的那份、或被它的还原覆盖掉。想边跑边改就先提交，让它走并行 worktree。");
  runSerial(mutations);
}

// options.silentOk：作为并行批次的补充跑时，由调用方统一收尾报告，这里不要自己打印"全绿"
// 也不要 process.exit —— 否则并行那批的结果会被这一段吞掉。
function runSerial(mutations = MUTATIONS, options = {}) {
  acquireLock();            // 先排除并发实例，否则"恢复"可能覆盖另一个实例正在用的内容
  recoverFromPreviousRun(); // 再收拾上一轮被中断留下的残局，然后才开始改坏任何东西
  const failures = [];
  const checked = [];
  for (const mutation of mutations) {
    if (mutation.skip) { checked.push(`- ${mutation.name}（跳过：${mutation.skip}）`); continue; }
    const path = join(root, mutation.file);
    const original = readFileSync(path, "utf8");
    if (!original.includes(mutation.from)) {
      failures.push(`${mutation.name}: 找不到要改坏的代码片段 —— 守卫可能已被重写，mutation 需同步更新`);
      continue;
    }
    // 目标不唯一必须报错，不能默默改第一处。实测踩到过：SHARED_DEFINITION_BLOCKING_STATUSES.includes(...)
    // 后来在派发循环里也出现了一次、且在文件更靠前，于是这条 mutation 改坏的是另一条路径，
    // 被测的关闭门毫发无损 —— 本门于是报出"你的测试是假绿"。而那条测试其实是好的。
    // 一个把人派去修好测试的假阳性，比漏报更糟：它会让人删掉真正有用的断言。
    const occurrences = original.split(mutation.from).length - 1;
    if (occurrences !== 1) {
      failures.push(`${mutation.name}: 要改坏的代码片段在 ${mutation.file} 里出现了 ${occurrences} 次 —— `
        + "无法确定改的是被测的那一处，mutation 必须写成唯一匹配（连上下文一起写）");
      continue;
    }
    // 【必须先登记再改】——否则上面那套退出钩子拿不到要还原的内容，看着有崩溃安全实则空转
    // （我第一版就是这样：pendingRestores 从没被填充过）。
    const mutated = original.replace(mutation.from, mutation.to);
    pendingRestores.set(path, {original, mutated});
    writePendingNote(path, original, mutated); // 先落便条再改坏：反过来的话，两者之间被杀就没人知道
    writeFileSync(path, mutated);
    let output = "";
    let passed = false;
    try {
      const invocation = gateInvocation(mutation, root);
      execFileSync(invocation.command, invocation.args, {cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: invocation.env});
      passed = true; // 改坏了却还通过 => 测试没有判别力
    } catch (error) {
      output = `${error.stdout || ""}${error.stderr || ""}`;
    } finally {
      // 同上：只在磁盘内容仍是自己写下的那份时才写回。
      let onDisk = "";
      try { onDisk = readFileSync(path, "utf8"); } catch { onDisk = mutated; }
      if (onDisk === mutated) writeFileSync(path, original);
      else process.stderr.write(`mutation gate: ${path} 期间被改动过，已放弃还原以免覆盖它。\n`);
      pendingRestores.delete(path);
      clearPendingNote();
    }
    recordDiscovery(mutation, output);
    process.stdout.write(`  · ${mutation.name} …\n`);
    if (passed) {
      failures.push(`${mutation.name}: 守卫被改坏后 ${mutation.gate || "contract"} 门仍然通过 —— 该守卫的测试是假绿，没有判别力`);
    } else if (!output.includes(mutation.expect)) {
      failures.push(`${mutation.name}: 失败了但不是因为预期断言（期望出现「${mutation.expect}」）—— 测试可能在别处偶然失败，并未真正覆盖这条守卫`);
    } else {
      checked.push(`- ${mutation.name}`);
    }
  }
  if (options.silentOk) return {failures, checked};
  if (failures.length) {
    console.error("mutation gate failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  reportDiscovery();
  console.log(`mutation gate ok: ${checked.length} 条守卫均已证明其测试具备判别力`);
  for (const line of checked) console.log(line);
  return {failures, checked};
}

await run();
