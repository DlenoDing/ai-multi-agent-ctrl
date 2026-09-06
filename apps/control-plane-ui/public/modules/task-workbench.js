(function () {
  "use strict";
  const {esc} = window.AIMAC_CONSOLE_DOM_UTILS;

  function itemsFor(groups, detail) {
    return groups.flatMap((group) => {
      const items = detail?.taskGroupId === group.id && detail?.progress?.workItems ? detail.progress.workItems : group.workItems || [];
      return items.map((work) => ({group, work}));
    }).sort((a, b) => String(b.work.createdAt || "").localeCompare(String(a.work.createdAt || "")) || String(b.work.id).localeCompare(String(a.work.id)));
  }

  function render({groups, detail, state, selected, pageData, workDetail, pageNumber = 1, eventHistory = false, eventPage = 1, loading = false, query = "", status = "", disclosure = {}, helpers: h}) {
    const all = pageData ? (pageData.workItems || []).map((work) => ({work,
      group: groups.find((item) => item.id === work.taskGroupId) || {id: work.taskGroupId, name: work.taskGroupName}})) : itemsFor(groups, detail);
    const picked = selected?.workItemId && workDetail?.workItem?.id === selected.workItemId && workDetail?.taskGroup?.id === selected?.taskGroupId
      ? {group: workDetail.taskGroup, work: workDetail.workItem}
      : all.find(({group, work}) => group.id === selected?.taskGroupId && work.id === selected?.workItemId);
    if (selected?.workItemId && picked) return renderDetail(picked, state, h, workDetail || {}, eventHistory, eventPage, disclosure);
    const needle = query.trim().toLocaleLowerCase();
    const visible = pageData ? all : all.filter(({group, work}) => (!status || work.status === status)
      && (!needle || [work.title, work.id, group.name, work.ownerRole].join(" ").toLocaleLowerCase().includes(needle)));
    const rows = visible.map(({group, work}) => `<div class="task-list-row">
      <div><strong class="task-list-title">${esc(work.title || work.id)}</strong> ${h.badge(work.status)}
        <div class="task-list-meta"><span>${esc(group.name || group.id)}</span><span>${esc(h.t(work.ownerRole))}</span><span>${h.fmtTime(work.createdAt)}</span><span>${esc(work.progress ?? 0)}%</span></div>
        ${work.blockedReason ? `<div class="small warn-text">${esc(h.explainCoded(work.blockedReason))}</div>` : ""}</div>
      <button class="secondary-button" data-open-work="${esc(work.id)}" data-work-group="${esc(group.id)}">查看任务</button>
    </div>`).join("");
    const truncated = pageData ? [] : groups.filter((group) => group.workItemsTruncated && detail?.taskGroupId !== group.id);
    return `<div class="stack"><div class="button-row">
      <input aria-label="搜索任务" data-work-search value="${esc(query)}" placeholder="任务名称、编号、执行角色">
      <select aria-label="任务状态" data-work-status><option value="">全部状态</option>${[...new Set([status, ...all.map(({work}) => work.status)].filter(Boolean))].map((value) =>
        `<option value="${esc(value)}"${value === status ? " selected" : ""}>${esc(h.t(value))}</option>`).join("")}</select>
      <span class="small muted">${pageData?.total ?? visible.length} 项任务${loading ? " · 正在加载" : ""}</span></div>
      ${truncated.length ? `<div class="notice">${truncated.length} 个任务组仅加载了任务摘要。${truncated.map((group) =>
        `<button class="secondary-button" data-focus-group="${esc(group.id)}" data-focus-page="tasks">${esc(group.name || group.id)} · 完整任务</button>`).join(" ")}</div>` : ""}
      <div class="task-list">${rows || `<div class="notice">${query || status || all.length ? "没有匹配的任务。" : "当前范围还没有任务。"}</div>`}</div>
      ${pageData ? `<div class="button-row"><button class="secondary-button" data-task-page="previous"${loading || pageNumber <= 1 ? " disabled" : ""}>上一页</button>
        <span class="small muted">第 ${pageNumber} 页 · 本页 ${visible.length} 项</span><button class="secondary-button" data-task-page="next"${loading || !pageData.hasMore ? " disabled" : ""}>下一页</button></div>` : ""}</div>`;
  }

  function renderDetail({group, work}, state, h, eventInfo, eventHistory, eventPage, disclosure) {
    const runs = (state.agentDispatches || []).filter((run) => run.taskGroupId === group.id && run.workItemId === work.id)
      .slice().sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || String(a.dispatchId).localeCompare(String(b.dispatchId)));
    const nodeNames = new Map((state.agentRuntimeNodes || []).map((node) => [node.nodeId, node.nodeName || node.nodeId]));
    const sessions = new Map((state.workSessions || []).map((session) => [session.sessionId, session]));
    const agents = new Map((state.agents || []).map((agent) => [agent.id, agent]));
    const eventsByRun = new Map();
    for (const event of (state.agentExecutionEvents || []).slice(-60)) {
      if (!eventsByRun.has(event.dispatchId)) eventsByRun.set(event.dispatchId, []);
      eventsByRun.get(event.dispatchId).push(event);
    }
    const histories = runs.map((run, index) => {
      const session = sessions.get(run.sessionId);
      const logical = agents.get(session?.agentId);
      const events = (eventsByRun.get(run.dispatchId) || []).slice().sort((a, b) =>
        Number(a.sequence || 0) && Number(b.sequence || 0) ? Number(a.sequence) - Number(b.sequence) : String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
      const returned = h.isTerminalDispatch(run.status);
      const executed = run.status === "completed" || events.some((event) => ["executor_started", "executor_output", "checkpoint_submitted"].includes(event.eventType));
      const stages = [["建立派发", true], ["节点认领", Boolean(run.assignedNodeId || run.claimedAt)], ["执行任务", executed], ["过程回送", Boolean(events.length || run.lastExecutionEventAt)], ["检查点", run.status === "completed"]];
      const open = disclosure[run.dispatchId] ?? (!returned || index === runs.length - 1);
      return `<details class="task-run"${open ? " open" : ""}><summary data-run-disclosure="${esc(run.dispatchId)}"><strong>第 ${index + 1} 次执行</strong> ${h.badge(run.status)}
        <span class="task-run-summary-meta"><span>${esc(h.t(run.roleId || work.ownerRole))}</span><span>${esc(nodeNames.get(run.assignedNodeId) || run.assignedNodeId || "等待认领")}</span><span>${esc(run.model || "未指定模型")}</span><span>${h.fmtTime(run.createdAt)}</span></span></summary>
        <div class="task-run-body"><ol class="execution-stages">${stages.map(([label, done]) => `<li class="${done ? "done" : returned ? "attention" : ""}">${esc(label)}</li>`).join("")}</ol>
        <dl class="kv-list"><dt>运行节点</dt><dd>${esc(nodeNames.get(run.assignedNodeId) || run.assignedNodeId || "等待认领")}</dd>
          <dt>角色档案</dt><dd>${esc(logical?.name || logical?.id || session?.agentId || "未记录")}</dd>
          <dt>执行角色</dt><dd>${esc(h.t(run.roleId || work.ownerRole))}</dd>
          <dt>模型与推理</dt><dd>${esc(run.model || "未记录")} · ${esc(run.reasoning || "未记录")}</dd>
          <dt>选型判断</dt><dd>${esc(run.modelDecision || "未记录")}</dd>
          <dt>会话</dt><dd class="mono">${esc(run.sessionId || "未记录")}</dd>
          <dt>派发时间</dt><dd>${h.fmtTime(run.createdAt)}</dd>
          <dt>最新回送</dt><dd>${h.fmtTime(run.lastExecutionEventAt || run.updatedAt)}</dd></dl>
        ${run.failureReason || run.blockedReason ? `<div class="notice warn-notice">${esc(h.explainCoded(run.failureReason || run.blockedReason))}${h.repositoryFailureAction(run)}</div>` : ""}
        <div class="button-row"><button class="primary-button" data-action="open-execution-object" data-execution-type="dispatch" data-execution-id="${esc(run.dispatchId)}" data-task="${esc(group.id)}">查看本次执行</button>
          <button class="secondary-button" data-action="show-dispatch-events" data-event-mode="history" data-dispatch-id="${esc(run.dispatchId)}" data-task="${esc(group.id)}">历史执行记录</button>
          <button class="secondary-button" data-action="show-dispatch-rules" data-dispatch-id="${esc(run.dispatchId)}">本次执行规则</button></div>
        ${h.dispatchRuleSummaries[run.dispatchId] ? h.ruleSummaryHtml(h.dispatchRuleSummaries[run.dispatchId]) : ""}
        ${events.length ? `<details class="task-run-events"${disclosure[`${run.dispatchId}:events`] ? " open" : ""}><summary data-run-disclosure="${esc(run.dispatchId)}:events">执行记录（${events.length} 条）</summary><ol class="task-requirements">${events.map((event) => `<li><span class="small muted">${h.fmtTime(event.createdAt)}</span> ${esc(h.t(event.eventType))}：${esc(event.summary || "")}</li>`).join("")}</ol></details>` : ""}
      </div></details>`;
    }).join("");
    const runIds = new Set(runs.map((run) => run.dispatchId));
    const archivedEvents = (state.agentExecutionEvents || []).filter((event) => event.taskGroupId === group.id
      && event.workItemId === work.id && !runIds.has(event.dispatchId)).slice(-60);
    return `<div class="stack"><div class="task-detail-header"><button class="secondary-button" data-close-work>返回任务列表</button></div>
      <div><h3>${esc(work.title || work.id)}</h3>${h.badge(work.status)} ${h.progressLine(work.progress)}
      <div class="task-list-meta"><span>任务组：${esc(group.name || group.id)}</span><span>执行角色：${esc(h.t(work.ownerRole))}</span><span class="mono">${esc(work.id)}</span></div></div>
      ${String(group.goalExecutionStatus || "").startsWith("active_paused") ? `<div class="notice warn-notice">任务组处于暂停状态。${group.canControl ? `<button class="primary-button" data-action="task-control" data-task="${esc(group.id)}" data-task-action="resume">启动任务组</button>` : "需要任务组负责人启动。"}</div>` : ""}
      ${work.blockedReason ? `<div class="notice warn-notice">${esc(h.explainCoded(work.blockedReason))}</div>` : ""}
      ${h.workItemExitHint(work)}${h.humanTraceHtml(work)}
      <details><summary>执行要求（${(work.requirements || []).length} 项）</summary><ul class="task-requirements">${(work.requirements || []).map((requirement) => `<li>${esc(requirement)}</li>`).join("")}</ul></details>
      ${group.canReview && group.status !== "closed" && group.status !== "aborted" ? `<details><summary>执行方案定稿要求：${work.requiresPlanFinalization ? "必须人工定稿" : "按系统判断"}</summary>
        <form class="form-grid" data-form="plan-finalization" data-task="${esc(group.id)}" data-work="${esc(work.id)}">
          <label>方案要求<select name="requiresPlanFinalization"><option value="false"${work.requiresPlanFinalization ? "" : " selected"}>按系统判断</option><option value="true"${work.requiresPlanFinalization ? " selected" : ""}>必须先由人定稿方案</option></select></label>
          <label>调整理由<input name="justification" required></label><button class="secondary-button" type="submit">保存</button>
        </form></details>` : ""}
      <section><h3>执行过程</h3><div class="button-row"><button class="${eventHistory ? "secondary-button" : "primary-button"}" data-work-event-mode="live">最新记录</button><button class="${eventHistory ? "primary-button" : "secondary-button"}" data-work-event-mode="history">完整历史</button></div>
        <div class="small muted">过程事件：${eventInfo.eventTotalExact === true && typeof eventInfo.eventCount === "number" ? `共 ${eventInfo.eventCount} 条` : "近期窗口"} · 本页 ${eventInfo.returnedEventCount ?? (eventInfo.events || []).length} 条${eventInfo.historyTruncated ? " · 含未显示的历史" : ""} · 执行尝试 ${runs.length} 次</div>
        <div class="task-run-trace">${histories || (archivedEvents.length ? "" : `<div class="notice">当前没有可展示的派发记录。${esc(h.t(work.status))}</div>`)}</div>
        ${archivedEvents.length ? `<div class="notice">以下事件的派发快照已不在当前运行态，历史事件仍保留。</div><ol class="task-requirements">${archivedEvents.map((event) => `<li>${h.fmtTime(event.createdAt)} · <code>${esc(event.dispatchId)}</code> · ${esc(h.t(event.eventType))}：${esc(event.summary || "")}</li>`).join("")}</ol>` : ""}
        ${eventHistory ? `<div class="button-row"><button class="secondary-button" data-work-event-page="previous"${eventPage <= 1 ? " disabled" : ""}>上一页</button><span class="small muted">第 ${eventPage} 页</span><button class="secondary-button" data-work-event-page="next"${eventInfo.hasMoreEvents ? "" : " disabled"}>下一页</button></div>` : ""}</section>
      <section><h3>结果与证据</h3>${h.workItemResultHtml(group.id, work.id)}</section></div>`;
  }

  window.AIMAC_TASK_WORKBENCH = {itemsFor, render};
})();
