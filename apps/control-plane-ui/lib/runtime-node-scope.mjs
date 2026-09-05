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

export function runtimeNodeVisibleForProjectSet(state, node = {}, projectIdSet = new Set()) {
  if (!projectIdSet || !projectIdSet.size) return false;
  return runtimeNodeProjectIds(state, node).some((projectId) => projectIdSet.has(projectId));
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
