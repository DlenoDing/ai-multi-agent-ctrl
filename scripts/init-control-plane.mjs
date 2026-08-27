import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digestOf, ensureRuntimeCollections } from "../apps/control-plane-ui/lib/control-plane-core.mjs";
import { appendAuditEntry } from "../apps/control-plane-ui/lib/audit-ledger.mjs";
import { markRuntimeStorage, stateStoreKind, storedStateExists, writeStoredState } from "../apps/control-plane-ui/lib/state-store.mjs";
import { mcpServiceAllowedTools } from "../apps/control-plane-ui/lib/mcp-service-allowlist.mjs";
import { createMcpToolDefinitions } from "../apps/mcp-server/server.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = resolve(root, process.env.AIMAC_RUNTIME_DIR || ".runtime");
const statePath = join(runtimeDir, "control-plane-state.json");
const configPath = join(runtimeDir, "runtime-config.json");
const seedPath = join(root, "data", "seed-state.json");
const repositoryRoot = resolve(process.env.AIMAC_REPOSITORY_ROOT || root);
const executionProfile = process.env.AIMAC_EXECUTION_PROFILE || "production";
// 参数名打错不能当成没给：--check 打错就跳过只读分支【真的去初始化】——
// 人想做一次探查，结果写了运行时状态和配置。认不出的一律拒绝，不猜。
const KNOWN_FLAGS = ["--force", "--check"];
// `--help` 是任何人敲的第一件事。此前它被当成打错的参数拒掉（非零退出、报错口吻）——
// 该说的内容本来就在下面那段里，只是以"你做错了"的姿态给出。同样的话，问的时候就该给。
const wantsHelp = process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h");
if (wantsHelp) {
  console.log("用法：npm run init [-- --check | --force]");
  console.log(`  · 认得的参数：${KNOWN_FLAGS.join(" ")}`);
  console.log("  · --check 只读探查，不写运行时状态与配置；--force 覆盖已有运行态");
  process.exit(0);
}
const unknownFlags = process.argv.slice(2).filter((arg) => !KNOWN_FLAGS.includes(arg));
if (unknownFlags.length) {
  console.error(`init-control-plane: 认不出这些参数：${unknownFlags.join(" ")}`);
  console.error(`  · 认得的参数：${KNOWN_FLAGS.join(" ")}`);
  console.error("  · --check 打错会被当成没给，于是【真的执行初始化】而不是只读探查 —— 所以这里拒绝");
  process.exit(2);
}
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
  // 引导审计行要经共用的台账构造走：原先在这里手拼一条（没有 schemaVersion、没有 rowHash/prevHash），
  // 于是每一份经 `npm run init` 初始化的部署，哈希链的第一行都是没上链的 —— docker 门在 PostgreSQL 后端上
  // 第一次按规范扫产出就把它报了出来（doctor 走的是种子路径，从没见过它）。
  appendAuditEntry(state, {actor: "bootstrap", action: "runtime_initialized",
    subject: "RuntimeBootstrapProfile:runtime_local", result: "succeeded", at: now});
  return state;
}

// 初始化的第一步就是建运行目录。它失败（只读挂载、权限、满盘）时原先直接把 Node 的栈抛出来：
// 屏幕上是一句 EACCES 加一条绝对路径，而这【恰恰是新人装第一次】的时刻。
// 要说清三件事：哪一步失败了、多半是什么原因、以及本机现在是什么状态（这一步之前什么都没写）。
function failInit(step, error, hints) {
  console.error(`init-control-plane: ${step}失败：${error?.code ? `${error.code} ` : ""}${error?.message || error}`);
  for (const hint of hints) console.error(`  · ${hint}`);
  console.error("  · 这一步之前没有写过任何东西；排掉原因后重跑 npm run init 即可，不需要先清理");
  process.exit(1);
}

try {
  mkdirSync(runtimeDir, { recursive: true });
} catch (error) {
  failInit(`建运行目录 ${runtimeDir}`, error, [
    "只读挂载 / 权限不足 / 盘满都会走到这里；先确认这个路径所在的盘可写",
    "要换个位置就设 AIMAC_RUNTIME_DIR 指向一个可写目录再重跑"
  ]);
}

if (checkOnly) {
  const ready = storedStateExists(stateStoreOptions()) && existsSync(configPath);
  console.log(ready ? "runtime initialized" : "runtime not initialized");
  process.exit(ready ? 0 : 1);
}

if (!force && storedStateExists(stateStoreOptions())) {
  console.log(`runtime state already exists: ${stateStoreKind() === "postgresql" ? "postgresql://aimac_control_plane_state/default" : statePath}`);
} else {
  try {
    writeStoredState(buildState(), stateStoreOptions());
  } catch (error) {
    failInit("写运行时状态", error, [
      "状态存储写不进去：盘满、权限，或 AIMAC_STATE_STORE 指向的后端连不上",
      `当前存储后端：${stateStoreKind()}`
    ]);
  }
  console.log(`runtime state initialized: ${stateStoreKind() === "postgresql" ? "postgresql://aimac_control_plane_state/default" : statePath}`);
}

const existingConfig = existsSync(configPath) ? loadJson(configPath) : {};
const bootstrapToken = process.env.AIMAC_BOOTSTRAP_TOKEN || existingConfig.localBootstrapToken || randomBytes(24).toString("base64url");
const workspaceOwnerTokenEnv = process.env.AIMAC_LOCAL_SEED_WORKSPACE_OWNER_TOKEN;
const reviewerTokenEnv = process.env.AIMAC_LOCAL_SEED_REVIEWER_TOKEN;
const agentRuntimeTokenEnv = process.env.AIMAC_LOCAL_SEED_AGENT_RUNTIME_TOKEN;
const workspaceOwnerToken = workspaceOwnerTokenEnv || existingConfig.localAccountTokens?.acct_workspace_owner || randomBytes(24).toString("base64url");
const reviewerToken = reviewerTokenEnv || existingConfig.localAccountTokens?.acct_reviewer || randomBytes(24).toString("base64url");
const agentRuntimeToken = agentRuntimeTokenEnv || existingConfig.localAccountTokens?.acct_agent_runtime || randomBytes(24).toString("base64url");
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
    ...(workspaceOwnerTokenEnv ? {} : {acct_workspace_owner: workspaceOwnerToken}),
    ...(reviewerTokenEnv ? {} : {acct_reviewer: reviewerToken}),
    ...(agentRuntimeTokenEnv ? {} : {acct_agent_runtime: agentRuntimeToken})
  },
  updatedAt: new Date().toISOString()
});

console.log("next: npm start");
// 这里原先原样打印 `$AIMAC_PUBLIC_URL/mcp` —— 一个操作者照抄就用不了的地址，
// 而且看不出它是占位符还是真值。buildState 本来就算出了有效地址，打印它。
// 没设 AIMAC_PUBLIC_URL 时那是个回环地址：本机的 MCP 客户端能连，别的机器连不上 ——
// 这正是人需要提前知道的一件事，而不是等远程客户端连不上再回来查。
const mcpEndpoint = process.env.AIMAC_PUBLIC_URL
  || `http://${process.env.AIMAC_HOST || "127.0.0.1"}:${Number(process.env.AIMAC_PORT || 4317)}`;
console.log(`mcp: ${mcpEndpoint}/mcp` + (process.env.AIMAC_PUBLIC_URL
  ? ""
  : "  (回环地址，只有本机的 MCP 客户端连得上；要给别的机器用，先设 AIMAC_PUBLIC_URL 再重跑)"));
// 这一屏其余每一行都是"英文标签 + 括号里中文说明"，只有这一行是整句英文 ——
// 而它恰恰是最复杂的一步（怎么让 agent 入网），新人第一次装的时候读的就是它。
// 按同一形状改：标签仍是英文（脚本输出要能 grep），说明用中文，并点名那个入口在哪。
// 入口名要按【界面上真有的那个】写：我第一版写的是"「智能体」页"，而实际在
// 「账号与授权」页的"智能体入网令牌"面板 —— 指向一个不存在的页面比不给指引更糟，
// 人会先怀疑自己的版本不对。写之前搜过 app.js 里的真实面板名。
console.log("agent: 登录管理控制台 → 「账号与授权」页 → 在「智能体入网令牌」面板签发一次性入网命令 → "
  + "把那条命令拿到 Agent 主机上执行（命令里已带好地址与一次性令牌，不必手工配置）");
// 登录同时需要【身份】和【令牌】：系统管理员的 authPolicy.method 是 bootstrap_token，
// 登录时要填邮箱/账号 ID 再配上这个令牌。原先只打印令牌，从不打印身份 —— 而那个值只存在于
// .env.example 与种子数据里，人拿着一串 token 面对"登录账号"输入框无从下手。
// 刚装完登进去，项目概览上是一个 73% 的项目、更新时间在一个月前 —— 那是随发行版附带的
// 示例数据（控制面自身的开发任务），而屏幕上没有任何地方说它是示例。人会以为这套部署里
// 有别人的数据，或者干脆就在这个示例项目里开工（那正是本仓最危险那个缺陷的前提：
// 待在种子那一个项目里干活，"有没有真实数据"的判定就看不出来）。在这里说清楚，
// 因为这正是他决定下一步做什么的那一刻。
const seedState = loadJson(seedPath);
const seedProjects = (seedState.projects || []).map((item) => item.name).join("、");
console.log(`sample data: 运行态里带着示例项目 ${seedProjects}（${(seedState.taskGroups || []).length} 个任务组，`
  + "控制面自身的开发任务）。它的进度与时间都是示例，不是你的数据 —— 建自己的项目再开工；"
  + "要清掉它：登录后到「系统概览」页用「重新初始化运行态」。");
console.log(`system admin login: ${process.env.AIMAC_SYSTEM_ADMIN_EMAIL || "system.admin@local"}  (在登录页「登录账号」处填它)`);
if (!process.env.AIMAC_BOOTSTRAP_TOKEN) {
  console.log(`local bootstrap token: ${bootstrapToken}  (与上面的登录账号配合使用)`);
}
// 上面那个管理员令牌写了"配合登录账号使用"，下面两个此前只有一串 base64 —— 人拿到手不知道
// 往哪儿填。三个令牌打印在同一屏，用途却只标了一个，剩下两个只能去翻代码。
if (!workspaceOwnerTokenEnv) {
  console.log(`local seed workspace owner token: ${workspaceOwnerToken}`
    + "  (种子里的普通成员账号 owner@local，用来验非管理员视角；登录方式与上面相同)");
}
// 这两个数原先是写死的字面量（"46 个工具、约 69k token"），而 46 是【过滤前】的条数 ——
// 真实放行 44 个，远程客户端一跑 tools/list 就与这句话对不上。改成按同一处真相源算出来：
// 工具数取服务令牌的有效白名单，token 数按真实 tools/list 载荷估（4 字节/token 粗算）。
function mcpServiceToolFacts() {
  const allowed = new Set(mcpServiceAllowedTools());
  const payload = createMcpToolDefinitions().filter((tool) => allowed.has(tool.name));
  return {count: payload.length, approxKiloTokens: Math.round(Buffer.byteLength(JSON.stringify(payload), "utf8") / 4 / 1000)};
}

if (!process.env.AIMAC_MCP_SERVICE_TOKEN) {
  console.log(`central MCP service token: ${mcpServiceToken}`
    + `  (远程 MCP 客户端连 ${mcpEndpoint}/mcp 时作 Bearer 令牌；`
    + `默认放行 ${mcpServiceToolFacts().count} 个工具，一次 tools/list 约 ${mcpServiceToolFacts().approxKiloTokens}k token，`
    + "用 AIMAC_MCP_SERVICE_ALLOWED_TOOLS 可再收窄)");
}
