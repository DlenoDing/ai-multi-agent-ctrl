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
    from: "  if (!declared || SUPPORTED_STATE_SCHEMA_VERSIONS.has(declared)) return state;",
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
    from: "        ${lastError ? `<div class=\"notice warn-notice\">连不上控制面或这一页加载失败，下面显示的是",
    to: "        ${false ? `<div class=\"notice warn-notice\">连不上控制面或这一页加载失败，下面显示的是",
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
    from: "${hint}（${requestPath}）`);",
    to: "${hint}`);",
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
    from: "    room_task_group_mismatch: \"只在房间 POST 上返回",
    to: "    room_task_group_mismatchX: \"只在房间 POST 上返回",
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
    from: '    item.issueFingerprint === fingerprint && item.status === "suppressed");',
    to: '    item.issueFingerprint === fingerprint && item.status === "never-matches");',
    expect: "人判过的事又回来了"
  },
  {
    name: "相对时间要按服务器时钟算",
    file: APP,
    gate: "console",
    from: "  const ageMs = serverNow() - new Date(node.lastHeartbeatAt).getTime();",
    to: "  const ageMs = Date.now() - new Date(node.lastHeartbeatAt).getTime();",
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
    from: 'for (const match of src.matchAll(/error:\\s*"([a-z0-9_]{6,})"/gu)) codes.add(match[1]);',
    to: 'for (const match of src.matchAll(/nosuchthing:\\s*"([a-z0-9_]{6,})"/gu)) codes.add(match[1]);',
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
    from: '    verifyMcpToolListCostStaysVisible: "它钉的是上限与实测值本身，撑破它就等于制造它要防的那个问题"',
    to: '    verifyTransitionEngine: "这一条其实已经有变异了"',
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
    from: '      if (context?.principal?.kind !== "system_admin") {',
    to: "      if (false) {",
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
    from: "if (!changedPaths.includes(manifestPath)) {\n      return {valid: false, status: 409, error: \"artifact_manifest_not_changed_in_commit\"};\n    }",
    to: 'if (false) { throw new Error("unreachable"); }',
    expect: "一份旧清单就能给这一轮背书"
  },
  {
    // 这一条被改坏时直接"已受理"：交付清单可以虚报，而人正是照着它验收。
    name: "上一轮的产出不得算进本轮清单",
    file: CORE,
    check: "verifyHumanApprovedPathsBindTheCommit",
    from: "if (!changedPaths.includes(outputRef)) {\n        return {valid: false, status: 409, error: \"artifact_output_ref_not_changed_in_commit\"};\n      }",
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
    from: "  if (sweepFaults) {\n    process.stderr.write(`stale session sweep could not remove",
    to: "  if (false) {\n    process.stderr.write(`stale session sweep could not remove",
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
    from: '`<div class="notice warn-notice">当前没有可用的技能源，所有角色都在用系统内置技能`',
    to: '""',
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
    from: '    badge(source.status) + (source.status === "stale" && source.lastSyncError',
    to: "    badge(source.status) + (false",
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
    from: 'if (context?.principal?.kind !== "system_admin") {',
    to: "if (false) {",
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
    from: '  if (reuse.response.status !== 409 || reuse.payload?.error !== "join_token_not_active") {',
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
    expect: "既没收到 pause_dispatch、也没被改成 blocked"
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
      + `\n  若确认那个进程已死，删除 ${lockPath} 后重试。`);
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
// 于是必跑失败 —— 而失败的原因不是被测守卫，门会报"红了但不是预期原因"（实测到过）。
const NEEDS_REAL_TREE = new Set(["idle", "crash", "writer"]);

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
  mcp: "scripts/doctor-mcp.mjs"
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
    return `${mutation.name}: 失败了但不是因为预期断言（期望出现「${mutation.expect}」）—— 测试可能在别处偶然失败，并未真正覆盖这条守卫`;
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
    if (mutation.from === mutation.to) failures.push(`${mutation.name}: from 与 to 相同 —— 这条变异什么也没改坏`);
    // 门名写错时，真跑起来会表现为"失败了但不是预期断言"——红是红了，但指向的方向完全不对。
    // 在毫秒级的锚点体检里直接拦住，说清可选值。
    if (mutation.gate && !GATE_COMMANDS[mutation.gate]) {
      failures.push(`${mutation.name}: gate "${mutation.gate}" 不存在（可选：${Object.keys(GATE_COMMANDS).join("、")}）`);
    }
    if (mutation.check && (mutation.gate || "contract") !== "contract") {
      failures.push(`${mutation.name}: check 只对契约门有意义，而这条指向 ${mutation.gate} 门 —— 它不会生效，留着会让人以为已经收窄了范围`);
    }
    if (!mutation.expect) failures.push(`${mutation.name}: 没有 expect —— 只看退出码的话，任何一处偶然失败都会被当成"守卫有效"`);
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
  if (workingTreeIsClean()) {
    const {failures, checked, workers, serialQueue} = await runParallel(mutations);
    if (failures.length) {
      console.error("mutation gate failed:");
      for (const failure of failures) console.error(`- ${failure}`);
      process.exit(1);
    }
    if (serialQueue.length) {
      console.error(`mutation gate: 另有 ${serialQueue.length} 条要起服务的门，worktree 里起不来（没有 node_modules），`
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
