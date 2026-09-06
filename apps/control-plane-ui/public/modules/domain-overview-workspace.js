(function initDomainOverviewWorkspace(global) {
  "use strict";

  const featuredByPage = {
    "sys-orgs": ["list", "create"],
    "sys-settings": ["runtime", "models", "skills", "envelopes"],
    "org-overview": ["overview"],
    "org-members": ["list", "grants", "create"],
    "org-projects": ["list", "grants", "create"],
    "org-agents": ["profiles", "nodes", "register"],
    "proj-overview": ["overview", "activity", "outputs"],
    "proj-members": ["list", "groups", "add"],
    "proj-agents": ["profiles", "nodes", "register"],
    tg: ["list", "create"],
    monitor: ["overview", "dispatches", "events", "blockers"],
    review: ["inbox", "pending", "permissions", "findings"],
    directives: ["compose", "history"],
    "proj-settings": ["repositories", "skills", "system-rules", "business-rules"],
    "group-detail": ["tasks", "timeline", "control", "blockers"]
  };

  const pagePurpose = {
    "sys-orgs": "组织、初始管理员与配额",
    "sys-settings": "平台运行和 AI 调度能力",
    "org-overview": "组织资源与项目状态",
    "org-members": "成员生命周期和授权范围",
    "org-projects": "项目目录与成员落位",
    "org-agents": "组织共享 Agent 与运行节点",
    "proj-overview": "项目进度、异常与产出",
    "proj-members": "项目成员和任务组权限",
    "proj-agents": "可调配 Agent 与运行节点",
    tg: "任务组进度和执行控制",
    monitor: "实时执行、异常和证据",
    review: "等待当前账号处理的事项",
    directives: "提交和追踪结构化人工指令",
    "proj-settings": "仓库、角色、Skill 与规则",
    "group-detail": "当前任务组的任务、配置与执行记录"
  };

  function row(item, pageId, h, primary = false) {
    const useWorkspaceRoute = pageId === "group-detail";
    const attributes = useWorkspaceRoute
      ? `data-workspace-page="group-detail" data-workspace="${h.esc(item.workspace)}"`
      : `data-menu="${h.esc(item.pageId)}" data-menu-workspace="${h.esc(item.workspace)}"`;
    return `<div class="domain-action-row">
      <div><strong>${h.esc(item.label)}</strong>${item.description ? `<span>${h.esc(item.description)}</span>` : ""}</div>
      <button class="${primary ? "primary-button" : "secondary-button"}" ${attributes}>打开</button>
    </div>`;
  }

  function render({pageId, title, items, helpers: h}) {
    const available = (items || []).filter((item) => item.workspace !== "help");
    const featuredOrder = featuredByPage[pageId] || available.slice(0, 4).map((item) => item.workspace);
    const featured = featuredOrder.map((workspace) => available.find((item) => item.workspace === workspace)).filter(Boolean);
    const featuredSet = new Set(featured.map((item) => item.workspace));
    const other = available.filter((item) => !featuredSet.has(item.workspace));
    return h.panel("常用入口", `<div class="domain-overview">
      <header class="domain-overview-header"><div><strong>${h.esc(title)}</strong><span>${h.esc(pagePurpose[pageId] || "当前管理范围")}</span></div>
        <span class="domain-overview-count">${available.length} 项功能</span></header>
      <div class="domain-action-list">${featured.map((item, index) => row(item, pageId, h, index === 0)).join("")}</div>
      ${other.length ? `<details class="domain-more"><summary>其他功能（${other.length}）</summary>
        <div class="domain-action-list">${other.map((item) => row(item, pageId, h)).join("")}</div></details>` : ""}
    </div>`, {wide: true});
  }

  global.AIMAC_DOMAIN_OVERVIEW_WORKSPACE = {render};
})(window);
