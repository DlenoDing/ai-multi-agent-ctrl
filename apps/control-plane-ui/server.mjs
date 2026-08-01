import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, freemem, hostname, loadavg, platform, totalmem } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureStoredState, isStateStoreConflict, markRuntimeStorage, readStoredCentralState, readStoredState, stateStoreKind, writeStoredState } from "./lib/state-store.mjs";
import { appendProjectExecutionEvent, projectExecutionEventStorageInfo, readProjectExecutionEventByKey, readProjectExecutionEvents } from "./lib/project-event-store.mjs";
import {
  authenticateAgentNode,
  ackAgentControlCommand,
  buildExecutionContentBundle,
  claimNextDispatch,
  createAgentControlCommand,
  createAgentJoinToken,
  ensureAgentGatewayCollections,
  finishNodeDispatch,
  getDispatchForNode,
  getSkillWorkset,
  heartbeatAgentNode,
  isSafeGitRemoteUrl,
  listAgentControlCommands,
  listAgentJoinTokens,
  prepareAgentExecutionEvent,
  publicAgentNode,
  registerAgentNode,
  recordAgentExecutionEvent,
  requestAgentNodeRevocation,
  revokeDispatchMcpGrants,
  selfCheckAgentNode
} from "./lib/agent-gateway.mjs";
import { approvalResolve, assignWorkItem, handleMcpJsonRpc, isWriteTool, permissionResolve } from "../mcp-server/server.mjs";
import {
  canUseGitPath,
  acceptAgentCheckpoint,
  approvalRequestCreate,
  artifactRegister,
  claimLease,
  classifyDerivedTask,
  contractPublish,
  createExecutionTopology,
  advanceExecutionTopology,
  findingResolve,
  findingSubmit,
  policyDecisionEval,
  permissionRequestSubmit,
  releaseLease,
  reviewBundleRegister,
  reviewPlanCreate,
  roomSend,
  roomWait,
  ruleSourceResolve,
  collectRuntimeIssue,
  computeCloseBarrier,
  computeCompletionReadiness,
  computeProgressSnapshots,
  cancelPendingConfirmationsForDispatch,
  consumeHumanConfirmation,
  createHumanConfirmationRequest,
  createHumanDirective,
  createId,
  decideHumanConfirmation,
  decideSessionPlacement,
  defaultModelCapabilities,
  DEFAULT_ORGANIZATION_ID,
  digestOf,
  effectiveProjectConfig,
  effectiveTaskGroupConfig,
  ensureRuntimeCollections,
  gitHead,
  gitRemoteUrl,
  organizationOf,
  organizationQuotaCheck,
  pathAllowlistValid,
  recomputeOrganizationUsage,
  registerRoleSkillOverlay,
  normalizeTaskGroupLanguagePolicy,
  projectOwnerGrantPermissions,
  runAgentRuntimeWorker,
  runAutonomousCycle,
  runCommandLifecycle,
  selectModel,
  syncSkillSource,
  updateTaskGroupLanguagePolicy
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
const stateViewCacheTtlMs = Number(process.env.AIMAC_STATE_VIEW_CACHE_TTL_MS || 60000);
const stateViewMaxEntries = Number(process.env.AIMAC_STATE_VIEW_CACHE_MAX_ENTRIES || 200);
const agentControlWaitFanout = new Map();
const projectExecutionWaitFanout = new Map();
const longPollWaiters = new Map();
// WebSocket clients subscribed to real-time wake channels (see /api/realtime). Wake frames carry
// no payload; the client re-fetches through the existing authenticated + tenant-scoped endpoints.
const realtimeClients = new Set();

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
  "scheduler-mcp.execution_topology_advance",
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

function readHealthState() {
  ensureState();
  const state = readStoredCentralState({root, runtimeDir, statePath, seedPath, buildInitialState});
  ensureRuntimeCollections(state, {root: repositoryRoot, runtimeDir, endpoint: process.env.AIMAC_PUBLIC_URL || localEndpoint(), executionProfile});
  markRuntimeStorage(state, ".runtime/control-plane-state.json");
  return state;
}

function writeState(state) {
  stateViewCache.clear();
  scopedStateCache.clear();
  computeProgressSnapshots(state);
  markRuntimeStorage(state, ".runtime/control-plane-state.json");
  writeStoredState(state, {root, runtimeDir, statePath, seedPath, buildInitialState, expectedStateVersion: state.__loadedStateVersion});
  flushPendingAuditAppends(state);
  notifyLongPollWaiters("state");
  const nodeIdsWithQueuedCommands = new Set((state.agentControlCommands || [])
    .filter((command) => command.status === "queued")
    .map((command) => command.nodeId));
  for (const nodeId of nodeIdsWithQueuedCommands) notifyLongPollWaiters(`agent-control:${nodeId}`);
}

function audit(state, actor, action, subject, result = "succeeded") {
  ensureControlState(state);
  const entry = {
    id: `audit_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    at: now(),
    actor,
    action,
    subject,
    result,
    stateVersion: Number(state.stateVersion || 0),
    prevHash: state.auditLog[0]?.rowHash || state.auditChainHead || "sha256:genesis"
  };
  entry.rowHash = digestOf(entry);
  state.auditLog.unshift(entry);
  state.auditLog = state.auditLog.slice(0, 80);
  state.auditChainHead = entry.rowHash;
  state.__pendingAuditAppends = [...(state.__pendingAuditAppends || []), entry];
}

function flushPendingAuditAppends(state) {
  const pending = state.__pendingAuditAppends || [];
  delete state.__pendingAuditAppends;
  if (!pending.length) return;
  try {
    appendFileSync(join(runtimeDir, "audit-log.jsonl"), pending.map((entry) => `${JSON.stringify(entry)}\n`).join(""), {mode: 0o600});
  } catch {}
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

// 幂等记录按数量淘汰最旧项，界住 state.json 无限增长（保留近期重放正确性；幂等键本就是近期重试语义）。
function evictIdempotencyRecords(state) {
  const cap = Number(process.env.AIMAC_IDEMPOTENCY_RECORD_CAP || 5000);
  const keys = Object.keys(state.idempotencyRecords || {});
  if (keys.length <= cap) return;
  const ordered = keys
    .map((key) => ({key, createdAt: state.idempotencyRecords[key]?.createdAt || ""}))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const {key} of ordered.slice(0, keys.length - cap)) delete state.idempotencyRecords[key];
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
  // Gap #3: run the guarded write through the real Command bus lifecycle (created -> admitted ->
  // dispatched -> running -> succeeded) instead of pushing a terminal stub. Control-plane writes
  // are internal state mutations (no external side effect), so no CommandEffect is emitted.
  runCommandLifecycle(state, {
    type: guard.command.type,
    subject: guard.command.subject,
    idempotencyKey: guard.idempotencyKey,
    policyDecisionRef: guard.policyDecision.id,
    resultRef: `response:${guard.idempotencyKey}`
  });
  state.decisionRecords = state.decisionRecords.slice(0, 120);
  state.policyDecisions = state.policyDecisions.slice(0, 120);
  state.idempotencyRecords[guard.idempotencyKey] = {status, payload, actor: guard.actor, action: guard.command.type, bodyDigest: guard.bodyDigest, createdAt: updatedAt};
  evictIdempotencyRecords(state);
  audit(state, "policy-engine", "policy_decision_allowed", guard.command.subject);
  audit(state, "command-bus", "command_succeeded", guard.command.subject);
}

function accountIdOf(account) {
  return account.accountId || account.id;
}

function accountEffectivePermissions(state, account) {
  // Union of direct permissions and all active grant permissions for this account. Resource-scope-agnostic,
  // so it is a superset used only as a UI capability hint; the backend still enforces per-scope on every write.
  const direct = account.permissions || [];
  const granted = (state.accessGrants || [])
    .filter((grant) => grant.status === "active" && grant.subjectRef?.subjectType === "account" && grant.subjectRef?.subjectId === accountIdOf(account))
    .flatMap((grant) => grant.permissions || []);
  const owns = (state.projects || []).some((project) => project.ownerAccountId === accountIdOf(account));
  const ownerHint = owns ? projectOwnerGrantPermissions : [];
  return [...new Set([...direct, ...granted, ...ownerHint])];
}

function isSystemAccount(account) {
  return Boolean(account && (account.accountType === "system_admin" || (account.roles || []).includes("system_admin") || (account.permissions || []).includes("system:*")));
}

function publicAccountRecord(account) {
  return {
    schemaVersion: account.schemaVersion,
    accountId: account.accountId,
    accountType: account.accountType,
    displayName: account.displayName,
    email: account.email,
    status: account.status,
    roles: account.roles || [],
    permissions: account.permissions || [],
    authPolicy: account.authPolicy ? {method: account.authPolicy.method, mfaRequired: Boolean(account.authPolicy.mfaRequired), passwordSet: Boolean(account.authPolicy.passwordSet), sessionTtlSeconds: account.authPolicy.sessionTtlSeconds} : undefined,
    credentialIssuedAt: account.credentialIssuedAt,
    credentialExpiresAt: account.credentialExpiresAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

function normalizeStringList(value, fallback = []) {
  const source = Array.isArray(value)
    ? value
    : String(value || "").split(/[\n,]/u);
  const normalized = [...new Set(source.map((item) => String(item).trim()).filter(Boolean))];
  return normalized.length ? normalized : fallback;
}

function requestedSystemAccountInvite(input = {}) {
  const accountType = String(input.accountType || "user_account");
  const roles = normalizeStringList(input.roles, []);
  const permissions = normalizeStringList(input.permissions, []);
  return accountType === "system_admin" ||
    roles.includes("system_admin") ||
    permissions.some((permission) => permission === "system:*" || permission.startsWith("system:"));
}

function boundedQuota(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.max(1, Number(fallback) || 1);
  return Math.max(1, Math.min(1_000_000, Math.floor(numeric)));
}

// Reject over-length rule fragments up front so a safety rule is never silently truncated (which would
// quietly weaken its semantics). Returns an error code string, or null when the payload is within limits.
function ruleFragmentsRejection(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return null;
  if (value.length > 200) return "too_many_rules";
  for (const rule of value) {
    if (!rule || typeof rule !== "object") continue;
    if (rule.ruleId !== undefined && String(rule.ruleId).length > 128) return "rule_id_too_long";
    if (rule.title !== undefined && String(rule.title).length > 256) return "rule_title_too_long";
    if (rule.content !== undefined && String(rule.content).length > 8192) return "rule_content_too_long";
  }
  return null;
}

function sanitizeRuleFragments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).filter((rule) => rule && typeof rule === "object").map((rule) => {
    const clean = {};
    if (rule.ruleId !== undefined) clean.ruleId = String(rule.ruleId).slice(0, 128);
    if (rule.title !== undefined) clean.title = String(rule.title).slice(0, 256);
    if (rule.content !== undefined) clean.content = String(rule.content).slice(0, 8192);
    if (rule.status !== undefined) clean.status = ["active", "draft", "disabled"].includes(rule.status) ? rule.status : "active";
    if (rule.enabled !== undefined) clean.enabled = rule.enabled !== false;
    return clean;
  });
}

function sanitizeMemberPermissions(value, fallback = ["project:view"]) {
  const sanitized = normalizeStringList(value, fallback).filter((permission) =>
    !permission.startsWith("system:") &&
    !permission.startsWith("org:") &&
    !unsafeDelegatedGrantPermissions.has(permission) &&
    !permission.endsWith(":*"));
  return sanitized.length ? sanitized : fallback;
}

function normalizeInvitedAccount(input = {}, systemScoped = false) {
  const roles = normalizeStringList(input.roles, ["viewer"]);
  const permissions = normalizeStringList(input.permissions, ["project:view"]);
  if (systemScoped) {
    return {
      accountType: String(input.accountType || "user_account"),
      roles,
      permissions
    };
  }
  if (requestedSystemAccountInvite(input)) throw new Error("project_invite_cannot_grant_system_account_or_permission");
  return {
    accountType: "user_account",
    roles: roles.filter((role) => role !== "system_admin" && role !== "org_admin"),
    permissions: permissions.filter((permission) =>
      !permission.startsWith("system:") &&
      !permission.startsWith("org:") &&
      !unsafeDelegatedGrantPermissions.has(permission) &&
      !permission.endsWith(":*"))
  };
}

const roleGrantPermissionTemplates = Object.freeze({
  project_owner: [...projectOwnerGrantPermissions],
  project_admin: ["project:view", "project:update", "project:grant", "member:invite", "agent:activate", "task_group:read", "task_group:control"],
  task_group_owner: ["project:view", "task_group:read", "task_group:control"],
  agent_operator: ["project:view", "agent:activate", "task_group:read"],
  reviewer: ["project:view", "task_group:read", "task_group:review"],
  viewer: ["project:view"],
  project_member: ["project:view"]
});

const taskGroupGrantPermissionTemplates = Object.freeze({
  task_group_owner: ["task_group:read", "task_group:control"],
  agent_operator: ["task_group:read", "task_group:monitor"],
  reviewer: ["task_group:read", "task_group:review"],
  viewer: ["task_group:read"],
  project_member: ["task_group:read"]
});

const unsafeDelegatedGrantPermissions = new Set([
  "system:*",
  "project:*",
  "task_group:*",
  "project:create",
  "task_group:orchestrate",
  "task_group:checkpoint_submit"
]);

function permissionsForRoleGrant(role, resourceType) {
  const templates = resourceType === "task_group" ? taskGroupGrantPermissionTemplates : roleGrantPermissionTemplates;
  return templates[role] || templates.viewer;
}

function projectIdFromGrantScope(state, resourceScope = {}) {
  if (resourceScope.resourceType === "project") return resourceScope.resourceId;
  if (resourceScope.resourceType === "task_group") {
    return resourceScope.projectId || state.taskGroups.find((item) => item.id === resourceScope.resourceId)?.projectId || "";
  }
  return "";
}

function actorIsProjectOwnerForScope(state, actor, resourceScope = {}) {
  const projectId = projectIdFromGrantScope(state, resourceScope);
  if (!projectId) return false;
  const project = state.projects.find((item) => item.id === projectId);
  if (project?.ownerAccountId === actor) return true;
  return (state.accessGrants || []).some((grant) =>
    grant.status === "active" &&
    grant.role === "project_owner" &&
    grant.subjectRef?.subjectType === "account" &&
    grant.subjectRef?.subjectId === actor &&
    grant.resource?.resourceType === "project" &&
    grant.resource?.resourceId === projectId
  );
}

function sanitizeGrantRequest(state, actor, input = {}, resourceScope = {}) {
  const account = state.accounts.find((item) => accountIdOf(item) === actor);
  const role = String(input.role || "viewer");
  const resource = {
    resourceType: String(input.resourceType || resourceScope.resourceType || "project"),
    resourceId: String(input.resourceId || resourceScope.resourceId || "prj_control_plane")
  };
  const explicitPermissions = normalizeStringList(input.permissions, []);
  const permissions = explicitPermissions.length
    ? explicitPermissions
    : permissionsForRoleGrant(role, resource.resourceType);
  const unsafe = permissions.filter((permission) =>
    unsafeDelegatedGrantPermissions.has(permission) || permission.startsWith("system:")
  );
  if (unsafe.length) {
    return {ok: false, status: 400, error: "unsafe_grant_permissions", permissions: unsafe};
  }
  const subjectAccount = state.accounts.find((item) => accountIdOf(item) === (input.subjectId || "acct_workspace_owner"));
  const resourceOrg = resourceScopeOrganizationId(state, resource);
  if (subjectAccount?.organizationId && resourceOrg && subjectAccount.organizationId !== resourceOrg) {
    return {ok: false, status: 400, error: "cross_org_grant_not_allowed"};
  }
  if (!isSystemAccount(account)) {
    const denied = permissions.filter((permission) => {
      if (permission === "project:grant" && !actorIsProjectOwnerForScope(state, actor, resourceScope)) return true;
      return !hasPermission(state, actor, permission, resourceScope);
    });
    if (denied.length) return {ok: false, status: 403, error: "grant_permission_not_delegable", permissions: denied};
  }
  return {ok: true, role, resource, permissions};
}

function ensureProjectOwnerGrant(state, project, ownerAccountId, policyDecisionRef, auditRef) {
  state.accessGrants ||= [];
  const existing = state.accessGrants.find((grant) =>
    grant.status === "active" &&
    grant.subjectRef?.subjectType === "account" &&
    grant.subjectRef?.subjectId === ownerAccountId &&
    grant.resource?.resourceType === "project" &&
    grant.resource?.resourceId === project.id
  );
  if (existing) return existing;
  const at = now();
  const grant = {
    schemaVersion: "access-control-grant/v1",
    grantId: createId("grant"),
    subjectRef: {subjectType: "account", subjectId: ownerAccountId},
    resource: {resourceType: "project", resourceId: project.id},
    role: "project_owner",
    permissions: [...projectOwnerGrantPermissions],
    status: "active",
    policyDecisionRef,
    auditRef,
    createdAt: at,
    updatedAt: at
  };
  state.accessGrants.push(grant);
  return grant;
}

function createTaskGroupRecord(state, input = {}, options = {}) {
  const projectId = String(input.projectId || "prj_control_plane");
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return {ok: false, status: 404, error: "project_not_found"};
  const taskGroupId = input.taskGroupId || createId("tg");
  if (state.taskGroups.some((item) => item.id === taskGroupId)) {
    return {ok: false, status: 409, error: "task_group_id_conflict"};
  }
  const at = now();
  const inheritedRoleIds = (project.config?.defaultRoles || []).map((role) => role.roleId).filter(Boolean);
  const userRoleIds = normalizeStringList(input.roles, []);
  const roleIdSet = new Set();
  const roles = [];
  for (const roleId of userRoleIds) {
    if (roleIdSet.has(roleId)) continue;
    roleIdSet.add(roleId);
    roles.push({roleId, status: "ready", skillBinding: "server_resolved_on_dispatch", addedBy: "user", addedAt: at});
  }
  for (const roleId of inheritedRoleIds) {
    if (roleIdSet.has(roleId)) continue;
    roleIdSet.add(roleId);
    roles.push({roleId, status: "ready", skillBinding: "server_resolved_on_dispatch", addedBy: "inherited", addedAt: at});
  }
  const taskGroup = {
    id: taskGroupId,
    projectId,
    name: input.name || input.title || "AI-native Task Group",
    title: input.title || input.name || "AI-native Task Group",
    objective: input.objective || input.title || input.name || "Machine-executed task group",
    status: input.status || "planned",
    goalExecutionStatus: "ready",
    phase: input.phase || "planning",
    progress: 0,
    health: "ok",
    languagePolicy: normalizeTaskGroupLanguagePolicy(input.languagePolicy || input),
    roles,
    workItems: [],
    blockers: [],
    auditRef: options.auditRef,
    createdAt: at,
    updatedAt: at
  };
  state.taskGroups.unshift(taskGroup);
  computeProgressSnapshots(state);
  return {taskGroup};
}

function createWorkItemRecord(state, taskGroupId, input = {}, options = {}) {
  const taskGroup = state.taskGroups.find((item) => item.id === taskGroupId);
  if (!taskGroup) return {ok: false, status: 404, error: "task_group_not_found"};
  const workItemId = input.workItemId || createId("work");
  if ((taskGroup.workItems || []).some((item) => item.id === workItemId)) {
    return {ok: false, status: 409, error: "work_item_id_conflict"};
  }
  const at = now();
  const workItem = {
    id: workItemId,
    title: input.title || "AI-native work item",
    status: ["draft", "ready"].includes(input.status) ? input.status : "ready",
    ownerRole: input.ownerRole || input.roleId || "orchestrator",
    progress: 0,
    requirements: normalizeStringList(input.requirements, []),
    auditRef: options.auditRef,
    createdAt: at,
    updatedAt: at
  };
  taskGroup.workItems ||= [];
  taskGroup.workItems.push(workItem);
  if (!taskGroup.roles?.some((role) => role.roleId === workItem.ownerRole)) {
    taskGroup.roles ||= [];
    taskGroup.roles.push({roleId: workItem.ownerRole, status: "ready", skillBinding: "server_resolved_on_dispatch", addedBy: "user", addedAt: at});
  }
  taskGroup.updatedAt = at;
  computeProgressSnapshots(state);
  return {taskGroupId: taskGroup.id, workItem, taskGroup};
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

const loginAttempts = new Map();

function loginClientIp(req) {
  if (process.env.AIMAC_TRUST_PROXY === "true") {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return String(req.socket.remoteAddress || "unknown");
}

function loginRateLimited(req) {
  const entry = loginAttempts.get(loginClientIp(req));
  if (!entry || Date.now() > entry.resetAt) return false;
  const maxAttempts = Math.max(3, Number(process.env.AIMAC_LOGIN_ATTEMPTS_PER_MINUTE || 10));
  return entry.count >= maxAttempts;
}

function recordFailedLogin(req) {
  const ip = loginClientIp(req);
  const nowMs = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || nowMs > entry.resetAt) {
    if (loginAttempts.size > 10000) loginAttempts.clear();
    loginAttempts.set(ip, {count: 1, resetAt: nowMs + 60000});
    return;
  }
  entry.count += 1;
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
  if (isSystemAccount(accountContext?.account)) {
    return {principal: {kind: "system_admin", id: accountContext.account.accountId, allowedMcpTools: ["*"]}, allowedMcpTools: ["*"]};
  }
  const config = readRuntimeConfig();
  if (config.mcpServiceTokenHash === digestOf(`mcp-service:${token}`)) {
    const allowedMcpTools = mcpServiceAllowedTools();
    return {principal: {kind: "system_service", id: "remote-mcp-client", projectIds: mcpServiceProjectIds(), allowedMcpTools}, allowedMcpTools};
  }
  return null;
}

function mcpServiceProjectIds() {
  const configured = String(process.env.AIMAC_MCP_SERVICE_PROJECT_IDS || "").split(",").map((item) => item.trim()).filter(Boolean);
  return configured.length ? configured : ["prj_control_plane"];
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
  if (isSystemAccount(account)) return true;
  if (resourceScope.resourceType === "organization") return account.organizationId === resourceScope.resourceId;
  if (resourceScope.resourceType === "system") return false;
  if (resourceScope.resourceType === "project") return canReadProject(state, account, resourceScope.resourceId);
  if (resourceScope.resourceType === "task_group") return canReadTaskGroup(state, account, resourceScope.resourceId);
  return true;
}

function canReadProject(state, account, projectId) {
  if (!projectId) return false;
  const project = state.projects.find((item) => item.id === projectId);
  if (account.accountType === "org_admin" && project && (project.organizationId || DEFAULT_ORGANIZATION_ID) === account.organizationId) return true;
  if (project?.ownerAccountId === account.accountId || (project?.members || []).some((member) => member.accountId === account.accountId)) return true;
  return ["project:view", "project:*"].some((permission) => hasPermission(state, account.accountId, permission, {resourceType: "project", resourceId: projectId}));
}

function canReadTaskGroup(state, account, taskGroupId) {
  const taskGroup = state.taskGroups.find((item) => item.id === taskGroupId);
  if (!taskGroup) return false;
  if (isSystemAccount(account)) return true;
  const project = state.projects.find((item) => item.id === taskGroup.projectId);
  if (project?.ownerAccountId === account.accountId) return true;
  return ["task_group:read", "task_group:review", "task_group:control", "task_group:orchestrate", "task_group:monitor", "task_group:*"].some((permission) =>
    hasPermission(state, account.accountId, permission, {resourceType: "task_group", resourceId: taskGroupId, projectId: taskGroup.projectId})
  );
}

// 非系统账号可下发的顶层 state 键白名单（已显式过滤的租户集合 + 全局安全的系统配置/计数器）。
// fail-closed：任何未列入的键（含未来新增且忘记过滤的键）在下发前被删除，避免默认整份泄漏给租户。
const SCOPED_ALLOWED_TOP_KEYS = new Set([
  "schemaVersion", "stateVersion", "orgMigrationVersion", "runtime", "managementSurfaces",
  "modelProviders", "modelCapabilities", "modelSelectionPolicies", "skillSources", "roleSkills",
  "agentControlSequence", "agentExecutionSequence", "leaseSequence",
  "projects", "taskGroups", "repositoryOutputs", "workSessions", "workerLanes", "agentDispatches",
  "agentRuntimeNodes", "agentControlCommands", "agentExecutionEvents", "agentJoinTokens", "agents",
  "agentTaskContracts", "effectiveInstructionPackets", "roleDriftGuards", "modelSelectionDecisions",
  "sessionPlacementDecisions", "roleSkillOverlays", "executionTopologies", "reviewPlans", "reviewBundles",
  "checkpoints", "completionReadiness", "closeBarriers", "admissionDecisions", "admissionScans", "sharedDefinitions", "progressSnapshots", "leases",
  "accounts", "accessGrants", "auditLog", "policyDecisions", "commands", "decisionRecords", "commandEffects", "dlqEntries", "integrationBatches",
  "idempotencyRecords", "runtimeIssuePatterns", "runtimeIssueSamples", "systemUpgradeCandidates",
  "agentGatewayEvents", "mcpCalls", "mcpProbeNodes", "instructionMetrics", "organizations",
  "humanConfirmationRequests", "humanDirectives", "transitionEvidence", "ruleSourceResolutions",
  "externalUpgradeImports", "mcpGrants", "roomMessages", "roomParticipants", "roomAcks", "roomSequenceByRoom",
  "permissionRequests", "approvalRequests", "artifacts", "testResults", "findings", "qualityGates",
  "derivedTaskRequests", "eventLog", "authSessions",
  // stateViewForAccount / 登录响应后续附加的派生字段
  "pendingHumanConfirmationTaskGroupIds"
]);

function scopedStateForAccount(state, account, session) {
  const cloned = {...state};
  delete cloned.__loadedStateVersion;
  const isSystem = isSystemAccount(account);
  cloned.authSessions = (state.authSessions || [])
    .filter((item) => isSystem || item.sessionId === session.sessionId)
    .map((item) => ({sessionId: item.sessionId, accountId: item.accountId, status: item.status, expiresAt: item.expiresAt, createdAt: item.createdAt, updatedAt: item.updatedAt}));
  cloned.agentRuntimeNodes = (state.agentRuntimeNodes || []).map(publicAgentNode);
  cloned.agentJoinTokens = listAgentJoinTokens(state);
  if (isSystem) return cloned;
  const visibleProjectIds = new Set((state.projects || []).filter((project) => canReadProject(state, account, project.id)).map((project) => project.id));
  const visibleTaskGroupIds = new Set((state.taskGroups || []).filter((taskGroup) => canReadTaskGroup(state, account, taskGroup.id)).map((taskGroup) => taskGroup.id));
  cloned.projects = (state.projects || []).filter((project) => visibleProjectIds.has(project.id));
  cloned.taskGroups = (state.taskGroups || []).filter((taskGroup) => visibleTaskGroupIds.has(taskGroup.id));
  cloned.repositoryOutputs = (state.repositoryOutputs || []).filter((target) =>
    target.taskGroupId ? visibleTaskGroupIds.has(target.taskGroupId) : visibleProjectIds.has(target.projectId)
  );
  cloned.workSessions = (state.workSessions || []).filter((sessionItem) => visibleTaskGroupIds.has(sessionItem.taskGroupId));
  cloned.workerLanes = (state.workerLanes || []).filter((lane) => lane.taskGroupId && visibleTaskGroupIds.has(lane.taskGroupId));
  cloned.agentDispatches = (state.agentDispatches || []).filter((dispatch) => visibleTaskGroupIds.has(dispatch.taskGroupId));
  cloned.agentRuntimeNodes = (state.agentRuntimeNodes || []).filter((node) => (node.projectIds || []).some((projectId) => visibleProjectIds.has(projectId))).map(publicAgentNode);
  const visibleNodeIds = new Set(cloned.agentRuntimeNodes.map((node) => node.nodeId));
  // A task-group-attributed record must be gated on task-group visibility (same invariant as
  // checkpoints/admissionDecisions): a plain project member without a task-group grant must not see a
  // hidden task group's execution events or control commands. Fall back to node visibility ONLY for
  // node-level records that carry no taskGroupId (e.g. refresh_profile control commands).
  cloned.agentControlCommands = (state.agentControlCommands || []).filter((command) => command.taskGroupId ? visibleTaskGroupIds.has(command.taskGroupId) : visibleNodeIds.has(command.nodeId));
  cloned.agentExecutionEvents = (state.agentExecutionEvents || []).filter((event) => event.taskGroupId ? visibleTaskGroupIds.has(event.taskGroupId) : visibleNodeIds.has(event.nodeId));
  cloned.agentJoinTokens = listAgentJoinTokens(state).filter((token) => visibleProjectIds.has(token.projectId));
  cloned.agents = (state.agents || []).filter((agent) =>
    (agent.organizationId || DEFAULT_ORGANIZATION_ID) === account.organizationId &&
    (!agent.projectId || visibleProjectIds.has(agent.projectId)));
  cloned.agentTaskContracts = (state.agentTaskContracts || []).filter((contract) => visibleTaskGroupIds.has(contract.taskGroupId));
  cloned.effectiveInstructionPackets = (state.effectiveInstructionPackets || []).filter((packet) => visibleTaskGroupIds.has(packet.taskGroupId));
  cloned.roleDriftGuards = (state.roleDriftGuards || []).filter((guard) => visibleTaskGroupIds.has(guard.taskGroupId));
  cloned.modelSelectionDecisions = (state.modelSelectionDecisions || []).filter((decision) => visibleTaskGroupIds.has(decision.taskGroupId));
  cloned.sessionPlacementDecisions = (state.sessionPlacementDecisions || []).filter((decision) => visibleTaskGroupIds.has(decision.taskGroupId));
  cloned.roleSkillOverlays = (state.roleSkillOverlays || []).filter((overlay) =>
    (overlay.taskGroupId && visibleTaskGroupIds.has(overlay.taskGroupId)) ||
    (!overlay.taskGroupId && overlay.projectId && visibleProjectIds.has(overlay.projectId))
  );
  cloned.executionTopologies = (state.executionTopologies || []).filter((item) => visibleTaskGroupIds.has(item.taskGroupId));
  cloned.reviewPlans = (state.reviewPlans || []).filter((item) => visibleTaskGroupIds.has(item.taskGroupId));
  cloned.reviewBundles = (state.reviewBundles || []).filter((item) => visibleTaskGroupIds.has(item.taskGroupId));
  cloned.checkpoints = (state.checkpoints || []).filter((checkpoint) => visibleTaskGroupIds.has(checkpoint.taskGroupId));
  cloned.completionReadiness = (state.completionReadiness || []).filter((item) => visibleTaskGroupIds.has(item.taskGroupId));
  cloned.closeBarriers = (state.closeBarriers || []).filter((item) => visibleTaskGroupIds.has(item.taskGroupId));
  // Gate strictly on task-group visibility (like checkpoints/completionReadiness/closeBarriers);
  // only fall back to project visibility for records that carry no taskGroupId. A plain project
  // member without a task-group grant must not see a hidden task group's admission decisions.
  cloned.admissionDecisions = (state.admissionDecisions || []).filter((item) => item.taskGroupId ? visibleTaskGroupIds.has(item.taskGroupId) : visibleProjectIds.has(item.projectId));
  cloned.admissionScans = (state.admissionScans || []).filter((item) => item.taskGroupId ? visibleTaskGroupIds.has(item.taskGroupId) : visibleProjectIds.has(item.projectId));
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
    ...(item.accountId === account.accountId ? {effectivePermissions: accountEffectivePermissions(state, account)} : {}),
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
  cloned.dlqEntries = [];
  cloned.integrationBatches = [];
  cloned.idempotencyRecords = {};
  cloned.runtimeIssuePatterns = [];
  cloned.runtimeIssueSamples = [];
  cloned.systemUpgradeCandidates = [];
  cloned.agentGatewayEvents = [];
  cloned.mcpCalls = [];
  cloned.mcpProbeNodes = [];
  cloned.instructionMetrics = {
    ...state.instructionMetrics,
    envelopes: (state.instructionMetrics?.envelopes || []).filter((envelope) => envelope.taskGroupId && visibleTaskGroupIds.has(envelope.taskGroupId))
  };
  cloned.organizations = (state.organizations || []).filter((org) => org.orgId === account.organizationId);
  cloned.humanConfirmationRequests = (state.humanConfirmationRequests || []).filter((item) => visibleTaskGroupIds.has(item.taskGroupId));
  cloned.humanDirectives = (state.humanDirectives || []).filter((item) => (item.taskGroupId && visibleTaskGroupIds.has(item.taskGroupId)) || (!item.taskGroupId && visibleProjectIds.has(item.projectId)));
  cloned.transitionEvidence = [];
  cloned.ruleSourceResolutions = [];
  cloned.externalUpgradeImports = [];
  cloned.mcpGrants = (state.mcpGrants || []).filter((grant) => grant.taskGroupId && visibleTaskGroupIds.has(grant.taskGroupId));
  const visibleRoomIds = new Set([...visibleTaskGroupIds].map((taskGroupId) => `room_${taskGroupId}`));
  cloned.roomMessages = (state.roomMessages || []).filter((message) => visibleRoomIds.has(message.roomId));
  cloned.roomParticipants = (state.roomParticipants || []).filter((participant) => visibleRoomIds.has(participant.roomId));
  cloned.roomAcks = (state.roomAcks || []).filter((ack) => visibleRoomIds.has(ack.roomId));
  cloned.roomSequenceByRoom = Object.fromEntries(Object.entries(state.roomSequenceByRoom || {}).filter(([roomId]) => visibleRoomIds.has(roomId)));
  cloned.permissionRequests = (state.permissionRequests || []).filter((item) => item.taskGroupId && visibleTaskGroupIds.has(item.taskGroupId));
  cloned.approvalRequests = (state.approvalRequests || []).filter((item) => item.taskGroupId && visibleTaskGroupIds.has(item.taskGroupId));
  cloned.artifacts = (state.artifacts || []).filter((item) => item.taskGroupId && visibleTaskGroupIds.has(item.taskGroupId));
  cloned.testResults = (state.testResults || []).filter((item) => item.taskGroupId && visibleTaskGroupIds.has(item.taskGroupId));
  cloned.findings = (state.findings || []).filter((item) => item.taskGroupId && visibleTaskGroupIds.has(item.taskGroupId));
  cloned.qualityGates = (state.qualityGates || []).filter((item) => item.taskGroupId && visibleTaskGroupIds.has(item.taskGroupId));
  cloned.derivedTaskRequests = (state.derivedTaskRequests || []).filter((item) => item.taskGroupId && visibleTaskGroupIds.has(item.taskGroupId));
  cloned.eventLog = (state.eventLog || []).filter((event) => event.taskGroupId && visibleTaskGroupIds.has(event.taskGroupId));
  // fail-closed：删除白名单外的任何顶层键（防未来新增未过滤的键默认整份泄漏给租户）
  for (const key of Object.keys(cloned)) {
    if (!SCOPED_ALLOWED_TOP_KEYS.has(key)) delete cloned[key];
  }
  return cloned;
}

const scopedStateCache = new Map();

function withoutStateInternals(state) {
  const clean = {...state};
  delete clean.__loadedStateVersion;
  return clean;
}

function cachedScopedState(state, account, session) {
  const key = `${account.accountId}:${session.sessionId}:${state.stateVersion}`;
  const cached = scopedStateCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.scoped;
  const scoped = scopedStateForAccount(state, account, session);
  if (scopedStateCache.size > stateViewMaxEntries) scopedStateCache.clear();
  scopedStateCache.set(key, {scoped, expiresAt: Date.now() + stateViewCacheTtlMs});
  return scoped;
}

function stateViewForAccount(state, account, session, view = "full", limit = 80) {
  const scoped = cachedScopedState(state, account, session);
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
    progressSnapshots: sliceItems(scoped.progressSnapshots, capped),
    pendingHumanConfirmationTaskGroupIds: (scoped.humanConfirmationRequests || []).filter((item) => item.status === "pending").map((item) => item.taskGroupId),
    // Lightweight id->displayName directory (visible accounts only) so views that show a decidedBy/actor
    // account (e.g. the review answered-history) render a name instead of a raw acct_ id. scoped.accounts
    // is already filtered to visible accounts + redacted; we expose only id+displayName here.
    accountDirectory: Object.fromEntries((scoped.accounts || []).map((item) => [item.accountId, item.displayName || item.accountId]))
  };
  const viewFields = {
    system: ["accounts", "auditLog", "policyDecisions", "commands", "decisionRecords"],
    users: ["accounts", "accessGrants", "projects", "agentJoinTokens"],
    projects: ["accounts", "accessGrants", "projects", "repositoryOutputs", "agentJoinTokens"],
    tasks: ["taskGroups", "workSessions", "agentDispatches", "agentControlCommands", "agentExecutionEvents", "repositoryOutputs", "checkpoints", "completionReadiness", "closeBarriers", "progressSnapshots", "humanConfirmationRequests", "humanDirectives", "permissionRequests", "approvalRequests", "findings", "qualityGates", "testResults"],
    runtime: ["modelSelectionPolicies", "modelSelectionDecisions", "sessionPlacementDecisions", "admissionDecisions", "workerLanes", "workSessions", "agentDispatches", "agentControlCommands", "agentExecutionEvents", "agentJoinTokens", "skillSources", "roleSkills", "roleSkillOverlays"],
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
  if (action === "system_account_invite") return "system:account_admin";
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
  // Gap 2B: §4 REST endpoints over shared core mutators.
  if (["finding_submit", "finding_resolve", "approval_request_create", "approval_resolve", "review_plan_create", "review_bundle_register"].includes(action)) return "task_group:review";
  if (["work_assign", "lease_claim", "lease_release", "execution_topology_plan", "execution_topology_advance", "derived_task_classify"].includes(action)) return "task_group:orchestrate";
  if (["artifact_register", "permission_request_submit"].includes(action)) return "task_group:checkpoint_submit";
  if (["room_send", "rule_source_resolve"].includes(action)) return "task_group:control";
  if (action === "permission_resolve") return "project:grant";
  if (action === "contract_publish") return "project:*";
  if (action === "policy_decision_eval") return "system:*";
  if (action === "project_config_update") return "project:update";
  if (["org_create", "org_quota_update", "org_status_update"].includes(action)) return "system:*";
  if (["org_member_create", "org_member_permissions_update", "org_member_status_update"].includes(action)) return "org:member_admin";
  if (action === "org_project_create") return "org:project_admin";
  if (action === "human_confirmation_decide") return "task_group:review";
  if (action === "human_directive_create") return "task_group:control";
  return "system:*";
}

// Unmatchable sentinel org for a scope that names a resource which must already exist but does not resolve to
// any organization. Returning this (instead of null) makes the org-boundary gate DENY rather than skip, so a
// phantom taskGroupId cannot fail the gate open and let an org_admin's blanket task_group:* reach another tenant.
const UNRESOLVED_ORGANIZATION_SCOPE = "__unresolved_org_scope__";

function resourceScopeOrganizationId(state, resourceScope = {}) {
  if (resourceScope.resourceType === "organization") return resourceScope.resourceId;
  if (resourceScope.resourceType === "project") {
    const project = state.projects.find((item) => item.id === resourceScope.resourceId);
    return project ? project.organizationId || DEFAULT_ORGANIZATION_ID : null;
  }
  if (resourceScope.resourceType === "task_group") {
    const taskGroup = state.taskGroups.find((item) => item.id === resourceScope.resourceId);
    if (taskGroup) {
      const project = state.projects.find((item) => item.id === taskGroup.projectId);
      return project ? project.organizationId || DEFAULT_ORGANIZATION_ID : null;
    }
    if (resourceScope.projectId) {
      const scopedProject = state.projects.find((item) => item.id === resourceScope.projectId);
      if (scopedProject) return scopedProject.organizationId || DEFAULT_ORGANIZATION_ID;
    }
    // Task-group scope naming a task group that does not exist and has no resolvable project: fail closed.
    return UNRESOLVED_ORGANIZATION_SCOPE;
  }
  return null;
}

function hasPermission(state, actor, requiredPermission, resourceScope) {
  if (!requiredPermission) return true;
  const account = state.accounts.find((item) => accountIdOf(item) === actor);
  if (!account || account.status !== "active") return false;
  if (!isSystemAccount(account) && account.organizationId) {
    const resourceOrg = resourceScopeOrganizationId(state, resourceScope);
    if (resourceOrg && resourceOrg !== account.organizationId) return false;
  }
  const direct = (account.permissions || []).filter((permission) => directPermissionApplies(account, permission, requiredPermission, resourceScope));
  const grantPermissions = state.accessGrants
    .filter((grant) => grant.status === "active" && grant.subjectRef?.subjectType === "account" && grant.subjectRef?.subjectId === actor)
    .filter((grant) => grantAppliesToResource(state, grant, resourceScope))
    .flatMap((grant) => grant.permissions || []);
  return [...direct, ...grantPermissions].some((permission) => permissionMatches(permission, requiredPermission));
}

function directPermissionApplies(account, permission, requiredPermission, resourceScope = {}) {
  if (isSystemAccount(account)) return true;
  if (resourceScope.resourceType === "organization") {
    return account.organizationId === resourceScope.resourceId && permission.startsWith("org:");
  }
  // Organization admins manage every resource in their own organization; the org-boundary
  // gate in hasPermission has already confirmed the resource belongs to their organization.
  if (account.accountType === "org_admin" && ["project", "task_group"].includes(resourceScope.resourceType)) {
    return permission.startsWith("project:") || permission.startsWith("task_group:") || ["member:invite", "agent:activate"].includes(permission);
  }
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

// After an operator resolves a close-barrier blocker (permission/approval/finding), refresh the stored
// readiness + close barrier so the console reflects the unblock immediately (the "关闭任务组" button is
// gated on the stored barrier.satisfied). Best-effort — the resolve itself already succeeded.
function recomputeBarrierAfterResolve(state, taskGroupId) {
  if (!taskGroupId) return;
  try {
    computeCompletionReadiness(state, taskGroupId, {root: repositoryRoot});
    computeCloseBarrier(state, taskGroupId, {root: repositoryRoot, mutate: false});
  } catch { /* recompute is advisory; do not fail the resolve on a recompute error */ }
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
    let settled = false;
    const fail = (message, status) => {
      if (settled) return;
      settled = true;
      const error = new Error(message);
      error.status = status;
      reject(error);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        tooLarge = true;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("error", () => fail("request_stream_error", 400));
    req.on("aborted", () => fail("request_aborted", 400));
    req.on("end", () => {
      if (settled) return;
      if (tooLarge) {
        fail("request_body_too_large", 413);
        return;
      }
      settled = true;
      if (!chunks.length) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        settled = false;
        fail("request_body_invalid_json", 400);
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
  return sharedLongPoll(agentControlWaitFanout, `agent-control:${node.nodeId}:${options.afterSequence || 0}:${options.limit || 20}:${options.waitMs || 0}`, () => waitForAgentControlCommandsDirect(node, options));
}

async function waitForAgentControlCommandsDirect(node, options = {}) {
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
    await waitForLongPollSignal([`agent-control:${node.nodeId}`], Math.max(1, deadline - Date.now()));
    latest = readState();
  }
}

async function waitForProjectExecutionEvents(projectId, options = {}) {
  return sharedLongPoll(projectExecutionWaitFanout, `project-events:${projectId}:${options.afterSequence || 0}:${options.dispatchId || ""}:${options.taskGroupId || ""}:${options.sessionId || ""}:${options.limit || 120}:${options.waitMs || 0}`, () => waitForProjectExecutionEventsDirect(projectId, options));
}

async function waitForProjectExecutionEventsDirect(projectId, options = {}) {
  const deadline = Date.now() + Math.max(0, Math.min(30000, Number(options.waitMs || 0)));
  for (;;) {
    const result = readProjectExecutionEvents(runtimeDir, projectId, options);
    if (result.events.length || Date.now() >= deadline) return result;
    await waitForLongPollSignal([`project-events:${projectId}`], Math.max(1, deadline - Date.now()));
  }
}

async function sharedLongPoll(cache, key, producer) {
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = (async () => producer())();
  cache.set(key, pending);
  try {
    return await pending;
  } finally {
    if (cache.get(key) === pending) cache.delete(key);
  }
}

function waitForLongPollSignal(keys, timeoutMs) {
  return new Promise((resolveSignal) => {
    let settled = false;
    const cleanup = () => {
      for (const key of keys) {
        const waiters = longPollWaiters.get(key);
        if (!waiters) continue;
        waiters.delete(resolveOnce);
        if (!waiters.size) longPollWaiters.delete(key);
      }
      clearTimeout(timer);
    };
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveSignal();
    };
    const timer = setTimeout(resolveOnce, Math.max(1, timeoutMs));
    for (const key of keys) {
      if (!longPollWaiters.has(key)) longPollWaiters.set(key, new Set());
      longPollWaiters.get(key).add(resolveOnce);
    }
  });
}

function notifyLongPollWaiters(key) {
  pushRealtime(key);
  const waiters = longPollWaiters.get(key);
  if (!waiters?.size) return;
  longPollWaiters.delete(key);
  for (const resolveWaiter of waiters) resolveWaiter();
}

// Push a lightweight wake frame to every WS client subscribed to this channel. Signal only —
// no data — so the delivery path carries no tenant-visible content; subscribing to a channel is
// authorized at subscribe time and the client re-fetches scoped data itself.
function pushRealtime(key) {
  if (!realtimeClients.size) return;
  const frame = JSON.stringify({event: "wake", channel: key, at: new Date().toISOString()});
  for (const client of realtimeClients) {
    if (client.readyState === client.OPEN && client.subscriptions?.has(key)) {
      try {
        client.send(frame);
      } catch {
        realtimeClients.delete(client);
      }
    }
  }
}

function retryExecutionEventProjection(req, body) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = readState();
    const latestNode = authenticateAgentNode(latest, bearerToken(req));
    if (!latestNode) return {ok: false, error: "agent_node_auth_required"};
    try {
      const dispatch = (latest.agentDispatches || []).find((item) => item.dispatchId === body.dispatchId);
      if (!dispatch) return {ok: false, error: "dispatch_not_found"};
      const storedEvent = body.eventKey ? readProjectExecutionEventByKey(runtimeDir, dispatch.projectId, body.eventKey) : null;
      if (storedEvent && storedEvent.nodeId !== latestNode.nodeId) return {ok: false, error: "event_node_binding_mismatch"};
      const prepared = storedEvent ? null : prepareAgentExecutionEvent(latest, latestNode, body);
      const storage = storedEvent
        ? {...projectExecutionEventStorageInfo(dispatch.projectId), replayedProjection: true, duplicate: true, event: storedEvent}
        : appendProjectExecutionEvent(runtimeDir, prepared.event);
      if (storage.event && !storage.duplicate) notifyLongPollWaiters(`project-events:${storage.event.projectId}`);
      const result = recordAgentExecutionEvent(latest, latestNode, storage.event || storedEvent || prepared.event, {allowHistoricalNodeBinding: Boolean(storedEvent || storage.duplicate)});
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
      if (session && ["needs_decision", "waiting_dependency", "stale_state"].includes(session.status)) {
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
  if (dispatch.blockedReason === "awaiting_human_confirmation") cancelPendingConfirmationsForDispatch(state, dispatch.dispatchId, reason);
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
    session.status = commandType === "cancel_dispatch" ? "aborted" : "needs_decision";
    session.blockedReason = commandType === "cancel_dispatch" ? session.blockedReason : reason;
    session.updatedAt = at;
  }
  const taskGroup = state.taskGroups.find((item) => item.id === dispatch.taskGroupId);
  const workItem = taskGroup?.workItems?.find((item) => item.id === dispatch.workItemId);
  if (workItem) {
    workItem.status = "needs_decision";
    workItem.blockedReason = reason;
    workItem.updatedAt = at;
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function prepareRemoteGitVerification(target, checkpointInput) {
  // Fail-closed on untrusted git input: a repository output target is tenant-controlled, so an
  // unvalidated repositoryUrl reaching `git fetch` on the shared control-plane host is remote code
  // execution (ext::/fd: transports) or SSRF. Mirror the agent-runtime hardening: validate the URL,
  // restrict transports via GIT_ALLOW_PROTOCOL, disable prompts, constrain branch/commit and use a
  // `--` end-of-options separator so no value can be parsed as a git option.
  if (!isSafeGitRemoteUrl(target.repositoryUrl)) {
    const error = new Error("repository_output_target_unsafe_repository_url");
    error.status = 400;
    throw error;
  }
  // ext::/fd:/remote-helper transports (RCE) are always rejected above. file://+local paths are
  // permitted by default (local deployments and the doctor use them and they cannot execute
  // commands), but a hosted multi-tenant deployment can forbid them — they would let a tenant-set
  // repositoryUrl make the shared host git-fetch arbitrary local repos — by setting
  // AIMAC_ALLOW_LOCAL_GIT_REMOTE=false.
  if (process.env.AIMAC_ALLOW_LOCAL_GIT_REMOTE === "false") {
    const url = String(target.repositoryUrl || "");
    if (/^file:\/\//iu.test(url) || url.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(url) || url.startsWith("./") || url.startsWith("../")) {
      const error = new Error("repository_output_target_local_git_remote_disabled");
      error.status = 400;
      throw error;
    }
  }
  const branch = String(target.branch || "main");
  if (!/^[A-Za-z0-9._\/-]+$/u.test(branch) || branch.startsWith("-") || branch.includes("..")) {
    const error = new Error("repository_output_target_unsafe_branch");
    error.status = 400;
    throw error;
  }
  const remote = target.remote || "origin";
  if (!/^[A-Za-z0-9._-]+$/u.test(remote) || remote.startsWith("-")) {
    const error = new Error("repository_output_target_unsafe_remote");
    error.status = 400;
    throw error;
  }
  const gitEnv = {...process.env, GIT_ALLOW_PROTOCOL: "file:https:ssh:git", GIT_TERMINAL_PROMPT: "0"};
  const git = (args) => execFileAsync("git", args, {env: gitEnv});
  const safeTargetId = String(target.targetId).replace(/[^A-Za-z0-9._-]+/gu, "_");
  const verificationRoot = join(runtimeDir, "git-verification", `${safeTargetId}.git`);
  mkdirSync(dirname(verificationRoot), {recursive: true});
  if (!existsSync(join(verificationRoot, "HEAD"))) await git(["init", "--bare", verificationRoot]);
  const remotes = (await git(["-C", verificationRoot, "remote"])).stdout.trim().split("\n").filter(Boolean);
  if (remotes.includes(remote)) await git(["-C", verificationRoot, "remote", "set-url", remote, "--", target.repositoryUrl]);
  else await git(["-C", verificationRoot, "remote", "add", remote, "--", target.repositoryUrl]);
  await git(["-C", verificationRoot, "fetch", "--force", "--no-tags", remote, "--", `refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
  for (const commitRef of checkpointInput.commitRefs || []) {
    const commit = String(commitRef.commit || "");
    // Only accept hex commit ids; anything else could be a git option or a crafted ref.
    if (!/^[0-9a-fA-F]{7,64}$/u.test(commit)) continue;
    try {
      await git(["-C", verificationRoot, "cat-file", "-e", `${commit}^{commit}`]);
    } catch {
      await git(["-C", verificationRoot, "fetch", "--force", "--no-tags", remote, "--", commit]);
    }
  }
  return verificationRoot;
}

const staticFileCache = new Map();

function serveStatic(req, res, pathname) {
  let requested = pathname === "/" ? "/index.html" : pathname;
  try {
    requested = decodeURIComponent(requested);
  } catch {
    res.writeHead(400, {"content-type": "text/plain; charset=utf-8"});
    res.end("Bad request");
    return;
  }
  const target = normalize(join(publicDir, requested));
  if ((target !== publicDir && !target.startsWith(`${publicDir}/`)) || !existsSync(target)) {
    res.writeHead(404, {"content-type": "text/plain; charset=utf-8"});
    res.end("Not found");
    return;
  }
  const stat = statSync(target);
  if (!stat.isFile()) {
    res.writeHead(404, {"content-type": "text/plain; charset=utf-8"});
    res.end("Not found");
    return;
  }
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  let cached = staticFileCache.get(target);
  if (!cached || cached.stamp !== stamp) {
    cached = {stamp, content: readFileSync(target)};
    if (staticFileCache.size > 64) staticFileCache.clear();
    staticFileCache.set(target, cached);
  }
  const content = cached.content;
  res.writeHead(200, {"content-type": mimeTypes[extname(target)] || "application/octet-stream", "x-content-type-options": "nosniff"});
  res.end(content);
}

const execFileAsync = promisify(execFile);

async function handleApi(req, res) {
  const url = new URL(req.url, "http://request.local");
  if (req.method === "GET" && ["/api/health", "/api/runtime/health"].includes(url.pathname)) {
    const state = readHealthState();
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

  const state = readState();
  const body = req.method === "POST" ? await parseBody(req) : {};
  req.bodyDigest = digestOf(body);

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
    if (result.persistRequired !== false) commitGatewayWrite(state);
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
    if (!String(body.eventKey || "").trim()) return json(res, 400, {error: "execution_event_key_required"});
    let prepared;
    try {
      prepared = prepareAgentExecutionEvent(state, node, body);
    } catch (error) {
      const historicalDispatch = (state.agentDispatches || []).find((item) => item.dispatchId === body.dispatchId);
      const historicalEvent = historicalDispatch && body.eventKey ? readProjectExecutionEventByKey(runtimeDir, historicalDispatch.projectId, body.eventKey) : null;
      if (!historicalEvent || historicalEvent.nodeId !== node.nodeId) throw error;
      prepared = {event: historicalEvent, duplicate: true, historical: true};
    }
    const storage = prepared.duplicate
      ? {...projectExecutionEventStorageInfo(prepared.event.projectId), duplicate: true, replayedProjection: Boolean(prepared.historical), event: prepared.event}
      : appendProjectExecutionEvent(runtimeDir, prepared.event);
    if (storage.event && !storage.duplicate) notifyLongPollWaiters(`project-events:${storage.event.projectId}`);
    const result = recordAgentExecutionEvent(state, node, storage.event || prepared.event, {allowHistoricalNodeBinding: Boolean(prepared.historical || storage.duplicate)});
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
    const verificationRoot = await prepareRemoteGitVerification(target, body);
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
    // Terminal-state guard (symmetric with the checkpoint route): a late/retried /fail must not corrupt
    // an already-finished dispatch. A /fail against a COMPLETED (successfully checkpointed, possibly
    // reviewed) dispatch is a real conflict; a repeat of the same non-success outcome acks idempotently.
    if (["completed", "failed", "cancelled"].includes(dispatch.status)) {
      if (dispatch.status === "completed") return json(res, 409, {error: "dispatch_already_completed"});
      return json(res, 200, {ok: true, replayed: true, dispatchId: dispatch.dispatchId, status: dispatch.status});
    }
    const reportedStatus = ["blocked", "cancelled"].includes(body.status) ? body.status : "failed";
    if (dispatch.blockedReason === "awaiting_human_confirmation" && reportedStatus !== "blocked") {
      cancelPendingConfirmationsForDispatch(state, dispatch.dispatchId, `dispatch_${reportedStatus}`);
    }
    const session = state.workSessions.find((item) => item.sessionId === dispatch.sessionId);
    // A /fail(blocked) that arrives while the session is still permission_required is a permission-poll
    // TIMEOUT: mark the dispatch so the (still-pending) permission-resolve lever can find and requeue or
    // terminalize it later. Without a marker the blocked, node-detached dispatch is orphaned and wedges
    // the close barrier — the operator's approval/denial would be a no-op.
    const permissionTimedOut = reportedStatus === "blocked" && session?.status === "permission_required";
    dispatch.status = reportedStatus;
    if (permissionTimedOut && !dispatch.blockedReason) dispatch.blockedReason = "permission_request_pending";
    dispatch.failureReason = String(body.reason || "agent_runtime_failure").slice(0, 2000);
    dispatch.updatedAt = now();
    if (session) {
      session.status = reportedStatus === "blocked" ? "needs_decision" : reportedStatus === "cancelled" ? "aborted" : "failed";
      if (reportedStatus === "blocked") session.blockedReason = dispatch.blockedReason || session.blockedReason;
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
    if (loginRateLimited(req)) {
      json(res, 429, {error: "too_many_login_attempts", retryAfterSeconds: 60});
      return;
    }
    const config = readRuntimeConfig();
    const token = String(body.token || body.accountToken || body.bootstrapToken || "");
    const email = String(body.email || "");
    const account = state.accounts.find((item) => item.email === email || item.accountId === email);
    const method = account?.authPolicy?.method;
    const bootstrapOk = method === "bootstrap_token" && digestOf(`bootstrap:${token}`) === config.bootstrapTokenHash;
    const localAccountOk = Boolean(account && config.localAccountTokenHashes?.[account.accountId] === digestOf(`account:${account.accountId}:${token}`));
    const issuedAccountOk = Boolean(account?.status === "invited" && account?.credentialDigest && account.credentialDigest === digestOf(`account-invite:${account.accountId}:${token}`) && (!account.credentialExpiresAt || new Date(account.credentialExpiresAt).getTime() > Date.now()));
    const passwordOk = Boolean(account?.passwordDigest && body.password && account.passwordDigest === digestOf(`account-password:${account.accountId}:${body.password}`));
    const tokenOk = bootstrapOk || localAccountOk || issuedAccountOk || passwordOk;
    if (!tokenOk || !account || !["active", "invited"].includes(account.status)) {
      audit(state, "auth-service", "auth_login", `Account:${email}`, "denied");
      commitDirectStateWrite(state);
      recordFailedLogin(req);
      json(res, 401, {error: "invalid_credentials"});
      return;
    }
    if (account.status === "invited" && issuedAccountOk) {
      account.status = "active";
      account.activatedAt = now();
      account.credentialConsumedAt = now();
      account.credentialExpiresAt = account.credentialConsumedAt;
      delete account.credentialDigest;
      account.updatedAt = now();
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
    // Prune EXPIRED/non-active sessions first (never evict a live session — a flat count cap would
    // force-logout an active session belonging to any other tenant/admin once concurrency exceeds it).
    // Keep all still-active sessions; only if active sessions themselves exceed a high bound do we drop
    // the oldest active ones (last resort against a runaway).
    const nowMs = Date.now();
    const liveSessions = state.authSessions.filter((item) => item.status === "active" && new Date(item.expiresAt || 0).getTime() > nowMs);
    const activeCap = Math.max(200, Number(process.env.AIMAC_ACTIVE_SESSION_CAP || 5000));
    state.authSessions = liveSessions.slice(0, activeCap);
    audit(state, "auth-service", "auth_login", `Account:${account.accountId}`);
    commitDirectStateWrite(state);
	    json(res, 200, {sessionToken, expiresAt, account: {accountId: account.accountId, accountType: account.accountType, organizationId: account.organizationId || null, defaultProjectId: account.defaultProjectId || null, email: account.email, displayName: account.displayName, roles: account.roles, permissions: account.permissions, effectivePermissions: accountEffectivePermissions(state, account), passwordSet: Boolean(account.authPolicy?.passwordSet)}});
	    return;
	  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const session = authenticateRequest(req, state);
    if (session) {
      session.status = "revoked";
      session.revokedAt = now();
      session.updatedAt = session.revokedAt;
      audit(state, "auth-service", "auth_logout", `Account:${session.accountId}`);
      commitDirectStateWrite(state);
    }
    json(res, 200, {ok: true});
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
    const scoped = cachedScopedState(state, reader.account, reader.session);
    json(res, 200, {
      modelCapabilities: scoped.modelCapabilities,
      modelSelectionPolicies: scoped.modelSelectionPolicies,
      modelSelectionDecisions: (scoped.modelSelectionDecisions || []).slice(0, 40)
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/skill-registry") {
    const reader = accountFromRequest(req, state);
    if (!reader) {
      json(res, 401, {error: "auth_required"});
      return;
    }
    const scoped = cachedScopedState(state, reader.account, reader.session);
    json(res, 200, {
      skillSources: scoped.skillSources,
      roleSkills: scoped.roleSkills,
      roleSkillOverlays: scoped.roleSkillOverlays
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/progress-snapshots") {
    const reader = accountFromRequest(req, state);
    if (!reader) {
      json(res, 401, {error: "auth_required"});
      return;
    }
    json(res, 200, {progressSnapshots: cachedScopedState(state, reader.account, reader.session).progressSnapshots});
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent-nodes") {
    const reader = accountFromRequest(req, state);
    if (!reader) return json(res, 401, {error: "auth_required"});
    const visible = isSystemAccount(reader.account)
      ? state.agentRuntimeNodes
      : state.agentRuntimeNodes.filter((nodeItem) => (nodeItem.projectIds || []).some((projectId) => canReadProject(state, reader.account, projectId)));
    json(res, 200, {agentRuntimeNodes: visible.map(publicAgentNode)});
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent-join-tokens") {
    const reader = accountFromRequest(req, state);
    if (!reader) return json(res, 401, {error: "auth_required"});
    const projectId = url.searchParams.get("projectId") || undefined;
    const tokens = listAgentJoinTokens(state, projectId).filter((token) => isSystemAccount(reader.account) || canReadProject(state, reader.account, token.projectId));
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
    // A dispatch-scoped control command must target a dispatch actually bound to THIS node. Rejecting a
    // mismatch both closes an intra-org scope-looseness (the guard is keyed on the dispatch's task group,
    // so a foreign dispatch could authorize a command to an unrelated node) and prevents a no-op command.
    if (["pause_dispatch", "cancel_dispatch", "resume_dispatch"].includes(commandType) && targetDispatch && targetDispatch.assignedNodeId !== targetNode.nodeId) {
      return json(res, 409, {error: "dispatch_not_assigned_to_node"});
    }
    // resume_dispatch may only revive a BLOCKED (paused / permission-held) dispatch. Resuming a dispatch
    // that is still `running` would requeue it (assignment cleared) while the node keeps executing, so a
    // second node re-claims and re-runs the same runId → double execution + an orphaned push. Reject it.
    if (commandType === "resume_dispatch" && targetDispatch && targetDispatch.status !== "blocked") {
      return json(res, 409, {error: "dispatch_not_resumable", reason: `cannot resume a ${targetDispatch.status} dispatch`});
    }
    const taskScopedControl = ["pause_dispatch", "cancel_dispatch", "resume_dispatch"].includes(commandType) && targetDispatch;
    const projectId = targetNode.projectIds?.[0];
    const guard = taskScopedControl
      ? beginGuardedWrite(req, state, "task_group_agent_control_command_create", `TaskGroup:${targetDispatch.taskGroupId}`, taskGroupScope(state, targetDispatch.taskGroupId))
      : beginGuardedWrite(req, state, "agent_control_command_create", `AgentRuntimeNode:${targetNode.nodeId}`, projectScope(projectId));
    if (guard.status) return json(res, guard.status, guard.payload);
    // Defense in depth: the command's visibility is keyed on nodeId, but the task-scoped branch guards only the
    // dispatch's task group. Independently confirm the target node's project is within the actor's organization,
    // so this endpoint also satisfies the "guard covers the visibility-keying field" invariant even if a future
    // change persisted the command before the node-ownership pre-effect check.
    const controlActor = state.accounts.find((item) => accountIdOf(item) === guard.actor);
    const targetNodeOrg = resourceScopeOrganizationId(state, projectScope(projectId));
    if (controlActor && !isSystemAccount(controlActor) && controlActor.organizationId && targetNodeOrg && targetNodeOrg !== controlActor.organizationId) {
      return json(res, 403, {error: "policy_denied", reason: "target_node_out_of_organization"});
    }
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
    const readOnlyState = structuredClone(withoutStateInternals(state));
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
      languagePolicy: taskGroup.languagePolicy,
      roles: taskGroup.roles,
      taskAnalysis: taskGroup.taskAnalysis || null,
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

  const sessionEventsMatch = url.pathname.match(/^\/api\/work-sessions\/([^/]+)\/execution-events$/);
  if (req.method === "GET" && sessionEventsMatch) {
    const session = state.workSessions.find((item) => item.sessionId === sessionEventsMatch[1]);
    if (!session) return json(res, 404, {error: "work_session_not_found"});
    const reader = requireRead(req, state, taskGroupScope(state, session.taskGroupId));
    if (reader.status) return json(res, reader.status, reader.payload);
    const taskGroup = state.taskGroups.find((item) => item.id === session.taskGroupId);
    const result = await waitForProjectExecutionEvents(taskGroup?.projectId || session.projectId || "prj_control_plane", {
      sessionId: session.sessionId,
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
    // A real close mutates the task group to terminal; refresh the project/task-group progress rollup so
    // the overview reflects it immediately instead of lagging until the next autonomy cycle.
    if (body.mutate === true && closeBarrier.satisfied) computeProgressSnapshots(state);
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
    // Guard on the SAME task group the overlay will be stamped with (registerRoleSkillOverlay stamps
    // taskGroupId when scope === "task_group" OR a taskGroupId is supplied, defaulting to tg_runtime_management),
    // so a task_group-scoped overlay with no explicit taskGroupId cannot slip through a project-only guard and
    // inject into the default tenant's view.
    const overlayScopesTaskGroup = body.scope === "task_group" || Boolean(body.taskGroupId);
    const overlayGuardScope = overlayScopesTaskGroup
      ? taskGroupScope(state, body.taskGroupId || "tg_runtime_management")
      : projectScope(body.projectId || "prj_control_plane");
    const guard = beginGuardedWrite(req, state, "role_skill_overlay_create", `AgentRoleSkill:${body.roleSkillRef || "default"}`, overlayGuardScope);
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
    const authenticated = accountFromRequest(req, state);
    if (!authenticated) {
      json(res, 401, {error: "auth_required"});
      return;
    }
    if (!req.headers["idempotency-key"]) {
      json(res, 428, {error: "idempotency_key_required"});
      return;
    }
    const authenticatedAccountId = accountIdOf(authenticated.account);
    const requestedOwnerAccountId = String(body.ownerAccountId || authenticatedAccountId || "").trim() || authenticatedAccountId;
    if (requestedOwnerAccountId !== authenticatedAccountId && !isSystemAccount(authenticated.account)) {
      json(res, 403, {error: "project_owner_assignment_denied"});
      return;
    }
    const ownerAccount = state.accounts.find((item) => accountIdOf(item) === requestedOwnerAccountId && ["active", "invited"].includes(item.status));
    if (!ownerAccount) {
      json(res, 404, {error: "owner_account_not_found"});
      return;
    }
    const guard = beginGuardedWrite(req, state, "project_create", "Project:new", {resourceType: "project", resourceId: "new"});
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const projectOrgId = ownerAccount.organizationId || authenticated.account.organizationId || DEFAULT_ORGANIZATION_ID;
    const projectQuota = organizationQuotaCheck(state, projectOrgId, "projects");
    if (!projectQuota.allowed) {
      json(res, 409, {error: projectQuota.error, quota: projectQuota.quota, usage: projectQuota.usage});
      return;
    }
    const id = createId("prj");
    const ownerAccountId = requestedOwnerAccountId;
    state.projects.push({
      id,
      organizationId: projectOrgId,
      name: body.name || "Untitled Project",
      status: "active",
      ownerAccountId,
      members: [{accountId: ownerAccountId, role: "project_owner"}],
      progress: {percent: 0, phase: "intake", health: "ok", openTaskGroups: 0, blockedItems: 0, updatedAt: now()}
    });
    const project = state.projects.at(-1);
    const ownerGrant = ensureProjectOwnerGrant(state, project, ownerAccountId, guard.policyDecision.id, `audit:${guard.idempotencyKey}`);
    computeProgressSnapshots(state);
    audit(state, guard.actor, "project_create", `Project:${id}`);
    const result = {id, ownerGrant};
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/task-groups") {
    const authenticated = accountFromRequest(req, state);
    if (!authenticated) {
      json(res, 401, {error: "auth_required"});
      return;
    }
    if (!req.headers["idempotency-key"]) {
      json(res, 428, {error: "idempotency_key_required"});
      return;
    }
    const projectId = String(body.projectId || "").trim();
    if (!projectId) {
      json(res, 400, {error: "project_id_required"});
      return;
    }
    if (!state.projects.some((item) => item.id === projectId)) {
      json(res, 404, {error: "project_not_found"});
      return;
    }
    const guard = beginGuardedWrite(req, state, "task_group_create", `Project:${projectId}`, projectScope(projectId));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const taskGroupProject = state.projects.find((item) => item.id === projectId);
    const taskGroupQuota = organizationQuotaCheck(state, taskGroupProject?.organizationId || DEFAULT_ORGANIZATION_ID, "taskGroups");
    if (!taskGroupQuota.allowed) {
      json(res, 409, {error: taskGroupQuota.error, quota: taskGroupQuota.quota, usage: taskGroupQuota.usage});
      return;
    }
    const result = createTaskGroupRecord(state, body, {auditRef: `audit:${guard.idempotencyKey}`});
    if (result.ok === false) {
      json(res, result.status || 409, {error: result.error});
      return;
    }
    audit(state, "ui-console-service", "task_group_create", `TaskGroup:${result.taskGroup.id}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  const workItemCreateMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/work-items$/);
  if (req.method === "POST" && workItemCreateMatch) {
    const authenticated = accountFromRequest(req, state);
    if (!authenticated) {
      json(res, 401, {error: "auth_required"});
      return;
    }
    if (!req.headers["idempotency-key"]) {
      json(res, 428, {error: "idempotency_key_required"});
      return;
    }
    const guard = beginGuardedWrite(req, state, "task_group_work_item_create", `TaskGroup:${workItemCreateMatch[1]}`, taskGroupScope(state, workItemCreateMatch[1]));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const taskGroup = state.taskGroups.find((item) => item.id === workItemCreateMatch[1]);
    if (!taskGroup) {
      json(res, 404, {error: "task_group_not_found"});
      return;
    }
    const result = createWorkItemRecord(state, taskGroup.id, body, {auditRef: `audit:${guard.idempotencyKey}`});
    if (result.ok === false) {
      json(res, result.status || 409, {error: result.error});
      return;
    }
    audit(state, "ui-console-service", "task_group_work_item_create", `WorkItem:${taskGroup.id}:${result.workItem.id}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  const memberMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/members$/);
  if (req.method === "POST" && memberMatch) {
    const authenticated = accountFromRequest(req, state);
    if (!authenticated) {
      json(res, 401, {error: "auth_required"});
      return;
    }
    if (!req.headers["idempotency-key"]) {
      json(res, 428, {error: "idempotency_key_required"});
      return;
    }
    const project = state.projects.find((item) => item.id === memberMatch[1]);
    if (!project) {
      json(res, 404, {error: "project_not_found"});
      return;
    }
    const accountId = body.accountId;
    const inviteeAccount = state.accounts.find((account) => accountIdOf(account) === accountId);
    if (!inviteeAccount) {
      json(res, 400, {error: "account_not_found"});
      return;
    }
    if (inviteeAccount.organizationId && (project.organizationId || DEFAULT_ORGANIZATION_ID) !== inviteeAccount.organizationId) {
      json(res, 400, {error: "cross_org_member_not_allowed"});
      return;
    }
    const guard = beginGuardedWrite(req, state, "project_member_grant", `Project:${project.id}`, projectScope(project.id));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const sanitizedGrant = sanitizeGrantRequest(state, guard.actor, {...body, resourceType: "project", resourceId: project.id}, projectScope(project.id));
    if (!sanitizedGrant.ok) {
      json(res, sanitizedGrant.status, {error: sanitizedGrant.error, permissions: sanitizedGrant.permissions});
      return;
    }
    project.members = project.members.filter((member) => member.accountId !== accountId);
    project.members.push({accountId, role: sanitizedGrant.role});
    state.accessGrants.push({
      schemaVersion: "access-control-grant/v1",
      grantId: createId("grant"),
      subjectRef: {subjectType: "account", subjectId: accountId},
      resource: sanitizedGrant.resource,
      role: sanitizedGrant.role,
      permissions: sanitizedGrant.permissions,
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
      organizationId: (body.projectId ? state.projects.find((item) => item.id === body.projectId)?.organizationId : null)
        || accountFromRequest(req, state)?.account?.organizationId
        || DEFAULT_ORGANIZATION_ID,
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

  const taskGroupLanguageMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/language-policy$/);
  if (req.method === "POST" && taskGroupLanguageMatch) {
    const taskGroupId = taskGroupLanguageMatch[1];
    const guard = beginGuardedWrite(req, state, "task_group_language_policy_update", `TaskGroup:${taskGroupId}`, taskGroupScope(state, taskGroupId));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const taskGroup = state.taskGroups.find((item) => item.id === taskGroupId);
    if (!taskGroup) {
      json(res, 404, {error: "task_group_not_found"});
      return;
    }
    const result = updateTaskGroupLanguagePolicy(state, taskGroup.id, body, {actor: guard.actor, idempotencyKey: guard.idempotencyKey});
    audit(state, "ui-console-service", "task_group_language_policy_update", `TaskGroup:${taskGroup.id}`);
    finishGuardedWrite(state, guard, 200, result);
    writeState(state);
    json(res, 200, result);
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
    const systemScopedInvite = requestedSystemAccountInvite(body);
    const guard = beginGuardedWrite(
      req,
      state,
      systemScopedInvite ? "system_account_invite" : "account_invite",
      "Account:new",
      systemScopedInvite ? {resourceType: "system", resourceId: "accounts"} : {resourceType: "project", resourceId: body.projectId || "prj_control_plane"}
    );
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    let invitedAccount;
    try {
      invitedAccount = normalizeInvitedAccount(body, systemScopedInvite);
    } catch (error) {
      json(res, 400, {error: error.message});
      return;
    }
    // Email must be unique: /api/auth/login resolves an account by the FIRST email match, so a second
    // account sharing an explicit email would be unreachable via the email+token flow the invite
    // response hands back. Reject the collision (login-by-accountId is unaffected).
    if (body.email && (state.accounts || []).some((item) => item.email === String(body.email))) {
      json(res, 409, {error: "account_email_already_registered"});
      return;
    }
    const inviterAccount = state.accounts.find((item) => accountIdOf(item) === guard.actor);
    const inviteOrgId = invitedAccount.accountType === "system_admin"
      ? null
      : (inviterAccount?.organizationId || DEFAULT_ORGANIZATION_ID);
    if (inviteOrgId) {
      const inviteQuota = organizationQuotaCheck(state, inviteOrgId, "members");
      if (!inviteQuota.allowed) {
        json(res, 409, {error: inviteQuota.error, quota: inviteQuota.quota, usage: inviteQuota.usage});
        return;
      }
    }
    const at = now();
    const accountId = createId("acct");
    const accountToken = `aimac_account_${randomBytes(32).toString("base64url")}`;
    const account = {
      schemaVersion: "account/v1",
      accountId,
      accountType: invitedAccount.accountType,
      ...(inviteOrgId ? {organizationId: inviteOrgId} : {}),
      displayName: body.displayName || "New User",
      email: body.email || `user-${Date.now()}@local`,
      status: "invited",
      roles: invitedAccount.roles,
      permissions: invitedAccount.permissions,
      authPolicy: {method: "invite_token", mfaRequired: false, passwordSet: false, sessionTtlSeconds: 3600},
      credentialDigest: digestOf(`account-invite:${accountId}:${accountToken}`),
      credentialIssuedAt: at,
      credentialExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      auditRef: `audit:${guard.idempotencyKey}`,
      createdAt: at,
      updatedAt: at
    };
    state.accounts.push(account);
    audit(state, "ui-console-service", "account_invite", `Account:${account.accountId}`);
    const publicAccount = publicAccountRecord(account);
    finishGuardedWrite(state, guard, 201, publicAccount);
    writeState(state);
    json(res, 201, {
      account: publicAccount,
      accountToken,
      tokenExpiresAt: account.credentialExpiresAt,
      login: {email: account.email, tokenField: "accountToken"}
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/access-grants") {
    const resourceScope = {resourceType: body.resourceType || "project", resourceId: body.resourceId || "prj_control_plane"};
    const guard = beginGuardedWrite(req, state, "access_grant_create", `${resourceScope.resourceType}:${resourceScope.resourceId}`, resourceScope);
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const sanitizedGrant = sanitizeGrantRequest(state, guard.actor, body, resourceScope);
    if (!sanitizedGrant.ok) {
      json(res, sanitizedGrant.status, {error: sanitizedGrant.error, permissions: sanitizedGrant.permissions});
      return;
    }
    const at = now();
    const grant = {
      schemaVersion: "access-control-grant/v1",
      grantId: createId("grant"),
      subjectRef: {subjectType: "account", subjectId: body.subjectId || "acct_workspace_owner"},
      resource: sanitizedGrant.resource,
      role: sanitizedGrant.role,
      permissions: sanitizedGrant.permissions,
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
    const envelopeTaskGroup = state.taskGroups.find((item) => item.id === (body.taskGroupId || "tg_runtime_management"));
    const envelopeLanguagePolicy = normalizeTaskGroupLanguagePolicy(body.languagePolicy || envelopeTaskGroup?.languagePolicy || {});
    const envelopeLanguagePolicyDigest = digestOf(envelopeLanguagePolicy);
    const envelope = {
      schemaVersion: "instruction-envelope/v1",
      envelopeId: createId("env"),
      taskGroupId: body.taskGroupId || "tg_runtime_management",
      recipientRole: body.recipientRole || "orchestrator",
      effectiveInstructionPacketRef: body.effectiveInstructionPacketRef || "eip_runtime_management",
      formatVersion: "ai-native-instruction-envelope/v1",
      stablePrefixDigest: body.stablePrefixDigest || stableDigest("6"),
      digestRefs: [...new Set([...(body.digestRefs || ["ruleset:runtime:v1"]), `language-policy:${envelopeLanguagePolicyDigest}`])],
      languagePolicy: envelopeLanguagePolicy,
      languagePolicyDigest: envelopeLanguagePolicyDigest,
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
    const definitionProjectId = body.projectId || "prj_control_plane";
    const definitionOrg = resourceScopeOrganizationId(state, {resourceType: "project", resourceId: definitionProjectId});
    // Drop any TaskGroup scopeRef outside the definition's own organization: the write is guarded only on the
    // definition's project, and the console shows a shared definition to anyone who can see a scopeRef task
    // group (server.mjs ~953), so an unconstrained cross-org scopeRef would inject it into another tenant's view.
    const sanitizedScopeRefs = (Array.isArray(body.scopeRefs) && body.scopeRefs.length ? body.scopeRefs : ["Project"]).filter((ref) => {
      const value = String(ref);
      if (!value.startsWith("TaskGroup:")) return true;
      const taskGroup = state.taskGroups.find((item) => item.id === value.slice("TaskGroup:".length));
      return taskGroup && resourceScopeOrganizationId(state, {resourceType: "task_group", resourceId: taskGroup.id}) === definitionOrg;
    });
    const definition = {
      schemaVersion: "shared-definition-contract/v1",
      contractId: createId("sdc"),
      projectId: definitionProjectId,
      definitionType: body.definitionType || "terminology",
      scopeRefs: sanitizedScopeRefs.length ? sanitizedScopeRefs : ["Project"],
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
    // Fail-closed at write time on an unsafe git URL so a malicious remote can never be persisted
    // (defense in depth alongside prepareRemoteGitVerification's read-time check).
    if (body.repositoryUrl && !isSafeGitRemoteUrl(body.repositoryUrl)) {
      json(res, 400, {error: "repository_output_target_unsafe_repository_url"});
      return;
    }
    const guard = beginGuardedWrite(req, state, "repository_output_target_select", "RepositoryOutputTarget:new", taskGroupScope(state, body.taskGroupId || "tg_runtime_management"));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const at = now();
    const remote = body.remote || "origin";
    // Derive the target's project from its task group (the guarded scope), never a free body.projectId, so the
    // stored projectId cannot contradict the taskGroupId the write was authorized against.
    const targetTaskGroupId = body.taskGroupId || "tg_runtime_management";
    const targetTaskGroup = state.taskGroups.find((item) => item.id === targetTaskGroupId);
    const targetProjectId = targetTaskGroup?.projectId || body.projectId || "prj_control_plane";
    const project = state.projects.find((item) => item.id === targetProjectId);
    const repository = (project?.repositories || []).find((item) => item.id === body.repositoryId) || project?.repositories?.[0];
    const target = {
      schemaVersion: "repository-output-target/v1",
      targetId: createId("rot"),
      projectId: targetProjectId,
      taskGroupId: targetTaskGroupId,
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

  // ── Gap 2B: §4 REST endpoints over shared core mutators ─────────────────────
  const workItemAssignMatch = url.pathname.match(/^\/api\/work-items\/([^/]+)\/assign$/);
  if (req.method === "POST" && workItemAssignMatch) {
    const guard = beginGuardedWrite(req, state, "work_assign", `WorkItem:${workItemAssignMatch[1]}`, taskGroupScope(state, body.taskGroupId || "tg_runtime_management"));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = assignWorkItem(state, {...body, workItemId: workItemAssignMatch[1]});
    if (result.ok === false) return json(res, 404, {error: result.error});
    audit(state, "scheduler", "work_assign", `WorkItem:${result.workItem.id}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/findings") {
    // Confused-deputy fix: when updating an existing finding, scope the guard on the finding's OWN task
    // group, never on the caller-supplied body.taskGroupId — otherwise a reviewer scoped to their own
    // task group could rewrite a finding owned by a different task group/tenant (matches finding_resolve).
    const existingFinding = body.findingId ? (state.findings || []).find((item) => item.findingId === body.findingId) : null;
    const scopeTaskGroupId = existingFinding?.taskGroupId || body.taskGroupId || "tg_runtime_management";
    const guard = beginGuardedWrite(req, state, "finding_submit", `Finding:${body.findingId || "new"}`, taskGroupScope(state, scopeTaskGroupId));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = findingSubmit(state, body);
    audit(state, "reviewer", "finding_submit", `Finding:${result.finding.findingId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  const findingResolveMatch = url.pathname.match(/^\/api\/findings\/([^/]+)\/resolve$/);
  if (req.method === "POST" && findingResolveMatch) {
    const existingFinding = (state.findings || []).find((item) => item.findingId === findingResolveMatch[1]);
    const guard = beginGuardedWrite(req, state, "finding_resolve", `Finding:${findingResolveMatch[1]}`, taskGroupScope(state, existingFinding?.taskGroupId || "tg_runtime_management"));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = findingResolve(state, {...body, findingId: findingResolveMatch[1]});
    if (result.ok === false) return json(res, 404, {error: result.error});
    recomputeBarrierAfterResolve(state, existingFinding?.taskGroupId);
    audit(state, "policy-engine", "finding_resolve", `Finding:${result.finding.findingId}`);
    finishGuardedWrite(state, guard, 200, result);
    writeState(state);
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/approval-requests") {
    const guard = beginGuardedWrite(req, state, "approval_request_create", `ApprovalRequest:${body.approvalId || "new"}`, taskGroupScope(state, body.taskGroupId || "tg_runtime_management"));
    if (guard.status) return json(res, guard.status, guard.payload);
    // Record the proposer as the AUTHENTICATED actor (never client-supplied) for high_risk_no_self_approval.
    const result = approvalRequestCreate(state, {...body, proposedBy: guard.actor});
    audit(state, "decision-center", "approval_request_create", `ApprovalRequest:${result.approvalRequest.approvalId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  const approvalResolveMatch = url.pathname.match(/^\/api\/approval-requests\/([^/]+)\/resolve$/);
  if (req.method === "POST" && approvalResolveMatch) {
    const existingApproval = (state.approvalRequests || []).find((item) => item.approvalId === approvalResolveMatch[1]);
    const guard = beginGuardedWrite(req, state, "approval_resolve", `ApprovalRequest:${approvalResolveMatch[1]}`, taskGroupScope(state, existingApproval?.taskGroupId || "tg_runtime_management"));
    if (guard.status) return json(res, guard.status, guard.payload);
    // The approver identity is the AUTHENTICATED actor, never a client-supplied resolvedBy — this is what
    // high_risk_no_self_approval and the quorum tally key on.
    const result = approvalResolve(state, {...body, approvalId: approvalResolveMatch[1], resolvedBy: guard.actor});
    if (result.ok === false) return json(res, result.error === "high_risk_no_self_approval" ? 403 : 404, {error: result.error});
    recomputeBarrierAfterResolve(state, existingApproval?.taskGroupId);
    audit(state, "policy-engine", "approval_resolve", `ApprovalRequest:${result.approvalRequest.approvalId}`);
    finishGuardedWrite(state, guard, 200, result);
    writeState(state);
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/policy-decisions/evaluate") {
    const guard = beginGuardedWrite(req, state, "policy_decision_eval", `PolicyDecision:${body.decisionId || "new"}`, {resourceType: "system", resourceId: "policy_engine"});
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = policyDecisionEval(state, body);
    audit(state, "policy-engine", "policy_decision_eval", `PolicyDecision:${result.policyDecision.decisionId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/contracts") {
    const contractTaskGroup = body.taskGroupId ? state.taskGroups.find((item) => item.id === body.taskGroupId) : null;
    const contractProjectId = contractTaskGroup?.projectId || body.projectId || "prj_control_plane";
    const guard = beginGuardedWrite(req, state, "contract_publish", `Contract:${body.contractId || "new"}`, projectScope(contractProjectId));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = contractPublish(state, {...body, projectId: contractProjectId});
    audit(state, "orchestrator", "contract_publish", `Contract:${result.contract.contractId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  const roomMessagesMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/messages$/);
  if (roomMessagesMatch) {
    const roomId = roomMessagesMatch[1];
    const roomTaskGroupId = roomId.startsWith("room_") ? roomId.slice("room_".length) : roomId;
    if (req.method === "GET") {
      const authenticated = requireRead(req, state, taskGroupScope(state, roomTaskGroupId));
      if (authenticated.status) return json(res, authenticated.status, authenticated.payload);
      const result = roomWait(state, {roomId, afterSequence: Number(url.searchParams.get("after") || url.searchParams.get("afterSequence") || 0), limit: Number(url.searchParams.get("limit") || 50)});
      json(res, 200, result);
      return;
    }
    if (req.method === "POST") {
      // Scope authorization AND the write from the path room only. Trusting body.taskGroupId here
      // would let an actor authorized on their own task group inject a message into another tenant's
      // room (guard passes on the body scope while roomSend routes by the path roomId).
      if (body.taskGroupId && body.taskGroupId !== roomTaskGroupId) {
        return json(res, 400, {error: "room_task_group_mismatch"});
      }
      const guard = beginGuardedWrite(req, state, "room_send", `Room:${roomId}`, taskGroupScope(state, roomTaskGroupId));
      if (guard.status) return json(res, guard.status, guard.payload);
      const result = roomSend(state, {...body, roomId, taskGroupId: roomTaskGroupId});
      audit(state, "room-broker", "room_send", `Room:${roomId}`);
      finishGuardedWrite(state, guard, 201, result);
      writeState(state);
      json(res, 201, result);
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/leases/claim") {
    const claimTargetId = body.repositoryOutputTargetRef || body.targetId;
    const claimTarget = claimTargetId ? (state.repositoryOutputs || []).find((item) => item.targetId === claimTargetId) : null;
    const guard = beginGuardedWrite(req, state, "lease_claim", `Lease:${claimTargetId || "new"}`, taskGroupScope(state, claimTarget?.taskGroupId || body.taskGroupId || "tg_runtime_management"));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = claimLease(state, body);
    if (result.ok === false) return json(res, result.error === "repository_output_target_not_found" ? 404 : 409, result);
    audit(state, "resource-broker", "lease_claim", `Lease:${result.lease.leaseId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  const leaseReleaseMatch = url.pathname.match(/^\/api\/leases\/([^/]+)\/release$/);
  if (req.method === "POST" && leaseReleaseMatch) {
    const lease = (state.leases || []).find((item) => item.leaseId === leaseReleaseMatch[1]);
    const leaseTargetId = lease?.resourceRef?.startsWith("RepositoryOutputTarget:") ? lease.resourceRef.slice("RepositoryOutputTarget:".length) : null;
    const leaseTarget = leaseTargetId ? (state.repositoryOutputs || []).find((item) => item.targetId === leaseTargetId) : null;
    const guard = beginGuardedWrite(req, state, "lease_release", `Lease:${leaseReleaseMatch[1]}`, taskGroupScope(state, leaseTarget?.taskGroupId || body.taskGroupId || "tg_runtime_management"));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = releaseLease(state, {...body, leaseId: leaseReleaseMatch[1]});
    if (result.ok === false) return json(res, result.error === "lease_not_found" ? 404 : 409, result);
    audit(state, "resource-broker", "lease_release", `Lease:${result.lease.leaseId}`);
    finishGuardedWrite(state, guard, 200, result);
    writeState(state);
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/artifacts") {
    const guard = beginGuardedWrite(req, state, "artifact_register", `Artifact:${body.artifactId || "new"}`, taskGroupScope(state, body.taskGroupId || "tg_runtime_management"));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = artifactRegister(state, body);
    audit(state, "agent-runtime", "artifact_register", `Artifact:${result.artifact.artifactId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/permission-requests") {
    const guard = beginGuardedWrite(req, state, "permission_request_submit", `PermissionRequest:${body.requestId || "new"}`, taskGroupScope(state, body.taskGroupId || "tg_runtime_management"));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = permissionRequestSubmit(state, body);
    audit(state, "permission-gateway", "permission_request_submit", `PermissionRequest:${result.permissionRequest.requestId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  const permissionResolveMatch = url.pathname.match(/^\/api\/permission-requests\/([^/]+)\/resolve$/);
  if (req.method === "POST" && permissionResolveMatch) {
    const existingPermission = (state.permissionRequests || []).find((item) => item.requestId === permissionResolveMatch[1]);
    // Confused-deputy fix: authorize on the RESOURCE that approval actually grants (request.resource,
    // which ensurePermissionAccessGrant uses), NOT on taskGroupId. resource.resourceId can be set
    // independently of taskGroupId at submit time, so guarding on taskGroupId let a project-lead of A
    // approve a grant over project/task-group B (same org). In the legitimate flow resource is
    // {task_group, taskGroupId}, so this does not change normal behavior.
    const permissionResolveResource = existingPermission?.resource;
    const permissionResolveScope =
      permissionResolveResource?.resourceType === "task_group" ? taskGroupScope(state, permissionResolveResource.resourceId) :
      permissionResolveResource?.resourceType === "project" ? projectScope(permissionResolveResource.resourceId) :
      existingPermission?.taskGroupId ? taskGroupScope(state, existingPermission.taskGroupId) :
      projectScope("prj_control_plane");
    const guard = beginGuardedWrite(req, state, "permission_resolve", `PermissionRequest:${permissionResolveMatch[1]}`, permissionResolveScope);
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = permissionResolve(state, {...body, requestId: permissionResolveMatch[1]});
    if (result.ok === false) return json(res, 404, {error: result.error});
    recomputeBarrierAfterResolve(state, existingPermission?.taskGroupId);
    audit(state, "permission-gateway", "permission_resolve", `PermissionRequest:${result.permissionRequest.requestId}`);
    finishGuardedWrite(state, guard, 200, result);
    writeState(state);
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/execution-topologies") {
    const guard = beginGuardedWrite(req, state, "execution_topology_plan", `ExecutionTopology:${body.topologyId || "new"}`, taskGroupScope(state, body.taskGroupId || "tg_runtime_management"));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = createExecutionTopology(state, body);
    audit(state, "scheduler", "execution_topology_plan", `ExecutionTopology:${result.topology.topologyId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  const topologyAdvanceMatch = url.pathname.match(/^\/api\/execution-topologies\/([^/]+)\/advance$/);
  if (req.method === "POST" && topologyAdvanceMatch) {
    // The lever for the no_open_execution_topologies close-barrier gate: without a reachable transition
    // path a planned topology would block the barrier forever. Scope the guard on the topology's OWN task
    // group (never a caller-supplied id) so it can't be driven from another tenant's scope.
    const existingTopology = (state.executionTopologies || []).find((item) => item.topologyId === topologyAdvanceMatch[1]);
    if (!existingTopology) return json(res, 404, {error: "execution_topology_not_found"});
    const guard = beginGuardedWrite(req, state, "execution_topology_advance", `ExecutionTopology:${topologyAdvanceMatch[1]}`, taskGroupScope(state, existingTopology.taskGroupId));
    if (guard.status) return json(res, guard.status, guard.payload);
    let result;
    try {
      result = advanceExecutionTopology(state, {...body, topologyId: topologyAdvanceMatch[1]});
    } catch (error) {
      return json(res, error.status || 409, {error: error.message});
    }
    if (result.ok === false) return json(res, 404, {error: result.error});
    recomputeBarrierAfterResolve(state, existingTopology.taskGroupId);
    audit(state, "orchestrator", "execution_topology_advance", `ExecutionTopology:${result.topology.topologyId}`, result.topology.status);
    finishGuardedWrite(state, guard, 200, result);
    writeState(state);
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/derived-task-requests") {
    const guard = beginGuardedWrite(req, state, "derived_task_classify", `DerivedTaskRequest:${body.taskGroupId || "tg_runtime_management"}`, taskGroupScope(state, body.taskGroupId || "tg_runtime_management"));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = classifyDerivedTask(state, body);
    audit(state, "scheduler", "derived_task_classify", `DerivedTaskRequest:${result.roleId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/review-plans") {
    const guard = beginGuardedWrite(req, state, "review_plan_create", `ReviewPlan:${body.reviewPlanId || "new"}`, taskGroupScope(state, body.taskGroupId || "tg_runtime_management"));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = reviewPlanCreate(state, body);
    audit(state, "reviewer", "review_plan_create", `ReviewPlan:${result.reviewPlan.reviewPlanId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/review-bundles") {
    const guard = beginGuardedWrite(req, state, "review_bundle_register", `ReviewBundle:${body.reviewBundleId || "new"}`, taskGroupScope(state, body.taskGroupId || "tg_runtime_management"));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = reviewBundleRegister(state, body);
    audit(state, "reviewer", "review_bundle_register", `ReviewBundle:${result.reviewBundle.reviewBundleId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/rule-source-resolutions") {
    const guard = beginGuardedWrite(req, state, "rule_source_resolve", `RuleSourceResolution:${body.resolutionId || "new"}`, taskGroupScope(state, body.taskGroupId || "tg_runtime_management"));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = ruleSourceResolve(state, body);
    audit(state, "rule-steward", "rule_source_resolve", `RuleSourceResolution:${result.ruleSourceResolution.resolutionId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/orgs") {
    const guard = beginGuardedWrite(req, state, "org_create", "Organization:new", {resourceType: "system", resourceId: "organizations"});
    if (guard.status) return json(res, guard.status, guard.payload);
    const at = now();
    const orgId = createId("org");
    const quotas = {
      maxMembers: boundedQuota(body.quotas?.maxMembers, 50),
      maxProjects: boundedQuota(body.quotas?.maxProjects, 20),
      maxTaskGroups: boundedQuota(body.quotas?.maxTaskGroups, 200),
      maxAgents: boundedQuota(body.quotas?.maxAgents, 100)
    };
    if (body.admin?.email && (state.accounts || []).some((item) => item.email === String(body.admin.email))) {
      json(res, 409, {error: "account_email_already_registered"});
      return;
    }
    const adminAccountId = createId("acct");
    const adminToken = `aimac_account_${randomBytes(32).toString("base64url")}`;
    const adminAccount = {
      schemaVersion: "account/v1",
      accountId: adminAccountId,
      accountType: "org_admin",
      organizationId: orgId,
      displayName: String(body.admin?.displayName || "组织管理员"),
      email: String(body.admin?.email || `org-admin-${Date.now()}@local`),
      status: "invited",
      roles: ["org_admin"],
      permissions: ["org:*", "project:create", "project:*", "task_group:*", "member:invite", "agent:activate", "project:grant"],
      authPolicy: {method: "invite_token", mfaRequired: false, passwordSet: false, sessionTtlSeconds: 28800},
      credentialDigest: digestOf(`account-invite:${adminAccountId}:${adminToken}`),
      credentialIssuedAt: at,
      credentialExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      createdAt: at,
      updatedAt: at
    };
    const organization = {
      schemaVersion: "organization/v1",
      orgId,
      name: String(body.name || "").trim() || `组织 ${orgId.slice(-6)}`,
      status: "active",
      quotas,
      usage: {members: 1, projects: 0, taskGroups: 0, agents: 0},
      initialAdminAccountId: adminAccountId,
      createdBy: guard.actor,
      createdAt: at,
      updatedAt: at
    };
    state.organizations.push(organization);
    state.accounts.push(adminAccount);
    audit(state, guard.actor, "org_create", `Organization:${orgId}`);
    finishGuardedWrite(state, guard, 201, {organization, adminAccountId});
    writeState(state);
    json(res, 201, {organization, adminAccount: publicAccountRecord(adminAccount), accountToken: adminToken, login: {email: adminAccount.email, tokenField: "accountToken"}});
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/orgs") {
    const reader = requireRead(req, state, {resourceType: "system", resourceId: "organizations"});
    if (reader.status) return json(res, reader.status, reader.payload);
    recomputeOrganizationUsage(state);
    json(res, 200, {organizations: state.organizations});
    return;
  }

  const orgQuotaMatch = url.pathname.match(/^\/api\/orgs\/([^/]+)\/quotas$/);
  if (req.method === "POST" && orgQuotaMatch) {
    const guard = beginGuardedWrite(req, state, "org_quota_update", `Organization:${orgQuotaMatch[1]}`, {resourceType: "system", resourceId: "organizations"});
    if (guard.status) return json(res, guard.status, guard.payload);
    const organization = organizationOf(state, orgQuotaMatch[1]);
    if (!organization) return json(res, 404, {error: "organization_not_found"});
    for (const key of ["maxMembers", "maxProjects", "maxTaskGroups", "maxAgents"]) {
      if (body.quotas?.[key] !== undefined) organization.quotas[key] = boundedQuota(body.quotas[key], organization.quotas[key]);
      else if (body[key] !== undefined) organization.quotas[key] = boundedQuota(body[key], organization.quotas[key]);
    }
    organization.updatedAt = now();
    audit(state, guard.actor, "org_quota_update", `Organization:${organization.orgId}`);
    finishGuardedWrite(state, guard, 200, organization);
    writeState(state);
    json(res, 200, organization);
    return;
  }

  const orgStatusMatch = url.pathname.match(/^\/api\/orgs\/([^/]+)\/status$/);
  if (req.method === "POST" && orgStatusMatch) {
    const guard = beginGuardedWrite(req, state, "org_status_update", `Organization:${orgStatusMatch[1]}`, {resourceType: "system", resourceId: "organizations"});
    if (guard.status) return json(res, guard.status, guard.payload);
    const organization = organizationOf(state, orgStatusMatch[1]);
    if (!organization) return json(res, 404, {error: "organization_not_found"});
    organization.status = body.status === "suspended" ? "suspended" : "active";
    organization.updatedAt = now();
    audit(state, guard.actor, "org_status_update", `Organization:${organization.orgId}`, organization.status);
    finishGuardedWrite(state, guard, 200, organization);
    writeState(state);
    json(res, 200, organization);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/system/overview") {
    const reader = requireRead(req, state, {resourceType: "system", resourceId: "overview"});
    if (reader.status) return json(res, reader.status, reader.payload);
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const cpuSeconds = (cpu.user + cpu.system) / 1e6;
    const wattsPerCpu = Number(process.env.AIMAC_ENERGY_WATTS_PER_CPU || 15);
    let stateBytes = 0;
    let projectDbBytes = 0;
    try { stateBytes = statSync(statePath).size; } catch {}
    try {
      const projectDbDir = join(runtimeDir, "project-db");
      if (existsSync(projectDbDir)) {
        for (const name of readdirSync(projectDbDir)) {
          try { projectDbBytes += statSync(join(projectDbDir, name)).size; } catch {}
        }
      }
    } catch {}
    recomputeOrganizationUsage(state);
    json(res, 200, {
      server: {platform: platform(), arch: arch(), hostname: hostname(), nodeVersion: process.version, uptimeSeconds: Math.round(process.uptime()), pid: process.pid},
      resources: {rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, cpuSeconds: Math.round(cpuSeconds), loadAverage: loadavg(), totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), cpuCount: cpus().length},
      energy: {estimatedWattHours: Math.round(cpuSeconds / 3600 * wattsPerCpu * 100) / 100, wattsPerCpuCoefficient: wattsPerCpu},
      storage: {centralStateBytes: stateBytes, projectDbBytes, stateStore: stateStoreKind()},
      runtime: {
        onlineNodes: (state.agentRuntimeNodes || []).filter((node) => node.status === "online").length,
        totalNodes: (state.agentRuntimeNodes || []).length,
        organizations: state.organizations.length,
        projects: (state.projects || []).length,
        activeTaskGroups: (state.taskGroups || []).filter((taskGroup) => !["closed", "aborted"].includes(taskGroup.status)).length,
        stateVersion: state.stateVersion,
        auditChainHead: state.auditChainHead || null
      },
      at: now()
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/change-password") {
    const authenticated = accountFromRequest(req, state);
    if (!authenticated) return json(res, 401, {error: "auth_required"});
    const newPassword = String(body.newPassword || "");
    if (newPassword.length < 8) return json(res, 400, {error: "password_too_short", minLength: 8});
    const account = authenticated.account;
    if (account.passwordDigest) {
      const currentOk = body.currentPassword && account.passwordDigest === digestOf(`account-password:${account.accountId}:${body.currentPassword}`);
      if (!currentOk) return json(res, 403, {error: "current_password_incorrect"});
    }
    account.passwordDigest = digestOf(`account-password:${account.accountId}:${newPassword}`);
    account.authPolicy = {...(account.authPolicy || {}), method: account.authPolicy?.method || "password", passwordSet: true};
    account.updatedAt = now();
    audit(state, account.accountId, "auth_change_password", `Account:${account.accountId}`);
    commitDirectStateWrite(state);
    json(res, 200, {ok: true, accountId: account.accountId, passwordSet: true});
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/org/members") {
    const actorAccount = accountFromRequest(req, state)?.account;
    const orgId = actorAccount?.organizationId;
    const guard = beginGuardedWrite(req, state, "org_member_create", `Organization:${orgId || "unknown"}`, {resourceType: "organization", resourceId: orgId});
    if (guard.status) return json(res, guard.status, guard.payload);
    const quota = organizationQuotaCheck(state, orgId, "members");
    if (!quota.allowed) return json(res, 409, {error: quota.error, quota: quota.quota, usage: quota.usage});
    if (body.email && (state.accounts || []).some((item) => item.email === String(body.email))) {
      return json(res, 409, {error: "account_email_already_registered"});
    }
    const at = now();
    const accountId = createId("acct");
    const memberToken = `aimac_account_${randomBytes(32).toString("base64url")}`;
    const permissions = sanitizeMemberPermissions(body.permissions, ["project:view"]);
    const member = {
      schemaVersion: "account/v1",
      accountId,
      accountType: "user_account",
      organizationId: orgId,
      displayName: String(body.displayName || "新成员"),
      email: String(body.email || `member-${Date.now()}@local`),
      status: "invited",
      roles: normalizeStringList(body.roles, ["member"]).filter((role) => role !== "system_admin" && role !== "org_admin"),
      permissions,
      defaultProjectId: body.defaultProjectId || null,
      authPolicy: {method: "invite_token", mfaRequired: false, passwordSet: false, sessionTtlSeconds: 28800},
      credentialDigest: digestOf(`account-invite:${accountId}:${memberToken}`),
      credentialIssuedAt: at,
      credentialExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      createdAt: at,
      updatedAt: at
    };
    state.accounts.push(member);
    recomputeOrganizationUsage(state);
    audit(state, guard.actor, "org_member_create", `Account:${accountId}`);
    finishGuardedWrite(state, guard, 201, publicAccountRecord(member));
    writeState(state);
    json(res, 201, {account: publicAccountRecord(member), accountToken: memberToken, login: {email: member.email, tokenField: "accountToken"}});
    return;
  }

  const orgMemberPermMatch = url.pathname.match(/^\/api\/org\/members\/([^/]+)\/permissions$/);
  if (req.method === "POST" && orgMemberPermMatch) {
    const actorAccount = accountFromRequest(req, state)?.account;
    const orgId = actorAccount?.organizationId;
    const guard = beginGuardedWrite(req, state, "org_member_permissions_update", `Account:${orgMemberPermMatch[1]}`, {resourceType: "organization", resourceId: orgId});
    if (guard.status) return json(res, guard.status, guard.payload);
    const member = state.accounts.find((item) => item.accountId === orgMemberPermMatch[1] && item.organizationId === orgId && item.accountType !== "org_admin");
    if (!member) return json(res, 404, {error: "org_member_not_found"});
    member.permissions = sanitizeMemberPermissions(body.permissions, member.permissions || ["project:view"]);
    if (body.defaultProjectId !== undefined) member.defaultProjectId = body.defaultProjectId || null;
    member.updatedAt = now();
    audit(state, guard.actor, "org_member_permissions_update", `Account:${member.accountId}`);
    finishGuardedWrite(state, guard, 200, publicAccountRecord(member));
    writeState(state);
    json(res, 200, publicAccountRecord(member));
    return;
  }

  const orgMemberStatusMatch = url.pathname.match(/^\/api\/org\/members\/([^/]+)\/status$/);
  if (req.method === "POST" && orgMemberStatusMatch) {
    const actorAccount = accountFromRequest(req, state)?.account;
    const orgId = actorAccount?.organizationId;
    const guard = beginGuardedWrite(req, state, "org_member_status_update", `Account:${orgMemberStatusMatch[1]}`, {resourceType: "organization", resourceId: orgId});
    if (guard.status) return json(res, guard.status, guard.payload);
    const member = state.accounts.find((item) => item.accountId === orgMemberStatusMatch[1] && item.organizationId === orgId && item.accountType !== "org_admin");
    if (!member) return json(res, 404, {error: "org_member_not_found"});
    member.status = body.status === "disabled" ? "disabled" : "active";
    member.updatedAt = now();
    if (member.status === "disabled") {
      for (const session of state.authSessions || []) {
        if (session.accountId === member.accountId && session.status === "active") session.status = "revoked";
      }
    }
    recomputeOrganizationUsage(state);
    audit(state, guard.actor, "org_member_status_update", `Account:${member.accountId}`, member.status);
    finishGuardedWrite(state, guard, 200, publicAccountRecord(member));
    writeState(state);
    json(res, 200, publicAccountRecord(member));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/org/members") {
    const reader = accountFromRequest(req, state);
    if (!reader) return json(res, 401, {error: "auth_required"});
    const orgId = isSystemAccount(reader.account) ? (url.searchParams.get("orgId") || DEFAULT_ORGANIZATION_ID) : reader.account.organizationId;
    if (!orgId) return json(res, 400, {error: "organization_required"});
    if (!isSystemAccount(reader.account) && !canReadResource(state, reader.account, {resourceType: "organization", resourceId: orgId})) {
      return json(res, 403, {error: "permission_denied"});
    }
    const members = (state.accounts || [])
      .filter((item) => item.organizationId === orgId && item.accountType !== "service_account")
      .map((item) => ({...publicAccountRecord(item), organizationId: item.organizationId, defaultProjectId: item.defaultProjectId || null}));
    json(res, 200, {orgId, members});
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/org/agents") {
    const reader = accountFromRequest(req, state);
    if (!reader) return json(res, 401, {error: "auth_required"});
    const orgId = isSystemAccount(reader.account) ? (url.searchParams.get("orgId") || DEFAULT_ORGANIZATION_ID) : reader.account.organizationId;
    if (!orgId) return json(res, 400, {error: "organization_required"});
    if (!isSystemAccount(reader.account) && reader.account.organizationId !== orgId) return json(res, 403, {error: "permission_denied"});
    const nodes = (state.agentRuntimeNodes || [])
      .filter((node) => (node.organizationId || DEFAULT_ORGANIZATION_ID) === orgId)
      .map((node) => ({
        ...publicAgentNode(node),
        display: {
          region: node.profile?.region || null,
          dataRoot: node.profile?.dataRoot || null,
          health: node.status === "online" ? (node.admission === "full" ? "healthy" : "limited") : node.status,
          currentDispatchIds: node.activeDispatchIds || [],
          networkSpeedMbps: node.profile?.networkSpeedMbps || null,
          models: (node.profile?.models || []).filter((model) => model.available !== false).map((model) => model.providerClass)
        }
      }));
    json(res, 200, {orgId, agentRuntimeNodes: nodes});
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/org/projects") {
    const actorAccount = accountFromRequest(req, state)?.account;
    const orgId = actorAccount?.organizationId;
    const guard = beginGuardedWrite(req, state, "org_project_create", `Organization:${orgId || "unknown"}`, {resourceType: "organization", resourceId: orgId});
    if (guard.status) return json(res, guard.status, guard.payload);
    const quota = organizationQuotaCheck(state, orgId, "projects");
    if (!quota.allowed) return json(res, 409, {error: quota.error, quota: quota.quota, usage: quota.usage});
    const id = createId("prj");
    state.projects.push({
      id,
      organizationId: orgId,
      name: String(body.name || "").trim() || "未命名项目",
      status: "active",
      ownerAccountId: guard.actor,
      members: [{accountId: guard.actor, role: "project_owner"}],
      config: {
        repositories: Array.isArray(body.repositories) ? body.repositories : [],
        baselineData: [],
        businessRules: [],
        defaultRoles: []
      },
      progress: {percent: 0, phase: "intake", health: "ok", openTaskGroups: 0, blockedItems: 0, updatedAt: now()}
    });
    const ownerGrant = ensureProjectOwnerGrant(state, state.projects.at(-1), guard.actor, guard.policyDecision.id, `audit:${guard.idempotencyKey}`);
    recomputeOrganizationUsage(state);
    audit(state, guard.actor, "org_project_create", `Project:${id}`);
    finishGuardedWrite(state, guard, 201, {id, ownerGrant});
    writeState(state);
    json(res, 201, {id, ownerGrant});
    return;
  }

  const humanConfirmationListMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/human-confirmations$/);
  if (req.method === "GET" && humanConfirmationListMatch) {
    const reader = requireRead(req, state, taskGroupScope(state, humanConfirmationListMatch[1]));
    if (reader.status) return json(res, reader.status, reader.payload);
    json(res, 200, {humanConfirmationRequests: (state.humanConfirmationRequests || []).filter((item) => item.taskGroupId === humanConfirmationListMatch[1])});
    return;
  }

  const humanConfirmationDecideMatch = url.pathname.match(/^\/api\/human-confirmations\/([^/]+)\/decide$/);
  if (req.method === "POST" && humanConfirmationDecideMatch) {
    const target = (state.humanConfirmationRequests || []).find((item) => item.requestId === humanConfirmationDecideMatch[1]);
    const guard = beginGuardedWrite(req, state, "human_confirmation_decide", `HumanConfirmationRequest:${humanConfirmationDecideMatch[1]}`, target ? taskGroupScope(state, target.taskGroupId) : {resourceType: "system", resourceId: "human_confirmations"});
    if (guard.status) return json(res, guard.status, guard.payload);
    let decided;
    try {
      decided = decideHumanConfirmation(state, humanConfirmationDecideMatch[1], body, {actor: guard.actor});
    } catch (error) {
      return json(res, error.status || 500, {error: error.message});
    }
    audit(state, guard.actor, "human_confirmation_decide", `HumanConfirmationRequest:${decided.requestId}`);
    finishGuardedWrite(state, guard, 200, decided);
    writeState(state);
    json(res, 200, decided);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/human-directives") {
    const guard = beginGuardedWrite(req, state, "human_directive_create", `TaskGroup:${body.taskGroupId || body.projectId || "unknown"}`, body.taskGroupId ? taskGroupScope(state, body.taskGroupId) : projectScope(body.projectId));
    if (guard.status) return json(res, guard.status, guard.payload);
    let directive;
    try {
      directive = createHumanDirective(state, body, {actor: guard.actor});
    } catch (error) {
      return json(res, error.status || 500, {error: error.message});
    }
    const controlAction = {pause: "pause", resume: "resume", cancel: "cancel"}[directive.directiveType];
    const directiveTaskGroup = directive.taskGroupId ? state.taskGroups.find((item) => item.id === directive.taskGroupId) : null;
    if (controlAction && directiveTaskGroup) {
      if (directive.directiveType === "pause") directiveTaskGroup.goalExecutionStatus = "active_paused_by_freeze";
      if (directive.directiveType === "resume") {
        directiveTaskGroup.goalExecutionStatus = "active";
        delete directiveTaskGroup.pauseReason;
      }
      if (directive.directiveType === "cancel") {
        directiveTaskGroup.goalExecutionStatus = "active_paused_by_freeze";
        directiveTaskGroup.pauseReason = "human_directive_cancel";
      }
      const runtimeControl = applyTaskGroupRuntimeControl(state, directiveTaskGroup, controlAction, {actor: guard.actor, idempotencyKey: `human-directive:${directive.directiveId}`});
      directive.status = "applied";
      directive.appliedActions = [{action: `task_group_${controlAction}`, ref: `TaskGroup:${directiveTaskGroup.id}`}];
      directive.runtimeControl = {controlCommands: runtimeControl.controlCommands.map((command) => command.commandId), directDispatches: runtimeControl.directDispatches, resumedDispatches: runtimeControl.resumedDispatches};
      directive.updatedAt = now();
      directiveTaskGroup.updatedAt = now();
    }
    audit(state, guard.actor, "human_directive_create", `HumanDirective:${directive.directiveId}`);
    finishGuardedWrite(state, guard, 201, directive);
    writeState(state);
    json(res, 201, directive);
    return;
  }

  const humanDirectiveListMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/human-directives$/);
  if (req.method === "GET" && humanDirectiveListMatch) {
    const reader = requireRead(req, state, taskGroupScope(state, humanDirectiveListMatch[1]));
    if (reader.status) return json(res, reader.status, reader.payload);
    json(res, 200, {humanDirectives: (state.humanDirectives || []).filter((item) => item.taskGroupId === humanDirectiveListMatch[1])});
    return;
  }

  const projectConfigMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/config$/);
  if (req.method === "GET" && projectConfigMatch) {
    const reader = requireRead(req, state, projectScope(projectConfigMatch[1]));
    if (reader.status) return json(res, reader.status, reader.payload);
    const project = state.projects.find((item) => item.id === projectConfigMatch[1]);
    if (!project) return json(res, 404, {error: "project_not_found"});
    json(res, 200, {projectId: project.id, config: effectiveProjectConfig(project)});
    return;
  }
  if (req.method === "POST" && projectConfigMatch) {
    const ruleErr = ruleFragmentsRejection(body.systemRules) || ruleFragmentsRejection(body.businessRules);
    if (ruleErr) return json(res, 422, {error: ruleErr, limits: {rules: 200, title: 256, content: 8192}});
    const guard = beginGuardedWrite(req, state, "project_config_update", `Project:${projectConfigMatch[1]}`, projectScope(projectConfigMatch[1]));
    if (guard.status) return json(res, guard.status, guard.payload);
    const project = state.projects.find((item) => item.id === projectConfigMatch[1]);
    if (!project) return json(res, 404, {error: "project_not_found"});
    project.config = {
      ...(project.config || {}),
      ...(body.repositories !== undefined ? {repositories: Array.isArray(body.repositories) ? body.repositories : []} : {}),
      ...(body.baselineData !== undefined ? {baselineData: Array.isArray(body.baselineData) ? body.baselineData : []} : {}),
      ...(body.businessRules !== undefined ? {businessRules: sanitizeRuleFragments(body.businessRules)} : {}),
      ...(body.systemRules !== undefined ? {systemRules: sanitizeRuleFragments(body.systemRules)} : {}),
      ...(body.defaultRoles !== undefined ? {defaultRoles: Array.isArray(body.defaultRoles) ? body.defaultRoles : []} : {})
    };
    project.updatedAt = now();
    audit(state, guard.actor, "project_config_update", `Project:${project.id}`);
    finishGuardedWrite(state, guard, 200, project.config);
    writeState(state);
    json(res, 200, {projectId: project.id, config: project.config});
    return;
  }

  const taskGroupConfigMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/config$/);
  if (req.method === "GET" && taskGroupConfigMatch) {
    const reader = requireRead(req, state, taskGroupScope(state, taskGroupConfigMatch[1]));
    if (reader.status) return json(res, reader.status, reader.payload);
    const taskGroup = state.taskGroups.find((item) => item.id === taskGroupConfigMatch[1]);
    if (!taskGroup) return json(res, 404, {error: "task_group_not_found"});
    json(res, 200, {taskGroupId: taskGroup.id, config: effectiveTaskGroupConfig(state, taskGroup)});
    return;
  }
  if (req.method === "POST" && taskGroupConfigMatch) {
    const ruleErr = ruleFragmentsRejection(body.systemRules) || ruleFragmentsRejection(body.businessRules);
    if (ruleErr) return json(res, 422, {error: ruleErr, limits: {rules: 200, title: 256, content: 8192}});
    const guard = beginGuardedWrite(req, state, "task_group_config_update", `TaskGroup:${taskGroupConfigMatch[1]}`, taskGroupScope(state, taskGroupConfigMatch[1]));
    if (guard.status) return json(res, guard.status, guard.payload);
    const taskGroup = state.taskGroups.find((item) => item.id === taskGroupConfigMatch[1]);
    if (!taskGroup) return json(res, 404, {error: "task_group_not_found"});
    const mergedOverrides = {
      ...(taskGroup.configOverrides || {}),
      ...(body.repositories !== undefined ? {repositories: Array.isArray(body.repositories) ? body.repositories : []} : {}),
      ...(body.baselineData !== undefined ? {baselineData: Array.isArray(body.baselineData) ? body.baselineData : []} : {}),
      ...(body.businessRules !== undefined ? {businessRules: sanitizeRuleFragments(body.businessRules)} : {}),
      ...(body.systemRules !== undefined ? {systemRules: sanitizeRuleFragments(body.systemRules)} : {}),
      ...(body.defaultRoles !== undefined ? {defaultRoles: Array.isArray(body.defaultRoles) ? body.defaultRoles : []} : {})
    };
    // 仅保留非空覆盖键；若全为空则删除整个 configOverrides，使任务组回到"继承项目"，
    // 避免无实际改动的保存把任务组误标为"已自定义"并冻结当时继承到的值。
    for (const key of Object.keys(mergedOverrides)) {
      if (Array.isArray(mergedOverrides[key]) && mergedOverrides[key].length === 0) delete mergedOverrides[key];
    }
    if (Object.keys(mergedOverrides).length) taskGroup.configOverrides = mergedOverrides;
    else delete taskGroup.configOverrides;
    taskGroup.updatedAt = now();
    audit(state, guard.actor, "task_group_config_update", `TaskGroup:${taskGroup.id}`);
    const effective = effectiveTaskGroupConfig(state, taskGroup);
    finishGuardedWrite(state, guard, 200, effective);
    writeState(state);
    json(res, 200, {taskGroupId: taskGroup.id, config: effective});
    return;
  }

  const taskGroupConfigResetMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/config\/reset$/);
  if (req.method === "POST" && taskGroupConfigResetMatch) {
    const guard = beginGuardedWrite(req, state, "task_group_config_reset", `TaskGroup:${taskGroupConfigResetMatch[1]}`, taskGroupScope(state, taskGroupConfigResetMatch[1]));
    if (guard.status) return json(res, guard.status, guard.payload);
    const taskGroup = state.taskGroups.find((item) => item.id === taskGroupConfigResetMatch[1]);
    if (!taskGroup) return json(res, 404, {error: "task_group_not_found"});
    delete taskGroup.configOverrides;
    taskGroup.updatedAt = now();
    audit(state, guard.actor, "task_group_config_reset", `TaskGroup:${taskGroup.id}`);
    const effective = effectiveTaskGroupConfig(state, taskGroup);
    finishGuardedWrite(state, guard, 200, effective);
    writeState(state);
    json(res, 200, {taskGroupId: taskGroup.id, config: effective});
    return;
  }

  const contentBundleMatch = url.pathname.match(/^\/api\/agent\/v1\/content-bundles\/([^/]+)$/);
  if (req.method === "GET" && contentBundleMatch) {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    try {
      const bundle = buildExecutionContentBundle(state, node, decodeURIComponent(contentBundleMatch[1]), {runtimeDir});
      json(res, 200, bundle);
    } catch (error) {
      json(res, error.status || 500, {error: error.message});
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/v1/confirmations") {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    let request;
    try {
      request = createHumanConfirmationRequest(state, {...body, nodeId: node.nodeId});
    } catch (error) {
      return json(res, error.status || 500, {error: error.message});
    }
    audit(state, `agent-node:${node.nodeId}`, "human_confirmation_request", `HumanConfirmationRequest:${request.requestId}`);
    commitGatewayWrite(state);
    json(res, 201, {request});
    return;
  }

  const agentConfirmationMatch = url.pathname.match(/^\/api\/agent\/v1\/confirmations\/([^/]+)$/);
  if (req.method === "GET" && agentConfirmationMatch) {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    const request = (state.humanConfirmationRequests || []).find((item) => item.requestId === agentConfirmationMatch[1]);
    if (!request || request.nodeId !== node.nodeId) return json(res, 404, {error: "human_confirmation_not_found"});
    if (url.searchParams.get("consume") === "true" && request.status === "answered") {
      consumeHumanConfirmation(state, request.requestId, {actor: `agent-node:${node.nodeId}`});
      commitGatewayWrite(state);
    }
    json(res, 200, {request});
    return;
  }

  json(res, 404, {error: "api_not_found"});
}

const server = createServer((req, res) => {
  try {
    const pathname = safeRequestPathname(req);
    if (pathname === null) {
      json(res, 400, {error: "invalid_request_url"});
      return;
    }
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
    if (!pathname.startsWith("/api/")) {
      serveStatic(req, res, pathname);
      return;
    }

    handleApi(req, res).catch((error) => {
      respondApiError(res, error);
    });
  } catch (error) {
    try {
      respondApiError(res, error);
    } catch {}
  }
});

function safeRequestPathname(req) {
  try {
    return new URL(req.url, "http://request.local").pathname;
  } catch {
    return null;
  }
}

// --- Real-time WebSocket push (additive over long-poll) --------------------------------------
const realtimeServer = new WebSocketServer({noServer: true});

function realtimeToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  try {
    return new URL(req.url, "http://request.local").searchParams.get("token") || "";
  } catch {
    return "";
  }
}

function authorizeRealtime(req) {
  const token = realtimeToken(req);
  if (!token) return null;
  const state = readState();
  const tokenDigest = digestOf(`session:${token}`);
  const session = (state.authSessions || []).find((item) => item.tokenDigest === tokenDigest && item.status === "active" && new Date(item.expiresAt).getTime() > Date.now());
  if (session) {
    const account = (state.accounts || []).find((item) => item.accountId === session.accountId);
    if (account) return {kind: "account", accountId: account.accountId};
  }
  const node = authenticateAgentNode(state, token);
  if (node) return {kind: "agent", nodeId: node.nodeId};
  return null;
}

function realtimeChannelAuthorized(principal, channel) {
  if (channel === "state") return true; // wake-only; client re-fetches tenant-scoped state
  if (channel.startsWith("agent-control:")) return principal.kind === "agent" && channel === `agent-control:${principal.nodeId}`;
  return false;
}

function handleRealtimeMessage(socket, data) {
  let message;
  try {
    message = JSON.parse(String(data));
  } catch {
    return;
  }
  if (Array.isArray(message.subscribe)) {
    for (const channel of message.subscribe) {
      if (realtimeChannelAuthorized(socket.principal, String(channel))) socket.subscriptions.add(String(channel));
    }
  }
  if (Array.isArray(message.unsubscribe)) {
    for (const channel of message.unsubscribe) socket.subscriptions.delete(String(channel));
  }
  try {
    socket.send(JSON.stringify({event: "subscribed", channels: [...socket.subscriptions]}));
  } catch {
    realtimeClients.delete(socket);
  }
}

server.on("upgrade", (req, socket, head) => {
  // The whole body must be guarded: unlike the request path (createServer callback), a throw in a
  // synchronously-emitted 'upgrade' listener becomes an uncaughtException and would exit the
  // process. authorizeRealtime() calls readState(), which can throw (lock/pg-bridge timeout).
  let principal;
  try {
    const pathname = new URL(req.url, "http://request.local").pathname;
    if (pathname !== "/api/realtime") {
      socket.destroy();
      return;
    }
    principal = authorizeRealtime(req);
  } catch {
    socket.destroy();
    return;
  }
  if (!principal) {
    try {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    } catch { /* socket already gone */ }
    socket.destroy();
    return;
  }
  realtimeServer.handleUpgrade(req, socket, head, (client) => {
    client.principal = principal;
    client.subscriptions = new Set();
    client.isAlive = true;
    if (principal.kind === "agent") client.subscriptions.add(`agent-control:${principal.nodeId}`);
    realtimeClients.add(client);
    client.on("pong", () => { client.isAlive = true; });
    client.on("message", (data) => handleRealtimeMessage(client, data));
    client.on("close", () => realtimeClients.delete(client));
    client.on("error", () => { realtimeClients.delete(client); try { client.terminate(); } catch {} });
    try {
      client.send(JSON.stringify({event: "connected", channels: [...client.subscriptions]}));
    } catch {
      realtimeClients.delete(client);
    }
  });
});

const realtimeHeartbeat = setInterval(() => {
  for (const client of realtimeClients) {
    if (client.isAlive === false) {
      realtimeClients.delete(client);
      try { client.terminate(); } catch {}
      continue;
    }
    client.isAlive = false;
    try { client.ping(); } catch { realtimeClients.delete(client); }
  }
}, Math.max(10000, Number(process.env.AIMAC_REALTIME_HEARTBEAT_MS || 30000)));
realtimeHeartbeat.unref();

function respondApiError(res, error) {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (isStateStoreConflict(error)) {
    json(res, 409, {error: "state_write_conflict", retryable: true, message: error.message});
    return;
  }
  if (error.status && error.status < 500) {
    json(res, error.status, {error: error.message, ...(error.details || {})});
    return;
  }
  json(res, error.status || 500, {error: "server_error", message: error.message});
}

server.keepAliveTimeout = Math.max(5000, Number(process.env.AIMAC_KEEP_ALIVE_TIMEOUT_MS || 65000));
server.headersTimeout = server.keepAliveTimeout + 5000;
server.requestTimeout = Math.max(server.headersTimeout, Number(process.env.AIMAC_REQUEST_TIMEOUT_MS || 300000));

assertRuntimeSecurity();
ensureState();
server.listen(port, host, () => {
  console.log(`AI Multi-Agent Ctrl console: http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`);
  console.log(`Centralized MCP endpoint: ${publicEndpoint()}/mcp`);
  console.log(`Agent installer: ${publicEndpoint()}/install-agent.sh`);
});
