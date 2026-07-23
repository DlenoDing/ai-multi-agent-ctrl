import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tableName = "aimac_control_plane_state";
const stateId = "default";
const lockTtlMs = 30000;

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
  const state = stateStoreKind() === "postgresql"
    ? JSON.parse(readPostgresState(options))
    : JSON.parse(readFileSync(options.statePath, "utf8"));
  state.__loadedStateVersion = Number(state.stateVersion || 0);
  return state;
}

export function writeStoredState(state, options) {
  mkdirSync(options.runtimeDir, {recursive: true});
  if (stateStoreKind() === "postgresql") {
    writePostgresState(state, options, options.expectedStateVersion);
    return;
  }
  withRuntimeJsonLock(options, () => {
    assertExpectedVersion(options.statePath, options.expectedStateVersion);
    writeFileSync(options.statePath, `${JSON.stringify(withoutInternalStateFields(state), null, 2)}\n`);
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
