#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = mkdtempSync(join(tmpdir(), "aimac-mcp-runtime-doctor-"));
const configDir = mkdtempSync(join(tmpdir(), "aimac-mcp-runtime-config-"));
const doctorRepo = setupDoctorRepository(root);

const registerResult = spawnSync(process.execPath, [
  join(root, "scripts", "register-mcp-client.mjs"),
  `--runtime-dir=${runtimeDir}`,
  `--output-dir=${configDir}`
], {
  cwd: root,
  encoding: "utf8",
  stdio: "pipe"
});
if (registerResult.status !== 0) {
  throw new Error(`mcp register failed: ${(registerResult.stderr || registerResult.stdout || "").trim()}`);
}

const generatedConfig = JSON.parse(readFileSync(join(configDir, "mcp-server.json"), "utf8"));
const serverConfig = generatedConfig.mcpServers["ai-multi-agent-ctrl"];
const server = spawn(serverConfig.command, serverConfig.args, {
  cwd: root,
  env: {
    ...process.env,
    ...serverConfig.env,
    AIMAC_REPOSITORY_ROOT: doctorRepo.work,
    AIMAC_STATE_STORE: "runtime_json",
    DATABASE_URL: "",
    AIMAC_EXECUTION_PROFILE: "verification",
    AIMAC_MCP_ENABLE_RUNTIME_RUN: "true",
    AIMAC_AGENT_RUNTIME_EXECUTOR_COMMAND: doctorRepo.executorCommand,
    OPENAI_API_KEY: "doctor-mcp-runtime-provider-key"
  },
  stdio: ["pipe", "pipe", "pipe"]
});

let nextId = 1;
let stdoutBuffer = "";
let stderrBuffer = "";
const pending = new Map();

server.stdout.setEncoding("utf8");
server.stderr.setEncoding("utf8");
server.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  let newlineIndex = stdoutBuffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = stdoutBuffer.slice(0, newlineIndex).trim();
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    if (line) handleResponseLine(line);
    newlineIndex = stdoutBuffer.indexOf("\n");
  }
});
server.stderr.on("data", (chunk) => {
  stderrBuffer += chunk;
});
server.on("exit", (code, signal) => {
  for (const {reject} of pending.values()) {
    reject(new Error(`mcp runtime doctor server exited before response; code=${code}; signal=${signal}; stderr=${stderrBuffer.trim()}`));
  }
  pending.clear();
});

function handleResponseLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    throw new Error(`invalid MCP JSON response: ${error.message}: ${line.slice(0, 120)}`);
  }
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(`${message.error.message || "mcp_error"}:${JSON.stringify(message.error)}`));
  else entry.resolve(message.result);
}

function request(method, params = {}) {
  const id = nextId++;
  const payload = {jsonrpc: "2.0", id, method, params};
  return new Promise((resolveRequest, rejectRequest) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      rejectRequest(new Error(`timeout waiting for ${method}; stderr=${stderrBuffer.trim()}`));
    }, 30000);
    pending.set(id, {
      resolve: (result) => {
        clearTimeout(timeout);
        resolveRequest(result);
      },
      reject: (error) => {
        clearTimeout(timeout);
        rejectRequest(error);
      }
    });
    server.stdin.write(`${JSON.stringify(payload)}\n`);
  });
}

function git(repoRoot, args, fallback = "") {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {encoding: "utf8"}).trim();
  } catch {
    return fallback;
  }
}

function setupDoctorRepository(projectRoot) {
  const base = mkdtempSync(join(tmpdir(), "aimac-mcp-runtime-git-"));
  const remote = join(base, "remote.git");
  const work = join(base, "work");
  execFileSync("git", ["init", "--bare", remote], {stdio: "pipe"});
  execFileSync("git", ["init", "-b", "main", work], {stdio: "pipe"});
  git(work, ["config", "user.email", "doctor-mcp-runtime@local"]);
  git(work, ["config", "user.name", "MCP Runtime Doctor"]);
  writeFileSync(join(work, "README.md"), "# MCP Runtime Doctor Repository\n");
  writeFileSync(join(work, ".aimac-verification-repository"), "verification\n");
  git(work, ["add", "README.md", ".aimac-verification-repository"]);
  git(work, ["commit", "-m", "Initialize MCP runtime doctor repository"]);
  git(work, ["remote", "add", "origin", remote]);
  git(work, ["push", "origin", "HEAD:refs/heads/main"]);
  const executorPath = join(base, "doctor-mcp-runtime-executor.mjs");
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
  \`MCP dispatch: \${input.dispatchId}\`,
  \`MCP session: \${input.sessionId}\`,
  \`MCP model: \${input.model.modelId}\`,
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
  generatedBy: "doctor-mcp-runtime-executor",
  model: input.model,
  roleSkill: input.roleSkill,
  outputRefs: [outputPath],
  createdAt: new Date().toISOString()
}, null, 2) + "\\n");
console.log(JSON.stringify({
  summary: "MCP runtime_run doctor produced git-backed output.",
  artifactManifestRefs: [manifestPath],
  changedPaths: [outputPath],
  evidenceRefs: ["executor:doctor-mcp-runtime-called"],
  commitMessage: \`MCP runtime_run output for \${input.workId}\`
}));
`);
  return {base, remote, work, executorCommand: `node ${JSON.stringify(executorPath)}`, projectRoot};
}

async function main() {
  const initialized = await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: {name: "aimac-mcp-runtime-doctor", version: "0.1.0"}
  });
  if (!initialized.capabilities?.tools) throw new Error("mcp initialize did not advertise tools capability");

  const run = await request("tools/call", {
    name: "orchestration-mcp.orchestrator_run",
    arguments: {
      idempotencyKey: "doctor-mcp-runtime-orchestrator",
      taskGroupId: "tg_runtime_management",
      mode: "single",
      autoSyncSkills: false,
      repositoryRoot: doctorRepo.work
    }
  });
  const changed = run.structuredContent?.result?.changed || [];
  const dispatched = changed.find((item) => item.awaiting === "agent_runtime_checkpoint");
  if (run.isError || !dispatched?.sessionId || !dispatched.dispatchId) {
    throw new Error(`MCP orchestrator_run did not enqueue a dispatch: ${JSON.stringify(run.structuredContent?.result)}`);
  }

  const resources = await request("tools/call", {
    name: "resource-mcp.resource_snapshot",
    arguments: {taskGroupId: dispatched.taskGroupId}
  });
  const lease = resources.structuredContent?.result?.leases?.find((item) => item.status === "active" && item.holderRef === `session:${dispatched.sessionId}`);
  if (!lease?.leaseId || lease.fencingToken === undefined) {
    throw new Error("MCP runtime_run doctor could not find active session lease");
  }

  const runtimeRun = await request("tools/call", {
    name: "agent-control-mcp.runtime_run",
    arguments: {
      idempotencyKey: "doctor-mcp-runtime-run-enabled",
      taskGroupId: dispatched.taskGroupId,
      maxJobs: 1,
      leaseId: lease.leaseId,
      fencingToken: String(lease.fencingToken),
      holderRef: lease.holderRef,
      sessionId: dispatched.sessionId,
      repositoryRoot: doctorRepo.work
    }
  });
  const results = runtimeRun.structuredContent?.result?.results || [];
  if (runtimeRun.isError || !results.some((item) => item.status === "completed")) {
    throw new Error(`MCP runtime_run did not complete dispatch: ${JSON.stringify(runtimeRun.structuredContent?.result)}`);
  }

  const pushedCommit = git(doctorRepo.work, ["rev-parse", "HEAD"]);
  const pushedRemote = git(doctorRepo.work, ["ls-remote", "origin", "refs/heads/main"], "").split(/\s+/u)[0];
  if (!pushedCommit || pushedCommit !== pushedRemote) {
    throw new Error("MCP runtime_run did not push the committed artifact manifest");
  }
  const outputPath = join(doctorRepo.work, "docs", "agent-runtime-output", dispatched.taskGroupId, `${dispatched.workItemId}.md`);
  if (!existsSync(outputPath)) {
    throw new Error("MCP runtime_run did not persist executor output in the project git repository");
  }
  console.log("mcp runtime_run doctor ok: dispatch, executor, commit, push and checkpoint verified");
}

try {
  await main();
} finally {
  server.kill("SIGTERM");
  await Promise.race([once(server, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 1000))]).catch(() => {});
  rmSync(runtimeDir, {recursive: true, force: true});
  rmSync(configDir, {recursive: true, force: true});
  rmSync(doctorRepo.base, {recursive: true, force: true});
}
