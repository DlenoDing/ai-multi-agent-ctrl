import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRuntimeCollections, syncSkillSource } from "../apps/control-plane-ui/lib/control-plane-core.mjs";
import { markRuntimeStorage, readStoredState, writeStoredState } from "../apps/control-plane-ui/lib/state-store.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = resolve(root, process.env.AIMAC_RUNTIME_DIR || ".runtime");
const statePath = join(runtimeDir, "control-plane-state.json");
const seedPath = join(root, "data", "seed-state.json");
const repositoryRoot = resolve(process.env.AIMAC_REPOSITORY_ROOT || root);
const executionProfile = process.env.AIMAC_EXECUTION_PROFILE || "production";
const sourceId = process.argv.find((arg) => arg.startsWith("--source="))?.split("=")[1] || "agency-agents-zh";

function buildInitialState() {
  const state = JSON.parse(readFileSync(seedPath, "utf8"));
  state.runtime.updatedAt = new Date().toISOString();
  state.runtime.executionProfile = executionProfile;
  ensureRuntimeCollections(state, {root: repositoryRoot, runtimeDir, executionProfile});
  markRuntimeStorage(state, ".runtime/control-plane-state.json");
  return state;
}

function stateStoreOptions(state) {
  return {
    root,
    runtimeDir,
    statePath,
    seedPath,
    buildInitialState,
    expectedStateVersion: state?.__loadedStateVersion
  };
}

mkdirSync(runtimeDir, {recursive: true});
const state = readStoredState(stateStoreOptions());
ensureRuntimeCollections(state, {root: repositoryRoot, runtimeDir, executionProfile});
const result = syncSkillSource(state, sourceId, {root, runtimeDir});
markRuntimeStorage(state, ".runtime/control-plane-state.json");
state.auditLog.unshift({
  id: `audit_skill_sync_${Date.now()}`,
  at: new Date().toISOString(),
  actor: "skill-registry",
  action: "skill_source_sync",
  subject: `AgentSkillSource:${sourceId}`,
  result: "succeeded"
});
writeStoredState(state, stateStoreOptions(state));

console.log(`skill source synced: ${sourceId}`);
console.log(`role skills indexed: ${result.roleSkillCount}`);
console.log(`pinned commit: ${result.actualCommit}`);
