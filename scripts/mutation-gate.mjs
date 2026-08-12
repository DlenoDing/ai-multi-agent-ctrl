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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = "apps/control-plane-ui/lib/control-plane-core.mjs";
const MCP = "apps/mcp-server/server.mjs";
const GATEWAY = "apps/control-plane-ui/lib/agent-gateway.mjs";
const PGSTORE = "apps/control-plane-ui/lib/pg-sync-store.mjs";
const STORE = "apps/control-plane-ui/lib/state-store.mjs";
const SERVER = "apps/control-plane-ui/server.mjs";

// 每条 mutation：把守卫改坏，期望 contract-check 失败且输出里出现 expect 片段。
const MUTATIONS = [
  // ── 本段会话新加的守卫：手工变异验过一次不算数，要每次全量 doctor 都重验 ─────────────
  {
    name: "取消/回收必须了结格子名下的资源",
    file: CORE,
    from: "    settleCellOwnedResources(state, dispatch.taskGroupId, dispatch.workItemId, dispatch.failureReason);",
    to: "",
    expect: "旧输出目标仍然可用"
  },
  {
    name: "每个对象一条的派生记录不得上限抖动",
    file: CORE,
    from: "  state.completionReadiness = capPerTaskGroupRecords([readiness, ...state.completionReadiness.filter((item) => item.taskGroupId !== taskGroupId)], state, 80);",
    to: "  state.completionReadiness = [readiness, ...state.completionReadiness.filter((item) => item.taskGroupId !== taskGroupId)].slice(0, 80);",
    expect: "规模下的编排循环停不下来"
  },
  {
    name: "准入账本不得随反复受阻线性增长",
    from: `    if (seenCells.has(item.workItemId)) continue;
    seenCells.add(item.workItemId);`,
    file: CORE,
    to: "",
    expect: "准入账本随反复受阻线性增长"
  },
  {
    name: "执行事件必须续上认领（长任务不得白干）",
    file: GATEWAY,
    from: "      dispatch.claimExpiresAt = renewed;",
    to: "",
    expect: "没有续上认领"
  },
  {
    name: "中央态不得当成完整状态写回",
    file: STORE,
    from: `  if (state && state.__centralOnly) {
    throw Object.assign(new Error("refusing_to_write_central_only_state"), {code: "AIMAC_CENTRAL_ONLY_WRITE"});
  }`,
    to: "",
    expect: "竟然被接受了"
  },
  {
    name: "认不出的状态版本必须拒读",
    file: STORE,
    from: "  if (!declared || SUPPORTED_STATE_SCHEMA_VERSIONS.has(declared)) return state;",
    to: "  return state;",
    expect: "竟然照读不误"
  },
  {
    name: "报文只给对象 id 时也要核对归属",
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
    file: CORE,
    from: 'if (request.decisionClass === "major" && !isHumanConfirmationActor(state, options.actor))',
    to: "if (false)",
    expect: "机器主体（service_account）竟然可以定稿核心决策"
  },
  {
    name: "AI 互审不得直接验收",
    file: CORE,
    from: 'workItem.status = "verification_ready";',
    to: 'workItem.status = "verified";',
    expect: "AI 互审仍然直接把工作项标记为 verified"
  },
  {
    name: "AI 再分析不得终结决策",
    file: CORE,
    from: 'if (!request.awaitingAiAnalysis && Number(request.round || 1) > 1)',
    to: "if (false)",
    expect: "AI 可连续刷新候选方案推进轮次"
  },
  {
    name: "定稿对象不得被掉包",
    file: CORE,
    from: "if (request.subjectContentDigest) {",
    to: "if (false) {",
    expect: "方案在人点确认前被改掉，定稿却仍然生效"
  },
  {
    name: "承载授权的记录 id 必须唯一",
    file: CORE,
    from: "if ((collection || []).some((item) => item?.[idField] === id)) {",
    to: "if (false) {",
    expect: "允许重复 id（冒名记录可顶替人批准的那一份）"
  },
  {
    name: "写入边界一个工作项只能有一份",
    file: MCP,
    from: "if (activeExisting) return {repositoryOutputTarget: activeExisting, deduplicated: true};",
    to: "",
    expect: "同一工作项出现了多份生效的写入边界"
  },
  {
    name: "确认单去重键按类别隔离",
    file: CORE,
    from: "const dedupeKey = `${decisionType}:` + (String(input.requestKey",
    to: 'const dedupeKey = "" + (String(input.requestKey',
    expect: "运行时确认单顶掉了核心决策单"
  },
  {
    name: "执行证据去重限定本次派发",
    file: GATEWAY,
    from: "item.eventKey === eventKey && item.dispatchId === dispatchId",
    to: "item.eventKey === eventKey",
    expect: "执行事件按全局 eventKey 去重"
  },
  {
    name: "技能绑定不得被冒名顶替且不得回退占位",
    file: CORE,
    from: "skillBasename(skill) === hint.skillRef",
    to: 'String(skill.roleSkillId || "").endsWith("/" + hint.skillRef)',
    expect: "真实同步技能没有被绑定"
  },
  // 本次会话新增的守卫。它们的判别力当时都手工验过，但手工验证不可重复 —— 而"守卫在，
  // 而它的测试是假绿"正是本门存在的理由。只收有 contract-check 断言的那几条（本门只跑它）。
  {
    name: "已关闭的任务组不得被再关一次（覆盖定稿归属）",
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
    file: PGSTORE,
    from: "    shards: assertProjectShardsArray(projectShards),",
    to: "    shards: Array.isArray(projectShards) ? projectShards : [],",
    expect: "没有接在 PostgreSQL 写入路径上"
  },
  {
    name: "被降级的状态机保证不得对人隐身",
    file: CORE,
    from: "  state.runtime.transitionEnforcement = transitionEnforcementMode(state);",
    to: "  state.runtime.transitionEnforcement ||= transitionEnforcementMode(state);",
    expect: "没有被重算覆盖"
  },
  {
    name: "定稿后方案实质变过就不得照常执行",
    file: CORE,
    from: 'if (["start", "merge"].includes(action) && topology.humanFinalization?.subjectContentDigest) {',
    to: "if (false) {",
    expect: "实质内容被改动"
  },
  {
    name: "AI 不得自行降级已定稿方案",
    file: CORE,
    from: 'if (topology.humanFinalization?.outcome === "confirmed" && !downgradeApproved) {',
    to: "if (false) {",
    expect: "自行降级"
  },
  {
    name: "AI 不得自行取消已定稿方案",
    file: CORE,
    from: 'if (topology.humanFinalization?.outcome === "confirmed" && !cancelApproved) {',
    to: "if (false) {",
    expect: "自行取消"
  },
  {
    name: "人要据以定稿的文本被截断时必须留痕",
    file: CORE,
    from: "return `${text.slice(0, Math.max(0, max - marker.length))}${marker}`;",
    to: "return text.slice(0, max);",
    expect: "静默截断"
  },
  {
    name: "执行器凭据不得等同于节点令牌",
    file: GATEWAY,
    from: 'if (dispatch.status !== "running" || !dispatch.executorTokenDigest || !dispatch.assignedNodeId) continue;',
    to: "if (!dispatch.executorTokenDigest || !dispatch.assignedNodeId) continue;",
    expect: "executor credential"
  },
  {
    name: "规则标题必须进摘要（否则改标题＝改模型读到的内容而漂移检测失明）",
    file: CORE,
    from: "const digest = digestOf({ruleId, category, title, content});",
    to: "const digest = digestOf({ruleId, category, content});",
    expect: "effective-rules digest"
  },
  {
    name: "草稿契约不得锁死关闭门（人无杠杆）",
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
    file: CORE,
    from: "const projectRefs = [`Project:${taskGroup.projectId}`, taskGroup.projectId];",
    to: 'const projectRefs = [`Project:${taskGroup.projectId}`, taskGroup.projectId, "Project"];',
    expect: "裸 Project 通配锁死了别的任务组"
  },
  {
    name: "合法发布必须真的激活",
    file: CORE,
    from: "args.allowDirectActivation === true",
    to: "false",
    expect: "合法发布未能激活"
  },
  {
    name: "技能绑定读的是生产者真实字段",
    file: CORE,
    from: 'String(skill.sourcePath || "")',
    to: 'String(skill.relativePath || "")',
    expect: "真实同步技能没有被绑定"
  },
  {
    name: "共享定义状态不得由调用方声称",
    file: CORE,
    from: "      : (SHARED_DEFINITION_CREATABLE_STATUSES.includes(args.status) ? args.status : \"draft\"),",
    to: '      : (args.status || "draft"),',
    expect: "调用方可直接把共享定义声明为生效/冲突"
  },
  {
    name: "publish 不得铸造未知契约",
    file: MCP,
    from: 'if (!definition) return {ok: false, error: "shared_definition_not_found"};',
    to: "if (!definition) return {ok: false, error: \"shared_definition_not_found\"}; // eslint-disable-line",
    to_alt: true,
    expect: "publish 铸造并激活了一个未知契约",
    skip: "publish 的 mutation 需要重建 || 分支，改动过大，由 validate-specs 的源码断言覆盖"
  },
  {
    name: "越权访问必须被漂移门定性阻断",
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
    file: CORE,
    from: '      if (["verified", "closed"].includes(workItem.status)) {',
    to: '      if (["verified", "closed"].includes(workItem.status) && workItem.progress >= 100) {',
    expect: "已被人验收定稿的工作项又被派发出去了"
  },
  {
    name: "容量淘汰不得删掉还开着的任务组",
    file: STORE,
    from: '  taskGroups: (item) => !["closed", "aborted"].includes(item.status)',
    to: "  taskGroups: () => false",
    expect: "里最老的【未了结】记录被容量淘汰"
  },
  {
    name: "容量淘汰不得删掉人已经作出的决定",
    file: STORE,
    from: '  humanConfirmationRequests: (item) => !["consumed", "expired", "cancelled"].includes(item.status),',
    to: '  humanConfirmationRequests: (item) => item.status === "pending",',
    expect: "把【非终态】HumanConfirmationRequest.answered 当成可淘汰的历史"
  },
  {
    name: "MCP 租户边界必须覆盖每一个对象地址",
    file: MCP,
    from: '  "envelopeId", "grantId", "nodeId", "reviewBundleId", "reviewPlanId", "topologyId"',
    to: '  "envelopeId", "grantId", "nodeId", "reviewBundleId", "reviewPlanId"',
    expect: "topologyId 是一个项目级对象地址"
  },
  {
    name: "读侧每个集合都要么被过滤、要么登记为全局",
    file: SERVER,
    from: "  cloned.reviewBundles = (state.reviewBundles || []).filter((item) => visibleTaskGroupIds.has(item.taskGroupId));\n",
    to: "",
    expect: "既没有在 scopedStateForAccount 里按可见性过滤"
  },
  {
    name: "幂等重放必须绑定到当初那个调用方",
    file: MCP,
    from: "        || existingRecord.principalRef !== principalRef))",
    to: "))",
    expect: "另一个主体用同一把幂等键拿到了上一个主体的执行结果"
  },
  {
    name: "分片拆合不得丢字段",
    file: STORE,
    from: "      shard.collections[collection].push(item);",
    to: "      const {updatedAt, ...rest} = item;\n      shard.collections[collection].push(rest);",
    expect: "落盘再读回后对不上"
  },
  // ↓ 本会话新增的守卫。它们此前只被手工变异验证过一次，而"验证过一次"与"以后一直有效"是两件事。
  {
    name: "控制命令重试用尽后不得还说「进行中」",
    file: GATEWAY,
    from: "      dispatch.blockedReason = rejectedReason;",
    to: '      dispatch.blockedReason = "control_pause_requested";',
    expect: "重试用尽后，派发原因仍是"
  },
  {
    name: "人批准的路径边界必须压在 git 算出的真实变更上",
    file: CORE,
    from: "  if (approvedPaths.length) {",
    to: "  if (false) {",
    expect: "人批的边界只由 agent 自报来守"
  },
  {
    name: "人在方案里划的禁区必须被强制",
    file: CORE,
    from: "  if (forbiddenApproved.length) {",
    to: "  if (false) {",
    expect: "禁区只是记录里的一行字"
  },
  {
    name: "人批准时看到的验收项必须有证据",
    file: CORE,
    from: "      && (branch.acceptanceChecks || []).length && !(branch.validationEvidenceRefs || []).length) {",
    to: "      && false) {",
    expect: "跑没跑从来没有人对账"
  },
  {
    name: "任务组读摘要的记忆化必须按 stateVersion 失效",
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
    expect: "没有被裁回上限"
  },
  {
    name: "在制品上限：额度必须按项目算，不得跨项目共享",
    file: CORE,
    from: "const wipNow = wipInFlight.get(taskGroup.projectId) || 0;",
    to: "const wipNow = [...wipInFlight.values()].reduce((sum, value) => sum + value, 0);",
    expect: "跨项目共享"
  },
  {
    name: "优先级预留：靠后组的 P0 不得被靠前组的普通活饿死",
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
    expect: "扣住了没还回来"
  },
  {
    name: "优先级预留：让路与额度真满不得记成同一件事",
    file: CORE,
    from: 'whyThisCellNow: wipNow >= wipCap ? "cell_waiting_for_wip_capacity" : "cell_yielding_to_higher_priority"',
    to: 'whyThisCellNow: "cell_waiting_for_wip_capacity"',
    expect: "人无从分辨"
  },
  {
    name: "在制品上限：闸必须真的挡住",
    file: CORE,
    from: "      if (wipNow >= wipCap) {",
    to: "      if (false) {",
    expect: "闸没生效"
  },
  {
    name: "在制品上限：额度不得算成 0（否则永远派不出第一个活）",
    file: CORE,
    from: "  return queueHead + online * perNode;",
    to: "  return 0;",
    expect: "额度算成了 0"
  },
  {
    name: "在制品上限：等额度是背压，不得记成 blocked",
    file: CORE,
    from: 'outcome: "resource_queued", reasonCode: "wip_capacity_reached"',
    to: 'outcome: "blocked", reasonCode: "wip_capacity_reached"',
    expect: "resource_queued"
  },
  {
    name: "在制品上限：在飞状态集合必须与 AgentDispatch 状态机一致",
    file: CORE,
    from: '["queued", "running", "blocked"]',
    to: '["queued", "running"]',
    expect: "漏了非终态"
  },
  {
    name: "租约索引必须核对状态，不得把已释放的租约当成活的",
    file: CORE,
    from: '  if (cached && cached.status === "active" && cached.resourceRef === resourceRef) return cached;',
    to: "  if (cached) return cached;",
    expect: "写锁形同虚设"
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

function removeWorktrees(dirs) {
  for (const dir of dirs) {
    try { execFileSync("git", ["worktree", "remove", "--force", dir], {cwd: root, stdio: "ignore"}); } catch { /* 尽力而为 */ }
  }
}

// 必须是异步子进程：execFileSync 会阻塞整个进程，用它做"池"等于串行。
function runContractCheck(workdir) {
  return new Promise((resolve) => {
    execFile("node", [join(workdir, "scripts/contract-check.mjs")], {cwd: workdir, maxBuffer: 64 * 1024 * 1024},
      (error, stdout, stderr) => resolve({failed: Boolean(error), output: `${stdout || ""}${stderr || ""}`}));
  });
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
    result = await runContractCheck(workdir);
  } finally {
    writeFileSync(target, original); // 只动副本，真实工作区全程未被触碰
  }
  if (!result.failed) return `${mutation.name}: 守卫被改坏后 contract-check 仍然通过 —— 该守卫的测试是假绿，没有判别力`;
  if (!result.output.includes(mutation.expect)) {
    return `${mutation.name}: 失败了但不是因为预期断言（期望出现「${mutation.expect}」）—— 测试可能在别处偶然失败，并未真正覆盖这条守卫`;
  }
  return null;
}

async function runParallel(mutations) {
  const workers = Math.max(1, Math.min(4, cpus().length - 2));
  pruneStaleWorktrees();
  const dirs = [];
  for (let index = 0; index < workers; index += 1) {
    const dir = join(tmpdir(), `${WORKTREE_PREFIX}${process.pid}-${index}`);
    try { rmSync(dir, {recursive: true, force: true}); } catch { /* 尽力而为 */ }
    execFileSync("git", ["worktree", "add", "--detach", "--quiet", dir, "HEAD"], {cwd: root, stdio: "ignore"});
    dirs.push(dir);
  }
  process.on("exit", () => removeWorktrees(dirs));
  const queue = [...mutations];
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
  return {failures, checked, workers};
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
    const {failures, checked, workers} = await runParallel(mutations);
    if (failures.length) {
      console.error("mutation gate failed:");
      for (const failure of failures) console.error(`- ${failure}`);
      process.exit(1);
    }
    console.log(`mutation gate ok（并行 ${workers} 路 worktree）: ${checked.length} 条守卫均已证明其测试具备判别力`);
    for (const line of checked) console.log(line);
    return;
  }
  console.error("mutation gate: 工作区不干净，改用串行模式（worktree 取的是 HEAD，带不上未提交改动，"
    + "并行会测到与本地不同的代码）。"
    + "\n  ⚠ 串行模式会【逐条改写工作区里的真实源文件】再还原：运行期间不要编辑这些文件，"
    + "否则会读到改坏的那份、或被它的还原覆盖掉。想边跑边改就先提交，让它走并行 worktree。");
  runSerial(mutations);
}

function runSerial(mutations = MUTATIONS) {
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
      execFileSync("node", [join(root, "scripts/contract-check.mjs")], {cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
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
    process.stdout.write(`  · ${mutation.name} …\n`);
    if (passed) {
      failures.push(`${mutation.name}: 守卫被改坏后 contract-check 仍然通过 —— 该守卫的测试是假绿，没有判别力`);
    } else if (!output.includes(mutation.expect)) {
      failures.push(`${mutation.name}: 失败了但不是因为预期断言（期望出现「${mutation.expect}」）—— 测试可能在别处偶然失败，并未真正覆盖这条守卫`);
    } else {
      checked.push(`- ${mutation.name}`);
    }
  }
  if (failures.length) {
    console.error("mutation gate failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(`mutation gate ok: ${checked.length} 条守卫均已证明其测试具备判别力`);
  for (const line of checked) console.log(line);
}

await run();
