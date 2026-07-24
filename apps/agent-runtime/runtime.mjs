#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform, arch, cpus, totalmem } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";

const RUNTIME_VERSION = "0.2.0";
const args = parseArgs(process.argv.slice(2));
const command = args._[0] || "run";
const workDir = resolve(args["work-dir"] || process.env.AIMAC_AGENT_WORK_DIR || join(homedir(), ".local", "share", "aimac-agent"));
const configPath = join(workDir, "agent-config.json");

await main();

async function main() {
  if (command === "bootstrap") return bootstrap();
  if (command === "self-check") return selfCheck(loadConfig());
  if (command === "status") return status(loadConfig());
  if (command === "run") return run(loadConfig());
  throw new Error(`unknown command: ${command}`);
}

async function bootstrap() {
  mkdirSync(workDir, {recursive: true});
  const serverUrl = trimSlash(args.server || process.env.AIMAC_SERVER_URL || "");
  const joinToken = readJoinToken();
  if (!serverUrl || !joinToken) throw new Error("bootstrap requires --server and --join-token-file");
  requireSecureServerUrl(serverUrl);
  const configuredExecutor = args["executor-command"] || process.env.AIMAC_AGENT_EXECUTOR_COMMAND || "";
  const profile = probeProfile(configuredExecutor);
  const registration = await retryableAgentRequest(() => jsonRequest(`${serverUrl}/api/agent/v1/register`, {
    method: "POST",
    token: joinToken,
    body: {
      nodeName: args["node-name"] || process.env.AIMAC_AGENT_NODE_NAME || hostname(),
      requestedRoles: splitCsv(args.roles),
      runtimeVersion: RUNTIME_VERSION,
      profile
    }
  }), "register");
  const config = {
    schemaVersion: "aimac-agent-local-config/v1",
    runtimeVersion: RUNTIME_VERSION,
    serverUrl,
    nodeId: registration.node.nodeId,
    nodeToken: registration.nodeToken,
    nodeName: registration.node.nodeName,
    projectIds: registration.node.projectIds,
    allowedRoles: registration.node.allowedRoles,
    gateway: registration.gateway,
    controlCursor: 0,
    workDir,
    repositoryDir: join(workDir, "repositories"),
    skillCacheDir: join(workDir, "skill-worksets"),
    taskDir: join(workDir, "tasks"),
    outboxDir: join(workDir, "outbox"),
    executorCommand: configuredExecutor,
    pollIntervalSeconds: registration.pollIntervalSeconds || 5,
    heartbeatIntervalSeconds: registration.heartbeatIntervalSeconds || 30,
    installedAt: new Date().toISOString()
  };
  for (const path of [config.repositoryDir, config.skillCacheDir, config.taskDir, config.outboxDir]) mkdirSync(path, {recursive: true});
  writeSecretJson(configPath, config);
  writeAgentScopedMcpConfig(config, profile);
  if (globalClientConfigurationEnabled()) configureGlobalRemoteMcpClients(config, profile);
  const check = await selfCheck(config);
  if (!check.ok) throw new Error(`agent self-check failed: ${check.missingChecks.join(",")}`);
  process.stdout.write([
    "AGENT_JOINED",
    `nodeId=${config.nodeId}`,
    `nodeName=${config.nodeName}`,
    `agentProfileDigest=${registration.node.profileDigest}`,
    `schedulerAdmission=${check.admission}`,
    `remoteMcp=${config.gateway.mcpUrl}`,
    `skills=on_demand`,
    ""
  ].join("\n"));
}

async function selfCheck(config) {
  const checks = [];
  const profile = probeProfile(config.executorCommand);
  checks.push(check("runtime", Number(process.versions.node.split(".")[0]) >= 20, `node ${process.versions.node}; runtime ${RUNTIME_VERSION}`));
  checks.push(check("filesystem", writableDirectory(config.workDir), config.workDir));
  checks.push(check("git", executableVersion("git", ["--version"]).available, executableVersion("git", ["--version"]).version));
  checks.push(check("model_executor", profile.models.some((item) => item.available === true), modelExecutorDetail(profile)));
  let gatewayOk = false;
  try {
    const health = await jsonRequest(`${config.serverUrl}/api/health`);
    gatewayOk = health.status === "ok";
  } catch {}
  checks.push(check("gateway", gatewayOk, config.serverUrl));
  let mcpOk = false;
  try {
    const initialized = await jsonRequest(config.gateway.mcpUrl, {
      method: "POST",
      token: config.nodeToken,
      headers: {accept: "application/json, text/event-stream"},
      body: {jsonrpc: "2.0", id: "agent-self-check", method: "initialize", params: {protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {name: "aimac-agent-runtime", version: RUNTIME_VERSION}}}
    });
    mcpOk = initialized.result?.serverInfo?.name === "ai-multi-agent-ctrl";
  } catch {}
  checks.push(check("remote_mcp", mcpOk, config.gateway.mcpUrl));
  const result = await jsonRequest(config.gateway.selfCheckUrl, {method: "POST", token: config.nodeToken, body: {checks, runtimeVersion: RUNTIME_VERSION, profile}});
  process.stdout.write(`agent self-check: ${result.ok ? "ok" : "failed"}\n`);
  return result;
}

async function status(config) {
  const result = await jsonRequest(`${config.serverUrl}/api/agent/v1/nodes/me`, {token: config.nodeToken});
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function run(config) {
  let lastHeartbeat = 0;
  let lastAdmissionSelfCheckAt = 0;
  const once = args.once === true || process.env.AIMAC_AGENT_ONCE === "true";
  for (;;) {
    if (config.shutdownRequested) {
      process.stdout.write("agent runtime shutdown requested by control plane\n");
      return;
    }
    const outboxPending = await flushCheckpointOutbox(config);
    if (Date.now() - lastHeartbeat >= config.heartbeatIntervalSeconds * 1000) {
      const currentProfile = probeProfile(config.executorCommand);
      const heartbeat = await retryableAgentRequest(() => jsonRequest(config.gateway.heartbeatUrl, {method: "POST", token: config.nodeToken, body: {nodeId: config.nodeId, status: "online", profile: currentProfile, runtimeVersion: RUNTIME_VERSION, capturedAt: new Date().toISOString()}}), "heartbeat");
      if (heartbeat.nodeToken) {
        config.nodeToken = heartbeat.nodeToken;
        writeSecretJson(configPath, config);
        writeAgentScopedMcpConfig(config, currentProfile);
        if (globalClientConfigurationEnabled()) configureGlobalRemoteMcpClients(config, currentProfile);
      }
      lastHeartbeat = Date.now();
    }
    await pollControlCommands(config, {waitMs: 0});
    if (config.shutdownRequested) {
      process.stdout.write("agent runtime shutdown requested by control plane\n");
      return;
    }
    if (outboxPending > 0) {
      process.stderr.write(`dispatch claim deferred: ${outboxPending} checkpoint outbox item(s) pending replay\n`);
      if (once) return;
      await delay(config.pollIntervalSeconds * 1000);
      continue;
    }
    const claimed = await retryableAgentRequest(() => jsonRequest(config.gateway.dispatchUrl, {method: "POST", token: config.nodeToken, body: {claimTtlSeconds: Number(args["claim-ttl"] || 1800)}}), "dispatch_claim");
    if (!claimed.dispatch && claimed.reason === "node_not_admitted" && Date.now() - lastAdmissionSelfCheckAt > 5 * 60 * 1000) {
      lastAdmissionSelfCheckAt = Date.now();
      await selfCheck(config).catch((error) => process.stderr.write(`re-admission self-check failed: ${error.message}\n`));
    }
    if (claimed.dispatch) {
      try {
        const control = startControlWatcher(config, claimed.dispatch);
        let checkpoint;
        try {
          checkpoint = await executeDispatch(config, claimed.dispatch, control);
        } finally {
          await control.stop();
        }
        const outboxPath = persistCheckpointOutbox(config, claimed.dispatch, checkpoint);
        if (process.env.AIMAC_AGENT_VERIFICATION_DEFER_CHECKPOINT === "true") {
          process.stdout.write(`checkpoint intentionally deferred for verification: ${claimed.dispatch.dispatch.dispatchId}\n`);
        } else {
          try {
            const result = await submitCheckpoint(config, claimed.dispatch.remoteServices.checkpointPath, checkpoint);
            unlinkSync(outboxPath);
            await submitExecutionEvent(config, claimed.dispatch, "checkpoint_submitted", {progressPercent: 100, summary: "Checkpoint accepted by control plane.", evidenceRefs: [`checkpoint:${result.checkpoint?.runId || "accepted"}`]}).catch(() => {});
            process.stdout.write(`dispatch completed: ${claimed.dispatch.dispatch.dispatchId} checkpoint=${result.checkpoint?.runId || "accepted"}\n`);
          } catch (error) {
            process.stderr.write(`checkpoint pending retry: ${claimed.dispatch.dispatch.dispatchId} ${error.message}\n`);
          }
        }
      } catch (error) {
        const eventType = error.controlStatus === "blocked" ? "blocked" : "failed";
        await submitExecutionEvent(config, claimed.dispatch, eventType, {summary: String(error.message || error).slice(0, 1000), status: eventType === "blocked" ? "attention" : "failed"}).catch(() => {});
        await jsonRequest(`${config.serverUrl}${claimed.dispatch.remoteServices.failurePath}`, {method: "POST", token: config.nodeToken, body: {reason: String(error.message || error).slice(0, 2000), status: error.controlStatus || "failed"}}).catch(() => {});
        process.stderr.write(`dispatch failed: ${claimed.dispatch.dispatch.dispatchId} ${error.message}\n`);
      }
    }
    if (once) return;
    await delay(config.pollIntervalSeconds * 1000);
  }
}

function startControlWatcher(config, dispatchPackage) {
  const state = {
    running: true,
    cancelled: false,
    controlStatus: "cancelled",
    reason: "",
    child: null,
    stopPromise: null
  };
  const watcher = {
    signal: state,
    attachChild(child) {
      state.child = child;
      if (state.cancelled && child && !state.stopPromise) state.stopPromise = terminateChild(child, Number(process.env.AIMAC_AGENT_STOP_TIMEOUT_MS || 10000));
    },
    throwIfCancelled() {
      if (!state.cancelled) return;
      const error = new Error(state.reason || "dispatch interrupted by control command");
      error.controlStatus = state.controlStatus;
      throw error;
    },
    requestStop(timeoutMs) {
      if (!state.child) return Promise.resolve({stopped: true, reason: "no_child"});
      if (!state.stopPromise) state.stopPromise = terminateChild(state.child, timeoutMs);
      return state.stopPromise;
    },
    async stop() {
      state.running = false;
      await loop.catch(() => {});
    }
  };
  const keepAliveMs = Math.max(15000, Number(process.env.AIMAC_AGENT_EXECUTION_KEEPALIVE_MS || 60000));
  let lastKeepAliveAt = Date.now();
  const loop = (async () => {
    while (state.running && !state.cancelled) {
      try {
        await pollControlCommands(config, {waitMs: 15000, dispatchPackage, controlState: state});
      } catch (error) {
        process.stderr.write(`control watcher iteration deferred: ${error.message}\n`);
        await delay(1000);
      }
      if (state.running && !state.cancelled && Date.now() - lastKeepAliveAt >= keepAliveMs) {
        lastKeepAliveAt = Date.now();
        await submitExecutionEvent(config, dispatchPackage, "heartbeat", {progressPercent: 0, summary: "Execution keep-alive heartbeat renews the dispatch claim."}).catch(() => {});
      }
      await delay(250);
    }
  })().catch((error) => {
    process.stderr.write(`control watcher stopped: ${error.message}\n`);
  });
  return watcher;
}

async function pollControlCommands(config, options = {}) {
  const controlUrl = config.gateway.controlUrl || `${config.serverUrl}/api/agent/v1/control`;
  const url = new URL(controlUrl);
  url.searchParams.set("afterSequence", String(config.controlCursor || 0));
  url.searchParams.set("waitMs", String(Math.max(0, Math.min(30000, Number(options.waitMs || 0)))));
  url.searchParams.set("limit", "20");
  let result;
  try {
    result = await retryableAgentRequest(() => jsonRequest(url.href, {token: config.nodeToken, timeoutMs: Math.max(0, Math.min(30000, Number(options.waitMs || 0))) + 15000}), "control_poll");
  } catch (error) {
    process.stderr.write(`control poll deferred: ${error.message}\n`);
    return {commands: [], nextCursor: config.controlCursor || 0};
  }
  for (const command of result.commands || []) {
    try {
      await handleControlCommand(config, command, options);
    } catch (error) {
      process.stderr.write(`control command handling failed: ${command.commandId} ${error.message}\n`);
      await ackControlCommand(config, command, "failed", {reason: String(error.message || error).slice(0, 500)}).catch(() => {});
    }
  }
  if (Number(result.nextCursor || 0) > Number(config.controlCursor || 0)) {
    config.controlCursor = Number(result.nextCursor || 0);
    writeSecretJson(configPath, config);
  }
  return result;
}

async function handleControlCommand(config, command, options = {}) {
  const dispatchPackage = options.dispatchPackage;
  const controlState = options.controlState;
  const activeDispatchId = dispatchPackage?.dispatch?.dispatchId;
  const scopedToActiveDispatch = !command.dispatchId || command.dispatchId === activeDispatchId;
  if (command.commandType === "refresh_profile") {
    await ackControlCommand(config, command, "received", {phase: "received"});
    const profile = probeProfile(config.executorCommand);
    const heartbeat = await retryableAgentRequest(() => jsonRequest(config.gateway.heartbeatUrl, {method: "POST", token: config.nodeToken, body: {profile, runtimeVersion: RUNTIME_VERSION}}), "control_refresh_profile");
    if (heartbeat.nodeToken) {
      config.nodeToken = heartbeat.nodeToken;
      writeSecretJson(configPath, config);
      writeAgentScopedMcpConfig(config, profile);
      if (globalClientConfigurationEnabled()) configureGlobalRemoteMcpClients(config, profile);
    }
    await ackControlCommand(config, command, "completed", {profileDigest: heartbeat.node?.profileDigest || null});
    return;
  }
  if (command.commandType === "resume_dispatch") {
    await ackControlCommand(config, command, "completed", {serverStateTransition: "resume_dispatch_already_applied", activeDispatchId});
    return;
  }
  if (!scopedToActiveDispatch) {
    await ackControlCommand(config, command, "rejected", {reason: "dispatch_scope_not_active", activeDispatchId});
    return;
  }
  if (["pause_dispatch", "cancel_dispatch", "revoke", "shutdown"].includes(command.commandType)) {
    await ackControlCommand(config, command, "received", {phase: "received", activeDispatchId});
    if (controlState) {
      controlState.cancelled = true;
      controlState.controlStatus = command.commandType === "pause_dispatch" ? "blocked" : "cancelled";
      controlState.reason = `dispatch interrupted by control command: ${command.commandType}`;
      const stopResult = await terminateChild(controlState.child, Number(command.payload?.stopTimeoutMs || process.env.AIMAC_AGENT_STOP_TIMEOUT_MS || 10000));
      if (["revoke", "shutdown"].includes(command.commandType)) {
        config.shutdownRequested = true;
        writeSecretJson(configPath, config);
      }
      await submitExecutionEvent(config, dispatchPackage, command.commandType === "pause_dispatch" ? "blocked" : "failed", {
        status: command.commandType === "pause_dispatch" ? "attention" : "failed",
        summary: controlState.reason,
        evidenceRefs: [`AgentControlCommand:${command.commandId}`],
        payload: stopResult
      }).catch(() => {});
      await ackControlCommand(config, command, stopResult.stopped ? "completed" : "failed", {reason: controlState.reason, stopResult});
      return;
    }
    if (["revoke", "shutdown"].includes(command.commandType)) {
      config.shutdownRequested = true;
      writeSecretJson(configPath, config);
      await ackControlCommand(config, command, "completed", {reason: "node-level shutdown accepted while idle"});
      return;
    }
    await ackControlCommand(config, command, "rejected", {reason: "no_active_dispatch_context"});
    return;
  }
  await ackControlCommand(config, command, "rejected", {reason: "UNSUPPORTED_COMMAND", commandType: command.commandType});
}

function ackControlCommand(config, command, status, result) {
  return retryableAgentRequest(() => jsonRequest(`${config.serverUrl}/api/agent/v1/control/${encodeURIComponent(command.commandId)}/ack`, {
    method: "POST",
    token: config.nodeToken,
    body: {status, result}
  }), "control_ack");
}

async function flushCheckpointOutbox(config) {
  const outboxDir = config.outboxDir || join(config.workDir, "outbox");
  mkdirSync(outboxDir, {recursive: true});
  let pending = 0;
  for (const filename of readdirSync(outboxDir).filter((name) => name.endsWith(".json")).sort()) {
    const path = join(outboxDir, filename);
    const item = JSON.parse(readFileSync(path, "utf8"));
    try {
      verifyCheckpointReplayRemote(config, item);
      await submitCheckpoint(config, item.checkpointPath, item.checkpoint);
      await submitExecutionEventForDispatch(config, item.dispatchId, "checkpoint_submitted", {progressPercent: 100, summary: "Checkpoint replay accepted by control plane.", evidenceRefs: [`checkpoint:${item.checkpoint?.runId || "accepted"}`]}).catch(() => {});
      unlinkSync(path);
      process.stdout.write(`checkpoint replayed: ${item.dispatchId}\n`);
    } catch (error) {
      if (String(error.message || "").includes("recover_required")) {
        const recoverPath = `${path}.recover-${Date.now()}`;
        renameSync(path, recoverPath);
        await jsonRequest(`${config.serverUrl}/api/agent/v1/dispatches/${encodeURIComponent(item.dispatchId)}/fail`, {
          method: "POST",
          token: config.nodeToken,
          body: {status: "blocked", reason: `checkpoint_replay_recover_required: ${String(error.message).slice(0, 500)}`}
        }).catch(() => {});
        process.stderr.write(`checkpoint replay moved to recovery: ${item.dispatchId} -> ${recoverPath}\n`);
        continue;
      }
      pending += 1;
      process.stderr.write(`checkpoint replay deferred: ${item.dispatchId} ${error.message}\n`);
    }
  }
  return pending;
}

function persistCheckpointOutbox(config, dispatchPackage, checkpoint) {
  const outboxDir = config.outboxDir || join(config.workDir, "outbox");
  mkdirSync(outboxDir, {recursive: true});
  const target = join(outboxDir, `${safeName(dispatchPackage.dispatch.dispatchId)}.json`);
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({dispatchId: dispatchPackage.dispatch.dispatchId, checkpointPath: dispatchPackage.remoteServices.checkpointPath, repositoryOutputTarget: dispatchPackage.repositoryOutputTarget, checkpoint, createdAt: new Date().toISOString()}, null, 2)}\n`, {mode: 0o600});
  renameSync(temporary, target);
  return target;
}

function verifyCheckpointReplayRemote(config, item) {
  const target = item.repositoryOutputTarget;
  const pushRef = item.checkpoint?.pushRefs?.at(-1);
  if (!target || !pushRef?.ref || !pushRef.remoteSha) return;
  const repositoryRoot = join(config.repositoryDir, safeName(target.repositoryId));
  if (!existsSync(join(repositoryRoot, ".git"))) throw new Error("checkpoint replay recover_required: repository checkout missing");
  const remote = pushRef.remote || target.remote || "origin";
  const currentRemoteSha = gitLsRemote(repositoryRoot, remote, pushRef.ref);
  if (currentRemoteSha === pushRef.remoteSha) return;
  try {
    git(repositoryRoot, ["fetch", "--no-tags", remote, pushRef.ref]);
    git(repositoryRoot, ["merge-base", "--is-ancestor", pushRef.remoteSha, "FETCH_HEAD"]);
  } catch {
    throw new Error(`checkpoint replay recover_required: pushed commit no longer contained in remote ${pushRef.ref}`);
  }
}

function submitCheckpoint(config, checkpointPath, checkpoint) {
  return jsonRequest(`${config.serverUrl}${checkpointPath}`, {method: "POST", token: config.nodeToken, body: checkpoint});
}

function submitExecutionEvent(config, dispatchPackage, eventType, payload = {}) {
  return submitExecutionEventForDispatch(config, dispatchPackage.dispatch.dispatchId, eventType, payload);
}

function submitExecutionEventForDispatch(config, dispatchId, eventType, payload = {}) {
  const eventUrl = config.gateway.eventUrl || `${config.serverUrl}/api/agent/v1/events`;
  config.eventSequence = Number(config.eventSequence || 0) + 1;
  writeSecretJson(configPath, config);
  return retryableAgentRequest(() => jsonRequest(eventUrl, {
    method: "POST",
    token: config.nodeToken,
    body: {
      dispatchId,
      eventType,
      eventKey: `${config.nodeId}:${dispatchId}:${config.eventSequence}:${eventType}`,
      ...payload
    }
  }), `event_${eventType}`);
}

async function executeDispatch(config, dispatchPackage, control) {
  verifyPackageBinding(config, dispatchPackage);
  await submitExecutionEvent(config, dispatchPackage, "dispatch_received", {progressPercent: 8, summary: "Dispatch package received and binding verified."});
  control?.throwIfCancelled();
  const skillWorkset = syncSkillWorkset(config, dispatchPackage);
  await submitExecutionEvent(config, dispatchPackage, "skill_synced", {progressPercent: 15, summary: "Server-issued skill workset synchronized.", evidenceRefs: [`skill-workset:${skillWorkset.worksetDigest}`]});
  control?.throwIfCancelled();
  const repositoryRoot = prepareRepository(config, dispatchPackage.repositoryOutputTarget);
  const taskRoot = join(config.taskDir, dispatchPackage.dispatch.dispatchId);
  mkdirSync(taskRoot, {recursive: true});
  const packagePath = join(taskRoot, "dispatch-package.json");
  const promptPath = join(taskRoot, "execution-prompt.txt");
  writeFileSync(packagePath, `${JSON.stringify(dispatchPackage, null, 2)}\n`, {mode: 0o600});
  writeFileSync(promptPath, buildExecutionPrompt(config, dispatchPackage, skillWorkset, packagePath), {mode: 0o600});
  ensureCleanWorktree(repositoryRoot);
  const before = git(repositoryRoot, ["rev-parse", "HEAD"]);
  await submitExecutionEvent(config, dispatchPackage, "executor_started", {progressPercent: 25, summary: "Model executor started.", evidenceRefs: [`prompt:${sha256(readFileSync(promptPath, "utf8"))}`]});
  const output = await runModelExecutor(config, dispatchPackage, repositoryRoot, skillWorkset, packagePath, promptPath, control);
  control?.throwIfCancelled();
  const changedBeforeManifest = gitStatusPaths(repositoryRoot);
  if (!changedBeforeManifest.length) throw new Error("model agent produced no repository changes");
  assertAllowedPaths(changedBeforeManifest, dispatchPackage.repositoryOutputTarget);
  await submitExecutionEvent(config, dispatchPackage, "repository_changed", {progressPercent: 65, summary: `Model executor changed ${changedBeforeManifest.length} repository paths.`, evidenceRefs: changedBeforeManifest.slice(0, 20).map((path) => `git-path:${path}`)});
  const manifestPath = dispatchPackage.repositoryOutputTarget.artifactManifestPath;
  const outputRefs = changedBeforeManifest.filter((path) => path !== manifestPath);
  if (!outputRefs.length) throw new Error("model agent produced no task output besides artifact manifest");
  writeArtifactManifest(repositoryRoot, manifestPath, dispatchPackage, outputRefs, output);
  const changed = gitStatusPaths(repositoryRoot);
  assertAllowedPaths(changed, dispatchPackage.repositoryOutputTarget);
  configureGitIdentity(repositoryRoot);
  git(repositoryRoot, ["add", "--", ...changed]);
  git(repositoryRoot, ["commit", "-m", output.commitMessage || `Complete ${dispatchPackage.taskContract.workId} via AI agent`]);
  const commit = git(repositoryRoot, ["rev-parse", "HEAD"]);
  await submitExecutionEvent(config, dispatchPackage, "git_committed", {progressPercent: 80, summary: `Committed repository changes at ${commit}.`, evidenceRefs: [`commit:${commit}`]});
  control?.throwIfCancelled();
  const branch = dispatchPackage.repositoryOutputTarget.branch;
  const remote = dispatchPackage.repositoryOutputTarget.remote || "origin";
  git(repositoryRoot, ["push", remote, `HEAD:refs/heads/${branch}`]);
  const remoteSha = gitLsRemote(repositoryRoot, remote, `refs/heads/${branch}`);
  if (remoteSha !== commit) throw new Error("remote push verification failed");
  await submitExecutionEvent(config, dispatchPackage, "git_pushed", {progressPercent: 90, summary: `Pushed ${commit} to ${remote}/refs/heads/${branch}.`, evidenceRefs: [`push:${remote}:refs/heads/${branch}:${remoteSha}`]});
  const tree = git(repositoryRoot, ["rev-parse", `${commit}^{tree}`]);
  const checkpoint = {
    schemaVersion: "checkpoint/v1",
    projectId: dispatchPackage.taskContract.projectId,
    taskGroupId: dispatchPackage.taskContract.taskGroupId,
    workId: dispatchPackage.taskContract.workId,
    sessionId: dispatchPackage.taskContract.sessionId,
    runId: dispatchPackage.taskContract.runId,
    taskContractDigest: dispatchPackage.taskContract.contractDigest,
    stateVersion: dispatchPackage.taskContract.stateVersion,
    summary: output.summary || `AI agent completed ${dispatchPackage.taskContract.workId}.`,
    nextSteps: output.nextSteps || [{actionId: "none", mode: "none", summary: "No follow-up action remains.", evidenceRefs: ["agent-runtime:completed"]}],
    openMachineActionIds: output.openMachineActionIds || [],
    derivedWorkRequests: output.derivedWorkRequests || [],
    returnPointRef: `return:${dispatchPackage.taskContract.sessionId}`,
    commitRefs: [{repo: dispatchPackage.repositoryOutputTarget.repositoryId, branch, commit, treeDigest: `git-tree:${tree}`, createdAt: new Date().toISOString()}],
    pushRefs: [{repo: dispatchPackage.repositoryOutputTarget.repositoryId, remote, ref: `refs/heads/${branch}`, sourceCommit: commit, remoteSha, providerOperationId: `agent-push:${dispatchPackage.dispatch.dispatchId}:${commit}`, verifiedAt: new Date().toISOString(), rewriteRelation: "same_commit"}],
    repositoryOutputTargetRefs: [dispatchPackage.repositoryOutputTarget.targetId],
    artifactManifestRefs: [manifestPath],
    changedPathEvidenceRefs: [`git-diff:${before}:${commit}`, ...changed.map((path) => `git-path:${path}`)],
    evidenceRefs: [`agent-node:${config.nodeId}`, `skill-workset:${skillWorkset.worksetDigest}`, `remote-mcp:${config.gateway.mcpUrl}`],
    languagePolicyDigest: dispatchPackage.taskContract.languagePolicyDigest,
    outputContractDigest: dispatchPackage.taskContract.outputContract?.schemaDigest || sha256("spec/checkpoint.schema.json"),
    createdAt: new Date().toISOString()
  };
  await submitExecutionEvent(config, dispatchPackage, "checkpoint_prepared", {progressPercent: 95, summary: "Checkpoint prepared for local outbox and control-plane ACK.", evidenceRefs: checkpoint.evidenceRefs});
  return checkpoint;
}

async function runModelExecutor(config, dispatchPackage, repositoryRoot, skillWorkset, packagePath, promptPath, control) {
  const dispatchModel = dispatchPackage.taskContract.model || {};
  const modelId = modelIdForProvider(dispatchModel);
  const reasoning = rawReasoningLevel(dispatchModel.reasoning || dispatchModel.reasoningLevel || "");
  const env = {
    ...process.env,
    AIMAC_SERVER_URL: config.serverUrl,
    AIMAC_MCP_URL: config.gateway.mcpUrl,
    AIMAC_MCP_BEARER_TOKEN: config.nodeToken,
    AIMAC_AGENT_NODE_ID: config.nodeId,
    AIMAC_DISPATCH_PACKAGE_FILE: packagePath,
    AIMAC_TASK_CONTRACT_FILE: packagePath,
    AIMAC_DISPATCH_MODEL: modelId || String(dispatchModel.model || dispatchModel.modelId || ""),
    AIMAC_DISPATCH_MODEL_ID: modelId || String(dispatchModel.model || dispatchModel.modelId || ""),
    AIMAC_DISPATCH_PROVIDER_CLASS: String(dispatchModel.providerClass || dispatchModel.alias || ""),
    AIMAC_DISPATCH_REASONING: reasoning,
    AIMAC_DISPATCH_REASONING_LEVEL: reasoning,
    AIMAC_MODEL_DECISION: String(dispatchModel.modelDecision || ""),
    AIMAC_TASK_GROUP_LANGUAGE: String(dispatchPackage.taskContract.languagePolicy?.languageTag || "zh-CN"),
    AIMAC_LANGUAGE_POLICY_DIGEST: String(dispatchPackage.taskContract.languagePolicyDigest || ""),
    AIMAC_SKILL_WORKSET_DIR: skillWorkset.directory,
    AIMAC_SKILL_MANIFEST_FILE: skillWorkset.manifestPath,
    AIMAC_EXECUTION_PROMPT_FILE: promptPath
  };
  const executorInput = {
    schemaVersion: "agent-runtime-executor-input/v2",
    repositoryRoot,
    dispatchId: dispatchPackage.dispatch.dispatchId,
    projectId: dispatchPackage.taskContract.projectId,
    taskGroupId: dispatchPackage.taskContract.taskGroupId,
    workId: dispatchPackage.taskContract.workId,
    sessionId: dispatchPackage.taskContract.sessionId,
    model: dispatchPackage.taskContract.model,
    languagePolicy: dispatchPackage.taskContract.languagePolicy,
    languagePolicyDigest: dispatchPackage.taskContract.languagePolicyDigest,
    roleSkill: dispatchPackage.taskContract.roleSkill,
    skillWorksetDir: skillWorkset.directory,
    taskContract: dispatchPackage.taskContract,
    effectiveInstructionPacket: dispatchPackage.effectiveInstructionPacket,
    repositoryOutputTarget: dispatchPackage.repositoryOutputTarget,
    remoteMcp: {url: config.gateway.mcpUrl, bearerTokenEnv: "AIMAC_MCP_BEARER_TOKEN"},
    requiredOutputs: ["repository_changes", "verification", "artifact_manifest_inputs"]
  };
  let result;
  const outputReporter = createExecutorOutputReporter(config, dispatchPackage);
  if (config.executorCommand) {
    result = await spawnAndCapture("sh", ["-c", config.executorCommand], {cwd: repositoryRoot, env, input: `${JSON.stringify(executorInput)}\n`, control, onOutput: outputReporter});
  } else {
    result = await runKnownModelCli(dispatchPackage.taskContract.model, readFileSync(promptPath, "utf8"), repositoryRoot, env, control, outputReporter);
  }
  control?.throwIfCancelled();
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`model executor exited ${result.status}: ${String(result.stderr || result.stdout || "").slice(-4000)}`);
  const lines = String(result.stdout || "").trim().split("\n").filter(Boolean);
  try {
    return lines.length ? JSON.parse(lines.at(-1)) : {};
  } catch {
    return {summary: String(result.stdout || "AI model agent completed execution.").slice(-2000)};
  }
}

function createExecutorOutputReporter(config, dispatchPackage) {
  let lastAt = 0;
  let tail = "";
  return (stream, chunk) => {
    tail = `${tail}${chunk}`.slice(-2000);
    if (Date.now() - lastAt < 1500) return;
    lastAt = Date.now();
    submitExecutionEvent(config, dispatchPackage, "executor_output", {
      progressPercent: 45,
      summary: `${stream} output received from model executor.`,
      outputTailDigest: sha256(tail),
      payload: {stream, tail: tail.slice(-500)}
    }).catch(() => {});
  };
}

function spawnAndCapture(commandName, commandArgs, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(commandName, commandArgs, {cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32"});
    options.control?.attachChild(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout = boundedOutputAppend(stdout, text);
      options.onOutput?.("stdout", text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr = boundedOutputAppend(stderr, text);
      options.onOutput?.("stderr", text);
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      resolveResult({status: status ?? (signal ? 143 : 1), signal, stdout, stderr});
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function terminateChild(child, timeoutMs = 10000) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve({stopped: true, reason: "no_running_child"});
  const graceMs = Math.max(1000, Math.min(60000, Number(timeoutMs || 10000)));
  return new Promise((resolveStop) => {
    let resolved = false;
    const finish = (status, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(killTimer);
      clearTimeout(giveUpTimer);
      resolveStop({stopped: true, status: status ?? null, signal: signal || null});
    };
    const killTimer = setTimeout(() => {
      killChildProcessGroup(child, "SIGKILL");
    }, graceMs);
    const giveUpTimer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      resolveStop({stopped: false, reason: "child_stop_timeout"});
    }, graceMs + 10000);
    child.once("close", finish);
    killChildProcessGroup(child, "SIGTERM");
  });
}

function killChildProcessGroup(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch (error) {
    if (error.code !== "ESRCH") process.stderr.write(`process group ${signal} failed: ${error.message}\n`);
  }
  try {
    child.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") process.stderr.write(`child ${signal} failed: ${error.message}\n`);
  }
}

function boundedOutputAppend(current, chunk) {
  return `${current}${chunk}`.slice(-(32 * 1024 * 1024));
}

function runKnownModelCli(model, prompt, cwd, env, control, onOutput) {
  const provider = providerClassForModel(model);
  const modelId = modelIdForProvider(model);
  const reasoning = reasoningForCli(model?.reasoning || model?.reasoningLevel || "", provider);
  if (["openai", "azure_openai"].includes(provider) && commandAvailable("codex")) {
    const args = ["exec", "--full-auto", "-C", cwd];
    if (modelId) args.push("--model", modelId);
    if (reasoning) args.push("--config", `model_reasoning_effort=${JSON.stringify(reasoning)}`);
    args.push(prompt);
    return spawnAndCapture("codex", args, {cwd, env, control, onOutput});
  }
  if (["anthropic", "aws_bedrock"].includes(provider) && commandAvailable("claude")) {
    const args = ["-p", "--permission-mode", "acceptEdits"];
    if (modelId) args.push("--model", modelId);
    if (reasoning) args.push("--effort", reasoning === "standard" ? "low" : reasoning);
    args.push(prompt);
    return spawnAndCapture("claude", args, {cwd, env, control, onOutput});
  }
  if (["google", "vertex_ai"].includes(provider) && commandAvailable("gemini")) {
    const args = [];
    if (modelId) args.push("--model", modelId);
    args.push("-p", prompt, "-y");
    return spawnAndCapture("gemini", args, {cwd, env, control, onOutput});
  }
  if (provider === "ollama" && commandAvailable("ollama")) {
    const ollamaModel = modelId || process.env.AIMAC_OLLAMA_MODEL;
    if (!ollamaModel) throw new Error("ollama execution requires a modelId or AIMAC_OLLAMA_MODEL");
    return spawnAndCapture("ollama", ["run", ollamaModel], {cwd, env, input: prompt, control, onOutput});
  }
  throw new Error(`no installed AI executor for provider ${provider}; configure --executor-command`);
}

function providerClassForModel(model = {}) {
  return String(model.providerClass || model.alias || String(model.modelId || model.model || "").split(":")[0] || "custom");
}

function modelIdForProvider(model = {}) {
  const provider = providerClassForModel(model);
  const raw = String(model.modelId || model.model || "").trim();
  if (!raw) return "";
  const prefix = `${provider}:`;
  const stripped = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  return stripped === "auto" ? "" : stripped;
}

function rawReasoningLevel(value) {
  return String(value || "").toLowerCase().trim();
}

function reasoningForCli(value, provider = "") {
  const normalized = String(value || "").toLowerCase().trim();
  if (["minimal", "low", "medium", "high"].includes(normalized)) return normalized;
  if (["xhigh", "max"].includes(normalized)) return provider === "anthropic" || provider === "aws_bedrock" ? normalized : "high";
  if (normalized === "ultra") return provider === "anthropic" || provider === "aws_bedrock" ? "max" : "high";
  if (["standard", "normal"].includes(normalized)) return "low";
  return "";
}

function syncSkillWorkset(config, dispatchPackage) {
  const expected = dispatchPackage.skillWorkset;
  const directory = join(config.skillCacheDir, expected.worksetId);
  const manifestPath = join(directory, "skill-workset.json");
  let workset = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  if (!workset || workset.worksetDigest !== expected.worksetDigest || !verifySkillFiles(directory, workset.files || [])) {
    workset = syncJson(`${config.serverUrl}${expected.downloadPath}`, config.nodeToken);
    if (workset.worksetDigest !== expected.worksetDigest) throw new Error("skill workset digest mismatch");
    mkdirSync(directory, {recursive: true});
    for (const file of workset.files || []) {
      const target = resolve(directory, normalize(file.path));
      if (!inside(directory, target)) throw new Error("skill workset path escapes cache");
      if (sha256(file.content) !== file.contentDigest) throw new Error(`skill file digest mismatch: ${file.path}`);
      mkdirSync(dirname(target), {recursive: true});
      writeFileSync(target, file.content, {mode: 0o600});
    }
    writeSecretJson(manifestPath, {...workset, files: workset.files.map(({content: _content, ...file}) => file)});
  }
  return {...workset, directory, manifestPath};
}

function prepareRepository(config, target) {
  const repositoryRoot = join(config.repositoryDir, safeName(target.repositoryId));
  if (!existsSync(join(repositoryRoot, ".git"))) {
    if (!target.repositoryUrl || target.repositoryUrl.startsWith("git:unknown")) throw new Error("dispatch repository URL is not cloneable");
    mkdirSync(dirname(repositoryRoot), {recursive: true});
    execFileSync("git", ["clone", target.repositoryUrl, repositoryRoot], {stdio: "pipe"});
  }
  const remote = target.remote || "origin";
  const configuredUrl = git(repositoryRoot, ["remote", "get-url", remote]);
  if (configuredUrl !== target.repositoryUrl) throw new Error("local repository remote does not match dispatch target");
  git(repositoryRoot, ["fetch", "--prune", remote]);
  const remoteBranch = `${remote}/${target.branch}`;
  let checkoutBase = remoteBranch;
  try {
    git(repositoryRoot, ["checkout", "-B", target.branch, remoteBranch]);
  } catch {
    checkoutBase = target.baseRef;
    git(repositoryRoot, ["checkout", "-B", target.branch, target.baseRef]);
  }
  git(repositoryRoot, ["reset", "--hard", checkoutBase]);
  return repositoryRoot;
}

function buildExecutionPrompt(config, dispatchPackage, workset, packagePath) {
  const contract = dispatchPackage.taskContract;
  const model = contract.model || {};
  if (!model.modelDecision || !(model.model || model.modelId) || !(model.reasoning || model.reasoningLevel)) {
    throw new Error("dispatch model, reasoning and modelDecision are required");
  }
  const languagePolicy = contract.languagePolicy || {};
  const languageTag = languagePolicy.languageTag || "zh-CN";
  const languageName = languagePolicy.languageName || languageTag;
  const repositoryTarget = dispatchPackage.repositoryOutputTarget || {};
  const readLocators = uniqueStrings([
    "AGENTS.md",
    ...(contract.inputLocators || []),
    `package:${packagePath}`,
    `skill-manifest:${workset.manifestPath}`
  ]);
  const writeSet = repositoryTarget.pathAllowlist?.length ? repositoryTarget.pathAllowlist : ["<repositoryOutputTarget.pathAllowlist>"];
  const gates = contract.actionBasis?.validationRequirements?.length ? contract.actionBasis.validationRequirements : ["schema_valid", "checkpoint_registered", "repository_output_target_selected"];
  const doNot = uniqueStrings([...(contract.actionBasis?.forbiddenActions || []), "do not expand graph", "return to owner if writeSet/dependency changes"]);
  return [
    "DISPATCH v1",
    "ruleset: 2026-07-23.33",
    `model: ${model.model || model.modelId}`,
    `reasoning: ${model.reasoning || model.reasoningLevel}`,
    modelDecisionLine(model.modelDecision),
    `language: ${languageTag}`,
    `languagePolicy: required; use ${languageName}/${languageTag} for role interaction, instructions, execution events, checkpoints, repository outputs and review material`,
    "",
    `node: ${contract.workId}`,
    `graph: ${contract.taskGroupId}`,
    `base: state@${contract.stateVersion} contract@${contract.contractDigest} repo@${repositoryTarget.targetId}`,
    "writeSet:",
    ...writeSet.map((item) => `- ${item}`),
    "",
    "read:",
    ...readLocators.map((item) => `- ${item}`),
    "",
    "do:",
    `- implement only ${contract.workId}`,
    "- run stated focused gates",
    "- commit/push task-owned checkpoint when stable",
    `- load skill workset ${workset.manifestPath}`,
    `- use only the centralized remote MCP ${config.gateway.mcpUrl || `${config.serverUrl}${dispatchPackage.remoteServices.mcpPath}`}`,
    `- keep all task-facing output in ${languageTag}`,
    "",
    "doNot:",
    ...doNot.map((item) => `- ${item}`),
    "- do not start or install any local MCP server",
    "",
    "gate:",
    ...gates.map((item) => `- ${item}`),
    "",
    "return:",
    "- status",
    "- changed paths",
    "- commits",
    "- commands/results",
    "- blockers or expansion request"
  ].join("\n");
}

function modelDecisionLine(value) {
  const text = String(value || "").trim();
  return text.startsWith("modelDecision:") ? text : `modelDecision: ${text}`;
}

function writeArtifactManifest(repositoryRoot, manifestPath, dispatchPackage, outputRefs, output) {
  const target = resolve(repositoryRoot, normalize(manifestPath));
  if (!inside(repositoryRoot, target)) throw new Error("artifact manifest path escapes repository");
  mkdirSync(dirname(target), {recursive: true});
  const manifest = {
    schemaVersion: "artifact-manifest/v1",
    projectId: dispatchPackage.taskContract.projectId,
    taskGroupId: dispatchPackage.taskContract.taskGroupId,
    workId: dispatchPackage.taskContract.workId,
    sessionId: dispatchPackage.taskContract.sessionId,
    dispatchId: dispatchPackage.dispatch.dispatchId,
    repositoryOutputTargetRefs: [dispatchPackage.repositoryOutputTarget.targetId],
    taskContractDigest: dispatchPackage.taskContract.contractDigest,
    languagePolicy: dispatchPackage.taskContract.languagePolicy,
    languagePolicyDigest: dispatchPackage.taskContract.languagePolicyDigest,
    outputPolicy: "project_git_repository_only",
    generatedBy: "aimac-agent-runtime",
    model: dispatchPackage.taskContract.model,
    roleSkill: dispatchPackage.taskContract.roleSkill,
    outputRefs,
    verificationRefs: output.verificationRefs || [],
    createdAt: new Date().toISOString()
  };
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
}

function writeAgentScopedMcpConfig(config, profile) {
  const generatedDir = join(config.workDir, "mcp-client-configs");
  mkdirSync(generatedDir, {recursive: true});
  const remote = {url: config.gateway.mcpUrl, headers: {Authorization: `Bearer ${config.nodeToken}`}};
  writeSecretJson(join(generatedDir, "mcp-server.json"), {
    generatedBy: "aimac-agent-runtime",
    schemaVersion: "aimac-agent-remote-mcp-config/v1",
    serverName: "ai-multi-agent-ctrl",
    transport: "streamable-http",
    hostedBy: config.serverUrl,
    nodeId: config.nodeId,
    projectIds: config.projectIds,
    allowedRoles: config.allowedRoles,
    detectedClients: (profile.tools || []).filter((tool) => ["codex", "claude", "cursor"].includes(tool.name) && tool.available).map((tool) => tool.name),
    mcpServers: {ai_multi_agent_ctrl: remote}
  });
  writeFileSync(join(generatedDir, "codex_config.toml"), [
    "# BEGIN ai-multi-agent-ctrl REMOTE MCP",
    "[mcp_servers.ai_multi_agent_ctrl]",
    `url = ${JSON.stringify(config.gateway.mcpUrl)}`,
    `http_headers = { Authorization = ${JSON.stringify(`Bearer ${config.nodeToken}`)} }`,
    "# END ai-multi-agent-ctrl REMOTE MCP",
    ""
  ].join("\n"), {mode: 0o600});
  writeSecretJson(join(generatedDir, "claude_desktop_config.json"), {mcpServers: {"ai_multi_agent_ctrl": remote}});
  writeSecretJson(join(generatedDir, "cursor_mcp.json"), {mcpServers: {"ai_multi_agent_ctrl": remote}});
}

function configureGlobalRemoteMcpClients(config, profile) {
  const clients = new Set((profile.tools || []).filter((tool) => tool.available).map((tool) => tool.name));
  const remote = {url: config.gateway.mcpUrl, headers: {Authorization: `Bearer ${config.nodeToken}`}};
  if (clients.has("codex")) {
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    const path = join(codexHome, "config.toml");
    const block = ["# BEGIN ai-multi-agent-ctrl REMOTE MCP", "[mcp_servers.ai_multi_agent_ctrl]", `url = ${JSON.stringify(config.gateway.mcpUrl)}`, `http_headers = { Authorization = ${JSON.stringify(`Bearer ${config.nodeToken}`)} }`, "# END ai-multi-agent-ctrl REMOTE MCP"].join("\n");
    replaceMarkedText(path, "# BEGIN ai-multi-agent-ctrl REMOTE MCP", "# END ai-multi-agent-ctrl REMOTE MCP", block);
  }
  if (clients.has("claude")) mergeMcpJson(join(homedir(), ".claude", "mcp.json"), remote);
  if (clients.has("cursor")) mergeMcpJson(join(homedir(), ".cursor", "mcp.json"), remote);
}

function mergeMcpJson(path, remote) {
  const current = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  current.mcpServers ||= {};
  current.mcpServers.ai_multi_agent_ctrl = remote;
  writeSecretJson(path, current);
}

function replaceMarkedText(path, start, end, block) {
  const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
  const startIndex = previous.indexOf(start);
  const endIndex = previous.indexOf(end);
  const next = startIndex >= 0 && endIndex > startIndex
    ? `${previous.slice(0, startIndex).trimEnd()}\n\n${block}\n${previous.slice(endIndex + end.length).trimStart()}`.trimStart()
    : `${previous.trimEnd()}\n\n${block}\n`.trimStart();
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, next.endsWith("\n") ? next : `${next}\n`, {mode: 0o600});
}

function verifyPackageBinding(config, value) {
  if (value.nodeBinding?.nodeId !== config.nodeId) throw new Error("dispatch package node binding mismatch");
  if (value.dispatch?.taskContractDigest !== value.taskContract?.contractDigest) throw new Error("dispatch task contract digest mismatch");
  if (value.skillWorkset?.worksetId !== value.taskContract?.roleSkill?.worksetId) throw new Error("dispatch skill workset binding mismatch");
}

function verifySkillFiles(directory, files) {
  return files.every((file) => {
    const target = resolve(directory, normalize(file.path));
    return inside(directory, target) && existsSync(target) && sha256(readFileSync(target, "utf8")) === file.contentDigest;
  });
}

function probeProfile(executorCommand = "") {
  const tools = ["git", "node", "npm", "docker", "codex", "claude", "gemini", "ollama"].map((name) => executableVersion(name, ["--version"]));
  const models = [];
  if (tools.find((tool) => tool.name === "codex")?.available) models.push({providerClass: "openai", adapter: "codex", available: true}, {providerClass: "azure_openai", adapter: "codex", available: true});
  if (tools.find((tool) => tool.name === "claude")?.available) models.push({providerClass: "anthropic", adapter: "claude", available: true}, {providerClass: "aws_bedrock", adapter: "claude", available: true});
  if (tools.find((tool) => tool.name === "gemini")?.available) models.push({providerClass: "google", adapter: "gemini", available: true}, {providerClass: "vertex_ai", adapter: "gemini", available: true});
  if (tools.find((tool) => tool.name === "ollama")?.available) models.push({providerClass: "ollama", adapter: "ollama", available: true});
  if (executorCommand) models.push({providerClass: "custom", adapter: "custom_command", available: true});
  if (!models.length) models.push({providerClass: "custom", adapter: "unconfigured", available: false});
  const capabilityFlags = ["git", "remote_mcp", "skill_workset_cache"];
  if (models.some((item) => item.available === true)) capabilityFlags.push("model_agent_executor");
  return {platform: platform(), arch: arch(), cpuCount: cpus().length, memoryBytes: totalmem(), diskFreeBytes: diskFree(workDir), tools, models, capabilityFlags};
}

function modelExecutorDetail(profile) {
  return (profile.models || [])
    .map((item) => `${item.providerClass}:${item.adapter}:${item.available === true ? "available" : "unavailable"}`)
    .join(",") || "no model executor detected";
}

function executableVersion(name, versionArgs) {
  const result = spawnSync(name, versionArgs, {encoding: "utf8", timeout: 5000});
  return {name, available: !result.error && result.status === 0, version: String(result.stdout || result.stderr || "unknown").trim().split("\n")[0].slice(0, 200)};
}

function commandAvailable(name) {
  return executableVersion(name, ["--version"]).available;
}

function diskFree(path) {
  try {
    const output = execFileSync("df", ["-Pk", existsSync(path) ? path : dirname(path)], {encoding: "utf8"}).trim().split("\n").at(-1);
    return Number(output.trim().split(/\s+/u)[3] || 0) * 1024;
  } catch {
    return 0;
  }
}

function writableDirectory(path) {
  try {
    mkdirSync(path, {recursive: true});
    const test = join(path, `.write-test-${process.pid}`);
    writeFileSync(test, "ok");
    renameSync(test, `${test}.done`);
    const ok = statSync(`${test}.done`).isFile();
    unlinkSync(`${test}.done`);
    return ok;
  } catch {
    return false;
  }
}

async function jsonRequest(url, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || process.env.AIMAC_AGENT_REQUEST_TIMEOUT_MS || 30000));
  const response = await fetch(url, {
    method: options.method || (options.body ? "POST" : "GET"),
    headers: {accept: "application/json", ...(options.body ? {"content-type": "application/json"} : {}), ...(options.token ? {authorization: `Bearer ${options.token}`} : {}), ...(options.headers || {})},
    ...(options.body ? {body: JSON.stringify(options.body)} : {}),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = {message: text}; }
  if (!response.ok) throw new Error(`${payload.error || "request_failed"}: ${payload.message || response.status}`);
  return payload;
}

async function retryableAgentRequest(fn, label) {
  const attempts = Number(process.env.AIMAC_AGENT_RETRY_ATTEMPTS || 4);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!retryableControlPlaneError(error) || attempt >= attempts) throw error;
      const waitMs = Math.min(2000, 150 * attempt + Math.floor(Math.random() * 150));
      process.stderr.write(`${label} retryable control-plane conflict; retry ${attempt}/${attempts} after ${waitMs}ms\n`);
      await delay(waitMs);
    }
  }
  throw new Error(`${label} retry exhausted`);
}

function retryableControlPlaneError(error) {
  const message = String(error?.message || error);
  return /state_write_conflict|AIMAC_STATE_CONFLICT|409/u.test(message);
}

function syncJson(url, token) {
  const result = spawnSync("curl", ["-fsSL", "--config", "-", url], {input: `header = "Authorization: Bearer ${token}"\n`, encoding: "utf8", maxBuffer: 32 * 1024 * 1024});
  if (result.error || result.status !== 0) throw new Error(`skill workset download failed: ${result.stderr || result.error?.message}`);
  return JSON.parse(result.stdout);
}

function loadConfig() {
  if (!existsSync(configPath)) throw new Error(`agent is not initialized: ${configPath}`);
  return JSON.parse(readFileSync(configPath, "utf8"));
}

function writeSecretJson(path, value) {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600});
}

function ensureCleanWorktree(root) {
  if (gitStatusPaths(root).length) throw new Error("agent repository worktree is not clean before dispatch");
}

function gitStatusPaths(root) {
  const raw = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return raw.split("\0").filter(Boolean).map((entry) => entry.slice(3)).map((path) => path.includes(" -> ") ? path.split(" -> ").at(-1) : path).sort();
}

function configureGitIdentity(root) {
  try { git(root, ["config", "user.email"]); } catch { git(root, ["config", "user.email", "aimac-agent@local"]); }
  try { git(root, ["config", "user.name"]); } catch { git(root, ["config", "user.name", "AI Multi-Agent Runtime"]); }
}

function git(root, gitArgs) {
  return execFileSync("git", ["-C", root, ...gitArgs], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024}).trim();
}

function gitLsRemote(root, remote, ref) {
  return git(root, ["ls-remote", remote, ref]).split(/\s+/u)[0] || "";
}

function assertAllowedPaths(paths, target) {
  const allowlist = target.pathAllowlist || [];
  const forbidden = target.forbiddenPathRules || [];
  for (const path of paths) {
    if (path.startsWith("/") || path.split("/").includes("..") || !allowlist.some((rule) => pathMatches(rule, path))) throw new Error(`repository path outside dispatch allowlist: ${path}`);
    if (forbidden.some((rule) => pathMatches(rule, path))) throw new Error(`repository path forbidden for runtime dispatch: ${path}`);
  }
}

function pathMatches(rule, path) {
  if (rule.endsWith("/**")) return path === rule.slice(0, -3) || path.startsWith(rule.slice(0, -2));
  return rule === path;
}

function parseArgs(argv) {
  const result = {_ : []};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) result._.push(arg);
    else if (arg.includes("=")) result[arg.slice(2, arg.indexOf("="))] = arg.slice(arg.indexOf("=") + 1);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) result[arg.slice(2)] = argv[++index];
    else result[arg.slice(2)] = true;
  }
  return result;
}

function splitCsv(value) {
  return value ? String(value).split(",").map((item) => item.trim()).filter(Boolean) : undefined;
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((item) => String(item || "").trim()).filter(Boolean))];
}

function globalClientConfigurationEnabled() {
  return [args["configure-global-clients"], args["configure-clients"]].some((value) => value === true || value === "true") ||
    process.env.AIMAC_AGENT_CONFIGURE_GLOBAL_CLIENTS === "true" || process.env.AIMAC_AGENT_CONFIGURE_CLIENTS === "true";
}

function readJoinToken() {
  if (args["join-token-file"]) return readFileSync(resolve(String(args["join-token-file"])), "utf8").trim();
  return String(args["join-token"] || process.env.AIMAC_AGENT_JOIN_TOKEN || "").trim();
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/gu, "_");
}

function trimSlash(value) {
  return String(value).replace(/\/+$/u, "");
}

function requireSecureServerUrl(url) {
  const parsed = new URL(url);
  const local = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local) && process.env.AIMAC_AGENT_ALLOW_INSECURE_HTTP !== "true") throw new Error("public Agent Gateway requires HTTPS; set AIMAC_AGENT_ALLOW_INSECURE_HTTP=true only for isolated verification");
}

function inside(root, target) {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target === root || target.startsWith(prefix);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function check(checkId, ok, detail) {
  return {checkId, status: ok ? "ok" : "failed", detail};
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
