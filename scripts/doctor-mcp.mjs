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
    // 关掉后台自治周期：端到端断言的是一段确定的状态序列，后台推进会把它打乱。
    AIMAC_ORCHESTRATOR_INTERVAL_MS: "0",
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

  // 只读工具的跨租户扫描：不逐个工具想"它会不会漏"，而是拿一个【绑定在项目 A 的节点】身份，
  // 把每个只读工具都用【项目 B 的 id】调一遍，再在响应里全文搜 B 的 id。
  // 现有排查法是"过一遍所有 read-only MCP 工具"——逐条，靠人记得；这一条对将来新增的工具自动生效。
  const scanProject = await api("/api/projects", {method: "POST", idempotencyKey: "mcp-scan-project", token: admin.sessionToken,
    body: {name: "隔壁项目", key: "mcp-scan-foreign"}});
  const scanProjectId = scanProject.id || scanProject.project?.id;
  const scanGroup = await api("/api/task-groups", {method: "POST", idempotencyKey: "mcp-scan-tg", token: admin.sessionToken,
    body: {projectId: scanProjectId, title: "隔壁任务组"}});
  const scanGroupId = scanGroup.taskGroup?.id || scanGroup.id;
  if (!scanProjectId || !scanGroupId) throw new Error("跨租户扫描造不出隔壁项目 —— 本条在空转");
  const joined = await api("/api/agent-join-tokens", {method: "POST", idempotencyKey: "mcp-scan-jt", token: admin.sessionToken,
    body: {projectId: "prj_control_plane", nodeName: "mcp-scan-node", allowedRoles: ["*"], ttlSeconds: 1800, maxUses: 1}});
  const registered = await api("/api/agent/v1/register", {method: "POST", idempotencyKey: "mcp-scan-reg", token: joined.joinToken,
    body: {nodeName: "mcp-scan-node", requestedRoles: ["*"], runtimeVersion: "doctor",
      profile: {tools: [], models: [{providerClass: "custom", adapter: "doctor", available: true}]}}});
  const nodeToken = registered.nodeToken;
  if (!nodeToken) throw new Error("跨租户扫描拿不到节点令牌 —— 本条在空转");
  await api("/api/agent/v1/self-check", {method: "POST", token: nodeToken,
    body: {runtimeVersion: "doctor", checks: [
      {checkId: "runtime", status: "ok", detail: "doctor"}, {checkId: "gateway", status: "ok", detail: baseUrl},
      {checkId: "filesystem", status: "ok", detail: "doctor"}, {checkId: "git", status: "ok", detail: "doctor"},
      {checkId: "remote_mcp", status: "ok", detail: `${baseUrl}/mcp`},
      {checkId: "model_executor", status: "ok", detail: "custom:doctor:available"}]}});
  await api("/api/orchestrator/run", {method: "POST", idempotencyKey: "mcp-scan-cycle", token: admin.sessionToken,
    body: {mode: "all", autoSyncSkills: false}});
  const claimed = await api("/api/agent/v1/dispatches/next", {method: "POST", token: nodeToken, body: {}});
  // 没领到活就没有授权，只读工具全都会以 ok:false 收场 —— 那样这段扫描什么都没验到。
  if (!claimed.dispatch) throw new Error(`跨租户扫描的节点没领到派发（${claimed.reason || "无原因"}）—— 没有授权，所有只读工具都会直接报错，本条在空转`);
  const grantedTaskGroupId = claimed.dispatch.taskGroupId;
  const readOnlyTools = listed.tools.filter((tool) => tool.annotations?.readOnlyHint || tool.readOnlyHint);
  if (readOnlyTools.length < 10) throw new Error(`跨租户扫描只认出 ${readOnlyTools.length} 个只读工具 —— 提取逻辑与代码脱节，本条在空转`);
  const scanLeaks = [];
  let probedExecuted = 0;
  const reachableTools = new Set();
  for (const tool of readOnlyTools) {
    // 两种都要调，而且【不带参数】那一次才是关键：带 addressing 参数的调用会被 principal
    // 作用域校验在到达过滤之前就拒掉（第一版只调了这一种，把守卫改坏也照样绿）；
    // 不带参数的只读工具绕过那道校验，靠工具自己按 principal 过滤 —— 漏就漏在这里。
    for (const args of [{projectId: scanProjectId, taskGroupId: scanGroupId}, {}, {taskGroupId: grantedTaskGroupId}]) {
      let result;
      try {
        result = await mcpAs(nodeToken, "tools/call", {name: tool.name, arguments: args});
      } catch {
        continue; // 被拒就是对的：拒绝不会泄露任何东西
      }
      // 错误被包在成功的 JSON-RPC 信封里，ok:false 说明这个工具【根本没执行】——
      // 只数真的执行了的那些，否则这段扫描会拿一堆错误信封冒充"验过了"。
      const executed = !/"ok":\s*false/u.test(JSON.stringify(result));
      if (executed) { probedExecuted += 1; reachableTools.add(tool.name); }
      const text = JSON.stringify(result);
      // 判据用【隔壁项目的内容】而不是它的 id：调用方自己传进去的 id 被回显不算泄露。
      if (text.includes("隔壁项目") || text.includes("隔壁任务组")) {
        scanLeaks.push(`${tool.name}(${Object.keys(args).length ? "带隔壁 id" : "不带参数"}): ${text.slice(0, 140)}`);
      }
    }
  }
  if (probedExecuted < 5) throw new Error(`跨租户扫描里只有 ${probedExecuted} 次调用真的执行了（其余都是 ok:false 的错误信封）—— 本条在空转`);
  if (scanLeaks.length) {
    throw new Error(`绑定在别的项目上的节点，从这些只读工具里拿到了隔壁项目的内容：\n  ${scanLeaks.join("\n  ")}`);
  }
  // 自证行要说清【实际验到了什么】：受限节点真正的边界是每次派发的工具白名单
  // （其余工具直接 mcp_tool_not_granted_to_principal，连处理器都进不去），
  // 状态过滤只是它后面的纵深防御。这段扫描守的是"凡是这个身份调得到的工具，都不许带出隔壁内容"。
  console.log(`MCP 只读工具跨租户扫描 ok: ${readOnlyTools.length} 个只读工具各用三种入参调过`
    + `（隔壁项目的 id / 无参 / 自己被授权的任务组），其中 ${reachableTools.size} 个这个受限节点真的调得到`
    + `（${probedExecuted} 次执行），其余被工具白名单挡在门外；调得到的都没有带出隔壁项目的内容`);

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
    headers: {"content-type": "application/json", accept: "application/json", ...(options.idempotencyKey ? {"idempotency-key": options.idempotencyKey} : {}), ...(options.token ? {authorization: `Bearer ${options.token}`} : {})},
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
