#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isStateStoreConflict, readStoredState, writeStoredState } from "../apps/control-plane-ui/lib/state-store.mjs";
import { createMcpGrant, createMcpToolDefinitions, mcpToolNames } from "../apps/mcp-server/server.mjs";
import { buildTaskContract, ensureRuntimeCollections, runAutonomousCycle, selectModel, updateTaskGroupLanguagePolicy } from "../apps/control-plane-ui/lib/control-plane-core.mjs";
import {
  ackAgentControlCommand,
  authenticateAgentNode,
  claimNextDispatch,
  createAgentControlCommand,
  createAgentJoinToken,
  getSkillWorkset,
  heartbeatAgentNode,
  listAgentControlCommands,
  registerAgentNode,
  requestAgentNodeRevocation,
  selfCheckAgentNode,
  submitAgentExecutionEvent
} from "../apps/control-plane-ui/lib/agent-gateway.mjs";
import { appendProjectExecutionEvent, readProjectExecutionEventByKey, readProjectExecutionEvents } from "../apps/control-plane-ui/lib/project-event-store.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const seedState = loadJson("data/seed-state.json");
const runtimeSchema = loadJson("spec/runtime-bootstrap.schema.json");
const mcpGrantSchema = loadJson("spec/mcp-grant.schema.json");
const joinTokenSchema = loadJson("spec/agent-join-token.schema.json");
const agentDispatchSchema = loadJson("spec/agent-dispatch.schema.json");
const agentControlCommandSchema = loadJson("spec/agent-control-command.schema.json");
const agentExecutionEventSchema = loadJson("spec/agent-execution-event.schema.json");
const runtimeNodeSchema = loadJson("spec/agent-runtime-node.schema.json");
const skillWorksetSchema = loadJson("spec/agent-skill-workset.schema.json");
const agentTaskContractSchema = loadJson("spec/agent-task-contract.schema.json");
const effectiveInstructionPacketSchema = loadJson("spec/effective-instruction-packet.schema.json");
const languagePolicySchema = loadJson("spec/language-policy.schema.json");
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
    writeStoredState({
      stateVersion: 3,
      runtime: {},
      taskGroups: [{id: "tg_collision_a", projectId: "project/a", workItems: []}],
      agentDispatches: [{dispatchId: "adp_collision_a", projectId: "project/a", taskGroupId: "tg_collision_a", updatedAt: new Date().toISOString()}],
      idempotencyRecords: {}
    }, {...options, expectedStateVersion: 2});
	    const sharded = readStoredState(options);
	    if (!sharded.agentDispatches.some((dispatch) => dispatch.dispatchId === "adp_collision_a")) {
	      output.push("runtime_json project shard did not hydrate project-scoped dispatches");
	    }
		    const centralShardIndex = JSON.parse(readFileSync(options.statePath, "utf8")).projectStateShards?.projects?.find((project) => project.projectId === "project/a");
		    if (!centralShardIndex?.storageRef?.match(/project-db\/p_[a-f0-9]{24}\.sv[0-9]+-[a-f0-9]{12}\.state\.json/u)) {
		      output.push("runtime_json project shard index did not point at a generation-qualified hash shard file");
		    }
        if (!centralShardIndex?.storagePayloadDigest || !centralShardIndex?.storagePayloadBytes) {
          output.push("runtime_json project shard index did not record shard payload digest and size");
        } else {
          const shardPath = join(runtimeDir, centralShardIndex.storageRef.replace(/^runtime:\/\//u, ""));
          const originalShard = readFileSync(shardPath, "utf8");
          writeFileSync(shardPath, originalShard.replace("adp_collision_a", "adp_tampered"));
          try {
            readStoredState(options);
            output.push("runtime_json project shard digest mismatch was not rejected");
          } catch {}
          writeFileSync(shardPath, originalShard);
        }
		    writeStoredState({stateVersion: 4, runtime: {}, taskGroups: [], agentDispatches: [], idempotencyRecords: {}}, {...options, expectedStateVersion: sharded.__loadedStateVersion});
    const emptied = readStoredState(options);
    if (emptied.agentDispatches.some((dispatch) => dispatch.dispatchId === "adp_collision_a") || emptied.taskGroups.some((taskGroup) => taskGroup.id === "tg_collision_a")) {
      output.push("runtime_json project shard stale data was resurrected after shard deletion");
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
  try {
    createAgentJoinToken(state, {projectId: "prj_control_plane", nodeName: "bad-contract-node", allowedRoles: ["*"], maxUses: 2}, {publicUrl: "https://control.example.test"});
    output.push("Agent join token allowed maxUses greater than one");
  } catch {}
  if (!issued.installCommand.includes("curl -fsSL 'https://control.example.test/install-agent.sh' | sh -s --")) output.push("Agent join token did not return a server-hosted installer command");
  if (issued.installCommand.includes("--join-token ") || issued.verifiedInstallCommand.includes("--join-token ") || !issued.installCommand.includes("--join-token-file") || !issued.verifiedInstallCommand.includes("--join-token-file")) {
    output.push("Agent join token installer command exposed token in argv instead of using --join-token-file");
  }
  if (!issued.verifiedInstallCommand.includes("( if command -v sha256sum") || !issued.verifiedInstallCommand.includes("elif command -v shasum") || !issued.verifiedInstallCommand.includes("--join-token-file \"$tmp/aimac.join\"")) {
    output.push("Agent join token did not return a portable checksum-verified installer command using token file");
  }
  const registered = registerAgentNode(state, {nodeName: "contract-node", requestedRoles: ["*"], runtimeVersion: "contract", profile: {platform: "test", arch: "test", tools: [], models: [{providerClass: "custom", available: true}]}}, {joinToken: issued.joinToken, publicUrl: "https://control.example.test"});
  const registeredNode = state.agentRuntimeNodes.find((item) => item.nodeId === registered.node.nodeId);
  validateSchema(registeredNode, runtimeNodeSchema, "AgentRuntimeNode", output);
  const noExecutorIssued = createAgentJoinToken(state, {projectId: "prj_control_plane", nodeName: "contract-no-executor", allowedRoles: ["*"]}, {publicUrl: "https://control.example.test"});
  registerAgentNode(state, {nodeName: "contract-no-executor", requestedRoles: ["*"], runtimeVersion: "contract", profile: {platform: "test", arch: "test", tools: [], models: [{providerClass: "custom", adapter: "unconfigured", available: false}]}}, {joinToken: noExecutorIssued.joinToken, publicUrl: "https://control.example.test"});
  const noExecutorNode = state.agentRuntimeNodes.find((item) => item.nodeName === "contract-no-executor");
  const noExecutorCheck = selfCheckAgentNode(state, noExecutorNode, {checks: [
    {checkId: "runtime", status: "ok"},
    {checkId: "gateway", status: "ok"},
    {checkId: "filesystem", status: "ok"},
    {checkId: "git", status: "ok"},
    {checkId: "remote_mcp", status: "ok"},
    {checkId: "model_executor", status: "failed"}
  ]});
  if (noExecutorCheck.ok || noExecutorNode.admission !== "read_only") output.push("Agent Gateway admitted a node without a runnable model executor");
  const contract = buildTaskContract(state, {taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", root});
  validateSchema(contract, agentTaskContractSchema, "AgentTaskContract", output);
  const instructionPacket = state.effectiveInstructionPackets.find((packet) => packet.packetId === contract.effectiveInstructionPacketRef);
  validateSchema(instructionPacket, effectiveInstructionPacketSchema, "EffectiveInstructionPacket", output);
  if (!contract.model.model || !contract.model.modelId || !contract.model.reasoning || !contract.model.reasoningLevel || !contract.model.modelDecision || !contract.model.modelDecision.startsWith("modelDecision:")) {
    output.push("AgentTaskContract did not bind explicit model, reasoning and short modelDecision");
  }
  if (!contract.languagePolicy?.languageTag || !contract.languagePolicyDigest || contract.outputContract.languagePolicyDigest !== contract.languagePolicyDigest || !contract.inputLocators.some((locator) => locator.includes("language-policy"))) {
    output.push("AgentTaskContract did not bind task-group language policy through contract, locators and output contract");
  }
  if (!instructionPacket?.languagePolicyDigest || instructionPacket.languagePolicyDigest !== contract.languagePolicyDigest || !instructionPacket.languageDirective?.includes(contract.languagePolicy.languageTag)) {
    output.push("EffectiveInstructionPacket did not carry the task-group language policy");
  }
  const languageState = JSON.parse(JSON.stringify(seedState));
  ensureRuntimeCollections(languageState, {root});
  languageState.taskGroups.find((item) => item.id === "tg_runtime_management").languagePolicy.fallback = "legacy_invalid_fallback";
  const updatedLanguage = updateTaskGroupLanguagePolicy(languageState, "tg_runtime_management", {languageTag: "fr", languageName: "French"});
  validateSchema(updatedLanguage.languagePolicy, languagePolicySchema, "UpdatedLanguagePolicy", output);
  const localizedContract = buildTaskContract(languageState, {taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", root});
  const localizedPacket = languageState.effectiveInstructionPackets.find((packet) => packet.packetId === localizedContract.effectiveInstructionPacketRef);
  if (localizedContract.languagePolicy.languageTag !== "fr" ||
      localizedContract.languagePolicyDigest !== updatedLanguage.languagePolicyDigest ||
      localizedContract.outputContract.requiredLanguage !== "fr" ||
      localizedPacket?.languagePolicyDigest !== updatedLanguage.languagePolicyDigest ||
      !localizedPacket.languageDirective?.includes("fr/French") ||
      localizedContract.languagePolicy.fallback !== "return_blocked_for_language_mismatch") {
    output.push("Task-group language policy update did not propagate to new contracts, EIP and output contract");
  }
	  const deepAnalysisDecision = selectModel(state, {projectId: "prj_control_plane", taskGroupId: "tg_runtime_management", roleId: "orchestrator", workItem: {id: "work_deep_analysis", title: "深度分析架构方案", ownerRole: "orchestrator", requirements: ["analysis only"]}});
  if (deepAnalysisDecision.taskExecutionClass !== "deep_analysis" || deepAnalysisDecision.escalationAllowed !== false || !deepAnalysisDecision.modelDecision?.startsWith("modelDecision:") || deepAnalysisDecision.modelDecision.length > 240) {
    output.push("Model selection did not create a bounded one-line integration-owner modelDecision");
	  }
  const unavailableState = JSON.parse(JSON.stringify(seedState));
  ensureRuntimeCollections(unavailableState, {root});
  const baselineDecision = selectModel(unavailableState, {projectId: "prj_control_plane", taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", roleId: "ui-console-service"});
  const baselineModelId = baselineDecision.selectedModel?.modelId;
  const unavailableModel = unavailableState.modelCapabilities.find((item) => item.modelId === baselineModelId);
  if (unavailableModel) unavailableModel.availability = "unavailable";
  const fallbackDecision = selectModel(unavailableState, {projectId: "prj_control_plane", taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", roleId: "ui-console-service"});
  if (baselineModelId && fallbackDecision.selectedModel?.modelId === baselineModelId) {
    output.push("Model selection chose a provider/model marked unavailable instead of the next ranked model");
  }
  unavailableState.modelCapabilities.forEach((item) => { item.availability = "unavailable"; });
  const rejectedDecision = selectModel(unavailableState, {projectId: "prj_control_plane", taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", roleId: "ui-console-service"});
  if (rejectedDecision.status !== "rejected" || !rejectedDecision.candidateRankings.some((item) => String(item.rejectionReason || "").includes("availability_unavailable"))) {
    output.push("Model selection did not fail closed when all models were unavailable");
  }
  try {
    buildTaskContract(unavailableState, {taskGroupId: "tg_runtime_management", workItemId: "work_management_ui", root});
    output.push("AgentTaskContract was created even though model selection was rejected");
  } catch (error) {
    if (error.code !== "AIMAC_MODEL_SELECTION_REJECTED") output.push(`AgentTaskContract rejected model failure with wrong error: ${error.message}`);
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
    model: contract.model.model,
    reasoning: contract.model.reasoning,
    modelDecision: contract.model.modelDecision,
    modelSelectionDecisionRef: contract.model.modelSelectionDecisionRef,
    language: contract.languagePolicy.languageTag,
    languagePolicyDigest: contract.languagePolicyDigest,
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
  validateSchema(state.agentDispatches[0], agentDispatchSchema, "AgentDispatch", output);
  try {
    getSkillWorkset(state, registeredNode, contract.roleSkill.worksetId, {runtimeDir: join(root, ".runtime")});
    output.push("Agent Gateway allowed skill workset download before dispatch claim");
  } catch {}
  if (registered.gateway.mcpUrl !== "https://control.example.test/mcp") output.push("AgentRuntimeNode registration did not bind remote MCP URL");
  const node = registeredNode;
  const firstNodeToken = registered.nodeToken;
  node.credentialExpiresAt = new Date(Date.now() + 60 * 1000).toISOString();
  const rotated = heartbeatAgentNode(state, node, {profile: node.profile}, {presentedToken: firstNodeToken});
  if (!rotated.nodeToken) output.push("Agent heartbeat did not rotate near-expiry node credentials");
	  if (rotated.nodeToken && !authenticateAgentNode(state, firstNodeToken)) output.push("Agent Gateway rejected previous credential during rotation overlap");
	  if (rotated.nodeToken && !authenticateAgentNode(state, rotated.nodeToken)) output.push("Agent Gateway rejected rotated current credential");
    const previousHeartbeat = heartbeatAgentNode(state, node, {profile: node.profile}, {presentedToken: firstNodeToken});
    if (previousHeartbeat.nodeToken || (rotated.nodeToken && !authenticateAgentNode(state, rotated.nodeToken))) {
      output.push("Agent heartbeat with previous credential invalidated the current node token");
    }
  node.status = "online";
  node.admission = "full";
  const claimed = claimNextDispatch(state, node, {runtimeDir: join(root, ".runtime"), claimTtlSeconds: 300});
  if (!claimed.dispatch) output.push(`Agent Gateway did not claim a compatible dispatch: ${claimed.reason || "unknown"}`);
  if (claimed.dispatch) {
    const workset = getSkillWorkset(state, registeredNode, contract.roleSkill.worksetId, {runtimeDir: join(root, ".runtime")});
    validateSchema(workset, skillWorksetSchema, "AgentSkillWorkset", output);
    if (workset.languagePolicyDigest !== contract.languagePolicyDigest || !workset.executionDirective.includes(contract.languagePolicy.languageTag)) {
      output.push("Agent skill workset did not carry the task-group language policy");
    }
    const issuedGrant = state.mcpGrants.find((grant) => grant.agentNodeId === node.nodeId && grant.dispatchId === claimed.dispatch.dispatch.dispatchId && grant.grantStatus === "issued");
    if (!issuedGrant) output.push("Agent Gateway did not issue dispatch-bound MCP grants after claim");
    if (state.mcpGrants.some((grant) => grant.agentNodeId === node.nodeId && grant.toolName === "evidence-mcp.checkpoint_submit" && grant.grantStatus === "issued")) {
      output.push("Agent Gateway issued checkpoint_submit as an Agent MCP grant instead of forcing Gateway checkpoint path");
    }
    const controlCommand = createAgentControlCommand(state, node, {commandType: "refresh_profile", dispatchId: claimed.dispatch.dispatch.dispatchId}, {actor: "contract-check", idempotencyKey: "contract-control-command"}).command;
    validateSchema(controlCommand, agentControlCommandSchema, "AgentControlCommand", output);
    const pendingCommands = listAgentControlCommands(state, node, {afterSequence: 0});
    if (!pendingCommands.commands.some((command) => command.commandId === controlCommand.commandId)) output.push("Agent control channel did not return queued command");
    const acked = ackAgentControlCommand(state, node, controlCommand.commandId, {status: "completed", result: {profileDigest: node.profileDigest}}).command;
    if (acked.status !== "completed" || !acked.resultDigest) output.push("Agent control command ack did not persist terminal status and digest");
	    const event = submitAgentExecutionEvent(state, node, {dispatchId: claimed.dispatch.dispatch.dispatchId, eventType: "executor_output", progressPercent: 45, summary: "contract event", eventKey: "contract-event-key"}).event;
	    validateSchema(event, agentExecutionEventSchema, "AgentExecutionEvent", output);
      try {
        submitAgentExecutionEvent(state, node, {dispatchId: claimed.dispatch.dispatch.dispatchId, eventType: "progress", summary: "missing key"});
        output.push("Agent execution event accepted a missing eventKey");
      } catch {}
				    const eventRuntimeDir = mkdtempSync(join(tmpdir(), "aimac-contract-events-"));
        if (event.languagePolicyDigest !== contract.languagePolicyDigest) output.push("Agent execution event did not bind the task-group language policy digest");
          const previousSegmentSize = process.env.AIMAC_PROJECT_EVENT_SEGMENT_MAX_BYTES;
			    try {
	          process.env.AIMAC_PROJECT_EVENT_SEGMENT_MAX_BYTES = "1024";
		      const stored = appendProjectExecutionEvent(eventRuntimeDir, event);
	      const durableEvent = stored.event || event;
	      const eventLog = readProjectExecutionEvents(eventRuntimeDir, event.projectId, {dispatchId: event.dispatchId, limit: 10});
	      if (!eventLog.events.some((item) => item.eventId === durableEvent.eventId) || eventLog.storage.storageKind !== "project-jsonl") {
	        output.push("Project-level execution event store did not isolate and return the dispatch event");
	      }
	      const eventByKey = readProjectExecutionEventByKey(eventRuntimeDir, event.projectId, event.eventKey);
	      if (!eventByKey || eventByKey.eventId !== durableEvent.eventId || eventByKey.sequence !== durableEvent.sequence) {
	        output.push("Project-level execution event store did not return the durable event by eventKey");
	      }
	      const firstOrdered = appendProjectExecutionEvent(eventRuntimeDir, {...event, eventId: "evt_order_first", eventKey: "order-first", sequence: 999});
	      const secondOrdered = appendProjectExecutionEvent(eventRuntimeDir, {...event, eventId: "evt_order_second", eventKey: "order-second", sequence: 1});
	      if (!(secondOrdered.event.sequence > firstOrdered.event.sequence)) {
	        output.push("Project-level execution event store did not assign append-order project sequences inside the project lock");
	      }
	      const afterFirst = readProjectExecutionEvents(eventRuntimeDir, event.projectId, {afterSequence: firstOrdered.event.sequence, limit: 10});
		      if (!afterFirst.events.some((item) => item.eventId === "evt_order_second")) {
		        output.push("Project-level execution event cursor skipped an append-later event");
		      }
          try {
            appendProjectExecutionEvent(eventRuntimeDir, {...event, eventId: "evt_missing_key", eventKey: ""});
            output.push("Project-level execution event store accepted a missing eventKey");
          } catch {}
          for (let index = 0; index < 8; index += 1) {
            appendProjectExecutionEvent(eventRuntimeDir, {...event, eventId: `evt_segment_${index}`, eventKey: `segment-${index}`, summary: "x".repeat(1200), sequence: 1});
          }
          const segmentedRead = readProjectExecutionEvents(eventRuntimeDir, event.projectId, {afterSequence: 0, limit: 50});
          const segmentEvent = readProjectExecutionEventByKey(eventRuntimeDir, event.projectId, "segment-7");
          if (!segmentEvent || !segmentedRead.events.some((item) => item.eventId === "evt_segment_7")) {
            output.push("Project-level execution event store did not read events across rotated project segments");
          }
          if (!existsSync(join(eventRuntimeDir, "project-db", `${safeProjectIdForContract(event.projectId)}.execution-events.manifest.json`))) {
            output.push("Project-level execution event store did not create a segment manifest");
          }
			      const firstStorage = appendProjectExecutionEvent(eventRuntimeDir, {...event, eventId: "evt_collision_a", eventKey: "collision-a", projectId: "project/a", sequence: 1});
      const secondStorage = appendProjectExecutionEvent(eventRuntimeDir, {...event, eventId: "evt_collision_b", eventKey: "collision-b", projectId: "project_a", sequence: 1});
      if (firstStorage.storageRef === secondStorage.storageRef) {
        output.push("Project-level execution event store collapsed sanitized project ids into the same file");
      }
	    } finally {
        if (previousSegmentSize === undefined) delete process.env.AIMAC_PROJECT_EVENT_SEGMENT_MAX_BYTES;
        else process.env.AIMAC_PROJECT_EVENT_SEGMENT_MAX_BYTES = previousSegmentSize;
	      rmSync(eventRuntimeDir, {recursive: true, force: true});
	    }
  }
  const claimedDispatchId = claimed.dispatch?.dispatch.dispatchId;
  if (claimedDispatchId) {
    const revokeRequest = requestAgentNodeRevocation(state, node, {ttlSeconds: 300}, {actor: "contract-check", idempotencyKey: "contract-node-revoke"});
    const pending = state.agentDispatches.find((dispatch) => dispatch.dispatchId === claimedDispatchId);
    if (!revokeRequest.pendingDispatchIds.includes(claimedDispatchId) || pending?.status !== "blocked" || pending.assignedNodeId !== node.nodeId || node.status !== "draining") {
      output.push("Agent node revocation request did not fence its running dispatch until runtime ACK");
    }
    if (state.mcpGrants.some((grant) => grant.agentNodeId === node.nodeId && grant.dispatchId === claimedDispatchId && grant.grantStatus === "issued")) {
      output.push("Agent node revocation request did not revoke dispatch-bound MCP grants before ACK");
    }
    ackAgentControlCommand(state, node, revokeRequest.command.commandId, {status: "completed", result: {stopped: true}});
    const requeued = state.agentDispatches.find((dispatch) => dispatch.dispatchId === claimedDispatchId);
    if (requeued?.status !== "queued" || requeued.assignedNodeId || node.status !== "revoked") {
      output.push("Agent node revocation ACK did not requeue its fenced dispatch and revoke the node");
    }
    const shutdownIssued = createAgentJoinToken(state, {projectId: "prj_control_plane", nodeName: "contract-shutdown-node", allowedRoles: ["*"]}, {publicUrl: "https://control.example.test"});
    registerAgentNode(state, {nodeName: "contract-shutdown-node", requestedRoles: ["*"], runtimeVersion: "contract", profile: {platform: "test", arch: "test", tools: [], models: [{providerClass: "custom", available: true}]}}, {joinToken: shutdownIssued.joinToken, publicUrl: "https://control.example.test"});
    const shutdownNode = state.agentRuntimeNodes.find((item) => item.nodeName === "contract-shutdown-node");
    selfCheckAgentNode(state, shutdownNode, {checks: [
      {checkId: "runtime", status: "ok"},
      {checkId: "gateway", status: "ok"},
      {checkId: "filesystem", status: "ok"},
      {checkId: "git", status: "ok"},
      {checkId: "remote_mcp", status: "ok"},
      {checkId: "model_executor", status: "ok"}
    ]});
    const shutdownClaim = claimNextDispatch(state, shutdownNode, {runtimeDir: join(root, ".runtime"), claimTtlSeconds: 300});
	    if (shutdownClaim.dispatch) {
	      const shutdownDispatchId = shutdownClaim.dispatch.dispatch.dispatchId;
	      const shutdownCommand = createAgentControlCommand(state, shutdownNode, {commandType: "shutdown"}, {actor: "contract-check", idempotencyKey: "contract-node-shutdown"}).command;
        const preAckShutdownDispatch = state.agentDispatches.find((dispatch) => dispatch.dispatchId === shutdownDispatchId);
        if (preAckShutdownDispatch?.status !== "blocked" || shutdownNode.status !== "draining" || state.mcpGrants.some((grant) => grant.agentNodeId === shutdownNode.nodeId && grant.dispatchId === shutdownDispatchId && grant.grantStatus === "issued")) {
          output.push("Agent shutdown command did not freeze dispatch and revoke MCP grants before runtime ACK");
        }
	      ackAgentControlCommand(state, shutdownNode, shutdownCommand.commandId, {status: "completed", result: {stopped: true}});
      const shutdownDispatch = state.agentDispatches.find((dispatch) => dispatch.dispatchId === shutdownDispatchId);
      if (shutdownNode.status !== "offline" || shutdownNode.admission !== "read_only" || shutdownDispatch?.status !== "queued" || shutdownDispatch.assignedNodeId) {
        output.push("Agent shutdown ACK did not offline the node and requeue active dispatches");
      }
    } else {
      output.push(`Agent shutdown contract could not claim a dispatch: ${shutdownClaim.reason || "unknown"}`);
    }
  }
}

console.log("contract check ok");

function loadJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function validateSchema(value, schema, path, output) {
  if (!schema || typeof schema !== "object") return;
  if (schema.$ref === "language-policy.schema.json") return validateSchema(value, languagePolicySchema, path, output);
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

function safeProjectIdForContract(projectId) {
  return `p_${createHash("sha256").update(String(projectId || "unknown")).digest("hex").slice(0, 24)}`;
}
