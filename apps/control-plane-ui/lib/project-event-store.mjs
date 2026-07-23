import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function appendProjectExecutionEvent(runtimeDir, event) {
  const path = projectExecutionEventPath(runtimeDir, event.projectId);
  mkdirSync(dirname(path), {recursive: true});
  if (event.eventKey && eventKeyRecentlyStored(runtimeDir, event.projectId, event.eventKey)) {
    return {
      storageKind: "project-jsonl",
      storageRef: `runtime://project-db/${safeProjectId(event.projectId)}.execution-events.jsonl`,
      projectId: event.projectId,
      duplicate: true
    };
  }
  appendFileSync(path, `${JSON.stringify(event)}\n`, {mode: 0o600});
  updateProjectExecutionEventIndex(runtimeDir, event);
  return {
    storageKind: "project-jsonl",
    storageRef: `runtime://project-db/${safeProjectId(event.projectId)}.execution-events.jsonl`,
    projectId: event.projectId
  };
}

export function readProjectExecutionEvents(runtimeDir, projectId, filters = {}) {
  const path = projectExecutionEventPath(runtimeDir, projectId);
  const afterSequence = Number(filters.afterSequence || 0);
  const limit = Math.max(1, Math.min(500, Number(filters.limit || 120)));
  if (!existsSync(path)) return {events: [], nextCursor: afterSequence, storage: storageInfo(projectId)};
  const source = readEventSource(path, filters);
  const events = source
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((event) => Number(event.sequence || 0) > afterSequence)
    .filter((event) => !filters.dispatchId || event.dispatchId === filters.dispatchId)
    .filter((event) => !filters.taskGroupId || event.taskGroupId === filters.taskGroupId)
    .filter((event) => !filters.sessionId || event.sessionId === filters.sessionId)
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
    .slice(0, limit);
  return {
    events,
    nextCursor: events.at(-1)?.sequence || afterSequence,
    storage: {
      ...storageInfo(projectId),
      readMode: source.length < statSync(path).size ? "tail-window" : "full"
    }
  };
}

function storageInfo(projectId) {
  return {
    storageKind: "project-jsonl",
    storageRef: `runtime://project-db/${safeProjectId(projectId)}.execution-events.jsonl`,
    projectId
  };
}

function projectExecutionEventPath(runtimeDir, projectId) {
  return join(runtimeDir, "project-db", `${safeProjectId(projectId)}.execution-events.jsonl`);
}

function projectExecutionEventIndexPath(runtimeDir, projectId) {
  return join(runtimeDir, "project-db", `${safeProjectId(projectId)}.execution-events.index.json`);
}

function readEventSource(path, filters = {}) {
  const maxBytes = Math.max(64 * 1024, Number(process.env.AIMAC_PROJECT_EVENT_TAIL_BYTES || 2 * 1024 * 1024));
  const size = statSync(path).size;
  if (size <= maxBytes) return readFileSync(path, "utf8");
  const afterSequence = Number(filters.afterSequence || 0);
  const tail = readFileTail(path, maxBytes);
  const firstTailSequence = firstSequenceInSource(tail);
  if (!afterSequence || (firstTailSequence && afterSequence >= firstTailSequence - 1)) return tail;
  return readFileSync(path, "utf8");
}

function readFileTail(path, maxBytes) {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = readSync(fd, buffer, offset, buffer.length - offset, start + offset);
      if (!bytes) break;
      offset += bytes;
    }
    const text = buffer.subarray(0, offset).toString("utf8");
    const firstNewline = text.indexOf("\n");
    return start > 0 && firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
  } finally {
    closeSync(fd);
  }
}

function firstSequenceInSource(source) {
  for (const line of source.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      return Number(JSON.parse(line).sequence || 0);
    } catch {
      return 0;
    }
  }
  return 0;
}

function eventKeyRecentlyStored(runtimeDir, projectId, eventKey) {
  const path = projectExecutionEventIndexPath(runtimeDir, projectId);
  if (!existsSync(path)) return false;
  try {
    const index = JSON.parse(readFileSync(path, "utf8"));
    return (index.recentEventKeys || []).includes(eventKey);
  } catch {
    return false;
  }
}

function updateProjectExecutionEventIndex(runtimeDir, event) {
  const path = projectExecutionEventIndexPath(runtimeDir, event.projectId);
  let index = {schemaVersion: "project-execution-event-index/v1", projectId: event.projectId, recentEventKeys: []};
  if (existsSync(path)) {
    try {
      index = {...index, ...JSON.parse(readFileSync(path, "utf8"))};
    } catch {}
  }
  const keyWindow = Math.max(100, Number(process.env.AIMAC_PROJECT_EVENT_IDEMPOTENCY_KEYS || 5000));
  index.lastSequence = Math.max(Number(index.lastSequence || 0), Number(event.sequence || 0));
  index.recentEventKeys = [event.eventKey, ...(index.recentEventKeys || []).filter((key) => key && key !== event.eventKey)].slice(0, keyWindow);
  index.updatedAt = new Date().toISOString();
  appendSafeJson(path, index);
}

function appendSafeJson(path, value) {
  mkdirSync(dirname(path), {recursive: true});
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600});
  renameSync(temporary, path);
}

function safeProjectId(projectId) {
  return String(projectId || "unknown").replace(/[^A-Za-z0-9._-]+/gu, "_");
}
