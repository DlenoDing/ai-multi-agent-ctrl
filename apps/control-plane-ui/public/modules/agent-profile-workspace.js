(function initAgentProfileWorkspace(global) {
  "use strict";
  const {esc} = global.AIMAC_CONSOLE_DOM_UTILS;

  function detail({agent, scopeLabel, editable, formHtml, activationHtml, helpers: h} = {}) {
    return `<section class="governance-object-workspace agent-profile-workspace" aria-label="Agent 档案详情">
      <header class="governance-object-header" tabindex="-1" data-agent-profile-heading>
        <button class="secondary-button" data-action="close-agent-profile">返回 Agent 档案列表</button>
        <div class="governance-eyebrow">${esc(scopeLabel)}</div>
        <h2>${esc(agent.name || agent.id)}</h2>
        <div class="record-meta">${h.statusBadge("agent", agent.status)}<span class="mono">${esc(agent.id)}</span></div>
      </header>
      <div class="governance-object-columns">
        <section class="governance-object-band"><h3>执行身份</h3><dl class="kv-list">
          <dt>执行角色</dt><dd>${esc(h.t(agent.role))}<div class="small muted mono">${esc(agent.role)}</div></dd>
          <dt>作用范围</dt><dd>${esc(scopeLabel)}</dd>
          <dt>当前状态</dt><dd>${h.statusBadge("agent", agent.status)}</dd>
          <dt>信任分</dt><dd>${Number.isFinite(Number(agent.trustScore)) ? `${Math.round(Number(agent.trustScore) * 100)}%` : "-"}</dd>
        </dl></section>
        <section class="governance-object-band"><h3>模型与 Skill</h3><dl class="kv-list">
          <dt>模型偏好</dt><dd>${h.modelCell(agent.model)}</dd>
          <dt>角色 Skill</dt><dd class="mono">${esc(agent.roleSkillRef || "按角色集中解析")}</dd>
          <dt>容量状态</dt><dd>${esc(h.t(agent.capacity || "-"))}</dd>
          <dt>更新时间</dt><dd>${h.fmtTime(agent.updatedAt || agent.createdAt)}</dd>
        </dl></section>
      </div>
      <section class="governance-object-band"><h3>档案配置</h3>${editable ? formHtml : `<div class="notice">这是组织共享档案，当前项目只能调配和查看；请到组织管理的“共享 Agent”修改。</div>`}</section>
      ${editable ? `<div class="governance-actions">${activationHtml}</div>` : ""}
    </section>`;
  }

  global.AIMAC_AGENT_PROFILE_WORKSPACE = {detail};
})(window);
