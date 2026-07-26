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
  return Number(process.env.AIMAC_PG_QUERY_TIMEOUT_MS || 60000);
}

function getBridge() {
  if (bridge) return bridge;
  const sig = new Int32Array(new SharedArrayBuffer(4));
  const channel = new MessageChannel();
  const worker = new Worker(new URL("./pg-pool-worker.mjs", import.meta.url), {
    workerData: {sig: sig.buffer, port: channel.port2},
    transferList: [channel.port2]
  });
  const state = {worker, port: channel.port1, sig, fatal: null};
  // A worker-level crash (e.g. pg import failure) would otherwise deadlock the
  // next Atomics.wait; record it so the following call throws instead of hanging.
  worker.on("error", (error) => { state.fatal = error; });
  worker.on("exit", (code) => { if (code !== 0 && !state.fatal) state.fatal = new Error(`pg worker exited with code ${code}`); });
  // Do not keep the process alive solely for the pool worker.
  worker.unref();
  channel.port1.unref();
  bridge = state;
  return bridge;
}

function call(op, args) {
  const active = getBridge();
  if (active.fatal) throw active.fatal;
  Atomics.store(active.sig, 0, 0);
  active.port.postMessage({op, args});
  const waitResult = Atomics.wait(active.sig, 0, 0, queryTimeoutMs());
  if (waitResult === "timed-out") {
    if (active.fatal) throw active.fatal;
    const error = new Error(`pg bridge timeout after ${queryTimeoutMs()}ms for op ${op}`);
    error.code = "AIMAC_PG_BRIDGE_TIMEOUT";
    throw error;
  }
  let received = receiveMessageOnPort(active.port);
  // Extremely rare: Atomics flag observed before the cross-thread message lands in
  // this port's queue. Spin briefly rather than returning a spurious null.
  for (let attempt = 0; attempt < 100000 && !received; attempt += 1) {
    received = receiveMessageOnPort(active.port);
  }
  if (!received) {
    if (active.fatal) throw active.fatal;
    throw new Error(`pg bridge: no response for op ${op}`);
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

export function pgWriteStateWithProjectShards(centralState, projectShards, expectedStateVersion) {
  const response = call("writeStateWithShards", {
    table: tableName,
    shardTable: projectShardTableName,
    stateId,
    central: JSON.stringify(centralState),
    shards: Array.isArray(projectShards) ? projectShards : [],
    expectedVersion: expectedStateVersion === undefined ? null : expectedStateVersion
  });
  if (response.conflict) {
    const error = new Error(`postgresql state version conflict; expected ${expectedStateVersion}`);
    error.code = "AIMAC_STATE_CONFLICT";
    throw error;
  }
}
