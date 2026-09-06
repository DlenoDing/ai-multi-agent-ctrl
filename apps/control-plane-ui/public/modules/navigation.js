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

  const leaf = (id, workspace, label, description, options = {}) => ({id, workspace, label, description, ...options});

  const PROJECT_MENU_TAIL = [
    {divider: "项目总览"},
    leaf("proj-overview", "overview", "项目概览", "总进度、健康度和当前下一步"),
    leaf("proj-overview", "activity", "最新执行", "近期执行事件与变化"),
    leaf("proj-overview", "outputs", "仓库产出", "项目 Git 产出归属"),
    {divider: "成员与权限"},
    leaf("proj-members", "list", "项目成员", "项目角色和成员详情"),
    leaf("proj-members", "add", "添加项目成员", "把组织成员加入当前项目", {requires: "project:grant"}),
    leaf("proj-members", "groups", "任务组权限", "按任务组分配控制、审核和观察"),
    leaf("proj-members", "grant-group", "授予任务组权限", "给成员分配当前任务组角色", {requires: "project:grant"}),
    {divider: "Agent"},
    leaf("proj-agents", "profiles", "Agent 档案", "项目专属与组织共享逻辑角色"),
    leaf("proj-agents", "create", "新建 Agent 档案", "创建当前项目专属逻辑角色", {requires: "agent:activate"}),
    leaf("proj-agents", "nodes", "运行节点", "项目专属与组织共享运行载体"),
    leaf("proj-agents", "register", "注册运行节点", "签发一次性令牌和安装脚本", {requires: "agent:activate"}),
    {divider: "工作推进"},
    leaf("tg", "list", "任务组", "任务组列表、进度与状态"),
    leaf("tg", "create", "新建任务组", "定义目标、角色和初始状态", {requires: "task_group:control"}),
    leaf("tasks", "list", "任务", "按时间倒序查看任务和执行详情"),
    leaf("tasks", "create", "新建任务", "向任务组增加工作项", {requires: "task_group:control"}),
    {divider: "执行观测"},
    leaf("monitor", "overview", "项目监控", "项目或任务组进度与异常"),
    leaf("monitor", "sessions", "工作会话", "持续多轮执行的会话状态"),
    leaf("monitor", "dispatches", "Agent 派发", "任务派发、进度、阻塞和结果"),
    leaf("monitor", "lanes", "执行载体", "可复用 Worker Lane 与当前会话"),
    leaf("monitor", "models", "模型决策", "实际模型、Agent 偏好和选型理由"),
    leaf("monitor", "placements", "会话放置", "新会话、子 Agent 与准入判定"),
    leaf("monitor", "admissions", "准入决策", "阶段门、容量和执行准入理由"),
    leaf("monitor", "events", "实时事件", "Agent 执行过程持续回送"),
    leaf("monitor", "node-control", "运行节点", "执行节点健康、准入和控制入口"),
    leaf("monitor", "commands", "控制命令", "暂停、恢复、取消和节点 ACK"),
    leaf("monitor", "dlq", "死信队列", "控制命令重试超限后的处置"),
    leaf("monitor", "checkpoints", "检查点证据", "Git 提交、推送和产出清单"),
    leaf("monitor", "quality", "质量门禁", "测试结果、质量门和人工豁免"),
    leaf("monitor", "finalizations", "人工定稿", "收尾裁决、责任人、时间和理由"),
    leaf("monitor", "barriers", "阻塞与门禁", "关闭阻塞、人工复核和死信"),
    {divider: "人工控制"},
    leaf("review", "pending", "待我审核", "执行方案与确认卡"),
    leaf("review", "permissions", "权限审批", "Agent 请求的临时权限与作用范围"),
    leaf("review", "approvals", "操作审批", "危险操作、阶段门和多方审批"),
    leaf("review", "findings", "发现处置", "评审发现、结论、状态和证据"),
    leaf("review", "history", "审核历史", "已完成的人定记录"),
    leaf("review", "inbox", "待办汇总", "当前账号可处理的全部待办"),
    leaf("directives", "compose", "下达指令", "向 AI 总控提交结构化控制输入", {requires: "task_group:control"}),
    leaf("directives", "history", "指令记录", "查看消费、拒绝和执行动作"),
    {divider: "项目治理"},
    leaf("proj-settings", "repositories", "仓库凭据", "仓库地址、账号密码或 API Key"),
    leaf("proj-settings", "baseline", "基线资料", "任务可引用的稳定输入"),
    leaf("proj-settings", "roles", "角色与 Skill", "默认角色和 Skill 定制"),
    leaf("proj-settings", "system-rules", "系统规则", "项目执行纪律和安全边界"),
    leaf("proj-settings", "business-rules", "业务规则", "项目业务约束"),
    {divider: "使用说明"},
    leaf("proj-overview", "help", "项目操作说明", "项目准备、执行与处置路径"),
    leaf("proj-members", "help", "项目授权说明", "项目角色与任务组权限边界"),
    leaf("proj-agents", "help", "Agent 运行说明", "档案、节点、注册与故障恢复"),
    leaf("tg", "help", "任务组说明", "生命周期、事项和处置方法"),
    leaf("monitor", "help", "监控链路说明", "实时回送、观测和异常处理"),
    leaf("review", "help", "审核流程说明", "确认、授权、发现与历史追溯"),
    leaf("directives", "help", "指令通道说明", "独立指令的下达与消费状态"),
    leaf("proj-settings", "help", "项目配置说明", "仓库、基线、角色和规则配置")
  ];

  const SYSTEM_MENU = [
    {divider: "平台运行"},
    leaf("sys-overview", "overview", "系统概览", "服务、资源和存储状态"),
    leaf("sys-overview", "audit", "审计日志", "系统操作与归档链"),
    leaf("sys-overview", "maintenance", "维护操作", "初始化与受控维护"),
    {divider: "组织治理"},
    leaf("sys-orgs", "list", "组织列表", "组织、初始管理员、启停和配额"),
    leaf("sys-orgs", "create", "开通组织", "创建组织与初始组织管理员"),
    {divider: "平台能力"},
    leaf("sys-settings", "runtime", "运行参数", "服务器运行参数和状态"),
    leaf("sys-settings", "models", "模型能力", "可调度模型能力目录"),
    leaf("sys-settings", "skills", "技能源", "服务端 Skill 源与同步状态"),
    leaf("sys-settings", "protocol", "调度协议", "指令压缩和共享定义归属"),
    {divider: "使用说明"},
    leaf("sys-orgs", "help", "组织治理说明", "系统侧组织、配额和初始管理员职责"),
    leaf("sys-settings", "help", "平台能力说明", "运行参数、模型、Skill 和协议边界")
  ];

  const ORG_MENU = [
    {divider: "组织总览"},
    leaf("org-overview", "overview", "组织概览", "配额、成员、项目与共享资源"),
    {divider: "成员与权限"},
    leaf("org-members", "list", "成员账户", "组织子账户和生命周期"),
    leaf("org-members", "create", "创建成员", "签发一次性登录凭据"),
    leaf("org-members", "grants", "权限矩阵", "成员的项目与任务组角色"),
    {divider: "项目目录"},
    leaf("org-projects", "list", "项目列表", "组织内项目状态和负责人"),
    leaf("org-projects", "create", "创建项目", "创建人自动成为项目负责人"),
    leaf("org-projects", "grants", "项目授权", "把组织成员加入项目"),
    {divider: "共享 Agent"},
    leaf("org-agents", "profiles", "共享 Agent 档案", "组织级逻辑角色"),
    leaf("org-agents", "create", "新建共享 Agent 档案", "创建可跨本组织项目调配的逻辑角色", {requires: "agent:activate"}),
    leaf("org-agents", "nodes", "共享运行节点", "组织级和项目级节点总览"),
    leaf("org-agents", "register", "注册共享运行节点", "组织范围的一次性接入"),
    leaf("org-agents", "tokens", "加入令牌", "待用、已用和已撤销令牌"),
    {divider: "使用说明"},
    leaf("org-overview", "help", "组织操作说明", "组织管理员的管理路径"),
    leaf("org-members", "help", "成员授权说明", "子账户、项目和任务组授权边界"),
    leaf("org-projects", "help", "项目治理说明", "项目创建、负责人和成员管理"),
    leaf("org-agents", "help", "共享 Agent 说明", "组织级档案、节点与接入范围")
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

  function menuMeta(perspective, pageId, workspace) {
    const item = allowedMenuItemsFor(perspective).find((entry) => !entry.divider && entry.id === pageId
      && (!entry.workspace || entry.workspace === workspace));
    return item ? [item.label, item.description || ""] : PAGE_META[pageId] || ["管理后台", ""];
  }

  function contextualMenuMeta(perspective, pageId, workspace, context = {}) {
    const base = menuMeta(perspective, pageId, workspace);
    if (pageId === "sys-orgs" && context.organization) return ["组织详情", "组织状态、初始管理员、配额与子账户构成"];
    if (pageId === "org-members" && context.orgMember) return ["成员详情", "账号生命周期、项目角色和任务组角色"];
    if (pageId === "proj-members" && context.projectMember) return ["项目成员详情", "项目角色、任务组权限和成员移出"];
    if (["org-agents", "proj-agents"].includes(pageId) && context.agentProfile) return ["Agent 档案详情", "执行角色、作用范围、模型偏好和 Skill"];
    if (["org-agents", "proj-agents"].includes(pageId) && context.runtimeNode) return ["运行节点详情", "节点身份、准入状态、当前任务和控制记录"];
    if (pageId === "monitor" && context.executionObject) return [context.executionType === "session" ? "执行会话详情" : "Agent 派发详情",
      "执行身份、模型决策、事件、仓库产出和控制状态"];
    if (pageId === "tg" && context.taskGroupObject) return ["任务组详情", "任务、进度、角色规则、执行控制和协作记录"];
    if (pageId === "tasks" && context.workObject) return ["任务详情", "执行顺序、Agent、角色、规则、结果与证据"];
    if (!context.taskGroupScope) return base;
    const scopedTitles = {
      tasks: {list: "任务组任务", create: "任务组新建任务"},
      monitor: {overview: "任务组监控", sessions: "任务组工作会话", dispatches: "任务组 Agent 派发", lanes: "任务组执行载体", models: "任务组模型决策", placements: "任务组会话放置", admissions: "任务组准入决策", events: "任务组实时事件", "node-control": "任务组运行节点", commands: "任务组控制命令", dlq: "任务组死信队列", checkpoints: "任务组检查点证据", quality: "任务组质量门禁", finalizations: "任务组人工定稿", barriers: "任务组阻塞与门禁", help: "任务组监控说明"},
      review: {pending: "任务组待审核", permissions: "任务组权限审批", approvals: "任务组操作审批", findings: "任务组发现处置", history: "任务组审核历史", inbox: "任务组待办汇总", help: "任务组审核说明"},
      directives: {compose: "任务组下达指令", history: "任务组指令记录", help: "任务组指令说明"}
    };
    const title = scopedTitles[pageId]?.[workspace];
    return title ? [title, `当前任务组范围 · ${base[1]}`] : base;
  }

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
    const description = item.description || "";
    return `
      <button class="nav-item nav-leaf ${active ? "active" : ""}" data-menu="${esc(item.id)}" data-menu-workspace="${esc(item.workspace || "")}" aria-current="${active ? "page" : "false"}">
        <span class="nav-item-main">
          <span class="nav-item-title">${esc(item.label)}</span>
          ${todo.count ? `<span class="nav-badge">${todo.count}${todo.capped ? "+" : ""}</span>` : ""}
        </span>
        ${description ? `<span class="nav-item-desc">${esc(description)}</span>` : ""}
      </button>
    `;
  }

  function menuGroups(items) {
    const groups = [];
    let current = {label: "功能", items: []};
    for (const item of items) {
      if (item.divider) {
        if (current.items.length) groups.push(current);
        current = {label: item.divider, items: []};
      } else current.items.push(item);
    }
    if (current.items.length) groups.push(current);
    return groups;
  }

  function desktopMenuHtml(items, pageId, workspace, todoFor) {
    return menuGroups(items).map((group) => {
      const active = group.items.some((item) => item.id === pageId && item.workspace === workspace);
      return `<details class="nav-group"${active ? " open" : ""}>
        <summary class="nav-group-summary"><span>${esc(group.label)}</span><span class="nav-group-count">${group.items.length}</span></summary>
        <div class="nav-group-items">${group.items.map((item) => menuItemHtml(item,
          item.id === pageId && item.workspace === workspace, todoFor(item))).join("")}</div>
      </details>`;
    }).join("");
  }

  function mobileMenuHtml(items, pageId, workspace) {
    const groups = menuGroups(items);
    return `<label class="mobile-function-picker"><span>当前功能</span><select data-menu-select aria-label="当前功能">${groups.map((group) =>
      `<optgroup label="${esc(group.label)}">${group.items.map((item) => `<option value="${esc(`${item.id}|${item.workspace || ""}`)}"${item.id === pageId && item.workspace === workspace ? " selected" : ""}>${esc(item.label)}</option>`).join("")}</optgroup>`).join("")}</select></label>`;
  }

  global.AIMAC_CONSOLE_NAV = {
    PROJECT_PAGES,
    PROJECT_MENU_TAIL,
    SYSTEM_MENU,
    ORG_MENU,
    MENUS,
    PAGE_META,
    menuMeta,
    contextualMenuMeta,
    perspectiveOf,
    defaultPageFor,
    primarySectionPageFor,
    allowedMenuItemsFor,
    managementSectionOf,
    menuForCurrentSection,
    sectionLabel,
    sectionSwitchHtml,
    menuItemHtml,
    desktopMenuHtml,
    mobileMenuHtml
  };
})(window);
