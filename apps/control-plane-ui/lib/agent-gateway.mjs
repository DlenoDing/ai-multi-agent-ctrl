import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { normalize, resolve, sep } from "node:path";
import { createId, digestOf, ensureRuntimeCollections, languagePolicyDirective, normalizeTaskGroupLanguagePolicy } from "./control-plane-core.mjs";

const DEFAULT_AGENT_MCP_TOOLS = [
  "agent-control-mcp.node_probe",
  "agent-control-mcp.session_start",
  "agent-control-mcp.session_pause",
  "agent-control-mcp.session_cancel",
  "agent-control-mcp.session_recover",
  "room-mcp.room_join",
  "room-mcp.room_send",
  "room-mcp.room_wait",
  "room-mcp.room_ack",
  "model-mcp.model_capabilities",
  "model-mcp.model_policy_get",
  "skill-mcp.role_skill_parse",
  "skill-mcp.role_skill_resolve",
  "evidence-mcp.artifact_register",
  "evidence-mcp.test_result_submit",
  "permission-mcp.permission_probe",
  "permission-mcp.permission_request_submit",
  "permission-mcp.permission_status",
  "ui-console-mcp.runtime_health_get",
  "ui-console-mcp.project_progress_get",
  "ui-console-mcp.task_group_progress_get",
  "instruction-mcp.cache_key_index",
  "instruction-mcp.stable_prefix_get",
  "repository-mcp.artifact_manifest_index"
];

const CONTROL_ROLE_MCP_TOOLS = [
  "orchestration-mcp.orchestrator_run",
  "orchestration-mcp.state_get",
  "scheduler-mcp.model_select",
  "scheduler-mcp.session_place",
  "scheduler-mcp.capacity_snapshot",
  "scheduler-mcp.execution_topology_plan",
  "scheduler-mcp.derived_task_classify",
  "review-mcp.review_plan_create",
  "review-mcp.review_bundle_register",
  "review-mcp.review_result_consume",
  "review-mcp.completion_readiness_compute",
  "governance-mcp.policy_decision_eval",
  "governance-mcp.finding_submit",
  "governance-mcp.close_barrier_compute",
  "definition-mcp.shared_definition_create",
  "definition-mcp.shared_definition_publish",
  "definition-mcp.shared_definition_consumer_bind",
  "definition-mcp.shared_definition_conflict_report"
];

export function ensureAgentGatewayCollections(state) {
  ensureRuntimeCollections(state);
  state.agentJoinTokens ||= [];
  state.agentRuntimeNodes ||= [];
  state.agentGatewayEvents ||= [];
  state.agentControlCommands ||= [];
  state.agentControlSequence ||= 0;
  state.agentExecutionEvents ||= [];
  state.agentExecutionSequence ||= 0;
  return state;
}

export function createAgentJoinToken(state, input = {}, options = {}) {
  ensureAgentGatewayCollections(state);
  const projectId = String(input.projectId || "").trim();
  if (!state.projects.some((project) => project.id === projectId)) throw new Error("join_token_project_not_found");
  const ttlSeconds = boundedInteger(input.ttlSeconds, 60, 86400, 1800);
  if (input.maxUses !== undefined && Number(input.maxUses) !== 1) throw gatewayError("join_token_must_be_one_time", 400);
  const maxUses = 1;
  const allowedRoles = uniqueStrings(input.allowedRoles?.length ? input.allowedRoles : ["agent-runtime"]);
  const token = `aimac_join_${randomBytes(32).toString("base64url")}`;
  const at = new Date().toISOString();
  const record = {
    schemaVersion: "agent-join-token/v1",
    joinTokenId: createId("ajt"),
    projectId,
    expectedNodeName: String(input.nodeName || input.expectedNodeName || "").trim() || null,
    allowedRoles,
    allowedMcpTools: mcpToolsForRoles(allowedRoles),
    tokenDigest: digestOf(`agent-join:${token}`),
    status: "issued",
    maxUses,
    useCount: 0,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    createdBy: options.actor || "system",
    createdAt: at,
    updatedAt: at
  };
  state.agentJoinTokens.unshift(record);
  state.agentJoinTokens = state.agentJoinTokens.slice(0, 500);
  const serverUrl = trimTrailingSlash(options.publicUrl || "http://127.0.0.1:4317");
  const nodeNameArg = record.expectedNodeName ? ` --node-name ${shellArg(record.expectedNodeName)}` : "";
  const tokenFileCommand = `umask 077; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT HUP INT TERM; cat > "$tmp/aimac.join" <<'AIMAC_JOIN_TOKEN'\n${token}\nAIMAC_JOIN_TOKEN\ncurl -fsSL ${shellUrl(`${serverUrl}/install-agent.sh`)} | sh -s -- --server ${shellArg(serverUrl)} --join-token-file "$tmp/aimac.join"${nodeNameArg}`;
  const verifiedTokenFileCommand = `umask 077; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT HUP INT TERM; cat > "$tmp/aimac.join" <<'AIMAC_JOIN_TOKEN'\n${token}\nAIMAC_JOIN_TOKEN\ncd "$tmp" && curl -fsSLO ${shellUrl(`${serverUrl}/install-agent.sh`)} && curl -fsSLO ${shellUrl(`${serverUrl}/install-agent.sh.sha256`)} && ( if command -v sha256sum >/dev/null 2>&1; then sha256sum -c install-agent.sh.sha256; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -c install-agent.sh.sha256; else printf '%s\\n' 'sha256sum or shasum is required' >&2; exit 1; fi ) && sh install-agent.sh --server ${shellArg(serverUrl)} --join-token-file "$tmp/aimac.join"${nodeNameArg}`;
  appendGatewayEvent(state, "join_token_issued", record.joinTokenId, {projectId, allowedRoles});
  return {
    joinToken: token,
    joinTokenRecord: publicJoinToken(record),
    installCommand: tokenFileCommand,
    verifiedInstallCommand: verifiedTokenFileCommand
  };
}

export function listAgentJoinTokens(state, projectId) {
  ensureAgentGatewayCollections(state);
  return state.agentJoinTokens
    .filter((item) => !projectId || item.projectId === projectId)
    .map(publicJoinToken);
}

export function registerAgentNode(state, input = {}, options = {}) {
  ensureAgentGatewayCollections(state);
  const rawToken = String(options.joinToken || "");
  const tokenDigest = digestOf(`agent-join:${rawToken}`);
  const record = state.agentJoinTokens.find((item) => item.tokenDigest === tokenDigest);
  if (!record) throw gatewayError("join_token_invalid", 401);
  if (record.status !== "issued") throw gatewayError("join_token_not_active", 409);
  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    record.status = "expired";
    record.updatedAt = new Date().toISOString();
    throw gatewayError("join_token_expired", 401);
  }
  if (record.useCount >= record.maxUses) {
    record.status = "consumed";
    record.updatedAt = new Date().toISOString();
    throw gatewayError("join_token_consumed", 409);
  }
  const nodeName = String(input.nodeName || "").trim();
  if (!nodeName) throw gatewayError("node_name_required", 400);
  if (record.expectedNodeName && record.expectedNodeName !== nodeName) throw gatewayError("join_token_node_name_mismatch", 403);
  const requestedRoles = uniqueStrings(input.requestedRoles || record.allowedRoles);
  if (!rolesAllowed(requestedRoles, record.allowedRoles)) throw gatewayError("join_token_role_scope_mismatch", 403);

  const nodeToken = `aimac_node_${randomBytes(40).toString("base64url")}`;
  const nodeId = createId("node");
  const at = new Date().toISOString();
  const profile = sanitizeNodeProfile(input.profile || {});
  const node = {
    schemaVersion: "agent-runtime-node/v1",
    nodeId,
    nodeName,
    projectIds: [record.projectId],
    allowedRoles: requestedRoles,
    allowedMcpTools: record.allowedMcpTools,
    status: "initializing",
    admission: "limited",
    credentialDigest: digestOf(`agent-node:${nodeId}:${nodeToken}`),
    credentialIssuedAt: at,
    credentialExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    profile,
    profileDigest: digestOf(profile),
    runtimeVersion: String(input.runtimeVersion || "unknown"),
    lastHeartbeatAt: at,
    lastSelfCheckAt: null,
    activeDispatchIds: [],
    completedDispatchCount: 0,
    failedDispatchCount: 0,
    createdAt: at,
    updatedAt: at
  };
  state.agentRuntimeNodes.unshift(node);
  record.useCount += 1;
  record.status = record.useCount >= record.maxUses ? "consumed" : "issued";
  record.updatedAt = at;
  appendGatewayEvent(state, "node_registered", nodeId, {projectId: record.projectId, profileDigest: node.profileDigest});
  const publicUrl = trimTrailingSlash(options.publicUrl || "http://127.0.0.1:4317");
  return {
    node: publicAgentNode(node),
    nodeToken,
    gateway: {
      serverUrl: publicUrl,
      heartbeatUrl: `${publicUrl}/api/agent/v1/heartbeat`,
      selfCheckUrl: `${publicUrl}/api/agent/v1/self-check`,
      dispatchUrl: `${publicUrl}/api/agent/v1/dispatches/next`,
      controlUrl: `${publicUrl}/api/agent/v1/control`,
      eventUrl: `${publicUrl}/api/agent/v1/events`,
      mcpUrl: `${publicUrl}/mcp`,
      skillWorksetBaseUrl: `${publicUrl}/api/agent/v1/skill-worksets`,
      runtimeUrl: `${publicUrl}/agent-runtime.mjs`
    },
    heartbeatIntervalSeconds: 30,
    pollIntervalSeconds: 5
  };
}

const nodeTokenCache = new Map();

export function authenticateAgentNode(state, bearerToken) {
  ensureAgentGatewayCollections(state);
  const token = String(bearerToken || "");
  if (!token.startsWith("aimac_node_")) return null;
  const cachedNodeId = nodeTokenCache.get(token);
  if (cachedNodeId) {
    const node = state.agentRuntimeNodes.find((item) => item.nodeId === cachedNodeId);
    if (node && nodeAcceptsToken(node, token)) return node;
    nodeTokenCache.delete(token);
  }
  for (const node of state.agentRuntimeNodes) {
    if (nodeAcceptsToken(node, token)) {
      if (nodeTokenCache.size > 5000) nodeTokenCache.clear();
      nodeTokenCache.set(token, node.nodeId);
      return node;
    }
  }
  return null;
}

function nodeAcceptsToken(node, token) {
  if (node.status === "revoked") return false;
  const presentedDigest = digestOf(`agent-node:${node.nodeId}:${token}`);
  const currentValid = !node.credentialExpiresAt || new Date(node.credentialExpiresAt).getTime() > Date.now();
  const previousValid = node.previousCredentialDigest === presentedDigest
    && new Date(node.previousCredentialExpiresAt || 0).getTime() > Date.now();
  return (currentValid && node.credentialDigest === presentedDigest) || previousValid;
}

export function heartbeatAgentNode(state, node, input = {}, options = {}) {
  const at = new Date().toISOString();
  const previousHeartbeatAt = node.lastHeartbeatAt;
  const previousStatus = node.status;
  const previousProfileDigest = node.profileDigest;
  node.lastHeartbeatAt = at;
  node.updatedAt = at;
  if (input.profile) {
    node.profile = sanitizeNodeProfile(input.profile);
    node.profileDigest = digestOf(node.profile);
  }
  if (["initializing", "offline", "degraded"].includes(node.status)) node.status = "online";
  const presentedDigest = digestOf(`agent-node:${node.nodeId}:${String(options.presentedToken || "")}`);
  const usingPreviousCredential = node.previousCredentialDigest === presentedDigest
    && new Date(node.previousCredentialExpiresAt || 0).getTime() > Date.now();
  let rotatedNodeToken;
  if (!usingPreviousCredential && (!node.credentialExpiresAt || new Date(node.credentialExpiresAt).getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000)) {
    rotatedNodeToken = `aimac_node_${randomBytes(40).toString("base64url")}`;
    node.previousCredentialDigest = node.credentialDigest;
    node.previousCredentialExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    node.credentialDigest = digestOf(`agent-node:${node.nodeId}:${rotatedNodeToken}`);
    node.credentialIssuedAt = at;
    node.credentialExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  }
  renewNodeDispatchClaims(state, node, at);
  const heartbeatPersistFloorMs = Math.max(30000, Number(process.env.AIMAC_HEARTBEAT_PERSIST_FLOOR_MS || 120000));
  const persistRequired = Boolean(rotatedNodeToken) ||
    node.status !== previousStatus ||
    node.profileDigest !== previousProfileDigest ||
    !previousHeartbeatAt ||
    Date.now() - new Date(previousHeartbeatAt).getTime() >= heartbeatPersistFloorMs ||
    (node.activeDispatchIds || []).length > 0;
  appendGatewayEvent(state, "node_heartbeat", node.nodeId, {profileDigest: node.profileDigest, credentialRotated: Boolean(rotatedNodeToken)});
  const queuedCommands = (state.agentControlCommands || []).filter((command) => command.nodeId === node.nodeId && command.status === "queued").length;
  return {ok: true, accepted: true, commandsAvailable: queuedCommands, node: publicAgentNode(node), serverTime: at, persistRequired, ...(rotatedNodeToken ? {nodeToken: rotatedNodeToken} : {})};
}

function renewNodeDispatchClaims(state, node, at) {
  for (const dispatch of state.agentDispatches || []) {
    if (dispatch.assignedNodeId !== node.nodeId || dispatch.status !== "running" || !dispatch.claimExpiresAt) continue;
    const ttlSeconds = boundedInteger(dispatch.claimTtlSeconds, 60, 21600, 1800);
    const renewed = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    if (renewed > dispatch.claimExpiresAt) {
      dispatch.claimExpiresAt = renewed;
      dispatch.updatedAt = at;
    }
  }
}

export function revokeAgentNode(state, node) {
  ensureAgentGatewayCollections(state);
  const at = new Date().toISOString();
  const activeDispatchIds = (state.agentDispatches || [])
    .filter((dispatch) => dispatch.assignedNodeId === node.nodeId && ["running", "blocked"].includes(dispatch.status))
    .map((dispatch) => dispatch.dispatchId);
  if (activeDispatchIds.length) {
    throw gatewayError("active_node_revocation_requires_control_ack", 409);
  }
  node.status = "revoked";
  node.admission = "read_only";
  node.activeDispatchIds = [];
  node.updatedAt = at;
  appendGatewayEvent(state, "node_revoked", node.nodeId, {requeuedDispatchIds: []});
  return {nodeId: node.nodeId, status: node.status, requeuedDispatchIds: []};
}

export function requestAgentNodeRevocation(state, node, input = {}, options = {}) {
  ensureAgentGatewayCollections(state);
  const result = createAgentControlCommand(state, node, {
    ...input,
    commandType: "revoke",
    payload: {...(input.payload || {})}
  }, options);
  const pendingDispatchIds = [...(result.command.payload?.activeDispatchIds || [])];
  appendGatewayEvent(state, "node_revocation_requested", node.nodeId, {commandId: result.command.commandId, pendingDispatchIds});
  return {nodeId: node.nodeId, status: node.status, command: result.command, pendingDispatchIds, requeuedDispatchIds: []};
}

function ensureDispatchMcpGrants(state, dispatch, node) {
  state.mcpGrants ||= [];
  const contract = state.agentTaskContracts.find((item) => item.sessionId === dispatch.sessionId && item.runId === dispatch.runId);
  const at = new Date().toISOString();
  const expiresAt = dispatch.claimExpiresAt || new Date(Date.now() + 30 * 60 * 1000).toISOString();
  for (const toolName of node.allowedMcpTools || []) {
    if (toolName === "*") continue;
    const existing = state.mcpGrants.find((grant) =>
      grant.principalRef === `agent-node:${node.nodeId}` &&
      grant.dispatchId === dispatch.dispatchId &&
      grant.toolName === toolName &&
      grant.grantStatus === "issued"
    );
    if (existing) {
      existing.expiresAt = expiresAt;
      existing.updatedAt = at;
      continue;
    }
    const serverId = toolName.split(".")[0];
    const grantSeed = {
      grantId: createId("mcp_grant"),
      serverId,
      toolName,
      principalRef: `agent-node:${node.nodeId}`,
      agentNodeId: node.nodeId,
      dispatchId: dispatch.dispatchId,
      projectId: dispatch.projectId,
      taskGroupId: dispatch.taskGroupId,
      workId: dispatch.workItemId,
      sessionId: dispatch.sessionId,
      runId: dispatch.runId,
      roleId: contract?.roleId || dispatch.roleId
    };
    state.mcpGrants.unshift({
      schemaVersion: "mcp-grant/v1",
      ...grantSeed,
      endpointPath: "/mcp",
      transport: "streamable-http",
      resource: `mcp://${toolName}`,
      action: `mcp:${toolName}`,
      issuedAt: at,
      expiresAt,
      schemaDigest: digestOf(`mcp-tool:${toolName}:v1`),
      policyDecisionRef: `policy:mcp:${toolName}:dispatch:${dispatch.dispatchId}`,
      approvalRequestRef: "approval:dispatch-bound-agent-grant",
      riskLevel: dispatchBoundRiskLevel(toolName),
      paramPolicyRef: `policy://mcp/dispatch-bound/${toolName}`,
      paramPolicyDigest: digestOf(grantSeed),
      resultFilterRef: "filter://mcp/agent-dispatch-scope",
      resultFilterDigest: digestOf("filter://mcp/agent-dispatch-scope"),
      leaseRef: "lease:dispatch-scope",
      idempotencyKey: "*",
      maxTtl: "PT6H",
      grantStatus: "issued",
      revocationRef: "revocation:none",
      auditRef: `audit:mcp-grant:${dispatch.dispatchId}:${toolName}`,
      grantDigest: digestOf(grantSeed)
    });
  }
  state.mcpGrants = state.mcpGrants.slice(0, 2000);
}

export function revokeDispatchMcpGrants(state, nodeId, dispatchId, reason) {
  const at = new Date().toISOString();
  for (const grant of state.mcpGrants || []) {
    if (grant.agentNodeId !== nodeId || grant.dispatchId !== dispatchId || grant.grantStatus !== "issued") continue;
    grant.grantStatus = "revoked";
    grant.revocationRef = `revocation:${reason}`;
    grant.updatedAt = at;
  }
}

function dispatchBoundRiskLevel(toolName) {
  if (toolName.includes("grant") || toolName.includes("account") || toolName.includes("approval") || toolName.includes("lease")) return "L2";
  return "L1";
}

export function selfCheckAgentNode(state, node, input = {}) {
  if (input.profile) {
    node.profile = sanitizeNodeProfile(input.profile);
    node.profileDigest = digestOf(node.profile);
  }
  const checks = normalizeChecks(input.checks || []);
  const required = ["runtime", "gateway", "filesystem", "git", "remote_mcp", "model_executor"];
  const missing = required.filter((checkId) => !checks.some((check) => check.checkId === checkId && check.status === "ok"));
  const at = new Date().toISOString();
  node.lastSelfCheckAt = at;
  node.selfCheckDigest = digestOf(checks);
  if (node.status !== "draining") {
    node.status = missing.length ? "degraded" : "online";
    node.admission = missing.length ? "read_only" : "full";
  }
  node.updatedAt = at;
  appendGatewayEvent(state, "node_self_check", node.nodeId, {status: node.status, missing});
  return {ok: missing.length === 0, admission: node.admission, missingChecks: missing, node: publicAgentNode(node)};
}

export function claimNextDispatch(state, node, options = {}) {
  ensureAgentGatewayCollections(state);
  if (node.status !== "online" || node.admission !== "full") return {dispatch: null, reason: "node_not_admitted"};
  recycleExpiredClaims(state);
  const dispatch = state.agentDispatches.find((item) => {
    if (item.status !== "queued") return false;
    if (!node.projectIds.includes(item.projectId)) return false;
    if (item.assignedNodeId && item.assignedNodeId !== node.nodeId) return false;
    const contract = state.agentTaskContracts.find((candidate) => candidate.sessionId === item.sessionId && candidate.runId === item.runId);
    if (!contract || (contract.expiresAt && new Date(contract.expiresAt).getTime() <= Date.now())) return false;
    return roleAllowed(contract.roleId, node.allowedRoles) && modelRunnable(contract.model, node.profile);
  });
  if (!dispatch) return {dispatch: null, reason: "no_compatible_dispatch"};
  const at = new Date().toISOString();
  dispatch.status = "running";
  dispatch.assignedNodeId = node.nodeId;
  dispatch.claimedAt = at;
  dispatch.claimTtlSeconds = boundedInteger(options.claimTtlSeconds, 60, 21600, 1800);
  dispatch.claimExpiresAt = new Date(Date.now() + dispatch.claimTtlSeconds * 1000).toISOString();
  dispatch.attempts = Number(dispatch.attempts || 0) + 1;
  dispatch.updatedAt = at;
  node.activeDispatchIds = uniqueStrings([...(node.activeDispatchIds || []), dispatch.dispatchId]);
  node.updatedAt = at;
  ensureDispatchMcpGrants(state, dispatch, node);
  appendGatewayEvent(state, "dispatch_claimed", dispatch.dispatchId, {nodeId: node.nodeId});
  return {dispatch: buildDispatchPackage(state, dispatch, node, options)};
}

function recycleExpiredClaims(state) {
  const at = Date.now();
  for (const dispatch of state.agentDispatches || []) {
    if (dispatch.status !== "running" || !dispatch.claimExpiresAt || new Date(dispatch.claimExpiresAt).getTime() > at) continue;
    const previousNodeId = dispatch.assignedNodeId;
    dispatch.status = "queued";
    dispatch.blockedReason = "claim_expired_requeued";
    delete dispatch.assignedNodeId;
    delete dispatch.claimedAt;
    delete dispatch.claimExpiresAt;
    dispatch.updatedAt = new Date().toISOString();
    const previousNode = state.agentRuntimeNodes.find((item) => item.nodeId === previousNodeId);
    if (previousNode) previousNode.activeDispatchIds = (previousNode.activeDispatchIds || []).filter((id) => id !== dispatch.dispatchId);
    revokeDispatchMcpGrants(state, previousNodeId, dispatch.dispatchId, "claim_expired_requeued");
    appendGatewayEvent(state, "dispatch_claim_expired", dispatch.dispatchId, {previousNodeId});
  }
}

export function getDispatchForNode(state, node, dispatchId, options = {}) {
  const dispatch = state.agentDispatches.find((item) => item.dispatchId === dispatchId && item.assignedNodeId === node.nodeId);
  if (!dispatch) throw gatewayError("dispatch_not_found", 404);
  return buildDispatchPackage(state, dispatch, node, options);
}

export function createAgentControlCommand(state, node, input = {}, options = {}) {
  ensureAgentGatewayCollections(state);
  if (!node || node.status === "revoked") throw gatewayError("agent_node_not_active", 409);
  const commandType = normalizeControlCommandType(input.commandType || input.action || "refresh_profile");
  const at = new Date().toISOString();
  state.agentControlSequence = Number(state.agentControlSequence || 0) + 1;
  const command = {
    schemaVersion: "agent-control-command/v1",
    commandId: createId("acc"),
    sequence: state.agentControlSequence,
    nodeId: node.nodeId,
    projectId: input.projectId || node.projectIds?.[0] || null,
    taskGroupId: input.taskGroupId || null,
    sessionId: input.sessionId || null,
    dispatchId: input.dispatchId || null,
    commandType,
    payload: ["shutdown", "revoke"].includes(commandType)
      ? {...(input.payload || {}), activeDispatchIds: [...(node.activeDispatchIds || [])]}
      : input.payload || {},
    status: "queued",
    requiresAck: true,
    createdBy: options.actor || "control-plane",
    idempotencyKey: options.idempotencyKey || null,
    expiresAt: input.expiresAt || new Date(Date.now() + boundedInteger(input.ttlSeconds, 60, 86400, 1800) * 1000).toISOString(),
    createdAt: at,
    updatedAt: at
  };
  applyControlCommandPreEffects(state, node, command);
  state.agentControlCommands.unshift(command);
  state.agentControlCommands = state.agentControlCommands.slice(0, 2000);
  appendGatewayEvent(state, "agent_control_command_queued", command.commandId, {nodeId: node.nodeId, commandType, dispatchId: command.dispatchId});
  return {command};
}

export function listAgentControlCommands(state, node, input = {}) {
  ensureAgentGatewayCollections(state);
  const afterSequence = Number(input.afterSequence || 0);
  const limit = boundedInteger(input.limit, 1, 50, 20);
  const nowMs = Date.now();
  const commands = (state.agentControlCommands || [])
    .filter((command) =>
      command.nodeId === node.nodeId &&
      Number(command.sequence || 0) > afterSequence &&
      ["queued", "delivered", "received"].includes(command.status) &&
      (!command.expiresAt || new Date(command.expiresAt).getTime() > nowMs)
    )
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
    .slice(0, limit);
  let deliveredCount = 0;
  const at = new Date().toISOString();
  for (const command of commands) {
    if (command.status !== "queued") continue;
    command.status = "delivered";
    command.deliveredAt = at;
    command.updatedAt = at;
    deliveredCount += 1;
  }
  return {commands, nextCursor: commands.at(-1)?.sequence || afterSequence, deliveredCount};
}

const controlAckRank = {queued: 0, delivered: 1, received: 2, acked: 3, completed: 4, failed: 4, rejected: 4};

export function ackAgentControlCommand(state, node, commandId, input = {}) {
  ensureAgentGatewayCollections(state);
  const command = state.agentControlCommands.find((item) => item.commandId === commandId && item.nodeId === node.nodeId);
  if (!command) throw gatewayError("agent_control_command_not_found", 404);
  const status = ["received", "acked", "completed", "failed", "rejected"].includes(input.status) ? input.status : "acked";
  const currentRank = controlAckRank[command.status] ?? 0;
  if (command.status === status) return {command, replayed: true};
  if (currentRank >= 4) throw gatewayError("agent_control_command_already_terminal", 409);
  if ((controlAckRank[status] ?? 0) < currentRank) throw gatewayError("agent_control_command_ack_regression", 409);
  command.status = status;
  command.acknowledgedAt = new Date().toISOString();
  command.ackResult = sanitizeAckResult(input.result || {});
  command.resultDigest = digestOf(command.ackResult);
  command.updatedAt = command.acknowledgedAt;
  if (status === "completed" && command.commandType === "revoke") finalizeNodeRevocation(state, node, command);
  if (status === "completed" && command.commandType === "shutdown") finalizeNodeShutdown(state, node, command);
  if (["failed", "rejected"].includes(status) && ["revoke", "shutdown"].includes(command.commandType)) handleStopControlFailure(state, node, command, status);
  if (["failed", "rejected"].includes(status) && ["pause_dispatch", "cancel_dispatch"].includes(command.commandType)) handleDispatchControlFailure(state, node, command, status);
  appendGatewayEvent(state, "agent_control_command_ack", command.commandId, {nodeId: node.nodeId, status});
  return {command};
}

function handleDispatchControlFailure(state, node, command, status) {
  const at = new Date().toISOString();
  const dispatch = (state.agentDispatches || []).find((item) => item.dispatchId === command.dispatchId);
  if (!dispatch) return;
  const retryAttempt = Number(command.payload?.retryAttempt || 0) + 1;
  if (status === "failed" && retryAttempt <= 3 && ["running", "blocked"].includes(dispatch.status)) {
    const retry = createAgentControlCommand(state, node, {
      commandType: command.commandType,
      dispatchId: command.dispatchId,
      payload: {...(command.payload || {}), retryOf: command.commandId, retryAttempt},
      ttlSeconds: 300
    }, {actor: "agent-gateway", idempotencyKey: `control-retry:${command.commandId}:${retryAttempt}`}).command;
    command.retryCommandId = retry.commandId;
  }
  const taskGroup = state.taskGroups.find((item) => item.id === dispatch.taskGroupId);
  if (taskGroup) {
    taskGroup.health = "attention";
    taskGroup.updatedAt = at;
  }
  command.failureHandledAt = at;
  appendGatewayEvent(state, "agent_dispatch_control_ack_failure", command.commandId, {nodeId: node.nodeId, commandType: command.commandType, status, dispatchId: dispatch.dispatchId, retryCommandId: command.retryCommandId || null});
}

export function submitAgentExecutionEvent(state, node, input = {}) {
  const prepared = prepareAgentExecutionEvent(state, node, input);
  if (prepared.duplicate) return prepared;
  return recordAgentExecutionEvent(state, node, prepared.event);
}

export function prepareAgentExecutionEvent(state, node, input = {}) {
  ensureAgentGatewayCollections(state);
  const dispatchId = String(input.dispatchId || "").trim();
  const dispatch = state.agentDispatches.find((item) => item.dispatchId === dispatchId && item.assignedNodeId === node.nodeId);
  if (!dispatch) throw gatewayError("dispatch_not_found", 404);
  const eventKey = String(input.eventKey || "").slice(0, 240);
  if (!eventKey) throw gatewayError("execution_event_key_required", 400);
  if (eventKey) {
    const existing = (state.agentExecutionEvents || []).find((item) => item.eventKey === eventKey);
    if (existing) return {event: existing, duplicate: true};
  }
  const at = new Date().toISOString();
  const nextSequence = Math.max(Number(state.agentExecutionSequence || 0) + 1, Date.now() * 1000 + Math.floor(Math.random() * 1000));
  state.agentExecutionSequence = nextSequence;
  const eventType = normalizeExecutionEventType(input.eventType || input.phase || "progress");
  const event = {
    schemaVersion: "agent-execution-event/v1",
    eventId: createId("aee"),
    sequence: nextSequence,
    nodeId: node.nodeId,
    dispatchId,
    projectId: dispatch.projectId,
    taskGroupId: dispatch.taskGroupId,
    workItemId: dispatch.workItemId,
    sessionId: dispatch.sessionId,
    runId: dispatch.runId,
    eventType,
    progressPercent: boundedInteger(input.progressPercent, 0, 100, progressForEventType(eventType)),
    status: ["running", "attention", "failed", "completed"].includes(input.status) ? input.status : statusForExecutionEvent(eventType),
    summary: String(input.summary || "").slice(0, 1000),
    outputTailDigest: /^sha256:[0-9a-f]{64}$/u.test(String(input.outputTailDigest || "")) ? input.outputTailDigest : null,
    evidenceRefs: uniqueStrings(input.evidenceRefs || []).slice(0, 40),
    eventKey: eventKey || null,
    payloadDigest: digestOf(input.payload || input.summary || eventType),
    languagePolicyDigest: dispatch.languagePolicyDigest || null,
    createdAt: at
  };
  return {event};
}

export function recordAgentExecutionEvent(state, node, event = {}, options = {}) {
  ensureAgentGatewayCollections(state);
  const dispatch = state.agentDispatches.find((item) =>
    item.dispatchId === event.dispatchId &&
    (item.assignedNodeId === node.nodeId || (options.allowHistoricalNodeBinding && event.nodeId === node.nodeId))
  );
  if (!dispatch) throw gatewayError("dispatch_not_found", 404);
  if (event.eventKey) {
    const existing = (state.agentExecutionEvents || []).find((item) => item.eventKey === event.eventKey);
    if (existing) return {event: existing, duplicate: true};
  }
  if ((state.agentExecutionEvents || []).some((item) => item.eventId === event.eventId)) return {event, duplicate: true};
  state.agentExecutionSequence = Math.max(Number(state.agentExecutionSequence || 0), Number(event.sequence || 0));
  state.agentExecutionEvents.unshift(event);
  state.agentExecutionEvents = state.agentExecutionEvents.slice(0, 500);
  const at = event.createdAt || new Date().toISOString();
  if (dispatch.status === "running" && dispatch.assignedNodeId === node.nodeId && dispatch.claimExpiresAt) {
    const ttlSeconds = boundedInteger(dispatch.claimTtlSeconds, 60, 21600, 1800);
    const renewed = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    if (renewed > dispatch.claimExpiresAt) dispatch.claimExpiresAt = renewed;
  }
  updateExecutionProgress(state, dispatch, event, at);
  appendGatewayEvent(state, "agent_execution_event", event.eventId, {nodeId: node.nodeId, dispatchId: event.dispatchId, eventType: event.eventType, progressPercent: event.progressPercent});
  return {event};
}

function applyControlCommandPreEffects(state, node, command) {
  if (["revoke", "shutdown"].includes(command.commandType)) {
    applyNodeStopPreEffects(state, node, command);
    return;
  }
  if (!["pause_dispatch", "cancel_dispatch", "resume_dispatch"].includes(command.commandType)) return;
  const dispatch = findNodeDispatchForControl(state, node, command);
  if (!dispatch) throw gatewayError("control_dispatch_not_active", 409);
  const at = command.createdAt;
  command.dispatchId = dispatch.dispatchId;
  command.projectId = dispatch.projectId;
  command.taskGroupId = dispatch.taskGroupId;
  command.sessionId = dispatch.sessionId;
  dispatch.controlCommandRef = command.commandId;
  dispatch.controlRequestedAt = at;
  if (command.commandType === "pause_dispatch") {
    dispatch.status = "blocked";
    dispatch.blockedReason = "control_pause_requested";
  } else if (command.commandType === "cancel_dispatch") {
    dispatch.status = "cancelled";
    dispatch.failureReason = "control_cancel_requested";
  } else {
    dispatch.status = "queued";
    dispatch.blockedReason = "control_resume_requested";
    delete dispatch.assignedNodeId;
    delete dispatch.claimedAt;
    delete dispatch.claimExpiresAt;
    delete dispatch.revocationPending;
  }
  dispatch.updatedAt = at;
  revokeDispatchMcpGrants(state, node.nodeId, dispatch.dispatchId, `control_${command.commandType}`);
  const session = state.workSessions.find((item) => item.sessionId === dispatch.sessionId);
  if (session) {
    session.status = command.commandType === "pause_dispatch" ? "blocked" : command.commandType === "cancel_dispatch" ? "aborted" : "active";
    session.controlCommandRef = command.commandId;
    session.updatedAt = at;
  }
  const taskGroup = state.taskGroups.find((item) => item.id === dispatch.taskGroupId);
  const workItem = taskGroup?.workItems?.find((item) => item.id === dispatch.workItemId);
  if (workItem) {
    workItem.status = command.commandType === "resume_dispatch" ? "ready" : "blocked";
    workItem.blockedReason = command.commandType === "pause_dispatch" ? "control_pause_requested" : command.commandType === "cancel_dispatch" ? "control_cancel_requested" : "control_resume_requested";
    workItem.updatedAt = at;
  }
  if (command.commandType === "resume_dispatch") node.activeDispatchIds = (node.activeDispatchIds || []).filter((id) => id !== dispatch.dispatchId);
  if (taskGroup) {
    taskGroup.health = "attention";
    taskGroup.updatedAt = at;
  }
  appendGatewayEvent(state, "agent_control_pre_effect_applied", command.commandId, {dispatchId: dispatch.dispatchId, commandType: command.commandType});
}

function applyNodeStopPreEffects(state, node, command) {
  const at = command.createdAt || new Date().toISOString();
  const pendingReason = command.commandType === "revoke"
    ? "assigned_node_revocation_pending_stop"
    : "assigned_node_shutdown_pending_stop";
  const pendingDispatchIds = [];
  for (const dispatch of state.agentDispatches || []) {
    if (dispatch.assignedNodeId !== node.nodeId || !["running", "blocked"].includes(dispatch.status)) continue;
    dispatch.status = "blocked";
    dispatch.blockedReason = pendingReason;
    dispatch.controlCommandRef = command.commandId;
    dispatch.controlRequestedAt = at;
    if (command.commandType === "revoke") dispatch.revocationPending = true;
    else delete dispatch.revocationPending;
    dispatch.updatedAt = at;
    pendingDispatchIds.push(dispatch.dispatchId);
    revokeDispatchMcpGrants(state, node.nodeId, dispatch.dispatchId, pendingReason);
  }
  command.payload = {
    ...(command.payload || {}),
    activeDispatchIds: uniqueStrings([...(command.payload?.activeDispatchIds || []), ...pendingDispatchIds])
  };
  node.status = "draining";
  node.admission = "read_only";
  node.updatedAt = at;
  appendGatewayEvent(state, "agent_node_stop_pre_effect_applied", command.commandId, {nodeId: node.nodeId, commandType: command.commandType, pendingDispatchIds});
}

function findNodeDispatchForControl(state, node, command) {
  const candidates = (state.agentDispatches || []).filter((dispatch) =>
    dispatch.assignedNodeId === node.nodeId &&
    (command.dispatchId ? dispatch.dispatchId === command.dispatchId : (node.activeDispatchIds || []).includes(dispatch.dispatchId))
  );
  return candidates.find((dispatch) => ["running", "blocked"].includes(dispatch.status)) || candidates[0] || null;
}

function finalizeNodeRevocation(state, node, command) {
  const at = new Date().toISOString();
  const commandDispatchIds = new Set(command.payload?.activeDispatchIds || []);
  const requeuedDispatchIds = [];
  for (const dispatch of state.agentDispatches || []) {
    if (dispatch.assignedNodeId !== node.nodeId) continue;
    const commandOwned = dispatch.controlCommandRef === command.commandId || dispatch.revocationPending;
    const wasActive = commandDispatchIds.has(dispatch.dispatchId) || (node.activeDispatchIds || []).includes(dispatch.dispatchId);
    if (!commandOwned && !wasActive) continue;
    if (!["running", "blocked", "cancelled", "failed"].includes(dispatch.status)) continue;
    dispatch.status = "queued";
    dispatch.blockedReason = "assigned_node_revocation_ack_requeued";
    delete dispatch.assignedNodeId;
    delete dispatch.claimedAt;
    delete dispatch.claimExpiresAt;
    delete dispatch.revocationPending;
    dispatch.updatedAt = at;
    requeuedDispatchIds.push(dispatch.dispatchId);
  }
  node.status = "revoked";
  node.admission = "read_only";
  node.activeDispatchIds = [];
  node.updatedAt = at;
  command.finalizedAt = at;
  appendGatewayEvent(state, "node_revoked", node.nodeId, {commandId: command.commandId, requeuedDispatchIds});
}

function finalizeNodeShutdown(state, node, command) {
  const at = new Date().toISOString();
  const commandDispatchIds = new Set(command.payload?.activeDispatchIds || []);
  const requeuedDispatchIds = [];
  for (const dispatch of state.agentDispatches || []) {
    if (dispatch.assignedNodeId !== node.nodeId) continue;
    const wasActive = commandDispatchIds.has(dispatch.dispatchId) || (node.activeDispatchIds || []).includes(dispatch.dispatchId);
    if (!wasActive || !["running", "blocked", "cancelled", "failed"].includes(dispatch.status)) continue;
    dispatch.status = "queued";
    dispatch.blockedReason = "assigned_node_shutdown_ack_requeued";
    delete dispatch.assignedNodeId;
    delete dispatch.claimedAt;
    delete dispatch.claimExpiresAt;
    delete dispatch.revocationPending;
    dispatch.updatedAt = at;
    revokeDispatchMcpGrants(state, node.nodeId, dispatch.dispatchId, "assigned_node_shutdown_ack_requeued");
    requeuedDispatchIds.push(dispatch.dispatchId);
  }
  node.status = "offline";
  node.admission = "read_only";
  node.activeDispatchIds = [];
  node.updatedAt = at;
  command.finalizedAt = at;
  appendGatewayEvent(state, "node_shutdown_completed", node.nodeId, {commandId: command.commandId, requeuedDispatchIds});
}

function handleStopControlFailure(state, node, command, status) {
  const at = new Date().toISOString();
  node.status = "degraded";
  node.admission = "read_only";
  node.updatedAt = at;
  const affectedDispatchIds = [];
  for (const dispatch of state.agentDispatches || []) {
    if (dispatch.assignedNodeId !== node.nodeId) continue;
    const commandOwned = dispatch.controlCommandRef === command.commandId || dispatch.revocationPending || (command.payload?.activeDispatchIds || []).includes(dispatch.dispatchId);
    if (!commandOwned || !["running", "blocked", "cancelled", "failed"].includes(dispatch.status)) continue;
    dispatch.status = "blocked";
    dispatch.blockedReason = `assigned_node_${command.commandType}_${status}_retry_queued`;
    dispatch.controlCommandRef = command.commandId;
    if (command.commandType === "revoke" || dispatch.revocationPending) dispatch.revocationPending = true;
    else delete dispatch.revocationPending;
    dispatch.updatedAt = at;
    affectedDispatchIds.push(dispatch.dispatchId);
  }
  const retryAttempt = Number(command.payload?.retryAttempt || 0) + 1;
  if (retryAttempt <= 3) {
    const retry = createAgentControlCommand(state, node, {
      commandType: command.commandType,
      payload: {...(command.payload || {}), retryOf: command.commandId, retryAttempt},
      ttlSeconds: 300
    }, {actor: "agent-gateway", idempotencyKey: `control-retry:${command.commandId}:${retryAttempt}`}).command;
    command.retryCommandId = retry.commandId;
  }
  command.failureHandledAt = at;
  appendGatewayEvent(state, "agent_stop_control_retry_queued", command.commandId, {nodeId: node.nodeId, commandType: command.commandType, status, affectedDispatchIds, retryCommandId: command.retryCommandId || null});
}

export function finishNodeDispatch(state, node, dispatchId, succeeded) {
  node.activeDispatchIds = (node.activeDispatchIds || []).filter((id) => id !== dispatchId);
  if (succeeded) node.completedDispatchCount = Number(node.completedDispatchCount || 0) + 1;
  else node.failedDispatchCount = Number(node.failedDispatchCount || 0) + 1;
  node.updatedAt = new Date().toISOString();
  revokeDispatchMcpGrants(state, node.nodeId, dispatchId, succeeded ? "dispatch_completed" : "dispatch_failed");
  appendGatewayEvent(state, succeeded ? "dispatch_completed" : "dispatch_failed", dispatchId, {nodeId: node.nodeId});
}

export function getSkillWorkset(state, node, worksetId, options = {}) {
  const dispatch = (state.agentDispatches || []).find((item) =>
    item.status === "running" &&
    item.assignedNodeId === node.nodeId &&
    item.skillWorksetId === worksetId
  );
  if (!dispatch) throw gatewayError("skill_workset_not_found", 404);
  const contract = state.agentTaskContracts.find((item) =>
    item.sessionId === dispatch.sessionId &&
    item.runId === dispatch.runId &&
    item.roleSkill?.worksetId === worksetId
  );
  if (!contract || !node.projectIds.includes(contract.projectId)) throw gatewayError("skill_workset_not_found", 404);
  return buildSkillWorkset(state, contract, options);
}

export function publicAgentNode(node) {
  const {
    credentialDigest: _credentialDigest,
    previousCredentialDigest: _previousCredentialDigest,
    previousCredentialExpiresAt: _previousCredentialExpiresAt,
    ...safe
  } = node;
  return safe;
}

function buildDispatchPackage(state, dispatch, node, options) {
  const contract = state.agentTaskContracts.find((item) => item.sessionId === dispatch.sessionId && item.runId === dispatch.runId);
  const repositoryOutputTarget = state.repositoryOutputs.find((item) => item.targetId === dispatch.repositoryOutputTargetRef);
  const instructionPacket = state.effectiveInstructionPackets.find((item) => item.packetId === contract?.effectiveInstructionPacketRef);
  if (!contract || !repositoryOutputTarget || !instructionPacket) throw gatewayError("dispatch_package_incomplete", 409);
  const skillWorkset = buildSkillWorkset(state, contract, options);
  return {
    schemaVersion: "agent-dispatch-package/v1",
    dispatch,
    taskContract: contract,
    effectiveInstructionPacket: instructionPacket,
    repositoryOutputTarget,
    skillWorkset: {
      worksetId: skillWorkset.worksetId,
      worksetDigest: skillWorkset.worksetDigest,
      downloadPath: `/api/agent/v1/skill-worksets/${encodeURIComponent(skillWorkset.worksetId)}`,
      requiredSkillRefs: skillWorkset.requiredSkillRefs,
      languagePolicy: skillWorkset.languagePolicy,
      languagePolicyDigest: skillWorkset.languagePolicyDigest,
      executionDirective: skillWorkset.executionDirective
    },
    remoteServices: {
      mcpPath: "/mcp",
      checkpointPath: `/api/agent/v1/dispatches/${encodeURIComponent(dispatch.dispatchId)}/checkpoint`,
      failurePath: `/api/agent/v1/dispatches/${encodeURIComponent(dispatch.dispatchId)}/fail`
    },
    nodeBinding: {nodeId: node.nodeId, profileDigest: node.profileDigest},
    packageDigest: digestOf({dispatch, contractDigest: contract.contractDigest, worksetDigest: skillWorkset.worksetDigest, nodeId: node.nodeId})
  };
}

function buildSkillWorkset(state, contract, options) {
  const runtimeDir = resolve(options.runtimeDir || ".runtime");
  const effectiveRef = String(contract.roleSkill?.roleSkillRef || contract.roleSkill?.selectedAgentSkillRef || "");
  const baseRef = effectiveRef.split("+")[0];
  const skill = state.roleSkills.find((item) => item.roleSkillId === baseRef) || state.roleSkills.find((item) => item.roleSkillId === effectiveRef);
  if (!skill) throw gatewayError("role_skill_not_found", 409);
  const files = [];
  if (skill.sourceId === "agency-agents-zh" && skill.sourcePath) {
    const sourceRoot = resolve(runtimeDir, "skill-sources", skill.sourceId, "repo");
    const target = resolve(sourceRoot, normalize(skill.sourcePath));
    if (!inside(sourceRoot, target) || !existsSync(target)) throw gatewayError("role_skill_source_missing", 409);
    const content = readFileSync(target, "utf8");
    if (digestOf(content) !== skill.contentDigest) throw gatewayError("role_skill_digest_mismatch", 409);
    files.push({path: "SKILL.md", content, contentDigest: skill.contentDigest, sourcePath: skill.sourcePath});
  } else {
    const content = [`# ${skill.name}`, "", skill.description, "", `Capabilities: ${(skill.capabilities || []).join(", ")}`, ""].join("\n");
    files.push({path: "SKILL.md", content, contentDigest: digestOf(content), sourcePath: skill.sourcePath});
  }
  const overlayRefs = contract.roleSkill?.overlayRefs || [];
  const overlays = (state.roleSkillOverlays || []).filter((item) => overlayRefs.includes(item.overlayId)).map((overlay) => ({
    overlayId: overlay.overlayId,
    overlayDigest: overlay.overlayDigest,
    patch: overlay.patch
  }));
  const languagePolicy = normalizeTaskGroupLanguagePolicy(contract.languagePolicy);
  const languagePolicyDigest = contract.languagePolicyDigest || digestOf(languagePolicy);
  const requiredSkillRefs = [effectiveRef];
  const manifestSeed = {
    roleId: contract.roleId,
    synchronizationMode: "server_managed_on_demand",
    requiredSkillRefs,
    roleSkillDigest: contract.roleSkill.roleSkillDigest,
    languagePolicyDigest,
    overlays,
    files: files.map(({path, contentDigest, sourcePath}) => ({path, contentDigest, sourcePath}))
  };
  const worksetDigest = digestOf(manifestSeed);
  const worksetId = contract.roleSkill.worksetId || `skillset_${worksetDigest.slice("sha256:".length, "sha256:".length + 24)}`;
  return {
    schemaVersion: "agent-skill-workset/v1",
    worksetId,
    worksetDigest,
    projectId: contract.projectId,
    taskGroupId: contract.taskGroupId,
    workItemId: contract.workId,
    roleId: contract.roleId,
    synchronizationMode: "server_managed_on_demand",
    languagePolicy,
    languagePolicyDigest,
    requiredSkillRefs,
    overlays,
    files,
    executionDirective: `The ${contract.roleId} agent MUST load and apply every skill in this workset before executing the task. Child roles MUST receive their own explicit skill workset from the control plane; they may not inherit or choose skills implicitly. ${languagePolicyDirective(languagePolicy)}`,
    createdAt: contract.issuedAt
  };
}

function mcpToolsForRoles(roles) {
  const control = roles.some((role) => ["orchestrator", "scheduler", "monitor", "reviewer", "security"].includes(role));
  return uniqueStrings([...DEFAULT_AGENT_MCP_TOOLS, ...(control ? CONTROL_ROLE_MCP_TOOLS : [])]);
}

function normalizeControlCommandType(value) {
  const normalized = String(value || "").trim();
  if (["refresh_profile", "pause_dispatch", "cancel_dispatch", "resume_dispatch", "shutdown", "revoke"].includes(normalized)) return normalized;
  throw gatewayError("agent_control_command_type_invalid", 400);
}

function normalizeExecutionEventType(value) {
  const normalized = String(value || "").trim();
  if ([
    "dispatch_received",
    "skill_synced",
    "executor_started",
    "executor_output",
    "repository_changed",
    "git_committed",
    "git_pushed",
    "checkpoint_prepared",
    "checkpoint_submitted",
    "heartbeat",
    "blocked",
    "drift_signal",
    "failed"
  ].includes(normalized)) return normalized;
  return "progress";
}

function progressForEventType(eventType) {
  return {
    dispatch_received: 8,
    skill_synced: 15,
    executor_started: 25,
    executor_output: 45,
    repository_changed: 65,
    git_committed: 80,
    git_pushed: 90,
    checkpoint_prepared: 95,
    checkpoint_submitted: 100,
    blocked: 35,
    drift_signal: 35,
    failed: 100
  }[eventType] || 50;
}

function statusForExecutionEvent(eventType) {
  if (eventType === "failed") return "failed";
  if (eventType === "blocked" || eventType === "drift_signal") return "attention";
  if (eventType === "checkpoint_submitted") return "completed";
  return "running";
}

function updateExecutionProgress(state, dispatch, event, at) {
  dispatch.lastExecutionEventRef = `AgentExecutionEvent:${event.eventId}`;
  dispatch.lastExecutionEventAt = at;
  dispatch.progressPercent = Math.max(Number(dispatch.progressPercent || 0), event.progressPercent);
  dispatch.updatedAt = at;
  const session = state.workSessions.find((item) => item.sessionId === dispatch.sessionId);
  if (session) {
    session.lastExecutionEventRef = dispatch.lastExecutionEventRef;
    session.progressPercent = Math.max(Number(session.progressPercent || 0), event.progressPercent);
    if (event.status === "attention" && session.status === "active") session.status = "monitor_attention";
    session.updatedAt = at;
  }
  const taskGroup = state.taskGroups.find((item) => item.id === dispatch.taskGroupId);
  const workItem = taskGroup?.workItems?.find((item) => item.id === dispatch.workItemId);
  if (workItem) {
    workItem.progress = Math.max(Number(workItem.progress || 0), Math.min(99, event.progressPercent));
    if (event.status === "attention") taskGroup.health = "attention";
    workItem.updatedAt = at;
    taskGroup.updatedAt = at;
  }
}

function sanitizeAckResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const text = JSON.stringify(value);
  if (text.length > 10000) return {truncated: true, resultDigest: digestOf(text)};
  return JSON.parse(text);
}

function roleAllowed(role, allowedRoles) {
  return allowedRoles.includes("*") || allowedRoles.includes(role);
}

function rolesAllowed(requested, allowed) {
  return allowed.includes("*") || requested.every((role) => allowed.includes(role));
}

function modelRunnable(model, profile = {}) {
  const providers = new Set((profile.models || []).filter((item) => item.available !== false).map((item) => item.providerClass || item.provider).filter(Boolean));
  if (!providers.size) return false;
  const provider = String(model?.providerClass || model?.alias || String(model?.modelId || model?.model || "").split(":")[0] || "custom");
  return providers.has(provider) || providers.has("custom");
}

function sanitizeNodeProfile(profile) {
  return {
    platform: String(profile.platform || "unknown"),
    arch: String(profile.arch || "unknown"),
    cpuCount: boundedInteger(profile.cpuCount, 0, 4096, 0),
    memoryBytes: boundedInteger(profile.memoryBytes, 0, Number.MAX_SAFE_INTEGER, 0),
    diskFreeBytes: boundedInteger(profile.diskFreeBytes, 0, Number.MAX_SAFE_INTEGER, 0),
    tools: Array.isArray(profile.tools) ? profile.tools.slice(0, 100).map((item) => ({name: String(item.name || ""), version: String(item.version || "unknown"), available: item.available === true})) : [],
    models: Array.isArray(profile.models) ? profile.models.slice(0, 100).map((item) => ({providerClass: String(item.providerClass || "custom"), adapter: String(item.adapter || "custom"), available: item.available !== false})) : [],
    capabilityFlags: uniqueStrings(profile.capabilityFlags || []).slice(0, 100),
    observedAt: new Date().toISOString()
  };
}

function normalizeChecks(checks) {
  return checks.slice(0, 100).map((check) => ({
    checkId: String(check.checkId || "unknown"),
    status: check.status === "ok" ? "ok" : "failed",
    detail: String(check.detail || "").slice(0, 1000)
  }));
}

function publicJoinToken(record) {
  const { tokenDigest: _tokenDigest, ...safe } = record;
  return safe;
}

function appendGatewayEvent(state, eventType, subjectId, payload) {
  state.agentGatewayEvents.unshift({eventId: createId("age"), eventType, subjectId, payload, createdAt: new Date().toISOString()});
  state.agentGatewayEvents = state.agentGatewayEvents.slice(0, 1000);
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value).trim()).filter(Boolean))];
}

function boundedInteger(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

function inside(root, target) {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target === root || target.startsWith(prefix);
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/u, "");
}

function shellArg(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function shellUrl(value) {
  if (!/^https?:\/\//u.test(value)) throw new Error("public_url_must_be_http_or_https");
  return shellArg(value);
}

function gatewayError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}
