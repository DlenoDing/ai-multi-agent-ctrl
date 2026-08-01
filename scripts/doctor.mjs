import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import WebSocket from "ws";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

async function getFreePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function waitForHealth(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/runtime/health`);
      if (response.ok) return await response.json();
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  throw new Error("control console health check timed out");
}

async function jsonFetch(port, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...options,
    headers: {"content-type": "application/json", ...(options.headers || {})}
  });
  const payload = await response.json();
  return {response, payload};
}

async function loginAs(port, email, token) {
  const login = await jsonFetch(port, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({email, token})
  });
  if (!login.response.ok || !login.payload.sessionToken) {
    throw new Error(`doctor login failed for ${email}`);
  }
  return `Bearer ${login.payload.sessionToken}`;
}

async function verifyRealtimeWebSocket(port, bearerAuth) {
  const token = bearerAuth.replace(/^Bearer\s+/u, "");
  // An unauthenticated upgrade must be rejected before the socket opens.
  await new Promise((resolveProbe, rejectProbe) => {
    const bad = new WebSocket(`ws://127.0.0.1:${port}/api/realtime?token=bogus-token`);
    const timer = setTimeout(() => { bad.terminate(); rejectProbe(new Error("unauthenticated realtime WS was not rejected")); }, 4000);
    bad.on("error", () => { clearTimeout(timer); resolveProbe(); });
    bad.on("open", () => { clearTimeout(timer); bad.close(); rejectProbe(new Error("unauthenticated realtime WS was accepted")); });
  });
  // 子协议携带令牌（控制台走的就是这条）：令牌不进 URL，也就不会被反向代理访问日志、
  // 浏览器历史等记下来。浏览器要求服务端回显一个它提供过的子协议，否则会立刻断开 ——
  // 这里连带验证握手确实回显了 aimac.bearer，且【没有】把令牌本身回显进响应头。
  await new Promise((resolveProto, rejectProto) => {
    const viaProtocol = new WebSocket(`ws://127.0.0.1:${port}/api/realtime`, ["aimac.bearer", token]);
    const timer = setTimeout(() => { viaProtocol.terminate(); rejectProto(new Error("subprotocol-authenticated realtime WS did not open")); }, 5000);
    viaProtocol.on("error", (error) => { clearTimeout(timer); rejectProto(error); });
    viaProtocol.on("open", () => {
      clearTimeout(timer);
      const accepted = viaProtocol.protocol;
      viaProtocol.close();
      if (accepted !== "aimac.bearer") { rejectProto(new Error(`realtime handshake echoed an unexpected subprotocol: ${accepted}`)); return; }
      resolveProto();
    });
  });
  // Authenticated: subscribe to state, trigger a scoped write, and expect a wake frame.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/realtime?token=${encodeURIComponent(token)}`);
  try {
    await new Promise((resolveWake, rejectWake) => {
      const timer = setTimeout(() => rejectWake(new Error("no realtime wake frame within 6s")), 6000);
      ws.on("error", (error) => { clearTimeout(timer); rejectWake(error); });
      ws.on("message", (data) => {
        let message;
        try { message = JSON.parse(String(data)); } catch { return; }
        if (message.event === "connected") ws.send(JSON.stringify({subscribe: ["state"]}));
        if (message.event === "subscribed") {
          jsonFetch(port, "/api/task-groups", {method: "POST", headers: {authorization: bearerAuth, "idempotency-key": "doctor-realtime-probe"}, body: JSON.stringify({projectId: "prj_control_plane", name: "Realtime probe"})}).catch((error) => rejectWake(error));
        }
        if (message.event === "wake" && message.channel === "state") { clearTimeout(timer); resolveWake(); }
      });
    });
  } finally {
    try { ws.close(); } catch { /* already closing */ }
  }
}

function expectStatus(result, status, label) {
  if (result.response.status !== status) {
    throw new Error(`${label}: expected ${status}, got ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
  return result;
}

function git(repoRoot, args, fallback = "") {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {encoding: "utf8"}).trim();
  } catch {
    return fallback;
  }
}

function hashFile(path) {
  if (!existsSync(path)) return "missing";
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function openSession(session) {
  return session && !["completed_objective", "failed", "closed", "recycled", "aborted"].includes(session.status);
}

function setupDoctorRepository(root) {
  mkdirSync(join(root, ".runtime"), {recursive: true});
  const base = mkdtempSync(join(root, ".runtime", "doctor-git-"));
  const remote = join(base, "remote.git");
  const work = join(base, "work");
  execFileSync("git", ["init", "--bare", remote], {stdio: "pipe"});
  execFileSync("git", ["init", "-b", "main", work], {stdio: "pipe"});
  git(work, ["config", "user.email", "doctor-agent@local"]);
  git(work, ["config", "user.name", "Doctor Agent Runtime"]);
  writeFileSync(join(work, "README.md"), "# Doctor Runtime Repository\n");
  writeFileSync(join(work, ".aimac-verification-repository"), "verification\n");
  git(work, ["add", "README.md"]);
  git(work, ["add", ".aimac-verification-repository"]);
  git(work, ["commit", "-m", "Initialize doctor runtime repository"]);
  git(work, ["remote", "add", "origin", remote]);
  git(work, ["push", "origin", "HEAD:refs/heads/main"]);
  const executorPath = join(base, "doctor-executor.mjs");
  writeFileSync(executorPath, `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const input = JSON.parse(readFileSync(0, "utf8"));
const manifestPath = input.repositoryOutputTarget.artifactManifestPath || \`docs/artifact-manifests/\${input.workId}.json\`;
const outputPath = \`docs/agent-runtime-output/\${input.taskGroupId}/\${input.workId}.md\`;
mkdirSync(join(input.repositoryRoot, dirname(manifestPath)), {recursive: true});
mkdirSync(join(input.repositoryRoot, dirname(outputPath)), {recursive: true});
writeFileSync(join(input.repositoryRoot, outputPath), [
  \`# \${input.workId}\`,
  "",
  \`Dispatch: \${input.dispatchId}\`,
  \`Session: \${input.sessionId}\`,
  \`Model: \${input.model.modelId}\`,
  ""
].join("\\n"));
writeFileSync(join(input.repositoryRoot, manifestPath), JSON.stringify({
  schemaVersion: "artifact-manifest/v1",
  projectId: input.projectId,
  taskGroupId: input.taskGroupId,
  workId: input.workId,
  sessionId: input.sessionId,
  dispatchId: input.dispatchId,
  repositoryOutputTargetRefs: [input.repositoryOutputTarget.targetId],
  taskContractDigest: input.taskContract.contractDigest,
  outputPolicy: "project_git_repository_only",
  generatedBy: "doctor-agent-executor",
  model: input.model,
  roleSkill: input.roleSkill,
  outputRefs: [outputPath],
  createdAt: new Date().toISOString()
}, null, 2) + "\\n");
console.log(JSON.stringify({
  summary: "Doctor executor produced git-backed task output and artifact manifest.",
  artifactManifestRefs: [manifestPath],
  changedPaths: [outputPath],
  evidenceRefs: ["executor:doctor-called"],
  commitMessage: \`Doctor executor output for \${input.workId}\`
}));
`);
  return {base, remote, work, executorPath, executorCommand: `node ${JSON.stringify(executorPath)}`};
}

const root = resolve(new URL("..", import.meta.url).pathname);
const port = await getFreePort();
const doctorRuntimeDir = process.env.AIMAC_DOCTOR_RUNTIME_DIR || `.runtime/doctor-${Date.now()}`;
const doctorRepo = setupDoctorRepository(root);
const child = spawn(process.execPath, ["apps/control-plane-ui/server.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    AIMAC_HOST: "127.0.0.1",
    AIMAC_PORT: String(port),
    AIMAC_RUNTIME_DIR: doctorRuntimeDir,
    AIMAC_REPOSITORY_ROOT: doctorRepo.work,
    AIMAC_EXECUTION_PROFILE: "verification",
    AIMAC_STATE_STORE: "runtime_json",
    DATABASE_URL: "",
    AIMAC_BOOTSTRAP_TOKEN: "doctor-bootstrap-token",
    AIMAC_LOCAL_SEED_WORKSPACE_OWNER_TOKEN: "doctor-workspace-token",
    AIMAC_LOCAL_SEED_REVIEWER_TOKEN: "doctor-reviewer-token",
    AIMAC_LOCAL_SEED_AGENT_RUNTIME_TOKEN: "doctor-agent-runtime-token",
    AIMAC_AGENT_RUNTIME_EXECUTOR_COMMAND: doctorRepo.executorCommand,
    OPENAI_API_KEY: "doctor-provider-key"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});
const exitPromise = once(child, "exit");

try {
  const health = await waitForHealth(port);
  console.log(`control console health ok: ${health.status}`);
  const stateReadDenied = await jsonFetch(port, "/api/state");
  if (stateReadDenied.response.status !== 401) {
    throw new Error(`expected unauthenticated state read 401, got ${stateReadDenied.response.status}`);
  }
  const unauth = await jsonFetch(port, "/api/model-selection/decide", {
    method: "POST",
    body: JSON.stringify({taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", roleId: "ui-console-service"})
  });
  if (unauth.response.status !== 401) {
    throw new Error(`expected unauthenticated 401, got ${unauth.response.status}`);
  }
  const unauthTaskGroupCreate = await jsonFetch(port, "/api/task-groups", {
    method: "POST",
    body: JSON.stringify({projectId: "prj_missing_probe", name: "Unauth probe"})
  });
  if (unauthTaskGroupCreate.response.status !== 401) {
    throw new Error(`expected unauthenticated task-group create 401 before existence checks, got ${unauthTaskGroupCreate.response.status}`);
  }
  const unauthWorkItemCreate = await jsonFetch(port, "/api/task-groups/tg_missing_probe/work-items", {
    method: "POST",
    body: JSON.stringify({title: "Unauth probe"})
  });
  if (unauthWorkItemCreate.response.status !== 401) {
    throw new Error(`expected unauthenticated work-item create 401 before existence checks, got ${unauthWorkItemCreate.response.status}`);
  }
  const ownerBootstrapDenied = await jsonFetch(port, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({email: "owner@local", token: "doctor-bootstrap-token"})
  });
  if (ownerBootstrapDenied.response.status !== 401) {
    throw new Error(`expected bootstrap token to be rejected for user account, got ${ownerBootstrapDenied.response.status}`);
  }
  const systemAuth = await loginAs(port, "system.admin@local", "doctor-bootstrap-token");
  const auth = await loginAs(port, "owner@local", "doctor-workspace-token");
  const reviewerAuth = await loginAs(port, "review@local", "doctor-reviewer-token");
  const agentAuth = await loginAs(port, "agent.runtime@local", "doctor-agent-runtime-token");
  const logoutLogin = await jsonFetch(port, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({email: "owner@local", token: "doctor-workspace-token"})
  });
  if (!logoutLogin.response.ok || !logoutLogin.payload.sessionToken) {
    throw new Error("logout fixture login failed");
  }
  const logoutAuth = `Bearer ${logoutLogin.payload.sessionToken}`;
  const logoutStateBefore = await jsonFetch(port, "/api/state", {
    headers: {authorization: logoutAuth}
  });
  if (!logoutStateBefore.response.ok) throw new Error("logout fixture bearer could not read state before revocation");
  const logoutResult = await jsonFetch(port, "/api/auth/logout", {
    method: "POST",
    headers: {authorization: logoutAuth},
    body: "{}"
  });
  if (!logoutResult.response.ok || logoutResult.payload.ok !== true) {
    throw new Error("auth logout did not return a successful idempotent response");
  }
  const logoutStateAfter = await jsonFetch(port, "/api/state", {
    headers: {authorization: logoutAuth}
  });
  if (logoutStateAfter.response.status !== 401) {
    throw new Error(`expected revoked bearer to be rejected after logout, got ${logoutStateAfter.response.status}`);
  }
  const stateResult = await jsonFetch(port, "/api/state", {
    headers: {authorization: systemAuth}
  });
  if (stateResult.payload.runtime.services.some((service) => service.status === "simulated")) {
    throw new Error("runtime services must not be simulated");
  }
  if (new Set(stateResult.payload.modelCapabilities.map((profile) => profile.providerClass)).size < 19) {
    throw new Error("model registry does not cover all provider classes");
  }
  if (!stateResult.payload.skillSources.some((source) => source.sourceId === "agency-agents-zh")) {
    throw new Error("agency-agents-zh skill source is not configured");
  }
  const noIdempotency = await jsonFetch(port, "/api/model-selection/decide", {
    method: "POST",
    headers: {authorization: auth},
    body: JSON.stringify({taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", roleId: "ui-console-service"})
  });
  if (noIdempotency.response.status !== 428) {
    throw new Error(`expected idempotency 428, got ${noIdempotency.response.status}`);
  }
  const skillSync = await jsonFetch(port, "/api/skill-sources/agency-agents-zh/sync", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-skill-sync", authorization: systemAuth},
    body: "{}"
  });
  if (!skillSync.response.ok || skillSync.payload.roleSkillCount < 260 || skillSync.payload.actualCommit !== "1d2345927e4a70c426472c37771e31f9333d7e0a") {
    throw new Error("agency-agents-zh sync did not verify pinned role index");
  }
  const modelDecision = await jsonFetch(port, "/api/model-selection/decide", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-model-selection", authorization: systemAuth},
    body: JSON.stringify({taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", roleId: "ui-console-service"})
  });
  if (!modelDecision.response.ok || modelDecision.payload.status !== "selected") {
    throw new Error("model selection did not select a model");
  }
  const idempotencyConflict = await jsonFetch(port, "/api/model-selection/decide", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-model-selection", authorization: systemAuth},
    body: JSON.stringify({taskGroupId: "tg_runtime_management", workItemId: "work_permissions", roleId: "policy-engine"})
  });
  if (idempotencyConflict.response.status !== 409) {
    throw new Error(`expected idempotency conflict 409, got ${idempotencyConflict.response.status}`);
  }
  const reviewerScopedGrant = await jsonFetch(port, "/api/access-grants", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-reviewer-scoped-grant", authorization: auth},
    body: JSON.stringify({subjectId: "acct_reviewer", resourceType: "task_group", resourceId: "tg_runtime_management", role: "task_group_owner", permissions: ["task_group:control"]})
  });
  if (!reviewerScopedGrant.response.ok) {
    throw new Error("failed to create reviewer scoped grant");
  }
  const reviewerOrchestrateDenied = await jsonFetch(port, "/api/orchestrator/run", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-reviewer-orchestrate-denied", authorization: reviewerAuth},
    body: JSON.stringify({mode: "single", taskGroupId: "tg_runtime_management"})
  });
  if (reviewerOrchestrateDenied.response.status !== 403) {
    throw new Error(`expected task_group:control not to satisfy orchestrator permission, got ${reviewerOrchestrateDenied.response.status}`);
  }
  const reviewerProjectGrant = await jsonFetch(port, "/api/access-grants", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-reviewer-project-grant", authorization: auth},
    body: JSON.stringify({subjectId: "acct_reviewer", resourceType: "project", resourceId: "prj_control_plane", role: "project_admin", permissions: ["project:grant"]})
  });
  if (!reviewerProjectGrant.response.ok) {
    throw new Error("failed to create reviewer project grant");
  }
  const reviewerCrossProjectDenied = await jsonFetch(port, "/api/access-grants", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-reviewer-cross-project-denied", authorization: reviewerAuth},
    body: JSON.stringify({subjectId: "acct_reviewer", resourceType: "project", resourceId: "prj_other", role: "project_admin", permissions: ["project:grant"]})
  });
  if (reviewerCrossProjectDenied.response.status !== 403) {
    throw new Error(`expected project-scoped grant isolation 403, got ${reviewerCrossProjectDenied.response.status}`);
  }
  const reviewerRuntimeGrantDenied = await jsonFetch(port, "/api/access-grants", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-reviewer-runtime-grant-denied", authorization: reviewerAuth},
    body: JSON.stringify({subjectId: "acct_reviewer", resourceType: "project", resourceId: "prj_control_plane", role: "agent_operator", permissions: ["task_group:orchestrate"]})
  });
  if (![400, 403].includes(reviewerRuntimeGrantDenied.response.status)) {
    throw new Error(`expected project grant holder not to delegate runtime orchestration permission, got ${reviewerRuntimeGrantDenied.response.status}`);
  }
  const ownerWildcardGrantDenied = await jsonFetch(port, "/api/access-grants", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-owner-wildcard-grant-denied", authorization: auth},
    body: JSON.stringify({subjectId: "acct_reviewer", resourceType: "project", resourceId: "prj_control_plane", role: "project_admin", permissions: ["project:*"]})
  });
  if (ownerWildcardGrantDenied.response.status !== 400) {
    throw new Error(`expected project owner wildcard grant to be rejected, got ${ownerWildcardGrantDenied.response.status}`);
  }
  const ownerCrossProjectDenied = await jsonFetch(port, "/api/access-grants", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-owner-cross-project-denied", authorization: auth},
    body: JSON.stringify({subjectId: "acct_reviewer", resourceType: "project", resourceId: "prj_other", role: "project_admin", permissions: ["project:grant"]})
  });
  if (ownerCrossProjectDenied.response.status !== 403) {
    throw new Error(`expected workspace owner project grant to stay resource-scoped, got ${ownerCrossProjectDenied.response.status}`);
  }
  const ownerCrossProjectInviteDenied = await jsonFetch(port, "/api/accounts", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-owner-cross-project-invite-denied", authorization: auth},
    body: JSON.stringify({projectId: "prj_other", displayName: "Other Project User", email: "other-project-user@local"})
  });
  if (ownerCrossProjectInviteDenied.response.status !== 403) {
    throw new Error(`expected workspace owner invite to stay project-scoped, got ${ownerCrossProjectInviteDenied.response.status}`);
  }
  const ownerSystemInviteDenied = await jsonFetch(port, "/api/accounts", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-owner-system-invite-denied", authorization: auth},
    body: JSON.stringify({projectId: "prj_control_plane", accountType: "system_admin", displayName: "Escalated Admin", email: "escalated-admin@local", roles: "system_admin", permissions: "system:*"})
  });
  if (ownerSystemInviteDenied.response.status !== 403) {
    throw new Error(`expected project-scoped inviter not to create system admin, got ${ownerSystemInviteDenied.response.status}`);
  }
  const ownerCrossProjectAgentDenied = await jsonFetch(port, "/api/agents", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-owner-cross-project-agent-denied", authorization: auth},
    body: JSON.stringify({projectId: "prj_other", name: "Other Project Agent", role: "reviewer", model: "auto_best"})
  });
  if (ownerCrossProjectAgentDenied.response.status !== 403) {
    throw new Error(`expected workspace owner agent activation to stay project-scoped, got ${ownerCrossProjectAgentDenied.response.status}`);
  }
  const delegatedDenyStateBefore = await jsonFetch(port, "/api/state?view=system&limit=20", {
    headers: {authorization: systemAuth}
  });
  const delegatedProjectOwnerDenied = await jsonFetch(port, "/api/projects", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-project-delegated-owner-denied", authorization: auth},
    body: JSON.stringify({name: "Delegated Owner Project", ownerAccountId: "acct_reviewer"})
  });
  if (delegatedProjectOwnerDenied.response.status !== 403) {
    throw new Error(`expected non-system project creator not to assign another owner, got ${delegatedProjectOwnerDenied.response.status}`);
  }
  const delegatedProjectOwnerDeniedReplay = await jsonFetch(port, "/api/projects", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-project-delegated-owner-denied", authorization: auth},
    body: JSON.stringify({name: "Delegated Owner Project", ownerAccountId: "acct_reviewer"})
  });
  const delegatedDenyStateAfter = await jsonFetch(port, "/api/state?view=system&limit=20", {
    headers: {authorization: systemAuth}
  });
  if (delegatedProjectOwnerDeniedReplay.response.status !== 403) {
    throw new Error(`expected delegated owner deny replay to remain 403, got ${delegatedProjectOwnerDeniedReplay.response.status}`);
  }
  if (delegatedDenyStateAfter.payload.stateVersion !== delegatedDenyStateBefore.payload.stateVersion) {
    throw new Error("delegated project owner denial or replay advanced stateVersion");
  }
  const createdProject = await jsonFetch(port, "/api/projects", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-project-create-owner-grant", authorization: auth},
    body: JSON.stringify({name: "Doctor Managed Project"})
  });
  if (!createdProject.response.ok || !createdProject.payload.id || createdProject.payload.ownerGrant?.subjectRef?.subjectId !== "acct_workspace_owner" || !createdProject.payload.ownerGrant?.permissions?.includes("task_group:control")) {
    throw new Error("project creation did not return an owner grant with task-group control");
  }
  const ownerGrantPermissions = createdProject.payload.ownerGrant.permissions || [];
  if (["project:*", "task_group:*", "task_group:orchestrate", "task_group:checkpoint_submit"].some((permission) => ownerGrantPermissions.includes(permission))) {
    throw new Error("project owner grant carried broad or runtime-execution permissions");
  }
  const createdProjectReplay = await jsonFetch(port, "/api/projects", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-project-create-owner-grant", authorization: auth},
    body: JSON.stringify({name: "Doctor Managed Project"})
  });
  if (!createdProjectReplay.response.ok || createdProjectReplay.payload.id !== createdProject.payload.id || createdProjectReplay.payload.ownerGrant?.grantId !== createdProject.payload.ownerGrant?.grantId) {
    throw new Error("project creation idempotency replay did not preserve owner grant payload");
  }
  const createdTaskGroup = await jsonFetch(port, "/api/task-groups", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-task-group-create", authorization: auth},
    body: JSON.stringify({projectId: createdProject.payload.id, name: "Doctor API Task Group", objective: "Verify user management can create task groups.", languageTag: "en", roles: ["orchestrator", "agent-runtime"]})
  });
  if (!createdTaskGroup.response.ok || createdTaskGroup.payload.taskGroup?.projectId !== createdProject.payload.id || createdTaskGroup.payload.taskGroup?.languagePolicy?.languageTag !== "en") {
    throw new Error("task group management API did not create a project-scoped language-bound task group");
  }
  const createdWorkItem = await jsonFetch(port, `/api/task-groups/${createdTaskGroup.payload.taskGroup.id}/work-items`, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-work-item-create", authorization: auth},
    body: JSON.stringify({title: "Doctor API work item", ownerRole: "agent-runtime", requirements: ["commit to project git", "return checkpoint"]})
  });
  if (!createdWorkItem.response.ok || createdWorkItem.payload.workItem?.ownerRole !== "agent-runtime" || !createdWorkItem.payload.taskGroup?.roles?.some((role) => role.roleId === "agent-runtime")) {
    throw new Error("work item management API did not create role-bound machine-executable work");
  }
  const memberGrant = await jsonFetch(port, `/api/projects/${createdProject.payload.id}/members`, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-project-member-role-template", authorization: auth},
    body: JSON.stringify({accountId: "acct_reviewer", role: "project_admin"})
  });
  if (!memberGrant.response.ok || !memberGrant.payload.members?.some((member) => member.accountId === "acct_reviewer" && member.role === "project_admin")) {
    throw new Error("project member role grant did not update project membership");
  }
  const reviewerManagedTaskGroup = await jsonFetch(port, "/api/task-groups", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-reviewer-project-admin-task-group", authorization: reviewerAuth},
    body: JSON.stringify({projectId: createdProject.payload.id, name: "Reviewer Managed Task Group", objective: "Verify role template grants task_group control.", languageTag: "zh-CN", roles: ["orchestrator"]})
  });
  if (!reviewerManagedTaskGroup.response.ok || reviewerManagedTaskGroup.payload.taskGroup?.projectId !== createdProject.payload.id) {
    throw new Error("project member role template did not grant usable project task-group management permission");
  }
  const ownerCreatedTaskOrchestrateDenied = await jsonFetch(port, "/api/orchestrator/run", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-owner-created-task-orchestrate-denied", authorization: auth},
    body: JSON.stringify({mode: "single", taskGroupId: createdTaskGroup.payload.taskGroup.id, autoSyncSkills: false})
  });
  if (ownerCreatedTaskOrchestrateDenied.response.status !== 403) {
    throw new Error(`expected project owner task_group:control not to satisfy orchestration permission, got ${ownerCreatedTaskOrchestrateDenied.response.status}`);
  }
  const ownerWorkerRunDenied = await jsonFetch(port, "/api/verification/agent-runtime/run", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-owner-worker-run-denied", authorization: auth},
    body: JSON.stringify({taskGroupId: createdTaskGroup.payload.taskGroup.id, maxJobs: 1})
  });
  if (ownerWorkerRunDenied.response.status !== 403) {
    throw new Error(`expected user account not to run agent runtime worker, got ${ownerWorkerRunDenied.response.status}`);
  }
  // 直接权限（写在账号 permissions 上、不绑定任何具体资源）绝不能满足 task_group: 级授权。
  // 原先这条守卫只在 task_group 作用域下生效，于是同一个权限被拿到 project 作用域比对时
  // 掉到"与是哪个项目无关"的兜底分支：持直接 task_group:review 的账号可以对组织内任意项目的
  // 评审计划动手。这里按真实 HTTP 路径复现那条越权，确保它保持被拒。
  // 用 system 账号来铸这个探针身份：委派校验现在会挡住"邀请方自己都没有该权限"的邀请，
  // 而这条探针要验的是【拿到直接权限之后】能不能跨项目动手，两件事要分开验。
  const crossScopeAccount = await jsonFetch(port, "/api/accounts", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-cross-scope-direct-permission", authorization: systemAuth},
    body: JSON.stringify({projectId: "prj_control_plane", displayName: "Cross Scope Probe", email: "cross-scope-probe@local", roles: "viewer", permissions: "task_group:review"})
  });
  if (!crossScopeAccount.response.ok) throw new Error("could not invite the cross-scope probe account");
  const crossScopeAuth = await loginAs(port, "cross-scope-probe@local", crossScopeAccount.payload.accountToken);
  const crossScopePlan = await jsonFetch(port, "/api/review-plans", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-cross-scope-plan", authorization: reviewerAuth},
    body: JSON.stringify({taskGroupId: "tg_runtime_management", requiredReviewerRoles: ["reviewer"]})
  });
  const crossScopePlanId = crossScopePlan.payload?.reviewPlan?.reviewPlanId || crossScopePlan.payload?.reviewPlanId;
  if (!crossScopePlanId) throw new Error("could not create a review plan for the cross-scope probe");
  const crossScopeResolve = await jsonFetch(port, `/api/review-plans/${crossScopePlanId}/resolve`, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-cross-scope-resolve", authorization: crossScopeAuth},
    body: JSON.stringify({status: "closed", justification: "probe"})
  });
  if (crossScopeResolve.response.status !== 403) {
    throw new Error(`a direct task_group: permission (bound to no resource) settled a review plan: expected 403, got ${crossScopeResolve.response.status}`);
  }

  // 鉴权前的存在性预言机：对象不存在时若先于守卫回 404，任何已认证主体都能靠 404 与 428/403
  // 的差别静默枚举别的租户有哪些对象（不产生 policyDecision、不写审计）。质量门的 id 是
  // qg:<taskGroupId>:<workItemId>:<gateType> 这种可推算的形式，尤其好枚举。
  // 要求：无权主体对"存在的 id"与"不存在的 id"必须得到同一个回答。
  const oracleProbeExisting = await jsonFetch(port, "/api/review-bundles/rvb_probe_exists/resolve", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-oracle-existing", authorization: agentAuth},
    body: JSON.stringify({status: "consumed", justification: "probe"})
  });
  const oracleProbeMissing = await jsonFetch(port, "/api/review-bundles/rvb_definitely_missing/resolve", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-oracle-missing", authorization: agentAuth},
    body: JSON.stringify({status: "consumed", justification: "probe"})
  });
  if (oracleProbeExisting.response.status === 404 || oracleProbeMissing.response.status === 404) {
    throw new Error(`无权主体从人工杠杆上拿到了 404，可据此枚举其它租户的对象（existing=${oracleProbeExisting.response.status} missing=${oracleProbeMissing.response.status}）`);
  }
  if (oracleProbeExisting.response.status !== oracleProbeMissing.response.status) {
    throw new Error(`存在与不存在的对象给了无权主体不同的回答：${oracleProbeExisting.response.status} vs ${oracleProbeMissing.response.status}`);
  }

  // 邀请与授权都是"把权限交给另一个主体"。授权那条一直在检查"授权方自己有没有"，
  // 邀请这条原先只过滤危险形状 —— 于是低权真人可以自造一个比自己权限更大的身份。
  const undelegatableInvite = await jsonFetch(port, "/api/accounts", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-invite-not-delegable", authorization: auth},
    body: JSON.stringify({projectId: "prj_control_plane", displayName: "Escalation Probe", email: "escalation-probe@local", roles: "viewer", permissions: "task_group:review"})
  });
  if (undelegatableInvite.response.status !== 403) {
    throw new Error(`邀请方铸出了自己并不拥有的权限（应 403，得到 ${undelegatableInvite.response.status}）`);
  }

  const invitedAccount = await jsonFetch(port, "/api/accounts", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-invited-account-login", authorization: auth},
    body: JSON.stringify({projectId: "prj_control_plane", displayName: "Project View Only", email: "project-view-only@local", roles: "viewer", permissions: "project:view"})
  });
  if (!invitedAccount.response.ok || !invitedAccount.payload.accountToken || invitedAccount.payload.account?.credentialDigest) {
    throw new Error("account invite did not return a one-time account token with a redacted public account");
	  }
	  const invitedAuth = await loginAs(port, "project-view-only@local", invitedAccount.payload.accountToken);
	  const invitedReplayDenied = await jsonFetch(port, "/api/auth/login", {
	    method: "POST",
	    body: JSON.stringify({email: "project-view-only@local", token: invitedAccount.payload.accountToken})
	  });
	  if (invitedReplayDenied.response.status !== 401) {
	    throw new Error(`expected invite account token to be one-time, got ${invitedReplayDenied.response.status}`);
	  }
	  const projectOnlyGrant = await jsonFetch(port, "/api/access-grants", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-project-only-task-scope", authorization: auth},
    body: JSON.stringify({subjectId: invitedAccount.payload.account.accountId, resourceType: "project", resourceId: "prj_control_plane", role: "viewer", permissions: ["project:view"]})
  });
  if (!projectOnlyGrant.response.ok) throw new Error("failed to create project-only view grant for invited account");
  const projectOnlyState = await jsonFetch(port, "/api/state", {headers: {authorization: invitedAuth}});
  if (!projectOnlyState.payload.projects.some((project) => project.id === "prj_control_plane")) {
    throw new Error("project-only account could not read its granted project");
  }
  if (projectOnlyState.payload.taskGroups.some((taskGroup) => taskGroup.id === "tg_runtime_management")) {
    throw new Error("project-only account unexpectedly inherited task group visibility from project membership");
  }
  if (projectOnlyState.payload.repositoryOutputs.some((target) => target.taskGroupId === "tg_runtime_management")) {
    throw new Error("project-only account unexpectedly inherited task group repository output visibility");
  }
  const unrelatedDefinition = await jsonFetch(port, "/api/shared-definition-contracts", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-unrelated-shared-definition", authorization: systemAuth},
    body: JSON.stringify({projectId: "prj_other", scopeRefs: ["Project:prj_other"], status: "owner_assigned"})
  });
  if (!unrelatedDefinition.response.ok) {
    throw new Error("failed to create unrelated shared definition fixture");
  }
  const placementDecision = await jsonFetch(port, "/api/session-placement/decide", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-session-placement", authorization: systemAuth},
    body: JSON.stringify({taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", roleId: "ui-console-service"})
  });
  if (!placementDecision.response.ok || placementDecision.payload.placement !== "new_session") {
    throw new Error("session placement did not prefer a new session for sustained work");
  }
  const badTarget = await jsonFetch(port, "/api/repository-output-targets", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-bad-repository-target", authorization: auth},
    body: JSON.stringify({artifactManifestPath: "/tmp/bad.json", pathAllowlist: ["/tmp/**"]})
  });
  if (badTarget.response.status !== 400) {
    throw new Error(`expected bad repository target 400, got ${badTarget.response.status}`);
  }
  const runResult = await jsonFetch(port, "/api/orchestrator/run", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-orchestrator-run", authorization: systemAuth},
    body: JSON.stringify({mode: "single", taskGroupId: "tg_runtime_management"})
  });
  if (!runResult.response.ok || !Array.isArray(runResult.payload.changed) || runResult.payload.changed.length === 0) {
    throw new Error("orchestrator autonomous cycle did not dispatch work");
  }
  if (!runResult.payload.changed.some((item) => item.awaiting === "agent_runtime_checkpoint")) {
    throw new Error("orchestrator did not leave work awaiting agent runtime checkpoint");
  }
  const dispatchedStateResult = await jsonFetch(port, "/api/state", {headers: {authorization: systemAuth}});
  const dispatchedState = dispatchedStateResult.payload;
  const dispatched = dispatchedState.workSessions.find((session) => session.taskGroupId === "tg_runtime_management" && openSession(session));
  if (!dispatched) throw new Error("no active work session after dispatch");
  const dispatch = dispatchedState.agentDispatches.find((item) => item.sessionId === dispatched.sessionId && item.status === "queued");
  if (!dispatch) throw new Error("no queued agent dispatch after orchestrator run");
  const activeSessionCount = dispatchedState.workSessions.filter((session) => session.taskGroupId === "tg_runtime_management" && session.workItemId === dispatched.workItemId && openSession(session)).length;
  const duplicateRun = await jsonFetch(port, "/api/orchestrator/run", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-orchestrator-run-duplicate", authorization: systemAuth},
    body: JSON.stringify({mode: "single", taskGroupId: "tg_runtime_management"})
  });
  if (!duplicateRun.response.ok || !duplicateRun.payload.changed.some((item) => item.awaiting === "awaiting_existing_checkpoint")) {
    throw new Error("orchestrator did not reuse existing active dispatch");
  }
  const duplicateStateResult = await jsonFetch(port, "/api/state", {headers: {authorization: systemAuth}});
  const duplicateState = duplicateStateResult.payload;
  const duplicateSessionCount = duplicateState.workSessions.filter((session) => session.taskGroupId === "tg_runtime_management" && session.workItemId === dispatched.workItemId && openSession(session)).length;
  if (duplicateSessionCount !== activeSessionCount) {
    throw new Error("orchestrator created duplicate active sessions for one work item");
  }
  const target = dispatchedState.repositoryOutputs.find((item) => item.workItemId === dispatched.workItemId && item.taskGroupId === dispatched.taskGroupId);
  const ownerCheckpointDenied = await jsonFetch(port, "/api/checkpoints", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-owner-checkpoint-denied", authorization: auth},
    body: JSON.stringify({taskGroupId: dispatched.taskGroupId, workId: dispatched.workItemId, sessionId: dispatched.sessionId})
  });
  if (ownerCheckpointDenied.response.status !== 403) {
    throw new Error(`expected owner checkpoint submit 403, got ${ownerCheckpointDenied.response.status}`);
  }
  const missingRunCheckpointDenied = await jsonFetch(port, "/api/checkpoints", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-agent-checkpoint-missing-run", authorization: agentAuth},
    body: JSON.stringify({taskGroupId: dispatched.taskGroupId, workId: dispatched.workItemId, sessionId: dispatched.sessionId})
  });
  if (missingRunCheckpointDenied.response.status !== 409 || missingRunCheckpointDenied.payload.error !== "checkpoint_run_id_required") {
    throw new Error(`expected checkpoint missing runId 409, got ${missingRunCheckpointDenied.response.status}:${missingRunCheckpointDenied.payload.error}`);
  }
  const wrongTarget = await jsonFetch(port, "/api/repository-output-targets", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-wrong-target", authorization: systemAuth},
    body: JSON.stringify({taskGroupId: dispatched.taskGroupId, workItemId: "work_permissions", artifactManifestPath: "docs/artifact-manifests/wrong-target.json", pathAllowlist: ["docs/**"]})
  });
  if (!wrongTarget.response.ok) throw new Error("failed to create wrong target negative fixture");
  const head = git(doctorRepo.work, ["rev-parse", "HEAD"], "0000000000000000000000000000000000000000");
  const branch = git(doctorRepo.work, ["branch", "--show-current"], "main") || "main";
  const remoteSha = git(doctorRepo.work, ["ls-remote", "origin", `refs/heads/${branch}`], "").split(/\s+/u)[0] || head;
  const forgedWrongTarget = await jsonFetch(port, "/api/checkpoints", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-forged-wrong-target", authorization: agentAuth},
    body: JSON.stringify({
      projectId: dispatched.projectId,
      taskGroupId: dispatched.taskGroupId,
      workId: dispatched.workItemId,
      sessionId: dispatched.sessionId,
      runId: "doctor-forged-wrong-target",
      summary: "Forged wrong target checkpoint.",
      commitRefs: [{repo: wrongTarget.payload.repositoryId, branch, commit: head, treeDigest: `git-tree:${head}`, createdAt: new Date().toISOString()}],
      pushRefs: [{repo: wrongTarget.payload.repositoryId, remote: "origin", ref: `refs/heads/${branch}`, sourceCommit: head, remoteSha, providerOperationId: `doctor-forged-${remoteSha}`, verifiedAt: new Date().toISOString(), rewriteRelation: "same_commit"}],
      repositoryOutputTargetRefs: [wrongTarget.payload.targetId],
      artifactManifestRefs: ["docs/artifact-manifests/missing.json"],
      changedPathEvidenceRefs: [`changed-paths:${wrongTarget.payload.targetId}:doctor`],
      evidenceRefs: ["evidence:forged"]
    })
  });
  if (forgedWrongTarget.response.status !== 409) {
    throw new Error(`expected forged wrong target 409, got ${forgedWrongTarget.response.status}`);
  }
  const forgedMissingManifest = await jsonFetch(port, "/api/checkpoints", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-forged-missing-manifest", authorization: agentAuth},
    body: JSON.stringify({
      projectId: dispatched.projectId,
      taskGroupId: dispatched.taskGroupId,
      workId: dispatched.workItemId,
      sessionId: dispatched.sessionId,
      runId: "doctor-forged-missing-manifest",
      summary: "Forged missing manifest checkpoint.",
      commitRefs: [{repo: target.repositoryId, branch, commit: head, treeDigest: `git-tree:${head}`, createdAt: new Date().toISOString()}],
      pushRefs: [{repo: target.repositoryId, remote: "origin", ref: `refs/heads/${branch}`, sourceCommit: head, remoteSha, providerOperationId: `doctor-forged-${remoteSha}`, verifiedAt: new Date().toISOString(), rewriteRelation: "same_commit"}],
      repositoryOutputTargetRefs: [target.targetId],
      artifactManifestRefs: ["docs/artifact-manifests/missing.json"],
      changedPathEvidenceRefs: [`changed-paths:${target.targetId}:doctor`],
      evidenceRefs: ["evidence:forged"]
    })
  });
  if (forgedMissingManifest.response.status !== 409) {
    throw new Error(`expected forged missing manifest 409, got ${forgedMissingManifest.response.status}`);
  }
  const workerResult = await jsonFetch(port, "/api/verification/agent-runtime/run", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-agent-runtime-worker", authorization: agentAuth},
    body: JSON.stringify({taskGroupId: "tg_runtime_management", maxJobs: 1})
  });
  if (!workerResult.response.ok || !workerResult.payload.results.some((item) => item.status === "completed")) {
    throw new Error(`agent runtime worker did not complete dispatch ${workerResult.response.status}`);
  }
  const pushedCommit = git(doctorRepo.work, ["rev-parse", "HEAD"]);
  const pushedRemote = git(doctorRepo.work, ["ls-remote", "origin", "refs/heads/main"], "").split(/\s+/u)[0];
  if (!pushedCommit || pushedCommit !== pushedRemote) {
    throw new Error("agent runtime worker did not push the committed artifact manifest");
  }
  const runtimeOutputPath = join(doctorRepo.work, "docs", "agent-runtime-output", "tg_runtime_management", `${dispatched.workItemId}.md`);
  if (!existsSync(runtimeOutputPath)) {
    throw new Error("agent runtime worker did not persist executor task output in the project git repository");
	  }
	  const statePath = join(root, doctorRuntimeDir, "control-plane-state.json");
	  const configPath = join(root, doctorRuntimeDir, "runtime-config.json");
	  const centralState = JSON.parse(readFileSync(statePath, "utf8"));
	  const projectShardIndex = centralState.projectStateShards?.projects?.find((project) => project.projectId === "prj_control_plane");
	  const projectShardFile = projectShardIndex?.storageRef?.split("/").pop();
	  const projectShardPath = projectShardFile ? join(root, doctorRuntimeDir, "project-db", projectShardFile) : "";
	  if (!projectShardPath || !existsSync(projectShardPath)) {
	    throw new Error("project-scoped state shard was not written for prj_control_plane");
	  }
	  if ((centralState.taskGroups || []).some((taskGroup) => taskGroup.projectId === "prj_control_plane")) {
	    throw new Error("central state still contains project-scoped task groups instead of shard indexes");
	  }
	  if (!projectShardIndex) {
	    throw new Error("central state does not index the prj_control_plane project shard");
	  }
  const stateHashBeforeReadiness = hashFile(statePath);
  const configHashBeforeReadiness = hashFile(configPath);
  const readinessDenied = await jsonFetch(port, "/api/task-groups/tg_runtime_management/readiness");
  if (readinessDenied.response.status !== 401) {
    throw new Error(`expected unauthenticated readiness read 401, got ${readinessDenied.response.status}`);
  }
  const readiness = await jsonFetch(port, "/api/task-groups/tg_runtime_management/readiness", {
    headers: {authorization: auth}
  });
  if (!["clear", "blocked"].includes(readiness.payload.readiness.status)) {
    throw new Error("completion readiness did not compute a terminal check status");
  }
  if (hashFile(statePath) !== stateHashBeforeReadiness || hashFile(configPath) !== configHashBeforeReadiness) {
    throw new Error("readiness GET mutated runtime state or config");
  }

  // Organization, quota, human-directive and human-confirmation HTTP lifecycle.
  const orgCreate = await jsonFetch(port, "/api/orgs", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-org-create", authorization: systemAuth},
    body: JSON.stringify({name: "医生组织", quotas: {maxMembers: 2, maxProjects: 1, maxTaskGroups: 1, maxAgents: 1}, admin: {displayName: "组织超管", email: "doctor.org.admin@local"}})
  });
  if (orgCreate.response.status !== 201 || !orgCreate.payload.accountToken) {
    throw new Error(`organization create failed: ${orgCreate.response.status}`);
  }
  const orgId = orgCreate.payload.organization.orgId;
  let orgAdminAuth = await loginAs(port, "doctor.org.admin@local", orgCreate.payload.accountToken);
  const changePassword = await jsonFetch(port, "/api/auth/change-password", {
    method: "POST",
    headers: {authorization: orgAdminAuth},
    body: JSON.stringify({newPassword: "doctor-org-admin-pass"})
  });
  if (!changePassword.response.ok) throw new Error("org admin change-password failed");
  const passwordLogin = await jsonFetch(port, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({email: "doctor.org.admin@local", password: "doctor-org-admin-pass"})
  });
  if (!passwordLogin.response.ok || !passwordLogin.payload.sessionToken) throw new Error("org admin password login failed");
  // 改密码必须撤销该账号已签发的全部会话 —— 它是"我怀疑被盗号"时唯一的自救手段，
  // 而原先它不动任何会话，已泄露的令牌最长还能再用 8 小时。
  const staleAfterPasswordChange = await jsonFetch(port, "/api/org/members", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-stale-session-after-pwchange", authorization: orgAdminAuth},
    body: JSON.stringify({displayName: "不该成功", email: "doctor.should.not@local", permissions: ["project:view"]})
  });
  if (staleAfterPasswordChange.response.status !== 401) {
    throw new Error(`改密码后旧会话仍然可用（应 401，得到 ${staleAfterPasswordChange.response.status}）—— 盗号者的令牌不受影响`);
  }
  // 改密之后必须用新会话继续
  orgAdminAuth = `Bearer ${passwordLogin.payload.sessionToken}`;
  const memberCreate = await jsonFetch(port, "/api/org/members", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-org-member", authorization: orgAdminAuth},
    body: JSON.stringify({displayName: "组织成员甲", email: "doctor.member1@local", permissions: ["project:view", "task_group:review"]})
  });
  if (memberCreate.response.status !== 201) throw new Error(`org member create failed: ${memberCreate.response.status}`);
  const memberOverQuota = await jsonFetch(port, "/api/org/members", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-org-member-2", authorization: orgAdminAuth},
    body: JSON.stringify({displayName: "组织成员乙", email: "doctor.member2@local"})
  });
  if (memberOverQuota.response.status !== 409 || memberOverQuota.payload.error !== "org_quota_exceeded" || typeof memberOverQuota.payload.quota !== "number") {
    throw new Error(`member quota was not enforced with detail: ${memberOverQuota.response.status}:${memberOverQuota.payload.error}`);
  }
  const orgMembers = await jsonFetch(port, "/api/org/members", {headers: {authorization: orgAdminAuth}});
  if (!orgMembers.response.ok || !orgMembers.payload.members.some((member) => member.email === "doctor.member1@local")) {
    throw new Error("org member list did not return the created member");
  }
  // Org-created project must let its org_admin owner control its task groups end-to-end.
  const orgProject = await jsonFetch(port, "/api/org/projects", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-org-project", authorization: orgAdminAuth},
    body: JSON.stringify({name: "组织自建项目"})
  });
  if (orgProject.response.status !== 201) throw new Error(`org project create failed: ${orgProject.response.status}`);
  const orgTaskGroup = await jsonFetch(port, "/api/task-groups", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-org-tg", authorization: orgAdminAuth},
    body: JSON.stringify({projectId: orgProject.payload.id, title: "组织任务组"})
  });
  if (orgTaskGroup.response.status !== 201) throw new Error(`org task group create failed: ${orgTaskGroup.response.status}`);
  const orgControl = await jsonFetch(port, `/api/task-groups/${orgTaskGroup.payload.taskGroup.id}/control`, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-org-tg-control", authorization: orgAdminAuth},
    body: JSON.stringify({action: "pause"})
  });
  if (orgControl.response.status !== 200) {
    throw new Error(`org_admin could not control its own org project's task group, got ${orgControl.response.status}`);
  }
  // org_admin has full org resource management: project-level config edit and confirmation review authority.
  const orgProjectConfig = await jsonFetch(port, `/api/projects/${orgProject.payload.id}/config`, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-org-proj-config", authorization: orgAdminAuth},
    body: JSON.stringify({baselineData: [{name: "基线", locator: "git:docs/baseline"}]})
  });
  if (orgProjectConfig.response.status !== 200) {
    throw new Error(`org_admin could not edit its own org project config, got ${orgProjectConfig.response.status}`);
  }
  // 暂停组织此前【什么都不停】：全仓只有配额检查一处读 org.status，于是它的实际语义仅仅是
  // "不许再新建"，成员照常登录、照常读写、名下的 agent 继续跑、继续烧模型额度。
  const suspendOrg = await jsonFetch(port, `/api/orgs/${orgId}/status`, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-org-suspend", authorization: systemAuth},
    body: JSON.stringify({status: "suspended"})
  });
  if (suspendOrg.response.status !== 200) throw new Error(`org suspend failed: ${suspendOrg.response.status}`);
  // 必须挑一个【不经配额检查】的写入动作：创建成员本来就会被配额那条 organization_suspended 挡下，
  // 用它测不出"暂停是否真的停住了执行与配置变更"，断言会假绿。
  // 用【它自己组织名下】的项目：上面 orgProjectConfig 刚验证过同一个动作在未暂停时是 200，
  // 所以这里的差别只可能来自组织被暂停。换成别人的项目会被普通权限判定挡住，测不出新判据。
  const configWhileSuspended = await jsonFetch(port, `/api/projects/${orgProject.payload.id}/config`, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-suspended-config", authorization: orgAdminAuth},
    body: JSON.stringify({baselineData: [{name: "暂停期间", locator: "git:docs/nope"}]})
  });
  if (configWhileSuspended.response.status === 200) {
    throw new Error("组织被暂停后其管理员仍能改配置 —— 暂停组织实际上只挡住了新建，没有停住任何在跑的东西");
  }
  // 读取必须仍然可用，否则被暂停的组织连"为什么停了"都查不到
  const readWhileSuspended = await jsonFetch(port, "/api/state?view=projects", {headers: {authorization: orgAdminAuth}});
  if (!readWhileSuspended.response.ok) {
    throw new Error(`组织被暂停后连读取都被挡住了（应仍可查看现状），got ${readWhileSuspended.response.status}`);
  }
  const resumeOrg = await jsonFetch(port, `/api/orgs/${orgId}/status`, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-org-resume", authorization: systemAuth},
    body: JSON.stringify({status: "active"})
  });
  if (resumeOrg.response.status !== 200) throw new Error(`org resume failed: ${resumeOrg.response.status}`);

  const orgReviewAuthority = await jsonFetch(port, "/api/human-confirmations/hcr_probe/decide", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-org-review-authority", authorization: orgAdminAuth},
    body: JSON.stringify({selectedOptionId: "none", inputText: "x"})
  });
  // 确认单不存在时，守卫拿不到它的任务组，只能退回一个 {system, human_confirmations} 兜底作用域。
  // 原先任何持直接 task_group:* 的账号都能穿过它拿到 404 —— 那既是越权放行（直接权限不绑定任何
  // 具体资源，等于对所有资源生效），也是一个不留审计的存在性预言机。现在按"作用域不可解析即拒绝"
  // 处理：不存在的 id 与无权限对调用方是同一个回答。确认单确实存在时，守卫按它的任务组落位，
  // org_admin 在自己组织内的评审权限不受影响（下面 orgConfirmationDecide 正是走这条路）。
  if (orgReviewAuthority.response.status !== 403) {
    throw new Error(`未知确认单必须与无权限同样回答 403（不可解析的作用域应当拒绝，且不泄露存在性），got ${orgReviewAuthority.response.status}`);
  }
  // Cross-organization write isolation: an org_admin cannot create a task group in another org's project.
  const crossOrgTaskGroup = await jsonFetch(port, "/api/task-groups", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-cross-org-tg", authorization: orgAdminAuth},
    body: JSON.stringify({projectId: "prj_control_plane", title: "越权任务组"})
  });
  if (crossOrgTaskGroup.response.status !== 403) {
    throw new Error(`cross-organization task group creation was not denied, got ${crossOrgTaskGroup.response.status}`);
  }
  const crossOrgDirective = await jsonFetch(port, "/api/human-directives", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-cross-org-directive", authorization: orgAdminAuth},
    body: JSON.stringify({taskGroupId: "tg_runtime_management", directiveType: "pause"})
  });
  if (crossOrgDirective.response.status !== 403) {
    throw new Error(`cross-organization directive was not denied, got ${crossOrgDirective.response.status}`);
  }

  const directive = await jsonFetch(port, "/api/human-directives", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-directive", authorization: systemAuth},
    body: JSON.stringify({taskGroupId: "tg_runtime_management", directiveType: "add_requirement", instruction: "输出文档必须包含中文摘要"})
  });
  if (directive.response.status !== 201) throw new Error(`human directive create failed: ${directive.response.status}`);
  await jsonFetch(port, "/api/orchestrator/run", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-directive-run", authorization: systemAuth},
    body: JSON.stringify({taskGroupId: "tg_runtime_management", mode: "all"})
  });
  const directiveList = await jsonFetch(port, "/api/task-groups/tg_runtime_management/human-directives", {headers: {authorization: systemAuth}});
  if (!directiveList.payload.humanDirectives.some((item) => item.status === "applied")) {
    throw new Error("human directive was not applied by orchestrator run");
  }
  const analysis = await jsonFetch(port, "/api/task-groups/tg_runtime_management/progress", {headers: {authorization: systemAuth}});
  if (!analysis.payload.taskAnalysis?.items?.length) throw new Error("task analysis breakdown was not generated");
  const cfgInherited = await jsonFetch(port, "/api/task-groups/tg_runtime_management/config", {headers: {authorization: systemAuth}});
  if (cfgInherited.payload.config.configSource !== "inherited") throw new Error("task group config did not default to inherited");
  const cfgCustom = await jsonFetch(port, "/api/task-groups/tg_runtime_management/config", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-config-set", authorization: systemAuth},
    body: JSON.stringify({businessRules: [{ruleId: "br_doctor", title: "验收规范", content: "必须包含测试"}]})
  });
  if (cfgCustom.payload.config.configSource !== "customized") throw new Error("task group config override did not customize");
  const cfgReset = await jsonFetch(port, "/api/task-groups/tg_runtime_management/config/reset", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-config-reset", authorization: systemAuth},
    body: JSON.stringify({})
  });
  if (cfgReset.payload.config.configSource !== "inherited") throw new Error("task group config reset did not restore inheritance");
  const decideMissing = await jsonFetch(port, "/api/human-confirmations/hcr_missing/decide", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-decide-missing", authorization: systemAuth},
    body: JSON.stringify({selectedOptionId: "none", inputText: "x"})
  });
  if (decideMissing.response.status !== 404) throw new Error("decide on unknown confirmation should 404");
  void orgId;
  void passwordLogin;

  // ── Gap 2B: §4 REST endpoints over shared core mutators (happy-path + auth deny) ──
  const g2 = async (path, auth, key, payload, method = "POST") => jsonFetch(port, path, {
    method,
    headers: {...(key ? {"Idempotency-Key": key} : {}), ...(auth ? {authorization: auth} : {})},
    ...(method === "POST" ? {body: JSON.stringify(payload || {})} : {})
  });

  // work-items assign → task_group:orchestrate
  expectStatus(await g2("/api/work-items/work_management_ui/assign", agentAuth, "g2b-assign-ok", {taskGroupId: "tg_runtime_management", roleId: "reviewer"}), 201, "work assign happy");
  expectStatus(await g2("/api/work-items/work_management_ui/assign", invitedAuth, "g2b-assign-deny", {taskGroupId: "tg_runtime_management", roleId: "reviewer"}), 403, "work assign deny");

  // findings → task_group:review (+ cross-tenant deny + resolve)
  const findingOk = expectStatus(await g2("/api/findings", reviewerAuth, "g2b-finding-ok", {taskGroupId: "tg_runtime_management", findingType: "review", severity: "low", summary: "doctor finding"}), 201, "finding submit happy");
  expectStatus(await g2("/api/findings", invitedAuth, "g2b-finding-deny", {taskGroupId: "tg_runtime_management", summary: "denied"}), 403, "finding submit deny");
  expectStatus(await g2("/api/findings", orgAdminAuth, "g2b-finding-crossorg", {taskGroupId: "tg_runtime_management", summary: "cross org"}), 403, "finding submit cross-tenant deny");
  expectStatus(await g2(`/api/findings/${findingOk.payload.finding.findingId}/resolve`, reviewerAuth, "g2b-finding-resolve-ok", {status: "resolved", evidenceRefs: ["evidence:doctor"], rootCauseOwner: "reviewer"}), 200, "finding resolve happy");

  // approval-requests → task_group:review (+ resolve)
  const approvalOk = expectStatus(await g2("/api/approval-requests", reviewerAuth, "g2b-approval-ok", {taskGroupId: "tg_runtime_management", action: "guarded_action"}), 201, "approval create happy");
  expectStatus(await g2("/api/approval-requests", invitedAuth, "g2b-approval-deny", {taskGroupId: "tg_runtime_management"}), 403, "approval create deny");
  expectStatus(await g2(`/api/approval-requests/${approvalOk.payload.approvalRequest.approvalId}/resolve`, reviewerAuth, "g2b-approval-resolve-ok", {status: "approved"}), 200, "approval resolve happy");

  // policy-decisions/evaluate → system:*
  expectStatus(await g2("/api/policy-decisions/evaluate", systemAuth, "g2b-policy-ok", {action: "mcp_tool_call", allowed: true}), 201, "policy eval happy");
  expectStatus(await g2("/api/policy-decisions/evaluate", reviewerAuth, "g2b-policy-deny", {action: "mcp_tool_call"}), 403, "policy eval deny");

  // contracts → project:*
  expectStatus(await g2("/api/contracts", systemAuth, "g2b-contract-ok", {projectId: "prj_control_plane", definitionType: "semantic_contract"}), 201, "contract publish happy");
  expectStatus(await g2("/api/contracts", reviewerAuth, "g2b-contract-deny", {projectId: "prj_control_plane"}), 403, "contract publish deny");

  // rooms/:roomId/messages → task_group:control (POST) / read (GET)
  expectStatus(await g2("/api/rooms/room_tg_runtime_management/messages", systemAuth, "g2b-room-ok", {taskGroupId: "tg_runtime_management", text: "doctor room message"}), 201, "room send happy");
  expectStatus(await g2("/api/rooms/room_tg_runtime_management/messages", invitedAuth, "g2b-room-deny", {taskGroupId: "tg_runtime_management", text: "x"}), 403, "room send deny");
  const roomRead = expectStatus(await g2("/api/rooms/room_tg_runtime_management/messages", systemAuth, null, null, "GET"), 200, "room wait read happy");
  if (!roomRead.payload.messages.some((message) => message.payload?.text === "doctor room message")) throw new Error("room wait did not return the sent message");
  expectStatus(await g2("/api/rooms/room_tg_runtime_management/messages", invitedAuth, null, null, "GET"), 403, "room wait read deny");

  // leases claim/release → task_group:orchestrate
  // 用一个独立的工作项建租约夹具：一个工作项同时只能有一份生效的写入边界（防止后建的宽边界顶替
  // 人批准的窄边界），所以复用 work_permissions 会拿到它既有的、已被别的会话持租的那一份。
  const leaseTarget = expectStatus(await g2("/api/repository-output-targets", systemAuth, "g2b-lease-target", {taskGroupId: "tg_runtime_management", workItemId: "work_g2b_lease_fixture", artifactManifestPath: "docs/artifact-manifests/g2b-lease.json", pathAllowlist: ["docs/**"]}), 201, "lease target fixture");
  const leaseOk = expectStatus(await g2("/api/leases/claim", systemAuth, "g2b-lease-ok", {repositoryOutputTargetRef: leaseTarget.payload.targetId, holderRef: "session:doctor-g2b"}), 201, "lease claim happy");
  expectStatus(await g2("/api/leases/claim", invitedAuth, "g2b-lease-deny", {repositoryOutputTargetRef: leaseTarget.payload.targetId}), 403, "lease claim deny");
  expectStatus(await g2(`/api/leases/${leaseOk.payload.lease.leaseId}/release`, systemAuth, "g2b-lease-release-ok", {holderRef: "session:doctor-g2b", fencingToken: leaseOk.payload.lease.fencingToken}), 200, "lease release happy");

  // artifacts → task_group:checkpoint_submit (runtime service account allowed)
  expectStatus(await g2("/api/artifacts", agentAuth, "g2b-artifact-ok", {taskGroupId: "tg_runtime_management", artifactManifestRef: "docs/artifact-manifests/doctor.json"}), 201, "artifact register happy");
  expectStatus(await g2("/api/artifacts", invitedAuth, "g2b-artifact-deny", {taskGroupId: "tg_runtime_management"}), 403, "artifact register deny");

  // permission-requests submit/resolve → checkpoint_submit (runtime allowed) / project:grant
  const permOk = expectStatus(await g2("/api/permission-requests", agentAuth, "g2b-perm-ok", {taskGroupId: "tg_runtime_management", permission: "task_group:read", subjectId: "acct_agent_runtime"}), 201, "permission request happy");
  expectStatus(await g2("/api/permission-requests", invitedAuth, "g2b-perm-deny", {taskGroupId: "tg_runtime_management", permission: "task_group:read"}), 403, "permission request deny");
  expectStatus(await g2(`/api/permission-requests/${permOk.payload.permissionRequest.requestId}/resolve`, systemAuth, "g2b-perm-resolve-ok", {status: "approved"}), 200, "permission resolve happy");

  // execution-topologies → task_group:orchestrate
  expectStatus(await g2("/api/execution-topologies", systemAuth, "g2b-topo-ok", {taskGroupId: "tg_runtime_management"}), 201, "execution topology happy");
  expectStatus(await g2("/api/execution-topologies", invitedAuth, "g2b-topo-deny", {taskGroupId: "tg_runtime_management"}), 403, "execution topology deny");

  // derived-task-requests → task_group:orchestrate
  expectStatus(await g2("/api/derived-task-requests", systemAuth, "g2b-derived-ok", {taskGroupId: "tg_runtime_management", title: "review the security configuration"}), 201, "derived task happy");
  expectStatus(await g2("/api/derived-task-requests", invitedAuth, "g2b-derived-deny", {taskGroupId: "tg_runtime_management", title: "x"}), 403, "derived task deny");

  // review-plans → task_group:review
  expectStatus(await g2("/api/review-plans", reviewerAuth, "g2b-reviewplan-ok", {taskGroupId: "tg_runtime_management"}), 201, "review plan happy");
  expectStatus(await g2("/api/review-plans", invitedAuth, "g2b-reviewplan-deny", {taskGroupId: "tg_runtime_management"}), 403, "review plan deny");

  // review-bundles → task_group:review
  expectStatus(await g2("/api/review-bundles", reviewerAuth, "g2b-reviewbundle-ok", {taskGroupId: "tg_runtime_management"}), 201, "review bundle happy");
  expectStatus(await g2("/api/review-bundles", invitedAuth, "g2b-reviewbundle-deny", {taskGroupId: "tg_runtime_management"}), 403, "review bundle deny");

  // rule-source-resolutions → task_group:control
  expectStatus(await g2("/api/rule-source-resolutions", systemAuth, "g2b-rulesource-ok", {taskGroupId: "tg_runtime_management", sourceRef: "reference:doctor", classification: "reference_only"}), 201, "rule source resolve happy");
  expectStatus(await g2("/api/rule-source-resolutions", invitedAuth, "g2b-rulesource-deny", {taskGroupId: "tg_runtime_management", sourceRef: "reference:x"}), 403, "rule source resolve deny");

  // 人工定稿闸门（HTTP 层真实校验）：机器主体【即使持有相应权限】也不得做核心决策。
  // 关键：先把所需权限真授给服务账号，否则 403 只是普通权限不足，测不出真人守卫（曾经就是这样的假绿）。
  const gateGrant = async (key, resourceType, resourceId, role, permissions) => expectStatus(await jsonFetch(port, "/api/access-grants", {
    method: "POST",
    headers: {authorization: systemAuth, "Idempotency-Key": key},
    body: JSON.stringify({subjectId: "acct_agent_runtime", resourceType, resourceId, role, permissions})
  }), 201, `授予服务账号 ${permissions.join(",")}`);
  await gateGrant("gate-grant-tg", "task_group", "tg_runtime_management", "task_group_owner", ["task_group:configure", "task_group:control", "task_group:review"]);
  await gateGrant("gate-grant-proj", "project", "prj_control_plane", "project_admin", ["project:update"]);
  // 现在服务账号权限齐备，仍必须被真人守卫拒绝 —— 403 只可能来自 HUMAN_ONLY_ACTIONS。
  expectStatus(await g2("/api/task-groups/tg_runtime_management/config", agentAuth, "gate-tgconfig-deny", {languagePolicy: {primaryLanguage: "zh-CN"}}), 403, "机器主体持权限仍不得变更任务组规则/配置");
  expectStatus(await g2("/api/projects/prj_control_plane/config", agentAuth, "gate-projconfig-deny", {languagePolicy: {primaryLanguage: "zh-CN"}}), 403, "机器主体持权限仍不得变更项目规则/配置");
  expectStatus(await g2("/api/human-directives", agentAuth, "gate-directive-deny", {taskGroupId: "tg_runtime_management", directiveType: "add_requirement", instruction: "doctor"}), 403, "机器主体持权限仍不得使用人工指令通道");
  expectStatus(await g2("/api/task-groups/tg_runtime_management/close-barrier/compute", agentAuth, "gate-close-deny", {mutate: true}), 403, "机器主体持权限仍不得关闭任务组");
  // 真人走同一条路径必须放行（证明拒绝确实是按主体类型，而不是端点本身坏了）。
  expectStatus(await g2("/api/task-groups/tg_runtime_management/config", systemAuth, "gate-tgconfig-ok", {languagePolicy: {primaryLanguage: "zh-CN"}}), 200, "真人变更任务组配置应放行");

  console.log("gap 2b §4 rest endpoints + human finalization gate ok");
  await verifyRealtimeWebSocket(port, auth);
  console.log("realtime websocket ok");
  console.log("ai-native control flow ok");
} finally {
  child.kill("SIGTERM");
}

const [code, signal] = await exitPromise;
try { rmSync(doctorRepo.base, {recursive: true, force: true}); } catch {}
if (!process.env.AIMAC_DOCTOR_RUNTIME_DIR) { try { rmSync(join(root, doctorRuntimeDir), {recursive: true, force: true}); } catch {} }
if (code && signal !== "SIGTERM") {
  throw new Error(`doctor server exited with ${code}: ${stderr}`);
}
