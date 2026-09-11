export const DEFAULT_NODE_ORGANIZATION_ID = "org_default";
export const REGISTRATION_SCOPES = Object.freeze(["project", "organization"]);

export function normalizeRegistrationScope(value, fallback = "project") {
  const normalized = String(value || fallback || "project").trim().toLowerCase();
  if (normalized === "org") return "organization";
  return REGISTRATION_SCOPES.includes(normalized) ? normalized : null;
}

export function uniqueProjectIds(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean))];
}

export function activeProjectIdsForOrganization(state, organizationId) {
  const orgId = String(organizationId || DEFAULT_NODE_ORGANIZATION_ID).trim() || DEFAULT_NODE_ORGANIZATION_ID;
  return uniqueProjectIds((state.projects || [])
    .filter((project) => (project.organizationId || DEFAULT_NODE_ORGANIZATION_ID) === orgId)
    .filter((project) => (project.status || "active") === "active")
    .map((project) => project.id));
}

export function runtimeNodeRegistrationScope(node = {}) {
  return normalizeRegistrationScope(node.registrationScope || node.scope, "project") || "project";
}

export function runtimeNodeScope(state, node = {}) {
  const registrationScope = runtimeNodeRegistrationScope(node);
  const organizationId = String(node.organizationId || DEFAULT_NODE_ORGANIZATION_ID).trim() || DEFAULT_NODE_ORGANIZATION_ID;
  const storedProjectIds = uniqueProjectIds(node.projectIds);
  const projectIds = registrationScope === "organization"
    ? activeProjectIdsForOrganization(state, organizationId)
    : storedProjectIds.filter((projectId) => {
      const project = (state.projects || []).find((item) => item.id === projectId);
      if (!project) return false;
      return (project.status || "active") === "active"
        && (project.organizationId || DEFAULT_NODE_ORGANIZATION_ID) === organizationId;
    });
  return {
    registrationScope,
    organizationId,
    storedProjectIds,
    projectIds,
    projectIdSet: new Set(projectIds)
  };
}

export function runtimeNodeProjectIds(state, node = {}) {
  return runtimeNodeScope(state, node).projectIds;
}

export function runtimeNodeCanAccessProject(state, node = {}, projectId) {
  return runtimeNodeScope(state, node).projectIdSet.has(projectId);
}

// 项目归档后它名下的节点【可见性】不能跟着消失：原先 projectIds 只留 active 项目，节点从组织与项目的节点列表里
// 一起不见了，只剩配额里的一个数 —— 管理员既吊销不了也不知道它在哪（09-12 收尾链路走查）。
// 可见按【登记过的项目】算（含已归档），可调度仍按 active 项目算（runtimeNodeCanAccessProject 不变）。
export function runtimeNodeVisibleForProjectSet(state, node = {}, projectIdSet = new Set()) {
  if (!projectIdSet || !projectIdSet.size) return false;
  const scope = runtimeNodeScope(state, node);
  const visibleProjectIds = scope.registrationScope === "organization"
    ? scope.projectIds
    : [...new Set([...scope.projectIds, ...runtimeNodeArchivedProjectIds(state, node)])];
  return visibleProjectIds.some((projectId) => projectIdSet.has(projectId));
}

// 节点登记过、但已归档的项目（只对项目专属节点有意义；组织共享节点跟着组织的在用项目走）。
export function runtimeNodeArchivedProjectIds(state, node = {}) {
  const scope = runtimeNodeScope(state, node);
  if (scope.registrationScope === "organization") return [];
  return scope.storedProjectIds.filter((projectId) => {
    const project = (state.projects || []).find((item) => item.id === projectId);
    return project && project.status === "archived"
      && (project.organizationId || DEFAULT_NODE_ORGANIZATION_ID) === scope.organizationId;
  });
}

export function agentRegistrationResourceScope(recordOrNode = {}) {
  const registrationScope = runtimeNodeRegistrationScope(recordOrNode);
  if (registrationScope === "organization") {
    return {
      resourceType: "organization",
      resourceId: recordOrNode.organizationId || DEFAULT_NODE_ORGANIZATION_ID
    };
  }
  return {
    resourceType: "project",
    resourceId: uniqueProjectIds(recordOrNode.projectIds)[0] || recordOrNode.projectId || null
  };
}
