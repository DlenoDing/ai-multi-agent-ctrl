import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digestOf, ensureRuntimeCollections } from "../apps/control-plane-ui/lib/control-plane-core.mjs";
import { markRuntimeStorage, stateStoreKind, storedStateExists, writeStoredState } from "../apps/control-plane-ui/lib/state-store.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = resolve(root, process.env.AIMAC_RUNTIME_DIR || ".runtime");
const statePath = join(runtimeDir, "control-plane-state.json");
const configPath = join(runtimeDir, "runtime-config.json");
const seedPath = join(root, "data", "seed-state.json");
const repositoryRoot = resolve(process.env.AIMAC_REPOSITORY_ROOT || root);
const executionProfile = process.env.AIMAC_EXECUTION_PROFILE || "production";
const force = process.argv.includes("--force");
const checkOnly = process.argv.includes("--check");

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function stateStoreOptions() {
  return {root, runtimeDir, statePath, seedPath, buildInitialState: buildState};
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
  state.runtime.executionProfile = executionProfile;
  ensureRuntimeCollections(state, {root: repositoryRoot, runtimeDir, endpoint: process.env.AIMAC_PUBLIC_URL || `http://${process.env.AIMAC_HOST || "127.0.0.1"}:${Number(process.env.AIMAC_PORT || 4317)}`, executionProfile});
  markRuntimeStorage(state, ".runtime/control-plane-state.json");
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
  const ready = storedStateExists(stateStoreOptions()) && existsSync(configPath);
  console.log(ready ? "runtime initialized" : "runtime not initialized");
  process.exit(ready ? 0 : 1);
}

if (!force && storedStateExists(stateStoreOptions())) {
  console.log(`runtime state already exists: ${stateStoreKind() === "postgresql" ? "postgresql://aimac_control_plane_state/default" : statePath}`);
} else {
  writeStoredState(buildState(), stateStoreOptions());
  console.log(`runtime state initialized: ${stateStoreKind() === "postgresql" ? "postgresql://aimac_control_plane_state/default" : statePath}`);
}

const existingConfig = existsSync(configPath) ? loadJson(configPath) : {};
const bootstrapToken = process.env.AIMAC_BOOTSTRAP_TOKEN || existingConfig.localBootstrapToken || randomBytes(24).toString("base64url");
const workspaceOwnerToken = process.env.AIMAC_WORKSPACE_OWNER_TOKEN || existingConfig.localAccountTokens?.acct_workspace_owner || randomBytes(24).toString("base64url");
const reviewerToken = process.env.AIMAC_REVIEWER_TOKEN || existingConfig.localAccountTokens?.acct_reviewer || randomBytes(24).toString("base64url");
const agentRuntimeToken = process.env.AIMAC_AGENT_RUNTIME_TOKEN || existingConfig.localAccountTokens?.acct_agent_runtime || randomBytes(24).toString("base64url");
const mcpServiceToken = process.env.AIMAC_MCP_SERVICE_TOKEN || existingConfig.localMcpServiceToken || randomBytes(32).toString("base64url");
writeJson(configPath, {
  schemaVersion: "runtime-local-config/v1",
  runtimeDir,
  statePath,
  repositoryRoot,
  executionProfile,
  host: process.env.AIMAC_HOST || "127.0.0.1",
  port: Number(process.env.AIMAC_PORT || 4317),
  publicUrl: process.env.AIMAC_PUBLIC_URL || existingConfig.publicUrl || null,
  databaseUrl: process.env.DATABASE_URL || null,
  stateStore: stateStoreKind(),
  bootstrapTokenConfigured: true,
  bootstrapTokenHash: digestOf(`bootstrap:${bootstrapToken}`),
  mcpServiceTokenHash: digestOf(`mcp-service:${mcpServiceToken}`),
  localAccountTokenHashes: {
    acct_workspace_owner: digestOf(`account:acct_workspace_owner:${workspaceOwnerToken}`),
    acct_reviewer: digestOf(`account:acct_reviewer:${reviewerToken}`),
    acct_agent_runtime: digestOf(`account:acct_agent_runtime:${agentRuntimeToken}`)
  },
  localBootstrapToken: process.env.AIMAC_BOOTSTRAP_TOKEN ? undefined : bootstrapToken,
  localMcpServiceToken: process.env.AIMAC_MCP_SERVICE_TOKEN ? undefined : mcpServiceToken,
  localAccountTokens: {
    ...(process.env.AIMAC_WORKSPACE_OWNER_TOKEN ? {} : {acct_workspace_owner: workspaceOwnerToken}),
    ...(process.env.AIMAC_REVIEWER_TOKEN ? {} : {acct_reviewer: reviewerToken}),
    ...(process.env.AIMAC_AGENT_RUNTIME_TOKEN ? {} : {acct_agent_runtime: agentRuntimeToken})
  },
  updatedAt: new Date().toISOString()
});

console.log("next: npm start");
console.log("mcp: hosted by npm start at $AIMAC_PUBLIC_URL/mcp");
console.log("agent: create a join token in the management console, then run the returned curl | sh command on the Agent host");
if (!process.env.AIMAC_BOOTSTRAP_TOKEN) {
  console.log(`local bootstrap token: ${bootstrapToken}`);
}
if (!process.env.AIMAC_WORKSPACE_OWNER_TOKEN) {
  console.log(`local workspace owner token: ${workspaceOwnerToken}`);
}
if (!process.env.AIMAC_MCP_SERVICE_TOKEN) {
  console.log(`central MCP service token: ${mcpServiceToken}`);
}
