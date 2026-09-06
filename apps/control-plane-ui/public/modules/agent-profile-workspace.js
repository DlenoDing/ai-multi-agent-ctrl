(function initAgentProfileWorkspace(global) {
  "use strict";
  const {esc} = global.AIMAC_CONSOLE_DOM_UTILS;

  function rows(agents, {showScope = true, helpers: h} = {}) {
    return agents.map((agent) => h.row([
      `<strong>${esc(agent.name || agent.id)}</strong><div class="small muted mono">${esc(agent.id)}</div>`,
      esc(h.t(agent.role)),
      h.modelCell(agent.model),
      showScope ? esc(h.scopeText(agent)) : esc(agent.projectId ? "项目级" : "组织级"),
      h.statusBadge("agent", agent.status),
      {v: Number.isFinite(Number(agent.trustScore)) ? `${Math.round(Number(agent.trustScore) * 100)}%` : "-", c: "num"},
      agent.roleSkillRef ? `<span class="mono">${esc(agent.roleSkillRef)}</span>` : "-",
      `<button class="primary-button" data-action="open-agent-profile" data-agent="${esc(agent.id)}">查看与管理</button>`
    ])).join("");
  }

  function createForm({projectId = "", title = "创建 Agent 档案", readOnly = false,
    roleOptions = "", modelOptions = "", skillOptions = ""} = {}) {
    if (readOnly) return `<div class="notice warn-notice">当前账号没有智能体管理权限，只能查看 Agent 档案。</div>`;
    return `<form class="form-grid" data-form="agent-create">
      ${projectId ? `<input type="hidden" name="projectId" value="${esc(projectId)}">` : ""}
      <div class="form-row-inline">
        <div class="form-row"><label>${esc(title)}名称</label><input name="name" placeholder="例如：后端实现 Agent"></div>
        <div class="form-row"><label>执行角色</label><input name="role" list="agent-role-options" required placeholder="例如：agent-runtime"><datalist id="agent-role-options">${roleOptions}</datalist></div>
        <div class="form-row"><label>模型偏好</label><input name="model" list="agent-model-options" value="auto_best" placeholder="auto_best 或实际模型 ID"><datalist id="agent-model-options">${modelOptions}</datalist>
          <div class="small muted">自动最优（auto_best）· 自动快速（auto_fast）· 成本优先（cost_aware），或填写模型能力列表中的实际模型 ID。偏好只在满足任务硬约束和模型上限的候选中生效。</div></div>
        <div class="form-row"><label>信任分</label><input name="trustScore" type="number" step="0.01" min="0" max="1" value="0.85"></div>
      </div>
      <div class="form-row"><label>角色 Skill 引用（可选）</label><input name="roleSkillRef" list="agent-role-skill-options" placeholder="默认使用技能源内匹配角色">${skillOptions}</div>
      <div class="notice">${projectId ? "项目级 Agent 只服务当前项目；任务组派发时可同时调配当前项目级 Agent 和组织级 Agent。" : "组织级 Agent 可被本组织内项目调配；项目有特殊要求时再在项目页创建项目级 Agent。"}</div>
      <button class="primary-button" type="submit">${esc(title)}</button>
    </form>`;
  }

  function updateForm(agent, h) {
    return `<form class="form-grid" data-form="agent-profile-update" data-agent="${esc(agent.id)}">
      <div class="form-row-inline">
        <div class="form-row"><label>档案名称</label><input name="name" required value="${esc(agent.name || "")}"></div>
        <div class="form-row"><label>执行角色</label><input name="role" list="agent-profile-role-options" required value="${esc(agent.role || "")}">
          <datalist id="agent-profile-role-options">${h.roleOptions}</datalist></div>
        <div class="form-row"><label>模型偏好</label><input name="model" list="agent-profile-model-options" required value="${esc(agent.model || "auto_best")}">
          <datalist id="agent-profile-model-options">${h.modelOptions}</datalist></div>
        <div class="form-row"><label>信任分</label><input name="trustScore" type="number" step="0.01" min="0" max="1" required value="${esc(Number.isFinite(Number(agent.trustScore)) ? agent.trustScore : "")}"></div>
      </div>
      <div class="form-row"><label>角色 Skill 引用（留空则按角色集中解析）</label><input name="roleSkillRef" list="agent-profile-skill-options" value="${esc(agent.roleSkillRef || "")}">
        ${h.skillOptions}</div>
      <button class="primary-button" type="submit">保存 Agent 档案</button>
    </form>`;
  }

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
      <section class="governance-object-band"><h3>档案配置</h3>${editable ? formHtml : `<div class="notice">这是组织共享档案，当前项目只能调配和查看；请到「组织管理」→「共享 Agent 档案」修改。</div>`}</section>
      ${editable ? `<div class="governance-actions">${activationHtml}</div>` : ""}
    </section>`;
  }

  function workspace({agent, scopeLabel, editable, helpers: h} = {}) {
    return detail({
      agent,
      scopeLabel,
      editable,
      formHtml: editable ? updateForm(agent, h) : "",
      activationHtml: editable
        ? `<button class="${agent.status === "active" ? "danger-button" : "secondary-button"}" data-action="toggle-agent" data-agent="${esc(agent.id)}">${agent.status === "active" ? "停用档案" : "启用档案"}</button>` : "",
      helpers: h
    });
  }

  global.AIMAC_AGENT_PROFILE_WORKSPACE = {rows, createForm, updateForm, detail, workspace};
})(window);
