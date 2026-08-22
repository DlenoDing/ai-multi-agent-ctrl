#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureStoredState, isStateStoreConflict, markRuntimeStorage, readStoredState, writeStoredState } from "../control-plane-ui/lib/state-store.mjs";
import { appendAuditEntry, flushPendingAuditAppends } from "../control-plane-ui/lib/audit-ledger.mjs";
import { isSafeGitRemoteUrl } from "../control-plane-ui/lib/agent-gateway.mjs";
import {
  acceptAgentCheckpoint,
  buildTaskContract,
  consumeHumanConfirmation,
  submitAiConfirmationAnalysis,
  isHumanConfirmationActor,
  assertUniqueRecordId,
  createHumanConfirmationRequest,
  decideHumanConfirmation,
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
  organizationQuotaCheck,
  DEFAULT_ORGANIZATION_ID,
  gitHead,
  gitRemoteUrl,
  pathAllowlistValid,
  pathMatchesAllowlist,
  registerRoleSkillOverlay,
  normalizeTaskGroupLanguagePolicy,
  projectOwnerGrantPermissions,
  runAutonomousCycle,
  runCommandLifecycle,
  selectModel,
  syncSkillSource,
  approvalRequestCreate,
  artifactRegister,
  capRetainingOpen,
  recordQualityGateFromTest,
  terminateCellRuntime,
  findPermissionBlockedDispatch,
  requeuePermissionApprovedDispatch,
  claimLease,
  classifyDerivedTask,
  contractPublish,
  createExecutionTopology,
  advanceExecutionTopology,
  findTaskGroup,
  findingResolve,
  findingSubmit,
  permissionProbe,
  permissionRequestSubmit,
  policyDecisionEval,
  releaseLease,
  resourceMatches,
  reviewBundleRegister,
  reviewPlanCreate,
  roomSend,
  ROOM_SENDER_KEY,
  ROOM_PARTICIPANT_KEY,
  roomWait,
  ruleSourceResolve,
  sharedDefinitionCreate,
  taskGroupForRecord,
  reviewPlanRecordCoverage,
  isDelegatableGrantPermission,
  WORK_SESSION_SETTLED_STATUSES,
  assertHumanTextWithinLimit,
  revokeAccountSessions,
  resolveRoleSkill,
  REGISTERED_OWNER_ROLES,
  taskGroupSettledRejection,
  STRING_LIST_MAX_ITEMS,
  STRING_LIST_MAX_ITEM_LENGTH
} from "../control-plane-ui/lib/control-plane-core.mjs";
import {
  createAgentControlCommand,
  revokeDispatchMcpGrants
} from "../control-plane-ui/lib/agent-gateway.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runtimeDir = resolve(root, process.env.AIMAC_RUNTIME_DIR || ".runtime");
const statePath = resolve(runtimeDir, "control-plane-state.json");
const seedPath = resolve(root, "data", "seed-state.json");
const repositoryRoot = resolve(process.env.AIMAC_REPOSITORY_ROOT || root);
const mcpAuditPath = resolve(runtimeDir, "mcp-audit.jsonl");
const agentJoinCommand = "create one-time join token in project UI, then run the generated curl installer command on the Agent host";

export const mcpToolGroups = {
  "orchestration-mcp": ["project_create", "task_group_create", "work_item_create", "work_assign", "orchestrator_run", "state_get"],
  "room-mcp": ["room_join", "room_send", "room_wait", "room_ack"],
  "agent-control-mcp": ["node_register", "node_probe", "session_start", "session_pause", "session_cancel", "session_recover", "dispatch_status"],
  "scheduler-mcp": ["model_select", "session_place", "work_assign", "capacity_snapshot", "execution_topology_plan", "execution_topology_advance", "derived_task_classify"],
  "resource-mcp": ["lease_claim", "lease_release", "resource_snapshot"],
  "model-mcp": ["model_capabilities", "model_policy_get", "model_select"],
  "skill-mcp": ["skill_source_sync", "role_skill_parse", "role_skill_overlay_validate", "role_skill_resolve"],
  "evidence-mcp": ["artifact_register", "checkpoint_submit", "test_result_submit"],
  "permission-mcp": ["permission_probe", "permission_request_submit", "permission_status", "permission_resolve"],
  "human-review-mcp": ["confirmation_request_submit", "confirmation_status", "confirmation_consume", "confirmation_analyze", "confirmation_decide"],
  "review-mcp": ["review_plan_create", "review_bundle_register", "review_result_consume", "completion_readiness_compute"],
  "governance-mcp": [
    "approval_request_create",
    "approval_resolve",
    "policy_decision_eval",
    "finding_submit",
    "finding_resolve",
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
  "agent-control-mcp.dispatch_status": "Read a remotely claimed AgentDispatch status without executing work on the control-plane server.",
  "scheduler-mcp.model_select": "Select the best available model for a role and task requirement.",
  "scheduler-mcp.session_place": "Choose new-session or subagent placement from machine signals.",
  "scheduler-mcp.work_assign": "Assign a role to a work item using the scheduler policy surface.",
  "scheduler-mcp.capacity_snapshot": "Return scheduler-visible session and agent capacity.",
  "scheduler-mcp.execution_topology_plan": "Create an execution topology plan for a task group.",
  "scheduler-mcp.execution_topology_advance": "Advance an execution topology along its modeled lifecycle (check_eligibility, start, downgrade, report_branch, reconcile_required, reconcile, block, unblock, merge, cancel).",
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
  "human-review-mcp.confirmation_request_submit": "Submit a question that requires human confirmation with AI-provided options.",
  "human-review-mcp.confirmation_status": "Read the status and decision of a human confirmation request.",
  "human-review-mcp.confirmation_consume": "Mark an answered human confirmation as consumed by the executor.",
  "human-review-mcp.confirmation_analyze": "Re-analyse a pending human confirmation after a human proposed their own plan: state whether it is correct, raise concerns or offer a better alternative, and optionally revise the candidate options. Never finalizes — only a human can.",
  "human-review-mcp.confirmation_decide": "Record the human decision for a pending confirmation request.",
  "permission-mcp.permission_status": "Read a permission request state.",
  "permission-mcp.permission_resolve": "Resolve a permission request and record the policy decision.",
  "review-mcp.review_plan_create": "Create an independent review plan for a task group.",
  "review-mcp.review_bundle_register": "Register review evidence bundle metadata.",
  "review-mcp.review_result_consume": "Consume review results into findings and readiness state.",
  "review-mcp.completion_readiness_compute": "Compute task-group completion readiness.",
  "governance-mcp.approval_request_create": "Create a machine approval request for high-risk actions.",
  "governance-mcp.policy_decision_eval": "Evaluate and record a policy decision for an action.",
  "governance-mcp.finding_submit": "Submit a governance, review, quality or security finding.",
  "governance-mcp.finding_resolve": "Move a governance finding to a terminal status (resolved/dismissed/wontfix).",
  "governance-mcp.approval_resolve": "Record the terminal decision (approved/rejected) on a machine approval request.",
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
  computeProgressSnapshots(state);
  markRuntimeStorage(state, ".runtime/control-plane-state.json");
  writeStoredState(state, {root, runtimeDir, statePath, seedPath, buildInitialState, expectedStateVersion: state.__loadedStateVersion});
  // 先落盘状态、再追加归档：CAS 冲突时上一行会抛，那次操作根本没发生，归档里不该有它。
  flushPendingAuditAppends(state, join(runtimeDir, "audit-log.jsonl"));
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
  state.roomSequenceByRoom ||= {};
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
  state.runtime.commands.mcpStart ||= "npm start";
  delete state.runtime.commands.mcpRegister;
  state.runtime.commands.agentJoin ||= agentJoinCommand;
  state.runtime.commands.mcpDoctor ||= "npm run mcp:doctor";
  state.runtime.mcp = {
    ...(state.runtime.mcp || {}),
    protocol: "mcp/streamable-http",
    serverId: "ai-multi-agent-ctrl",
    logicalServers: Object.keys(mcpToolGroups),
    toolCount: mcpToolNames.length,
    endpointPath: "/mcp",
    hostedBy: "control-plane",
    startupCommand: "npm start",
    registrationCommand: agentJoinCommand,
    doctorCommand: "npm run mcp:doctor",
    agentLocalServerAllowed: false
  };
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
    "orchestration-mcp.task_group_create": ["projectId"],
    "orchestration-mcp.work_item_create": ["taskGroupId"],
    "orchestration-mcp.work_assign": ["taskGroupId", "workItemId", "roleId"],
    "orchestration-mcp.orchestrator_run": ["taskGroupId"],
    "agent-control-mcp.session_start": ["taskGroupId", "workItemId"],
    "agent-control-mcp.session_pause": ["sessionId"],
    "agent-control-mcp.session_cancel": ["sessionId"],
    "agent-control-mcp.session_recover": ["sessionId"],
    "agent-control-mcp.dispatch_status": ["dispatchId"],
    "scheduler-mcp.model_select": ["taskGroupId", "workItemId", "roleId"],
    "scheduler-mcp.session_place": ["taskGroupId", "workItemId", "roleId"],
    "scheduler-mcp.work_assign": ["taskGroupId", "workItemId", "roleId"],
    "scheduler-mcp.execution_topology_plan": ["taskGroupId"],
    "scheduler-mcp.execution_topology_advance": ["topologyId", "action"],
    "model-mcp.model_select": ["taskGroupId", "workItemId", "roleId"],
    "resource-mcp.lease_release": ["leaseId", "holderRef", "fencingToken"],
    "skill-mcp.role_skill_overlay_validate": ["roleSkillRef"],
    "evidence-mcp.checkpoint_submit": ["taskGroupId", "workId", "sessionId", "runId"],
    "permission-mcp.permission_status": ["requestId"],
    "governance-mcp.finding_resolve": ["findingId", "status"],
    "governance-mcp.approval_resolve": ["approvalId"],
    "human-review-mcp.confirmation_request_submit": ["dispatchId", "options"],
    "human-review-mcp.confirmation_status": ["requestId"],
    "human-review-mcp.confirmation_consume": ["requestId"],
    "human-review-mcp.confirmation_analyze": ["requestId", "summary"],
    "human-review-mcp.confirmation_decide": ["requestId", "selectedOptionId"],
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
    conflictPolicy: {type: "string", enum: ["block_and_request_canonical_decision", "owner_reconciles_then_republish"]},
    consumerRef: string,
    consumerRefs: array,
    contractId: string,
    cursor: number,
    decisionRecordRef: string,
    definition: object,
    definitionType: string,
    delta: object,
    description: string,
    detail: string,
    dispatchId: string,
    digestRefs: array,
    displayName: string,
    dryRun: boolean,
    blocking: boolean,
    effectiveInstructionPacketRef: string,
    email: string,
    endpoint: string,
    envelopeId: string,
    question: object,
    options: array,
    selectedOptionId: string,
    evidenceRefs: array,
    expiresAt: string,
    externalUpgradePackageRef: string,
    fencingToken: {type: ["string", "number"]},
    findingId: string,
    findingType: string,
    grantId: string,
    grantPermissions: array,
    grantRole: string,
    hardConstraints: object,
    inputText: string,
    holderRef: string,
    idempotencyKey: string,
    leaseId: string,
    languageName: string,
    languagePolicy: object,
    languageTag: string,
    limit: number,
    locatorRefs: array,
    maxJobs: number,
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
    resolvedBy: string,
    resolutionRef: string,
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
    ttlSeconds: number,
    toolSignals: array,
    trustScore: number,
    workId: string,
    workItem: object,
    workItemId: string,
    workSignals: array,
    // AI 对人工确认的再分析 (human-review-mcp.confirmation_analyze)
    assessment: string,
    // 人在 MCP 上定稿核心决策时的轮次令牌（防 AI 在点击前掉包候选方案）
    expectedRound: number,
    concerns: array,
    // ExecutionTopology plan + lifecycle (scheduler-mcp.execution_topology_plan / _advance)
    topologyId: string,
    groupId: string,
    branches: array,
    branchId: string,
    branchStatus: string,
    runnerKind: string,
    runnerId: string,
    isolation: string,
    runnerGrantRef: string,
    localVerificationEvidenceRefs: array,
    actualChangedPaths: array,
    validationEvidenceRefs: array,
    unresolvedRisks: array,
    derivedTaskRequestRefs: array,
    resultRef: string,
    downgradeReason: string,
    reconcileEvidenceRef: string,
    blockingDerivedTaskRequestRef: string,
    resolvedBlockerRef: string,
    finalValidationEvidenceRefs: array,
    cancelRef: string
  };
}

// terminalStatuses MUST match the "non-blocking" set the readiness/close-barrier gates use for
// this collection (control-plane-core computeCompletionReadiness/computeCloseBarrier), so a still-gating
// item is treated as "open" and never trimmed away from under a gate.
function confirmationReadableByPrincipal(confirmation, context = {}) {
  const principal = context.principal || {};
  if (principal.kind === "agent_node") {
    // 运行时确认单按节点归属可见（一个节点看不到别的节点的问题）。但核心决策单是"方案定稿"，
    // 没有绑定 dispatch/nodeId：人提出自己的方案后要由 AI 再分析，如果 agent 读不到这张单，
    // 「交 AI 再分析」就永远无人应答（多轮协商在默认部署下形同虚设）。按项目归属放开【只读/再分析】，
    // 定稿权仍然被 confirmation_decide 的机器主体拦截挡在门外。
    if (confirmation.nodeId) return confirmation.nodeId === principal.id;
    // 只放开到这个节点【实际被授权的任务组】。按 projectId 放开会比它自己的 state_get 视图还宽
    // （scopeStateForAgentPrincipal 是按 mcpGrants 的任务组过滤的），等于从确认单这条缝里泄露
    // 它本来看不到的任务组内容，还能对不相干的决策注入候选方案。
    // 用与 state_get 完全同一份授权（context.grantCheck.grants），确保这条缝不会比它的状态视图更宽。
    const grantedTaskGroupIds = new Set((context.grantCheck?.grants || []).map((grant) => grant.taskGroupId).filter(Boolean));
    return confirmation.decisionClass === "major" && grantedTaskGroupIds.has(confirmation.taskGroupId);
  }
  if (principal.kind === "system_admin") return true;
  if (Array.isArray(principal.projectIds)) return principal.projectIds.includes(confirmation.projectId);
  return false;
}

function isReadOnlyTool(name) {
  return [
    ".state_get",
    ".confirmation_status",
    ".room_wait",
    ".node_probe",
    ".dispatch_status",
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

export function isWriteTool(name) {
  return !isReadOnlyTool(name);
}

export async function callTool(name, args = {}, context = {}) {
  if (!mcpToolNames.includes(name)) {
    const error = new Error(`Unknown tool: ${name}`);
    error.code = -32602;
    throw error;
  }
  const state = loadState();
  const beforeVersion = Number(state.stateVersion || 1);
  const idempotencyKey = args.idempotencyKey || null;
  const rawArgs = sanitizeArgs(args);
  let effectiveArgs = rawArgs;
  let argumentDigest = digestOf(rawArgs);
  let result;
  const inputValidation = validateInputArgs(name, args);
  if (!inputValidation.ok) {
    result = inputValidation;
  } else if (isWriteTool(name) && !idempotencyKey) {
    result = {ok: false, error: "idempotency_key_required"};
  } else {
    const grantCheck = validateMcpGrant(state, name, rawArgs, argumentDigest, context);
    if (!grantCheck.allowed) {
      result = {ok: false, error: grantCheck.error, grantRef: grantCheck.grantRef, required: grantCheck.required};
    } else {
      effectiveArgs = applyAgentGrantScopeArgs(name, rawArgs, grantCheck);
      argumentDigest = digestOf(effectiveArgs);
      // 幂等键的命名空间是全局的、内容由调用方自己给。REST 那一侧命中时要求 actor 相等，
      // MCP 这一侧原先只比对工具名与参数摘要，【不看是谁在调】—— 于是另一个主体拿同样的键和
      // 同样的参数调用，会直接拿到上一个主体那次执行的结果（replayed），而工具根本没有被执行、
      // 也没有为这次调用产生新的策略判定。两侧对同一件事必须有同一个判断。
      const principalRef = `${context.principal?.kind || "unknown"}:${context.principal?.id || "unknown"}`;
      const existingRecord = isWriteTool(name) ? state.idempotencyRecords[idempotencyKey] : null;
      // 记录【没有】principalRef 时不能当成"通过"：那是本次改动之前写下的旧记录，无从判断是谁写的，
      // 而"判断不了就放行"正是这条漏洞本身。改用一个独立错误码，不与真正的键冲突混为一谈：
      // 旧记录在 TTL 内最多让重放明确失败一次，而不是把别人的结果悄悄返回。
      if (existingRecord && !existingRecord.principalRef) {
        result = {ok: false, error: "idempotency_record_principal_unknown", idempotencyKey,
          detail: "这条幂等记录早于主体绑定，无法确认它属于哪个调用方；请换一个幂等键重试"};
      } else if (existingRecord && (existingRecord.action !== name || existingRecord.argumentDigest !== argumentDigest
        || existingRecord.principalRef !== principalRef)) {
        result = {ok: false, error: "idempotency_key_reuse_conflict", idempotencyKey};
      } else if (existingRecord) {
        result = {ok: true, replayed: true, idempotencyRecord: existingRecord, payload: existingRecord.payload};
      } else {
        const policyDecision = isWriteTool(name)
      ? policyDecisionEval(state, {
          action: `mcp:${name}`,
          resource: {resourceType: "mcp_tool", resourceId: name},
          subjectRef: {subjectType: "service", subjectId: "mcp-proxy"},
          allowed: true,
          reasonCode: "remote_mcp_principal_grant",
          evidenceRefs: [grantCheck.grantRef, `argument:${argumentDigest}`]
        }).policyDecision
      : null;
        result = isWriteTool(name) && effectiveArgs.dryRun
          ? {ok: true, dryRun: true, wouldCall: name, argumentDigest}
          : await dispatchTool(state, name, effectiveArgs, {principal: context.principal, grantCheck});
        if (policyDecision && result && typeof result === "object") result.policyDecisionRef = policyDecision.decisionId;
        if (grantCheck.grantRef && result && typeof result === "object") result.mcpGrantRef = grantCheck.grantRef;
        if (isWriteTool(name) && idempotencyKey && result.ok !== false && !effectiveArgs.dryRun) {
          state.idempotencyRecords[idempotencyKey] = {
            status: 200,
            action: name,
            // 谁写下的这条记录。重放时必须是同一个主体 —— 否则另一个主体拿同样的键就能取走结果。
            principalRef,
            argumentDigest,
            resultDigest: digestOf(result),
            payload: redactMcpPayload(result),
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
  if (isWriteTool(name)) {
    state.mcpCalls.unshift(mcpCall);
    state.mcpCalls = state.mcpCalls.slice(0, 300);
  }
  try {
    if (isWriteTool(name) && !effectiveArgs.dryRun) {
      // 主台账（控制台审计页读的那本）此前只由 REST 侧写，于是经 MCP 改的状态在那一屏上
      // 一条痕迹都没有 —— 人来问"谁动了它"看到的是空白。动作名统一记成 mcp_tool_call，
      // 工具名与它指到的那条记录放进 subject：85 个工具各记一个动作名的话，
      // 中文词表要跟着长 85 条，而屏幕上照样是一串英文工具名。
      appendAuditEntry(state, {
        actor: mcpPrincipalLabel(context.principal),
        action: "mcp_tool_call",
        subject: mcpAuditSubject(name, effectiveArgs),
        result: mcpCall.status,
        at
      });
      state.stateVersion = beforeVersion + 1;
      writeState(state);
    }
  } catch (error) {
    if (!isStateStoreConflict(error)) throw error;
    result = {ok: false, error: "state_write_conflict", retryable: true, message: error.message};
    const conflictCall = {...mcpCall, status: "failed", resultDigest: digestOf(result), conflict: true};
    appendMcpAudit(conflictCall);
    return {
      ok: false,
      tool: name,
      stateVersion: beforeVersion,
      result,
      untrustedResult: true,
      auditRef: conflictCall.callId
    };
  }
  // 这一层只写 MCP 自己的台账（mcp-audit.jsonl）。控制台那本主台账（state.auditLog + audit-log.jsonl）
  // 由 UI 服务端的 audit() 写，这里一次都不调它 —— 于是经 MCP 改的状态在审计页上没有痕迹。
  // 页面已经写清了这条边界（"两处都要看"）。要真的合流，得连着三件事一起做，缺一件都会造出
  // 比现在更糟的不一致（控制台看得见、归档里没有）：
  //   ① 审计条目的构造（含 prevHash 链）要抽成共享函数，两侧共用；
  //   ② 归档落盘走的是 UI 服务端写状态时的 flushPendingAuditAppends，MCP 的写路径不经过它；
  //   ③ actor 要从 MCP 主体映射过去（agent_node / executor / 远程主体），不能记成空。
  appendMcpAudit(mcpCall);
  return {
    // 内层带了 error 就不能在信封上说成功。实测有两个进度查询在缺作用域时返回
    // {progressSnapshot: null, error: "scope_ref_required_for_bounded_principal"} 而不带 ok:false，
    // 于是信封是 ok:true —— 只看信封的消费方会把它当成"查到了，只是没有进度"，
    // 而真相是"你没给作用域"。判据放在信封上而不是逐个工具补 ok:false：
    // 那样以后新增的路径还会再漏一次，而这一层是所有工具的必经之处。
    ok: result.ok !== false && !(result && typeof result === "object" && result.error),
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
    // 两种完全不同的原因原先共用一个码、且不带任何取值：
    //   允许清单本身不合法 —— 那是【配置】的问题，不是调用方给错了路径；
    //   清单里那条产出清单路径 git 跟踪不了 —— 这才是调用方能改的。
    // agent 拿到裸码只能瞎猜（还可能为一件不是它的错的事反复重试）。带上判别与真实取值。
    if (!pathAllowlistValid(pathAllowlist)) {
      return {ok: false, error: "repository_output_target_must_use_git_trackable_paths",
        cause: "path_allowlist_invalid", allowedPaths: pathAllowlist};
    }
    if (!canUseGitPath(artifactManifestPath)) {
      return {ok: false, error: "repository_output_target_must_use_git_trackable_paths",
        cause: "manifest_path_not_git_trackable", path: artifactManifestPath};
    }
    if (!pathMatchesAllowlist(artifactManifestPath, pathAllowlist)) {
      return {ok: false, error: "artifact_manifest_outside_allowlist",
        path: artifactManifestPath, allowedPaths: pathAllowlist};
    }
  }
  return {ok: true};
}

function redactMcpPayload(value) {
  if (!value || typeof value !== "object") return value;
  const clone = JSON.parse(JSON.stringify(value));
  redactSecretFields(clone);
  return clone;
}

function redactSecretFields(value) {
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (["accountToken", "joinToken", "nodeToken", "bearerToken"].includes(key)) {
      value[key] = `[redacted:${digestOf(value[key]).slice(7, 19)}]`;
    } else {
      redactSecretFields(value[key]);
    }
  }
}

function schemaTypeMatches(value, expectedType) {
  if (value === undefined) return true;
  if (Array.isArray(expectedType)) return expectedType.some((candidate) => schemaTypeMatches(value, candidate));
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

// 与 REST 侧同规（server.mjs 的 normalizeStringList）：条数与单条长度都有上限。
// 少补这一侧，agent 一样能一次请求把状态撑成几兆 —— 这类洞的常见样子就是孪生分支只补一半。
// 上限取自 core 那份唯一真相源 —— 与 REST 侧同一个常量，不在这里另抄一份。

function normalizeMcpStringList(value, fallback = [], field = "list") {
  const source = Array.isArray(value) ? value : String(value || "").split(/[\n,]/u);
  if (source.length > STRING_LIST_MAX_ITEMS) {
    throw Object.assign(new Error(`${field}_too_many_items`), {status: 400,
      details: {limit: STRING_LIST_MAX_ITEMS, actual: source.length}});
  }
  const normalized = [...new Set(source.map((item) => String(item).trim()).filter(Boolean))];
  const overlong = normalized.find((item) => item.length > STRING_LIST_MAX_ITEM_LENGTH);
  if (overlong !== undefined) {
    throw Object.assign(new Error(`${field}_item_too_long`), {status: 400,
      details: {limit: STRING_LIST_MAX_ITEM_LENGTH, actual: overlong.length}});
  }
  return normalized.length ? normalized : fallback;
}

function normalizeMcpRoleBindings(value, fallback = []) {
  const roles = Array.isArray(value) ? value : fallback;
  const roleIds = roles.map((role) => typeof role === "string" ? role : role?.roleId).filter(Boolean);
  return normalizeMcpStringList(roleIds, fallback).map((roleId) => ({
    roleId,
    status: "ready",
    skillBinding: "server_resolved_on_dispatch"
  }));
}

export function createMcpGrant(toolName, options = {}) {
  const readOnly = isReadOnlyTool(toolName);
  const [serverId] = toolName.split(".");
  const issuedAt = options.issuedAt || new Date().toISOString();
  const expiresAt = options.expiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const seed = {
    grantId: options.grantId || `mcp_grant_${createId("remote")}`,
    projectId: options.projectId || "prj_control_plane",
    taskGroupId: options.taskGroupId || "tg_runtime_management",
    workId: options.workId || "*",
    sessionId: options.sessionId || "remote-mcp-session",
    agentNodeId: options.agentNodeId || "remote-mcp-principal",
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
    approvalRequestRef: readOnly ? "approval:not-required:read-only" : "approval:remote-principal-policy",
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

function validateMcpGrant(state, toolName, args, argumentDigest, context = {}) {
  const readOnly = isReadOnlyTool(toolName);
  const principal = context.principal;
  if (!principal) return {allowed: false, error: "mcp_remote_auth_required", required: "Bearer node, account-session, or MCP service token"};
  const allowedTools = context.allowedMcpTools || principal.allowedMcpTools || [];
  if (!allowedTools.includes("*") && !allowedTools.includes(toolName)) {
    return {allowed: false, error: "mcp_tool_not_granted_to_principal", required: toolName};
  }
  const creationScope = validateMcpCreationScope(toolName, args, principal);
  if (!creationScope.allowed) return {...creationScope, grantRef: `remote-principal:${principal.kind}:${principal.id}`};
  const scopeExists = validateExplicitMcpScopeExists(state, toolName, args);
  if (!scopeExists.allowed) {
    // 受限主体（绑定在某个项目上的 agent 节点）问一个 id 时，"查无此物"与"存在但不属于你"
    // 必须给同一个答案。原先前者回 task_group_not_found / project_not_found，后者回
    // mcp_grant_scope_mismatch —— 两者可分辨，报文就成了跨租户的存在性探针：
    // 拿一个 id 试一下，就知道这套部署里别的租户有没有它。
    // REST 侧早就把这条写成了口径（"别的组织有没有这个账号会从 403 与 404 的差别里漏出去"），
    // 这里是同一条不变式在 MCP 侧的缺口。系统管理员与服务令牌不受影响：它们本就有权知道什么存在。
    const boundedPrincipal = principal.kind === "agent_node";
    if (boundedPrincipal && /_not_found$/u.test(String(scopeExists.error || ""))) {
      return {allowed: false, error: "mcp_grant_scope_mismatch", required: toolName,
        grantRef: `remote-principal:${principal.kind}:${principal.id}`};
    }
    return {...scopeExists, grantRef: `remote-principal:${principal.kind}:${principal.id}`};
  }
  if (principal.kind === "agent_node") {
    // 【第二道门，当前不可达】2026-08-14 用真实节点实测：checkpoint_submit 不在任何派发下发的
    // 工具白名单里，所以上面 mcp_tool_not_granted_to_principal 会先拒掉，这一支走不到。
    // 留着是因为白名单是【配置】：哪天有人把它放进某个角色的工具集，这道门就是最后一道 ——
    // 检查点必须走网关（那里才有认领代次、围栏与证据链校验）。
    // 因此它在"拒绝码覆盖"名单上会一直挂着零覆盖，那是如实的，不要为它编一个够不到的用例。
    if (toolName === "evidence-mcp.checkpoint_submit") {
      return {allowed: false, error: "agent_checkpoint_must_use_gateway", required: "/api/agent/v1/dispatches/:dispatchId/checkpoint"};
    }
    // Read-only self-status: a node must read the TERMINAL outcome of its own permission request even
    // after a deny/abandon cascade revoked its dispatch-bound grant (else it polls a 403 until the ~4min
    // timeout and never sees "denied"). permissionStatus scopes to the owner via
    // permissionRequestReadableByPrincipal, so no active grant is required for this read-only self-read.
    if (toolName === "permission-mcp.permission_status") {
      return {allowed: true, grantRef: "self-permission-status", argumentDigest, readOnly: true};
    }
    const activeGrants = activeAgentMcpGrants(state, principal, toolName);
    if (!activeGrants.length) return {allowed: false, error: "mcp_dispatch_bound_grant_required", required: toolName};
    const scopedGrants = activeGrants.filter((grant) => grantMatchesArgs(state, grant, args));
    if (!scopedGrants.length) return {allowed: false, error: "mcp_grant_scope_mismatch", required: toolName};
    if (scopedGrants.length !== 1) {
      return {allowed: false, error: readOnly ? "mcp_grant_scope_required" : "mcp_grant_scope_ambiguous", required: "dispatchId or exact dispatch-bound scope"};
    }
    const grantRef = scopedGrants.map((grant) => `McpGrant:${grant.grantId}`).join(",");
    return {allowed: true, grantRef, grants: scopedGrants, scope: scopeFromGrant(scopedGrants[0]), argumentDigest, readOnly};
  }
  const grantRef = `remote-principal:${principal.kind}:${principal.id}`;
  const scopeCheck = validateRemotePrincipalScope(state, principal, args, {toolName, readOnly});
  if (!scopeCheck.allowed) return {allowed: false, error: scopeCheck.error, grantRef, required: scopeCheck.required};
  if (leaseRequiredForTool(toolName) && !["resource-mcp.lease_claim", "repository-mcp.repository_target_lease_bind"].includes(toolName)) {
    const leaseId = args.leaseId || args.leaseRef || args.repositoryLeaseRef;
    const lease = state.leases.find((item) => item.leaseId === leaseId && item.status === "active");
    if (!lease) return {allowed: false, error: "active_mcp_lease_required", grantRef};
    if (!args.fencingToken) return {allowed: false, error: "mcp_lease_fencing_token_required", grantRef};
    if (String(lease.fencingToken) !== String(args.fencingToken)) return {allowed: false, error: "mcp_lease_fencing_token_mismatch", grantRef};
    if (args.holderRef && lease.holderRef !== args.holderRef) return {allowed: false, error: "mcp_lease_holder_mismatch", grantRef};
    if (args.sessionId && lease.holderRef !== `session:${args.sessionId}`) return {allowed: false, error: "mcp_lease_session_mismatch", grantRef};
  }
  return {allowed: true, grantRef, argumentDigest, readOnly};
}

function validateMcpCreationScope(toolName, args = {}, principal = {}) {
  if (toolName === "orchestration-mcp.project_create" && principal.kind !== "system_admin") {
    return {allowed: false, error: "mcp_project_create_requires_system_admin", required: "system_admin"};
  }
  if (toolName === "orchestration-mcp.task_group_create" && !hasInputArg(args, "projectId")) {
    return {allowed: false, error: "project_id_required", required: "projectId"};
  }
  return {allowed: true};
}

function validateExplicitMcpScopeExists(state, toolName, args = {}) {
  const createsProject = toolName === "orchestration-mcp.project_create";
  const createsTaskGroup = toolName === "orchestration-mcp.task_group_create";
  const createsWorkItem = toolName === "orchestration-mcp.work_item_create";
  const projectId = hasInputArg(args, "projectId") ? String(args.projectId) : "";
  const taskGroupId = hasInputArg(args, "taskGroupId") ? String(args.taskGroupId) : "";
  const workItemId = hasInputArg(args, "workItemId") ? String(args.workItemId) : hasInputArg(args, "workId") ? String(args.workId) : "";
  if (projectId && !createsProject && !(state.projects || []).some((item) => item.id === projectId)) {
    return {allowed: false, error: "project_not_found", required: projectId};
  }
  const taskGroup = taskGroupId ? (state.taskGroups || []).find((item) => item.id === taskGroupId) : null;
  if (taskGroupId && !createsTaskGroup && !taskGroup) {
    return {allowed: false, error: "task_group_not_found", required: taskGroupId};
  }
  if (projectId && taskGroup && !createsTaskGroup && taskGroup.projectId !== projectId) {
    return {allowed: false, error: "task_group_project_scope_mismatch", required: `${projectId}:${taskGroupId}`};
  }
  const explicitResource = explicitMcpResourceScope(args);
  if (explicitResource?.resourceType === "project") {
    const resourceProject = (state.projects || []).find((item) => item.id === explicitResource.resourceId);
    if (!resourceProject) return {allowed: false, error: "project_not_found", required: explicitResource.resourceId};
    if (projectId && projectId !== explicitResource.resourceId) {
      return {allowed: false, error: "resource_project_scope_mismatch", required: `${projectId}:${explicitResource.resourceId}`};
    }
    if (taskGroup && taskGroup.projectId !== explicitResource.resourceId) {
      return {allowed: false, error: "resource_task_group_project_scope_mismatch", required: `${taskGroup.id}:${explicitResource.resourceId}`};
    }
  }
  if (explicitResource?.resourceType === "task_group") {
    const resourceTaskGroup = (state.taskGroups || []).find((item) => item.id === explicitResource.resourceId);
    if (!resourceTaskGroup) return {allowed: false, error: "task_group_not_found", required: explicitResource.resourceId};
    if (taskGroupId && taskGroupId !== explicitResource.resourceId) {
      return {allowed: false, error: "resource_task_group_scope_mismatch", required: `${taskGroupId}:${explicitResource.resourceId}`};
    }
    if (projectId && resourceTaskGroup.projectId !== projectId) {
      return {allowed: false, error: "resource_project_scope_mismatch", required: `${projectId}:${explicitResource.resourceId}`};
    }
  }
  if (workItemId && !createsWorkItem) {
    const workItemMatches = taskGroup
      ? (taskGroup.workItems || []).filter((item) => item.id === workItemId)
      : (state.taskGroups || []).flatMap((item) => (item.workItems || []).filter((workItem) => workItem.id === workItemId).map((workItem) => ({taskGroup: item, workItem})));
    if (!workItemMatches.length) return {allowed: false, error: "work_item_not_found", required: workItemId};
    if (projectId && !taskGroup && !workItemMatches.some((match) => match.taskGroup?.projectId === projectId)) {
      return {allowed: false, error: "work_item_project_scope_mismatch", required: `${projectId}:${workItemId}`};
    }
  }
  if (hasInputArg(args, "dispatchId")) {
    const dispatch = (state.agentDispatches || []).find((item) => item.dispatchId === args.dispatchId);
    if (!dispatch) return {allowed: false, error: "dispatch_not_found", required: args.dispatchId};
    if (projectId && dispatch.projectId !== projectId) return {allowed: false, error: "dispatch_project_scope_mismatch", required: `${projectId}:${args.dispatchId}`};
    if (taskGroupId && dispatch.taskGroupId !== taskGroupId) return {allowed: false, error: "dispatch_task_group_scope_mismatch", required: `${taskGroupId}:${args.dispatchId}`};
    if (workItemId && dispatch.workItemId !== workItemId) return {allowed: false, error: "dispatch_work_item_scope_mismatch", required: `${workItemId}:${args.dispatchId}`};
  }
  const targetRef = hasInputArg(args, "repositoryOutputTargetRef") ? args.repositoryOutputTargetRef : hasInputArg(args, "targetId") ? args.targetId : "";
  if (targetRef && toolName !== "repository-mcp.repository_output_target_select") {
    const target = (state.repositoryOutputs || []).find((item) => item.targetId === targetRef);
    if (!target) return {allowed: false, error: "repository_output_target_not_found", required: targetRef};
    if (projectId && target.projectId !== projectId) return {allowed: false, error: "repository_target_project_scope_mismatch", required: `${projectId}:${targetRef}`};
    if (taskGroupId && target.taskGroupId !== taskGroupId) return {allowed: false, error: "repository_target_task_group_scope_mismatch", required: `${taskGroupId}:${targetRef}`};
    if (workItemId && target.workItemId !== workItemId) return {allowed: false, error: "repository_target_work_item_scope_mismatch", required: `${workItemId}:${targetRef}`};
  }
  return {allowed: true};
}

function explicitMcpResourceScope(args = {}) {
  const resource = args.resource && typeof args.resource === "object" ? args.resource : {};
  const resourceType = resource.resourceType || (hasInputArg(args, "resourceType") ? args.resourceType : "");
  const resourceId = resource.resourceId ||
    (hasInputArg(args, "resourceId") ? args.resourceId : "") ||
    (String(resourceType) === "task_group" ? args.taskGroupId : "") ||
    (String(resourceType) === "project" ? args.projectId : "");
  if (!resourceType && !resourceId) return null;
  return {resourceType: String(resourceType || "project"), resourceId: String(resourceId || "")};
}

// Arguments that address a project-scoped resource. If a bounded principal supplies any of these but
// none resolves to a project, we fail closed rather than fall through — so an unresolved (e.g. foreign or
// not-yet-existing) id can never reach a tool with no scope confinement. Identity/node args (subjectId,
// nodeId) are intentionally excluded: they are not project-scoped and must not be forced through this gate.
// roomId is intentionally excluded: an unresolvable room (room_<non-existent-tg> or an ad-hoc room) is not a
// project-scoped object, so fail-closing on it would wrongly deny legitimate room traffic; a room backed by a
// real task group is still scope-enforced because inferMcpArgumentProjectIds resolves room_<tgId> to its project.
// 出现其中任一个键、却推断不出所属项目时，有界主体一律拒绝（fail closed）。
// 这份清单必须覆盖【所有能单独定位一条项目级记录的 id】：漏掉一个，有界主体就能只带那个 id
// 去操作别的租户的对象 —— 推断不出项目，而这条键又不在清单里，校验会一路走到 allowed。
// 覆盖面由 contract-check 按 spec 里带 projectId/taskGroupId 的规范全量核对，不靠人记得补。
export const RESOURCE_ADDRESSING_ARG_KEYS = [
  "projectId", "taskGroupId", "workId", "workItemId", "dispatchId", "sessionId", "requestId",
  "contractId", "leaseId", "findingId", "approvalId", "repositoryOutputTargetRef", "targetId",
  // 以下六个同样是"单独一个就能指到一条项目级记录"的地址，原先不在清单里。
  "envelopeId", "grantId", "nodeId", "reviewBundleId", "reviewPlanId", "topologyId"
];
// Handlers that receive no explicit resource default their write to this project; a bounded principal not
// scoped to it must not perform such an unscoped write into the control-plane tenant's default project.
const DEFAULT_CONTROL_PLANE_PROJECT_ID = "prj_control_plane";

function validateRemotePrincipalScope(state, principal, args = {}, meta = {}) {
  if (principal.kind === "system_admin") return {allowed: true};
  const allowedProjectIds = new Set(principal.projectIds || []);
  if (allowedProjectIds.has("*")) return {allowed: true};
  const projectIds = inferMcpArgumentProjectIds(state, args);
  if (!projectIds.size) {
    // A call that addresses a specific project-scoped resource we could not tie to a project must not
    // proceed for a bounded principal (defends future-added tools/args against the fail-open path).
    if (RESOURCE_ADDRESSING_ARG_KEYS.some((key) => hasInputArg(args, key))) {
      return {allowed: false, error: "mcp_principal_project_scope_unresolved"};
    }
    // A state-mutating tool with no addressing argument defaults its resource to the control-plane project;
    // deny it for a bounded principal not scoped there so it cannot write into another tenant's default.
    if (meta.readOnly === false && !allowedProjectIds.has(DEFAULT_CONTROL_PLANE_PROJECT_ID)) {
      return {allowed: false, error: "mcp_principal_project_scope_unresolved"};
    }
    return {allowed: true};
  }
  for (const projectId of projectIds) {
    if (!allowedProjectIds.has(projectId)) {
      return {allowed: false, error: "mcp_principal_project_scope_mismatch", required: projectId};
    }
  }
  return {allowed: true};
}

function inferMcpArgumentProjectIds(state, args = {}) {
  const projectIds = new Set();
  if (args.projectId) projectIds.add(String(args.projectId));
  const explicitResource = explicitMcpResourceScope(args);
  if (explicitResource?.resourceType === "project" && explicitResource.resourceId) projectIds.add(explicitResource.resourceId);
  if (explicitResource?.resourceType === "task_group" && explicitResource.resourceId) {
    const taskGroup = (state.taskGroups || []).find((item) => item.id === explicitResource.resourceId);
    if (taskGroup?.projectId) projectIds.add(taskGroup.projectId);
  }
  if (args.taskGroupId) {
    const taskGroup = (state.taskGroups || []).find((item) => item.id === args.taskGroupId);
    if (taskGroup?.projectId) projectIds.add(taskGroup.projectId);
  }
  if (args.dispatchId) {
    const dispatch = (state.agentDispatches || []).find((item) => item.dispatchId === args.dispatchId);
    if (dispatch?.projectId) projectIds.add(dispatch.projectId);
  }
  if (args.repositoryOutputTargetRef || args.targetId) {
    const target = (state.repositoryOutputs || []).find((item) => item.targetId === (args.repositoryOutputTargetRef || args.targetId));
    if (target?.projectId) projectIds.add(target.projectId);
  }
  if (args.leaseId) {
    const lease = (state.leases || []).find((item) => item.leaseId === args.leaseId);
    const target = repositoryOutputTargetForLease(state, lease);
    if (target?.projectId) projectIds.add(target.projectId);
  }
  if (args.roomId && String(args.roomId).startsWith("room_")) {
    const taskGroupId = String(args.roomId).slice("room_".length);
    const taskGroup = (state.taskGroups || []).find((item) => item.id === taskGroupId);
    if (taskGroup?.projectId) projectIds.add(taskGroup.projectId);
  }
  if (args.findingId) {
    const finding = (state.findings || []).find((item) => item.findingId === args.findingId);
    if (finding?.projectId) projectIds.add(finding.projectId);
  }
  if (args.approvalId) {
    const approval = (state.approvalRequests || []).find((item) => item.approvalId === args.approvalId);
    if (approval?.projectId) projectIds.add(approval.projectId);
  }
  if (args.contractId) {
    // Shared-definition tools (publish/consumer_bind/conflict_report) are addressed solely by contractId;
    // resolve it to the owning project so a bounded principal cannot mutate another tenant's definition.
    const definition = (state.sharedDefinitions || []).find((item) => item.contractId === args.contractId);
    if (definition?.projectId) projectIds.add(definition.projectId);
  }
  if (args.topologyId) {
    // execution_topology_advance is addressed solely by topologyId; resolve it to the owning project so a
    // bounded principal cannot drive another tenant's topology through its lifecycle.
    const topology = (state.executionTopologies || []).find((item) => item.topologyId === args.topologyId);
    if (topology?.projectId) projectIds.add(topology.projectId);
  }
  const workItemId = args.workItemId || args.workId;
  if (workItemId) {
    // A bare workItemId resolves through its owning task group to a project (mirrors validateExplicitMcpScopeExists),
    // so the owner is not falsely denied and a cross-tenant work id becomes a scope mismatch rather than unresolved.
    for (const taskGroup of state.taskGroups || []) {
      if ((taskGroup.workItems || []).some((item) => item.id === workItemId) && taskGroup.projectId) {
        projectIds.add(taskGroup.projectId);
      }
    }
  }
  const projectIdForTaskGroupId = (taskGroupId) => {
    if (!taskGroupId) return;
    const taskGroup = (state.taskGroups || []).find((item) => item.id === taskGroupId);
    if (taskGroup?.projectId) projectIds.add(taskGroup.projectId);
  };
  const projectIdForSessionId = (sessionId) => {
    if (!sessionId) return;
    const session = (state.workSessions || []).find((item) => item.sessionId === sessionId);
    projectIdForTaskGroupId(session?.taskGroupId);
  };
  // A session/request-addressed tool (e.g. permission_request_submit, confirmation_*, session control)
  // must confine a bounded service principal to the owning project, else it could mutate another tenant's session.
  projectIdForSessionId(args.sessionId);
  if (args.requestId) {
    const request = (state.permissionRequests || []).find((item) => item.requestId === args.requestId)
      || (state.humanConfirmationRequests || []).find((item) => item.requestId === args.requestId);
    projectIdForTaskGroupId(request?.taskGroupId);
    projectIdForSessionId(request?.sessionId);
  }
  return projectIds;
}

function repositoryOutputTargetForLease(state, lease) {
  if (!lease) return null;
  const resourceRefTargetId = String(lease.resourceRef || "").startsWith("RepositoryOutputTarget:")
    ? String(lease.resourceRef).slice("RepositoryOutputTarget:".length)
    : String(lease.resourceRef || "");
  const targetId = lease.repositoryOutputTargetRef || resourceRefTargetId;
  return (state.repositoryOutputs || []).find((item) => item.targetId === targetId) || null;
}

function applyAgentGrantScopeArgs(toolName, args, grantCheck = {}) {
  if (!grantCheck.scope) return args;
  return {
    ...args,
    dispatchId: args.dispatchId || grantCheck.scope.dispatchId,
    projectId: args.projectId || grantCheck.scope.projectId,
    taskGroupId: args.taskGroupId || grantCheck.scope.taskGroupId,
    workId: args.workId || grantCheck.scope.workId,
    workItemId: args.workItemId || grantCheck.scope.workId,
    sessionId: args.sessionId || grantCheck.scope.sessionId,
    runId: args.runId || grantCheck.scope.runId,
    roleId: args.roleId || grantCheck.scope.roleId
  };
}

function scopeFromGrant(grant) {
  return {
    dispatchId: grant.dispatchId,
    projectId: grant.projectId,
    taskGroupId: grant.taskGroupId,
    workId: grant.workId,
    sessionId: grant.sessionId,
    runId: grant.runId,
    roleId: grant.roleId
  };
}

function activeAgentMcpGrants(state, principal, toolName) {
  const projectIds = new Set(principal.projectIds || []);
  return (state.mcpGrants || []).filter((grant) =>
    grant.grantStatus === "issued" &&
    grant.agentNodeId === principal.id &&
    grant.toolName === toolName &&
    (!grant.expiresAt || new Date(grant.expiresAt).getTime() > Date.now()) &&
    (!grant.projectId || projectIds.has(grant.projectId))
  );
}

export function grantMatchesArgs(state, grant, args = {}) {
  if (args.dispatchId && args.dispatchId !== grant.dispatchId) return false;
  if (args.projectId && args.projectId !== grant.projectId) return false;
  if (args.taskGroupId && args.taskGroupId !== grant.taskGroupId) return false;
  if ((args.workId || args.workItemId) && (args.workId || args.workItemId) !== grant.workId) return false;
  const explicitResource = explicitMcpResourceScope(args);
  if (explicitResource?.resourceType === "project" && explicitResource.resourceId && explicitResource.resourceId !== grant.projectId) return false;
  if (explicitResource?.resourceType === "task_group" && explicitResource.resourceId && explicitResource.resourceId !== grant.taskGroupId) return false;
  if (args.sessionId && args.sessionId !== grant.sessionId) return false;
  if (args.repositoryOutputTargetRef || args.targetId) {
    const target = state.repositoryOutputs.find((item) => item.targetId === (args.repositoryOutputTargetRef || args.targetId));
    if (!target || target.projectId !== grant.projectId || target.taskGroupId !== grant.taskGroupId || target.workItemId !== grant.workId) return false;
  }
  // 共享定义契约同理（与上面 targetId 一个形状）：报文只给 contractId、不给作用域时，
  // 上面那些按字段比对的检查一条都不触发。而共享定义是【项目内】作用域的
  // （sharedDefinitionAppliesToWork 要求 definition.projectId === taskGroup.projectId），
  // 跨项目去动它对自己毫无用处，只会害别人：publish 会把对方的草案推成 proposed，
  // 而 proposed 属于阻塞状态，直接卡住对方的关闭门、逼出一次人工处置。
  if (args.contractId) {
    const definition = (state.sharedDefinitions || []).find((item) => item.contractId === args.contractId);
    if (definition && definition.projectId && definition.projectId !== grant.projectId) return false;
  }
  if (args.roomId) {
    const allowedRoomIds = new Set([`room_${grant.taskGroupId}`, grant.sessionId].filter(Boolean));
    if (!allowedRoomIds.has(args.roomId)) return false;
  }
  return true;
}

function leaseRequiredForTool(toolName) {
  return [
    "evidence-mcp.checkpoint_submit",
    "resource-mcp.lease_release"
  ].includes(toolName);
}

function riskLevelForTool(toolName) {
  if (toolName === "evidence-mcp.checkpoint_submit") return "L3";
  if (toolName.includes("grant") || toolName.includes("account") || toolName.includes("approval") || toolName.includes("lease")) return "L2";
  return "L1";
}

// 审计里的"谁"：MCP 主体有三种（节点令牌 / 执行器凭据 / 远程 MCP 主体），都要记得出来。
// 记成空或统一记成 "mcp" 等于把问责这一栏作废。
function mcpWorkItemCreateStatus(value) {
  if (value === undefined || value === null || value === "") return "ready";
  if (["draft", "ready"].includes(value)) return value;
  throw Object.assign(new Error("work_item_status_unknown"),
    {status: 400, details: {status: String(value).slice(0, 60), supported: ["draft", "ready"]}});
}

// REST 侧（normalizeOwnerRole）把未登记的角色当场拒掉，理由写在那儿：认不出的角色被原样收下之后，
// 派发时会静默绑上 orchestrator 的技能 —— agent 按别人的角色规则干活，而人以为自己指定了角色。
// 这一侧原先一点校验都没有：同一个洞，孪生分支只补了一半（上面 status 那条注释讲的正是这件事，
// 而它自己旁边这一行就没补）。词表用 core 里那份唯一的真相源，不在这里另抄一份。
function mcpWorkItemOwnerRole(value) {
  const role = String(value || "").trim() || "orchestrator";
  if (!REGISTERED_OWNER_ROLES.includes(role)) {
    throw Object.assign(new Error("work_item_owner_role_not_registered"),
      {status: 400, details: {ownerRole: role.slice(0, 60), registeredRoles: REGISTERED_OWNER_ROLES}});
  }
  return role;
}

function mcpPrincipalLabel(principal) {
  const kind = String(principal?.kind || "unknown");
  const id = String(principal?.id || "unknown");
  return `mcp:${kind}:${id}`;
}

// 审计里的"对什么"：工具名 + 它指到的那条记录（取第一个能单独定位到资源的入参）。
function mcpAuditSubject(toolName, args) {
  for (const key of RESOURCE_ADDRESSING_ARG_KEYS) {
    const value = args?.[key];
    if (typeof value === "string" && value) return `${toolName} · ${key}=${value}`;
  }
  return toolName;
}

function appendMcpAudit(event) {
  mkdirSync(runtimeDir, {recursive: true});
  withMcpAuditLock(() => {
    rotateMcpAuditIfNeeded();
    appendFileSync(mcpAuditPath, `${JSON.stringify(event)}\n`);
  });
}

function rotateMcpAuditIfNeeded() {
  const maxBytes = Math.max(1024 * 1024, Number(process.env.AIMAC_MCP_AUDIT_MAX_BYTES || 64 * 1024 * 1024));
  try {
    if (!existsSync(mcpAuditPath) || statSync(mcpAuditPath).size < maxBytes) return;
    const rotatedPath = `${mcpAuditPath}.${new Date().toISOString().replace(/[^0-9T]/g, "")}.${process.pid}.${randomBytes(4).toString("hex")}.rotated`;
    renameSync(mcpAuditPath, rotatedPath);
    pruneMcpAuditRotations();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function pruneMcpAuditRotations() {
  const keep = Math.max(1, Number(process.env.AIMAC_MCP_AUDIT_ROTATIONS || 20));
  const dir = dirname(mcpAuditPath);
  const prefix = `${mcpAuditPath.split("/").pop()}.`;
  const rotated = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".rotated"))
    .map((name) => ({name, mtime: statSync(join(dir, name)).mtimeMs}))
    .sort((left, right) => right.mtime - left.mtime);
  for (const item of rotated.slice(keep)) unlinkSync(join(dir, item.name));
}

// 持锁进程已死 => 立刻可破。判不出持有者（锁刚建好、pid 还没落盘的毫秒级窗口，或进程死在那个
// 窗口里）时给一个短宽限期，而不是让 30 秒的阈值把写工具堵在门外。
function mcpAuditLockIsStale(lockPath) {
  let owner = null;
  try { owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")); } catch { owner = null; }
  const pid = Number(owner?.pid || 0);
  if (pid && pid !== process.pid) {
    try { process.kill(pid, 0); return false; } catch (error) { if (error?.code !== "EPERM") return true; return false; }
  }
  if (pid === process.pid) return false;
  try { return Date.now() - statSync(lockPath).mtimeMs > 2000; } catch { return false; }
}

function withMcpAuditLock(fn) {
  const lockPath = `${mcpAuditPath}.lock`;
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      mkdirSync(lockPath);
      // 与状态库那把锁同规：把持锁者写进锁里。进程被硬杀时锁会留下，而"谁持有它、它还活着吗"
      // 是唯一能安全破锁的依据。只按时间兜底的话（阈值 30s > 获取超时 10s），
      // 崩溃后约 30 秒内每个写工具调用都要么直接失败、要么白等 10 秒才通过。
      // 原子写，理由同状态库那把锁：撕裂读与"还没写"分不开，会让活着的持有者被提前破锁。
      try {
        const ownerTemporary = join(lockPath, `owner.${process.pid}.tmp`);
        writeFileSync(ownerTemporary, JSON.stringify({pid: process.pid, at: new Date().toISOString()}));
        renameSync(ownerTemporary, join(lockPath, "owner.json"));
      } catch { /* 锁已拿到，记不上持有者不该让写入失败 */ }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (mcpAuditLockIsStale(lockPath)) {
        rmSync(lockPath, {recursive: true, force: true});
        continue;
      }
      if (Date.now() > deadline) throw new Error("mcp_audit_lock_timeout");
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, {recursive: true, force: true});
  }
}

async function dispatchTool(state, name, args, context = {}) {
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
      return stateGet(state, args, context);
    case "room-mcp.room_join":
      // 缺省作用域不得等于放行：这些实现在 taskGroupId/roomId 缺省时会落到控制面自己的
      // 任务组（tg_runtime_management）。受限主体必须显式点名一个它有权的作用域，
      // 与 close_barrier_compute / room_wait 同规 —— 同一形状不该有的有守卫、有的没有。
      // 参与者身份与消息署名同源：服务端从已认证主体派生，不采信报文里的 participantId。
      return boundedRoomGuard(state, args, context) || roomJoin(state, {...args, [ROOM_PARTICIPANT_KEY]: context?.principal?.kind
        ? `${context.principal.kind}:${context.principal.id}:${args.roomId || args.taskGroupId || "room"}` : undefined});
    case "room-mcp.room_send":
      // 同 REST：署名由已认证主体派生。报文里的 senderRef 已从输入白名单里去掉，会被直接拒绝，
      // 而不是悄悄忽略 —— 悄悄忽略会让调用方以为自己署上了名。
      return roomSend(state, {...args, [ROOM_SENDER_KEY]: context?.principal?.kind
        ? `${context.principal.kind}:${context.principal.id}` : "unattributed"});
    case "room-mcp.room_wait":
      return boundedRoomGuard(state, args, context) || roomWait(state, args);
    case "room-mcp.room_ack":
      // 缺省作用域不得等于放行：这些实现在 taskGroupId/roomId 缺省时会落到控制面自己的
      // 任务组（tg_runtime_management）。受限主体必须显式点名一个它有权的作用域，
      // 与 close_barrier_compute / room_wait 同规 —— 同一形状不该有的有守卫、有的没有。
      return boundedRoomGuard(state, args, context) || roomAck(state, args);
    case "agent-control-mcp.node_register":
      return nodeRegister(state, args);
    case "agent-control-mcp.node_probe":
      return nodeProbe(state, args);
    case "agent-control-mcp.session_start":
      return sessionStart(state, args);
    case "agent-control-mcp.session_pause":
      return sessionMutate(state, args, "paused");
    case "agent-control-mcp.session_cancel":
      // "cancelled" 从来不是 WorkSession 的已登记状态，于是被取消的会话永远不在关闭门认可的
      // 了结集里 —— 取消一次就永久挡住任务组关闭。语义上它就是 aborted，用已登记的那个。
      return sessionMutate(state, args, "aborted");
    case "agent-control-mcp.session_recover":
      return sessionMutate(state, args, "active");
    case "agent-control-mcp.dispatch_status":
      return {dispatch: scopedDispatch(state, args.dispatchId, context) || null};
    case "scheduler-mcp.model_select":
    case "model-mcp.model_select":
      return selectModel(state, args);
    case "scheduler-mcp.session_place":
      return decideSessionPlacement(state, args);
    case "scheduler-mcp.capacity_snapshot":
      return capacitySnapshot(state, principalProjectFilter(context));
    case "scheduler-mcp.execution_topology_plan":
      return createExecutionTopology(state, args);
    case "scheduler-mcp.execution_topology_advance":
      return advanceExecutionTopology(state, {...args, actor: context?.principal?.id});
    case "scheduler-mcp.derived_task_classify":
      return classifyDerivedTask(state, args);
    case "resource-mcp.lease_claim":
      return claimLease(state, args);
    case "resource-mcp.lease_release":
      return releaseLease(state, args);
    case "resource-mcp.resource_snapshot":
      return resourceSnapshot(state, args, principalProjectFilter(context));
    case "model-mcp.model_capabilities":
      return {modelCapabilities: state.modelCapabilities};
    case "model-mcp.model_policy_get":
      return modelPolicyGet(state, args);
    case "skill-mcp.skill_source_sync":
      // 规则层（角色 SKILL.md 正文 / 覆盖层）不该由机器主体改：syncSkillSource 会整体替换
      // state.roleSkills，registerRoleSkillOverlay 直接产出 active 覆盖层并被下一次 buildTaskContract
      // 选中。REST 侧已把两者定为真人专属，配置面也挡了服务令牌 —— 但配置是配置，锁要落在决策点上。
      // 白名单式，与「替人定稿」那道同规：放行控制台代表的真人会话（system_admin），其余一律拒。
      // 原先是黑名单（列举 agent_node / system_service）—— 那条语义是"没列到的一律放行"，
      // 以后新增任何机器主体，默认就能做这件事，而且不会有任何东西报警。
      if (context?.principal?.kind !== "system_admin") {
        return {ok: false, error: "rule_layer_mutation_forbidden_for_machine_principal"};
      }
      return syncSkillSource(state, args.sourceId || "agency-agents-zh", {root, runtimeDir});
    case "skill-mcp.role_skill_parse":
      return roleSkillParse(state, args);
    case "skill-mcp.role_skill_overlay_validate":
      // 规则层（角色 SKILL.md 正文 / 覆盖层）不该由机器主体改：syncSkillSource 会整体替换
      // state.roleSkills，registerRoleSkillOverlay 直接产出 active 覆盖层并被下一次 buildTaskContract
      // 选中。REST 侧已把两者定为真人专属，配置面也挡了服务令牌 —— 但配置是配置，锁要落在决策点上。
      // 同上，白名单式：覆盖层是"项目级角色规则定制"，机器主体改它等于自己给自己换规矩。
      if (context?.principal?.kind !== "system_admin") {
        return {ok: false, error: "rule_layer_mutation_forbidden_for_machine_principal"};
      }
      return registerRoleSkillOverlay(state, args);
    case "skill-mcp.role_skill_resolve":
      return resolveRoleSkillView(state, args);
    case "evidence-mcp.artifact_register":
      return artifactRegister(state, args);
    case "evidence-mcp.checkpoint_submit":
      return acceptAgentCheckpoint(state, args, {root: args.repositoryRoot || repositoryRoot});
    case "evidence-mcp.test_result_submit":
      // 缺省作用域不得等于放行：这些实现在 taskGroupId/roomId 缺省时会落到控制面自己的
      // 任务组（tg_runtime_management）。受限主体必须显式点名一个它有权的作用域，
      // 与 close_barrier_compute / room_wait 同规 —— 同一形状不该有的有守卫、有的没有。
      return boundedTaskGroupGuard(state, args, context) || testResultSubmit(state, args);
    case "permission-mcp.permission_probe":
      return permissionProbe(state, args, principalProjectFilter(context));
    case "permission-mcp.permission_request_submit":
      return permissionRequestSubmit(state, args);
    case "permission-mcp.permission_status":
      return permissionStatus(state, args, context);
    case "permission-mcp.permission_resolve":
      // 与 confirmation_decide 同因：REST 侧把 permission_resolve 列为真人专属（批准一条权限请求
      // ＝把被挡住的那项能力交出去，拒绝分支还会级联终结执行），而这里是通向同一个函数的第二道门。
      // 它今天不在 agent 节点的工具集、也不在服务令牌默认白名单里，可一旦运维在
      // AIMAC_MCP_SERVICE_ALLOWED_TOOLS 里配上它，真人专属就被一个环境变量悄悄取消了 ——
      // 挡在决策点上，才与"谁能拿到这个工具"无关。
      // 白名单式，与「替人定稿」那道同规：放行控制台代表的真人会话（system_admin），其余一律拒。
      // 原先是黑名单（列举 agent_node / system_service）—— 那条语义是"没列到的一律放行"，
      // 以后新增任何机器主体，默认就能做这件事，而且不会有任何东西报警。
      if (context?.principal?.kind !== "system_admin") {
        return {ok: false, error: "permission_resolution_forbidden_for_machine_principal"};
      }
      return permissionResolve(state, args);
    case "human-review-mcp.confirmation_request_submit":
      // 与 REST 的 agent 通道同样收紧：MCP 主体只能提运行时执行确认，不得自选 decisionType/subjectRef/content
      // 来伪造核心决策单（那会让人的批准落到人没看过的对象上）。核心决策单只由控制面内部生成。
      return {request: createHumanConfirmationRequest(state, {
        nodeId: context?.principal?.kind === "agent_node" ? context.principal.id : args.nodeId,
        dispatchId: args.dispatchId,
        workItemId: args.workItemId,
        sessionId: args.sessionId,
        summary: args.summary,
        detail: args.detail,
        question: args.question,
        evidenceRefs: args.evidenceRefs,
        options: args.options,
        blocking: args.blocking,
        decisionType: "runtime_execution"
      })};
    case "human-review-mcp.confirmation_status": {
      const confirmation = (state.humanConfirmationRequests || []).find((item) => item.requestId === args.requestId);
      if (!confirmation || !confirmationReadableByPrincipal(confirmation, context)) return {ok: false, error: "human_confirmation_not_found"};
      return {request: confirmation};
    }
    case "human-review-mcp.confirmation_consume": {
      const confirmation = (state.humanConfirmationRequests || []).find((item) => item.requestId === args.requestId);
      if (!confirmation || !confirmationReadableByPrincipal(confirmation, context)) return {ok: false, error: "human_confirmation_not_found"};
      return {request: consumeHumanConfirmation(state, args.requestId, {actor: context?.principal?.id || "mcp-client"})};
    }
    case "human-review-mcp.confirmation_analyze": {
      const confirmation = (state.humanConfirmationRequests || []).find((item) => item.requestId === args.requestId);
      if (!confirmation) return {ok: false, error: "human_confirmation_not_found"};
      if (!confirmationReadableByPrincipal(confirmation, context)) return {ok: false, error: "human_confirmation_not_found"};
      // 这是 AI 在确认流程里唯一的发言权：可以反对、可以给更优方案，但不会终结决策。
      return {request: submitAiConfirmationAnalysis(state, args.requestId, args, {actor: context?.principal?.id || "agent-runtime"})};
    }
    case "human-review-mcp.confirmation_decide": {
      const confirmation = (state.humanConfirmationRequests || []).find((item) => item.requestId === args.requestId);
      if (!confirmation) return {ok: false, error: "human_confirmation_not_found"};
      // 定稿权只属于真人，而这是整套系统"人工定稿"这条不变式的最后一道闸。
      // 判据必须是【白名单】：原先写的是"拒绝 agent_node 与 system_service"，今天恰好完整
      //（/mcp 上只构造这三种主体，普通人类账号走 MCP 直接是 null），但黑名单的语义是
      // "没列到的一律放行"—— 以后新增任何机器主体，默认就能替人定稿，而且不会有任何东西报警。
      // 这条不变式不能靠"新增主体时记得回来改这里"。
      // system_admin 是控制台代表的真人会话（REST + 真人账号），只放行它。
      if (context?.principal?.kind !== "system_admin") {
        return {ok: false, error: "human_confirmation_decision_forbidden_for_machine_principal"};
      }
      if (!confirmationReadableByPrincipal(confirmation, context)) return {ok: false, error: "human_confirmation_not_found"};
      return {request: decideHumanConfirmation(state, args.requestId, args, {actor: context?.principal?.id || "mcp-client"})};
    }
    case "review-mcp.review_plan_create":
      return reviewPlanCreate(state, args);
    case "review-mcp.review_bundle_register":
      return reviewBundleRegister(state, args);
    case "review-mcp.review_result_consume":
      // 缺省作用域不得等于放行：这些实现在 taskGroupId/roomId 缺省时会落到控制面自己的
      // 任务组（tg_runtime_management）。受限主体必须显式点名一个它有权的作用域，
      // 与 close_barrier_compute / room_wait 同规 —— 同一形状不该有的有守卫、有的没有。
      return boundedTaskGroupGuard(state, args, context) || reviewResultConsume(state, args);
    case "review-mcp.completion_readiness_compute":
      return boundedTaskGroupGuard(state, args, context) || computeCompletionReadiness(state, args.taskGroupId || "tg_runtime_management", args);
    case "governance-mcp.approval_request_create":
      // Proposer identity is the authenticated MCP principal (for high_risk_no_self_approval), not client args.
      return approvalRequestCreate(state, {...args, proposedBy: context?.principal?.id || args.proposedBy || null});
    case "governance-mcp.policy_decision_eval":
      return policyDecisionEval(state, args);
    case "governance-mcp.finding_submit":
      return findingSubmit(state, args);
    case "governance-mcp.finding_resolve":
      // 无需在这里剥离自报的 humanActor：真人身份走 Symbol 键，JSON 入参表达不出来。
      return findingResolve(state, args);
    case "governance-mcp.approval_resolve":
      // Approver identity is the authenticated MCP principal (high_risk_no_self_approval + quorum tally).
      return approvalResolve(state, {...args, resolvedBy: context?.principal?.id || args.resolvedBy});
    case "governance-mcp.contract_publish":
      // 共享定义契约一旦 active 就进入每个后续任务契约与指令包，且不在阻塞集里，不会留下可见阻塞。
      // REST 的 contract_publish 是真人专属，这里是同一个函数的第二道门。
      // 白名单式，与「替人定稿」那道同规：放行控制台代表的真人会话（system_admin），其余一律拒。
      // 原先是黑名单（列举 agent_node / system_service）—— 那条语义是"没列到的一律放行"，
      // 以后新增任何机器主体，默认就能做这件事，而且不会有任何东西报警。
      if (context?.principal?.kind !== "system_admin") {
        return {ok: false, error: "contract_publish_forbidden_for_machine_principal"};
      }
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
      return boundedTaskGroupGuard(state, args, context) || computeCloseBarrier(state, args.taskGroupId || "tg_runtime_management", args);
    case "identity-mcp.account_invite":
      // 建账号是治理决策：REST 侧把 account_invite / system_account_invite 都定为真人专属，
      // 而这一侧此前直接落到实现上。两侧各写了一份实现（REST 是内联的），所以"同一个核心函数"
      // 那条对等检查结构上连不起来 —— 锁必须落在决策点本身，工具清单只是配置。
      // 白名单式，与「替人定稿」那道同规：放行控制台代表的真人会话（system_admin），其余一律拒。
      // 原先是黑名单（列举 agent_node / system_service）—— 那条语义是"没列到的一律放行"，
      // 以后新增任何机器主体，默认就能做这件事，而且不会有任何东西报警。
      if (context?.principal?.kind !== "system_admin") {
        return {ok: false, error: "account_invite_forbidden_for_machine_principal"};
      }
      return accountInvite(state, args);
    case "identity-mcp.account_suspend":
      return accountSuspend(state, args);
    case "identity-mcp.grant_create":
      return grantCreate(state, args);
    case "identity-mcp.grant_revoke":
      return grantRevoke(state, args);
    case "identity-mcp.permission_matrix_get":
      return permissionMatrixGet(state, principalProjectFilter(context));
    case "ui-console-mcp.runtime_health_get":
      return runtimeHealthGet(state);
    case "ui-console-mcp.management_surface_get":
      return {managementSurfaces: state.managementSurfaces};
    case "ui-console-mcp.project_progress_get":
      return progressGet(state, args, "project", principalProjectFilter(context));
    case "ui-console-mcp.task_group_progress_get":
      return progressGet(state, args, "task_group", principalProjectFilter(context));
    case "ui-console-mcp.guarded_action_dispatch":
      return guardedActionDispatch(state, args);
    case "definition-mcp.shared_definition_create":
      return sharedDefinitionCreate(state, args);
    case "definition-mcp.shared_definition_publish":
      return sharedDefinitionPublish(state, args);
    case "definition-mcp.shared_definition_consumer_bind":
      // 缺省作用域不得等于放行：这些实现在 taskGroupId/roomId 缺省时会落到控制面自己的
      // 任务组（tg_runtime_management）。受限主体必须显式点名一个它有权的作用域，
      // 与 close_barrier_compute / room_wait 同规 —— 同一形状不该有的有守卫、有的没有。
      return boundedTaskGroupGuard(state, args, context) || sharedDefinitionConsumerBind(state, args);
    case "definition-mcp.shared_definition_conflict_report":
      return sharedDefinitionConflictReport(state, args);
    case "instruction-mcp.instruction_envelope_create":
      return instructionEnvelopeCreate(state, args, "instruction_envelope");
    case "instruction-mcp.cache_key_index":
      return cacheKeyIndex(state, args, principalProjectFilter(context));
    case "instruction-mcp.stable_prefix_get":
      return stablePrefixGet(state, args, principalProjectFilter(context));
    case "instruction-mcp.delta_payload_compact":
      return deltaPayloadCompact(state, args);
    case "repository-mcp.repository_output_target_select":
      return repositoryOutputTargetSelect(state, args);
    case "repository-mcp.repository_target_lease_bind":
      return repositoryTargetLeaseBind(state, args);
    case "repository-mcp.artifact_manifest_index":
      return artifactManifestIndex(state, args, principalProjectFilter(context));
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
  const projectId = args.projectId || createId("prj");
  if (state.projects.some((item) => item.id === projectId)) return {ok: false, error: "project_id_conflict"};
  const ownerAccountId = args.ownerAccountId || "acct_workspace_owner";
  const ownerAccount = state.accounts.find((account) => account.accountId === ownerAccountId && ["active", "invited"].includes(account.status));
  if (!ownerAccount) {
    return {ok: false, error: "owner_account_not_found"};
  }
  const organizationId = ownerAccount.organizationId || DEFAULT_ORGANIZATION_ID;
  const quota = organizationQuotaCheck(state, organizationId, "projects");
  if (!quota.allowed) return {ok: false, error: quota.error, quota};
  const project = {
    id: projectId,
    organizationId,
    name: assertHumanTextWithinLimit(args.name || args.title || "AI-native Project", "project_name", 200),
    status: "active",
    ownerAccountId,
    members: [{accountId: ownerAccountId, role: "project_owner"}],
    repositoryRefs: args.repositoryRefs || [],
    progress: {percent: 0, phase: "initialized", health: "ok", updatedAt: at},
    createdAt: at,
    updatedAt: at
  };
  state.projects.unshift(project);
  const ownerGrant = ensureMcpProjectOwnerGrant(state, project, ownerAccountId, `policy:mcp:project_create:${projectId}`);
  computeProgressSnapshots(state);
  return {project, ownerGrant};
}

function createTaskGroup(state, args) {
  if (!args.projectId) return {ok: false, error: "project_id_required"};
  const project = state.projects.find((item) => item.id === args.projectId);
  if (!project) return {ok: false, error: "project_not_found"};
  // 与 REST 侧同规：归档的项目不得再新建任务组（那次收尾会白做，新组也没人看得见）。
  // 建组有两份实现，只补一份就是这类洞最常见的样子 —— 本文件上面那段注释已经为同一形状写过一次。
  if (project.status === "archived") return {ok: false, error: "project_archived"};
  const taskGroupId = args.taskGroupId || createId("tg");
  if (state.taskGroups.some((item) => item.id === taskGroupId)) return {ok: false, error: "task_group_id_conflict"};
  const quota = organizationQuotaCheck(state, project.organizationId || DEFAULT_ORGANIZATION_ID, "taskGroups");
  if (!quota.allowed) return {ok: false, error: quota.error, quota};
  const at = new Date().toISOString();
  const languagePolicy = normalizeTaskGroupLanguagePolicy(args.languagePolicy || args);
  const taskGroup = {
    id: taskGroupId,
    projectId: project.id,
    // 与 REST 侧同规（server.mjs 的同名字段）：自由文本有上限，超了就拒。
    // 少补这一侧的话，agent 一样能把状态撑大 —— 这类洞的常见样子就是孪生分支只补一半。
    name: assertHumanTextWithinLimit(args.name || args.title || "AI-native Task Group", "task_group_name", 200),
    title: assertHumanTextWithinLimit(args.title || args.name || "AI-native Task Group", "task_group_name", 200),
    objective: assertHumanTextWithinLimit(args.objective || args.title || "Machine-executed task group", "task_group_objective", 4000),
    // intake 是 TaskGroup 机器的初态。此前写的是 planned —— 机器里没有这个状态。
    status: "intake",
    goalExecutionStatus: "ready",
    phase: "planning",
    progress: 0,
    health: "ok",
    languagePolicy,
    roles: normalizeMcpRoleBindings(args.roles, ["orchestrator", "agent-runtime", "reviewer"]),
    workItems: [],
    blockers: [],
    createdAt: at,
    updatedAt: at
  };
  state.taskGroups.unshift(taskGroup);
  computeProgressSnapshots(state);
  return {taskGroup};
}

function ensureMcpProjectOwnerGrant(state, project, ownerAccountId, policyDecisionRef) {
  state.accessGrants ||= [];
  const existing = state.accessGrants.find((grant) =>
    grant.status === "active" &&
    grant.subjectRef?.subjectType === "account" &&
    grant.subjectRef?.subjectId === ownerAccountId &&
    grant.resource?.resourceType === "project" &&
    grant.resource?.resourceId === project.id &&
    grant.role === "project_owner"
  );
  if (existing) {
    existing.permissions = [...projectOwnerGrantPermissions];
    existing.updatedAt = new Date().toISOString();
    return existing;
  }
  const at = new Date().toISOString();
  const grant = {
    schemaVersion: "access-control-grant/v1",
    grantId: createId("grant"),
    subjectRef: {subjectType: "account", subjectId: ownerAccountId},
    resource: {resourceType: "project", resourceId: project.id},
    role: "project_owner",
    permissions: [...projectOwnerGrantPermissions],
    status: "active",
    policyDecisionRef,
    auditRef: `audit:mcp:project_create:${project.id}`,
    createdAt: at,
    updatedAt: at
  };
  state.accessGrants.unshift(grant);
  return grant;
}

function createWorkItem(state, args) {
  // A work item must attach to an explicitly named task group — never findTaskGroup's taskGroups[0] fallback,
  // which would add the item to an arbitrary tenant's task group when taskGroupId is omitted.
  const taskGroup = args.taskGroupId ? findTaskGroup(state, args.taskGroupId) : null;
  if (!taskGroup) return {ok: false, error: "task_group_not_found"};
  // 与 REST 侧同规：终结的任务组不得再加新活。建组那对孪生实现上一轮就漏过一次，这对同样两份都要补。
  const settledRejection = taskGroupSettledRejection(state, taskGroup.id);
  if (settledRejection) return settledRejection;
  const workItemId = args.workItemId || createId("work");
  if ((taskGroup.workItems || []).some((item) => item.id === workItemId)) return {ok: false, error: "work_item_id_conflict"};
  const at = new Date().toISOString();
  const workItem = {
    id: workItemId,
    title: assertHumanTextWithinLimit(args.title || "AI-native work item", "work_item_title", 200),
    // 与 REST 侧同规（server.mjs 的 workItemCreateStatus）：不填＝ready 是合理的创建默认，
    // 填错必须拒 —— 认不出的状态原先降级成"可开跑"。孪生分支只补一半是这类洞最常见的样子。
    status: mcpWorkItemCreateStatus(args.status),
    ownerRole: mcpWorkItemOwnerRole(args.roleId || args.ownerRole),
    progress: 0,
    requirements: normalizeMcpStringList(args.requirements, [], "work_item_requirements"),
    createdAt: at,
    updatedAt: at
  };
  taskGroup.workItems ||= [];
  taskGroup.workItems.push(workItem);
  taskGroup.roles ||= [];
  if (!taskGroup.roles.some((role) => role.roleId === workItem.ownerRole)) {
    taskGroup.roles.push({roleId: workItem.ownerRole, status: "ready", skillBinding: "server_resolved_on_dispatch"});
  }
  taskGroup.updatedAt = at;
  computeProgressSnapshots(state);
  return {taskGroupId: taskGroup.id, workItem, taskGroup};
}

function findWorkItem(state, taskGroupId, workItemId) {
  const taskGroup = findTaskGroup(state, taskGroupId);
  return workItemId ? taskGroup?.workItems?.find((item) => item.id === workItemId) || null : taskGroup?.workItems?.[0] || null;
}

export function assignWorkItem(state, args) {
  const taskGroup = findTaskGroup(state, args.taskGroupId);
  const workItem = findWorkItem(state, taskGroup?.id, args.workItemId);
  if (!taskGroup || !workItem) return {ok: false, error: "work_item_not_found"};
  workItem.ownerRole = args.roleId || args.ownerRole || workItem.ownerRole || "orchestrator";
  if (workItem.status === "draft") workItem.status = "ready";
  workItem.updatedAt = new Date().toISOString();
  const modelDecision = selectModel(state, {projectId: taskGroup.projectId, taskGroupId: taskGroup.id, workItemId: workItem.id, roleId: workItem.ownerRole});
  return {taskGroupId: taskGroup.id, workItem, modelDecision};
}

function stateGet(state, args, context = {}) {
  const scope = args.scope || "summary";
  computeProgressSnapshots(state);
  if (context.principal?.kind === "agent_node") {
    const scoped = scopeStateForAgentPrincipal(state, context.principal, context.grantCheck?.grants || []);
    if (scope === "full") {
      // Gate full state behind the same env flag as the system_service/admin branches (least privilege):
      // even tenant-scoped, a full dump is far more than an agent needs. The agent runtime only ever
      // reads summary scope, so this denies nothing it depends on.
      if (process.env.AIMAC_MCP_ALLOW_FULL_STATE !== "true") {
        return {ok: false, error: "full_state_scope_not_allowed", summary: summaryState(scoped)};
      }
      return {state: redactStateForMcp(scoped)};
    }
    return summaryState(scoped);
  }
  if (context.principal?.kind === "system_service") {
    const scoped = scopeStateForProjectPrincipal(state, context.principal);
    if (scope === "full") {
      if (process.env.AIMAC_MCP_ALLOW_FULL_STATE !== "true") {
        return {ok: false, error: "full_state_scope_not_allowed", summary: summaryState(scoped)};
      }
      return {state: redactStateForMcp(scoped)};
    }
    return summaryState(scoped);
  }
  if (scope === "full") {
    if (process.env.AIMAC_MCP_ALLOW_FULL_STATE !== "true") {
      return {ok: false, error: "full_state_scope_not_allowed", summary: summaryState(state)};
    }
    return {state: redactStateForMcp(state)};
  }
  return summaryState(state);
}

// Fail-closed allowlist for MCP-scoped full state: any top-level key not listed is deleted, so a newly
// added collection can never default to leaking cross-tenant (mirrors the UI SCOPED_ALLOWED_TOP_KEYS).
const MCP_SCOPED_ALLOWED_TOP_KEYS = new Set([
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
  "derivedTaskRequests", "eventLog", "authSessions"
]);

// Fail-closed finalizer applied AFTER each principal's specific filters: filter every remaining
// tenant-attributed collection by the principal's visible task groups / projects, empty the global
// management collections, and drop any non-whitelisted top-level key. Without this, scope:"full"
// returned a deep clone minus only a handful of collections — leaking 20+ tenant collections
// (findings/testResults/checkpoints/closeBarriers/roomMessages/reviewBundles/auditLog/...) cross-project.
function finalizeScopedMcpState(scoped, projectIdSet, visibleTaskGroupIds) {
  const tg = (item) => Boolean(item && item.taskGroupId && visibleTaskGroupIds.has(item.taskGroupId));
  const tgOrProject = (item) => item && (item.taskGroupId ? visibleTaskGroupIds.has(item.taskGroupId) : projectIdSet.has(item.projectId));
  scoped.agentTaskContracts = (scoped.agentTaskContracts || []).filter(tg);
  scoped.effectiveInstructionPackets = (scoped.effectiveInstructionPackets || []).filter(tg);
  scoped.roleDriftGuards = (scoped.roleDriftGuards || []).filter(tg);
  scoped.modelSelectionDecisions = (scoped.modelSelectionDecisions || []).filter(tg);
  scoped.sessionPlacementDecisions = (scoped.sessionPlacementDecisions || []).filter(tg);
  scoped.executionTopologies = (scoped.executionTopologies || []).filter(tg);
  scoped.reviewPlans = (scoped.reviewPlans || []).filter(tg);
  scoped.reviewBundles = (scoped.reviewBundles || []).filter(tg);
  scoped.checkpoints = (scoped.checkpoints || []).filter(tg);
  scoped.completionReadiness = (scoped.completionReadiness || []).filter(tg);
  scoped.closeBarriers = (scoped.closeBarriers || []).filter(tg);
  scoped.admissionDecisions = (scoped.admissionDecisions || []).filter(tgOrProject);
  scoped.admissionScans = (scoped.admissionScans || []).filter(tgOrProject);
  scoped.permissionRequests = (scoped.permissionRequests || []).filter(tg);
  scoped.approvalRequests = (scoped.approvalRequests || []).filter(tg);
  scoped.artifacts = (scoped.artifacts || []).filter(tg);
  scoped.testResults = (scoped.testResults || []).filter(tg);
  scoped.findings = (scoped.findings || []).filter(tg);
  scoped.qualityGates = (scoped.qualityGates || []).filter(tg);
  scoped.derivedTaskRequests = (scoped.derivedTaskRequests || []).filter(tg);
  scoped.humanConfirmationRequests = (scoped.humanConfirmationRequests || []).filter(tg);
  scoped.humanDirectives = (scoped.humanDirectives || []).filter(tgOrProject);
  scoped.eventLog = (scoped.eventLog || []).filter(tg);
  scoped.roleSkillOverlays = (scoped.roleSkillOverlays || []).filter((overlay) =>
    (overlay.taskGroupId && visibleTaskGroupIds.has(overlay.taskGroupId)) ||
    (!overlay.taskGroupId && overlay.projectId && projectIdSet.has(overlay.projectId)));
  scoped.sharedDefinitions = (scoped.sharedDefinitions || []).filter((definition) =>
    projectIdSet.has(definition.projectId) ||
    (definition.scopeRefs || []).some((ref) => visibleTaskGroupIds.has(String(ref).replace("TaskGroup:", ""))));
  scoped.leases = (scoped.leases || []).filter((lease) =>
    (scoped.repositoryOutputs || []).some((target) => lease.resourceRef === `RepositoryOutputTarget:${target.targetId}`));
  const visibleRoomIds = new Set([...visibleTaskGroupIds].map((taskGroupId) => `room_${taskGroupId}`));
  scoped.roomMessages = (scoped.roomMessages || []).filter((message) => visibleRoomIds.has(message.roomId));
  scoped.roomParticipants = (scoped.roomParticipants || []).filter((participant) => visibleRoomIds.has(participant.roomId));
  scoped.roomAcks = (scoped.roomAcks || []).filter((ack) => visibleRoomIds.has(ack.roomId));
  scoped.roomSequenceByRoom = Object.fromEntries(Object.entries(scoped.roomSequenceByRoom || {}).filter(([roomId]) => visibleRoomIds.has(roomId)));
  scoped.agentRuntimeNodes = (scoped.agentRuntimeNodes || []).filter((node) => (node.projectIds || []).some((projectId) => projectIdSet.has(projectId)));
  scoped.agents = (scoped.agents || []).filter((agent) => !agent.projectId || projectIdSet.has(agent.projectId));
  scoped.instructionMetrics = {
    ...scoped.instructionMetrics,
    envelopes: (scoped.instructionMetrics?.envelopes || []).filter((envelope) => envelope.taskGroupId && visibleTaskGroupIds.has(envelope.taskGroupId))
  };
  // Global / management collections: never visible to a scoped principal.
  scoped.agentJoinTokens = [];
  scoped.authSessions = [];
  scoped.auditLog = [];
  scoped.policyDecisions = [];
  scoped.commands = [];
  scoped.decisionRecords = [];
  scoped.commandEffects = [];
  scoped.dlqEntries = [];
  scoped.integrationBatches = [];
  scoped.idempotencyRecords = {};
  scoped.runtimeIssuePatterns = [];
  scoped.runtimeIssueSamples = [];
  scoped.systemUpgradeCandidates = [];
  scoped.agentGatewayEvents = [];
  scoped.mcpCalls = [];
  scoped.mcpProbeNodes = [];
  // 转移证据不出 API，任何视角都不给 —— 它的记录里没有 projectId/taskGroupId，放出去就是把别的租户的
  // 对象 id 与状态流转一起交出去。它是给事故时直接看磁盘 state 的人用的取证记录。
  // 想把它接进控制台的话，先给 recordTransition 补上租户归属再谈，别只改这一行。
  scoped.transitionEvidence = [];
  scoped.ruleSourceResolutions = [];
  scoped.externalUpgradeImports = [];
  for (const key of Object.keys(scoped)) {
    if (!MCP_SCOPED_ALLOWED_TOP_KEYS.has(key)) delete scoped[key];
  }
  return scoped;
}

function scopeStateForProjectPrincipal(state, principal) {
  const projectIds = new Set(principal.projectIds || []);
  if (projectIds.has("*")) return JSON.parse(JSON.stringify(state));
  const visibleTaskGroupIds = new Set((state.taskGroups || [])
    .filter((taskGroup) => projectIds.has(taskGroup.projectId))
    .map((taskGroup) => taskGroup.id));
  const scoped = JSON.parse(JSON.stringify(state));
  scoped.projects = (scoped.projects || []).filter((project) => projectIds.has(project.id));
  scoped.taskGroups = (scoped.taskGroups || []).filter((taskGroup) => visibleTaskGroupIds.has(taskGroup.id));
  scoped.progressSnapshots = (scoped.progressSnapshots || []).filter((snapshot) =>
    progressSnapshotVisibleForScope(snapshot, projectIds, visibleTaskGroupIds)
  );
  scoped.agentDispatches = (scoped.agentDispatches || []).filter((dispatch) =>
    projectIds.has(dispatch.projectId) && visibleTaskGroupIds.has(dispatch.taskGroupId)
  );
  scoped.workSessions = (scoped.workSessions || []).filter((session) => visibleTaskGroupIds.has(session.taskGroupId));
  scoped.repositoryOutputs = (scoped.repositoryOutputs || []).filter((target) =>
    projectIds.has(target.projectId) && visibleTaskGroupIds.has(target.taskGroupId)
  );
  scoped.agentExecutionEvents = (scoped.agentExecutionEvents || []).filter((event) =>
    projectIds.has(event.projectId) && visibleTaskGroupIds.has(event.taskGroupId)
  );
  scoped.agentControlCommands = (scoped.agentControlCommands || []).filter((command) =>
    !command.projectId || projectIds.has(command.projectId)
  );
  scoped.accounts = [];
  scoped.authSessions = [];
  scoped.accessGrants = [];
  scoped.agentJoinTokens = [];
  scoped.mcpGrants = (scoped.mcpGrants || []).filter((grant) => !grant.projectId || projectIds.has(grant.projectId));
  return finalizeScopedMcpState(scoped, projectIds, visibleTaskGroupIds);
}

function scopeStateForAgentPrincipal(state, principal, grants = []) {
  const projectIds = new Set(principal.projectIds || []);
  const grantTaskGroupIds = new Set(grants.map((grant) => grant.taskGroupId).filter(Boolean));
  const grantDispatchIds = new Set(grants.map((grant) => grant.dispatchId).filter(Boolean));
  const visibleTaskGroupIds = new Set((state.taskGroups || [])
    .filter((taskGroup) => projectIds.has(taskGroup.projectId) && (!grantTaskGroupIds.size || grantTaskGroupIds.has(taskGroup.id)))
    .map((taskGroup) => taskGroup.id));
  const scoped = JSON.parse(JSON.stringify(state));
  scoped.projects = (scoped.projects || []).filter((project) => projectIds.has(project.id));
  scoped.taskGroups = (scoped.taskGroups || []).filter((taskGroup) => visibleTaskGroupIds.has(taskGroup.id));
  scoped.progressSnapshots = (scoped.progressSnapshots || []).filter((snapshot) =>
    progressSnapshotVisibleForScope(snapshot, projectIds, visibleTaskGroupIds)
  );
  scoped.agentDispatches = (scoped.agentDispatches || []).filter((dispatch) =>
    dispatch.assignedNodeId === principal.id || grantDispatchIds.has(dispatch.dispatchId)
  );
  scoped.workSessions = (scoped.workSessions || []).filter((session) =>
    visibleTaskGroupIds.has(session.taskGroupId) && scoped.agentDispatches.some((dispatch) => dispatch.sessionId === session.sessionId)
  );
  scoped.repositoryOutputs = (scoped.repositoryOutputs || []).filter((target) =>
    projectIds.has(target.projectId) && visibleTaskGroupIds.has(target.taskGroupId)
  );
  scoped.roleSkills = [];
  scoped.roleSkillOverlays = [];
  scoped.accounts = [];
  scoped.accessGrants = [];
  scoped.authSessions = [];
  // Task-group-attributed events/commands gate on the agent's granted task groups; node-level records
  // (no taskGroupId) only for this agent's own node. Mirrors the project path + UI scopedStateForAccount.
  scoped.agentExecutionEvents = (scoped.agentExecutionEvents || []).filter((event) =>
    (event.taskGroupId && visibleTaskGroupIds.has(event.taskGroupId)) || event.nodeId === principal.id);
  scoped.agentControlCommands = (scoped.agentControlCommands || []).filter((command) =>
    command.taskGroupId ? visibleTaskGroupIds.has(command.taskGroupId) : command.nodeId === principal.id);
  scoped.mcpGrants = (scoped.mcpGrants || []).filter((grant) => grant.agentNodeId === principal.id && grant.grantStatus === "issued");
  return finalizeScopedMcpState(scoped, projectIds, visibleTaskGroupIds);
}

function progressSnapshotVisibleForScope(snapshot, projectIds, visibleTaskGroupIds) {
  if (snapshot.scopeType === "project") return projectIds.has(snapshot.scopeRef);
  if (snapshot.scopeType === "task_group") return visibleTaskGroupIds.has(snapshot.scopeRef);
  return false;
}

function scopedDispatch(state, dispatchId, context = {}) {
  const dispatch = state.agentDispatches.find((item) => item.dispatchId === dispatchId);
  if (!dispatch) return null;
  if (context.principal?.kind !== "agent_node") return dispatch;
  const grantDispatchIds = new Set((context.grantCheck?.grants || []).map((grant) => grant.dispatchId));
  return dispatch.assignedNodeId === context.principal.id || grantDispatchIds.has(dispatch.dispatchId) ? dispatch : null;
}

// "summary" 此前把全部任务组（含全部工作单元）、全部进度快照、全部派发原样塞了进去 ——
// 实测 1500 单元时它和 full 一样大（3MB），full 需要开关才允许的那道最小权限门因此在体积上
// 什么也没省下。而这份东西是发给 AI agent 的工具输出：它直接占 agent 的上下文、按 token 计费。
// 截断可以，但 agent 会据此判断"是不是全部"，所以每一处截断都要带上真实总数与标记。
const MCP_SUMMARY_CAP = Math.max(5, Number(process.env.AIMAC_MCP_SUMMARY_CAP || 25));
const MCP_SUMMARY_WORK_ITEM_CAP = Math.max(5, Number(process.env.AIMAC_MCP_SUMMARY_WORK_ITEM_CAP || 20));

function summarizeList(items, cap) {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= cap) return {list, total: list.length, truncated: false};
  return {list: list.slice(0, cap), total: list.length, truncated: true};
}

export function summaryState(state) {
  const truncated = {};
  const take = (name, items, cap) => {
    const {list, total, truncated: cut} = summarizeList(items, cap);
    if (cut) truncated[name] = {returned: list.length, total};
    return list;
  };
  const taskGroups = take("taskGroups", state.taskGroups, MCP_SUMMARY_CAP).map((taskGroup) => {
    const items = Array.isArray(taskGroup.workItems) ? taskGroup.workItems : [];
    if (items.length <= MCP_SUMMARY_WORK_ITEM_CAP) return {...taskGroup, workItemCount: items.length};
    truncated[`taskGroups.${taskGroup.id}.workItems`] = {returned: MCP_SUMMARY_WORK_ITEM_CAP, total: items.length};
    return {...taskGroup, workItems: items.slice(0, MCP_SUMMARY_WORK_ITEM_CAP),
      workItemCount: items.length, workItemsTruncated: true};
  }).map((taskGroup) => {
    // taskAnalysis.items 每个工作单元一条：摘要里只留条数，需要明细走专用工具或 full 作用域。
    const analysis = taskGroup.taskAnalysis;
    if (!analysis || !Array.isArray(analysis.items)) return taskGroup;
    truncated[`taskGroups.${taskGroup.id}.taskAnalysis.items`] = {returned: 0, total: analysis.items.length};
    return {...taskGroup, taskAnalysis: {...analysis, items: undefined, itemCount: analysis.items.length}};
  });
  // 进度快照单条把 repositoryOutputs 与 workItems 整份嵌了进去（实测 97KB/条）。
  // 摘要里只留标识与汇总字段：需要明细的走对应的专用工具或 full 作用域。
  const progressSnapshots = take("progressSnapshots", state.progressSnapshots, MCP_SUMMARY_CAP)
    .map(({workItems, repositoryOutputs, ...rest}) => rest);
  return {
    runtime: state.runtime,
    projects: take("projects", state.projects, MCP_SUMMARY_CAP),
    taskGroups,
    progressSnapshots,
    modelCapabilities: take("modelCapabilities", state.modelCapabilities, MCP_SUMMARY_CAP),
    skillSources: take("skillSources", state.skillSources, MCP_SUMMARY_CAP),
    roleSkillCount: state.roleSkills.length,
    agentDispatches: take("agentDispatches", state.agentDispatches, MCP_SUMMARY_CAP),
    // 截断了什么、少了多少，必须明说：agent 会拿"列表里没有"当成"不存在"。
    ...(Object.keys(truncated).length ? {truncated} : {})
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
    // participantId 原先取自调用方，而这张表是按 participantId 替换的 —— 传别人的 id 就能覆盖
    // 别人的记录（改掉它的 roleId/cursor/sessionId）。名单不参与授权判定，所以这不是提权；
    // 但一张能被任意改写的名单，一旦将来被呈现给人或被拿来判断，就是错的来源。
    // 与房间消息署名同一处理：身份由已认证主体派生，报文里的自报值不采信。
    participantId: args[ROOM_PARTICIPANT_KEY] || createId("room_participant"),
    roomId: args.roomId || `room_${args.taskGroupId || "tg_runtime_management"}`,
    sessionId: args.sessionId,
    roleId: args.roleId || "agent-runtime",
    cursor: Number(args.cursor || 0),
    status: "joined",
    joinedAt: at,
    updatedAt: at
  };
  // 与同文件里 roomAcks 的 5000 上限同因：participantId 缺省时每次 join 都生成新 id，所以这张表
  // 是按调用次数增长的。参与者名单不参与任何授权判定（roomSend/roomWait 从不查询它），也没有任何
  // 门在读它，因此按最近使用截断不会摘掉任何门依赖的东西。
  state.roomParticipants = [participant, ...state.roomParticipants.filter((item) => item.participantId !== participant.participantId)]
    .slice(0, Math.max(100, Number(process.env.AIMAC_ROOM_PARTICIPANTS_MAX || 5000)));
  return {participant};
}

function roomAck(state, args) {
  const at = new Date().toISOString();
  const roomId = args.roomId || `room_${args.taskGroupId || "tg_runtime_management"}`;
  const participantId = args.participantId || args.sessionId || "agent-runtime";
  const existing = (state.roomAcks || []).find((item) => item.roomId === roomId && item.participantId === participantId);
  const ack = {
    ackId: existing?.ackId || args.ackId || createId("room_ack"),
    roomId,
    participantId,
    messageRefs: args.messageRefs || [],
    cursor: Math.max(Number(args.cursor || 0), existing ? Number(existing.cursor || 0) : 0),
    createdAt: existing?.createdAt || at,
    updatedAt: at
  };
  // Ack is a per-participant cursor: replace in place rather than append unbounded history.
  state.roomAcks = [ack, ...(state.roomAcks || []).filter((item) => !(item.roomId === roomId && item.participantId === participantId))].slice(0, 5000);
  return {ack};
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function nodeRegister(state, args) {
  const at = new Date().toISOString();
  state.mcpProbeNodes ||= [];
  const node = {
    schemaVersion: "mcp-probe-node/v1",
    nodeId: args.nodeId || createId("probe_node"),
    status: "online",
    endpoint: args.endpoint || "remote-agent-gateway",
    capabilityFlags: args.capabilityFlags || ["room", "command", "mcp_proxy", "permission_request", "git"],
    toolSignals: args.toolSignals || ["node", "git"],
    mcpServers: Object.keys(mcpToolGroups),
    modelProviders: state.modelCapabilities.map((item) => item.providerClass),
    trustScore: Number(args.trustScore || 0.9),
    registeredAt: at,
    updatedAt: at
  };
  state.mcpProbeNodes = [node, ...state.mcpProbeNodes.filter((item) => item.nodeId !== node.nodeId)].slice(0, 200);
  return {node};
}

function nodeProbe(state, args) {
  state.mcpProbeNodes ||= [];
  const node = state.mcpProbeNodes.find((item) => item.nodeId === args.nodeId) || nodeRegister(state, args).node;
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

export function sessionMutate(state, args, status) {
  const session = state.workSessions.find((item) => item.sessionId === args.sessionId);
  if (!session) return {ok: false, error: "session_not_found"};
  session.status = status;
  session.updatedAt = new Date().toISOString();
  const controlCommands = [];
  const directDispatches = [];
  for (const dispatch of state.agentDispatches.filter((item) => item.sessionId === session.sessionId && !["completed", "failed", "cancelled"].includes(item.status))) {
    const commandType = status === "aborted" ? "cancel_dispatch" : status === "paused" ? "pause_dispatch" : null;
    const node = dispatch.assignedNodeId ? state.agentRuntimeNodes.find((item) => item.nodeId === dispatch.assignedNodeId) : null;
    if (commandType && node && ["running", "blocked"].includes(dispatch.status)) {
      const result = createAgentControlCommand(state, node, {
        commandType,
        dispatchId: dispatch.dispatchId,
        sessionId: session.sessionId,
        taskGroupId: session.taskGroupId,
        payload: {reason: `mcp_session_${status}`}
      }, {
        actor: "mcp-agent-control",
        idempotencyKey: `${args.idempotencyKey || "mcp-session-control"}:${dispatch.dispatchId}`
      });
      controlCommands.push(result.command);
      continue;
    }
    if (status === "cancelled") {
      dispatch.status = "cancelled";
      dispatch.failureReason = "mcp_session_cancelled";
    }
    if (status === "paused") {
      dispatch.status = "blocked";
      dispatch.blockedReason = "mcp_session_paused";
    }
    if (status === "active" && ["blocked", "cancelled"].includes(dispatch.status)) {
      dispatch.status = "queued";
      delete dispatch.blockedReason;
      delete dispatch.failureReason;
      delete dispatch.assignedNodeId;
      delete dispatch.claimedAt;
      delete dispatch.claimExpiresAt;
    }
    if (commandType && dispatch.assignedNodeId) revokeDispatchMcpGrants(state, dispatch.assignedNodeId, dispatch.dispatchId, `mcp_session_${status}`);
    dispatch.updatedAt = session.updatedAt;
    directDispatches.push(dispatch.dispatchId);
  }
  return {session, controlCommands, directDispatches};
}

export function capacitySnapshot(state, filter) {
  // A bounded principal only sees capacity for its own projects; a null filter (system_admin /
  // wildcard) sees global aggregates. Prevents cross-tenant operational disclosure via this read.
  // 与 core 共用：手打第四份副本正是 cancelled/paused 这类未登记状态漂移进来的原因。
  const terminal = WORK_SESSION_SETTLED_STATUSES;
  const inScope = (item) => !filter || (item.projectId && filter.has(item.projectId));
  const sessions = state.workSessions.filter(inScope);
  const dispatches = state.agentDispatches.filter(inScope);
  return {
    activeSessions: sessions.filter((item) => !terminal.includes(item.status)).length,
    activeSubagents: sessions.filter((item) => item.placement === "subagent" && !terminal.includes(item.status)).length,
    dispatchQueueDepth: dispatches.filter((item) => ["queued", "blocked"].includes(item.status)).length,
    // 这两个计数此前都按 item.projectId 过滤，而两种记录都【没有这个字段】：
    // agents 是全局角色/模型注册表（记录里根本没有项目归属），节点带的是复数 projectIds。
    // 于是对任何受限主体，两个数恒为 0 —— 调度方拿它判断容量，会一律得出"没有容量"。
    // 失败方向是安全的（少报不泄漏），但报的是假数，而这个快照存在的意义就是让人/agent 据此决策。
    // agents 与 modelProviderCount 同类（全局注册表、计数不含租户数据），按同一规矩全局上报。
    agentCount: state.agents.length,
    nodeCount: filter
      ? state.agentRuntimeNodes.filter((item) => (item.projectIds || []).some((id) => filter.has(id))).length
      : state.agentRuntimeNodes.length,
    modelProviderCount: state.modelCapabilities.length
  };
}

// Project scope filter for read tools: null = unrestricted (system_admin, or a wildcard/unset principal),
// otherwise a Set of the bounded principal's project ids. Read handlers filter their output by this so a
// bounded remote-service token cannot read another tenant's operational or authorization data.
function principalProjectFilter(context = {}) {
  const principal = context.principal || {};
  if (principal.kind === "system_admin") return null;
  const ids = principal.projectIds;
  if (!Array.isArray(ids) || ids.includes("*")) return null;
  return new Set(ids);
}

// For read tools that would otherwise default to tg_runtime_management: a bounded principal must
// address an in-scope taskGroupId, else it could read the control-plane project's state. Returns an
// error result to short-circuit, or null when unrestricted / in-scope.
function boundedTaskGroupGuard(state, args, context) {
  const filter = principalProjectFilter(context);
  if (!filter) return null;
  if (!args.taskGroupId) return {ok: false, error: "task_group_id_required_for_bounded_principal"};
  const project = state.taskGroups.find((item) => item.id === args.taskGroupId)?.projectId;
  if (!project || !filter.has(project)) return {ok: false, error: "out_of_scope"};
  return null;
}

// room_wait is read-only, so the write default-deny does not cover it; roomWait defaults an omitted
// selector to the control-plane room (room_tg_runtime_management). A bounded principal must therefore
// name an in-scope room — deny the default and any room that cannot be tied to a project in its filter
// (fail-closed), mirroring boundedTaskGroupGuard. Returns an error result to short-circuit, or null.
function boundedRoomGuard(state, args, context) {
  const filter = principalProjectFilter(context);
  if (!filter) return null;
  const roomId = args.roomId || (args.taskGroupId ? `room_${args.taskGroupId}` : null);
  if (!roomId) return {ok: false, error: "room_id_required_for_bounded_principal"};
  const taskGroupId = roomId.startsWith("room_") ? roomId.slice("room_".length) : roomId;
  const project = state.taskGroups.find((item) => item.id === taskGroupId)?.projectId;
  if (!project || !filter.has(project)) return {ok: false, error: "out_of_scope"};
  return null;
}

function resourceSnapshot(state, args, filter) {
  const leaseInScope = (lease) => {
    if (!filter) return true;
    const ref = String(lease.resourceRef || "");
    const target = ref.startsWith("RepositoryOutputTarget:")
      ? state.repositoryOutputs.find((item) => `RepositoryOutputTarget:${item.targetId}` === ref)
      : null;
    return Boolean(target && filter.has(target.projectId));
  };
  return {
    leases: state.leases.filter((item) => (!args.status || item.status === args.status) && leaseInScope(item)),
    repositoryOutputs: state.repositoryOutputs.filter((item) => (!args.taskGroupId || item.taskGroupId === args.taskGroupId) && (!filter || filter.has(item.projectId)))
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

// 这个视图原先自己实现了一遍"按角色找技能"，而且比 core 那份宽松得多：
//   · 用 roleSkillId.includes(roleId) 子串匹配（"review" 能撞上 reviewer 的技能）；
//   · 都找不到就落到 state.roleSkills[0] —— 数组顺序由技能源同步的替换写法决定，实质上是任意的；
//   · 回退不留痕，agent 问"我这个角色的规则是什么"，拿到的是别人的规则，一声不吭。
// core 的 resolveRoleSkill 早就把这些处理好了（歧义抛错、回退到通用技能但在返回值上标出
// roleSkillFallback）。同一件事不再实现第二遍 —— 派发时按 core 那份绑定，
// 而 agent 事先问到的却是另一套答案，那比两边都错更难查。
function resolveRoleSkillView(state, args) {
  const roleId = args.roleId || args.ownerRole || "orchestrator";
  const resolved = resolveRoleSkill(state, roleId,
    {skillRef: args.roleSkillRef, taskGroupId: args.taskGroupId, projectId: args.projectId});
  const overlays = state.roleSkillOverlays.filter((overlay) =>
    overlay.roleSkillRef === resolved?.roleSkillId &&
    (!overlay.taskGroupId || overlay.taskGroupId === args.taskGroupId) &&
    (!overlay.projectId || overlay.projectId === args.projectId)
  );
  return {roleSkill: resolved, overlays,
    ...(resolved?.roleSkillFallback ? {roleSkillFallback: resolved.roleSkillFallback} : {}),
    precedence: ["task_group_overlay", "project_overlay", "upstream_default"]};
}

const TEST_RESULT_STATUSES = ["passed", "failed", "skipped", "error"];

export function testResultSubmit(state, args) {
  const at = new Date().toISOString();
  const taskGroup = taskGroupForRecord(state, args);
  // status 原先缺省即 "passed"：一次不带任何参数的调用就能造出一道【通过】的质量门，
  // 而质量门正是人看到"全通过"时的唯一依据、并直接喂给关闭门。
  // 缺信息永远不该变成通过 —— 误差不对称：错记一次通过，比错记一次未通过危险得多。
  // 这是命令接口（调用方发起的动作请求），因此按"拒绝并报出"处理，而不是替它猜一个。
  if (!TEST_RESULT_STATUSES.includes(String(args.status || ""))) {
    return {ok: false, error: "test_result_status_required",
      required: TEST_RESULT_STATUSES,
      message: "提交测试结果必须显式给出 status（passed/failed/skipped/error）：缺省不会被当作通过"};
  }
  const testResult = {
    testResultId: args.testResultId || createId("test_result"),
    projectId: taskGroup?.projectId || args.projectId || "prj_control_plane",
    taskGroupId: taskGroup?.id || args.taskGroupId || "tg_runtime_management",
    workItemId: args.workItemId || args.workId,
    status: args.status,
    gateType: args.gateType || "test",
    command: args.command,
    summary: args.summary || "",
    evidenceRefs: args.evidenceRefs || [],
    createdAt: at
  };
  state.testResults = capRetainingOpen([testResult, ...state.testResults], ["passed", "failed", "skipped", "error"], 2000);
  // Derive a QualityGate so this evidence actually gates the close barrier (all_quality_gates_passed).
  const qualityGate = recordQualityGateFromTest(state, testResult);
  return {testResult, qualityGate};
}

// A permission request is readable by: system_admin; the agent node whose dispatch/session owns it;
// or an account/service principal scoped to the request's task-group project. Without this a bounded
// principal could read any tenant's permission request by (enumerable) requestId (cross-tenant IDOR).
function permissionRequestReadableByPrincipal(state, request, context = {}) {
  const principal = context.principal || {};
  if (principal.kind === "system_admin") return true;
  if (principal.kind === "agent_node") {
    // Match the still-bound node OR the node it was bound to before a deny/abandon cascade unbound it,
    // so a node can always read the terminal outcome of its own permission request.
    return Boolean(request.sessionId) && (state.agentDispatches || []).some((item) => item.sessionId === request.sessionId && (item.assignedNodeId === principal.id || item.previousNodeId === principal.id));
  }
  if (Array.isArray(principal.projectIds)) {
    if (principal.projectIds.includes("*")) return true;
    const project = (state.taskGroups || []).find((item) => item.id === request.taskGroupId)?.projectId;
    return Boolean(project) && principal.projectIds.includes(project);
  }
  return false;
}

function permissionStatus(state, args, context) {
  const request = state.permissionRequests.find((item) => item.requestId === args.requestId);
  if (!request || !permissionRequestReadableByPrincipal(state, request, context)) return {permissionRequest: null, ok: false, error: "permission_request_not_found"};
  return {permissionRequest: request};
}

export function permissionResolve(state, args) {
  const request = state.permissionRequests.find((item) => item.requestId === args.requestId);
  if (!request) return {ok: false, error: "permission_request_not_found"};
  // Idempotency / terminal guard (mirrors decideHumanConfirmation's pending check): a permission request
  // resolves exactly once. Re-resolving — especially a deny->approve flip — would re-run the policy
  // cascade and mint an access grant for an already-terminalized cell. Return the settled request as-is.
  if (request.status !== "pending_approval") return {permissionRequest: request, accessGrant: null, alreadyResolved: true};
  const at = new Date().toISOString();
  // PermissionRequest FSM vocab: pending_approval -> approved / rejected. Accept a legacy "denied" from
  // callers and normalize it to the modeled "rejected".
  //
  // The status must be whitelisted, not merely normalized. Without this, any other string was written
  // through verbatim, and the result was silently wrong in both directions at once: the close barrier
  // only treats "pending_approval" as pending (PERMISSION_REQUEST_PENDING_STATUSES), so the request
  // stopped blocking the gate, while never being "approved" it also minted no grant — and the
  // resolve-once guard above then made it permanently unresolvable. A blocked cell would be waiting on
  // a permission that no longer blocks anything and can no longer be granted, with the close gate
  // reporting green. Fail loudly instead; an unrecognised outcome is a caller bug, not a decision.
  const rawStatus = args.status || (args.allowed === false ? "rejected" : "approved");
  const resolvedStatus = rawStatus === "denied" ? "rejected" : rawStatus;
  if (!["approved", "rejected"].includes(resolvedStatus)) {
    // 合法取值就在上一行，而拒绝里原先不带它：调用方（agent 或经 REST 转发过来的人）
    // 只知道"你给的不行"，不知道什么行 —— 只能穷举重试。同一族里角色那几处早就带了
    // registeredRoles，这一处是漏的。控制台的指引数组已经支持 allowedStatuses，服务端不发就显示不出来。
    return {ok: false, error: "permission_request_status_invalid",
      received: String(rawStatus).slice(0, 60), allowedStatuses: ["approved", "rejected"]};
  }
  request.status = resolvedStatus;
  const decision = policyDecisionEval(state, {
    action: request.permission,
    resource: request.resource,
    subjectRef: request.subjectRef || {subjectType: "account", subjectId: request.subjectId},
    allowed: request.status === "approved",
    reasonCode: request.status === "approved" ? "permission_request_approved" : "permission_request_denied",
    evidenceRefs: [`PermissionRequest:${request.requestId}`]
  }).policyDecision;
  request.policyDecisionRef = decision.decisionId;
  request.updatedAt = at;
  let accessGrant = null;
  let accessGrantDeclinedReason = null;
  if (request.status === "approved") {
    // 批准了却没铸出授权，此前是【静默的】：调用方只看到 accessGrant: null，不知道为什么。
    // 人点了"批准"，而实际什么都没发生 —— 必须把原因一起说出来。
    ({grant: accessGrant, declinedReason: accessGrantDeclinedReason} =
      ensurePermissionAccessGrant(state, request, args, decision, at));
    resumePermissionBlockedSession(state, request, at);
  } else {
    releasePermissionDeniedSession(state, request, at);
  }
  return {permissionRequest: request, accessGrant,
    ...(accessGrantDeclinedReason ? {accessGrantDeclinedReason} : {})};
}

// 授权资源归属哪个组织：项目直接取，任务组按它的项目反查。取不到就不做跨组织判断（宁可不拦，
// 也不能凭空拒绝一条合法授权）——取不到本身由别的判据管。
function organizationIdForGrantResource(state, resource) {
  if (!resource) return null;
  if (resource.resourceType === "project") {
    const project = (state.projects || []).find((item) => item.id === resource.resourceId);
    return project ? (project.organizationId || DEFAULT_ORGANIZATION_ID) : null;
  }
  if (resource.resourceType === "task_group") {
    const taskGroup = (state.taskGroups || []).find((item) => item.id === resource.resourceId);
    const project = taskGroup ? (state.projects || []).find((item) => item.id === taskGroup.projectId) : null;
    return project ? (project.organizationId || DEFAULT_ORGANIZATION_ID) : null;
  }
  return null;
}

function ensurePermissionAccessGrant(state, request, args, decision, at) {
  const subjectRef = request.subjectRef || {subjectType: "account", subjectId: request.subjectId};
  const permissions = [request.permission].filter(Boolean);
  // 防御纵深：提交侧已经拦下不可委派的权限与非任务组资源，但请求也可能来自 REST 或历史遗留记录，
  // 而这里是真正铸造 grant 的地方 —— 铸造点必须自己校验，不能依赖"上游应该已经挡过了"。
  // 只有控制面资源才铸 grant；external_capability 走的是能力边界那条路，不该在这里产生授权。
  if (!permissions.length) return {grant: null, declinedReason: "permission_missing"};
  if (!permissions.every((permission) => isDelegatableGrantPermission(permission))) {
    return {grant: null, declinedReason: "permission_not_delegable"};
  }
  if (!["task_group", "project"].includes(request.resource?.resourceType)) {
    return {grant: null, declinedReason: "resource_type_not_grantable"};
  }
  // 「不许跨组织授权」这条不变式此前【只有 REST 那扇门在守】（server.mjs 的 sanitizeGrantRequest）。
  // 同一件事两扇门、只有一扇挡住，等于没挡住：经 MCP 批准一条主体在甲组织、资源在乙组织的请求，
  // 就能铸出一条 REST 侧会拒绝的跨租户授权。铸造点自己校验 —— 这也正是本函数注释立的规矩。
  const subjectAccount = (state.accounts || []).find((item) => item.accountId === subjectRef.subjectId);
  // 主体是账号却查无此人时也要拒（REST 侧的 grant_subject_account_not_found）：
  // 否则会铸出一条指向不存在账号的授权，而跨组织那道判据也会因为查不到账号而整条失效。
  // 主体不是账号的（节点等）不适用这一条。
  if (subjectRef.subjectType === "account" && !subjectAccount) {
    return {grant: null, declinedReason: "grant_subject_account_not_found"};
  }
  const resourceOrgId = organizationIdForGrantResource(state, request.resource);
  if (subjectAccount && resourceOrgId
    && (subjectAccount.organizationId || DEFAULT_ORGANIZATION_ID) !== resourceOrgId) {
    return {grant: null, declinedReason: "cross_org_grant_not_allowed"};
  }
  const existing = state.accessGrants.find((grant) =>
    grant.status === "active" &&
    grant.subjectRef?.subjectType === subjectRef.subjectType &&
    grant.subjectRef?.subjectId === subjectRef.subjectId &&
    resourceMatches(grant.resource, request.resource) &&
    permissions.every((permission) => (grant.permissions || []).includes(permission) || (grant.permissions || []).includes("*"))
  );
  if (existing) return {grant: existing, declinedReason: null};
  const ttlSeconds = Math.max(60, Math.min(86400, Number(args.ttlSeconds || 3600)));
  const grant = {
    schemaVersion: "access-control-grant/v1",
    grantId: createId("grant"),
    subjectRef,
    resource: request.resource,
    role: args.role || (request.resource?.resourceType === "task_group" ? "agent_operator" : "viewer"),
    permissions,
    scopeDigest: digestOf({subjectRef, resource: request.resource, permissions}),
    status: "active",
    policyDecisionRef: decision.decisionId,
    expiresAt: args.expiresAt || new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    auditRef: `audit:permission:${request.requestId}`,
    createdAt: at,
    updatedAt: at
  };
  state.accessGrants.unshift(grant);
  return {grant, declinedReason: null};
}

function resumePermissionBlockedSession(state, request, at) {
  const session = request.sessionId ? state.workSessions.find((item) => item.sessionId === request.sessionId) : null;
  // Happy path: the runtime is still polling permission_status on a live dispatch. Clearing the session's
  // permission hold lets it resume in place; the running dispatch needs no action.
  if (session && session.status === "permission_required") {
    session.status = "active";
    session.permissionRequestRef = `PermissionRequest:${request.requestId}`;
    session.updatedAt = at;
    return;
  }
  // Timeout path: the runtime already gave up (/fail(blocked) moved the session to needs_decision and left
  // a blocked dispatch). Requeue that dispatch so it re-executes with the grant now in place — otherwise
  // the approval is a no-op and the blocked dispatch wedges the close barrier with no lever.
  if (session) session.permissionRequestRef = `PermissionRequest:${request.requestId}`;
  requeuePermissionApprovedDispatch(state, request, at);
}

// Symmetric with resumePermissionBlockedSession: on DENIAL the session must not be left in the
// non-terminal permission_required state (it would block completion readiness forever with no lever).
// Move it out and demote the owning work item to needs_decision so the operator's resolve_decision
// actuator can reopen or abandon it.
function releasePermissionDeniedSession(state, request, at) {
  const session = request.sessionId ? state.workSessions.find((item) => item.sessionId === request.sessionId) : null;
  // Also handle the timeout path: the session may already be needs_decision (post /fail(blocked)) with a
  // blocked, orphaned dispatch. Denial must terminalize that dispatch too, else it wedges the barrier.
  const timedOutDispatch = findPermissionBlockedDispatch(state, request);
  if ((!session || session.status !== "permission_required") && !timedOutDispatch) return;
  if (session) session.permissionRequestRef = `PermissionRequest:${request.requestId}`;
  const workItemId = request.workId || session?.workItemId || timedOutDispatch?.workItemId;
  const taskGroupId = request.taskGroupId || session?.taskGroupId || timedOutDispatch?.taskGroupId;
  // The denied permission means the current execution cannot proceed — terminalize the cell's runtime
  // residue (dispatch/session/lease/target/guard) so it does not wedge the close barrier, then demote the
  // work item to needs_decision so the operator can reopen (fresh attempt) or abandon it via
  // resolve_decision. (Session becomes failed via the cascade; a failed session is terminal + non-blocking.)
  terminateCellRuntime(state, taskGroupId, workItemId, "permission_request_denied");
  if (session && session.status === "permission_required") { // no dispatch cascade hit it (e.g. no live dispatch)
    session.status = "failed";
    session.blockedReason = "permission_request_denied";
    session.updatedAt = at;
  }
  const taskGroup = (state.taskGroups || []).find((group) => group.id === taskGroupId);
  const workItem = workItemId && taskGroup ? (taskGroup.workItems || []).find((item) => item.id === workItemId) : null;
  if (workItem && !["done", "verified", "closed", "aborted", "cancelled", "superseded"].includes(workItem.status)) {
    workItem.status = "needs_decision";
    workItem.blockedReason = "permission_request_denied";
    workItem.updatedAt = at;
  }
}

export function reviewResultConsume(state, args) {
  const finding = findingSubmit(state, {...args, findingType: args.findingType || "review", severity: args.severity || "info"});
  // Terminalize the referenced external review bundle (submitted -> consumed / rejected). Without this a
  // submitted bundle stays non-terminal forever and wedges the close-barrier no_pending_review_bundles gate.
  if (args.reviewBundleId) {
    // 作用域必须覆盖被改变的资源本身：按 id 全局查找意味着 A 任务组的调用方可以把 B 任务组的
    // 评审包终态化，直接替 B 清掉 no_pending_review_bundles 这道阻塞（confused deputy）。
    const scopedTaskGroupId = args.taskGroupId || "tg_runtime_management";
    const bundle = (state.reviewBundles || []).find((item) => item.reviewBundleId === args.reviewBundleId && item.taskGroupId === scopedTaskGroupId);
    if (bundle && !["consumed", "rejected"].includes(bundle.status)) {
      bundle.status = ["rejected", "changes_requested"].includes(args.verdict) || args.status === "rejected" ? "rejected" : "consumed";
      bundle.updatedAt = new Date().toISOString();
    }
  }
  // 评审结论回流 = 该角色的评审覆盖度已到位。不记这一笔，评审计划就永远停在未终结态，
  // 把任务组关闭门卡死（与上面终态化 reviewBundle 是同一个道理）。
  const reviewPlan = reviewPlanRecordCoverage(state, {
    reviewPlanId: args.reviewPlanId, taskGroupId: args.taskGroupId || "tg_runtime_management",
    reviewerRole: args.reviewerRole || args.role || "reviewer"
  });
  const readiness = computeCompletionReadiness(state, args.taskGroupId || "tg_runtime_management", args);
  return {finding: finding.finding, readiness, reviewPlan};
}

export function approvalResolve(state, args) {
  const request = (state.approvalRequests || []).find((item) => item.approvalId === args.approvalId);
  if (!request) return {ok: false, error: "approval_request_not_found"};
  // Terminal guard (mirrors permissionResolve / decideHumanConfirmation): a governance approval settles
  // exactly once. Without this, a fresh-idempotency-key re-call could flip a terminal rejected->approved
  // verdict and overwrite the audit fields (resolvedBy / decisionRecordRef). Return the settled request.
  if (["approved", "rejected", "expired", "cancelled"].includes(request.status)) return {approvalRequest: request, alreadyResolved: true};
  const at = new Date().toISOString();
  const resolver = args.resolvedBy || "policy-engine";
  // 既不给 status 也不给 allowed 时原先默认【批准】—— 治理审批上"没说"绝不能变成"批准"：
  // 这是高风险动作的闸门（法定人数、禁止自批都建立在它之上），而一次漏填参数就能放行。
  // 与 test_result_submit 的"缺省即通过"同形，同样按命令接口处理：拒绝并报出可选值。
  if (!["approved", "rejected", "cancelled"].includes(args.status) && args.allowed === undefined) {
    return {ok: false, error: "approval_decision_required",
      required: ["approved", "rejected", "cancelled"],
      message: "处理审批必须显式给出 status（approved/rejected/cancelled）或 allowed —— 缺省不会被当作批准"};
  }
  const decision = ["approved", "rejected", "cancelled"].includes(args.status)
    ? args.status
    : (args.allowed === false ? "rejected" : "approved");
  request.decisionRecordRef = args.decisionRecordRef || request.decisionRecordRef;
  request.updatedAt = at;
  if (decision === "cancelled") { request.status = "cancelled"; request.resolvedBy = resolver; return {approvalRequest: request}; }
  // A single rejection blocks immediately.
  if (decision === "rejected") { request.status = "rejected"; request.resolvedBy = resolver; return {approvalRequest: request}; }
  // high_risk_no_self_approval (spec/terminal-execution-manifest nonNegotiable): the proposer of a
  // high-risk action may never be one of its approvers. resolver is the authenticated actor (the routes
  // pass guard.actor / principal.id), not a client-supplied field.
  if (request.riskClass === "high" && request.proposedBy && resolver === request.proposedBy) {
    return {ok: false, error: "high_risk_no_self_approval"};
  }
  // 互审票可以由 AI 投，但**终审那一票必须是人**。累计不同主体的票；即使凑够法定人数，只要没有任何一票
  // 来自真人账号，就停在非终态 quorum_collecting（继续阻塞 close barrier），绝不自动变成 approved。
  request.approvals = [...new Set([...(request.approvals || []), resolver])];
  const quorum = Math.max(1, Number(request.quorum || 1));
  const hasHumanApprover = request.approvals.some((approver) => isHumanConfirmationActor(state, approver));
  if (request.approvals.length < quorum || !hasHumanApprover) {
    request.status = "quorum_collecting";
    return {
      approvalRequest: request,
      quorumRemaining: Math.max(0, quorum - request.approvals.length),
      ...(hasHumanApprover ? {} : {awaitingHumanApprover: true})
    };
  }
  request.status = "approved";
  request.resolvedBy = resolver;
  return {approvalRequest: request};
}

function roleDriftGuardBind(state, args) {
  const contract = args.sessionId
    ? state.agentTaskContracts.find((item) => item.sessionId === args.sessionId)
    : buildTaskContract(state, {...args, root: args.repositoryRoot || repositoryRoot});
  if (!contract) return {ok: false, error: "task_contract_not_found"};
  const drift = evaluateRoleDrift(state, {sessionId: contract.sessionId, taskGroupId: contract.taskGroupId, actionScopeRefs: args.actionScopeRefs || [`TaskGroup:${contract.taskGroupId}`]});
  return {contractRef: contract.commandId, drift};
}

function systemUpgradeCandidateExport(state, args) {
  const candidates = state.systemUpgradeCandidates.filter((candidate) => !args.taskGroupId || candidate.taskGroupId === args.taskGroupId);
  // Actually EXPORT: transition handed-off candidates to the modeled terminal status
  // exported_for_external_maintenance (schema/state-machine value) + set the required externalUpgradePackageRef.
  // Without this the runtime_issue_candidates_exported close-barrier gate (blocks on status==="candidate_created")
  // was structurally unsatisfiable — a candidate could be created (recurrence>=3) but never cleared, wedging
  // close with no lever. Export is the governance action that clears it.
  const at = new Date().toISOString();
  const exportId = createId("upgrade_export");
  for (const candidate of candidates) {
    if (candidate.status === "candidate_created") {
      candidate.status = "exported_for_external_maintenance";
      candidate.externalUpgradePackageRef = candidate.externalUpgradePackageRef || `upgrade-package:${exportId}`;
      candidate.updatedAt = at;
    }
  }
  return {
    exportId,
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
  state.externalUpgradeImports = state.externalUpgradeImports.slice(0, 2000);
  return {externalUpgradeImport: imported};
}

export function accountInvite(state, args) {
  const at = new Date().toISOString();
  // 这条通道创建的账号原先【完全不带 organizationId】，而三处跨组织边界闸门都写成
  // `X.organizationId && ...` —— undefined 时整条判定被跳过。结果这类账号可被任意组织的管理员
  // 拉进项目、授予 grant，且自身在 hasPermission 里不受任何组织约束；它也不计入任何组织的
  // 成员配额（那条统计唯一没有默认组织兜底）。归属必须在创建时就定下来，不能事后靠迁移补。
  assertUniqueRecordId(state.accounts, "accountId", args.accountId, "account_id_conflict");
  const accountId = args.accountId || createId("acct");
  const organizationId = String(args.organizationId || "").trim()
    || (state.organizations || []).find((item) => item.orgId === DEFAULT_ORGANIZATION_ID)?.orgId
    || DEFAULT_ORGANIZATION_ID;
  const accountToken = `aimac_account_${randomBytes(32).toString("base64url")}`;
  const account = {
    schemaVersion: "account/v1",
    accountId,
    accountType: "user_account",
    organizationId,
    displayName: args.displayName || args.email || "Project User",
    email: args.email || `${createId("user")}@local`,
    status: "invited",
    roles: args.roles || ["project_member"],
    permissions: [],
    authPolicy: {method: "invite_token", mfaRequired: false, passwordSet: false, sessionTtlSeconds: 3600},
    credentialDigest: digestOf(`account-invite:${accountId}:${accountToken}`),
    credentialIssuedAt: at,
    credentialExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
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
  return {
    account: publicAccountForMcp(account),
    accountToken,
    tokenExpiresAt: account.credentialExpiresAt,
    login: {email: account.email, tokenField: "accountToken"}
  };
}

function publicAccountForMcp(account) {
  const {credentialDigest: _credentialDigest, ...publicAccount} = account;
  return publicAccount;
}

function accountSuspend(state, args) {
  const account = state.accounts.find((item) => item.accountId === args.accountId);
  if (!account) return {ok: false, error: "account_not_found"};
  account.status = "suspended";
  account.updatedAt = new Date().toISOString();
  // 挂起必须同时撤销已签发的会话：只改 status 的话，锁定完全依赖每次请求现场检查，
  // 而"重新激活"会把挂起前的全部旧令牌一次性复活。
  revokeAccountSessions(state, account.accountId, "account_suspended");
  for (const grant of state.accessGrants.filter((item) => item.subjectRef?.subjectId === account.accountId && item.status === "active")) {
    grant.status = "revoked";
    grant.updatedAt = account.updatedAt;
  }
  return {account};
}

function grantCreate(state, args) {
  // 目前 identity-mcp.* 对机器主体是禁用的，所以不可达；但一旦放开，冒名的同 id 授权会让"撤销"
  // 打在冒名那份上而真授权存活。守住它比依赖"暂时不可达"可靠。
  assertUniqueRecordId(state.accessGrants, "grantId", args.grantId, "access_grant_id_conflict");
  const at = new Date().toISOString();
  const subjectRef = args.subjectRef || {subjectType: "account", subjectId: args.subjectId || args.accountId || "acct_agent_runtime"};
  const resource = args.resource || {resourceType: args.resourceType || "task_group", resourceId: args.resourceId || args.taskGroupId || "tg_runtime_management"};
  const permissions = args.permissions || ["task_group:read"];
  // Idempotency dedup (mirrors ensurePermissionAccessGrant): a fresh-idempotency-key retry must not mint a
  // duplicate active grant covering the same subject/resource/permissions.
  const existing = state.accessGrants.find((item) =>
    item.status === "active" &&
    item.subjectRef?.subjectType === subjectRef.subjectType &&
    item.subjectRef?.subjectId === subjectRef.subjectId &&
    resourceMatches(item.resource, resource) &&
    permissions.every((permission) => (item.permissions || []).includes(permission) || (item.permissions || []).includes("*")));
  if (existing) return {grant: existing, deduplicated: true};
  const grant = {
    schemaVersion: "access-control-grant/v1",
    grantId: args.grantId || createId("grant"),
    subjectRef,
    resource,
    role: args.role || "agent_operator",
    permissions,
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

function permissionMatrixGet(state, filter) {
  // The account/role/grant matrix is a cross-tenant system view. A bounded principal (a project-
  // scoped service token) must never read every tenant's accounts and grant edges through it — deny
  // unless the principal is unrestricted (system_admin / wildcard, filter === null).
  if (filter) {
    return {ok: false, error: "permission_matrix_requires_unrestricted_principal"};
  }
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

function progressGet(state, args, scopeType, filter) {
  computeProgressSnapshots(state);
  const scopeRef = scopeType === "project" ? args.projectId : args.taskGroupId;
  // A bounded principal must address an in-scope ref; without one, returning the first snapshot of
  // the scope type would disclose an arbitrary tenant's progress. Deny rather than guess.
  if (filter) {
    if (!scopeRef) return {progressSnapshot: null, error: "scope_ref_required_for_bounded_principal"};
    const projectId = scopeType === "project" ? scopeRef : state.taskGroups.find((item) => item.id === scopeRef)?.projectId;
    if (!projectId || !filter.has(projectId)) return {progressSnapshot: null, error: "out_of_scope"};
  }
  return {
    progressSnapshot: state.progressSnapshots.find((snapshot) => snapshot.scopeType === scopeType && (!scopeRef || snapshot.scopeRef === scopeRef)) || null
  };
}

function guardedActionDispatch(state, args) {
  const decision = policyDecisionEval(state, {action: args.action || "guarded_action", resource: args.resource || {}, allowed: args.allowed !== false}).policyDecision;
  if (decision.result !== "allowed") {
    return {
      commandResult: {
        commandId: createId("cmd_guarded"),
        action: args.action || "guarded_action",
        status: "denied",
        policyDecisionRef: decision.decisionId
      }
    };
  }
  // Gap #3: an allowed guarded action runs the real Command bus lifecycle to a terminal command.
  const taskGroupId = args.taskGroupId || args.resource?.taskGroupId;
  const {command} = runCommandLifecycle(state, {
    type: args.action || "guarded_action",
    subject: taskGroupId ? `TaskGroup:${taskGroupId}` : (args.resource?.resourceId ? String(args.resource.resourceId) : "control-plane"),
    ...(taskGroupId ? {taskGroupId} : {}),
    policyDecisionRef: decision.decisionId,
    resultRef: `guarded_action:${decision.decisionId}`
  });
  return {
    commandResult: {
      commandId: command.id,
      action: args.action || "guarded_action",
      status: "accepted",
      policyDecisionRef: decision.decisionId
    }
  };
}

export function sharedDefinitionPublish(state, args) {
  // publish 只能把【已存在的】契约推到生效。原先 `|| sharedDefinitionCreate(...)` 让一个未知 contractId
  // 在同一次调用里被铸造并直接激活，绕过 create 的 draft 默认值和任何评审证据要求 —— 等于 AI 自行
  // 宣布"什么是本项目的规范"并自我批准，而它会流进每个派发 agent 的任务契约与指令包。
  const definition = state.sharedDefinitions.find((item) => item.contractId === args.contractId);
  if (!definition) return {ok: false, error: "shared_definition_not_found"};
  // 生效的共享定义会被分发进每个 agent 的任务契约和指令包 —— 它就是"本项目认什么规范"。
  // 因此 publish 只能【提案】，不能自我激活：create(draft) + publish(active) 两步都在
  // CONTROL_ROLE_MCP_TOOLS 里，AI 原本可以一口气自行宣布并自我批准一条全局规范，
  // 这正是"核心方案不得由 AI 自动确认"要挡住的事。
  // proposed 属于 SHARED_DEFINITION_BLOCKING_STATUSES，会挡住关闭门，并由真人专属的
  // shared_definition_resolve 杠杆决定是否 active —— 阻塞有出口，不构成死锁。
  if (definition.status === "active") return {sharedDefinition: definition};
  definition.status = "proposed";
  definition.proposedBy = args.actor || args.requestedBy || "agent";
  definition.updatedAt = new Date().toISOString();
  return {sharedDefinition: definition, requiresHumanActivation: true};
}

function sharedDefinitionConsumerBind(state, args) {
  const definition = state.sharedDefinitions.find((item) => item.contractId === args.contractId);
  if (!definition) return {ok: false, error: "shared_definition_not_found"};
  definition.consumerRefs = [...new Set([...(definition.consumerRefs || []), ...(args.consumerRefs || [args.consumerRef || `TaskGroup:${args.taskGroupId || "tg_runtime_management"}`])])];
  definition.updatedAt = new Date().toISOString();
  return {sharedDefinition: definition};
}

function sharedDefinitionConflictReport(state, args) {
  // 上报冲突原先只产出一条 Finding，契约本身状态不变 —— 于是 conflicted 这个"阻塞状态"
  // 没有任何写入方，检查它的关闭门在生产上永远不会触发。冲突必须真的把契约打成 conflicted，
  // 由真人专属的 shared_definition_resolve 决定怎么收（active/superseded/retired/rejected）。
  const definition = (state.sharedDefinitions || []).find((item) => item.contractId === args.contractId);
  if (definition && !["superseded", "retired", "rejected"].includes(definition.status)) {
    definition.status = "conflicted";
    definition.updatedAt = new Date().toISOString();
  }
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
  const taskGroup = taskGroupForRecord(state, args);
  const languagePolicy = normalizeTaskGroupLanguagePolicy(taskGroup?.languagePolicy || args.languagePolicy || args);
  const languagePolicyDigest = digestOf(languagePolicy);
  const tokenBudget = args.tokenBudget || {};
  const envelope = {
    schemaVersion: "instruction-envelope/v1",
    envelopeId: args.envelopeId || createId("ienv"),
    status: args.status && ["drafted", "compacted", "cache_indexed", "dispatched", "acknowledged", "invalidated"].includes(args.status) ? args.status : "drafted",
    taskGroupId: taskGroup?.id || args.taskGroupId || "tg_runtime_management",
    recipientRole: args.recipientRole || args.roleId || "agent-runtime",
    effectiveInstructionPacketRef: args.effectiveInstructionPacketRef || args.packetRef || "eip:runtime",
    formatVersion: "ai-native-instruction-envelope/v1",
    stablePrefixDigest: digestOf(args.stablePrefix || "ai-native-control-plane"),
    digestRefs: [...new Set([...(args.digestRefs || []), `language-policy:${languagePolicyDigest}`])],
    languagePolicy,
    languagePolicyDigest,
    sharedDefinitionRefs: args.sharedDefinitionRefs || [],
    cacheKey: digestOf({role: args.recipientRole || args.roleId, taskGroupId: taskGroup?.id || args.taskGroupId, sourceKind, languagePolicyDigest}),
    tokenBudget: {
      maxInputTokens: Number(tokenBudget.maxInputTokens || 4096),
      targetDeltaTokens: Number(tokenBudget.targetDeltaTokens || tokenBudget.deltaMessageTargetTokens || 420),
      maxOutputTokens: Number(tokenBudget.maxOutputTokens || 1200)
    },
    outputContractRef: args.outputContractRef || "spec/checkpoint.schema.json",
    createdAt: at,
    updatedAt: at
  };
  state.instructionMetrics.envelopes.unshift(envelope);
  state.instructionMetrics.envelopes = state.instructionMetrics.envelopes.slice(0, 2000);
  return {instructionEnvelope: envelope};
}

function cacheKeyIndex(state, args, filter) {
  const projectOf = (taskGroupId) => (state.taskGroups.find((item) => item.id === taskGroupId) || {}).projectId;
  return {
    cacheKeys: state.instructionMetrics.envelopes
      .filter((item) => (!args.taskGroupId || item.taskGroupId === args.taskGroupId) && (!filter || filter.has(projectOf(item.taskGroupId))))
      .map((item) => ({envelopeId: item.envelopeId, cacheKey: item.cacheKey, stablePrefixDigest: item.stablePrefixDigest}))
  };
}

function stablePrefixGet(state, args, filter) {
  // Scope by the envelope's task-group project so a bounded principal cannot read another tenant's
  // instruction-envelope digest by guessing an envelopeId (which is not a scope-addressing arg).
  const inScope = (envelope) => {
    if (!filter) return true;
    const project = (state.taskGroups || []).find((item) => item.id === envelope.taskGroupId)?.projectId;
    return Boolean(project && filter.has(project));
  };
  const envelope = (state.instructionMetrics.envelopes || []).find((item) => item.envelopeId === args.envelopeId && inScope(item))
    || (state.instructionMetrics.envelopes || []).find((item) => (!args.taskGroupId || item.taskGroupId === args.taskGroupId) && inScope(item));
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

export function repositoryOutputTargetSelect(state, args) {
  const taskGroup = findTaskGroup(state, args.taskGroupId);
  const workItem = findWorkItem(state, taskGroup?.id, args.workItemId);
  const at = new Date().toISOString();
  const pathAllowlist = args.pathAllowlist || ["docs/**", "apps/**", "scripts/**", "spec/**", "data/**", "package.json", "Dockerfile", "docker-compose.yml", "README.md"];
  const artifactManifestPath = args.artifactManifestPath || `docs/artifact-manifests/${args.workItemId || workItem?.id || "work"}.json`;
  // 同上：配置不合法与路径给错了是两回事，都要说出真实取值（否则 agent 无从自纠）。
  if (!pathAllowlistValid(pathAllowlist)) {
    return {ok: false, error: "repository_output_target_must_use_git_trackable_paths",
      cause: "path_allowlist_invalid", allowedPaths: pathAllowlist};
  }
  if (!canUseGitPath(artifactManifestPath)) {
    return {ok: false, error: "repository_output_target_must_use_git_trackable_paths",
      cause: "manifest_path_not_git_trackable", path: artifactManifestPath};
  }
  if (!pathMatchesAllowlist(artifactManifestPath, pathAllowlist)) {
    return {ok: false, error: "artifact_manifest_outside_allowlist",
      path: artifactManifestPath, allowedPaths: pathAllowlist};
  }
  if (args.repositoryUrl && !isSafeGitRemoteUrl(args.repositoryUrl)) {
    return {ok: false, error: "repository_output_target_unsafe_repository_url"};
  }
  // 这个对象【就是写入边界】。要守住它，必须守住真正被用来选中它的那个查找条件 ——
  // control-plane-core 是按 (taskGroupId, workItemId, 非 superseded) 复合条件找的，不是按 targetId。
  // 只守 targetId 唯一性没有用：AI 换个新 id 就能再造一份宽 allowlist 的，unshift 让它排在最前，
  // 于是独立互审拿它去判 changed_paths_outside_allowlist，改了 apps/** 的提交也判"通过"，
  // 而人看到的验收卡片仍写着"只改文档"。（第四、五轮各复现一次；第四轮我守错了字段。）
  assertUniqueRecordId(state.repositoryOutputs, "targetId", args.targetId, "repository_output_target_id_conflict");
  const activeExisting = (state.repositoryOutputs || []).find((item) =>
    item.taskGroupId === (args.taskGroupId || taskGroup?.id || "tg_runtime_management") &&
    item.workItemId === (args.workItemId || workItem?.id || "work_unknown") &&
    item.status !== "superseded");
  // 一个工作项同时只能有一份生效的写入边界：已有就原样返回（幂等），要换边界必须先显式 supersede。
  if (activeExisting) return {repositoryOutputTarget: activeExisting, deduplicated: true};
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
  // push，与 core/REST 两个写入方一致：避免"后插入者排在 find 最前"这一类顶替。
  state.repositoryOutputs.push(target);
  return {repositoryOutputTarget: target};
}

function repositoryTargetLeaseBind(state, args) {
  return claimLease(state, args);
}

function artifactManifestIndex(state, args, filter) {
  const inScope = (projectId) => !filter || filter.has(projectId);
  const manifests = [
    ...state.artifacts.filter((artifact) => inScope(artifact.projectId)).map((artifact) => artifact.artifactManifestRef).filter(Boolean),
    ...state.repositoryOutputs.filter((target) => inScope(target.projectId)).map((target) => target.artifactManifestPath).filter(Boolean),
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

export async function handleMcpJsonRpc(message, context = {}) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return {jsonrpc: "2.0", id: null, error: {code: -32600, message: "Invalid Request"}};
  if (message.method === "notifications/initialized") return null;
  if (message.method === "initialize") {
    const supportedProtocolVersions = ["2025-06-18", "2025-03-26", "2024-11-05"];
    const requestedProtocolVersion = String(message.params?.protocolVersion || "");
    return {jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: supportedProtocolVersions.includes(requestedProtocolVersion) ? requestedProtocolVersion : "2025-06-18",
      capabilities: {tools: {listChanged: false}},
      serverInfo: {name: "ai-multi-agent-ctrl", version: "0.2.0"},
      instructions: "This is the centralized remote MCP control plane. Agent hosts must not start a local MCP server."
    }};
  }
  if (message.method === "tools/list") {
    const tools = createVisibleMcpToolDefinitions(context);
    return {jsonrpc: "2.0", id: message.id, result: {
      resultType: "complete",
      tools,
      ttlMs: 300000,
      cacheScope: "principal"
    }};
  }
  if (message.method === "tools/call") {
    try {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      const payload = await callTool(name, args, context);
      return {jsonrpc: "2.0", id: message.id, result: toolResult(payload, payload.ok === false)};
    } catch (error) {
      if (error.code) {
        return {jsonrpc: "2.0", id: message.id, error: {code: error.code, message: error.message}};
      }
      // details 原先在这里被整个丢掉：报文只剩一个错误码。而读它的多半是 agent，
      // 它要靠"合法取值有哪些"自己改请求重发 —— 特意写好的 supported/registeredRoles
      // 一路都没送出去（work_item_status_unknown 那条从加上到现在一直如此）。
      return {jsonrpc: "2.0", id: message.id, result: toolResult({ok: false,
        tool: message.params?.name || "unknown", error: error.message,
        ...(error.details ? {details: error.details} : {})}, true)};
    }
  }
  if (message.id !== undefined) return {jsonrpc: "2.0", id: message.id, error: {code: -32601, message: `Method not found: ${message.method}`}};
  return null;
}

function createVisibleMcpToolDefinitions(context = {}) {
  const allowedTools = context.allowedMcpTools || context.principal?.allowedMcpTools || [];
  if (allowedTools.includes("*")) return createMcpToolDefinitions();
  let names = new Set(allowedTools);
  if (context.principal?.kind === "agent_node") {
    const state = loadState();
    const active = new Set((state.mcpGrants || [])
      .filter((grant) => grant.grantStatus === "issued" && grant.agentNodeId === context.principal.id && (!grant.expiresAt || new Date(grant.expiresAt).getTime() > Date.now()))
      .map((grant) => grant.toolName));
    names = new Set([...names].filter((name) => active.has(name)));
  }
  return createMcpToolDefinitions().filter((tool) => names.has(tool.name));
}

async function handleMessage(message) {
  const response = await handleMcpJsonRpc(message, {
    principal: {kind: "system_service", id: "internal-stdio", allowedMcpTools: ["*"]},
    allowedMcpTools: ["*"]
  });
  if (!response) return;
  if (response.error) respondError(response.id, response.error.code, response.error.message, response.error.data);
  else respond(response.id, response.result);
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
  if (process.env.AIMAC_MCP_INTERNAL_STDIO !== "true") {
    process.stderr.write("Local MCP stdio startup is disabled. Start the control-plane service and connect to its /mcp endpoint.\n");
    process.exit(2);
  }
  startStdioServer();
}
