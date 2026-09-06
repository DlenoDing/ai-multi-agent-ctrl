(function initTaskGroupInsights(global) {
  "use strict";

  function eventTimeOf(item) {
    return item?.createdAt || item?.updatedAt || item?.decidedAt || item?.computedAt || "";
  }

  function workItemTitleIn(taskGroup, progressData, workItemId, fallback = "") {
    const workItem = (taskGroup.workItems || []).find((item) => item.id === workItemId)
      || ((progressData?.workItems || []).find((item) => item.id === workItemId));
    return workItem?.title || fallback || workItemId || "-";
  }

  function timelineItem({kind, title, status, at, tone = "blue", detail = "", meta = []}) {
    return {kind, title, status, at, tone, detail, meta: meta.filter(Boolean)};
  }

  function executionTimeline(taskGroup, progressData = {}, helpers) {
    const {state, terminalDispatchStatuses, t, explainCoded, modelDecisionSummaryZh,
      customBadge, badge, esc, fmtTime, agentNodeLabel} = helpers;
    const groupId = taskGroup.id;
    const workItems = progressData.workItems || taskGroup.workItems || [];
    const inGroup = (item) => item?.taskGroupId === groupId;
    const titleOf = (workItemId, fallback) => workItemTitleIn(taskGroup, progressData, workItemId, fallback);
    const entries = [];

    for (const workItem of workItems) {
      entries.push(timelineItem({
        kind: "工作项",
        title: workItem.title || workItem.id,
        status: workItem.status,
        at: eventTimeOf(workItem) || taskGroup.updatedAt,
        tone: workItem.blockedReason || ["blocked", "needs_decision"].includes(workItem.status) ? "red" : "blue",
        detail: workItem.blockedReason
          ? explainCoded(workItem.blockedReason)
          : (workItem.requirements || []).slice(0, 2).join("；"),
        meta: [`角色：${t(workItem.ownerRole) || workItem.ownerRole || "未指定"}`,
          workItem.pinnedModelId ? `指定模型：${workItem.pinnedModelId}` : "模型：自动选择"]
      }));
    }
    for (const decision of (state.modelSelectionDecisions || []).filter(inGroup).slice(0, 40)) {
      entries.push(timelineItem({
        kind: "模型",
        title: titleOf(decision.workItemId, decision.workItemId),
        status: decision.status,
        at: eventTimeOf(decision),
        tone: decision.status === "blocked" ? "red" : "green",
        detail: modelDecisionSummaryZh(decision),
        meta: [`角色：${t(decision.roleId) || decision.roleId || "-"}`,
          `模型：${decision.selectedModel?.modelId || "-"}`,
          decision.modelDecision ? `依据：${decision.modelDecision}` : ""]
      }));
    }
    for (const placement of (state.sessionPlacementDecisions || []).filter(inGroup).slice(0, 40)) {
      entries.push(timelineItem({
        kind: "会话",
        title: titleOf(placement.workItemId, placement.workItemId),
        status: placement.status,
        at: eventTimeOf(placement),
        tone: placement.status === "blocked" ? "red" : "blue",
        detail: `放置方式：${t(placement.placement) || placement.placement || "-"}；执行载体：${placement.workerCarrierDecision?.carrier || "-"}`,
        meta: [placement.sessionId ? `会话：${placement.sessionId}` : "", placement.laneId ? `Lane：${placement.laneId}` : ""]
      }));
    }
    for (const dispatch of (state.agentDispatches || []).filter(inGroup)) {
      entries.push(timelineItem({
        kind: "派发",
        title: titleOf(dispatch.workItemId, dispatch.workItemId),
        status: dispatch.status,
        at: dispatch.lastExecutionEventAt || eventTimeOf(dispatch),
        tone: dispatch.status === "blocked" || dispatch.failureReason
          ? "red"
          : terminalDispatchStatuses.has(dispatch.status) ? "gray" : "blue",
        detail: explainCoded(dispatch.blockedReason || dispatch.failureReason || dispatch.dispatchReason || ""),
        meta: [`Agent：${agentNodeLabel(dispatch.assignedNodeId)}`,
          `派发：${dispatch.dispatchId}`,
          dispatch.progressPercent !== undefined ? `进度：${dispatch.progressPercent}%` : ""]
      }));
    }
    for (const event of (state.agentExecutionEvents || []).filter(inGroup).slice(0, 60)) {
      entries.push(timelineItem({
        kind: "事件",
        title: titleOf(event.workItemId, event.eventType),
        status: event.status,
        at: eventTimeOf(event),
        tone: event.status === "failed" || event.status === "error" ? "red" : "blue",
        detail: event.summary || "",
        meta: [`事件：${t(event.eventType) || event.eventType || "-"}`,
          `Agent：${agentNodeLabel(event.nodeId)}`,
          event.progressPercent !== undefined ? `进度：${event.progressPercent}%` : ""]
      }));
    }
    for (const checkpoint of (state.checkpoints || []).filter(inGroup)) {
      const lastCommit = checkpoint.commitRefs?.at(-1);
      entries.push(timelineItem({
        kind: "证据",
        title: titleOf(checkpoint.workId, checkpoint.workId),
        status: checkpoint.status || "checkpoint",
        at: eventTimeOf(checkpoint),
        tone: "green",
        detail: checkpoint.artifactManifestRefs?.[0] || "",
        meta: [lastCommit ? `提交：${String(lastCommit.commit || lastCommit).slice(0, 12)}` : "",
          checkpoint.pushRefs?.length ? `已推送：${checkpoint.pushRefs.length}` : ""]
      }));
    }

    entries.sort((left, right) => String(right.at || "").localeCompare(String(left.at || "")));
    const rows = entries.slice(0, 40).map((entry) => `
      <div class="timeline-row">
        <div class="timeline-point tone-${esc(entry.tone)}"></div>
        <div class="timeline-body">
          <div class="record-title">
            ${customBadge(entry.kind, entry.tone)}
            <strong>${esc(entry.title || "-")}</strong>
            ${entry.status ? badge(entry.status) : ""}
          </div>
          <div class="record-meta">
            <span>${fmtTime(entry.at)}</span>
            ${entry.meta.map((item) => `<span>${esc(item)}</span>`).join("")}
          </div>
          ${entry.detail ? `<div class="small muted">${esc(entry.detail).slice(0, 600)}</div>` : ""}
        </div>
      </div>
    `).join("");
    return `
      <div class="timeline-list">
        ${rows || `<div class="notice">当前任务组还没有可合并展示的执行记录。工作项进入派发、Agent 回送事件或提交 checkpoint 后，会按时间倒序出现在这里。</div>`}
      </div>
      ${entries.length > 40 ? `<div class="small muted">共 ${entries.length} 条，这里显示最新 40 条；更完整的事件仍在执行监控页按派发或任务组查看。</div>` : ""}
    `;
  }

  function monitorMatrix(groups, {dispatchesAll = [], sessionsAll = [], barriersInScope = []} = {}, helpers) {
    const {state, terminalDispatchStatuses, sessionSettledStatuses, sinceText, esc, panel} = helpers;
    const groupIds = new Set(groups.map((taskGroup) => taskGroup.id));
    const latestEventByGroup = new Map();
    for (const event of (state.agentExecutionEvents || []).filter((item) => groupIds.has(item.taskGroupId)).slice(0, 60)) {
      if (event.taskGroupId && !latestEventByGroup.has(event.taskGroupId)) latestEventByGroup.set(event.taskGroupId, event);
    }
    const cards = groups.map((taskGroup) => {
      const dispatches = dispatchesAll.filter((dispatch) => dispatch.taskGroupId === taskGroup.id);
      const sessions = sessionsAll.filter((session) => session.taskGroupId === taskGroup.id);
      const barrier = barriersInScope.find((item) => item.taskGroupId === taskGroup.id);
      const activeDispatches = dispatches.filter((dispatch) => !terminalDispatchStatuses.has(dispatch.status)).length;
      const blockedDispatches = dispatches.filter((dispatch) => dispatch.status === "blocked").length;
      const activeSessions = sessions.filter((session) => !sessionSettledStatuses.includes(session.status)).length;
      const barrierBlocks = barrier && !barrier.satisfied ? (barrier.blockingObjects || []).length : 0;
      const latest = latestEventByGroup.get(taskGroup.id);
      const tone = blockedDispatches || barrierBlocks
        ? "red"
        : activeDispatches || activeSessions ? "blue" : taskGroup.status === "closed" ? "gray" : "green";
      const details = [
        `进度 ${Number(taskGroup.progress || 0)}%`,
        `派发 ${activeDispatches}/${dispatches.length}`,
        `会话 ${activeSessions}/${sessions.length}`,
        barrier ? `关闭门 ${barrier.satisfied ? "可关闭" : `${barrierBlocks} 项阻塞`}` : "关闭门未计算",
        latest ? `最近事件 ${sinceText(latest.createdAt)}` : "暂无事件"
      ];
      return `
        <button class="module-card tone-${tone}" data-action="monitor-scope" data-scope="taskGroup:${esc(taskGroup.id)}">
          <span class="module-title">${esc(taskGroup.name || taskGroup.id)}</span>
          <strong>${esc(activeDispatches || activeSessions || barrierBlocks || Number(taskGroup.progress || 0))}</strong>
          <span class="module-detail">${esc(details.join(" · "))}</span>
          <span class="module-action">切到该任务组</span>
        </button>
      `;
    }).join("");
    return panel("任务组监控矩阵", `
      <div class="module-grid action-grid">${cards || `<div class="notice">当前项目还没有任务组。</div>`}</div>
      <div class="small muted">每张卡对应一个任务组，汇总进度、活跃派发、工作会话、关闭门和最近事件；点击后实时事件流切换到该任务组范围。</div>
    `, {wide: true});
  }

  function detailPath(summary, helpers) {
    const {jumpModuleCard, sectionBlock} = helpers;
    const roomMetric = summary.roomCount === null ? "不可见" : String(summary.roomCount || 0);
    const cards = [
      jumpModuleCard({title: "1 事项清单", metric: String(summary.analysisCount || 0),
        detail: "目标拆解、执行树和当前进度", panelTitle: "事项清单",
        tone: summary.analysisCount ? "blue" : "orange", action: "查看"}),
      jumpModuleCard({title: "2 角色列表", metric: String(summary.roleCount || 0),
        detail: "本任务组实际参与的 Skill 角色", panelTitle: "角色列表",
        tone: summary.roleCount ? "blue" : "orange", action: "查看"}),
      jumpModuleCard({title: "3 配置继承", metric: summary.configLabel || "未加载",
        detail: "配置来源、默认角色、仓库与基线引用", panelTitle: "配置继承",
        tone: summary.configLabel === "自定义" ? "orange" : "green", action: "查看"}),
      jumpModuleCard({title: "4 Skill 定制", metric: String(summary.skillCount || 0),
        detail: "项目继承与任务组特殊角色能力", panelTitle: "角色 Skill 定制",
        tone: summary.skillCount ? "blue" : "gray", action: "查看"}),
      jumpModuleCard({title: "5 系统规则", metric: String(summary.systemRuleCount || 0),
        detail: "安全、流程、证据和 AI-native 纪律", panelTitle: "系统规则", tone: "blue", action: "查看"}),
      jumpModuleCard({title: "6 业务规则", metric: String(summary.businessRuleCount || 0),
        detail: "本项目与任务组业务约束", panelTitle: "业务规则", tone: "blue", action: "查看"}),
      jumpModuleCard({title: "7 执行控制", metric: summary.canControl ? "可控" : "只读",
        detail: "暂停、恢复、评审和统一语言策略", panelTitle: "执行控制",
        tone: summary.canControl ? "blue" : "gray", action: "查看"}),
      jumpModuleCard({title: "8 工作项", metric: String(summary.workItemCount || 0),
        detail: "执行单元、模型、派发和实时事件入口", panelTitle: "工作项",
        tone: summary.workItemCount ? "blue" : "orange", action: "查看"}),
      jumpModuleCard({title: "9 准入与阻断", metric: summary.hasAdmission ? "已计算" : "待编排",
        detail: "可执行、等待、真实阻断和整体阻断规则", panelTitle: "准入与阻断分类",
        tone: summary.hasAdmission ? "green" : "orange", action: "查看"}),
      jumpModuleCard({title: "10 阻塞", metric: String(summary.blockerCount || 0),
        detail: "关闭门禁、提示阻塞和下一步处置", panelTitle: "阻塞",
        tone: summary.blockerCount ? "red" : "green", action: "查看"}),
      jumpModuleCard({title: "11 任务时间线", metric: "倒序",
        detail: "任务、模型、会话、派发、事件和 Git 证据", panelTitle: "任务执行时间线", tone: "blue", action: "查看"}),
      jumpModuleCard({title: "12 协作记录", metric: roomMetric,
        detail: "Agent 房间消息和过程追溯", panelTitle: "协作记录（agent 之间的房间消息）",
        tone: summary.roomCount === null ? "orange" : "blue", action: "查看"})
    ].join("");
    return sectionBlock("任务组详情阅读路径", `
      <div class="module-grid action-grid">${cards}</div>
      <div class="small muted">按实际问题进入对应栏目：先确认拆解和参与角色，再看继承、Skill、规则、控制、阻塞、任务时间线和协作过程。</div>
    `);
  }

  global.AIMAC_TASK_GROUP_INSIGHTS = {executionTimeline, monitorMatrix, detailPath};
})(window);
