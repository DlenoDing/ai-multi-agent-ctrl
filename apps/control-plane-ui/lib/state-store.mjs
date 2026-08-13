import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
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

// 认不出的存储名会被上面那行静默当成 runtime_json —— 而 postgres / postgresql 恰好是最容易
// 写错的一对。后果不是启动失败，是【启动成功但接在另一个存储上】：运维得到一个看起来正常、
// 实则空的控制面，在上面建的项目与账号，等他改回来之后全都不见，两份状态从此分叉。
// 同理 postgresql 但没给 DATABASE_URL 也会静默降级。
// 显式指定了什么就必须用什么，用不了就当场停 —— 与本仓其它地方一致：缺省不得等于有利结果。
const KNOWN_STATE_STORES = ["runtime_json", "postgresql"];
export function assertStateStoreConfig(env = process.env) {
  const configured = String(env.AIMAC_STATE_STORE || "").trim();
  if (!configured) return "runtime_json";
  if (!KNOWN_STATE_STORES.includes(configured)) {
    throw new Error(`AIMAC_STATE_STORE=${configured} 认不出来（可选：${KNOWN_STATE_STORES.join(" / ")}）`
      + " —— 拒绝按默认的 runtime_json 起来：那会让你接在另一个存储上，而一切看起来都正常");
  }
  if (configured === "postgresql" && !env.DATABASE_URL) {
    throw new Error("AIMAC_STATE_STORE=postgresql 但没有给 DATABASE_URL —— 拒绝退回本地 runtime_json："
      + "那会让你在一份空状态上工作，等配好数据库之后这段时间的改动全都不在里面");
  }
  return configured;
}

// 状态不存在时按种子建一份 —— 首次部署要的就是这个。但【跑着的时候】它消失再被重建，
// 意思完全不同：那是数据没了，系统却带着一份空状态继续服务，登录全失败而健康检查照样 ok。
// 两种情形在这个函数里长得一模一样，所以把"我刚重建过"记下来，交给调用方去判断严重性。
let lastRebuiltFromSeedAt = null;
export function consumeStateRebuildSignal() {
  const at = lastRebuiltFromSeedAt;
  lastRebuiltFromSeedAt = null;
  return at;
}

export function ensureStoredState(options) {
  mkdirSync(options.runtimeDir, {recursive: true});
  if (stateStoreKind() === "postgresql") {
    ensurePostgresTable(options);
    const row = readPostgresState(options);
    if (!row) {
      lastRebuiltFromSeedAt = new Date().toISOString();
      writeStoredState(options.buildInitialState(), options);
    }
    return;
  }
  if (!existsSync(options.statePath)) {
    lastRebuiltFromSeedAt = new Date().toISOString();
    writeStoredState(options.buildInitialState(), options);
  }
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
      const central = parseStateFile(options.statePath);
      assertStateSchemaSupported(central);
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
  assertStateSchemaSupported(first.central);
  const state = hydrateProjectState(first.central, options, first.shards);
  state.__loadedStateVersion = Number(state.stateVersion || 0);
  return state;
}

// 盘上的状态自带 schemaVersion，而此前【没有任何代码读过它】。
// 后果只有在版本真的变了那天才出现，而那天恰恰最不能容忍沉默：旧构建会把新格式
// 当成自己认识的东西照读照写，把它认不出来的语义悄悄改掉，而且是就地覆盖、没有回头路。
// 所以在读取点直接拒绝：认不出来就不开工，让人看到一句能照着做的话。
// 缺字段视为兼容（很多夹具与早期状态就没有这个字段），只拒绝【明确不同】的版本。
const SUPPORTED_STATE_SCHEMA_VERSIONS = new Set(["control-plane-runtime-state/v1"]);

function assertStateSchemaSupported(state) {
  const declared = state && typeof state === "object" ? state.schemaVersion : null;
  if (!declared || SUPPORTED_STATE_SCHEMA_VERSIONS.has(declared)) return state;
  throw Object.assign(
    new Error(`unsupported_state_schema_version:${declared}`),
    {code: "AIMAC_UNSUPPORTED_STATE_SCHEMA",
      hint: `盘上的状态是「${declared}」写的，这个构建只认 ${[...SUPPORTED_STATE_SCHEMA_VERSIONS].join(" / ")}。`
        + "请换回能读它的版本，或先做数据迁移 —— 用这个构建继续写会把它认不出来的部分改掉。"}
  );
}

export function readStoredCentralState(options) {
  ensureStoredState(options);
  if (stateStoreKind() !== "postgresql") {
    const cached = cachedStoredState(centralStateCache, options.statePath, () => statCacheKey(options.statePath));
    if (cached) {
      cached.__loadedStateVersion = Number(cached.stateVersion || 0);
      // 缓存命中这条分支也要打标记：否则"第一次读"的中央态拒得住、"第二次读"的拒不住，
      // 而缓存命中恰恰是常态 —— 这种半边生效的保护比没有更危险。
      cached.__centralOnly = true;
      return cached;
    }
  }
  const central = stateStoreKind() === "postgresql"
    ? readPostgresState()
    : parseStateFile(options.statePath);
  if (stateStoreKind() !== "postgresql") cacheStoredState(centralStateCache, options.statePath, central, statCacheKey(options.statePath));
  assertStateSchemaSupported(central);
  central.__loadedStateVersion = Number(central.stateVersion || 0);
  // 打上"这是中央态、不是完整状态"的标记：项目分片里的集合（任务组、派发、会话、确认单…）
  // 在这份对象里【是空的】。谁要是拿它去 writeStoredState，写入方会把不在列表里的分片行全删掉 ——
  // 等于把所有项目的数据清空。标记会在 withoutInternalStateFields 里被剥掉，不会写进盘。
  central.__centralOnly = true;
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
  // 中央态不是完整状态：它不含项目分片里的集合。拿它写回去会把全部项目分片删掉。
  // 这不是假想 —— PG 的 CAS 探针就这么清空过一次（当时靠既有 e2e 才发现）。
  // 在写入点直接拒绝，比在每个调用点提醒可靠。
  if (state && state.__centralOnly) {
    throw Object.assign(new Error("refusing_to_write_central_only_state"), {code: "AIMAC_CENTRAL_ONLY_WRITE"});
  }
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
    // 回收的判据是"不在本次写入的分片名单里就删文件"。于是任何一次【项目变少了的写入】
    // 都会静默抹掉那些项目的全部数据。旁边那道 __centralOnly 守卫防的是同一类事故的一种形态
    // （注释里写着 PG 的 CAS 探针真的这么清空过一次），但它盖不住"有项目、只是少了几个"：
    // MCP 与控制台都会造 scoped 副本（按项目过滤后的深拷贝），今天没有任何调用点把它写回去，
    // 而那是纪律不是机制 —— 写错一次的代价是别的租户的数据没了。
    // 产品里项目只会归档、不会被移除（全仓没有从 state.projects 里删元素的代码），
    // 所以"变少"必然是 bug；唯一合法的例外是重新初始化，它显式带上这个开关。
    const removedProjectIds = [...previousShardIndex.keys()]
      .filter((projectId) => !projectShards.some((shard) => shard.projectId === projectId));
    if (removedProjectIds.length && !options.allowProjectShardRemoval) {
      throw Object.assign(new Error(`refusing_to_drop_project_shards:${removedProjectIds.join(",")}`),
        {code: "AIMAC_PROJECT_SHARD_REMOVAL"});
    }
    const shardWrite = writeRuntimeJsonProjectShards(projectShards, options, unchangedProjectIds);
    writeRuntimeJsonCentralState(centralState, options);
    gcRuntimeJsonProjectShards(options, shardWrite.activeNames);
    cacheStoredState(centralStateCache, options.statePath, centralState, statCacheKey(options.statePath));
    cacheStoredState(hydratedStateCache, options.statePath, hydratedStateFromParts(centralState, projectShards), runtimeJsonStateCacheKey(options, centralState));
  });
}

function readCentralStateIfPresent(statePath) {
  if (!existsSync(statePath)) return null;
  return parseStateFile(statePath);
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
    // 规范化序列化是整条写路径最贵的一步（实测 2000 单元时占落盘 CPU 的 28%），而这里原先
    // 把同一份文本算了两遍：一次给摘要、一次给字节数。算一次，两处共用。
    const payloadText = projectShardPayloadText(shard);
    const payloadBytes = Buffer.byteLength(payloadText);
    if (nextGeneration) {
      const payloadDigest = digestOfProjectShardPayloadText(payloadText);
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
      shard.storagePayloadBytes = payloadBytes;
    }
    if (!nextGeneration) {
      // PostgreSQL 后端原先整段跳过（generation/文件名是 runtime_json 专有的），连带把摘要也跳过了 ——
      // 于是中央索引里没有任何可核对的东西，读取侧也就无从校验。runtime_json 有三道防篡改校验、
      // 还被 contract-check 钉着，而 PG 才是生产配置：有 DB 写权限的人可以直接改分片行，
      // 注入或删掉 taskGroup / dispatch / 人工确认单，控制面读出来完全无感。
      // generation 与文件名与它无关，摘要与字节数与后端无关。
      shard.storagePayloadDigest = digestOfProjectShardPayloadText(payloadText);
      shard.storagePayloadBytes = payloadBytes;
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
  // 判据是"未到终态"，不是"还没人答"。answered = 人已经作出、尚未被消费的决定：
  // 执行方要靠它拿到人决定了什么（agent-gateway 把 answered/consumed 一起打进内容包），
  // 消费还要走 ?consume=true 那一步。原先只保 pending，等于把人已经拍的板当成可淘汰的历史。
  // 终态镜像 spec/state-machines.yaml 的 HumanConfirmationRequest.terminal。
  humanConfirmationRequests: (item) => !["consumed", "expired", "cancelled"].includes(item.status),
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
  roleDriftGuards: (item) => !["closed", "corrected"].includes(item.status), // core 2756
  // 任务组是主实体，工作项内嵌在它里面 —— 淘汰一个任务组等于连同它的全部工作项一起删掉，
  // 而且它是【唯一】一个内存层完全不封顶的分片集合：其余集合都有 core 里的 cap 先行收口，
  // 只有任务组由人不断新建、从不收口，这道 2000 是它遇到的第一道也是唯一一道上限。
  // 原先走的是按 updatedAt 新→旧的盲切片，被删的正是"还开着但最久没动"的那批 ——
  // 也就是人正在等的那些。终态镜像 spec/state-machines.yaml 的 TaskGroup.terminal。
  taskGroups: (item) => !["closed", "aborted"].includes(item.status)
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
        // 解析失败要带上是【哪一个分片】：原样抛 SyntaxError 的话，调用方拿到的是一句
        // "Unexpected end of JSON input"，既不知道坏的是哪份，也不知道该去恢复哪个文件。
        // 同目录下已有 project_state_shard_missing:<name> 这种带名字的稳定码，这里对齐它。
        let shard;
        try { shard = JSON.parse(source); }
        catch { throw new Error(`project_state_shard_corrupt:${name}`); }
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

// 进程被硬杀时，写到一半的临时文件会永远留在盘上 —— 一次崩溃攒一个，没人会去删。
// 每次写入顺手清掉【属于已死进程】的那些：名字里带着写入者的 pid，判据是现成的。
function sweepOrphanTempFiles(statePath) {
  const directory = dirname(statePath);
  const prefix = `${basename(statePath)}.tmp-`;
  let names = [];
  try { names = readdirSync(directory); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const pid = Number(name.slice(prefix.length).split("-")[0] || 0);
    if (!pid || pid === process.pid) continue;
    try { process.kill(pid, 0); continue; } catch (error) { if (error?.code === "EPERM") continue; }
    try { rmSync(join(directory, name), {force: true}); } catch { /* 尽力而为 */ }
  }
}

function writeRuntimeJsonCentralState(centralState, options) {
  sweepOrphanTempFiles(options.statePath);
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
  return digestOfProjectShardPayloadText(projectShardPayloadText(shard));
}

// 摘要与字节数原先各自把同一份分片规范化一遍（实测占落盘 CPU 的 28%）。文本算一次、两处共用，
// 出摘要的口径必须与 digestProjectShardPayload 完全一致 —— 否则索引里记的摘要与盘上内容对不上，
// 完整性校验要么把正常数据锁在门外，要么把改过的数据放行。
export function digestOfProjectShardPayloadText(payloadText) {
  return `sha256:${createHash("sha256").update(payloadText).digest("hex")}`;
}

function legacyDigestProjectShardPayload(shard = {}) {
  return `sha256:${createHash("sha256").update(legacyProjectShardPayloadText(shard)).digest("hex")}`;
}

// 中央状态文件解析失败时，原样抛 SyntaxError 会让调用方只看到一句
// "Unterminated string in JSON at position 31584"：不知道坏的是哪个文件、也不知道下一步做什么。
// 给一个带文件名的稳定码，与分片那边 project_state_shard_corrupt:<name> 同规。
function parseStateFile(path) {
  const source = readFileSync(path, "utf8");
  try { return JSON.parse(source); }
  catch { throw new Error(`control_plane_state_corrupt:${basename(path)}`); }
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
  } catch (error) {
    // fsync 失败意味着这次写入【可能没有真的落到盘上】：机器一断电就丢。
    // 静默吞掉的话，系统会带着"以为已持久化"的假设继续跑，事后连线索都没有。
    // 不抛出（写入本身已经成功、抛出会把一次正常操作变成失败），但必须留下痕迹。
    process.stderr.write(`[state-store] fsync 失败，本次写入可能未真正落盘：${path}：${String(error?.message || error).slice(0, 200)}\n`);
  }
}

function withRuntimeJsonLock(options, fn) {
  const lockDir = `${options.statePath}.lock`;
  const deadline = Date.now() + 10000;
  while (true) {
    try {
      mkdirSync(lockDir);
      // 把持锁者写进锁里：进程被硬杀时锁目录会留下，而"谁持有它、它还活着吗"是唯一能
      // 安全破锁的依据。实测过后果 —— SIGKILL 之后重启的服务【再也写不进去】：
      // 连登录（它要写会话）都报 state_store_lock_timeout，系统等于废了，得有人手工删目录。
      // 原子写：这份文件【就是给别的进程读的】，而读者把"解析失败"与"还没写"当成同一种情况，
      // 据此给短宽限期 —— 撕裂读会让一个【活着的】持有者的锁被提前破掉。先写临时文件再改名。
      try {
        const ownerTemporary = join(lockDir, `owner.${process.pid}.tmp`);
        writeFileSync(ownerTemporary,
          JSON.stringify({pid: process.pid, host: hostname(), at: new Date().toISOString()}));
        renameSync(ownerTemporary, join(lockDir, "owner.json"));
      } catch { /* 锁已拿到，记不上持有者也不该让写入失败 */ }
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

function lockOwnerAlive(lockDir) {
  let owner = null;
  try { owner = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8")); } catch { return null; }
  const pid = Number(owner?.pid || 0);
  if (!pid) return null;
  // pid 只在本机有意义。运行目录若被两台机器共享（NFS 之类），拿本机的 pid 去判别人机器上的
  // 持有者，会把一把【活着的】锁判成死锁并破掉 —— 那正是这套锁要防的事。
  // 主机对不上就退回时间兜底：宁可等，也不能在另一台机器正在写的时候闯进去。
  if (owner.host && owner.host !== hostname()) return null;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function clearStaleLock(lockDir) {
  try {
    // 时间兜底原先是唯一判据，而它的阈值（30s）比获取锁的超时（10s）还长 ——
    // 清理永远等不到就先超时了，那段代码在实际中是死的。先按持锁进程是否还活着判：
    // 进程已死，锁就不可能还有人在用，立刻破。活着就老老实实等（真并发不该被破坏）。
    const alive = lockOwnerAlive(lockDir);
    if (alive === false) {
      rmSync(lockDir, {recursive: true, force: true});
      return;
    }
    // 判不出持有者，只可能是两种情况：锁刚被创建、owner.json 还没落盘（毫秒级窗口），
    // 或者创建它的进程正好死在这个窗口里。后者若只靠 30 秒的时间兜底，
    // 而获取锁的超时是 10 秒 —— 系统照样被锁死。给一个短宽限期：活着的持有者会在建好目录后
    // 立刻写下自己的 pid，宽限期一过还没有，就当它死在窗口里了。
    // 有 owner.json 但主机对不上 => 判不了，只能按完整的时间阈值等；
    // 没有 owner.json => 大概率是死在"建目录到写 pid"那个毫秒级窗口里，给短宽限期。
    let hasOwnerRecord = false;
    try { hasOwnerRecord = Boolean(JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"))?.pid); } catch { hasOwnerRecord = false; }
    const graceMs = hasOwnerRecord ? lockTtlMs : Math.min(2000, lockTtlMs);
    if (alive === null && Date.now() - statSync(lockDir).mtimeMs > graceMs) {
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
