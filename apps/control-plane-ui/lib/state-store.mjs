import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tableName = "aimac_control_plane_state";
const stateId = "default";

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
  if (stateStoreKind() === "postgresql") {
    return JSON.parse(readPostgresState(options));
  }
  return JSON.parse(readFileSync(options.statePath, "utf8"));
}

export function writeStoredState(state, options) {
  mkdirSync(options.runtimeDir, {recursive: true});
  if (stateStoreKind() === "postgresql") {
    writePostgresState(state, options);
    return;
  }
  writeFileSync(options.statePath, `${JSON.stringify(state, null, 2)}\n`);
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

function writePostgresState(state, options) {
  const tag = `$aimac_${randomBytes(8).toString("hex")}$`;
  const sqlPath = join(options.runtimeDir, `.state-store-${Date.now()}-${randomBytes(4).toString("hex")}.sql`);
  const payload = JSON.stringify(state);
  writeFileSync(sqlPath, [
    `CREATE TABLE IF NOT EXISTS ${tableName} (id text PRIMARY KEY, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());`,
    `INSERT INTO ${tableName} (id, state, updated_at) VALUES ('${stateId}', ${tag}${payload}${tag}::jsonb, now())`,
    `ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now();`
  ].join("\n"));
  try {
    runPsqlFile(sqlPath, options);
  } finally {
    unlinkSync(sqlPath);
  }
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
