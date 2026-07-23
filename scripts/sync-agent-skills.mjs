import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRuntimeCollections, syncSkillSource } from "../apps/control-plane-ui/lib/control-plane-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = resolve(root, process.env.AIMAC_RUNTIME_DIR || ".runtime");
const statePath = join(runtimeDir, "control-plane-state.json");
const seedPath = join(root, "data", "seed-state.json");
const sourceId = process.argv.find((arg) => arg.startsWith("--source="))?.split("=")[1] || "agency-agents-zh";

function loadState() {
  mkdirSync(runtimeDir, {recursive: true});
  if (existsSync(statePath)) return JSON.parse(readFileSync(statePath, "utf8"));
  return JSON.parse(readFileSync(seedPath, "utf8"));
}

function writeState(state) {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

const state = loadState();
ensureRuntimeCollections(state, {root, runtimeDir});
const result = syncSkillSource(state, sourceId, {root, runtimeDir});
state.auditLog.unshift({
  id: `audit_skill_sync_${Date.now()}`,
  at: new Date().toISOString(),
  actor: "skill-registry",
  action: "skill_source_sync",
  subject: `AgentSkillSource:${sourceId}`,
  result: "succeeded"
});
writeState(state);

console.log(`skill source synced: ${sourceId}`);
console.log(`role skills indexed: ${result.roleSkillCount}`);
console.log(`pinned commit: ${result.actualCommit}`);
