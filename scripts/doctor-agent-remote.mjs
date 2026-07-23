import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(new URL("..", import.meta.url).pathname);
const sandbox = mkdtempSync(join(tmpdir(), "aimac-agent-doctor-"));
const runtimeDir = join(sandbox, "server-runtime");
const agentWorkDir = join(sandbox, "agent-work");
const verifiedCommandWorkDir = join(sandbox, "verified-command-agent-work");
const remote = join(sandbox, "remote.git");
const source = join(sandbox, "source");
const executor = join(sandbox, "doctor-agent-executor.mjs");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

setupRepository();
writeFileSync(executor, `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const input = JSON.parse(readFileSync(0, "utf8"));
const outputPath = \`docs/agent-runtime-output/\${input.taskGroupId}/\${input.workId}.md\`;
mkdirSync(join(input.repositoryRoot, dirname(outputPath)), {recursive: true});
writeFileSync(join(input.repositoryRoot, outputPath), [
  \`# \${input.workId}\`,
  "",
  \`Role skill: \${input.roleSkill.roleSkillRef}\`,
  \`Skill workset: \${input.skillWorksetDir}\`,
  \`Remote MCP: \${input.remoteMcp.url}\`,
  ""
].join("\\n"));
console.log(JSON.stringify({summary: "Remote Agent Runtime executed the assigned model task with a server-issued skill workset.", verificationRefs: ["doctor:executor-ok"]}));
`);

const server = spawn(process.execPath, ["apps/control-plane-ui/server.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    AIMAC_HOST: "127.0.0.1",
    AIMAC_PORT: String(port),
    AIMAC_PUBLIC_URL: baseUrl,
    AIMAC_RUNTIME_DIR: runtimeDir,
    AIMAC_REPOSITORY_ROOT: source,
    AIMAC_EXECUTION_PROFILE: "production",
    AIMAC_STATE_STORE: "runtime_json",
    AIMAC_BOOTSTRAP_TOKEN: "doctor-bootstrap-token",
    AIMAC_MCP_SERVICE_TOKEN: "doctor-mcp-service-token",
    DATABASE_URL: ""
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let stderr = "";
server.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

try {
  await waitForHealth();
  const installer = await fetch(`${baseUrl}/install-agent.sh`);
  const installerChecksum = await fetch(`${baseUrl}/install-agent.sh.sha256`);
  const runtimeArtifact = await fetch(`${baseUrl}/agent-runtime.mjs`);
  if (!installer.ok || !installerChecksum.ok || !runtimeArtifact.ok) throw new Error("server did not publish Agent bootstrap artifacts");
  const installerText = await installer.text();
  if (!installerText.includes(baseUrl) || installerText.includes("__AIMAC_SERVER_URL__")) throw new Error("Agent installer was not bound to the public server URL");

  const login = await json("/api/auth/login", {method: "POST", body: {email: "system.admin@local", token: "doctor-bootstrap-token"}});
  const joinResult = await json("/api/agent-join-tokens", {
    method: "POST",
    token: login.sessionToken,
    idempotencyKey: "doctor-agent-join-token",
    body: {projectId: "prj_control_plane", nodeName: "doctor-node", allowedRoles: ["*"], ttlSeconds: 1800, maxUses: 1}
  });
  if (!joinResult.installCommand.includes(`${baseUrl}/install-agent.sh`)) throw new Error("join token did not produce a server-hosted install command");
  if (joinResult.installCommand.includes("--join-token ") || !joinResult.installCommand.includes("--join-token-file")) throw new Error("join token install command exposed token in argv");
  if (!joinResult.verifiedInstallCommand.includes("( if command -v sha256sum") || !joinResult.verifiedInstallCommand.includes("elif command -v shasum")) throw new Error("join token did not produce a portable checksum-verified install command");

  const noExecutorJoin = await json("/api/agent-join-tokens", {
    method: "POST",
    token: login.sessionToken,
    idempotencyKey: "doctor-agent-no-executor-token",
    body: {projectId: "prj_control_plane", nodeName: "no-executor-node", allowedRoles: ["*"], ttlSeconds: 1800, maxUses: 1}
  });
  const noExecutorRegistration = await json("/api/agent/v1/register", {
    method: "POST",
    token: noExecutorJoin.joinToken,
    body: {nodeName: "no-executor-node", requestedRoles: ["*"], runtimeVersion: "doctor", profile: {tools: [], models: [{providerClass: "custom", adapter: "unconfigured", available: false}]}}
  });
  const noExecutorSelfCheck = await jsonRaw("/api/agent/v1/self-check", {
    method: "POST",
    token: noExecutorRegistration.nodeToken,
    body: {checks: okSelfChecks(baseUrl, {modelExecutor: false}), runtimeVersion: "doctor"}
  });
  if (noExecutorSelfCheck.response.status !== 409 || noExecutorSelfCheck.payload.admission !== "read_only" || !noExecutorSelfCheck.payload.missingChecks?.includes("model_executor")) {
    throw new Error(`agent without model executor was not rejected from full admission: ${noExecutorSelfCheck.response.status}`);
  }
  const noExecutorClaim = await json("/api/agent/v1/dispatches/next", {method: "POST", token: noExecutorRegistration.nodeToken, body: {claimTtlSeconds: 900}});
  if (noExecutorClaim.dispatch || noExecutorClaim.reason !== "node_not_admitted") throw new Error("agent without model executor was allowed to claim dispatch");

  const verifiedJoinResult = await json("/api/agent-join-tokens", {
    method: "POST",
    token: login.sessionToken,
    idempotencyKey: "doctor-agent-verified-install-token",
    body: {projectId: "prj_control_plane", nodeName: "verified-command-node", allowedRoles: ["*"], ttlSeconds: 1800, maxUses: 1}
  });
  const verifiedInstall = spawnSync("sh", ["-c", verifiedJoinResult.verifiedInstallCommand], {
    cwd: sandbox,
    env: {
      ...process.env,
      AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true",
      AIMAC_AGENT_CONFIGURE_CLIENTS: "false",
      AIMAC_AGENT_NODE_NAME: "verified-command-node",
      AIMAC_AGENT_WORK_DIR: verifiedCommandWorkDir,
      AIMAC_AGENT_EXECUTOR_COMMAND: `node ${JSON.stringify(executor)}`
    },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  stopAgentDaemon(verifiedCommandWorkDir);
  if (verifiedInstall.status !== 0 || !verifiedInstall.stdout.includes("AGENT_JOINED") || !verifiedInstall.stdout.includes("AGENT_RUNTIME_STARTED")) {
    throw new Error(`checksum-verified Agent install command failed: ${verifiedInstall.stderr || verifiedInstall.stdout}`);
  }
  assertAgentScopedMcpConfig(verifiedCommandWorkDir, baseUrl);

  const joinTokenFile = join(sandbox, "doctor.join");
  writeFileSync(joinTokenFile, joinResult.joinToken, {mode: 0o600});
  const install = spawnSync("sh", ["-s", "--", "--server", baseUrl, "--join-token-file", joinTokenFile, "--node-name", "doctor-node", "--work-dir", agentWorkDir, "--no-daemon", "--no-configure-clients", "--executor-command", `node ${JSON.stringify(executor)}`], {
    cwd: sandbox,
    input: installerText,
    env: {...process.env, AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true", AIMAC_AGENT_CONFIGURE_CLIENTS: "false"},
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  if (install.status !== 0 || !install.stdout.includes("AGENT_JOINED") || !install.stdout.includes(`remoteMcp=${baseUrl}/mcp`)) throw new Error(`Agent one-command bootstrap failed: ${install.stderr || install.stdout}`);
  assertAgentScopedMcpConfig(agentWorkDir, baseUrl);

  const agentConfigPath = join(agentWorkDir, "agent-config.json");
  const agentConfig = JSON.parse(readFileSync(agentConfigPath, "utf8"));
  const runtimePath = join(agentWorkDir, "bin", "aimac-agent-runtime.mjs");
  if (!existsSync(runtimePath)) throw new Error("Agent Runtime artifact was not installed");
  forceNodeCredentialNearExpiry(agentConfig.nodeId);
  const rotationRun = spawnSync(process.execPath, [runtimePath, "run", "--work-dir", agentWorkDir, "--once"], {
    env: {...process.env, AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true", AIMAC_AGENT_CONFIGURE_CLIENTS: "false"},
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  if (rotationRun.status !== 0) throw new Error(`Agent Runtime credential rotation run failed: ${rotationRun.stderr || rotationRun.stdout}`);
  const rotatedAgentConfig = JSON.parse(readFileSync(agentConfigPath, "utf8"));
  if (rotatedAgentConfig.nodeToken === agentConfig.nodeToken) throw new Error("Agent Runtime did not persist a rotated node credential");
  const previousCredentialProbe = await jsonRaw("/api/agent/v1/nodes/me", {token: agentConfig.nodeToken});
  const currentCredentialProbe = await jsonRaw("/api/agent/v1/nodes/me", {token: rotatedAgentConfig.nodeToken});
  if (!previousCredentialProbe.response.ok || !currentCredentialProbe.response.ok) throw new Error("Agent Gateway did not accept both previous and current credentials during rotation overlap");
  const previousHeartbeat = await jsonRaw("/api/agent/v1/heartbeat", {method: "POST", token: agentConfig.nodeToken, body: {profile: {tools: [], models: [{providerClass: "custom", adapter: "doctor", available: true}]}}});
  const currentAfterPreviousHeartbeat = await jsonRaw("/api/agent/v1/nodes/me", {token: rotatedAgentConfig.nodeToken});
  if (!previousHeartbeat.response.ok || !currentAfterPreviousHeartbeat.response.ok) throw new Error("Agent heartbeat with previous credential invalidated the current credential");
  assertAgentScopedMcpConfig(agentWorkDir, baseUrl, rotatedAgentConfig.nodeToken);

  await json(`/api/agent-nodes/${agentConfig.nodeId}/control`, {
    method: "POST",
    token: login.sessionToken,
    idempotencyKey: "doctor-agent-control-refresh",
    body: {commandType: "refresh_profile"}
  });
  const controlRun = spawnSync(process.execPath, [runtimePath, "run", "--work-dir", agentWorkDir, "--once"], {
    env: {...process.env, AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true", AIMAC_AGENT_CONFIGURE_CLIENTS: "false"},
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  if (controlRun.status !== 0) throw new Error(`Agent Runtime control-channel run failed: ${controlRun.stderr || controlRun.stdout}`);
  const controlState = await json("/api/state?view=runtime&limit=200", {token: login.sessionToken});
  const controlCommand = (controlState.agentControlCommands || []).find((command) => command.idempotencyKey === "doctor-agent-control-refresh");
  if (!controlCommand || controlCommand.status !== "completed" || !controlCommand.resultDigest) throw new Error("Agent control command was not delivered and ACKed");
  if (!controlCommand.deliveredAt || !controlCommand.acknowledgedAt) throw new Error("Agent control command did not persist delivered and ACK timestamps");

  const reuse = await jsonRaw("/api/agent/v1/register", {method: "POST", token: joinResult.joinToken, body: {nodeName: "doctor-node", profile: {}}});
  if (reuse.response.status !== 409) throw new Error(`one-time join token was reusable: ${reuse.response.status}`);

  const orchestrated = await json("/api/orchestrator/run", {
    method: "POST",
    token: login.sessionToken,
    idempotencyKey: "doctor-agent-orchestrate",
    body: {mode: "single", taskGroupId: "tg_runtime_management", autoSyncSkills: false}
  });
  if (!orchestrated.changed.some((item) => item.dispatchId)) throw new Error("orchestrator did not enqueue a dispatch for the remote Agent Runtime");

  const run = spawnSync(process.execPath, [runtimePath, "run", "--work-dir", agentWorkDir, "--once"], {
    env: {...process.env, AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true", AIMAC_AGENT_CONFIGURE_CLIENTS: "false", AIMAC_AGENT_VERIFICATION_DEFER_CHECKPOINT: "true"},
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  if (run.status !== 0 || !run.stdout.includes("checkpoint intentionally deferred")) {
    const remoteHead = execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"], {encoding: "utf8"}).trim();
    const remoteParent = execFileSync("git", ["--git-dir", remote, "rev-parse", `${remoteHead}^`], {encoding: "utf8"}).trim();
    const remoteDiff = execFileSync("git", ["--git-dir", remote, "diff", "--name-only", remoteParent, remoteHead], {encoding: "utf8"}).trim();
    const manifests = remoteDiff.split("\n").filter((path) => path.includes("artifact-manifests/"));
    const manifest = manifests[0] ? execFileSync("git", ["--git-dir", remote, "show", `${remoteHead}:${manifests[0]}`], {encoding: "utf8"}).trim() : "missing";
    throw new Error(`remote Agent dispatch execution failed: ${run.stderr || run.stdout}\nremoteDiff=${remoteDiff}\nmanifest=${manifest}`);
  }

  const replay = spawnSync(process.execPath, [runtimePath, "run", "--work-dir", agentWorkDir, "--once"], {
    env: {...process.env, AIMAC_AGENT_ALLOW_INSECURE_HTTP: "true", AIMAC_AGENT_CONFIGURE_CLIENTS: "false"},
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  if (replay.status !== 0 || !replay.stdout.includes("checkpoint replayed")) throw new Error(`Agent checkpoint outbox replay failed: ${replay.stderr || replay.stdout}`);

  const state = await json("/api/state", {token: login.sessionToken});
  const completed = state.agentDispatches.find((dispatch) => dispatch.status === "completed" && dispatch.assignedNodeId);
  const node = state.agentRuntimeNodes.find((item) => item.nodeId === completed?.assignedNodeId);
  if (!completed || !node || node.status !== "online" || node.completedDispatchCount < 1) throw new Error("remote Agent completion was not persisted");
  const contract = state.agentTaskContracts.find((item) => item.sessionId === completed.sessionId);
  if (contract.roleSkill.synchronizationMode !== "server_managed_on_demand" || !contract.roleSkill.usageDirective.includes("child role")) throw new Error("dispatch did not bind the server-issued skill workset and child-role skill directive");
  const eventLog = await json(`/api/agent-dispatches/${completed.dispatchId}/events?limit=80`, {token: login.sessionToken});
  const eventTypes = new Set((eventLog.events || []).map((event) => event.eventType));
  for (const requiredEvent of ["dispatch_received", "skill_synced", "executor_started", "executor_output", "repository_changed", "git_committed", "git_pushed", "checkpoint_prepared", "checkpoint_submitted"]) {
    if (!eventTypes.has(requiredEvent)) throw new Error(`Agent execution event stream missing ${requiredEvent}`);
  }
  if (eventLog.storage?.storageKind !== "project-jsonl" || !eventLog.storage?.storageRef?.includes("project-db/")) throw new Error("Agent execution events were not read from the project-level event store");
  const sessionEventLog = await json(`/api/work-sessions/${completed.sessionId}/execution-events?limit=80`, {token: login.sessionToken});
  if (!(sessionEventLog.events || []).some((event) => event.dispatchId === completed.dispatchId)) throw new Error("WorkSession execution event stream did not return dispatch events");
  const remoteTree = execFileSync("git", ["--git-dir", remote, "ls-tree", "-r", "--name-only", "refs/heads/main"], {encoding: "utf8"});
  if (!remoteTree.includes("docs/agent-runtime-output/") || !remoteTree.includes("docs/artifact-manifests/")) throw new Error("Agent outputs were not committed and pushed to the project Git repository");

  const revokeJoinResult = await json("/api/agent-join-tokens", {
    method: "POST",
    token: login.sessionToken,
    idempotencyKey: "doctor-agent-revoke-token",
    body: {projectId: "prj_control_plane", nodeName: "revoke-node", allowedRoles: ["*"], ttlSeconds: 1800, maxUses: 1}
  });
  const revokeRegistration = await json("/api/agent/v1/register", {
    method: "POST",
    token: revokeJoinResult.joinToken,
    body: {nodeName: "revoke-node", requestedRoles: ["*"], runtimeVersion: "doctor", profile: {tools: [], models: [{providerClass: "custom", adapter: "doctor", available: true}]}}
  });
  await json("/api/agent/v1/self-check", {
    method: "POST",
    token: revokeRegistration.nodeToken,
    body: {checks: okSelfChecks(baseUrl), runtimeVersion: "doctor"}
  });
  const requeueOrchestrated = await json("/api/orchestrator/run", {
    method: "POST",
    token: login.sessionToken,
    idempotencyKey: "doctor-agent-revoke-orchestrate",
    body: {mode: "single", taskGroupId: "tg_runtime_management", autoSyncSkills: false}
  });
  const revokeClaim = await json("/api/agent/v1/dispatches/next", {method: "POST", token: revokeRegistration.nodeToken, body: {claimTtlSeconds: 900}});
  if (!revokeClaim.dispatch) throw new Error(`revoke test could not claim a dispatch: ${requeueOrchestrated.changed?.map((item) => item.workItemId || item.dispatchId).join(",") || "none"}`);
  const revokeResult = await json(`/api/agent-nodes/${revokeRegistration.node.nodeId}/revoke`, {
    method: "POST",
    token: login.sessionToken,
    idempotencyKey: "doctor-agent-node-revoke"
  });
	  const revokedDispatchId = revokeClaim.dispatch.dispatch.dispatchId;
	  const postRevokeState = await json("/api/state", {token: login.sessionToken});
	  const pendingDispatch = postRevokeState.agentDispatches.find((dispatch) => dispatch.dispatchId === revokedDispatchId);
		  if (!revokeResult.pendingDispatchIds.includes(revokedDispatchId) || pendingDispatch?.status !== "blocked" || pendingDispatch.assignedNodeId !== revokeRegistration.node.nodeId) {
		    throw new Error("Agent node revocation did not fence the running dispatch before ACK");
		  }
      if ((postRevokeState.mcpGrants || []).some((grant) => grant.agentNodeId === revokeRegistration.node.nodeId && grant.dispatchId === revokedDispatchId && grant.grantStatus === "issued")) {
        throw new Error("Agent node revocation did not revoke dispatch MCP grants before ACK");
      }
	  if (revokeResult.status !== "draining" || revokeResult.command?.commandType !== "revoke") {
	    throw new Error("Agent node revocation did not queue a draining revoke command");
	  }
	  const revokeControls = await json("/api/agent/v1/control?afterSequence=0&waitMs=1000", {token: revokeRegistration.nodeToken});
	  if (!revokeControls.commands.some((command) => command.commandId === revokeResult.command.commandId && command.commandType === "revoke")) {
	    throw new Error("Agent node control channel did not deliver revoke command");
	  }
	  await json(`/api/agent/v1/control/${revokeResult.command.commandId}/ack`, {
	    method: "POST",
	    token: revokeRegistration.nodeToken,
	    body: {status: "completed", result: {stopped: true}}
	  });
	  const postAckState = await json("/api/state", {token: login.sessionToken});
	  const requeuedDispatch = postAckState.agentDispatches.find((dispatch) => dispatch.dispatchId === revokedDispatchId);
	  if (requeuedDispatch?.status !== "queued" || requeuedDispatch.assignedNodeId) {
	    throw new Error("Agent node revocation ACK did not requeue the fenced dispatch");
	  }
		  console.log("agent remote doctor ok: one-command join, checksum install, credential rotation, initialization, self-check, remote MCP, control command ACK, project/session-level execution event stream, on-demand skill workset, dispatch, commit, push and checkpoint outbox replay, revoke pending+ACK requeue verified");
} finally {
  server.kill("SIGTERM");
  await Promise.race([once(server, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 3000))]);
  rmSync(sandbox, {recursive: true, force: true});
  if (server.exitCode && server.exitCode !== 0 && stderr) process.stderr.write(stderr);
}

function setupRepository() {
  mkdirSync(source, {recursive: true});
  execFileSync("git", ["init", "--bare", remote], {stdio: "pipe"});
  execFileSync("git", ["init", "-b", "main", source], {stdio: "pipe"});
  execFileSync("git", ["-C", source, "config", "user.email", "doctor@local"], {stdio: "pipe"});
  execFileSync("git", ["-C", source, "config", "user.name", "Doctor"], {stdio: "pipe"});
  writeFileSync(join(source, "README.md"), "# Agent Gateway Doctor\n");
  execFileSync("git", ["-C", source, "add", "README.md"], {stdio: "pipe"});
  execFileSync("git", ["-C", source, "commit", "-m", "Initialize Agent Gateway doctor repository"], {stdio: "pipe"});
  execFileSync("git", ["-C", source, "remote", "add", "origin", remote], {stdio: "pipe"});
  execFileSync("git", ["-C", source, "push", "origin", "HEAD:refs/heads/main"], {stdio: "pipe"});
}

function forceNodeCredentialNearExpiry(nodeId) {
  const path = join(runtimeDir, "control-plane-state.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  const node = state.agentRuntimeNodes.find((item) => item.nodeId === nodeId);
  if (!node) throw new Error(`node not found for credential rotation test: ${nodeId}`);
  node.credentialExpiresAt = new Date(Date.now() + 60 * 1000).toISOString();
  node.updatedAt = new Date().toISOString();
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function stopAgentDaemon(workDir) {
  const pidFile = join(workDir, "run", "agent.pid");
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (pid > 0) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
}

function okSelfChecks(baseUrl, options = {}) {
  const checks = [
    {checkId: "runtime", status: "ok", detail: "doctor"},
    {checkId: "gateway", status: "ok", detail: baseUrl},
    {checkId: "filesystem", status: "ok", detail: "doctor"},
    {checkId: "git", status: "ok", detail: "doctor"},
    {checkId: "remote_mcp", status: "ok", detail: `${baseUrl}/mcp`}
  ];
  checks.push(options.modelExecutor === false
    ? {checkId: "model_executor", status: "failed", detail: "no model executor configured"}
    : {checkId: "model_executor", status: "ok", detail: "custom:doctor:available"});
  return checks;
}

function assertAgentScopedMcpConfig(workDir, baseUrl, expectedToken) {
  const configDir = join(workDir, "mcp-client-configs");
  const mcpConfigPath = join(configDir, "mcp-server.json");
  if (!existsSync(mcpConfigPath)) throw new Error(`Agent scoped MCP config was not generated: ${mcpConfigPath}`);
  const config = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
  const server = config.mcpServers?.ai_multi_agent_ctrl;
  if (config.transport !== "streamable-http" || config.hostedBy !== baseUrl || server?.url !== `${baseUrl}/mcp`) throw new Error("Agent scoped MCP config does not point at the centralized remote MCP endpoint");
  if (Object.prototype.hasOwnProperty.call(server, "command")) throw new Error("Agent scoped MCP config must not contain a local command");
  if (expectedToken && server.headers?.Authorization !== `Bearer ${expectedToken}`) throw new Error("Agent scoped MCP config was not refreshed after node credential rotation");
  for (const filename of ["codex_config.toml", "claude_desktop_config.json", "cursor_mcp.json"]) {
    if (!existsSync(join(configDir, filename))) throw new Error(`Agent scoped MCP client snippet missing: ${filename}`);
  }
}

async function json(path, options = {}) {
  const result = await jsonRaw(path, options);
  if (!result.response.ok) throw new Error(`${result.payload.error || "request_failed"}: ${result.payload.message || result.response.status}`);
  return result.payload;
}

async function jsonRaw(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || (options.body ? "POST" : "GET"),
    headers: {accept: "application/json", ...(options.body ? {"content-type": "application/json"} : {}), ...(options.token ? {authorization: `Bearer ${options.token}`} : {}), ...(options.idempotencyKey ? {"idempotency-key": options.idempotencyKey} : {})},
    ...(options.body ? {body: JSON.stringify(options.body)} : {})
  });
  return {response, payload: await response.json()};
}

async function waitForHealth() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`Agent Gateway health timeout: ${stderr}`);
}

async function freePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const selected = listener.address().port;
  listener.close();
  await once(listener, "close");
  return selected;
}
