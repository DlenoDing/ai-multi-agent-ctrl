import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  console.log("ai-native control flow ok");
} finally {
  child.kill("SIGTERM");
}

const [code, signal] = await exitPromise;
if (code && signal !== "SIGTERM") {
  throw new Error(`doctor server exited with ${code}: ${stderr}`);
}
