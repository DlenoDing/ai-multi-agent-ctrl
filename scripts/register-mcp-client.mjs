#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mcpToolNames } from "../apps/mcp-server/server.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 这个脚本此前每一条失败路径都是【一段 Node 崩溃栈】：参数打错、--apply 少了客户端、
// 地址不是 HTTPS，人看到的都是源码行加一个尖角。与 agentctl 同规：一句人话 + 下一步，
// 堆栈留给 AIMAC_REGISTER_MCP_DEBUG=1。参数拒绝也改成与另外三个运维入口同一种形状。
// `--help` 是任何人敲的第一件事。此前它被当成打错的参数拒掉（非零退出、报错口吻）——
// 该说的内容本来就在下面那段里，只是以"你做错了"的姿态给出。同样的话，问的时候就该给。
const wantsHelp = process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h");
if (wantsHelp) {
  console.log("用法：node scripts/register-mcp-client.mjs [--apply] [--client=all|codex|claude|cursor] [--target=project|user] ...");
  console.log("  · 认得的参数：--apply --client= --target= --config= --output-dir= --server-url= --token= --token-env=");
  console.log("  · 不给 --apply 时只打印将要写的配置，不落盘");
  process.exit(0);
}
const unknownFlags = [];
const args = parseArgs(process.argv.slice(2));
if (unknownFlags.length) {
  fail(`认不出这些参数：${unknownFlags.join(" ")}`,
    ["认得的参数：--apply --client= --target= --config= --output-dir= --server-url= --token= --token-env=",
     "打错的参数会被当成没给（--apply 打错就变成空跑，配置根本没写下去）—— 所以这里拒绝，而不是替你猜"]);
}
// 取值校验放在"参数名认不出"之后：名字打错更可能是根因，先说那个。
if (!["all", "codex", "claude", "cursor"].includes(args.client || "all")) {
  fail(`--client 认不出：${args.client}`, ["可选值：all / codex / claude / cursor"]);
}
if (!["project", "user"].includes(args.target || "project")) {
  fail(`--target 认不出：${args.target}`,
    ["可选值：project（写进当前仓库）/ user（写进你的用户配置）"]);
}
const client = args.client || "all";
const target = args.target || "project";
const apply = Boolean(args.apply);
const outputDir = resolve(root, args.outputDir || process.env.AIMAC_MCP_CONFIG_DIR || join(".runtime", "mcp-client-configs"));
const serverUrl = normalizeServerUrl(args.serverUrl || process.env.AIMAC_PUBLIC_URL || "http://127.0.0.1:4317");
const mcpUrl = `${serverUrl}/mcp`;
const bearerToken = args.token || process.env.AIMAC_MCP_BEARER_TOKEN || "";
const tokenEnv = args.tokenEnv || "AIMAC_MCP_BEARER_TOKEN";
const outputs = [];

mkdirSync(outputDir, {recursive: true});

if (apply && client === "all") {
  fail("--apply 要写进哪个客户端的配置，必须指明",
    ["加 --client=codex 或 --client=claude 或 --client=cursor",
     "不加 --apply 时只生成配置片段到输出目录，不动你机器上的任何配置"]);
}
if (apply && !bearerToken && client !== "codex") {
  fail(`--apply 写 ${client} 的配置需要一个可用的令牌`,
    ["给 --token=<令牌>，或设环境变量 AIMAC_MCP_BEARER_TOKEN",
     "JSON 类客户端不支持 ${环境变量} 占位，令牌必须当场写进文件（所以文件按 0600 落盘）",
     "codex 那条走 TOML，可以留占位，所以它不要求"]);
}

const remoteEntry = {
  url: mcpUrl,
  headers: {Authorization: bearerToken ? `Bearer ${bearerToken}` : `Bearer \${${tokenEnv}}`}
};

writeJson(join(outputDir, "mcp-server.json"), {
  generatedBy: "ai-multi-agent-ctrl",
  serverName: "ai-multi-agent-ctrl",
  transport: "streamable-http",
  hostedBy: serverUrl,
  logicalServers: logicalServersFromTools(),
  toolCount: mcpToolNames.length,
  mcpServers: {"ai_multi_agent_ctrl": remoteEntry}
});
outputs.push(join(outputDir, "mcp-server.json"));

if (client === "all" || client === "codex") writeCodexSnippet();
if (client === "all" || client === "claude") writeJsonSnippet("claude_desktop_config.json");
if (client === "all" || client === "cursor") writeJsonSnippet("cursor_mcp.json");
if (apply) applyClientConfig();

console.log("remote MCP client registration artifacts generated");
console.log(`server: ${mcpUrl}`);
console.log(`transport: streamable-http`);
console.log(`tool count: ${mcpToolNames.length}`);
for (const output of outputs) console.log(`config: ${output}`);

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (arg === "--apply") parsed.apply = true;
    else if (arg.startsWith("--client=")) parsed.client = arg.slice("--client=".length);
    else if (arg.startsWith("--target=")) parsed.target = arg.slice("--target=".length);
    else if (arg.startsWith("--config=")) parsed.config = arg.slice("--config=".length);
    else if (arg.startsWith("--output-dir=")) parsed.outputDir = arg.slice("--output-dir=".length);
    else if (arg.startsWith("--server-url=")) parsed.serverUrl = arg.slice("--server-url=".length);
    else if (arg.startsWith("--token=")) parsed.token = arg.slice("--token=".length);
    else if (arg.startsWith("--token-env=")) parsed.tokenEnv = arg.slice("--token-env=".length);
    else unknownFlags.push(arg);
  }
  return parsed;
}

function normalizeServerUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    // 原先这里直接冒到 node:internal/url 的崩溃栈，连"是哪个参数"都不说。
    fail(`控制面地址不是一个合法的 URL：${value}`,
      ["它来自 --server-url=，或环境变量 AIMAC_PUBLIC_URL",
       "要带协议，形如 https://aimac.example.com 或 http://127.0.0.1:4317"]);
  }
  const local = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local) && process.env.AIMAC_ALLOW_INSECURE_REMOTE_MCP !== "true") {
    fail(`远程 MCP 必须走 HTTPS，而这个地址是 ${parsed.protocol}//${parsed.hostname}`,
      ["MCP 请求头里带的是 Bearer 令牌，明文传输等于把它交出去",
       "本机地址（127.0.0.1 / localhost / ::1）不受此限",
       "隔离环境下确要放行：设 AIMAC_ALLOW_INSECURE_REMOTE_MCP=true"]);
  }
  return String(value).replace(/\/+$/u, "");
}

function logicalServersFromTools() {
  return [...new Set(mcpToolNames.map((name) => name.split(".")[0]))].sort();
}

function writeJson(path, value) {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600});
}

function writeJsonSnippet(filename) {
  const path = join(outputDir, filename);
  writeJson(path, {mcpServers: {"ai_multi_agent_ctrl": remoteEntry}});
  outputs.push(path);
}

function writeCodexSnippet() {
  const path = join(outputDir, "codex_config.toml");
  writeFileSync(path, codexTomlBlock(), {mode: 0o600});
  outputs.push(path);
}

function codexTomlBlock() {
  return [
    "# BEGIN ai-multi-agent-ctrl REMOTE MCP",
    "[mcp_servers.ai_multi_agent_ctrl]",
    `url = ${JSON.stringify(mcpUrl)}`,
    ...(bearerToken
      ? [`http_headers = { Authorization = ${JSON.stringify(`Bearer ${bearerToken}`)} }`]
      : [`bearer_token_env_var = ${JSON.stringify(tokenEnv)}`]),
    "# END ai-multi-agent-ctrl REMOTE MCP",
    ""
  ].join("\n");
}

function applyClientConfig() {
  const configPath = resolve(args.config || defaultClientConfigPath(client));
  if (client === "codex") {
    const previous = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    const next = replaceMarkedBlock(previous, codexTomlBlock());
    mkdirSync(dirname(configPath), {recursive: true});
    writeFileSync(configPath, next, {mode: 0o600});
    outputs.push(configPath);
    return;
  }
  const raw = existsSync(configPath) ? readFileSync(configPath, "utf8").trim() : "";
  const previous = raw ? JSON.parse(raw) : {};
  previous.mcpServers ||= {};
  previous.mcpServers.ai_multi_agent_ctrl = remoteEntry;
  delete previous.mcpServers["ai-multi-agent-ctrl"];
  writeJson(configPath, previous);
  outputs.push(configPath);
}

function defaultClientConfigPath(selectedClient) {
  const userHome = process.env.HOME;
  if (!userHome) {
    fail("取不到你的用户目录（HOME 没有设），所以不知道该把配置写到哪",
      ["用 --config=<配置文件路径> 直接指定", "或设好 HOME 再重跑"]);
  }
  if (target !== "user") {
    if (selectedClient === "claude") return join(outputDir, "claude_desktop_config.json");
    if (selectedClient === "cursor") return join(outputDir, "cursor_mcp.json");
    return join(outputDir, "codex_config.toml");
  }
  if (selectedClient === "claude") return join(userHome, ".claude", "mcp.json");
  if (selectedClient === "cursor") return join(userHome, ".cursor", "mcp.json");
  return join(process.env.CODEX_HOME || join(userHome, ".codex"), "config.toml");
}

function replaceMarkedBlock(previous, block) {
  const start = "# BEGIN ai-multi-agent-ctrl REMOTE MCP";
  const end = "# END ai-multi-agent-ctrl REMOTE MCP";
  const startIndex = previous.indexOf(start);
  const endIndex = previous.indexOf(end);
  if (startIndex >= 0 && endIndex > startIndex) {
    const before = previous.slice(0, startIndex).trimEnd();
    const after = previous.slice(endIndex + end.length).trimStart();
    return [before, block.trimEnd(), after].filter(Boolean).join("\n\n") + "\n";
  }
  return [previous.trimEnd(), block.trimEnd()].filter(Boolean).join("\n\n") + "\n";
}

// 一句人话 + 下一步，退出码 1；堆栈留给 AIMAC_REGISTER_MCP_DEBUG=1。
// 与 agentctl / agent 运行时同规：运维在自己机器上敲命令，不该收到一段 Node 崩溃栈。
function fail(summary, nextSteps = []) {
  console.error(`register-mcp-client: ${summary}`);
  for (const step of nextSteps.filter(Boolean)) console.error(`  \u00b7 ${step}`);
  if (process.env.AIMAC_REGISTER_MCP_DEBUG === "1") console.error(new Error(summary).stack);
  else console.error("  \uff08\u8981\u770b\u5b8c\u6574\u5806\u6808\uff1aAIMAC_REGISTER_MCP_DEBUG=1 \u91cd\u8dd1\uff09");
  process.exit(1);
}
