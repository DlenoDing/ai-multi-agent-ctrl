(function initRuntimeNodeWorkspace(global) {
  "use strict";
  const {esc} = global.AIMAC_CONSOLE_DOM_UTILS;

  function metric(label, value) {
    return `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  }

  function chips(items, empty = "未声明") {
    return items?.length ? `<div class="chip-row">${items.map((item) => `<span class="chip">${esc(item)}</span>`).join("")}</div>`
      : `<span class="muted">${esc(empty)}</span>`;
  }

  function dispatches(detail, h) {
    const items = detail.activeDispatches || [];
    if (!items.length) return `<div class="notice">当前节点没有活动派发，可继续接收符合角色与项目范围的新任务。</div>`;
    return `<div class="runtime-node-records">${items.map((dispatch) => `<button class="runtime-node-record" data-action="open-execution-object" data-execution-type="dispatch" data-execution-id="${esc(dispatch.dispatchId)}" data-task="${esc(dispatch.taskGroupId || "")}" data-project="${esc(dispatch.projectId || "")}">
      <div><strong>${esc(dispatch.workItemTitle || dispatch.workItemId || dispatch.dispatchId)}</strong><span>${esc(dispatch.taskGroupName || dispatch.taskGroupId || "-")}</span></div>
      <div>${h.badge(dispatch.status)}${Number.isFinite(Number(dispatch.progressPercent)) ? `<strong>${esc(dispatch.progressPercent)}%</strong>` : ""}</div>
      <div><span>${esc(h.t(dispatch.roleId) || dispatch.roleId || "未记录角色")}</span><span class="mono">${esc(dispatch.model || "未记录模型")}</span></div>
      <time>${h.fmtTime(dispatch.lastExecutionEventAt || dispatch.updatedAt || dispatch.createdAt)}</time>
    </button>`).join("")}</div>`;
  }

  function commands(items, h) {
    if (!items.length) return `<div class="small muted">当前节点没有控制命令。</div>`;
    return `<div class="runtime-node-records">${items.map((command) => `<div class="runtime-node-record static">
      <div><strong>${esc(h.t(command.commandType) || command.commandType || "控制命令")}</strong><span class="mono">${esc(command.commandId || `#${command.sequence || "-"}`)}</span></div>
      <div>${h.badge(command.status)}</div><div>${esc(h.explainCoded(command.ackResult?.reason || "")) || "已正常处理或等待 ACK"}</div><time>${h.fmtTime(command.updatedAt || command.createdAt)}</time>
    </div>`).join("")}</div>`;
  }

  function events(items, h) {
    if (!items.length) return `<div class="small muted">当前节点还没有近期执行事件。</div>`;
    return `<ol class="runtime-node-events">${items.slice(0, 30).map((event) => `<li><span></span><div><div>${h.badge(event.eventType, "blue")} ${h.badge(event.status)}${Number.isFinite(Number(event.progressPercent)) ? ` <strong>${esc(event.progressPercent)}%</strong>` : ""}</div>
      <p>${esc(event.summary || "未提供摘要")}</p>${h.evidenceRefsHint(event)}<div class="small muted">${h.fmtTime(event.createdAt)} · ${esc(event.dispatchId || event.sessionId || "节点事件")}</div></div></li>`).join("")}</ol>`;
  }

  function profiles(items, h) {
    if (!items.length) return `<div class="notice">当前节点的角色范围没有匹配到启用中的 Agent 档案；总控不会把不满足档案和角色条件的任务派到这里。</div>`;
    return `<div class="runtime-node-profiles">${items.map((agent) => `<button data-action="open-agent-profile" data-agent="${esc(agent.id)}"><strong>${esc(agent.name || agent.id)}</strong><span>${esc(h.t(agent.role) || agent.role)}</span><span>${esc(agent.projectId ? "项目级" : "组织共享")}</span></button>`).join("")}</div>`;
  }

  function capability(detail, h) {
    const node = detail.node;
    const profile = node.profile || {};
    const tools = profile.tools || [];
    const models = profile.models || [];
    return `<div class="runtime-node-capability-grid">
      ${metric("CPU", profile.cpuCount ?? "-")}${metric("内存", h.fmtBytes(profile.memoryBytes))}${metric("磁盘可用", h.fmtBytes(profile.diskFreeBytes))}${metric("网络", profile.networkSpeedMbps ? `${profile.networkSpeedMbps} Mbps` : "-")}
    </div>
    <div class="runtime-node-capability-groups"><div><h4>模型执行器</h4>${chips(models.map((model) => `${model.providerClass || model.modelId || "model"}${model.available === false ? "（不可用）" : ""}`), "未上报模型")}</div>
      <div><h4>本机工具</h4>${chips(tools.map((tool) => `${tool.name || "tool"}${tool.version ? ` ${tool.version}` : ""}${tool.available === false ? "（不可用）" : ""}`), "未上报工具")}</div>
      <div><h4>能力标记</h4>${chips(profile.capabilityFlags || [], "未上报能力标记")}</div></div>`;
  }

  function render({detail, controls = "", helpers: h} = {}) {
    const node = detail.node;
    const missing = node.selfCheckMissing || [];
    const failures = node.selfCheckFailures || [];
    const scopeText = detail.scope?.type === "organization" ? `组织共享 · ${detail.scope.id || node.organizationId || "当前组织"}`
      : `项目专属 · ${(detail.scope?.ids || node.projectIds || []).join("、") || detail.projectId || "未绑定项目"}`;
    return `<section class="runtime-node-workspace wide" aria-label="运行节点详情">
      <header class="runtime-node-header" tabindex="-1" data-runtime-node-heading><button class="secondary-button" data-action="close-runtime-node">返回运行节点列表</button>
        <div class="runtime-node-title"><div><span class="governance-eyebrow">${esc(scopeText)}</span><h2>${esc(node.nodeName || node.nodeId)}</h2><span class="mono">${esc(node.nodeId)}</span></div>
          <div class="runtime-node-state">${h.badge(node.heartbeatOverdue ? "heartbeat_timeout" : node.status)}${h.badge(node.admission)}</div></div>
        <div class="runtime-node-metrics">${metric("当前任务", (detail.activeDispatches || []).length)}${metric("累计派发", detail.assignedDispatchCount || 0)}${metric("匹配档案", (detail.agentProfiles || []).length)}${metric("最近事件", (detail.recentEvents || []).length)}${metric("完成 / 失败", `${node.completedDispatchCount || 0} / ${node.failedDispatchCount || 0}`)}</div>
      </header>
      ${node.heartbeatOverdue ? `<div class="notice warn-notice">节点记录仍是“${esc(h.t(node.status) || node.status)}”，但心跳已超过判死阈值。它当前不能被当作可执行节点；先恢复 Agent Runtime 和网络心跳，再刷新自检。</div>` : ""}
      ${controls ? `<div class="runtime-node-controls">${controls}</div>` : ""}
      <div class="runtime-node-columns">
        <section><span class="governance-eyebrow">运行健康</span><h3>心跳与自检</h3><dl class="execution-kv">
          <dt>最近心跳</dt><dd>${h.fmtTime(node.lastHeartbeatAt)}</dd><dt>最近自检</dt><dd>${h.fmtTime(node.lastSelfCheckAt)}</dd><dt>Runtime 版本</dt><dd class="mono">${esc(node.runtimeVersion || "-")}${node.runtimeOutdated ? " · 需要升级" : ""}</dd>
          <dt>缺少检查</dt><dd>${missing.length ? chips(missing.map((item) => h.t(item) || item)) : "无"}</dd><dt>失败检查</dt><dd>${failures.length ? chips(failures.map((item) => h.explainCoded(item.reason || item))) : "无"}</dd>
        </dl></section>
        <section><span class="governance-eyebrow">调配边界</span><h3>项目与角色</h3><dl class="execution-kv"><dt>注册范围</dt><dd>${esc(scopeText)}</dd><dt>可见项目</dt><dd>${chips(node.effectiveProjectIds || node.projectIds || [], "暂无")}</dd><dt>可承担角色</dt><dd>${chips(node.allowedRoles || [], "未声明")}</dd><dt>远程 MCP 工具</dt><dd>${chips(node.allowedMcpTools || [], "按任务授权")}</dd></dl></section>
      </div>
      <section class="runtime-node-band"><span class="governance-eyebrow">主机能力</span><h3>模型、资源与工具</h3>${capability(detail, h)}</section>
      <section class="runtime-node-band"><div class="runtime-node-band-heading"><div><span class="governance-eyebrow">当前负载</span><h3>活动派发</h3></div><strong>${esc((detail.activeDispatches || []).length)} 个</strong></div>${dispatches(detail, h)}</section>
      <section class="runtime-node-band"><span class="governance-eyebrow">逻辑角色</span><h3>可匹配 Agent 档案</h3>${profiles(detail.agentProfiles || [], h)}</section>
      <section class="runtime-node-band"><span class="governance-eyebrow">控制回执</span><h3>节点命令</h3>${commands(detail.controlCommands || [], h)}</section>
      <section class="runtime-node-band"><span class="governance-eyebrow">执行回送</span><h3>近期事件</h3>${events(detail.recentEvents || [], h)}</section>
    </section>`;
  }

  global.AIMAC_RUNTIME_NODE_WORKSPACE = {render};
})(window);
