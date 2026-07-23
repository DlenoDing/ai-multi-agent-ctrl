#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isStateStoreConflict, readStoredState, writeStoredState } from "../apps/control-plane-ui/lib/state-store.mjs";
import { createMcpGrant, createMcpToolDefinitions, mcpToolNames } from "../apps/mcp-server/server.mjs";
import { buildTaskContract, ensureRuntimeCollections, runAutonomousCycle, selectModel } from "../apps/control-plane-ui/lib/control-plane-core.mjs";
import {
  authenticateAgentNode,
  claimNextDispatch,
  createAgentJoinToken,
  getSkillWorkset,
  heartbeatAgentNode,
  registerAgentNode,
  revokeAgentNode
} from "../apps/control-plane-ui/lib/agent-gateway.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const seedState = loadJson("data/seed-state.json");
const runtimeSchema = loadJson("spec/runtime-bootstrap.schema.json");
const mcpGrantSchema = loadJson("spec/mcp-grant.schema.json");
const joinTokenSchema = loadJson("spec/agent-join-token.schema.json");
const runtimeNodeSchema = loadJson("spec/agent-runtime-node.schema.json");
const skillWorksetSchema = loadJson("spec/agent-skill-workset.schema.json");
const errors = [];

validateSchema(seedState.runtime, runtimeSchema, "seed.runtime", errors);
verifyAgentGatewayContracts(errors);

for (const toolName of ["ui-console-mcp.runtime_health_get", "room-mcp.room_send", "agent-control-mcp.dispatch_status"]) {
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
  for (const requiredKey of tool.inputSchema?.required || []) {
    if (!tool.inputSchema.properties?.[requiredKey]) errors.push(`MCP tool ${tool.name} required key ${requiredKey} missing from properties`);
  }
  if (tool.outputSchema?.type !== "object") errors.push(`MCP tool ${tool.name} outputSchema must be object`);
}

verifyRuntimeJsonConflict(errors);

if (errors.length) {
  console.error("contract check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

function verifyRuntimeJsonConflict(output) {
  const previousStore = process.env.AIMAC_STATE_STORE;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.AIMAC_STATE_STORE = "runtime_json";
  delete process.env.DATABASE_URL;
  const runtimeDir = mkdtempSync(join(tmpdir(), "aimac-contract-state-"));
  const options = {
    root,
    runtimeDir,
    statePath: join(runtimeDir, "control-plane-state.json"),
    seedPath: resolve(root, "data", "seed-state.json"),
    buildInitialState: () => ({stateVersion: 1, runtime: {}})
  };
  try {
    writeStoredState({stateVersion: 1, runtime: {}}, options);
    const first = readStoredState(options);
    const second = readStoredState(options);
    first.stateVersion = 2;
    writeStoredState(first, {...options, expectedStateVersion: first.__loadedStateVersion});
    second.stateVersion = 2;
    try {
      writeStoredState(second, {...options, expectedStateVersion: second.__loadedStateVersion});
      output.push("runtime_json state-store did not reject stale expectedStateVersion");
    } catch (error) {
      if (!isStateStoreConflict(error)) output.push(`runtime_json state-store stale write raised wrong error: ${error.message}`);
    }
  } finally {
    if (previousStore === undefined) delete process.env.AIMAC_STATE_STORE;
    else process.env.AIMAC_STATE_STORE = previousStore;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    rmSync(runtimeDir, {recursive: true, force: true});
  }
}

function verifyAgentGatewayContracts(output) {
  const state = JSON.parse(JSON.stringify(seedState));
  ensureRuntimeCollections(state, {root});
  const issued = createAgentJoinToken(state, {projectId: "prj_control_plane", nodeName: "contract-node", allowedRoles: ["*"]}, {publicUrl: "https://control.example.test"});
  validateSchema(state.agentJoinTokens[0], joinTokenSchema, "AgentJoinToken", output);
  if (!issued.installCommand.startsWith("curl -fsSL 'https://control.example.test/install-agent.sh' | sh -s --")) output.push("Agent join token did not return a one-line server-hosted installer command");
  if (!issued.verifiedInstallCommand.includes("( if command -v sha256sum") || !issued.verifiedInstallCommand.includes("elif command -v shasum") || !issued.verifiedInstallCommand.endsWith(`--join-token '${issued.joinToken}'`)) {
    output.push("Agent join token did not return a portable checksum-verified installer command");
  }
  const registered = registerAgentNode(state, {nodeName: "contract-node", requestedRoles: ["*"], runtimeVersion: "contract", profile: {platform: "test", arch: "test", tools: [], models: [{providerClass: "custom", available: true}]}}, {joinToken: issued.joinToken, publicUrl: "https://control.example.test"});
  validateSchema(state.agentRuntimeNodes[0], runtimeNodeSchema, "AgentRuntimeNode", output);
  const contract = buildTaskContract(state, {taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", root});
  if (!contract.model.modelId || !contract.model.reasoningLevel || !contract.model.modelTier || contract.model.maxModelTier !== "frontier_standard" || contract.model.maxReasoningLevel !== "high") {
    output.push("AgentTaskContract did not bind explicit provider-neutral model tier and reasoning ceiling");
  }
  const deepAnalysisDecision = selectModel(state, {projectId: "prj_control_plane", taskGroupId: "tg_runtime_management", roleId: "orchestrator", workItem: {id: "work_deep_analysis", title: "深度分析架构方案", ownerRole: "orchestrator", requirements: ["analysis only"]}});
  if (deepAnalysisDecision.taskExecutionClass !== "deep_analysis" || deepAnalysisDecision.maxModelTier !== "frontier_standard" || deepAnalysisDecision.maxReasoningLevel !== "high" || deepAnalysisDecision.escalationAllowed !== false) {
    output.push("Model selection did not enforce provider-neutral default ceiling for deep analysis");
  }
  const mixedState = JSON.parse(JSON.stringify(seedState));
  ensureRuntimeCollections(mixedState, {root});
  const mixedTaskGroup = mixedState.taskGroups.find((item) => item.id === "tg_runtime_management");
  mixedTaskGroup.workItems.unshift({id: "work_mixed_model_split", title: "深度分析并开发实现完整代码", status: "ready", ownerRole: "agent-runtime", progress: 0, requirements: ["analysis", "implementation"]});
  const splitResult = runAutonomousCycle(mixedState, {root, runtimeDir: join(root, ".runtime"), endpoint: "https://control.example.test", mode: "single", taskGroupId: "tg_runtime_management", autoSyncSkills: false});
  if (!splitResult.changed.some((item) => item.reason === "mixed_analysis_implementation_split") || !mixedTaskGroup.workItems.some((item) => item.id === "work_mixed_model_split_analysis") || !mixedTaskGroup.workItems.some((item) => item.id === "work_mixed_model_split_implementation")) {
    output.push("Orchestrator did not split mixed deep-analysis and implementation work before model assignment");
  }
  state.agentDispatches.unshift({
    schemaVersion: "agent-dispatch/v1",
    dispatchId: "adp_contract_gateway",
    projectId: contract.projectId,
    taskGroupId: contract.taskGroupId,
    workItemId: contract.workId,
    sessionId: contract.sessionId,
    runId: contract.runId,
    status: "queued",
    deliveryMode: "new_session",
    modelSelectionDecisionRef: contract.model.modelSelectionDecisionRef,
    taskContractDigest: contract.contractDigest,
    taskContractRef: `AgentTaskContract:${contract.commandId}`,
    repositoryOutputTargetRef: contract.repositoryOutputTargetRef,
    roleId: contract.roleId,
    skillWorksetId: contract.roleSkill.worksetId,
    requiredCredentialEnvNames: [],
    workerKind: "model_agent_runtime",
    attempts: 0,
    checkpointRequired: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  try {
    getSkillWorkset(state, state.agentRuntimeNodes[0], contract.roleSkill.worksetId, {runtimeDir: join(root, ".runtime")});
    output.push("Agent Gateway allowed skill workset download before dispatch claim");
  } catch {}
  if (registered.gateway.mcpUrl !== "https://control.example.test/mcp") output.push("AgentRuntimeNode registration did not bind remote MCP URL");
  const node = state.agentRuntimeNodes[0];
  const firstNodeToken = registered.nodeToken;
  node.credentialExpiresAt = new Date(Date.now() + 60 * 1000).toISOString();
  const rotated = heartbeatAgentNode(state, node, {profile: node.profile}, {presentedToken: firstNodeToken});
  if (!rotated.nodeToken) output.push("Agent heartbeat did not rotate near-expiry node credentials");
  if (rotated.nodeToken && !authenticateAgentNode(state, firstNodeToken)) output.push("Agent Gateway rejected previous credential during rotation overlap");
  if (rotated.nodeToken && !authenticateAgentNode(state, rotated.nodeToken)) output.push("Agent Gateway rejected rotated current credential");
  node.status = "online";
  node.admission = "full";
  const claimed = claimNextDispatch(state, node, {runtimeDir: join(root, ".runtime"), claimTtlSeconds: 300});
  if (!claimed.dispatch) output.push(`Agent Gateway did not claim a compatible dispatch: ${claimed.reason || "unknown"}`);
  if (claimed.dispatch) {
    const workset = getSkillWorkset(state, state.agentRuntimeNodes[0], contract.roleSkill.worksetId, {runtimeDir: join(root, ".runtime")});
    validateSchema(workset, skillWorksetSchema, "AgentSkillWorkset", output);
    const issuedGrant = state.mcpGrants.find((grant) => grant.agentNodeId === node.nodeId && grant.dispatchId === claimed.dispatch.dispatch.dispatchId && grant.grantStatus === "issued");
    if (!issuedGrant) output.push("Agent Gateway did not issue dispatch-bound MCP grants after claim");
  }
  const claimedDispatchId = claimed.dispatch?.dispatch.dispatchId;
  if (claimedDispatchId) {
    const revoked = revokeAgentNode(state, node);
    const requeued = state.agentDispatches.find((dispatch) => dispatch.dispatchId === claimedDispatchId);
    if (!revoked.requeuedDispatchIds.includes(claimedDispatchId) || requeued?.status !== "queued" || requeued.assignedNodeId) {
      output.push("Agent node revocation did not requeue its running dispatch");
    }
  }
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
