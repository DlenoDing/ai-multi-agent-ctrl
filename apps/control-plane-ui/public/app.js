const content = document.querySelector("#content");
const statusLine = document.querySelector("#status-line");
const viewTitle = document.querySelector("#view-title");
const viewSubtitle = document.querySelector("#view-subtitle");
const refreshButton = document.querySelector("#refresh");
const bootstrapButton = document.querySelector("#bootstrap");

const viewMeta = {
  system: ["系统管理", "系统级运行、初始化、审计、策略和安全控制"],
  users: ["用户管理", "账号、项目成员、Agent 激活和权限授权"],
  projects: ["项目总览", "项目状态、进度、成员和仓库输出归属"],
  tasks: ["任务组监控", "任务组阶段、角色、工作项、阻塞和控制操作"],
  runtime: ["AI Runtime", "模型选择、角色 Skill、会话放置和自治执行证据"],
  instructions: ["指令协议", "稳定前缀、增量载荷、缓存键和共享定义归属"]
};

let state = null;
let activeView = "system";
let authToken = localStorage.getItem("aimac.sessionToken") || "";
let currentAccount = JSON.parse(localStorage.getItem("aimac.account") || "null");
let lastError = "";
let lastJoinCommands = null;
let lastAccountInvite = null;
let selectedExecutionDispatchId = "";
let selectedExecutionScope = {type: "", id: ""};
let selectedExecutionEvents = [];
let selectedExecutionCursor = 0;
let executionPollTimer = null;
let expandedTaskGroupId = "";

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
    instructionMetrics: {stablePrefixTokens: 0, deltaMessageTargetTokens: 0, cacheHitTarget: 0, envelopes: []},
    auditLog: [],
    progressSnapshots: []
  };
}

function h(strings, ...values) {
  return strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function pill(status) {
  const value = escapeHtml(status);
  const tone = ["attention", "blocked", "paused", "failed", "inactive"].includes(status)
    ? "warn"
    : ["rejected", "revoked", "error"].includes(status)
      ? "bad"
      : ["review_requested", "initialized", "cache_indexed"].includes(status)
        ? "neutral"
        : "";
  return `<span class="pill ${tone}">${value}</span>`;
}

function progress(percent) {
  const safe = Math.max(0, Math.min(100, Number(percent || 0)));
  return `<div class="progress" aria-label="progress ${safe}%"><span style="width:${safe}%"></span></div>`;
}

function panel(title, body, extra = "") {
  return h`
    <article class="panel ${extra}">
      <div class="panel-header"><h2>${escapeHtml(title)}</h2></div>
      <div class="panel-body">${body}</div>
    </article>
  `;
}

function row(items) {
  return `<tr>${items.map((item) => `<td>${item}</td>`).join("")}</tr>`;
}

const terminalDispatchStatuses = new Set(["completed", "failed", "cancelled"]);

function isExecutionPollingView() {
  return ["runtime", "tasks"].includes(activeView);
}

function findWorkItemDispatch(taskGroupId, workItemId) {
  const candidates = (state.agentDispatches || [])
    .filter((dispatch) => dispatch.taskGroupId === taskGroupId && dispatch.workItemId === workItemId)
    .sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
  return candidates.find((dispatch) => !terminalDispatchStatuses.has(dispatch.status)) || candidates[0] || null;
}

function renderSelectedExecutionPanel() {
  const scope = selectedExecutionScope.id ? selectedExecutionScope : (selectedExecutionDispatchId ? {type: "dispatch", id: selectedExecutionDispatchId} : {type: "", id: ""});
  if (!scope.id) return "";
  const selectedEventRows = selectedExecutionEvents.slice().reverse().slice(0, 100).map((event) => row([
    escapeHtml(event.sequence),
    escapeHtml(event.eventType),
    `${escapeHtml(event.progressPercent)}%`,
    pill(event.status),
    escapeHtml(event.summary || "-"),
    escapeHtml(event.outputTailDigest || "-"),
    escapeHtml(event.createdAt)
  ])).join("");
  return panel(`${scope.type === "session" ? "Session" : "Dispatch"} 实时事件 ${scope.id}`, h`
    <table class="data-table">
      <thead><tr><th>Seq</th><th>事件</th><th>进度</th><th>状态</th><th>摘要</th><th>Tail Digest</th><th>时间</th></tr></thead>
      <tbody>${selectedEventRows || row(["-", "-", "-", "-", "-", "-", "-"])}</tbody>
    </table>
  `, "wide");
}

async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const idempotencyKey = `idem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const headers = {"content-type": "application/json", ...(options.headers || {})};
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  if (method !== "GET") headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(path, {
    ...options,
    headers,
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.json()).error || "";
    } catch {}
    throw new Error(`${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`);
  }
  return response.json();
}

function showError(error) {
  lastError = error.message || String(error);
  render();
}

function accountIdOf(account) {
  return account.accountId || account.id;
}

function grantSubjectId(grant) {
  return grant.subjectRef?.subjectId || grant.subjectId;
}

function grantResourceText(grant) {
  const resource = grant.resource || {resourceType: grant.resourceType, resourceId: grant.resourceId};
  return `${resource.resourceType}:${resource.resourceId}`;
}

const languageOptions = [
  ["zh-CN", "中文"],
  ["en", "English"],
  ["fr", "Français"],
  ["ja", "日本語"],
  ["de", "Deutsch"],
  ["es", "Español"]
];

function languagePolicyText(policy = {}) {
  const tag = policy.languageTag || "zh-CN";
  const label = policy.languageName || languageOptions.find(([value]) => value === tag)?.[1] || tag;
  return `${label} (${tag})`;
}

function languageOptionTags(selected) {
  const known = languageOptions.some(([value]) => value === selected);
  const options = (known ? languageOptions : [[selected, selected], ...languageOptions]).filter(([value]) => value);
  return options.map(([value, label]) => `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)} · ${escapeHtml(value)}</option>`).join("");
}

function envelopeTokens(envelope) {
  return envelope.tokenBudget?.targetDeltaTokens || envelope.estimatedTokens || "-";
}

async function load() {
  if (!authToken) {
    state = emptyState();
    render();
    return;
  }
  try {
    state = {...emptyState(), ...(await api(`/api/state?view=${encodeURIComponent(activeView)}&limit=120`))};
  } catch (error) {
    if (String(error.message || "").startsWith("401")) {
      authToken = "";
      currentAccount = null;
      localStorage.removeItem("aimac.sessionToken");
      localStorage.removeItem("aimac.account");
      state = emptyState();
    } else {
      throw error;
    }
  }
  render();
}

async function loadExecutionEvents(options = {}) {
  const scope = selectedExecutionScope.id ? selectedExecutionScope : (selectedExecutionDispatchId ? {type: "dispatch", id: selectedExecutionDispatchId} : {type: "", id: ""});
  if (!scope.id || !authToken) return;
  const after = options.reset ? 0 : selectedExecutionCursor;
  const waitMs = options.longPoll ? 2000 : 0;
  const path = scope.type === "session"
    ? `/api/work-sessions/${encodeURIComponent(scope.id)}/execution-events`
    : `/api/agent-dispatches/${encodeURIComponent(scope.id)}/events`;
  const result = await api(`${path}?afterSequence=${after}&limit=200&waitMs=${waitMs}`);
  if (options.reset) selectedExecutionEvents = [];
  const existing = new Set(selectedExecutionEvents.map((event) => event.eventId));
  for (const event of result.events || []) {
    if (!existing.has(event.eventId)) selectedExecutionEvents.push(event);
  }
  selectedExecutionEvents = selectedExecutionEvents.slice(-300);
  selectedExecutionCursor = Number(result.nextCursor || selectedExecutionCursor || 0);
}

function setExecutionPolling(enabled) {
  if (executionPollTimer) {
    clearInterval(executionPollTimer);
    executionPollTimer = null;
  }
  if (!enabled || !(selectedExecutionScope.id || selectedExecutionDispatchId) || !isExecutionPollingView()) return;
  executionPollTimer = setInterval(async () => {
    try {
      await loadExecutionEvents({longPoll: true});
      render();
    } catch (error) {
      lastError = error.message || String(error);
      render();
    }
  }, 2500);
}

function renderStatusLine() {
  const activeAgents = state.agents.filter((agent) => agent.status === "active").length;
  const openTaskGroups = state.taskGroups.filter((task) => !["closed", "aborted"].includes(task.status)).length;
  const blockers = state.taskGroups.flatMap((task) => task.blockers || []).length;
  const providers = new Set((state.modelCapabilities || []).map((profile) => profile.providerClass)).size;
  const onlineNodes = (state.agentRuntimeNodes || []).filter((node) => node.status === "online").length;
  const projectProgress = Math.round(
    state.projects.reduce((sum, project) => sum + (project.progress?.percent || 0), 0) / Math.max(1, state.projects.length)
  );

  statusLine.innerHTML = h`
    <div class="metric"><span>Runtime</span><strong>${escapeHtml(state.runtime.status)}</strong></div>
    <div class="metric"><span>Active Agents</span><strong>${activeAgents}/${state.agents.length}</strong></div>
    <div class="metric"><span>Open Task Groups</span><strong>${openTaskGroups}</strong></div>
    <div class="metric"><span>Model Providers</span><strong>${providers}</strong></div>
    <div class="metric"><span>Runtime Nodes</span><strong>${onlineNodes}/${(state.agentRuntimeNodes || []).length}</strong></div>
    <div class="metric"><span>Avg Project Progress</span><strong>${projectProgress}%</strong></div>
  `;

  if (blockers > 0) {
    statusLine.insertAdjacentHTML("beforeend", `<div class="metric"><span>Blockers</span><strong>${blockers}</strong></div>`);
  }
}

function authPanel() {
  return panel("登录", h`
    <form id="login-form" class="form-grid">
      <div class="notice">写操作必须使用管理账号登录后的 bearer session。系统管理员使用 bootstrap token，用户管理账号使用对应账号 token。</div>
      <div class="form-row"><label for="loginEmail">账号</label><input id="loginEmail" name="email" value="${escapeHtml(currentAccount?.email || "owner@local")}" required></div>
      <div class="form-row"><label for="loginToken">登录 Token</label><input id="loginToken" name="token" type="password" required></div>
      <button class="primary-button" type="submit">登录</button>
    </form>
  `);
}

function errorPanel() {
  return lastError ? panel("操作错误", `<div class="notice error-notice">${escapeHtml(lastError)}</div>`) : "";
}

function renderSystem() {
  const services = state.runtime.services.map((service) => row([
    escapeHtml(service.serviceId || service.id),
    pill(service.status),
    pill(service.health)
  ])).join("");
  const admins = state.accounts
    .filter((account) => account.accountType === "system_admin")
    .map((account) => row([
      escapeHtml(account.displayName),
      escapeHtml(account.email),
      pill(account.status),
      escapeHtml(account.roles.join(", "))
    ])).join("");
  const audit = state.auditLog.slice(0, 12).map((entry) => row([
    escapeHtml(entry.at),
    escapeHtml(entry.actor),
    escapeHtml(entry.action),
    escapeHtml(entry.subject),
    pill(entry.result)
  ])).join("");

  content.innerHTML = [
    errorPanel(),
    authToken ? panel("当前会话", h`
      <div class="record-title"><strong>${escapeHtml(currentAccount?.displayName || currentAccount?.email || "authenticated")}</strong>${pill("authenticated")}</div>
      <div class="button-row"><button class="secondary-button" data-action="logout">退出</button></div>
    `) : authPanel(),
    panel("运行入口", h`
      <div class="stack">
        <div class="notice">支持 npm、Docker、Shell 直接启动；初始化只写入本地运行态目录，项目产出文件始终进入对应项目 Git 仓库。</div>
        <table class="data-table">
          <thead><tr><th>方式</th><th>命令</th><th>用途</th></tr></thead>
          <tbody>
            ${row(["npm", "<span class='mono'>npm run init && npm start</span>", "初始化并启动控制台"])}
            ${row(["Docker", "<span class='mono'>npm run docker:up</span>", "生成缺失环境值并容器化启动"])}
            ${row(["Shell", "<span class='mono'>npm run shell:start</span>", "脚本入口"])}
          </tbody>
        </table>
      </div>
    `),
    panel("系统服务", h`
      <table class="data-table">
        <thead><tr><th>服务</th><th>状态</th><th>健康度</th></tr></thead>
        <tbody>${services}</tbody>
      </table>
    `),
    panel("系统管理员", h`
      <table class="data-table">
        <thead><tr><th>账号</th><th>邮箱</th><th>状态</th><th>角色</th></tr></thead>
        <tbody>${admins}</tbody>
      </table>
    `),
    panel("防护操作", h`
      <div class="stack">
        <div class="record"><div class="record-title"><strong>策略导入</strong>${pill("system_quorum_required")}</div><div class="record-meta">仅系统管理面可见，执行前必须有 DecisionRecord 和审计引用。</div></div>
        <div class="record"><div class="record-title"><strong>运行升级导入</strong>${pill("external_maintenance_only")}</div><div class="record-meta">运行中只收集问题模式，升级由系统外维护流程导入。</div></div>
        <div class="record"><div class="record-title"><strong>共享定义发布</strong>${pill("owner_required")}</div><div class="record-meta">总控先确定 owner 和 producer，消费者只能引用已发布 digest。</div></div>
      </div>
    `),
    panel("审计", h`
      <table class="data-table">
        <thead><tr><th>时间</th><th>Actor</th><th>动作</th><th>对象</th><th>结果</th></tr></thead>
        <tbody>${audit || row(["-", "-", "-", "-", "-"])}</tbody>
      </table>
    `, "wide")
  ].join("");

  const loginForm = document.querySelector("#login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.target);
      try {
        const result = await api("/api/auth/login", {method: "POST", body: JSON.stringify(Object.fromEntries(form.entries()))});
        authToken = result.sessionToken;
        currentAccount = result.account;
        localStorage.setItem("aimac.sessionToken", authToken);
        localStorage.setItem("aimac.account", JSON.stringify(currentAccount));
        lastError = "";
        await load();
      } catch (error) {
        showError(error);
      }
    });
  }
}

function renderUsers() {
  const canCreateSystemAccount = currentAccount?.accountType === "system_admin" || (currentAccount?.permissions || []).includes("system:*");
  const accountTypeOptions = [
    `<option value="user_account">用户账号</option>`,
    canCreateSystemAccount ? `<option value="system_admin">系统管理员</option>` : "",
    `<option value="service_account">服务账号</option>`
  ].join("");
  const accounts = state.accounts.map((account) => row([
    escapeHtml(account.displayName),
    escapeHtml(account.email),
    escapeHtml(account.accountType),
    pill(account.status),
    escapeHtml(account.roles.join(", "))
  ])).join("");
  const grants = state.accessGrants.map((grant) => row([
    escapeHtml(grantSubjectId(grant)),
    escapeHtml(grantResourceText(grant)),
    escapeHtml(grant.role),
    pill(grant.status),
    escapeHtml(grant.permissions.join(", ")),
    grant.status === "active" ? `<button class="secondary-button" data-action="revoke-grant" data-grant="${escapeHtml(grant.grantId)}">撤销</button>` : "-"
  ])).join("");
  const agents = state.agents.map((agent) => row([
    escapeHtml(agent.name),
    escapeHtml(agent.role),
    escapeHtml(agent.model),
    pill(agent.status),
    `<button class="secondary-button" data-action="toggle-agent" data-agent="${escapeHtml(agent.id)}">${agent.status === "active" ? "停用" : "激活"}</button>`
  ])).join("");

  content.innerHTML = [
    panel("邀请账号", h`
      <form id="invite-form" class="form-grid">
        <div class="form-row"><label for="displayName">显示名</label><input id="displayName" name="displayName" required></div>
        <div class="form-row"><label for="email">邮箱</label><input id="email" name="email" type="email" required></div>
        <div class="form-row">
          <label for="accountType">账号类型</label>
          <select id="accountType" name="accountType">
            ${accountTypeOptions}
          </select>
        </div>
        <div class="form-row"><label for="inviteRoles">角色</label><input id="inviteRoles" name="roles" value="viewer"></div>
        <div class="form-row"><label for="invitePermissions">默认权限</label><input id="invitePermissions" name="permissions" value="project:view"></div>
        <button class="primary-button" type="submit">邀请</button>
      </form>
      ${lastAccountInvite ? h`
        <div class="command-box">
          <strong>账号登录凭据</strong>
          <pre>email=${escapeHtml(lastAccountInvite.account?.email || lastAccountInvite.login?.email || "")}
accountToken=${escapeHtml(lastAccountInvite.accountToken || "")}
expiresAt=${escapeHtml(lastAccountInvite.tokenExpiresAt || "")}</pre>
        </div>
      ` : ""}
    `),
    panel("Agent 激活", h`
      <form id="agent-form" class="form-grid compact-form">
        <div class="form-row"><label for="agentName">Agent</label><input id="agentName" name="name" required></div>
        <div class="form-row"><label for="agentRole">角色</label><input id="agentRole" name="role" value="reviewer" required></div>
        <div class="form-row"><label for="agentModel">模型策略</label><select id="agentModel" name="model"><option value="auto_best">auto_best</option><option value="auto_fast">auto_fast</option><option value="cost_aware">cost_aware</option></select></div>
        <button class="primary-button" type="submit">创建 Agent</button>
      </form>
      <table class="data-table">
        <thead><tr><th>Agent</th><th>角色</th><th>模型</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>${agents}</tbody>
      </table>
    `),
    panel("账号", h`
      <table class="data-table">
        <thead><tr><th>账号</th><th>邮箱</th><th>类型</th><th>状态</th><th>角色</th></tr></thead>
        <tbody>${accounts}</tbody>
      </table>
    `, "wide"),
    panel("授权", h`
      <form id="grant-form" class="form-grid compact-form">
        <div class="form-row"><label for="grantSubject">账号 ID</label><input id="grantSubject" name="subjectId" value="acct_workspace_owner" required></div>
        <div class="form-row"><label for="grantResourceType">资源类型</label><select id="grantResourceType" name="resourceType"><option value="project">项目</option><option value="task_group">任务组</option></select></div>
        <div class="form-row"><label for="grantResourceId">资源 ID</label><input id="grantResourceId" name="resourceId" value="prj_control_plane" required></div>
        <div class="form-row"><label for="grantRole">角色</label><input id="grantRole" name="role" value="viewer"></div>
        <div class="form-row"><label for="grantPermissions">权限</label><input id="grantPermissions" name="permissions" value="project:view"></div>
        <button class="primary-button" type="submit">新增授权</button>
      </form>
      <table class="data-table">
        <thead><tr><th>主体</th><th>资源</th><th>角色</th><th>状态</th><th>权限</th><th>操作</th></tr></thead>
        <tbody>${grants}</tbody>
      </table>
    `, "wide")
  ].join("");

  document.querySelector("#invite-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      lastAccountInvite = await api("/api/accounts", {method: "POST", body: JSON.stringify(Object.fromEntries(form.entries()))});
      lastError = "";
      await load();
    } catch (error) {
      showError(error);
    }
  });

  document.querySelector("#grant-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await api("/api/access-grants", {method: "POST", body: JSON.stringify(Object.fromEntries(form.entries()))});
      lastError = "";
      await load();
    } catch (error) {
      showError(error);
    }
  });

  document.querySelector("#agent-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await api("/api/agents", {method: "POST", body: JSON.stringify(Object.fromEntries(form.entries()))});
      lastError = "";
      await load();
    } catch (error) {
      showError(error);
    }
  });
}

function renderProjects() {
  const projectRows = state.projects.map((project) => {
    const members = project.members.map((member) => `${member.accountId}:${member.role}`).join(", ");
    return row([
      escapeHtml(project.name),
      pill(project.status),
      `${project.progress.percent}% ${progress(project.progress.percent)}`,
      escapeHtml(project.progress.phase),
      pill(project.progress.health),
      escapeHtml(members)
    ]);
  }).join("");
  const repositoryRows = (state.repositoryOutputs || []).map((target) => row([
    escapeHtml(target.taskGroupId),
    escapeHtml(target.workItemId),
    escapeHtml(target.repositoryId),
    escapeHtml(target.branch),
    pill(target.status),
    escapeHtml(target.pathAllowlist.join(", "))
  ])).join("");

  content.innerHTML = [
    panel("创建项目", h`
      <form id="project-form" class="form-grid">
        <div class="form-row"><label for="projectName">项目名称</label><input id="projectName" name="name" required></div>
        <div class="form-row">
          <label for="ownerAccountId">Owner</label>
          <select id="ownerAccountId" name="ownerAccountId">
            ${state.accounts.map((account) => `<option value="${escapeHtml(accountIdOf(account))}">${escapeHtml(account.displayName)}</option>`).join("")}
          </select>
        </div>
        <button class="primary-button" type="submit">创建</button>
      </form>
    `),
    panel("项目成员授权", h`
      <form id="member-form" class="form-grid">
        <div class="form-row">
          <label for="projectId">项目</label>
          <select id="projectId" name="projectId">${state.projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("")}</select>
        </div>
        <div class="form-row">
          <label for="memberAccountId">账号</label>
          <select id="memberAccountId" name="accountId">${state.accounts.map((account) => `<option value="${escapeHtml(accountIdOf(account))}">${escapeHtml(account.displayName)}</option>`).join("")}</select>
        </div>
        <div class="form-row">
          <label for="memberRole">角色</label>
          <select id="memberRole" name="role">
            <option value="project_owner">项目 Owner</option>
            <option value="project_admin">项目管理员</option>
            <option value="task_group_owner">任务组 Owner</option>
            <option value="agent_operator">Agent 操作员</option>
            <option value="viewer">观察者</option>
          </select>
        </div>
        <button class="primary-button" type="submit">授权</button>
      </form>
    `),
    panel("Agent 入网授权", h`
      <form id="join-token-form" class="form-grid compact-form">
        <div class="form-row">
          <label for="joinProjectId">项目</label>
          <select id="joinProjectId" name="projectId">${state.projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("")}</select>
        </div>
        <div class="form-row"><label for="joinNodeName">节点名</label><input id="joinNodeName" name="nodeName" placeholder="可留空"></div>
        <div class="form-row"><label for="joinRoles">角色范围</label><input id="joinRoles" name="allowedRoles" value="agent-runtime"></div>
        <div class="form-row"><label for="joinTtl">有效秒数</label><input id="joinTtl" name="ttlSeconds" type="number" min="60" max="86400" value="1800"></div>
        <button class="primary-button" type="submit">生成一次性 Agent 注册命令</button>
      </form>
      ${lastJoinCommands ? `<pre class="command-output">${escapeHtml(["direct:", lastJoinCommands.installCommand, "", "verified:", lastJoinCommands.verifiedInstallCommand].join("\n"))}</pre>` : ""}
    `, "wide"),
    panel("项目状态", h`
      <table class="data-table">
        <thead><tr><th>项目</th><th>状态</th><th>进度</th><th>阶段</th><th>健康度</th><th>成员</th></tr></thead>
        <tbody>${projectRows}</tbody>
      </table>
    `, "wide"),
    panel("仓库产出归属", h`
      <div class="stack">
        <div class="notice">任务产出文件不进入独立文件库。总控为每个任务确定 project repository target，执行角色只在对应 Git 仓库、分支和路径内写入，并以 CommitRef、PushRef、artifact manifest 引用结果。</div>
        <table class="data-table">
          <thead><tr><th>任务组</th><th>工作项</th><th>仓库</th><th>分支</th><th>状态</th><th>路径</th></tr></thead>
          <tbody>${repositoryRows || row(["-", "-", "-", "-", "-", "-"])}</tbody>
        </table>
      </div>
    `, "wide")
  ].join("");

  document.querySelector("#project-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await api("/api/projects", {method: "POST", body: JSON.stringify(Object.fromEntries(form.entries()))});
      lastError = "";
      await load();
    } catch (error) {
      showError(error);
    }
  });

  document.querySelector("#member-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const data = Object.fromEntries(form.entries());
    try {
      await api(`/api/projects/${data.projectId}/members`, {method: "POST", body: JSON.stringify(data)});
      lastError = "";
      await load();
    } catch (error) {
      showError(error);
    }
  });

  document.querySelector("#join-token-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target).entries());
    data.allowedRoles = String(data.allowedRoles || "agent-runtime").split(",").map((item) => item.trim()).filter(Boolean);
    data.ttlSeconds = Number(data.ttlSeconds || 1800);
    data.maxUses = 1;
    try {
      const result = await api("/api/agent-join-tokens", {method: "POST", body: JSON.stringify(data)});
      lastJoinCommands = {installCommand: result.installCommand, verifiedInstallCommand: result.verifiedInstallCommand};
      lastError = "";
      await load();
    } catch (error) {
      showError(error);
    }
  });
}

function renderTasks() {
  const taskGroups = state.taskGroups.map((taskGroup) => {
    const expanded = expandedTaskGroupId === taskGroup.id;
    const languagePolicy = taskGroup.languagePolicy || {languageTag: "zh-CN", languageName: "Chinese"};
    const workItems = (taskGroup.workItems || []).map((workItem) => {
      const dispatch = findWorkItemDispatch(taskGroup.id, workItem.id);
      return h`
        <div class="record">
          <div class="record-title"><strong>${escapeHtml(workItem.title)}</strong>${pill(workItem.status)}</div>
          ${progress(workItem.progress)}
          <div class="record-meta"><span>${escapeHtml(workItem.ownerRole)}</span><span>${workItem.progress}%</span></div>
          ${dispatch ? h`
            <div class="record-meta">
              <span>dispatch: ${escapeHtml(dispatch.dispatchId)}</span>
              <span>${pill(dispatch.status)} ${escapeHtml(dispatch.progressPercent || 0)}%</span>
            </div>
            <div class="button-row">
              <button class="secondary-button" data-action="show-dispatch-events" data-dispatch-id="${escapeHtml(dispatch.dispatchId)}">实时事件</button>
            </div>
          ` : ""}
        </div>
      `;
    }).join("");
    const roles = (taskGroup.roles || []).map((role) => `${role.roleId}:${role.status}`).join(", ");
    const blockers = (taskGroup.blockers || []).length
      ? (taskGroup.blockers || []).map((blocker) => `<div class="record"><strong>${escapeHtml(blocker.severity)}</strong><span>${escapeHtml(blocker.summary)}</span></div>`).join("")
      : "<div class='record'>无阻塞</div>";
    const languageForm = h`
      <form class="form-grid compact-form" data-language-policy-form data-task="${escapeHtml(taskGroup.id)}">
        <div class="form-row">
          <label for="language-${escapeHtml(taskGroup.id)}">任务组语言</label>
          <select id="language-${escapeHtml(taskGroup.id)}" name="languageTag">${languageOptionTags(languagePolicy.languageTag || "zh-CN")}</select>
        </div>
        <div class="form-row"><label for="language-name-${escapeHtml(taskGroup.id)}">显示名</label><input id="language-name-${escapeHtml(taskGroup.id)}" name="languageName" value="${escapeHtml(languagePolicy.languageName || "")}"></div>
        <button class="primary-button" type="submit">保存语言策略</button>
      </form>
    `;
    return panel(taskGroup.name || taskGroup.title || taskGroup.id, h`
      <div class="stack">
        <div class="record-title"><strong>${escapeHtml(taskGroup.phase)}</strong><span>${pill(taskGroup.status)} ${pill(taskGroup.goalExecutionStatus || "active")}</span></div>
        ${progress(taskGroup.progress)}
        <div class="record-meta"><span>health: ${escapeHtml(taskGroup.health)}</span><span>language: ${escapeHtml(languagePolicyText(languagePolicy))}</span><span>roles: ${escapeHtml(roles)}</span></div>
        <div class="button-row">
          <button class="secondary-button" data-action="toggle-task-detail" data-task="${escapeHtml(taskGroup.id)}">${expanded ? "收起详情" : "查看详情"}</button>
          <button class="secondary-button" data-action="task-control" data-task="${escapeHtml(taskGroup.id)}" data-task-action="pause">暂停</button>
          <button class="secondary-button" data-action="task-control" data-task="${escapeHtml(taskGroup.id)}" data-task-action="resume">恢复</button>
          <button class="secondary-button" data-action="task-control" data-task="${escapeHtml(taskGroup.id)}" data-task-action="request_review">复验</button>
          <button class="danger-button" data-action="task-control" data-task="${escapeHtml(taskGroup.id)}" data-task-action="rebound_drift">纠偏</button>
        </div>
        ${expanded ? h`
          ${languageForm}
          <div class="stack">${workItems}</div>
          <div class="stack">${blockers}</div>
        ` : ""}
      </div>
    `, "wide");
  }).join("");

  content.innerHTML = [taskGroups, renderSelectedExecutionPanel()].join("");
  document.querySelectorAll("[data-language-policy-form]").forEach((form) => {
    form.querySelector("select[name='languageTag']")?.addEventListener("change", (event) => {
      const label = event.target.selectedOptions[0]?.textContent?.split(" · ")[0] || event.target.value;
      form.querySelector("input[name='languageName']").value = label;
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target).entries());
      try {
        await api(`/api/task-groups/${event.target.dataset.task}/language-policy`, {method: "POST", body: JSON.stringify(data)});
        lastError = "";
        await load();
      } catch (error) {
        showError(error);
      }
    });
  });
}

function renderRuntime() {
  const nodeRows = (state.agentRuntimeNodes || []).map((node) => row([
    escapeHtml(node.nodeName),
    escapeHtml(node.nodeId),
    escapeHtml((node.projectIds || []).join(", ")),
    escapeHtml((node.allowedRoles || []).join(", ")),
    pill(node.status),
    pill(node.admission),
    escapeHtml(node.lastHeartbeatAt || "-"),
    node.status !== "revoked" ? [
      `<button class="secondary-button" data-action="agent-control" data-node-id="${escapeHtml(node.nodeId)}" data-command="refresh_profile">刷新</button>`,
      `<button class="secondary-button" data-action="agent-control" data-node-id="${escapeHtml(node.nodeId)}" data-command="pause_dispatch">暂停</button>`,
      `<button class="danger-button" data-action="agent-control" data-node-id="${escapeHtml(node.nodeId)}" data-command="cancel_dispatch">取消</button>`,
      `<button class="secondary-button" data-action="revoke-agent-node" data-node-id="${escapeHtml(node.nodeId)}">撤销</button>`
    ].join(" ") : "-"
  ])).join("");
  const joinTokenRows = (state.agentJoinTokens || []).slice(0, 20).map((token) => row([
    escapeHtml(token.joinTokenId),
    escapeHtml(token.projectId),
    escapeHtml((token.allowedRoles || []).join(", ")),
    pill(token.status),
    `${token.useCount}/${token.maxUses}`,
    escapeHtml(token.expiresAt),
    token.status === "issued" ? `<button class="secondary-button" data-action="revoke-join-token" data-token-id="${escapeHtml(token.joinTokenId)}">撤销</button>` : "-"
  ])).join("");
  const sources = (state.skillSources || []).map((source) => row([
    escapeHtml(source.sourceId),
    pill(source.status),
    escapeHtml(source.pinnedCommit),
    String((state.roleSkills || []).filter((skill) => skill.sourceId === source.sourceId).length),
    `<button class="secondary-button" data-action="sync-skill-source" data-source="${escapeHtml(source.sourceId)}">同步</button>`
  ])).join("");
  const modelRows = (state.modelCapabilities || []).slice(0, 24).map((profile) => row([
    escapeHtml(profile.providerClass),
    escapeHtml(profile.modelId),
    escapeHtml(profile.strengths.slice(0, 5).join(", ")),
    escapeHtml(profile.limits.contextWindowTokens),
    pill(profile.availability)
  ])).join("");
  const decisions = (state.modelSelectionDecisions || []).slice(0, 12).map((decision) => row([
    escapeHtml(decision.roleId),
    escapeHtml(decision.workItemId),
    escapeHtml(decision.selectedModel?.modelId || "-"),
    pill(decision.status),
    escapeHtml(decision.modelDecision || decision.selectionMode)
  ])).join("");
  const placements = (state.sessionPlacementDecisions || []).slice(0, 12).map((decision) => row([
    escapeHtml(decision.workItemId),
    escapeHtml(decision.placement),
    pill(decision.status),
    escapeHtml(decision.workSignals.join(", "))
  ])).join("");
  const sessions = (state.workSessions || []).slice(0, 12).map((session) => row([
    escapeHtml(session.sessionId),
    escapeHtml(session.roleId),
    escapeHtml(session.workItemId),
    escapeHtml(session.placement),
    pill(session.status),
    `<button class="secondary-button" data-action="show-session-events" data-session-id="${escapeHtml(session.sessionId)}">事件</button>`
  ])).join("");
  const dispatches = (state.agentDispatches || []).slice(0, 12).map((dispatch) => row([
    escapeHtml(dispatch.dispatchId),
    escapeHtml(dispatch.workItemId),
    escapeHtml(dispatch.deliveryMode),
    pill(dispatch.status),
    `${escapeHtml(dispatch.progressPercent || 0)}%`,
    escapeHtml(dispatch.repositoryOutputTargetRef),
    escapeHtml(dispatch.blockedReason || dispatch.failureReason || "-"),
    `<button class="secondary-button" data-action="show-dispatch-events" data-dispatch-id="${escapeHtml(dispatch.dispatchId)}">事件</button>`
  ])).join("");
  const closeRows = (state.closeBarriers || []).slice(0, 8).map((barrier) => row([
    escapeHtml(barrier.taskGroupId),
    barrier.satisfied ? pill("satisfied") : pill("blocked"),
    String(barrier.blockingObjects.length),
    escapeHtml(barrier.computedAt)
  ])).join("");
  const controlRows = (state.agentControlCommands || []).slice(0, 16).map((command) => row([
    escapeHtml(command.sequence),
    escapeHtml(command.nodeId),
    escapeHtml(command.commandType),
    escapeHtml(command.dispatchId || command.sessionId || "-"),
    pill(command.status),
    escapeHtml(command.updatedAt || command.createdAt)
  ])).join("");
  const eventRows = (state.agentExecutionEvents || []).slice(0, 20).map((event) => row([
    escapeHtml(event.sequence),
    escapeHtml(event.dispatchId),
    escapeHtml(event.eventType),
    `${escapeHtml(event.progressPercent)}%`,
    pill(event.status),
    escapeHtml(event.summary || "-"),
    escapeHtml(event.createdAt)
  ])).join("");
  content.innerHTML = [
    panel("自治控制", h`
      <div class="button-row">
        <button class="primary-button" data-action="orchestrator-run">运行自治循环</button>
        <button class="secondary-button" data-action="decide-model">模型决策</button>
      </div>
    `),
    panel("Agent Runtime 节点", h`
      <table class="data-table">
        <thead><tr><th>节点</th><th>Node ID</th><th>项目</th><th>角色</th><th>状态</th><th>准入</th><th>心跳</th><th>操作</th></tr></thead>
        <tbody>${nodeRows || row(["-", "-", "-", "-", "-", "-", "-", "-"])}</tbody>
      </table>
    `, "wide"),
    panel("Agent 控制通道", h`
      <table class="data-table">
        <thead><tr><th>Seq</th><th>Node</th><th>命令</th><th>Scope</th><th>状态</th><th>更新时间</th></tr></thead>
        <tbody>${controlRows || row(["-", "-", "-", "-", "-", "-"])}</tbody>
      </table>
    `, "wide"),
    panel("执行事件流", h`
      <table class="data-table">
        <thead><tr><th>Seq</th><th>Dispatch</th><th>事件</th><th>进度</th><th>状态</th><th>摘要</th><th>时间</th></tr></thead>
        <tbody>${eventRows || row(["-", "-", "-", "-", "-", "-", "-"])}</tbody>
      </table>
    `, "wide"),
    panel("一次性 Join Token", h`
      <table class="data-table">
        <thead><tr><th>ID</th><th>项目</th><th>角色</th><th>状态</th><th>使用</th><th>过期</th><th>操作</th></tr></thead>
        <tbody>${joinTokenRows || row(["-", "-", "-", "-", "-", "-", "-"])}</tbody>
      </table>
    `, "wide"),
    panel("Skill Registry", h`
      <table class="data-table">
        <thead><tr><th>Source</th><th>状态</th><th>Pinned Commit</th><th>角色数</th><th>操作</th></tr></thead>
        <tbody>${sources}</tbody>
      </table>
    `),
    panel("Model Registry", h`
      <table class="data-table">
        <thead><tr><th>Provider</th><th>Model</th><th>能力</th><th>Context</th><th>可用性</th></tr></thead>
        <tbody>${modelRows}</tbody>
      </table>
    `, "wide"),
    panel("模型选择记录", h`
      <table class="data-table">
        <thead><tr><th>角色</th><th>Work</th><th>模型</th><th>状态</th><th>modelDecision</th></tr></thead>
        <tbody>${decisions || row(["-", "-", "-", "-", "-"])}</tbody>
      </table>
    `),
    panel("会话放置记录", h`
      <table class="data-table">
        <thead><tr><th>Work</th><th>Placement</th><th>状态</th><th>Signals</th></tr></thead>
        <tbody>${placements || row(["-", "-", "-", "-"])}</tbody>
      </table>
    `),
    panel("Work Sessions", h`
      <table class="data-table">
        <thead><tr><th>Session</th><th>角色</th><th>Work</th><th>Placement</th><th>状态</th><th>详情</th></tr></thead>
        <tbody>${sessions || row(["-", "-", "-", "-", "-", "-"])}</tbody>
      </table>
    `, "wide"),
    panel("Agent Dispatch Outbox", h`
      <table class="data-table">
        <thead><tr><th>Dispatch</th><th>Work</th><th>模式</th><th>状态</th><th>进度</th><th>仓库目标</th><th>原因</th><th>详情</th></tr></thead>
        <tbody>${dispatches || row(["-", "-", "-", "-", "-", "-", "-", "-"])}</tbody>
      </table>
    `, "wide"),
    renderSelectedExecutionPanel(),
    panel("Close Barrier", h`
      <table class="data-table">
        <thead><tr><th>任务组</th><th>状态</th><th>阻塞数</th><th>计算时间</th></tr></thead>
        <tbody>${closeRows || row(["-", "-", "-", "-"])}</tbody>
      </table>
    `, "wide")
  ].join("");

}

function renderInstructions() {
  const metrics = state.instructionMetrics;
  const envelopes = metrics.envelopes.map((envelope) => row([
    escapeHtml(envelope.envelopeId || envelope.id),
    escapeHtml(envelope.recipientRole),
    escapeHtml(envelope.cacheKey),
    pill(envelope.status),
    escapeHtml(envelopeTokens(envelope))
  ])).join("");
  const definitions = state.sharedDefinitions.map((definition) => row([
    escapeHtml(definition.contractId || definition.id),
    escapeHtml(definition.definitionType),
    escapeHtml(definition.canonicalOwnerRole),
    escapeHtml(definition.producerRole),
    pill(definition.status),
    escapeHtml(definition.consumerRefs.join(", "))
  ])).join("");

  content.innerHTML = [
    panel("指令压缩策略", h`
      <div class="stack">
        <div class="record"><div class="record-title"><strong>稳定前缀 tokens</strong><span>${metrics.stablePrefixTokens}</span></div></div>
        <div class="record"><div class="record-title"><strong>增量消息目标 tokens</strong><span>${metrics.deltaMessageTargetTokens}</span></div></div>
        <div class="record"><div class="record-title"><strong>缓存命中目标</strong><span>${Math.round(metrics.cacheHitTarget * 100)}%</span></div></div>
      </div>
    `),
    panel("Instruction Envelopes", h`
      <table class="data-table">
        <thead><tr><th>ID</th><th>角色</th><th>Cache Key</th><th>状态</th><th>Tokens</th></tr></thead>
        <tbody>${envelopes}</tbody>
      </table>
    `),
    panel("共享定义归属", h`
      <table class="data-table">
        <thead><tr><th>定义</th><th>类型</th><th>Owner</th><th>Producer</th><th>状态</th><th>消费者</th></tr></thead>
        <tbody>${definitions}</tbody>
      </table>
    `, "wide")
  ].join("");
}

function render() {
  const [title, subtitle] = viewMeta[activeView];
  viewTitle.textContent = title;
  viewSubtitle.textContent = subtitle;
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === activeView));
  renderStatusLine();

  if (activeView === "system") renderSystem();
  if (activeView === "users") renderUsers();
  if (activeView === "projects") renderProjects();
  if (activeView === "tasks") renderTasks();
  if (activeView === "runtime") renderRuntime();
  if (activeView === "instructions") renderInstructions();
  if (lastError && !content.querySelector(".error-notice")) {
    content.insertAdjacentHTML("afterbegin", errorPanel());
  }
}

document.querySelector(".nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (!button) return;
  activeView = button.dataset.view;
  setExecutionPolling(isExecutionPollingView());
  load().catch(showError);
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  try {
    if (target.dataset.action === "logout") {
      authToken = "";
      currentAccount = null;
      localStorage.removeItem("aimac.sessionToken");
      localStorage.removeItem("aimac.account");
      render();
      return;
    }
    if (target.dataset.action === "toggle-agent") {
      const agent = state.agents.find((item) => item.id === target.dataset.agent);
      await api(`/api/agents/${target.dataset.agent}/activate`, {method: "POST", body: JSON.stringify({active: agent.status !== "active"})});
      lastError = "";
      await load();
    }
    if (target.dataset.action === "task-control") {
      await api(`/api/task-groups/${target.dataset.task}/control`, {method: "POST", body: JSON.stringify({action: target.dataset.taskAction})});
      lastError = "";
      await load();
    }
    if (target.dataset.action === "toggle-task-detail") {
      expandedTaskGroupId = expandedTaskGroupId === target.dataset.task ? "" : target.dataset.task;
      render();
    }
    if (target.dataset.action === "revoke-grant") {
      await api(`/api/access-grants/${target.dataset.grant}/revoke`, {method: "POST", body: "{}"});
      lastError = "";
      await load();
    }
    if (target.dataset.action === "sync-skill-source") {
      await api(`/api/skill-sources/${target.dataset.source}/sync`, {method: "POST", body: "{}"});
      lastError = "";
      await load();
    }
    if (target.dataset.action === "orchestrator-run") {
      await api("/api/orchestrator/run", {method: "POST", body: JSON.stringify({mode: "all"})});
      lastError = "";
      await load();
    }
    if (target.dataset.action === "revoke-join-token") {
      await api(`/api/agent-join-tokens/${target.dataset.tokenId}/revoke`, {method: "POST", body: "{}"});
      lastError = "";
      await load();
    }
    if (target.dataset.action === "revoke-agent-node") {
      await api(`/api/agent-nodes/${target.dataset.nodeId}/revoke`, {method: "POST", body: "{}"});
      lastError = "";
      await load();
    }
    if (target.dataset.action === "agent-control") {
      const nodeId = target.dataset.nodeId;
      const node = (state.agentRuntimeNodes || []).find((item) => item.nodeId === nodeId);
      const dispatchId = (node?.activeDispatchIds || [])[0] || "";
      await api(`/api/agent-nodes/${nodeId}/control`, {
        method: "POST",
        body: JSON.stringify({commandType: target.dataset.command, dispatchId: dispatchId || undefined})
      });
      lastError = "";
      await load();
    }
    if (target.dataset.action === "show-dispatch-events") {
      selectedExecutionDispatchId = target.dataset.dispatchId || "";
      selectedExecutionScope = {type: "dispatch", id: selectedExecutionDispatchId};
      selectedExecutionCursor = 0;
      selectedExecutionEvents = [];
      await loadExecutionEvents({reset: true});
      setExecutionPolling(true);
      lastError = "";
      render();
    }
    if (target.dataset.action === "show-session-events") {
      selectedExecutionDispatchId = "";
      selectedExecutionScope = {type: "session", id: target.dataset.sessionId || ""};
      selectedExecutionCursor = 0;
      selectedExecutionEvents = [];
      await loadExecutionEvents({reset: true});
      setExecutionPolling(true);
      lastError = "";
      render();
    }
    if (target.dataset.action === "decide-model") {
      await api("/api/model-selection/decide", {method: "POST", body: JSON.stringify({taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", roleId: "ui-console-service"})});
      lastError = "";
      await load();
    }
  } catch (error) {
    showError(error);
  }
});

refreshButton.addEventListener("click", load);
bootstrapButton.addEventListener("click", async () => {
  try {
    await api("/api/bootstrap/init", {method: "POST", body: "{}"});
    lastError = "";
    await load();
  } catch (error) {
    showError(error);
  }
});

load().catch((error) => {
  content.innerHTML = `<article class="panel wide"><div class="panel-body">加载失败：${escapeHtml(error.message)}</div></article>`;
});
