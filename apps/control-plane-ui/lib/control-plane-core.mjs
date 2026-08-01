import { execFileSync } from "node:child_process";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { assertTransition, canonicalTransition, requiresValuesToEvidenceRefs } from "./transition-engine.mjs";

const controlPlaneRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
const specDigestCache = new Map();

export function specContentDigest(specRelativePath) {
  if (specDigestCache.has(specRelativePath)) return specDigestCache.get(specRelativePath);
  let digest;
  try {
    digest = digestOf(readFileSync(join(controlPlaneRoot, specRelativePath), "utf8"));
  } catch {
    digest = digestOf(specRelativePath);
  }
  specDigestCache.set(specRelativePath, digest);
  return digest;
}

export const providerClasses = [
  "openai",
  "anthropic",
  "google",
  "xai",
  "meta",
  "mistral",
  "deepseek",
  "qwen",
  "moonshot",
  "zhipu",
  "baidu",
  "tencent",
  "openrouter",
  "azure_openai",
  "aws_bedrock",
  "vertex_ai",
  "ollama",
  "vllm",
  "custom"
];

const embeddedServices = [
  ["control-plane", "ui-console-service"],
  ["room-broker", "room-broker"],
  ["scheduler", "scheduler"],
  ["agent-gateway", "agent-runtime"],
  ["identity-service", "identity-service"],
  ["ui-console-service", "ui-console-service"],
  ["repository-router", "repository-router"],
  ["instruction-optimizer", "instruction-optimizer"],
  ["policy-engine", "policy-engine"],
  ["command-bus", "command-bus"],
  ["permission-gateway", "permission-gateway"],
  ["mcp-proxy", "mcp-proxy"],
  ["model-registry", "model-registry"],
  ["skill-registry", "skill-registry"],
  ["monitor", "monitor"]
];

const agentJoinCommand = "create one-time join token in project UI, then run the generated curl installer command on the Agent host";

const embeddedMcpLogicalServers = [
  "agent-control-mcp",
  "definition-mcp",
  "evidence-mcp",
  "governance-mcp",
  "human-review-mcp",
  "identity-mcp",
  "instruction-mcp",
  "model-mcp",
  "orchestration-mcp",
  "permission-mcp",
  "repository-mcp",
  "resource-mcp",
  "review-mcp",
  "room-mcp",
  "scheduler-mcp",
  "skill-mcp",
  "ui-console-mcp"
];

const embeddedMcpToolCount = 81;

const modelProviderAdapters = providerClasses.map((providerClass) => ({
  providerClass,
  adapterId: `adapter:${providerClass}`,
  credentialEnvNames: credentialEnvNames(providerClass),
  invocationMode: ["ollama", "vllm", "custom"].includes(providerClass) ? "local_or_http_endpoint" : "provider_api",
  status: "configured"
}));

const roleCapabilityHints = {
  orchestrator: {
    category: "control",
    skillRef: "engineering-multi-agent-systems-architect",
    capabilities: ["planning", "architecture", "deep_reasoning", "long_context", "tool_use", "review"],
    strengths: ["planning", "architecture", "deep_reasoning", "long_context"]
  },
  scheduler: {
    category: "control",
    skillRef: "project-management-project-shepherd",
    capabilities: ["planning", "fast_execution", "cost_aware", "quota_aware", "tool_use"],
    strengths: ["planning", "fast_execution"]
  },
  reviewer: {
    category: "review",
    skillRef: "engineering-code-reviewer",
    capabilities: ["review", "coding", "security", "qa", "deep_reasoning"],
    strengths: ["review", "coding", "security"]
  },
  qa: {
    category: "quality",
    skillRef: "testing-qa-engineer",
    capabilities: ["qa", "review", "coding", "data_analysis"],
    strengths: ["qa", "review"]
  },
  security: {
    category: "security",
    skillRef: "security-architect",
    capabilities: ["security", "review", "deep_reasoning", "tool_use"],
    strengths: ["security", "review", "deep_reasoning"]
  },
  release: {
    category: "release",
    skillRef: "engineering-devops-automator",
    capabilities: ["coding", "qa", "planning", "tool_use", "fast_execution"],
    strengths: ["coding", "qa", "planning"]
  },
  monitor: {
    category: "monitor",
    skillRef: "engineering-sre",
    capabilities: ["qa", "data_analysis", "fast_execution", "tool_use"],
    strengths: ["qa", "data_analysis", "fast_execution"]
  },
  "agent-runtime": {
    category: "runtime",
    skillRef: "engineering-backend-architect",
    capabilities: ["coding", "architecture", "tool_use", "qa"],
    strengths: ["coding", "architecture"]
  },
  "ui-console-service": {
    category: "ui",
    skillRef: "engineering-frontend-developer",
    capabilities: ["coding", "creative", "qa", "tool_use"],
    strengths: ["coding", "creative"]
  },
  "policy-engine": {
    category: "policy",
    skillRef: "security-compliance-auditor",
    capabilities: ["security", "review", "deep_reasoning", "planning"],
    strengths: ["security", "review"]
  },
  "model-registry": {
    category: "runtime",
    skillRef: "engineering-ai-engineer",
    capabilities: ["data_analysis", "planning", "deep_reasoning", "tool_use"],
    strengths: ["data_analysis", "planning"]
  },
  "skill-registry": {
    category: "runtime",
    skillRef: "specialized-prompt-engineer",
    capabilities: ["writing", "planning", "review", "translation"],
    strengths: ["writing", "planning"]
  }
};

const providerDefaults = {
  openai: {modalities: ["text", "vision", "tool_use"], strengths: ["deep_reasoning", "coding", "architecture", "review", "security", "qa", "planning", "long_context"], context: 128000, output: 16000, quality: [0.96, 0.95, 0.94, "normal", 0.95], cost: ["high", "normal"]},
  anthropic: {modalities: ["text", "vision", "tool_use"], strengths: ["deep_reasoning", "coding", "architecture", "review", "writing", "long_context"], context: 200000, output: 16000, quality: [0.94, 0.92, 0.94, "normal", 0.94], cost: ["high", "normal"]},
  google: {modalities: ["text", "vision", "audio", "video", "tool_use"], strengths: ["deep_reasoning", "coding", "math", "data_analysis", "multimodal", "long_context"], context: 1000000, output: 16000, quality: [0.92, 0.9, 0.9, "normal", 0.92], cost: ["normal", "high"]},
  xai: {modalities: ["text", "vision", "tool_use"], strengths: ["deep_reasoning", "fast_execution", "coding", "writing"], context: 128000, output: 12000, quality: [0.89, 0.86, 0.84, "low", 0.88], cost: ["normal", "normal"]},
  meta: {modalities: ["text", "tool_use"], strengths: ["coding", "fast_execution", "low_cost", "local_private"], context: 128000, output: 8000, quality: [0.84, 0.85, 0.8, "low", 0.84], cost: ["low", "high"]},
  mistral: {modalities: ["text", "tool_use"], strengths: ["coding", "fast_execution", "low_cost", "multimodal"], context: 128000, output: 8000, quality: [0.86, 0.86, 0.82, "low", 0.86], cost: ["low", "high"]},
  deepseek: {modalities: ["text", "tool_use"], strengths: ["deep_reasoning", "coding", "math", "low_cost"], context: 128000, output: 8000, quality: [0.91, 0.92, 0.85, "normal", 0.86], cost: ["low", "normal"]},
  qwen: {modalities: ["text", "vision", "tool_use"], strengths: ["coding", "math", "translation", "low_cost", "long_context"], context: 128000, output: 8000, quality: [0.88, 0.89, 0.84, "low", 0.87], cost: ["low", "high"]},
  moonshot: {modalities: ["text", "vision", "tool_use"], strengths: ["long_context", "writing", "translation", "deep_reasoning"], context: 1000000, output: 8000, quality: [0.88, 0.84, 0.84, "normal", 0.87], cost: ["normal", "normal"]},
  zhipu: {modalities: ["text", "vision", "tool_use"], strengths: ["translation", "writing", "low_cost", "multimodal"], context: 128000, output: 8000, quality: [0.84, 0.82, 0.8, "low", 0.84], cost: ["low", "normal"]},
  baidu: {modalities: ["text", "vision", "tool_use"], strengths: ["translation", "writing", "data_analysis", "multimodal"], context: 128000, output: 8000, quality: [0.83, 0.8, 0.8, "normal", 0.84], cost: ["normal", "normal"]},
  tencent: {modalities: ["text", "vision", "tool_use"], strengths: ["writing", "translation", "data_analysis", "low_cost"], context: 128000, output: 8000, quality: [0.82, 0.8, 0.8, "normal", 0.83], cost: ["normal", "normal"]},
  openrouter: {modalities: ["text", "vision", "tool_use"], strengths: ["planning", "coding", "low_cost", "fast_execution"], context: 128000, output: 12000, quality: [0.86, 0.86, 0.84, "low", 0.82], cost: ["low", "high"]},
  azure_openai: {modalities: ["text", "vision", "tool_use"], strengths: ["deep_reasoning", "coding", "architecture", "review", "security", "planning", "long_context"], context: 128000, output: 16000, quality: [0.95, 0.94, 0.94, "normal", 0.95], cost: ["high", "normal"]},
  aws_bedrock: {modalities: ["text", "vision", "tool_use"], strengths: ["architecture", "security", "writing", "planning"], context: 200000, output: 12000, quality: [0.9, 0.87, 0.9, "normal", 0.92], cost: ["normal", "normal"]},
  vertex_ai: {modalities: ["text", "vision", "audio", "video", "tool_use"], strengths: ["data_analysis", "multimodal", "long_context", "planning"], context: 1000000, output: 16000, quality: [0.91, 0.88, 0.89, "normal", 0.92], cost: ["normal", "normal"]},
  ollama: {modalities: ["text", "tool_use"], strengths: ["local_private", "low_cost", "fast_execution", "coding"], context: 64000, output: 8000, quality: [0.76, 0.78, 0.74, "low", 0.78], cost: ["low", "high"]},
  vllm: {modalities: ["text", "tool_use"], strengths: ["local_private", "low_cost", "fast_execution", "coding"], context: 128000, output: 8000, quality: [0.78, 0.8, 0.75, "low", 0.8], cost: ["low", "high"]},
  custom: {modalities: ["text", "tool_use"], strengths: ["planning", "coding", "review"], context: 128000, output: 8000, quality: [0.75, 0.75, 0.75, "unknown", 0.75], cost: ["unknown", "unknown"]}
};

const providerDefaultModelIds = {
  openai: "openai:gpt-5.5",
  anthropic: "anthropic:claude-sonnet-4-5",
  google: "google:gemini-2.5-pro",
  xai: "xai:grok-4",
  meta: "meta:llama-4-maverick",
  mistral: "mistral:mistral-large-latest",
  deepseek: "deepseek:deepseek-chat",
  qwen: "qwen:qwen-max-latest",
  moonshot: "moonshot:kimi-k2",
  zhipu: "zhipu:glm-4.5",
  baidu: "baidu:ernie-4.5",
  tencent: "tencent:hunyuan-turbos-latest",
  openrouter: "openrouter:openai/gpt-5.5",
  azure_openai: "azure_openai:gpt-5.5",
  aws_bedrock: "aws_bedrock:anthropic.claude-sonnet-4-5",
  vertex_ai: "vertex_ai:gemini-2.5-pro",
  ollama: "ollama:llama3.1",
  vllm: "vllm:Qwen/Qwen2.5-Coder-32B-Instruct",
  custom: "custom:custom-model"
};

const defaultModelCeiling = {
  maxModelTier: "frontier_standard",
  maxReasoningLevel: "high",
  escalationPolicy: "special_signal_required"
};

export const projectOwnerGrantPermissions = Object.freeze([
  "project:view",
  "project:update",
  "project:grant",
  "member:invite",
  "agent:activate",
  "task_group:read",
  "task_group:control"
]);

const reasoningRank = {low: 0, standard: 1, medium: 2, high: 3, max: 4, ultra: 5};
const modelTierRank = {standard: 0, frontier_economy: 1, frontier_standard: 2, frontier_plus: 3};

// Gap #3: terminal state sets for the Command / CommandEffect / DLQEntry state machines
// (spec/state-machines.yaml). The close-barrier and completion-readiness gates use these
// to decide whether a command bus object is still "in flight" and must block a close.
export const COMMAND_TERMINAL_STATES = Object.freeze(["succeeded", "cancelled", "timed_out", "compensated", "dlq"]);
export const COMMAND_EFFECT_TERMINAL_STATES = Object.freeze(["verified", "rolled_back", "abandoned"]);
export const DLQ_ENTRY_TERMINAL_STATES = Object.freeze(["replayed", "discarded", "superseded"]);
const COMMAND_TERMINAL = new Set(COMMAND_TERMINAL_STATES);
const COMMAND_EFFECT_TERMINAL = new Set(COMMAND_EFFECT_TERMINAL_STATES);
const DLQ_ENTRY_TERMINAL = new Set(DLQ_ENTRY_TERMINAL_STATES);

const defaultLanguagePolicy = Object.freeze({
  schemaVersion: "language-policy/v1",
  languageTag: "zh-CN",
  languageName: "Chinese",
  script: "Hans",
  scope: [
    "role_interaction",
    "dispatch_instruction",
    "room_message",
    "execution_event",
    "checkpoint",
    "repository_output",
    "review_material"
  ],
  enforcement: "required",
  fallback: "return_blocked_for_language_mismatch"
});

const languageAliases = new Map([
  ["中文", {languageTag: "zh-CN", languageName: "Chinese", script: "Hans"}],
  ["汉语", {languageTag: "zh-CN", languageName: "Chinese", script: "Hans"}],
  ["简体中文", {languageTag: "zh-CN", languageName: "Chinese", script: "Hans"}],
  ["zh", {languageTag: "zh-CN", languageName: "Chinese", script: "Hans"}],
  ["zh-cn", {languageTag: "zh-CN", languageName: "Chinese", script: "Hans"}],
  ["chinese", {languageTag: "zh-CN", languageName: "Chinese", script: "Hans"}],
  ["english", {languageTag: "en", languageName: "English"}],
  ["英语", {languageTag: "en", languageName: "English"}],
  ["en", {languageTag: "en", languageName: "English"}],
  ["en-us", {languageTag: "en-US", languageName: "English"}],
  ["french", {languageTag: "fr", languageName: "French"}],
  ["法语", {languageTag: "fr", languageName: "French"}],
  ["fr", {languageTag: "fr", languageName: "French"}],
  ["fr-fr", {languageTag: "fr-FR", languageName: "French"}],
  ["ja", {languageTag: "ja", languageName: "Japanese"}],
  ["japanese", {languageTag: "ja", languageName: "Japanese"}],
  ["de", {languageTag: "de", languageName: "German"}],
  ["german", {languageTag: "de", languageName: "German"}],
  ["es", {languageTag: "es", languageName: "Spanish"}],
  ["spanish", {languageTag: "es", languageName: "Spanish"}]
]);

const defaultSkillSource = {
  schemaVersion: "agent-skill-source/v1",
  sourceId: "agency-agents-zh",
  repositoryUrl: "https://github.com/DlenoDing/agency-agents-zh.git",
  defaultRef: "main",
  pinnedCommit: "1d2345927e4a70c426472c37771e31f9333d7e0a",
  status: "configured",
  stateVersion: 1,
  catalogFiles: ["AGENT-LIST.md", "CATALOG.md"],
  roleFileGlobs: [
    "academic/**/*.md",
    "design/**/*.md",
    "engineering/**/*.md",
    "finance/**/*.md",
    "game-development/**/*.md",
    "gis/**/*.md",
    "hr/**/*.md",
    "integrations/**/*.md",
    "legal/**/*.md",
    "marketing/**/*.md",
    "paid-media/**/*.md",
    "product/**/*.md",
    "project-management/**/*.md",
    "sales/**/*.md",
    "security/**/*.md",
    "spatial-computing/**/*.md",
    "specialized/**/*.md",
    "strategy/**/*.md",
    "supply-chain/**/*.md",
    "support/**/*.md",
    "testing/**/*.md",
    "writing/**/*.md"
  ],
  catalogDigest: digestOf("agency-agents-zh:configured"),
  roleSkillIndexRef: "runtime://skill-sources/agency-agents-zh/index.json",
  digestIndexRef: "runtime://skill-sources/agency-agents-zh/digest-index.json",
  digestIndexVerified: false,
  trustPolicy: {
    requirePinnedCommit: true,
    requireFrontmatter: true,
    requireDigestIndex: true,
    allowUnsignedContent: false
  },
  syncPolicy: {
    mode: "pinned_snapshot",
    refreshTrigger: "orchestrator_need",
    onUpstreamChange: "create_system_upgrade_candidate"
  },
  overlayPolicy: {
    defaultPrecedence: ["task_group_overlay", "project_overlay", "upstream_default"],
    allowedScopes: ["project", "task_group"],
    requiresDecisionRecord: true,
    requiresDigest: true
  }
};

export function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function digestOf(value) {
  const input = typeof value === "string" ? value : stableJson(value);
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function normalizeTaskGroupLanguagePolicy(input = {}, fallback = {}) {
  const rawPolicy = input?.languagePolicy && typeof input.languagePolicy === "object" ? input.languagePolicy : input;
  const fallbackPolicy = fallback?.languagePolicy && typeof fallback.languagePolicy === "object" ? fallback.languagePolicy : fallback;
  const rawLanguage = String(
    rawPolicy.languageTag ||
    rawPolicy.language ||
    rawPolicy.outputLanguage ||
    rawPolicy.interactionLanguage ||
    fallbackPolicy.languageTag ||
    defaultLanguagePolicy.languageTag
  ).trim();
  const preset = resolveLanguagePreset(rawLanguage);
  const scope = unique([
    ...(Array.isArray(rawPolicy.scope) ? rawPolicy.scope : []),
    ...(Array.isArray(rawPolicy.appliesTo) ? rawPolicy.appliesTo : []),
    ...(!rawPolicy.scope && !rawPolicy.appliesTo && Array.isArray(fallbackPolicy.scope) ? fallbackPolicy.scope : []),
    ...(!rawPolicy.scope && !rawPolicy.appliesTo && !fallbackPolicy.scope ? defaultLanguagePolicy.scope : [])
  ]);
  return {
    schemaVersion: "language-policy/v1",
    languageTag: preset.languageTag,
    languageName: String(rawPolicy.languageName || preset.languageName || preset.languageTag),
    ...(rawPolicy.script || preset.script ? {script: String(rawPolicy.script || preset.script)} : {}),
    scope: scope.length ? scope : [...defaultLanguagePolicy.scope],
    enforcement: ["advisory", "required"].includes(rawPolicy.enforcement)
      ? rawPolicy.enforcement
      : fallbackPolicy.enforcement === "advisory" ? "advisory" : "required",
    fallback: normalizeLanguageFallback(rawPolicy.fallback, fallbackPolicy.fallback)
  };
}

export function languagePolicyDirective(policy = defaultLanguagePolicy) {
  const normalized = normalizeTaskGroupLanguagePolicy(policy);
  return `LanguagePolicy ${normalized.languageTag}/${normalized.languageName}: all role interaction, dispatch instructions, room messages, execution events, checkpoints, repository outputs and review materials MUST use this language; return blocked if unable.`;
}

function resolveLanguagePreset(rawLanguage) {
  const key = String(rawLanguage || "").trim().toLowerCase();
  const alias = languageAliases.get(key);
  if (alias) return alias;
  if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(rawLanguage)) {
    return {languageTag: canonicalLanguageTag(rawLanguage), languageName: canonicalLanguageTag(rawLanguage)};
  }
  return {...defaultLanguagePolicy};
}

function normalizeLanguageFallback(primary, fallback) {
  const allowed = new Set(["return_blocked_for_language_mismatch", "translate_or_return_blocked"]);
  if (allowed.has(primary)) return primary;
  if (allowed.has(fallback)) return fallback;
  return defaultLanguagePolicy.fallback;
}

function canonicalLanguageTag(value) {
  const parts = String(value || "").trim().split("-").filter(Boolean);
  return parts.map((part, index) => index === 0 ? part.toLowerCase() : part.toUpperCase()).join("-");
}

function ensureTaskGroupLanguagePolicies(state) {
  for (const taskGroup of state.taskGroups || []) {
    taskGroup.languagePolicy = normalizeTaskGroupLanguagePolicy(taskGroup.languagePolicy || taskGroup);
  }
}

export function ensureRuntimeCollections(state, options = {}) {
  if (state.__runtimeEnsured) return state;
  state.stateVersion ||= 1;
  state.idempotencyRecords ||= {};
  state.policyDecisions ||= [];
  state.commands ||= [];
  state.decisionRecords ||= [];
  state.eventLog ||= [];
  state.transitionEvidence ||= [];
  state.authSessions ||= [];
  state.managementSurfaces ||= defaultManagementSurfaces();
  state.skillSources ||= [clone(defaultSkillSource)];
  state.roleSkills ||= defaultRoleSkills();
  state.roleSkillOverlays ||= [];
  state.modelProviders ||= clone(modelProviderAdapters);
  state.modelCapabilities ||= defaultModelCapabilities();
  state.modelSelectionPolicies ||= defaultModelSelectionPolicies();
  state.modelSelectionDecisions ||= [];
  state.sessionPlacementDecisions ||= [];
  state.workerLanes ||= [];
  state.workSessions ||= [];
  state.agentDispatches ||= [];
  state.agentTaskContracts ||= [];
  state.effectiveInstructionPackets ||= [];
  state.roleDriftGuards ||= [];
  state.executionTopologies ||= [];
  state.reviewPlans ||= [];
  state.reviewBundles ||= [];
  state.completionReadiness ||= [];
  state.closeBarriers ||= [];
  state.admissionDecisions ||= [];
  state.admissionScans ||= [];
  state.runtimeIssuePatterns ||= [];
  state.systemUpgradeCandidates ||= [];
  state.runtimeIssueSamples ||= [];
  state.checkpoints ||= [];
  state.leases ||= [];
  state.roomParticipants ||= [];
  state.roomMessages ||= [];
  state.roomSequenceByRoom ||= {};
  state.roomAcks ||= [];
  state.agentRuntimeNodes ||= [];
  state.mcpProbeNodes ||= [];
  state.agentJoinTokens ||= [];
  state.agentGatewayEvents ||= [];
  state.organizations ||= [];
  state.humanConfirmationRequests ||= [];
  state.humanDirectives ||= [];
  state.agentControlCommands ||= [];
  state.agentControlSequence ||= 0;
  state.agentExecutionEvents ||= [];
  state.agentExecutionSequence ||= 0;
  state.permissionRequests ||= [];
  state.approvalRequests ||= [];
  state.artifacts ||= [];
  state.testResults ||= [];
  state.ruleSourceResolutions ||= [];
  state.mcpGrants ||= [];
  state.mcpCalls ||= [];
  state.leaseSequence ||= 0;
  state.externalUpgradeImports ||= [];
  state.findings ||= [];
  state.qualityGates ||= [];
  state.commandEffects ||= [];
  state.dlqEntries ||= [];
  state.integrationBatches ||= [];
  state.progressSnapshots ||= [];
  state.repositoryOutputs ||= [];
  state.sharedDefinitions ||= [];
  state.accessGrants ||= [];
  normalizeProjectOwnerAccessGrants(state);
  state.taskGroups ||= [];
  ensureTaskGroupLanguagePolicies(state);
  state.instructionMetrics ||= {tokenBudgetPolicy: "delta_locators_digest_first", cacheHitTarget: 0.7, stablePrefixTokens: 1800, deltaMessageTargetTokens: 420, envelopes: []};
  state.instructionMetrics.envelopes ||= [];
  state.auditLog ||= [];
  state.runtime ||= {};
  state.runtime.executionProfile ||= options.executionProfile || process.env.AIMAC_EXECUTION_PROFILE || "production";
	  state.runtime.commands ||= {};
	  state.runtime.commands.mcpStart ||= "npm start";
	  delete state.runtime.commands.mcpRegister;
	  state.runtime.commands.agentJoin ||= agentJoinCommand;
	  state.runtime.commands.mcpDoctor ||= "npm run mcp:doctor";
  state.runtime.mcp = {
    ...(state.runtime.mcp || {}),
    protocol: "mcp/streamable-http",
    serverId: "ai-multi-agent-ctrl",
    logicalServers: embeddedMcpLogicalServers,
    toolCount: embeddedMcpToolCount,
	    endpointPath: "/mcp",
	    hostedBy: "control-plane",
	    startupCommand: "npm start",
	    registrationCommand: agentJoinCommand,
    doctorCommand: "npm run mcp:doctor",
    agentLocalServerAllowed: false
  };
  ensureServices(state, options.endpoint);
  ensureDefaultServiceAccounts(state);
  ensureDefaultAccessGrants(state);
  ensureDefaultAgents(state);
  ensureOrganizations(state);
  if (!Array.isArray(state.progressSnapshots) || !state.progressSnapshots.length) computeProgressSnapshots(state);
  Object.defineProperty(state, "__runtimeEnsured", {value: true, enumerable: false, configurable: true});
  return state;
}

export const DEFAULT_ORGANIZATION_ID = "org_default";

const defaultOrganizationQuotas = {
  maxMembers: Number(process.env.AIMAC_ORG_DEFAULT_MAX_MEMBERS || 50),
  maxProjects: Number(process.env.AIMAC_ORG_DEFAULT_MAX_PROJECTS || 20),
  maxTaskGroups: Number(process.env.AIMAC_ORG_DEFAULT_MAX_TASK_GROUPS || 200),
  maxAgents: Number(process.env.AIMAC_ORG_DEFAULT_MAX_AGENTS || 100)
};

function ensureOrganizations(state) {
  if (state.orgMigrationVersion === 1 && state.organizations.length) return;
  if (!state.organizations.some((org) => org.orgId === DEFAULT_ORGANIZATION_ID)) {
    const at = new Date().toISOString();
    state.organizations.push({
      schemaVersion: "organization/v1",
      orgId: DEFAULT_ORGANIZATION_ID,
      name: "默认组织",
      status: "active",
      quotas: {...defaultOrganizationQuotas},
      usage: {members: 0, projects: 0, taskGroups: 0, agents: 0},
      initialAdminAccountId: "acct_workspace_owner",
      createdBy: "system",
      createdAt: at,
      updatedAt: at
    });
  }
  for (const account of state.accounts || []) {
    if (["system_admin", "service_account"].includes(account.accountType)) continue;
    account.organizationId ||= DEFAULT_ORGANIZATION_ID;
  }
  for (const project of state.projects || []) project.organizationId ||= DEFAULT_ORGANIZATION_ID;
  for (const agent of state.agents || []) agent.organizationId ||= DEFAULT_ORGANIZATION_ID;
  for (const node of state.agentRuntimeNodes || []) node.organizationId ||= DEFAULT_ORGANIZATION_ID;
  for (const token of state.agentJoinTokens || []) token.organizationId ||= DEFAULT_ORGANIZATION_ID;
  recomputeOrganizationUsage(state);
  state.orgMigrationVersion = 1;
}

export function recomputeOrganizationUsage(state) {
  const projectOrg = new Map((state.projects || []).map((project) => [project.id, project.organizationId || DEFAULT_ORGANIZATION_ID]));
  for (const org of state.organizations || []) {
    org.usage = {
      members: (state.accounts || []).filter((account) => account.organizationId === org.orgId && account.status !== "disabled").length,
      projects: (state.projects || []).filter((project) => (project.organizationId || DEFAULT_ORGANIZATION_ID) === org.orgId && project.status !== "deleted").length,
      taskGroups: (state.taskGroups || []).filter((taskGroup) => projectOrg.get(taskGroup.projectId) === org.orgId && !["closed", "aborted"].includes(taskGroup.status)).length,
      agents: (state.agentRuntimeNodes || []).filter((node) => (node.organizationId || DEFAULT_ORGANIZATION_ID) === org.orgId && node.status !== "revoked").length
    };
  }
}

export function organizationOf(state, orgId) {
  return (state.organizations || []).find((org) => org.orgId === orgId) || null;
}

export function organizationQuotaCheck(state, orgId, kind) {
  const org = organizationOf(state, orgId);
  if (!org) return {allowed: false, error: "organization_not_found"};
  if (org.status !== "active") return {allowed: false, error: "organization_suspended"};
  recomputeOrganizationUsage(state);
  const quotaKeyByKind = {members: "maxMembers", projects: "maxProjects", taskGroups: "maxTaskGroups", agents: "maxAgents"};
  const quota = Number(org.quotas?.[quotaKeyByKind[kind]] || 0);
  const usage = Number(org.usage?.[kind] || 0);
  if (usage >= quota) return {allowed: false, error: "org_quota_exceeded", quota, usage, kind};
  return {allowed: true, quota, usage, kind};
}

function normalizeProjectOwnerAccessGrants(state) {
  for (const grant of state.accessGrants || []) {
    if (grant.role !== "project_owner" || grant.resource?.resourceType !== "project") continue;
    grant.permissions = [...projectOwnerGrantPermissions];
  }
}

function ensureServices(state, endpoint) {
  const existing = new Map((state.runtime?.services || []).map((service) => [service.serviceId, service]));
  state.runtime ||= {};
  state.runtime.services = embeddedServices.map(([serviceId, roleId]) => ({
    serviceId,
    roleId,
    status: existing.get(serviceId)?.status || "running",
    health: existing.get(serviceId)?.health || "ok",
    ...(serviceId === "control-plane" || serviceId === "ui-console-service" || serviceId === "agent-gateway" || serviceId === "mcp-proxy" || serviceId === "skill-registry" ? {endpoint: endpoint || existing.get(serviceId)?.endpoint || "http://127.0.0.1:4317"} : {})
  }));
}

function ensureDefaultAgents(state) {
  state.agents ||= [];
  const defaults = [
    ["agent_orchestrator", "Orchestrator Runtime", "orchestrator", "auto_best"],
    ["agent_scheduler", "Scheduler Agent", "scheduler", "auto_fast"],
    ["agent_reviewer", "Independent Reviewer", "reviewer", "auto_best"],
    ["agent_qa", "QA Runtime", "qa", "cost_aware"],
    ["agent_security", "Security Reviewer", "security", "auto_best"],
    ["agent_release", "Release Runtime", "release", "auto_fast"],
    ["agent_monitor", "Monitor Agent", "monitor", "auto_fast"]
  ];
  for (const [id, name, role, model] of defaults) {
    if (state.agents.some((agent) => agent.id === id)) continue;
    state.agents.push({id, name, role, model, status: "active", trustScore: 0.9, capacity: "ready"});
  }
}

function ensureDefaultServiceAccounts(state) {
  state.accounts ||= [];
  if (!state.accounts.some((account) => account.accountId === "acct_agent_runtime")) {
    const at = new Date().toISOString();
    state.accounts.push({
      schemaVersion: "account/v1",
      accountId: "acct_agent_runtime",
      accountType: "service_account",
      displayName: "Agent Runtime Service",
      email: "agent.runtime@local",
      status: "active",
      roles: ["service_agent_runtime"],
      permissions: [],
      authPolicy: {method: "service_token", mfaRequired: false, passwordSet: false, sessionTtlSeconds: 3600},
      auditRef: "audit_seed_agent_runtime",
      createdAt: at,
      updatedAt: at
    });
  }
}

function ensureDefaultAccessGrants(state) {
  state.accessGrants ||= [];
  const taskGroup = (state.taskGroups || []).find((item) => item.id === "tg_runtime_management") || (state.taskGroups || [])[0];
  if (!taskGroup || state.accessGrants.some((grant) => grant.grantId === "grant_agent_runtime_task_group")) return;
  const at = new Date().toISOString();
  state.accessGrants.push({
    schemaVersion: "access-control-grant/v1",
    grantId: "grant_agent_runtime_task_group",
    subjectRef: {subjectType: "account", subjectId: "acct_agent_runtime"},
    resource: {resourceType: "task_group", resourceId: taskGroup.id},
    role: "agent_operator",
    permissions: ["task_group:orchestrate", "task_group:checkpoint_submit", "task_group:read", "task_group:monitor"],
    status: "active",
    policyDecisionRef: "pd_seed_agent_runtime_task_group",
    auditRef: "audit_seed_grant_agent_runtime_task_group",
    createdAt: at,
    updatedAt: at
  });
}

export function updateTaskGroupLanguagePolicy(state, taskGroupId, input = {}, options = {}) {
  ensureRuntimeCollections(state);
  const taskGroup = (state.taskGroups || []).find((item) => item.id === taskGroupId);
  if (!taskGroup) {
    const error = new Error("task_group_not_found");
    error.status = 404;
    throw error;
  }
  const at = new Date().toISOString();
  const previousDigest = digestOf(taskGroup.languagePolicy || {});
  taskGroup.languagePolicy = normalizeTaskGroupLanguagePolicy(input.languagePolicy || input, taskGroup.languagePolicy);
  taskGroup.updatedAt = at;
  const languagePolicyDigest = digestOf(taskGroup.languagePolicy);
  appendEvent(state, "task_group_language_policy_updated", "TaskGroup", taskGroup.id, options.actor || "ui-console-service", {
    projectId: taskGroup.projectId,
    taskGroupId: taskGroup.id,
    previousDigest,
    languagePolicyDigest,
    languageTag: taskGroup.languagePolicy.languageTag
  });
  return {taskGroup, languagePolicy: taskGroup.languagePolicy, languagePolicyDigest};
}

function defaultManagementSurfaces() {
  const at = new Date().toISOString();
  return [
    {
      schemaVersion: "management-console-surface/v1",
      surfaceId: "surface_system_management",
      consoleType: "system_management",
      status: "active",
      route: "/#system",
      views: ["runtime", "accounts", "audit", "policies", "instructions"],
      guardedActions: [
        {actionId: "runtime_reinitialize", riskClass: "high", requiredPermission: "system:bootstrap", decisionRequired: true},
        {actionId: "skill_source_sync", riskClass: "medium", requiredPermission: "system:skill_sync", decisionRequired: true},
        {actionId: "model_capability_register", riskClass: "medium", requiredPermission: "system:model_registry", decisionRequired: true}
      ],
      visualQualityGates: ["responsive_layout", "text_no_overlap", "action_state_visible", "progress_visible", "audit_trace_visible"],
      auditRef: "audit_seed_surface_system",
      createdAt: at,
      updatedAt: at
    },
    {
      schemaVersion: "management-console-surface/v1",
      surfaceId: "surface_user_management",
      consoleType: "user_management",
      status: "active",
      route: "/#projects",
      views: ["projects", "task_groups", "agents", "permissions", "progress", "instructions"],
      guardedActions: [
        {actionId: "project_create", riskClass: "medium", requiredPermission: "project:create", decisionRequired: true},
        {actionId: "task_group_control", riskClass: "medium", requiredPermission: "task_group:control", decisionRequired: true},
        {actionId: "activate_agent", riskClass: "medium", requiredPermission: "agent:activate", decisionRequired: true}
      ],
      visualQualityGates: ["responsive_layout", "text_no_overlap", "action_state_visible", "progress_visible", "audit_trace_visible"],
      auditRef: "audit_seed_surface_user",
      createdAt: at,
      updatedAt: at
    }
  ];
}

function defaultRoleSkills() {
  return Object.entries(roleCapabilityHints).map(([roleId, hint]) => ({
    schemaVersion: "agent-role-skill/v1",
    sourceId: "system-default",
    roleSkillId: `system-${roleId}`,
    sourcePath: `runtime://system-role-skills/${roleId}`,
    name: `${roleId} system role skill`,
    description: `Built-in role skill for ${roleId} until agency-agents-zh is synced.`,
    category: hint.category,
    frontmatterDigest: digestOf({roleId, type: "frontmatter"}),
    contentDigest: digestOf({roleId, capabilities: hint.capabilities}),
    capabilities: hint.capabilities,
    defaultModelRequirements: {
      strengths: hint.strengths,
      minContextWindowTokens: roleId === "orchestrator" ? 128000 : 32000,
      requiresToolUse: true,
      riskLevel: ["orchestrator", "security", "policy-engine"].includes(roleId) ? "L2" : "L1"
    },
    overlayRefs: [],
    status: "active",
    stateVersion: 1,
    auditRef: `audit_seed_skill_${roleId}`
  }));
}

export function defaultModelCapabilities(observedAt = new Date().toISOString()) {
  return providerClasses.map((providerClass) => {
    const spec = providerDefaults[providerClass];
    const [reasoningScore, codingScore, reviewScore, latencyClass, reliabilityScore] = spec.quality;
    const [costClass, quotaClass] = spec.cost;
    return {
	      schemaVersion: "model-capability/v1",
	      providerId: `${providerClass}:default`,
	      providerClass,
	      modelId: providerDefaultModelIds[providerClass],
	      aliases: [`${providerClass}:auto_best`, `${providerClass}:auto_fast`, `${providerClass}:cost_aware`],
      capabilityDigest: digestOf({providerClass, strengths: spec.strengths, context: spec.context}),
      modalities: spec.modalities,
      strengths: spec.strengths,
      limits: {
        contextWindowTokens: spec.context,
        maxOutputTokens: spec.output,
        supportsStructuredOutput: true,
        supportsToolUse: spec.modalities.includes("tool_use")
      },
      toolCapabilities: spec.modalities.includes("tool_use") ? ["mcp_proxy", "function_calling", "json_schema_output"] : ["json_schema_output"],
      qualitySignals: {reasoningScore, codingScore, reviewScore, latencyClass, reliabilityScore},
      costSignals: {costClass, quotaClass},
      availability: "available",
      observedAt
    };
  });
}

function defaultModelSelectionPolicies() {
  const common = {
    schemaVersion: "model-selection-policy/v1",
    taskType: "ai_native_work_item",
    scoringWeights: {capabilityFit: 2, roleSkillFit: 2, quality: 2, latency: 1, cost: 1, quota: 1, reliability: 2, risk: 1},
    hardConstraints: {minContextWindowTokens: 32000, requiresStructuredOutput: true, requiresToolUse: true, minReliabilityScore: 0.75},
    fallbackPolicy: {onNoModel: "split_task", onQuotaLimited: "select_next_ranked", onProviderDegraded: "select_next_ranked"},
    decisionSchemaRef: "spec/model-selection-decision.schema.json"
  };
  return Object.keys(roleCapabilityHints).map((roleId) => ({
    ...clone(common),
    policyId: `msp_${roleId}`,
    roleId,
    requiredCapabilities: roleCapabilityHints[roleId].capabilities
  }));
}

export function selectModel(state, request = {}) {
  ensureRuntimeCollections(state);
  const roleId = request.roleId || request.ownerRole || "orchestrator";
  const workItem = request.workItem || findWorkItem(state, request.taskGroupId, request.workItemId) || {};
  const policy = state.modelSelectionPolicies.find((item) => item.roleId === roleId) || state.modelSelectionPolicies[0];
  const roleSkill = resolveRoleSkill(state, roleId, request);
  const taskExecution = classifyTaskExecution(workItem, request);
  const modelCeiling = modelCeilingForTask(taskExecution, request);
  const requiredCapabilities = unique([
    ...(request.requiredCapabilities || []),
    ...(policy?.requiredCapabilities || []),
    ...inferCapabilities(`${workItem.title || ""} ${workItem.ownerRole || roleId}`)
  ]);
  const hardConstraints = {...(policy?.hardConstraints || {}), ...(request.hardConstraints || {}), maxReasoningLevel: modelCeiling.maxReasoningLevel};
  const selectionMode = normalizeSelectionMode(request.selectionMode);
  const candidates = state.modelCapabilities.map((candidateModel) => rankModel(candidateModel, roleSkill, requiredCapabilities, hardConstraints, selectionMode, taskExecution, modelCeiling, policy?.fallbackPolicy || {}));
  candidates.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.totalScore - a.totalScore);
  const selected = candidates.find((candidate) => candidate.eligible);
  const at = new Date().toISOString();
  const decisionId = createId("msd");
  const modelDecision = shortModelDecision({workItem, request, taskExecution, selected, modelCeiling});
  const decision = {
    schemaVersion: "model-selection-decision/v1",
    decisionId,
    projectId: request.projectId || workItem.projectId || "prj_control_plane",
    taskGroupId: request.taskGroupId || workItem.taskGroupId || "tg_runtime_management",
    workItemId: request.workItemId || workItem.id || "work_unknown",
    status: selected ? "selected" : "rejected",
    roleId,
    roleSkillRef: roleSkill.roleSkillId,
    roleSkillDigest: roleSkill.contentDigest,
    taskExecutionClass: taskExecution.taskExecutionClass,
    splitRequired: taskExecution.splitRequired,
    maxModelTier: modelCeiling.maxModelTier,
    maxReasoningLevel: modelCeiling.maxReasoningLevel,
    escalationAllowed: modelCeiling.escalationAllowed,
    escalationRationaleRefs: modelCeiling.escalationRationaleRefs,
    selectionMode,
    modelDecision,
    candidateRankings: candidates.slice(0, Math.min(8, candidates.length)).map((candidate, index) => ({
      rank: index + 1,
      providerClass: candidate.providerClass,
      modelId: candidate.modelId,
      totalScore: candidate.totalScore,
      eligible: candidate.eligible,
      capabilityProfileRef: candidate.capabilityProfileRef,
      reasoningLevel: candidate.reasoningLevel,
      modelTier: candidate.modelTier,
      ...(candidate.rejectionReason ? {rejectionReason: candidate.rejectionReason} : {})
    })),
    hardConstraintResults: hardConstraintResults(hardConstraints, selected),
    scoreBreakdown: selected?.scoreBreakdown || emptyScoreBreakdown(),
    policyDecisionRef: request.policyDecisionRef || `policy:model-selection:${decisionId}`,
    auditRef: request.auditRef || `audit:model-selection:${decisionId}`,
    createdAt: at
  };
  if (selected) {
    decision.selectedAgentSkillRef = roleSkill.roleSkillId;
    decision.selectedModel = {
      providerClass: selected.providerClass,
      providerId: selected.providerId,
      modelId: selected.modelId,
      modelTier: selected.modelTier,
      reasoningLevel: selected.reasoningLevel,
      reasoning: selected.reasoningLevel,
      modelDecision,
      maxModelTier: modelCeiling.maxModelTier,
      maxReasoningLevel: modelCeiling.maxReasoningLevel,
      capabilityProfileRef: selected.capabilityProfileRef
    };
  } else {
    decision.denialReason = "no_candidate_satisfied_hard_constraints";
    decision.fallbackPolicyRef = policy?.policyId || "msp_default";
  }
  state.modelSelectionDecisions.unshift(decision);
  state.modelSelectionDecisions = state.modelSelectionDecisions.slice(0, 160);
  appendEvent(state, "model_selection_decision", "ModelSelectionDecision", decision.decisionId, "model-registry", decision);
  return decision;
}

function rankModel(candidateModel, roleSkill, requiredCapabilities, hardConstraints, selectionMode, taskExecution, modelCeiling, fallbackPolicy = {}) {
  const reasons = [];
  const availability = candidateModel.availability || "available";
  if (availability === "unavailable") reasons.push("availability_unavailable");
  if (availability === "quota_limited" && fallbackPolicy.onQuotaLimited === "select_next_ranked") reasons.push("availability_quota_limited");
  if (availability === "degraded" && fallbackPolicy.onProviderDegraded === "select_next_ranked") reasons.push("availability_degraded");
  if (hardConstraints.minContextWindowTokens && candidateModel.limits.contextWindowTokens < hardConstraints.minContextWindowTokens) reasons.push("context_window");
  if (hardConstraints.requiresStructuredOutput && !candidateModel.limits.supportsStructuredOutput) reasons.push("structured_output");
  if (hardConstraints.requiresToolUse && !candidateModel.limits.supportsToolUse) reasons.push("tool_use");
  if (hardConstraints.allowedProviderClasses?.length && !hardConstraints.allowedProviderClasses.includes(candidateModel.providerClass)) reasons.push("provider_not_allowed");
  if (hardConstraints.forbiddenProviderClasses?.includes(candidateModel.providerClass)) reasons.push("provider_forbidden");
  if (hardConstraints.minReliabilityScore && candidateModel.qualitySignals.reliabilityScore < hardConstraints.minReliabilityScore) reasons.push("reliability");
  if (hardConstraints.maxCostClass && costRank(candidateModel.costSignals.costClass) > costRank(hardConstraints.maxCostClass)) reasons.push("cost");
  const baseReasoningLevel = reasoningLevelForTask(candidateModel, taskExecution);
  const modelTier = modelTierForCandidate(candidateModel);
  if (reasoningRank[baseReasoningLevel] > reasoningRank[hardConstraints.maxReasoningLevel || "high"] && !modelCeiling.escalationAllowed) reasons.push("reasoning_above_task_ceiling");
  if (modelTierRank[modelTier] > modelTierRank[modelCeiling.maxModelTier || "frontier_standard"] && !modelCeiling.escalationAllowed) reasons.push("model_tier_above_task_ceiling");
  const capabilityFit = overlapScore(requiredCapabilities, candidateModel.strengths);
  const roleSkillFit = overlapScore(roleSkill.capabilities, candidateModel.strengths);
  const quality = (candidateModel.qualitySignals.reasoningScore + candidateModel.qualitySignals.codingScore + candidateModel.qualitySignals.reviewScore) / 3;
  const latency = latencyScore(candidateModel.qualitySignals.latencyClass, selectionMode);
  const cost = 1 - costRank(candidateModel.costSignals.costClass) / 3;
  const quota = quotaScore(candidateModel.costSignals.quotaClass);
  const reliability = candidateModel.qualitySignals.reliabilityScore * availabilityScore(availability, fallbackPolicy);
  const risk = ["ollama", "vllm"].includes(candidateModel.providerClass) ? 0.92 : 0.84;
  const scoreBreakdown = {capabilityFit, roleSkillFit, quality, latency, cost, quota, reliability, risk};
  const weighted = capabilityFit * 2 + roleSkillFit * 2 + quality * 2 + latency + cost + quota + reliability * 2 + risk;
  return {
    providerClass: candidateModel.providerClass,
    providerId: candidateModel.providerId,
    modelId: candidateModel.modelId,
    totalScore: Math.max(0, Math.min(1, Number((weighted / 12).toFixed(4)))),
    eligible: reasons.length === 0,
    capabilityProfileRef: `${candidateModel.providerId}/${candidateModel.modelId}`,
    availability,
    modelTier,
    reasoningLevel: modelCeiling.escalationAllowed ? baseReasoningLevel : capReasoning(baseReasoningLevel, modelCeiling.maxReasoningLevel),
    scoreBreakdown,
    ...(reasons.length ? {rejectionReason: reasons.join(",")} : {})
  };
}

function classifyTaskExecution(workItem = {}, request = {}) {
  const text = `${workItem.title || ""} ${workItem.ownerRole || ""} ${(workItem.requirements || []).join(" ")} ${request.taskPrompt || ""}`.toLowerCase();
  const analysis = /分析|深度|调研|架构|设计|方案|复验|审查|review|audit|research|architecture|design|planning/u.test(text);
  const implementation = /代码|开发|实现|修复|改造|构建|提交|push|docker|npm|shell|code|implement|build|fix|patch|commit/u.test(text);
  const verification = /测试|验证|自检|doctor|e2e|复测|test|verify|validation/u.test(text);
  const special = /安全|权限|高风险|生产|跨系统|核心故障|总控偏移|调度安全|监测偏移|security|permission|production|critical/u.test(text);
  let taskExecutionClass = "implementation";
  if (analysis && !implementation) taskExecutionClass = "deep_analysis";
  else if (verification && !implementation) taskExecutionClass = "verification";
  else if (analysis && implementation) taskExecutionClass = "mixed_analysis_implementation";
  else if (/小任务|短任务|quick|minor/u.test(text)) taskExecutionClass = "short_execution";
  return {
    taskExecutionClass,
    splitRequired: taskExecutionClass === "mixed_analysis_implementation",
    specialEscalationSignal: special,
    signals: unique([
      ...(analysis ? ["analysis"] : []),
      ...(implementation ? ["implementation"] : []),
      ...(verification ? ["verification"] : []),
      ...(special ? ["special_escalation_signal"] : [])
    ])
  };
}

function modelCeilingForTask(taskExecution, request = {}) {
  const escalationAllowed = request.allowModelEscalation === true || taskExecution.specialEscalationSignal === true;
  return {
    maxModelTier: escalationAllowed ? (request.maxModelTier || "frontier_plus") : (request.maxModelTier || defaultModelCeiling.maxModelTier),
    maxReasoningLevel: escalationAllowed ? (request.maxReasoningLevel || "high") : (request.maxReasoningLevel || defaultModelCeiling.maxReasoningLevel),
    escalationAllowed,
    escalationRationaleRefs: escalationAllowed ? [`task-signal:${taskExecution.signals.join("+") || "special"}`] : ["policy:default_cap_frontier_standard_high"]
  };
}

function shortModelDecision({workItem = {}, request = {}, taskExecution, selected, modelCeiling}) {
  const text = `${workItem.title || ""} ${(workItem.requirements || []).join(" ")} ${request.taskPrompt || ""}`.toLowerCase();
  const risk = taskExecution.specialEscalationSignal ? "P0 risk" : /权限|跨仓|cross-repo|root-cause|裁决|architecture|架构/u.test(text) ? "decision risk" : "no architecture裁决";
  const writeSet = request.writeSet?.length ? "fixed writeSet" : "bounded writeSet";
  const workKind = taskExecution.taskExecutionClass === "verification" ? "directed verification" : taskExecution.taskExecutionClass === "short_execution" ? "short mechanical task" : taskExecution.taskExecutionClass === "deep_analysis" ? "analysis/cross-check" : "implementation";
  const model = selected?.modelId || providerDefaultModelIds.custom;
  const reasoning = selected?.reasoningLevel || capReasoning(modelCeiling.maxReasoningLevel || "medium", "high");
  return `modelDecision: ${writeSet} ${workKind}; ${risk} -> ${model} / ${reasoning}`.slice(0, 220);
}

function reasoningLevelForTask(candidateModel, taskExecution) {
  if (taskExecution.taskExecutionClass === "deep_analysis") return candidateModel.qualitySignals.reasoningScore >= 0.82 ? "high" : "medium";
  if (taskExecution.taskExecutionClass === "verification") return candidateModel.qualitySignals.reviewScore >= 0.86 ? "medium" : "standard";
  if (taskExecution.taskExecutionClass === "short_execution") return "low";
  return candidateModel.qualitySignals.codingScore >= 0.88 ? "medium" : "standard";
}

function capReasoning(reasoningLevel, maxReasoningLevel) {
  return reasoningRank[reasoningLevel] > reasoningRank[maxReasoningLevel] ? maxReasoningLevel : reasoningLevel;
}

function modelTierForCandidate(candidateModel) {
  const quality = (candidateModel.qualitySignals.reasoningScore + candidateModel.qualitySignals.codingScore + candidateModel.qualitySignals.reviewScore) / 3;
  if (quality >= 0.9) return "frontier_standard";
  if (quality >= 0.84) return "frontier_economy";
  return "standard";
}

function hardConstraintResults(hardConstraints, selected) {
  const keys = Object.keys(hardConstraints);
  const resultKeys = keys.length ? keys : ["default_provider_registry"];
  return resultKeys.map((constraint) => ({
    constraint,
    status: selected ? "passed" : "failed",
    evidenceRefs: [`model-registry:${constraint}`]
  }));
}

function emptyScoreBreakdown() {
  return {capabilityFit: 0, roleSkillFit: 0, quality: 0, latency: 0, cost: 0, quota: 0, reliability: 0, risk: 0};
}

function overlapScore(required, available) {
  const req = unique(required).filter(Boolean);
  if (!req.length) return 1;
  const have = new Set(available);
  return Number((req.filter((item) => have.has(item)).length / req.length).toFixed(4));
}

function latencyScore(latencyClass, selectionMode) {
  const base = {low: 1, normal: 0.75, high: 0.45, unknown: 0.55}[latencyClass] ?? 0.55;
  return selectionMode === "auto_fast" ? base : Math.min(1, base + 0.1);
}

function normalizeSelectionMode(value) {
  return ["dynamic_context", "auto_best", "auto_fast", "cost_aware"].includes(value) ? value : "dynamic_context";
}

function costRank(costClass) {
  return {low: 0, normal: 1, high: 2, unknown: 1.5}[costClass] ?? 1.5;
}

function quotaScore(quotaClass) {
  return {high: 1, normal: 0.75, low: 0.45, unknown: 0.55}[quotaClass] ?? 0.55;
}

function availabilityScore(availability, fallbackPolicy = {}) {
  if (availability === "available") return 1;
  if (availability === "degraded") return fallbackPolicy.onProviderDegraded === "select_next_ranked" ? 0.55 : 0.75;
  if (availability === "quota_limited") return 0.35;
  return 0;
}

/* ── 可复用 worker lane 模型 ──
 * worker lane 归属某个角色（roleId），一个角色可拥有多个 lane；lane 是可复用的顶层执行载体，
 * 复用前须通过 reusePrecheck；在 base 漂移 / 采纳 P0-P1 / Ruleset 变化 / 上下文过长 / 模型档不匹配时轮换归档。
 */
const WORKER_LANE_TERMINAL = new Set(["retired"]);
// Legal WorkItem states (spec/state-machines.yaml) that represent a work item held back from progress.
// There is no "blocked" WorkItem state; blockage is expressed via one of these specific enums.
export const BLOCKED_WORKITEM_STATUSES = ["blocked_dependency", "blocked_resource", "permission_required", "needs_decision", "stale_state"];
const BLOCKED_OR_FAILED_WORKITEM_STATUSES = [...BLOCKED_WORKITEM_STATUSES, "failed"];

function laneReusePrecheck(state, lane) {
  const currentSession = lane.currentSessionId ? (state.workSessions || []).find((item) => item.sessionId === lane.currentSessionId) : null;
  const checks = {
    laneIdle: lane.status === "idle",
    previousSessionClean: !currentSession || ["completed_objective", "closed", "recycled"].includes(currentSession.status),
    notRetired: !WORKER_LANE_TERMINAL.has(lane.status),
    rulesetResampled: true,      // 每次复用由内容包重建 Ruleset/graph/inputLocators
    modelDecisionRewritten: true // decideSessionPlacement 每次重算 modelDecision
  };
  return {ok: Object.values(checks).every(Boolean), checks};
}

function registerWorkerLane(state, {roleId, laneFunction, taskGroupId}) {
  const at = new Date().toISOString();
  const lane = {
    schemaVersion: "worker-lane/v1",
    laneId: createId("lane"),
    roleId: roleId || "orchestrator",
    laneFunction: laneFunction || "general_execution",
    reuseMode: "reusable_top_level_lane",
    status: "idle",
    reuseGeneration: 0,
    reuseCount: 0,
    currentSessionId: null,
    boundNodeId: null,
    taskGroupId: taskGroupId || null,
    createdAt: at,
    updatedAt: at
  };
  state.workerLanes.unshift(lane);
  appendEvent(state, "worker_lane_registered", "WorkerLane", lane.laneId, "scheduler", lane);
  return lane;
}

// 为某角色获取载体并原子占用：优先复用该角色的空闲 lane（过 precheck），否则为该角色新建 lane（角色 1:N lane）。
// 获取即置 busy 并绑定会话，避免同角色多个决策抢占同一空闲 lane。
export function acquireWorkerLane(state, {roleId, laneFunction, taskGroupId, sessionId} = {}) {
  ensureRuntimeCollections(state);
  const roleLanes = (state.workerLanes || []).filter((lane) => lane.roleId === roleId && lane.status === "idle" && !WORKER_LANE_TERMINAL.has(lane.status));
  for (const lane of roleLanes) {
    const precheck = laneReusePrecheck(state, lane);
    if (!precheck.ok) continue;
    lane.reuseGeneration += 1;
    lane.reuseCount += 1;
    if (laneFunction) lane.laneFunction = laneFunction;
    if (taskGroupId) lane.taskGroupId = taskGroupId;
    lane.status = "busy";
    lane.currentSessionId = sessionId || null;
    lane.updatedAt = new Date().toISOString();
    return {mode: "reuse_lane", lane, reusePrecheck: precheck};
  }
  const lane = registerWorkerLane(state, {roleId, laneFunction, taskGroupId});
  lane.status = "busy";
  lane.currentSessionId = sessionId || null;
  lane.updatedAt = new Date().toISOString();
  return {mode: "new_lane", lane, reusePrecheck: {ok: true, checks: {newlyCreated: true}}};
}

export function rotateWorkerLane(state, laneId, reason) {
  ensureRuntimeCollections(state);
  const lane = (state.workerLanes || []).find((item) => item.laneId === laneId);
  if (!lane) return null;
  lane.status = "retired";
  lane.retireReason = reason || "rotate";
  lane.updatedAt = new Date().toISOString();
  appendEvent(state, "worker_lane_retired", "WorkerLane", lane.laneId, "scheduler", {laneId, reason: lane.retireReason});
  return lane;
}

// 每轮维护：释放会话已终态的 lane、按复用代数上限归档、剪枝历史归档 lane。
export function maintainWorkerLanes(state, options = {}) {
  ensureRuntimeCollections(state);
  const maxGeneration = Number(options.maxReuseGeneration || process.env.AIMAC_WORKER_LANE_MAX_REUSE || 50);
  for (const lane of state.workerLanes) {
    if (WORKER_LANE_TERMINAL.has(lane.status)) continue;
    if (lane.currentSessionId) {
      const session = (state.workSessions || []).find((item) => item.sessionId === lane.currentSessionId);
      if (session && ["failed", "aborted"].includes(session.status)) {
        // 承载过失败/中止会话的 lane 不静默复用，直接轮换归档，避免带过失败上下文
        lane.currentSessionId = null;
        rotateWorkerLane(state, lane.laneId, "carried_failed_session");
      } else if (!session || ["completed_objective", "closed", "recycled"].includes(session.status)) {
        lane.status = "idle";
        lane.currentSessionId = null;
        lane.updatedAt = new Date().toISOString();
      }
    }
    if (lane.status === "idle" && lane.reuseGeneration >= maxGeneration) {
      rotateWorkerLane(state, lane.laneId, "reuse_generation_exceeded");
    }
  }
  const retired = state.workerLanes.filter((lane) => WORKER_LANE_TERMINAL.has(lane.status));
  if (retired.length > 200) {
    const keep = new Set(retired.slice(0, 200).map((lane) => lane.laneId));
    state.workerLanes = state.workerLanes.filter((lane) => !WORKER_LANE_TERMINAL.has(lane.status) || keep.has(lane.laneId));
  }
  reconcileRoleDriftGuards(state);
  return state.workerLanes;
}

// acceptAgentCheckpoint is the only path that closes a role-drift guard (on a checkpointing session).
// A session that terminalizes WITHOUT a checkpoint (cancel / claim-expiry recycle / fail / revoke)
// would otherwise leave its guard "monitoring" forever, so no_active_role_drift_guard wedges the
// close barrier and guards grow unbounded. Close any guard whose session is terminal or gone, and
// cap the retained closed guards.
function reconcileRoleDriftGuards(state) {
  const terminalSessionStatuses = new Set(["failed", "aborted", "recycled", "closed", "completed_objective"]);
  const at = new Date().toISOString();
  for (const guard of state.roleDriftGuards || []) {
    if (["closed", "corrected"].includes(guard.status)) continue;
    const session = guard.sessionId ? (state.workSessions || []).find((item) => item.sessionId === guard.sessionId) : null;
    if (!session || terminalSessionStatuses.has(session.status)) {
      guard.status = "closed";
      guard.closeReason = session ? `session_${session.status}` : "session_absent";
      guard.updatedAt = at;
    }
  }
  const closedGuards = (state.roleDriftGuards || []).filter((guard) => ["closed", "corrected"].includes(guard.status));
  if (closedGuards.length > 200) {
    const keep = new Set(closedGuards.slice(0, 200).map((guard) => guard.guardId));
    state.roleDriftGuards = (state.roleDriftGuards || []).filter((guard) => !["closed", "corrected"].includes(guard.status) || keep.has(guard.guardId));
  }
}

export function decideSessionPlacement(state, request = {}) {
  ensureRuntimeCollections(state);
  const taskGroup = state.taskGroups?.find((item) => item.id === request.taskGroupId);
  const workItem = request.workItem || findWorkItem(state, request.taskGroupId, request.workItemId) || {};
  const modelDecision = request.modelSelectionDecision || selectModel(state, request);
  const signals = unique([...(request.workSignals || []), ...inferWorkSignals(workItem, taskGroup)]);
  const activeSubagents = state.workSessions.filter((session) => session.parentSessionId === "sess_orch_1" && session.placement === "subagent" && !WORK_SESSION_SETTLED_STATUSES.includes(session.status)).length;
  if (activeSubagents >= 3 && !signals.includes("subagent_limit_approaching")) signals.push("subagent_limit_approaching");
  const sustained = signals.some((signal) => ["expected_multi_turn", "long_running", "stateful_context", "role_owner_required", "independent_work_owner", "write_scope_owner", "cross_file_or_cross_service_change", "external_capability_flow", "git_or_release_side_effect", "subagent_limit_approaching", "controller_context_pressure"].includes(signal));
  const placement = sustained ? "new_session" : "subagent";
  const at = new Date().toISOString();
  const decision = {
    schemaVersion: "session-placement-decision/v1",
    decisionId: createId("spd"),
    projectId: request.projectId || taskGroup?.projectId || "prj_control_plane",
    taskGroupId: request.taskGroupId || taskGroup?.id || "tg_runtime_management",
    workItemId: request.workItemId || workItem.id || "work_unknown",
    status: placement === "new_session" ? "new_session_selected" : "subagent_selected",
    placement,
    workSignals: signals.length ? signals : ["single_turn", "read_only_scan", "no_persistent_state", "no_global_task_ownership"],
    capacitySnapshotRef: `capacity:controller:sess_orch_1:subagents:${activeSubagents}`,
    modelSelectionDecisionRef: modelDecision.decisionId,
    taskContractRef: request.taskContractRef || `pending-contract:${request.workItemId || workItem.id || "work_unknown"}`,
    rationaleRefs: sustained ? ["policy:new_session_for_sustained_work"] : ["policy:short_contained_subagent"],
    auditRef: request.auditRef || `audit:session-placement:${createId("audit")}`,
    createdAt: at
  };
  // worker 载体决策：持续型工作走可复用 worker lane（归属工作项 owner 角色，角色 1:N lane），短工作走 subagent。
  // 此处只记录载体意图与角色；具体 lane 的选取+占用在 buildTaskContract 建会话时由 acquireWorkerLane 原子完成。
  const laneRoleId = workItem.ownerRole || request.roleId || "orchestrator";
  // A7: choose among the four carriers and record why the others were NOT chosen (a placement
  // lacking nonSelectedCarriers/nonReuseReason is an incomplete admission record). `mode` is kept
  // for backward compatibility with acquireWorkerLane; `carrier` is the 4-way generalized enum.
  const selectedCarrier = placement === "new_session" ? "reusable_top_level_lane" : "short_subagent";
  const carrierReasons = {
    short_subagent: sustained ? "rejected: sustained/multi-turn/stateful/ownership signals present" : "selected: single-turn contained work",
    reusable_top_level_lane: sustained ? "selected: reuse a free role-owned lane when acquire precheck passes" : "rejected: no persistent ownership needed",
    new_top_level_lane: sustained ? "deferred: only if no reusable free role lane passes the acquire precheck" : "rejected: single-turn contained work",
    integration_owner_direct: "rejected: delegable role task, not an integration-owner-only side effect"
  };
  const nonSelectedCarriers = [...WORKER_CARRIER_MODES].filter((carrier) => carrier !== selectedCarrier).map((carrier) => ({carrier, reason: carrierReasons[carrier]}));
  if (placement === "new_session") {
    decision.workerCarrierDecision = {
      mode: "worker_lane",
      carrier: selectedCarrier,
      roleId: laneRoleId,
      laneFunction: request.laneFunction || modelDecision.taskExecutionClass || "general_execution",
      nonReuseReason: "prefer_reuse_of_free_role_lane_via_acquire_precheck",
      retireOrArchiveCondition: "base_drift | ruleset_change | P0-P1_adopted | max_reuse_generations_exceeded | owning_session_terminal",
      nonSelectedCarriers
    };
  } else {
    decision.workerCarrierDecision = {mode: "subagent", carrier: selectedCarrier, roleId: laneRoleId, nonReuseReason: "not_applicable_short_subagent", retireOrArchiveCondition: "session_end", nonSelectedCarriers};
    decision.subagentSafetyProof = {
      singleTurn: true,
      noPersistentState: true,
      noGlobalTaskOwnership: true,
      boundedRepositoryLeaseOnly: true,
      noExternalCapabilityFlow: true,
      subagentCapacityAvailable: true
    };
  }
  state.sessionPlacementDecisions.unshift(decision);
  state.sessionPlacementDecisions = state.sessionPlacementDecisions.slice(0, 160);
  appendEvent(state, "session_placement_decision", "SessionPlacementDecision", decision.decisionId, "scheduler", decision);
  return decision;
}

export function buildTaskContract(state, request = {}) {
  ensureRuntimeCollections(state);
  const taskGroup = state.taskGroups.find((item) => item.id === request.taskGroupId) || state.taskGroups[0];
  const workItem = request.workItem || findWorkItem(state, taskGroup?.id, request.workItemId) || taskGroup?.workItems?.[0];
  const project = state.projects.find((item) => item.id === taskGroup?.projectId) || state.projects[0];
  // Idempotency guard: if a non-terminal dispatch already exists for this cell, return its contract
  // instead of minting a new session/lease/worker-lane. Without this, a duplicate build (e.g. two
  // MCP session.start calls, since enqueueAgentDispatch dedups only AFTER buildTaskContract has
  // acquired resources) orphans an active session + busy worker lane that maintainWorkerLanes can
  // never release. runAutonomousCycle already pre-guards via activeExecutionForWork, so this only
  // affects the direct-call paths.
  const existingDispatch = (state.agentDispatches || []).find((item) =>
    item.taskGroupId === taskGroup?.id && item.workItemId === workItem?.id && !["completed", "failed", "cancelled"].includes(item.status));
  if (existingDispatch) {
    const existingContract = (state.agentTaskContracts || []).find((item) => item.sessionId === existingDispatch.sessionId && item.runId === existingDispatch.runId)
      || (state.agentTaskContracts || []).find((item) => item.sessionId === existingDispatch.sessionId);
    if (existingContract) return existingContract;
  }
  const modelDecision = request.modelSelectionDecision || selectModel(state, {projectId: project?.id, taskGroupId: taskGroup?.id, workItemId: workItem?.id, roleId: workItem?.ownerRole || "orchestrator"});
  assertSelectedModelDecision(modelDecision);
  const placementDecision = request.placementDecision || decideSessionPlacement(state, {projectId: project?.id, taskGroupId: taskGroup?.id, workItemId: workItem?.id, workItem, modelSelectionDecision: modelDecision});
  const repositoryTarget = ensureRepositoryTarget(state, project, taskGroup, workItem, request);
  const sessionId = placementDecision.placement === "new_session" ? createId("sess") : `subagent_${createId("sa")}`;
  const runId = createId("run");
  const at = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const languagePolicy = normalizeTaskGroupLanguagePolicy(taskGroup?.languagePolicy);
  const languagePolicyDigest = digestOf(languagePolicy);
  const roleSkill = resolveRoleSkill(state, workItem?.ownerRole || "orchestrator", {projectId: project?.id, taskGroupId: taskGroup?.id});
  const skillBindingDigest = digestOf({
    roleId: workItem?.ownerRole || "orchestrator",
    roleSkillRef: roleSkill.roleSkillId,
    roleSkillDigest: roleSkill.contentDigest,
    overlayRefs: roleSkill.overlayRefs || []
  });
  const skillWorksetId = `skillset_${skillBindingDigest.slice("sha256:".length, "sha256:".length + 24)}`;
  const sharedDefinitionRefs = activeSharedDefinitionRefs(state, {projectId: project?.id, taskGroupId: taskGroup?.id, workItemId: workItem?.id});
  const contractSeed = {projectId: project?.id, taskGroupId: taskGroup?.id, workId: workItem?.id, roleId: workItem?.ownerRole, stateVersion: state.stateVersion, languagePolicyDigest};
  const contractDigest = digestOf(contractSeed);
  const guardRef = createId("rdg");
  const packetRef = createId("eip");
  const grantsWriteScope = true;
  // Fold the RESOLVED effective rules (default -> project -> task-group inheritance/override) into the
  // contract digest so rulesetDigest / the effective-instruction packet actually reflect effective rule
  // content and version. Previously rulesetDigest was a static constant, so any consumer treating it as
  // the authoritative rule version would miss operator rule edits (which only changed the content bundle).
  const effectiveRuleConfig = effectiveTaskGroupConfig(state, taskGroup);
  const effectiveRulesDigest = digestOf([
    ...(effectiveRuleConfig.activeSystemRules || []).map((rule) => [rule.ruleId, rule.contentDigest]),
    ...(effectiveRuleConfig.activeBusinessRules || []).map((rule) => [rule.ruleId, rule.contentDigest])
  ]);
  const contract = {
    contractVersion: "agent-task-contract/v1",
    projectId: project?.id || "prj_control_plane",
    taskGroupId: taskGroup?.id || "tg_runtime_management",
    commandId: createId("cmd_contract"),
    sessionId,
    runId,
    idempotencyKey: request.idempotencyKey || createId("idem_contract"),
    protocolVersion: "control-plane/v1",
    schemaDigest: specContentDigest("spec/agent-task-contract.schema.json"),
    contractDigest,
    issuedAt: at,
    expiresAt,
    taskId: taskGroup?.id || "tg_runtime_management",
    workId: workItem?.id || "work_unknown",
    roleId: workItem?.ownerRole || "orchestrator",
    roleSkill: {
      roleSkillRef: roleSkill.roleSkillId,
      roleSkillDigest: roleSkill.contentDigest,
      selectedAgentSkillRef: roleSkill.roleSkillId,
      sourceId: roleSkill.sourceId,
      overlayRefs: roleSkill.overlayRefs || [],
      worksetId: skillWorksetId,
      synchronizationMode: "server_managed_on_demand",
      usageDirective: `The ${workItem?.ownerRole || "orchestrator"} agent must load this exact skill workset before execution and must explicitly bind a separate server-issued workset for every child role. ${languagePolicyDirective(languagePolicy)}`,
      modelSelectionDecisionRef: modelDecision.decisionId
    },
    roomId: `room_${taskGroup?.id || "runtime"}`,
    placementDecisionRef: placementDecision.decisionId,
    stateVersion: state.stateVersion,
    rulesetDigest: digestOf(["ruleset:ai-native-control-plane:v1", effectiveRulesDigest]),
    effectiveRulesDigest,
    effectiveInstructionPacketRef: packetRef,
    digestRefs: ["ruleset:ai-native-control-plane:v1", `effective-ruleset:${effectiveRulesDigest}`, `model-selection:${modelDecision.decisionId}`, `session-placement:${placementDecision.decisionId}`, `language-policy:${languagePolicyDigest}`],
    languagePolicy,
    languagePolicyDigest,
    sharedDefinitionRefs,
    actionBasis: {
      effectiveInstructionPacketRef: packetRef,
      sourceKind: "orchestrator_plan",
      sourceRef: `TaskGroup:${taskGroup?.id || "tg_runtime_management"}`,
      nextActionDraftDigest: digestOf({workItem, action: "execute"}),
      activeRuleRefs: ["terminal-execution-manifest:v1", "state-machines:v1", "language-policy:v1", `effective-ruleset:${effectiveRulesDigest}`],
      nonActiveMaterialRefs: [],
      contextIntakeRefs: [`Project:${project?.id || "prj_control_plane"}`, `TaskGroup:${taskGroup?.id || "tg_runtime_management"}`, `LanguagePolicy:${languagePolicyDigest}`],
      validationRequirements: ["schema_valid", "checkpoint_registered", "repository_output_target_selected", "language_policy_satisfied"],
      forbiddenActions: ["mutate_active_ruleset", "self_patch_control_plane", "auto_expand_mcp_grant"],
      deferredDecisions: []
    },
    roleFocus: {
      roleDriftGuardRef: guardRef,
      objectiveBoundaryDigest: digestOf(taskGroup?.objective || "objective"),
      roleMissionDigest: digestOf(workItem?.ownerRole || "role"),
      taskContractDigest: contractDigest,
      allowedActionScopeRefs: [`RepositoryOutputTarget:${repositoryTarget.targetId}`, `TaskGroup:${taskGroup?.id || "tg_runtime_management"}`],
      forbiddenActionScopeRefs: ["forbidden:external_capability_bypass", "forbidden:runtime_self_upgrade"],
      maxAllowedDriftScore: ["orchestrator", "scheduler", "monitor"].includes(workItem?.ownerRole) ? 0.1 : 0.2
    },
    inputLocators: [`state://task-groups/${taskGroup?.id || "tg_runtime_management"}`, `state://task-groups/${taskGroup?.id || "tg_runtime_management"}/language-policy`, `state://work-items/${workItem?.id || "work_unknown"}`],
    inputDigests: {[`work-item:${workItem?.id || "work_unknown"}`]: digestOf(workItem || {}), [`language-policy:${taskGroup?.id || "tg_runtime_management"}`]: languagePolicyDigest},
    writeScope: [],
    repositoryOutputTargetRef: repositoryTarget.targetId,
    repositoryOutputTargetDigest: digestOf(repositoryTarget),
    artifactManifestPath: repositoryTarget.artifactManifestPath || `docs/artifact-manifests/${workItem?.id || "work"}.json`,
    readScope: [{resourceType: "state", resourceKey: `TaskGroup:${taskGroup?.id || "tg_runtime_management"}`, access: "read", resourceDigest: digestOf(taskGroup || {})}],
    model: {
      model: modelDecision.selectedModel.modelId,
      modelId: modelDecision.selectedModel.modelId,
      alias: modelDecision.selectedModel.providerClass,
      providerClass: modelDecision.selectedModel.providerClass,
      taskExecutionClass: modelDecision.taskExecutionClass || "implementation",
      reasoning: modelDecision.selectedModel.reasoning || modelDecision.selectedModel.reasoningLevel,
      reasoningLevel: modelDecision.selectedModel.reasoningLevel,
      selectionMode: modelDecision.selectionMode,
      modelDecision: modelDecision.modelDecision,
      modelSelectionDecisionRef: modelDecision.decisionId
    },
    mcpGrants: [],
    permissionPolicy: {
      onMissing: "permission_request",
      autoAllowPromptTypes: ["browser_download", "dev_server_open"],
      denyPromptTypes: ["oauth_consent", "account_login", "uac_admin", "keychain_access", "sudo", "hardware_key", "payment_authorization", "cloud_org_boundary", "production_boundary"],
      policyDecisionRef: request.policyDecisionRef || `policy:contract:${contractDigest}`
    },
    dependencies: request.dependencies || [],
    stopOrReturn: ["done", "blocked", "stale_state", "needs_decision", "permission_required", "spec_drift", "failed"],
    outputContract: {
      requiredOutputs: ["checkpoint", "commitRef", "pushRef", "evidenceRefs", "verificationRefs"],
      evidenceRequired: true,
      checkpointRequired: true,
      independentReviewRequired: true,
      pushRefRequired: true,
      requiredLanguage: languagePolicy.languageTag,
      languagePolicyDigest,
      languagePolicyRef: `LanguagePolicy:${languagePolicyDigest}`,
      schemaRef: "spec/checkpoint.schema.json",
      schemaDigest: specContentDigest("spec/checkpoint.schema.json")
    }
  };
  if (grantsWriteScope) {
    const lease = ensureLease(state, repositoryTarget, `session:${sessionId}`, contractDigest);
    contract.writeScope = [{
      resourceType: "git_repo",
      resourceKey: repositoryTarget.repositoryId,
      access: "write",
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      leaseExpiresAt: lease.expiresAt,
      resourceDigestBefore: gitHead(request.root)
    }];
  }
  state.agentTaskContracts.unshift(contract);
  state.agentTaskContracts = capTaskContracts(state.agentTaskContracts, state.agentDispatches, 160);
  // 持续型工作在建会话时获取并占用其角色的 worker lane（复用空闲/新建），回填具体载体到放置决策；subagent 无 lane
  let acquiredLaneId = null;
  if (placementDecision.workerCarrierDecision?.mode === "worker_lane") {
    const acquired = acquireWorkerLane(state, {
      roleId: placementDecision.workerCarrierDecision.roleId,
      laneFunction: placementDecision.workerCarrierDecision.laneFunction,
      taskGroupId: contract.taskGroupId,
      sessionId
    });
    acquiredLaneId = acquired.lane.laneId;
    placementDecision.workerCarrierDecision.laneId = acquired.lane.laneId;
    placementDecision.workerCarrierDecision.acquireMode = acquired.mode;
    placementDecision.workerCarrierDecision.reuseGeneration = acquired.lane.reuseGeneration;
    placementDecision.workerCarrierDecision.reusePrecheck = acquired.reusePrecheck.checks;
  }
  state.workSessions.unshift({
    sessionId,
    projectId: contract.projectId,
    taskGroupId: contract.taskGroupId,
    workItemId: contract.workId,
    roleId: contract.roleId,
    agentId: agentForRole(state, contract.roleId)?.id || "agent_orchestrator",
    placement: placementDecision.placement,
    laneId: acquiredLaneId,
    status: "active",
    parentSessionId: placementDecision.placement === "subagent" ? "sess_orch_1" : undefined,
    modelSelectionDecisionRef: modelDecision.decisionId,
    placementDecisionRef: placementDecision.decisionId,
    taskContractDigest: contractDigest,
    startedAt: at,
    updatedAt: at
  });
  state.effectiveInstructionPackets.unshift(buildEffectiveInstructionPacket(contract, packetRef, at));
  state.roleDriftGuards.unshift(buildRoleDriftGuard(contract, guardRef, at));
  appendEvent(state, "command_created", "Command", contract.commandId, "orchestrator", contract);
  return contract;
}

function assertSelectedModelDecision(modelDecision) {
  if (modelDecision?.status === "selected" && modelDecision.selectedModel?.modelId && modelDecision.selectedModel?.reasoningLevel) return;
  const error = new Error(`model_selection_rejected:${modelDecision?.denialReason || "no_selected_model"}`);
  error.code = "AIMAC_MODEL_SELECTION_REJECTED";
  error.decision = modelDecision;
  throw error;
}

function buildEffectiveInstructionPacket(contract, packetId, at) {
  return {
    schemaVersion: "effective-instruction-packet/v1",
    packetId,
    projectId: contract.projectId,
    taskGroupId: contract.taskGroupId,
    workItemId: contract.workId,
    status: "active",
    objectiveBoundaryDigest: contract.roleFocus.objectiveBoundaryDigest,
    effectiveRulesDigest: contract.effectiveRulesDigest,
    digestRefs: contract.digestRefs,
    languagePolicy: contract.languagePolicy,
    languagePolicyDigest: contract.languagePolicyDigest,
    languageDirective: languagePolicyDirective(contract.languagePolicy),
    sharedDefinitionRefs: contract.sharedDefinitionRefs,
    nextActionDraftDigest: contract.actionBasis.nextActionDraftDigest,
    actionBasisRef: `action-basis:${contract.commandId}`,
    activeRuleRefs: contract.actionBasis.activeRuleRefs,
    nonActiveMaterialRefs: contract.actionBasis.nonActiveMaterialRefs,
    contextIntakeRefs: contract.actionBasis.contextIntakeRefs,
    validationRequirements: contract.actionBasis.validationRequirements,
    forbiddenActions: contract.actionBasis.forbiddenActions,
    deferredDecisions: contract.actionBasis.deferredDecisions,
    auditRef: `audit:eip:${packetId}`,
    createdAt: at
  };
}

function buildRoleDriftGuard(contract, guardId, at) {
  const roleClass = ["orchestrator"].includes(contract.roleId) ? "meta_control" : ["scheduler"].includes(contract.roleId) ? "control" : ["monitor"].includes(contract.roleId) ? "monitor" : "execution";
  return {
    schemaVersion: "role-drift-guard/v1",
    guardId,
    projectId: contract.projectId,
    taskGroupId: contract.taskGroupId,
    workItemId: contract.workId,
    status: "monitoring",
    roleId: contract.roleId,
    roleClass,
    sessionId: contract.sessionId,
    parentControllerRef: "session:sess_orch_1",
    objectiveBoundaryDigest: contract.roleFocus.objectiveBoundaryDigest,
    roleMissionDigest: contract.roleFocus.roleMissionDigest,
    taskContractDigest: contract.contractDigest,
    effectiveInstructionPacketRef: contract.effectiveInstructionPacketRef,
    allowedActionScopeRefs: contract.roleFocus.allowedActionScopeRefs,
    forbiddenActionScopeRefs: contract.roleFocus.forbiddenActionScopeRefs,
    driftChecks: ["objective_boundary_match", "role_mission_match", "task_contract_match", "allowed_action_scope_match", "forbidden_action_absent", "peer_instruction_not_authoritative", "external_review_not_directive", "progress_signal_relevant", "completion_readiness_not_bypassed"],
    driftScore: 0,
    maxAllowedDriftScore: roleClass === "meta_control" || roleClass === "control" || roleClass === "monitor" ? 0.1 : 0.2,
    driftSignals: [],
    monitorEvidenceRefs: ["monitor:role-focus:bound"],
    correctiveActions: ["pause_side_effects", "reissue_task_contract", "reassign_role"],
    auditRef: `audit:role-drift:${guardId}`,
    createdAt: at,
    updatedAt: at
  };
}

// §4.5 admission ledger: every per-cell scheduling verdict (dispatch / skip / wait / block)
// produces one machine-readable admissionDecision. `outcome` is the single mutually-exclusive
// verdict; the boolean flags are derived from it (exactly one is true) for machine consumers.
// Consecutive identical verdicts for the same cell are collapsed to avoid audit churn.
const ADMISSION_OUTCOMES = new Set([
  "selected", "deferred", "blocked", "resource_queued",
  "awaiting_review", "awaiting_checkpoint", "superseded", "skipped_terminal"
]);

// ---- §4.5 generalized admission/scheduling model (absorbed from the MGP core-init operating
// model, domain-agnostic: MGP market/session -> condition window; provider quota -> external
// resource). All descriptors below are OPTIONAL on a work item; absent -> prior behaviour. ----

// A1: next-cell priority tiers, admitted in this order (index = priority, lower first).
const ADMISSION_PRIORITY_TIERS = [
  "p0_safety",          // P0 / safety / funds / data-corruption / evidence-pollution
  "unblock_many",       // blocks many downstream cells (source / runtime / provisioning)
  "available_window",   // a currently-open, time-bounded external window
  "current_condition",  // current-condition correctness (baseline / closed-state semantics)
  "capability_data",    // non-condition capability / data / client work
  "readiness_preflight",// read-only / preflight / matrix / readiness
  "formal_gate"         // formal / performance / multi-instance gate
];
const DEFAULT_PRIORITY_TIER = ADMISSION_PRIORITY_TIERS.indexOf("current_condition");

// A2: classification of every non-terminal cell each scan.
const ADMISSIBLE_CELL_CLASSES = new Set([
  "ready_now", "ready_after_resource_admission", "pending_window", "pending_data_volume",
  "blocked_external", "blocked_by_exact_dependency", "diagnostic_only_no_pass", "defer_downstream"
]);

// A6: transient-wait blocker classes that must NEVER escalate a blocked cell to a whole-group block
// (a window/quota/data-volume/verification wait is not a parent block). De-escalation is opt-in: a
// cell must explicitly declare one of these on `blockerClass`; unmarked blocked cells escalate as
// before, preserving prior behaviour. The complementary escalatable root causes are, for reference:
// p0 / safety / funds / data_corruption / shared_resource_uninsulable / evidence_pollution /
// global_infra_down.
const NON_ESCALATING_WAIT_CLASSES = new Set([
  "pending_window", "pending_data_volume", "resource_queued", "external_wait",
  "verification_incomplete", "formal_pass_ineligible", "no_pass_preflight"
]);

// A7: the four worker-carrier options a placement decision must choose among and justify.
const WORKER_CARRIER_MODES = new Set([
  "short_subagent", "reusable_top_level_lane", "new_top_level_lane", "integration_owner_direct"
]);

export function cellAdmissionPriority(workItem) {
  const explicit = workItem.admissionPriorityClass || workItem.priorityClass;
  if (explicit && ADMISSION_PRIORITY_TIERS.includes(explicit)) return ADMISSION_PRIORITY_TIERS.indexOf(explicit);
  if (/p0|safety|funds|corrupt|urgent|critical/u.test(String(workItem.priorityHint || "").toLowerCase())) return 0;
  return DEFAULT_PRIORITY_TIER;
}

// A2/A4: map an admission verdict to a cell class (per (cell, condition) where a condition applies).
export function admissibleCellClass(outcome, reasonCode, workItem) {
  const reason = String(reasonCode || "");
  if (outcome === "selected") return "ready_now";
  if (outcome === "resource_queued") return "ready_after_resource_admission";
  if (outcome === "awaiting_review" || outcome === "awaiting_checkpoint") return "ready_now";
  if (outcome === "superseded") return "defer_downstream";
  // A deferred cell that declares a condition dependency (or whose reason names one) is a window
  // wait — classify off the dependency itself, not a fragile regex over a free-form reason string.
  if (outcome === "deferred") return (workItem?.conditionDependency || /window|condition|market|session/u.test(reason)) ? "pending_window" : "defer_downstream";
  if (outcome === "blocked") {
    if (/window|condition|market|session/u.test(reason)) return "pending_window";
    if (/data_volume|volume/u.test(reason)) return "pending_data_volume";
    if (/external|provider|quota|resource/u.test(reason)) return "blocked_external";
    if (workItem && workItem.diagnosticOnly) return "diagnostic_only_no_pass";
    return "blocked_by_exact_dependency";
  }
  return "defer_downstream";
}

// A5: orthogonal admission dimensions — recorded separately so "why not running" is never conflated
// into one field (condition vs shared-resource vs external-capability vs evidence-qualification).
function admissionDimensions(workItem, outcome) {
  const condition = workItem?.conditionDependency || null;
  return {
    conditionDimension: condition
      ? {source: condition.conditionSource || null, requiredWindowState: condition.requiredWindowState || null, environment: condition.environment || null}
      : null,
    functionDimension: workItem?.taskExecutionClass || null,
    resourceDimension: outcome === "resource_queued"
      ? "external_quota_account"
      : ((workItem?.writeScope || []).length ? "mutable_shared_store" : "read_only_preflight"),
    evidenceQualificationDimension: outcome === "selected" ? "pass"
      : outcome === "resource_queued" ? "resource_queued"
      : outcome === "awaiting_review" ? "verification_incomplete"
      : outcome === "blocked" ? "blocked_external"
      : outcome === "deferred" ? "deferred_condition_mismatch"
      : "pending_window"
  };
}

function recordAdmissionDecision(state, input = {}) {
  state.admissionDecisions ||= [];
  const outcome = ADMISSION_OUTCOMES.has(input.outcome) ? input.outcome : "deferred";
  const workItemId = input.workItem?.id || input.workItemId || "unknown";
  const taskGroupId = input.taskGroup?.id || input.taskGroupId || null;
  const reasonCode = input.reasonCode || null;
  const previous = state.admissionDecisions.find((item) => item.workItemId === workItemId && item.taskGroupId === taskGroupId);
  if (previous && previous.outcome === outcome && previous.reasonCode === reasonCode) return previous;
  const decision = {
    schemaVersion: "admission-decision/v1",
    decisionId: createId("adm"),
    projectId: input.taskGroup?.projectId || input.projectId || "prj_control_plane",
    taskGroupId,
    workItemId,
    candidateRef: `WorkItem:${workItemId}`,
    outcome,
    selected: outcome === "selected",
    deferred: outcome === "deferred",
    blocked: outcome === "blocked",
    resourceQueued: outcome === "resource_queued",
    awaitingReview: outcome === "awaiting_review",
    awaitingCheckpoint: outcome === "awaiting_checkpoint",
    superseded: outcome === "superseded",
    skippedTerminal: outcome === "skipped_terminal",
    cellClass: admissibleCellClass(outcome, reasonCode, input.workItem),
    dimensions: admissionDimensions(input.workItem, outcome),
    reasonCode,
    whyThisCellNow: input.whyThisCellNow || null,
    evidenceQualification: input.evidenceQualification || null,
    workerCarrierDecision: input.workerCarrierDecision || null,
    modelDecisionRef: input.modelDecisionRef || null,
    wakeTrigger: input.wakeTrigger || null,
    sessionId: input.sessionId || null,
    dispatchId: input.dispatchId || null,
    cycleRef: input.cycleRef || null,
    decidedAt: new Date().toISOString()
  };
  const cap = Math.max(50, Number(process.env.AIMAC_ADMISSION_DECISION_CAP || 400));
  state.admissionDecisions = [decision, ...state.admissionDecisions].slice(0, cap);
  return decision;
}

// A8: one cycle-level admission scan per task group per cycle, holding the whole candidate set and
// the deferred/blocked/resource-queued lists together with the resampled condition/resource
// snapshots — the machine-readable record of "what else could run" behind each dispatch decision.
function recordAdmissionScan(state, input = {}) {
  state.admissionScans ||= [];
  const decisions = input.decisions || [];
  const byClass = (predicate) => decisions.filter(predicate).map((decision) => decision.workItemId);
  const scan = {
    schemaVersion: "admission-scan/v1",
    scanId: createId("adms"),
    projectId: input.taskGroup?.projectId || "prj_control_plane",
    taskGroupId: input.taskGroup?.id || null,
    cycleRef: input.cycleRef || null,
    ruleset: "ai-native-control-plane:v1",
    conditionSource: input.conditionSource || null,
    resourceSnapshot: input.resourceSnapshot || null,
    candidateCells: decisions.map((decision) => decision.workItemId),
    selectedCells: byClass((decision) => decision.selected),
    deferredCells: byClass((decision) => decision.deferred),
    blockedCells: byClass((decision) => decision.blocked),
    resourceQueuedCells: byClass((decision) => decision.resourceQueued),
    cellClasses: Object.fromEntries(decisions.map((decision) => [decision.workItemId, decision.cellClass])),
    sampledAt: new Date().toISOString()
  };
  const cap = Math.max(20, Number(process.env.AIMAC_ADMISSION_SCAN_CAP || 200));
  state.admissionScans = [scan, ...state.admissionScans].slice(0, cap);
  return scan;
}

// A3/A9: is this cell gated by an as-yet-unmet external condition window? Returns null when the cell
// declares no condition dependency (so condition-independent cells are NEVER gated by a closed
// window) or when the required window state is currently satisfied. `conditionSource` is resampled
// per cycle by the caller (never inferred from a local clock).
export function conditionWindowGate(workItem, conditionSource) {
  const dependency = workItem?.conditionDependency;
  if (!dependency || !dependency.requiredWindowState) return null;
  const environment = dependency.environment || "default";
  const current = conditionSource?.windowStateByEnvironment?.[environment];
  if (current === undefined || current === null) return null; // unknown -> do not gate (fail-open to progress)
  if (current === dependency.requiredWindowState) return null; // window satisfied
  return {
    environment,
    requiredWindowState: dependency.requiredWindowState,
    currentWindowState: current,
    reasonCode: "condition_window_deferred",
    wakeTrigger: {
      environment,
      nextWindowState: dependency.requiredWindowState,
      conditionSource: dependency.conditionSource || null,
      commandsToRun: dependency.wakeCommands || [],
      reason: "condition_window_reopen"
    }
  };
}

export function runAutonomousCycle(state, request = {}) {
  ensureRuntimeCollections(state, {root: request.root, endpoint: request.endpoint});
  const changed = [];
  const cycleRef = createId("cycle");
  let skillSyncBlocked = false;
  if (request.autoSyncSkills !== false) {
    for (const source of state.skillSources || []) {
      if (source.sourceId === "agency-agents-zh" && source.status !== "active") {
        try {
          syncSkillSource(state, source.sourceId, {root: request.root, runtimeDir: request.runtimeDir});
        } catch (error) {
          const issue = collectRuntimeIssue(state, {
            issueClass: "repeated_integration_conflict",
            issueFingerprint: `skill-sync:${source.sourceId}`,
            affectedComponents: ["skill_registry"],
            evidenceRefs: [`skill-sync-error:${error.message}`],
            sampleRefs: [`skill-sync:${source.sourceId}:${Date.now()}`]
          });
          changed.push({status: "blocked_resource", reason: "skill_source_sync_failed", issueRef: issue.patternId || issue.sampleId});
          // 技能源同步失败只应挡住【派发】，不该把整个周期掐断。原先这里直接 return，位置在
          // consumeQueuedHumanDirectives / expireStaleHumanConfirmations / sweepCommandBus 之前 ——
          // 于是一件无关的外部故障会让【人下达的指令再也不被消费】、确认单超时不再升级、命令总线不再清扫，
          // 而同一次失败还会生成新的阻塞候选项。人的杠杆因此随着一次技能同步失败一起停摆。
          skillSyncBlocked = true;
          break;
        }
      }
    }
  }
  // 自愈与人工通道无论如何都要跑：它们正是"出问题之后人还能不能介入"的依赖。
  consumeQueuedHumanDirectives(state, request);
  expireStaleHumanConfirmations(state);
  expireStaleQueuedDispatches(state);
  maintainWorkerLanes(state);
  expireStaleLeases(state);
  sweepCommandBus(state);
  if (skillSyncBlocked) return {changed, progressSnapshots: computeProgressSnapshots(state).slice(0, 8)};
  const taskGroups = (state.taskGroups || []).filter((taskGroup) => !request.taskGroupId || taskGroup.id === request.taskGroupId);
  // A9: resample the external condition source once per cycle from the request/state — never from a
  // local clock — so window-gated cells are admitted/deferred against a verifiable current baseline.
  const conditionSource = request.conditionSource || state.conditionSource || null;
  for (const taskGroup of taskGroups) {
    if (["closed", "aborted"].includes(taskGroup.status) || ["active_paused_by_freeze", "active_paused_by_control"].includes(taskGroup.goalExecutionStatus)) continue;
    const cycleCandidates = [];
    // A1: admit cells in priority order (a stable sort keeps declared order within a tier). Iterating
    // a snapshot means cells created mid-cycle (e.g. by a split) are picked up on the next cycle.
    const orderedWorkItems = [...(taskGroup.workItems || [])].sort((left, right) => cellAdmissionPriority(left) - cellAdmissionPriority(right));
    for (const workItem of orderedWorkItems) {
      try {
      if (workItem.status === "superseded") continue;
      if (!["verified", "closed"].includes(workItem.status)) cycleCandidates.push(workItem.id);
      if (["verified", "closed"].includes(workItem.status) && workItem.progress >= 100) {
        if (workItem.status === "verified" && needsReviewBackfill(state, taskGroup, workItem)) {
          const backfill = performIndependentReview(state, taskGroup, workItem, request, {backfill: true});
          changed.push({taskGroupId: taskGroup.id, workItemId: workItem.id, status: workItem.status, progress: workItem.progress, awaiting: backfill.verdict === "passed" ? null : "independent_review_backfill", review: backfill});
        }
        continue;
      }
      if (["checkpoint_submitted", "code_complete", "review_requested", "review_passed", "verification_ready"].includes(workItem.status)) {
        const review = performIndependentReview(state, taskGroup, workItem, request);
        if (review.reviewed !== false) {
          recordAdmissionDecision(state, {taskGroup, workItem, outcome: "awaiting_review", reasonCode: "independent_review", whyThisCellNow: "cell_awaiting_independent_review", cycleRef});
          changed.push({taskGroupId: taskGroup.id, workItemId: workItem.id, status: workItem.status, progress: workItem.progress, awaiting: review.verdict === "passed" ? null : "independent_review", review});
          continue;
        }
      }
      // Held cells: a blocked cell must not be auto-resumed with fabricated gate evidence — hold it
      // until its real precondition is satisfied, so dispatchWorkItem never fabricates the gate.
      // - blocked_dependency: resume only when EVERY dependsOnWorkItemRefs target is verified/closed
      //   (enforces analysis->implementation ordering from splitMixedWorkItemIfNeeded).
      // - needs_decision: never auto-admit — it requires an external decision (human/decision-center)
      //   to return to ready, so holding preserves the rework cap and the human-in-the-loop gate.
      if (workItem.status === "blocked_dependency") {
        // A dependency that is superseded (e.g. an abandoned analysis child) can NEVER become
        // verified, so the dependent would be stuck forever with no operator lever (it isn't
        // needs_decision, so resolve_decision can't reach it). Escalate it to needs_decision so the
        // operator can reopen it (with manual input) or abandon it via resolve_decision.
        const abandonedDep = (workItem.dependsOnWorkItemRefs || []).find((depId) => {
          const dependency = (taskGroup.workItems || []).find((item) => item.id === depId);
          return dependency && dependency.status === "superseded";
        });
        if (abandonedDep) {
          workItem.status = "needs_decision";
          workItem.blockedReason = "dependency_abandoned";
          workItem.updatedAt = new Date().toISOString();
          recordAdmissionDecision(state, {taskGroup, workItem, outcome: "blocked", reasonCode: "dependency_abandoned", whyThisCellNow: `dependency ${abandonedDep} was abandoned`, cycleRef});
          addBlocker(taskGroup, "S1", `工作项 ${workItem.id} 的依赖 ${abandonedDep} 已被放弃，需人工决策。`);
          changed.push({taskGroupId: taskGroup.id, workItemId: workItem.id, status: "needs_decision", reason: "dependency_abandoned"});
          continue;
        }
        const unmetDeps = (workItem.dependsOnWorkItemRefs || []).filter((depId) => {
          const dependency = (taskGroup.workItems || []).find((item) => item.id === depId);
          return !dependency || !["verified", "closed"].includes(dependency.status);
        });
        if (unmetDeps.length) {
          recordAdmissionDecision(state, {taskGroup, workItem, outcome: "blocked", reasonCode: "awaiting_dependency", whyThisCellNow: `awaiting dependencies ${unmetDeps.join(",")}`, cycleRef});
          changed.push({taskGroupId: taskGroup.id, workItemId: workItem.id, status: workItem.status, reason: "awaiting_dependency", awaiting: "dependency", dependsOnWorkItemRefs: unmetDeps});
          continue;
        }
      }
      if (workItem.status === "needs_decision") {
        recordAdmissionDecision(state, {taskGroup, workItem, outcome: "blocked", reasonCode: "awaiting_decision", whyThisCellNow: "cell_needs_external_decision", cycleRef});
        changed.push({taskGroupId: taskGroup.id, workItemId: workItem.id, status: workItem.status, reason: "awaiting_decision", awaiting: "decision"});
        continue;
      }
      // 与另外两个调用点同规：只有【在流程中】的契约才算未就绪。上一轮只改了两处、漏了这处，
      // 结果工作项照旧被饿死，而关闭门那边已经不再显示 SharedDefinitionContract 阻塞项 ——
      // 楔死从"可见"变成了"不可见"，比原来更糟。
      const missingDefinition = relatedSharedDefinitions(state, taskGroup, workItem).find((definition) => SHARED_DEFINITION_BLOCKING_STATUSES.includes(definition.status));
      if (missingDefinition) {
        addBlocker(taskGroup, "S1", `共享定义 ${missingDefinition.contractId} 尚未对工作项 ${workItem.id} 生效。`);
        recordAdmissionDecision(state, {taskGroup, workItem, outcome: "blocked", reasonCode: "shared_definition_not_active", whyThisCellNow: `awaiting SharedDefinitionContract:${missingDefinition.contractId}`, cycleRef});
        changed.push({taskGroupId: taskGroup.id, workItemId: workItem.id, status: "blocked_dependency", reason: "shared_definition_not_active", sharedDefinitionRef: missingDefinition.contractId});
        // Always `continue` (never `break`, even in single mode): a cell blocked on an inactive shared
        // definition stays blocked_dependency indefinitely, so breaking here would permanently starve
        // every executable cell behind it. Matches the condition-window gate's per-cell isolation.
        continue;
      }
      const active = activeExecutionForWork(state, taskGroup.id, workItem.id);
      if (active) {
        recordAdmissionDecision(state, {taskGroup, workItem, outcome: "awaiting_checkpoint", reasonCode: "existing_execution_active", whyThisCellNow: "cell_already_executing", cycleRef, sessionId: active.sessionId, dispatchId: active.dispatchId});
        changed.push({
          taskGroupId: taskGroup.id,
          workItemId: workItem.id,
          status: workItem.status,
          progress: workItem.progress,
          sessionId: active.sessionId,
          dispatchId: active.dispatchId,
          awaiting: "awaiting_existing_checkpoint"
        });
        if (request.mode !== "until_blocked" && request.mode !== "all") break;
        continue;
      }
      // A3/A4/A9: defer ONLY cells whose declared condition window is unmet; condition-independent
      // cells and cells for other environments stay admissible. Always `continue` (never `break`) so
      // one closed window can never stop the scan from admitting another cell.
      const windowGate = conditionWindowGate(workItem, conditionSource);
      if (windowGate) {
        workItem.wakeTrigger = windowGate.wakeTrigger;
        recordAdmissionDecision(state, {taskGroup, workItem, outcome: "deferred", reasonCode: windowGate.reasonCode, whyThisCellNow: "cell_deferred_condition_window", cycleRef, wakeTrigger: windowGate.wakeTrigger});
        changed.push({taskGroupId: taskGroup.id, workItemId: workItem.id, status: workItem.status, awaiting: "condition_window", conditionWindow: windowGate});
        continue;
      }
      const split = splitMixedWorkItemIfNeeded(state, taskGroup, workItem);
      // 任何针对这个工作项的重大决策只要还挂着待人工定稿，本轮就不得再派发它。
      // 此前只有 task_split 这一种被拦下，验收/方案拓扑都没拦 —— 于是人还在看"要不要按这个方案跑"
      // 或"这份成果算不算通过"，AI 已经重新拿到写租约把对象改掉了。人的定稿因此落在一个正在被
      // 改写的东西上，而定稿之后互审又会永久跳过该工作项，后续改动再无人复核。
      // 闸门要装在"这个工作项现在能不能被执行"上，而不是装在某一个 API 动作上。
      const blockingMajorConfirmation = (state.humanConfirmationRequests || []).find((request) =>
        request.status === "pending" && request.decisionClass === "major" && request.taskGroupId === taskGroup.id
        && (request.workItemId === workItem.id || request.subjectRef === `WorkItem:${workItem.id}`));
      if (blockingMajorConfirmation) {
        recordAdmissionDecision(state, {taskGroup, workItem, outcome: "deferred", reasonCode: "awaiting_human_confirmation", whyThisCellNow: "cell_held_for_human_confirmation", cycleRef});
        changed.push({taskGroupId: taskGroup.id, workItemId: workItem.id, status: workItem.status, awaiting: "human_confirmation", confirmationRef: blockingMajorConfirmation.requestId});
        continue;
      }
      if (split?.pendingHumanSplitConfirmation) {
        // 拆分方案待人工定稿：本轮不得继续派发这个工作项，否则等于按 AI 自己的方案执行下去。
        recordAdmissionDecision(state, {taskGroup, workItem, outcome: "deferred", reasonCode: "awaiting_human_split_confirmation", whyThisCellNow: "cell_held_for_human_plan_confirmation", cycleRef});
        changed.push({taskGroupId: taskGroup.id, workItemId: workItem.id, status: workItem.status, awaiting: "human_split_confirmation", confirmationRef: split.confirmationRef});
        continue;
      }
      if (split) {
        recordAdmissionDecision(state, {taskGroup, workItem, outcome: "superseded", reasonCode: "mixed_analysis_implementation_split", whyThisCellNow: "cell_split_into_analysis_and_implementation", cycleRef});
        changed.push({taskGroupId: taskGroup.id, workItemId: workItem.id, status: "superseded", reason: "mixed_analysis_implementation_split", derivedWorkItemIds: split.derivedWorkItemIds});
        if (request.mode !== "until_blocked" && request.mode !== "all") break;
        continue;
      }
      let contract;
      try {
        contract = buildTaskContract(state, {projectId: taskGroup.projectId, taskGroupId: taskGroup.id, workItemId: workItem.id, workItem, root: request.root});
      } catch (error) {
        if (error.code !== "AIMAC_MODEL_SELECTION_REJECTED") throw error;
        workItem.status = "blocked_resource";
        workItem.blockedReason = "model_selection_rejected";
        workItem.updatedAt = new Date().toISOString();
        addBlocker(taskGroup, "S1", `没有可运行的模型满足工作项 ${workItem.id} 的硬性约束。`);
        recordAdmissionDecision(state, {taskGroup, workItem, outcome: "blocked", reasonCode: "model_selection_rejected", whyThisCellNow: "no_model_satisfies_hard_constraints", cycleRef, modelDecisionRef: error.decision?.decisionId || null});
        changed.push({taskGroupId: taskGroup.id, workItemId: workItem.id, status: "blocked_resource", reason: "model_selection_rejected", modelSelectionDecisionRef: error.decision?.decisionId});
        continue;
      }
      const repositoryTarget = state.repositoryOutputs.find((target) => target.targetId === contract.repositoryOutputTargetRef);
      const drift = evaluateRoleDrift(state, {sessionId: contract.sessionId, taskGroupId: taskGroup.id, actionScopeRefs: [`TaskGroup:${taskGroup.id}`, `RepositoryOutputTarget:${repositoryTarget.targetId}`]});
      if (!drift.allowed) {
        workItem.status = "needs_decision";
        workItem.blockedReason = "role_drift_guard_blocked";
        addBlocker(taskGroup, "S0", `角色偏移守卫拦截了工作项 ${workItem.id} 的派发。`);
        recordAdmissionDecision(state, {taskGroup, workItem, outcome: "blocked", reasonCode: "role_drift_guard_blocked", whyThisCellNow: "role_drift_guard_intercepted_dispatch", cycleRef});
        changed.push({taskGroupId: taskGroup.id, workItemId: workItem.id, status: "needs_decision", reason: "role_drift_guard_blocked"});
        continue;
      }
      const dispatch = dispatchWorkItem(state, taskGroup, workItem, contract, repositoryTarget);
      const dispatchSession = state.workSessions.find((item) => item.sessionId === contract.sessionId);
      recordAdmissionDecision(state, {
        taskGroup, workItem, outcome: "selected", reasonCode: "dispatched",
        whyThisCellNow: "executable_cell_admitted_this_cycle", cycleRef,
        sessionId: contract.sessionId, dispatchId: dispatch.dispatchId,
        modelDecisionRef: dispatchSession?.modelSelectionDecisionRef || null,
        workerCarrierDecision: dispatchSession?.laneId
          ? {mode: dispatchSession.placement, laneId: dispatchSession.laneId}
          : (dispatchSession?.placement ? {mode: dispatchSession.placement} : null),
        evidenceQualification: {contractDigest: contract.contractDigest || contract.contractId || null, placementDecisionRef: contract.placementDecisionRef || null}
      });
      changed.push({taskGroupId: taskGroup.id, workItemId: workItem.id, status: workItem.status, progress: workItem.progress, sessionId: contract.sessionId, dispatchId: dispatch.dispatchId, awaiting: "agent_runtime_checkpoint"});
      if (request.mode !== "until_blocked" && request.mode !== "all") break;
      } catch (cellError) {
        // Per-cell isolation (global intelligent scheduling): an unexpected error on ONE cell must
        // never abort the cycle — remaining executable cells and other task groups keep running. The
        // failed cell is quarantined to needs_decision so the operator can resolve_decision it.
        workItem.status = "needs_decision";
        workItem.blockedReason = "cell_processing_error";
        workItem.updatedAt = new Date().toISOString();
        addBlocker(taskGroup, "S1", `工作项 ${workItem.id} 处理异常，已隔离待人工决策：${cellError.message}`);
        recordAdmissionDecision(state, {taskGroup, workItem, outcome: "blocked", reasonCode: "cell_processing_error", whyThisCellNow: "cell_processing_error", cycleRef});
        changed.push({taskGroupId: taskGroup.id, workItemId: workItem.id, status: "needs_decision", reason: "cell_processing_error", error: cellError.message});
      }
    }
    // A8: record one cycle-level admission scan holding the latest verdict for every candidate cell
    // seen this cycle (dedup means an unchanged cell keeps its prior decision, so resolve by cell).
    if (cycleCandidates.length) {
      const seen = new Set();
      const scanDecisions = [];
      for (const decision of state.admissionDecisions) {
        if (decision.taskGroupId !== taskGroup.id || seen.has(decision.workItemId) || !cycleCandidates.includes(decision.workItemId)) continue;
        seen.add(decision.workItemId);
        scanDecisions.push(decision);
      }
      recordAdmissionScan(state, {taskGroup, cycleRef, decisions: scanDecisions, conditionSource});
    }
    try {
      recomputeTaskGroup(taskGroup);
      ensureTaskAnalysis(state, taskGroup);
      computeCompletionReadiness(state, taskGroup.id, request);
      computeCloseBarrier(state, taskGroup.id, request);
    } catch (groupError) {
      // Per-task-group isolation: a recompute/readiness/close error on one group must not abort the
      // whole cycle — other task groups still get scheduled and evaluated.
      taskGroup.health = "attention";
      changed.push({taskGroupId: taskGroup.id, status: "attention", reason: "task_group_recompute_error", error: groupError.message});
    }
  }
  computeProgressSnapshots(state);
  appendEvent(state, "progress", "ProgressSnapshot", `cycle:${Date.now()}`, "orchestrator", {changed});
  return {changed, progressSnapshots: state.progressSnapshots.slice(0, 8)};
}

function splitMixedWorkItemIfNeeded(state, taskGroup, workItem) {
  if (workItem.splitFrom || workItem.splitStatus === "split_by_orchestrator") return null;
  const taskExecution = classifyTaskExecution(workItem);
  if (!taskExecution.splitRequired) return null;
  const existingChildren = (taskGroup.workItems || []).filter((item) => item.splitFrom === workItem.id);
  if (existingChildren.length) return {derivedWorkItemIds: existingChildren.map((item) => item.id), existing: true};
  // 任务拆分是核心方案决策：AI 只能【提案】，必须由人定稿后才真正拆。原先这里是自批自吸收
  // （直接改写工作项并写一条 status:"absorbed" 的派生请求），等于 AI 自己决定了"怎么干"。
  const splitLock = workItem.humanFinalization;
  const splitConfirmed = splitLock?.decisionType === "task_split" && splitLock.outcome === "confirmed";
  if (!splitConfirmed) {
    // 人已明确否决过就不再重复打扰；否则挂起一张人工定稿单（requestKey 去重，不会每轮刷屏）。
    if (splitLock?.decisionType === "task_split" && splitLock.outcome === "rejected") return null;
    const proposal = createHumanConfirmationRequest(state, {
      taskGroupId: taskGroup.id,
      workItemId: workItem.id,
      decisionType: "task_split",
      requestKey: `task_split:${workItem.id}`,
      summary: `任务拆分方案确认：${workItem.title || workItem.id}`,
      detail: `该工作项被判定为分析与实现混合（${taskExecution.taskExecutionClass || "mixed"}），建议拆分为「分析」与「实现」两个子项，实现子项依赖分析子项产出。拆分方案需人工定稿后才会执行。`,
      peerReview: {verdict: "split_recommended", findings: [`taskExecutionClass:${taskExecution.taskExecutionClass || "mixed"}`]},
      content: {analysisId: `${workItem.id}_analysis`, implementationId: `${workItem.id}_implementation`},
      options: [
        {optionId: "accept_split", label: "同意拆分为分析＋实现", description: "按建议拆分；定稿后执行且 AI 不再自行调整。", recommended: true},
        {optionId: "reject", label: "不拆分", description: "保持为单个工作项，由人另行安排方案。"}
      ]
    });
    // 方案待定期间必须【拦住】这个工作项：否则它会被照常派发，AI 等于仍在按自己的方案执行。
    if (!["needs_decision", "superseded", "closed", "verified"].includes(workItem.status)) {
      workItem.status = "needs_decision";
      workItem.blockedReason = "awaiting_human_split_confirmation";
      workItem.updatedAt = new Date().toISOString();
    }
    // 返回"已挂起"信号，调用方据此跳过本项（返回 null 会让编排继续往下派发，等于绕过了闸门）。
    return {pendingHumanSplitConfirmation: true, confirmationRef: proposal.requestId};
  }
  const at = new Date().toISOString();
  const baseRequirements = workItem.requirements || [];
  const analysis = {
    id: `${workItem.id}_analysis`,
    title: `${workItem.title} - analysis`,
    status: "ready",
    ownerRole: analysisRoleFor(workItem.ownerRole),
    progress: 0,
    taskExecutionClass: "deep_analysis",
    splitFrom: workItem.id,
    requirements: unique([...baseRequirements, "Produce bounded analysis, architecture decisions, risk notes and implementation inputs. Do not modify repository code."]),
    createdAt: at,
    updatedAt: at
  };
  const implementation = {
    id: `${workItem.id}_implementation`,
    title: `${workItem.title} - implementation`,
    status: "blocked_dependency",
    blockedReason: "awaiting_analysis_output",
    ownerRole: workItem.ownerRole || "agent-runtime",
    progress: 0,
    taskExecutionClass: "implementation",
    splitFrom: workItem.id,
    dependsOnWorkItemRefs: [analysis.id],
    requirements: unique([...baseRequirements, `Use analysis output from WorkItem:${analysis.id} as input before writing code.`]),
    createdAt: at,
    updatedAt: at
  };
  taskGroup.workItems.push(analysis, implementation);
  workItem.status = "superseded";
  workItem.splitStatus = "split_by_orchestrator";
  workItem.progress = Math.max(Number(workItem.progress || 0), 1);
  workItem.updatedAt = at;
  state.derivedTaskRequests ||= [];
  // Conforms to derived-task-request.schema.json. The mixed work item is absorbed in place into an
  // analysis->implementation split (a topology replan); the implementation is linked via its
  // dependsOnWorkItemRefs on the analysis item recorded in createdWorkItemRef.
  state.derivedTaskRequests.unshift({
    schemaVersion: "derived-task-request/v1",
    requestId: createId("dtr"),
    projectId: taskGroup.projectId,
    taskGroupId: taskGroup.id,
    sourceRef: `WorkItem:${workItem.id}`,
    reason: "topology_replan",
    proposedInsertionMode: "current_absorb",
    topologyEffect: "requires_replan",
    summary: `混合分析/实现工作项 ${workItem.id} 拆分为分析与实现子项`,
    evidenceRef: `WorkItem:${workItem.id}`,
    actionBasisRef: `decision:mixed-split:${workItem.id}`,
    status: "absorbed",
    // 指向真实的人工定稿确认单（原先是自己拼的 decision:mixed-split:<id> 假引用，没有任何外部权威）。
    decisionRecordRef: splitLock.confirmationRef || `decision:mixed-split:${workItem.id}`,
    createdWorkItemRef: analysis.id,
    auditRef: `audit:dtr:${workItem.id}`,
    createdAt: at,
    updatedAt: at
  });
  state.derivedTaskRequests = capRetainingPredicate(state.derivedTaskRequests, (item) => DERIVED_TASK_REQUEST_PENDING_STATUSES.includes(item.status), 2000);
  appendEvent(state, "derived_task_created", "WorkItem", workItem.id, "orchestrator", {derivedWorkItemRefs: [analysis.id, implementation.id], taskExecutionClass: taskExecution.taskExecutionClass});
  return {derivedWorkItemIds: [analysis.id, implementation.id]};
}

function analysisRoleFor(roleId) {
  if (["security", "policy-engine"].includes(roleId)) return "security";
  if (["reviewer", "qa", "release"].includes(roleId)) return "reviewer";
  return "orchestrator";
}

function dispatchWorkItem(state, taskGroup, workItem, contract, repositoryTarget) {
  const at = new Date().toISOString();
  if (BLOCKED_WORKITEM_STATUSES.includes(workItem.status)) {
    // Resume to "ready" through the modeled actor for the blocked status. The precondition was
    // already judged by runAutonomousCycle's reality-first admission (deps verified, model runnable,
    // no active execution, needs_decision held) — so record only the real resume ref, not a
    // synthesized per-gate "evidence" token (absorbed from MGP core-init: no ceremonial evidence).
    const modeled = canonicalTransition("WorkItem", workItem.status, "ready");
    recordTransition(state, "WorkItem", workItem.id, workItem.status, "ready", modeled?.actor || "orchestrator", {resumed_from: workItem.blockedReason || "unblocked"});
    workItem.status = "ready";
    delete workItem.blockedReason;
  }
  if (contract.writeScope.length) {
    const lease = ensureLease(state, repositoryTarget, `session:${contract.sessionId}`, contract.contractDigest);
    repositoryTarget.status = "lease_bound";
    repositoryTarget.leaseRef = lease.leaseId;
  } else {
    repositoryTarget.status = "selected";
  }
  repositoryTarget.updatedAt = at;
  if (workItem.status === "draft") {
    // Record only the genuine contract refs produced this dispatch; omit fabricated placeholders.
    recordTransition(state, "WorkItem", workItem.id, "draft", "ready", "orchestrator", {
      task_contract_created: contract.contractDigest || contract.contractId,
      effective_instruction_packet_ref: contract.effectiveInstructionPacketRef,
      repository_output_target_ref: contract.repositoryOutputTargetRef,
      shared_definition_refs_resolved: contract.sharedDefinitionRefs?.length ? contract.sharedDefinitionRefs.join(",") : undefined,
      split_basis_digest: contract.splitBasisDigest || undefined
    });
    workItem.status = "ready";
  }
  if (workItem.status === "ready") {
    recordTransition(state, "WorkItem", workItem.id, "ready", "assigned", "scheduler", {
      agent_selected: contract.roleId,
      model_selected: contract.modelSelectionDecisionRef,
      session_placement_selected: contract.placementDecisionRef,
      lease_admitted: repositoryTarget.leaseRef || undefined
    });
    workItem.status = "assigned";
  }
  workItem.progress = Math.max(Number(workItem.progress || 0), 5);
  workItem.repositoryOutputTargetRef = repositoryTarget.targetId;
  ensureTaskGroupRole(state, taskGroup, contract.roleId, "auto");
  taskGroup.goalExecutionStatus = "active";
  const dispatch = enqueueAgentDispatch(state, contract, repositoryTarget);
  appendEvent(state, "command_dispatched", "WorkSession", contract.sessionId, "orchestrator", {projectId: taskGroup.projectId, taskGroupId: taskGroup.id, workItemId: workItem.id, sessionId: contract.sessionId, dispatchId: dispatch.dispatchId});
  return dispatch;
}

export function acceptAgentCheckpoint(state, checkpointInput = {}, request = {}) {
  ensureRuntimeCollections(state);
  const taskGroup = state.taskGroups.find((item) => item.id === checkpointInput.taskGroupId);
  const workItem = taskGroup?.workItems?.find((item) => item.id === checkpointInput.workId);
  if (!taskGroup || !workItem) {
    return {accepted: false, status: 404, error: "work_item_not_found"};
  }
  const session = state.workSessions.find((item) => item.sessionId === checkpointInput.sessionId);
  if (!session || session.workItemId !== workItem.id) {
    return {accepted: false, status: 409, error: "session_work_item_mismatch"};
  }
  if (!checkpointInput.runId) {
    return {accepted: false, status: 409, error: "checkpoint_run_id_required"};
  }
  const dispatch = (state.agentDispatches || []).find((item) =>
    item.sessionId === session.sessionId &&
    item.taskGroupId === taskGroup.id &&
    item.workItemId === workItem.id &&
    item.runId === checkpointInput.runId
  );
  if (!dispatch || dispatch.status !== "running") {
    return {accepted: false, status: 409, error: "active_agent_dispatch_required"};
  }
  if (checkpointInput.runId && checkpointInput.runId !== dispatch.runId) {
    return {accepted: false, status: 409, error: "checkpoint_run_id_mismatch"};
  }
  if (checkpointInput.taskContractDigest && checkpointInput.taskContractDigest !== dispatch.taskContractDigest) {
    return {accepted: false, status: 409, error: "checkpoint_task_contract_digest_mismatch"};
  }
  const contract = state.agentTaskContracts.find((item) => item.sessionId === session.sessionId && item.workId === workItem.id && item.runId === dispatch.runId);
  if (!contract || contract.contractDigest !== dispatch.taskContractDigest) {
    return {accepted: false, status: 409, error: "agent_dispatch_contract_mismatch"};
  }
  const expectedLanguagePolicyDigest = contract.languagePolicyDigest || digestOf(normalizeTaskGroupLanguagePolicy(taskGroup.languagePolicy));
  if (contract.languagePolicyDigest) {
    if (!checkpointInput.languagePolicyDigest) {
      return {accepted: false, status: 409, error: "checkpoint_language_policy_digest_required"};
    }
    if (checkpointInput.languagePolicyDigest !== expectedLanguagePolicyDigest) {
      return {accepted: false, status: 409, error: "checkpoint_language_policy_digest_mismatch"};
    }
  } else if (checkpointInput.languagePolicyDigest && checkpointInput.languagePolicyDigest !== expectedLanguagePolicyDigest) {
    return {accepted: false, status: 409, error: "checkpoint_language_policy_digest_mismatch"};
  }
  const drift = evaluateRoleDrift(state, {sessionId: checkpointInput.sessionId, taskGroupId: taskGroup.id, actionScopeRefs: (checkpointInput.repositoryOutputTargetRefs || []).map((ref) => `RepositoryOutputTarget:${ref}`)});
  if (!drift.allowed) {
    return {accepted: false, status: 409, error: "role_drift_guard_not_clear"};
  }
  const guard = state.roleDriftGuards.find((item) => item.sessionId === checkpointInput.sessionId);
  const targetRefs = checkpointInput.repositoryOutputTargetRefs || [];
  const target = state.repositoryOutputs.find((item) => targetRefs.includes(item.targetId));
  if (!target) {
    return {accepted: false, status: 409, error: "repository_output_target_missing"};
  }
  if (targetRefs.length !== 1 || targetRefs[0] !== target.targetId) {
    return {accepted: false, status: 409, error: "repository_output_target_refs_must_match_single_session_target"};
  }
  if (!checkpointInput.commitRefs?.length || !checkpointInput.pushRefs?.length || !checkpointInput.artifactManifestRefs?.length || !checkpointInput.changedPathEvidenceRefs?.length) {
    return {accepted: false, status: 409, error: "checkpoint_missing_git_evidence"};
  }
  if (!checkpointInput.artifactManifestRefs.every(canUseGitPath)) {
    return {accepted: false, status: 400, error: "artifact_manifest_must_be_git_trackable"};
  }
  const evidence = validateCheckpointGitEvidence(state, {taskGroup, workItem, session, dispatch, target, checkpointInput, root: request.root || request.repositoryRoot || process.cwd()});
  if (!evidence.valid) {
    return {accepted: false, status: evidence.status || 409, error: evidence.error};
  }
  const at = new Date().toISOString();
  const checkpoint = {
    schemaVersion: "checkpoint/v1",
    projectId: taskGroup.projectId,
    taskGroupId: taskGroup.id,
    workId: workItem.id,
    sessionId: checkpointInput.sessionId,
    runId: dispatch.runId,
    stateVersion: state.stateVersion,
    summary: checkpointInput.summary || `${workItem.title} checkpoint submitted by Agent Runtime.`,
    nextSteps: checkpointInput.nextSteps || [{actionId: "none", mode: "none", summary: "No follow-up action remains for this work item.", evidenceRefs: ["evidence:agent-runtime-verified"]}],
    openMachineActionIds: checkpointInput.openMachineActionIds || [],
    derivedWorkRequests: checkpointInput.derivedWorkRequests || [],
    returnPointRef: checkpointInput.returnPointRef || `return:${checkpointInput.sessionId}`,
    commitRefs: evidence.normalizedCommitRefs,
    pushRefs: evidence.normalizedPushRefs,
    repositoryOutputTargetRefs: targetRefs,
    artifactManifestRefs: checkpointInput.artifactManifestRefs,
    changedPathEvidenceRefs: checkpointInput.changedPathEvidenceRefs,
    evidenceRefs: unique([...(checkpointInput.evidenceRefs || ["evidence:agent-runtime-checkpoint"]), evidence.evidenceRef]),
    languagePolicyDigest: expectedLanguagePolicyDigest,
    outputContractDigest: checkpointInput.outputContractDigest || specContentDigest("spec/checkpoint.schema.json"),
    createdAt: checkpointInput.createdAt || at
  };
  state.checkpoints.unshift(checkpoint);
  target.status = "pushed";
  target.commitRefs = evidence.normalizedCommitRefs.map((commit) => `commit:${commit.commit}`);
  target.pushRefs = evidence.normalizedPushRefs.map((push) => `push:${push.remote}/${push.ref}:${push.remoteSha}`);
  target.changedPaths = evidence.changedPaths;
  target.artifactManifestPath = checkpoint.artifactManifestRefs[0];
  target.updatedAt = at;
  if (target.leaseRef) {
    const lease = state.leases.find((item) => item.leaseId === target.leaseRef);
    if (lease) {
      lease.status = "released";
      lease.updatedAt = at;
    }
  }
  session.status = "completed_objective";
  session.completedAt = at;
  session.updatedAt = at;
  session.checkpointRef = `checkpoint:${checkpoint.runId}`;
  if (guard) {
    guard.status = "closed";
    guard.updatedAt = at;
  }
  advanceWorkItemToReviewRequested(state, workItem, checkpoint);
  workItem.progress = Math.max(Number(workItem.progress || 0), 95);
  if (dispatch) {
    dispatch.status = "completed";
    dispatch.completedAt = at;
    dispatch.updatedAt = at;
    dispatch.checkpointRef = `checkpoint:${checkpoint.runId}`;
  }
  recomputeTaskGroup(taskGroup);
  ensureTaskAnalysis(state, taskGroup);
  appendEvent(state, "checkpoint_submitted", "Checkpoint", `${checkpoint.taskGroupId}:${checkpoint.workId}:${checkpoint.runId}`, session.roleId, checkpoint);
  // Gap #3: the accepted checkpoint carries a real external side effect (the verified git push).
  // Record it through the command bus so a CommandEffect is emitted and reconciled to `verified`
  // — this is what makes the close-barrier command-effect gate a live check rather than vacuous.
  const push = evidence.normalizedPushRefs?.at(-1);
  runCommandLifecycle(state, {
    type: "repository_push",
    subject: `TaskGroup:${taskGroup.id}`,
    projectId: taskGroup.projectId,
    taskGroupId: taskGroup.id,
    idempotencyKey: `cmd:checkpoint:${checkpoint.runId}`,
    resultRef: `checkpoint:${checkpoint.runId}`,
    sideEffect: {
      taskGroupId: taskGroup.id,
      projectId: taskGroup.projectId,
      externalOperationId: push?.providerOperationId || `git-push:${dispatch.dispatchId}:${checkpoint.runId}`,
      fencingToken: target.leaseRef || `fence:${target.targetId}`,
      beforeDigest: digestOf({target: target.targetId, before: dispatch.taskContractDigest || checkpoint.runId}),
      afterDigest: push?.remoteSha ? `sha256:${String(push.remoteSha).padEnd(64, "0").slice(0, 64)}` : digestOf({target: target.targetId, after: checkpoint.runId}),
      resultRef: `checkpoint:${checkpoint.runId}`,
      effectVerifyEvidence: `effect_verify_evidence:checkpoint:${checkpoint.runId}`
    }
  });
  return {accepted: true, status: 201, checkpoint};
}

export function runAgentRuntimeWorker(state, request = {}) {
  ensureRuntimeCollections(state, {root: request.root, endpoint: request.endpoint});
  if (state.runtime?.executionProfile !== "verification") {
    return {
      results: [],
      blocked: true,
      reason: "server_side_agent_execution_forbidden",
      required: "registered Agent Runtime must claim the dispatch through Agent Gateway"
    };
  }
  const root = request.repositoryRoot || request.root || process.cwd();
  const maxJobs = Number(request.maxJobs || 1);
  const results = [];
  const runnable = (state.agentDispatches || [])
    .filter((dispatch) => (!request.taskGroupId || dispatch.taskGroupId === request.taskGroupId) && ["queued", "blocked"].includes(dispatch.status))
    .slice(0, maxJobs);
  for (const dispatch of runnable) {
    const taskGroup = state.taskGroups.find((item) => item.id === dispatch.taskGroupId);
    const workItem = taskGroup?.workItems?.find((item) => item.id === dispatch.workItemId);
    const session = state.workSessions.find((item) => item.sessionId === dispatch.sessionId);
    const target = state.repositoryOutputs.find((item) => item.targetId === dispatch.repositoryOutputTargetRef);
    if (!taskGroup || !workItem || !session || !target) {
      markDispatchFailed(state, dispatch, "dispatch_binding_missing");
      results.push({dispatchId: dispatch.dispatchId, status: "failed", reason: "dispatch_binding_missing"});
      continue;
    }
    const drift = evaluateRoleDrift(state, {sessionId: dispatch.sessionId, taskGroupId: dispatch.taskGroupId, actionScopeRefs: [`TaskGroup:${dispatch.taskGroupId}`, `RepositoryOutputTarget:${target.targetId}`]});
    if (!drift.allowed) {
      markDispatchFailed(state, dispatch, "role_drift_guard_blocked");
      addBlocker(taskGroup, "S0", `角色偏移守卫拦截了工作项 ${workItem.id} 的运行时工作循环。`);
      results.push({dispatchId: dispatch.dispatchId, status: "failed", reason: "role_drift_guard_blocked"});
      continue;
    }
    const deterministicLocalWorker = request.allowDeterministicLocalWorker === true &&
      state.runtime?.executionProfile === "verification" &&
      existsSync(join(root, ".aimac-verification-repository"));
    const hasRuntimeCredential = dispatch.requiredCredentialEnvNames.length === 0 || dispatch.requiredCredentialEnvNames.some((name) => Boolean(process.env[name]));
    if (!deterministicLocalWorker && !hasRuntimeCredential) {
      markDispatchBlocked(state, dispatch, "credential_required");
      workItem.status = "permission_required";
      workItem.blockedReason = "credential_required";
      addBlocker(taskGroup, "S1", `执行需要智能体运行时凭据：${dispatch.requiredCredentialEnvNames.join(" 或 ")}。`);
      results.push({dispatchId: dispatch.dispatchId, status: "blocked", reason: "credential_required", requiredCredentialEnvNames: dispatch.requiredCredentialEnvNames});
      continue;
    }
    if (!deterministicLocalWorker && !process.env.AIMAC_AGENT_RUNTIME_EXECUTOR_COMMAND) {
      markDispatchBlocked(state, dispatch, "agent_runtime_executor_required");
      workItem.status = "blocked_resource";
      workItem.blockedReason = "agent_runtime_executor_required";
      addBlocker(taskGroup, "S1", "由供应商模型执行需要配置智能体运行时执行器命令。");
      results.push({dispatchId: dispatch.dispatchId, status: "blocked", reason: "agent_runtime_executor_required"});
      continue;
    }
    dispatch.status = "running";
    dispatch.attempts += 1;
    dispatch.updatedAt = new Date().toISOString();
    session.status = "active";
    session.updatedAt = dispatch.updatedAt;
    if (workItem.status === "assigned") {
      recordTransition(state, "WorkItem", workItem.id, "assigned", "in_progress", "work-session", {
        task_contract_valid: dispatch.contractRef || `contract:${dispatch.runId}`,
        repository_output_target_bound: target.targetId
      });
      workItem.status = "in_progress";
    }
    workItem.progress = Math.max(Number(workItem.progress || 0), 35);
    try {
      const checkpointInput = deterministicLocalWorker
        ? runLocalGitArtifactWorker(state, {dispatch, taskGroup, workItem, session, target, root})
        : runExecutorBackedAgentWorker(state, {dispatch, taskGroup, workItem, session, target, root});
      const accepted = acceptAgentCheckpoint(state, checkpointInput, {root});
      if (!accepted.accepted) {
        markDispatchFailed(state, dispatch, accepted.error || "checkpoint_rejected");
        results.push({dispatchId: dispatch.dispatchId, status: "failed", reason: accepted.error || "checkpoint_rejected"});
        continue;
      }
      results.push({dispatchId: dispatch.dispatchId, status: "completed", checkpoint: accepted.checkpoint.runId});
    } catch (error) {
      markDispatchFailed(state, dispatch, error.message);
      results.push({dispatchId: dispatch.dispatchId, status: "failed", reason: error.message});
    }
  }
  computeProgressSnapshots(state);
  appendEvent(state, "progress", "AgentDispatch", `worker:${Date.now()}`, "agent-runtime", {results});
  return {results, progressSnapshots: state.progressSnapshots.slice(0, 8)};
}

function runLocalGitArtifactWorker(state, request) {
  const {dispatch, taskGroup, workItem, session, target, root} = request;
  const at = new Date().toISOString();
  const workerContract = state.agentTaskContracts.find((item) => item.sessionId === session.sessionId && item.runId === dispatch.runId);
  const languagePolicy = workerContract?.languagePolicy || normalizeTaskGroupLanguagePolicy(taskGroup.languagePolicy);
  const languagePolicyDigest = workerContract?.languagePolicyDigest || digestOf(languagePolicy);
  const manifestPath = target.artifactManifestPath || `docs/artifact-manifests/${workItem.id}.json`;
  const outputPath = `docs/agent-runtime-output/${taskGroup.id}/${workItem.id}.md`;
  if (!canUseGitPath(manifestPath)) throw new Error("artifact_manifest_must_be_git_trackable");
  if (!pathMatchesAllowlist(manifestPath, target.pathAllowlist || [])) throw new Error("artifact_manifest_outside_allowlist");
  if (!pathMatchesAllowlist(outputPath, target.pathAllowlist || [])) throw new Error("agent_runtime_output_outside_allowlist");
  if (gitStatusPaths(root).length) throw new Error("agent_runtime_worker_requires_clean_worktree");
  mkdirSync(join(root, dirname(manifestPath)), {recursive: true});
  mkdirSync(join(root, dirname(outputPath)), {recursive: true});
  writeFileSync(join(root, outputPath), [
    `# ${workItem.id}`,
    "",
    `TaskGroup: ${taskGroup.id}`,
    `Session: ${session.sessionId}`,
    `Dispatch: ${dispatch.dispatchId}`,
    `LanguagePolicy: ${languagePolicy.languageTag}`,
    ""
  ].join("\n"));
  const manifest = {
    schemaVersion: "artifact-manifest/v1",
    projectId: taskGroup.projectId,
    taskGroupId: taskGroup.id,
    workId: workItem.id,
    sessionId: session.sessionId,
    dispatchId: dispatch.dispatchId,
    repositoryOutputTargetRefs: [target.targetId],
    taskContractDigest: dispatch.taskContractDigest,
    languagePolicy,
    languagePolicyDigest,
    outputPolicy: "project_git_repository_only",
    generatedBy: "agent-runtime",
    outputRefs: [outputPath],
    evidence: {
      baseRef: target.baseRef,
      pathAllowlist: target.pathAllowlist || [],
      checkpointRequired: true
    },
    createdAt: at
  };
  writeFileSync(join(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  if (!git(root, ["config", "user.email"], "")) gitStrict(root, ["config", "user.email", "agent-runtime@local"]);
  if (!git(root, ["config", "user.name"], "")) gitStrict(root, ["config", "user.name", "AI Agent Runtime"]);
  gitStrict(root, ["add", manifestPath, outputPath]);
  const hasStaged = git(root, ["diff", "--cached", "--name-only"], "");
  if (!hasStaged) throw new Error("agent_runtime_no_git_changes");
  gitStrict(root, ["commit", "-m", `Add AI runtime artifact manifest for ${workItem.id}`]);
  const commit = gitStrict(root, ["rev-parse", "HEAD"]);
  const branch = git(root, ["branch", "--show-current"], target.branch || "main") || target.branch || "main";
  const treeDigest = `git-tree:${gitStrict(root, ["rev-parse", `${commit}^{tree}`])}`;
  gitStrict(root, ["push", "origin", `HEAD:refs/heads/${branch}`]);
  const remoteSha = gitRemoteSha(root, "origin", `refs/heads/${branch}`);
  if (remoteSha !== commit) throw new Error("agent_runtime_push_remote_sha_mismatch");
  return {
    projectId: taskGroup.projectId,
    taskGroupId: taskGroup.id,
    workId: workItem.id,
    sessionId: session.sessionId,
    runId: dispatch.runId,
    taskContractDigest: dispatch.taskContractDigest,
    languagePolicyDigest,
    summary: `${workItem.title} completed by Agent Runtime worker.`,
    commitRefs: [{repo: target.repositoryId, branch, commit, treeDigest, createdAt: at}],
    pushRefs: [{repo: target.repositoryId, remote: "origin", ref: `refs/heads/${branch}`, sourceCommit: commit, remoteSha, providerOperationId: `git-push:${dispatch.dispatchId}:${remoteSha}`, verifiedAt: new Date().toISOString(), rewriteRelation: "same_commit"}],
    repositoryOutputTargetRefs: [target.targetId],
    artifactManifestRefs: [manifestPath],
    changedPathEvidenceRefs: [`git-diff:${target.baseRef}:${commit}`, `git-path:${manifestPath}`, `git-path:${outputPath}`],
    evidenceRefs: [`agent-dispatch:${dispatch.dispatchId}`, `artifact-manifest:${manifestPath}`]
  };
}

function runExecutorBackedAgentWorker(state, request) {
  const {dispatch, taskGroup, workItem, session, target, root} = request;
  const contract = state.agentTaskContracts.find((item) => item.sessionId === session.sessionId && item.workId === workItem.id);
  if (!contract) throw new Error("task_contract_missing_for_executor");
  const command = process.env.AIMAC_AGENT_RUNTIME_EXECUTOR_COMMAND;
  if (gitStatusPaths(root).length) throw new Error("agent_runtime_executor_requires_clean_worktree");
  const input = {
    schemaVersion: "agent-runtime-executor-input/v1",
    repositoryRoot: root,
    projectId: taskGroup.projectId,
    taskGroupId: taskGroup.id,
    workId: workItem.id,
    sessionId: session.sessionId,
    dispatchId: dispatch.dispatchId,
    model: contract.model,
    languagePolicy: contract.languagePolicy,
    languagePolicyDigest: contract.languagePolicyDigest,
    roleSkill: contract.roleSkill,
    taskContract: contract,
    repositoryOutputTarget: target,
    requiredOutputs: ["git_changes", "artifact_manifest", "commit", "push", "checkpoint_evidence"]
  };
  const result = spawnSync(command, {
    cwd: root,
    input: `${JSON.stringify(input)}\n`,
    encoding: "utf8",
    shell: true,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.error) throw new Error(`agent_runtime_executor_failed:${result.error.message}`);
  if (result.status !== 0) throw new Error(`agent_runtime_executor_failed:${(result.stderr || result.stdout || "").trim().slice(0, 300)}`);
  let output;
  try {
    output = JSON.parse((result.stdout || "").trim());
  } catch {
    throw new Error("agent_runtime_executor_output_not_json");
  }
  if (!Array.isArray(output.artifactManifestRefs) || output.artifactManifestRefs.length === 0) throw new Error("agent_runtime_executor_missing_artifact_manifest_refs");
  const gitOutputPaths = unique([...(output.changedPaths || []), ...output.artifactManifestRefs]);
  const changedByExecutor = gitStatusPaths(root);
  const undeclaredChanges = changedByExecutor.filter((changedPath) => !gitOutputPaths.includes(changedPath));
  if (undeclaredChanges.length) throw new Error(`agent_runtime_executor_undeclared_changes:${undeclaredChanges.slice(0, 5).join(",")}`);
  const missingDeclaredChanges = gitOutputPaths.filter((outputPath) => !changedByExecutor.includes(outputPath));
  if (missingDeclaredChanges.length) throw new Error(`agent_runtime_executor_declared_unchanged_paths:${missingDeclaredChanges.slice(0, 5).join(",")}`);
  for (const outputPath of gitOutputPaths) {
    if (!canUseGitPath(outputPath) || !pathMatchesAllowlist(outputPath, target.pathAllowlist || [])) throw new Error("agent_runtime_executor_output_outside_allowlist");
  }
  for (const manifestPath of output.artifactManifestRefs) {
    if (!canUseGitPath(manifestPath) || !pathMatchesAllowlist(manifestPath, target.pathAllowlist || [])) throw new Error("agent_runtime_executor_manifest_outside_allowlist");
  }
  gitStrict(root, ["add", ...gitOutputPaths]);
  const hasStaged = git(root, ["diff", "--cached", "--name-only"], "");
  if (!hasStaged) throw new Error("agent_runtime_executor_no_git_changes");
  gitStrict(root, ["commit", "-m", output.commitMessage || `Apply AI agent output for ${workItem.id}`]);
  const commit = gitStrict(root, ["rev-parse", "HEAD"]);
  if (gitStatusPaths(root).length) throw new Error("agent_runtime_executor_uncommitted_changes_after_commit");
  const branch = git(root, ["branch", "--show-current"], target.branch || "main") || target.branch || "main";
  const treeDigest = `git-tree:${gitStrict(root, ["rev-parse", `${commit}^{tree}`])}`;
  gitStrict(root, ["push", "origin", `HEAD:refs/heads/${branch}`]);
  const remoteSha = gitRemoteSha(root, "origin", `refs/heads/${branch}`);
  if (remoteSha !== commit) throw new Error("agent_runtime_executor_push_remote_sha_mismatch");
  return {
    projectId: taskGroup.projectId,
    taskGroupId: taskGroup.id,
    workId: workItem.id,
    sessionId: session.sessionId,
    runId: dispatch.runId,
    taskContractDigest: dispatch.taskContractDigest,
    languagePolicyDigest: contract.languagePolicyDigest,
    summary: output.summary || `${workItem.title} completed by executor-backed Agent Runtime.`,
    commitRefs: [{repo: target.repositoryId, branch, commit, treeDigest, createdAt: new Date().toISOString()}],
    pushRefs: [{repo: target.repositoryId, remote: "origin", ref: `refs/heads/${branch}`, sourceCommit: commit, remoteSha, providerOperationId: output.providerOperationId || `git-push:${dispatch.dispatchId}:${remoteSha}`, verifiedAt: new Date().toISOString(), rewriteRelation: "same_commit"}],
    repositoryOutputTargetRefs: [target.targetId],
    artifactManifestRefs: output.artifactManifestRefs,
    changedPathEvidenceRefs: [`git-diff:${target.baseRef}:${commit}`, ...gitOutputPaths.map((outputPath) => `git-path:${outputPath}`)],
    evidenceRefs: unique([`agent-dispatch:${dispatch.dispatchId}`, `agent-executor:${digestOf(command)}`, ...(output.evidenceRefs || [])])
  };
}

function validateCheckpointGitEvidence(state, request) {
  const {taskGroup, workItem, session, dispatch, target, checkpointInput, root} = request;
  if (target.projectId !== taskGroup.projectId || target.taskGroupId !== taskGroup.id || target.workItemId !== workItem.id) {
    return {valid: false, status: 409, error: "repository_output_target_scope_mismatch"};
  }
  if (target.status === "pushed") return {valid: false, status: 409, error: "repository_output_target_already_pushed"};
  const lease = state.leases.find((item) => item.leaseId === target.leaseRef);
  if (!lease || lease.status !== "active" || lease.resourceRef !== `RepositoryOutputTarget:${target.targetId}` || lease.holderRef !== `session:${session.sessionId}`) {
    return {valid: false, status: 409, error: "active_session_lease_required"};
  }
  const normalizedCommitRefs = [];
  for (const commitRef of checkpointInput.commitRefs || []) {
    if (commitRef.repo !== target.repositoryId || commitRef.branch !== target.branch) {
      return {valid: false, status: 409, error: "commit_ref_target_mismatch"};
    }
    const fullCommit = git(root, ["rev-parse", "--verify", `${commitRef.commit}^{commit}`], "");
    if (!fullCommit) return {valid: false, status: 409, error: "commit_ref_not_found"};
    normalizedCommitRefs.push({...commitRef, commit: fullCommit});
  }
  const commitSet = new Set(normalizedCommitRefs.map((item) => item.commit));
  const finalCommit = normalizedCommitRefs.at(-1)?.commit;
  if (!finalCommit) return {valid: false, status: 409, error: "commit_ref_not_found"};
  const normalizedPushRefs = [];
  for (const pushRef of checkpointInput.pushRefs || []) {
    if (pushRef.repo !== target.repositoryId || pushRef.remote !== (target.remote || "origin") || pushRef.ref !== `refs/heads/${target.branch}` || !commitSet.has(git(root, ["rev-parse", "--verify", `${pushRef.sourceCommit}^{commit}`], ""))) {
      return {valid: false, status: 409, error: "push_ref_target_mismatch"};
    }
    const configuredRemoteUrl = gitRemoteUrl(root, pushRef.remote);
    if (target.repositoryUrl && configuredRemoteUrl && normalizeGitRemoteUrl(configuredRemoteUrl) !== normalizeGitRemoteUrl(target.repositoryUrl)) {
      return {valid: false, status: 409, error: "push_ref_remote_repository_mismatch"};
    }
    const liveRemoteSha = gitRemoteSha(root, pushRef.remote, pushRef.ref);
    const recordedRemoteSha = git(root, ["rev-parse", "--verify", `${pushRef.remoteSha}^{commit}`], "");
    if (!liveRemoteSha || !recordedRemoteSha) {
      return {valid: false, status: 409, error: "push_ref_remote_sha_mismatch"};
    }
    let remoteAdvancedContained = false;
    if (liveRemoteSha !== recordedRemoteSha) {
      if (!gitIsAncestor(root, recordedRemoteSha, liveRemoteSha)) {
        return {valid: false, status: 409, error: "push_ref_remote_sha_mismatch"};
      }
      remoteAdvancedContained = true;
    }
    const sourceCommit = git(root, ["rev-parse", "--verify", `${pushRef.sourceCommit}^{commit}`]);
    if (recordedRemoteSha !== sourceCommit || recordedRemoteSha !== finalCommit) {
      return {valid: false, status: 409, error: "push_ref_must_point_to_final_commit"};
    }
    normalizedPushRefs.push({...pushRef, sourceCommit, remoteSha: recordedRemoteSha, ...(remoteAdvancedContained ? {remoteAdvancedContained: true, observedRemoteSha: liveRemoteSha} : {})});
  }
  const changedPaths = git(root, ["diff", "--name-only", target.baseRef || `${finalCommit}^`, finalCommit], "")
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!changedPaths.length) return {valid: false, status: 409, error: "checkpoint_commit_has_no_changed_paths"};
  if (!changedPaths.every((path) => canUseGitPath(path) && pathMatchesAllowlist(path, target.pathAllowlist || []))) {
    return {valid: false, status: 409, error: "changed_paths_outside_repository_target_allowlist"};
  }
  for (const manifestPath of checkpointInput.artifactManifestRefs || []) {
    if (!changedPaths.includes(manifestPath)) {
      return {valid: false, status: 409, error: "artifact_manifest_not_changed_in_commit"};
    }
    if (!pathMatchesAllowlist(manifestPath, target.pathAllowlist || [])) {
      return {valid: false, status: 409, error: "artifact_manifest_outside_allowlist"};
    }
    const raw = git(root, ["show", `${finalCommit}:${manifestPath}`], "");
    if (!raw) return {valid: false, status: 409, error: "artifact_manifest_not_in_commit"};
    let manifest;
    try {
      manifest = JSON.parse(raw);
    } catch {
      return {valid: false, status: 409, error: "artifact_manifest_not_json"};
    }
    if (manifest.projectId !== taskGroup.projectId || manifest.taskGroupId !== taskGroup.id || manifest.workId !== workItem.id || manifest.sessionId !== session.sessionId || !manifest.repositoryOutputTargetRefs?.includes(target.targetId)) {
      return {valid: false, status: 409, error: "artifact_manifest_binding_mismatch"};
    }
    if (manifest.taskContractDigest !== dispatch.taskContractDigest) {
      return {valid: false, status: 409, error: "artifact_manifest_contract_digest_mismatch"};
    }
    const outputRefs = Array.isArray(manifest.outputRefs) ? manifest.outputRefs : [];
    if (!outputRefs.length) {
      return {valid: false, status: 409, error: "artifact_manifest_missing_output_refs"};
    }
    for (const outputRef of outputRefs) {
      if (!canUseGitPath(outputRef) || !pathMatchesAllowlist(outputRef, target.pathAllowlist || [])) {
        return {valid: false, status: 409, error: "artifact_output_ref_outside_allowlist"};
      }
      if (!changedPaths.includes(outputRef)) {
        return {valid: false, status: 409, error: "artifact_output_ref_not_changed_in_commit"};
      }
      if (!gitPathExists(root, finalCommit, outputRef)) {
        return {valid: false, status: 409, error: "artifact_output_ref_not_in_commit"};
      }
    }
  }
  return {
    valid: true,
    normalizedCommitRefs,
    normalizedPushRefs,
    changedPaths,
    evidenceRef: `git-evidence:${target.targetId}:${finalCommit}`
  };
}

function markDispatchBlocked(state, dispatch, reason) {
  dispatch.status = "blocked";
  dispatch.blockedReason = reason;
  dispatch.updatedAt = new Date().toISOString();
  appendEvent(state, "blocker", "AgentDispatch", dispatch.dispatchId, "agent-runtime", {projectId: dispatch.projectId, taskGroupId: dispatch.taskGroupId, reason});
}

function markDispatchFailed(state, dispatch, reason) {
  dispatch.status = "failed";
  dispatch.failureReason = reason;
  dispatch.updatedAt = new Date().toISOString();
  const session = state.workSessions.find((item) => item.sessionId === dispatch.sessionId);
  if (session) {
    session.status = "failed";
    session.updatedAt = dispatch.updatedAt;
  }
  appendEvent(state, "command_failed", "AgentDispatch", dispatch.dispatchId, "agent-runtime", {projectId: dispatch.projectId, taskGroupId: dispatch.taskGroupId, reason});
}

export function computeProgressSnapshots(state) {
  const at = new Date().toISOString();
  const snapshots = [];
  const taskGroupsByProject = new Map();
  for (const taskGroup of state.taskGroups || []) {
    taskGroupsByProject.set(taskGroup.projectId, [...(taskGroupsByProject.get(taskGroup.projectId) || []), taskGroup]);
  }
  const outputsByProject = new Map();
  const outputsByTaskGroup = new Map();
  for (const target of state.repositoryOutputs || []) {
    if (target.projectId) outputsByProject.set(target.projectId, [...(outputsByProject.get(target.projectId) || []), target]);
    if (target.taskGroupId) outputsByTaskGroup.set(target.taskGroupId, [...(outputsByTaskGroup.get(target.taskGroupId) || []), target]);
  }
  for (const project of state.projects || []) {
    const taskGroups = taskGroupsByProject.get(project.id) || [];
    const workItems = taskGroups.flatMap((taskGroup) => taskGroup.workItems || []);
    const counters = countWork(workItems);
    const progressPercent = workItems.length ? Math.round(workItems.reduce((sum, item) => sum + Number(item.progress || 0), 0) / workItems.length) : project.progress?.percent || 0;
    project.progress ||= {};
    const nextProgress = {
      percent: progressPercent,
      openTaskGroups: taskGroups.filter((taskGroup) => !["closed", "aborted"].includes(taskGroup.status)).length,
      blockedItems: counters.blocked,
      health: counters.blocked ? "attention" : taskGroups.some((taskGroup) => taskGroup.health === "attention") ? "attention" : "ok"
    };
    const progressChanged = ["percent", "openTaskGroups", "blockedItems", "health"].some((key) => project.progress[key] !== nextProgress[key]);
    if (progressChanged) {
      Object.assign(project.progress, nextProgress);
      project.progress.updatedAt = at;
    }
    snapshots.push(progressSnapshot("project", project.id, project.status, project.progress, project.progress.health, counters, taskGroups.flatMap((taskGroup) => taskGroup.roles || []), workItems, outputsByProject.get(project.id) || [], at));
  }
  for (const taskGroup of state.taskGroups || []) {
    const counters = countWork(taskGroup.workItems || []);
    snapshots.push(progressSnapshot("task_group", taskGroup.id, taskGroup.status, {percent: taskGroup.progress || 0, phase: taskGroup.phase || taskGroup.status}, taskGroup.health || "ok", counters, taskGroup.roles || [], taskGroup.workItems || [], outputsByTaskGroup.get(taskGroup.id) || [], at));
  }
  const previousById = new Map((state.progressSnapshots || []).map((snapshot) => [snapshot.snapshotId, snapshot]));
  state.progressSnapshots = snapshots.map((snapshot) => {
    const contentDigest = digestOf({...snapshot, createdAt: null, updatedAt: null});
    const previous = previousById.get(snapshot.snapshotId);
    if (previous?.contentDigest === contentDigest) return previous;
    return {...snapshot, contentDigest, digest: digestOf({...snapshot, contentDigest})};
  });
  return state.progressSnapshots;
}

function progressSnapshot(scopeType, scopeRef, status, progress, health, counters, roles, workItems, repositoryOutputs, at) {
  return {
    schemaVersion: "progress-snapshot/v1",
    snapshotId: `ps_${scopeType}_${scopeRef}`,
    scopeType,
    scopeRef,
    status: health === "blocked" ? "blocked" : "current",
    progress: {percent: Math.max(0, Math.min(100, Number(progress.percent || 0))), phase: progress.phase || status || "active"},
    health,
    counters,
    roleActivity: roles.map((role) => ({roleId: role.roleId, status: role.status, lastEventRef: `event:${scopeRef}:${role.roleId}`})),
    workItems: workItems.map((item) => ({workItemId: item.id || item.workItemId, title: item.title, status: item.status, progress: Number(item.progress || 0), ...(item.repositoryOutputTargetRef ? {repositoryOutputTargetRef: item.repositoryOutputTargetRef} : {})})),
    blockers: workItems.filter((item) => BLOCKED_OR_FAILED_WORKITEM_STATUSES.includes(item.status)).map((item) => item.id),
    repositoryOutputs: repositoryOutputs.map((target) => ({
      repositoryOutputTargetRef: target.targetId,
      repositoryId: target.repositoryId,
      branch: target.branch,
      commitRefs: target.commitRefs || [],
      pushRefs: target.pushRefs || [],
      artifactManifestPath: target.artifactManifestPath
    })),
    createdAt: at,
    updatedAt: at
  };
}

// Terminalize a cell's runtime residue so an abandoned/denied cell can never wedge the close barrier.
// Without this, denying a permission then abandoning the cell left the running dispatch + non-terminal
// session + active lease + bound repo-output target + monitoring role-drift guard all blocking close,
// with no operator lever (cancel only reaches queued/blocked dispatches, resolve_decision only the work
// item). Cascades: dispatch+session -> failed, lease -> released, its bound target -> superseded, guard
// -> closed. Idempotent (skips already-terminal objects).
export function terminateCellRuntime(state, taskGroupId, workItemId, reason) {
  if (!taskGroupId || !workItemId) return;
  const at = new Date().toISOString();
  for (const dispatch of state.agentDispatches || []) {
    if (dispatch.taskGroupId === taskGroupId && dispatch.workItemId === workItemId && !["completed", "failed", "cancelled"].includes(dispatch.status)) {
      markDispatchFailed(state, dispatch, reason);
      // Mirror every other dispatch-terminalize path: cancel dispatch-bound pending confirmations and
      // revoke the node binding + its issued MCP grants, then clear stop markers. Without this the failed
      // dispatch's still-issued grants keep no_active_temp_grants blocked (re-wedging close), a dangling
      // pending confirmation keeps no_pending_human_confirmations blocked, and the revoke-ack finalizer
      // (which matches on assignedNodeId/revocationPending) resurrects the failed dispatch to queued.
      cancelPendingConfirmationsForDispatch(state, dispatch.dispatchId, reason);
      revokeDispatchNodeBinding(state, dispatch, reason);
      delete dispatch.revocationPending;
      delete dispatch.shutdownPending;
    }
  }
  const sessionIds = new Set();
  for (const session of state.workSessions || []) {
    if (session.taskGroupId !== taskGroupId || session.workItemId !== workItemId) continue;
    sessionIds.add(session.sessionId);
    if (!WORK_SESSION_SETTLED_STATUSES.includes(session.status)) {
      session.status = "failed";
      session.blockedReason = reason;
      session.updatedAt = at;
    }
  }
  for (const lease of state.leases || []) {
    if (lease.status !== "active" || !sessionIds.has(String(lease.holderRef || "").replace("session:", ""))) continue;
    lease.status = "released";
    lease.updatedAt = at;
    const targetId = String(lease.resourceRef || "").replace("RepositoryOutputTarget:", "");
    const target = (state.repositoryOutputs || []).find((item) => item.targetId === targetId && item.leaseRef === lease.leaseId);
    if (target && !["pushed", "committed", "rejected", "superseded"].includes(target.status)) {
      target.status = "superseded";
      target.updatedAt = at;
      delete target.leaseRef;
    }
  }
  // 制品同理：放弃这个格子之后，它登记过的、不可验证的证据不能继续挡着关闭门。
  for (const artifact of state.artifacts || []) {
    if (artifact.taskGroupId !== taskGroupId || artifact.workItemId !== workItemId) continue;
    if (["verified", "rejected"].includes(artifact.status)) continue;
    if (!artifactStillGating(artifact)) continue;
    artifact.status = "rejected";
    artifact.rejectedReason = reason;
    artifact.updatedAt = at;
  }
  // 目标此前【只能经活跃租约】被级联：从未绑定过租约的（停在 selected）、以及租约已被
  // releaseLease 单独释放过的目标，谁也够不到它 —— 于是它永远挡着 all_changes_integrated，
  // 而人没有任何杠杆。归属关系本来就是 (taskGroupId, workItemId)，按归属直接收口。
  for (const target of state.repositoryOutputs || []) {
    if (target.taskGroupId !== taskGroupId || target.workItemId !== workItemId) continue;
    if (["pushed", "committed", "rejected", "superseded"].includes(target.status)) continue;
    target.status = "superseded";
    target.supersededReason = reason;
    target.updatedAt = at;
    delete target.leaseRef;
  }
  for (const guard of state.roleDriftGuards || []) {
    if (guard.sessionId && sessionIds.has(guard.sessionId) && !["closed", "corrected"].includes(guard.status)) {
      guard.status = "closed";
      guard.updatedAt = at;
    }
  }
}

function activeExecutionForWork(state, taskGroupId, workItemId) {
  const session = (state.workSessions || []).find((item) =>
    item.taskGroupId === taskGroupId &&
    item.workItemId === workItemId &&
    !WORK_SESSION_SETTLED_STATUSES.includes(item.status)
  );
  const dispatch = (state.agentDispatches || []).find((item) =>
    item.taskGroupId === taskGroupId &&
    item.workItemId === workItemId &&
    !["completed", "failed", "cancelled"].includes(item.status)
  );
  if (!session && !dispatch) return null;
  return {
    sessionId: session?.sessionId || dispatch?.sessionId,
    dispatchId: dispatch?.dispatchId,
    status: dispatch?.status || session?.status
  };
}

function capLeaseHistory(leases, limit = 2000) {
  if (leases.length <= limit) return leases;
  // Never drop an active lease (fencing / holder authority still matters); trim oldest released history.
  const active = leases.filter((item) => item.status === "active");
  const released = leases
    .filter((item) => item.status !== "active")
    .sort((left, right) => new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime())
    .slice(0, Math.max(0, limit - active.length));
  return [...active, ...released];
}

function capDispatchHistory(dispatches, limit) {
  if (dispatches.length <= limit) return dispatches;
  const terminal = new Set(["completed", "failed", "cancelled"]);
  const kept = dispatches.slice(0, limit);
  const keptIds = new Set(kept.map((item) => item.dispatchId));
  // Never drop a still-active dispatch beyond the window (its checkpoint could still arrive).
  const strandedActive = dispatches.slice(limit).filter((item) => !terminal.has(item.status) && !keptIds.has(item.dispatchId));
  return strandedActive.length ? [...kept, ...strandedActive] : kept;
}

// Symmetric with capDispatchHistory: never evict the task contract of a still-active dispatch, or
// acceptAgentCheckpoint would reject its checkpoint forever (agent_dispatch_contract_mismatch) and
// the dispatch could never terminalize — permanently wedging the task group's close barrier.
export function capTaskContracts(contracts, dispatches, limit) {
  if (contracts.length <= limit) return contracts;
  const terminal = new Set(["completed", "failed", "cancelled"]);
  const activeSessionIds = new Set((dispatches || []).filter((item) => !terminal.has(item.status)).map((item) => item.sessionId).filter(Boolean));
  const kept = contracts.slice(0, limit);
  const keptRefs = new Set(kept.map((item) => item.contractId));
  const strandedActive = contracts.slice(limit).filter((item) => activeSessionIds.has(item.sessionId) && !keptRefs.has(item.contractId));
  return strandedActive.length ? [...kept, ...strandedActive] : kept;
}

function enqueueAgentDispatch(state, contract, repositoryTarget) {
  if (!contract?.model?.modelId || !contract?.model?.modelDecision || !contract?.model?.modelSelectionDecisionRef) {
    throw new Error("agent_dispatch_requires_selected_model_decision");
  }
  const existing = (state.agentDispatches || []).find((item) =>
    item.taskGroupId === contract.taskGroupId &&
    item.workItemId === contract.workId &&
    !["completed", "failed", "cancelled"].includes(item.status)
  );
  if (existing) return existing;
  const at = new Date().toISOString();
  const workSession = (state.workSessions || []).find((session) => session.sessionId === contract.sessionId);
  const dispatch = {
    schemaVersion: "agent-dispatch/v1",
    dispatchId: createId("adp"),
    projectId: contract.projectId,
    taskGroupId: contract.taskGroupId,
    workItemId: contract.workId,
    sessionId: contract.sessionId,
    runId: contract.runId,
    status: "queued",
    deliveryMode: workSession?.placement || "new_session",
    model: contract.model.model || contract.model.modelId || providerDefaultModelIds.custom,
    reasoning: contract.model.reasoning || contract.model.reasoningLevel || "standard",
    modelDecision: contract.model.modelDecision,
    modelSelectionDecisionRef: contract.model.modelSelectionDecisionRef,
    language: contract.languagePolicy?.languageTag || defaultLanguagePolicy.languageTag,
    languagePolicyDigest: contract.languagePolicyDigest || digestOf(normalizeTaskGroupLanguagePolicy()),
    taskContractDigest: contract.contractDigest,
    taskContractRef: `AgentTaskContract:${contract.commandId}`,
    repositoryOutputTargetRef: repositoryTarget.targetId,
    roleId: contract.roleId,
    skillWorksetId: contract.roleSkill.worksetId,
    requiredCredentialEnvNames: credentialEnvNames(contract.model.alias),
    workerKind: "model_agent_runtime",
    attempts: 0,
    checkpointRequired: true,
    createdAt: at,
    updatedAt: at
  };
  state.agentDispatches.unshift(dispatch);
  state.agentDispatches = capDispatchHistory(state.agentDispatches, 240);
  return dispatch;
}

export function evaluateRoleDrift(state, request = {}) {
  ensureRuntimeCollections(state);
  const guard = request.sessionId
    ? state.roleDriftGuards.find((item) => item.sessionId === request.sessionId)
    : state.roleDriftGuards.find((item) => item.taskGroupId === request.taskGroupId && !["closed", "corrected"].includes(item.status));
  if (!guard || ["closed", "corrected"].includes(guard.status)) {
    if (request.requireGuard === true) return {allowed: false, driftScore: 1, signals: ["role_drift_guard_missing"], guardRef: null};
    return {allowed: true, driftScore: 0, signals: []};
  }
  // Signals stored on the guard MUST be values from the role-drift-guard.schema.json driftSignal enum.
  // The specific offending refs are preserved in signalDetails (carried on the emitted event) so mapping
  // to the enum doesn't lose observability.
  const signals = [];
  const signalDetails = [];
  const taskGroup = state.taskGroups.find((item) => item.id === guard.taskGroupId);
  const workItem = taskGroup?.workItems?.find((item) => item.id === guard.workItemId);
  if (taskGroup && digestOf(taskGroup.objective || "objective") !== guard.objectiveBoundaryDigest) { signals.push("goal_mismatch"); signalDetails.push("objective_boundary_mismatch"); }
  if (workItem && digestOf(workItem.ownerRole || "role") !== guard.roleMissionDigest) { signals.push("goal_mismatch"); signalDetails.push("role_mission_mismatch"); }
  for (const ref of request.actionScopeRefs || []) {
    if (!guard.allowedActionScopeRefs.includes(ref)) { signals.push("scope_expansion_without_decision"); signalDetails.push(`scope_not_allowed:${ref}`); }
  }
  for (const ref of request.forbiddenActionScopeRefs || []) {
    if (guard.forbiddenActionScopeRefs.includes(ref)) { signals.push("forbidden_action_attempted"); signalDetails.push(`forbidden_scope:${ref}`); }
  }
  // 信号不能均一化打分：越权访问一个不在允许范围内的资源、或触碰明令禁止的范围，是【定性】违规，
  // 与"目标摘要变了"这种提示性信号不同。原先每条一律 0.1 分，而阈值是 0.1/0.2 —— 单条越权永远
  // 触发不了阻断，这道门对它恒定空转（正是它本该拦住的那种行为）。
  const hardViolation = signals.some((signal) => ["scope_expansion_without_decision", "forbidden_action_attempted"].includes(signal));
  const driftScore = hardViolation ? 1 : Math.min(1, signals.length * 0.1);
  guard.driftScore = driftScore;
  guard.driftSignals = unique([...(guard.driftSignals || []), ...signals]);
  guard.updatedAt = new Date().toISOString();
  if (driftScore > guard.maxAllowedDriftScore) {
    guard.status = "correction_required";
    appendEvent(state, "blocker", "RoleDriftGuard", guard.guardId, "monitor", {projectId: guard.projectId, taskGroupId: guard.taskGroupId, signals, signalDetails});
    return {allowed: false, driftScore, signals, signalDetails, guardRef: guard.guardId};
  }
  return {allowed: true, driftScore, signals, signalDetails, guardRef: guard.guardId};
}

function countWork(workItems) {
  const active = (workItems || []).filter((item) => item.status !== "superseded");
  return {
    total: active.length,
    done: active.filter((item) => ["verified", "closed"].includes(item.status) || Number(item.progress || 0) >= 100).length,
    inProgress: active.filter((item) => ["ready", "assigned", "in_progress", "checkpoint_submitted", "review_requested", "review_passed", "verification_ready"].includes(item.status)).length,
    blocked: active.filter((item) => BLOCKED_OR_FAILED_WORKITEM_STATUSES.includes(item.status)).length
  };
}

export function computeCompletionReadiness(state, taskGroupId, request = {}) {
  ensureRuntimeCollections(state);
  const taskGroup = state.taskGroups.find((item) => item.id === taskGroupId);
  const at = new Date().toISOString();
  // 上游这份 workItems 会把 superseded 过滤掉，于是"工作项全被放弃/全被拆分取代"的任务组
  // 看起来和"从来没有过工作项"一模一样 —— 而后者是要阻塞的。两件事必须分开看。
  const allWorkItems = taskGroup?.workItems || [];
  const workItems = allWorkItems.filter((item) => item.status !== "superseded");
  const verifiedItems = workItems.filter((item) => ["verified", "closed"].includes(item.status));
  const taskGroupCheckpoints = (state.checkpoints || []).filter((checkpoint) => checkpoint.taskGroupId === taskGroupId);
  const pendingStatuses = BARRIER_PENDING_STATUSES;
  const checkFailures = {
    // ExecutionTopology terminal states per spec/state-machines.yaml are merged/downgraded/cancelled (the
    // former closed/completed/superseded literals were not modeled states at all, so nothing could clear it).
    no_open_execution_topology: (state.executionTopologies || []).some((item) => item.taskGroupId === taskGroupId && !TOPOLOGY_TERMINAL_STATUSES.includes(item.status)),
    no_open_review_plan: (state.reviewPlans || []).some((item) => item.taskGroupId === taskGroupId && !REVIEW_PLAN_TERMINAL_STATUSES.includes(item.status)),
    no_pending_review_bundle: (state.reviewBundles || []).some((item) => item.taskGroupId === taskGroupId && !["consumed", "rejected"].includes(item.status)),
    no_blocking_derived_task_request: (state.derivedTaskRequests || []).some((item) => item.taskGroupId === taskGroupId && DERIVED_TASK_REQUEST_PENDING_STATUSES.includes(item.status)),
    no_pending_external_review: (state.reviewBundles || []).some((item) => item.taskGroupId === taskGroupId && item.reviewMode === "external" && !["consumed", "rejected"].includes(item.status)),
    no_active_role_drift_guard: (state.roleDriftGuards || []).some((guard) => guard.taskGroupId === taskGroupId && !["closed", "corrected"].includes(guard.status)),
    // 这里原先有两道关于指令包的门，但它们永远不会响：指令包是任务契约的纯投影，
    // buildEffectiveInstructionPacket 直接写 "active"，spec 里 assembled/strengthened/validated
    // 那条流水线在代码里根本不存在，没有任何一步会失败。给它硬造一个生产者只是为了让门"看起来
    // 有事可做" —— 那是在糊弄检查而不是在检查。真正的保护也不在这里：包缺失时 buildDispatchPackage
    // 会以 dispatch_package_incomplete 直接失败。若将来真的实现了分阶段的包构建，这道门连同它的
    // 阶段一起加回来。
    // 只有【已经进入流程】的共享定义才阻塞关闭：草稿视为尚未提出。否则任何一条 AI 建的 draft 都能
    // 永久锁死关闭门，而控制台对共享定义是只读的、REST 也没有改状态的入口 —— 人将完全无法脱困。
    shared_definitions_active: relatedSharedDefinitions(state, taskGroup).some((definition) => SHARED_DEFINITION_BLOCKING_STATUSES.includes(definition.status)),
    repository_output_target_terminal: (state.repositoryOutputs || []).filter((target) => target.taskGroupId === taskGroupId).some((target) => !["pushed", "committed", "rejected", "superseded"].includes(target.status)),
    // 原先只认 verified/closed，于是【被拆分掉的父工作项】和【人工放弃的工作项】（都是 superseded）
    // 会永久挡住关闭 —— 拆分过一次的任务组从此关不掉，而拆分是系统自己会做的事。
    // 已了结不等于已交付：放弃/取消/被取代都是了结，只是没有产出。
    all_required_outputs_present: allWorkItems.length === 0 || allWorkItems.some((item) => !WORK_ITEM_SETTLED_STATUSES.includes(item.status)),
    // 原先只要求全组【存在任意一个】带 git 证据的检查点：5 个已验收工作项配 1 个检查点也算通过，
    // 太弱；反过来，agent 从未成功跑过（或工作项全被放弃）时又永远满足不了，人还没有任何杠杆，
    // 因为 checkpoint_submit 被锁死为服务账号专属。改为按【已验收的工作项】逐个要求证据 ——
    // 既严格得多，也不再要求"没有交付的东西"拿出交付证据。
    all_required_evidence_present: verifiedItems.some((item) =>
      !taskGroupCheckpoints.some((checkpoint) => (checkpoint.workId === item.id || checkpoint.workItemId === item.id)
        && checkpoint.commitRefs?.length && checkpoint.pushRefs?.length && checkpoint.artifactManifestRefs?.length)),
    all_required_validation_present: verifiedItems.some((item) =>
      taskGroupCheckpoints.some((checkpoint) => checkpoint.workId === item.id) &&
      !item.reviewBundleRef &&
      !(state.reviewBundles || []).some((bundle) => bundle.workItemId === item.id && bundle.verdict === "passed")),
    no_pending_permission_or_approval: (state.permissionRequests || []).some((item) => item.taskGroupId === taskGroupId && PERMISSION_REQUEST_PENDING_STATUSES.includes(item.status)) ||
      (state.approvalRequests || []).some((item) => item.taskGroupId === taskGroupId && APPROVAL_REQUEST_PENDING_STATUSES.includes(item.status)),
    no_unreconciled_command_effect: (state.commandEffects || []).some((item) => item.taskGroupId === taskGroupId && !COMMAND_EFFECT_TERMINAL.has(item.status)),
    no_pending_human_confirmations: (state.humanConfirmationRequests || []).some((item) => item.taskGroupId === taskGroupId && item.status === "pending"),
    no_pending_human_directives: (state.humanDirectives || []).some((item) => item.taskGroupId === taskGroupId && ["queued", "acknowledged"].includes(item.status))
  };
  const blockers = [];
  if (checkFailures.all_required_outputs_present) blockers.push({objectType: "WorkItem", objectId: taskGroup?.id || taskGroupId, status: "open"});
  if (checkFailures.no_active_role_drift_guard) blockers.push({objectType: "RoleDriftGuard", objectId: taskGroupId, status: "active"});
  if (checkFailures.shared_definitions_active) blockers.push({objectType: "SharedDefinitionContract", objectId: taskGroupId, status: "not_active"});
  if (checkFailures.repository_output_target_terminal) blockers.push({objectType: "RepositoryOutputTarget", objectId: taskGroupId, status: "non_terminal"});
  if ((state.workSessions || []).some((session) => session.taskGroupId === taskGroupId && !WORK_SESSION_SETTLED_STATUSES.includes(session.status))) blockers.push({objectType: "WorkSession", objectId: taskGroupId, status: "active"});
  if ((state.agentDispatches || []).some((dispatch) => dispatch.taskGroupId === taskGroupId && !["completed", "failed", "cancelled"].includes(dispatch.status))) blockers.push({objectType: "AgentDispatch", objectId: taskGroupId, status: "active"});
  if ((state.leases || []).some((lease) => lease.status === "active" && leaseAppliesToTaskGroup(state, lease, taskGroupId))) blockers.push({objectType: "Lease", objectId: taskGroupId, status: "active"});
  if (checkFailures.all_required_evidence_present) blockers.push({objectType: "Checkpoint", objectId: taskGroupId, status: "missing_git_evidence"});
  if (checkFailures.all_required_validation_present) blockers.push({objectType: "ReviewBundle", objectId: taskGroupId, status: "independent_review_missing"});
  if (checkFailures.no_pending_permission_or_approval) blockers.push({objectType: "PermissionOrApprovalRequest", objectId: taskGroupId, status: "pending"});
  if (checkFailures.no_open_execution_topology) blockers.push({objectType: "ExecutionTopology", objectId: taskGroupId, status: "open"});
  if (checkFailures.no_open_review_plan) blockers.push({objectType: "ReviewPlan", objectId: taskGroupId, status: "open"});
  if (checkFailures.no_pending_review_bundle) blockers.push({objectType: "ReviewBundle", objectId: taskGroupId, status: "pending"});
  if (checkFailures.no_blocking_derived_task_request) blockers.push({objectType: "DerivedTaskRequest", objectId: taskGroupId, status: "pending"});
  if (checkFailures.no_unreconciled_command_effect) blockers.push({objectType: "CommandEffect", objectId: taskGroupId, status: "unreconciled"});
  if (checkFailures.no_pending_human_confirmations) blockers.push({objectType: "HumanConfirmationRequest", objectId: taskGroupId, status: "pending"});
  if (checkFailures.no_pending_human_directives) blockers.push({objectType: "HumanDirective", objectId: taskGroupId, status: "pending"});
  const checks = Object.keys(checkFailures);
  const clear = blockers.length === 0;
  const checkResults = Object.fromEntries(checks.map((check) => [check, {
    status: checkFailures[check] ? "blocked" : "passed",
    evidenceRefs: [`readiness:${taskGroupId}:${check}`],
    ...(checkFailures[check] ? {reasonCode: "blocking_objects_present"} : {})
  }]));
  const readiness = {
    schemaVersion: "completion-readiness/v1",
    checkId: createId("ready"),
    projectId: taskGroup?.projectId || request.projectId || "prj_control_plane",
    taskGroupId,
    targetRef: `TaskGroup:${taskGroupId}`,
    status: clear ? "clear" : "blocked",
    stateVersion: state.stateVersion,
    stateDigest: digestOf({
      workItems: workItems.map((item) => ({id: item.id, status: item.status, progress: item.progress})),
      guards: (state.roleDriftGuards || []).filter((guard) => guard.taskGroupId === taskGroupId).map((guard) => ({id: guard.guardId, status: guard.status})),
      targets: (state.repositoryOutputs || []).filter((target) => target.taskGroupId === taskGroupId).map((target) => ({id: target.targetId, status: target.status})),
      checkpoints: taskGroupCheckpoints.map((checkpoint) => checkpoint.runId),
      blockers
    }),
    sourceQueryRefs: [`state://task-groups/${taskGroupId}`, `state://checkpoints/${taskGroupId}`, `state://review-bundles/${taskGroupId}`, `state://permission-requests/${taskGroupId}`, `state://approval-requests/${taskGroupId}`],
    requiredChecks: checks,
    checkResults,
    blockingObjects: blockers,
    evidenceRefs: [`readiness:${taskGroupId}`],
    computedAt: at
  };
  state.completionReadiness = [readiness, ...state.completionReadiness.filter((item) => item.taskGroupId !== taskGroupId)].slice(0, 80);
  return readiness;
}

export function computeCloseBarrier(state, taskGroupId, request = {}) {
  ensureRuntimeCollections(state);
  const taskGroup = state.taskGroups.find((item) => item.id === taskGroupId);
  // Only reuse a cached readiness computed against the CURRENT state version; a stale one (e.g. a
  // WorkItem added or a role-drift guard opened since the last cycle) would let close_barrier_compute
  // (esp. mutate:true) satisfy the barrier and close a task group with unfinished work.
  const cachedReadiness = state.completionReadiness.find((item) => item.taskGroupId === taskGroupId);
  const readiness = (cachedReadiness && cachedReadiness.stateVersion === state.stateVersion)
    ? cachedReadiness
    : computeCompletionReadiness(state, taskGroupId, request);
  const nowMs = Date.now();
  // "quorum_collecting" is a NON-terminal approval state (a high-risk approval that has some but not all
  // required approvers): it MUST count as pending so the no_pending_approvals close-barrier gate keeps
  // blocking until the approver quorum is actually reached.
  const pendingStatuses = ["open", "pending", "pending_approval", "quorum_collecting", "requested", "submitted", "in_review", "waiting"];
  const forTaskGroup = (items) => (items || []).filter((item) => item.taskGroupId === taskGroupId);
  // A failed quality gate whose work item was abandoned (cancelled/aborted/superseded) or already closed
  // is moot — it must not block the task-group close forever with no operator remedy (the work will never
  // be re-tested). Live/in-progress work items keep blocking; the operator re-tests or cancels the item.
  const abandonedQualityGateWorkIds = new Set((taskGroup?.workItems || [])
    .filter((workItem) => ["cancelled", "aborted", "superseded", "closed"].includes(workItem.status))
    .map((workItem) => workItem.id));
  const gateFailures = {
    all_required_work_closed: readiness.blockingObjects.some((item) => item.objectType === "WorkItem"),
    all_findings_terminal: forTaskGroup(state.findings).some((item) => !(FINDING_TERMINAL_STATUSES.includes(item.status) && ["fixed_verified", "not_applicable", "scope_adjusted", "blocked_external"].includes(item.dispositionClass))),
    all_quality_gates_passed: forTaskGroup(state.qualityGates).some((item) => !["passed", "waived"].includes(item.status) && !(item.workItemId && abandonedQualityGateWorkIds.has(item.workItemId))),
    all_contracts_compatible: relatedSharedDefinitions(state, taskGroup).some((definition) => ["conflicted", "change_requested"].includes(definition.status)),
    all_changes_integrated: forTaskGroup(state.repositoryOutputs).some((target) => !["pushed", "committed", "rejected", "superseded"].includes(target.status)),
    no_pending_permissions: forTaskGroup(state.permissionRequests).some((item) => PERMISSION_REQUEST_PENDING_STATUSES.includes(item.status)),
    no_pending_approvals: forTaskGroup(state.approvalRequests).some((item) => APPROVAL_REQUEST_PENDING_STATUSES.includes(item.status)),
    all_commands_terminal: (state.commands || []).some((command) => (command.taskGroupId === taskGroupId || command.subject === `TaskGroup:${taskGroupId}`) && !COMMAND_TERMINAL.has(command.status)),
    all_command_effects_terminal: forTaskGroup(state.commandEffects).some((item) => !COMMAND_EFFECT_TERMINAL.has(item.status)),
    no_active_dlq: forTaskGroup(state.dlqEntries).some((item) => !DLQ_ENTRY_TERMINAL.has(item.status)),
    all_leases_terminal: (state.leases || []).some((lease) => lease.status === "active" && leaseAppliesToTaskGroup(state, lease, taskGroupId)),
    no_active_temp_grants: (state.mcpGrants || []).some((grant) => grant.taskGroupId === taskGroupId && grant.grantStatus === "issued" && new Date(grant.expiresAt || 0).getTime() > nowMs),
    // 这道门原先恒不触发：artifactRegister 只会写 "registered"，而它本身就在通过集里，
    // "verified" 则全仓无人写入 —— 一道名为"制品已验证"的门，从来没有验证过任何东西，
    // 连没有任何摘要（原先那个 digest 其实是请求参数的哈希）的制品也照样通过。
    // 改为按【是否真的可验证】判定；出口是 terminateCellRuntime 的级联（放弃工作项即收口）。
    // 已了结的三种：verified（真验过）、rejected/gc（明确作废，只有 terminateCellRuntime 能写）。
    // 其余只有"registered 且确实带内容哈希"才算数 —— 摘要若来自请求参数，它什么都没证明。
    artifacts_verified: forTaskGroup(state.artifacts).some(artifactStillGating),
    rules_candidates_processed: (state.ruleSourceResolutions || []).some((item) => item.taskGroupId === taskGroupId && item.status === "discovered"),
    runtime_issue_candidates_exported: forTaskGroup(state.systemUpgradeCandidates).some((item) => item.status === "candidate_created"),
    no_open_execution_topologies: forTaskGroup(state.executionTopologies).some((item) => !TOPOLOGY_TERMINAL_STATUSES.includes(item.status)),
    no_blocking_derived_task_requests: forTaskGroup(state.derivedTaskRequests).some((item) => ["candidate", "strengthened", "classified"].includes(item.status)),
    all_review_plans_closed: forTaskGroup(state.reviewPlans).some((item) => !REVIEW_PLAN_TERMINAL_STATUSES.includes(item.status)),
    no_pending_review_bundles: forTaskGroup(state.reviewBundles).some((item) => !["consumed", "rejected"].includes(item.status)),
    all_rule_sources_resolved: (state.ruleSourceResolutions || []).some((item) => item.taskGroupId === taskGroupId && !RULE_SOURCE_TERMINAL_STATUSES.includes(item.status) && item.status !== "active"),
    completion_readiness_clear: readiness.status !== "clear",
    no_pending_human_confirmations: forTaskGroup(state.humanConfirmationRequests).some((item) => item.status === "pending"),
    no_pending_human_directives: forTaskGroup(state.humanDirectives).some((item) => ["queued", "acknowledged"].includes(item.status)),
    no_active_role_drift_blockers: readiness.blockingObjects.some((item) => item.objectType === "RoleDriftGuard"),
    all_shared_definitions_active: relatedSharedDefinitions(state, taskGroup).some((definition) => SHARED_DEFINITION_BLOCKING_STATUSES.includes(definition.status)),
    all_repository_output_targets_terminal: forTaskGroup(state.repositoryOutputs).some((target) => !["pushed", "committed", "rejected", "superseded"].includes(target.status))
  };
  const gates = Object.keys(gateFailures);
  const failedGates = gates.filter((gate) => gateFailures[gate]);
  const blockers = [...readiness.blockingObjects];
  for (const gate of failedGates) {
    if (!blockers.some((item) => item.gate === gate)) blockers.push({objectType: "CloseBarrierGate", objectId: taskGroupId, gate, status: "blocked"});
  }
  const satisfied = failedGates.length === 0 && readiness.status === "clear";
  const at = new Date().toISOString();
  const barrier = {
    schemaVersion: "close-barrier/v1",
    projectId: taskGroup?.projectId || request.projectId || "prj_control_plane",
    taskGroupId,
    stateVersion: state.stateVersion,
    stateDigest: digestOf({readinessDigest: readiness.stateDigest, failedGates, taskGroupStatus: taskGroup?.status}),
    sourceQueryRefs: [{queryId: `close:${taskGroupId}`, source: `state://task-groups/${taskGroupId}`, digest: digestOf({id: taskGroup?.id, status: taskGroup?.status, workItems: (taskGroup?.workItems || []).map((item) => ({id: item.id, status: item.status}))})}],
    requiredGates: gates,
    gateResults: Object.fromEntries(gates.map((gate) => [gate, {
      status: gateFailures[gate] ? "blocked" : "passed",
      evidenceRefs: [`close:${taskGroupId}:${gate}`],
      ...(gateFailures[gate] ? {reasonCode: "gate_blocked"} : {})
    }])),
    blockingObjects: blockers,
    // §4.5/§10 global judgment record: the close is an explicit reality-first judgment over the whole
    // task group (required cells terminal + real findings dispositioned + independent review + side
    // effects settled + no live authorization/human hold), not a mere mechanical AND of flags. All
    // fields are derived from real state (not synthesized), so the terminal close carries an auditable
    // holistic conclusion.
    holisticJudgment: {
      basis: "reality_first_close_barrier",
      requiredCellsTerminal: !gateFailures.all_required_work_closed,
      findingsDispositioned: !gateFailures.all_findings_terminal,
      independentReviewComplete: readiness.checkResults?.all_required_validation_present?.status !== "blocked",
      sideEffectsSettled: !gateFailures.all_commands_terminal && !gateFailures.all_command_effects_terminal && !gateFailures.no_active_dlq,
      noLiveAuthorizationHold: !gateFailures.no_pending_permissions && !gateFailures.no_pending_approvals && !gateFailures.no_pending_human_confirmations,
      realBlockerCount: blockers.length,
      conclusion: satisfied ? "all_required_terminal_no_real_blocker" : "blocked_by_real_gate"
    },
    evidenceRefs: [`close:${taskGroupId}`, readiness.checkId],
    computedAt: at,
    satisfied
  };
  state.closeBarriers = [barrier, ...state.closeBarriers.filter((item) => item.taskGroupId !== taskGroupId)].slice(0, 80);
  // 关闭任务组是核心定稿动作：只有真人账号可以落闸。机器主体即使拿到 task_group:control 也不行 ——
  // 否则一个服务账号就能替 AI 把任务组关掉，人工闸门在最后一步被绕过。这里对**任何**落闸请求先行拒绝
  // （而不是等门禁满足后才拒），机器主体的关闭意图应当被明确报错，而不是静默无效。
  if (request.mutate === true && taskGroup && !isHumanConfirmationActor(state, request.actor)) {
    throw Object.assign(new Error("task_group_close_requires_human_actor"), {status: 403});
  }
  if (satisfied && request.mutate === true && taskGroup) {
    taskGroup.status = "closed";
    taskGroup.goalExecutionStatus = "closed";
    taskGroup.progress = 100;
    taskGroup.health = "ok";
    // 记录人工定稿：谁、何时、依据哪一份门禁快照关闭的。这也是关闭后 AI 不得再改的基线。
    taskGroup.humanFinalization = {
      finalizedBy: request.actor,
      finalizedAt: at,
      confirmationRef: `close-barrier:${taskGroupId}:${barrier.stateVersion}`,
      contentDigest: barrier.stateDigest,
      decisionType: "task_group_close",
      outcome: "confirmed"
    };
    taskGroup.updatedAt = at;
    barrier.confirmedBy = request.actor;
    barrier.confirmedAt = at;
    appendEvent(state, "decision", "TaskGroup", taskGroup.id, request.actor, {
      taskGroupId: taskGroup.id, decisionType: "task_group_close", humanFinalized: true
    });
  }
  return barrier;
}

export function collectRuntimeIssue(state, request = {}) {
  ensureRuntimeCollections(state);
  const at = new Date().toISOString();
  const fingerprint = request.issueFingerprint || digestOf({issueClass: request.issueClass, summary: request.summary}).slice(7, 23);
  const matchingSamples = state.runtimeIssueSamples.filter((sample) => sample.issueFingerprint === fingerprint);
  let pattern = state.runtimeIssuePatterns.find((item) => item.issueFingerprint === fingerprint);
  if (!pattern) {
    if (matchingSamples.length === 0 && !request.forcePattern) {
      const sample = {
        sampleId: createId("ris"),
        status: "sample_recorded",
        issueClass: request.issueClass || "repeated_failure_fingerprint",
        issueFingerprint: fingerprint,
        affectedComponents: request.affectedComponents || ["orchestrator"],
        evidenceRefs: request.evidenceRefs || [`issue:${fingerprint}`],
        sampleRefs: request.sampleRefs || [`sample:${fingerprint}:1`],
        createdAt: at
      };
      state.runtimeIssueSamples.unshift(sample);
      state.runtimeIssueSamples = state.runtimeIssueSamples.slice(0, 2000);
      return sample;
    }
    pattern = {
      schemaVersion: "runtime-issue-pattern/v1",
      patternId: createId("rip"),
      projectId: request.projectId,
      taskGroupId: request.taskGroupId,
      status: "clustered",
      issueClass: request.issueClass || "repeated_failure_fingerprint",
      issueFingerprint: fingerprint,
      recurrenceCount: Math.max(2, Number(request.recurrenceCount || matchingSamples.length + 1)),
      affectedComponents: request.affectedComponents || ["orchestrator"],
      evidenceRefs: request.evidenceRefs || [`issue:${fingerprint}`],
      sampleRefs: request.sampleRefs || [`sample:${fingerprint}:1`],
      collectionPolicy: {mode: "collect_only", forbidsRuntimeAutoUpgrade: true, externalUpgradePackageRequired: true},
      auditRef: `audit:runtime-issue:${fingerprint}`,
      createdAt: at,
      updatedAt: at
    };
    state.runtimeIssuePatterns.unshift(pattern);
    state.runtimeIssuePatterns = state.runtimeIssuePatterns.slice(0, 2000);
  } else {
    pattern.recurrenceCount += 1;
    pattern.status = pattern.recurrenceCount >= 2 ? "clustered" : "observed";
    pattern.evidenceRefs = unique([...pattern.evidenceRefs, ...(request.evidenceRefs || [])]);
    pattern.sampleRefs = unique([...pattern.sampleRefs, ...(request.sampleRefs || [`sample:${fingerprint}:${pattern.recurrenceCount}`])]);
    pattern.updatedAt = at;
  }
  if (pattern.recurrenceCount >= 3 && !pattern.candidateRef) {
    const candidate = {
      schemaVersion: "system-upgrade-candidate/v1",
      candidateId: createId("suc"),
      issuePatternId: pattern.patternId,
      projectId: pattern.projectId,
      taskGroupId: pattern.taskGroupId,
      status: "candidate_created",
      issueFingerprint: pattern.issueFingerprint,
      recurrenceCount: pattern.recurrenceCount,
      affectedComponents: pattern.affectedComponents,
      evidenceRefs: pattern.evidenceRefs,
      sampleRefs: pattern.sampleRefs,
      runtimeMutationPolicy: {
        mode: "collect_only",
        forbidActiveExecutionMutation: true,
        forbiddenActions: ["mutate_active_ruleset", "self_patch_control_plane", "change_scheduler_policy", "auto_publish_role_skill_overlay", "auto_change_permission_policy", "auto_expand_mcp_grant", "create_runtime_self_upgrade_task_group", "execute_system_upgrade_during_project_run"]
      },
      externalMaintenancePolicy: {requiresExternalMaintenance: true, forbidsRuntimeAutoUpgrade: true, forbidsAutoUpgradeTaskGroup: true, exportPackageRequired: true},
      auditRef: `audit:system-upgrade:${pattern.patternId}`,
      createdAt: at,
      updatedAt: at
    };
    state.systemUpgradeCandidates.unshift(candidate);
    state.systemUpgradeCandidates = capRetainingPredicate(state.systemUpgradeCandidates, (item) => item.status === "candidate_created", 2000);
    pattern.status = "candidate_created";
    pattern.candidateRef = candidate.candidateId;
  }
  appendEvent(state, "blocker", "RuntimeIssuePattern", pattern.patternId, "monitor", pattern);
  return pattern;
}

export function registerRoleSkillOverlay(state, body = {}) {
  ensureRuntimeCollections(state);
  const base = state.roleSkills.find((skill) => skill.roleSkillId === body.roleSkillRef) || state.roleSkills[0];
  const at = new Date().toISOString();
  const overlay = {
    schemaVersion: "role-skill-overlay/v1",
    overlayId: createId("rso"),
    status: "active",
    scope: body.scope || "project",
    roleSkillRef: base.roleSkillId,
    baseRoleSkillDigest: base.contentDigest,
    overlayDigest: digestOf(body.patch || {}),
    patch: body.patch || {allowedCapabilityAdds: [], forbiddenCapabilityAdds: [], instructionRef: "overlay:empty", modelRequirementPatchRef: "overlay:model:none"},
    decisionRecordRef: body.decisionRecordRef || `decision:overlay:${base.roleSkillId}`,
    auditRef: body.auditRef || `audit:overlay:${base.roleSkillId}`,
    createdAt: at,
    projectId: body.projectId || "prj_control_plane",
    ...(body.scope === "task_group" || body.taskGroupId ? {taskGroupId: body.taskGroupId || "tg_runtime_management"} : {})
  };
  state.roleSkillOverlays.unshift(overlay);
  state.roleSkillOverlays = state.roleSkillOverlays.slice(0, 2000);
  base.overlayRefs = unique([...(base.overlayRefs || []), overlay.overlayId]);
  appendEvent(state, "decision", "RoleSkillOverlay", overlay.overlayId, "skill-registry", overlay);
  return overlay;
}

export function syncSkillSource(state, sourceId, options = {}) {
  ensureRuntimeCollections(state);
  const source = state.skillSources.find((item) => item.sourceId === sourceId);
  if (!source) throw new Error("skill_source_not_found");
  const runtimeDir = options.runtimeDir || join(options.root || process.cwd(), ".runtime");
  const sourceDir = join(runtimeDir, "skill-sources", source.sourceId);
  const repoDir = join(sourceDir, "repo");
  mkdirSync(sourceDir, {recursive: true});
  source.status = "syncing";
  // Harden the skill-source git subprocess (same discipline as checkpoint verification): restrict
  // transports (blocks ext::/fd:/remote-helper RCE), reject an unsafe URL / malformed ref / non-hex
  // commit, and disable prompts. Skill sources are normally system-configured, but this is defense
  // in depth against a tampered/typo'd source record.
  const gitEnv = {...process.env, GIT_ALLOW_PROTOCOL: "https:ssh:git", GIT_TERMINAL_PROMPT: "0"};
  const repoUrl = String(source.repositoryUrl || "");
  const defaultRef = String(source.defaultRef || "");
  const pinnedCommit = String(source.pinnedCommit || "");
  if (!repoUrl || repoUrl.startsWith("-") || /^[a-z0-9+.-]*::/iu.test(repoUrl) || repoUrl.startsWith("ext:") || repoUrl.startsWith("fd:")
      || !/^[A-Za-z0-9._\/-]+$/u.test(defaultRef) || !/^[0-9a-fA-F]{7,64}$/u.test(pinnedCommit)) {
    source.status = "quarantined";
    throw new Error("skill_source_unsafe_git_input");
  }
  if (!existsSync(join(repoDir, ".git"))) {
    execFileSync("git", ["clone", "--", repoUrl, repoDir], {stdio: "pipe", env: gitEnv});
  }
  execFileSync("git", ["-C", repoDir, "fetch", "origin", "--", defaultRef], {stdio: "pipe", env: gitEnv});
  execFileSync("git", ["-C", repoDir, "checkout", "--detach", pinnedCommit], {stdio: "pipe", env: gitEnv});
  const actualCommit = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], {encoding: "utf8"}).trim();
  if (source.trustPolicy.requirePinnedCommit && actualCommit !== source.pinnedCommit) {
    source.status = "quarantined";
    throw new Error(`pinned_commit_mismatch:${actualCommit}`);
  }
  const roleFiles = listRoleFiles(repoDir, source.roleFileGlobs);
  const roleSkills = roleFiles.map((filePath) => parseRoleSkillFile(source, repoDir, filePath)).filter(Boolean);
  const catalogDigest = digestOf(source.catalogFiles.map((file) => {
    const path = join(repoDir, file);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }).join("\n"));
  const index = {
    schemaVersion: "agent-role-skill-index/v1",
    sourceId: source.sourceId,
    pinnedCommit: source.pinnedCommit,
    actualCommit,
    roleSkillCount: roleSkills.length,
    catalogDigest,
    contentDigest: digestOf(roleSkills.map((skill) => [skill.roleSkillId, skill.contentDigest])),
    indexedAt: new Date().toISOString(),
    roleSkills
  };
  const indexPath = join(sourceDir, "index.json");
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  source.status = "active";
  source.stateVersion += 1;
  source.catalogDigest = catalogDigest;
  source.roleSkillIndexRef = `runtime://skill-sources/${source.sourceId}/index.json`;
  source.digestIndexRef = `runtime://skill-sources/${source.sourceId}/index.json#contentDigest`;
  source.digestIndexVerified = true;
  state.roleSkills = [...state.roleSkills.filter((skill) => skill.sourceId !== source.sourceId), ...roleSkills];
  appendEvent(state, "decision", "AgentSkillSource", source.sourceId, "skill-registry", {roleSkillCount: roleSkills.length, actualCommit});
  return {source, roleSkillCount: roleSkills.length, indexPath, actualCommit};
}

function listRoleFiles(repoDir, globs) {
  const prefixes = unique(globs.map((pattern) => pattern.split("/**")[0]).filter(Boolean));
  const files = [];
  for (const prefix of prefixes) {
    const start = join(repoDir, prefix);
    if (!existsSync(start)) continue;
    walk(start, (filePath) => {
      if (filePath.endsWith(".md")) files.push(filePath);
    });
  }
  return unique(files).sort();
}

function walk(dir, visit) {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const target = join(dir, entry.name);
    if (entry.isDirectory()) walk(target, visit);
    if (entry.isFile()) visit(target);
  }
}

function parseRoleSkillFile(source, repoDir, filePath) {
  const content = readFileSync(filePath, "utf8");
  const frontmatter = parseFrontmatter(content);
  if (source.trustPolicy.requireFrontmatter && !frontmatter) return null;
  const relativePath = relative(repoDir, filePath);
  const roleSkillId = relativePath.replace(/\.md$/u, "").replaceAll("/", "-");
  const category = relativePath.split("/")[0];
  const body = content.replace(/^---[\s\S]*?---\s*/u, "");
  const description = frontmatter?.description || body.split("\n").find((line) => line.trim() && !line.startsWith("#"))?.trim() || roleSkillId;
  const capabilities = inferCapabilities(`${frontmatter?.name || ""} ${description} ${body}`).slice(0, 12);
  return {
    schemaVersion: "agent-role-skill/v1",
    sourceId: source.sourceId,
    roleSkillId,
    sourcePath: relativePath,
    name: frontmatter?.name || roleSkillId,
    description,
    category,
    frontmatterDigest: digestOf(frontmatter || {}),
    contentDigest: digestOf(content),
    capabilities: capabilities.length ? capabilities : ["planning"],
    defaultModelRequirements: {
      strengths: strengthsFromCapabilities(capabilities),
      minContextWindowTokens: content.length > 20000 ? 128000 : 32000,
      requiresToolUse: /工具|tool|MCP|API|代码|开发|测试/u.test(content),
      riskLevel: /安全|security|支付|权限|合规|法律|法务/u.test(content) ? "L2" : "L1"
    },
    overlayRefs: [],
    status: "active",
    stateVersion: 1,
    auditRef: `audit:skill:${roleSkillId}`
  };
}

function parseFrontmatter(content) {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---", 4);
  if (end < 0) return null;
  const raw = content.slice(4, end).trim();
  const result = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^([^:#]+):\s*(.*)$/u);
    if (!match) continue;
    result[match[1].trim()] = match[2].trim().replace(/^["']|["']$/gu, "");
  }
  return result;
}

function inferCapabilities(text) {
  const t = text.toLowerCase();
  const result = [];
  const add = (capability, regex) => {
    if (regex.test(t)) result.push(capability);
  };
  add("coding", /code|代码|开发|工程|frontend|backend|api|数据库|架构/u);
  add("architecture", /architecture|架构|系统|拓扑|设计/u);
  add("review", /review|审查|评审|复验|审核/u);
  add("security", /security|安全|威胁|合规|权限|secret/u);
  add("qa", /qa|测试|验证|质量|回归|验收/u);
  add("planning", /plan|规划|项目|调度|路线|roadmap/u);
  add("writing", /writing|文档|写作|内容|copy/u);
  add("translation", /translation|翻译|中文|英文/u);
  add("math", /math|数学|算法|量化/u);
  add("data_analysis", /data|数据|分析|指标|统计/u);
  add("creative", /design|设计|视觉|品牌|创意/u);
  add("fast_execution", /快速|自动化|ops|运维|devops|效率/u);
  add("long_context", /长上下文|上下文|context|文档库/u);
  if (!result.length) result.push("planning");
  return unique(result);
}

function strengthsFromCapabilities(capabilities) {
  const allowed = new Set(["deep_reasoning", "coding", "architecture", "review", "security", "qa", "planning", "writing", "translation", "math", "data_analysis", "creative", "fast_execution", "long_context", "multimodal", "low_cost", "local_private"]);
  const mapped = capabilities.map((item) => item === "tool_use" ? "planning" : item).filter((item) => allowed.has(item));
  return unique(mapped.length ? mapped : ["planning"]);
}

export function resolveRoleSkill(state, roleId, request = {}) {
  const hint = roleCapabilityHints[roleId] || roleCapabilityHints.orchestrator;
  // 技能内容会进任务契约，等于 agent 的行为准则，所以"绑定谁"必须不可顶替。
  // 原先是任意 `endsWith(skillRef)`：造一个 `evil-<skillRef>` 的 id 就能顶替真技能。
  // 但也不能拿 `-` 当锚点——roleSkillId 是 relativePath 把 `/` 换成 `-` 生成的（parseRoleSkillFile），
  // 真实 id 里根本没有 `/`/`:`，按那两个字符锚定会让所有角色静默回退到种子占位技能（我犯过这个错）。
  // 正确的锚点是 relativePath 的【文件名】：skillRef 指的就是它，且能天然区分
  // security-architect 与 security-cloud-security-architect 这种前缀包含关系。
  // 字段名是 sourcePath（parseRoleSkillFile 第 3271 行），不是 relativePath —— 后者只是那里的局部
  // 变量名。我上一版读错字段，导致 basename 恒为空、匹配退化成精确 id、所有角色静默回退到占位技能，
  // 而我那个"双向测试"用的 fixture 自造了一个生产中不存在的 relativePath 字段，所以照样全绿。
  const skillBasename = (skill) => String(skill.sourcePath || "").split("/").pop().replace(/\.md$/u, "");
  const skillRefMatches = (skill) => String(skill.roleSkillId || "") === hint.skillRef || skillBasename(skill) === hint.skillRef;
  const skillCandidates = state.roleSkills.filter(skillRefMatches);
  // 歧义必须显式暴露，不能像 find 那样静默取数组里的第一个（那等于"谁先插入谁赢"）。
  if (skillCandidates.length > 1) {
    throw Object.assign(new Error("role_skill_reference_ambiguous"), {status: 409, skillRef: hint.skillRef, candidates: skillCandidates.map((skill) => skill.roleSkillId)});
  }
  const baseSkill = skillCandidates[0] ||
    state.roleSkills.find((skill) => skill.roleSkillId === `system-${roleId}`) ||
    state.roleSkills[0];
  const overlay = selectRoleSkillOverlay(state, baseSkill?.roleSkillId, request);
  if (overlay) {
    return applyRoleSkillOverlay(baseSkill, overlay);
  }
  return baseSkill;
}

function selectRoleSkillOverlay(state, roleSkillId, request = {}) {
  const matching = (state.roleSkillOverlays || []).filter((item) => item.status === "active" && item.roleSkillRef === roleSkillId);
  const newest = (items) => items.sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")))[0];
  const taskGroupOverlay = request.taskGroupId ? newest(matching.filter((item) => item.taskGroupId === request.taskGroupId)) : null;
  if (taskGroupOverlay) return taskGroupOverlay;
  return request.projectId ? newest(matching.filter((item) => item.projectId === request.projectId && !item.taskGroupId)) : null;
}

function applyRoleSkillOverlay(baseSkill, overlay) {
  const patch = overlay.patch || {};
  const forbidden = new Set(patch.forbiddenCapabilityAdds || []);
  const capabilities = unique([...(baseSkill.capabilities || []), ...(patch.allowedCapabilityAdds || [])]).filter((capability) => !forbidden.has(capability));
  return {
    ...baseSkill,
    roleSkillId: `${baseSkill.roleSkillId}+${overlay.overlayId}`,
    capabilities,
    contentDigest: overlay.overlayDigest,
    overlayRefs: unique([...(baseSkill.overlayRefs || []), overlay.overlayId])
  };
}

function inferWorkSignals(workItem = {}, taskGroup = {}) {
  const text = `${workItem.title || ""} ${workItem.ownerRole || ""} ${taskGroup.objective || ""}`.toLowerCase();
  const signals = [];
  if (/runtime|management|console|permission|project|progress|schema|仓库|权限|控制|管理/u.test(text)) signals.push("expected_multi_turn", "stateful_context", "write_scope_owner");
  if (/review|复验|security|release|git|commit|push/u.test(text)) signals.push("independent_work_owner", "git_or_release_side_effect");
  if (!signals.length) signals.push("single_turn", "read_only_scan", "no_persistent_state", "no_global_task_ownership");
  return unique(signals);
}

function ensureRepositoryTarget(state, project, taskGroup, workItem, request) {
  const existing = state.repositoryOutputs.find((target) => target.taskGroupId === taskGroup?.id && target.workItemId === workItem?.id && target.status !== "superseded");
  if (existing) {
    existing.remote ||= request.remote || "origin";
    const existingRemoteUrl = gitRemoteUrl(request.root, existing.remote);
    if (existingRemoteUrl) existing.repositoryUrl = existingRemoteUrl;
    if (!existing.baseRef || existing.baseRef === "HEAD") {
      existing.baseRef = gitHead(request.root);
      existing.updatedAt = new Date().toISOString();
    }
    if (!existing.leaseRef && ["lease_bound", "writing", "committed", "pushed"].includes(existing.status)) ensureLease(state, existing);
    return existing;
  }
  const at = new Date().toISOString();
  const repository = project?.repositories?.[0] || {id: "repo_control_plane", url: "git@github.com:dleno/ai-multi-agent-ctrl.git", defaultBranch: "main"};
  const remote = request.remote || "origin";
  const remoteUrl = gitRemoteUrl(request.root, remote) || repository.url;
  const target = {
    schemaVersion: "repository-output-target/v1",
    targetId: createId("rot"),
    projectId: project?.id || "prj_control_plane",
    taskGroupId: taskGroup?.id || "tg_runtime_management",
    workItemId: workItem?.id || "work_unknown",
    repositoryId: repository.id,
    repositoryUrl: remoteUrl,
    remote,
    branch: repository.defaultBranch || "main",
    baseRef: gitHead(request.root),
    pathAllowlist: request.pathAllowlist || ["apps/control-plane-ui/**", "spec/**", "docs/**", "scripts/**", "data/**", "package.json", "Dockerfile", "docker-compose.yml"],
    pathDenylist: request.pathDenylist || request.forbiddenPathRules || [".runtime/**", ".git/**", "node_modules/**", ".env", ".env.local", ".env.production"],
    status: "selected",
    outputPolicy: "project_git_repository_only",
    decisionRecordRef: request.decisionRecordRef || `decision:repo-target:${workItem?.id || "work"}`,
    artifactManifestPath: request.artifactManifestPath || `docs/artifact-manifests/${workItem?.id || "work"}.json`,
    auditRef: request.auditRef || `audit:repo-target:${workItem?.id || "work"}`,
    createdAt: at,
    updatedAt: at
  };
  state.repositoryOutputs.push(target);
  // State-machine fidelity: a target superseded during rework (independent review) requires a
  // successor_output_target_ref. The successor is this freshly-created rework target, so back-link any
  // superseded target for the same work item that is still missing its successor — closing the audit trail
  // (superseded -> successor) that a bare status flip would otherwise leave dangling.
  for (const prior of state.repositoryOutputs) {
    if (prior !== target && prior.status === "superseded" && prior.taskGroupId === target.taskGroupId && prior.workItemId === target.workItemId && !prior.successorOutputTargetRef) {
      prior.successorOutputTargetRef = target.targetId;
      prior.updatedAt = at;
    }
  }
  return target;
}

function ensureLease(state, repositoryTarget, holderRef = "orchestrator", taskContractDigest) {
  let lease = state.leases.find((item) => item.resourceRef === `RepositoryOutputTarget:${repositoryTarget.targetId}` && item.status === "active");
  const at = new Date().toISOString();
  if (!lease) {
    state.leaseSequence = Number(state.leaseSequence || 0) + 1;
    lease = {
      leaseId: createId("lease"),
      resourceRef: `RepositoryOutputTarget:${repositoryTarget.targetId}`,
      holderRef,
      status: "active",
      fencingToken: state.leaseSequence,
      expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      taskContractDigest,
      auditRef: `audit:lease:${repositoryTarget.targetId}`,
      createdAt: at,
      updatedAt: at
    };
    state.leases.push(lease);
    state.leases = capLeaseHistory(state.leases);
  } else if (holderRef && lease.holderRef !== holderRef) {
    state.leaseSequence = Number(state.leaseSequence || 0) + 1;
    lease.transferEvidenceRefs = unique([...(lease.transferEvidenceRefs || []), `lease-transfer:${lease.holderRef}->${holderRef}:fence:${state.leaseSequence}`]);
    lease.previousHolderRef = lease.holderRef;
    lease.holderRef = holderRef;
    lease.fencingToken = state.leaseSequence;
    lease.taskContractDigest = taskContractDigest || lease.taskContractDigest;
    lease.updatedAt = at;
  } else {
    lease.taskContractDigest = taskContractDigest || lease.taskContractDigest;
    lease.updatedAt = at;
  }
  repositoryTarget.leaseRef = lease.leaseId;
  return lease;
}

export function recomputeTaskGroup(taskGroup) {
  const items = (taskGroup.workItems || []).filter((item) => item.status !== "superseded");
  taskGroup.progress = items.length ? Math.round(items.reduce((sum, item) => sum + Number(item.progress || 0), 0) / items.length) : 100;
  const blockedItems = items.filter((item) => BLOCKED_OR_FAILED_WORKITEM_STATUSES.includes(item.status));
  const executableCells = items.filter((item) => !BLOCKED_OR_FAILED_WORKITEM_STATUSES.includes(item.status) && !["verified", "closed"].includes(item.status));
  // A6 escalatable blocked cell = a genuine root-cause block, NOT an opt-in transient wait.
  const escalatableBlocked = blockedItems.filter((item) => !NON_ESCALATING_WAIT_CLASSES.has(item.blockerClass));
  // §4.5 single-cell-block guard + minimal-scope allow-list: a blocked cell must not escalate the
  // whole task group to a global block while an executable cell can still make progress; and even
  // with no executable cell, a group made up only of transient waits (window/quota/data-volume/
  // verification) stays "attention", never "blocked". Overall block requires zero executable cells
  // AND at least one genuine (non-wait) blocker.
  const overallBlockedPermitted = executableCells.length === 0 && escalatableBlocked.length > 0;
  taskGroup.singleCellEscalationGuard = {
    executableCells: executableCells.map((item) => item.id),
    blockedCells: blockedItems.map((item) => item.id),
    escalatableBlockedCells: escalatableBlocked.map((item) => item.id),
    waitingCells: blockedItems.filter((item) => NON_ESCALATING_WAIT_CLASSES.has(item.blockerClass)).map((item) => item.id),
    overallBlockedPermitted
  };
  if (!blockedItems.length) taskGroup.health = "ok";
  else if (overallBlockedPermitted) taskGroup.health = "blocked";
  else taskGroup.health = "attention";
  taskGroup.blockers = taskGroup.health === "ok" ? [] : taskGroup.blockers || [];
  const allTerminal = items.length > 0 && items.every((item) => ["verified", "closed"].includes(item.status));
  if (allTerminal && taskGroup.health === "ok" && !["closed", "aborted"].includes(taskGroup.status)) taskGroup.status = "verification";
  taskGroup.updatedAt = new Date().toISOString();
}

function activeSharedDefinitionRefs(state, request = {}) {
  const taskGroup = request.taskGroupId ? (state.taskGroups || []).find((item) => item.id === request.taskGroupId) : null;
  const workItem = request.workItemId ? (taskGroup?.workItems || []).find((item) => item.id === request.workItemId) : null;
  return relatedSharedDefinitions(state, taskGroup || {id: request.taskGroupId, projectId: request.projectId}, workItem).filter((definition) => definition.status === "active").map((definition) => ({
    contractRef: definition.contractId,
    definitionDigest: definition.definitionDigest,
    status: "active"
  }));
}

// 导出供契约测试断言作用域读写两侧一致 —— 这条链路曾整体失效而无人察觉。
export function relatedSharedDefinitionsForTest(state, taskGroup, workItem) {
  return relatedSharedDefinitions(state, taskGroup, workItem);
}

function relatedSharedDefinitions(state, taskGroup, workItem) {
  if (!taskGroup) return [];
  return (state.sharedDefinitions || []).filter((definition) => sharedDefinitionAppliesToWork(definition, taskGroup, workItem));
}

function sharedDefinitionAppliesToWork(definition, taskGroup, workItem) {
  if (!definition || !taskGroup) return false;
  if (definition.projectId && definition.projectId !== taskGroup.projectId) return false;
  const refs = new Set([...(definition.scopeRefs || []), ...(definition.consumerRefs || [])].filter(Boolean));
  // 去掉裸 "Project" 通配：它让任何调用方写一句 scopeRefs:["Project"] 就把契约作用到项目内的
  // 每个任务组（进而阻塞每个任务组的关闭门）。项目级作用域必须写明具体项目 id。
  const projectRefs = [`Project:${taskGroup.projectId}`, taskGroup.projectId];
  const taskGroupRefs = [`TaskGroup:${taskGroup.id}`, taskGroup.id];
  const workRefs = workItem ? [`WorkItem:${workItem.id}`, workItem.id] : [];
  if (!refs.size) return true;
  if (workRefs.some((ref) => refs.has(ref))) return true;
  if (taskGroupRefs.some((ref) => refs.has(ref))) return true;
  return projectRefs.some((ref) => refs.has(ref));
}

function leaseAppliesToTaskGroup(state, lease, taskGroupId) {
  const targetId = String(lease.resourceRef || "").split(":")[1];
  const target = (state.repositoryOutputs || []).find((item) => item.targetId === targetId);
  return target?.taskGroupId === taskGroupId;
}

const REVIEW_FINDING_LABELS = {
  repository_output_target_not_terminal: "仓库产出目标未到终态",
  push_evidence_missing: "缺少推送证据",
  artifact_manifest_missing: "缺少产物清单",
  final_commit_not_verifiable: "最终提交无法验证",
  changed_paths_outside_allowlist: "变更路径超出允许范围"
};
function reviewFindingLabel(code) { return REVIEW_FINDING_LABELS[code] || code; }

function addBlocker(taskGroup, severity, summary) {
  taskGroup.blockers ||= [];
  if (!taskGroup.blockers.some((blocker) => blocker.summary === summary)) {
    taskGroup.blockers.push({id: createId("blk"), severity, summary});
  }
  taskGroup.health = "blocked";
}

function findWorkItem(state, taskGroupId, workItemId) {
  const taskGroup = state.taskGroups?.find((item) => item.id === taskGroupId);
  const workItem = taskGroup?.workItems?.find((item) => item.id === workItemId);
  return workItem ? {...workItem, taskGroupId, projectId: taskGroup.projectId} : null;
}

function agentForRole(state, roleId) {
  return state.agents.find((agent) => agent.role === roleId && agent.status === "active") || state.agents.find((agent) => agent.status === "active");
}

function git(root = process.cwd(), args = [], fallback = "") {
  try {
    return execFileSync("git", ["-C", root, ...args], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim();
  } catch {
    return fallback;
  }
}

function gitStrict(root = process.cwd(), args = []) {
  return execFileSync("git", ["-C", root, ...args], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim();
}

export function gitHead(root = process.cwd()) {
  return git(root, ["rev-parse", "--short=12", "HEAD"], "000000000000");
}

export function gitRemoteUrl(root = process.cwd(), remote = "origin") {
  return git(root, ["remote", "get-url", remote], "");
}

function gitSnapshot(root = process.cwd()) {
  const run = (args, fallback) => {
    try {
      return execFileSync("git", ["-C", root, ...args], {encoding: "utf8"}).trim();
    } catch {
      return fallback;
    }
  };
  const head = run(["rev-parse", "--short=12", "HEAD"], "000000000000");
  const branch = run(["branch", "--show-current"], "main") || "main";
  const remoteSha = run(["rev-parse", "--short=12", `origin/${branch}`], head);
  const status = run(["status", "--short"], "");
  return {
    head,
    branch,
    remoteSha,
    treeDigest: digestOf({head, status})
  };
}

function gitIsAncestor(root, ancestor, descendant) {
  try {
    execFileSync("git", ["-C", root, "merge-base", "--is-ancestor", ancestor, descendant], {stdio: ["ignore", "pipe", "pipe"]});
    return true;
  } catch {
    return false;
  }
}

function gitRemoteSha(root, remote, ref) {
  const output = git(root, ["ls-remote", remote, ref], "");
  const line = output.split("\n").find(Boolean);
  return line?.split(/\s+/u)[0] || "";
}

function gitStatusPaths(root = process.cwd()) {
  return git(root, ["status", "--porcelain", "--untracked-files=all"], "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").pop())
    .filter(Boolean);
}

function gitPathExists(root, commit, path) {
  return git(root, ["cat-file", "-e", `${commit}:${path}`], "__missing__") !== "__missing__";
}

function normalizeGitRemoteUrl(url = "") {
  return String(url).trim().replace(/\.git$/u, "");
}

function credentialEnvNames(providerClass) {
  return {
    openai: ["OPENAI_API_KEY"],
    anthropic: ["ANTHROPIC_API_KEY"],
    google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    xai: ["XAI_API_KEY"],
    meta: ["META_API_KEY"],
    mistral: ["MISTRAL_API_KEY"],
    deepseek: ["DEEPSEEK_API_KEY"],
    qwen: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"],
    moonshot: ["MOONSHOT_API_KEY"],
    zhipu: ["ZHIPU_API_KEY"],
    baidu: ["BAIDU_API_KEY"],
    tencent: ["TENCENT_HUNYUAN_API_KEY"],
    openrouter: ["OPENROUTER_API_KEY"],
    azure_openai: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"],
    aws_bedrock: ["AWS_ACCESS_KEY_ID", "AWS_PROFILE"],
    vertex_ai: ["GOOGLE_APPLICATION_CREDENTIALS", "VERTEX_PROJECT_ID"],
    ollama: ["OLLAMA_HOST"],
    vllm: ["VLLM_ENDPOINT"],
    custom: ["AIMAC_CUSTOM_MODEL_ENDPOINT"]
  }[providerClass] || [];
}

function appendEvent(state, type, subjectType, subjectId, actorId, payload) {
  const event = {
    schemaVersion: "control-event/v1",
    protocolVersion: "control-plane/v1",
    schemaDigest: digestOf("spec/control-events.schema.json"),
    eventId: createId("evt"),
    projectId: payload?.projectId || "prj_control_plane",
    taskGroupId: payload?.taskGroupId,
    type,
    actor: {actorType: "service", actorId},
    subject: {type: subjectType, id: subjectId},
    stateVersion: state.stateVersion,
    idempotencyKey: payload?.idempotencyKey || createId("idem_event"),
    createdAt: new Date().toISOString(),
    payloadSchemaRef: payload?.payloadSchemaRef || `control-event-payload:${type}/v1`,
    payloadDigest: digestOf(payload || {}),
    payloadRef: `state-event:${subjectType}:${subjectId}`
  };
  state.eventLog.unshift(event);
  state.eventLog = state.eventLog.slice(0, 240);
  return event;
}

// Gap #1: resolve the effective enforcement mode for the runtime gate/transition engine.
// Default is "strict" (reject illegal transitions) because every recordTransition call site
// has been converged to legal, spec-modeled transitions. AIMAC_TRANSITION_STRICT overrides:
// false/warn -> log-and-record; true/strict -> reject; auto -> derive from executionProfile
// (verification/production strict, other profiles warn) as a documented safety valve.
function transitionEnforcementMode(state) {
  const raw = String(process.env.AIMAC_TRANSITION_STRICT ?? "").trim().toLowerCase();
  if (["0", "false", "warn", "off", "no"].includes(raw)) return "warn";
  if (["1", "true", "strict", "on", "yes"].includes(raw)) return "strict";
  if (raw === "auto") {
    const profile = state?.runtime?.executionProfile || process.env.AIMAC_EXECUTION_PROFILE || "production";
    return profile === "verification" || profile === "production" ? "strict" : "warn";
  }
  return "strict";
}

// recordTransition now validates every state-machine transition against the runtime engine
// before appending transitionEvidence. `requiresValues` maps each `requires` gate id of the
// modeled transition to its non-empty evidence value.
function recordTransition(state, machine, objectId, from, to, actor, requiresValues = {}) {
  try {
    assertTransition(state, machine, from, to, actor, requiresValues);
  } catch (error) {
    if (transitionEnforcementMode(state) === "strict") throw error;
    console.warn(`[transition-engine] rejected ${machine} ${from}->${to} by ${actor}: ${error.failureCode || error.code || error.message} (warn mode; transition still recorded)`);
  }
  const transition = {
    transitionId: createId("trn"),
    machine,
    objectId,
    from,
    to,
    actor,
    evidenceRefs: requiresValuesToEvidenceRefs(requiresValues),
    createdAt: new Date().toISOString()
  };
  state.transitionEvidence ||= [];
  state.transitionEvidence.unshift(transition);
  state.transitionEvidence = state.transitionEvidence.slice(0, 240);
  return transition;
}

function advanceWorkItemToReviewRequested(state, workItem, checkpoint) {
  const pathByStatus = {
    assigned: ["in_progress", "checkpoint_submitted", "review_requested"],
    in_progress: ["checkpoint_submitted", "review_requested"],
    checkpoint_submitted: ["review_requested"],
    code_complete: ["review_requested"],
    review_requested: []
  };
  const path = pathByStatus[workItem.status] || ["checkpoint_submitted", "review_requested"];
  let from = workItem.status;
  for (const to of path) {
    // Each segment uses its own modeled actor/gates (work-session for progress segments,
    // orchestrator for the review-request segment) rather than a single hardcoded actor.
    const modeled = canonicalTransition("WorkItem", from, to);
    const requiresValues = {};
    for (const gate of modeled?.requires || []) requiresValues[gate] = `checkpoint:${checkpoint.runId}:${gate}`;
    recordTransition(state, "WorkItem", workItem.id, from, to, modeled?.actor || "orchestrator", requiresValues);
    from = to;
  }
  workItem.status = "review_requested";
  workItem.reviewState = "review_requested";
}

const DEFAULT_SYSTEM_RULES = [
  {ruleId: "sys.product-intelligence-first", title: "产品智能优先总纲", content: "所有问题处理以 product-intelligence-first 为最高判断：目标是让正式产品在真实服务链路、真实数据、真实客户端、真实运行状态下正确/完整/可靠，而非让某样本/日志/字段/实例/页面/接口/gate 通过。任何问题不得把用户举例、单条日志、单字段、单实例、单页面、单接口或 raw 存储/传输/HTTP 观测当作天然边界，必须先提升到对应 problemFamily / 功能族 / 数据能力族 / 运行状态族 / 契约族，再决定修复与复验范围。每个非简单问题建三向影响图：upstreamSurface（producer/adapter/canonical owner/存储/缓存/消息队列/config-env overlay/scheduler/权限/数据预热补齐来源/runtime 拓扑）、peerSurface（同类接口/字段/页面、同端相邻模块、跨端对端、相邻环境/窗口/维度、同来源另一接口或腿、同 read model 其他消费者）、downstreamSurface（API/WS/read model/client store/各端展示交互刷新缓存/E2E/用户可见结果）。重大/重复/跨服务/数据/外部依赖/客户端主路径/多实例问题必须先做假设竞争：列出合理解释并用真实服务内链路逐一排除，不得一眼定案。根因修复必须落在被违反不变量的 canonical owner，不在 consumer/临时 env/清缓存/单实例 smoke/症状层掩盖上游。复验范围由 problemFamily + impactSurface 反推，而非由改了几个文件、用户举了哪个例、worker 自己修了哪里决定。关闭硬门（全满足才可关闭 finding；否则只能保持 open / repair_required / verification_incomplete / exact blocked_external|coverage_gap）：症状已提升为正确功能族；upstream/peer/downstream 已分析且未受影响部分有明确理由；rootCauseOwner 正确且未在 consumer/症状层掩盖上游；修复覆盖正常路径/旧状态/异常状态/跨端跨服务消费者/必要负向场景；复验范围由影响图决定并标注哪些已 pass、哪些仍是 exact gap。总控吸收 worker/review 结果时必须独立复核以上点——worker 只修症状、只测样本、只给局部 pass、只列证据不做语义判断、未说明同级面或上下游影响时，一律退回补充，不得吸收为完成。证据/gate/脚本/截图/日志只服务于智能判断，保持 MINIMAL-EFFECTIVE-EVIDENCE 不机械堆 raw dump，也不得用一句「AI 判断通过」替代上述分析。本总纲统领其余系统规则，冲突时以本总纲与最新 core-init 结论为准。"},
  {ruleId: "sys.review-dual-track", title: "互审双轨：既审当前方案也另寻更优", content: "任何互审/评审都必须同时走两条轨道，缺一不可，只做其中一条即为不合格评审。轨道一（方案内审查）：按当前方案的目标、边界、验收标准审查其执行是否正确、完整、有证据。轨道二（方案外求优）：跳出当前方案本身，重新回到【原始问题与目标】，判断这个方案本身是不是解决该问题的正确/最优路径，并至少给出一个可比较的替代方案，或明确说明已考察过哪些替代路径、为何当前方案更优。设立轨道二的原因：只沿既定方案往下审，会把一个本来就错的方向越做越精细——评审越勤，偏差越大；必须周期性回到问题本身，才可能发现方向错了，而不只是执行得不够好。触发即强制：方案/拓扑选择、任务拆分、验收、规则变更等核心决策的互审，必须在结论里显式记录 alternativesConsidered（考察过的替代路径及取舍理由）；为空视为评审未完成，不得据此推进。与既有规则的关系：轨道二只产出【提案与意见】，不构成擅自改动。发现更优方案时，一律通过人工确认通道提出（confirmation_analyze 的 better_alternative / incorrect），由人决定是否改变方案；AI 不得据自己的更优判断绕过已定稿方案或自行扩大改动范围——那属于 sys.scope-convergence 与角色漂移守卫的管辖，仍然禁止。即：想得更宽是义务，做得更宽要授权。"},
  {ruleId: "sys.risk-grading", title: "行为语义风险分级", content: "按真实运行影响面（L0–L3）而非文件路径/类名/所在层级定级；动手前先明确「级别 + 影响面 + 允许动作 + 验证方式 + 互审要求」；同一任务命中多档按最高风险执行。"},
  {ruleId: "sys.interrupt-recovery", title: "中断恢复先校主线", content: "接手/压缩/恢复后执行任何新动作前，先重新确认用户最终目标与最新修正、当前权威规则与验收标准、已完成/未完成/阻断项、真实运行状态是否支持旧记录、主线是否偏离；发现走偏立即停止支线、保留证据、回主线；纠偏时冻结有争议的推导分支再继续。"},
  {ruleId: "sys.temp-instrumentation", title: "临时测试插桩生命周期", content: "临时 debug/插桩须分配唯一 temp_id + 成对 marker + 每 run 唯一 manifest 登记；默认关闭、有界激活、精确清理；active 临时 hunk 不进普通提交/推送/构建；正式复验前必须停用+移除+按污染范围重建 run 状态；不得整文件回退或按 TODO/test 泛词删除；改变被测行为的 run 只作 diagnostic evidence。"},
  {ruleId: "sys.evidence-freshness", title: "证据新鲜度", content: "证据必须晚于变更真实生效点，并记录镜像/commit、实例 generation、启动时间、实际加载文件/构建摘要；过期或只剩历史观测标 historical_unverified，只作恢复线索，不能支撑当前完成结论，重测须生成新证据，不得原地改写历史 artifact。"},
  {ruleId: "sys.verification-target-binding", title: "验证目标层级绑定", content: "每条验证状态绑定具体对象 + 层级（plan/source/config/runtime/data/wire/client/capability/production）+ claimScope；方案/文档层「已修」不等于代码接线/运行正确/数据已供/客户端通过/生产达标；跨层完成声明必须分别引用每层证据，缺失层记 verification_incomplete/pending_window/blocked_external。"},
  {ruleId: "sys.completion-boundary", title: "完成声明边界", content: "「页面打开/接口 200/编译通过/没有继续报错/没有新日志」均不能单独作为完成证据；完成结论只覆盖已定义并执行的验证矩阵，明确列出未覆盖/外部阻断/待窗口项与恢复条件。"},
  {ruleId: "sys.observation-control", title: "观察通道正对照与可逆变异", content: "断言「0 行/无日志/无 key/无事件」前先用正对照证明观察通道、认证、库/分区、查询窗口有效；重要守卫交付前做可逆变异检验（制造应捕获的缺陷确认转红，还原转绿），变异前先清缓存/单例。"},
  {ruleId: "sys.precise-git-staging", title: "精确暂存禁止 add .", content: "用 git add <具体路径> 或 git add -p 暂存，提交前用 status/diff 核对归属，核对 git diff --cached，提交后核对 git show --stat 与 upstream；禁止 git add . / git add -A；不提交未知归属/他人 hunk/secret/原始证据/冲突标记。"},
  {ruleId: "sys.root-cause-owner", title: "根因落 canonical owner", content: "从用户可见入口沿链路反查 producer/consumer/owner，修复点落在被违反不变量的 canonical owner，不在症状点加默认值/别名/吞异常/私有推断/长期兼容分支掩盖上游；普通问题按根因批量收敛，P0/安全/资金/数据破坏/证据污染先最小留证 + 止血 + 隔离 + 升级，再按根因修复。根因不止代码 owner，还含过程性根因，须显式处置：规则/官方定义未被转成可执行不变量门（rules_not_converted_to_executable_invariant_gate）、无节点负责跨服务/跨组件不变量致症状被逐点分修（symptom_split_without_cross_cutting_invariant_owner）、证据门过窄、字段语义混用、回归测试缺失、信任恢复须先证据——修复应把规则转成可执行门、指派跨切面不变量 owner，而非只改代码点。"},
  {ruleId: "sys.environment-by-config", title: "环境由配置表达", content: "环境统一枚举（项目定义，如 local/dev/test/pre/prod），差异只由配置表达，不用 hostname/IP/容器名/路径/git 分支/机器职责推断业务环境。"},
  {ruleId: "sys.side-effect-authorization", title: "副作用授权与 fail-closed", content: "对会造成不可逆、外部可见或跨环境副作用的动作（正式/生产写入、真实 Provider/支付/KYC/下单等会产生状态变更、计费或不可逆结果的外部调用、删除或清理已有数据/凭据/资源、对外通知）默认禁止；仅在用户对 exact environment/identity/scope/action 明确授权后执行。只读、幂等的 owner-path 预热/补齐读取不属副作用动作，按 sys.readiness-provisioning 的幂等/去重/限流纪律执行，不受本条 per-action 授权约束。为确证 adapter/契约、或为交付重要守卫做可逆变异检验（见 sys.observation-control）所必需且已就对应 exact scope 获授权时，才做最小、受控、幂等或可回滚的探针，并预先声明副作用边界与回滚方式；未获授权时只允许在隔离/沙箱、无外部可见副作用、可逆的探针，任何触达真实外部/生产的探针仍按默认禁止处理。无法正向确证正确性、授权或数据完整性时，对资金/安全/权限/数据破坏类动作一律 fail-closed（拒绝或阻断，而非放行、默认值或吞异常）；命中 P0/安全/资金/数据破坏/证据污染的止血与升级按 sys.root-cause-owner 处置。"},
  {ruleId: "sys.time-semantics", title: "五类时间语义分类", content: "比较时间前先分类 instant/civilTime/businessCalendar/elapsedDuration/logicalOrder 并声明字段语义，比较方法先定义 exact/resolution-aware/tolerance/window；不同 role 不因都能转 UTC 就互换；elapsed 同进程用 monotonic，跨主机 wall-clock 差值须有 skew bound；因果顺序用 sequence/version/offset 不用时间戳替代。"},
  {ruleId: "sys.scope-convergence", title: "变更范围收敛", content: "本条约束的是【改动范围】，不约束【分析与提案范围】——按 sys.review-dual-track，互审必须跳出当前方案另寻更优解，那是义务而非违规；发现的更优方案通过人工确认通道提出，由人决定是否改变方案。变更图/范围冻结后仅「可定位真实引用 / 冻结契约新直接依赖 / P0安全数据破坏 / 已执行节点暴露的新 required 依赖」四类证据可扩【改动】范围，禁止「继续看看是否还有问题」式无界扫描；全量验证建版本化覆盖矩阵、按根因批量收敛，不以「无新增可疑点」为无限目标。"},
  {ruleId: "sys.full-chain-diagnosis", title: "运行事实全链路溯源", content: "把任何运行事实（键名/表名/前缀/头/序列化/时区/locale/env/命名空间等）判定为缺陷前，先沿全链路溯源：业务代码→helper/契约→framework/SDK/client adapter→依赖默认值→env/config overlay→容器/runtime→原始存储/传输观测→应用回读；任何 raw 外部观测须声明是否经 client/SDK 自动改写。若写入与回读走同一 canonical owner path 且回读通过，「物理名≠逻辑名」先归类为 evidence_probe_mismatch，不得据单点 raw 观测升级为 blocker 或擅改全局 prefix/config/key/schema；finding 只有溯源后才定性（source bug / config mismatch / runtime env mismatch / evidence probe mismatch / adapter bug / schema bug / true gap）。"},
  {ruleId: "sys.owner-path-verification", title: "服务内 owner-path 终判", content: "pass/fail、缺陷判定与修复验证必须在完整启动的服务实例内经真实程序路径（owner path / 应用 client / API / CLI / consumer / cron / WS / 框架配置的 SDK 路径）完成；raw 技术栈探针（如 redis-cli / 直连 DB / 队列 CLI / raw curl / grep 代码 / 单条日志 / 隔离 helper 单点等）只作定位、前后状态观测或负对照，非特殊情况不得单独作为最终 pass/fail 或修复方向依据；build/依赖安装/容器启动/HTTP 200/静态清单是前置条件而非验证。"},
  {ruleId: "sys.evidence-qualification", title: "弱证据结论重分类", content: "凡曾作为解锁/完成/正确性/资金安全 owner 判断依据、却主要基于 raw 探针或单点证据的历史结论，须按影响面重分类（must_reverify_now / defer_to_e2e / diagnostic_only_no_pass / already_service_verified）；分类即决定后续动作——must_reverify_now 立即经正确路径复验，defer_to_e2e 记待 E2E 复验，diagnostic_only_no_pass 降级为不承载 pass，already_service_verified 视为已服务内验证不重复复验；重分类是证据质量修正、不停止整体任务；任一 defer_to_e2e 一旦被用作解锁依据须升格为 must_reverify_now。证据的方法强度（不只是新鲜度）决定其可承载的结论范围。"},
  {ruleId: "sys.guard-reuse", title: "昂贵前置 guard 复用纪律", content: "昂贵的可部署性/前置 guard（构建、依赖安装、环境 provisioning、资源重建）是 required，但非每轮固定重跑：输入（依赖/构建输入/generation）未变且可证明时可复用，复用须登记依据与未作废理由（reused_previous_valid_guard + 上次证据 + 输入摘要），不得把「未执行」写成「新通过」；输入变化或进入正式 pass 前必须重跑。"},
  {ruleId: "sys.layered-admission", title: "分层准入与最小复验", content: "cell 因数据量/外部条件窗口/资源额度/设备/完整生产覆盖/多实例 formal gate 暂不能声明正式 pass，不等于不能执行当前条件下的真实验证：必须先产出受限当前条件的真实证据，未满足项精确登记为对应 pending_window/pending_data_volume/resource_queued/verification_incomplete/no_pass_preflight cell，绝不写成父级整体 blocked（仅真正影响全部可执行 cell 的 P0/安全/资金/数据破坏、不可隔离的共享资源、证据污染或全局基础设施不可用才允许整体 blocked）；条件满足后只复验受影响 cell，不因单个 reverify 触发机械重跑整个大项。准入不得混用 gating 状态字段——条件/资源/外部能力/证据资格是各自正交维度分别记录。FORMAL-PASS-GATE 与 CURRENT-CONDITION-EVIDENCE 必须严格分离：不能声明正式 pass 不得抑制对可跑部分产出当前条件 scoped 证据；defer/延期结论被用作解锁下游 runtime/数据门/资金风险 readiness/正式 pass 的依据时的升格规则见 sys.evidence-qualification。"},
  {ruleId: "sys.problem-family-bundle", title: "问题族捆绑修复", content: "（L0/孤立、无共享逻辑的小问题按 sys.risk-grading 说明为何孤立即可，不强制建族。）非简单问题默认先判定其 problemFamily，不得以「当前报错点→小补丁→独立评审→runtime/E2E 重跑→再发现相邻分支」的流水线推进。触发条件（任一）：同一 owner/组件/能力连续≥2 次 no-pass；问题涉及状态机/拓扑/owner-rebalance/持久状态；评审发现是相邻分支遗漏而非孤立 typo；runtime no-pass 说明 source 测试未覆盖完整运行不变量；用户指出同类反复。触发后暂停小补丁循环，先补完整问题族图→影响面扩展→一次性 bundled 修复（source/config/data/client）→一次族级评审→一次 scoped 复验；评审后仍发现同族相邻遗漏须回同一 bundle 补全再一次性复审，不得另开窄 follow-up。"},
  {ruleId: "sys.function-vs-sample-coverage", title: "功能面而非样本面", content: "任何问题必须功能级、全链路判断：用户举例只是线索不是边界，不能只修一个样本/页面/端/接口/服务/字段就关闭；每个发现主动扩展到可能影响的功能族/页面族/字段族/消费者。worker 与评审返回须分别报告 functionCoverage 与 sampleCoverage 及 adjacentBranchRisk；仅样本通过而功能面未证明不得关闭。"},
  {ruleId: "sys.mainline-compatibility", title: "主线兼容与诊断证据隔离", content: "选取执行 cell 前须确认它推进终态目标且不弱化被验证对象：不得用 mock/smoke/以单实例冒充多实例或 owner-rebalance 运行基线/raw-only/禁用依赖(Provider/socket/cron/consumer)/容器临时 env 覆盖业务开关等手段让验证「可跑」来形成正式结论。单实例本身在不依赖多实例/owner-rebalance 不变量的 cell 上仍是合法 owner-path 验证；仅当被验证不变量要求多实例时，单实例才降级为 diagnostic。诊断专用(diagnostic_only_no_pass)、静态清单、HTTP 200、raw 存储探针、弱化档位证据一律进 diagnostic_supporting_evidence，不得提高 mainline_progress 或任一主线门百分比，也不得解锁下游 cell 的前置。进度必须拆分 mainline_progress 与 diagnostic_supporting_evidence。"},
  {ruleId: "sys.resource-admission", title: "运行资源复用准入", content: "对可复用运行资源(环境/实例/沙箱/容器)做真实验证前须先 resourceAdmission：确认其 source/config/env/输入与当前验证目标匹配、未被其他 lane 占用或污染、不破坏 active evidence、不跨环境(dev/test/pre/prod/warmup)、不触发不允许的外部副作用。资源处于停止态不是不可复用理由——默认复用优先；仅当 source/config/env/vendor/build/input 不匹配才新建 run-owned 隔离资源，且必须记录 exact nonReuseReason 与证据，不得以「无正在运行可复用资源」或列表为空搪塞。"},
  {ruleId: "sys.readiness-provisioning", title: "就绪分层与 owner-path 补齐", content: "区分就绪层级：hot(主路径直接可读)/warm(后台预取中，允许短时 loading/partial/stale-with-status)/cold_on_demand(未预拉取)，与真实外部缺口(unsupported/quota_limited/temporarily_unavailable)必须分开——不得把「尚未补齐」当成真实无数据缺口。消费者发现缺口只能提交幂等、去重(single-flight/coalesce)、限流、可观测的 owner-path 补齐任务，不得直接回源第三方或触发无界全量回补；同一缺口须合并为一个 owner 任务。"},
  {ruleId: "sys.independent-review-depth", title: "独立评审语义深度", content: "独立评审不得只看 diff/测试通过：必须判断修复是否落在正确 canonical owner、是否覆盖对应功能族/正常/旧/异常/跨端跨服务消费者/必要负向场景、是否引入上下游或双端不一致、复验范围是否由影响图（upstream/peer/downstream）决定而非改了几个文件、支撑结论的 load-bearing 证据是否经服务内 owner-path 产生且新鲜、方法强度是否足以承载该结论（见 sys.owner-path-verification / sys.evidence-freshness / sys.evidence-qualification）。评审会话不得复用被审实现的推导上下文、不得继承其争议结论或 self-pass。命中 symptom-only/sample-only/局部 pass/只列证据不做语义判断/未说明同级面或上下游影响/以 raw 探针或过期证据支撑通过时一律退回补充而非放行。"}
].map((rule) => ({schemaVersion: "rule/v1", category: "system", status: "active", enabled: true, source: "default", ...rule}));

export function defaultSystemRules() {
  return DEFAULT_SYSTEM_RULES.map((rule) => ({...rule}));
}

export function defaultBusinessRules() {
  return [];
}

function stableRuleId(raw, category) {
  const explicit = String(raw.ruleId || "").trim();
  if (explicit) return explicit;
  const title = String(raw.title || "").trim();
  if (title) {
    const slug = title.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 48).replace(/^-+|-+$/gu, "");
    if (slug) return `${category}.${slug}`;
    // A non-Latin (e.g. Chinese) title slugifies to empty; derive a deterministic id from the title
    // digest so two distinct titles keep distinct, stable ids instead of colliding on a constant "rule".
    return `${category}.t-${digestOf(title).slice("sha256:".length, "sha256:".length + 16)}`;
  }
  // Deterministic id from content so a title-less rule keeps a stable id (and thus stable contentDigest) across reads.
  return `${category}.${digestOf(String(raw.content || "")).slice("sha256:".length, "sha256:".length + 16)}`;
}

function mergeRuleLayer(base, overlay, source, category) {
  const byId = new Map(base.map((rule) => [rule.ruleId, {...rule}]));
  for (const raw of overlay || []) {
    if (!raw || typeof raw !== "object") continue;
    const ruleId = stableRuleId(raw, category);
    const existing = byId.get(ruleId);
    const merged = {
      schemaVersion: "rule/v1",
      ruleId,
      // Category is authoritative from the array the rule lives in, never from client-supplied payload.
      category,
      title: raw.title ?? existing?.title ?? ruleId,
      content: raw.content ?? existing?.content ?? "",
      status: raw.status ?? existing?.status ?? "active",
      enabled: raw.enabled !== undefined ? raw.enabled !== false : (existing?.enabled ?? true),
      source: existing ? `${existing.source || "default"}+${source}` : source
    };
    byId.set(ruleId, merged);
  }
  return [...byId.values()];
}

// Memoize the per-rule content digest: it's a pure function of (ruleId, category, content), and the ~25
// invariant default-rule bodies (some multi-KB) were re-hashed on every buildTaskContract (every dispatch).
// Cache is bounded by the number of distinct rule contents in the system (defaults + capped overrides).
const ruleContentDigestCache = new Map();
function ruleContentDigest(ruleId, category, content) {
  // Length-prefix the first two fields so no (ruleId, category, content) triple can alias another
  // regardless of separator characters in the ids; content is last and needs no delimiter. (Plain
  // ASCII only — an earlier revision used a raw NUL separator that made the source file read as binary.)
  const key = `${ruleId.length}:${ruleId}|${category.length}:${category}|${content}`;
  const cached = ruleContentDigestCache.get(key);
  if (cached) return cached;
  const digest = digestOf({ruleId, category, content});
  if (ruleContentDigestCache.size >= 20000) ruleContentDigestCache.clear(); // backstop against unbounded growth
  ruleContentDigestCache.set(key, digest);
  return digest;
}

function resolveRuleCategory(defaults, projectRules, taskGroupRules, category) {
  const withProject = mergeRuleLayer(defaults, projectRules, "project", category);
  const withTaskGroup = mergeRuleLayer(withProject, taskGroupRules, "task_group", category);
  return withTaskGroup.map((rule) => ({...rule, category, contentDigest: ruleContentDigest(rule.ruleId, category, rule.content)}));
}

export function effectiveProjectConfig(project) {
  const base = project?.config || {};
  const systemRules = resolveRuleCategory(defaultSystemRules(), base.systemRules, null, "system");
  const businessRules = resolveRuleCategory(defaultBusinessRules(), base.businessRules, null, "business");
  return {
    projectId: project?.id,
    repositories: base.repositories ?? [],
    baselineData: base.baselineData ?? [],
    systemRules,
    businessRules,
    activeSystemRules: systemRules.filter((rule) => rule.enabled && rule.status === "active"),
    activeBusinessRules: businessRules.filter((rule) => rule.enabled && rule.status === "active"),
    defaultRoles: base.defaultRoles ?? []
  };
}

export function effectiveTaskGroupConfig(state, taskGroup) {
  const project = (state.projects || []).find((item) => item.id === taskGroup?.projectId);
  const base = project?.config || {};
  const overrides = taskGroup?.configOverrides || null;
  // 空数组覆盖视为"继承"（不冻结上层值）；configSource 仅在存在非空覆盖内容时才算"已自定义"。
  const overriddenKeys = ["repositories", "baselineData", "defaultRoles", "systemRules", "businessRules"];
  const hasOverride = Boolean(overrides) && overriddenKeys.some((key) => Array.isArray(overrides[key]) && overrides[key].length > 0);
  const pick = (key) => (Array.isArray(overrides?.[key]) && overrides[key].length ? overrides[key] : (base[key] ?? []));
  const systemRules = resolveRuleCategory(defaultSystemRules(), base.systemRules, overrides?.systemRules, "system");
  const businessRules = resolveRuleCategory(defaultBusinessRules(), base.businessRules, overrides?.businessRules, "business");
  return {
    configSource: hasOverride ? "customized" : "inherited",
    repositories: pick("repositories"),
    baselineData: pick("baselineData"),
    systemRules,
    businessRules,
    activeSystemRules: systemRules.filter((rule) => rule.enabled && rule.status === "active"),
    activeBusinessRules: businessRules.filter((rule) => rule.enabled && rule.status === "active"),
    defaultRoles: pick("defaultRoles")
  };
}

export function ensureTaskAnalysis(state, taskGroup) {
  if (!taskGroup) return null;
  const statusOf = (workItem) => {
    if (["verified", "closed"].includes(workItem.status)) return "completed";
    if (BLOCKED_OR_FAILED_WORKITEM_STATUSES.includes(workItem.status)) return "blocked";
    if (["draft", "ready"].includes(workItem.status)) return "pending";
    return "in_progress";
  };
  const noteOf = (workItem) => {
    if (workItem.blockedReason) return `受阻原因：${workItem.blockedReason}`;
    if (workItem.reviewState === "changes_requested") return "独立评审要求返工";
    if (workItem.status === "verified") return "已通过独立评审与验证";
    return "";
  };
  const majors = (taskGroup.workItems || []).filter((item) => !item.splitFrom);
  const childrenByParent = new Map();
  for (const item of (taskGroup.workItems || []).filter((child) => child.splitFrom)) {
    childrenByParent.set(item.splitFrom, [...(childrenByParent.get(item.splitFrom) || []), item]);
  }
  const items = majors.map((workItem, majorIndex) => {
    const splitChildren = childrenByParent.get(workItem.id) || [];
    const children = splitChildren.length
      ? splitChildren.map((child, childIndex) => ({
          itemId: `ta_${majorIndex + 1}_${childIndex + 1}`,
          title: child.title || child.id,
          kind: "minor",
          status: statusOf(child),
          progress: Math.max(0, Math.min(100, Number(child.progress || 0))),
          note: noteOf(child),
          workItemRefs: [child.id]
        }))
      : (workItem.requirements || []).slice(0, 20).map((requirement, childIndex) => ({
          itemId: `ta_${majorIndex + 1}_${childIndex + 1}`,
          title: String(requirement).slice(0, 200),
          kind: "minor",
          status: statusOf(workItem),
          progress: Math.max(0, Math.min(100, Number(workItem.progress || 0))),
          note: "",
          workItemRefs: [workItem.id]
        }));
    return {
      itemId: `ta_${majorIndex + 1}`,
      title: workItem.title || workItem.id,
      kind: "major",
      status: workItem.status === "superseded" ? "in_progress" : statusOf(workItem),
      progress: Math.max(0, Math.min(100, Number(workItem.progress || 0))),
      note: noteOf(workItem),
      workItemRefs: [workItem.id],
      children
    };
  });
  const contentDigest = digestOf(items);
  if (taskGroup.taskAnalysis?.contentDigest === contentDigest) return taskGroup.taskAnalysis;
  const at = new Date().toISOString();
  taskGroup.taskAnalysis = {
    schemaVersion: "task-analysis/v1",
    taskGroupId: taskGroup.id,
    items,
    contentDigest,
    generatedBy: "orchestrator",
    generatedAt: taskGroup.taskAnalysis?.generatedAt || at,
    updatedAt: at
  };
  return taskGroup.taskAnalysis;
}

export function ensureTaskGroupRole(state, taskGroup, roleId, addedBy = "auto") {
  if (!taskGroup || !roleId) return null;
  taskGroup.roles ||= [];
  let role = taskGroup.roles.find((item) => item.roleId === roleId);
  if (!role) {
    role = {roleId, status: "active", addedBy, addedAt: new Date().toISOString()};
    taskGroup.roles.push(role);
    if (addedBy === "auto") appendEvent(state, "progress", "TaskGroup", taskGroup.id, "scheduler", {autoAddedRole: roleId});
  }
  return role;
}

function revokeDispatchNodeBinding(state, dispatch, reason) {
  const at = new Date().toISOString();
  const previousNodeId = dispatch.assignedNodeId;
  if (previousNodeId) {
    for (const grant of state.mcpGrants || []) {
      if (grant.agentNodeId === previousNodeId && grant.dispatchId === dispatch.dispatchId && grant.grantStatus === "issued") {
        grant.grantStatus = "revoked";
        grant.revocationRef = `revocation:${reason}`;
        grant.updatedAt = at;
      }
    }
    const previousNode = (state.agentRuntimeNodes || []).find((item) => item.nodeId === previousNodeId);
    if (previousNode) previousNode.activeDispatchIds = (previousNode.activeDispatchIds || []).filter((id) => id !== dispatch.dispatchId);
    // Preserve the unbound node so the agent can still read its OWN terminal permission_status after the
    // deny/abandon cascade revokes its grant + clears assignedNodeId (else it polls a 403 until timeout).
    dispatch.previousNodeId = previousNodeId;
  }
  delete dispatch.assignedNodeId;
  delete dispatch.claimedAt;
  delete dispatch.claimExpiresAt;
}

export function cancelPendingConfirmationsForDispatch(state, dispatchId, reason) {
  const at = new Date().toISOString();
  for (const request of state.humanConfirmationRequests || []) {
    if (request.dispatchId === dispatchId && request.status === "pending") {
      request.status = "cancelled";
      request.cancelReason = reason;
      request.updatedAt = at;
      // 作废本身是合理的（派发已经没了，这张单再答也落不到任何执行上），但【不能就这样算了】：
      // 这张单是 AI 自己提出的问题，而它只要上报一次失败就能让人正要回答的问题凭空消失，
      // 同时 no_pending_human_confirmations 这道阻塞也一并清掉 —— 等于 AI 单方面撤掉了人的决策权。
      // 因此把对应工作项升级为人工决策：人仍有 resolve_decision 杠杆，关闭门也仍然被挡住。
      // （与"人工确认超时不得等于放行"是同一条原则。）
      const taskGroup = (state.taskGroups || []).find((item) => item.id === request.taskGroupId);
      const workItem = request.workItemId ? (taskGroup?.workItems || []).find((item) => item.id === request.workItemId) : null;
      if (workItem && !["verified", "closed", "superseded", "needs_decision"].includes(workItem.status)) {
        workItem.status = "needs_decision";
        workItem.blockedReason = "human_confirmation_cancelled_by_dispatch_failure";
        workItem.updatedAt = at;
      }
      if (taskGroup) addBlocker(taskGroup, "S2", `执行失败导致待人工确认的问题被作废，已升级为人工决策（不会静默放行）：${request.question?.summary || request.requestId}`);
      appendEvent(state, "decision", "HumanConfirmationRequest", request.requestId, "monitor", {
        taskGroupId: request.taskGroupId, cancelled: true, reason, escalatedToNeedsDecision: Boolean(workItem)
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// 人工定稿闸门 (human finalization gate)
//
// 系统不再有任何"AI 自动确认"路径。AI 可以提案、可以互审（peer review），但互审结论只是【建议】，
// 永远不能自己把一个核心决策推到终态。核心决策一律由**真人账号**确认才生效；人确认过的定稿方案，
// AI 不得默认自动改变，实质内容有分歧时必须回到人工确认。
// ---------------------------------------------------------------------------------------------------

// 核心/重大决策类别：这些一律强制阻塞 + 必须真人确认，没有任何配置可以关掉。
export const MAJOR_DECISION_TYPES = [
  "work_item_verification",   // 工作项验收（原先互审通过即自动 verified）
  "task_group_close",         // 任务组关闭定稿
  "plan_topology",            // 执行方案/拓扑选择
  "task_split",               // 任务拆分
  "rule_change"               // 规则/配置变更
];

// 只有真人账号可以定稿。service_account / agent_identity 一律不算"人"。
const HUMAN_ACCOUNT_TYPES = ["system_admin", "org_admin", "user_account"];

export function isHumanConfirmationActor(state, actorId) {
  if (!actorId) return false;
  const account = (state.accounts || []).find((item) => accountIdentity(item) === actorId);
  if (!account) return false;
  // 账号类型是人，还必须是【生效中】的账号：被停用/撤销/尚未接受邀请的账号不能拿来定稿。
  if (account.status !== "active") return false;
  return HUMAN_ACCOUNT_TYPES.includes(account.accountType);
}

// Mirrors accountIdOf in server.mjs — the actor string carried on a guarded write is the account id.
function accountIdentity(account) {
  return account?.accountId || account?.id || null;
}

// 定稿内容摘要：只覆盖【实质内容】。AI 之后要改这些字段就是"分歧"，必须重新回到人工确认。
export function decisionContentDigest(subject) {
  return digestOf({
    decisionType: subject.decisionType || null,
    workItemId: subject.workItemId || null,
    taskGroupId: subject.taskGroupId || null,
    content: subject.content ?? null
  });
}

export function createHumanConfirmationRequest(state, input = {}) {
  ensureRuntimeCollections(state);
  const decisionType = String(input.decisionType || "runtime_execution");
  const isMajor = MAJOR_DECISION_TYPES.includes(decisionType);
  // 核心决策（验收/关闭/方案/拆分/规则）可以没有在跑的 dispatch —— 它们是"方案定稿"而不是"运行时打断"。
  // 非核心的运行时确认仍必须绑定一个真实 dispatch（保持原有的节点归属校验）。
  const dispatch = (state.agentDispatches || []).find((item) => item.dispatchId === input.dispatchId) || null;
  if (!dispatch && !isMajor) throw Object.assign(new Error("dispatch_not_found"), {status: 404});
  if (dispatch && input.nodeId && dispatch.assignedNodeId !== input.nodeId) throw Object.assign(new Error("confirmation_dispatch_node_mismatch"), {status: 403});
  if (dispatch && input.taskGroupId && input.taskGroupId !== dispatch.taskGroupId) throw Object.assign(new Error("confirmation_task_group_mismatch"), {status: 409});
  const taskGroup = (state.taskGroups || []).find((item) => item.id === (dispatch?.taskGroupId || input.taskGroupId));
  if (!taskGroup) throw Object.assign(new Error("task_group_not_found"), {status: 404});
  const summary = String(input.question?.summary || input.summary || "").trim().slice(0, 300);
  if (!summary) throw Object.assign(new Error("human_confirmation_question_required"), {status: 400});
  const aiOptions = (Array.isArray(input.options) ? input.options : [])
    .filter((option) => option && String(option.label || "").trim())
    .slice(0, 8)
    .map((option, index) => ({
      optionId: String(option.optionId || `opt_${index + 1}`),
      label: String(option.label).trim().slice(0, 200),
      description: String(option.description || "").slice(0, 1000),
      ...(option.recommended === true ? {recommended: true} : {})
    }))
    .filter((option) => option.optionId !== "none");
  if (!aiOptions.length) throw Object.assign(new Error("human_confirmation_options_required"), {status: 400});
  // 去重键按【决策类别】加前缀隔离：运行时确认单与核心决策单永远不可能撞键。原先 agent 通道会
  // 把调用方的 requestKey 原样透传，而控制面自己的键是可猜的（plan_topology:<id> / task_split:<id>），
  // AI 抢先用同一个键提一张 operational 单，控制面那张红色核心决策卡片就直接被去重掉、根本不出现，
  // 人看到的是 AI 自己写的运行时文案（第五轮复现）。现在通道不再透传 requestKey，键也带类别前缀。
  const dedupeKey = `${decisionType}:` + (String(input.requestKey || "").trim()
    || digestOf({dispatchId: dispatch?.dispatchId || null, workItemId: input.workItemId || dispatch?.workItemId || null, summary}));
  // 去重必须限定在【同一个任务组】内。原先是全局按 dedupeKey 匹配并把命中的单子原样返回给调用方，
  // 而 requestKey 由调用方提供且可预测（task_split:<workItemId> / plan_topology:<topologyId>）——
  // 猜中就能拿到别的租户的确认单，连同人写的方案原文和协商记录一起泄露（已复现）。
  const existingPending = (state.humanConfirmationRequests || []).find((item) =>
    item.status === "pending" && item.dedupeKey === dedupeKey && item.taskGroupId === taskGroup.id);
  if (existingPending) return existingPending;
  const at = new Date().toISOString();
  const request = {
    schemaVersion: "human-confirmation-request/v1",
    requestId: createId("hcr"),
    projectId: taskGroup.projectId,
    taskGroupId: taskGroup.id,
    workItemId: input.workItemId || dispatch?.workItemId || null,
    sessionId: input.sessionId || dispatch?.sessionId || null,
    dispatchId: dispatch?.dispatchId || null,
    nodeId: input.nodeId || dispatch?.assignedNodeId || null,
    question: {
      summary,
      detail: String(input.question?.detail || input.detail || "").slice(0, 4000),
      evidenceRefs: unique(input.question?.evidenceRefs || input.evidenceRefs || []).slice(0, 20)
    },
    options: [...aiOptions, {optionId: "none", label: "不选择（自定义输入）", description: "以上选项均不采用，由人工直接输入确认内容。", system: true}],
    // 核心决策强制阻塞：blocking 原本由发起方(AI)自己决定，传 blocking:false 就能绕开人工闸门。
    // 对 MAJOR_DECISION_TYPES 一律忽略调用方的意见。
    blocking: isMajor ? true : input.blocking !== false,
    decisionClass: isMajor ? "major" : "operational",
    decisionType,
    // AI 互审结论只作为【建议】随单附上，供人参考；它本身永远不能定稿。
    ...(input.peerReview ? {peerReview: {
      verdict: String(input.peerReview.verdict || "unknown"),
      findings: unique(input.peerReview.findings || []).slice(0, 50),
      ...(input.peerReview.reviewRecordRef ? {reviewRecordRef: String(input.peerReview.reviewRecordRef)} : {}),
      // 互审双轨的轨道二随单呈现：人要看到"AI 有没有跳出这个方案想过别的路"，
      // 否则只会看到"按当前方案审查通过"，而看不到方案本身可能就是错的。
      ...((input.peerReview.alternativesConsidered || []).length
        ? {alternativesConsidered: input.peerReview.alternativesConsidered.slice(0, 10).map((item) => ({
            alternative: String(item.alternative || "").slice(0, 300),
            assessment: String(item.assessment || "").slice(0, 500)
          }))}
        : {})
    }} : {}),
    // 定稿锁的基线：人确认的就是这份内容的摘要，后续 AI 改动与之不符即为分歧。
    contentDigest: decisionContentDigest({decisionType, workItemId: input.workItemId || dispatch?.workItemId || null, taskGroupId: taskGroup.id, content: input.content ?? null}),
    ...(input.subjectRef ? {subjectRef: String(input.subjectRef)} : {}),
    round: 1,
    dedupeKey,
    status: "pending",
    expiresAt: input.expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: at,
    updatedAt: at
  };
  // 记下被确认对象在【出卡片这一刻】的实质内容快照，定稿时要重新核对（见 decideHumanConfirmation）。
  const snapshot = subjectContentSnapshot(state, request);
  if (snapshot !== undefined && snapshot !== null) request.subjectContentDigest = digestOf(snapshot);
  state.humanConfirmationRequests.unshift(request);
  if (request.blocking && dispatch && ["running", "queued"].includes(dispatch.status)) {
    dispatch.status = "blocked";
    dispatch.blockedReason = "awaiting_human_confirmation";
    dispatch.humanConfirmationRef = request.requestId;
    dispatch.updatedAt = at;
    const session = (state.workSessions || []).find((item) => item.sessionId === dispatch.sessionId);
    if (session && !WORK_SESSION_SETTLED_STATUSES.includes(session.status)) {
      session.status = "needs_decision";
      session.blockedReason = "awaiting_human_confirmation";
      session.updatedAt = at;
    }
    taskGroup.health = "attention";
    taskGroup.updatedAt = at;
  }
  appendEvent(state, "decision_request", "HumanConfirmationRequest", request.requestId, "agent-runtime", {taskGroupId: taskGroup.id, summary, blocking: request.blocking});
  return request;
}

// 人自己做了一个合法动作（豁免一道质量门、放弃一个格子），而这个动作恰好改变了某张待定稿卡片
// 的"被确认内容" —— 定稿时的快照比对随即把 finalize / reject / revise 三个动作全部拒掉，
// 人按下唯一的出路键，反而把自己钉死，只能等 7 天过期。
// 快照比对本身是对的（防的是 AI 在人点击前偷改），但它不该把【人自己的改动】也算成偷改。
// 正确处理：内容确实变了，就推进轮次并刷新快照，让人重新看一眼最新状态再决定；
// 若这个格子已经被放弃，那张卡就没有对象了，直接作废并留痕。
export function refreshConfirmationsAfterHumanChange(state, taskGroupId, workItemId, reason) {
  const at = new Date().toISOString();
  const affected = [];
  for (const request of state.humanConfirmationRequests || []) {
    if (request.status !== "pending" || request.taskGroupId !== taskGroupId) continue;
    if (workItemId && request.workItemId !== workItemId) continue;
    const snapshot = subjectContentSnapshot(state, request);
    if (snapshot === null) {
      request.status = "cancelled";
      request.cancelReason = reason;
      request.updatedAt = at;
      affected.push(request.requestId);
      continue;
    }
    if (snapshot === undefined) continue;
    const nextDigest = digestOf(snapshot);
    if (nextDigest === request.subjectContentDigest) continue;
    request.subjectContentDigest = nextDigest;
    request.round = Number(request.round || 1) + 1;
    request.awaitingAiAnalysis = false;
    request.deliberation = [...(request.deliberation || []), {
      round: request.round, actorKind: "human", actor: reason.actor || "human",
      action: "propose", summary: `人工操作改变了被确认内容：${reason.summary || reason}`, at
    }];
    request.updatedAt = at;
    affected.push(request.requestId);
  }
  return affected;
}

export function decideHumanConfirmation(state, requestId, decision = {}, options = {}) {
  ensureRuntimeCollections(state);
  const request = (state.humanConfirmationRequests || []).find((item) => item.requestId === requestId);
  if (!request) throw Object.assign(new Error("human_confirmation_not_found"), {status: 404});
  if (request.status !== "pending") throw Object.assign(new Error("human_confirmation_not_pending"), {status: 409});
  const selectedOptionId = String(decision.selectedOptionId || "");
  const option = (request.options || []).find((item) => item.optionId === selectedOptionId);
  if (!option) throw Object.assign(new Error("human_confirmation_option_invalid"), {status: 400});
  const inputText = String(decision.inputText || "").trim().slice(0, 4000);
  if (selectedOptionId === "none" && !inputText) throw Object.assign(new Error("human_confirmation_input_required_for_none"), {status: 400});
  // 防 TOCTOU：AI 在人点击前修订了候选方案时，人看到的轮次已经过期。带上 expectedRound 的调用（控制台
  // 总是带）必须与当前轮次一致，否则拒绝，让人重新看过修订后的方案再定。
  // 核心决策【必须】带轮次令牌：可选校验等于没校验（省略即跳过，任何非控制台客户端都能绕开）。
  if (request.decisionClass === "major" && decision.expectedRound === undefined) {
    throw Object.assign(new Error("human_confirmation_expected_round_required"), {status: 400, currentRound: Number(request.round || 1)});
  }
  if (decision.expectedRound !== undefined && Number(decision.expectedRound) !== Number(request.round || 1)) {
    throw Object.assign(new Error("human_confirmation_round_stale"), {status: 409, currentRound: Number(request.round || 1)});
  }
  // 通用不变式：定稿那一刻，被绑定的对象必须还是出卡片时的那个样子。对象在此期间被改过（AI 换了执行
  // 模式/载体/分支），就不能把你的批准算到新内容上 —— 拒绝，让你重新看过。这是对"卡片说 X、锁绑 Y"
  // 那一类绕过的结构性封堵（前两轮各被绕过一次，逐字段设防不够）。
  if (request.subjectContentDigest) {
    const currentSnapshot = subjectContentSnapshot(state, request);
    if (currentSnapshot === null) throw Object.assign(new Error("human_finalization_subject_missing"), {status: 409, subjectRef: request.subjectRef || null});
    if (digestOf(currentSnapshot) !== request.subjectContentDigest) {
      throw Object.assign(new Error("human_confirmation_subject_changed"), {status: 409, subjectRef: request.subjectRef || null});
    }
  }
  // 定稿权只属于真人。机器主体（service_account / agent_identity）即使被授予了权限也不能确认核心决策 ——
  // 否则 AI 只要拿到一个服务账号就能自己批准自己的方案，闸门形同虚设。
  if (request.decisionClass === "major" && !isHumanConfirmationActor(state, options.actor)) {
    throw Object.assign(new Error("human_confirmation_requires_human_actor"), {status: 403});
  }
  const at = new Date().toISOString();
  const actor = options.actor || "unknown";
  // 人工动作分三种。协商是多轮的：只有【定稿】这一步才终结并上锁，其余都让请求继续挂着（继续阻塞执行）。
  //   revise   —— 人提出自己的方案/修改意见。**不直接生效**：转给 AI 再分析（AI 可指出不合理或给更优方案）。
  //   reject   —— 打回返工。
  //   finalize —— 明确选择定稿。到此为止 AI 不得再改（applyHumanFinalization 上锁）。
  // 默认值必须 fail-safe：核心决策在动作缺失时按【revise】处理（不可逆的定稿绝不能靠默认值发生），
  // 运行时确认单保留原有的 finalize 默认（它不锁定任何东西，只是回答一个执行期问题）。
  const action = ["revise", "reject", "finalize"].includes(decision.action)
    ? decision.action
    : (selectedOptionId === "none" || request.decisionClass === "major" ? "revise" : "finalize");
  request.round = Number(request.round || 1);
  request.deliberation ||= [];

  if (action === "revise") {
    request.deliberation.push({
      round: request.round, actorKind: "human", actor, action: "propose",
      summary: String(inputText || option.label).slice(0, 300), ...(inputText ? {detail: inputText} : {}), at
    });
    request.round += 1;
    // 交回 AI 再分析：人提的方案不等于直接采纳，AI 仍要判断是否正确、有无更优解。
    request.awaitingAiAnalysis = true;
    request.updatedAt = at;
    appendEvent(state, "decision_request", "HumanConfirmationRequest", request.requestId, actor, {
      taskGroupId: request.taskGroupId, action: "human_revision_proposed", round: request.round
    });
    return request;
  }

  request.status = "answered";
  request.decision = {selectedOptionId, selectedLabel: option.label, inputText, decidedBy: actor, decidedAt: at, action};
  request.deliberation.push({
    round: request.round, actorKind: "human", actor, action,
    summary: `${action === "finalize" ? "定稿" : "打回"}：${option.label}`.slice(0, 300), ...(inputText ? {detail: inputText} : {}), at
  });
  delete request.awaitingAiAnalysis;
  request.updatedAt = at;
  // 人一旦定稿：把这次确认的内容摘要锁死。后续 AI 想改实质内容，必须重新走人工确认（见 assertHumanFinalization）。
  if (request.decisionClass === "major") applyHumanFinalization(state, request, actor, at, action);
  if (request.dispatchId) {
    const dispatch = (state.agentDispatches || []).find((item) => item.dispatchId === request.dispatchId);
    if (dispatch && dispatch.status === "blocked" && dispatch.blockedReason === "awaiting_human_confirmation") {
      dispatch.status = "queued";
      delete dispatch.blockedReason;
      revokeDispatchNodeBinding(state, dispatch, "human_confirmation_answered_requeued");
      dispatch.updatedAt = at;
      const session = (state.workSessions || []).find((item) => item.sessionId === dispatch.sessionId);
      if (session && session.status === "needs_decision" && session.blockedReason === "awaiting_human_confirmation") {
        session.status = "active";
        delete session.blockedReason;
        session.updatedAt = at;
      }
    }
  }
  appendEvent(state, "decision", "HumanConfirmationRequest", request.requestId, options.actor || "human-reviewer", {selectedOptionId, hasInput: Boolean(inputText)});
  return request;
}

// 把一个被确认对象的【实质内容】投影成可比对的快照。定稿单创建时记一份，定稿时再算一份，
// 两者必须一致 —— 这条不变式的意思是"你批准的必须还是你当时看到的那个东西"。
// 前两轮的绕过都属同一类：人看到的卡片描述 X，锁却绑到了对象 Y。逐个堵字段是打地鼠，
// 这里改为在定稿那一刻按活对象重算，内容对不上就拒绝定稿，让人重新看过。
function subjectContentSnapshot(state, request) {
  if (request.decisionType === "plan_topology") {
    const id = String(request.subjectRef || "").replace(/^ExecutionTopology:/u, "");
    const topology = (state.executionTopologies || []).find((item) => item.topologyId === id);
    if (!topology) return null;
    // 必须覆盖真正的【杀伤面】：只锁 mode/载体/分支名的话，AI 把某分支的 ownedPaths 从 docs/** 改成
    // apps/**、把 acceptanceChecks 改成恒真，摘要照样不变，人的批准就被套到一个大得多的授权上。
    return {
      mode: topology.mode,
      runnerKind: topology.runnerKind,
      isolation: topology.isolation,
      branches: (topology.groups || []).flatMap((group) => (group.branches || []).map((branch) => ({
        branchId: branch.branchId,
        objective: branch.objective,
        ownedPaths: [...(branch.ownedPaths || [])].sort(),
        forbiddenPaths: [...(branch.forbiddenPaths || [])].sort(),
        resourceScopes: [...(branch.resourceScopes || [])].sort(),
        acceptanceChecks: [...(branch.acceptanceChecks || [])].sort()
      })))
    };
  }
  if (request.decisionType === "work_item_verification") {
    // 先前这里返回 undefined，理由是"验收绑定的是确定的工作项本身"。但 TOCTOU 防的不是【指向谁】
    // 变了，而是【那个东西的内容】变了：人批准的是"这份成果通过验收"，而成果就是提交/推送/产出目标
    // 与质量门这些证据。卡片挂着的时候若又跑了一轮，人的定稿就落在另一份成果上 —— 而定稿之后
    // 互审会永久跳过该工作项，那些改动再也不会被复核。所以这里必须锁住证据面。
    const workItemId = String(request.subjectRef || "").replace(/^WorkItem:/u, "") || request.workItemId;
    const taskGroup = (state.taskGroups || []).find((item) => item.id === request.taskGroupId);
    const workItem = (taskGroup?.workItems || []).find((item) => item.id === workItemId);
    if (!workItem) return null;
    const checkpoint = (state.checkpoints || [])
      .filter((item) => item.taskGroupId === request.taskGroupId && (item.workId === workItemId || item.workItemId === workItemId))
      .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))[0];
    return {
      workItemStatus: workItem.status,
      reviewState: workItem.reviewState || null,
      commitRefs: [...(checkpoint?.commitRefs || [])].map((ref) => ref.commit || ref).sort(),
      pushRefs: [...(checkpoint?.pushRefs || [])].map((ref) => `${ref.remote || ""}:${ref.ref || ""}:${ref.remoteSha || ""}`).sort(),
      artifactManifestRefs: [...(checkpoint?.artifactManifestRefs || [])].sort(),
      repositoryOutputs: (state.repositoryOutputs || [])
        .filter((target) => target.taskGroupId === request.taskGroupId && target.workItemId === workItemId)
        .map((target) => `${target.targetId}:${target.status}`).sort(),
      qualityGates: (state.qualityGates || [])
        .filter((gate) => gate.taskGroupId === request.taskGroupId && gate.workItemId === workItemId)
        .map((gate) => `${gate.gateType}:${gate.status}:${gate.previouslyFailed ? "prev_failed" : "clean"}`).sort()
    };
  }
  // task_group_close 不走确认单：它是 computeCloseBarrier 里"算完当场落闸"的一次调用，
  // 落闸前重算门禁并要求真人身份，中间没有 TOCTOU 窗口。这里不放分支，是为了不留一段
  // 看着像防护、实际永不执行的代码。
  return undefined; // 拆分绑定的是确定的工作项本身，且拆分方案本身就写在卡片正文里
}

// 人定稿后的落地 + 上锁。这里是**唯一**能把工作项推到 verified 的路径（AI 互审只能推到 verification_ready）。
function applyHumanFinalization(state, request, actor, at, action = "finalize") {
  // 是否否决【只看人点的动作】。原先还看 selectedOptionId === "reject"，而选项 id 与文案都可能是 AI
  // 写的：AI 把 id 为 accept 的选项文案改成"打回返工"，人以为在打回，实际触发的是通过（已复现）。
  const rejected = action === "reject";
  const taskGroup = (state.taskGroups || []).find((item) => item.id === request.taskGroupId);
  const workItem = request.workItemId ? (taskGroup?.workItems || []).find((item) => item.id === request.workItemId) : null;
  const lock = {
    finalizedBy: actor,
    finalizedAt: at,
    confirmationRef: request.requestId,
    contentDigest: request.contentDigest,
    decisionType: request.decisionType,
    // 定稿那一刻对象的实质内容摘要 —— 之后 start/merge 会拿它比对，AI 改了方案就走分歧拦截。
    ...(request.subjectContentDigest ? {subjectContentDigest: request.subjectContentDigest} : {}),
    outcome: rejected ? "rejected" : "confirmed"
  };
  if (request.decisionType === "work_item_verification" && workItem) {
    if (rejected) {
      // 人否决 = 打回返工，交回人工决策通道（resolve_decision 可 reopen/abandon）。
      workItem.status = "needs_decision";
      workItem.blockedReason = "human_verification_rejected";
    } else {
      // 只有到这里才允许 verified —— 而且 actor 是真人，转移证据里留的是人的身份。
      recordTransition(state, "WorkItem", workItem.id, workItem.status, "verified", "qa", {
        verification_evidence: `human_confirmation:${request.requestId}:${actor}`
      });
      workItem.status = "verified";
      workItem.progress = 100;
      delete workItem.blockedReason;
    }
    workItem.humanFinalization = lock;
    workItem.updatedAt = at;
  } else if (request.decisionType === "task_group_close" && taskGroup) {
    taskGroup.humanFinalization = lock;
    taskGroup.updatedAt = at;
  } else if (request.decisionType === "task_split" && workItem) {
    // 拆分方案已定稿：把工作项从"待人工定稿"释放回 ready，下一轮编排器按定稿方案执行（或按否决不拆分）。
    workItem.humanFinalization = lock;
    if (workItem.status === "needs_decision" && workItem.blockedReason === "awaiting_human_split_confirmation") {
      workItem.status = "ready";
      delete workItem.blockedReason;
    }
    workItem.updatedAt = at;
  } else if (request.decisionType === "plan_topology") {
    // 方案定稿必须落在【这张确认单所针对的那一份拓扑】上。原先按 workItemId 查最新非终态拓扑，
    // AI 只要在人点确认前再建一份拓扑，就能把人的批准"洗"到自己那份上（已复现的绕过）。
    const subjectId = String(request.subjectRef || "").startsWith("ExecutionTopology:")
      ? String(request.subjectRef).slice("ExecutionTopology:".length)
      : null;
    const topology = subjectId ? (state.executionTopologies || []).find((item) => item.topologyId === subjectId) : null;
    // Fail closed：定稿必须落到确定的对象上。落不到（缺 subjectRef 的历史遗留单、或拓扑已被替换/清理）
    // 时绝不能静默返回 200 —— 那样控制台显示"已定稿"，而 start 会永远报缺少人工方案确认。
    if (!topology) throw Object.assign(new Error("human_finalization_subject_missing"), {status: 409, subjectRef: request.subjectRef || null});
    topology.humanFinalization = lock; topology.updatedAt = at;
    // 工作项上只记溯源引用，不写定稿锁：写了会被 performIndependentReview 误判为"已定稿"而永久跳过验收。
    if (workItem) { workItem.planFinalizationRef = request.requestId; workItem.updatedAt = at; }
  } else if (workItem) {
    workItem.humanFinalization = lock;
    workItem.updatedAt = at;
  }
  appendEvent(state, "decision", "HumanConfirmationRequest", request.requestId, actor, {
    taskGroupId: request.taskGroupId, decisionType: request.decisionType, outcome: lock.outcome, humanFinalized: true
  });
  return lock;
}

// AI 的再分析通道。人提出自己的方案后（revise），AI 必须在这里给出判断：是否正确、有没有不合理之处、
// 有没有更优方式，并可据此修订候选方案。**这是 AI 在确认流程里唯一能做的事** —— 它可以反对、可以给更好的
// 方案，但永远不能把请求推到 answered/定稿；决定权始终在人手上。
export function submitAiConfirmationAnalysis(state, requestId, input = {}, options = {}) {
  ensureRuntimeCollections(state);
  const request = (state.humanConfirmationRequests || []).find((item) => item.requestId === requestId);
  if (!request) throw Object.assign(new Error("human_confirmation_not_found"), {status: 404});
  if (request.status !== "pending") throw Object.assign(new Error("human_confirmation_not_pending"), {status: 409});
  // 只能在【人确实把球踢回给 AI】时再分析。否则 AI 可以不停调用它推进轮次，让人手里的 expectedRound
  // 永远过期，核心决策再也定不了稿（活锁）。首轮（AI 自己发起的提案）也允许一次，供它补充分析。
  if (!request.awaitingAiAnalysis && Number(request.round || 1) > 1) {
    throw Object.assign(new Error("human_confirmation_not_awaiting_ai_analysis"), {status: 409});
  }
  const assessment = ["agree", "concerns", "better_alternative", "incorrect"].includes(input.assessment) ? input.assessment : "concerns";
  const summary = String(input.summary || "").trim().slice(0, 300);
  if (!summary) throw Object.assign(new Error("ai_analysis_summary_required"), {status: 400});
  const at = new Date().toISOString();
  request.round = Number(request.round || 1);
  request.deliberation ||= [];
  request.deliberation.push({
    round: request.round,
    actorKind: "ai",
    actor: options.actor || "agent-runtime",
    action: "analysis",
    assessment,
    summary,
    ...(input.detail ? {detail: String(input.detail).slice(0, 4000)} : {}),
    ...(Array.isArray(input.concerns) && input.concerns.length ? {concerns: unique(input.concerns).slice(0, 20)} : {}),
    at
  });
  // AI 可以在再分析后修订候选方案（例如把人提的方案补成可执行的版本，或加入它认为更优的选项），
  // 但系统的"自定义输入"选项恒在，人始终可以不采纳任何 AI 选项。
  // AI 提的选项一律进 `ai:` 命名空间，且【只能追加】不能顶掉控制面自己的语义选项。
  // 否则 AI 拥有了选项 id 与文案的全部所有权：它可以删掉"打回返工"、把 id=accept 的选项写成
  // "打回返工：证据不足"，人点下去实际是通过（已复现）。语义选项的所有权必须留在控制面。
  const revised = (Array.isArray(input.options) ? input.options : [])
    .filter((option) => option && String(option.label || "").trim() && option.optionId !== "none")
    .slice(0, 8)
    .map((option, index) => ({
      optionId: `ai:${String(option.optionId || `r${request.round}_opt_${index + 1}`).replace(/^ai:/u, "")}`,
      label: String(option.label).trim().slice(0, 200),
      description: String(option.description || "").slice(0, 1000),
      ...(option.recommended === true ? {recommended: true} : {})
    }));
  if (revised.length) {
    const controlPlaneOptions = (request.options || []).filter((option) => !String(option.optionId).startsWith("ai:") && option.optionId !== "none");
    request.options = [...controlPlaneOptions, ...revised, (request.options || []).find((option) => option.optionId === "none")
      || {optionId: "none", label: "不选择（自定义输入）", description: "以上选项均不采用，由人工直接输入确认内容。", system: true}];
    // 候选方案变了就必须推进轮次：人手上那一版已经过期，带旧 expectedRound 的确认会被拒（防 TOCTOU）。
    request.round += 1;
    // 方案有改动 => 定稿基线随之更新（人最终定稿时锁的是那一刻的内容）。
    request.contentDigest = decisionContentDigest({
      decisionType: request.decisionType, workItemId: request.workItemId, taskGroupId: request.taskGroupId,
      content: {round: request.round, options: request.options.map((option) => option.optionId + ":" + option.label)}
    });
  }
  delete request.awaitingAiAnalysis;
  request.updatedAt = at;
  appendEvent(state, "decision_request", "HumanConfirmationRequest", request.requestId, options.actor || "agent-runtime", {
    taskGroupId: request.taskGroupId, action: "ai_analysis", assessment, round: request.round
  });
  return request;
}

export function consumeHumanConfirmation(state, requestId, options = {}) {
  const request = (state.humanConfirmationRequests || []).find((item) => item.requestId === requestId);
  if (!request) throw Object.assign(new Error("human_confirmation_not_found"), {status: 404});
  if (request.status === "answered") {
    request.status = "consumed";
    request.consumedBy = options.actor || "agent-runtime";
    request.updatedAt = new Date().toISOString();
  }
  return request;
}

export function createHumanDirective(state, input = {}, options = {}) {
  ensureRuntimeCollections(state);
  const taskGroup = input.taskGroupId ? (state.taskGroups || []).find((item) => item.id === input.taskGroupId) : null;
  const projectId = taskGroup?.projectId || input.projectId;
  if (!projectId) throw Object.assign(new Error("human_directive_project_required"), {status: 400});
  const directiveType = ["pause", "resume", "cancel", "adjust_priority", "add_requirement", "resolve_decision", "free_text"].includes(input.directiveType)
    ? input.directiveType
    : "free_text";
  const instruction = String(input.instruction || "").trim().slice(0, 4000);
  if (!instruction && directiveType === "free_text") throw Object.assign(new Error("human_directive_instruction_required"), {status: 400});
  const resolution = directiveType === "resolve_decision"
    ? (["reopen", "abandon"].includes(input.resolution) ? input.resolution : "reopen")
    : null;
  const at = new Date().toISOString();
  const directive = {
    schemaVersion: "human-directive/v1",
    directiveId: createId("hd"),
    projectId,
    taskGroupId: taskGroup?.id || null,
    directiveType,
    instruction,
    ...(directiveType === "resolve_decision" ? {resolution, workItemId: input.workItemId || null} : {}),
    issuedBy: options.actor || "unknown",
    status: "queued",
    appliedActions: [],
    createdAt: at,
    updatedAt: at
  };
  state.humanDirectives.unshift(directive);
  appendEvent(state, "command_created", "HumanDirective", directive.directiveId, options.actor || "human-operator", {directiveType, taskGroupId: directive.taskGroupId});
  return directive;
}

export function expireStaleHumanConfirmations(state) {
  const nowMs = Date.now();
  const at = new Date().toISOString();
  const expired = [];
  for (const request of (state.humanConfirmationRequests || []).filter((item) => item.status === "pending")) {
    if (!request.expiresAt || new Date(request.expiresAt).getTime() > nowMs) continue;
    request.status = "expired";
    request.updatedAt = at;
    // 超时【绝不】等于放行。原先这里把 dispatch 从 blocked 改回 queued 让它继续跑，等于给每一道人工闸门
    // 开了一条 7 天绕过通道；一个没人回答的问题会变成绿灯。现在改为升级为人工决策，仍然停住。
    if (request.dispatchId) {
      const dispatch = (state.agentDispatches || []).find((item) => item.dispatchId === request.dispatchId);
      if (dispatch && dispatch.status === "blocked" && dispatch.blockedReason === "awaiting_human_confirmation") {
        dispatch.blockedReason = "human_confirmation_expired_needs_decision";
        dispatch.updatedAt = at;
      }
    }
    const taskGroup = (state.taskGroups || []).find((item) => item.id === request.taskGroupId);
    // 把对应工作项降级到 needs_decision，让 resolve_decision（人工指令通道）成为可达的杠杆。
    const expiredWorkItem = request.workItemId ? (taskGroup?.workItems || []).find((item) => item.id === request.workItemId) : null;
    if (expiredWorkItem && !["verified", "closed", "superseded", "needs_decision"].includes(expiredWorkItem.status)) {
      expiredWorkItem.status = "needs_decision";
      expiredWorkItem.blockedReason = "human_confirmation_expired";
      expiredWorkItem.updatedAt = at;
    }
    if (taskGroup) addBlocker(taskGroup, "S2", `人工确认请求超时未作答，已升级为人工决策（不会自动放行）：${request.question?.summary || request.requestId}`);
    expired.push(request.requestId);
    appendEvent(state, "decision", "HumanConfirmationRequest", request.requestId, "monitor", {expired: true});
  }
  return expired;
}

export function consumeQueuedHumanDirectives(state, request = {}) {
  const applied = [];
  // Apply oldest-first (FIFO): humanDirectives is stored newest-first (unshift), so reverse the
  // queued set — otherwise last-writer-wins fields (e.g. adjust_priority's priorityHint) would let an
  // OLDER directive overwrite a newer one, silently dropping the user's most recent intent.
  for (const directive of (state.humanDirectives || []).filter((item) => item.status === "queued").reverse()) {
    const at = new Date().toISOString();
    directive.status = "acknowledged";
    directive.updatedAt = at;
    const taskGroup = directive.taskGroupId ? (state.taskGroups || []).find((item) => item.id === directive.taskGroupId) : null;
    try {
      if (directive.directiveType === "pause" && taskGroup) {
        taskGroup.goalExecutionStatus = "active_paused_by_freeze";
        taskGroup.pauseReason = "human_directive";
        directive.appliedActions.push({action: "task_group_pause", ref: `TaskGroup:${taskGroup.id}`});
      } else if (directive.directiveType === "resume" && taskGroup) {
        taskGroup.goalExecutionStatus = "active";
        delete taskGroup.pauseReason;
        directive.appliedActions.push({action: "task_group_resume", ref: `TaskGroup:${taskGroup.id}`});
      } else if (directive.directiveType === "cancel" && taskGroup) {
        taskGroup.goalExecutionStatus = "active_paused_by_freeze";
        taskGroup.pauseReason = "human_directive_cancel";
        for (const dispatch of (state.agentDispatches || []).filter((item) => item.taskGroupId === taskGroup.id && ["queued", "blocked"].includes(item.status))) {
          dispatch.status = "cancelled";
          dispatch.failureReason = "human_directive_cancel";
          cancelPendingConfirmationsForDispatch(state, dispatch.dispatchId, "human_directive_cancel");
          revokeDispatchNodeBinding(state, dispatch, "human_directive_cancel");
          dispatch.updatedAt = at;
          const session = (state.workSessions || []).find((item) => item.sessionId === dispatch.sessionId);
          if (session && !WORK_SESSION_SETTLED_STATUSES.includes(session.status)) {
            session.status = "aborted";
            delete session.blockedReason;
            session.updatedAt = at;
          }
          const workItem = (taskGroup.workItems || []).find((item) => item.id === dispatch.workItemId);
          if (workItem && !["verified", "closed", "superseded"].includes(workItem.status)) {
            workItem.status = "needs_decision";
            workItem.blockedReason = "human_directive_cancel";
            workItem.updatedAt = at;
          }
        }
        directive.appliedActions.push({action: "task_group_cancel_pending_dispatches", ref: `TaskGroup:${taskGroup.id}`});
      } else if (directive.directiveType === "add_requirement" && taskGroup) {
        taskGroup.humanGuidance = [...(taskGroup.humanGuidance || []), {directiveRef: directive.directiveId, text: directive.instruction, addedAt: at}];
        const openWorkItem = (taskGroup.workItems || []).find((item) => !["verified", "closed", "superseded"].includes(item.status));
        if (openWorkItem && directive.instruction) {
          openWorkItem.requirements = unique([...(openWorkItem.requirements || []), directive.instruction]);
          openWorkItem.updatedAt = at;
          directive.appliedActions.push({action: "work_item_requirement_appended", ref: `WorkItem:${openWorkItem.id}`});
        } else {
          directive.appliedActions.push({action: "task_group_requirement_appended", ref: `TaskGroup:${taskGroup.id}`});
        }
      } else if (directive.directiveType === "adjust_priority" && taskGroup) {
        taskGroup.priorityHint = directive.instruction || taskGroup.priorityHint || "elevated";
        taskGroup.humanGuidance = [...(taskGroup.humanGuidance || []), {directiveRef: directive.directiveId, text: `优先级调整：${directive.instruction}`, addedAt: at}];
        directive.appliedActions.push({action: "task_group_priority_adjusted", ref: `TaskGroup:${taskGroup.id}`});
      } else if (directive.directiveType === "resolve_decision" && taskGroup) {
        // The operator's decision on a needs_decision cell — the actuator that resolves the
        // rework-cap / role-drift escalation the autonomous cycle deliberately will not auto-resume.
        // reopen: return to ready for another genuine attempt (reset the rework count by superseding
        // the prior changes_requested review bundles); abandon: supersede the cell so it stops
        // blocking close. Without this a needs_decision cell would wedge the close barrier forever.
        // reopen 仍然只对 needs_decision 生效（把已验收的工作项拉回 ready 会绕过人工定稿）；
        // 但 abandon 是"我决定不做了"，必须对任何还没了结的工作项都可用 —— 原先只能放弃
        // needs_decision 的格子，于是一个卡在别的状态上的工作项，人连放弃它的手段都没有。
        // 放宽 abandon 的适用状态时，我把"不填 workItemId"的爆炸半径一起放大了：原先它只命中
        // needs_decision 的格子，放宽后变成【整组所有未了结的工作项】—— 一条指令就能放弃整组，
        // 顺带把产出目标置为 superseded、不可验证的制品置为 rejected、失败的质量门因工作项被放弃
        // 而豁免，关闭门当场全绿。而控制台上那句提示写的仍是旧语义，人以为自己在"清掉卡住的格子"。
        // 因此：不填 workItemId 时维持原语义（只处置 needs_decision），放宽出来的那部分能力
        // 必须点名到具体工作项。
        const abandonable = (item) => !WORK_ITEM_SETTLED_STATUSES.includes(item.status);
        const targets = (taskGroup.workItems || []).filter((item) => {
          if (directive.workItemId && item.id !== directive.workItemId) return false;
          if (directive.resolution !== "abandon") return item.status === "needs_decision";
          return directive.workItemId ? abandonable(item) : item.status === "needs_decision";
        });
        for (const workItem of targets) {
          if (directive.resolution === "abandon") {
            workItem.status = "superseded";
            workItem.splitStatus = workItem.splitStatus || "abandoned_by_human_decision";
            delete workItem.blockedReason;
            // Terminalize the cell's runtime residue (dispatch/session/lease/target/guard) so the
            // abandoned cell cannot keep blocking the close barrier with no operator lever.
            terminateCellRuntime(state, taskGroup.id, workItem.id, "work_item_abandoned_by_human_decision");
            // 核心决策卡（验收/拆分/方案）不带 dispatchId，terminateCellRuntime 的
            // cancelPendingConfirmationsForDispatch 够不到它们；不处理的话，格子已经没了，
            // 卡片却仍 pending 且三个动作全被快照校验拒掉，只能等 7 天过期。
            refreshConfirmationsAfterHumanChange(state, taskGroup.id, workItem.id,
              {actor: directive.issuedBy || "human", summary: "工作项已由人工放弃"});
          } else {
            for (const bundle of (state.reviewBundles || [])) {
              if (bundle.workItemId === workItem.id && bundle.verdict === "changes_requested") bundle.supersededByHumanDecision = true;
            }
            workItem.status = "ready";
            workItem.reviewState = "reopened_by_human_decision";
            workItem.humanDecisionRef = directive.directiveId;
            workItem.progress = Math.min(Number(workItem.progress || 0), 60);
            delete workItem.blockedReason;
          }
          workItem.updatedAt = at;
          directive.appliedActions.push({action: `work_item_decision_${directive.resolution || "reopen"}`, ref: `WorkItem:${workItem.id}`});
        }
        if (!targets.length) directive.appliedActions.push({action: "no_needs_decision_work_item", ref: `TaskGroup:${taskGroup.id}`});
      } else if (taskGroup) {
        taskGroup.humanGuidance = [...(taskGroup.humanGuidance || []), {directiveRef: directive.directiveId, text: directive.instruction, addedAt: at}];
        directive.appliedActions.push({action: "task_group_guidance_appended", ref: `TaskGroup:${taskGroup.id}`});
      } else {
        directive.appliedActions.push({action: "recorded_without_task_group", ref: `Project:${directive.projectId}`});
      }
      directive.status = "applied";
    } catch (error) {
      directive.status = "rejected";
      directive.rejectReason = String(error.message || error).slice(0, 500);
    }
    directive.updatedAt = new Date().toISOString();
    applied.push({directiveId: directive.directiveId, status: directive.status, appliedActions: directive.appliedActions});
    appendEvent(state, "command_succeeded", "HumanDirective", directive.directiveId, "orchestrator", {status: directive.status});
  }
  return applied;
}

export function expireStaleQueuedDispatches(state) {
  const nowMs = Date.now();
  const at = new Date().toISOString();
  const expired = [];
  for (const dispatch of state.agentDispatches || []) {
    if (dispatch.status !== "queued") continue;
    const contract = (state.agentTaskContracts || []).find((item) => item.sessionId === dispatch.sessionId && item.runId === dispatch.runId);
    if (contract && (!contract.expiresAt || new Date(contract.expiresAt).getTime() > nowMs)) continue;
    dispatch.status = "cancelled";
    dispatch.failureReason = contract ? "task_contract_expired" : "task_contract_missing";
    dispatch.updatedAt = at;
    const session = (state.workSessions || []).find((item) => item.sessionId === dispatch.sessionId);
    if (session && !WORK_SESSION_SETTLED_STATUSES.includes(session.status)) {
      session.status = "recycled";
      session.updatedAt = at;
    }
    expired.push(dispatch.dispatchId);
    appendEvent(state, "command_failed", "AgentDispatch", dispatch.dispatchId, "scheduler", {projectId: dispatch.projectId, taskGroupId: dispatch.taskGroupId, reason: dispatch.failureReason});
  }
  return expired;
}

// ---- Command Bus lifecycle (Gap #3) ----------------------------------------------------
// Real created->admitted->dispatched->running->succeeded/failed lifecycle for the Command
// machine, plus the CommandEffect and DLQEntry machines. Every edge is validated through the
// transition engine (assertTransition via recordTransition). Side-effecting commands emit a
// CommandEffect (satisfying `effect_record_if_side_effect`); exhausted failures land in the DLQ.
// This makes the close-barrier `all_command_effects_terminal` / `no_active_dlq` gates real
// instead of vacuously true.

function capCommandBus(state) {
  // 这三个集合都被关闭门读取（all_commands_terminal / all_command_effects_terminal / no_active_dlq），
  // 而原先是盲 slice：旧但仍未了结的项会被新项挤出窗口，门随即"假满足"，任务组因此可能提前误关闭。
  // 这正是本仓已经反复交过学费的 barrier-safe cap 那一类 —— 同文件里就有专门的助手，这里却没用。
  state.commands = capRetainingPredicate(state.commands || [], (item) => !COMMAND_TERMINAL.has(item.status), 240);
  state.commandEffects = capRetainingPredicate(state.commandEffects || [], (item) => !COMMAND_EFFECT_TERMINAL.has(item.status), 240);
  state.dlqEntries = capRetainingPredicate(state.dlqEntries || [], (item) => !DLQ_ENTRY_TERMINAL.has(item.status), 240);
}

export function createCommand(state, input = {}) {
  ensureRuntimeCollections(state);
  const at = new Date().toISOString();
  const command = {
    schemaVersion: "command/v1",
    id: input.commandId || createId("cmd"),
    type: input.type || "control_command",
    subject: input.subject || (input.taskGroupId ? `TaskGroup:${input.taskGroupId}` : "control-plane"),
    projectId: input.projectId || "prj_control_plane",
    ...(input.taskGroupId ? {taskGroupId: input.taskGroupId} : {}),
    status: "created",
    idempotencyKey: input.idempotencyKey || createId("idem_cmd"),
    policyDecisionRef: input.policyDecisionRef || `policy:command:${createId("pd")}`,
    attempts: 0,
    maxAttempts: Math.max(1, Number(input.maxAttempts || 3)),
    ...(input.timeoutAt ? {timeoutAt: input.timeoutAt} : {}),
    ...(input.targetRef ? {targetRef: input.targetRef} : {}),
    createdAt: at,
    updatedAt: at
  };
  state.commands.unshift(command);
  // created -> admitted (policy-engine): policy_passed + idempotency_key
  recordTransition(state, "Command", command.id, "created", "admitted", "policy-engine", {
    policy_passed: `policy_passed:${command.policyDecisionRef}`,
    idempotency_key: command.idempotencyKey
  });
  command.status = "admitted";
  command.updatedAt = new Date().toISOString();
  appendEvent(state, "command_admitted", "Command", command.id, "policy-engine", {projectId: command.projectId, taskGroupId: command.taskGroupId});
  capCommandBus(state);
  return command;
}

export function dispatchCommand(state, command, input = {}) {
  // admitted -> dispatched (command-bus): target_available
  recordTransition(state, "Command", command.id, "admitted", "dispatched", "command-bus", {
    target_available: input.targetRef || command.targetRef || `target_available:${command.id}`
  });
  command.status = "dispatched";
  if (input.targetRef) command.targetRef = input.targetRef;
  command.updatedAt = new Date().toISOString();
  return command;
}

export function markRunning(state, command, input = {}) {
  // dispatched -> running (agent-runtime): dispatch_ack
  recordTransition(state, "Command", command.id, "dispatched", "running", "agent-runtime", {
    dispatch_ack: input.dispatchAck || `dispatch_ack:${command.id}`
  });
  command.status = "running";
  command.updatedAt = new Date().toISOString();
  return command;
}

export function succeedCommand(state, command, input = {}) {
  let commandEffect = null;
  let effectRef = "no_side_effect";
  if (input.sideEffect) {
    commandEffect = recordCommandEffect(state, command, {...input.sideEffect, taskGroupId: input.sideEffect.taskGroupId || command.taskGroupId});
    effectRef = `command_effect_ref:CommandEffect:${commandEffect.effectId}`;
    command.commandEffectRef = `CommandEffect:${commandEffect.effectId}`;
  }
  const from = command.status === "checkpointed" ? "checkpointed" : "running";
  // running|checkpointed -> succeeded (agent-runtime): result_ref + effect_record_if_side_effect
  recordTransition(state, "Command", command.id, from, "succeeded", "agent-runtime", {
    result_ref: input.resultRef || `result_ref:${command.id}`,
    effect_record_if_side_effect: effectRef
  });
  command.status = "succeeded";
  command.resultRef = input.resultRef || `result_ref:${command.id}`;
  command.updatedAt = new Date().toISOString();
  appendEvent(state, "command_succeeded", "Command", command.id, "agent-runtime", {projectId: command.projectId, taskGroupId: command.taskGroupId, hasSideEffect: Boolean(commandEffect)});
  capCommandBus(state);
  return {command, commandEffect};
}

export function failCommand(state, command, input = {}) {
  // running -> failed (agent-runtime): failure_ref
  recordTransition(state, "Command", command.id, "running", "failed", "agent-runtime", {
    failure_ref: input.failureRef || `failure_ref:${command.id}`
  });
  command.status = "failed";
  command.failureRef = input.failureRef || `failure_ref:${command.id}`;
  command.attempts = Number(command.attempts || 0) + 1;
  command.updatedAt = new Date().toISOString();
  appendEvent(state, "command_failed", "Command", command.id, "agent-runtime", {projectId: command.projectId, taskGroupId: command.taskGroupId, failureRef: command.failureRef});
  return command;
}

export function retryCommand(state, command, input = {}) {
  // failed -> admitted (command-bus): retry_policy_allows (only while attempts < maxAttempts)
  if (command.status !== "failed") return null;
  if (Number(command.attempts || 0) >= Number(command.maxAttempts || 1)) return null;
  recordTransition(state, "Command", command.id, "failed", "admitted", "command-bus", {
    retry_policy_allows: input.retryPolicyRef || `retry_policy_allows:${command.attempts}/${command.maxAttempts}`
  });
  command.status = "admitted";
  command.updatedAt = new Date().toISOString();
  return command;
}

export function timeoutCommand(state, command, input = {}) {
  // running -> timed_out (command-bus): timeout_at_elapsed
  recordTransition(state, "Command", command.id, "running", "timed_out", "command-bus", {
    timeout_at_elapsed: input.reason || `timeout_at_elapsed:${command.timeoutAt || command.id}`
  });
  command.status = "timed_out";
  command.updatedAt = new Date().toISOString();
  appendEvent(state, "command_failed", "Command", command.id, "command-bus", {projectId: command.projectId, taskGroupId: command.taskGroupId, reason: "timeout_at_elapsed"});
  return command;
}

export function cancelCommand(state, command, input = {}) {
  // running -> cancelled (command-bus): cancel_ref
  recordTransition(state, "Command", command.id, "running", "cancelled", "command-bus", {
    cancel_ref: input.cancelRef || `cancel_ref:${command.id}`
  });
  command.status = "cancelled";
  command.updatedAt = new Date().toISOString();
  return command;
}

export function compensateCommand(state, command, input = {}) {
  // failed -> compensated (command-bus): compensation_command_verified
  recordTransition(state, "Command", command.id, "failed", "compensated", "command-bus", {
    compensation_command_verified: input.compensationRef || `compensation_command_verified:${command.id}`
  });
  command.status = "compensated";
  command.updatedAt = new Date().toISOString();
  return command;
}

export function toDlq(state, command, input = {}) {
  // failed -> dlq (command-bus): max_attempts_exceeded + create a DLQEntry
  recordTransition(state, "Command", command.id, "failed", "dlq", "command-bus", {
    max_attempts_exceeded: `max_attempts_exceeded:${command.attempts}/${command.maxAttempts}`
  });
  command.status = "dlq";
  command.updatedAt = new Date().toISOString();
  const dlqEntry = createDlqEntry(state, {
    commandId: command.id,
    projectId: command.projectId,
    taskGroupId: command.taskGroupId,
    reason: input.reason || command.failureRef || "max_attempts_exceeded",
    sourceObjectRef: `Command:${command.id}`
  });
  return {command, dlqEntry};
}

// CommandEffect machine: prepared -> applied -> verifying -> verified (reconciled).
export function recordCommandEffect(state, command, input = {}) {
  ensureRuntimeCollections(state);
  const at = new Date().toISOString();
  const effect = {
    schemaVersion: "command-effect/v1",
    effectId: input.effectId || createId("cef"),
    commandId: command?.id || input.commandId,
    projectId: input.projectId || command?.projectId || "prj_control_plane",
    ...(input.taskGroupId || command?.taskGroupId ? {taskGroupId: input.taskGroupId || command?.taskGroupId} : {}),
    status: "prepared",
    externalOperationId: input.externalOperationId || `ext:${command?.id || effectRandom()}`,
    fencingToken: input.fencingToken || `fence:${command?.id || effectRandom()}`,
    beforeDigest: input.beforeDigest || digestOf({command: command?.id, phase: "before", nonce: at}),
    createdAt: at,
    updatedAt: at
  };
  state.commandEffects.unshift(effect);
  appendEvent(state, "command_effect_prepared", "CommandEffect", effect.effectId, "agent-runtime", {projectId: effect.projectId, taskGroupId: effect.taskGroupId, commandId: effect.commandId});
  capCommandBus(state);
  if (input.autoReconcile !== false) reconcileCommandEffect(state, effect, input);
  return effect;
}

function effectRandom() {
  return Math.random().toString(36).slice(2, 8);
}

export function applyCommandEffect(state, effect, input = {}) {
  // prepared -> applied (agent-runtime): before_digest + external_operation_id + fencing_token
  recordTransition(state, "CommandEffect", effect.effectId, "prepared", "applied", "agent-runtime", {
    before_digest: effect.beforeDigest,
    external_operation_id: effect.externalOperationId,
    fencing_token: effect.fencingToken
  });
  effect.status = "applied";
  effect.updatedAt = new Date().toISOString();
  return effect;
}

export function verifyingCommandEffect(state, effect, input = {}) {
  effect.afterDigest = input.afterDigest || digestOf({effect: effect.effectId, phase: "after"});
  effect.resultRef = input.resultRef || `result_ref:${effect.effectId}`;
  // applied -> verifying (agent-runtime): after_digest + result_ref
  recordTransition(state, "CommandEffect", effect.effectId, "applied", "verifying", "agent-runtime", {
    after_digest: effect.afterDigest,
    result_ref: effect.resultRef
  });
  effect.status = "verifying";
  effect.updatedAt = new Date().toISOString();
  return effect;
}

export function verifyCommandEffect(state, effect, input = {}) {
  // verifying -> verified (reviewer): effect_verify_evidence
  recordTransition(state, "CommandEffect", effect.effectId, "verifying", "verified", "reviewer", {
    effect_verify_evidence: input.effectVerifyEvidence || `effect_verify_evidence:${effect.effectId}`
  });
  effect.status = "verified";
  effect.updatedAt = new Date().toISOString();
  appendEvent(state, "command_effect_verified", "CommandEffect", effect.effectId, "reviewer", {projectId: effect.projectId, taskGroupId: effect.taskGroupId});
  return effect;
}

function reconcileCommandEffect(state, effect, input = {}) {
  applyCommandEffect(state, effect, input);
  verifyingCommandEffect(state, effect, input);
  verifyCommandEffect(state, effect, input);
  return effect;
}

// DLQEntry machine: created -> classified -> assigned -> replayed|discarded|superseded.
export function createDlqEntry(state, input = {}) {
  ensureRuntimeCollections(state);
  const at = new Date().toISOString();
  const entry = {
    schemaVersion: "dlq-entry/v1",
    entryId: input.entryId || createId("dlq"),
    ...(input.commandId ? {commandId: input.commandId} : {}),
    projectId: input.projectId || "prj_control_plane",
    ...(input.taskGroupId ? {taskGroupId: input.taskGroupId} : {}),
    status: "created",
    sourceObjectRef: input.sourceObjectRef || (input.commandId ? `Command:${input.commandId}` : "unknown"),
    reason: input.reason || "max_attempts_exceeded",
    createdAt: at,
    updatedAt: at
  };
  state.dlqEntries.unshift(entry);
  appendEvent(state, "dlq_entry_created", "DLQEntry", entry.entryId, "command-bus", {projectId: entry.projectId, taskGroupId: entry.taskGroupId, reason: entry.reason});
  capCommandBus(state);
  return entry;
}

export function classifyDlqEntry(state, entry, input = {}) {
  // created -> classified (monitor): root_cause_hint
  recordTransition(state, "DLQEntry", entry.entryId, "created", "classified", "monitor", {
    root_cause_hint: input.rootCauseHint || `root_cause_hint:${entry.entryId}`
  });
  entry.status = "classified";
  entry.rootCauseHint = input.rootCauseHint || `root_cause_hint:${entry.entryId}`;
  entry.updatedAt = new Date().toISOString();
  return entry;
}

export function assignDlqEntry(state, entry, input = {}) {
  // classified -> assigned (orchestrator): owner_role
  recordTransition(state, "DLQEntry", entry.entryId, "classified", "assigned", "orchestrator", {
    owner_role: input.ownerRole || "release"
  });
  entry.status = "assigned";
  entry.ownerRole = input.ownerRole || "release";
  entry.updatedAt = new Date().toISOString();
  return entry;
}

export function replayDlqEntry(state, entry, input = {}) {
  // assigned -> replayed (command-bus): replay_policy_passed
  recordTransition(state, "DLQEntry", entry.entryId, "assigned", "replayed", "command-bus", {
    replay_policy_passed: input.replayPolicyRef || `replay_policy_passed:${entry.entryId}`
  });
  entry.status = "replayed";
  entry.updatedAt = new Date().toISOString();
  appendEvent(state, "dlq_entry_replayed", "DLQEntry", entry.entryId, "command-bus", {projectId: entry.projectId, taskGroupId: entry.taskGroupId});
  return entry;
}

export function discardDlqEntry(state, entry, input = {}) {
  // assigned -> discarded (orchestrator): decision_record + resolution_effect_ref
  recordTransition(state, "DLQEntry", entry.entryId, "assigned", "discarded", "orchestrator", {
    decision_record: input.decisionRecord || `decision_record:${entry.entryId}`,
    resolution_effect_ref: input.resolutionEffectRef || `resolution_effect_ref:${entry.entryId}`
  });
  entry.status = "discarded";
  entry.updatedAt = new Date().toISOString();
  return entry;
}

// Sweeper: applied on the same cadence as expireStaleQueuedDispatches / maintainWorkerLanes.
// It applies timeout_at_elapsed to running commands whose timeoutAt has passed so a stuck
// command cannot silently keep the close-barrier `all_commands_terminal` gate blocked.
export function sweepCommandBus(state, options = {}) {
  ensureRuntimeCollections(state);
  const nowMs = options.nowMs || Date.now();
  const swept = {timedOut: []};
  for (const command of state.commands || []) {
    if (command.status === "running" && command.timeoutAt && new Date(command.timeoutAt).getTime() <= nowMs) {
      timeoutCommand(state, command, {reason: `timeout_at_elapsed:${command.timeoutAt}`});
      swept.timedOut.push(command.id);
    }
  }
  return swept;
}

// One-shot helper for control-plane write paths: run created->admitted->dispatched->running->
// succeeded and (when the write has an external side effect) emit + reconcile a CommandEffect.
export function runCommandLifecycle(state, input = {}) {
  const command = createCommand(state, input);
  dispatchCommand(state, command, {targetRef: input.targetRef});
  markRunning(state, command, {dispatchAck: input.dispatchAck});
  return succeedCommand(state, command, {resultRef: input.resultRef, sideEffect: input.sideEffect});
}

export function needsReviewBackfill(state, taskGroup, workItem) {
  if (workItem.reviewBundleRef) return false;
  if ((state.reviewBundles || []).some((bundle) => bundle.workItemId === workItem.id && bundle.verdict === "passed")) return false;
  return (state.checkpoints || []).some((checkpoint) => checkpoint.taskGroupId === taskGroup.id && checkpoint.workId === workItem.id);
}

export function performIndependentReview(state, taskGroup, workItem, request = {}, options = {}) {
  // 人已定稿的工作项，AI 不得再自动改动（包括不能重新互审把它推回别的状态）。
  // 只有【验收】已定稿才不再互审。必须同时匹配 decisionType —— 否则一个 plan_topology / task_split 的
  // 定稿锁会让这个工作项永远无法进入验收，任务组的关闭门也就永远不可满足（死锁）。
  if (workItem.humanFinalization?.outcome === "confirmed" && workItem.humanFinalization?.decisionType === "work_item_verification") {
    return {reviewed: false, reason: "human_finalized"};
  }
  // 已经挂着待人工定稿单时不重复互审——决定权在人手上，重跑只会刷屏。
  const awaitingHuman = (state.humanConfirmationRequests || []).some((item) =>
    item.status === "pending" && item.decisionType === "work_item_verification" && item.workItemId === workItem.id);
  if (awaitingHuman) return {reviewed: false, reason: "awaiting_human_confirmation"};
  const checkpoint = (state.checkpoints || []).find((item) => item.taskGroupId === taskGroup.id && item.workId === workItem.id);
  if (!checkpoint) return {reviewed: false, reason: "checkpoint_missing"};
  const target = (state.repositoryOutputs || []).find((item) => (checkpoint.repositoryOutputTargetRefs || []).includes(item.targetId));
  const finalCommit = checkpoint.commitRefs?.at(-1)?.commit;
  const findings = [];
  if (!target || !["pushed", "committed"].includes(target.status)) findings.push("repository_output_target_not_terminal");
  if (!checkpoint.pushRefs?.length) findings.push("push_evidence_missing");
  if (!checkpoint.artifactManifestRefs?.length) findings.push("artifact_manifest_missing");
  const reviewRoots = [];
  if (target && request.runtimeDir) {
    const safeTargetId = String(target.targetId).replace(/[^A-Za-z0-9._-]+/gu, "_");
    const verificationRoot = join(request.runtimeDir, "git-verification", `${safeTargetId}.git`);
    if (existsSync(join(verificationRoot, "HEAD"))) reviewRoots.push(verificationRoot);
  }
  reviewRoots.push(request.root || process.cwd());
  if (!finalCommit || !reviewRoots.some((reviewRoot) => git(reviewRoot, ["rev-parse", "--verify", `${finalCommit}^{commit}`], ""))) findings.push("final_commit_not_verifiable");
  const changedPaths = target?.changedPaths || [];
  if (target && changedPaths.some((path) => !pathMatchesAllowlist(path, target.pathAllowlist || []))) findings.push("changed_paths_outside_allowlist");
  const at = new Date().toISOString();
  const verdict = findings.length ? "changes_requested" : "passed";
  const checkpointRef = `checkpoint:${checkpoint.runId}`;
  const previousRejections = (state.reviewBundles || []).filter((item) =>
    item.workItemId === workItem.id && item.verdict === "changes_requested" && !item.supersededByHumanDecision);
  const duplicateRejection = verdict === "changes_requested"
    ? previousRejections.find((item) => item.checkpointRef === checkpointRef && JSON.stringify(item.findings || []) === JSON.stringify(findings))
    : null;
  let bundle = duplicateRejection || null;
  if (!bundle) {
    bundle = {
      // Internal independent review — a DISTINCT concept from the external ReviewBundle (review-bundle/v1),
      // which models a redacted payload for an external provider. Uses its own schema so the two aren't
      // conflated (H2). The close barrier reads verdict/workItemId/reviewMode off this record.
      schemaVersion: "internal-review-record/v1",
      bundleId: createId("rvb"),
      projectId: taskGroup.projectId,
      taskGroupId: taskGroup.id,
      workItemId: workItem.id,
      checkpointRef,
      reviewerRole: "reviewer",
      reviewMode: "independent_control_plane_review",
      // 互审双轨（sys.review-dual-track）轨道二：不只审"这个方案执行得对不对"，还要回到原始问题问
      // "这个方案本身是不是解决它的正确路径"。控制面的独立互审是确定性证据核验，它能给出的替代路径
      // 判断有限，因此如实记录其考察边界，而不是编造一条替代方案充数——留空会被 schema 判为评审未完成，
      // 编造则会误导人的定稿判断。真正的方案级替代由执行 agent 通过 confirmation_analyze 提出。
      alternativesConsidered: [{
        alternative: "维持当前实现方案，仅核验其证据完整性",
        assessment: `控制面独立互审的考察边界为证据层（提交/推送/产物清单/变更路径合规），未评估方案层替代路径；方案是否为最优应由执行方在人工确认通道提出（本次证据结论：${verdict}）`
      }],
      verdict,
      findings,
      evidenceRefs: [
        `review-evidence:commit:${finalCommit || "missing"}`,
        ...(checkpoint.pushRefs || []).map((push) => `review-evidence:push:${push.remote}/${push.ref}:${push.remoteSha}`)
      ],
      status: "consumed",
      createdAt: at,
      updatedAt: at
    };
    state.reviewBundles.unshift(bundle);
    // capRetainingOpen (not a blind slice): a non-terminal (registered/pending/external) bundle gates
    // the close barrier (no_pending_review_bundle), so dropping it by recency would falsely pass close.
    state.reviewBundles = capRetainingOpen(state.reviewBundles, ["consumed", "rejected"], 160);
  }
  if (verdict !== "passed") {
    workItem.reviewState = "changes_requested";
    workItem.updatedAt = at;
    const rejectionCount = previousRejections.length + (duplicateRejection ? 0 : 1);
    const maxReworkAttempts = Math.max(1, Number(process.env.AIMAC_REVIEW_MAX_REWORK_ATTEMPTS || 3));
    if (options.backfill || rejectionCount >= maxReworkAttempts) {
      // Both the max-rework and the backfill failure paths must demote to needs_decision. A backfill
      // review runs against an already-`verified` item that lost its review bundle; if it fails we must
      // NOT leave it verified — that would keep needsReviewBackfill true forever (re-reviewing every
      // cycle, never recording a passing bundle, wedging completion readiness) with no operator lever
      // since resolve_decision only reaches needs_decision. Demote it (distinct reason) so it can be
      // reopened/abandoned.
      workItem.status = "needs_decision";
      workItem.blockedReason = options.backfill ? "independent_review_backfill_failed" : "independent_review_changes_requested";
      addBlocker(taskGroup, "S1", `独立评审要求工作项 ${workItem.id} 返工：${findings.map(reviewFindingLabel).join("，")}`);
    } else {
      if (target && ["pushed", "committed"].includes(target.status)) {
        target.status = "superseded";
        target.updatedAt = at;
      }
      workItem.status = "ready";
      workItem.progress = Math.min(Number(workItem.progress || 0), 60);
      delete workItem.blockedReason;
      addBlocker(taskGroup, "S2", `独立评审已将工作项 ${workItem.id} 重新排队返工（第 ${rejectionCount}/${maxReworkAttempts} 次）：${findings.map(reviewFindingLabel).join("，")}`);
    }
    if (!duplicateRejection) appendEvent(state, "review_result", "WorkItem", workItem.id, "reviewer", {verdict, findings, reviewBundleRef: bundle.bundleId});
    return {reviewed: true, verdict, reviewBundleRef: bundle.bundleId, findings};
  }
  let from = workItem.status;
  if (["checkpoint_submitted", "code_complete"].includes(from)) {
    // checkpoint_submitted/code_complete -> review_requested is modeled with the orchestrator
    // as actor; use the modeled gate id (evidence_refs / review_request_event) per segment.
    const modeled = canonicalTransition("WorkItem", from, "review_requested");
    const requiresValues = {};
    for (const gate of modeled?.requires || []) requiresValues[gate] = `checkpoint:${checkpoint.runId}:${gate}`;
    recordTransition(state, "WorkItem", workItem.id, from, "review_requested", modeled?.actor || "orchestrator", requiresValues);
    from = "review_requested";
  }
  if (from === "review_requested") {
    recordTransition(state, "WorkItem", workItem.id, "review_requested", "review_passed", "reviewer", {
      review_report: `review-bundle:${bundle.bundleId}`,
      local_verification_evidence: `local_verification_evidence:${finalCommit}`,
      adoption_classification: "adopted"
    });
    from = "review_passed";
  }
  if (from === "review_passed") {
    recordTransition(state, "WorkItem", workItem.id, "review_passed", "verification_ready", "orchestrator", {
      verification_plan: `review-bundle:${bundle.bundleId}`
    });
    from = "verification_ready";
  }
  // 互审通过 **不等于** 验收通过。AI 只能把工作项推进到 verification_ready（"证据齐了，可以验收"），
  // verification_ready -> verified 这一步只能由真人在人工确认窗口里做（applyHumanFinalization）。
  workItem.status = "verification_ready";
  workItem.reviewState = "review_passed_awaiting_human_confirmation";
  workItem.reviewBundleRef = bundle.bundleId;
  workItem.progress = Math.min(99, Math.max(Number(workItem.progress || 0), 95));
  workItem.updatedAt = at;
  // 发起人工定稿单，把互审结论作为【建议】附上（AI 推荐"确认验收"，但决定权在人）。
  const confirmation = createHumanConfirmationRequest(state, {
    taskGroupId: taskGroup.id,
    workItemId: workItem.id,
    decisionType: "work_item_verification",
    requestKey: `work_item_verification:${workItem.id}:${bundle.bundleId}`,
    summary: `验收确认：${workItem.title || workItem.id}`,
    detail: `控制面独立互审结论：${verdict}。证据已就绪，等待人工定稿验收。互审只提供建议，不构成验收。` +
      // 让"曾经失败、后被重报为通过"的质量门对人可见：否则人看到的只是"质量门全通过"，
      // 看不到其中哪一条是被同一个 AI 重报翻过来的，知情同意就名不副实。
      (() => {
        const gates = (state.qualityGates || []).filter((gate) => gate.taskGroupId === taskGroup.id && gate.workItemId === workItem.id);
        const reversed = gates.filter((gate) => gate.previouslyFailed && gate.status === "passed");
      // 证据摘要是执行方在自己机器上算的，内容从不上传，控制面无法核验它与内容是否相符。
      // 卡片上必须说出这一点：否则"证据已就绪"会被读成"证据已被核验过"。
      const attested = (state.artifacts || []).filter((item) => item.taskGroupId === taskGroup.id
        && item.workItemId === workItem.id && item.contentDigestAttested === true);
        const waived = gates.filter((gate) => gate.status === "waived");
        const notes = [];
        if (reversed.length) notes.push(`\n⚠ 以下质量门曾判失败、后由执行方重报为通过（已附新证据）：${reversed.map((gate) => gate.gateType).join("、")}`);
        if (waived.length) notes.push(`\n⚠ 以下质量门为人工豁免：${waived.map((gate) => `${gate.gateType}（${gate.waivedBy || "?"}）`).join("、")}`);
        if (attested.length) notes.push(`\n⚠ 本工作项的 ${attested.length} 项证据制品，其内容摘要由执行方自行计算并声明，证据内容不上传控制面，因此控制面【未能独立核验】摘要与内容是否相符。可独立核验的是检查点里的提交与推送记录。`);
        return notes.join("");
      })(),
    evidenceRefs: bundle.evidenceRefs,
    peerReview: {verdict, findings, reviewRecordRef: bundle.bundleId, alternativesConsidered: bundle.alternativesConsidered},
    content: {reviewBundleRef: bundle.bundleId, finalCommit: finalCommit || null},
    options: [
      {optionId: "accept", label: "确认验收（定稿）", description: "确认该工作项通过验收；定稿后 AI 不得再自动更改。", recommended: true},
      {optionId: "reject", label: "打回返工", description: "不认可本次结果，工作项回到人工决策通道等待重开或废弃。"}
    ]
  });
  appendEvent(state, "review_result", "WorkItem", workItem.id, "reviewer", {verdict, reviewBundleRef: bundle.bundleId, awaitingHumanConfirmation: confirmation.requestId});
  return {reviewed: true, verdict, reviewBundleRef: bundle.bundleId, humanConfirmationRef: confirmation.requestId, awaitingHumanConfirmation: true};
}

function unique(items) {
  return [...new Set((items || []).filter(Boolean))];
}

export function canUseGitPath(path) {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.startsWith("artifacts/") && !path.startsWith(".runtime/") && !path.startsWith("tmp/") && !path.includes("..");
}

export function pathAllowlistValid(paths) {
  return Array.isArray(paths) && paths.length > 0 && paths.every(canUseGitPath);
}

export function pathMatchesAllowlist(path, allowlist) {
  if (!canUseGitPath(path)) return false;
  return (allowlist || []).some((pattern) => {
    if (!canUseGitPath(pattern)) return false;
    if (pattern.endsWith("/**")) return path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2));
    if (!pattern.includes("*")) return path === pattern;
    return globPathMatches(pattern.split("/"), path.split("/"));
  });
}

function globPathMatches(patternSegments, pathSegments) {
  let patternIndex = 0;
  let pathIndex = 0;
  let starPatternIndex = -1;
  let starPathIndex = -1;
  while (pathIndex < pathSegments.length) {
    if (patternIndex < patternSegments.length && patternSegments[patternIndex] === "**") {
      starPatternIndex = patternIndex;
      starPathIndex = pathIndex;
      patternIndex += 1;
    } else if (patternIndex < patternSegments.length && globSegmentMatches(patternSegments[patternIndex], pathSegments[pathIndex])) {
      patternIndex += 1;
      pathIndex += 1;
    } else if (starPatternIndex >= 0) {
      starPathIndex += 1;
      pathIndex = starPathIndex;
      patternIndex = starPatternIndex + 1;
    } else {
      return false;
    }
  }
  while (patternIndex < patternSegments.length && patternSegments[patternIndex] === "**") patternIndex += 1;
  return patternIndex === patternSegments.length;
}

function globSegmentMatches(patternSegment, pathSegment) {
  let patternIndex = 0;
  let pathIndex = 0;
  let starPatternIndex = -1;
  let starPathIndex = -1;
  while (pathIndex < pathSegment.length) {
    if (patternIndex < patternSegment.length && patternSegment[patternIndex] === "*") {
      starPatternIndex = patternIndex;
      starPathIndex = pathIndex;
      patternIndex += 1;
    } else if (patternIndex < patternSegment.length && patternSegment[patternIndex] === pathSegment[pathIndex]) {
      patternIndex += 1;
      pathIndex += 1;
    } else if (starPatternIndex >= 0) {
      starPathIndex += 1;
      pathIndex = starPathIndex;
      patternIndex = starPatternIndex + 1;
    } else {
      return false;
    }
  }
  while (patternIndex < patternSegment.length && patternSegment[patternIndex] === "*") patternIndex += 1;
  return patternIndex === patternSegment.length;
}

export function defaultSourceConfig() {
  return clone(defaultSkillSource);
}

// --- Gap 2A: shared governance mutators lifted from mcp-server (behavior-neutral) ---
// These are pure (state, args) governance/room/lease/finding/review mutators previously defined
// only inside apps/mcp-server/server.mjs. They are lifted here verbatim so HTTP endpoints, the
// agent runtime, and the command bus can share one implementation with the MCP surface.

export function findTaskGroup(state, taskGroupId) {
  return taskGroupId ? state.taskGroups.find((item) => item.id === taskGroupId) || null : state.taskGroups[0] || null;
}

export function taskGroupForRecord(state, args) {
  // Attribute a record to the project that actually owns its task group / work item, never a hardcoded
  // default, so a tenant-scoped write cannot be misfiled under the control-plane project. Resolve ONLY on a
  // real id — findTaskGroup falls back to taskGroups[0] on a falsy id, which would misfile an
  // unscoped record under an arbitrary tenant instead of the intended control-plane default.
  const workItemId = args.workItemId || args.workId;
  return (args.taskGroupId ? findTaskGroup(state, args.taskGroupId) : null)
    || (workItemId ? (state.taskGroups || []).find((item) => (item.workItems || []).some((work) => work.id === workItemId)) : null);
}

export function capRetainingOpen(items, terminalStatuses, limit) {
  if (items.length <= limit) return items;
  const terminal = new Set(terminalStatuses);
  const open = items.filter((item) => !terminal.has(item.status));
  const closed = items.filter((item) => terminal.has(item.status)).slice(0, Math.max(0, limit - open.length));
  // Never drop a non-terminal (gating) item; trim oldest terminal history first.
  return [...open, ...closed];
}

// Statuses that make a close-barrier collection item still "open"/blocking. Single source of truth so
// the cap below and computeCloseBarrier can never drift into evicting a gating item.
// Includes "quorum_collecting" so a sub-quorum high-risk approval keeps blocking completion readiness.
// 会话的"已了结"集：completed_objective 之后即便还没回收，也不该再挡住任务组关闭。
// 这里必须只用已登记状态 —— 原先混着 WorkSession 根本没有的 "closed"。
// 工作项的"已了结"集：verified/closed 是交付了结，superseded/cancelled/aborted 是没有交付的了结
// （被拆分取代、人工放弃、被取消）。两者都不该再挡住任务组关闭。
export const WORK_ITEM_SETTLED_STATUSES = ["verified", "closed", "superseded", "aborted"];
export const WORK_SESSION_SETTLED_STATUSES = ["completed_objective", "recycled", "failed", "aborted"];
const BARRIER_PENDING_STATUSES = ["open", "pending", "pending_approval", "quorum_collecting", "requested", "submitted", "in_review", "waiting"];
// 一个横跨 5 类实体的通用"待处理"清单，对每一类都只是碰运气 —— 实测 8 个状态名里，
// 对 RuleSourceResolution / DerivedTaskRequest 一个都不命中，那两道门从来没有触发过。
// 因此改为按实体给出各自的未了结集，且每个值都必须是 state-machines.yaml 里已登记的状态。
export const PERMISSION_REQUEST_PENDING_STATUSES = ["pending_approval"];
export const APPROVAL_REQUEST_PENDING_STATUSES = ["requested", "quorum_collecting"];
export const DERIVED_TASK_REQUEST_PENDING_STATUSES = ["candidate", "strengthened", "classified"];

// Like capRetainingOpen but with an explicit isOpen predicate, for barrier collections whose "open"
// condition is a positive status match (candidate_created / conflict / pending) rather than the
// negation of a terminal-status list. Never drops an item the predicate marks open (would falsely
// satisfy a close/completion barrier and prematurely close the task group); trims oldest closed first.
function capRetainingPredicate(items, isOpen, limit) {
  if (items.length <= limit) return items;
  const open = items.filter(isOpen);
  const closed = items.filter((item) => !isOpen(item)).slice(0, Math.max(0, limit - open.length));
  return [...open, ...closed];
}

// Wire the evidence -> quality-gate -> close-barrier pipeline the design promises: test evidence is
// recorded AND derived into a QualityGate so the close-barrier gate all_quality_gates_passed (which reads
// state.qualityGates) actually reflects it. Without this, test_result_submit filled a collection nothing
// read and the quality-gate collection had no writer, so both gates were no-ops. Upsert one gate per
// (taskGroup, workItem, gateType): a passing/skipped test -> passed (terminal, trimmable); a failing/error
// test -> failed (non-terminal, blocks close until the fix is re-verified).
export function recordQualityGateFromTest(state, testResult) {
  state.qualityGates ||= [];
  const gateType = testResult.gateType || "test";
  const gateId = `qg:${testResult.taskGroupId}:${testResult.workItemId || "tg"}:${gateType}`;
  const passed = ["passed", "skipped"].includes(testResult.status);
  const at = testResult.createdAt || new Date().toISOString();
  const existing = state.qualityGates.find((gate) => gate.gateId === gateId);
  if (existing) {
    // 失败过的门不能被同一个 AI 用一次"我又跑了一遍、这次过了"悄悄抹平。
    // 这里是【人看到"质量门全通过"时所依据的唯一来源】，而它完全由 agent 自报：
    // 提交测试结果不需要任何参数、命令从不真正执行、证据可以为空。若允许无条件覆写，
    // 那么"能把门判失败的"和"能把门清掉的"是同一个 AI —— 人的知情同意就是空的。
    if (existing.status === "failed" && passed) {
      const priorEvidence = new Set([...(existing.evidenceRefs || []), ...(existing.clearedEvidenceRefs || [])]);
      const freshEvidence = (testResult.evidenceRefs || []).filter((ref) => ref && !priorEvidence.has(ref));
      if (!freshEvidence.length) {
        // 没有任何新证据 => 不改判，只记一次尝试。人工豁免走 quality_gate_waive（真人专属）。
        existing.reassertedWithoutNewEvidenceCount = Number(existing.reassertedWithoutNewEvidenceCount || 0) + 1;
        existing.updatedAt = at;
        return existing;
      }
      existing.clearedEvidenceRefs = [...priorEvidence, ...freshEvidence];
      // 留痕：这道门曾经失败过。close barrier 与人工确认卡片都要让人看见，
      // 否则人看到的只是"全通过"，而看不到"其中一条是被重报翻过来的"。
      existing.previouslyFailed = true;
    }
    existing.status = passed ? "passed" : "failed";
    existing.testResultRef = testResult.testResultId;
    if ((testResult.evidenceRefs || []).length) existing.evidenceRefs = unique([...(existing.evidenceRefs || []), ...testResult.evidenceRefs]);
    existing.updatedAt = at;
    return existing;
  }
  const gate = {
    schemaVersion: "quality-gate/v1",
    gateId,
    gateType,
    projectId: testResult.projectId,
    taskGroupId: testResult.taskGroupId,
    workItemId: testResult.workItemId || null,
    status: passed ? "passed" : "failed",
    testResultRef: testResult.testResultId,
    createdAt: at,
    updatedAt: at
  };
  state.qualityGates = capRetainingOpen([gate, ...state.qualityGates], ["passed", "waived"], 2000);
  return gate;
}

function normalizePermissionResource(args = {}) {
  const resource = args.resource && typeof args.resource === "object" ? args.resource : {};
  return {
    resourceType: resource.resourceType || args.resourceType || (args.taskGroupId ? "task_group" : "project"),
    resourceId: resource.resourceId || args.resourceId || args.taskGroupId || args.projectId || "prj_control_plane"
  };
}

export function resourceMatches(grantResource = {}, requestedResource = {}) {
  if (!grantResource.resourceType || !requestedResource.resourceType) return false;
  return grantResource.resourceType === requestedResource.resourceType && grantResource.resourceId === requestedResource.resourceId;
}

function grantResourceProjectId(state, grant = {}) {
  const resource = grant.resource || {};
  if (resource.resourceType === "project") return resource.resourceId;
  if (resource.resourceType === "task_group") {
    return (state.taskGroups.find((item) => item.id === resource.resourceId) || {}).projectId;
  }
  return undefined;
}

function pruneRoomMessages(state) {
  const maxTotal = Math.max(1000, Number(process.env.AIMAC_ROOM_MESSAGES_MAX_TOTAL || 10000));
  const maxPerRoom = Math.max(100, Number(process.env.AIMAC_ROOM_MESSAGES_MAX_PER_ROOM || 1000));
  const ttlMs = Math.max(60 * 1000, Number(process.env.AIMAC_ROOM_MESSAGES_TTL_MS || 7 * 24 * 60 * 60 * 1000));
  const cutoff = Date.now() - ttlMs;
  const perRoom = new Map();
  const kept = [];
  for (const message of [...(state.roomMessages || [])].reverse()) {
    if (new Date(message.createdAt || 0).getTime() < cutoff) continue;
    const count = perRoom.get(message.roomId) || 0;
    if (count >= maxPerRoom) continue;
    perRoom.set(message.roomId, count + 1);
    kept.push(message);
    if (kept.length >= maxTotal) break;
  }
  state.roomMessages = kept.reverse();
}

export function roomSend(state, args) {
  const at = new Date().toISOString();
  const roomId = args.roomId || `room_${args.taskGroupId || "tg_runtime_management"}`;
  state.roomMessages ||= [];
  state.roomSequenceByRoom ||= {};
  // (roomId, idempotencyKey) dedup: a retried send with the same key must return the original
  // message instead of appending a duplicate with a fresh sequence. The dedup window is bounded
  // by roomMessages retention (pruneRoomMessages), consistent with the command-bus idempotency.
  const idempotencyKey = args.idempotencyKey || null;
  if (idempotencyKey) {
    const existing = state.roomMessages.find((item) => item.roomId === roomId && item.idempotencyKey === idempotencyKey);
    if (existing) return {message: existing, duplicate: true};
  }
  const retainedMax = Math.max(0, ...state.roomMessages.filter((item) => item.roomId === roomId).map((item) => Number(item.sequence || 0)));
  const nextSequence = Math.max(Number(state.roomSequenceByRoom[roomId] || 0), retainedMax) + 1;
  state.roomSequenceByRoom[roomId] = nextSequence;
  const message = {
    messageId: args.messageId || createId("room_msg"),
    roomId,
    sequence: nextSequence,
    senderRef: args.senderRef || args.roleId || "agent-runtime",
    payload: args.payload || {text: args.text || ""},
    payloadDigest: digestOf(args.payload || args.text || ""),
    // room_send persists a RoomMessage as an internal write with no external side effect; "delivered" is
    // the modeled terminal RoomMessage state (was the unmodeled "sent").
    status: "delivered",
    ...(idempotencyKey ? {idempotencyKey} : {}),
    createdAt: at
  };
  state.roomMessages.push(message);
  pruneRoomMessages(state);
  // room_send persists a RoomMessage (an internal write, no external side effect) — run it
  // through the real command bus lifecycle so it reaches a terminal `succeeded` command
  // without emitting a CommandEffect.
  runCommandLifecycle(state, {
    type: "room_send",
    subject: `Room:${roomId}`,
    projectId: args.projectId,
    ...(args.taskGroupId ? {taskGroupId: args.taskGroupId} : {}),
    idempotencyKey: args.idempotencyKey || `cmd:room:${message.messageId}`,
    resultRef: `RoomMessage:${message.messageId}`
  });
  state.eventLog.unshift({
    id: createId("evt_room"),
    at,
    type: "room_message",
    subject: {type: "RoomMessage", id: message.messageId},
    actor: message.senderRef,
    taskGroupId: args.taskGroupId,
    payloadDigest: message.payloadDigest
  });
  return {message};
}

export function roomWait(state, args) {
  const roomId = args.roomId || `room_${args.taskGroupId || "tg_runtime_management"}`;
  const afterSequence = Number(args.afterSequence || args.cursor || 0);
  const limit = Math.max(1, Math.min(500, Number(args.limit || 50)));
  const messages = state.roomMessages
    .filter((item) => item.roomId === roomId && Number(item.sequence || 0) > afterSequence)
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
    .slice(0, limit);
  return {roomId, messages, nextCursor: messages.at(-1)?.sequence || afterSequence};
}

// ExecutionTopology — plans how ONE work item is executed: serially, or fanned out across isolated
// branches that a parent serially merges. Terminal states are the modeled ones (merged/downgraded/
// cancelled); everything else gates the close barrier, and advanceExecutionTopology is the lever that
// walks the modeled transitions. Records conform to spec/execution-topology.schema.json.
const TOPOLOGY_TERMINAL_STATUSES = ["merged", "downgraded", "cancelled"];
const TOPOLOGY_BRANCH_OUTPUT_CONTRACT = ["changedPaths", "resultRef", "validationEvidence", "unresolvedRisks", "derivedTaskRequests"];
const TOPOLOGY_ELIGIBILITY_GATES = [
  "independent_deliverables",
  "owned_paths_disjoint",
  "resource_scopes_disjoint",
  "runner_isolated",
  "result_bundle_contract",
  "parent_serial_merge_owner",
  "final_validation_available"
];

// ---------------------------------------------------------------------------------------------------
// 承载授权/定稿的记录必须 id 唯一。
//
// 这些集合都是"按 id find 出一个对象，然后据它决定谁被授权、写哪些路径、算不算通过"。而 id 往往是
// 调用方可自选的，插入又是 unshift —— 于是用同一个 id 再造一份，就能让所有 find 命中冒名的那份：
// 人批准的是卡片描述的 A，实际生效的是 B。这一类绕过在四轮复核里出现了四次（拓扑、仓库产出目标、
// 授权请求、审批请求），每次都是同一个形状，所以这里做成统一的守卫，新增同类集合时直接复用。
// ---------------------------------------------------------------------------------------------------
export function assertUniqueRecordId(collection, idField, id, errorCode) {
  if (!id) return;
  if ((collection || []).some((item) => item?.[idField] === id)) {
    throw Object.assign(new Error(errorCode), {status: 409, conflictingId: id});
  }
}

function topologyError(code, status = 409) {
  const error = new Error(code);
  error.status = status;
  return error;
}

function normalizeTopologyBranches(args, workItem) {
  const requested = Array.isArray(args.branches) && args.branches.length
    ? args.branches
    : [{branchId: `${workItem?.id || "work"}_serial`, objective: workItem?.title || args.objective || "串行执行"}];
  const seenBranchIds = new Set();
  return requested.map((branch, index) => {
    const objective = String(branch.objective || workItem?.title || `分支 ${index + 1}`);
    const branchId = String(branch.branchId || `${workItem?.id || "work"}_b${index + 1}`);
    // 分支 id 在一份拓扑内必须唯一：重名会让 report_branch 只认第一份，第二份永远停在 running，
    // 拓扑到不了 integrating，一份【已被人定稿】的方案就此永久卡死（只剩 cancel）。
    if (seenBranchIds.has(branchId)) throw topologyError("execution_topology_duplicate_branch_id", 400);
    seenBranchIds.add(branchId);
    return {
      branchId,
      ...(branch.runnerId ? {runnerId: String(branch.runnerId)} : {}),
      status: "queued",
      objective,
      objectiveDigest: digestOf(objective),
      ownedPaths: unique(branch.ownedPaths || []),
      forbiddenPaths: unique(branch.forbiddenPaths || [".runtime/**", ".git/**"]),
      resourceScopes: unique(branch.resourceScopes || []),
      acceptanceChecks: unique(branch.acceptanceChecks || ["npm run validate"]),
      outputContract: [...TOPOLOGY_BRANCH_OUTPUT_CONTRACT],
      actualChangedPaths: []
    };
  });
}

// Evaluate the modeled eligibility gates against the ACTUAL branch definitions — a gate that cannot fail
// is a vacuous gate, so every one of these is computed from real plan data, and each failure becomes a
// blocker that forbids `start` (leaving `downgrade` as the lever).
function evaluateTopologyEligibility(topology) {
  const branches = (topology.groups || []).flatMap((group) => group.branches || []);
  const blockers = [];
  const seenPaths = new Map();
  const seenScopes = new Map();
  for (const branch of branches) {
    for (const path of branch.ownedPaths || []) {
      if (seenPaths.has(path)) blockers.push(`owned_paths_disjoint:${path}:${seenPaths.get(path)}|${branch.branchId}`);
      else seenPaths.set(path, branch.branchId);
    }
    for (const scope of branch.resourceScopes || []) {
      if (seenScopes.has(scope)) blockers.push(`resource_scopes_disjoint:${scope}:${seenScopes.get(scope)}|${branch.branchId}`);
      else seenScopes.set(scope, branch.branchId);
    }
    if (!branch.objective) blockers.push(`independent_deliverables:${branch.branchId}:missing_objective`);
    if (!(branch.acceptanceChecks || []).length) blockers.push(`final_validation_available:${branch.branchId}:no_acceptance_checks`);
    if ((branch.outputContract || []).length < 4) blockers.push(`result_bundle_contract:${branch.branchId}:incomplete`);
  }
  // Parallel execution requires a real isolation boundary; a serial single-branch plan does not.
  if (branches.length > 1 && (topology.runnerKind === "none" || topology.isolation === "none")) {
    blockers.push(`runner_isolated:${topology.topologyId}:runner_or_isolation_none`);
  }
  if (branches.length > 1 && (topology.ownedPathsRequired !== false) && branches.some((branch) => !(branch.ownedPaths || []).length)) {
    blockers.push("owned_paths_disjoint:branch_without_owned_paths");
  }
  if (topology.mergePolicy !== "parent_serial_after_all_required_reported") blockers.push("parent_serial_merge_owner:missing");
  return unique(blockers);
}

export function createExecutionTopology(state, args) {
  const taskGroup = findTaskGroup(state, args.taskGroupId);
  const workItem = (taskGroup?.workItems || []).find((item) => item.id === (args.workItemId || args.workId))
    || (taskGroup?.workItems || []).find((item) => !["superseded", "closed"].includes(item.status))
    || null;
  const workItemId = args.workItemId || args.workId || workItem?.id;
  if (!workItemId) throw topologyError("execution_topology_requires_work_item", 400);
  const at = new Date().toISOString();
  const root = args.root || args.repositoryRoot || process.cwd();
  const branches = normalizeTopologyBranches(args, workItem);
  const mode = args.mode || (branches.length > 1 ? "parallel_active" : "serial");
  const runnerKind = args.runnerKind || (branches.length > 1 ? "git_worktree" : "work_session");
  const isolation = args.isolation || (branches.length > 1 ? "git_worktree" : "new_work_session");
  // Schema conditional: an external runner must carry its grant plus local verification evidence — the
  // control plane never trusts an external result without locally verifiable evidence.
  if (runnerKind === "external_runner" && !(args.runnerGrantRef && (args.localVerificationEvidenceRefs || []).length)) {
    throw topologyError("execution_topology_external_runner_requires_grant_and_local_verification", 400);
  }
  const topologyId = args.topologyId || createId("topo");
  // id 唯一性：topologyId 是调用方可自选的。若允许重复，AI 只要用同一个 id 再造一份，unshift 之后
  // 所有 `find(topologyId===id)` 都会命中冒名的那份 —— 人批准的方案 A 的锁会落到方案 B 上，
  // 且因 requestKey 去重连新卡片都不会出（已复现的第三个绕过）。工作项早有同类校验，这里补齐。
  assertUniqueRecordId(state.executionTopologies, "topologyId", args.topologyId, "execution_topology_id_conflict");
  const topology = {
    schemaVersion: "execution-topology/v1",
    topologyId,
    projectId: taskGroup?.projectId || args.projectId || "prj_control_plane",
    taskGroupId: taskGroup?.id || args.taskGroupId || "tg_runtime_management",
    workItemId,
    status: "planned",
    mode,
    runnerKind,
    isolation,
    ...(args.runnerGrantRef ? {runnerGrantRef: String(args.runnerGrantRef)} : {}),
    ...((args.localVerificationEvidenceRefs || []).length ? {localVerificationEvidenceRefs: unique(args.localVerificationEvidenceRefs)} : {}),
    baseSnapshot: {
      stateVersion: Math.max(1, Number(state.stateVersion || 1)),
      gitHead: gitHead(root),
      dirtyDigest: digestOf(gitStatusPaths(root))
    },
    mergePolicy: "parent_serial_after_all_required_reported",
    groups: [{groupId: args.groupId || `${workItemId}_g1`, branches, blockers: []}],
    eligibilityGates: [...TOPOLOGY_ELIGIBILITY_GATES],
    blockers: [],
    auditRef: args.auditRef || `audit:execution-topology:${topologyId}`,
    createdAt: at,
    updatedAt: at
  };
  state.executionTopologies.unshift(topology);
  state.executionTopologies = capRetainingPredicate(state.executionTopologies, (item) => !TOPOLOGY_TERMINAL_STATUSES.includes(item.status), 2000);
  appendEvent(state, "execution_topology", "ExecutionTopology", topology.topologyId, "scheduler", {
    projectId: topology.projectId, taskGroupId: topology.taskGroupId, workItemId, mode, branchCount: branches.length
  });
  return {topology};
}

// The lever that walks the modeled ExecutionTopology transitions. Every action asserts the object's ACTUAL
// current status (not just machine legality) so a replayed/out-of-order call cannot skip a state, and each
// transition is recorded with the evidence the state machine's `requires` names.
export function advanceExecutionTopology(state, args) {
  const topology = (state.executionTopologies || []).find((item) => item.topologyId === args.topologyId);
  if (!topology) return {ok: false, error: "execution_topology_not_found"};
  if (TOPOLOGY_TERMINAL_STATUSES.includes(topology.status)) return {topology, alreadyTerminal: true};
  const action = String(args.action || "");
  const at = new Date().toISOString();
  const branches = (topology.groups || []).flatMap((group) => group.branches || []);
  // 定稿后 AI 不得更改方案：任何"按已批准方案往下走"的动作之前，先核对方案实质内容仍与定稿时一致。
  // （downgrade 有它自己的授权路径，report_branch 会写入执行结果因此不做此校验。）
  if (["start", "merge"].includes(action) && topology.humanFinalization?.subjectContentDigest) {
    const current = subjectContentSnapshot(state, {decisionType: "plan_topology", subjectRef: `ExecutionTopology:${topology.topologyId}`});
    if (!current || digestOf(current) !== topology.humanFinalization.subjectContentDigest) {
      throw topologyError("human_finalized_decision_diverged", 409);
    }
  }
  const expect = (status) => { if (topology.status !== status) throw topologyError(`execution_topology_expected_${status}_got_${topology.status}`); };
  const transition = (from, to, actor, requires) => recordTransition(state, "ExecutionTopology", topology.topologyId, from, to, actor, requires);

  if (action === "check_eligibility") {
    expect("planned");
    topology.blockers = evaluateTopologyEligibility(topology);
    topology.groups.forEach((group) => { group.blockers = topology.blockers.filter((blocker) => (group.branches || []).some((branch) => blocker.includes(branch.branchId))); });
    topology.status = "eligibility_checked";
    // 资格通过 => 这是一份可执行的方案，但"要不要按这个方案跑"是核心方案决策：挂人工定稿单，
    // 由人确认后才允许 start（见下方 start 分支的定稿校验）。资格不通过时不提案，先让人看到阻塞原因。
    if (!topology.blockers.length) {
      createHumanConfirmationRequest(state, {
        taskGroupId: topology.taskGroupId,
        workItemId: topology.workItemId,
        decisionType: "plan_topology",
        // 绑定到具体这一份拓扑，定稿锁按它落位（不能按 workItemId 找"最新的那份"）。
        subjectRef: `ExecutionTopology:${topology.topologyId}`,
        requestKey: `plan_topology:${topology.topologyId}`,
        summary: `执行方案确认：${topology.mode === "serial" ? "串行" : "并行"}执行 ${topology.workItemId}`,
        // 把每个分支【将要动哪些路径】直接写进卡片：这是这份授权真正的杀伤面，人必须看得见才谈得上知情同意。
        detail: `拟以 ${topology.mode} 模式执行，运行载体 ${topology.runnerKind}／隔离方式 ${topology.isolation}，共 ${branches.length} 个分支。\n` +
          branches.map((branch) => `· ${branch.branchId}：${branch.objective}｜将改动 ${(branch.ownedPaths || []).join("、") || "（未声明占用路径）"}｜验收 ${(branch.acceptanceChecks || []).join("、") || "（无）"}`).join("\n") +
          `\n方案需人工定稿后才会启动；定稿后若内容被改动将拒绝生效并回到人工确认。`,
        peerReview: {verdict: "eligibility_passed", findings: []},
        content: {mode: topology.mode, runnerKind: topology.runnerKind, isolation: topology.isolation, branches: branches.map((branch) => branch.branchId)},
        options: [
          {optionId: "accept_plan", label: "同意按此方案执行", description: "定稿后启动；AI 不再自行更改该方案。", recommended: true},
          {optionId: "reject", label: "不采用该方案", description: "退回，由人给出方案或要求降级为串行。"}
        ]
      });
    }
    transition("planned", "eligibility_checked", "scheduler", {
      topology_plan_ref: `ExecutionTopology:${topology.topologyId}`,
      branch_boundaries_defined: String(branches.length),
      base_snapshot_ref: `state:${topology.baseSnapshot.stateVersion}:${topology.baseSnapshot.gitHead}`
    });
  } else if (action === "start") {
    expect("eligibility_checked");
    if (topology.blockers.length) throw topologyError("execution_topology_eligibility_blocked");
    // 方案必须先由人定稿才能启动：AI 不得自己决定"按哪种方案跑"。
    const planLock = topology.humanFinalization;
    if (!(planLock?.decisionType === "plan_topology" && planLock.outcome === "confirmed")) {
      throw topologyError("execution_topology_requires_human_plan_confirmation", 409);
    }
    // Schema conditional for running/integrating/merged: a real runner and a real isolation boundary.
    if (topology.runnerKind === "none" || topology.isolation === "none") throw topologyError("execution_topology_requires_runner_and_isolation");
    topology.status = "running";
    branches.forEach((branch) => { if (branch.status === "queued") branch.status = "running"; });
    transition("eligibility_checked", "running", "scheduler", {
      runner_gate_passed: topology.runnerKind,
      isolation_available: topology.isolation,
      owned_paths_disjoint: "verified",
      resource_scopes_disjoint: "verified",
      result_bundle_contract: TOPOLOGY_BRANCH_OUTPUT_CONTRACT.join(",")
    });
  } else if (action === "downgrade") {
    expect("eligibility_checked");
    const reason = String(args.downgradeReason || args.reason || "");
    if (!reason) throw topologyError("execution_topology_downgrade_requires_reason", 400);
    // 降级会改变已定稿方案的实质内容（并行→串行）。规则是"AI 不得自行改，有分歧回到人工确认"：
    //   · 真人发起的降级 = 人自己改自己的定稿，直接放行并更新定稿记录；
    //   · AI/机器发起的降级 = 拦下，并【挂一张新的人工确认单】说明为什么要降级，交回人定夺。
    // 注意不能只拦不给出路：曾经这里只抛 human_finalized_decision_diverged，导致运行载体不可用时
    // 已定稿方案既不能降级、又因未 running 而不能取消，永久卡在 eligibility_checked 阻塞关闭门。
    // 人已经在降级申请单上批过"同意降级" => 授权已经拿到，机器据此执行即可（否则那个选项是死杠杆：
    // 批了不生效，AI 重试又被拒并再挂一张单，无限 approve→refuse→re-ask，拓扑与确认单一起卡死关闭门）。
    const downgradeApproved = (state.humanConfirmationRequests || []).some((item) =>
      item.decisionType === "plan_topology" &&
      item.subjectRef === `ExecutionTopology:${topology.topologyId}` &&
      item.decision?.action === "finalize" &&
      item.decision?.selectedOptionId === "accept_downgrade");
    if (topology.humanFinalization?.outcome === "confirmed" && !downgradeApproved) {
      if (isHumanConfirmationActor(state, args.actor)) {
        topology.humanFinalization = {
          ...topology.humanFinalization,
          finalizedBy: args.actor,
          finalizedAt: at,
          contentDigest: decisionContentDigest({decisionType: "plan_topology", workItemId: topology.workItemId, taskGroupId: topology.taskGroupId, content: {mode: "downgraded_serial", reason}})
        };
      } else {
        createHumanConfirmationRequest(state, {
          taskGroupId: topology.taskGroupId,
          workItemId: topology.workItemId,
          decisionType: "plan_topology",
          subjectRef: `ExecutionTopology:${topology.topologyId}`,
          requestKey: `plan_topology_downgrade:${topology.topologyId}`,
          summary: `已定稿方案申请降级为串行：${topology.workItemId}`,
          detail: `原因：${reason}。该方案已由人定稿，AI 不能自行更改；是否同意降级为串行执行，请人工决定。`,
          peerReview: {verdict: "downgrade_requested", findings: [reason]},
          content: {mode: "downgraded_serial", reason},
          options: [
            {optionId: "accept_downgrade", label: "同意降级为串行", description: "认可降级理由，改为串行执行。", recommended: true},
            {optionId: "reject", label: "不同意降级", description: "维持原定稿方案。"}
          ]
        });
        throw topologyError("human_finalized_decision_diverged", 409);
      }
    }
    topology.status = "downgraded";
    topology.mode = "downgraded_serial";
    topology.downgradeReason = reason;
    transition("eligibility_checked", "downgraded", "scheduler", {downgrade_reason: reason});
  } else if (action === "report_branch") {
    expect("running");
    const branch = branches.find((item) => item.branchId === args.branchId);
    if (!branch) return {ok: false, error: "execution_topology_branch_not_found"};
    branch.status = ["reported", "failed", "rejected", "blocked"].includes(args.branchStatus) ? args.branchStatus : "reported";
    if (args.resultRef) branch.resultRef = String(args.resultRef);
    branch.actualChangedPaths = unique([...(branch.actualChangedPaths || []), ...(args.actualChangedPaths || [])]);
    branch.validationEvidenceRefs = unique([...(branch.validationEvidenceRefs || []), ...(args.validationEvidenceRefs || [])]);
    if ((args.unresolvedRisks || []).length) branch.unresolvedRisks = unique([...(branch.unresolvedRisks || []), ...args.unresolvedRisks]);
    if ((args.derivedTaskRequestRefs || []).length) branch.derivedTaskRequestRefs = unique([...(branch.derivedTaskRequestRefs || []), ...args.derivedTaskRequestRefs]);
    // A branch that wrote outside the paths it owns breaks the disjointness the plan was admitted on.
    const strayPaths = (branch.actualChangedPaths || []).filter((path) => (branch.ownedPaths || []).length && !branch.ownedPaths.some((owned) => path === owned || path.startsWith(owned.replace(/\*+$/u, ""))));
    if (strayPaths.length) topology.blockers = unique([...topology.blockers, ...strayPaths.map((path) => `owned_paths_disjoint:${branch.branchId}:wrote_${path}`)]);
    if (branches.every((item) => ["reported", "accepted", "failed", "rejected"].includes(item.status))) {
      topology.status = "integrating";
      transition("running", "integrating", "orchestrator", {
        all_required_branches_reported: String(branches.length),
        branch_result_bundles_ref: branches.map((item) => item.resultRef || `branch:${item.branchId}`).join(",")
      });
    }
  } else if (action === "reconcile_required") {
    expect("running");
    topology.status = "needs_reconcile";
    topology.blockers = unique([...topology.blockers, `runner_handle_uncertain:${args.runnerId || "unknown"}`]);
    transition("running", "needs_reconcile", "monitor", {runner_handle_uncertain: String(args.runnerId || "unknown")});
  } else if (action === "reconcile") {
    expect("needs_reconcile");
    const evidence = String(args.reconcileEvidenceRef || "");
    if (!evidence) throw topologyError("execution_topology_reconcile_requires_evidence", 400);
    topology.blockers = topology.blockers.filter((blocker) => !blocker.startsWith("runner_handle_uncertain:"));
    topology.status = "integrating";
    transition("needs_reconcile", "integrating", "orchestrator", {runner_reconcile_evidence: evidence});
  } else if (action === "block") {
    expect("integrating");
    const ref = String(args.blockingDerivedTaskRequestRef || "");
    if (!ref) throw topologyError("execution_topology_block_requires_derived_task_request_ref", 400);
    topology.status = "blocked";
    topology.blockers = unique([...topology.blockers, `blocking_derived_task_request:${ref}`]);
    transition("integrating", "blocked", "orchestrator", {blocking_derived_task_request_ref: ref});
  } else if (action === "unblock") {
    expect("blocked");
    const ref = String(args.resolvedBlockerRef || args.blockingDerivedTaskRequestRef || "");
    if (!ref) throw topologyError("execution_topology_unblock_requires_resolved_ref", 400);
    // 只清除【这一条】阻塞，且【绝不】清除 owned_paths_disjoint 这类"分支写到了批准范围之外"的证据 ——
    // 那是事后唯一能证明越界的记录。原先是 includes(ref) 子串匹配，传个 "_" 就能把它们全抹掉。
    // 注意 block 存的是带前缀的 `blocking_derived_task_request:<ref>`，所以按这个完整键比对；
    // 直接拿裸 ref 做精确比对会永远匹配不上 —— blocked 状态就此没有杠杆（我自己引入过这个死锁）。
    const targetBlocker = `blocking_derived_task_request:${ref}`;
    const before = topology.blockers.length;
    topology.blockers = topology.blockers.filter((blocker) =>
      blocker.startsWith("owned_paths_disjoint:") || (blocker !== targetBlocker && blocker !== ref));
    if (topology.blockers.length === before) throw topologyError("execution_topology_blocker_not_found", 409);
    topology.status = "integrating";
    transition("blocked", "integrating", "orchestrator", {topology_blocker_resolved: ref});
  } else if (action === "merge") {
    expect("integrating");
    const validation = unique(args.finalValidationEvidenceRefs || []);
    if (!validation.length) throw topologyError("execution_topology_merge_requires_final_validation_evidence", 400);
    if (topology.blockers.length) throw topologyError("execution_topology_merge_blocked_by_topology_blockers");
    const unfinished = branches.filter((branch) => !["accepted", "reported"].includes(branch.status));
    if (unfinished.length) throw topologyError("execution_topology_merge_requires_all_branches_reported");
    branches.forEach((branch) => { branch.status = "accepted"; });
    topology.localVerificationEvidenceRefs = unique([...(topology.localVerificationEvidenceRefs || []), ...validation]);
    topology.status = "merged";
    transition("integrating", "merged", "orchestrator", {
      serial_integration_verified: topology.mergePolicy,
      final_validation_evidence: validation.join(","),
      no_topology_blockers: "0"
    });
  } else if (action === "cancel") {
    // 取消原先只能从 running 走，于是 integrating 是个死角：分支只要报了 failed/rejected，
    // 拓扑照样进入 integrating，而 merge 只认 accepted/reported、cancel 又够不着 —— 两头堵，
    // 并且 no_open_execution_topologies 会一直挡着关闭门。同理，写到批准范围之外留下的
    // owned_paths_disjoint 证据（刻意永不清除）也会让 merge 永远失败，那时唯一正确的出路就是取消。
    const cancellableFrom = ["running", "integrating", "blocked", "needs_reconcile"];
    if (!cancellableFrom.includes(topology.status)) {
      throw topologyError(`execution_topology_expected_${cancellableFrom.join("_or_")}`, 409);
    }
    const ref = String(args.cancelRef || args.reason || "");
    if (!ref) throw topologyError("execution_topology_cancel_requires_ref", 400);
    // 取消一个【已被人定稿】的方案，本身就是改变人的决定 —— 与降级同一条口径：AI 不得自行取消，
    // 必须回到人工确认；人自己来取消则直接生效并改写定稿记录。
    const cancelApproved = (state.humanConfirmationRequests || []).some((item) =>
      item.subjectRef === `ExecutionTopology:${topology.topologyId}` &&
      item.decision?.action === "finalize" &&
      item.decision?.selectedOptionId === "accept_cancel");
    if (topology.humanFinalization?.outcome === "confirmed" && !cancelApproved) {
      if (isHumanConfirmationActor(state, args.actor)) {
        topology.humanFinalization = {...topology.humanFinalization, finalizedBy: args.actor, finalizedAt: at,
          contentDigest: decisionContentDigest({decisionType: "plan_topology", workItemId: topology.workItemId, taskGroupId: topology.taskGroupId, content: {mode: "cancelled", reason: ref}})};
      } else {
        createHumanConfirmationRequest(state, {
          taskGroupId: topology.taskGroupId,
          workItemId: topology.workItemId,
          decisionType: "plan_topology",
          subjectRef: `ExecutionTopology:${topology.topologyId}`,
          requestKey: `plan_topology_cancel:${topology.topologyId}`,
          summary: `已定稿方案申请取消：${topology.workItemId}`,
          detail: `原因：${ref}。该方案已由人定稿，AI 不能自行取消；是否同意终止该执行方案，请人工决定。`,
          peerReview: {verdict: "cancel_requested", findings: [ref]},
          content: {mode: "cancelled", reason: ref},
          options: [
            {optionId: "accept_cancel", label: "同意终止该方案", description: "认可终止理由，取消这次执行方案。", recommended: true},
            {optionId: "reject", label: "不同意终止", description: "维持原定稿方案，继续处理阻塞。"}
          ]
        });
        throw topologyError("human_finalized_decision_diverged", 409);
      }
    }
    const previousStatus = topology.status;
    topology.status = "cancelled";
    topology.cancelRef = ref;
    transition(previousStatus, "cancelled", "orchestrator", {cancel_ref: ref});
  } else {
    return {ok: false, error: "execution_topology_unknown_action"};
  }

  topology.updatedAt = at;
  state.executionTopologies = capRetainingPredicate(state.executionTopologies, (item) => !TOPOLOGY_TERMINAL_STATUSES.includes(item.status), 2000);
  appendEvent(state, "execution_topology", "ExecutionTopology", topology.topologyId, "orchestrator", {
    projectId: topology.projectId, taskGroupId: topology.taskGroupId, action, status: topology.status, blockerCount: topology.blockers.length
  });
  return {topology};
}

export function classifyDerivedTask(state, args) {
  const title = `${args.title || ""} ${args.description || ""}`.toLowerCase();
  const signals = [];
  if (title.includes("review") || title.includes("audit")) signals.push("review_required");
  if (title.includes("test") || title.includes("qa")) signals.push("qa_required");
  if (title.includes("security") || title.includes("permission")) signals.push("security_required");
  const roleId = signals.includes("security_required") ? "security" : signals.includes("qa_required") ? "qa" : signals.includes("review_required") ? "reviewer" : args.roleId || "orchestrator";
  return {roleId, signals, modelDecision: selectModel(state, {...args, roleId})};
}

// 租约有 expiresAt，但全仓【没有任何代码读它】—— 也就是说租约从来不会过期。持有它的会话
// 若已经了结（或压根不存在了），这条 active 租约会永远挡住 all_leases_terminal，而 capLeaseHistory
// 还专门保证 active 的绝不被淘汰。设了到期时间却没人执行，等于没有到期时间。
// 只回收【确实已经过期】且【持有者不再存活】的租约：持有者还活着说明它只是没续期，
// 强行回收会把别人正在写的目标抢掉。
export function expireStaleLeases(state, nowMs = Date.now()) {
  const expired = [];
  for (const lease of state.leases || []) {
    if (lease.status !== "active") continue;
    const expiresAtMs = new Date(lease.expiresAt || 0).getTime();
    if (!expiresAtMs || expiresAtMs > nowMs) continue;
    const holderSessionId = String(lease.holderRef || "").replace("session:", "");
    const holder = (state.workSessions || []).find((item) => item.sessionId === holderSessionId);
    const holderAlive = holder && !WORK_SESSION_SETTLED_STATUSES.includes(holder.status);
    if (holderAlive) continue;
    lease.status = "expired";
    lease.expiredReason = holder ? "holder_session_settled" : "holder_missing";
    lease.updatedAt = new Date(nowMs).toISOString();
    // 租约走了，它绑定的产出目标也不能继续停在写入中的状态上没人管。
    const targetId = String(lease.resourceRef || "").replace("RepositoryOutputTarget:", "");
    const target = (state.repositoryOutputs || []).find((item) => item.targetId === targetId && item.leaseRef === lease.leaseId);
    if (target && !["pushed", "committed", "rejected", "superseded"].includes(target.status)) {
      target.status = "superseded";
      target.supersededReason = "lease_expired";
      target.updatedAt = lease.updatedAt;
      delete target.leaseRef;
    }
    expired.push(lease.leaseId);
  }
  return expired;
}

export function claimLease(state, args) {
  // 租约决定谁有写权限：冒名的同 id 租约会让受害会话的 target.leaseRef 永远匹配不上，
  // 该工作项再也提交不了检查点、到不了验收，且没有任何杠杆可清（第五轮复现）。
  assertUniqueRecordId(state.leases, "leaseId", args.leaseId, "lease_id_conflict");
  const targetRef = args.repositoryOutputTargetRef || args.targetId;
  const target = state.repositoryOutputs.find((item) => item.targetId === targetRef);
  if (!target) return {ok: false, error: "repository_output_target_not_found", targetRef};
  const at = new Date().toISOString();
  const resourceRef = `RepositoryOutputTarget:${target.targetId}`;
  const holderRef = args.holderRef || `session:${args.sessionId || createId("sess")}`;
  const existing = state.leases.find((item) => item.resourceRef === resourceRef && item.status === "active");
  if (existing) {
    if (existing.holderRef === holderRef) return {lease: existing, repositoryOutputTarget: target, replayedActiveLease: true};
    return {ok: false, error: "lease_already_active", activeLeaseRef: existing.leaseId, holderRef: existing.holderRef};
  }
  state.leaseSequence = Number(state.leaseSequence || 0) + 1;
  const lease = {
    leaseId: args.leaseId || createId("lease"),
    resourceRef,
    holderRef,
    status: "active",
    fencingToken: state.leaseSequence,
    sequence: state.leaseSequence,
    expiresAt: args.expiresAt || new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    createdAt: at,
    updatedAt: at
  };
  state.leases.unshift(lease);
  state.leases = capLeaseHistory(state.leases);
  target.status = "lease_bound";
  target.leaseRef = lease.leaseId;
  target.updatedAt = at;
  return {lease, repositoryOutputTarget: target};
}

export function releaseLease(state, args) {
  const lease = state.leases.find((item) => item.leaseId === args.leaseId);
  if (!lease) return {ok: false, error: "lease_not_found"};
  if (args.holderRef && lease.holderRef !== args.holderRef) return {ok: false, error: "lease_holder_mismatch"};
  if (!args.fencingToken) return {ok: false, error: "lease_fencing_token_required"};
  if (String(lease.fencingToken) !== String(args.fencingToken)) return {ok: false, error: "lease_fencing_token_mismatch"};
  lease.status = "released";
  lease.updatedAt = new Date().toISOString();
  return {lease};
}

// 定位符里嵌着摘要的前 40 位（运行时就是这么拼的）。强制这条绑定，摘要就不能与定位符各说各话 ——
// 这是控制面在【不接收内容】的前提下唯一能独立复核的一致性。它证明不了"摘要来自真实内容"，
// 只证明"这两样是同一次登记里配套的"，所以下游必须按自证对待。
// 门与淘汰谓词共用这一句：分成两处手写，就是刚被查出来的那种漂移。
export function artifactStillGating(item) {
  if (["verified", "rejected", "gc"].includes(item.status)) return false;
  return !(item.status === "registered" && item.contentDigestAttested === true);
}

function attestedArtifactDigest(args) {
  const digest = String(args.payload?.digest || "");
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) return null;
  const locators = [...(args.outputRefs || []), args.payload?.uri].filter(Boolean).map(String);
  const shortDigest = digest.slice("sha256:".length, "sha256:".length + 40);
  if (locators.length && !locators.some((ref) => ref.includes(shortDigest))) return null;
  return digest;
}

export function artifactRegister(state, args) {
  const at = new Date().toISOString();
  const taskGroup = taskGroupForRecord(state, args);
  const artifact = {
    artifactId: args.artifactId || createId("artifact"),
    projectId: taskGroup?.projectId || args.projectId || "prj_control_plane",
    taskGroupId: taskGroup?.id || args.taskGroupId || "tg_runtime_management",
    workItemId: args.workItemId || args.workId,
    repositoryOutputTargetRef: args.repositoryOutputTargetRef,
    artifactManifestRef: args.artifactManifestRef || args.path,
    outputRefs: args.outputRefs || [],
    // digestOf(args) 是【请求参数】的哈希：两次相同的请求得到相同的值，而它与文件内容毫无关系 ——
    // 一条"已按摘要登记"的证据其实什么都没有证明。运行时本来就在本地算好了内容哈希并放在
    // payload.digest 里，此前被整个丢掉。没有内容哈希的制品必须如实标注，不能借这个字段冒充可验证。
    // 摘要是【执行方在自己机器上算的】，证据内容从不上传到控制面（那是日志/截图/HAR/数据库转储，
    // 是全系统最敏感的数据；把它们收进控制面等于给自己造一个必须加密、必须管保留期的外泄目标）。
    // 因此控制面【无法】核验摘要与内容是否相符 —— 字段名必须说出这一点，不能叫 contentVerifiable
    // 那样暗示"已核验"。它的真实含义是：执行方声明了一个摘要，并且这个摘要与它给出的定位符自洽。
    contentDigest: attestedArtifactDigest(args),
    contentDigestAttested: Boolean(attestedArtifactDigest(args)),
    requestDigest: digestOf(args),
    status: "registered",
    createdAt: at
  };
  // 门现在认为"registered 但没有自证摘要"是阻塞项，而这里的终态集还写着 registered ——
  // 于是"正在挡门的东西"在淘汰逻辑眼里是可丢弃的终态，登记 2001 条就能把它挤掉。
  // 淘汰谓词必须与门判据同一句话。
  state.artifacts = capRetainingPredicate([artifact, ...state.artifacts], (item) => artifactStillGating(item), 2000);
  return {artifact};
}

export function permissionProbe(state, args, filter) {
  const subjectId = args.subjectId || args.accountId || "acct_agent_runtime";
  const permission = args.permission || args.action;
  const resource = normalizePermissionResource(args);
  const grants = state.accessGrants.filter((grant) =>
    grant.status === "active" &&
    grant.subjectRef?.subjectId === subjectId &&
    resourceMatches(grant.resource, resource) &&
    (!filter || filter.has(grantResourceProjectId(state, grant)))
  );
  const allowed = grants.some((grant) => (grant.permissions || []).includes(permission) || (grant.permissions || []).includes("*"));
  return {subjectId, permission, resource, allowed, grants};
}

// 授权铸造有两道门：REST 的 sanitizeGrantRequest 做了完整委派校验（拒 system:/通配、拒批准人
// 自己都没有的权限），而"申请-批准"这道门原样铸造申请人自选的权限，一道锁都没有。
// 同一间屋子两道门、其中一道没锁，是本仓反复出现的形态，所以判据放在这里由两侧共用。
export const UNSAFE_DELEGATED_GRANT_PERMISSIONS = new Set([
  "system:*", "project:*", "task_group:*", "project:create", "task_group:orchestrate", "task_group:checkpoint_submit"
]);
// 外部能力申请（github_push、网络访问…）与控制面授权申请共用这条通道，但只有后者会被铸成 grant。
export const PERMISSION_REQUEST_RESOURCE_TYPES = ["task_group", "project", "external_capability"];
export function isDelegatableGrantPermission(permission) {
  const value = String(permission || "");
  if (!value) return false;
  if (UNSAFE_DELEGATED_GRANT_PERMISSIONS.has(value)) return false;
  // system: 前缀整体不可经此通道授予 —— 拿到 system:account_admin 就能铸造 system_admin 账号，
  // 而人工定稿闸门只认 accountType，于是"铸造一个人"就等于摘掉整道闸门。
  if (value.startsWith("system:")) return false;
  return true;
}

export function permissionRequestSubmit(state, args) {
  // 冒名的授权请求会让"批准读权限"的点击铸出别的 grant（见 assertUniqueRecordId 注释）。
  assertUniqueRecordId(state.permissionRequests, "requestId", args.requestId, "permission_request_id_conflict");
  const at = new Date().toISOString();
  const request = {
    requestId: args.requestId || createId("perm_req"),
    subjectId: args.subjectId || args.subjectRef?.subjectId || "acct_agent_runtime",
    subjectRef: args.subjectRef || {subjectType: "account", subjectId: args.subjectId || "acct_agent_runtime"},
    resource: normalizePermissionResource(args),
    permission: args.permission || args.action || "task_group:read",
    sessionId: args.sessionId,
    taskGroupId: args.taskGroupId,
    workId: args.workId || args.workItemId,
    status: "pending_approval",
    reason: args.reason || args.actionReason || "machine permission request",
    createdAt: at,
    updatedAt: at
  };
  // Confused-deputy guard (covers HTTP + MCP submit): the resource that approval will grant must live in
  // the same project as the request's taskGroupId. Otherwise a principal authorized only for the task
  // group's project could approve a grant over a resource in a DIFFERENT project (same org). Reject the
  // mismatch at the source — in the legitimate flow the resource IS the task group, so no false reject.
  const resourceProjectId = request.resource.resourceType === "project"
    ? request.resource.resourceId
    : (state.taskGroups || []).find((taskGroup) => taskGroup.id === request.resource.resourceId)?.projectId;
  const requestTaskGroupProjectId = request.taskGroupId
    ? (state.taskGroups || []).find((taskGroup) => taskGroup.id === request.taskGroupId)?.projectId
    : null;
  // 这条通道有两种合法用途，判据不同，此前混作一谈：
  //   (a) external_capability —— 执行方申请一项外部能力（github_push、网络访问…）。它不是控制面
  //       授权，批准它不该铸出任何控制面权限。
  //   (b) task_group / project —— 控制面授权。它会被原样铸成 grant。
  // 危险的是自选出第三种：{system, accounts} 这样的资源配上 system:* 这样的权限。下面那道项目
  // 对齐守卫对"解析不出项目"的资源会短路放行 —— 守卫按它预期的形状写，遇到别的形状就失效。
  if (!PERMISSION_REQUEST_RESOURCE_TYPES.includes(request.resource.resourceType)) {
    const error = new Error("permission_request_resource_type_not_allowed");
    error.status = 400;
    throw error;
  }
  // 无论哪种用途，都不得经这条通道铸出不可委派的权限（通配/system:）。REST 那道门一直这么拒，
  // 这道门却原样放行 —— 同一间屋子两道门，其中一道没锁。
  if (!isDelegatableGrantPermission(request.permission)) {
    const error = new Error("permission_request_permission_not_delegable");
    error.status = 400;
    throw error;
  }
  // workId 会在 permission 被拒时经 releasePermissionDeniedSession 传给 terminateCellRuntime，
  // 于是"给别的格子报一个权限请求再自己拒掉"就能终结那个格子的执行、作废它的产出目标。
  // 声明的工作项必须真的属于声明的任务组。
  if (request.taskGroupId && request.workId) {
    const owningGroup = (state.taskGroups || []).find((item) => item.id === request.taskGroupId);
    if (!(owningGroup?.workItems || []).some((item) => item.id === request.workId)) {
      const error = new Error("permission_request_work_item_scope_mismatch");
      error.status = 400;
      throw error;
    }
  }
  if (request.taskGroupId && request.resource.resourceType !== "external_capability" && !resourceProjectId) {
    // 控制面资源解析不出所属项目时必须 fail closed，而不是当作"无从比较"放行。
    const error = new Error("permission_request_resource_scope_unresolvable");
    error.status = 400;
    throw error;
  }
  if (request.taskGroupId && resourceProjectId && requestTaskGroupProjectId && resourceProjectId !== requestTaskGroupProjectId) {
    const error = new Error("permission_request_resource_project_mismatch");
    error.status = 400;
    throw error;
  }
  state.permissionRequests = capRetainingOpen([request, ...state.permissionRequests], ["approved", "rejected", "resolved", "revoked", "expired", "cancelled"], 2000);
  if (args.sessionId) {
    // 这里会把【任意】sessionId 的会话直接推到 permission_required：既能把别的格子、甚至
    // 别的项目里【已经了结】的会话复活成非终态（对方的关闭门就此永久被挡），也能配合随后的
    // permission "拒绝" 去调 terminateCellRuntime，把别人格子的产出目标与租约一并作废 ——
    // 全程无人工参与。守卫作用域是按 taskGroupId 落的，而被改变的资源是那个会话，两者不一致。
    // 会话必须属于本请求声明的任务组，且已了结的会话不得被复活。
    const session = state.workSessions.find((item) => item.sessionId === args.sessionId);
    if (session && request.taskGroupId && session.taskGroupId !== request.taskGroupId) {
      const error = new Error("permission_request_session_scope_mismatch");
      error.status = 400;
      throw error;
    }
    if (session && WORK_SESSION_SETTLED_STATUSES.includes(session.status)) {
      const error = new Error("permission_request_session_already_settled");
      error.status = 409;
      throw error;
    }
    if (session) {
      session.status = "permission_required";
      session.updatedAt = at;
    }
  }
  return {permissionRequest: request};
}

// A permission request whose runtime poll timed out leaves a blocked, node-detached dispatch marked
// "permission_request_pending" (stamped by the /fail(blocked) route). Locate it so the resolve levers can
// act on the dispatch — the happy path keeps the dispatch running and needs no dispatch action, but the
// timed-out dispatch is otherwise orphaned (non-terminal → wedges the close barrier with no lever).
export function findPermissionBlockedDispatch(state, request) {
  if (!request) return null;
  return (state.agentDispatches || []).find((dispatch) =>
    dispatch.status === "blocked" && dispatch.blockedReason === "permission_request_pending" &&
    ((request.sessionId && dispatch.sessionId === request.sessionId) ||
     (request.workId && dispatch.workItemId === request.workId && dispatch.taskGroupId === request.taskGroupId))) || null;
}

// On APPROVAL of a timed-out permission request, requeue the orphaned dispatch so a node re-claims and
// re-executes it with the grant now in place (mirrors decideHumanConfirmation's blocked->queued requeue).
export function requeuePermissionApprovedDispatch(state, request, at = new Date().toISOString()) {
  const dispatch = findPermissionBlockedDispatch(state, request);
  if (!dispatch) return null;
  dispatch.status = "queued";
  delete dispatch.blockedReason;
  revokeDispatchNodeBinding(state, dispatch, "permission_request_approved_requeued");
  dispatch.updatedAt = at;
  const session = (state.workSessions || []).find((item) => item.sessionId === dispatch.sessionId);
  if (session && !WORK_SESSION_SETTLED_STATUSES.includes(session.status)) {
    session.status = "active";
    delete session.blockedReason;
    session.updatedAt = at;
  }
  const taskGroup = (state.taskGroups || []).find((group) => group.id === dispatch.taskGroupId);
  const workItem = taskGroup?.workItems?.find((item) => item.id === dispatch.workItemId);
  if (workItem && workItem.status === "needs_decision" && workItem.blockedReason === "permission_request_pending") {
    workItem.status = "ready";
    delete workItem.blockedReason;
    workItem.updatedAt = at;
  }
  return dispatch;
}

// 评审计划此前是【只能创建、无法终结】的：创建时写死 "planned"，而关闭门要求它进入终态，
// 全仓却没有任何迁移入口 —— 建过一次评审计划，这个任务组就永远关不掉，人也没有任何杠杆。
// 这里补上它缺失的后半段生命周期：评审结论回流即累计覆盖度，要求的评审角色全部到齐即闭合。
export const REVIEW_PLAN_TERMINAL_STATUSES = ["closed", "rejected", "superseded"];

export function reviewPlanRecordCoverage(state, args) {
  // 同上：即使指定了 reviewPlanId，也必须落在调用方自己的任务组内，否则可以推进（乃至闭合）
  // 别人的评审计划。
  const plan = (state.reviewPlans || []).find((item) => item.taskGroupId === args.taskGroupId && (args.reviewPlanId
    ? item.reviewPlanId === args.reviewPlanId
    : !REVIEW_PLAN_TERMINAL_STATUSES.includes(item.status)));
  if (!plan) return null;
  if (REVIEW_PLAN_TERMINAL_STATUSES.includes(plan.status)) return plan;
  const at = new Date().toISOString();
  if (args.reviewerRole) plan.coveredReviewerRoles = [...new Set([...(plan.coveredReviewerRoles || []), args.reviewerRole])];
  const required = plan.requiredReviewerRoles || [];
  const covered = plan.coveredReviewerRoles || [];
  const satisfied = required.length > 0 && required.every((role) => covered.includes(role));
  // 覆盖度达成即闭合：评审计划本身不是"重大方案选择"，任务组关闭那道人工定稿闸门仍然在后面挡着，
  // 所以这里自动推进不会绕过人工确认，只是不再把流程卡死。
  plan.status = satisfied ? "closed" : "in_progress";
  if (satisfied) plan.closedAt = at;
  plan.updatedAt = at;
  return plan;
}

export function reviewPlanCreate(state, args) {
  const taskGroup = taskGroupForRecord(state, args);
  const at = new Date().toISOString();
  const plan = {
    schemaVersion: "review-plan/v1",
    reviewPlanId: args.reviewPlanId || createId("review_plan"),
    projectId: taskGroup?.projectId || args.projectId || "prj_control_plane",
    taskGroupId: taskGroup?.id || args.taskGroupId || "tg_runtime_management",
    status: "ready",
    reviewScopeRefs: args.reviewScopeRefs || [`TaskGroup:${taskGroup?.id || "tg_runtime_management"}`],
    requiredReviewerRoles: args.requiredReviewerRoles || ["reviewer", "qa"],
    coveredReviewerRoles: [],
    evidenceRefs: args.evidenceRefs || [],
    createdAt: at,
    updatedAt: at
  };
  state.reviewPlans.unshift(plan);
  state.reviewPlans = capRetainingPredicate(state.reviewPlans, (item) => !REVIEW_PLAN_TERMINAL_STATUSES.includes(item.status), 2000);
  return {reviewPlan: plan};
}

export function reviewBundleRegister(state, args) {
  // 同一个 id 注册两次会让 review_result_consume 的 find 只命中最新那份，旧副本永远停在
  // submitted 上挡着 no_pending_review_bundles，而且没有第二条杠杆能碰到它。
  // 这与 claimLease / permissionRequestSubmit 等处是同一条 id 唯一性纪律。
  assertUniqueRecordId(state.reviewBundles, "reviewBundleId", args.reviewBundleId, "review_bundle_id_conflict");
  const at = new Date().toISOString();
  const taskGroup = taskGroupForRecord(state, args);
  const bundle = {
    schemaVersion: "review-bundle/v1",
    reviewBundleId: args.reviewBundleId || createId("review_bundle"),
    projectId: taskGroup?.projectId || args.projectId || "prj_control_plane",
    taskGroupId: taskGroup?.id || args.taskGroupId || "tg_runtime_management",
    // "submitted" is a MODELED ReviewBundle state (was the unmodeled "registered"). It is non-terminal, so
    // it blocks the close barrier's no_pending_review_bundles gate until review_result_consume terminalizes
    // it — that is the resolving lever, so this is a pending external review, not a permanent wedge.
    status: "submitted",
    artifactRefs: args.artifactRefs || [],
    checkpointRefs: args.checkpointRefs || [],
    evidenceRefs: args.evidenceRefs || [],
    createdAt: at,
    updatedAt: at
  };
  state.reviewBundles.unshift(bundle);
  state.reviewBundles = capRetainingOpen(state.reviewBundles, ["consumed", "rejected"], 160);
  return {reviewBundle: bundle};
}

export function approvalRequestCreate(state, args) {
  // 冒名的审批请求可自带 quorum:1 / riskClass:low，让高危多方审批塌缩成一次点击。
  assertUniqueRecordId(state.approvalRequests, "approvalId", args.approvalId, "approval_request_id_conflict");
  const at = new Date().toISOString();
  const taskGroup = taskGroupForRecord(state, args);
  const request = {
    approvalId: args.approvalId || createId("approval"),
    projectId: taskGroup?.projectId || args.projectId || "prj_control_plane",
    taskGroupId: taskGroup?.id || args.taskGroupId || "tg_runtime_management",
    action: args.action || "guarded_action",
    resource: args.resource || {},
    // "pending" 不在 ApprovalRequest 的已登记状态里 —— 按 schema 校验这条记录本身就是非法的，
    // 而关闭门又照着已登记枚举去判，两边对不上。统一到已登记的初始态 requested。
    status: "requested",
    riskClass: args.riskClass || "medium",
    requiredApprovers: args.requiredApprovers || ["policy-engine", "security"],
    quorum: Number(args.quorum || 1),
    // Proposer identity for high_risk_no_self_approval enforcement, and the running set of distinct
    // approvers for the AI-quorum tally (approvalResolve). proposedBy is the authenticated actor that
    // requested the guarded action — never a client-supplied field.
    proposedBy: args.proposedBy || null,
    approvals: [],
    expiresAt: args.expiresAt || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    decisionRecordRef: args.decisionRecordRef || `decision:approval:${at}`,
    auditRef: args.auditRef || `audit:approval:${at}`,
    createdAt: at,
    updatedAt: at
  };
  state.approvalRequests = capRetainingOpen([request, ...state.approvalRequests], ["approved", "rejected", "cancelled", "expired"], 2000);
  return {approvalRequest: request};
}

export function policyDecisionEval(state, args) {
  const at = new Date().toISOString();
  const policyDecision = {
    decisionId: args.decisionId || createId("pd"),
    action: args.action || "mcp_tool_call",
    resource: args.resource || {},
    subjectRef: args.subjectRef || {subjectType: "service", subjectId: "mcp-proxy"},
    result: args.allowed === false ? "denied" : "allowed",
    reasonCode: args.reasonCode || "local_mcp_policy_eval",
    evidenceRefs: args.evidenceRefs || [],
    createdAt: at
  };
  // Cap at the source: policy decisions are point-in-time (immediately terminal) records emitted on
  // EVERY guarded/MCP write, and this collection is central (not sharded). Without a source cap it
  // grows unbounded in central state on the MCP-first path (the UI server's separate 120-cap does
  // not cover MCP callers).
  state.policyDecisions = [policyDecision, ...state.policyDecisions].slice(0, Math.max(100, Number(process.env.AIMAC_POLICY_DECISIONS_CAP || 500)));
  return {policyDecision};
}

const findingTerminalStatuses = ["resolved", "closed", "dismissed", "wontfix"];

function nonTerminalFindingStatus(status, fallback) {
  // Raising a finding must never terminalize it; only governance-mcp.finding_resolve can. This keeps
  // finding_submit (available to control-role agents) from bypassing the resolve separation of duties.
  return status && !findingTerminalStatuses.includes(status) ? status : fallback;
}

// Finding 的终态集：门与 findingResolve 必须用同一份，否则两边各自手打就会再次漂移。
export const FINDING_TERMINAL_STATUSES = ["resolved", "closed", "dismissed", "wontfix"];

export function findingSubmit(state, args) {
  const at = new Date().toISOString();
  if (args.findingId) {
    const existing = (state.findings || []).find((item) => item.findingId === args.findingId);
    if (existing) {
      Object.assign(existing, {
        severity: args.severity || existing.severity,
        status: nonTerminalFindingStatus(args.status, existing.status),
        summary: args.summary || existing.summary,
        evidenceRefs: [...new Set([...(existing.evidenceRefs || []), ...(args.evidenceRefs || [])])],
        updatedAt: at
      });
      return {finding: existing};
    }
  }
  const taskGroup = taskGroupForRecord(state, args);
  const finding = {
    findingId: args.findingId || createId("finding"),
    projectId: taskGroup?.projectId || args.projectId || "prj_control_plane",
    taskGroupId: taskGroup?.id || args.taskGroupId || "tg_runtime_management",
    workItemId: args.workItemId || args.workId,
    findingType: args.findingType || "governance",
    severity: args.severity || "medium",
    status: nonTerminalFindingStatus(args.status, "open"),
    summary: args.summary || "Machine-submitted finding",
    evidenceRefs: args.evidenceRefs || [],
    createdAt: at,
    updatedAt: at
  };
  state.findings = capRetainingOpen([finding, ...state.findings], findingTerminalStatuses, 2000);
  return {finding};
}

// 允许作为"已妥善闭合"的处置类（close-barrier 只认这些 + 相应证据/归属）
const VALID_FINDING_DISPOSITIONS = ["fixed_verified", "not_applicable", "scope_adjusted", "blocked_external"];

// 不修即放行的处置类：缺陷仍然存在，只是被判定为不必修。这不是事实核验，是决定。
export const NON_REMEDIATION_DISPOSITIONS = ["not_applicable", "scope_adjusted"];
// 这两个是降级出来的处置类：它们表示这次处置没能了结该发现项，因此发现项必须保持 open —— 
// 既让关闭门继续挡住，也让人还能看见它、还能再处置它。
export const NON_CLOSING_FINDING_DISPOSITIONS = ["fixed_unverified", "blocked_external_incomplete"];

// 真人处置身份用 Symbol 作键传递，而不是普通字段。MCP / REST 的入参都来自 JSON，
// JSON 表达不出 Symbol 键 —— 于是"自报 humanActor"在结构上就不可能，不必依赖每个调用点
// 记得剥离它（逐点剥离总会漏掉下一个新调用点，这一类漏洞我已经反复交过学费）。
export const HUMAN_ACTOR_KEY = Symbol.for("dleno.control-plane.humanActor");

export function findingResolve(state, args) {
  const finding = (state.findings || []).find((item) => item.findingId === args.findingId);
  if (!finding) return {ok: false, error: "finding_not_found"};
  // Terminal guard: a finding is terminalized exactly once (only finding_resolve may terminalize it —
  // separation of duties from finding_submit). Without this a fresh-idempotency-key re-call could
  // re-dispose a settled fixed_unverified finding into an accepted class (dismissed/not_applicable),
  // passing the close barrier's "no unfixed finding" gate with no new evidence. Return the settled finding.
  if (findingTerminalStatuses.includes(finding.status)) return {finding, alreadyResolved: true};
  const terminal = FINDING_TERMINAL_STATUSES;
  const status = terminal.includes(args.status) ? args.status : "resolved";
  const evidenceRefs = [...new Set([...(finding.evidenceRefs || []), ...(args.evidenceRefs || [])])];
  // 处置类：显式指定优先，否则按状态派生；不足证据/归属者降级为不可闭合类，供 close-barrier 拦截"无修复即闭合"
  let disposition = VALID_FINDING_DISPOSITIONS.includes(args.dispositionClass)
    ? args.dispositionClass
    : {resolved: "fixed_verified", closed: "fixed_verified", dismissed: "not_applicable", wontfix: "scope_adjusted"}[status];
  if (disposition === "fixed_verified" && evidenceRefs.length === 0) disposition = "fixed_unverified";
  if (disposition === "blocked_external" && !(args.rootCauseOwner && (args.recoveryRef || args.resolutionRef))) disposition = "blocked_external_incomplete";
  // "已修复且有证据"是可核验的事实判断，AI 可以做；但 not_applicable / scope_adjusted 是
  // 【不修就放行】的决定 —— 缺陷还在，只是被判定为不必修。这类判断由 AI 自己下，等于它可以
  // 把自己造出来的问题一笔勾销，关闭门也随之通过。故这两类必须由真人处置。
  const humanActor = args[HUMAN_ACTOR_KEY] || null;
  if (NON_REMEDIATION_DISPOSITIONS.includes(disposition) && !humanActor) {
    return {ok: false, error: "finding_disposition_requires_human", dispositionClass: disposition};
  }
  // 降级出来的两个处置类表示"这次处置【没有】把它了结掉"（证据不足 / 归属与恢复路径不全）。
  // 原先仍然把 status 写成终态，后果是三重的：关闭门因处置类不合格继续阻塞、一次性守卫拒绝
  // 再次处置、控制台只列非终态发现项所以人根本看不见它 —— 一个既挡路、又改不动、还看不到的东西。
  // 没有了结，就不该写成已了结。
  const closesFinding = !NON_CLOSING_FINDING_DISPOSITIONS.includes(disposition);
  finding.status = closesFinding ? status : "open";
  finding.dispositionClass = disposition;
  if (!closesFinding) {
    finding.lastResolutionAttempt = {
      attemptedStatus: status, dispositionClass: disposition,
      reason: disposition === "fixed_unverified" ? "evidence_refs_missing" : "root_cause_owner_or_recovery_ref_missing",
      at: new Date().toISOString()
    };
  } else {
    delete finding.lastResolutionAttempt;
  }
  if (humanActor) finding.dispositionedBy = humanActor;
  finding.resolutionRef = args.resolutionRef || `resolution:${status}`;
  if (args.rootCauseOwner) finding.rootCauseOwner = args.rootCauseOwner;
  if (args.recoveryRef) finding.recoveryRef = args.recoveryRef;
  finding.evidenceRefs = evidenceRefs;
  finding.updatedAt = new Date().toISOString();
  return {finding, closed: closesFinding, ...(closesFinding ? {} : {downgraded: disposition})};
}

export function contractPublish(state, args) {
  // 这是受控的发布路径（REST 侧需 project:*）。sharedDefinitionCreate 的状态枚举守卫是用来挡
  // "调用方自选状态"的，不该把这条合法的激活路径也降级成 draft —— 那会让每次发布都留下一条
  // 永久阻塞关闭门、且人没有入口清除的记录（我上一版就是这样把修复变成了新的拒绝服务）。
  const contract = sharedDefinitionCreate(state, {...args, status: "active", allowDirectActivation: true}).sharedDefinition;
  return {contract};
}

// 规则来源分流：discovered = 刚发现、还没判定它算不算本项目的规则，属于未了结，必须挡住关闭门；
// resolved/active 表示已判定为规则并生效；reference_only/quarantined/rejected/superseded 为终态。
// 建立时只能是 discovered（"发现了一份材料，还没人判定它算不算本项目的规则"）。
// 判为 active（采纳为本项目规则）是规则层决策，必须真人 —— 与共享定义契约同一条口径：
// AI 不得自行宣布什么是本项目的规范。
// 关于下面那个 AI_SETTLEABLE 集：唯一的 settle 入口 /api/rule-source-resolutions/:id/settle 已是
// 真人专属，所以【当前没有任何调用方会走到 AI 分支】。保留它不是装饰，而是因为这条函数级约束
// 才是真正的判据：将来若接上 MCP 工具让执行方自行"判为不采纳"，AI 也绝不会顺手把它判成 active。
// 若最终确定不接 MCP 入口，这个集合应当连同分支一起删掉，而不是留在这里看起来像一道保护。
export const RULE_SOURCE_AI_SETTLEABLE_STATUSES = ["reference_only", "quarantined", "rejected"];
export const RULE_SOURCE_HUMAN_ONLY_STATUSES = ["active"];
export const RULE_SOURCE_TERMINAL_STATUSES = ["reference_only", "quarantined", "rejected", "superseded"];

export function ruleSourceResolve(state, args) {
  const at = new Date().toISOString();
  const resolution = {
    schemaVersion: "rule-source-resolution/v1",
    resolutionId: args.resolutionId || createId("rsr"),
    // 此前这条记录不带 projectId/taskGroupId，而两道关闭门都按 taskGroupId 过滤 ——
    // 就算状态名拼对了，过滤器也恒为空集，门照样是空转的。
    projectId: args.projectId || "prj_control_plane",
    taskGroupId: args.taskGroupId || "tg_runtime_management",
    sourceRef: args.sourceRef || "reference:unknown",
    sourceScope: args.sourceScope || "reference_material",
    status: "discovered",
    classification: args.classification || "reference_only",
    adoptionPolicy: args.classification === "generic_mechanism" ? "external_review_required" : "not_active_rule",
    evidenceRefs: args.evidenceRefs || [],
    createdAt: at,
    updatedAt: at
  };
  state.ruleSourceResolutions.unshift(resolution);
  state.ruleSourceResolutions = capRetainingPredicate(state.ruleSourceResolutions, (item) => !RULE_SOURCE_TERMINAL_STATUSES.includes(item.status), 2000);
  return {ruleSourceResolution: resolution};
}

// 分流记录建出来是 discovered，而在此之前【全仓没有任何迁移入口】—— 建一条就永久挡住关闭门。
// 这是把一道空转门改成阻塞门时漏掉的后半段：门有了牙齿，就必须同时有出口。
export function ruleSourceSettle(state, args) {
  const resolution = (state.ruleSourceResolutions || []).find((item) =>
    item.resolutionId === args.resolutionId && item.taskGroupId === args.taskGroupId);
  if (!resolution) return {ok: false, error: "rule_source_resolution_not_found"};
  if (RULE_SOURCE_TERMINAL_STATUSES.includes(resolution.status)) return {ruleSourceResolution: resolution, alreadySettled: true};
  const humanActor = args[HUMAN_ACTOR_KEY] || null;
  const wantsAdoption = RULE_SOURCE_HUMAN_ONLY_STATUSES.includes(args.status);
  if (wantsAdoption && !humanActor) return {ok: false, error: "rule_source_adoption_requires_human"};
  if (!wantsAdoption && !RULE_SOURCE_AI_SETTLEABLE_STATUSES.includes(args.status)) {
    return {ok: false, error: "rule_source_status_invalid"};
  }
  resolution.status = args.status;
  resolution.adoptionPolicy = wantsAdoption ? "active_project_rule" : "not_active_rule";
  if (humanActor) resolution.settledBy = humanActor;
  if (args.justification) resolution.settlementJustification = String(args.justification).slice(0, 2000);
  resolution.updatedAt = new Date().toISOString();
  return {ruleSourceResolution: resolution};
}

// 创建时允许声明的状态：只有推进流程的早期态。active/conflicted 等"有实际效力"的状态必须经受控路径。
const SHARED_DEFINITION_CREATABLE_STATUSES = ["draft", "owner_assigned", "proposed", "reviewing"];
// 真正构成"未完成、必须先处理掉"的状态。draft 不在内：它是"还没提出来"，不该阻塞任何人关闭任务组。
const SHARED_DEFINITION_CONFLICT_POLICIES = ["block_and_request_canonical_decision", "owner_reconciles_then_republish"];
const SHARED_DEFINITION_BLOCKING_STATUSES = ["owner_assigned", "proposed", "reviewing", "change_requested", "conflicted"];

export function sharedDefinitionCreate(state, args) {
  // 与其它承载授权的记录同规:同 id 的冒名契约会顶替掉已生效的那份（目前 governance-mcp.* 对机器
  // 主体禁用故不可达，但不依赖"暂时不可达"）。
  assertUniqueRecordId(state.sharedDefinitions, "contractId", args.contractId, "shared_definition_id_conflict");
  const at = new Date().toISOString();
  const taskGroup = taskGroupForRecord(state, args);
  const projectId = taskGroup?.projectId || args.projectId || "prj_control_plane";
  const scopedTaskGroupId = taskGroup?.id || args.taskGroupId;
  const definition = {
    schemaVersion: "shared-definition-contract/v1",
    contractId: args.contractId || createId("sdc"),
    // 状态必须落在建模枚举内，且【不能由调用方直接声明为生效/冲突】：
    // 一个 AI 若能自选 status:"conflicted"，就能把整个项目的关闭门永久锁死（人没有任何杠杆可清）。
    // 生效只能经 shared_definition_publish 这条受控路径。
    status: args.allowDirectActivation === true
      ? (args.status || "active")
      : (SHARED_DEFINITION_CREATABLE_STATUSES.includes(args.status) ? args.status : "draft"),
    projectId,
    definitionType: args.definitionType || "semantic_contract",
    // 空数组在 JS 里是真值：原先 `args.scopeRefs || [...]` 会让 scopeRefs:[] 存活，而
    // sharedDefinitionAppliesToWork 把"空作用域"当成【适用于项目内所有任务组】—— 于是一条契约
    // 就能横扫整个项目。空数组一律回落到本任务组作用域。
    scopeRefs: (Array.isArray(args.scopeRefs) && args.scopeRefs.length ? args.scopeRefs : null)
      || [scopedTaskGroupId ? `TaskGroup:${scopedTaskGroupId}` : `Project:${projectId}`],
    canonicalOwnerRole: args.canonicalOwnerRole || args.ownerRole || "orchestrator",
    producerRole: args.producerRole || args.ownerRole || "orchestrator",
    consumerRefs: args.consumerRefs || [],
    definitionDigest: digestOf(args.definition || args),
    repositoryOutputTargetRef: args.repositoryOutputTargetRef || "rot_shared_definition",
    repositoryOutputTargetDigest: digestOf(args.repositoryOutputTargetRef || "rot_shared_definition"),
    // 这两个字段此前给的是随手写的对象（conflictPolicy schema 要字符串枚举，changePolicy 的三个
    // 必填布尔一个都没有）—— 也就是说，分发给所有 agent 的"本项目规范"载体，自己不符合自己的契约。
    // requiresDecisionRecord/consumerAckRequired 在 schema 里是 const true：规范变更必须有决策记录、
    // 必须要消费方确认，不允许被创建方调低。
    conflictPolicy: SHARED_DEFINITION_CONFLICT_POLICIES.includes(args.conflictPolicy) ? args.conflictPolicy : "block_and_request_canonical_decision",
    changePolicy: {
      requiresDecisionRecord: true,
      invalidatesConsumers: args.changePolicy?.invalidatesConsumers !== false,
      consumerAckRequired: true
    },
    reviewEvidenceRefs: args.reviewEvidenceRefs || [],
    createdAt: at,
    updatedAt: at
  };
  state.sharedDefinitions.unshift(definition);
  return {sharedDefinition: definition};
}
