#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mcpToolNames } from "../apps/mcp-server/server.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = mkdtempSync(join(tmpdir(), "aimac-mcp-doctor-"));
const configDir = mkdtempSync(join(tmpdir(), "aimac-mcp-config-doctor-"));
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
    AIMAC_REPOSITORY_ROOT: root,
    AIMAC_STATE_STORE: "runtime_json"
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
    reject(new Error(`mcp server exited before response; code=${code}; signal=${signal}; stderr=${stderrBuffer.trim()}`));
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
    }, 20000);
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

async function main() {
  const initialized = await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: {name: "aimac-mcp-doctor", version: "0.1.0"}
  });
  if (!initialized.capabilities?.tools) throw new Error("mcp initialize did not advertise tools capability");

  const listed = await request("tools/list");
  const listedNames = new Set((listed.tools || []).map((tool) => tool.name));
  const missingTools = mcpToolNames.filter((name) => !listedNames.has(name));
  if (missingTools.length) throw new Error(`mcp tools/list missing tools: ${missingTools.join(", ")}`);
  if ((listed.tools || []).length < 60) throw new Error(`mcp tools/list returned too few tools: ${(listed.tools || []).length}`);

  const health = await request("tools/call", {
    name: "ui-console-mcp.runtime_health_get",
    arguments: {}
  });
  if (health.isError || !health.structuredContent?.result?.health?.ok) throw new Error("runtime_health_get did not return healthy structured content");

  const fullState = await request("tools/call", {
    name: "orchestration-mcp.state_get",
    arguments: {scope: "full"}
  });
  if (!fullState.structuredContent?.result?.error?.includes("full_state_scope_not_allowed")) {
    throw new Error("state_get full scope was not denied by default");
  }

  const missingIdempotency = await request("tools/call", {
    name: "room-mcp.room_send",
    arguments: {roomId: "room_doctor", payload: {text: "must fail without idempotency"}}
  });
  if (!missingIdempotency.structuredContent?.result?.error?.includes("idempotency_key_required")) {
    throw new Error("write MCP call without idempotencyKey was not rejected");
  }

  const unknownInput = await request("tools/call", {
    name: "ui-console-mcp.runtime_health_get",
    arguments: {unknownProperty: true}
  });
  if (!unknownInput.structuredContent?.result?.error?.includes("mcp_input_unknown_property")) {
    throw new Error("MCP input schema did not reject unknown properties");
  }

  const missingRequiredArgument = await request("tools/call", {
    name: "model-mcp.model_select",
    arguments: {idempotencyKey: "doctor-model-select-missing-role", taskGroupId: "tg_runtime_management", workItemId: "work_ai_native_runtime"}
  });
  if (!missingRequiredArgument.structuredContent?.result?.error?.includes("mcp_required_argument_missing")) {
    throw new Error("MCP input schema did not reject missing required arguments");
  }

  const badRepositoryTarget = await request("tools/call", {
    name: "repository-mcp.repository_output_target_select",
    arguments: {idempotencyKey: "doctor-bad-repository-path", taskGroupId: "tg_runtime_management", workItemId: "work_bootstrap", artifactManifestPath: "/tmp/bad.json"}
  });
  if (!badRepositoryTarget.structuredContent?.result?.error?.includes("repository_output_target_must_use_git_trackable_paths")) {
    throw new Error("MCP repository target selection accepted a non-git-trackable path");
  }

  const stateBeforeDryRun = await request("tools/call", {
    name: "orchestration-mcp.state_get",
    arguments: {scope: "summary"}
  });
  const dryRun = await request("tools/call", {
    name: "room-mcp.room_send",
    arguments: {idempotencyKey: "doctor-room-dry-run", dryRun: true, roomId: "room_doctor", payload: {text: "dry run"}}
  });
  const stateAfterDryRun = await request("tools/call", {
    name: "orchestration-mcp.state_get",
    arguments: {scope: "summary"}
  });
  if (!dryRun.structuredContent?.result?.dryRun) throw new Error("write MCP dryRun did not return dryRun marker");
  if (stateBeforeDryRun.structuredContent?.stateVersion !== stateAfterDryRun.structuredContent?.stateVersion) {
    throw new Error("write MCP dryRun changed stateVersion");
  }

  const modelSelection = await request("tools/call", {
    name: "model-mcp.model_select",
    arguments: {idempotencyKey: "doctor-model-select", taskGroupId: "tg_runtime_management", workItemId: "work_ai_native_runtime", roleId: "orchestrator"}
  });
  if (modelSelection.isError || !modelSelection.structuredContent?.result?.selectedModel) throw new Error("model_select did not produce a selected model");

  const placement = await request("tools/call", {
    name: "scheduler-mcp.session_place",
    arguments: {idempotencyKey: "doctor-session-place", taskGroupId: "tg_runtime_management", workItemId: "work_ai_native_runtime", roleId: "orchestrator", workSignals: ["expected_multi_turn"]}
  });
  if (placement.isError || placement.structuredContent?.result?.placement !== "new_session") throw new Error("session_place did not choose new_session for sustained work");

  const roomSend = await request("tools/call", {
    name: "room-mcp.room_send",
    arguments: {idempotencyKey: "doctor-room-send", roomId: "room_doctor", payload: {text: "mcp doctor"}}
  });
  if (roomSend.isError || !roomSend.structuredContent?.result?.message?.messageId) throw new Error("room_send did not append a room message");

  const idempotencyConflict = await request("tools/call", {
    name: "room-mcp.room_send",
    arguments: {idempotencyKey: "doctor-room-send", roomId: "room_doctor", payload: {text: "different payload"}}
  });
  if (!idempotencyConflict.structuredContent?.result?.error?.includes("idempotency_key_reuse_conflict")) {
    throw new Error("MCP idempotency key reuse with different arguments was not rejected");
  }

  const target = await request("tools/call", {
    name: "repository-mcp.repository_output_target_select",
    arguments: {idempotencyKey: "doctor-repository-target", taskGroupId: "tg_runtime_management", workItemId: "work_bootstrap", artifactManifestPath: "docs/artifact-manifests/doctor-mcp.json"}
  });
  const targetId = target.structuredContent?.result?.repositoryOutputTarget?.targetId;
  if (!targetId) throw new Error("repository_output_target_select did not create a target");

  const firstLease = await request("tools/call", {
    name: "resource-mcp.lease_claim",
    arguments: {idempotencyKey: "doctor-lease-claim-1", repositoryOutputTargetRef: targetId, holderRef: "session:doctor-a"}
  });
  const lease = firstLease.structuredContent?.result?.lease;
  if (!lease?.fencingToken?.startsWith("fence-")) throw new Error("lease_claim did not create monotonic fencing token");

  const secondLease = await request("tools/call", {
    name: "resource-mcp.lease_claim",
    arguments: {idempotencyKey: "doctor-lease-claim-2", repositoryOutputTargetRef: targetId, holderRef: "session:doctor-b"}
  });
  if (!secondLease.structuredContent?.result?.error?.includes("lease_already_active")) {
    throw new Error("lease_claim allowed a second active holder");
  }

  const wrongRelease = await request("tools/call", {
    name: "resource-mcp.lease_release",
    arguments: {idempotencyKey: "doctor-lease-release-wrong", leaseId: lease.leaseId, holderRef: "session:doctor-a", fencingToken: "fence-000000000000"}
  });
  if (!wrongRelease.structuredContent?.result?.error?.includes("lease_fencing_token_mismatch")) {
    throw new Error("lease_release accepted wrong fencing token");
  }

  const missingFencingRelease = await request("tools/call", {
    name: "resource-mcp.lease_release",
    arguments: {idempotencyKey: "doctor-lease-release-missing-fence", leaseId: lease.leaseId, holderRef: "session:doctor-a"}
  });
  if (!missingFencingRelease.structuredContent?.result?.error?.includes("mcp_required_argument_missing")) {
    throw new Error("lease_release accepted a missing fencing token");
  }

  const runtimeRun = await request("tools/call", {
    name: "agent-control-mcp.runtime_run",
    arguments: {idempotencyKey: "doctor-runtime-run-disabled", taskGroupId: "tg_runtime_management"}
  });
  if (!runtimeRun.structuredContent?.result?.error?.includes("agent_runtime_worker_mcp_disabled")) {
    throw new Error("runtime_run was not blocked by default MCP runtime-run gate");
  }

  console.log(`mcp doctor ok: ${listed.tools.length} tools exposed and protocol calls verified`);
}

try {
  await main();
} finally {
  server.kill("SIGTERM");
  rmSync(runtimeDir, {recursive: true, force: true});
  rmSync(configDir, {recursive: true, force: true});
}
