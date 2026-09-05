(function initWorkspaceRoute(global) {
  "use strict";
  const PAGE_SEGMENTS = {
    "proj-overview": "overview",
    "proj-members": "members",
    "proj-agents": "agents",
    tg: "task-groups",
    tasks: "tasks",
    monitor: "monitor",
    review: "review",
    directives: "directives",
    "proj-settings": "settings"
  };
  const SEGMENT_PAGES = Object.fromEntries(Object.entries(PAGE_SEGMENTS).map(([page, segment]) => [segment, page]));

  function safePart(value) {
    try {
      const decoded = decodeURIComponent(String(value || ""));
      return decoded.length <= 256 && /^[A-Za-z0-9._:-]+$/u.test(decoded) ? decoded : "";
    } catch { return ""; }
  }

  function queryValue(query, key) {
    for (const part of String(query || "").split("&")) {
      const [name, value = ""] = part.split("=");
      if (name === key) return safePart(value);
    }
    return "";
  }

  function parse(hash = global.location?.hash || "") {
    if (!String(hash).startsWith("#/")) return null;
    const [rawPath, rawQuery = ""] = String(hash).slice(2).split("?");
    const parts = rawPath.split("/").filter(Boolean).map(safePart);
    if (!parts.length || parts.some((part) => !part)) return null;
    const workspace = queryValue(rawQuery, "pane");
    if (parts[0] === "system") {
      if (parts[1] === "organizations") return {page: "sys-orgs", organizationId: parts[2] || "", workspace: workspace || "list"};
      if (parts[1] === "settings") return {page: "sys-settings", workspace: workspace || "runtime"};
      return {page: "sys-overview", workspace: workspace || "overview"};
    }
    if (parts[0] === "organization") {
      if (parts[1] === "members") return {page: "org-members", accountId: parts[2] || "", workspace: workspace || "list"};
      if (parts[1] === "agents") return {page: "org-agents", workspace: workspace || "nodes"};
      if (parts[1] === "projects") return {page: "org-projects", workspace: workspace || "list"};
      return {page: "org-overview", workspace: workspace || "overview"};
    }
    if (parts[0] === "project" && !parts[1]) return {page: "proj-overview", projectId: "", workspace: "overview"};
    if (parts[0] !== "project" || !parts[1]) return null;
    const projectId = parts[1];
    const segment = parts[2] || "overview";
    const page = SEGMENT_PAGES[segment];
    if (!page) return null;
    const route = {page, projectId, workspace};
    if (["task-groups", "tasks", "monitor", "review", "directives"].includes(segment)) route.groupId = parts[3] || "";
    if (segment === "tasks") route.workId = parts[4] || "";
    if (segment === "directives") route.workId = parts[4] || "";
    if (segment === "members") route.accountId = parts[3] || "";
    return route;
  }

  function encoded(value) {
    return encodeURIComponent(String(value || ""));
  }

  function build(route = {}) {
    const pane = route.workspace ? `?pane=${encoded(route.workspace)}` : "";
    if (route.page === "sys-orgs") return `#/system/organizations${route.organizationId ? `/${encoded(route.organizationId)}` : ""}${pane}`;
    if (route.page === "sys-settings") return `#/system/settings${pane}`;
    if (route.page === "sys-overview" || route.page === "sys-accounts") return `#/system/overview${pane}`;
    if (route.page === "org-members") return `#/organization/members${route.accountId ? `/${encoded(route.accountId)}` : ""}${pane}`;
    if (route.page === "org-agents") return `#/organization/agents${pane}`;
    if (route.page === "org-projects") return `#/organization/projects${pane}`;
    if (route.page === "org-overview") return `#/organization/overview${pane}`;
    const segment = PAGE_SEGMENTS[route.page] || "overview";
    if (!route.projectId) return "#/project";
    const project = encoded(route.projectId);
    const group = route.groupId ? `/${encoded(route.groupId)}` : "";
    const work = route.workId && ["tasks", "directives"].includes(route.page) ? `/${encoded(route.workId)}` : "";
    const account = route.accountId && route.page === "proj-members" ? `/${encoded(route.accountId)}` : "";
    return `#/project/${project}/${segment}${account || group}${work}${pane}`;
  }

  function write(route, {replace = false} = {}) {
    const hash = build(route);
    if (!global.location || global.location.hash === hash) return false;
    const path = `${global.location.pathname || "/"}${global.location.search || ""}${hash}`;
    const method = replace ? "replaceState" : "pushState";
    if (typeof global.history?.[method] === "function") global.history[method](null, "", path);
    else global.location.hash = hash;
    return true;
  }

  function listen(callback) {
    if (typeof global.addEventListener !== "function") return () => {};
    let scheduled = false;
    const handler = () => {
      if (scheduled) return;
      scheduled = true;
      Promise.resolve().then(() => { scheduled = false; callback(parse()); });
    };
    global.addEventListener("popstate", handler);
    global.addEventListener("hashchange", handler);
    return () => {
      global.removeEventListener?.("popstate", handler);
      global.removeEventListener?.("hashchange", handler);
    };
  }

  global.AIMAC_WORKSPACE_ROUTE = {parse, build, write, listen};
})(window);
