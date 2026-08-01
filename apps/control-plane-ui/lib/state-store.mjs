import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pgEnsureTables, pgReadProjectShards, pgReadState, pgReadStateWithShards, pgWriteStateWithProjectShards } from "./pg-sync-store.mjs";

const tableName = "aimac_control_plane_state";
const projectShardTableName = "aimac_project_state_shards";
const stateId = "default";
const lockTtlMs = 30000;
const projectDbDirName = "project-db";
const projectShardCollections = [
  "taskGroups",
  "repositoryOutputs",
  "workSessions",
  "agentDispatches",
  "agentTaskContracts",
  "effectiveInstructionPackets",
  "roleDriftGuards",
  "checkpoints",
  "completionReadiness",
  "closeBarriers",
  "progressSnapshots",
  "agentControlCommands",
  "agentExecutionEvents",
  "humanConfirmationRequests",
  "humanDirectives"
];
const projectShardCollectionLimits = {
  taskGroups: 2000,
  repositoryOutputs: 5000,
  workSessions: 5000,
  agentDispatches: 5000,
  agentTaskContracts: 5000,
  effectiveInstructionPackets: 5000,
  roleDriftGuards: 5000,
  checkpoints: 5000,
  completionReadiness: 2000,
  closeBarriers: 2000,
  progressSnapshots: 5000,
  agentControlCommands: 5000,
  agentExecutionEvents: 1000,
  humanConfirmationRequests: 2000,
  humanDirectives: 2000
};

export function isStateStoreConflict(error) {
  return error?.code === "AIMAC_STATE_CONFLICT";
}

const hydratedStateCache = new Map();
const centralStateCache = new Map();

function statCacheKey(path) {
  try {
    const stat = statSync(path, {bigint: true});
    return `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
  } catch {
    return null;
  }
}

function runtimeJsonStateCacheKey(options, central) {
  const centralKey = statCacheKey(options.statePath);
  if (!centralKey) return null;
  const parts = [centralKey];
  for (const entry of central?.projectStateShards?.projects || []) {
    const name = runtimeJsonShardNameFromIndexEntry(entry);
    if (!name) return null;
    const shardKey = statCacheKey(join(options.runtimeDir, projectDbDirName, name));
    if (!shardKey) return null;
    parts.push(`${name}=${shardKey}`);
  }
  return parts.join("|");
}

function cacheStoredState(cache, statePath, value, key) {
  if (!key) return;
  cache.clear();
  cache.set(statePath, {key, value: structuredClone(value)});
}

function cachedStoredState(cache, statePath, keyBuilder) {
  const entry = cache.get(statePath);
  if (!entry) return null;
  const currentKey = keyBuilder(entry.value);
  if (!currentKey || entry.key !== currentKey) return null;
  return structuredClone(entry.value);
}

export function stateStoreKind() {
  return process.env.AIMAC_STATE_STORE === "postgresql" && Boolean(process.env.DATABASE_URL) ? "postgresql" : "runtime_json";
}

export function ensureStoredState(options) {
  mkdirSync(options.runtimeDir, {recursive: true});
  if (stateStoreKind() === "postgresql") {
    ensurePostgresTable(options);
    const row = readPostgresState(options);
    if (!row) writeStoredState(options.buildInitialState(), options);
    return;
  }
  if (!existsSync(options.statePath)) writeStoredState(options.buildInitialState(), options);
}

export function storedStateExists(options) {
  mkdirSync(options.runtimeDir, {recursive: true});
  if (stateStoreKind() === "postgresql") {
    ensurePostgresTable(options);
    return Boolean(readPostgresState(options));
  }
  return existsSync(options.statePath);
}

export function readStoredState(options) {
  ensureStoredState(options);
  if (stateStoreKind() !== "postgresql") {
    const cached = cachedStoredState(hydratedStateCache, options.statePath, (value) => runtimeJsonStateCacheKey(options, value));
    if (cached) {
      cached.__loadedStateVersion = Number(cached.stateVersion || 0);
      return cached;
    }
    return withRuntimeJsonLock(options, () => {
      const central = JSON.parse(readFileSync(options.statePath, "utf8"));
      const state = hydrateProjectState(central, options);
      cacheStoredState(hydratedStateCache, options.statePath, state, runtimeJsonStateCacheKey(options, central));
      state.__loadedStateVersion = Number(state.stateVersion || 0);
      return state;
    });
  }
  const {central, shards} = pgReadStateWithShards();
  const state = hydrateProjectState(central, options, shards);
  state.__loadedStateVersion = Number(state.stateVersion || 0);
  return state;
}

export function readStoredCentralState(options) {
  ensureStoredState(options);
  if (stateStoreKind() !== "postgresql") {
    const cached = cachedStoredState(centralStateCache, options.statePath, () => statCacheKey(options.statePath));
    if (cached) {
      cached.__loadedStateVersion = Number(cached.stateVersion || 0);
      return cached;
    }
  }
  const central = stateStoreKind() === "postgresql"
    ? readPostgresState()
    : JSON.parse(readFileSync(options.statePath, "utf8"));
  if (stateStoreKind() !== "postgresql") cacheStoredState(centralStateCache, options.statePath, central, statCacheKey(options.statePath));
  central.__loadedStateVersion = Number(central.stateVersion || 0);
  return central;
}

export function writeStoredState(state, options) {
  mkdirSync(options.runtimeDir, {recursive: true});
  if (stateStoreKind() === "postgresql") {
    const {centralState, projectShards} = externalizeProjectState(withoutInternalStateFields(state));
    writePostgresStateWithProjectShards(centralState, projectShards, options, options.expectedStateVersion);
    return;
  }
  withRuntimeJsonLock(options, () => {
    const previousCentral = readCentralStateIfPresent(options.statePath);
    assertExpectedVersionFromCentral(previousCentral, options.expectedStateVersion);
    const previousShardIndex = new Map((previousCentral?.projectStateShards?.projects || []).map((entry) => [entry.projectId, entry]));
    const {centralState, projectShards, unchangedProjectIds} = externalizeProjectState(withoutInternalStateFields(state), previousShardIndex, options);
    const shardWrite = writeRuntimeJsonProjectShards(projectShards, options, unchangedProjectIds);
    writeRuntimeJsonCentralState(centralState, options);
    gcRuntimeJsonProjectShards(options, shardWrite.activeNames);
    cacheStoredState(centralStateCache, options.statePath, centralState, statCacheKey(options.statePath));
    cacheStoredState(hydratedStateCache, options.statePath, hydratedStateFromParts(centralState, projectShards), runtimeJsonStateCacheKey(options, centralState));
  });
}

function readCentralStateIfPresent(statePath) {
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function assertExpectedVersionFromCentral(central, expectedStateVersion) {
  if (expectedStateVersion === undefined || expectedStateVersion === null) return;
  // Fail CLOSED when the central file vanished between read and locked write (matches the Postgres CAS,
  // which conflicts on rowCount 0). A non-null expectedStateVersion means the caller read an existing
  // state; if it is now absent, silently succeeding would reset stateVersion and lose the guard.
  if (!central) {
    throwStateStoreConflict(`runtime_json state version conflict; expected ${expectedStateVersion}, central state absent`);
  }
  if (Number(central.stateVersion || 0) !== Number(expectedStateVersion)) {
    throwStateStoreConflict(`runtime_json state version conflict; expected ${expectedStateVersion}, found ${central.stateVersion}`);
  }
}

function hydratedStateFromParts(centralState, projectShards) {
  const state = {...centralState};
  for (const collection of projectShardCollections) {
    state[collection] = Array.isArray(state[collection]) ? [...state[collection]] : [];
  }
  const ordered = [...projectShards].sort((left, right) => String(left.projectId).localeCompare(String(right.projectId)));
  for (const shard of ordered) {
    for (const collection of projectShardCollections) {
      const items = Array.isArray(shard.collections?.[collection]) ? shard.collections[collection] : [];
      if (items.length) state[collection].push(...items);
    }
  }
  return state;
}

export function markRuntimeStorage(state, statePath = ".runtime/control-plane-state.json") {
  state.runtime ||= {};
  state.runtime.storage ||= {};
  state.runtime.storage.stateStore = stateStoreKind();
  state.runtime.storage.runtimeStatePath = stateStoreKind() === "postgresql" ? "postgresql://aimac_control_plane_state/default" : statePath;
  if (stateStoreKind() === "postgresql") state.runtime.storage.databaseUrlSecretRef = "env:DATABASE_URL";
  else delete state.runtime.storage.databaseUrlSecretRef;
}

function ensurePostgresTable() {
  pgEnsureTables();
}

// Returns the parsed central-state object (jsonb decodes to a JS object) or null.
function readPostgresState() {
  return pgReadState();
}

function writePostgresStateWithProjectShards(state, projectShards, options, expectedStateVersion) {
  pgWriteStateWithProjectShards(withoutInternalStateFields(state), projectShards, expectedStateVersion);
}

function readPostgresProjectShards() {
  ensurePostgresTable();
  return pgReadProjectShards();
}

function withoutInternalStateFields(state) {
  const clean = {...state};
  for (const key of Object.keys(clean)) {
    if (key.startsWith("__")) delete clean[key];
  }
  return clean;
}

function externalizeProjectState(state, previousShardIndex = null, options = null) {
  const centralState = pruneCentralState({...state});
  const taskGroupProjectIds = new Map((state.taskGroups || []).map((taskGroup) => [taskGroup.id, taskGroup.projectId]));
  const shardsByProject = new Map();
  const indexes = [];
  const unchangedProjectIds = new Set();
  const runtimeJson = stateStoreKind() !== "postgresql";
  const nextGeneration = runtimeJson ? runtimeJsonShardGeneration(state) : null;
  for (const collection of projectShardCollections) {
    const items = Array.isArray(state[collection]) ? state[collection] : [];
    const unscoped = [];
    for (const item of items) {
      const projectId = projectIdForCollectionItem(collection, item, taskGroupProjectIds);
      if (!projectId) {
        unscoped.push(item);
        continue;
      }
      const shard = ensureProjectShard(shardsByProject, projectId);
      shard.collections[collection] ||= [];
      shard.collections[collection].push(item);
    }
    centralState[collection] = unscoped;
  }
  for (const shard of shardsByProject.values()) {
    capProjectShardCollections(shard);
    if (nextGeneration) {
      const payloadDigest = digestProjectShardPayload(shard);
      const previous = previousShardIndex?.get(shard.projectId);
      const previousName = previous ? runtimeJsonShardNameFromIndexEntry(previous) : null;
      const reusable = previous &&
        previous.storagePayloadDigest === payloadDigest &&
        previousName &&
        options &&
        existsSync(join(options.runtimeDir, projectDbDirName, previousName));
      if (reusable) {
        shard.storageGeneration = previous.storageGeneration || "legacy";
        shard.storageName = previousName;
        shard.updatedAt = previous.updatedAt || shard.updatedAt;
        unchangedProjectIds.add(shard.projectId);
      } else {
        shard.storageGeneration = nextGeneration;
        shard.storageName = runtimeJsonProjectShardName(shard.projectId, nextGeneration);
      }
      shard.storagePayloadDigest = payloadDigest;
      shard.storagePayloadBytes = Buffer.byteLength(projectShardPayloadText(shard));
    }
    const collectionCounts = Object.fromEntries(projectShardCollections.map((collection) => [collection, shard.collections[collection]?.length || 0]));
    indexes.push({
      projectId: shard.projectId,
      storageKind: runtimeJson ? "project-json" : "postgresql-project-row",
      storageRef: runtimeJson
        ? `runtime://project-db/${shard.storageName}`
        : `postgresql://${projectShardTableName}/${shard.projectId}`,
      ...(shard.storageGeneration ? {storageGeneration: shard.storageGeneration} : {}),
      ...(shard.storagePayloadDigest ? {storagePayloadDigest: shard.storagePayloadDigest, storagePayloadBytes: shard.storagePayloadBytes} : {}),
      collectionCounts,
      updatedAt: shard.updatedAt
    });
  }
  centralState.projectStateShards = {
    schemaVersion: "project-state-shards/v1",
    externalizedCollections: projectShardCollections,
    projects: indexes.sort((left, right) => left.projectId.localeCompare(right.projectId)),
    updatedAt: new Date().toISOString()
  };
  return {centralState, projectShards: Array.from(shardsByProject.values()), unchangedProjectIds};
}

function runtimeJsonShardNameFromIndexEntry(entry) {
  const refName = String(entry.storageRef || "").split("/").pop();
  if (refName?.endsWith(".state.json")) return refName;
  if (entry.projectId && entry.storageGeneration) return runtimeJsonProjectShardName(entry.projectId, entry.storageGeneration);
  return null;
}

// Barrier-safe persist retention: these sharded collections gate the close/completion barrier (or are
// dereferenced by a live runtime), so the persist cap must never evict an OPEN item. A blind
// newest-by-time slice would drop an old-but-still-pending item and falsely satisfy the barrier
// (premature close), or evict evidence the barrier needs (unsatisfiable). Predicates mirror
// computeCompletionReadiness in control-plane-core.mjs — the barrier line is noted for each and the
// terminal literals are asserted in sync by scripts/validate-specs.rb.
const shardOpenPredicates = {
  workSessions: (item) => !["completed_objective", "failed", "closed", "recycled", "aborted"].includes(item.status), // core 2777
  humanConfirmationRequests: (item) => item.status === "pending", // core 2769
  humanDirectives: (item) => ["queued", "acknowledged"].includes(item.status), // core 2770
  repositoryOutputs: (item) => !["pushed", "committed", "rejected", "superseded"].includes(item.status), // core 2759
  // 谓词必须与 core 的门判据一致（core 2882/2997 现为 !["active","rejected","superseded"]），否则两边
  // 对"还在阻塞吗"的理解不同。但仅镜像门是不够的：指令包会被存活派发经 agentTaskContracts 解引用，
  // 淘汰掉一个仍被引用的包会让派发以 dispatch_package_incomplete(409) 失败（agent-gateway.mjs:1115）。
  // 故：门认为仍未了结的要留，被存活派发引用的也要留。
  effectiveInstructionPackets: (item, shard) => !["active", "rejected", "superseded"].includes(item.status)
    || (shard?.collections?.agentTaskContracts || []).some((contract) => contract.effectiveInstructionPacketRef === item.packetId), // core 2882/2997 + live deref
  // core 2761/2763 evidence dimension. NOTE: all_required_validation_present (core 2826) and
  // needsReviewBackfill (core 4514) also read checkpoints by workId regardless of evidence — those are
  // inert today (every "verified" work item carries a reviewBundleRef, so their guard is dead), so this
  // evidence-only predicate is safe. If a future path ever marks a work item verified WITHOUT a
  // reviewBundleRef, extend this predicate to also retain any checkpoint referenced by an open workId.
  checkpoints: (item) => Boolean(item.commitRefs?.length && item.pushRefs?.length && item.artifactManifestRefs?.length),
  // Defense-in-depth: these two are also open-item barriers; today their in-memory caps (capDispatchHistory
  // 240 / reconcileRoleDriftGuards open+200) keep them under the shard limit so the slice never runs, but
  // giving them predicates makes the persist layer independently barrier-safe if either in-memory cap changes.
  agentDispatches: (item) => !["completed", "failed", "cancelled"].includes(item.status), // core 2778
  roleDriftGuards: (item) => !["closed", "corrected"].includes(item.status) // core 2756
};

export function capProjectShardCollections(shard) {
  for (const collection of projectShardCollections) {
    const items = shard.collections[collection];
    if (!Array.isArray(items)) continue;
    const limit = projectShardCollectionLimits[collection] || 5000;
    if (items.length <= limit) continue;
    const sorted = items.slice().sort((left, right) => sortableTime(right) - sortableTime(left)); // newest first
    const isOpen = shardOpenPredicates[collection];
    if (!isOpen) {
      shard.collections[collection] = sorted.slice(0, limit);
      continue;
    }
    // Never evict an open/gating item; trim only the oldest non-open beyond the limit.
    const open = sorted.filter((item) => isOpen(item, shard));
    const closed = sorted.filter((item) => !isOpen(item, shard)).slice(0, Math.max(0, limit - open.length));
    shard.collections[collection] = [...open, ...closed];
  }
}

function sortableTime(item) {
  return new Date(item.updatedAt || item.createdAt || item.completedAt || item.issuedAt || item.sequence || 0).getTime() || 0;
}

function hydrateProjectState(centralState, options, preReadShards) {
  const state = {...centralState};
  for (const collection of projectShardCollections) {
    state[collection] = Array.isArray(state[collection]) ? [...state[collection]] : [];
  }
  const shards = preReadShards !== undefined
    ? preReadShards
    : (stateStoreKind() === "postgresql"
      ? readPostgresProjectShards(options)
      : readRuntimeJsonProjectShards(options, centralState));
  for (const shard of shards) {
    for (const collection of projectShardCollections) {
      const items = Array.isArray(shard.collections?.[collection]) ? shard.collections[collection] : [];
      if (items.length) state[collection].push(...items);
    }
  }
  return state;
}

function ensureProjectShard(shardsByProject, projectId) {
  if (!shardsByProject.has(projectId)) {
    const at = new Date().toISOString();
    shardsByProject.set(projectId, {
      schemaVersion: "project-state-shard/v1",
      projectId,
      collections: {},
      updatedAt: at
    });
  }
  return shardsByProject.get(projectId);
}

function projectIdForCollectionItem(collection, item, taskGroupProjectIds) {
  if (!item || typeof item !== "object") return null;
  if (item.projectId) return String(item.projectId);
  if (item.taskGroupId && taskGroupProjectIds.has(item.taskGroupId)) return String(taskGroupProjectIds.get(item.taskGroupId));
  if (collection === "progressSnapshots" && item.scopeType === "project") return String(item.scopeRef || "");
  if (collection === "progressSnapshots" && item.scopeType === "task_group" && taskGroupProjectIds.has(item.scopeRef)) return String(taskGroupProjectIds.get(item.scopeRef));
  return null;
}

function pruneCentralState(state) {
  state.idempotencyRecords = pruneIdempotencyRecords(state.idempotencyRecords || {});
  return state;
}

function pruneIdempotencyRecords(records) {
  const ttlMs = Math.max(60 * 60 * 1000, Number(process.env.AIMAC_IDEMPOTENCY_TTL_MS || 7 * 24 * 60 * 60 * 1000));
  const maxRecords = Math.max(100, Number(process.env.AIMAC_IDEMPOTENCY_MAX_RECORDS || 5000));
  const cutoff = Date.now() - ttlMs;
  return Object.fromEntries(
    Object.entries(records)
      .filter(([, record]) => !record.createdAt || new Date(record.createdAt).getTime() >= cutoff)
      .sort((left, right) => new Date(right[1].createdAt || 0).getTime() - new Date(left[1].createdAt || 0).getTime())
      .slice(0, maxRecords)
  );
}

function readRuntimeJsonProjectShards(options, centralState = {}) {
  const dir = join(options.runtimeDir, projectDbDirName);
  if (!existsSync(dir)) return [];
  const indexedMetadata = runtimeJsonShardMetadataFromCentral(centralState);
  const names = indexedMetadata
    ? [...indexedMetadata.keys()].filter((name) => name.endsWith(".state.json"))
    : readdirSync(dir).filter((name) => name.endsWith(".state.json"));
  return names
    .map((name) => {
      const indexedEntry = indexedMetadata?.get(name);
      try {
        const path = join(dir, name);
        if (!existsSync(path)) {
          if (indexedEntry) throw new Error(`project_state_shard_missing:${name}`);
          return null;
        }
        const source = readFileSync(path, "utf8");
        const shard = JSON.parse(source);
        const currentName = runtimeJsonProjectShardName(shard.projectId, shard.storageGeneration || "legacy");
        const stableName = `${safeProjectId(shard.projectId)}.state.json`;
        const legacyName = `${legacySafeProjectId(shard.projectId)}.state.json`;
        if (indexedEntry?.storagePayloadBytes && Number(indexedEntry.storagePayloadBytes) !== Number(shard.storagePayloadBytes || 0)) {
          throw new Error(`project_state_shard_payload_size_mismatch:${name}`);
        }
        if (indexedEntry?.storagePayloadDigest &&
            indexedEntry.storagePayloadDigest !== digestProjectShardPayload(shard) &&
            indexedEntry.storagePayloadDigest !== legacyDigestProjectShardPayload(shard)) {
          throw new Error(`project_state_shard_digest_mismatch:${name}`);
        }
        return name === currentName || name === stableName || name === legacyName ? shard : null;
      } catch (error) {
        if (indexedEntry) throw error;
        return null;
      }
    })
    .filter(Boolean);
}

function writeRuntimeJsonProjectShards(projectShards, options, unchangedProjectIds = new Set()) {
  const dir = join(options.runtimeDir, projectDbDirName);
  mkdirSync(dir, {recursive: true});
  assertUniqueSafeProjectIds(projectShards);
  const activeNames = new Set(projectShards.map((shard) => shard.storageName || runtimeJsonProjectShardName(shard.projectId, shard.storageGeneration || "legacy")));
  for (const shard of projectShards) {
    const path = join(dir, shard.storageName || runtimeJsonProjectShardName(shard.projectId, shard.storageGeneration || "legacy"));
    if (unchangedProjectIds.has(shard.projectId) && existsSync(path)) continue;
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    mkdirSync(dirname(path), {recursive: true});
    writeDurableFile(temporary, `${JSON.stringify(shard)}\n`);
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
  }
  return {activeNames};
}

// Reclaim leftover ".tmp-*" write temporaries (from an ENOSPC/crash between openSync and renameSync).
// Readers ignore them so there is no corruption, but they accumulate unbounded under repeated write
// failures. Only sweep ones older than 60s so a concurrent same-process in-flight write is never touched.
function sweepStaleTempFiles(dir) {
  if (!existsSync(dir)) return;
  const cutoff = Date.now() - 60000;
  for (const name of readdirSync(dir)) {
    if (!name.includes(".tmp-")) continue;
    const full = join(dir, name);
    try {
      if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
    } catch { /* raced with another sweep / already gone */ }
  }
}

function gcRuntimeJsonProjectShards(options, activeNames) {
  const dir = join(options.runtimeDir, projectDbDirName);
  sweepStaleTempFiles(dir);
  sweepStaleTempFiles(dirname(options.statePath));
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((item) => item.endsWith(".state.json"))) {
    if (!activeNames.has(name)) unlinkSync(join(dir, name));
  }
}

function assertUniqueSafeProjectIds(projectShards) {
  const seen = new Map();
  for (const shard of projectShards) {
    const safe = safeProjectId(shard.projectId);
    const existing = seen.get(safe);
    if (existing && existing !== shard.projectId) {
      throw new Error(`project_shard_safe_id_collision:${existing}:${shard.projectId}`);
    }
    seen.set(safe, shard.projectId);
  }
}

function writeRuntimeJsonCentralState(centralState, options) {
  const temporary = `${options.statePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  mkdirSync(dirname(options.statePath), {recursive: true});
  const pretty = process.env.AIMAC_RUNTIME_JSON_PRETTY === "true";
  writeDurableFile(temporary, `${pretty ? JSON.stringify(centralState, null, 2) : JSON.stringify(centralState)}\n`);
  renameSync(temporary, options.statePath);
  fsyncDirectory(dirname(options.statePath));
}

function safeProjectId(projectId) {
  const raw = String(projectId || "unknown");
  return `p_${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
}

function runtimeJsonShardGeneration(state) {
  return `sv${Number(state.stateVersion || 0)}-${randomBytes(6).toString("hex")}`;
}

function runtimeJsonProjectShardName(projectId, generation) {
  return `${safeProjectId(projectId)}.${String(generation || "legacy").replace(/[^A-Za-z0-9._-]+/gu, "_")}.state.json`;
}

function legacySafeProjectId(projectId) {
  const raw = String(projectId || "unknown");
  const safe = raw.replace(/[^A-Za-z0-9._-]+/gu, "_") || "unknown";
  if (safe === raw) return safe;
  return `${safe}-${createHash("sha256").update(raw).digest("hex").slice(0, 10)}`;
}

function runtimeJsonShardNamesFromCentral(centralState = {}) {
  const metadata = runtimeJsonShardMetadataFromCentral(centralState);
  return metadata ? new Set(metadata.keys()) : null;
}

function runtimeJsonShardMetadataFromCentral(centralState = {}) {
  const projects = centralState.projectStateShards?.projects;
  if (!Array.isArray(projects) || !projects.length) return null;
  const names = new Map();
  for (const entry of projects) {
    const refName = String(entry.storageRef || "").split("/").pop();
    if (refName?.endsWith(".state.json")) {
      names.set(refName, entry);
      continue;
    }
    if (entry.projectId && entry.storageGeneration) {
      names.set(runtimeJsonProjectShardName(entry.projectId, entry.storageGeneration), entry);
      continue;
    }
    if (entry.projectId) names.set(`${safeProjectId(entry.projectId)}.state.json`, {...entry, legacyStorageRef: true});
    if (entry.projectId) names.set(`${legacySafeProjectId(entry.projectId)}.state.json`, {...entry, legacyStorageRef: true});
  }
  return names;
}

function projectShardPayloadText(shard = {}) {
  const payload = {...shard};
  delete payload.storagePayloadDigest;
  delete payload.storagePayloadBytes;
  delete payload.storageGeneration;
  delete payload.storageName;
  delete payload.updatedAt;
  return JSON.stringify(payload);
}

function legacyProjectShardPayloadText(shard = {}) {
  const payload = {...shard};
  delete payload.storagePayloadDigest;
  delete payload.storagePayloadBytes;
  return JSON.stringify(payload);
}

function digestProjectShardPayload(shard = {}) {
  return `sha256:${createHash("sha256").update(projectShardPayloadText(shard)).digest("hex")}`;
}

function legacyDigestProjectShardPayload(shard = {}) {
  return `sha256:${createHash("sha256").update(legacyProjectShardPayloadText(shard)).digest("hex")}`;
}

function writeDurableFile(path, data) {
  const fd = openSync(path, "w", 0o600);
  try {
    writeFileSync(fd, data);
    if (process.env.AIMAC_RUNTIME_JSON_FSYNC !== "false") fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path) {
  if (process.env.AIMAC_RUNTIME_JSON_FSYNC === "false") return;
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {}
}

function withRuntimeJsonLock(options, fn) {
  const lockDir = `${options.statePath}.lock`;
  const deadline = Date.now() + 10000;
  while (true) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      clearStaleLock(lockDir);
      if (Date.now() > deadline) throw new Error(`state_store_lock_timeout:${lockDir}`);
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, {recursive: true, force: true});
  }
}

function clearStaleLock(lockDir) {
  try {
    if (Date.now() - statSync(lockDir).mtimeMs > lockTtlMs) {
      rmSync(lockDir, {recursive: true, force: true});
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function throwStateStoreConflict(message) {
  const error = new Error(message);
  error.code = "AIMAC_STATE_CONFLICT";
  throw error;
}
