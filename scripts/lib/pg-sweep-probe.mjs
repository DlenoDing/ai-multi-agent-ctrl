// PostgreSQL 后端的产出核对探针：经产品自己的 PG 读路径（readStoredState → pgReadStateWithShards → 水合）
// 把整份状态读出来，按各记录自己声明的规范扫一遍、再按状态机对一遍表，把结论打成一行 JSON 交给父进程。
// 为什么要有它：三套 e2e 都在 runtime_json 后端上扫产出，而生产用的是 PostgreSQL —— 分片按 project_id
// 读回再水合是另一条路，这条路读出来的记录此前从没被任何门按规范验过。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStoredState } from "../../apps/control-plane-ui/lib/state-store.mjs";
import { UNCOVERED_CEILINGS, sweepRecordsAgainstDeclaredSchemas } from "./schema-validate.mjs";
import { checkRecordStatusesAreDeclaredStates } from "./state-machine-states.mjs";

const root = process.cwd();
const runtimeDir = mkdtempSync(join(tmpdir(), "aimac-pg-sweep-"));
const state = readStoredState({root, runtimeDir, statePath: join(runtimeDir, "control-plane-state.json"),
  seedPath: join(root, "data/seed-state.json"),
  buildInitialState: () => { throw new Error("pg sweep probe: 期望读到 PostgreSQL 里的状态，却触发了初始状态创建"); }});
const sweep = sweepRecordsAgainstDeclaredSchemas(state, {specDir: join(root, "spec"), label: "docker 部署产出",
  minValidated: 50, maxUncovered: UNCOVERED_CEILINGS["docker 部署产出"]});
const states = checkRecordStatusesAreDeclaredStates(join(root, "spec/state-machines.yaml"), state, "docker 部署产出");
// 没有 schemaVersion 的记录要点名是哪几条（键、action/actor/id），否则父进程只知道"有一条漂了"、不知道是谁写的。
const samples = {};
for (const [collection, items] of Object.entries(state)) {
  if (!Array.isArray(items)) continue;
  const bare = items.filter((item) => item && typeof item === "object" && !item.schemaVersion).slice(0, 3)
    .map((item) => ({keys: Object.keys(item).slice(0, 12), id: item.id || item.accountId || item.requestId || null, action: item.action || null, actor: item.actor || null}));
  if (bare.length) samples[collection] = bare;
}
console.log(JSON.stringify({validated: sweep.validated, errors: [...sweep.errors, ...states.errors].slice(0, 20), samples,
  uncoveredNote: sweep.uncoveredNote, statesNote: states.note, stateVersion: state.stateVersion}));
