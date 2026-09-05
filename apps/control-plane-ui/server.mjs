import { createServer } from "node:http";
import { clampEnvNumber } from "./lib/env-number.mjs";
import { WebSocketServer } from "ws";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { gzipSync } from "node:zlib";
import { accessSync, constants as fsConstants, appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, freemem, hostname, loadavg, platform, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AUDIT_LOG_CAP, appendAuditEntry, auditArchiveFault as sharedAuditArchiveFault, flushPendingAuditAppends as flushAuditArchive } from "./lib/audit-ledger.mjs";
import { json, jsonString, parseBody } from "./lib/http-utils.mjs";
import { mcpServiceAllowedTools, mcpServiceAllowlistNotice } from "./lib/mcp-service-allowlist.mjs";
import { createStaticAssetHandler } from "./lib/static-assets.mjs";
import { assertStateStoreConfig, consumeStateRebuildSignal, ensureStoredState, isStateStoreConflict, markRuntimeStorage, projectShardStorageFault, readStoredCentralState, readStoredState, stateStoreKind, writeStoredState } from "./lib/state-store.mjs";
import { appendProjectExecutionEvent, projectEventLogFault, projectExecutionEventStorageInfo, readProjectExecutionEventByKey, readProjectExecutionEvents } from "./lib/project-event-store.mjs";
import {
  authenticateAgentNode,
  authenticateExecutorPrincipal,
  recycleExpiredClaims,
  ackAgentControlCommand,
  buildExecutionContentBundle,
  claimNextDispatch,
  createAgentControlCommand,
  createAgentJoinToken,
  ensureAgentGatewayCollections,
  finishNodeDispatch,
  getDispatchForNode,
  getSkillWorkset,
  heartbeatAgentNode,
  isSafeGitRemoteUrl,
  listAgentControlCommands,
  listAgentJoinTokens,
  prepareAgentExecutionEvent,
  publicAgentNode,
  registerAgentNode,
  recordAgentExecutionEvent,
  requestAgentNodeRevocation,
  revokeDispatchMcpGrants,
  selfCheckAgentNode,
  validateDispatchClaim, nodeHeartbeatTimeoutMs, agentNodeHealthSummary} from "./lib/agent-gateway.mjs";
import { approvalResolve, assignWorkItem, handleMcpJsonRpc, isWriteTool, permissionResolve, createMcpToolDefinitions, mcpAuditFault } from "../mcp-server/server.mjs";
import {
  recordOrchestratorTickOutcome,
  canUseGitPath,
  acceptAgentCheckpoint,
  approvalRequestCreate,
  artifactRegister,
  claimLease,
  classifyDerivedTask,
  contractPublish,
  createExecutionTopology,
  advanceExecutionTopology,
  findingResolve,
  findingSubmit,
  policyDecisionEval,
  permissionRequestSubmit,
  releaseLease,
  reviewBundleRegister,
  reviewPlanCreate,
  roomSend,
  roomWait,
  ruleSourceResolve,
  ruleSourceSettle,
  collectRuntimeIssue,
  computeCloseBarrier,
  computeCompletionReadiness,
  computeProgressSnapshots,
  countInFlightDispatchesByProject, realtimePrincipalStillValid, operatorResolveDlqEntry,
  makeProjectScopePredicate,
  wipCapacityForProject,
  cancelPendingConfirmationsForDispatch,
  consumeHumanConfirmation,
  createHumanConfirmationRequest,
  createHumanDirective,
  createId,
  decideHumanConfirmation,
  decideSessionPlacement,
  defaultModelCapabilities,
  providerClasses,
  DEFAULT_ORGANIZATION_ID,
  digestOf,
  workItemCreateStatus,
  effectiveProjectConfig,
  effectiveTaskGroupConfig,
  ensureRuntimeCollections,
  gitHead,
  gitRemoteUrl,
  organizationOf,
  organizationQuotaCheck,
  pathAllowlistValid,
  recomputeOrganizationUsage,
  registerRoleSkillOverlay,
  normalizeTaskGroupLanguagePolicy,
  projectOwnerGrantPermissions,
  accountEffectivePermissions,
  ACCOUNT_ROLES,
  unknownAccountRoles,
  KNOWN_PERMISSIONS,
  unknownPermissions, consoleVocabularies,
  unknownOwnerRoles,
  runAgentRuntimeWorker,
  runAutonomousCycle,
  assertHumanTextWithinLimit,
  clampVisibleText,
  settleCellOwnedResources,
  runCommandLifecycle,
  selectModel,
  syncSkillSource,
  organizationMembershipOf,
  settleRuntimeIssuePatternForCandidate,
  retireSkillSource,
  updateTaskGroupLanguagePolicy,
  HUMAN_ACTOR_KEY,
  effectivePathDenylist,
  recordIdempotentResult,
  taskGroupRuntimeControlRefusal,
  nodeProjectsBeyondPermission,
  projectArchivedRefusal,
  idempotentReplayOutcome,
  recordCheckpointRejection,
  routeBlockedDispatchToHumanDecision,
  repositoryUrlRegisteredForProject,
  ROOM_SENDER_KEY,
  UNSAFE_DELEGATED_GRANT_PERMISSIONS,
  refreshConfirmationsAfterHumanChange,
  activeSharedDefinitionRefs,
  permissionsForRoleGrant,
  validateGrantRoleTemplate,
  retireAccount,
  revokeAccountSessions,
  validateDelegatedGrant,
  REGISTERED_OWNER_ROLES,
  normalizedExpiry,
  SHARED_DEFINITION_TYPES,
  SHARED_DEFINITION_CONFLICT_POLICIES,
  taskGroupSettledRejection,
  capKeepingReferenced,
  STRING_LIST_MAX_ITEMS,
  STRING_LIST_MAX_ITEM_LENGTH,
  projectRepositories,
  isSafeGitRef,
  noteWorkItemExecutionFailure, normalizePinnedModelId, newestWindow, dispatchContractSummary} from "./lib/control-plane-core.mjs";
import { isTerminalDispatchStatus } from "./lib/lifecycle-states.mjs";

// 真正绑上的端口（listen 回调写入）；localEndpoint 用它。放在模块顶部：读状态的路径在 listen 之前就会调它。
let boundPort = 0;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = resolve(process.env.AIMAC_REPOSITORY_ROOT || root);
const publicDir = join(root, "apps", "control-plane-ui", "public");
const runtimeDir = resolve(root, process.env.AIMAC_RUNTIME_DIR || ".runtime");
const statePath = join(runtimeDir, "control-plane-state.json");
const configPath = join(runtimeDir, "runtime-config.json");
const seedPath = join(root, "data", "seed-state.json");
// 存储层「读不出来」的故障码是【一族】，不是几个特例。原先健康页与错误出口各写死同一个三码白名单，
// 于是同族的码静默掉进兜底：control_plane_state_unrecognized（认不出的状态文件）与三种校验不符
// 都不在名单里 —— 写操作回的是 500 server_error 而不是 503 state_storage_corrupt，
// 健康页只说「没归到已知的几类」，而这两处恰恰是要告诉人「该去恢复哪一份」的地方。
// 改按家族前缀认，新增同族码自动在列。写入侧的拒绝（refusing_to_drop_project_shards、
// project_shard_safe_id_collision）与可重试的 state_store_lock_timeout 不在此列：它们各有出口，
// 归到「损坏、不可重试」会把话说错。判据 verifyStorageFaultCodesReachTheOperator 按 state-store
// 里的真实抛出点全量核对这两类的归属与中文说明。
const storageFaultCodePattern =
  /^(control_plane_state_[a-z_]+|project_state_shard_[a-z_]+|unsupported_(?:state|project_shard)_schema_version):(.+)$/u;
const agentInstallerPath = join(root, "scripts", "install-agent.sh");
const agentRuntimePath = join(root, "apps", "agent-runtime", "runtime.mjs");
const host = process.env.AIMAC_HOST || "127.0.0.1";
const port = clampEnvNumber(process.env.AIMAC_PORT, 0, 4317);
const executionProfile = process.env.AIMAC_EXECUTION_PROFILE || "production";
const stateViewCache = new Map();
const stateViewCacheTtlMs = clampEnvNumber(process.env.AIMAC_STATE_VIEW_CACHE_TTL_MS, 0, 60000);
const stateViewMaxEntries = clampEnvNumber(process.env.AIMAC_STATE_VIEW_CACHE_MAX_ENTRIES, 0, 200);
const agentControlWaitFanout = new Map();
const projectExecutionWaitFanout = new Map();
const longPollWaiters = new Map();
// WebSocket clients subscribed to real-time wake channels (see /api/realtime). Wake frames carry
// no payload; the client re-fetches through the existing authenticated + tenant-scoped endpoints.
const realtimeClients = new Set();

const unsafeSecretValues = new Set([
  "",
  "change-this-bootstrap-token",
  "change-this-mcp-service-token",
  "change-this-local-workspace-owner-token",
  "change-this-local-reviewer-token",
  "change-this-local-agent-runtime-token"
]);


function now() {
  return new Date().toISOString();
}

function ensureState() {
  mkdirSync(runtimeDir, { recursive: true });
  ensureRuntimeConfig();
  ensureStoredState({root, runtimeDir, statePath, seedPath, buildInitialState});
}

// 读 JSON 文件时把【哪个文件、它是干什么的、下一步怎么办】一起说清。
// 原先是裸 JSON.parse：人手改过 runtime-config.json 之后，启动只吐一句
// "Expected property name or '}' in JSON at position 2" —— 连是哪个文件都没有，
// 而这套部署里同时有三份 JSON（运行时配置 / 中央状态 / 种子）。
function readJsonFile(path, what, nextStep) {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    const detail = String(error.message || error).slice(0, 120);
    throw new Error(`${what}读不出来（不是合法 JSON）：${path}\n  · 解析器说：${detail}\n  · ${nextStep}`);
  }
}
const SEED_NEXT_STEP = "这份文件随发行版一起分发 —— 它坏了通常说明安装包不完整，重新拉取一份";
const CONFIG_NEXT_STEP = "它由 npm run init 生成，可以直接删掉让下一次启动重新生成（里面的本地令牌会换一批）";

function buildInitialState() {
  const seed = readJsonFile(seedPath, "种子数据", SEED_NEXT_STEP);
  seed.runtime.updatedAt = now();
  seed.runtime.executionProfile = executionProfile;
  ensureRuntimeCollections(seed, {root: repositoryRoot, runtimeDir, endpoint: process.env.AIMAC_PUBLIC_URL || localEndpoint(), executionProfile});
  markRuntimeStorage(seed, ".runtime/control-plane-state.json");
  return seed;
}

function ensureRuntimeConfig() {
  mkdirSync(runtimeDir, { recursive: true });
  const existing = existsSync(configPath) ? readJsonFile(configPath, "运行时配置", CONFIG_NEXT_STEP) : {};
  const localToken = process.env.AIMAC_BOOTSTRAP_TOKEN || existing.localBootstrapToken || randomBytes(24).toString("base64url");
  const workspaceOwnerTokenEnv = process.env.AIMAC_LOCAL_SEED_WORKSPACE_OWNER_TOKEN;
  const reviewerTokenEnv = process.env.AIMAC_LOCAL_SEED_REVIEWER_TOKEN;
  const agentRuntimeTokenEnv = process.env.AIMAC_LOCAL_SEED_AGENT_RUNTIME_TOKEN;
  const workspaceOwnerToken = workspaceOwnerTokenEnv || existing.localAccountTokens?.acct_workspace_owner || randomBytes(24).toString("base64url");
  const reviewerToken = reviewerTokenEnv || existing.localAccountTokens?.acct_reviewer || randomBytes(24).toString("base64url");
  const agentRuntimeToken = agentRuntimeTokenEnv || existing.localAccountTokens?.acct_agent_runtime || randomBytes(24).toString("base64url");
  const mcpServiceToken = process.env.AIMAC_MCP_SERVICE_TOKEN || existing.localMcpServiceToken || randomBytes(32).toString("base64url");
  const localAccountTokenHashes = {
    acct_workspace_owner: digestOf(`account:acct_workspace_owner:${workspaceOwnerToken}`),
    acct_reviewer: digestOf(`account:acct_reviewer:${reviewerToken}`),
    acct_agent_runtime: digestOf(`account:acct_agent_runtime:${agentRuntimeToken}`)
  };
  const localAccountTokens = {
    ...(workspaceOwnerTokenEnv ? {} : {acct_workspace_owner: workspaceOwnerToken}),
    ...(reviewerTokenEnv ? {} : {acct_reviewer: reviewerToken}),
    ...(agentRuntimeTokenEnv ? {} : {acct_agent_runtime: agentRuntimeToken})
  };
  const config = {
    schemaVersion: "runtime-local-config/v1",
    runtimeDir,
    statePath,
    repositoryRoot,
    executionProfile,
    host,
    port,
    publicUrl: process.env.AIMAC_PUBLIC_URL || existing.publicUrl || null,
    databaseUrl: process.env.DATABASE_URL || existing.databaseUrl || null,
    stateStore: stateStoreKind(),
    bootstrapTokenHash: digestOf(`bootstrap:${localToken}`),
    bootstrapTokenConfigured: true,
    mcpServiceTokenHash: digestOf(`mcp-service:${mcpServiceToken}`),
    localAccountTokenHashes,
    localBootstrapToken: process.env.AIMAC_BOOTSTRAP_TOKEN ? undefined : localToken,
    localMcpServiceToken: process.env.AIMAC_MCP_SERVICE_TOKEN ? undefined : mcpServiceToken,
    localAccountTokens,
    updatedAt: existing.updatedAt || now()
  };
  const comparableExisting = {...existing, updatedAt: config.updatedAt};
  if (!existsSync(configPath) || JSON.stringify(comparableExisting) !== JSON.stringify(config)) {
    config.updatedAt = now();
    // 原子写：先写临时文件再改名。原先直接 writeFileSync，两个进程共用同一个 runtime 目录时
    // （多副本、或本机起了两份），另一个进程会读到【只写了一半】的 JSON，
    // 于是 readState → ensureRuntimeConfig → JSON.parse 抛 "Unexpected end of JSON input"，
    // 表现为随机 500。状态文件早就是"临时文件+改名"了，这一份配置漏了 —— 同一形状只做了一半。
    const temporary = `${configPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`);
    renameSync(temporary, configPath);
  }
  return config;
}

function readRuntimeConfig() {
  if (!existsSync(configPath)) return ensureRuntimeConfig();
  return readJsonFile(configPath, "运行时配置", CONFIG_NEXT_STEP);
}

// 邮箱比对一律走这里。域名部分本来就不区分大小写，而手机键盘默认把首字母大写 ——
// 严格比较会让人用自己的邮箱登不进来，回的还是一句 invalid_credentials（有意不透露账号是否存在），
// 于是人完全看不出问题出在大小写上。粘贴时带的首尾空格同理。
// 登录查找与"是否已注册"必须用【同一个口径】：只改一边，就会出现两个只差大小写的账号，
// 而登录时不知道该匹配谁。存储里仍保留本人填写的原样，只在比对时归一。
function normalizedEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function sameEmail(left, right) {
  return normalizedEmail(left) === normalizedEmail(right) && normalizedEmail(left) !== "";
}

function assertRuntimeSecurity() {
  for (const envName of [
    "AIMAC_BOOTSTRAP_TOKEN",
    "AIMAC_MCP_SERVICE_TOKEN",
    "AIMAC_LOCAL_SEED_WORKSPACE_OWNER_TOKEN",
    "AIMAC_LOCAL_SEED_REVIEWER_TOKEN",
    "AIMAC_LOCAL_SEED_AGENT_RUNTIME_TOKEN"
  ]) {
    if (process.env[envName] !== undefined && weakSecret(process.env[envName])) {
      // 只说长度，绝不回显密钥本身 —— 启动日志常被贴进工单。
      throw startupError(`${envName} 这个密钥不安全，拒绝启动`, [
        "要求：至少 20 个字符，且不能是示例/占位值",
        `当前给的是 ${String(process.env[envName]).trim().length} 个字符`,
        `生成一个：node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"`
      ]);
    }
  }
  const configuredPublicUrl = process.env.AIMAC_PUBLIC_URL || readRuntimeConfig().publicUrl || "";
  if (host === "0.0.0.0" && !configuredPublicUrl) {
    throw startupError("对外监听（0.0.0.0）时必须给 AIMAC_PUBLIC_URL", [
      "agent 和 MCP 客户端要靠这个地址回连，服务自己猜不出对外该是什么地址",
      "例：AIMAC_PUBLIC_URL=https://aimac.example.com",
      "只在本机用就把 AIMAC_HOST 留空（默认 127.0.0.1），不需要这个变量"
    ]);
  }
  if (configuredPublicUrl) {
    let parsed;
    try {
      parsed = new URL(configuredPublicUrl);
    } catch {
      // 原先这里直接冒出 node:internal/url 的崩溃栈，连是哪个变量都不说。
      throw startupError(`AIMAC_PUBLIC_URL 不是一个合法的 URL：${configuredPublicUrl}`, [
        "要带协议，形如 https://aimac.example.com",
        "它也可能来自运行时配置文件里的 publicUrl"
      ]);
    }
    if (parsed.protocol !== "https:" && !isLocalHostname(parsed.hostname) && process.env.AIMAC_ALLOW_INSECURE_PUBLIC_URL !== "true") {
      throw startupError(`AIMAC_PUBLIC_URL 用的是 ${parsed.protocol}// 而主机 ${parsed.hostname} 不是本机，拒绝启动`, [
        "入网票和 Bearer 令牌都会走这个地址，明文传输等于把它们交出去",
        "本机地址（127.0.0.1 / localhost / ::1）不受此限",
        "隔离环境下确要放行：AIMAC_ALLOW_INSECURE_PUBLIC_URL=true"
      ]);
    }
  }
}

// 启动期的失败是运维最常撞到的一刻（npm start 起不来）。这一族此前全是裸 throw ——
// 人看到的是一段 Node 崩溃栈加一个机器码，既不说规则是什么，也不说下一步。
// 与 [state-store] / [startup] 端口那几条同规：一句人话 + 下一步，退出码 1。
// 写不进磁盘的那句话只有这一份：健康检查的 hint、写请求的 message、stderr 三处共用。
const STORAGE_UNAVAILABLE_HINT = "状态写不进磁盘（读操作不受影响）：按 code 指出的原因处理 —— 检查运行目录的剩余空间、挂载是不是只读、以及本进程对它的写权限；恢复可写之后健康检查会自动转回 ok，不必重启";

// PostgreSQL 后端连不上：与「盘写不进去」同规 —— 稳定错误码 + 一句该查什么；驱动原话（带库的地址）只进 stderr，不回给调用方。
const DATABASE_UNAVAILABLE_HINT = "数据库连不上：确认 DATABASE_URL 指向的库在跑、地址/端口/用户名密码对、网络与防火墙通；库回来之后自动恢复，不必重启";
const DATABASE_UNAVAILABLE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPIPE",
  "AIMAC_PG_BRIDGE_TIMEOUT", "AIMAC_PG_BRIDGE_FATAL", "57P01", "57P02", "57P03", "08000", "08001", "08003", "08004", "08006"]);
function databaseUnavailable(error) {
  if (process.env.AIMAC_STATE_STORE !== "postgresql") return false;
  if (DATABASE_UNAVAILABLE_CODES.has(String(error?.code || ""))) return true;
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|terminat(ed|ing) connection|Connection terminated|the database system is (starting|shutting)/iu.test(String(error?.message || ""));
}

function startupError(summary, nextSteps) {
  return Object.assign(new Error(summary), {nextSteps});
}

// 启动期写不进运行态目录（EACCES/EPERM/EROFS）：assertRuntimeSecurity 读运行时配置时就会碰到，ensureState 也会。
// 两处 catch 用同一句：点名目录、给两条出路。返回 null 表示不是这一类。
function startupDiskProblem(error) {
  if (!["EACCES", "EPERM", "EROFS"].includes(error?.code)) return null;
  return `运行态目录不可写：${runtimeDir}（${error.code}）—— 给这个目录写权限（chown/chmod 给运行服务的用户），或用 AIMAC_RUNTIME_DIR 指到一个能写的目录`;
}

function weakSecret(value) {
  const text = String(value || "").trim();
  return unsafeSecretValues.has(text) || text.length < 20;
}

// 【只读请求不必每次深拷 2.3MB】。readState() 每次调用都克隆整份状态（实测 7.98ms），
// 而每个 API 请求都走它 —— 健康检查那条早就改成"共用只读 + 每次状态变化只付一次"了，
// 主路一直是漏的。这里同一套办法：状态没变（共用那份的对象身份没换）就复用准备好的那一份，
// 只把每次都可能变的 runtime 字段浅覆盖一层（几十个顶层键的浅拷是微秒级）。
// 拿到的是【冻结】的：GET 处理函数若不小心去改状态，会当场抛错而不是悄悄污染此后所有人的读。
let preparedReadState = {source: null, state: null};
// 【下发给界面的 runtime 常量只有这一个写入点】。readStateForRead（GET 的共享只读副本）与 readState（写路径）
// 原先各抄一份同样的五行：一条路补了新词表、另一条没补，界面就在两种请求下拿到两种词表 ——
// 而 doctor 只看得见其中一条（授权模板词表那条变异第一版就这样假绿过）。
// autonomousOrchestrator 不在这里：它是进程内的活值（心跳），读路径另行注入（见 readStateForRead）。
function decorateRuntimeForConsole(state) {
  // 台账上限：界面要据此判断「有没有东西被挤掉」，而不是自己编一个数。
  state.runtime.auditLogCap = AUDIT_LOG_CAP;
  // 判死阈值：节点行上的"在线"来自 node.status，而它只有在扫描跑过之后才翻成 offline（扫描挂在编排拍上）。
  // 界面要据此说出"心跳已经超时、只是还没被标记"，而不是照抄一个过时的字。
  state.runtime.nodeHeartbeatTimeoutMs = nodeHeartbeatTimeoutMs();
  // 三份词表（accountRoles / knownPermissions / grantRoleTemplates）：邀请/授权/角色表单原先是自由文本，
  // 而服务端按枚举拒 —— 词表只能来自服务端，且只有 core 的 consoleVocabularies 一个来源（勘察工具也用它）。
  Object.assign(state.runtime, consoleVocabularies());
  return state;
}

function readStateForRead() {
  ensureState();
  const shared = readStoredState({root, runtimeDir, statePath, seedPath, buildInitialState}, {shared: true});
  if (preparedReadState.source !== shared) {
    const fresh = readStoredState({root, runtimeDir, statePath, seedPath, buildInitialState});
    ensureRuntimeCollections(fresh, {root: repositoryRoot, runtimeDir, endpoint: process.env.AIMAC_PUBLIC_URL || localEndpoint(), executionProfile});
    markRuntimeStorage(fresh, ".runtime/control-plane-state.json");
    decorateRuntimeForConsole(fresh);
    deepFreezeState(fresh);
    preparedReadState = {source: shared, state: fresh};
  }
  // autonomousOrchestrator 是【进程内的活值】（心跳），与盘上那份状态无关：
  // 它不能被缓存住，所以每次请求都在最外层浅覆盖一次。
  return {...preparedReadState.state,
    runtime: {...preparedReadState.state.runtime, autonomousOrchestrator: runtimeOrchestratorStatus}};
}

function deepFreezeState(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreezeState(value[key]);
  return value;
}

function readState() {
  ensureState();
  const state = readStoredState({root, runtimeDir, statePath, seedPath, buildInitialState});
  ensureRuntimeCollections(state, {root: repositoryRoot, runtimeDir, endpoint: process.env.AIMAC_PUBLIC_URL || localEndpoint(), executionProfile});
  markRuntimeStorage(state, ".runtime/control-plane-state.json");
  state.runtime.autonomousOrchestrator = runtimeOrchestratorStatus;
  decorateRuntimeForConsole(state);
  return state;
}

// 【命令接口不许替调用方猜对象】。这几条写路由原先把缺失的对象字段用默认值补上：
// 空 body 打过去照样 201 —— 凭空给种子账号发一份授权、铸一个能登录的"New User"、
// 在控制面自己的任务组上挂一张审批单（它会进别人的待办、卡住关闭门）。
// 人少填一个字段就造出一条要人处置的真记录，而且看不出这不是他想要的那个对象。
// 缺了就拒，并说清缺的是哪一个。（控制面 e2e 里有一条按【真实路由清单】逐个打空 body 的扫描守着。）
function requireBodyFields(res, body, fields, code) {
  const missing = fields.filter((field) => !String(body?.[field] ?? "").trim());
  if (!missing.length) return false;
  json(res, 400, {error: code, missing,
    message: `缺少必填字段：${missing.join("、")} —— 这条接口不会替你挑一个默认对象`});
  return true;
}

function readHealthState() {
  ensureState();
  // 健康检查曾经【每次请求】把整份中央态深拷一遍：实测 2.3MB 状态下一次 6.9ms，
  // 而它真正要的只有两样（runtime 与 agentRuntimeNodes）。负载均衡器每几秒敲一次，
  // 这笔钱全花在拷贝上；视图那条路早就改成共用只读了，这一条是漏的。
  // 只补浅壳不行：ensureRuntimeCollections 会修【嵌套】的东西（试过，共用那份是冻的，
  // 当场抛 "Cannot assign to read only property 'permissions'"）—— 深拷不是白花的。
  // 所以改成【每次状态变化只付一次】：共用只读那份的对象身份就是天然的键，
  // 它换了就说明底下的状态换了，不必另造版本号。
  const shared = readStoredCentralState({root, runtimeDir, statePath, seedPath, buildInitialState}, {shared: true});
  // 这条路【只读中央文件】（为省一次全量读），于是分片在不在它看不见。而"中央索引记着分片、
  // project-db 整个不在"正是备份只拷了一半的样子：登录进去项目数据全没了，健康检查却回 ok。
  // 一次 existsSync 就能分辨，抛出去走存储故障那条统一出口（503 + 说清该恢复哪一份）。
  const shardFault = projectShardStorageFault({root, runtimeDir, statePath, seedPath, buildInitialState}, shared);
  if (shardFault) throw Object.assign(new Error(`${shardFault.code}:${shardFault.file}`), {hint: shardFault.hint});
  if (healthStateCache.source !== shared) {
    const fresh = readStoredCentralState({root, runtimeDir, statePath, seedPath, buildInitialState});
    ensureRuntimeCollections(fresh, {root: repositoryRoot, runtimeDir, endpoint: process.env.AIMAC_PUBLIC_URL || localEndpoint(), executionProfile});
    markRuntimeStorage(fresh, ".runtime/control-plane-state.json");
    healthStateCache = {source: shared, state: fresh};
  }
  // 回一层浅壳：这条路今天只读，壳是给将来的人兜底的 —— 谁在顶层写一笔，也污染不到下一次。
  return {...healthStateCache.state};
}

// 健康检查用的那份"已补齐"状态，按【底下那份共用只读状态的对象身份】缓存。
let healthStateCache = {source: null, state: null};

let runtimeOrchestratorStatus = {intervalMs: 0, enabled: false};

function writeState(state, writeOptions = {}) {
  stateViewCache.clear();
  scopedStateCache.clear();
  computeProgressSnapshots(state);
  markRuntimeStorage(state, ".runtime/control-plane-state.json");
  writeStoredState(state, {root, runtimeDir, statePath, seedPath, buildInitialState,
    expectedStateVersion: state.__loadedStateVersion, ...writeOptions});
  flushPendingAuditAppends(state);
  notifyLongPollWaiters("state");
  const nodeIdsWithQueuedCommands = new Set((state.agentControlCommands || [])
    .filter((command) => command.status === "queued")
    .map((command) => command.nodeId));
  for (const nodeId of nodeIdsWithQueuedCommands) notifyLongPollWaiters(`agent-control:${nodeId}`);
}

// 条目构造挪到了共享台账（lib/audit-ledger.mjs）：MCP 那条写路径要往【同一本】台账上记，
// 两处各写一份的话，prevHash 链迟早分叉。这里保留同名包装，70 处调用点一个都不用改。
// 任务组的初始状态。此前这里是 `input.status || "planned"` —— 两处都错：
//   · planned 在 spec/state-machines.yaml 的 TaskGroup 里根本没有登记（机器的初态是 intake），
//     按状态机推理的东西一个都不认识它，而这不报任何错；
//   · input.status 完全不校验，调用方能把任意字符串塞成初始状态。
// 字面量清单与状态机的一致性由 validate-specs 的「状态集合常量」那道门逐个对表。
const TASK_GROUP_STATUSES = ["intake", "discovery", "product_design", "solution_design", "ui_design",
  "development", "global_development_review", "verification", "repair", "reverification",
  "integration", "release", "online_quality", "closed", "aborted"];
function taskGroupCreateStatus(value) {
  if (value === undefined || value === null || value === "") return "intake";
  if (TASK_GROUP_STATUSES.includes(value)) return value;
  throw Object.assign(new Error("task_group_status_unknown"),
    {status: 400, details: {status: String(value).slice(0, 60), supported: TASK_GROUP_STATUSES}});
}


function audit(state, actor, action, subject, result = "succeeded") {
  ensureControlState(state);
  appendAuditEntry(state, {actor, action, subject, result, at: now()});
}

const AUDIT_ARCHIVE_PATH = () => join(runtimeDir, "audit-log.jsonl");

function flushPendingAuditAppends(state) {
  flushAuditArchive(state, AUDIT_ARCHIVE_PATH());
}

// 归档只能追加、且要能被人读到 —— 有归档而没有读取入口，等于没有归档。
// 尾部读取：只读最后 AUDIT_TAIL_BYTES 字节，避免文件长到几百 MB 时把整份读进内存。
const AUDIT_TAIL_BYTES = 512 * 1024;

function readAuditArchiveTail(limit) {
  const path = AUDIT_ARCHIVE_PATH();
  if (!existsSync(path)) return {entries: [], truncated: false, bytesScanned: 0, fileBytes: 0};
  const fileBytes = statSync(path).size;
  const start = Math.max(0, fileBytes - AUDIT_TAIL_BYTES);
  const handle = openSync(path, "r");
  let text;
  try {
    const buffer = Buffer.allocUnsafe(fileBytes - start);
    readSync(handle, buffer, 0, buffer.length, start);
    text = buffer.toString("utf8");
  } finally {
    closeSync(handle);
  }
  // 从中间切进去的第一行多半是半行，丢掉它，否则会解析出一条残缺记录。
  const lines = text.split("\n").filter((line) => line.trim());
  if (start > 0 && lines.length) lines.shift();
  const parsed = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line)); } catch { /* 半行或损坏行：跳过，下面按链校验会暴露缺口 */ }
  }
  const selected = parsed.slice(Math.max(0, parsed.length - limit));
  return {
    entries: selected.reverse(),
    // 窗口之外还有更早的记录：如实说出来，而不是让人以为这就是全部。
    truncated: start > 0 || parsed.length > selected.length,
    bytesScanned: fileBytes - start,
    fileBytes
  };
}

// 每条记录都带 prevHash + rowHash，但此前没有任何地方校验过 —— 一条从没被验过的哈希链
// 只是装饰。这里按返回窗口逐条重算：改过的记录、被删掉的记录都会在这里露出来。
function verifyAuditChain(entriesNewestFirst) {
  const ordered = [...entriesNewestFirst].reverse();
  const breaks = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index];
    const {rowHash, ...body} = entry;
    if (digestOf(body) !== rowHash) breaks.push({id: entry.id, reason: "row_hash_mismatch"});
    else if (index > 0 && entry.prevHash !== ordered[index - 1].rowHash) breaks.push({id: entry.id, reason: "prev_hash_mismatch"});
  }
  return {verified: ordered.length, breaks};
}

function ensureControlState(state) {
  ensureRuntimeCollections(state, {root: repositoryRoot, runtimeDir, endpoint: process.env.AIMAC_PUBLIC_URL || localEndpoint(), executionProfile});
  ensureAgentGatewayCollections(state);
}

// 口令原先用纯 SHA-256 存（digestOf("account-password:<id>:<明文>")）：没有任何密钥拉伸，
// 拿到状态文件就能离线极快地暴力破解，而状态文件里本来就有节点令牌这类东西，被读到并非天方夜谭。
// 改成 scrypt + 每账号随机盐 + 定时安全比较。旧摘要必须继续可验证，否则升级即等于把所有人锁在门外；
// 验证成功时就地升级为 scrypt，不需要任何人重设密码。
const PASSWORD_SCRYPT = {N: 16384, r: 8, p: 1, keyLength: 32};

function scryptPasswordDigest(password, salt) {
  const derived = scryptSync(String(password), salt, PASSWORD_SCRYPT.keyLength, {
    N: PASSWORD_SCRYPT.N, r: PASSWORD_SCRYPT.r, p: PASSWORD_SCRYPT.p
  });
  return `scrypt$${PASSWORD_SCRYPT.N}$${PASSWORD_SCRYPT.r}$${PASSWORD_SCRYPT.p}$${salt}$${derived.toString("base64url")}`;
}

function newPasswordDigest(password) {
  return scryptPasswordDigest(password, randomBytes(16).toString("base64url"));
}

// 常数时间比较：长度不同的两个 Buffer 会让 timingSafeEqual 抛错，先按长度短路（长度本身不是秘密）。
function digestsEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  if (a.length !== b.length || !a.length) return false;
  return timingSafeEqual(a, b);
}

// 返回 {ok, needsUpgrade}：ok 表示口令正确；needsUpgrade 表示它是旧格式，调用方应就地换成 scrypt。
function verifyAccountPassword(account, password) {
  const stored = String(account?.passwordDigest || "");
  if (!stored || !password) return {ok: false, needsUpgrade: false};
  if (stored.startsWith("scrypt$")) {
    const salt = stored.split("$")[4];
    if (!salt) return {ok: false, needsUpgrade: false};
    return {ok: digestsEqual(stored, scryptPasswordDigest(password, salt)), needsUpgrade: false};
  }
  const legacy = digestOf(`account-password:${account.accountId}:${password}`);
  return {ok: digestsEqual(stored, legacy), needsUpgrade: true};
}

function beginGuardedWrite(req, state, action, subject, resourceScope = inferResourceScope(state, subject)) {
  ensureControlState(state);
  const authenticated = authenticateRequest(req, state);
  if (!authenticated) {
    return {status: 401, payload: {error: "auth_required"}};
  }
  const idempotencyKey = req.headers["idempotency-key"];
  if (!idempotencyKey) {
    return {status: 428, payload: {error: "idempotency_key_required"}};
  }
  const actor = authenticated.accountId;
  const account = state.accounts.find((item) => accountIdOf(item) === actor);
  if (!principalAllowedForAction(account, action)) {
    return {status: 403, payload: {error: "principal_not_allowed_for_action", actor, action}};
  }
  const bodyDigest = req.bodyDigest || digestOf("");
  const existingRecord = state.idempotencyRecords[idempotencyKey];
  if (existingRecord) {
    // subject 也要比：旧记录里没有这个字段时（本次改动之前写下的）跳过这一项，
    // 否则升级那一刻所有在途的幂等键都会变成冲突。
    const subjectChanged = existingRecord.subject !== undefined && existingRecord.subject !== subject;
    if (existingRecord.actor !== actor || existingRecord.action !== action
      || subjectChanged || existingRecord.bodyDigest !== bodyDigest) {
      return {status: 409, payload: {error: "idempotency_key_reuse_conflict"}};
    }
    // 响应体已过重放窗口时不能返回一个空的成功响应 —— 那看起来像原来那次调用的结果，
    // 而它什么内容都没有。明确告诉调用方：那次写入确实发生过，但结果已经不能再重放了。
    const replay = idempotentReplayOutcome(existingRecord);
    if (replay.expired) {
      return {status: 409, payload: {error: replay.error, idempotencyKey,
        originalStatus: replay.originalStatus, completedAt: replay.completedAt,
        payloadExpiredAt: replay.payloadExpiredAt}};
    }
    return {status: replay.status, payload: replay.payload};
  }
  const drift = writeDriftCheck(state, action, resourceScope);
  if (!drift.allowed) {
    // 【拒了要说得出下一步】。这里原先只回一个码加一串信号（role_drift_guard_missing:xxx）——
    // 而这条拒绝挡着五个动作（建指令信封、建角色定制、选产出目标、检查点、运行时开工），
    // 其中两条正是控制台上写明"由人经 API 创建"的那两条。人看到这句话完全不知道该做什么：
    // 守卫【只能由执行方在开工时绑定】（MCP 的 role_drift_guard_bind），控制台上没有入口，
    // 所以一个还没跑过 agent 的部署上，这两条路是死的，而报文一个字都没解释。
    const missing = drift.signals.some((signal) => String(signal).startsWith("role_drift_guard_missing:"));
    return {status: 409, payload: {error: "role_drift_guard_not_clear", driftSignals: drift.signals,
      message: missing
        ? "这个任务组还没有绑定角色漂移守卫。它由执行方在开工时绑定（agent 认领派发后调 role_drift_guard_bind），"
          + "控制台上没有手动入口 —— 先让这个任务组真正派发一次，或改在已经开过工的任务组上做这件事"
        : "已绑定的角色漂移守卫没有把这个任务组列进它的作用域（allowedActionScopeRefs）："
          + "执行方绑守卫时限定了监管范围，这次写入落在范围之外 —— 让执行方重新绑定（role_drift_rebound）后再试"}};
  }
  const at = now();
  const requiredPermission = permissionForAction(action);
  const allowed = hasPermission(state, actor, requiredPermission, resourceScope);
  const policyDecision = {
    schemaVersion: "policy-decision/v1",
    id: createId("pd"),
    status: allowed ? "allowed" : "denied",
    actor,
    action,
    resource: subject,
    resourceScope,
    policyVersion: "local-demo-policy/v1",
    requiredPermission,
    evidenceRefs: [`idempotency:${idempotencyKey}`, `actor:${actor}`],
    createdAt: at
  };
  if (!allowed) {
    state.policyDecisions.unshift(policyDecision);
    // 这里原先还按 120 盲切一刀 —— 比写入点那道保护的 500 更严，于是真正生效的是 120，
    // 而且它先跑：被活跃授权引用、本该被捞回来的那条，在保护看到之前就没了。
    // 容量只由写入点 capPolicyDecisionsKeepingReferenced 管（那里带引用保护）。
    // 被拒的这一次【没有别的动作行】——这一行就是它在台账上唯一的痕迹。而它原先记的是
    // 作者 "policy-engine"、动作 "policy_decision_denied"：27 行长得一模一样，
    // 唯一的差别只有对象，「谁试图做什么」两件事都答不出来。改记真实的调用方与真实的动作，
    // 结果栏写明是被策略挡下的。actor 来自认证，不取自请求体。
    audit(state, actor, action, subject, "policy_denied");
    commitUnguardedWrite(state);
    return {status: 403, payload: {error: "policy_denied", actor, requiredPermission, resourceScope}};
  }
  const command = {
    id: createId("cmd"),
    type: action,
    subject,
    status: "admitted",
    idempotencyKey,
    policyDecisionRef: policyDecision.id,
    createdAt: at,
    updatedAt: at
  };
  return {idempotencyKey, policyDecision, command, actor, bodyDigest, resourceScope};
}


function finishGuardedWrite(state, guard, status, payload) {
  ensureControlState(state);
  const updatedAt = now();
  state.stateVersion += 1;
  const decisionRecord = {
    // 此前这个集合不受任何规范约束，status 一直写着 `accepted` —— 而 spec/state-machines.yaml 的
    // DecisionRecord 压根没有这个状态。守卫在写之前已经同步评估完策略，drafted/validated
    // 两步没有对应的现实动作，所以记录直接落在 active（那道 validated->active 的门要的
    // state_version_incremented 与 audit_ref，这里两项都满足）。
    schemaVersion: "decision-record/v1",
    decisionId: createId("decision"),
    status: "active",
    actor: guard.actor,
    action: guard.command.type,
    subject: guard.command.subject,
    policyDecisionRef: guard.policyDecision.id,
    payloadDigest: digestOf(payload),
    createdAt: updatedAt,
    auditRef: `audit:${guard.idempotencyKey}`
  };
  state.decisionRecords.unshift(decisionRecord);
  state.policyDecisions.unshift(guard.policyDecision);
  // Gap #3: run the guarded write through the real Command bus lifecycle (created -> admitted ->
  // dispatched -> running -> succeeded) instead of pushing a terminal stub. Control-plane writes
  // are internal state mutations (no external side effect), so no CommandEffect is emitted.
  runCommandLifecycle(state, {
    type: guard.command.type,
    subject: guard.command.subject,
    idempotencyKey: guard.idempotencyKey,
    policyDecisionRef: guard.policyDecision.id,
    resultRef: `response:${guard.idempotencyKey}`
  });
  state.decisionRecords = state.decisionRecords.slice(0, 120);
  // subject（这次写的是【哪个对象】）必须一起记下来。有二十来条写路由的资源只出现在 URL 里、
  // body 是空的：同一个人、同一个动作、同样的空 body，对两个不同对象用同一个幂等键时，
  // 第二次会命中第一次的记录并把那份结果原样返回 —— 而第二个对象根本没被处理过（实测复现）。
  // 写入、正文过期清理、条数淘汰是一件事，收在 core 的 recordIdempotentResult 里 ——
  // 原先这三步只在这一侧凑齐，MCP 那侧只做了第一步（于是它写下的回执正文永不清理）。
  recordIdempotentResult(state, guard.idempotencyKey,
    {status, payload, actor: guard.actor, action: guard.command.type, subject: guard.command.subject, bodyDigest: guard.bodyDigest, createdAt: updatedAt});
  // 【问责台账不再附赠这两行】。它们此前挂在每一次守卫写入上：作者是 policy-engine /
  // command-bus 两个伪身份，对象与动作行完全相同，说的是"策略放行了"和"命令完成了" ——
  // 而这两件事，动作行本身（谁 / 何时 / 动了什么 / 结果）已经回答过了。
  // 代价是实打实的：台账在册上限 80 行，每次写入占 3 行，于是【三分之二是套话】。
  // 实测一份真实运行态：80 行里 79 行是这类例行噪声，只装下了 1 条人做的动作
  //（task_group_pause）—— 而"谁把这台机器踢出去的""谁注销了这个账号"正要从这里查。
  // 策略判定与命令记录本身没有丢：它们在 state.policyDecisions / state.decisionRecords 里，
  // view=full 照常取得到。去掉的只是台账上那两行复述。
}

function accountIdOf(account) {
  return account.accountId || account.id;
}

function isSystemAccount(account) {
  return Boolean(account && (account.accountType === "system_admin" || (account.roles || []).includes("system_admin") || (account.permissions || []).includes("system:*")));
}

// 成员类路由统一按【被改的那个账号】取作用域，而不是按操作者自己的组织取。
// 按操作者取会让系统管理员（organizationId 为 null）在成员管理页列得出某组织的全部成员、
// 对每一个动手却都拿到 org_member_not_found —— 界面上三个按钮全是坏的。
// 但只有系统账号跟到目标所属的组织；其余人一律锁在自己的组织里，否则"别的组织有没有这个账号"
// 会从 403（越权）与 404（不存在）的差别里漏出去，这几条路由就成了跨租户的存在性探针。
function resolveOrgMemberTarget(state, actorAccount, accountId) {
  const target = (state.accounts || []).find((item) => item.accountId === accountId);
  // 归属同样走那处共用判据：列表里看得见的人，就该管得到；列表里没有的（服务账号、
  // 没有组织的系统账号），组织管理员也不该经这条路碰到。
  const orgId = isSystemAccount(actorAccount)
    ? (target ? organizationMembershipOf(target) : null)
    : (actorAccount?.organizationId ?? null);
  return {
    orgId,
    member: target && organizationMembershipOf(target) === orgId ? target : null,
    scope: orgId ? {resourceType: "organization", resourceId: orgId} : {resourceType: "system", resourceId: "accounts"}
  };
}

function publicAccountRecord(account) {
  return {
    schemaVersion: account.schemaVersion,
    accountId: account.accountId,
    accountType: account.accountType,
    displayName: account.displayName,
    email: account.email,
    status: account.status,
    // 界面要靠它把"被撤回的邀请"和"停用的正常账号"分开：前者只能重发邀请，按「启用」必然 409。
    ...(account.invitationWithdrawn ? {invitationWithdrawn: true} : {}),
    roles: account.roles || [],
    permissions: account.permissions || [],
    authPolicy: account.authPolicy ? {method: account.authPolicy.method, mfaRequired: Boolean(account.authPolicy.mfaRequired), passwordSet: Boolean(account.authPolicy.passwordSet), sessionTtlSeconds: account.authPolicy.sessionTtlSeconds} : undefined,
    credentialIssuedAt: account.credentialIssuedAt,
    credentialExpiresAt: account.credentialExpiresAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

// 条数与单条长度都要有上限。实测两条请求（5 万条要求 + 一条 30 万字的要求）
// 就把状态从 63KB 撑到 6.4MB —— 而每次写入的成本正比于状态大小，那是永久的账。
// 与自由文本同规：拒绝，不静默截断（存下的与人写的不一致更难查）。
// field 只用于把"是哪一项超了"说清楚；MCP 侧有一份孪生实现（normalizeMcpStringList），
// 两边必须同规，少补一侧 agent 就能从那扇门把状态撑大。
// 上限取自 core 那份唯一真相源（见 import）——两侧各抄一份字面量会悄悄分叉。

// 项目/任务组两层配置的 defaultRoles 原先自由写入：建任务组时把它继承进 roles，而那一步只查调用方自己填的角色 ——
// 写成 reviwer 的默认角色会随每个新任务组一起落地，谁也派不了工、谁也不报错。与建任务组/入网令牌/智能体共用一份词表，在写入的门上拒。
function unregisteredDefaultRoles(list) {
  const roleIds = (Array.isArray(list) ? list : [])
    .map((item) => (typeof item === "string" ? item : item?.roleId))
    .map((id) => String(id || "").trim()).filter(Boolean);
  return unknownOwnerRoles(roleIds);
}
function defaultRoleRefusal(unknownRoles) {
  return {error: "config_default_role_not_registered", unknownOwnerRoles: unknownRoles.slice(0, 10), supported: [...REGISTERED_OWNER_ROLES],
    message: `默认角色「${unknownRoles.slice(0, 10).join("、")}」不在已登记的执行角色里 —— 可用：${REGISTERED_OWNER_ROLES.join("、")}`};
}

function normalizeStringList(value, fallback = [], field = "list") {
  const source = Array.isArray(value)
    ? value
    : String(value || "").split(/[\n,]/u);
  if (source.length > STRING_LIST_MAX_ITEMS) {
    throw Object.assign(new Error(`${field}_too_many_items`), {status: 400,
      details: {limit: STRING_LIST_MAX_ITEMS, actual: source.length,
        message: `这一项给了 ${source.length} 条，超出上限 ${STRING_LIST_MAX_ITEMS} 条。`}});
  }
  const normalized = [...new Set(source.map((item) => String(item).trim()).filter(Boolean))];
  const overlong = normalized.find((item) => item.length > STRING_LIST_MAX_ITEM_LENGTH);
  if (overlong !== undefined) {
    throw Object.assign(new Error(`${field}_item_too_long`), {status: 400,
      details: {limit: STRING_LIST_MAX_ITEM_LENGTH, actual: overlong.length,
        message: `这一项里有一条 ${overlong.length} 字，超出单条上限 ${STRING_LIST_MAX_ITEM_LENGTH} 字。`}});
  }
  return normalized.length ? normalized : fallback;
}

function requestedSystemAccountInvite(input = {}) {
  const accountType = String(input.accountType || "user_account");
  const roles = normalizeStringList(input.roles, []);
  const permissions = normalizeStringList(input.permissions, []);
  return accountType === "system_admin" ||
    roles.includes("system_admin") ||
    permissions.some((permission) => permission === "system:*" || permission.startsWith("system:"));
}

const ORG_QUOTA_KEYS = ["maxMembers", "maxProjects", "maxTaskGroups", "maxAgents"];
// 建组织与改配额共用一份判据：填了但认不出的配额要拒。建组织原先只走 boundedQuota —— 非数悄悄回落到缺省、0 与负数钳成 1，
// 一个「只装得下一个人」的组织就这样带着 201 建出来了。
function invalidQuotaEntries(body) {
  const invalid = [];
  for (const key of ORG_QUOTA_KEYS) {
    const raw = body.quotas?.[key] !== undefined ? body.quotas[key] : body[key];
    if (raw === undefined) continue;
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < 1 || numeric > 1_000_000) invalid.push({key, received: raw === null ? null : String(raw)});
  }
  return invalid;
}
function quotaInvalidPayload(invalid) {
  return {error: "org_quota_invalid", invalid, limits: {min: 1, max: 1_000_000},
    message: `配额必须是 1 到 1000000 的整数：${invalid.map((item) => `${item.key}=${JSON.stringify(item.received)}`).join("、")}`};
}

function boundedQuota(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.max(1, Number(fallback) || 1);
  return Math.max(1, Math.min(1_000_000, Math.floor(numeric)));
}

// Reject over-length rule fragments up front so a safety rule is never silently truncated (which would
// quietly weaken its semantics). Returns an error code string, or null when the payload is within limits.
function ruleFragmentsRejection(value) {
  if (value === undefined) return null;
  // 非数组原先直接放行，随后 sanitizeRuleFragments 对非数组返回 [] —— 于是
  // POST {"systemRules":"..."} 会把该层规则【静默清空】并回 200。而这个函数存在的全部理由
  // 就是"绝不静默改变一条安全规则"，把它整层抹掉显然更严重。
  if (!Array.isArray(value)) return "rule_fragments_must_be_an_array";
  if (value.length > 200) return "too_many_rules";
  for (const rule of value) {
    if (!rule || typeof rule !== "object") continue;
    if (rule.ruleId !== undefined && String(rule.ruleId).length > 128) return "rule_id_too_long";
    if (rule.title !== undefined && String(rule.title).length > 256) return "rule_title_too_long";
    if (rule.content !== undefined && String(rule.content).length > 8192) return "rule_content_too_long";
    // 认不出的状态原先在 sanitizeRuleFragments 里被【默认成 "active"】：把 disabled 打错一个字母
    // （disable / Disabled / inactive），那条规则不是被停用，而是照旧生效 —— 而人以为自己关掉了它。
    // 安全规则上"以为关了其实没关"和"以为开了其实没开"一样坏，所以这里拒绝，不猜。
    if (rule.status !== undefined && !RULE_STATUSES.includes(rule.status)) return "rule_status_unknown";
  }
  return null;
}

// 规则的合法状态只有这三个。清单写一处：净化那边的兜底与校验这边的判定必须是同一份，
// 否则"校验放过的"与"净化认得的"会分叉。
const AGENT_STATUSES = ["active", "inactive"];
const RULE_STATUSES = ["active", "draft", "disabled"];
const REPOSITORY_CREDENTIAL_MODES = ["none", "account_password", "api_key"];

function sanitizeRuleFragments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).filter((rule) => rule && typeof rule === "object").map((rule) => {
    const clean = {};
    if (rule.ruleId !== undefined) clean.ruleId = String(rule.ruleId).slice(0, 128);
    if (rule.title !== undefined) clean.title = String(rule.title).slice(0, 256);
    if (rule.content !== undefined) clean.content = String(rule.content).slice(0, 8192);
    // 走到这里时状态一定合法（上面 ruleFragmentsRejection 已经拒过认不出的）。这句兜底是第二道门。
    if (rule.status !== undefined) clean.status = RULE_STATUSES.includes(rule.status) ? rule.status : "active";
    if (rule.enabled !== undefined) clean.enabled = rule.enabled !== false;
    return clean;
  });
}

function repositoryKey(repo = {}) {
  return String(repo.id || repo.repositoryId || repo.url || "").trim();
}

function sanitizeRepositoryCredential(inputCredential = {}, mode, previousCredential = {}) {
  if (mode === "account_password") {
    const password = inputCredential.password !== undefined && inputCredential.password !== ""
      ? String(inputCredential.password).slice(0, 8192)
      : String(previousCredential.password || "");
    return {
      mode,
      username: String(inputCredential.username || previousCredential.username || "").slice(0, 512),
      ...(password ? {password} : {})
    };
  }
  if (mode === "api_key") {
    const apiKey = inputCredential.apiKey !== undefined && inputCredential.apiKey !== ""
      ? String(inputCredential.apiKey).slice(0, 8192)
      : String(previousCredential.apiKey || previousCredential.password || "");
    return {mode, ...(apiKey ? {apiKey} : {})};
  }
  return {mode: "none"};
}

function sanitizeRepositoryConfigs(value, previous = []) {
  if (!Array.isArray(value)) return [];
  const previousByKey = new Map((previous || []).map((repo) => [repositoryKey(repo), repo]).filter(([key]) => key));
  return value.slice(0, 200).filter((repo) => repo && typeof repo === "object").map((repo) => {
    const key = repositoryKey(repo);
    const previousRepo = previousByKey.get(key) || {};
    const modeCandidate = String(repo.credentialMode || repo.credential?.mode || previousRepo.credentialMode || previousRepo.credential?.mode || "none");
    const mode = REPOSITORY_CREDENTIAL_MODES.includes(modeCandidate) ? modeCandidate : "none";
    const clean = {
      id: String(repo.id || repo.repositoryId || "").slice(0, 128),
      url: String(repo.url || "").slice(0, 2048),
      defaultBranch: String(repo.defaultBranch || "main").slice(0, 256),
      credentialMode: mode,
      credential: sanitizeRepositoryCredential(repo.credential || repo, mode, previousRepo.credential || previousRepo)
    };
    return clean;
  }).filter((repo) => repo.id || repo.url);
}

function redactRepositoryConfigs(value = []) {
  if (!Array.isArray(value)) return [];
  return value.map((repo) => {
    if (!repo || typeof repo !== "object") return repo;
    const credential = repo.credential || {};
    const redacted = {...repo, credential: {...credential}};
    if (redacted.credential.password) {
      redacted.credential.password = "";
      redacted.credential.passwordSet = true;
    }
    if (redacted.credential.apiKey) {
      redacted.credential.apiKey = "";
      redacted.credential.apiKeySet = true;
    }
    delete redacted.credentialSecretRef;
    return redacted;
  });
}

function redactProjectConfig(config = {}) {
  if (!config || typeof config !== "object") return config;
  return {...config, repositories: redactRepositoryConfigs(config.repositories)};
}

function publicProjectRecord(project = {}) {
  return {...project, config: redactProjectConfig(project.config || {})};
}

function sanitizeMemberPermissions(value, fallback = ["project:view"]) {
  const sanitized = normalizeStringList(value, fallback).filter((permission) =>
    !permission.startsWith("system:") &&
    !permission.startsWith("org:") &&
    !unsafeDelegatedGrantPermissions.has(permission) &&
    !permission.endsWith(":*"));
  return sanitized.length ? sanitized : fallback;
}

// 邀请与授权是同一件事的两条路：都在把权限交给另一个主体。授权那条（sanitizeGrantRequest）
// 会检查"授权方自己有没有这个权限"，邀请这条只过滤了危险的权限【形状】，从不看邀请方的实际权限 ——
// 于是一个只有 project:create 的人可以铸出一个带 task_group:review 直接权限的账号，再用它去做
// 自己做不到的事。同一间屋子两道门、其中一道没锁，这是本仓反复出现的形态。
function normalizeOwnerRole(value) {
  const role = String(value || "").trim() || "orchestrator";
  if (!REGISTERED_OWNER_ROLES.includes(role)) {
    const error = new Error("work_item_owner_role_not_registered");
    error.status = 400;
    error.registeredRoles = REGISTERED_OWNER_ROLES;
    throw error;
  }
  return role;
}

function normalizeInvitedAccount(input = {}, systemScoped = false, delegation = null) {
  const roles = normalizeStringList(input.roles, ["viewer"]);
  const permissions = normalizeStringList(input.permissions, ["project:view"]);
  if (systemScoped) {
    return {
      accountType: String(input.accountType || "user_account"),
      roles,
      permissions
    };
  }
  // 这一行【当前恒为假】：上游 systemScopedInvite 用的就是 requestedSystemAccountInvite(body)，
  // 为真时上面已经提前返回。它守的是那两处判定【漂开】的那天 —— 谁把上游换成别的口径
  // （比如只看 accountType、不看 permissions），带 system:* 权限的邀请就会从项目这条路进来。
  // 「两处必须同一个谓词」由 verifyInviteEscalationGuardsShareOnePredicate 钉着。
  if (requestedSystemAccountInvite(input)) throw new Error("project_invite_cannot_grant_system_account_or_permission");
  const shapeSafe = permissions.filter((permission) =>
    !permission.startsWith("system:") &&
    !permission.startsWith("org:") &&
    !unsafeDelegatedGrantPermissions.has(permission) &&
    !permission.endsWith(":*"));
  {
    const unknown = unknownPermissions(shapeSafe);
    if (unknown.length) {
      const error = new Error("permission_unknown");
      error.status = 400;
      error.details = {unknownPermissions: unknown.slice(0, 10), supported: [...KNOWN_PERMISSIONS]};
      throw error;
    }
  }
  if (delegation && !isSystemAccount(delegation.account)) {
    const notDelegable = shapeSafe.filter((permission) => !hasPermission(delegation.state, delegation.actor, permission, delegation.resourceScope));
    if (notDelegable.length) {
      const error = new Error("invite_permission_not_delegable");
      error.permissions = notDelegable;
      throw error;
    }
  }
  return {
    accountType: "user_account",
    roles: roles.filter((role) => role !== "system_admin" && role !== "org_admin"),
    permissions: shapeSafe
  };
}



// 与 core 共用同一份判据：两条铸造路径分别维护各自的清单，正是它们标准不一致的原因。
const unsafeDelegatedGrantPermissions = UNSAFE_DELEGATED_GRANT_PERMISSIONS;


function projectIdFromGrantScope(state, resourceScope = {}) {
  if (resourceScope.resourceType === "project") return resourceScope.resourceId;
  if (resourceScope.resourceType === "task_group") {
    return resourceScope.projectId || state.taskGroups.find((item) => item.id === resourceScope.resourceId)?.projectId || "";
  }
  return "";
}

function actorIsProjectOwnerForScope(state, actor, resourceScope = {}) {
  const projectId = projectIdFromGrantScope(state, resourceScope);
  if (!projectId) return false;
  const project = state.projects.find((item) => item.id === projectId);
  if (project?.ownerAccountId === actor) return true;
  return (state.accessGrants || []).some((grant) =>
    grant.status === "active" &&
    grant.role === "project_owner" &&
    grant.subjectRef?.subjectType === "account" &&
    grant.subjectRef?.subjectId === actor &&
    grant.resource?.resourceType === "project" &&
    grant.resource?.resourceId === projectId
  );
}

// 授权能落在哪几种作用域上 —— 这是个闭集。多一个认不出的取值，跨组织边界就少守一次。


// 模型能力档案里规范认识的字段（spec/model-capability.schema.json 是 additionalProperties:false）。
// 与规范双向核对：多一个＝落下来的记录违反规范，少一个＝调用方给的那一项被静默丢掉。
const MODEL_CAPABILITY_FIELDS = ["aliases", "availability", "capabilityDigest", "costSignals", "limits",
  "modalities", "modelId", "observedAt", "providerClass", "providerId", "qualitySignals", "strengths",
  "toolCapabilities"];


// 成员的默认项目：不指定是允许的（「（不指定）」是下拉里的第一项），但一旦指定就必须
// 指得到、属于本组织、且不是已归档 —— 归档意味着"移出可建新工作的范围"，把新成员的落脚点
// 设在那里，等于让他一进来就站在一个开不了工的地方，而没有任何地方会提示他为什么。
function validateDefaultProject(state, defaultProjectId, organizationId) {
  if (defaultProjectId === undefined || defaultProjectId === null || defaultProjectId === "") return null;
  const project = (state.projects || []).find((item) => item.id === defaultProjectId);
  if (!project) {
    return {error: "member_default_project_not_found", defaultProjectId: String(defaultProjectId).slice(0, 80),
      message: "默认项目指不到任何项目：请从下拉里选一个，或留空表示不指定"};
  }
  if ((project.organizationId || DEFAULT_ORGANIZATION_ID) !== organizationId) {
    return {error: "member_default_project_outside_organization", defaultProjectId: project.id,
      message: "默认项目不属于这个组织：成员进不去，等于没设"};
  }
  if (project.status === "archived") {
    return {error: "member_default_project_archived", defaultProjectId: project.id,
      message: "这个项目已归档（不能再建新工作）：把新成员的落脚点设在这里，他一进来就无事可做"};
  }
  return null;
}

function sanitizeGrantRequest(state, actor, input = {}, resourceScope = {}) {
  const account = state.accounts.find((item) => accountIdOf(item) === actor);
  const role = String(input.role || "viewer");
  const resource = {
    resourceType: String(input.resourceType || resourceScope.resourceType || "project").slice(0, 100),
    resourceId: String(input.resourceId || resourceScope.resourceId || "prj_control_plane")
  };
  // 作用域类型此前是任意字符串（只截到 100 字）。认不出的类型在 resourceScopeOrganizationId
  // 里返回 null，而 null 的含义是「系统级作用域」—— 于是一个打错的类型会让跨组织那道检查
  // 整个不适用，还会落一条永远匹配不上任何资源、却在名单里显示「启用中」的僵尸授权。
  const explicitPermissions = normalizeStringList(input.permissions, []);
  // 角色套不到模板就拒（与 MCP 那侧同一份校验）：原先静默降成 viewer，发出去的授权
  // 名字写着「项目管理员」而实际只读。
  const roleTemplate = validateGrantRoleTemplate(role, resource.resourceType, explicitPermissions.length > 0);
  if (!roleTemplate.ok) return roleTemplate;
  const permissions = explicitPermissions.length
    ? explicitPermissions
    : permissionsForRoleGrant(role, resource.resourceType);
  // 前四条校验（作用域类型、不可委派权限、对象存在、跨组织）已搬进 core 由两侧共用 ——
  // MCP 的 grant_create 此前一条都没有，靠"入参词表里没有 permissions"碰巧安全。
  const shared = validateDelegatedGrant(state, {resource, permissions, subjectId: input.subjectId || "acct_workspace_owner",
    resourceOrganizationId: resourceScopeOrganizationId(state, resource)});
  if (!shared.ok) return shared;
  if (!isSystemAccount(account)) {
    const denied = permissions.filter((permission) => {
      if (permission === "project:grant" && !actorIsProjectOwnerForScope(state, actor, resourceScope)) return true;
      return !hasPermission(state, actor, permission, resourceScope);
    });
    if (denied.length) return {ok: false, status: 403, error: "grant_permission_not_delegable", permissions: denied};
  }
  return {ok: true, role, resource, permissions};
}

// 服务端算出来的那份在前，调用方追加的在后，按 contractRef 去重（与 MCP 侧同一份语义）。
function mergeSharedDefinitionRefs(serverRefs, callerRefs) {
  const merged = [...(serverRefs || [])];
  const seen = new Set(merged.map((item) => item?.contractRef || item));
  for (const ref of Array.isArray(callerRefs) ? callerRefs : []) {
    const key = ref?.contractRef || ref;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(ref);
  }
  return merged;
}

function ensureProjectOwnerGrant(state, project, ownerAccountId, policyDecisionRef, auditRef) {
  state.accessGrants ||= [];
  const existing = state.accessGrants.find((grant) =>
    grant.status === "active" &&
    grant.subjectRef?.subjectType === "account" &&
    grant.subjectRef?.subjectId === ownerAccountId &&
    grant.resource?.resourceType === "project" &&
    grant.resource?.resourceId === project.id
  );
  if (existing) {
    // 找到就原样返回的话，一份【权限集已经过时】的既有授权永远补不上：
    // 项目负责人的权限集后来扩过一项，经 MCP 建的项目会被刷新（那一侧本来就刷），
    // 经控制台建的不会 —— 同一个人在两个项目里能做的事不一样，而没有任何地方会告诉他为什么。
    // 与 MCP 侧同规：既有授权也对齐到当前权限集。
    existing.permissions = [...projectOwnerGrantPermissions];
    existing.updatedAt = now();
    return existing;
  }
  const at = now();
  const grant = {
    schemaVersion: "access-control-grant/v1",
    grantId: createId("grant"),
    subjectRef: {subjectType: "account", subjectId: ownerAccountId},
    resource: {resourceType: "project", resourceId: project.id},
    role: "project_owner",
    permissions: [...projectOwnerGrantPermissions],
    status: "active",
    policyDecisionRef,
    auditRef,
    createdAt: at,
    updatedAt: at
  };
  state.accessGrants.unshift(grant);
  return grant;
}

function createTaskGroupRecord(state, input = {}, options = {}) {
  const projectId = String(input.projectId || "prj_control_plane");
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return {ok: false, status: 404, error: "project_not_found"};
  // 归档是项目的终结态，而且归档路由要求先把所有任务组关掉（不级联，让人自己收尾）。
  // 归档之后还能往里建新任务组的话，那次收尾就白做了：项目重新变活，而它已经不在任何人的视野里
  // （概览按 active 列、编排跳过 archived）—— 新组从此没人看、没人推，是一条谁也处置不掉的活。
  // 与任务组终结后的写入判据（core 的 taskGroupSettledRejection）同规，只是高一层。
  const archivedForCreate = projectArchivedRefusal(project, "不能再往里新建任务组");
  if (archivedForCreate) return {ok: false, status: 409, ...archivedForCreate};
  const taskGroupId = input.taskGroupId || createId("tg");
  if (state.taskGroups.some((item) => item.id === taskGroupId)) {
    return {ok: false, status: 409, error: "task_group_id_conflict"};
  }
  const at = now();
  const inheritedRoleIds = (project.config?.defaultRoles || []).map((role) => role.roleId).filter(Boolean);
  const userRoleIds = normalizeStringList(input.roles, []);
  {
    const unknownRoles = unknownOwnerRoles(userRoleIds);
    if (unknownRoles.length) {
      return {ok: false, status: 400, error: "task_group_role_not_registered", unknownOwnerRoles: unknownRoles.slice(0, 10), supported: [...REGISTERED_OWNER_ROLES]};
    }
  }
  const roleIdSet = new Set();
  const roles = [];
  for (const roleId of userRoleIds) {
    if (roleIdSet.has(roleId)) continue;
    roleIdSet.add(roleId);
    roles.push({roleId, status: "ready", skillBinding: "server_resolved_on_dispatch", addedBy: "user", addedAt: at});
  }
  for (const roleId of inheritedRoleIds) {
    if (roleIdSet.has(roleId)) continue;
    roleIdSet.add(roleId);
    roles.push({roleId, status: "ready", skillBinding: "server_resolved_on_dispatch", addedBy: "inherited", addedAt: at});
  }
  const taskGroup = {
    schemaVersion: "task-group/v1",
    id: taskGroupId,
    projectId,
    // 自由文本必须有上限：实测一次请求就能把目标写进 30 万字，状态文件 56KB 涨到 1.8MB，
    // 而每次写入的成本正比于状态大小 —— 一个字段能让此后【每一次写入】都替它买单。
    // 拒绝而不是静默截断：存下的内容与人写的不一致，比报错难查得多。
    name: assertHumanTextWithinLimit(input.name || input.title || "AI-native Task Group", "task_group_name", 200),
    title: assertHumanTextWithinLimit(input.title || input.name || "AI-native Task Group", "task_group_name", 200),
    objective: assertHumanTextWithinLimit(input.objective || input.title || input.name || "Machine-executed task group", "task_group_objective", 4000),
    status: taskGroupCreateStatus(input.status),
    goalExecutionStatus: "ready",
    phase: input.phase || "planning",
    progress: 0,
    health: "ok",
    languagePolicy: normalizeTaskGroupLanguagePolicy(input.languagePolicy || input),
    roles,
    workItems: [],
    blockers: [],
    auditRef: options.auditRef,
    createdAt: at,
    updatedAt: at
  };
  state.taskGroups.unshift(taskGroup);
  computeProgressSnapshots(state);
  return {taskGroup};
}

function createWorkItemRecord(state, taskGroupId, input = {}, options = {}) {
  const taskGroup = state.taskGroups.find((item) => item.id === taskGroupId);
  if (!taskGroup) return {ok: false, status: 404, error: "task_group_not_found"};
  // 任务组终结之后不得再往里加新东西 —— 建工作项是这一族里最直接的一个，偏偏之前漏了：
  // 上一轮给六个写入口（发现项/许可/审批/确认单/执行方案/规则来源）都加了这道判据，
  // 唯独没加在"往已关闭的组里塞一件新活"上。新活既没人推（编排跳过终结的组）也没人看得见。
  const settledRejection = taskGroupSettledRejection(state, taskGroup.id);
  if (settledRejection) return {...settledRejection, status: 409};
  const workItemId = input.workItemId || createId("work");
  if ((taskGroup.workItems || []).some((item) => item.id === workItemId)) {
    return {ok: false, status: 409, error: "work_item_id_conflict"};
  }
  // 精确钉模型（可选）：填了就必须是注册表里的模型，否则当场拒 —— 与 MCP 建工作项同用 core 的同一个校验，
  // 不让两份实现各写一套而漂移。存的是规范 modelId，派发时 selectModel 读 workItem.pinnedModelId 生效。
  const pin = normalizePinnedModelId(state, input.pinnedModelId);
  if (pin.error) return {ok: false, status: 400, error: pin.error, pinnedModelId: pin.pinnedModelId};
  const at = now();
  const workItem = {
    id: workItemId,
    title: assertHumanTextWithinLimit(input.title || "AI-native work item", "work_item_title", 200),
    // 认不出的状态原先降级成 ready（可开跑）。不填＝ready 是合理的创建默认，填错则必须拒 ——
    // 人写了个自己以为存在的状态，拿到的却是"已经可以开跑"。
    status: workItemCreateStatus(input.status),
    // 未登记的角色原先会被原样收下，然后在派发时静默绑上 orchestrator 的技能 ——
    // agent 按别人的角色规则干活。要拒就在【创建这一刻】拒，那时人还知道自己填了什么；
    // 等到派发再炸，人已经不知道问题出在哪。
    ownerRole: normalizeOwnerRole(input.ownerRole || input.roleId),
    progress: 0,
    requirements: normalizeStringList(input.requirements, [], "work_item_requirements"),
    ...(pin.pinnedModelId ? {pinnedModelId: pin.pinnedModelId} : {}),
    auditRef: options.auditRef,
    createdAt: at,
    updatedAt: at
  };
  taskGroup.workItems ||= [];
  taskGroup.workItems.push(workItem);
  if (!taskGroup.roles?.some((role) => role.roleId === workItem.ownerRole)) {
    taskGroup.roles ||= [];
    taskGroup.roles.push({roleId: workItem.ownerRole, status: "ready", skillBinding: "server_resolved_on_dispatch", addedBy: "user", addedAt: at});
  }
  taskGroup.updatedAt = at;
  computeProgressSnapshots(state);
  return {taskGroupId: taskGroup.id, workItem, taskGroup};
}

// 只有真人账号能做的动作：核心方案的定稿与人工意图通道。机器主体（service_account / agent_identity）
// 即使被授予了相应权限也一律拒绝 —— 否则 AI 拿到一个服务账号就能自我批准，人工闸门形同虚设。
// 规则/配置变更会影响后续所有执行，属于核心决策：机器主体不得变更（AI 只能通过人工确认通道提议）。
const HUMAN_ONLY_ACTIONS = [
  "human_confirmation_decide",
  "human_directive_create",
  "project_config_update",
  // 归档一个项目是组织层面的决定（它会释放配额、把项目移出可建工作的范围），不该由机器主体做。
  "project_archive",
  "task_group_config_update",
  // 重置/语言策略同样是规则变更 —— 重置会把人设定的 configOverrides 整个抹回默认值，
  // 只挡住 update 而放过 reset 等于没挡。
  "task_group_config_reset",
  "task_group_language_policy_update",
  // 共享定义的状态推进是规则层决策，且它是这类楔死的唯一出路 —— 必须由真人掌握。
  "shared_definition_resolve",
  "review_plan_resolve",
  "review_bundle_resolve",
  "rule_source_settle",
  // 判"这件事算不算重大决策"是人的事，不是分类器的事。
  "work_item_plan_finalization_set",
  // 批准一条权限请求＝把它被挡住的那项能力交给执行方，同时它的"拒绝"分支会级联终结该格子的
  // 执行、作废产出目标与租约。这既是治理决策也是破坏性操作，不该由机器主体自行完成 ——
  // 此前那条提权链正是从这里穿过去的。两条 e2e 里做批准的本来就都是真人账号。
  // 重发邀请＝铸一份新的登录凭据。这不该由机器主体完成。
  "org_member_invite_reissue",
  "permission_resolve",
  "system_upgrade_candidate_resolve",
  // 豁免质量门是放行决定，必须由真人负责，不能由 AI 自我豁免。
  // 共享定义契约的激活有两条路：MCP 的 shared_definition_publish 已被限制为"只能提案"，
  // 由真人专属的 shared_definition_resolve 决定是否 active。而 POST /api/contracts 这条
  // 直接落 active，且原先不在真人专属集里 —— 同一件事两道门，只锁了一道。
  // active 的契约会进入每个后续任务契约与指令包，且不在阻塞集里，不会留下任何可见阻塞。
  "contract_publish",
  // 与上面同因：改角色技能/技能源就是改规则层，必须真人。
  "role_skill_overlay_create",
  "skill_source_sync",
  // 退役比同步更不可逆：它会摘掉这个源带来的全部角色技能、终态化指向它们的叠加规则。
  "skill_source_retire",
  "quality_gate_waive",
  // 铸造账号必须是真人动作。人工定稿闸门只认 account.accountType，而铸造该 accountType 的动作
  // 原本不受同一条闸门保护 —— 机器主体铸一个"人"、再用返回的令牌登录，就成了合法的定稿人，
  // 整道人工闸门被从旁边绕过去。account_invite 强制铸出的正是 user_account（"人"类型）。
  "account_invite",
  "system_account_invite",
  // 【注销账号】2026-08-26 人定做出来的。它是终态且不可撤销：会话、名下授权、登录凭据一起断。
  // 铸凭据是真人专属，销毁凭据同理 —— 而且它比铸造更不可逆（铸错了能停用，销错了回不来）。
  "account_retire",
  // 【组织与授权面】2026-08-26 人定：AI 只负责把任务做完，不许动"谁能干什么"。
  // 这一族原先是机器可做的：拿到相应权限就能建组织、改成员权限与状态、调配额、发放/撤销授权。
  // 它绕得过人工定稿闸门吗？绕不过（闸门认 accountType，而铸账号已是真人专属）——
  // 但"谁能干什么"本身就不该由干活的一方来定，所以整族收归真人。
  "org_create", "org_member_create", "org_member_permissions_update", "org_member_status_update",
  "org_quota_update", "org_status_update",
  "access_grant_create", "access_grant_revoke", "project_member_grant",
  // 【取消与中止】2026-08-26 人定：AI 可以暂停，取消只能由人发起。
  // 暂停/恢复是可恢复的节奏调节；而取消与中止会停掉整组在跑的派发，
  // 并连带作废其名下【人正在等着签字】的确认单 —— 「关闭任务组」早已是真人专属，
  // 这两个到不了终态，却把人正在等的东西拿走了。
  "task_group_cancel", "task_group_abort"
];
const HUMAN_ACCOUNT_TYPES_FOR_ACTIONS = ["system_admin", "org_admin", "user_account"];

// 上面那份清单是【黑名单姿势】：没列到的动作一律放行给机器主体。于是"新加一条写路由"这件事
// 默认把它交给机器，而"要不要交给机器"根本没被问过 —— 这正是本仓反复出现的形态
// （缺省不得等于有利结果）。所以两份清单都要显式：不在任何一份里的动作【谁都不许做】，
// 由 verifyEveryGuardedActionIsClassified 按 beginGuardedWrite 的真实调用点两向核对，
// 新动作在 CI 上就会被拦下来，而不是悄悄以"机器也能做"上线。
// 每一族都写清楚"为什么机器可以做"。判断标准是那条人工定稿闸门：
// 提案、上报、执行推进可以是机器；【落闸、定稿、铸凭据】必须是人。
const MACHINE_ALLOWED_ACTIONS = [
  // 一、执行侧：agent 节点的接入、认领与产出。这些本来就是机器在做的事。
  "agent_create", "agent_activation_update", "agent_node_revoke",
  "agent_join_token_create", "agent_join_token_revoke",
  "agent_control_command_create", "task_group_agent_control_command_create",
  "artifact_register", "lease_claim", "lease_release", "work_assign", "instruction_envelope_create",
  // 二、编排与推进：自治循环每一拍都在做，人不可能逐条点。
  "orchestrator_run", "execution_topology_plan", "execution_topology_advance",
  "derived_task_classify", "model_selection_decide", "session_placement_decide",
  "repository_output_target_select", "model_capability_register", "policy_decision_eval",
  "task_group_close_barrier_compute", "task_group_recompute_readiness", "runtime_issue_collect",
  // 三、只提不决：造出来的都是待人处置的单子，终局仍在真人专属的那几个动作上。
  "approval_request_create", "permission_request_submit", "finding_submit",
  "review_plan_create", "review_bundle_register", "shared_definition_contract_create",
  "room_send", "task_group_create", "task_group_work_item_create",
  "project_create", "org_project_create",
  // 四、看着像"决"、实则另有内部闸门的三个（改这三处实现时必须回来看这里）：
  // approval_resolve —— 机器可以投票，但凑够法定人数【且至少一票来自真人】才会变 approved；
  // finding_resolve —— 终态化只对治理角色开放，提交方（control 角色）够不着；
  // rule_source_resolve —— 规则源的最终落定是真人专属的 rule_source_settle。
  "approval_resolve", "finding_resolve", "rule_source_resolve",
  // 五、任务组运行控制里【可恢复】的那几个：暂停、恢复、要求评审、纠偏。
  // 它们改的是节奏不是结论，停了还能再起来，所以机器可以做。
  // （取消/中止不在这里 —— 见下面真人专属那份清单。）
  "task_group_pause", "task_group_resume", "task_group_request_review", "task_group_rebound_drift",
  // 死信处置（丢弃/重放重试超限的命令）是运维对失败的判断，与质量门豁免同类，不交给机器主体。
  "dlq_entry_resolve",
  // 七、首次引导：空库上建出第一个系统账号，那一刻还没有任何"人"可用。
  "bootstrap_init"
];

function principalAllowedForAction(account, action) {
  if (!account) return false;
  if (["agent_runtime_worker_run", "checkpoint_submit"].includes(action)) {
    return account.accountType === "service_account" && (account.roles || []).includes("service_agent_runtime");
  }
  if (HUMAN_ONLY_ACTIONS.includes(action)) return HUMAN_ACCOUNT_TYPES_FOR_ACTIONS.includes(account.accountType);
  // 没登记过的动作【谁都不许做】。这是接线错误时的 fail-closed：新路由忘了分类的话，
  // 它在 e2e 上当场 403，而不是默认把这件事交给机器主体。
  return MACHINE_ALLOWED_ACTIONS.includes(action);
}

function stableDigest(fill) {
  return digestOf(fill);
}

function gitTrackablePath(path) {
  return canUseGitPath(path);
}

function validPathAllowlist(paths) {
  return pathAllowlistValid(paths);
}

// 【本地端点要用真正绑上的端口】。AIMAC_PORT=0 是"随便给我一个空闲端口"的标准写法：原先这里用配置的 port，
// 于是启动横幅的 MCP/安装器两行、/health 的 publicUrl 回落、以及 ensureRuntimeCollections 写进运行态的服务端点
// 全是 http://127.0.0.1:0 —— 只有控制台那一行修过。boundPort 由 listen 回调写入（声明在模块顶部，免得 TDZ）。
function localEndpoint() {
  return `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${boundPort || port}`;
}

function publicEndpoint(req) {
  const configured = process.env.AIMAC_PUBLIC_URL || readRuntimeConfig().publicUrl;
  if (configured) return String(configured).replace(/\/+$/u, "");
  if (!req) return localEndpoint();
  const hostHeader = String(req.headers.host || "").trim();
  if (!requestHostAllowed(hostHeader)) return localEndpoint();
  const forwardedProto = process.env.AIMAC_TRUST_PROXY === "true" ? String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() : "";
  const protocol = forwardedProto || (req.socket.encrypted ? "https" : "http");
  if (protocol !== "https" && !isLocalHostHeader(hostHeader) && process.env.AIMAC_ALLOW_INSECURE_PUBLIC_URL !== "true") return localEndpoint();
  return `${protocol}://${hostHeader}`.replace(/\/+$/u, "");
}

function requestHostAllowed(hostHeader) {
  if (!hostHeader) return false;
  if (isLocalHostHeader(hostHeader)) return true;
  const allowed = new Set(String(process.env.AIMAC_ALLOWED_PUBLIC_HOSTS || "").split(",").map((item) => item.trim()).filter(Boolean));
  const hostname = hostnameFromHostHeader(hostHeader);
  return allowed.has(hostHeader) || allowed.has(hostname);
}

function isLocalHostHeader(hostHeader) {
  return isLocalHostname(hostnameFromHostHeader(hostHeader));
}

function hostnameFromHostHeader(hostHeader) {
  const value = String(hostHeader || "").trim();
  if (value.startsWith("[")) return value.slice(1, value.indexOf("]"));
  return value.split(":")[0];
}

function isLocalHostname(hostname) {
  return ["127.0.0.1", "localhost", "::1"].includes(String(hostname || "").toLowerCase());
}

function canExposeBootstrapHint(req) {
  if (process.env.AIMAC_EXPOSE_BOOTSTRAP_HINT !== "true" && executionProfile === "production") return false;
  return isLoopbackAddress(req.socket.remoteAddress) && isLocalHostHeader(String(req.headers.host || ""));
}

function isLoopbackAddress(address) {
  const value = String(address || "");
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

const loginAttempts = new Map();

function loginClientIp(req) {
  if (process.env.AIMAC_TRUST_PROXY === "true") {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return String(req.socket.remoteAddress || "unknown");
}

function loginRateLimited(req) {
  const entry = loginAttempts.get(loginClientIp(req));
  if (!entry || Date.now() > entry.resetAt) return false;
  const maxAttempts = clampEnvNumber(process.env.AIMAC_LOGIN_ATTEMPTS_PER_MINUTE, 3, 10);
  return entry.count >= maxAttempts;
}

function loginRetryAfterSeconds(req) {
  const entry = loginAttempts.get(loginClientIp(req));
  if (!entry) return 0;
  return Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000));
}

function clearFailedLogins(req) {
  loginAttempts.delete(loginClientIp(req));
}

function recordFailedLogin(req) {
  const ip = loginClientIp(req);
  const nowMs = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || nowMs > entry.resetAt) {
    if (loginAttempts.size > 10000) loginAttempts.clear();
    loginAttempts.set(ip, {count: 1, resetAt: nowMs + 60000});
    return;
  }
  entry.count += 1;
}

function authenticateRequest(req, state) {
  const token = bearerToken(req);
  if (!token) return null;
  const tokenDigest = digestOf(`session:${token}`);
  const session = (state.authSessions || []).find((item) => item.tokenDigest === tokenDigest && item.status === "active" && new Date(item.expiresAt).getTime() > Date.now());
  if (!session) return null;
  return session;
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

function mcpContextFromRequest(req, state) {
  const token = bearerToken(req);
  if (!token) return null;
  const node = authenticateAgentNode(state, token);
  if (node) {
    return {
      principal: {kind: "agent_node", id: node.nodeId, projectIds: node.projectIds, allowedMcpTools: node.allowedMcpTools},
      allowedMcpTools: node.allowedMcpTools
    };
  }
  // 执行器凭据只在这里被接受 —— 网关端点走 authenticateAgentNode，认不出它。
  // 主体仍报成 agent_node（授权与 mcpGrants 的匹配逻辑一律不变），额外带上它被绑定的那条派发。
  const executor = authenticateExecutorPrincipal(state, token);
  if (executor) {
    return {
      principal: {kind: "agent_node", id: executor.node.nodeId, projectIds: executor.node.projectIds,
        allowedMcpTools: executor.node.allowedMcpTools, dispatchId: executor.dispatch.dispatchId, credentialKind: "executor"},
      allowedMcpTools: executor.node.allowedMcpTools
    };
  }
  const accountContext = accountFromRequest(req, state);
  if (isSystemAccount(accountContext?.account)) {
    return {principal: {kind: "system_admin", id: accountContext.account.accountId, allowedMcpTools: ["*"]}, allowedMcpTools: ["*"]};
  }
  const config = readRuntimeConfig();
  if (config.mcpServiceTokenHash === digestOf(`mcp-service:${token}`)) {
    // 把真实工具名传进去：不传的话"名字拼错了"那一半永远探测不到（白名单本身不核对工具存不存在）。
    const allowedMcpTools = mcpServiceAllowedTools(createMcpToolDefinitions().map((tool) => tool.name));
    return {principal: {kind: "system_service", id: "remote-mcp-client", projectIds: mcpServiceProjectIds(), allowedMcpTools}, allowedMcpTools};
  }
  return null;
}

function mcpServiceProjectIds() {
  const configured = String(process.env.AIMAC_MCP_SERVICE_PROJECT_IDS || "").split(",").map((item) => item.trim()).filter(Boolean);
  return configured.length ? configured : ["prj_control_plane"];
}


// 前置认证：有些路由必须先按 id 查出对象、才能算出授权作用域（例如按节点/派发所属任务组授权），
// 于是"对象存不存在""是否绑定在这个节点上"这类判断天然跑在 beginGuardedWrite 之前。若不先验身份，
// 这些分支就成了【无需任何凭证】的跨租户探测器：可枚举 id、区分"无此物"与"有但无权"、读出派发状态。
// 这里只验"你是谁"（会话有效即可），具体权限仍由下游的 beginGuardedWrite 按真实作用域判定。
function requireAuthenticated(req, state, res) {
  if (accountFromRequest(req, state) || authenticateAgentNode(state, bearerToken(req))) return true;
  json(res, 401, {error: "auth_required"});
  return false;
}

function accountFromRequest(req, state) {
  const session = authenticateRequest(req, state);
  if (!session) return null;
  const account = state.accounts.find((item) => accountIdOf(item) === session.accountId && item.status === "active");
  return account ? {session, account} : null;
}

// 按 id 取一个项目时，"查无此物"与"存在但不属于你"必须给同一个答案。原先前者一路走到
// 404 project_not_found、后者被 requireRead 挡成 403 —— 两者可分辨，这些路由就成了跨租户的
// 存在性探针：拿一个 id 试一下就知道这套部署里别处有没有它（本文件 resolveOrgMemberTarget
// 上方那段注释早把这条写成了口径，这里是同一条不变式在项目级路由上的缺口）。
// 系统账号不受影响：它本就有权知道什么存在，给它准确的 404，否则运维分不清是打错了 id 还是权限不对。
// 写路径同理：`beginGuardedWrite` 过了之后再查存在，就把"这个项目不存在"和"存在但你动不了"
// 分成了两种答案（404 vs 403/400）。对非系统账号统一成"看不见"那一种。
// 入口处的可见性判据：非系统账号对一个【看不见的】项目 id，无论它存不存在，都必须拿到同一个答案。
// 只在存在检查那一处统一还不够 —— 路由各自的判权点在后面，foreign 与 missing 会落到不同的码上
// （实测：POST config 落 policy_denied、POST members 落到更靠后的 account_not_found）。
// 返回布尔而不是一个 {status,payload}：鉴权布局门要求前置校验的响应是【字面量 4xx + 固定错误串】，
// 它没法判断一个变量 payload 里装的是不是状态内容 —— 那条判据是对的，这里照它的形状写。
// 未认证不在这里处理：交给后面的守卫回 401，否则会把 401 说成 403。
function projectHiddenFromActor(req, state, projectId) {
  const authenticated = accountFromRequest(req, state);
  if (!authenticated || isSystemAccount(authenticated.account)) return false;
  const project = state.projects.find((item) => item.id === projectId);
  return !(project && canReadResource(state, authenticated.account, projectScope(projectId)));
}

function missingProjectDenial(actorAccount) {
  if (isSystemAccount(actorAccount)) return {status: 404, payload: {error: "project_not_found"}};
  return {status: 403, payload: {error: "permission_denied"}};
}

// "查无此物"与"存在但你看不见"必须给同一个答案 —— 否则把 id 挨个试一遍，就能数出别的租户
// 有多少条记录、id 长什么样（本仓已在项目与任务组两处修过同一条不变式，见 missingProjectDenial）。
// 系统账号例外：它本就该知道什么存在，给它准确的 404，否则运维分不清是打错了 id 还是权限不对。
function missingRecordDenial(req, state, code, deniedError) {
  if (isSystemAccount(accountFromRequest(req, state)?.account)) return {status: 404, payload: {error: code}};
  return {status: 403, payload: {error: deniedError}};
}

function readableProjectOr403(req, state, projectId) {
  const reader = requireRead(req, state, projectScope(projectId));
  if (reader.status) return {denial: {status: reader.status, payload: reader.payload}};
  const project = state.projects.find((item) => item.id === projectId);
  if (project) return {reader, project};
  if (isSystemAccount(reader.account)) return {denial: {status: 404, payload: {error: "project_not_found"}}};
  return {denial: {status: 403, payload: {error: "permission_denied"}}};
}

function requireRead(req, state, resourceScope = {resourceType: "system", resourceId: "state"}) {
  const authenticated = accountFromRequest(req, state);
  if (!authenticated) return {status: 401, payload: {error: "auth_required"}};
  if (canReadResource(state, authenticated.account, resourceScope)) return authenticated;
  return {status: 403, payload: {error: "permission_denied"}};
}

function canReadResource(state, account, resourceScope = {}) {
  if (!account) return false;
  if (isSystemAccount(account)) return true;
  if (resourceScope.resourceType === "organization") return account.organizationId === resourceScope.resourceId;
  if (resourceScope.resourceType === "system") return false;
  if (resourceScope.resourceType === "project") return canReadProject(state, account, resourceScope.resourceId);
  if (resourceScope.resourceType === "task_group") return canReadTaskGroup(state, account, resourceScope.resourceId);
  return true;
}

function canReadProject(state, account, projectId, resolvedProject) {
  if (!projectId) return false;
  // resolvedProject：调用方已握有该 project 对象时传进来，省掉一次 state.projects.find —— 作用域视图
  // 构建里对每个 project 逐个判权，若这里再全表 find 就是 filter 里套 find＝O(项目数²)（读路径热点）。
  const project = resolvedProject || state.projects.find((item) => item.id === projectId);
  if (account.accountType === "org_admin" && project && (project.organizationId || DEFAULT_ORGANIZATION_ID) === account.organizationId) return true;
  if (project?.ownerAccountId === account.accountId || (project?.members || []).some((member) => member.accountId === account.accountId)) return true;
  return ["project:view", "project:*"].some((permission) => hasPermission(state, account.accountId, permission, {resourceType: "project", resourceId: projectId}));
}

function canReadTaskGroup(state, account, taskGroupId, resolvedTaskGroup, resolvedProject) {
  // resolvedTaskGroup/resolvedProject：作用域视图构建里对每个任务组逐个判权，若这里再全表 find 就是
  // filter 里套 find＝O(任务组²)+O(任务组×项目)（读路径热点，每次写后非系统账号首请求重建时跑）。
  const taskGroup = resolvedTaskGroup || state.taskGroups.find((item) => item.id === taskGroupId);
  if (!taskGroup) return false;
  if (isSystemAccount(account)) return true;
  const project = resolvedProject || state.projects.find((item) => item.id === taskGroup.projectId);
  if (project?.ownerAccountId === account.accountId) return true;
  return ["task_group:read", "task_group:review", "task_group:control", "task_group:orchestrate", "task_group:monitor", "task_group:*"].some((permission) =>
    hasPermission(state, account.accountId, permission, {resourceType: "task_group", resourceId: taskGroupId, projectId: taskGroup.projectId})
  );
}

// 非系统账号可下发的顶层 state 键白名单（已显式过滤的租户集合 + 全局安全的系统配置/计数器）。
// fail-closed：任何未列入的键（含未来新增且忘记过滤的键）在下发前被删除，避免默认整份泄漏给租户。
const SCOPED_ALLOWED_TOP_KEYS = new Set([
  "schemaVersion", "stateVersion", "orgMigrationVersion", "runtime", "managementSurfaces",
  "modelProviders", "modelCapabilities", "modelSelectionPolicies", "skillSources", "roleSkills",
  "agentControlSequence", "agentExecutionSequence", "leaseSequence",
  "projects", "taskGroups", "repositoryOutputs", "workSessions", "workerLanes", "agentDispatches",
  "agentRuntimeNodes", "agentControlCommands", "agentExecutionEvents", "agentJoinTokens", "agents",
  "agentTaskContracts", "effectiveInstructionPackets", "roleDriftGuards", "modelSelectionDecisions",
  "sessionPlacementDecisions", "roleSkillOverlays", "executionTopologies", "reviewPlans", "reviewBundles",
  "checkpoints", "completionReadiness", "closeBarriers", "admissionDecisions", "admissionScans", "sharedDefinitions", "progressSnapshots", "leases",
  "accounts", "accessGrants", "auditLog", "policyDecisions", "commands", "decisionRecords", "commandEffects", "dlqEntries", "integrationBatches",
  "idempotencyRecords", "runtimeIssuePatterns", "runtimeIssueSamples", "systemUpgradeCandidates",
  "agentGatewayEvents", "mcpCalls", "mcpProbeNodes", "instructionMetrics", "organizations",
  "humanConfirmationRequests", "humanDirectives", "transitionEvidence", "ruleSourceResolutions",
  "externalUpgradeImports", "mcpGrants", "roomMessages", "roomParticipants", "roomAcks", "roomSequenceByRoom",
  "permissionRequests", "approvalRequests", "artifacts", "testResults", "findings", "qualityGates",
  "derivedTaskRequests", "eventLog", "authSessions",
  // stateViewForAccount / 登录响应后续附加的派生字段
  "pendingHumanConfirmationTaskGroupIds"
]);

function scopedStateForAccount(state, account, session) {
  const cloned = {...state};
  delete cloned.__loadedStateVersion;
  const isSystem = isSystemAccount(account);
  cloned.authSessions = (state.authSessions || [])
    .filter((item) => isSystem || item.sessionId === session.sessionId)
    .map((item) => ({sessionId: item.sessionId, accountId: item.accountId, status: item.status, expiresAt: item.expiresAt, createdAt: item.createdAt, updatedAt: item.updatedAt}));
  cloned.projects = (state.projects || []).map(publicProjectRecord);
  cloned.agentRuntimeNodes = (state.agentRuntimeNodes || []).map(publicAgentNode);
  cloned.agentJoinTokens = listAgentJoinTokens(state);
  // 系统账号此前拿到的是【原始账号记录】：里面有 passwordDigest（口令的 scrypt 哈希）和
  // credentialDigest（一次性登录令牌的校验值）。控制台一个都不显示，把口令校验材料发进浏览器
  // 没有任何用处，却会跟着 devtools、HAR 导出、录屏和任何一次 XSS 一起走。
  // 非系统账号那条路（下面几十行处）早就在用显式白名单了 —— 系统这条只是绕开了它。
  // 白名单而不是黑名单：将来账号上再加一个机密字段，缺省不该是"发出去"。
  cloned.accounts = (state.accounts || []).map((item) => ({
    ...publicAccountRecord(item),
    ...(item.organizationId ? {organizationId: item.organizationId} : {}),
    ...(item.accountId === account.accountId ? {effectivePermissions: accountEffectivePermissions(state, account)} : {})
  }));
  if (isSystem) return cloned;
  // 把已握有的 project/taskGroup 对象直接传给判权函数（并用一张 projectById 现算任务组的项目），
  // 免得每项再全表 find —— 否则这两行是 filter 里套 find＝O(项目²)+O(任务组²)+O(任务组×项目)（实测
  // 8000 任务组仅这几处 self-find 就 154ms/次，且每次写后非系统账号首请求都重建）。
  const projectById = new Map((state.projects || []).map((project) => [project.id, project]));
  const visibleProjectIds = new Set((state.projects || []).filter((project) => canReadProject(state, account, project.id, project)).map((project) => project.id));
  const visibleTaskGroupIds = new Set((state.taskGroups || []).filter((taskGroup) => canReadTaskGroup(state, account, taskGroup.id, taskGroup, projectById.get(taskGroup.projectId))).map((taskGroup) => taskGroup.id));
  cloned.projects = (state.projects || []).filter((project) => visibleProjectIds.has(project.id));
  cloned.taskGroups = (state.taskGroups || []).filter((taskGroup) => visibleTaskGroupIds.has(taskGroup.id));
  cloned.repositoryOutputs = (state.repositoryOutputs || []).filter((target) =>
    target.taskGroupId ? visibleTaskGroupIds.has(target.taskGroupId) : visibleProjectIds.has(target.projectId)
  );
  cloned.workSessions = (state.workSessions || []).filter((sessionItem) => visibleTaskGroupIds.has(sessionItem.taskGroupId));
  cloned.workerLanes = (state.workerLanes || []).filter((lane) => lane.taskGroupId && visibleTaskGroupIds.has(lane.taskGroupId));
  cloned.agentDispatches = (state.agentDispatches || []).filter((dispatch) => visibleTaskGroupIds.has(dispatch.taskGroupId));
  cloned.agentRuntimeNodes = (state.agentRuntimeNodes || []).filter((node) => (node.projectIds || []).some((projectId) => visibleProjectIds.has(projectId))).map(publicAgentNode);
  const visibleNodeIds = new Set(cloned.agentRuntimeNodes.map((node) => node.nodeId));
  // A task-group-attributed record must be gated on task-group visibility (same invariant as
  // checkpoints/admissionDecisions): a plain project member without a task-group grant must not see a
  // hidden task group's execution events or control commands. Fall back to node visibility ONLY for
  // node-level records that carry no taskGroupId (e.g. refresh_profile control commands).
  cloned.agentControlCommands = (state.agentControlCommands || []).filter((command) => command.taskGroupId ? visibleTaskGroupIds.has(command.taskGroupId) : visibleNodeIds.has(command.nodeId));
  cloned.agentExecutionEvents = (state.agentExecutionEvents || []).filter((event) => event.taskGroupId ? visibleTaskGroupIds.has(event.taskGroupId) : visibleNodeIds.has(event.nodeId));
  cloned.agentJoinTokens = listAgentJoinTokens(state).filter((token) => visibleProjectIds.has(token.projectId));
  cloned.agents = (state.agents || []).filter((agent) =>
    (agent.organizationId || DEFAULT_ORGANIZATION_ID) === account.organizationId &&
    (!agent.projectId || visibleProjectIds.has(agent.projectId)));
  cloned.agentTaskContracts = (state.agentTaskContracts || []).filter((contract) => visibleTaskGroupIds.has(contract.taskGroupId));
  cloned.effectiveInstructionPackets = (state.effectiveInstructionPackets || []).filter((packet) => visibleTaskGroupIds.has(packet.taskGroupId));
  cloned.roleDriftGuards = (state.roleDriftGuards || []).filter((guard) => visibleTaskGroupIds.has(guard.taskGroupId));
  cloned.modelSelectionDecisions = (state.modelSelectionDecisions || []).filter((decision) => visibleTaskGroupIds.has(decision.taskGroupId));
  cloned.sessionPlacementDecisions = (state.sessionPlacementDecisions || []).filter((decision) => visibleTaskGroupIds.has(decision.taskGroupId));
  cloned.roleSkillOverlays = (state.roleSkillOverlays || []).filter((overlay) =>
    (overlay.taskGroupId && visibleTaskGroupIds.has(overlay.taskGroupId)) ||
    (!overlay.taskGroupId && overlay.projectId && visibleProjectIds.has(overlay.projectId))
  );
  cloned.executionTopologies = (state.executionTopologies || []).filter((item) => visibleTaskGroupIds.has(item.taskGroupId));
  cloned.reviewPlans = (state.reviewPlans || []).filter((item) => visibleTaskGroupIds.has(item.taskGroupId));
  cloned.reviewBundles = (state.reviewBundles || []).filter((item) => visibleTaskGroupIds.has(item.taskGroupId));
  cloned.checkpoints = (state.checkpoints || []).filter((checkpoint) => visibleTaskGroupIds.has(checkpoint.taskGroupId));
  cloned.completionReadiness = (state.completionReadiness || []).filter((item) => visibleTaskGroupIds.has(item.taskGroupId));
  cloned.closeBarriers = (state.closeBarriers || []).filter((item) => visibleTaskGroupIds.has(item.taskGroupId));
  // Gate strictly on task-group visibility (like checkpoints/completionReadiness/closeBarriers);
  // only fall back to project visibility for records that carry no taskGroupId. A plain project
  // member without a task-group grant must not see a hidden task group's admission decisions.
  cloned.admissionDecisions = (state.admissionDecisions || []).filter((item) => item.taskGroupId ? visibleTaskGroupIds.has(item.taskGroupId) : visibleProjectIds.has(item.projectId));
  cloned.admissionScans = (state.admissionScans || []).filter((item) => item.taskGroupId ? visibleTaskGroupIds.has(item.taskGroupId) : visibleProjectIds.has(item.projectId));
  cloned.sharedDefinitions = (state.sharedDefinitions || []).filter((definition) => visibleProjectIds.has(definition.projectId) || (definition.scopeRefs || []).some((ref) => visibleTaskGroupIds.has(String(ref).replace("TaskGroup:", ""))));
  // progressSnapshots 在下面被整体清空（界面不读它），这里原本的可见性过滤已无意义。
  // 租约按"它指向的产出目标是否可见"过滤。原先对每条租约都整趟扫一遍 repositoryOutputs ——
  // 两个集合都随工作量增长，于是每次取状态都要付一次乘积（实测 n=3200 时 78ms，每请求）。
  // 先把可见目标的 ref 收成集合：结果完全一样，代价从 O(租约×产出) 降到 O(租约+产出)。
  const visibleOutputRefs = new Set(cloned.repositoryOutputs.map((target) => `RepositoryOutputTarget:${target.targetId}`));
  cloned.leases = (state.leases || []).filter((lease) => visibleOutputRefs.has(lease.resourceRef));
  const visibleAccountIds = new Set([account.accountId]);
  for (const project of cloned.projects) {
    for (const member of project.members || []) visibleAccountIds.add(member.accountId);
  }
  cloned.accounts = (state.accounts || []).filter((item) => visibleAccountIds.has(item.accountId)).map((item) => ({
    schemaVersion: item.schemaVersion,
    accountId: item.accountId,
    accountType: item.accountType,
    displayName: item.displayName,
    email: item.email,
    status: item.status,
    roles: item.roles,
    permissions: item.accountId === account.accountId ? item.permissions : [],
    ...(item.accountId === account.accountId ? {effectivePermissions: accountEffectivePermissions(state, account)} : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  }));
  cloned.accessGrants = (state.accessGrants || []).filter((grant) => {
    const resource = grant.resource || {};
    return grant.subjectRef?.subjectId === account.accountId ||
      (resource.resourceType === "project" && visibleProjectIds.has(resource.resourceId)) ||
      (resource.resourceType === "task_group" && visibleTaskGroupIds.has(resource.resourceId));
  });
  cloned.auditLog = [];
  cloned.policyDecisions = [];
  cloned.commands = [];
  cloned.decisionRecords = [];
  cloned.commandEffects = [];
  cloned.dlqEntries = (state.dlqEntries || []).filter((item) => item.taskGroupId ? visibleTaskGroupIds.has(item.taskGroupId) : visibleProjectIds.has(item.projectId));
  cloned.integrationBatches = [];
  cloned.idempotencyRecords = {};
  cloned.runtimeIssuePatterns = [];
  cloned.runtimeIssueSamples = [];
  // 原先一律清空：而 runtime_issue_candidates_exported 这道门就是按它阻塞的，
  // 于是人在控制台上看到一个红色阻塞项，却连它指的是哪条记录都看不到，更别说处置。
  // 按可见任务组下发（与 findings/qualityGates 同规），跨租户仍然看不到。
  cloned.systemUpgradeCandidates = (state.systemUpgradeCandidates || []).filter((item) => item.taskGroupId && visibleTaskGroupIds.has(item.taskGroupId));
  cloned.agentGatewayEvents = [];
  cloned.mcpCalls = [];
  cloned.mcpProbeNodes = [];
  // 下面这五个【全站没有一处读 state.<它们>】，而主视图每次都整份传：
  // roleSkills 一项在真实部署里就是 293 KB（整份状态的 73%），加起来 309 KB 白传。
  // 技能源与模型两页各有专用端点按需取（roleSkills 那页现在只取按来源的计数），
  // 进度快照走 /api/task-groups/:id/progress，都不依赖主视图基底。
  // 它们仍留在 SCOPED_ALLOWED_TOP_KEYS 里 —— 那是【防泄漏的白名单】，管的是"允许出现什么"，
  // 与"这一份要不要带上它"是两回事，不能混为一谈。
  cloned.roleSkills = [];
  cloned.modelSelectionPolicies = [];
  cloned.progressSnapshots = [];
  cloned.modelProviders = [];
  cloned.managementSurfaces = [];
  cloned.instructionMetrics = {
    ...state.instructionMetrics,
    envelopes: (state.instructionMetrics?.envelopes || []).filter((envelope) => envelope.taskGroupId && visibleTaskGroupIds.has(envelope.taskGroupId))
  };
  cloned.organizations = (state.organizations || []).filter((org) => org.orgId === account.organizationId);
  cloned.humanConfirmationRequests = (state.humanConfirmationRequests || []).filter((item) => visibleTaskGroupIds.has(item.taskGroupId));
  cloned.humanDirectives = (state.humanDirectives || []).filter((item) => (item.taskGroupId && visibleTaskGroupIds.has(item.taskGroupId)) || (!item.taskGroupId && visibleProjectIds.has(item.projectId)));
  // 转移证据不出 API，任何视角都不给 —— 它的记录里没有 projectId/taskGroupId，放出去就是把别的租户的
  // 对象 id 与状态流转一起交出去。它是给事故时直接看磁盘 state 的人用的取证记录。
  // 想把它接进控制台的话，先给 recordTransition 补上租户归属再谈，别只改这一行。
  cloned.transitionEvidence = [];
  // 原先一律清空，而 rules_candidates_processed / all_rule_sources_resolved 两道门就是按它阻塞的：
  // 人在关闭门禁上看到红 chip，处置它的表单却永远渲染不出来，因为数据根本没下发。
  // 与 findings/qualityGates 同规按可见任务组过滤，跨租户仍然看不到。
  cloned.ruleSourceResolutions = (state.ruleSourceResolutions || []).filter((item) => item.taskGroupId && visibleTaskGroupIds.has(item.taskGroupId));
  cloned.externalUpgradeImports = [];
  cloned.mcpGrants = (state.mcpGrants || []).filter((grant) => grant.taskGroupId && visibleTaskGroupIds.has(grant.taskGroupId));
  const visibleRoomIds = new Set([...visibleTaskGroupIds].map((taskGroupId) => `room_${taskGroupId}`));
  cloned.roomMessages = (state.roomMessages || []).filter((message) => visibleRoomIds.has(message.roomId));
  cloned.roomParticipants = (state.roomParticipants || []).filter((participant) => visibleRoomIds.has(participant.roomId));
  cloned.roomAcks = (state.roomAcks || []).filter((ack) => visibleRoomIds.has(ack.roomId));
  cloned.roomSequenceByRoom = Object.fromEntries(Object.entries(state.roomSequenceByRoom || {}).filter(([roomId]) => visibleRoomIds.has(roomId)));
  cloned.permissionRequests = (state.permissionRequests || []).filter((item) => item.taskGroupId && visibleTaskGroupIds.has(item.taskGroupId));
  cloned.approvalRequests = (state.approvalRequests || []).filter((item) => item.taskGroupId && visibleTaskGroupIds.has(item.taskGroupId));
  cloned.artifacts = (state.artifacts || []).filter((item) => item.taskGroupId && visibleTaskGroupIds.has(item.taskGroupId));
  cloned.testResults = (state.testResults || []).filter((item) => item.taskGroupId && visibleTaskGroupIds.has(item.taskGroupId));
  cloned.findings = (state.findings || []).filter((item) => item.taskGroupId && visibleTaskGroupIds.has(item.taskGroupId));
  cloned.qualityGates = (state.qualityGates || []).filter((item) => item.taskGroupId && visibleTaskGroupIds.has(item.taskGroupId));
  cloned.derivedTaskRequests = (state.derivedTaskRequests || []).filter((item) => item.taskGroupId && visibleTaskGroupIds.has(item.taskGroupId));
  cloned.eventLog = (state.eventLog || []).filter((event) => event.taskGroupId && visibleTaskGroupIds.has(event.taskGroupId));
  // fail-closed：删除白名单外的任何顶层键（防未来新增未过滤的键默认整份泄漏给租户）
  for (const key of Object.keys(cloned)) {
    if (!SCOPED_ALLOWED_TOP_KEYS.has(key)) delete cloned[key];
  }
  return cloned;
}

const scopedStateCache = new Map();

function withoutStateInternals(state) {
  const clean = {...state};
  delete clean.__loadedStateVersion;
  return clean;
}

function cachedScopedState(state, account, session) {
  const key = `${account.accountId}:${session.sessionId}:${state.stateVersion}`;
  const cached = scopedStateCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.scoped;
  const scoped = scopedStateForAccount(state, account, session);
  if (scopedStateCache.size > stateViewMaxEntries) scopedStateCache.clear();
  scopedStateCache.set(key, {scoped, expiresAt: Date.now() + stateViewCacheTtlMs});
  return scoped;
}

// 列表视图里每个任务组最多嵌这么多工作单元；真实总数另给 workItemCount。
const embeddedWorkItemCap = clampEnvNumber(process.env.AIMAC_VIEW_EMBEDDED_WORK_ITEM_CAP, 5, 20);
// 明细页（/api/task-groups/:id/progress）比列表视图需要多得多的工作项，但也不能不设上限。
const progressWorkItemCap = clampEnvNumber(process.env.AIMAC_PROGRESS_WORK_ITEM_CAP, 20, 300);

// 只写一处：视图基底与各视角的字段清单都会产出 taskGroups，分别写一遍的话，
// 后写的那次会把前一次的截断【覆盖掉】——实测就是这么漏的（tasks 视角照旧 89KB）。
function projectTaskGroupsForView(taskGroups) {
  return taskGroups.map((taskGroup) => {
    // taskAnalysis.items 每个工作单元一条（实测 1500 单元时这一项 206KB），而控制台读的是
    // 进度接口给的那份（progressData.taskAnalysis），从不读状态里的这份 —— 只留汇总标识。
    const analysis = taskGroup.taskAnalysis;
    const slimAnalysis = analysis && Array.isArray(analysis.items)
      ? {...analysis, items: undefined, itemCount: analysis.items.length}
      : analysis;
    const items = Array.isArray(taskGroup.workItems) ? taskGroup.workItems : [];
    // roles 列表页只用来数个数（「角色数：N」），明细页读的是进度接口给的那份。
    // 整份带上在 80 组时约 11 KB，而这一页每 5 秒轮询一次 —— 只给个数。
    const roles = Array.isArray(taskGroup.roles) ? taskGroup.roles : [];
    // 语言策略整份 331 字节（scope 一项就占 133），而控制台只读 languageTag / languageName
    //（列表那句「语言：中文」和详情页那个下拉的预选值）。80 组时约 24 KB，每 5 秒一次。
    const policy = taskGroup.languagePolicy;
    const slimPolicy = policy
      ? {languageTag: policy.languageTag, ...(policy.languageName ? {languageName: policy.languageName} : {})}
      : policy;
    const projected = {...(slimAnalysis === analysis ? taskGroup : {...taskGroup, taskAnalysis: slimAnalysis}),
      roles: undefined, roleCount: roles.length, ...(policy ? {languagePolicy: slimPolicy} : {})};
    if (items.length <= embeddedWorkItemCap) return {...projected, workItemCount: items.length};
    return {...projected, workItems: newestWindow(items, embeddedWorkItemCap),
      workItemCount: items.length, workItemsTruncated: true};
  });
}

// 组织用量是【派生量】，而它此前只在写入端点和 GET /api/orgs 上重算。组织管理员自己的概览页
// 走的是 GET /api/state?view=orgs，读到的是上一次写入时存下来的那份快照 —— 于是同一个数字
// 两页不一致，而人自己那页是旧的：实测任务组配额 1/1 已满、建第二个被 409 拒（usage=1），
// 概览却显示 0。人会以为还有名额，点下去必然失败。
// 在出口处按当前状态重算，并且【不写回】那份跨请求复用的 scoped 缓存对象（与同一函数里
// 归档故障、自治心跳两条同规：易变或派生的事实不进缓存）。计数规则不在这里重写一遍，
// 仍然交给 recomputeOrganizationUsage —— 两处口径必须是同一份代码。
function organizationsWithFreshUsage(state, organizations) {
  if (!Array.isArray(organizations) || !organizations.length) return organizations;
  const probe = {
    organizations: organizations.map((org) => ({orgId: org.orgId})),
    accounts: state.accounts, projects: state.projects,
    taskGroups: state.taskGroups, agentRuntimeNodes: state.agentRuntimeNodes
  };
  recomputeOrganizationUsage(probe);
  const fresh = new Map(probe.organizations.map((org) => [org.orgId, org.usage]));
  return organizations.map((org) => ({...org, usage: fresh.get(org.orgId) || org.usage}));
}

function stateViewForAccount(state, account, session, view = "full", limit = 80, requestedProjectId = null) {
  const scoped = cachedScopedState(state, account, session);
  // 归档故障的错误文本里会带运行目录路径，且它是系统级运维事实 —— 只给系统账号。
  // 不写进 scoped：那份对象带缓存且跨请求复用，改它会把故障粘在缓存里。
  // 故障标记现在由共享台账持有（MCP 那条写路径的归档失败也算在内，两边是同一本账）。
  const auditArchiveFault = sharedAuditArchiveFault();
  // 事件日志的损坏行走同一条路：重建索引时跳过一行坏数据，后果是序号可能被重用、
  // 幂等键可能失效 —— 都不会自己现形，必须让人看见。
  const eventLogFault = projectEventLogFault();
  const faultField = isSystemAccount(account)
    ? {...(auditArchiveFault ? {auditArchiveFault} : {}), ...(eventLogFault ? {eventLogFault} : {})}
    : {};
  // 自治循环心跳同理：它在 state.runtime 里，而 scoped 那份对象【按 stateVersion 缓存并跨请求复用】。
  // 空转不再落盘之后版本号不动，于是整份 scoped（含心跳）被复用到过期为止 ——
  // 控制台上"上次推进时间"冻住，看起来像自治循环死了。所以在出口处用内存里的实时值覆盖，
  // 与上面那条归档故障同规：易变的运行时事实不进缓存对象。
  const liveRuntime = {...scoped.runtime, autonomousOrchestrator: runtimeOrchestratorStatus};
  if (!view || view === "full") {
    return {...scoped, organizations: organizationsWithFreshUsage(state, scoped.organizations),
      runtime: liveRuntime, ...faultField};
  }
  const capped = Math.max(10, Math.min(500, Number(limit || 80)));
  // 项目视角的页面（任务/监控/项目设置）本来就只看当前项目，而视图此前是【按账号可见范围取最新 N 条】，
  // 再由控制台自己过滤。后果有两条：一是载荷按整个账号的规模走（实测 400 单元时监控页一次轮询 1.78MB，
  // 而它最多渲染 20 行/表）；二是【安静项目会看不到自己的记录】—— 别的项目更新的记录先把窗口占满了，
  // 页面上是空表，人却以为"这个项目没有记录"。所以过滤放到服务端、放在截断【之前】。
  const scopeProjectId = requestedProjectId && (scoped.projects || []).some((item) => item.id === requestedProjectId)
    ? requestedProjectId
    : null;
  // 判据由【数据自身】决定：记录上带 projectId 且不等于当前项目的就滤掉，其余一律保留。
  // 不维护"哪些集合属于项目"的清单 —— 第一版拿存储层的分片清单来当这个清单，结果漏掉了
  // modelSelectionDecisions 这类中央集合（分片是按存储布局切的，不是按归属切的），过滤等于没生效。
  // 有些记录不带 projectId，靠 taskGroupId 归属项目（按 schema 全量核对是三种：worker lane、
  // 指令信封、任务分析；其中 worker lane 就在 runtime 视图里下发）。只看 projectId 的判据会把
  // 它们当成"公共记录"整份放行 —— 实测选中 A 项目时，监控页拿到的是 B 项目的全部 lane。
  // 而账本上限只留 60 条，本项目自己的 lane 完全可能被别的项目挤出窗口，
  // 那正是当初做项目过滤要解决的毛病（"安静项目看不到自己的记录"）。
  // 判据本身在 control-plane-core 里，那里造得出入参、两条分支都单测得到。
  const inRequestedProject = makeProjectScopePredicate(scoped.taskGroups, scopeProjectId);
  const scopeCollection = (value) => (scopeProjectId && Array.isArray(value) ? value.filter(inRequestedProject) : value);
  // 账本类集合：控制台每张表最多渲染 10~20 行，却按整页上限（200）取 —— 实测 400 单元时
  // 监控页一次轮询 1.1MB，绝大多数记录从没被显示过。给它们单独设一个更小的上限；
  // 任务组这类"人要逐条扫"的集合不动（那会让大项目的列表少列条目）。
  // 截断仍会被如实标记（界面显示"共 N+ 条"），所以少取不等于少说。
  // 上限做成可配：默认 60（每张账本表最多渲染 20 行，3 倍余量），
  // 而门要能把它调小才验得动"截断仍会被如实标记"—— 造 60 条账本记录只为验一个标记，代价不合理。
  const ledgerLimit = Math.min(capped, clampEnvNumber(process.env.AIMAC_VIEW_LEDGER_LIMIT, 1, 60));
  const LEDGER_COLLECTIONS = new Set(["modelSelectionDecisions", "sessionPlacementDecisions", "admissionDecisions",
    "agentExecutionEvents", "agentControlCommands", "workerLanes", "transitionEvidence"]);
  const limitFor = (field) => (LEDGER_COLLECTIONS.has(field) ? ledgerLimit : capped);
  const base = {
    schemaVersion: scoped.schemaVersion,
    stateVersion: scoped.stateVersion,
    runtime: liveRuntime,
    // 舰队计数（只有数字，几十字节）。没有它，界面就无从知道"活挂着但没有任何 agent 能接"——
    // 实测零节点时循环照样造出成千上万个 active 会话与租约，控制台看上去一片繁忙，
    // 而真相是没有任何东西在跑。节点明细只在 agent 页下发，这里不带。
    // 按项目切分之后再数：选中项目时，别的项目的节点不能算进这个项目的舰队。
    // total 原先数的是【所有行，含已吊销】。界面拿它分岔："已注册 N 个，把降级的那台修好或重启"
    // 与"一个都还没注册，按安装指引接一台" —— 三台全被吊销时会说前一句，让人去修一台不存在的机器。
    // 已吊销的节点不再参与任何事，不该出现在这个分母里。
    fleet: {
      online: (scopeCollection(scoped.agentRuntimeNodes) || []).filter((node) => node.status === "online").length,
      total: (scopeCollection(scoped.agentRuntimeNodes) || []).filter((node) => node.status !== "revoked").length
    },
    // 在制品额度（两个数字）。编排周期一旦按这个额度把单元判成 resource_queued，界面必须能说出
    // "为什么我的单元不动" —— 后端有闸而界面没有出口，等于这个闸对使用者不存在。
    // 现算而不是复用周期里的那份：周期里的数是那一拍的快照，请求到达时早就过期了。
    // blocked 是【在飞但自己也卡住了】的那部分（等权限、等定稿、被暂停）。没有这个数，界面只能说
    // "等在飞的活跑完就会自动继续" —— 而这些活恰恰不会自己跑完，那句话把人支到一边干等。
    wip: scopeProjectId
      ? {inFlight: countInFlightDispatchesByProject(scoped).get(scopeProjectId) || 0,
         capacity: wipCapacityForProject(scoped, scopeProjectId),
         blocked: (scoped.agentDispatches || []).filter((dispatch) =>
           dispatch.projectId === scopeProjectId && dispatch.status === "blocked").length}
      : null,
    agents: sliceItems(scoped.agents, capped),
    // 项目列表被上限截断时，窗口之外的项目在界面上【完全选不到】：切换器就是拿这个列表渲染的
    // <select>。而且更糟 —— 控制台发现自己保存的项目不在列表里，会静默切到第一个项目，
    // 于是一个在第 95 个项目上工作的人，刷新之后人就在第 1 个项目里，没有任何提示。
    // 服务端这边其实是对的：带上 projectId 时它照样按那个项目切数据。缺的只是"选得到"。
    // 两件事分开办：
    // 1) 当前请求的这个项目，它的完整记录一定要在（否则页面拿不到名称/进度）；
    // 2) 额外给一份只有 id/名称/状态的全量索引，供切换器列出全部项目。
    //    只在真的被截断时才带上 —— 项目数不到上限的部署一分钱都不用付。
    projects: (() => {
      const window = sliceItems(scoped.projects, capped);
      if (!scopeProjectId || window.some((project) => project.id === scopeProjectId)) return window;
      const requested = (scoped.projects || []).find((project) => project.id === scopeProjectId);
      return requested ? [requested, ...window.slice(0, Math.max(0, window.length - 1))] : window;
    })(),
    ...((scoped.projects || []).length > capped
      ? {projectIndex: (scoped.projects || []).map((project) => ({id: project.id, name: project.name, status: project.status}))}
      : {}),
    // 任务组把全部工作单元嵌在里面，而它在【基底】里 —— 每个视图、每次请求都带上。
    // 实测 3000 单元时仅这一项就 276KB，且随规模线性涨。控制台在列表页只用它做一个计数，
    // 明细页的工作项另有专用端点 /api/task-groups/:id/progress。
    // 所以这里截断，但必须【同时给出真实总数】：把截断后的长度当总数，正是这套系统反复栽过的坑。
    // 基底里的集合同样要按项目过滤。此前只有把 taskGroups 列进 viewFields 的视图（tasks）
    // 才拿得到过滤版，runtime 视图没列它 —— 于是选中一个项目打开监控页，下发的是【全部项目】
    // 的任务组（实测 100 个项目时 235KB / 每 5 秒一次，而这一页只关心选中的那个）。
    // 同一个集合在一个视图里按项目切、在另一个视图里不切，是"有的有、有的没有"的又一例。
    taskGroups: projectTaskGroupsForView(sliceItems(scopeCollection(scoped.taskGroups), capped)),
    // modelCapabilities 不进基底：只有系统设置那一页读它（实测 15.8 KB），而基底意味着
    // 【每个视图、每次轮询】都带一遍。它现在只列在 runtime 视图里 —— 那正是那一页取的视图。
    agentRuntimeNodes: sliceItems(scopeCollection(scoped.agentRuntimeNodes), capped),
    // progressSnapshots 不进视图基底：控制台的进度数据走专用端点 /api/task-groups/:id/progress
    // 按需取，全站没有一处读 state.progressSnapshots。而单条快照把 repositoryOutputs 与 workItems
    // 整份嵌了进去（实测 300 单元时 97KB/条），基底又意味着【每个视图、每次请求】都带上 ——
    // 实测每次响应白白多 191KB。MCP 那一侧照常下发（doctor-mcp 在验它的租户隔离），view=full 也照旧。
    pendingHumanConfirmationTaskGroupIds: (scoped.humanConfirmationRequests || []).filter((item) => item.status === "pending").map((item) => item.taskGroupId),
    // Lightweight id->displayName directory (visible accounts only) so views that show a decidedBy/actor
    // account (e.g. the review answered-history) render a name instead of a raw acct_ id. scoped.accounts
    // is already filtered to visible accounts + redacted; we expose only id+displayName here.
    accountDirectory: Object.fromEntries((scoped.accounts || []).map((item) => [item.accountId, item.displayName || item.accountId])),
    ...faultField
  };
  // 记录里有些字段【控制台一个都不读】，而它们占了大头：单条模型选择决策 3989 字节，
  // 其中 candidateRankings 1869、hardConstraintResults 550 —— 视图一次发 80 条，
  // 光这两项就是约 190KB，而界面只显示角色、工作项、选定模型、状态和一句摘要。
  // 只在【视图】里裁掉：state 本身、view=full、MCP 下发都不受影响，需要细节时从那里取。
  // 判据由 validate-specs 守着：被裁掉的字段不得在控制台被引用（想渲染它就先把裁剪去掉）。
  const viewDroppedFields = {
    modelSelectionDecisions: ["candidateRankings", "hardConstraintResults"],
    // 关闭门记录单条 5.6KB，而控制台只读 satisfied / blockingObjects / taskGroupId / computedAt：
    // gateResults 一项就占 53%（26 道门各带 evidenceRefs），requiredGates 又占 13%。
    // 实测 400 单元时任务页 428KB 里有 121KB 是它们，而这一页每 5 秒轮询一次。
    // 只在视图里裁 —— 账本本身（state/full/MCP）一个字段不动，审计仍然拿得到完整的门禁判定。
    closeBarriers: ["gateResults", "requiredGates", "sourceQueryRefs", "holisticJudgment"],
    // taskAnalysis 控制台一处都不读【视图里这份】：明细页读的是进度接口给的那份
    //（progressData.taskAnalysis）。80 组时约 6.6 KB，每 5 秒一次。
    taskGroups: ["taskAnalysis"]
  };
  const viewFields = {
    // policyDecisions / commands / decisionRecords 控制台一处都没读 —— 需要时从 view=full 取。
    system: ["accounts", "auditLog"],
    users: ["accounts", "accessGrants", "projects", "agentJoinTokens"],
    projects: ["accounts", "accessGrants", "projects", "repositoryOutputs", "agentJoinTokens"],
    tasks: ["taskGroups", "workSessions", "agentDispatches", "agentControlCommands", "agentExecutionEvents", "repositoryOutputs", "checkpoints", "closeBarriers", "humanConfirmationRequests", "humanDirectives", "permissionRequests", "approvalRequests", "findings", "qualityGates", "testResults", "reviewPlans", "sharedDefinitions", "reviewBundles", "ruleSourceResolutions", "systemUpgradeCandidates", "executionTopologies",
      // 死信队列挡着 no_active_dlq 关闭门、属任务组维度，要下发到 monitor 页才有处置入口。
      "dlqEntries",
      // artifacts 此前在防泄漏白名单里却【没有任何视图下发它】。关闭门的 artifacts_verified
      // 只说一句"还有产物没核验"、指不出是哪一条，而人被要求"等执行方补齐证据或取消对应工作项"。
      "artifacts"],
    runtime: ["modelCapabilities", "modelSelectionPolicies", "modelSelectionDecisions", "sessionPlacementDecisions", "admissionDecisions", "workerLanes", "workSessions", "agentDispatches", "agentControlCommands", "agentExecutionEvents", "agentJoinTokens", "skillSources", "roleSkillOverlays"],
    // effectiveInstructionPackets / roleDriftGuards 控制台一处都没读（实测这一视图 608KB 里
    // 它们占 303KB）。需要时可从 view=full 或专用接口取，不该让每次打开这一页都付这笔钱。
    instructions: ["instructionMetrics", "sharedDefinitions"],
    // 组织概览此前只能取 view=full —— 因为没有任何视图带 organizations，而 full 是【不切片】的：
    // 实测 1000 个单元时它返回 16.9MB、单次请求同步占用主线程 149ms，且随部署规模无界增长。
    // 这一页真正要的只有 organizations（projects/taskGroups 本就在视图基底里）。
    orgs: ["organizations", "accessGrants"]
  };
  // 认不出的视图名此前静默降级成基底：调用方拿到 200 和一份看着正常、却少了全部集合的载荷，
  // 没有任何迹象说明它要的那些东西根本没被组装（我自己就用 view=directives 这个不存在的名字
  // 得出过"指令一条都没有"的错误结论）。缺省不得等于"看起来成功"——认不出就直说，并给出可选值。
  if (!Object.prototype.hasOwnProperty.call(viewFields, view)) {
    throw Object.assign(new Error("state_view_unknown"), {status: 400,
      details: {view, supported: ["full", ...Object.keys(viewFields)]}});
  }
  for (const field of viewFields[view] || []) {
    const value = field === "organizations" ? organizationsWithFreshUsage(state, scoped.organizations) : scoped[field];
    const scopedValue = scopeCollection(value);
    base[field] = Array.isArray(scopedValue)
      ? (field === "taskGroups" ? projectTaskGroupsForView(sliceItems(scopedValue, limitFor(field))) : sliceItems(scopedValue, limitFor(field)))
      : scopedValue;
    const dropped = viewDroppedFields[field];
    if (dropped && Array.isArray(base[field])) {
      base[field] = base[field].map((item) => {
        if (!item || typeof item !== "object") return item;
        const trimmed = {...item};
        for (const key of dropped) delete trimmed[key];
        return trimmed;
      });
    }
  }
  // 技能源那一页要显示「每个源提供了多少角色技能」。roleSkills 本身不下发（281 条 293KB、
  // 界面从不读正文），改为在这里给出【按来源分组的计数】。原先只有 /api/skill-registry 算它，
  // 而控制台读的是这个视图、一次都没调过那个接口 —— 于是屏幕上每个源的角色数恒为 0，
  // 横幅也恒说「一个角色技能都还没取下来」（真实运行态实测：明明有 281 条）。
  // 计数用【未截断】的那份算：视图上限会把 269 条截到 188，那个数本身就是错的。
  // 控制台判「这件事我能不能处置」用的是 effectivePermissions —— 那是【跨资源的并集】，
  // 注释里也写明了它只是 UI 提示。而后端每一次写入都按资源判（canReadTaskGroup 那一套）。
  // 于是「待你处理」那块会把【别的任务组】的待办也算成你的：只在 tg1 上有评审权的人，
  // 看到的数字里混着 tg2 的，点进去必然 403。而那块面板恰恰写着「只统计你有权处置的」。
  // 这里按任务组把真实权限算出来给界面。口径不在这儿重写一遍 —— 仍旧调后端那份 hasPermission。
  if (view === "tasks") {
    const consolePermissions = ["task_group:read", "task_group:review", "task_group:control", "task_group:orchestrate"];
    // 编码成「默认集 + 只列例外」：系统账号/项目所有者在每一组上都是全权限，逐组重复四个串
    // 在 80 组时就要 8.4 KB（占这一份载荷的 10%），而它每次轮询都要传一遍。
    const taskGroupPermissions = {};
    const fullSet = isSystemAccount(account) ? consolePermissions : null;
    for (const taskGroup of base.taskGroups || []) {
      const project = (state.projects || []).find((item) => item.id === taskGroup.projectId);
      // 项目所有者这一条不在 hasPermission 里（canReadTaskGroup 也是单独判的），照它的写法来。
      const owns = project?.ownerAccountId === account.accountId;
      const granted = isSystemAccount(account) || owns
        ? consolePermissions
        : consolePermissions.filter((permission) => hasPermission(state, account.accountId, permission,
          {resourceType: "task_group", resourceId: taskGroup.id, projectId: taskGroup.projectId}));
      // 与默认集一致的不列出来 —— 界面拿不到条目时按默认集判（见 hasGroupPerm）。
      if (fullSet && granted.length === fullSet.length) continue;
      taskGroupPermissions[taskGroup.id] = granted;
    }
    base.taskGroupPermissions = taskGroupPermissions;
    base.taskGroupPermissionsDefault = fullSet || [];
  }
  if (view === "runtime") {
    const roleSkillCountBySource = {};
    // 从 state 算而不是 scoped：非系统账号那条路上 scoped.roleSkills 被清空了（省掉那 293 KB 的
    // 那次改动清的；系统账号走的是更上面的 early return，所以拿 scoped 算只在系统视角下"碰巧对"）。
    for (const skill of state.roleSkills || []) {
      const key = skill.sourceId || "unknown";
      roleSkillCountBySource[key] = (roleSkillCountBySource[key] || 0) + 1;
    }
    base.roleSkillCountBySource = roleSkillCountBySource;
  }
  // 视角为了体积把每个集合截到 capped 条，而界面拿这些数组直接报数（「共 N 项等待你处理，跨你
  // 可见的全部项目统计」）——超过上限时那个 N 是错的，且错得毫无痕迹：人以为处置完这 N 项就清空了。
  // 这里如实告诉界面哪些集合被截断过，界面据此改口径，而不是把截断后的长度当成总数。
  const truncatedCollections = [];
  for (const [field, value] of Object.entries(base)) {
    // 比较对象必须是【按项目过滤之后】的那份：拿账号范围的数组来比，
    // 按项目取数时每个集合都会被标成截断，界面上到处是"共 N+ 条"，而它其实取全了 ——
    // 那是把"我这里就这么多"说成了"还有更多"，同样是报数不实。
    const comparable = scopeCollection(scoped[field]);
    if (Array.isArray(value) && Array.isArray(comparable) && comparable.length > value.length) {
      truncatedCollections.push(field);
    }
  }
  if (truncatedCollections.length) base.truncatedCollections = truncatedCollections;
  // 存储层的容量淘汰是另一回事：视图截断说的是「这次没加载全，记录还在」，
  // 而这些是【已经被丢掉了】—— 两句话给人的下一步动作完全不同（一个是翻页/收窄范围，
  // 一个是去归档里找、或者接受它已经没了）。所以单独一个字段，界面分开说。
  // 只有一份计数：分片裁剪与网关裁剪都就地累加到 centralDroppedCounts（它随中央态落盘）。
  // 曾经另有一个「合并时算出来」的派生版本，那是错的 —— 读取先看缓存，而写入会把
  // 调用方那份没经过合并的对象填进缓存，于是写→读循环里它从来不在，横幅时有时无。
  const dropped = Object.entries(state.centralDroppedCounts || {})
    .filter(([field, count]) => Number(count) > 0 && Array.isArray(base[field]));
  if (dropped.length) base.storageDroppedCounts = Object.fromEntries(dropped);
  return base;
}

// ETag = 视图缓存键 + 那些不进 stateVersion 的运行时事实。后者不带上的话，
// 自治循环停摆告警、审计归档故障这类只活在内存里的变化会被 304 一直挡在门外。
// 不进 stateVersion、只活在内存里的运行时事实：自治循环心跳与归档故障。
// 它们既要进 ETag，也要进【视图缓存的键】—— 只进 ETag 的话，304 判对了，
// 但 200 那一路会从缓存里拿出一份旧载荷。此前 stateVersion 每拍都涨掩盖了这一点；
// 空转不再落盘之后，控制台上的"上次推进时间"就冻住了，看起来像自治循环死了。
function runtimeFactsSignature() {
  return [
    runtimeOrchestratorStatus?.lastTickAt || "",
    runtimeOrchestratorStatus?.consecutiveErrors || 0,
    runtimeOrchestratorStatus?.enabled ? 1 : 0,
    sharedAuditArchiveFault()?.at || ""
  ].join("|");
}

function stateViewEtag(cacheKey, central) {
  return `W/"${digestOf(`${cacheKey}\u0000${central?.stateVersion || 0}\u0000${runtimeFactsSignature()}`).slice(7, 39)}"`;
}

// 【键里的 stateVersion 是正确性那一条，writeState 里的 clear() 只是及时回收内存】——
// 两者看着冗余，其实分工不同，别把哪一条当成多余删掉：
//  · 本进程自己写：clear() 与版本号都能让它失效。
//  · 【别的进程】写（每次请求都从磁盘重读状态，本仓真有多进程写同一份状态）：
//    那句 clear 根本不会在这一台上执行，只有版本号进键才兜得住。并发写入门里有专门的用例。
// 前提是"每一次写入都涨版本号"——会话过期清扫那处原先漏了，已补。
function stateViewCacheKey(account, session, stateVersion, view, limit, projectId) {
  // projectId 必须进键：不进的话，同一个人先看 A 项目再切到 B，会拿到 A 的缓存结果。
  return `${account.accountId}:${session.sessionId}:${stateVersion}:${view || "full"}:${limit || "default"}:${projectId || "all"}`
    + `:${digestOf(runtimeFactsSignature()).slice(7, 23)}`;
}

function cachedStateView(state, account, session, view, limit, projectId) {
  const key = stateViewCacheKey(account, session, state.stateVersion, view, limit, projectId);
  const cached = stateViewCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const payload = JSON.stringify(stateViewForAccount(state, account, session, view, limit, projectId));
  // gzip 在【缓存填充】这一次做（每 (键, stateVersion) 只一次），发送路径零压缩 CPU。
  // 视图动辄上百 KB 且每次状态变更都要整下一份 —— 见 jsonView 的协商。
  const entry = {payload, gzip: gzipSync(payload), expiresAt: Date.now() + stateViewCacheTtlMs};
  stateViewCache.set(key, entry);
  if (stateViewCache.size > stateViewMaxEntries) {
    for (const cacheKey of stateViewCache.keys()) {
      stateViewCache.delete(cacheKey);
      if (stateViewCache.size <= stateViewMaxEntries) break;
    }
  }
  return entry;
}

// 视图条目的协商发送：客户端接受 gzip 且条目带压缩体就发压缩体。cache-control 基线 no-store，
// 带 ETag 的调用方用 extraHeaders 覆盖成 no-cache（与 jsonString 同规）；Vary 让缓存分开两种表示。
function jsonView(req, res, entry, extraHeaders) {
  const useGzip = /\bgzip\b/u.test(String(req.headers["accept-encoding"] || "")) && entry.gzip;
  res.writeHead(200, {"content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    vary: "accept-encoding", ...(useGzip ? {"content-encoding": "gzip"} : {}), ...(extraHeaders || {})});
  res.end(useGzip ? entry.gzip : entry.payload);
}

function sliceItems(items, limit) {
  if (!Array.isArray(items)) return [];
  if (items.length <= limit) return items;
  // 窗口必须留【最新的】那一批。各集合的追加方向并不统一：39 个 unshift（最新在前）、
  // 4 个 push（最新在后）、5 个两种都有 —— 而这里原先一律取前 N 条。
  // 对 push 的那些，被藏起来的恰恰是刚刚创建的记录：授权、账号、智能体、产出目标都很容易过 200
  //（视图上限），于是「我刚授的权/刚接的节点在名单里找不到」，而横幅只说了一句"条目更多"。
  // 不去改八处追加方向：projects[0] 是控制台可见的默认选择，roomMessages 必须保持正序。
  // 在窗口这一层按时间挑，且只在【真要截断时】才排一次；挑完保持原有相对顺序，
  // 对本来就是最新在前的那 39 个集合，结果与改动前逐字节相同。
  // 没有时间戳的记录一律记 0：V8 的排序是稳定的，于是它们退化成原先的「取前 N 条」。
  // 【不解析时间】：这些字段规范里都是 date-time（UTC、同格式、定长），
  // 字典序就是时间序。实测 5000 条时 Date.parse + 排序要 0.85ms/集合，而一次视图要过二十来个集合 ——
  // 相对「每请求 0.2ms」的基线是实打实的回归。改成比字符串后是 0.038ms（22 倍）。
  // 没有时间戳的记 ""，排在最后被先丢掉 —— 与改动前（Date.parse 得 0）行为一致。
  // 名字要认全：有六个集合根本没有 updatedAt/createdAt（准入决策用 decidedAt、准入扫描 sampledAt、
  // 关闭门与完成度 computedAt、审计台账 at、模型能力 observedAt）。认不出就一律记 ""，
  // 那时整份数组"看起来单调"，窗口退回按数组顺序取前 N 条 —— 对这几个集合恰好也对（它们都是
  // 最新在前），但那是碰巧，不是保证：哪天它们改成 push，窗口就会安静地只给最旧的。
  // 【纯 push 的集合必须带一个这里认得的时间字段】，这条写进了 PUSH_ORDERED_COLLECTIONS 的登记。
  const keyOf = (item) => item?.updatedAt || item?.createdAt || item?.issuedAt
    || item?.decidedAt || item?.computedAt || item?.sampledAt || item?.observedAt || item?.at || "";
  // 快路径：数组单调时不必排序。每个集合的追加方向是定死的（契约门守着「不许两种方向混用」），
  // 所以按项目取数时它一定单调；只有【跨分片合并】的全局取数才会不单调，那时才走排序。
  // 只留【降序】这一条快路径：41 个集合是最新在前，走的都是它，而且它有判据守着
  //（空转门里「按项目取数的窗口里也要留最新的那一批」，改成 slice(-limit) 当场红）。
  // 升序那一条也写过，又删了：这个夹具造不出「按项目取数且升序还超窗口」的情形，
  // 等于一段没有判据的分支；让它落到下面的排序里，正确，且只贵 0.06ms。
  let descending = true;
  let previous = keyOf(items[0]);
  for (let index = 1; index < items.length; index += 1) {
    const current = keyOf(items[index]);
    if (current > previous) { descending = false; break; }
    previous = current;
  }
  if (descending) return items.slice(0, limit);
  const newest = new Set([...items]
    .sort((left, right) => (keyOf(right) < keyOf(left) ? -1 : keyOf(right) > keyOf(left) ? 1 : 0))
    .slice(0, limit));
  return items.filter((item) => newest.has(item));
}

// 任务组运行时控制的闭集。守卫与审计的动作名都由它拼出，所以它必须是【服务端定死的】：
// 一旦允许请求体带任意后缀，权限映射（task_group_* → task_group:control）就成了万能钥匙，
// 审计日志也成了可写入的留言板。
const TASK_GROUP_CONTROL_ACTIONS = ["recompute_readiness", "pause", "resume", "request_review", "rebound_drift", "cancel", "abort"];

// 【一台节点可能同时服务多个项目】。吊销它、给它下控制命令，影响的是它服务的【全部】项目，
// 而这两条路原先只按 projectIds[0] 判权：在第一个项目上有权的人，能停掉一台同时给别人干活的
// 节点；反过来，只在第二个项目上有权的人被挡在门外，而那台节点正在他的项目里跑。
// 作用域取第一个是为了让审计/命令记录有一个确定的落点 —— 那没问题，问题是【判权也只判了它】。
// 这里在守卫之外把其余项目逐个补判：任一项目上没有 agent:activate 就整体拒绝。
function refuseIfNodeServesUnauthorizedProjects(req, state, node) {
  const account = accountFromRequest(req, state)?.account;
  if (!account) return {status: 401, payload: {error: "auth_required"}};
  if (isSystemAccount(account)) return null;
  const missing = nodeProjectsBeyondPermission(state, accountIdOf(account), node, hasPermission);
  if (!missing.length) return null;
  return {status: 403, payload: {error: "agent_node_serves_other_projects", nodeId: node.nodeId,
    nodeProjectIds: node.projectIds, missingOn: missing,
    message: "这台节点同时服务多个项目，停它会影响到你没有权限的那几个："
      + `${missing.join("、")}。请先在这些项目上取得「智能体管理」权限，或让各自的负责人各停各的`}};
}

function permissionForAction(action) {
  if (action === "bootstrap_init") return "system:bootstrap";
  if (action === "system_account_invite") return "system:account_admin";
  if (action === "account_invite") return "member:invite";
  // 注销与「邀请/停用成员」同属成员治理，权限也该同源：组织管理员管得了自己组织的人。
  // 不给映射的话会落到兜底的 system:*，变成只有系统管理员够得到 —— 而界面上不会有任何迹象，
  // 组织管理员只会看到按钮点下去回一句没权限。
  if (action === "account_retire") return "member:invite";
  if (action === "project_create") return "project:create";
  if (action === "project_member_grant") return "member:invite";
  if (action === "access_grant_create" || action === "access_grant_revoke") return "project:grant";
  if (action === "agent_create" || action === "agent_activation_update") return "agent:activate";
  if (action === "agent_join_token_create" || action === "agent_join_token_revoke" || action === "agent_node_revoke" || action === "agent_control_command_create") return "agent:activate";
  if (action.startsWith("task_group_")) return "task_group:control";
  if (action === "repository_output_target_select") return "project:*";
  if (action === "instruction_envelope_create") return "task_group:control";
  if (action === "shared_definition_contract_create") return "project:*";
  if (action === "skill_source_sync" || action === "skill_source_retire") return "system:skill_sync";
  if (action === "role_skill_overlay_create") return "project:*";
  if (action === "model_capability_register") return "system:model_registry";
  if (action === "model_selection_decide" || action === "session_placement_decide") return "task_group:orchestrate";
  if (action === "orchestrator_run" || action === "agent_runtime_worker_run") return "task_group:orchestrate";
  if (action === "checkpoint_submit") return "task_group:checkpoint_submit";
  if (action === "runtime_issue_collect") return "task_group:monitor";
  // Gap 2B: §4 REST endpoints over shared core mutators.
  if (["finding_submit", "finding_resolve", "approval_request_create", "approval_resolve", "review_plan_create", "review_bundle_register"].includes(action)) return "task_group:review";
  if (["work_assign", "lease_claim", "lease_release", "execution_topology_plan", "execution_topology_advance", "derived_task_classify"].includes(action)) return "task_group:orchestrate";
  if (["artifact_register", "permission_request_submit"].includes(action)) return "task_group:checkpoint_submit";
  if (["room_send", "rule_source_resolve"].includes(action)) return "task_group:control";
  if (action === "permission_resolve") return "project:grant";
  if (action === "contract_publish") return "project:*";
  if (action === "policy_decision_eval") return "system:*";
  if (action === "quality_gate_waive") return "task_group:review";
  // 收尾评审计划与豁免质量门同属评审裁决，此前漏了这条映射会落到兜底的 system:*，
  // 结果只有系统管理员能解掉一个任务组层面的阻塞 —— 与同批杠杆口径不一致。
  if (action === "review_plan_resolve") return "task_group:review";
  if (action === "rule_source_settle") return "task_group:control";
  // 死信处置（丢弃/重放重试超限的命令）是命令总线层的运维决定，与 rule_source_settle 同属任务组控制。
  if (action === "dlq_entry_resolve") return "task_group:control";
  if (action === "work_item_plan_finalization_set") return "task_group:review";
  if (action === "review_bundle_resolve") return "task_group:review";
  if (action === "system_upgrade_candidate_resolve") return "task_group:control";
  if (action === "shared_definition_resolve") return "project:update";
  if (action === "project_config_update") return "project:update";
  if (action === "project_archive") return "project:update";
  if (["org_create", "org_quota_update", "org_status_update"].includes(action)) return "system:*";
  if (["org_member_create", "org_member_permissions_update", "org_member_status_update", "org_member_invite_reissue"].includes(action)) return "org:member_admin";
  if (action === "org_project_create") return "org:project_admin";
  if (action === "human_confirmation_decide") return "task_group:review";
  if (action === "human_directive_create") return "task_group:control";
  return "system:*";
}

// Unmatchable sentinel org for a scope that names a resource which must already exist but does not resolve to
// any organization. Returning this (instead of null) makes the org-boundary gate DENY rather than skip, so a
// phantom taskGroupId cannot fail the gate open and let an org_admin's blanket task_group:* reach another tenant.
const UNRESOLVED_ORGANIZATION_SCOPE = "__unresolved_org_scope__";

function resourceScopeOrganizationId(state, resourceScope = {}) {
  if (resourceScope.resourceType === "organization") return resourceScope.resourceId;
  if (resourceScope.resourceType === "project") {
    const project = state.projects.find((item) => item.id === resourceScope.resourceId);
    // 这里【故意】不像下面 task_group 那支那样 fail closed：建项目这条路的作用域是
    // {project, "new"} —— 一个还不存在的项目。改成 UNRESOLVED_ORGANIZATION_SCOPE 之后
    // hasPermission 会认定「资源不属于你的组织」，非系统账号一律建不了项目（实测 e2e 当场红）。
    // 打错的项目 id 不会因此松掉组织边界：directPermissionApplies 对 project 作用域的
    // project:* 直接权限一律 return false，授权也绑着具体资源匹配不上，路由本身还会先 404。
    return project ? project.organizationId || DEFAULT_ORGANIZATION_ID : null;
  }
  if (resourceScope.resourceType === "task_group") {
    const taskGroup = state.taskGroups.find((item) => item.id === resourceScope.resourceId);
    if (taskGroup) {
      const project = state.projects.find((item) => item.id === taskGroup.projectId);
      return project ? project.organizationId || DEFAULT_ORGANIZATION_ID : null;
    }
    if (resourceScope.projectId) {
      const scopedProject = state.projects.find((item) => item.id === resourceScope.projectId);
      if (scopedProject) return scopedProject.organizationId || DEFAULT_ORGANIZATION_ID;
    }
    // Task-group scope naming a task group that does not exist and has no resolvable project: fail closed.
    return UNRESOLVED_ORGANIZATION_SCOPE;
  }
  return null;
}

function hasPermission(state, actor, requiredPermission, resourceScope) {
  if (!requiredPermission) return true;
  const account = state.accounts.find((item) => accountIdOf(item) === actor);
  if (!account || account.status !== "active") return false;
  if (!isSystemAccount(account)) {
    // 同上 fail closed：归属不明的账号按默认组织处理，而不是"不受任何组织约束"。
    // 组织被 suspended 时，全仓原先只有配额检查一处读 org.status —— 也就是说"暂停组织"的实际
    // 语义仅仅是"不许再新建项目/任务组/成员/agent"：成员照常登录、照常读写，名下的任务组与
    // agent 节点继续跑、继续烧模型额度。这与这个动作的名字和运维意图完全不符。
    // hasPermission 是所有写入的必经之路，在这里挡住即覆盖全部路径；读取不受影响，
    // 被暂停组织的人仍然看得到现状（否则连"为什么停了"都查不到）。
    const resourceOrg = resourceScopeOrganizationId(state, resourceScope);
    if (resourceOrg && resourceOrg !== (account.organizationId || DEFAULT_ORGANIZATION_ID)) return false;
    // 只需要这一条：上一行已经保证 resourceOrg 必等于 account.organizationId，所以"调用方所属组织
    // 被暂停"与"目标资源所属组织被暂停"是同一件事。我起初写了两条，实测发现单独去掉任一条都
    // 挡得住 —— 互为冗余的判据没法各自判别，也就没法保证它们各自还活着。
    const accountOrg = account.organizationId || DEFAULT_ORGANIZATION_ID;
    const scopedOrg = (state.organizations || []).find((item) => item.orgId === (resourceOrg || accountOrg));
    if (scopedOrg && scopedOrg.status === "suspended") return false;
  }
  const direct = (account.permissions || []).filter((permission) => directPermissionApplies(account, permission, requiredPermission, resourceScope));
  const grantPermissions = state.accessGrants
    .filter((grant) => grant.status === "active" && grant.subjectRef?.subjectType === "account" && grant.subjectRef?.subjectId === actor)
    .filter((grant) => grantAppliesToResource(state, grant, resourceScope))
    .flatMap((grant) => grant.permissions || []);
  return [...direct, ...grantPermissions].some((permission) => permissionMatches(permission, requiredPermission));
}

function directPermissionApplies(account, permission, requiredPermission, resourceScope = {}) {
  if (isSystemAccount(account)) return true;
  if (resourceScope.resourceType === "organization") {
    return account.organizationId === resourceScope.resourceId
      && (permission.startsWith("org:") || permission === "agent:activate");
  }
  // Organization admins manage every resource in their own organization; the org-boundary
  // gate in hasPermission has already confirmed the resource belongs to their organization.
  if (account.accountType === "org_admin" && ["project", "task_group"].includes(resourceScope.resourceType)) {
    return permission.startsWith("project:") || permission.startsWith("task_group:") || ["member:invite", "agent:activate"].includes(permission);
  }
  if (["member:invite", "agent:activate"].includes(permission) && ["project", "task_group"].includes(resourceScope.resourceType)) return false;
  // 原先这条只在 task_group 作用域下生效，于是一个 task_group: 权限被拿到【project 作用域】
  // 比对时会掉到最后的 return true —— 而那句与"是哪个项目"完全无关。结果：任何持直接
  // task_group:review 的账号，可以对组织内【任意】项目的评审计划动手（已由 HTTP 探针实测）。
  // task_group 级授权必须始终来自 grant（grant 绑定了具体资源），直接权限一律不算。
  if (permission.startsWith("task_group:")) return false;
  if (resourceScope.resourceType === "project" && permission.startsWith("project:") && requiredPermission !== "project:create") return false;
  // 【归属解析不出组织的作用域是系统级的】。system / system_console / state / git_repo 这几种
  // resourceType 在 resourceScopeOrganizationId 里一律返回 null —— 也就是上面那道组织边界什么
  // 都没挡；再掉到这里的 return true，结果是任何拿着 project:grant 的组织管理员都能对系统级
  // 对象动手。实测：一个普通组织的管理员撤掉了 grant_system_owner 那条 system:* 授权，HTTP 200。
  // 系统级作用域只认 system: 权限（系统账号在本函数开头已经放行，不受影响）。
  if (!["project", "task_group", "organization"].includes(resourceScope.resourceType)) {
    return permission.startsWith("system:");
  }
  return true;
}

function permissionMatches(granted, required) {
  if (granted === required || granted === "system:*") return true;
  if (granted.endsWith(":*") && !required.endsWith(":*")) return required.startsWith(granted.slice(0, -1));
  if (granted.endsWith(":*") && required.endsWith(":*")) return granted === required;
  return false;
}

function inferResourceScope(state, subject) {
  const [type, id] = String(subject || "").split(":");
  if (type === "Project") return {resourceType: "project", resourceId: id};
  if (type === "TaskGroup") {
    const taskGroup = state.taskGroups.find((item) => item.id === id);
    return {resourceType: "task_group", resourceId: id, projectId: taskGroup?.projectId};
  }
  if (type === "WorkItem" || type === "Checkpoint") {
    const parts = String(subject).split(":");
    const taskGroupId = parts[1] || id;
    const taskGroup = state.taskGroups.find((item) => item.id === taskGroupId);
    return {resourceType: "task_group", resourceId: taskGroupId, projectId: taskGroup?.projectId};
  }
  if (type === "AgentSkillSource" || type === "RuntimeBootstrapProfile" || type === "ModelCapabilityProfile") return {resourceType: "system", resourceId: type};
  return {resourceType: "system", resourceId: type || "system"};
}

function grantAppliesToResource(state, grant, resourceScope = {}) {
  const grantResource = grant.resource || {resourceType: grant.resourceType, resourceId: grant.resourceId};
  if (!grantResource?.resourceType) return false;
  // system 型 grant 此前对任何 system 作用域生效、resourceId 完全被忽略：一条 {system, accounts}
  // 的授权因此等价于整个系统的通行证。改为按 resourceId 精确匹配（"*" 仍表示全域，供受控路径使用）。
  if (grantResource.resourceType === "system") {
    return resourceScope.resourceType === "system"
      && (grantResource.resourceId === "*" || grantResource.resourceId === resourceScope.resourceId);
  }
  if (grantResource.resourceType === "project") {
    if (resourceScope.resourceType === "project") return grantResource.resourceId === resourceScope.resourceId;
    if (resourceScope.resourceType === "task_group") {
      // resourceScope.projectId 由所有构造点从任务组解析而来（恒＝该任务组的真实 project，或任务组不存在时
      // 为 undefined），所以它给了就直接用、不必再 state.taskGroups.find 一次 —— 否则 hasPermission 每次调
      // 都对每条 project 型 grant 做一次全表 find，而判权在【每个任务组】上都跑（作用域视图/关闭门），
      // 就是 O(任务组²) 的读路径热点（与 scopedForAccount 的 self-find 同量级）。给不出 projectId 才回退 find。
      const scopeProjectId = resourceScope.projectId !== undefined && resourceScope.projectId !== null
        ? resourceScope.projectId
        : state.taskGroups.find((item) => item.id === resourceScope.resourceId)?.projectId;
      return scopeProjectId === grantResource.resourceId;
    }
    return false;
  }
  if (grantResource.resourceType === "task_group") return resourceScope.resourceType === "task_group" && grantResource.resourceId === resourceScope.resourceId;
  return false;
}

function taskGroupScope(state, taskGroupId) {
  const taskGroup = state.taskGroups.find((item) => item.id === taskGroupId);
  return {resourceType: "task_group", resourceId: taskGroupId, projectId: taskGroup?.projectId};
}

// After an operator resolves a close-barrier blocker (permission/approval/finding), refresh the stored
// readiness + close barrier so the console reflects the unblock immediately (the "关闭任务组" button is
// gated on the stored barrier.satisfied). Best-effort — the resolve itself already succeeded.
function recomputeBarrierAfterResolve(state, taskGroupId) {
  if (!taskGroupId) return;
  try {
    computeCompletionReadiness(state, taskGroupId, {root: repositoryRoot});
    computeCloseBarrier(state, taskGroupId, {root: repositoryRoot, mutate: false});
  } catch { /* recompute is advisory; do not fail the resolve on a recompute error */ }
}

function projectScope(projectId) {
  return {resourceType: "project", resourceId: projectId};
}

function writeDriftCheck(state, action, resourceScope = {}) {
  if (resourceScope.resourceType !== "task_group") return {allowed: true};
  const activeGuards = (state.roleDriftGuards || []).filter((guard) => guard.taskGroupId === resourceScope.resourceId && !["closed", "corrected"].includes(guard.status));
  if (!activeGuards.length) {
    return driftGuardRequiredForAction(action)
      ? {allowed: false, signals: [`role_drift_guard_missing:${action}`]}
      : {allowed: true, signals: []};
  }
  return activeGuards.reduce((result, guard) => {
    if (!result.allowed) return result;
    const allowed = guard.allowedActionScopeRefs.includes(`TaskGroup:${resourceScope.resourceId}`);
    return {
      ...result,
      allowed,
      signals: allowed ? [] : [`write_scope_not_allowed:${action}`]
    };
  }, {allowed: true, signals: []});
}

function driftGuardRequiredForAction(action) {
  return [
    "agent_runtime_worker_run",
    "checkpoint_submit",
    "repository_output_target_select",
    "role_skill_overlay_create",
    "instruction_envelope_create"
  ].includes(action);
}

// 不走 guarded write 的那些路径（agent 网关、以及少数直接改状态的路由）自己把版本号推一格再落盘。
// 这里原先是【两个逐字相同的函数】：commitGatewayWrite 与 commitDirectStateWrite。
// 两个名字暗示有区别，实际没有 —— 而「同一件事两条路、只有一条被改到」是本仓反复出问题的形态
//（今天已经撞到三次：网关/分片两个上限、幂等两个旋钮、读取两条拼装路径）。合成一个。
function commitUnguardedWrite(state) {
  state.stateVersion = Number(state.stateVersion || 0) + 1;
  writeState(state);
}

function serveAgentAsset(req, res, pathname) {
  let content;
  let filename;
  if (pathname.startsWith("/install-agent.sh")) {
    content = readFileSync(agentInstallerPath, "utf8").replaceAll("__AIMAC_SERVER_URL__", publicEndpoint(req));
    filename = "install-agent.sh";
  } else {
    content = readFileSync(agentRuntimePath);
    filename = "agent-runtime.mjs";
  }
  if (pathname.endsWith(".sha256")) {
    const hash = createHash("sha256").update(content).digest("hex");
    res.writeHead(200, {"content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff"});
    res.end(`${hash}  ${filename}\n`);
    return;
  }
  res.writeHead(200, {
    "content-type": filename.endsWith(".sh") ? "text/x-shellscript; charset=utf-8" : "application/javascript; charset=utf-8",
    "cache-control": "no-store",
    "content-disposition": `inline; filename=${filename}`,
    "x-content-type-options": "nosniff"
  });
  res.end(content);
}

async function handleMcp(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, {allow: "POST", "content-type": "application/json; charset=utf-8"});
    res.end(JSON.stringify({error: "mcp_streamable_http_requires_post",
      message: "这是 MCP 端点（streamable HTTP，只收 POST 的 JSON-RPC）—— 用 MCP 客户端连它；控制台在站点根路径 /"}));
    return;
  }
  const state = readState();
  const context = mcpContextFromRequest(req, state);
  if (!context) {
    // 「没带令牌」与「带了个错的」是两回事：前者要告诉它带什么、去哪拿；后者要告诉它这把不对或已失效。原先都是一句裸码。
    const presented = Boolean(String(req.headers.authorization || "").trim());
    res.writeHead(401, {"www-authenticate": "Bearer", "content-type": "application/json; charset=utf-8", "cache-control": "no-store"});
    res.end(JSON.stringify(presented
      ? {error: "mcp_token_invalid", message: "Authorization 里的令牌不对或已失效 —— 服务令牌以 AIMAC_MCP_SERVICE_TOKEN 配置在控制面；节点令牌由 agentctl bootstrap 写在 agent-config.json；账号会话令牌来自登录接口，会话撤销后要重新登录"}
      : {error: "mcp_auth_required", message: "这个 MCP 端点要带 Authorization: Bearer <令牌> —— 服务令牌（AIMAC_MCP_SERVICE_TOKEN）、节点令牌（agentctl bootstrap 签发）或账号会话令牌（登录接口）三种之一"}));
    return;
  }
  const message = await parseBody(req);
  const response = Array.isArray(message)
    ? await handleMcpBatch(message, context)
    : await handleMcpJsonRpc(message, context);
  if (response === null || (Array.isArray(response) && !response.length)) {
    res.writeHead(202, {"cache-control": "no-store"});
    res.end();
    return;
  }
  res.writeHead(200, {"content-type": "application/json; charset=utf-8", "cache-control": "no-store", "mcp-protocol-version": "2025-06-18"});
  res.end(JSON.stringify(response));
}

async function handleMcpBatch(messages, context) {
  const writeCount = messages.filter(mcpJsonRpcIsWriteCall).length;
  if (writeCount === 0) return (await Promise.all(messages.map((item) => handleMcpJsonRpc(item, context)))).filter(Boolean);
  const responses = [];
  for (const item of messages) {
    if (writeCount > 1 && mcpJsonRpcIsWriteCall(item)) {
      responses.push({
        jsonrpc: "2.0",
        id: item?.id ?? null,
        error: {code: -32600, message: "mcp_batch_multiple_write_calls_forbidden"}
      });
      continue;
    }
    const response = await handleMcpJsonRpc(item, context);
    if (response) responses.push(response);
  }
  return responses;
}

function mcpJsonRpcIsWriteCall(message) {
  return message?.method === "tools/call" && isWriteTool(message.params?.name);
}

async function waitForAgentControlCommands(node, options = {}) {
  return sharedLongPoll(agentControlWaitFanout, `agent-control:${node.nodeId}:${options.afterSequence || 0}:${options.limit || 20}:${options.waitMs || 0}`, () => waitForAgentControlCommandsDirect(node, options));
}

async function waitForAgentControlCommandsDirect(node, options = {}) {
  const deadline = Date.now() + Math.max(0, Math.min(30000, Number(options.waitMs || 0)));
  let latest = readState();
  for (;;) {
    const currentNode = authenticateAgentNode(latest, options.token);
    if (!currentNode || currentNode.nodeId !== node.nodeId) return {commands: [], nextCursor: Number(options.afterSequence || 0), reason: "node_not_active"};
    const result = listAgentControlCommands(latest, currentNode, options);
    if (result.deliveredCount) {
      try {
        commitUnguardedWrite(latest);
      } catch (error) {
        if (!isStateStoreConflict(error)) throw error;
      }
    }
    if (result.commands.length || Date.now() >= deadline) return result;
    await waitForLongPollSignal([`agent-control:${node.nodeId}`], Math.max(1, deadline - Date.now()));
    latest = readState();
  }
}

async function waitForProjectExecutionEvents(projectId, options = {}) {
  return sharedLongPoll(projectExecutionWaitFanout, `project-events:${projectId}:${options.afterSequence || 0}:${options.dispatchId || ""}:${options.taskGroupId || ""}:${options.sessionId || ""}:${options.limit || 120}:${options.waitMs || 0}`, () => waitForProjectExecutionEventsDirect(projectId, options));
}

async function waitForProjectExecutionEventsDirect(projectId, options = {}) {
  const deadline = Date.now() + Math.max(0, Math.min(30000, Number(options.waitMs || 0)));
  for (;;) {
    const result = readProjectExecutionEvents(runtimeDir, projectId, options);
    if (result.events.length || Date.now() >= deadline) return result;
    await waitForLongPollSignal([`project-events:${projectId}`], Math.max(1, deadline - Date.now()));
  }
}

async function sharedLongPoll(cache, key, producer) {
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = (async () => producer())();
  cache.set(key, pending);
  try {
    return await pending;
  } finally {
    if (cache.get(key) === pending) cache.delete(key);
  }
}

function waitForLongPollSignal(keys, timeoutMs) {
  return new Promise((resolveSignal) => {
    let settled = false;
    const cleanup = () => {
      for (const key of keys) {
        const waiters = longPollWaiters.get(key);
        if (!waiters) continue;
        waiters.delete(resolveOnce);
        if (!waiters.size) longPollWaiters.delete(key);
      }
      clearTimeout(timer);
    };
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveSignal();
    };
    const timer = setTimeout(resolveOnce, Math.max(1, timeoutMs));
    for (const key of keys) {
      if (!longPollWaiters.has(key)) longPollWaiters.set(key, new Set());
      longPollWaiters.get(key).add(resolveOnce);
    }
  });
}

function notifyLongPollWaiters(key) {
  pushRealtime(key);
  const waiters = longPollWaiters.get(key);
  if (!waiters?.size) return;
  longPollWaiters.delete(key);
  for (const resolveWaiter of waiters) resolveWaiter();
}

// Push a lightweight wake frame to every WS client subscribed to this channel. Signal only —
// no data — so the delivery path carries no tenant-visible content; subscribing to a channel is
// authorized at subscribe time and the client re-fetches scoped data itself.
function pushRealtime(key) {
  if (!realtimeClients.size) return;
  const frame = JSON.stringify({event: "wake", channel: key, at: new Date().toISOString()});
  for (const client of realtimeClients) {
    if (client.readyState === client.OPEN && client.subscriptions?.has(key)) {
      try {
        client.send(frame);
      } catch {
        realtimeClients.delete(client);
      }
    }
  }
}

function retryExecutionEventProjection(req, body) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = readState();
    const latestNode = authenticateAgentNode(latest, bearerToken(req));
    if (!latestNode) return {ok: false, error: "agent_node_auth_required"};
    try {
      const dispatch = (latest.agentDispatches || []).find((item) => item.dispatchId === body.dispatchId);
      if (!dispatch) return {ok: false, error: "dispatch_not_found"};
      const storedEvent = body.eventKey
        ? readProjectExecutionEventByKey(runtimeDir, dispatch.projectId, body.eventKey, {dispatchId: dispatch.dispatchId})
        : null;
      if (storedEvent && storedEvent.nodeId !== latestNode.nodeId) return {ok: false, error: "event_node_binding_mismatch"};
      const prepared = storedEvent ? null : prepareAgentExecutionEvent(latest, latestNode, body);
      const storage = storedEvent
        ? {...projectExecutionEventStorageInfo(dispatch.projectId), replayedProjection: true, duplicate: true, event: storedEvent}
        : appendProjectExecutionEvent(runtimeDir, prepared.event);
      if (storage.event && !storage.duplicate) notifyLongPollWaiters(`project-events:${storage.event.projectId}`);
      const result = recordAgentExecutionEvent(latest, latestNode, storage.event || storedEvent || prepared.event, {allowHistoricalNodeBinding: Boolean(storedEvent || storage.duplicate)});
      commitUnguardedWrite(latest);
      return {ok: true, result, storage};
    } catch (error) {
      if (!isStateStoreConflict(error)) return {ok: false, error: error.message};
    }
  }
  return {ok: false, error: "state_conflict_not_recovered"};
}

// 「人把它叫停了」的几种落地理由。resume 认这几种，/fail 也据此拒绝 agent 覆盖 ——
// 两处必须同源，否则加了一种新的暂停理由时，只有一边跟上（本仓最常见的漂移形态）。
const HUMAN_CONTROL_BLOCK_REASONS = ["control_pause_requested", "task_group_pause", "task_group_rebound_drift"];

function applyTaskGroupRuntimeControl(state, taskGroup, action, options = {}) {
  const at = now();
  const controlCommands = [];
  const directDispatches = [];
  const resumedDispatches = [];
  const stopCommandType = ["cancel", "abort"].includes(action)
    ? "cancel_dispatch"
    : ["pause", "rebound_drift"].includes(action)
      ? "pause_dispatch"
      : null;
  if (stopCommandType) {
    for (const dispatch of state.agentDispatches || []) {
      if (dispatch.taskGroupId !== taskGroup.id || isTerminalDispatchStatus(dispatch.status)) continue;
      const node = dispatch.assignedNodeId ? (state.agentRuntimeNodes || []).find((item) => item.nodeId === dispatch.assignedNodeId) : null;
      if (node && ["running", "blocked"].includes(dispatch.status)) {
        const result = createAgentControlCommand(state, node, {
          commandType: stopCommandType,
          dispatchId: dispatch.dispatchId,
          taskGroupId: taskGroup.id,
          payload: {reason: `task_group_${action}`}
        }, {
          actor: options.actor || "ui-console-service",
          idempotencyKey: `${options.idempotencyKey || "task-group-control"}:${dispatch.dispatchId}`
        });
        controlCommands.push(result.command);
        continue;
      }
      applyDirectDispatchControl(state, dispatch, stopCommandType, `task_group_${action}`, at);
      directDispatches.push(dispatch.dispatchId);
    }
  }
  if (action === "resume") {
    for (const dispatch of state.agentDispatches || []) {
      if (dispatch.taskGroupId !== taskGroup.id || dispatch.status !== "blocked") continue;
      if (!HUMAN_CONTROL_BLOCK_REASONS.includes(dispatch.blockedReason)) continue;
      dispatch.status = "queued";
      delete dispatch.blockedReason;
      delete dispatch.controlCommandRef;
      delete dispatch.assignedNodeId;
      delete dispatch.claimedAt;
      delete dispatch.claimExpiresAt;
      dispatch.updatedAt = at;
      const session = state.workSessions.find((item) => item.sessionId === dispatch.sessionId);
      if (session && ["needs_decision", "waiting_dependency", "stale_state"].includes(session.status)) {
        session.status = "active";
        session.updatedAt = at;
      }
      resumedDispatches.push(dispatch.dispatchId);
    }
  }
  return {
    controlCommands,
    directDispatches,
    resumedDispatches
  };
}

function applyDirectDispatchControl(state, dispatch, commandType, reason, at) {
  if (dispatch.blockedReason === "awaiting_human_confirmation") cancelPendingConfirmationsForDispatch(state, dispatch.dispatchId, reason);
  if (commandType === "cancel_dispatch") {
    dispatch.status = "cancelled";
    dispatch.failureReason = reason;
    // 取消要连它名下的资源一起了结：输出目标、租约、制品、角色漂移守卫。
    // 不了结的话，输出目标永远停在非终态，关闭门恒把它列为阻塞物 —— 任务组从此关不掉，
    // 而人没有任何杠杆（lane 与守卫有自清逻辑，目标没有）。暂停不能走这条：它是可恢复的。
    settleCellOwnedResources(state, dispatch.taskGroupId, dispatch.workItemId, reason);
  } else {
    dispatch.status = "blocked";
    dispatch.blockedReason = reason;
  }
  dispatch.controlRequestedAt = at;
  dispatch.updatedAt = at;
  if (dispatch.assignedNodeId) revokeDispatchMcpGrants(state, dispatch.assignedNodeId, dispatch.dispatchId, reason);
  const session = state.workSessions.find((item) => item.sessionId === dispatch.sessionId);
  if (session) {
    session.status = commandType === "cancel_dispatch" ? "aborted" : "needs_decision";
    session.blockedReason = commandType === "cancel_dispatch" ? session.blockedReason : reason;
    session.updatedAt = at;
  }
  const taskGroup = state.taskGroups.find((item) => item.id === dispatch.taskGroupId);
  const workItem = taskGroup?.workItems?.find((item) => item.id === dispatch.workItemId);
  if (workItem) {
    workItem.status = "needs_decision";
    workItem.blockedReason = reason;
    workItem.updatedAt = at;
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function prepareRemoteGitVerification(target, checkpointInput) {
  // Fail-closed on untrusted git input: a repository output target is tenant-controlled, so an
  // unvalidated repositoryUrl reaching `git fetch` on the shared control-plane host is remote code
  // execution (ext::/fd: transports) or SSRF. Mirror the agent-runtime hardening: validate the URL,
  // restrict transports via GIT_ALLOW_PROTOCOL, disable prompts, constrain branch/commit and use a
  // `--` end-of-options separator so no value can be parsed as a git option.
  if (!isSafeGitRemoteUrl(target.repositoryUrl)) {
    const error = new Error("repository_output_target_unsafe_repository_url");
    error.status = 400;
    throw error;
  }
  // ext::/fd:/remote-helper transports (RCE) are always rejected above. file://+local paths are
  // permitted by default (local deployments and the doctor use them and they cannot execute
  // commands), but a hosted multi-tenant deployment can forbid them — they would let a tenant-set
  // repositoryUrl make the shared host git-fetch arbitrary local repos — by setting
  // AIMAC_ALLOW_LOCAL_GIT_REMOTE=false.
  if (process.env.AIMAC_ALLOW_LOCAL_GIT_REMOTE === "false") {
    const url = String(target.repositoryUrl || "");
    if (/^file:\/\//iu.test(url) || url.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(url) || url.startsWith("./") || url.startsWith("../")) {
      const error = new Error("repository_output_target_local_git_remote_disabled");
      error.status = 400;
      throw error;
    }
  }
  const branch = String(target.branch || "main");
  if (!isSafeGitRef(branch)) {
    const error = new Error("repository_output_target_unsafe_branch");
    error.status = 400;
    throw error;
  }
  const remote = target.remote || "origin";
  if (!/^[A-Za-z0-9._-]+$/u.test(remote) || remote.startsWith("-")) {
    const error = new Error("repository_output_target_unsafe_remote");
    error.status = 400;
    throw error;
  }
  const gitEnv = {...process.env, GIT_ALLOW_PROTOCOL: "file:https:ssh:git", GIT_TERMINAL_PROMPT: "0"};
  // 命中网络的 fetch（下面对远端拉分支/提交）必须有墙钟超时：execFileAsync 默认无超时，挂死的远端会让
  // 这次检查点验证请求永远悬挂、git 子进程堆积。到点 execFileAsync 会杀进程并 reject，请求干净失败。
  const git = (args) => execFileAsync("git", args, {timeout: clampEnvNumber(process.env.AIMAC_GIT_COMMAND_TIMEOUT_MS, 60000, 600000), env: gitEnv});
  const safeTargetId = String(target.targetId).replace(/[^A-Za-z0-9._-]+/gu, "_");
  const verificationRoot = join(runtimeDir, "git-verification", `${safeTargetId}.git`);
  mkdirSync(dirname(verificationRoot), {recursive: true});
  if (!existsSync(join(verificationRoot, "HEAD"))) await git(["init", "--bare", verificationRoot]);
  const remotes = (await git(["-C", verificationRoot, "remote"])).stdout.trim().split("\n").filter(Boolean);
  if (remotes.includes(remote)) await git(["-C", verificationRoot, "remote", "set-url", remote, "--", target.repositoryUrl]);
  else await git(["-C", verificationRoot, "remote", "add", remote, "--", target.repositoryUrl]);
  await git(["-C", verificationRoot, "fetch", "--force", "--no-tags", remote, "--", `refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
  for (const commitRef of checkpointInput.commitRefs || []) {
    const commit = String(commitRef.commit || "");
    // Only accept hex commit ids; anything else could be a git option or a crafted ref.
    if (!/^[0-9a-fA-F]{7,64}$/u.test(commit)) continue;
    try {
      await git(["-C", verificationRoot, "cat-file", "-e", `${commit}^{commit}`]);
    } catch {
      await git(["-C", verificationRoot, "fetch", "--force", "--no-tags", remote, "--", commit]);
    }
  }
  return verificationRoot;
}

const serveStatic = createStaticAssetHandler(publicDir);

const execFileAsync = promisify(execFile);

const routeTraceFile = process.env.AIMAC_ROUTE_TRACE || null;

async function handleApi(req, res) {
  const url = new URL(req.url, "http://request.local");
  // 路由记账（默认关闭，只在门里打开）：「这条路由有没有被真打过」不能靠在 e2e 源码里搜路径 ——
  // 搜到的是"提到过"，不是"跑到过"。开关关着时这一行只是一次环境变量读取。
  if (routeTraceFile) {
    // 记在【响应结束时】而不是请求开始时：要的是状态码。「这条路由被打过」和「它成功过」
    // 是两件事 —— 空 body 扫描会把每条写路由都打一遍（并期待被拒），只记「打过」的话，
    // 一条从没成功执行过的路由看起来是覆盖的（实测 /api/role-skill-overlays 就是这样）。
    // 第四列是耗时（毫秒，追加在末尾：读账的门只按位置取前三列，多一列不打坏它）——
    // 「哪条路由慢」此前只能靠单独起服务端手工压，现在跑完一轮 e2e 顺手就能排出来。
    const startedAt = process.hrtime.bigint();
    res.once("finish", () => {
      const elapsedMs = (Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(1);
      try { appendFileSync(routeTraceFile, `${req.method} ${url.pathname} ${res.statusCode} ${elapsedMs}\n`); } catch { /* 记账坏了不能影响请求 */ }
    });
  }
  if (req.method === "GET" && ["/api/health", "/api/runtime/health"].includes(url.pathname)) {
    // 存储坏过一次就不能再报 ok：分片损坏时服务照常起、这里照常 200，监控绿着而读数据全 503。
    // healthy 的定义得包含"状态读得出来"。
    // 运行目录被清掉（有人清 /tmp、挂载掉了）时，存储层会【静默重建一份空状态】：登录全失败、
    // 数据全没了，而这里照样 200。只查"文件在不在"没用 —— 请求管线里的 ensureState 已经把它
    // 重建出来了。按 inode 认：重建出来的是另一个文件，认得出来。
    if (!lastStorageFault && stateStoreKind() === "runtime_json" && runtimeDirIdentity) {
      let nowIdentity = null;
      try { const stat = statSync(runtimeDir); nowIdentity = `${stat.dev}:${stat.ino}`; } catch { nowIdentity = null; }
      if (nowIdentity !== runtimeDirIdentity) {
        lastStorageFault = {kind: nowIdentity ? "runtime_dir_replaced" : "runtime_dir_missing",
          file: basename(statePath), at: now()};
      }
    }
    if (lastStorageFault) {
      // 故障标记不能只置不清 —— 我第一版就是这样，而提示里还写着"恢复后自动转回 ok"，
      // 那句话是假的：修好了它也一直报 degraded。这里当场复核一次。
      // 但【目录被换 / 目录不见了 / 状态被重建成空的】这三种不复核：进程已经接在另一份数据上了，
      // 把数据还原回去也救不了这个已经跑歪的进程，必须重启 —— 所以对它们如实说"要重启"。
      const needsRestart = ["runtime_dir_replaced", "runtime_dir_missing", "state_rebuilt_from_seed"]
        .includes(lastStorageFault.kind);
      let recovered = false;
      if (!needsRestart) {
        // 复核要问的是"这个故障还在不在"，而不是统一问"读得出来吗"：
        // 磁盘写不进去（EACCES/ENOSPC/只读挂载）时状态照样读得出来 —— 用读去复核，
        // 故障会被当场清掉，健康页回到 ok，而每一次写仍然在 503（实测 chmod 500 就是这样）。
        if (lastStorageFault.kind === "state_storage_unavailable") {
          try { accessSync(dirname(statePath), fsConstants.W_OK); recovered = true; } catch { recovered = false; }
        } else {
          try { readHealthState(); recovered = true; } catch { recovered = false; }
        }
      }
      if (recovered) {
        lastStorageFault = null;
      } else {
        json(res, 503, {status: "degraded", storageFault: lastStorageFault,
          // 三种故障要说三种话：读不出来 / 写不进去 / 数据被换过。
          // 原先"写不进去"也套用"状态读不出来"那一句 —— 运维会去查文件损坏，而实际是磁盘满了或挂载只读。
          hint: needsRestart
            ? "状态已经不是本进程启动时那一份了：先把数据恢复回去，然后【重启本进程】——"
              + "当前进程还接着那份被换掉的状态，不重启光恢复数据没用"
            : lastStorageFault.kind === "state_storage_unavailable"
              ? STORAGE_UNAVAILABLE_HINT
              : "状态读不出来：按 file/code 指出的线索恢复（文件损坏就还原那一份，数据库掉线就把它接回来），恢复之后本接口会自动转回 ok"});
        return;
      }
    }
    let state;
    try { state = readHealthState(); }
    catch (error) {
      // 兜底：读不出状态就是 degraded，不管是哪种原因。只认几种已知形态的话，
      // 生产上 PostgreSQL 中途掉线、文件权限被改这类照样会让健康检查报 ok，
      // 而那正是最需要它说实话的时刻。原因归类只用于把话说清楚，不作为"算不算故障"的判据。
      const hit = storageFaultCodePattern.exec(String(error?.message || ""));
      lastStorageFault = hit
        ? {kind: hit[1], file: hit[2], at: now()}
        : {kind: "state_unreadable", code: error?.code || null, at: now()};
      console.error(`[state-store] health: ${error?.code || ""} ${String(error?.message || error).slice(0, 200)}`);
      json(res, 503, {status: "degraded", storageFault: lastStorageFault,
        hint: "状态读不出来：按 file/code 指出的线索恢复（文件损坏就还原那一份，数据库掉线就把它接回来），恢复之后本接口会自动转回 ok"});
      return;
    }
    // 状态在【跑着的时候】被按种子重建过：首次部署时这是正常的，之后发生就意味着数据没了，
    // 而系统会带着一份空状态继续服务 —— 登录全失败，这里却照样 ok。启动之后的重建一律算故障。
    // 必须放在 readHealthState【之后】：重建正是它内部触发的，放前面读到的永远是上一拍的信号。
    const rebuiltAt = consumeStateRebuildSignal();
    if (rebuiltAt && rebuiltAt > serverStartedAt) {
      lastStorageFault = {kind: "state_rebuilt_from_seed", file: basename(statePath), at: rebuiltAt};
      json(res, 503, {status: "degraded", storageFault: lastStorageFault,
        hint: "状态在运行中被重建成了空的（原文件消失）：先确认运行目录没被清、挂载还在，再从备份还原"});
      return;
    }
    // 【已经知道的故障不能只讲给控制台听】。审计归档写不进去（磁盘满 / 权限变了）与
    // 执行事件日志损坏，服务端本来就记着，控制台也会弹提示 —— 但那条提示只有系统账号看得见，
    // 而盯着这个接口的是监控。原先这两种情况这里照样回 200 ok：问责记录正在丢，监控一片绿。
    // 不报 503：这两样都不影响对外服务，而 503 会让编排把容器摘掉甚至重启 ——
    // 重启既修不好满了的磁盘，还会把正在跑的东西一起打断。所以照常 ok，但把警告一起端出来。
    const auditFault = sharedAuditArchiveFault();
    const eventFault = projectEventLogFault();
    // MCP 那本归档是 agent 调用记录的【唯一】完整来源（状态里只留最近 300 条）。
    const mcpFault = mcpAuditFault();
    // 技能源同步不上（stale）或被隔离（quarantined）：agent 从此一直用上一次同步下来的技能，
    // 而这件事此前只在控制台的技能源面板上看得见 —— 盯着这个接口的监控一片绿。
    // 与上面同规：不报 503（对外服务照常），把它端出来。状态就在 readHealthState 那份壳里，不另读。
    const skillSourceFaults = (state.skillSources || [])
      .filter((source) => source.status === "stale" || source.status === "quarantined")
      .map((source) => ({sourceId: source.sourceId, status: source.status,
        lastSyncError: String(source.lastSyncError || "").slice(0, 200), lastSyncFailedAt: source.lastSyncFailedAt || null}));
    // 在线节点数按【心跳没过期】数，不按 status 数：status 只在扫描跑过之后才翻成 offline。
    const nodeHealth = agentNodeHealthSummary(state);
    const warnings = [
      ...(nodeHealth.overdueNodes.length ? [{kind: "agent_node_heartbeat_overdue", nodes: nodeHealth.overdueNodes,
        hint: "这些节点的心跳已经超过阈值、只是还没被扫描标成 offline：它们名下的活不会推进。先看节点机器是不是还活着，再决定重启节点或撤销它"}] : []),
      ...(skillSourceFaults.length ? [{kind: "skill_source_stale", sources: skillSourceFaults,
        hint: "技能源同步不上：agent 用的还是上一次同步下来的技能。按 lastSyncError 排查（地址 / 认证 / 分支 / 网络），修好后在「AI 智能体」页点「同步」，或等自治周期重试"}] : []),
      ...(mcpFault ? [{kind: "mcp_audit_write_failed", lostEntries: mcpFault.lostEntries,
        error: mcpFault.error, at: mcpFault.at,
        hint: mcpFault.kind === "lock_timeout"
          ? "MCP 调用归档的锁被另一个活着的进程持着超过 10 秒（多半是多个控制面进程共用了同一个运行目录）："
            + "这段时间 agent 的调用记录丢了，且每次写工具都会白等 10 秒并冻住整个控制面；"
            + "确认只有一个控制面进程在写这个目录"
          : "MCP 调用归档写不进去了，这段时间 agent 做过什么事后查不到：检查运行目录剩余空间、"
            + "挂载是否只读、以及本进程对 mcp-audit.jsonl 的写权限；恢复之后下一次调用会自动转回正常"}] : []),
      ...(auditFault ? [{kind: "audit_archive_write_failed", lostEntries: auditFault.lostEntries,
        error: auditFault.error, at: auditFault.at,
        hint: "问责台账的归档写不进去了，这段时间的操作事后查不到：检查运行目录剩余空间、"
          + "挂载是否只读、以及本进程对 audit-log.jsonl 的写权限；恢复之后下一次写入会自动转回正常"}] : []),
      ...(eventFault ? [{kind: "project_event_log_damaged", error: String(eventFault).slice(0, 200),
        hint: "执行事件日志有损坏行：重建索引时会跳过它，后果是序号可能被重用、幂等键可能失效 ——"
          + " 按日志里指出的段文件排查"}] : [])
    ];
    json(res, 200, {
      status: "ok",
      ...(warnings.length ? {warnings} : {}),
      runtime: state.runtime.status,
      publicUrl: publicEndpoint(req),
      mcp: {transport: "streamable-http", endpoint: `${publicEndpoint(req)}/mcp`, hostedBy: "control-plane"},
      agentGateway: {endpoint: `${publicEndpoint(req)}/api/agent/v1`, onlineNodes: nodeHealth.onlineNodes, overdueNodes: nodeHealth.overdueNodes.length},
      at: now()
    });
    return;
  }

  // 控制台是轮询的，GET /api/state 是全仓最频繁的请求。它此前一律先把整份状态水合并深拷贝一遍
  // （2000 单元实测 180ms、4000 单元 351ms），然后才去查视图缓存 —— 命中时那份拷贝全白付。
  // 视图缓存的键里只有账号、会话、stateVersion、视角与上限，而这几样【中央状态里就有】
  // （分片里装的是任务组/派发那些集合，账号与会话不在其中），只读中央状态实测 19ms。
  // 未命中则原样落回下面的正常路径，语义完全不变。
  if (req.method === "GET" && url.pathname === "/api/state") {
    // 这一段【只读】：认出是谁、算 ETag、命中就回 304 或直接发缓存里的那份载荷。
    // 所以拿缓存里那份共用对象，不为它克隆整份状态 —— 实测 2MB 时一次克隆 4.84ms，
    // 而轮询的常态恰恰是"内容没变、回 304"，那 4.84ms 全是白付的。
    // 判据 verifyPollingPeekDoesNotCloneOrMutate 钉住这条路走完之后那份对象一字未变。
    const central = readStoredCentralState({root, runtimeDir, statePath, seedPath, buildInitialState},
      {shared: true});
    const peeker = central && accountFromRequest(req, central);
    if (peeker) {
      const view = url.searchParams.get("view") || "full";
      const limit = Number(url.searchParams.get("limit") || 80);
      const peekProjectId = url.searchParams.get("projectId") || null;
      const peekKey = stateViewCacheKey(peeker.account, peeker.session, central.stateVersion, view, limit, peekProjectId);
      // 控制台每 5 秒轮询一次当前页视图（WebSocket 的兜底）。内容没变时，最省的做法不是
      // "更快地把它发一遍"，而是【根本不发】：ETag 对上就回 304，一个字节的载荷都不用付。
      // 签名里除了 stateVersion，还要带上不写盘的运行时事实（自治循环健康度、归档故障）——
      // 它们会变而 stateVersion 不变，只按版本号做 ETag 会让那条停摆告警迟迟不出现。
      // ETag 按【表示】区分（gzip 加 -gz，与静态资源同规）：强 ETag 标识的是这一份字节。
      // 客户端换 accept-encoding 后第一次会拿 200（新表示+新 ETag），之后照常 304。
      const wantsGzipView = /\bgzip\b/u.test(String(req.headers["accept-encoding"] || ""));
      const etag = stateViewEtag(peekKey, central).replace(/"$/u, wantsGzipView ? '-gz"' : '"');
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, {etag, "cache-control": "no-cache", vary: "accept-encoding"});
        res.end();
        return;
      }
      const peeked = stateViewCache.get(peekKey);
      if (peeked && peeked.expiresAt > Date.now()) {
        jsonView(req, res, peeked, {etag, "cache-control": "no-cache"});
        return;
      }
      req.stateViewEtag = etag;
    }
  }

  // GET 不改状态，走共用只读那份（省掉每请求 7.98ms 的深拷）。其余方法仍拿自己的可变副本：
  // 写入方要先改再落盘，共享一份会让两个并发请求互相看见对方改到一半的状态。
  //
  // 【agent 网关那一族整族排除】。它有好几条 GET 是【设计上就会写】的：取控制命令要把 queued
  // 标成 delivered、confirmations 带 ?consume=true 要销单、内容包下发要记投递 —— 而这些写发生在
  // 被调用的 helper 里，处理函数体上看不出来（试过按"处理函数体里有没有写"静态分类，
  // control 与内容包都被判成了纯读，跑起来才发现是错的）。
  // 逐条列白名单就是拿【没被 e2e 覆盖的那几条网关 GET】去赌：漏判一条，生产上那条路直接 500。
  // 而网关最热的那条（长轮询取控制命令）本来就要写，收窄排除面买到的时间很少、风险却是实的。
  // 控制台与运维那批 GET 才是轮询主力，它们已经在共用只读里。
  const sharedReadEligible = req.method === "GET" && !url.pathname.startsWith("/api/agent/v1/");
  const state = sharedReadEligible ? readStateForRead() : readState();
  const body = req.method === "POST" ? await parseBody(req) : {};
  req.bodyDigest = digestOf(body);

  if (req.method === "GET" && url.pathname === "/api/agent/v1/bootstrap-manifest") {
    json(res, 200, {
      schemaVersion: "agent-bootstrap-manifest/v1",
      serverUrl: publicEndpoint(req),
      installScriptUrl: `${publicEndpoint(req)}/install-agent.sh`,
      installScriptChecksumUrl: `${publicEndpoint(req)}/install-agent.sh.sha256`,
      runtimeUrl: `${publicEndpoint(req)}/agent-runtime.mjs`,
      runtimeChecksumUrl: `${publicEndpoint(req)}/agent-runtime.mjs.sha256`,
      mcpUrl: `${publicEndpoint(req)}/mcp`,
      localMcpServerAllowed: false,
      skillSynchronization: "server_managed_on_demand"
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/v1/register") {
    const result = registerAgentNode(state, body, {joinToken: bearerToken(req), publicUrl: publicEndpoint(req), idempotencyKey: req.headers["idempotency-key"]});
    audit(state, "agent-gateway", "agent_node_register", `AgentRuntimeNode:${result.node.nodeId}`);
    commitUnguardedWrite(state);
    json(res, 201, result);
    return;
  }

  const node = url.pathname.startsWith("/api/agent/v1/") ? authenticateAgentNode(state, bearerToken(req)) : null;

  if (req.method === "GET" && url.pathname === "/api/agent/v1/nodes/me") {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    json(res, 200, {node: publicAgentNode(node)});
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/v1/heartbeat") {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    const result = heartbeatAgentNode(state, node, body, {presentedToken: bearerToken(req)});
    if (result.persistRequired !== false) commitUnguardedWrite(state);
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/v1/self-check") {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    const result = selfCheckAgentNode(state, node, body);
    commitUnguardedWrite(state);
    json(res, result.ok ? 200 : 409, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent/v1/control") {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    const result = await waitForAgentControlCommands(node, {
      token: bearerToken(req),
      afterSequence: Number(url.searchParams.get("afterSequence") || 0),
      waitMs: Number(url.searchParams.get("waitMs") || 25000),
      limit: Number(url.searchParams.get("limit") || 20)
    });
    json(res, 200, result);
    return;
  }

  const nodeControlAckMatch = url.pathname.match(/^\/api\/agent\/v1\/control\/([^/]+)\/ack$/);
  if (req.method === "POST" && nodeControlAckMatch) {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    const result = ackAgentControlCommand(state, node, nodeControlAckMatch[1], body);
    commitUnguardedWrite(state);
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/v1/events") {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    if (!String(body.eventKey || "").trim()) return json(res, 400, {error: "execution_event_key_required"});
    let prepared;
    try {
      prepared = prepareAgentExecutionEvent(state, node, body);
    } catch (error) {
      const historicalDispatch = (state.agentDispatches || []).find((item) => item.dispatchId === body.dispatchId);
      const historicalEvent = historicalDispatch && body.eventKey
        ? readProjectExecutionEventByKey(runtimeDir, historicalDispatch.projectId, body.eventKey, {dispatchId: historicalDispatch.dispatchId})
        : null;
      if (!historicalEvent || historicalEvent.nodeId !== node.nodeId) throw error;
      prepared = {event: historicalEvent, duplicate: true, historical: true};
    }
    const storage = prepared.duplicate
      ? {...projectExecutionEventStorageInfo(prepared.event.projectId), duplicate: true, replayedProjection: Boolean(prepared.historical), event: prepared.event}
      : appendProjectExecutionEvent(runtimeDir, prepared.event);
    if (storage.event && !storage.duplicate) notifyLongPollWaiters(`project-events:${storage.event.projectId}`);
    // 持久层已经判定这条事件是重复的，就不该再走一遍投影：内存去重窗口只有 500 条，
    // 一条落出窗口的旧事件重放时会被再插一次、再跑一次进度更新、再续一次 claim。
    // 进度本身是 Math.max 幂等的，但控制台会多出重复条目，而无谓续租会推迟"这个节点其实已经不在了"
    // 的判定 —— 那正是 claim 过期回收赖以生效的信号。submitAgentExecutionEvent 那条路径本来就是
    // 这么短路的，只有 HTTP 这条漏了。
    if (storage.duplicate && !prepared.historical) {
      json(res, 202, {duplicate: true, storage, centralStateUpdated: false});
      return;
    }
    const result = recordAgentExecutionEvent(state, node, storage.event || prepared.event, {allowHistoricalNodeBinding: Boolean(prepared.historical || storage.duplicate)});
    try {
      commitUnguardedWrite(state);
      json(res, 202, {...result, storage, centralStateUpdated: true});
    } catch (error) {
      if (!isStateStoreConflict(error)) throw error;
      const recovered = retryExecutionEventProjection(req, body);
      json(res, 202, {...(recovered.result || result), storage: recovered.storage || storage, centralStateUpdated: recovered.ok, stateConflict: true, conflictRecovered: recovered.ok});
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/v1/dispatches/next") {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    const result = claimNextDispatch(state, node, {runtimeDir, claimTtlSeconds: body.claimTtlSeconds});
    // stateChanged 是给这里看的，不上线：认领失败时网关也会在节点上留下"为什么接不了"的诊断，
    // 那条诊断同样要落盘，否则控制台上永远是空的。
    const {stateChanged, ...claimPayload} = result;
    if (result.dispatch || stateChanged) commitUnguardedWrite(state);
    json(res, 200, claimPayload);
    return;
  }

  const nodeDispatchMatch = url.pathname.match(/^\/api\/agent\/v1\/dispatches\/([^/]+)$/);
  if (req.method === "GET" && nodeDispatchMatch) {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    json(res, 200, {dispatch: getDispatchForNode(state, node, nodeDispatchMatch[1], {runtimeDir})});
    return;
  }

  // 不可逆动作（git push）之前的 claim 复核。没有它，一个失联后恢复的节点会直接把提交推上去，
  // 而它的检查点提交要到推送之后才会被拒（404）—— 那时提交已经在远端分支上，且控制面毫无记录。
  const claimCheckMatch = url.pathname.match(/^\/api\/agent\/v1\/dispatches\/([^/]+)\/claim$/);
  if (req.method === "GET" && claimCheckMatch) {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    const epochParam = url.searchParams.get("claimEpoch");
    const result = validateDispatchClaim(state, node, claimCheckMatch[1], epochParam === null ? undefined : Number(epochParam));
    json(res, result.valid ? 200 : 409, result);
    return;
  }

  const skillWorksetMatch = url.pathname.match(/^\/api\/agent\/v1\/skill-worksets\/([^/]+)$/);
  if (req.method === "GET" && skillWorksetMatch) {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    json(res, 200, getSkillWorkset(state, node, decodeURIComponent(skillWorksetMatch[1]), {runtimeDir}));
    return;
  }

  const nodeCheckpointMatch = url.pathname.match(/^\/api\/agent\/v1\/dispatches\/([^/]+)\/checkpoint$/);
  if (req.method === "POST" && nodeCheckpointMatch) {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    const dispatch = state.agentDispatches.find((item) => item.dispatchId === nodeCheckpointMatch[1] && item.assignedNodeId === node.nodeId);
    if (!dispatch) return json(res, 404, {error: "dispatch_not_found"});
    // claim 代次此前只在【客户端自查】（/claim 复核）与【执行器凭据】里被读，检查点这个真正的
    // 写入点从不比较它 —— 而认领被回收后重新分配给【同一个节点】时，assignedNodeId 照样匹配。
    // 于是旧执行器（或它的 outbox 重放）提交的检查点会被当作当前这一轮的成果接受：
    // 派发判完成、产出目标置为 pushed，而那些提交属于上一次尝试。
    // fencing 必须在写入点拒绝过期写入，靠调用方自觉复核不算 fence（陈旧的调用方恰恰不会自觉）。
    const presentedClaimEpoch = body.claimEpoch;
    const currentClaimEpoch = Number(dispatch.claimEpoch || 0);
    if (presentedClaimEpoch !== undefined && Number(presentedClaimEpoch) !== currentClaimEpoch) {
      return json(res, 409, {error: "checkpoint_claim_epoch_stale", claimEpoch: currentClaimEpoch,
        presented: Number(presentedClaimEpoch),
        message: "这份检查点来自该派发的上一次认领，当前持有者已经换了一代；它的提交属于上一次尝试，不能算作本轮成果"});
    }
    if (dispatch.status === "completed") {
      const existingCheckpoint = state.checkpoints.find((item) => item.runId === dispatch.runId && item.sessionId === dispatch.sessionId && item.workId === dispatch.workItemId);
      const submittedCommit = body.commitRefs?.at(-1)?.commit;
      const existingCommit = existingCheckpoint?.commitRefs?.at(-1)?.commit;
      if (!existingCheckpoint || body.runId !== dispatch.runId || body.sessionId !== dispatch.sessionId || submittedCommit !== existingCommit) {
        return json(res, 409, {error: "checkpoint_replay_binding_mismatch"});
      }
      json(res, 200, {accepted: true, replayed: true, checkpoint: existingCheckpoint});
      return;
    }
    // 只在【这个派发被认领过不止一次】时强制要求带代次：首次认领不存在更早的持有者，
    // 缺代次也掩盖不了陈旧写入；这样既补上 fence，又不会因为旧版 agent 缺字段而拒掉常规路径。
    if (presentedClaimEpoch === undefined && Number(dispatch.attempts || 0) > 1) {
      // 缺字段即可绕过的 fence 不算 fence，所以这里必须强制。但在役的旧版运行时（0.3.0 之前）
      // 不发送代次，一旦其派发被重新认领就会卡在这里 —— 因此把"该怎么办"直接写进拒绝信息，
      // 而不是让运维面对一个只说"必须带上"的错误码。运行时版本已随该契约变更提升到 0.3.0。
      return json(res, 409, {error: "checkpoint_claim_epoch_required", claimEpoch: currentClaimEpoch,
        requiredRuntimeVersion: "0.3.0",
        nodeRuntimeVersion: node.runtimeVersion || null,
        message: "该派发被重新认领过，提交检查点必须带上你持有的 claimEpoch，否则无法区分它来自哪一次尝试。"
          + "若该节点的 agent 运行时早于 0.3.0（不发送认领代次），请在该主机上重新执行入网安装命令升级后重试"});
    }
    const target = state.repositoryOutputs.find((item) => item.targetId === dispatch.repositoryOutputTargetRef);
    if (!target) return json(res, 409, {error: "repository_output_target_missing"});
    const verificationRoot = await prepareRemoteGitVerification(target, body);
    // 路由按 dispatchId + assignedNodeId 认证到派发 A，然后把【整个 body】交给 acceptAgentCheckpoint —— 
    // 而后者完全按 body 里的 taskGroupId/workId/sessionId/runId 另行查找派发 B，从不与 A 比对。
    // 于是：一个曾经持有过 B（claim 过期被回收，runId/sessionId/targetId 全部保留）的节点，
    // 只要再 claim 到同项目的任意派发 A，就能用 A 的身份替 B 提交检查点 —— B 被判完成、它的产出目标
    // 置为 pushed，真正在执行 B 的那个节点之后永远提交不上去，而审计里记的是"这个节点完成了 A"。
    // 认证到的是谁，就只能替谁提交：身份字段一律以 A 为准，不接受 body 自报。
    const boundBody = {...body,
      dispatchId: dispatch.dispatchId,
      runId: dispatch.runId,
      sessionId: dispatch.sessionId,
      workId: dispatch.workItemId,
      workItemId: dispatch.workItemId,
      taskGroupId: dispatch.taskGroupId,
      projectId: dispatch.projectId,
      repositoryOutputTargetRefs: [target.targetId]};
    const result = acceptAgentCheckpoint(state, boundBody, {root: verificationRoot, repositoryRoot: verificationRoot});
    if (!result.accepted) {
      commitUnguardedWrite(state);
      json(res, result.status || 409, result);
      return;
    }
    finishNodeDispatch(state, node, dispatch.dispatchId, true);
    audit(state, `agent-node:${node.nodeId}`, "checkpoint_submit", `AgentDispatch:${dispatch.dispatchId}`);
    commitUnguardedWrite(state);
    json(res, 201, result);
    return;
  }

  const nodeFailureMatch = url.pathname.match(/^\/api\/agent\/v1\/dispatches\/([^/]+)\/fail$/);
  if (req.method === "POST" && nodeFailureMatch) {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    const dispatch = state.agentDispatches.find((item) => item.dispatchId === nodeFailureMatch[1] && item.assignedNodeId === node.nodeId);
    if (!dispatch) return json(res, 404, {error: "dispatch_not_found"});
    // 与 /checkpoint 同一道 fence，而且这一侧更直接：旧执行器超时后调 /fail(blocked)，
    // 会把【当前这一轮正在跑的活】标记为阻塞 —— 认领被回收再分回同一节点时 assignedNodeId 照样匹配。
    // 这里只做「带了就比较」而不强制要求：outbox 条目内容损坏时 agent 拿不到代次（那份条目本就不可解析），
    // 强制会把损坏隔离这条恢复路径一起拖垮 —— 而那条路径存在的意义正是让丢失的证据被人看见。
    const failClaimEpoch = Number(dispatch.claimEpoch || 0);
    // 与 /checkpoint 同规（那边已经这么做了，这边一直没有）：派发被认领过不止一次时，
    // 缺代次就不能放行 —— 缺字段即可绕过的 fence 不算 fence。
    // 这条路径的危害比检查点更直接：旧执行器超时后调 /fail(blocked)，
    // 会把【当前这一轮正在跑的活】标记为阻塞，而 assignedNodeId 在重认领回同一节点时照样匹配。
    // 判据仍限定在 attempts > 1：首次认领不存在更早的持有者，强制它只会拒掉旧版 agent 的常规路径。
    if (body.claimEpoch === undefined && Number(dispatch.attempts || 0) > 1) {
      return json(res, 409, {error: "dispatch_fail_claim_epoch_required", claimEpoch: failClaimEpoch,
        requiredRuntimeVersion: "0.3.0",
        nodeRuntimeVersion: node.runtimeVersion || null,
        message: "该派发被重新认领过，上报失败/阻塞必须带上你持有的 claimEpoch，否则无法区分它来自哪一次尝试。"
          + "若该节点的 agent 运行时早于 0.3.0（不发送认领代次），请在该主机上重新执行入网安装命令升级后重试"});
    }
    if (body.claimEpoch !== undefined && Number(body.claimEpoch) !== failClaimEpoch) {
      return json(res, 409, {error: "dispatch_fail_claim_epoch_stale", claimEpoch: failClaimEpoch,
        presented: Number(body.claimEpoch),
        message: "这条失败上报来自该派发的上一次认领；当前持有者已经换了一代，不能用它把正在跑的这一轮标记为失败或阻塞"});
    }
    // Terminal-state guard (symmetric with the checkpoint route): a late/retried /fail must not corrupt
    // an already-finished dispatch. A /fail against a COMPLETED (successfully checkpointed, possibly
    // reviewed) dispatch is a real conflict; a repeat of the same non-success outcome acks idempotently.
    if (isTerminalDispatchStatus(dispatch.status)) {
      if (dispatch.status === "completed") return json(res, 409, {error: "dispatch_already_completed"});
      return json(res, 200, {ok: true, replayed: true, dispatchId: dispatch.dispatchId, status: dispatch.status});
    }
    // 不填＝failed（这是 /fail 端点，默认合理）；填了但认不出的必须拒 ——
    // 原先 "blockd" 这样拼错一个字母会被降级成 failed，那是【终态】：
    // 本来只是阻塞、人一恢复就能接着跑的活，从此再也回不来，而上报方拿到的是 200。
    const FAIL_REPORT_STATUSES = ["blocked", "cancelled", "failed"];
    if (body.status !== undefined && !FAIL_REPORT_STATUSES.includes(body.status)) {
      return json(res, 400, {error: "dispatch_fail_status_unknown", status: String(body.status).slice(0, 60),
        supported: FAIL_REPORT_STATUSES,
        message: "认不出的上报状态。blocked 可恢复，cancelled/failed 是终态 —— 别让拼写错误把可恢复的活变成终态。"});
    }
    const reportedStatus = body.status === undefined ? "failed" : body.status;
    // 人下的暂停不许被 agent 的上报抹掉：控制面已经把它置成 blocked 并写明是谁停的，
    // 这时收到一条 failed，`dispatch.status = reportedStatus` 会把它推进终态 ——
    // 人的动作从屏幕上消失，而且终态再也 resume 不回来（resume 只认 blocked）。
    // 与 /checkpoint 同一道门：靠调用方自觉不算 fence（旧执行器、outbox 重放都会走到这里）。
    if (dispatch.status === "blocked"
      && HUMAN_CONTROL_BLOCK_REASONS.includes(dispatch.blockedReason)) {
      return json(res, 409, {error: "dispatch_halted_by_human_control", blockedReason: dispatch.blockedReason,
        message: "这个派发已经被人叫停了。先由人恢复（resume），再上报执行结果。"});
    }
    if (dispatch.blockedReason === "awaiting_human_confirmation" && reportedStatus !== "blocked") {
      cancelPendingConfirmationsForDispatch(state, dispatch.dispatchId, `dispatch_${reportedStatus}`);
    }
    const session = state.workSessions.find((item) => item.sessionId === dispatch.sessionId);
    // A /fail(blocked) that arrives while the session is still permission_required is a permission-poll
    // TIMEOUT: mark the dispatch so the (still-pending) permission-resolve lever can find and requeue or
    // terminalize it later. Without a marker the blocked, node-detached dispatch is orphaned and wedges
    // the close barrier — the operator's approval/denial would be a no-op.
    const permissionTimedOut = reportedStatus === "blocked" && session?.status === "permission_required";
    // 失败计数记在工作项上（派发历史有 240 条上限，现数会被顶掉 —— 见 noteWorkItemExecutionFailure）。
    // 这一条路径是 agent 自己上报失败，与编排里那条 markDispatchFailed 是同一件事的两个入口。
    if (reportedStatus === "failed") noteWorkItemExecutionFailure(state, dispatch);
    dispatch.status = reportedStatus;
    if (permissionTimedOut && !dispatch.blockedReason) dispatch.blockedReason = "permission_request_pending";
    dispatch.failureReason = clampVisibleText(body.reason || "agent_runtime_failure", 2000);
    dispatch.updatedAt = now();
    if (session) {
      session.status = reportedStatus === "blocked" ? "needs_decision" : reportedStatus === "cancelled" ? "aborted" : "failed";
      // 原因不能只在 blocked 时写：agent 报 failed 是更常见的那条路，而监控页「工作会话」表
      // 读的就是 session.blockedReason —— 不写就是「失败 / -」，人得自己去派发表里对 id。
      // 与编排里的 markDispatchFailed 是同一件事的两个入口，两处必须一样。
      session.blockedReason = reportedStatus === "blocked"
        ? (dispatch.blockedReason || session.blockedReason)
        : (dispatch.failureReason || session.blockedReason);
      session.updatedAt = now();
    }
    routeBlockedDispatchToHumanDecision(state, dispatch);
    finishNodeDispatch(state, node, dispatch.dispatchId, false);
    audit(state, `agent-node:${node.nodeId}`, `dispatch_${reportedStatus}`, `AgentDispatch:${dispatch.dispatchId}`, reportedStatus);
    commitUnguardedWrite(state);
    json(res, 200, {ok: true, dispatchId: dispatch.dispatchId, status: dispatch.status});
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/bootstrap-hint") {
    const config = readRuntimeConfig();
    if (!canExposeBootstrapHint(req)) {
      json(res, 200, {
        bootstrapTokenConfigured: Boolean(config.bootstrapTokenHash),
        tokenHintsExposed: false
      });
      return;
    }
    json(res, 200, {
      bootstrapTokenConfigured: Boolean(config.bootstrapTokenHash),
      tokenHintsExposed: true,
      tokenSource: process.env.AIMAC_BOOTSTRAP_TOKEN ? "environment" : "runtime-local-config",
      tokenHint: config.localBootstrapToken ? `${config.localBootstrapToken.slice(0, 4)}...${config.localBootstrapToken.slice(-4)}` : null,
      // 登录要【身份 + 令牌】两样。原先只提示令牌，人拿着一串 token 面对"登录账号"输入框无从下手 ——
      // 而这个值只写在 .env.example 与种子数据里。放在这条已有的门内（仅回环 + 非生产）：
      // 在公开的登录页上说出管理员账号叫什么，等于把凭据的一半送出去。
      systemAdminLogin: (state.accounts || []).find((item) => item.accountType === "system_admin")?.email || null,
      localAccountTokenHints: Object.fromEntries(Object.entries(config.localAccountTokens || {}).map(([accountId, token]) => [accountId, `${token.slice(0, 4)}...${token.slice(-4)}`]))
    });
    return;
  }

	  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    if (loginRateLimited(req)) {
      // 原先写死 60 —— 而窗口是从【第一次失败】起算的，真到人被挡住时常常只剩十几秒。
      // 报一个偏大的数，人就真的去等满一分钟；这个值服务端本来就有，没有理由不说准。
      json(res, 429, {error: "too_many_login_attempts", retryAfterSeconds: loginRetryAfterSeconds(req)});
      return;
    }
    const config = readRuntimeConfig();
    const token = String(body.token || body.accountToken || body.bootstrapToken || "");
    const email = String(body.email || "");
    // 精确匹配优先：万一历史数据里已经有两个只差大小写的账号，行为与从前一致；
    // 找不到再按归一口径找一次，让大小写/空格不同的人也能进来。
    const account = state.accounts.find((item) => item.email === email || item.accountId === email)
      || state.accounts.find((item) => sameEmail(item.email, email));
    const method = account?.authPolicy?.method;
    const bootstrapOk = method === "bootstrap_token" && digestOf(`bootstrap:${token}`) === config.bootstrapTokenHash;
    const localAccountOk = Boolean(account && config.localAccountTokenHashes?.[account.accountId] === digestOf(`account:${account.accountId}:${token}`));
    const issuedAccountOk = Boolean(account?.status === "invited" && account?.credentialDigest && account.credentialDigest === digestOf(`account-invite:${account.accountId}:${token}`) && (!account.credentialExpiresAt || new Date(account.credentialExpiresAt).getTime() > Date.now()));
    const passwordCheck = account && body.password ? verifyAccountPassword(account, body.password) : {ok: false, needsUpgrade: false};
    const passwordOk = passwordCheck.ok;
    const tokenOk = bootstrapOk || localAccountOk || issuedAccountOk || passwordOk;
    if (!tokenOk || !account || !["active", "invited"].includes(account.status)) {
      // 结果码要按场景选："denied" 在词表里是「已驳回」（审批用语）——
      // 登录失败并没有人审批过，台账上写"已驳回"会让人以为有人拒了他。
      // 真实台账读出来就是"登录 Account:x 已驳回"（拿真实状态渲染时读到的）。
      audit(state, "auth-service", "auth_login", `Account:${email}`, "credentials_invalid");
      commitUnguardedWrite(state);
      recordFailedLogin(req);
      json(res, 401, {error: "invalid_credentials"});
      return;
    }
    // account.schema.json 把 authPolicy.mfaRequired 列为必填，publicAccountRecord 也把它回给调用方 ——
    // 但全仓没有任何一处读它：口令/令牌验过就发会话。今天它处处写死 false，所以看不出问题；
    // 一旦有任何路径（导入、直接改库、以后的管理入口）把它置为 true，这里会一声不吭地照发会话，
    // 那时"声明了 MFA"与"实际没有 MFA"的差别只存在于一个没人读的字段里。
    // 在补上真正的 MFA 之前，声明了就必须拒绝发会话 —— 做不到的安全策略要停在门口，不能默认放行。
    if (account.authPolicy?.mfaRequired) {
      json(res, 403, {error: "mfa_required_but_unavailable",
        message: "该账号声明必须二次验证，而本部署尚未实现二次验证；在实现之前不会为它签发会话"});
      return;
    }
    // 旧格式口令验证成功后就地升级为 scrypt：不需要任何人重设密码，也不会有人被锁在门外。
    // 放在这里（认证已通过、状态写入之前），因为只有此刻我们手里同时有明文和"它确实正确"这个结论。
    if (passwordCheck.ok && passwordCheck.needsUpgrade) {
      account.passwordDigest = newPasswordDigest(body.password);
      account.updatedAt = now();
    }
    if (account.status === "invited" && issuedAccountOk) {
      account.status = "active";
      account.activatedAt = now();
      account.credentialConsumedAt = now();
      account.credentialExpiresAt = account.credentialConsumedAt;
      delete account.credentialDigest;
      account.updatedAt = now();
    }
    // 登录成功要清零该 IP 的失败计数：否则输错几次再登进去，之后一次手误就撞上 429 ——
    // 节流本是拦暴力破解的，不该反过来把已经证明自己是本人的人挡在外面。
    clearFailedLogins(req);
    const sessionToken = randomBytes(32).toString("base64url");
    // authPolicy.sessionTtlSeconds 此前是纯装饰：账号上写着 3600 或 28800、还通过 publicAccountRecord
    // 回显给控制台，而签发时固定 8 小时。运维给高权账号配了 1 小时会话，实得 8 小时 ——
    // 一个安全相关的字段在对人说谎。夹在 [5 分钟, 24 小时] 之间，缺省仍是 8 小时。
    const configuredTtl = Number(account.authPolicy?.sessionTtlSeconds);
    const sessionTtlSeconds = Number.isFinite(configuredTtl) && configuredTtl > 0
      ? Math.min(24 * 60 * 60, Math.max(300, Math.floor(configuredTtl)))
      : 8 * 60 * 60;
    const expiresAt = new Date(Date.now() + sessionTtlSeconds * 1000).toISOString();
    state.authSessions.unshift({
      // 这个集合此前不受任何规范约束。要紧的是两条：绝不存明文令牌（只存摘要），
      // 以及 expiresAt 必须是合法时间 —— 写坏了的话 `new Date(x) > now` 两个方向都是 false，
      // 该拒的不拒、该收的不收，而且没有任何地方会报错（本仓的时间形态老毛病）。
      schemaVersion: "auth-session/v1",
      sessionId: createId("authsess"),
      tokenDigest: digestOf(`session:${sessionToken}`),
      accountId: account.accountId,
      status: "active",
      expiresAt,
      createdAt: now(),
      updatedAt: now()
    });
    // Prune EXPIRED/non-active sessions first (never evict a live session — a flat count cap would
    // force-logout an active session belonging to any other tenant/admin once concurrency exceeds it).
    // Keep all still-active sessions; only if active sessions themselves exceed a high bound do we drop
    // the oldest active ones (last resort against a runaway).
    const nowMs = Date.now();
    const liveSessions = state.authSessions.filter((item) => item.status === "active" && new Date(item.expiresAt || 0).getTime() > nowMs);
    const activeCap = clampEnvNumber(process.env.AIMAC_ACTIVE_SESSION_CAP, 200, 5000);
    state.authSessions = liveSessions.slice(0, activeCap);
    audit(state, "auth-service", "auth_login", `Account:${account.accountId}`);
    commitUnguardedWrite(state);
	    json(res, 200, {sessionToken, expiresAt, account: {accountId: account.accountId, accountType: account.accountType, organizationId: account.organizationId || null, defaultProjectId: account.defaultProjectId || null, email: account.email, displayName: account.displayName, roles: account.roles, permissions: account.permissions, effectivePermissions: accountEffectivePermissions(state, account), passwordSet: Boolean(account.authPolicy?.passwordSet)}});
	    return;
	  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const session = authenticateRequest(req, state);
    if (session) {
      session.status = "revoked";
      session.revokedAt = now();
      // 撤销原因两条路径都要写：另一条（改密/停用触发的 revokeAccountSessions）此前只写原因不写时间，
      // 这条只写时间不写原因。会话被撤销时人要问的是「什么时候、为什么」，缺一半就答不上来。
      session.revokedReason = "logout";
      session.updatedAt = session.revokedAt;
      audit(state, "auth-service", "auth_logout", `Account:${session.accountId}`);
      commitUnguardedWrite(state);
    }
    json(res, 200, {ok: true});
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    const reader = accountFromRequest(req, state);
    if (!reader) {
      json(res, 401, {error: "auth_required"});
      return;
    }
    const view = url.searchParams.get("view") || "full";
    const limit = Number(url.searchParams.get("limit") || 80);
    jsonView(req, res, cachedStateView(state, reader.account, reader.session, view, limit, url.searchParams.get("projectId") || null),
      req.stateViewEtag ? {etag: req.stateViewEtag, "cache-control": "no-cache"} : undefined);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/model-registry") {
    const reader = accountFromRequest(req, state);
    if (!reader) {
      json(res, 401, {error: "auth_required"});
      return;
    }
    const scoped = cachedScopedState(state, reader.account, reader.session);
    json(res, 200, {
      modelCapabilities: scoped.modelCapabilities,
      modelSelectionPolicies: scoped.modelSelectionPolicies,
      modelSelectionDecisions: (scoped.modelSelectionDecisions || []).slice(0, 40)
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/skill-registry") {
    const reader = accountFromRequest(req, state);
    if (!reader) {
      json(res, 401, {error: "auth_required"});
      return;
    }
    const scoped = cachedScopedState(state, reader.account, reader.session);
    // 界面只按 sourceId 数个数、判存在（从不读正文）。而 roleSkills 是整份状态里最大的一块
    // ——真实部署里 281 条 293KB，占 73%。整份下发有两个后果：每次打开这一页都白传 293KB；
    // 而且它会被视图上限截断（实测 269 条截到 188 条），于是屏幕上那个"技能数"本身就是错的。
    // 改为服务端直接给【按来源分组的计数】：既省掉那 293KB，计数也不再受截断影响。
    const roleSkillCountBySource = {};
    // 同上：scoped.roleSkills 已被清空，这里必须从 state 算（这个端点因此也一直在回全 0，
    // 只是控制台从没调过它，没人看见）。
    for (const skill of state.roleSkills || []) {
      const key = skill.sourceId || "unknown";
      roleSkillCountBySource[key] = (roleSkillCountBySource[key] || 0) + 1;
    }
    const roleSkillIndex = (state.roleSkills || []).map((skill) => ({
      roleSkillId: skill.roleSkillId,
      sourceId: skill.sourceId,
      sourcePath: skill.sourcePath,
      name: skill.name || skill.title || skill.roleSkillId,
      category: skill.category || skill.domain || "role",
      status: skill.status || "active",
      capabilities: (skill.capabilities || []).slice(0, 12),
      contentDigest: skill.contentDigest
    })).sort((left, right) => String(left.roleSkillId || "").localeCompare(String(right.roleSkillId || ""), "zh-Hans-CN"));
    json(res, 200, {
      skillSources: scoped.skillSources,
      roleSkillCountBySource,
      roleSkillIndex,
      roleSkillOverlays: scoped.roleSkillOverlays
    });
    return;
  }

  // 这里原先有一条 GET /api/progress-snapshots：全仓零调用（控制台、agentctl、MCP、e2e、文档都没有），
  // 而且它读的 scoped.progressSnapshots 对非系统账号【恒为空】（那是主视图瘦身时清掉的五个集合之一）。
  // 一个没人用、对多数账号又静默返回空的接口，留着只会坑下一个发现它的人。
  // 进度数据的正主是 GET /api/task-groups/:id/progress（按需取一个任务组，控制台用的就是它）。

  const projectDetailMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (req.method === "GET" && projectDetailMatch) {
    const resolved = readableProjectOr403(req, state, projectDetailMatch[1]);
    if (resolved.denial) {
      json(res, resolved.denial.status, resolved.denial.payload);
      return;
    }
    const project = resolved.project;
    const taskGroupLimit = Math.max(1, Math.min(200, Number(url.searchParams.get("taskGroupLimit") || 50)));
    const taskGroups = (state.taskGroups || []).filter((item) => item.projectId === project.id);
    const repositoryOutputs = (state.repositoryOutputs || []).filter((target) => target.projectId === project.id);
    json(res, 200, {
      project,
      taskGroups: projectTaskGroupsForView(taskGroups.slice(0, taskGroupLimit)),
      taskGroupCount: taskGroups.length,
      ...(taskGroups.length > taskGroupLimit ? {taskGroupsTruncated: true} : {}),
      repositoryOutputs: repositoryOutputs.slice(0, 200),
      repositoryOutputCount: repositoryOutputs.length,
      ...(repositoryOutputs.length > 200 ? {repositoryOutputsTruncated: true} : {})
    });
    return;
  }

  const taskGroupDetailMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)$/);
  if (req.method === "GET" && taskGroupDetailMatch) {
    const taskGroup = (state.taskGroups || []).find((item) => item.id === taskGroupDetailMatch[1]);
    if (!taskGroup) {
      const denial = missingRecordDenial(req, state, "task_group_not_found", "permission_denied");
      json(res, denial.status, denial.payload);
      return;
    }
    const reader = requireRead(req, state, taskGroupScope(state, taskGroup.id));
    if (reader.status) {
      json(res, reader.status, reader.payload);
      return;
    }
    const workItemLimit = Math.max(1, Math.min(500, Number(url.searchParams.get("workItemLimit") || progressWorkItemCap)));
    const workItems = Array.isArray(taskGroup.workItems) ? taskGroup.workItems : [];
    const taskGroupSessions = (state.workSessions || []).filter((session) => session.taskGroupId === taskGroup.id);
    const taskGroupDispatches = (state.agentDispatches || []).filter((dispatch) => dispatch.taskGroupId === taskGroup.id);
    json(res, 200, {
      taskGroup: {
        ...taskGroup,
        workItems: workItems.slice(0, workItemLimit),
        workItemCount: workItems.length,
        ...(workItems.length > workItemLimit ? {workItemsTruncated: true} : {})
      },
      repositoryOutputs: (state.repositoryOutputs || []).filter((target) => target.taskGroupId === taskGroup.id),
      workSessions: taskGroupSessions.slice(0, 100),
      workSessionCount: taskGroupSessions.length,
      ...(taskGroupSessions.length > 100 ? {workSessionsTruncated: true} : {}),
      agentDispatches: taskGroupDispatches.slice(0, 100),
      agentDispatchCount: taskGroupDispatches.length,
      ...(taskGroupDispatches.length > 100 ? {agentDispatchesTruncated: true} : {}),
      latestReadiness: (state.completionReadiness || []).find((item) => item.taskGroupId === taskGroup.id) || null,
      latestCloseBarrier: (state.closeBarriers || []).find((item) => item.taskGroupId === taskGroup.id) || null
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent-nodes") {
    const reader = accountFromRequest(req, state);
    if (!reader) return json(res, 401, {error: "auth_required"});
    const visible = isSystemAccount(reader.account)
      ? state.agentRuntimeNodes
      : state.agentRuntimeNodes.filter((nodeItem) => (nodeItem.projectIds || []).some((projectId) => canReadProject(state, reader.account, projectId)));
    json(res, 200, {agentRuntimeNodes: visible.map(publicAgentNode)});
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent-join-tokens") {
    const reader = accountFromRequest(req, state);
    if (!reader) return json(res, 401, {error: "auth_required"});
    const projectId = url.searchParams.get("projectId") || undefined;
    const tokens = listAgentJoinTokens(state, projectId).filter((token) => isSystemAccount(reader.account) || canReadProject(state, reader.account, token.projectId));
    json(res, 200, {agentJoinTokens: tokens});
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent-join-tokens") {
    const guard = beginGuardedWrite(req, state, "agent_join_token_create", `Project:${body.projectId || "unknown"}`, projectScope(body.projectId));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = createAgentJoinToken(state, body, {actor: guard.actor, publicUrl: publicEndpoint(req)});
    const persistedResult = {joinTokenRecord: result.joinTokenRecord, secretReturnedOnce: true};
    audit(state, guard.actor, "agent_join_token_create", `AgentJoinToken:${result.joinTokenRecord.joinTokenId}`);
    finishGuardedWrite(state, guard, 201, persistedResult);
    writeState(state);
    json(res, 201, result);
    return;
  }

  const revokeJoinTokenMatch = url.pathname.match(/^\/api\/agent-join-tokens\/([^/]+)\/revoke$/);
  if (req.method === "POST" && revokeJoinTokenMatch) {
    if (!requireAuthenticated(req, state, res)) return;
    const record = state.agentJoinTokens.find((item) => item.joinTokenId === revokeJoinTokenMatch[1]);
    if (!record) {
      const denial = missingRecordDenial(req, state, "agent_join_token_not_found", "policy_denied");
      return json(res, denial.status, denial.payload);
    }
    const guard = beginGuardedWrite(req, state, "agent_join_token_revoke", `Project:${record.projectId}`, projectScope(record.projectId));
    if (guard.status) return json(res, guard.status, guard.payload);
    record.status = "revoked";
    record.updatedAt = now();
    const payload = {joinTokenId: record.joinTokenId, status: record.status};
    // finishGuardedWrite 只写 decisionRecords，而【控制台一处都不读它】——
    // 人能看到的那本账是 auditLog。安全动作不进那本账，等于"谁把这台机器踢出去的"查不到。
    audit(state, guard.actor, "agent_join_token_revoke", `AgentJoinToken:${record.joinTokenId}`);
    finishGuardedWrite(state, guard, 200, payload);
    writeState(state);
    json(res, 200, payload);
    return;
  }

  const revokeNodeMatch = url.pathname.match(/^\/api\/agent-nodes\/([^/]+)\/revoke$/);
  if (req.method === "POST" && revokeNodeMatch) {
    if (!requireAuthenticated(req, state, res)) return;
    const targetNode = state.agentRuntimeNodes.find((item) => item.nodeId === revokeNodeMatch[1]);
    if (!targetNode) {
      const denial = missingRecordDenial(req, state, "agent_node_not_found", "policy_denied");
      return json(res, denial.status, denial.payload);
    }
    const projectId = targetNode.projectIds?.[0];
    const crossProject = refuseIfNodeServesUnauthorizedProjects(req, state, targetNode);
    if (crossProject) return json(res, crossProject.status, crossProject.payload);
    const guard = beginGuardedWrite(req, state, "agent_node_revoke", `Project:${projectId}`, projectScope(projectId));
    if (guard.status) return json(res, guard.status, guard.payload);
    const payload = requestAgentNodeRevocation(state, targetNode, body, {actor: guard.actor, idempotencyKey: guard.idempotencyKey});
    audit(state, guard.actor, "agent_node_revoke", `AgentRuntimeNode:${targetNode.nodeId}`);
    finishGuardedWrite(state, guard, 200, payload);
    writeState(state);
    json(res, 200, payload);
    return;
  }

  const controlNodeMatch = url.pathname.match(/^\/api\/agent-nodes\/([^/]+)\/control$/);
  if (req.method === "POST" && controlNodeMatch) {
    if (!requireAuthenticated(req, state, res)) return;
    const targetNode = state.agentRuntimeNodes.find((item) => item.nodeId === controlNodeMatch[1]);
    if (!targetNode) {
      const denial = missingRecordDenial(req, state, "agent_node_not_found", "policy_denied");
      return json(res, denial.status, denial.payload);
    }
    const commandType = String(body.commandType || body.action || "refresh_profile");
    const targetDispatch = body.dispatchId ? state.agentDispatches.find((dispatch) => dispatch.dispatchId === body.dispatchId) : null;
    // A dispatch-scoped control command must target a dispatch actually bound to THIS node. Rejecting a
    // mismatch both closes an intra-org scope-looseness (the guard is keyed on the dispatch's task group,
    // so a foreign dispatch could authorize a command to an unrelated node) and prevents a no-op command.
    if (["pause_dispatch", "cancel_dispatch", "resume_dispatch"].includes(commandType) && targetDispatch && targetDispatch.assignedNodeId !== targetNode.nodeId) {
      return json(res, 409, {error: "dispatch_not_assigned_to_node"});
    }
    // resume_dispatch may only revive a BLOCKED (paused / permission-held) dispatch. Resuming a dispatch
    // that is still `running` would requeue it (assignment cleared) while the node keeps executing, so a
    // second node re-claims and re-runs the same runId → double execution + an orphaned push. Reject it.
    if (commandType === "resume_dispatch" && targetDispatch && targetDispatch.status !== "blocked") {
      // 不回显 dispatch.status：这段在 beginGuardedWrite 之前，把状态插进响应等于让未鉴权调用方
      // 探测任意（含别的租户的）dispatch 处于什么状态。错误码本身已足够说明问题。
      return json(res, 409, {error: "dispatch_not_resumable"});
    }
    const taskScopedControl = ["pause_dispatch", "cancel_dispatch", "resume_dispatch"].includes(commandType) && targetDispatch;
    // 派发级的命令按【那条派发所属的任务组】判权（下面那一支），作用域是准的。
    // 节点级的命令不一样：它影响这台节点服务的【全部】项目，而这里只按 projectIds[0] 判。
    if (!taskScopedControl) {
      const crossProject = refuseIfNodeServesUnauthorizedProjects(req, state, targetNode);
      if (crossProject) return json(res, crossProject.status, crossProject.payload);
    }
    const projectId = targetNode.projectIds?.[0];
    const guard = taskScopedControl
      ? beginGuardedWrite(req, state, "task_group_agent_control_command_create", `TaskGroup:${targetDispatch.taskGroupId}`, taskGroupScope(state, targetDispatch.taskGroupId))
      : beginGuardedWrite(req, state, "agent_control_command_create", `AgentRuntimeNode:${targetNode.nodeId}`, projectScope(projectId));
    if (guard.status) return json(res, guard.status, guard.payload);
    // Defense in depth: the command's visibility is keyed on nodeId, but the task-scoped branch guards only the
    // dispatch's task group. Independently confirm the target node's project is within the actor's organization,
    // so this endpoint also satisfies the "guard covers the visibility-keying field" invariant even if a future
    // change persisted the command before the node-ownership pre-effect check.
    const controlActor = state.accounts.find((item) => accountIdOf(item) === guard.actor);
    const targetNodeOrg = resourceScopeOrganizationId(state, projectScope(projectId));
    if (controlActor && !isSystemAccount(controlActor) && controlActor.organizationId && targetNodeOrg && targetNodeOrg !== controlActor.organizationId) {
      return json(res, 403, {error: "policy_denied", reason: "target_node_out_of_organization"});
    }
    // 不给命令类型就默认 refresh_profile：空 body 打过来也会真的往节点下一条命令（实测 201）。
    // 控制命令是对着【别人机器上正在跑的东西】发的，缺省不该替调用方挑一个。
    // 【必须放在鉴权之后】：放前面的话，真实的外租户节点 id 回 400（缺参数）、编造的 id 回 403，
    // 两者可分辨＝挨个试就能数出别的租户有多少节点。跨租户存在性预言机那道门当场抓到过这一版。
    if (requireBodyFields(res, body, ["commandType"], "agent_control_command_type_required")) return;
    const result = createAgentControlCommand(state, targetNode, body, {actor: guard.actor, idempotencyKey: guard.idempotencyKey});
    // 给 agent 下控制命令（暂停/取消/关停）同样是要留痕的动作：谁在什么时候停了谁。
    audit(state, guard.actor, `agent_control_${result.command.commandType}`,
      `AgentRuntimeNode:${targetNode.nodeId}${result.command.dispatchId ? `/AgentDispatch:${result.command.dispatchId}` : ""}`);
    finishGuardedWrite(state, guard, 201, result.command);
    writeState(state);
    json(res, 201, result);
    return;
  }

  const readinessMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/readiness$/);
  if (req.method === "GET" && readinessMatch) {
    const reader = requireRead(req, state, taskGroupScope(state, readinessMatch[1]));
    if (reader.status) {
      json(res, reader.status, reader.payload);
      return;
    }
    const readOnlyState = structuredClone(withoutStateInternals(state));
    const readiness = computeCompletionReadiness(readOnlyState, readinessMatch[1], {root: repositoryRoot});
    const closeBarrier = computeCloseBarrier(readOnlyState, readinessMatch[1], {root: repositoryRoot, mutate: false});
    json(res, 200, {readiness, closeBarrier});
    return;
  }

  const projectProgressMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/progress$/);
  if (req.method === "GET" && projectProgressMatch) {
    const resolved = readableProjectOr403(req, state, projectProgressMatch[1]);
    if (resolved.denial) {
      json(res, resolved.denial.status, resolved.denial.payload);
      return;
    }
    const project = resolved.project;
    json(res, 200, {
      projectId: project.id,
      progress: project.progress,
      repositoryOutputs: (state.repositoryOutputs || []).filter((target) => target.projectId === project.id)
    });
    return;
  }

  const taskGroupProgressMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/progress$/);
  if (req.method === "GET" && taskGroupProgressMatch) {
    const reader = requireRead(req, state, taskGroupScope(state, taskGroupProgressMatch[1]));
    if (reader.status) {
      json(res, reader.status, reader.payload);
      return;
    }
    const taskGroup = state.taskGroups.find((item) => item.id === taskGroupProgressMatch[1]);
    if (!taskGroup) {
      json(res, 404, {error: "task_group_not_found"});
      return;
    }
    json(res, 200, {
      taskGroupId: taskGroup.id,
      phase: taskGroup.phase,
      progress: taskGroup.progress,
      health: taskGroup.health,
      languagePolicy: taskGroup.languagePolicy,
      roles: taskGroup.roles,
      taskAnalysis: taskGroup.taskAnalysis || null,
      // 明细页此前把【全部】工作项一次发下来，而界面把每一条都渲染成一行、每 5 秒轮询重建一次：
      // 4000 单元时是约 1.1MB 载荷 + 4000 个 DOM 节点。给上限，并把真实总数一起给出去 ——
      // 截断后的长度当总数，是这套系统反复栽过的坑。
      workItems: newestWindow(taskGroup.workItems, progressWorkItemCap),
      workItemCount: (taskGroup.workItems || []).length,
      ...((taskGroup.workItems || []).length > progressWorkItemCap ? {workItemsTruncated: true} : {}),
      blockers: taskGroup.blockers,
      ...(Number(taskGroup.blockersDroppedCount || 0) ? {blockersDroppedCount: taskGroup.blockersDroppedCount} : {}),
      repositoryOutputs: (state.repositoryOutputs || []).filter((target) => target.taskGroupId === taskGroup.id)
    });
    return;
  }

  const dispatchEventsMatch = url.pathname.match(/^\/api\/agent-dispatches\/([^/]+)\/events$/);
  if (req.method === "GET" && dispatchEventsMatch) {
    const dispatch = state.agentDispatches.find((item) => item.dispatchId === dispatchEventsMatch[1]);
    if (!dispatch) {
      const denial = missingRecordDenial(req, state, "dispatch_not_found", "permission_denied");
      return json(res, denial.status, denial.payload);
    }
    const reader = requireRead(req, state, taskGroupScope(state, dispatch.taskGroupId));
    if (reader.status) return json(res, reader.status, reader.payload);
    const result = await waitForProjectExecutionEvents(dispatch.projectId, {
      dispatchId: dispatch.dispatchId,
      afterSequence: Number(url.searchParams.get("afterSequence") || 0),
      waitMs: Number(url.searchParams.get("waitMs") || 0),
      limit: Number(url.searchParams.get("limit") || 120)
    });
    json(res, 200, result);
    return;
  }

  // 「这次派发用了什么规则」：只读，按派发判租户作用域（与上面派发事件路由同一道 requireRead）。
  // 回的是契约记录的治理件（角色技能/生效规则件/规则集摘要/禁止动作/验收要求），不是一份人写的规则标题表。
  const dispatchContractMatch = url.pathname.match(/^\/api\/agent-dispatches\/([^/]+)\/contract-summary$/);
  if (req.method === "GET" && dispatchContractMatch) {
    const dispatch = state.agentDispatches.find((item) => item.dispatchId === dispatchContractMatch[1]);
    if (!dispatch) {
      const denial = missingRecordDenial(req, state, "dispatch_not_found", "permission_denied");
      return json(res, denial.status, denial.payload);
    }
    const reader = requireRead(req, state, taskGroupScope(state, dispatch.taskGroupId));
    if (reader.status) return json(res, reader.status, reader.payload);
    json(res, 200, dispatchContractSummary(state, dispatch));
    return;
  }

  const taskGroupEventsMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/execution-events$/);
  if (req.method === "GET" && taskGroupEventsMatch) {
    const taskGroup = state.taskGroups.find((item) => item.id === taskGroupEventsMatch[1]);
    if (!taskGroup) {
      const denial = missingRecordDenial(req, state, "task_group_not_found", "permission_denied");
      return json(res, denial.status, denial.payload);
    }
    const reader = requireRead(req, state, taskGroupScope(state, taskGroup.id));
    if (reader.status) return json(res, reader.status, reader.payload);
    const result = await waitForProjectExecutionEvents(taskGroup.projectId, {
      taskGroupId: taskGroup.id,
      afterSequence: Number(url.searchParams.get("afterSequence") || 0),
      waitMs: Number(url.searchParams.get("waitMs") || 0),
      limit: Number(url.searchParams.get("limit") || 120)
    });
    json(res, 200, result);
    return;
  }

  const sessionEventsMatch = url.pathname.match(/^\/api\/work-sessions\/([^/]+)\/execution-events$/);
  if (req.method === "GET" && sessionEventsMatch) {
    const session = state.workSessions.find((item) => item.sessionId === sessionEventsMatch[1]);
    if (!session) {
      const denial = missingRecordDenial(req, state, "work_session_not_found", "permission_denied");
      return json(res, denial.status, denial.payload);
    }
    const reader = requireRead(req, state, taskGroupScope(state, session.taskGroupId));
    if (reader.status) return json(res, reader.status, reader.payload);
    const taskGroup = state.taskGroups.find((item) => item.id === session.taskGroupId);
    const result = await waitForProjectExecutionEvents(taskGroup?.projectId || session.projectId || "prj_control_plane", {
      sessionId: session.sessionId,
      afterSequence: Number(url.searchParams.get("afterSequence") || 0),
      waitMs: Number(url.searchParams.get("waitMs") || 0),
      limit: Number(url.searchParams.get("limit") || 120)
    });
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/bootstrap/init") {
    const guard = beginGuardedWrite(req, state, "bootstrap_init", "RuntimeBootstrapProfile:runtime_local", {resourceType: "system", resourceId: "runtime_local"});
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    // 这个端点整体替换 state —— 全部组织、账号、项目、任务组、访问授权、审计链一次归零，
    // 且原先没有任何环境判据：生产环境同样可点，而按钮就在系统管理员的落地页上。
    // 它的用途是本地排障，那就让它只在"还没有真实租户数据"时无条件可用；
    // 一旦已经有了别的组织/项目，就必须显式带上要摧毁的规模，证明调用方知道自己在做什么。
    const liveOrgs = (state.organizations || []).filter((item) => item.orgId !== DEFAULT_ORGANIZATION_ID).length;
    const liveProjects = (state.projects || []).length;
    const liveTaskGroups = (state.taskGroups || []).length;
    // 只数【组织/项目/任务组】三个集合是不够的：一个团队完全可能就待在默认组织里、
    // 用种子自带的那一个项目和任务组干活，底下积累了几百个工作项、会话、派发与人工定稿记录。
    // 那时三个数都没超种子，hasTenantData 判成 false —— 不带任何确认就能把这一切抹掉。
    // 界面那一侧一直要求打字确认，所以这条路只在【绕过界面直接打接口】时打开（脚本、curl、误调用）。
    // 判据改成"有没有人在这里真干过活"：只取那些【干活才会长】的集合，
    // 登录/审计这类一开机就涨的不算，否则刚装完的本地排障也要凑确认串，等于把这条路封死。
    const bootstrapBaseline = readJsonFile(seedPath, "种子数据", SEED_NEXT_STEP);
    const countWorkItems = (snapshot) => (snapshot.taskGroups || [])
      .reduce((total, group) => total + (group.workItems || []).length, 0);
    const WORK_EVIDENCE = ["accounts", "workSessions", "agentDispatches", "humanConfirmationRequests",
      "artifacts", "repositoryOutputs", "agentRuntimeNodes", "checkpoints", "executionTopologies"];
    const grownCollections = WORK_EVIDENCE
      .filter((name) => (state[name] || []).length > (bootstrapBaseline[name] || []).length);
    const grownWorkItems = countWorkItems(state) > countWorkItems(bootstrapBaseline);
    const hasTenantData = liveOrgs > 0 || liveProjects > 1 || liveTaskGroups > 1
      || grownCollections.length > 0 || grownWorkItems;
    if (hasTenantData && String(body.confirmDestroy || "") !== `${liveOrgs}/${liveProjects}/${liveTaskGroups}`) {
      return json(res, 409, {
        error: "bootstrap_init_requires_explicit_confirmation",
        message: "运行态里已有真实数据，重新初始化会全部抹掉；请带上 confirmDestroy=<组织数>/<项目数>/<任务组数> 再调用",
        organizations: liveOrgs, projects: liveProjects, taskGroups: liveTaskGroups,
        // 三个数都没超种子、却仍被要求确认时，人会以为系统在无理取闹。说清是哪些东西在证明
        // 这里有人干过活 —— 否则他只会反复重试那个"0/1/1"的串。
        ...(grownCollections.length || grownWorkItems
          ? {grownBeyondSeed: [...grownCollections, ...(grownWorkItems ? ["workItems"] : [])]}
          : {})
      });
    }
    const seed = structuredClone(bootstrapBaseline);
    seed.__loadedStateVersion = state.__loadedStateVersion;
    // 【重置内容，但版本号只能往前走】。种子里的 stateVersion 是 2，而运行态早就推过它 ——
    // 存储层有一道"写入必须推进 stateVersion"的守卫（它防的是并发写静默覆盖），
    // 于是这条重置路由在【任何推进过的运行态上】都会被那道守卫拒掉，回一句通用的 500 server_error。
    // 也就是说控制台上那个"重新初始化运行态"（本地排障的最后一招）一直是坏的，
    // 而它坏的样子是"服务器故障"，没有任何地方说得出真正的原因。
    // 内容回到种子与版本号继续前进不矛盾：重置是一次新的写入，不是回到过去。
    seed.stateVersion = Number(state.stateVersion || 0) + 1;
    seed.runtime.updatedAt = now();
    seed.runtime.executionProfile = executionProfile;
    ensureRuntimeCollections(seed, {root: repositoryRoot, runtimeDir, endpoint: localEndpoint(), executionProfile});
    finishGuardedWrite(seed, guard, 200, {profileId: "runtime_local"});
    audit(seed, "system", "bootstrap_init", "RuntimeBootstrapProfile:runtime_local");
    // 唯一一条【合法】让项目变少的路：重置回种子。存储层默认拒绝丢弃项目分片，这里显式开口。
    writeState(seed, {allowProjectShardRemoval: true});
    json(res, 200, seed);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/orchestrator/run") {
    const guard = beginGuardedWrite(req, state, "orchestrator_run", `TaskGroup:${body.taskGroupId || "all"}`, body.taskGroupId ? taskGroupScope(state, body.taskGroupId) : {resourceType: "project", resourceId: body.projectId || "prj_control_plane"});
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    // 对账要挂在【每一条推进路径】上，不只是后台那一拍。后台那一拍是可以被关掉的
    //（AIMAC_ORCHESTRATOR_INTERVAL_MS=0 是文档里写明的开关），关掉之后系统靠人按这个按钮推进 ——
    // 而此前这条路只推进、不对账：死掉的节点永远显示在线、running 派发的认领永不过期、
    // 吊销截止期永不了结、注册重放里的明文令牌永不抹除。实测：节点静默 65 秒（宽限期 60 秒）、
    // 手动跑两拍，它仍然 online、在线数仍是 1。
    // 与后台那一拍同因：一个只在系统健康时才运行的对账，恰好在最需要它的时候不运行。
    recycleExpiredClaims(state);
    const result = runAutonomousCycle(state, {root: repositoryRoot, runtimeDir, endpoint: publicEndpoint(req), mode: body.mode || "all", taskGroupId: body.taskGroupId, autoSyncSkills: body.autoSyncSkills !== false});
    audit(state, guard.actor, "orchestrator_run", `TaskGroup:${body.taskGroupId || "all"}`);
    finishGuardedWrite(state, guard, 200, result);
    writeState(state);
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/verification/agent-runtime/run") {
    if (executionProfile !== "verification") {
      json(res, 409, {error: "server_side_agent_execution_forbidden", required: "register an Agent Runtime and let it claim the dispatch through /api/agent/v1/dispatches/next"});
      return;
    }
    const guard = beginGuardedWrite(req, state, "agent_runtime_worker_run", `TaskGroup:${body.taskGroupId || "all"}`, body.taskGroupId ? taskGroupScope(state, body.taskGroupId) : {resourceType: "project", resourceId: body.projectId || "prj_control_plane"});
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const result = runAgentRuntimeWorker(state, {
      root: repositoryRoot,
      repositoryRoot,
      runtimeDir,
      endpoint: localEndpoint(),
      taskGroupId: body.taskGroupId,
      maxJobs: body.maxJobs || 1,
      allowDeterministicLocalWorker: body.allowDeterministicLocalWorker === true && process.env.AIMAC_ALLOW_LOCAL_DETERMINISTIC_WORKER === "true"
    });
    audit(state, guard.actor, "agent_runtime_worker_run", `TaskGroup:${body.taskGroupId || "all"}`);
    finishGuardedWrite(state, guard, 200, result);
    writeState(state);
    json(res, 200, result);
    return;
  }

  const closeComputeMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/close-barrier\/compute$/);
  if (req.method === "POST" && closeComputeMatch) {
    const guard = beginGuardedWrite(req, state, "task_group_close_barrier_compute", `TaskGroup:${closeComputeMatch[1]}`, taskGroupScope(state, closeComputeMatch[1]));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const readiness = computeCompletionReadiness(state, closeComputeMatch[1], {root: repositoryRoot});
    let closeBarrier;
    try {
      // actor 透传给 core：真正落闸（mutate:true）时 core 会校验必须是真人账号。
      closeBarrier = computeCloseBarrier(state, closeComputeMatch[1], {root: repositoryRoot, mutate: body.mutate === true, actor: guard.actor});
    } catch (error) {
      return json(res, error.status || 500, {error: error.message});
    }
    // 已关闭的任务组被再次关闭时回 409，与其余处置路径同规：回 200 会让第二个人以为是他关的，
    // 而对象上留下的定稿归属其实是第一个人的（现在也不再被覆盖）。
    if (body.mutate === true && closeBarrier.alreadyClosed) {
      return json(res, 409, {error: "task_group_already_closed",
        closedBy: closeBarrier.closedBy, closedAt: closeBarrier.closedAt});
    }
    // A real close mutates the task group to terminal; refresh the project/task-group progress rollup so
    // the overview reflects it immediately instead of lagging until the next autonomy cycle.
    if (body.mutate === true && closeBarrier.satisfied) computeProgressSnapshots(state);
    const result = {readiness, closeBarrier};
    audit(state, guard.actor, "task_group_close_barrier_compute", `TaskGroup:${closeComputeMatch[1]}`);
    finishGuardedWrite(state, guard, 200, result);
    writeState(state);
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/checkpoints") {
    // 【检查点只能走 agent 网关】。这条 REST 入口通向同一个 acceptAgentCheckpoint，
    // 但少了网关那两样：节点凭据鉴权、以及"这个派发是不是你认领的"那道 claim 围栏 ——
    // 于是持 agent-runtime 服务账号的调用方可以为【别的节点认领的派发】提交检查点。
    // MCP 那扇同形的门早就明确挡回了（工具白名单 + 决策点各一道），而这一扇一直开着：
    // 同一件事两条路只关了一条，是本仓反复出现的形态。
    // 全仓没有任何调用方走它（agent 运行时用的是 /api/agent/v1/dispatches/:id/checkpoint），
    // 所以关掉它不影响任何现有流程；留着才是把围栏做成可绕过的。
    // 【先判权、再回"走网关"】。把整条路由关在守卫之前，会顺手把「谁允许提检查点」那道分类
    // 判定变成不可观测的（真人提交本该 403 principal_not_allowed_for_action，而不是与
    // agent 服务账号拿到同一句话）—— 关一扇门不该顺手拆掉门上的锁。
    const guard = beginGuardedWrite(req, state, "checkpoint_submit",
      `Checkpoint:${body.taskGroupId || "unknown"}:${body.workId || "unknown"}`, taskGroupScope(state, body.taskGroupId));
    if (guard.status) return json(res, guard.status, guard.payload);
    // 该走哪条路直接写进 message：单列一个 gatewayPath 字段的话，控制台一处都不读它，
    // 而"拒绝报文里的字段必须有人看"是本仓的一道门（出错那一刻人最需要它）。
    audit(state, guard.actor, "checkpoint_rejected", `Checkpoint:${body.taskGroupId || "unknown"}:${body.workId || "unknown"}`,
      "checkpoint_must_use_agent_gateway");
    finishGuardedWrite(state, guard, 409, {error: "checkpoint_must_use_agent_gateway"});
    writeState(state);
    return json(res, 409, {error: "checkpoint_must_use_agent_gateway",
      message: "检查点必须由认领该派发的那个节点、用它自己的节点凭据经 agent 网关提交"
        + "（POST /api/agent/v1/dispatches/:dispatchId/checkpoint）："
        + "这条通道少了节点鉴权与认领围栏，无法证明提交者就是干这件活的那一个"});
  }

  const skillSyncMatch = url.pathname.match(/^\/api\/skill-sources\/([^/]+)\/sync$/);
  if (req.method === "POST" && skillSyncMatch) {
    const guard = beginGuardedWrite(req, state, "skill_source_sync", `AgentSkillSource:${skillSyncMatch[1]}`, {resourceType: "system", resourceId: "skill_registry"});
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    let result;
    try {
      result = syncSkillSource(state, skillSyncMatch[1], {root, runtimeDir});
    } catch (error) {
      // 【失败也要落盘】。syncSkillSource 在抛之前已经把 source.status（stale / quarantined）与
      // lastSyncError 写进状态 —— 而这条路上一抛，本请求那份状态就丢了：面板照旧显示上一次的状态，
      // 人看到的只是一条一闪而过的 500「server_error」，连词表里那句「该源已标记为 stale」都是假话。
      // 自治周期那条路（catch 之后接着写）一直是对的，按钮这条路漏了。
      const status = skillSourceFailureStatus(error);
      if (!status) throw error;
      const source = (state.skillSources || []).find((item) => item.sourceId === skillSyncMatch[1]);
      const payload = {error: String(error.message).split(":")[0], sourceId: skillSyncMatch[1],
        sourceStatus: source?.status || null, lastSyncError: source?.lastSyncError || null,
        message: String(error.message).slice(0, 400)};
      audit(state, guard.actor, "skill_source_sync", `AgentSkillSource:${skillSyncMatch[1]}`, payload.error);
      finishGuardedWrite(state, guard, status, payload);
      writeState(state);
      json(res, status, payload);
      return;
    }
    audit(state, guard.actor, "skill_source_sync", `AgentSkillSource:${skillSyncMatch[1]}`);
    finishGuardedWrite(state, guard, 200, result);
    writeState(state);
    json(res, 200, result);
    return;
  }

  // 退役：接进来的源此前拿不下去（状态机里 retired 一直没有生产者）。配错地址或换了仓库时，
  // 人只能眼看着自治周期一遍遍重试它。
  const skillRetireMatch = url.pathname.match(/^\/api\/skill-sources\/([^/]+)\/retire$/);
  if (req.method === "POST" && skillRetireMatch) {
    const guard = beginGuardedWrite(req, state, "skill_source_retire", `AgentSkillSource:${skillRetireMatch[1]}`,
      {resourceType: "system", resourceId: "*"});
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    // 不自己接异常：与同步那条一样交给外层统一处理（它认 error.status，404/409 会如实回给人）。
    const result = retireSkillSource(state, skillRetireMatch[1]);
    audit(state, guard.actor, "skill_source_retire", `AgentSkillSource:${skillRetireMatch[1]}`);
    finishGuardedWrite(state, guard, 200, result);
    writeState(state);
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/model-capabilities") {
    const guard = beginGuardedWrite(req, state, "model_capability_register", `ModelCapabilityProfile:${body.providerClass || "custom"}`, {resourceType: "system", resourceId: "model_registry"});
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    // 【只取规范认识的字段】。原先是 `...body` —— 请求体整个摊进持久记录，
    // 而规范是 additionalProperties:false：多带一个字段，落下来的记录就违反它自己声明的规范，
    // 而这件事只有在 e2e 恰好造出那种记录时才会被发现。字段清单与规范双向核对（契约门）。
    const picked = Object.fromEntries(MODEL_CAPABILITY_FIELDS
      .filter((field) => body[field] !== undefined).map((field) => [field, body[field]]));
    // 观测时间是【调用方自填的】，而视图窗口按时间挑「最新的那一批」——
    // 一个填不出日期的字符串（或 "zzz" 这种）会按字典序排到最新，永久占住窗口。认不出就拒。
    const observedAt = normalizedExpiry(body.observedAt);
    if (observedAt === false) {
      json(res, 400, {error: "model_capability_observed_at_invalid", received: String(body.observedAt).slice(0, 60)});
      return;
    }
    // 模板按 providerClass 取（含默认的 "custom"）。认不出的 providerClass 没有模板 —— 此时 profile 只剩 body
    // 那几个字段，缺 qualitySignals/limits/costSignals 就会让 rankModel 读到 undefined 子字段、算出 NaN 分
    // （selectModel 的排序比较器返回 NaN＝排序失序、甚至崩溃），而且这条无效记录违反 model-capability 规范。
    // 认不出就拒，不静默存一条会毒化模型选择的残缺记录。
    const template = defaultModelCapabilities(now()).find((item) => item.providerClass === (body.providerClass || "custom"));
    if (!template) {
      json(res, 400, {error: "model_capability_provider_class_unknown", received: String(body.providerClass).slice(0, 60),
        supported: providerClasses});
      return;
    }
    const profile = {
      ...template,
      ...picked,
      // 评分相关的嵌套对象要【深合并】：body 只给了部分（如只 reasoningScore）时，上面的浅展开会把模板里
      // 完整的那份整个换成残缺对象 —— rankModel 读到 undefined 子字段算出 NaN 分。逐个并回模板默认值。
      qualitySignals: {...template.qualitySignals, ...picked.qualitySignals},
      limits: {...template.limits, ...picked.limits},
      costSignals: {...template.costSignals, ...picked.costSignals},
      schemaVersion: "model-capability/v1",
      capabilityDigest: body.capabilityDigest || digestOf(body),
      observedAt: observedAt || now()
    };
    state.modelCapabilities = state.modelCapabilities.filter((item) => !(item.providerId === profile.providerId && item.modelId === profile.modelId));
    state.modelCapabilities.unshift(profile);
    audit(state, guard.actor, "model_capability_register", `ModelCapabilityProfile:${profile.providerId}/${profile.modelId}`);
    finishGuardedWrite(state, guard, 201, profile);
    writeState(state);
    json(res, 201, profile);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/model-selection/decide") {
    const guard = beginGuardedWrite(req, state, "model_selection_decide", `WorkItem:${body.workItemId || "unknown"}`, taskGroupScope(state, body.taskGroupId));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const decision = selectModel(state, {...body, policyDecisionRef: guard.policyDecision.id, auditRef: `audit:${guard.idempotencyKey}`});
    audit(state, guard.actor, "model_selection_decide", `ModelSelectionDecision:${decision.decisionId}`);
    finishGuardedWrite(state, guard, 201, decision);
    writeState(state);
    json(res, 201, decision);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session-placement/decide") {
    const guard = beginGuardedWrite(req, state, "session_placement_decide", `WorkItem:${body.workItemId || "unknown"}`, taskGroupScope(state, body.taskGroupId));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const decision = decideSessionPlacement(state, {...body, auditRef: `audit:${guard.idempotencyKey}`});
    audit(state, guard.actor, "session_placement_decide", `SessionPlacementDecision:${decision.decisionId}`);
    finishGuardedWrite(state, guard, 201, decision);
    writeState(state);
    json(res, 201, decision);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/runtime-issues") {
    const guard = beginGuardedWrite(req, state, "runtime_issue_collect", `RuntimeIssuePattern:${body.issueFingerprint || "new"}`, body.taskGroupId ? taskGroupScope(state, body.taskGroupId) : {resourceType: "project", resourceId: body.projectId || "prj_control_plane"});
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const issue = collectRuntimeIssue(state, body);
    const issueRef = issue.patternId ? `RuntimeIssuePattern:${issue.patternId}` : `RuntimeIssueSample:${issue.sampleId}`;
    audit(state, guard.actor, "runtime_issue_collect", issueRef);
    finishGuardedWrite(state, guard, 201, issue);
    writeState(state);
    json(res, 201, issue);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/role-skill-overlays") {
    // Guard on the SAME task group the overlay will be stamped with (registerRoleSkillOverlay stamps
    // taskGroupId when scope === "task_group" OR a taskGroupId is supplied, defaulting to tg_runtime_management),
    // so a task_group-scoped overlay with no explicit taskGroupId cannot slip through a project-only guard and
    // inject into the default tenant's view.
    const overlayScopesTaskGroup = body.scope === "task_group" || Boolean(body.taskGroupId);
    const overlayGuardScope = overlayScopesTaskGroup
      ? taskGroupScope(state, body.taskGroupId)
      : projectScope(body.projectId || "prj_control_plane");
    const guard = beginGuardedWrite(req, state, "role_skill_overlay_create", `AgentRoleSkill:${body.roleSkillRef || "default"}`, overlayGuardScope);
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const overlay = registerRoleSkillOverlay(state, body);
    audit(state, guard.actor, "role_skill_overlay_create", `RoleSkillOverlay:${overlay.overlayId}`);
    finishGuardedWrite(state, guard, 201, overlay);
    writeState(state);
    json(res, 201, overlay);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/projects") {
    const authenticated = accountFromRequest(req, state);
    if (!authenticated) {
      json(res, 401, {error: "auth_required"});
      return;
    }
    if (!req.headers["idempotency-key"]) {
      json(res, 428, {error: "idempotency_key_required"});
      return;
    }
    const authenticatedAccountId = accountIdOf(authenticated.account);
    const requestedOwnerAccountId = String(body.ownerAccountId || authenticatedAccountId || "").trim() || authenticatedAccountId;
    if (requestedOwnerAccountId !== authenticatedAccountId && !isSystemAccount(authenticated.account)) {
      json(res, 403, {error: "project_owner_assignment_denied"});
      return;
    }
    const ownerAccount = state.accounts.find((item) => accountIdOf(item) === requestedOwnerAccountId && ["active", "invited"].includes(item.status));
    if (!ownerAccount) {
      json(res, 404, {error: "owner_account_not_found"});
      return;
    }
    const guard = beginGuardedWrite(req, state, "project_create", "Project:new", {resourceType: "project", resourceId: "new"});
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const projectOrgId = ownerAccount.organizationId || authenticated.account.organizationId || DEFAULT_ORGANIZATION_ID;
    const projectQuota = organizationQuotaCheck(state, projectOrgId, "projects");
    if (!projectQuota.allowed) {
      json(res, 409, {error: projectQuota.error, quota: projectQuota.quota, usage: projectQuota.usage, kind: projectQuota.kind});
      return;
    }
    const id = createId("prj");
    const ownerAccountId = requestedOwnerAccountId;
    state.projects.push({
      schemaVersion: "project/v1",
      id,
      organizationId: projectOrgId,
      name: assertHumanTextWithinLimit(body.name || "Untitled Project", "project_name", 200),
      status: "active",
      ownerAccountId,
      members: [{accountId: ownerAccountId, role: "project_owner"}],
      progress: {percent: 0, phase: "intake", health: "ok", openTaskGroups: 0, blockedItems: 0, updatedAt: now()},
      // 三个建项目的入口里，此前只有 MCP 那个写时间戳 —— 另两个建出来的项目
      // 「什么时候建的」系统整个答不上来（顶层 updatedAt 也只在后来被改动时才冒出来）。
      createdAt: now(),
      updatedAt: now()
    });
    const project = state.projects.at(-1);
    const ownerGrant = ensureProjectOwnerGrant(state, project, ownerAccountId, guard.policyDecision.id, `audit:${guard.idempotencyKey}`);
    computeProgressSnapshots(state);
    audit(state, guard.actor, "project_create", `Project:${id}`);
    const result = {id, ownerGrant};
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/task-groups") {
    const authenticated = accountFromRequest(req, state);
    if (!authenticated) {
      json(res, 401, {error: "auth_required"});
      return;
    }
    if (!req.headers["idempotency-key"]) {
      json(res, 428, {error: "idempotency_key_required"});
      return;
    }
    const projectId = String(body.projectId || "").trim();
    if (!projectId) {
      json(res, 400, {error: "project_id_required"});
      return;
    }
    if (!state.projects.some((item) => item.id === projectId)) {
      json(res, 404, {error: "project_not_found"});
      return;
    }
    const guard = beginGuardedWrite(req, state, "task_group_create", `Project:${projectId}`, projectScope(projectId));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const taskGroupProject = state.projects.find((item) => item.id === projectId);
    const taskGroupQuota = organizationQuotaCheck(state, taskGroupProject?.organizationId || DEFAULT_ORGANIZATION_ID, "taskGroups");
    if (!taskGroupQuota.allowed) {
      json(res, 409, {error: taskGroupQuota.error, quota: taskGroupQuota.quota, usage: taskGroupQuota.usage, kind: taskGroupQuota.kind});
      return;
    }
    const result = createTaskGroupRecord(state, body, {auditRef: `audit:${guard.idempotencyKey}`});
    if (result.ok === false) {
      // 拒绝报文要把记录构造函数算好的细节一起带出去（unknownRoles / supported / 归档原因）：
      // 原先只转发 error，人拿到一个码却不知道哪个角色错、该填什么。error 写在展开之后，谁也盖不掉它。
      const {ok: _ok, status: _status, ...details} = result;
      json(res, result.status || 409, {...details, error: result.error});
      return;
    }
    audit(state, guard.actor, "task_group_create", `TaskGroup:${result.taskGroup.id}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  const workItemCreateMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/work-items$/);
  if (req.method === "POST" && workItemCreateMatch) {
    // 空 body 原先会造出一个标题叫「AI-native work item」的真工作项：它进任务组、进进度分母、
    // 要人去处置。工作项是干活的单位，标题必须由人给。
    if (requireBodyFields(res, body, ["title"], "work_item_title_required")) return;
    const authenticated = accountFromRequest(req, state);
    if (!authenticated) {
      json(res, 401, {error: "auth_required"});
      return;
    }
    if (!req.headers["idempotency-key"]) {
      json(res, 428, {error: "idempotency_key_required"});
      return;
    }
    const guard = beginGuardedWrite(req, state, "task_group_work_item_create", `TaskGroup:${workItemCreateMatch[1]}`, taskGroupScope(state, workItemCreateMatch[1]));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const taskGroup = state.taskGroups.find((item) => item.id === workItemCreateMatch[1]);
    if (!taskGroup) {
      json(res, 404, {error: "task_group_not_found"});
      return;
    }
    const result = createWorkItemRecord(state, taskGroup.id, body, {auditRef: `audit:${guard.idempotencyKey}`});
    if (result.ok === false) {
      json(res, refusalStatus(result, 409), refusalPayload(result));
      return;
    }
    audit(state, guard.actor, "task_group_work_item_create", `WorkItem:${taskGroup.id}:${result.workItem.id}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  const memberMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/members$/);
  if (req.method === "POST" && memberMatch) {
    if (projectHiddenFromActor(req, state, memberMatch[1])) return json(res, 403, {error: "permission_denied"});
    const authenticated = accountFromRequest(req, state);
    if (!authenticated) {
      json(res, 401, {error: "auth_required"});
      return;
    }
    if (!req.headers["idempotency-key"]) {
      json(res, 428, {error: "idempotency_key_required"});
      return;
    }
    const project = state.projects.find((item) => item.id === memberMatch[1]);
    if (!project) {
      const denial = missingProjectDenial(authenticated.account);
      json(res, denial.status, denial.payload);
      return;
    }
    const accountId = body.accountId;
    const inviteeAccount = state.accounts.find((account) => accountIdOf(account) === accountId);
    if (!inviteeAccount) {
      json(res, 400, {error: "account_not_found"});
      return;
    }
  // 无组织归属的账号（历史上经 MCP identity-mcp.account_invite 创建的那批）会让这条判定整个跳过 ——
  // `X.organizationId && ...` 遇到 undefined 就当作"无从比较"放行。跨租户边界必须 fail closed：
  // 归属不明就按"不属于本组织"处理，而不是按"属于任何组织"处理。
    if ((inviteeAccount.organizationId || DEFAULT_ORGANIZATION_ID) !== (project.organizationId || DEFAULT_ORGANIZATION_ID)) {
      json(res, 400, {error: "cross_org_member_not_allowed"});
      return;
    }
    // 归档是项目的终结态：往一个已归档的项目里发成员授权，授权会真的落下来，
    // 而那个项目已经不在任何人的视野里 —— 人以为自己把人加进去了。与建任务组同规。
    const archivedForGrant = projectArchivedRefusal(project, "不能再往里发成员授权");
    if (archivedForGrant) return json(res, 409, archivedForGrant);
    const guard = beginGuardedWrite(req, state, "project_member_grant", `Project:${project.id}`, projectScope(project.id));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const sanitizedGrant = sanitizeGrantRequest(state, guard.actor, {...body, resourceType: "project", resourceId: project.id}, projectScope(project.id));
    if (!sanitizedGrant.ok) {
      json(res, sanitizedGrant.status, {error: sanitizedGrant.error,
        // 拒绝报文要带上合法取值 —— 这两处此前只转发 error 和 permissions，
        // 于是「认不出这个作用域类型」拒了，人还是不知道该填什么。
        ...(sanitizedGrant.permissions ? {permissions: sanitizedGrant.permissions} : {}),
        ...(sanitizedGrant.unknownPermissions ? {unknownPermissions: sanitizedGrant.unknownPermissions} : {}),
        ...(sanitizedGrant.supported ? {supported: sanitizedGrant.supported} : {})});
      return;
    }
    project.members = project.members.filter((member) => member.accountId !== accountId);
    project.members.push({accountId, role: sanitizedGrant.role});
    state.accessGrants.unshift({
      schemaVersion: "access-control-grant/v1",
      grantId: createId("grant"),
      subjectRef: {subjectType: "account", subjectId: accountId},
      resource: sanitizedGrant.resource,
      role: sanitizedGrant.role,
      permissions: sanitizedGrant.permissions,
      status: "active",
      policyDecisionRef: guard.policyDecision.id,
      auditRef: `audit:${guard.idempotencyKey}`,
      createdAt: now(),
      updatedAt: now()
    });
    audit(state, guard.actor, "project_member_grant", `Project:${project.id}`);
    finishGuardedWrite(state, guard, 200, project);
    writeState(state);
    json(res, 200, project);
    return;
  }

  const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/(?:activate|activation)$/);
  if (req.method === "POST" && agentMatch) {
    if (!requireAuthenticated(req, state, res)) return;
    const agent = state.agents.find((item) => item.id === agentMatch[1]);
    if (!agent) {
      const denial = missingRecordDenial(req, state, "agent_not_found", "policy_denied");
      json(res, denial.status, denial.payload);
      return;
    }
    const guard = beginGuardedWrite(req, state, "agent_activation_update", `AgentNode:${agent.id}`,
      agent.projectId ? projectScope(agent.projectId) : {resourceType: "organization", resourceId: agent.organizationId || DEFAULT_ORGANIZATION_ID});
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    // 同一形状：空 body 原先等于"启用"。路径叫 activate，但停用走的也是这条（active:false），
    // 所以"什么都不说"不能替调用方选一边。
    if (typeof body.active !== "boolean") {
      return json(res, 400, {error: "agent_activation_flag_required", supported: [true, false],
        message: "启用/停用智能体必须显式给出 active（true / false）—— 缺省不会被当作启用"});
    }
    agent.status = body.active === false ? "inactive" : "active";
    agent.capacity = agent.status === "active" ? "ready" : "standby";
    audit(state, guard.actor, "agent_activation_update", `AgentNode:${agent.id}`);
    finishGuardedWrite(state, guard, 200, agent);
    writeState(state);
    json(res, 200, agent);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agents") {
    if (requireBodyFields(res, body, ["role"], "agent_role_required")) return;
    const authenticated = accountFromRequest(req, state);
    if (!authenticated) return json(res, 401, {error: "auth_required"});
    const requestedProjectId = String(body.projectId || "").trim();
    const requestedProject = requestedProjectId ? state.projects.find((item) => item.id === requestedProjectId) : null;
    if (requestedProjectId && !requestedProject) {
      // 查无此项目与"存在但你看不见"必须同一个答案（否则挨个试 projectId 就能枚举别的租户的项目）；
      // 系统账号例外拿准确的 404。与本文件别处的 missingRecordDenial 同一条不变式。
      const denial = missingRecordDenial(req, state, "project_not_found", "permission_denied");
      return json(res, denial.status, denial.payload);
    }

    const agentGuardScope = requestedProjectId
      ? projectScope(requestedProjectId)
      : {resourceType: "organization", resourceId: authenticated.account.organizationId || DEFAULT_ORGANIZATION_ID};
    const guard = beginGuardedWrite(req, state, "agent_create", `AgentNode:${body.role || "custom"}`, agentGuardScope);
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    // 归档是项目的终结态（没有"恢复归档"这条路），而建一个逻辑智能体是【往里接入新的干活能力】——
    // 与签发入网令牌同族。落进去之后它绑在一个不能再建任何工作的项目上，谁也不会报错。
    // 哪些动作在归档后仍然允许，逐条登记在 contract-check 的 ARCHIVED_PROJECT_WRITE_POLICY 里。
    // 【角色要在已登记的执行角色里】。原先任意字符串照收：写成 reviwer 的智能体，派工时 agentForRole 找不到同名角色
    // 就退回「随便哪个在跑的」—— 人建的那个永远不会被选中，而谁也没报错。与任务组/入网令牌两处同一份词表。
    const unknownAgentRoles = unknownOwnerRoles([String(body.role || "")]);
    if (unknownAgentRoles.length) {
      return json(res, 400, {error: "agent_role_not_registered", unknownRoles: unknownAgentRoles, supported: REGISTERED_OWNER_ROLES,
        message: `智能体角色「${unknownAgentRoles.join("、")}」不在已登记的执行角色里 —— 可用：${REGISTERED_OWNER_ROLES.join("、")}`});
    }
    const agentProject = requestedProject || (requestedProjectId ? null : undefined);
    if (agentProject?.status === "archived") {
      return json(res, 409, {error: "project_archived",
        message: "该项目已归档，不能再往里接入智能体。要继续这条线，请先另建一个项目"});
    }
    // 此前这两个字段是【请求体直接落库】：status 想写什么写什么（界面的启停按钮只认
    // active/inactive，别的取值会让那个按钮永远显示「启用」）；trustScore 走 Number(任意输入)，
    // `Number("高")` 得到 NaN，序列化成 null 存进去，而 NaN 参与的比较两个方向都是 false。
    // 命令接口要拒绝，不要猜。
    const agentStatus = body.status === undefined || body.status === null || body.status === ""
      ? "active"
      : body.status;
    if (!AGENT_STATUSES.includes(agentStatus)) {
      return json(res, 400, {error: "agent_status_unknown", status: String(body.status).slice(0, 60), supported: AGENT_STATUSES});
    }
    const trustScore = body.trustScore === undefined || body.trustScore === null || body.trustScore === ""
      ? 0.85
      : Number(body.trustScore);
    if (!Number.isFinite(trustScore) || trustScore < 0 || trustScore > 1) {
      // 报文里不放控制台不读的字段：出错那一刻人看到的是 message，
      // 单独带一个 trustScore 键等于把最关键的那个值藏在人看不见的地方。
      return json(res, 400, {error: "agent_trust_score_invalid",
        message: `信任分必须是 0 到 1 之间的数（收到的是「${String(body.trustScore).slice(0, 60)}」）`});
    }
    const agent = {
      schemaVersion: "agent/v1",
      id: createId("agent"),
      name: assertHumanTextWithinLimit(body.name || `${body.role || "custom"} Agent`, "agent_name", 200),
      role: body.role || "custom",
      model: body.model || "auto_best",
      status: agentStatus,
      trustScore,
      capacity: agentStatus === "inactive" ? "standby" : "ready",
      projectId: requestedProjectId || undefined,
      organizationId: (requestedProjectId ? requestedProject?.organizationId : null)
        || authenticated.account.organizationId
        || DEFAULT_ORGANIZATION_ID,
      roleSkillRef: body.roleSkillRef,
      createdAt: now(),
      updatedAt: now()
    };
    state.agents.push(agent);
    audit(state, guard.actor, "agent_create", `AgentNode:${agent.id}`);
    finishGuardedWrite(state, guard, 201, agent);
    writeState(state);
    json(res, 201, agent);
    return;
  }

  const taskGroupLanguageMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/language-policy$/);
  if (req.method === "POST" && taskGroupLanguageMatch) {
    // 空 body 原先会把这个组的统一语言【设成默认值】—— 而语言策略是规则层的东西，
    // 它会进之后每一次派发的指令包。改它必须说清改成哪一种。
    if (requireBodyFields(res, body, ["languageTag"], "language_tag_required")) return;
    const taskGroupId = taskGroupLanguageMatch[1];
    const guard = beginGuardedWrite(req, state, "task_group_language_policy_update", `TaskGroup:${taskGroupId}`, taskGroupScope(state, taskGroupId));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const taskGroup = state.taskGroups.find((item) => item.id === taskGroupId);
    if (!taskGroup) {
      json(res, 404, {error: "task_group_not_found"});
      return;
    }
    const result = updateTaskGroupLanguagePolicy(state, taskGroup.id, body, {actor: guard.actor, idempotencyKey: guard.idempotencyKey});
    // 同上：语言策略变更是真人专属动作，审计要记下是谁改的。
    audit(state, guard.actor, "task_group_language_policy_update", `TaskGroup:${taskGroup.id}`);
    finishGuardedWrite(state, guard, 200, result);
    writeState(state);
    json(res, 200, result);
    return;
  }

  const taskGroupMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/control$/);
  if (req.method === "POST" && taskGroupMatch) {
    if (!requireAuthenticated(req, state, res)) return;
    const taskGroup = state.taskGroups.find((item) => item.id === taskGroupMatch[1]);
    if (!taskGroup) {
      const denial = missingRecordDenial(req, state, "task_group_not_found", "policy_denied");
      json(res, denial.status, denial.payload);
      return;
    }
    // 动作名此前直接由请求体拼成守卫动作名与审计动作名，而权限映射对 task_group_* 一律放行
    // task_group:control —— 实测 {"action":"approved_by_security_review"} 返回 200，并原样落进
    // 审计日志。问责记录成了谁都能写的留言板，而它恰恰是事后唯一的凭据。
    // 认不出来的动作也不能当成"照默认那个跑"：人得到 200 却什么都没发生。
    const action = String(body.action || "recompute_readiness");
    if (!TASK_GROUP_CONTROL_ACTIONS.includes(action)) {
      json(res, 400, {error: "unsupported_task_group_control_action", supported: TASK_GROUP_CONTROL_ACTIONS});
      return;
    }
    // 终态的组不再接受运行控制 —— 与人工指令那条路共用同一份判断（两条路都能暂停/取消/改优先级）。
    const terminalRefusal = taskGroupRuntimeControlRefusal(taskGroup, action);
    if (terminalRefusal) {
      json(res, 409, terminalRefusal);
      return;
    }
    const guard = beginGuardedWrite(req, state, `task_group_${action}`, `TaskGroup:${taskGroup.id}`, taskGroupScope(state, taskGroup.id));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    // 【人停下来的，机器不许恢复】。取消是真人专属，但"撤销这个取消"此前走的是这条路：
    // resume 无条件把状态写回 active，而 task_group_resume 在【机器可做】那份清单里 ——
    // 于是人下了取消，AI 点一下恢复就把这个决定翻掉，记录上还留着「停因：人工指令取消」。
    // 判据是 pauseReason：只有人工指令那条路会写它（human_directive / human_directive_cancel）。
    if (action === "resume" && String(taskGroup.pauseReason || "").startsWith("human_directive")
      && !HUMAN_ACCOUNT_TYPES_FOR_ACTIONS.includes(accountFromRequest(req, state)?.account?.accountType)) {
      return json(res, 403, {error: "human_stop_requires_human_resume", pauseReason: taskGroup.pauseReason,
        message: "这个任务组是人停下来的（停因：" + taskGroup.pauseReason + "），只有真人能恢复它 ——"
          + "否则「取消归人」这条就等于没有：停下来之后随手一恢复就翻过去了"});
    }
    if (action === "pause") taskGroup.goalExecutionStatus = "active_paused_by_control";
    if (action === "resume") {
      taskGroup.goalExecutionStatus = "active";
      // 停因要一起清掉：不清的话屏幕上会同时写着「进行中」和「停因：人工指令取消」，
      // 而人只会信离数据最近的那一句。人工指令那条路的 resume 早就在清它，这一条是漏的。
      delete taskGroup.pauseReason;
    }
    if (action === "request_review") taskGroup.reviewState = "review_requested";
    if (action === "rebound_drift") taskGroup.health = "attention";
    const runtimeControl = applyTaskGroupRuntimeControl(state, taskGroup, action, {actor: guard.actor, idempotencyKey: guard.idempotencyKey});
    taskGroup.updatedAt = now();
    audit(state, guard.actor, `task_group_${action}`, `TaskGroup:${taskGroup.id}`);
    const payload = {taskGroup, runtimeControl};
    finishGuardedWrite(state, guard, 200, payload);
    writeState(state);
    json(res, 200, payload);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/accounts") {
    if (requireBodyFields(res, body, ["email"], "account_email_required")) return;
    const systemScopedInvite = requestedSystemAccountInvite(body);
    const guard = beginGuardedWrite(
      req,
      state,
      systemScopedInvite ? "system_account_invite" : "account_invite",
      "Account:new",
      systemScopedInvite ? {resourceType: "system", resourceId: "accounts"} : {resourceType: "project", resourceId: body.projectId || "prj_control_plane"}
    );
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    let invitedAccount;
    try {
      const inviteScope = systemScopedInvite
        ? {resourceType: "system", resourceId: "accounts"}
        : {resourceType: "project", resourceId: body.projectId || "prj_control_plane"};
      invitedAccount = normalizeInvitedAccount(body, systemScopedInvite, {
        state, actor: guard.actor, resourceScope: inviteScope,
        account: state.accounts.find((item) => accountIdOf(item) === guard.actor)
      });
    {
      const unknownRoles = unknownAccountRoles(invitedAccount.roles);
      if (unknownRoles.length) {
        return json(res, 400, {error: "account_role_unknown", unknownRoles: unknownRoles.slice(0, 10), supported: ACCOUNT_ROLES,
          message: "账号角色不在词表里：这些名字界面显示不出、判权时谁也不认（授权用的 project_member 之类是授权模板的角色，不是账号角色）"});
      }
    }
    } catch (error) {
      // 不可委派是授权判定，不是入参格式问题 —— 与 sanitizeGrantRequest 的 403 保持同一口径。
      const status = error.message === "invite_permission_not_delegable" ? 403 : 400;
      json(res, status, {error: error.message, ...(error.permissions ? {permissions: error.permissions} : {})});
      return;
    }
    // Email must be unique: /api/auth/login resolves an account by the FIRST email match, so a second
    // account sharing an explicit email would be unreachable via the email+token flow the invite
    // response hands back. Reject the collision (login-by-accountId is unaffected).
    if (body.email && (state.accounts || []).some((item) => sameEmail(item.email, body.email))) {
      json(res, 409, {error: "account_email_already_registered"});
      return;
    }
    const inviterAccount = state.accounts.find((item) => accountIdOf(item) === guard.actor);
    const inviteOrgId = invitedAccount.accountType === "system_admin"
      ? null
      : (inviterAccount?.organizationId || DEFAULT_ORGANIZATION_ID);
    if (inviteOrgId) {
      const inviteQuota = organizationQuotaCheck(state, inviteOrgId, "members");
      if (!inviteQuota.allowed) {
        json(res, 409, {error: inviteQuota.error, quota: inviteQuota.quota, usage: inviteQuota.usage, kind: inviteQuota.kind});
        return;
      }
    }
    const at = now();
    const accountId = createId("acct");
    const accountToken = `aimac_account_${randomBytes(32).toString("base64url")}`;
    const account = {
      schemaVersion: "account/v1",
      accountId,
      accountType: invitedAccount.accountType,
      ...(inviteOrgId ? {organizationId: inviteOrgId} : {}),
      displayName: body.displayName || "New User",
      email: body.email || `user-${Date.now()}@local`,
      status: "invited",
      roles: invitedAccount.roles,
      permissions: invitedAccount.permissions,
      authPolicy: {method: "invite_token", mfaRequired: false, passwordSet: false, sessionTtlSeconds: 3600},
      credentialDigest: digestOf(`account-invite:${accountId}:${accountToken}`),
      credentialIssuedAt: at,
      credentialExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      auditRef: `audit:${guard.idempotencyKey}`,
      createdAt: at,
      updatedAt: at
    };
    state.accounts.unshift(account);
    // 执行者记 guard.actor 而不是服务名：这是真人专属动作，事后要回答"是谁铸的这个账号"。
    // 动作名也必须是【实际发生的那个】—— 系统级邀请此前被记成普通的 account_invite，
    // 而两者的分量完全不同（一个铸的是系统级账号），审计里却分不出来。
    audit(state, guard.actor, systemScopedInvite ? "system_account_invite" : "account_invite", `Account:${account.accountId}`);
    const publicAccount = publicAccountRecord(account);
    finishGuardedWrite(state, guard, 201, publicAccount);
    writeState(state);
    json(res, 201, {
      account: publicAccount,
      accountToken,
      tokenExpiresAt: account.credentialExpiresAt,
      login: {email: account.email, tokenField: "accountToken"}
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/access-grants") {
    if (requireBodyFields(res, body, ["subjectId", "resourceId"], "access_grant_subject_and_resource_required")) return;
    const resourceScope = {resourceType: body.resourceType || "project", resourceId: body.resourceId || "prj_control_plane"};
    const guard = beginGuardedWrite(req, state, "access_grant_create", `${resourceScope.resourceType}:${resourceScope.resourceId}`, resourceScope);
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const sanitizedGrant = sanitizeGrantRequest(state, guard.actor, body, resourceScope);
    if (!sanitizedGrant.ok) {
      json(res, sanitizedGrant.status, {error: sanitizedGrant.error,
        // 拒绝报文要带上合法取值 —— 这两处此前只转发 error 和 permissions，
        // 于是「认不出这个作用域类型」拒了，人还是不知道该填什么。
        ...(sanitizedGrant.permissions ? {permissions: sanitizedGrant.permissions} : {}),
        ...(sanitizedGrant.unknownPermissions ? {unknownPermissions: sanitizedGrant.unknownPermissions} : {}),
        ...(sanitizedGrant.supported ? {supported: sanitizedGrant.supported} : {})});
      return;
    }
    const at = now();
    const grant = {
      schemaVersion: "access-control-grant/v1",
      grantId: createId("grant"),
      subjectRef: {subjectType: "account", subjectId: body.subjectId || "acct_workspace_owner"},
      resource: sanitizedGrant.resource,
      role: sanitizedGrant.role,
      permissions: sanitizedGrant.permissions,
      status: "active",
      policyDecisionRef: guard.policyDecision.id,
      auditRef: `audit:${guard.idempotencyKey}`,
      createdAt: at,
      updatedAt: at
    };
    state.accessGrants.unshift(grant);
    audit(state, guard.actor, "access_grant_create", `${grant.resource.resourceType}:${grant.resource.resourceId}`);
    finishGuardedWrite(state, guard, 201, grant);
    writeState(state);
    json(res, 201, grant);
    return;
  }

  const revokeGrantMatch = url.pathname.match(/^\/api\/access-grants\/([^/]+)\/revoke$/);
  if (req.method === "POST" && revokeGrantMatch) {
    if (!requireAuthenticated(req, state, res)) return;
    const grant = state.accessGrants.find((item) => item.grantId === revokeGrantMatch[1]);
    if (!grant) {
      const denial = missingRecordDenial(req, state, "access_grant_not_found", "policy_denied");
      json(res, denial.status, denial.payload);
      return;
    }
    const guard = beginGuardedWrite(req, state, "access_grant_revoke", `AccessControlGrant:${grant.grantId}`, grant.resource || {resourceType: grant.resourceType, resourceId: grant.resourceId});
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    grant.status = "revoked";
    grant.updatedAt = now();
    audit(state, guard.actor, "access_grant_revoke", `AccessControlGrant:${grant.grantId}`);
    finishGuardedWrite(state, guard, 200, grant);
    writeState(state);
    json(res, 200, grant);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/instruction-envelopes") {
    // 全仓 30 处 `|| "tg_runtime_management"` 里，只有这一处会把默认值【写进记录】：
    // 不点名任务组时，这份指令信封（发给 agent 的规则包）会挂到控制面自己的管理组上。
    // 判权作用域用那个默认是另一回事（对象还不存在时总得有个作用域），落账不行 —— 记到别人账上。
    if (requireBodyFields(res, body, ["taskGroupId"], "instruction_envelope_task_group_required")) return;
    const guard = beginGuardedWrite(req, state, "instruction_envelope_create", "InstructionEnvelope:new", taskGroupScope(state, body.taskGroupId));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const at = now();
    const envelopeTaskGroup = state.taskGroups.find((item) => item.id === (body.taskGroupId));
    const envelopeLanguagePolicy = normalizeTaskGroupLanguagePolicy(body.languagePolicy || envelopeTaskGroup?.languagePolicy || {});
    const envelopeLanguagePolicyDigest = digestOf(envelopeLanguagePolicy);
    const envelope = {
      schemaVersion: "instruction-envelope/v1",
      envelopeId: createId("env"),
      taskGroupId: body.taskGroupId,
      recipientRole: body.recipientRole || "orchestrator",
      effectiveInstructionPacketRef: body.effectiveInstructionPacketRef || "eip_runtime_management",
      formatVersion: "ai-native-instruction-envelope/v1",
      stablePrefixDigest: body.stablePrefixDigest || stableDigest("6"),
      digestRefs: [...new Set([...(body.digestRefs || ["ruleset:runtime:v1"]), `language-policy:${envelopeLanguagePolicyDigest}`])],
      languagePolicy: envelopeLanguagePolicy,
      languagePolicyDigest: envelopeLanguagePolicyDigest,
      // 与 MCP 那条孪生同规：本项目现行规范一律由服务端带上，调用方给的只能【追加】。
      // 原先是 `|| []` —— 不给就是空，也就是这份指令不受任何规范约束，而 agent 照着它干活。
      sharedDefinitionRefs: mergeSharedDefinitionRefs(
        activeSharedDefinitionRefs(state, {taskGroupId: body.taskGroupId}),
        body.sharedDefinitionRefs),
      cacheKey: body.cacheKey || `runtime:v1:${Date.now()}`,
      status: "cache_indexed",
      tokenBudget: body.tokenBudget || {maxInputTokens: 4096, targetDeltaTokens: Number(body.estimatedTokens || 320), maxOutputTokens: 1200},
      outputContractRef: body.outputContractRef || "spec/checkpoint.schema.json",
      payloadDigest: body.payloadDigest || stableDigest("7"),
      auditRef: `audit:${guard.idempotencyKey}`,
      createdAt: at,
      updatedAt: at
    };
    state.instructionMetrics.envelopes.push(envelope);
    audit(state, guard.actor, "instruction_envelope_create", `InstructionEnvelope:${envelope.envelopeId}`);
    finishGuardedWrite(state, guard, 201, envelope);
    writeState(state);
    json(res, 201, envelope);
    return;
  }

  // 人工杠杆：共享定义的状态原先【只有 AI 专属的 MCP 工具能改】——REST 无 PATCH、控制台是只读表格、
  // contractPublish 只会新建、id 唯一性又挡住复用。于是任何一条处于阻塞态的契约都能把任务组永久钉死，
  // 而人束手无策。这条路由把状态推进权交回真人（HUMAN_ONLY_ACTIONS 强制），是这类楔死的唯一出路。
  // 人工豁免质量门。"waived" 此前是死状态：close barrier 接受它，却没有任何代码路径能写入 ——
  // 于是唯一能把门判失败的和唯一能把门清掉的都是同一个 AI。这条把"豁免"这一决定交回真人，
  // 并强制留下理由（人自己也要为放行负责，不能无声豁免）。
  const qualityGateWaiveMatch = url.pathname.match(/^\/api\/quality-gates\/([^/]+)\/waive$/);
  if (req.method === "POST" && qualityGateWaiveMatch) {
    if (!requireAuthenticated(req, state, res)) return;
    const gate = (state.qualityGates || []).find((item) => item.gateId === decodeURIComponent(qualityGateWaiveMatch[1]));
    // 对象不存在时先前直接回 404，而那发生在守卫【之前】：任何已认证主体（含 agent 节点令牌）
    // 都能靠 404 与 428 的差别静默枚举别的租户有哪些对象，且不产生 policyDecision、不写审计。
    // 质量门尤其敏感 —— gateId 是 qg:<taskGroupId>:<workItemId>:<gateType> 这样可推算的确定性 id。
    // 改为：先过守卫（对象不在时退回一个寻常主体满足不了的系统作用域），无权者与不存在对调用方
    // 是同一个回答；只有能满足该作用域的主体才会看到 404。
    // 评审计划这条还要注意：守卫必须按它自己的 taskGroupId 落位，用 projectScope 会掉到一条
    // 与"是哪个项目"无关的判据上（见 directPermissionApplies）。
    const guard = beginGuardedWrite(req, state, "quality_gate_waive", gate ? `QualityGate:${gate.gateId}` : "quality_gates:unknown",
      gate ? taskGroupScope(state, gate.taskGroupId) : {resourceType: "system", resourceId: "quality_gates"});
    if (guard.status) return json(res, guard.status, guard.payload);
    if (!gate) return json(res, 404, {error: "quality_gate_not_found"});
    const justification = String(body.justification || "").trim();
    if (!justification) return json(res, 400, {error: "quality_gate_waive_requires_justification"});
    // 终态一次性守卫：这些字段是那位真人处置理由的【唯一】存放处（审计条目只记 actor/action/subject/
    // result，不含理由），被后来者无条件覆写即不可恢复。与 findingResolve / ruleSourceSettle 同规。
    if (["waived", "passed"].includes(gate.status)) return json(res, 409, {error: "quality_gate_already_settled", qualityGate: gate});
    gate.status = "waived";
    gate.waivedBy = guard.actor;
    gate.waiveJustification = assertHumanTextWithinLimit(justification, "quality_gate_waive_justification", 2000);
    gate.updatedAt = now();
    // 豁免恰好改变了验收卡片快照里的质量门状态。不同步刷新的话，人按下这个唯一的出路键之后，
    // 那张卡的 finalize/reject/revise 会被快照校验全部拒掉 —— 人把自己钉死，只能等过期。
    refreshConfirmationsAfterHumanChange(state, gate.taskGroupId, gate.workItemId,
      {actor: guard.actor, summary: `已人工豁免质量门 ${gate.gateType}`});
    // 处置完一项就要刷新关闭门快照：控制台上"关闭任务组"按钮只在 barrier.satisfied 时出现，
    // 而刷新那份快照的唯一入口原先就是那个按钮自己 —— 人处置掉最后一个阻塞项后，页面仍显示"存在阻塞"，
    // 于是永远等不到那个按钮（循环依赖）。
    recomputeBarrierAfterResolve(state, gate.taskGroupId);
    audit(state, guard.actor, "quality_gate_waive", `QualityGate:${gate.gateId}`, "waived");
    finishGuardedWrite(state, guard, 200, gate);
    writeState(state);
    json(res, 200, gate);
    return;
  }

  // 评审包的人工收尾杠杆：POST /api/review-bundles 允许任务组层面的人建出一条 submitted 的
  // 评审包，而终态化它此前只有 MCP review_result_consume 一条路 —— 那条路对真人只有 system_admin
  // 走得通。建得出来、settle 不掉，等于自己给自己上了个锁。
  const reviewBundleResolveMatch = url.pathname.match(/^\/api\/review-bundles\/([^/]+)\/resolve$/);
  if (req.method === "POST" && reviewBundleResolveMatch) {
    if (!requireAuthenticated(req, state, res)) return;
    const bundle = (state.reviewBundles || []).find((item) => item.reviewBundleId === reviewBundleResolveMatch[1]);
    // 对象不存在时先前直接回 404，而那发生在守卫【之前】：任何已认证主体（含 agent 节点令牌）
    // 都能靠 404 与 428 的差别静默枚举别的租户有哪些对象，且不产生 policyDecision、不写审计。
    // 质量门尤其敏感 —— gateId 是 qg:<taskGroupId>:<workItemId>:<gateType> 这样可推算的确定性 id。
    // 改为：先过守卫（对象不在时退回一个寻常主体满足不了的系统作用域），无权者与不存在对调用方
    // 是同一个回答；只有能满足该作用域的主体才会看到 404。
    // 评审计划这条还要注意：守卫必须按它自己的 taskGroupId 落位，用 projectScope 会掉到一条
    // 与"是哪个项目"无关的判据上（见 directPermissionApplies）。
    const guard = beginGuardedWrite(req, state, "review_bundle_resolve", bundle ? `ReviewBundle:${bundle.reviewBundleId}` : "review_bundles:unknown",
      bundle ? taskGroupScope(state, bundle.taskGroupId) : {resourceType: "system", resourceId: "review_bundles"});
    if (guard.status) return json(res, guard.status, guard.payload);
    if (!bundle) return json(res, 404, {error: "review_bundle_not_found"});
    const nextStatus = ["consumed", "rejected"].includes(body.status) ? body.status : null;
    if (!nextStatus) return json(res, 400, {error: "review_bundle_status_invalid"});
    const justification = String(body.justification || "").trim();
    if (!justification) return json(res, 400, {error: "review_bundle_resolution_justification_required"});
    if (["consumed", "rejected"].includes(bundle.status)) return json(res, 409, {error: "review_bundle_already_resolved", reviewBundle: bundle});
    bundle.status = nextStatus;
    bundle.resolvedBy = guard.actor;
    bundle.resolutionJustification = assertHumanTextWithinLimit(justification, "review_bundle_justification", 2000);
    bundle.updatedAt = now();
    // 处置完一项就要刷新关闭门快照：控制台上"关闭任务组"按钮只在 barrier.satisfied 时出现，
    // 而刷新那份快照的唯一入口原先就是那个按钮自己 —— 人处置掉最后一个阻塞项后，页面仍显示"存在阻塞"，
    // 于是永远等不到那个按钮（循环依赖）。
    recomputeBarrierAfterResolve(state, bundle.taskGroupId);
    audit(state, guard.actor, "review_bundle_resolve", `ReviewBundle:${bundle.reviewBundleId}`, nextStatus);
    finishGuardedWrite(state, guard, 200, bundle);
    writeState(state);
    json(res, 200, bundle);
    return;
  }

  // 系统升级候选项的人工处置杠杆：candidate_created 是 collectRuntimeIssue 自动产生的（例如
  // 一次技能源同步失败就会生成一条），它会挡住关闭门，而推进它此前只有 MCP 一条路，
  // 且 AI 被双重挡住 —— 于是只剩 system_admin 手写 JSON-RPC。自动产生的阻塞必须有寻常的人工出口。
  const upgradeCandidateResolveMatch = url.pathname.match(/^\/api\/system-upgrade-candidates\/([^/]+)\/resolve$/);
  if (req.method === "POST" && upgradeCandidateResolveMatch) {
    if (!requireAuthenticated(req, state, res)) return;
    const candidate = (state.systemUpgradeCandidates || []).find((item) => item.candidateId === upgradeCandidateResolveMatch[1]);
    // 对象不存在时先前直接回 404，而那发生在守卫【之前】：任何已认证主体（含 agent 节点令牌）
    // 都能靠 404 与 428 的差别静默枚举别的租户有哪些对象，且不产生 policyDecision、不写审计。
    // 质量门尤其敏感 —— gateId 是 qg:<taskGroupId>:<workItemId>:<gateType> 这样可推算的确定性 id。
    // 改为：先过守卫（对象不在时退回一个寻常主体满足不了的系统作用域），无权者与不存在对调用方
    // 是同一个回答；只有能满足该作用域的主体才会看到 404。
    // 评审计划这条还要注意：守卫必须按它自己的 taskGroupId 落位，用 projectScope 会掉到一条
    // 与"是哪个项目"无关的判据上（见 directPermissionApplies）。
    const guard = beginGuardedWrite(req, state, "system_upgrade_candidate_resolve", candidate ? `SystemUpgradeCandidate:${candidate.candidateId}` : "system_upgrade_candidates:unknown",
      candidate ? taskGroupScope(state, candidate.taskGroupId) : {resourceType: "system", resourceId: "system_upgrade_candidates"});
    if (guard.status) return json(res, guard.status, guard.payload);
    if (!candidate) return json(res, 404, {error: "system_upgrade_candidate_not_found"});
    const nextStatus = ["exported_for_external_maintenance", "dismissed", "closed"].includes(body.status) ? body.status : null;
    if (!nextStatus) return json(res, 400, {error: "system_upgrade_candidate_status_invalid"});
    const justification = String(body.justification || "").trim();
    if (!justification) return json(res, 400, {error: "system_upgrade_candidate_justification_required"});
    if (["external_maintenance_required", "dismissed", "superseded", "closed", "exported_for_external_maintenance"].includes(candidate.status)) {
      return json(res, 409, {error: "system_upgrade_candidate_already_resolved", systemUpgradeCandidate: candidate});
    }
    candidate.status = nextStatus;
    candidate.resolvedBy = guard.actor;
    candidate.resolutionJustification = assertHumanTextWithinLimit(justification, "system_upgrade_candidate_justification", 2000);
    candidate.updatedAt = now();
    // 处置完一项就要刷新关闭门快照：控制台上"关闭任务组"按钮只在 barrier.satisfied 时出现，
    // 而刷新那份快照的唯一入口原先就是那个按钮自己 —— 人处置掉最后一个阻塞项后，页面仍显示"存在阻塞"，
    // 于是永远等不到那个按钮（循环依赖）。
    recomputeBarrierAfterResolve(state, candidate.taskGroupId);
    // 人的判断要传导到它背后的问题模式，否则同一件已经判过的事会一直被重新聚类、反复顶上来。
    settleRuntimeIssuePatternForCandidate(state, candidate, nextStatus);
    audit(state, guard.actor, "system_upgrade_candidate_resolve", `SystemUpgradeCandidate:${candidate.candidateId}`, nextStatus);
    finishGuardedWrite(state, guard, 200, candidate);
    writeState(state);
    json(res, 200, candidate);
    return;
  }

  // 决定"这件事算不算需要人定稿的方案"的分类器，是几条字面匹配 —— 它认不出
  //「把订单状态机换成事件溯源」这类真正的架构决策，也会因为角色名之类的巧合误判。
  // 让它 fail-safe（判不准一律要人确认）不是答案：字面匹配对几乎所有任务都不确定，
  // 那会把确认流量堆到没人看的程度，而总在响的门等于没有门。
  // 机器判不了的事，判断权应当明确地交给人：这条杠杆让真人直接指定某个工作项是否必须先有
  // 人工定稿的执行方案才能开跑，覆盖分类器的结论（两个方向都能覆盖）。
  const planFinalizationMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/work-items\/([^/]+)\/plan-finalization$/);
  if (req.method === "POST" && planFinalizationMatch) {
    if (!requireAuthenticated(req, state, res)) return;
    const planTaskGroup = (state.taskGroups || []).find((item) => item.id === planFinalizationMatch[1]);
    const planWorkItem = (planTaskGroup?.workItems || []).find((item) => item.id === decodeURIComponent(planFinalizationMatch[2]));
    const guard = beginGuardedWrite(req, state, "work_item_plan_finalization_set",
      `WorkItem:${planFinalizationMatch[1]}:${planFinalizationMatch[2]}`, taskGroupScope(state, planFinalizationMatch[1]));
    if (guard.status) return json(res, guard.status, guard.payload);
    if (!planWorkItem) return json(res, 404, {error: "work_item_not_found"});
    // 缺省不得等于一个决定：原先写的是 `=== true`，于是字段名写错、或调用方没带这个字段时，
    // 这条命令会【按"不强制"执行】并把提交人的理由记在那条相反的决定上（审计写成 cleared）。
    // 实测用 {"required": true} 调它：HTTP 200，记录里 requiresPlanFinalization=false、理由照收。
    // 命令接口要拒绝，不要猜 —— 这是真人专属动作，猜错的是人的意思。
    if (typeof body.requiresPlanFinalization !== "boolean") {
      return json(res, 400, {error: "plan_finalization_requirement_required",
        message: "必须显式给出 requiresPlanFinalization（true 或 false）：缺省会被当成「不强制」，那可能与你的本意相反"});
    }
    const required = body.requiresPlanFinalization;
    const justification = String(body.justification || "").trim();
    if (!justification) return json(res, 400, {error: "plan_finalization_justification_required"});
    planWorkItem.requiresPlanFinalization = required;
    planWorkItem.planFinalizationDecidedBy = guard.actor;
    planWorkItem.planFinalizationJustification = assertHumanTextWithinLimit(justification, "plan_finalization_justification", 2000);
    planWorkItem.updatedAt = now();
    audit(state, guard.actor, "work_item_plan_finalization_set", `WorkItem:${planWorkItem.id}`,
      required ? "plan_finalization_required" : "plan_finalization_cleared");
    finishGuardedWrite(state, guard, 200, planWorkItem);
    writeState(state);
    json(res, 200, planWorkItem);
    return;
  }

  // 规则来源分流的收尾杠杆：AI 只能判"不采纳"（reference_only/quarantined/rejected），
  // 判为 active（采纳为本项目规则）必须真人 —— 与共享定义契约同一条口径。
  const ruleSourceSettleMatch = url.pathname.match(/^\/api\/rule-source-resolutions\/([^/]+)\/settle$/);
  if (req.method === "POST" && ruleSourceSettleMatch) {
    if (!requireAuthenticated(req, state, res)) return;
    const resolution = (state.ruleSourceResolutions || []).find((item) => item.resolutionId === ruleSourceSettleMatch[1]);
    // 对象不存在时先前直接回 404，而那发生在守卫【之前】：任何已认证主体（含 agent 节点令牌）
    // 都能靠 404 与 428 的差别静默枚举别的租户有哪些对象，且不产生 policyDecision、不写审计。
    // 质量门尤其敏感 —— gateId 是 qg:<taskGroupId>:<workItemId>:<gateType> 这样可推算的确定性 id。
    // 改为：先过守卫（对象不在时退回一个寻常主体满足不了的系统作用域），无权者与不存在对调用方
    // 是同一个回答；只有能满足该作用域的主体才会看到 404。
    // 评审计划这条还要注意：守卫必须按它自己的 taskGroupId 落位，用 projectScope 会掉到一条
    // 与"是哪个项目"无关的判据上（见 directPermissionApplies）。
    const guard = beginGuardedWrite(req, state, "rule_source_settle", resolution ? `RuleSourceResolution:${resolution.resolutionId}` : "rule_source_resolutions:unknown",
      resolution ? taskGroupScope(state, resolution.taskGroupId) : {resourceType: "system", resourceId: "rule_source_resolutions"});
    if (guard.status) return json(res, guard.status, guard.payload);
    if (!resolution) return json(res, 404, {error: "rule_source_resolution_not_found"});
    const settleAccount = accountFromRequest(req, state);
    const settleArgs = {resolutionId: resolution.resolutionId, taskGroupId: resolution.taskGroupId, status: body.status, justification: body.justification};
    if (settleAccount && HUMAN_ACCOUNT_TYPES_FOR_ACTIONS.includes(settleAccount.accountType) && settleAccount.status === "active") {
      settleArgs[HUMAN_ACTOR_KEY] = settleAccount.accountId;
    }
    const result = ruleSourceSettle(state, settleArgs);
    // 已被处置时必须回 409 而不是 200：后到者的决定被丢弃了，而 200 会让他确信自己成功了。
    // 权限那条最重 —— 拒绝方拿到 200，而权限其实已经授出。仓里另有五条处置路径本来就这么做
    // （质量门/评审计划/评审包/升级候选/共享定义），i18n 里也有现成的"可能是另一个人刚处理完"。
    if (result.alreadySettled) return json(res, 409, {error: "rule_source_already_settled", ruleSourceResolution: result.ruleSourceResolution});
    if (result.ok === false) return json(res, result.error === "rule_source_resolution_not_found" ? 404 : 403, result);
    // 处置完一项就要刷新关闭门快照：控制台上"关闭任务组"按钮只在 barrier.satisfied 时出现，
    // 而刷新那份快照的唯一入口原先就是那个按钮自己 —— 人处置掉最后一个阻塞项后，页面仍显示"存在阻塞"，
    // 于是永远等不到那个按钮（循环依赖）。
    recomputeBarrierAfterResolve(state, resolution.taskGroupId);
    audit(state, guard.actor, "rule_source_settle", `RuleSourceResolution:${resolution.resolutionId}`, result.ruleSourceResolution.status);
    finishGuardedWrite(state, guard, 200, result.ruleSourceResolution);
    writeState(state);
    json(res, 200, result.ruleSourceResolution);
    return;
  }

  // 评审计划的人工收尾杠杆：要求的评审角色可能永远到不齐（角色撤销、范围变更、外部评审方不再参与）。
  // 没有这个杠杆，评审计划就是一个只能进不能出的阻塞项。真人专属，且必须写明理由。
  const reviewPlanResolveMatch = url.pathname.match(/^\/api\/review-plans\/([^/]+)\/resolve$/);
  if (req.method === "POST" && reviewPlanResolveMatch) {
    if (!requireAuthenticated(req, state, res)) return;
    const plan = (state.reviewPlans || []).find((item) => item.reviewPlanId === reviewPlanResolveMatch[1]);
    // 对象不存在时先前直接回 404，而那发生在守卫【之前】：任何已认证主体（含 agent 节点令牌）
    // 都能靠 404 与 428 的差别静默枚举别的租户有哪些对象，且不产生 policyDecision、不写审计。
    // 质量门尤其敏感 —— gateId 是 qg:<taskGroupId>:<workItemId>:<gateType> 这样可推算的确定性 id。
    // 改为：先过守卫（对象不在时退回一个寻常主体满足不了的系统作用域），无权者与不存在对调用方
    // 是同一个回答；只有能满足该作用域的主体才会看到 404。
    // 评审计划这条还要注意：守卫必须按它自己的 taskGroupId 落位，用 projectScope 会掉到一条
    // 与"是哪个项目"无关的判据上（见 directPermissionApplies）。
    const guard = beginGuardedWrite(req, state, "review_plan_resolve", plan ? `ReviewPlan:${plan.reviewPlanId}` : "review_plans:unknown",
      plan ? taskGroupScope(state, plan.taskGroupId) : {resourceType: "system", resourceId: "review_plans"});
    if (guard.status) return json(res, guard.status, guard.payload);
    if (!plan) return json(res, 404, {error: "review_plan_not_found"});
    const nextStatus = ["closed", "rejected", "superseded"].includes(body.status) ? body.status : null;
    if (!nextStatus) return json(res, 400, {error: "review_plan_status_invalid"});
    const justification = String(body.justification || "").trim();
    if (!justification) return json(res, 400, {error: "review_plan_resolution_justification_required"});
    if (["closed", "rejected", "superseded"].includes(plan.status)) return json(res, 409, {error: "review_plan_already_resolved", reviewPlan: plan});
    plan.status = nextStatus;
    plan.resolvedBy = guard.actor;
    plan.resolutionJustification = assertHumanTextWithinLimit(justification, "review_plan_justification", 2000);
    plan.closedAt = now();
    plan.updatedAt = now();
    // 处置完一项就要刷新关闭门快照：控制台上"关闭任务组"按钮只在 barrier.satisfied 时出现，
    // 而刷新那份快照的唯一入口原先就是那个按钮自己 —— 人处置掉最后一个阻塞项后，页面仍显示"存在阻塞"，
    // 于是永远等不到那个按钮（循环依赖）。
    recomputeBarrierAfterResolve(state, plan.taskGroupId);
    audit(state, guard.actor, "review_plan_resolve", `ReviewPlan:${plan.reviewPlanId}`, nextStatus);
    finishGuardedWrite(state, guard, 200, plan);
    writeState(state);
    json(res, 200, plan);
    return;
  }

  const sharedDefinitionResolveMatch = url.pathname.match(/^\/api\/shared-definition-contracts\/([^/]+)\/resolve$/);
  if (req.method === "POST" && sharedDefinitionResolveMatch) {
    if (!requireAuthenticated(req, state, res)) return;
    const definition = (state.sharedDefinitions || []).find((item) => item.contractId === sharedDefinitionResolveMatch[1]);
    // 对象不存在时先前直接回 404，而那发生在守卫【之前】：任何已认证主体（含 agent 节点令牌）
    // 都能靠 404 与 428 的差别静默枚举别的租户有哪些对象，且不产生 policyDecision、不写审计。
    // 质量门尤其敏感 —— gateId 是 qg:<taskGroupId>:<workItemId>:<gateType> 这样可推算的确定性 id。
    // 改为：先过守卫（对象不在时退回一个寻常主体满足不了的系统作用域），无权者与不存在对调用方
    // 是同一个回答；只有能满足该作用域的主体才会看到 404。
    // 评审计划这条还要注意：守卫必须按它自己的 taskGroupId 落位，用 projectScope 会掉到一条
    // 与"是哪个项目"无关的判据上（见 directPermissionApplies）。
    const guard = beginGuardedWrite(req, state, "shared_definition_resolve", definition ? `SharedDefinitionContract:${definition.contractId}` : "shared_definition_contracts:unknown",
      definition ? projectScope(definition.projectId) : {resourceType: "system", resourceId: "shared_definition_contracts"});
    if (guard.status) return json(res, guard.status, guard.payload);
    if (!definition) return json(res, 404, {error: "shared_definition_not_found"});
    const nextStatus = ["active", "superseded", "retired", "rejected"].includes(body.status) ? body.status : null;
    if (!nextStatus) return json(res, 400, {error: "shared_definition_status_invalid"});
    // 与同批其余五条口径一致：人定稿必须留下依据。此前这是唯一一条不要求理由的杠杆，
    // 而它恰恰能把一条契约直接推成全局生效的规范。
    const definitionJustification = String(body.justification || "").trim();
    if (!definitionJustification) return json(res, 400, {error: "shared_definition_resolution_justification_required"});
    if (["superseded", "retired", "rejected"].includes(definition.status)) {
      return json(res, 409, {error: "shared_definition_already_resolved", sharedDefinition: definition});
    }
    definition.status = nextStatus;
    // 同上：人写的处置依据超了要拒，不能悄悄截断（这条也是真人专属的杠杆）。
    definition.resolutionJustification =
      assertHumanTextWithinLimit(definitionJustification, "shared_definition_resolution_justification", 2000);
    definition.resolvedBy = guard.actor;
    definition.updatedAt = now();
    // 处置完一项就要刷新关闭门快照：控制台上"关闭任务组"按钮只在 barrier.satisfied 时出现，
    // 而刷新那份快照的唯一入口原先就是那个按钮自己 —— 人处置掉最后一个阻塞项后，页面仍显示"存在阻塞"，
    // 于是永远等不到那个按钮（循环依赖）。
    recomputeBarrierAfterResolve(state, definition.taskGroupId);
    audit(state, guard.actor, "shared_definition_resolve", `SharedDefinitionContract:${definition.contractId}`, nextStatus);
    finishGuardedWrite(state, guard, 200, definition);
    writeState(state);
    json(res, 200, definition);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/shared-definition-contracts") {
    const guard = beginGuardedWrite(req, state, "shared_definition_contract_create", "SharedDefinitionContract:new", projectScope(body.projectId || "prj_control_plane"));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    const at = now();
    const definitionProjectId = body.projectId || "prj_control_plane";
    const definitionOrg = resourceScopeOrganizationId(state, {resourceType: "project", resourceId: definitionProjectId});
    // Drop any TaskGroup scopeRef outside the definition's own organization: the write is guarded only on the
    // definition's project, and the console shows a shared definition to anyone who can see a scopeRef task
    // group (server.mjs ~953), so an unconstrained cross-org scopeRef would inject it into another tenant's view.
    const defaultProjectScopeRef = `Project:${body.projectId || "prj_control_plane"}`;
    // 显式写明项目 id：裸 "Project" 曾被当成"项目内所有任务组"的通配，任何调用方写一句就能
    // 横扫全项目（并阻塞每个任务组的关闭门）。通配已从读取侧移除，写入侧必须同步给出具体 id，
    // 否则契约会绑定不到任何任务组（我上一轮只改了读取侧，导致种子契约对所有组都失效）。
    const sanitizedScopeRefs = (Array.isArray(body.scopeRefs) && body.scopeRefs.length ? body.scopeRefs : [defaultProjectScopeRef]).filter((ref) => {
      const value = String(ref);
      if (!value.startsWith("TaskGroup:")) return true;
      const taskGroup = state.taskGroups.find((item) => item.id === value.slice("TaskGroup:".length));
      return taskGroup && resourceScopeOrganizationId(state, {resourceType: "task_group", resourceId: taskGroup.id}) === definitionOrg;
    });
    // 这两个字段规范里就是闭集（spec/shared-definition-contract.schema.json 的 enum），
    // 门口却一直原样收：喂个认不出的取值，落下来的记录违反它自己声明的规范，
    // 而界面把它交给 t() —— 屏幕上是一串英文。旁边的 status 早就按白名单挡了，这两个漏了。
    // 常量与规范的 enum 由 contract-check 双向核对，不许手抄漂开。
    if (body.definitionType !== undefined && !SHARED_DEFINITION_TYPES.includes(String(body.definitionType))) {
      json(res, 400, {error: "shared_definition_type_not_recognized", supported: [...SHARED_DEFINITION_TYPES]});
      return;
    }
    if (body.conflictPolicy !== undefined && !SHARED_DEFINITION_CONFLICT_POLICIES.includes(String(body.conflictPolicy))) {
      json(res, 400, {error: "shared_definition_conflict_policy_not_recognized",
        supported: [...SHARED_DEFINITION_CONFLICT_POLICIES]});
      return;
    }
    const definition = {
      schemaVersion: "shared-definition-contract/v1",
      contractId: createId("sdc"),
      projectId: definitionProjectId,
      definitionType: body.definitionType || "terminology",
      scopeRefs: sanitizedScopeRefs.length ? sanitizedScopeRefs : [defaultProjectScopeRef],
      canonicalOwnerRole: body.canonicalOwnerRole || "orchestrator",
      producerRole: body.producerRole || "decision-center",
      // 与 core 的创建路径同规：调用方不得自选"有实际效力"的状态。这条 REST 路径原先完全绕过了
      // 那个枚举守卫（两条创建路径只守了一条），持 project:* 者可直接建出 conflicted 契约。
      status: ["draft", "owner_assigned", "proposed", "reviewing"].includes(body.status) ? body.status : "draft",
      definitionDigest: body.definitionDigest || stableDigest("8"),
      consumerRefs: body.consumerRefs || [],
      repositoryOutputTargetRef: body.repositoryOutputTargetRef || "rot_runtime_management",
      repositoryOutputTargetDigest: body.repositoryOutputTargetDigest || stableDigest("9"),
      conflictPolicy: body.conflictPolicy || "block_and_request_canonical_decision",
      changePolicy: body.changePolicy || {requiresDecisionRecord: true, invalidatesConsumers: true, consumerAckRequired: true},
      reviewEvidenceRefs: body.reviewEvidenceRefs || ["review:auto"],
      auditRef: `audit:${guard.idempotencyKey}`,
      createdAt: at,
      updatedAt: at
    };
    state.sharedDefinitions.unshift(definition);
    audit(state, guard.actor, "shared_definition_contract_create", `SharedDefinitionContract:${definition.contractId}`);
    finishGuardedWrite(state, guard, 201, definition);
    writeState(state);
    json(res, 201, definition);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/repository-output-targets") {
    // 见下方 taskGroupScope：任务组说不清就具名拒绝，不替调用方挑一个。
    if (requireBodyFields(res, body, ["taskGroupId"], "repository_output_target_task_group_required")) return;
    const pathAllowlist = body.pathAllowlist || ["docs/**", "spec/**"];
    const artifactManifestPath = body.artifactManifestPath || `docs/artifact-manifests/manifest.${Date.now()}.json`;
    // 与 MCP 那两处同规：两种原因分开说，并带上真实取值。
    // 原先只回一个裸码，人在控制台上看到"必须用 git 跟得住的路径"，却不知道是哪条路径不行。
    if (!validPathAllowlist(pathAllowlist)) {
      json(res, 400, {error: "repository_output_target_must_use_git_trackable_paths",
        cause: "path_allowlist_invalid", allowedPaths: pathAllowlist});
      return;
    }
    if (!gitTrackablePath(artifactManifestPath)) {
      json(res, 400, {error: "repository_output_target_must_use_git_trackable_paths",
        cause: "manifest_path_not_git_trackable", path: artifactManifestPath});
      return;
    }
    // Fail-closed at write time on an unsafe git URL so a malicious remote can never be persisted
    // (defense in depth alongside prepareRemoteGitVerification's read-time check).
    // 分支名与 remote 名也要【写时】拒，和下面那条 repositoryUrl 一个道理：原先只有读时
    // （prepareRemoteGitVerification）才判，于是 "-x" 这样的分支名、"--upload-pack=..." 这样的
    // remote 名能一路存进产出目标里，界面显示一切正常，直到 agent 真去推的时候才炸 ——
    // 那时报的是"执行失败"，人看不出是自己当初填错了一个字段。两处用同一个判据。
    // 位置必须在 beginGuardedWrite 之前：拒绝不该先落一条写入记录（第一版就放在了守卫之后）。
    if (!isSafeGitRef(String(body.branch || "main"))) {
      json(res, 400, {error: "repository_output_target_unsafe_branch", branch: String(body.branch || "").slice(0, 80)});
      return;
    }
    const requestedRemote = String(body.remote || "origin");
    if (!/^[A-Za-z0-9._-]+$/u.test(requestedRemote) || requestedRemote.startsWith("-")) {
      json(res, 400, {error: "repository_output_target_unsafe_remote", remote: requestedRemote.slice(0, 80)});
      return;
    }
    if (body.repositoryUrl && !isSafeGitRemoteUrl(body.repositoryUrl)) {
      json(res, 400, {error: "repository_output_target_unsafe_repository_url"});
      return;
    }
    // 调用方给的仓库地址必须是本项目登记过的那一个。写入只被授权在任务组作用域上，而地址
    // 决定了改动最终落在哪个仓库 —— 不做这条交叉校验，授权针对的是 A、改动可以落在 B。
    if (body.repositoryUrl) {
      const urlTaskGroup = state.taskGroups.find((item) => item.id === (body.taskGroupId));
      const urlProject = state.projects.find((item) => item.id === (urlTaskGroup?.projectId || body.projectId));
      if (!repositoryUrlRegisteredForProject(urlProject, body.repositoryUrl)) {
        json(res, 400, {error: "repository_output_target_repository_not_registered_for_project"});
        return;
      }
    }
    const guard = beginGuardedWrite(req, state, "repository_output_target_select", "RepositoryOutputTarget:new", taskGroupScope(state, body.taskGroupId));
    if (guard.status) {
      json(res, guard.status, guard.payload);
      return;
    }
    // 幂等：一个工作项同时只能有一份生效的写入边界（否则后建的宽边界会顶替人批准的窄边界）。
    // 【必须放在 beginGuardedWrite 之后】—— 鉴权、权限、租户作用域全在守卫里；放在它之前等于把
    // 人批准的写入边界（仓库地址/分支/基线/允许与禁止路径/活跃租约）做成了一个免鉴权的读接口。
    const existingActiveTarget = (state.repositoryOutputs || []).find((item) =>
      item.taskGroupId === body.taskGroupId && item.workItemId === body.workItemId && item.status !== "superseded");
    if (existingActiveTarget) {
      finishGuardedWrite(state, guard, 201, existingActiveTarget);
      writeState(state);
      json(res, 201, existingActiveTarget);
      return;
    }
    const at = now();
    const remote = body.remote || "origin";
    // Derive the target's project from its task group (the guarded scope), never a free body.projectId, so the
    // stored projectId cannot contradict the taskGroupId the write was authorized against.
    const targetTaskGroupId = body.taskGroupId;
    const targetTaskGroup = state.taskGroups.find((item) => item.id === targetTaskGroupId);
    const targetProjectId = targetTaskGroup?.projectId || body.projectId || "prj_control_plane";
    const project = state.projects.find((item) => item.id === targetProjectId);
    // 与 core 同一口径：界面写的是 config.repositories，顶层只有种子有（见 projectRepositories）。
    const projectRepos = projectRepositories(project);
    const repository = projectRepos.find((item) => item.id === body.repositoryId) || projectRepos[0];
    const target = {
      schemaVersion: "repository-output-target/v1",
      targetId: createId("rot"),
      projectId: targetProjectId,
      taskGroupId: targetTaskGroupId,
      workItemId: body.workItemId || "work_unknown",
      repositoryId: body.repositoryId || "repo_control_plane",
      repositoryUrl: body.repositoryUrl || gitRemoteUrl(repositoryRoot, remote) || repository?.url || "git:unknown-project-repository",
      remote,
      branch: body.branch || "main",
      baseRef: body.baseRef || gitHead(repositoryRoot),
      pathAllowlist,
      // 这条创建路径原先【根本没有 pathDenylist】—— 于是服务端判据与执行侧判据同时对着空集，
      // 允许集里写上 ".github/workflows/**" 就能改 CI 配置并推上去。禁区下限由 core 统一给。
      pathDenylist: effectivePathDenylist({pathDenylist: body.pathDenylist, forbiddenPathRules: body.forbiddenPathRules}),
      status: "selected",
      outputPolicy: "project_git_repository_only",
      // 这两个是不同的东西，原先挤在一个字段里：decisionRecordRef 是【调用方给的决策记录引用】，
      // 而落盘处的保留逻辑要的是【这次写入的策略决策 id】（凭什么允许写这个仓库/这些路径）。
      // 原先写成 `body.decisionRecordRef || guard.policyDecision.id`：调用方一旦真的传了前者，
      // 保留逻辑就再也找不到那条策略决策 —— 它会被容量悄悄挤掉，而那正是那段逻辑要防的事。
      // 实测真实状态里就有一条 decisionRecordRef 存着 pd_ 开头的 id（策略决策，不是决策记录）。
      decisionRecordRef: body.decisionRecordRef || guard.policyDecision.id,
      policyDecisionRef: guard.policyDecision.id,
      artifactManifestPath,
      auditRef: `audit:${guard.idempotencyKey}`,
      createdAt: at,
      updatedAt: at
    };
    state.repositoryOutputs ||= [];
    state.repositoryOutputs.push(target);
    audit(state, guard.actor, "repository_output_target_select", `RepositoryOutputTarget:${target.targetId}`);
    finishGuardedWrite(state, guard, 201, target);
    writeState(state);
    json(res, 201, target);
    return;
  }

  // ── Gap 2B: §4 REST endpoints over shared core mutators ─────────────────────
  const workItemAssignMatch = url.pathname.match(/^\/api\/work-items\/([^/]+)\/assign$/);
  if (req.method === "POST" && workItemAssignMatch) {
    // 作用域必须取【被改的那条记录】自己所属的任务组，不能取调用方在请求体里写的那个
    // —— 否则就是 confused deputy：我对自己的组有权，请求体里写自己的组，守卫放行，
    // 而 URL 上那条工作项是别人的。目前挡住这一手的是 core 里"查找按 taskGroupId 过滤"，
    // 也就是说防线全压在 mutator 上；隔壁 findings 路由早就把这个口径写进注释了，这里补齐。
    const assignTarget = (state.taskGroups || []).find((group) =>
      (group.workItems || []).some((item) => item.id === workItemAssignMatch[1]));
    const guard = beginGuardedWrite(req, state, "work_assign", `WorkItem:${workItemAssignMatch[1]}`,
      taskGroupScope(state, assignTarget?.id || body.taskGroupId));
    if (guard.status) return json(res, guard.status, guard.payload);
    // 空 body 原先也能"指派"：它把草稿工作项推进到 ready，归属缺失时还挑一个 orchestrator。
    // 指派是"谁来干这件事"的决定，不该由缺省替人做。（这一条是完整变异门跑出来的：
    // 另一条无关变异改变了工作项状态，我那轮扫描的结果就跟着变了 —— 说明这条路由的行为
    // 本来就取决于对象状态，缺省更不该在这里做决定。）
    // 两个字段名任一即可，所以不能连着调两次 requireBodyFields —— 它自己会发响应，
    // 连调两次就是往同一个请求上发两遍（headers already sent）。
    if (!String(body.roleId ?? body.ownerRole ?? "").trim()) {
      return json(res, 400, {error: "work_item_owner_role_required",
        message: "指派必须点名负责角色（roleId 或 ownerRole）—— 缺省不会替你挑一个"});
    }
    const result = assignWorkItem(state, {...body, workItemId: workItemAssignMatch[1]});
    if (result.ok === false) return json(res, refusalStatus(result), refusalPayload(result));
    audit(state, guard.actor, "work_assign", `WorkItem:${result.workItem.id}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/findings") {
    // Confused-deputy fix: when updating an existing finding, scope the guard on the finding's OWN task
    // group, never on the caller-supplied body.taskGroupId — otherwise a reviewer scoped to their own
    // task group could rewrite a finding owned by a different task group/tenant (matches finding_resolve).
    const existingFinding = body.findingId ? (state.findings || []).find((item) => item.findingId === body.findingId) : null;
    if (!existingFinding && requireBodyFields(res, body, ["taskGroupId"], "finding_task_group_required")) return;
    const scopeTaskGroupId = existingFinding?.taskGroupId || body.taskGroupId;
    const guard = beginGuardedWrite(req, state, "finding_submit", `Finding:${body.findingId || "new"}`, taskGroupScope(state, scopeTaskGroupId));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = findingSubmit(state, body);
    // core 的拒绝（如 task_group_settled）要原样转发：不接住的话下一行 result.finding.findingId 直接抛，
    // 调用方收到 500 server_error —— 与 approval_request_create 同规（那处早有这道门，这族其余几处漏了）。
    if (result.ok === false) return json(res, refusalStatus(result), refusalPayload(result));
    audit(state, guard.actor, "finding_submit", `Finding:${result.finding.findingId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  const findingResolveMatch = url.pathname.match(/^\/api\/findings\/([^/]+)\/resolve$/);
  if (req.method === "POST" && findingResolveMatch) {
    const existingFinding = (state.findings || []).find((item) => item.findingId === findingResolveMatch[1]);
    const guard = beginGuardedWrite(req, state, "finding_resolve", `Finding:${findingResolveMatch[1]}`, taskGroupScope(state, existingFinding?.taskGroupId));
    if (guard.status) return json(res, guard.status, guard.payload);
    // 真人身份只能由已鉴权账号推导，并且经 Symbol 键传入 —— 请求体里写什么都进不来。
    const resolvingAccount = accountFromRequest(req, state);
    const humanActor = resolvingAccount && HUMAN_ACCOUNT_TYPES_FOR_ACTIONS.includes(resolvingAccount.accountType) && resolvingAccount.status === "active"
      ? resolvingAccount.accountId
      : null;
    const findingArgs = {...(body || {}), findingId: findingResolveMatch[1]};
    if (humanActor) findingArgs[HUMAN_ACTOR_KEY] = humanActor;
    const result = findingResolve(state, findingArgs);
    if (result.error === "finding_disposition_requires_human") return json(res, 403, result);
    // 已被处置时必须回 409 而不是 200：后到者的决定被丢弃了，而 200 会让他确信自己成功了。
    // 权限那条最重 —— 拒绝方拿到 200，而权限其实已经授出。仓里另有五条处置路径本来就这么做
    // （质量门/评审计划/评审包/升级候选/共享定义），i18n 里也有现成的"可能是另一个人刚处理完"。
    if (result.alreadyResolved) return json(res, 409, {error: "finding_already_resolved", finding: result.finding});
    if (result.ok === false) return json(res, refusalStatus(result), refusalPayload(result));
    recomputeBarrierAfterResolve(state, existingFinding?.taskGroupId);
    audit(state, guard.actor, "finding_resolve", `Finding:${result.finding.findingId}`);
    finishGuardedWrite(state, guard, 200, result);
    writeState(state);
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/approval-requests") {
    if (requireBodyFields(res, body, ["taskGroupId"], "approval_request_task_group_required")) return;
    const guard = beginGuardedWrite(req, state, "approval_request_create", `ApprovalRequest:${body.approvalId || "new"}`, taskGroupScope(state, body.taskGroupId));
    if (guard.status) return json(res, guard.status, guard.payload);
    // Record the proposer as the AUTHENTICATED actor (never client-supplied) for high_risk_no_self_approval.
    const result = approvalRequestCreate(state, {...body, proposedBy: guard.actor});
    // core 的拒绝要原样转发：不接住的话下一行 result.approvalRequest.approvalId 直接抛，
    // 调用方收到的是 500 server_error —— 「少填一个字段报成服务器故障」这一族在本仓已经撞过一次。
    if (result.ok === false) return json(res, 400, {error: result.error, ...(result.message ? {message: result.message} : {})});
    audit(state, guard.actor, "approval_request_create", `ApprovalRequest:${result.approvalRequest.approvalId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  const dlqResolveMatch = url.pathname.match(/^\/api\/dlq-entries\/([^/]+)\/resolve$/);
  if (req.method === "POST" && dlqResolveMatch) {
    const entry = (state.dlqEntries || []).find((item) => item.entryId === dlqResolveMatch[1]);
    const guard = beginGuardedWrite(req, state, "dlq_entry_resolve", `DLQEntry:${dlqResolveMatch[1]}`,
      entry ? taskGroupScope(state, entry.taskGroupId) : {resourceType: "system", resourceId: "dlq"});
    if (guard.status) return json(res, guard.status, guard.payload);
    if (!entry) return json(res, 404, {error: "dlq_entry_not_found"});
    let result;
    try { result = operatorResolveDlqEntry(state, entry, {resolution: body.resolution, justification: body.justification, actor: guard.actor}); }
    catch (error) { return json(res, error.status || 400, {error: error.message}); }
    if (result.alreadyResolved) return json(res, 409, {error: "dlq_entry_already_resolved", dlqEntry: result.dlqEntry});
    recomputeBarrierAfterResolve(state, entry.taskGroupId);
    audit(state, guard.actor, "dlq_entry_resolve", `DLQEntry:${entry.entryId}`, result.resolution);
    finishGuardedWrite(state, guard, 200, result);
    writeState(state);
    json(res, 200, result);
    return;
  }

  const approvalResolveMatch = url.pathname.match(/^\/api\/approval-requests\/([^/]+)\/resolve$/);
  if (req.method === "POST" && approvalResolveMatch) {
    const existingApproval = (state.approvalRequests || []).find((item) => item.approvalId === approvalResolveMatch[1]);
    const guard = beginGuardedWrite(req, state, "approval_resolve", `ApprovalRequest:${approvalResolveMatch[1]}`, taskGroupScope(state, existingApproval?.taskGroupId));
    if (guard.status) return json(res, guard.status, guard.payload);
    // The approver identity is the AUTHENTICATED actor, never a client-supplied resolvedBy — this is what
    // high_risk_no_self_approval and the quorum tally key on.
    const result = approvalResolve(state, {...body, approvalId: approvalResolveMatch[1], resolvedBy: guard.actor});
    // 已被处置时必须回 409 而不是 200：后到者的决定被丢弃了，而 200 会让他确信自己成功了。
    // 权限那条最重 —— 拒绝方拿到 200，而权限其实已经授出。仓里另有五条处置路径本来就这么做
    // （质量门/评审计划/评审包/升级候选/共享定义），i18n 里也有现成的"可能是另一个人刚处理完"。
    if (result.alreadyResolved) return json(res, 409, {error: "approval_already_resolved", approvalRequest: result.approvalRequest});
    if (result.ok === false) return json(res, result.error === "high_risk_no_self_approval" ? 403 : refusalStatus(result), refusalPayload(result));
    recomputeBarrierAfterResolve(state, existingApproval?.taskGroupId);
    audit(state, guard.actor, "approval_resolve", `ApprovalRequest:${result.approvalRequest.approvalId}`);
    finishGuardedWrite(state, guard, 200, result);
    writeState(state);
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/policy-decisions/evaluate") {
    const guard = beginGuardedWrite(req, state, "policy_decision_eval", `PolicyDecision:${body.decisionId || "new"}`, {resourceType: "system", resourceId: "policy_engine"});
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = policyDecisionEval(state, body);
    // core 的拒绝要原样转发：不接住的话下一行 result.policyDecision.decisionId 直接抛，
    // 调用方收到 500 —— 「少填一个字段报成服务器故障」这一族本仓已经撞过两次。
    if (result.ok === false) {
      return json(res, 400, {error: result.error, received: result.received, message: result.message});
    }
    audit(state, guard.actor, "policy_decision_eval", `PolicyDecision:${result.policyDecision.decisionId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/contracts") {
    const contractTaskGroup = body.taskGroupId ? state.taskGroups.find((item) => item.id === body.taskGroupId) : null;
    const contractProjectId = contractTaskGroup?.projectId || body.projectId || "prj_control_plane";
    const guard = beginGuardedWrite(req, state, "contract_publish", `Contract:${body.contractId || "new"}`, projectScope(contractProjectId));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = contractPublish(state, {...body, projectId: contractProjectId});
    audit(state, guard.actor, "contract_publish", `Contract:${result.contract.contractId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  const roomMessagesMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/messages$/);
  if (roomMessagesMatch) {
    const roomId = roomMessagesMatch[1];
    const roomTaskGroupId = roomId.startsWith("room_") ? roomId.slice("room_".length) : roomId;
    if (req.method === "GET") {
      const authenticated = requireRead(req, state, taskGroupScope(state, roomTaskGroupId));
      if (authenticated.status) return json(res, authenticated.status, authenticated.payload);
      const result = roomWait(state, {roomId, tail: url.searchParams.get("tail") === "1", afterSequence: Number(url.searchParams.get("after") || url.searchParams.get("afterSequence") || 0), limit: Number(url.searchParams.get("limit") || 50)});
      json(res, 200, result);
      return;
    }
    if (req.method === "POST") {
      // Scope authorization AND the write from the path room only. Trusting body.taskGroupId here
      // would let an actor authorized on their own task group inject a message into another tenant's
      // room (guard passes on the body scope while roomSend routes by the path roomId).
      if (body.taskGroupId && body.taskGroupId !== roomTaskGroupId) {
        return json(res, 400, {error: "room_task_group_mismatch"});
      }
      const guard = beginGuardedWrite(req, state, "room_send", `Room:${roomId}`, taskGroupScope(state, roomTaskGroupId));
      if (guard.status) return json(res, guard.status, guard.payload);
      // 署名取已认证主体，不取报文。REST 这条路上可能是真人账号会话，也可能是 agent 节点令牌。
      const roomSendArgs = {...body, roomId, taskGroupId: roomTaskGroupId};
      const roomSendAccount = accountFromRequest(req, state);
      const roomSendNode = roomSendAccount ? null : authenticateAgentNode(state, bearerToken(req));
      // accountFromRequest 返回的是 {session, account} —— 账号 id 在【里层】。
      // 原先写的是 roomSendAccount.accountId，取到 undefined，于是经 REST 由真人发的每一条
      // 房间消息都署名成字符串 "account:undefined"：协作记录里谁说的这件事整个丢了，
      // 而它不报错、也不是空 —— 看起来像一个正常的署名。
      const roomSenderAccountId = accountIdOf(roomSendAccount?.account || {});
      roomSendArgs[ROOM_SENDER_KEY] = roomSenderAccountId ? `account:${roomSenderAccountId}`
        : roomSendNode ? `agent_node:${roomSendNode.nodeId}` : "unattributed";
      const result = roomSend(state, roomSendArgs);
      if (result.error === "room_task_group_settled") return json(res, 409, {error: result.error, taskGroupStatus: result.taskGroupStatus});
      if (result.ok === false) return json(res, 413, {error: result.error, maxBytes: result.maxBytes});
      audit(state, guard.actor, "room_send", `Room:${roomId}`);
      finishGuardedWrite(state, guard, 201, result);
      writeState(state);
      json(res, 201, result);
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/leases/claim") {
    const claimTargetId = body.repositoryOutputTargetRef || body.targetId;
    const claimTarget = claimTargetId ? (state.repositoryOutputs || []).find((item) => item.targetId === claimTargetId) : null;
    // 同 lease_release：claimLease 按 body 里的产出目标定位，作用域就必须由那个目标派生。
    // 目标查不到时 claimLease 一定回 repository_output_target_not_found，此处不必也不该
    // 拿调用方自报的任务组去判权 —— fail closed 同时消掉了"用 404/403 试探目标是否存在"。
    const leaseClaimScope = claimTarget?.taskGroupId
      ? taskGroupScope(state, claimTarget.taskGroupId)
      : {resourceType: "system", resourceId: "leases"};
    const guard = beginGuardedWrite(req, state, "lease_claim", `Lease:${claimTargetId || "new"}`, leaseClaimScope);
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = claimLease(state, body);
    if (result.ok === false) return json(res, result.error === "repository_output_target_not_found" ? 404 : 409, result);
    audit(state, guard.actor, "lease_claim", `Lease:${result.lease.leaseId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  const leaseReleaseMatch = url.pathname.match(/^\/api\/leases\/([^/]+)\/release$/);
  if (req.method === "POST" && leaseReleaseMatch) {
    const lease = (state.leases || []).find((item) => item.leaseId === leaseReleaseMatch[1]);
    const leaseTargetId = lease?.resourceRef?.startsWith("RepositoryOutputTarget:") ? lease.resourceRef.slice("RepositoryOutputTarget:".length) : null;
    const leaseTarget = leaseTargetId ? (state.repositoryOutputs || []).find((item) => item.targetId === leaseTargetId) : null;
    // 授权作用域必须由【真正被改的那个对象】派生。原先推导不出时回落到 body.taskGroupId ——
    // 而 releaseLease 纯按路径里的 leaseId 定位，根本不看 taskGroupId：调用方报一个自己有权的
    // 任务组就能过守卫，被释放的却是别人的租约。释放租约＝解开对方产出目标的写锁，
    // 另一个会话随即可以抢占。（今天还有 fencingToken 兜着，但那是纵深防御，不是授权。）
    // 租约的 resourceRef 由 claimLease 恒定构造为一个存在的 RepositoryOutputTarget，
    // 所以推导不出只可能是"租约不存在"或"目标已消失"——两种都不该用调用方自报的作用域，
    // 改为按系统级资源判权（fail closed），随后 releaseLease 自然回 404，也不构成存在性预言。
    const leaseReleaseScope = leaseTarget?.taskGroupId
      ? taskGroupScope(state, leaseTarget.taskGroupId)
      : {resourceType: "system", resourceId: "leases"};
    const guard = beginGuardedWrite(req, state, "lease_release", `Lease:${leaseReleaseMatch[1]}`, leaseReleaseScope);
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = releaseLease(state, {...body, leaseId: leaseReleaseMatch[1]});
    if (result.ok === false) return json(res, result.error === "lease_not_found" ? 404 : 409, result);
    audit(state, guard.actor, "lease_release", `Lease:${result.lease.leaseId}`);
    finishGuardedWrite(state, guard, 200, result);
    writeState(state);
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/artifacts") {
    if (requireBodyFields(res, body, ["taskGroupId"], "artifact_task_group_required")) return;
    const guard = beginGuardedWrite(req, state, "artifact_register", `Artifact:${body.artifactId || "new"}`, taskGroupScope(state, body.taskGroupId));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = artifactRegister(state, body);
    audit(state, guard.actor, "artifact_register", `Artifact:${result.artifact.artifactId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/permission-requests") {
    // 见下方 taskGroupScope：任务组说不清就具名拒绝，不替调用方挑一个。
    if (requireBodyFields(res, body, ["taskGroupId"], "permission_request_task_group_required")) return;
    const guard = beginGuardedWrite(req, state, "permission_request_submit", `PermissionRequest:${body.requestId || "new"}`, taskGroupScope(state, body.taskGroupId));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = permissionRequestSubmit(state, body);
    if (result.ok === false) return json(res, refusalStatus(result), refusalPayload(result));
    audit(state, guard.actor, "permission_request_submit", `PermissionRequest:${result.permissionRequest.requestId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  const permissionResolveMatch = url.pathname.match(/^\/api\/permission-requests\/([^/]+)\/resolve$/);
  if (req.method === "POST" && permissionResolveMatch) {
    const existingPermission = (state.permissionRequests || []).find((item) => item.requestId === permissionResolveMatch[1]);
    // Confused-deputy fix: authorize on the RESOURCE that approval actually grants (request.resource,
    // which ensurePermissionAccessGrant uses), NOT on taskGroupId. resource.resourceId can be set
    // independently of taskGroupId at submit time, so guarding on taskGroupId let a project-lead of A
    // approve a grant over project/task-group B (same org). In the legitimate flow resource is
    // {task_group, taskGroupId}, so this does not change normal behavior.
    const permissionResolveResource = existingPermission?.resource;
    const permissionResolveScope =
      permissionResolveResource?.resourceType === "task_group" ? taskGroupScope(state, permissionResolveResource.resourceId) :
      permissionResolveResource?.resourceType === "project" ? projectScope(permissionResolveResource.resourceId) :
      existingPermission?.taskGroupId ? taskGroupScope(state, existingPermission.taskGroupId) :
      projectScope("prj_control_plane");
    const guard = beginGuardedWrite(req, state, "permission_resolve", `PermissionRequest:${permissionResolveMatch[1]}`, permissionResolveScope);
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = permissionResolve(state, {...body, requestId: permissionResolveMatch[1]});
    // 无法识别的处置结果是调用方的错，不是"找不到这条请求" —— 一律回 404 会让调用方去查 id，
    // 而真正的原因是它送了一个不属于 approved/rejected 的状态。
    // 转发时不能只带 error：core/MCP 那侧同时给了 received 与 allowedStatuses，
    // 只取 error 的话，人在控制台上看到"状态不合法"却看不到什么才合法（界面本来就会渲染这两个字段）。
    // 「没说」不能变成「批准」：core 那侧现在要求显式结论，这里要把拒绝原样转发，
    // 否则会掉到下面 `result.ok === false → 404`，人看到的是"这条申请不存在"（假话）。
    if (result.error === "expires_at_invalid" || result.error === "ttl_seconds_invalid") {
      return json(res, 400, {error: result.error, received: result.received, message: result.message});
    }
    if (result.error === "permission_decision_required") {
      return json(res, 400, {error: result.error, allowedStatuses: result.allowedStatuses, message: result.message});
    }
    if (result.error === "permission_request_status_invalid") {
      return json(res, 400, {error: result.error,
        ...(result.received === undefined ? {} : {received: result.received}),
        ...(result.allowedStatuses === undefined ? {} : {allowedStatuses: result.allowedStatuses})});
    }
    // 已被处置时必须回 409 而不是 200：后到者的决定被丢弃了，而 200 会让他确信自己成功了。
    // 权限那条最重 —— 拒绝方拿到 200，而权限其实已经授出。仓里另有五条处置路径本来就这么做
    // （质量门/评审计划/评审包/升级候选/共享定义），i18n 里也有现成的"可能是另一个人刚处理完"。
    if (result.alreadyResolved) return json(res, 409, {error: "permission_request_already_resolved", permissionRequest: result.permissionRequest});
    if (result.ok === false) return json(res, refusalStatus(result), refusalPayload(result));
    recomputeBarrierAfterResolve(state, existingPermission?.taskGroupId);
    audit(state, guard.actor, "permission_resolve", `PermissionRequest:${result.permissionRequest.requestId}`, result.permissionRequest.status);
    finishGuardedWrite(state, guard, 200, result);
    writeState(state);
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/execution-topologies") {
    // 见下方 taskGroupScope：任务组说不清就具名拒绝，不替调用方挑一个。
    if (requireBodyFields(res, body, ["taskGroupId"], "execution_topology_task_group_required")) return;
    const guard = beginGuardedWrite(req, state, "execution_topology_plan", `ExecutionTopology:${body.topologyId || "new"}`, taskGroupScope(state, body.taskGroupId));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = createExecutionTopology(state, body, {root: repositoryRoot});
    if (result.ok === false) return json(res, refusalStatus(result), refusalPayload(result));
    audit(state, guard.actor, "execution_topology_plan", `ExecutionTopology:${result.topology.topologyId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  const topologyAdvanceMatch = url.pathname.match(/^\/api\/execution-topologies\/([^/]+)\/advance$/);
  if (req.method === "POST" && topologyAdvanceMatch) {
    if (!requireAuthenticated(req, state, res)) return;
    // The lever for the no_open_execution_topologies close-barrier gate: without a reachable transition
    // path a planned topology would block the barrier forever. Scope the guard on the topology's OWN task
    // group (never a caller-supplied id) so it can't be driven from another tenant's scope.
    const existingTopology = (state.executionTopologies || []).find((item) => item.topologyId === topologyAdvanceMatch[1]);
    // "不存在"必须和"看不见"长得一样，否则把 id 挨个试一遍就能数出别的租户有多少条拓扑。
    // 只有看得见全局的系统账号才配拿到真 404（与 missingProjectDenial 同一条不变式）。
    if (!existingTopology) {
      const denial = missingRecordDenial(req, state, "execution_topology_not_found", "policy_denied");
      return json(res, denial.status, denial.payload);
    }
    const guard = beginGuardedWrite(req, state, "execution_topology_advance", `ExecutionTopology:${topologyAdvanceMatch[1]}`, taskGroupScope(state, existingTopology.taskGroupId));
    if (guard.status) return json(res, guard.status, guard.payload);
    let result;
    try {
      result = advanceExecutionTopology(state, {...body, topologyId: topologyAdvanceMatch[1], actor: guard.actor});
    } catch (error) {
      // 与人工定稿那条路由同理：核心函数特意附带的字段不能在这里被丢掉。
      // 控制台上有真人可点的"终止执行方案"，过时页面点一下就会撞到这里，而他需要的正是"现在是什么状态"。
      return json(res, error.status || 409, {error: error.message,
        ...(error.currentStatus ? {currentStatus: error.currentStatus} : {}),
        ...(error.allowedStatuses ? {allowedStatuses: error.allowedStatuses} : {}),
        ...(error.hint ? {message: error.hint} : {})});
    }
    if (result.ok === false) return json(res, refusalStatus(result), refusalPayload(result));
    // 同上：拓扑已到终态时回 409，而不是回 200 让后到者以为自己推进了它。
    if (result.alreadyTerminal) return json(res, 409, {error: "execution_topology_already_terminal", topology: result.topology});
    recomputeBarrierAfterResolve(state, existingTopology.taskGroupId);
    audit(state, guard.actor, "execution_topology_advance", `ExecutionTopology:${result.topology.topologyId}`, result.topology.status);
    finishGuardedWrite(state, guard, 200, result);
    writeState(state);
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/derived-task-requests") {
    // 见下方 taskGroupScope：任务组说不清就具名拒绝，不替调用方挑一个。
    if (requireBodyFields(res, body, ["taskGroupId"], "derived_task_task_group_required")) return;
    const guard = beginGuardedWrite(req, state, "derived_task_classify", `DerivedTaskRequest:${body.taskGroupId}`, taskGroupScope(state, body.taskGroupId));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = classifyDerivedTask(state, body);
    audit(state, guard.actor, "derived_task_classify", `DerivedTaskRequest:${result.roleId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/review-plans") {
    // 见下方 taskGroupScope：任务组说不清就具名拒绝，不替调用方挑一个。
    if (requireBodyFields(res, body, ["taskGroupId"], "review_plan_task_group_required")) return;
    const guard = beginGuardedWrite(req, state, "review_plan_create", `ReviewPlan:${body.reviewPlanId || "new"}`, taskGroupScope(state, body.taskGroupId));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = reviewPlanCreate(state, body);
    if (result.ok === false) return json(res, refusalStatus(result), refusalPayload(result));
    audit(state, guard.actor, "review_plan_create", `ReviewPlan:${result.reviewPlan.reviewPlanId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/review-bundles") {
    // 见下方 taskGroupScope：任务组说不清就具名拒绝，不替调用方挑一个。
    if (requireBodyFields(res, body, ["taskGroupId"], "review_bundle_task_group_required")) return;
    const guard = beginGuardedWrite(req, state, "review_bundle_register", `ReviewBundle:${body.reviewBundleId || "new"}`, taskGroupScope(state, body.taskGroupId));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = reviewBundleRegister(state, body);
    audit(state, guard.actor, "review_bundle_register", `ReviewBundle:${result.reviewBundle.reviewBundleId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/rule-source-resolutions") {
    // 见下方 taskGroupScope：任务组说不清就具名拒绝，不替调用方挑一个。
    if (requireBodyFields(res, body, ["taskGroupId"], "rule_source_task_group_required")) return;
    const guard = beginGuardedWrite(req, state, "rule_source_resolve", `RuleSourceResolution:${body.resolutionId || "new"}`, taskGroupScope(state, body.taskGroupId));
    if (guard.status) return json(res, guard.status, guard.payload);
    const result = ruleSourceResolve(state, body);
    if (result.ok === false) return json(res, refusalStatus(result), refusalPayload(result));
    audit(state, guard.actor, "rule_source_resolve", `RuleSourceResolution:${result.ruleSourceResolution.resolutionId}`);
    finishGuardedWrite(state, guard, 201, result);
    writeState(state);
    json(res, 201, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/orgs") {
    const guard = beginGuardedWrite(req, state, "org_create", "Organization:new", {resourceType: "system", resourceId: "organizations"});
    if (guard.status) return json(res, guard.status, guard.payload);
    const invalidCreateQuotas = invalidQuotaEntries(body);
    if (invalidCreateQuotas.length) return json(res, 400, quotaInvalidPayload(invalidCreateQuotas));
    const at = now();
    const orgId = createId("org");
    const quotas = {
      maxMembers: boundedQuota(body.quotas?.maxMembers, 50),
      maxProjects: boundedQuota(body.quotas?.maxProjects, 20),
      maxTaskGroups: boundedQuota(body.quotas?.maxTaskGroups, 200),
      maxAgents: boundedQuota(body.quotas?.maxAgents, 100)
    };
    // 邮箱是这个组织管理员的【登录身份】，不能替人编一个。原先缺了就默认成
    // `org-admin-<时间戳>@local` 并回 201 —— 我自己就踩过：字段发成平铺的 adminEmail
    // （服务端认的是嵌套的 admin.email），于是指定的邮箱被静默丢掉、系统造了另一个身份，
    // 而调用方拿到的是"创建成功"。控制台发的形状是对的，所以这个洞只在脚本/集成方那一侧显形。
    const requestedAdminEmail = String(body.admin?.email || "").trim();
    if (!requestedAdminEmail || !requestedAdminEmail.includes("@")) {
      json(res, 400, {error: "organization_admin_email_required",
        message: "创建组织必须指定初始组织管理员的邮箱：它是这个人的登录身份，系统不会替你编一个",
        hint: '字段在 admin.email，形如 {"name":"…","admin":{"email":"a@b.c","displayName":"…"}}',
        received: body.admin === undefined ? "请求体里没有 admin 这一层" : `admin.email = ${JSON.stringify(body.admin?.email)}`});
      return;
    }
    if (body.admin?.email && (state.accounts || []).some((item) => sameEmail(item.email, body.admin.email))) {
      json(res, 409, {error: "account_email_already_registered"});
      return;
    }
    const adminAccountId = createId("acct");
    const adminToken = `aimac_account_${randomBytes(32).toString("base64url")}`;
    const adminAccount = {
      schemaVersion: "account/v1",
      accountId: adminAccountId,
      accountType: "org_admin",
      organizationId: orgId,
      displayName: String(body.admin?.displayName || "组织管理员"),
      email: requestedAdminEmail,
      status: "invited",
      roles: ["org_admin"],
      permissions: ["org:*", "project:create", "project:*", "task_group:*", "member:invite", "agent:activate", "project:grant"],
      authPolicy: {method: "invite_token", mfaRequired: false, passwordSet: false, sessionTtlSeconds: 28800},
      credentialDigest: digestOf(`account-invite:${adminAccountId}:${adminToken}`),
      credentialIssuedAt: at,
      credentialExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      createdAt: at,
      updatedAt: at
    };
    const organization = {
      schemaVersion: "organization/v1",
      orgId,
      name: String(body.name || "").trim() || `组织 ${orgId.slice(-6)}`,
      status: "active",
      quotas,
      usage: {members: 1, projects: 0, taskGroups: 0, agents: 0},
      initialAdminAccountId: adminAccountId,
      createdBy: guard.actor,
      createdAt: at,
      updatedAt: at
    };
    state.organizations.push(organization);
    state.accounts.unshift(adminAccount);
    audit(state, guard.actor, "org_create", `Organization:${orgId}`);
    finishGuardedWrite(state, guard, 201, {organization, adminAccountId});
    writeState(state);
    json(res, 201, {organization, adminAccount: publicAccountRecord(adminAccount), accountToken: adminToken, login: {email: adminAccount.email, tokenField: "accountToken"}});
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/orgs") {
    const reader = requireRead(req, state, {resourceType: "system", resourceId: "organizations"});
    if (reader.status) return json(res, reader.status, reader.payload);
    // 只读请求把新用量算进【响应】，不写回状态：recomputeOrganizationUsage(state) 会改 org.usage，
    // 而 GET 走的是共用只读那份（冻的）。同一份计算早就有不改状态的版本，视图那条一直在用。
    json(res, 200, {organizations: organizationsWithFreshUsage(state, state.organizations)});
    return;
  }

  const orgQuotaMatch = url.pathname.match(/^\/api\/orgs\/([^/]+)\/quotas$/);
  if (req.method === "POST" && orgQuotaMatch) {
    const guard = beginGuardedWrite(req, state, "org_quota_update", `Organization:${orgQuotaMatch[1]}`, {resourceType: "system", resourceId: "organizations"});
    if (guard.status) return json(res, guard.status, guard.payload);
    const organization = organizationOf(state, orgQuotaMatch[1]);
    if (!organization) return json(res, 404, {error: "organization_not_found"});
    // 一个配额都不给却回 200：什么也没改，而调用方以为改成功了。
    const quotaKeys = ["maxMembers", "maxProjects", "maxTaskGroups", "maxAgents"];
    if (!quotaKeys.some((key) => body.quotas?.[key] !== undefined || body[key] !== undefined)) {
      return json(res, 400, {error: "org_quota_update_empty", supported: quotaKeys,
        message: "改配额至少要给一项 —— 一项都不给时这条接口什么也不会改"});
    }
    // 【填了但认不出的配额要拒，不能悄悄保持原值】。判据与建组织共用（invalidQuotaEntries）。
    const invalidQuotas = invalidQuotaEntries(body);
    if (invalidQuotas.length) return json(res, 400, quotaInvalidPayload(invalidQuotas));
    for (const key of ["maxMembers", "maxProjects", "maxTaskGroups", "maxAgents"]) {
      if (body.quotas?.[key] !== undefined) organization.quotas[key] = boundedQuota(body.quotas[key], organization.quotas[key]);
      else if (body[key] !== undefined) organization.quotas[key] = boundedQuota(body[key], organization.quotas[key]);
    }
    organization.updatedAt = now();
    audit(state, guard.actor, "org_quota_update", `Organization:${organization.orgId}`);
    finishGuardedWrite(state, guard, 200, organization);
    writeState(state);
    json(res, 200, organization);
    return;
  }

  const orgStatusMatch = url.pathname.match(/^\/api\/orgs\/([^/]+)\/status$/);
  if (req.method === "POST" && orgStatusMatch) {
    const guard = beginGuardedWrite(req, state, "org_status_update", `Organization:${orgStatusMatch[1]}`, {resourceType: "system", resourceId: "organizations"});
    if (guard.status) return json(res, guard.status, guard.payload);
    const organization = organizationOf(state, orgStatusMatch[1]);
    if (!organization) return json(res, 404, {error: "organization_not_found"});
    // 缺省不得等于"启用"：空 body 原先会把组织置成 active —— 一个被停用的组织就这么被静默恢复，
    // 而停用本身是会级联停掉名下所有在跑执行的。与改成员状态同一形状、爆炸半径更大。
    if (!["active", "suspended"].includes(String(body.status || ""))) {
      return json(res, 400, {error: "org_status_required", supported: ["active", "suspended"],
        message: "改组织状态必须显式给出 status（active / suspended）—— 缺省不会被当作启用"});
    }
    const previousOrgStatus = organization.status;
    organization.status = body.status === "suspended" ? "suspended" : "active";
    organization.updatedAt = now();
    // 停用要覆盖【正在执行】的那一段，不能只挡住新建与认领。
    // 任务组"暂停"早就会向在跑的 agent 下 pause_dispatch（applyTaskGroupRuntimeControl），
    // 而组织停用此前只翻了一个字段：名下已经在跑的 agent 继续跑到底、继续推 git、继续烧额度，
    // 而控制台上写着"已停用"。这里复用同一套机制，逐个任务组施加，语义与暂停一致。
    const orgRuntimeControl = [];
    if (organization.status === "suspended" && previousOrgStatus !== "suspended") {
      const orgProjectIds = new Set((state.projects || [])
        .filter((project) => (project.organizationId || DEFAULT_ORGANIZATION_ID) === organization.orgId)
        .map((project) => project.id));
      for (const taskGroup of state.taskGroups || []) {
        if (!orgProjectIds.has(taskGroup.projectId)) continue;
        if (["closed", "aborted"].includes(taskGroup.status)) continue;
        const control = applyTaskGroupRuntimeControl(state, taskGroup, "pause",
          {actor: guard.actor, idempotencyKey: `${guard.idempotencyKey || "org-suspend"}:${taskGroup.id}`});
        if ((control.controlCommands || []).length || (control.directDispatches || []).length) {
          orgRuntimeControl.push({taskGroupId: taskGroup.id, ...control});
        }
      }
    }
    audit(state, guard.actor, "org_status_update", `Organization:${organization.orgId}`, organization.status);
    const orgStatusPayload = {...organization, ...(orgRuntimeControl.length ? {runtimeControl: orgRuntimeControl} : {})};
    finishGuardedWrite(state, guard, 200, orgStatusPayload);
    writeState(state);
    json(res, 200, orgStatusPayload);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/system/overview") {
    const reader = requireRead(req, state, {resourceType: "system", resourceId: "overview"});
    if (reader.status) return json(res, reader.status, reader.payload);
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const cpuSeconds = (cpu.user + cpu.system) / 1e6;
    const wattsPerCpu = clampEnvNumber(process.env.AIMAC_ENERGY_WATTS_PER_CPU, 0, 15);
    // 量不到的时候要回 null，不能回 0：界面会把 0 原样显示成"0 B"，
    // 而"存储占用 0 字节"是个看起来很正常、实际完全错误的数字 —— 人据此判断容量。
    // 分片目录里个别文件量不到，也要如实标出"这个数是不完整的"。
    let stateBytes = null;
    let projectDbBytes = null;
    let storagePartial = false;
    try { stateBytes = statSync(statePath).size; } catch { storagePartial = true; }
    try {
      const projectDbDir = join(runtimeDir, "project-db");
      if (existsSync(projectDbDir)) {
        projectDbBytes = 0;
        for (const name of readdirSync(projectDbDir)) {
          try { projectDbBytes += statSync(join(projectDbDir, name)).size; } catch { storagePartial = true; }
        }
      }
    } catch { storagePartial = true; }
    // 这里原先调 recomputeOrganizationUsage(state) —— 而这份响应只用到 organizations.length，
    // 重算出来的用量一个都没被读。也就是说这是一次纯副作用：读路径在改状态。
    // 用量该由写入方在改动之后重算（它们本来就在做），不该由一个 GET 顺手代劳。
    json(res, 200, {
      server: {platform: platform(), arch: arch(), hostname: hostname(), nodeVersion: process.version, uptimeSeconds: Math.round(process.uptime()), pid: process.pid},
      resources: {rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, cpuSeconds: Math.round(cpuSeconds), loadAverage: loadavg(), totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), cpuCount: cpus().length},
      energy: {estimatedWattHours: Math.round(cpuSeconds / 3600 * wattsPerCpu * 100) / 100, wattsPerCpuCoefficient: wattsPerCpu},
      storage: {centralStateBytes: stateBytes, projectDbBytes, stateStore: stateStoreKind(),
        ...(storagePartial ? {partial: true} : {})},
      runtime: {
        onlineNodes: (state.agentRuntimeNodes || []).filter((node) => node.status === "online").length,
        // 同上：已吊销的不算在"在线 X/Y"的 Y 里，否则半年前吊销的节点会一直让这个比值难看。
        totalNodes: (state.agentRuntimeNodes || []).filter((node) => node.status !== "revoked").length,
        organizations: state.organizations.length,
        projects: (state.projects || []).length,
        // 总数与"进行中"要分开给：重置运行态那个确认框问的是【会毁掉多少】，
        // 而它此前只能拿到进行中的数量（甚至拿不到，见控制台那一侧的注释）。
        taskGroups: (state.taskGroups || []).length,
        activeTaskGroups: (state.taskGroups || []).filter((taskGroup) => !["closed", "aborted"].includes(taskGroup.status)).length,
        stateVersion: state.stateVersion,
        auditChainHead: state.auditChainHead || null
      },
      at: now()
    });
    return;
  }

  // 审计归档的读取入口。内存里只留最近 80 条，更早的记录只在这份追加文件里 ——
  // 没有这个入口，"事后查得到"对 80 条之前的事就是假的。
  // 归档跨全部组织与项目，因此只对系统账号开放（canReadResource 对 system 作用域即此语义）。
  if (req.method === "GET" && url.pathname === "/api/audit-archive") {
    const reader = requireRead(req, state, {resourceType: "system", resourceId: "audit_archive"});
    if (reader.status) return json(res, reader.status, reader.payload);
    const requested = Number(url.searchParams.get("limit") || 200);
    const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 200, 1), 1000);
    const tail = readAuditArchiveTail(limit);
    json(res, 200, {
      entries: tail.entries,
      // 没读到的部分要说清楚，否则人会把这一屏当成全部历史。
      windowTruncated: tail.truncated,
      fileBytes: tail.fileBytes,
      bytesScanned: tail.bytesScanned,
      chain: verifyAuditChain(tail.entries),
      // 读的必须是共享台账那份（模块变量），不是 state 上的字段 —— 后者全仓从没被赋过值，
      // 于是这个字段一直是 null：归档写失败过之后，人打开【专门查历史的这一屏】毫无察觉。
      // 概览页那条横幅是好的，因为它读的是视图里注入的那份；两处来源不同，只修好了一处。
      archiveFault: sharedAuditArchiveFault(),
      at: now()
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/change-password") {
    const authenticated = accountFromRequest(req, state);
    if (!authenticated) return json(res, 401, {error: "auth_required"});
    const newPassword = String(body.newPassword || "");
    if (newPassword.length < 8) return json(res, 400, {error: "password_too_short", minLength: 8});
    const account = authenticated.account;
    if (account.passwordDigest) {
      const currentOk = Boolean(body.currentPassword) && verifyAccountPassword(account, body.currentPassword).ok;
      if (!currentOk) return json(res, 403, {error: "current_password_incorrect"});
    }
    account.passwordDigest = newPasswordDigest(newPassword);
    // 改密码是"我怀疑被盗号"时唯一的自救手段，而它原先不动任何会话 —— 已泄露的令牌最长还能再用
    // 8 小时，系统也没有"登出其他设备"的入口。改密即撤销该账号的全部会话（含当前这条，
    // 调用方重新登录即可），否则这个动作对攻击者没有任何影响。
    revokeAccountSessions(state, account.accountId, "password_changed");
    account.authPolicy = {...(account.authPolicy || {}), method: account.authPolicy?.method || "password", passwordSet: true};
    account.updatedAt = now();
    audit(state, account.accountId, "auth_change_password", `Account:${account.accountId}`);
    commitUnguardedWrite(state);
    json(res, 200, {ok: true, accountId: account.accountId, passwordSet: true});
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/org/members") {
    const actorAccount = accountFromRequest(req, state)?.account;
    const orgId = actorAccount?.organizationId;
    const guard = beginGuardedWrite(req, state, "org_member_create", `Organization:${orgId || "unknown"}`, {resourceType: "organization", resourceId: orgId});
    if (guard.status) return json(res, guard.status, guard.payload);
    const quota = organizationQuotaCheck(state, orgId, "members");
    if (!quota.allowed) return json(res, 409, {error: quota.error, quota: quota.quota, usage: quota.usage, kind: quota.kind});
    if (body.email && (state.accounts || []).some((item) => sameEmail(item.email, body.email))) {
      return json(res, 409, {error: "account_email_already_registered"});
    }
    const at = now();
    const accountId = createId("acct");
    const memberToken = `aimac_account_${randomBytes(32).toString("base64url")}`;
    const permissions = sanitizeMemberPermissions(body.permissions, ["project:view"]);
    // 【默认项目要指得到、且还能开工】。这个字段原先原样收下：可以指向一个已归档的项目
    //（新成员一进来就落在一个开不了新工作的项目上），也可以指向一个根本不存在的 id，
    // 而两种都不会有任何提示。与入网令牌那条同一口径 —— 归档意味着"移出可建新工作的范围"。
    const defaultProjectRefusal = validateDefaultProject(state, body.defaultProjectId, orgId);
    if (defaultProjectRefusal) return json(res, 400, defaultProjectRefusal);
    const orgMemberRoles = normalizeStringList(body.roles, ["member"]).filter((role) => role !== "system_admin" && role !== "org_admin");
    {
      const unknownRoles = unknownAccountRoles(orgMemberRoles);
      if (unknownRoles.length) {
        return json(res, 400, {error: "account_role_unknown", unknownRoles: unknownRoles.slice(0, 10), supported: ACCOUNT_ROLES,
          message: "账号角色不在词表里：这些名字界面显示不出、判权时谁也不认"});
      }
    }
    const member = {
      schemaVersion: "account/v1",
      accountId,
      accountType: "user_account",
      organizationId: orgId,
      displayName: String(body.displayName || "新成员"),
      email: String(body.email || `member-${Date.now()}@local`),
      status: "invited",
      roles: orgMemberRoles,
      permissions,
      defaultProjectId: body.defaultProjectId || null,
      authPolicy: {method: "invite_token", mfaRequired: false, passwordSet: false, sessionTtlSeconds: 28800},
      credentialDigest: digestOf(`account-invite:${accountId}:${memberToken}`),
      credentialIssuedAt: at,
      credentialExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      createdAt: at,
      updatedAt: at
    };
    state.accounts.unshift(member);
    recomputeOrganizationUsage(state);
    audit(state, guard.actor, "org_member_create", `Account:${accountId}`);
    finishGuardedWrite(state, guard, 201, publicAccountRecord(member));
    writeState(state);
    json(res, 201, {account: publicAccountRecord(member), accountToken: memberToken, login: {email: member.email, tokenField: "accountToken"}});
    return;
  }

  const orgMemberPermMatch = url.pathname.match(/^\/api\/org\/members\/([^/]+)\/permissions$/);
  if (req.method === "POST" && orgMemberPermMatch) {
    const actorAccount = accountFromRequest(req, state)?.account;
    const target = resolveOrgMemberTarget(state, actorAccount, orgMemberPermMatch[1]);
    const guard = beginGuardedWrite(req, state, "org_member_permissions_update", `Account:${orgMemberPermMatch[1]}`, target.scope);
    if (guard.status) return json(res, guard.status, guard.payload);
    const member = target.member && target.member.accountType !== "org_admin" ? target.member : null;
    if (!member) return json(res, 404, {error: "org_member_not_found"});
    // 两样都不给等于什么都没说，却回 200 —— 调用方以为改成功了。至少要给一样。
    if (body.permissions === undefined && body.defaultProjectId === undefined) {
      return json(res, 400, {error: "member_permissions_update_empty",
        message: "改成员授权至少要给 permissions 或 defaultProjectId 之一 —— 两样都不给时这条接口什么也不会改"});
    }
    member.permissions = sanitizeMemberPermissions(body.permissions, member.permissions || ["project:view"]);
    if (body.defaultProjectId !== undefined) {
      // 同上：改成员的默认项目也要指得到、且还能开工（这条路原先也是原样收下）。
      const refusal = validateDefaultProject(state, body.defaultProjectId, member.organizationId || DEFAULT_ORGANIZATION_ID);
      if (refusal) return json(res, 400, refusal);
      member.defaultProjectId = body.defaultProjectId || null;
    }
    member.updatedAt = now();
    audit(state, guard.actor, "org_member_permissions_update", `Account:${member.accountId}`);
    finishGuardedWrite(state, guard, 200, publicAccountRecord(member));
    writeState(state);
    json(res, 200, publicAccountRecord(member));
    return;
  }

  // 一次性邀请令牌只显示一次。原先它一丢，账号就报废：没有重发路径，邮箱唯一性又拦住重建，
  // 于是只能换个邮箱新建，旧账号变成僵尸并继续占着组织成员配额。而它的两条登录路径此时都是断的
  // （邀请分支要 status==="invited" 且凭据未消费，密码分支要 passwordDigest，邀请态没有）。
  // 这里补上唯一缺的那一环：重新铸一份一次性凭据。旧的当场失效 —— 重发不是"再给一份"，
  // 是"作废旧的、换一份"，否则丢在聊天记录里的那一份仍然能用。
  const orgMemberReissueMatch = url.pathname.match(/^\/api\/org\/members\/([^/]+)\/reissue-invite$/);
  if (req.method === "POST" && orgMemberReissueMatch) {
    const reissueActor = accountFromRequest(req, state)?.account;
    const reissueTarget = resolveOrgMemberTarget(state, reissueActor, orgMemberReissueMatch[1]);
    const guard = beginGuardedWrite(req, state, "org_member_invite_reissue", `Account:${orgMemberReissueMatch[1]}`,
      reissueTarget.scope);
    if (guard.status) return json(res, guard.status, guard.payload);
    const member = reissueTarget.member;
    if (!member) return json(res, 404, {error: "org_member_not_found"});
    // 被撤回的邀请（invited→disabled）也走这里：它同样从没接受过，两条登录路径同样是断的，
    // 而"先停用再重新邀请"这句原话在没有这一支时是空的 —— 邮箱唯一性拦住重建、配额还占着。
    if (member.status !== "invited" && !member.invitationWithdrawn) {
      return json(res, 409, {error: "org_member_invite_reissue_not_applicable",
        message: "只有尚未接受邀请的成员可以重发邀请；已激活的账号请让本人用「修改密码」自行设置，或先停用再重新邀请"});
    }
    const reissuedToken = randomBytes(24).toString("base64url");
    const reissuedAt = now();
    member.credentialDigest = digestOf(`account-invite:${member.accountId}:${reissuedToken}`);
    member.credentialIssuedAt = reissuedAt;
    member.credentialExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    delete member.credentialConsumedAt;
    // 重发即把它放回"等待接受邀请"的状态：撤回标记要一起清掉，否则新令牌发出去了，
    // 人拿着它登录时账号还是 disabled，登不进来。
    member.status = "invited";
    delete member.invitationWithdrawn;
    member.updatedAt = reissuedAt;
    revokeAccountSessions(state, member.accountId, "invite_reissued");
    audit(state, guard.actor, "org_member_invite_reissue", `Account:${member.accountId}`);
    const reissuePayload = {account: publicAccountRecord(member), accountToken: reissuedToken,
      login: {email: member.email, tokenField: "accountToken"}};
    // 幂等记录里【不存】明文令牌：它会随 view=full 一起发出去，而且长期留在状态里。
    // 同批的 /api/accounts 邀请与 /api/agent-join-tokens 都是只存脱敏记录 —— 这条漏了。
    // 重放拿不到令牌是有意的：一次性凭据只出现一次，重放的人本来就已经收到过那一份。
    finishGuardedWrite(state, guard, 200, {account: reissuePayload.account,
      login: reissuePayload.login, secretReturnedOnce: true});
    writeState(state);
    json(res, 200, reissuePayload);
    return;
  }

  // 【注销账号】单独一条路由，不和上面那个可恢复的启用/停用开关挤在一起：
  // 一条路由服务两种风险等级，人点错一次的代价差着数量级，而守卫也只能按一个动作名分类。
  const orgMemberRetireMatch = url.pathname.match(/^\/api\/org\/members\/([^/]+)\/retire$/);
  if (req.method === "POST" && orgMemberRetireMatch) {
    const retireActor = accountFromRequest(req, state)?.account;
    const retireTarget = resolveOrgMemberTarget(state, retireActor, orgMemberRetireMatch[1]);
    const guard = beginGuardedWrite(req, state, "account_retire", `Account:${orgMemberRetireMatch[1]}`, retireTarget.scope);
    if (guard.status) return json(res, guard.status, guard.payload);
    if (!retireTarget.member) return json(res, 404, {error: "org_member_not_found"});
    const result = retireAccount(state, retireTarget.member.accountId,
      {actor: guard.actor, reason: body.reason, auditRef: `audit:account-retire:${retireTarget.member.accountId}`});
    if (!result.ok) return json(res, result.status, {error: result.error, ...(result.message ? {message: result.message} : {})});
    recomputeOrganizationUsage(state);
    audit(state, guard.actor, "account_retire", `Account:${result.account.accountId}`, "retired");
    // 回执要说清【这一下动了什么】：光回一个 status 的话，人不知道会话/授权有没有一起断，
    // 而那正是"注销"与"停用"的区别所在。
    const payload = {account: publicAccountRecord(result.account), revokedSessions: result.revokedSessions,
      revokedGrants: result.revokedGrants, credentialCleared: result.credentialCleared};
    finishGuardedWrite(state, guard, 200, payload);
    writeState(state);
    json(res, 200, payload);
    return;
  }

  const orgMemberStatusMatch = url.pathname.match(/^\/api\/org\/members\/([^/]+)\/status$/);
  if (req.method === "POST" && orgMemberStatusMatch) {
    const actorAccount = accountFromRequest(req, state)?.account;
    const target = resolveOrgMemberTarget(state, actorAccount, orgMemberStatusMatch[1]);
    const orgId = target.orgId;
    const guard = beginGuardedWrite(req, state, "org_member_status_update", `Account:${orgMemberStatusMatch[1]}`, target.scope);
    if (guard.status) return json(res, guard.status, guard.payload);
    // 原先把 org_admin 整个排除在外：组织管理员离职之后，控制台上没有任何入口能让它下线，
    // 只能靠系统管理员专属的 MCP 工具。现在允许停用，但不得把组织锁死 —— 至少要留一个活跃管理员。
    const member = target.member;
    if (!member) return json(res, 404, {error: "org_member_not_found"});
    // 缺省不得等于"启用"：空 body 打过来原先会把成员置成 active —— 一个被停用的账号
    // 就这么被静默恢复了（实测 200）。认不出的取值也一样要拒，并把合法值列出来。
    // 2026-08-26：落下去的状态一律用规范里声明过的那个 —— suspended。
    // 此前这条路写的是 disabled，而 spec/account.schema.json 与状态机里【都没有这个值】：
    // 两个名字一件事，而规范那份从来没被强制过。入参上继续认 disabled（老客户端、
    // 界面上那个按钮都在用它），但永不再写进状态里。
    if (!["active", "disabled", "suspended"].includes(String(body.status || ""))) {
      // 字段名用仓里既有的 supported：控制台已经会把它渲染成「可用的取值：…」。
      // 自己新造一个 allowed 的话，服务端算出来了、界面一处都不读 —— 出错那一刻人还是得猜。
      return json(res, 400, {error: "member_status_required", supported: ["active", "suspended"],
        message: "改成员状态必须显式给出 status（active / suspended）—— 缺省不会被当作启用"});
    }
    const nextMemberStatus = ["disabled", "suspended"].includes(body.status) ? "suspended" : "active";
    // 治理主体不能被停到零。原先只写了 org_admin 这一支，而系统管理员的 organizationId 是 null、
    // 与它自己调用时的 orgId 恰好相等，所以这条路由够得着它 —— 全新部署里唯一的系统管理员可以把
    // 自己停掉：会话当场吊销、无法登录，而铸一个新的系统管理员要 system:account_admin，
    // 于是整个部署永久失去系统层控制权。作用域按治理层级取：组织管理员按本组织算，系统管理员按全局算。
    if (nextMemberStatus === "suspended" && ["org_admin", "system_admin"].includes(member.accountType)) {
      const systemScoped = member.accountType === "system_admin";
      const remainingAdmins = (state.accounts || []).filter((item) => item.accountType === member.accountType
        && item.status === "active" && item.accountId !== member.accountId
        && (systemScoped || item.organizationId === orgId));
      if (!remainingAdmins.length) {
        return json(res, 409, {error: systemScoped ? "system_last_admin_cannot_be_disabled" : "org_last_admin_cannot_be_disabled"});
      }
    }
    // 原先任何非 disabled 的入参一律置为 active。对一个【尚未接受邀请】的账号执行之后：
    // 邀请令牌分支要求 status === "invited"（断了），密码分支要求 passwordDigest（邀请态没有，也断了），
    // 而系统没有重发邀请或重置密码的接口 —— 两条登录路径全断、无法恢复，且仍占着成员配额。
    // 判据不能只看【当前是不是 invited】：先停用（invited→disabled）再启用，两步就把同一个僵尸
    // 洗成了 active —— 实测过，账号显示 active、登录回 invalid_credentials、仍占配额。
    // 所以在【撤回那一刻】留一个持久标记，而不是事后去猜这个账号当初有没有接受过邀请
    // （种子账号从来就是 active、没有 activatedAt，拿那些字段当判据会误伤它们）。
    if (nextMemberStatus === "active" && (member.status === "invited" || member.invitationWithdrawn)) {
      return json(res, 409, {error: "org_member_invitation_pending", message: "该成员尚未接受邀请，置为 active 会让它两条登录路径全断且无法恢复；请用「重发邀请」给它一份新的一次性令牌"});
    }
    if (nextMemberStatus === "suspended" && member.status === "invited") member.invitationWithdrawn = true;
    member.status = nextMemberStatus;
    member.updatedAt = now();
    if (member.status === "suspended") revokeAccountSessions(state, member.accountId, "member_disabled");
    recomputeOrganizationUsage(state);
    audit(state, guard.actor, "org_member_status_update", `Account:${member.accountId}`, member.status);
    finishGuardedWrite(state, guard, 200, publicAccountRecord(member));
    writeState(state);
    json(res, 200, publicAccountRecord(member));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/org/members") {
    const reader = accountFromRequest(req, state);
    if (!reader) return json(res, 401, {error: "auth_required"});
    const orgId = isSystemAccount(reader.account) ? (url.searchParams.get("orgId") || DEFAULT_ORGANIZATION_ID) : reader.account.organizationId;
    if (!orgId) return json(res, 400, {error: "organization_required"});
    if (!isSystemAccount(reader.account) && !canReadResource(state, reader.account, {resourceType: "organization", resourceId: orgId})) {
      return json(res, 403, {error: "permission_denied"});
    }
    // 授权只比对"你属不属于这个组织"，于是任何普通项目成员都能拿到全组织通讯录：
    // email、roles、直接 permissions、authPolicy（是否设了密码/是否要 MFA）—— 一份现成的权限侦察清单。
    // 而 /api/state 那条路径特意把 accounts 收窄成"自己 + 可见项目的成员"并把他人 permissions 清空。
    // 同一份数据两道门，只锁了一道。这里与它同规：
    // 只有确实负责成员管理的人（member:invite / org:member_admin）才看得到完整记录，
    // 其余人看到的是不含权限与认证配置的最小视图。
    const canAdminMembers = isSystemAccount(reader.account)
      || reader.account.accountType === "org_admin"
      || hasPermission(state, accountIdOf(reader.account), "member:invite", {resourceType: "organization", resourceId: orgId});
    const members = (state.accounts || [])
      // 与配额用量共用同一处判据：两边各写各的时，默认组织的"成员 N/50"里含着列表上
      // 永远不出现的账号，配额满了人却找不到该停用谁。
      .filter((item) => organizationMembershipOf(item) === orgId)
      .map((item) => {
        const isSelf = accountIdOf(item) === accountIdOf(reader.account);
        if (canAdminMembers || isSelf) {
          return {...publicAccountRecord(item), organizationId: item.organizationId, defaultProjectId: item.defaultProjectId || null};
        }
        // 最小视图：够用来"知道组织里有谁"，不够用来侦察谁有什么权限、谁还没设密码。
        return {accountId: item.accountId, displayName: item.displayName, accountType: item.accountType,
          status: item.status, organizationId: item.organizationId};
      });
    json(res, 200, {orgId, members});
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/org/agents") {
    const reader = accountFromRequest(req, state);
    if (!reader) return json(res, 401, {error: "auth_required"});
    const orgId = isSystemAccount(reader.account) ? (url.searchParams.get("orgId") || DEFAULT_ORGANIZATION_ID) : reader.account.organizationId;
    if (!orgId) return json(res, 400, {error: "organization_required"});
    if (!isSystemAccount(reader.account) && reader.account.organizationId !== orgId) return json(res, 403, {error: "permission_denied"});
    const nodes = (state.agentRuntimeNodes || [])
      .filter((node) => (node.organizationId || DEFAULT_ORGANIZATION_ID) === orgId)
      .map((node) => ({
        ...publicAgentNode(node),
        display: {
          region: node.profile?.region || null,
          dataRoot: node.profile?.dataRoot || null,
          health: node.status === "online" ? (node.admission === "full" ? "healthy" : "limited") : node.status,
          currentDispatchIds: node.activeDispatchIds || [],
          networkSpeedMbps: node.profile?.networkSpeedMbps || null,
          models: (node.profile?.models || []).filter((model) => model.available !== false).map((model) => model.providerClass)
        }
      }));
    json(res, 200, {orgId, agentRuntimeNodes: nodes});
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/org/projects") {
    const actorAccount = accountFromRequest(req, state)?.account;
    const orgId = actorAccount?.organizationId;
    const guard = beginGuardedWrite(req, state, "org_project_create", `Organization:${orgId || "unknown"}`, {resourceType: "organization", resourceId: orgId});
    if (guard.status) return json(res, guard.status, guard.payload);
    const quota = organizationQuotaCheck(state, orgId, "projects");
    if (!quota.allowed) return json(res, 409, {error: quota.error, quota: quota.quota, usage: quota.usage, kind: quota.kind});
    const id = createId("prj");
    state.projects.push({
      schemaVersion: "project/v1",
      id,
      organizationId: orgId,
      name: assertHumanTextWithinLimit(String(body.name || "").trim() || "未命名项目", "project_name", 200),
      status: "active",
      ownerAccountId: guard.actor,
      members: [{accountId: guard.actor, role: "project_owner"}],
      config: {
        repositories: Array.isArray(body.repositories) ? body.repositories : [],
        baselineData: [],
        businessRules: [],
        defaultRoles: []
      },
      progress: {percent: 0, phase: "intake", health: "ok", openTaskGroups: 0, blockedItems: 0, updatedAt: now()},
      createdAt: now(),
      updatedAt: now()
    });
    const ownerGrant = ensureProjectOwnerGrant(state, state.projects.at(-1), guard.actor, guard.policyDecision.id, `audit:${guard.idempotencyKey}`);
    recomputeOrganizationUsage(state);
    audit(state, guard.actor, "org_project_create", `Project:${id}`);
    finishGuardedWrite(state, guard, 201, {id, ownerGrant});
    writeState(state);
    json(res, 201, {id, ownerGrant});
    return;
  }

  const humanConfirmationListMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/human-confirmations$/);
  if (req.method === "GET" && humanConfirmationListMatch) {
    const reader = requireRead(req, state, taskGroupScope(state, humanConfirmationListMatch[1]));
    if (reader.status) return json(res, reader.status, reader.payload);
    json(res, 200, {humanConfirmationRequests: (state.humanConfirmationRequests || []).filter((item) => item.taskGroupId === humanConfirmationListMatch[1])});
    return;
  }

  const humanConfirmationDecideMatch = url.pathname.match(/^\/api\/human-confirmations\/([^/]+)\/decide$/);
  if (req.method === "POST" && humanConfirmationDecideMatch) {
    const target = (state.humanConfirmationRequests || []).find((item) => item.requestId === humanConfirmationDecideMatch[1]);
    const guard = beginGuardedWrite(req, state, "human_confirmation_decide", `HumanConfirmationRequest:${humanConfirmationDecideMatch[1]}`, target ? taskGroupScope(state, target.taskGroupId) : {resourceType: "system", resourceId: "human_confirmations"});
    if (guard.status) return json(res, guard.status, guard.payload);
    let decided;
    try {
      decided = decideHumanConfirmation(state, humanConfirmationDecideMatch[1], body, {actor: guard.actor});
    } catch (error) {
      // 这条路由原先只回传 error.message，把核心函数特意附带的字段全丢了：轮次过期时人拿不到
      // 当前轮次，被别人抢先定稿时拿不到"是谁、定了什么"。这些字段正是这两种冲突下人唯一需要的东西。
      return json(res, error.status || 500, {...(error.details || {}), error: error.message,
        ...(error.currentRound !== undefined ? {currentRound: error.currentRound} : {}),
        ...(error.currentStatus !== undefined ? {currentStatus: error.currentStatus} : {}),
        ...(error.decidedBy ? {decidedBy: error.decidedBy} : {}),
        ...(error.decidedAt ? {decidedAt: error.decidedAt} : {}),
        ...(error.decidedAction ? {decidedAction: error.decidedAction} : {}),
        ...(error.decidedOption ? {decidedOption: error.decidedOption} : {}),
        ...(error.subjectRef ? {subjectRef: error.subjectRef} : {})});
    }
    // 定稿是这套系统的立身动作：审计不只要记"谁决定了"，还要记【决定是什么】——
    // 否则事后只知道有人处置过这张卡，答不出他是定稿、打回、还是选了哪个方案。
    audit(state, guard.actor, "human_confirmation_decide", `HumanConfirmationRequest:${decided.requestId}`,
      decided.decision?.action || decided.status);
    finishGuardedWrite(state, guard, 200, decided);
    writeState(state);
    json(res, 200, decided);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/human-directives") {
    const guard = beginGuardedWrite(req, state, "human_directive_create", `TaskGroup:${body.taskGroupId || body.projectId || "unknown"}`, body.taskGroupId ? taskGroupScope(state, body.taskGroupId) : projectScope(body.projectId));
    if (guard.status) return json(res, guard.status, guard.payload);
    let directive;
    try {
      directive = createHumanDirective(state, body, {actor: guard.actor});
    } catch (error) {
      // 带上错误自己挂的细节（认不出的类型要连合法清单一起给）：只回一个码，调用方只能猜。
      // 与 state_view_unknown 那条同规。
      // 【抛出的那个码永远赢】。原先 error 写在最前面，后面的 ...details 展开时会把它盖掉 ——
      // 而 message 按本仓的纪律就是【稳定错误码】（人话放 details）。今天 13 处带 details 的抛错
      // 里没有一处不一致，所以这不是在修一个现存缺陷，而是把这类静默替换变成结构上不可能：
      // 谁将来在 details 里写一个 error 字段，客户端与 e2e 断言看到的码都不会被悄悄换掉。
      return json(res, error.status || 500, {
        ...(error.directiveType ? {directiveType: error.directiveType} : {}),
        ...(error.supported ? {supported: error.supported} : {}),
        ...(error.details || {}),
        error: error.message});
    }
    const controlAction = {pause: "pause", resume: "resume", cancel: "cancel"}[directive.directiveType];
    const directiveTaskGroup = directive.taskGroupId ? state.taskGroups.find((item) => item.id === directive.taskGroupId) : null;
    if (controlAction && directiveTaskGroup) {
      if (directive.directiveType === "pause") directiveTaskGroup.goalExecutionStatus = "active_paused_by_freeze";
      if (directive.directiveType === "resume") {
        directiveTaskGroup.goalExecutionStatus = "active";
        delete directiveTaskGroup.pauseReason;
      }
      if (directive.directiveType === "cancel") {
        directiveTaskGroup.goalExecutionStatus = "active_paused_by_freeze";
        directiveTaskGroup.pauseReason = "human_directive_cancel";
      }
      const runtimeControl = applyTaskGroupRuntimeControl(state, directiveTaskGroup, controlAction, {actor: guard.actor, idempotencyKey: `human-directive:${directive.directiveId}`});
      directive.status = "applied";
      directive.appliedActions = [{action: `task_group_${controlAction}`, ref: `TaskGroup:${directiveTaskGroup.id}`}];
      directive.runtimeControl = {controlCommands: runtimeControl.controlCommands.map((command) => command.commandId), directDispatches: runtimeControl.directDispatches, resumedDispatches: runtimeControl.resumedDispatches};
      directive.updatedAt = now();
      directiveTaskGroup.updatedAt = now();
    }
    audit(state, guard.actor, "human_directive_create", `HumanDirective:${directive.directiveId}`);
    finishGuardedWrite(state, guard, 201, directive);
    writeState(state);
    json(res, 201, directive);
    return;
  }

  const humanDirectiveListMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/human-directives$/);
  if (req.method === "GET" && humanDirectiveListMatch) {
    const reader = requireRead(req, state, taskGroupScope(state, humanDirectiveListMatch[1]));
    if (reader.status) return json(res, reader.status, reader.payload);
    json(res, 200, {humanDirectives: (state.humanDirectives || []).filter((item) => item.taskGroupId === humanDirectiveListMatch[1])});
    return;
  }

  // 项目此前【没有任何终结路径】：project.status 在全仓一个写入点都没有，而配额统计排除的是
  // status !== "deleted" —— 那个状态既不在模型里（模型是 active → archived）、也没有任何代码写它，
  // 于是那条排除永远为真。结果：maxProjects 只增不减，一个组织把项目建满之后再也建不了新的，
  // 而它手上没有任何杠杆。这是空转判据长在配额统计里的一例。
  // 白名单式投影：项目记录目前没有敏感字段，但这次会话里已经见过两次"黑名单投影随着新字段一起漏"。
  const projectSummary = (project) => ({
    id: project.id, name: project.name, status: project.status || "active",
    organizationId: project.organizationId || null, archivedAt: project.archivedAt || null,
    updatedAt: project.updatedAt || null
  });
  const projectArchiveMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/archive$/);
  if (req.method === "POST" && projectArchiveMatch) {
    const guard = beginGuardedWrite(req, state, "project_archive", `Project:${projectArchiveMatch[1]}`, projectScope(projectArchiveMatch[1]));
    if (guard.status) return json(res, guard.status, guard.payload);
    const project = state.projects.find((item) => item.id === projectArchiveMatch[1]);
    if (!project) return json(res, 404, {error: "project_not_found"});
    if (project.status === "archived") return json(res, 200, projectSummary(project));
    // 不级联终结：把一个还有活干的项目归档掉，等于替人把那些工作组一并处置了，而人并没有做这个判断。
    // 说清还剩哪些，让他自己收尾。
    const openGroups = (state.taskGroups || []).filter((item) => item.projectId === project.id
      && !["closed", "aborted"].includes(item.status));
    if (openGroups.length) {
      return json(res, 409, {error: "project_has_open_task_groups",
        message: `该项目还有 ${openGroups.length} 个未终结的任务组，请先逐个关闭或中止它们；归档不会替你处置它们`,
        openTaskGroupIds: openGroups.map((item) => item.id).slice(0, 20)});
    }
    project.status = "archived";
    project.archivedAt = now();
    project.updatedAt = now();
    recomputeOrganizationUsage(state);
    audit(state, guard.actor, "project_archive", `Project:${project.id}`);
    finishGuardedWrite(state, guard, 200, projectSummary(project));
    writeState(state);
    json(res, 200, projectSummary(project));
    return;
  }

  // 配置层的版本 = 被覆盖的那一层的内容摘要。取的是【存储层】而不是合并后的有效视图 ——
  // 前提要挡的是"我覆盖的东西在我读到之后被别人改过"，与继承来的默认值无关。
  //
  // 为什么需要它：规则保存是整数组替换，而全局 stateVersion 的 CAS 只覆盖服务端读到写的亚秒窗口，
  // 覆盖不了人类的编辑会话。两个人先后保存，后者会静默删掉前者新增的规则，两人都拿到 200。
  // 丢的正是安全规则与业务规则本身，而且不留痕（审计只记"配置已更新"，不记内容差异）。
  const configLayerVersion = (layer) => digestOf(layer || {}).slice(7, 23);
  // 只有这些字段是"整份替换"的，丢数据的风险在它们身上；只改语言策略之类的不受影响。
  const REPLACING_CONFIG_FIELDS = ["systemRules", "businessRules", "repositories", "baselineData", "defaultRoles"];
  const configPreconditionFailure = (body, layer) => {
    if (!REPLACING_CONFIG_FIELDS.some((field) => body[field] !== undefined)) return null;
    const current = configLayerVersion(layer);
    if (body.expectedConfigVersion === undefined) {
      return {error: "config_version_required",
        message: "保存整份规则/配置必须带上你读到的那一版的 expectedConfigVersion，否则会静默覆盖别人在此期间的改动",
        currentConfigVersion: current};
    }
    if (String(body.expectedConfigVersion) !== current) {
      return {error: "config_version_stale",
        // 原文是"请刷新后把你的修改重做一遍"，比事实糟：提交失败时表单内容是被回填保住的，
        // 不必重打。但也不能只说"内容还在"——版本号仍是旧的，不刷新就再点保存，还是同一个 409。
        // 两件事都要说，人才知道下一步到底该怎么走。
        message: "这一层配置在你打开之后被别人改过了：直接保存会删掉对方的改动。你刚填的内容还留在表单里，先复制出来，再刷新看对方改了什么，然后重新提交（不刷新的话再点保存还是同一个错——版本号还是旧的）",
        currentConfigVersion: current};
    }
    return null;
  };

  const projectConfigMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/config$/);
  if (req.method === "GET" && projectConfigMatch) {
    const resolved = readableProjectOr403(req, state, projectConfigMatch[1]);
    if (resolved.denial) return json(res, resolved.denial.status, resolved.denial.payload);
    const project = resolved.project;
    json(res, 200, {projectId: project.id, config: redactProjectConfig(effectiveProjectConfig(project)),
      configVersion: configLayerVersion(project.config)});
    return;
  }
  if (req.method === "POST" && projectConfigMatch) {
    if (projectHiddenFromActor(req, state, projectConfigMatch[1])) return json(res, 403, {error: "permission_denied"});
    const ruleErr = ruleFragmentsRejection(body.systemRules) || ruleFragmentsRejection(body.businessRules);
    // 白名单式拒绝要把白名单一起给：只回一个 rule_status_unknown，调用方不知道该写什么。
    if (ruleErr) {
      return json(res, 422, {error: ruleErr, limits: {rules: 200, title: 256, content: 8192},
        ...(ruleErr === "rule_status_unknown" ? {allowedStatuses: RULE_STATUSES} : {})});
    }
    const guard = beginGuardedWrite(req, state, "project_config_update", `Project:${projectConfigMatch[1]}`, projectScope(projectConfigMatch[1]));
    if (guard.status) return json(res, guard.status, guard.payload);
    const project = state.projects.find((item) => item.id === projectConfigMatch[1]);
    if (!project) {
      const denial = missingProjectDenial(guard.actorAccount || accountFromRequest(req, state)?.account);
      return json(res, denial.status, denial.payload);
    }
    // 归档之后改配置改不出任何效果：那个项目不在概览里、编排也跳过它。
    // 而这一页的项目切换器是列得出已归档项目的，人选中它、点「保存项目配置」，回执还是 200。
    const archivedForConfig = projectArchivedRefusal(project, "不能再改它的配置");
    if (archivedForConfig) return json(res, 409, archivedForConfig);
    const projectPrecondition = configPreconditionFailure(body, project.config);
    if (projectPrecondition) return json(res, 409, projectPrecondition);
    const unknownProjectDefaultRoles = unregisteredDefaultRoles(body.defaultRoles);
    if (unknownProjectDefaultRoles.length) return json(res, 400, defaultRoleRefusal(unknownProjectDefaultRoles));
    project.config = {
      ...(project.config || {}),
      ...(body.repositories !== undefined ? {repositories: sanitizeRepositoryConfigs(body.repositories, project.config?.repositories || [])} : {}),
      ...(body.baselineData !== undefined ? {baselineData: Array.isArray(body.baselineData) ? body.baselineData : []} : {}),
      ...(body.businessRules !== undefined ? {businessRules: sanitizeRuleFragments(body.businessRules)} : {}),
      ...(body.systemRules !== undefined ? {systemRules: sanitizeRuleFragments(body.systemRules)} : {}),
      ...(body.defaultRoles !== undefined ? {defaultRoles: Array.isArray(body.defaultRoles) ? body.defaultRoles : []} : {})
    };
    project.updatedAt = now();
    audit(state, guard.actor, "project_config_update", `Project:${project.id}`);
    const publicConfig = redactProjectConfig(project.config);
    finishGuardedWrite(state, guard, 200, publicConfig);
    writeState(state);
    json(res, 200, {projectId: project.id, config: publicConfig, configVersion: configLayerVersion(project.config)});
    return;
  }

  const taskGroupConfigMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/config$/);
  if (req.method === "GET" && taskGroupConfigMatch) {
    const reader = requireRead(req, state, taskGroupScope(state, taskGroupConfigMatch[1]));
    if (reader.status) return json(res, reader.status, reader.payload);
    const taskGroup = state.taskGroups.find((item) => item.id === taskGroupConfigMatch[1]);
    if (!taskGroup) return json(res, 404, {error: "task_group_not_found"});
    json(res, 200, {taskGroupId: taskGroup.id, config: redactProjectConfig(effectiveTaskGroupConfig(state, taskGroup)),
      configVersion: configLayerVersion(taskGroup.configOverrides)});
    return;
  }
  if (req.method === "POST" && taskGroupConfigMatch) {
    const ruleErr = ruleFragmentsRejection(body.systemRules) || ruleFragmentsRejection(body.businessRules);
    // 白名单式拒绝要把白名单一起给：只回一个 rule_status_unknown，调用方不知道该写什么。
    if (ruleErr) {
      return json(res, 422, {error: ruleErr, limits: {rules: 200, title: 256, content: 8192},
        ...(ruleErr === "rule_status_unknown" ? {allowedStatuses: RULE_STATUSES} : {})});
    }
    const guard = beginGuardedWrite(req, state, "task_group_config_update", `TaskGroup:${taskGroupConfigMatch[1]}`, taskGroupScope(state, taskGroupConfigMatch[1]));
    if (guard.status) return json(res, guard.status, guard.payload);
    const taskGroup = state.taskGroups.find((item) => item.id === taskGroupConfigMatch[1]);
    if (!taskGroup) return json(res, 404, {error: "task_group_not_found"});
    const taskGroupPrecondition = configPreconditionFailure(body, taskGroup.configOverrides);
    if (taskGroupPrecondition) return json(res, 409, taskGroupPrecondition);
    const unknownTaskGroupDefaultRoles = unregisteredDefaultRoles(body.defaultRoles);
    if (unknownTaskGroupDefaultRoles.length) return json(res, 400, defaultRoleRefusal(unknownTaskGroupDefaultRoles));
    const mergedOverrides = {
      ...(taskGroup.configOverrides || {}),
      ...(body.repositories !== undefined ? {repositories: Array.isArray(body.repositories) ? body.repositories : []} : {}),
      ...(body.baselineData !== undefined ? {baselineData: Array.isArray(body.baselineData) ? body.baselineData : []} : {}),
      ...(body.businessRules !== undefined ? {businessRules: sanitizeRuleFragments(body.businessRules)} : {}),
      ...(body.systemRules !== undefined ? {systemRules: sanitizeRuleFragments(body.systemRules)} : {}),
      ...(body.defaultRoles !== undefined ? {defaultRoles: Array.isArray(body.defaultRoles) ? body.defaultRoles : []} : {})
    };
    // 仅保留非空覆盖键；若全为空则删除整个 configOverrides，使任务组回到"继承项目"，
    // 避免无实际改动的保存把任务组误标为"已自定义"并冻结当时继承到的值。
    for (const key of Object.keys(mergedOverrides)) {
      if (Array.isArray(mergedOverrides[key]) && mergedOverrides[key].length === 0) delete mergedOverrides[key];
    }
    if (Object.keys(mergedOverrides).length) taskGroup.configOverrides = mergedOverrides;
    else delete taskGroup.configOverrides;
    taskGroup.updatedAt = now();
    audit(state, guard.actor, "task_group_config_update", `TaskGroup:${taskGroup.id}`);
    const effective = effectiveTaskGroupConfig(state, taskGroup);
    finishGuardedWrite(state, guard, 200, effective);
    writeState(state);
    json(res, 200, {taskGroupId: taskGroup.id, config: effective, configVersion: configLayerVersion(taskGroup.configOverrides)});
    return;
  }

  const taskGroupConfigResetMatch = url.pathname.match(/^\/api\/task-groups\/([^/]+)\/config\/reset$/);
  if (req.method === "POST" && taskGroupConfigResetMatch) {
    const guard = beginGuardedWrite(req, state, "task_group_config_reset", `TaskGroup:${taskGroupConfigResetMatch[1]}`, taskGroupScope(state, taskGroupConfigResetMatch[1]));
    if (guard.status) return json(res, guard.status, guard.payload);
    const taskGroup = state.taskGroups.find((item) => item.id === taskGroupConfigResetMatch[1]);
    if (!taskGroup) return json(res, 404, {error: "task_group_not_found"});
    delete taskGroup.configOverrides;
    taskGroup.updatedAt = now();
    audit(state, guard.actor, "task_group_config_reset", `TaskGroup:${taskGroup.id}`);
    const effective = effectiveTaskGroupConfig(state, taskGroup);
    finishGuardedWrite(state, guard, 200, effective);
    writeState(state);
    json(res, 200, {taskGroupId: taskGroup.id, config: effective, configVersion: configLayerVersion(taskGroup.configOverrides)});
    return;
  }

  const contentBundleMatch = url.pathname.match(/^\/api\/agent\/v1\/content-bundles\/([^/]+)$/);
  if (req.method === "GET" && contentBundleMatch) {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    try {
      const bundle = buildExecutionContentBundle(state, node, decodeURIComponent(contentBundleMatch[1]), {runtimeDir});
      json(res, 200, bundle);
    } catch (error) {
      json(res, error.status || 500, {error: error.message});
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/v1/confirmations") {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    let request;
    try {
      // 严格白名单：agent 节点只能提【运行时执行确认】（"这一步要不要做"），不得自行构造核心决策单。
      // 原先这里 {...body} 原样透传，agent 可以自选 decisionType / subjectRef / content —— 于是它能
      // 伪造一张文案无害的"方案确认"卡片，而 subjectRef 指向另一份它想跑的拓扑；人一点确认，
      // 定稿锁就落到了没人真正看过的那个对象上（已复现的洗白绕过）。
      // 核心决策单一律由控制面内部按真实对象生成（互审 / 拆分 / 方案资格通过时），不经这条通道。
      request = createHumanConfirmationRequest(state, {
        nodeId: node.nodeId,
        dispatchId: body.dispatchId,
        workItemId: body.workItemId,
        sessionId: body.sessionId,
        summary: body.summary,
        detail: body.detail,
        question: body.question,
        evidenceRefs: body.evidenceRefs,
        options: body.options,
        blocking: body.blocking,
        decisionType: "runtime_execution"
      });
    } catch (error) {
      return json(res, error.status || 500, {error: error.message});
    }
    // core 走【返回 {ok:false}】而不是抛（如 task_group_settled）：try/catch 接不住它，不接住的话下面会拿
    // request.requestId=undefined 去记审计、再以 201 把这份拒绝当成功回出去。与 finding/approval 同规原样转发。
    if (request.ok === false) return json(res, refusalStatus(request), refusalPayload(request));
    audit(state, `agent-node:${node.nodeId}`, "human_confirmation_request", `HumanConfirmationRequest:${request.requestId}`);
    commitUnguardedWrite(state);
    json(res, 201, {request});
    return;
  }

  const agentConfirmationMatch = url.pathname.match(/^\/api\/agent\/v1\/confirmations\/([^/]+)$/);
  if (req.method === "GET" && agentConfirmationMatch) {
    if (!node) return json(res, 401, {error: "agent_node_auth_required"});
    const request = (state.humanConfirmationRequests || []).find((item) => item.requestId === agentConfirmationMatch[1]);
    if (!request || request.nodeId !== node.nodeId) return json(res, 404, {error: "human_confirmation_not_found"});
    if (url.searchParams.get("consume") === "true" && request.status === "answered") {
      consumeHumanConfirmation(state, request.requestId, {actor: `agent-node:${node.nodeId}`});
      commitUnguardedWrite(state);
    }
    json(res, 200, {request});
    return;
  }

  // 只回一个码的话，人（和 agent）看不出是路径打错了、方法用错了、还是这个接口压根不存在。
  // 把【它自己发的那次请求】回显出来：这是排障时最省事的一句，而它就在手上。
  json(res, 404, {error: "api_not_found", method: req.method, path: url.pathname,
    message: "这个接口不存在。核对路径与方法；控制台用的接口都在 /api/ 下面。"});
}

const server = createServer((req, res) => {
  try {
    const pathname = safeRequestPathname(req);
    if (pathname === null) {
      json(res, 400, {error: "invalid_request_url"});
      return;
    }
    if (["/install-agent.sh", "/install-agent.sh.sha256", "/agent-runtime.mjs", "/agent-runtime.mjs.sha256"].includes(pathname)) {
      serveAgentAsset(req, res, pathname);
      return;
    }
    if (pathname === "/mcp") {
      handleMcp(req, res).catch((error) => {
        json(res, error.status || 500, {error: error.message || "mcp_server_error"});
      });
      return;
    }
    if (!pathname.startsWith("/api/")) {
      serveStatic(req, res, pathname);
      return;
    }

    // 用 req.url 而不是 url.pathname：`url` 是 handleApi 内部的局部变量，这一层根本没有它 ——
    // 第一版就是在这里又踩了一次同样的坑（好在这次日志能用，它直接说了 "url is not defined"）。
    const requestLabel = `${req.method} ${req.url}`;
    handleApi(req, res).catch((error) => {
      respondApiError(res, error, requestLabel);
    });
  } catch (error) {
    try {
      respondApiError(res, error, `${req.method} ${req.url}`);
    } catch { /* 兜底的兜底：响应都发不出去时不能再抛 */ }
  }
});

function safeRequestPathname(req) {
  try {
    return new URL(req.url, "http://request.local").pathname;
  } catch {
    return null;
  }
}

// --- Real-time WebSocket push (additive over long-poll) --------------------------------------
const realtimeServer = new WebSocketServer({
  noServer: true,
  // 入站只有极小的订阅控制帧（subscribe/unsubscribe + 频道名）。ws 默认 maxPayload 是 100MB：一个已认证
  // 的客户端就能发一条含数百万频道字符串的巨消息，handleRealtimeMessage 的 subscribe 循环会逐个遍历它、
  // 在主线程上阻塞事件循环数百毫秒（即便频道都授权不过也照样遍历）。限到 64KB —— 对真实订阅帧绰绰有余，
  // 超了 ws 直接关连接，数组因此也被限住、循环不会失控。
  maxPayload: 64 * 1024,
  // 客户端用子协议头携带令牌（["aimac.bearer", "<token>"]）。握手必须回显【一个】它提供过的
  // 子协议，否则浏览器会立刻断开。这里固定回显 aimac.bearer，绝不回显令牌本身 ——
  // 回显令牌会把它写进响应头，等于换个地方继续泄露。
  handleProtocols: (protocols) => (protocols.has?.("aimac.bearer") || [...protocols].includes("aimac.bearer")) ? "aimac.bearer" : false
});

function realtimeToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  // 浏览器的 WebSocket 无法设置 Authorization 头，于是控制台原先把会话令牌放在查询串里 ——
  // 而查询串会被反向代理的访问日志、浏览器历史、以及各种中间设施原样记录下来。
  // 标准做法是借用子协议头：它是请求头，不进 URL，也就不会被这些地方记下来。
  const protocols = String(req.headers["sec-websocket-protocol"] || "").split(",").map((item) => item.trim()).filter(Boolean);
  const bearerIndex = protocols.indexOf("aimac.bearer");
  if (bearerIndex >= 0 && protocols[bearerIndex + 1]) return protocols[bearerIndex + 1];
  try {
    // 保留查询串作为兼容回退（非浏览器客户端、旧版控制台），但它不再是控制台使用的路径。
    return new URL(req.url, "http://request.local").searchParams.get("token") || "";
  } catch {
    return "";
  }
}

function authorizeRealtime(req) {
  const token = realtimeToken(req);
  if (!token) return null;
  const state = readState();
  const tokenDigest = digestOf(`session:${token}`);
  const session = (state.authSessions || []).find((item) => item.tokenDigest === tokenDigest && item.status === "active" && new Date(item.expiresAt).getTime() > Date.now());
  if (session) {
    const account = (state.accounts || []).find((item) => item.accountId === session.accountId);
    // 全仓唯一不检查账号状态的认证路径：被挂起/停用的账号照样能建立 WebSocket，
    // 而已建立的连接在会话被撤销之后也从不重新校验、永不断开。
    if (account && account.status === "active") return {kind: "account", accountId: account.accountId, sessionId: session.sessionId};
  }
  const node = authenticateAgentNode(state, token);
  if (node) return {kind: "agent", nodeId: node.nodeId};
  return null;
}

function realtimeChannelAuthorized(principal, channel) {
  if (channel === "state") return true; // wake-only; client re-fetches tenant-scoped state
  if (channel.startsWith("agent-control:")) return principal.kind === "agent" && channel === `agent-control:${principal.nodeId}`;
  return false;
}

function handleRealtimeMessage(socket, data) {
  let message;
  try {
    message = JSON.parse(String(data));
  } catch {
    return;
  }
  if (Array.isArray(message.subscribe)) {
    for (const channel of message.subscribe) {
      if (realtimeChannelAuthorized(socket.principal, String(channel))) socket.subscriptions.add(String(channel));
    }
  }
  if (Array.isArray(message.unsubscribe)) {
    for (const channel of message.unsubscribe) socket.subscriptions.delete(String(channel));
  }
  try {
    socket.send(JSON.stringify({event: "subscribed", channels: [...socket.subscriptions]}));
  } catch {
    realtimeClients.delete(socket);
  }
}

server.on("upgrade", (req, socket, head) => {
  // The whole body must be guarded: unlike the request path (createServer callback), a throw in a
  // synchronously-emitted 'upgrade' listener becomes an uncaughtException and would exit the
  // process. authorizeRealtime() calls readState(), which can throw (lock/pg-bridge timeout).
  let principal;
  try {
    const pathname = new URL(req.url, "http://request.local").pathname;
    if (pathname !== "/api/realtime") {
      socket.destroy();
      return;
    }
    principal = authorizeRealtime(req);
  } catch {
    socket.destroy();
    return;
  }
  if (!principal) {
    try {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    } catch { /* socket already gone */ }
    socket.destroy();
    return;
  }
  realtimeServer.handleUpgrade(req, socket, head, (client) => {
    client.principal = principal;
    client.subscriptions = new Set();
    client.isAlive = true;
    if (principal.kind === "agent") client.subscriptions.add(`agent-control:${principal.nodeId}`);
    realtimeClients.add(client);
    client.on("pong", () => { client.isAlive = true; });
    client.on("message", (data) => handleRealtimeMessage(client, data));
    client.on("close", () => realtimeClients.delete(client));
    client.on("error", () => { realtimeClients.delete(client); try { client.terminate(); } catch {} });
    try {
      client.send(JSON.stringify({event: "connected", channels: [...client.subscriptions]}));
    } catch {
      realtimeClients.delete(client);
    }
  });
});

const realtimeHeartbeat = setInterval(() => {
  // 已建立的连接原先【从不重新校验】：账号被挂起、会话被撤销之后，那条 WebSocket 照旧活着并
  // 继续收到唤醒通知，直到它自己断开为止。撤销只对新连接生效等于撤销了一半。
  // 心跳本来就要遍历全部连接，在这里顺带复核主体是否仍然有效。
  // 这一拍要用的只有 accounts 与 authSessions，两者都在【中央状态】里 —— 而 readState 会把
  // 全部项目分片一起水合出来：实测 400 单元时一次 165ms，30 秒一拍，且【一个连接都没有时照付】。
  // 所以先读中央态（实测 19ms），只有真的有过期会话要写回时，才升级成全量读写。
  let revalidationState = null;
  try { revalidationState = readStoredCentralState({root, runtimeDir, statePath, seedPath, buildInitialState}); }
  catch { revalidationState = null; }
  // 过期会话原先【只在有人登录时】被顺带清理，没有独立扫描器 —— 无人登录期间，已过期的会话记录
  // 长期滞留在 state 里。这里顺带扫一遍：心跳本来就在跑，且它读的就是同一份 state。
  // 只标记已过期的，绝不碰仍然有效的（那会把正在用的人踢下线）。
  if (revalidationState) {
    const nowMs = Date.now();
    const isExpired = (session) => session.status === "active"
      && new Date(session.expiresAt || 0).getTime() <= nowMs;
    // 中央态只用来【判断有没有要清的】。真要写回时必须走全量读 ——
    // 拿中央态直接写会把项目分片当成空的，等于把所有项目的数据清掉。
    if ((revalidationState.authSessions || []).some(isExpired)) {
      try {
        const writable = readState();
        let expiredCount = 0;
        for (const session of writable.authSessions || []) {
          if (!isExpired(session)) continue;
          session.status = "expired";
          session.updatedAt = new Date(nowMs).toISOString();
          expiredCount += 1;
        }
        if (expiredCount) {
          // 版本号必须跟着涨：读视图缓存的键带着它，不涨的话别的进程那一侧会在 TTL 内
          // 继续端出过期会话还"有效"的那一份（全仓 77 处写入里只有这一处漏了）。
          writable.stateVersion = Number(writable.stateVersion || 0) + 1;
          writeState(writable);
        }
      } catch { /* 清扫是尽力而为，冲突时下一轮心跳再来 */ }
    }
  }
  for (const client of realtimeClients) {
    if (revalidationState && client.principal && !realtimePrincipalStillValid(revalidationState, client.principal)) {
      realtimeClients.delete(client);
      try { client.close(4401, "principal_no_longer_active"); } catch { try { client.terminate(); } catch {} }
      continue;
    }
    if (client.isAlive === false) {
      realtimeClients.delete(client);
      try { client.terminate(); } catch {}
      continue;
    }
    client.isAlive = false;
    try { client.ping(); } catch { realtimeClients.delete(client); }
  }
}, clampEnvNumber(process.env.AIMAC_REALTIME_HEARTBEAT_MS, 10000, 30000));

// 自治循环此前【没有任何东西驱动它】：runAutonomousCycle 的入口只有 POST /api/orchestrator/run
// 与一个 MCP 工具，server.mjs 里没有任何定时器调用它。而 task_group:orchestrate 不在任何项目角色
// 模板里、且在不可委派清单里 —— 也就是说除了系统管理员，没有任何人能点那个按钮，而系统自己也不动。
// 于是一个项目负责人建完任务组会看到「事项清单尚未生成（编排启动后自动生成）」然后一直等下去。
//
// 权限这一侧是对的、不该放宽：编排权限由服务账号持有、明确不可委派，说明设计意图是"编排是系统的
// 职责而不是某个人的"。缺的不是授权，是那份职责从来没有人履行。补的是运行时，不是权限。
// 一拍跑完到底改没改东西，只能靠比对内容 —— 循环返回的 changed 里装的是"这一拍看过的单元"
// （awaiting_existing_checkpoint 之类），不是改过的，拿它当判据会把空转当成有变化。
// 序列化 30MB 状态约 100ms，而一次落盘约 800ms，且落盘还会推进版本号、作废所有客户端的 ETag，
// 让每个控制台都重新拉一遍视图、重建一次 DOM。所以这笔比对是划算的。
function tickContentDigest(state) {
  // 排除三样东西，都不是"循环改了什么"的一部分：
  // 1. runtime.autonomousOrchestrator —— readState 每次注入的内存心跳。不排除的话，上一拍缓存的
  //    指纹里是注入【之前】的值，这一拍读到的是注入之后的，每拍都判成"变了"，跳过永远不发生。
  // 2. stateVersion —— 循环从不改它，只有落盘时 +1。排除之后，落盘前后的指纹相同，
  //    于是可以把这一拍算出的指纹直接缓存给下一拍，【任何一拍都只需序列化一次】而不是两次。
  // 3. __ 开头的内部字段（如 __loadedStateVersion）—— 它们随每次读取变化，会让缓存永远落空。
  // 4. projectStateShards —— 分片索引（代号、载荷摘要、更新时刻）是【落盘时存储层自己写的】，
  //    内存里那份永远是上一代。数据真变了的话，分片里的集合本身也变了，照样检得出来。
  const {autonomousOrchestrator, ...runtimeRest} = state.runtime || {};
  const comparable = {...state, stateVersion: 0, runtime: runtimeRest, projectStateShards: null};
  for (const key of Object.keys(comparable)) if (key.startsWith("__")) delete comparable[key];
  return digestOf(JSON.stringify(comparable));
}
// 上一拍算出的指纹。只有在"从那以后没有别的写入者动过状态"时才可复用（用加载版本号判定），
// 于是稳态空转每拍只需序列化一次而不是两次。落盘之后不缓存：writeState 可能会裁剪状态，
// 缓存下落盘前的指纹会让下一拍永远判为"变了"，churn 反而变成常态。
let lastTickContentDigest = null;

export function runOrchestratorTick() {
  const finish = (outcome) => {
    runtimeOrchestratorStatus = recordOrchestratorTickOutcome(runtimeOrchestratorStatus, outcome);
    return outcome;
  };
  let state = null;
  try { state = readState(); } catch (error) { return finish({skipped: "state_unavailable", error: String(error?.message || error)}); }
  const loadedVersion = state.__loadedStateVersion;
  const digestBefore = (lastTickContentDigest && lastTickContentDigest.stateVersion === loadedVersion)
    ? lastTickContentDigest.digest
    : tickContentDigest(state);
  try {
    // 对账必须先跑，而且【不受"有没有在跑的任务组"影响】。
    // recycleExpiredClaims 此前只有两个调用点：heartbeatAgentNode 与 claimNextDispatch —— 两个都要
    // 活着的节点来发起。于是全队节点崩掉之后：它们永远显示"在线"、running 派发的认领永不过期、
    // 永不重排队；而挂在这条路上的撤销截止期与注册重放明文令牌抹除也一并停摆。
    // 一个只有在系统健康时才会运行的对账，恰好在最需要它的时候不运行。
    const reconciled = recycleExpiredClaims(state);
    const pending = (state.taskGroups || []).some((group) => !["closed", "aborted"].includes(group.status));
    if (!pending) {
      if (!reconciled) return finish({skipped: "no_open_task_group"});
      state.stateVersion = Number(state.stateVersion || 0) + 1;
      writeState(state);
      return finish({ran: true, reconciledOnly: true});
    }
    const result = runAutonomousCycle(state, {root: repositoryRoot, runtimeDir, mode: "all", autoSyncSkills: false});
    const digestAfter = tickContentDigest(state);
    if (digestAfter === digestBefore) {
      // 什么都没变还落盘，代价不只是那 800ms：版本号一推进，所有客户端的 ETag 全作废，
      // 每个控制台都要重新拉一遍视图、重建一次 DOM —— 每分钟一次，永远。
      lastTickContentDigest = {stateVersion: loadedVersion, digest: digestAfter};
      return finish({ran: true, changed: 0, unchanged: true});
    }
    state.stateVersion = Number(state.stateVersion || 0) + 1;
    writeState(state);
    // 指纹里不含版本号，所以落盘后无需重算：这一拍的产物就是下一拍的基准。
    // 写入失败会抛到下面的 catch，那里把缓存作废 —— 盘上没写成功时不能拿内存里的当基准。
    lastTickContentDigest = {stateVersion: state.stateVersion, digest: digestAfter};
    return finish({ran: true, changed: result?.changed?.length || 0});
  } catch (error) {
    // 与心跳里的清扫同规：冲突/失败都是尽力而为，下一拍再来。一次失败不该让循环整个停摆。
    // 缓存必须作废：这一拍可能已经改了内存里的状态却没写成功，拿它当下一拍的基准会把真实变化判成"没变"。
    lastTickContentDigest = null;
    return finish({skipped: "cycle_error", error: String(error?.message || error).slice(0, 200)});
  }
}

// 间隔设为 0 即关闭 —— 端到端脚本用它把周期关掉，避免后台推进打乱被断言的状态序列。
// 配置问题只在启动那一刻有人看：这里主动核对一次服务令牌白名单，
// 把"配了但不会生效 / 名字拼错了"当场说出来，而不是等运维去数 tools/list。
try {
  mcpServiceAllowedTools(createMcpToolDefinitions().map((tool) => tool.name));
  const allowlistNotice = mcpServiceAllowlistNotice();
  if (allowlistNotice) console.warn(`[mcp-allowlist] ${allowlistNotice}`);
  // 同族：AIMAC_MCP_SERVICE_PROJECT_IDS 配的是【项目 id 清单】，而它同样从不核对这些 id 存不存在。
  // 配错一个，服务令牌就被限定在一个不存在的项目上 —— 之后每次调用都因作用域失败，
  // 而失败信息只会说"越权/看不见"，不会说"你配的那个项目根本没有"。
  const configuredProjectIds = String(process.env.AIMAC_MCP_SERVICE_PROJECT_IDS || "")
    .split(",").map((item) => item.trim()).filter(Boolean);
  if (configuredProjectIds.length) {
    const bootState = readStoredState({root, runtimeDir, statePath, seedPath, buildInitialState});
    const known = new Set((bootState.projects || []).map((item) => item.id));
    const missing = configuredProjectIds.filter((id) => !known.has(id));
    if (missing.length) {
      console.warn(`[mcp-allowlist] AIMAC_MCP_SERVICE_PROJECT_IDS 里这些项目不存在：${missing.join("、")}`
        + " —— 服务令牌会被限定在它们上面，之后每次调用都因作用域失败，"
        + "而报错只会说越权/看不见，不会说这个项目根本没有");
    }
  }
} catch { /* 工具表或状态取不到时不影响启动 */ }
// 值打错（NaN）必须回默认 60000 而不是被 intervalMs > 0 当成「关闭」——关闭只属于显式写 0 的人（min=0 保留它）。
const orchestratorIntervalMs = clampEnvNumber(process.env.AIMAC_ORCHESTRATOR_INTERVAL_MS, 0, 60000);
// 关掉它，后台就没有任何东西推进：人提交的指令一直停在"待处理"，派发不会被领走，
// 关闭门不会重算 —— 而控制台上一切如常，人会以为系统在跑。这与状态机执行模式同形，
// 所以同样如实公布：它是"想要多久跑一次"，不是猜的。
runtimeOrchestratorStatus = {
  intervalMs: orchestratorIntervalMs > 0 ? Math.max(5000, orchestratorIntervalMs) : 0,
  enabled: orchestratorIntervalMs > 0
};
if (orchestratorIntervalMs > 0) {
  const orchestratorTimer = setInterval(runOrchestratorTick, Math.max(5000, orchestratorIntervalMs));
  // 不要让这个定时器把进程钉住：它是后台推进，不是进程存在的理由。
  orchestratorTimer.unref?.();
}
realtimeHeartbeat.unref();

let lastStorageFault = null;

// 技能源同步的三种业务失败各给一个状态码；认不出的照旧当 500 抛出去（那才是真的服务端问题）。
function skillSourceFailureStatus(error) {
  const code = String(error?.message || "").split(":")[0];
  if (code === "skill_source_sync_failed") return 502;
  if (code === "pinned_commit_mismatch") return 409;
  if (code === "skill_source_unsafe_git_input") return 400;
  return 0;
}

// 记录构造函数回 ok:false 时，路由要把它算好的细节一起带出去（supported / allowed / required / 了结原因），
// 状态码按它给的来，没给就按码的家族判：不存在 404、与现状冲突 409、其余是入参问题 400。
// 原先五条路由对所有 ok:false 一律 404 + 只转发 error：「发现项状态认不出」被说成"找不到"，
// 而它算好的 supported 一个字都没出去。
function refusalStatus(result, fallback = 400) {
  if (Number.isInteger(result?.status)) return result.status;
  const code = String(result?.error || "");
  if (/_not_found$/u.test(code)) return 404;
  if (/_settled$|_conflict$|already|_terminal$/u.test(code)) return 409;
  return fallback;
}
function refusalPayload(result) {
  const {ok: _ok, status: _status, ...details} = result || {};
  return {...details, error: result?.error};
}

function respondApiError(res, error, requestLabel = "") {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (isStateStoreConflict(error)) {
    json(res, 409, {error: "state_write_conflict", retryable: true, message: error.message});
    return;
  }
  if (error.status && error.status < 500) {
    // 同上：抛出的码写在展开【之后】，details 里若有同名字段也盖不掉它。
    json(res, error.status, {...(error.details || {}), error: error.message});
    return;
  }
  // 盘写不进去（满盘 / 只读挂载 / 权限 / 配额）：原样把 Node 的错误抛回去有两处不妥 ——
  // 中文界面上出现一句英文 EACCES，而且报文里带着服务器的绝对路径。
  // 实测把运行目录改成不可写：写入回 500 + "EACCES: permission denied, mkdir '/var/folders/…'"。
  // 这一类要给一个稳定的错误码，让人知道该去查什么；路径留在服务端日志里，不回给调用方。
  // 状态文件损坏：与上面的写失败同规 —— 稳定错误码 + 说清是哪一份，路径不回给调用方。
  // 而且要【记下来】：分片坏掉时服务照常起、/api/health 仍然 200，监控是绿的而数据面已经不可用。
  const corrupt = storageFaultCodePattern.exec(String(error?.message || ""));
  if (corrupt) {
    lastStorageFault = {kind: corrupt[1], file: corrupt[2], at: now()};
    console.error(`[state-store] ${corrupt[1]}: ${corrupt[2]}`);
    json(res, 503, {error: "state_storage_corrupt", kind: corrupt[1], file: corrupt[2], retryable: false});
    return;
  }
  if (databaseUnavailable(error)) {
    // 实测把 PG 停掉：读写一律 500 server_error + "connect ECONNREFUSED 127.0.0.1:55433" —— 库的地址回给了调用方，
    // 而健康检查早就会说 degraded。这里与磁盘那一支同规：503 + 稳定码 + 一句话，地址只留在 stderr。
    console.error(`[state-store] ${error.code || "database"}: ${error.message} —— ${DATABASE_UNAVAILABLE_HINT}`);
    lastStorageFault = {kind: "state_unreadable", code: error.code || null, at: now()};
    json(res, 503, {error: "state_storage_unavailable", code: error.code || "database_unreachable", retryable: true, message: DATABASE_UNAVAILABLE_HINT});
    return;
  }
  if (["EACCES", "EPERM", "ENOSPC", "EROFS", "EDQUOT", "EMFILE", "ENFILE"].includes(error?.code)) {
    console.error(`[state-write] ${error.code}: ${error.message} —— ${STORAGE_UNAVAILABLE_HINT}`);
    // 健康页必须跟着变：原先只有"状态损坏"那一支登记 lastStorageFault，写不进磁盘这一支不登记 ——
    // 于是磁盘一个字都写不进去了，/api/health 仍然回 status:"ok"，监控探针一路绿灯，
    // 而每一次写操作都在 503（实测：把运行目录 chmod 500 之后正是这样）。
    // 健康页自己会在故障消失后把它清掉（那一支已有自愈判据），所以这里只管登记。
    lastStorageFault = {kind: "state_storage_unavailable", file: basename(statePath), code: error.code, at: now()};
    // REST/MCP/agent 这些不经控制台词表的调用方，也要在正文里读到该查什么。
    json(res, 503, {error: "state_storage_unavailable", code: error.code, retryable: true, message: STORAGE_UNAVAILABLE_HINT});
    return;
  }
  // 兜底这一支原先【一个字都不打】，而它上面每一支都打。于是一个未预期的 500 在服务端
  // 不留任何痕迹：客户端看到 server_error，运维翻日志什么也没有，无从排查。
  // 实测并发写入门偶发 500（六轮两次），正是因为这里静默才查不出是什么。
  // 堆栈默认不打（生产日志会被贴进工单），要看用 AIMAC_SERVER_ERROR_DEBUG=1。
  // 【这一行本身曾是崩溃源】：它引用 req/url，而这个函数只收 res —— 于是每一个走到兜底的请求
  // 都会在这里抛 ReferenceError，未捕获，**整个服务端进程直接退出**。
  // 症状是并发写入门偶发 ECONNREFUSED，追了三轮才看见（门收集服务端输出的那套自己也坏着）。
  // 两条教训写进代码：请求信息显式传参，别指望闭包；日志本身要包起来 ——
  // 记录错误的代码把服务打死，比不记录坏得多。
  try {
    const where = requestLabel ? ` ${requestLabel}` : "";
    console.error(`[server-error]${where}: ${error?.message || error}`);
    if (process.env.AIMAC_SERVER_ERROR_DEBUG === "1" && error?.stack) console.error(error.stack);
  } catch { /* 日志失败绝不能影响响应 */ }
  json(res, error?.status || 500, {error: "server_error", message: error?.message});
}

server.keepAliveTimeout = clampEnvNumber(process.env.AIMAC_KEEP_ALIVE_TIMEOUT_MS, 5000, 65000);
server.headersTimeout = server.keepAliveTimeout + 5000;
server.requestTimeout = clampEnvNumber(process.env.AIMAC_REQUEST_TIMEOUT_MS, server.headersTimeout, 300000);

try {
  assertRuntimeSecurity();
} catch (error) {
  console.error(`[startup] ${startupDiskProblem(error) || error.message}`);
  for (const step of error.nextSteps || []) console.error(`  · ${step}`);
  process.exit(1);
}
// 启动期最常撞到的两种盘上故障要说人话：目录写不进（EACCES/EPERM/EROFS）原先只吐一句 Node 原话；
// 状态文件损坏原先一个字都不说 —— 横幅照常打、看起来健康，只有 /api/health 才报 storageFault。
try {
  ensureState();
} catch (error) {
  const diskProblem = startupDiskProblem(error);
  if (diskProblem) {
    console.error(`[startup] ${diskProblem}`);
    process.exit(1);
  }
  // 启动时连不上 DATABASE_URL 指向的库：原先是一段 pg 桥的崩溃栈。驱动原话不含密码（只有主机:端口），可以打。
  if (databaseUnavailable(error)) {
    console.error(`[startup] 连不上 DATABASE_URL 指向的数据库（${error.code || "?"}：${error.message}）—— 确认库在跑、地址/端口/用户名密码对、网络与防火墙通；服务不会带着一个连不上的库启动`);
    process.exit(1);
  }
  throw error;
}
try {
  readState();
} catch (error) {
  const corruptAtStartup = storageFaultCodePattern.exec(String(error?.message || ""));
  if (!corruptAtStartup) throw error;
  lastStorageFault = {kind: corruptAtStartup[1], file: corruptAtStartup[2], at: new Date().toISOString()};
  console.error(`[startup] 运行态文件损坏：${corruptAtStartup[2]}（${corruptAtStartup[1]}）—— 服务照常起来、/api/health 会报 storageFault，但数据面不可用。`
    + `恢复：停掉服务，把最近一次 npm run backup 的整目录拷回 ${runtimeDir} 再启动；没有备份就删掉这份坏文件让下次启动按种子重建（会丢掉全部运行数据）`);
}
// 运行目录的身份（设备+inode）在启动时记一次：目录被清掉又重建时它会变。
// 不能记【状态文件】的 inode —— 原子写每次 rename 都会换掉那个文件的 inode，
// 那样第一次写入之后系统就会被判成 degraded（实测把 agent e2e 打挂了）。
const serverStartedAt = new Date().toISOString();
let runtimeDirIdentity = null;
try { const stat = statSync(runtimeDir); runtimeDirIdentity = `${stat.dev}:${stat.ino}`; } catch { runtimeDirIdentity = null; }

// 存储配置在【监听之前】就要认账：认不出的名字、或 postgresql 少了 DATABASE_URL，
// 此前都会静默退回本地 runtime_json —— 服务照常起、健康检查照常 ok，而它接的是另一个存储。
try {
  assertStateStoreConfig();
} catch (error) {
  console.error(`[state-store] ${error.message}`);
  process.exit(1);
}

// 端口被占是重启时最常见的失误（旧进程还没退就起了新的），而 Node 默认吐的是一段
// "Unhandled 'error' event" 崩溃栈，一句人话都没有。这里按 errno 说清楚，并保持退出码 1。
server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`[startup] ${host}:${port} 已经被占用 —— 多半是上一个实例还没退（用 lsof -i :${port} 看是谁），`
      + "或者改用 AIMAC_PORT 换一个端口");
  } else if (error?.code === "EACCES") {
    console.error(`[startup] 没有权限监听 ${host}:${port} —— 1024 以下的端口需要特权，换一个高位端口或授权`);
  } else if (error?.code === "EADDRNOTAVAIL") {
    console.error(`[startup] 这台机器上没有 ${host} 这个地址 —— 检查 AIMAC_HOST（想对外监听用 0.0.0.0）`);
  } else {
    console.error(`[startup] 监听 ${host}:${port} 失败：${error?.code || ""} ${error?.message || error}`);
  }
  process.exit(1);
});

// e2e 起服务端的进程若被 SIGKILL（或整个终端被关掉），它的 finally 跑不了，
// 这个服务端就成了孤儿：一直占着内存和端口，直到有人手工发现。实测一次数出【79 个】，
// 最久的活了 8 天。父进程没了就跟着退 —— 只在显式打开时生效，生产不受影响。
if (process.env.AIMAC_EXIT_WITH_PARENT === "1") {
  const bornTo = process.ppid;
  // unref：这只是看门狗，不该把一个本该退出的进程吊在事件循环里。
  setInterval(() => {
    // 父进程没了之后本进程会被过继给 1（launchd/init）。ppid 变了就是那一刻。
    if (process.ppid === bornTo) return;
    console.error(`[server] 起我的那个进程（pid ${bornTo}）已经不在了，跟着退出 —— 否则会变成一个占着端口的孤儿`);
    process.exit(0);
  }, 2000).unref();
}

server.listen(port, host, () => {
  // 打【真正绑上的】端口，不是请求的那个：AIMAC_PORT=0 是"随便给我一个空闲端口"的标准写法，
  // 而原先这行会打出 http://127.0.0.1:0 —— 照着它连一次都连不上。
  boundPort = server.address()?.port || port;
  // 运行态里的服务端点在 listen 之前就按配置端口写过一次（ensureState），之后只有写请求才会重写：
  // AIMAC_PORT=0 时它们会一直是 :0，控制台「系统服务」表照抄。端口与配置不同就补写一遍。
  if (boundPort !== port) {
    try {
      const rebound = readState();
      // 存储层要求每次写都推进版本（同版本并发写会被它拒掉）：与写路由同一写法。
      rebound.stateVersion = Number(rebound.stateVersion || 0) + 1;
      writeState(rebound);
    } catch (error) { console.error(`补写服务端点失败（不影响运行）：${error.message}`); }
  }
  console.log(`AI Multi-Agent Ctrl console: http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${boundPort}`);
  console.log(`Centralized MCP endpoint: ${publicEndpoint()}/mcp`);
  console.log(`Agent installer: ${publicEndpoint()}/install-agent.sh`);
});
