const TERMINAL_DISPATCH = new Set(["completed", "failed", "cancelled", "rejected", "expired"]);

function newest(items, limit) {
  return items.slice().sort((left, right) =>
    String(right?.updatedAt || right?.createdAt || "").localeCompare(String(left?.updatedAt || left?.createdAt || "")))
    .slice(0, limit);
}

function publicDispatch(dispatch, group, work) {
  return {
    dispatchId: dispatch.dispatchId,
    projectId: dispatch.projectId,
    taskGroupId: dispatch.taskGroupId,
    taskGroupName: group?.name || null,
    workItemId: dispatch.workItemId,
    workItemTitle: work?.title || null,
    sessionId: dispatch.sessionId,
    roleId: dispatch.roleId || work?.ownerRole || null,
    model: dispatch.model || null,
    reasoning: dispatch.reasoning || null,
    status: dispatch.status,
    progressPercent: dispatch.progressPercent ?? null,
    blockedReason: dispatch.blockedReason || null,
    failureReason: dispatch.failureReason || null,
    lastExecutionEventAt: dispatch.lastExecutionEventAt || null,
    createdAt: dispatch.createdAt || null,
    updatedAt: dispatch.updatedAt || null
  };
}

function publicCommand(command) {
  return {
    commandId: command.commandId || null,
    sequence: command.sequence ?? null,
    nodeId: command.nodeId,
    projectId: command.projectId || null,
    taskGroupId: command.taskGroupId || null,
    dispatchId: command.dispatchId || null,
    sessionId: command.sessionId || null,
    commandType: command.commandType,
    status: command.status,
    ackResult: command.ackResult ? {status: command.ackResult.status || null, reason: command.ackResult.reason || null} : null,
    createdAt: command.createdAt || null,
    updatedAt: command.updatedAt || null
  };
}

function publicEvent(event) {
  return {
    eventId: event.eventId,
    sequence: event.sequence,
    dispatchId: event.dispatchId || null,
    sessionId: event.sessionId || null,
    projectId: event.projectId || null,
    taskGroupId: event.taskGroupId || null,
    workItemId: event.workItemId || null,
    eventType: event.eventType,
    status: event.status,
    progressPercent: event.progressPercent ?? null,
    summary: event.summary || null,
    evidenceRefs: (event.evidenceRefs || []).slice(0, 40),
    createdAt: event.createdAt || null
  };
}

function publicAgent(agent) {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    model: agent.model,
    status: agent.status,
    projectId: agent.projectId || null,
    organizationId: agent.organizationId || null,
    roleSkillRef: agent.roleSkillRef || null,
    trustScore: agent.trustScore ?? null
  };
}

export function buildRuntimeNodeDetail(state, node, {publicNode, projectId = ""} = {}) {
  const groupById = new Map((state.taskGroups || []).map((group) => [group.id, group]));
  const inProject = (item) => !projectId || item.projectId === projectId || groupById.get(item.taskGroupId)?.projectId === projectId;
  const assigned = (state.agentDispatches || []).filter((dispatch) => dispatch.assignedNodeId === node.nodeId && inProject(dispatch));
  const dispatches = newest(assigned, 50).map((dispatch) => {
    const group = groupById.get(dispatch.taskGroupId);
    const work = (group?.workItems || []).find((item) => item.id === dispatch.workItemId);
    return publicDispatch(dispatch, group, work);
  });
  const visibleProjectIds = new Set(projectId ? [projectId] : (publicNode.effectiveProjectIds || publicNode.projectIds || []));
  const allowedRoles = new Set(publicNode.allowedRoles || []);
  const agentProfiles = (state.agents || []).filter((agent) => {
    if (agent.status !== "active") return false;
    if (!allowedRoles.has("*") && !allowedRoles.has(agent.role)) return false;
    if (agent.projectId) return visibleProjectIds.has(agent.projectId);
    return (agent.organizationId || "org_default") === (node.organizationId || "org_default");
  }).map(publicAgent).slice(0, 100);
  return {
    schemaVersion: "runtime-node-detail/v1",
    node: publicNode,
    projectId: projectId || null,
    scope: publicNode.registrationScope === "organization"
      ? {type: "organization", id: publicNode.organizationId || node.organizationId || null}
      : {type: "project", ids: (publicNode.projectIds || []).slice(0, 100)},
    activeDispatches: dispatches.filter((dispatch) => !TERMINAL_DISPATCH.has(dispatch.status)),
    recentDispatches: dispatches,
    assignedDispatchCount: assigned.length,
    controlCommands: newest((state.agentControlCommands || []).filter((command) => command.nodeId === node.nodeId && inProject(command)), 50).map(publicCommand),
    recentEvents: newest((state.agentExecutionEvents || []).filter((event) => event.nodeId === node.nodeId && inProject(event)), 100).map(publicEvent),
    agentProfiles
  };
}
