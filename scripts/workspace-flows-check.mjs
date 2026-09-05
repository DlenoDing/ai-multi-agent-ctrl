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
  console.log("workspace flows check passed");
} catch (error) {
  console.error(`workspace flows check failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (server.exitCode === null) server.kill("SIGTERM");
  const killTimer = setTimeout(() => server.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(killTimer);
  rmSync(runtimeDir, {recursive: true, force: true});
}
