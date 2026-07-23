#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mcpToolNames } from "../apps/mcp-server/server.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
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

if (apply && client === "all") throw new Error("--apply requires --client=codex, --client=claude or --client=cursor");
if (apply && !bearerToken && client !== "codex") throw new Error("--apply for JSON MCP clients requires --token or AIMAC_MCP_BEARER_TOKEN");

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
  mcpServers: {"ai-multi-agent-ctrl": remoteEntry}
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
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!["all", "codex", "claude", "cursor"].includes(parsed.client || "all")) throw new Error("--client must be all, codex, claude or cursor");
  if (!["project", "user"].includes(parsed.target || "project")) throw new Error("--target must be project or user");
  return parsed;
}

function normalizeServerUrl(value) {
  const parsed = new URL(value);
  const local = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local) && process.env.AIMAC_ALLOW_INSECURE_REMOTE_MCP !== "true") {
    throw new Error("remote MCP requires HTTPS; set AIMAC_ALLOW_INSECURE_REMOTE_MCP=true only for isolated verification");
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
  writeJson(path, {mcpServers: {"ai-multi-agent-ctrl": remoteEntry}});
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
  previous.mcpServers["ai-multi-agent-ctrl"] = remoteEntry;
  writeJson(configPath, previous);
  outputs.push(configPath);
}

function defaultClientConfigPath(selectedClient) {
  const userHome = process.env.HOME;
  if (!userHome) throw new Error("--config is required when HOME is unavailable");
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
