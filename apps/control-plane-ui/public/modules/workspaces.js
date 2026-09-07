(function () {
  "use strict";
  const {esc} = window.AIMAC_CONSOLE_DOM_UTILS;
  const pane = (id, label, titles = [], group = "") => ({id, label, titles, group});
  const catalog = {
    // 任务组详情：4 个栏目。此前 12 个栏目分 3 组，展开一个任务组要先在左侧一列里找栏目 —— 人来任务组是看任务、看执行、改配置。
    "group-detail": [
      pane("tasks", "任务与进度", ["任务*", "事项清单", "任务执行时间线"]),
      pane("config", "角色与规则", ["角色列表", "配置继承", "角色 Skill 定制", "系统规则", "业务规则"]),
      pane("control", "执行控制", ["执行控制", "准入与阻断分类", "阻塞"]),
      pane("collaboration", "协作记录", ["协作记录*"]),
      pane("help", "详情说明", [])
    ],
    "sys-overview": [pane("overview", "运行状态"), pane("details", "技术状态", ["运行指标", "服务器信息", "资源占用", "能耗估算", "存储体量", "系统服务"]), pane("audit", "审计日志", ["审计日志"]), pane("maintenance", "维护操作", ["维护操作"])],
    "sys-orgs": [pane("list", "组织列表", ["组织列表"]), pane("create", "开通组织", ["创建组织"]), pane("help", "职责与配额说明")],
    "sys-settings": [pane("runtime", "运行参数", ["运行参数（只读）"]), pane("models", "模型能力", ["模型能力注册（只读）"]), pane("skills", "技能源", ["技能源"]), pane("instruction-efficiency", "指令效率", ["指令压缩指标"]), pane("envelopes", "指令信封", ["指令信封"]), pane("definitions", "共享定义", ["共享定义归属"]), pane("upgrade-imports", "外部升级导入", ["外部升级导入"]), pane("help", "能力说明", ["系统设置总览"])],
    "org-overview": [pane("overview", "组织概况"), pane("help", "组织操作说明", ["组织操作路径"])],
    "org-members": [pane("list", "成员列表", ["成员列表"]), pane("create", "创建成员", ["创建成员"]), pane("grants", "权限矩阵", ["子账户项目 / 任务组权限矩阵"]), pane("help", "授权说明")],
    "org-projects": [pane("list", "项目列表", ["项目列表"]), pane("create", "创建项目", ["创建项目"]), pane("grants", "项目授权", ["项目成员授权"]), pane("help", "项目治理说明")],
    "org-agents": [pane("profiles", "共享 Agent 档案", ["组织级 Agent 档案"]), pane("create", "新建共享 Agent 档案", ["创建组织级 Agent 档案"]), pane("nodes", "共享运行节点", ["运行节点"]), pane("register", "注册共享运行节点", ["注册共享运行节点"]), pane("tokens", "加入令牌", ["加入令牌审计"]), pane("help", "接入与管理说明")],
    "proj-agents": [pane("profiles", "Agent 档案", ["可调配 Agent 档案"]), pane("create", "新建 Agent 档案", ["创建项目级 Agent 档案"]), pane("nodes", "运行节点", ["项目运行节点"]), pane("register", "注册运行节点", ["注册运行节点"]), pane("help", "接入与运行说明")],
    "proj-overview": [pane("overview", "项目概况", ["项目概况", "关键指标", "任务组一览"]), pane("activity", "最新执行", ["最新执行事件"]), pane("outputs", "仓库产出", ["仓库产出归属概览", "仓库产出归属"]), pane("help", "准备与操作", ["流程导航"])],
    "proj-members": [pane("list", "项目成员", ["项目成员列表"]), pane("add", "添加项目成员", ["项目成员授权"]), pane("groups", "任务组权限", ["任务组权限列表"]), pane("grant-group", "授予任务组权限", ["任务组权限授权"]), pane("help", "授权说明")],
    // 项目设置：仓库与基线 / 角色与 Skill / 规则。此前六个分项各占一个栏目（还各占一行侧栏）。
    "proj-settings": [pane("repositories", "仓库与基线", ["项目基础配置", "基线资料"]), pane("roles", "角色与 Skill", ["项目默认角色", "角色 Skill 定制"]),
      pane("rules", "规则", ["系统规则", "业务规则"]), pane("help", "配置说明")],
    tg: [pane("list", "任务组列表", ["任务组列表", "任务组详情"]), pane("create", "创建任务组", ["创建任务组"]), pane("help", "任务组说明", ["任务组总览", "任务组处置看板", "任务组生命周期", "创建任务"])],
    tasks: [pane("list", "任务工作台", ["任务工作台", "任务详情"]), pane("create", "创建任务", ["创建任务"])],
    // 执行监控：5 个栏目。此前 16 个栏目（会话/派发/载体/模型/放置/准入/事件/节点/命令/死信/检查点/质量/定稿/阻塞/关闭门）
    // 一字排开；按人要回答的问题合并：跑到哪了 / 谁在跑、为什么这么派 / 过程回送 / 载体与命令 / 收得了口吗。
    monitor: [pane("overview", "进度总览", ["执行监控", "执行监控总览", "任务组监控矩阵", "自治控制"]),
      pane("execution", "会话与派发", ["工作会话", "智能体派发", "可复用执行载体（Worker Lane）", "模型选择记录", "会话放置记录", "准入决策"]),
      pane("events", "实时事件", ["实时事件流"]),
      pane("nodes", "节点与命令", ["运行节点", "控制通道", "死信队列"]),
      pane("acceptance", "验收与收口", ["检查点（Git 证据）", "质量门禁 / 测试证据", "最近的人工定稿", "阻塞项人工处置", "关闭门禁"]),
      pane("help", "监控说明", ["监控处置看板", "实时回送链路"])],
    // 人工审核：待办处理（汇总）/ 待我审核（确认卡）/ 审批与处置（权限审批 · 操作审批 · 发现处置）/ 审核历史。
    review: [pane("inbox", "待办处理", ["待你处理*"]), pane("pending", "待我审核", ["人工审核", "待人工确认"]),
      pane("dispositions", "审批与处置", ["权限审批", "操作审批", "发现处置"]), pane("history", "审核历史", ["已答历史"]), pane("help", "审核说明")],
    directives: [pane("compose", "下达指令", ["下达人工指令", "人工指令"]), pane("history", "指令流水", ["指令流水"]), pane("help", "指令说明")]
  };
  const fallback = {"sys-orgs": "help", "sys-settings": "help", "org-members": "help", "org-projects": "help", "org-agents": "help", "proj-agents": "help", "proj-members": "help", "proj-settings": "help", tasks: "discard", monitor: "barriers", review: "help", directives: "help"};
  const legacyPaneAliases = {"sys-settings:protocol": "instruction-efficiency", "group-detail:config": "config", "group-detail:progress": "tasks", "group-detail:timeline": "tasks", "group-detail:roles": "config", "group-detail:inheritance": "config", "group-detail:skills": "config", "group-detail:system-rules": "config", "group-detail:business-rules": "config", "group-detail:admission": "control", "group-detail:blockers": "control", "monitor:runs": "execution", "monitor:sessions": "execution", "monitor:dispatches": "execution", "monitor:lanes": "execution", "monitor:models": "execution", "monitor:placements": "execution", "monitor:admissions": "execution", "monitor:nodes": "nodes", "monitor:node-control": "nodes", "monitor:commands": "nodes", "monitor:dlq": "nodes", "monitor:evidence": "acceptance", "monitor:checkpoints": "acceptance", "monitor:quality": "acceptance", "monitor:finalizations": "acceptance", "monitor:barriers": "acceptance", "monitor:blockers": "acceptance", "monitor:close-gates": "acceptance", "review:decisions": "dispositions", "review:permissions": "dispositions", "review:approvals": "dispositions", "review:findings": "dispositions", "proj-settings:baseline": "repositories", "proj-settings:default-roles": "roles", "proj-settings:skills": "roles", "proj-settings:system-rules": "rules", "proj-settings:business-rules": "rules"};
  const storagePrefix = "aimac.workspaces";
  let accountId = "";
  let selections = {};
  let context = null;

  function storageKey() {
    return accountId ? `${storagePrefix}:${accountId}` : "";
  }

  function readSelections() {
    const key = storageKey();
    if (!key) return {};
    try {
      const value = JSON.parse(sessionStorage.getItem(key) || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }

  function setAccount(nextAccountId) {
    accountId = String(nextAccountId || "").slice(0, 256);
    selections = readSelections();
  }

  function current(page) {
    const entries = catalog[page] || [];
    const selected = legacyPaneAliases[`${page}:${selections?.[page]}`] || selections?.[page];
    return entries.find((entry) => entry.id === selected) || entries[0] || null;
  }

  function resolve(page, id) {
    const target = legacyPaneAliases[`${page}:${id}`] || id;
    return (catalog[page] || []).some((entry) => entry.id === target) ? target : "";
  }

  function select(page, id) {
    id = legacyPaneAliases[`${page}:${id}`] || id;
    if (!(catalog[page] || []).some((entry) => entry.id === id)) return false;
    selections = {...selections, [page]: id};
    const key = storageKey();
    if (key) sessionStorage.setItem(key, JSON.stringify(selections));
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

  // 动作型栏目（注册 / 创建 / 添加 / 授予）不进栏目条：停在这些栏目时高亮它所属的父栏目（注册节点→运行节点、授予任务组权限→任务组权限、
  // 添加成员→列表、创建→本页第一个栏目），否则整条栏目条没有任何一项亮着，人不知道自己在哪。
  const ACTION_PANES = new Set(["create", "add", "grant-group", "register"]);
  function activePane(page) {
    const id = current(page)?.id || "";
    if (!ACTION_PANES.has(id)) return id;
    const entries = catalog[page] || [];
    const has = (target) => entries.some((entry) => entry.id === target);
    if (id === "register" && has("nodes")) return "nodes";
    if (id === "grant-group" && has("groups")) return "groups";
    return entries.find((entry) => !ACTION_PANES.has(entry.id) && entry.id !== "help")?.id || id;
  }

  function navigation(page, mobile = false, options = {}) {
    const entries = (catalog[page] || []).filter((entry) => entry.id !== "help"
      && !["create", "add", "grant-group", "register"].includes(entry.id)
      && (options.canCreate !== false || !["create", "register"].includes(entry.id)));
    if (!entries.length) return "";
    const active = activePane(page);
    if (mobile === true) {
      return `<label class="workspace-mobile-picker"><span>当前栏目</span><select data-workspace-select data-workspace-page="${esc(page)}">${entries.map((entry) =>
        `<option value="${esc(entry.id)}"${active === entry.id ? " selected" : ""}>${esc(entry.label)}</option>`).join("")}</select></label>`;
    }
    return `<div class="${mobile === "inline" ? "workspace-detail-nav" : mobile ? "workspace-mobile-nav" : "workspace-nav"}" aria-label="功能栏目">${entries.map((entry) =>
      `<button class="workspace-nav-item${active === entry.id ? " active" : ""}" data-workspace-page="${esc(page)}" data-workspace="${esc(entry.id)}" aria-current="${active === entry.id ? "page" : "false"}">${esc(entry.label)}</button>`).join("")}</div>`;
  }

  function objectNavigation(page, options = {}) {
    const entries = (catalog[page] || []).filter((entry) => entry.id !== "help"
      && !["create", "add", "grant-group", "register"].includes(entry.id)
      && (options.canCreate !== false || !["create", "register"].includes(entry.id)));
    if (!entries.length) return "";
    const active = activePane(page);
    const item = (entry) => `<button class="object-section-nav-item${active === entry.id ? " active" : ""}" data-workspace-page="${esc(page)}" data-workspace="${esc(entry.id)}" aria-current="${active === entry.id ? "page" : "false"}">${esc(entry.label)}</button>`;
    const groups = [];
    for (const entry of entries) {
      const label = entry.group || "对象功能";
      const group = groups.at(-1);
      if (!group || group.label !== label) groups.push({label, entries: [entry]});
      else group.entries.push(entry);
    }
    const desktop = entries.some((entry) => entry.group)
      ? groups.map((group) => `<section class="object-section-group"><div class="object-section-group-title">${esc(group.label)}</div>${group.entries.map(item).join("")}</section>`).join("")
      : entries.map(item).join("");
    return `<nav class="object-section-nav" aria-label="当前对象功能">${desktop}</nav>${navigation(page, true, options)}`;
  }

  function heading(page, options = {}) {
    const entry = current(page);
    if (!entry) return "";
    return entry.titles.includes(entry.label) ? "" : `<div class="workspace-heading"><h2>${esc(entry.label)}</h2></div>`;
  }

  window.AIMAC_WORKSPACES = {catalog, current, select, resolve, activePane, setAccount, owner, allows, run, showGuide, showHub, navigation, objectNavigation, heading};
})();
