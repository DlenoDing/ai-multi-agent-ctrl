(function initContextNavigation(global) {
  "use strict";
  const {esc} = global.AIMAC_CONSOLE_DOM_UTILS;

  function managementSpaces({perspective, currentSection, organizationName = "", projectCount = 0} = {}) {
    const primary = perspective === "system"
      ? {target: "sys-overview", label: "系统管理", meta: "平台与组织"}
      : {target: "org-overview", label: "组织管理", meta: organizationName || "成员与共享资源"};
    const spaces = perspective === "user" ? [] : [primary,
      {target: "proj-overview", label: "项目管理", meta: `${projectCount} 个可见项目`}];
    if (!spaces.length) return "";
    return `<section class="management-space-switch" aria-label="管理空间">
      <span class="sidebar-eyebrow">管理空间</span>
      <div class="management-space-options">${spaces.map((space) => {
        const project = space.target === "proj-overview";
        const active = project ? currentSection === "project" : currentSection !== "project";
        return `<button class="management-space-option${active ? " active" : ""}" data-section-target="${esc(space.target)}" aria-current="${active ? "page" : "false"}">
          <strong>${esc(space.label)}</strong><span>${esc(space.meta)}</span>
        </button>`;
      }).join("")}</div>
    </section>`;
  }

  function progress(value) {
    const percent = Math.max(0, Math.min(100, Number(value) || 0));
    return `<div class="sidebar-progress" aria-label="进度 ${percent}%"><span style="width:${percent}%"></span></div>`;
  }

  function projectContext({project, projects = [], group = null, work = null, stats = {}, labels = {}} = {}) {
    if (!project) return "";
    return `<section class="sidebar-object-context" aria-label="当前对象">
      <span class="sidebar-eyebrow">当前项目</span>
      <select id="project-switcher" aria-label="当前项目">${projects.map((item) =>
        `<option value="${esc(item.id)}"${item.id === project.id ? " selected" : ""}>${esc(item.name || item.id)}${item.status === "archived" ? "（已归档 · 只读）" : ""}</option>`).join("")}</select>
      <div class="sidebar-project-state"><span>${esc(labels.projectStatus || project.status || "-")}</span><strong>${esc(project.progress?.percent ?? 0)}%</strong></div>
      ${progress(project.progress?.percent)}
      ${group ? `<div class="sidebar-object-card">
        <span class="sidebar-eyebrow">当前任务组</span>
        <button class="sidebar-object-name" data-focus-group="${esc(group.id)}" data-focus-page="tg">${esc(group.name || group.id)}</button>
        <div class="sidebar-project-state"><span>${esc(labels.groupStatus || group.goalExecutionStatus || group.status || "-")}</span><strong>${esc(group.progress ?? 0)}%</strong></div>
        ${progress(group.progress)}
        <div class="sidebar-object-counts"><span>任务 ${esc(stats.tasks ?? 0)}</span><span>运行 ${esc(stats.runs ?? 0)}</span><span>待审 ${esc(stats.reviews ?? 0)}</span><span>受阻 ${esc(stats.blocked ?? 0)}</span></div>
        <div class="sidebar-object-actions">
          <button data-focus-group="${esc(group.id)}" data-focus-page="tasks">任务</button>
          <button data-focus-group="${esc(group.id)}" data-focus-page="monitor">监控</button>
          <button data-focus-group="${esc(group.id)}" data-focus-page="review">审核</button>
          <button data-focus-group="${esc(group.id)}" data-focus-page="directives">指令</button>
        </div>
      </div>` : ""}
      ${work && group ? `<div class="sidebar-object-card sidebar-work-card">
        <span class="sidebar-eyebrow">当前任务</span>
        <button class="sidebar-object-name" data-open-work="${esc(work.id)}" data-work-group="${esc(group.id)}">${esc(work.title || work.id)}</button>
        <div class="sidebar-project-state"><span>${esc(labels.workStatus || work.status || "-")}</span><strong>${esc(work.progress ?? 0)}%</strong></div>
      </div>` : ""}
    </section>`;
  }

  global.AIMAC_CONTEXT_NAVIGATION = {managementSpaces, projectContext};
})(window);
