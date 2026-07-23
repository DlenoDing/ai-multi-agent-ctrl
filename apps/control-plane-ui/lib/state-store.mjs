import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
  const central = stateStoreKind() === "postgresql"
    ? JSON.parse(readPostgresState(options))
    : JSON.parse(readFileSync(options.statePath, "utf8"));
  const state = hydrateProjectState(central, options);
  state.__loadedStateVersion = Number(state.stateVersion || 0);
  return state;
}

export function writeStoredState(state, options) {
  mkdirSync(options.runtimeDir, {recursive: true});
  const {centralState, projectShards} = externalizeProjectState(withoutInternalStateFields(state));
  if (stateStoreKind() === "postgresql") {
    writePostgresStateWithProjectShards(centralState, projectShards, options, options.expectedStateVersion);
    return;
  }
  withRuntimeJsonLock(options, () => {
    assertExpectedVersion(options.statePath, options.expectedStateVersion);
    writeRuntimeJsonProjectShards(projectShards, options);
    writeFileSync(options.statePath, `${JSON.stringify(centralState, null, 2)}\n`);
  });
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
    "), shard_upsert AS (",
    `INSERT INTO ${projectShardTableName} (project_id, shard, updated_at)`,
    "SELECT project_id, shard, now() FROM shard_payload WHERE EXISTS (SELECT 1 FROM central_upsert)",
    "ON CONFLICT (project_id) DO UPDATE SET shard = EXCLUDED.shard, updated_at = now()",
    "RETURNING project_id",
    ")"
  ].join("\n") : "";
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

function assertExpectedVersion(path, expectedStateVersion) {
  if (expectedStateVersion === undefined || expectedStateVersion === null || !existsSync(path)) return;
  const current = JSON.parse(readFileSync(path, "utf8"));
  if (Number(current.stateVersion || 0) !== Number(expectedStateVersion)) {
    throwStateStoreConflict(`runtime_json state version conflict; expected ${expectedStateVersion}, found ${current.stateVersion}`);
  }
}

function withoutInternalStateFields(state) {
  const clean = {...state};
  delete clean.__loadedStateVersion;
  return clean;
}

function externalizeProjectState(state) {
  const centralState = pruneCentralState({...state});
  const taskGroupProjectIds = new Map((state.taskGroups || []).map((taskGroup) => [taskGroup.id, taskGroup.projectId]));
  const shardsByProject = new Map();
  const indexes = [];
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
    const collectionCounts = Object.fromEntries(projectShardCollections.map((collection) => [collection, shard.collections[collection]?.length || 0]));
    indexes.push({
      projectId: shard.projectId,
      storageKind: stateStoreKind() === "postgresql" ? "postgresql-project-row" : "project-json",
      storageRef: stateStoreKind() === "postgresql"
        ? `postgresql://${projectShardTableName}/${shard.projectId}`
        : `runtime://project-db/${safeProjectId(shard.projectId)}.state.json`,
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
  return {centralState, projectShards: Array.from(shardsByProject.values())};
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
    : readRuntimeJsonProjectShards(options);
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

function readRuntimeJsonProjectShards(options) {
  const dir = join(options.runtimeDir, projectDbDirName);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".state.json"))
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(dir, name), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeRuntimeJsonProjectShards(projectShards, options) {
  const dir = join(options.runtimeDir, projectDbDirName);
  mkdirSync(dir, {recursive: true});
  for (const shard of projectShards) {
    const path = join(dir, `${safeProjectId(shard.projectId)}.state.json`);
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(temporary, `${JSON.stringify(shard, null, 2)}\n`, {mode: 0o600});
    renameSync(temporary, path);
  }
}

function safeProjectId(projectId) {
  return String(projectId || "unknown").replace(/[^A-Za-z0-9._-]+/gu, "_");
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
