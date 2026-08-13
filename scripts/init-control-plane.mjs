import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digestOf, ensureRuntimeCollections } from "../apps/control-plane-ui/lib/control-plane-core.mjs";
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
  state.auditLog.unshift({
    id: `audit_bootstrap_${Date.now()}`,
    at: now,
    actor: "bootstrap",
    action: "runtime_initialized",
    subject: "RuntimeBootstrapProfile:runtime_local",
    result: "succeeded"
  });
  return state;
}

mkdirSync(runtimeDir, { recursive: true });

if (checkOnly) {
  const ready = storedStateExists(stateStoreOptions()) && existsSync(configPath);
  console.log(ready ? "runtime initialized" : "runtime not initialized");
  process.exit(ready ? 0 : 1);
}

if (!force && storedStateExists(stateStoreOptions())) {
  console.log(`runtime state already exists: ${stateStoreKind() === "postgresql" ? "postgresql://aimac_control_plane_state/default" : statePath}`);
} else {
  writeStoredState(buildState(), stateStoreOptions());
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
// 而且看不出它是占位符还是真值。第 42 行本来就算出了有效地址，打印它。
// 没设 AIMAC_PUBLIC_URL 时那是个回环地址：本机的 MCP 客户端能连，别的机器连不上 ——
// 这正是人需要提前知道的一件事，而不是等远程客户端连不上再回来查。
const mcpEndpoint = process.env.AIMAC_PUBLIC_URL
  || `http://${process.env.AIMAC_HOST || "127.0.0.1"}:${Number(process.env.AIMAC_PORT || 4317)}`;
console.log(`mcp: ${mcpEndpoint}/mcp` + (process.env.AIMAC_PUBLIC_URL
  ? ""
  : "  (回环地址，只有本机的 MCP 客户端连得上；要给别的机器用，先设 AIMAC_PUBLIC_URL 再重跑)"));
console.log("agent: log in to the management console, open the target project, generate a one-time join command, then run that command on the Agent host");
// 登录同时需要【身份】和【令牌】：系统管理员的 authPolicy.method 是 bootstrap_token，
// 登录时要填邮箱/账号 ID 再配上这个令牌。原先只打印令牌，从不打印身份 —— 而那个值只存在于
// .env.example 与种子数据里，人拿着一串 token 面对"登录账号"输入框无从下手。
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
