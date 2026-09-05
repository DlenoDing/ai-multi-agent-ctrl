(function initOperationalStats(global) {
  "use strict";
  let cachedState = null;
  let cachedIndex = null;

  function indexFor(state, terminalStatuses) {
    if (cachedState === state && cachedIndex) return cachedIndex;
    const runs = new Map();
    const blockedRuns = new Map();
    const reviews = new Map();
    const bump = (map, id) => { if (id) map.set(id, Number(map.get(id) || 0) + 1); };
    for (const dispatch of state.agentDispatches || []) {
      if (!terminalStatuses.has(dispatch.status)) bump(runs, dispatch.taskGroupId);
      if (dispatch.status === "blocked") bump(blockedRuns, dispatch.taskGroupId);
    }
    for (const item of [...(state.humanConfirmationRequests || []), ...(state.permissionRequests || []), ...(state.approvalRequests || [])]) {
      if (["pending", "requested", "pending_approval"].includes(item.status)) bump(reviews, item.taskGroupId);
    }
    cachedState = state;
    cachedIndex = {runs, blockedRuns, reviews};
    return cachedIndex;
  }

  function forGroup(state, group, {terminalStatuses, detail} = {}) {
    if (!group) return {tasks: 0, runs: 0, reviews: 0, blocked: 0};
    const taskItems = detail?.taskGroupId === group.id && detail?.progress?.workItems
      ? detail.progress.workItems : group.workItems || [];
    const indexed = indexFor(state, terminalStatuses);
    const blockedWork = taskItems.filter((item) => item.blockedReason || String(item.status || "").startsWith("blocked")).length;
    return {
      tasks: group.workItemCount ?? taskItems.length,
      runs: Number(indexed.runs.get(group.id) || 0),
      reviews: Number(indexed.reviews.get(group.id) || 0),
      blocked: Number(group.blockerCount ?? group.blockers?.length ?? 0) + blockedWork + Number(indexed.blockedRuns.get(group.id) || 0)
    };
  }

  global.AIMAC_OPERATIONAL_STATS = {indexFor, forGroup};
})(window);
