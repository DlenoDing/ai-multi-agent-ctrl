#!/usr/bin/env node
// Focused workspace contract checks for the split management UI.
//
// These tests deliberately exercise the real workspaces catalog and filtering
// helpers. They do not switch the application into an all-panels mode.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "apps/control-plane-ui/public");
const failures = [];

function check(name, ok, detail = "") {
  if (!ok) failures.push(`${name}${detail ? `\n  ${detail}` : ""}`);
}

function readPublic(file) {
  return fs.readFileSync(path.join(publicDir, file), "utf8");
}

function loadPublicModules() {
  const storage = new Map();
  const context = vm.createContext({
    console,
    window: {},
    document: {createElement: () => ({})},
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key)
    },
    CSS: {escape: (value) => String(value).replace(/["\\]/g, "\\$&")},
    URLSearchParams
  });
  context.window = context;
  for (const file of [
    "modules/dom-utils.js",
    "modules/i18n-utils.js",
    "modules/time-format.js",
    "modules/labels.js",
    "modules/ui-config.js",
    "modules/workspaces.js",
    "modules/workspace-location.js",
    "modules/workspace-route.js",
    "modules/object-workspace.js",
    "modules/task-group-workspace.js",
    "modules/task-group-insights.js",
    "modules/task-group-detail-workspace.js",
    "modules/task-workbench.js",
    "modules/project-settings-workspace.js",
    "modules/domain-overview-workspace.js",
    "modules/execution-object-workspace.js",
    "modules/monitor-workspace.js",
    "modules/monitor-dashboard-workspace.js",
    "modules/runtime-node-workspace.js"
  ]) {
    vm.runInContext(readPublic(file), context, {filename: file});
  }
  return context;
}

function strip(html) {
  return String(html || "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
}

function sourceBlock(source, start, end) {
  const startAt = source.indexOf(start);
  if (startAt < 0) return "";
  const endAt = end ? source.indexOf(end, startAt + start.length) : -1;
  return endAt < 0 ? source.slice(startAt) : source.slice(startAt, endAt);
}

const context = loadPublicModules();
const workspaces = context.AIMAC_WORKSPACES || context.window.AIMAC_WORKSPACES;
const taskWorkbench = context.AIMAC_TASK_WORKBENCH || context.window.AIMAC_TASK_WORKBENCH;
const uiConfig = context.AIMAC_CONSOLE_UI_CONFIG || context.window.AIMAC_CONSOLE_UI_CONFIG;
const locations = context.AIMAC_WORKSPACE_LOCATION;

{
  const indexSource = readPublic("index.html");
  const moduleAt = indexSource.indexOf('/modules/project-settings-workspace.js');
  const taskGroupDetailAt = indexSource.indexOf('/modules/task-group-detail-workspace.js');
  const monitorDashboardAt = indexSource.indexOf('/modules/monitor-dashboard-workspace.js');
  const domainOverviewAt = indexSource.indexOf('/modules/domain-overview-workspace.js');
  const appAt = indexSource.indexOf('/app.js');
  check("project settings workspace loads before app.js", moduleAt >= 0 && appAt > moduleAt,
    `moduleAt=${moduleAt}; appAt=${appAt}`);
  check("task-group detail workspace loads before app.js", taskGroupDetailAt >= 0 && appAt > taskGroupDetailAt,
    `taskGroupDetailAt=${taskGroupDetailAt}; appAt=${appAt}`);
  check("monitor dashboard workspace loads before app.js", monitorDashboardAt >= 0 && appAt > monitorDashboardAt,
    `monitorDashboardAt=${monitorDashboardAt}; appAt=${appAt}`);
  check("domain overview workspace loads before app.js", domainOverviewAt >= 0 && appAt > domainOverviewAt,
    `domainOverviewAt=${domainOverviewAt}; appAt=${appAt}`);
}

{
  const appSource = readPublic("app.js");
  const moduleSource = readPublic("modules/monitor-dashboard-workspace.js");
  const contextKeys = [...(moduleSource.match(/const \{([\s\S]*?)\} = context;/u)?.[1] || "")
    .matchAll(/\b([A-Za-z_$][\w$]*)\b(?:\s*=\s*[^,]+)?\s*(?:,|$)/gu)].map((match) => match[1]);
  const callAt = appSource.indexOf("AIMAC_MONITOR_DASHBOARD_WORKSPACE.render({");
  const contextBlock = callAt < 0 ? "" : appSource.slice(callAt, appSource.indexOf("}, {", callAt));
  const missing = contextKeys.filter((key) => !new RegExp(`\\b${key}\\b`, "u").test(contextBlock));
  check("monitor dashboard receives every declared runtime context value", contextKeys.length >= 9 && !missing.length,
    `declared=${contextKeys.join(",")}; missing=${missing.join(",")}`);
}
{
  const longCursor = "c".repeat(4096);
  const snapshot = {version: 1, accountId: "a1", projectId: "p1", page: "tasks", groupId: "g1", workId: "w1", workspace: "list", cursor: longCursor, stack: Array.from({length: 100}, (_, index) => `cursor-${index}`), token: "DO_NOT_STORE_TOKEN", objective: "DO_NOT_STORE_BODY"};
  check("workspace location saves whitelisted state", locations.save(snapshot));
  const restored = locations.read("a1");
  check("workspace location preserves task identity and full cursor history", restored?.workId === "w1" && restored.groupId === "g1" && restored.projectId === "p1" && restored.cursor === longCursor && restored.stack.length === 100);
  check("workspace location excludes credentials and task bodies", !JSON.stringify(restored).includes("DO_NOT_STORE"));
  check("workspace location does not restore across accounts", locations.read("a2") === null);
  check("workspace location stores execution identity only on monitor pages", locations.save({version: 1, accountId: "a1", projectId: "p1", page: "monitor", groupId: "g1", executionType: "session", executionId: "s1"})
    && locations.read("a1")?.executionType === "session" && locations.read("a1")?.executionId === "s1"
    && locations.save({version: 1, accountId: "a1", projectId: "p1", page: "tasks", executionType: "dispatch", executionId: "d1"})
    && locations.read("a1")?.executionType === "" && locations.read("a1")?.executionId === "");
  locations.clear();
  check("workspace location clear removes previous identity", locations.read("a1") === null);
  context.sessionStorage.setItem("aimac.workspace-location", "{broken");
  check("invalid local location is ignored without breaking the UI", locations.read("a1") === null);
  locations.clear();
}

{
  const routes = context.AIMAC_WORKSPACE_ROUTE;
  const dispatchHash = routes.build({page: "monitor", projectId: "p1", groupId: "g1", executionType: "dispatch", executionId: "d1", workspace: "events"});
  const sessionHash = routes.build({page: "monitor", projectId: "p1", groupId: "g1", executionType: "session", executionId: "s1"});
  check("execution dispatch route keeps project, task group, object and pane", dispatchHash === "#/project/p1/monitor/g1/dispatch/d1?pane=events", dispatchHash);
  check("execution session route keeps project, task group and object", sessionHash === "#/project/p1/monitor/g1/session/s1", sessionHash);
  check("execution object route parses back to the same identity",
    JSON.stringify(routes.parse(dispatchHash)) === JSON.stringify({page: "monitor", projectId: "p1", workspace: "events", groupId: "g1", executionType: "dispatch", executionId: "d1"}),
    JSON.stringify(routes.parse(dispatchHash)));
  check("unsafe execution object ids are rejected", routes.parse("#/project/p1/monitor/g1/session/%3Cscript%3E") === null);
  const projectNodeHash = routes.build({page: "proj-agents", projectId: "p1", nodeId: "n1", workspace: "nodes"});
  const orgNodeHash = routes.build({page: "org-agents", nodeId: "n2", workspace: "nodes"});
  check("runtime node routes distinguish project and organization scope",
    projectNodeHash === "#/project/p1/agents/runtime/n1?pane=nodes" && routes.parse(projectNodeHash)?.nodeId === "n1"
      && orgNodeHash === "#/organization/agents/runtime/n2?pane=nodes" && routes.parse(orgNodeHash)?.nodeId === "n2",
    `${projectNodeHash} | ${orgNodeHash}`);
}

check("workspaces module is loaded", !!workspaces && typeof workspaces.run === "function");
check("task workbench module is loaded", !!taskWorkbench && typeof taskWorkbench.render === "function");
const executionWorkspace = context.AIMAC_EXECUTION_OBJECT_WORKSPACE;
check("execution object workspace module is loaded", typeof executionWorkspace?.render === "function");
const monitorWorkspace = context.AIMAC_MONITOR_WORKSPACE;
check("monitor scope workspace module is loaded", typeof monitorWorkspace?.scopeHeader === "function");
const runtimeNodeWorkspace = context.AIMAC_RUNTIME_NODE_WORKSPACE;
check("runtime node workspace module is loaded", typeof runtimeNodeWorkspace?.render === "function");
const objectWorkspace = context.AIMAC_OBJECT_WORKSPACE;
check("object workspace module is loaded", typeof objectWorkspace?.trail === "function");
const trail = objectWorkspace.trail({organization: {name: "组织甲"}, project: {id: "p1", name: "项目甲"}, group: {id: "tg1", name: "任务组甲"}, work: {title: "任务甲"}, pageLabel: "任务详情"});
check("object breadcrumb retains all identity levels and real navigation actions", ["组织甲", "项目甲", "任务组甲", "任务甲", "任务详情", 'data-project="p1"', 'data-focus-group="tg1"'].every((value) => trail.includes(value)), trail);
const maliciousTrail = objectWorkspace.trail({organization: {name: '<script>alert(1)</script>'}, pageLabel: "概览", returnTask: {title: '\" onclick=\"alert(1)'}});
check("breadcrumb labels and return titles are escaped", !maliciousTrail.includes("<script>") && maliciousTrail.includes("&quot; onclick=&quot;"), maliciousTrail);
workspaces.select("org-members", "list");
check("generic workspace heading never duplicates create/register navigation", !workspaces.heading("org-members").includes("data-workspace") && !workspaces.heading("proj-agents").includes("data-workspace"));
check("member direct permission editor only offers project creation",
  JSON.stringify(uiConfig?.MEMBER_PERMISSION_OPTIONS || []) === JSON.stringify([["project:create", "允许创建项目"]]),
  JSON.stringify(uiConfig?.MEMBER_PERMISSION_OPTIONS || []));
check("legacy permission labels stay available outside the editable member capability list",
  uiConfig?.PERMISSION_LABELS?.["project:grant"] === "项目授权管理"
    && uiConfig?.PERMISSION_LABELS?.["task_group:control"] === "任务组执行控制"
    && uiConfig?.PERMISSION_LABELS?.["task_group:review"] === "任务组人工审核",
  JSON.stringify(uiConfig?.PERMISSION_LABELS || {}));

const expectedDefaults = {
  "group-detail": "tasks",
  "sys-overview": "overview",
  "sys-orgs": "list",
  "sys-settings": "runtime",
  "org-overview": "overview",
  "org-members": "list",
  "org-projects": "list",
  "org-agents": "profiles",
  "proj-agents": "profiles",
  "proj-overview": "overview",
  "proj-members": "list",
  "proj-settings": "repositories",
  "tg": "list",
  "tasks": "list",
  "monitor": "overview",
  "review": "pending",
  "directives": "compose"
};

for (const [page, firstPane] of Object.entries(expectedDefaults)) {
  const ids = (workspaces.catalog[page] || []).map((pane) => pane.id);
  check(`${page} declares panes`, ids.length > 0, `catalog: ${JSON.stringify(workspaces.catalog[page])}`);
  check(`${page} default pane is ${firstPane}`, workspaces.current(page)?.id === firstPane,
    `actual: ${workspaces.current(page)?.id || "(none)"}; panes: ${ids.join(", ")}`);
}

{
  const html = runtimeNodeWorkspace.render({
    detail: {
      node: {nodeId: "node_1", nodeName: "构建节点", organizationId: "org_1", registrationScope: "organization", status: "online", admission: "full", runtimeVersion: "1.4.0", lastHeartbeatAt: "now", lastSelfCheckAt: "now", allowedRoles: ["reviewer"], allowedMcpTools: Array.from({length: 9}, (_, index) => `tool.${index}`), effectiveProjectIds: ["p1"], profile: {cpuCount: 8, tools: [{name: "git", version: "2", available: true}], models: [{providerClass: "openai", available: true}], capabilityFlags: ["repo_write"]}},
      scope: {type: "organization", id: "org_1"}, assignedDispatchCount: 1,
      activeDispatches: [{dispatchId: "d1", projectId: "p1", taskGroupId: "g1", taskGroupName: "任务组", workItemId: "w1", workItemTitle: "执行任务", roleId: "reviewer", model: "model-a", status: "running", progressPercent: 33}],
      agentProfiles: [{id: "a1", name: "评审 Agent", role: "reviewer", status: "active"}],
      controlCommands: [{commandId: "c1", commandType: "refresh_profile", status: "acked", updatedAt: "now"}],
      recentEvents: [{eventId: "e1", dispatchId: "d1", eventType: "progress", status: "running", summary: "已检查", createdAt: "now"}]
    },
    controls: '<button data-command="shutdown">关停</button>',
    helpers: {badge: (value) => `<span>${value}</span>`, t: (value) => value, fmtTime: (value) => value, fmtBytes: (value) => value || "-", explainCoded: (value) => String(value || ""), evidenceRefsHint: () => ""}
  });
  check("runtime node detail exposes scope, health, capabilities, profiles, work and control ACK",
    ["org_1", "node_1", "1.4.0", "openai", "git 2", "a1", "d1", "c1", "shutdown"].every((value) => html.includes(value))
      && /data-action="open-execution-object"/u.test(html) && /data-action="open-agent-profile"/u.test(html)
      && /<details class="runtime-node-disclosure"><summary>9 个工具，展开查看/u.test(html), strip(html).slice(0, 800));
}

{
  const h = {badge: (value) => `<span>${value}</span>`, fmtTime: (value) => value};
  const projectHtml = monitorWorkspace.scopeHeader({project: {id: "p1", name: "项目甲", status: "active", progress: {percent: 36}}, stats: {groups: 3, reviews: 2}, activeSessions: 4, activeDispatches: 5, blockingObjects: 1, helpers: h});
  const groupHtml = monitorWorkspace.scopeHeader({project: {id: "p1", name: "项目甲"}, group: {id: "g1", name: "任务组甲", status: "active", progress: 48}, stats: {tasks: 8, reviews: 2, blocked: 1}, activeSessions: 2, activeDispatches: 3, helpers: h});
  check("monitor header distinguishes project overview from task-group monitoring",
    /aria-label="项目执行总览"/u.test(projectHtml) && /项目甲/u.test(projectHtml) && /任务组[^<]*<\/span><strong>3/u.test(projectHtml)
      && /aria-label="任务组执行监控"/u.test(groupHtml) && /任务组甲/u.test(groupHtml) && /data-action="monitor-project-scope"/u.test(groupHtml),
    `${strip(projectHtml)} | ${strip(groupHtml)}`);
}

{
  const before = workspaces.current("tasks")?.id;
  check("select rejects unknown panes", workspaces.select("tasks", "not-a-pane") === false);
  check("selecting an unknown pane does not move current pane", workspaces.current("tasks")?.id === before);
}

{
  check("legacy monitor runs pane migrates to the work-session page", workspaces.select("monitor", "runs") === true
    && workspaces.current("monitor")?.id === "sessions");
  check("legacy monitor nodes pane migrates to the runtime-node page", workspaces.select("monitor", "nodes") === true
    && workspaces.current("monitor")?.id === "node-control");
  check("legacy monitor evidence pane migrates to the checkpoint page", workspaces.select("monitor", "evidence") === true
    && workspaces.current("monitor")?.id === "checkpoints");
  check("legacy monitor barriers pane migrates to blocker handling", workspaces.select("monitor", "barriers") === true
    && workspaces.current("monitor")?.id === "blockers");
  check("legacy review decisions pane migrates to permission approvals", workspaces.select("review", "decisions") === true
    && workspaces.current("review")?.id === "permissions");
  check("legacy project roles pane migrates to default roles", workspaces.select("proj-settings", "roles") === true
    && workspaces.current("proj-settings")?.id === "default-roles");
  check("legacy system protocol pane migrates to instruction efficiency", workspaces.select("sys-settings", "protocol") === true
    && workspaces.current("sys-settings")?.id === "instruction-efficiency");
  workspaces.select("monitor", "overview");
}

{
  workspaces.select("proj-settings", "repositories");
  const repositoriesPane = workspaces.run("proj-settings", () => ({
    repo: workspaces.allows("项目基础配置"),
    baseline: workspaces.allows("基线资料"),
    roles: workspaces.allows("默认角色")
  }));
  check("project settings repositories pane only owns repository configuration",
    repositoriesPane.repo && !repositoriesPane.baseline && !repositoriesPane.roles,
    JSON.stringify(repositoriesPane));

  workspaces.select("proj-settings", "baseline");
  const baselinePane = workspaces.run("proj-settings", () => ({
    repo: workspaces.allows("项目基础配置"),
    baseline: workspaces.allows("基线资料"),
    rules: workspaces.allows("业务规则")
  }));
  check("project baseline pane is isolated from repository and rule forms",
    !baselinePane.repo && baselinePane.baseline && !baselinePane.rules,
    JSON.stringify(baselinePane));
}

{
  workspaces.select("tasks", "list");
  const taskListPane = workspaces.run("tasks", () => ({
    list: workspaces.allows("任务工作台"),
    create: workspaces.allows("创建工作项")
  }));
  workspaces.select("tasks", "create");
  const taskCreatePane = workspaces.run("tasks", () => ({
    list: workspaces.allows("任务工作台"),
    create: workspaces.allows("创建工作项")
  }));
  check("tasks page list/create panes are independent",
    taskListPane.list && !taskListPane.create && !taskCreatePane.list && taskCreatePane.create,
    `list=${JSON.stringify(taskListPane)} create=${JSON.stringify(taskCreatePane)}`);
}

{
  const detailOwners = [
    ["工作项（共 4000 个，当前展示 300 个）", "tasks"], ["事项清单", "progress"], ["任务执行时间线", "timeline"],
    ["角色列表", "roles"], ["配置继承", "inheritance"], ["角色 Skill 定制", "skills"],
    ["系统规则", "system-rules"], ["业务规则", "business-rules"], ["执行控制", "control"],
    ["准入与阻断分类", "admission"], ["阻塞", "blockers"], ["协作记录（Agent 房间消息）", "collaboration"]
  ];
  for (const [title, expected] of detailOwners) {
    const owner = workspaces.owner("group-detail", title);
    check(`group detail title maps to ${expected}: ${title}`, owner === expected, `owner=${owner}`);
  }
  workspaces.select("group-detail", "inheritance");
  const objectNav = workspaces.objectNavigation("group-detail");
  check("task-group detail has a grouped desktop object rail and one mobile local picker",
    /class="object-section-nav"/u.test(objectNav) && /class="workspace-mobile-picker"/u.test(objectNav)
      && (objectNav.match(/object-section-nav-item active/gu) || []).length === 1
      && /data-workspace="inheritance" aria-current="page"/u.test(objectNav)
      && ["工作推进", "执行配置", "控制与追溯"].every((label) => objectNav.includes(`<h3>${label}</h3>`)), objectNav);
  workspaces.select("group-detail", "config");
  check("legacy task-group config pane migrates to inheritance",
    workspaces.current("group-detail")?.id === "inheritance", JSON.stringify(workspaces.current("group-detail")));
  workspaces.select("group-detail", "tasks");
}

{
  const hiddenFromPrimaryNavigation = new Set(["create", "add", "grant-group", "register", "help"]);
  for (const [page, panes] of Object.entries(workspaces.catalog)) {
    for (const pane of panes) {
      workspaces.select(page, pane.id);
      const html = workspaces.run(page, () => workspaces.navigation(page));
      const activeMatches = String(html).match(/class="workspace-nav-item active"/gu) || [];
      if (hiddenFromPrimaryNavigation.has(pane.id)) {
        check(`${page}/${pane.id} remains selectable without occupying primary navigation`,
          workspaces.current(page)?.id === pane.id && activeMatches.length === 0 && !String(html).includes(`data-workspace="${pane.id}"`),
          `current=${workspaces.current(page)?.id}; nav=${html}`);
      } else {
        check(`${page}/${pane.id} renders one active primary navigation item`, activeMatches.length === 1,
          `active item count=${activeMatches.length}`);
        check(`${page}/${pane.id} primary navigation keeps the pane label`, String(html).includes(pane.label));
      }
    }
  }
}

{
  for (const [page, createPane] of [["tg", "create"], ["tasks", "create"], ["proj-agents", "register"]]) {
    workspaces.select(page, (workspaces.catalog[page] || [])[0]?.id);
    const hiddenNav = workspaces.navigation(page, false, {canCreate: false});
    const hiddenHeading = workspaces.heading(page, {canCreate: false});
    const shownNav = workspaces.navigation(page, false, {canCreate: true});
    const shownHeading = workspaces.heading(page, {canCreate: true});
    check(`${page} hides create/register workspace affordances when canCreate is false`,
      !String(hiddenNav).includes(`data-workspace="${createPane}"`)
        && !String(hiddenHeading).includes("data-workspace"),
      `nav=${hiddenNav}; heading=${hiddenHeading}`);
    check(`${page} keeps create/register workspace selectable but outside primary navigation`,
      !String(shownNav).includes(`data-workspace="${createPane}"`)
        && workspaces.select(page, createPane) === true && workspaces.current(page)?.id === createPane
        && !String(shownHeading).includes("data-workspace"),
      `nav=${shownNav}; heading=${shownHeading}; current=${workspaces.current(page)?.id}`);
  }
}

const terminalDispatchLookups = [];
const isTerminalDispatch = (status) => {
  terminalDispatchLookups.push(status);
  return ["completed", "failed", "cancelled"].includes(status);
};

const helpers = {
  badge: (kind, label) => `<span data-kind="${kind}">${label}</span>`,
  escapeHtml: context.escapeHtml || ((value) => String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char])),
  explainCoded: (value) => `explained:${value}`,
  fmtTime: (value) => `time:${value}`,
  dispatchRuleSummaries: {},
  ruleSummaryHtml: () => "",
  repositoryFailureAction: () => "",
  isTerminalDispatch,
  progressLine: (value) => `<span>${value ?? 0}%</span>`,
  workItemExitHint: () => "",
  humanTraceHtml: () => "",
  workItemResultHtml: (_groupId, workItemId) => `<div>result:${workItemId}</div>`,
  selectedProjectId: "p1",
  t: (key) => key
};

{
  const groups = [
    {id: "g2", projectId: "p1", name: "Other group", workItems: [
      {id: "w_other", title: "Other", status: "ready", createdAt: "2026-09-01T00:00:00.000Z"}
    ]},
    {id: "g1", projectId: "p1", name: "Checkout", workItems: [
      {id: "w_old", title: "Docs pass", status: "completed", createdAt: "2026-09-02T00:00:00.000Z"},
      {id: "w_new", title: "API wiring", status: "ready", createdAt: "2026-09-03T00:00:00.000Z"}
    ]}
  ];
  const detail = {taskGroupId: "g1", progress: {workItems: [
    {id: "w_detail", title: "Detail source", status: "running", createdAt: "2026-09-04T00:00:00.000Z"}
  ]}};
  const detailItems = taskWorkbench.itemsFor(groups, detail);
  check("task workbench prefers selected group detail work items",
    detailItems.map((item) => item.work.id).join(",") === "w_detail,w_other"
      && !detailItems.some((item) => item.group.id === "g1" && item.work.id === "w_new"),
    detailItems.map((item) => item.work.id).join(", "));

  const listItems = taskWorkbench.itemsFor(groups, null);
  check("task workbench list is scoped and newest-first",
    listItems.map((item) => item.work.id).join(",") === "w_new,w_old,w_other",
    listItems.map((item) => `${item.work.id}:${item.work.createdAt}`).join(", "));

  let listHtml = "";
  let listError = null;
  try {
    listHtml = taskWorkbench.render({
      groups, detail: {taskGroupId: "g1", progress: {workItems: groups[1].workItems}},
      selected: null, query: "api", status: "ready", state: {agentDispatches: []}, helpers
    });
  } catch (error) {
    listError = error;
  }
  check("task workbench list honors query and status filters",
    !listError && /API wiring/u.test(listHtml) && !/Docs pass/u.test(listHtml) && !/Other group/u.test(listHtml),
    listError ? `${listError.name}: ${listError.message}` : strip(listHtml).slice(0, 220));

  const detailHtml = taskWorkbench.render({
    groups, detail: {taskGroupId: "g1", progress: {workItems: groups[1].workItems}},
    selected: {taskGroupId: "g1", workItemId: "w_new"}, query: "", status: "",
    state: {agentDispatches: [
      {dispatchId: "d_new", taskGroupId: "g1", workItemId: "w_new", status: "completed",
        assignedNodeId: "node_a", agentRole: "implementer", model: "gpt-5.5", reasoning: "high",
        modelDecision: "bounded regression adaptation", sessionId: "sess_1",
        events: [{eventType: "completed", createdAt: "2026-09-04T00:00:00.000Z"}],
        result: {summary: "done", evidence: [{label: "console gate", path: "scripts/console-behaviour-check.mjs"}]}},
      {dispatchId: "d_other", taskGroupId: "g2", workItemId: "w_other", status: "failed",
        assignedNodeId: "node_b", events: [{eventType: "failed", createdAt: "2026-09-04T00:01:00.000Z"}]}
    ], agentRuntimeNodes: [
      {nodeId: "node_a", nodeName: "Runtime A"},
      {nodeId: "node_b", nodeName: "Runtime B"}
    ], workSessions: [], agents: [], agentExecutionEvents: [
      {dispatchId: "d_new", eventType: "completed", createdAt: "2026-09-04T00:00:00.000Z"},
      {dispatchId: "d_other", eventType: "failed", createdAt: "2026-09-04T00:01:00.000Z"}
    ]},
    helpers
  });
  check("task workbench detail scopes run history to selected task group and work item",
    /d_new/u.test(detailHtml) && /Runtime A/u.test(detailHtml) && !/d_other/u.test(detailHtml) && !/Runtime B/u.test(detailHtml),
    strip(detailHtml).slice(0, 280));
  check("task workbench detail keeps one return action and leaves lifecycle navigation to the object shell",
    /data-close-work/u.test(detailHtml)
      && !/data-focus-page="monitor"/u.test(detailHtml)
      && !/data-focus-page="review"/u.test(detailHtml)
      && !/data-focus-page="directives"/u.test(detailHtml),
    strip(detailHtml).slice(0, 280));
  check("each task execution attempt opens the addressable dispatch object", /data-action="open-execution-object"[^>]*data-execution-type="dispatch"[^>]*data-execution-id="d_new"/u.test(detailHtml), strip(detailHtml).slice(0, 360));
  check("task workbench asks the supplied helper for terminal dispatch state",
    terminalDispatchLookups.includes("completed"),
    `helper calls: ${terminalDispatchLookups.join(", ") || "(none)"}`);
  const runState = {agentDispatches: [
    {dispatchId: "second", taskGroupId: "g1", workItemId: "w_new", status: "failed", createdAt: "2026-09-05T00:00:00Z", roleId: "qa", model: "model-b"},
    {dispatchId: "first", taskGroupId: "g1", workItemId: "w_new", status: "completed", createdAt: "2026-09-04T00:00:00Z", roleId: "agent-runtime", model: "model-a"}
  ], agentExecutionEvents: [], agents: [], workSessions: []};
  const runHtml = taskWorkbench.render({groups, state: runState, selected: {taskGroupId: "g1", workItemId: "w_new"}, disclosure: {first: true, second: false}, helpers});
  check("execution trace is chronological and each attempt remains independently addressable", runHtml.indexOf('data-run-disclosure="first"') < runHtml.indexOf('data-run-disclosure="second"'));
  check("execution trace retains explicit expand/collapse choices", /<details class="task-run" open><summary data-run-disclosure="first"/u.test(runHtml) && /<details class="task-run"><summary data-run-disclosure="second"/u.test(runHtml));
  const failedRun = runHtml.slice(runHtml.indexOf('data-run-disclosure="second"'));
  check("a failed-before-start attempt is not marked as executed", !/<li class="done">执行任务<\/li>/u.test(failedRun));
  const queuedRun = taskWorkbench.render({groups, state: {...runState, agentDispatches: [runState.agentDispatches[0]], agentExecutionEvents: [{dispatchId: "second", eventType: "executor_started", sequence: 2, createdAt: "2026-09-05T01:00:00Z"}]}, selected: {taskGroupId: "g1", workItemId: "w_new"}, helpers});
  check("executor evidence marks the execution stage reached even when the run fails later", /<li class="done">执行任务<\/li>/u.test(queuedRun));
}

{
  const html = executionWorkspace.render({
    detail: {
      objectType: "dispatch", objectId: "d_exec", settled: false,
      taskGroup: {id: "g_exec", name: "发布任务组"},
      workItem: {id: "w_exec", title: "发布任务"},
      session: {sessionId: "s_exec", roleId: "reviewer", placement: "new_session", taskContractDigest: "sha256:contract"},
      dispatch: {dispatchId: "d_exec", taskGroupId: "g_exec", status: "running", progressPercent: 48, model: "model-x", reasoning: "medium", modelDecision: "bounded review", assignedNodeId: "n_exec"},
      agent: {id: "a_exec", name: "审查 Agent", projectId: null},
      node: {nodeId: "n_exec", nodeName: "运行节点", status: "online", admission: "full"},
      modelDecision: {selectedModel: {modelId: "model-x", reasoningLevel: "medium"}, modelDecision: "bounded review"},
      placementDecision: {placement: "new_session", workerCarrierDecision: {carrier: "codex_thread"}},
      contractSummary: {found: true, roleSkill: {roleSkillId: "skill-review"}, activeRuleRefs: ["rule:one"], forbiddenActions: ["scope_expand"], validationRequirements: ["tests_passed"]},
      controlCommands: [{commandId: "cmd_exec", commandType: "pause_dispatch", status: "acked", updatedAt: "2026-09-06T00:00:00Z"}],
      repositoryOutput: {repositoryId: "repo", branch: "main", status: "pushed"},
      checkpoints: [{checkpointId: "cp_exec", commitRefs: [{commit: "1234567890abcdef"}], pushRefs: [{remote: "origin"}], createdAt: "2026-09-06T00:00:00Z"}],
      qualityGates: [], testResults: []
    },
    events: [{sequence: 1, eventType: "progress", status: "running", progressPercent: 48, summary: '<script>alert(1)</script>', createdAt: "2026-09-06T00:00:00Z"}],
    controls: '<button data-command="pause_dispatch">暂停本次执行</button>',
    helpers: {
      badge: (value) => `<span class="badge">${String(value ?? "-")}</span>`,
      t: (value) => value,
      fmtTime: (value) => value,
      explainCoded: (value) => value,
      evidenceRefsHint: () => "",
      ruleSummaryHtml: () => '<div data-rules>skill-review</div>',
      reasoningLabel: (value) => ({medium: "中"}[value] || value)
    }
  });
  check("execution object workspace keeps the full task-session-dispatch-node relationship",
    ["g_exec", "w_exec", "s_exec", "d_exec", "n_exec"].every((value) => html.includes(value)), strip(html).slice(0, 500));
  check("execution object workspace exposes agent, model, reasoning, rules, commands and Git evidence",
    ["a_exec", "model-x", "中", "skill-review", "cmd_exec", "1234567890ab", "pause_dispatch"].every((value) => html.includes(value)), strip(html).slice(0, 700));
  check("execution event summaries are escaped", !html.includes("<script>") && html.includes("&lt;script&gt;"), html.slice(-500));
}

{
  const app = readPublic("app.js");
  const taskWorkbenchSource = readPublic("modules/task-workbench.js");
  const contextNavigationSource = readPublic("modules/context-navigation.js");
  const apiBlock = sourceBlock(app, "async function api(path, options = {})", "async function getState");
  const saveSessionBlock = sourceBlock(app, "function saveSession(sessionToken, account)", "const EXPIRED_DRAFT_KEY");
  const clearSessionBlock = sourceBlock(app, "function clearSession()", "function renderLogin");
  const loadTasksBlock = sourceBlock(app, "async function loadTaskWorkbenchData()", "function resetTaskWorkbench()");
  const resetTasksBlock = sourceBlock(app, "function resetTaskWorkbench()", "function renderPageContent");
  const renderContentBlock = sourceBlock(app, "function renderContent()", "function workspaceOptions()");
  const renderBlock = sourceBlock(app, "function render()", "function renderContent()");
  const sidebarContextBlock = sourceBlock(app, "function sidebarContextHtml(perspective)", "function workspaceRouteSnapshot()");
  const workspaceOptionsBlock = sourceBlock(app, "function workspaceOptions()", "function focusedTaskGroups()");
  const projectSwitchBlock = sourceBlock(app, "if (target.id === \"project-switcher\")", "if (target.dataset.ruleScope");
  const openProjectBlock = sourceBlock(app, "if (action === \"open-project-page\")", "if (action === \"focus-group\")");
  const projectCreateSubmitBlock = sourceBlock(app, "if (kind === \"project-create\")", "if (kind === \"org-project-create\")");
  const openCreateProjectBlock = sourceBlock(app, "if (action === \"open-create-project\")", "if (action === \"member-perms\")");
  const memberPermsSubmitBlock = sourceBlock(app, "if (kind === \"member-perms\")", "if (kind === \"account-invite\")");
  const memberPermsClickBlock = sourceBlock(app, "if (action === \"member-perms\")", "if (action === \"member-status\")");
  check("task workbench keeps terminal dispatch policy outside the module",
    /h\.isTerminalDispatch\(run\.status\)/u.test(taskWorkbenchSource)
      && !/terminalDispatchStatuses/u.test(taskWorkbenchSource)
      && !/new Set\(\s*\[\s*"completed"/u.test(taskWorkbenchSource),
    "modules/task-workbench.js should call the helper provided by app.js instead of carrying its own terminal-status list");
  check("task workbench controller loads paginated project lists and detail records",
    /\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}\/work-items\?\$\{query\}/u.test(loadTasksBlock)
      && /\/api\/task-groups\/\$\{encodeURIComponent\(selectedWork\.taskGroupId\)\}\/work-items\/\$\{encodeURIComponent\(selectedWork\.workItemId\)\}/u.test(loadTasksBlock)
      && /new URLSearchParams\(\{limit: "50"\}\)/u.test(loadTasksBlock),
    "loadTaskWorkbenchData should use the new project work-item list and task-group work-item detail endpoints");
  check("stale async task responses are fenced before mutating task caches",
    /\+\+taskRequestGeneration/u.test(loadTasksBlock)
      && /generation !== taskRequestGeneration \|\| projectId !== currentProjectId \|\| page !== "tasks"/u.test(loadTasksBlock)
      && /if \(currentRead\(\) && generation === taskRequestGeneration && projectId === currentProjectId && page === "tasks"\) throw error/u.test(loadTasksBlock)
      && /finally \{ if \(generation === taskRequestGeneration\) taskPageLoading = false; \}/u.test(loadTasksBlock),
    "task workbench async responses must not update list/detail caches after project/page/generation changed");
  check("task workbench reset clears scoped list/detail caches and invalidates in-flight requests",
    /taskPageData = null/u.test(resetTasksBlock)
      && /taskWorkDetail = null/u.test(resetTasksBlock)
      && /taskPageCursor = ""/u.test(resetTasksBlock)
      && /taskCursorStack = \[\]/u.test(resetTasksBlock)
      && /taskRequestGeneration \+= 1/u.test(resetTasksBlock)
      && /resetTaskWorkbench\(\)/u.test(saveSessionBlock)
      && /resetTaskWorkbench\(\)/u.test(clearSessionBlock)
      && /resetTaskWorkbench\(\)/u.test(projectSwitchBlock)
      && /targetProjectId !== currentProjectId\) resetTaskWorkbench\(\)/u.test(openProjectBlock),
    "session save/clear and project switches must discard cached task pages/details and stale requests");
  check("401 handling only clears the session that made the failed request",
    /const requestToken = authToken/u.test(apiBlock)
      && /response\.status === 401 && authToken && authToken === requestToken/u.test(apiBlock)
      && /clearSession\(\)/u.test(apiBlock),
    "old 401 responses must not logout a newer session");
  check("menu-first navigation gates create/register leaves and uses one mobile function picker",
    /menuForCurrentSection\(perspective, page\)\.filter\(\(item\) => item\.divider \|\| menuItemAvailable\(item\)\)/u.test(renderContentBlock)
      && /mobileMenuHtml\(functionalMenu, page, activeWorkspace\)/u.test(renderContentBlock)
      && /item\.requires === "agent:activate"/u.test(renderContentBlock)
      && /item\.requires === "task_group:control"/u.test(renderContentBlock),
    "renderContent should build the mobile picker from the same permission-filtered stable menu used on desktop");
  check("member-perms submit preserves uneditable original permissions",
    /const editablePermissions = new Set\(MEMBER_PERMISSION_OPTIONS\.map\(\(\[permission\]\) => permission\)\)/u.test(memberPermsSubmitBlock)
      && /\.\.\.\(member\.permissions \|\| \[\]\)\.filter\(\(permission\) => !editablePermissions\.has\(permission\)\)/u.test(memberPermsSubmitBlock)
      && /\.\.\.\[\.\.\.form\.querySelectorAll\("input\[name='perm'\]:checked"\)\]\.map\(\(input\) => input\.value\)/u.test(memberPermsSubmitBlock),
    "saving direct account capabilities must not erase project/task-group grants that are no longer editable here");
  check("member-perms modal is explicitly scoped to account capability only",
    /openModal\(`账号能力 · \$\{member\.displayName\}`/u.test(memberPermsClickBlock)
      && /本次仅调整创建项目能力，不改变已授予的项目和任务组角色/u.test(memberPermsClickBlock)
      && /permissionCheckboxes\(member\.permissions \|\| \[\]\)/u.test(memberPermsClickBlock),
    "member permission modal should not imply it edits project or task-group role grants");
  check("user-account project-create sidebar entry prefers state capability with direct-permission fallback",
    /currentAccount\.accountType === "user_account"\s*&& \(state\.accountCapabilities\?\.canCreateProject \?\? \(currentAccount\.permissions \|\| \[\]\)\.includes\("project:create"\)\)/u.test(sidebarContextBlock)
      && /canCreateProject/u.test(sidebarContextBlock)
      && /!sidebarContext\.project && sidebarContext\.canCreateProject/u.test(renderBlock)
      && /data-action="open-create-project"/u.test(renderBlock)
      && /canCreateProject[\s\S]*data-action="open-create-project"/u.test(contextNavigationSource),
    "sidebar project creation entry must use fresh server accountCapabilities when present and only fall back to cached account permissions when absent");
  check("open-create-project modal is short and has no owner selection",
    /currentAccount\?\.accountType !== "user_account" \|\| !\(state\.accountCapabilities\?\.canCreateProject \?\? \(currentAccount\.permissions \|\| \[\]\)\.includes\("project:create"\)\)/u.test(openCreateProjectBlock)
      && /data-form="project-create"/u.test(openCreateProjectBlock)
      && !/ownerAccountId/u.test(openCreateProjectBlock),
    "ordinary member project creation modal should not expose ownerAccountId");
  check("project-create submit navigates to the returned project id",
    /const created = await api\("\/api\/projects"/u.test(projectCreateSubmitBlock)
      && /if \(created\.id\)/u.test(projectCreateSubmitBlock)
      && /currentProjectId = created\.id/u.test(projectCreateSubmitBlock)
      && /page = "proj-overview"/u.test(projectCreateSubmitBlock)
      && /sessionStorage\.setItem\("aimac\.projectId", currentProjectId\)/u.test(projectCreateSubmitBlock)
      && /sessionStorage\.setItem\("aimac\.page", page\)/u.test(projectCreateSubmitBlock),
    "project-create success should enter the newly created project overview");
  check("project overview workspace covers preparation, activity and repository outputs",
    ["overview", "activity", "outputs", "help"].every((id) => (workspaces.catalog["proj-overview"] || []).some((pane) => pane.id === id))
      && workspaces.owner("proj-overview", "最新执行事件") === "activity"
      && workspaces.owner("proj-overview", "仓库产出归属概览") === "outputs"
      && workspaces.owner("proj-overview", "流程导航") === "help",
    JSON.stringify(workspaces.catalog["proj-overview"] || []));
  check("project config forms are split by data-config-fields and retain rendered config version",
    /data-config-fields="repositories" data-config-version="\$\{esc\(projConfigVersion \|\| ""\)\}"/u.test(app)
      && /data-config-fields="baselineData" data-config-version="\$\{esc\(projConfigVersion \|\| ""\)\}"/u.test(app)
      && /data-config-fields="defaultRoles" data-config-version="\$\{esc\(projConfigVersion \|\| ""\)\}"/u.test(app),
    "expected repositories, baselineData and defaultRoles forms to carry their rendered config version");
  check("rule forms retain rendered config version for project and task-group layers",
    /data-config-version="\$\{esc\(layer === "project" \? projConfigVersion \|\| "" : tgDetail\?\.configVersion \|\| ""\)\}"/u.test(app),
    "ruleEditorForm must preserve the version from the rendered layer snapshot");
  check("navigation click path uses dirty guard before switching panes",
    /formTouched && !\(await confirmDialog/u.test(app) && /workspaces\.select\(nextPage, nextSection\)/u.test(app),
    "expected dirty confirmDialog guard and workspaces.select(nextPage, nextSection) in app navigation handler");
  check("task workbench navigation opens and closes selected work without global panel bypass",
    /data-open-work/u.test(app) && /data-close-work/u.test(app) && /selectedWork = null/u.test(app),
    "expected real task workbench open/close handlers");
  check("registration forms submit registrationScope to backend",
    /registrationScope/u.test(app) && /data\.registrationScope/u.test(app),
    "join-token submit branch must pass organization/project scope");
  check("creation UX returns users to the newly created work surface",
    /kind === "org-project-create"[\s\S]*page = "proj-overview"[\s\S]*sessionStorage\.setItem\("aimac\.page", page\)/u.test(app)
      && /kind === "task-group-create"[\s\S]*startPaused: data\.startPaused === "true"[\s\S]*workspaces\.select\("group-detail", "tasks"\)/u.test(app)
      && /kind === "work-item-create"[\s\S]*selectedWork = created\.workItem\?\.id[\s\S]*page = "tasks"[\s\S]*workspaces\.select\("tasks", "list"\)/u.test(app),
    "create handlers should navigate to project overview, task-group detail, and task detail respectively");
}

{
  const gateway = fs.readFileSync(path.join(root, "apps/control-plane-ui/lib/agent-gateway.mjs"), "utf8");
  const server = fs.readFileSync(path.join(root, "apps/control-plane-ui/server.mjs"), "utf8");
  check("backend registration supports organization shared nodes and effective project ids",
    /registrationScope/u.test(gateway) && /effectiveProjectIds/u.test(gateway),
    "agent gateway must expose both scope and effective project boundaries");
  check("state view publishes fresh ordinary-user project creation capability",
    /accountCapabilities: \{canCreateProject: account\.accountType === "user_account"/u.test(server)
      && /hasPermission\(state, account\.accountId, "project:create", \{resourceType: "project", resourceId: "new"\}\)/u.test(server),
    "state view must publish accountCapabilities.canCreateProject from real permission evaluation so refresh beats stale sessionStorage account data");
}

if (failures.length > 0) {
  console.error(`workspace checks failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("workspace checks passed");
