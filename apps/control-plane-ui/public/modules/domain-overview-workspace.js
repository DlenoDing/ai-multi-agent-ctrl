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
    "proj-settings": "项目仓库与默认配置",
    "group-detail": "当前任务组的任务、配置与执行记录"
  };

  const pageNotes = {
    "sys-orgs": ["系统管理员只管理组织状态、配额和初始组织管理员；组织子账户由组织管理员维护。", "停用组织会阻断其新增和执行入口，恢复后才可继续。"],
    "sys-settings": ["MCP、模型目录和技能源由服务器集中提供，Agent 节点不在本机重复部署服务。", "项目角色、Skill 覆盖和业务规则在对应项目内维护。"],
    "org-overview": ["组织空间管理成员、项目目录和共享 Agent；项目执行进入具体项目处理。"],
    "org-members": ["成员账号能力不能包含系统级或组织级通配权限。", "项目角色与任务组角色分别授权；一次性登录令牌使用后即失效。"],
    "org-projects": ["创建人自动成为项目负责人；项目角色和任务组角色在具体作用域内生效。", "项目归档是终态，归档前应先完成任务组收口。"],
    "org-agents": ["Agent 档案定义逻辑角色，运行节点提供实际执行能力，两者不是同一对象。", "组织共享节点可服务本组织项目；加入令牌和安装命令只在签发时显示一次。"],
    "proj-overview": ["总控自动拆解、选模型、匹配 Skill 和派发；人只处理入口配置、必要审核与纠偏。"],
    "proj-members": ["项目角色决定项目级能力，任务组角色只影响指定任务组。", "授权不会自动启动任务或扩大 Agent 的服务端权限。"],
    "proj-agents": ["项目可调配本项目 Agent 和本组织共享 Agent。", "节点只运行轻量 Runtime；远程 MCP 和按任务 Skill 由服务器下发。"],
    tg: ["任务组统一目标、语言和执行范围；组内任务由总控自动分析和派发。", "暂停、恢复、评审和纠偏都作用于明确任务组并保留审计。"],
    monitor: ["执行过程持续回送事件；页面实时状态不替代 Git 检查点和质量证据。", "先处理受阻和待审核项，模型、放置与准入记录用于进一步诊断。"],
    review: ["这里只处理必须由真人完成的确认、权限审批、危险操作和发现项。", "没有对应任务组审核权时只能查看，不能代替有权人员处置。"],
    directives: ["人工指令是给总控的结构化输入，不是向运行会话直接发送聊天消息。", "指令按任务组权限和状态机消费，拒绝原因与执行动作均保留。"],
    "proj-settings": ["这里定义任务组默认继承的项目配置；任务组有特殊要求时，只在对应任务组内覆盖。", "配置只影响后续派发和产出落地，不会静默改写正在执行的会话。"],
    "group-detail": ["任务组覆盖只作用于当前任务组，并优先于项目默认配置。", "执行控制、规则和协作记录都绑定当前对象，切换栏目不会改变作用域。"]
  };

  function row(item, pageId, h, primary = false) {
    const useWorkspaceRoute = pageId === "group-detail";
    const attributes = useWorkspaceRoute
      ? `data-workspace-page="group-detail" data-workspace="${h.esc(item.workspace)}"`
      : `data-menu="${h.esc(item.pageId)}" data-menu-workspace="${h.esc(item.workspace)}"`;
    return `<div class="domain-action-row">
      <div><strong>${h.esc(item.label)}</strong>${item.description ? `<span>${h.esc(item.description)}</span>` : ""}</div>
      <button class="icon-button domain-action-open${primary ? " primary" : ""}" ${attributes} title="打开${h.esc(item.label)}" aria-label="打开${h.esc(item.label)}">→</button>
    </div>`;
  }

  function render({pageId, title, items, helpers: h}) {
    const available = (items || []).filter((item) => item.workspace !== "help");
    const featuredOrder = featuredByPage[pageId] || available.slice(0, 4).map((item) => item.workspace);
    const featured = featuredOrder.map((workspace) => available.find((item) => item.workspace === workspace)).filter(Boolean);
    const featuredSet = new Set(featured.map((item) => item.workspace));
    const other = available.filter((item) => !featuredSet.has(item.workspace));
    const notes = pageNotes[pageId] || [];
    return h.panel("常用入口", `<div class="domain-overview" aria-label="${h.esc(title)}">
      <header class="domain-overview-header"><div><strong>${h.esc(pagePurpose[pageId] || "当前管理范围")}</strong></div>
        <span class="domain-overview-count">${available.length} 项功能</span></header>
      <div class="domain-action-list">${featured.map((item, index) => row(item, pageId, h, index === 0)).join("")}</div>
      ${other.length ? `<details class="domain-more"><summary>其他功能（${other.length}）</summary>
        <div class="domain-action-list">${other.map((item) => row(item, pageId, h)).join("")}</div></details>` : ""}
      ${notes.length ? `<div class="domain-notes"><strong>需要注意</strong><ul>${notes.map((note) => `<li>${h.esc(note)}</li>`).join("")}</ul></div>` : ""}
    </div>`, {wide: true});
  }

  global.AIMAC_DOMAIN_OVERVIEW_WORKSPACE = {render};
})(window);
