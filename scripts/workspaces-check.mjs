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
    "modules/object-workspace.js",
    "modules/task-group-workspace.js",
    "modules/task-workbench.js"
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
  const longCursor = "c".repeat(4096);
  const snapshot = {version: 1, accountId: "a1", projectId: "p1", page: "tasks", groupId: "g1", workId: "w1", workspace: "list", cursor: longCursor, stack: Array.from({length: 100}, (_, index) => `cursor-${index}`), token: "DO_NOT_STORE_TOKEN", objective: "DO_NOT_STORE_BODY"};
  check("workspace location saves whitelisted state", locations.save(snapshot));
  const restored = locations.read("a1");
  check("workspace location preserves task identity and full cursor history", restored?.workId === "w1" && restored.groupId === "g1" && restored.projectId === "p1" && restored.cursor === longCursor && restored.stack.length === 100);
  check("workspace location excludes credentials and task bodies", !JSON.stringify(restored).includes("DO_NOT_STORE"));
  check("workspace location does not restore across accounts", locations.read("a2") === null);
  locations.clear();
  check("workspace location clear removes previous identity", locations.read("a1") === null);
  context.sessionStorage.setItem("aimac.workspace-location", "{broken");
  check("invalid local location is ignored without breaking the UI", locations.read("a1") === null);
  locations.clear();
}

check("workspaces module is loaded", !!workspaces && typeof workspaces.run === "function");
check("task workbench module is loaded", !!taskWorkbench && typeof taskWorkbench.render === "function");
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
  "org-agents": "nodes",
  "proj-agents": "nodes",
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
  const before = workspaces.current("tasks")?.id;
  check("select rejects unknown panes", workspaces.select("tasks", "not-a-pane") === false);
  check("selecting an unknown pane does not move current pane", workspaces.current("tasks")?.id === before);
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
  const detailTitles = ["任务组概览", "工作项（共 4000 个，当前展示 300 个）", "执行角色", "阻塞与状态"];
  for (const title of detailTitles) {
    const owner = workspaces.owner("group-detail", title);
    const ids = (workspaces.catalog["group-detail"] || []).map((pane) => pane.id);
    check(`group detail title maps to a real pane: ${title}`, ids.includes(owner),
      `owner=${owner}; panes=${ids.join(", ")}`);
  }
}

{
  for (const [page, panes] of Object.entries(workspaces.catalog)) {
    for (const pane of panes) {
      workspaces.select(page, pane.id);
      const html = workspaces.run(page, () => workspaces.navigation(page));
      const activeMatches = String(html).match(/class="workspace-nav-item active"/gu) || [];
      check(`${page}/${pane.id} renders one active workspace tab`, activeMatches.length === 1,
        `active tab count=${activeMatches.length}`);
      check(`${page}/${pane.id} navigation keeps the pane label`, String(html).includes(pane.label));
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
    check(`${page} keeps create/register workspace affordances when canCreate is true`,
      String(shownNav).includes(`data-workspace="${createPane}"`)
        && !String(shownHeading).includes("data-workspace"),
      `nav=${shownNav}; heading=${shownHeading}`);
  }
}

const terminalDispatchLookups = [];
const isTerminalDispatch = (status) => {
  terminalDispatchLookups.push(status);
  return status === "completed";
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
  check("task workbench detail preserves lifecycle links",
    /data-focus-page="monitor"/u.test(detailHtml)
      && /data-focus-page="review"/u.test(detailHtml)
      && /data-focus-page="directives"/u.test(detailHtml)
      && /data-close-work/u.test(detailHtml),
    strip(detailHtml).slice(0, 280));
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
  const app = readPublic("app.js");
  const taskWorkbenchSource = readPublic("modules/task-workbench.js");
  const apiBlock = sourceBlock(app, "async function api(path, options = {})", "async function getState");
  const saveSessionBlock = sourceBlock(app, "function saveSession(sessionToken, account)", "const EXPIRED_DRAFT_KEY");
  const clearSessionBlock = sourceBlock(app, "function clearSession()", "function renderLogin");
  const loadTasksBlock = sourceBlock(app, "async function loadTaskWorkbenchData()", "function resetTaskWorkbench()");
  const resetTasksBlock = sourceBlock(app, "function resetTaskWorkbench()", "function renderPageContent");
  const renderContentBlock = sourceBlock(app, "function renderContent()", "function workspaceOptions()");
  const renderBlock = sourceBlock(app, "function render()", "function renderContent()");
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
  check("workspaceOptions gates create/register panes for task groups, tasks and project agents",
    /workspaces\.navigation\(groupDetail \? "group-detail" : page, true, workspaceOptions\(\)\)/u.test(renderContentBlock)
      && /workspaces\.heading\(page, workspaceOptions\(\)\)/u.test(renderContentBlock)
      && /page === "tg" \? hasProjectPermission\("task_group:control"\)/u.test(workspaceOptionsBlock)
      && /page === "tasks" \? hasPerm\("task_group:control"\)/u.test(workspaceOptionsBlock)
      && /page === "proj-agents" \? hasPerm\("agent:activate"\) : true/u.test(workspaceOptionsBlock),
    "renderContent should pass canCreate into workspace navigation/heading for the affected pages");
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
  check("user-account project-create topbar entry prefers state capability with direct-permission fallback",
    /currentAccount\.accountType === "user_account" && \(state\.accountCapabilities\?\.canCreateProject \?\? \(currentAccount\.permissions \|\| \[\]\)\.includes\("project:create"\)\)/u.test(renderBlock)
      && /data-action="open-create-project"/u.test(renderBlock),
    "topbar project creation entry must use fresh server accountCapabilities when present and only fall back to cached account permissions when absent");
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
