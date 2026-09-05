(function () {
  "use strict";
  const {esc} = window.AIMAC_CONSOLE_DOM_UTILS;
  const pane = (id, label, titles = []) => ({id, label, titles});
  const catalog = {
    "group-detail": [pane("tasks", "任务列表", ["工作项*"]), pane("progress", "事项与进度", ["事项清单", "任务执行时间线", "准入与阻断分类", "阻塞"]), pane("config", "角色与规则", ["角色列表", "配置（继承 / 自定义）", "本任务组角色 Skill 定制", "系统规则（默认 / 项目 / 任务组）", "业务规则（默认 / 项目 / 任务组）"]), pane("control", "执行控制", ["执行控制"]), pane("collaboration", "协作记录", ["协作记录*"]), pane("help", "详情说明")],
    "sys-overview": [pane("overview", "运行状态"), pane("audit", "审计日志", ["审计日志"]), pane("maintenance", "维护操作", ["维护操作"])],
    "sys-orgs": [pane("list", "组织列表", ["组织列表"]), pane("create", "开通组织", ["创建组织"]), pane("help", "职责与配额说明")],
    "sys-settings": [pane("runtime", "运行参数", ["运行参数（只读）", "系统设置总览"]), pane("models", "模型能力", ["模型能力注册（只读）"]), pane("skills", "技能源", ["技能源", "角色技能叠加（改动 agent 能力，只读）"]), pane("protocol", "调度协议与契约", ["指令压缩指标", "共享定义归属"]), pane("help", "能力说明")],
    "org-overview": [pane("overview", "组织概况"), pane("help", "组织操作说明", ["组织操作路径"])],
    "org-members": [pane("list", "成员列表", ["成员列表"]), pane("create", "创建成员", ["创建成员"]), pane("grants", "权限矩阵", ["子账户项目 / 任务组权限矩阵"]), pane("help", "授权说明")],
    "org-projects": [pane("list", "项目列表", ["项目列表"]), pane("create", "创建项目", ["创建项目"]), pane("grants", "项目授权", ["项目成员授权"]), pane("help", "项目治理说明")],
    "org-agents": [pane("nodes", "运行节点", ["agent 节点"]), pane("register", "注册共享节点", ["注册组织 agent"]), pane("profiles", "角色档案", ["组织级 Agent 档案"]), pane("tokens", "加入令牌", ["加入令牌审计"]), pane("help", "接入与管理说明")],
    "proj-agents": [pane("nodes", "运行节点", ["项目 agent 节点"]), pane("register", "注册项目节点", ["注册 agent"]), pane("profiles", "可调配角色", ["可调配 Agent 档案"]), pane("help", "接入与运行说明")],
    "proj-overview": [pane("overview", "项目概况", ["项目概况", "关键指标", "任务组一览"]), pane("activity", "最新执行", ["最新执行事件"]), pane("outputs", "仓库产出", ["仓库产出归属概览", "仓库产出归属"]), pane("help", "准备与操作", ["流程导航"])],
    "proj-members": [pane("list", "项目成员", ["项目成员列表", "项目成员授权"]), pane("groups", "任务组权限", ["任务组权限列表", "任务组权限授权"]), pane("help", "授权说明")],
    "proj-settings": [pane("repositories", "仓库与凭据", ["项目基础配置", "规则配置"]), pane("baseline", "基线资料", ["基线资料"]), pane("roles", "角色与 Skill", ["项目默认角色", "角色 Skill 定制"]), pane("system-rules", "系统规则", ["系统规则"]), pane("business-rules", "业务规则", ["业务规则"]), pane("help", "配置说明")],
    tg: [pane("list", "任务组列表", ["任务组列表", "任务组详情"]), pane("create", "创建任务组", ["创建任务组"]), pane("help", "任务组说明", ["任务组总览", "任务组处置看板", "任务组生命周期", "创建工作项"])],
    tasks: [pane("list", "任务工作台", ["任务工作台", "任务详情"]), pane("create", "创建任务", ["创建工作项"])],
    monitor: [pane("overview", "进度总览", ["执行监控", "执行监控总览", "任务组监控矩阵", "自治控制"]), pane("runs", "执行会话", ["工作会话", "智能体派发", "可复用执行载体（Worker Lane）", "模型选择记录", "会话放置记录"]), pane("events", "实时事件", ["实时事件流"]), pane("nodes", "节点与控制", ["控制通道", "agent 节点"]), pane("evidence", "产出与验收", ["检查点（Git 证据）", "质量门禁 / 测试证据", "最近的人工定稿"]), pane("barriers", "阻塞与复核"), pane("help", "监控说明", ["监控处置看板", "实时回送链路"])],
    review: [pane("pending", "待我审核", ["人工审核", "待人工确认"]), pane("decisions", "授权与复核", ["授权与处置"]), pane("history", "审核历史", ["已答历史"]), pane("inbox", "待办汇总", ["待你处理*"]), pane("help", "审核说明")],
    directives: [pane("compose", "下达指令", ["下达人工指令", "人工指令"]), pane("history", "指令流水", ["指令流水"]), pane("help", "指令说明")]
  };
  const fallback = {"sys-orgs": "help", "sys-settings": "help", "org-members": "help", "org-projects": "help", "org-agents": "help", "proj-agents": "help", "proj-members": "help", "proj-settings": "help", tasks: "discard", monitor: "barriers", review: "help", directives: "help"};
  let selections = {};
  try { selections = JSON.parse(sessionStorage.getItem("aimac.workspaces") || "{}"); } catch {}
  let context = null;

  function current(page) {
    const entries = catalog[page] || [];
    return entries.find((entry) => entry.id === selections?.[page]) || entries[0] || null;
  }

  function select(page, id) {
    if (!(catalog[page] || []).some((entry) => entry.id === id)) return false;
    selections = {...selections, [page]: id};
    sessionStorage.setItem("aimac.workspaces", JSON.stringify(selections));
    return true;
  }

  function owner(page, title) {
    const entries = catalog[page] || [];
    const found = entries.find((entry) => entry.titles.some((value) => value.endsWith("*") ? title.startsWith(value.slice(0, -1)) : value === title));
    return found?.id || fallback[page] || entries[0]?.id;
  }

  function allows(title) {
    return !context || !catalog[context.page] || owner(context.page, title) === current(context.page)?.id;
  }

  function run(page, renderer) {
    const previous = context;
    context = {page};
    try { return renderer(); } finally { context = previous; }
  }

  function showGuide() { return !context || !catalog[context.page] || current(context.page)?.id === "help"; }
  function showHub() { return !context || ["overview", "list"].includes(current(context.page)?.id || "overview"); }

  function navigation(page, mobile = false, options = {}) {
    const entries = (catalog[page] || []).filter((entry) => options.canCreate !== false || !["create", "register"].includes(entry.id));
    if (!entries.length) return "";
    return `<div class="${mobile === "inline" ? "workspace-detail-nav" : mobile ? "workspace-mobile-nav" : "workspace-nav"}" aria-label="功能栏目">${entries.map((entry) =>
      `<button class="workspace-nav-item${current(page)?.id === entry.id ? " active" : ""}" data-workspace-page="${esc(page)}" data-workspace="${esc(entry.id)}" aria-current="${current(page)?.id === entry.id ? "page" : "false"}">${esc(entry.label)}</button>`).join("")}</div>`;
  }

  function heading(page, options = {}) {
    const entry = current(page);
    if (!entry) return "";
    return entry.titles.includes(entry.label) ? "" : `<div class="workspace-heading"><h2>${esc(entry.label)}</h2></div>`;
  }

  window.AIMAC_WORKSPACES = {catalog, current, select, owner, allows, run, showGuide, showHub, navigation, heading};
})();
