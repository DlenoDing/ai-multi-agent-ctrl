/*
 * 控制台视角、菜单与页面元数据。
 * PAGE_META 是页面标题、页头副标题和菜单说明的单一真相源。
 */
(function initNavigation(global) {
  const esc = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

  const PROJECT_PAGES = new Set(["proj-overview", "proj-members", "tg", "tasks", "review", "directives", "monitor", "proj-agents", "proj-settings"]);

  const PROJECT_MENU_TAIL = [
    {divider: "项目总览"},
    {id: "proj-overview", label: "项目概览"},
    {divider: "准备与接入"},
    {id: "proj-members", label: "成员权限"},
    {id: "proj-agents", label: "项目 Agent"},
    {divider: "执行推进"},
    {id: "tg", label: "任务组"},
    {id: "tasks", label: "任务工作台"},
    {id: "monitor", label: "执行监控"},
    {divider: "人工控制"},
    {id: "review", label: "人工审核"},
    {id: "directives", label: "人工指令"},
    {divider: "治理配置"},
    {id: "proj-settings", label: "项目设置"}
  ];

  const SYSTEM_MENU = [
    {id: "sys-overview", label: "系统概览"},
    {id: "sys-orgs", label: "组织管理"},
    {id: "sys-settings", label: "系统设置"}
  ];

  const ORG_MENU = [
    {id: "org-overview", label: "组织概览"},
    {id: "org-members", label: "成员管理"},
    {id: "org-agents", label: "共享 Agent"},
    {id: "org-projects", label: "项目列表"}
  ];

  const MENUS = {
    system: SYSTEM_MENU,
    org: ORG_MENU,
    user: [...PROJECT_MENU_TAIL]
  };

  const PAGE_META = {
    "sys-overview": ["系统概览", "服务器信息、资源占用、能耗估算、存储体量与运行指标"],
    "sys-orgs": ["组织管理", "组织列表、配额与用量、创建组织并签发初始组织管理员账号"],
    "sys-settings": ["系统设置", "运行参数只读展示、模型能力注册、技能源与指令协议"],
    "org-overview": ["组织概览", "配额用量、活跃项目与任务组统计"],
    "org-members": ["成员管理", "创建成员、权限分配、停用与一次性登录令牌"],
    "org-agents": ["共享 Agent", "组织级 Agent 档案、共享运行节点、注册与令牌治理"],
    "org-projects": ["项目列表", "创建项目、基础配置与成员授权"],
    "proj-overview": ["项目概览", "总进度、健康度、任务组平均进度与待人工确认数"],
    "proj-members": ["成员权限", "当前项目成员、角色授权、任务组控制与审核权限入口"],
    "tg": ["任务组", "事项清单、角色、配置继承与执行控制"],
    "tasks": ["任务工作台", "任务列表、执行过程、角色规则与结果证据"],
    "review": ["人工审核", "集中处理执行过程中提交的人工确认请求"],
    "directives": ["人工指令", "通过独立通道向系统下达结构化指令"],
    "monitor": ["执行监控", "会话、派发、控制通道与实时执行事件流"],
    "proj-agents": ["项目 Agent", "项目专属档案、可调配共享档案、运行节点与注册控制"],
    "proj-settings": ["项目设置", "仓库与访问凭据、基线数据、规则与默认角色"]
  };

  function perspectiveOf(account) {
    if (!account) return "user";
    if (account.accountType === "system_admin" || (account.permissions || []).includes("system:*")) return "system";
    if (account.accountType === "org_admin") return "org";
    return "user";
  }

  function defaultPageFor(perspective) {
    if (perspective === "system") return "sys-overview";
    if (perspective === "org") return "org-overview";
    return "proj-overview";
  }

  function primarySectionPageFor(perspective) {
    if (perspective === "system") return "sys-overview";
    if (perspective === "org") return "org-overview";
    return "proj-overview";
  }

  function allowedMenuItemsFor(perspective) {
    if (perspective === "system") return [...SYSTEM_MENU, ...PROJECT_MENU_TAIL];
    if (perspective === "org") return [...ORG_MENU, ...PROJECT_MENU_TAIL];
    return [...PROJECT_MENU_TAIL];
  }

  function managementSectionOf(pageId, perspective) {
    if (PROJECT_PAGES.has(pageId)) return "project";
    if (perspective === "system") return "system";
    if (perspective === "org") return "org";
    return "project";
  }

  function menuForCurrentSection(perspective, pageId) {
    const section = managementSectionOf(pageId, perspective);
    if (section === "project") return PROJECT_MENU_TAIL;
    if (section === "org") return ORG_MENU;
    return SYSTEM_MENU;
  }

  function sectionLabel(perspective, pageId) {
    const section = managementSectionOf(pageId, perspective);
    if (section === "project") return "项目管理";
    if (section === "org") return "组织管理";
    return "系统管理";
  }

  function sectionSwitchHtml(perspective, pageId) {
    if (perspective === "user") return "";
    const current = managementSectionOf(pageId, perspective);
    const primaryLabel = perspective === "system" ? "系统管理" : "组织管理";
    const primaryPage = primarySectionPageFor(perspective);
    const item = (target, label, active) =>
      `<button class="section-tab ${active ? "active" : ""}" data-section-target="${esc(target)}">${esc(label)}</button>`;
    return `<div class="section-switch" aria-label="管理空间">`
      + item(primaryPage, primaryLabel, current !== "project")
      + item("proj-overview", "项目管理", current === "project")
      + "</div>";
  }

  function menuItemHtml(item, active, todo) {
    const meta = PAGE_META[item.id] || [item.label, ""];
    const description = meta[1] || "";
    return `
      <button class="nav-item ${active ? "active" : ""}" data-menu="${esc(item.id)}">
        <span class="nav-item-main">
          <span class="nav-item-title">${esc(item.label)}</span>
          ${todo.count ? `<span class="nav-badge">${todo.count}${todo.capped ? "+" : ""}</span>` : ""}
        </span>
        ${description ? `<span class="nav-item-desc">${esc(description)}</span>` : ""}
      </button>
    `;
  }

  global.AIMAC_CONSOLE_NAV = {
    PROJECT_PAGES,
    PROJECT_MENU_TAIL,
    SYSTEM_MENU,
    ORG_MENU,
    MENUS,
    PAGE_META,
    perspectiveOf,
    defaultPageFor,
    primarySectionPageFor,
    allowedMenuItemsFor,
    managementSectionOf,
    menuForCurrentSection,
    sectionLabel,
    sectionSwitchHtml,
    menuItemHtml
  };
})(window);
