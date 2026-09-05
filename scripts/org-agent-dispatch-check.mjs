#!/usr/bin/env node
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowedFlags = new Set(["--help", "-h", "--keep-runtime"]);
const unknownFlags = process.argv.slice(2).filter((arg) => arg.startsWith("-") && !allowedFlags.has(arg));
if (unknownFlags.length) {
  console.error(`unknown option(s): ${unknownFlags.join(", ")}`);
  console.error("usage: node scripts/org-agent-dispatch-check.mjs [--keep-runtime]");
  process.exit(2);
}
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log([
    "usage: node scripts/org-agent-dispatch-check.mjs [--keep-runtime]",
    "",
    "Runs an isolated org Agent dispatch verification:",
    "- same-org org-scoped Agent profile selection",
    "- project-bound runtime node claim/completion",
    "- member grant and cross-org visibility isolation",
    "- deterministic git auth failure classification",
    "",
    "Options:",
    "  --keep-runtime   Preserve the temp runtime fixture and print restart metadata.",
    "  --help, -h       Show this help."
  ].join("\n"));
  process.exit(0);
}
const keepRuntime = process.argv.includes("--keep-runtime");
const bootstrapToken = "org-agent-dispatch-bootstrap-token";
const roleUnderTest = "ui-console-service";
let serverChild = null;
let baseDir = null;
let runtimeDir = null;
let agentAWorkDir = null;

function logOk(message) {
  console.log(`ok: ${message}`);
}

function fail(message) {
  throw new Error(message);
}

async function getFreePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const {port} = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function jsonFetch(baseUrl, path, options = {}) {
  const {timeoutMs = 15000, ...fetchOptions} = options;
  const response = await fetch(`${baseUrl}${path}`, {
    ...fetchOptions,
    signal: fetchOptions.signal || AbortSignal.timeout(timeoutMs),
    headers: {"content-type": "application/json", ...(fetchOptions.headers || {})}
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = {message: text}; }
  return {response, payload};
}

async function expectStatus(baseUrl, path, options, status, label) {
  const result = await jsonFetch(baseUrl, path, options);
  if (result.response.status !== status) {
    fail(`${label}: expected HTTP ${status}, got ${result.response.status} ${JSON.stringify(result.payload).slice(0, 300)}`);
  }
  return result.payload;
}

async function login(baseUrl, email, token) {
  const payload = await expectStatus(baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({email, token})
  }, 200, `login ${email}`);
  if (!payload.sessionToken) fail(`login ${email}: response did not include a session token`);
  return `Bearer ${payload.sessionToken}`;
}

function git(repoRoot, args) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000
  }).trim();
}

function setupRepository() {
  const repoBase = join(baseDir, "git");
  const remote = join(repoBase, "remote.git");
  const work = join(repoBase, "work");
  mkdirSync(repoBase, {recursive: true});
  execFileSync("git", ["init", "--bare", remote], {stdio: "pipe", timeout: 60000});
  execFileSync("git", ["init", "-b", "main", work], {stdio: "pipe", timeout: 60000});
  git(work, ["config", "user.email", "org-agent-dispatch-check@local"]);
  git(work, ["config", "user.name", "Org Agent Dispatch Check"]);
  writeFileSync(join(work, "README.md"), "# Org Agent Dispatch Check\n");
  writeFileSync(join(work, ".aimac-verification-repository"), "verification\n");
  git(work, ["add", "README.md", ".aimac-verification-repository"]);
  git(work, ["commit", "-m", "Initialize org agent dispatch check repository"]);
  git(work, ["remote", "add", "origin", remote]);
  git(work, ["push", "origin", "HEAD:refs/heads/main"]);
  return {remote, work};
}

function setupExecutor() {
  const executorPath = join(baseDir, "deterministic-executor.mjs");
  writeFileSync(executorPath, `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const input = JSON.parse(readFileSync(0, "utf8"));
const outputPath = \`docs/org-agent-dispatch-check/\${input.taskGroupId}/\${input.workId}.md\`;
mkdirSync(join(input.repositoryRoot, dirname(outputPath)), {recursive: true});
writeFileSync(join(input.repositoryRoot, outputPath), [
  \`# \${input.workId}\`,
  "",
  \`Dispatch: \${input.dispatchId}\`,
  \`TaskGroup: \${input.taskGroupId}\`,
  \`Session: \${input.sessionId}\`,
  \`RoleSkill: \${input.roleSkill?.roleSkillRef || ""}\`,
  ""
].join("\\n"));
console.log(JSON.stringify({
  summary: "Deterministic executor completed org agent dispatch check.",
  verificationRefs: ["executor:deterministic"],
  evidenceRefs: ["executor:deterministic"],
  changedPaths: [outputPath],
  commitMessage: \`Org agent dispatch check output for \${input.workId}\`
}));
`);
  return executorPath;
}

async function waitForHealth(baseUrl, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverChild?.exitCode !== null) fail(`control-plane server exited before health check completed with code ${serverChild.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/runtime/health`, {signal: AbortSignal.timeout(1000)});
      if (response.ok) return await response.json();
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
  }
  fail("control-plane server did not become healthy");
}

function startServer(port, repositoryRoot) {
  const child = spawn(process.execPath, ["apps/control-plane-ui/server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      AIMAC_HOST: "127.0.0.1",
      AIMAC_PORT: String(port),
      AIMAC_PUBLIC_URL: `http://127.0.0.1:${port}`,
      AIMAC_RUNTIME_DIR: runtimeDir,
      AIMAC_REPOSITORY_ROOT: repositoryRoot,
      AIMAC_BOOTSTRAP_TOKEN: bootstrapToken,
      AIMAC_EXECUTION_PROFILE: "verification",
      AIMAC_ORCHESTRATOR_INTERVAL_MS: "0",
      AIMAC_ALLOW_LOCAL_GIT_REMOTE: "true",
      AIMAC_STATE_STORE: "runtime_json",
      AIMAC_EXIT_WITH_PARENT: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  serverChild = child;
  return child;
}

function runAgentRuntime(args, env = {}) {
  const result = spawnSync(process.execPath, ["apps/agent-runtime/runtime.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 20 * 1024 * 1024,
    env: {...process.env, ...env}
  });
  if (result.status !== 0) {
    fail(`agent runtime ${args.join(" ")} failed with ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function spawnAgentRuntime(args, env = {}, timeoutMs = 90000) {
  const child = spawn(process.execPath, ["apps/agent-runtime/runtime.mjs", ...args], {
    cwd: root,
    env: {...process.env, ...env},
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolveDone) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolveDone({status, signal, stdout, stderr});
    });
  });
  return {child, done, output: () => ({stdout, stderr})};
}

async function stopServer(child, timeoutMs = 4000) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = once(child, "exit").then(() => true);
  const timedOut = new Promise((resolveWait) => setTimeout(() => resolveWait(false), timeoutMs));
  if (!(await Promise.race([exited, timedOut])) && child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 1000))]);
  }
}

async function createOrg(baseUrl, systemAuth, key, name) {
  const email = `${key}@org-agent-dispatch-check.local`;
  const payload = await expectStatus(baseUrl, "/api/orgs", {
    method: "POST",
    headers: {authorization: systemAuth, "Idempotency-Key": `org-agent-dispatch-check-org-${key}`},
    body: JSON.stringify({
      name,
      admin: {email, displayName: `${name} Admin`},
      quotas: {maxProjects: 4, maxTaskGroups: 12, maxAgents: 8, maxMembers: 8}
    })
  }, 201, `create ${name}`);
  return {
    orgId: payload.organization.orgId,
    adminAccountId: payload.adminAccount.accountId,
    adminEmail: email,
    accountToken: payload.accountToken,
    auth: await login(baseUrl, email, payload.accountToken)
  };
}

async function createOrgMember(baseUrl, auth, key, defaultProjectId) {
  const email = `${key}@org-agent-dispatch-check.local`;
  const payload = await expectStatus(baseUrl, "/api/org/members", {
    method: "POST",
    headers: {authorization: auth, "Idempotency-Key": `org-agent-dispatch-check-member-${key}`},
    body: JSON.stringify({
      email,
      displayName: `Org Dispatch ${key} Member`,
      roles: ["member"],
      permissions: ["project:view"],
      ...(defaultProjectId ? {defaultProjectId} : {})
    })
  }, 201, `invite org member ${key}`);
  return {
    accountId: payload.account.accountId,
    email,
    accountToken: payload.accountToken
  };
}

async function grantProjectViewer(baseUrl, auth, key, projectId, accountId, extraBody = {}) {
  return await expectStatus(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/members`, {
    method: "POST",
    headers: {authorization: auth, "Idempotency-Key": `org-agent-dispatch-check-project-member-${key}`},
    body: JSON.stringify({...extraBody, accountId, role: "viewer"})
  }, 200, `grant project viewer ${key}`);
}

async function grantTaskGroupReviewer(baseUrl, auth, key, taskGroupId, accountId) {
  return await expectStatus(baseUrl, "/api/access-grants", {
    method: "POST",
    headers: {authorization: auth, "Idempotency-Key": `org-agent-dispatch-check-tg-reviewer-${key}`},
    body: JSON.stringify({
      subjectId: accountId,
      resourceType: "task_group",
      resourceId: taskGroupId,
      role: "reviewer"
    })
  }, 201, `grant task group reviewer ${key}`);
}

async function createProject(baseUrl, auth, key, remote) {
  const payload = await expectStatus(baseUrl, "/api/org/projects", {
    method: "POST",
    headers: {authorization: auth, "Idempotency-Key": `org-agent-dispatch-check-project-${key}`},
    body: JSON.stringify({
      name: `Org dispatch project ${key}`,
      repositories: [{
        id: `repo_${key}`,
        url: remote,
        defaultBranch: "main",
        credentialMode: "none",
        credential: {mode: "none"}
      }]
    })
  }, 201, `create project ${key}`);
  return payload.id;
}

async function createAgentProfile(baseUrl, auth, key) {
  return await expectStatus(baseUrl, "/api/agents", {
    method: "POST",
    headers: {authorization: auth, "Idempotency-Key": `org-agent-dispatch-check-agent-${key}`},
    body: JSON.stringify({
      name: `Org ${key.toUpperCase()} UI console profile`,
      role: roleUnderTest,
      model: "custom:deterministic",
      trustScore: 0.91
    })
  }, 201, `create org ${key} agent profile`);
}

async function createTaskGroupAndWork(baseUrl, auth, key, projectId) {
  const group = await expectStatus(baseUrl, "/api/task-groups", {
    method: "POST",
    headers: {authorization: auth, "Idempotency-Key": `org-agent-dispatch-check-tg-${key}`},
    body: JSON.stringify({
      projectId,
      name: `Org ${key.toUpperCase()} dispatch selection`,
      objective: "Exercise org scoped logical agent profile selection and runtime node claim.",
      languageTag: "en",
      roles: [roleUnderTest]
    })
  }, 201, `create task group ${key}`);
  const taskGroupId = group.taskGroup.id;
  const workItemId = await createWorkItem(baseUrl, auth, key, taskGroupId);
  return {taskGroupId, workItemId};
}

async function createWorkItem(baseUrl, auth, key, taskGroupId) {
  const work = await expectStatus(baseUrl, `/api/task-groups/${encodeURIComponent(taskGroupId)}/work-items`, {
    method: "POST",
    headers: {authorization: auth, "Idempotency-Key": `org-agent-dispatch-check-work-${key}`},
    body: JSON.stringify({
      title: `Org ${key.toUpperCase()} deterministic artifact`,
      ownerRole: roleUnderTest,
      requirements: ["Produce one repository artifact through the agent runtime transport."]
    })
  }, 201, `create work item ${key}`);
  return work.workItem.id;
}

async function registerNodeByApi(baseUrl, auth, key, projectId) {
  const join = await expectStatus(baseUrl, "/api/agent-join-tokens", {
    method: "POST",
    headers: {authorization: auth, "Idempotency-Key": `org-agent-dispatch-check-join-${key}`},
    body: JSON.stringify({projectId, allowedRoles: [roleUnderTest], ttlSeconds: 900})
  }, 201, `create join token ${key}`);
  const registered = await expectStatus(baseUrl, "/api/agent/v1/register", {
    method: "POST",
    headers: {authorization: `Bearer ${join.joinToken}`, "Idempotency-Key": `org-agent-dispatch-check-register-${key}`},
    body: JSON.stringify({
      nodeName: `org-${key}-api-node`,
      requestedRoles: [roleUnderTest],
      runtimeVersion: "org-agent-dispatch-check",
      profile: {tools: [], models: [{providerClass: "custom", adapter: "deterministic", available: true}]}
    })
  }, 201, `register api node ${key}`);
  await expectStatus(baseUrl, "/api/agent/v1/self-check", {
    method: "POST",
    headers: {authorization: `Bearer ${registered.nodeToken}`},
    body: JSON.stringify({checks: [
      {checkId: "runtime", status: "ok", detail: "script"},
      {checkId: "gateway", status: "ok", detail: "script"},
      {checkId: "filesystem", status: "ok", detail: "script"},
      {checkId: "git", status: "ok", detail: "script"},
      {checkId: "remote_mcp", status: "ok", detail: "script"},
      {checkId: "model_executor", status: "ok", detail: "custom:deterministic"}
    ], profile: {tools: [], models: [{providerClass: "custom", adapter: "deterministic", available: true}]}})
  }, 200, `self-check api node ${key}`);
  return registered;
}

async function createJoinToken(baseUrl, auth, key, projectId) {
  return await expectStatus(baseUrl, "/api/agent-join-tokens", {
    method: "POST",
    headers: {authorization: auth, "Idempotency-Key": `org-agent-dispatch-check-join-${key}`},
    body: JSON.stringify({projectId, allowedRoles: [roleUnderTest], ttlSeconds: 900})
  }, 201, `create join token ${key}`);
}

async function readState(baseUrl, auth, label) {
  return await expectStatus(baseUrl, "/api/state?view=full&limit=200", {
    headers: {authorization: auth},
    timeoutMs: 20000
  }, 200, label);
}

function findGrant(state, {subjectId, resourceType, resourceId, role}) {
  return (state.accessGrants || []).find((grant) =>
    grant.subjectRef?.subjectId === subjectId &&
    grant.resource?.resourceType === resourceType &&
    grant.resource?.resourceId === resourceId &&
    (!role || grant.role === role) &&
    grant.status === "active"
  );
}

function assertVisible(collection, idField, expectedId, label) {
  if (!(collection || []).some((item) => item[idField] === expectedId)) fail(`${label} was not visible`);
}

function assertNotVisible(collection, idField, forbiddenId, label) {
  if ((collection || []).some((item) => item[idField] === forbiddenId)) fail(`${label} leaked into member-scoped state`);
}

function assertGrantTargetsMember(state, {memberAccountId, spoofedAccountId, projectId, taskGroupId}) {
  const projectGrant = findGrant(state, {
    subjectId: memberAccountId,
    resourceType: "project",
    resourceId: projectId,
    role: "viewer"
  });
  if (!projectGrant) fail("project viewer grant was not persisted for the invited member account");
  if (findGrant(state, {subjectId: spoofedAccountId, resourceType: "project", resourceId: projectId})) {
    fail("project member route honored spoofed subjectId instead of the route accountId");
  }
  const reviewerGrant = findGrant(state, {
    subjectId: memberAccountId,
    resourceType: "task_group",
    resourceId: taskGroupId,
    role: "reviewer"
  });
  if (!reviewerGrant) fail("task group reviewer grant was not persisted for the invited member account");
  if (!(reviewerGrant.permissions || []).includes("task_group:review")) {
    fail(`task group reviewer grant missed task_group:review permission: ${JSON.stringify(reviewerGrant.permissions)}`);
  }
}

function assertMemberScopedVisibility(state, ids) {
  assertVisible(state.projects, "id", ids.projectA, "org A project");
  assertVisible(state.taskGroups, "id", ids.taskGroupId, "org A task group");
  assertVisible(state.agents, "id", ids.profileA, "org A org-scoped agent profile");
  assertVisible(state.accounts, "accountId", ids.memberA, "logged-in member account");
  assertNotVisible(state.projects, "id", ids.projectB, "foreign org project");
  assertNotVisible(state.agents, "id", ids.profileB, "foreign org agent profile");
  if (ids.nodeB) assertNotVisible(state.agentRuntimeNodes, "nodeId", ids.nodeB, "foreign org runtime node");
  assertNotVisible(state.accounts, "accountId", ids.orgBAdmin, "foreign org account");
  if ((state.accessGrants || []).some((grant) => grant.subjectRef?.subjectId === ids.orgBAdmin)) {
    fail("foreign org grant subject leaked into member-scoped access grants");
  }
}

function installAuthenticationFailureHook(remote) {
  const hookPath = join(remote, "hooks", "pre-receive");
  writeFileSync(hookPath, [
    "#!/bin/sh",
    "echo 'Authentication failed' >&2",
    "exit 1",
    ""
  ].join("\n"));
  chmodSync(hookPath, 0o755);
  return hookPath;
}

async function waitForPermissionRequest(baseUrl, auth, dispatchId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readState(baseUrl, auth, "poll permission request");
    const request = (state.permissionRequests || []).find((item) =>
      item.status === "pending_approval" &&
      (item.dispatchId === dispatchId || String(item.reason || "").includes(dispatchId))
    );
    if (request) return request;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  fail(`runtime did not submit a permission request for dispatch ${dispatchId}`);
}

async function resolvePermissionRequest(baseUrl, auth, requestId) {
  return await expectStatus(baseUrl, `/api/permission-requests/${encodeURIComponent(requestId)}/resolve`, {
    method: "POST",
    headers: {authorization: auth, "Idempotency-Key": `org-agent-dispatch-check-permission-resolve-${requestId}`},
    body: JSON.stringify({status: "approved", ttlSeconds: 60})
  }, 200, `approve permission request ${requestId}`);
}

async function runFailureRuntimeAndApprovePermission(baseUrl, auth, dispatchId) {
  const runtime = spawnAgentRuntime([
    "run",
    "--once",
    "--work-dir", agentAWorkDir,
    "--claim-ttl", "180"
  ], {
    AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true",
    AIMAC_AGENT_REQUEST_TIMEOUT_MS: "20000",
    AIMAC_AGENT_SWEEP_INTERVAL_MS: "600000",
    AIMAC_AGENT_EXECUTION_TIMEOUT_MS: "60000",
    AIMAC_AGENT_PERMISSION_POLL_INTERVAL_MS: "200",
    AIMAC_AGENT_PERMISSION_POLL_ATTEMPTS: "100"
  }, 90000);
  const request = await waitForPermissionRequest(baseUrl, auth, dispatchId);
  await resolvePermissionRequest(baseUrl, auth, request.requestId);
  const result = await runtime.done;
  if (result.status !== 0) {
    fail(`failure-path agent runtime exited with ${result.status ?? result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  if (!combined.includes("dispatch failed:") || !combined.includes("git_auth_failed")) {
    fail(`failure-path runtime did not surface git_auth_failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return {permissionRequestId: request.requestId, runtimeOutput: combined};
}

async function queueSingleDispatch(baseUrl, auth, taskGroupId, workItemId, key) {
  const run = await expectStatus(baseUrl, "/api/orchestrator/run", {
    method: "POST",
    headers: {authorization: auth, "Idempotency-Key": `org-agent-dispatch-check-orchestrator-${key}`},
    body: JSON.stringify({mode: "single", taskGroupId, autoSyncSkills: false})
  }, 200, `orchestrator dispatch ${key}`);
  const queuedChange = (run.changed || []).find((item) => item.taskGroupId === taskGroupId && item.workItemId === workItemId && item.dispatchId);
  if (!queuedChange) fail(`orchestrator did not queue ${key} work: ${JSON.stringify(run.changed || []).slice(0, 500)}`);
  return queuedChange;
}

async function assertGitAuthFailureArrived(baseUrl, auth, taskGroupId, workItemId, dispatchId) {
  const detail = await expectStatus(baseUrl, `/api/task-groups/${encodeURIComponent(taskGroupId)}`, {
    headers: {authorization: auth}
  }, 200, "read git auth failure task group");
  const dispatch = detail.agentDispatches.find((item) => item.dispatchId === dispatchId);
  const session = detail.workSessions.find((item) => item.dispatchId === dispatchId || item.workItemId === workItemId);
  if (dispatch?.status !== "failed") fail(`git auth dispatch status=${dispatch?.status}; expected failed`);
  if (!String(dispatch.failureReason || "").startsWith("git_auth_failed:")) {
    fail(`git auth dispatch failureReason=${dispatch.failureReason}; expected git_auth_failed`);
  }
  if (!String(session?.blockedReason || "").startsWith("git_auth_failed:")) {
    fail(`git auth session blockedReason=${session?.blockedReason}; expected git_auth_failed mirror`);
  }
  const events = await expectStatus(baseUrl, `/api/task-groups/${encodeURIComponent(taskGroupId)}/execution-events?limit=100`, {
    headers: {authorization: auth}
  }, 200, "read git auth failure events");
  const failedEvent = (events.events || []).find((event) =>
    event.eventType === "failed" &&
    (event.dispatchId === dispatchId || event.workItemId === workItemId || String(event.summary || "").includes("git_auth_failed"))
  );
  if (!failedEvent || !String(failedEvent.summary || "").includes("git_auth_failed")) {
    fail(`missing failed execution event with git_auth_failed; saw ${(events.events || []).map((event) => `${event.eventType}:${event.summary || ""}`).join(" | ").slice(0, 1000)}`);
  }
  return {dispatch, failedEvent};
}

function printFixtureMetadata(metadata) {
  console.log(`fixture metadata: ${JSON.stringify(metadata, null, 2)}`);
}

async function main() {
  mkdirSync(join(root, ".runtime"), {recursive: true});
  baseDir = mkdtempSync(join(root, ".runtime", "org-agent-dispatch-check-"));
  runtimeDir = join(baseDir, "control-plane-runtime");
  agentAWorkDir = join(baseDir, "agent-a-runtime");
  const repo = setupRepository();
  const executorPath = setupExecutor();
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = startServer(port, repo.work);
  let serverOutput = "";
  child.stdout.on("data", (chunk) => { serverOutput += chunk; });
  child.stderr.on("data", (chunk) => { serverOutput += chunk; });
  child.on("exit", (code) => {
    if (code && code !== 0) serverOutput += `\nserver exited with ${code}\n`;
  });
  let succeeded = false;
  let fixtureMetadata = {baseDir, runtimeDir, agentRuntimeDir: agentAWorkDir, port, baseUrl};

  try {
    await waitForHealth(baseUrl);
    logOk(`isolated control-plane server healthy on ${baseUrl}`);
    const systemAuth = await login(baseUrl, "system.admin@local", bootstrapToken);
    fixtureMetadata.bootstrapAuth = {email: "system.admin@local", token: bootstrapToken};

    const orgB = await createOrg(baseUrl, systemAuth, "b", "Dispatch Check Org B");
    const orgA = await createOrg(baseUrl, systemAuth, "a", "Dispatch Check Org A");
    const projectB = await createProject(baseUrl, orgB.auth, "b", repo.remote);
    const projectA = await createProject(baseUrl, orgA.auth, "a", repo.remote);
    const profileB = await createAgentProfile(baseUrl, orgB.auth, "b");
    const profileA = await createAgentProfile(baseUrl, orgA.auth, "a");
    if (profileA.id === profileB.id) fail("profile fixture collapsed: org A and org B agent profiles have the same id");
    fixtureMetadata.orgA = {orgId: orgA.orgId, adminAccountId: orgA.adminAccountId, adminEmail: orgA.adminEmail, projectId: projectA, profileId: profileA.id};
    fixtureMetadata.orgB = {orgId: orgB.orgId, adminAccountId: orgB.adminAccountId, adminEmail: orgB.adminEmail, projectId: projectB, profileId: profileB.id};
    logOk(`created distinct org-scoped profiles (${profileA.id} in ${orgA.orgId}, ${profileB.id} in ${orgB.orgId})`);

    const {taskGroupId, workItemId} = await createTaskGroupAndWork(baseUrl, orgA.auth, "a", projectA);
    const memberA = await createOrgMember(baseUrl, orgA.auth, "a-reviewer", projectA);
    fixtureMetadata.memberA = {accountId: memberA.accountId, email: memberA.email, token: "<generated; omitted>"};
    fixtureMetadata.taskGroupId = taskGroupId;
    fixtureMetadata.successWorkItemId = workItemId;
    await grantProjectViewer(baseUrl, orgA.auth, "a-body-account-only", projectA, memberA.accountId);
    await grantProjectViewer(baseUrl, orgA.auth, "a-spoofed-subject", projectA, memberA.accountId, {subjectId: orgB.adminAccountId});
    await grantTaskGroupReviewer(baseUrl, orgA.auth, "a", taskGroupId, memberA.accountId);
    const grantState = await readState(baseUrl, systemAuth, "read grant state");
    assertGrantTargetsMember(grantState, {
      memberAccountId: memberA.accountId,
      spoofedAccountId: orgB.adminAccountId,
      projectId: projectA,
      taskGroupId
    });
    const memberAuth = await login(baseUrl, memberA.email, memberA.accountToken);
    const memberInitialState = await readState(baseUrl, memberAuth, "read member initial state");
    assertMemberScopedVisibility(memberInitialState, {
      projectA,
      projectB,
      taskGroupId,
      profileA: profileA.id,
      profileB: profileB.id,
      memberA: memberA.accountId,
      orgBAdmin: orgB.adminAccountId
    });
    await expectStatus(baseUrl, `/api/task-groups/${encodeURIComponent(taskGroupId)}`, {
      headers: {authorization: memberAuth}
    }, 200, "member reads reviewer task group");
    logOk(`invited org A member ${memberA.accountId}; project viewer and task-group reviewer grants are visible only to the actual accountId`);

    const queuedChange = await queueSingleDispatch(baseUrl, orgA.auth, taskGroupId, workItemId, "success");
    const initialDetail = await expectStatus(baseUrl, `/api/task-groups/${encodeURIComponent(taskGroupId)}`, {
      headers: {authorization: systemAuth}
    }, 200, "read queued task group");
    const queuedDispatch = initialDetail.agentDispatches.find((item) => item.dispatchId === queuedChange.dispatchId);
    const queuedSession = initialDetail.workSessions.find((item) => item.sessionId === queuedChange.sessionId);
    if (!queuedDispatch || queuedDispatch.status !== "queued") fail("queued dispatch was not visible in task group detail");
    if (!queuedSession) fail("queued work session was not visible in task group detail");
    if (queuedSession.agentId !== profileA.id) {
      fail(`org A work session selected ${queuedSession.agentId}; expected org A profile ${profileA.id} and not org B profile ${profileB.id}`);
    }
    if (queuedSession.agentId === profileB.id) fail("cross-org profile was selected for org A work");
    logOk(`org A task group selected org A logical Agent profile ${queuedSession.agentId}`);

    const nodeB = await registerNodeByApi(baseUrl, orgB.auth, "b", projectB);
    const memberAfterForeignNodeState = await readState(baseUrl, memberAuth, "read member state after foreign node");
    assertMemberScopedVisibility(memberAfterForeignNodeState, {
      projectA,
      projectB,
      taskGroupId,
      profileA: profileA.id,
      profileB: profileB.id,
      memberA: memberA.accountId,
      orgBAdmin: orgB.adminAccountId,
      nodeB: nodeB.node.nodeId
    });
    const bClaim = await expectStatus(baseUrl, "/api/agent/v1/dispatches/next", {
      method: "POST",
      headers: {authorization: `Bearer ${nodeB.nodeToken}`},
      body: JSON.stringify({claimTtlSeconds: 120})
    }, 200, "org B claim attempt");
    if (bClaim.dispatch) {
      fail(`org B runtime node claimed org A dispatch ${bClaim.dispatch?.dispatch?.dispatchId || bClaim.dispatch?.dispatchId}`);
    }
    logOk(`org B runtime node ${nodeB.node.nodeId} was excluded from org A queued dispatch`);

    const joinA = await createJoinToken(baseUrl, orgA.auth, "a-runtime", projectA);
    const bootstrap = runAgentRuntime([
      "bootstrap",
      "--server", baseUrl,
      "--join-token", joinA.joinToken,
      "--node-name", "org-a-real-runtime",
      "--roles", roleUnderTest,
      "--work-dir", agentAWorkDir,
      "--executor-command", `node ${JSON.stringify(executorPath)}`
    ], {AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true"});
    const nodeIdMatch = bootstrap.stdout.match(/nodeId=([^\s]+)/u);
    const agentNodeId = nodeIdMatch?.[1];
    if (!agentNodeId) fail(`could not parse AGENT_JOINED nodeId from bootstrap output:\n${bootstrap.stdout}`);
    if (agentNodeId === profileA.id) fail("runtime node id unexpectedly equals the logical agent profile id");
    logOk(`registered real runtime node ${agentNodeId}, distinct from logical profile ${profileA.id}`);

    const runtimeRun = runAgentRuntime([
      "run",
      "--once",
      "--work-dir", agentAWorkDir,
      "--claim-ttl", "180"
    ], {
      AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true",
      AIMAC_AGENT_REQUEST_TIMEOUT_MS: "20000",
      AIMAC_AGENT_SWEEP_INTERVAL_MS: "600000"
    });
    if (!runtimeRun.stdout.includes("dispatch completed:")) {
      fail(`agent runtime did not report a completed dispatch:\nstdout:\n${runtimeRun.stdout}\nstderr:\n${runtimeRun.stderr}`);
    }

    const finalDetail = await expectStatus(baseUrl, `/api/task-groups/${encodeURIComponent(taskGroupId)}`, {
      headers: {authorization: systemAuth}
    }, 200, "read final task group");
    const finalDispatch = finalDetail.agentDispatches.find((item) => item.dispatchId === queuedDispatch.dispatchId);
    const finalSession = finalDetail.workSessions.find((item) => item.sessionId === queuedSession.sessionId);
    const finalWorkItem = finalDetail.taskGroup.workItems.find((item) => item.id === workItemId);
    fixtureMetadata.successDispatchId = finalDispatch?.dispatchId;
    fixtureMetadata.successRuntimeNodeId = agentNodeId;
    if (finalDispatch?.status !== "completed") fail(`dispatch did not complete; status=${finalDispatch?.status}`);
    if (finalDispatch.assignedNodeId !== agentNodeId) fail(`dispatch assignedNodeId ${finalDispatch.assignedNodeId} did not match runtime node ${agentNodeId}`);
    if (finalSession?.agentId !== profileA.id) fail(`final session agentId drifted to ${finalSession?.agentId}; expected ${profileA.id}`);
    if (finalSession.agentId === finalDispatch.assignedNodeId) fail("logical profile id and runtime node id were conflated in final state");
    if (!["checkpoint_submitted", "code_complete", "review_requested", "review_passed", "verified", "closed"].includes(finalWorkItem?.status)) {
      fail(`work item did not advance after checkpoint; status=${finalWorkItem?.status}`);
    }
    const eventStream = await expectStatus(baseUrl, `/api/task-groups/${encodeURIComponent(taskGroupId)}/execution-events?limit=50`, {
      headers: {authorization: systemAuth}
    }, 200, "read execution events");
    const eventTypes = new Set((eventStream.events || []).map((event) => event.eventType));
    for (const required of ["dispatch_received", "executor_started", "git_pushed", "checkpoint_submitted"]) {
      if (!eventTypes.has(required)) fail(`missing execution event ${required}; saw ${[...eventTypes].join(",")}`);
    }
    const memberFinalDetail = await expectStatus(baseUrl, `/api/task-groups/${encodeURIComponent(taskGroupId)}`, {
      headers: {authorization: memberAuth}
    }, 200, "member reads final reviewer task group");
    if (!memberFinalDetail.agentDispatches?.some((item) => item.dispatchId === finalDispatch.dispatchId)) {
      fail("member reviewer could not see the completed dispatch for their task group");
    }
    const memberEvents = await expectStatus(baseUrl, `/api/task-groups/${encodeURIComponent(taskGroupId)}/execution-events?limit=50`, {
      headers: {authorization: memberAuth}
    }, 200, "member reads reviewer execution events");
    if (!(memberEvents.events || []).some((event) => event.eventType === "checkpoint_submitted")) {
      fail("member reviewer could not see checkpoint progress event");
    }
    const memberFinalState = await readState(baseUrl, memberAuth, "read member final state");
    assertMemberScopedVisibility(memberFinalState, {
      projectA,
      projectB,
      taskGroupId,
      profileA: profileA.id,
      profileB: profileB.id,
      memberA: memberA.accountId,
      orgBAdmin: orgB.adminAccountId,
      nodeB: nodeB.node.nodeId
    });
    const remoteHead = execFileSync("git", ["--git-dir", repo.remote, "rev-parse", "refs/heads/main"], {encoding: "utf8", timeout: 60000}).trim();
    if (!remoteHead || remoteHead === git(repo.work, ["rev-list", "--max-parents=0", "HEAD"])) {
      fail("remote repository head did not move after deterministic runtime completion");
    }

    logOk(`dispatch ${finalDispatch.dispatchId} claimed by runtime node ${agentNodeId} and completed with checkpoint ${finalSession.checkpointRef || finalDispatch.runId}`);
    logOk(`progress/result observed: work item ${workItemId} status=${finalWorkItem.status}, events=${[...eventTypes].sort().join(",")}`);

    const failureWorkItemId = await createWorkItem(baseUrl, orgA.auth, "a-git-auth-failure", taskGroupId);
    fixtureMetadata.gitAuthFailureWorkItemId = failureWorkItemId;
    const failureQueued = await queueSingleDispatch(baseUrl, orgA.auth, taskGroupId, failureWorkItemId, "git-auth-failure");
    fixtureMetadata.gitAuthFailureDispatchId = failureQueued.dispatchId;
    const hookPath = installAuthenticationFailureHook(repo.remote);
    fixtureMetadata.gitAuthFailureHook = hookPath;
    const failureRun = await runFailureRuntimeAndApprovePermission(baseUrl, orgA.auth, failureQueued.dispatchId);
    fixtureMetadata.gitAuthFailurePermissionRequestId = failureRun.permissionRequestId;
    const failedResult = await assertGitAuthFailureArrived(baseUrl, systemAuth, taskGroupId, failureWorkItemId, failureQueued.dispatchId);
    logOk(`git auth failure dispatch ${failedResult.dispatch.dispatchId} persisted failureReason=${failedResult.dispatch.failureReason.split(":")[0]}`);

    logOk(`member login can read reviewed task group progress while foreign org project/profile/node/account stay excluded`);
    console.log("tested hops: REST org/member/profile/project/task-group/work-item creation; member project-viewer grant by route accountId including spoofed subjectId rejection-by-overwrite; task-group reviewer grant/login visibility; orchestrator queue; org B cross-org profile/node exclusion; real agent-runtime bootstrap/self-check/claim/events/git push/checkpoint; rejected pre-receive push classified and persisted as git_auth_failed with failed event.");
    console.log("untested hops: UI/browser selection widgets; paid provider model invocation; org-scoped runtime-node scheduling beyond project-bound join-token membership.");
    succeeded = true;
  } catch (error) {
    console.error(serverOutput.trim().split("\n").slice(-20).join("\n"));
    throw error;
  } finally {
    await stopServer(serverChild);
    if (succeeded && baseDir) {
      if (keepRuntime) {
        printFixtureMetadata({
          ...fixtureMetadata,
          serverStopped: true,
          restartCommand: `AIMAC_HOST=127.0.0.1 AIMAC_PORT=${fixtureMetadata.port} AIMAC_PUBLIC_URL=${fixtureMetadata.baseUrl} AIMAC_RUNTIME_DIR=${runtimeDir} AIMAC_REPOSITORY_ROOT=${join(baseDir, "git", "work")} AIMAC_BOOTSTRAP_TOKEN=${bootstrapToken} AIMAC_EXECUTION_PROFILE=verification AIMAC_ORCHESTRATOR_INTERVAL_MS=0 AIMAC_ALLOW_LOCAL_GIT_REMOTE=true AIMAC_STATE_STORE=runtime_json node apps/control-plane-ui/server.mjs`
        });
        console.log(`ok: --keep-runtime enabled; preserved temp runtime ${baseDir}`);
      } else {
        rmSync(baseDir, {recursive: true, force: true});
        console.log(`ok: removed successful temp runtime ${baseDir}`);
      }
    } else if (baseDir) {
      console.error(`runtime kept for failure evidence: ${baseDir}`);
    }
  }
}

main().catch((error) => {
  console.error(`org-agent-dispatch-check failed: ${error.message}`);
  process.exit(1);
});
