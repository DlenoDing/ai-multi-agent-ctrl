import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = resolve(root, process.env.AIMAC_RUNTIME_DIR || ".runtime");
const statePath = join(runtimeDir, "control-plane-state.json");
const configPath = join(runtimeDir, "runtime-config.json");
const seedPath = join(root, "data", "seed-state.json");
const force = process.argv.includes("--force");
const checkOnly = process.argv.includes("--check");

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function buildState() {
  const state = loadJson(seedPath);
  const now = new Date().toISOString();
  const systemAdminEmail = process.env.AIMAC_SYSTEM_ADMIN_EMAIL || "system.admin@local";
  const systemAdminName = process.env.AIMAC_SYSTEM_ADMIN_NAME || "System Owner";
  const systemOwner = state.accounts.find((account) => account.accountId === "acct_system_owner");
  if (systemOwner) {
    systemOwner.email = systemAdminEmail;
    systemOwner.displayName = systemAdminName;
  }
  state.runtime.updatedAt = now;
  state.auditLog.unshift({
    id: `audit_bootstrap_${Date.now()}`,
    at: now,
    actor: "bootstrap",
    action: "runtime_initialized",
    subject: "RuntimeBootstrapProfile:runtime_local",
    result: "succeeded"
  });
  return state;
}

mkdirSync(runtimeDir, { recursive: true });

if (checkOnly) {
  const ready = existsSync(statePath) && existsSync(configPath);
  console.log(ready ? "runtime initialized" : "runtime not initialized");
  process.exit(ready ? 0 : 1);
}

if (!force && existsSync(statePath)) {
  console.log(`runtime state already exists: ${statePath}`);
} else {
  writeJson(statePath, buildState());
  console.log(`runtime state initialized: ${statePath}`);
}

writeJson(configPath, {
  schemaVersion: "runtime-local-config/v1",
  runtimeDir,
  statePath,
  host: process.env.AIMAC_HOST || "127.0.0.1",
  port: Number(process.env.AIMAC_PORT || 4317),
  databaseUrl: process.env.DATABASE_URL || null,
  bootstrapTokenConfigured: Boolean(process.env.AIMAC_BOOTSTRAP_TOKEN),
  updatedAt: new Date().toISOString()
});

console.log("next: npm start");
