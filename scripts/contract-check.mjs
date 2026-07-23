#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpGrant, createMcpToolDefinitions, mcpToolNames } from "../apps/mcp-server/server.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const seedState = loadJson("data/seed-state.json");
const runtimeSchema = loadJson("spec/runtime-bootstrap.schema.json");
const mcpGrantSchema = loadJson("spec/mcp-grant.schema.json");
const errors = [];

validateSchema(seedState.runtime, runtimeSchema, "seed.runtime", errors);

for (const toolName of ["ui-console-mcp.runtime_health_get", "room-mcp.room_send", "agent-control-mcp.runtime_run"]) {
  validateSchema(createMcpGrant(toolName, {tokenDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}), mcpGrantSchema, `McpGrant:${toolName}`, errors);
}

const toolNamePattern = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u;
const toolDefs = createMcpToolDefinitions();
const toolDefNames = new Set(toolDefs.map((tool) => tool.name));
for (const toolName of mcpToolNames) {
  if (!toolDefNames.has(toolName)) errors.push(`MCP tool definition missing ${toolName}`);
}
for (const tool of toolDefs) {
  if (!toolNamePattern.test(tool.name)) errors.push(`MCP tool name invalid: ${tool.name}`);
  if (tool.inputSchema?.type !== "object") errors.push(`MCP tool ${tool.name} inputSchema must be object`);
  if (tool.inputSchema?.additionalProperties !== false) errors.push(`MCP tool ${tool.name} inputSchema must be closed`);
  if (tool.outputSchema?.type !== "object") errors.push(`MCP tool ${tool.name} outputSchema must be object`);
}

if (errors.length) {
  console.error("contract check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("contract check ok");

function loadJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function validateSchema(value, schema, path, output) {
  if (!schema || typeof schema !== "object") return;
  if (schema.const !== undefined && value !== schema.const) output.push(`${path} expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  if (schema.enum && !schema.enum.includes(value)) output.push(`${path} expected enum ${schema.enum.join("|")}, got ${JSON.stringify(value)}`);
  if (schema.type) validateType(value, schema.type, path, output);
  if (schema.type === "string" && schema.minLength && String(value || "").length < schema.minLength) output.push(`${path} expected minLength ${schema.minLength}`);
  if ((schema.type === "integer" || schema.type === "number") && schema.minimum !== undefined && Number(value) < schema.minimum) output.push(`${path} expected minimum ${schema.minimum}`);
  if (schema.type === "array" && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) output.push(`${path} expected minItems ${schema.minItems}`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) output.push(`${path} expected uniqueItems`);
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`, output));
  }
  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (value[key] === undefined) output.push(`${path}.${key} is required`);
    }
    const properties = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) output.push(`${path}.${key} is not allowed by schema`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (value[key] !== undefined) validateSchema(value[key], childSchema, `${path}.${key}`, output);
    }
  }
}

function validateType(value, type, path, output) {
  if (type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) output.push(`${path} expected object`);
  if (type === "array" && !Array.isArray(value)) output.push(`${path} expected array`);
  if (type === "string" && typeof value !== "string") output.push(`${path} expected string`);
  if (type === "boolean" && typeof value !== "boolean") output.push(`${path} expected boolean`);
  if (type === "integer" && !Number.isInteger(value)) output.push(`${path} expected integer`);
  if (type === "number" && typeof value !== "number") output.push(`${path} expected number`);
}
