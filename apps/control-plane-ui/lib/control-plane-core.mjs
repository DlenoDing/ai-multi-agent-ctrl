import { execFileSync } from "node:child_process";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

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

const embeddedMcpToolCount = 77;

const modelProviderAdapters = providerClasses.map((providerClass) => ({
  providerClass,
  adapterId: `adapter:${providerClass}`,
  credentialEnvNames: credentialEnvNames(providerClass),
  invocationMode: ["ollama", "vllm", "custom"].includes(providerClass) ? "local_or_http_endpoint" : "provider_api",
  status: "configured"
}));

const roleProfiles = {
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

const reasoningRank = {low: 0, standard: 1, medium: 2, high: 3, max: 4, ultra: 5};
const modelTierRank = {standard: 0, frontier_economy: 1, frontier_standard: 2, frontier_plus: 3};

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
    enforcement: rawPolicy.enforcement === "advisory" ? "advisory" : "required",
    fallback: ["return_blocked_for_language_mismatch", "translate_or_return_blocked"].includes(rawPolicy.fallback)
      ? rawPolicy.fallback
      : (fallbackPolicy.fallback || defaultLanguagePolicy.fallback)
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
  state.progressSnapshots ||= [];
  state.repositoryOutputs ||= [];
  state.sharedDefinitions ||= [];
  state.accessGrants ||= [];
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
  computeProgressSnapshots(state);
  return state;
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
  return Object.entries(roleProfiles).map(([roleId, profile]) => ({
    schemaVersion: "agent-role-skill/v1",
    sourceId: "system-default",
    roleSkillId: `system-${roleId}`,
    sourcePath: `runtime://system-role-skills/${roleId}`,
    name: `${roleId} system role skill`,
    description: `Built-in role skill for ${roleId} until agency-agents-zh is synced.`,
    category: profile.category,
    frontmatterDigest: digestOf({roleId, type: "frontmatter"}),
    contentDigest: digestOf({roleId, capabilities: profile.capabilities}),
    capabilities: profile.capabilities,
    defaultModelRequirements: {
      strengths: profile.strengths,
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
  return Object.keys(roleProfiles).map((roleId) => ({
    ...clone(common),
    policyId: `msp_${roleId}`,
    roleId,
    requiredCapabilities: roleProfiles[roleId].capabilities
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

export function decideSessionPlacement(state, request = {}) {
  ensureRuntimeCollections(state);
  const taskGroup = state.taskGroups?.find((item) => item.id === request.taskGroupId);
  const workItem = request.workItem || findWorkItem(state, request.taskGroupId, request.workItemId) || {};
  const modelDecision = request.modelSelectionDecision || selectModel(state, request);
  const signals = unique([...(request.workSignals || []), ...inferWorkSignals(workItem, taskGroup)]);
  const activeSubagents = state.workSessions.filter((session) => session.parentSessionId === "sess_orch_1" && session.placement === "subagent" && !["completed_objective", "failed", "closed", "recycled", "aborted"].includes(session.status)).length;
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
  if (placement === "subagent") {
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
    rulesetDigest: digestOf("ruleset:ai-native-control-plane:v1"),
    effectiveInstructionPacketRef: packetRef,
    digestRefs: ["ruleset:ai-native-control-plane:v1", `model-selection:${modelDecision.decisionId}`, `session-placement:${placementDecision.decisionId}`, `language-policy:${languagePolicyDigest}`],
    languagePolicy,
    languagePolicyDigest,
    sharedDefinitionRefs,
    actionBasis: {
      effectiveInstructionPacketRef: packetRef,
      sourceKind: "orchestrator_plan",
      sourceRef: `TaskGroup:${taskGroup?.id || "tg_runtime_management"}`,
      nextActionDraftDigest: digestOf({workItem, action: "execute"}),
      activeRuleRefs: ["terminal-execution-manifest:v1", "state-machines:v1", "language-policy:v1"],
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
  state.agentTaskContracts = state.agentTaskContracts.slice(0, 160);
  state.workSessions.unshift({
    sessionId,
    projectId: contract.projectId,
    taskGroupId: contract.taskGroupId,
    workItemId: contract.workId,
    roleId: contract.roleId,
    agentId: agentForRole(state, contract.roleId)?.id || "agent_orchestrator",
    placement: placementDecision.placement,
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

export function runAutonomousCycle(state, request = {}) {
  ensureRuntimeCollections(state, {root: request.root, endpoint: request.endpoint});
  const changed = [];
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
          changed.push({status: "blocked", reason: "skill_source_sync_failed", issueRef: issue.patternId || issue.sampleId});
          return {changed, progressSnapshots: computeProgressSnapshots(state).slice(0, 8)};
        }
      }
    }
  }
  const taskGroups = (state.taskGroups || []).filter((taskGroup) => !request.taskGroupId || taskGroup.id === request.taskGroupId);
  for (const taskGroup of taskGroups) {
    if (["closed", "aborted"].includes(taskGroup.status) || ["active_paused_by_freeze", "active_paused_by_control"].includes(taskGroup.goalExecutionStatus)) continue;
    for (const workItem of taskGroup.workItems || []) {
      if (workItem.status === "superseded") continue;
      if (["verified", "closed"].includes(workItem.status) && workItem.progress >= 100) continue;
      if (["checkpoint_submitted", "code_complete", "review_requested", "review_passed", "verification_ready"].includes(workItem.status)) {
        const review = performIndependentReview(state, taskGroup, workItem, request);
        changed.push({taskGroupId: taskGroup.id, workItemId: workItem.id, status: workItem.status, progress: workItem.progress, awaiting: review.verdict === "passed" ? null : "independent_review", review});
        continue;
      }
      const missingDefinition = relatedSharedDefinitions(state, taskGroup, workItem).find((definition) => definition.status !== "active");
      if (missingDefinition) {
        addBlocker(taskGroup, "S1", `Shared definition ${missingDefinition.contractId} is not active for ${workItem.id}.`);
        changed.push({taskGroupId: taskGroup.id, workItemId: workItem.id, status: "blocked", reason: "shared_definition_not_active", sharedDefinitionRef: missingDefinition.contractId});
        if (request.mode !== "until_blocked" && request.mode !== "all") break;
        continue;
      }
      const active = activeExecutionForWork(state, taskGroup.id, workItem.id);
      if (active) {
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
      const split = splitMixedWorkItemIfNeeded(state, taskGroup, workItem);
      if (split) {
        changed.push({taskGroupId: taskGroup.id, workItemId: workItem.id, status: "superseded", reason: "mixed_analysis_implementation_split", derivedWorkItemIds: split.derivedWorkItemIds});
        if (request.mode !== "until_blocked" && request.mode !== "all") break;
        continue;
      }
      let contract;
      try {
        contract = buildTaskContract(state, {projectId: taskGroup.projectId, taskGroupId: taskGroup.id, workItemId: workItem.id, workItem, root: request.root});
      } catch (error) {
        if (error.code !== "AIMAC_MODEL_SELECTION_REJECTED") throw error;
        workItem.status = "blocked";
        workItem.blockedReason = "model_selection_rejected";
        workItem.updatedAt = new Date().toISOString();
        addBlocker(taskGroup, "S1", `No runnable model satisfied hard constraints for ${workItem.id}.`);
        changed.push({taskGroupId: taskGroup.id, workItemId: workItem.id, status: "blocked", reason: "model_selection_rejected", modelSelectionDecisionRef: error.decision?.decisionId});
        continue;
      }
      const repositoryTarget = state.repositoryOutputs.find((target) => target.targetId === contract.repositoryOutputTargetRef);
      const drift = evaluateRoleDrift(state, {sessionId: contract.sessionId, taskGroupId: taskGroup.id, actionScopeRefs: [`TaskGroup:${taskGroup.id}`, `RepositoryOutputTarget:${repositoryTarget.targetId}`]});
      if (!drift.allowed) {
        workItem.status = "blocked";
        addBlocker(taskGroup, "S0", `Role drift guard blocked dispatch for ${workItem.id}.`);
        changed.push({taskGroupId: taskGroup.id, workItemId: workItem.id, status: "blocked", reason: "role_drift_guard_blocked"});
        continue;
      }
      const dispatch = dispatchWorkItem(state, taskGroup, workItem, contract, repositoryTarget);
      changed.push({taskGroupId: taskGroup.id, workItemId: workItem.id, status: workItem.status, progress: workItem.progress, sessionId: contract.sessionId, dispatchId: dispatch.dispatchId, awaiting: "agent_runtime_checkpoint"});
      if (request.mode !== "until_blocked" && request.mode !== "all") break;
    }
    recomputeTaskGroup(taskGroup);
    computeCompletionReadiness(state, taskGroup.id, request);
    computeCloseBarrier(state, taskGroup.id, request);
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
    status: "blocked",
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
  state.derivedTaskRequests.unshift({
    requestId: createId("dtr"),
    projectId: taskGroup.projectId,
    taskGroupId: taskGroup.id,
    sourceWorkItemId: workItem.id,
    status: "accepted",
    classification: "mixed_analysis_implementation_split",
    derivedWorkItemRefs: [analysis.id, implementation.id],
    createdAt: at,
    updatedAt: at
  });
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
  if (contract.writeScope.length) {
    const lease = ensureLease(state, repositoryTarget, `session:${contract.sessionId}`, contract.contractDigest);
    repositoryTarget.status = "lease_bound";
    repositoryTarget.leaseRef = lease.leaseId;
  } else {
    repositoryTarget.status = "selected";
  }
  repositoryTarget.updatedAt = at;
  if (workItem.status === "draft") {
    recordTransition(state, "WorkItem", workItem.id, "draft", "ready", "orchestrator", ["task_contract_created", contract.effectiveInstructionPacketRef, contract.repositoryOutputTargetRef]);
    workItem.status = "ready";
  }
  if (workItem.status === "ready") {
    recordTransition(state, "WorkItem", workItem.id, "ready", "assigned", "scheduler", ["agent_selected", contract.modelSelectionDecisionRef, contract.placementDecisionRef]);
    workItem.status = "assigned";
  }
  workItem.progress = Math.max(Number(workItem.progress || 0), 5);
  workItem.repositoryOutputTargetRef = repositoryTarget.targetId;
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
  if (!checkpointInput.languagePolicyDigest) {
    return {accepted: false, status: 409, error: "checkpoint_language_policy_digest_required"};
  }
  if (checkpointInput.languagePolicyDigest !== expectedLanguagePolicyDigest) {
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
  appendEvent(state, "checkpoint_submitted", "Checkpoint", `${checkpoint.taskGroupId}:${checkpoint.workId}:${checkpoint.runId}`, session.roleId, checkpoint);
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
      addBlocker(taskGroup, "S0", `Role drift guard blocked runtime worker for ${workItem.id}.`);
      results.push({dispatchId: dispatch.dispatchId, status: "failed", reason: "role_drift_guard_blocked"});
      continue;
    }
    const deterministicLocalWorker = request.allowDeterministicLocalWorker === true &&
      state.runtime?.executionProfile === "verification" &&
      existsSync(join(root, ".aimac-verification-repository"));
    const hasRuntimeCredential = dispatch.requiredCredentialEnvNames.length === 0 || dispatch.requiredCredentialEnvNames.some((name) => Boolean(process.env[name]));
    if (!deterministicLocalWorker && !hasRuntimeCredential) {
      markDispatchBlocked(state, dispatch, "credential_required");
      workItem.status = "blocked";
      addBlocker(taskGroup, "S1", `Agent runtime credential is required for ${dispatch.requiredCredentialEnvNames.join(" or ")}.`);
      results.push({dispatchId: dispatch.dispatchId, status: "blocked", reason: "credential_required", requiredCredentialEnvNames: dispatch.requiredCredentialEnvNames});
      continue;
    }
    if (!deterministicLocalWorker && !process.env.AIMAC_AGENT_RUNTIME_EXECUTOR_COMMAND) {
      markDispatchBlocked(state, dispatch, "agent_runtime_executor_required");
      workItem.status = "blocked";
      addBlocker(taskGroup, "S1", "Agent runtime executor command is required for provider-backed model execution.");
      results.push({dispatchId: dispatch.dispatchId, status: "blocked", reason: "agent_runtime_executor_required"});
      continue;
    }
    dispatch.status = "running";
    dispatch.attempts += 1;
    dispatch.updatedAt = new Date().toISOString();
    session.status = "active";
    session.updatedAt = dispatch.updatedAt;
    if (workItem.status === "assigned") {
      recordTransition(state, "WorkItem", workItem.id, "assigned", "in_progress", "work-session", ["task_contract_valid", target.targetId]);
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
  const languagePolicy = normalizeTaskGroupLanguagePolicy(taskGroup.languagePolicy);
  const languagePolicyDigest = digestOf(languagePolicy);
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
  for (const project of state.projects || []) {
    const taskGroups = (state.taskGroups || []).filter((taskGroup) => taskGroup.projectId === project.id);
    const workItems = taskGroups.flatMap((taskGroup) => taskGroup.workItems || []);
    const counters = countWork(workItems);
    const progressPercent = workItems.length ? Math.round(workItems.reduce((sum, item) => sum + Number(item.progress || 0), 0) / workItems.length) : project.progress?.percent || 0;
    project.progress ||= {};
    project.progress.percent = progressPercent;
    project.progress.openTaskGroups = taskGroups.filter((taskGroup) => !["closed", "aborted"].includes(taskGroup.status)).length;
    project.progress.blockedItems = counters.blocked;
    project.progress.health = counters.blocked ? "attention" : taskGroups.some((taskGroup) => taskGroup.health === "attention") ? "attention" : "ok";
    project.progress.updatedAt = at;
    snapshots.push(progressSnapshot("project", project.id, project.status, project.progress, project.progress.health, counters, taskGroups.flatMap((taskGroup) => taskGroup.roles || []), workItems, state.repositoryOutputs.filter((target) => target.projectId === project.id), at));
  }
  for (const taskGroup of state.taskGroups || []) {
    const counters = countWork(taskGroup.workItems || []);
    snapshots.push(progressSnapshot("task_group", taskGroup.id, taskGroup.status, {percent: taskGroup.progress || 0, phase: taskGroup.phase || taskGroup.status}, taskGroup.health || "ok", counters, taskGroup.roles || [], taskGroup.workItems || [], state.repositoryOutputs.filter((target) => target.taskGroupId === taskGroup.id), at));
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
    blockers: workItems.filter((item) => ["blocked", "failed"].includes(item.status)).map((item) => item.id),
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

function activeExecutionForWork(state, taskGroupId, workItemId) {
  const session = (state.workSessions || []).find((item) =>
    item.taskGroupId === taskGroupId &&
    item.workItemId === workItemId &&
    !["completed_objective", "failed", "closed", "recycled", "aborted"].includes(item.status)
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
  state.agentDispatches = state.agentDispatches.slice(0, 240);
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
  const signals = [];
  const taskGroup = state.taskGroups.find((item) => item.id === guard.taskGroupId);
  const workItem = taskGroup?.workItems?.find((item) => item.id === guard.workItemId);
  if (taskGroup && digestOf(taskGroup.objective || "objective") !== guard.objectiveBoundaryDigest) signals.push("objective_boundary_mismatch");
  if (workItem && digestOf(workItem.ownerRole || "role") !== guard.roleMissionDigest) signals.push("role_mission_mismatch");
  for (const ref of request.actionScopeRefs || []) {
    if (!guard.allowedActionScopeRefs.includes(ref)) signals.push(`scope_not_allowed:${ref}`);
  }
  for (const ref of request.forbiddenActionScopeRefs || []) {
    if (guard.forbiddenActionScopeRefs.includes(ref)) signals.push(`forbidden_scope:${ref}`);
  }
  const driftScore = Math.min(1, signals.length * 0.1);
  guard.driftScore = driftScore;
  guard.driftSignals = unique([...(guard.driftSignals || []), ...signals]);
  guard.updatedAt = new Date().toISOString();
  if (driftScore > guard.maxAllowedDriftScore) {
    guard.status = "correction_required";
    appendEvent(state, "blocker", "RoleDriftGuard", guard.guardId, "monitor", {projectId: guard.projectId, taskGroupId: guard.taskGroupId, signals});
    return {allowed: false, driftScore, signals, guardRef: guard.guardId};
  }
  return {allowed: true, driftScore, signals, guardRef: guard.guardId};
}

function countWork(workItems) {
  const active = (workItems || []).filter((item) => item.status !== "superseded");
  return {
    total: active.length,
    done: active.filter((item) => ["verified", "closed"].includes(item.status) || Number(item.progress || 0) >= 100).length,
    inProgress: active.filter((item) => ["ready", "assigned", "in_progress", "checkpoint_submitted", "review_requested", "review_passed", "verification_ready"].includes(item.status)).length,
    blocked: active.filter((item) => ["blocked", "failed"].includes(item.status)).length
  };
}

export function computeCompletionReadiness(state, taskGroupId, request = {}) {
  ensureRuntimeCollections(state);
  const taskGroup = state.taskGroups.find((item) => item.id === taskGroupId);
  const at = new Date().toISOString();
  const workItems = (taskGroup?.workItems || []).filter((item) => item.status !== "superseded");
  const verifiedItems = workItems.filter((item) => ["verified", "closed"].includes(item.status));
  const taskGroupCheckpoints = (state.checkpoints || []).filter((checkpoint) => checkpoint.taskGroupId === taskGroupId);
  const pendingStatuses = ["open", "pending", "requested", "submitted", "in_review", "waiting"];
  const checkFailures = {
    no_open_execution_topology: (state.executionTopologies || []).some((item) => item.taskGroupId === taskGroupId && !["closed", "completed", "superseded"].includes(item.status)),
    no_open_review_plan: (state.reviewPlans || []).some((item) => item.taskGroupId === taskGroupId && !["closed", "completed", "cancelled"].includes(item.status)),
    no_pending_review_bundle: (state.reviewBundles || []).some((item) => item.taskGroupId === taskGroupId && !["consumed", "closed"].includes(item.status)),
    no_blocking_derived_task_request: (state.derivedTaskRequests || []).some((item) => item.taskGroupId === taskGroupId && pendingStatuses.includes(item.status)),
    no_pending_external_review: (state.reviewBundles || []).some((item) => item.taskGroupId === taskGroupId && item.reviewMode === "external" && !["consumed", "closed"].includes(item.status)),
    no_active_role_drift_guard: (state.roleDriftGuards || []).some((guard) => guard.taskGroupId === taskGroupId && !["closed", "corrected"].includes(guard.status)),
    effective_instruction_packet_active: (state.effectiveInstructionPackets || []).some((packet) => packet.taskGroupId === taskGroupId && !["active", "consumed", "expired", "superseded"].includes(packet.status)),
    shared_definitions_active: relatedSharedDefinitions(state, taskGroup).some((definition) => definition.status !== "active"),
    repository_output_target_terminal: (state.repositoryOutputs || []).filter((target) => target.taskGroupId === taskGroupId).some((target) => !["pushed", "committed", "rejected", "superseded"].includes(target.status)),
    all_required_outputs_present: workItems.length === 0 || workItems.some((item) => !["verified", "closed"].includes(item.status)),
    all_required_evidence_present: !taskGroupCheckpoints.some((checkpoint) => checkpoint.commitRefs?.length && checkpoint.pushRefs?.length && checkpoint.artifactManifestRefs?.length),
    all_required_validation_present: verifiedItems.some((item) => !item.reviewBundleRef && !(state.reviewBundles || []).some((bundle) => bundle.workItemId === item.id && bundle.verdict === "passed")),
    no_pending_permission_or_approval: (state.permissionRequests || []).some((item) => item.taskGroupId === taskGroupId && pendingStatuses.includes(item.status)) ||
      (state.approvalRequests || []).some((item) => item.taskGroupId === taskGroupId && pendingStatuses.includes(item.status)),
    no_unreconciled_command_effect: (state.commandEffects || []).some((item) => item.taskGroupId === taskGroupId && item.status !== "reconciled")
  };
  const blockers = [];
  if (checkFailures.all_required_outputs_present) blockers.push({objectType: "WorkItem", objectId: taskGroup?.id || taskGroupId, status: "open"});
  if (checkFailures.no_active_role_drift_guard) blockers.push({objectType: "RoleDriftGuard", objectId: taskGroupId, status: "active"});
  if (checkFailures.shared_definitions_active) blockers.push({objectType: "SharedDefinitionContract", objectId: taskGroupId, status: "not_active"});
  if (checkFailures.repository_output_target_terminal) blockers.push({objectType: "RepositoryOutputTarget", objectId: taskGroupId, status: "non_terminal"});
  if ((state.workSessions || []).some((session) => session.taskGroupId === taskGroupId && !["completed_objective", "failed", "closed", "recycled", "aborted"].includes(session.status))) blockers.push({objectType: "WorkSession", objectId: taskGroupId, status: "active"});
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
  const readiness = state.completionReadiness.find((item) => item.taskGroupId === taskGroupId) || computeCompletionReadiness(state, taskGroupId, request);
  const nowMs = Date.now();
  const pendingStatuses = ["open", "pending", "requested", "submitted", "in_review", "waiting"];
  const forTaskGroup = (items) => (items || []).filter((item) => item.taskGroupId === taskGroupId);
  const notModeled = {status: "passed", reasonCode: "not_applicable_collection_not_modeled"};
  const gateFailures = {
    all_required_work_closed: readiness.blockingObjects.some((item) => item.objectType === "WorkItem"),
    all_findings_terminal: forTaskGroup(state.findings).some((item) => !["resolved", "closed", "dismissed", "wontfix"].includes(item.status)),
    all_quality_gates_passed: forTaskGroup(state.qualityGates).some((item) => !["passed", "waived"].includes(item.status)),
    all_contracts_compatible: relatedSharedDefinitions(state, taskGroup).some((definition) => ["conflict", "blocked"].includes(definition.status)),
    all_changes_integrated: forTaskGroup(state.repositoryOutputs).some((target) => !["pushed", "committed", "rejected", "superseded"].includes(target.status)),
    no_pending_permissions: forTaskGroup(state.permissionRequests).some((item) => pendingStatuses.includes(item.status)),
    no_pending_approvals: forTaskGroup(state.approvalRequests).some((item) => pendingStatuses.includes(item.status)),
    all_policy_decisions_terminal: false,
    all_commands_terminal: (state.commands || []).some((command) => String(command.subject || "").includes(taskGroupId) && !["succeeded", "failed", "cancelled"].includes(command.status)),
    all_command_effects_terminal: forTaskGroup(state.commandEffects).some((item) => item.status !== "reconciled"),
    no_active_dlq: false,
    all_leases_terminal: (state.leases || []).some((lease) => lease.status === "active" && leaseAppliesToTaskGroup(state, lease, taskGroupId)),
    no_active_temp_grants: (state.mcpGrants || []).some((grant) => grant.taskGroupId === taskGroupId && grant.grantStatus === "issued" && new Date(grant.expiresAt || 0).getTime() > nowMs),
    no_active_secret_leases: false,
    no_open_external_capability_boundaries: false,
    artifacts_verified: forTaskGroup(state.artifacts).some((item) => !["verified", "registered"].includes(item.status)),
    release_manifest_ready: false,
    rules_candidates_processed: (state.ruleSourceResolutions || []).some((item) => item.taskGroupId === taskGroupId && pendingStatuses.includes(item.status)),
    runtime_issue_candidates_exported: forTaskGroup(state.systemUpgradeCandidates).some((item) => item.status === "candidate_created"),
    no_open_execution_topologies: forTaskGroup(state.executionTopologies).some((item) => !["closed", "completed", "superseded"].includes(item.status)),
    no_blocking_derived_task_requests: forTaskGroup(state.derivedTaskRequests).some((item) => pendingStatuses.includes(item.status)),
    all_review_plans_closed: forTaskGroup(state.reviewPlans).some((item) => !["closed", "completed", "cancelled"].includes(item.status)),
    no_pending_review_bundles: forTaskGroup(state.reviewBundles).some((item) => !["consumed", "closed"].includes(item.status)),
    all_rule_sources_resolved: (state.ruleSourceResolutions || []).some((item) => item.taskGroupId === taskGroupId && item.status === "conflict"),
    completion_readiness_clear: readiness.status !== "clear",
    no_active_role_drift_blockers: readiness.blockingObjects.some((item) => item.objectType === "RoleDriftGuard"),
    all_effective_instruction_packets_terminal: forTaskGroup(state.effectiveInstructionPackets).some((packet) => !["active", "consumed", "expired", "superseded"].includes(packet.status)),
    all_shared_definitions_active: relatedSharedDefinitions(state, taskGroup).some((definition) => definition.status !== "active"),
    all_repository_output_targets_terminal: forTaskGroup(state.repositoryOutputs).some((target) => !["pushed", "committed", "rejected", "superseded"].includes(target.status))
  };
  const notModeledGates = new Set(["all_policy_decisions_terminal", "no_active_dlq", "no_active_secret_leases", "no_open_external_capability_boundaries", "release_manifest_ready"]);
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
      ...(gateFailures[gate] ? {reasonCode: `gate_blocked:${gate}`} : {}),
      ...(notModeledGates.has(gate) && !gateFailures[gate] ? {reasonCode: notModeled.reasonCode} : {})
    }])),
    blockingObjects: blockers,
    evidenceRefs: [`close:${taskGroupId}`, readiness.checkId],
    computedAt: at,
    satisfied
  };
  state.closeBarriers = [barrier, ...state.closeBarriers.filter((item) => item.taskGroupId !== taskGroupId)].slice(0, 80);
  if (satisfied && request.mutate === true && taskGroup) {
    taskGroup.status = "closed";
    taskGroup.goalExecutionStatus = "closed";
    taskGroup.progress = 100;
    taskGroup.health = "ok";
    taskGroup.updatedAt = at;
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
  if (!existsSync(join(repoDir, ".git"))) {
    execFileSync("git", ["clone", source.repositoryUrl, repoDir], {stdio: "pipe"});
  }
  execFileSync("git", ["-C", repoDir, "fetch", "origin", source.defaultRef], {stdio: "pipe"});
  execFileSync("git", ["-C", repoDir, "checkout", "--detach", source.pinnedCommit], {stdio: "pipe"});
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

function resolveRoleSkill(state, roleId, request = {}) {
  const profile = roleProfiles[roleId] || roleProfiles.orchestrator;
  const baseSkill = state.roleSkills.find((skill) => skill.roleSkillId === profile.skillRef || skill.roleSkillId.endsWith(profile.skillRef)) ||
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
  const existing = state.repositoryOutputs.find((target) => target.taskGroupId === taskGroup?.id && target.workItemId === workItem?.id);
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
    forbiddenPathRules: request.forbiddenPathRules || [".runtime/**", ".git/**", "node_modules/**", ".env", ".env.local", ".env.production"],
    status: "selected",
    outputPolicy: "project_git_repository_only",
    decisionRecordRef: request.decisionRecordRef || `decision:repo-target:${workItem?.id || "work"}`,
    artifactManifestPath: request.artifactManifestPath || `docs/artifact-manifests/${workItem?.id || "work"}.json`,
    auditRef: request.auditRef || `audit:repo-target:${workItem?.id || "work"}`,
    createdAt: at,
    updatedAt: at
  };
  state.repositoryOutputs.push(target);
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

function recomputeTaskGroup(taskGroup) {
  const items = (taskGroup.workItems || []).filter((item) => item.status !== "superseded");
  taskGroup.progress = items.length ? Math.round(items.reduce((sum, item) => sum + Number(item.progress || 0), 0) / items.length) : 100;
  taskGroup.health = items.some((item) => ["blocked", "failed"].includes(item.status)) ? "blocked" : "ok";
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

function relatedSharedDefinitions(state, taskGroup, workItem) {
  if (!taskGroup) return [];
  return (state.sharedDefinitions || []).filter((definition) => sharedDefinitionAppliesToWork(definition, taskGroup, workItem));
}

function sharedDefinitionAppliesToWork(definition, taskGroup, workItem) {
  if (!definition || !taskGroup) return false;
  if (definition.projectId && definition.projectId !== taskGroup.projectId) return false;
  const refs = new Set([...(definition.scopeRefs || []), ...(definition.consumerRefs || [])].filter(Boolean));
  const projectRefs = [`Project:${taskGroup.projectId}`, taskGroup.projectId, "Project"];
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
    payloadDigest: digestOf(payload || {}),
    payloadRef: `state-event:${subjectType}:${subjectId}`
  };
  state.eventLog.unshift(event);
  state.eventLog = state.eventLog.slice(0, 240);
  return event;
}

function recordTransition(state, machine, objectId, from, to, actor, evidenceRefs = []) {
  const transition = {
    transitionId: createId("trn"),
    machine,
    objectId,
    from,
    to,
    actor,
    evidenceRefs,
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
    recordTransition(state, "WorkItem", workItem.id, from, to, "agent-runtime", [`checkpoint:${checkpoint.runId}`, ...(checkpoint.evidenceRefs || [])]);
    from = to;
  }
  workItem.status = "review_requested";
  workItem.reviewState = "review_requested";
}

export function performIndependentReview(state, taskGroup, workItem, request = {}) {
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
  const bundle = {
    schemaVersion: "review-bundle/v1",
    bundleId: createId("rvb"),
    projectId: taskGroup.projectId,
    taskGroupId: taskGroup.id,
    workItemId: workItem.id,
    checkpointRef: `checkpoint:${checkpoint.runId}`,
    reviewerRole: "reviewer",
    reviewMode: "independent_control_plane_review",
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
  state.reviewBundles = state.reviewBundles.slice(0, 160);
  if (verdict !== "passed") {
    workItem.reviewState = "changes_requested";
    workItem.updatedAt = at;
    addBlocker(taskGroup, "S1", `Independent review requested changes for ${workItem.id}: ${findings.join(",")}`);
    appendEvent(state, "review_result", "WorkItem", workItem.id, "reviewer", {verdict, findings, reviewBundleRef: bundle.bundleId});
    return {reviewed: true, verdict, reviewBundleRef: bundle.bundleId, findings};
  }
  let from = workItem.status;
  if (["checkpoint_submitted", "code_complete"].includes(from)) {
    recordTransition(state, "WorkItem", workItem.id, from, "review_requested", "agent-runtime", [`checkpoint:${checkpoint.runId}`]);
    from = "review_requested";
  }
  if (from === "review_requested") {
    recordTransition(state, "WorkItem", workItem.id, "review_requested", "review_passed", "reviewer", [`review-bundle:${bundle.bundleId}`, `local_verification_evidence:${finalCommit}`, "adoption_classification:adopted"]);
    from = "review_passed";
  }
  if (from === "review_passed") {
    recordTransition(state, "WorkItem", workItem.id, "review_passed", "verification_ready", "orchestrator", [`review-bundle:${bundle.bundleId}`]);
    from = "verification_ready";
  }
  if (from === "verification_ready") {
    recordTransition(state, "WorkItem", workItem.id, "verification_ready", "verified", "qa", [`verification_evidence:push:${checkpoint.pushRefs?.at(-1)?.remoteSha || finalCommit}`]);
  }
  workItem.status = "verified";
  workItem.reviewState = "review_passed";
  workItem.reviewBundleRef = bundle.bundleId;
  workItem.progress = 100;
  workItem.updatedAt = at;
  appendEvent(state, "review_result", "WorkItem", workItem.id, "reviewer", {verdict, reviewBundleRef: bundle.bundleId});
  return {reviewed: true, verdict, reviewBundleRef: bundle.bundleId};
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
    const escaped = pattern
      .split("**")
      .map((segment) => segment
        .split("*")
        .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
        .join("[^/]*"))
      .join(".*");
    return new RegExp(`^${escaped}$`, "u").test(path);
  });
}

export function defaultSourceConfig() {
  return clone(defaultSkillSource);
}
