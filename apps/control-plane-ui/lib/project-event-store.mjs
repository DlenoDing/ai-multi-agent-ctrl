import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function appendProjectExecutionEvent(runtimeDir, event) {
  return withProjectEventLock(runtimeDir, event.projectId, () => {
    const eventKey = String(event.eventKey || "");
    if (!eventKey) throw new Error("project_execution_event_key_required");
    rotateProjectExecutionEventIfNeeded(runtimeDir, event.projectId);
    const path = projectExecutionEventPath(runtimeDir, event.projectId, {forWrite: true});
    mkdirSync(dirname(path), {recursive: true});
    const index = ensureProjectExecutionEventIndex(runtimeDir, event.projectId);
    const existingEvent = readProjectExecutionEventByKey(runtimeDir, event.projectId, eventKey, {indexOnly: true}) || indexedEventByKey(index, eventKey);
    if (existingEvent) {
      return {
        storageKind: "project-jsonl",
        storageRef: `runtime://project-db/${safeProjectId(event.projectId)}.execution-events.jsonl`,
        projectId: event.projectId,
        duplicate: true,
        event: existingEvent
      };
    }
    const storedEvent = {
      ...event,
      sequence: Number(index.lastSequence || 0) + 1
    };
    appendDurableLine(path, `${JSON.stringify(storedEvent)}\n`);
    writeProjectExecutionEventKey(runtimeDir, storedEvent, path);
    updateProjectExecutionEventIndex(runtimeDir, storedEvent, index);
    return {
      storageKind: "project-jsonl",
      storageRef: `runtime://project-db/${safeProjectId(event.projectId)}.execution-events.jsonl`,
      projectId: event.projectId,
      event: storedEvent
    };
  });
}

export function readProjectExecutionEvents(runtimeDir, projectId, filters = {}) {
  const afterSequence = Number(filters.afterSequence || 0);
  const limit = Math.max(1, Math.min(500, Number(filters.limit || 120)));
  const paths = projectExecutionEventReadPaths(runtimeDir, projectId);
  if (!paths.length) return {events: [], nextCursor: afterSequence, storage: storageInfo(projectId)};
  const sources = paths.map((path) => ({path, source: readEventSource(path, filters)}));
  const source = sources.map((item) => item.source).join("\n");
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
      readMode: sources.some((item) => item.source.length < statSync(item.path).size) ? "tail-window" : "full"
    }
  };
}

export function readProjectExecutionEventByKey(runtimeDir, projectId, eventKey, options = {}) {
  const key = String(eventKey || "");
  if (!key) return null;
  const keyIndexed = readProjectExecutionEventKey(runtimeDir, projectId, key);
  if (keyIndexed) return keyIndexed;
  const indexed = indexedEventByKey(readProjectExecutionEventIndex(runtimeDir, projectId), key);
  if (indexed) return indexed;
  if (options.indexOnly) return null;
  const paths = projectExecutionEventReadPaths(runtimeDir, projectId);
  if (!paths.length) return null;
  for (const path of paths) {
    const tailMatch = findEventByKey(readEventSource(path, {afterSequence: Number.MAX_SAFE_INTEGER}), key);
    if (tailMatch) return tailMatch;
  }
  if (process.env.AIMAC_PROJECT_EVENT_ALLOW_FULL_KEY_SCAN !== "true" && !options.allowFullScan) return null;
  for (const path of paths) {
    const match = findEventByKey(readFileSync(path, "utf8"), key);
    if (match) return match;
  }
  return null;
}

function findEventByKey(source, eventKey) {
  for (const line of source.split(/\r?\n/u).filter(Boolean).reverse()) {
    try {
      const event = JSON.parse(line);
      if (event.eventKey === eventKey) return event;
    } catch {}
  }
  return null;
}

function storageInfo(projectId) {
  return {
    storageKind: "project-jsonl",
    storageRef: `runtime://project-db/${safeProjectId(projectId)}.execution-events.jsonl`,
    projectId
  };
}

export function projectExecutionEventStorageInfo(projectId) {
  return storageInfo(projectId);
}

function projectExecutionEventPath(runtimeDir, projectId, options = {}) {
  return projectEventPath(runtimeDir, projectId, "execution-events.jsonl", options);
}

function projectExecutionEventIndexPath(runtimeDir, projectId, options = {}) {
  return projectEventPath(runtimeDir, projectId, "execution-events.index.json", options);
}

function projectExecutionEventManifestPath(runtimeDir, projectId, options = {}) {
  return projectEventPath(runtimeDir, projectId, "execution-events.manifest.json", options);
}

function projectExecutionEventKeyPath(runtimeDir, projectId, eventKey) {
  const digest = createHash("sha256").update(String(eventKey)).digest("hex");
  return join(runtimeDir, "project-db", "event-keys", safeProjectId(projectId), `${digest}.json`);
}

function projectEventPath(runtimeDir, projectId, suffix, options = {}) {
  const primary = join(runtimeDir, "project-db", `${safeProjectId(projectId)}.${suffix}`);
  if (options.forWrite || existsSync(primary)) return primary;
  const legacy = join(runtimeDir, "project-db", `${legacySafeProjectId(projectId)}.${suffix}`);
  return existsSync(legacy) ? legacy : primary;
}

function projectExecutionEventReadPaths(runtimeDir, projectId) {
  const primary = projectEventPath(runtimeDir, projectId, "execution-events.jsonl", {forWrite: true});
  const legacy = join(runtimeDir, "project-db", `${legacySafeProjectId(projectId)}.execution-events.jsonl`);
  const manifest = readProjectExecutionEventManifest(runtimeDir, projectId);
  const dir = join(runtimeDir, "project-db");
  const fromManifest = (manifest.segments || [])
    .map((segment) => join(dir, segment.file))
    .filter((path) => existsSync(path));
  const prefix = `${safeProjectId(projectId)}.execution-events.`;
  const fromDirectory = existsSync(dir)
    ? readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".jsonl") && name !== `${safeProjectId(projectId)}.execution-events.jsonl`)
      .map((name) => join(dir, name))
    : [];
  return [...new Set([legacy, ...fromManifest, ...fromDirectory, primary])]
    .filter((path) => existsSync(path))
    .sort((left, right) => firstSequenceInFile(left) - firstSequenceInFile(right));
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

function updateProjectExecutionEventIndex(runtimeDir, event, existingIndex = null) {
  const path = projectExecutionEventIndexPath(runtimeDir, event.projectId, {forWrite: true});
  let index = existingIndex || readProjectExecutionEventIndex(runtimeDir, event.projectId) || {};
  index = {schemaVersion: "project-execution-event-index/v4", projectId: event.projectId, fileId: safeProjectId(event.projectId), recentEventKeys: [], eventsByKey: {}, keyIndex: "project-event-key-kv", segments: [], ...index};
  const keyWindow = Math.max(100, Number(process.env.AIMAC_PROJECT_EVENT_IDEMPOTENCY_KEYS || 500));
  index.lastSequence = Math.max(Number(index.lastSequence || 0), Number(event.sequence || 0));
  const entries = Object.entries(index.eventsByKey || {}).filter(([key]) => key && key !== event.eventKey);
  if (event.eventKey) entries.unshift([event.eventKey, event]);
  index.eventsByKey = Object.fromEntries(entries.slice(0, keyWindow));
  index.recentEventKeys = Object.keys(index.eventsByKey).slice(0, keyWindow);
  index.segments = readProjectExecutionEventManifest(runtimeDir, event.projectId).segments || [];
  index.fileSnapshot = snapshotProjectEventFiles(projectExecutionEventReadPaths(runtimeDir, event.projectId));
  index.backfilledAt ||= new Date().toISOString();
  index.updatedAt = new Date().toISOString();
  appendSafeJson(path, index);
}

function ensureProjectExecutionEventIndex(runtimeDir, projectId) {
  const currentPaths = projectExecutionEventReadPaths(runtimeDir, projectId);
  const currentSnapshot = snapshotProjectEventFiles(currentPaths);
  const index = readProjectExecutionEventIndex(runtimeDir, projectId);
  if (index?.schemaVersion === "project-execution-event-index/v4" && snapshotsEqual(index.fileSnapshot || [], currentSnapshot)) return index;
  const rebuilt = {
    schemaVersion: "project-execution-event-index/v4",
    projectId,
    fileId: safeProjectId(projectId),
    recentEventKeys: [],
    eventsByKey: {},
    keyIndex: "project-event-key-kv",
    segments: readProjectExecutionEventManifest(runtimeDir, projectId).segments || [],
    lastSequence: 0,
    fileSnapshot: currentSnapshot,
    backfilledAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const keyWindow = Math.max(100, Number(process.env.AIMAC_PROJECT_EVENT_IDEMPOTENCY_KEYS || 500));
  const keyEntries = [];
  for (const path of currentPaths) {
    const source = readFileSync(path, "utf8");
    for (const line of source.split(/\r?\n/u).filter(Boolean)) {
      try {
        const event = JSON.parse(line);
        rebuilt.lastSequence = Math.max(Number(rebuilt.lastSequence || 0), Number(event.sequence || 0));
        if (event.eventKey) {
          writeProjectExecutionEventKey(runtimeDir, event, path);
          keyEntries.unshift([event.eventKey, event]);
        }
      } catch {}
    }
  }
  rebuilt.eventsByKey = Object.fromEntries(keyEntries.slice(0, keyWindow));
  rebuilt.recentEventKeys = Object.keys(rebuilt.eventsByKey).slice(0, keyWindow);
  appendSafeJson(projectExecutionEventIndexPath(runtimeDir, projectId, {forWrite: true}), rebuilt);
  return rebuilt;
}

function readProjectExecutionEventIndex(runtimeDir, projectId) {
  for (const path of [projectExecutionEventIndexPath(runtimeDir, projectId), legacyProjectExecutionEventIndexPath(runtimeDir, projectId)]) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  }
  return null;
}

function legacyProjectExecutionEventIndexPath(runtimeDir, projectId) {
  return join(runtimeDir, "project-db", `${legacySafeProjectId(projectId)}.execution-events.index.json`);
}

function indexedEventByKey(index, eventKey) {
  const key = String(eventKey || "");
  if (!index || !key) return null;
  const stored = index.eventsByKey?.[key];
  if (stored?.schemaVersion === "agent-execution-event/v1") return stored;
  if (stored?.event?.schemaVersion === "agent-execution-event/v1") return stored.event;
  return null;
}

function readProjectExecutionEventKey(runtimeDir, projectId, eventKey) {
  const path = projectExecutionEventKeyPath(runtimeDir, projectId, eventKey);
  if (!existsSync(path)) return null;
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    return record.event?.schemaVersion === "agent-execution-event/v1" ? record.event : null;
  } catch {
    return null;
  }
}

function writeProjectExecutionEventKey(runtimeDir, event, path) {
  if (!event.eventKey) return;
  appendSafeJson(projectExecutionEventKeyPath(runtimeDir, event.projectId, event.eventKey), {
    schemaVersion: "project-execution-event-key/v1",
    projectId: event.projectId,
    eventKey: event.eventKey,
    eventId: event.eventId,
    sequence: event.sequence,
    file: path.split("/").pop(),
    event,
    updatedAt: new Date().toISOString()
  });
}

function readProjectExecutionEventManifest(runtimeDir, projectId) {
  const path = projectExecutionEventManifestPath(runtimeDir, projectId);
  if (!existsSync(path)) return {schemaVersion: "project-execution-event-manifest/v1", projectId, segments: []};
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    return {schemaVersion: "project-execution-event-manifest/v1", projectId, segments: [], ...manifest};
  } catch {
    return {schemaVersion: "project-execution-event-manifest/v1", projectId, segments: []};
  }
}

function writeProjectExecutionEventManifest(runtimeDir, projectId, manifest) {
  appendSafeJson(projectExecutionEventManifestPath(runtimeDir, projectId, {forWrite: true}), {
    schemaVersion: "project-execution-event-manifest/v1",
    projectId,
    fileId: safeProjectId(projectId),
    segments: manifest.segments || [],
    updatedAt: new Date().toISOString()
  });
}

function rotateProjectExecutionEventIfNeeded(runtimeDir, projectId) {
  const path = projectExecutionEventPath(runtimeDir, projectId, {forWrite: true});
  if (!existsSync(path)) return;
  const maxBytes = Math.max(1024, Number(process.env.AIMAC_PROJECT_EVENT_SEGMENT_MAX_BYTES || 64 * 1024 * 1024));
  const stat = statSync(path);
  if (stat.size < maxBytes) return;
  const bounds = sequenceBoundsInFile(path);
  if (!bounds.lastSequence) return;
  const rotatedName = `${safeProjectId(projectId)}.execution-events.${bounds.firstSequence}-${bounds.lastSequence}.${new Date().toISOString().replace(/[^0-9T]/g, "")}.jsonl`;
  const rotatedPath = join(dirname(path), rotatedName);
  renameSync(path, rotatedPath);
  fsyncDirectory(dirname(path));
  const manifest = readProjectExecutionEventManifest(runtimeDir, projectId);
  manifest.segments = [...(manifest.segments || []), {
    file: rotatedName,
    firstSequence: bounds.firstSequence,
    lastSequence: bounds.lastSequence,
    size: stat.size,
    digest: digestFile(rotatedPath),
    sealedAt: new Date().toISOString()
  }];
  writeProjectExecutionEventManifest(runtimeDir, projectId, manifest);
}

function sequenceBoundsInFile(path) {
  let firstSequence = 0;
  let lastSequence = 0;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean)) {
    try {
      const sequence = Number(JSON.parse(line).sequence || 0);
      if (sequence && !firstSequence) firstSequence = sequence;
      if (sequence) lastSequence = sequence;
    } catch {}
  }
  return {firstSequence, lastSequence};
}

const firstSequenceCache = new Map();

function firstSequenceInFile(path) {
  const fromName = String(path.split("/").pop()).match(/\.execution-events\.(\d+)-\d+\./u);
  if (fromName) return Number(fromName[1]);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
  const cached = firstSequenceCache.get(path);
  if (cached && cached.ino === stat.ino) return cached.firstSequence;
  let firstSequence = firstSequenceInSource(readFileHead(path, 64 * 1024));
  if (!firstSequence) firstSequence = sequenceBoundsInFile(path).firstSequence;
  if (firstSequence) {
    firstSequenceCache.set(path, {ino: stat.ino, firstSequence});
    if (firstSequenceCache.size > 512) firstSequenceCache.delete(firstSequenceCache.keys().next().value);
    return firstSequence;
  }
  return Number.MAX_SAFE_INTEGER;
}

function readFileHead(path, maxBytes) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!bytes) break;
      offset += bytes;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function digestFile(path) {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function snapshotProjectEventFiles(paths) {
  return paths.map((path) => {
    const stat = statSync(path);
    return {file: path.split("/").pop(), size: stat.size};
  }).sort((left, right) => left.file.localeCompare(right.file));
}

function snapshotsEqual(left = [], right = []) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appendSafeJson(path, value) {
  mkdirSync(dirname(path), {recursive: true});
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeDurableFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
}

function appendDurableLine(path, line) {
  mkdirSync(dirname(path), {recursive: true});
  appendFileSync(path, line, {mode: 0o600});
  if (process.env.AIMAC_PROJECT_EVENT_FSYNC === "false") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeDurableFile(path, data) {
  mkdirSync(dirname(path), {recursive: true});
  const fd = openSync(path, "w", 0o600);
  try {
    writeFileSync(fd, data);
    if (process.env.AIMAC_PROJECT_EVENT_FSYNC !== "false") fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path) {
  if (process.env.AIMAC_PROJECT_EVENT_FSYNC === "false") return;
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {}
}

function safeProjectId(projectId) {
  const raw = String(projectId || "unknown");
  return `p_${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
}

function legacySafeProjectId(projectId) {
  const raw = String(projectId || "unknown");
  const safe = raw.replace(/[^A-Za-z0-9._-]+/gu, "_") || "unknown";
  if (safe === raw) return safe;
  return `${safe}-${createHash("sha256").update(raw).digest("hex").slice(0, 10)}`;
}

function withProjectEventLock(runtimeDir, projectId, fn) {
  const lockPath = join(runtimeDir, "locks", `${safeProjectId(projectId)}.execution-events.lock`);
  mkdirSync(dirname(lockPath), {recursive: true});
  const startedAt = Date.now();
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() - startedAt > Number(process.env.AIMAC_PROJECT_EVENT_LOCK_TIMEOUT_MS || 10000)) {
        throw new Error(`project_event_lock_timeout:${projectId}`);
      }
      if (lockStale(lockPath)) {
        try { rmSync(lockPath, {recursive: true, force: true}); } catch {}
        continue;
      }
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, {recursive: true, force: true});
  }
}

function lockStale(lockPath) {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > Number(process.env.AIMAC_PROJECT_EVENT_LOCK_STALE_MS || 30000);
  } catch {
    return false;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
