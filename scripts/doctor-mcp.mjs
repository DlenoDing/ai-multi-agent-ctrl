import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(new URL("..", import.meta.url).pathname);
const port = await freePort();
const runtimeDir = mkdtempSync(join(tmpdir(), "aimac-mcp-doctor-runtime-"));
const configDir = mkdtempSync(join(tmpdir(), "aimac-mcp-doctor-config-"));
const token = "doctor-remote-mcp-service-token";
const baseUrl = `http://127.0.0.1:${port}`;
let requestId = 0;
const child = spawn(process.execPath, ["apps/control-plane-ui/server.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    AIMAC_HOST: "127.0.0.1",
    AIMAC_PORT: String(port),
    AIMAC_PUBLIC_URL: baseUrl,
    AIMAC_RUNTIME_DIR: runtimeDir,
    AIMAC_STATE_STORE: "runtime_json",
    AIMAC_EXECUTION_PROFILE: "production",
    AIMAC_MCP_SERVICE_TOKEN: token,
    AIMAC_BOOTSTRAP_TOKEN: "doctor-bootstrap-token",
    DATABASE_URL: ""
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

try {
  await waitForHealth();
  const unauthenticated = await fetch(`${baseUrl}/mcp`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "initialize", params: {}})});
  if (unauthenticated.status !== 401) throw new Error(`remote MCP did not reject unauthenticated request: ${unauthenticated.status}`);

  const initialized = await mcp("initialize", {protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {name: "doctor", version: "1"}});
  if (initialized.serverInfo?.name !== "ai-multi-agent-ctrl") throw new Error("remote MCP initialize failed");
  const listed = await mcp("tools/list", {});
  if (!Array.isArray(listed.tools) || listed.tools.length < 35) throw new Error("remote MCP service allowlist returned an incomplete integration surface");
  if (listed.tools.some((tool) => tool.name === "agent-control-mcp.runtime_run")) throw new Error("remote MCP still exposes server-side Agent execution");
  if (listed.tools.some((tool) => tool.name === "identity-mcp.grant_create" || tool.name === "governance-mcp.approval_request_create" || tool.name === "evidence-mcp.checkpoint_submit")) {
    throw new Error("remote MCP service token exposed high-risk admin or Agent checkpoint tools");
  }

  const health = await mcp("tools/call", {name: "ui-console-mcp.runtime_health_get", arguments: {}});
  if (health.isError || health.structuredContent?.result?.runtime?.mcp?.protocol !== "mcp/streamable-http") throw new Error("remote MCP health did not report centralized streamable HTTP");

  const unknownInput = await mcp("tools/call", {name: "ui-console-mcp.runtime_health_get", arguments: {unknownProperty: true}});
  if (!unknownInput.structuredContent?.result?.error?.includes("mcp_input_unknown_property")) throw new Error("MCP input schema did not reject unknown properties");

  const missingIdempotency = await mcp("tools/call", {name: "room-mcp.room_send", arguments: {roomId: "room_doctor", payload: {text: "must fail"}}});
  if (!missingIdempotency.structuredContent?.result?.error?.includes("idempotency_key_required")) throw new Error("write MCP call without idempotencyKey was not rejected");

  const fullState = await mcp("tools/call", {name: "orchestration-mcp.state_get", arguments: {scope: "full"}});
  if (!fullState.structuredContent?.result?.error?.includes("full_state_scope_not_allowed")) throw new Error("state_get full scope was not denied");

  const stateBeforeDryRun = await mcp("tools/call", {name: "orchestration-mcp.state_get", arguments: {scope: "summary"}});
  const dryRun = await mcp("tools/call", {name: "room-mcp.room_send", arguments: {idempotencyKey: "doctor-room-dry-run", dryRun: true, roomId: "room_doctor", payload: {text: "dry run"}}});
  const stateAfterDryRun = await mcp("tools/call", {name: "orchestration-mcp.state_get", arguments: {scope: "summary"}});
  if (!dryRun.structuredContent?.result?.dryRun || stateBeforeDryRun.structuredContent?.stateVersion !== stateAfterDryRun.structuredContent?.stateVersion) throw new Error("write MCP dryRun changed stateVersion");

  const roomSend = await mcp("tools/call", {name: "room-mcp.room_send", arguments: {idempotencyKey: "doctor-room-send", roomId: "room_doctor", payload: {text: "remote MCP"}}});
  if (!roomSend.structuredContent?.result?.message?.messageId) throw new Error("remote MCP room_send failed");
  const idempotencyConflict = await mcp("tools/call", {name: "room-mcp.room_send", arguments: {idempotencyKey: "doctor-room-send", roomId: "room_doctor", payload: {text: "different"}}});
  if (!idempotencyConflict.structuredContent?.result?.error?.includes("idempotency_key_reuse_conflict")) throw new Error("MCP idempotency key reuse was not rejected");

  const badRepositoryTarget = await mcp("tools/call", {name: "repository-mcp.repository_output_target_select", arguments: {idempotencyKey: "doctor-bad-path", taskGroupId: "tg_runtime_management", workItemId: "work_bootstrap", artifactManifestPath: "/tmp/bad.json"}});
  if (!badRepositoryTarget.structuredContent?.result?.error?.includes("repository_output_target_must_use_git_trackable_paths")) throw new Error("MCP repository target selection accepted a non-git-trackable path");

  const selected = await mcp("tools/call", {name: "model-mcp.model_select", arguments: {idempotencyKey: "doctor-model-select", taskGroupId: "tg_runtime_management", workItemId: "work_ai_native_runtime", roleId: "orchestrator"}});
  if (!selected.structuredContent?.result?.selectedModel) throw new Error("remote MCP write call did not execute");

  const targetResult = await mcp("tools/call", {name: "repository-mcp.repository_output_target_select", arguments: {idempotencyKey: "doctor-repository-target", targetId: "rot_doctor_remote_mcp", taskGroupId: "tg_runtime_management", workItemId: "work_bootstrap", artifactManifestPath: "docs/artifact-manifests/doctor-mcp.json"}});
  const targetId = targetResult.structuredContent?.result?.repositoryOutputTarget?.targetId;
  if (!targetId) throw new Error("remote MCP repository target was not created");
  const firstLease = await mcp("tools/call", {name: "resource-mcp.lease_claim", arguments: {idempotencyKey: "doctor-lease-1", repositoryOutputTargetRef: targetId, holderRef: "session:doctor-a"}});
  const lease = firstLease.structuredContent?.result?.lease;
  if (!lease?.fencingToken) throw new Error("remote MCP lease did not issue fencing token");
  const secondLease = await mcp("tools/call", {name: "resource-mcp.lease_claim", arguments: {idempotencyKey: "doctor-lease-2", repositoryOutputTargetRef: targetId, holderRef: "session:doctor-b"}});
  if (!secondLease.structuredContent?.result?.error?.includes("lease_already_active")) throw new Error("lease_claim allowed a second active holder");
  const wrongRelease = await mcp("tools/call", {name: "resource-mcp.lease_release", arguments: {idempotencyKey: "doctor-lease-release", leaseId: lease.leaseId, holderRef: "session:doctor-a", fencingToken: "wrong"}});
  if (!wrongRelease.structuredContent?.result?.error?.includes("lease_fencing_token_mismatch")) throw new Error("lease release accepted the wrong fencing token");

  const registration = spawnSync(process.execPath, ["scripts/register-mcp-client.mjs", `--server-url=${baseUrl}`, `--output-dir=${configDir}`], {
    cwd: root,
    env: {...process.env, AIMAC_MCP_BEARER_TOKEN: token},
    encoding: "utf8"
  });
  if (registration.status !== 0) throw new Error(`remote MCP registration failed: ${registration.stderr}`);
  const generated = JSON.parse(readFileSync(join(configDir, "mcp-server.json"), "utf8"));
  const entry = generated.mcpServers["ai-multi-agent-ctrl"];
  if (entry.url !== `${baseUrl}/mcp` || entry.command || generated.transport !== "streamable-http") throw new Error("MCP client registration did not generate a remote-only endpoint");

  const localStart = spawnSync(process.execPath, ["apps/mcp-server/server.mjs"], {cwd: root, encoding: "utf8"});
  if (localStart.status === 0 || !localStart.stderr.includes("Local MCP stdio startup is disabled")) throw new Error("Agent-local MCP stdio server was not disabled");
  console.log(`mcp doctor ok: ${listed.tools.length} remote tools, auth, HTTP transport, input policy and remote-only registration verified`);
} finally {
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 3000))]);
  rmSync(runtimeDir, {recursive: true, force: true});
  rmSync(configDir, {recursive: true, force: true});
  if (child.exitCode && child.exitCode !== 0 && stderr) process.stderr.write(stderr);
}

async function mcp(method, params) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {"content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`},
    body: JSON.stringify({jsonrpc: "2.0", id: ++requestId, method, params})
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(`MCP ${method} failed: ${JSON.stringify(payload.error || payload)}`);
  return payload.result;
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
  throw new Error(`remote MCP control plane health timeout: ${stderr}`);
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const selected = server.address().port;
  server.close();
  await once(server, "close");
  return selected;
}
