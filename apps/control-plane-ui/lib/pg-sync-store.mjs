// Synchronous facade over the async pg.Pool that lives in pg-pool-worker.mjs.
//
// The whole state-store API (readStoredState/writeStoredState/...) is synchronous
// and is called synchronously from ~40 request handlers, core, and mcp. Converting
// them to async would ripple through the entire codebase. Instead we keep the
// synchronous contract and bridge to pg's asynchronous pool via a worker thread:
// the main thread posts a request, blocks on Atomics.wait against a shared flag,
// and drains the reply with receiveMessageOnPort once the worker signals. This
// matches the previous blocking model (execFileSync "psql" also blocked the main
// thread) while reusing pooled connections instead of forking a process per query.
import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";

const tableName = "aimac_control_plane_state";
const projectShardTableName = "aimac_project_state_shards";
const stateId = "default";

let bridge = null;

function queryTimeoutMs() {
  // Must be a finite positive millisecond count: a non-numeric env (NaN) would make Atomics.wait
  // block forever (ToNumber(NaN) -> +Infinity), and "0" would time out every call and churn workers.
  const n = Number(process.env.AIMAC_PG_QUERY_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 60000;
}

function getBridge() {
  if (bridge) return bridge;
  const sig = new Int32Array(new SharedArrayBuffer(4));
  const channel = new MessageChannel();
  const worker = new Worker(new URL("./pg-pool-worker.mjs", import.meta.url), {
    workerData: {sig: sig.buffer, port: channel.port2},
    transferList: [channel.port2]
  });
  const state = {worker, port: channel.port1, sig, fatal: null, seq: 0};
  // Record a worker-level crash (e.g. pg import failure) so the NEXT call throws immediately instead
  // of hanging. Note: a crash DURING an in-flight call is not observable here — the error/exit event
  // is queued and cannot run while the main thread is parked in Atomics.wait, so that call still waits
  // out the full queryTimeoutMs before throwing a bridge timeout. That is inherent to the sync bridge.
  // 桥自身死掉（子进程 error/exit）与 DB 不可用是同一类：瞬时、下一次调用 resetBridge 重开就恢复。
  // 打上 AIMAC_STATE_CONFLICT 之外的稳定码，让上层按「存储不可用」503 处理，而不是落成 500 server_error。
  worker.on("error", (error) => { if (error && !error.code) error.code = "AIMAC_PG_BRIDGE_FATAL"; state.fatal = error; });
  worker.on("exit", (code) => { if (code !== 0 && !state.fatal) state.fatal = Object.assign(new Error(`pg worker exited with code ${code}`), {code: "AIMAC_PG_BRIDGE_FATAL"}); });
  // Do not keep the process alive solely for the pool worker.
  worker.unref();
  channel.port1.unref();
  bridge = state;
  return bridge;
}

// On a query timeout the worker may still be mid-op and will later enqueue an orphaned response.
// Tear the whole bridge down (terminate the worker, drop the port with its queue) so the next call
// starts a fresh worker/pool and can never consume that stale message.
function resetBridge() {
  const active = bridge;
  bridge = null;
  if (!active) return;
  try { active.worker.terminate(); } catch { /* already gone */ }
  try { active.port.close(); } catch { /* already gone */ }
}

function call(op, args) {
  const active = getBridge();
  if (active.fatal) { resetBridge(); throw active.fatal; }
  const requestId = (active.seq += 1);
  Atomics.store(active.sig, 0, 0);
  active.port.postMessage({op, args, requestId});
  const waitResult = Atomics.wait(active.sig, 0, 0, queryTimeoutMs());
  if (waitResult === "timed-out") {
    const fatal = active.fatal;
    resetBridge();
    if (fatal) throw fatal;
    const error = new Error(`pg bridge timeout after ${queryTimeoutMs()}ms for op ${op}`);
    error.code = "AIMAC_PG_BRIDGE_TIMEOUT";
    throw error;
  }
  // Drain until the response correlated with THIS request. A message with an older requestId is a
  // stale response from a prior (e.g. spuriously-recovered) op and must be discarded, never returned.
  let received = null;
  for (let attempt = 0; attempt < 100000; attempt += 1) {
    const next = receiveMessageOnPort(active.port);
    if (!next) {
      if (received) break;
      continue;
    }
    if (next.message?.requestId === requestId) { received = next; break; }
    // else: stale/orphaned response — discard and keep draining.
  }
  if (!received) {
    if (active.fatal) { resetBridge(); throw active.fatal; }
    throw Object.assign(new Error(`pg bridge: no response for op ${op}`), {code: "AIMAC_PG_BRIDGE_FATAL"});
  }
  const response = received.message;
  if (!response.ok) {
    const error = new Error(response.error || "pg worker error");
    if (response.code) error.code = response.code;
    throw error;
  }
  return response;
}

export function pgEnsureTables() {
  call("ensureTables", {table: tableName, shardTable: projectShardTableName});
}

// Returns the parsed central-state object (jsonb decodes to a JS object), or null.
export function pgReadState() {
  return call("readState", {table: tableName, stateId}).value;
}

export function pgReadProjectShards() {
  return call("readShards", {shardTable: projectShardTableName}).value || [];
}

// Transactionally consistent read of central + all project shards ({central, shards}).
export function pgReadStateWithShards() {
  return call("readStateWithShards", {table: tableName, shardTable: projectShardTableName, stateId}).value || {central: null, shards: []};
}

// 分片必须是数组，"没传"绝不能被当成"一个都没有"。worker 对空数组的处理是 DELETE 掉整张分片表
// （零个项目时这是对的），于是一次静默强转就等于把全部项目分片连同中心状态一起提交掉。
// 同一个错误在 runtime_json 那边是 `for...of undefined` 当场抛错、零损失 —— 安全的那个行为
// 恰好落在没人在生产上跑的后端上。这里改成拒绝，让两个后端对同一个错误给出同一种反应。
export function assertProjectShardsArray(projectShards) {
  if (!Array.isArray(projectShards)) {
    throw Object.assign(
      new Error(`pg_write_requires_project_shard_array:${projectShards === undefined ? "undefined" : typeof projectShards}`),
      {code: "AIMAC_PG_SHARDS_NOT_ARRAY"}
    );
  }
  return projectShards;
}

export function pgWriteStateWithProjectShards(centralState, projectShards, expectedStateVersion) {
  const response = call("writeStateWithShards", {
    table: tableName,
    shardTable: projectShardTableName,
    stateId,
    central: JSON.stringify(centralState),
    shards: assertProjectShardsArray(projectShards),
    expectedVersion: expectedStateVersion === undefined ? null : expectedStateVersion
  });
  if (response.conflict) {
    const error = new Error(`postgresql state version conflict; expected ${expectedStateVersion}`);
    error.code = "AIMAC_STATE_CONFLICT";
    throw error;
  }
}
