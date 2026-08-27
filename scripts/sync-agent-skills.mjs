import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRuntimeCollections, syncSkillSource } from "../apps/control-plane-ui/lib/control-plane-core.mjs";
import { markRuntimeStorage, readStoredState, writeStoredState } from "../apps/control-plane-ui/lib/state-store.mjs";
import { appendAuditEntry } from "../apps/control-plane-ui/lib/audit-ledger.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = resolve(root, process.env.AIMAC_RUNTIME_DIR || ".runtime");
const statePath = join(runtimeDir, "control-plane-state.json");
const seedPath = join(root, "data", "seed-state.json");
const repositoryRoot = resolve(process.env.AIMAC_REPOSITORY_ROOT || root);
const executionProfile = process.env.AIMAC_EXECUTION_PROFILE || "production";
// 参数名打错不能当成没给：--source 打错就静默同步默认那个源，人以为自己同步的是另一个。
// `--help` 是任何人敲的第一件事。此前它被当成打错的参数拒掉（非零退出、报错口吻）——
// 该说的内容本来就在下面那段里，只是以"你做错了"的姿态给出。同样的话，问的时候就该给。
const wantsHelp = process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h");
if (wantsHelp) {
  console.log("用法：npm run skills:sync [-- --source=<技能源 id>]");
  console.log("  · 认得的参数：--source=<技能源 id>（不给则用 agency-agents-zh）");
  process.exit(0);
}
const unknownFlags = process.argv.slice(2).filter((arg) => !arg.startsWith("--source=") && arg !== "--help" && arg !== "-h");
if (unknownFlags.length) {
  console.error(`sync-agent-skills: 认不出这些参数：${unknownFlags.join(" ")}`);
  console.error("  · 认得的参数：--source=<技能源 id>（不给则用 agency-agents-zh）");
  console.error("  · 打错会被当成没给，于是同步的是默认那个源 —— 所以这里拒绝，而不是替你猜");
  process.exit(2);
}
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
// 台账行要经共用构造走（schemaVersion / prevHash / rowHash）：手拼一条等于往哈希链里塞一行散的
//（init 那处同病，同日改掉）。
appendAuditEntry(state, {actor: "skill-registry", action: "skill_source_sync", subject: `AgentSkillSource:${sourceId}`, result: "succeeded"});
// 版本号必须自己推进：CAS 只断言"中央还是我读到的那个版本"，不推进的话，之后拿着同一个期望值
// 写入的人照样成立，会把这次同步整份覆盖掉 —— 而且按 stateVersion 做键的视图缓存不会失效。
state.stateVersion = Number(state.stateVersion || 0) + 1;
writeStoredState(state, stateStoreOptions(state));

console.log(`skill source synced: ${sourceId}`);
console.log(`role skills indexed: ${result.roleSkillCount}`);
console.log(`pinned commit: ${result.actualCommit}`);
