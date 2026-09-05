(function initExecutionObjectWorkspace(global) {
  "use strict";
  const {esc} = global.AIMAC_CONSOLE_DOM_UTILS;

  const present = (value, fallback = "-") => value === undefined || value === null || value === "" ? fallback : value;
  const titleFor = (type) => type === "session" ? "工作会话" : "Agent 派发";

  function linkedObject({label, value, action = "", attrs = ""}) {
    const body = `<span>${esc(label)}</span><strong>${esc(present(value))}</strong>`;
    return action ? `<button class="execution-link" data-action="${esc(action)}" ${attrs}>${body}</button>`
      : `<div class="execution-link static">${body}</div>`;
  }

  function relationship(detail) {
    const group = detail.taskGroup;
    const work = detail.workItem;
    const session = detail.session;
    const dispatch = detail.dispatch;
    const node = detail.node;
    return `<div class="execution-relationship" aria-label="执行对象关系">
      ${linkedObject({label: "任务组", value: group?.name || group?.id, action: "execution-open-group", attrs: `data-task="${esc(group?.id || "")}"`})}
      <span class="execution-arrow" aria-hidden="true">›</span>
      ${linkedObject({label: "任务", value: work?.title || work?.id, action: "execution-open-work", attrs: `data-task="${esc(group?.id || "")}" data-work="${esc(work?.id || "")}"`})}
      <span class="execution-arrow" aria-hidden="true">›</span>
      ${linkedObject({label: "会话", value: session?.sessionId, action: session?.sessionId && detail.objectType !== "session" ? "open-execution-object" : "", attrs: `data-execution-type="session" data-execution-id="${esc(session?.sessionId || "")}" data-task="${esc(group?.id || "")}"`})}
      <span class="execution-arrow" aria-hidden="true">›</span>
      ${linkedObject({label: "派发", value: dispatch?.dispatchId, action: dispatch?.dispatchId && detail.objectType !== "dispatch" ? "open-execution-object" : "", attrs: `data-execution-type="dispatch" data-execution-id="${esc(dispatch?.dispatchId || "")}" data-task="${esc(group?.id || "")}"`})}
      <span class="execution-arrow" aria-hidden="true">›</span>
      ${linkedObject({label: "运行节点", value: node?.nodeName || node?.nodeId || "尚未分配", action: node?.nodeId ? "execution-open-node" : "", attrs: `data-node="${esc(node?.nodeId || "")}"`})}
    </div>`;
  }

  function definitionList(items) {
    return `<dl class="execution-kv">${items.map(([label, value, mono = false]) =>
      `<dt>${esc(label)}</dt><dd${mono ? ` class="mono"` : ""}>${value}</dd>`).join("")}</dl>`;
  }

  function eventTimeline(events, h) {
    if (!events.length) return `<div class="notice">当前范围还没有过程事件。Agent 开始执行后，进度、输出摘要、仓库变更和检查点会持续出现在这里。</div>`;
    return `<ol class="execution-event-timeline">${events.map((event) => `<li>
      <span class="execution-event-point tone-${event.status === "failed" || event.status === "blocked" ? "red" : event.status === "completed" ? "green" : "blue"}"></span>
      <div class="execution-event-body"><div class="execution-event-title">${h.badge(event.eventType, "blue")} ${h.badge(event.status)}${Number.isFinite(Number(event.progressPercent)) ? `<strong>${esc(event.progressPercent)}%</strong>` : ""}</div>
        <div>${esc(event.summary || "未提供摘要")}</div>${h.evidenceRefsHint(event)}
        <div class="small muted">${h.fmtTime(event.createdAt)}${event.nodeId ? ` · 节点 ${esc(event.nodeId)}` : ""}</div></div>
    </li>`).join("")}</ol>`;
  }

  function commandRows(commands, h) {
    if (!commands.length) return `<div class="small muted">当前对象没有控制命令。</div>`;
    return `<div class="execution-record-list">${commands.map((command) => `<div class="execution-record-row">
      <div><strong>${esc(h.t(command.commandType) || command.commandType || "控制命令")}</strong><div class="small muted mono">${esc(command.commandId || `#${command.sequence || "-"}`)}</div></div>
      <div>${h.badge(command.status)}<div class="small muted">${esc(h.explainCoded(command.ackResult?.reason || "")) || "等待或已正常处理"}</div></div>
      <time>${h.fmtTime(command.updatedAt || command.createdAt)}</time>
    </div>`).join("")}</div>`;
  }

  function evidence(detail, h) {
    const output = detail.repositoryOutput;
    const checkpoints = detail.checkpoints || [];
    const gates = detail.qualityGates || [];
    const tests = detail.testResults || [];
    if (!output && !checkpoints.length && !gates.length && !tests.length) {
      return `<div class="notice">当前对象还没有仓库产出、检查点或质量证据。</div>`;
    }
    const outputHtml = output ? definitionList([
      ["仓库", esc(present(output.repositoryId)), true],
      ["分支", esc(present(output.branch || output.targetBranch)), true],
      ["产出状态", h.badge(output.status)],
      ["清单", esc(present(output.artifactManifestPath || output.artifactManifestRef)), true]
    ]) : "";
    const pointHtml = checkpoints.map((checkpoint) => `<div class="execution-evidence-row"><div><strong>检查点</strong><span class="mono">${esc(checkpoint.checkpointId || checkpoint.runId || "-")}</span></div>
      <div>${(checkpoint.commitRefs || []).length ? `提交 ${(checkpoint.commitRefs || []).map((item) => `<code>${esc(String(item.commit || item).slice(0, 12))}</code>`).join(" ")}` : "无提交"}</div>
      <div>${(checkpoint.pushRefs || []).length ? "已推送" : "未推送"}</div><time>${h.fmtTime(checkpoint.createdAt || checkpoint.updatedAt)}</time></div>`).join("");
    const qualityHtml = [...gates.map((item) => ({kind: h.t(item.gateType) || item.gateType || "质量门", ...item})),
      ...tests.map((item) => ({kind: item.name || item.testId || "测试", ...item}))]
      .map((item) => `<div class="execution-evidence-row"><div><strong>${esc(item.kind)}</strong><span class="mono">${esc(item.gateId || item.testId || "-")}</span></div><div>${h.badge(item.status)}</div><div class="text-clip">${esc(item.summary || item.failureReason || "-")}</div><time>${h.fmtTime(item.updatedAt || item.createdAt)}</time></div>`).join("");
    return `${outputHtml}${pointHtml ? `<h4>Git 检查点</h4><div class="execution-evidence-list">${pointHtml}</div>` : ""}${qualityHtml ? `<h4>质量与测试</h4><div class="execution-evidence-list">${qualityHtml}</div>` : ""}`;
  }

  function relatedDispatches(detail, h) {
    if (detail.objectType !== "session" || !(detail.relatedDispatches || []).length) return "";
    return `<section class="execution-object-band"><div class="execution-band-heading"><div><span class="governance-eyebrow">会话承载</span><h3>关联派发</h3></div><strong>${esc(detail.relatedDispatchCount || detail.relatedDispatches.length)} 次</strong></div>
      <div class="execution-record-list">${detail.relatedDispatches.map((dispatch) => `<button class="execution-record-row execution-record-button" data-action="open-execution-object" data-execution-type="dispatch" data-execution-id="${esc(dispatch.dispatchId)}" data-task="${esc(detail.taskGroup?.id || "")}">
        <div><strong>${esc(dispatch.dispatchId)}</strong><span class="small muted">${esc(h.t(dispatch.roleId) || dispatch.roleId || "未记录角色")}</span></div>
        <div>${h.badge(dispatch.status)} ${Number.isFinite(Number(dispatch.progressPercent)) ? `<span>${esc(dispatch.progressPercent)}%</span>` : ""}</div>
        <div class="small muted">${esc(dispatch.model || "未记录模型")} · ${esc(h.t(dispatch.reasoning) || dispatch.reasoning || "未记录推理")}</div>
        <time>${h.fmtTime(dispatch.updatedAt || dispatch.createdAt)}</time></button>`).join("")}</div></section>`;
  }

  function render({detail, events = [], eventHistory = false, eventPage = 1, hasMoreEvents = false, historyTruncated = false, controls = "", helpers: h}) {
    const target = detail.objectType === "session" ? detail.session : detail.dispatch;
    const session = detail.session || {};
    const dispatch = detail.dispatch || {};
    const decision = detail.modelDecision || {};
    const selectedModel = decision.selectedModel || {};
    const placement = detail.placementDecision || {};
    const agent = detail.agent;
    const node = detail.node;
    const progress = Number.isFinite(Number(dispatch.progressPercent)) ? Number(dispatch.progressPercent) : null;
    const eventList = events.slice().sort((left, right) => Number(right.sequence || 0) - Number(left.sequence || 0));
    return `<section class="execution-object-workspace wide" aria-label="${esc(titleFor(detail.objectType))}详情">
      <header class="execution-object-header" tabindex="-1" data-execution-object-heading>
        <button class="secondary-button" data-action="close-execution-object">返回${detail.taskGroup?.id ? "任务组监控" : "执行监控"}</button>
        <div class="execution-object-title"><div><span class="governance-eyebrow">${esc(titleFor(detail.objectType))}</span><h2>${esc(detail.objectId)}</h2></div>
          <div class="execution-object-state">${h.badge(target?.status)}${progress === null ? "" : `<strong>${esc(progress)}%</strong>`}</div></div>
        <div class="record-meta"><span>最近活动 ${h.fmtTime(dispatch.lastExecutionEventAt || target?.updatedAt || target?.createdAt)}</span><span>${detail.settled ? "已结束" : "执行链路仍在活动"}</span></div>
        ${progress === null ? "" : `<div class="execution-progress" aria-label="执行进度 ${esc(progress)}%"><span style="width:${Math.max(0, Math.min(100, progress))}%"></span></div>`}
      </header>
      ${relationship(detail)}
      ${controls ? `<div class="execution-object-controls">${controls}</div>` : ""}
      <div class="execution-object-columns">
        <section class="execution-object-band"><span class="governance-eyebrow">执行身份</span><h3>Agent 与节点</h3>${definitionList([
          ["逻辑 Agent", agent ? `<button class="object-name-link" data-action="execution-open-agent" data-agent="${esc(agent.id)}">${esc(agent.name || agent.id)}</button><div class="small muted mono">${esc(agent.id)}</div>` : "<span class=\"muted\">未绑定档案</span>"],
          ["作用范围", esc(agent?.projectId ? "项目级 Agent" : agent ? "组织共享 Agent" : "-")],
          ["执行角色", `${esc(h.t(session.roleId || dispatch.roleId) || session.roleId || dispatch.roleId || "-")}<div class="small muted mono">${esc(session.roleId || dispatch.roleId || "-")}</div>`],
          ["运行节点", node ? `<button class="object-name-link" data-action="execution-open-node" data-node="${esc(node.nodeId)}">${esc(node.nodeName || node.nodeId)}</button><div class="small muted mono">${esc(node.nodeId)}</div>` : "<span class=\"muted\">尚未分配</span>"],
          ["节点状态", node ? `${h.badge(node.status)} ${h.badge(node.admission)}` : "-"]
        ])}</section>
        <section class="execution-object-band"><span class="governance-eyebrow">调度决定</span><h3>模型与放置</h3>${definitionList([
          ["实际模型", `<span class="mono">${esc(selectedModel.modelId || dispatch.model || "-")}</span>`],
          ["推理级别", esc(h.t(selectedModel.reasoningLevel || selectedModel.reasoning || dispatch.reasoning) || selectedModel.reasoningLevel || dispatch.reasoning || "-")],
          ["会话放置", esc(h.t(placement.placement || session.placement) || placement.placement || session.placement || "-")],
          ["执行载体", esc(placement.workerCarrierDecision?.carrier || placement.workerCarrierDecision?.mode || session.laneId || "-")],
          ["模型选择依据", esc(decision.modelDecision || dispatch.modelDecision || "未记录")]
        ])}</section>
      </div>
      <section class="execution-object-band"><div class="execution-band-heading"><div><span class="governance-eyebrow">任务契约</span><h3>Skill、规则与验收要求</h3></div><span class="mono small">${esc(dispatch.taskContractDigest || session.taskContractDigest || "")}</span></div>${h.ruleSummaryHtml(detail.contractSummary)}</section>
      ${relatedDispatches(detail, h)}
      <section class="execution-object-band"><div class="execution-band-heading"><div><span class="governance-eyebrow">实时过程</span><h3>执行事件</h3></div>
        <div class="button-row" role="group" aria-label="记录模式"><button class="${eventHistory ? "secondary-button" : "primary-button"}" data-exec-mode="live">最新记录</button><button class="${eventHistory ? "primary-button" : "secondary-button"}" data-exec-mode="history">完整历史</button></div></div>
        ${historyTruncated && !eventHistory ? `<div class="small muted">当前显示近期事件窗口；切换“完整历史”可继续向前翻页。</div>` : ""}
        ${eventTimeline(eventList, h)}
        ${eventHistory ? `<div class="button-row"><button class="secondary-button" data-event-page="previous"${eventPage <= 1 ? " disabled" : ""}>上一页</button><span class="small muted">第 ${esc(eventPage)} 页</span><button class="secondary-button" data-event-page="next"${hasMoreEvents ? "" : " disabled"}>下一页</button></div>` : ""}</section>
      <section class="execution-object-band"><span class="governance-eyebrow">控制回执</span><h3>控制命令</h3>${commandRows(detail.controlCommands || [], h)}</section>
      <section class="execution-object-band"><span class="governance-eyebrow">结果证据</span><h3>仓库、检查点与质量</h3>${evidence(detail, h)}</section>
    </section>`;
  }

  global.AIMAC_EXECUTION_OBJECT_WORKSPACE = {render, titleFor};
})(window);
