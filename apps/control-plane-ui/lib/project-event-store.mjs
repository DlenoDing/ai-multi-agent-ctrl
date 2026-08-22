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
    maybeGcProjectExecutionEventKeys(runtimeDir, storedEvent);
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
      // Compare BYTES to bytes: source.length is UTF-16 code units, so any multibyte content (the
      // console is Chinese) would otherwise report a fully-read file as a truncated "tail-window".
      readMode: sources.some((item) => Buffer.byteLength(item.source, "utf8") < statSync(item.path).size) ? "tail-window" : "full"
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

// 按【成因】各记一条。原先是一个字符串加 `||` 保护：第一条路径先报了，
// 后面两条就永远说不出话 —— 而它们说的是不同的后果（序号被重用 / 段范围不准 / 幂等失效）。
// 成因是固定的六种，不会随文件数涨（同一成因只留先撞上的那一条，具体是哪一段写在正文里）。
const eventLogFaults = new Map();

function noteEventLogFault(cause, text) {
  if (!eventLogFaults.has(cause)) eventLogFaults.set(cause, text);
}

// 与 auditArchiveFault 同规：只报事实，由服务端决定给谁看。
export function projectEventLogFault() {
  return [...eventLogFaults.values()].join("；");
}

// 第三条读路径。上一轮补了索引重建与段序号扫描两处，漏了这一处 —— 而它恰恰是【幂等查找】：
// 坏行被静默跳过时，一条其实已经写过的事件会被判成"没见过"，调用方于是再执行一遍。
// 幂等这件事本身就是"出问题时才起作用"，它失效时更不能一声不吭。
function findEventByKey(source, eventKey) {
  let corrupt = 0;
  for (const line of source.split(/\r?\n/u).filter(Boolean).reverse()) {
    try {
      const event = JSON.parse(line);
      if (event.eventKey === eventKey) return event;
    } catch {
      corrupt += 1;
    }
  }
  if (corrupt) {
    noteEventLogFault("key-lookup",
      `${corrupt} 行事件日志解析不了，按幂等键查找时跳过了 —— 已经写过的事件可能查不到，`
        + "于是被当成没做过再做一遍（重复执行、重复记账），请核对该文件");
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
    .filter((segment) => {
      const path = join(dir, segment.file);
      if (!existsSync(path)) {
        // 段清单说有这一段，盘上却没有 —— 悄悄跳过等于【这段历史凭空消失】：
        // 实测删掉一个已封存段，同一次查询读出来的事件从 40 条变成 35 条，没有任何地方说过。
        // 下面按名字扫目录那一路也补不回它（文件本来就不在），所以必须在这里说出来。
        noteEventLogFault("segment-missing",
          `段清单里记着的事件段 ${segment.file} 不在盘上了 —— 序号 ${segment.firstSequence}-${segment.lastSequence} `
            + "的执行历史读不到了（页面上不会有任何提示，只是变少），请从备份还原这一段或核对是谁删的");
        return false;
      }
      noteSealedSegmentDamage(path, segment);
      return true;
    })
    .map((segment) => join(dir, segment.file));
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
  let corruptLines = 0;
  let corruptSample = "";
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
      } catch {
        // 索引重建时跳过一行坏数据，后果具体且都看不见：
        //   那行若含最大序号 → lastSequence 算小了 → 下一条事件会【重用序号】；
        //   那行若含 eventKey → 该键的幂等性没了 → 重放会被当成新事件【接受两次】。
        // 而追加那段专门在处理"尾部没有换行"，说明撕裂写本来就是预期内的 ——
        // 也就是说这条 catch 不是理论分支，它真的会被走到。至少要让人知道跳过了几行、在哪个文件。
        corruptLines += 1;
        if (!corruptSample) corruptSample = `${path.split("/").pop()}: ${line.slice(0, 60)}`;
      }
    }
  }
  rebuilt.eventsByKey = Object.fromEntries(keyEntries.slice(0, keyWindow));
  // 记成模块级的故障事实，走 auditArchiveFault 同一条路：系统账号的状态里下发，界面出横幅。
  // 不抛异常：一行坏数据不该让整个项目读不出来；但也绝不能一声不吭。
  if (corruptLines) {
    noteEventLogFault("index-rebuild", `${corruptLines} 行事件日志解析不了，重建索引时跳过了`
      + `（样例 ${corruptSample}）—— 序号可能被重用、幂等键可能失效，请核对该文件`);
  }
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

function projectExecutionEventKeyDir(runtimeDir, projectId) {
  return join(runtimeDir, "project-db", "event-keys", safeProjectId(projectId));
}

// The per-event-key KV files back idempotent dedup as the fast path ahead of the
// (capped) in-memory index. Left ungoverned they grow one file per unique key
// forever. GC caps them by count and evicts the oldest by mtime; the cap is held at
// or above the index key window so file-backed dedup is never narrower than
// index-backed dedup. The APPEND dedup path (readProjectExecutionEventByKey with
// indexOnly) checks only the KV files + the index — it does NOT scan the log — so a
// re-append of a key older than BOTH the file cap and the index window can duplicate;
// the cap (default 5000) makes this window far larger than the idempotency window
// (default 500). The full log scan is available only to explicit indexOnly:false /
// allowFullScan reads. Amortized: runs once every AIMAC_PROJECT_EVENT_KEY_GC_STRIDE appends.
function maybeGcProjectExecutionEventKeys(runtimeDir, event) {
  const stride = Math.max(1, Number(process.env.AIMAC_PROJECT_EVENT_KEY_GC_STRIDE || 256));
  if (Number(event.sequence || 0) % stride !== 0) return;
  gcProjectExecutionEventKeys(runtimeDir, event.projectId);
}

function gcProjectExecutionEventKeys(runtimeDir, projectId) {
  const dir = projectExecutionEventKeyDir(runtimeDir, projectId);
  if (!existsSync(dir)) return;
  const keyWindow = Math.max(100, Number(process.env.AIMAC_PROJECT_EVENT_IDEMPOTENCY_KEYS || 500));
  const cap = Math.max(keyWindow, Number(process.env.AIMAC_PROJECT_EVENT_KEY_FILE_CAP || 5000));
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  if (names.length <= cap) return;
  const entries = [];
  for (const name of names) {
    try {
      entries.push({name, mtime: statSync(join(dir, name)).mtimeMs});
    } catch {
      // File removed concurrently; skip.
    }
  }
  entries.sort((left, right) => left.mtime - right.mtime);
  const removeCount = entries.length - cap;
  for (let i = 0; i < removeCount; i += 1) {
    try {
      rmSync(join(dir, entries[i].name), {force: true});
    } catch {
      // Best-effort; a failed unlink just defers reclamation to the next sweep.
    }
  }
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
    } catch {
      // 与索引重建同理：坏行被吞掉，这个段声明的序号范围就与它的内容对不上。
      // 段清单是轮转与查找的依据，范围错了会让某些事件永远查不到。
      noteEventLogFault("segment-scan",
        `${path.split("/").pop()} 里有解析不了的行，段序号范围可能不准 —— 查找与轮转都以它为准`);
    }
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

// 段清单里记着每一段的 size 与 digest，而读取侧【一处都没核过】。实测把一个已封存段截空，
// 事件从 35 条变成 30 条；把段里一条事件改掉，改过的那条照样当真发出去 —— 两次都一声不吭。
// 已封存的段是不可变的，据此分两级核：长度每次都核（stat 是 O(1)）；摘要按「长度+mtime」记住
// 核过的结论，一个进程里每段最多算一次（段上限默认 64MB，约 40ms，此后直接跳过）。
// 只报故障、不抛错：这是历史与审计的读路径，为一段坏掉的历史把整页打死更糟 ——
// 但也【不能不说】，坏掉的审计历史被当成真的，比读不出来更危险。
const verifiedSegmentDigests = new Map();

function noteSealedSegmentDamage(path, segment) {
  let stat;
  try { stat = statSync(path); } catch { return; }
  if (segment.size && Number(segment.size) !== stat.size) {
    noteEventLogFault("segment-size",
      `已封存的事件段 ${segment.file} 长度与段清单对不上（封存时 ${segment.size} 字节，现在 ${stat.size} 字节）——`
        + `序号 ${segment.firstSequence}-${segment.lastSequence} 的执行历史已经不是当初封存的那一份，不可信`);
    return;
  }
  if (!segment.digest) return;
  // 缓存键按【路径】存一条、值带上长度与 mtime：段被改过时 mtime 变、键的值对不上，会重算一次。
  // 用 Map 而不是 Set，是为了让它的条目数被段数封住 —— 反复改写同一个文件不会把它撑大。
  const stamp = `${stat.size}:${stat.mtimeMs}`;
  if (verifiedSegmentDigests.get(path) === stamp) return;
  if (digestFile(path) !== segment.digest) {
    noteEventLogFault("segment-digest",
      `已封存的事件段 ${segment.file} 的校验值与段清单对不上 —— 长度没变而内容变了，`
        + `序号 ${segment.firstSequence}-${segment.lastSequence} 的执行历史被改写过，不可信`);
    return;
  }
  verifiedSegmentDigests.set(path, stamp);
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
  // Self-heal a prior torn write: if the file's last byte isn't a newline (a previous append was cut off
  // mid-line by a crash/power-loss), prepend one so this record starts fresh. Otherwise the two lines
  // concatenate into one unparseable record and BOTH are dropped on rebuild (torn event + following one).
  let prefix = "";
  if (existsSync(path)) {
    const size = statSync(path).size;
    if (size > 0) {
      const fd = openSync(path, "r");
      try {
        const tail = Buffer.alloc(1);
        readSync(fd, tail, 0, 1, size - 1);
        if (tail[0] !== 0x0a) prefix = "\n";
      } finally {
        closeSync(fd);
      }
    }
  }
  appendFileSync(path, prefix + line, {mode: 0o600});
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
  } catch {
    // 目录 fsync 在有些平台/文件系统上本就不支持（macOS 上会 EINVAL/EACCES），
    // 拿它当错误会让正常环境直接写不进事件。这里【只能】吞掉。
    // 残留风险要说清：目录项没落盘时，刚轮转出来的那个新段文件可能在断电后不存在
    //（段里的内容本身已经 fsync 过）。这是本存储在这些平台上的落盘保证上限，不是 bug。
  }
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
