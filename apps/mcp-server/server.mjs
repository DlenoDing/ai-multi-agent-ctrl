#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureStoredState, isStateStoreConflict, markRuntimeStorage, readStoredState, writeStoredState } from "../control-plane-ui/lib/state-store.mjs";
import {
  acceptAgentCheckpoint,
  buildTaskContract,
  collectRuntimeIssue,
  computeCloseBarrier,
  computeCompletionReadiness,
  computeProgressSnapshots,
  canUseGitPath,
  createId,
  decideSessionPlacement,
  digestOf,
  ensureRuntimeCollections,
  evaluateRoleDrift,
  gitHead,
  gitRemoteUrl,
  pathAllowlistValid,
  pathMatchesAllowlist,
  registerRoleSkillOverlay,
  runAutonomousCycle,
  runAgentRuntimeWorker,
  selectModel,
  syncSkillSource
} from "../control-plane-ui/lib/control-plane-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runtimeDir = resolve(root, process.env.AIMAC_RUNTIME_DIR || ".runtime");
const statePath = resolve(runtimeDir, "control-plane-state.json");
const seedPath = resolve(root, "data", "seed-state.json");
const repositoryRoot = resolve(process.env.AIMAC_REPOSITORY_ROOT || root);
const mcpAuditPath = resolve(runtimeDir, "mcp-audit.jsonl");
const mcpTokenPath = resolve(runtimeDir, "mcp-client-token");

export const mcpToolGroups = {
  "orchestration-mcp": ["project_create", "task_group_create", "work_item_create", "work_assign", "orchestrator_run", "state_get"],
  "room-mcp": ["room_join", "room_send", "room_wait", "room_ack"],
  "agent-control-mcp": ["node_register", "node_probe", "session_start", "session_pause", "session_cancel", "session_recover", "runtime_run"],
  "scheduler-mcp": ["model_select", "session_place", "work_assign", "capacity_snapshot", "execution_topology_plan", "derived_task_classify"],
  "resource-mcp": ["lease_claim", "lease_release", "resource_snapshot"],
  "model-mcp": ["model_capabilities", "model_policy_get", "model_select"],
  "skill-mcp": ["skill_source_sync", "role_skill_parse", "role_skill_overlay_validate", "role_skill_resolve"],
  "evidence-mcp": ["artifact_register", "checkpoint_submit", "test_result_submit"],
  "permission-mcp": ["permission_probe", "permission_request_submit", "permission_status", "permission_resolve"],
  "review-mcp": ["review_plan_create", "review_bundle_register", "review_result_consume", "completion_readiness_compute"],
  "governance-mcp": [
    "approval_request_create",
    "policy_decision_eval",
    "finding_submit",
    "contract_publish",
    "effective_instruction_create",
    "role_drift_guard_bind",
    "role_drift_rebound",
    "rule_source_resolve",
    "runtime_issue_pattern_submit",
    "system_upgrade_candidate_export",
    "system_upgrade_external_import",
    "close_barrier_compute"
  ],
  "identity-mcp": ["account_invite", "account_suspend", "grant_create", "grant_revoke", "permission_matrix_get"],
  "ui-console-mcp": ["runtime_health_get", "management_surface_get", "project_progress_get", "task_group_progress_get", "guarded_action_dispatch"],
  "definition-mcp": ["shared_definition_create", "shared_definition_publish", "shared_definition_consumer_bind", "shared_definition_conflict_report"],
  "instruction-mcp": ["instruction_envelope_create", "cache_key_index", "stable_prefix_get", "delta_payload_compact"],
  "repository-mcp": ["repository_output_target_select", "repository_target_lease_bind", "artifact_manifest_index"]
};

export const mcpToolNames = Object.entries(mcpToolGroups).flatMap(([serverId, tools]) => tools.map((tool) => `${serverId}.${tool}`));

const toolDescriptions = {
  "orchestration-mcp.project_create": "Create a project control object and initialize scoped progress state.",
  "orchestration-mcp.task_group_create": "Create a task group under a project with AI-native work items.",
  "orchestration-mcp.work_item_create": "Create one bounded work item inside a task group.",
  "orchestration-mcp.work_assign": "Assign a work item to a role and update scheduler state.",
  "orchestration-mcp.orchestrator_run": "Run one autonomous orchestrator cycle and enqueue AgentDispatch work.",
  "orchestration-mcp.state_get": "Read the authoritative control-plane state through the MCP proxy boundary.",
  "room-mcp.room_join": "Create or refresh a deterministic room participant handle for an agent session.",
  "room-mcp.room_send": "Append a machine-readable room message to the durable room log.",
  "room-mcp.room_wait": "Read room messages after a cursor without depending on live websocket state.",
  "room-mcp.room_ack": "Acknowledge processed room messages for replay-safe agent coordination.",
  "agent-control-mcp.node_register": "Register or refresh an Agent Runtime node profile.",
  "agent-control-mcp.node_probe": "Capture node capability, tool, MCP, Git and quota signals.",
  "agent-control-mcp.session_start": "Create an AgentTaskContract and WorkSession for a selected work item.",
  "agent-control-mcp.session_pause": "Pause an active work session and its queued dispatch.",
  "agent-control-mcp.session_cancel": "Cancel an active work session and its queued dispatch.",
  "agent-control-mcp.session_recover": "Recover a paused or failed session into active state.",
  "agent-control-mcp.runtime_run": "Run the Agent Runtime worker against queued dispatches with checkpoint evidence rules.",
  "scheduler-mcp.model_select": "Select the best available model for a role and task requirement.",
  "scheduler-mcp.session_place": "Choose new-session or subagent placement from machine signals.",
  "scheduler-mcp.work_assign": "Assign a role to a work item using the scheduler policy surface.",
  "scheduler-mcp.capacity_snapshot": "Return scheduler-visible session and agent capacity.",
  "scheduler-mcp.execution_topology_plan": "Create an execution topology plan for a task group.",
  "scheduler-mcp.derived_task_classify": "Classify a derived task request without running it.",
  "resource-mcp.lease_claim": "Claim a bounded resource lease for a repository output target.",
  "resource-mcp.lease_release": "Release a resource lease and unblock follow-on dispatches.",
  "resource-mcp.resource_snapshot": "Return active leases and repository output target state.",
  "model-mcp.model_capabilities": "Return model provider capability profiles for common model providers.",
  "model-mcp.model_policy_get": "Return model selection policy for a role.",
  "model-mcp.model_select": "Select a model through the model registry surface.",
  "skill-mcp.skill_source_sync": "Sync and index the pinned agency-agents-zh role skill source.",
  "skill-mcp.role_skill_parse": "Return parsed role skills by source, category or capability.",
  "skill-mcp.role_skill_overlay_validate": "Create and validate a project/task-group role skill overlay.",
  "skill-mcp.role_skill_resolve": "Resolve the effective role skill with task-group then project precedence.",
  "evidence-mcp.artifact_register": "Register artifact metadata produced by an Agent Runtime.",
  "evidence-mcp.checkpoint_submit": "Submit a checkpoint and bind it to dispatch, Git and artifact evidence.",
  "evidence-mcp.test_result_submit": "Record machine test results as evidence for readiness gates.",
  "permission-mcp.permission_probe": "Evaluate whether a scoped permission or grant exists.",
  "permission-mcp.permission_request_submit": "Submit a structured permission request for policy resolution.",
  "permission-mcp.permission_status": "Read a permission request state.",
  "permission-mcp.permission_resolve": "Resolve a permission request and record the policy decision.",
  "review-mcp.review_plan_create": "Create an independent review plan for a task group.",
  "review-mcp.review_bundle_register": "Register review evidence bundle metadata.",
  "review-mcp.review_result_consume": "Consume review results into findings and readiness state.",
  "review-mcp.completion_readiness_compute": "Compute task-group completion readiness.",
  "governance-mcp.approval_request_create": "Create a machine approval request for high-risk actions.",
  "governance-mcp.policy_decision_eval": "Evaluate and record a policy decision for an action.",
  "governance-mcp.finding_submit": "Submit a governance, review, quality or security finding.",
  "governance-mcp.contract_publish": "Publish a shared contract record for downstream agents.",
  "governance-mcp.effective_instruction_create": "Create a compact effective instruction envelope.",
  "governance-mcp.role_drift_guard_bind": "Bind or refresh a role drift guard.",
  "governance-mcp.role_drift_rebound": "Evaluate drift and return corrective action state.",
  "governance-mcp.rule_source_resolve": "Classify external/source material before it can affect active rules.",
  "governance-mcp.runtime_issue_pattern_submit": "Collect repeated runtime issue patterns without self-upgrading.",
  "governance-mcp.system_upgrade_candidate_export": "Export collected upgrade candidates for external maintenance.",
  "governance-mcp.system_upgrade_external_import": "Import externally maintained upgrade package metadata.",
  "governance-mcp.close_barrier_compute": "Compute the close barrier for a task group.",
  "identity-mcp.account_invite": "Create a scoped user account invite record.",
  "identity-mcp.account_suspend": "Suspend an account and revoke active grants.",
  "identity-mcp.grant_create": "Create a scoped access grant.",
  "identity-mcp.grant_revoke": "Revoke a scoped access grant.",
  "identity-mcp.permission_matrix_get": "Return account, role and grant permission matrix.",
  "ui-console-mcp.runtime_health_get": "Return runtime health, services and command availability.",
  "ui-console-mcp.management_surface_get": "Return system and user management console surfaces.",
  "ui-console-mcp.project_progress_get": "Return project progress snapshot.",
  "ui-console-mcp.task_group_progress_get": "Return task-group progress snapshot.",
  "ui-console-mcp.guarded_action_dispatch": "Record a guarded console action through policy and audit.",
  "definition-mcp.shared_definition_create": "Create a canonical shared definition contract.",
  "definition-mcp.shared_definition_publish": "Publish a shared definition after ownership is established.",
  "definition-mcp.shared_definition_consumer_bind": "Bind a consumer task or role to a shared definition.",
  "definition-mcp.shared_definition_conflict_report": "Report conflicting shared definition semantics.",
  "instruction-mcp.instruction_envelope_create": "Create an instruction envelope optimized for token reuse.",
  "instruction-mcp.cache_key_index": "Return stable instruction cache keys and digests.",
  "instruction-mcp.stable_prefix_get": "Return stable instruction prefix references for a role/task.",
  "instruction-mcp.delta_payload_compact": "Compact a tool or agent payload into digest-first deltas.",
  "repository-mcp.repository_output_target_select": "Select or create a repository output target for a work item.",
  "repository-mcp.repository_target_lease_bind": "Bind an active lease to a repository output target.",
  "repository-mcp.artifact_manifest_index": "Index artifact manifests that live inside project Git repositories."
};

function loadState() {
  mkdirSync(runtimeDir, {recursive: true});
  ensureStoredState({root, runtimeDir, statePath, seedPath, buildInitialState});
  const state = readStoredState({root, runtimeDir, statePath, seedPath, buildInitialState});
  ensureRuntimeCollections(state, {root, runtimeDir});
  ensureMcpCollections(state);
  markRuntimeStorage(state, ".runtime/control-plane-state.json");
  return state;
}

function writeState(state) {
  ensureMcpCollections(state);
  markRuntimeStorage(state, ".runtime/control-plane-state.json");
  writeStoredState(state, {root, runtimeDir, statePath, seedPath, buildInitialState, expectedStateVersion: state.__loadedStateVersion});
}

function buildInitialState() {
  const state = JSON.parse(readFileSync(seedPath, "utf8"));
  ensureRuntimeCollections(state, {root, runtimeDir});
  ensureMcpCollections(state);
  markRuntimeStorage(state, ".runtime/control-plane-state.json");
  return state;
}

function ensureMcpCollections(state) {
  state.roomParticipants ||= [];
  state.roomMessages ||= [];
  state.roomAcks ||= [];
  state.agentRuntimeNodes ||= [];
  state.permissionRequests ||= [];
  state.approvalRequests ||= [];
  state.artifacts ||= [];
  state.testResults ||= [];
  state.ruleSourceResolutions ||= [];
  state.mcpGrants ||= [];
  state.mcpCalls ||= [];
  state.leaseSequence ||= 0;
  state.externalUpgradeImports ||= [];
  state.runtime ||= {};
  state.runtime.commands ||= {};
  state.runtime.commands.mcpStart ||= "npm run mcp:start";
  state.runtime.commands.mcpRegister ||= "npm run mcp:register";
  state.runtime.commands.mcpDoctor ||= "npm run mcp:doctor";
  state.runtime.mcp ||= {
    protocol: "mcp/json-rpc-stdio",
    serverId: "ai-multi-agent-ctrl",
    logicalServers: Object.keys(mcpToolGroups),
    toolCount: mcpToolNames.length,
    startupCommand: "npm run mcp:start",
    registrationCommand: "npm run mcp:register",
    doctorCommand: "npm run mcp:doctor"
  };
  ensureDefaultMcpGrants(state);
}

export function createMcpToolDefinitions() {
  return mcpToolNames.map((name) => ({
    name,
    title: name,
    description: toolDescriptions[name] || `Execute ${name} through the AI multi-agent control-plane MCP proxy.`,
    inputSchema: inputSchemaFor(name),
    outputSchema: {
      type: "object",
      properties: {
        ok: {type: "boolean"},
        tool: {type: "string"},
        stateVersion: {type: "integer"}
      },
      required: ["ok", "tool"]
    },
    annotations: {
      readOnlyHint: isReadOnlyTool(name),
      destructiveHint: false,
      idempotentHint: !isWriteTool(name)
    }
  }));
}

function inputSchemaFor(name) {
  const base = {
    type: "object",
    properties: commonInputProperties(),
    additionalProperties: false,
    ...(requiredInputPropertiesFor(name).length ? {required: requiredInputPropertiesFor(name)} : {})
  };
  if (isReadOnlyTool(name)) return base;
  return {
    ...base,
    properties: {
      ...base.properties,
      actionReason: {type: "string"},
      dryRun: {type: "boolean"}
    },
    ...(requiredInputPropertiesFor(name).length ? {required: requiredInputPropertiesFor(name)} : {})
  };
}

function requiredInputPropertiesFor(name) {
  return {
    "orchestration-mcp.work_item_create": ["taskGroupId"],
    "orchestration-mcp.work_assign": ["taskGroupId", "workItemId", "roleId"],
    "orchestration-mcp.orchestrator_run": ["taskGroupId"],
    "agent-control-mcp.session_start": ["taskGroupId", "workItemId"],
    "agent-control-mcp.session_pause": ["sessionId"],
    "agent-control-mcp.session_cancel": ["sessionId"],
    "agent-control-mcp.session_recover": ["sessionId"],
    "scheduler-mcp.model_select": ["taskGroupId", "workItemId", "roleId"],
    "scheduler-mcp.session_place": ["taskGroupId", "workItemId", "roleId"],
    "scheduler-mcp.work_assign": ["taskGroupId", "workItemId", "roleId"],
    "scheduler-mcp.execution_topology_plan": ["taskGroupId"],
    "model-mcp.model_select": ["taskGroupId", "workItemId", "roleId"],
    "resource-mcp.lease_release": ["leaseId", "holderRef", "fencingToken"],
    "skill-mcp.role_skill_overlay_validate": ["roleSkillRef"],
    "evidence-mcp.checkpoint_submit": ["taskGroupId", "workId", "sessionId", "runId"],
    "permission-mcp.permission_status": ["requestId"],
    "permission-mcp.permission_resolve": ["requestId"],
    "identity-mcp.account_suspend": ["accountId"],
    "identity-mcp.grant_revoke": ["grantId"],
    "definition-mcp.shared_definition_publish": ["contractId"],
    "definition-mcp.shared_definition_consumer_bind": ["contractId"],
    "definition-mcp.shared_definition_conflict_report": ["contractId"],
    "repository-mcp.repository_output_target_select": ["taskGroupId", "workItemId"],
    "repository-mcp.repository_target_lease_bind": ["holderRef"]
  }[name] || [];
}

function commonInputProperties() {
  const string = {type: "string"};
  const number = {type: "number"};
  const boolean = {type: "boolean"};
  const array = {type: "array"};
  const object = {type: "object"};
  return {
    accountId: string,
    action: string,
    actionReason: string,
    afterSequence: number,
    allowed: boolean,
    autoSyncSkills: boolean,
    approvalId: string,
    artifactId: string,
    artifactManifestPath: string,
    artifactManifestRef: string,
    artifactManifestRefs: array,
    artifactRefs: array,
    baseRef: string,
    branch: string,
    capability: string,
    capabilityFlags: array,
    category: string,
    checkpointRefs: array,
    classification: string,
    command: string,
    commitRefs: array,
    conflictPolicy: object,
    consumerRef: string,
    consumerRefs: array,
    contractId: string,
    cursor: number,
    decisionRecordRef: string,
    definition: object,
    definitionType: string,
    delta: object,
    description: string,
    digestRefs: array,
    displayName: string,
    dryRun: boolean,
    edges: array,
    effectiveInstructionPacketRef: string,
    email: string,
    endpoint: string,
    envelopeId: string,
    evidenceRefs: array,
    expiresAt: string,
    externalUpgradePackageRef: string,
    fencingToken: string,
    findingId: string,
    findingType: string,
    grantId: string,
    grantPermissions: array,
    grantRole: string,
    hardConstraints: object,
    holderRef: string,
    idempotencyKey: string,
    leaseId: string,
    locatorRefs: array,
    maxJobs: number,
    mcpGrantId: string,
    messageId: string,
    mode: string,
    modelSelectionDecision: object,
    name: string,
    nodeId: string,
    objective: string,
    openMachineActionIds: array,
    outputContractDigest: string,
    outputContractRef: string,
    outputRefs: array,
    ownerAccountId: string,
    ownerRole: string,
    packageRef: string,
    participantId: string,
    patch: object,
    path: string,
    pathAllowlist: array,
    payload: object,
    permission: string,
    projectId: string,
    pushRefs: array,
    quorum: number,
    reason: string,
    recipientRole: string,
    remote: string,
    repositoryId: string,
    repositoryLeaseRef: string,
    repositoryOutputTargetRef: string,
    repositoryOutputTargetRefs: array,
    repositoryRefs: array,
    repositoryRoot: string,
    repositoryUrl: string,
    requestId: string,
    requiredApprovers: array,
    requiredCapabilities: array,
    requiredReviewerRoles: array,
    requirements: array,
    resource: object,
    resourceId: string,
    resourceType: string,
    returnPointRef: string,
    reviewBundleId: string,
    reviewEvidenceRefs: array,
    reviewPlanId: string,
    reviewScopeRefs: array,
    riskClass: string,
    roleId: string,
    roleSkillRef: string,
    roles: array,
    roomId: string,
    runId: string,
    scope: string,
    scopeRefs: array,
    selectionMode: string,
    senderRef: string,
    sessionId: string,
    severity: string,
    sourceId: string,
    sourceRef: string,
    sourceScope: string,
    stablePrefix: string,
    stableRefs: array,
    status: string,
    subjectId: string,
    subjectRef: object,
    summary: string,
    targetId: string,
    taskGroupId: string,
    text: string,
    title: string,
    tokenBudget: object,
    toolSignals: array,
    trustScore: number,
    workId: string,
    workItem: object,
    workItemId: string,
    workSignals: array
  };
}

function isReadOnlyTool(name) {
  return [
    ".state_get",
    ".room_wait",
    ".node_probe",
    ".capacity_snapshot",
    ".resource_snapshot",
    ".model_capabilities",
    ".model_policy_get",
    ".role_skill_parse",
    ".role_skill_resolve",
    ".permission_probe",
    ".permission_status",
    ".completion_readiness_compute",
    ".close_barrier_compute",
    ".permission_matrix_get",
    ".runtime_health_get",
    ".management_surface_get",
    ".project_progress_get",
    ".task_group_progress_get",
    ".cache_key_index",
    ".stable_prefix_get"
  ].some((suffix) => name.endsWith(suffix));
}

function isWriteTool(name) {
  return !isReadOnlyTool(name);
}

async function callTool(name, args = {}) {
  if (!mcpToolNames.includes(name)) {
    const error = new Error(`Unknown tool: ${name}`);
    error.code = -32602;
    throw error;
  }
  const state = loadState();
  const beforeVersion = Number(state.stateVersion || 1);
  const idempotencyKey = args.idempotencyKey || null;
  const argumentDigest = digestOf(sanitizeArgs(args));
  let result;
  const inputValidation = validateInputArgs(name, args);
  if (!inputValidation.ok) {
    result = inputValidation;
  } else if (isWriteTool(name) && !idempotencyKey) {
    result = {ok: false, error: "idempotency_key_required"};
  } else {
    const existingRecord = isWriteTool(name) ? state.idempotencyRecords[idempotencyKey] : null;
    if (existingRecord && (existingRecord.action !== name || existingRecord.argumentDigest !== argumentDigest)) {
      result = {ok: false, error: "idempotency_key_reuse_conflict", idempotencyKey};
    } else if (existingRecord) {
      result = {ok: true, replayed: true, idempotencyRecord: existingRecord, payload: existingRecord.payload};
    } else {
      const grantCheck = validateMcpGrant(state, name, args, argumentDigest);
      if (!grantCheck.allowed) {
        result = {ok: false, error: grantCheck.error, grantRef: grantCheck.grantRef, required: grantCheck.required};
      } else {
        const policyDecision = isWriteTool(name)
      ? policyDecisionEval(state, {
          action: `mcp:${name}`,
          resource: {resourceType: "mcp_tool", resourceId: name},
          subjectRef: {subjectType: "service", subjectId: "mcp-proxy"},
          allowed: true,
          reasonCode: "local_mcp_proxy_grant",
          evidenceRefs: [grantCheck.grantRef, `argument:${argumentDigest}`]
        }).policyDecision
      : null;
        result = isWriteTool(name) && args.dryRun
          ? {ok: true, dryRun: true, wouldCall: name, argumentDigest}
          : await dispatchTool(state, name, sanitizeArgs(args));
        if (policyDecision && result && typeof result === "object") result.policyDecisionRef = policyDecision.decisionId;
        if (grantCheck.grantRef && result && typeof result === "object") result.mcpGrantRef = grantCheck.grantRef;
        if (isWriteTool(name) && idempotencyKey && result.ok !== false && !args.dryRun) {
          state.idempotencyRecords[idempotencyKey] = {
            status: 200,
            action: name,
            argumentDigest,
            resultDigest: digestOf(result),
            payload: result,
            policyDecisionRef: policyDecision?.decisionId,
            mcpGrantRef: grantCheck.grantRef,
            createdAt: new Date().toISOString()
          };
        }
      }
    }
  }
  const at = new Date().toISOString();
  const mcpCall = {
    callId: createId("mcp_call"),
    toolName: name,
    idempotencyKey: args.idempotencyKey || createId("idem_mcp"),
    status: result.ok === false ? "failed" : "succeeded",
    readOnly: isReadOnlyTool(name),
    argumentDigest,
    resultDigest: digestOf(result),
    untrustedResult: true,
    createdAt: at
  };
  appendMcpAudit(mcpCall);
  if (isWriteTool(name)) {
    state.mcpCalls.unshift(mcpCall);
    state.mcpCalls = state.mcpCalls.slice(0, 300);
  }
  try {
    if (isWriteTool(name) && result.ok !== false && !result.replayed && !args.dryRun) {
      state.stateVersion = beforeVersion + 1;
      writeState(state);
    } else if (result.ok === false) {
      if (isWriteTool(name) && !args.dryRun) writeState(state);
    } else if (isWriteTool(name) && !args.dryRun) {
      writeState(state);
    }
  } catch (error) {
    if (!isStateStoreConflict(error)) throw error;
    result = {ok: false, error: "state_write_conflict", retryable: true, message: error.message};
    return {
      ok: false,
      tool: name,
      stateVersion: beforeVersion,
      result,
      untrustedResult: true,
      auditRef: mcpCall.callId
    };
  }
  return {
    ok: result.ok !== false,
    tool: name,
    stateVersion: state.stateVersion,
    result,
    untrustedResult: true,
    auditRef: mcpCall.callId
  };
}

function validateInputArgs(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {ok: false, error: "mcp_input_must_be_object"};
  }
  const schema = inputSchemaFor(name);
  const properties = schema.properties || {};
  for (const key of Object.keys(args)) {
    if (!properties[key]) return {ok: false, error: "mcp_input_unknown_property", property: key};
    if (!schemaTypeMatches(args[key], properties[key].type)) {
      return {ok: false, error: "mcp_input_type_mismatch", property: key, expectedType: properties[key].type};
    }
  }
  for (const key of requiredInputPropertiesFor(name)) {
    if (!hasInputArg(args, key)) return {ok: false, error: "mcp_required_argument_missing", argument: key};
  }
  if (name === "resource-mcp.lease_claim" && !hasAnyInputArg(args, ["repositoryOutputTargetRef", "targetId"])) {
    return {ok: false, error: "mcp_required_argument_missing", argument: "repositoryOutputTargetRef"};
  }
  if (name === "repository-mcp.repository_target_lease_bind" && !hasAnyInputArg(args, ["repositoryOutputTargetRef", "targetId"])) {
    return {ok: false, error: "mcp_required_argument_missing", argument: "repositoryOutputTargetRef"};
  }
  if (name === "repository-mcp.repository_output_target_select") {
    const pathAllowlist = args.pathAllowlist || ["docs/**", "apps/**", "scripts/**", "spec/**", "data/**", "package.json", "Dockerfile", "docker-compose.yml", "README.md"];
    const artifactManifestPath = args.artifactManifestPath || `docs/artifact-manifests/${args.workItemId}.json`;
    if (!pathAllowlistValid(pathAllowlist) || !canUseGitPath(artifactManifestPath)) {
      return {ok: false, error: "repository_output_target_must_use_git_trackable_paths"};
    }
    if (!pathMatchesAllowlist(artifactManifestPath, pathAllowlist)) {
      return {ok: false, error: "artifact_manifest_outside_allowlist"};
    }
  }
  return {ok: true};
}

function schemaTypeMatches(value, expectedType) {
  if (value === undefined) return true;
  if (expectedType === "array") return Array.isArray(value);
  if (expectedType === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (expectedType === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === expectedType;
}

function hasInputArg(args, key) {
  if (args[key] === undefined || args[key] === null) return false;
  if (typeof args[key] === "string") return args[key].trim().length > 0;
  if (Array.isArray(args[key])) return args[key].length > 0;
  return true;
}

function hasAnyInputArg(args, keys) {
  return keys.some((key) => hasInputArg(args, key));
}

function ensureDefaultMcpGrants(state) {
  const at = new Date().toISOString();
  const existing = new Set(state.mcpGrants.map((grant) => grant.grantId));
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  for (const toolName of mcpToolNames) {
    const readOnly = isReadOnlyTool(toolName);
    if (!readOnly && !localMcpWriteEnabled(state)) continue;
    const grantId = defaultMcpGrantId(toolName);
    if (existing.has(grantId)) continue;
    state.mcpGrants.push(createMcpGrant(toolName, {issuedAt: at, expiresAt, tokenDigest: state.runtime?.mcp?.localTokenDigest}));
  }
}

export function createMcpGrant(toolName, options = {}) {
  const readOnly = isReadOnlyTool(toolName);
  const [serverId] = toolName.split(".");
  const issuedAt = options.issuedAt || new Date().toISOString();
  const expiresAt = options.expiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const seed = {
    grantId: options.grantId || defaultMcpGrantId(toolName),
    projectId: options.projectId || "prj_control_plane",
    taskGroupId: options.taskGroupId || "tg_runtime_management",
    workId: options.workId || "*",
    sessionId: options.sessionId || "local-mcp-stdio",
    agentNodeId: options.agentNodeId || (readOnly ? "local-mcp-read-client" : "local-mcp-write-client"),
    serverId,
    toolName,
    resource: `mcp://${toolName}`,
    action: `mcp:${toolName}`,
    issuedAt,
    expiresAt
  };
  return {
    ...seed,
    schemaDigest: digestOf(`mcp-tool:${toolName}:v1`),
    policyDecisionRef: `policy:mcp:${toolName}`,
    approvalRequestRef: readOnly ? "approval:not-required:read-only" : "approval:local-stdio-bootstrap",
    riskLevel: readOnly ? "L0" : riskLevelForTool(toolName),
    paramPolicyRef: `policy://mcp/default/${toolName}`,
    paramPolicyDigest: digestOf({toolName, requiresIdempotency: !readOnly, dryRunSupported: true, tokenDigest: options.tokenDigest || null}),
    resultFilterRef: "filter://mcp/default-redaction",
    resultFilterDigest: digestOf("filter://mcp/default-redaction"),
      leaseRef: readOnly ? "lease:not-required:read-only" : leaseRequiredForTool(toolName) ? "lease:tool-scope-required" : "lease:not-required:tool",
    idempotencyKey: readOnly ? "read-only" : "*",
    maxTtl: "P30D",
    grantStatus: "issued",
    revocationRef: "revocation:none",
    auditRef: `audit:mcp-grant:${seed.grantId}`,
    grantDigest: digestOf({...seed, tokenDigest: options.tokenDigest || null})
  };
}

function localMcpWriteEnabled(state) {
  if (process.env.AIMAC_MCP_LOCAL_WRITE_ENABLE !== "true") return false;
  const tokenDigest = currentMcpTokenDigest();
  if (!tokenDigest) return false;
  state.runtime ||= {};
  state.runtime.mcp ||= {};
  state.runtime.mcp.localTokenDigest ||= tokenDigest;
  return state.runtime.mcp.localTokenDigest === tokenDigest;
}

function currentMcpTokenDigest() {
  const token = process.env.AIMAC_MCP_TOKEN;
  if (!token || !existsSync(mcpTokenPath)) return null;
  const storedToken = readFileSync(mcpTokenPath, "utf8").trim();
  if (!storedToken || storedToken !== token) return null;
  return digestOf(`mcp-token:${storedToken}`);
}

function defaultMcpGrantId(toolName) {
  return `mcp_grant_local_${toolName.replace(/[^A-Za-z0-9_]+/gu, "_")}`;
}

function validateMcpGrant(state, toolName, args, argumentDigest) {
  const readOnly = isReadOnlyTool(toolName);
  if (!readOnly && !localMcpWriteEnabled(state)) {
    return {allowed: false, error: "mcp_write_token_binding_required", required: "run through npm run mcp:register generated client config so AIMAC_MCP_TOKEN matches .runtime/mcp-client-token"};
  }
  if (!readOnly && !args.mcpGrantId && !state.mcpGrants.some((grant) => grant.grantId === defaultMcpGrantId(toolName))) {
    return {allowed: false, error: "mcp_write_grant_required", required: "active local McpGrant"};
  }
  if (toolName === "agent-control-mcp.runtime_run" && process.env.AIMAC_MCP_ENABLE_RUNTIME_RUN !== "true") {
    return {allowed: false, error: "agent_runtime_worker_mcp_disabled", required: "AIMAC_MCP_ENABLE_RUNTIME_RUN=true plus service scoped grant"};
  }
  const [serverId] = toolName.split(".");
  const grantId = args.mcpGrantId || defaultMcpGrantId(toolName);
  const grant = state.mcpGrants.find((item) => item.grantId === grantId);
  if (!grant) return {allowed: false, error: "mcp_grant_not_found", grantRef: grantId};
  if (grant.grantStatus !== "issued") return {allowed: false, error: "mcp_grant_not_active", grantRef: grant.grantId};
  if (new Date(grant.expiresAt).getTime() <= Date.now()) {
    grant.grantStatus = "expired";
    return {allowed: false, error: "mcp_grant_expired", grantRef: grant.grantId};
  }
  if (grant.serverId !== serverId) return {allowed: false, error: "mcp_grant_server_mismatch", grantRef: grant.grantId};
  if (grant.toolName !== toolName && grant.toolName !== "*") return {allowed: false, error: "mcp_grant_tool_mismatch", grantRef: grant.grantId};
  if (grant.projectId !== "*" && args.projectId && grant.projectId !== args.projectId) return {allowed: false, error: "mcp_grant_project_scope_mismatch", grantRef: grant.grantId};
  if (grant.taskGroupId !== "*" && args.taskGroupId && grant.taskGroupId !== args.taskGroupId) return {allowed: false, error: "mcp_grant_task_group_scope_mismatch", grantRef: grant.grantId};
  if (grant.workId !== "*" && (args.workItemId || args.workId) && grant.workId !== (args.workItemId || args.workId)) return {allowed: false, error: "mcp_grant_work_scope_mismatch", grantRef: grant.grantId};
  if (grant.idempotencyKey !== "*" && !readOnly && args.idempotencyKey && grant.idempotencyKey !== args.idempotencyKey) return {allowed: false, error: "mcp_grant_idempotency_mismatch", grantRef: grant.grantId};
  if (leaseRequiredForTool(toolName) && !["resource-mcp.lease_claim", "repository-mcp.repository_target_lease_bind"].includes(toolName)) {
    const leaseId = args.leaseId || args.leaseRef || args.repositoryLeaseRef;
    const lease = state.leases.find((item) => item.leaseId === leaseId && item.status === "active");
    if (!lease) return {allowed: false, error: "active_mcp_lease_required", grantRef: grant.grantId};
    if (!args.fencingToken) return {allowed: false, error: "mcp_lease_fencing_token_required", grantRef: grant.grantId};
    if (String(lease.fencingToken) !== String(args.fencingToken)) return {allowed: false, error: "mcp_lease_fencing_token_mismatch", grantRef: grant.grantId};
    if (args.holderRef && lease.holderRef !== args.holderRef) return {allowed: false, error: "mcp_lease_holder_mismatch", grantRef: grant.grantId};
    if (args.sessionId && lease.holderRef !== `session:${args.sessionId}`) return {allowed: false, error: "mcp_lease_session_mismatch", grantRef: grant.grantId};
  }
  if (toolName === "agent-control-mcp.runtime_run") {
    const serviceAccount = state.accounts.find((account) => account.accountId === "acct_agent_runtime" && account.accountType === "service_account" && (account.roles || []).includes("service_agent_runtime"));
    const serviceGrant = state.accessGrants.find((accessGrant) =>
      accessGrant.status === "active" &&
      accessGrant.subjectRef?.subjectId === "acct_agent_runtime" &&
      (accessGrant.permissions || []).includes("task_group:orchestrate") &&
      (!args.taskGroupId || accessGrant.resource?.resourceId === args.taskGroupId)
    );
    if (!serviceAccount || !serviceGrant) return {allowed: false, error: "service_agent_runtime_grant_required", grantRef: grant.grantId};
  }
  return {allowed: true, grantRef: grant.grantId, argumentDigest};
}

function leaseRequiredForTool(toolName) {
  return [
    "agent-control-mcp.runtime_run",
    "evidence-mcp.checkpoint_submit",
    "resource-mcp.lease_release"
  ].includes(toolName);
}

function riskLevelForTool(toolName) {
  if (toolName === "agent-control-mcp.runtime_run" || toolName === "evidence-mcp.checkpoint_submit") return "L3";
  if (toolName.includes("grant") || toolName.includes("account") || toolName.includes("approval") || toolName.includes("lease")) return "L2";
  return "L1";
}

function appendMcpAudit(event) {
  mkdirSync(runtimeDir, {recursive: true});
  appendFileSync(mcpAuditPath, `${JSON.stringify(event)}\n`);
}

async function dispatchTool(state, name, args) {
  switch (name) {
    case "orchestration-mcp.project_create":
      return createProject(state, args);
    case "orchestration-mcp.task_group_create":
      return createTaskGroup(state, args);
    case "orchestration-mcp.work_item_create":
      return createWorkItem(state, args);
    case "orchestration-mcp.work_assign":
    case "scheduler-mcp.work_assign":
      return assignWorkItem(state, args);
    case "orchestration-mcp.orchestrator_run":
      return runAutonomousCycle(state, {...args, root: args.repositoryRoot || repositoryRoot, runtimeDir});
    case "orchestration-mcp.state_get":
      return stateGet(state, args);
    case "room-mcp.room_join":
      return roomJoin(state, args);
    case "room-mcp.room_send":
      return roomSend(state, args);
    case "room-mcp.room_wait":
      return roomWait(state, args);
    case "room-mcp.room_ack":
      return roomAck(state, args);
    case "agent-control-mcp.node_register":
      return nodeRegister(state, args);
    case "agent-control-mcp.node_probe":
      return nodeProbe(state, args);
    case "agent-control-mcp.session_start":
      return sessionStart(state, args);
    case "agent-control-mcp.session_pause":
      return sessionMutate(state, args, "paused");
    case "agent-control-mcp.session_cancel":
      return sessionMutate(state, args, "cancelled");
    case "agent-control-mcp.session_recover":
      return sessionMutate(state, args, "active");
    case "agent-control-mcp.runtime_run":
      return runAgentRuntimeWorker(state, {...args, root: args.repositoryRoot || repositoryRoot, repositoryRoot: args.repositoryRoot || repositoryRoot});
    case "scheduler-mcp.model_select":
    case "model-mcp.model_select":
      return selectModel(state, args);
    case "scheduler-mcp.session_place":
      return decideSessionPlacement(state, args);
    case "scheduler-mcp.capacity_snapshot":
      return capacitySnapshot(state);
    case "scheduler-mcp.execution_topology_plan":
      return createExecutionTopology(state, args);
    case "scheduler-mcp.derived_task_classify":
      return classifyDerivedTask(state, args);
    case "resource-mcp.lease_claim":
      return claimLease(state, args);
    case "resource-mcp.lease_release":
      return releaseLease(state, args);
    case "resource-mcp.resource_snapshot":
      return resourceSnapshot(state, args);
    case "model-mcp.model_capabilities":
      return {modelCapabilities: state.modelCapabilities};
    case "model-mcp.model_policy_get":
      return modelPolicyGet(state, args);
    case "skill-mcp.skill_source_sync":
      return syncSkillSource(state, args.sourceId || "agency-agents-zh", {root, runtimeDir});
    case "skill-mcp.role_skill_parse":
      return roleSkillParse(state, args);
    case "skill-mcp.role_skill_overlay_validate":
      return registerRoleSkillOverlay(state, args);
    case "skill-mcp.role_skill_resolve":
      return resolveRoleSkillView(state, args);
    case "evidence-mcp.artifact_register":
      return artifactRegister(state, args);
    case "evidence-mcp.checkpoint_submit":
      return acceptAgentCheckpoint(state, args, {root: args.repositoryRoot || repositoryRoot});
    case "evidence-mcp.test_result_submit":
      return testResultSubmit(state, args);
    case "permission-mcp.permission_probe":
      return permissionProbe(state, args);
    case "permission-mcp.permission_request_submit":
      return permissionRequestSubmit(state, args);
    case "permission-mcp.permission_status":
      return permissionStatus(state, args);
    case "permission-mcp.permission_resolve":
      return permissionResolve(state, args);
    case "review-mcp.review_plan_create":
      return reviewPlanCreate(state, args);
    case "review-mcp.review_bundle_register":
      return reviewBundleRegister(state, args);
    case "review-mcp.review_result_consume":
      return reviewResultConsume(state, args);
    case "review-mcp.completion_readiness_compute":
      return computeCompletionReadiness(state, args.taskGroupId || "tg_runtime_management", args);
    case "governance-mcp.approval_request_create":
      return approvalRequestCreate(state, args);
    case "governance-mcp.policy_decision_eval":
      return policyDecisionEval(state, args);
    case "governance-mcp.finding_submit":
      return findingSubmit(state, args);
    case "governance-mcp.contract_publish":
      return contractPublish(state, args);
    case "governance-mcp.effective_instruction_create":
      return instructionEnvelopeCreate(state, args, "effective_instruction_packet");
    case "governance-mcp.role_drift_guard_bind":
      return roleDriftGuardBind(state, args);
    case "governance-mcp.role_drift_rebound":
      return evaluateRoleDrift(state, args);
    case "governance-mcp.rule_source_resolve":
      return ruleSourceResolve(state, args);
    case "governance-mcp.runtime_issue_pattern_submit":
      return collectRuntimeIssue(state, args);
    case "governance-mcp.system_upgrade_candidate_export":
      return systemUpgradeCandidateExport(state, args);
    case "governance-mcp.system_upgrade_external_import":
      return systemUpgradeExternalImport(state, args);
    case "governance-mcp.close_barrier_compute":
      return computeCloseBarrier(state, args.taskGroupId || "tg_runtime_management", args);
    case "identity-mcp.account_invite":
      return accountInvite(state, args);
    case "identity-mcp.account_suspend":
      return accountSuspend(state, args);
    case "identity-mcp.grant_create":
      return grantCreate(state, args);
    case "identity-mcp.grant_revoke":
      return grantRevoke(state, args);
    case "identity-mcp.permission_matrix_get":
      return permissionMatrixGet(state);
    case "ui-console-mcp.runtime_health_get":
      return runtimeHealthGet(state);
    case "ui-console-mcp.management_surface_get":
      return {managementSurfaces: state.managementSurfaces};
    case "ui-console-mcp.project_progress_get":
      return progressGet(state, args, "project");
    case "ui-console-mcp.task_group_progress_get":
      return progressGet(state, args, "task_group");
    case "ui-console-mcp.guarded_action_dispatch":
      return guardedActionDispatch(state, args);
    case "definition-mcp.shared_definition_create":
      return sharedDefinitionCreate(state, args);
    case "definition-mcp.shared_definition_publish":
      return sharedDefinitionPublish(state, args);
    case "definition-mcp.shared_definition_consumer_bind":
      return sharedDefinitionConsumerBind(state, args);
    case "definition-mcp.shared_definition_conflict_report":
      return sharedDefinitionConflictReport(state, args);
    case "instruction-mcp.instruction_envelope_create":
      return instructionEnvelopeCreate(state, args, "instruction_envelope");
    case "instruction-mcp.cache_key_index":
      return cacheKeyIndex(state, args);
    case "instruction-mcp.stable_prefix_get":
      return stablePrefixGet(state, args);
    case "instruction-mcp.delta_payload_compact":
      return deltaPayloadCompact(state, args);
    case "repository-mcp.repository_output_target_select":
      return repositoryOutputTargetSelect(state, args);
    case "repository-mcp.repository_target_lease_bind":
      return repositoryTargetLeaseBind(state, args);
    case "repository-mcp.artifact_manifest_index":
      return artifactManifestIndex(state, args);
    default:
      throw new Error(`Unhandled tool: ${name}`);
  }
}

function sanitizeArgs(args) {
  const safe = args && typeof args === "object" ? {...args} : {};
  delete safe.mcpToken;
  delete safe.token;
  delete safe.authorization;
  return safe;
}

function createProject(state, args) {
  const at = new Date().toISOString();
  const project = {
    id: args.projectId || createId("prj"),
    name: args.name || args.title || "AI-native Project",
    status: "active",
    ownerAccountId: args.ownerAccountId || "acct_workspace_owner",
    repositoryRefs: args.repositoryRefs || [],
    progress: {percent: 0, phase: "initialized", health: "ok", updatedAt: at},
    createdAt: at,
    updatedAt: at
  };
  state.projects.unshift(project);
  computeProgressSnapshots(state);
  return {project};
}

function createTaskGroup(state, args) {
  const project = state.projects.find((item) => item.id === args.projectId) || state.projects[0];
  const at = new Date().toISOString();
  const taskGroup = {
    id: args.taskGroupId || createId("tg"),
    projectId: project?.id || "prj_control_plane",
    title: args.title || "AI-native Task Group",
    objective: args.objective || args.title || "Machine-executed task group",
    status: "planned",
    goalExecutionStatus: "ready",
    phase: "planning",
    progress: 0,
    health: "ok",
    roles: args.roles || [],
    workItems: [],
    blockers: [],
    createdAt: at,
    updatedAt: at
  };
  state.taskGroups.unshift(taskGroup);
  computeProgressSnapshots(state);
  return {taskGroup};
}

function createWorkItem(state, args) {
  const taskGroup = state.taskGroups.find((item) => item.id === args.taskGroupId) || state.taskGroups[0];
  const at = new Date().toISOString();
  const workItem = {
    id: args.workItemId || createId("work"),
    title: args.title || "AI-native work item",
    status: args.status || "draft",
    ownerRole: args.roleId || args.ownerRole || "orchestrator",
    progress: 0,
    requirements: args.requirements || [],
    createdAt: at,
    updatedAt: at
  };
  taskGroup.workItems ||= [];
  taskGroup.workItems.push(workItem);
  taskGroup.updatedAt = at;
  computeProgressSnapshots(state);
  return {taskGroupId: taskGroup.id, workItem};
}

function findTaskGroup(state, taskGroupId) {
  return state.taskGroups.find((item) => item.id === taskGroupId) || state.taskGroups[0];
}

function findWorkItem(state, taskGroupId, workItemId) {
  const taskGroup = findTaskGroup(state, taskGroupId);
  return taskGroup?.workItems?.find((item) => item.id === workItemId) || taskGroup?.workItems?.[0];
}

function assignWorkItem(state, args) {
  const taskGroup = findTaskGroup(state, args.taskGroupId);
  const workItem = findWorkItem(state, taskGroup?.id, args.workItemId);
  if (!taskGroup || !workItem) return {ok: false, error: "work_item_not_found"};
  workItem.ownerRole = args.roleId || args.ownerRole || workItem.ownerRole || "orchestrator";
  if (workItem.status === "draft") workItem.status = "ready";
  workItem.updatedAt = new Date().toISOString();
  const modelDecision = selectModel(state, {projectId: taskGroup.projectId, taskGroupId: taskGroup.id, workItemId: workItem.id, roleId: workItem.ownerRole});
  return {taskGroupId: taskGroup.id, workItem, modelDecision};
}

function stateGet(state, args) {
  const scope = args.scope || "summary";
  computeProgressSnapshots(state);
  if (scope === "full") {
    if (process.env.AIMAC_MCP_ALLOW_FULL_STATE !== "true") {
      return {ok: false, error: "full_state_scope_not_allowed", summary: summaryState(state)};
    }
    return {state: redactStateForMcp(state)};
  }
  return summaryState(state);
}

function summaryState(state) {
  return {
    runtime: state.runtime,
    projects: state.projects,
    taskGroups: state.taskGroups,
    progressSnapshots: state.progressSnapshots,
    modelCapabilities: state.modelCapabilities,
    skillSources: state.skillSources,
    roleSkillCount: state.roleSkills.length,
    agentDispatches: state.agentDispatches
  };
}

function redactStateForMcp(state) {
  const redacted = JSON.parse(JSON.stringify(state));
  redacted.authSessions = (redacted.authSessions || []).map((session) => ({
    sessionId: session.sessionId,
    accountId: session.accountId,
    status: session.status,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  }));
  redacted.idempotencyRecords = {};
  redacted.mcpGrants = (redacted.mcpGrants || []).map((grant) => ({
    grantId: grant.grantId,
    serverId: grant.serverId,
    toolName: grant.toolName,
    projectId: grant.projectId,
    taskGroupId: grant.taskGroupId,
    workId: grant.workId,
    grantStatus: grant.grantStatus,
    expiresAt: grant.expiresAt,
    riskLevel: grant.riskLevel,
    grantDigest: grant.grantDigest
  }));
  return redacted;
}

function roomJoin(state, args) {
  const at = new Date().toISOString();
  const participant = {
    participantId: args.participantId || createId("room_participant"),
    roomId: args.roomId || `room_${args.taskGroupId || "tg_runtime_management"}`,
    sessionId: args.sessionId,
    roleId: args.roleId || "agent-runtime",
    cursor: Number(args.cursor || 0),
    status: "joined",
    joinedAt: at,
    updatedAt: at
  };
  state.roomParticipants = [participant, ...state.roomParticipants.filter((item) => item.participantId !== participant.participantId)];
  return {participant};
}

function roomSend(state, args) {
  const at = new Date().toISOString();
  const roomId = args.roomId || `room_${args.taskGroupId || "tg_runtime_management"}`;
  const message = {
    messageId: args.messageId || createId("room_msg"),
    roomId,
    sequence: state.roomMessages.filter((item) => item.roomId === roomId).length + 1,
    senderRef: args.senderRef || args.roleId || "agent-runtime",
    payload: args.payload || {text: args.text || ""},
    payloadDigest: digestOf(args.payload || args.text || ""),
    status: "sent",
    createdAt: at
  };
  state.roomMessages.push(message);
  state.commands.unshift({
    id: createId("cmd_room"),
    type: "room_send",
    subject: `Room:${roomId}`,
    status: "succeeded",
    idempotencyKey: args.idempotencyKey,
    resultRef: `RoomMessage:${message.messageId}`,
    createdAt: at,
    updatedAt: at
  });
  state.eventLog.unshift({
    id: createId("evt_room"),
    at,
    type: "room_message",
    subject: {type: "RoomMessage", id: message.messageId},
    actor: message.senderRef,
    taskGroupId: args.taskGroupId,
    payloadDigest: message.payloadDigest
  });
  return {message};
}

function roomWait(state, args) {
  const roomId = args.roomId || `room_${args.taskGroupId || "tg_runtime_management"}`;
  const afterSequence = Number(args.afterSequence || args.cursor || 0);
  const messages = state.roomMessages.filter((item) => item.roomId === roomId && Number(item.sequence || 0) > afterSequence);
  return {roomId, messages, nextCursor: messages.at(-1)?.sequence || afterSequence};
}

function roomAck(state, args) {
  const at = new Date().toISOString();
  const ack = {
    ackId: args.ackId || createId("room_ack"),
    roomId: args.roomId || `room_${args.taskGroupId || "tg_runtime_management"}`,
    participantId: args.participantId || args.sessionId || "agent-runtime",
    messageRefs: args.messageRefs || [],
    cursor: Number(args.cursor || 0),
    createdAt: at
  };
  state.roomAcks.unshift(ack);
  return {ack};
}

function nodeRegister(state, args) {
  const at = new Date().toISOString();
  const node = {
    nodeId: args.nodeId || createId("node"),
    status: "online",
    endpoint: args.endpoint || "local-stdio",
    capabilityFlags: args.capabilityFlags || ["room", "command", "mcp_proxy", "permission_request", "git"],
    toolSignals: args.toolSignals || ["node", "git"],
    mcpServers: Object.keys(mcpToolGroups),
    modelProviders: state.modelCapabilities.map((item) => item.providerClass),
    trustScore: Number(args.trustScore || 0.9),
    registeredAt: at,
    updatedAt: at
  };
  state.agentRuntimeNodes = [node, ...state.agentRuntimeNodes.filter((item) => item.nodeId !== node.nodeId)];
  return {node};
}

function nodeProbe(state, args) {
  const node = state.agentRuntimeNodes.find((item) => item.nodeId === args.nodeId) || nodeRegister(state, args).node;
  node.lastProbe = {
    probedAt: new Date().toISOString(),
    gitHead: gitHead(repositoryRoot),
    gitRemote: gitRemoteUrl(repositoryRoot),
    mcpToolCount: mcpToolNames.length,
    dispatchQueueDepth: state.agentDispatches.filter((item) => ["queued", "blocked"].includes(item.status)).length
  };
  node.updatedAt = node.lastProbe.probedAt;
  return {node};
}

function sessionStart(state, args) {
  const contract = buildTaskContract(state, {...args, root: args.repositoryRoot || repositoryRoot});
  return {contract, session: state.workSessions.find((item) => item.sessionId === contract.sessionId)};
}

function sessionMutate(state, args, status) {
  const session = state.workSessions.find((item) => item.sessionId === args.sessionId);
  if (!session) return {ok: false, error: "session_not_found"};
  session.status = status;
  session.updatedAt = new Date().toISOString();
  for (const dispatch of state.agentDispatches.filter((item) => item.sessionId === session.sessionId && !["completed", "failed", "cancelled"].includes(item.status))) {
    if (status === "cancelled") dispatch.status = "cancelled";
    if (status === "paused") dispatch.status = "blocked";
    if (status === "active" && ["blocked", "cancelled"].includes(dispatch.status)) dispatch.status = "queued";
    dispatch.updatedAt = session.updatedAt;
  }
  return {session};
}

function capacitySnapshot(state) {
  return {
    activeSessions: state.workSessions.filter((item) => !["completed_objective", "failed", "closed", "recycled", "aborted", "cancelled"].includes(item.status)).length,
    activeSubagents: state.workSessions.filter((item) => item.placement === "subagent" && !["completed_objective", "failed", "closed", "recycled", "aborted", "cancelled"].includes(item.status)).length,
    dispatchQueueDepth: state.agentDispatches.filter((item) => ["queued", "blocked"].includes(item.status)).length,
    agentCount: state.agents.length,
    nodeCount: state.agentRuntimeNodes.length,
    modelProviderCount: state.modelCapabilities.length
  };
}

function createExecutionTopology(state, args) {
  const taskGroup = findTaskGroup(state, args.taskGroupId);
  const at = new Date().toISOString();
  const topology = {
    schemaVersion: "execution-topology/v1",
    topologyId: args.topologyId || createId("topo"),
    projectId: taskGroup?.projectId || args.projectId || "prj_control_plane",
    taskGroupId: taskGroup?.id || args.taskGroupId || "tg_runtime_management",
    status: "planned",
    nodes: (taskGroup?.workItems || []).map((item) => ({workItemId: item.id, roleId: item.ownerRole, status: item.status})),
    edges: args.edges || [],
    createdAt: at,
    updatedAt: at
  };
  state.executionTopologies.unshift(topology);
  return {topology};
}

function classifyDerivedTask(state, args) {
  const title = `${args.title || ""} ${args.description || ""}`.toLowerCase();
  const signals = [];
  if (title.includes("review") || title.includes("audit")) signals.push("review_required");
  if (title.includes("test") || title.includes("qa")) signals.push("qa_required");
  if (title.includes("security") || title.includes("permission")) signals.push("security_required");
  const roleId = signals.includes("security_required") ? "security" : signals.includes("qa_required") ? "qa" : signals.includes("review_required") ? "reviewer" : args.roleId || "orchestrator";
  return {roleId, signals, modelDecision: selectModel(state, {...args, roleId})};
}

function claimLease(state, args) {
  const targetRef = args.repositoryOutputTargetRef || args.targetId;
  const target = state.repositoryOutputs.find((item) => item.targetId === targetRef);
  if (!target) return {ok: false, error: "repository_output_target_not_found", targetRef};
  const at = new Date().toISOString();
  const resourceRef = `RepositoryOutputTarget:${target.targetId}`;
  const holderRef = args.holderRef || `session:${args.sessionId || createId("sess")}`;
  const existing = state.leases.find((item) => item.resourceRef === resourceRef && item.status === "active");
  if (existing) {
    if (existing.holderRef === holderRef) return {lease: existing, repositoryOutputTarget: target, replayedActiveLease: true};
    return {ok: false, error: "lease_already_active", activeLeaseRef: existing.leaseId, holderRef: existing.holderRef};
  }
  state.leaseSequence = Number(state.leaseSequence || 0) + 1;
  const lease = {
    leaseId: args.leaseId || createId("lease"),
    resourceRef,
    holderRef,
    status: "active",
    fencingToken: `fence-${String(state.leaseSequence).padStart(12, "0")}`,
    sequence: state.leaseSequence,
    expiresAt: args.expiresAt || new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    createdAt: at,
    updatedAt: at
  };
  state.leases.unshift(lease);
  target.status = "lease_bound";
  target.leaseRef = lease.leaseId;
  target.updatedAt = at;
  return {lease, repositoryOutputTarget: target};
}

function releaseLease(state, args) {
  const lease = state.leases.find((item) => item.leaseId === args.leaseId);
  if (!lease) return {ok: false, error: "lease_not_found"};
  if (args.holderRef && lease.holderRef !== args.holderRef) return {ok: false, error: "lease_holder_mismatch"};
  if (!args.fencingToken) return {ok: false, error: "lease_fencing_token_required"};
  if (String(lease.fencingToken) !== String(args.fencingToken)) return {ok: false, error: "lease_fencing_token_mismatch"};
  lease.status = "released";
  lease.updatedAt = new Date().toISOString();
  return {lease};
}

function resourceSnapshot(state, args) {
  return {
    leases: state.leases.filter((item) => !args.status || item.status === args.status),
    repositoryOutputs: state.repositoryOutputs.filter((item) => !args.taskGroupId || item.taskGroupId === args.taskGroupId)
  };
}

function modelPolicyGet(state, args) {
  return {
    policies: state.modelSelectionPolicies.filter((item) => !args.roleId || item.roleId === args.roleId),
    providerClasses: [...new Set(state.modelCapabilities.map((item) => item.providerClass))]
  };
}

function roleSkillParse(state, args) {
  return {
    roleSkills: state.roleSkills.filter((skill) =>
      (!args.sourceId || skill.sourceId === args.sourceId) &&
      (!args.category || skill.category === args.category) &&
      (!args.capability || (skill.capabilities || []).includes(args.capability))
    )
  };
}

function resolveRoleSkillView(state, args) {
  const roleId = args.roleId || args.ownerRole || "orchestrator";
  const roleSkill = state.roleSkills.find((skill) => skill.roleSkillId === args.roleSkillRef)
    || state.roleSkills.find((skill) => skill.roleSkillId?.includes(roleId))
    || state.roleSkills[0];
  const overlays = state.roleSkillOverlays.filter((overlay) =>
    overlay.roleSkillRef === roleSkill?.roleSkillId &&
    (!overlay.taskGroupId || overlay.taskGroupId === args.taskGroupId) &&
    (!overlay.projectId || overlay.projectId === args.projectId)
  );
  return {roleSkill, overlays, precedence: ["task_group_overlay", "project_overlay", "upstream_default"]};
}

function artifactRegister(state, args) {
  const at = new Date().toISOString();
  const artifact = {
    artifactId: args.artifactId || createId("artifact"),
    projectId: args.projectId || "prj_control_plane",
    taskGroupId: args.taskGroupId || "tg_runtime_management",
    workItemId: args.workItemId || args.workId,
    repositoryOutputTargetRef: args.repositoryOutputTargetRef,
    artifactManifestRef: args.artifactManifestRef || args.path,
    outputRefs: args.outputRefs || [],
    digest: digestOf(args),
    status: "registered",
    createdAt: at
  };
  state.artifacts.unshift(artifact);
  return {artifact};
}

function testResultSubmit(state, args) {
  const at = new Date().toISOString();
  const testResult = {
    testResultId: args.testResultId || createId("test_result"),
    projectId: args.projectId || "prj_control_plane",
    taskGroupId: args.taskGroupId || "tg_runtime_management",
    workItemId: args.workItemId || args.workId,
    status: args.status || "passed",
    command: args.command,
    summary: args.summary || "",
    evidenceRefs: args.evidenceRefs || [],
    createdAt: at
  };
  state.testResults.unshift(testResult);
  return {testResult};
}

function permissionProbe(state, args) {
  const subjectId = args.subjectId || args.accountId || "acct_agent_runtime";
  const permission = args.permission || args.action;
  const grants = state.accessGrants.filter((grant) => grant.status === "active" && grant.subjectRef?.subjectId === subjectId);
  const allowed = grants.some((grant) => (grant.permissions || []).includes(permission) || (grant.permissions || []).includes("*"));
  return {subjectId, permission, allowed, grants};
}

function permissionRequestSubmit(state, args) {
  const at = new Date().toISOString();
  const request = {
    requestId: args.requestId || createId("perm_req"),
    subjectId: args.subjectId || "acct_agent_runtime",
    resource: args.resource || {resourceType: "task_group", resourceId: args.taskGroupId || "tg_runtime_management"},
    permission: args.permission || args.action || "task_group:read",
    status: "pending",
    reason: args.reason || args.actionReason || "machine permission request",
    createdAt: at,
    updatedAt: at
  };
  state.permissionRequests.unshift(request);
  if (args.sessionId) {
    const session = state.workSessions.find((item) => item.sessionId === args.sessionId);
    if (session) {
      session.status = "permission_required";
      session.updatedAt = at;
    }
  }
  return {permissionRequest: request};
}

function permissionStatus(state, args) {
  const request = state.permissionRequests.find((item) => item.requestId === args.requestId);
  return {permissionRequest: request || null};
}

function permissionResolve(state, args) {
  const request = state.permissionRequests.find((item) => item.requestId === args.requestId);
  if (!request) return {ok: false, error: "permission_request_not_found"};
  request.status = args.status || (args.allowed === false ? "denied" : "approved");
  request.policyDecisionRef = policyDecisionEval(state, {action: request.permission, resource: request.resource, allowed: request.status === "approved"}).policyDecision.decisionId;
  request.updatedAt = new Date().toISOString();
  return {permissionRequest: request};
}

function reviewPlanCreate(state, args) {
  const taskGroup = findTaskGroup(state, args.taskGroupId);
  const at = new Date().toISOString();
  const plan = {
    schemaVersion: "review-plan/v1",
    reviewPlanId: args.reviewPlanId || createId("review_plan"),
    projectId: taskGroup?.projectId || args.projectId || "prj_control_plane",
    taskGroupId: taskGroup?.id || args.taskGroupId || "tg_runtime_management",
    status: "planned",
    reviewScopeRefs: args.reviewScopeRefs || [`TaskGroup:${taskGroup?.id || "tg_runtime_management"}`],
    requiredReviewerRoles: args.requiredReviewerRoles || ["reviewer", "qa"],
    evidenceRefs: args.evidenceRefs || [],
    createdAt: at,
    updatedAt: at
  };
  state.reviewPlans.unshift(plan);
  return {reviewPlan: plan};
}

function reviewBundleRegister(state, args) {
  const at = new Date().toISOString();
  const bundle = {
    schemaVersion: "review-bundle/v1",
    reviewBundleId: args.reviewBundleId || createId("review_bundle"),
    projectId: args.projectId || "prj_control_plane",
    taskGroupId: args.taskGroupId || "tg_runtime_management",
    status: "registered",
    artifactRefs: args.artifactRefs || [],
    checkpointRefs: args.checkpointRefs || [],
    evidenceRefs: args.evidenceRefs || [],
    createdAt: at,
    updatedAt: at
  };
  state.reviewBundles.unshift(bundle);
  return {reviewBundle: bundle};
}

function reviewResultConsume(state, args) {
  const finding = findingSubmit(state, {...args, findingType: args.findingType || "review", severity: args.severity || "info"});
  const readiness = computeCompletionReadiness(state, args.taskGroupId || "tg_runtime_management", args);
  return {finding: finding.finding, readiness};
}

function approvalRequestCreate(state, args) {
  const at = new Date().toISOString();
  const request = {
    approvalId: args.approvalId || createId("approval"),
    projectId: args.projectId,
    taskGroupId: args.taskGroupId,
    action: args.action || "guarded_action",
    resource: args.resource || {},
    status: "pending",
    riskClass: args.riskClass || "medium",
    requiredApprovers: args.requiredApprovers || ["policy-engine", "security"],
    quorum: Number(args.quorum || 1),
    expiresAt: args.expiresAt || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    decisionRecordRef: args.decisionRecordRef || `decision:approval:${at}`,
    auditRef: args.auditRef || `audit:approval:${at}`,
    createdAt: at,
    updatedAt: at
  };
  state.approvalRequests.unshift(request);
  return {approvalRequest: request};
}

function policyDecisionEval(state, args) {
  const at = new Date().toISOString();
  const policyDecision = {
    decisionId: args.decisionId || createId("pd"),
    action: args.action || "mcp_tool_call",
    resource: args.resource || {},
    subjectRef: args.subjectRef || {subjectType: "service", subjectId: "mcp-proxy"},
    result: args.allowed === false ? "denied" : "allowed",
    reasonCode: args.reasonCode || "local_mcp_policy_eval",
    evidenceRefs: args.evidenceRefs || [],
    createdAt: at
  };
  state.policyDecisions.unshift(policyDecision);
  return {policyDecision};
}

function findingSubmit(state, args) {
  const at = new Date().toISOString();
  const finding = {
    findingId: args.findingId || createId("finding"),
    projectId: args.projectId || "prj_control_plane",
    taskGroupId: args.taskGroupId || "tg_runtime_management",
    workItemId: args.workItemId || args.workId,
    findingType: args.findingType || "governance",
    severity: args.severity || "medium",
    status: args.status || "open",
    summary: args.summary || "Machine-submitted finding",
    evidenceRefs: args.evidenceRefs || [],
    createdAt: at,
    updatedAt: at
  };
  state.findings.unshift(finding);
  return {finding};
}

function contractPublish(state, args) {
  const contract = sharedDefinitionCreate(state, {...args, status: "active"}).sharedDefinition;
  return {contract};
}

function roleDriftGuardBind(state, args) {
  const contract = args.sessionId
    ? state.agentTaskContracts.find((item) => item.sessionId === args.sessionId)
    : buildTaskContract(state, {...args, root: args.repositoryRoot || repositoryRoot});
  if (!contract) return {ok: false, error: "task_contract_not_found"};
  const drift = evaluateRoleDrift(state, {sessionId: contract.sessionId, taskGroupId: contract.taskGroupId, actionScopeRefs: args.actionScopeRefs || [`TaskGroup:${contract.taskGroupId}`]});
  return {contractRef: contract.commandId, drift};
}

function ruleSourceResolve(state, args) {
  const at = new Date().toISOString();
  const resolution = {
    schemaVersion: "rule-source-resolution/v1",
    resolutionId: args.resolutionId || createId("rsr"),
    sourceRef: args.sourceRef || "reference:unknown",
    sourceScope: args.sourceScope || "reference_material",
    status: args.status || "classified",
    classification: args.classification || "reference_only",
    adoptionPolicy: args.classification === "generic_mechanism" ? "external_review_required" : "not_active_rule",
    evidenceRefs: args.evidenceRefs || [],
    createdAt: at,
    updatedAt: at
  };
  state.ruleSourceResolutions.unshift(resolution);
  return {ruleSourceResolution: resolution};
}

function systemUpgradeCandidateExport(state, args) {
  const candidates = state.systemUpgradeCandidates.filter((candidate) => !args.taskGroupId || candidate.taskGroupId === args.taskGroupId);
  return {
    exportId: createId("upgrade_export"),
    mode: "external_maintenance_only",
    forbidsRuntimeAutoUpgrade: true,
    candidateCount: candidates.length,
    candidates
  };
}

function systemUpgradeExternalImport(state, args) {
  const at = new Date().toISOString();
  const imported = {
    importId: args.importId || createId("upgrade_import"),
    packageRef: args.packageRef || args.externalUpgradePackageRef,
    status: "imported_pending_admin_activation",
    forbidsActiveRuntimeSelfMutation: true,
    evidenceRefs: args.evidenceRefs || [],
    createdAt: at
  };
  state.externalUpgradeImports.unshift(imported);
  return {externalUpgradeImport: imported};
}

function accountInvite(state, args) {
  const at = new Date().toISOString();
  const account = {
    schemaVersion: "account/v1",
    accountId: args.accountId || createId("acct"),
    accountType: "user_account",
    displayName: args.displayName || args.email || "Project User",
    email: args.email || `${createId("user")}@local`,
    status: "invited",
    roles: args.roles || ["project_member"],
    permissions: [],
    authPolicy: {method: "local_password", mfaRequired: false, passwordSet: false, sessionTtlSeconds: 3600},
    auditRef: `audit:account-invite:${at}`,
    createdAt: at,
    updatedAt: at
  };
  state.accounts.unshift(account);
  if (args.resource || args.projectId || args.taskGroupId) {
    grantCreate(state, {
      subjectId: account.accountId,
      resource: args.resource || (args.taskGroupId ? {resourceType: "task_group", resourceId: args.taskGroupId} : {resourceType: "project", resourceId: args.projectId}),
      role: args.grantRole || "project_member",
      permissions: args.grantPermissions || ["project:read"]
    });
  }
  return {account};
}

function accountSuspend(state, args) {
  const account = state.accounts.find((item) => item.accountId === args.accountId);
  if (!account) return {ok: false, error: "account_not_found"};
  account.status = "suspended";
  account.updatedAt = new Date().toISOString();
  for (const grant of state.accessGrants.filter((item) => item.subjectRef?.subjectId === account.accountId && item.status === "active")) {
    grant.status = "revoked";
    grant.updatedAt = account.updatedAt;
  }
  return {account};
}

function grantCreate(state, args) {
  const at = new Date().toISOString();
  const grant = {
    schemaVersion: "access-control-grant/v1",
    grantId: args.grantId || createId("grant"),
    subjectRef: args.subjectRef || {subjectType: "account", subjectId: args.subjectId || args.accountId || "acct_agent_runtime"},
    resource: args.resource || {resourceType: args.resourceType || "task_group", resourceId: args.resourceId || args.taskGroupId || "tg_runtime_management"},
    role: args.role || "agent_operator",
    permissions: args.permissions || ["task_group:read"],
    status: "active",
    policyDecisionRef: args.policyDecisionRef || `policy:grant:${at}`,
    auditRef: args.auditRef || `audit:grant:${at}`,
    createdAt: at,
    updatedAt: at
  };
  state.accessGrants.unshift(grant);
  return {grant};
}

function grantRevoke(state, args) {
  const grant = state.accessGrants.find((item) => item.grantId === args.grantId);
  if (!grant) return {ok: false, error: "grant_not_found"};
  grant.status = "revoked";
  grant.updatedAt = new Date().toISOString();
  return {grant};
}

function permissionMatrixGet(state) {
  return {
    accounts: state.accounts.map((account) => ({
      accountId: account.accountId,
      accountType: account.accountType,
      status: account.status,
      roles: account.roles,
      directPermissions: account.permissions
    })),
    grants: state.accessGrants
  };
}

function runtimeHealthGet(state) {
  return {
    runtime: state.runtime,
    statePath,
    repositoryRoot,
    mcp: state.runtime.mcp,
    health: {
      ok: true,
      services: state.runtime.services,
      toolCount: mcpToolNames.length,
      logicalServerCount: Object.keys(mcpToolGroups).length,
      skillSourceStatus: state.skillSources.map((source) => ({sourceId: source.sourceId, status: source.status, digestIndexVerified: source.digestIndexVerified}))
    }
  };
}

function progressGet(state, args, scopeType) {
  computeProgressSnapshots(state);
  const scopeRef = scopeType === "project" ? args.projectId : args.taskGroupId;
  return {
    progressSnapshot: state.progressSnapshots.find((snapshot) => snapshot.scopeType === scopeType && (!scopeRef || snapshot.scopeRef === scopeRef)) || null
  };
}

function guardedActionDispatch(state, args) {
  const decision = policyDecisionEval(state, {action: args.action || "guarded_action", resource: args.resource || {}, allowed: args.allowed !== false}).policyDecision;
  return {
    commandResult: {
      commandId: createId("cmd_guarded"),
      action: args.action || "guarded_action",
      status: decision.result === "allowed" ? "accepted" : "denied",
      policyDecisionRef: decision.decisionId
    }
  };
}

function sharedDefinitionCreate(state, args) {
  const at = new Date().toISOString();
  const definition = {
    schemaVersion: "shared-definition-contract/v1",
    contractId: args.contractId || createId("sdc"),
    status: args.status || "draft",
    projectId: args.projectId || "prj_control_plane",
    definitionType: args.definitionType || "semantic_contract",
    scopeRefs: args.scopeRefs || [args.taskGroupId ? `TaskGroup:${args.taskGroupId}` : "Project:prj_control_plane"],
    canonicalOwnerRole: args.canonicalOwnerRole || args.ownerRole || "orchestrator",
    producerRole: args.producerRole || args.ownerRole || "orchestrator",
    consumerRefs: args.consumerRefs || [],
    definitionDigest: digestOf(args.definition || args),
    repositoryOutputTargetRef: args.repositoryOutputTargetRef || "rot_shared_definition",
    repositoryOutputTargetDigest: digestOf(args.repositoryOutputTargetRef || "rot_shared_definition"),
    conflictPolicy: args.conflictPolicy || {onConflict: "canonical_owner_decides"},
    changePolicy: args.changePolicy || {requiresConsumersRebind: true},
    reviewEvidenceRefs: args.reviewEvidenceRefs || [],
    createdAt: at,
    updatedAt: at
  };
  state.sharedDefinitions.unshift(definition);
  return {sharedDefinition: definition};
}

function sharedDefinitionPublish(state, args) {
  const definition = state.sharedDefinitions.find((item) => item.contractId === args.contractId) || sharedDefinitionCreate(state, args).sharedDefinition;
  definition.status = "active";
  definition.updatedAt = new Date().toISOString();
  return {sharedDefinition: definition};
}

function sharedDefinitionConsumerBind(state, args) {
  const definition = state.sharedDefinitions.find((item) => item.contractId === args.contractId);
  if (!definition) return {ok: false, error: "shared_definition_not_found"};
  definition.consumerRefs = [...new Set([...(definition.consumerRefs || []), ...(args.consumerRefs || [args.consumerRef || `TaskGroup:${args.taskGroupId || "tg_runtime_management"}`])])];
  definition.updatedAt = new Date().toISOString();
  return {sharedDefinition: definition};
}

function sharedDefinitionConflictReport(state, args) {
  const finding = findingSubmit(state, {
    ...args,
    findingType: "shared_definition_conflict",
    severity: args.severity || "high",
    summary: args.summary || `Shared definition conflict: ${args.contractId || "unknown"}`
  }).finding;
  return {finding};
}

function instructionEnvelopeCreate(state, args, sourceKind) {
  const at = new Date().toISOString();
  const envelope = {
    schemaVersion: "instruction-envelope/v1",
    envelopeId: args.envelopeId || createId("ienv"),
    status: "active",
    taskGroupId: args.taskGroupId || "tg_runtime_management",
    recipientRole: args.recipientRole || args.roleId || "agent-runtime",
    effectiveInstructionPacketRef: args.effectiveInstructionPacketRef || args.packetRef || "eip:runtime",
    formatVersion: "digest_first/v1",
    stablePrefixDigest: digestOf(args.stablePrefix || "ai-native-control-plane"),
    digestRefs: args.digestRefs || [],
    sharedDefinitionRefs: args.sharedDefinitionRefs || [],
    cacheKey: digestOf({role: args.recipientRole || args.roleId, taskGroupId: args.taskGroupId, sourceKind}),
    tokenBudget: args.tokenBudget || {stablePrefixTokens: 1800, deltaMessageTargetTokens: 420},
    outputContractRef: args.outputContractRef || "spec/checkpoint.schema.json",
    createdAt: at,
    updatedAt: at
  };
  state.instructionMetrics.envelopes.unshift(envelope);
  return {instructionEnvelope: envelope};
}

function cacheKeyIndex(state, args) {
  return {
    cacheKeys: state.instructionMetrics.envelopes
      .filter((item) => !args.taskGroupId || item.taskGroupId === args.taskGroupId)
      .map((item) => ({envelopeId: item.envelopeId, cacheKey: item.cacheKey, stablePrefixDigest: item.stablePrefixDigest}))
  };
}

function stablePrefixGet(state, args) {
  const envelope = state.instructionMetrics.envelopes.find((item) => item.envelopeId === args.envelopeId)
    || state.instructionMetrics.envelopes.find((item) => !args.taskGroupId || item.taskGroupId === args.taskGroupId);
  return {
    stablePrefix: {
      envelopeId: envelope?.envelopeId,
      digest: envelope?.stablePrefixDigest || digestOf("ai-native-control-plane"),
      refs: ["terminal-execution-manifest:v1", "state-machines:v1", "role-drift-guard:v1"]
    }
  };
}

function deltaPayloadCompact(_state, args) {
  const payload = args.payload || {};
  return {
    compactPayload: {
      payloadDigest: digestOf(payload),
      locatorRefs: args.locatorRefs || [],
      stableRefs: args.stableRefs || [],
      delta: args.delta || payload
    }
  };
}

function repositoryOutputTargetSelect(state, args) {
  const taskGroup = findTaskGroup(state, args.taskGroupId);
  const workItem = findWorkItem(state, taskGroup?.id, args.workItemId);
  const at = new Date().toISOString();
  const pathAllowlist = args.pathAllowlist || ["docs/**", "apps/**", "scripts/**", "spec/**", "data/**", "package.json", "Dockerfile", "docker-compose.yml", "README.md"];
  const artifactManifestPath = args.artifactManifestPath || `docs/artifact-manifests/${args.workItemId || workItem?.id || "work"}.json`;
  if (!pathAllowlistValid(pathAllowlist) || !canUseGitPath(artifactManifestPath)) {
    return {ok: false, error: "repository_output_target_must_use_git_trackable_paths"};
  }
  if (!pathMatchesAllowlist(artifactManifestPath, pathAllowlist)) {
    return {ok: false, error: "artifact_manifest_outside_allowlist"};
  }
  const target = {
    schemaVersion: "repository-output-target/v1",
    targetId: args.targetId || createId("rot"),
    projectId: args.projectId || taskGroup?.projectId || "prj_control_plane",
    taskGroupId: args.taskGroupId || taskGroup?.id || "tg_runtime_management",
    workItemId: args.workItemId || workItem?.id || "work_unknown",
    repositoryId: args.repositoryId || "repo_control_plane",
    repositoryUrl: args.repositoryUrl || gitRemoteUrl(repositoryRoot) || "",
    remote: args.remote || "origin",
    branch: args.branch || "main",
    status: "selected",
    outputPolicy: "project_git_repository_only",
    pathAllowlist,
    baseRef: args.baseRef || gitHead(repositoryRoot),
    artifactManifestPath,
    decisionRecordRef: args.decisionRecordRef || `decision:repository-target:${at}`,
    auditRef: args.auditRef || `audit:repository-target:${at}`,
    createdAt: at,
    updatedAt: at
  };
  state.repositoryOutputs.unshift(target);
  return {repositoryOutputTarget: target};
}

function repositoryTargetLeaseBind(state, args) {
  return claimLease(state, args);
}

function artifactManifestIndex(state, args) {
  const manifests = [
    ...state.artifacts.map((artifact) => artifact.artifactManifestRef).filter(Boolean),
    ...state.repositoryOutputs.map((target) => target.artifactManifestPath).filter(Boolean),
    ...(args.artifactManifestRefs || [])
  ];
  return {artifactManifestRefs: [...new Set(manifests)]};
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({jsonrpc: "2.0", id, result})}\n`);
}

function respondError(id, code, message, data) {
  process.stdout.write(`${JSON.stringify({jsonrpc: "2.0", id, error: {code, message, ...(data ? {data} : {})}})}\n`);
}

function toolResult(payload, isError = false) {
  const text = JSON.stringify(payload, null, 2);
  return {
    resultType: "complete",
    content: [{type: "text", text}],
    structuredContent: payload,
    isError
  };
}

async function handleMessage(message) {
  if (message.method === "notifications/initialized") return;
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: message.params?.protocolVersion || "2025-03-26",
      capabilities: {tools: {listChanged: false}},
      serverInfo: {name: "ai-multi-agent-ctrl", version: "0.1.0"}
    });
    return;
  }
  if (message.method === "tools/list") {
    respond(message.id, {
      resultType: "complete",
      tools: createMcpToolDefinitions(),
      ttlMs: 300000,
      cacheScope: "public"
    });
    return;
  }
  if (message.method === "tools/call") {
    try {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      const payload = await callTool(name, args);
      respond(message.id, toolResult(payload, false));
    } catch (error) {
      if (error.code) {
        respondError(message.id, error.code, error.message);
      } else {
        respond(message.id, toolResult({ok: false, error: error.message}, true));
      }
    }
    return;
  }
  if (message.id !== undefined) respondError(message.id, -32601, `Method not found: ${message.method}`);
}

export function startStdioServer() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          respondError(null, -32700, `Parse error: ${error.message}`);
          newlineIndex = buffer.indexOf("\n");
          continue;
        }
        handleMessage(message).catch((error) => respondError(message.id, -32603, error.message));
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });

  process.stdin.on("end", () => process.exit(0));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startStdioServer();
}
