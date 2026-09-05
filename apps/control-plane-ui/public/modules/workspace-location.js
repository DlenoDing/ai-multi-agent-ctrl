(function () {
  "use strict";
  const key = "aimac.workspace-location";
  const text = (value, max = 256) => typeof value === "string" && value.length <= max ? value : "";
  const cursor = (value) => typeof value === "string" ? value : "";
  const cursors = (value) => Array.isArray(value) ? value.map(cursor) : [];

  function normalize(value) {
    if (!value || typeof value !== "object" || value.version !== 1 || !text(value.accountId) || !text(value.page)) return null;
    const page = text(value.page);
    const executionType = page === "monitor" && ["session", "dispatch"].includes(value.executionType) ? value.executionType : "";
    return {version: 1, accountId: text(value.accountId), projectId: text(value.projectId), page,
      workspace: text(value.workspace), groupWorkspace: text(value.groupWorkspace), groupId: text(value.groupId),
      groupDetail: value.groupDetail === true, workId: text(value.workId),
      executionType, executionId: executionType ? text(value.executionId) : "",
      directiveWorkId: text(value.directiveWorkId),
      search: text(value.search, 300), status: text(value.status), cursor: cursor(value.cursor), stack: cursors(value.stack),
      listGroupId: text(value.listGroupId), listCursor: cursor(value.listCursor), listStack: cursors(value.listStack)};
  }

  function save(value) {
    const location = normalize(value);
    if (!location) return false;
    try {
      const encoded = JSON.stringify(location);
      if (encoded.length > 300000) return false;
      if (sessionStorage.getItem(key) !== encoded) sessionStorage.setItem(key, encoded);
      return true;
    } catch { return false; }
  }

  function read(accountId) {
    try {
      const stored = sessionStorage.getItem(key);
      if (!stored || stored.length > 300000) return null;
      const location = normalize(JSON.parse(stored));
      return location?.accountId === accountId ? location : null;
    } catch { return null; }
  }

  function clear() {
    try { sessionStorage.removeItem(key); } catch { /* Browsing remains available without session storage. */ }
  }

  window.AIMAC_WORKSPACE_LOCATION = {save, read, clear};
})();
