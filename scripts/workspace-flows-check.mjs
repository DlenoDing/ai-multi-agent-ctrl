import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {randomBytes, randomUUID} from "node:crypto";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeDir = mkdtempSync(join(tmpdir(), "aimac-workspace-flows-"));
const bootstrap = randomBytes(24).toString("base64url");
let output = "";
let sessionToken = "";
let baseUrl = "";
const server = spawn(process.execPath, ["apps/control-plane-ui/server.mjs"], {cwd: root,
  env: {...process.env, AIMAC_RUNTIME_DIR: runtimeDir, AIMAC_HOST: "127.0.0.1", AIMAC_PORT: "0", AIMAC_PUBLIC_URL: "",
    AIMAC_BOOTSTRAP_TOKEN: bootstrap, AIMAC_ORCHESTRATOR_INTERVAL_MS: "0", AIMAC_EXECUTION_PROFILE: "production",
    AIMAC_STATE_STORE: "runtime_json", DATABASE_URL: "", AIMAC_EXIT_WITH_PARENT: "1"}, stdio: ["ignore", "pipe", "pipe"]});
const exited = new Promise((resolveExit) => server.once("exit", resolveExit));
server.stdout.on("data", (chunk) => { output += String(chunk); });
server.stderr.on("data", (chunk) => { output += String(chunk); });

async function request(path, {method = "GET", body, status = 200} = {}) {
  const result = await fetch(`${baseUrl}${path}`, {method, signal: AbortSignal.timeout(10000),
    headers: {"content-type": "application/json", "Idempotency-Key": randomUUID(), ...(sessionToken ? {authorization: `Bearer ${sessionToken}`} : {})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const payload = await result.json();
  assert.equal(result.status, status, `${method} ${path}: ${payload.error || result.status}`);
  return payload;
}

try {
  const deadline = Date.now() + 10000;
  while (!baseUrl && Date.now() < deadline) {
    baseUrl = /console: (http:\/\/127\.0\.0\.1:\d+)/u.exec(output)?.[1] || "";
    if (server.exitCode !== null) throw new Error("test server exited during startup");
    if (!baseUrl) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.ok(baseUrl, "server did not start");
  sessionToken = (await request("/api/auth/login", {method: "POST", body: {email: "system.admin@local", token: bootstrap}})).sessionToken;
  assert.ok(sessionToken);
  const createdProject = await request("/api/projects", {method: "POST", body: {name: "管理工作区验证项目"}, status: 201});
  const projectId = createdProject.project?.id || createdProject.id;
  assert.ok(projectId);
  const created = await request("/api/task-groups", {method: "POST", status: 201,
    body: {projectId, name: "等待人工启动的任务组", objective: "验证先创建后启动", roles: ["agent-runtime"], startPaused: true}});
  const group = created.taskGroup;
  assert.equal(group.goalExecutionStatus, "active_paused_by_control");
  assert.equal(group.pauseReason, "human_directive_pause");
  const work = await request(`/api/task-groups/${group.id}/work-items`, {method: "POST", status: 201,
    body: {title: "手动启动前保留的任务", ownerRole: "agent-runtime", requirements: ["启动后按正常阶段门执行"]}});
  await request("/api/orchestrator/run", {method: "POST", body: {mode: "all"}});
  const beforeStart = await request(`/api/task-groups/${group.id}`);
  assert.equal(beforeStart.taskGroup.goalExecutionStatus, "active_paused_by_control");
  assert.equal(beforeStart.taskGroup.workItems.find((item) => item.id === work.workItem.id).status, work.workItem.status);
  assert.equal(beforeStart.agentDispatches.length, 0, "a paused group must not dispatch");
  await request(`/api/task-groups/${group.id}/control`, {method: "POST", body: {action: "resume"}});
  assert.equal((await request(`/api/task-groups/${group.id}`)).taskGroup.goalExecutionStatus, "active");
  console.log("ok: create paused -> create task -> automatic cycle holds -> explicit start resumes");

  const configPath = `/api/projects/${projectId}/config`;
  const emptyConfig = await request(configPath);
  const initial = await request(configPath, {method: "POST", body: {
    repositories: [{id: "repo_test", url: "https://example.test/workspace.git", defaultBranch: "main", credentialMode: "none"}],
    baselineData: [{name: "现状资料", locator: "git:docs/baseline.md"}], defaultRoles: [{roleId: "agent-runtime"}],
    expectedConfigVersion: emptyConfig.configVersion
  }});
  const changed = await request(configPath, {method: "POST", body: {
    repositories: [{id: "repo_test", url: "https://example.test/updated.git", defaultBranch: "main", credentialMode: "none"}],
    expectedConfigVersion: initial.configVersion
  }});
  assert.deepEqual(changed.config.baselineData, initial.config.baselineData);
  assert.deepEqual(changed.config.defaultRoles, initial.config.defaultRoles);
  const stale = await request(configPath, {method: "POST", status: 409, body: {businessRules: [], expectedConfigVersion: initial.configVersion}});
  assert.equal(stale.error, "config_version_stale");
  assert.equal((await request(configPath)).config.repositories[0].url, "https://example.test/updated.git");
  console.log("ok: repository-only save preserves baseline/roles; stale form cannot overwrite a newer configuration");
  const projectEvents = await request(`/api/projects/${projectId}/execution-events?limit=20`);
  assert.equal(projectEvents.projectId, projectId);
  assert.ok(Array.isArray(projectEvents.events));
  const systemSession = sessionToken;
  const organization = await request("/api/orgs", {method: "POST", status: 201,
    body: {name: "导航作用域验证组织", admin: {email: "navigation-admin@example.test", displayName: "导航管理员"}}});
  sessionToken = (await request("/api/auth/login", {method: "POST",
    body: {email: organization.adminAccount.email, token: organization.accountToken}})).sessionToken;
  const orgProject = await request("/api/org/projects", {method: "POST", status: 201, body: {name: "组织导航项目"}});
  const siblingProject = await request("/api/org/projects", {method: "POST", status: 201, body: {name: "成员保留权限项目"}});
  const orgAdminSession = sessionToken;
  const invitedMember = await request("/api/org/members", {method: "POST", status: 201,
    body: {displayName: "权限替换成员", email: "permission-replace-member@example.test", defaultProjectId: orgProject.id}});
  const memberId = invitedMember.account.accountId;
  await request(`/api/projects/${orgProject.id}/members`, {method: "POST", body: {accountId: memberId, role: "project_admin"}});
  await request(`/api/projects/${siblingProject.id}/members`, {method: "POST", body: {accountId: memberId, role: "viewer"}});
  await request(`/api/projects/${orgProject.id}/members`, {method: "POST", body: {accountId: memberId, role: "viewer"}});
  let permissionState = await request(`/api/state?view=projects&projectId=${orgProject.id}`);
  const projectGrants = permissionState.accessGrants.filter((grant) => grant.subjectRef?.subjectId === memberId
    && grant.resource?.resourceType === "project" && grant.resource?.resourceId === orgProject.id);
  assert.equal(projectGrants.filter((grant) => grant.status === "active").length, 1, "project role replacement must leave one active grant");
  assert.equal(projectGrants.find((grant) => grant.status === "active")?.role, "viewer");
  assert.ok(projectGrants.some((grant) => grant.status === "revoked" && grant.role === "project_admin"
    && grant.revokedReason === "project_role_replaced"), "old project admin grant must be revoked on downgrade");
  const ownerId = organization.adminAccount.accountId;
  assert.equal((await request(`/api/projects/${orgProject.id}/members`, {method: "POST", status: 409,
    body: {accountId: ownerId, role: "viewer"}})).error, "project_owner_role_immutable");
  assert.equal((await request(`/api/projects/${orgProject.id}/members/${ownerId}/revoke`, {method: "POST", status: 409,
    body: {}})).error, "project_owner_cannot_be_removed");

  const permissionGroup = (await request("/api/task-groups", {method: "POST", status: 201,
    body: {projectId: orgProject.id, name: "权限替换任务组", objective: "验证任务组角色替换", roles: ["agent-runtime"], startPaused: true}})).taskGroup;
  await request("/api/access-grants", {method: "POST", status: 201,
    body: {subjectId: memberId, resourceType: "task_group", resourceId: permissionGroup.id, role: "reviewer", replaceExisting: true}});
  await request("/api/access-grants", {method: "POST", status: 201,
    body: {subjectId: memberId, resourceType: "task_group", resourceId: permissionGroup.id, role: "viewer", replaceExisting: true}});
  permissionState = await request(`/api/state?view=projects&projectId=${orgProject.id}`);
  const groupGrants = permissionState.accessGrants.filter((grant) => grant.subjectRef?.subjectId === memberId
    && grant.resource?.resourceType === "task_group" && grant.resource?.resourceId === permissionGroup.id);
  assert.equal(groupGrants.filter((grant) => grant.status === "active").length, 1, "task-group role replacement must leave one active grant");
  assert.equal(groupGrants.find((grant) => grant.status === "active")?.role, "viewer");
  assert.ok(groupGrants.some((grant) => grant.status === "revoked" && grant.role === "reviewer"
    && grant.revokedReason === "role_replaced"), "old task-group reviewer grant must be revoked on replacement");

  const memberSession = (await request("/api/auth/login", {method: "POST",
    body: {email: invitedMember.account.email, token: invitedMember.accountToken}})).sessionToken;
  sessionToken = orgAdminSession;
  const removed = await request(`/api/projects/${orgProject.id}/members/${memberId}/revoke`, {method: "POST", body: {}});
  assert.ok(removed.revokedProjectGrants >= 1 && removed.revokedTaskGroupGrants >= 1,
    "removing a project member must revoke project and child task-group grants");
  const membersAfterRemoval = await request("/api/org/members");
  assert.equal(membersAfterRemoval.members.find((member) => member.accountId === memberId)?.defaultProjectId, null,
    "removing the default project membership must clear the default project pointer");
  sessionToken = memberSession;
  const memberProjectsAfterRemoval = await request("/api/state?view=projects");
  assert.ok(!memberProjectsAfterRemoval.projects.some((project) => project.id === orgProject.id), "removed member must not see the removed project");
  assert.ok(memberProjectsAfterRemoval.projects.some((project) => project.id === siblingProject.id), "removing one project must preserve access to other projects");
  sessionToken = orgAdminSession;
  console.log("ok: project/task-group role replacement revokes stale permissions; removing a member cascades only within that project");
  const orgView = await request(`/api/state?view=projects&projectId=${orgProject.id}`);
  assert.deepEqual(orgView.organizationContext, {id: organization.organization.orgId, name: "导航作用域验证组织", status: "active"});
  assert.ok(!orgView.projects.some((project) => project.id === projectId), "organization context must not introduce foreign projects");
  sessionToken = systemSession;
  assert.equal((await request("/api/state?view=system")).organizationContext, null, "global system management must not be labeled as an organization workspace");
  const systemProjectView = await request(`/api/state?view=projects&projectId=${orgProject.id}`);
  assert.deepEqual(systemProjectView.organizationContext, orgView.organizationContext, "system reader uses the target project's organization, not the reader's default organization");
  console.log("ok: organization breadcrumb context follows the authorized project for org and system readers");
  console.log("workspace flows check passed");
} catch (error) {
  console.error(`workspace flows check failed: ${error.stack || error.message}`);
  process.exitCode = 1;
} finally {
  if (server.exitCode === null) server.kill("SIGTERM");
  const killTimer = setTimeout(() => server.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(killTimer);
  rmSync(runtimeDir, {recursive: true, force: true});
}
