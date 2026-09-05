#!/usr/bin/env node
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { argv } from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowedFlags = new Set(["--help", "-h", "--keep-runtime"]);
const unknownFlags = argv.slice(2).filter((arg) => arg.startsWith("-") && !allowedFlags.has(arg));
if (unknownFlags.length) {
  console.error(`unknown option(s): ${unknownFlags.join(", ")}`);
  console.error("usage: node scripts/org-node-scope-check.mjs [--keep-runtime]");
  process.exit(2);
}
if (argv.includes("--help") || argv.includes("-h")) {
  console.log([
    "usage: node scripts/org-node-scope-check.mjs [--keep-runtime]",
    "",
    "Runs an isolated organization-scoped runtime node verification:",
    "- organization-scoped join token and node registration before projects exist",
    "- dynamic same-organization active project eligibility after future project creation",
    "- real agent-runtime claim/completion for two own projects",
    "- foreign organization dispatch exclusion",
    "- project-admin denial for org token signing and shared-node control",
    "- bare direct project permissions cannot grant/control through task-group scope",
    "",
    "Options:",
    "  --keep-runtime   Preserve the temp runtime fixture.",
    "  --help, -h       Show this help."
  ].join("\n"));
  process.exit(0);
}
const bootstrapToken = "org-node-scope-bootstrap-token";
const roleUnderTest = "ui-console-service";
let serverChild = null;
let baseDir = null;
let runtimeDir = null;
let agentWorkDir = null;

function fail(message) {
  throw new Error(message);
}

function logOk(message) {
  console.log(`ok: ${message}`);
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
    fail(`${label}: expected HTTP ${status}, got ${result.response.status} ${JSON.stringify(result.payload).slice(0, 500)}`);
  }
  return result.payload;
}

async function callMcpTool(baseUrl, token, name, args = {}, label = name) {
  const payload = await expectStatus(baseUrl, "/mcp", {
    method: "POST",
    headers: {authorization: `Bearer ${token}`, accept: "application/json, text/event-stream"},
    body: JSON.stringify({jsonrpc: "2.0", id: `${Date.now()}:${Math.random()}`, method: "tools/call", params: {name, arguments: args}})
  }, 200, `MCP ${label}`);
  if (payload.error) fail(`MCP ${label} returned JSON-RPC error: ${JSON.stringify(payload.error).slice(0, 500)}`);
  return payload.result?.structuredContent || {};
}

async function expectMcpError(baseUrl, token, name, args, expectedError, label) {
  const result = await callMcpTool(baseUrl, token, name, args, label);
  const error = result.result?.error || result.error;
  if (error !== expectedError) {
    fail(`MCP ${label} expected ${expectedError}, got ${JSON.stringify(result).slice(0, 500)}`);
  }
  return result;
}

async function login(baseUrl, email, token) {
  const payload = await expectStatus(baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({email, token})
  }, 200, `login ${email}`);
  if (!payload.sessionToken) fail(`login ${email}: no session token`);
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
  git(work, ["config", "user.email", "org-node-scope-check@local"]);
  git(work, ["config", "user.name", "Org Node Scope Check"]);
  writeFileSync(join(work, "README.md"), "# Org Node Scope Check\n");
  writeFileSync(join(work, ".aimac-verification-repository"), "verification\n");
  git(work, ["add", "README.md", ".aimac-verification-repository"]);
  git(work, ["commit", "-m", "Initialize org node scope check repository"]);
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
const outputPath = \`docs/org-node-scope-check/\${input.projectId}/\${input.workId}.md\`;
mkdirSync(join(input.repositoryRoot, dirname(outputPath)), {recursive: true});
writeFileSync(join(input.repositoryRoot, outputPath), [
  \`# \${input.workId}\`,
  "",
  \`Dispatch: \${input.dispatchId}\`,
  \`Project: \${input.projectId}\`,
  \`TaskGroup: \${input.taskGroupId}\`,
  ""
].join("\\n"));
console.log(JSON.stringify({
  summary: "Deterministic executor completed org node scope check.",
  verificationRefs: ["executor:deterministic"],
  evidenceRefs: ["executor:deterministic"],
  changedPaths: [outputPath],
  commitMessage: \`Org node scope check output for \${input.workId}\`
}));
`);
  return executorPath;
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
      AIMAC_MCP_ALLOW_FULL_STATE: "true",
      AIMAC_STATE_STORE: "runtime_json",
      AIMAC_EXIT_WITH_PARENT: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  serverChild = child;
  return child;
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
  const email = `${key}@org-node-scope-check.local`;
  const payload = await expectStatus(baseUrl, "/api/orgs", {
    method: "POST",
    headers: {authorization: systemAuth, "Idempotency-Key": `org-node-scope-check-org-${key}`},
    body: JSON.stringify({
      name,
      admin: {email, displayName: `${name} Admin`},
      quotas: {maxProjects: 5, maxTaskGroups: 20, maxAgents: 8, maxMembers: 8}
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

async function createOrgMember(baseUrl, auth, key, defaultProjectId, options = {}) {
  const email = `${key}@org-node-scope-check.local`;
  const payload = await expectStatus(baseUrl, "/api/org/members", {
    method: "POST",
    headers: {authorization: auth, "Idempotency-Key": `org-node-scope-check-member-${key}`},
    body: JSON.stringify({
      email,
      displayName: `Org Node Scope ${key} Member`,
      roles: ["member"],
      permissions: options.permissions || ["project:view"],
      defaultProjectId
    })
  }, 201, `invite org member ${key}`);
  return {accountId: payload.account.accountId, email, accountToken: payload.accountToken};
}

async function grantProjectAdmin(baseUrl, auth, key, projectId, accountId) {
  return await expectStatus(baseUrl, "/api/access-grants", {
    method: "POST",
    headers: {authorization: auth, "Idempotency-Key": `org-node-scope-check-project-admin-${key}`},
    body: JSON.stringify({
      subjectId: accountId,
      resourceType: "project",
      resourceId: projectId,
      role: "project_admin"
    })
  }, 201, `grant project admin ${key}`);
}

async function grantProjectViewer(baseUrl, auth, key, projectId, accountId) {
  return await expectStatus(baseUrl, "/api/access-grants", {
    method: "POST",
    headers: {authorization: auth, "Idempotency-Key": `org-node-scope-check-project-viewer-${key}`},
    body: JSON.stringify({
      subjectId: accountId,
      resourceType: "project",
      resourceId: projectId,
      role: "viewer"
    })
  }, 201, `grant project viewer ${key}`);
}

async function grantTaskGroupViewer(baseUrl, auth, key, taskGroupId, accountId) {
  return await expectStatus(baseUrl, "/api/access-grants", {
    method: "POST",
    headers: {authorization: auth, "Idempotency-Key": `org-node-scope-check-task-viewer-${key}`},
    body: JSON.stringify({
      subjectId: accountId,
      resourceType: "task_group",
      resourceId: taskGroupId,
      role: "viewer"
    })
  }, 201, `grant task group viewer ${key}`);
}

async function createProject(baseUrl, auth, key, remote) {
  const payload = await expectStatus(baseUrl, "/api/org/projects", {
    method: "POST",
    headers: {authorization: auth, "Idempotency-Key": `org-node-scope-check-project-${key}`},
    body: JSON.stringify({
      name: `Org node scope project ${key}`,
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
    headers: {authorization: auth, "Idempotency-Key": `org-node-scope-check-agent-${key}`},
    body: JSON.stringify({
      name: `Org ${key.toUpperCase()} scope profile`,
      role: roleUnderTest,
      model: "custom:deterministic",
      trustScore: 0.91
    })
  }, 201, `create org ${key} agent profile`);
}

async function createTaskGroupAndWork(baseUrl, auth, key, projectId) {
  const group = await expectStatus(baseUrl, "/api/task-groups", {
    method: "POST",
    headers: {authorization: auth, "Idempotency-Key": `org-node-scope-check-tg-${key}`},
    body: JSON.stringify({
      projectId,
      name: `Org ${key.toUpperCase()} runtime node scope`,
      objective: "Exercise organization scoped runtime node project eligibility.",
      languageTag: "en",
      roles: [roleUnderTest]
    })
  }, 201, `create task group ${key}`);
  const work = await expectStatus(baseUrl, `/api/task-groups/${encodeURIComponent(group.taskGroup.id)}/work-items`, {
    method: "POST",
    headers: {authorization: auth, "Idempotency-Key": `org-node-scope-check-work-${key}`},
    body: JSON.stringify({
      title: `Org ${key.toUpperCase()} deterministic artifact`,
      ownerRole: roleUnderTest,
      requirements: ["Produce one repository artifact through the agent runtime transport."]
    })
  }, 201, `create work item ${key}`);
  return {taskGroupId: group.taskGroup.id, workItemId: work.workItem.id};
}

async function queueSingleDispatch(baseUrl, auth, taskGroupId, workItemId, key) {
  const run = await expectStatus(baseUrl, "/api/orchestrator/run", {
    method: "POST",
    headers: {authorization: auth, "Idempotency-Key": `org-node-scope-check-orchestrator-${key}`},
    body: JSON.stringify({mode: "single", taskGroupId, autoSyncSkills: false})
  }, 200, `orchestrator dispatch ${key}`);
  const queuedChange = (run.changed || []).find((item) => item.taskGroupId === taskGroupId && item.workItemId === workItemId && item.dispatchId);
  if (!queuedChange) fail(`orchestrator did not queue ${key} work: ${JSON.stringify(run.changed || []).slice(0, 500)}`);
  return queuedChange;
}

async function readTaskGroup(baseUrl, auth, taskGroupId, label) {
  return await expectStatus(baseUrl, `/api/task-groups/${encodeURIComponent(taskGroupId)}`, {
    headers: {authorization: auth},
    timeoutMs: 20000
  }, 200, label);
}

async function assertDispatchCompleted(baseUrl, auth, taskGroupId, dispatchId, nodeId, label) {
  const detail = await readTaskGroup(baseUrl, auth, taskGroupId, `read ${label} task group`);
  const dispatch = detail.agentDispatches.find((item) => item.dispatchId === dispatchId);
  if (dispatch?.status !== "completed") fail(`${label}: dispatch status=${dispatch?.status}; expected completed`);
  if (dispatch.assignedNodeId !== nodeId) fail(`${label}: assignedNodeId=${dispatch.assignedNodeId}; expected ${nodeId}`);
}

async function readProjectExecutionEvents(baseUrl, auth, projectId, label) {
  return await expectStatus(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/execution-events?limit=500`, {
    headers: {authorization: auth},
    timeoutMs: 20000
  }, 200, label);
}

async function readBaseState(baseUrl, auth, label) {
  return await expectStatus(baseUrl, "/api/state?view=projects&limit=200", {
    headers: {authorization: auth},
    timeoutMs: 20000
  }, 200, label);
}

async function expectCanCreateProject(baseUrl, auth, expected, label) {
  const state = await readBaseState(baseUrl, auth, label);
  const actual = state.accountCapabilities?.canCreateProject;
  if (actual !== expected) fail(`${label}: canCreateProject=${actual}; expected ${expected}`);
  return state;
}

async function updateOrgMemberPermissions(baseUrl, auth, accountId, permissions, key) {
  return await expectStatus(baseUrl, `/api/org/members/${encodeURIComponent(accountId)}/permissions`, {
    method: "POST",
    headers: {authorization: auth, "Idempotency-Key": `org-node-scope-check-member-permissions-${key}`},
    body: JSON.stringify({permissions})
  }, 200, `update member permissions ${key}`);
}

async function readOrgMember(baseUrl, auth, accountId, label) {
  const members = await expectStatus(baseUrl, "/api/org/members", {
    headers: {authorization: auth},
    timeoutMs: 20000
  }, 200, label);
  const member = (members.members || []).find((item) => item.accountId === accountId);
  if (!member) fail(`${label}: member ${accountId} not found`);
  return member;
}

async function createAccountProject(baseUrl, auth, name, key, expectedStatus = 201) {
  return await expectStatus(baseUrl, "/api/projects", {
    method: "POST",
    headers: {authorization: auth, "Idempotency-Key": `org-node-scope-check-account-project-${key}`},
    body: JSON.stringify({name})
  }, expectedStatus, `account project create ${key}`);
}

async function main() {
  // 新邀请会剥掉通配权限；旧数据中的裸通配权限另用真实判权函数验证，不把剥掉后的账号冒充旧账号。
  const serverSource = readFileSync(join(root, "apps/control-plane-ui/server.mjs"), "utf8");
  const directSource = serverSource.match(/^function directPermissionApplies\([\s\S]*?^\}/mu)?.[0];
  const systemSource = serverSource.match(/^function isSystemAccount\([\s\S]*?^\}/mu)?.[0];
  if (!directSource || !systemSource) fail("could not extract actual direct permission predicates");
  const directPermissionApplies = runInNewContext(`${systemSource}\n(${directSource})`);
  for (const resourceType of ["project", "task_group"]) {
    for (const permission of ["project:*", "project:grant"]) {
      if (directPermissionApplies({accountType: "user_account", permissions: [permission]}, permission, "project:grant", {resourceType, resourceId: "scope-test"})) {
        fail(`legacy direct ${permission} unexpectedly authorizes ${resourceType} grant`);
      }
    }
  }
  if (!directPermissionApplies({accountType: "org_admin"}, "project:*", "project:grant", {resourceType: "task_group", resourceId: "scope-test"})) fail("org admin project permission regression");
  logOk("actual permission predicate rejects legacy bare project wildcards; org admin branch remains available");
  mkdirSync(join(root, ".runtime"), {recursive: true});
  baseDir = mkdtempSync(join(root, ".runtime", "org-node-scope-check-"));
  runtimeDir = join(baseDir, "control-plane-runtime");
  agentWorkDir = join(baseDir, "agent-runtime");
  const repo = setupRepository();
  const executorPath = setupExecutor();
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = startServer(port, repo.work);
  let serverOutput = "";
  child.stdout.on("data", (chunk) => { serverOutput += chunk; });
  child.stderr.on("data", (chunk) => { serverOutput += chunk; });
  let succeeded = false;

  try {
    await waitForHealth(baseUrl);
    const systemAuth = await login(baseUrl, "system.admin@local", bootstrapToken);
    const orgA = await createOrg(baseUrl, systemAuth, "a", "Org Node Scope A");
    const orgB = await createOrg(baseUrl, systemAuth, "b", "Org Node Scope B");
    logOk(`created org ${orgA.orgId} with no projects before node registration`);

    const orgJoin = await expectStatus(baseUrl, "/api/agent-join-tokens", {
      method: "POST",
      headers: {authorization: orgA.auth, "Idempotency-Key": "org-node-scope-check-org-join"},
      body: JSON.stringify({registrationScope: "organization", organizationId: orgA.orgId, allowedRoles: [roleUnderTest, "orchestrator"], ttlSeconds: 900})
    }, 201, "create organization scoped join token");
    if (orgJoin.joinTokenRecord.registrationScope !== "organization") fail("organization join token did not expose registrationScope=organization");
    if (orgJoin.joinTokenRecord.projectId !== null) fail(`organization join token projectId=${orgJoin.joinTokenRecord.projectId}; expected null`);

    const bootstrap = runAgentRuntime([
      "bootstrap",
      "--server", baseUrl,
      "--join-token", orgJoin.joinToken,
      "--node-name", "org-a-shared-runtime",
      "--roles", roleUnderTest,
      "--work-dir", agentWorkDir,
      "--executor-command", `node ${JSON.stringify(executorPath)}`
    ], {AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true"});
    const nodeId = bootstrap.stdout.match(/nodeId=([^\s]+)/u)?.[1];
    if (!nodeId) fail(`could not parse nodeId from bootstrap output:\n${bootstrap.stdout}`);
    const nodeToken = JSON.parse(readFileSync(join(agentWorkDir, "agent-config.json"), "utf8")).nodeToken;
    await expectMcpError(baseUrl, nodeToken, "orchestration-mcp.state_get", {scope: "full"}, "mcp_dispatch_bound_grant_required", "state_get before projects");
    await expectMcpError(baseUrl, nodeToken, "scheduler-mcp.capacity_snapshot", {}, "mcp_dispatch_bound_grant_required", "capacity_snapshot before projects");
    logOk("MCP state_get/capacity_snapshot did not fall open while org node had no eligible projects or dispatch grant");
    const nodeBeforeProjects = await expectStatus(baseUrl, "/api/agent/v1/nodes/me", {
      headers: {authorization: `Bearer ${orgJoin.joinToken}`},
      timeoutMs: 2000
    }, 401, "join token cannot authenticate node endpoint").catch((error) => {
      if (!String(error.message).includes("expected HTTP 401")) throw error;
    });
    void nodeBeforeProjects;
    const nodeStateBefore = await expectStatus(baseUrl, "/api/agent-nodes", {
      headers: {authorization: orgA.auth}
    }, 200, "list nodes before projects");
    const sharedNodeBefore = nodeStateBefore.agentRuntimeNodes.find((node) => node.nodeId === nodeId);
    if (!sharedNodeBefore || sharedNodeBefore.registrationScope !== "organization") fail("registered node was not organization scoped");
    if ((sharedNodeBefore.effectiveProjectIds || []).length !== 0) fail("org node registered before projects had non-empty effective project set");
    logOk(`registered org-scoped runtime node ${nodeId} while org had no active projects`);

    const projectA1 = await createProject(baseUrl, orgA.auth, "a1", repo.remote);
    const projectA2 = await createProject(baseUrl, orgA.auth, "a2", repo.remote);
    const projectB = await createProject(baseUrl, orgB.auth, "b1", repo.remote);
    await createAgentProfile(baseUrl, orgA.auth, "a");
    await createAgentProfile(baseUrl, orgB.auth, "b");
    const member = await createOrgMember(baseUrl, orgA.auth, "project-admin", projectA1);
    await grantProjectAdmin(baseUrl, orgA.auth, "project-admin", projectA1, member.accountId);
    const memberAuth = await login(baseUrl, member.email, member.accountToken);
    const directAgentMember = await createOrgMember(baseUrl, orgA.auth, "direct-agent-activate", projectA1, {permissions: ["agent:activate"]});
    const directAgentAuth = await login(baseUrl, directAgentMember.email, directAgentMember.accountToken);
    const directProjectGrantMember = await createOrgMember(baseUrl, orgA.auth, "direct-project-grant", projectA1, {permissions: ["project:grant"]});
    if (!(await readOrgMember(baseUrl, orgA.auth, directProjectGrantMember.accountId, "verify bare project:grant fixture")).permissions?.includes("project:grant")) {
      fail("bare project:grant negative fixture lost its direct permission");
    }
    const directProjectGrantAuth = await login(baseUrl, directProjectGrantMember.email, directProjectGrantMember.accountToken);
    const directProjectStarMember = await createOrgMember(baseUrl, orgA.auth, "direct-project-star", projectA1, {permissions: ["project:*"]});
    const directProjectStarAuth = await login(baseUrl, directProjectStarMember.email, directProjectStarMember.accountToken);
    const directProjectCreateMember = await createOrgMember(baseUrl, orgA.auth, "direct-project-create", projectA1, {permissions: []});
    const directProjectCreateAuth = await login(baseUrl, directProjectCreateMember.email, directProjectCreateMember.accountToken);
    const observer = await createOrgMember(baseUrl, orgA.auth, "project-event-observer", projectA2, {permissions: []});
    await expectCanCreateProject(baseUrl, directProjectCreateAuth, false, "direct project:create member before permission grant");
    await createAccountProject(baseUrl, directProjectCreateAuth, "direct create denied before permission", "direct-create-before-permission", 403);
    const unknownPermission = await expectStatus(baseUrl, `/api/org/members/${encodeURIComponent(directProjectCreateMember.accountId)}/permissions`, {
      method: "POST",
      headers: {authorization: orgA.auth, "Idempotency-Key": "org-node-scope-check-member-permissions-unknown"},
      body: JSON.stringify({permissions: ["project:not_real"]})
    }, 400, "unknown org member permission rejected");
    if (unknownPermission.error !== "permission_unknown") fail(`unknown org member permission returned ${unknownPermission.error}`);
    await updateOrgMemberPermissions(baseUrl, orgA.auth, directProjectCreateMember.accountId, ["project:create"], "grant-project-create");
    const createMemberAfterGrant = await readOrgMember(baseUrl, orgA.auth, directProjectCreateMember.accountId, "read project:create member after grant");
    if (!((createMemberAfterGrant.permissions || []).includes("project:create"))) {
      fail(`project:create member readback missing permission: ${JSON.stringify(createMemberAfterGrant.permissions || [])}`);
    }
    const createState = await expectCanCreateProject(baseUrl, directProjectCreateAuth, true, "direct project:create member after permission grant");
    const createdByAccount = await createAccountProject(baseUrl, directProjectCreateAuth, "Direct project:create owned project", "direct-create-after-permission", 201);
    const ownerGrantSubject = createdByAccount.ownerGrant?.subjectRef?.subjectId || createdByAccount.ownerGrant?.subjectId;
    if (ownerGrantSubject !== directProjectCreateMember.accountId) {
      fail(`project:create ownerGrant subject=${ownerGrantSubject}; expected ${directProjectCreateMember.accountId}`);
    }
    const createdProject = (await readBaseState(baseUrl, directProjectCreateAuth, "read created account project")).projects
      ?.find((project) => project.id === createdByAccount.id);
    if (!createdProject || createdProject.organizationId !== orgA.orgId || createdProject.ownerAccountId !== directProjectCreateMember.accountId) {
      fail(`project:create project ownership/org wrong: ${JSON.stringify(createdProject || createdByAccount).slice(0, 500)}`);
    }
    if (!createState.accountCapabilities?.canCreateProject) fail("project:create capability unexpectedly false before create");
    await updateOrgMemberPermissions(baseUrl, orgA.auth, directProjectCreateMember.accountId, [], "clear-project-create");
    const createMemberAfterClear = await readOrgMember(baseUrl, orgA.auth, directProjectCreateMember.accountId, "read project:create member after clear");
    if ((createMemberAfterClear.permissions || []).length !== 0) {
      fail(`explicit empty member permissions did not clear permissions: ${JSON.stringify(createMemberAfterClear.permissions || [])}`);
    }
    await expectCanCreateProject(baseUrl, directProjectCreateAuth, false, "direct project:create member after permission clear");
    await createAccountProject(baseUrl, directProjectCreateAuth, "direct create denied after clear", "direct-create-after-clear", 403);
    const projectStarMember = await readOrgMember(baseUrl, orgA.auth, directProjectStarMember.accountId, "read project:* member after wildcard request");
    if ((projectStarMember.permissions || []).includes("project:*") || (projectStarMember.permissions || []).includes("project:create")) {
      fail(`project:* member retained create-capable permission: ${JSON.stringify(projectStarMember.permissions || [])}`);
    }
    await expectCanCreateProject(baseUrl, directProjectStarAuth, false, "direct project:* member capability");
    await createAccountProject(baseUrl, directProjectStarAuth, "direct wildcard create denied", "direct-star-create", 403);
    logOk("direct project:create member capability, project creation ownership, explicit permission clear, and project:* negative were verified");
    const nodeStateAfter = await expectStatus(baseUrl, "/api/agent-nodes", {
      headers: {authorization: orgA.auth}
    }, 200, "list nodes after projects");
    const sharedNodeAfter = nodeStateAfter.agentRuntimeNodes.find((node) => node.nodeId === nodeId);
    const effective = new Set(sharedNodeAfter?.effectiveProjectIds || []);
    if (!effective.has(projectA1) || !effective.has(projectA2) || effective.has(projectB)) {
      fail(`org node effectiveProjectIds=${JSON.stringify([...effective])}; expected own active projects only`);
    }
    logOk(`org node dynamically covers own active projects ${projectA1}, ${projectA2} and excludes ${projectB}`);

    const workA1 = await createTaskGroupAndWork(baseUrl, orgA.auth, "a1", projectA1);
    const workA2 = await createTaskGroupAndWork(baseUrl, orgA.auth, "a2", projectA2);
    const workA2Hidden = await createTaskGroupAndWork(baseUrl, orgA.auth, "a2-hidden", projectA2);
    const workB = await createTaskGroupAndWork(baseUrl, orgB.auth, "b1", projectB);
    const queuedA1 = await queueSingleDispatch(baseUrl, orgA.auth, workA1.taskGroupId, workA1.workItemId, "a1");
    const queuedA2 = await queueSingleDispatch(baseUrl, orgA.auth, workA2.taskGroupId, workA2.workItemId, "a2");
    const queuedA2Hidden = await queueSingleDispatch(baseUrl, orgA.auth, workA2Hidden.taskGroupId, workA2Hidden.workItemId, "a2-hidden");
    const queuedB = await queueSingleDispatch(baseUrl, orgB.auth, workB.taskGroupId, workB.workItemId, "b1");

    for (const key of ["a1", "a2", "a2-hidden"]) {
      const result = runAgentRuntime([
        "run",
        "--once",
        "--work-dir", agentWorkDir,
        "--claim-ttl", "180"
      ], {
        AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true",
        AIMAC_AGENT_REQUEST_TIMEOUT_MS: "20000",
        AIMAC_AGENT_SWEEP_INTERVAL_MS: "600000"
      });
      if (!result.stdout.includes("dispatch completed:")) {
        fail(`agent runtime did not complete ${key} dispatch:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      }
    }
    await assertDispatchCompleted(baseUrl, orgA.auth, workA1.taskGroupId, queuedA1.dispatchId, nodeId, "project A1");
    await assertDispatchCompleted(baseUrl, orgA.auth, workA2.taskGroupId, queuedA2.dispatchId, nodeId, "project A2");
    await assertDispatchCompleted(baseUrl, orgA.auth, workA2Hidden.taskGroupId, queuedA2Hidden.dispatchId, nodeId, "project A2 hidden");

    await grantProjectViewer(baseUrl, orgA.auth, "project-event-observer", projectA2, observer.accountId);
    await grantTaskGroupViewer(baseUrl, orgA.auth, "project-event-observer-visible", workA2.taskGroupId, observer.accountId);
    await grantTaskGroupViewer(baseUrl, orgA.auth, "direct-project-grant-visible", workA2.taskGroupId, directProjectGrantMember.accountId);
    await grantTaskGroupViewer(baseUrl, orgA.auth, "direct-project-star-visible", workA2.taskGroupId, directProjectStarMember.accountId);
    const observerAuth = await login(baseUrl, observer.email, observer.accountToken);
    const projectEventsA2 = await readProjectExecutionEvents(baseUrl, orgA.auth, projectA2, "org admin reads project A2 execution events");
    if (!(projectEventsA2.events || []).length) fail("project A2 execution-events endpoint returned no events after real runtime execution");
    if ((projectEventsA2.events || []).some((event) => event.projectId !== projectA2)) {
      fail(`project A2 execution-events leaked another project: ${JSON.stringify(projectEventsA2.events).slice(0, 500)}`);
    }
    const adminEventDispatches = new Set((projectEventsA2.events || []).map((event) => event.dispatchId));
    if (!adminEventDispatches.has(queuedA2.dispatchId) || !adminEventDispatches.has(queuedA2Hidden.dispatchId)) {
      fail(`project A2 execution-events missing visible or hidden same-project runtime events: ${JSON.stringify([...adminEventDispatches])}`);
    }
    const observerEventsA2 = await readProjectExecutionEvents(baseUrl, observerAuth, projectA2, "observer reads project A2 execution events");
    if (!(observerEventsA2.events || []).length) fail("observer project execution-events read returned empty instead of granted task-group events");
    if ((observerEventsA2.events || []).some((event) => event.projectId !== projectA2)) {
      fail(`observer project execution-events leaked another project: ${JSON.stringify(observerEventsA2.events).slice(0, 500)}`);
    }
    if ((observerEventsA2.events || []).some((event) => event.taskGroupId !== workA2.taskGroupId)) {
      fail(`observer project execution-events leaked hidden task-group events: ${JSON.stringify(observerEventsA2.events).slice(0, 500)}`);
    }
    const observerDispatches = new Set((observerEventsA2.events || []).map((event) => event.dispatchId));
    if (!observerDispatches.has(queuedA2.dispatchId) || observerDispatches.has(queuedA2Hidden.dispatchId)) {
      fail(`observer project execution-events dispatch visibility wrong: ${JSON.stringify([...observerDispatches])}`);
    }
    logOk("project execution-events endpoint returned real nonempty project events and filtered hidden task-group events for observer");

    const extraA2 = await createTaskGroupAndWork(baseUrl, orgA.auth, "a2-extra", projectA2);
    const queuedA2Extra = await queueSingleDispatch(baseUrl, orgA.auth, extraA2.taskGroupId, extraA2.workItemId, "a2-extra");
    const claimedA2Extra = await expectStatus(baseUrl, "/api/agent/v1/dispatches/next", {
      method: "POST",
      headers: {authorization: `Bearer ${nodeToken}`},
      body: JSON.stringify({claimTtlSeconds: 180})
    }, 200, "claim extra project A2 dispatch");
    if (claimedA2Extra.dispatch?.dispatch?.dispatchId !== queuedA2Extra.dispatchId) {
      fail(`extra A2 claim got ${claimedA2Extra.dispatch?.dispatch?.dispatchId}; expected ${queuedA2Extra.dispatchId}`);
    }
    const mcpState = await callMcpTool(baseUrl, nodeToken, "orchestration-mcp.state_get", {scope: "full"}, "state_get after dynamic projects");
    const scopedState = mcpState.result?.state || mcpState.state || {};
    const mcpNode = (scopedState.agentRuntimeNodes || []).find((node) => node.nodeId === nodeId);
    if (!mcpNode) fail("MCP scoped state did not include the eligible org-scoped runtime node");
    const mcpEffective = new Set(mcpNode.effectiveProjectIds || []);
    if (!mcpEffective.has(projectA1) || !mcpEffective.has(projectA2) || mcpEffective.has(projectB)) {
      fail(`MCP scoped node effectiveProjectIds=${JSON.stringify([...mcpEffective])}; expected own active projects only`);
    }
    if ((scopedState.projects || []).some((project) => project.id === projectB)) fail("MCP scoped state leaked foreign project");
    if (mcpNode.profile?.dataRoot || mcpNode.profile?.permission || mcpNode.profile?.integrity) {
      fail("MCP scoped node projection leaked full profile metadata");
    }
    const mcpCapacity = await callMcpTool(baseUrl, nodeToken, "scheduler-mcp.capacity_snapshot", {}, "capacity_snapshot after dynamic projects");
    const capacityResult = mcpCapacity.result || mcpCapacity;
    if (capacityResult.nodeCount !== 1) fail(`MCP capacity nodeCount=${capacityResult.nodeCount}; expected 1 dynamic org node`);
    logOk("MCP state_get/capacity_snapshot use dynamic org-node project scope after future projects exist");
    const projectAdminOrgAgents = await expectStatus(baseUrl, "/api/org/agents", {
      headers: {authorization: memberAuth}
    }, 200, "project admin reads org agents");
    const projectAdminNode = projectAdminOrgAgents.agentRuntimeNodes.find((node) => node.nodeId === nodeId);
    if (!projectAdminNode) fail("project admin could not see shared node eligible for their project");
    const projectAdminEffective = new Set(projectAdminNode.effectiveProjectIds || []);
    if (!projectAdminEffective.has(projectA1) || projectAdminEffective.has(projectA2) || projectAdminEffective.has(projectB)) {
      fail(`project admin effectiveProjectIds=${JSON.stringify([...projectAdminEffective])}; expected only ${projectA1}`);
    }
    if ((projectAdminNode.activeDispatchIds || []).includes(queuedA2Extra.dispatchId)) {
      fail("project admin node projection leaked active dispatch id from another project");
    }
    if ((projectAdminNode.display?.currentDispatchIds || []).includes(queuedA2Extra.dispatchId)) {
      fail("project admin org agent display leaked active dispatch id from another project");
    }
    if (projectAdminNode.profile?.dataRoot || projectAdminNode.profile?.permission || projectAdminNode.profile?.integrity) {
      fail("project admin node projection leaked full profile metadata");
    }
    logOk("project admin sees eligible shared node with project-filtered effectiveProjectIds, activeDispatchIds, display ids, and profile metadata");

    const foreignClaim = await expectStatus(baseUrl, "/api/agent/v1/dispatches/next", {
      method: "POST",
      headers: {authorization: `Bearer ${nodeToken}`},
      body: JSON.stringify({claimTtlSeconds: 120})
    }, 200, "same node claim after own projects complete");
    if (foreignClaim.dispatch) fail(`org A shared node claimed foreign dispatch ${foreignClaim.dispatch.dispatch?.dispatchId || foreignClaim.dispatch.dispatchId}`);
    const foreignDetail = await readTaskGroup(baseUrl, orgB.auth, workB.taskGroupId, "read foreign task group");
    const foreignDispatch = foreignDetail.agentDispatches.find((item) => item.dispatchId === queuedB.dispatchId);
    if (foreignDispatch?.status !== "queued") fail(`foreign dispatch status=${foreignDispatch?.status}; expected queued`);
    logOk(`foreign org dispatch ${queuedB.dispatchId} remained queued and unclaimed by ${nodeId}`);

    await expectStatus(baseUrl, "/api/agent-join-tokens", {
      method: "POST",
      headers: {authorization: memberAuth, "Idempotency-Key": "org-node-scope-check-project-admin-org-join"},
      body: JSON.stringify({registrationScope: "organization", organizationId: orgA.orgId, allowedRoles: [roleUnderTest], ttlSeconds: 900})
    }, 403, "project admin cannot create org scoped token");
    await expectStatus(baseUrl, `/api/agent-nodes/${encodeURIComponent(nodeId)}/control`, {
      method: "POST",
      headers: {authorization: memberAuth, "Idempotency-Key": "org-node-scope-check-project-admin-node-control"},
      body: JSON.stringify({commandType: "refresh_profile"})
    }, 403, "project admin cannot control organization scoped node");
    await expectStatus(baseUrl, `/api/agent-nodes/${encodeURIComponent(nodeId)}/revoke`, {
      method: "POST",
      headers: {authorization: memberAuth, "Idempotency-Key": "org-node-scope-check-project-admin-node-revoke"},
      body: JSON.stringify({reason: "project_admin_must_not_revoke_org_node"})
    }, 403, "project admin cannot revoke organization scoped node");
    await expectStatus(baseUrl, "/api/agent-join-tokens", {
      method: "POST",
      headers: {authorization: directAgentAuth, "Idempotency-Key": "org-node-scope-check-direct-agent-org-join"},
      body: JSON.stringify({registrationScope: "organization", organizationId: orgA.orgId, allowedRoles: [roleUnderTest], ttlSeconds: 900})
    }, 403, "direct agent:activate member cannot create org scoped token");
    await expectStatus(baseUrl, `/api/agent-nodes/${encodeURIComponent(nodeId)}/control`, {
      method: "POST",
      headers: {authorization: directAgentAuth, "Idempotency-Key": "org-node-scope-check-direct-agent-node-control"},
      body: JSON.stringify({commandType: "refresh_profile"})
    }, 403, "direct agent:activate member cannot control organization scoped node");
    await expectStatus(baseUrl, `/api/agent-nodes/${encodeURIComponent(nodeId)}/revoke`, {
      method: "POST",
      headers: {authorization: directAgentAuth, "Idempotency-Key": "org-node-scope-check-direct-agent-node-revoke"},
      body: JSON.stringify({reason: "direct_permission_must_not_revoke_org_node"})
    }, 403, "direct agent:activate member cannot revoke organization scoped node");
    logOk("project admin and direct agent:activate member were denied org token signing and shared-node control/revoke");

    await expectStatus(baseUrl, "/api/access-grants", {
      method: "POST",
      headers: {authorization: directProjectGrantAuth, "Idempotency-Key": "org-node-scope-check-direct-project-grant-task-viewer"},
      body: JSON.stringify({
        subjectId: directAgentMember.accountId,
        resourceType: "task_group",
        resourceId: workA2.taskGroupId,
        role: "viewer"
      })
    }, 403, "direct project:grant plus task-group viewer cannot issue task-group grants");
    await expectStatus(baseUrl, "/api/access-grants", {
      method: "POST",
      headers: {authorization: directProjectStarAuth, "Idempotency-Key": "org-node-scope-check-direct-project-star-task-viewer"},
      body: JSON.stringify({
        subjectId: directAgentMember.accountId,
        resourceType: "task_group",
        resourceId: workA2.taskGroupId,
        role: "viewer"
      })
    }, 403, "sanitized wildcard request plus task-group viewer cannot issue task-group grants");
    await expectStatus(baseUrl, `/api/task-groups/${encodeURIComponent(workA2.taskGroupId)}/control`, {
      method: "POST",
      headers: {authorization: directProjectStarAuth, "Idempotency-Key": "org-node-scope-check-direct-project-star-task-control"},
      body: JSON.stringify({action: "pause"})
    }, 403, "sanitized wildcard request plus task-group viewer cannot control task group");
    logOk("bare direct project permissions did not grant/control through task-group scope");

    succeeded = true;
    console.log("tested hops: org token creation with registrationScope=organization; org node registration before any projects; empty org-node MCP state/capacity calls do not fall open; dynamic effectiveProjectIds after future project creation; direct project:create member capability/create/ownership and explicit permission clear; project:* member lacks create capability and cannot create via /api/projects; real agent-runtime claims/completes own-project dispatches through deterministic executor; project execution-events returns nonempty project-local runtime events and filters hidden task-group events; MCP state_get/capacity_snapshot use dynamic org-node scope; project-admin projection filters effectiveProjectIds/dispatch ids/profile metadata; foreign org dispatch remains queued; project admin and direct agent:activate member denied organization token signing and node-level control/revoke; bare direct project permissions plus task-group viewer grant cannot issue task-group grants or control task groups.");
  } finally {
    await stopServer(child);
    if (!succeeded) {
      console.error("server output:");
      console.error(serverOutput.slice(-6000));
    }
    if (!argv.includes("--keep-runtime") && baseDir) rmSync(baseDir, {recursive: true, force: true});
    else if (baseDir) {
      chmodSync(baseDir, 0o700);
      console.log(`kept runtime fixture: ${baseDir}`);
    }
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
