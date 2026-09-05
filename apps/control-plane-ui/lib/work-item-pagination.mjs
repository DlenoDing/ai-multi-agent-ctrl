const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export function parseWorkItemListQuery(searchParams) {
  const limit = parsePositiveInteger(searchParams.get("limit"), DEFAULT_LIMIT, MAX_LIMIT);
  if (!limit.ok) return limit;
  const cursor = decodeWorkItemCursor(searchParams.get("cursor"));
  if (!cursor.ok) return cursor;
  return {
    ok: true,
    filters: {
      taskGroupId: nonEmpty(searchParams.get("taskGroupId")),
      q: nonEmpty(searchParams.get("q")),
      status: nonEmpty(searchParams.get("status")),
      cursor: cursor.cursor,
      limit: limit.value
    }
  };
}

export function listProjectWorkItems(taskGroups, filters = {}) {
  const query = normalizeSearch(filters.q);
  const status = nonEmpty(filters.status);
  const taskGroupId = nonEmpty(filters.taskGroupId);
  const candidates = [];
  for (const group of Array.isArray(taskGroups) ? taskGroups : []) {
    if (taskGroupId && group.id !== taskGroupId) continue;
    for (const workItem of Array.isArray(group.workItems) ? group.workItems : []) {
      if (status && workItem.status !== status) continue;
      if (query && !workItemMatchesQuery(workItem, group, query)) continue;
      candidates.push({group, workItem});
    }
  }
  const ordered = candidates.sort(compareWorkItemRows);
  const total = ordered.length;
  const afterCursor = filters.cursor;
  const pageStart = afterCursor ? ordered.findIndex((row) => compareCursorRow(row, afterCursor) > 0) : 0;
  const start = pageStart < 0 ? ordered.length : pageStart;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(filters.limit || DEFAULT_LIMIT)));
  const page = ordered.slice(start, start + limit);
  const hasMore = start + limit < ordered.length;
  return {
    workItems: page.map(({group, workItem}) => workItemListRecord(workItem, group)),
    total,
    nextCursor: hasMore ? encodeWorkItemCursor(cursorForRow(page.at(-1))) : null,
    hasMore
  };
}

function workItemListRecord(workItem, group) {
  return stripUndefined({
    id: workItem.id,
    title: workItem.title,
    status: workItem.status,
    progress: workItem.progress,
    ownerRole: workItem.ownerRole,
    createdAt: workItem.createdAt,
    blockedReason: workItem.blockedReason,
    taskGroupId: group.id,
    taskGroupName: group.name
  });
}

function parsePositiveInteger(raw, fallback, cap) {
  if (raw === null || raw === undefined || raw === "") return {ok: true, value: fallback};
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < 1) {
    return {ok: false, status: 400, payload: {error: "invalid_request_url", message: "limit must be a positive integer"}};
  }
  return {ok: true, value: Math.min(cap, numeric)};
}

function encodeWorkItemCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeWorkItemCursor(raw) {
  const value = nonEmpty(raw);
  if (!value) return {ok: true, cursor: null};
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || !parsed) throw new Error("cursor_not_object");
    const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : "";
    const id = typeof parsed.id === "string" ? parsed.id : "";
    const taskGroupId = typeof parsed.taskGroupId === "string" ? parsed.taskGroupId : "";
    if (!createdAt || !id || !taskGroupId || !Number.isFinite(new Date(createdAt).getTime())) {
      throw new Error("cursor_missing_keys");
    }
    return {ok: true, cursor: {createdAt, id, taskGroupId}};
  } catch {
    return {ok: false, status: 400, payload: {error: "invalid_request_url", message: "cursor is invalid"}};
  }
}

function compareWorkItemRows(left, right) {
  const timeDelta = sortableCreatedAt(right.workItem) - sortableCreatedAt(left.workItem);
  if (timeDelta) return timeDelta;
  const idDelta = String(left.workItem.id || "").localeCompare(String(right.workItem.id || ""));
  if (idDelta) return idDelta;
  return String(left.group.id || "").localeCompare(String(right.group.id || ""));
}

function compareCursorRow(row, cursor) {
  const rowCursor = cursorForRow(row);
  const timeDelta = sortableCursorCreatedAt(cursor) - sortableCursorCreatedAt(rowCursor);
  if (timeDelta) return timeDelta;
  const idDelta = String(rowCursor.id || "").localeCompare(String(cursor.id || ""));
  if (idDelta) return idDelta;
  return String(rowCursor.taskGroupId || "").localeCompare(String(cursor.taskGroupId || ""));
}

function cursorForRow(row) {
  return {
    createdAt: String(row?.workItem?.createdAt || ""),
    id: String(row?.workItem?.id || ""),
    taskGroupId: String(row?.group?.id || "")
  };
}

function sortableCreatedAt(workItem) {
  return new Date(workItem.createdAt || 0).getTime() || 0;
}

function sortableCursorCreatedAt(cursor) {
  return new Date(cursor.createdAt || 0).getTime() || 0;
}

function workItemMatchesQuery(workItem, group, query) {
  return [workItem.title, workItem.id, workItem.ownerRole, group.name]
    .some((value) => normalizeSearch(value).includes(query));
}

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
}

function nonEmpty(value) {
  const text = String(value || "").trim();
  return text || "";
}

function stripUndefined(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
