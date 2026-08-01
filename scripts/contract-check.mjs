#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isStateStoreConflict, readStoredState, writeStoredState } from "../apps/control-plane-ui/lib/state-store.mjs";
import { createMcpGrant, createMcpToolDefinitions, mcpToolNames, permissionResolve, approvalResolve, reviewResultConsume } from "../apps/mcp-server/server.mjs";
import {
  acquireWorkerLane,
  maintainWorkerLanes,
  rotateWorkerLane,
  buildTaskContract,
  computeCloseBarrier,
  computeProgressSnapshots,
  createHumanConfirmationRequest,
  decideHumanConfirmation,
  submitAiConfirmationAnalysis,
  assertHumanFinalization,
  performIndependentReview,
  gitHead,
  createHumanDirective,
  consumeQueuedHumanDirectives,
  defaultSystemRules,
  effectiveTaskGroupConfig,
  ensureRuntimeCollections,
  organizationQuotaCheck,
  runAutonomousCycle,
  recomputeTaskGroup,
  cellAdmissionPriority,
  conditionWindowGate,
  admissibleCellClass,
  capTaskContracts,
  terminateCellRuntime,
  findPermissionBlockedDispatch,
  requeuePermissionApprovedDispatch,
  findingResolve,
  reviewBundleRegister,
  computeCompletionReadiness,
  createExecutionTopology,
  advanceExecutionTopology,
  decideSessionPlacement,
  roomSend,
  selectModel,
  updateTaskGroupLanguagePolicy,
  createCommand,
  dispatchCommand,
  markRunning,
  succeedCommand,
  failCommand,
  retryCommand,
  toDlq,
  recordCommandEffect,
  applyCommandEffect,
  verifyingCommandEffect,
  verifyCommandEffect,
  classifyDlqEntry,
  assignDlqEntry,
  replayDlqEntry,
  sweepCommandBus
} from "../apps/control-plane-ui/lib/control-plane-core.mjs";
import {
  ackAgentControlCommand,
  authenticateAgentNode,
  claimNextDispatch,
  createAgentControlCommand,
  createAgentJoinToken,
  getSkillWorkset,
  heartbeatAgentNode,
  listAgentControlCommands,
  registerAgentNode,
  requestAgentNodeRevocation,
  selfCheckAgentNode,
  submitAgentExecutionEvent
} from "../apps/control-plane-ui/lib/agent-gateway.mjs";
import { appendProjectExecutionEvent, readProjectExecutionEventByKey, readProjectExecutionEvents } from "../apps/control-plane-ui/lib/project-event-store.mjs";
import { assertTransition, resolveGate, loadStateMachines, loadGateCatalog } from "../apps/control-plane-ui/lib/transition-engine.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const seedState = loadJson("data/seed-state.json");
const runtimeSchema = loadJson("spec/runtime-bootstrap.schema.json");
const mcpGrantSchema = loadJson("spec/mcp-grant.schema.json");
const joinTokenSchema = loadJson("spec/agent-join-token.schema.json");
const agentDispatchSchema = loadJson("spec/agent-dispatch.schema.json");
const agentControlCommandSchema = loadJson("spec/agent-control-command.schema.json");
const agentExecutionEventSchema = loadJson("spec/agent-execution-event.schema.json");
const runtimeNodeSchema = loadJson("spec/agent-runtime-node.schema.json");
const skillWorksetSchema = loadJson("spec/agent-skill-workset.schema.json");
const agentTaskContractSchema = loadJson("spec/agent-task-contract.schema.json");
const effectiveInstructionPacketSchema = loadJson("spec/effective-instruction-packet.schema.json");
const workerLaneSchema = loadJson("spec/worker-lane.schema.json");
const sessionPlacementDecisionSchema = loadJson("spec/session-placement-decision.schema.json");
const closeBarrierSchema = loadJson("spec/close-barrier.schema.json");
const languagePolicySchema = loadJson("spec/language-policy.schema.json");
const humanConfirmationSchema = loadJson("spec/human-confirmation-request.schema.json");
const humanDirectiveSchema = loadJson("spec/human-directive.schema.json");
const organizationSchema = loadJson("spec/organization.schema.json");
const errors = [];

validateSchema(seedState.runtime, runtimeSchema, "seed.runtime", errors);
verifyAgentGatewayContracts(errors);
verifyHumanAndOrganizationContracts(errors);

for (const toolName of ["ui-console-mcp.runtime_health_get", "room-mcp.room_send", "agent-control-mcp.dispatch_status"]) {
  validateSchema(createMcpGrant(toolName, {tokenDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}), mcpGrantSchema, `McpGrant:${toolName}`, errors);
}

const toolNamePattern = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u;
const toolDefs = createMcpToolDefinitions();
const toolDefNames = new Set(toolDefs.map((tool) => tool.name));
for (const toolName of mcpToolNames) {
  if (!toolDefNames.has(toolName)) errors.push(`MCP tool definition missing ${toolName}`);
}
for (const tool of toolDefs) {
  if (!toolNamePattern.test(tool.name)) errors.push(`MCP tool name invalid: ${tool.name}`);
  if (tool.inputSchema?.type !== "object") errors.push(`MCP tool ${tool.name} inputSchema must be object`);
  if (tool.inputSchema?.additionalProperties !== false) errors.push(`MCP tool ${tool.name} inputSchema must be closed`);
  for (const requiredKey of tool.inputSchema?.required || []) {
    if (!tool.inputSchema.properties?.[requiredKey]) errors.push(`MCP tool ${tool.name} required key ${requiredKey} missing from properties`);
  }
  if (tool.outputSchema?.type !== "object") errors.push(`MCP tool ${tool.name} outputSchema must be object`);
}

verifyRuntimeJsonConflict(errors);
verifyWorkStatusEnumConvergence(errors);
verifyTransitionEngine(errors);
verifyCommandBusLifecycle(errors);

if (errors.length) {
  console.error("contract check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

function verifyHumanAndOrganizationContracts(output) {
  const state = structuredClone(seedState);
  ensureRuntimeCollections(state, {root});

  // Default organization exists and backfills membership/usage.
  const defaultOrg = (state.organizations || []).find((org) => org.orgId === "org_default");
  if (!defaultOrg) output.push("Default organization was not created during migration");
  else validateSchema(defaultOrg, organizationSchema, "Organization:default", output);
  if (!(state.accounts || []).every((account) => ["system_admin", "service_account"].includes(account.accountType) ? true : account.organizationId)) {
    output.push("Organization migration left an org-scoped account without organizationId");
  }

  // Quota enforcement returns quota + usage detail.
  if (defaultOrg) {
    defaultOrg.quotas.maxProjects = defaultOrg.usage.projects;
    const denied = organizationQuotaCheck(state, "org_default", "projects");
    if (denied.allowed || denied.error !== "org_quota_exceeded" || typeof denied.quota !== "number" || typeof denied.usage !== "number") {
      output.push("organizationQuotaCheck did not report org_quota_exceeded with quota/usage detail");
    }
    defaultOrg.quotas.maxProjects = 100;
  }

  // Task-group config inheritance and reset.
  const taskGroup = state.taskGroups?.[0];
  const project = state.projects.find((item) => item.id === taskGroup?.projectId);
  if (taskGroup && project) {
    project.config = {...(project.config || {}), businessRules: [{ruleId: "br_ct", title: "验收", content: "必须测试"}]};
    const inherited = effectiveTaskGroupConfig(state, taskGroup);
    if (inherited.configSource !== "inherited" || inherited.businessRules.length !== 1) output.push("Task group config did not inherit project business rules");
    // 空覆盖视为继承（不应误标已自定义、也不应冻结继承值）
    taskGroup.configOverrides = {businessRules: []};
    if (effectiveTaskGroupConfig(state, taskGroup).configSource !== "inherited") output.push("Empty task group config override should stay inherited, not customized");
    // 仅在存在非空覆盖内容时才切换为已自定义
    taskGroup.configOverrides = {businessRules: [{ruleId: "br_tg", title: "任务组验收", content: "任务组级补充"}]};
    if (effectiveTaskGroupConfig(state, taskGroup).configSource !== "customized") output.push("Task group config override did not switch configSource to customized");
    delete taskGroup.configOverrides;
    const reset = effectiveTaskGroupConfig(state, taskGroup);
    if (reset.configSource !== "inherited" || reset.businessRules.length !== 1) output.push("Task group config reset did not restore inherited project config");

    // Three-category rule model: default system rules inherit and can be disabled/overridden per level.
    const defaults = defaultSystemRules();
    if (!defaults.length) output.push("defaultSystemRules must be non-empty");
    const baseResolved = effectiveTaskGroupConfig(state, taskGroup);
    if (baseResolved.activeSystemRules.length !== defaults.length) output.push("Task group did not inherit all default system rules");
    if (baseResolved.systemRules.some((rule) => !rule.contentDigest)) output.push("Resolved system rule missing contentDigest");
    const sampleRuleId = defaults[0].ruleId;
    project.config = {...(project.config || {}), systemRules: [{ruleId: sampleRuleId, enabled: false}]};
    const afterDisable = effectiveTaskGroupConfig(state, taskGroup);
    if (afterDisable.activeSystemRules.some((rule) => rule.ruleId === sampleRuleId)) output.push("Project could not disable a default system rule");
    taskGroup.configOverrides = {systemRules: [{ruleId: sampleRuleId, enabled: true, content: "override"}]};
    const afterReenable = effectiveTaskGroupConfig(state, taskGroup);
    const reenabled = afterReenable.systemRules.find((rule) => rule.ruleId === sampleRuleId);
    if (!reenabled?.enabled || reenabled.content !== "override" || !String(reenabled.source).includes("task_group")) {
      output.push("Task group could not re-enable/override a system rule with source tracking");
    }
    delete taskGroup.configOverrides;
    delete project.config.systemRules;
  }

  // Reusable worker lane model: a lane belongs to a role, a role can own multiple lanes, and an idle lane
  // is reused (reuse generation bumps) rather than spawning a new one; retired lanes are never reused.
  {
    const laneState = {};
    const laneA = acquireWorkerLane(laneState, {roleId: "reviewer", sessionId: "sess_a"});
    validateSchema(laneA.lane, workerLaneSchema, "WorkerLane", output);
    const laneB = acquireWorkerLane(laneState, {roleId: "reviewer", sessionId: "sess_b"});
    if (laneA.lane.roleId !== "reviewer" || laneB.lane.roleId !== "reviewer") output.push("worker lane must belong to the requested role");
    if (laneA.lane.laneId === laneB.lane.laneId || laneState.workerLanes.filter((lane) => lane.roleId === "reviewer").length !== 2) {
      output.push("a role must be able to own multiple concurrent worker lanes");
    }
    laneState.workSessions = [{sessionId: "sess_a", status: "completed_objective"}, {sessionId: "sess_b", status: "active"}];
    maintainWorkerLanes(laneState);
    if (laneState.workerLanes.find((lane) => lane.laneId === laneA.lane.laneId)?.status !== "idle") output.push("worker lane not released after its session terminated");
    const laneReuse = acquireWorkerLane(laneState, {roleId: "reviewer", sessionId: "sess_c"});
    if (laneReuse.mode !== "reuse_lane" || laneReuse.lane.laneId !== laneA.lane.laneId || laneReuse.lane.reuseGeneration !== 1) {
      output.push("idle worker lane was not reused with a bumped reuse generation");
    }
    rotateWorkerLane(laneState, laneReuse.lane.laneId, "accepted_p0");
    const laneAfterRotate = acquireWorkerLane(laneState, {roleId: "reviewer", sessionId: "sess_d"});
    if (laneAfterRotate.lane.laneId === laneReuse.lane.laneId) output.push("retired worker lane must not be reused");
    const placement = { workerCarrierDecision: { mode: "subagent" } };
    if (placement.workerCarrierDecision.laneId) output.push("subagent placement must not hold a worker lane");
  }

  // Human directive consumption applies to task group and is auditable.
  if (taskGroup) {
    createHumanDirective(state, {taskGroupId: taskGroup.id, directiveType: "add_requirement", instruction: "输出必须包含中文摘要"}, {actor: "acct_ct"});
    const applied = consumeQueuedHumanDirectives(state);
    if (!applied.some((item) => item.status === "applied")) output.push("Human directive was not applied by the orchestrator cycle");
    const directive = state.humanDirectives?.[0];
    if (directive) validateSchema(directive, humanDirectiveSchema, "HumanDirective", output);
  }

  // Human confirmation forces a none option, requires input for none, and dedups pending.
  const cycle = runAutonomousCycle(state, {root, mode: "all"});

  // §4.5 admission ledger (gap #11): every scheduling verdict persists a machine-readable
  // admissionDecision whose orthogonal status flags are mutually exclusive (exactly one true).
  if (!Array.isArray(state.admissionDecisions) || !state.admissionDecisions.length) {
    output.push("runAutonomousCycle did not record any admissionDecision");
  } else {
    const orthogonalKeys = ["selected", "deferred", "blocked", "resourceQueued", "awaitingReview", "awaitingCheckpoint", "superseded", "skippedTerminal"];
    for (const decision of state.admissionDecisions) {
      const trueFlags = orthogonalKeys.filter((key) => decision[key] === true);
      if (trueFlags.length !== 1) output.push(`admissionDecision ${decision.decisionId} orthogonal status flags are not mutually exclusive (got ${trueFlags.join(",") || "none"})`);
      if (!decision.workItemId || !decision.outcome || !decision.candidateRef) output.push("admissionDecision missing candidate/outcome fields");
    }
    if (!state.admissionDecisions.some((decision) => decision.selected)) output.push("admissionDecision ledger recorded no selected dispatch");
    // A2/A5: every admission decision carries a cell class and orthogonal dimensions.
    for (const decision of state.admissionDecisions) {
      if (!decision.cellClass) output.push("admissionDecision missing cellClass (A2)");
      if (!decision.dimensions || !decision.dimensions.evidenceQualificationDimension) output.push("admissionDecision missing orthogonal dimensions (A5)");
    }
  }
  // A8: a cycle-level admission scan holds the candidate set + per-cell classification.
  if (!Array.isArray(state.admissionScans) || !state.admissionScans.length) {
    output.push("runAutonomousCycle did not record an admissionScan (A8)");
  } else {
    const scan = state.admissionScans[0];
    if (!Array.isArray(scan.candidateCells) || !scan.cellClasses || typeof scan.cellClasses !== "object") output.push("admissionScan missing candidateCells/cellClasses (A8)");
  }

  // A1: explicit next-cell priority ordering (lower tier index = admitted first).
  if (!(cellAdmissionPriority({admissionPriorityClass: "p0_safety"}) < cellAdmissionPriority({admissionPriorityClass: "formal_gate"}))) output.push("cell admission priority ordering is wrong (A1)");
  if (cellAdmissionPriority({priorityHint: "P0 urgent"}) !== 0) output.push("priorityHint P0 did not map to the top tier (A1)");

  // A3/A4: condition-window gate defers only cells whose declared window is unmet, per environment.
  const gatedCell = conditionWindowGate({conditionDependency: {environment: "envA", requiredWindowState: "open", conditionSource: "src"}}, {windowStateByEnvironment: {envA: "closed"}});
  if (!gatedCell || gatedCell.currentWindowState !== "closed" || !gatedCell.wakeTrigger) output.push("condition-window gate did not defer a closed-window cell with a wakeTrigger (A3)");
  if (conditionWindowGate({conditionDependency: {environment: "envA", requiredWindowState: "open"}}, {windowStateByEnvironment: {envA: "open"}}) !== null) output.push("condition-window gate deferred a satisfied-window cell (A3)");
  if (conditionWindowGate({}, {windowStateByEnvironment: {envA: "closed"}}) !== null) output.push("condition-window gate gated a condition-independent cell (A3/A4)");
  // A2/A5: a window-deferred cell must be classified pending_window (not conflated into
  // defer_downstream) — the reason code and the dependency both drive the class.
  const gatedWorkItem = {conditionDependency: {environment: "envA", requiredWindowState: "open"}};
  if (admissibleCellClass("deferred", gatedCell.reasonCode, gatedWorkItem) !== "pending_window") output.push("window-deferred cell was misclassified (not pending_window) (A2/A3)");
  if (admissibleCellClass("deferred", "awaiting_downstream_output", {}) !== "defer_downstream") output.push("non-window deferral misclassified as pending_window (A2)");
  if (admissibleCellClass("selected", "dispatched", {}) !== "ready_now") output.push("selected cell not classified ready_now (A2)");

  // A7: carrier decision records the 4-way carrier + nonSelectedCarriers + nonReuseReason, and the
  // produced instance must validate against session-placement-decision.schema.json (no spec drift).
  const carrierPlacement = decideSessionPlacement(state, {taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", workSignals: ["expected_multi_turn", "role_owner_required"]});
  const carrierDecision = carrierPlacement.workerCarrierDecision;
  if (!carrierDecision.carrier || !Array.isArray(carrierDecision.nonSelectedCarriers) || carrierDecision.nonSelectedCarriers.length !== 3 || !carrierDecision.nonReuseReason || !carrierDecision.retireOrArchiveCondition) {
    output.push("carrier decision missing 4-way carrier / nonSelectedCarriers / nonReuseReason (A7)");
  }
  validateSchema(carrierPlacement, sessionPlacementDecisionSchema, "SessionPlacementDecision", output);
  const subagentPlacement = decideSessionPlacement(state, {taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", workSignals: ["single_turn", "read_only_scan"]});
  validateSchema(subagentPlacement, sessionPlacementDecisionSchema, "SessionPlacementDecision(subagent)", output);

  // Efficacy guard for the completed validator: the whole point of C1 is that a REGRESSED producer must
  // be caught. decideSessionPlacement emits new_session for the seed work item, so we exercise the
  // subagent conditional branch with a hand-built canonical instance: assert the VALID one passes, then
  // prove each corruption is rejected — so these conditional gates can never silently go vacuous again.
  const rejectsSchema = (instance) => { const errs = []; validateSchema(instance, sessionPlacementDecisionSchema, "neg", errs, sessionPlacementDecisionSchema); return errs.length > 0; };
  const validSubagent = {
    schemaVersion: "session-placement-decision/v1", decisionId: "spd_probe", projectId: "prj_control_plane",
    taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", status: "subagent_selected", placement: "subagent",
    workSignals: ["single_turn", "read_only_scan"], capacitySnapshotRef: "cap_x", modelSelectionDecisionRef: "msd_x",
    taskContractRef: "tc_x", rationaleRefs: ["rationale_x"], auditRef: "audit_x", createdAt: "2026-07-28T00:00:00Z",
    subagentSafetyProof: {singleTurn: true, noPersistentState: true, noGlobalTaskOwnership: true, boundedRepositoryLeaseOnly: true, noExternalCapabilityFlow: true, subagentCapacityAvailable: true}
  };
  if (rejectsSchema(validSubagent)) output.push("efficacy-probe: the canonical valid subagent placement was wrongly rejected (probe instance is wrong)");
  const noProof = structuredClone(validSubagent); delete noProof.subagentSafetyProof;
  if (!rejectsSchema(noProof)) output.push("VACUOUS: validator accepted a subagent placement with no subagentSafetyProof (allOf/if/then not enforced)");
  const unboundedProof = structuredClone(validSubagent); unboundedProof.subagentSafetyProof.boundedRepositoryLeaseOnly = false;
  if (!rejectsSchema(unboundedProof)) output.push("VACUOUS: validator accepted boundedRepositoryLeaseOnly=false (const in then not enforced)");
  const sustainedSubagent = structuredClone(validSubagent); sustainedSubagent.workSignals = ["single_turn", "long_running"];
  if (!rejectsSchema(sustainedSubagent)) output.push("VACUOUS: validator accepted a subagent placement carrying a sustained work signal (not/contains not enforced)");
  const wrongStatus = structuredClone(validSubagent); wrongStatus.placement = "new_session";
  if (!rejectsSchema(wrongStatus)) output.push("VACUOUS: validator accepted new_session placement with subagent_selected status (if/then status const not enforced)");

  // --- 2026-07-26 multi-dimension review fixes: behavioral tests ---
  {
    // buildTaskContract idempotency: a second build for an already-dispatched cell returns the
    // existing contract (same runId) and mints no orphan session/lane.
    const idemState = structuredClone(seedState);
    ensureRuntimeCollections(idemState, {root});
    runAutonomousCycle(idemState, {root, mode: "all", autoSyncSkills: false});
    // A produced RepositoryOutputTarget must conform to its schema (locks the pathDenylist field name and
    // catches producer drift now that the schema validator enforces conditional clauses).
    const repoTarget = (idemState.repositoryOutputs || [])[0];
    if (repoTarget) validateSchema(repoTarget, loadJson("spec/repository-output-target.schema.json"), "RepositoryOutputTarget", output);
    // Every produced control event must conform to control-events.schema.json — locks the event `type` and
    // subject.type enums against producer drift (appendEvent emits many categories from across the core).
    const controlEventSchema = loadJson("spec/control-events.schema.json");
    for (const ev of (idemState.eventLog || []).slice(0, 40)) validateSchema(ev, controlEventSchema, `ControlEvent:${ev.type}`, output);
    const activeDispatch = (idemState.agentDispatches || []).find((item) => ["queued", "running"].includes(item.status));
    if (activeDispatch) {
      const sessionsBefore = idemState.workSessions.length;
      const rebuilt = buildTaskContract(idemState, {taskGroupId: activeDispatch.taskGroupId, workItemId: activeDispatch.workItemId, root});
      if (rebuilt.runId !== activeDispatch.runId) output.push("buildTaskContract idempotency: rebuild did not return the active dispatch contract");
      if (idemState.workSessions.length !== sessionsBefore) output.push("buildTaskContract idempotency: rebuild created an orphan session");
    }
    // capTaskContracts protects the contract of a non-terminal dispatch beyond the cap window.
    const capped = capTaskContracts(
      [{contractId: "c_new", sessionId: "s_new", runId: "r_new"}, {contractId: "c_old_active", sessionId: "s_active", runId: "r_active"}, {contractId: "c_old_done", sessionId: "s_done", runId: "r_done"}],
      [{sessionId: "s_active", status: "running"}, {sessionId: "s_done", status: "completed"}],
      1
    );
    if (!capped.some((item) => item.contractId === "c_old_active")) output.push("capTaskContracts evicted the contract of an active dispatch");
    if (capped.some((item) => item.contractId === "c_old_done")) output.push("capTaskContracts retained a terminal dispatch contract beyond the cap");
    // blocked_dependency hold: an implementation cell whose analysis dependency is unverified must
    // not be dispatched; a held admission (awaiting_dependency) is recorded instead.
    const holdState = structuredClone(seedState);
    ensureRuntimeCollections(holdState, {root});
    const holdTg = holdState.taskGroups.find((item) => item.id === "tg_runtime_management");
    // The analysis dep is itself held (unmet dep) so nothing dispatches; the point is only that the
    // implementation cell is NOT auto-resumed while its analysis dependency is unverified.
    holdTg.workItems = [
      {id: "wi_analysis_hold", title: "分析", status: "blocked_dependency", ownerRole: "orchestrator", taskExecutionClass: "deep_analysis", dependsOnWorkItemRefs: ["wi_absent_dep"], progress: 0},
      {id: "wi_impl_hold", title: "实现", status: "blocked_dependency", blockedReason: "awaiting_analysis_output", ownerRole: "agent-runtime", taskExecutionClass: "implementation", dependsOnWorkItemRefs: ["wi_analysis_hold"], progress: 0}
    ];
    runAutonomousCycle(holdState, {root, mode: "all", taskGroupId: "tg_runtime_management", autoSyncSkills: false});
    if ((holdState.agentDispatches || []).some((item) => item.workItemId === "wi_impl_hold")) output.push("blocked_dependency hold: implementation cell dispatched before its analysis dependency was verified");
    const heldAdmission = (holdState.admissionDecisions || []).find((item) => item.workItemId === "wi_impl_hold");
    if (!heldAdmission || heldAdmission.reasonCode !== "awaiting_dependency") output.push("blocked_dependency hold: no awaiting_dependency admission recorded");

    // resolve_decision actuator: reopen returns a needs_decision cell to ready and resets the rework
    // count (supersedes prior changes_requested bundles); abandon supersedes the cell.
    const decisionState = structuredClone(seedState);
    ensureRuntimeCollections(decisionState, {root});
    const decisionTg = decisionState.taskGroups.find((item) => item.id === "tg_runtime_management");
    decisionTg.workItems = [{id: "wi_decide", title: "决策项", status: "needs_decision", blockedReason: "independent_review_changes_requested", ownerRole: "agent-runtime", progress: 40}];
    decisionState.reviewBundles = [{bundleId: "rvb_x", workItemId: "wi_decide", verdict: "changes_requested", status: "consumed"}];
    createHumanDirective(decisionState, {taskGroupId: "tg_runtime_management", directiveType: "resolve_decision", workItemId: "wi_decide", resolution: "reopen"}, {actor: "acct_ct"});
    consumeQueuedHumanDirectives(decisionState);
    const reopened = decisionTg.workItems.find((item) => item.id === "wi_decide");
    if (reopened.status !== "ready") output.push("resolve_decision reopen did not return the needs_decision cell to ready");
    if (reopened.blockedReason) output.push("resolve_decision reopen left a blockedReason");
    if (!decisionState.reviewBundles.every((item) => item.workItemId !== "wi_decide" || item.supersededByHumanDecision)) output.push("resolve_decision reopen did not reset the rework count");
    const abandonState = structuredClone(seedState);
    ensureRuntimeCollections(abandonState, {root});
    const abandonTg = abandonState.taskGroups.find((item) => item.id === "tg_runtime_management");
    abandonTg.workItems = [{id: "wi_abandon", title: "放弃项", status: "needs_decision", blockedReason: "role_drift_guard_blocked", ownerRole: "agent-runtime", progress: 10}];
    createHumanDirective(abandonState, {taskGroupId: "tg_runtime_management", directiveType: "resolve_decision", workItemId: "wi_abandon", resolution: "abandon"}, {actor: "acct_ct"});
    consumeQueuedHumanDirectives(abandonState);
    if (abandonTg.workItems.find((item) => item.id === "wi_abandon").status !== "superseded") output.push("resolve_decision abandon did not supersede the needs_decision cell");

    // close-barrier must ignore a stale (older stateVersion) cached readiness (else close_barrier_compute
    // could satisfy/close a group with unfinished work).
    const staleState = structuredClone(seedState);
    ensureRuntimeCollections(staleState, {root});
    const staleTg = staleState.taskGroups.find((item) => item.id === "tg_runtime_management");
    staleTg.workItems = [{id: "wi_incomplete", title: "未完成", status: "ready", ownerRole: "agent-runtime", progress: 0}];
    staleState.stateVersion = 999;
    staleState.completionReadiness = [{schemaVersion: "completion-readiness/v1", checkId: "stale", taskGroupId: "tg_runtime_management", status: "clear", stateVersion: 1, blockingObjects: [], checkResults: {}, requiredChecks: []}];
    const staleBarrier = computeCloseBarrier(staleState, "tg_runtime_management", {mutate: false});
    if (staleBarrier.satisfied) output.push("close-barrier trusted a stale readiness and reported satisfied with incomplete work");
    // core-init absorption: the barrier records a reality-first holistic judgment (not a bare flag AND).
    if (!staleBarrier.holisticJudgment || staleBarrier.holisticJudgment.basis !== "reality_first_close_barrier") output.push("close-barrier missing holistic judgment record");
    if (staleBarrier.holisticJudgment.requiredCellsTerminal !== false || staleBarrier.holisticJudgment.conclusion !== "blocked_by_real_gate") output.push("close-barrier holistic judgment did not reflect the incomplete cell");
    if ("all_policy_decisions_terminal" in staleBarrier.gateResults || "release_manifest_ready" in staleBarrier.gateResults) output.push("close-barrier still emits vacuous always-pass stub gates");
    // The produced close-barrier instance must validate against its schema (schema<->code drift guard;
    // the core-init absorption removed 4 gates + added holisticJudgment).
    validateSchema(staleBarrier, closeBarrierSchema, "CloseBarrier", output);
    // Efficacy guard: a barrier claiming satisfied:true while it still has blocking objects / non-passed
    // gates must be REJECTED — this is the satisfied => all-gates-passed invariant that lived in an
    // ignored allOf/if/then with patternProperties, previously validated by nothing.
    const forgedSatisfied = structuredClone(staleBarrier); forgedSatisfied.satisfied = true;
    const forgedErrors = [];
    validateSchema(forgedSatisfied, closeBarrierSchema, "neg", forgedErrors, closeBarrierSchema);
    if (forgedErrors.length === 0) output.push("VACUOUS: validator accepted a CloseBarrier with satisfied=true but unfinished gates/blocking objects (satisfied-implies-passed not enforced)");

    // terminateCellRuntime cascade — BEHAVIORAL (not source-string) proof that abandoning a cell cleans
    // every downstream reference, so gutting any cascade branch fails a gate. Covers the deadlock class
    // the source-presence assertions in validate-specs can't catch.
    const cascadeState = structuredClone(seedState);
    ensureRuntimeCollections(cascadeState, {root});
    cascadeState.agentDispatches = [{dispatchId: "disp_casc", taskGroupId: "tg_runtime_management", workItemId: "wi_casc", sessionId: "sess_casc", status: "running", assignedNodeId: "node_casc", revocationPending: true, mcpGrants: []}];
    cascadeState.workSessions = [{sessionId: "sess_casc", taskGroupId: "tg_runtime_management", workItemId: "wi_casc", status: "active"}];
    cascadeState.leases = [{leaseId: "lease_casc", status: "active", holderRef: "session:sess_casc", resourceRef: "RepositoryOutputTarget:tgt_casc"}];
    cascadeState.repositoryOutputs = [{targetId: "tgt_casc", status: "leased", leaseRef: "lease_casc"}];
    cascadeState.roleDriftGuards = [{guardId: "guard_casc", sessionId: "sess_casc", status: "open"}];
    cascadeState.humanConfirmationRequests = [{requestId: "hcr_casc", dispatchId: "disp_casc", status: "pending"}];
    cascadeState.agentRuntimeNodes = [{nodeId: "node_casc", projectIds: ["prj_control_plane"], activeDispatchIds: ["disp_casc"], status: "active"}];
    terminateCellRuntime(cascadeState, "tg_runtime_management", "wi_casc", "cell_abandoned_test");
    const cDisp = cascadeState.agentDispatches[0];
    if (cDisp.status !== "failed") output.push("terminateCellRuntime cascade: dispatch not failed");
    if (cDisp.assignedNodeId || cDisp.revocationPending) output.push("terminateCellRuntime cascade: dispatch node binding / revocationPending not cleared (revoke-ack could resurrect it)");
    if ((cascadeState.agentRuntimeNodes[0].activeDispatchIds || []).includes("disp_casc")) output.push("terminateCellRuntime cascade: dispatch left in node.activeDispatchIds");
    if (cascadeState.workSessions[0].status !== "failed") output.push("terminateCellRuntime cascade: session not failed");
    if (cascadeState.leases[0].status !== "released") output.push("terminateCellRuntime cascade: active lease not released");
    if (cascadeState.repositoryOutputs[0].status !== "superseded" || cascadeState.repositoryOutputs[0].leaseRef) output.push("terminateCellRuntime cascade: bound repository target not superseded / leaseRef not cleared");
    if (cascadeState.roleDriftGuards[0].status !== "closed") output.push("terminateCellRuntime cascade: role drift guard not closed");
    if (cascadeState.humanConfirmationRequests[0].status === "pending") output.push("terminateCellRuntime cascade: dispatch-bound pending confirmation not cancelled (keeps no_pending_human_confirmations blocked)");

    // C3 drift gate: every state-machine-declared terminal state MUST be treated as terminal by the close
    // barrier, else a record parked in a newly-added upstream terminal state is seen as active forever
    // (barrier liveness wedge). The barrier set is intentionally a SUPERSET (it also treats success states
    // completed_objective/committed as done), so this is a subset check. The mirror is bound to the real
    // code literal (already pinned by validate-specs), transitively binding the state machine to the code.
    const barrierTerminal = {
      WorkSession: ["completed_objective", "failed", "closed", "recycled", "aborted"],
      AgentDispatch: ["completed", "failed", "cancelled"],
      RepositoryOutputTarget: ["pushed", "committed", "rejected", "superseded"],
      ReviewBundle: ["consumed", "rejected"]
    };
    const machines = loadStateMachines(root).machines || {};
    const coreSourceText = readFileSync(resolve(root, "apps/control-plane-ui/lib/control-plane-core.mjs"), "utf8");
    for (const [entity, barrierSet] of Object.entries(barrierTerminal)) {
      if (!coreSourceText.includes(barrierSet.map((s) => `"${s}"`).join(", "))) output.push(`terminal-set drift gate: barrier ${entity} terminal literal not found in control-plane-core (update this mirror)`);
      const missing = ((machines[entity] || {}).terminal || []).filter((s) => !barrierSet.includes(s));
      if (missing.length) output.push(`terminal-set drift: ${entity} state-machine terminal(s) ${JSON.stringify(missing)} not treated as terminal by the close barrier (liveness wedge risk)`);
    }

    // Permission-timeout deadlock fix (cross-subsystem seam): a permission request whose runtime poll timed
    // out leaves a blocked, node-detached dispatch marked permission_request_pending. APPROVE must requeue
    // it (not no-op) and DENY must terminalize it — otherwise the orphaned dispatch wedges the close barrier
    // with the operator's resolve lever dead.
    const mkPermTimedOut = () => {
      const s = structuredClone(seedState);
      ensureRuntimeCollections(s, {root});
      s.agentDispatches = [{dispatchId: "disp_perm", taskGroupId: "tg_runtime_management", workItemId: "wi_perm", sessionId: "sess_perm", status: "blocked", blockedReason: "permission_request_pending", assignedNodeId: "node_perm", mcpGrants: []}];
      s.workSessions = [{sessionId: "sess_perm", taskGroupId: "tg_runtime_management", workItemId: "wi_perm", status: "needs_decision", blockedReason: "permission_request_pending"}];
      s.agentRuntimeNodes = [{nodeId: "node_perm", projectIds: ["prj_control_plane"], activeDispatchIds: ["disp_perm"], status: "active"}];
      const tg = s.taskGroups.find((t) => t.id === "tg_runtime_management");
      tg.workItems = [{id: "wi_perm", title: "待授权项", status: "needs_decision", blockedReason: "permission_request_pending", ownerRole: "agent-runtime", progress: 30}];
      return s;
    };
    const permReq = {requestId: "perm_x", sessionId: "sess_perm", workId: "wi_perm", taskGroupId: "tg_runtime_management"};
    const apprState = mkPermTimedOut();
    if (!findPermissionBlockedDispatch(apprState, permReq)) output.push("permission-timeout: findPermissionBlockedDispatch did not locate the marked dispatch");
    requeuePermissionApprovedDispatch(apprState, permReq);
    const apprDisp = apprState.agentDispatches[0];
    if (apprDisp.status !== "queued" || apprDisp.blockedReason) output.push("permission-timeout approve: dispatch not requeued (approval would be a no-op deadlock)");
    if (apprDisp.assignedNodeId) output.push("permission-timeout approve: requeued dispatch still node-bound");
    if (apprState.workSessions[0].status !== "active") output.push("permission-timeout approve: session not restored to active");
    if (apprState.taskGroups.find((t) => t.id === "tg_runtime_management").workItems[0].status !== "ready") output.push("permission-timeout approve: work item not restored to ready");
    const denyState = mkPermTimedOut();
    terminateCellRuntime(denyState, "tg_runtime_management", "wi_perm", "permission_request_denied");
    if (!["failed", "cancelled"].includes(denyState.agentDispatches[0].status)) output.push("permission-timeout deny: dispatch not terminalized (wedges close barrier)");

    // permissionResolve idempotency/terminal guard: a settled request must not re-resolve (a deny->approve
    // flip would re-run the cascade and mint an access grant for an already-terminalized cell).
    const permIdemState = structuredClone(seedState);
    ensureRuntimeCollections(permIdemState, {root});
    permIdemState.permissionRequests = [{requestId: "perm_settled", status: "rejected", resource: {resourceType: "task_group", resourceId: "tg_runtime_management"}, permission: "task_group:write", subjectRef: {subjectType: "account", subjectId: "acct_x"}}];
    const grantsBefore = (permIdemState.accessGrants || []).length;
    const reResolve = permissionResolve(permIdemState, {requestId: "perm_settled", status: "approved"});
    if (permIdemState.permissionRequests[0].status !== "rejected") output.push("permissionResolve: a settled (rejected) request was re-resolved (deny->approve flip)");
    if (!reResolve.alreadyResolved || reResolve.accessGrant) output.push("permissionResolve: re-resolving a settled request minted a grant / did not report alreadyResolved");
    if ((permIdemState.accessGrants || []).length !== grantsBefore) output.push("permissionResolve: re-resolving a settled request created an access grant for a terminalized cell");

    // Same terminal-guard class: approvalResolve must not flip a settled governance verdict, and
    // findingResolve must not re-dispose a terminalized finding into an accepted class.
    const apprIdem = structuredClone(seedState);
    ensureRuntimeCollections(apprIdem, {root});
    apprIdem.approvalRequests = [{approvalId: "appr_settled", status: "rejected", resolvedBy: "security", decisionRecordRef: "dr_1"}];
    const apprRe = approvalResolve(apprIdem, {approvalId: "appr_settled", status: "approved", resolvedBy: "attacker"});
    if (apprIdem.approvalRequests[0].status !== "rejected") output.push("approvalResolve: a settled rejected verdict was flipped to approved");
    if (apprIdem.approvalRequests[0].resolvedBy !== "security" || !apprRe.alreadyResolved) output.push("approvalResolve: re-resolving overwrote the audit trail / did not report alreadyResolved");
    const findIdem = structuredClone(seedState);
    ensureRuntimeCollections(findIdem, {root});
    findIdem.findings = [{findingId: "find_settled", status: "resolved", dispositionClass: "fixed_unverified", taskGroupId: "tg_runtime_management"}];
    const findRe = findingResolve(findIdem, {findingId: "find_settled", status: "dismissed", dispositionClass: "not_applicable"});
    if (findIdem.findings[0].status !== "resolved" || findIdem.findings[0].dispositionClass !== "fixed_unverified") output.push("findingResolve: a terminal fixed_unverified finding was re-disposed into an accepted class (barrier bypass)");
    if (!findRe.alreadyResolved) output.push("findingResolve: re-resolving a terminal finding did not report alreadyResolved");

    // M3/M4 ReviewBundle: register must create a MODELED "submitted" state (was the unmodeled "registered"
    // that no path could clear -> permanent close-barrier wedge), and review_result_consume must
    // terminalize the referenced bundle to a modeled terminal (consumed/rejected) so it stops blocking.
    const rbState = structuredClone(seedState);
    ensureRuntimeCollections(rbState, {root});
    const rb = reviewBundleRegister(rbState, {taskGroupId: "tg_runtime_management", reviewBundleId: "rvb_ext", reviewMode: "external"}).reviewBundle;
    if (rb.status !== "submitted") output.push("reviewBundleRegister: bundle not created in the modeled 'submitted' state (unmodeled status wedges the barrier)");
    reviewResultConsume(rbState, {taskGroupId: "tg_runtime_management", reviewBundleId: "rvb_ext", summary: "ok"});
    if (rbState.reviewBundles.find((b) => b.reviewBundleId === "rvb_ext").status !== "consumed") output.push("reviewResultConsume: submitted bundle not terminalized to consumed (permanent close-barrier wedge)");
    const rbReject = structuredClone(rbState);
    rbReject.reviewBundles = [reviewBundleRegister(rbReject, {taskGroupId: "tg_runtime_management", reviewBundleId: "rvb_rej"}).reviewBundle];
    reviewResultConsume(rbReject, {taskGroupId: "tg_runtime_management", reviewBundleId: "rvb_rej", verdict: "rejected", summary: "no"});
    if (rbReject.reviewBundles.find((b) => b.reviewBundleId === "rvb_rej").status !== "rejected") output.push("reviewResultConsume: a rejecting verdict did not land the bundle in the modeled terminal 'rejected'");

    // M1 ExecutionTopology: the producer must conform to execution-topology.schema.json AND the modeled
    // lifecycle must be walkable to a terminal state — a topology with no reachable terminal would block
    // the no_open_execution_topologies close-barrier gate forever (structural deadlock).
    const topoSchema = loadJson("spec/execution-topology.schema.json");
    const topoState = structuredClone(seedState);
    ensureRuntimeCollections(topoState, {root});
    const topoTg = topoState.taskGroups.find((t) => t.id === "tg_runtime_management");
    topoTg.workItems = [{id: "wi_topo", title: "并行拓扑项", status: "ready", ownerRole: "agent-runtime", progress: 0}];
    const planned = createExecutionTopology(topoState, {
      taskGroupId: "tg_runtime_management", workItemId: "wi_topo", root,
      branches: [
        {branchId: "b_api", objective: "API 分支", ownedPaths: ["apps/api/**"], resourceScopes: ["db:api"]},
        {branchId: "b_ui", objective: "UI 分支", ownedPaths: ["apps/ui/**"], resourceScopes: ["db:ui"]}
      ]
    }).topology;
    validateSchema(planned, topoSchema, "ExecutionTopology(planned)", output);
    if (planned.status !== "planned" || planned.mode !== "parallel_active") output.push("M1: a multi-branch topology was not planned as parallel_active");
    // A non-terminal topology MUST gate the close barrier (discriminating: assert the specific blocker).
    const openReadiness = computeCloseBarrier(topoState, "tg_runtime_management", {mutate: false});
    if (!(openReadiness.blockingObjects || []).some((b) => b.objectType === "ExecutionTopology")) output.push("M1: an open (planned) execution topology did NOT block the close barrier");
    // Walk the full modeled lifecycle to a terminal state.
    advanceExecutionTopology(topoState, {topologyId: planned.topologyId, action: "check_eligibility"});
    if (planned.status !== "eligibility_checked" || planned.blockers.length) output.push(`M1: disjoint-path plan failed eligibility unexpectedly (${JSON.stringify(planned.blockers)})`);
    // 方案是核心决策：未经人工定稿不得启动。
    let planStartBlocked = false;
    try { advanceExecutionTopology(topoState, {topologyId: planned.topologyId, action: "start"}); }
    catch (error) { planStartBlocked = error.message === "execution_topology_requires_human_plan_confirmation"; }
    if (!planStartBlocked) output.push("人工闸门: 执行方案未经人工定稿就被启动了");
    // 资格通过时应自动挂起一张 plan_topology 人工定稿单，供人确认。
    const planConfirmation = (topoState.humanConfirmationRequests || []).find((item) => item.decisionType === "plan_topology" && item.status === "pending");
    if (!planConfirmation) output.push("人工闸门: 资格通过后没有挂起执行方案的人工定稿单");
    const topoHuman = (topoState.accounts.find((a) => ["system_admin", "org_admin", "user_account"].includes(a.accountType)) || {}).accountId;
    if (planConfirmation) decideHumanConfirmation(topoState, planConfirmation.requestId, {action: "finalize", selectedOptionId: "accept_plan", expectedRound: planConfirmation.round}, {actor: topoHuman});
    advanceExecutionTopology(topoState, {topologyId: planned.topologyId, action: "start"});
    if (planned.status !== "running") output.push("M1: eligible topology did not start");
    validateSchema(planned, topoSchema, "ExecutionTopology(running)", output);
    advanceExecutionTopology(topoState, {topologyId: planned.topologyId, action: "report_branch", branchId: "b_api", resultRef: "bundle:api", actualChangedPaths: ["apps/api/x.mjs"], validationEvidenceRefs: ["test:api"]});
    if (planned.status !== "running") output.push("M1: topology left running before all branches reported");
    advanceExecutionTopology(topoState, {topologyId: planned.topologyId, action: "report_branch", branchId: "b_ui", resultRef: "bundle:ui", actualChangedPaths: ["apps/ui/y.mjs"], validationEvidenceRefs: ["test:ui"]});
    if (planned.status !== "integrating") output.push("M1: topology did not reach integrating after all branches reported");
    advanceExecutionTopology(topoState, {topologyId: planned.topologyId, action: "merge", finalValidationEvidenceRefs: ["npm run validate:ok"]});
    if (planned.status !== "merged") output.push("M1: topology could not reach the terminal 'merged' state (close-barrier deadlock)");
    validateSchema(planned, topoSchema, "ExecutionTopology(merged)", output);
    // Every guarded write bumps stateVersion in production, which is what invalidates the cached readiness;
    // mirror that here so the barrier is genuinely recomputed against the merged topology.
    topoState.stateVersion = Number(topoState.stateVersion || 1) + 1;
    const mergedBarrier = computeCloseBarrier(topoState, "tg_runtime_management", {mutate: false});
    if ((mergedBarrier.blockingObjects || []).some((b) => b.objectType === "ExecutionTopology")) output.push("M1: a merged (terminal) topology still blocked the close barrier");
    // Ineligible plan (overlapping owned paths) must be blocked from starting, with downgrade as the lever.
    const badState = structuredClone(seedState);
    ensureRuntimeCollections(badState, {root});
    badState.taskGroups.find((t) => t.id === "tg_runtime_management").workItems = [{id: "wi_bad", title: "冲突拓扑", status: "ready", ownerRole: "agent-runtime", progress: 0}];
    const bad = createExecutionTopology(badState, {
      taskGroupId: "tg_runtime_management", workItemId: "wi_bad", root,
      branches: [
        {branchId: "b1", objective: "分支1", ownedPaths: ["apps/shared/**"]},
        {branchId: "b2", objective: "分支2", ownedPaths: ["apps/shared/**"]}
      ]
    }).topology;
    advanceExecutionTopology(badState, {topologyId: bad.topologyId, action: "check_eligibility"});
    if (!bad.blockers.some((b) => b.startsWith("owned_paths_disjoint:"))) output.push("M1: overlapping owned paths did not fail the owned_paths_disjoint eligibility gate (vacuous gate)");
    let startRejected = false;
    try { advanceExecutionTopology(badState, {topologyId: bad.topologyId, action: "start"}); } catch { startRejected = true; }
    if (!startRejected) output.push("M1: an ineligible topology was allowed to start");
    advanceExecutionTopology(badState, {topologyId: bad.topologyId, action: "downgrade", downgradeReason: "owned_paths_overlap"});
    if (bad.status !== "downgraded" || bad.mode !== "downgraded_serial") output.push("M1: downgrade lever did not terminalize an ineligible topology");
    validateSchema(bad, topoSchema, "ExecutionTopology(downgraded)", output);

    // ---------------------------------------------------------------------------------------------
    // 人工定稿闸门：AI 只能提案+互审，核心决策必须真人定稿；定稿前可多轮协商，定稿后 AI 不得再改。
    // ---------------------------------------------------------------------------------------------
    const hcrSchema = loadJson("spec/human-confirmation-request.schema.json");
    const gateState = structuredClone(seedState);
    ensureRuntimeCollections(gateState, {root});
    const gateTg = gateState.taskGroups.find((t) => t.id === "tg_runtime_management");
    gateTg.workItems = [{id: "wi_gate", title: "待验收项", status: "verification_ready", ownerRole: "agent-runtime", progress: 90}];
    const humanActor = (gateState.accounts.find((a) => ["system_admin", "org_admin", "user_account"].includes(a.accountType)) || {}).accountId;
    const machineActor = (gateState.accounts.find((a) => a.accountType === "service_account") || {}).accountId;
    if (!humanActor || !machineActor) output.push("人工闸门测试: 种子里缺少真人账号或服务账号，无法验证主体区分");
    const gate = createHumanConfirmationRequest(gateState, {
      taskGroupId: "tg_runtime_management", workItemId: "wi_gate", decisionType: "work_item_verification",
      summary: "验收确认：待验收项", blocking: false, // 故意传 false —— 核心决策必须无视它
      peerReview: {verdict: "passed", findings: []},
      options: [{optionId: "accept", label: "确认验收（定稿）", recommended: true}, {optionId: "reject", label: "打回返工"}]
    });
    validateSchema(gate, hcrSchema, "HumanConfirmationRequest(major)", output);
    if (gate.decisionClass !== "major" || gate.blocking !== true) output.push("人工闸门: 核心决策未被强制标记为 major/阻塞（AI 传 blocking:false 就能绕开闸门）");
    // 机器主体不得定稿。
    let machineBlocked = false;
    try { decideHumanConfirmation(gateState, gate.requestId, {action: "finalize", selectedOptionId: "accept", expectedRound: gate.round}, {actor: machineActor}); }
    catch (error) { machineBlocked = error.message === "human_confirmation_requires_human_actor"; }
    if (!machineBlocked) output.push("人工闸门: 机器主体（service_account）竟然可以定稿核心决策");
    // 人提出自己的方案 => 不定稿、不生效，转入下一轮等 AI 再分析。
    decideHumanConfirmation(gateState, gate.requestId, {action: "revise", selectedOptionId: "none", inputText: "我有自己的方案：先补回归测试再验收", expectedRound: gate.round}, {actor: humanActor});
    if (gate.status !== "pending" || gate.awaitingAiAnalysis !== true || gate.round !== 2) output.push("人工闸门: 人提出方案后应继续挂起并等待 AI 再分析，而不是直接生效");
    if (gateTg.workItems[0].status === "verified") output.push("人工闸门: 人只是提了方案（未定稿），工作项就被验收了");
    // AI 再分析：可以反对/给更优方案，但绝不能终结决策。
    submitAiConfirmationAnalysis(gateState, gate.requestId, {
      assessment: "better_alternative", summary: "回归测试可与验收并行，建议改为先验收再补测试",
      options: [{optionId: "parallel", label: "并行：先验收并同步补测试", recommended: true}]
    }, {actor: "agent-runtime"});
    if (gate.status !== "pending") output.push("人工闸门: AI 再分析竟然终结了决策（AI 永远不能定稿）");
    if (gate.awaitingAiAnalysis) output.push("人工闸门: AI 已再分析但仍标记为等待 AI");
    if (!(gate.deliberation || []).some((turn) => turn.actorKind === "ai" && turn.assessment === "better_alternative")) output.push("人工闸门: AI 的异议/更优方案没有进入协商记录");
    validateSchema(gate, hcrSchema, "HumanConfirmationRequest(deliberating)", output);
    // 人明确定稿 => 才真正验收，并写入定稿锁。
    decideHumanConfirmation(gateState, gate.requestId, {action: "finalize", selectedOptionId: "parallel", expectedRound: gate.round}, {actor: humanActor});
    const gatedItem = gateTg.workItems[0];
    if (gate.status !== "answered" || gatedItem.status !== "verified") output.push("人工闸门: 人明确定稿后工作项未进入 verified");
    if (gatedItem.humanFinalization?.finalizedBy !== humanActor || gatedItem.humanFinalization?.outcome !== "confirmed") output.push("人工闸门: 定稿锁未写入（finalizedBy/outcome 缺失）");
    validateSchema(gate, hcrSchema, "HumanConfirmationRequest(finalized)", output);
    // 定稿后 AI 不得再改：内容有分歧必须被拦下。
    let divergenceBlocked = false;
    try { assertHumanFinalization(gatedItem, {reviewBundleRef: "rvb_other", finalCommit: "deadbeef"}); }
    catch (error) { divergenceBlocked = error.message === "human_finalized_decision_diverged"; }
    if (!divergenceBlocked) output.push("人工闸门: 已定稿方案被 AI 改动却没有拦截（定稿后 AI 仍可静默更改）");

    // 任务组关闭是核心定稿动作：机器主体不得落闸，真人落闸要留下定稿记录。
    const closeState = structuredClone(seedState);
    ensureRuntimeCollections(closeState, {root});
    const closeTg = closeState.taskGroups.find((t) => t.id === "tg_runtime_management");
    closeTg.workItems = [];
    closeState.checkpoints = []; closeState.agentDispatches = []; closeState.workSessions = [];
    closeState.repositoryOutputs = []; closeState.findings = []; closeState.permissionRequests = [];
    closeState.approvalRequests = []; closeState.humanConfirmationRequests = []; closeState.humanDirectives = [];
    const closeHuman = (closeState.accounts.find((a) => ["system_admin", "org_admin", "user_account"].includes(a.accountType)) || {}).accountId;
    const closeMachine = (closeState.accounts.find((a) => a.accountType === "service_account") || {}).accountId;
    // 机器主体的落闸请求必须被明确拒绝（与门禁是否满足无关），真人的请求必须被放行到门禁判定。
    let machineCloseBlocked = false;
    try { computeCloseBarrier(closeState, "tg_runtime_management", {root, mutate: true, actor: closeMachine}); }
    catch (error) { machineCloseBlocked = error.message === "task_group_close_requires_human_actor"; }
    if (!machineCloseBlocked) output.push("人工闸门: 机器主体竟然可以关闭任务组（关闭必须由真人落闸）");
    if (closeTg.status === "closed") output.push("人工闸门: 机器主体的关闭尝试被拒后任务组仍被关闭");
    let humanCloseAllowed = true;
    let humanClosed = null;
    closeState.stateVersion = Number(closeState.stateVersion || 1) + 1;
    try { humanClosed = computeCloseBarrier(closeState, "tg_runtime_management", {root, mutate: true, actor: closeHuman}); }
    catch { humanCloseAllowed = false; }
    if (!humanCloseAllowed) output.push("人工闸门: 真人的关闭请求被主体校验错误地拒绝了");
    // 若门禁确实满足，真人落闸必须留下定稿记录；否则（门禁未满足）不应关闭。
    if (humanClosed?.satisfied) {
      if (closeTg.status !== "closed") output.push("人工闸门: 门禁满足且由真人落闸，任务组却未关闭");
      if (closeTg.humanFinalization?.finalizedBy !== closeHuman || humanClosed.confirmedBy !== closeHuman) output.push("人工闸门: 真人关闭未留下定稿记录（humanFinalization / confirmedBy）");
      validateSchema(humanClosed, closeBarrierSchema, "CloseBarrier(humanConfirmed)", output);
    } else if (closeTg.status === "closed") {
      output.push("人工闸门: 门禁未满足却把任务组关掉了");
    }

    // 绕过复现防回归 #2：agent 通道不得自选 decisionType/subjectRef —— 否则 AI 能伪造一张文案无害的
    // "方案确认"卡片，而 subjectRef 指向它想跑的另一份拓扑，人一点确认锁就落到没人看过的对象上。
    const forgeState = structuredClone(seedState);
    ensureRuntimeCollections(forgeState, {root});
    forgeState.taskGroups.find((t) => t.id === "tg_runtime_management").workItems = [{id: "wi_forge", title: "伪造", status: "ready", ownerRole: "agent-runtime", progress: 0}];
    forgeState.agentDispatches = [{dispatchId: "disp_forge", taskGroupId: "tg_runtime_management", workItemId: "wi_forge", sessionId: "sess_forge", status: "running", assignedNodeId: "node_forge", mcpGrants: []}];
    forgeState.agentRuntimeNodes = [{nodeId: "node_forge", projectIds: ["prj_control_plane"], activeDispatchIds: ["disp_forge"], status: "active"}];
    // 模拟服务端白名单后的调用：agent 提交的字段里即便带了 decisionType/subjectRef 也不会被采纳。
    const forged = createHumanConfirmationRequest(forgeState, {
      nodeId: "node_forge", dispatchId: "disp_forge", workItemId: "wi_forge",
      summary: "看起来无害的问题", options: [{optionId: "yes", label: "继续"}],
      decisionType: "runtime_execution" // 通道恒定注入这个值
    });
    if (forged.decisionClass !== "operational" || forged.decisionType !== "runtime_execution") {
      output.push("人工闸门: agent 通道创建的确认单不是运行时类（agent 可自造核心决策单 => 洗白绕过）");
    }
    if (forged.subjectRef) output.push("人工闸门: agent 通道创建的确认单带上了 subjectRef（可指向任意对象）");

    // 结构性不变式：定稿那一刻被绑定的对象必须还是出卡片时的样子。AI 在人点确认前把方案内容改掉
    // （串行→并行、换载体、加分支），必须拒绝定稿而不是把批准算到新内容上。
    const swapState = structuredClone(seedState);
    ensureRuntimeCollections(swapState, {root});
    swapState.taskGroups.find((t) => t.id === "tg_runtime_management").workItems = [{id: "wi_swap", title: "掉包", status: "ready", ownerRole: "agent-runtime", progress: 0}];
    const swapTopo = createExecutionTopology(swapState, {taskGroupId: "tg_runtime_management", workItemId: "wi_swap", root,
      branches: [{branchId: "b_one", objective: "串行", ownedPaths: ["apps/one/**"]}]}).topology;
    advanceExecutionTopology(swapState, {topologyId: swapTopo.topologyId, action: "check_eligibility"});
    const swapConfirmation = (swapState.humanConfirmationRequests || []).find((item) => item.decisionType === "plan_topology" && item.status === "pending");
    if (swapConfirmation && !swapConfirmation.subjectContentDigest) output.push("人工闸门: 方案确认单没有记录对象内容快照（无法察觉对象被掉包）");
    // AI 在人点确认前改掉方案内容。
    swapTopo.groups[0].branches.push({branchId: "b_two", status: "queued", objective: "偷加的分支", ownedPaths: ["apps/two/**"], forbiddenPaths: [], resourceScopes: [], acceptanceChecks: ["x"], outputContract: ["changedPaths", "resultRef", "validationEvidence", "unresolvedRisks"], actualChangedPaths: []});
    swapTopo.mode = "parallel_active";
    const swapHuman = (swapState.accounts.find((a) => ["system_admin", "org_admin", "user_account"].includes(a.accountType) && a.status === "active") || {}).accountId;
    let swapRejected = false;
    if (swapConfirmation) {
      try { decideHumanConfirmation(swapState, swapConfirmation.requestId, {action: "finalize", selectedOptionId: "accept_plan", expectedRound: swapConfirmation.round}, {actor: swapHuman}); }
      catch (error) { swapRejected = error.message === "human_confirmation_subject_changed"; }
    }
    if (!swapRejected) output.push("人工闸门: 方案在人点确认前被改掉，定稿却仍然生效（批准被算到没看过的内容上）");
    if (swapTopo.humanFinalization) output.push("人工闸门: 被掉包的方案拿到了定稿锁");

    // 绕过复现防回归：AI 抢先另建一份拓扑，不得把人对第一份方案的批准"洗"到第二份上。
    const raceState = structuredClone(seedState);
    ensureRuntimeCollections(raceState, {root});
    const raceTg = raceState.taskGroups.find((t) => t.id === "tg_runtime_management");
    raceTg.workItems = [{id: "wi_race", title: "抢跑项", status: "ready", ownerRole: "agent-runtime", progress: 0}];
    const safePlan = createExecutionTopology(raceState, {taskGroupId: "tg_runtime_management", workItemId: "wi_race", root,
      branches: [{branchId: "b_safe", objective: "串行", ownedPaths: ["apps/safe/**"]}]}).topology;
    advanceExecutionTopology(raceState, {topologyId: safePlan.topologyId, action: "check_eligibility"});
    const raceConfirmation = (raceState.humanConfirmationRequests || []).find((item) => item.decisionType === "plan_topology" && item.status === "pending");
    // AI 在人点确认前另建一份拓扑（同一个工作项）。
    const evilPlan = createExecutionTopology(raceState, {taskGroupId: "tg_runtime_management", workItemId: "wi_race", root,
      branches: [{branchId: "b_evil", objective: "并行", ownedPaths: ["apps/evil/**"]}, {branchId: "b_evil2", objective: "并行2", ownedPaths: ["apps/evil2/**"]}]}).topology;
    const raceHuman = (raceState.accounts.find((a) => ["system_admin", "org_admin", "user_account"].includes(a.accountType) && a.status === "active") || {}).accountId;
    decideHumanConfirmation(raceState, raceConfirmation.requestId, {action: "finalize", selectedOptionId: "accept_plan", expectedRound: raceConfirmation.round}, {actor: raceHuman});
    if (evilPlan.humanFinalization) output.push("人工闸门: 人对方案A的批准被洗到了 AI 另建的方案B 上（定稿锁按 workItemId 而非具体拓扑落位）");
    if (!safePlan.humanFinalization) output.push("人工闸门: 人批准的那份方案没有拿到定稿锁");
    let evilStartBlocked = false;
    try { advanceExecutionTopology(raceState, {topologyId: evilPlan.topologyId, action: "check_eligibility"}); advanceExecutionTopology(raceState, {topologyId: evilPlan.topologyId, action: "start"}); }
    catch (error) { evilStartBlocked = error.message === "execution_topology_requires_human_plan_confirmation"; }
    if (!evilStartBlocked) output.push("人工闸门: AI 另建的未获批方案竟然可以启动（绕过）");
    // 方案定稿不得连带掐死该工作项的验收（plan_topology 的锁不应被当成验收已定稿）。
    const raceItem = raceTg.workItems.find((i) => i.id === "wi_race");
    if (raceItem.humanFinalization?.decisionType === "plan_topology") output.push("人工闸门: 方案定稿锁被写到工作项上，会让验收永久无法进行（死锁）");
    // 已定稿的方案不得被 AI 自行降级（分歧必须被拦下）。
    const raceMachine = (raceState.accounts.find((a) => a.accountType === "service_account") || {}).accountId;
    let downgradeBlocked = false;
    try { advanceExecutionTopology(raceState, {topologyId: safePlan.topologyId, action: "downgrade", downgradeReason: "ai_decided", actor: raceMachine}); }
    catch (error) { downgradeBlocked = error.message === "human_finalized_decision_diverged"; }
    if (!downgradeBlocked) output.push("人工闸门: 已定稿方案被 AI 自行降级（定稿后 AI 仍可改变方案）");
    // 但不能只拦不给出路：AI 被拦下时必须挂出降级申请单，交回人定夺（"有分歧则回到人工确认"）。
    if (!(raceState.humanConfirmationRequests || []).some((item) => String(item.question?.summary || "").includes("申请降级") && item.status === "pending")) {
      output.push("人工闸门: AI 的降级被拦下却没有挂出人工确认单（分歧未回到人工，方案将永久卡住）");
    }
    // 真人自己改自己的定稿必须放行，否则运行载体不可用时方案既不能降级也不能取消 = 死锁。
    let humanDowngradeOk = true;
    try { advanceExecutionTopology(raceState, {topologyId: safePlan.topologyId, action: "downgrade", downgradeReason: "runner_unavailable", actor: raceHuman}); }
    catch { humanDowngradeOk = false; }
    if (!humanDowngradeOk || safePlan.status !== "downgraded") output.push("人工闸门: 真人无法降级自己定稿的方案（已定稿方案陷入无杠杆死锁）");
    // 轮次令牌：AI 修订候选后，人手里的旧轮次必须失效。
    const roundStaleState = structuredClone(gateState);
    const roundStaleReq = roundStaleState.humanConfirmationRequests.find((r) => r.decisionType === "work_item_verification");
    if (roundStaleReq) {
      // 走真实路径：人先"提交修改意见"把球踢回 AI（awaitingAiAnalysis），AI 才有资格再分析。
      roundStaleReq.status = "pending"; delete roundStaleReq.decision; roundStaleReq.awaitingAiAnalysis = true;
      const roundBefore = roundStaleReq.round;
      submitAiConfirmationAnalysis(roundStaleState, roundStaleReq.requestId, {assessment: "better_alternative", summary: "换个方案", options: [{optionId: "new_opt", label: "新方案"}]}, {actor: "agent-runtime"});
      // AI 不能连续刷轮次把人锁在门外：球已经踢回给人，第二次再分析必须被拒（防活锁）。
      let livelockBlocked = false;
      try { submitAiConfirmationAnalysis(roundStaleState, roundStaleReq.requestId, {assessment: "concerns", summary: "再改一次", options: [{optionId: "again", label: "又一个方案"}]}, {actor: "agent-runtime"}); }
      catch (error) { livelockBlocked = error.message === "human_confirmation_not_awaiting_ai_analysis"; }
      if (!livelockBlocked) output.push("人工闸门: AI 可连续刷新候选方案推进轮次，人永远定不了稿（活锁）");
      if (roundStaleReq.round === roundBefore) output.push("人工闸门: AI 修订候选方案后未推进轮次（轮次令牌失效，TOCTOU 仍成立）");
      let staleRejected = false;
      try { decideHumanConfirmation(roundStaleState, roundStaleReq.requestId, {action: "finalize", selectedOptionId: "new_opt", expectedRound: roundBefore}, {actor: humanActor}); }
      catch (error) { staleRejected = error.message === "human_confirmation_round_stale"; }
      if (!staleRejected) output.push("人工闸门: 人拿着过期轮次仍可定稿（AI 可在点击前掉包方案）");
    }

    // AI 互审本身绝不能把工作项推到 verified —— 它只能推进到 verification_ready 并挂起人工定稿单。
    const reviewState2 = structuredClone(seedState);
    ensureRuntimeCollections(reviewState2, {root});
    const rTg = reviewState2.taskGroups.find((t) => t.id === "tg_runtime_management");
    rTg.workItems = [{id: "wi_rev", title: "互审项", status: "checkpoint_submitted", ownerRole: "agent-runtime", progress: 80}];
    // 用仓库真实 HEAD，否则 final_commit_not_verifiable 会让互审走返工分支而不是通过分支。
    const headCommit = gitHead(root);
    reviewState2.checkpoints = [{taskGroupId: "tg_runtime_management", workId: "wi_rev", runId: "run_rev",
      commitRefs: [{commit: headCommit}], pushRefs: [{remote: "origin", ref: "refs/heads/main", remoteSha: headCommit}],
      artifactManifestRefs: ["docs/m.json"], repositoryOutputTargetRefs: ["tgt_rev"], changedPathEvidenceRefs: []}];
    reviewState2.repositoryOutputs = [{targetId: "tgt_rev", status: "pushed", pathAllowlist: ["**"]}];
    const reviewOutcome = performIndependentReview(reviewState2, rTg, rTg.workItems[0], {root}, {});
    if (rTg.workItems[0].status === "verified") output.push("人工闸门: AI 互审仍然直接把工作项标记为 verified（自动确认未去除）");
    if (reviewOutcome.reviewed && !reviewOutcome.awaitingHumanConfirmation) output.push("人工闸门: AI 互审通过后没有发起人工定稿单");

    // H2: internal independent-review records use their own schema, distinct from the external ReviewBundle.
    // Validate the exact shape performIndependentReview emits against internal-review-record.schema.json.
    validateSchema({
      schemaVersion: "internal-review-record/v1", bundleId: "rvb_int", projectId: "prj_control_plane",
      taskGroupId: "tg_runtime_management", workItemId: "wi_int", checkpointRef: "checkpoint:run_int",
      reviewerRole: "reviewer", reviewMode: "independent_control_plane_review", verdict: "changes_requested",
      findings: ["push_evidence_missing"], evidenceRefs: ["review-evidence:commit:abc"], status: "consumed",
      supersededByHumanDecision: false, createdAt: "2026-07-28T00:00:00Z", updatedAt: "2026-07-28T00:00:00Z"
    }, loadJson("spec/internal-review-record.schema.json"), "InternalReviewRecord", output);

    // H1 high_risk_no_self_approval + AI-quorum: the proposer of a high-risk action may not approve it, and
    // approval only terminalizes to "approved" once a distinct-approver quorum is reached.
    const approvalHrState = structuredClone(seedState);
    ensureRuntimeCollections(approvalHrState, {root});
    // 审批需要真人终审：给测试造三个真实的人类账号 + 一个机器账号。
    approvalHrState.accounts = [
      ...(approvalHrState.accounts || []),
      {schemaVersion: "account/v1", accountId: "acct_alice", accountType: "user_account", displayName: "Alice", status: "active"},
      {schemaVersion: "account/v1", accountId: "acct_bob", accountType: "user_account", displayName: "Bob", status: "active"},
      {schemaVersion: "account/v1", accountId: "acct_carol", accountType: "user_account", displayName: "Carol", status: "active"},
      {schemaVersion: "account/v1", accountId: "acct_ai_1", accountType: "service_account", displayName: "AI-1", status: "active"},
      {schemaVersion: "account/v1", accountId: "acct_ai_2", accountType: "service_account", displayName: "AI-2", status: "active"}
    ];
    approvalHrState.approvalRequests = [{approvalId: "appr_hr", status: "pending", riskClass: "high", proposedBy: "acct_alice", quorum: 1, approvals: []}];
    const selfAppr = approvalResolve(approvalHrState, {approvalId: "appr_hr", status: "approved", resolvedBy: "acct_alice"});
    if (selfAppr.error !== "high_risk_no_self_approval" || approvalHrState.approvalRequests[0].status === "approved") output.push("H1: a high-risk request was self-approved by its proposer");
    approvalResolve(approvalHrState, {approvalId: "appr_hr", status: "approved", resolvedBy: "acct_bob"});
    if (approvalHrState.approvalRequests[0].status !== "approved") output.push("H1: a distinct approver could not approve a high-risk request");
    approvalHrState.approvalRequests.push({approvalId: "appr_q2", status: "pending", riskClass: "medium", proposedBy: "acct_alice", quorum: 2, approvals: []});
    const q2 = () => approvalHrState.approvalRequests.find((a) => a.approvalId === "appr_q2");
    approvalResolve(approvalHrState, {approvalId: "appr_q2", status: "approved", resolvedBy: "acct_bob"});
    if (q2().status !== "quorum_collecting") output.push("H1: a quorum-2 request terminalized on the first of two approvers");
    approvalResolve(approvalHrState, {approvalId: "appr_q2", status: "approved", resolvedBy: "acct_bob"});
    if (q2().status !== "quorum_collecting") output.push("H1: the same approver was double-counted toward quorum");
    approvalResolve(approvalHrState, {approvalId: "appr_q2", status: "approved", resolvedBy: "acct_carol"});
    if (q2().status !== "approved") output.push("H1: a quorum-2 request was not approved after two distinct approvers");
    // 终审必须有人：纯 AI（机器主体）票即使凑够法定人数也不得通过。
    approvalHrState.approvalRequests.push({approvalId: "appr_ai", status: "pending", riskClass: "medium", proposedBy: "acct_alice", quorum: 2, approvals: []});
    const aiOnly = () => approvalHrState.approvalRequests.find((a) => a.approvalId === "appr_ai");
    approvalResolve(approvalHrState, {approvalId: "appr_ai", status: "approved", resolvedBy: "acct_ai_1"});
    const aiQuorumResult = approvalResolve(approvalHrState, {approvalId: "appr_ai", status: "approved", resolvedBy: "acct_ai_2"});
    if (aiOnly().status === "approved") output.push("人工闸门: 纯 AI 票凑够法定人数就通过了审批（终审必须有真人一票）");
    if (!aiQuorumResult.awaitingHumanApprover) output.push("人工闸门: AI 凑够票后未标记 awaitingHumanApprover（缺少待真人终审的信号）");
    approvalResolve(approvalHrState, {approvalId: "appr_ai", status: "approved", resolvedBy: "acct_bob"});
    if (aiOnly().status !== "approved") output.push("人工闸门: 真人补上终审票后审批仍未通过");
    // CRITICAL: a quorum_collecting (sub-quorum) approval MUST keep blocking the close barrier — otherwise a
    // partial approval lets a high-risk action close without its full approver quorum.
    const quorumBlockState = structuredClone(seedState);
    ensureRuntimeCollections(quorumBlockState, {root});
    const qbTg = quorumBlockState.taskGroups.find((t) => t.id === "tg_runtime_management");
    qbTg.workItems = [{id: "wi_qb", title: "完成项", status: "verified", ownerRole: "agent-runtime", progress: 100, reviewBundleRef: "rvb_qb"}];
    quorumBlockState.approvalRequests = [{approvalId: "appr_qb", taskGroupId: "tg_runtime_management", status: "quorum_collecting", riskClass: "high", proposedBy: "acct_alice", quorum: 2, approvals: ["acct_bob"]}];
    const qbReadiness = computeCompletionReadiness(quorumBlockState, "tg_runtime_management", {});
    // Discriminating assertion: the seed blocks for other reasons too (repo-output target, checkpoint), so
    // assert SPECIFICALLY that the quorum_collecting approval itself contributes a blocker — this fails if
    // quorum_collecting is dropped from the barrier pending-set (the exact regression this locks).
    const qbApprovalBlocks = (qbReadiness.blockingObjects || []).some((b) => b.objectType === "PermissionOrApprovalRequest");
    if (!qbApprovalBlocks) output.push("H1 CRITICAL: a quorum_collecting (sub-quorum) high-risk approval did NOT block completion readiness (partial approval lets close bypass the quorum)");

    // human directives consumed oldest-first (FIFO): the newest adjust_priority must win.
    const fifoState = structuredClone(seedState);
    ensureRuntimeCollections(fifoState, {root});
    createHumanDirective(fifoState, {taskGroupId: "tg_runtime_management", directiveType: "adjust_priority", instruction: "first"}, {actor: "acct_ct"});
    createHumanDirective(fifoState, {taskGroupId: "tg_runtime_management", directiveType: "adjust_priority", instruction: "second"}, {actor: "acct_ct"});
    consumeQueuedHumanDirectives(fifoState);
    if (fifoState.taskGroups.find((item) => item.id === "tg_runtime_management").priorityHint !== "second") output.push("directive FIFO: newest adjust_priority did not win (LIFO regression)");

    // Per-cell error isolation (global intelligent scheduling): a cell that throws during processing
    // is quarantined to needs_decision/cell_processing_error and never aborts the whole cycle.
    const isoState = structuredClone(seedState);
    ensureRuntimeCollections(isoState, {root});
    const isoTg = isoState.taskGroups.find((item) => item.id === "tg_runtime_management");
    isoTg.workItems = [{id: "wi_throw_iso", title: "异常项", status: "blocked_dependency", ownerRole: "agent-runtime", dependsOnWorkItemRefs: 7, progress: 0}];
    let cycleAborted = false;
    try {
      runAutonomousCycle(isoState, {root, mode: "all", taskGroupId: "tg_runtime_management", autoSyncSkills: false});
    } catch {
      cycleAborted = true;
    }
    if (cycleAborted) output.push("per-cell isolation: an unexpected cell error aborted the whole cycle");
    const isolatedCell = isoTg.workItems.find((item) => item.id === "wi_throw_iso");
    if (!isolatedCell || isolatedCell.status !== "needs_decision" || isolatedCell.blockedReason !== "cell_processing_error") output.push("per-cell isolation: a throwing cell was not quarantined to needs_decision/cell_processing_error");
  }

  // §4.5 single-cell-block guard (gap #12): a blocked cell must not escalate the whole task
  // group to a global block while an executable cell can still make progress.
  const mixedGuard = {status: "development", workItems: [
    {id: "wi_blocked_guard", status: "blocked_dependency", blockedReason: "awaiting_dep", progress: 0},
    {id: "wi_exec_guard", status: "assigned", progress: 20}
  ]};
  recomputeTaskGroup(mixedGuard);
  if (mixedGuard.health === "blocked") output.push("single-cell-block guard escalated to blocked while an executable cell existed");
  if (mixedGuard.health !== "attention") output.push(`single-cell-block guard did not mark a partially-blocked group as attention (got ${mixedGuard.health})`);
  if (!mixedGuard.singleCellEscalationGuard || mixedGuard.singleCellEscalationGuard.overallBlockedPermitted !== false) output.push("single-cell-block guard did not forbid overall block with an executable cell");
  const fullyBlockedGuard = {status: "development", workItems: [
    {id: "wi_a_guard", status: "blocked_dependency", progress: 0},
    {id: "wi_b_guard", status: "failed", progress: 0}
  ]};
  recomputeTaskGroup(fullyBlockedGuard);
  if (fullyBlockedGuard.health !== "blocked") output.push("single-cell-block guard did not block a task group with no executable cell");
  if (fullyBlockedGuard.singleCellEscalationGuard.overallBlockedPermitted !== true) output.push("single-cell-block guard did not permit overall block when every cell is blocked");
  // A6 minimal-scope allow-list: a group made up only of transient waits must stay "attention"
  // even with no executable cell — a window/quota wait is never a parent block.
  const waitOnlyGuard = {status: "development", workItems: [
    {id: "wi_wait_a", status: "blocked_resource", blockerClass: "resource_queued", progress: 0},
    {id: "wi_wait_b", status: "blocked_dependency", blockerClass: "pending_window", progress: 0}
  ]};
  recomputeTaskGroup(waitOnlyGuard);
  if (waitOnlyGuard.health === "blocked") output.push("minimal-scope allow-list escalated a wait-only group to blocked (A6)");
  if (waitOnlyGuard.singleCellEscalationGuard.overallBlockedPermitted !== false) output.push("minimal-scope allow-list permitted overall block for a wait-only group (A6)");

  // gap #3: room_send (roomId, idempotencyKey) domain-level dedup returns the original message
  // on a same-key replay instead of appending a duplicate with a fresh sequence.
  const roomFirst = roomSend(state, {roomId: "room_dedup_ct", idempotencyKey: "room-dedup-1", payload: {text: "first"}});
  const roomReplay = roomSend(state, {roomId: "room_dedup_ct", idempotencyKey: "room-dedup-1", payload: {text: "first"}});
  if (roomReplay.message.messageId !== roomFirst.message.messageId || roomReplay.message.sequence !== roomFirst.message.sequence || !roomReplay.duplicate) {
    output.push("room_send did not dedup a repeated (roomId, idempotencyKey) send");
  }
  if (state.roomMessages.filter((item) => item.roomId === "room_dedup_ct").length !== 1) {
    output.push("room_send appended a duplicate room message for a repeated idempotency key");
  }
  const roomOtherKey = roomSend(state, {roomId: "room_dedup_ct", idempotencyKey: "room-dedup-2", payload: {text: "second"}});
  if (roomOtherKey.message.sequence <= roomFirst.message.sequence || roomOtherKey.duplicate) {
    output.push("room_send did not append a new message for a distinct idempotency key");
  }
  const dispatch = (state.agentDispatches || []).find((item) => item.status === "queued" || item.status === "running");
  if (!dispatch) {
    output.push("No dispatch available to attach a human confirmation contract");
  } else {
    dispatch.status = "running";
    dispatch.assignedNodeId = dispatch.assignedNodeId || "node_ct";
    const request = createHumanConfirmationRequest(state, {dispatchId: dispatch.dispatchId, summary: "选型确认", options: [{label: "方案A", recommended: true}, {label: "方案B"}]});
    validateSchema(request, humanConfirmationSchema, "HumanConfirmationRequest", output);
    if (!request.options.some((option) => option.optionId === "none" && option.system)) output.push("Human confirmation did not force a system none option");
    const dupe = createHumanConfirmationRequest(state, {dispatchId: dispatch.dispatchId, summary: "选型确认", options: [{label: "方案A"}, {label: "方案B"}]});
    if (dupe.requestId !== request.requestId) output.push("Human confirmation did not dedupe an identical pending request");
    let noneRejected = false;
    try {
      decideHumanConfirmation(state, request.requestId, {selectedOptionId: "none"}, {actor: "acct_ct"});
    } catch (error) {
      noneRejected = error.message === "human_confirmation_input_required_for_none";
    }
    if (!noneRejected) output.push("Human confirmation accepted a none selection without input text");
    const decided = decideHumanConfirmation(state, request.requestId, {selectedOptionId: request.options[0].optionId, inputText: "采用方案A"}, {actor: "acct_ct"});
    if (decided.status !== "answered") output.push("Human confirmation decision did not move the request to answered");
    const requeued = (state.agentDispatches || []).find((item) => item.dispatchId === dispatch.dispatchId);
    if (requeued.status !== "queued") output.push("Answered human confirmation did not requeue its blocked dispatch");
    if (requeued.assignedNodeId) output.push("Requeued dispatch retained its node binding after human confirmation");
  }

  // A human cancel directive over a confirmation-blocked dispatch must not deadlock the work item.
  const cancelState = structuredClone(seedState);
  ensureRuntimeCollections(cancelState, {root});
  runAutonomousCycle(cancelState, {root, mode: "all"});
  const cancelDispatch = (cancelState.agentDispatches || []).find((item) => ["queued", "running"].includes(item.status));
  if (cancelDispatch) {
    cancelDispatch.status = "running";
    cancelDispatch.assignedNodeId = "node_cancel_ct";
    const cancelRequest = createHumanConfirmationRequest(cancelState, {dispatchId: cancelDispatch.dispatchId, summary: "取消前确认", options: [{label: "继续"}]});
    createHumanDirective(cancelState, {taskGroupId: cancelDispatch.taskGroupId, directiveType: "cancel"}, {actor: "acct_ct"});
    consumeQueuedHumanDirectives(cancelState);
    const cancelledDispatch = (cancelState.agentDispatches || []).find((item) => item.dispatchId === cancelDispatch.dispatchId);
    if (cancelledDispatch.status !== "cancelled") output.push("Human cancel directive did not cancel the confirmation-blocked dispatch");
    const cancelledSession = (cancelState.workSessions || []).find((item) => item.sessionId === cancelledDispatch.sessionId);
    if (cancelledSession && !["aborted", "failed", "closed", "recycled", "completed_objective"].includes(cancelledSession.status)) {
      output.push("Human cancel directive left the work session non-terminal, deadlocking re-dispatch");
    }
    const cancelledConfirmation = (cancelState.humanConfirmationRequests || []).find((item) => item.requestId === cancelRequest.requestId);
    if (cancelledConfirmation.status !== "cancelled") output.push("Human cancel directive left the pending confirmation orphaned");
    const cancelledTaskGroup = (cancelState.taskGroups || []).find((item) => item.id === cancelDispatch.taskGroupId);
    if (cancelledTaskGroup.goalExecutionStatus !== "active_paused_by_freeze") output.push("Human cancel directive did not freeze the task group");
    const dispatchCountBefore = (cancelState.agentDispatches || []).length;
    runAutonomousCycle(cancelState, {root, mode: "all"});
    const dispatchCountAfter = (cancelState.agentDispatches || []).length;
    if (dispatchCountAfter !== dispatchCountBefore) output.push("Cancelled+frozen task group re-dispatched work on the next cycle");
  }

  // Readiness/close-barrier expose the new human gates.
  if (taskGroup) {
    const readiness = cycle && state.completionReadiness?.find((item) => item.taskGroupId === taskGroup.id);
    if (readiness && !Object.prototype.hasOwnProperty.call(readiness.checkResults, "no_pending_human_confirmations")) {
      output.push("Completion readiness is missing the no_pending_human_confirmations check");
    }
    const barrier = state.closeBarriers?.find((item) => item.taskGroupId === taskGroup.id);
    if (barrier && !Object.prototype.hasOwnProperty.call(barrier.gateResults, "no_pending_human_confirmations")) {
      output.push("Close barrier is missing the no_pending_human_confirmations gate");
    }
  }
}

function verifyRuntimeJsonConflict(output) {
  const previousStore = process.env.AIMAC_STATE_STORE;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.AIMAC_STATE_STORE = "runtime_json";
  delete process.env.DATABASE_URL;
  const runtimeDir = mkdtempSync(join(tmpdir(), "aimac-contract-state-"));
  const options = {
    root,
    runtimeDir,
    statePath: join(runtimeDir, "control-plane-state.json"),
    seedPath: resolve(root, "data", "seed-state.json"),
    buildInitialState: () => ({stateVersion: 1, runtime: {}})
  };
  try {
    writeStoredState({stateVersion: 1, runtime: {}}, options);
    const first = readStoredState(options);
    const second = readStoredState(options);
    first.stateVersion = 2;
    writeStoredState(first, {...options, expectedStateVersion: first.__loadedStateVersion});
    second.stateVersion = 2;
    try {
      writeStoredState(second, {...options, expectedStateVersion: second.__loadedStateVersion});
      output.push("runtime_json state-store did not reject stale expectedStateVersion");
    } catch (error) {
      if (!isStateStoreConflict(error)) output.push(`runtime_json state-store stale write raised wrong error: ${error.message}`);
    }
    writeStoredState({
      stateVersion: 3,
      runtime: {},
      taskGroups: [{id: "tg_collision_a", projectId: "project/a", workItems: []}],
      agentDispatches: [{dispatchId: "adp_collision_a", projectId: "project/a", taskGroupId: "tg_collision_a", updatedAt: new Date().toISOString()}],
      idempotencyRecords: {}
    }, {...options, expectedStateVersion: 2});
	    const sharded = readStoredState(options);
	    if (!sharded.agentDispatches.some((dispatch) => dispatch.dispatchId === "adp_collision_a")) {
	      output.push("runtime_json project shard did not hydrate project-scoped dispatches");
	    }
		    const centralShardIndex = JSON.parse(readFileSync(options.statePath, "utf8")).projectStateShards?.projects?.find((project) => project.projectId === "project/a");
		    if (!centralShardIndex?.storageRef?.match(/project-db\/p_[a-f0-9]{24}\.sv[0-9]+-[a-f0-9]{12}\.state\.json/u)) {
		      output.push("runtime_json project shard index did not point at a generation-qualified hash shard file");
		    }
        if (!centralShardIndex?.storagePayloadDigest || !centralShardIndex?.storagePayloadBytes) {
          output.push("runtime_json project shard index did not record shard payload digest and size");
        } else {
          const shardPath = join(runtimeDir, centralShardIndex.storageRef.replace(/^runtime:\/\//u, ""));
          const originalShard = readFileSync(shardPath, "utf8");
          writeFileSync(shardPath, originalShard.replace("adp_collision_a", "adp_tampered"));
          try {
            readStoredState(options);
            output.push("runtime_json project shard digest mismatch was not rejected");
          } catch {}
          writeFileSync(shardPath, originalShard);
        }
		    writeStoredState({stateVersion: 4, runtime: {}, taskGroups: [], agentDispatches: [], idempotencyRecords: {}}, {...options, expectedStateVersion: sharded.__loadedStateVersion});
    const emptied = readStoredState(options);
    if (emptied.agentDispatches.some((dispatch) => dispatch.dispatchId === "adp_collision_a") || emptied.taskGroups.some((taskGroup) => taskGroup.id === "tg_collision_a")) {
      output.push("runtime_json project shard stale data was resurrected after shard deletion");
    }
  } finally {
    if (previousStore === undefined) delete process.env.AIMAC_STATE_STORE;
    else process.env.AIMAC_STATE_STORE = previousStore;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    rmSync(runtimeDir, {recursive: true, force: true});
  }
}

function verifyAgentGatewayContracts(output) {
  const state = JSON.parse(JSON.stringify(seedState));
  ensureRuntimeCollections(state, {root});
  const issued = createAgentJoinToken(state, {projectId: "prj_control_plane", nodeName: "contract-node", allowedRoles: ["*"]}, {publicUrl: "https://control.example.test"});
  validateSchema(state.agentJoinTokens[0], joinTokenSchema, "AgentJoinToken", output);
  if ((state.agentJoinTokens[0].allowedMcpTools || []).includes("human-review-mcp.confirmation_decide")) {
    output.push("Agent join token must not grant human-review-mcp.confirmation_decide (agents cannot proxy human decisions)");
  }
  if (!(state.agentJoinTokens[0].allowedMcpTools || []).includes("human-review-mcp.confirmation_request_submit")) {
    output.push("Agent join token should grant human-review-mcp.confirmation_request_submit for raising confirmations");
  }
  try {
    createAgentJoinToken(state, {projectId: "prj_control_plane", nodeName: "bad-contract-node", allowedRoles: ["*"], maxUses: 2}, {publicUrl: "https://control.example.test"});
    output.push("Agent join token allowed maxUses greater than one");
  } catch {}
  if (!issued.installCommand.includes("curl -fsSL 'https://control.example.test/install-agent.sh' | sh -s --")) output.push("Agent join token did not return a server-hosted installer command");
  if (issued.installCommand.includes("--join-token ") || issued.verifiedInstallCommand.includes("--join-token ") || !issued.installCommand.includes("--join-token-file") || !issued.verifiedInstallCommand.includes("--join-token-file")) {
    output.push("Agent join token installer command exposed token in argv instead of using --join-token-file");
  }
  if (!issued.verifiedInstallCommand.includes("( if command -v sha256sum") || !issued.verifiedInstallCommand.includes("elif command -v shasum") || !issued.verifiedInstallCommand.includes("--join-token-file \"$tmp/aimac.join\"")) {
    output.push("Agent join token did not return a portable checksum-verified installer command using token file");
  }
  const registered = registerAgentNode(state, {nodeName: "contract-node", requestedRoles: ["*"], runtimeVersion: "contract", profile: {platform: "test", arch: "test", tools: [], models: [{providerClass: "custom", available: true}]}}, {joinToken: issued.joinToken, publicUrl: "https://control.example.test"});
  const registeredNode = state.agentRuntimeNodes.find((item) => item.nodeId === registered.node.nodeId);
  validateSchema(registeredNode, runtimeNodeSchema, "AgentRuntimeNode", output);
  const noExecutorIssued = createAgentJoinToken(state, {projectId: "prj_control_plane", nodeName: "contract-no-executor", allowedRoles: ["*"]}, {publicUrl: "https://control.example.test"});
  registerAgentNode(state, {nodeName: "contract-no-executor", requestedRoles: ["*"], runtimeVersion: "contract", profile: {platform: "test", arch: "test", tools: [], models: [{providerClass: "custom", adapter: "unconfigured", available: false}]}}, {joinToken: noExecutorIssued.joinToken, publicUrl: "https://control.example.test"});
  const noExecutorNode = state.agentRuntimeNodes.find((item) => item.nodeName === "contract-no-executor");
  const noExecutorCheck = selfCheckAgentNode(state, noExecutorNode, {checks: [
    {checkId: "runtime", status: "ok"},
    {checkId: "gateway", status: "ok"},
    {checkId: "filesystem", status: "ok"},
    {checkId: "git", status: "ok"},
    {checkId: "remote_mcp", status: "ok"},
    {checkId: "model_executor", status: "failed"}
  ]});
  if (noExecutorCheck.ok || noExecutorNode.admission !== "read_only") output.push("Agent Gateway admitted a node without a runnable model executor");
  const contract = buildTaskContract(state, {taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", root});
  validateSchema(contract, agentTaskContractSchema, "AgentTaskContract", output);
  const instructionPacket = state.effectiveInstructionPackets.find((packet) => packet.packetId === contract.effectiveInstructionPacketRef);
  validateSchema(instructionPacket, effectiveInstructionPacketSchema, "EffectiveInstructionPacket", output);
  if (!contract.model.model || !contract.model.modelId || !contract.model.reasoning || !contract.model.reasoningLevel || !contract.model.modelDecision || !contract.model.modelDecision.startsWith("modelDecision:")) {
    output.push("AgentTaskContract did not bind explicit model, reasoning and short modelDecision");
  }
  if (!contract.languagePolicy?.languageTag || !contract.languagePolicyDigest || contract.outputContract.languagePolicyDigest !== contract.languagePolicyDigest || !contract.inputLocators.some((locator) => locator.includes("language-policy"))) {
    output.push("AgentTaskContract did not bind task-group language policy through contract, locators and output contract");
  }
  if (!instructionPacket?.languagePolicyDigest || instructionPacket.languagePolicyDigest !== contract.languagePolicyDigest || !instructionPacket.languageDirective?.includes(contract.languagePolicy.languageTag)) {
    output.push("EffectiveInstructionPacket did not carry the task-group language policy");
  }
  const languageState = JSON.parse(JSON.stringify(seedState));
  ensureRuntimeCollections(languageState, {root});
  languageState.taskGroups.find((item) => item.id === "tg_runtime_management").languagePolicy.fallback = "legacy_invalid_fallback";
  const updatedLanguage = updateTaskGroupLanguagePolicy(languageState, "tg_runtime_management", {languageTag: "fr", languageName: "French"});
  validateSchema(updatedLanguage.languagePolicy, languagePolicySchema, "UpdatedLanguagePolicy", output);
  const localizedContract = buildTaskContract(languageState, {taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", root});
  const localizedPacket = languageState.effectiveInstructionPackets.find((packet) => packet.packetId === localizedContract.effectiveInstructionPacketRef);
  if (localizedContract.languagePolicy.languageTag !== "fr" ||
      localizedContract.languagePolicyDigest !== updatedLanguage.languagePolicyDigest ||
      localizedContract.outputContract.requiredLanguage !== "fr" ||
      localizedPacket?.languagePolicyDigest !== updatedLanguage.languagePolicyDigest ||
      !localizedPacket.languageDirective?.includes("fr/French") ||
      localizedContract.languagePolicy.fallback !== "return_blocked_for_language_mismatch") {
    output.push("Task-group language policy update did not propagate to new contracts, EIP and output contract");
  }
	  const deepAnalysisDecision = selectModel(state, {projectId: "prj_control_plane", taskGroupId: "tg_runtime_management", roleId: "orchestrator", workItem: {id: "work_deep_analysis", title: "深度分析架构方案", ownerRole: "orchestrator", requirements: ["analysis only"]}});
  if (deepAnalysisDecision.taskExecutionClass !== "deep_analysis" || deepAnalysisDecision.escalationAllowed !== false || !deepAnalysisDecision.modelDecision?.startsWith("modelDecision:") || deepAnalysisDecision.modelDecision.length > 240) {
    output.push("Model selection did not create a bounded one-line integration-owner modelDecision");
	  }
  const unavailableState = JSON.parse(JSON.stringify(seedState));
  ensureRuntimeCollections(unavailableState, {root});
  const baselineDecision = selectModel(unavailableState, {projectId: "prj_control_plane", taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", roleId: "ui-console-service"});
  const baselineModelId = baselineDecision.selectedModel?.modelId;
  const unavailableModel = unavailableState.modelCapabilities.find((item) => item.modelId === baselineModelId);
  if (unavailableModel) unavailableModel.availability = "unavailable";
  const fallbackDecision = selectModel(unavailableState, {projectId: "prj_control_plane", taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", roleId: "ui-console-service"});
  if (baselineModelId && fallbackDecision.selectedModel?.modelId === baselineModelId) {
    output.push("Model selection chose a provider/model marked unavailable instead of the next ranked model");
  }
  unavailableState.modelCapabilities.forEach((item) => { item.availability = "unavailable"; });
  const rejectedDecision = selectModel(unavailableState, {projectId: "prj_control_plane", taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", roleId: "ui-console-service"});
  if (rejectedDecision.status !== "rejected" || !rejectedDecision.candidateRankings.some((item) => String(item.rejectionReason || "").includes("availability_unavailable"))) {
    output.push("Model selection did not fail closed when all models were unavailable");
  }
  try {
    buildTaskContract(unavailableState, {taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", root});
    output.push("AgentTaskContract was created even though model selection was rejected");
  } catch (error) {
    if (error.code !== "AIMAC_MODEL_SELECTION_REJECTED") output.push(`AgentTaskContract rejected model failure with wrong error: ${error.message}`);
  }
  const mixedState = JSON.parse(JSON.stringify(seedState));
  ensureRuntimeCollections(mixedState, {root});
  const mixedTaskGroup = mixedState.taskGroups.find((item) => item.id === "tg_runtime_management");
  mixedTaskGroup.workItems.unshift({id: "work_mixed_model_split", title: "深度分析并开发实现完整代码", status: "ready", ownerRole: "agent-runtime", progress: 0, requirements: ["analysis", "implementation"]});
  runAutonomousCycle(mixedState, {root, runtimeDir: join(root, ".runtime"), endpoint: "https://control.example.test", mode: "single", taskGroupId: "tg_runtime_management", autoSyncSkills: false});
  // 任务拆分是核心方案决策：AI 只能提案，第一轮【不得】直接拆，而应挂起一张人工定稿单。
  if (mixedTaskGroup.workItems.some((item) => item.id === "work_mixed_model_split_analysis")) {
    output.push("人工闸门: 任务拆分未经人工定稿就被执行了（AI 自行决定了怎么干）");
  }
  const splitConfirmation = (mixedState.humanConfirmationRequests || []).find((item) => item.decisionType === "task_split" && item.workItemId === "work_mixed_model_split" && item.status === "pending");
  if (!splitConfirmation) output.push("人工闸门: 判定需要拆分后没有挂起任务拆分的人工定稿单");
  if (splitConfirmation && (splitConfirmation.decisionClass !== "major" || splitConfirmation.blocking !== true)) output.push("人工闸门: 任务拆分定稿单未被标记为核心决策/强制阻塞");
  // 人定稿后，下一轮才真正拆分。
  if (splitConfirmation) {
    const splitHuman = (mixedState.accounts.find((a) => ["system_admin", "org_admin", "user_account"].includes(a.accountType)) || {}).accountId;
    decideHumanConfirmation(mixedState, splitConfirmation.requestId, {action: "finalize", selectedOptionId: "accept_split", expectedRound: splitConfirmation.round}, {actor: splitHuman});
    const splitResult = runAutonomousCycle(mixedState, {root, runtimeDir: join(root, ".runtime"), endpoint: "https://control.example.test", mode: "single", taskGroupId: "tg_runtime_management", autoSyncSkills: false});
    if (!splitResult.changed.some((item) => item.reason === "mixed_analysis_implementation_split") || !mixedTaskGroup.workItems.some((item) => item.id === "work_mixed_model_split_analysis") || !mixedTaskGroup.workItems.some((item) => item.id === "work_mixed_model_split_implementation")) {
      output.push("人工闸门: 人已定稿同意拆分，编排器却仍未执行拆分");
    }
    const derived = (mixedState.derivedTaskRequests || []).find((item) => item.sourceRef === "WorkItem:work_mixed_model_split");
    if (derived && !String(derived.decisionRecordRef || "").startsWith("hcr_")) output.push("人工闸门: 拆分派生请求的 decisionRecordRef 未指向真实的人工定稿单");
  }
  state.agentDispatches.unshift({
    schemaVersion: "agent-dispatch/v1",
    dispatchId: "adp_contract_gateway",
    projectId: contract.projectId,
    taskGroupId: contract.taskGroupId,
    workItemId: contract.workId,
    sessionId: contract.sessionId,
    runId: contract.runId,
    status: "queued",
    deliveryMode: "new_session",
    model: contract.model.model,
    reasoning: contract.model.reasoning,
    modelDecision: contract.model.modelDecision,
    modelSelectionDecisionRef: contract.model.modelSelectionDecisionRef,
    language: contract.languagePolicy.languageTag,
    languagePolicyDigest: contract.languagePolicyDigest,
    taskContractDigest: contract.contractDigest,
    taskContractRef: `AgentTaskContract:${contract.commandId}`,
    repositoryOutputTargetRef: contract.repositoryOutputTargetRef,
    roleId: contract.roleId,
    skillWorksetId: contract.roleSkill.worksetId,
    requiredCredentialEnvNames: [],
    workerKind: "model_agent_runtime",
    attempts: 0,
    checkpointRequired: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  validateSchema(state.agentDispatches[0], agentDispatchSchema, "AgentDispatch", output);
  try {
    getSkillWorkset(state, registeredNode, contract.roleSkill.worksetId, {runtimeDir: join(root, ".runtime")});
    output.push("Agent Gateway allowed skill workset download before dispatch claim");
  } catch {}
  if (registered.gateway.mcpUrl !== "https://control.example.test/mcp") output.push("AgentRuntimeNode registration did not bind remote MCP URL");
  const node = registeredNode;
  const firstNodeToken = registered.nodeToken;
  node.credentialExpiresAt = new Date(Date.now() + 60 * 1000).toISOString();
  const rotated = heartbeatAgentNode(state, node, {profile: node.profile}, {presentedToken: firstNodeToken});
  if (!rotated.nodeToken) output.push("Agent heartbeat did not rotate near-expiry node credentials");
	  if (rotated.nodeToken && !authenticateAgentNode(state, firstNodeToken)) output.push("Agent Gateway rejected previous credential during rotation overlap");
	  if (rotated.nodeToken && !authenticateAgentNode(state, rotated.nodeToken)) output.push("Agent Gateway rejected rotated current credential");
    const previousHeartbeat = heartbeatAgentNode(state, node, {profile: node.profile}, {presentedToken: firstNodeToken});
    if (previousHeartbeat.nodeToken || (rotated.nodeToken && !authenticateAgentNode(state, rotated.nodeToken))) {
      output.push("Agent heartbeat with previous credential invalidated the current node token");
    }
  node.status = "online";
  node.admission = "full";
  const claimed = claimNextDispatch(state, node, {runtimeDir: join(root, ".runtime"), claimTtlSeconds: 300});
  if (!claimed.dispatch) output.push(`Agent Gateway did not claim a compatible dispatch: ${claimed.reason || "unknown"}`);
  if (claimed.dispatch) {
    const workset = getSkillWorkset(state, registeredNode, contract.roleSkill.worksetId, {runtimeDir: join(root, ".runtime")});
    validateSchema(workset, skillWorksetSchema, "AgentSkillWorkset", output);
    if (workset.languagePolicyDigest !== contract.languagePolicyDigest || !workset.executionDirective.includes(contract.languagePolicy.languageTag)) {
      output.push("Agent skill workset did not carry the task-group language policy");
    }
    const issuedGrant = state.mcpGrants.find((grant) => grant.agentNodeId === node.nodeId && grant.dispatchId === claimed.dispatch.dispatch.dispatchId && grant.grantStatus === "issued");
    if (!issuedGrant) output.push("Agent Gateway did not issue dispatch-bound MCP grants after claim");
    if (state.mcpGrants.some((grant) => grant.agentNodeId === node.nodeId && grant.toolName === "evidence-mcp.checkpoint_submit" && grant.grantStatus === "issued")) {
      output.push("Agent Gateway issued checkpoint_submit as an Agent MCP grant instead of forcing Gateway checkpoint path");
    }
    const controlCommand = createAgentControlCommand(state, node, {commandType: "refresh_profile", dispatchId: claimed.dispatch.dispatch.dispatchId}, {actor: "contract-check", idempotencyKey: "contract-control-command"}).command;
    validateSchema(controlCommand, agentControlCommandSchema, "AgentControlCommand", output);
    const pendingCommands = listAgentControlCommands(state, node, {afterSequence: 0});
    if (!pendingCommands.commands.some((command) => command.commandId === controlCommand.commandId)) output.push("Agent control channel did not return queued command");
    const acked = ackAgentControlCommand(state, node, controlCommand.commandId, {status: "completed", result: {profileDigest: node.profileDigest}}).command;
    if (acked.status !== "completed" || !acked.resultDigest) output.push("Agent control command ack did not persist terminal status and digest");
	    const event = submitAgentExecutionEvent(state, node, {dispatchId: claimed.dispatch.dispatch.dispatchId, eventType: "executor_output", progressPercent: 45, summary: "contract event", eventKey: "contract-event-key"}).event;
	    validateSchema(event, agentExecutionEventSchema, "AgentExecutionEvent", output);
      try {
        submitAgentExecutionEvent(state, node, {dispatchId: claimed.dispatch.dispatch.dispatchId, eventType: "progress", summary: "missing key"});
        output.push("Agent execution event accepted a missing eventKey");
      } catch {}
				    const eventRuntimeDir = mkdtempSync(join(tmpdir(), "aimac-contract-events-"));
        if (event.languagePolicyDigest !== contract.languagePolicyDigest) output.push("Agent execution event did not bind the task-group language policy digest");
          const previousSegmentSize = process.env.AIMAC_PROJECT_EVENT_SEGMENT_MAX_BYTES;
			    try {
	          process.env.AIMAC_PROJECT_EVENT_SEGMENT_MAX_BYTES = "1024";
		      const stored = appendProjectExecutionEvent(eventRuntimeDir, event);
	      const durableEvent = stored.event || event;
	      const eventLog = readProjectExecutionEvents(eventRuntimeDir, event.projectId, {dispatchId: event.dispatchId, limit: 10});
	      if (!eventLog.events.some((item) => item.eventId === durableEvent.eventId) || eventLog.storage.storageKind !== "project-jsonl") {
	        output.push("Project-level execution event store did not isolate and return the dispatch event");
	      }
	      const eventByKey = readProjectExecutionEventByKey(eventRuntimeDir, event.projectId, event.eventKey);
	      if (!eventByKey || eventByKey.eventId !== durableEvent.eventId || eventByKey.sequence !== durableEvent.sequence) {
	        output.push("Project-level execution event store did not return the durable event by eventKey");
	      }
	      const firstOrdered = appendProjectExecutionEvent(eventRuntimeDir, {...event, eventId: "evt_order_first", eventKey: "order-first", sequence: 999});
	      const secondOrdered = appendProjectExecutionEvent(eventRuntimeDir, {...event, eventId: "evt_order_second", eventKey: "order-second", sequence: 1});
	      if (!(secondOrdered.event.sequence > firstOrdered.event.sequence)) {
	        output.push("Project-level execution event store did not assign append-order project sequences inside the project lock");
	      }
	      const afterFirst = readProjectExecutionEvents(eventRuntimeDir, event.projectId, {afterSequence: firstOrdered.event.sequence, limit: 10});
		      if (!afterFirst.events.some((item) => item.eventId === "evt_order_second")) {
		        output.push("Project-level execution event cursor skipped an append-later event");
		      }
          try {
            appendProjectExecutionEvent(eventRuntimeDir, {...event, eventId: "evt_missing_key", eventKey: ""});
            output.push("Project-level execution event store accepted a missing eventKey");
          } catch {}
          for (let index = 0; index < 8; index += 1) {
            appendProjectExecutionEvent(eventRuntimeDir, {...event, eventId: `evt_segment_${index}`, eventKey: `segment-${index}`, summary: "x".repeat(1200), sequence: 1});
          }
          const segmentedRead = readProjectExecutionEvents(eventRuntimeDir, event.projectId, {afterSequence: 0, limit: 50});
          const segmentEvent = readProjectExecutionEventByKey(eventRuntimeDir, event.projectId, "segment-7");
          if (!segmentEvent || !segmentedRead.events.some((item) => item.eventId === "evt_segment_7")) {
            output.push("Project-level execution event store did not read events across rotated project segments");
          }
          if (!existsSync(join(eventRuntimeDir, "project-db", `${safeProjectIdForContract(event.projectId)}.execution-events.manifest.json`))) {
            output.push("Project-level execution event store did not create a segment manifest");
          }
          // event-key KV GC: appending beyond the file cap must bound the KV dir while
          // preserving dedup for keys still inside the retained window.
          const gcRuntimeDir = mkdtempSync(join(tmpdir(), "aimac-contract-evk-gc-"));
          const gcEnvKeys = ["AIMAC_PROJECT_EVENT_IDEMPOTENCY_KEYS", "AIMAC_PROJECT_EVENT_KEY_FILE_CAP", "AIMAC_PROJECT_EVENT_KEY_GC_STRIDE"];
          const gcPrev = Object.fromEntries(gcEnvKeys.map((key) => [key, process.env[key]]));
          try {
            process.env.AIMAC_PROJECT_EVENT_IDEMPOTENCY_KEYS = "50";
            process.env.AIMAC_PROJECT_EVENT_KEY_FILE_CAP = "100";
            process.env.AIMAC_PROJECT_EVENT_KEY_GC_STRIDE = "10";
            for (let index = 1; index <= 130; index += 1) {
              appendProjectExecutionEvent(gcRuntimeDir, {...event, projectId: "prj_gc", eventId: `evt_gc_${index}`, eventKey: `gc-${index}`, sequence: 1});
            }
            const gcDir = join(gcRuntimeDir, "project-db", "event-keys", safeProjectIdForContract("prj_gc"));
            const gcFiles = readdirSync(gcDir).filter((name) => name.endsWith(".json"));
            if (gcFiles.length !== 100) output.push(`event-key KV GC did not bound key files to the cap (got ${gcFiles.length})`);
            const gcDedup = appendProjectExecutionEvent(gcRuntimeDir, {...event, projectId: "prj_gc", eventId: "evt_gc_dup", eventKey: "gc-130", sequence: 1});
            if (!gcDedup.duplicate) output.push("event-key KV GC dropped a recent key still needed for dedup");
          } finally {
            for (const key of gcEnvKeys) {
              if (gcPrev[key] === undefined) delete process.env[key];
              else process.env[key] = gcPrev[key];
            }
            rmSync(gcRuntimeDir, {recursive: true, force: true});
          }
			      const firstStorage = appendProjectExecutionEvent(eventRuntimeDir, {...event, eventId: "evt_collision_a", eventKey: "collision-a", projectId: "project/a", sequence: 1});
      const secondStorage = appendProjectExecutionEvent(eventRuntimeDir, {...event, eventId: "evt_collision_b", eventKey: "collision-b", projectId: "project_a", sequence: 1});
      if (firstStorage.storageRef === secondStorage.storageRef) {
        output.push("Project-level execution event store collapsed sanitized project ids into the same file");
      }
	    } finally {
        if (previousSegmentSize === undefined) delete process.env.AIMAC_PROJECT_EVENT_SEGMENT_MAX_BYTES;
        else process.env.AIMAC_PROJECT_EVENT_SEGMENT_MAX_BYTES = previousSegmentSize;
	      rmSync(eventRuntimeDir, {recursive: true, force: true});
	    }
  }
  const claimedDispatchId = claimed.dispatch?.dispatch.dispatchId;
  if (claimedDispatchId) {
    const revokeRequest = requestAgentNodeRevocation(state, node, {ttlSeconds: 300}, {actor: "contract-check", idempotencyKey: "contract-node-revoke"});
    const pending = state.agentDispatches.find((dispatch) => dispatch.dispatchId === claimedDispatchId);
    if (!revokeRequest.pendingDispatchIds.includes(claimedDispatchId) || pending?.status !== "blocked" || pending.assignedNodeId !== node.nodeId || node.status !== "draining") {
      output.push("Agent node revocation request did not fence its running dispatch until runtime ACK");
    }
    if (state.mcpGrants.some((grant) => grant.agentNodeId === node.nodeId && grant.dispatchId === claimedDispatchId && grant.grantStatus === "issued")) {
      output.push("Agent node revocation request did not revoke dispatch-bound MCP grants before ACK");
    }
    ackAgentControlCommand(state, node, revokeRequest.command.commandId, {status: "completed", result: {stopped: true}});
    const requeued = state.agentDispatches.find((dispatch) => dispatch.dispatchId === claimedDispatchId);
    if (requeued?.status !== "queued" || requeued.assignedNodeId || node.status !== "revoked") {
      output.push("Agent node revocation ACK did not requeue its fenced dispatch and revoke the node");
    }
    const shutdownIssued = createAgentJoinToken(state, {projectId: "prj_control_plane", nodeName: "contract-shutdown-node", allowedRoles: ["*"]}, {publicUrl: "https://control.example.test"});
    registerAgentNode(state, {nodeName: "contract-shutdown-node", requestedRoles: ["*"], runtimeVersion: "contract", profile: {platform: "test", arch: "test", tools: [], models: [{providerClass: "custom", available: true}]}}, {joinToken: shutdownIssued.joinToken, publicUrl: "https://control.example.test"});
    const shutdownNode = state.agentRuntimeNodes.find((item) => item.nodeName === "contract-shutdown-node");
    selfCheckAgentNode(state, shutdownNode, {checks: [
      {checkId: "runtime", status: "ok"},
      {checkId: "gateway", status: "ok"},
      {checkId: "filesystem", status: "ok"},
      {checkId: "git", status: "ok"},
      {checkId: "remote_mcp", status: "ok"},
      {checkId: "model_executor", status: "ok"}
    ]});
    const shutdownClaim = claimNextDispatch(state, shutdownNode, {runtimeDir: join(root, ".runtime"), claimTtlSeconds: 300});
	    if (shutdownClaim.dispatch) {
	      const shutdownDispatchId = shutdownClaim.dispatch.dispatch.dispatchId;
	      const shutdownCommand = createAgentControlCommand(state, shutdownNode, {commandType: "shutdown"}, {actor: "contract-check", idempotencyKey: "contract-node-shutdown"}).command;
        const preAckShutdownDispatch = state.agentDispatches.find((dispatch) => dispatch.dispatchId === shutdownDispatchId);
        if (preAckShutdownDispatch?.status !== "blocked" || shutdownNode.status !== "draining" || state.mcpGrants.some((grant) => grant.agentNodeId === shutdownNode.nodeId && grant.dispatchId === shutdownDispatchId && grant.grantStatus === "issued")) {
          output.push("Agent shutdown command did not freeze dispatch and revoke MCP grants before runtime ACK");
        }
	      ackAgentControlCommand(state, shutdownNode, shutdownCommand.commandId, {status: "completed", result: {stopped: true}});
      const shutdownDispatch = state.agentDispatches.find((dispatch) => dispatch.dispatchId === shutdownDispatchId);
      if (shutdownNode.status !== "offline" || shutdownNode.admission !== "read_only" || shutdownDispatch?.status !== "queued" || shutdownDispatch.assignedNodeId) {
        output.push("Agent shutdown ACK did not offline the node and requeue active dispatches");
      }
    } else {
      output.push(`Agent shutdown contract could not claim a dispatch: ${shutdownClaim.reason || "unknown"}`);
    }
  }
}

// Gap #3: the Command / CommandEffect / DLQEntry lifecycle must be real, and the close-barrier
// command-effect / DLQ gates must actually bite. Prove both directions so neither gate is a new
// vacuous constant: an unreconciled effect (or active DLQ) blocks the close; reconciling the
// effect / clearing the DLQ un-blocks the corresponding gate.
function verifyCommandBusLifecycle(output) {
  const state = structuredClone(seedState);
  ensureRuntimeCollections(state, {root});
  const tgId = "tg_runtime_management";

  // Baseline: with no command effects and no DLQ entries, both gates pass (not vacuously false).
  const base = computeCloseBarrier(state, tgId, {mutate: false});
  if (base.gateResults.all_command_effects_terminal?.status !== "passed") {
    output.push("command-bus: baseline all_command_effects_terminal should pass with no effects");
  }
  if (base.gateResults.no_active_dlq?.status !== "passed") {
    output.push("command-bus: baseline no_active_dlq should pass with no DLQ entries");
  }

  // Happy path with no side effect: created -> admitted -> dispatched -> running -> succeeded.
  const cmd = createCommand(state, {type: "control_write", taskGroupId: tgId, subject: `TaskGroup:${tgId}`});
  if (cmd.status !== "admitted") output.push("command-bus: createCommand did not admit the command via policy-engine");
  dispatchCommand(state, cmd, {targetRef: "target:x"});
  if (cmd.status !== "dispatched") output.push("command-bus: dispatchCommand did not move admitted -> dispatched");
  markRunning(state, cmd, {});
  const done = succeedCommand(state, cmd, {resultRef: "result:x"});
  if (done.command.status !== "succeeded" || done.commandEffect) {
    output.push("command-bus: no-side-effect command should succeed without a CommandEffect");
  }

  // Side-effecting command records a CommandEffect and reconciles it to verified.
  const cmd2 = createCommand(state, {type: "repository_push", taskGroupId: tgId, subject: `TaskGroup:${tgId}`});
  dispatchCommand(state, cmd2, {});
  markRunning(state, cmd2, {});
  const sideDone = succeedCommand(state, cmd2, {resultRef: "result:y", sideEffect: {taskGroupId: tgId}});
  if (!sideDone.commandEffect || sideDone.commandEffect.status !== "verified") {
    output.push("command-bus: side-effect command did not record and reconcile a CommandEffect to verified");
  }
  if (computeCloseBarrier(state, tgId, {mutate: false}).gateResults.all_command_effects_terminal?.status !== "passed") {
    output.push("command-bus: a reconciled (verified) CommandEffect must not block the close barrier");
  }

  // Unreconciled effect must block the close-barrier command-effect gate.
  const cmd3 = createCommand(state, {type: "repository_push", taskGroupId: tgId, subject: `TaskGroup:${tgId}`});
  dispatchCommand(state, cmd3, {});
  markRunning(state, cmd3, {});
  const pending = recordCommandEffect(state, cmd3, {taskGroupId: tgId, autoReconcile: false});
  if (pending.status !== "prepared") output.push("command-bus: recordCommandEffect autoReconcile:false should leave effect prepared");
  const blocked = computeCloseBarrier(state, tgId, {mutate: false});
  if (blocked.gateResults.all_command_effects_terminal?.status !== "blocked") {
    output.push("command-bus: an unreconciled CommandEffect did not block all_command_effects_terminal");
  }
  if (!blocked.blockingObjects.some((item) => item.gate === "all_command_effects_terminal")) {
    output.push("command-bus: blocked close barrier did not list the command-effect gate as a blocker");
  }
  // Drive it through applied -> verifying -> verified and confirm the gate clears.
  applyCommandEffect(state, pending, {});
  verifyingCommandEffect(state, pending, {});
  verifyCommandEffect(state, pending, {});
  if (pending.status !== "verified") output.push("command-bus: manual CommandEffect reconciliation did not reach verified");
  if (computeCloseBarrier(state, tgId, {mutate: false}).gateResults.all_command_effects_terminal?.status !== "passed") {
    output.push("command-bus: reconciling the CommandEffect did not clear all_command_effects_terminal");
  }

  // Failed command exhausting attempts lands in the DLQ, which blocks no_active_dlq until resolved.
  const cmd4 = createCommand(state, {type: "repository_push", taskGroupId: tgId, subject: `TaskGroup:${tgId}`, maxAttempts: 1});
  dispatchCommand(state, cmd4, {});
  markRunning(state, cmd4, {});
  failCommand(state, cmd4, {failureRef: "failure:x"});
  if (cmd4.status !== "failed") output.push("command-bus: failCommand did not move running -> failed");
  const dlq = toDlq(state, cmd4, {reason: "max_attempts_exceeded"});
  if (cmd4.status !== "dlq" || dlq.dlqEntry.status !== "created") {
    output.push("command-bus: toDlq did not move the command to dlq and create a DLQ entry");
  }
  const dlqBlocked = computeCloseBarrier(state, tgId, {mutate: false});
  if (dlqBlocked.gateResults.no_active_dlq?.status !== "blocked") {
    output.push("command-bus: an active DLQ entry did not block no_active_dlq");
  }
  classifyDlqEntry(state, dlq.dlqEntry, {rootCauseHint: "flaky remote push"});
  assignDlqEntry(state, dlq.dlqEntry, {ownerRole: "release"});
  replayDlqEntry(state, dlq.dlqEntry, {});
  if (dlq.dlqEntry.status !== "replayed") output.push("command-bus: DLQ entry did not progress created -> classified -> assigned -> replayed");
  if (computeCloseBarrier(state, tgId, {mutate: false}).gateResults.no_active_dlq?.status !== "passed") {
    output.push("command-bus: replaying the DLQ entry did not clear no_active_dlq");
  }

  // Retry: a failed command within its attempt budget re-admits.
  const cmd5 = createCommand(state, {type: "repository_push", taskGroupId: tgId, subject: `TaskGroup:${tgId}`, maxAttempts: 3});
  dispatchCommand(state, cmd5, {});
  markRunning(state, cmd5, {});
  failCommand(state, cmd5, {failureRef: "failure:y"});
  const retried = retryCommand(state, cmd5, {});
  if (!retried || cmd5.status !== "admitted") {
    output.push("command-bus: retryCommand did not re-admit a failed command within its attempt budget");
  }

  // Sweeper: a running command past its timeoutAt is timed out on the maintenance cadence.
  const cmd6 = createCommand(state, {type: "repository_push", taskGroupId: tgId, subject: `TaskGroup:${tgId}`, timeoutAt: new Date(Date.now() - 1000).toISOString()});
  dispatchCommand(state, cmd6, {});
  markRunning(state, cmd6, {});
  sweepCommandBus(state);
  if (cmd6.status !== "timed_out") {
    output.push("command-bus: sweepCommandBus did not time out a running command past its timeoutAt");
  }
}

console.log("contract check ok");

function loadJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

// Extract the declared states of a state-machine from spec/state-machines.yaml without a YAML dependency.
function extractMachineStates(yamlText, machine) {
  const lines = yamlText.split(/\r?\n/);
  let index = lines.findIndex((line) => line === `  ${machine}:`);
  if (index < 0) return [];
  const states = [];
  let inStates = false;
  for (index += 1; index < lines.length; index++) {
    const line = lines[index];
    if (/^  \S/.test(line)) break; // next machine at 2-space indent
    if (/^    states:\s*$/.test(line)) { inStates = true; continue; }
    if (!inStates) continue;
    const item = line.match(/^      - "([^"]+)"\s*$/);
    if (item) { states.push(item[1]); continue; }
    if (/^    \S/.test(line)) break; // next key (e.g. transitions:)
  }
  return states;
}

// Gap #4: WorkItem/WorkSession status must stay within the legal state-machine enums; there is no
// "blocked"/"monitor_attention" state. Also confirm the converged blocked enums are recognized by
// the derived blockers/counters logic.
function verifyWorkStatusEnumConvergence(output) {
  const smText = readFileSync(resolve(root, "spec/state-machines.yaml"), "utf8");
  const workItemSet = new Set(extractMachineStates(smText, "WorkItem"));
  const workSessionSet = new Set(extractMachineStates(smText, "WorkSession"));
  if (workItemSet.size === 0 || workSessionSet.size === 0) {
    output.push("state-machines: failed to extract WorkItem/WorkSession states");
    return;
  }
  for (const illegal of ["blocked"]) {
    if (workItemSet.has(illegal)) output.push(`state-machines WorkItem must not contain '${illegal}'`);
  }
  for (const illegal of ["blocked", "monitor_attention"]) {
    if (workSessionSet.has(illegal)) output.push(`state-machines WorkSession must not contain '${illegal}'`);
  }
  const blockedWorkItemStatuses = ["blocked_dependency", "blocked_resource", "permission_required", "needs_decision", "stale_state"];
  for (const status of blockedWorkItemStatuses) {
    if (!workItemSet.has(status)) output.push(`state-machines WorkItem missing expected enum ${status}`);
  }

  for (const taskGroup of seedState.taskGroups || []) {
    for (const workItem of taskGroup.workItems || []) {
      if (!workItemSet.has(workItem.status)) {
        output.push(`seed WorkItem ${taskGroup.id}/${workItem.id} has illegal status "${workItem.status}"`);
      }
    }
  }
  for (const session of seedState.workSessions || []) {
    if (!workSessionSet.has(session.status)) {
      output.push(`seed WorkSession ${session.sessionId} has illegal status "${session.status}"`);
    }
  }

  // Blocked-work-item scenario: every converged blocked enum must be surfaced by readiness/blockers.
  const scenario = {
    projects: [{id: "project/enum-check", status: "development", progress: {}}],
    taskGroups: [{
      id: "tg/enum-check",
      projectId: "project/enum-check",
      status: "development",
      health: "ok",
      roles: [],
      workItems: [
        {id: "wi-active", title: "active", status: "in_progress", progress: 40},
        ...blockedWorkItemStatuses.map((status) => ({id: `wi-${status}`, title: status, status, blockedReason: `${status}_reason`, progress: 0}))
      ]
    }],
    repositoryOutputs: [],
    workSessions: [],
    progressSnapshots: []
  };
  const snapshots = computeProgressSnapshots(scenario);
  const tgSnapshot = snapshots.find((snapshot) => snapshot.scopeType === "task_group" && snapshot.scopeRef === "tg/enum-check");
  if (!tgSnapshot) {
    output.push("enum-check: task group progress snapshot missing");
    return;
  }
  for (const status of blockedWorkItemStatuses) {
    if (!tgSnapshot.blockers.includes(`wi-${status}`)) {
      output.push(`enum-check: blockers did not identify WorkItem in status ${status}`);
    }
  }
  if (tgSnapshot.counters.blocked !== blockedWorkItemStatuses.length) {
    output.push(`enum-check: counters.blocked ${tgSnapshot.counters.blocked} != ${blockedWorkItemStatuses.length}`);
  }
}

// Gap #1: the runtime gate/transition resolution engine must accept spec-modeled transitions
// and fail-closed on illegal ones (wrong from-state, unauthorized actor, missing requires
// evidence, and unresolvable gates) with the correct typed failureCode.
function verifyTransitionEngine(output) {
  const expectRejected = (label, expectedCode, fn) => {
    let error;
    try {
      fn();
    } catch (caught) {
      error = caught;
    }
    if (!error) {
      output.push(`transition-engine: expected rejection for ${label}`);
      return;
    }
    const code = error.failureCode || error.code;
    if (code !== expectedCode) {
      output.push(`transition-engine: ${label} rejected with ${code}, expected ${expectedCode}`);
    }
  };

  // Reader must yield the same machine/gate shapes validate-specs parses.
  const machines = loadStateMachines().machines;
  const catalog = loadGateCatalog();
  if (!machines.WorkItem || !Array.isArray(catalog.resolvers) || !catalog.resolvers.length) {
    output.push("transition-engine: failed to load state machines / gate catalog");
    return;
  }

  // Legal, fully-evidenced transition must pass.
  const legalEvidence = {
    task_contract_created: "contract:x",
    effective_instruction_packet_ref: "eip:x",
    repository_output_target_ref: "rot:x",
    shared_definition_refs_resolved: "none_resolved",
    task_draft_review_passed: "review:x",
    split_basis_digest: "sha256:x",
    quality_surface_plan_ref: "qs:x"
  };
  try {
    assertTransition({}, "WorkItem", "draft", "ready", "orchestrator", legalEvidence);
  } catch (error) {
    output.push(`transition-engine: legal draft->ready rejected: ${error.failureCode || error.code}`);
  }

  // Gate resolution: exact ids win over patterns; unknown gates fail closed.
  if (resolveGate("checkpoint", catalog).id !== "checkpoint_literal") {
    output.push("transition-engine: exact-id gate 'checkpoint' did not resolve to checkpoint_literal");
  }
  if (resolveGate("some_target_ref", catalog).id !== "reference_exists") {
    output.push("transition-engine: pattern gate '*_ref' did not resolve to reference_exists");
  }
  expectRejected("unknown gate resolution", "gate.unresolved", () => resolveGate("no_such_gate_zzz", catalog));

  // Illegal transitions must be rejected with typed failure codes.
  expectRejected("wrong from-state", "transition.not_modeled", () =>
    assertTransition({}, "WorkItem", "assigned", "ready", "orchestrator", { dependency_resolved: "x" })
  );
  expectRejected("unauthorized actor", "transition.actor_not_authorized", () =>
    assertTransition({}, "WorkItem", "draft", "ready", "scheduler", legalEvidence)
  );
  // Absorbed from MGP core-init: transitions are NOT gated on ceremonial "evidence" token presence
  // (the caller always synthesizes them). A legal transition with NO evidence values must succeed;
  // real evidence is validated at the producing boundary (acceptAgentCheckpoint), not here.
  try {
    assertTransition({}, "WorkItem", "draft", "ready", "orchestrator", {});
  } catch (error) {
    output.push(`transition-engine: legal draft->ready rejected for empty evidence (should be de-ceremonied): ${error.failureCode || error.code}`);
  }
  // But an unmodeled/unresolved required gate id is still a spec-integrity failure.
  expectRejected("unresolved required gate id", "gate.unresolved", () => resolveGate("no_such_gate_zzz", catalog));
  expectRejected("unknown machine", "transition.unknown_machine", () =>
    assertTransition({}, "NoSuchMachine", "a", "b", "orchestrator", {})
  );

  // Forced-strict recordTransition path (via a real orchestration flow) must reject an illegal
  // transition. buildTaskContract + dispatch drives legal transitions; here we prove the guard
  // fires by asserting a deliberately illegal actor for a real modeled edge.
  expectRejected("blocked_resource->ready by orchestrator (illegal actor)", "transition.actor_not_authorized", () =>
    assertTransition({}, "WorkItem", "blocked_resource", "ready", "orchestrator", { resource_available: "x" })
  );
}

// Resolve a JSON-Pointer $ref (#/$defs/...) against the schema document root. Only local pointers are
// supported; external file refs are handled by the caller (language-policy).
function resolveInternalRef(ref, root) {
  const parts = ref.slice(2).split("/");
  let node = root;
  for (const part of parts) {
    if (node == null || typeof node !== "object") return null;
    node = node[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return node && typeof node === "object" ? node : null;
}

// True iff `value` satisfies `schema` with zero errors — used to evaluate if/then/else, not, any/oneOf.
function schemaMatches(value, schema, root, depth) {
  const scratch = [];
  validateSchema(value, schema, "", scratch, root, depth);
  return scratch.length === 0;
}

// A pragmatic JSON-Schema subset validator. Supports const/enum/type/minLength/minimum, array
// items/minItems/uniqueItems/contains, object required/properties/additionalProperties, the
// combinators allOf/anyOf/oneOf/if-then-else/not, and local $ref (#/$defs/...). This breadth matters:
// the conditional guarantees (e.g. a subagent placement REQUIRING subagentSafetyProof with every safety
// flag true, or CloseBarrier.satisfied implying all gates passed) live in allOf/if/then/$ref — a
// validator that skipped those keywords validated nothing and let a regressed producer pass silently.
function validateSchema(value, schema, path, output, root, depth = 0) {
  if (!schema || typeof schema !== "object") return;
  if (root === undefined) root = schema;
  // A $ref is the only unbounded-recursion vector; bound the follow depth so a (mistakenly) self- or
  // cyclically-referential schema fails loudly instead of hanging the gate.
  if (depth > 256) { output.push(`${path} $ref recursion too deep (possible schema cycle)`); return; }
  if (schema.$ref !== undefined) {
    if (schema.$ref.startsWith("#/")) {
      const resolved = resolveInternalRef(schema.$ref, root);
      // Unresolvable local $ref must ERROR, not silently pass — a typo'd pointer would otherwise validate
      // nothing (re-introducing the vacuous-gate class this validator was completed to prevent).
      if (resolved) validateSchema(value, resolved, path, output, root, depth + 1);
      else output.push(`${path} unresolved local $ref ${schema.$ref}`);
      return;
    }
    if (schema.$ref === "language-policy.schema.json") { validateSchema(value, languagePolicySchema, path, output, languagePolicySchema, depth + 1); return; }
    return; // unknown external ref: not resolvable here, skip
  }
  if (schema.const !== undefined && value !== schema.const) output.push(`${path} expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  if (schema.enum && !schema.enum.includes(value)) output.push(`${path} expected enum ${schema.enum.join("|")}, got ${JSON.stringify(value)}`);
  if (schema.type) validateType(value, schema.type, path, output);
  if (schema.type === "string" && schema.minLength && String(value || "").length < schema.minLength) output.push(`${path} expected minLength ${schema.minLength}`);
  if ((schema.type === "integer" || schema.type === "number") && schema.minimum !== undefined && Number(value) < schema.minimum) output.push(`${path} expected minimum ${schema.minimum}`);
  // Array keywords apply to any array instance (not gated on a declared type — the `contains` subschema
  // under the placement `not` clause declares no type).
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) output.push(`${path} expected minItems ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) output.push(`${path} expected maxItems ${schema.maxItems}, got ${value.length}`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) output.push(`${path} expected uniqueItems`);
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`, output, root, depth));
    if (schema.contains && !value.some((item) => schemaMatches(item, schema.contains, root, depth))) output.push(`${path} expected at least one item matching contains`);
  }
  // Object keywords apply to any object instance (an if/then subschema carries required/properties with
  // no declared type; gating on schema.type==="object" would make every if-condition vacuously match).
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (value[key] === undefined) output.push(`${path}.${key} is required`);
    }
    const properties = schema.properties || {};
    const patternProperties = schema.patternProperties || {};
    const patternRegexes = Object.keys(patternProperties).map((pattern) => new RegExp(pattern));
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        const known = Object.prototype.hasOwnProperty.call(properties, key) || patternRegexes.some((re) => re.test(key));
        if (!known) output.push(`${path}.${key} is not allowed by schema`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (value[key] !== undefined) validateSchema(value[key], childSchema, `${path}.${key}`, output, root, depth);
    }
    for (const [pattern, childSchema] of Object.entries(patternProperties)) {
      const re = new RegExp(pattern);
      for (const key of Object.keys(value)) {
        if (re.test(key)) validateSchema(value[key], childSchema, `${path}.${key}`, output, root, depth);
      }
    }
  }
  if (Array.isArray(schema.allOf)) schema.allOf.forEach((sub, index) => validateSchema(value, sub, `${path}/allOf[${index}]`, output, root, depth));
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((sub) => schemaMatches(value, sub, root, depth))) output.push(`${path} matched no anyOf branch`);
  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter((sub) => schemaMatches(value, sub, root, depth)).length;
    if (matched !== 1) output.push(`${path} expected exactly one oneOf match, got ${matched}`);
  }
  if (schema.if) {
    if (schemaMatches(value, schema.if, root, depth)) { if (schema.then) validateSchema(value, schema.then, path, output, root, depth); }
    else if (schema.else) validateSchema(value, schema.else, path, output, root, depth);
  }
  if (schema.not && schemaMatches(value, schema.not, root, depth)) output.push(`${path} must not match the not-subschema`);
}

function validateType(value, type, path, output) {
  if (type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) output.push(`${path} expected object`);
  if (type === "array" && !Array.isArray(value)) output.push(`${path} expected array`);
  if (type === "string" && typeof value !== "string") output.push(`${path} expected string`);
  if (type === "boolean" && typeof value !== "boolean") output.push(`${path} expected boolean`);
  if (type === "integer" && !Number.isInteger(value)) output.push(`${path} expected integer`);
  if (type === "number" && typeof value !== "number") output.push(`${path} expected number`);
}

function safeProjectIdForContract(projectId) {
  return `p_${createHash("sha256").update(String(projectId || "unknown")).digest("hex").slice(0, 24)}`;
}
