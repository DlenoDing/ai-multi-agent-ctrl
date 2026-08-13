import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import WebSocket from "ws";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { readStoredState } from "../apps/control-plane-ui/lib/state-store.mjs";
import { sweepRecordsAgainstDeclaredSchemas } from "./lib/schema-validate.mjs";

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
    // 关掉后台自治周期：端到端断言的是一段确定的状态序列，后台推进会把它打乱。
    AIMAC_ORCHESTRATOR_INTERVAL_MS: "0",
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
  // 「这个单元必须先由人定稿方案」是真人专属杠杆，而它此前一条 e2e 覆盖都没有。
  // 原先服务端读的是 `body.requiresPlanFinalization === true`：字段名写错或没带，
  // 就【按"不强制"执行】并把提交人的理由记在那条相反的决定上（实测 {"required":true} 得到 200
  // 且记录里是 false）。命令接口要拒绝，不要猜 —— 猜错的是人的意思。
  const planFinalizationPath = `/api/task-groups/${createdTaskGroup.payload.taskGroup.id}`
    + `/work-items/${encodeURIComponent(createdWorkItem.payload.workItem.id)}/plan-finalization`;
  const planGuess = await jsonFetch(port, planFinalizationPath, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-plan-final-guess", authorization: systemAuth},
    body: JSON.stringify({required: true, justification: "字段名写错的调用"})
  });
  if (planGuess.response.status !== 400 || planGuess.payload.error !== "plan_finalization_requirement_required") {
    throw new Error(`没带 requiresPlanFinalization 时必须拒绝（得到 ${planGuess.response.status}/${planGuess.payload.error}）—— `
      + "缺省会被当成「不强制」，与提交人的本意相反，而理由还会记在那条相反的决定上");
  }
  const planSet = await jsonFetch(port, planFinalizationPath, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-plan-final-set", authorization: systemAuth},
    body: JSON.stringify({requiresPlanFinalization: true, justification: "涉及存储选型，先要有人拍板的方案"})
  });
  if (!planSet.response.ok || planSet.payload.requiresPlanFinalization !== true) {
    throw new Error(`显式要求人工定稿方案没有生效（${planSet.response.status}/${JSON.stringify(planSet.payload).slice(0, 120)}）`);
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

  // 处置杠杆必须真的清得掉它挡住的那一项。此前只验过"界面上有没有指引文案"和"无权主体会不会被拒"，
  // 从没验过【有权处置一次之后，关闭门里那条阻塞项是否消失】—— 一个清不掉阻塞项的杠杆，
  // 与没有杠杆是同一回事：人照着指引点完，门还挡着，而且看不出为什么。
  const barrierBlockers = async (label) => {
    const barrier = await jsonFetch(port, "/api/task-groups/tg_runtime_management/close-barrier/compute", {
      method: "POST",
      headers: {"Idempotency-Key": `doctor-barrier-${label}`, authorization: reviewerAuth},
      body: JSON.stringify({})
    });
    if (!barrier.response.ok) throw new Error(`could not compute the close barrier (${label}): ${barrier.response.status}`);
    const objects = barrier.payload?.closeBarrier?.blockingObjects || barrier.payload?.blockingObjects || [];
    return objects.map((item) => item.objectType);
  };
  const blockersBeforeResolve = await barrierBlockers("before");
  if (!blockersBeforeResolve.includes("ReviewPlan")) {
    throw new Error(`未决的评审计划没有出现在关闭门的阻塞项里（实得 ${[...new Set(blockersBeforeResolve)].join(",") || "空"}）—— 下面那条断言无从验证`);
  }
  const settleReviewPlan = await jsonFetch(port, `/api/review-plans/${crossScopePlanId}/resolve`, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-plan-settle", authorization: reviewerAuth},
    body: JSON.stringify({status: "closed", justification: "外部评审方不再参与，改由内部 QA 覆盖"})
  });
  if (!settleReviewPlan.response.ok) {
    throw new Error(`有权主体处置评审计划失败：${settleReviewPlan.response.status} ${JSON.stringify(settleReviewPlan.payload).slice(0, 160)}`);
  }
  const blockersAfterResolve = await barrierBlockers("after");
  if (blockersAfterResolve.includes("ReviewPlan")) {
    throw new Error("评审计划已被处置，关闭门里仍然挂着 ReviewPlan 阻塞项 —— 人照着指引处置完，门还是挡着，而且看不出为什么");
  }
  // 同一判据推到其余人工专属杠杆上：逐个造出阻塞项 → 用有权主体处置 → 那一项必须消失。
  // 逐条写而不是抽象成循环，是因为每类的创建载荷与终态各不相同；共同的判据由 settleAndExpectCleared 保证，
  // 其中"处置前必须真的在阻塞"这一步同样不能省 —— 少了它，任何一条都可能是在清一个本来就不存在的阻塞。
  const settleAndExpectCleared = async ({label, objectType, create, resolvePath, resolveBody, settleAuth}) => {
    const created = await create();
    if (!created.response.ok) throw new Error(`${label}: 造不出阻塞项（${created.response.status} ${JSON.stringify(created.payload).slice(0, 140)}）`);
    const before = await barrierBlockers(`${label}-before`);
    if (!before.includes(objectType)) {
      throw new Error(`${label}: 造出来之后并没有成为阻塞项（实得 ${[...new Set(before)].join(",") || "空"}）—— 这条断言无从验证`);
    }
    const settled = await jsonFetch(port, resolvePath(created), {
      method: "POST",
      // 各类处置要求的权限不同（评审计划/评审包是 task_group:review，共享定义是 project:update）——
      // 这条门验的是"杠杆能不能清掉阻塞"，谁持有它由各自的权限映射决定，这里按类取对应的主体。
      headers: {"Idempotency-Key": `doctor-settle-${label}`, authorization: settleAuth || reviewerAuth},
      body: JSON.stringify(resolveBody)
    });
    if (!settled.response.ok) throw new Error(`${label}: 有权主体处置失败（${settled.response.status} ${JSON.stringify(settled.payload).slice(0, 160)}）`);
    const after = await barrierBlockers(`${label}-after`);
    if (after.includes(objectType)) {
      throw new Error(`${label}: 处置成功了，关闭门里仍然挂着 ${objectType} —— 人照着指引处置完，门还是挡着，而且看不出为什么`);
    }
  };

  await settleAndExpectCleared({
    label: "review-bundle",
    objectType: "ReviewBundle",
    create: () => jsonFetch(port, "/api/review-bundles", {
      method: "POST",
      headers: {"Idempotency-Key": "doctor-bundle-create", authorization: reviewerAuth},
      body: JSON.stringify({taskGroupId: "tg_runtime_management", evidenceRefs: ["evidence:doctor-lever"]})
    }),
    resolvePath: (created) => `/api/review-bundles/${created.payload?.reviewBundle?.reviewBundleId || created.payload?.reviewBundleId}/resolve`,
    resolveBody: {status: "consumed", justification: "已人工复核该证据包"}
  });
  await settleAndExpectCleared({
    label: "shared-definition",
    objectType: "SharedDefinitionContract",
    // 共享定义只能经 MCP 创建（REST 上的 /api/contracts 走的是 contractPublish，是另一种记录），
    // 而处置只在 REST 上 —— 两端入口不同，所以这一条要跨两个协议才能验完整。
    create: async () => {
      const rpc = await jsonFetch(port, "/mcp", {
        method: "POST",
        headers: {authorization: systemAuth},
        body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/call", params: {
          name: "definition-mcp.shared_definition_create",
          arguments: {taskGroupId: "tg_runtime_management", projectId: "prj_control_plane",
            name: "杠杆探针术语", definitionType: "semantic_contract", status: "proposed",
            scopeRefs: ["TaskGroup:tg_runtime_management"], idempotencyKey: "doctor-definition-create"}
        }})
      });
      let contractId = null;
      try {
        const text = rpc.payload?.result?.content?.[0]?.text;
        contractId = JSON.parse(text || "{}")?.result?.sharedDefinition?.contractId || null;
      } catch { contractId = null; }
      return {response: {ok: Boolean(contractId), status: contractId ? 200 : (rpc.response?.status || 500)},
        payload: {contractId, raw: rpc.payload}};
    },
    resolvePath: (created) => `/api/shared-definition-contracts/${created.payload?.sharedDefinition?.contractId || created.payload?.contractId}/resolve`,
    resolveBody: {status: "active", justification: "人工确认该术语可生效"},
    settleAuth: auth
  });
  await settleAndExpectCleared({
    label: "permission-request",
    objectType: "PermissionOrApprovalRequest",
    // 待批的权限申请挡着关闭门。批准是把一项能力真的交出去，所以它是真人专属杠杆
    // （permission_resolve → project:grant），机器主体拿到权限也不行。
    create: () => jsonFetch(port, "/api/permission-requests", {
      method: "POST",
      headers: {"Idempotency-Key": "doctor-permreq-create", authorization: agentAuth},
      body: JSON.stringify({taskGroupId: "tg_runtime_management", permission: "task_group:read",
        subjectId: "acct_agent_runtime", justification: "杠杆探针"})
    }),
    resolvePath: (created) => `/api/permission-requests/${created.payload?.permissionRequest?.requestId || created.payload?.requestId}/resolve`,
    resolveBody: {status: "rejected", justification: "探针申请，不予授权"},
    settleAuth: auth
  });
  console.log("人工处置杠杆 ok: 评审计划、评审包、共享定义契约、权限申请处置后，关闭门的对应阻塞项确实消失");

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
  // 这条断言必须在下面那次登录【之前】：旧格式口令登录成功会就地升级为 scrypt，放在登录之后就
  // 分不清"改密写的就是 scrypt"和"改密写了弱摘要、被登录顺手补救了"——那是一条永远为真的断言。
  {
    const afterChange = JSON.parse(readFileSync(join(root, doctorRuntimeDir, "control-plane-state.json"), "utf8"));
    const changed = (afterChange.accounts || []).find((item) => item.email === "doctor.org.admin@local");
    if (!String(changed?.passwordDigest || "").startsWith("scrypt$")) {
      throw new Error(`改密落盘的不是 scrypt 而是 ${String(changed?.passwordDigest).slice(0, 24)}… —— 无密钥拉伸的摘要可被离线极快暴力破解`);
    }
  }
  const passwordLogin = await jsonFetch(port, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({email: "doctor.org.admin@local", password: "doctor-org-admin-pass"})
  });
  if (!passwordLogin.response.ok || !passwordLogin.payload.sessionToken) throw new Error("org admin password login failed");

  // 口令原先是纯 SHA-256（无密钥拉伸）：拿到状态文件即可离线极快暴力破解，而状态文件里本来就有
  // 节点令牌这类东西。改成 scrypt + 每账号随机盐 + 定时安全比较之后，必须钉住三件事：
  // 落盘的确实是 scrypt 而不是又一个裸摘要、错口令仍被拒、以及【旧格式口令还能登录并就地升级】——
  // 少了最后一条，这次升级就等于把所有已设过密码的人锁在门外。
  {
    const authStatePath = join(root, doctorRuntimeDir, "control-plane-state.json");
    const stored = JSON.parse(readFileSync(authStatePath, "utf8"));
    const orgAdmin = (stored.accounts || []).find((item) => item.email === "doctor.org.admin@local");
    if (!orgAdmin?.passwordDigest) throw new Error("改密之后账号上没有口令摘要");
    const wrongPassword = await jsonFetch(port, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({email: "doctor.org.admin@local", password: "doctor-org-admin-pass-wrong"})
    });
    if (wrongPassword.response.ok) throw new Error("错误口令竟然登录成功");

    // 旧格式兼容：直接把摘要改回纯 SHA-256 的老形状，再登录一次。
    const legacyPassword = "legacy-format-pass";
    const legacyDigest = `sha256:${createHash("sha256").update(`account-password:${orgAdmin.accountId}:${legacyPassword}`).digest("hex")}`;
    const beforeLegacy = JSON.parse(readFileSync(authStatePath, "utf8"));
    const legacyAccount = beforeLegacy.accounts.find((item) => item.accountId === orgAdmin.accountId);
    legacyAccount.passwordDigest = legacyDigest;
    beforeLegacy.stateVersion = Number(beforeLegacy.stateVersion || 1) + 1;
    writeFileSync(authStatePath, `${JSON.stringify(beforeLegacy, null, 2)}\n`);
    const legacyLogin = await jsonFetch(port, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({email: "doctor.org.admin@local", password: legacyPassword})
    });
    if (!legacyLogin.response.ok) throw new Error("旧格式口令无法登录 —— 这次升级会把所有已设过密码的人锁在门外");
    const afterLegacy = JSON.parse(readFileSync(authStatePath, "utf8"));
    const upgraded = afterLegacy.accounts.find((item) => item.accountId === orgAdmin.accountId);
    if (!String(upgraded.passwordDigest || "").startsWith("scrypt$")) {
      throw new Error("旧格式口令登录成功后没有就地升级为 scrypt —— 弱摘要会一直留在盘上");
    }
  }

  // 一次性邀请令牌只显示一次。它一丢，账号此前就报废了：没有重发路径，邮箱唯一性又拦住重建，
  // 于是只能换邮箱新建，旧账号变僵尸并继续占配额。重发必须同时做到两件事，缺一不可：
  // 新令牌能登录，且【旧令牌当场失效】—— 否则"重发"只是又发了一份，散落在聊天记录里的那份仍可用。
  // 自带一个组织：借用上面那个会撞它的成员配额，而一条断言不该靠扰动邻居来成立。
  const reissueOrg = await jsonFetch(port, "/api/orgs", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-reissue-org", authorization: systemAuth},
    body: JSON.stringify({name: "重发探针组织", quotas: {maxMembers: 3, maxProjects: 1, maxTaskGroups: 1, maxAgents: 1},
      admin: {displayName: "重发组织超管", email: "doctor.reissue.admin@local"}})
  });
  if (reissueOrg.response.status !== 201 || !reissueOrg.payload.accountToken) {
    throw new Error(`重发探针组织创建失败：${reissueOrg.response.status}`);
  }
  const reissueAdminAuth = await loginAs(port, "doctor.reissue.admin@local", reissueOrg.payload.accountToken);
  const reissueTarget = await jsonFetch(port, "/api/org/members", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-reissue-member", authorization: reissueAdminAuth},
    body: JSON.stringify({displayName: "Reissue Probe", email: "reissue-probe@local", roles: "member"})
  });
  if (!reissueTarget.response.ok || !reissueTarget.payload.accountToken) {
    throw new Error(`创建待重发成员失败：${reissueTarget.response.status} ${JSON.stringify(reissueTarget.payload).slice(0, 200)}`);
  }
  const staleInviteToken = reissueTarget.payload.accountToken;
  const reissued = await jsonFetch(port, `/api/org/members/${encodeURIComponent(reissueTarget.payload.account.accountId)}/reissue-invite`, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-reissue-member-token", authorization: reissueAdminAuth},
    body: "{}"
  });
  if (!reissued.response.ok || !reissued.payload.accountToken) {
    throw new Error(`重发邀请失败：${reissued.response.status} ${JSON.stringify(reissued.payload).slice(0, 200)}`);
  }
  if (reissued.payload.accountToken === staleInviteToken) {
    throw new Error("重发邀请返回了同一份令牌 —— 那不是重发，只是把旧令牌又显示了一次");
  }
  const staleInviteDenied = await jsonFetch(port, "/api/auth/login", {
    method: "POST", body: JSON.stringify({email: "reissue-probe@local", token: staleInviteToken})
  });
  if (staleInviteDenied.response.status !== 401) {
    throw new Error(`重发之后旧邀请令牌仍能登录（${staleInviteDenied.response.status}）—— 散落在聊天记录里的那一份还活着`);
  }
  const reissuedLogin = await jsonFetch(port, "/api/auth/login", {
    method: "POST", body: JSON.stringify({email: "reissue-probe@local", token: reissued.payload.accountToken})
  });
  if (!reissuedLogin.response.ok) {
    throw new Error(`重发出来的令牌登录不了（${reissuedLogin.response.status}）—— 重发只是换了种方式把账号弄坏`);
  }
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
  // 屏幕上的两个数必须是同一批人算出来的：配额那行写着"成员 N/上限"，成员表里就该有 N 行。
  // 此前不是 —— 用量把没有组织的账号兜底进默认组织、也把服务账号算进去，而列表两样都不算。
  // 于是配额满了，人翻遍列表也找不到该停用谁（默认组织实测差 2 个：系统属主与 agent 服务身份）。
  const quotaUsage = Number(memberOverQuota.payload.usage);
  if (orgMembers.payload.members.length !== quotaUsage) {
    throw new Error(`配额说这个组织有 ${quotaUsage} 个成员，成员表里却是 ${orgMembers.payload.members.length} 行`
      + " —— 两处算的不是同一批人，配额满了人找不到该停用谁");
  }
  // 状态视图里不许出现凭据材料。此前系统账号拿到的是【原始账号记录】，里面有 passwordDigest
  //（口令的 scrypt 哈希）和 credentialDigest（一次性登录令牌的校验值）——控制台一个都不显示，
  // 而它们会跟着 devtools、HAR 导出、录屏和任何一次 XSS 走。
  // 判据按【字段名】全量扫整份载荷，不是只盯这两个：将来账号或别的记录上再加一个凭据字段，
  // 缺省不该是"发出去"。内容摘要（bodyDigest/contentDigest 之类）不在此列，它们不是校验凭据。
  const CREDENTIAL_FIELDS = new Set(["passwordDigest", "credentialDigest", "tokenDigest", "nodeToken",
    "joinToken", "accountToken", "sessionToken", "bootstrapToken", "credentialSecret"]);
  const findCredentialFields = (node, path, hits) => {
    if (Array.isArray(node)) { node.forEach((item) => findCredentialFields(item, `${path}[]`, hits)); return; }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (CREDENTIAL_FIELDS.has(key)) hits.push(`${path}.${key}`);
      findCredentialFields(value, `${path}.${key}`, hits);
    }
  };
  for (const viewName of ["full", "system", "users", "tasks"]) {
    const viewPayload = await jsonFetch(port, `/api/state?view=${viewName}&limit=100`, {headers: {authorization: systemAuth}});
    if (!viewPayload.response.ok) throw new Error(`凭据字段扫描取不到 view=${viewName}（${viewPayload.response.status}）—— 本条在空转`);
    const hits = [];
    findCredentialFields(viewPayload.payload, viewName, hits);
    if (hits.length) {
      throw new Error(`状态视图里带出了凭据材料：${hits.slice(0, 5).join("、")}${hits.length > 5 ? ` 等 ${hits.length} 处` : ""} —— 界面一个都不显示，这些东西不该离开服务端`);
    }
  }
  // 认不出的视图名此前静默降级成基底：200 + 一份少了全部集合的载荷。调用方据此得出的
  // "这类记录一条都没有"是错的，而没有任何迹象说明它要的东西根本没被组装。
  const unknownView = await jsonFetch(port, "/api/state?view=directives&limit=10", {headers: {authorization: systemAuth}});
  if (unknownView.response.status !== 400 || unknownView.payload.error !== "state_view_unknown"
    || !(unknownView.payload.supported || []).includes("tasks")) {
    throw new Error(`认不出的视图名没有被拒（应 400 state_view_unknown 且列出可选值，得到 ${unknownView.response.status}:${unknownView.payload.error}）—— 调用方会拿一份缺集合的 200 当成"没有数据"`);
  }
  // 同一个请求打第二次走的是视图缓存那条捷径（它另有一处取 view）—— 两条路径必须一致，
  // 否则第一次被拒、第二次照常返回，或者反过来。
  const unknownViewCached = await jsonFetch(port, "/api/state?view=directives&limit=10", {headers: {authorization: systemAuth}});
  if (unknownViewCached.response.status !== 400) {
    throw new Error(`认不出的视图名第二次请求返回 ${unknownViewCached.response.status} —— 视图缓存那条捷径绕过了校验`);
  }
  const knownView = await jsonFetch(port, "/api/state?view=tasks&limit=10", {headers: {authorization: systemAuth}});
  if (!knownView.response.ok || !Array.isArray(knownView.payload.taskGroups)) {
    throw new Error(`合法视图被误伤：view=tasks 返回 ${knownView.response.status}`);
  }
  // authPolicy.mfaRequired 是 account.schema.json 的必填字段、也回显给调用方，但全仓没有一处读它。
  // 今天它处处写死 false，所以看不出问题 —— 一旦有任何路径把它置为 true，登录会一声不吭地照发会话。
  // 这里直接改盘上的账号记录把它置为 true（本阶段编排间隔是 0，没有后台写在抢），再走真实登录：
  // 做不到的安全策略必须停在门口。验完改回去，并确认改回去之后登录恢复正常。
  const mfaStatePath = join(root, doctorRuntimeDir, "control-plane-state.json");
  const flipMfa = (required) => {
    const snapshot = JSON.parse(readFileSync(mfaStatePath, "utf8"));
    const owner = snapshot.accounts.find((item) => item.accountId === "acct_system_owner");
    owner.authPolicy = {...owner.authPolicy, mfaRequired: required};
    writeFileSync(mfaStatePath, JSON.stringify(snapshot, null, 2));
  };
  flipMfa(true);
  const mfaLogin = await jsonFetch(port, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({email: "system.admin@local", token: "doctor-bootstrap-token"})
  });
  flipMfa(false);
  if (mfaLogin.response.status !== 403 || mfaLogin.payload.error !== "mfa_required_but_unavailable") {
    throw new Error(`账号声明必须二次验证，登录却照发会话（应 403 mfa_required_but_unavailable，得到 ${mfaLogin.response.status}:${mfaLogin.payload.error}）—— 声明了做不到的安全策略等于没有`);
  }
  const mfaRestored = await jsonFetch(port, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({email: "system.admin@local", token: "doctor-bootstrap-token"})
  });
  if (!mfaRestored.payload.sessionToken) throw new Error(`把 mfaRequired 改回 false 之后仍然登不进来：${mfaRestored.response.status}:${mfaRestored.payload.error}`);
  // 全新部署只有一个系统管理员，而它的 organizationId 是 null —— 与它自己调用这条路由时的 orgId
  // 恰好相等，所以它够得着自己。停用会当场吊销会话、登录被拒，而铸一个新的系统管理员又要
  // system:account_admin：整个部署永久失去系统层控制权。这里只验拒绝的那一支（放行支会把本次
  // e2e 后面的所有系统级动作一起废掉），实测过的放行条件是"存在另一个 status=active 的系统管理员"，
  // 仅仅"已邀请未接受"不算数 —— 那种账号还登不进来，算进去等于放行锁死。
  const lastSystemAdmin = await jsonFetch(port, "/api/org/members/acct_system_owner/status", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-last-system-admin", authorization: systemAuth},
    body: JSON.stringify({status: "disabled"})
  });
  if (lastSystemAdmin.response.status !== 409 || lastSystemAdmin.payload.error !== "system_last_admin_cannot_be_disabled") {
    throw new Error(`最后一个系统管理员被允许停用（应 409 system_last_admin_cannot_be_disabled，得到 ${lastSystemAdmin.response.status}:${lastSystemAdmin.payload.error}）—— 部署会永久失去系统层控制权`);
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
  // 跨租户隔离：不逐条枚举字段，而是把【别的租户的 id】收集起来，在组织管理员拿到的整份载荷里
  // 全文搜。逐条断言只能覆盖"我想到的那些集合"，而本仓这类漏洞恰恰出在没想到的那一个上
  //（视图基底不过滤 taskGroups、按 taskGroupId 归属的 worker lane、用复数 projectIds 的节点，
  // 三次都是这么漏的）。这条判据对【将来新增的集合】自动生效。
  const systemWide = await jsonFetch(port, "/api/state?view=full&limit=200", {headers: {authorization: systemAuth}});
  if (!systemWide.response.ok) throw new Error("跨租户扫描取不到系统侧全量视图 —— 本条在空转");
  const mine = new Set([orgId, orgProject.payload.id, orgTaskGroup.payload.taskGroup.id]);
  for (const account of systemWide.payload.accounts || []) if (account.organizationId === orgId) mine.add(account.accountId);
  const foreignIds = [];
  for (const [collection, idField] of [["projects", "id"], ["taskGroups", "id"], ["organizations", "orgId"],
    ["accounts", "accountId"], ["agentRuntimeNodes", "nodeId"]]) {
    for (const item of systemWide.payload[collection] || []) {
      const id = item[idField];
      if (!id || mine.has(id)) continue;
      // 组织管理员本人和它自己组织里的对象不算外租户
      if (item.organizationId === orgId) continue;
      foreignIds.push(`${collection}.${id}`);
    }
  }
  const foreignIdValues = new Set(foreignIds.map((entry) => entry.split(".").slice(1).join(".")));
  if (foreignIds.length < 3) throw new Error(`跨租户扫描只收集到 ${foreignIds.length} 个外租户 id —— 夹具太干净，本条在空转`);
  const asOrgAdmin = await jsonFetch(port, "/api/state?view=full&limit=200", {headers: {authorization: orgAdminAuth}});
  // 外租户 id 出现在【引用字段】上（谁创建的、谁裁决的）与【对象本身被发出来】不是一回事。
  // 判据做成登记制：引用位置要逐个写明理由，其余一律报红 —— 这样将来多出一处引用会被看见，
  // 而不是被一句宽泛的例外悄悄放过。
  const ALLOWED_FOREIGN_REFERENCE_FIELDS = {
    createdBy: "组织记录上的创建者是系统账号；这是【自己组织】的元数据，不是别的租户的对象"
  };
  const foreignHits = [];
  const locateForeign = (node, path) => {
    if (Array.isArray(node)) { node.forEach((item, index) => locateForeign(item, `${path}[${index}]`)); return; }
    if (node && typeof node === "object") { for (const [key, value] of Object.entries(node)) locateForeign(value, `${path}.${key}`); return; }
    const text = String(node);
    if (!foreignIdValues.has(text)) return;
    const field = path.split(".").pop().replace(/\[\d+\]$/u, "");
    if (ALLOWED_FOREIGN_REFERENCE_FIELDS[field]) return;
    foreignHits.push(`${path}=${text}`);
  };
  locateForeign(asOrgAdmin.payload, "");
  if (foreignHits.length) {
    throw new Error(`组织管理员的整份状态载荷里出现了别的租户的对象：${foreignHits.slice(0, 6).join("、")}`
      + `${foreignHits.length > 6 ? ` 等 ${foreignHits.length} 处` : ""} —— 若确属合法引用，登记到 ALLOWED_FOREIGN_REFERENCE_FIELDS 并写明理由`);
  }

  // 组织用量是派生量，而两条路径各自算各自的：GET /api/orgs 当场重算，
  // GET /api/state?view=orgs（组织管理员自己的概览页）此前读的是上一次写入时存下的快照。
  // 任务组创建那条路由不重算用量，于是刚建完就差一个 —— 实测配额 1/1 已满而概览显示 0，
  // 人以为还有名额，点下去必然失败。判据是"两条独立路径必须给出同一份用量"，
  // 不跟任何写死的期望值比：写死的那种在计数规则改动时会一起错。
  const usageFromOrgsApi = await jsonFetch(port, "/api/orgs", {headers: {authorization: systemAuth}});
  const usageFromStateView = await jsonFetch(port, "/api/state?view=orgs&limit=50", {headers: {authorization: systemAuth}});
  const orgFromApi = (usageFromOrgsApi.payload.organizations || usageFromOrgsApi.payload || []).find((item) => item.orgId === orgId);
  const orgFromView = (usageFromStateView.payload.organizations || []).find((item) => item.orgId === orgId);
  if (!orgFromApi || !orgFromView) throw new Error(`用量对照取不到组织 ${orgId} —— 判据在空转`);
  if (JSON.stringify(orgFromApi.usage) !== JSON.stringify(orgFromView.usage)) {
    throw new Error(`同一个组织的用量两条路径不一致：/api/orgs ${JSON.stringify(orgFromApi.usage)} vs 概览页 ${JSON.stringify(orgFromView.usage)} —— 人看到的是旧的那一份`);
  }
  const orgControl = await jsonFetch(port, `/api/task-groups/${orgTaskGroup.payload.taskGroup.id}/control`, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-org-tg-control", authorization: orgAdminAuth},
    body: JSON.stringify({action: "pause"})
  });
  // 认不出来的控制动作必须当场拒绝：此前它返回 200（照默认那条跑），并把请求体里的名字
  // 原样写进审计日志 —— 谁都能往问责记录里写一条自己编的动作。
  const bogusControl = await jsonFetch(port, `/api/task-groups/${orgTaskGroup.payload.taskGroup.id}/control`, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-org-tg-control-bogus", authorization: orgAdminAuth},
    body: JSON.stringify({action: "approved_by_security_review"})
  });
  if (bogusControl.response.status !== 400) {
    throw new Error(`未登记的任务组控制动作返回了 ${bogusControl.response.status} —— 人得到成功回执却什么都没发生，且这个名字会进审计`);
  }
  if (orgControl.response.status !== 200) {
    throw new Error(`org_admin could not control its own org project's task group, got ${orgControl.response.status}`);
  }
  // org_admin has full org resource management: project-level config edit and confirmation review authority.
  // 整份替换类字段必须先读版本再写 —— 这正是真实客户端要做的事（不先读就写，等于愿意覆盖别人）。
  const orgProjectConfigRead = await jsonFetch(port, `/api/projects/${orgProject.payload.id}/config`, {headers: {authorization: orgAdminAuth}});
  const orgProjectConfig = await jsonFetch(port, `/api/projects/${orgProject.payload.id}/config`, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-org-proj-config", authorization: orgAdminAuth},
    body: JSON.stringify({baselineData: [{name: "基线", locator: "git:docs/baseline"}],
      expectedConfigVersion: orgProjectConfigRead.payload.configVersion})
  });
  if (orgProjectConfig.response.status !== 200) {
    throw new Error(`org_admin could not edit its own org project config, got ${orgProjectConfig.response.status}`);
  }
  // 组织管理员离职后在控制台上下不了线（成员查找把 org_admin 整个排除在外），只能靠系统管理员
  // 专属的 MCP 工具。允许停用，但不得把组织锁死。
  const lastAdminDisable = await jsonFetch(port, `/api/org/members/${orgCreate.payload.organization.initialAdminAccountId}/status`, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-last-admin-disable", authorization: orgAdminAuth},
    body: JSON.stringify({status: "disabled"})
  });
  if (lastAdminDisable.response.status !== 409) {
    throw new Error(`停用最后一个活跃组织管理员应被拒（409），得到 ${lastAdminDisable.response.status} —— 组织会被彻底锁死`);
  }
  // 把一个【尚未接受邀请】的成员置为 active 会让它两条登录路径全断且无法恢复：
  // 邀请令牌分支要求 status === "invited"，密码分支要求 passwordDigest（邀请态没有），
  // 而系统没有重发邀请或重置密码的接口。它还会继续占着成员配额。
  const zombieActivate = await jsonFetch(port, `/api/org/members/${memberCreate.payload.account.accountId}/status`, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-zombie-activate", authorization: orgAdminAuth},
    body: JSON.stringify({status: "active"})
  });
  if (zombieActivate.response.status !== 409) {
    throw new Error(`把未接受邀请的成员置为 active 应被拒（409），得到 ${zombieActivate.response.status} —— 会造出永远登不进来且仍占配额的僵尸账号`);
  }
  // 而这条判据不能只看【当前是不是 invited】：先停用再启用，两步就把同一个僵尸洗成 active。
  const zombieLaunderDisable = await jsonFetch(port, `/api/org/members/${memberCreate.payload.account.accountId}/status`, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-zombie-withdraw", authorization: orgAdminAuth},
    body: JSON.stringify({status: "disabled"})
  });
  if (zombieLaunderDisable.response.status !== 200) throw new Error(`withdrawing an invitation failed: ${zombieLaunderDisable.response.status}`);
  const zombieLaunder = await jsonFetch(port, `/api/org/members/${memberCreate.payload.account.accountId}/status`, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-zombie-launder", authorization: orgAdminAuth},
    body: JSON.stringify({status: "active"})
  });
  if (zombieLaunder.response.status !== 409 || zombieLaunder.payload.error !== "org_member_invitation_pending") {
    throw new Error(`先停用再启用把未接受邀请的成员洗成了 active（应 409，得到 ${zombieLaunder.response.status}）—— 两步绕过了上一条守卫`);
  }
  // 撤回之后必须还有出路：重发邀请要能把它放回 invited，且新令牌真的登得进来，否则这个账号
  // 永远占着配额、邮箱唯一性又拦住重建。
  const withdrawnReissue = await jsonFetch(port, `/api/org/members/${memberCreate.payload.account.accountId}/reissue-invite`, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-withdrawn-reissue", authorization: orgAdminAuth}
  });
  if (withdrawnReissue.response.status !== 200 || withdrawnReissue.payload.account.status !== "invited") {
    throw new Error(`被撤回的邀请无法重发（${withdrawnReissue.response.status}:${withdrawnReissue.payload.error}）—— 该账号再也回不来，还占着成员配额`);
  }
  const withdrawnLogin = await jsonFetch(port, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({email: "doctor.member1@local", token: withdrawnReissue.payload.accountToken})
  });
  if (!withdrawnLogin.payload.sessionToken) throw new Error(`重发之后仍然登不进来：${withdrawnLogin.response.status}:${withdrawnLogin.payload.error}`);
  // 系统管理员在成员管理页看得到某组织的成员，就必须动得了 —— 原先这条路由按【操作者自己】的
  // 组织匹配，系统管理员的 organizationId 是 null，于是列表里每一个成员按下停用都回
  // org_member_not_found："这个成员不存在"，而它就在上面那张表里。
  const memberAccountId = orgMembers.payload.members.find((member) => member.email === "doctor.member1@local")?.accountId;
  const systemActsOnMember = await jsonFetch(port, `/api/org/members/${encodeURIComponent(memberAccountId)}/status`, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-system-member-status", authorization: systemAuth},
    body: JSON.stringify({status: "disabled"})
  });
  if (systemActsOnMember.response.status !== 200 || systemActsOnMember.payload.status !== "disabled") {
    throw new Error(`系统管理员动不了它列得出来的组织成员（应 200 disabled，得到 ${systemActsOnMember.response.status}:${systemActsOnMember.payload.error}）—— 界面上的停用按钮按下去必然失败`);
  }
  const systemRestoresMember = await jsonFetch(port, `/api/org/members/${encodeURIComponent(memberAccountId)}/status`, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-system-member-restore", authorization: systemAuth},
    body: JSON.stringify({status: "active"})
  });
  if (systemRestoresMember.response.status !== 200) throw new Error(`system admin could not re-enable the member: ${systemRestoresMember.response.status}`);
  // 同一张表上还有「权限」「重发邀请」两个按钮，它们此前是同一个毛病。这两条都写成【不改变任何
  // 东西】的形态：权限原样提交、重发对一个已激活的账号 —— 关键是它必须回 409（够得着、但不适用），
  // 而不是 404（找不到这个成员）。区分的正是被修掉的那个缺陷。
  const systemEditsPermissions = await jsonFetch(port, `/api/org/members/${encodeURIComponent(memberAccountId)}/permissions`, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-system-member-perms", authorization: systemAuth},
    body: JSON.stringify({permissions: orgMembers.payload.members.find((member) => member.email === "doctor.member1@local").permissions})
  });
  if (systemEditsPermissions.response.status !== 200) {
    throw new Error(`系统管理员改不了它列得出来的成员权限（${systemEditsPermissions.response.status}:${systemEditsPermissions.payload.error}）—— 界面上的「权限」按钮是坏的`);
  }
  const systemReissues = await jsonFetch(port, `/api/org/members/${encodeURIComponent(memberAccountId)}/reissue-invite`, {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-system-member-reissue", authorization: systemAuth}
  });
  if (systemReissues.response.status !== 409 || systemReissues.payload.error !== "org_member_invite_reissue_not_applicable") {
    throw new Error(`系统管理员的重发邀请没够着这个成员（应 409 not_applicable，得到 ${systemReissues.response.status}:${systemReissues.payload.error}）—— 404 说明这条路由仍按操作者自己的组织找人`);
  }
  // 而放开这条口子不得让"别的组织有没有这个账号"漏出去：存在但不属于我 与 根本不存在，
  // 对组织管理员必须是同一个回答，否则这条路由就成了跨租户的存在性探针。
  const foreignTarget = await jsonFetch(port, "/api/org/members/acct_system_owner/status", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-foreign-member", authorization: orgAdminAuth},
    body: JSON.stringify({status: "disabled"})
  });
  const absentTarget = await jsonFetch(port, "/api/org/members/acct_no_such_account/status", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-absent-member", authorization: orgAdminAuth},
    body: JSON.stringify({status: "disabled"})
  });
  if (foreignTarget.response.status !== 404 || absentTarget.response.status !== 404
    || foreignTarget.payload.error !== absentTarget.payload.error) {
    throw new Error(`组织外账号与不存在账号的回答不一致（${foreignTarget.response.status}:${foreignTarget.payload.error} vs ${absentTarget.response.status}:${absentTarget.payload.error}）—— 可以拿它探测别的组织有哪些账号`);
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
  // org_admin 在自己组织内的评审权限不受影响 —— 确认单确实存在时，守卫按它的任务组落位。
  // （原先这里写着"下面 orgConfirmationDecide 正是走这条路"，而那个变量在本文件里并不存在：
  //   注释指向一个不存在的用例，读的人会以为那条路径被覆盖过。）
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

  // 认不出的指令类型必须被拒，不能降级成一条便条：pause/cancel 拼错一个字母，原先会记成
  // free_text（HTTP 201、无任何提示），活照跑，而人以为自己已经把它停了。报文要连合法清单一起给，
  // 否则调用方只能猜。
  const badDirective = await jsonFetch(port, "/api/human-directives", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-directive-bad-type", authorization: systemAuth},
    body: JSON.stringify({taskGroupId: "tg_runtime_management", directiveType: "pause_execution", instruction: "停一下"})
  });
  if (badDirective.response.status !== 400 || badDirective.payload.error !== "human_directive_type_unknown") {
    throw new Error(`认不出的指令类型必须拒绝（得到 ${badDirective.response.status}/${badDirective.payload.error}）—— `
      + "降级成 free_text 意味着 pause 拼错就变成一条便条，活照跑而人以为停住了");
  }
  if (!(badDirective.payload.supported || []).includes("pause")) {
    throw new Error("拒绝报文里没有给出合法的指令类型清单 —— 调用方只能猜自己该写什么");
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
    // 整份替换必须带上读到的那一版；cfgInherited 就是刚读的那次。
    body: JSON.stringify({businessRules: [{ruleId: "br_doctor", title: "验收规范", content: "必须包含测试"}],
      expectedConfigVersion: cfgInherited.payload.configVersion})
  });
  if (cfgCustom.response.status !== 200) throw new Error(`带正确版本的任务组规则保存被拒：${cfgCustom.response.status} ${JSON.stringify(cfgCustom.payload).slice(0, 200)}`);
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
  // 两个人同时编辑同一层规则：后保存者原先会静默删掉前保存者新增的规则，两人都拿到 200。
  // 丢的正是安全规则本身，而且不留痕。现在保存必须带上"我读到的是哪一版"。
  {
    const readCfg = await jsonFetch(port, "/api/projects/prj_control_plane/config", {headers: {authorization: auth}});
    if (!readCfg.payload.configVersion) throw new Error("项目配置未返回 configVersion，前端无从带回，前提形同虚设");
    const stale = readCfg.payload.configVersion;
    const first = await g2("/api/projects/prj_control_plane/config", auth, "cfg-first",
      {businessRules: [{ruleId: "biz.concurrent.a", title: "A 的规则", content: "A", enabled: true}], expectedConfigVersion: stale});
    expectStatus(first, 200, "带着正确版本的规则保存应通过");
    // B 拿着同一份旧版本保存：必须被拒，而不是把 A 刚加的那条删掉。
    expectStatus(await g2("/api/projects/prj_control_plane/config", auth, "cfg-second",
      {businessRules: [{ruleId: "biz.concurrent.b", title: "B 的规则", content: "B", enabled: true}], expectedConfigVersion: stale}),
      409, "拿着过期版本保存规则必须被拒（否则会静默删掉别人刚写下的规则）");
    // 不带版本同样必须被拒 —— 否则任何忘了带的调用方都能绕过这道前提。
    expectStatus(await g2("/api/projects/prj_control_plane/config", auth, "cfg-noversion",
      {businessRules: []}), 409, "不带版本保存整份规则必须被拒");
    const afterCfg = await jsonFetch(port, "/api/projects/prj_control_plane/config", {headers: {authorization: auth}});
    if (!(afterCfg.payload.config.businessRules || []).some((rule) => rule.ruleId === "biz.concurrent.a")) {
      throw new Error("A 写下的规则在并发保存之后消失了");
    }
  }

  expectStatus(await g2(`/api/permission-requests/${permOk.payload.permissionRequest.requestId}/resolve`, systemAuth, "g2b-perm-resolve-ok", {status: "approved"}), 200, "permission resolve happy");
  // 两个人同时处置同一条授权请求：后到的那个必须拿到 409，而不是 200。
  // 回 200 的后果是【拒绝方被告知成功，而权限其实已经授出】—— 他不会再去看结果。
  expectStatus(await g2(`/api/permission-requests/${permOk.payload.permissionRequest.requestId}/resolve`, systemAuth, "g2b-perm-resolve-again", {status: "rejected"}), 409, "已被处置的授权请求必须回 409（否则拒绝方以为自己成功了，而权限已授出）");
  expectStatus(await g2(`/api/approval-requests/${approvalOk.payload.approvalRequest.approvalId}/resolve`, reviewerAuth, "g2b-approval-resolve-again", {status: "rejected"}), 409, "已被处置的审批请求必须回 409");

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

  // GET /api/state 走了一条快路径：命中视图缓存时只读中央状态（拿 stateVersion 与账号会话），
  // 不水合整份状态（2000 单元实测轮询 108ms → 15ms）。它必须在两件事上与慢路径完全一致：
  // 写入之后立刻看得到新值（不能按旧版本命中缓存），以及鉴权一分不少。
  {
    const orgsBefore = await jsonFetch(port, "/api/state?view=orgs", {headers: {authorization: systemAuth}});
    const probeOrgId = orgsBefore.payload.organizations?.[0]?.orgId;
    if (!probeOrgId) throw new Error("doctor: 状态视图里没有组织 —— 快路径断言无从验证");
    // 先打一次让缓存热起来，再写入，再读 —— 快路径若按旧 stateVersion 命中，这里会读回旧值。
    await jsonFetch(port, "/api/state?view=orgs", {headers: {authorization: systemAuth}});
    const quotaWrite = await jsonFetch(port, `/api/orgs/${probeOrgId}/quotas`, {method: "POST",
      headers: {"Idempotency-Key": "doctor-fastpath-quota", authorization: systemAuth},
      body: JSON.stringify({quotas: {maxMembers: 73}})});
    if (!quotaWrite.response.ok) throw new Error(`doctor: 快路径断言的写入没成功（HTTP ${quotaWrite.response.status}）`);
    const orgsAfter = await jsonFetch(port, "/api/state?view=orgs", {headers: {authorization: systemAuth}});
    if (orgsAfter.payload.organizations?.find((item) => item.orgId === probeOrgId)?.quotas?.maxMembers !== 73) {
      throw new Error("doctor: 写入之后 GET /api/state 仍返回旧值 —— 视图快路径按过期的 stateVersion 命中了缓存");
    }
    const anonView = await fetch(`http://127.0.0.1:${port}/api/state?view=orgs`);
    if (anonView.status !== 401) throw new Error(`doctor: 未认证读状态视图返回了 ${anonView.status}`);
    const bogusView = await fetch(`http://127.0.0.1:${port}/api/state?view=orgs`, {headers: {authorization: "Bearer bogus-token"}});
    if (bogusView.status !== 401) throw new Error(`doctor: 坏令牌读状态视图返回了 ${bogusView.status}`);
    console.log("状态视图快路径 ok: 写入后立刻可见、未认证与坏令牌仍被拒");
  }
  await verifyRealtimeWebSocket(port, auth);
  console.log("realtime websocket ok");

  // 审计归档：内存只留最近 80 条，更早的操作只在归档文件里。归档若没有读取入口、
  // 哈希链若从没被校验过、写失败若无声无息 —— "事后查得到"这句话就是假的。
  {
    const archivePath = join(root, doctorRuntimeDir, "audit-log.jsonl");
    const readArchive = async (as = systemAuth, query = "?limit=200") =>
      jsonFetch(port, `/api/audit-archive${query}`, {headers: {authorization: as}});
    const archive = await readArchive();
    if (!archive.response.ok || !(archive.payload.entries || []).length) {
      throw new Error(`doctor: 审计归档读不出记录（HTTP ${archive.response.status}）—— 80 条之前的操作事后无从查起`);
    }
    const chain = archive.payload.chain || {};
    if (chain.verified !== archive.payload.entries.length || (chain.breaks || []).length) {
      throw new Error(`doctor: 归档哈希链校验异常 verified=${chain.verified} breaks=${JSON.stringify(chain.breaks)}`);
    }
    // 这一轮里 REST 与 MCP 交替写过同一本台账（上面共享定义那条走的是 /mcp）。链校验本身
    // 少一条也照样通过 —— 所以要单独要求 MCP 那条真的在归档里，且看得出是谁做的。
    // 合流之前，经 MCP 改的状态在这本账上一条痕迹都没有。
    // 读【归档文件本身】而不是那个接口：接口取的是末尾若干条，而 MCP 那次调用发生在这一轮很早的
    // 阶段，后面几百条 REST 动作会把它挤出窗口 —— 我第一版就是这么写的，报出来的是假红。
    const archivedLines = readFileSync(archivePath, "utf8").trim().split("\n").filter(Boolean);
    const mcpEntries = archivedLines.map((line) => { try { return JSON.parse(line); } catch { return {}; } })
      .filter((entry) => entry.action === "mcp_tool_call");
    if (!mcpEntries.length) {
      throw new Error("doctor: 这一轮有过 MCP 写调用，归档里却没有 mcp_tool_call —— 经 MCP 改的状态在主台账上没有痕迹");
    }
    if (!mcpEntries.every((entry) => String(entry.actor || "").startsWith("mcp:"))) {
      throw new Error(`doctor: MCP 那条审计记录看不出是谁做的（actor=${mcpEntries.map((entry) => entry.actor).join(",")}）`);
    }
    if (!mcpEntries.some((entry) => String(entry.subject || "").includes("definition-mcp.shared_definition_create"))) {
      throw new Error(`doctor: MCP 审计记录里没写清做了什么（subject=${mcpEntries.map((entry) => entry.subject).join(" | ").slice(0, 200)}）`);
    }
    // 链校验必须真的能发现改动：改掉归档里的一条执行者，它必须报出来。
    const originalArchive = readFileSync(archivePath, "utf8");
    const archiveLines = originalArchive.trim().split("\n");
    const victim = JSON.parse(archiveLines[archiveLines.length - 2]);
    victim.actor = "someone-else";
    archiveLines[archiveLines.length - 2] = JSON.stringify(victim);
    writeFileSync(archivePath, `${archiveLines.join("\n")}\n`);
    const tampered = await readArchive(systemAuth, "?limit=20");
    writeFileSync(archivePath, originalArchive);
    if (!((tampered.payload.chain || {}).breaks || []).length) {
      throw new Error("doctor: 改掉归档里一条记录的执行者，哈希链校验没有报出来 —— 这条链是装饰");
    }
    // 归档跨全部组织，只对系统账号开放。
    const tenantRead = await fetch(`http://127.0.0.1:${port}/api/audit-archive`, {headers: {authorization: orgAdminAuth}});
    if (tenantRead.status !== 403) {
      throw new Error(`doctor: 组织管理员读到了跨全部组织的审计归档（HTTP ${tenantRead.status}）`);
    }
    // 控制台每 5 秒轮询一次当前页视图。内容没变时必须回 304、不传载荷；
    // 而"变了却还回 304"会让人一直看着旧状态 —— 这两面都要验。
    {
      const etagUrl = `http://127.0.0.1:${port}/api/state?view=orgs&limit=200`;
      const firstResponse = await fetch(etagUrl, {headers: {authorization: systemAuth}});
      const stateEtag = firstResponse.headers.get("etag");
      const firstBody = await firstResponse.text();
      if (!stateEtag) throw new Error("doctor: 状态视图响应没有 ETag —— 控制台每 5 秒的轮询只能整份重传");
      const notModified = await fetch(etagUrl, {headers: {authorization: systemAuth, "if-none-match": stateEtag}});
      const notModifiedBody = await notModified.text();
      if (notModified.status !== 304 || notModifiedBody.length !== 0) {
        throw new Error(`doctor: 内容没变时没有回 304（HTTP ${notModified.status}，载荷 ${notModifiedBody.length} 字节，`
          + `首次 ${firstBody.length} 字节）`);
      }
      const etagOrgId = (await jsonFetch(port, "/api/state?view=orgs", {headers: {authorization: systemAuth}}))
        .payload.organizations?.[0]?.orgId;
      if (!etagOrgId) throw new Error("doctor: ETag 断言拿不到组织 —— 本条在空转");
      const quotaBump = await jsonFetch(port, `/api/orgs/${etagOrgId}/quotas`, {method: "POST",
        headers: {"Idempotency-Key": "doctor-etag-bump", authorization: systemAuth},
        body: JSON.stringify({quotas: {maxMembers: 71}})});
      if (!quotaBump.response.ok) throw new Error("doctor: ETag 断言的写入没成功");
      const afterWrite = await fetch(etagUrl, {headers: {authorization: systemAuth, "if-none-match": stateEtag}});
      if (afterWrite.status !== 200) {
        throw new Error(`doctor: 写入之后旧 ETag 仍被判为未变化（HTTP ${afterWrite.status}）—— 人会一直看着旧状态`);
      }
      // 第三面：ETag 不许跨视图串用。缓存键里少写一个维度（视图名 / 上限 / 项目 / 账号）时，
      // 前两条断言照样全绿 —— 而人切到另一页会拿到 304，界面显示的是上一页的数据，
      // 且它会一直"没变化"下去。这一面比前两面更难发现，因为它看起来只是"数据没刷新"。
      const freshEtag = afterWrite.headers.get("etag");
      for (const [label, url] of [["换视图", `http://127.0.0.1:${port}/api/state?view=system&limit=200`],
        ["换上限", `http://127.0.0.1:${port}/api/state?view=orgs&limit=199`]]) {
        const crossed = await fetch(url, {headers: {authorization: systemAuth, "if-none-match": freshEtag}});
        if (crossed.status !== 200) {
          throw new Error(`doctor: ${label}之后旧 ETag 仍被判为未变化（HTTP ${crossed.status}）—— 缓存键少了一个维度，人会在这一页上看到另一页的数据`);
        }
      }
      console.log("状态视图 ETag ok: 没变回 304 零载荷、变了立刻回 200、且不跨视图/上限串用");
    }

    console.log(`审计归档 ok: ${archive.payload.entries.length} 条可读、哈希链逐条校验、改动能被发现、非系统账号 403`);
  }
  console.log("ai-native control flow ok");
} finally {
  child.kill("SIGTERM");
}

// 后台自治周期：上面那台服务把它关掉了（端到端断言的是一段确定的状态序列）。可关掉就等于没验证过，
// 而"这个特性根本没被跑过"正是本仓反复出现的形态。这里另起一台短周期的服务，**不发任何请求**，
// 只看状态会不会自己往前走 —— 那才是"人建完任务组之后不必点任何东西"这句话的实际含义。
{
  const tickPort = port + 1;
  const tickChild = spawn(process.execPath, ["apps/control-plane-ui/server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      AIMAC_HOST: "127.0.0.1",
      AIMAC_PORT: String(tickPort),
      AIMAC_RUNTIME_DIR: doctorRuntimeDir,
      AIMAC_ORCHESTRATOR_INTERVAL_MS: "5000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let tickStderr = "";
  tickChild.stderr.on("data", (chunk) => { tickStderr += String(chunk); });
  try {
    const statePath = join(root, doctorRuntimeDir, "control-plane-state.json");
    const versionOf = () => { try { return Number(JSON.parse(readFileSync(statePath, "utf8")).stateVersion || 0); } catch { return 0; } };
    const before = versionOf();
    let advanced = false;
    for (let attempt = 0; attempt < 40 && !advanced; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      advanced = versionOf() > before;
    }
    if (!advanced) {
      throw new Error(`autonomous orchestrator tick never advanced state on its own (stateVersion stayed ${before}) — a person who creates a task group would wait forever, because nothing drives the cycle: ${tickStderr.slice(0, 400)}`);
    }
    console.log("autonomous orchestrator tick ok: state advanced with no request made");
  } finally {
    tickChild.kill("SIGTERM");
    await new Promise((resolve) => tickChild.on("exit", resolve));
  }
}

// 这一轮 e2e 走过的是另一批路径：人工确认与定稿、权限与审批、评审计划、房间、组织、质量门。
// 它们产出的记录同样从来没有被自己声明的规范压过 —— 而"没被真实记录压过的规范一定会漂移"
// 这件事，上一轮已经在 agent e2e 那边逐条证实了。
// 服务端此刻已退出，磁盘上就是这一轮真实跑完的状态。
const doctorProducedState = readStoredState({
  root,
  runtimeDir: join(root, doctorRuntimeDir),
  statePath: join(root, doctorRuntimeDir, "control-plane-state.json"),
  seedPath: join(root, "data/seed-state.json"),
  // 走到"新建初始状态"说明读的不是本轮跑出来的东西；那样校验一份崭新的种子会得到毫无意义的绿。
  buildInitialState: () => { throw new Error("doctor: 期望读到本轮跑出的状态，却触发了初始状态创建"); }
});
const doctorSweep = sweepRecordsAgainstDeclaredSchemas(doctorProducedState, {
  specDir: join(root, "spec"), label: "控制面 e2e 产出", minValidated: 50
});
if (!(doctorProducedState.humanConfirmationRequests || []).some((item) => item.schemaVersion)) {
  throw new Error("doctor: 本轮没有产出任何带 schemaVersion 的人工确认单 —— 这道规范核对在空转，人工定稿闸门的记录面依旧无人校验");
}
if (doctorSweep.errors.length) {
  throw new Error(`doctor: e2e 真实产出的记录不符合它们自己声明的规范：\n- ${doctorSweep.errors.slice(0, 200).join("\n- ")}`);
}
console.log(`控制面 e2e 产出规范核对 ok: ${doctorSweep.validated} 条记录符合各自声明的 schema（含人工确认与定稿记录）；${doctorSweep.uncoveredNote}`);

const [code, signal] = await exitPromise;
try { rmSync(doctorRepo.base, {recursive: true, force: true}); } catch {}
if (!process.env.AIMAC_DOCTOR_RUNTIME_DIR) { try { rmSync(join(root, doctorRuntimeDir), {recursive: true, force: true}); } catch {} }
if (code && signal !== "SIGTERM") {
  throw new Error(`doctor server exited with ${code}: ${stderr}`);
}
