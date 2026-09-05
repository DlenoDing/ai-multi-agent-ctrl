(function () {
  "use strict";
  const {esc} = window.AIMAC_CONSOLE_DOM_UTILS;

  function projectLink(project, label, {page = "proj-overview", workspace = "", accountId = "", primary = false} = {}) {
    return `<button class="${primary ? "object-name-link" : "secondary-button"}" data-action="open-project-page" data-project="${esc(project.id)}" data-target-menu="${esc(page)}"${workspace ? ` data-target-workspace="${esc(workspace)}"` : ""}${accountId ? ` data-grant-account="${esc(accountId)}"` : ""}>${esc(label)}</button>`;
  }

  function groupLink(group, label, page = "tg", primary = false) {
    return `<button class="${primary ? "object-name-link" : "secondary-button"}" data-focus-group="${esc(group.id)}" data-focus-page="${esc(page)}">${esc(label)}</button>`;
  }

  function trail({organization, project, group, work, pageLabel, returnTask}) {
    const parts = [];
    if (organization?.name) parts.push(`<span>${esc(organization.name)}</span>`);
    if (project) parts.push(projectLink(project, project.name || project.id, {primary: true}));
    if (group) parts.push(groupLink(group, group.name || group.id, "tg", true));
    if (work) parts.push(`<span>${esc(work.title || work.id)}</span>`);
    if (!parts.length) return "";
    return `<div class="object-context"><nav aria-label="当前位置">${parts.join('<span class="object-separator" aria-hidden="true">/</span>')}<span class="object-separator" aria-hidden="true">/</span><span aria-current="page">${esc(pageLabel)}</span></nav>
      ${returnTask ? `<button class="secondary-button" data-return-work title="${esc(returnTask.title)}">返回任务：${esc(returnTask.title)}</button>` : ""}</div>`;
  }

  function projectSummary({project, agentOnline, agentTotal, repositoryCount, helpers: h}) {
    return `<section class="project-object-summary wide" aria-label="项目摘要">
      <div class="project-object-identity"><h2>${esc(project.name || project.id)}</h2>
        <div class="record-meta"><span>状态 ${h.badge(project.status)}</span><span>阶段 ${h.badge(project.progress?.phase)}</span><span>健康度 ${h.badge(project.progress?.health)}</span><span>更新 ${h.fmtTime(project.progress?.updatedAt)}</span></div>
        <div class="project-object-progress"><span>总进度</span>${h.progressLine(project.progress?.percent)}</div>
      </div>
      <div class="project-object-resources">
        ${projectLink(project, `Agent 节点 ${agentOnline}/${agentTotal} 在线`, {page: "proj-agents", workspace: "nodes"})}
        ${projectLink(project, `仓库 ${repositoryCount} 个`, {page: "proj-settings", workspace: "repositories"})}
        ${projectLink(project, `成员 ${(project.members || []).length} 人`, {page: "proj-members", workspace: "list"})}
      </div>
    </section>`;
  }

  window.AIMAC_OBJECT_WORKSPACE = {projectLink, groupLink, trail, projectSummary};
})();
