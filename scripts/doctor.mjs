import { spawn, spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import WebSocket from "ws";
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { readStoredState } from "../apps/control-plane-ui/lib/state-store.mjs";
import { sweepRecordsAgainstDeclaredSchemas } from "./lib/schema-validate.mjs";
import { assertNoUndefinedInPayload } from "./lib/no-undefined-payload.mjs";

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
  assertNoUndefinedInPayload(`${options.method || "GET"} ${path}`, options.body, options.allowUndefinedInPayload);
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

// 没点名拒绝码的 4xx 断言登记在这里：它们只验了"拒了"，没验"拒对了"。
// 同一个 409 可以是"已被处置"也可以是"幂等键撞了"，同一个 403 可以是越权也可以是组织被停 ——
// 守卫串位时状态码照样对得上。棘轮只降不升；下面会把实测到的码打出来，照抄进第四个参数即可。
const UNNAMED_REFUSALS = [];
const UNNAMED_REFUSAL_CEILING = 0;

// 第四个参数给了就连拒绝码一起对：只判状态码等于"拒了"，不等于"拒对了"——
// 同一个 409 可以是"已被处置"，也可以是"幂等键撞了"，两者对人的意思完全不同。
function expectStatus(result, status, label, expectedError) {
  if (expectedError === undefined && status >= 400) {
    UNNAMED_REFUSALS.push(`${label} → ${JSON.stringify(result.payload?.error)}`);
  }
  if (expectedError !== undefined && result.payload?.error !== expectedError) {
    throw new Error(`${label}: 状态码对上了（${result.response.status}），但拒绝码是 `
      + `${JSON.stringify(result.payload?.error)}，应为 ${expectedError} —— 拒了不等于拒对了`);
  }
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
// 本轮真实签发出去的一次性凭据。收尾时要证明它们【一个都没落盘】——
// 用真令牌搜，而不是搜一个泛化的形状：后者在文件里本来就搜不到，断言会安静地空转。
const issuedPlaintextSecrets = [];
const doctorRepo = setupDoctorRepository(root);

// npm start 起不来是运维最常撞到的失败时刻，而这一族此前全是裸 throw ——
// 一段 Node 崩溃栈加一个机器码，既不说规则是什么，也不说下一步。
// 这四条都在【监听之前】就失败，所以起停很快，值得真跑一遍读它说的话。
{
  const startupCases = [
    ["密钥太短", {AIMAC_BOOTSTRAP_TOKEN: "short-token"}, "至少 20 个字符"],
    ["对外监听没给公开地址", {AIMAC_HOST: "0.0.0.0", AIMAC_PUBLIC_URL: ""}, "必须给 AIMAC_PUBLIC_URL"],
    ["公开地址不是 URL", {AIMAC_PUBLIC_URL: "notaurl"}, "不是一个合法的 URL"],
    ["公开地址是明文远程", {AIMAC_PUBLIC_URL: "http://aimac.example.test"}, "明文传输等于把它们交出去"]
  ];
  for (const [why, overrides, expected] of startupCases) {
    const attempt = spawnSync(process.execPath, ["apps/control-plane-ui/server.mjs"],
      {cwd: root, encoding: "utf8", timeout: 60000,
        env: {...process.env, AIMAC_RUNTIME_DIR: `${doctorRuntimeDir}-startup`, AIMAC_PORT: "0", ...overrides}});
    const said = `${attempt.stdout || ""}${attempt.stderr || ""}`;
    if (attempt.status === 0) throw new Error(`启动期「${why}」居然没被拦下`);
    if (/ {4}at \w+|node:internal/u.test(said)) {
      throw new Error(`启动期「${why}」吐给运维的是崩溃栈：${said.slice(0, 200)}`);
    }
    if (!said.includes(expected)) {
      throw new Error(`启动期「${why}」没说清原因，期望提到「${expected}」：${said.slice(0, 200)}`);
    }
    if (!said.includes("·")) throw new Error(`启动期「${why}」只报了结论、没给下一步`);
  }
  // 密钥不安全时绝不能把密钥本身回显出去 —— 启动日志常被原样贴进工单。
  const leaky = spawnSync(process.execPath, ["apps/control-plane-ui/server.mjs"],
    {cwd: root, encoding: "utf8", timeout: 60000,
      env: {...process.env, AIMAC_RUNTIME_DIR: `${doctorRuntimeDir}-startup`, AIMAC_PORT: "0",
        AIMAC_BOOTSTRAP_TOKEN: "hunter2-please-do-not-print"}});
  if (`${leaky.stdout || ""}${leaky.stderr || ""}`.includes("hunter2-please-do-not-print")) {
    throw new Error("启动期把不安全的密钥原样打进了日志");
  }
}

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
  if (idempotencyConflict.response.status !== 409 || idempotencyConflict.payload?.error !== "idempotency_key_reuse_conflict") {
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
  if (reviewerOrchestrateDenied.response.status !== 403 || reviewerOrchestrateDenied.payload?.error !== "policy_denied") {
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
  if (reviewerCrossProjectDenied.response.status !== 403 || reviewerCrossProjectDenied.payload?.error !== "policy_denied") {
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
  if (ownerWildcardGrantDenied.response.status !== 400 || ownerWildcardGrantDenied.payload?.error !== "unsafe_grant_permissions") {
    throw new Error(`expected project owner wildcard grant to be rejected, got ${ownerWildcardGrantDenied.response.status}`);
  }
  const ownerCrossProjectDenied = await jsonFetch(port, "/api/access-grants", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-owner-cross-project-denied", authorization: auth},
    body: JSON.stringify({subjectId: "acct_reviewer", resourceType: "project", resourceId: "prj_other", role: "project_admin", permissions: ["project:grant"]})
  });
  if (ownerCrossProjectDenied.response.status !== 403 || ownerCrossProjectDenied.payload?.error !== "policy_denied") {
    throw new Error(`expected workspace owner project grant to stay resource-scoped, got ${ownerCrossProjectDenied.response.status}`);
  }
  const ownerCrossProjectInviteDenied = await jsonFetch(port, "/api/accounts", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-owner-cross-project-invite-denied", authorization: auth},
    body: JSON.stringify({projectId: "prj_other", displayName: "Other Project User", email: "other-project-user@local"})
  });
  if (ownerCrossProjectInviteDenied.response.status !== 403 || ownerCrossProjectInviteDenied.payload?.error !== "policy_denied") {
    throw new Error(`expected workspace owner invite to stay project-scoped, got ${ownerCrossProjectInviteDenied.response.status}`);
  }
  const ownerSystemInviteDenied = await jsonFetch(port, "/api/accounts", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-owner-system-invite-denied", authorization: auth},
    body: JSON.stringify({projectId: "prj_control_plane", accountType: "system_admin", displayName: "Escalated Admin", email: "escalated-admin@local", roles: "system_admin", permissions: "system:*"})
  });
  if (ownerSystemInviteDenied.response.status !== 403 || ownerSystemInviteDenied.payload?.error !== "policy_denied") {
    throw new Error(`expected project-scoped inviter not to create system admin, got ${ownerSystemInviteDenied.response.status}`);
  }
  const ownerCrossProjectAgentDenied = await jsonFetch(port, "/api/agents", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-owner-cross-project-agent-denied", authorization: auth},
    body: JSON.stringify({projectId: "prj_other", name: "Other Project Agent", role: "reviewer", model: "auto_best"})
  });
  if (ownerCrossProjectAgentDenied.response.status !== 403 || ownerCrossProjectAgentDenied.payload?.error !== "policy_denied") {
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
  // 点名错误码而不是只看 403：换成【别的】守卫把它拒掉（比如权限不足），这条照样绿，
  // 而"非系统账号不得替别人挂负责人"那道门其实已经没了 —— 拒了和拒对了是两件事。
  if (delegatedProjectOwnerDenied.response.status !== 403
    || delegatedProjectOwnerDenied.payload?.error !== "project_owner_assignment_denied") {
    throw new Error(`expected non-system project creator not to assign another owner, got ${delegatedProjectOwnerDenied.response.status}`
      + ` ${JSON.stringify(delegatedProjectOwnerDenied.payload).slice(0, 120)} —— 任何能建项目的人都能替别人挂上一份会真正生效的负责人授权`);
  }
  const delegatedProjectOwnerDeniedReplay = await jsonFetch(port, "/api/projects", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-project-delegated-owner-denied", authorization: auth},
    body: JSON.stringify({name: "Delegated Owner Project", ownerAccountId: "acct_reviewer"})
  });
  const delegatedDenyStateAfter = await jsonFetch(port, "/api/state?view=system&limit=20", {
    headers: {authorization: systemAuth}
  });
  if (delegatedProjectOwnerDeniedReplay.response.status !== 403 || delegatedProjectOwnerDeniedReplay.payload?.error !== "project_owner_assignment_denied") {
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
  if (ownerCreatedTaskOrchestrateDenied.response.status !== 403 || ownerCreatedTaskOrchestrateDenied.payload?.error !== "policy_denied") {
    throw new Error(`expected project owner task_group:control not to satisfy orchestration permission, got ${ownerCreatedTaskOrchestrateDenied.response.status}`);
  }
  const ownerWorkerRunDenied = await jsonFetch(port, "/api/verification/agent-runtime/run", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-owner-worker-run-denied", authorization: auth},
    body: JSON.stringify({taskGroupId: createdTaskGroup.payload.taskGroup.id, maxJobs: 1})
  });
  if (ownerWorkerRunDenied.response.status !== 403 || ownerWorkerRunDenied.payload?.error !== "principal_not_allowed_for_action") {
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
  if (crossScopeResolve.response.status !== 403 || crossScopeResolve.payload?.error !== "policy_denied") {
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
  if (undelegatableInvite.response.status !== 403 || undelegatableInvite.payload?.error !== "invite_permission_not_delegable") {
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
	  issuedPlaintextSecrets.push(["受邀账号的一次性令牌", invitedAccount.payload?.accountToken]);
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
  if (badTarget.response.status !== 400 || badTarget.payload?.error !== "repository_output_target_must_use_git_trackable_paths") {
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
  if (ownerCheckpointDenied.response.status !== 403 || ownerCheckpointDenied.payload?.error !== "principal_not_allowed_for_action") {
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
  // 这两条原先只判 409。实测它们落在 `active_agent_dispatch_required` ——
  // 这一段里的派发还是 queued（不是 running），而"产出目标对不上""清单缺失"那两道门都在它后面，
  // 也就是说**这两条从来没验到自己声称要验的东西**。收紧成点名码，把这个事实钉在明面上：
  // 真正验那两道门的是契约门里的伪造夹具（它把派发置为 running 之后逐条走过）。
  // 这里保留它们的价值是：证明"没有活跃派发就交检查点"这条边界本身还在。
  if (forgedWrongTarget.response.status !== 409
    || forgedWrongTarget.payload?.error !== "active_agent_dispatch_required") {
    throw new Error(`没有活跃派发时交检查点，没有被 active_agent_dispatch_required 拦下`
      + `（${forgedWrongTarget.response.status} ${JSON.stringify(forgedWrongTarget.payload).slice(0, 120)}）`);
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
  if (forgedMissingManifest.response.status !== 409
    || forgedMissingManifest.payload?.error !== "active_agent_dispatch_required") {
    throw new Error(`没有活跃派发时交检查点（缺清单那一版），没有被 active_agent_dispatch_required 拦下`
      + `（${forgedMissingManifest.response.status} ${JSON.stringify(forgedMissingManifest.payload).slice(0, 120)}）`);
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
  // 邮箱是初始组织管理员的【登录身份】，不能替人编一个。原先缺了就默认成
  // org-admin-<时间戳>@local 并回 201 —— 字段发成平铺的 adminEmail（服务端认的是嵌套
  // 的 admin.email）就会静默走到这条路上，调用方拿到"创建成功"，而那个人的身份是系统编的。
  {
    const invented = await jsonFetch(port, "/api/orgs", {
      method: "POST",
      headers: {"Idempotency-Key": "doctor-org-no-admin-email", authorization: systemAuth},
      body: JSON.stringify({name: "缺邮箱的组织", adminEmail: "flat@local", adminName: "平铺字段"})
    });
    if (invented.response.status !== 400 || invented.payload.error !== "organization_admin_email_required") {
      throw new Error(`没给 admin.email 也把组织建出来了（HTTP ${invented.response.status}）：`
        + `${JSON.stringify(invented.payload).slice(0, 200)}`);
    }
    if (!String(invented.payload.hint || "").includes("admin.email")) {
      throw new Error("拒绝时没有指出字段在 admin.email —— 发成平铺字段的人只能靠猜");
    }
  }

  // 一次性邀请凭据【会过期】这件事，代码里有判据（登录时比 credentialExpiresAt 与现在），
  // 但没有任何断言证明它真的触发过 —— 一次重构把字段名比错，就变成"邀请令牌永不过期"，
  // 而这类失效是静默的：所有正常登录照旧成功。这里直接把一份邀请改成已过期再登录。
  // 注意登录判据写的是 `!credentialExpiresAt || 未过期`：字段【缺失】等于永不过期，
  // 所以第二支验的是"缺字段的邀请也不能长期可用"这条边界目前不可达（五处签发都成对写了）。
  {
    const expiring = await jsonFetch(port, "/api/accounts", {
      method: "POST", headers: {authorization: systemAuth, "Idempotency-Key": "doctor-expiring-invite"},
      body: JSON.stringify({displayName: "过期邀请探针", email: "expiring.invite@local", accountType: "user_account"})
    });
    if (expiring.response.status !== 201 || !expiring.payload.accountToken) {
      throw new Error(`过期邀请探针建不出来（HTTP ${expiring.response.status}）—— 本条在空转`);
    }
    const statePath = join(root, doctorRuntimeDir, "control-plane-state.json");
    const snapshot = JSON.parse(readFileSync(statePath, "utf8"));
    const target = (snapshot.accounts || []).find((item) => item.email === "expiring.invite@local");
    if (!target?.credentialDigest || !target?.credentialExpiresAt) {
      throw new Error("签发邀请时没有同时写下凭据摘要与过期时间 —— 缺过期时间等于这张票永不过期");
    }
    target.credentialExpiresAt = new Date(Date.now() - 60000).toISOString();
    writeFileSync(statePath, JSON.stringify(snapshot));
    const expiredLogin = await jsonFetch(port, "/api/auth/login", {
      method: "POST", body: JSON.stringify({email: "expiring.invite@local", token: expiring.payload.accountToken})
    });
    if (expiredLogin.response.status !== 401) {
      throw new Error(`已过期的一次性邀请仍然能登录（HTTP ${expiredLogin.response.status}）——`
        + "那张票发出去之后就永远有效了");
    }
  }

  // 自由文本必须有上限。实测一次请求就能把任务组目标写进 30 万字，状态文件 56KB 涨到 1.8MB —— 
  // 而每次写入的成本正比于状态大小，这一个字段会让【此后每一次写入】都替它买单。
  // 拒绝而不是静默截断：存下的内容与人写的不一致，比报错难查得多。
  {
    const huge = "长".repeat(300000);
    const before = statSync(join(root, doctorRuntimeDir, "control-plane-state.json")).size;
    const bigGroup = await jsonFetch(port, "/api/task-groups", {
      method: "POST", headers: {authorization: systemAuth, "Idempotency-Key": "doctor-huge-objective"},
      body: JSON.stringify({projectId: "prj_control_plane", title: "超长目标探针", objective: huge})
    });
    if (bigGroup.response.status !== 400 || bigGroup.payload.error !== "task_group_objective_too_long") {
      throw new Error(`30 万字的任务组目标被收下了（HTTP ${bigGroup.response.status}）——`
        + "状态会被它永久撑大，而每次写入的成本正比于状态大小");
    }
    // REST 侧把 details 摊平到顶层（{error, limit, actual, over, message}），
    // MCP 侧是嵌在 details 里 —— 两边形状不同，判据要认各自那一份，别只按一种写。
    const limitInfo = bigGroup.payload.details || bigGroup.payload;
    if (!limitInfo.limit || !limitInfo.actual) {
      throw new Error(`拒绝时没说上限是多少、实际多少：${JSON.stringify(bigGroup.payload).slice(0, 160)}`);
    }
    const bigProject = await jsonFetch(port, "/api/projects", {
      method: "POST", headers: {authorization: systemAuth, "Idempotency-Key": "doctor-huge-project-name"},
      body: JSON.stringify({name: huge, key: "huge"})
    });
    if (bigProject.response.status !== 400 || bigProject.payload.error !== "project_name_too_long") {
      throw new Error(`30 万字的项目名被收下了（HTTP ${bigProject.response.status}）`);
    }
    // 数组是同一个洞的另一扇门：条数与单条长度都要有上限。
    // 实测两条请求（5 万条要求 + 一条 30 万字的要求）把状态从 63KB 撑到 6.4MB。
    const tooManyItems = await jsonFetch(port, "/api/task-groups/tg_runtime_management/work-items", {
      method: "POST", headers: {authorization: systemAuth, "Idempotency-Key": "doctor-too-many-reqs"},
      body: JSON.stringify({title: "条数探针", ownerRole: "agent-runtime",
        requirements: Array.from({length: 50000}, (unused, index) => `要求 ${index}`)})
    });
    if (tooManyItems.response.status !== 400 || tooManyItems.payload.error !== "work_item_requirements_too_many_items") {
      throw new Error(`5 万条机器可执行要求被收下了（HTTP ${tooManyItems.response.status}）`);
    }
    const itemTooLong = await jsonFetch(port, "/api/task-groups/tg_runtime_management/work-items", {
      method: "POST", headers: {authorization: systemAuth, "Idempotency-Key": "doctor-req-too-long"},
      body: JSON.stringify({title: "长度探针", ownerRole: "agent-runtime", requirements: [huge]})
    });
    if (itemTooLong.response.status !== 400 || itemTooLong.payload.error !== "work_item_requirements_item_too_long") {
      throw new Error(`单条 30 万字的要求被收下了（HTTP ${itemTooLong.response.status}）`);
    }
    // 正常长度的清单必须照常收下 —— 上限不能把真实用法一起挡掉。
    const normalList = await jsonFetch(port, "/api/task-groups/tg_runtime_management/work-items", {
      method: "POST", headers: {authorization: systemAuth, "Idempotency-Key": "doctor-normal-reqs"},
      body: JSON.stringify({title: "正常清单", ownerRole: "agent-runtime",
        requirements: ["页面能打开", "接口返回 200"]})
    });
    if (normalList.response.status !== 201 || normalList.payload.workItem?.requirements?.length !== 2) {
      throw new Error(`正常长度的要求清单被上限挡掉了（HTTP ${normalList.response.status}）—— 守卫过头了`);
    }
    const after = statSync(join(root, doctorRuntimeDir, "control-plane-state.json")).size;
    if (after > before + 64 * 1024) {
      throw new Error(`被拒的超长写入仍然把状态撑大了：${(before / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB`);
    }
  }

  // 邮箱按大小写/首尾空格归一比对。手机键盘默认把首字母大写，粘贴常带空格 ——
  // 严格比较会让人拿自己的邮箱登不进来，而回的是统一的 invalid_credentials（有意不透露
  // 账号是否存在），于是人完全看不出问题出在大小写上。登录与"是否已注册"必须同一口径，
  // 否则会存在两个只差大小写的账号、登录时不知道该匹配谁 —— 三支都验。
  {
    const made = await jsonFetch(port, "/api/orgs", {
      method: "POST",
      headers: {"Idempotency-Key": "doctor-org-email-case", authorization: systemAuth},
      body: JSON.stringify({name: "大小写探针组织", admin: {displayName: "管", email: "case.probe@local"}})
    });
    if (made.response.status !== 201) throw new Error(`大小写探针组织没建起来：${made.response.status}`);
    const upper = await jsonFetch(port, "/api/auth/login", {
      method: "POST", body: JSON.stringify({email: "  Case.Probe@LOCAL  ", token: made.payload.accountToken})
    });
    if (upper.response.status !== 200) {
      throw new Error(`换个大小写（并带首尾空格）就登不进来了：HTTP ${upper.response.status} `
        + `${JSON.stringify(upper.payload).slice(0, 120)}`);
    }
    const dupe = await jsonFetch(port, "/api/orgs", {
      method: "POST",
      headers: {"Idempotency-Key": "doctor-org-email-case-dupe", authorization: systemAuth},
      body: JSON.stringify({name: "撞名组织", admin: {displayName: "管乙", email: "CASE.PROBE@local"}})
    });
    if (dupe.response.status !== 409 || dupe.payload?.error !== "account_email_already_registered") {
      throw new Error(`建出了只差大小写的第二个账号（HTTP ${dupe.response.status}）——`
        + "登录时就不知道该匹配谁了");
    }
    // 统一的 401 是有意的（不透露账号是否存在）。归一比对不能把这个性质带偏。
    const wrongToken = await jsonFetch(port, "/api/auth/login", {
      method: "POST", body: JSON.stringify({email: "case.probe@local", token: "definitely-not-the-token"})
    });
    const noSuchAccount = await jsonFetch(port, "/api/auth/login", {
      method: "POST", body: JSON.stringify({email: "nobody.at.all@local", token: "definitely-not-the-token"})
    });
    if (wrongToken.response.status !== 401 || noSuchAccount.response.status !== 401
      || JSON.stringify(wrongToken.payload) !== JSON.stringify(noSuchAccount.payload)) {
      throw new Error("登录失败的回答不再统一了 —— 账号存不存在会被探出来："
        + `${JSON.stringify(wrongToken.payload)} vs ${JSON.stringify(noSuchAccount.payload)}`);
    }
  }

  const orgCreate = await jsonFetch(port, "/api/orgs", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-org-create", authorization: systemAuth},
    body: JSON.stringify({name: "医生组织", quotas: {maxMembers: 2, maxProjects: 1, maxTaskGroups: 1, maxAgents: 1}, admin: {displayName: "组织超管", email: "doctor.org.admin@local"}})
  });
  issuedPlaintextSecrets.push(["组织管理员的一次性令牌", orgCreate.payload?.accountToken]);
  if (orgCreate.response.status !== 201 || !orgCreate.payload.accountToken) {
    throw new Error(`organization create failed: ${orgCreate.response.status}`);
  }
  const orgId = orgCreate.payload.organization.orgId;
  let orgAdminAuth = await loginAs(port, "doctor.org.admin@local", orgCreate.payload.accountToken);

  // 租户边界：别的组织的账号不得被授予本组织项目的角色。这条守卫此前【一条判据都没有】——
  // 它失效时同组织的授权照旧成功，只有跨组织那一次会悄悄通过，而那等于把一个外人放进项目。
  // 正面对照上面已经有了（第一次 members 授权用的是同组织账号，要求成功），这里补反面。
  {
    const foreignAccountId = orgCreate.payload.adminAccount?.accountId;
    if (!foreignAccountId) throw new Error("拿不到别的组织的账号 id —— 跨组织授权这条在空转");
    const crossOrgGrant = await jsonFetch(port, `/api/projects/${createdProject.payload.id}/members`, {
      method: "POST",
      headers: {"Idempotency-Key": "doctor-cross-org-member", authorization: auth},
      body: JSON.stringify({accountId: foreignAccountId, role: "project_admin"})
    });
    if (crossOrgGrant.response.status !== 400 || crossOrgGrant.payload.error !== "cross_org_member_not_allowed") {
      throw new Error(`把别的组织的账号授权进了本项目（${crossOrgGrant.response.status}:`
        + `${crossOrgGrant.payload.error}）—— 租户边界在成员授权这条路上是敞开的`);
    }
  }
  // 改口令的三道守卫此前一条断言都没有。它们各自失效的后果都很直接：
  // 太短 → 弱口令进库；不核对当前口令 → 拿到一个没锁屏的会话就能改掉别人的口令；
  // 登录不核对 → 口令形同虚设。
  expectStatus(await jsonFetch(port, "/api/auth/change-password", {
    method: "POST", headers: {authorization: orgAdminAuth},
    body: JSON.stringify({newPassword: "短"})
  }), 400, "太短的新口令必须被拒", "password_too_short");
  expectStatus(await jsonFetch(port, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({email: "doctor.org.admin@local", password: "这不是我的口令"})
  }), 401, "口令不对必须被拒", "invalid_credentials");
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
  // 改密即撤销该账号【全部】会话（含发起这次改密的那一条）——那是"我怀疑被盗号"时唯一的自救手段，
  // 不撤销就等于对攻击者毫无影响。这条性质此前只写在注释里，没有任何断言压着。
  // 界面也依赖它：改完密码要当场回登录页，而不是留在一条已经死掉的会话里。
  {
    const staleSession = await jsonFetch(port, "/api/state?view=orgs", {headers: {authorization: orgAdminAuth}});
    if (staleSession.response.status !== 401) {
      throw new Error(`改密之后原来那条会话还能用（HTTP ${staleSession.response.status}）——`
        + "被盗号的人改了密码，攻击者手里的令牌照样有效");
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
  // 这一条必须在【账号已经设过口令】之后：守卫只在 account.passwordDigest 存在时才核对当前口令，
  // 第一次设密本来就不需要旧口令 —— 放在设密之前，验到的是"没有旧口令可核对"那一支（实测过）。
  expectStatus(await jsonFetch(port, "/api/auth/change-password", {
    method: "POST", headers: {authorization: orgAdminAuth},
    body: JSON.stringify({currentPassword: "不是当前这一个", newPassword: "doctor-org-admin-pass2"})
  }), 403, "报错了当前口令就不许改密", "current_password_incorrect");
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
  if (unknownViewCached.response.status !== 400 || unknownViewCached.payload?.error !== "state_view_unknown") {
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
  if (bogusControl.response.status !== 400 || bogusControl.payload?.error !== "unsupported_task_group_control_action") {
    throw new Error(`未登记的任务组控制动作返回了 ${bogusControl.response.status} —— 人得到成功回执却什么都没发生，且这个名字会进审计`);
  }
  if (orgControl.response.status !== 200) {
    throw new Error(`org_admin could not control its own org project's task group, got ${orgControl.response.status}`);
  }
  // 写路径上的同一条不变式：非系统账号对一个【看不见的】项目 id，无论它存不存在，答案必须一样。
  // 只在读路径上统一是不够的 —— 写路由各自的判权点在存在检查【之后】，两种情况会落到不同的码上
  // （实测过：POST config 落 policy_denied、POST members 一路走到更靠后的 account_not_found）。
  for (const [what, path, payload] of [
    ["config", "config", {configVersion: 1, baselineData: []}],
    ["members", "members", {email: "review@local", displayName: "R", roles: "viewer"}]
  ]) {
    const answers = [];
    for (const id of ["prj_never_existed", "prj_control_plane"]) {
      const probe = await jsonFetch(port, `/api/projects/${id}/${path}`, {method: "POST",
        headers: {"Idempotency-Key": `existence-write-${what}-${id}`, authorization: orgAdminAuth},
        body: JSON.stringify(payload)});
      answers.push(`${probe.response.status}:${probe.payload?.error}`);
    }
    if (answers[0] !== answers[1]) {
      throw new Error(`POST /api/projects/:id/${path}：受限账号写"不存在的 id"得到 ${answers[0]}、写"别的租户真有的 id"得到 ${answers[1]}`
        + " —— 两者可分辨，写路由同样是一台跨租户存在性探针");
    }
  }
  console.log("REST 写路径跨租户存在性 ok: 项目配置与成员两条写路由，两种'看不见'给同一个答案");

  // 【缺省不得等于有利结果】四条处置路由都用"白名单映射 + 认不出就拒"。一旦改成"认不出按默认值处理"，
  // `status` 打错一个字母就是一次真实的处置 —— 而这四条的推进方向全是【向前】（consumed/closed/active…）。
  // 这里只验共享定义那一条：另外三类（复核包/升级候选/复核方案）种子里没有实例，
  // 存在检查在状态校验【之前】，探针会停在 404，验不到被测的那道门 —— 与其编一个假通过，不如说清楚。
  // 那三条的同形判据由契约门里各自的用例覆盖（它们直接调核心函数，不经过存在检查这一步）。
  {
    const bogusStatus = await jsonFetch(port, "/api/shared-definition-contracts/sdc_status_semantics/resolve", {method: "POST",
      headers: {"Idempotency-Key": "status-invalid-shared-definition", authorization: systemAuth},
      body: JSON.stringify({status: "definitely_not_a_status"})});
    if (bogusStatus.payload?.error !== "shared_definition_status_invalid") {
      throw new Error(`共享定义处置：喂一个认不出的状态，没有回 shared_definition_status_invalid`
        + `（实际 ${bogusStatus.response.status} ${JSON.stringify(bogusStatus.payload).slice(0, 120)}）`
        + " —— 认不出就按默认值处理的话，status 打错一个字母就是一次真实的激活");
    }
    // 正面对照：合法状态必须走得通，否则这道门把正常处置一起堵死。
    const legitStatus = await jsonFetch(port, "/api/shared-definition-contracts/sdc_status_semantics/resolve", {method: "POST",
      headers: {"Idempotency-Key": "status-valid-shared-definition", authorization: systemAuth},
      // 这条路还要求写明处置理由（真人处置必须留下依据）—— 正面对照把这个前提也暴露了出来。
      body: JSON.stringify({status: "retired", justification: "探针：验证合法状态照常走得通"})});
    if (!legitStatus.response.ok) {
      throw new Error(`共享定义处置：合法状态 retired 也被拒了（${legitStatus.response.status} ${JSON.stringify(legitStatus.payload).slice(0, 120)}）`);
    }
    console.log("认不出的处置状态 ok: 共享定义处置拒绝未知状态，而合法状态照常走得通");
  }

  // 写入层的两道授权边界，此前都没有点名断言。
  // ① 真人专属动作不得由机器主体执行 —— 这是人工定稿闸门落在【写入层】的那一处：
  //    配置面挡一层、决策点挡一层，这里是第三层，而三层里只要有一层是唯一生效的那层就必须自己会红。
  //    动作要挑一个这个服务账号【本来就有权限】的，否则先撞上 permission_denied，
  //    验到的是"它没权限"而不是"它不是人"（第一版就是这样）。
  const machineHumanOnly = await jsonFetch(port, "/api/human-directives", {method: "POST",
    headers: {"Idempotency-Key": "doctor-machine-human-only", authorization: agentAuth},
    body: JSON.stringify({taskGroupId: "tg_runtime_management", directiveType: "guidance",
      summary: "机器主体下的人工指令"})});
  if (machineHumanOnly.response.status !== 403
    || machineHumanOnly.payload?.error !== "principal_not_allowed_for_action") {
    throw new Error(`服务账号执行了真人专属动作 human_directive_create（${machineHumanOnly.response.status} ${JSON.stringify(machineHumanOnly.payload).slice(0, 120)}）`
      + " —— AI 拿一个服务账号就能替人下指令，人工闸门在写入层这一处形同虚设");
  }
  // 正面对照：同一个动作由真人做必须走得通，否则这道门把正常路径一起堵死。
  const humanSameAction = await jsonFetch(port, "/api/human-directives", {method: "POST",
    headers: {"Idempotency-Key": "doctor-human-same-action", authorization: systemAuth},
    body: JSON.stringify({taskGroupId: "tg_runtime_management", directiveType: "guidance",
      summary: "真人下的人工指令"})});
  if (humanSameAction.response.status === 403
    && humanSameAction.payload?.error === "principal_not_allowed_for_action") {
    throw new Error("真人也被'真人专属动作'挡住了 —— 这道门把正常路径一起堵死了");
  }

  console.log("写入层授权边界 ok: 机器主体做不了真人专属动作，而真人照常可以");

  // 归档是项目的终结态，而归档路由【要求先把所有任务组关掉】（不级联，让人自己收尾）。
  // 归档之后还能往里建新任务组的话，那次收尾就白做了：项目重新变活，而它已经不在任何人的视野里
  // （概览按 active 列、编排跳过 archived）—— 新组从此没人看、没人推。
  {
    const archProject = await jsonFetch(port, "/api/projects", {method: "POST",
      headers: {"Idempotency-Key": "doctor-archive-probe-project", authorization: systemAuth},
      body: JSON.stringify({name: "归档探针项目", key: "archive-probe"})});
    const archProjectId = archProject.payload?.id || archProject.payload?.project?.id;
    if (!archProjectId) throw new Error("归档探针造不出项目 —— 下面几条会在空转");
    const archived = await jsonFetch(port, `/api/projects/${archProjectId}/archive`, {method: "POST",
      headers: {"Idempotency-Key": "doctor-archive-probe", authorization: systemAuth}, body: "{}"});
    if (!archived.response.ok) throw new Error(`归档一个没有任务组的项目就失败了：${JSON.stringify(archived.payload).slice(0, 160)}`);
    const afterArchive = await jsonFetch(port, "/api/task-groups", {method: "POST",
      headers: {"Idempotency-Key": "doctor-archive-probe-tg", authorization: systemAuth},
      body: JSON.stringify({projectId: archProjectId, title: "归档后新建的任务组"})});
    if (afterArchive.response.ok || afterArchive.payload?.error !== "project_archived") {
      throw new Error(`已归档的项目里还能新建任务组（${afterArchive.response.status} ${JSON.stringify(afterArchive.payload).slice(0, 120)}）`
        + " —— 归档前那次逐个关闭白做了，新组也不在任何人的视野里");
    }
    // 正面对照：没归档的项目必须照常建得出来，否则这道判据把正常路径一起堵死。
    const liveProject = await jsonFetch(port, "/api/projects", {method: "POST",
      headers: {"Idempotency-Key": "doctor-archive-live-project", authorization: systemAuth},
      body: JSON.stringify({name: "未归档对照项目", key: "archive-live"})});
    const liveId = liveProject.payload?.id || liveProject.payload?.project?.id;
    const liveGroup = await jsonFetch(port, "/api/task-groups", {method: "POST",
      headers: {"Idempotency-Key": "doctor-archive-live-tg", authorization: systemAuth},
      body: JSON.stringify({projectId: liveId, title: "未归档项目里的任务组"})});
    if (!liveGroup.response.ok) {
      throw new Error(`未归档的项目里也建不出任务组（${liveGroup.response.status} ${JSON.stringify(liveGroup.payload).slice(0, 120)}）—— 这道判据把正常路径堵死了`);
    }
    console.log("项目归档终态 ok: 归档后建不了新任务组，未归档的照常建得出来");
  }

  // 跨租户存在性探针（REST 侧）：受限账号问一个项目 id，"查无此物"与"别处真有"必须给同一个答案。
  // 两者可分辨的话，拿一批 id 试一遍就知道这套部署里别的租户有没有它们。
  for (const route of ["config", "progress"]) {
    const answers = [];
    for (const id of ["prj_never_existed", "prj_control_plane"]) {
      const probe = await jsonFetch(port, `/api/projects/${id}/${route}`, {headers: {authorization: orgAdminAuth}});
      answers.push(`${probe.response.status}:${probe.payload?.error}`);
    }
    if (answers[0] !== answers[1]) {
      throw new Error(`/api/projects/:id/${route}：受限账号问"不存在的 id"得到 ${answers[0]}、问"别的租户真有的 id"得到 ${answers[1]}`
        + " —— 两者可分辨，这条路由就是一台跨租户存在性探针");
    }
    // 正面对照：系统账号本就有权知道什么存在，必须仍拿得到准确的 404，否则运维分不清是打错 id 还是没权限。
    const asSystem = await jsonFetch(port, `/api/projects/prj_never_existed/${route}`, {headers: {authorization: systemAuth}});
    if (asSystem.response.status !== 404 || asSystem.payload?.error !== "project_not_found") {
      throw new Error(`/api/projects/:id/${route}：系统账号问一个不存在的项目没有拿到 404 project_not_found`
        + `（实际 ${asSystem.response.status} ${asSystem.payload?.error}）—— 越权与打错 id 被一锅端`);
    }
  }
  console.log("REST 跨租户存在性 ok: 受限账号分辨不出别的租户有没有某个项目，而系统账号仍拿得到准确的 404");

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
  if (lastAdminDisable.response.status !== 409 || lastAdminDisable.payload?.error !== "org_last_admin_cannot_be_disabled") {
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
  if (zombieActivate.response.status !== 409 || zombieActivate.payload?.error !== "org_member_invitation_pending") {
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
  if (orgReviewAuthority.response.status !== 403 || orgReviewAuthority.payload?.error !== "policy_denied") {
    throw new Error(`未知确认单必须与无权限同样回答 403（不可解析的作用域应当拒绝，且不泄露存在性），got ${orgReviewAuthority.response.status}`);
  }
  // Cross-organization write isolation: an org_admin cannot create a task group in another org's project.
  const crossOrgTaskGroup = await jsonFetch(port, "/api/task-groups", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-cross-org-tg", authorization: orgAdminAuth},
    body: JSON.stringify({projectId: "prj_control_plane", title: "越权任务组"})
  });
  if (crossOrgTaskGroup.response.status !== 403 || crossOrgTaskGroup.payload?.error !== "policy_denied") {
    throw new Error(`cross-organization task group creation was not denied, got ${crossOrgTaskGroup.response.status}`);
  }
  const crossOrgDirective = await jsonFetch(port, "/api/human-directives", {
    method: "POST",
    headers: {"Idempotency-Key": "doctor-cross-org-directive", authorization: orgAdminAuth},
    body: JSON.stringify({taskGroupId: "tg_runtime_management", directiveType: "pause"})
  });
  if (crossOrgDirective.response.status !== 403 || crossOrgDirective.payload?.error !== "policy_denied") {
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
  expectStatus(await g2("/api/work-items/work_management_ui/assign", invitedAuth, "g2b-assign-deny", {taskGroupId: "tg_runtime_management", roleId: "reviewer"}), 403, "work assign deny", "policy_denied");

  // findings → task_group:review (+ cross-tenant deny + resolve)
  const findingOk = expectStatus(await g2("/api/findings", reviewerAuth, "g2b-finding-ok", {taskGroupId: "tg_runtime_management", findingType: "review", severity: "low", summary: "doctor finding"}), 201, "finding submit happy");
  expectStatus(await g2("/api/findings", invitedAuth, "g2b-finding-deny", {taskGroupId: "tg_runtime_management", summary: "denied"}), 403, "finding submit deny", "policy_denied");
  expectStatus(await g2("/api/findings", orgAdminAuth, "g2b-finding-crossorg", {taskGroupId: "tg_runtime_management", summary: "cross org"}), 403, "finding submit cross-tenant deny", "policy_denied");
  expectStatus(await g2(`/api/findings/${findingOk.payload.finding.findingId}/resolve`, reviewerAuth, "g2b-finding-resolve-ok", {status: "resolved", evidenceRefs: ["evidence:doctor"], rootCauseOwner: "reviewer"}), 200, "finding resolve happy");
  // 已定过的缺陷不得被第二次处置：回 200 意味着后到的那个人以为自己改掉了结论，而记录没动。
  expectStatus(await g2(`/api/findings/${findingOk.payload.finding.findingId}/resolve`, reviewerAuth,
    "g2b-finding-resolve-again", {status: "dismissed", evidenceRefs: ["e2e"]}), 409,
  "已被处置的缺陷必须回 409", "finding_already_resolved");
  // 【认不出的处置状态必须拒绝】这三条走的是同一形状：状态名拼错时，原先会掉到默认那条
  // 或者静默不改，人却拿到成功回执。三个入口各有自己的拒绝码，逐个点名。
  const bogusStatusTargets = [
    {create: ["/api/review-bundles", {taskGroupId: "tg_runtime_management", evidenceRefs: ["evidence:e2e-status"]}],
      idOf: (r) => r.payload?.reviewBundle?.reviewBundleId || r.payload?.reviewBundleId,
      base: "/api/review-bundles", code: "review_bundle_status_invalid", what: "评审包"},
    {create: ["/api/review-plans", {taskGroupId: "tg_runtime_management", scope: "e2e"}],
      idOf: (r) => r.payload?.reviewPlan?.reviewPlanId || r.payload?.reviewPlanId,
      base: "/api/review-plans", code: "review_plan_status_invalid", what: "评审计划"},
  ];
  // 升级候选没有 REST 创建入口（只能由 MCP 从运行问题模式导出，两跳）。先试着导一次；
  // 导不出来就如实说这一条没验，别硬造一个不存在的 id 去打 —— 那验的是 404，不是状态校验。
  {
    await jsonFetch(port, "/mcp", {
      method: "POST", headers: {authorization: systemAuth},
      body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "governance-mcp.system_upgrade_candidate_export",
        arguments: {taskGroupId: "tg_runtime_management", idempotencyKey: "doctor-suc-export"}}})
    });
    const view = await jsonFetch(port, "/api/state?view=full&limit=200", {headers: {authorization: systemAuth}});
    const candidate = (view.payload.systemUpgradeCandidates || [])[0];
    if (candidate?.candidateId) {
      expectStatus(await g2(`/api/system-upgrade-candidates/${candidate.candidateId}/resolve`, systemAuth,
        "g2b-status-bogus-candidate", {status: "approved_by_security_review", justification: "e2e"}), 400,
      "认不出的升级候选状态必须拒绝", "system_upgrade_candidate_status_invalid");
    } else {
      console.log("  --  这一轮导不出升级候选（没有运行问题模式），它的状态校验未被检验");
    }
  }
  for (const [index, target] of bogusStatusTargets.entries()) {
    const created = await g2(target.create[0], systemAuth, `g2b-status-src-${index}`, target.create[1]);
    const id = target.idOf(created);
    if (!id) {
      throw new Error(`造不出${target.what}用于状态校验（HTTP ${created.response.status} `
        + `${JSON.stringify(created.payload).slice(0, 160)}）—— 那一条会打到不存在的 id 上，验的是 404 而不是状态校验`);
    }
    expectStatus(await g2(`${target.base}/${id}/resolve`, systemAuth, `g2b-status-bogus-${index}`,
      {status: "approved_by_security_review", justification: "e2e"}), 400,
    `认不出的${target.what}状态必须拒绝`, target.code);
  }

  // approval-requests → task_group:review (+ resolve)
  const approvalOk = expectStatus(await g2("/api/approval-requests", reviewerAuth, "g2b-approval-ok", {taskGroupId: "tg_runtime_management", action: "guarded_action"}), 201, "approval create happy");
  expectStatus(await g2("/api/approval-requests", invitedAuth, "g2b-approval-deny", {taskGroupId: "tg_runtime_management"}), 403, "approval create deny", "policy_denied");
  expectStatus(await g2(`/api/approval-requests/${approvalOk.payload.approvalRequest.approvalId}/resolve`, reviewerAuth, "g2b-approval-resolve-ok", {status: "approved"}), 200, "approval resolve happy");

  // policy-decisions/evaluate → system:*
  expectStatus(await g2("/api/policy-decisions/evaluate", systemAuth, "g2b-policy-ok", {action: "mcp_tool_call", allowed: true}), 201, "policy eval happy");
  expectStatus(await g2("/api/policy-decisions/evaluate", reviewerAuth, "g2b-policy-deny", {action: "mcp_tool_call"}), 403, "policy eval deny", "policy_denied");

  // contracts → project:*
  expectStatus(await g2("/api/contracts", systemAuth, "g2b-contract-ok", {projectId: "prj_control_plane", definitionType: "semantic_contract"}), 201, "contract publish happy");
  expectStatus(await g2("/api/contracts", reviewerAuth, "g2b-contract-deny", {projectId: "prj_control_plane"}), 403, "contract publish deny", "policy_denied");

  // rooms/:roomId/messages → task_group:control (POST) / read (GET)
  expectStatus(await g2("/api/rooms/room_tg_runtime_management/messages", systemAuth, "g2b-room-ok", {taskGroupId: "tg_runtime_management", text: "doctor room message"}), 201, "room send happy");
  expectStatus(await g2("/api/rooms/room_tg_runtime_management/messages", invitedAuth, "g2b-room-deny", {taskGroupId: "tg_runtime_management", text: "x"}), 403, "room send deny", "policy_denied");
  const roomRead = expectStatus(await g2("/api/rooms/room_tg_runtime_management/messages", systemAuth, null, null, "GET"), 200, "room wait read happy");
  if (!roomRead.payload.messages.some((message) => message.payload?.text === "doctor room message")) throw new Error("room wait did not return the sent message");
  expectStatus(await g2("/api/rooms/room_tg_runtime_management/messages", invitedAuth, null, null, "GET"), 403, "room wait read deny", "permission_denied");

  // leases claim/release → task_group:orchestrate
  // 用一个独立的工作项建租约夹具：一个工作项同时只能有一份生效的写入边界（防止后建的宽边界顶替
  // 人批准的窄边界），所以复用 work_permissions 会拿到它既有的、已被别的会话持租的那一份。
  const leaseTarget = expectStatus(await g2("/api/repository-output-targets", systemAuth, "g2b-lease-target", {taskGroupId: "tg_runtime_management", workItemId: "work_g2b_lease_fixture", artifactManifestPath: "docs/artifact-manifests/g2b-lease.json", pathAllowlist: ["docs/**"]}), 201, "lease target fixture");
  const leaseOk = expectStatus(await g2("/api/leases/claim", systemAuth, "g2b-lease-ok", {repositoryOutputTargetRef: leaseTarget.payload.targetId, holderRef: "session:doctor-g2b"}), 201, "lease claim happy");
  expectStatus(await g2("/api/leases/claim", invitedAuth, "g2b-lease-deny", {repositoryOutputTargetRef: leaseTarget.payload.targetId}), 403, "lease claim deny", "policy_denied");
  expectStatus(await g2(`/api/leases/${leaseOk.payload.lease.leaseId}/release`, systemAuth, "g2b-lease-release-ok", {holderRef: "session:doctor-g2b", fencingToken: leaseOk.payload.lease.fencingToken}), 200, "lease release happy");

  // artifacts → task_group:checkpoint_submit (runtime service account allowed)
  expectStatus(await g2("/api/artifacts", agentAuth, "g2b-artifact-ok", {taskGroupId: "tg_runtime_management", artifactManifestRef: "docs/artifact-manifests/doctor.json"}), 201, "artifact register happy");
  expectStatus(await g2("/api/artifacts", invitedAuth, "g2b-artifact-deny", {taskGroupId: "tg_runtime_management"}), 403, "artifact register deny", "policy_denied");

  // permission-requests submit/resolve → checkpoint_submit (runtime allowed) / project:grant
  const permOk = expectStatus(await g2("/api/permission-requests", agentAuth, "g2b-perm-ok", {taskGroupId: "tg_runtime_management", permission: "task_group:read", subjectId: "acct_agent_runtime"}), 201, "permission request happy");
  expectStatus(await g2("/api/permission-requests", invitedAuth, "g2b-perm-deny", {taskGroupId: "tg_runtime_management", permission: "task_group:read"}), 403, "permission request deny", "policy_denied");
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
      409, "拿着过期版本保存规则必须被拒（否则会静默删掉别人刚写下的规则）", "config_version_stale");
    // 不带版本同样必须被拒 —— 否则任何忘了带的调用方都能绕过这道前提。
    expectStatus(await g2("/api/projects/prj_control_plane/config", auth, "cfg-noversion",
      {businessRules: []}), 409, "不带版本保存整份规则必须被拒", "config_version_required");
    const afterCfg = await jsonFetch(port, "/api/projects/prj_control_plane/config", {headers: {authorization: auth}});
    if (!(afterCfg.payload.config.businessRules || []).some((rule) => rule.ruleId === "biz.concurrent.a")) {
      throw new Error("A 写下的规则在并发保存之后消失了");
    }
  }

  expectStatus(await g2(`/api/permission-requests/${permOk.payload.permissionRequest.requestId}/resolve`, systemAuth, "g2b-perm-resolve-ok", {status: "approved"}), 200, "permission resolve happy");
  // 两个人同时处置同一条授权请求：后到的那个必须拿到 409，而不是 200。
  // 回 200 的后果是【拒绝方被告知成功，而权限其实已经授出】—— 他不会再去看结果。
  expectStatus(await g2(`/api/permission-requests/${permOk.payload.permissionRequest.requestId}/resolve`, systemAuth, "g2b-perm-resolve-again", {status: "rejected"}), 409, "已被处置的授权请求必须回 409（否则拒绝方以为自己成功了，而权限已授出）", "permission_request_already_resolved");
  expectStatus(await g2(`/api/approval-requests/${approvalOk.payload.approvalRequest.approvalId}/resolve`, reviewerAuth, "g2b-approval-resolve-again", {status: "rejected"}), 409, "已被处置的审批请求必须回 409", "approval_already_resolved");

  // execution-topologies → task_group:orchestrate
  expectStatus(await g2("/api/execution-topologies", systemAuth, "g2b-topo-ok", {taskGroupId: "tg_runtime_management"}), 201, "execution topology happy");
  expectStatus(await g2("/api/execution-topologies", invitedAuth, "g2b-topo-deny", {taskGroupId: "tg_runtime_management"}), 403, "execution topology deny", "policy_denied");

  // derived-task-requests → task_group:orchestrate
  expectStatus(await g2("/api/derived-task-requests", systemAuth, "g2b-derived-ok", {taskGroupId: "tg_runtime_management", title: "review the security configuration"}), 201, "derived task happy");
  expectStatus(await g2("/api/derived-task-requests", invitedAuth, "g2b-derived-deny", {taskGroupId: "tg_runtime_management", title: "x"}), 403, "derived task deny", "policy_denied");

  // review-plans → task_group:review
  expectStatus(await g2("/api/review-plans", reviewerAuth, "g2b-reviewplan-ok", {taskGroupId: "tg_runtime_management"}), 201, "review plan happy");
  expectStatus(await g2("/api/review-plans", invitedAuth, "g2b-reviewplan-deny", {taskGroupId: "tg_runtime_management"}), 403, "review plan deny", "policy_denied");

  // review-bundles → task_group:review
  expectStatus(await g2("/api/review-bundles", reviewerAuth, "g2b-reviewbundle-ok", {taskGroupId: "tg_runtime_management"}), 201, "review bundle happy");
  expectStatus(await g2("/api/review-bundles", invitedAuth, "g2b-reviewbundle-deny", {taskGroupId: "tg_runtime_management"}), 403, "review bundle deny", "policy_denied");

  // rule-source-resolutions → task_group:control
  expectStatus(await g2("/api/rule-source-resolutions", systemAuth, "g2b-rulesource-ok", {taskGroupId: "tg_runtime_management", sourceRef: "reference:doctor", classification: "reference_only"}), 201, "rule source resolve happy");
  // 规则源一旦定案（reference_only/quarantined/rejected/superseded 都是终态）就不许再被改写：
  // 回 200 意味着后来的人（或 AI）能把人已经定过的分类悄悄换掉，而记录上看不出发生过两次。
  {
    const settled = await g2("/api/rule-source-resolutions", systemAuth, "g2b-rulesource-settled-src",
      {taskGroupId: "tg_runtime_management", sourceRef: "reference:doctor-settled", classification: "reference_only"});
    const resolutionId = settled.payload?.ruleSourceResolution?.resolutionId || settled.payload?.resolutionId;
    if (!resolutionId) {
      throw new Error(`造不出规则源处置记录（${JSON.stringify(settled.payload).slice(0, 160)}）—— 这一条会打到不存在的 id 上`);
    }
    expectStatus(await g2(`/api/rule-source-resolutions/${resolutionId}/settle`, systemAuth,
      "g2b-rulesource-settle-once", {taskGroupId: "tg_runtime_management", status: "rejected"}), 200,
    "第一次定案必须成功（否则下面那条可以靠一律拒绝蒙混过去）");
    expectStatus(await g2(`/api/rule-source-resolutions/${resolutionId}/settle`, systemAuth,
      "g2b-rulesource-settle-again", {taskGroupId: "tg_runtime_management", status: "quarantined"}), 409,
    "已定案的规则源不得被再次改写", "rule_source_already_settled");
  }
  expectStatus(await g2("/api/rule-source-resolutions", invitedAuth, "g2b-rulesource-deny", {taskGroupId: "tg_runtime_management", sourceRef: "reference:x"}), 403, "rule source resolve deny", "policy_denied");

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
  expectStatus(await g2("/api/task-groups/tg_runtime_management/config", agentAuth, "gate-tgconfig-deny", {languagePolicy: {primaryLanguage: "zh-CN"}}), 403, "机器主体持权限仍不得变更任务组规则/配置", "principal_not_allowed_for_action");
  expectStatus(await g2("/api/projects/prj_control_plane/config", agentAuth, "gate-projconfig-deny", {languagePolicy: {primaryLanguage: "zh-CN"}}), 403, "机器主体持权限仍不得变更项目规则/配置", "permission_denied");
  expectStatus(await g2("/api/human-directives", agentAuth, "gate-directive-deny", {taskGroupId: "tg_runtime_management", directiveType: "add_requirement", instruction: "doctor"}), 403, "机器主体持权限仍不得使用人工指令通道", "principal_not_allowed_for_action");
  expectStatus(await g2("/api/task-groups/tg_runtime_management/close-barrier/compute", agentAuth, "gate-close-deny", {mutate: true}), 403, "机器主体持权限仍不得关闭任务组", "task_group_close_requires_human_actor");
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
    // 归档写失败必须传到【专门查历史的那一屏】。此前接口读的是 state.auditArchiveFault，
    // 而那个字段全仓从没被赋过值 —— 于是这个事实永远是 null，人打开归档只看到一屏记录，
    // 不知道有条目从没落盘。两支都验：出故障要报，恢复之后要自己清掉
    //（只置不清的故障标记等于提示在说谎）。
    {
      chmodSync(archivePath, 0o444);
      const blockedWrite = await jsonFetch(port, `/api/orgs/${orgId}/quotas`, {
        method: "POST", headers: {authorization: systemAuth, "Idempotency-Key": "doctor-archive-fault"},
        body: JSON.stringify({quotas: {maxMembers: 61}})
      });
      const faulted = await readArchive();
      chmodSync(archivePath, 0o644);
      if (!blockedWrite.response.ok) {
        throw new Error(`归档写不进去时整个写请求也失败了（HTTP ${blockedWrite.response.status}）——`
          + "台账落不了盘不该把业务写入一起挡死");
      }
      const fault = faulted.payload.archiveFault;
      if (!fault || !fault.lostEntries || !fault.error) {
        throw new Error(`归档写失败了，查历史那一屏却毫无察觉：archiveFault=${JSON.stringify(fault)}`);
      }
      const recovered = await jsonFetch(port, `/api/orgs/${orgId}/quotas`, {
        method: "POST", headers: {authorization: systemAuth, "Idempotency-Key": "doctor-archive-recover"},
        body: JSON.stringify({quotas: {maxMembers: 62}})
      });
      if (!recovered.response.ok) throw new Error("恢复写权限之后仍然写不进去");
      const afterRecovery = await readArchive();
      if (afterRecovery.payload.archiveFault) {
        throw new Error(`归档恢复正常之后故障标记没清掉：${JSON.stringify(afterRecovery.payload.archiveFault)}`
          + " —— 只置不清的标记会让人以为一直在坏");
      }
    }

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
  // 【"这东西不存在"这条路必须被走过】。下面每个拒绝码原先都没有任何门/e2e 提到过 ——
  // 也就是说，把 `if (!x) return 404` 整行删掉，没有任何东西会变红，而那意味着后面的代码会
  // 拿着 undefined 往下跑（真实形态：读 x.status 直接把请求打成 500，或更糟，当成"没有约束"放行）。
  // 系统管理员看得见全局，所以这里期望的是真 404 而不是 403（非系统主体的不泄露存在性另有断言）。
  {
    const NOT_FOUND_ROUTES = [
      {method: "POST", path: "/api/execution-topologies/bogus_topology/advance", code: "execution_topology_not_found"},
      {method: "POST", path: "/api/quality-gates/bogus_gate/waive", code: "quality_gate_not_found"},
      {method: "POST", path: "/api/review-bundles/bogus_bundle/resolve", code: "review_bundle_not_found"},
      {method: "POST", path: "/api/review-plans/bogus_plan/resolve", code: "review_plan_not_found"},
      {method: "GET", path: "/api/work-sessions/bogus_session/execution-events", code: "work_session_not_found"},
      {method: "POST", path: "/api/access-grants/bogus_grant/revoke", code: "access_grant_not_found"},
      {method: "POST", path: "/api/agent-nodes/bogus_node/revoke", code: "agent_node_not_found"},
      {method: "POST", path: "/api/agents/bogus_agent/activate", code: "agent_not_found"},
      {method: "POST", path: "/api/orgs/bogus_org/quotas", code: "organization_not_found"},
      {method: "POST", path: "/api/org/members/bogus_member/permissions", code: "org_member_not_found"},
      {method: "POST", path: "/api/rule-source-resolutions/bogus_resolution/settle", code: "rule_source_resolution_not_found"},
      {method: "POST", path: "/api/system-upgrade-candidates/bogus_candidate/resolve", code: "system_upgrade_candidate_not_found"},
      {method: "POST", path: "/api/agent-join-tokens/bogus_join_token/revoke", code: "agent_join_token_not_found"}
    ];
    const wrong = [];
    for (const route of NOT_FOUND_ROUTES) {
      const probe = await jsonFetch(port, route.path, {
        method: route.method,
        headers: route.method === "GET"
          ? {authorization: systemAuth}
          : {"Idempotency-Key": `doctor-notfound-${route.code}`, authorization: systemAuth},
        body: route.method === "GET" ? undefined : JSON.stringify({reason: "e2e 探测不存在的 id"})
      });
      if (probe.response.status !== 404 || probe.payload?.error !== route.code) {
        wrong.push(`${route.method} ${route.path} → ${probe.response.status}/${probe.payload?.error}（应为 404/${route.code}）`);
      }
    }
    if (wrong.length) {
      throw new Error(`不存在的 id 没有得到该给的 404 拒绝码：\n    ${wrong.join("\n    ")}`);
    }
  }

  // 【"不存在"与"看不见"必须长得一样】。上面那批用系统管理员打，拿到的是真 404 —— 那是对的。
  // 但对【看不见这条记录】的人，404 与 403 的差别本身就是情报：把 id 挨个试一遍，就能数出别的
  // 租户有多少条记录、id 长什么样。本仓已按这条不变式修过项目与任务组两处；这里按【路由】把同
  // 形状的入口一次扫完 —— 只守一扇门等于没守，这是本仓反复撞到的形态。
  {
    // 造一个【别的租户的】加入令牌：不造的话这条路由永远没样本，探针就只能报"未检验"。
    const foreignJoinToken = await jsonFetch(port, "/api/agent-join-tokens", {
      method: "POST",
      headers: {"Idempotency-Key": "doctor-oracle-join-token", authorization: systemAuth},
      body: JSON.stringify({projectId: "prj_control_plane", roleId: "ui-console-engineer", ttlSeconds: 600})
    });
    if (foreignJoinToken.response.status !== 201) {
      throw new Error(`造不出外租户加入令牌（HTTP ${foreignJoinToken.response.status} `
        + `${JSON.stringify(foreignJoinToken.payload)}）—— 那条路由的存在性探针会一直空转`);
    }
    // 再把它兑成一个真实的运行节点：不注册的话 agent-nodes 那两条路由永远没样本。
    const foreignNode = await jsonFetch(port, "/api/agent/v1/register", {
      method: "POST",
      headers: {authorization: `Bearer ${foreignJoinToken.payload.joinToken}`},
      body: JSON.stringify({nodeName: "doctor-oracle-node", requestedRoles: ["agent-runtime"],
        runtimeVersion: "doctor", profile: {tools: [], models: [{providerClass: "custom", adapter: "doctor", available: true}]}})
    });
    if (foreignNode.response.status !== 201) {
      throw new Error(`造不出外租户运行节点（HTTP ${foreignNode.response.status} `
        + `${JSON.stringify(foreignNode.payload)}）—— agent-nodes 两条路由的存在性探针会一直空转`);
    }
    const wide = await jsonFetch(port, "/api/state?view=full&limit=200", {headers: {authorization: systemAuth}});
    if (!wide.response.ok) throw new Error("取不到系统侧全量视图 —— 存在性探针断言在空转");
    const mine = new Set([orgId, orgProject.payload.id, orgTaskGroup.payload.taskGroup.id]);
    // 归属可能挂在嵌套的 resource 上（访问授权就是），只看顶层字段会把自己的东西当成外租户的
    // —— 那样"越权成功"其实是"对自己的东西操作成功"，会读出一个假缺陷。
    const isForeign = (item) => ![item.organizationId, item.projectId, item.taskGroupId,
      item.resource?.resourceId, item.resourceId, item.scope?.resourceId]
      .some((ref) => ref && mine.has(ref));
    const pickWhy = {};
    const pick = (collection, idField) => {
      const all = wide.payload[collection] || [];
      const found = all.filter(isForeign).map((item) => item[idField]).find(Boolean);
      // 没探到时要说清是"集合本来就空"还是"全都归自己"——两者要补的夹具完全不同。
      if (!found) {
        // 三种情形要分开：集合为空 / 都归自己 / id 字段名写错了（第三种最容易把断言变成空转）。
        pickWhy[collection] = !all.length ? "集合为空"
          : all.some((item) => item[idField]) ? `${all.length} 条但都归本组织`
            : `${all.length} 条但没有一条有 ${idField} 字段 —— 取 id 的字段名写错了`;
      }
      return found;
    };
    const ORACLE_ROUTES = [
      {method: "POST", path: (id) => `/api/execution-topologies/${id}/advance`, id: pick("executionTopologies", "topologyId")},
      {method: "POST", path: (id) => `/api/agent-nodes/${id}/revoke`, id: pick("agentRuntimeNodes", "nodeId")},
      {method: "POST", path: (id) => `/api/agent-nodes/${id}/control`, id: pick("agentRuntimeNodes", "nodeId")},
      {method: "POST", path: (id) => `/api/task-groups/${id}/control`, id: pick("taskGroups", "id")},
      {method: "POST", path: (id) => `/api/agents/${id}/activate`, id: pick("agents", "id")},
      {method: "POST", path: (id) => `/api/access-grants/${id}/revoke`, id: pick("accessGrants", "grantId")},
      {method: "POST", path: (id) => `/api/agent-join-tokens/${id}/revoke`, id: pick("agentJoinTokens", "joinTokenId")},
      {method: "GET", path: (id) => `/api/agent-dispatches/${id}/events`, id: pick("agentDispatches", "dispatchId")},
      {method: "GET", path: (id) => `/api/task-groups/${id}/execution-events`, id: pick("taskGroups", "id")},
      {method: "GET", path: (id) => `/api/work-sessions/${id}/execution-events`, id: pick("workSessions", "sessionId")},
      {method: "GET", path: (id) => `/api/task-groups/${id}/progress`, id: pick("taskGroups", "id")},
      {method: "GET", path: (id) => `/api/task-groups/${id}/config`, id: pick("taskGroups", "id")},
      {method: "POST", path: (id) => `/api/task-groups/${id}/work-items`, id: pick("taskGroups", "id")},
      {method: "POST", path: (id) => `/api/task-groups/${id}/language-policy`, id: pick("taskGroups", "id")},
      {method: "POST", path: (id) => `/api/task-groups/${id}/config`, id: pick("taskGroups", "id")},
      {method: "POST", path: (id) => `/api/task-groups/${id}/config/reset`, id: pick("taskGroups", "id")}
    ];
    const leaks = [];
    const unprobed = [];
    for (const [index, route] of ORACLE_ROUTES.entries()) {
      if (!route.id) { unprobed.push(route.path("<无外租户样本>")); continue; }
      const hit = async (id) => jsonFetch(port, route.path(id), {
        method: route.method,
        headers: route.method === "GET"
          ? {authorization: orgAdminAuth}
          : {"Idempotency-Key": `doctor-oracle-${index}-${id}`, authorization: orgAdminAuth},
        body: route.method === "GET" ? undefined : JSON.stringify({action: "pause", reason: "e2e 存在性探测"})
      });
      const [exists, missing] = [await hit(route.id), await hit(`bogus_oracle_${index}`)];
      // 2xx 比"可分辨"严重一个量级：那不是泄露存在性，是真的动到了别人的东西。分开报，
      // 否则真出这种事时，人读到的会是一条讲情报泄露的话。
      if (exists.response.status < 400) {
        leaks.push(`${route.method} ${route.path("<id>")}：对【别的租户的】记录返回了 ${exists.response.status}`
          + " —— 越权写入成功，不是泄露存在性");
      } else if (exists.response.status !== missing.response.status || exists.payload?.error !== missing.payload?.error) {
        leaks.push(`${route.method} ${route.path("<id>")}：真实外租户 id → ${exists.response.status}/${exists.payload?.error}，`
          + `编造的 id → ${missing.response.status}/${missing.payload?.error}`);
      }
    }
    // 没有外租户样本的那几条不能算过：说出来，别让它看起来像验过了。
    if (unprobed.length) {
      console.log(`  --  ${unprobed.length} 条路由这一轮没有外租户样本，存在性探针未检验：${unprobed.join("、")}`
        + `（原因：${Object.entries(pickWhy).map(([k, v]) => `${k} ${v}`).join("；")}）`);
    }
    if (leaks.length) {
      throw new Error("越租户探测能分辨\"存在\"和\"不存在\"：\n    " + leaks.join("\n    ")
        + "\n  —— 把 id 挨个试一遍就能数出别的租户有多少条记录");
    }
    if (ORACLE_ROUTES.length - unprobed.length < 5) {
      throw new Error(`只探到 ${ORACLE_ROUTES.length - unprobed.length} 条路由 —— 夹具太干净，这条断言在空转`);
    }
  }

  // 【守卫的作用域必须来自"要改的那条记录"，不能来自调用方给的参数】。
  // 否则就是典型的 confused deputy：我对自己的任务组有权 → 我在请求体里写自己的任务组 →
  // 守卫按我的组放行 → 实际被改的是 URL 上那条【别人的】记录。
  // findings 那条路由的注释里已经写死了这个口径，这里逐个路由压一遍，别只守一扇门。
  {
    const wideView = await jsonFetch(port, "/api/state?view=full&limit=200", {headers: {authorization: systemAuth}});
    const ownIds = new Set([orgId, orgProject.payload.id, orgTaskGroup.payload.taskGroup.id]);
    const foreignWorkItem = (wideView.payload.taskGroups || [])
      .filter((group) => !ownIds.has(group.id))
      .flatMap((group) => (group.workItems || []).map((item) => ({groupId: group.id, itemId: item.id})))[0];
    if (!foreignWorkItem) {
      throw new Error("没有外租户的工作项可用于越权探测 —— 这条断言会空转");
    }
    const stolen = await jsonFetch(port, `/api/work-items/${foreignWorkItem.itemId}/assign`, {
      method: "POST",
      headers: {"Idempotency-Key": "doctor-confused-deputy", authorization: orgAdminAuth},
      // 请求体里写【自己的】任务组：守卫若按它判权，就会放行一次对别人记录的改写。
      body: JSON.stringify({taskGroupId: orgTaskGroup.payload.taskGroup.id, assigneeRef: "acct_agent_runtime"})
    });
    // 必须是【守卫】把它拒掉（policy_denied），不能只靠 core 的查找过滤兜住 ——
    // 后者是 mutator 的实现细节，一次自然的重构就会把它改没。
    if (stolen.payload?.error !== "policy_denied") {
      throw new Error(`越权改别的租户的工作项，拒它的不是守卫而是别的东西`
        + `（HTTP ${stolen.response.status}/${stolen.payload?.error}）—— 防线压在 mutator 上，重构一次就没了`);
    }
    if (stolen.response.status < 400) {
      throw new Error(`在请求体里写上自己的任务组，就改掉了别的租户的工作项`
        + `（${foreignWorkItem.groupId}/${foreignWorkItem.itemId}，HTTP ${stolen.response.status}）`
        + " —— 守卫按调用方给的参数判权，实际改的是 URL 上那一条");
    }
  }

  // 【按内容指纹合并的记录也要分租户】。运行问题模式是按 issueFingerprint 找的 ——
  // 如果那次查找不看归属，别的租户只要报一个同样的指纹，就会被并进我这条模式里：
  // 计数被改、样本被塞进来，回执里还会把我这条模式的内容原样带回去。
  {
    const fingerprint = "e2e-cross-tenant-fp";
    const submit = (auth, taskGroupId, key) => jsonFetch(port, "/api/runtime-issues", {
      method: "POST",
      headers: {"Idempotency-Key": key, authorization: auth},
      body: JSON.stringify({taskGroupId, issueFingerprint: fingerprint,
        issueClass: "repeated_failure_fingerprint", summary: "e2e 指纹合并探测", forcePattern: true})
    });
    const seeded = await submit(systemAuth, "tg_runtime_management", "doctor-fp-seed");
    const seededId = seeded.payload?.patternId || seeded.payload?.pattern?.patternId;
    if (!seededId) {
      throw new Error(`造不出外租户的运行问题模式（HTTP ${seeded.response.status} `
        + `${JSON.stringify(seeded.payload).slice(0, 140)}）—— 这条断言会空转`);
    }
    const merged = await submit(orgAdminAuth, orgTaskGroup.payload.taskGroup.id, "doctor-fp-merge");
    const mergedId = merged.payload?.patternId || merged.payload?.pattern?.patternId;
    if (mergedId === seededId) {
      throw new Error(`别的租户报一个相同的 issueFingerprint，就被并进了 ${seededId} 这条模式`
        + " —— 按内容指纹查找时没有分租户，计数与样本会被外人改写，回执还把内容带了出去");
    }
    // 正面对照：同一个租户再报一次同样的指纹，必须还是并进原来那条 ——
    // 否则上面那条可以靠"一律不合并"蒙混过去，而按指纹归并正是这个特性的全部意义。
    const sameTenantAgain = await submit(systemAuth, "tg_runtime_management", "doctor-fp-again");
    const againId = sameTenantAgain.payload?.patternId || sameTenantAgain.payload?.pattern?.patternId;
    if (againId !== seededId) {
      throw new Error(`同一个租户再报同样的指纹却另起了一条模式（${againId} ≠ ${seededId}）`
        + " —— 按指纹归并被一起堵死了，同一个问题会散成很多条，人根本看不出它反复出现");
    }
  }

  // 【按 id 取记录的读路由，不能把别的租户的内容发出来】。写路径已经按"不存在≠看不见"扫过；
  // 读路径是另一件事：回 200 并附上内容，才是真的把数据交出去了。这里按【路由】枚举，
  // 拿外租户的真实 id 去读，任何 2xx 都算漏（回执里有没有敏感字段是另一回事，先卡住"能不能读到"）。
  {
    const wideRead = await jsonFetch(port, "/api/state?view=full&limit=200", {headers: {authorization: systemAuth}});
    const ownIds = new Set([orgId, orgProject.payload.id, orgTaskGroup.payload.taskGroup.id]);
    const foreignGroup = (wideRead.payload.taskGroups || []).find((item) => !ownIds.has(item.id));
    const foreignProject = (wideRead.payload.projects || []).find((item) => !ownIds.has(item.id));
    const foreignSession = (wideRead.payload.workSessions || [])
      .find((item) => item.taskGroupId && !ownIds.has(item.taskGroupId));
    const foreignDispatch = (wideRead.payload.agentDispatches || [])
      .find((item) => item.taskGroupId && !ownIds.has(item.taskGroupId));
    const READ_ROUTES = [
      {path: foreignGroup && `/api/task-groups/${foreignGroup.id}/readiness`, what: "任务组完成度"},
      {path: foreignGroup && `/api/task-groups/${foreignGroup.id}/progress`, what: "任务组进度"},
      {path: foreignGroup && `/api/task-groups/${foreignGroup.id}/execution-events`, what: "任务组执行事件"},
      {path: foreignGroup && `/api/task-groups/${foreignGroup.id}/human-confirmations`, what: "任务组人工确认"},
      {path: foreignGroup && `/api/task-groups/${foreignGroup.id}/human-directives`, what: "任务组人工指令"},
      {path: foreignGroup && `/api/task-groups/${foreignGroup.id}/config`, what: "任务组配置"},
      {path: foreignProject && `/api/projects/${foreignProject.id}/progress`, what: "项目进度"},
      {path: foreignProject && `/api/projects/${foreignProject.id}/config`, what: "项目配置"},
      {path: foreignSession && `/api/work-sessions/${foreignSession.sessionId}/execution-events`, what: "工作会话执行事件"},
      {path: foreignDispatch && `/api/agent-dispatches/${foreignDispatch.dispatchId}/events`, what: "派发事件"}
    ];
    const leaked = [];
    const unprobed = [];
    for (const route of READ_ROUTES) {
      if (!route.path) { unprobed.push(route.what); continue; }
      const read = await jsonFetch(port, route.path, {headers: {authorization: orgAdminAuth}});
      if (read.response.status < 400) {
        leaked.push(`${route.what} ${route.path} → HTTP ${read.response.status}，`
          + `回执 ${JSON.stringify(read.payload).slice(0, 90)}`);
      }
    }
    if (unprobed.length) {
      console.log(`  --  ${unprobed.length} 条读路由这一轮没有外租户样本，未检验：${unprobed.join("、")}`);
    }
    if (leaked.length) {
      throw new Error("组织管理员读到了别的租户的内容：\n    " + leaked.join("\n    ")
        + "\n  —— 写路径守住了，读路径把同一份数据发了出去");
    }
    if (READ_ROUTES.length - unprobed.length < 6) {
      throw new Error(`只探到 ${READ_ROUTES.length - unprobed.length} 条读路由 —— 夹具太干净，这条断言在空转`);
    }
  }

  // 【写完立刻读，必须看得见自己刚写的东西】。/api/state 有一层 60 秒的视图缓存，
  // 键里带着 stateVersion —— 一旦它从键里掉出去（实测：把它删掉，整套 e2e 一条都不红），
  // 人建完任务组刷新页面，最多一分钟内看到的还是旧的那份，而屏幕上没有任何异样。
  // 缓存必须由"它失效条件被破坏时会出现的可观察故障"来守，不能只由"它存在"来守。
  {
    const readAll = () => jsonFetch(port, "/api/state?view=full&limit=200", {headers: {authorization: systemAuth}});
    const before = await readAll();
    const beforeCount = (before.payload.taskGroups || []).length;
    const created = await jsonFetch(port, "/api/task-groups", {
      method: "POST",
      headers: {"Idempotency-Key": "doctor-cache-freshness", authorization: systemAuth},
      body: JSON.stringify({projectId: "prj_control_plane", title: "缓存新鲜度探针"})
    });
    if (created.response.status !== 201) {
      throw new Error(`造不出任务组用于缓存新鲜度检验（HTTP ${created.response.status}）`);
    }
    const newId = created.payload.taskGroup.id;
    const after = await readAll();
    const visible = (after.payload.taskGroups || []).some((item) => item.id === newId);
    if (!visible) {
      throw new Error(`刚建的任务组 ${newId} 在紧接着的一次 /api/state 里看不到`
        + `（前 ${beforeCount} 条、后 ${(after.payload.taskGroups || []).length} 条）`
        + " —— 视图缓存的失效条件坏了，人刷新页面最多一分钟内都看不到自己刚做的事");
    }
  }

  // 【人叫停之后，agent 的上报不许把这个决定抹掉】。控制面把派发置成 blocked 并写明是谁停的
  // （createAgentControlCommand 下发 pause_dispatch 时就置了），这时节点若报一条 failed，
  // 原先会直接 `dispatch.status = reportedStatus` 推进终态：人的动作从屏幕上消失，
  // 而且终态再也 resume 不回来（resume 只认 blocked）。旧执行器、outbox 重放都会走到这里 ——
  // 靠调用方自觉不算 fence。实测：把这道判据去掉，整条快速链一个门都不红。
  {
    const haltJoin = await jsonFetch(port, "/api/agent-join-tokens", {
      method: "POST",
      headers: {"Idempotency-Key": "doctor-halt-join", authorization: systemAuth},
      body: JSON.stringify({projectId: "prj_control_plane", allowedRoles: ["monitor"], ttlSeconds: 600})
    });
    const haltNode = await jsonFetch(port, "/api/agent/v1/register", {
      method: "POST",
      headers: {authorization: `Bearer ${haltJoin.payload?.joinToken}`},
      body: JSON.stringify({nodeName: "doctor-halt-node", requestedRoles: ["monitor"],
        runtimeVersion: "doctor", profile: {tools: [], models: [{providerClass: "custom", adapter: "doctor", available: true}]}})
    });
    if (haltNode.response.status !== 201) {
      throw new Error(`造不出用于「人叫停后 agent 不得覆盖」的节点（HTTP ${haltNode.response.status} `
        + `${JSON.stringify(haltNode.payload).slice(0, 120)}）`);
    }
    const haltNodeAuth = `Bearer ${haltNode.payload.nodeToken}`;
    // 不自检就领不到活（admission 停在 read_only）—— 六项必检全绿才算入网。
    await jsonFetch(port, "/api/agent/v1/self-check", {
      method: "POST", headers: {authorization: haltNodeAuth},
      body: JSON.stringify({runtimeVersion: "doctor", checks: [
        {checkId: "runtime", status: "ok", detail: "doctor"},
        {checkId: "gateway", status: "ok", detail: "doctor"},
        {checkId: "filesystem", status: "ok", detail: "doctor"},
        {checkId: "git", status: "ok", detail: "doctor"},
        {checkId: "remote_mcp", status: "ok", detail: "doctor"},
        {checkId: "model_executor", status: "ok", detail: "custom:doctor:available"}
      ]})
    });
    const claimed = await jsonFetch(port, "/api/agent/v1/dispatches/next", {
      method: "POST", headers: {authorization: haltNodeAuth}, body: JSON.stringify({})
    });
    // 认领回执是个信封：派发在 .dispatch 里，而 .dispatch 本身可能又套一层（实测两种都见过）。
    const envelope = claimed.payload?.dispatch;
    const claimedDispatch = envelope?.dispatchId ? envelope : envelope?.dispatch;
    if (!claimedDispatch) {
      console.log(`  --  这个节点这一轮领不到派发（${JSON.stringify(claimed.payload).slice(0, 90)}），`
        + "「人叫停后 agent 不得覆盖」未被检验");
    } else {
      const groupId = claimedDispatch.taskGroupId;
      const pauseIt = await jsonFetch(port, `/api/task-groups/${groupId}/control`, {
        method: "POST",
        headers: {"Idempotency-Key": "doctor-halt-pause", authorization: systemAuth},
        body: JSON.stringify({action: "pause"})
      });
      if (pauseIt.response.status !== 200) {
        throw new Error(`暂停任务组失败：HTTP ${pauseIt.response.status}（groupId=${groupId}）`);
      }
      const afterHalt = await jsonFetch(port, "/api/state", {headers: {authorization: systemAuth}});
      const halted = (afterHalt.payload.agentDispatches || [])
        .find((item) => item.dispatchId === claimedDispatch.dispatchId);
      if (halted?.status !== "blocked") {
        throw new Error(`人暂停之后这个派发不是 blocked（${halted?.status}）—— 下面那条断言会打在别的分支上`);
      }
      const failAfterHalt = await jsonFetch(port, `/api/agent/v1/dispatches/${claimedDispatch.dispatchId}/fail`, {
        method: "POST",
        headers: {authorization: haltNodeAuth},
        body: JSON.stringify({status: "failed", reason: "执行器自己报的失败", claimEpoch: Number(halted.claimEpoch || 0)})
      });
      if (failAfterHalt.response.status !== 409
        || failAfterHalt.payload?.error !== "dispatch_halted_by_human_control") {
        throw new Error(`人已叫停的派发接受了 agent 的失败上报`
          + `（HTTP ${failAfterHalt.response.status}/${failAfterHalt.payload?.error}）`
          + " —— 人的暂停被机器改写成失败，屏幕上看不出是谁停的，而且终态再也恢复不回来");
      }
      await jsonFetch(port, `/api/task-groups/${groupId}/control`, {
        method: "POST",
        headers: {"Idempotency-Key": "doctor-halt-resume", authorization: systemAuth},
        body: JSON.stringify({action: "resume"})
      });
    }
  }

  // 【停用必须叫停在跑的执行】。此前只有契约门里一条同名检查，测的是它自己写的一段模拟，
  // 产品路径怎么退化都不会红。这里走真实 HTTP：对一个确实有派发的任务组下暂停，之后该组下
  // 不得再有在跑的派发 —— 否则 agent 会跑到底、把产出推上 git、把额度烧完，而控制台上写着"已暂停"。
  // 放在收尾处：它会把该任务组的执行真的停掉，中间插入会拖垮后面的断言。
  {
    const before = await jsonFetch(port, "/api/state", {headers: {authorization: systemAuth}});
    const live = (before.payload.agentDispatches || []).filter((item) =>
      item.taskGroupId === "tg_runtime_management" && !["completed", "failed", "cancelled"].includes(item.status));
    if (!live.length) {
      throw new Error("收尾时 tg_runtime_management 下没有未终结的派发 —— 这一条断言会空转，"
        + "等于没验过\"停用叫停在跑的执行\"；请改挂到确有派发的任务组上");
    }
    const paused = await jsonFetch(port, "/api/task-groups/tg_runtime_management/control", {
      method: "POST",
      headers: {"Idempotency-Key": "doctor-suspend-halts", authorization: systemAuth},
      body: JSON.stringify({action: "pause"})
    });
    if (paused.response.status !== 200) {
      throw new Error(`真人暂停任务组失败：HTTP ${paused.response.status} ${JSON.stringify(paused.payload)}`);
    }
    const after = await jsonFetch(port, "/api/state", {headers: {authorization: systemAuth}});
    // 每一个原先未终结的派发都必须被处置：跑在节点上的那种要收到 pause_dispatch（否则节点上的
    // 进程不知道自己该停），还没落到节点的那种直接改成 blocked。漏掉任何一个，"已暂停"就是假的。
    const stopCommands = (after.payload.agentControlCommands || []).filter((item) =>
      item.taskGroupId === "tg_runtime_management" && item.commandType === "pause_dispatch");
    const commanded = new Set(stopCommands.map((item) => item.dispatchId));
    const untouched = live.filter((item) => {
      if (commanded.has(item.dispatchId)) return false;
      const nowState = (after.payload.agentDispatches || []).find((row) => row.dispatchId === item.dispatchId);
      return nowState?.status !== "blocked";
    });
    if (untouched.length) {
      throw new Error(`暂停之后有 ${untouched.length} 个派发既没收到 pause_dispatch、也没被改成 blocked`
        + `（${untouched.map((item) => `${item.dispatchId}:${item.status}`).join(",")}）——`
        + " 控制台上写着已暂停，而它们照跑");
    }
    if (!stopCommands.length) {
      console.log("  --  这一轮没有落到节点上的派发，pause_dispatch 那一支未被检验（其余派发已确认转为 blocked）");
    }
  }

} finally {
  // 【登录限流】。防爆破的实控件，而它一个断言都没有 —— 失效时所有正常登录照旧成功，
  // 只有"猜口令"这件事变得没有代价，屏幕上不会有任何异样。
  // 这一段【必须放在最后】：打满之后本机 IP 会被挡一分钟，放在中间会把后面所有登录一起拖垮。
  {
    const attempts = [];
    for (let index = 0; index < 12; index += 1) {
      attempts.push(await jsonFetch(port, "/api/auth/login", {
        method: "POST", body: JSON.stringify({email: "system.admin@local", token: `wrong-${index}`})
      }));
    }
    const limited = attempts.find((attempt) => attempt.response.status === 429);
    if (!limited) {
      throw new Error(`连续 12 次错误登录都没被限流（状态码：${attempts.map((a) => a.response.status).join(",")}）`
        + " —— 口令空间可以随便爆破");
    }
    if (limited.payload.error !== "too_many_login_attempts" || !limited.payload.retryAfterSeconds) {
      throw new Error(`限流的报文没说清是限流、也没说多久之后能再试：${JSON.stringify(limited.payload)}`);
    }
    // 被限流期间，【正确】的凭据同样要被挡住 —— 否则限流只挡错口令，爆破者一旦猜中就能立刻进。
    const correctWhileLimited = await jsonFetch(port, "/api/auth/login", {
      method: "POST", body: JSON.stringify({email: "system.admin@local", token: "doctor-bootstrap-token"})
    });
    if (correctWhileLimited.response.status !== 429) {
      throw new Error(`限流期间正确凭据仍然放行（HTTP ${correctWhileLimited.response.status}）——`
        + "那样限流只是拖慢猜测，猜中的那一次照样成功");
    }
  }

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
    // 无上限地等子进程退出 = 它一旦不理 SIGTERM，整个 e2e 就挂在这里，最后死于一句
    // "Detected unsettled top-level await"，看不出是谁没退出、也跑不到后面的检查
    // （并发跑变异门时实测撞到过，靠肉眼读那句警告才定位）。改成：先礼后兵，还不走就明说。
    tickChild.kill("SIGTERM");
    const exited = await Promise.race([
      new Promise((resolve) => tickChild.on("exit", () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 10000))
    ]);
    if (!exited) {
      tickChild.kill("SIGKILL");
      const killed = await Promise.race([
        new Promise((resolve) => tickChild.on("exit", () => resolve(true))),
        new Promise((resolve) => setTimeout(() => resolve(false), 5000))
      ]);
      if (!killed) throw new Error("后台自治周期的子进程 SIGTERM 与 SIGKILL 都不退出 —— 它多半卡在磁盘或子进程上");
      console.log("  --  后台自治周期的子进程没有响应 SIGTERM，已强制结束（10 秒内未退出）");
    }
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
if (UNNAMED_REFUSALS.length > UNNAMED_REFUSAL_CEILING) {
  throw new Error(`只判状态码不判拒绝码的 4xx 断言从 ${UNNAMED_REFUSAL_CEILING} 涨到 ${UNNAMED_REFUSALS.length}`
    + " —— 新加的断言没点名拒绝码，守卫串位时它照样绿");
}
if (process.env.AIMAC_LIST_UNNAMED_REFUSALS) {
  console.log(`没点名拒绝码的 4xx 断言 ${UNNAMED_REFUSALS.length} 条（实测到的码已附上，照抄进第四个参数）：\n  `
    + UNNAMED_REFUSALS.join("\n  "));
}
console.log(`拒绝码点名：${UNNAMED_REFUSALS.length} 条 4xx 断言只判了状态码`
  + `（棘轮 ${UNNAMED_REFUSAL_CEILING}，只降不升；AIMAC_LIST_UNNAMED_REFUSALS=1 可列出清单与实测码）`);

console.log(`控制面 e2e 产出规范核对 ok: ${doctorSweep.validated} 条记录符合各自声明的 schema（含人工确认与定稿记录）；${doctorSweep.uncoveredNote}`);

// 【明文机密不许落盘】。一次性令牌按设计只在签发那一刻回给调用方一次；如果它同时被写进了
// 状态、幂等记录或审计归档，那就等于永久留在磁盘上 —— 而状态文件会随 view=full 出去、
// 归档是给人查的、幂等记录会在重放时被原样回放。这一类咬过一次（幂等记录存明文令牌）。
// 判据【用本轮真发出去的那几个令牌】去搜，不是搜一个泛化的形状：
// 后者在文件里本来就搜不到东西，断言会安静地空转。
{
  const issuedSecrets = issuedPlaintextSecrets
    .filter(([, secret]) => typeof secret === "string" && secret.length > 20);
  if (issuedSecrets.length < 2) {
    throw new Error(`明文机密核对：这一轮只拿到 ${issuedSecrets.length} 个真实令牌 —— 夹具没触达，本条在空转`);
  }
  const scanned = [];
  for (const name of ["control-plane-state.json", "audit-log.jsonl", "mcp-audit.jsonl"]) {
    const path = join(root, doctorRuntimeDir, name);
    if (!existsSync(path)) continue;
    scanned.push(name);
    const raw = readFileSync(path, "utf8");
    for (const [label, secret] of issuedSecrets) {
      if (raw.includes(secret)) {
        throw new Error(`${name} 里存着明文的${label} —— 一次性凭据只该出现在签发那一次的响应里，`
          + "落盘之后它就永久可读了（状态会随 view=full 出去、归档是给人查的）");
      }
    }
  }
  const shardDir = join(root, doctorRuntimeDir, "project-db");
  if (existsSync(shardDir)) {
    for (const name of readdirSync(shardDir).filter((item) => item.endsWith(".state.json"))) {
      scanned.push(`project-db/${name}`);
      const raw = readFileSync(join(shardDir, name), "utf8");
      for (const [label, secret] of issuedSecrets) {
        if (raw.includes(secret)) throw new Error(`项目分片 ${name} 里存着明文的${label}`);
      }
    }
  }
  console.log(`明文机密核对 ok: ${issuedSecrets.length} 个本轮真实签发的令牌，`
    + `在 ${scanned.length} 份落盘文件里一个都搜不到（只存摘要）`);
}

// 同上：主服务被 SIGTERM 之后若不退出，整套 e2e 就挂死在最后一行 —— 前面所有断言都跑完了，
// 人看到的却只有一句 unsettled top-level await。给它上限，超时就强杀并明说。
const exitRace = await Promise.race([
  exitPromise.then((pair) => ({pair})),
  new Promise((resolve) => setTimeout(() => resolve({timedOut: true}), 15000))
]);
if (exitRace.timedOut) {
  child.kill("SIGKILL");
  console.log("  --  控制面服务收到 SIGTERM 后 15 秒未退出，已强制结束（断言均已跑完）");
}
const [code, signal] = exitRace.pair || [null, "SIGKILL"];
try { rmSync(doctorRepo.base, {recursive: true, force: true}); } catch {}
if (!process.env.AIMAC_DOCTOR_RUNTIME_DIR) { try { rmSync(join(root, doctorRuntimeDir), {recursive: true, force: true}); } catch {} }
if (code && signal !== "SIGTERM") {
  throw new Error(`doctor server exited with ${code}: ${stderr}`);
}
