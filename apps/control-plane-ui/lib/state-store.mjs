import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  "agentExecutionEvents"
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
  agentExecutionEvents: 1000
};

export function isStateStoreConflict(error) {
  return error?.code === "AIMAC_STATE_CONFLICT";
}

const hydratedStateCache = new Map();
const centralStateCache = new Map();

function statCacheKey(path) {
  try {
    const stat = statSync(path);
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
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
  const central = JSON.parse(readPostgresState(options));
  const state = hydrateProjectState(central, options);
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
    ? JSON.parse(readPostgresState(options))
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
  if (expectedStateVersion === undefined || expectedStateVersion === null || !central) return;
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

function ensurePostgresTable(options) {
  runPsql([
    `CREATE TABLE IF NOT EXISTS ${tableName} (`,
    "id text PRIMARY KEY,",
    "state jsonb NOT NULL,",
    "updated_at timestamptz NOT NULL DEFAULT now()",
    ");",
    `CREATE TABLE IF NOT EXISTS ${projectShardTableName} (`,
    "project_id text PRIMARY KEY,",
    "shard jsonb NOT NULL,",
    "updated_at timestamptz NOT NULL DEFAULT now()",
    ");"
  ].join(" "), options);
}

function readPostgresState(options) {
  const output = runPsql(`SELECT state::text FROM ${tableName} WHERE id = '${stateId}';`, options, ["-t", "-A"]);
  const value = output.trim();
  return value.length ? value : null;
}

function writePostgresState(state, options, expectedStateVersion) {
  const tag = `$aimac_${randomBytes(8).toString("hex")}$`;
  const sqlPath = join(options.runtimeDir, `.state-store-${Date.now()}-${randomBytes(4).toString("hex")}.sql`);
  const payload = JSON.stringify(withoutInternalStateFields(state));
  const versionGuard = expectedStateVersion === undefined || expectedStateVersion === null
    ? ""
    : ` WHERE COALESCE((${tableName}.state->>'stateVersion')::bigint, 0) = ${Number(expectedStateVersion)}`;
  writeFileSync(sqlPath, [
    `CREATE TABLE IF NOT EXISTS ${tableName} (id text PRIMARY KEY, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());`,
    `INSERT INTO ${tableName} (id, state, updated_at) VALUES ('${stateId}', ${tag}${payload}${tag}::jsonb, now())`,
    `ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()${versionGuard};`
  ].join("\n"));
  try {
    const output = runPsqlFile(sqlPath, options);
    if (versionGuard && output.includes("INSERT 0 0")) {
      throwStateStoreConflict(`postgresql state version conflict; expected ${expectedStateVersion}`);
    }
  } finally {
    unlinkSync(sqlPath);
  }
}

function writePostgresStateWithProjectShards(state, projectShards, options, expectedStateVersion) {
  const tag = `$aimac_${randomBytes(8).toString("hex")}$`;
  const sqlPath = join(options.runtimeDir, `.state-store-${Date.now()}-${randomBytes(4).toString("hex")}.sql`);
  const payload = JSON.stringify(withoutInternalStateFields(state));
  const versionGuard = expectedStateVersion === undefined || expectedStateVersion === null
    ? "TRUE"
    : `COALESCE((${tableName}.state->>'stateVersion')::bigint, 0) = ${Number(expectedStateVersion)}`;
  const shardValues = projectShards.length
    ? projectShards.map((shard) => `(${sqlString(shard.projectId)}, ${tag}${JSON.stringify(shard)}${tag}::jsonb)`).join(",\n")
    : "";
  const shardSql = projectShards.length ? [
    ", shard_payload(project_id, shard) AS (",
    `VALUES ${shardValues}`,
    "), stale_shard_delete AS (",
    `DELETE FROM ${projectShardTableName}`,
    "WHERE EXISTS (SELECT 1 FROM central_upsert)",
    "AND project_id NOT IN (SELECT project_id FROM shard_payload)",
    "RETURNING project_id",
    "), shard_upsert AS (",
    `INSERT INTO ${projectShardTableName} (project_id, shard, updated_at)`,
    "SELECT project_id, shard, now() FROM shard_payload WHERE EXISTS (SELECT 1 FROM central_upsert)",
    "ON CONFLICT (project_id) DO UPDATE SET shard = EXCLUDED.shard, updated_at = now()",
    "RETURNING project_id",
    ")"
  ].join("\n") : [
    ", stale_shard_delete AS (",
    `DELETE FROM ${projectShardTableName}`,
    "WHERE EXISTS (SELECT 1 FROM central_upsert)",
    "RETURNING project_id",
    ")"
  ].join("\n");
  writeFileSync(sqlPath, [
    "BEGIN;",
    `CREATE TABLE IF NOT EXISTS ${tableName} (id text PRIMARY KEY, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());`,
    `CREATE TABLE IF NOT EXISTS ${projectShardTableName} (project_id text PRIMARY KEY, shard jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());`,
    "WITH central_upsert AS (",
    `INSERT INTO ${tableName} (id, state, updated_at) VALUES ('${stateId}', ${tag}${payload}${tag}::jsonb, now())`,
    `ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now() WHERE ${versionGuard}`,
    "RETURNING id",
    ")",
    shardSql,
    "SELECT CASE WHEN EXISTS (SELECT 1 FROM central_upsert) THEN 'AIMAC_WRITE_OK' ELSE 'AIMAC_WRITE_CONFLICT' END;",
    "COMMIT;"
  ].filter(Boolean).join("\n"));
  try {
    const output = runPsqlFile(sqlPath, options);
    if (output.includes("AIMAC_WRITE_CONFLICT")) {
      throwStateStoreConflict(`postgresql state version conflict; expected ${expectedStateVersion}`);
    }
  } finally {
    unlinkSync(sqlPath);
  }
}

function readPostgresProjectShards(options) {
  ensurePostgresTable(options);
  const output = runPsql(`SELECT COALESCE(jsonb_agg(shard ORDER BY project_id), '[]'::jsonb)::text FROM ${projectShardTableName};`, options, ["-t", "-A"]);
  const value = output.trim();
  return value.length ? JSON.parse(value) : [];
}

function writePostgresProjectShards(projectShards, options) {
  ensurePostgresTable(options);
  if (!projectShards.length) return;
  const tag = `$aimac_project_${randomBytes(8).toString("hex")}$`;
  const sqlPath = join(options.runtimeDir, `.project-state-store-${Date.now()}-${randomBytes(4).toString("hex")}.sql`);
  const statements = [
    `CREATE TABLE IF NOT EXISTS ${projectShardTableName} (project_id text PRIMARY KEY, shard jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());`
  ];
  for (const shard of projectShards) {
    statements.push([
      `INSERT INTO ${projectShardTableName} (project_id, shard, updated_at)`,
      `VALUES (${sqlString(shard.projectId)}, ${tag}${JSON.stringify(shard)}${tag}::jsonb, now())`,
      "ON CONFLICT (project_id) DO UPDATE SET shard = EXCLUDED.shard, updated_at = now();"
    ].join(" "));
  }
  writeFileSync(sqlPath, statements.join("\n"));
  try {
    runPsqlFile(sqlPath, options);
  } finally {
    unlinkSync(sqlPath);
  }
}

function withoutInternalStateFields(state) {
  const clean = {...state};
  delete clean.__loadedStateVersion;
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

function capProjectShardCollections(shard) {
  for (const collection of projectShardCollections) {
    const items = shard.collections[collection];
    if (!Array.isArray(items)) continue;
    const limit = projectShardCollectionLimits[collection] || 5000;
    if (items.length <= limit) continue;
    shard.collections[collection] = items
      .slice()
      .sort((left, right) => sortableTime(right) - sortableTime(left))
      .slice(0, limit);
  }
}

function sortableTime(item) {
  return new Date(item.updatedAt || item.createdAt || item.completedAt || item.issuedAt || item.sequence || 0).getTime() || 0;
}

function hydrateProjectState(centralState, options) {
  const state = {...centralState};
  for (const collection of projectShardCollections) {
    state[collection] = Array.isArray(state[collection]) ? [...state[collection]] : [];
  }
  const shards = stateStoreKind() === "postgresql"
    ? readPostgresProjectShards(options)
    : readRuntimeJsonProjectShards(options, centralState);
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

function gcRuntimeJsonProjectShards(options, activeNames) {
  const dir = join(options.runtimeDir, projectDbDirName);
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

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
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

function runPsql(sql, options, extraArgs = []) {
  return execFileSync("psql", [process.env.DATABASE_URL, "-v", "ON_ERROR_STOP=1", ...extraArgs, "-c", sql], {
    cwd: options.root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runPsqlFile(sqlPath, options) {
  return execFileSync("psql", [process.env.DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-f", sqlPath], {
    cwd: options.root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}
