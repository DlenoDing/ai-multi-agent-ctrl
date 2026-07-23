#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mcpToolNames } from "../apps/mcp-server/server.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const client = args.client || "all";
const target = args.target || "project";
const apply = Boolean(args.apply);
const runtimeDir = resolve(root, args.runtimeDir || process.env.AIMAC_RUNTIME_DIR || ".runtime");
const outputDir = resolve(root, args.outputDir || process.env.AIMAC_MCP_CONFIG_DIR || join(".runtime", "mcp-client-configs"));
const serverPath = resolve(root, "apps", "mcp-server", "server.mjs");
const tokenPath = join(runtimeDir, "mcp-client-token");
const nodeCommand = args.node || process.execPath;

mkdirSync(runtimeDir, {recursive: true});
mkdirSync(outputDir, {recursive: true});

const token = ensureToken(tokenPath);
const serverEntry = {
  command: nodeCommand,
  args: [serverPath],
  env: {
    AIMAC_RUNTIME_DIR: runtimeDir,
    AIMAC_REPOSITORY_ROOT: root,
    AIMAC_MCP_TOKEN: token,
    AIMAC_MCP_LOCAL_WRITE_ENABLE: "true"
  }
};

const outputs = [];

function main() {
  if (apply && client === "all") {
    throw new Error("--apply requires --client=codex, --client=claude or --client=cursor");
  }
  const canonical = {
    generatedBy: "ai-multi-agent-ctrl",
    serverName: "ai-multi-agent-ctrl",
    logicalServers: logicalServersFromTools(),
    toolCount: mcpToolNames.length,
    mcpServers: {"ai-multi-agent-ctrl": serverEntry}
  };
  writeJson(join(outputDir, "mcp-server.json"), canonical);
  outputs.push(join(outputDir, "mcp-server.json"));

  if (client === "all" || client === "codex") writeCodexSnippet();
  if (client === "all" || client === "claude") writeJsonSnippet("claude_desktop_config.json");
  if (client === "all" || client === "cursor") writeJsonSnippet("cursor_mcp.json");

  if (apply) applyClientConfig();

  console.log("mcp client registration artifacts generated");
  console.log(`server: ai-multi-agent-ctrl`);
  console.log(`tool count: ${mcpToolNames.length}`);
  console.log(`runtime dir: ${runtimeDir}`);
  for (const output of outputs) console.log(`config: ${output}`);
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (arg === "--apply") parsed.apply = true;
    else if (arg.startsWith("--client=")) parsed.client = arg.slice("--client=".length);
    else if (arg.startsWith("--target=")) parsed.target = arg.slice("--target=".length);
    else if (arg.startsWith("--config=")) parsed.config = arg.slice("--config=".length);
    else if (arg.startsWith("--runtime-dir=")) parsed.runtimeDir = arg.slice("--runtime-dir=".length);
    else if (arg.startsWith("--output-dir=")) parsed.outputDir = arg.slice("--output-dir=".length);
    else if (arg.startsWith("--node=")) parsed.node = arg.slice("--node=".length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!["all", "codex", "claude", "cursor"].includes(parsed.client || "all")) throw new Error("--client must be all, codex, claude or cursor");
  if (!["project", "user"].includes(parsed.target || "project")) throw new Error("--target must be project or user");
  return parsed;
}

function ensureToken(path) {
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const token = `aimac_mcp_${randomBytes(24).toString("hex")}`;
  writeFileSync(path, `${token}\n`, {mode: 0o600});
  return token;
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
  writeJson(path, {mcpServers: {"ai-multi-agent-ctrl": serverEntry}});
  outputs.push(path);
}

function writeCodexSnippet() {
  const path = join(outputDir, "codex_config.toml");
  writeFileSync(path, codexTomlBlock(), {mode: 0o600});
  outputs.push(path);
}

function codexTomlBlock() {
  return [
    "# BEGIN ai-multi-agent-ctrl MCP",
    "[mcp_servers.ai_multi_agent_ctrl]",
    `command = ${tomlString(serverEntry.command)}`,
    `args = [${serverEntry.args.map(tomlString).join(", ")}]`,
    "[mcp_servers.ai_multi_agent_ctrl.env]",
    ...Object.entries(serverEntry.env).map(([key, value]) => `${key} = ${tomlString(value)}`),
    "# END ai-multi-agent-ctrl MCP",
    ""
  ].join("\n");
}

function tomlString(value) {
  return JSON.stringify(String(value));
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
  previous.mcpServers["ai-multi-agent-ctrl"] = serverEntry;
  writeJson(configPath, previous);
  outputs.push(configPath);
}

function defaultClientConfigPath(selectedClient) {
  if (args.config) return args.config;
  const home = process.env.HOME;
  if (!home) throw new Error("--config is required when HOME is unavailable");
  if (target !== "user") {
    if (selectedClient === "claude") return join(outputDir, "claude_desktop_config.json");
    if (selectedClient === "cursor") return join(outputDir, "cursor_mcp.json");
    return join(outputDir, "codex_config.toml");
  }
  if (selectedClient === "claude") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (selectedClient === "cursor") return join(home, ".cursor", "mcp.json");
  return join(process.env.CODEX_HOME || join(home, ".codex"), "config.toml");
}

function replaceMarkedBlock(previous, block) {
  const start = "# BEGIN ai-multi-agent-ctrl MCP";
  const end = "# END ai-multi-agent-ctrl MCP";
  const startIndex = previous.indexOf(start);
  const endIndex = previous.indexOf(end);
  if (startIndex >= 0 && endIndex > startIndex) {
    const before = previous.slice(0, startIndex).trimEnd();
    const after = previous.slice(endIndex + end.length).trimStart();
    return [before, block.trimEnd(), after].filter(Boolean).join("\n\n") + "\n";
  }
  return [previous.trimEnd(), block.trimEnd()].filter(Boolean).join("\n\n") + "\n";
}

main();
