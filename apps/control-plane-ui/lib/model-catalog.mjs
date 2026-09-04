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

export const embeddedServices = [
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

export const agentJoinCommand = "create one-time join token in project UI, then run the generated curl installer command on the Agent host";

export const embeddedMcpLogicalServers = [
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

export const modelProviderAdapters = providerClasses.map((providerClass) => ({
  schemaVersion: "model-provider/v1",
  providerClass,
  adapterId: `adapter:${providerClass}`,
  credentialEnvNames: credentialEnvNames(providerClass),
  invocationMode: ["ollama", "vllm", "custom"].includes(providerClass) ? "local_or_http_endpoint" : "provider_api",
  status: "discovered"
}));

export const REGISTERED_OWNER_ROLES = ["orchestrator", "decision-center", "scheduler", "work-session", "reviewer", "qa",
  "security", "release", "rule-steward", "monitor", "agent-runtime", "command-bus", "permission-gateway", "policy-engine",
  "mcp-proxy", "room-broker", "model-registry", "skill-registry", "identity-service", "ui-console-service",
  "repository-router", "instruction-optimizer"];

export const roleCapabilityHints = {
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

export const providerDefaults = {
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

export const providerDefaultModelIds = {
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

export const defaultModelCeiling = {
  maxModelTier: "frontier_standard",
  maxReasoningLevel: "high",
  escalationPolicy: "special_signal_required"
};

export function credentialEnvNames(providerClass) {
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
