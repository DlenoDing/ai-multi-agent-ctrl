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
  instructions: ["指令协议", "稳定前缀、增量载荷、缓存键和共享定义归属"]
};

let state = null;
let activeView = "system";

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
      : ["review_requested", "simulated", "initialized", "cache_indexed"].includes(status)
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

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {"content-type": "application/json"},
    ...options
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function load() {
  state = await api("/api/state");
  render();
}

function renderStatusLine() {
  const activeAgents = state.agents.filter((agent) => agent.status === "active").length;
  const openTaskGroups = state.taskGroups.filter((task) => !["closed", "aborted"].includes(task.status)).length;
  const blockers = state.taskGroups.flatMap((task) => task.blockers || []).length;
  const projectProgress = Math.round(
    state.projects.reduce((sum, project) => sum + (project.progress?.percent || 0), 0) / Math.max(1, state.projects.length)
  );

  statusLine.innerHTML = h`
    <div class="metric"><span>Runtime</span><strong>${escapeHtml(state.runtime.status)}</strong></div>
    <div class="metric"><span>Active Agents</span><strong>${activeAgents}/${state.agents.length}</strong></div>
    <div class="metric"><span>Open Task Groups</span><strong>${openTaskGroups}</strong></div>
    <div class="metric"><span>Avg Project Progress</span><strong>${projectProgress}%</strong></div>
  `;

  if (blockers > 0) {
    statusLine.insertAdjacentHTML("beforeend", `<div class="metric"><span>Blockers</span><strong>${blockers}</strong></div>`);
  }
}

function renderSystem() {
  const services = state.runtime.services.map((service) => row([
    escapeHtml(service.id),
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
    panel("运行入口", h`
      <div class="stack">
        <div class="notice">支持 npm、Docker、Shell 直接启动；初始化只写入本地运行态目录，项目产出文件始终进入对应项目 Git 仓库。</div>
        <table class="data-table">
          <thead><tr><th>方式</th><th>命令</th><th>用途</th></tr></thead>
          <tbody>
            ${row(["npm", "<span class='mono'>npm run init && npm start</span>", "初始化并启动控制台"])}
            ${row(["Docker", "<span class='mono'>docker compose up --build</span>", "容器化启动"])}
            ${row(["Shell", "<span class='mono'>./scripts/start.sh</span>", "脚本入口"])}
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
}

function renderUsers() {
  const accounts = state.accounts.map((account) => row([
    escapeHtml(account.displayName),
    escapeHtml(account.email),
    escapeHtml(account.accountType),
    pill(account.status),
    escapeHtml(account.roles.join(", "))
  ])).join("");
  const grants = state.accessGrants.map((grant) => row([
    escapeHtml(grant.subjectId),
    escapeHtml(`${grant.resourceType}:${grant.resourceId}`),
    escapeHtml(grant.role),
    pill(grant.status),
    escapeHtml(grant.permissions.join(", "))
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
            <option value="user_account">用户账号</option>
            <option value="system_admin">系统管理员</option>
            <option value="service_account">服务账号</option>
          </select>
        </div>
        <button class="primary-button" type="submit">邀请</button>
      </form>
    `),
    panel("Agent 激活", h`
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
      <table class="data-table">
        <thead><tr><th>主体</th><th>资源</th><th>角色</th><th>状态</th><th>权限</th></tr></thead>
        <tbody>${grants}</tbody>
      </table>
    `, "wide")
  ].join("");

  document.querySelector("#invite-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    await api("/api/accounts", {method: "POST", body: JSON.stringify(Object.fromEntries(form.entries()))});
    await load();
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
            ${state.accounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.displayName)}</option>`).join("")}
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
          <select id="memberAccountId" name="accountId">${state.accounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.displayName)}</option>`).join("")}</select>
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
    await api("/api/projects", {method: "POST", body: JSON.stringify(Object.fromEntries(form.entries()))});
    await load();
  });

  document.querySelector("#member-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const data = Object.fromEntries(form.entries());
    await api(`/api/projects/${data.projectId}/members`, {method: "POST", body: JSON.stringify(data)});
    await load();
  });
}

function renderTasks() {
  const taskGroups = state.taskGroups.map((taskGroup) => {
    const workItems = taskGroup.workItems.map((workItem) => h`
      <div class="record">
        <div class="record-title"><strong>${escapeHtml(workItem.title)}</strong>${pill(workItem.status)}</div>
        ${progress(workItem.progress)}
        <div class="record-meta"><span>${escapeHtml(workItem.ownerRole)}</span><span>${workItem.progress}%</span></div>
      </div>
    `).join("");
    const roles = taskGroup.roles.map((role) => `${role.roleId}:${role.status}`).join(", ");
    const blockers = taskGroup.blockers.length
      ? taskGroup.blockers.map((blocker) => `<div class="record"><strong>${escapeHtml(blocker.severity)}</strong><span>${escapeHtml(blocker.summary)}</span></div>`).join("")
      : "<div class='record'>无阻塞</div>";
    return panel(taskGroup.name, h`
      <div class="stack">
        <div class="record-title"><strong>${escapeHtml(taskGroup.phase)}</strong>${pill(taskGroup.status)}</div>
        ${progress(taskGroup.progress)}
        <div class="record-meta"><span>health: ${escapeHtml(taskGroup.health)}</span><span>roles: ${escapeHtml(roles)}</span></div>
        <div class="button-row">
          <button class="secondary-button" data-action="task-control" data-task="${escapeHtml(taskGroup.id)}" data-task-action="pause">暂停</button>
          <button class="secondary-button" data-action="task-control" data-task="${escapeHtml(taskGroup.id)}" data-task-action="resume">恢复</button>
          <button class="secondary-button" data-action="task-control" data-task="${escapeHtml(taskGroup.id)}" data-task-action="request_review">复验</button>
          <button class="danger-button" data-action="task-control" data-task="${escapeHtml(taskGroup.id)}" data-task-action="rebound_drift">纠偏</button>
        </div>
        <div class="stack">${workItems}</div>
        <div class="stack">${blockers}</div>
      </div>
    `, "wide");
  }).join("");

  content.innerHTML = taskGroups;
}

function renderInstructions() {
  const metrics = state.instructionMetrics;
  const envelopes = metrics.envelopes.map((envelope) => row([
    escapeHtml(envelope.id),
    escapeHtml(envelope.recipientRole),
    escapeHtml(envelope.cacheKey),
    pill(envelope.status),
    escapeHtml(envelope.estimatedTokens)
  ])).join("");
  const definitions = state.sharedDefinitions.map((definition) => row([
    escapeHtml(definition.name),
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
  if (activeView === "instructions") renderInstructions();
}

document.querySelector(".nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (!button) return;
  activeView = button.dataset.view;
  render();
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  if (target.dataset.action === "toggle-agent") {
    const agent = state.agents.find((item) => item.id === target.dataset.agent);
    await api(`/api/agents/${target.dataset.agent}/activate`, {method: "POST", body: JSON.stringify({active: agent.status !== "active"})});
    await load();
  }
  if (target.dataset.action === "task-control") {
    await api(`/api/task-groups/${target.dataset.task}/control`, {method: "POST", body: JSON.stringify({action: target.dataset.taskAction})});
    await load();
  }
});

refreshButton.addEventListener("click", load);
bootstrapButton.addEventListener("click", async () => {
  await api("/api/bootstrap/init", {method: "POST", body: "{}"});
  await load();
});

load().catch((error) => {
  content.innerHTML = `<article class="panel wide"><div class="panel-body">加载失败：${escapeHtml(error.message)}</div></article>`;
});
