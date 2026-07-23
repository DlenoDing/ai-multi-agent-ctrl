#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
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
  const joinToken = args["join-token"] || process.env.AIMAC_AGENT_JOIN_TOKEN || "";
  if (!serverUrl || !joinToken) throw new Error("bootstrap requires --server and --join-token");
  requireSecureServerUrl(serverUrl);
  const configuredExecutor = args["executor-command"] || process.env.AIMAC_AGENT_EXECUTOR_COMMAND || "";
  const profile = probeProfile(configuredExecutor);
  const registration = await jsonRequest(`${serverUrl}/api/agent/v1/register`, {
    method: "POST",
    token: joinToken,
    body: {
      nodeName: args["node-name"] || process.env.AIMAC_AGENT_NODE_NAME || hostname(),
      requestedRoles: splitCsv(args.roles),
      runtimeVersion: RUNTIME_VERSION,
      profile
    }
  });
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
  if (clientConfigurationEnabled()) configureRemoteMcpClients(config, profile);
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
  checks.push(check("runtime", Number(process.versions.node.split(".")[0]) >= 20, `node ${process.versions.node}; runtime ${RUNTIME_VERSION}`));
  checks.push(check("filesystem", writableDirectory(config.workDir), config.workDir));
  checks.push(check("git", executableVersion("git", ["--version"]).available, executableVersion("git", ["--version"]).version));
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
  const result = await jsonRequest(config.gateway.selfCheckUrl, {method: "POST", token: config.nodeToken, body: {checks, runtimeVersion: RUNTIME_VERSION}});
  process.stdout.write(`agent self-check: ${result.ok ? "ok" : "failed"}\n`);
  return result;
}

async function status(config) {
  const result = await jsonRequest(`${config.serverUrl}/api/agent/v1/nodes/me`, {token: config.nodeToken});
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function run(config) {
  let lastHeartbeat = 0;
  const once = args.once === true || process.env.AIMAC_AGENT_ONCE === "true";
  for (;;) {
    await flushCheckpointOutbox(config);
    if (Date.now() - lastHeartbeat >= config.heartbeatIntervalSeconds * 1000) {
      const currentProfile = probeProfile(config.executorCommand);
      const heartbeat = await jsonRequest(config.gateway.heartbeatUrl, {method: "POST", token: config.nodeToken, body: {profile: currentProfile, runtimeVersion: RUNTIME_VERSION}});
      if (heartbeat.nodeToken) {
        config.nodeToken = heartbeat.nodeToken;
        writeSecretJson(configPath, config);
        if (clientConfigurationEnabled()) configureRemoteMcpClients(config, currentProfile);
      }
      lastHeartbeat = Date.now();
    }
    const claimed = await jsonRequest(config.gateway.dispatchUrl, {method: "POST", token: config.nodeToken, body: {claimTtlSeconds: Number(args["claim-ttl"] || 1800)}});
    if (claimed.dispatch) {
      try {
        const checkpoint = executeDispatch(config, claimed.dispatch);
        const outboxPath = persistCheckpointOutbox(config, claimed.dispatch, checkpoint);
        if (process.env.AIMAC_AGENT_VERIFICATION_DEFER_CHECKPOINT === "true") {
          process.stdout.write(`checkpoint intentionally deferred for verification: ${claimed.dispatch.dispatch.dispatchId}\n`);
        } else {
          try {
            const result = await submitCheckpoint(config, claimed.dispatch.remoteServices.checkpointPath, checkpoint);
            unlinkSync(outboxPath);
            process.stdout.write(`dispatch completed: ${claimed.dispatch.dispatch.dispatchId} checkpoint=${result.checkpoint?.runId || "accepted"}\n`);
          } catch (error) {
            process.stderr.write(`checkpoint pending retry: ${claimed.dispatch.dispatch.dispatchId} ${error.message}\n`);
          }
        }
      } catch (error) {
        await jsonRequest(`${config.serverUrl}${claimed.dispatch.remoteServices.failurePath}`, {method: "POST", token: config.nodeToken, body: {reason: String(error.message || error).slice(0, 2000)}}).catch(() => {});
        process.stderr.write(`dispatch failed: ${claimed.dispatch.dispatch.dispatchId} ${error.message}\n`);
      }
    }
    if (once) return;
    await delay(config.pollIntervalSeconds * 1000);
  }
}

async function flushCheckpointOutbox(config) {
  const outboxDir = config.outboxDir || join(config.workDir, "outbox");
  mkdirSync(outboxDir, {recursive: true});
  for (const filename of readdirSync(outboxDir).filter((name) => name.endsWith(".json")).sort()) {
    const path = join(outboxDir, filename);
    const item = JSON.parse(readFileSync(path, "utf8"));
    try {
      verifyCheckpointReplayRemote(config, item);
      await submitCheckpoint(config, item.checkpointPath, item.checkpoint);
      unlinkSync(path);
      process.stdout.write(`checkpoint replayed: ${item.dispatchId}\n`);
    } catch (error) {
      process.stderr.write(`checkpoint replay deferred: ${item.dispatchId} ${error.message}\n`);
    }
  }
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
  const currentRemoteSha = gitLsRemote(repositoryRoot, pushRef.remote || target.remote || "origin", pushRef.ref);
  if (currentRemoteSha !== pushRef.remoteSha) {
    throw new Error(`checkpoint replay recover_required: remote ref changed ${pushRef.ref}`);
  }
}

function submitCheckpoint(config, checkpointPath, checkpoint) {
  return jsonRequest(`${config.serverUrl}${checkpointPath}`, {method: "POST", token: config.nodeToken, body: checkpoint});
}

function executeDispatch(config, dispatchPackage) {
  verifyPackageBinding(config, dispatchPackage);
  const skillWorkset = syncSkillWorkset(config, dispatchPackage);
  const repositoryRoot = prepareRepository(config, dispatchPackage.repositoryOutputTarget);
  const taskRoot = join(config.taskDir, dispatchPackage.dispatch.dispatchId);
  mkdirSync(taskRoot, {recursive: true});
  const packagePath = join(taskRoot, "dispatch-package.json");
  const promptPath = join(taskRoot, "execution-prompt.txt");
  writeFileSync(packagePath, `${JSON.stringify(dispatchPackage, null, 2)}\n`, {mode: 0o600});
  writeFileSync(promptPath, buildExecutionPrompt(dispatchPackage, skillWorkset, packagePath), {mode: 0o600});
  ensureCleanWorktree(repositoryRoot);
  const before = git(repositoryRoot, ["rev-parse", "HEAD"]);
  const output = runModelExecutor(config, dispatchPackage, repositoryRoot, skillWorkset, packagePath, promptPath);
  const changedBeforeManifest = gitStatusPaths(repositoryRoot);
  if (!changedBeforeManifest.length) throw new Error("model agent produced no repository changes");
  assertAllowedPaths(changedBeforeManifest, dispatchPackage.repositoryOutputTarget);
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
  const branch = dispatchPackage.repositoryOutputTarget.branch;
  const remote = dispatchPackage.repositoryOutputTarget.remote || "origin";
  git(repositoryRoot, ["push", remote, `HEAD:refs/heads/${branch}`]);
  const remoteSha = gitLsRemote(repositoryRoot, remote, `refs/heads/${branch}`);
  if (remoteSha !== commit) throw new Error("remote push verification failed");
  const tree = git(repositoryRoot, ["rev-parse", `${commit}^{tree}`]);
  return {
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
    outputContractDigest: sha256("spec/checkpoint.schema.json"),
    createdAt: new Date().toISOString()
  };
}

function runModelExecutor(config, dispatchPackage, repositoryRoot, skillWorkset, packagePath, promptPath) {
  const env = {
    ...process.env,
    AIMAC_SERVER_URL: config.serverUrl,
    AIMAC_MCP_URL: config.gateway.mcpUrl,
    AIMAC_MCP_BEARER_TOKEN: config.nodeToken,
    AIMAC_AGENT_NODE_ID: config.nodeId,
    AIMAC_DISPATCH_PACKAGE_FILE: packagePath,
    AIMAC_TASK_CONTRACT_FILE: packagePath,
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
    roleSkill: dispatchPackage.taskContract.roleSkill,
    skillWorksetDir: skillWorkset.directory,
    taskContract: dispatchPackage.taskContract,
    effectiveInstructionPacket: dispatchPackage.effectiveInstructionPacket,
    repositoryOutputTarget: dispatchPackage.repositoryOutputTarget,
    remoteMcp: {url: config.gateway.mcpUrl, bearerTokenEnv: "AIMAC_MCP_BEARER_TOKEN"},
    requiredOutputs: ["repository_changes", "verification", "artifact_manifest_inputs"]
  };
  let result;
  if (config.executorCommand) {
    result = spawnSync("sh", ["-c", config.executorCommand], {cwd: repositoryRoot, env, input: `${JSON.stringify(executorInput)}\n`, encoding: "utf8", maxBuffer: 32 * 1024 * 1024});
  } else {
    result = runKnownModelCli(dispatchPackage.taskContract.model, readFileSync(promptPath, "utf8"), repositoryRoot, env);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`model executor exited ${result.status}: ${String(result.stderr || result.stdout || "").slice(-4000)}`);
  const lines = String(result.stdout || "").trim().split("\n").filter(Boolean);
  try {
    return lines.length ? JSON.parse(lines.at(-1)) : {};
  } catch {
    return {summary: String(result.stdout || "AI model agent completed execution.").slice(-2000)};
  }
}

function runKnownModelCli(model, prompt, cwd, env) {
  const provider = model?.alias || String(model?.modelId || "").split(":")[0];
  if (["openai", "azure_openai"].includes(provider) && commandAvailable("codex")) return spawnSync("codex", ["exec", "--full-auto", "-C", cwd, prompt], {cwd, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024});
  if (["anthropic", "aws_bedrock"].includes(provider) && commandAvailable("claude")) return spawnSync("claude", ["-p", "--permission-mode", "acceptEdits", prompt], {cwd, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024});
  if (["google", "vertex_ai"].includes(provider) && commandAvailable("gemini")) return spawnSync("gemini", ["-p", prompt, "-y"], {cwd, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024});
  if (provider === "ollama" && commandAvailable("ollama")) {
    const modelId = String(model?.modelId || "").replace(/^ollama:/u, "") || process.env.AIMAC_OLLAMA_MODEL;
    if (!modelId) throw new Error("ollama execution requires a modelId or AIMAC_OLLAMA_MODEL");
    return spawnSync("ollama", ["run", modelId], {cwd, env, input: prompt, encoding: "utf8", maxBuffer: 32 * 1024 * 1024});
  }
  throw new Error(`no installed AI executor for provider ${provider}; configure --executor-command`);
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

function buildExecutionPrompt(dispatchPackage, workset, packagePath) {
  return [
    `You are the ${dispatchPackage.taskContract.roleId} execution agent for work item ${dispatchPackage.taskContract.workId}.`,
    `Use the explicitly assigned model contract: provider=${dispatchPackage.taskContract.model.providerClass || dispatchPackage.taskContract.model.alias}, modelId=${dispatchPackage.taskContract.model.modelId}, modelTier=${dispatchPackage.taskContract.model.modelTier || "standard"}, reasoningLevel=${dispatchPackage.taskContract.model.reasoningLevel}, maxReasoningLevel=${dispatchPackage.taskContract.model.maxReasoningLevel || "high"}. Do not inherit any previous model or reasoning defaults.`,
    dispatchPackage.skillWorkset.executionDirective,
    `Load the skill manifest at ${workset.manifestPath} and every listed skill file before acting.`,
    `The authoritative task package is ${packagePath}.`,
    `Use only the remote MCP server ${dispatchPackage.remoteServices.mcpPath}; do not start or install any local MCP server.`,
    "Keep all task outputs in the assigned Git repository and within repositoryOutputTarget.pathAllowlist.",
    "Do not modify control-plane rules, scheduler policy, permissions, or skills during task execution.",
    "Run the required verification and leave the repository with task output changes ready for the runtime to commit and push."
  ].join("\n");
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

function configureRemoteMcpClients(config, profile) {
  const clients = new Set((profile.tools || []).filter((tool) => tool.available).map((tool) => tool.name));
  const generatedDir = join(config.workDir, "mcp-client-configs");
  mkdirSync(generatedDir, {recursive: true});
  const remote = {url: config.gateway.mcpUrl, headers: {Authorization: `Bearer ${config.nodeToken}`}};
  writeSecretJson(join(generatedDir, "mcp-server.json"), {mcpServers: {ai_multi_agent_ctrl: remote}});
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
  return {platform: platform(), arch: arch(), cpuCount: cpus().length, memoryBytes: totalmem(), diskFreeBytes: diskFree(workDir), tools, models, capabilityFlags: ["git", "remote_mcp", "skill_workset_cache", "model_agent_executor"]};
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
  const response = await fetch(url, {
    method: options.method || (options.body ? "POST" : "GET"),
    headers: {accept: "application/json", ...(options.body ? {"content-type": "application/json"} : {}), ...(options.token ? {authorization: `Bearer ${options.token}`} : {}), ...(options.headers || {})},
    ...(options.body ? {body: JSON.stringify(options.body)} : {})
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = {message: text}; }
  if (!response.ok) throw new Error(`${payload.error || "request_failed"}: ${payload.message || response.status}`);
  return payload;
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

function clientConfigurationEnabled() {
  return args["configure-clients"] === "true" || process.env.AIMAC_AGENT_CONFIGURE_CLIENTS === "true";
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
