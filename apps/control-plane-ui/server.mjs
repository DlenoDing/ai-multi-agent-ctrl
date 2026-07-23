import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureStoredState, isStateStoreConflict, markRuntimeStorage, readStoredState, stateStoreKind, writeStoredState } from "./lib/state-store.mjs";
import { appendProjectExecutionEvent, readProjectExecutionEvents } from "./lib/project-event-store.mjs";
import {
  authenticateAgentNode,
  ackAgentControlCommand,
  claimNextDispatch,
  createAgentControlCommand,
  createAgentJoinToken,
  ensureAgentGatewayCollections,
  finishNodeDispatch,
  getDispatchForNode,
  getSkillWorkset,
  heartbeatAgentNode,
  listAgentControlCommands,
  listAgentJoinTokens,
  publicAgentNode,
  registerAgentNode,
  requestAgentNodeRevocation,
  revokeDispatchMcpGrants,
  revokeAgentNode,
  selfCheckAgentNode,
  submitAgentExecutionEvent
} from "./lib/agent-gateway.mjs";
import { handleMcpJsonRpc, isWriteTool } from "../mcp-server/server.mjs";
import {
  canUseGitPath,
  acceptAgentCheckpoint,
  collectRuntimeIssue,
  computeCloseBarrier,
  computeCompletionReadiness,
  createId,
  decideSessionPlacement,
  defaultModelCapabilities,
  digestOf,
  ensureRuntimeCollections,
  gitHead,
  gitRemoteUrl,
  pathAllowlistValid,
  registerRoleSkillOverlay,
  runAgentRuntimeWorker,
  runAutonomousCycle,
  selectModel,
  syncSkillSource
} from "./lib/control-plane-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = resolve(process.env.AIMAC_REPOSITORY_ROOT || root);
const publicDir = join(root, "apps", "control-plane-ui", "public");
const runtimeDir = resolve(root, process.env.AIMAC_RUNTIME_DIR || ".runtime");
const statePath = join(runtimeDir, "control-plane-state.json");
const configPath = join(runtimeDir, "runtime-config.json");
const seedPath = join(root, "data", "seed-state.json");
const agentInstallerPath = join(root, "scripts", "install-agent.sh");
const agentRuntimePath = join(root, "apps", "agent-runtime", "runtime.mjs");
const host = process.env.AIMAC_HOST || "127.0.0.1";
const port = Number(process.env.AIMAC_PORT || 4317);
const executionProfile = process.env.AIMAC_EXECUTION_PROFILE || "production";
const stateViewCache = new Map();
const stateViewCacheTtlMs = Number(process.env.AIMAC_STATE_VIEW_CACHE_TTL_MS || 500);
const stateViewMaxEntries = Number(process.env.AIMAC_STATE_VIEW_CACHE_MAX_ENTRIES || 200);

const unsafeSecretValues = new Set([
  "",
  "change-this-bootstrap-token",
  "change-this-mcp-service-token",
  "change-this-local-workspace-owner-token",
  "change-this-local-reviewer-token",
  "change-this-local-agent-runtime-token"
]);

const defaultMcpServiceToolAllowlist = [
  "orchestration-mcp.state_get",
  "room-mcp.room_join",
  "room-mcp.room_send",
  "room-mcp.room_wait",
  "room-mcp.room_ack",
  "agent-control-mcp.node_probe",
  "agent-control-mcp.dispatch_status",
  "scheduler-mcp.model_select",
  "scheduler-mcp.session_place",
  "scheduler-mcp.capacity_snapshot",
  "scheduler-mcp.execution_topology_plan",
  "scheduler-mcp.derived_task_classify",
  "resource-mcp.lease_claim",
  "resource-mcp.lease_release",
  "resource-mcp.resource_snapshot",
  "model-mcp.model_capabilities",
  "model-mcp.model_policy_get",
  "model-mcp.model_select",
  "skill-mcp.skill_source_sync",
  "skill-mcp.role_skill_parse",
  "skill-mcp.role_skill_overlay_validate",
  "skill-mcp.role_skill_resolve",
  "evidence-mcp.artifact_register",
  "evidence-mcp.test_result_submit",
  "permission-mcp.permission_probe",
  "permission-mcp.permission_request_submit",
  "permission-mcp.permission_status",
  "review-mcp.review_plan_create",
  "review-mcp.review_bundle_register",
  "review-mcp.review_result_consume",
  "review-mcp.completion_readiness_compute",
  "definition-mcp.shared_definition_create",
  "definition-mcp.shared_definition_publish",
  "definition-mcp.shared_definition_consumer_bind",
  "definition-mcp.shared_definition_conflict_report",
  "instruction-mcp.cache_key_index",
  "instruction-mcp.stable_prefix_get",
  "instruction-mcp.delta_payload_compact",
  "repository-mcp.repository_output_target_select",
  "repository-mcp.repository_target_lease_bind",
  "repository-mcp.artifact_manifest_index",
  "ui-console-mcp.runtime_health_get",
  "ui-console-mcp.management_surface_get",
  "ui-console-mcp.project_progress_get",
  "ui-console-mcp.task_group_progress_get"
];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function now() {
  return new Date().toISOString();
}

function ensureState() {
  mkdirSync(runtimeDir, { recursive: true });
  ensureRuntimeConfig();
  ensureStoredState({root, runtimeDir, statePath, seedPath, buildInitialState});
}

function buildInitialState() {
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));
  seed.runtime.updatedAt = now();
  seed.runtime.executionProfile = executionProfile;
  ensureRuntimeCollections(seed, {root: repositoryRoot, runtimeDir, endpoint: process.env.AIMAC_PUBLIC_URL || localEndpoint(), executionProfile});
  markRuntimeStorage(seed, ".runtime/control-plane-state.json");
  return seed;
}

function ensureRuntimeConfig() {
  mkdirSync(runtimeDir, { recursive: true });
  const existing = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  const localToken = process.env.AIMAC_BOOTSTRAP_TOKEN || existing.localBootstrapToken || randomBytes(24).toString("base64url");
  const workspaceOwnerTokenEnv = process.env.AIMAC_LOCAL_SEED_WORKSPACE_OWNER_TOKEN;
  const reviewerTokenEnv = process.env.AIMAC_LOCAL_SEED_REVIEWER_TOKEN;
  const agentRuntimeTokenEnv = process.env.AIMAC_LOCAL_SEED_AGENT_RUNTIME_TOKEN;
  const workspaceOwnerToken = workspaceOwnerTokenEnv || existing.localAccountTokens?.acct_workspace_owner || randomBytes(24).toString("base64url");
  const reviewerToken = reviewerTokenEnv || existing.localAccountTokens?.acct_reviewer || randomBytes(24).toString("base64url");
  const agentRuntimeToken = agentRuntimeTokenEnv || existing.localAccountTokens?.acct_agent_runtime || randomBytes(24).toString("base64url");
  const mcpServiceToken = process.env.AIMAC_MCP_SERVICE_TOKEN || existing.localMcpServiceToken || randomBytes(32).toString("base64url");
  const localAccountTokenHashes = {
    acct_workspace_owner: digestOf(`account:acct_workspace_owner:${workspaceOwnerToken}`),
    acct_reviewer: digestOf(`account:acct_reviewer:${reviewerToken}`),
    acct_agent_runtime: digestOf(`account:acct_agent_runtime:${agentRuntimeToken}`)
  };
  const localAccountTokens = {
    ...(workspaceOwnerTokenEnv ? {} : {acct_workspace_owner: workspaceOwnerToken}),
    ...(reviewerTokenEnv ? {} : {acct_reviewer: reviewerToken}),
    ...(agentRuntimeTokenEnv ? {} : {acct_agent_runtime: agentRuntimeToken})
  };
  const config = {
    schemaVersion: "runtime-local-config/v1",
    runtimeDir,
    statePath,
    repositoryRoot,
    executionProfile,
    host,
    port,
    publicUrl: process.env.AIMAC_PUBLIC_URL || existing.publicUrl || null,
    databaseUrl: process.env.DATABASE_URL || existing.databaseUrl || null,
    stateStore: stateStoreKind(),
    bootstrapTokenHash: digestOf(`bootstrap:${localToken}`),
    bootstrapTokenConfigured: true,
    mcpServiceTokenHash: digestOf(`mcp-service:${mcpServiceToken}`),
    localAccountTokenHashes,
    localBootstrapToken: process.env.AIMAC_BOOTSTRAP_TOKEN ? undefined : localToken,
    localMcpServiceToken: process.env.AIMAC_MCP_SERVICE_TOKEN ? undefined : mcpServiceToken,
    localAccountTokens,
    updatedAt: existing.updatedAt || now()
  };
  const comparableExisting = {...existing, updatedAt: config.updatedAt};
  if (!existsSync(configPath) || JSON.stringify(comparableExisting) !== JSON.stringify(config)) {
    config.updatedAt = now();
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  return config;
}

function readRuntimeConfig() {
  if (!existsSync(configPath)) return ensureRuntimeConfig();
  return JSON.parse(readFileSync(configPath, "utf8"));
}

function assertRuntimeSecurity() {
  for (const envName of [
    "AIMAC_BOOTSTRAP_TOKEN",
    "AIMAC_MCP_SERVICE_TOKEN",
    "AIMAC_LOCAL_SEED_WORKSPACE_OWNER_TOKEN",
    "AIMAC_LOCAL_SEED_REVIEWER_TOKEN",
    "AIMAC_LOCAL_SEED_AGENT_RUNTIME_TOKEN"
  ]) {
    if (process.env[envName] !== undefined && weakSecret(process.env[envName])) {
      throw new Error(`${envName}_is_unsafe_default_or_too_short`);
    }
  }
  const configuredPublicUrl = process.env.AIMAC_PUBLIC_URL || readRuntimeConfig().publicUrl || "";
  if (host === "0.0.0.0" && !configuredPublicUrl) throw new Error("AIMAC_PUBLIC_URL_required_when_binding_public_host");
  if (configuredPublicUrl) {
    const parsed = new URL(configuredPublicUrl);
    if (parsed.protocol !== "https:" && !isLocalHostname(parsed.hostname) && process.env.AIMAC_ALLOW_INSECURE_PUBLIC_URL !== "true") {
      throw new Error("AIMAC_PUBLIC_URL_requires_https_for_non_local_hosts");
    }
  }
}

function weakSecret(value) {
  const text = String(value || "").trim();
  return unsafeSecretValues.has(text) || text.length < 20;
}

function readState() {
  ensureState();
  const state = readStoredState({root, runtimeDir, statePath, seedPath, buildInitialState});
  ensureRuntimeCollections(state, {root: repositoryRoot, runtimeDir, endpoint: process.env.AIMAC_PUBLIC_URL || localEndpoint(), executionProfile});
  markRuntimeStorage(state, ".runtime/control-plane-state.json");
  return state;
}

function writeState(state) {
  markRuntimeStorage(state, ".runtime/control-plane-state.json");
  writeStoredState(state, {root, runtimeDir, statePath, seedPath, buildInitialState, expectedStateVersion: state.__loadedStateVersion});
}

function audit(state, actor, action, subject, result = "succeeded") {
  ensureControlState(state);
  state.auditLog.unshift({
    id: `audit_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    at: now(),
    actor,
    action,
    subject,
    result
  });
  state.auditLog = state.auditLog.slice(0, 80);
}

function ensureControlState(state) {
  ensureRuntimeCollections(state, {root: repositoryRoot, runtimeDir, endpoint: process.env.AIMAC_PUBLIC_URL || localEndpoint(), executionProfile});
  ensureAgentGatewayCollections(state);
}

function beginGuardedWrite(req, state, action, subject, resourceScope = inferResourceScope(state, subject)) {
  ensureControlState(state);
  const authenticated = authenticateRequest(req, state);
  if (!authenticated) {
    return {status: 401, payload: {error: "auth_required"}};
  }
  const idempotencyKey = req.headers["idempotency-key"];
  if (!idempotencyKey) {
    return {status: 428, payload: {error: "idempotency_key_required"}};
  }
  const actor = authenticated.accountId;
  const account = state.accounts.find((item) => accountIdOf(item) === actor);
  if (!principalAllowedForAction(account, action)) {
    return {status: 403, payload: {error: "principal_not_allowed_for_action", actor, action}};
  }
  const bodyDigest = req.bodyDigest || digestOf("");
  const existingRecord = state.idempotencyRecords[idempotencyKey];
  if (existingRecord) {
    if (existingRecord.actor !== actor || existingRecord.action !== action || existingRecord.bodyDigest !== bodyDigest) {
      return {status: 409, payload: {error: "idempotency_key_reuse_conflict"}};
    }
    return {status: existingRecord.status, payload: existingRecord.payload};
  }
  const drift = writeDriftCheck(state, action, resourceScope);
  if (!drift.allowed) {
    return {status: 409, payload: {error: "role_drift_guard_not_clear", driftSignals: drift.signals}};
  }
  const at = now();
  const requiredPermission = permissionForAction(action);
  const allowed = hasPermission(state, actor, requiredPermission, resourceScope);
  const policyDecision = {
    id: createId("pd"),
    status: allowed ? "allowed" : "denied",
    actor,
    action,
    resource: subject,
    resourceScope,
    policyVersion: "local-demo-policy/v1",
    requiredPermission,
    evidenceRefs: [`idempotency:${idempotencyKey}`, `actor:${actor}`],
    createdAt: at
  };
  if (!allowed) {
    state.policyDecisions.unshift(policyDecision);
    state.policyDecisions = state.policyDecisions.slice(0, 120);
    audit(state, "policy-engine", "policy_decision_denied", subject, "denied");
    commitDirectStateWrite(state);
    return {status: 403, payload: {error: "policy_denied", actor, requiredPermission, resourceScope}};
  }
  const command = {
    id: createId("cmd"),
    type: action,
    subject,
    status: "admitted",
    idempotencyKey,
    policyDecisionRef: policyDecision.id,
    createdAt: at,
    updatedAt: at
  };
  return {idempotencyKey, policyDecision, command, actor, bodyDigest, resourceScope};
}

function finishGuardedWrite(state, guard, status, payload) {
  ensureControlState(state);
  const updatedAt = now();
  state.stateVersion += 1;
  const decisionRecord = {
    decisionId: createId("decision"),
    status: "accepted",
    actor: guard.actor,
    action: guard.command.type,
    subject: guard.command.subject,
    policyDecisionRef: guard.policyDecision.id,
    payloadDigest: digestOf(payload),
    createdAt: updatedAt,
    auditRef: `audit:${guard.idempotencyKey}`
  };
  state.decisionRecords.unshift(decisionRecord);
  state.policyDecisions.unshift(guard.policyDecision);
  state.commands.unshift({...guard.command, status: "succeeded", resultRef: `response:${guard.idempotencyKey}`, updatedAt});
  state.decisionRecords = state.decisionRecords.slice(0, 120);
  state.policyDecisions = state.policyDecisions.slice(0, 120);
  state.commands = state.commands.slice(0, 120);
  state.idempotencyRecords[guard.idempotencyKey] = {status, payload, actor: guard.actor, action: guard.command.type, bodyDigest: guard.bodyDigest, createdAt: updatedAt};
  audit(state, "policy-engine", "policy_decision_allowed", guard.command.subject);
  audit(state, "command-bus", "command_succeeded", guard.command.subject);
}

function accountIdOf(account) {
  return account.accountId || account.id;
}

function principalAllowedForAction(account, action) {
  if (!account) return false;
  if (["agent_runtime_worker_run", "checkpoint_submit"].includes(action)) {
    return account.accountType === "service_account" && (account.roles || []).includes("service_agent_runtime");
  }
  return true;
}

function stableDigest(fill) {
  return digestOf(fill);
}

function gitTrackablePath(path) {
  return canUseGitPath(path);
}

function validPathAllowlist(paths) {
  return pathAllowlistValid(paths);
}

function localEndpoint() {
  return `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
}

function publicEndpoint(req) {
  const configured = process.env.AIMAC_PUBLIC_URL || readRuntimeConfig().publicUrl;
  if (configured) return String(configured).replace(/\/+$/u, "");
  if (!req) return localEndpoint();
  const hostHeader = String(req.headers.host || "").trim();
  if (!requestHostAllowed(hostHeader)) return localEndpoint();
  const forwardedProto = process.env.AIMAC_TRUST_PROXY === "true" ? String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() : "";
  const protocol = forwardedProto || (req.socket.encrypted ? "https" : "http");
  if (protocol !== "https" && !isLocalHostHeader(hostHeader) && process.env.AIMAC_ALLOW_INSECURE_PUBLIC_URL !== "true") return localEndpoint();
  return `${protocol}://${hostHeader}`.replace(/\/+$/u, "");
}

function requestHostAllowed(hostHeader) {
  if (!hostHeader) return false;
  if (isLocalHostHeader(hostHeader)) return true;
  const allowed = new Set(String(process.env.AIMAC_ALLOWED_PUBLIC_HOSTS || "").split(",").map((item) => item.trim()).filter(Boolean));
  const hostname = hostnameFromHostHeader(hostHeader);
  return allowed.has(hostHeader) || allowed.has(hostname);
}

function isLocalHostHeader(hostHeader) {
  return isLocalHostname(hostnameFromHostHeader(hostHeader));
}

function hostnameFromHostHeader(hostHeader) {
  const value = String(hostHeader || "").trim();
  if (value.startsWith("[")) return value.slice(1, value.indexOf("]"));
  return value.split(":")[0];
}

function isLocalHostname(hostname) {
  return ["127.0.0.1", "localhost", "::1"].includes(String(hostname || "").toLowerCase());
}

function canExposeBootstrapHint(req) {
  if (process.env.AIMAC_EXPOSE_BOOTSTRAP_HINT !== "true" && executionProfile === "production") return false;
  return isLoopbackAddress(req.socket.remoteAddress) && isLocalHostHeader(String(req.headers.host || ""));
}

function isLoopbackAddress(address) {
  const value = String(address || "");
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function authenticateRequest(req, state) {
  const token = bearerToken(req);
  if (!token) return null;
  const tokenDigest = digestOf(`session:${token}`);
  const session = (state.authSessions || []).find((item) => item.tokenDigest === tokenDigest && item.status === "active" && new Date(item.expiresAt).getTime() > Date.now());
  if (!session) return null;
  return session;
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

function mcpContextFromRequest(req, state) {
  const token = bearerToken(req);
  if (!token) return null;
  const node = authenticateAgentNode(state, token);
  if (node) {
    return {
      principal: {kind: "agent_node", id: node.nodeId, projectIds: node.projectIds, allowedMcpTools: node.allowedMcpTools},
      allowedMcpTools: node.allowedMcpTools
    };
  }
  const accountContext = accountFromRequest(req, state);
  if (accountContext?.account.accountType === "system_admin") {
    return {principal: {kind: "system_admin", id: accountContext.account.accountId, allowedMcpTools: ["*"]}, allowedMcpTools: ["*"]};
  }
  const config = readRuntimeConfig();
  if (config.mcpServiceTokenHash === digestOf(`mcp-service:${token}`)) {
    const allowedMcpTools = mcpServiceAllowedTools();
    return {principal: {kind: "system_service", id: "remote-mcp-client", allowedMcpTools}, allowedMcpTools};
  }
  return null;
}

function mcpServiceAllowedTools() {
  const configured = String(process.env.AIMAC_MCP_SERVICE_ALLOWED_TOOLS || "").split(",").map((item) => item.trim()).filter(Boolean);
  const tools = configured.length ? configured : defaultMcpServiceToolAllowlist;
  return tools.filter((tool) => !forbiddenMcpServiceTool(tool));
}

function forbiddenMcpServiceTool(tool) {
  return tool === "*" ||
    tool === "evidence-mcp.checkpoint_submit" ||
    tool.startsWith("identity-mcp.") ||
    tool.startsWith("governance-mcp.") ||
    (tool.startsWith("orchestration-mcp.") && tool !== "orchestration-mcp.state_get");
}

function accountFromRequest(req, state) {
  const session = authenticateRequest(req, state);
  if (!session) return null;
  const account = state.accounts.find((item) => accountIdOf(item) === session.accountId && item.status === "active");
  return account ? {session, account} : null;
}

function requireRead(req, state, resourceScope = {resourceType: "system", resourceId: "state"}) {
  const authenticated = accountFromRequest(req, state);
  if (!authenticated) return {status: 401, payload: {error: "auth_required"}};
  if (canReadResource(state, authenticated.account, resourceScope)) return authenticated;
  return {status: 403, payload: {error: "permission_denied"}};
}

function canReadResource(state, account, resourceScope = {}) {
  if (!account) return false;
  if (account.accountType === "system_admin" || (account.permissions || []).includes("system:*")) return true;
  if (resourceScope.resourceType === "system") return false;
  if (resourceScope.resourceType === "project") return canReadProject(state, account, resourceScope.resourceId);
  if (resourceScope.resourceType === "task_group") return canReadTaskGroup(state, account, resourceScope.resourceId);
  return true;
}

function canReadProject(state, account, projectId) {
  if (!projectId) return false;
  const project = state.projects.find((item) => item.id === projectId);
  if (project?.ownerAccountId === account.accountId || (project?.members || []).some((member) => member.accountId === account.accountId)) return true;
  return ["project:view", "project:*"].some((permission) => hasPermission(state, account.accountId, permission, {resourceType: "project", resourceId: projectId}));
}

function canReadTaskGroup(state, account, taskGroupId) {
  const taskGroup = state.taskGroups.find((item) => item.id === taskGroupId);
  if (!taskGroup) return false;
  if (canReadProject(state, account, taskGroup.projectId)) return true;
  return ["task_group:read", "task_group:review", "task_group:control", "task_group:orchestrate", "task_group:monitor", "task_group:*"].some((permission) =>
    hasPermission(state, account.accountId, permission, {resourceType: "task_group", resourceId: taskGroupId, projectId: taskGroup.projectId})
  );
}

function scopedStateForAccount(state, account, session) {
  const cloned = JSON.parse(JSON.stringify(state));
  const isSystem = account.accountType === "system_admin" || (account.permissions || []).includes("system:*");
  cloned.authSessions = (state.authSessions || [])
    .filter((item) => isSystem || item.sessionId === session.sessionId)
    .map((item) => ({sessionId: item.sessionId, accountId: item.accountId, status: item.status, expiresAt: item.expiresAt, createdAt: item.createdAt, updatedAt: item.updatedAt}));
  cloned.agentRuntimeNodes = (state.agentRuntimeNodes || []).map(publicAgentNode);
  cloned.agentJoinTokens = listAgentJoinTokens(state);
  if (isSystem) return cloned;
  const visibleProjectIds = new Set((state.projects || []).filter((project) => canReadProject(state, account, project.id)).map((project) => project.id));
  const visibleTaskGroupIds = new Set((state.taskGroups || []).filter((taskGroup) => visibleProjectIds.has(taskGroup.projectId) || canReadTaskGroup(state, account, taskGroup.id)).map((taskGroup) => taskGroup.id));
  cloned.projects = (state.projects || []).filter((project) => visibleProjectIds.has(project.id));
  cloned.taskGroups = (state.taskGroups || []).filter((taskGroup) => visibleTaskGroupIds.has(taskGroup.id));
  cloned.repositoryOutputs = (state.repositoryOutputs || []).filter((target) => visibleProjectIds.has(target.projectId) || visibleTaskGroupIds.has(target.taskGroupId));
  cloned.workSessions = (state.workSessions || []).filter((sessionItem) => visibleTaskGroupIds.has(sessionItem.taskGroupId));
  cloned.agentDispatches = (state.agentDispatches || []).filter((dispatch) => visibleTaskGroupIds.has(dispatch.taskGroupId));
  cloned.agentRuntimeNodes = (state.agentRuntimeNodes || []).filter((node) => (node.projectIds || []).some((projectId) => visibleProjectIds.has(projectId))).map(publicAgentNode);
  const visibleNodeIds = new Set(cloned.agentRuntimeNodes.map((node) => node.nodeId));
  cloned.agentControlCommands = (state.agentControlCommands || []).filter((command) => visibleNodeIds.has(command.nodeId));
  cloned.agentExecutionEvents = (state.agentExecutionEvents || []).filter((event) => visibleTaskGroupIds.has(event.taskGroupId) || visibleNodeIds.has(event.nodeId));
  cloned.agentJoinTokens = listAgentJoinTokens(state).filter((token) => visibleProjectIds.has(token.projectId));
  cloned.agentTaskContracts = (state.agentTaskContracts || []).filter((contract) => visibleTaskGroupIds.has(contract.taskGroupId));
  cloned.effectiveInstructionPackets = (state.effectiveInstructionPackets || []).filter((packet) => visibleTaskGroupIds.has(packet.taskGroupId));
  cloned.roleDriftGuards = (state.roleDriftGuards || []).filter((guard) => visibleTaskGroupIds.has(guard.taskGroupId));
  cloned.modelSelectionDecisions = (state.modelSelectionDecisions || []).filter((decision) => visibleTaskGroupIds.has(decision.taskGroupId));
  cloned.sessionPlacementDecisions = (state.sessionPlacementDecisions || []).filter((decision) => visibleTaskGroupIds.has(decision.taskGroupId));
  cloned.executionTopologies = (state.executionTopologies || []).filter((item) => visibleTaskGroupIds.has(item.taskGroupId));
  cloned.reviewPlans = (state.reviewPlans || []).filter((item) => visibleTaskGroupIds.has(item.taskGroupId));
  cloned.reviewBundles = (state.reviewBundles || []).filter((item) => visibleTaskGroupIds.has(item.taskGroupId));
  cloned.checkpoints = (state.checkpoints || []).filter((checkpoint) => visibleTaskGroupIds.has(checkpoint.taskGroupId));
  cloned.completionReadiness = (state.completionReadiness || []).filter((item) => visibleTaskGroupIds.has(item.taskGroupId));
  cloned.closeBarriers = (state.closeBarriers || []).filter((item) => visibleTaskGroupIds.has(item.taskGroupId));
  cloned.sharedDefinitions = (state.sharedDefinitions || []).filter((definition) => visibleProjectIds.has(definition.projectId) || (definition.scopeRefs || []).some((ref) => visibleTaskGroupIds.has(String(ref).replace("TaskGroup:", ""))));
  cloned.progressSnapshots = (state.progressSnapshots || []).filter((snapshot) => snapshot.scopeType === "project" ? visibleProjectIds.has(snapshot.scopeRef) : visibleTaskGroupIds.has(snapshot.scopeRef));
  cloned.leases = (state.leases || []).filter((lease) => cloned.repositoryOutputs.some((target) => lease.resourceRef === `RepositoryOutputTarget:${target.targetId}`));
  const visibleAccountIds = new Set([account.accountId]);
  for (const project of cloned.projects) {
    for (const member of project.members || []) visibleAccountIds.add(member.accountId);
  }
  cloned.accounts = (state.accounts || []).filter((item) => visibleAccountIds.has(item.accountId)).map((item) => ({
    schemaVersion: item.schemaVersion,
    accountId: item.accountId,
    accountType: item.accountType,
    displayName: item.displayName,
    email: item.email,
    status: item.status,
    roles: item.roles,
    permissions: item.accountId === account.accountId ? item.permissions : [],
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  }));
  cloned.accessGrants = (state.accessGrants || []).filter((grant) => {
    const resource = grant.resource || {};
    return grant.subjectRef?.subjectId === account.accountId ||
      (resource.resourceType === "project" && visibleProjectIds.has(resource.resourceId)) ||
      (resource.resourceType === "task_group" && visibleTaskGroupIds.has(resource.resourceId));
  });
  cloned.auditLog = [];
  cloned.policyDecisions = [];
  cloned.commands = [];
  cloned.decisionRecords = [];
  cloned.commandEffects = [];
  cloned.idempotencyRecords = {};
  cloned.runtimeIssuePatterns = [];
  cloned.runtimeIssueSamples = [];
  cloned.systemUpgradeCandidates = [];
  cloned.eventLog = (state.eventLog || []).filter((event) => event.taskGroupId && visibleTaskGroupIds.has(event.taskGroupId));
  return cloned;
}

function stateViewForAccount(state, account, session, view = "full", limit = 80) {
  const scoped = scopedStateForAccount(state, account, session);
  if (!view || view === "full") return scoped;
  const capped = Math.max(10, Math.min(500, Number(limit || 80)));
  const base = {
    schemaVersion: scoped.schemaVersion,
    stateVersion: scoped.stateVersion,
    runtime: scoped.runtime,
    agents: sliceItems(scoped.agents, capped),
    projects: sliceItems(scoped.projects, capped),
    taskGroups: sliceItems(scoped.taskGroups, capped),
    modelCapabilities: sliceItems(scoped.modelCapabilities, capped),
    agentRuntimeNodes: sliceItems(scoped.agentRuntimeNodes, capped),
    progressSnapshots: sliceItems(scoped.progressSnapshots, capped)
  };
  const viewFields = {
    system: ["accounts", "auditLog", "policyDecisions", "commands", "decisionRecords"],
    users: ["accounts", "accessGrants", "projects"],
    projects: ["accounts", "accessGrants", "projects", "repositoryOutputs", "agentJoinTokens"],
    tasks: ["taskGroups", "workSessions", "agentDispatches", "agentControlCommands", "agentExecutionEvents", "repositoryOutputs", "checkpoints", "completionReadiness", "closeBarriers", "progressSnapshots"],
    runtime: ["modelSelectionPolicies", "modelSelectionDecisions", "sessionPlacementDecisions", "workSessions", "agentDispatches", "agentControlCommands", "agentExecutionEvents", "agentJoinTokens", "skillSources", "roleSkills", "roleSkillOverlays"],
    instructions: ["instructionMetrics", "sharedDefinitions", "effectiveInstructionPackets", "roleDriftGuards"]
  };
  for (const field of viewFields[view] || []) {
    const value = scoped[field];
    base[field] = Array.isArray(value) ? sliceItems(value, capped) : value;
  }
  return base;
}

function cachedStateView(state, account, session, view, limit) {
  const key = `${account.accountId}:${session.sessionId}:${state.stateVersion}:${view || "full"}:${limit || "default"}`;
  const cached = stateViewCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;
  const payload = JSON.stringify(stateViewForAccount(state, account, session, view, limit));
  stateViewCache.set(key, {payload, expiresAt: Date.now() + stateViewCacheTtlMs});
  if (stateViewCache.size > stateViewMaxEntries) {
    for (const cacheKey of stateViewCache.keys()) {
      stateViewCache.delete(cacheKey);
      if (stateViewCache.size <= stateViewMaxEntries) break;
    }
  }
  return payload;
}

function sliceItems(items, limit) {
  return Array.isArray(items) ? items.slice(0, limit) : [];
}

function permissionForAction(action) {
  if (action === "bootstrap_init") return "system:bootstrap";
  if (action === "account_invite") return "member:invite";
  if (action === "project_create") return "project:create";
  if (action === "project_member_grant") return "member:invite";
  if (action === "access_grant_create" || action === "access_grant_revoke") return "project:grant";
  if (action === "agent_create" || action === "agent_activation_update") return "agent:activate";
  if (action === "agent_join_token_create" || action === "agent_join_token_revoke" || action === "agent_node_revoke" || action === "agent_control_command_create") return "agent:activate";
  if (action.startsWith("task_group_")) return "task_group:control";
  if (action === "repository_output_target_select") return "project:*";
  if (action === "instruction_envelope_create") return "task_group:control";
  if (action === "shared_definition_contract_create") return "project:*";
  if (action === "skill_source_sync") return "system:skill_sync";
  if (action === "role_skill_overlay_create") return "project:*";
  if (action === "model_capability_register") return "system:model_registry";
  if (action === "model_selection_decide" || action === "session_placement_decide") return "task_group:orchestrate";
  if (action === "orchestrator_run" || action === "agent_runtime_worker_run") return "task_group:orchestrate";
  if (action === "checkpoint_submit") return "task_group:checkpoint_submit";
  if (action === "runtime_issue_collect") return "task_group:monitor";
  return "system:*";
}

function hasPermission(state, actor, requiredPermission, resourceScope) {
  if (!requiredPermission) return true;
  const account = state.accounts.find((item) => accountIdOf(item) === actor);
  if (!account || account.status !== "active") return false;
  const direct = (account.permissions || []).filter((permission) => directPermissionApplies(account, permission, requiredPermission, resourceScope));
  const grantPermissions = state.accessGrants
    .filter((grant) => grant.status === "active" && grant.subjectRef?.subjectType === "account" && grant.subjectRef?.subjectId === actor)
    .filter((grant) => grantAppliesToResource(state, grant, resourceScope))
    .flatMap((grant) => grant.permissions || []);
  return [...direct, ...grantPermissions].some((permission) => permissionMatches(permission, requiredPermission));
}

function directPermissionApplies(account, permission, requiredPermission, resourceScope = {}) {
  if (account.accountType === "system_admin") return true;
  if (["member:invite", "agent:activate"].includes(permission) && ["project", "task_group"].includes(resourceScope.resourceType)) return false;
  if (resourceScope.resourceType === "task_group" && permission.startsWith("task_group:")) return false;
  if (resourceScope.resourceType === "project" && permission.startsWith("project:") && requiredPermission !== "project:create") return false;
  return true;
}

function permissionMatches(granted, required) {
  if (granted === required || granted === "system:*") return true;
  if (granted.endsWith(":*") && !required.endsWith(":*")) return required.startsWith(granted.slice(0, -1));
  if (granted.endsWith(":*") && required.endsWith(":*")) return granted === required;
  return false;
}

function inferResourceScope(state, subject) {
  const [type, id] = String(subject || "").split(":");
  if (type === "Project") return {resourceType: "project", resourceId: id};
  if (type === "TaskGroup") {
    const taskGroup = state.taskGroups.find((item) => item.id === id);
    return {resourceType: "task_group", resourceId: id, projectId: taskGroup?.projectId};
  }
  if (type === "WorkItem" || type === "Checkpoint") {
    const parts = String(subject).split(":");
    const taskGroupId = parts[1] || id;
    const taskGroup = state.taskGroups.find((item) => item.id === taskGroupId);
    return {resourceType: "task_group", resourceId: taskGroupId, projectId: taskGroup?.projectId};
  }
  if (type === "AgentSkillSource" || type === "RuntimeBootstrapProfile" || type === "ModelCapabilityProfile") return {resourceType: "system", resourceId: type};
  return {resourceType: "system", resourceId: type || "system"};
}

function grantAppliesToResource(state, grant, resourceScope = {}) {
  const grantResource = grant.resource || {resourceType: grant.resourceType, resourceId: grant.resourceId};
  if (!grantResource?.resourceType) return false;
  if (grantResource.resourceType === "system") return resourceScope.resourceType === "system";
  if (grantResource.resourceType === "project") {
    if (resourceScope.resourceType === "project") return grantResource.resourceId === resourceScope.resourceId;
    if (resourceScope.resourceType === "task_group") {
      const taskGroup = state.taskGroups.find((item) => item.id === resourceScope.resourceId);
      return taskGroup?.projectId === grantResource.resourceId || resourceScope.projectId === grantResource.resourceId;
    }
    return false;
  }
  if (grantResource.resourceType === "task_group") return resourceScope.resourceType === "task_group" && grantResource.resourceId === resourceScope.resourceId;
  return false;
}

function taskGroupScope(state, taskGroupId) {
  const taskGroup = state.taskGroups.find((item) => item.id === taskGroupId);
  return {resourceType: "task_group", resourceId: taskGroupId, projectId: taskGroup?.projectId};
}

function projectScope(projectId) {
  return {resourceType: "project", resourceId: projectId};
}

function writeDriftCheck(state, action, resourceScope = {}) {
  if (resourceScope.resourceType !== "task_group") return {allowed: true};
  const activeGuards = (state.roleDriftGuards || []).filter((guard) => guard.taskGroupId === resourceScope.resourceId && !["closed", "corrected"].includes(guard.status));
  if (!activeGuards.length) {
    return driftGuardRequiredForAction(action)
      ? {allowed: false, signals: [`role_drift_guard_missing:${action}`]}
      : {allowed: true, signals: []};
  }
  return activeGuards.reduce((result, guard) => {
    if (!result.allowed) return result;
    const allowed = guard.allowedActionScopeRefs.includes(`TaskGroup:${resourceScope.resourceId}`);
    return {
      ...result,
      allowed,
      signals: allowed ? [] : [`write_scope_not_allowed:${action}`]
    };
  }, {allowed: true, signals: []});
}

function driftGuardRequiredForAction(action) {
  return [
    "agent_runtime_worker_run",
    "checkpoint_submit",
    "repository_output_target_select",
    "role_skill_overlay_create",
    "instruction_envelope_create"
  ].includes(action);
}

function json(res, status, payload) {
  res.writeHead(status, {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"});
  res.end(JSON.stringify(payload));
}

function jsonString(res, status, payload) {
  res.writeHead(status, {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"});
  res.end(payload);
}

function parseBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        tooLarge = true;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        const error = new Error("request_body_too_large");
        error.status = 413;
        reject(error);
        return;
      }
      if (!chunks.length) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function commitGatewayWrite(state) {
  state.stateVersion = Number(state.stateVersion || 0) + 1;
  writeState(state);
}

function commitDirectStateWrite(state) {
  state.stateVersion = Number(state.stateVersion || 0) + 1;
  writeState(state);
}

function serveAgentAsset(req, res, pathname) {
  let content;
  let filename;
  if (pathname.startsWith("/install-agent.sh")) {
    content = readFileSync(agentInstallerPath, "utf8").replaceAll("__AIMAC_SERVER_URL__", publicEndpoint(req));
    filename = "install-agent.sh";
  } else {
    content = readFileSync(agentRuntimePath);
    filename = "agent-runtime.mjs";
  }
  if (pathname.endsWith(".sha256")) {
    const hash = createHash("sha256").update(content).digest("hex");
    res.writeHead(200, {"content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff"});
    res.end(`${hash}  ${filename}\n`);
    return;
  }
  res.writeHead(200, {
    "content-type": filename.endsWith(".sh") ? "text/x-shellscript; charset=utf-8" : "application/javascript; charset=utf-8",
    "cache-control": "no-store",
    "content-disposition": `inline; filename=${filename}`,
    "x-content-type-options": "nosniff"
  });
  res.end(content);
}

async function handleMcp(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, {allow: "POST", "content-type": "application/json; charset=utf-8"});
    res.end(JSON.stringify({error: "mcp_streamable_http_requires_post"}));
    return;
  }
  const state = readState();
  const context = mcpContextFromRequest(req, state);
  if (!context) {
    res.writeHead(401, {"www-authenticate": "Bearer", "content-type": "application/json; charset=utf-8", "cache-control": "no-store"});
    res.end(JSON.stringify({error: "mcp_auth_required"}));
    return;
  }
  const message = await parseBody(req);
  const response = Array.isArray(message)
    ? await handleMcpBatch(message, context)
    : await handleMcpJsonRpc(message, context);
  if (response === null || (Array.isArray(response) && !response.length)) {
    res.writeHead(202, {"cache-control": "no-store"});
    res.end();
    return;
  }
  res.writeHead(200, {"content-type": "application/json; charset=utf-8", "cache-control": "no-store", "mcp-protocol-version": "2025-06-18"});
  res.end(JSON.stringify(response));
}

async function handleMcpBatch(messages, context) {
  const writeCount = messages.filter(mcpJsonRpcIsWriteCall).length;
  if (writeCount === 0) return (await Promise.all(messages.map((item) => handleMcpJsonRpc(item, context)))).filter(Boolean);
  const responses = [];
  for (const item of messages) {
    if (writeCount > 1 && mcpJsonRpcIsWriteCall(item)) {
      responses.push({
        jsonrpc: "2.0",
        id: item?.id ?? null,
        error: {code: -32600, message: "mcp_batch_multiple_write_calls_forbidden"}
      });
      continue;
    }
    const response = await handleMcpJsonRpc(item, context);
    if (response) responses.push(response);
  }
  return responses;
}

function mcpJsonRpcIsWriteCall(message) {
  return message?.method === "tools/call" && isWriteTool(message.params?.name);
}

async function waitForAgentControlCommands(node, options = {}) {
  const deadline = Date.now() + Math.max(0, Math.min(30000, Number(options.waitMs || 0)));
  let latest = readState();
  for (;;) {
    const currentNode = authenticateAgentNode(latest, options.token);
    if (!currentNode || currentNode.nodeId !== node.nodeId) return {commands: [], nextCursor: Number(options.afterSequence || 0), reason: "node_not_active"};
    const result = listAgentControlCommands(latest, currentNode, options);
    if (result.deliveredCount) {
      try {
        commitGatewayWrite(latest);
      } catch (error) {
        if (!isStateStoreConflict(error)) throw error;
      }
    }
    if (result.commands.length || Date.now() >= deadline) return result;
    await delay(250);
    latest = readState();
  }
}

async function waitForProjectExecutionEvents(projectId, options = {}) {
  const deadline = Date.now() + Math.max(0, Math.min(30000, Number(options.waitMs || 0)));
  for (;;) {
    const result = readProjectExecutionEvents(runtimeDir, projectId, options);
    if (result.events.length || Date.now() >= deadline) return result;
    await delay(250);
  }
}

function retryExecutionEventProjection(req, body) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = readState();
    const latestNode = authenticateAgentNode(latest, bearerToken(req));
    if (!latestNode) return {ok: false, error: "agent_node_auth_required"};
    try {
      const result = submitAgentExecutionEvent(latest, latestNode, body);
      const storage = appendProjectExecutionEvent(runtimeDir, result.event);
      commitGatewayWrite(latest);
      return {ok: true, result, storage};
    } catch (error) {
      if (!isStateStoreConflict(error)) return {ok: false, error: error.message};
    }
  }
  return {ok: false, error: "state_conflict_not_recovered"};
}

function applyTaskGroupRuntimeControl(state, taskGroup, action, options = {}) {
  const at = now();
  const controlCommands = [];
  const directDispatches = [];
  const resumedDispatches = [];
  const stopCommandType = ["cancel", "abort"].includes(action)
    ? "cancel_dispatch"
    : ["pause", "rebound_drift"].includes(action)
      ? "pause_dispatch"
      : null;
  if (stopCommandType) {
    for (const dispatch of state.agentDispatches || []) {
      if (dispatch.taskGroupId !== taskGroup.id || ["completed", "failed", "cancelled"].includes(dispatch.status)) continue;
      const node = dispatch.assignedNodeId ? (state.agentRuntimeNodes || []).find((item) => item.nodeId === dispatch.assignedNodeId) : null;
      if (node && ["running", "blocked"].includes(dispatch.status)) {
        const result = createAgentControlCommand(state, node, {
          commandType: stopCommandType,
          dispatchId: dispatch.dispatchId,
          taskGroupId: taskGroup.id,
          payload: {reason: `task_group_${action}`}
        }, {
          actor: options.actor || "ui-console-service",
          idempotencyKey: `${options.idempotencyKey || "task-group-control"}:${dispatch.dispatchId}`
        });
        controlCommands.push(result.command);
        continue;
      }
      applyDirectDispatchControl(state, dispatch, stopCommandType, `task_group_${action}`, at);
      directDispatches.push(dispatch.dispatchId);
    }
  }
  if (action === "resume") {
    for (const dispatch of state.agentDispatches || []) {
      if (dispatch.taskGroupId !== taskGroup.id || dispatch.status !== "blocked") continue;
      if (!["control_pause_requested", "task_group_pause", "task_group_rebound_drift"].includes(dispatch.blockedReason)) continue;
      dispatch.status = "queued";
      delete dispatch.blockedReason;
      delete dispatch.controlCommandRef;
      delete dispatch.assignedNodeId;
      delete dispatch.claimedAt;
      delete dispatch.claimExpiresAt;
      dispatch.updatedAt = at;
      const session = state.workSessions.find((item) => item.sessionId === dispatch.sessionId);
      if (session && ["blocked", "monitor_attention"].includes(session.status)) {
        session.status = "active";
        session.updatedAt = at;
      }
      resumedDispatches.push(dispatch.dispatchId);
    }
  }
  return {
    controlCommands,
    directDispatches,
    resumedDispatches
  };
}

function applyDirectDispatchControl(state, dispatch, commandType, reason, at) {
  if (commandType === "cancel_dispatch") {
    dispatch.status = "cancelled";
    dispatch.failureReason = reason;
  } else {
    dispatch.status = "blocked";
    dispatch.blockedReason = reason;
  }
  dispatch.controlRequestedAt = at;
  dispatch.updatedAt = at;
  if (dispatch.assignedNodeId) revokeDispatchMcpGrants(state, dispatch.assignedNodeId, dispatch.dispatchId, reason);
  const session = state.workSessions.find((item) => item.sessionId === dispatch.sessionId);
  if (session) {
    session.status = commandType === "cancel_dispatch" ? "aborted" : "blocked";
    session.updatedAt = at;
  }
  const taskGroup = state.taskGroups.find((item) => item.id === dispatch.taskGroupId);
  const workItem = taskGroup?.workItems?.find((item) => item.id === dispatch.workItemId);
  if (workItem) {
    workItem.status = "blocked";
    workItem.blockedReason = reason;
    workItem.updatedAt = at;
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function prepareRemoteGitVerification(target, checkpointInput) {
  const safeTargetId = String(target.targetId).replace(/[^A-Za-z0-9._-]+/gu, "_");
  const verificationRoot = join(runtimeDir, "git-verification", `${safeTargetId}.git`);
  mkdirSync(dirname(verificationRoot), {recursive: true});
  if (!existsSync(join(verificationRoot, "HEAD"))) execFileSync("git", ["init", "--bare", verificationRoot], {stdio: "pipe"});
  const remotes = execFileSync("git", ["-C", verificationRoot, "remote"], {encoding: "utf8"}).trim().split("\n").filter(Boolean);
  if (remotes.includes(target.remote || "origin")) execFileSync("git", ["-C", verificationRoot, "remote", "set-url", target.remote || "origin", target.repositoryUrl], {stdio: "pipe"});
  else execFileSync("git", ["-C", verificationRoot, "remote", "add", target.remote || "origin", target.repositoryUrl], {stdio: "pipe"});
  const remote = target.remote || "origin";
  execFileSync("git", ["-C", verificationRoot, "fetch", "--force", "--no-tags", remote, `refs/heads/${target.branch}:refs/remotes/${remote}/${target.branch}`], {stdio: "pipe"});
  for (const commitRef of checkpointInput.commitRefs || []) {
    try {
      execFileSync("git", ["-C", verificationRoot, "cat-file", "-e", `${commitRef.commit}^{commit}`], {stdio: "pipe"});
    } catch {
      execFileSync("git", ["-C", verificationRoot, "fetch", "--force", "--no-tags", remote, commitRef.commit], {stdio: "pipe"});
    }
  }
  return verificationRoot;
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const target = normalize(join(publicDir, requested));
  if (!target.startsWith(publicDir) || !existsSync(target)) {
    res.writeHead(404, {"content-type": "text/plain; charset=utf-8"});
    res.end("Not found");
    return;
  }
  res.writeHead(200, {"content-type": mimeTypes[extname(target)] || "application/octet-stream"});
  res.end(readFileSync(target));
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const state = readState();
  const body = req.method === "POST" ? await parseBody(req) : {};
  req.bodyDigest = digestOf(body);

  if (req.method === "GET" && ["/api/health", "/api/runtime/health"].includes(url.pathname)) {
    json(res, 200, {
      status: "ok",
      runtime: state.runtime.status,
      publicUrl: publicEndpoint(req),
      mcp: {transport: "streamable-http", endpoint: `${publicEndpoint(req)}/mcp`, hostedBy: "control-plane"},
      agentGateway: {endpoint: `${publicEndpoint(req)}/api/agent/v1`, onlineNodes: state.agentRuntimeNodes.filter((node) => node.status === "online").length},
      at: now()
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent/v1/bootstrap-manifest") {
    json(res, 200, {
      schemaVersion: "agent-bootstrap-manifest/v1",
      serverUrl: publicEndpoint(req),
      installScriptUrl: `${publicEndpoint(req)}/install-agent.sh`,
      installScriptChecksumUrl: `${publicEndpoint(req)}/install-agent.sh.sha256`,
      runtimeUrl: `${publicEndpoint(req)}/agent-runtime.mjs`,
      runtimeChecksumUrl: `${publicEndpoint(req)}/agent-runtime.mjs.sha256`,
      mcpUrl: `${publicEndpoint(req)}/mcp`,
      localMcpServerAllowed: false,
      skillSynchronization: "server_managed_on_demand"
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/v1/register") {
    const result = registerAgentNode(state, body, {joinToken: bearerToken(req), publicUrl: publicEndpoint(req)});
    audit(state, "agent-gateway", "agent_node_register", `AgentRuntimeNode:${result.node.nodeId}`);
    commitGatewayWrite(state);
    json(res, 201, result);
    return;
  }

  const node = url.pathname.startsWith("/api/agent/v1/") ? authenticateAgentNode(state, bearerToken(req)) : null;

  if (req.method === "GET" && url.pathname === "/api/agent/v1/nodes/me") {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    json(res, 200, {node: publicAgentNode(node)});
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/v1/heartbeat") {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    const result = heartbeatAgentNode(state, node, body, {presentedToken: bearerToken(req)});
    commitGatewayWrite(state);
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/v1/self-check") {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    const result = selfCheckAgentNode(state, node, body);
    commitGatewayWrite(state);
    json(res, result.ok ? 200 : 409, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent/v1/control") {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    const result = await waitForAgentControlCommands(node, {
      token: bearerToken(req),
      afterSequence: Number(url.searchParams.get("afterSequence") || 0),
      waitMs: Number(url.searchParams.get("waitMs") || 25000),
      limit: Number(url.searchParams.get("limit") || 20)
    });
    json(res, 200, result);
    return;
  }

  const nodeControlAckMatch = url.pathname.match(/^\/api\/agent\/v1\/control\/([^/]+)\/ack$/);
  if (req.method === "POST" && nodeControlAckMatch) {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    const result = ackAgentControlCommand(state, node, nodeControlAckMatch[1], body);
    commitGatewayWrite(state);
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/v1/events") {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    const result = submitAgentExecutionEvent(state, node, body);
    const storage = appendProjectExecutionEvent(runtimeDir, result.event);
    try {
      commitGatewayWrite(state);
      json(res, 202, {...result, storage, centralStateUpdated: true});
    } catch (error) {
      if (!isStateStoreConflict(error)) throw error;
      const recovered = retryExecutionEventProjection(req, body);
      json(res, 202, {...(recovered.result || result), storage: recovered.storage || storage, centralStateUpdated: recovered.ok, stateConflict: true, conflictRecovered: recovered.ok});
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/v1/dispatches/next") {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    const result = claimNextDispatch(state, node, {runtimeDir, claimTtlSeconds: body.claimTtlSeconds});
    if (result.dispatch) commitGatewayWrite(state);
    json(res, 200, result);
    return;
  }

  const nodeDispatchMatch = url.pathname.match(/^\/api\/agent\/v1\/dispatches\/([^/]+)$/);
  if (req.method === "GET" && nodeDispatchMatch) {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    json(res, 200, {dispatch: getDispatchForNode(state, node, nodeDispatchMatch[1], {runtimeDir})});
    return;
  }

  const skillWorksetMatch = url.pathname.match(/^\/api\/agent\/v1\/skill-worksets\/([^/]+)$/);
  if (req.method === "GET" && skillWorksetMatch) {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    json(res, 200, getSkillWorkset(state, node, decodeURIComponent(skillWorksetMatch[1]), {runtimeDir}));
    return;
  }

  const nodeCheckpointMatch = url.pathname.match(/^\/api\/agent\/v1\/dispatches\/([^/]+)\/checkpoint$/);
  if (req.method === "POST" && nodeCheckpointMatch) {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    const dispatch = state.agentDispatches.find((item) => item.dispatchId === nodeCheckpointMatch[1] && item.assignedNodeId === node.nodeId);
    if (!dispatch) return json(res, 404, {error: "dispatch_not_found"});
    if (dispatch.status === "completed") {
      const existingCheckpoint = state.checkpoints.find((item) => item.runId === dispatch.runId && item.sessionId === dispatch.sessionId && item.workId === dispatch.workItemId);
      const submittedCommit = body.commitRefs?.at(-1)?.commit;
      const existingCommit = existingCheckpoint?.commitRefs?.at(-1)?.commit;
      if (!existingCheckpoint || body.runId !== dispatch.runId || body.sessionId !== dispatch.sessionId || submittedCommit !== existingCommit) {
        return json(res, 409, {error: "checkpoint_replay_binding_mismatch"});
      }
      json(res, 200, {accepted: true, replayed: true, checkpoint: existingCheckpoint});
      return;
    }
    const target = state.repositoryOutputs.find((item) => item.targetId === dispatch.repositoryOutputTargetRef);
    if (!target) return json(res, 409, {error: "repository_output_target_missing"});
    const verificationRoot = prepareRemoteGitVerification(target, body);
    const result = acceptAgentCheckpoint(state, body, {root: verificationRoot, repositoryRoot: verificationRoot});
    if (!result.accepted) {
      commitGatewayWrite(state);
      json(res, result.status || 409, result);
      return;
    }
    finishNodeDispatch(state, node, dispatch.dispatchId, true);
    audit(state, `agent-node:${node.nodeId}`, "checkpoint_submit", `AgentDispatch:${dispatch.dispatchId}`);
    commitGatewayWrite(state);
    json(res, 201, result);
    return;
  }

  const nodeFailureMatch = url.pathname.match(/^\/api\/agent\/v1\/dispatches\/([^/]+)\/fail$/);
  if (req.method === "POST" && nodeFailureMatch) {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    const dispatch = state.agentDispatches.find((item) => item.dispatchId === nodeFailureMatch[1] && item.assignedNodeId === node.nodeId);
    if (!dispatch) return json(res, 404, {error: "dispatch_not_found"});
    const reportedStatus = ["blocked", "cancelled"].includes(body.status) ? body.status : "failed";
    dispatch.status = reportedStatus;
    dispatch.failureReason = String(body.reason || "agent_runtime_failure").slice(0, 2000);
    dispatch.updatedAt = now();
    const session = state.workSessions.find((item) => item.sessionId === dispatch.sessionId);
    if (session) {
      session.status = reportedStatus === "blocked" ? "blocked" : reportedStatus === "cancelled" ? "aborted" : "failed";
      session.updatedAt = now();
    }
    finishNodeDispatch(state, node, dispatch.dispatchId, false);
    audit(state, `agent-node:${node.nodeId}`, `dispatch_${reportedStatus}`, `AgentDispatch:${dispatch.dispatchId}`, reportedStatus);
    commitGatewayWrite(state);
    json(res, 200, {ok: true, dispatchId: dispatch.dispatchId, status: dispatch.status});
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/bootstrap-hint") {
    const config = readRuntimeConfig();
    if (!canExposeBootstrapHint(req)) {
      json(res, 200, {
        bootstrapTokenConfigured: Boolean(config.bootstrapTokenHash),
        tokenHintsExposed: false
      });
      return;
    }
    json(res, 200, {
      bootstrapTokenConfigured: Boolean(config.bootstrapTokenHash),
      tokenHintsExposed: true,
      tokenSource: process.env.AIMAC_BOOTSTRAP_TOKEN ? "environment" : "runtime-local-config",
      tokenHint: config.localBootstrapToken ? `${config.localBootstrapToken.slice(0, 4)}...${config.localBootstrapToken.slice(-4)}` : null,
      localAccountTokenHints: Object.fromEntries(Object.entries(config.localAccountTokens || {}).map(([accountId, token]) => [accountId, `${token.slice(0, 4)}...${token.slice(-4)}`]))
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const config = readRuntimeConfig();
    const token = String(body.token || body.accountToken || body.bootstrapToken || "");
    const email = String(body.email || "");
    const account = state.accounts.find((item) => item.email === email || item.accountId === email);
    const method = account?.authPolicy?.method;
    const tokenOk = method === "bootstrap_token"
      ? digestOf(`bootstrap:${token}`) === config.bootstrapTokenHash
      : Boolean(account && config.localAccountTokenHashes?.[account.accountId] === digestOf(`account:${account.accountId}:${token}`));
    if (!tokenOk || !account || account.status !== "active") {
      audit(state, "auth-service", "auth_login", `Account:${email}`, "denied");
      commitDirectStateWrite(state);
      json(res, 401, {error: "invalid_credentials"});
      return;
    }
    const sessionToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    state.authSessions.unshift({
      sessionId: createId("authsess"),
      tokenDigest: digestOf(`session:${sessionToken}`),
      accountId: account.accountId,
      status: "active",
      expiresAt,
      createdAt: now(),
      updatedAt: now()
    });
    state.authSessions = state.authSessions.slice(0, 80);
    audit(state, "auth-service", "auth_login", `Account:${account.accountId}`);
    commitDirectStateWrite(state);
    json(res, 200, {sessionToken, expiresAt, account: {accountId: account.accountId, email: account.email, displayName: account.displayName, roles: account.roles, permissions: account.permissions}});
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    const reader = accountFromRequest(req, state);
    if (!reader) {
      json(res, 401, {error: "auth_required"});
      return;
    }
    const view = url.searchParams.get("view") || "full";
    const limit = Number(url.searchParams.get("limit") || 80);
    jsonString(res, 200, cachedStateView(state, reader.account, reader.session, view, limit));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/model-registry") {
    const reader = accountFromRequest(req, state);
    if (!reader) {
      json(res, 401, {error: "auth_required"});
      return;
    }
    json(res, 200, {
      modelCapabilities: state.modelCapabilities,
      modelSelectionPolicies: state.modelSelectionPolicies,
      modelSelectionDecisions: state.modelSelectionDecisions.slice(0, 40)
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/skill-registry") {
    const reader = accountFromRequest(req, state);
    if (!reader) {
      json(res, 401, {error: "auth_required"});
      return;
    }
    json(res, 200, {
      skillSources: state.skillSources,
      roleSkills: state.roleSkills,
      roleSkillOverlays: state.roleSkillOverlays
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/progress-snapshots") {
    const reader = accountFromRequest(req, state);
    if (!reader) {
      json(res, 401, {error: "auth_required"});
      return;
    }
    json(res, 200, {progressSnapshots: scopedStateForAccount(state, reader.account, reader.session).progressSnapshots});
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent-nodes") {
    const reader = accountFromRequest(req, state);
    if (!reader) return json(res, 401, {error: "auth_required"});
    const visible = reader.account.accountType === "system_admin"
      ? state.agentRuntimeNodes
      : state.agentRuntimeNodes.filter((nodeItem) => (nodeItem.projectIds || []).some((projectId) => canReadProject(state, reader.account, projectId)));
    json(res, 200, {agentRuntimeNodes: visible.map(publicAgentNode)});
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent-join-tokens") {
    const reader = accountFromRequest(req, state);
    if (!reader) return json(res, 401, {error: "auth_required"});
    const projectId = url.searchParams.get("projectId") || undefined;
    const tokens = listAgentJoinTokens(state, projectId).filter((token) => reader.account.accountType === "system_admin" || canReadProject(state, reader.account, token.projectId));
    json(res, 200, {agentJoinTokens: tokens});
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent-join-tokens") {
    const guard = beginGuardedWrite(req, state, "agent_join_token_create", `Project:${body.projectId || "unknown"}`, projectScope(body.projectId));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = createAgentJoinToken(state, body, {actor: guard.actor, publicUrl: publicEndpoint(req)});
    const persistedResult = {joinTokenRecord: result.joinTokenRecord, secretReturnedOnce: true};
    audit(state, guard.actor, "agent_join_token_create", `AgentJoinToken:${result.joinTokenRecord.joinTokenId}`);
    finishGuardedWrite(state, guard, 201, persistedResult);
    writeState(state);
    json(res, 201, result);
    return;
  }

  const revokeJoinTokenMatch = url.pathname.match(/^\/api\/agent-join-tokens\/([^/]+)\/revoke$/);
  if (req.method === "POST" && revokeJoinTokenMatch) {
    const record = state.agentJoinTokens.find((item) => item.joinTokenId === revokeJoinTokenMatch[1]);
    if (!record) return json(res, 404, {error: "agent_join_token_not_found"});
    const guard = beginGuardedWrite(req, state, "agent_join_token_revoke", `Project:${record.projectId}`, projectScope(record.projectId));
    if (guard.status) return json(res, guard.status, guard.payload);
    record.status = "revoked";
    record.updatedAt = now();
    const payload = {joinTokenId: record.joinTokenId, status: record.status};
    finishGuardedWrite(state, guard, 200, payload);
    writeState(state);
    json(res, 200, payload);
    return;
  }

  const revokeNodeMatch = url.pathname.match(/^\/api\/agent-nodes\/([^/]+)\/revoke$/);
  if (req.method === "POST" && revokeNodeMatch) {
    const targetNode = state.agentRuntimeNodes.find((item) => item.nodeId === revokeNodeMatch[1]);
    if (!targetNode) return json(res, 404, {error: "agent_node_not_found"});
    const projectId = targetNode.projectIds?.[0];
    const guard = beginGuardedWrite(req, state, "agent_node_revoke", `Project:${projectId}`, projectScope(projectId));
    if (guard.status) return json(res, guard.status, guard.payload);
    const payload = requestAgentNodeRevocation(state, targetNode, body, {actor: guard.actor, idempotencyKey: guard.idempotencyKey});
    finishGuardedWrite(state, guard, 200, payload);
    writeState(state);
    json(res, 200, payload);
    return;
  }

  const controlNodeMatch = url.pathname.match(/^\/api\/agent-nodes\/([^/]+)\/control$/);
  if (req.method === "POST" && controlNodeMatch) {
    const targetNode = state.agentRuntimeNodes.find((item) => item.nodeId === controlNodeMatch[1]);
    if (!targetNode) return json(res, 404, {error: "agent_node_not_found"});
    const commandType = String(body.commandType || body.action || "refresh_profile");
    const targetDispatch = body.dispatchId ? state.agentDispatches.find((dispatch) => dispatch.dispatchId === body.dispatchId) : null;
    const taskScopedControl = ["pause_dispatch", "cancel_dispatch", "resume_dispatch"].includes(commandType) && targetDispatch;
    const projectId = targetNode.projectIds?.[0];
    const guard = taskScopedControl
      ? beginGuardedWrite(req, state, "task_group_agent_control_command_create", `TaskGroup:${targetDispatch.taskGroupId}`, taskGroupScope(state, targetDispatch.taskGroupId))
      : beginGuardedWrite(req, state, "agent_control_command_create", `AgentRuntimeNode:${targetNode.nodeId}`, projectScope(projectId));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = createAgentControlCommand(state, targetNode, body, {actor: guard.actor, idempotencyKey: guard.idempotencyKey});
    finishGuardedWrite(state, guard, 201, result.command);
    writeState(state);
    json(res, 201, result);
    return;
  }

  const readinessMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/readiness$/);
  if (req.method === "GET" && readinessMatch) {
    const reader = requireRead(req, state, taskGroupScope(state, readinessMatch[1]));
    if (reader.status) {
      json(res, reader.status, reader.payload);
      return;
    }
    const readOnlyState = JSON.parse(JSON.stringify(state));
    const readiness = computeCompletionReadiness(readOnlyState, readinessMatch[1], {root: repositoryRoot});
    const closeBarrier = computeCloseBarrier(readOnlyState, readinessMatch[1], {root: repositoryRoot, mutate: false});
    json(res, 200, {readiness, closeBarrier});
    return;
  }

  const projectProgressMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/progress$/);
  if (req.method === "GET" && projectProgressMatch) {
    const reader = requireRead(req, state, projectScope(projectProgressMatch[1]));
    if (reader.status) {
      json(res, reader.status, reader.payload);
      return;
    }
    const project = state.projects.find((item) => item.id === projectProgressMatch[1]);
    if (!project) {
      json(res, 404, {error: "project_not_found"});
      return;
    }
    json(res, 200, {
      projectId: project.id,
      progress: project.progress,
      repositoryOutputs: (state.repositoryOutputs || []).filter((target) => target.projectId === project.id)
    });
    return;
  }

  const taskGroupProgressMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/progress$/);
  if (req.method === "GET" && taskGroupProgressMatch) {
    const reader = requireRead(req, state, taskGroupScope(state, taskGroupProgressMatch[1]));
    if (reader.status) {
      json(res, reader.status, reader.payload);
      return;
    }
    const taskGroup = state.taskGroups.find((item) => item.id === taskGroupProgressMatch[1]);
    if (!taskGroup) {
      json(res, 404, {error: "task_group_not_found"});
      return;
    }
    json(res, 200, {
      taskGroupId: taskGroup.id,
      phase: taskGroup.phase,
      progress: taskGroup.progress,
      health: taskGroup.health,
      roles: taskGroup.roles,
      workItems: taskGroup.workItems,
      blockers: taskGroup.blockers,
      repositoryOutputs: (state.repositoryOutputs || []).filter((target) => target.taskGroupId === taskGroup.id)
    });
    return;
  }

  const dispatchEventsMatch = url.pathname.match(/^\/api\/agent-dispatches\/([^/]+)\/events$/);
  if (req.method === "GET" && dispatchEventsMatch) {
    const dispatch = state.agentDispatches.find((item) => item.dispatchId === dispatchEventsMatch[1]);
    if (!dispatch) return json(res, 404, {error: "dispatch_not_found"});
    const reader = requireRead(req, state, taskGroupScope(state, dispatch.taskGroupId));
    if (reader.status) return json(res, reader.status, reader.payload);
    const result = await waitForProjectExecutionEvents(dispatch.projectId, {
      dispatchId: dispatch.dispatchId,
      afterSequence: Number(url.searchParams.get("afterSequence") || 0),
      waitMs: Number(url.searchParams.get("waitMs") || 0),
      limit: Number(url.searchParams.get("limit") || 120)
    });
    json(res, 200, result);
    return;
  }

  const taskGroupEventsMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/execution-events$/);
  if (req.method === "GET" && taskGroupEventsMatch) {
    const taskGroup = state.taskGroups.find((item) => item.id === taskGroupEventsMatch[1]);
    if (!taskGroup) return json(res, 404, {error: "task_group_not_found"});
    const reader = requireRead(req, state, taskGroupScope(state, taskGroup.id));
    if (reader.status) return json(res, reader.status, reader.payload);
    const result = await waitForProjectExecutionEvents(taskGroup.projectId, {
      taskGroupId: taskGroup.id,
      afterSequence: Number(url.searchParams.get("afterSequence") || 0),
      waitMs: Number(url.searchParams.get("waitMs") || 0),
      limit: Number(url.searchParams.get("limit") || 120)
    });
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/bootstrap/init") {
    const guard = beginGuardedWrite(req, state, "bootstrap_init", "RuntimeBootstrapProfile:runtime_local", {resourceType: "system", resourceId: "runtime_local"});
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const seed = JSON.parse(readFileSync(seedPath, "utf8"));
    seed.__loadedStateVersion = state.__loadedStateVersion;
    seed.runtime.updatedAt = now();
    seed.runtime.executionProfile = executionProfile;
    ensureRuntimeCollections(seed, {root: repositoryRoot, runtimeDir, endpoint: localEndpoint(), executionProfile});
    finishGuardedWrite(seed, guard, 200, {profileId: "runtime_local"});
    audit(seed, "system", "bootstrap_init", "RuntimeBootstrapProfile:runtime_local");
    writeState(seed);
    json(res, 200, seed);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/orchestrator/run") {
    const guard = beginGuardedWrite(req, state, "orchestrator_run", `TaskGroup:${body.taskGroupId || "all"}`, body.taskGroupId ? taskGroupScope(state, body.taskGroupId) : {resourceType: "project", resourceId: body.projectId || "prj_control_plane"});
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const result = runAutonomousCycle(state, {root: repositoryRoot, runtimeDir, endpoint: publicEndpoint(req), mode: body.mode || "all", taskGroupId: body.taskGroupId, autoSyncSkills: body.autoSyncSkills !== false});
    audit(state, "orchestrator", "orchestrator_run", `TaskGroup:${body.taskGroupId || "all"}`);
    finishGuardedWrite(state, guard, 200, result);
    writeState(state);
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/verification/agent-runtime/run") {
    if (executionProfile !== "verification") {
      json(res, 409, {error: "server_side_agent_execution_forbidden", required: "register an Agent Runtime and let it claim the dispatch through /api/agent/v1/dispatches/next"});
      return;
    }
    const guard = beginGuardedWrite(req, state, "agent_runtime_worker_run", `TaskGroup:${body.taskGroupId || "all"}`, body.taskGroupId ? taskGroupScope(state, body.taskGroupId) : {resourceType: "project", resourceId: body.projectId || "prj_control_plane"});
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const result = runAgentRuntimeWorker(state, {
      root: repositoryRoot,
      repositoryRoot,
      runtimeDir,
      endpoint: localEndpoint(),
      taskGroupId: body.taskGroupId,
      maxJobs: body.maxJobs || 1,
      allowDeterministicLocalWorker: body.allowDeterministicLocalWorker === true && process.env.AIMAC_ALLOW_LOCAL_DETERMINISTIC_WORKER === "true"
    });
    audit(state, "agent-runtime", "agent_runtime_worker_run", `TaskGroup:${body.taskGroupId || "all"}`);
    finishGuardedWrite(state, guard, 200, result);
    writeState(state);
    json(res, 200, result);
    return;
  }

  const closeComputeMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/close-barrier\/compute$/);
  if (req.method === "POST" && closeComputeMatch) {
    const guard = beginGuardedWrite(req, state, "task_group_close_barrier_compute", `TaskGroup:${closeComputeMatch[1]}`, taskGroupScope(state, closeComputeMatch[1]));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const readiness = computeCompletionReadiness(state, closeComputeMatch[1], {root: repositoryRoot});
    const closeBarrier = computeCloseBarrier(state, closeComputeMatch[1], {root: repositoryRoot, mutate: body.mutate === true});
    const result = {readiness, closeBarrier};
    audit(state, "orchestrator", "task_group_close_barrier_compute", `TaskGroup:${closeComputeMatch[1]}`);
    finishGuardedWrite(state, guard, 200, result);
    writeState(state);
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/checkpoints") {
    const guard = beginGuardedWrite(req, state, "checkpoint_submit", `Checkpoint:${body.taskGroupId || "unknown"}:${body.workId || "unknown"}`, taskGroupScope(state, body.taskGroupId));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const result = acceptAgentCheckpoint(state, body, {root: repositoryRoot});
    if (!result.accepted) {
      json(res, result.status || 409, {error: result.error});
      return;
    }
    audit(state, "agent-runtime", "checkpoint_submit", `Checkpoint:${result.checkpoint.taskGroupId}:${result.checkpoint.workId}`);
    finishGuardedWrite(state, guard, 201, result.checkpoint);
    writeState(state);
    json(res, 201, result.checkpoint);
    return;
  }

  const skillSyncMatch = url.pathname.match(/^\/api\/skill-sources\/([^/]+)\/sync$/);
  if (req.method === "POST" && skillSyncMatch) {
    const guard = beginGuardedWrite(req, state, "skill_source_sync", `AgentSkillSource:${skillSyncMatch[1]}`, {resourceType: "system", resourceId: "skill_registry"});
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const result = syncSkillSource(state, skillSyncMatch[1], {root, runtimeDir});
    audit(state, "skill-registry", "skill_source_sync", `AgentSkillSource:${skillSyncMatch[1]}`);
    finishGuardedWrite(state, guard, 200, result);
    writeState(state);
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/model-capabilities") {
    const guard = beginGuardedWrite(req, state, "model_capability_register", `ModelCapabilityProfile:${body.providerClass || "custom"}`, {resourceType: "system", resourceId: "model_registry"});
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const profile = {
      ...defaultModelCapabilities(now()).find((item) => item.providerClass === (body.providerClass || "custom")),
      ...body,
      schemaVersion: "model-capability/v1",
      capabilityDigest: body.capabilityDigest || digestOf(body),
      observedAt: body.observedAt || now()
    };
    state.modelCapabilities = state.modelCapabilities.filter((item) => !(item.providerId === profile.providerId && item.modelId === profile.modelId));
    state.modelCapabilities.unshift(profile);
    audit(state, "model-registry", "model_capability_register", `ModelCapabilityProfile:${profile.providerId}/${profile.modelId}`);
    finishGuardedWrite(state, guard, 201, profile);
    writeState(state);
    json(res, 201, profile);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/model-selection/decide") {
    const guard = beginGuardedWrite(req, state, "model_selection_decide", `WorkItem:${body.workItemId || "unknown"}`, taskGroupScope(state, body.taskGroupId));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const decision = selectModel(state, {...body, policyDecisionRef: guard.policyDecision.id, auditRef: `audit:${guard.idempotencyKey}`});
    audit(state, "scheduler", "model_selection_decide", `ModelSelectionDecision:${decision.decisionId}`);
    finishGuardedWrite(state, guard, 201, decision);
    writeState(state);
    json(res, 201, decision);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session-placement/decide") {
    const guard = beginGuardedWrite(req, state, "session_placement_decide", `WorkItem:${body.workItemId || "unknown"}`, taskGroupScope(state, body.taskGroupId));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const decision = decideSessionPlacement(state, {...body, auditRef: `audit:${guard.idempotencyKey}`});
    audit(state, "scheduler", "session_placement_decide", `SessionPlacementDecision:${decision.decisionId}`);
    finishGuardedWrite(state, guard, 201, decision);
    writeState(state);
    json(res, 201, decision);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/runtime-issues") {
    const guard = beginGuardedWrite(req, state, "runtime_issue_collect", `RuntimeIssuePattern:${body.issueFingerprint || "new"}`, body.taskGroupId ? taskGroupScope(state, body.taskGroupId) : {resourceType: "project", resourceId: body.projectId || "prj_control_plane"});
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const issue = collectRuntimeIssue(state, body);
    const issueRef = issue.patternId ? `RuntimeIssuePattern:${issue.patternId}` : `RuntimeIssueSample:${issue.sampleId}`;
    audit(state, "monitor", "runtime_issue_collect", issueRef);
    finishGuardedWrite(state, guard, 201, issue);
    writeState(state);
    json(res, 201, issue);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/role-skill-overlays") {
    const guard = beginGuardedWrite(req, state, "role_skill_overlay_create", `AgentRoleSkill:${body.roleSkillRef || "default"}`, body.taskGroupId ? taskGroupScope(state, body.taskGroupId) : projectScope(body.projectId || "prj_control_plane"));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const overlay = registerRoleSkillOverlay(state, body);
    audit(state, "skill-registry", "role_skill_overlay_create", `RoleSkillOverlay:${overlay.overlayId}`);
    finishGuardedWrite(state, guard, 201, overlay);
    writeState(state);
    json(res, 201, overlay);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/projects") {
    const guard = beginGuardedWrite(req, state, "project_create", "Project:new", {resourceType: "project", resourceId: "new"});
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const id = createId("prj");
    const ownerAccountId = body.ownerAccountId || "acct_workspace_owner";
    state.projects.push({
      id,
      name: body.name || "Untitled Project",
      status: "active",
      ownerAccountId,
      members: [{accountId: ownerAccountId, role: "project_owner"}],
      progress: {percent: 0, phase: "intake", health: "ok", openTaskGroups: 0, blockedItems: 0, updatedAt: now()}
    });
    audit(state, ownerAccountId, "project_create", `Project:${id}`);
    finishGuardedWrite(state, guard, 201, {id});
    writeState(state);
    json(res, 201, {id});
    return;
  }

  const memberMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/members$/);
  if (req.method === "POST" && memberMatch) {
    const project = state.projects.find((item) => item.id === memberMatch[1]);
    if (!project) {
      json(res, 404, {error: "project_not_found"});
      return;
    }
    const accountId = body.accountId;
    if (!state.accounts.some((account) => accountIdOf(account) === accountId)) {
      json(res, 400, {error: "account_not_found"});
      return;
    }
    const guard = beginGuardedWrite(req, state, "project_member_grant", `Project:${project.id}`, projectScope(project.id));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    project.members = project.members.filter((member) => member.accountId !== accountId);
    project.members.push({accountId, role: body.role || "viewer"});
    state.accessGrants.push({
      schemaVersion: "access-control-grant/v1",
      grantId: createId("grant"),
      subjectRef: {subjectType: "account", subjectId: accountId},
      resource: {resourceType: "project", resourceId: project.id},
      role: body.role || "viewer",
      permissions: body.permissions || ["project:view"],
      status: "active",
      policyDecisionRef: guard.policyDecision.id,
      auditRef: `audit:${guard.idempotencyKey}`,
      createdAt: now(),
      updatedAt: now()
    });
    audit(state, "ui-console-service", "project_member_grant", `Project:${project.id}`);
    finishGuardedWrite(state, guard, 200, project);
    writeState(state);
    json(res, 200, project);
    return;
  }

  const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/(?:activate|activation)$/);
  if (req.method === "POST" && agentMatch) {
    const agent = state.agents.find((item) => item.id === agentMatch[1]);
    if (!agent) {
      json(res, 404, {error: "agent_not_found"});
      return;
    }
    const guard = beginGuardedWrite(req, state, "agent_activation_update", `AgentNode:${agent.id}`, agent.projectId ? projectScope(agent.projectId) : {resourceType: "project", resourceId: "prj_control_plane"});
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    agent.status = body.active === false ? "inactive" : "active";
    agent.capacity = agent.status === "active" ? "ready" : "standby";
    audit(state, "ui-console-service", "agent_activation_update", `AgentNode:${agent.id}`);
    finishGuardedWrite(state, guard, 200, agent);
    writeState(state);
    json(res, 200, agent);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agents") {
    const guard = beginGuardedWrite(req, state, "agent_create", `AgentNode:${body.role || "custom"}`, projectScope(body.projectId || "prj_control_plane"));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const agent = {
      id: createId("agent"),
      name: body.name || `${body.role || "custom"} Agent`,
      role: body.role || "custom",
      model: body.model || "auto_best",
      status: body.status || "active",
      trustScore: Number(body.trustScore || 0.85),
      capacity: body.status === "inactive" ? "standby" : "ready",
      projectId: body.projectId,
      roleSkillRef: body.roleSkillRef,
      createdAt: now(),
      updatedAt: now()
    };
    state.agents.push(agent);
    audit(state, "ui-console-service", "agent_create", `AgentNode:${agent.id}`);
    finishGuardedWrite(state, guard, 201, agent);
    writeState(state);
    json(res, 201, agent);
    return;
  }

  const taskGroupMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/control$/);
  if (req.method === "POST" && taskGroupMatch) {
    const taskGroup = state.taskGroups.find((item) => item.id === taskGroupMatch[1]);
    if (!taskGroup) {
      json(res, 404, {error: "task_group_not_found"});
      return;
    }
    const guard = beginGuardedWrite(req, state, `task_group_${body.action || "recompute_readiness"}`, `TaskGroup:${taskGroup.id}`, taskGroupScope(state, taskGroup.id));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const action = body.action || "recompute_readiness";
    if (action === "pause") taskGroup.goalExecutionStatus = "active_paused_by_control";
    if (action === "resume") taskGroup.goalExecutionStatus = "active";
    if (action === "request_review") taskGroup.reviewState = "review_requested";
    if (action === "rebound_drift") taskGroup.health = "attention";
    const runtimeControl = applyTaskGroupRuntimeControl(state, taskGroup, action, {actor: guard.actor, idempotencyKey: guard.idempotencyKey});
    taskGroup.updatedAt = now();
    audit(state, "ui-console-service", `task_group_${action}`, `TaskGroup:${taskGroup.id}`);
    const payload = {taskGroup, runtimeControl};
    finishGuardedWrite(state, guard, 200, payload);
    writeState(state);
    json(res, 200, payload);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/accounts") {
    const guard = beginGuardedWrite(req, state, "account_invite", "Account:new", {resourceType: "project", resourceId: body.projectId || "prj_control_plane"});
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const at = now();
    const accountId = createId("acct");
    const account = {
      schemaVersion: "account/v1",
      accountId,
      accountType: body.accountType || "user_account",
      displayName: body.displayName || "New User",
      email: body.email || `user-${Date.now()}@local`,
      status: "invited",
      roles: body.roles || ["viewer"],
      permissions: body.permissions || ["project:view"],
      authPolicy: {method: "invite_token", mfaRequired: false, passwordSet: false, sessionTtlSeconds: 3600},
      auditRef: `audit:${guard.idempotencyKey}`,
      createdAt: at,
      updatedAt: at
    };
    state.accounts.push(account);
    audit(state, "ui-console-service", "account_invite", `Account:${account.accountId}`);
    finishGuardedWrite(state, guard, 201, account);
    writeState(state);
    json(res, 201, account);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/access-grants") {
    const guard = beginGuardedWrite(req, state, "access_grant_create", `${body.resourceType || "project"}:${body.resourceId || "prj_control_plane"}`, {resourceType: body.resourceType || "project", resourceId: body.resourceId || "prj_control_plane"});
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const at = now();
    const grant = {
      schemaVersion: "access-control-grant/v1",
      grantId: createId("grant"),
      subjectRef: {subjectType: "account", subjectId: body.subjectId || "acct_workspace_owner"},
      resource: {resourceType: body.resourceType || "project", resourceId: body.resourceId || "prj_control_plane"},
      role: body.role || "viewer",
      permissions: body.permissions || ["project:view"],
      status: "active",
      policyDecisionRef: guard.policyDecision.id,
      auditRef: `audit:${guard.idempotencyKey}`,
      createdAt: at,
      updatedAt: at
    };
    state.accessGrants.push(grant);
    audit(state, "ui-console-service", "access_grant_create", `${grant.resource.resourceType}:${grant.resource.resourceId}`);
    finishGuardedWrite(state, guard, 201, grant);
    writeState(state);
    json(res, 201, grant);
    return;
  }

  const revokeGrantMatch = url.pathname.match(/^\/api\/access-grants\/([^/]+)\/revoke$/);
  if (req.method === "POST" && revokeGrantMatch) {
    const grant = state.accessGrants.find((item) => item.grantId === revokeGrantMatch[1]);
    if (!grant) {
      json(res, 404, {error: "access_grant_not_found"});
      return;
    }
    const guard = beginGuardedWrite(req, state, "access_grant_revoke", `AccessControlGrant:${grant.grantId}`, grant.resource || {resourceType: grant.resourceType, resourceId: grant.resourceId});
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    grant.status = "revoked";
    grant.updatedAt = now();
    audit(state, "ui-console-service", "access_grant_revoke", `AccessControlGrant:${grant.grantId}`);
    finishGuardedWrite(state, guard, 200, grant);
    writeState(state);
    json(res, 200, grant);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/instruction-envelopes") {
    const guard = beginGuardedWrite(req, state, "instruction_envelope_create", "InstructionEnvelope:new", taskGroupScope(state, body.taskGroupId || "tg_runtime_management"));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const at = now();
    const envelope = {
      schemaVersion: "instruction-envelope/v1",
      envelopeId: createId("env"),
      taskGroupId: body.taskGroupId || "tg_runtime_management",
      recipientRole: body.recipientRole || "orchestrator",
      effectiveInstructionPacketRef: body.effectiveInstructionPacketRef || "eip_runtime_management",
      formatVersion: "ai-native-instruction-envelope/v1",
      stablePrefixDigest: body.stablePrefixDigest || stableDigest("6"),
      digestRefs: body.digestRefs || ["ruleset:runtime:v1"],
      sharedDefinitionRefs: body.sharedDefinitionRefs || [],
      cacheKey: body.cacheKey || `runtime:v1:${Date.now()}`,
      status: "cache_indexed",
      tokenBudget: body.tokenBudget || {maxInputTokens: 4096, targetDeltaTokens: Number(body.estimatedTokens || 320), maxOutputTokens: 1200},
      outputContractRef: body.outputContractRef || "spec/checkpoint.schema.json",
      payloadDigest: body.payloadDigest || stableDigest("7"),
      auditRef: `audit:${guard.idempotencyKey}`,
      createdAt: at,
      updatedAt: at
    };
    state.instructionMetrics.envelopes.push(envelope);
    audit(state, "instruction-optimizer", "instruction_envelope_create", `InstructionEnvelope:${envelope.envelopeId}`);
    finishGuardedWrite(state, guard, 201, envelope);
    writeState(state);
    json(res, 201, envelope);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/shared-definition-contracts") {
    const guard = beginGuardedWrite(req, state, "shared_definition_contract_create", "SharedDefinitionContract:new", projectScope(body.projectId || "prj_control_plane"));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const at = now();
    const definition = {
      schemaVersion: "shared-definition-contract/v1",
      contractId: createId("sdc"),
      projectId: body.projectId || "prj_control_plane",
      definitionType: body.definitionType || "terminology",
      scopeRefs: body.scopeRefs || ["Project"],
      canonicalOwnerRole: body.canonicalOwnerRole || "orchestrator",
      producerRole: body.producerRole || "decision-center",
      status: body.status || "owner_assigned",
      definitionDigest: body.definitionDigest || stableDigest("8"),
      consumerRefs: body.consumerRefs || [],
      repositoryOutputTargetRef: body.repositoryOutputTargetRef || "rot_runtime_management",
      repositoryOutputTargetDigest: body.repositoryOutputTargetDigest || stableDigest("9"),
      conflictPolicy: body.conflictPolicy || "block_and_request_canonical_decision",
      changePolicy: body.changePolicy || {requiresDecisionRecord: true, invalidatesConsumers: true, consumerAckRequired: true},
      reviewEvidenceRefs: body.reviewEvidenceRefs || ["review:auto"],
      auditRef: `audit:${guard.idempotencyKey}`,
      createdAt: at,
      updatedAt: at
    };
    state.sharedDefinitions.push(definition);
    audit(state, "orchestrator", "shared_definition_contract_create", `SharedDefinitionContract:${definition.contractId}`);
    finishGuardedWrite(state, guard, 201, definition);
    writeState(state);
    json(res, 201, definition);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/repository-output-targets") {
    const pathAllowlist = body.pathAllowlist || ["docs/**", "spec/**"];
    const artifactManifestPath = body.artifactManifestPath || `docs/artifact-manifests/manifest.${Date.now()}.json`;
    if (!validPathAllowlist(pathAllowlist) || !gitTrackablePath(artifactManifestPath)) {
      json(res, 400, {error: "repository_output_target_must_use_git_trackable_paths"});
      return;
    }
    const guard = beginGuardedWrite(req, state, "repository_output_target_select", "RepositoryOutputTarget:new", taskGroupScope(state, body.taskGroupId || "tg_runtime_management"));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const at = now();
    const remote = body.remote || "origin";
    const project = state.projects.find((item) => item.id === (body.projectId || "prj_control_plane"));
    const repository = (project?.repositories || []).find((item) => item.id === body.repositoryId) || project?.repositories?.[0];
    const target = {
      schemaVersion: "repository-output-target/v1",
      targetId: createId("rot"),
      projectId: body.projectId || "prj_control_plane",
      taskGroupId: body.taskGroupId || "tg_runtime_management",
      workItemId: body.workItemId || "work_unknown",
      repositoryId: body.repositoryId || "repo_control_plane",
      repositoryUrl: body.repositoryUrl || gitRemoteUrl(repositoryRoot, remote) || repository?.url || "git:unknown-project-repository",
      remote,
      branch: body.branch || "main",
      baseRef: body.baseRef || gitHead(repositoryRoot),
      pathAllowlist,
      status: "selected",
      outputPolicy: "project_git_repository_only",
      decisionRecordRef: body.decisionRecordRef || guard.policyDecision.id,
      artifactManifestPath,
      auditRef: `audit:${guard.idempotencyKey}`,
      createdAt: at,
      updatedAt: at
    };
    state.repositoryOutputs ||= [];
    state.repositoryOutputs.push(target);
    audit(state, "repository-router", "repository_output_target_select", `RepositoryOutputTarget:${target.targetId}`);
    finishGuardedWrite(state, guard, 201, target);
    writeState(state);
    json(res, 201, target);
    return;
  }

  json(res, 404, {error: "api_not_found"});
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (["/install-agent.sh", "/install-agent.sh.sha256", "/agent-runtime.mjs", "/agent-runtime.mjs.sha256"].includes(pathname)) {
    serveAgentAsset(req, res, pathname);
    return;
  }
  if (pathname === "/mcp") {
    handleMcp(req, res).catch((error) => {
      json(res, error.status || 500, {error: error.message || "mcp_server_error"});
    });
    return;
  }
  if (!req.url.startsWith("/api/")) {
    serveStatic(req, res);
    return;
  }

  handleApi(req, res).catch((error) => {
    if (isStateStoreConflict(error)) {
      json(res, 409, {error: "state_write_conflict", retryable: true, message: error.message});
      return;
    }
    json(res, error.status || 500, {error: "server_error", message: error.message});
  });
});

assertRuntimeSecurity();
ensureState();
server.listen(port, host, () => {
  console.log(`AI Multi-Agent Ctrl console: http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`);
  console.log(`Centralized MCP endpoint: ${publicEndpoint()}/mcp`);
  console.log(`Agent installer: ${publicEndpoint()}/install-agent.sh`);
});
