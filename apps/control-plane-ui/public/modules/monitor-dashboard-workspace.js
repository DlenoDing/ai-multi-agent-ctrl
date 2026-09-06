(function initMonitorDashboardWorkspace(global) {
  "use strict";

function render(context, helpers) {
  const {
    currentAccount, currentProjectId, execEvents = [], execHasMore, execHistoryMode,
    execHistoryStack = [], execScope = {}, managementGroupId, selectedExecutionObject, state
  } = context;
  const {
    AGENT_MODEL_PRESET_LABEL, SESSION_SETTLED_STATUSES, accountName, admissionReasonLabel,
    agentActions, badge, claimMissHint, countSuffix, currentProject, customBadge,
    decisionSelect, esc, evidenceRefsHint, explainCoded, filterInput, filterSource,
    fleetOfflineNotice, fmtTime, focusedTaskGroups, gatingArtifactRows, hasGroupPerm,
    hasNoVisibleProject, hasPerm, heartbeatStaleHint, heartbeatTimedOut, laneFunctionLabel,
    modelDecisionSummaryZh, moreText, noRightOnThisGroup, noVisibleProjectNotice,
    orchestratorStalledNotice, panel, percentCell, perspectiveOf,
    projectTaskGroups, recentHumanFinalizations, renderExecutionObjectDetail,
    renderMonitorActionBoard, renderMonitorRealtimeGuide, renderMonitorSummary,
    renderTaskGroupMonitorMatrix, repositoryFailureAction, row, selfCheckFailureHint,
    sinceText, stuckExitNotice, t, table, taskGroupById, taskGroupNameOf,
    taskGroupOperationalStats, terminalDispatchStatuses, topologyBlockerText
  } = helpers;
  // 一个项目都没有时，这一页原先摆出十一张"暂无数据"的空表和一个空的监听范围下拉 ——
  // 屏幕上全是表头，没有一句话说明为什么什么都没有、下一步该做什么。
  // 条件是"没有项目，且这一页范围内一件事都没有"。生产上 projects 为空时本来就取不到任务组，
  // 两个条件必然同时成立；多这一句只是不去误伤那些"任务组挂着 projectId、状态里却没有 projects"
  // 的老夹具 —— 那种形状真实部署里不存在，但把它们逐个改掉的风险大于收益。
  if (hasNoVisibleProject() && !projectTaskGroups().length) {
    return panel("执行监控", noVisibleProjectNotice(), {wide: true});
  }
  if (selectedExecutionObject.id) return renderExecutionObjectDetail();
  const groups = focusedTaskGroups();
  // 这一页整体以"当前项目"为抬头，因此页内每张表都必须按它过滤。
  // 此前七张表里有五张漏了，最严重的一张还挂着"关闭任务组"按钮。
  const inScope = (item) => groups.some((taskGroup) => taskGroup.id === item.taskGroupId);
  const scopeOptions = [
    {value: `project:${currentProjectId}`, label: "整个项目"},
    ...groups.map((taskGroup) => ({value: `taskGroup:${taskGroup.id}`, label: `任务组 · ${taskGroup.name || taskGroup.id}`}))
  ];
  const scopeValue = execScope.id ? `${execScope.type}:${execScope.id}` : "";
  if (execScope.id && !scopeOptions.some((option) => option.value === scopeValue)) {
    scopeOptions.unshift({value: scopeValue, label: `${execScope.type === "dispatch" ? "派发" : execScope.type === "session" ? "会话" : "任务组"} · ${execScope.id}`});
  }

  const eventsShown = filterSource(execEvents.filter((event) => !managementGroupId || event.taskGroupId === managementGroupId).slice().reverse(), "events");
  const eventRows = eventsShown.slice(0, 120).map((event) => row([
    {v: esc(event.sequence), c: "num"},
    badge(event.eventType, "blue"),
    {v: percentCell(event.progressPercent), c: "num"},
    badge(event.status),
    // 证据引用此前从不渲染，而执行方恰恰在这里上报了"这次提示词里实际包含了哪几份规则文件"
    // （prompt-includes:system/rules.md 之类）。人在控制台上只看得到 summary 里那句"含 N 个规则文件"，
    // 看不到是哪几个 —— 而"人写下的那份规则有没有真的到达模型"正是要从这里回答的。
    {v: `${esc(event.summary || "-")}${evidenceRefsHint(event)}${repositoryFailureAction(event)}`, c: "text-clip"},
    {v: fmtTime(event.createdAt), c: "nowrap"}
  ])).join("");

  const LANE_STATUS = {idle: {label: "空闲", tone: "green"}, busy: {label: "占用中", tone: "blue"}, retired: {label: "已归档", tone: "gray"}};
  const lanesAll = filterSource((state.workerLanes || []).filter((lane) => groups.some((taskGroup) => taskGroup.id === lane.taskGroupId)), "worker-lanes");
  const laneRows = lanesAll.slice(0, 20).map((lane) => row([
    esc(t(lane.roleId)),
    esc(laneFunctionLabel(lane.laneFunction)),
    customBadge((LANE_STATUS[lane.status] || {label: lane.status}).label, (LANE_STATUS[lane.status] || {}).tone || "gray"),
    {v: String(lane.reuseGeneration ?? 0), c: "num"},
    lane.currentSessionId ? {v: `<span class="mono">${esc(lane.currentSessionId)}</span>`, c: "nowrap"} : "-",
    {v: fmtTime(lane.updatedAt), c: "nowrap"}
  ])).join("");

  const sessionsAll = filterSource((state.workSessions || []).filter((session) => groups.some((taskGroup) => taskGroup.id === session.taskGroupId)), "sessions");
  const sessions = sessionsAll.slice(0, 20).map((session) => row([
    `<span class="mono">${esc(session.sessionId)}</span>`,
    esc(t(session.roleId)),
    `<span class="mono">${esc(session.workItemId || "-")}</span>`,
    badge(session.placement),
    session.laneId ? {v: `<span class="mono">${esc(session.laneId)}</span>`, c: "nowrap"} : "-",
    badge(session.status),
    // 会话的阻塞原因此前只写在记录里、从不渲染：人看到一个 needs_decision 的徽标，看不出为什么。
    esc(explainCoded(session.blockedReason)) + repositoryFailureAction(session),
    `<button class="primary-button" data-action="open-execution-object" data-execution-type="session" data-execution-id="${esc(session.sessionId)}" data-task="${esc(session.taskGroupId)}">查看详情</button>`
  ])).join("");

  const dispatchesAll = filterSource((state.agentDispatches || []).filter((dispatch) => groups.some((taskGroup) => taskGroup.id === dispatch.taskGroupId)), "dispatches");
  const dispatches = dispatchesAll.slice(0, 20).map((dispatch) => {
    const controls = `<button class="primary-button" data-action="open-execution-object" data-execution-type="dispatch" data-execution-id="${esc(dispatch.dispatchId)}" data-task="${esc(dispatch.taskGroupId)}">查看详情</button>`;
    return row([
    `<span class="mono">${esc(dispatch.dispatchId)}</span>`,
    `<span class="mono">${esc(dispatch.workItemId || "-")}</span>`,
    badge(dispatch.status),
    {v: percentCell(dispatch.progressPercent), c: "num"},
    // 「最近动静」＝上一条执行事件到现在有多久。进度百分比是【最高水位】（只增不减），
    // 所以一个卡住的派发会一直显示同一个数字，看不出它其实早就不动了。
    // 已了结的派发不能说「还没被领走」：认领时间在了结时被清掉，于是一条【已完成】的派发
    // 在这一列上写着"还没被领走"（真实运行态上读到的，doctor 那条 work_management_ui 正是如此）。
    // 了结记录的 updatedAt 就是它最后一次动的时间，说这个既准确又不夸大。
    {v: dispatch.lastExecutionEventAt
      ? esc(sinceText(dispatch.lastExecutionEventAt))
      : terminalDispatchStatuses.has(dispatch.status)
        ? `<span class="muted">已了结${dispatch.updatedAt ? ` ${esc(sinceText(dispatch.updatedAt))}` : ""}</span>`
        : `<span class="muted">${dispatch.claimedAt ? `领走 ${esc(sinceText(dispatch.claimedAt))}，还没有过动静` : "还没被领走"}</span>`,
      c: "nowrap"},
    // 这两个标记控制面早就在写了（写它们的注释里明写着"必须留痕并让人看到"），而控制台从来没有
    // 渲染过它们 —— 于是人只看到"认领超时重新入队"，看不到最要紧的那句：上一任可能已经把提交推上去了。
    // 新持有者的 reset --hard origin/<branch> 会把那些提交当作基线继续往上做，而没有任何人复核过它们。
    [
      esc(explainCoded(dispatch.blockedReason || dispatch.failureReason)),
      repositoryFailureAction(dispatch),
      // 卡在人工确认上时，控制面【知道】是哪一张卡挡住的（dispatch.humanConfirmationRef），
      // 而这里从来没显示过它 —— 人只看到"到人工审核页定稿对应的确认卡"，
      // 却不知道是哪一张；审核页上同时挂着好几张时，只能一张张点开比对。
      dispatch.humanConfirmationRef
        ? `<div class="small muted">在等这张卡：<span class="mono">${esc(dispatch.humanConfirmationRef)}</span></div>`
        : "",
      dispatch.previousHolderMayHavePushed
        ? `<div class="small warn-text">⚠ 上一任持有者${dispatch.recycledFromNodeId ? `（${esc(dispatch.recycledFromNodeId)}）` : ""}可能已经推送过提交：新持有者会把它们当作基线，需人工核对该分支</div>`
        : "",
      dispatch.rulesChangedAfterContract
        ? `<div class="small warn-text">⚠ 契约签发之后规则发生过变更：这次执行遵循的可能不是当前生效的规则</div>`
        : ""
    ].filter(Boolean).join(""),
    controls
  ]);
  }).join("");

  const commandsInScope = (state.agentControlCommands || []).filter(inScope);
  const commands = commandsInScope.slice(0, 16).map((command) => row([
    {v: esc(command.sequence), c: "num"},
    `<span class="mono">${esc(command.nodeId)}</span>`,
    badge(command.commandType, "blue"),
    `<span class="mono">${esc(command.dispatchId || command.sessionId || "-")}</span>`,
    badge(command.status),
    // 节点报回来的原因（ackResult.reason）：网关一直在存，全仓零处读 ——
    // 屏幕上只有一个「已拒绝」，人无处可查为什么。code:detail 形态交给 explainCoded 查词表。
    {v: esc(explainCoded(command.ackResult?.reason || "")) || "-", c: "text-clip"},
    {v: fmtTime(command.updatedAt || command.createdAt), c: "nowrap"}
  ])).join("");

  const canControlNodes = hasPerm("agent:activate");
  const canOrchestrate = hasPerm("task_group:orchestrate");
  const involvedNodeIds = new Set([...dispatchesAll.map((dispatch) => dispatch.assignedNodeId), ...commandsInScope.map((command) => command.nodeId)].filter(Boolean));
  const monitorNodes = (state.agentRuntimeNodes || []).filter((node) => !managementGroupId || involvedNodeIds.has(node.nodeId));
  const nodes = monitorNodes.map((node) => row([
    `<strong>${esc(node.nodeName || node.nodeId)}</strong><div class="small muted mono">${esc(node.nodeId)}</div>`,
    // "降级/只读"此前不说原因：缺哪几项自检只进网关事件负载，而那条流没有任何界面。
    // 人看到一个黄色徽标，然后无从下手。
    `${heartbeatTimedOut(node)
      ? `${badge("heartbeat_timeout")}<div class="small warn-text">记录上还写着「${esc(t(node.status) || node.status)}」——`
        + "那是上一次扫描留下的，心跳早就断了</div>"
      : badge(node.status)}${claimMissHint(node)}${node.runtimeOutdated
      ? `<div class="small warn-text">运行时版本过旧（${esc(node.runtimeVersion || "未知")}）：它不发送认领代次，一旦这台机器上的派发被重新认领，提交就会被拒。请在该主机上重新执行入网安装命令升级。</div>`
      : ""}${(node.selfCheckMissing || []).length
      ? `<div class="small warn-text">自检未通过：${(node.selfCheckMissing || []).map((item) => esc(t(item))).join("、")}</div>`
        + selfCheckFailureHint(node) : ""}`,
    badge(node.admission),
    // 心跳时间戳原先只是一个时间：人得自己算它有多旧，而"节点其实已经死了"正是最该一眼看出来的。
    {v: `${fmtTime(node.lastHeartbeatAt)}${heartbeatStaleHint(node)}`, c: "nowrap"},
    node.status !== "revoked" && canControlNodes ? agentActions(node, {scope: "project", showDanger: false, includeDispatchControl: false}) : "-"
  ])).join("");

  const decisionsInScope = (state.modelSelectionDecisions || []).filter(inScope);
  const decisions = decisionsInScope.slice(0, 10).map((decision) => row([
    // 套用了别人的策略要在【角色】这一列上说出来：这条决策依据的能力要求与硬约束
    // 不是这个角色自己的（22 个已登记角色里有 10 个没有专属策略）。留痕不显示等于没留。
    esc(t(decision.roleId)) + (decision.policyFallback
      ? `<div class="small warn-text">套用了 ${esc(decision.policyFallback.boundTo || "别的角色")} 的选型策略（本角色没有专属策略）</div>`
      : ""),
    decision.selectedAgentId
      ? `<strong>${esc((state.agents || []).find((agent) => agent.id === decision.selectedAgentId)?.name || decision.selectedAgentId)}</strong>
        <div class="small muted mono">${esc(decision.selectedAgentId)}</div>
        <div class="small muted">偏好：${esc(AGENT_MODEL_PRESET_LABEL[decision.agentModelPreference] || decision.agentModelPreference || "未设置")}</div>`
      : `<span class="muted">未绑定档案</span>`,
    `<span class="mono">${esc(decision.workItemId || "-")}</span>`,
    `<span class="mono">${esc(decision.selectedModel?.modelId || "-")}</span>`,
    badge(decision.status),
    {v: esc(modelDecisionSummaryZh(decision)), c: "text-clip"}
  ])).join("");

  const placementsInScope = (state.sessionPlacementDecisions || []).filter(inScope);
  const placements = placementsInScope.slice(0, 10).map((decision) => row([
    `<span class="mono">${esc(decision.workItemId || "-")}</span>`,
    badge(decision.placement),
    badge(decision.workerCarrierDecision?.carrier || "-"),
    badge(decision.status)
  ])).join("");

  const admissionsInScope = (state.admissionDecisions || []).filter(inScope);
  const admissions = admissionsInScope.slice(0, 12).map((decision) => row([
    `<span class="mono">${esc(decision.workItemId || "-")}</span>`,
    badge(decision.outcome),
    badge(decision.cellClass || "-"),
    {v: esc(admissionReasonLabel(decision)), c: "text-clip"}
  ])).join("");

  const checkpointRows = filterSource((state.checkpoints || []).filter((cp) => groups.some((taskGroup) => taskGroup.id === cp.taskGroupId)), "checkpoints").slice(0, 20).map((cp) => {
    const lastCommit = cp.commitRefs?.at(-1);
    const lastPush = cp.pushRefs?.at(-1);
    const commitLabel = lastCommit ? esc(String(lastCommit.commit || lastCommit).slice(0, 12)) : "";
    const commitExtra = (cp.commitRefs || []).length > 1 ? ` +${(cp.commitRefs || []).length - 1}` : "";
    const pushLabel = lastPush ? esc(`${String(lastPush.remote || "")}/${String(lastPush.ref || lastPush.remoteSha || lastPush)}`) : "";
    return row([
      esc(taskGroupNameOf(cp.taskGroupId)),
      `<span class="mono">${esc(cp.workId || "-")}</span>`,
      lastCommit ? {v: `<span class="mono">${commitLabel}</span>${commitExtra}`, c: "nowrap"} : "-",
      lastPush ? {v: `<span class="mono">${pushLabel}</span>`, c: "nowrap"} : "-",
      {v: esc(cp.artifactManifestRefs?.[0] || "-"), c: "text-clip"},
      {v: fmtTime(cp.createdAt), c: "nowrap"}
    ]);
  }).join("");
  // 一张只显示"已通过"的表会让人以为门都真过了。曾判失败后被执行方重报为通过、以及无新证据的
  // 反复重报次数，都是"AI 在硬顶人工闸门"的信号，必须直接摆在这张表里。
  const qualityGateRows = filterSource((state.qualityGates || []).filter((qg) => groups.some((taskGroup) => taskGroup.id === qg.taskGroupId)), "quality-gates").slice(0, 20).map((qg) => row([
    esc(taskGroupNameOf(qg.taskGroupId)),
    esc(t(qg.gateType) || qg.gateType || "-"),
    `<span class="mono">${esc(qg.workItemId || "-")}</span>`,
    badge(qg.status) + (qg.previouslyFailed && qg.status === "passed" ? " " + customBadge("曾失败后被重报", "orange") : "")
      + (Number(qg.reassertedWithoutNewEvidenceCount) ? " " + customBadge(`无新证据重报 ${qg.reassertedWithoutNewEvidenceCount} 次`, "red") : "")
      + (qg.status === "waived" && qg.waivedBy ? ` <span class="record-meta">由 ${esc(qg.waivedBy)} 豁免</span>` : ""),
    {v: fmtTime(qg.updatedAt || qg.createdAt), c: "nowrap"}
  ])).join("");
  const waivableGates = (state.qualityGates || [])
    .filter((qg) => groups.some((taskGroup) => taskGroup.id === qg.taskGroupId) && !["passed", "waived"].includes(qg.status))
    .slice(0, 8);
  const failingTests = (state.testResults || []).filter((tr) => groups.some((taskGroup) => taskGroup.id === tr.taskGroupId) && ["failed", "error"].includes(tr.status));
  const canReviewGates = hasPerm("task_group:review");     // quality_gate_waive / review_plan_resolve
  const openReviewPlans = (state.reviewPlans || []).filter((plan) => inScope(plan) && !["closed", "rejected", "superseded"].includes(plan.status)).slice(0, 8);
  const openRuleSources = (state.ruleSourceResolutions || []).filter((item) => inScope(item) && !["reference_only", "quarantined", "rejected", "superseded", "active"].includes(item.status)).slice(0, 8);
  // 同段其余四处都按 inScope 过滤，唯独这里漏了 —— 于是在项目 A 的监控页上会列出项目 B 的契约。
  // （跨租户仍然安全：服务端只下发可见项目的契约。但列在这里会让人以为它属于当前项目。）
  const visibleProjectIds = new Set(groups.map((taskGroup) => taskGroup.projectId).filter(Boolean));
  const blockingDefinitions = (state.sharedDefinitions || []).filter((definition) =>
    ["owner_assigned", "proposed", "reviewing", "change_requested", "conflicted"].includes(definition.status)
    && (!definition.projectId || visibleProjectIds.has(definition.projectId))).slice(0, 8);
  const openReviewBundles = (state.reviewBundles || []).filter((item) => inScope(item) && !["consumed", "rejected"].includes(item.status)).slice(0, 8);
  const openUpgradeCandidates = (state.systemUpgradeCandidates || []).filter((item) => inScope(item) && item.status === "candidate_created").slice(0, 8);
  const finalizations = recentHumanFinalizations(new Set(groups.map((taskGroup) => taskGroup.id)));

  // 卡住的执行方案会永久挡住关闭门：分支报了 failed 之后拓扑照样进 integrating，merge 只认  // 卡住的执行方案会永久挡住关闭门：分支报了 failed 之后拓扑照样进 integrating，merge 只认
  // accepted、cancel 又只有人能做。后端一直有"人来取消"这条杠杆（契约检查专门断言过它必须存在），
  // 但 executionTopologies 根本不在下发字段里，界面上也没有入口 —— 后端有杠杆而界面没有入口，
  // 等于这个杠杆不存在：人只看到"存在阻塞 · N 项"里的一个红 chip，然后无从下手。
  const TOPOLOGY_CANCELLABLE = ["running", "integrating", "blocked", "needs_reconcile"];
  const stuckTopologies = (state.executionTopologies || [])
    .filter((item) => inScope(item) && TOPOLOGY_CANCELLABLE.includes(item.status)).slice(0, 8);
  // 资格检查没过的方案是另一个死角，而且此前【整个界面都看不到它】：
  //   start 被阻塞项挡下 · cancel 只从上面那四种状态走 · 于是后端唯一接受的出口是【降级为串行】。
  // 人在任务组上只看到"存在阻塞 · N 项"一个红 chip，点不进去也不知道该做什么，
  // 而 no_open_execution_topologies 会一直挡着关闭门（非终态）。降级后进入 downgraded 终态。
  const downgradableTopologies = (state.executionTopologies || [])
    .filter((item) => inScope(item) && item.status === "eligibility_checked" && (item.blockers || []).length)
    .slice(0, 8);
  const canControlRules = hasPerm("task_group:control");   // rule_source_settle
  const canUpdateProject = hasPerm("project:update");      // shared_definition_resolve
  // 【够不着的那几条要按任务组数，不能按跨资源并集判】。canReviewGates 之类走的是
  // effectivePermissions —— 服务端注释里就写着它只是 UI 提示、是所有资源上的并集。
  // 于是在 tg1 上有评审权的人，canReviewGates 为真：那句"你没有权限"的警告不显示；
  // 而下面每一段又按任务组过滤，tg2 里那两条待收尾的评审计划一条都不列 ——
  // 结果是它们既不显示、也不解释，人只看到任务组上「存在阻塞」，而它们正挡着关闭门。
  // 改成逐项数：够不着的有几条、在哪几个组、缺哪个权限，都说出来。
  const outOfReach = [
    ...openReviewPlans.filter((item) => !hasGroupPerm(item.taskGroupId, "task_group:review"))
      .map((item) => ["评审计划", item.taskGroupId, "人工审核(task_group:review)"]),
    ...openReviewBundles.filter((item) => !hasGroupPerm(item.taskGroupId, "task_group:review"))
      .map((item) => ["评审包", item.taskGroupId, "人工审核(task_group:review)"]),
    ...openRuleSources.filter((item) => !hasGroupPerm(item.taskGroupId, "task_group:control"))
      .map((item) => ["规则来源", item.taskGroupId, "任务组控制(task_group:control)"]),
    ...openUpgradeCandidates.filter((item) => !hasGroupPerm(item.taskGroupId, "task_group:control"))
      .map((item) => ["升级候选", item.taskGroupId, "任务组控制(task_group:control)"]),
    ...(canUpdateProject ? [] : blockingDefinitions.map((item) => ["共享定义契约", item.taskGroupId, "项目更新(project:update)"]))
  ];
  const outOfReachBlockerNotice = () => {
    if (!outOfReach.length) return "";
    const byPerm = new Map();
    for (const [kind, taskGroupId, perm] of outOfReach) {
      if (!byPerm.has(perm)) byPerm.set(perm, {count: 0, kinds: new Set(), groups: new Set()});
      const bucket = byPerm.get(perm);
      bucket.count += 1;
      bucket.kinds.add(kind);
      if (taskGroupId) bucket.groups.add(taskGroupNameOf(taskGroupId));
    }
    const lines = [...byPerm].map(([perm, bucket]) =>
      `${[...bucket.kinds].join("、")} ${bucket.count} 项`
      + `${bucket.groups.size ? `（${[...bucket.groups].slice(0, 3).join("、")}${bucket.groups.size > 3 ? "…" : ""}）` : ""}`
      + ` —— 需要「${perm}」`);
    return `<div class="notice warn-notice">其中 ${outOfReach.length} 项你处置不了，它们仍然挡着关闭门：`
      + `${esc(lines.join("；"))}。权限按【任务组】授予（在别的组上有同名权限不算），`
      + "只能在「项目管理」→「任务组权限」按角色授予（例如“评审人”），请找项目负责人或组织管理员授予后再来。</div>";
  };

  // 同段其余六处都按 inScope 过滤，唯独关闭门禁没有 —— 于是在项目 A 的监控页上会列出项目 B 的
  // 门禁，并且直接给出"关闭任务组"按钮。关闭是最不可逆的一步（写 humanFinalization 且只能关一次），
  // 在错误的项目抬头下点它，人以为关的是 A 的任务组。
  const barriersInScope = (state.closeBarriers || []).filter(inScope);
  const barriers = barriersInScope.slice(0, 8).map((barrier) => row([
    esc(taskGroupNameOf(barrier.taskGroupId)),
    barrier.satisfied ? customBadge("可关闭", "green") : customBadge("存在阻塞", "red"),
    {v: String((barrier.blockingObjects || []).length), c: "num"},
    {v: fmtTime(barrier.computedAt), c: "nowrap"},
    (barrier.satisfied && hasGroupPerm(barrier.taskGroupId, "task_group:control")
      && taskGroupById(barrier.taskGroupId)?.status !== "closed")
      ? `<button class="primary-button" data-action="close-task-group" data-task="${esc(barrier.taskGroupId)}">关闭任务组</button>`
      : (taskGroupById(barrier.taskGroupId)?.status === "closed"
        // 关闭任务组是真人专属的决定，而【谁定的、什么时候定的】此前落在 confirmedBy/confirmedAt 上
        // 却没有任何读取点：屏幕上只有一个"已关闭"，追不到人。
        ? `${customBadge("已关闭", "gray")}${barrier.confirmedBy
          ? `<div class="record-meta">由 ${esc(accountName(barrier.confirmedBy))} 定稿于 ${fmtTime(barrier.confirmedAt)}</div>`
          : ""}`
        : "-")
  ])).join("");

  // 刚装完打开这一页，十一张表全是"暂无数据" —— 每一张都在说"这里什么都没有"，
  // 却没有一张说【为什么】和【下一步】。人分不清"还没开始跑"和"跑了但记录没取回来"。
  // 只在这一页范围内一件事都没有时说一句；有任何一条记录就不说（常亮的提示等于没有提示）。
  // 用这一页【已经算好的那几个作用域数组】判空，不再直接点名集合：
  // 账本限流那道门按"谁提到了这个集合名"找渲染点，直接点名会被它当成一处没设上限的渲染。
  const nothingRanYet = !eventsShown.length && !sessionsAll.length && !dispatchesAll.length
    && !lanesAll.length && !admissionsInScope.length && !nodes.length;
  // 项目空间已经和系统/组织空间拆开，跨空间指路不能再写成"去某某页"：
  // 人在当前左侧菜单里看不到那一项，会以为功能丢了。先点空间，再说面板名。
  const JOIN_TOKEN_ENTRY_BY_PERSPECTIVE = {
    system: "先打开「项目管理」→「注册运行节点」",
    org: "先打开「项目管理」→「注册运行节点」；也可以在「组织管理」→「共享运行节点」统一管理节点"
  };
  const joinTokenWhere = JOIN_TOKEN_ENTRY_BY_PERSPECTIVE[perspectiveOf(currentAccount)];
  const nothingRanYetNotice = nothingRanYet
    ? `<div class="notice">这个项目还没有任何执行记录 —— 下面几张表是空的，这在刚装完时是正常的，`
      + `不是没取回来。要让它动起来：${joinTokenWhere
        ? `${joinTokenWhere}，点「签发一次性加入令牌」并在 agent 主机运行安装命令注册一台节点，`
        : "先让管理员签发加入令牌，并在 agent 主机运行安装命令注册一台节点（签发加入令牌这件事你这个账号做不了），"}`
      + `再到“任务”确认工作项已就绪。节点接上之后，“工作会话”“Agent 派发”和“实时事件”会持续显示运行过程。</div>`
    : "";
  const selectedMonitorGroup = managementGroupId ? groups.find((group) => group.id === managementGroupId) || null : null;
  const selectedStats = selectedMonitorGroup ? taskGroupOperationalStats(selectedMonitorGroup) : {
    groups: groups.length,
    reviews: groups.reduce((sum, group) => sum + taskGroupOperationalStats(group).reviews, 0)
  };
  const monitorScopeHeader = global.AIMAC_MONITOR_WORKSPACE.scopeHeader({
    project: currentProject(),
    group: selectedMonitorGroup,
    stats: selectedStats,
    activeSessions: sessionsAll.filter((session) => !SESSION_SETTLED_STATUSES.includes(session.status)).length,
    activeDispatches: dispatchesAll.filter((dispatch) => !terminalDispatchStatuses.has(dispatch.status)).length,
    latestEvent: eventsShown[0] || null,
    blockingObjects: barriersInScope.reduce((sum, barrier) => sum + (barrier.satisfied ? 0 : Number((barrier.blockingObjects || []).length)), 0),
    helpers: {badge, fmtTime}
  });

  return [
    monitorScopeHeader,
    nothingRanYetNotice,
    orchestratorStalledNotice(),
    fleetOfflineNotice(),
    renderMonitorSummary({eventsShown, sessionsAll, dispatchesAll, lanesAll, nodes: monitorNodes, barriersInScope}),
    renderMonitorActionBoard({
      dispatchesAll,
      sessionsAll,
      nodes: monitorNodes,
      barriersInScope,
      stuckTopologies,
      downgradableTopologies,
      failingTests,
      waivableGates,
      openReviewPlans,
      openReviewBundles,
      openRuleSources,
      openUpgradeCandidates,
      blockingDefinitions
    }),
    renderMonitorRealtimeGuide({
      eventsShown,
      sessionsAll,
      dispatchesAll,
      commandsInScope,
      nodes: monitorNodes,
      barriersInScope
    }),
    renderTaskGroupMonitorMatrix(groups, {dispatchesAll, sessionsAll, barriersInScope}),
    canOrchestrate ? panel("自治控制", `
      <div class="button-row">
        <button class="primary-button" data-action="orchestrator-run">运行自治循环</button>
        <button class="secondary-button" data-action="decide-model">模型决策</button>
      </div>
    `) : "",
    panel("实时事件流", `
      <div class="stack">
        <div class="button-row" role="group" aria-label="记录模式"><button class="${execHistoryMode ? "secondary-button" : "primary-button"}" data-exec-mode="live" aria-pressed="${!execHistoryMode}">实时记录</button>
          <button class="${execHistoryMode ? "primary-button" : "secondary-button"}" data-exec-mode="history" aria-pressed="${execHistoryMode}">历史记录</button></div>
        <div class="record-meta"><span>监听范围：</span><select data-select="exec-scope" aria-label="执行监听范围">${scopeOptions.map((option) => `<option value="${esc(option.value)}" ${option.value === scopeValue ? "selected" : ""}>${esc(option.label)}</option>`).join("")}</select></div>
        ${table([{label: "序号", c: "num"}, "事件", {label: "进度", c: "num"}, "状态", {label: "摘要", c: "text-clip"}, {label: "时间", c: "nowrap"}], eventRows, {moreText: moreText(eventsShown.length, 120, execEventsDropped)})}
        ${execHistoryMode ? `<div class="button-row"><button class="secondary-button" data-event-page="previous"${execHistoryStack.length ? "" : " disabled"}>上一页</button><span class="small muted">第 ${execHistoryStack.length + 1} 页</span><button class="secondary-button" data-event-page="next"${execHasMore ? "" : " disabled"}>下一页</button></div>` : ""}
      </div>
    `, {wide: true, headerSide: filterInput("按事件、摘要过滤…", "events")}),
    panel("可复用执行载体（Worker Lane）", table(["角色", "功能", "状态", {label: "复用代数", c: "num"}, "当前会话", {label: "更新时间", c: "nowrap"}], laneRows, {moreText: moreText(lanesAll.length, 20, "workerLanes")}), {wide: true, headerSide: filterInput("按角色、会话过滤…", "worker-lanes")}),
    panel("工作会话", table(["会话", "角色", "工作项", "放置方式", {label: "执行载体", c: "nowrap"}, "状态", "原因", "详情"], sessions, {moreText: moreText(sessionsAll.length, 20, "workSessions")}), {wide: true, headerSide: filterInput("按会话、工作项过滤…", "sessions")}),
    panel("智能体派发", stuckExitNotice(dispatchesAll, sessionsAll) + table(["派发", "工作项", "状态", {label: "进度", c: "num"}, {label: "最近动静", c: "nowrap"}, "原因", "详情"], dispatches, {moreText: moreText(dispatchesAll.length, 20, "agentDispatches")}), {wide: true, headerSide: filterInput("按派发、工作项过滤…", "dispatches")}),
    // 节点为什么拒/为什么失败，此前写进 command.ackResult 就再没人读过（全仓只有网关那一处写、
    // 零处读）—— 屏幕上只有一个「已拒绝」，人无处可查。它本来就随视图下发了，缺的只是这一列。
    panel("控制通道", table([{label: "序号", c: "num"}, "节点", "命令", "作用对象", "状态", "原因", {label: "更新时间", c: "nowrap"}], commands, {moreText: moreText(commandsInScope.length, 16, "agentControlCommands")}), {wide: true}),
    (() => {
      // 死信队列：命令重试超限时产生，非终态会一直挡住关闭门（no_active_dlq）。此前它连下发都没有、
      // 更没有处置入口 —— 一条死信就能让任务组永远关不掉。这里列出待处置的，给出丢弃/重放的出口。
      const DLQ_TERMINAL = new Set(["replayed", "discarded", "superseded"]);
      const dlqActive = (state.dlqEntries || []).filter((entry) => !DLQ_TERMINAL.has(entry.status) && (!managementGroupId || inScope(entry)));
      const dlqRows = dlqActive.map((entry) => row([
        `<span class="mono">${esc(entry.entryId)}</span>`,
        `<span class="mono">${esc(entry.commandId || entry.sourceObjectRef || "-")}</span>`,
        esc(taskGroupNameOf(entry.taskGroupId)),
        esc(entry.reason || "-"),
        badge(entry.status),
        {v: fmtTime(entry.updatedAt || entry.createdAt), c: "nowrap"},
        hasGroupPerm(entry.taskGroupId, "task_group:control") ? `
          <form class="form-grid" data-form="dlq-resolve" data-entry="${esc(entry.entryId)}">
            ${decisionSelect("resolution", [["discard", "丢弃（放弃这条失败命令）"], ["replay", "重放（判定可以放行）"]], "请选择处置…", {required: false})}
            <input name="justification" placeholder="处置理由（必填）">
            <button class="secondary-button" type="submit">处置</button>
          </form>` : noRightOnThisGroup(entry.taskGroupId, "任务组控制（处置死信）")
      ]));
      return panel("死信队列", dlqActive.length
        ? table(["条目", "命令", "作用对象", "原因", "状态", {label: "更新时间", c: "nowrap"}, "处置"], dlqRows)
        : `<div class="small muted">没有待处置的死信条目。命令重试超限时才会在这里出现，非终态会挡住任务组关闭。</div>`, {wide: true});
    })(),
    panel("agent 节点", table(["节点", "状态", "准入", {label: "最近心跳", c: "nowrap"}, "操作"], nodes), {wide: true, headerSide: filterInput("按节点过滤…", "runtime-nodes")}),
    panel("模型选择记录", table(["角色", "Agent 档案", "工作项", "实际模型", "状态", {label: "决策说明", c: "text-clip"}], decisions, {moreText: moreText(decisionsInScope.length, 10, "modelSelectionDecisions")})),
    panel("会话放置记录", table(["工作项", "放置方式", {label: "执行载体", c: "nowrap"}, "状态"], placements, {moreText: moreText(placementsInScope.length, 10, "sessionPlacementDecisions")})),
    panel("准入决策", table(["工作项", "判定", "分类", {label: "原因", c: "text-clip"}], admissions, {moreText: moreText(admissionsInScope.length, 12, "admissionDecisions")}), {wide: true}),
    panel("检查点（Git 证据）", table(["任务组", "工作项", "提交", "推送", {label: "产出清单", c: "text-clip"}, {label: "时间", c: "nowrap"}], checkpointRows, {moreText: moreText(filterSource((state.checkpoints || []).filter((cp) => groups.some((taskGroup) => taskGroup.id === cp.taskGroupId)), "checkpoints").length, 20, "checkpoints")}), {wide: true, headerSide: filterInput("按工作项、提交过滤…", "checkpoints")}),
    (state.qualityGates || []).some((qg) => groups.some((taskGroup) => taskGroup.id === qg.taskGroupId)) ? panel("质量门禁 / 测试证据", `
      ${failingTests.length ? `<div class="notice warn-notice">有 ${failingTests.length}${countSuffix("testResults")} 项失败测试，阻塞关闭门禁（gateType 对应门禁为 failed，需修复并重提通过测试、取消对应工作项，或由你判定该门不适用后豁免）。</div>` : ""}
      ${table(["任务组", "门禁类型", "工作项", "状态", {label: "更新时间", c: "nowrap"}], qualityGateRows, {moreText: moreText(filterSource((state.qualityGates || []).filter((qg) => groups.some((taskGroup) => taskGroup.id === qg.taskGroupId)), "quality-gates").length, 20, "qualityGates")})}
      ${canReviewGates && waivableGates.length ? `
        <div class="record" style="margin-top:8px;">
          <div class="record-title">豁免未通过的质量门</div>
          <div class="record-meta">豁免是由你负责的放行决定：门仍未通过，只是你判定它在本次范围内不适用。执行方无法自行豁免，理由会随门一起留档并显示在验收卡片上。</div>
          ${waivableGates.filter((qg) => hasGroupPerm(qg.taskGroupId, "task_group:review")).map((qg) => `
            <form class="form-grid" data-form="quality-gate-waive" data-request="${esc(qg.gateId)}" style="margin-top:8px;">
              <div class="record-meta"><span class="mono">${esc(qg.gateId)}</span> · ${esc(t(qg.gateType) || qg.gateType || "-")} · ${esc(qg.workItemId || "-")} · ${badge(qg.status)}</div>
              <div class="form-row"><label>豁免理由（必填）</label><input name="justification" placeholder="例如：该门针对的能力不在本任务组范围内"></div>
              <button class="primary-button" type="submit">豁免此门</button>
            </form>`).join("")}
        </div>` : ""}
    `, {wide: true, headerSide: filterInput("按门禁类型、工作项过滤…", "quality-gates")}) : "",
    // 关闭门禁上每一个阻塞项都必须能在这里被人处理掉。后端有杠杆而界面上没有入口，
    // 等于这个杠杆不存在 —— 人只会看到一个红 chip，然后无从下手。
    panel("阻塞项人工处置", (openReviewPlans.length || openRuleSources.length || blockingDefinitions.length || openReviewBundles.length || openUpgradeCandidates.length || stuckTopologies.length
      || downgradableTopologies.length) ? `
      <div class="notice">下面这些阻塞只能由人来收尾：AI 要么不该有权决定（采纳规则、激活规范），要么已经无法推进（评审角色不再参与）。</div>
      ${outOfReachBlockerNotice()}
      ${canReviewGates && openReviewPlans.length ? `
        <div class="record" style="margin-top:8px;">
          <div class="record-title">评审计划（要求的评审角色到齐即自动闭合；到不齐时由你收尾）</div>
          ${openReviewPlans.filter((plan) => hasGroupPerm(plan.taskGroupId, "task_group:review")).map((plan) => `
            <form class="form-grid" data-form="review-plan-resolve" data-request="${esc(plan.reviewPlanId)}" style="margin-top:8px;">
              <div class="record-meta"><span class="mono">${esc(plan.reviewPlanId)}</span> · ${esc(taskGroupNameOf(plan.taskGroupId))} · ${badge(plan.status)}
                · 需要 ${esc((plan.requiredReviewerRoles || []).map((role) => t(role) || role).join("、") || "-")}
                · 已到 ${esc((plan.coveredReviewerRoles || []).map((role) => t(role) || role).join("、") || "无")}</div>
              <div class="form-row"><label>收尾方式</label>${decisionSelect("status", [["closed", "关闭（视为已完成评审）"], ["superseded", "被取代"], ["rejected", "驳回"]], "请选择收尾方式…")}</div>
              <div class="form-row"><label>理由（必填）</label><input name="justification" placeholder="例如：外部评审方不再参与，改由内部 QA 覆盖"></div>
              <button class="primary-button" type="submit">收尾评审计划</button>
            </form>`).join("")}
        </div>` : ""}
      ${canControlRules && openRuleSources.length ? `
        <div class="record" style="margin-top:8px;">
          <div class="record-title">规则来源分流（判为"采纳为本项目规则"只能由你做，AI 只能判不采纳）</div>
          ${openRuleSources.filter((item) => hasGroupPerm(item.taskGroupId, "task_group:control")).map((item) => `
            <form class="form-grid" data-form="rule-source-settle" data-request="${esc(item.resolutionId)}" style="margin-top:8px;">
              <div class="record-meta"><span class="mono">${esc(item.sourceRef || item.resolutionId)}</span> · ${esc(taskGroupNameOf(item.taskGroupId))} · ${badge(item.status)}</div>
              <div class="form-row"><label>判定</label>${decisionSelect("status", [["active", "采纳为本项目规则"], ["reference_only", "仅作参考"], ["quarantined", "隔离"], ["rejected", "不采纳"]], "请选择判定…")}</div>
              <div class="form-row"><label>理由（可选）</label><input name="justification" placeholder="判定依据"></div>
              <button class="primary-button" type="submit">提交判定</button>
            </form>`).join("")}
        </div>` : ""}
      ${canReviewGates && openReviewBundles.length ? `
        <div class="record" style="margin-top:8px;">
          <div class="record-title">评审包（外部评审结论回流后自动终态化；回不来时由你收尾）</div>
          ${openReviewBundles.filter((bundle) => hasGroupPerm(bundle.taskGroupId, "task_group:review")).map((bundle) => `
            <form class="form-grid" data-form="review-bundle-resolve" data-request="${esc(bundle.reviewBundleId)}" style="margin-top:8px;">
              <div class="record-meta"><span class="mono">${esc(bundle.reviewBundleId)}</span> · ${esc(taskGroupNameOf(bundle.taskGroupId))} · ${badge(bundle.status)}${bundle.workItemId ? ` · ${esc(bundle.workItemId)}` : ""}</div>
              <div class="form-row"><label>收尾方式</label>${decisionSelect("status", [["consumed", "已采纳该评审结论"], ["rejected", "驳回该评审包"]], "请选择收尾方式…")}</div>
              <div class="form-row"><label>理由（必填）</label><input name="justification" placeholder="例如：外部评审方未再回流，改由内部互审覆盖"></div>
              <button class="primary-button" type="submit">收尾评审包</button>
            </form>`).join("")}
        </div>` : ""}
      ${canControlRules && openUpgradeCandidates.length ? `
        <div class="record" style="margin-top:8px;">
          <div class="record-title">系统升级候选项（由运行时故障自动生成，需你判定后才不再阻塞）</div>
          ${openUpgradeCandidates.map((item) => `
            <form class="form-grid" data-form="upgrade-candidate-resolve" data-request="${esc(item.candidateId)}" style="margin-top:8px;">
              <div class="record-meta"><span class="mono">${esc(item.candidateId)}</span> · ${esc(taskGroupNameOf(item.taskGroupId))} · ${esc(t(item.issueClass) || item.issueClass || "-")} · ${badge(item.status)}</div>
              <div class="form-row"><label>判定</label>${decisionSelect("status", [["exported_for_external_maintenance", "已导出交外部维护"], ["dismissed", "不予处理"], ["closed", "已解决"]], "请选择判定…")}</div>
              <div class="form-row"><label>理由（必填）</label><input name="justification" placeholder="判定依据"></div>
              <button class="primary-button" type="submit">提交判定</button>
            </form>`).join("")}
        </div>` : ""}
      ${canUpdateProject && blockingDefinitions.length ? `
        <div class="record" style="margin-top:8px;">
          <div class="record-title">共享定义契约（AI 只能提议，激活为全局规范由你决定）</div>
          ${blockingDefinitions.map((definition) => `
            <form class="form-grid" data-form="shared-definition-resolve" data-request="${esc(definition.contractId)}" style="margin-top:8px;">
              <div class="record-meta"><span class="mono">${esc(definition.contractId)}</span> · ${esc(t(definition.definitionType) || definition.definitionType || "-")} · ${badge(definition.status)}${definition.proposedBy ? ` · 由 ${esc(definition.proposedBy)} 提议` : ""}</div>
              <div class="form-row"><label>处置</label>${decisionSelect("status", [["active", "激活为全局规范"], ["rejected", "驳回"], ["superseded", "被取代"], ["retired", "退役"]], "请选择处置…")}</div>
              <div class="form-row"><label>理由（必填）</label><input name="justification" placeholder="例如：已与相关方对齐，采纳为全局状态语义"></div>
              <button class="primary-button" type="submit">提交处置</button>
            </form>`).join("")}
        </div>` : ""}
      ${canOrchestrate && downgradableTopologies.length ? `
        <div class="record" style="margin-top:8px;">
          <div class="record-title">资格检查没过的执行方案（这些阻塞项清不掉就启动不了；后端在这个阶段只接受【降级为串行】，不接受终止）</div>
          ${downgradableTopologies.map((topology) => `
            <form class="form-grid" data-form="topology-downgrade" data-request="${esc(topology.topologyId)}" style="margin-top:8px;">
              <div class="record-meta"><span class="mono">${esc(topology.topologyId)}</span> · ${esc(taskGroupNameOf(topology.taskGroupId))} · ${badge(topology.status)}
                · 工作项 <span class="mono">${esc(topology.workItemId || "-")}</span>
                ${topology.humanFinalization?.outcome === "confirmed" ? " · " + customBadge("已由人定稿", "blue") : ""}</div>
              <div class="small muted">卡在这几项：${(topology.blockers || [])
                .slice(0, 6).map((blocker) => esc(topologyBlockerText(blocker))).join("；")}</div>
              <div class="form-row"><label>降级理由（必填，会写进定稿记录）</label><input name="downgradeReason" placeholder="例如：这台机器上没有可用的隔离工作树，改为串行执行"></div>
              <button class="primary-button" type="submit">降级为串行执行</button>
            </form>`).join("")}
        </div>` : ""}
      ${canOrchestrate && stuckTopologies.length ? `
        <div class="record" style="margin-top:8px;">
          <div class="record-title">卡住的执行方案（分支报失败后 merge 走不通，只有人能终止；不终止会一直挡着关闭门）</div>
          ${stuckTopologies.map((topology) => `
            <form class="form-grid" data-form="topology-cancel" data-request="${esc(topology.topologyId)}" style="margin-top:8px;">
              <div class="record-meta"><span class="mono">${esc(topology.topologyId)}</span> · ${esc(taskGroupNameOf(topology.taskGroupId))} · ${badge(topology.status)}
                · 工作项 <span class="mono">${esc(topology.workItemId || "-")}</span>
                ${topology.humanFinalization?.outcome === "confirmed" ? " · " + customBadge("已由人定稿", "blue") : ""}</div>
              ${(topology.blockers || []).length ? `<div class="small muted">卡在这几项：${(topology.blockers || [])
                .slice(0, 6).map((blocker) => esc(topologyBlockerText(blocker))).join("；")}</div>` : ""}
              <div class="form-row"><label>终止理由（必填，会写进定稿记录）</label><input name="cancelRef" placeholder="例如：分支 b_api 报失败且无法修复，改由串行方案重做"></div>
              <button class="danger-button" type="submit">终止该执行方案</button>
            </form>`).join("")}
        </div>` : ""}
    ` : `<div class="notice">当前范围没有需要人工收尾的评审计划、规则来源、评审包、系统升级候选、共享定义或卡住的执行方案。</div>`, {wide: true}),
    // 上面那一屏是"还要谁来收尾"，这一屏是"已经谁收的尾、为什么"。人写下的定稿理由此前落库之后
    // 没有任何读取点，而收尾之后对象又从待处置清单里消失 —— 于是这条链上唯一的人类判断不留痕迹。
    finalizations.length ? panel("最近的人工定稿", `
      <div class="notice">这些收尾只能由真人做。这里保留他们当时给出的理由 —— 后来的人要靠它判断能不能照做。</div>
      ${table(["对象", "任务组", "处置后状态", "定稿人", {label: "时间", c: "nowrap"}, "理由"],
        finalizations.map((item) => row([
          `${esc(item.kind)} <span class="mono">${esc(item.id || "-")}</span>`,
          esc(taskGroupNameOf(item.taskGroupId)),
          badge(item.status),
          esc(item.by ? accountName(item.by) : "-"),
          fmtTime(item.at),
          // 有的是人写的原话，有的是码（发现项的处置类别）—— 统一过 explainCoded：
          // 是码就译成人话，是原话就原样出来。
          {v: esc(item.why ? explainCoded(item.why) : "（当时没有填理由）"), c: "text-clip"}
        ])).join(""))}
    `, {wide: true}) : "",
    panel("关闭门禁", `
      ${table(["任务组", "状态", {label: "阻塞对象数", c: "num"}, {label: "计算时间", c: "nowrap"}, "操作"], barriers, {moreText: moreText(barriersInScope.length, 8, "closeBarriers")})}
      ${(state.closeBarriers || []).filter((barrier) => !barrier.satisfied && (barrier.blockingObjects || []).length).slice(0, 8).map((barrier) => `
        <div class="record" style="margin-top:8px;">
          <div class="record-title"><strong>${esc(taskGroupNameOf(barrier.taskGroupId))}</strong> 阻塞明细</div>
          <div class="chip-row">${(barrier.blockingObjects || []).map((obj) => customBadge(`${t(obj.objectType) || obj.objectType}${obj.gate ? `·${t(obj.gate) || obj.gate}` : ""}：${t(obj.status) || obj.status}`, "red")).join(" ")}</div>
          ${gatingArtifactRows(barrier)}
        </div>`).join("")}
    `, {wide: true})
  ].join("");
}

/* ---------------- 成员：项目设置 ---------------- */

// readOnly：无“项目授权管理”权限或项目已归档时，这几行只能看不能改。此前输入始终可编辑、删除按钮
// 始终启用（而同页的 rule 行、添加/保存按钮都按 readOnly 置灰了）—— read-only 的成员因此能就地改字段、
// 删行（本地暂存 formTouched），却存不下（保存按钮已禁用、后端也会拒 project_config_update），
// 是「按了看不到效果」的死动作。与 ruleRow 同规：输入加 readonly、删除按钮 readOnly 时干脆不渲染。


  global.AIMAC_MONITOR_DASHBOARD_WORKSPACE = {render};
})(window);
