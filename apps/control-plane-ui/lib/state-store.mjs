import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pgEnsureTables, pgReadProjectShards, pgReadState, pgReadStateWithShards, pgWriteStateWithProjectShards } from "./pg-sync-store.mjs";

const tableName = "aimac_control_plane_state";
const projectShardTableName = "aimac_project_state_shards";
const stateId = "default";
const lockTtlMs = 30000;
const projectDbDirName = "project-db";
const projectShardCollections = [
  "taskGroups",
  "repositoryOutputs",
  "workSessions",
  "agentDispatches",
  "agentTaskContracts",
  "effectiveInstructionPackets",
  "roleDriftGuards",
  "checkpoints",
  "completionReadiness",
  "closeBarriers",
  "progressSnapshots",
  "agentControlCommands",
  "agentExecutionEvents",
  "humanConfirmationRequests",
  "humanDirectives"
];
const projectShardCollectionLimits = {
  taskGroups: 2000,
  repositoryOutputs: 5000,
  workSessions: 5000,
  agentDispatches: 5000,
  agentTaskContracts: 5000,
  effectiveInstructionPackets: 5000,
  roleDriftGuards: 5000,
  checkpoints: 5000,
  completionReadiness: 2000,
  closeBarriers: 2000,
  progressSnapshots: 5000,
  agentControlCommands: 5000,
  agentExecutionEvents: 1000,
  humanConfirmationRequests: 2000,
  humanDirectives: 2000
};

export function isStateStoreConflict(error) {
  return error?.code === "AIMAC_STATE_CONFLICT";
}

const hydratedStateCache = new Map();
const centralStateCache = new Map();

function statCacheKey(path) {
  try {
    const stat = statSync(path, {bigint: true});
    return `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
  } catch {
    return null;
  }
}

function runtimeJsonStateCacheKey(options, central) {
  const centralKey = statCacheKey(options.statePath);
  if (!centralKey) return null;
  const parts = [centralKey];
  for (const entry of central?.projectStateShards?.projects || []) {
    const name = runtimeJsonShardNameFromIndexEntry(entry);
    if (!name) return null;
    const shardKey = statCacheKey(join(options.runtimeDir, projectDbDirName, name));
    if (!shardKey) return null;
    parts.push(`${name}=${shardKey}`);
  }
  return parts.join("|");
}

function cacheStoredState(cache, statePath, value, key) {
  if (!key) return;
  cache.clear();
  cache.set(statePath, {key, value: structuredClone(value)});
}

function cachedStoredState(cache, statePath, keyBuilder) {
  const entry = cache.get(statePath);
  if (!entry) return null;
  const currentKey = keyBuilder(entry.value);
  if (!currentKey || entry.key !== currentKey) return null;
  return structuredClone(entry.value);
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
  if (stateStoreKind() === "postgresql") {
    // PG 分支自己做建表 + 一次读；不再走 ensureStoredState 里那次"只为判断存在性"的全量读。
    mkdirSync(options.runtimeDir, {recursive: true});
    ensurePostgresTable(options);
  } else {
    ensureStoredState(options);
  }
  if (stateStoreKind() !== "postgresql") {
    const cached = cachedStoredState(hydratedStateCache, options.statePath, (value) => runtimeJsonStateCacheKey(options, value));
    if (cached) {
      cached.__loadedStateVersion = Number(cached.stateVersion || 0);
      return cached;
    }
    return withRuntimeJsonLock(options, () => {
      const central = JSON.parse(readFileSync(options.statePath, "utf8"));
      const state = hydrateProjectState(central, options);
      cacheStoredState(hydratedStateCache, options.statePath, state, runtimeJsonStateCacheKey(options, central));
      state.__loadedStateVersion = Number(state.stateVersion || 0);
      return state;
    });
  }
  // 一次读，不是两次。原先这里先经 ensureStoredState 把整份中央文档读出来【只为判断这一行存不存在】，
  // 再由 pgReadStateWithShards 把同一行连同全部分片重新读一遍。中央文档实测已有 436KB，
  // 而每个 /api/* 请求（含 GET）都走这条路，一次 MCP 写工具调用还要再走两遍。
  // 行不存在这件事，读一次就知道了。
  const first = pgReadStateWithShards();
  if (!first.central) {
    writeStoredState(options.buildInitialState(), options);
    const seeded = pgReadStateWithShards();
    const seededState = hydrateProjectState(seeded.central, options, seeded.shards);
    seededState.__loadedStateVersion = Number(seededState.stateVersion || 0);
    return seededState;
  }
  const state = hydrateProjectState(first.central, options, first.shards);
  state.__loadedStateVersion = Number(state.stateVersion || 0);
  return state;
}

export function readStoredCentralState(options) {
  ensureStoredState(options);
  if (stateStoreKind() !== "postgresql") {
    const cached = cachedStoredState(centralStateCache, options.statePath, () => statCacheKey(options.statePath));
    if (cached) {
      cached.__loadedStateVersion = Number(cached.stateVersion || 0);
      return cached;
    }
  }
  const central = stateStoreKind() === "postgresql"
    ? readPostgresState()
    : JSON.parse(readFileSync(options.statePath, "utf8"));
  if (stateStoreKind() !== "postgresql") cacheStoredState(centralStateCache, options.statePath, central, statCacheKey(options.statePath));
  central.__loadedStateVersion = Number(central.stateVersion || 0);
  return central;
}

// 带着 expectedStateVersion 却没有推进版本号的写入，本身就是错的：CAS 断言的是"中央还停在我读到的
// 那个版本"，而如果我自己也不推进，那么在我之后写入的人拿着同一个期望值照样成立 —— 它会把我的改动
// 整份覆盖掉，而 CAS 全程什么都没察觉。scripts/sync-agent-skills.mjs 正是这样：技能同步结果会被
// 控制面的下一次写入静默丢弃，而且两个按 stateVersion 做键的缓存会继续返回同步前的旧视图。
//
// 拦在写入层而不是逐个脚本补递增：下一个新脚本会再忘一次，而这种丢失不报错、不留痕。
function assertStateVersionAdvanced(state, expectedStateVersion) {
  if (expectedStateVersion === undefined || expectedStateVersion === null) return;
  if (Number(state?.stateVersion || 0) > Number(expectedStateVersion)) return;
  const error = new Error(`state write did not advance stateVersion (still ${state?.stateVersion}) while asserting expected ${expectedStateVersion}`
    + " — a concurrent writer holding the same expected version would silently overwrite this change");
  error.code = "AIMAC_STATE_VERSION_NOT_ADVANCED";
  throw error;
}

export function writeStoredState(state, options) {
  mkdirSync(options.runtimeDir, {recursive: true});
  assertStateVersionAdvanced(state, options.expectedStateVersion);
  if (stateStoreKind() === "postgresql") {
    const {centralState, projectShards} = externalizeProjectState(withoutInternalStateFields(state));
    writePostgresStateWithProjectShards(centralState, projectShards, options, options.expectedStateVersion);
    return;
  }
  withRuntimeJsonLock(options, () => {
    const previousCentral = readCentralStateIfPresent(options.statePath);
    assertExpectedVersionFromCentral(previousCentral, options.expectedStateVersion);
    const previousShardIndex = new Map((previousCentral?.projectStateShards?.projects || []).map((entry) => [entry.projectId, entry]));
    const {centralState, projectShards, unchangedProjectIds} = externalizeProjectState(withoutInternalStateFields(state), previousShardIndex, options);
    const shardWrite = writeRuntimeJsonProjectShards(projectShards, options, unchangedProjectIds);
    writeRuntimeJsonCentralState(centralState, options);
    gcRuntimeJsonProjectShards(options, shardWrite.activeNames);
    cacheStoredState(centralStateCache, options.statePath, centralState, statCacheKey(options.statePath));
    cacheStoredState(hydratedStateCache, options.statePath, hydratedStateFromParts(centralState, projectShards), runtimeJsonStateCacheKey(options, centralState));
  });
}

function readCentralStateIfPresent(statePath) {
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function assertExpectedVersionFromCentral(central, expectedStateVersion) {
  if (expectedStateVersion === undefined || expectedStateVersion === null) return;
  // Fail CLOSED when the central file vanished between read and locked write (matches the Postgres CAS,
  // which conflicts on rowCount 0). A non-null expectedStateVersion means the caller read an existing
  // state; if it is now absent, silently succeeding would reset stateVersion and lose the guard.
  if (!central) {
    throwStateStoreConflict(`runtime_json state version conflict; expected ${expectedStateVersion}, central state absent`);
  }
  if (Number(central.stateVersion || 0) !== Number(expectedStateVersion)) {
    throwStateStoreConflict(`runtime_json state version conflict; expected ${expectedStateVersion}, found ${central.stateVersion}`);
  }
}

function hydratedStateFromParts(centralState, projectShards) {
  const state = {...centralState};
  for (const collection of projectShardCollections) {
    state[collection] = Array.isArray(state[collection]) ? [...state[collection]] : [];
  }
  const ordered = [...projectShards].sort((left, right) => String(left.projectId).localeCompare(String(right.projectId)));
  for (const shard of ordered) {
    for (const collection of projectShardCollections) {
      const items = Array.isArray(shard.collections?.[collection]) ? shard.collections[collection] : [];
      if (items.length) state[collection].push(...items);
    }
  }
  return state;
}

export function markRuntimeStorage(state, statePath = ".runtime/control-plane-state.json") {
  state.runtime ||= {};
  state.runtime.storage ||= {};
  state.runtime.storage.stateStore = stateStoreKind();
  state.runtime.storage.runtimeStatePath = stateStoreKind() === "postgresql" ? "postgresql://aimac_control_plane_state/default" : statePath;
  if (stateStoreKind() === "postgresql") state.runtime.storage.databaseUrlSecretRef = "env:DATABASE_URL";
  else delete state.runtime.storage.databaseUrlSecretRef;
}

// 建表语句每进程只需要跑一次。原先每一次 readStoredState 都跑两条 CREATE TABLE IF NOT EXISTS，
// 而 PG 桥用 Atomics.wait 在主线程上等回复 —— 每一次桥调用都会冻住定时器、WebSocket 心跳和
// 其他请求的 I/O 回调。每请求省下的往返，直接就是主线程少冻住的时间。
let postgresTablesEnsured = false;

function ensurePostgresTable() {
  if (postgresTablesEnsured) return;
  pgEnsureTables();
  postgresTablesEnsured = true;
}

// Returns the parsed central-state object (jsonb decodes to a JS object) or null.
function readPostgresState() {
  return pgReadState();
}

function writePostgresStateWithProjectShards(state, projectShards, options, expectedStateVersion) {
  pgWriteStateWithProjectShards(withoutInternalStateFields(state), projectShards, expectedStateVersion);
}

function readPostgresProjectShards() {
  ensurePostgresTable();
  return pgReadProjectShards();
}

// 与 runtime_json 那三道校验同一意图：中央索引记着每个分片的摘要与字节数，读出来的分片必须对得上。
// 失败一律抛错（fail-closed）—— 分片被改过而控制面照常运行，比读不出来危险得多。
export function assertProjectShardsMatchCentralIndex(shards, centralState) {
  const indexed = new Map((centralState?.projectStateShards?.projects || []).map((entry) => [entry.projectId, entry]));
  // 引导期中央索引为空时无需特判：下面两个循环都以索引为准，空索引自然什么都不查。
  // 原先这里有一句提前返回，突变测试证明它去掉之后行为完全不变 —— 一条无法被单独验证的守卫，
  // 留着只会让人以为这里有两道保护。
  for (const shard of shards) {
    const entry = indexed.get(shard.projectId);
    if (!entry) continue; // 索引里没有这个项目：由上层的可见性/租户过滤处理，不在完整性校验范围内
    if (entry.storagePayloadBytes && Number(entry.storagePayloadBytes) !== Number(shard.storagePayloadBytes || 0)) {
      throw new Error(`project_state_shard_payload_size_mismatch:${shard.projectId}`);
    }
    // 三路接受是【升级兼容】：插入序与旧版摘要来自本模块早期的两种写法，用于让升级后的第一次读取
    // 不至于把自己的存量存储判成被篡改。它有明确的退役条件，不是长期双路径：
    // externalizeProjectState 的复用判定比对的是【规范序】摘要（digestProjectShardPayload），
    // 旧格式必然不匹配 -> 该分片不可复用 -> 下一次写入必被重写为规范序。因此升级后完成一次写入周期，
    // 下面两条兼容分支即成为不可达代码，可以连同 insertionOrderDigest*/legacyDigest* 一并删除。
    // 【若有人把复用判定改成也接受旧格式摘要，这个退役条件当场失效、兼容路径变成永久的】——
    // 那属于 sys.scope-convergence 禁止的长期双路径，改动复用判定时必须同时处置这里。
    if (entry.storagePayloadDigest && entry.storagePayloadDigest !== digestProjectShardPayload(shard)
      && entry.storagePayloadDigest !== insertionOrderDigestProjectShardPayload(shard)
      && entry.storagePayloadDigest !== legacyDigestProjectShardPayload(shard)) {
      throw new Error(`project_state_shard_payload_digest_mismatch:${shard.projectId}`);
    }
  }
  // 索引里有、却一个分片都没读到：这是"分片被删掉"的形态，必须与被改写同等对待。
  const present = new Set(shards.map((shard) => shard.projectId));
  for (const [projectId, entry] of indexed) {
    if (entry.storagePayloadDigest && !present.has(projectId)) {
      throw new Error(`project_state_shard_missing:${projectId}`);
    }
  }
  return shards;
}

function withoutInternalStateFields(state) {
  const clean = {...state};
  for (const key of Object.keys(clean)) {
    if (key.startsWith("__")) delete clean[key];
  }
  return clean;
}

function externalizeProjectState(state, previousShardIndex = null, options = null) {
  const centralState = pruneCentralState({...state});
  const taskGroupProjectIds = new Map((state.taskGroups || []).map((taskGroup) => [taskGroup.id, taskGroup.projectId]));
  const shardsByProject = new Map();
  const indexes = [];
  const unchangedProjectIds = new Set();
  const runtimeJson = stateStoreKind() !== "postgresql";
  const nextGeneration = runtimeJson ? runtimeJsonShardGeneration(state) : null;
  for (const collection of projectShardCollections) {
    const items = Array.isArray(state[collection]) ? state[collection] : [];
    const unscoped = [];
    for (const item of items) {
      const projectId = projectIdForCollectionItem(collection, item, taskGroupProjectIds);
      if (!projectId) {
        unscoped.push(item);
        continue;
      }
      const shard = ensureProjectShard(shardsByProject, projectId);
      shard.collections[collection] ||= [];
      shard.collections[collection].push(item);
    }
    centralState[collection] = unscoped;
  }
  for (const shard of shardsByProject.values()) {
    capProjectShardCollections(shard);
    if (nextGeneration) {
      const payloadDigest = digestProjectShardPayload(shard);
      const previous = previousShardIndex?.get(shard.projectId);
      const previousName = previous ? runtimeJsonShardNameFromIndexEntry(previous) : null;
      const reusable = previous &&
        previous.storagePayloadDigest === payloadDigest &&
        previousName &&
        options &&
        existsSync(join(options.runtimeDir, projectDbDirName, previousName));
      if (reusable) {
        shard.storageGeneration = previous.storageGeneration || "legacy";
        shard.storageName = previousName;
        shard.updatedAt = previous.updatedAt || shard.updatedAt;
        unchangedProjectIds.add(shard.projectId);
      } else {
        shard.storageGeneration = nextGeneration;
        shard.storageName = runtimeJsonProjectShardName(shard.projectId, nextGeneration);
      }
      shard.storagePayloadDigest = payloadDigest;
      shard.storagePayloadBytes = Buffer.byteLength(projectShardPayloadText(shard));
    }
    if (!nextGeneration) {
      // PostgreSQL 后端原先整段跳过（generation/文件名是 runtime_json 专有的），连带把摘要也跳过了 ——
      // 于是中央索引里没有任何可核对的东西，读取侧也就无从校验。runtime_json 有三道防篡改校验、
      // 还被 contract-check 钉着，而 PG 才是生产配置：有 DB 写权限的人可以直接改分片行，
      // 注入或删掉 taskGroup / dispatch / 人工确认单，控制面读出来完全无感。
      // generation 与文件名与它无关，摘要与字节数与后端无关。
      shard.storagePayloadDigest = digestProjectShardPayload(shard);
      shard.storagePayloadBytes = Buffer.byteLength(projectShardPayloadText(shard));
    }
    const collectionCounts = Object.fromEntries(projectShardCollections.map((collection) => [collection, shard.collections[collection]?.length || 0]));
    indexes.push({
      projectId: shard.projectId,
      storageKind: runtimeJson ? "project-json" : "postgresql-project-row",
      storageRef: runtimeJson
        ? `runtime://project-db/${shard.storageName}`
        : `postgresql://${projectShardTableName}/${shard.projectId}`,
      ...(shard.storageGeneration ? {storageGeneration: shard.storageGeneration} : {}),
      ...(shard.storagePayloadDigest ? {storagePayloadDigest: shard.storagePayloadDigest, storagePayloadBytes: shard.storagePayloadBytes} : {}),
      collectionCounts,
      updatedAt: shard.updatedAt
    });
  }
  centralState.projectStateShards = {
    schemaVersion: "project-state-shards/v1",
    externalizedCollections: projectShardCollections,
    projects: indexes.sort((left, right) => left.projectId.localeCompare(right.projectId)),
    updatedAt: new Date().toISOString()
  };
  return {centralState, projectShards: Array.from(shardsByProject.values()), unchangedProjectIds};
}

function runtimeJsonShardNameFromIndexEntry(entry) {
  const refName = String(entry.storageRef || "").split("/").pop();
  if (refName?.endsWith(".state.json")) return refName;
  if (entry.projectId && entry.storageGeneration) return runtimeJsonProjectShardName(entry.projectId, entry.storageGeneration);
  return null;
}

// Barrier-safe persist retention: these sharded collections gate the close/completion barrier (or are
// dereferenced by a live runtime), so the persist cap must never evict an OPEN item. A blind
// newest-by-time slice would drop an old-but-still-pending item and falsely satisfy the barrier
// (premature close), or evict evidence the barrier needs (unsatisfiable). Predicates mirror
// computeCompletionReadiness in control-plane-core.mjs — the barrier line is noted for each and the
// terminal literals are asserted in sync by scripts/validate-specs.rb.
const shardOpenPredicates = {
  // state-store 不导入 core（避免循环依赖），所以这里是一份镜像 —— 由 contract-check 的
  // 终态漂移门钉住它与 core 的一致性，而不是靠人记得同步。
  workSessions: (item) => !["completed_objective", "recycled", "failed", "aborted"].includes(item.status), // 镜像 WORK_SESSION_SETTLED_STATUSES
  humanConfirmationRequests: (item) => item.status === "pending", // core 2769
  humanDirectives: (item) => ["queued", "acknowledged"].includes(item.status), // core 2770
  repositoryOutputs: (item) => !["pushed", "committed", "rejected", "superseded"].includes(item.status), // core 2759
  // 谓词必须与 core 的门判据一致（core 2882/2997 现为 !["active","rejected","superseded"]），否则两边
  // 对"还在阻塞吗"的理解不同。但仅镜像门是不够的：指令包会被存活派发经 agentTaskContracts 解引用，
  // 淘汰掉一个仍被引用的包会让派发以 dispatch_package_incomplete(409) 失败（agent-gateway.mjs:1115）。
  // 故：门认为仍未了结的要留，被存活派发引用的也要留。
  effectiveInstructionPackets: (item, shard) => !["active", "rejected", "superseded"].includes(item.status)
    || (shard?.collections?.agentTaskContracts || []).some((contract) => contract.effectiveInstructionPacketRef === item.packetId), // core 2882/2997 + live deref
  // core 2761/2763 evidence dimension. NOTE: all_required_validation_present (core 2826) and
  // needsReviewBackfill (core 4514) also read checkpoints by workId regardless of evidence — those are
  // inert today (every "verified" work item carries a reviewBundleRef, so their guard is dead), so this
  // evidence-only predicate is safe. If a future path ever marks a work item verified WITHOUT a
  // reviewBundleRef, extend this predicate to also retain any checkpoint referenced by an open workId.
  checkpoints: (item) => Boolean(item.commitRefs?.length && item.pushRefs?.length && item.artifactManifestRefs?.length),
  // Defense-in-depth: these two are also open-item barriers; today their in-memory caps (capDispatchHistory
  // 240 / reconcileRoleDriftGuards open+200) keep them under the shard limit so the slice never runs, but
  // giving them predicates makes the persist layer independently barrier-safe if either in-memory cap changes.
  // 内存层的 capAgentControlCommands 为了正确性【刻意】让 queued/delivered/received 突破 2000
  // 上限（淘汰掉活跃命令会让后续 ack 报 404、配对的 blocked 派发永远不被处理）。而这里原先没有
  // 对应谓词，走的是按 updatedAt 新→旧的盲切片，5000 处把最老的活跃命令直接扔掉 ——
  // 内存层为正确性突破上限，持久层转手就把它删了。两层必须对同一件事有同一个判断。
  agentControlCommands: (item) => ["queued", "delivered", "received"].includes(item.status),
  // 同一形状：capTaskContracts 保留活跃会话的合同突破 160，这里也需要对应谓词。
  agentTaskContracts: (item, shard) => (shard?.collections?.agentDispatches || [])
    .some((dispatch) => !["completed", "failed", "cancelled"].includes(dispatch.status)
      && dispatch.sessionId === item.sessionId && dispatch.runId === item.runId),
  agentDispatches: (item) => !["completed", "failed", "cancelled"].includes(item.status), // core 2778
  roleDriftGuards: (item) => !["closed", "corrected"].includes(item.status) // core 2756
};

export function capProjectShardCollections(shard) {
  for (const collection of projectShardCollections) {
    const items = shard.collections[collection];
    if (!Array.isArray(items)) continue;
    const limit = projectShardCollectionLimits[collection] || 5000;
    if (items.length <= limit) continue;
    const sorted = items.slice().sort((left, right) => sortableTime(right) - sortableTime(left)); // newest first
    const isOpen = shardOpenPredicates[collection];
    if (!isOpen) {
      shard.collections[collection] = sorted.slice(0, limit);
      continue;
    }
    // Never evict an open/gating item; trim only the oldest non-open beyond the limit.
    const open = sorted.filter((item) => isOpen(item, shard));
    const closed = sorted.filter((item) => !isOpen(item, shard)).slice(0, Math.max(0, limit - open.length));
    shard.collections[collection] = [...open, ...closed];
  }
}

function sortableTime(item) {
  return new Date(item.updatedAt || item.createdAt || item.completedAt || item.issuedAt || item.sequence || 0).getTime() || 0;
}

function hydrateProjectState(centralState, options, preReadShards) {
  const state = {...centralState};
  for (const collection of projectShardCollections) {
    state[collection] = Array.isArray(state[collection]) ? [...state[collection]] : [];
  }
  const shards = preReadShards !== undefined
    ? preReadShards
    : (stateStoreKind() === "postgresql"
      ? readPostgresProjectShards()
      : readRuntimeJsonProjectShards(options, centralState));
  // 校验放在【合并处】而不是读取函数里：PG 的主读路径走 pgReadStateWithShards() 再把分片当
  // preReadShards 传进来，根本不经过 readPostgresProjectShards —— 校验写在那里等于没写。
  // runtime_json 的三道校验在它自己的读取函数里完成，这里不重复。
  if (stateStoreKind() === "postgresql") assertProjectShardsMatchCentralIndex(shards, centralState);
  for (const shard of shards) {
    for (const collection of projectShardCollections) {
      const items = Array.isArray(shard.collections?.[collection]) ? shard.collections[collection] : [];
      if (items.length) state[collection].push(...items);
    }
  }
  return state;
}

function ensureProjectShard(shardsByProject, projectId) {
  if (!shardsByProject.has(projectId)) {
    const at = new Date().toISOString();
    shardsByProject.set(projectId, {
      schemaVersion: "project-state-shard/v1",
      projectId,
      collections: {},
      updatedAt: at
    });
  }
  return shardsByProject.get(projectId);
}

function projectIdForCollectionItem(collection, item, taskGroupProjectIds) {
  if (!item || typeof item !== "object") return null;
  if (item.projectId) return String(item.projectId);
  if (item.taskGroupId && taskGroupProjectIds.has(item.taskGroupId)) return String(taskGroupProjectIds.get(item.taskGroupId));
  if (collection === "progressSnapshots" && item.scopeType === "project") return String(item.scopeRef || "");
  if (collection === "progressSnapshots" && item.scopeType === "task_group" && taskGroupProjectIds.has(item.scopeRef)) return String(taskGroupProjectIds.get(item.scopeRef));
  return null;
}

function pruneCentralState(state) {
  state.idempotencyRecords = pruneIdempotencyRecords(state.idempotencyRecords || {});
  return state;
}

function pruneIdempotencyRecords(records) {
  const ttlMs = Math.max(60 * 60 * 1000, Number(process.env.AIMAC_IDEMPOTENCY_TTL_MS || 7 * 24 * 60 * 60 * 1000));
  const maxRecords = Math.max(100, Number(process.env.AIMAC_IDEMPOTENCY_MAX_RECORDS || 5000));
  const cutoff = Date.now() - ttlMs;
  return Object.fromEntries(
    Object.entries(records)
      .filter(([, record]) => !record.createdAt || new Date(record.createdAt).getTime() >= cutoff)
      .sort((left, right) => new Date(right[1].createdAt || 0).getTime() - new Date(left[1].createdAt || 0).getTime())
      .slice(0, maxRecords)
  );
}

function readRuntimeJsonProjectShards(options, centralState = {}) {
  const dir = join(options.runtimeDir, projectDbDirName);
  if (!existsSync(dir)) return [];
  const indexedMetadata = runtimeJsonShardMetadataFromCentral(centralState);
  const names = indexedMetadata
    ? [...indexedMetadata.keys()].filter((name) => name.endsWith(".state.json"))
    : readdirSync(dir).filter((name) => name.endsWith(".state.json"));
  return names
    .map((name) => {
      const indexedEntry = indexedMetadata?.get(name);
      try {
        const path = join(dir, name);
        if (!existsSync(path)) {
          if (indexedEntry) throw new Error(`project_state_shard_missing:${name}`);
          return null;
        }
        const source = readFileSync(path, "utf8");
        const shard = JSON.parse(source);
        const currentName = runtimeJsonProjectShardName(shard.projectId, shard.storageGeneration || "legacy");
        const stableName = `${safeProjectId(shard.projectId)}.state.json`;
        const legacyName = `${legacySafeProjectId(shard.projectId)}.state.json`;
        if (indexedEntry?.storagePayloadBytes && Number(indexedEntry.storagePayloadBytes) !== Number(shard.storagePayloadBytes || 0)) {
          throw new Error(`project_state_shard_payload_size_mismatch:${name}`);
        }
        if (indexedEntry?.storagePayloadDigest &&
            indexedEntry.storagePayloadDigest !== digestProjectShardPayload(shard) &&
            indexedEntry.storagePayloadDigest !== insertionOrderDigestProjectShardPayload(shard) &&
            indexedEntry.storagePayloadDigest !== legacyDigestProjectShardPayload(shard)) {
          throw new Error(`project_state_shard_digest_mismatch:${name}`);
        }
        return name === currentName || name === stableName || name === legacyName ? shard : null;
      } catch (error) {
        if (indexedEntry) throw error;
        return null;
      }
    })
    .filter(Boolean);
}

function writeRuntimeJsonProjectShards(projectShards, options, unchangedProjectIds = new Set()) {
  const dir = join(options.runtimeDir, projectDbDirName);
  mkdirSync(dir, {recursive: true});
  assertUniqueSafeProjectIds(projectShards);
  const activeNames = new Set(projectShards.map((shard) => shard.storageName || runtimeJsonProjectShardName(shard.projectId, shard.storageGeneration || "legacy")));
  for (const shard of projectShards) {
    const path = join(dir, shard.storageName || runtimeJsonProjectShardName(shard.projectId, shard.storageGeneration || "legacy"));
    if (unchangedProjectIds.has(shard.projectId) && existsSync(path)) continue;
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    mkdirSync(dirname(path), {recursive: true});
    writeDurableFile(temporary, `${JSON.stringify(shard)}\n`);
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
  }
  return {activeNames};
}

// Reclaim leftover ".tmp-*" write temporaries (from an ENOSPC/crash between openSync and renameSync).
// Readers ignore them so there is no corruption, but they accumulate unbounded under repeated write
// failures. Only sweep ones older than 60s so a concurrent same-process in-flight write is never touched.
function sweepStaleTempFiles(dir) {
  if (!existsSync(dir)) return;
  const cutoff = Date.now() - 60000;
  for (const name of readdirSync(dir)) {
    if (!name.includes(".tmp-")) continue;
    const full = join(dir, name);
    try {
      if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
    } catch { /* raced with another sweep / already gone */ }
  }
}

function gcRuntimeJsonProjectShards(options, activeNames) {
  const dir = join(options.runtimeDir, projectDbDirName);
  sweepStaleTempFiles(dir);
  sweepStaleTempFiles(dirname(options.statePath));
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((item) => item.endsWith(".state.json"))) {
    if (!activeNames.has(name)) unlinkSync(join(dir, name));
  }
}

function assertUniqueSafeProjectIds(projectShards) {
  const seen = new Map();
  for (const shard of projectShards) {
    const safe = safeProjectId(shard.projectId);
    const existing = seen.get(safe);
    if (existing && existing !== shard.projectId) {
      throw new Error(`project_shard_safe_id_collision:${existing}:${shard.projectId}`);
    }
    seen.set(safe, shard.projectId);
  }
}

function writeRuntimeJsonCentralState(centralState, options) {
  const temporary = `${options.statePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  mkdirSync(dirname(options.statePath), {recursive: true});
  const pretty = process.env.AIMAC_RUNTIME_JSON_PRETTY === "true";
  writeDurableFile(temporary, `${pretty ? JSON.stringify(centralState, null, 2) : JSON.stringify(centralState)}\n`);
  renameSync(temporary, options.statePath);
  fsyncDirectory(dirname(options.statePath));
}

function safeProjectId(projectId) {
  const raw = String(projectId || "unknown");
  return `p_${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
}

function runtimeJsonShardGeneration(state) {
  return `sv${Number(state.stateVersion || 0)}-${randomBytes(6).toString("hex")}`;
}

function runtimeJsonProjectShardName(projectId, generation) {
  return `${safeProjectId(projectId)}.${String(generation || "legacy").replace(/[^A-Za-z0-9._-]+/gu, "_")}.state.json`;
}

function legacySafeProjectId(projectId) {
  const raw = String(projectId || "unknown");
  const safe = raw.replace(/[^A-Za-z0-9._-]+/gu, "_") || "unknown";
  if (safe === raw) return safe;
  return `${safe}-${createHash("sha256").update(raw).digest("hex").slice(0, 10)}`;
}

function runtimeJsonShardNamesFromCentral(centralState = {}) {
  const metadata = runtimeJsonShardMetadataFromCentral(centralState);
  return metadata ? new Set(metadata.keys()) : null;
}

function runtimeJsonShardMetadataFromCentral(centralState = {}) {
  const projects = centralState.projectStateShards?.projects;
  if (!Array.isArray(projects) || !projects.length) return null;
  const names = new Map();
  for (const entry of projects) {
    const refName = String(entry.storageRef || "").split("/").pop();
    if (refName?.endsWith(".state.json")) {
      names.set(refName, entry);
      continue;
    }
    if (entry.projectId && entry.storageGeneration) {
      names.set(runtimeJsonProjectShardName(entry.projectId, entry.storageGeneration), entry);
      continue;
    }
    if (entry.projectId) names.set(`${safeProjectId(entry.projectId)}.state.json`, {...entry, legacyStorageRef: true});
    if (entry.projectId) names.set(`${legacySafeProjectId(entry.projectId)}.state.json`, {...entry, legacyStorageRef: true});
  }
  return names;
}

// 键序无关的规范化序列化。JSON.stringify 的键序取决于对象的插入顺序，而 PostgreSQL 的 jsonb
// **不保留键序**（存储时会规范化重排）。于是同一份分片写进 PG 再读回来，序列化结果不同、摘要对不上，
// 完整性校验把一次正常的往返判成篡改。runtime_json 是普通文件、键序原样保留，所以本地一直是绿的 ——
// 这个缺陷只有跑 PostgreSQL 的那条端到端能发现。
export function canonicalJson(value) {
  // 数组里的 undefined 与 JSON.stringify 一致：变成 null。
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (value && typeof value === "object") {
    // 【必须与 JSON.stringify 对齐】：它会【跳过】值为 undefined 的键，而落盘走的正是 JSON.stringify。
    // 第一版把这些键输出成 null，于是写入时按 canonical 记的字节数偏大，落盘后那些键消失，
    // 读回来重算自然对不上 —— 表现为分片"被篡改"。实测差 69 字节，就是这么来的。
    // 教训：一个"规范化"函数若与真正的序列化函数在任何一处语义不同，它规范化的就不是被存下来的东西。
    return `{${Object.keys(value).sort()
      .filter((key) => value[key] !== undefined && typeof value[key] !== "function" && typeof value[key] !== "symbol")
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function projectShardPayloadText(shard = {}) {
  const payload = {...shard};
  delete payload.storagePayloadDigest;
  delete payload.storagePayloadBytes;
  delete payload.storageGeneration;
  delete payload.storageName;
  delete payload.updatedAt;
  return canonicalJson(payload);
}

// 规范化之前写下的摘要（插入顺序序列化）。读取侧继续接受它，否则升级到规范化那一刻，
// 所有既有分片都会被判成被篡改 —— 一个把正常数据锁在门外的完整性校验，比没有更糟。
function insertionOrderProjectShardPayloadText(shard = {}) {
  const payload = {...shard};
  delete payload.storagePayloadDigest;
  delete payload.storagePayloadBytes;
  delete payload.storageGeneration;
  delete payload.storageName;
  delete payload.updatedAt;
  return JSON.stringify(payload);
}

function insertionOrderDigestProjectShardPayload(shard = {}) {
  return `sha256:${createHash("sha256").update(insertionOrderProjectShardPayloadText(shard)).digest("hex")}`;
}

function legacyProjectShardPayloadText(shard = {}) {
  const payload = {...shard};
  delete payload.storagePayloadDigest;
  delete payload.storagePayloadBytes;
  return JSON.stringify(payload);
}

export function digestProjectShardPayload(shard = {}) {
  return `sha256:${createHash("sha256").update(projectShardPayloadText(shard)).digest("hex")}`;
}

function legacyDigestProjectShardPayload(shard = {}) {
  return `sha256:${createHash("sha256").update(legacyProjectShardPayloadText(shard)).digest("hex")}`;
}

function writeDurableFile(path, data) {
  const fd = openSync(path, "w", 0o600);
  try {
    writeFileSync(fd, data);
    if (process.env.AIMAC_RUNTIME_JSON_FSYNC !== "false") fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path) {
  if (process.env.AIMAC_RUNTIME_JSON_FSYNC === "false") return;
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {}
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
