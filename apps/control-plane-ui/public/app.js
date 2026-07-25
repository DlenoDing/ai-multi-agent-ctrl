/*
 * 面向人的全中文管理后台（human-org-console/v1 §6）
 * 三视角：系统管理员 / 组织管理员 / 组织成员。
 * 所有内部枚举展示一律经过 i18n-zh.js 提供的 t() 渲染。
 */

const I18N = window.AIMAC_I18N || {t: (value) => String(value ?? "-")};
const t = (value) => I18N.t(value);

const app = document.querySelector("#app");

/* ---------------- 会话与全局状态 ---------------- */

let authToken = sessionStorage.getItem("aimac.sessionToken") || "";
let currentAccount = JSON.parse(sessionStorage.getItem("aimac.account") || "null");
let page = sessionStorage.getItem("aimac.page") || "";
let currentProjectId = sessionStorage.getItem("aimac.projectId") || "";

let state = emptyState();
let systemOverview = null;
let organizations = [];
let orgAgentNodes = [];
let instructionState = null;
let loginHint = null;

let lastError = "";
let loading = false;
let formTouched = false;
let modalHtml = "";

let expandedTaskGroupId = "";
let tgDetail = null;

let reviewTaskGroupId = "";
let reviewRequests = [];
let directiveTaskGroupId = "";
let directiveList = [];
let pendingConfirmCount = 0;

let agentViewMode = "table";

let execScope = {type: "", id: ""};
let execEvents = [];
let execCursor = 0;
let execTimer = null;

/* ---------------- 视角与菜单 ---------------- */

const PROJECT_PAGES = new Set(["proj-overview", "tg", "review", "directives", "monitor", "proj-settings"]);

const PROJECT_MENU_TAIL = [
  {id: "proj-overview", label: "项目概览"},
  {id: "tg", label: "任务组"},
  {id: "review", label: "人工审核"},
  {id: "directives", label: "人工指令"},
  {id: "monitor", label: "执行监控"},
  {id: "proj-settings", label: "项目设置"}
];

const MENUS = {
  system: [
    {id: "sys-overview", label: "系统概览"},
    {id: "sys-orgs", label: "组织管理"},
    {id: "sys-settings", label: "系统设置"},
    {id: "sys-accounts", label: "账号与授权"},
    {divider: "项目支持（排障）"},
    ...PROJECT_MENU_TAIL
  ],
  org: [
    {id: "org-overview", label: "组织概览"},
    {id: "org-members", label: "成员管理"},
    {id: "org-agents", label: "AI 智能体"},
    {id: "org-projects", label: "项目管理"},
    {divider: "项目视角"},
    ...PROJECT_MENU_TAIL
  ],
  user: [...PROJECT_MENU_TAIL]
};

const PAGE_META = {
  "sys-overview": ["系统概览", "服务器信息、资源占用、能耗估算、存储体量与运行指标"],
  "sys-orgs": ["组织管理", "组织列表、配额与用量、创建组织并签发初始超管账号"],
  "sys-settings": ["系统设置", "运行参数只读展示、模型能力注册、技能源与指令协议"],
  "sys-accounts": ["账号与授权", "账号邀请、访问授权、项目归属与 Agent 入网令牌"],
  "org-overview": ["组织概览", "配额用量、活跃项目与任务组统计"],
  "org-members": ["成员管理", "创建成员、权限分配、停用与一次性登录令牌"],
  "org-agents": ["AI 智能体", "组织内智能体节点：运行状态、健康度、加入令牌与吊销"],
  "org-projects": ["项目管理", "创建项目、基础配置与成员授权"],
  "proj-overview": ["项目概览", "进度、健康度、事项完成度与待人工确认数"],
  "tg": ["任务组", "事项清单、角色、配置继承与执行控制"],
  "review": ["人工审核", "集中处理执行过程中提交的人工确认请求"],
  "directives": ["人工指令", "通过独立通道向系统下达结构化指令"],
  "monitor": ["执行监控", "会话、派发、控制通道与实时执行事件流"],
  "proj-settings": ["项目设置", "仓库与凭证引用、基线数据、业务规则与默认角色"]
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

/* ---------------- 基础工具 ---------------- */

function emptyState() {
  return {
    runtime: {status: "login_required", services: []},
    accounts: [],
    accessGrants: [],
    agents: [],
    projects: [],
    taskGroups: [],
    modelCapabilities: [],
    modelSelectionPolicies: [],
    modelSelectionDecisions: [],
    skillSources: [],
    roleSkills: [],
    roleSkillOverlays: [],
    sessionPlacementDecisions: [],
    workSessions: [],
    agentDispatches: [],
    agentRuntimeNodes: [],
    agentJoinTokens: [],
    repositoryOutputs: [],
    agentControlCommands: [],
    agentExecutionEvents: [],
    closeBarriers: [],
    sharedDefinitions: [],
    organizations: [],
    instructionMetrics: {stablePrefixTokens: 0, deltaMessageTargetTokens: 0, cacheHitTarget: 0, envelopes: []},
    auditLog: [],
    progressSnapshots: []
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const esc = escapeHtml;

const TONE_GREEN = new Set(["completed", "verified", "ok", "active", "online", "passed", "succeeded", "accepted", "applied", "answered", "consumed", "satisfied", "clear", "healthy", "available", "pushed", "committed", "merged", "full", "current", "resolved", "admitted", "acked", "indexed", "review_passed", "completed_objective", "closed", "fixed", "reverified", "code_complete", "corrected", "verification_ready"]);
const TONE_BLUE = new Set(["running", "in_progress", "queued", "assigned", "delivered", "monitoring", "syncing", "starting", "development", "evaluating", "collecting", "dispatched", "ready", "selected", "acknowledged", "received", "intake", "discovery", "product_design", "solution_design", "ui_design", "global_development_review", "verification", "repair", "reverification", "integration", "release", "online_quality", "implementation", "governance_design", "protocol", "cache_indexed", "initialized", "configured", "prepared", "submitted", "new_session", "subagent", "issued", "bound", "planned", "integrating", "checkpointed", "checkpoint_submitted", "created", "executor_started", "executor_output", "git_committed", "git_pushed", "repository_changed", "skill_synced", "dispatch_received", "heartbeat", "progress", "writing", "lease_bound"]);
const TONE_ORANGE = new Set(["attention", "pending", "review_requested", "paused", "draining", "degraded", "limited", "invited", "waiting_room_event", "waiting_dependency", "permission_required", "needs_decision", "stale_state", "reverify_required", "standby", "active_paused_by_control", "change_requested", "reopened", "requested", "reviewing", "candidate", "drift_signal", "monitor_attention", "needs_reconcile", "quota_limited", "awaiting_human_confirmation", "read_only", "close_candidate"]);
const TONE_RED = new Set(["failed", "blocked", "rejected", "denied", "error", "aborted", "quarantined", "quarantine", "dlq", "correction_required", "drift_detected", "timed_out", "unavailable", "blocked_dependency", "blocked_resource", "conflicted", "merge_conflict", "rolled_back", "invalidated"]);

function toneOf(value) {
  const key = String(value ?? "");
  if (TONE_GREEN.has(key)) return "green";
  if (TONE_BLUE.has(key)) return "blue";
  if (TONE_ORANGE.has(key)) return "orange";
  if (TONE_RED.has(key)) return "red";
  return "gray";
}

function badge(value, tone) {
  if (value === null || value === undefined || value === "") return `<span class="badge gray">-</span>`;
  return `<span class="badge ${tone || toneOf(value)}">${esc(t(value))}</span>`;
}

function customBadge(label, tone) {
  return `<span class="badge ${tone}">${esc(label)}</span>`;
}

function fmtTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return esc(value);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fmtBytes(value) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function progressBar(percent, extra = "") {
  const safe = Math.max(0, Math.min(100, Number(percent || 0)));
  return `<div class="progress ${extra}" aria-label="进度 ${safe}%"><span style="width:${safe}%"></span></div>`;
}

function progressLine(percent) {
  const safe = Math.max(0, Math.min(100, Number(percent || 0)));
  return `<div class="progress-line">${progressBar(safe)}<em>${safe}%</em></div>`;
}

function quotaLine(used, max) {
  const total = Math.max(1, Number(max || 1));
  const percent = Math.round((Number(used || 0) / total) * 100);
  const tone = percent >= 100 ? "quota-full" : percent >= 80 ? "quota-warn" : "quota-ok";
  return `<div class="progress-line">${progressBar(percent, tone)}<em>${used ?? 0}/${max ?? 0}</em></div>`;
}

function panel(title, body, options = {}) {
  return `
    <article class="panel ${options.wide ? "wide" : ""}">
      <div class="panel-header"><h2>${esc(title)}</h2>${options.headerSide ? `<div class="header-side">${options.headerSide}</div>` : ""}</div>
      <div class="panel-body">${body}</div>
    </article>
  `;
}

function row(items) {
  return `<tr>${items.map((item) => `<td>${item}</td>`).join("")}</tr>`;
}

function table(headers, bodyRows) {
  const emptyRow = row(headers.map(() => "-"));
  return `
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr>${headers.map((headline) => `<th>${esc(headline)}</th>`).join("")}</tr></thead>
        <tbody>${bodyRows || emptyRow}</tbody>
      </table>
    </div>
  `;
}

function errorBanner() {
  return lastError ? `<article class="panel wide"><div class="panel-body"><div class="notice error-notice">操作失败：${esc(lastError)}</div></div></article>` : "";
}

/* ---------------- API 封装 ---------------- */

async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = {"content-type": "application/json", ...(options.headers || {})};
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  if (method !== "GET") headers["Idempotency-Key"] = crypto.randomUUID();
  const response = await fetch(path, {...options, headers});
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.json()).error || "";
    } catch {}
    if (response.status === 401 && authToken) {
      clearSession();
      render();
    }
    throw new Error(`${response.status} ${detail ? t(detail) : response.statusText}`);
  }
  return response.json();
}

async function fetchState(view) {
  return {...emptyState(), ...(await api(`/api/state?view=${encodeURIComponent(view)}&limit=200`))};
}

function saveSession(sessionToken, account) {
  authToken = sessionToken;
  currentAccount = account;
  sessionStorage.setItem("aimac.sessionToken", sessionToken);
  sessionStorage.setItem("aimac.account", JSON.stringify(account));
}

function clearSession() {
  authToken = "";
  currentAccount = null;
  state = emptyState();
  systemOverview = null;
  organizations = [];
  orgAgentNodes = [];
  instructionState = null;
  modalHtml = "";
  expandedTaskGroupId = "";
  tgDetail = null;
  reviewRequests = [];
  directiveList = [];
  execScope = {type: "", id: ""};
  execEvents = [];
  execCursor = 0;
  stopExecPolling();
  sessionStorage.removeItem("aimac.sessionToken");
  sessionStorage.removeItem("aimac.account");
  sessionStorage.removeItem("aimac.page");
  sessionStorage.removeItem("aimac.projectId");
}

function showError(error) {
  lastError = error?.message || String(error);
  render();
}

/* ---------------- 项目范围 ---------------- */

function visibleProjects() {
  return state.projects || [];
}

function currentProject() {
  return visibleProjects().find((project) => project.id === currentProjectId) || null;
}

function ensureProjectSelection() {
  const projects = visibleProjects();
  if (!projects.length) {
    currentProjectId = "";
    return;
  }
  if (currentProjectId && projects.some((project) => project.id === currentProjectId)) return;
  const preferred = currentAccount?.defaultProjectId;
  currentProjectId = (preferred && projects.some((project) => project.id === preferred)) ? preferred : projects[0].id;
  sessionStorage.setItem("aimac.projectId", currentProjectId);
}

function projectTaskGroups() {
  return (state.taskGroups || []).filter((taskGroup) => !currentProjectId || taskGroup.projectId === currentProjectId);
}

/* ---------------- 页面数据加载 ---------------- */

async function loadPage() {
  if (!authToken) {
    render();
    return;
  }
  loading = true;
  try {
    if (page === "sys-overview") {
      [systemOverview, state] = await Promise.all([api("/api/system/overview"), fetchState("system")]);
    } else if (page === "sys-orgs") {
      organizations = (await api("/api/orgs")).organizations || [];
    } else if (page === "sys-settings") {
      [state, instructionState] = await Promise.all([fetchState("runtime"), fetchState("instructions")]);
    } else if (page === "sys-accounts") {
      state = await fetchState("users");
    } else if (page === "org-overview") {
      state = await fetchState("full");
    } else if (page === "org-members") {
      state = await fetchState("users");
    } else if (page === "org-agents") {
      const [agentsResult, projectState] = await Promise.all([api("/api/org/agents"), fetchState("projects")]);
      orgAgentNodes = agentsResult.agentRuntimeNodes || [];
      state = projectState;
    } else if (page === "org-projects") {
      state = await fetchState("projects");
    } else if (page === "proj-overview") {
      state = await fetchState("tasks");
      ensureProjectSelection();
      loadPendingConfirmCount();
    } else if (page === "tg") {
      state = await fetchState("tasks");
      ensureProjectSelection();
      if (expandedTaskGroupId) await loadTaskGroupDetail(expandedTaskGroupId);
    } else if (page === "review") {
      state = await fetchState("tasks");
      ensureProjectSelection();
      await loadReviewData();
    } else if (page === "directives") {
      state = await fetchState("tasks");
      ensureProjectSelection();
      await loadDirectiveData();
    } else if (page === "monitor") {
      const [tasksState, runtimeState] = await Promise.all([fetchState("tasks"), fetchState("runtime")]);
      state = {
        ...tasksState,
        modelSelectionDecisions: runtimeState.modelSelectionDecisions || [],
        sessionPlacementDecisions: runtimeState.sessionPlacementDecisions || [],
        skillSources: runtimeState.skillSources || [],
        roleSkills: runtimeState.roleSkills || [],
        agentJoinTokens: runtimeState.agentJoinTokens || []
      };
      ensureProjectSelection();
      ensureExecScope();
    } else if (page === "proj-settings") {
      state = await fetchState("tasks");
    }
    ensureProjectSelection();
    lastError = "";
  } catch (error) {
    lastError = error?.message || String(error);
  }
  loading = false;
  render();
}

async function loadTaskGroupDetail(taskGroupId) {
  const [progressResult, configResult] = await Promise.all([
    api(`/api/task-groups/${encodeURIComponent(taskGroupId)}/progress`),
    api(`/api/task-groups/${encodeURIComponent(taskGroupId)}/config`).catch(() => null)
  ]);
  tgDetail = {taskGroupId, progress: progressResult, config: configResult?.config || null};
}

async function loadReviewData() {
  const groups = projectTaskGroups();
  if (!groups.length) {
    reviewTaskGroupId = "";
    reviewRequests = [];
    return;
  }
  if (!reviewTaskGroupId || !groups.some((taskGroup) => taskGroup.id === reviewTaskGroupId)) {
    reviewTaskGroupId = groups[0].id;
  }
  const result = await api(`/api/task-groups/${encodeURIComponent(reviewTaskGroupId)}/human-confirmations`);
  reviewRequests = result.humanConfirmationRequests || [];
}

async function loadDirectiveData() {
  const groups = projectTaskGroups();
  if (!groups.length) {
    directiveTaskGroupId = "";
    directiveList = [];
    return;
  }
  if (!directiveTaskGroupId || !groups.some((taskGroup) => taskGroup.id === directiveTaskGroupId)) {
    directiveTaskGroupId = groups[0].id;
  }
  const result = await api(`/api/task-groups/${encodeURIComponent(directiveTaskGroupId)}/human-directives`);
  directiveList = result.humanDirectives || [];
}

function loadPendingConfirmCount() {
  const visibleTaskGroupIds = new Set(projectTaskGroups().map((taskGroup) => taskGroup.id));
  const pendingIds = state.pendingHumanConfirmationTaskGroupIds
    || (state.humanConfirmationRequests || []).filter((item) => item.status === "pending").map((item) => item.taskGroupId);
  pendingConfirmCount = pendingIds.filter((taskGroupId) => visibleTaskGroupIds.has(taskGroupId)).length;
}

/* ---------------- 执行事件长轮询 ---------------- */

function ensureExecScope() {
  if (execScope.id) return;
  const first = projectTaskGroups()[0];
  if (first) {
    execScope = {type: "taskGroup", id: first.id};
    execEvents = [];
    execCursor = 0;
  }
}

function execEventsPath(scope) {
  if (scope.type === "dispatch") return `/api/agent-dispatches/${encodeURIComponent(scope.id)}/events`;
  if (scope.type === "session") return `/api/work-sessions/${encodeURIComponent(scope.id)}/execution-events`;
  return `/api/task-groups/${encodeURIComponent(scope.id)}/execution-events`;
}

async function loadExecEvents(options = {}) {
  if (!execScope.id || !authToken) return;
  const after = options.reset ? 0 : execCursor;
  const waitMs = options.longPoll ? 2000 : 0;
  const result = await api(`${execEventsPath(execScope)}?afterSequence=${after}&limit=200&waitMs=${waitMs}`);
  if (options.reset) execEvents = [];
  const known = new Set(execEvents.map((event) => event.eventId));
  for (const event of result.events || []) {
    if (!known.has(event.eventId)) execEvents.push(event);
  }
  execEvents = execEvents.slice(-300);
  execCursor = Number(result.nextCursor || execCursor || 0);
}

function stopExecPolling() {
  if (execTimer) {
    clearInterval(execTimer);
    execTimer = null;
  }
}

function startExecPolling() {
  stopExecPolling();
  if (page !== "monitor" || !execScope.id) return;
  execTimer = setInterval(async () => {
    if (!authToken || page !== "monitor") {
      stopExecPolling();
      return;
    }
    try {
      await loadExecEvents({longPoll: true});
      if (!formTouched && !modalHtml) render();
    } catch {}
  }, 2500);
}

/* ---------------- 弹窗 ---------------- */

function openModal(title, body) {
  modalHtml = `
    <div class="modal-mask" data-modal-mask>
      <div class="modal">
        <div class="modal-header"><h3>${esc(title)}</h3><button class="modal-close" data-action="modal-close" title="关闭">×</button></div>
        <div class="modal-body">${body}</div>
      </div>
    </div>
  `;
  render();
}

function closeModal() {
  modalHtml = "";
  render();
}

function oneTimeTokenModal(title, loginEmail, token, extraNote = "") {
  openModal(title, `
    <div class="stack">
      <div class="notice warn-notice">该登录令牌仅显示一次，请立即复制并妥善保存。关闭本弹窗后将无法再次查看。</div>
      <div class="command-box"><strong>登录凭据</strong><pre>登录账号：${esc(loginEmail)}
一次性令牌：${esc(token)}</pre></div>
      ${extraNote ? `<div class="notice">${esc(extraNote)}</div>` : ""}
    </div>
  `);
}

/* ---------------- 登录页 ---------------- */

async function loadLoginHint() {
  if (loginHint) return;
  try {
    loginHint = await api("/api/auth/bootstrap-hint");
  } catch {
    loginHint = {bootstrapTokenConfigured: false};
  }
  if (!authToken) render();
}

function renderLogin() {
  const hintBlock = loginHint
    ? `
      <div class="login-hint">
        <div>初始化令牌：${loginHint.bootstrapTokenConfigured ? "已配置（系统管理员可用初始化令牌登录）" : "未配置"}</div>
        ${loginHint.tokenHintsExposed && loginHint.tokenHint ? `<div>本机令牌提示：<span class="mono">${esc(loginHint.tokenHint)}</span></div>` : ""}
        ${loginHint.tokenHintsExposed && loginHint.localAccountTokenHints ? Object.entries(loginHint.localAccountTokenHints).map(([accountId, hint]) => `<div>${esc(accountId)}：<span class="mono">${esc(hint)}</span></div>`).join("") : ""}
      </div>
    `
    : "";
  app.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-brand">
          <span class="brand-mark">智</span>
          <h1>AI 多智能体管控台</h1>
        </div>
        <p class="login-sub">面向人的组织化管理后台 · 系统管理员 / 组织管理员 / 组织成员</p>
        ${lastError ? `<div class="notice error-notice" style="margin-bottom:14px;">登录失败：${esc(lastError)}</div>` : ""}
        <form class="form-grid" data-form="login">
          <div class="form-row"><label for="loginEmail">登录账号（邮箱或账号 ID）</label><input id="loginEmail" name="email" required autocomplete="username"></div>
          <div class="form-row"><label for="loginSecret">登录令牌 / 密码</label><input id="loginSecret" name="secret" type="password" required autocomplete="current-password"></div>
          <button class="primary-button" type="submit">登 录</button>
        </form>
        ${hintBlock}
        <p class="small muted" style="margin-top:16px;">首次使用一次性令牌登录后，可在顶栏"修改密码"设置个人密码。</p>
      </div>
    </div>
  `;
  loadLoginHint();
}

/* ---------------- 框架渲染 ---------------- */

function render() {
  if (!authToken || !currentAccount) {
    renderLogin();
    return;
  }
  const perspective = perspectiveOf(currentAccount);
  if (!page || !MENUS[perspective].some((item) => item.id === page)) {
    page = defaultPageFor(perspective);
  }
  const [title, subtitle] = PAGE_META[page] || ["管理后台", ""];
  const menuHtml = MENUS[perspective].map((item) => item.divider
    ? `<div class="nav-divider">${esc(item.divider)}</div>`
    : `<button class="nav-item ${item.id === page ? "active" : ""}" data-menu="${item.id}">${esc(item.label)}</button>`
  ).join("");

  const showSwitcher = PROJECT_PAGES.has(page) && visibleProjects().length > 0;
  const switcherHtml = showSwitcher
    ? `
      <div class="project-switch">
        <span>当前项目</span>
        <select id="project-switcher">
          ${visibleProjects().map((project) => `<option value="${esc(project.id)}" ${project.id === currentProjectId ? "selected" : ""}>${esc(project.name || project.id)}</option>`).join("")}
        </select>
      </div>
    `
    : "";

  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-mark">智</span>
          <div>
            <strong>AI 多智能体管控台</strong>
            <span>${esc(t(perspectiveOf(currentAccount) === "system" ? "system_admin" : currentAccount.accountType))}视角</span>
          </div>
        </div>
        <nav class="nav" aria-label="管理菜单">${menuHtml}</nav>
      </aside>
      <main class="workspace">
        <header class="topbar">
          <div>
            <h1>${esc(title)}</h1>
            <p class="subtitle">${esc(subtitle)}</p>
          </div>
          ${switcherHtml}
          <div class="topbar-actions">
            <span class="account-chip">${esc(currentAccount.displayName || currentAccount.email)} ${badge(currentAccount.accountType)}</span>
            <button class="secondary-button" data-action="open-change-password">修改密码</button>
            <button class="icon-button" data-action="refresh" title="刷新">↻</button>
            <button class="secondary-button" data-action="logout">退出登录</button>
          </div>
        </header>
        <section class="content">${renderContent()}</section>
      </main>
    </div>
    ${modalHtml}
  `;
}

function renderContent() {
  const banner = errorBanner();
  let body = "";
  if (page === "sys-overview") body = renderSysOverview();
  else if (page === "sys-orgs") body = renderSysOrgs();
  else if (page === "sys-settings") body = renderSysSettings();
  else if (page === "sys-accounts") body = renderSysAccounts();
  else if (page === "org-overview") body = renderOrgOverview();
  else if (page === "org-members") body = renderOrgMembers();
  else if (page === "org-agents") body = renderOrgAgents();
  else if (page === "org-projects") body = renderOrgProjects();
  else if (page === "proj-overview") body = renderProjectOverview();
  else if (page === "tg") body = renderTaskGroups();
  else if (page === "review") body = renderReview();
  else if (page === "directives") body = renderDirectives();
  else if (page === "monitor") body = renderMonitor();
  else if (page === "proj-settings") body = renderProjectSettings();
  return banner + body;
}

/* ---------------- 系统管理员：系统概览 ---------------- */

function renderSysOverview() {
  const overview = systemOverview;
  const services = (state.runtime?.services || []).map((service) => row([
    `<span class="mono">${esc(service.serviceId)}</span>`,
    badge(service.status),
    badge(service.health)
  ])).join("");
  const audit = (state.auditLog || []).slice(0, 15).map((entry) => row([
    fmtTime(entry.at),
    esc(entry.actor),
    esc(entry.action),
    esc(entry.subject),
    badge(entry.result || "ok")
  ])).join("");

  const overviewPanels = overview ? [
    panel("服务器信息", `
      <dl class="kv-list">
        <dt>主机名</dt><dd class="mono">${esc(overview.server.hostname)}</dd>
        <dt>平台 / 架构</dt><dd>${esc(overview.server.platform)} / ${esc(overview.server.arch)}</dd>
        <dt>Node 版本</dt><dd>${esc(overview.server.nodeVersion)}</dd>
        <dt>进程号</dt><dd>${esc(overview.server.pid)}</dd>
        <dt>持续运行</dt><dd>${Math.floor(overview.server.uptimeSeconds / 3600)} 小时 ${Math.floor((overview.server.uptimeSeconds % 3600) / 60)} 分钟</dd>
      </dl>
    `),
    panel("资源占用", `
      <dl class="kv-list">
        <dt>常驻内存</dt><dd>${fmtBytes(overview.resources.rssBytes)}</dd>
        <dt>堆内存</dt><dd>${fmtBytes(overview.resources.heapUsedBytes)}</dd>
        <dt>累计 CPU 时间</dt><dd>${esc(overview.resources.cpuSeconds)} 秒</dd>
        <dt>负载（1/5/15 分钟）</dt><dd>${(overview.resources.loadAverage || []).map((load) => load.toFixed(2)).join(" / ")}</dd>
        <dt>CPU 核数</dt><dd>${esc(overview.resources.cpuCount)}</dd>
        <dt>系统内存</dt><dd>可用 ${fmtBytes(overview.resources.freeMemoryBytes)} / 共 ${fmtBytes(overview.resources.totalMemoryBytes)}</dd>
      </dl>
    `),
    panel("能耗估算", `
      <div class="metric-grid">
        <div class="metric"><span>累计估算能耗</span><strong>${esc(overview.energy.estimatedWattHours)} Wh</strong></div>
        <div class="metric"><span>功率系数</span><strong>${esc(overview.energy.wattsPerCpuCoefficient)} W/核</strong></div>
      </div>
    `),
    panel("存储体量", `
      <dl class="kv-list">
        <dt>中央状态库</dt><dd>${fmtBytes(overview.storage.centralStateBytes)}</dd>
        <dt>项目事件库</dt><dd>${fmtBytes(overview.storage.projectDbBytes)}</dd>
        <dt>状态存储引擎</dt><dd>${esc(t(overview.storage.stateStore))}</dd>
      </dl>
    `),
    panel("运行指标", `
      <div class="metric-grid">
        <div class="metric"><span>在线节点</span><strong>${esc(overview.runtime.onlineNodes)}/${esc(overview.runtime.totalNodes)}</strong></div>
        <div class="metric"><span>组织数</span><strong>${esc(overview.runtime.organizations)}</strong></div>
        <div class="metric"><span>项目数</span><strong>${esc(overview.runtime.projects)}</strong></div>
        <div class="metric"><span>活跃任务组</span><strong>${esc(overview.runtime.activeTaskGroups)}</strong></div>
        <div class="metric"><span>状态版本</span><strong>${esc(overview.runtime.stateVersion)}</strong></div>
      </div>
      <p class="small muted" style="margin-bottom:0;">审计链头：<span class="mono">${esc(String(overview.runtime.auditChainHead || "-").slice(0, 24))}…</span> · 统计时间 ${fmtTime(overview.at)}</p>
    `, {wide: true})
  ].join("") : panel("系统概览", `<div class="notice">正在加载系统概览…</div>`, {wide: true});

  return overviewPanels + [
    panel("系统服务", table(["服务", "状态", "健康度"], services)),
    panel("维护操作", `
      <div class="stack">
        <div class="notice warn-notice">重新初始化会将运行态重置为种子数据，仅用于本地环境排障。</div>
        <div class="button-row"><button class="danger-button" data-action="bootstrap-init">重新初始化运行态</button></div>
      </div>
    `),
    panel("审计日志", table(["时间", "操作者", "动作", "对象", "结果"], audit), {wide: true})
  ].join("");
}

/* ---------------- 系统管理员：组织管理 ---------------- */

function renderSysOrgs() {
  const orgRows = organizations.map((org) => row([
    `<strong>${esc(org.name)}</strong><div class="small muted mono">${esc(org.orgId)}</div>`,
    badge(org.status),
    quotaLine(org.usage?.members, org.quotas?.maxMembers),
    quotaLine(org.usage?.projects, org.quotas?.maxProjects),
    quotaLine(org.usage?.taskGroups, org.quotas?.maxTaskGroups),
    quotaLine(org.usage?.agents, org.quotas?.maxAgents),
    fmtTime(org.createdAt),
    [
      `<button class="secondary-button" data-action="org-quota" data-org="${esc(org.orgId)}">配额</button>`,
      org.status === "active"
        ? `<button class="danger-button" data-action="org-status" data-org="${esc(org.orgId)}" data-status="suspended">停用</button>`
        : `<button class="secondary-button" data-action="org-status" data-org="${esc(org.orgId)}" data-status="active">启用</button>`
    ].join(" ")
  ])).join("");

  return [
    panel("创建组织", `
      <form class="form-grid" data-form="org-create">
        <div class="form-row"><label>组织名称</label><input name="name" required placeholder="示例：华东研发中心"></div>
        <div class="form-row-inline">
          <div class="form-row"><label>初始超管姓名</label><input name="adminName" required placeholder="组织管理员"></div>
          <div class="form-row"><label>初始超管邮箱</label><input name="adminEmail" type="email" required></div>
        </div>
        <div class="form-row-inline">
          <div class="form-row"><label>成员上限</label><input name="maxMembers" type="number" min="1" value="50"></div>
          <div class="form-row"><label>项目上限</label><input name="maxProjects" type="number" min="1" value="20"></div>
          <div class="form-row"><label>任务组上限</label><input name="maxTaskGroups" type="number" min="1" value="200"></div>
          <div class="form-row"><label>智能体上限</label><input name="maxAgents" type="number" min="1" value="100"></div>
        </div>
        <div class="notice">创建成功后将弹窗展示初始超管的一次性登录令牌，请务必保存。</div>
        <button class="primary-button" type="submit">创建组织并签发超管账号</button>
      </form>
    `),
    panel("说明", `
      <div class="stack">
        <div class="record"><div class="record-title"><strong>三级职责边界</strong></div><div class="record-meta"><span>系统管理员负责组织与配额；组织管理员负责成员、智能体与项目；组织成员在被授权的项目内工作。</span></div></div>
        <div class="record"><div class="record-title"><strong>配额强制</strong></div><div class="record-meta"><span>成员 / 项目 / 任务组 / 智能体创建时校验配额，超限将返回"组织配额超限"。</span></div></div>
      </div>
    `),
    panel("组织列表", table(["组织", "状态", "成员", "项目", "任务组", "智能体", "创建时间", "操作"], orgRows), {wide: true})
  ].join("");
}

/* ---------------- 系统管理员：系统设置 ---------------- */

function renderSysSettings() {
  const runtime = state.runtime || {};
  const models = (state.modelCapabilities || []).slice(0, 40).map((profile) => row([
    esc(t(profile.providerClass)),
    `<span class="mono">${esc(profile.modelId)}</span>`,
    esc((profile.strengths || []).slice(0, 4).join("、")),
    esc(profile.limits?.contextWindowTokens ?? "-"),
    badge(profile.availability)
  ])).join("");
  const sources = (state.skillSources || []).map((source) => row([
    `<span class="mono">${esc(source.sourceId)}</span>`,
    badge(source.status),
    `<span class="mono">${esc(String(source.pinnedCommit || "").slice(0, 10))}</span>`,
    String((state.roleSkills || []).filter((skill) => skill.sourceId === source.sourceId).length),
    `<button class="secondary-button" data-action="sync-skill-source" data-source="${esc(source.sourceId)}">同步</button>`
  ])).join("");
  const metrics = instructionState?.instructionMetrics || {stablePrefixTokens: 0, deltaMessageTargetTokens: 0, cacheHitTarget: 0, envelopes: []};
  const envelopes = (metrics.envelopes || []).slice(0, 12).map((envelope) => row([
    `<span class="mono">${esc(envelope.envelopeId || "-")}</span>`,
    esc(t(envelope.recipientRole)),
    `<span class="mono">${esc(String(envelope.cacheKey || "").slice(0, 28))}</span>`,
    badge(envelope.status),
    esc(envelope.tokenBudget?.targetDeltaTokens ?? "-")
  ])).join("");
  const definitions = (instructionState?.sharedDefinitions || []).map((definition) => row([
    `<span class="mono">${esc(definition.contractId)}</span>`,
    esc(definition.definitionType),
    esc(t(definition.canonicalOwnerRole)),
    esc(t(definition.producerRole)),
    badge(definition.status)
  ])).join("");

  return [
    panel("运行参数（只读）", `
      <dl class="kv-list">
        <dt>运行档案</dt><dd class="mono">${esc(runtime.profileId || "-")}</dd>
        <dt>运行状态</dt><dd>${badge(runtime.status)}</dd>
        <dt>执行档位</dt><dd>${esc(t(runtime.executionProfile || "-"))}</dd>
        <dt>启动方式</dt><dd>${esc((runtime.launchModes || []).join("、") || "-")}</dd>
        <dt>MCP 工具数</dt><dd>${esc(runtime.mcp?.toolCount ?? "-")}</dd>
        <dt>更新时间</dt><dd>${fmtTime(runtime.updatedAt)}</dd>
      </dl>
    `),
    panel("技能源", table(["技能源", "状态", "固定提交", "角色数", "操作"], sources)),
    panel("模型能力注册（只读）", table(["供应商", "模型", "能力", "上下文窗口", "可用性"], models), {wide: true}),
    panel("指令压缩指标", `
      <div class="metric-grid">
        <div class="metric"><span>稳定前缀 tokens</span><strong>${esc(metrics.stablePrefixTokens)}</strong></div>
        <div class="metric"><span>增量消息目标 tokens</span><strong>${esc(metrics.deltaMessageTargetTokens)}</strong></div>
        <div class="metric"><span>缓存命中目标</span><strong>${Math.round((metrics.cacheHitTarget || 0) * 100)}%</strong></div>
      </div>
    `),
    panel("指令信封", table(["编号", "接收角色", "缓存键", "状态", "目标 tokens"], envelopes)),
    panel("共享定义归属", table(["定义", "类型", "归属角色", "生产角色", "状态"], definitions), {wide: true})
  ].join("");
}

/* ---------------- 系统管理员：账号与授权（保留既有功能） ---------------- */

function renderSysAccounts() {
  const accounts = (state.accounts || []).map((account) => row([
    esc(account.displayName),
    esc(account.email),
    badge(account.accountType),
    badge(account.status),
    esc((account.roles || []).map((role) => t(role)).join("、"))
  ])).join("");
  const grants = (state.accessGrants || []).map((grant) => row([
    `<span class="mono">${esc(grant.subjectRef?.subjectId || "-")}</span>`,
    `<span class="mono">${esc(`${grant.resource?.resourceType || "-"}:${grant.resource?.resourceId || "-"}`)}</span>`,
    esc(t(grant.role)),
    badge(grant.status),
    esc((grant.permissions || []).join("、")),
    grant.status === "active" ? `<button class="danger-button" data-action="revoke-grant" data-grant="${esc(grant.grantId)}">撤销</button>` : "-"
  ])).join("");
  const agents = (state.agents || []).map((agent) => row([
    esc(agent.name),
    esc(t(agent.role)),
    esc(t(agent.model)),
    badge(agent.status),
    `<button class="secondary-button" data-action="toggle-agent" data-agent="${esc(agent.id)}">${agent.status === "active" ? "停用" : "启用"}</button>`
  ])).join("");

  return [
    panel("邀请账号", `
      <form class="form-grid" data-form="account-invite">
        <div class="form-row"><label>显示名</label><input name="displayName" required></div>
        <div class="form-row"><label>邮箱</label><input name="email" type="email" required></div>
        <div class="form-row"><label>账号类型</label>
          <select name="accountType">
            <option value="user_account">组织成员</option>
            <option value="system_admin">系统管理员</option>
            <option value="service_account">服务账号</option>
          </select>
        </div>
        <div class="form-row"><label>角色（逗号分隔）</label><input name="roles" value="viewer"></div>
        <div class="form-row"><label>默认权限（逗号分隔）</label><input name="permissions" value="project:view"></div>
        <button class="primary-button" type="submit">邀请并签发一次性令牌</button>
      </form>
    `),
    panel("新增访问授权", `
      <form class="form-grid" data-form="grant-create">
        <div class="form-row"><label>账号 ID</label><input name="subjectId" required placeholder="acct_..."></div>
        <div class="form-row"><label>资源类型</label>
          <select name="resourceType"><option value="project">项目</option><option value="task_group">任务组</option></select>
        </div>
        <div class="form-row"><label>资源 ID</label><input name="resourceId" required placeholder="prj_... / tg_..."></div>
        <div class="form-row"><label>角色</label><input name="role" value="viewer"></div>
        <div class="form-row"><label>权限（逗号分隔）</label><input name="permissions" value="project:view"></div>
        <button class="primary-button" type="submit">新增授权</button>
      </form>
    `),
    panel("创建项目（系统级）", `
      <form class="form-grid" data-form="project-create">
        <div class="form-row"><label>项目名称</label><input name="name" required></div>
        <div class="form-row"><label>项目负责人</label>
          <select name="ownerAccountId">
            ${(state.accounts || []).map((account) => `<option value="${esc(account.accountId)}">${esc(account.displayName)}</option>`).join("")}
          </select>
        </div>
        <button class="primary-button" type="submit">创建项目</button>
      </form>
    `),
    panel("项目成员授权", renderProjectMemberForm()),
    panel("Agent 入网令牌", renderJoinTokenSection(), {wide: true}),
    panel("账号列表", table(["账号", "邮箱", "类型", "状态", "角色"], accounts), {wide: true}),
    panel("访问授权列表", table(["主体", "资源", "角色", "状态", "权限", "操作"], grants), {wide: true}),
    panel("编排智能体档案", table(["名称", "角色", "模型策略", "状态", "操作"], agents) + `
      <form class="form-grid" data-form="agent-create" style="margin-top:12px;">
        <div class="form-row-inline">
          <div class="form-row"><label>名称</label><input name="name" required></div>
          <div class="form-row"><label>角色</label><input name="role" value="reviewer" required></div>
          <div class="form-row"><label>模型策略</label>
            <select name="model"><option value="auto_best">自动最优</option><option value="auto_fast">自动快速</option><option value="cost_aware">成本优先</option></select>
          </div>
        </div>
        <button class="primary-button" type="submit">创建档案</button>
      </form>
    `, {wide: true})
  ].join("");
}

function renderProjectMemberForm() {
  return `
    <form class="form-grid" data-form="project-member">
      <div class="form-row"><label>项目</label>
        <select name="projectId">${(state.projects || []).map((project) => `<option value="${esc(project.id)}">${esc(project.name || project.id)}</option>`).join("")}</select>
      </div>
      <div class="form-row"><label>账号</label>
        <select name="accountId">${(state.accounts || []).map((account) => `<option value="${esc(account.accountId)}">${esc(account.displayName)}</option>`).join("")}</select>
      </div>
      <div class="form-row"><label>项目角色</label>
        <select name="role">
          <option value="project_owner">项目负责人</option>
          <option value="project_admin">项目管理员</option>
          <option value="task_group_owner">任务组负责人</option>
          <option value="agent_operator">智能体操作员</option>
          <option value="viewer">观察者</option>
        </select>
      </div>
      <button class="primary-button" type="submit">授权</button>
    </form>
  `;
}

function renderJoinTokenSection() {
  const tokens = (state.agentJoinTokens || []).slice(0, 20).map((token) => row([
    `<span class="mono">${esc(token.joinTokenId)}</span>`,
    esc(projectNameOf(token.projectId)),
    esc((token.allowedRoles || []).join("、")),
    badge(token.status),
    `${token.useCount ?? 0}/${token.maxUses ?? 1}`,
    fmtTime(token.expiresAt),
    token.status === "issued" ? `<button class="danger-button" data-action="revoke-join-token" data-token-id="${esc(token.joinTokenId)}">撤销</button>` : "-"
  ])).join("");
  return `
    <div class="stack">
      <form class="form-grid" data-form="join-token">
        <div class="form-row-inline">
          <div class="form-row"><label>目标项目</label>
            <select name="projectId">${(state.projects || []).map((project) => `<option value="${esc(project.id)}" ${project.id === currentProjectId ? "selected" : ""}>${esc(project.name || project.id)}</option>`).join("")}</select>
          </div>
          <div class="form-row"><label>节点名（可留空）</label><input name="nodeName" placeholder="自动生成"></div>
          <div class="form-row"><label>角色范围</label><input name="allowedRoles" value="agent-runtime"></div>
          <div class="form-row"><label>有效期（秒）</label><input name="ttlSeconds" type="number" min="60" max="86400" value="1800"></div>
        </div>
        <button class="primary-button" type="submit">签发一次性加入令牌</button>
      </form>
      ${table(["令牌", "项目", "角色范围", "状态", "已用次数", "过期时间", "操作"], tokens)}
    </div>
  `;
}

function projectNameOf(projectId) {
  return (state.projects || []).find((project) => project.id === projectId)?.name || projectId || "-";
}

/* ---------------- 组织管理员：组织概览 ---------------- */

function renderOrgOverview() {
  const org = (state.organizations || [])[0] || null;
  const projects = state.projects || [];
  const openTaskGroups = (state.taskGroups || []).filter((taskGroup) => !["closed", "aborted"].includes(taskGroup.status));
  const quotaPanel = org
    ? panel(`配额用量 · ${esc(org.name)}`, `
        <div class="stack">
          <div><div class="small muted">成员</div>${quotaLine(org.usage?.members, org.quotas?.maxMembers)}</div>
          <div><div class="small muted">项目</div>${quotaLine(org.usage?.projects, org.quotas?.maxProjects)}</div>
          <div><div class="small muted">任务组</div>${quotaLine(org.usage?.taskGroups, org.quotas?.maxTaskGroups)}</div>
          <div><div class="small muted">AI 智能体</div>${quotaLine(org.usage?.agents, org.quotas?.maxAgents)}</div>
          <div class="record-meta"><span>组织状态：${badge(org.status)}</span><span>创建时间：${fmtTime(org.createdAt)}</span></div>
        </div>
      `)
    : panel("配额用量", `<div class="notice">未找到当前账号归属的组织记录。</div>`);
  const projectRows = projects.map((project) => row([
    `<strong>${esc(project.name)}</strong><div class="small muted mono">${esc(project.id)}</div>`,
    badge(project.status),
    progressLine(project.progress?.percent),
    badge(project.progress?.phase),
    badge(project.progress?.health)
  ])).join("");

  return [
    quotaPanel,
    panel("组织运行统计", `
      <div class="metric-grid">
        <div class="metric"><span>项目总数</span><strong>${projects.length}</strong></div>
        <div class="metric"><span>进行中的任务组</span><strong>${openTaskGroups.length}</strong></div>
        <div class="metric"><span>在线智能体节点</span><strong>${(state.agentRuntimeNodes || []).filter((node) => node.status === "online").length}/${(state.agentRuntimeNodes || []).length}</strong></div>
        <div class="metric"><span>受阻项</span><strong>${(state.taskGroups || []).flatMap((taskGroup) => taskGroup.blockers || []).length}</strong></div>
      </div>
    `),
    panel("项目一览", table(["项目", "状态", "进度", "阶段", "健康度"], projectRows), {wide: true})
  ].join("");
}

/* ---------------- 组织管理员：成员管理 ---------------- */

const MEMBER_PERMISSION_OPTIONS = [
  ["project:view", "查看项目"],
  ["project:create", "创建项目"],
  ["project:grant", "项目授权管理"],
  ["task_group:read", "查看任务组"],
  ["task_group:review", "人工审核"],
  ["task_group:control", "任务组控制 / 人工指令"],
  ["task_group:orchestrate", "编排调度"],
  ["task_group:monitor", "执行监控"],
  ["member:invite", "邀请成员"],
  ["agent:activate", "智能体管理"]
];

function permissionCheckboxes(selected = ["project:view", "task_group:read"]) {
  return `
    <div class="checkbox-grid">
      ${MEMBER_PERMISSION_OPTIONS.map(([value, label]) => `
        <label><input type="checkbox" name="perm" value="${esc(value)}" ${selected.includes(value) ? "checked" : ""}> ${esc(label)}</label>
      `).join("")}
    </div>
  `;
}

function renderOrgMembers() {
  const members = (state.accounts || []).filter((account) => account.accountType !== "service_account");
  const memberRows = members.map((account) => {
    const isSelf = account.accountId === currentAccount.accountId;
    const manageable = account.accountType === "user_account" && !isSelf;
    return row([
      `<strong>${esc(account.displayName)}</strong>${isSelf ? ` ${customBadge("本人", "blue")}` : ""}`,
      esc(account.email),
      badge(account.accountType),
      badge(account.status),
      esc((account.roles || []).map((role) => t(role)).join("、")),
      manageable ? [
        `<button class="secondary-button" data-action="member-perms" data-account="${esc(account.accountId)}">权限</button>`,
        account.status === "disabled"
          ? `<button class="secondary-button" data-action="member-status" data-account="${esc(account.accountId)}" data-status="active">启用</button>`
          : `<button class="danger-button" data-action="member-status" data-account="${esc(account.accountId)}" data-status="disabled">停用</button>`
      ].join(" ") : "-"
    ]);
  }).join("");

  return [
    panel("创建成员", `
      <form class="form-grid" data-form="member-create">
        <div class="form-row-inline">
          <div class="form-row"><label>显示名</label><input name="displayName" required></div>
          <div class="form-row"><label>邮箱</label><input name="email" type="email" required></div>
        </div>
        <div class="form-row"><label>默认项目</label>
          <select name="defaultProjectId">
            <option value="">（不指定）</option>
            ${(state.projects || []).map((project) => `<option value="${esc(project.id)}">${esc(project.name || project.id)}</option>`).join("")}
          </select>
        </div>
        <div class="form-row"><label>权限分配</label>${permissionCheckboxes()}</div>
        <div class="notice">创建成功后将弹窗展示一次性登录令牌，请提示成员保存并尽快登录改密。</div>
        <button class="primary-button" type="submit">创建成员</button>
      </form>
    `),
    panel("说明", `
      <div class="stack">
        <div class="record"><div class="record-title"><strong>一次性令牌</strong></div><div class="record-meta"><span>成员首次使用令牌登录后令牌即失效，可在顶栏"修改密码"设置个人密码。</span></div></div>
        <div class="record"><div class="record-title"><strong>权限边界</strong></div><div class="record-meta"><span>成员权限不可包含系统级与组织级通配权限；项目/任务组细粒度授权可在"账号与授权 / 项目管理"中补充。</span></div></div>
      </div>
    `),
    panel("成员列表", table(["成员", "邮箱", "类型", "状态", "角色", "操作"], memberRows), {wide: true})
  ].join("");
}

/* ---------------- 组织管理员：AI 智能体 ---------------- */

function agentHoverPop(node) {
  const profile = node.profile || {};
  const display = node.display || {};
  return `
    <div class="hover-pop">
      <dl>
        <dt>CPU 核数</dt><dd>${esc(profile.cpuCount ?? "-")}</dd>
        <dt>内存</dt><dd>${fmtBytes(profile.memoryBytes)}</dd>
        <dt>磁盘可用</dt><dd>${fmtBytes(profile.diskFreeBytes)}</dd>
        <dt>支持模型</dt><dd>${esc((display.models || []).map((model) => t(model)).join("、") || "-")}</dd>
        <dt>网络速度</dt><dd>${display.networkSpeedMbps ? `${esc(display.networkSpeedMbps)} Mbps` : "-"}</dd>
        <dt>数据根路径</dt><dd class="mono">${esc(display.dataRoot || "-")}</dd>
        <dt>累计完成 / 失败</dt><dd>${esc(node.completedDispatchCount ?? 0)} / ${esc(node.failedDispatchCount ?? 0)}</dd>
      </dl>
    </div>
  `;
}

function agentActions(node) {
  if (node.status === "revoked") return "-";
  return [
    `<button class="secondary-button" data-action="agent-control" data-node-id="${esc(node.nodeId)}" data-command="pause_dispatch">暂停</button>`,
    `<button class="secondary-button" data-action="agent-control" data-node-id="${esc(node.nodeId)}" data-command="resume_dispatch">恢复</button>`,
    `<button class="danger-button" data-action="revoke-agent-node" data-node-id="${esc(node.nodeId)}">吊销</button>`
  ].join(" ");
}

function renderOrgAgents() {
  const nodes = orgAgentNodes;
  const toggle = `
    <div class="button-row">
      <button class="${agentViewMode === "table" ? "primary-button" : "secondary-button"}" data-action="agent-view-mode" data-mode="table">列表视图</button>
      <button class="${agentViewMode === "cards" ? "primary-button" : "secondary-button"}" data-action="agent-view-mode" data-mode="cards">卡片视图</button>
    </div>
  `;
  let bodyHtml;
  if (agentViewMode === "cards") {
    bodyHtml = nodes.length ? `
      <div class="agent-cards">
        ${nodes.map((node) => `
          <div class="agent-card">
            <h3><span class="hover-wrap">${esc(node.nodeName || node.nodeId)}${agentHoverPop(node)}</span>${badge(node.status)}</h3>
            <div class="agent-meta">
              <span>地区：${esc(node.display?.region || "-")}</span>
              <span>健康度：${badge(node.display?.health)}</span>
              <span>当前任务数：${(node.display?.currentDispatchIds || []).length}</span>
              <span>最近心跳：${fmtTime(node.lastHeartbeatAt)}</span>
            </div>
            <div class="button-row" style="margin-top:10px;">${agentActions(node)}</div>
          </div>
        `).join("")}
      </div>
    ` : `<div class="notice">当前组织暂无智能体节点，可先签发加入令牌。</div>`;
  } else {
    const nodeRows = nodes.map((node) => row([
      `<span class="hover-wrap"><strong>${esc(node.nodeName || node.nodeId)}</strong>${agentHoverPop(node)}</span><div class="small muted mono">${esc(node.nodeId)}</div>`,
      badge(node.status),
      esc(node.display?.region || "-"),
      badge(node.display?.health),
      String((node.display?.currentDispatchIds || []).length),
      fmtTime(node.lastHeartbeatAt),
      agentActions(node)
    ])).join("");
    bodyHtml = table(["名称", "运行状态", "地区", "健康度", "当前任务数", "最近心跳", "操作"], nodeRows);
  }

  return [
    panel("智能体节点", `<div class="stack"><div class="notice">鼠标悬浮在节点名称上可查看资源、支持模型、网络速度、数据根路径与累计完成 / 失败。</div>${bodyHtml}</div>`, {wide: true, headerSide: toggle}),
    panel("签发加入令牌 / 令牌管理", renderJoinTokenSection(), {wide: true})
  ].join("");
}

/* ---------------- 组织管理员：项目管理 ---------------- */

function renderOrgProjects() {
  const projectRows = (state.projects || []).map((project) => row([
    `<strong>${esc(project.name)}</strong><div class="small muted mono">${esc(project.id)}</div>`,
    badge(project.status),
    progressLine(project.progress?.percent),
    badge(project.progress?.phase),
    badge(project.progress?.health),
    esc((project.members || []).map((member) => `${member.accountId}(${t(member.role)})`).join("、"))
  ])).join("");

  return [
    panel("创建项目", `
      <form class="form-grid" data-form="org-project-create">
        <div class="form-row"><label>项目名称</label><input name="name" required></div>
        <div class="notice">项目在当前组织配额内创建，创建人自动成为项目负责人。</div>
        <button class="primary-button" type="submit">创建项目</button>
      </form>
    `),
    panel("项目成员授权", renderProjectMemberForm()),
    panel("项目列表", table(["项目", "状态", "进度", "阶段", "健康度", "成员"], projectRows), {wide: true})
  ].join("");
}

/* ---------------- 成员：项目概览 ---------------- */

function renderProjectOverview() {
  const project = currentProject();
  if (!project) return panel("项目概览", `<div class="notice">当前账号暂无可见项目，请联系组织管理员分配。</div>`, {wide: true});
  const groups = projectTaskGroups();
  const openGroups = groups.filter((taskGroup) => !["closed", "aborted"].includes(taskGroup.status));
  const blockers = groups.flatMap((taskGroup) => taskGroup.blockers || []);
  const avgProgress = groups.length ? Math.round(groups.reduce((sum, taskGroup) => sum + Number(taskGroup.progress || 0), 0) / groups.length) : 0;
  const groupRows = groups.map((taskGroup) => row([
    `<strong>${esc(taskGroup.name || taskGroup.id)}</strong>`,
    badge(taskGroup.status),
    badge(taskGroup.phase),
    progressLine(taskGroup.progress),
    badge(taskGroup.health),
    String((taskGroup.blockers || []).length)
  ])).join("");
  const repoRows = (state.repositoryOutputs || []).filter((target) => target.projectId === project.id).map((target) => row([
    esc(taskGroupNameOf(target.taskGroupId)),
    `<span class="mono">${esc(target.repositoryId)}</span>`,
    `<span class="mono">${esc(target.branch)}</span>`,
    badge(target.status),
    `<span class="mono">${esc((target.pathAllowlist || []).join("、"))}</span>`
  ])).join("");
  const events = (state.agentExecutionEvents || []).filter((event) => groups.some((taskGroup) => taskGroup.id === event.taskGroupId)).slice(0, 10).map((event) => row([
    fmtTime(event.createdAt),
    badge(event.eventType, "blue"),
    badge(event.status),
    esc(event.summary || "-")
  ])).join("");

  return [
    panel(`项目进度 · ${esc(project.name)}`, `
      <div class="stack">
        ${progressLine(project.progress?.percent)}
        <div class="record-meta">
          <span>阶段：${badge(project.progress?.phase)}</span>
          <span>健康度：${badge(project.progress?.health)}</span>
          <span>项目状态：${badge(project.status)}</span>
          <span>更新时间：${fmtTime(project.progress?.updatedAt)}</span>
        </div>
      </div>
    `),
    panel("关键指标", `
      <div class="metric-grid">
        <div class="metric"><span>任务组</span><strong>${openGroups.length}/${groups.length}</strong></div>
        <div class="metric"><span>事项完成度</span><strong>${avgProgress}%</strong></div>
        <div class="metric"><span>受阻项</span><strong>${blockers.length}</strong></div>
        <div class="metric"><span>待人工确认</span><strong>${pendingConfirmCount}</strong></div>
      </div>
    `),
    panel("任务组一览", table(["任务组", "状态", "阶段", "进度", "健康度", "受阻数"], groupRows), {wide: true}),
    panel("最新执行事件", table(["时间", "事件", "状态", "摘要"], events)),
    panel("仓库产出归属", table(["任务组", "仓库", "分支", "状态", "允许路径"], repoRows))
  ].join("");
}

function taskGroupNameOf(taskGroupId) {
  return (state.taskGroups || []).find((taskGroup) => taskGroup.id === taskGroupId)?.name || taskGroupId || "-";
}

/* ---------------- 成员：任务组 ---------------- */

const LANGUAGE_OPTIONS = [
  ["zh-CN", "中文"],
  ["en", "English"],
  ["ja", "日本語"],
  ["fr", "Français"],
  ["de", "Deutsch"],
  ["es", "Español"]
];

function languageSelectOptions(selected) {
  const known = LANGUAGE_OPTIONS.some(([value]) => value === selected);
  const options = known || !selected ? LANGUAGE_OPTIONS : [[selected, selected], ...LANGUAGE_OPTIONS];
  return options.map(([value, label]) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(label)} · ${esc(value)}</option>`).join("");
}

function renderTaskGroups() {
  const groups = projectTaskGroups();
  const roleOptions = [...new Set(["orchestrator", "agent-runtime", "reviewer", "qa", "security", "release", "monitor"])]
    .map((role) => `<option value="${esc(role)}">${esc(t(role))} (${esc(role)})</option>`).join("");

  const createPanels = [
    panel("创建任务组", `
      <form class="form-grid" data-form="task-group-create">
        <div class="form-row"><label>任务组名称</label><input name="name" required></div>
        <div class="form-row"><label>目标描述</label><textarea name="objective" required placeholder="描述该任务组要达成的目标"></textarea></div>
        <div class="form-row"><label>统一语言</label><select name="languageTag">${languageSelectOptions("zh-CN")}</select></div>
        <div class="form-row"><label>初始角色（逗号分隔）</label><input name="roles" value="orchestrator,agent-runtime,reviewer"></div>
        ${currentProjectId ? "" : `<div class="notice warn-notice">当前无可见项目，无法创建任务组。</div>`}
        <button class="primary-button" type="submit" ${currentProjectId ? "" : "disabled"}>创建任务组</button>
      </form>
    `),
    panel("创建工作项", `
      <form class="form-grid" data-form="work-item-create">
        <div class="form-row"><label>所属任务组</label>
          <select name="taskGroupId" ${groups.length ? "" : "disabled"}>${groups.map((taskGroup) => `<option value="${esc(taskGroup.id)}">${esc(taskGroup.name || taskGroup.id)}</option>`).join("")}</select>
        </div>
        <div class="form-row"><label>工作项标题</label><input name="title" required></div>
        <div class="form-row"><label>执行角色</label><select name="ownerRole">${roleOptions}</select></div>
        <div class="form-row"><label>机器可执行要求（每行一条）</label><textarea name="requirements" placeholder="每行一条约束或验收条件"></textarea></div>
        ${groups.length ? "" : `<div class="notice">先创建任务组后再追加工作项。</div>`}
        <button class="primary-button" type="submit" ${groups.length ? "" : "disabled"}>创建工作项</button>
      </form>
    `)
  ];

  const groupPanels = groups.map((taskGroup) => {
    const expanded = expandedTaskGroupId === taskGroup.id;
    const head = `
      <div class="stack">
        <div class="record-title">
          ${badge(taskGroup.status)} ${badge(taskGroup.phase)} ${badge(taskGroup.health)} ${badge(taskGroup.goalExecutionStatus || "active")}
        </div>
        ${progressLine(taskGroup.progress)}
        <div class="record-meta">
          <span>语言：${esc(taskGroup.languagePolicy?.languageName || taskGroup.languagePolicy?.languageTag || "中文")}</span>
          <span>角色数：${(taskGroup.roles || []).length}</span>
          <span>工作项：${(taskGroup.workItems || []).length}</span>
          <span>更新时间：${fmtTime(taskGroup.updatedAt)}</span>
        </div>
        <div class="button-row">
          <button class="secondary-button" data-action="tg-detail" data-task="${esc(taskGroup.id)}">${expanded ? "收起详情" : "查看详情"}</button>
          <button class="secondary-button" data-action="task-control" data-task="${esc(taskGroup.id)}" data-task-action="pause">暂停</button>
          <button class="secondary-button" data-action="task-control" data-task="${esc(taskGroup.id)}" data-task-action="resume">恢复</button>
          <button class="secondary-button" data-action="task-control" data-task="${esc(taskGroup.id)}" data-task-action="request_review">请求评审</button>
          <button class="danger-button" data-action="task-control" data-task="${esc(taskGroup.id)}" data-task-action="rebound_drift">纠偏</button>
        </div>
        ${expanded ? renderTaskGroupDetail(taskGroup) : ""}
      </div>
    `;
    return panel(taskGroup.name || taskGroup.id, head, {wide: true});
  }).join("");

  return createPanels.join("") + (groupPanels || panel("任务组", `<div class="notice">当前项目暂无任务组。</div>`, {wide: true}));
}

function renderTaskGroupDetail(taskGroup) {
  if (!tgDetail || tgDetail.taskGroupId !== taskGroup.id) {
    return `<div class="notice">正在加载任务组详情…</div>`;
  }
  const progressData = tgDetail.progress || {};
  const analysis = progressData.taskAnalysis;
  const analysisHtml = analysis && (analysis.items || []).length
    ? `<div class="tree">${(analysis.items || []).map((item) => `
        <div class="tree-item">
          <div class="tree-head">${customBadge(t(item.kind), "gray")} <strong>${esc(item.title)}</strong> ${badge(item.status)} <em class="small muted">${item.progress ?? 0}%</em></div>
          ${progressBar(item.progress)}
          ${item.note ? `<div class="tree-note">${esc(item.note)}</div>` : ""}
          ${(item.children || []).length ? `<div class="tree-children">${item.children.map((child) => `
            <div class="tree-item minor">
              <div class="tree-head">${customBadge(t(child.kind), "gray")} ${esc(child.title)} ${badge(child.status)} <em class="small muted">${child.progress ?? 0}%</em></div>
              ${child.note ? `<div class="tree-note">${esc(child.note)}</div>` : ""}
            </div>
          `).join("")}</div>` : ""}
        </div>
      `).join("")}</div>`
    : `<div class="notice">事项清单尚未生成（编排启动后自动生成）。</div>`;

  const roles = (progressData.roles || taskGroup.roles || []).map((role) => `
    <div class="record">
      <div class="record-title">
        <strong>${esc(t(role.roleId))}</strong><span class="mono small muted">${esc(role.roleId)}</span>
        ${badge(role.status)}
        ${role.addedBy === "auto" ? customBadge("自动加入", "orange") : role.addedBy === "inherited" ? customBadge("继承项目", "gray") : customBadge("手动添加", "blue")}
      </div>
      ${role.addedAt ? `<div class="record-meta"><span>加入时间：${fmtTime(role.addedAt)}</span></div>` : ""}
    </div>
  `).join("") || `<div class="notice">暂无角色记录。</div>`;

  const config = tgDetail.config;
  const configHtml = config ? `
    <div class="stack">
      <div class="record-title">
        <strong>配置来源：</strong>
        ${config.configSource === "customized" ? customBadge("已自定义", "orange") : customBadge("继承项目", "green")}
        ${config.configSource === "customized" ? `<button class="danger-button" data-action="tg-config-reset" data-task="${esc(taskGroup.id)}">重置为继承</button>` : ""}
      </div>
      <form class="form-grid" data-form="tg-config" data-task="${esc(taskGroup.id)}">
        <div class="form-row"><label>业务规则（标题 + 内容）</label>
          <div class="cfg-rows" data-cfg-list="tg-business">
            ${(config.businessRules || []).map((rule) => cfgBusinessRow(rule)).join("")}
          </div>
          <div class="button-row"><button type="button" class="secondary-button" data-action="cfg-add" data-kind="business" data-target="tg-business">添加规则</button></div>
        </div>
        <div class="form-row"><label>默认角色（逗号分隔角色 ID）</label>
          <input name="defaultRoles" value="${esc((config.defaultRoles || []).map((role) => role.roleId || role).join(","))}">
        </div>
        <div class="record-meta">
          <span>仓库配置：${(config.repositories || []).length} 条（在"项目设置"维护，任务组可覆盖）</span>
          <span>基线数据：${(config.baselineData || []).length} 条</span>
        </div>
        <button class="primary-button" type="submit">保存任务组配置</button>
      </form>
    </div>
  ` : `<div class="notice">暂无法读取任务组配置。</div>`;

  const languagePolicy = taskGroup.languagePolicy || {languageTag: "zh-CN"};
  const controlHtml = `
    <div class="stack">
      <div class="button-row">
        <button class="secondary-button" data-action="task-control" data-task="${esc(taskGroup.id)}" data-task-action="pause">暂停执行</button>
        <button class="secondary-button" data-action="task-control" data-task="${esc(taskGroup.id)}" data-task-action="resume">恢复执行</button>
        <button class="secondary-button" data-action="task-control" data-task="${esc(taskGroup.id)}" data-task-action="request_review">请求评审</button>
      </div>
      <form class="form-grid" data-form="language-policy" data-language-policy-form data-task="${esc(taskGroup.id)}">
        <div class="form-row"><label>任务组统一语言</label><select name="languageTag">${languageSelectOptions(languagePolicy.languageTag || "zh-CN")}</select></div>
        <button class="primary-button" type="submit">保存语言策略</button>
      </form>
    </div>
  `;

  const workItems = (progressData.workItems || taskGroup.workItems || []).map((workItem) => {
    const dispatch = findWorkItemDispatch(taskGroup.id, workItem.id);
    return `
      <div class="record">
        <div class="record-title"><strong>${esc(workItem.title)}</strong>${badge(workItem.status)}</div>
        ${progressLine(workItem.progress)}
        <div class="record-meta"><span>执行角色：${esc(t(workItem.ownerRole))}</span>${workItem.blockedReason ? `<span>受阻原因：${esc(t(workItem.blockedReason))}</span>` : ""}</div>
        ${dispatch ? `
          <div class="record-meta"><span>派发：<span class="mono">${esc(dispatch.dispatchId)}</span></span><span>${badge(dispatch.status)} ${esc(dispatch.progressPercent || 0)}%</span></div>
          <div class="button-row"><button class="secondary-button" data-action="show-dispatch-events" data-dispatch-id="${esc(dispatch.dispatchId)}">实时事件</button></div>
        ` : ""}
      </div>
    `;
  }).join("");

  const blockers = (progressData.blockers || taskGroup.blockers || []).map((blocker) => `
    <div class="record"><div class="record-title">${badge(blocker.severity || "attention")} <span>${esc(blocker.summary)}</span></div></div>
  `).join("") || `<div class="record">无阻塞</div>`;

  return `
    <div class="stack" style="margin-top:8px;">
      ${sectionBlock("事项清单", analysisHtml)}
      ${sectionBlock("角色列表", `<div class="stack">${roles}</div>`)}
      ${sectionBlock("配置（继承 / 自定义）", configHtml)}
      ${sectionBlock("执行控制", controlHtml)}
      ${sectionBlock("工作项", `<div class="stack">${workItems || `<div class="notice">暂无工作项。</div>`}</div>`)}
      ${sectionBlock("阻塞", `<div class="stack">${blockers}</div>`)}
    </div>
  `;
}

function sectionBlock(title, body) {
  return `<div class="record" style="background:#fff;"><div class="record-title"><strong>${esc(title)}</strong></div><div style="margin-top:8px;">${body}</div></div>`;
}

function cfgBusinessRow(rule = {}) {
  return `
    <div class="cfg-row" data-cfg-kind="business">
      <input name="brTitle" placeholder="规则标题" value="${esc(rule.title || "")}">
      <textarea name="brContent" placeholder="规则内容">${esc(rule.content || "")}</textarea>
      <button type="button" class="danger-button" data-action="cfg-del">删除</button>
    </div>
  `;
}

const terminalDispatchStatuses = new Set(["completed", "failed", "cancelled"]);

function findWorkItemDispatch(taskGroupId, workItemId) {
  const candidates = (state.agentDispatches || [])
    .filter((dispatch) => dispatch.taskGroupId === taskGroupId && dispatch.workItemId === workItemId)
    .sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
  return candidates.find((dispatch) => !terminalDispatchStatuses.has(dispatch.status)) || candidates[0] || null;
}

/* ---------------- 成员：人工审核 ---------------- */

function taskGroupSelector(selectedId, selectName) {
  const groups = projectTaskGroups();
  return `
    <select data-select="${selectName}">
      ${groups.map((taskGroup) => `<option value="${esc(taskGroup.id)}" ${taskGroup.id === selectedId ? "selected" : ""}>${esc(taskGroup.name || taskGroup.id)}</option>`).join("")}
    </select>
  `;
}

function renderReview() {
  if (!projectTaskGroups().length) {
    return panel("人工审核", `<div class="notice">当前项目暂无任务组。</div>`, {wide: true});
  }
  const pending = reviewRequests.filter((request) => request.status === "pending");
  const answered = reviewRequests.filter((request) => request.status !== "pending");

  const pendingHtml = pending.length ? pending.map((request) => `
    <div class="record">
      <div class="record-title"><strong>${esc(request.question?.summary || "-")}</strong>${badge(request.status)}${request.blocking ? customBadge("阻塞执行", "orange") : ""}</div>
      ${request.question?.detail ? `<div class="record-meta"><span>${esc(request.question.detail)}</span></div>` : ""}
      <div class="record-meta">
        <span>任务组：${esc(taskGroupNameOf(request.taskGroupId))}</span>
        ${request.workItemId ? `<span>工作项：<span class="mono">${esc(request.workItemId)}</span></span>` : ""}
        <span>提交时间：${fmtTime(request.createdAt)}</span>
        <span>过期时间：${fmtTime(request.expiresAt)}</span>
      </div>
      <form class="form-grid" data-form="hcr-decide" data-request="${esc(request.requestId)}" style="margin-top:10px;">
        <div class="option-list">
          ${(request.options || []).map((option, index) => `
            <label class="option-item">
              <input type="radio" name="selectedOptionId" value="${esc(option.optionId)}" ${option.recommended || (index === 0 && !(request.options || []).some((item) => item.recommended)) ? "checked" : ""}>
              <span class="option-text">
                <strong>${esc(option.label)} ${option.recommended ? customBadge("AI 推荐", "blue") : ""} ${option.optionId === "none" ? customBadge("自定义", "gray") : ""}</strong>
                ${option.description ? `<span>${esc(option.description)}</span>` : ""}
              </span>
            </label>
          `).join("")}
        </div>
        <div class="form-row"><label>确认内容（选择"不选择（自定义输入）"时必填）</label><textarea name="inputText" placeholder="补充说明或自定义决定"></textarea></div>
        <button class="primary-button" type="submit">提交确认</button>
      </form>
    </div>
  `).join("") : `<div class="notice">当前任务组没有待确认的问题。</div>`;

  const answeredRows = answered.map((request) => row([
    esc(request.question?.summary || "-"),
    badge(request.status),
    esc(request.decision?.selectedLabel || request.decision?.selectedOptionId || "-"),
    esc(request.decision?.inputText || "-"),
    esc(request.decision?.decidedBy || "-"),
    fmtTime(request.decision?.decidedAt || request.updatedAt)
  ])).join("");

  return [
    panel("待人工确认", `
      <div class="stack">
        <div class="record-meta"><span>任务组：</span>${taskGroupSelector(reviewTaskGroupId, "review-tg")}</div>
        ${pendingHtml}
      </div>
    `, {wide: true}),
    panel("已答历史", table(["问题", "状态", "所选选项", "确认内容", "确认人", "确认时间"], answeredRows), {wide: true})
  ].join("");
}

/* ---------------- 成员：人工指令 ---------------- */

const DIRECTIVE_TYPES = [
  ["pause", "暂停执行"],
  ["resume", "恢复执行"],
  ["cancel", "取消任务"],
  ["adjust_priority", "调整优先级"],
  ["add_requirement", "补充要求"],
  ["free_text", "自由指令"]
];

function renderDirectives() {
  if (!projectTaskGroups().length) {
    return panel("人工指令", `<div class="notice">当前项目暂无任务组。</div>`, {wide: true});
  }
  const directiveRows = directiveList.map((directive) => row([
    fmtTime(directive.createdAt),
    badge(directive.directiveType, "blue"),
    esc(directive.instruction || "-"),
    badge(directive.status),
    esc((directive.appliedActions || []).map((action) => action.action).join("、") || "-"),
    esc(directive.rejectReason ? t(directive.rejectReason) : "-")
  ])).join("");

  return [
    panel("下达人工指令", `
      <div class="stack">
        <div class="notice">总控 / 调度会话不接受人工直接输入。所有人工操作通过本通道生成结构化指令，由编排周期作为决策输入消费并全程留审计。</div>
        <form class="form-grid" data-form="directive-create">
          <div class="form-row"><label>目标任务组</label>${taskGroupSelector(directiveTaskGroupId, "directive-tg")}</div>
          <div class="form-row"><label>指令类型</label>
            <select name="directiveType">${DIRECTIVE_TYPES.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join("")}</select>
          </div>
          <div class="form-row"><label>指令内容</label><textarea name="instruction" placeholder="补充要求 / 自由指令必填，其余类型可选"></textarea></div>
          <button class="primary-button" type="submit">提交指令</button>
        </form>
      </div>
    `, {wide: true}),
    panel("指令流水", table(["时间", "类型", "指令内容", "状态", "已执行动作", "拒绝原因"], directiveRows), {wide: true})
  ].join("");
}

/* ---------------- 成员：执行监控 ---------------- */

function renderMonitor() {
  const groups = projectTaskGroups();
  const scopeOptions = [
    ...groups.map((taskGroup) => ({value: `taskGroup:${taskGroup.id}`, label: `任务组 · ${taskGroup.name || taskGroup.id}`}))
  ];
  const scopeValue = execScope.id ? `${execScope.type}:${execScope.id}` : "";
  if (execScope.id && !scopeOptions.some((option) => option.value === scopeValue)) {
    scopeOptions.unshift({value: scopeValue, label: `${execScope.type === "dispatch" ? "派发" : execScope.type === "session" ? "会话" : "任务组"} · ${execScope.id}`});
  }

  const eventRows = execEvents.slice().reverse().slice(0, 120).map((event) => row([
    esc(event.sequence),
    badge(event.eventType, "blue"),
    `${esc(event.progressPercent ?? 0)}%`,
    badge(event.status),
    esc(event.summary || "-"),
    fmtTime(event.createdAt)
  ])).join("");

  const sessions = (state.workSessions || []).filter((session) => groups.some((taskGroup) => taskGroup.id === session.taskGroupId)).slice(0, 20).map((session) => row([
    `<span class="mono">${esc(session.sessionId)}</span>`,
    esc(t(session.roleId)),
    `<span class="mono">${esc(session.workItemId || "-")}</span>`,
    badge(session.placement),
    badge(session.status),
    `<button class="secondary-button" data-action="show-session-events" data-session-id="${esc(session.sessionId)}">事件</button>`
  ])).join("");

  const dispatches = (state.agentDispatches || []).filter((dispatch) => groups.some((taskGroup) => taskGroup.id === dispatch.taskGroupId)).slice(0, 20).map((dispatch) => row([
    `<span class="mono">${esc(dispatch.dispatchId)}</span>`,
    `<span class="mono">${esc(dispatch.workItemId || "-")}</span>`,
    badge(dispatch.status),
    `${esc(dispatch.progressPercent || 0)}%`,
    esc(dispatch.blockedReason || dispatch.failureReason ? t(dispatch.blockedReason || dispatch.failureReason) : "-"),
    `<button class="secondary-button" data-action="show-dispatch-events" data-dispatch-id="${esc(dispatch.dispatchId)}">事件</button>`
  ])).join("");

  const commands = (state.agentControlCommands || []).slice(0, 16).map((command) => row([
    esc(command.sequence),
    `<span class="mono">${esc(command.nodeId)}</span>`,
    badge(command.commandType, "blue"),
    `<span class="mono">${esc(command.dispatchId || command.sessionId || "-")}</span>`,
    badge(command.status),
    fmtTime(command.updatedAt || command.createdAt)
  ])).join("");

  const nodes = (state.agentRuntimeNodes || []).map((node) => row([
    `<strong>${esc(node.nodeName || node.nodeId)}</strong><div class="small muted mono">${esc(node.nodeId)}</div>`,
    badge(node.status),
    badge(node.admission),
    fmtTime(node.lastHeartbeatAt),
    node.status !== "revoked" ? [
      `<button class="secondary-button" data-action="agent-control" data-node-id="${esc(node.nodeId)}" data-command="refresh_profile">刷新</button>`,
      `<button class="secondary-button" data-action="agent-control" data-node-id="${esc(node.nodeId)}" data-command="pause_dispatch">暂停</button>`,
      `<button class="danger-button" data-action="agent-control" data-node-id="${esc(node.nodeId)}" data-command="cancel_dispatch">取消</button>`
    ].join(" ") : "-"
  ])).join("");

  const decisions = (state.modelSelectionDecisions || []).slice(0, 10).map((decision) => row([
    esc(t(decision.roleId)),
    `<span class="mono">${esc(decision.workItemId || "-")}</span>`,
    `<span class="mono">${esc(decision.selectedModel?.modelId || "-")}</span>`,
    badge(decision.status),
    esc(decision.modelDecision || t(decision.selectionMode || "-"))
  ])).join("");

  const placements = (state.sessionPlacementDecisions || []).slice(0, 10).map((decision) => row([
    `<span class="mono">${esc(decision.workItemId || "-")}</span>`,
    badge(decision.placement),
    badge(decision.status)
  ])).join("");

  const barriers = (state.closeBarriers || []).slice(0, 8).map((barrier) => row([
    esc(taskGroupNameOf(barrier.taskGroupId)),
    barrier.satisfied ? customBadge("可关闭", "green") : customBadge("存在阻塞", "red"),
    String((barrier.blockingObjects || []).length),
    fmtTime(barrier.computedAt)
  ])).join("");

  return [
    panel("自治控制", `
      <div class="button-row">
        <button class="primary-button" data-action="orchestrator-run">运行自治循环</button>
        <button class="secondary-button" data-action="decide-model">模型决策</button>
      </div>
    `),
    panel("实时事件流", `
      <div class="stack">
        <div class="record-meta"><span>监听范围：</span><select data-select="exec-scope">${scopeOptions.map((option) => `<option value="${esc(option.value)}" ${option.value === scopeValue ? "selected" : ""}>${esc(option.label)}</option>`).join("")}</select></div>
        ${table(["序号", "事件", "进度", "状态", "摘要", "时间"], eventRows)}
      </div>
    `, {wide: true}),
    panel("工作会话", table(["会话", "角色", "工作项", "放置方式", "状态", "详情"], sessions), {wide: true}),
    panel("智能体派发", table(["派发", "工作项", "状态", "进度", "原因", "详情"], dispatches), {wide: true}),
    panel("控制通道", table(["序号", "节点", "命令", "作用对象", "状态", "更新时间"], commands), {wide: true}),
    panel("运行时节点", table(["节点", "状态", "准入", "最近心跳", "操作"], nodes), {wide: true}),
    panel("模型选择记录", table(["角色", "工作项", "模型", "状态", "决策说明"], decisions)),
    panel("会话放置记录", table(["工作项", "放置方式", "状态"], placements)),
    panel("关闭门禁", table(["任务组", "状态", "阻塞对象数", "计算时间"], barriers), {wide: true})
  ].join("");
}

/* ---------------- 成员：项目设置 ---------------- */

function cfgRepoRow(repo = {}) {
  return `
    <div class="cfg-row" data-cfg-kind="repo">
      <input name="repoId" placeholder="仓库 ID" value="${esc(repo.id || "")}">
      <input name="repoUrl" placeholder="仓库地址（git@... / https://...）" value="${esc(repo.url || "")}">
      <input name="repoBranch" placeholder="默认分支" value="${esc(repo.defaultBranch || "main")}">
      <input name="repoCred" placeholder="凭证引用（如 env:AIMAC_REPO_TOKEN_X）" value="${esc(repo.credentialSecretRef || "")}">
      <button type="button" class="danger-button" data-action="cfg-del">删除</button>
    </div>
  `;
}

function cfgBaselineRow(item = {}) {
  return `
    <div class="cfg-row" data-cfg-kind="baseline">
      <input name="blName" placeholder="名称" value="${esc(item.name || "")}">
      <input name="blLocator" placeholder="定位（如 git:docs/baseline/...）" value="${esc(item.locator || "")}">
      <input name="blDigest" placeholder="内容摘要（可选）" value="${esc(item.digest || "")}">
      <button type="button" class="danger-button" data-action="cfg-del">删除</button>
    </div>
  `;
}

function cfgRoleRow(role = {}) {
  return `
    <div class="cfg-row" data-cfg-kind="role">
      <input name="roleId" placeholder="角色 ID（如 backend-developer）" value="${esc(role.roleId || "")}">
      <input name="roleSkillRef" placeholder="角色规则引用（可选）" value="${esc(role.roleSkillRef || "")}">
      <button type="button" class="danger-button" data-action="cfg-del">删除</button>
    </div>
  `;
}

function renderProjectSettings() {
  const project = currentProject();
  if (!project) return panel("项目设置", `<div class="notice">当前账号暂无可见项目。</div>`, {wide: true});
  const config = project.config || {};
  return [
    panel(`项目设置 · ${esc(project.name)}`, `
      <form class="form-grid" data-form="project-config" data-project="${esc(project.id)}">
        <div class="form-row"><label>仓库与凭证引用（凭证只存引用，不落明文）</label>
          <div class="cfg-rows" data-cfg-list="proj-repos">${(config.repositories || []).map((repo) => cfgRepoRow(repo)).join("")}</div>
          <div class="button-row"><button type="button" class="secondary-button" data-action="cfg-add" data-kind="repo" data-target="proj-repos">添加仓库</button></div>
        </div>
        <div class="form-row"><label>基线数据</label>
          <div class="cfg-rows" data-cfg-list="proj-baseline">${(config.baselineData || []).map((item) => cfgBaselineRow(item)).join("")}</div>
          <div class="button-row"><button type="button" class="secondary-button" data-action="cfg-add" data-kind="baseline" data-target="proj-baseline">添加基线</button></div>
        </div>
        <div class="form-row"><label>业务规则（标题 + 内容）</label>
          <div class="cfg-rows" data-cfg-list="proj-business">${(config.businessRules || []).map((rule) => cfgBusinessRow(rule)).join("")}</div>
          <div class="button-row"><button type="button" class="secondary-button" data-action="cfg-add" data-kind="business" data-target="proj-business">添加规则</button></div>
        </div>
        <div class="form-row"><label>默认角色</label>
          <div class="cfg-rows" data-cfg-list="proj-roles">${(config.defaultRoles || []).map((role) => cfgRoleRow(role)).join("")}</div>
          <div class="button-row"><button type="button" class="secondary-button" data-action="cfg-add" data-kind="role" data-target="proj-roles">添加角色</button></div>
        </div>
        <button class="primary-button" type="submit">保存项目配置</button>
      </form>
    `, {wide: true})
  ].join("");
}

/* ---------------- 表单提交处理 ---------------- */

document.addEventListener("submit", async (event) => {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.form;
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    if (kind === "login") {
      const secret = String(data.secret || "");
      const result = await api("/api/auth/login", {method: "POST", body: JSON.stringify({email: data.email, token: secret, password: secret})});
      saveSession(result.sessionToken, result.account);
      lastError = "";
      page = defaultPageFor(perspectiveOf(currentAccount));
      sessionStorage.setItem("aimac.page", page);
      await loadPage();
      return;
    }
    if (kind === "change-password") {
      if (String(data.newPassword || "").length < 8) throw new Error("新密码至少 8 位");
      if (data.newPassword !== data.confirmPassword) throw new Error("两次输入的新密码不一致");
      await api("/api/auth/change-password", {method: "POST", body: JSON.stringify({currentPassword: data.currentPassword || undefined, newPassword: data.newPassword})});
      modalHtml = "";
      openModal("修改密码", `<div class="notice">密码修改成功，下次登录可使用新密码。</div>`);
      return;
    }
    if (kind === "org-create") {
      const result = await api("/api/orgs", {method: "POST", body: JSON.stringify({
        name: data.name,
        admin: {displayName: data.adminName, email: data.adminEmail},
        quotas: {maxMembers: Number(data.maxMembers), maxProjects: Number(data.maxProjects), maxTaskGroups: Number(data.maxTaskGroups), maxAgents: Number(data.maxAgents)}
      })});
      await loadPage();
      oneTimeTokenModal(`组织「${result.organization?.name || data.name}」创建成功`, result.adminAccount?.email || data.adminEmail, result.accountToken || "-", "请将令牌交给该组织的初始超管，首次登录后建议立即设置密码。");
      return;
    }
    if (kind === "org-quotas") {
      await api(`/api/orgs/${encodeURIComponent(form.dataset.org)}/quotas`, {method: "POST", body: JSON.stringify({
        quotas: {maxMembers: Number(data.maxMembers), maxProjects: Number(data.maxProjects), maxTaskGroups: Number(data.maxTaskGroups), maxAgents: Number(data.maxAgents)}
      })});
      modalHtml = "";
      await loadPage();
      return;
    }
    if (kind === "member-create") {
      const permissions = [...form.querySelectorAll("input[name='perm']:checked")].map((input) => input.value);
      const result = await api("/api/org/members", {method: "POST", body: JSON.stringify({
        displayName: data.displayName,
        email: data.email,
        permissions,
        defaultProjectId: data.defaultProjectId || null
      })});
      await loadPage();
      oneTimeTokenModal("成员创建成功", result.account?.email || data.email, result.accountToken || "-", "请将一次性登录令牌交给该成员。");
      return;
    }
    if (kind === "member-perms") {
      const permissions = [...form.querySelectorAll("input[name='perm']:checked")].map((input) => input.value);
      await api(`/api/org/members/${encodeURIComponent(form.dataset.account)}/permissions`, {method: "POST", body: JSON.stringify({permissions})});
      modalHtml = "";
      await loadPage();
      return;
    }
    if (kind === "account-invite") {
      const result = await api("/api/accounts", {method: "POST", body: JSON.stringify(data)});
      await loadPage();
      oneTimeTokenModal("账号邀请成功", result.account?.email || result.login?.email || data.email, result.accountToken || "-", `令牌有效期至 ${fmtTime(result.tokenExpiresAt)}。`);
      return;
    }
    if (kind === "grant-create") {
      await api("/api/access-grants", {method: "POST", body: JSON.stringify(data)});
      await loadPage();
      return;
    }
    if (kind === "project-create") {
      await api("/api/projects", {method: "POST", body: JSON.stringify(data)});
      await loadPage();
      return;
    }
    if (kind === "org-project-create") {
      await api("/api/org/projects", {method: "POST", body: JSON.stringify({name: data.name})});
      await loadPage();
      return;
    }
    if (kind === "project-member") {
      await api(`/api/projects/${encodeURIComponent(data.projectId)}/members`, {method: "POST", body: JSON.stringify(data)});
      await loadPage();
      return;
    }
    if (kind === "join-token") {
      const payload = {
        projectId: data.projectId,
        nodeName: data.nodeName || undefined,
        allowedRoles: String(data.allowedRoles || "agent-runtime").split(",").map((item) => item.trim()).filter(Boolean),
        ttlSeconds: Number(data.ttlSeconds || 1800),
        maxUses: 1
      };
      const result = await api("/api/agent-join-tokens", {method: "POST", body: JSON.stringify(payload)});
      await loadPage();
      openModal("一次性 Agent 加入令牌", `
        <div class="stack">
          <div class="notice warn-notice">以下注册命令仅显示一次，请立即复制到目标主机执行。</div>
          <div class="command-box"><strong>直接安装</strong><pre>${esc(result.installCommand || "-")}</pre></div>
          <div class="command-box"><strong>校验安装（推荐）</strong><pre>${esc(result.verifiedInstallCommand || "-")}</pre></div>
        </div>
      `);
      return;
    }
    if (kind === "agent-create") {
      await api("/api/agents", {method: "POST", body: JSON.stringify(data)});
      await loadPage();
      return;
    }
    if (kind === "task-group-create") {
      if (!currentProjectId) throw new Error("请先选择项目");
      const languageSelect = form.querySelector("select[name='languageTag']");
      const languageName = languageSelect?.selectedOptions[0]?.textContent?.split(" · ")[0]?.trim() || data.languageTag;
      const payload = {
        projectId: currentProjectId,
        name: data.name,
        objective: data.objective,
        languageTag: data.languageTag,
        languageName,
        roles: String(data.roles || "").split(/[\n,]/u).map((item) => item.trim()).filter(Boolean)
      };
      const result = await api("/api/task-groups", {method: "POST", body: JSON.stringify(payload)});
      expandedTaskGroupId = result.taskGroup?.id || expandedTaskGroupId;
      formTouched = false;
      await loadPage();
      return;
    }
    if (kind === "work-item-create") {
      const taskGroupId = data.taskGroupId;
      const payload = {
        title: data.title,
        ownerRole: data.ownerRole,
        requirements: String(data.requirements || "").split(/\n/u).map((item) => item.trim()).filter(Boolean)
      };
      await api(`/api/task-groups/${encodeURIComponent(taskGroupId)}/work-items`, {method: "POST", body: JSON.stringify(payload)});
      expandedTaskGroupId = taskGroupId;
      formTouched = false;
      await loadPage();
      return;
    }
    if (kind === "language-policy") {
      const languageSelect = form.querySelector("select[name='languageTag']");
      const languageName = languageSelect?.selectedOptions[0]?.textContent?.split(" · ")[0]?.trim() || data.languageTag;
      await api(`/api/task-groups/${encodeURIComponent(form.dataset.task)}/language-policy`, {method: "POST", body: JSON.stringify({languageTag: data.languageTag, languageName})});
      formTouched = false;
      await loadPage();
      return;
    }
    if (kind === "tg-config") {
      const businessRules = [...form.querySelectorAll("[data-cfg-kind='business']")].map((rowEl) => ({
        title: rowEl.querySelector("input[name='brTitle']")?.value?.trim() || "",
        content: rowEl.querySelector("textarea[name='brContent']")?.value?.trim() || ""
      })).filter((rule) => rule.title || rule.content);
      const defaultRoles = String(data.defaultRoles || "").split(",").map((item) => item.trim()).filter(Boolean).map((roleId) => ({roleId}));
      await api(`/api/task-groups/${encodeURIComponent(form.dataset.task)}/config`, {method: "POST", body: JSON.stringify({businessRules, defaultRoles})});
      formTouched = false;
      await loadPage();
      return;
    }
    if (kind === "project-config") {
      const repositories = [...form.querySelectorAll("[data-cfg-kind='repo']")].map((rowEl) => ({
        id: rowEl.querySelector("input[name='repoId']")?.value?.trim() || "",
        url: rowEl.querySelector("input[name='repoUrl']")?.value?.trim() || "",
        defaultBranch: rowEl.querySelector("input[name='repoBranch']")?.value?.trim() || "main",
        credentialSecretRef: rowEl.querySelector("input[name='repoCred']")?.value?.trim() || ""
      })).filter((repo) => repo.id || repo.url);
      const baselineData = [...form.querySelectorAll("[data-cfg-kind='baseline']")].map((rowEl) => ({
        name: rowEl.querySelector("input[name='blName']")?.value?.trim() || "",
        locator: rowEl.querySelector("input[name='blLocator']")?.value?.trim() || "",
        digest: rowEl.querySelector("input[name='blDigest']")?.value?.trim() || ""
      })).filter((item) => item.name || item.locator);
      const businessRules = [...form.querySelectorAll("[data-cfg-kind='business']")].map((rowEl) => ({
        title: rowEl.querySelector("input[name='brTitle']")?.value?.trim() || "",
        content: rowEl.querySelector("textarea[name='brContent']")?.value?.trim() || ""
      })).filter((rule) => rule.title || rule.content);
      const defaultRoles = [...form.querySelectorAll("[data-cfg-kind='role']")].map((rowEl) => ({
        roleId: rowEl.querySelector("input[name='roleId']")?.value?.trim() || "",
        roleSkillRef: rowEl.querySelector("input[name='roleSkillRef']")?.value?.trim() || ""
      })).filter((role) => role.roleId);
      await api(`/api/projects/${encodeURIComponent(form.dataset.project)}/config`, {method: "POST", body: JSON.stringify({repositories, baselineData, businessRules, defaultRoles})});
      formTouched = false;
      await loadPage();
      return;
    }
    if (kind === "hcr-decide") {
      const selectedOptionId = data.selectedOptionId;
      if (!selectedOptionId) throw new Error("请先选择一个选项");
      if (selectedOptionId === "none" && !String(data.inputText || "").trim()) throw new Error("选择“不选择（自定义输入）”时必须填写确认内容");
      await api(`/api/human-confirmations/${encodeURIComponent(form.dataset.request)}/decide`, {method: "POST", body: JSON.stringify({selectedOptionId, inputText: data.inputText || ""})});
      formTouched = false;
      await loadPage();
      return;
    }
    if (kind === "directive-create") {
      if (["add_requirement", "free_text"].includes(data.directiveType) && !String(data.instruction || "").trim()) {
        throw new Error("补充要求 / 自由指令必须填写指令内容");
      }
      await api("/api/human-directives", {method: "POST", body: JSON.stringify({
        projectId: currentProjectId,
        taskGroupId: directiveTaskGroupId,
        directiveType: data.directiveType,
        instruction: data.instruction || ""
      })});
      formTouched = false;
      await loadPage();
      return;
    }
  } catch (error) {
    showError(error);
  }
});

/* ---------------- 点击与选择处理 ---------------- */

document.addEventListener("change", async (event) => {
  const target = event.target;
  try {
    if (target.id === "project-switcher") {
      currentProjectId = target.value;
      sessionStorage.setItem("aimac.projectId", currentProjectId);
      expandedTaskGroupId = "";
      tgDetail = null;
      reviewTaskGroupId = "";
      directiveTaskGroupId = "";
      execScope = {type: "", id: ""};
      execEvents = [];
      execCursor = 0;
      await loadPage();
      return;
    }
    if (target.dataset.select === "review-tg") {
      reviewTaskGroupId = target.value;
      await loadPage();
      return;
    }
    if (target.dataset.select === "directive-tg") {
      directiveTaskGroupId = target.value;
      await loadPage();
      return;
    }
    if (target.dataset.select === "exec-scope") {
      const [type, ...rest] = String(target.value).split(":");
      execScope = {type, id: rest.join(":")};
      execEvents = [];
      execCursor = 0;
      await loadExecEvents({reset: true});
      startExecPolling();
      render();
      return;
    }
  } catch (error) {
    showError(error);
  }
});

document.addEventListener("input", (event) => {
  if (event.target.closest("form[data-form]")) formTouched = true;
});

document.addEventListener("click", async (event) => {
  const mask = event.target.closest("[data-modal-mask]");
  if (mask && event.target === mask) {
    closeModal();
    return;
  }
  const menuButton = event.target.closest("[data-menu]");
  if (menuButton) {
    page = menuButton.dataset.menu;
    sessionStorage.setItem("aimac.page", page);
    lastError = "";
    formTouched = false;
    stopExecPolling();
    await loadPage();
    if (page === "monitor") {
      try {
        await loadExecEvents({reset: true});
      } catch {}
      startExecPolling();
      render();
    }
    return;
  }
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  try {
    if (action === "modal-close") {
      closeModal();
      return;
    }
    if (action === "logout") {
      try {
        await api("/api/auth/logout", {method: "POST", body: "{}"});
      } catch {}
      clearSession();
      lastError = "";
      render();
      return;
    }
    if (action === "refresh") {
      await loadPage();
      return;
    }
    if (action === "open-change-password") {
      openModal("修改密码", `
        <form class="form-grid" data-form="change-password">
          <div class="form-row"><label>当前密码（首次设置可留空）</label><input name="currentPassword" type="password" autocomplete="current-password"></div>
          <div class="form-row"><label>新密码（至少 8 位）</label><input name="newPassword" type="password" required minlength="8" autocomplete="new-password"></div>
          <div class="form-row"><label>确认新密码</label><input name="confirmPassword" type="password" required minlength="8" autocomplete="new-password"></div>
          <button class="primary-button" type="submit">保存新密码</button>
        </form>
      `);
      return;
    }
    if (action === "bootstrap-init") {
      if (!confirm("确认重新初始化运行态？该操作会重置为种子数据，仅用于本地排障。")) return;
      await api("/api/bootstrap/init", {method: "POST", body: "{}"});
      await loadPage();
      return;
    }
    if (action === "org-quota") {
      const org = organizations.find((item) => item.orgId === target.dataset.org);
      if (!org) return;
      openModal(`调整配额 · ${org.name}`, `
        <form class="form-grid" data-form="org-quotas" data-org="${esc(org.orgId)}">
          <div class="form-row"><label>成员上限</label><input name="maxMembers" type="number" min="1" value="${esc(org.quotas?.maxMembers ?? 50)}"></div>
          <div class="form-row"><label>项目上限</label><input name="maxProjects" type="number" min="1" value="${esc(org.quotas?.maxProjects ?? 20)}"></div>
          <div class="form-row"><label>任务组上限</label><input name="maxTaskGroups" type="number" min="1" value="${esc(org.quotas?.maxTaskGroups ?? 200)}"></div>
          <div class="form-row"><label>智能体上限</label><input name="maxAgents" type="number" min="1" value="${esc(org.quotas?.maxAgents ?? 100)}"></div>
          <button class="primary-button" type="submit">保存配额</button>
        </form>
      `);
      return;
    }
    if (action === "org-status") {
      const status = target.dataset.status;
      if (status === "suspended" && !confirm("确认停用该组织？停用后组织内账号与智能体将无法工作。")) return;
      await api(`/api/orgs/${encodeURIComponent(target.dataset.org)}/status`, {method: "POST", body: JSON.stringify({status})});
      await loadPage();
      return;
    }
    if (action === "member-perms") {
      const member = (state.accounts || []).find((account) => account.accountId === target.dataset.account);
      if (!member) return;
      openModal(`调整权限 · ${member.displayName}`, `
        <form class="form-grid" data-form="member-perms" data-account="${esc(member.accountId)}">
          <div class="notice">提交后将以所选权限覆盖该成员当前权限集合。</div>
          ${permissionCheckboxes(member.permissions || [])}
          <button class="primary-button" type="submit">保存权限</button>
        </form>
      `);
      return;
    }
    if (action === "member-status") {
      const status = target.dataset.status;
      if (status === "disabled" && !confirm("确认停用该成员？其活动会话将被立即吊销。")) return;
      await api(`/api/org/members/${encodeURIComponent(target.dataset.account)}/status`, {method: "POST", body: JSON.stringify({status})});
      await loadPage();
      return;
    }
    if (action === "agent-view-mode") {
      agentViewMode = target.dataset.mode;
      render();
      return;
    }
    if (action === "toggle-agent") {
      const agent = (state.agents || []).find((item) => item.id === target.dataset.agent);
      if (agent?.status === "active" && !confirm("确认停用该智能体档案？")) return;
      await api(`/api/agents/${encodeURIComponent(target.dataset.agent)}/activate`, {method: "POST", body: JSON.stringify({active: agent?.status !== "active"})});
      await loadPage();
      return;
    }
    if (action === "revoke-grant") {
      if (!confirm("确认撤销该访问授权？")) return;
      await api(`/api/access-grants/${encodeURIComponent(target.dataset.grant)}/revoke`, {method: "POST", body: "{}"});
      await loadPage();
      return;
    }
    if (action === "sync-skill-source") {
      await api(`/api/skill-sources/${encodeURIComponent(target.dataset.source)}/sync`, {method: "POST", body: "{}"});
      await loadPage();
      return;
    }
    if (action === "revoke-join-token") {
      if (!confirm("确认撤销该加入令牌？未使用的令牌将立即失效。")) return;
      await api(`/api/agent-join-tokens/${encodeURIComponent(target.dataset.tokenId)}/revoke`, {method: "POST", body: "{}"});
      await loadPage();
      return;
    }
    if (action === "revoke-agent-node") {
      if (!confirm("确认吊销该智能体节点？节点上运行中的任务将被围栏并重新排队。")) return;
      await api(`/api/agent-nodes/${encodeURIComponent(target.dataset.nodeId)}/revoke`, {method: "POST", body: "{}"});
      await loadPage();
      return;
    }
    if (action === "agent-control") {
      const command = target.dataset.command;
      if (command === "cancel_dispatch" && !confirm("确认取消该节点当前派发的任务？")) return;
      const node = [...(state.agentRuntimeNodes || []), ...orgAgentNodes].find((item) => item.nodeId === target.dataset.nodeId);
      const dispatchId = (node?.activeDispatchIds || node?.display?.currentDispatchIds || [])[0] || "";
      await api(`/api/agent-nodes/${encodeURIComponent(target.dataset.nodeId)}/control`, {
        method: "POST",
        body: JSON.stringify({commandType: command, dispatchId: dispatchId || undefined})
      });
      await loadPage();
      return;
    }
    if (action === "task-control") {
      const taskAction = target.dataset.taskAction;
      if (taskAction === "rebound_drift" && !confirm("确认执行纠偏？任务组健康度将标记为需关注并触发复核。")) return;
      await api(`/api/task-groups/${encodeURIComponent(target.dataset.task)}/control`, {method: "POST", body: JSON.stringify({action: taskAction})});
      await loadPage();
      return;
    }
    if (action === "tg-detail") {
      const taskGroupId = target.dataset.task;
      if (expandedTaskGroupId === taskGroupId) {
        expandedTaskGroupId = "";
        tgDetail = null;
        render();
      } else {
        expandedTaskGroupId = taskGroupId;
        tgDetail = null;
        render();
        await loadTaskGroupDetail(taskGroupId);
        render();
      }
      return;
    }
    if (action === "tg-config-reset") {
      if (!confirm("确认重置任务组配置？将删除全部自定义项并回到继承项目配置。")) return;
      await api(`/api/task-groups/${encodeURIComponent(target.dataset.task)}/config/reset`, {method: "POST", body: "{}"});
      await loadPage();
      return;
    }
    if (action === "cfg-add") {
      const container = document.querySelector(`[data-cfg-list='${target.dataset.target}']`);
      if (!container) return;
      const kind = target.dataset.kind;
      const html = kind === "repo" ? cfgRepoRow() : kind === "baseline" ? cfgBaselineRow() : kind === "role" ? cfgRoleRow() : cfgBusinessRow();
      container.insertAdjacentHTML("beforeend", html);
      formTouched = true;
      return;
    }
    if (action === "cfg-del") {
      target.closest(".cfg-row")?.remove();
      formTouched = true;
      return;
    }
    if (action === "show-dispatch-events") {
      execScope = {type: "dispatch", id: target.dataset.dispatchId || ""};
      execEvents = [];
      execCursor = 0;
      if (page !== "monitor") {
        page = "monitor";
        sessionStorage.setItem("aimac.page", page);
        await loadPage();
      }
      await loadExecEvents({reset: true});
      startExecPolling();
      render();
      return;
    }
    if (action === "show-session-events") {
      execScope = {type: "session", id: target.dataset.sessionId || ""};
      execEvents = [];
      execCursor = 0;
      if (page !== "monitor") {
        page = "monitor";
        sessionStorage.setItem("aimac.page", page);
        await loadPage();
      }
      await loadExecEvents({reset: true});
      startExecPolling();
      render();
      return;
    }
    if (action === "orchestrator-run") {
      await api("/api/orchestrator/run", {method: "POST", body: JSON.stringify({mode: "all"})});
      await loadPage();
      return;
    }
    if (action === "decide-model") {
      const taskGroup = projectTaskGroups()[0];
      const workItem = (taskGroup?.workItems || [])[0];
      if (!taskGroup || !workItem) throw new Error("当前项目暂无可用于模型决策的任务组和工作项");
      await api("/api/model-selection/decide", {method: "POST", body: JSON.stringify({taskGroupId: taskGroup.id, workItemId: workItem.id, roleId: "orchestrator"})});
      await loadPage();
      return;
    }
  } catch (error) {
    showError(error);
  }
});

/* ---------------- 自动刷新（5 秒） ---------------- */

setInterval(() => {
  if (!authToken || loading || modalHtml || formTouched) return;
  const active = document.activeElement;
  if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;
  loadPage().catch(() => {});
}, 5000);

/* ---------------- 启动 ---------------- */

if (authToken && currentAccount) {
  page = page || defaultPageFor(perspectiveOf(currentAccount));
  loadPage().then(() => {
    if (page === "monitor") {
      loadExecEvents({reset: true}).catch(() => {});
      startExecPolling();
    }
  }).catch((error) => {
    lastError = error?.message || String(error);
    render();
  });
} else {
  render();
}
