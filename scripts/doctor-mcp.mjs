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
  const scopedProgressSnapshots = stateBeforeDryRun.structuredContent?.result?.progressSnapshots || [];
  if (!scopedProgressSnapshots.some((snapshot) => snapshot.scopeType === "project" && snapshot.scopeRef === "prj_control_plane") ||
      !scopedProgressSnapshots.some((snapshot) => snapshot.scopeType === "task_group" && snapshot.scopeRef === "tg_runtime_management")) {
    throw new Error("project-scoped MCP state_get dropped project/task-group progress snapshots");
  }
  const dryRun = await mcp("tools/call", {name: "room-mcp.room_send", arguments: {idempotencyKey: "doctor-room-dry-run", dryRun: true, roomId: "room_doctor", payload: {text: "dry run"}}});
  const stateAfterDryRun = await mcp("tools/call", {name: "orchestration-mcp.state_get", arguments: {scope: "summary"}});
  if (!dryRun.structuredContent?.result?.dryRun || stateBeforeDryRun.structuredContent?.stateVersion !== stateAfterDryRun.structuredContent?.stateVersion) throw new Error("write MCP dryRun changed stateVersion");

  const roomSend = await mcp("tools/call", {name: "room-mcp.room_send", arguments: {idempotencyKey: "doctor-room-send", roomId: "room_doctor", payload: {text: "remote MCP"}}});
  if (!roomSend.structuredContent?.result?.message?.messageId) throw new Error("remote MCP room_send failed");
  const idempotencyConflict = await mcp("tools/call", {name: "room-mcp.room_send", arguments: {idempotencyKey: "doctor-room-send", roomId: "room_doctor", payload: {text: "different"}}});
  if (!idempotencyConflict.structuredContent?.result?.error?.includes("idempotency_key_reuse_conflict")) throw new Error("MCP idempotency key reuse was not rejected");

  const badRepositoryTarget = await mcp("tools/call", {name: "repository-mcp.repository_output_target_select", arguments: {idempotencyKey: "doctor-bad-path", taskGroupId: "tg_runtime_management", workItemId: "work_bootstrap", artifactManifestPath: "/tmp/bad.json"}});
  if (!badRepositoryTarget.structuredContent?.result?.error?.includes("repository_output_target_must_use_git_trackable_paths")) throw new Error("MCP repository target selection accepted a non-git-trackable path");
  const invalidTaskGroupTarget = await mcp("tools/call", {name: "repository-mcp.repository_output_target_select", arguments: {idempotencyKey: "doctor-invalid-task-scope", taskGroupId: "tg_missing_scope", workItemId: "work_bootstrap", artifactManifestPath: "docs/artifact-manifests/doctor-invalid-task.json"}});
  if (!invalidTaskGroupTarget.structuredContent?.result?.error?.includes("task_group_not_found")) throw new Error("MCP repository target selection did not fail closed on an invalid taskGroupId");
  const invalidWorkItemTarget = await mcp("tools/call", {name: "repository-mcp.repository_output_target_select", arguments: {idempotencyKey: "doctor-invalid-work-scope", taskGroupId: "tg_runtime_management", workItemId: "work_missing_scope", artifactManifestPath: "docs/artifact-manifests/doctor-invalid-work.json"}});
  if (!invalidWorkItemTarget.structuredContent?.result?.error?.includes("work_item_not_found")) throw new Error("MCP repository target selection did not fail closed on an invalid workItemId");

  const selected = await mcp("tools/call", {name: "model-mcp.model_select", arguments: {idempotencyKey: "doctor-model-select", taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", roleId: "orchestrator"}});
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
  const admin = await api("/api/auth/login", {method: "POST", body: {email: "system.admin@local", token: "doctor-bootstrap-token"}});
  const missingProjectTaskGroup = await mcpAs(admin.sessionToken, "tools/call", {name: "orchestration-mcp.task_group_create", arguments: {idempotencyKey: "doctor-mcp-task-create-missing-project", taskGroupId: "tg_doctor_missing_project", name: "Missing Project Scope"}});
  if (missingProjectTaskGroup.structuredContent?.result?.error !== "mcp_required_argument_missing" || missingProjectTaskGroup.structuredContent?.result?.argument !== "projectId") {
    throw new Error("MCP task_group_create without projectId was not rejected by input policy");
  }
  const normalizedTaskGroup = await mcpAs(admin.sessionToken, "tools/call", {name: "orchestration-mcp.task_group_create", arguments: {idempotencyKey: "doctor-mcp-task-create", projectId: "prj_control_plane", taskGroupId: "tg_doctor_mcp_norm", name: "Doctor MCP normalized task group", languageTag: "en", roles: ["orchestrator", "agent-runtime"]}});
  const normalizedTask = normalizedTaskGroup.structuredContent?.result?.taskGroup;
  if (!normalizedTask?.roles?.every((role) => role.roleId && role.status === "ready" && role.skillBinding === "server_resolved_on_dispatch") || normalizedTask.languagePolicy?.languageTag !== "en") {
    throw new Error("MCP task_group_create did not normalize role bindings and language policy");
  }
  const normalizedWorkItem = await mcpAs(admin.sessionToken, "tools/call", {name: "orchestration-mcp.work_item_create", arguments: {idempotencyKey: "doctor-mcp-work-create", taskGroupId: "tg_doctor_mcp_norm", workItemId: "work_doctor_mcp_norm", title: "Doctor MCP normalized work", ownerRole: "agent-runtime", requirements: ["return realtime event"]}});
  const normalizedWork = normalizedWorkItem.structuredContent?.result;
  if (normalizedWork?.workItem?.status !== "ready" || normalizedWork.workItem.ownerRole !== "agent-runtime" || !normalizedWork.taskGroup?.roles?.some((role) => role.roleId === "agent-runtime")) {
    throw new Error("MCP work_item_create did not normalize work item status and task group role binding");
  }
  const foreignProject = await mcpAs(admin.sessionToken, "tools/call", {name: "orchestration-mcp.project_create", arguments: {idempotencyKey: "doctor-foreign-project", projectId: "prj_foreign_scope", name: "Doctor Foreign Scope"}});
  const foreignProjectResult = foreignProject.structuredContent?.result;
  if (!foreignProjectResult?.project?.id || foreignProjectResult.ownerGrant?.subjectRef?.subjectId !== "acct_workspace_owner" || !foreignProjectResult.ownerGrant?.permissions?.includes("task_group:control")) {
    throw new Error("system admin MCP could not create a foreign project with owner grant");
  }
  const foreignTask = await mcpAs(admin.sessionToken, "tools/call", {name: "orchestration-mcp.task_group_create", arguments: {idempotencyKey: "doctor-foreign-task", projectId: "prj_foreign_scope", taskGroupId: "tg_foreign_scope", name: "Doctor Foreign Task", roles: ["orchestrator"]}});
  if (!foreignTask.structuredContent?.result?.taskGroup?.id) throw new Error("system admin MCP could not create a foreign task group");
  const foreignWork = await mcpAs(admin.sessionToken, "tools/call", {name: "orchestration-mcp.work_item_create", arguments: {idempotencyKey: "doctor-foreign-work", taskGroupId: "tg_foreign_scope", workItemId: "work_foreign_scope", title: "Doctor Foreign Work", ownerRole: "orchestrator"}});
  if (!foreignWork.structuredContent?.result?.workItem?.id) throw new Error("system admin MCP could not create a foreign work item");
  const foreignPermissionRequest = await mcp("tools/call", {name: "permission-mcp.permission_request_submit", arguments: {idempotencyKey: "doctor-foreign-permission-resource", resource: {resourceType: "task_group", resourceId: "tg_foreign_scope"}, permission: "task_group:control", reason: "must fail closed on nested resource scope"}});
  if (!foreignPermissionRequest.structuredContent?.result?.error?.includes("mcp_principal_project_scope_mismatch")) {
    throw new Error("MCP service token accepted nested permission resource outside its project scope");
  }
  const foreignTarget = await mcpAs(admin.sessionToken, "tools/call", {name: "repository-mcp.repository_output_target_select", arguments: {idempotencyKey: "doctor-foreign-target", targetId: "rot_doctor_foreign_scope", projectId: "prj_foreign_scope", taskGroupId: "tg_foreign_scope", workItemId: "work_foreign_scope", artifactManifestPath: "docs/artifact-manifests/doctor-foreign-scope.json"}});
  const foreignTargetId = foreignTarget.structuredContent?.result?.repositoryOutputTarget?.targetId;
  if (!foreignTargetId) throw new Error("system admin MCP could not create a foreign-scope repository target");
  const foreignLeaseClaim = await mcpAs(admin.sessionToken, "tools/call", {name: "resource-mcp.lease_claim", arguments: {idempotencyKey: "doctor-foreign-lease", repositoryOutputTargetRef: foreignTargetId, holderRef: "session:doctor-foreign"}});
  const foreignLease = foreignLeaseClaim.structuredContent?.result?.lease;
  if (!foreignLease?.leaseId) throw new Error("system admin MCP could not create a foreign-scope lease");
  const foreignRelease = await mcp("tools/call", {name: "resource-mcp.lease_release", arguments: {idempotencyKey: "doctor-foreign-release-service-token", leaseId: foreignLease.leaseId, holderRef: "session:doctor-foreign", fencingToken: foreignLease.fencingToken}});
  if (!foreignRelease.structuredContent?.result?.error?.includes("mcp_principal_project_scope_mismatch")) {
    throw new Error("MCP service token released a lease outside its project scope when only leaseId was supplied");
  }

  const registration = spawnSync(process.execPath, ["scripts/register-mcp-client.mjs", `--server-url=${baseUrl}`, `--output-dir=${configDir}`], {
    cwd: root,
    env: {...process.env, AIMAC_MCP_BEARER_TOKEN: token},
    encoding: "utf8"
  });
  if (registration.status !== 0) throw new Error(`remote MCP registration failed: ${registration.stderr}`);
  const generated = JSON.parse(readFileSync(join(configDir, "mcp-server.json"), "utf8"));
  const entry = generated.mcpServers.ai_multi_agent_ctrl;
  if (generated.mcpServers["ai-multi-agent-ctrl"] || entry?.url !== `${baseUrl}/mcp` || entry.command || generated.transport !== "streamable-http") throw new Error("MCP client registration did not generate a remote-only endpoint");

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
  return mcpAs(token, method, params);
}

async function mcpAs(bearer, method, params) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {"content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}`},
    body: JSON.stringify({jsonrpc: "2.0", id: ++requestId, method, params})
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(`MCP ${method} failed: ${JSON.stringify(payload.error || payload)}`);
  return payload.result;
}

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers: {"content-type": "application/json", accept: "application/json", ...(options.token ? {authorization: `Bearer ${options.token}`} : {})},
    ...(options.body ? {body: JSON.stringify(options.body)} : {})
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`API ${path} failed: ${JSON.stringify(payload)}`);
  return payload;
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
