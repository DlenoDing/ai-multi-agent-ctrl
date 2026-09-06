(function initAgentNodeCards(global) {
  "use strict";
  const {esc} = global.AIMAC_CONSOLE_DOM_UTILS;

  function render(nodes, options = {}, helpers) {
    const {canControl = false, scope = "project", showDanger = false, showAdmission = true,
      emptyText = "当前项目还没有任何 Agent 节点。要让任务实际执行，请进入“注册运行节点”签发一次性加入令牌。"} = options;
    const h = helpers;
    if (!nodes.length) return `<div class="notice warn-notice">${esc(emptyText)}</div>`;
    return `<div class="agent-cards">${nodes.map((node) => {
      const timedOut = h.heartbeatTimedOut(node);
      return `<div class="agent-card">
        <h3><span class="hover-wrap">${esc(node.nodeName || node.nodeId)}${h.agentHoverPop(node)}</span>${timedOut ? h.badge("heartbeat_timeout") : h.badge(node.status)}</h3>
        <div class="agent-meta">
          ${showAdmission ? `<span>准入：${h.badge(node.admission)}</span>` : ""}
          <span>健康度：${h.badge(timedOut ? "offline" : node.display?.health || node.status)}</span>
          <span>地区：${esc(node.display?.region || "-")}</span>
          <span>当前任务数：${h.nodeDispatchIds(node).length}</span>
          <span>最近心跳：${h.fmtTime(node.lastHeartbeatAt)}</span>
        </div>
        ${timedOut ? `<div class="small warn-text">上次状态仍为「${esc(h.t(node.status) || node.status)}」，但心跳已超过判死阈值。</div>` : ""}
        ${h.claimMissHint(node)}${h.selfCheckFailureHint(node)}${h.heartbeatStaleHint(node)}
        <div class="button-row" style="margin-top:10px;">${h.runtimeNodeDetailButton(node, true)}${canControl
          ? h.agentActions(node, {scope, showDanger})
          : `<span class="small muted">当前账号无节点控制权限</span>`}</div>
      </div>`;
    }).join("")}</div>`;
  }

  global.AIMAC_AGENT_NODE_CARDS = {render};
})(window);
