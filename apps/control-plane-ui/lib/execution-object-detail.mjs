const SESSION_SETTLED = new Set(["completed", "completed_objective", "failed", "cancelled", "aborted", "recycled", "closed"]);
const DISPATCH_SETTLED = new Set(["completed", "failed", "cancelled", "rejected", "expired"]);

function newest(items, limit, timeKey = "updatedAt") {
  return items.slice().sort((left, right) =>
    String(right?.[timeKey] || right?.createdAt || "").localeCompare(String(left?.[timeKey] || left?.createdAt || "")))
    .slice(0, limit);
}

function publicAgent(agent) {
  if (!agent) return null;
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    model: agent.model,
    status: agent.status,
    trustScore: agent.trustScore,
    capacity: agent.capacity,
    roleSkillRef: agent.roleSkillRef || null,
    organizationId: agent.organizationId || null,
    projectId: agent.projectId || null,
    createdAt: agent.createdAt || null,
    updatedAt: agent.updatedAt || null
  };
}

function publicModelDecision(decision) {
  if (!decision) return null;
  return {
    decisionId: decision.decisionId,
    projectId: decision.projectId,
    taskGroupId: decision.taskGroupId,
    workItemId: decision.workItemId,
    roleId: decision.roleId,
    selectedAgentId: decision.selectedAgentId || null,
    agentModelPreference: decision.agentModelPreference || null,
    roleSkillRef: decision.roleSkillRef || null,
    roleSkillAssignmentSource: decision.roleSkillAssignmentSource || null,
    selectionMode: decision.selectionMode || null,
    taskExecutionClass: decision.taskExecutionClass || null,
    selectedModel: decision.selectedModel || null,
    modelDecision: decision.modelDecision || null,
    status: decision.status,
    createdAt: decision.createdAt || null,
    updatedAt: decision.updatedAt || null
  };
}

function publicPlacementDecision(decision) {
  if (!decision) return null;
  return {
    decisionId: decision.decisionId,
    projectId: decision.projectId,
    taskGroupId: decision.taskGroupId,
    workItemId: decision.workItemId,
    placement: decision.placement,
    status: decision.status,
    workerCarrierDecision: decision.workerCarrierDecision ? {
      carrier: decision.workerCarrierDecision.carrier || null,
      mode: decision.workerCarrierDecision.mode || null,
      roleId: decision.workerCarrierDecision.roleId || null,
      laneFunction: decision.workerCarrierDecision.laneFunction || null,
      laneId: decision.workerCarrierDecision.laneId || null,
      acquireMode: decision.workerCarrierDecision.acquireMode || null,
      reuseGeneration: decision.workerCarrierDecision.reuseGeneration ?? null
    } : null,
    createdAt: decision.createdAt || null,
    updatedAt: decision.updatedAt || null
  };
}

function publicWorkItem(workItem) {
  if (!workItem) return null;
  return {
    id: workItem.id,
    title: workItem.title,
    status: workItem.status,
    ownerRole: workItem.ownerRole,
    progress: workItem.progress,
    blockedReason: workItem.blockedReason || null,
    createdAt: workItem.createdAt || null,
    updatedAt: workItem.updatedAt || null
  };
}

export function findExecutionObject(state, type, id) {
  if (type === "session") return (state.workSessions || []).find((item) => item.sessionId === id) || null;
  if (type === "dispatch") return (state.agentDispatches || []).find((item) => item.dispatchId === id) || null;
  return null;
}

export function buildExecutionObjectDetail(state, {type, id, taskGroupSummary, publicNode, contractSummary}) {
  const target = findExecutionObject(state, type, id);
  if (!target) return null;
  const session = type === "session" ? target
    : (state.workSessions || []).find((item) => item.sessionId === target.sessionId) || null;
  const relatedDispatches = (state.agentDispatches || []).filter((item) =>
    type === "dispatch" ? item.dispatchId === target.dispatchId : item.sessionId === target.sessionId);
  const primaryDispatch = type === "dispatch" ? target : relatedDispatches.find((item) => !DISPATCH_SETTLED.has(item.status)) || relatedDispatches[0] || null;
  const taskGroupId = target.taskGroupId || session?.taskGroupId || primaryDispatch?.taskGroupId;
  const taskGroup = (state.taskGroups || []).find((item) => item.id === taskGroupId) || null;
  const workItemId = target.workItemId || session?.workItemId || primaryDispatch?.workItemId;
  const workItem = (taskGroup?.workItems || []).find((item) => item.id === workItemId) || null;
  const decisionRef = primaryDispatch?.modelSelectionDecisionRef || session?.modelSelectionDecisionRef;
  const placementRef = session?.placementDecisionRef;
  const modelDecision = (state.modelSelectionDecisions || []).find((item) => item.decisionId === decisionRef)
    || (state.modelSelectionDecisions || []).find((item) => item.taskGroupId === taskGroupId && item.workItemId === workItemId) || null;
  const placementDecision = (state.sessionPlacementDecisions || []).find((item) => item.decisionId === placementRef)
    || (state.sessionPlacementDecisions || []).find((item) => item.taskGroupId === taskGroupId && item.workItemId === workItemId) || null;
  const agentId = session?.agentId || modelDecision?.selectedAgentId;
  const agent = (state.agents || []).find((item) => item.id === agentId) || null;
  const nodeId = primaryDispatch?.assignedNodeId || null;
  const node = nodeId ? (state.agentRuntimeNodes || []).find((item) => item.nodeId === nodeId) : null;
  const dispatchIds = new Set(relatedDispatches.map((item) => item.dispatchId));
  const runIds = new Set(relatedDispatches.map((item) => item.runId).filter(Boolean));
  const controlCommands = newest((state.agentControlCommands || []).filter((item) =>
    dispatchIds.has(item.dispatchId) || item.sessionId === session?.sessionId), 50);
  const checkpoints = newest((state.checkpoints || []).filter((item) =>
    item.taskGroupId === taskGroupId && (runIds.has(item.runId) || item.sessionId === session?.sessionId
      || item.workId === workItemId)), 20, "createdAt");
  const qualityGates = newest((state.qualityGates || []).filter((item) =>
    item.taskGroupId === taskGroupId && (!item.workItemId || item.workItemId === workItemId)), 20);
  const testResults = newest((state.testResults || []).filter((item) =>
    item.taskGroupId === taskGroupId && (!item.workItemId || item.workItemId === workItemId)), 20);
  const repositoryOutput = (state.repositoryOutputs || []).find((item) =>
    item.targetId === primaryDispatch?.repositoryOutputTargetRef)
    || (state.repositoryOutputs || []).find((item) => item.taskGroupId === taskGroupId && item.workItemId === workItemId) || null;

  return {
    schemaVersion: "execution-object-detail/v1",
    objectType: type,
    objectId: id,
    projectId: target.projectId || taskGroup?.projectId || null,
    taskGroup: taskGroup ? taskGroupSummary(taskGroup) : null,
    workItem: publicWorkItem(workItem),
    session,
    dispatch: primaryDispatch,
    relatedDispatches: newest(relatedDispatches, 50),
    relatedDispatchCount: relatedDispatches.length,
    agent: publicAgent(agent),
    node: node ? publicNode(node) : null,
    modelDecision: publicModelDecision(modelDecision),
    placementDecision: publicPlacementDecision(placementDecision),
    contractSummary: primaryDispatch ? contractSummary(state, primaryDispatch) : null,
    repositoryOutput,
    controlCommands,
    checkpoints,
    qualityGates,
    testResults,
    settled: type === "session" ? SESSION_SETTLED.has(target.status) : DISPATCH_SETTLED.has(target.status)
  };
}
