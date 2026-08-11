#!/usr/bin/env ruby
# frozen_string_literal: true

require "json"
require "set"
require "yaml"

ROOT = File.expand_path("..", __dir__)

def load_json(path)
  JSON.parse(File.read(File.join(ROOT, path)))
end

def load_yaml(path)
  YAML.load_file(File.join(ROOT, path))
end

def fail_with(errors)
  return if errors.empty?

  warn "spec validation failed:"
  errors.each { |error| warn "- #{error}" }
  exit 1
end

errors = []

Dir[File.join(ROOT, "spec/*.json")].sort.each do |path|
  JSON.parse(File.read(path))
rescue JSON::ParserError => e
  errors << "#{path.sub("#{ROOT}/", "")}: invalid JSON: #{e.message}"
end

Dir[File.join(ROOT, "spec/*.yaml")].sort.each do |path|
  YAML.load_file(path)
rescue Psych::SyntaxError => e
  errors << "#{path.sub("#{ROOT}/", "")}: invalid YAML: #{e.message}"
end

manifest = load_yaml("spec/terminal-execution-manifest.yaml")
state_machines = load_yaml("spec/state-machines.yaml")
gates = load_yaml("spec/gates.yaml")
close_barrier = load_json("spec/close-barrier.schema.json")
completion_readiness = load_json("spec/completion-readiness.schema.json")
control_events = load_json("spec/control-events.schema.json")
package_json = load_json("package.json")
seed_state = load_json("data/seed-state.json")
session_placement_decision = load_json("spec/session-placement-decision.schema.json")
repository_output_target_schema = load_json("spec/repository-output-target.schema.json")

required_runtime_files = %w[
  package.json
  Dockerfile
  docker-compose.yml
  scripts/start.sh
  scripts/docker-up.sh
  scripts/run-with-env.mjs
  scripts/contract-check.mjs
  scripts/init-control-plane.mjs
  scripts/doctor.mjs
  scripts/doctor-mcp.mjs
  scripts/doctor-agent-remote.mjs
  scripts/agentctl.mjs
  scripts/install-agent.sh
  scripts/register-mcp-client.mjs
  scripts/sync-agent-skills.mjs
  apps/mcp-server/server.mjs
  apps/agent-runtime/runtime.mjs
  apps/control-plane-ui/server.mjs
  apps/control-plane-ui/lib/control-plane-core.mjs
  apps/control-plane-ui/lib/state-store.mjs
  apps/control-plane-ui/lib/project-event-store.mjs
  apps/control-plane-ui/public/index.html
  apps/control-plane-ui/public/styles.css
  apps/control-plane-ui/public/app.js
  data/seed-state.json
  spec/agent-dispatch.schema.json
  spec/agent-control-command.schema.json
  spec/agent-execution-event.schema.json
  spec/agent-join-token.schema.json
  spec/agent-runtime-node.schema.json
  spec/agent-skill-workset.schema.json
]

required_runtime_files.each do |path|
  errors << "runtime entrypoint missing: #{path}" unless File.exist?(File.join(ROOT, path))
end

required_npm_scripts = %w[init dev start shell:start mcp:start mcp:doctor agentctl agent:doctor skills:sync contract:check validate doctor docker:build docker:up docker:doctor]
available_scripts = package_json.fetch("scripts", {})
missing_npm_scripts = required_npm_scripts.reject { |script_name| available_scripts.key?(script_name) }
errors << "package.json missing scripts: #{missing_npm_scripts.join(", ")}" unless missing_npm_scripts.empty?

unless File.executable?(File.join(ROOT, "scripts/start.sh"))
  errors << "scripts/start.sh must be executable"
end
unless File.executable?(File.join(ROOT, "scripts/docker-up.sh"))
  errors << "scripts/docker-up.sh must be executable"
end
unless File.executable?(File.join(ROOT, "scripts/install-agent.sh"))
  errors << "scripts/install-agent.sh must be executable"
end

dockerfile = File.read(File.join(ROOT, "Dockerfile"))
errors << "Dockerfile must install git for skills:sync" unless dockerfile.include?("git")
# The Postgres backend upgraded from the `psql` subprocess to the pooled `pg` client, so the
# image no longer needs postgresql-client but MUST install node dependencies (pg) reproducibly.
errors << "Dockerfile must install node dependencies (pg) via npm ci with a lockfile" unless dockerfile.include?("npm ci") && dockerfile.include?("package-lock.json")
errors << "Dockerfile must not run bootstrap init at build time" if dockerfile.include?("RUN npm run init")

manifest["requiredMachineSpecs"].each do |spec_path|
  errors << "manifest required spec missing: #{spec_path}" unless File.exist?(File.join(ROOT, spec_path))
end

required_objects = Set.new(manifest["requiredControlObjects"])
machine_objects = Set.new(state_machines.fetch("machines").keys)
missing_machines = required_objects - machine_objects
extra_machines = machine_objects - required_objects
errors << "requiredControlObjects missing state machines: #{missing_machines.to_a.sort.join(", ")}" unless missing_machines.empty?
errors << "state machines not declared in manifest: #{extra_machines.to_a.sort.join(", ")}" unless extra_machines.empty?

role_ids = Set.new(manifest["roles"].map { |role| role.fetch("id") })
state_machines["machines"].each do |machine_name, machine|
  machine["transitions"].each do |transition|
    actor = transition.fetch("actor")
    errors << "#{machine_name} transition #{transition["from"]}->#{transition["to"]} actor not in manifest roles: #{actor}" unless role_ids.include?(actor)
    errors << "#{machine_name} transition #{transition["from"]}->#{transition["to"]} has empty requires" if transition.fetch("requires").empty?
  end
end

exact_resolvers = Hash.new { |h, key| h[key] = [] }
pattern_resolvers = []
gates["resolvers"].each do |resolver|
  if resolver.dig("evaluation", "kind").nil?
    errors << "gate resolver missing evaluation.kind: #{resolver["id"]}"
  end

  resolver.dig("match", "exactIds")&.each { |gate_id| exact_resolvers[gate_id] << resolver["id"] }
  pattern = resolver.dig("match", "pattern")
  pattern_resolvers << [resolver["id"], Regexp.new(pattern)] if pattern
rescue RegexpError => e
  errors << "gate resolver #{resolver["id"]} has invalid regex: #{e.message}"
end

required_gate_ids = state_machines["machines"].values.flat_map do |machine|
  machine["transitions"].flat_map { |transition| transition.fetch("requires") }
end.uniq

required_gate_ids.each do |gate_id|
  matches = exact_resolvers[gate_id].dup
  pattern_resolvers.each { |resolver_id, regex| matches << resolver_id if regex.match?(gate_id) }
  errors << "transition gate has no resolver: #{gate_id}" if matches.uniq.empty?
end

close_gate_enum = close_barrier.dig("$defs", "closeGate", "enum").to_a
gate_result_required = close_barrier.dig("properties", "gateResults", "required").to_a
missing_close_results = close_gate_enum - gate_result_required
extra_close_results = gate_result_required - close_gate_enum
errors << "CloseBarrier gateResults missing gates: #{missing_close_results.sort.join(", ")}" unless missing_close_results.empty?
errors << "CloseBarrier gateResults has unknown gates: #{extra_close_results.sort.join(", ")}" unless extra_close_results.empty?

contains_values = close_barrier["allOf"].flat_map do |clause|
  clause.dig("properties", "requiredGates", "allOf").to_a.map { |item| item.dig("contains", "const") }
end.compact
missing_contains = close_gate_enum - contains_values
errors << "CloseBarrier requiredGates missing contains checks: #{missing_contains.sort.join(", ")}" unless missing_contains.empty?

readiness_check_enum = completion_readiness.dig("properties", "requiredChecks", "items", "enum").to_a
readiness_result_required = completion_readiness.dig("properties", "checkResults", "required").to_a
missing_readiness_results = readiness_check_enum - readiness_result_required
extra_readiness_results = readiness_result_required - readiness_check_enum
errors << "CompletionReadiness checkResults missing checks: #{missing_readiness_results.sort.join(", ")}" unless missing_readiness_results.empty?
errors << "CompletionReadiness checkResults has unknown checks: #{extra_readiness_results.sort.join(", ")}" unless extra_readiness_results.empty?

subject_types = Set.new(control_events.dig("properties", "subject", "properties", "type", "enum").to_a)
missing_subject_types = required_objects - subject_types
errors << "ControlEvent subject.type missing control objects: #{missing_subject_types.to_a.sort.join(", ")}" unless missing_subject_types.empty?

session_placement_decision.fetch("allOf").each do |clause|
  placement_const = clause.dig("if", "properties", "placement", "const")
  required_then = clause.dig("then", "required").to_a
  if placement_const == "new_session" && required_then.include?("subagentSafetyProof")
    errors << "SessionPlacementDecision must not require subagentSafetyProof for new_session"
  end
  if placement_const == "subagent"
    errors << "SessionPlacementDecision must require subagentSafetyProof for subagent" unless required_then.include?("subagentSafetyProof")
    bounded_lease_const = clause.dig("then", "properties", "subagentSafetyProof", "properties", "boundedRepositoryLeaseOnly", "const")
    errors << "SessionPlacementDecision subagent proof must require boundedRepositoryLeaseOnly=true" unless bounded_lease_const == true
  end
end

rot_condition_statuses = repository_output_target_schema.fetch("allOf").flat_map do |clause|
  status = clause.dig("if", "properties", "status")
  Array(status && (status["enum"] || status["const"]))
end
%w[lease_bound writing committed pushed].each do |status|
  errors << "RepositoryOutputTarget schema missing state evidence condition for #{status}" unless rot_condition_statuses.include?(status)
end
errors << "RepositoryOutputTarget schema must include remote binding" unless repository_output_target_schema.dig("properties", "remote")

critical_schema_titles = Set.new(%w[
  AgentSkillSource
  AgentRoleSkill
  RoleSkillOverlay
  ModelCapabilityProfile
  ModelSelectionPolicy
  ModelSelectionDecision
  SessionPlacementPolicy
  SessionPlacementDecision
  EffectiveInstructionPacket
  RoleDriftGuard
  ExternalCapabilityBoundary
  ExecutionTopology
  DerivedTaskRequest
  ReviewPlan
  ReviewBundle
  RuleSourceResolution
  CompletionReadinessCheck
  RuntimeIssuePattern
  SystemUpgradeCandidate
  RuntimeBootstrapProfile
  Account
  AccessControlGrant
  ManagementConsoleSurface
  ProgressSnapshot
  AgentDispatch
  AgentControlCommand
  AgentExecutionEvent
  InstructionEnvelope
  SharedDefinitionContract
  RepositoryOutputTarget
  AgentTaskContract
  CloseBarrier
  LanguagePolicy
])

schema_titles = Set.new(Dir[File.join(ROOT, "spec/*.schema.json")].map { |path| JSON.parse(File.read(path)).fetch("title") })
missing_critical_schemas = critical_schema_titles - schema_titles
errors << "critical schema titles missing: #{missing_critical_schemas.to_a.sort.join(", ")}" unless missing_critical_schemas.empty?

# schema title 与状态机名的对应关系必须显式登记。原先是 `next unless machines[title]` —— 名字对不上
# 就静默跳过，于是 AgentRuntimeNode（对应机器 AgentNode）整台机器从未被核对过：spec 里建模的
# joining/read_only/quarantine/retired 与运行时实际写入的状态几乎不相交，唯一的终态没有任何生产者，
# 而这道检查一声不吭。"跳过"必须是有人写下来的决定，不能是拼写巧合的副产品。
schema_machine_aliases = {
  "AgentRuntimeNode" => "AgentNode"
}
# 这些 schema 有 status 枚举但确实没有状态机（它们的状态不构成生命周期，或生命周期在别处建模）。
# 新增一个带 status 枚举的 schema 时，要么建机器、要么登记到这里说明为什么不需要。
schemas_without_state_machine = Set.new(%w[
  AgentControlCommand AgentExecutionEvent AgentJoinToken InternalReviewRecord Organization WorkerLane
])

Dir[File.join(ROOT, "spec/*.schema.json")].sort.each do |path|
  schema = JSON.parse(File.read(path))
  title = schema["title"]
  status_enum = schema.dig("properties", "status", "enum")
  next unless title && status_enum

  machine_name = schema_machine_aliases[title] || title
  machine = state_machines["machines"][machine_name]
  unless machine
    unless schemas_without_state_machine.include?(title)
      errors << "#{title} has a status enum but no state machine and is not registered as intentionally unmodeled (register an alias or add it to schemas_without_state_machine — a silent skip means this schema's states are never cross-checked against anything)"
    end
    next
  end

  schema_statuses = Set.new(status_enum)
  machine_states = Set.new(machine["states"])
  missing_in_schema = machine_states - schema_statuses
  missing_in_machine = schema_statuses - machine_states
  unless missing_in_schema.empty? && missing_in_machine.empty?
    errors << "#{machine_name} status enum/state machine mismatch; missing in schema: #{missing_in_schema.to_a.sort.join(", ")}; missing in state machine: #{missing_in_machine.to_a.sort.join(", ")}"
  end
end

invariant_text = manifest.fetch("nonNegotiableInvariants").map { |item| item.fetch("rule") }.join("\n")
if invariant_text.match?(/[Hh][Uu][Mm][Aa][Nn]|[Mm][Aa][Nn][Uu][Aa][Ll]|[Oo][Pp][Ee][Rr][Aa][Tt][Oo][Rr]|[Pp][Rr][Oo][Jj][Ee][Cc][Tt] [Mm][Aa][Nn][Aa][Gg][Ee][Rr]/)
  errors << "nonNegotiableInvariants contain forbidden non-system actor wording"
end

unless manifest.dig("repositoryOutputPolicy", "outputPolicy") == "project_git_repository_only"
  errors << "repositoryOutputPolicy.outputPolicy must be project_git_repository_only"
end

runtime = seed_state.fetch("runtime")
%w[schemaVersion profileId status executionProfile launchModes commands services storage adminSeedPolicy healthChecks createdAt updatedAt].each do |field|
  errors << "seed runtime missing #{field}" if runtime[field].nil? || runtime[field].to_s.empty?
end
errors << "seed runtime missing mcp metadata" if runtime["mcp"].nil? || runtime["mcp"].to_s.empty?
errors << "seed runtime executionProfile must default to production" unless runtime["executionProfile"] == "production"
errors << "seed runtime uses deprecated startModes field" if runtime.key?("startModes")
errors << "seed runtime uses deprecated initializedAt field" if runtime.key?("initializedAt")
runtime.fetch("services", []).each do |service|
  %w[serviceId roleId status health].each do |field|
    errors << "seed runtime service missing #{field}: #{service.inspect}" if service[field].nil? || service[field].to_s.empty?
  end
  errors << "seed runtime service #{service["serviceId"]} uses deprecated id field" if service.key?("id")
  errors << "seed runtime service #{service["serviceId"]} must be executable, not simulated" if service["status"] == "simulated"
end

required_embedded_services = %w[
  control-plane
  room-broker
  scheduler
  agent-gateway
  identity-service
  ui-console-service
  repository-router
  instruction-optimizer
  policy-engine
  command-bus
  permission-gateway
  mcp-proxy
  model-registry
  skill-registry
  monitor
]
seed_service_ids = runtime.fetch("services", []).map { |service| service["serviceId"] }.to_set
missing_seed_services = required_embedded_services.to_set - seed_service_ids
errors << "seed runtime missing embedded services: #{missing_seed_services.to_a.sort.join(", ")}" unless missing_seed_services.empty?

provider_classes = manifest.dig("modelProviderPolicy", "providerClasses").to_set
seed_provider_classes = seed_state.fetch("modelCapabilities", []).map { |profile| profile["providerClass"] }.to_set
missing_seed_provider_classes = provider_classes - seed_provider_classes
errors << "seed modelCapabilities missing provider classes: #{missing_seed_provider_classes.to_a.sort.join(", ")}" unless missing_seed_provider_classes.empty?
seed_state.fetch("modelCapabilities", []).each do |profile|
  %w[schemaVersion providerId providerClass modelId capabilityDigest modalities strengths limits toolCapabilities qualitySignals costSignals availability observedAt].each do |field|
    errors << "seed model capability missing #{field}: #{profile.inspect}" if profile[field].nil? || profile[field].to_s.empty?
  end
end

skill_sources = seed_state.fetch("skillSources", [])
agency_source = skill_sources.find { |source| source["sourceId"] == "agency-agents-zh" }
if agency_source.nil?
  errors << "seed skillSources must include agency-agents-zh"
else
  expected_source = manifest.fetch("skillRoleSources").find { |source| source["sourceId"] == "agency-agents-zh" }
  errors << "agency-agents-zh pinnedCommit mismatch between manifest and seed" if expected_source && agency_source["pinnedCommit"] != expected_source["pinnedCommit"]
  required_skill_dirs = %w[academic design engineering finance game-development gis hr integrations legal marketing paid-media product project-management sales security spatial-computing specialized strategy supply-chain support testing writing]
  source_globs = agency_source.fetch("roleFileGlobs", [])
  missing_skill_dirs = required_skill_dirs.reject { |dir| source_globs.include?("#{dir}/**/*.md") }
  errors << "agency-agents-zh roleFileGlobs missing directories: #{missing_skill_dirs.join(", ")}" unless missing_skill_dirs.empty?
  %w[schemaVersion sourceId repositoryUrl defaultRef pinnedCommit status stateVersion catalogFiles roleFileGlobs catalogDigest roleSkillIndexRef digestIndexRef digestIndexVerified trustPolicy syncPolicy overlayPolicy].each do |field|
    errors << "agency-agents-zh skill source missing #{field}" if agency_source[field].nil? || agency_source[field].to_s.empty?
  end
end

if seed_state.fetch("roleSkills", []).empty?
  errors << "seed roleSkills must include executable default role skills"
end
if seed_state.fetch("modelSelectionPolicies", []).empty?
  errors << "seed modelSelectionPolicies must include scheduler policies"
end
management_surface_types = seed_state.fetch("managementSurfaces", []).map { |surface| surface["consoleType"] }.to_set
%w[system_management user_management].each do |console_type|
  errors << "seed managementSurfaces missing #{console_type}" unless management_surface_types.include?(console_type)
end
if seed_state.fetch("progressSnapshots", []).empty?
  errors << "seed progressSnapshots must be precomputed for UI consumption"
end
errors << "seed must include agentDispatches durable outbox collection" unless seed_state.key?("agentDispatches") && seed_state["agentDispatches"].is_a?(Array)
errors << "seed must include transitionEvidence collection for state-machine proof" unless seed_state.key?("transitionEvidence") && seed_state["transitionEvidence"].is_a?(Array)
agent_runtime_account = seed_state.fetch("accounts", []).find { |account| account["accountId"] == "acct_agent_runtime" }
if agent_runtime_account.nil?
  errors << "seed accounts must include acct_agent_runtime service account"
else
  errors << "acct_agent_runtime must be a service_account" unless agent_runtime_account["accountType"] == "service_account"
  errors << "acct_agent_runtime must use service_token auth" unless agent_runtime_account.dig("authPolicy", "method") == "service_token"
  errors << "acct_agent_runtime missing service_agent_runtime role" unless agent_runtime_account.fetch("roles", []).include?("service_agent_runtime")
  disallowed_direct = agent_runtime_account.fetch("permissions", []).grep(/\A(project|task_group):/)
  errors << "acct_agent_runtime must not use direct project/task permissions: #{disallowed_direct.sort.join(", ")}" unless disallowed_direct.empty?
end
agent_runtime_grant = seed_state.fetch("accessGrants", []).find do |grant|
  grant.dig("subjectRef", "subjectId") == "acct_agent_runtime" && grant.dig("resource", "resourceType") == "task_group"
end
if agent_runtime_grant.nil?
  errors << "seed accessGrants must include scoped task_group grant for acct_agent_runtime"
else
  %w[task_group:checkpoint_submit task_group:orchestrate].each do |permission|
    errors << "acct_agent_runtime scoped grant missing #{permission}" unless agent_runtime_grant.fetch("permissions", []).include?(permission)
  end
end

server_source = File.read(File.join(ROOT, "apps/control-plane-ui/server.mjs"))
core_source = File.read(File.join(ROOT, "apps/control-plane-ui/lib/control-plane-core.mjs"))

# schema 与代码的双向一致：上面几条只查了 schema 内部自洽（enum 与 required 互相覆盖），
# 没查 schema 里的门是否真的存在于代码。我删掉两道恒不触发的指令包门时，schema 里的残留就是
# 这样漏过去的 —— 只有在别处报错时才暴露出来。
core_gate_block = core_source[/const gateFailures = \{(.*?)\n  \};/m, 1].to_s
core_check_block = core_source[/const checkFailures = \{(.*?)\n  \};/m, 1].to_s
code_gates = core_gate_block.scan(/^\s{4}([a-z_0-9]+):/).flatten
code_checks = core_check_block.scan(/^\s{4}([a-z_0-9]+):/).flatten
stale_schema_gates = close_gate_enum - code_gates
missing_schema_gates = code_gates - close_gate_enum
errors << "CloseBarrier schema 里的门在代码中不存在（schema 残留）: #{stale_schema_gates.sort.join(", ")}" unless stale_schema_gates.empty?
errors << "代码里的关闭门没有登记进 CloseBarrier schema: #{missing_schema_gates.sort.join(", ")}" unless missing_schema_gates.empty?
stale_schema_checks = readiness_check_enum - code_checks
missing_schema_checks = code_checks - readiness_check_enum
errors << "CompletionReadiness schema 里的检查在代码中不存在（schema 残留）: #{stale_schema_checks.sort.join(", ")}" unless stale_schema_checks.empty?
errors << "代码里的就绪度检查没有登记进 CompletionReadiness schema: #{missing_schema_checks.sort.join(", ")}" unless missing_schema_checks.empty?

state_store_source = File.read(File.join(ROOT, "apps/control-plane-ui/lib/state-store.mjs"))
# The Postgres backend upgraded from per-query `psql` subprocesses to a pooled `pg` client.
# Because Node has no synchronous Postgres driver, the async pool lives in a worker thread
# (pg-pool-worker.mjs) driven synchronously from state-store via pg-sync-store.mjs (Atomics.wait
# + receiveMessageOnPort). The JSONB DDL and version-guarded CAS therefore moved into those files;
# tamper assertions read the combined source so they stay meaningful after the relocation.
pg_pool_worker_source = File.read(File.join(ROOT, "apps/control-plane-ui/lib/pg-pool-worker.mjs"))
transition_engine_source = File.read(File.join(ROOT, "apps/control-plane-ui/lib/transition-engine.mjs"))
pg_sync_store_source = File.read(File.join(ROOT, "apps/control-plane-ui/lib/pg-sync-store.mjs"))
postgres_backend_source = "#{state_store_source}\n#{pg_sync_store_source}\n#{pg_pool_worker_source}"
project_event_store_source = File.read(File.join(ROOT, "apps/control-plane-ui/lib/project-event-store.mjs"))
doctor_source = File.read(File.join(ROOT, "scripts/doctor.mjs"))
mcp_source = File.read(File.join(ROOT, "apps/mcp-server/server.mjs"))
# Gap 2A lifted the pure (state,args) governance/room/lease mutators into control-plane-core.mjs so the
# MCP surface and future HTTP/runtime/command-bus callers share one implementation. Source-presence
# assertions for those mutators therefore accept the definition in either the MCP server or shared core.
mcp_shared_governance_source = "#{mcp_source}\n#{core_source}"
mcp_doctor_source = File.read(File.join(ROOT, "scripts/doctor-mcp.mjs"))
agent_doctor_source = File.read(File.join(ROOT, "scripts/doctor-agent-remote.mjs"))
agent_runtime_source = File.read(File.join(ROOT, "apps/agent-runtime/runtime.mjs"))
agent_gateway_source = File.read(File.join(ROOT, "apps/control-plane-ui/lib/agent-gateway.mjs"))
public_app_source = File.read(File.join(ROOT, "apps/control-plane-ui/public/app.js"))
agent_installer_source = File.read(File.join(ROOT, "scripts/install-agent.sh"))
mcp_register_source = File.read(File.join(ROOT, "scripts/register-mcp-client.mjs"))
skill_sync_source = File.read(File.join(ROOT, "scripts/sync-agent-skills.mjs"))
run_with_env_source = File.read(File.join(ROOT, "scripts/run-with-env.mjs"))
contract_check_source = File.read(File.join(ROOT, "scripts/contract-check.mjs"))
# 规范校验器本体已抽到 scripts/lib/schema-validate.mjs（e2e 那一侧也要用同一份）。
# 针对校验器行为的源码断言必须跟着走 —— 否则它会去 contract-check 里找一段已经不在那儿的代码。
schema_validator_source = File.read(File.join(ROOT, "scripts/lib/schema-validate.mjs"))
docker_up_source = File.read(File.join(ROOT, "scripts/docker-up.sh"))
env_example_source = File.read(File.join(ROOT, ".env.example"))
{
  "server must isolate deterministic agent runtime worker to verification endpoint" => "/api/verification/agent-runtime/run",
  "server must scope state reads by authenticated account" => "scopedStateForAccount",
  "server must require auth for state reads" => "auth_required",
  "server must gate deterministic worker behind environment flag" => "AIMAC_ALLOW_LOCAL_DETERMINISTIC_WORKER",
  "server must require executor command for provider-backed agent runtime" => "AIMAC_AGENT_RUNTIME_EXECUTOR_COMMAND",
  "server must enforce service agent runtime principal gates" => "service_agent_runtime",
  "server login must bind local account token hashes" => "localAccountTokenHashes",
  "doctor must reject forged wrong target checkpoints" => "doctor-forged-wrong-target",
  "doctor must reject forged missing manifest checkpoints" => "doctor-forged-missing-manifest",
  "doctor must run agent runtime worker instead of hand-built checkpoint success" => "doctor-agent-runtime-worker",
  "doctor must verify duplicate orchestrator dispatch reuse" => "awaiting_existing_checkpoint",
  "doctor must verify scoped permission isolation" => "doctor-reviewer-cross-project-denied",
  "doctor must verify workspace owner direct permissions do not cross project scope" => "doctor-owner-cross-project-denied",
  "doctor must verify unauthenticated state read is blocked" => "expected unauthenticated state read 401",
  "doctor must reject checkpoint without runId" => "doctor-agent-checkpoint-missing-run",
  "doctor must verify workspace owner invite does not cross project scope" => "doctor-owner-cross-project-invite-denied",
  "doctor must verify workspace owner agent activation does not cross project scope" => "doctor-owner-cross-project-agent-denied",
  "doctor must verify invited account token login" => "doctor-invited-account-login",
  "doctor must verify project-only users do not inherit task group visibility" => "doctor-project-only-task-scope",
  "core must bind checkpoints to active agent dispatch" => "active_agent_dispatch_required",
  "core must require checkpoint runId" => "checkpoint_run_id_required",
  "core must preserve dispatch deliveryMode from work session placement" => "workSession?.placement",
  "core must reject executor undeclared changes" => "agent_runtime_executor_undeclared_changes",
  "core must bind push remote to selected repository" => "push_ref_remote_repository_mismatch",
  "core must require artifact manifest output refs" => "artifact_manifest_missing_output_refs"
}.each do |message, needle|
  source = message.start_with?("server") || message.start_with?("core") ? "#{server_source}\n#{core_source}" : doctor_source
  errors << message unless source.include?(needle)
end

expected_mcp_tools = {
  "orchestration-mcp" => %w[project_create task_group_create work_item_create work_assign orchestrator_run state_get],
  "room-mcp" => %w[room_join room_send room_wait room_ack],
  "agent-control-mcp" => %w[node_register node_probe session_start session_pause session_cancel session_recover dispatch_status],
  "scheduler-mcp" => %w[model_select session_place work_assign capacity_snapshot execution_topology_plan execution_topology_advance derived_task_classify],
  "resource-mcp" => %w[lease_claim lease_release resource_snapshot],
  "model-mcp" => %w[model_capabilities model_policy_get model_select],
  "skill-mcp" => %w[skill_source_sync role_skill_parse role_skill_overlay_validate role_skill_resolve],
  "evidence-mcp" => %w[artifact_register checkpoint_submit test_result_submit],
  "permission-mcp" => %w[permission_probe permission_request_submit permission_status permission_resolve],
  "review-mcp" => %w[review_plan_create review_bundle_register review_result_consume completion_readiness_compute],
  "governance-mcp" => %w[approval_request_create policy_decision_eval finding_submit contract_publish effective_instruction_create role_drift_guard_bind role_drift_rebound rule_source_resolve runtime_issue_pattern_submit system_upgrade_candidate_export system_upgrade_external_import close_barrier_compute],
  "identity-mcp" => %w[account_invite account_suspend grant_create grant_revoke permission_matrix_get],
  "ui-console-mcp" => %w[runtime_health_get management_surface_get project_progress_get task_group_progress_get guarded_action_dispatch],
  "definition-mcp" => %w[shared_definition_create shared_definition_publish shared_definition_consumer_bind shared_definition_conflict_report],
  "instruction-mcp" => %w[instruction_envelope_create cache_key_index stable_prefix_get delta_payload_compact],
  "repository-mcp" => %w[repository_output_target_select repository_target_lease_bind artifact_manifest_index]
}
expected_mcp_tools.each do |server_id, tool_names|
  errors << "MCP server #{server_id} missing from implementation" unless mcp_source.include?("\"#{server_id}\"")
  tool_names.each do |tool_name|
    full_name = "#{server_id}.#{tool_name}"
    errors << "MCP tool missing from implementation: #{full_name}" unless mcp_source.include?(full_name)
    errors << "MCP doctor does not exercise expected MCP protocol surface" unless mcp_doctor_source.include?("tools/list") && mcp_doctor_source.include?("tools/call")
  end
end
errors << "MCP server must implement JSON-RPC initialize" unless mcp_source.include?("initialize") && mcp_source.include?("tools/list") && mcp_source.include?("tools/call")
errors << "MCP server must enforce write idempotency" unless mcp_source.include?("idempotency_key_required")
errors << "HTTP control plane must host Streamable HTTP MCP" unless server_source.include?("handleMcp") && server_source.include?("pathname === \"/mcp\"") && mcp_source.include?("mcp/streamable-http")
errors << "MCP server must require a remote authenticated principal" unless mcp_source.include?("mcp_remote_auth_required") && server_source.include?("mcpContextFromRequest")
errors << "MCP server must make write dryRun non-mutating" unless mcp_source.include?("wouldCall") && mcp_doctor_source.include?("write MCP dryRun changed stateVersion")
errors << "MCP server must reject idempotency key reuse conflicts" unless mcp_source.include?("idempotency_key_reuse_conflict") && mcp_doctor_source.include?("MCP idempotency key reuse")
errors << "MCP doctor must exercise input validation" unless mcp_doctor_source.include?("MCP input schema did not reject unknown properties") && mcp_doctor_source.include?("MCP repository target selection accepted a non-git-trackable path")
errors << "MCP server must require principal-scoped tool grants" unless mcp_source.include?("mcp_tool_not_granted_to_principal") && mcp_source.include?("validateMcpGrant")
errors << "MCP service principals must be project-scoped for read projections" unless server_source.include?("AIMAC_MCP_SERVICE_PROJECT_IDS") && mcp_source.include?("validateRemotePrincipalScope") && mcp_source.include?("scopeStateForProjectPrincipal")
errors << "MCP tools/list must reflect active dispatch-bound grants for agent nodes" unless mcp_source.include?("createVisibleMcpToolDefinitions") && mcp_source.include?("active.has(name)")
errors << "MCP agent-node read-only tools must require a unique dispatch-bound scope" unless mcp_source.include?("mcp_grant_scope_required") && mcp_source.include?("scopeFromGrant(scopedGrants[0])") && !mcp_source.include?("grantCheck.readOnly || !grantCheck.scope")
errors << "MCP room messages must be bounded, paginated and use persistent per-room sequence" unless mcp_shared_governance_source.include?("pruneRoomMessages") && mcp_shared_governance_source.include?("AIMAC_ROOM_MESSAGES_MAX_TOTAL") && mcp_shared_governance_source.include?("Math.min(500") && mcp_shared_governance_source.include?("roomSequenceByRoom")
errors << "MCP audit must rotate with unique locked files and mark conflict writes as failed" unless mcp_source.include?("rotateMcpAuditIfNeeded") && mcp_source.include?("AIMAC_MCP_AUDIT_MAX_BYTES") && mcp_source.include?("withMcpAuditLock") && mcp_source.include?("randomBytes(4)") && mcp_source.include?("conflict: true")
errors << "production MCP must not expose server-side agent execution" if mcp_source.include?("agent-control-mcp.runtime_run") || !mcp_doctor_source.include?("remote MCP still exposes server-side Agent execution")
errors << "MCP server must reject full state scope by default" unless mcp_source.include?("full_state_scope_not_allowed") && mcp_doctor_source.include?("state_get full scope was not denied")
errors << "MCP server must enforce unique active lease and fencing token" unless mcp_shared_governance_source.include?("lease_already_active") && mcp_shared_governance_source.include?("lease_fencing_token_mismatch") && mcp_doctor_source.include?("lease_claim allowed a second active holder")
errors << "MCP grant validation must require active leases for lease-bound tools" unless mcp_source.include?("active_mcp_lease_required") && mcp_source.include?("leaseRequiredForTool")
errors << "MCP grant validation must require fencing tokens for lease-bound tools" unless mcp_source.include?("mcp_lease_fencing_token_required")
errors << "MCP server must validate tool input schemas at call time" unless mcp_source.include?("validateInputArgs") && mcp_source.include?("mcp_input_unknown_property") && mcp_source.include?("mcp_required_argument_missing")
errors << "MCP repository target selection must reject non-git-trackable paths" unless mcp_source.include?("repository_output_target_must_use_git_trackable_paths") && mcp_source.include?("pathAllowlistValid")
errors << "MCP server must mark tool results untrusted" unless mcp_source.include?("untrustedResult")
errors << "HTTP server must use shared state-store" unless server_source.include?("readStoredState") && server_source.include?("writeStoredState")
errors << "HTTP health checks must avoid full project shard hydration" unless server_source.include?("readHealthState") && server_source.include?("readStoredCentralState")
errors << "MCP server must use shared state-store" unless mcp_source.include?("readStoredState") && mcp_source.include?("writeStoredState")
errors << "state-store must support PostgreSQL JSONB authority via a pooled pg client" unless state_store_source.include?("AIMAC_STATE_STORE") && postgres_backend_source.include?("jsonb") && pg_pool_worker_source.include?("new pg.Pool") && pg_sync_store_source.include?("receiveMessageOnPort")
# The sync bridge must correlate responses (requestId) and tear the bridge down on timeout so a
# late response from a timed-out op can never be consumed by a later call (off-by-one desync).
errors << "pg sync bridge must correlate responses and reset on timeout" unless pg_sync_store_source.include?("requestId") && pg_sync_store_source.include?("resetBridge") && pg_sync_store_source.include?("next.message?.requestId === requestId") && pg_pool_worker_source.include?("response.requestId = message.requestId")
errors << "state-store must enforce versioned write conflict detection" unless state_store_source.include?("expectedStateVersion") && state_store_source.include?("AIMAC_STATE_CONFLICT")
errors << "state-store must externalize project-scoped collections into project shards" unless state_store_source.include?("projectShardCollections") && state_store_source.include?("aimac_project_state_shards") && state_store_source.include?(".state.json")
errors << "project shard writes must be protected by the central state CAS" unless state_store_source.include?("writePostgresStateWithProjectShards") && pg_pool_worker_source.include?("state->>'stateVersion'") && pg_pool_worker_source.index("upsert.rowCount === 0") && pg_pool_worker_source.index("INSERT INTO ${ident(shardTable)}") && pg_pool_worker_source.index("upsert.rowCount === 0") < pg_pool_worker_source.index("INSERT INTO ${ident(shardTable)}") && state_store_source.index("assertExpectedVersion") && state_store_source.index("writeRuntimeJsonProjectShards") && state_store_source.index("assertExpectedVersion") < state_store_source.index("writeRuntimeJsonProjectShards")
errors << "runtime_json state-store reads and writes must share a file lock and atomic central rename" unless state_store_source.include?("return withRuntimeJsonLock(options") && state_store_source.include?("writeRuntimeJsonCentralState") && state_store_source.include?("renameSync(temporary, options.statePath)")
errors << "project shard filenames must use bounded hash ids and preserve legacy reads" unless state_store_source.include?("p_${createHash") && state_store_source.include?("legacySafeProjectId") && project_event_store_source.include?("p_${createHash") && project_event_store_source.include?("legacySafeProjectId")
errors << "runtime_json shard GC must run only after central atomic rename and hydrate must follow central shard index" unless state_store_source.include?("gcRuntimeJsonProjectShards") && state_store_source.index("writeRuntimeJsonCentralState(centralState") && state_store_source.index("gcRuntimeJsonProjectShards") && state_store_source.index("writeRuntimeJsonCentralState(centralState") < state_store_source.index("gcRuntimeJsonProjectShards") && state_store_source.include?("runtimeJsonShardNamesFromCentral")
errors << "runtime_json shard writes must use central-indexed generation files for crash consistency" unless state_store_source.include?("runtimeJsonShardGeneration") && state_store_source.include?("storageGeneration") && state_store_source.include?("runtimeJsonProjectShardName") && contract_check_source.include?("generation-qualified hash shard file")
errors << "runtime_json project shards must fsync and verify payload digests" unless state_store_source.include?("writeDurableFile") && state_store_source.include?("fsyncDirectory") && state_store_source.include?("storagePayloadDigest") && contract_check_source.include?("shard digest mismatch was not rejected")
errors << "state-store must cap idempotency records" unless state_store_source.include?("pruneIdempotencyRecords") && state_store_source.include?("AIMAC_IDEMPOTENCY_MAX_RECORDS")
errors << "skills sync must use shared state-store" unless skill_sync_source.include?("readStoredState") && skill_sync_source.include?("writeStoredState")
errors << "doctor must isolate verification state from configured PostgreSQL stores" unless doctor_source.include?("AIMAC_STATE_STORE: \"runtime_json\"") && !package_json.dig("scripts", "doctor").to_s.include?("init-control-plane")
errors << "MCP register script must generate Codex config" unless mcp_register_source.include?("codex_config.toml")
errors << "MCP register script must generate Claude config" unless mcp_register_source.include?("claude_desktop_config.json")
errors << "MCP register script must generate Cursor config" unless mcp_register_source.include?("cursor_mcp.json")
errors << "MCP register script must generate remote Streamable HTTP configs" unless mcp_register_source.include?("streamable-http") && mcp_register_source.include?("--server-url=") && mcp_register_source.include?("url: mcpUrl")
errors << "MCP register script must allow env-controlled output dir" unless mcp_register_source.include?("AIMAC_MCP_CONFIG_DIR")
errors << "MCP register script must not use central service token as a client bearer default" if mcp_register_source.include?("AIMAC_MCP_SERVICE_TOKEN")
errors << "npm scripts must not expose standalone MCP client registration" if package_json.dig("scripts", "mcp:register")
errors << "MCP doctor must verify remote-only generated config" unless mcp_doctor_source.include?("mcp-server.json") && mcp_doctor_source.include?("entry.command") && mcp_doctor_source.include?("streamable-http")
errors << "local MCP stdio server must be disabled by default" unless mcp_source.include?("Local MCP stdio startup is disabled") && mcp_doctor_source.include?("Agent-local MCP stdio server was not disabled")
errors << "Agent installer must download and verify the server runtime" unless agent_installer_source.include?("agent-runtime.mjs.sha256") && agent_installer_source.include?("checksum verification failed")
errors << "Agent installer must make global client config an explicit opt-in" unless agent_installer_source.include?("--configure-global-clients") && agent_installer_source.include?("CONFIGURE_GLOBAL_CLIENTS=false")
errors << "Agent Gateway must implement one-time join, heartbeat, self-check and dispatch claim" unless %w[registerAgentNode heartbeatAgentNode selfCheckAgentNode claimNextDispatch].all? { |needle| agent_gateway_source.include?(needle) }
errors << "Agent Gateway must implement durable bidirectional control commands" unless %w[createAgentControlCommand listAgentControlCommands ackAgentControlCommand].all? { |needle| agent_gateway_source.include?(needle) } && server_source.include?("/api/agent/v1/control")
errors << "Agent Gateway must persist delivered/received control state" unless agent_gateway_source.include?("deliveredAt") && agent_gateway_source.include?("\"received\"") && agent_runtime_source.include?("\"received\"")
errors << "pause/cancel control must freeze dispatch and revoke MCP grants before agent ACK" unless agent_gateway_source.include?("applyControlCommandPreEffects") && agent_gateway_source.include?("revokeDispatchMcpGrants") && agent_gateway_source.include?("control_pause_requested")
errors << "Agent revoke must fence dispatches until runtime ACK before requeue" unless agent_gateway_source.include?("assigned_node_revocation_pending_stop") && agent_gateway_source.include?("pendingDispatchIds") && agent_gateway_source.include?("finalizeNodeRevocation") && contract_check_source.include?("did not fence its running dispatch until runtime ACK")
errors << "Agent shutdown ACK must offline nodes and requeue active dispatches" unless agent_gateway_source.include?("finalizeNodeShutdown") && agent_gateway_source.include?("node_shutdown_completed") && contract_check_source.include?("Agent shutdown ACK did not offline")
errors << "Agent revoke/shutdown failed ACK must queue a retry instead of permanently fencing dispatches" unless agent_gateway_source.include?("handleStopControlFailure") && agent_gateway_source.include?("agent_stop_control_retry_queued") && agent_gateway_source.include?("control-retry:")
errors << "resume_dispatch must have a server-side state transition" unless agent_gateway_source.include?("control_resume_requested") && agent_gateway_source.include?("resume_dispatch")
errors << "task group controls must reuse dispatch control commands" unless server_source.include?("applyTaskGroupRuntimeControl") && server_source.include?("pause_dispatch") && server_source.include?("cancel_dispatch") && server_source.include?("createAgentControlCommand")
errors << "MCP session pause/cancel must reuse dispatch control commands" unless mcp_source.include?("createAgentControlCommand") && mcp_source.include?("mcp_session_paused") && mcp_source.include?("revokeDispatchMcpGrants")
errors << "Agent Runtime must poll and ack the server-side control channel" unless agent_runtime_source.include?("startControlWatcher") && agent_runtime_source.include?("pollControlCommands") && agent_runtime_source.include?("ackControlCommand")
errors << "Agent Runtime control watcher must continue after command handling errors" unless agent_runtime_source.include?("control watcher iteration deferred")
errors << "Agent Runtime must terminate executor process groups for stop controls" unless agent_runtime_source.include?("terminateChild") && agent_runtime_source.include?("SIGKILL") && agent_runtime_source.include?("detached:")
errors << "Agent Runtime must pass selected model and reasoning to known CLIs" unless agent_runtime_source.include?("AIMAC_DISPATCH_MODEL_ID") && agent_runtime_source.include?("--model") && agent_runtime_source.include?("model_reasoning_effort") && agent_runtime_source.include?("--effort")
errors << "Agent Runtime must not pass provider auto aliases as CLI model ids" unless agent_runtime_source.include?('stripped === "auto"') && agent_runtime_source.include?("reasoningForCli") && agent_runtime_source.include?("rawReasoningLevel")
errors << "default model registry must bind concrete model ids instead of provider:auto" unless core_source.include?("providerDefaultModelIds") && seed_state.fetch("modelCapabilities", []).none? { |profile| profile["modelId"].to_s.end_with?(":auto") }
errors << "model selection must reject unavailable/quota-limited models and fail closed before dispatch" unless core_source.include?("availability_unavailable") && core_source.include?("availability_quota_limited") && core_source.include?("assertSelectedModelDecision") && contract_check_source.include?("all models were unavailable")
errors << "Agent self-check and scheduler admission must require a runnable model executor" unless agent_runtime_source.include?("\"model_executor\"") && agent_gateway_source.include?("\"model_executor\"") && agent_gateway_source.include?("if (!providers.size) return false")
errors << "Agent revoke/shutdown control must request local runtime shutdown after stopping an active executor" unless agent_runtime_source.include?("config.shutdownRequested = true") && agent_runtime_source.include?("[\"revoke\", \"shutdown\"].includes(command.commandType)")
errors << "Agent Runtime must stream execution events before final checkpoint" unless agent_runtime_source.include?("submitExecutionEvent") && agent_runtime_source.include?("executor_output") && server_source.include?("/api/agent/v1/events")
errors << "Execution events must be isolated into project-level server files" unless project_event_store_source.include?("project-db") && project_event_store_source.include?("appendProjectExecutionEvent") && server_source.include?("readProjectExecutionEvents")
errors << "Execution events must be idempotent through a persistent key index and tail-readable" unless project_event_store_source.include?("project-execution-event-key/v1") && project_event_store_source.include?("ensureProjectExecutionEventIndex") && project_event_store_source.include?("tail-window") && agent_runtime_source.include?("eventKey")
errors << "Execution events must require eventKey and rotate project JSONL segments" unless load_json("spec/agent-execution-event.schema.json").fetch("required").include?("eventKey") && server_source.include?("execution_event_key_required") && project_event_store_source.include?("execution-events.manifest.json") && project_event_store_source.include?("rotateProjectExecutionEventIfNeeded") && contract_check_source.include?("segment manifest")
errors << "Execution event-key KV files must be garbage collected under a bounded cap" unless project_event_store_source.include?("gcProjectExecutionEventKeys") && project_event_store_source.include?("AIMAC_PROJECT_EVENT_KEY_FILE_CAP") && project_event_store_source.include?("maybeGcProjectExecutionEventKeys") && contract_check_source.include?("event-key KV GC")
errors << "Orchestrator must record a machine-readable admissionDecision per scheduling verdict" unless core_source.include?("recordAdmissionDecision") && core_source.include?("admission-decision/v1") && core_source.include?("ADMISSION_OUTCOMES") && server_source.include?("cloned.admissionDecisions") && contract_check_source.include?("admission ledger")
errors << "Task group health must apply the single-cell-block guard" unless core_source.include?("singleCellEscalationGuard") && core_source.include?("overallBlockedPermitted") && contract_check_source.include?("single-cell-block guard")
errors << "room_send must dedup on (roomId, idempotencyKey)" unless core_source.include?("item.roomId === roomId && item.idempotencyKey === idempotencyKey") && contract_check_source.include?("room_send did not dedup")
# Absorbed MGP core-init scheduling/allocation adjustments (A1-A10), generalized (domain-agnostic).
errors << "Orchestrator must admit cells in explicit priority order" unless core_source.include?("ADMISSION_PRIORITY_TIERS") && core_source.include?("cellAdmissionPriority") && core_source.include?("orderedWorkItems") && contract_check_source.include?("cell admission priority ordering is wrong (A1)")
errors << "Admission decisions must classify cells and record orthogonal dimensions" unless core_source.include?("ADMISSIBLE_CELL_CLASSES") && core_source.include?("admissibleCellClass") && core_source.include?("admissionDimensions") && core_source.include?("evidenceQualificationDimension")
errors << "Each cycle must record an admission scan of the candidate set" unless core_source.include?("recordAdmissionScan") && core_source.include?("admission-scan/v1") && core_source.include?("candidateCells") && server_source.include?("cloned.admissionScans") && contract_check_source.include?("admissionScan (A8)")
errors << "Condition-window admission must gate only condition-dependent cells and defer per environment" unless core_source.include?("conditionWindowGate") && core_source.include?("windowStateByEnvironment") && core_source.include?("wakeTrigger") && contract_check_source.include?("condition-window gate")
errors << "Overall block must obey the minimal-scope blocker allow-list" unless core_source.include?("NON_ESCALATING_WAIT_CLASSES") && core_source.include?("escalatableBlocked") && contract_check_source.include?("wait-only group")
errors << "Worker carrier decision must record the 4-way carrier and justify non-selected carriers" unless core_source.include?("WORKER_CARRIER_MODES") && core_source.include?("nonSelectedCarriers") && core_source.include?("nonReuseReason") && core_source.include?("retireOrArchiveCondition") && contract_check_source.include?("nonReuseReason (A7)")
errors << "Default system rules must include the layered-admission discipline" unless core_source.include?("sys.layered-admission")
# 2026-07-27 core-init update absorption (problem-family / whole-surface / mainline-compat / global scheduling).
errors << "Default system rules must include the core-init update disciplines" unless ["sys.problem-family-bundle", "sys.function-vs-sample-coverage", "sys.mainline-compatibility", "sys.resource-admission", "sys.readiness-provisioning"].all? { |rule| core_source.include?(rule) }
# The product-intelligence-first governing doctrine (three-way impact graph + hard close gates +
# controller re-check) must be present as the umbrella system rule.
errors << "Default system rules must include the product-intelligence-first governing doctrine" unless core_source.include?("sys.product-intelligence-first") && core_source.include?("upstreamSurface") && core_source.include?("peerSurface") && core_source.include?("downstreamSurface") && core_source.include?("本总纲统领其余系统规则")
errors << "root-cause-owner must include process root-cause dispositions" unless core_source.include?("rules_not_converted_to_executable_invariant_gate") && core_source.include?("symptom_split_without_cross_cutting_invariant_owner")
errors << "layered-admission must promote a used deferred conclusion to must_reverify_now" unless core_source.include?("must_reverify_now")
# 2026-07-27 holistic system-rule audit corrections: add the side-effect authorization / fail-closed
# safety rule (O-1) and the independent-review depth rule (O-2); fix the mainline-compatibility
# single-instance overbreadth (C-1/W-1) so a legitimate single-instance owner-path run is not
# wrongly downgraded; keep the defer-escalation authoritative in evidence-qualification only (R-1 dedup).
errors << "Default system rules must include the side-effect authorization / fail-closed safety rule" unless core_source.include?("sys.side-effect-authorization") && core_source.include?("fail-closed")
errors << "Default system rules must include the independent-review depth rule" unless core_source.include?("sys.independent-review-depth")
errors << "mainline-compatibility must not forbid legitimate single-instance owner-path verification" unless core_source.include?("以单实例冒充多实例或 owner-rebalance 运行基线") && core_source.include?("单实例本身在不依赖多实例")
errors << "layered-admission must delegate the defer escalation to evidence-qualification (no duplicate)" unless core_source.include?("升格规则见 sys.evidence-qualification") && core_source.include?("任一 defer_to_e2e 一旦被用作解锁依据须升格为 must_reverify_now")
# 2026-07-27 tri-perspective rule re-audit corrections (round-2 of holistic audit):
# side-effect-authorization must not sweep read-only idempotent owner-path warmup reads (C-1 too-wide),
# must re-tie the probe carve-out to the exact-scope authorization gate (A-1 correctness) and cover the
# observation-control reversible-mutation guard check (C-2 too-narrow); the P0 stabilize sequence must be
# stated ONCE (root-cause-owner) and cross-referenced elsewhere (R-A dedup); evidence-qualification must be
# disposition-driven not a blanket reverify (A-2); independent-review-depth must bind evidence quality (C-3).
errors << "side-effect-authorization must exempt read-only owner-path warmup reads and re-tie probes to authorization" unless core_source.include?("不受本条 per-action 授权约束") && core_source.include?("未获授权时只允许在隔离/沙箱") && core_source.include?("可逆变异检验（见 sys.observation-control）")
if core_source.scan("最小留证 + 止血 + 隔离 + 升级").length != 1
  errors << "P0 stabilize sequence must be stated exactly once (root-cause-owner) and cross-referenced elsewhere"
end
errors << "evidence-qualification must be disposition-driven, not a blanket reverify" unless core_source.include?("already_service_verified 视为已服务内验证不重复复验")
errors << "independent-review-depth must bind evidence quality (owner-path/freshness/method-strength)" unless core_source.include?("方法强度是否足以承载该结论")
# A single problem cell / task group must never abort the whole cycle — remaining executable work continues.
errors << "runAutonomousCycle must isolate per-cell and per-task-group failures" unless core_source.include?("cell_processing_error") && core_source.include?("task_group_recompute_error")
# 2026-07-26 multi-dimension review fixes.
errors << "Remote git verification must validate the repository URL and restrict git transports" unless server_source.include?("prepareRemoteGitVerification") && server_source.include?("isSafeGitRemoteUrl(target.repositoryUrl)") && server_source.include?("GIT_ALLOW_PROTOCOL") && agent_gateway_source.include?("export function isSafeGitRemoteUrl")
errors << "Repository output target selection must reject an unsafe git URL at write time" unless server_source.include?("repository_output_target_unsafe_repository_url") && mcp_source.include?("repository_output_target_unsafe_repository_url")
errors << "isSafeGitRemoteUrl must reject remote-helper and ext/fd transports" unless agent_gateway_source.include?("value.startsWith(\"ext:\")") && agent_gateway_source.include?("/^[a-z0-9+.-]*::/iu")
errors << "Hosted deployments must be able to forbid local git remotes" unless server_source.include?("AIMAC_ALLOW_LOCAL_GIT_REMOTE") && server_source.include?("repository_output_target_local_git_remote_disabled")
errors << "MCP progress/capacity reads must be scoped by the principal project filter" unless mcp_source.include?("progressGet(state, args, \"project\", principalProjectFilter(context))") && mcp_source.include?("capacitySnapshot(state, principalProjectFilter(context))")
errors << "Blocked cells must not be auto-resumed with fabricated evidence" unless core_source.include?("awaiting_dependency") && core_source.include?("awaiting_decision") && core_source.include?("dependsOnWorkItemRefs || []).filter") && contract_check_source.include?("blocked_dependency hold")
errors << "Task contracts of active dispatches must not be evicted" unless core_source.include?("capTaskContracts") && contract_check_source.include?("capTaskContracts")
errors << "buildTaskContract must be idempotent against an existing active dispatch" unless core_source.include?("const existingDispatch = (state.agentDispatches || []).find(") && core_source.include?("if (existingContract) return existingContract;") && contract_check_source.include?("buildTaskContract idempotency")
errors << "close-barrier all_commands_terminal must match the exact task-group subject" unless core_source.include?("command.subject === `TaskGroup:${taskGroupId}`")
errors << "Postgres central+shards read must be transactionally consistent" unless pg_pool_worker_source.include?("readStateWithShards") && pg_pool_worker_source.include?("ISOLATION LEVEL REPEATABLE READ") && pg_sync_store_source.include?("pgReadStateWithShards") && state_store_source.include?("pgReadStateWithShards()")
app_js_source = File.read(File.join(ROOT, "apps/control-plane-ui/public/app.js"))
i18n_zh_source = File.read(File.join(ROOT, "apps/control-plane-ui/public/i18n-zh.js"))
# The zh dictionary must not contain duplicate keys — JS last-wins would silently shadow the intended
# value (a recurring defect this cycle when appending gate/objectType keys). Guard durably.
i18n_dup_keys = i18n_zh_source.scan(/^\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:/).flatten.tally.select { |_k, count| count > 1 }.keys
errors << "zh i18n dictionary has duplicate keys: #{i18n_dup_keys.join(', ')}" unless i18n_dup_keys.empty?
# 规范里建模过的每一个状态都必须有中文。t() 未命中时回退成原始英文键，并只往【浏览器控制台】
# 打一条警告 —— 而真正的用户不会去看那里。于是人批准一个授权请求之后，中文界面上的徽标写着
# "approved"（补这条检查时实测缺 32 个键，覆盖 14 台机器，其中就有 approved / wontfix 这种
# 每天都会看到的）。此前只有逐条写死的"某某必须本地化"，那种写法只能守住有人想到的那几条；
# 按 state-machines.yaml 全量核对才守得住这一类。
modeled_states = state_machines.fetch("machines", {}).values.flat_map { |m| m["states"] || [] }.uniq
missing_zh_states = modeled_states.reject { |st| i18n_zh_source.match?(/(^|[^A-Za-z0-9_])#{Regexp.escape(st)}\s*:/) }
unless missing_zh_states.empty?
  errors << "these modeled states have no Chinese label (the console will show the raw English enum): #{missing_zh_states.sort.join(', ')}"
end
# 本条自身不得空转：状态总数远少于预期就说明提取逻辑与规范结构脱节。
errors << "modeled-state i18n coverage check only found #{modeled_states.size} distinct states — extraction has drifted from the spec shape" if modeled_states.size < 150
# The blocking-detail panel renders every close-barrier gate name via t(); they must all be localized so
# the all-Chinese diagnostic panel never shows a raw English gate name.
%w[all_repository_output_targets_terminal all_leases_terminal no_active_dlq artifacts_verified all_rule_sources_resolved all_shared_definitions_active no_active_temp_grants completion_readiness_clear].each do |gate|
  errors << "close-barrier gate name #{gate} must be localized in the console" unless i18n_zh_source.include?("#{gate}:")
end
errors << "Console must surface the admission ledger and single-cell escalation guard" unless server_source.include?("\"admissionDecisions\", \"workerLanes\"") && app_js_source.include?("singleCellEscalationGuard") && app_js_source.include?("准入决策") && app_js_source.include?("workerCarrierDecision?.carrier")
# The monitor page merges the runtime view over the tasks view by hand; every runtime-only field that
# renderMonitor reads must be carried in that merge or its panel renders permanently empty (regression
# caught: admissionDecisions/workerLanes were dropped, blanking the ledger + worker-lane panels).
errors << "Monitor merge must carry the runtime-only admissionDecisions/workerLanes that renderMonitor reads" unless app_js_source.include?("admissionDecisions: runtimeState.admissionDecisions") && app_js_source.include?("workerLanes: runtimeState.workerLanes")
errors << "Console i18n must localize admission enums and blocked-reason codes" unless i18n_zh_source.include?("awaiting_analysis_output") && i18n_zh_source.include?("pending_window") && i18n_zh_source.include?("reusable_top_level_lane") && i18n_zh_source.include?("deferred:")
# 2026-07-27 full-system multi-dimension review corrections (5-lens sweep). Each guards a fixed defect:
# Core-1: a cell blocked on an inactive shared definition must `continue` the admission scan (never
# break, even in single mode) or it permanently starves every executable cell behind it.
errors << "shared_definition_not_active must not break the admission scan (global scheduling)" unless core_source[/shared_definition_not_active.*?\n(?:.*\n){0,6}?\s*continue;/m] && !core_source[/shared_definition_not_active.*?\n(?:.*\n){0,6}?\s*break;/m]
# Core-2: a failed backfill review must demote the item to needs_decision (distinct reason) so it is not
# left `verified` forever re-reviewing with no resolve_decision lever.
errors << "backfill review failure must demote to needs_decision with a distinct reason" unless core_source.include?("independent_review_backfill_failed") && i18n_zh_source.include?("independent_review_backfill_failed")
# Server-1: task-group-attributed execution events / control commands must be gated on task-group
# visibility (not node visibility) so a project viewer cannot read a hidden task group's activity.
errors << "agentExecutionEvents/agentControlCommands must gate on task-group visibility" unless server_source.include?("command.taskGroupId ? visibleTaskGroupIds.has(command.taskGroupId)") && server_source.include?("event.taskGroupId ? visibleTaskGroupIds.has(event.taskGroupId)")
# Server-2: the git remote name must reject a leading dash (option-injection parity with branch).
errors << "repository output target remote must reject a leading dash" unless server_source.include?("remote.startsWith(\"-\")")
# MCP-1: room_wait (read-only) must apply a bounded-principal room guard so a project-scoped principal
# cannot default to the control-plane management room.
errors << "room_wait must guard bounded principals against the default control-plane room" unless mcp_source.include?("boundedRoomGuard") && mcp_source.include?("boundedRoomGuard(state, args, context) || roomWait")
# MCP-2: a shutdown whose ACK never arrives must be backstopped (not only revoke); node -> offline.
errors << "shutdown ACK timeout must be backstopped like revoke" unless agent_gateway_source.include?("assigned_node_shutdown_pending_stop") && agent_gateway_source.include?("shutdown_ack_timeout_requeued") && i18n_zh_source.include?("shutdown_ack_timeout_requeued")
# State-2/4: the guarded write must be a plain UPDATE (an absent row must conflict, not silently insert),
# and ensureTables must run OUTSIDE the write transaction (a DDL race must not poison BEGIN..COMMIT).
errors << "guarded pg write must UPDATE (no insert-on-absent bypass) and ensure tables outside the txn" unless pg_pool_worker_source.include?("UPDATE ${ident(table)} SET state = $2::jsonb") && pg_pool_worker_source.include?("Ensure tables OUTSIDE the write transaction")
# State-1: the pg query timeout must be a finite positive number (NaN would deadlock Atomics.wait).
errors << "pg query timeout must be clamped to a finite positive value" unless pg_sync_store_source.include?("Number.isFinite(n) && n > 0 ? n : 60000")
# 2026-07-27 full-system review round 2. Runtime-1: prepareRepository must `git clean` after reset --hard,
# or untracked files from a failed/cancelled dispatch permanently fail ensureCleanWorktree on every future
# dispatch (persistent per-repository node wedge).
errors << "agent runtime must git clean the persistent checkout before each dispatch" unless agent_runtime_source.include?("[\"clean\", \"-ffd\"]")
# Cycle-4 resilience/runtime fixes.
# H1: git status -z rename parsing must walk records (R/C source is a separate field), not slice(3)-map,
# which corrupted the bare source path and failed every rename dispatch on the allowlist check.
errors << "agent runtime must parse git -z rename records field-by-field (no corrupt slice-map)" unless agent_runtime_source.include?("if (/[RC]/.test(entry.slice(0, 2)))") && !agent_runtime_source.include?(".map((entry) => entry.slice(3)).map((path) => path.includes(\" -> \")")
# H2: the model executor must have a wall-clock timeout (a hung executor otherwise pins the node forever).
errors << "agent runtime model executor must have a wall-clock timeout" unless agent_runtime_source.include?("AIMAC_AGENT_EXECUTION_TIMEOUT_MS") && agent_runtime_source.include?("terminateChild(child)")
# F1: the node heartbeat must NOT blanket-renew dispatch claims (only execution events renew) — else an
# orphaned running dispatch is kept alive forever and wedges its close barrier.
errors << "node heartbeat must not blanket-renew dispatch claims (orphan wedge)" unless !agent_gateway_source.include?("renewNodeDispatchClaims")
# F2: durable JSONL append must self-heal a prior torn write (leading newline) so it doesn't lose the next event.
errors << "durable event append must self-heal a torn prior write" unless project_event_store_source.include?("if (tail[0] !== 0x0a) prefix")
# F3: the state-store GC must sweep stale write temporaries so they don't accumulate on write failures.
errors << "state-store GC must sweep stale write temporaries" unless state_store_source.include?("function sweepStaleTempFiles")
# M6: a malformed existing client MCP config must not crash the agent run loop.
errors << "agent runtime must tolerate a malformed client MCP config" unless agent_runtime_source.include?("skipping remote MCP merge")
# M1: a cancel landing before the push or before checkpoint submit must not push/submit a cancelled dispatch.
errors << "cancelled dispatch must not push to remote or submit a checkpoint" unless agent_runtime_source.include?("Final cancellation check immediately before the irreversible remote side effect") && agent_runtime_source.include?("if (control.signal?.cancelled)")
# M3: checkpoint replay must bound retries (even for non-terminal errors) so a poisoned item can't wedge all claims.
errors << "checkpoint replay must bound retries to avoid wedging the node" unless agent_runtime_source.include?("AIMAC_AGENT_REPLAY_MAX_ATTEMPTS") && agent_runtime_source.include?("attempts >= attemptCap")
# M5: the runtime must reap executor child process groups on SIGINT/SIGTERM (no orphaned model CLI).
errors << "agent runtime must reap executor children on signal" unless agent_runtime_source.include?("const activeChildProcesses = new Set()") && agent_runtime_source.include?("function installChildReaper")
# perf: the per-rule content digest must be memoized (was re-hashed per dispatch over invariant rule bodies).
errors << "per-rule content digest must be memoized" unless core_source.include?("const ruleContentDigestCache = new Map()") && core_source.include?("function ruleContentDigest")
# Source hygiene: no tracked text source may embed a raw NUL byte (makes grep/git/editors treat it as
# binary). Regressed once when a memo-key separator was written as a literal U+0000 instead of "\\u0000".
nul_offenders = Dir.glob(File.join(ROOT, "**/*.{mjs,js,rb,html,css,md}")).reject { |p| p.include?("/node_modules/") }.select do |p|
  File.binread(p).include?("\x00".b)
end
errors << "tracked text source(s) contain a raw NUL byte: #{nul_offenders.map { |p| p.sub(ROOT + '/', '') }.join(', ')}" unless nul_offenders.empty?
# Cancel-resurrection guard: a node stop/revoke finalizer must NOT requeue a terminal (cancelled/failed)
# dispatch it did not itself drain, and cancel_dispatch must detach the dispatch from the node's active set.
errors << "cancel_dispatch must detach the dispatch from the node active set" unless agent_gateway_source.include?("command.commandType === \"resume_dispatch\" || command.commandType === \"cancel_dispatch\") node.activeDispatchIds")
errors << "stop finalizers must not resurrect a terminal dispatch they did not drain" unless agent_gateway_source.scan(/\[\"cancelled\", \"failed\"\]\.includes\(dispatch\.status\)\) \{ if \(!commandOwned\) continue; \}/).length >= 2 && agent_gateway_source.include?("else if ([\"cancelled\", \"failed\"].includes(dispatch.status)) { if (!trulyOwned) continue; }")
# UI: a keyword filter must surface matches past the display cap (debounced focus-preserving re-render).
errors << "filter input must trigger a focus-preserving re-render so past-cap matches surface" unless public_app_source.include?("function scheduleFilterRerender") && public_app_source.include?("scheduleFilterRerender(filter)")
# B1: updating an existing finding must scope the guard on the finding's OWN task group (confused-deputy).
errors << "finding_submit update must scope the guard on the existing finding's task group" unless server_source.include?("existingFinding?.taskGroupId || body.taskGroupId") && server_source.include?("const existingFinding = body.findingId ?")
# B2: a dispatch-scoped node control command must target a dispatch actually bound to that node.
errors << "dispatch-scoped node control must reject a dispatch not assigned to the node" unless server_source.include?("dispatch_not_assigned_to_node")
# C1: the contract-check schema validator must enforce conditional keywords (allOf/if/then/not/$ref) and
# be proven non-vacuous, else the subagent-safety and close-barrier gates validate nothing.
errors << "contract-check schema validator must support conditional keywords" unless schema_validator_source.include?("function schemaMatches") && schema_validator_source.include?("resolveInternalRef") && schema_validator_source.include?("schema.patternProperties")
errors << "contract-check must prove the schema validator rejects invalid conditional instances" unless contract_check_source.include?("VACUOUS: validator accepted a subagent placement with no subagentSafetyProof") && contract_check_source.include?("VACUOUS: validator accepted a CloseBarrier with satisfied=true")
# C2: terminateCellRuntime must have a behavioral cascade test (not just source-string presence).
errors << "terminateCellRuntime must have a behavioral cascade test" unless contract_check_source.include?("terminateCellRuntime cascade: dispatch not failed") && contract_check_source.include?("terminateCellRuntime cascade: bound repository target not superseded")
# C3: a drift gate must bind state-machine terminal states to the close-barrier terminal set.
errors << "a terminal-set drift gate must bind the state machine to the close barrier" unless contract_check_source.include?("terminal-set drift:") && contract_check_source.include?("loadStateMachines(root).machines")
# Permission-timeout deadlock: a timed-out permission request must not orphan its dispatch. The /fail(blocked)
# route marks it, and the approve/deny resolve levers must act on the marked dispatch (requeue / terminalize).
errors << "permission-poll timeout must mark the dispatch so the resolve lever can find it" unless server_source.include?("permission_request_pending") && server_source.include?("session?.status === \"permission_required\"")
errors << "permission approval must requeue a timed-out orphaned dispatch (no dead lever)" unless core_source.include?("export function requeuePermissionApprovedDispatch") && core_source.include?("export function findPermissionBlockedDispatch") && mcp_source.include?("requeuePermissionApprovedDispatch(state, request")
errors << "permission denial must terminalize a timed-out orphaned dispatch" unless mcp_source.include?("findPermissionBlockedDispatch(state, request)") && mcp_source.include?("!session || session.status !== \"permission_required\") && !timedOutDispatch")
# The completed contract-check schema validator must guard against silent-pass and $ref cycles.
errors << "schema validator must error on an unresolved local $ref and bound recursion" unless schema_validator_source.include?("unresolved local $ref") && schema_validator_source.include?("$ref recursion too deep")
# Permission-timeout requeue/terminalize must have behavioral coverage.
errors << "permission-timeout requeue/terminalize must have a behavioral test" unless contract_check_source.include?("permission-timeout approve: dispatch not requeued") && contract_check_source.include?("permission-timeout deny: dispatch not terminalized")
# permissionResolve must resolve exactly once (idempotency/terminal guard, like decideHumanConfirmation).
errors << "permissionResolve must guard against re-resolving a settled request" unless mcp_source.include?("if (request.status !== \"pending_approval\") return {permissionRequest: request, accessGrant: null, alreadyResolved: true}")
# L4: permission requests use the FSM vocab pending_approval / rejected (not pending / denied), and the
# barrier pending-set must include pending_approval so a pending permission still blocks close.
errors << "permission requests must use the FSM pending_approval / rejected vocab" unless core_source.include?("status: \"pending_approval\"") && core_source.include?("[\"approved\", \"rejected\", \"resolved\", \"revoked\", \"expired\", \"cancelled\"]") && core_source.scan(/"pending", "pending_approval"/).length >= 2
# The runtime permission poll must treat pending_approval as still-awaiting (else it resolves on the first
# poll before the operator decides and fails the dispatch).
errors << "runtime permission poll must keep waiting on pending_approval" unless agent_runtime_source.include?("![\"pending\", \"pending_approval\"].includes(status)")
# Same terminal-guard class across the sibling resolve entrypoints (a fresh idempotency-key re-call must
# not flip a settled verdict / re-dispose a terminal finding / mint a duplicate active grant).
errors << "approvalResolve must guard against re-resolving a settled approval" unless mcp_source.include?("[\"approved\", \"rejected\", \"expired\", \"cancelled\"].includes(request.status)) return {approvalRequest: request, alreadyResolved: true}")
errors << "findingResolve must guard against re-resolving a terminal finding" unless core_source.include?("if (findingTerminalStatuses.includes(finding.status)) return {finding, alreadyResolved: true}")
errors << "grantCreate must dedup an existing active grant" unless mcp_source.include?("if (existing) return {grant: existing, deduplicated: true}")
errors << "sibling resolve terminal guards need behavioral coverage" unless contract_check_source.include?("approvalResolve: a settled rejected verdict was flipped") && contract_check_source.include?("findingResolve: a terminal fixed_unverified finding was re-disposed")
# F1: a transient control-plane error on heartbeat/claim must not kill the daemon (retry classification
# covers 5xx/timeout/network AND the run loop has an outer safety-net that continues on any iteration error).
errors << "retryable classification must cover transient transport failures" unless agent_runtime_source.include?("status >= 500 && status <= 599") && agent_runtime_source.include?("ECONNREFUSED")
errors << "the run loop must survive a transient iteration error instead of exiting" unless agent_runtime_source.include?("agent runtime loop iteration error (continuing)")
# F2: a cancel landing AFTER the irreversible push must record the pushed checkpoint, not orphan it.
errors << "a cancel after push must record the pushed checkpoint, not discard it" unless agent_runtime_source.include?("recording the pushed checkpoint rather than orphaning it")
# F3: resume_dispatch may only revive a blocked dispatch (not a running one → double execution).
errors << "resume_dispatch must only revive a blocked dispatch" unless server_source.include?("dispatch_not_resumable") && agent_gateway_source.include?("command.commandType === \"resume_dispatch\" && dispatch.status !== \"blocked\"")
# M3/M4: ReviewBundle must use its MODELED terminal set (consumed/rejected, not the phantom "closed"), be
# registered in a modeled state, and be terminalizable by review_result_consume (else it wedges close).
errors << "ReviewBundle close-barrier checks must use the modeled terminal set (no phantom 'closed')" if core_source.include?("\"consumed\", \"closed\"")
errors << "reviewBundleRegister must create a modeled (submitted) bundle, not the unmodeled 'registered'" unless core_source[/function reviewBundleRegister[\s\S]{0,1200}?status: "submitted"/] && !core_source[/function reviewBundleRegister[\s\S]{0,1200}?status: "registered"/]
# 终态化评审包必须【按调用方自己的任务组】收口：原断言钉的恰好是未加作用域的那行源码，
# 于是它在钉住"要终态化"的同时，也把跨租户终态化一并钉死了。
errors << "review_result_consume must terminalize the referenced review bundle within the caller's task group" unless mcp_source.include?("item.reviewBundleId === args.reviewBundleId && item.taskGroupId === scopedTaskGroupId") && contract_check_source.include?("reviewResultConsume: submitted bundle not terminalized")
errors << "the terminal-set drift gate must also bind ReviewBundle" unless contract_check_source.include?("ReviewBundle: [\"consumed\", \"rejected\"]")
# H1: the modeled non-negotiable high_risk_no_self_approval + AI-quorum must be enforced (was a single-call
# pending->approved with no proposer check). Proposer/approver identity must come from the authenticated actor.
errors << "high_risk_no_self_approval must be enforced in approvalResolve" unless mcp_source.include?("high_risk_no_self_approval") && mcp_source.include?("resolver === request.proposedBy")
errors << "approval must require a distinct-approver quorum before terminalizing" unless mcp_source.include?("request.approvals = [...new Set([...(request.approvals || []), resolver])]") && mcp_source.include?("request.approvals.length < quorum")
errors << "approver/proposer identity must be the authenticated actor, not client input" unless server_source.include?("resolvedBy: guard.actor") && server_source.include?("proposedBy: guard.actor") && mcp_source.include?("proposedBy: context?.principal?.id")
errors << "high_risk_no_self_approval / quorum need behavioral coverage" unless contract_check_source.include?("H1: a high-risk request was self-approved") && contract_check_source.include?("H1: a quorum-2 request terminalized on the first")
# CRITICAL: quorum_collecting must be a barrier pending status (both barrier pending-sets) so a sub-quorum
# high-risk approval keeps blocking close — and a behavioral test must assert it blocks.
errors << "quorum_collecting must count as pending in both barrier pending-sets" unless core_source.scan(/"quorum_collecting", "requested"/).length >= 2
errors << "quorum_collecting-blocks-close must have behavioral coverage" unless contract_check_source.include?("H1 CRITICAL: a quorum_collecting (sub-quorum) high-risk approval did NOT block")
# H2: internal independent-review records use a dedicated schema/version, not the external review-bundle/v1.
errors << "internal review records must use their own schema version" unless core_source.include?("schemaVersion: \"internal-review-record/v1\"") && File.exist?(File.join(ROOT, "spec/internal-review-record.schema.json")) && contract_check_source.include?("internal-review-record.schema.json")
# M1: ExecutionTopology is a fully wired feature — schema-conforming producer, the MODELED terminal set
# (merged/downgraded/cancelled, not the unmodeled closed/completed/superseded), a reachable lifecycle lever
# (advanceExecutionTopology, exposed over MCP + HTTP), non-vacuous eligibility gates, and instance validation.
errors << "execution topology must use its modeled terminal set" unless core_source.include?("const TOPOLOGY_TERMINAL_STATUSES = [\"merged\", \"downgraded\", \"cancelled\"]") && !core_source.include?("[\"closed\", \"completed\", \"superseded\"]")
errors << "execution topology must have a reachable lifecycle lever" unless core_source.include?("export function advanceExecutionTopology") && mcp_source.include?("scheduler-mcp.execution_topology_advance") && server_source.include?("execution_topology_advance")
errors << "execution topology eligibility gates must be computed from the real plan" unless core_source.include?("function evaluateTopologyEligibility") && core_source.include?("owned_paths_disjoint:") && core_source.include?("resource_scopes_disjoint:")
errors << "execution topology lifecycle needs schema + behavioral coverage" unless contract_check_source.include?("ExecutionTopology(merged)") && contract_check_source.include?("M1: topology could not reach the terminal 'merged' state") && contract_check_source.include?("M1: an open (planned) execution topology did NOT block the close barrier")
# A bounded MCP principal must not drive another tenant's topology: topologyId resolves to its owning project.
errors << "topologyId must resolve to its owning project for MCP scope checks" unless mcp_source.include?("args.topologyId") && mcp_source.include?("state.executionTopologies || []).find((item) => item.topologyId === args.topologyId)")

# ---------------------------------------------------------------------------------------------------
# 人工定稿闸门：系统内不得存在任何"AI 自动确认"路径。
# ---------------------------------------------------------------------------------------------------
# 1. AI 互审绝不能直接把工作项标记为 verified —— 只能推进到 verification_ready 并挂起人工定稿单。
errors << "AI 互审不得自动验收（必须停在 verification_ready 并发起人工定稿单）" unless core_source.include?("workItem.status = \"verification_ready\"") && core_source.include?("decisionType: \"work_item_verification\"") && !core_source.include?("workItem.status = \"verified\";\n  workItem.reviewState = \"review_passed\";")
# 2. 核心决策强制阻塞：发起方(AI)传 blocking:false 不得绕开闸门。
errors << "核心决策必须强制阻塞，不受调用方 blocking 参数影响" unless core_source.include?("blocking: isMajor ? true : input.blocking !== false")
# 3. 定稿权只属于真人：机器主体一律拒绝（core + REST 权限层 + MCP 通道三处）。
errors << "核心决策定稿必须校验真人账号" unless core_source.include?("human_confirmation_requires_human_actor") && core_source.include?("const HUMAN_ACCOUNT_TYPES = [\"system_admin\", \"org_admin\", \"user_account\"]")
errors << "REST 权限层必须声明仅真人可执行的动作" unless server_source.include?("HUMAN_ONLY_ACTIONS") && server_source.include?("human_confirmation_decide")
errors << "MCP 通道必须拒绝机器主体代为定稿" unless mcp_source.include?("human_confirmation_decision_forbidden_for_machine_principal") && mcp_source.include?("context?.principal?.kind === \"system_service\"")
# 4. 多轮协商：人提方案 -> AI 再分析 -> 人决定；只有 finalize 才终结并上锁，AI 永不能终结。
errors << "人提出方案后必须转交 AI 再分析而不是直接生效" unless core_source.include?("request.awaitingAiAnalysis = true") && core_source.include?("action: \"human_revision_proposed\"")
errors << "AI 再分析通道必须存在且不能终结决策" unless core_source.include?("export function submitAiConfirmationAnalysis") && mcp_source.include?("confirmation_analyze")
# 5. 人工确认超时【绝不】等于放行。
errors << "人工确认超时不得自动放行，必须升级为人工决策" unless core_source.include?("human_confirmation_expired_needs_decision") && !core_source.include?("human_confirmation_expired_requeued")
# 6. 定稿后 AI 不得静默更改，内容分歧必须被拦下。
# 定稿后 AI 不得更改：由"定稿时存对象快照 + start/merge 前重新比对"强制。原先的 assertHumanFinalization
# 是只有测试引用的空转导出（断言还名不副实：声称查生产调用点，实际查的是别的字符串），已删除。
errors << "定稿后必须在执行前重新核对方案未被改动" unless core_source.include?("topology.humanFinalization?.subjectContentDigest") && core_source.include?("human_finalized_decision_diverged")
errors << "assertHumanFinalization 空转导出必须已移除" if core_source.include?("export function assertHumanFinalization")
# 7. 上述语义必须有行为测试覆盖（否则回归时门仍绿）。
errors << "人工定稿闸门需要行为测试覆盖" unless contract_check_source.include?("人工闸门: 机器主体（service_account）竟然可以定稿核心决策") && contract_check_source.include?("人工闸门: AI 再分析竟然终结了决策") && contract_check_source.include?("人工闸门: AI 互审仍然直接把工作项标记为 verified")
# 8. 审批终审必须有真人一票：AI 可以投互审票，但纯 AI 票凑够法定人数也不得通过。
errors << "审批终审必须有真人一票（纯 AI quorum 不得通过）" unless mcp_source.include?("const hasHumanApprover = request.approvals.some((approver) => isHumanConfirmationActor(state, approver))") && mcp_source.include?("request.approvals.length < quorum || !hasHumanApprover")
errors << "审批终审需人一票必须有行为测试覆盖" unless contract_check_source.include?("人工闸门: 纯 AI 票凑够法定人数就通过了审批")
# 9. 关闭任务组必须由真人落闸，并留下定稿记录。
errors << "关闭任务组必须由真人落闸" unless core_source.include?("task_group_close_requires_human_actor") && core_source.include?("decisionType: \"task_group_close\"") && server_source.include?("actor: guard.actor")
errors << "关闭任务组的真人校验必须有行为测试覆盖" unless contract_check_source.include?("人工闸门: 机器主体竟然可以关闭任务组")
# 10. 任务拆分与执行方案是核心方案决策：AI 只能提案，且提案期间必须拦住该工作项，人定稿后才执行。
errors << "任务拆分必须先人工定稿（AI 不得自批自拆）" unless core_source.include?("decisionType: \"task_split\"") && core_source.include?("pendingHumanSplitConfirmation") && core_source.include?("awaiting_human_split_confirmation")
errors << "拆分待定期间必须拦住工作项，不得继续派发" unless core_source.include?("if (split?.pendingHumanSplitConfirmation)") && core_source.include?("cell_held_for_human_plan_confirmation")
errors << "执行方案启动前必须人工定稿" unless core_source.include?("execution_topology_requires_human_plan_confirmation") && core_source.include?("decisionType: \"plan_topology\"")
errors << "拆分/方案闸门必须有行为测试覆盖" unless contract_check_source.include?("人工闸门: 任务拆分未经人工定稿就被执行了") && contract_check_source.include?("人工闸门: 执行方案未经人工定稿就被启动了")
# 11. 规则/配置变更影响后续所有执行，机器主体不得变更（走与人工定稿同一套 HUMAN_ONLY_ACTIONS 强制）。
errors << "规则/配置变更必须限定真人主体" unless server_source.include?("\"project_config_update\",") && server_source.include?("\"task_group_config_update\"") && server_source.include?("HUMAN_ONLY_ACTIONS.includes(action)) return HUMAN_ACCOUNT_TYPES_FOR_ACTIONS.includes(account.accountType)")
# 规则变更的"重置/语言策略"同属一类，只挡 update 会被 reset 绕过。
errors << "配置重置与语言策略变更同样必须限定真人主体" unless server_source.include?("\"task_group_config_reset\"") && server_source.include?("\"task_group_language_policy_update\"")
# 12. 方案定稿锁必须绑定到具体对象（否则 AI 另建一份就能把人的批准洗过去 —— 已复现的绕过）。
errors << "方案定稿锁必须按 subjectRef 绑定具体拓扑" unless core_source.include?("subjectRef: `ExecutionTopology:${topology.topologyId}`") && core_source.include?("item.topologyId === subjectId")
errors << "定稿锁落位绕过必须有防回归测试" unless contract_check_source.include?("人工闸门: 人对方案A的批准被洗到了 AI 另建的方案B 上")
# 13. 只有【验收】类定稿才跳过互审；否则方案定稿会让工作项永远无法验收（死锁）。
errors << "互审跳过必须同时匹配 decisionType（避免方案定稿掐死验收）" unless core_source.include?("workItem.humanFinalization?.decisionType === \"work_item_verification\"")
# 14. 防 TOCTOU：AI 修订候选必须推进轮次，人带过期轮次定稿必须被拒。
errors << "AI 修订候选必须推进协商轮次并支持轮次令牌校验" unless core_source.include?("human_confirmation_round_stale") && core_source.include?("request.round += 1")
errors << "轮次令牌必须有防回归测试" unless contract_check_source.include?("人工闸门: 人拿着过期轮次仍可定稿")
errors << "定稿分歧必须回到人工确认而不是死堵" unless core_source.include?("requestKey: `plan_topology_downgrade:${topology.topologyId}`") && core_source.include?("if (isHumanConfirmationActor(state, args.actor))")
errors << "已定稿方案的降级出路必须有行为测试覆盖" unless contract_check_source.include?("人工闸门: 真人无法降级自己定稿的方案") && contract_check_source.include?("人工闸门: AI 的降级被拦下却没有挂出人工确认单")
# 18. agent 通道只能提运行时确认，绝不能自选 decisionType/subjectRef 伪造核心决策单（洗白绕过 #2）。
errors << "agent 确认通道必须白名单且恒定为运行时类" unless server_source.include?("decisionType: \"runtime_execution\"") && mcp_source.include?("decisionType: \"runtime_execution\"") && !server_source.include?("createHumanConfirmationRequest(state, {...body")
errors << "agent 通道伪造核心决策单必须有防回归测试" unless contract_check_source.include?("人工闸门: agent 通道创建的确认单不是运行时类")
# 19. 定稿落不到对象上必须 fail-closed（否则升级路径静默丢失已批准的方案）。
errors << "定稿落空必须 fail-closed" unless core_source.include?("human_finalization_subject_missing")
# 20. agent 可读范围不得宽于其 state 视图；再分析必须确实被"踢回球"（防活锁）。
errors << "agent 可读确认单必须限于其授权任务组" unless mcp_source.include?("context.grantCheck?.grants || []).map((grant) => grant.taskGroupId)")
errors << "AI 再分析必须以 awaitingAiAnalysis 为前提（防活锁）" unless core_source.include?("human_confirmation_not_awaiting_ai_analysis") && contract_check_source.include?("人工闸门: AI 可连续刷新候选方案推进轮次")
# 21. 核心决策必须强制携带轮次令牌（可选校验等于没校验）。
errors << "核心决策定稿必须强制携带轮次令牌" unless core_source.include?("human_confirmation_expected_round_required") && mcp_source.include?("expectedRound: number")
# 22. 「同意降级」必须真的授权降级，不能是死杠杆。
errors << "同意降级必须真正生效" unless core_source.include?("selectedOptionId === \"accept_downgrade\"")
# 23. 结构性不变式：定稿那一刻被绑定对象必须仍是出卡片时的样子（"你批准的必须还是你看到的那个东西"）。
#     前两轮的绕过都属"卡片说 X、锁绑 Y"这一类，逐字段设防不够，这里在定稿时按活对象重算比对。
errors << "定稿必须重新核对被绑定对象未被掉包" unless core_source.include?("function subjectContentSnapshot") && core_source.include?("human_confirmation_subject_changed")
errors << "对象掉包必须有防回归测试" unless contract_check_source.include?("人工闸门: 方案在人点确认前被改掉，定稿却仍然生效")
# 24-27 第三轮复核修复：
#  · id 可自选且不校验唯一 => 冒名对象顶替（第三个同类绕过）
# 第四轮：同一形状（id 可自选 + 不校验唯一 + unshift）在四个承载授权的集合里都出现过，统一守卫。
errors << "承载授权的记录必须有统一的 id 唯一性守卫" unless core_source.include?("export function assertUniqueRecordId")
%w[execution_topology_id_conflict permission_request_id_conflict approval_request_id_conflict].each do |code|
  errors << "缺少 id 唯一性守卫: #{code}" unless core_source.include?(code)
end
errors << "仓库产出目标必须拒绝重复 targetId（它定义写入边界）" unless mcp_source.include?("repository_output_target_id_conflict")
errors << "id 冒名必须有防回归测试" unless contract_check_source.include?("允许重复 id（冒名记录可顶替人批准的那一份）")
# 第五轮：守卫必须落在【真正选出授权记录的那个查找条件】上，而不是某个字段。
#   · 写入边界按 (taskGroupId, workItemId, 非 superseded) 查找 —— 只守 targetId 唯一性是 fail-open。
errors << "写入边界必须按真实查找条件保证唯一" unless mcp_source.include?("if (activeExisting) return {repositoryOutputTarget: activeExisting")
# 幂等分支必须在鉴权之后：放在 beginGuardedWrite 之前等于把人批准的写入边界做成免鉴权读接口。
errors << "REST 写入边界的幂等分支必须在鉴权之后" unless server_source.index("const guard = beginGuardedWrite(req, state, \"repository_output_target_select\"") < server_source.index("const existingActiveTarget = (state.repositoryOutputs || []).find")
errors << "同类集合的插入方式必须一致（避免后插入者排在 find 最前）" if mcp_source.include?("state.repositoryOutputs.unshift")
#   · 租约 id 决定写权限归属
errors << "租约必须拒绝重复 leaseId" unless core_source.include?("lease_id_conflict")
#   · 去重键决定"核心决策卡片是否出现"，必须按类别隔离且不可由调用方指定
errors << "确认单去重键必须按决策类别隔离" unless core_source.include?("const dedupeKey = `${decisionType}:`")
errors << "agent 通道不得透传 requestKey（去重键可被抢占）" if server_source.include?("requestKey: body.requestKey") || mcp_source.include?("requestKey: args.requestKey")
errors << "第五轮三项必须有防回归测试" unless contract_check_source.include?("人工闸门: 同一工作项出现了多份生效的写入边界") && contract_check_source.include?("人工闸门: 允许重复 leaseId") && contract_check_source.include?("人工闸门: 运行时确认单顶掉了核心决策单")
# 第五轮遗留线索：证据完整性与"绑定谁"的解析必须不可顶替。
errors << "执行事件去重必须限定在本次派发内（否则可跨节点压制/读取证据）" unless agent_gateway_source.include?("item.eventKey === eventKey && item.dispatchId === dispatchId")
# （旧断言要求按 `/` 锚定 —— 那条规则本身是错的：roleSkillId 由 / 换 - 生成，按 / 锚定会让所有
# 角色静默回退到占位技能。已由下面"按 relativePath 文件名锚定 + 显式报歧义"取代。）
errors << "共享定义必须拒绝重复 contractId" unless core_source.include?("shared_definition_id_conflict")
errors << "证据/技能绑定必须有防回归测试" unless contract_check_source.include?("人工闸门: 执行事件按全局 eventKey 去重") && contract_check_source.include?("人工闸门: 技能绑定被 evil-")
# 技能绑定必须锚在 relativePath 的文件名上（roleSkillId 由 / 换 - 生成，按 / 锚定会打断全部正常绑定），
# 并且歧义要显式报错；测试必须【双向】——只断言"没选到 evil-"会放过"全部回退到占位技能"的回归。
errors << "技能绑定必须按 relativePath 文件名锚定并显式报歧义" unless core_source.include?("const skillBasename = (skill) =>") && core_source.include?("role_skill_reference_ambiguous")
errors << "技能绑定测试必须双向断言" unless contract_check_source.include?("真实同步技能没有被绑定")
# 共享定义：状态不可由调用方直接声明为生效/冲突；空 scopeRefs 不得等于全项目；publish 不得铸造未知契约。
errors << "共享定义状态必须限定在可创建枚举内" unless core_source.include?("SHARED_DEFINITION_CREATABLE_STATUSES")
errors << "空 scopeRefs 不得被当成全项目作用域" unless core_source.include?("Array.isArray(args.scopeRefs) && args.scopeRefs.length")
# 第八轮：修必须落在【类】上，不能只修被报告的那个点。
#  · 阻塞态判定必须三个调用点一致（漏一个 => 工作项照旧饿死，但关闭门不再显示原因，楔死转入隐形）
errors << "共享定义阻塞态判定必须所有调用点一致" if core_source.include?('definition.status !== "active"')
#  · 两条创建路径都必须受枚举约束
errors << "REST 创建共享定义也必须受状态枚举约束" unless server_source.include?('["draft", "owner_assigned", "proposed", "reviewing"].includes(body.status)')
#  · 必须存在【真人可达】的状态推进杠杆，否则任何阻塞态都是永久拒绝服务
errors << "共享定义必须有真人可达的状态推进杠杆" unless server_source.include?("sharedDefinitionResolveMatch") && server_source.include?("definition.status = nextStatus")
errors << "共享定义状态推进必须限定真人" unless server_source.match?(/HUMAN_ONLY_ACTIONS = \[[^\]]*shared_definition_resolve/m)

# ---------------------------------------------------------------------------------------------------
# 互审双轨（sys.review-dual-track）：既审当前方案，也跳出方案另寻更优。
# 只沿既定方案往下审，会把一个本来就错的方向越做越精细 —— 评审越勤，偏差越大。
# ---------------------------------------------------------------------------------------------------
errors << "必须存在互审双轨规则" unless core_source.include?('ruleId: "sys.review-dual-track"')
errors << "范围收敛规则必须与互审双轨对齐（约束改动范围而非分析提案范围）" unless core_source.include?("本条约束的是【改动范围】，不约束【分析与提案范围】")
errors << "互审结论必须记录考察过的替代路径" unless core_source.include?("alternativesConsidered: [{") && File.read(File.join(ROOT, "spec/internal-review-record.schema.json")).include?('"alternativesConsidered"')
errors << "替代路径必须随人工确认单呈现给人" unless core_source.include?("alternativesConsidered: input.peerReview.alternativesConsidered") && app_js_source.include?("考察过的其他方案")
# 最终方案的判准共六项（真实功能/数据正确性/已证实适用的外部使用边界/简单/高性能/稳定）。
# 只写后三项是【语义过窄】：那会允许用降低真实覆盖、频率或正确性去换"高性能"，而这恰恰是最常见的失效。
# 前三项是底线，必须写明后三项不得以牺牲它们换取，并给出冲突排序——没有排序的判准等于没有判准。
errors << "互审双轨必须写明六项判准（真实功能/数据正确性/外部使用边界/简单/高性能/稳定）" unless core_source.include?("真实功能、数据正确性、已证实适用的外部使用边界、简单、高性能、稳定")
errors << "六项判准必须写明前三项是底线、不得被后三项换取" unless core_source.include?("前三项是底线，后三项不得以牺牲前三项换取")
errors << "六项判准必须落到每条替代路径的取舍上，而不只是一句口号" unless core_source.include?("alternativesConsidered 的每一条都要写明它在这六项上相对当前方案的取舍")
errors << "六项判准必须给出冲突时的排序，否则等于没有判准" unless core_source.include?("六者冲突时的排序")
# 两轨深度必须分层：要求每一次定向 diff 复核都做开放式替代方案头脑风暴是【语义过宽】，
# 会把小复核变成无边界发散；但"缺轨"永远不合格——分层的是深度，不是有无。
errors << "两轨要求必须按评审类型分层深度（否则定向复核被迫做开放式发散）" unless core_source.include?("深度按评审类型分层") && core_source.include?("不得扩成开放式 brainstorm")
errors << "互审结论必须被定性为输入而非裁决（须逐条复核后采纳）" unless core_source.include?("互审结论是【输入】不是【裁决】")
errors << "互审必须有闭环要求（finding 落到改动或文档，驳回须有证据）" unless core_source.include?("闭环要求")
# 单一权威副本：判准细节只允许存在于 review-dual-track 一处，其余条目只作交叉引用。
# 复制出来的副本迟早与权威那份漂移，而漂移的两份都会被当成规则引用。
errors << "independent-review-depth 不得复制判准细节，只能交叉引用" unless core_source.include?("本条不复制其内容，只声明触发")
# 互审要求本身必须点名双轨：否则"双轨"只是一条孤立规则，评审者按 independent-review-depth 走完
# 也不会去做轨道二。
errors << "独立评审/互审要求必须明确要求走双轨" unless core_source.include?("必须同时走 sys.review-dual-track 的两条轨道")
errors << "互审双轨必须有行为断言" unless contract_check_source.include?("互审双轨: 互审结论没有记录考察过的替代路径")

# ---------------------------------------------------------------------------------------------------
# 2026-08-03 第五轮 MGP 吸收：六条通用执行规则。它们都不是本仓已有机制能强制的行为纪律，
# 必须作为默认系统规则随内容包下发，因此逐条钉住存在性——漏掉任一条，下发给会话的规则集就少一条。
# ---------------------------------------------------------------------------------------------------
absorbed_2026_08_03 = {
  "sys.optimal-end-state-first" => "先问它该不该存在（症状级修复的共同特征是让错误的事情做得更好）",
  "sys.falsifiable-design-gate" => "核心机制定案顺序与可证伪断言",
  "sys.prior-art-required" => "核心机制须先查证业界标准做法",
  "sys.admission-predicate-shape" => "准入判据形态：必需存在+形态正确，非集合精确相等",
  "sys.reject-disposition" => "拒绝后的归宿逐目标判定，运行状态不得决定是否处理",
  "sys.oracle-independence" => "判据独立性：不要用同一个误解验证自己"
}
missing_absorbed = absorbed_2026_08_03.reject { |rule_id, _| core_source.include?(%(ruleId: "#{rule_id}")) }
unless missing_absorbed.empty?
  errors << "these absorbed universal rules are missing from defaultSystemRules: #{missing_absorbed.map { |k, v| "#{k}(#{v})" }.join(", ")}"
end
# 最优终态优先必须先于根因定位使用：否则会先讨论"在哪一层修"，而跳过"它该不该存在"。
errors << "最优终态优先必须声明它先于 root-cause-owner 使用" unless core_source.include?("本条先于 sys.root-cause-owner 使用")
# 完成边界必须区分"已实现"与"已生效"：编译通过/注册声明了不等于运行时真的接上了。
errors << "完成边界必须区分已实现与已生效（注册声明不等于运行接线）" unless core_source.include?("不等于【运行时真的接上了】")
# 可逆变异不得用整文件还原：那会连带销毁其他会话未提交的改动（本仓实测发生过多次）。
errors << "可逆变异必须禁止共享文件整文件还原" unless core_source.include?("不在其他会话可能同时编辑的共享文件上做整文件变异或整文件还原")
# 新规则之间、以及新旧规则之间的边界必须写明，否则同一份规则集会给出互相矛盾的指令：
#   · fail-closed（拒绝不可信【动作/副作用】）vs 不停链路（【处理流】照常走）——不写边界就会互相套用；
#   · 判据放宽只适用【数据契约准入】，授权/签名/身份这类安全判据放宽即为漏洞；
#   · "它不该存在"是判断与提案，不是就地删除的授权。
errors << "拒绝归宿必须写明与 side-effect-authorization 的 fail-closed 边界" unless core_source.include?("与 sys.side-effect-authorization 的边界")
errors << "判据形态规则必须写明不适用于授权/签名类安全判据" unless core_source.include?("授权、权限范围、签名与完整性校验、幂等键、身份匹配这类安全判据不适用本条")
# 把规则用在控制面自己身上时发现的第二条边界：MCP 工具入参拒绝未知属性，照字面套用"不得整体拒绝"
# 会削弱一个真正的安全校验——拼错的参数可能正是携带作用域的那个，静默忽略会让动作在缺少作用域时执行。
errors << "判据形态规则必须写明命令/工具调用接口不适用本条" unless core_source.include?("命令/工具调用接口不适用本条") && core_source.include?("谁拥有这个字段的新增权")
# 兼容层必须写明退役条件，否则它会无界存在。分片摘要的三路接受是升级兼容，其退役条件是
# "复用判定按规范序摘要比对，旧格式必被重写"——这个条件只存在于代码推理里时，谁改了复用判定
# 都不会意识到自己把兼容路径变成了永久的。要求它写在判据旁边。
state_store_source = File.read(File.join(ROOT, "apps/control-plane-ui/lib/state-store.mjs"))
# 后台自治周期设为 0 时什么都不推进（指令停在待处理、派发不被领走、关闭门不重算），
# 而控制台上一切如常。与状态机执行模式同形：能悄悄关掉保证的开关必须如实公布。
# 由 AI 自报、且直接喂给门的字段，缺省不得等于有利结果。这一类已经在两处真实发生过：
#   · test_result_submit 的 status 缺省即 "passed"（零参数调用造出一道通过的质量门）
#   · approvalResolve 无结论即 "approved"（法定人数与禁止自批都建立在这道闸门上）
# 两处都改成"拒绝并报出可选值"。这里钉住不再复发：写路径里不允许把结论字段缺省成字面量，
# 唯一例外是受控授权分支（allowDirectActivation），它自身另有两条判别力门守着。
mcp_source_status_defaults = mcp_source.scan(/args\.(?:status|verdict|outcome|allowed)\s*\|\|\s*"[a-z_]+"/)
unless mcp_source_status_defaults.empty?
  errors << "MCP 写路径把结论字段缺省成了字面量（缺省不得等于有利结果）：#{mcp_source_status_defaults.uniq.join(', ')}"
end
core_status_defaults = core_source.scan(/args\.(?:status|verdict|outcome|allowed)\s*\|\|\s*"[a-z_]+"/)
unexpected_core_defaults = core_status_defaults.reject { |snippet| snippet.include?('"active"') } # 见上：受控授权分支
unless unexpected_core_defaults.empty?
  errors << "核心写路径把结论字段缺省成了字面量（缺省不得等于有利结果）：#{unexpected_core_defaults.uniq.join(', ')}"
end
errors << "测试结果必须显式给出状态（缺省不得当作通过）" unless mcp_source.include?("test_result_status_required")
errors << "审批必须显式给出结论（缺省不得当作批准）" unless mcp_source.include?("approval_decision_required")

errors << "后台自治的开关状态必须如实公布给人" unless server_source.include?("state.runtime.autonomousOrchestrator = runtimeOrchestratorStatus") && app_js_source.include?("指令会一直停在待处理")
errors << "分片摘要的兼容接受必须写明退役条件" unless state_store_source.include?("它有明确的退役条件，不是长期双路径") && state_store_source.include?("下一次写入必被重写为规范序")
errors << "最优终态优先必须写明它只产出判断与提案，不构成动手授权" unless core_source.include?("本条产出的是【判断与提案】，不是动手授权")

# D6：质量门是人看到"全通过"时的唯一依据，却完全由 agent 自报（提交测试结果零必填参数、命令从不执行）。
# 失败必须留痕，无新证据不得翻转，且必须存在【真人】豁免杠杆——否则判失败与清失败是同一个 AI。
errors << "失败的质量门不得被无新证据的重报翻转" unless core_source.include?("reassertedWithoutNewEvidenceCount") && core_source.include?("existing.status === \"failed\" && passed")
errors << "质量门翻转必须留痕并对人可见" unless core_source.include?("existing.previouslyFailed = true") && core_source.include?("曾判失败、后由执行方重报为通过")
errors << "质量门必须有真人豁免杠杆" unless server_source.include?("qualityGateWaiveMatch") && server_source.include?("quality_gate_waive_requires_justification")
errors << "质量门豁免必须限定真人" unless server_source.match?(/HUMAN_ONLY_ACTIONS = \[[^\]]*quality_gate_waive/m)
errors << "质量门完整性必须有行为断言" unless contract_check_source.include?("判失败与清失败是同一个 AI")
errors << "publish 不得铸造未知共享定义" unless mcp_source.include?("if (!definition) return {ok: false, error: \"shared_definition_not_found\"}")
errors << "共享定义三项必须有防回归测试" unless contract_check_source.include?("人工闸门: publish 铸造并激活了一个未知契约")
# 写入边界的第三个写入方（REST）必须同规，且越权访问必须被角色漂移门定性阻断。
errors << "REST 写入边界必须同样保证一个工作项只有一份生效目标" unless server_source.include?("const existingActiveTarget = (state.repositoryOutputs || []).find") && server_source.include?("if (existingActiveTarget) {")
errors << "越权访问必须被角色漂移门定性阻断" unless core_source.include?("const hardViolation = signals.some") && contract_check_source.include?("人工闸门: 单条越权访问未被角色漂移门拦下")
# unblock 不得用子串匹配抹掉"越界写入"证据；分支 id 在拓扑内必须唯一（否则已定稿方案卡死）。
errors << "unblock 必须按完整键精确匹配且保留越界写入证据" unless core_source.include?('blocker.startsWith("owned_paths_disjoint:") || (blocker !== targetBlocker && blocker !== ref)')
errors << "block/unblock 与越界证据必须有行为测试覆盖" unless contract_check_source.include?("人工闸门: 正常的 block -> unblock 走不通") && contract_check_source.include?("人工闸门: 越界写入证据被 unblock 抹掉了")
errors << "拓扑内分支 id 必须唯一" unless core_source.include?("execution_topology_duplicate_branch_id")
#  · 语义选项归控制面所有：AI 候选进 ai: 命名空间、不得顶掉控制面选项；是否否决只由 action 决定
errors << "AI 候选必须隔离到 ai: 命名空间且不得顶掉控制面选项" unless core_source.include?("optionId: `ai:${String(option.optionId") && core_source.include?("const controlPlaneOptions = (request.options || []).filter")
errors << "是否否决只能由人点的动作决定" unless core_source.include?("const rejected = action === \"reject\";")
#  · 快照必须覆盖真正的杀伤面（占用路径/验收条件），卡片也要让人看得见
errors << "方案快照必须覆盖占用路径与验收条件" unless core_source.include?("ownedPaths: [...(branch.ownedPaths || [])].sort()") && core_source.include?("将改动 ")
#  · 确认单去重必须限定同一任务组（键可猜 => 跨租户窃取）
errors << "确认单去重必须限定同一任务组" unless core_source.include?("item.dedupeKey === dedupeKey && item.taskGroupId === taskGroup.id")
# 16. 定稿主体必须是【生效中】的真人账号。
errors << "定稿主体必须是生效中的账号" unless core_source.include?("if (account.status !== \"active\") return false")
# 17. agent 必须能读到核心决策单才能做"再分析"，否则多轮协商无人应答（死锁）。
errors << "agent 必须能读到核心决策单以完成再分析" unless mcp_source.include?("confirmation.decisionClass === \"major\" && grantedTaskGroupIds.has(confirmation.taskGroupId)")
# M7: the repository output target denylist field must be the schema-declared pathDenylist (not the
# non-schema forbiddenPathRules), enforced end-to-end (producer + runtime consumer), and instance-validated.
errors << "repository output target must use the schema pathDenylist field" unless core_source.include?("pathDenylist: request.pathDenylist") && agent_runtime_source.include?("target.pathDenylist") && contract_check_source.include?("repository-output-target.schema.json")
# M6: role-drift signals stored on the guard must be values from the schema driftSignal enum (details kept
# separately for observability), not free-form strings.
errors << "role-drift signals must map to the schema driftSignal enum" unless core_source.include?("signalDetails.push(`scope_not_allowed:${ref}`)") && core_source.include?("signals.push(\"scope_expansion_without_decision\")")
# M5: a target superseded during rework must record its successor (state-machine successor_output_target_ref).
errors << "a superseded rework target must be back-linked to its successor" unless core_source.include?("prior.successorOutputTargetRef = target.targetId")
# M2: control events must carry payloadSchemaRef (schema allOf requires it) and every produced event must
# be instance-validated so the type/subject enums cannot drift from the emitting code.
errors << "control events must set payloadSchemaRef" unless core_source.include?("payloadSchemaRef: payload?.payloadSchemaRef")
errors << "produced control events must be instance-validated" unless contract_check_source.include?("validateSchema(ev, controlEventSchema")
# H3: the derived-task-request producer must emit the schema-required fields with a modeled status.
errors << "derived-task-request producer must conform to its schema" unless core_source.include?("schemaVersion: \"derived-task-request/v1\"") && core_source.include?("proposedInsertionMode: \"current_absorb\"") && core_source.include?("status: \"absorbed\"")
# L2/L3: artifact "registered" and RoomMessage "delivered" must be modeled state-machine states.
errors << "artifact 'registered' must be a modeled state" unless File.read(File.join(ROOT, "spec/state-machines.yaml")).include?("- \"registered\"")
errors << "room_send must use the modeled 'delivered' state, not the unmodeled 'sent'" unless core_source.include?("status: \"delivered\"") && !core_source.include?("status: \"sent\"")
# 2026-07-27 full-system review round 3. Isolation-1: MCP state_get full scope must be fail-closed —
# both scope functions run the whitelist finalizer (a deep-clone-minus-a-few leaked 20+ tenant
# collections cross-project), and the agent_node full branch must be env-gated like its siblings.
errors << "MCP scoped state must be fail-closed via finalizeScopedMcpState + allowlist" unless mcp_source.include?("function finalizeScopedMcpState") && mcp_source.include?("MCP_SCOPED_ALLOWED_TOP_KEYS.has(key)") && mcp_source.scan("return finalizeScopedMcpState(scoped,").length >= 2
# The agent principal path must also filter node/task-group-attributed events + control commands +
# empty authSessions (they are not covered by the shared finalizer, which lacks node context).
errors << "MCP agent scope must filter execution events/control commands by node/task-group visibility" unless mcp_source.include?("event.nodeId === principal.id") && mcp_source.include?("command.nodeId === principal.id")
# 2026-07-27 full-system review round 4. F1: the /fail route must guard terminal state (no corrupting a
# completed dispatch) and finishNodeDispatch must be idempotent (no double-count on retry).
errors << "dispatch /fail route must guard terminal state and finishNodeDispatch must be idempotent" unless server_source.include?("dispatch_already_completed") && agent_gateway_source.include?("if (!wasActive) return;")
# F2: heartbeat profile digest must exclude observedAt or the persist-floor throttle is defeated.
errors << "heartbeat profileDigest must exclude the per-beat observedAt timestamp" unless agent_gateway_source.include?("const {observedAt, ...stableProfile} = node.profile") && agent_gateway_source.include?("digestOf(stableProfile)")
# LOW: account email must be unique (login resolves by first email match); runtime_json CAS must fail
# closed when the central file is absent (parity with the Postgres backend).
errors << "account creation must reject a duplicate email" unless server_source.include?("account_email_already_registered")
errors << "runtime_json CAS must fail closed when the central state is absent" unless state_store_source.include?("central state absent")
# 2026-07-27 full-system review round 5. F1: previously-uncapped central-state collections must be
# bounded (unbounded growth degrades every request); agentRuntimeNodes cap must never drop a live node.
errors << "non-barrier central collections must be bounded" unless ["runtimeIssueSamples", "runtimeIssuePatterns", "roleSkillOverlays"].all? { |c| core_source.include?("state.#{c} = state.#{c}.slice(0, 2000)") }
# Round 6 correction: close/completion-barrier collections must be capped with capRetainingPredicate
# (never drop an OPEN gating item), NOT a blind slice — a blind slice can evict a still-open item and
# falsely satisfy a barrier, prematurely closing the task group.
errors << "barrier collections must cap without dropping open gating items" unless core_source.include?("function capRetainingPredicate") && ["executionTopologies", "reviewPlans", "systemUpgradeCandidates", "ruleSourceResolutions", "derivedTaskRequests"].all? { |c| core_source.include?("state.#{c} = capRetainingPredicate(state.#{c}") } && !core_source.include?("state.executionTopologies = state.executionTopologies.slice")
# reviewBundles is also a barrier collection: cap retaining non-terminal bundles (terminal = consumed/rejected
# per the ReviewBundle state machine; the phantom "closed" was corrected in M3).
errors << "reviewBundles must cap retaining open bundles (not a blind slice)" unless core_source.include?("capRetainingOpen(state.reviewBundles, [\"consumed\", \"rejected\"], 160)") && !core_source.include?("state.reviewBundles.slice(0, 160)")
# claimLease must bound state.leases like ensureLease does.
errors << "claimLease must cap lease history" unless core_source.include?("state.leases = capLeaseHistory(state.leases)")
# agentControlCommands cap must retain still-active (queued/delivered/received) commands so a later ack
# does not throw agent_control_command_not_found.
errors << "agentControlCommands cap must retain active commands" unless agent_gateway_source.include?("function capAgentControlCommands") && !agent_gateway_source.include?("state.agentControlCommands.slice(0, 2000)")
# Shutdown stop-control must carry a persistent shutdownPending marker so a retry-exhausted shutdown is
# backstopped symmetrically with revoke (revocationPending) instead of wedging.
errors << "shutdown stop-control must use a persistent shutdownPending backstop marker" unless agent_gateway_source.include?("dispatch.shutdownPending = true") && agent_gateway_source.include?("dispatch.shutdownPending || dispatch.blockedReason === \"assigned_node_shutdown_pending_stop\"")
# 2026-07-27 full-system review round 7 (exhaustive class sweep). A1: the persistence-layer shard cap
# must be barrier-safe (never evict an open/gating item) — a blind newest-by-time slice re-introduced the
# barrier-unsafe class at the storage layer, so a barrier collection's persist cap uses shardOpenPredicates.
errors << "persist-layer shard cap must retain open barrier items (shardOpenPredicates)" unless state_store_source.include?("const shardOpenPredicates") && state_store_source.include?("const open = sorted.filter((item) => isOpen(item, shard))") && ["workSessions", "humanConfirmationRequests", "humanDirectives", "repositoryOutputs", "effectiveInstructionPackets", "checkpoints", "agentDispatches", "roleDriftGuards"].all? { |c| state_store_source.include?("#{c}:") }
# A2/A3: previously-unbounded central MCP collections must be capped.
errors << "externalUpgradeImports and instructionMetrics.envelopes must be bounded" unless mcp_source.include?("state.externalUpgradeImports = state.externalUpgradeImports.slice(0, 2000)") && mcp_source.include?("state.instructionMetrics.envelopes = state.instructionMetrics.envelopes.slice(0, 2000)")
# A4: join-token cap must retain still-redeemable (issued+unexpired) tokens.
errors << "agentJoinTokens cap must retain redeemable tokens" unless agent_gateway_source.include?("function capAgentJoinTokens") && !agent_gateway_source.include?("state.agentJoinTokens.slice(0, 500)")
# B1: dead-node reconciliation must be driven by heartbeats too (not only claim polls), elapsed-time based.
errors << "heartbeat must drive dead-node reconciliation (recycleExpiredClaims)" unless agent_gateway_source.include?("const reconciled = recycleExpiredClaims(state)") && agent_gateway_source.include?("const persistRequired = reconciled ||")
# B2: a paused dispatch on a dead node must be backstopped (else resume/cancel wedge on the dead node).
errors << "paused dispatch on a dead node must be backstopped" unless agent_gateway_source.include?("const pausePending = dispatch.blockedReason === \"control_pause_requested\"") && i18n_zh_source.include?("paused_node_dead_requeued")
# 2026-07-27 cycle-2: the evidence -> quality-gate -> close-barrier pipeline must be wired. test_result_submit
# was filling a collection nothing read, and the all_quality_gates_passed gate had no writer (always-pass
# no-op). testResultSubmit now derives a QualityGate so failing test evidence actually blocks close.
errors << "test evidence must derive a quality gate that gates close" unless core_source.include?("export function recordQualityGateFromTest") && mcp_source.include?("recordQualityGateFromTest(state, testResult)") && core_source.include?("all_quality_gates_passed")
# Cycle-2 operator surfaces: pending permission/approval/finding requests (which block the close barrier)
# must be visible + resolvable in the console, the close-barrier panel must offer a close action, and the
# graceful shutdown command must be reachable. All wire to endpoints that already existed.
# 真人专属杠杆若在控制台里没有入口，等于这个杠杆不存在 —— 人只会看到一个红色阻塞 chip，
# 然后无从下手。本轮一次性发现三个这样的杠杆（质量门豁免/评审计划收尾/共享定义处置），
# 全都只有裸 REST。故把"有杠杆必有入口"钉成结构约束。
# 会话令牌不得出现在 WebSocket 的 URL 里：查询串会被反向代理访问日志、浏览器历史等原样记下来。
# 浏览器的 WebSocket 不允许设置 Authorization 头，标准替代位置是子协议头（它是请求头，不进 URL）。
errors << %(控制台不得把会话令牌放进 WebSocket 查询串（会被访问日志与浏览器历史记录下来）) if app_js_source.match?(/new WebSocket\([^)]*realtime\?token=/m)
errors << %(控制台必须用子协议头携带实时通道令牌) unless app_js_source.include?(%q{["aimac.bearer", authToken]})
# 握手必须回显一个客户端提供过的子协议，否则浏览器立刻断开；且绝不能回显令牌本身（那等于换个地方泄露）。
errors << %(实时通道握手必须回显 aimac.bearer 子协议，且不得回显令牌本身) unless server_source.include?("handleProtocols") && server_source.include?(%q{? "aimac.bearer" : false})

# 人打开控制台看不出"现在轮到我做什么"：菜单写死无计数，唯一的待办数字不可点击且只算当前项目，
# 而等人拍板的东西被拆在两个页面上，其中一个还叫"执行监控" —— 名字完全不暗示这里有等你签字的东西。
errors << %(控制台必须有跨项目的"待你处理"汇总，否则人工闸门存在但不可操作) unless app_js_source.include?("function pendingForMe()") && app_js_source.include?(%q{panel("待你处理"})
errors << %(菜单必须带待办计数，否则等人签字的东西藏在别的页面里没人会去点) unless app_js_source.include?(%q{class="nav-badge">}) && app_js_source.include?("menuTodoCounts[item.id]")
# 计数只能统计"这个人有权处置"的项：把别人负责的也算进来，红点就成了一个永远清不掉的东西。
# 只查"有没有 allowed 这个入参"，不锁死整个签名：签名多一个参数就假红，而真正的过滤逻辑坏掉时
# 它照样绿（字符串还在）。真正的不变式"无权的类别不进统计"由控制台行为门断言。
errors << %(待办统计必须按处置权限过滤（否则出现永远清不掉的红点）) unless app_js_source.match?(/const add = \(id, label, page, items, allowed[,)]/)

# 豁免表单上明写"理由会随门一起留档并显示在验收卡片上"。而卡片正文是【创建那一刻】的快照，
# 卡片挂起之后才做的豁免不会出现在里面 —— 界面许下的承诺必须在代码里兑现，否则人以为自己
# 看到的是完整信息。同理：证据引用落在 question.evidenceRefs 里却从不渲染，人无法从卡片
# 跳到检查点/提交记录去核对。两者都必须在【渲染时】从当前状态取。
errors << %(验收卡片必须实时呈现质量门豁免理由（豁免表单已向人承诺过这件事）) unless app_js_source.include?(%q{gate.waiveJustification ? }) && app_js_source.include?(%q{gate.waivedBy || "?"})
errors << %(验收卡片必须呈现证据引用，否则人无法核对它据以判断的东西) unless app_js_source.include?(%q{const evidence = request.question?.evidenceRefs || [];}) && app_js_source.include?(%q{证据引用：})
# 任务组页原先只看提示型 blockers，与"能不能关闭"无关，于是显示"无阻塞"却关不掉 —— 与事实相反。
errors << %(任务组页必须呈现关闭门禁的实际判定，而不是只看提示型阻塞) unless app_js_source.include?("关闭门禁：") && app_js_source.match?(/const groupBarrier = \(state\.closeBarriers/)

# 轨道二（跳出方案另寻更优）与"互审的考察边界声明"必须在卡片上分开呈现。控制面的独立互审
# 结构上只能核验证据层，它写进 alternativesConsidered 的是一句免责声明；不加区分地展示为
# "考察过的其他方案"，人会读成"AI 已经比较过别的路了"，而实际上没有任何一方做过轨道二。
errors << "互审边界声明必须与真正的替代方案考察区分（否则免责声明会被读成考察结论）" unless core_source.include?('scope: "control_plane_evidence_only"')
errors << "没有任何方案级考察时，验收卡片必须明确提示人自行判断方向" unless app_js_source.include?("没有任何一方跳出当前方案考察过替代路径")

# 代理端的本地关键文件（agent-config.json 里的 nodeToken、outbox 里已 push 成功的检查点）
# 必须原子落盘。join token 是一次性的，配置一旦被截断，节点既加载不了凭据也无法重新注册 ——
# 永久变砖。而它在执行期间每条执行事件之前都会被重写一次（约每 1.5 秒），裸 writeFileSync
# 是截断覆盖，崩在写窗口里就正好毁掉它（实测：同一时刻被 SIGKILL，旧写法留下 0 字节文件）。
runtime_source = File.read(File.join(ROOT, "apps/agent-runtime/runtime.mjs"))
errors << "代理本地写必须走 tmp+fsync+rename（裸 writeFileSync 崩在写窗口里会把节点写成永久变砖）" unless runtime_source.include?("function writeDurableJson") && runtime_source.match?(/function writeSecretJson\(path, value\) \{\s*\n\s*writeDurableJson\(path, value\);/m)
errors << "checkpoint outbox 必须与配置走同一条持久写路径" unless runtime_source.match?(/persistCheckpointOutbox[\s\S]{0,600}?writeDurableJson\(target,/m)
# 控制面把 shutdown 当作可恢复的排空（finalizeNodeShutdown 只置 offline，心跳允许 offline->online），
# 代理端若把 shutdownRequested 写死而不清除，两侧对同一件事的理解就不一致：节点再也回不来。
errors << "代理重启后必须清除 shutdownRequested（否则控制面认为可恢复、代理端却不可逆）" unless runtime_source.include?("delete config.shutdownRequested")

# 角色规则（"你是谁、职责边界、禁区"）是三类规则之一。改角色技能 overlay 或整体替换技能源，
# 就是改规则层 —— 而这两条原先都对 MCP 服务令牌开放、且都不是真人专属。
# runtimeMutationPolicy 里那条 auto_publish_role_skill_overlay 是声明了却从没有人执行的禁令。
["skill-mcp.skill_source_sync", "skill-mcp.role_skill_overlay_validate"].each do |tool|
  errors << %(#{tool} 必须对 MCP 服务令牌禁用（它改的是角色规则层，不能绕过人工闸门）) unless server_source.include?(%(tool === "#{tool}"))
end
["role_skill_overlay_create", "skill_source_sync"].each do |action|
  errors << %(#{action} 必须是真人专属动作（改角色规则/技能源＝改规则层）) unless server_source.match?(/HUMAN_ONLY_ACTIONS\s*=\s*\[[^\]]*"#{action}"/m)
end

# 22 个已登记角色里只有 11 个有技能文件，其余回退到通用技能。回退是必要的（拒绝会让这些角色
# 的工作项一个都派发不了），但验收的人必须知道"执行方依据的角色规则并不是这个角色的"。
errors << %(验收卡片必须说明角色技能回退（否则人以为它按自己角色的规则做事）) unless core_source.include?("没有属于自己的技能文件，本次实际绑定的是")
# 过期会话原先只在有人登录时被顺带清理，无人登录期间长期滞留。
errors << %(必须有独立的过期会话清扫（不能只依赖"下一次有人登录"）) unless server_source.include?("for (const session of revalidationState.authSessions || [])") && server_source.include?("session.status = \"expired\"")

# 控制台里唯一能一次性摧毁全部租户的按钮，原先与"刷新页面"是同一种交互成本：两次单击，
# 文案只说"重置为种子数据"。有真实租户数据时必须显式带上要摧毁的规模。
errors << %(重新初始化运行态在已有真实数据时必须要求显式确认规模) unless server_source.include?("bootstrap_init_requires_explicit_confirmation")
errors << %(摧毁全部数据必须打字确认（单击式确认无法让人读到规模）) unless app_js_source.include?("function promptDialog(options =") && app_js_source.include?("确认抹掉全部数据")
# confirmDialog 的安全语义（回车不触发、焦点落在"取消"）只对 danger:true 生效。
# 关闭任务组是终态且无任何回退路径，必须标 danger，且必须指名关的是哪一个（按钮逐行渲染）。
errors << %(关闭任务组的确认必须标 danger 且指名任务组) unless app_js_source.include?('message: `确认关闭任务组「${taskGroupNameOf(target.dataset.task)}」？`')
# 定稿/打回都是一次性的，且与"提交修改意见"并排 —— 这是整套人工闸门的核心动作，不能零确认。
errors << %(定稿与打回必须二次确认（一次性且不可修改）) unless app_js_source.include?('title: finalizing ? "确认定稿" : "确认打回返工"')

# 模型是执行体的一部分：换了模型，这份成果就是另一个东西做出来的。而 buildTaskContract 每次派发
# 都重新 selectModel，定稿锁的内容摘要原先不含 modelId —— 改一次能力表，后续派发静默换执行体。
errors << %(验收快照必须包含实际执行模型（否则已定稿方案可被静默换执行体）) unless core_source.include?("executedModels:")
# 角色是"谁来做"，不是"这件事是什么"：ownerRole 参与任务性质判定会让角色名本身命中判据。
# 注意只看 classifyTaskExecution 这一个函数：inferWorkSignals 里有一个同名变量也拼了 ownerRole，
# 但它判的是"载体放置"而不是"这件事算不算重大决策"，不在本条约束范围内。
# 用逐行提取而不是 [\s\S]{0,N}?：函数体超过那个上限时匹配为空，断言就恒不触发（实测过）。
classify_body = core_source[/function classifyTaskExecution\((?:[^\n]*\n){0,60}?\}\n/].to_s
errors << %(classifyTaskExecution 函数体提取不到（本断言已与代码脱节，不能据此下结论）) if classify_body.empty?
errors << %(任务性质判定不得把 ownerRole 拼进匹配文本（角色是"谁来做"，不是"这件事是什么"）) if classify_body.include?("workItem.ownerRole")
# 人在拓扑卡上批准的执行方案必须真的管住派发，否则"批准了按这个方案跑"与"实际怎么跑"互不相干。
errors << %(人已定稿的执行拓扑必须约束派发通道) unless core_source.include?("governed_by_finalized_topology")

# 分类器判不出架构与选型这类决策，而让它 fail-safe（判不准一律要人确认）会把确认流量堆到
# 没人看的程度 —— 总在响的门等于没有门。机器判不了的事，判断权必须明确地交给人。
errors << %(必须给人一条直接指定"这个工作项要不要先定稿方案"的杠杆（分类器判不了架构决策）) unless server_source.include?("work_item_plan_finalization_set")
errors << %(派发必须尊重人的指定（标记了却没定稿方案时不得开跑）) unless core_source.include?("awaiting_plan_finalization")

# 互审此前是空转的：它能产出的每一条判据都是 acceptAgentCheckpoint 已经强制过的结构性事实，
# 所以对任何被接受的检查点结论恒为 passed。控制面判断不了代码对不对，但质量门是否真的过了、
# 声明的需求有没有对应证据、以及这次交付有多大，是它能独立查而接受时不查的。
errors << %(互审必须至少检查质量门（否则它只是复述接受检查点时已强制过的事实）) unless core_source.include?("quality_gates_not_passed:")
errors << %(验收卡片必须呈现本次交付的改动规模（"证据已就绪"不能掩盖只动了一个文件）) unless core_source.include?("本次交付改动了")

# 证据不该由被证明的一方提供。检查点里若干字段原样落库并随检查点展示，看起来像完整性证据，
# 实际是执行方自己填的：treeDigest 从不与 <commit>^{tree} 比对；changedPathEvidenceRefs 与真实
# 改动毫无关系；createdAt 由调用方给，而验收卡片按它倒序挑"那一份检查点"——执行方因此能决定人看哪份。
errors << %(treeDigest 必须与提交的实际 tree 比对（否则它是执行方自填的一串字符）) unless core_source.include?("commit_ref_tree_digest_mismatch")
errors << %(改动路径证据必须由控制面从真实 diff 派生，不能原样收执行方自报的) unless core_source.include?("selfReportedChangedPathEvidenceRefs") && core_source.include?("...(evidence.changedPaths || []).slice(0, 200).map((path) => `git-path:${path}`)")
errors << %(检查点落库时间必须由服务端定（验收卡片按它挑那一份检查点）) unless core_source.include?("reportedCreatedAt")
# 组织通讯录：授权只比对"你属不属于这个组织"，任何普通成员都能拿到全组织的 email/roles/permissions。
errors << %(组织成员清单必须按成员管理权限收窄（否则是一份现成的权限侦察清单）) unless server_source.include?("const canAdminMembers = isSystemAccount(reader.account)")

# 检查点是"这份工作到底有没有真的做出来"的最终判据，三条实质校验此前只在【被约束方自己】那里：
#  ① "产出必须在清单之外" —— 只有 runtime.mjs 在查，服务端没有等价物，于是一份把自己列为自己产出的
#     清单就能满足全部校验，零产出的提交被判为证据齐备；
#  ② pathDenylist（.env/.git/**/node_modules/**）唯一的执行点也在执行方，而 allowlist 接受 "**"；
#  ③ 网关路由按 dispatchId 认证到派发 A，却把整个 body 交给 core，后者按 body 另找派发 B —— 
#     认证的和被操作的不是同一个对象。
errors << %(服务端必须要求"清单之外还有真实产出"（被约束方自查等于没查）) unless core_source.include?("artifact_manifest_has_no_output_beyond_itself")
errors << %(服务端必须执行 pathDenylist，不能只靠执行方自查) unless core_source.include?("changed_paths_inside_repository_target_denylist")
errors << %(检查点路由必须用【认证到的那个派发】的身份，不接受 body 自报) unless server_source.include?("const boundBody = {...body,") && server_source.include?("repositoryOutputTargetRefs: [target.targetId]")

# 证据摘要是执行方自证的（内容不上传控制面，控制面无法核验摘要与内容是否相符）。
# 字段名与卡片文案都必须说出这一点 —— 叫 contentVerifiable 会被读成"已核验"，
# 而"证据已就绪"若不加说明，人会以为控制面替他检查过了。
errors << "证据摘要字段不得暗示控制面已核验（应为自证语义）" if core_source.include?("contentVerifiable:")
errors << "验收卡片必须说明证据摘要为执行方自证、控制面未独立核验" unless core_source.include?("未能独立核验") && core_source.include?("contentDigestAttested")

["account_invite", "system_account_invite", "permission_resolve", "contract_publish"].each do |action|
  errors << "#{action} 必须是真人专属动作（铸造人类账号 / 授予被挡住的能力，机器主体自行完成即绕过人工闸门）" unless server_source.match?(/HUMAN_ONLY_ACTIONS\s*=\s*\[[^\]]*"#{action}"/m)
end

human_lever_forms = {
  "quality_gate_waive" => "quality-gate-waive",
  "review_plan_resolve" => "review-plan-resolve",
  "shared_definition_resolve" => "shared-definition-resolve",
  "rule_source_settle" => "rule-source-settle",
  "work_item_plan_finalization_set" => "plan-finalization",
  "review_bundle_resolve" => "review-bundle-resolve",
  "system_upgrade_candidate_resolve" => "upgrade-candidate-resolve",
  "human_confirmation_decide" => "hcr-decide",
  "human_directive_create" => "directive-create"
}
# 处置理由只存在于记录上的那一个字段（审计条目只记 actor/action/subject/result，不含理由）。
# 没有终态一次性守卫的话，后一位真人会无条件覆盖前一位的理由，且不可恢复。
{
  "quality_gate_already_settled" => "质量门豁免",
  "review_bundle_already_resolved" => "评审包收尾",
  "system_upgrade_candidate_already_resolved" => "系统升级候选项处置",
  "review_plan_already_resolved" => "评审计划收尾",
  "shared_definition_already_resolved" => "共享定义处置"
}.each do |code, label|
  errors << "#{label} 缺少终态一次性守卫（后一位真人会覆盖掉前一位的处置理由，且理由不可恢复）" unless server_source.include?(code)
end
# 每条人工处置都必须留下依据
["quality_gate_waive_requires_justification", "review_plan_resolution_justification_required",
 "review_bundle_resolution_justification_required", "system_upgrade_candidate_justification_required",
 "shared_definition_resolution_justification_required"].each do |code|
  errors << "人工处置杠杆缺少必填理由：#{code}" unless server_source.include?(code)
end

# 控制台的处置表单依赖对应集合被下发到前端。集合不在 view 白名单里（或被整体清空），
# 表单就是永远渲染不出来的死代码 —— 后端有杠杆、前端有代码，中间断在数据下发上。
["reviewBundles", "ruleSourceResolutions", "systemUpgradeCandidates", "reviewPlans", "sharedDefinitions"].each do |collection|
  errors << "阻塞项处置依赖的 #{collection} 没有下发到 tasks 视图（表单永远渲染不出来）" unless server_source.match?(/tasks: \[[^\]]*"#{collection}"/m)
end
# 每一条人工处置都必须刷新关闭门快照：控制台的"关闭任务组"按钮只在 barrier.satisfied 时出现，
# 而刷新快照的唯一入口原先就是那个按钮自己，人处置掉最后一个阻塞项后永远等不到它。
["quality_gate_waive", "review_bundle_resolve", "system_upgrade_candidate_resolve",
 "rule_source_settle", "review_plan_resolve", "shared_definition_resolve"].each do |action|
  # 必须从【路由体】起算：直接找 "#{action}" 的第一次出现会命中 HUMAN_ONLY_ACTIONS 里的那个字符串，
  # 提取到的块与路由无关，断言就成了空转（实测过：撤掉 recompute 也不报错）。
  # 块终点用 finishGuardedWrite 而不是 json(res, 200)：后者在有些路由里落在窗口之外，
  # 提取到空块 -> include? 恒为假 -> 断言反而变成"永远报错"或"永远不报错"，两种都不可信。
  # 不能用 /m + (?:.*\n)：Ruby 的 /m 让 . 也匹配换行，一个 .* 就吃掉整个文件，
  # 提取出来的"块"长达数万字符，于是断言对任何路由都恒真（实测：撤掉 recompute 也不报错）。
  # 用 [^\n]* 显式逐行，并且不加 /m。
  block = server_source[/beginGuardedWrite\(req, state, "#{action}"(?:[^\n]*\n){0,60}?[^\n]*finishGuardedWrite/].to_s
  errors << %(真人杠杆 #{action} 的路由块提取不到（本断言已与代码脱节，不能据此下结论）) if block.empty?
  errors << %(#{action} 处置后没有刷新关闭门快照（人处置完最后一个阻塞项也等不到「关闭任务组」按钮）) unless block.include?("recomputeBarrierAfterResolve")
end
# 任务组级权限只认按资源落位的 grant；把它们摆在"直接权限"勾选框里，人会勾上、看到按钮、点下去必 403。
# 注意：不能用 [^\]]* 去跨过数组内容 —— 它在第一个内层数组的 ] 处就停了，根本到不了 task_group 条目。
member_permission_block = app_js_source[/const MEMBER_PERMISSION_OPTIONS = \[(.*?)^\];/m, 1].to_s
errors << %(成员权限勾选框不得提供 task_group:* 直接权限（服务端一律不认，界面在说谎）) if member_permission_block.include?('"task_group:')
# 钉的是「授权表单的角色候选里有 reviewer」这个属性，不是它当年那一段标记。原先钉 `<option value="reviewer">`
# 整串，把角色下拉改成经 decisionSelect 渲染就会假红 —— 而"能不能把人工审核权交出去"一点没变。
errors << %(项目成员授权必须能授予「评审人」角色，否则没有任何界面能把人工审核权交出去) unless app_js_source.match?(/\["reviewer",\s*"评审人/)

human_lever_forms.each do |action, form_kind|
  next unless server_source.include?("\"#{action}\"")
  errors << "真人杠杆 #{action} 在控制台没有操作入口（data-form=\"#{form_kind}\"）——后端有杠杆而界面上按不到，等于没有" unless app_js_source.include?("data-form=\"#{form_kind}\"") && app_js_source.include?("kind === \"#{form_kind}\"")
  # 光有入口不够：这些杠杆之所以是"真人杠杆"，靠的就是 HUMAN_ONLY_ACTIONS 这一条。
  # 漏登记的话它会静默退化成"任何拿到对应权限的机器主体都能按"，而界面上看不出任何区别。
  errors << "真人杠杆 #{action} 没有登记进 HUMAN_ONLY_ACTIONS（机器主体同样能调用，它就不再是真人专属）" unless server_source.match?(/HUMAN_ONLY_ACTIONS\s*=\s*\[[^\]]*"#{action}"/m)
end

errors << "review console must surface + resolve permission/approval/finding requests" unless server_source.include?("\"permissionRequests\", \"approvalRequests\", \"findings\", \"qualityGates\"") && app_js_source.include?("data-form=\"perm-resolve\"") && app_js_source.include?("data-form=\"approval-resolve\"") && app_js_source.include?("data-form=\"finding-resolve\"")
errors << "close-barrier panel must offer a close-task-group action" unless app_js_source.include?("data-action=\"close-task-group\"") && app_js_source.include?("close-barrier/compute") && app_js_source.include?("mutate: true")
errors << "runtime nodes must offer the graceful shutdown command" unless app_js_source.include?("data-command=\"shutdown\"")
# The permission-request resolve UI must gate on project:grant (the endpoint's permission), not review.
errors << "permission-request resolve must gate on project:grant" unless app_js_source.include?("const canGrant = hasPerm(\"project:grant\")")
# C: the close-barrier panel must surface WHICH gates block (not just a count); E: checkpoint Git evidence
# (commit/push refs) must be shown; U4: keyword filters must search the source before the display cap;
# packet: the effective-instruction packet must carry the resolved effective-rules digest.
errors << "close-barrier panel must show the blocking-object breakdown" unless app_js_source.include?("阻塞明细")
errors << "monitor must surface checkpoint Git evidence (commit/push refs)" unless app_js_source.include?("检查点（Git 证据）")
errors << "keyword filters must filter the source before the display cap" unless app_js_source.include?("function filterSource") && app_js_source.include?("filterSource((state.workSessions")
# 原先钉的是"这一行源码长什么样"（const effectiveRulesDigest = digestOf），把它抽成共享函数就误报。
# 断言应当钉【性质】：摘要由已解析的有效规则算出、并被带进指令包；而且这个计算必须只有一处 ——
# 契约侧与内容包侧各写一遍同样的算法，迟早漂移，那正是"规则换了而摘要没换"的成因。
errors << "effective-instruction packet must carry the resolved effective-rules digest" unless core_source.include?("export function computeEffectiveRulesDigest") && core_source.include?("const effectiveRulesDigest = computeEffectiveRulesDigest(effectiveRuleConfig)") && core_source.include?("effectiveRulesDigest: contract.effectiveRulesDigest")
errors << "有效规则摘要的计算必须只有一处实现（两侧各写一遍必然漂移）" if core_source.scan(/activeSystemRules \|\| \[\]\)\.map\(\(rule\) => \[rule\.ruleId/).length > 1
# Cycle-2 round-2 delta fixes:
# F1 (shipping-blocker): a multi-submit-button form must capture the submitter, else approve silently denies.
errors << "form submit must capture the submitter (approve must not silently deny)" unless app_js_source.include?("new FormData(form, event.submitter)")
# A failed quality gate for an abandoned/closed work item must not deadlock the close barrier (no waive path).
errors << "quality gate for an abandoned work item must not block close" unless core_source.include?("abandonedQualityGateWorkIds")
# Resolving a blocker must recompute the barrier so the close action appears without a manual cycle.
errors << "resolving a barrier blocker must recompute readiness + close barrier" unless server_source.include?("function recomputeBarrierAfterResolve") && server_source.scan("recomputeBarrierAfterResolve(state,").length >= 3
# The quality-gate / test evidence that now gates close must be visible in the console.
errors << "quality gates that gate close must be visible" unless server_source.include?("\"qualityGates\", \"testResults\"") && app_js_source.include?("质量门禁 / 测试证据")
# Cycle-2 round-3: abandoning/denying a cell must terminalize its runtime residue (dispatch/session/lease/
# target/guard) or those objects wedge the close barrier with no operator lever (same deadlock class as
# the quality-gate one). terminateCellRuntime cascades, called from the abandon actuator + the deny handler.
errors << "abandon/deny must cascade-terminalize the cell runtime (no orphaned close-barrier blocker)" unless core_source.include?("export function terminateCellRuntime") && core_source.include?("terminateCellRuntime(state, taskGroup.id, workItem.id") && mcp_source.include?("terminateCellRuntime(state, taskGroupId, workItemId")
# Cycle-2 round-4: the runtime_issue_candidates_exported gate blocked on status "candidate_created" but the
# export tool only READ candidates (never transitioned them), so the gate was structurally unsatisfiable —
# a created candidate wedged the close forever. Export now terminalizes candidates to "exported".
# Export must terminalize to the MODELED status (schema enum + state machine), not an invented value, and
# set the schema-required externalUpgradePackageRef. Cross-check the status against the schema enum so a
# future drift (code emitting a status the schema forbids) fails here.
sysupgrade_schema = File.read(File.join(ROOT, "spec/system-upgrade-candidate.schema.json"))
errors << "upgrade candidate export must terminalize to the modeled schema status + set externalUpgradePackageRef" unless mcp_source.include?("candidate.status = \"exported_for_external_maintenance\"") && mcp_source.include?("candidate.externalUpgradePackageRef =") && sysupgrade_schema.include?("\"exported_for_external_maintenance\"") && !mcp_source.include?("candidate.status = \"exported\"") && core_source.include?("runtime_issue_candidates_exported")
# Cycle-3 fixes:
# HIGH terminateCellRuntime must revoke the node binding + dispatch-bound grants + cancel confirmations
# (not just fail the dispatch) or dangling issued grants re-wedge close and the revoke finalizer resurrects it.
errors << "terminateCellRuntime must revoke node binding + grants + confirmations" unless core_source.include?("cancelPendingConfirmationsForDispatch(state, dispatch.dispatchId, reason)") && core_source.include?("revokeDispatchNodeBinding(state, dispatch, reason)")
# HIGH permission_resolve confused deputy: authorize on the granted resource, and reject a submit whose
# resource lives in a different project than the taskGroupId.
errors << "permission resolve/submit must guard against the confused-deputy cross-project grant" unless server_source.include?("permissionResolveResource?.resourceType === \"task_group\"") && core_source.include?("permission_request_resource_project_mismatch")
# MED proj-settings must not render empty editable rule editors on a config-GET failure (save would wipe).
errors << "project settings must guard rule editors against a config load failure" unless app_js_source.include?("const rulesLoaded = projConfig !== null")
# MED per-form dirty tracking so saving one form warns before discarding sibling forms' unsaved edits.
errors << "multi-form pages must track per-form dirtiness to avoid silent edit loss" unless app_js_source.include?("const dirtyFormKinds = new Set()") && app_js_source.include?("dirtyFormKinds.add(formDirtyKey(touchedForm))") && app_js_source.include?("function formDirtyKey")
# MED: the deny/abandon cascade revokes the node's dispatch grant, but the agent polls permission_status
# to learn the outcome — it must still be able to read its OWN request's terminal status (grant-exempt +
# previousNodeId ownership) or it spins for ~4min instead of stopping promptly on a deny.
errors << "a node must read its own permission_status after the deny/abandon grant revocation" unless mcp_source.include?("toolName === \"permission-mcp.permission_status\"") && mcp_source.include?("item.previousNodeId === principal.id") && core_source.include?("dispatch.previousNodeId = previousNodeId")
errors << "agentRuntimeNodes cap must retain live nodes and trim terminal first" unless agent_gateway_source.include?("function capAgentRuntimeNodes") && agent_gateway_source.include?("capAgentRuntimeNodes(state.agentRuntimeNodes)")
# F2: mcpGrants cap must never evict a still-issued grant of a live dispatch (would deny it MCP access).
errors << "mcpGrants cap must retain issued grants of live dispatches" unless agent_gateway_source.include?("function capMcpGrants") && agent_gateway_source.include?("capMcpGrants(state, state.mcpGrants)")
# F3: permission DENIAL must release the blocked session symmetrically (approve/deny) and demote the
# owning work item to needs_decision so the resolve_decision lever applies.
errors << "permission denial must release the blocked session and demote the work item" unless mcp_source.include?("function releasePermissionDeniedSession") && mcp_source.include?("releasePermissionDeniedSession(state, request, at)") && mcp_source.include?("permission_request_denied") && i18n_zh_source.include?("permission_request_denied")
errors << "MCP agent_node full state_get must be env-gated like system_service/admin" unless mcp_source.scan("AIMAC_MCP_ALLOW_FULL_STATE").length >= 3
errors << "Console must offer a resolve_decision actuator for needs_decision cells" unless app_js_source.include?("\"resolve_decision\"") && app_js_source.include?("resolution: data.resolution") && app_js_source.include?("admissionReasonLabel") && i18n_zh_source.include?("work_item_decision_reopen") && i18n_zh_source.include?("dependency_abandoned")
# Durable i18n-completeness guard: every static blockedReason / admission reasonCode literal set in
# core/gateway must have a zh dictionary key, else the Chinese console renders raw English (a
# recurring defect class). Also forbid TEMPLATE-LITERAL blockedReason (its interpolated variants can
# never be localized — use a static closed-set reason instead).
i18n_key = ->(code) { i18n_zh_source.match?(/^\s*#{Regexp.escape(code)}:/) }
# Scan core + gateway + MCP server: the MCP server also sets dispatch.blockedReason literals that the
# console renders via t(), so it must be covered or a raw-English reason (e.g. mcp_session_paused) leaks.
i18n_reason_sources = core_source + agent_gateway_source + mcp_source
localized_literals = i18n_reason_sources.scan(/(?:blockedReason|reasonCode)\s*[:=]\s*"([a-z_]+)"/).flatten.uniq
missing_localized = localized_literals.reject { |code| i18n_key.call(code) }
errors << "Console i18n missing blockedReason/reasonCode keys: #{missing_localized.join(', ')}" unless missing_localized.empty?
errors << "blockedReason must be a static string literal (not a template literal) for i18n" if i18n_reason_sources.match?(/blockedReason\s*[:=]\s*`/)
# reasonCode must also be a static literal (a template reasonCode is equally un-localizable and leaks
# raw English into the admission ledger via the t()/whyThisCellNow fallback).
errors << "reasonCode must be a static string literal (not a template literal) for i18n" if (core_source + agent_gateway_source).match?(/reasonCode\s*[:=]\s*`/)
# 2026-07-27 review round 6 residual (LOW security).
errors << "MCP instruction stable_prefix_get must be principal-scoped" unless mcp_source.include?("stablePrefixGet(state, args, principalProjectFilter(context))")
errors << "MCP permission_matrix_get must deny bounded principals" unless mcp_source.include?("permission_matrix_requires_unrestricted_principal")
errors << "MCP permission_status must be scoped to the principal" unless mcp_source.include?("permissionRequestReadableByPrincipal") && mcp_source.include?("permissionStatus(state, args, context)")
errors << "Skill-source git sync must restrict transports and validate inputs" unless core_source.include?("skill_source_unsafe_git_input") && core_source.include?("GIT_ALLOW_PROTOCOL")
# 2026-07-26 review round 2 fixes.
errors << "needs_decision cells must have a human resolution actuator" unless core_source.include?("resolve_decision") && core_source.include?("supersededByHumanDecision") && contract_check_source.include?("resolve_decision")
errors << "MCP readiness/close-barrier reads must guard bounded principals" unless mcp_source.include?("boundedTaskGroupGuard") && mcp_source.include?("boundedTaskGroupGuard(state, args, context) || computeCompletionReadiness") && mcp_source.include?("boundedTaskGroupGuard(state, args, context) || computeCloseBarrier")
# 2026-07-27 review round 4 fixes.
errors << "Dispatch-bound MCP grants must be refreshed on claim renewal" unless agent_gateway_source.include?("refreshDispatchGrantExpiry") && agent_gateway_source.include?("refreshDispatchGrantExpiry(state, dispatch, renewed, at)")
errors << "Revocation must have a node-death ACK-timeout requeue backstop" unless agent_gateway_source.include?("revocation_ack_timeout_requeued") && agent_gateway_source.include?("AIMAC_REVOCATION_ACK_TIMEOUT_MS")
# 钉的是属性而不是那一行源码：授权与路由都必须取自路径上的房间。原先直接钉
# `roomSend(state, {...body, roomId, taskGroupId: roomTaskGroupId})` 整串，把调用改成先构造入参变量
# 就会假红 —— 而属性一点没变。
errors << "Room send must scope authorization and routing from the path room only" unless server_source.include?("room_task_group_mismatch") && server_source.include?("{...body, roomId, taskGroupId: roomTaskGroupId}")
# 署名必须由服务端从已认证主体派生。报文里的 senderRef 若被采信，任何能发消息的 agent 都能
# 署名成业主 —— 而这个值直接进 eventLog 的 actor，伪造的署名同时污染了用来核对它的审计。
errors << "Room message sender must be derived from the authenticated principal, never from the request body" unless core_source.include?("ROOM_SENDER_KEY") && core_source.include?("senderRef: args[ROOM_SENDER_KEY]") && !mcp_source.include?("senderRef: string")
# 参与者名单按 participantId 替换：自报 id 就等于可以覆盖别人的记录（改其 roleId/cursor/sessionId）。
# 名单不参与授权判定，所以这不是提权 —— 但一张能被任意改写的名单一旦被呈现或被采信，就是错的来源。
# 处置/授权类下拉一律经 decisionSelect：它的第一项恰好都是后果最重的那个（已解决 / 采纳为本项目规则 /
# 激活为全局规范 / project_owner），而 select 默认选中第一项 —— 人不做选择直接提交就会拿到它。
# 钉的是"没有绕过助手的裸下拉"这个结构，不是某一段具体文案。
raw_decision_selects = public_app_source.scan(/<select name="(status|resolution|dispositionClass|role)"[^>]*>\s*<option/)
errors << "console decision dropdowns must go through decisionSelect (found raw: #{raw_decision_selects.flatten.uniq.join(", ")})" unless raw_decision_selects.empty?
errors << "console decisionSelect must render a disabled, selected, empty-valued placeholder and mark the select required" unless public_app_source.include?('<option value="" selected disabled>') && public_app_source.include?('<select name="${esc(name)}" required>')

# 接线：禁区下限必须落在【判据处】与【每一个生产者】上。只在生产者补齐是不够的 —— 已经落库的
# 旧目标（含那些完全没有该字段的）拿不到下限；只在判据处兜底也不够 —— 执行侧读的是存下来的值。
errors << "checkpoint denylist check must apply the mandatory floor (effectivePathDenylist), not the target's raw field" unless core_source.include?("pathMatchesAllowlist(path, effectivePathDenylist(target))")
errors << "the REST repository-output-target producer must set pathDenylist through the mandatory floor" unless server_source.include?("pathDenylist: effectivePathDenylist(")
# 接线：禁区下限必须落在【判据处】与【每一个生产者】上。只在生产者补齐是不够的 —— 已经落库的
# 旧目标（含那些完全没有该字段的）拿不到下限；只在判据处兜底也不够 —— 执行侧读的是存下来的值。
errors << "checkpoint denylist check must apply the mandatory floor (effectivePathDenylist), not the target's raw field" unless core_source.include?("pathMatchesAllowlist(path, effectivePathDenylist(target))")
errors << "the REST repository-output-target producer must set pathDenylist through the mandatory floor" unless server_source.include?("pathDenylist: effectivePathDenylist(")
# 接线：抹除必须挂在真正会被周期性调用的那条路上（心跳驱动的 recycleExpiredClaims），
# 否则函数写好了没人调用，明文令牌照样永久留着。
errors << "expired registration replays must be redacted from the heartbeat-driven reconciliation path" unless agent_gateway_source.include?("changed = redactExpiredRegistrationReplays(state, at) || changed;")
errors << "the repository-output-target route must reject a repository url not registered for the project" unless server_source.include?("repository_output_target_repository_not_registered_for_project") && server_source.include?("repositoryUrlRegisteredForProject(urlProject, body.repositoryUrl)")
# 接线：PG 的主读路径走 pgReadStateWithShards() 再把分片当 preReadShards 传进合并处，根本不经过
# readPostgresProjectShards —— 校验写在读取函数里等于没写，必须落在合并处。
# 写入侧同样要钉：摘要原先只在 runtime_json 分支里算（那段同时负责 generation 与文件名），
# PG 整段跳过。读取侧再严，索引里没有摘要也就无从核对。
# "校验安装"只防传输损坏：checksum 与被校验物同源、同进程实时生成，没有离线签名。
# 界面必须说出这条边界，否则运维会把它读成"能防服务器被篡改"，而那正是它防不了的。
errors << "the verified-install command must state that its checksum does not protect against a tampered control plane" unless public_app_source.include?("不能") && public_app_source.match?(/checksum 与安装脚本来自同一个控制面地址/)
# 接线：清理必须挂在每次写入都会经过的淘汰路径上；重放读取必须区分"响应体过期"与"成功但空"。
# 交给宿主机上那个 AI CLI 的必须是按派发签发、只对 MCP 有效的凭据，不是节点令牌 ——
# 节点令牌同时开着心跳、领派发、报事件这些网关端点。
runtime_source = File.read(File.join(ROOT, "apps/agent-runtime/runtime.mjs"))
# 撤销必须把写进用户全局 AI 客户端配置的那份凭据也清掉 —— 两条 revoke 分支都要，
# 否则"空闲时被撤销"这条路上凭据照样留在配置里。shutdown 不清（节点还会回来）。
errors << "revoking a node must clean the credential it wrote into the operator's global MCP client configs (both revoke branches)" unless runtime_source.scan(/if \(command\.commandType === "revoke"\) removeGlobalRemoteMcpClients\(\);/).size == 2
errors << "the executor must receive a dispatch-scoped MCP credential, never the node token" unless runtime_source.include?("AIMAC_MCP_BEARER_TOKEN: dispatchPackage.executorToken") && !runtime_source.include?("AIMAC_MCP_BEARER_TOKEN: config.nodeToken")
errors << "the executor credential must be accepted only on the MCP path" unless server_source.include?("authenticateExecutorPrincipal(state, token)") && !server_source.match?(/requireAuthenticated[\s\S]{0,400}?authenticateExecutorPrincipal/)
# PG 桥用 Atomics.wait 在主线程上等回复：每一次桥调用都会冻住定时器、WebSocket 心跳和其他请求的
# I/O 回调，所以"每请求几次往返"直接就是可用性问题。两条属性必须钉住（接线检查，正确性由
# docker compose 的 PG 端到端覆盖）：建表每进程只跑一次；读状态只读一次中央文档，
# 不再先经 ensureStoredState 把整份文档读出来【只为判断这一行存不存在】。
state_store_source = File.read(File.join(ROOT, "apps/control-plane-ui/lib/state-store.mjs"))
# 自治循环必须有东西驱动它。此前 runAutonomousCycle 的入口只有一个 HTTP 路由和一个 MCP 工具，
# 而 task_group:orchestrate 不在任何项目角色模板里、且不可委派 —— 除系统管理员外无人能点那个按钮，
# 系统自己也不动，于是"编排启动后自动生成"这句话永远不会成真。
# 对账（死节点清扫、认领过期回收、撤销截止期、注册重放明文令牌抹除）原先只挂在需要活节点发起的
# 路径上。服务端周期必须自己也跑一遍，且不受"有没有在跑的任务组"影响 —— 否则全队崩掉时它正好不跑。
# 这两个标记控制面早就在写（写它们的注释明写"必须留痕并让人看到"），而控制台从来没有渲染过 ——
# 人只看到"认领超时重新入队"，看不到最要紧的那句：上一任可能已经把提交推上去了。
# 领到派发之后必须清掉"接不了"的诊断，否则它会一直挂着、告诉人一件已经不成立的事。
# 会到人眼前的错误码必须有中文。词表自己的头注释就写着：未翻译时人看到的是一串英文枚举，而它们
# 出现的时机恰恰是人最需要看懂的时候。逐批补翻译治不了本 —— 下一个新错误码照样会漏。
# 登记的是【发给机器的那一侧】而不是【给人看的那一侧】：新增一个未登记的错误码默认要求翻译，
# 忘了登记的代价是被门拦下（看得见），反过来则是人某天撞上一串英文（看不见）。
machine_facing_error_codes = %w[
  mcp_streamable_http_requires_post mcp_auth_required
  event_node_binding_mismatch execution_event_key_required
  checkpoint_replay_binding_mismatch dispatch_not_assigned_to_node
  room_task_group_mismatch
].to_set
# 核心与网关抛出的错误码同样会到人眼前：respondApiError 把它们原样回给控制台，而失败原因还会
# 落在派发记录上（监控页按 t(blockedReason || failureReason) 渲染）。只扫 server.mjs 会漏掉
# 这一整片 —— 实测扩进来时有 114 个静态码没有中文。
core_error_codes = (core_source.scan(/new Error\("([a-z0-9_]{5,})"\)/) +
                    core_source.scan(/topologyError\("([a-z0-9_]{5,})"/) +
                    agent_gateway_source.scan(/new Error\("([a-z0-9_]{5,})"\)/) +
                    agent_gateway_source.scan(/gatewayError\("([a-z0-9_]{5,})"/)).flatten.uniq
server_error_codes = (server_source.scan(/error:\s*"([a-z0-9_]+)"/).flatten + core_error_codes).uniq
# 本条同样不得空转：错误码总数远少于预期即说明提取逻辑与代码脱节。
errors << "error-code i18n coverage check only found #{server_error_codes.size} codes — extraction has drifted" if server_error_codes.size < 150
untranslated = server_error_codes.reject do |code|
  machine_facing_error_codes.include?(code) || i18n_zh_source.match?(/\n\s*#{Regexp.escape(code)}:/)
end
unless untranslated.empty?
  errors << "these error codes reach a person with no Chinese rendering: #{untranslated.sort.join(", ")} (translate them, or register them as machine-facing)"
end
# 登记表本身也会过期：一个已经翻译了的机器面错误码说明它其实会到人眼前，登记就该撤掉。
stale_machine_facing = machine_facing_error_codes.select { |code| i18n_zh_source.match?(/\n\s*#{Regexp.escape(code)}:/) }
unless stale_machine_facing.empty?
  errors << "these codes are registered as machine-facing but have Chinese renderings: #{stale_machine_facing.sort.join(", ")} — remove the registration or the translation"
end

# 项目必须有终结路径：没有它，组织的项目配额只增不减，建满之后再也建不了新的，而它手上没有任何杠杆。
# 规则标题会原样下发给模型（renderRules 拼成 `## <title>`），所以它必须进摘要 —— 否则改标题
# 就改了模型读到的内容，而"契约签发后规则变过"的检测一位都不动。
# 内容包写入前必须先清空：提示词点名的是控制面下发的那几份规则文件，而目录里残留的旧文件
# （例如人把某一类规则全部禁用之后不再下发的那份）会在重排队复用同一 sessionId 时复活。
errors << "the content bundle directory must be cleared before it is written (a deleted rule must not survive on disk)" unless runtime_source.include?("rmSync(bundleDir, {recursive: true, force: true})")
# 提示词不得把"这个目录下的每一个文件"都宣布为规则：git-transfer 在同一目录下，内容来自项目仓库，
# 任何能往仓库写文件的人都能让一段文字变成"必须遵守的规则"。
errors << "the prompt must name the delivered rule files instead of declaring every file in the bundle directory binding" unless runtime_source.include?("these rule files, which are binding constraints") && !runtime_source.include?("read and apply EVERY file under")
# 重新定基线必须走共用函数：契约里有四处引用同一个规则摘要，只改其中一个会让同一份契约自相矛盾，
# 而它会被整份交给 agent。两处各写一遍派生公式正是这类不一致最初的来源。
# 配错会削弱某条保证的开关必须在 .env.example 里有名有姓地写明【默认值】与【调错的后果】。
# 只钉这一类：内部容量上限与 agent 侧测试钩子刻意不列 —— 文档里的噪声会让要紧的条目不再被阅读。
# 新增一个这类开关而不写文档，运维就只能从源码里发现它，或者根本发现不了。
safety_relevant_env_vars = %w[
  AIMAC_TRANSITION_STRICT AIMAC_ORCHESTRATOR_INTERVAL_MS
  AIMAC_REVOCATION_ACK_TIMEOUT_MS AIMAC_REGISTER_REPLAY_WINDOW_MS
  AIMAC_IDEMPOTENCY_PAYLOAD_TTL_MS AIMAC_NODE_HEARTBEAT_TIMEOUT_MS
  AIMAC_ROOM_MESSAGE_MAX_BYTES AIMAC_MCP_SERVICE_ALLOWED_TOOLS
  AIMAC_RUNTIME_JSON_FSYNC AIMAC_EXPOSE_BOOTSTRAP_HINT AIMAC_ALLOW_LOCAL_GIT_REMOTE
  AIMAC_TRUST_PROXY AIMAC_LOGIN_ATTEMPTS_PER_MINUTE
  AIMAC_MCP_ALLOW_FULL_STATE AIMAC_ALLOW_INSECURE_PUBLIC_URL AIMAC_PROJECT_EVENT_FSYNC
]
env_example = File.read(File.join(ROOT, ".env.example"))
undocumented_env = safety_relevant_env_vars.reject { |name| env_example.include?(name) }
unless undocumented_env.empty?
  errors << "these switches change a safety guarantee and are not documented in .env.example: #{undocumented_env.sort.join(", ")}"
end

# 设计文档不得声称一个不存在的保护。有人会据它做决定 —— 这与代码里"看着像门、实际空转"是同一类，
# 只是长在文档层，而文档层没有任何测试会失败。
room_design_doc = File.read(File.join(ROOT, "docs/multi-agent-project-orchestration-system-design.md"))
apps_sources = Dir[File.join(ROOT, "apps/**/*.mjs")].map { |path| File.read(path) }.join("\n")
if room_design_doc.include?("hopCount") && !room_design_doc.include?("`hopCount` 未实现") && !apps_sources.include?("hopCount")
  errors << "the design doc credits hopCount with preventing agent reply loops while no such field exists in the code"
end

errors << "re-baselining the effective-rules digest must rewrite every field derived from it (one shared helper, not a bare assignment)" unless core_source.include?("export function applyEffectiveRulesDigest") && agent_gateway_source.include?("applyEffectiveRulesDigest(contract, currentRulesDigest)") && !agent_gateway_source.include?("contract.effectiveRulesDigest = currentRulesDigest")
errors << "the rule digest must cover the title (it is delivered to the model verbatim)" unless core_source.include?("digestOf({ruleId, category, title, content})")
# 判别力门必须真的在跑。它把"改坏守卫→测试必须变红"这套纪律固化成脚本，而它此前有 npm 脚本
# 却不在任何链路上 —— 用来强制"断言必须有判别力"的机制自己没在跑，是本仓最讽刺的一处空转。
errors << "the mutation gate must be wired into the doctor chain" unless File.read(File.join(ROOT, "package.json")).include?("npm run -s mutation-gate")
errors << "a project must have a way to be archived (otherwise the project quota only ever grows)" unless server_source.include?("project_archive") && server_source.include?('project.status = "archived"')
errors << "archiving must refuse a project that still has open task groups instead of settling them for the person" unless server_source.include?("project_has_open_task_groups")
errors << "a successful claim must clear the stale cannot-claim diagnosis" unless agent_gateway_source.match?(/return \{dispatch: null, reason: "no_compatible_dispatch"\};\s*\}\s*delete node\.lastClaimMiss;/)
errors << "the console must surface previousHolderMayHavePushed (an unreviewed push becomes the next holder's baseline)" unless public_app_source.include?("dispatch.previousHolderMayHavePushed")
errors << "the console must surface which self-check items failed, not just the degraded badge" unless public_app_source.include?("node.selfCheckMissing") && agent_gateway_source.include?("node.selfCheckMissing = missing")
errors << "the server-side tick must reconcile regardless of whether any task group is open (dead-node sweep cannot depend on a live node)" unless server_source.match?(/const reconciled = recycleExpiredClaims\(state\);[\s\S]{0,400}?const pending = /)
errors << "the autonomous cycle must have something driving it (no scheduler means a task group never starts)" unless server_source.include?("export function runOrchestratorTick()") && server_source.match?(/setInterval\(runOrchestratorTick/)
errors << "postgres DDL must be memoized per process (every bridge call blocks the event loop)" unless state_store_source.include?("if (postgresTablesEnsured) return;")
errors << "the postgres read path must not pay for a full central read just to probe existence" unless state_store_source.match?(/export function readStoredState\(options\) \{\s*\n\s*if \(stateStoreKind\(\) === "postgresql"\) \{/)
errors << "idempotency payload purge must run on the eviction path taken by every write" unless server_source.include?("purgeExpiredIdempotencyPayloads(state);")
errors << "an expired idempotency replay must not be returned as an empty success" unless server_source.include?("idempotent_result_expired")
errors << "postgres project shards must carry a payload digest in the central index (it is computed outside the runtime_json generation branch)" unless File.read(File.join(ROOT, "apps/control-plane-ui/lib/state-store.mjs")).include?("if (!nextGeneration) {") && File.read(File.join(ROOT, "apps/control-plane-ui/lib/state-store.mjs")).match?(/if \(!nextGeneration\) \{[\s\S]{0,900}?shard\.storagePayloadDigest = digestProjectShardPayload\(shard\);/)
errors << "postgres project shards must be integrity-checked where they are merged, not in a read helper the main path skips" unless File.read(File.join(ROOT, "apps/control-plane-ui/lib/state-store.mjs")).include?('if (stateStoreKind() === "postgresql") assertProjectShardsMatchCentralIndex(shards, centralState);')
errors << "Room participant identity must be derived from the authenticated principal, never from the request body" unless mcp_source.include?("ROOM_PARTICIPANT_KEY") && mcp_source.include?("participantId: args[ROOM_PARTICIPANT_KEY]") && !mcp_source.include?("participantId: string")
errors << "close-barrier must not trust a stale-version cached readiness" unless core_source.include?("cachedReadiness.stateVersion === state.stateVersion") && contract_check_source.include?("stale readiness")
errors << "Human directives must be consumed oldest-first" unless core_source.include?("status === \"queued\").reverse()") && contract_check_source.include?("directive FIFO")
# 2026-07-27 MGP core-init absorption: global intelligent judgment over mechanical/redundant/useless gates.
errors << "Transitions must enforce state/actor legality but not ceremonial evidence tokens" unless transition_engine_source.include?("spec integrity: every required gate id must be modeled") && !transition_engine_source.include?("requires_evidence_missing") && transition_engine_source.include?("gate.unresolved")
errors << "dispatchWorkItem must not fabricate per-gate transition evidence" unless !core_source.include?("redispatch:")
errors << "close-barrier must drop vacuous always-pass stub gates" unless !core_source.include?("all_policy_decisions_terminal") && !core_source.include?("release_manifest_ready") && !core_source.include?("not_applicable_collection_not_modeled")
errors << "close-barrier must record a reality-first holistic judgment" unless core_source.include?("holisticJudgment") && core_source.include?("reality_first_close_barrier") && contract_check_source.include?("holistic judgment")
errors << "Server must offer authenticated real-time WebSocket push over the long-poll channels" unless server_source.include?("WebSocketServer") && server_source.include?("/api/realtime") && server_source.include?("pushRealtime") && server_source.include?("authorizeRealtime") && server_source.include?("pushRealtime(key)") && doctor_source.include?("verifyRealtimeWebSocket")
# The upgrade handler must guard authorizeRealtime() (which calls readState()) so a state-store throw
# destroys the socket instead of becoming an uncaughtException that exits the process.
errors << "WebSocket upgrade handler must fail-closed on authorization errors" unless server_source.include?("let principal;") && server_source.include?("principal = authorizeRealtime(req);\n  } catch {")
# admissionDecisions must gate on task-group visibility (like checkpoints/closeBarriers), not fall
# back to project visibility for records that DO carry a taskGroupId (cross-scope leak).
errors << "admissionDecisions projection must gate strictly on task-group visibility" unless server_source.include?("item.taskGroupId ? visibleTaskGroupIds.has(item.taskGroupId) : visibleProjectIds.has(item.projectId)")
errors << "UI and API must expose session-scoped execution events" unless server_source.include?("work-sessions") && server_source.include?("sessionEventsMatch") && server_source.include?("sessionId: session.sessionId") && public_app_source.include?("show-session-events")
errors << "Execution event project sequence must be assigned under the per-project append lock" unless project_event_store_source.include?("sequence: Number(index.lastSequence || 0) + 1") && contract_check_source.include?("append-order project sequences inside the project lock")
errors << "Execution event projection must append durable events before central projection and recover historical bindings" unless server_source.include?("prepareAgentExecutionEvent") && server_source.include?("appendProjectExecutionEvent(runtimeDir, prepared.event)") && server_source.include?("allowHistoricalNodeBinding") && server_source.include?("event_node_binding_mismatch")
errors << "Long polling must use write notifications instead of fixed interval synchronous polling" unless server_source.include?("waitForLongPollSignal") && server_source.include?("notifyLongPollWaiters") && !server_source.include?("await delay(250)")
errors << "Agent Gateway must issue server-managed skill worksets" unless agent_gateway_source.include?("agent-skill-workset/v1") && agent_gateway_source.include?("server_managed_on_demand") && agent_gateway_source.include?("Child roles MUST receive")
errors << "Agent Runtime must use remote MCP and on-demand skill worksets" unless agent_runtime_source.include?("AIMAC_MCP_URL") && agent_runtime_source.include?("syncSkillWorkset") && agent_runtime_source.include?("do not start or install any local MCP server")
errors << "Agent Runtime dispatch prompt must use compact DISPATCH v1 envelope" unless agent_runtime_source.include?("\"DISPATCH v1\"") && agent_runtime_source.include?("`model: ${model.model") && agent_runtime_source.include?("`reasoning: ${model.reasoning") && agent_runtime_source.include?("model.modelDecision")
errors << "Agent Runtime dispatch prompt must prefer locators over pasted long context" unless agent_runtime_source.include?("contract.inputLocators") && agent_runtime_source.include?("`package:${packagePath}`") && agent_runtime_source.include?("writeSet:")
errors << "Agent task contract schema must require explicit model/reasoning/modelDecision" unless load_json("spec/agent-task-contract.schema.json").dig("properties", "model", "required")&.include?("modelDecision")
errors << "Task group language policy must be a first-class dispatch contract and runtime field" unless core_source.include?("normalizeTaskGroupLanguagePolicy") && core_source.include?("languagePolicyDigest") && load_json("spec/agent-task-contract.schema.json").fetch("required").include?("languagePolicy") && load_json("spec/effective-instruction-packet.schema.json").fetch("required").include?("languagePolicy") && load_json("spec/agent-skill-workset.schema.json").fetch("required").include?("languagePolicy") && agent_runtime_source.include?("`language: ${languageTag}`") && public_app_source.include?("data-language-policy-form") && server_source.include?("/language-policy")
errors << "Execution outputs and events must bind language policy digest" unless load_json("spec/checkpoint.schema.json").fetch("required").include?("languagePolicyDigest") && load_json("spec/agent-execution-event.schema.json").fetch("required").include?("languagePolicyDigest") && agent_gateway_source.include?("languagePolicyDigest: dispatch.languagePolicyDigest") && contract_check_source.include?("Agent execution event did not bind")
errors << "Model selection decision schema must require short modelDecision" unless load_json("spec/model-selection-decision.schema.json").fetch("required").include?("modelDecision")
errors << "Agent Runtime must always maintain agent-scoped remote MCP client config" unless agent_runtime_source.include?("writeAgentScopedMcpConfig") && agent_runtime_source.include?("mcp-client-configs") && agent_runtime_source.include?("configureGlobalRemoteMcpClients")
errors << "Agent doctor must verify agent-scoped MCP config and credential rotation refresh" unless agent_doctor_source.include?("assertAgentScopedMcpConfig") && agent_doctor_source.include?("was not refreshed after node credential rotation")
errors << "Agent doctor must verify remote join/MCP/skill/dispatch/Git/checkpoint flow" unless agent_doctor_source.include?("one-command join") && agent_doctor_source.include?("on-demand skill workset") && agent_doctor_source.include?("commit, push and checkpoint")
errors << "Agent doctor must reject nodes without model executors" unless agent_doctor_source.include?("doctor-agent-no-executor-token") && agent_doctor_source.include?("node_not_admitted")
errors << "npm scripts must load .env through run-with-env wrapper" unless package_json.dig("scripts", "start").to_s.include?("run-with-env") && package_json.dig("scripts", "mcp:start").to_s.include?("run-with-env")
errors << "run-with-env must parse .env before importing target script" unless run_with_env_source.include?("loadDotEnv") && run_with_env_source.include?("await import")
errors << "account invites must issue one-time per-account token digests usable by login" unless server_source.include?("account-invite:") && server_source.include?("credentialConsumedAt") && server_source.include?("delete account.credentialDigest") && doctor_source.include?("invite account token to be one-time")
errors << "project account invites must not escalate to system admins" unless server_source.include?("requestedSystemAccountInvite") && server_source.include?("system_account_invite") && doctor_source.include?("project-scoped inviter not to create system admin")
errors << ".env.example must not define empty secret values that fail weak-secret checks" if env_example_source.match?(/^(AIMAC_BOOTSTRAP_TOKEN|AIMAC_MCP_SERVICE_TOKEN|AIMAC_LOCAL_SEED_.*TOKEN|POSTGRES_PASSWORD)=/m)
errors << "docker:up must generate and then reuse persisted local verification secrets" unless docker_up_source.include?("value_or_generated") && docker_up_source.include?("existing_env_value") && docker_up_source.include?("POSTGRES_PASSWORD_VALUE") && docker_up_source.include?("--env-file")
errors << "docker:up must not fall back to predictable timestamp-derived secrets" if docker_up_source.include?("date \"+%s\"")
errors << "contract-check must validate runtime and McpGrant schemas" unless contract_check_source.include?("RuntimeBootstrapProfile") || (contract_check_source.include?("runtime-bootstrap.schema.json") && contract_check_source.include?("mcp-grant.schema.json"))
errors << "package validate must run contract:check" unless package_json.dig("scripts", "validate").to_s.include?("contract:check")
errors << "doctor script must run MCP doctor" unless package_json.dig("scripts", "doctor").to_s.include?("mcp:doctor")
errors << "seed runtime must expose MCP metadata" unless seed_state.dig("runtime", "mcp", "toolCount").to_i >= expected_mcp_tools.values.flatten.length
%w[mcpStart agentJoin mcpDoctor].each do |command_name|
  errors << "seed runtime commands missing #{command_name}" unless seed_state.dig("runtime", "commands", command_name)
end
runtime_schema = load_json("spec/runtime-bootstrap.schema.json")
errors << "RuntimeBootstrapProfile schema must require mcp" unless runtime_schema.fetch("required").include?("mcp")
%w[mcpStart agentJoin mcpDoctor].each do |command_name|
  errors << "RuntimeBootstrapProfile commands schema missing #{command_name}" unless runtime_schema.dig("properties", "commands", "properties", command_name)
end
errors << "RuntimeBootstrapProfile schema missing mcp property" unless runtime_schema.dig("properties", "mcp", "properties", "toolCount")
compose_source = File.read(File.join(ROOT, "docker-compose.yml"))
errors << "docker-compose must run control plane with PostgreSQL state store" unless compose_source.include?("AIMAC_STATE_STORE") && compose_source.include?("postgresql")
%w[AIMAC_BOOTSTRAP_TOKEN AIMAC_MCP_SERVICE_TOKEN AIMAC_LOCAL_SEED_WORKSPACE_OWNER_TOKEN AIMAC_LOCAL_SEED_REVIEWER_TOKEN AIMAC_LOCAL_SEED_AGENT_RUNTIME_TOKEN].each do |env_name|
  errors << "docker-compose must pass #{env_name}" unless compose_source.include?(env_name)
end

seed_state.fetch("repositoryOutputs", []).each do |target|
  unless target["outputPolicy"] == "project_git_repository_only"
    errors << "seed repository output #{target["targetId"]} must use project_git_repository_only"
  end
  manifest_path = target["artifactManifestPath"].to_s
  if manifest_path.empty? || manifest_path.start_with?("artifacts/", "/tmp/", ".runtime/")
    errors << "seed repository output #{target["targetId"]} artifactManifestPath must be a git-trackable project path"
  end
  %w[schemaVersion targetId decisionRecordRef auditRef createdAt updatedAt].each do |field|
    errors << "seed repository output missing #{field}: #{target.inspect}" if target[field].nil? || target[field].to_s.empty?
  end
end

seed_state.fetch("accounts", []).each do |account|
  %w[schemaVersion accountId accountType status displayName roles permissions authPolicy createdAt updatedAt].each do |field|
    errors << "seed account missing #{field}: #{account.inspect}" if account[field].nil? || account[field].to_s.empty?
  end
  errors << "seed account #{account["accountId"]} uses deprecated id field" if account.key?("id")
  errors << "seed account #{account["accountId"]} uses deprecated auth field" if account.key?("auth")
  if account["accountType"] == "user_account"
    disallowed_direct = account.fetch("permissions", []).grep(/\A(project|task_group):/)
    disallowed_direct -= ["project:create"]
    disallowed_direct += account.fetch("permissions", []) & %w[member:invite agent:activate]
    errors << "seed user account #{account["accountId"]} has non-scoped direct project/task permissions: #{disallowed_direct.sort.join(", ")}" unless disallowed_direct.empty?
  end
end

account_role_enum = load_json("spec/account.schema.json").dig("properties", "roles", "items", "enum").to_set
seed_state.fetch("accounts", []).each do |account|
  account.fetch("roles", []).each do |role|
    errors << "seed account #{account["accountId"]} role not in Account schema: #{role}" unless account_role_enum.include?(role)
  end
end

task_group_states = Set.new(state_machines.dig("machines", "TaskGroup", "states"))
seed_state.fetch("taskGroups", []).each do |task_group|
  errors << "seed taskGroup #{task_group["id"]} status not in TaskGroup state machine: #{task_group["status"]}" unless task_group_states.include?(task_group["status"])
  policy = task_group["languagePolicy"]
  unless policy && policy["schemaVersion"] == "language-policy/v1" && policy["languageTag"].to_s.length.positive?
    errors << "seed taskGroup #{task_group["id"]} missing languagePolicy"
  end
end

seed_state.fetch("accessGrants", []).each do |grant|
  %w[schemaVersion grantId status subjectRef resource role permissions policyDecisionRef createdAt updatedAt].each do |field|
    errors << "seed access grant missing #{field}: #{grant.inspect}" if grant[field].nil? || grant[field].to_s.empty?
  end
  %w[id subjectId resourceType resourceId].each do |field|
    errors << "seed access grant #{grant["grantId"]} uses deprecated #{field} field" if grant.key?(field)
  end
end

seed_state.fetch("sharedDefinitions", []).each do |definition|
  %w[schemaVersion contractId status projectId definitionType scopeRefs canonicalOwnerRole producerRole consumerRefs definitionDigest repositoryOutputTargetRef repositoryOutputTargetDigest conflictPolicy changePolicy reviewEvidenceRefs createdAt updatedAt].each do |field|
    errors << "seed shared definition missing #{field}: #{definition.inspect}" if definition[field].nil? || definition[field].to_s.empty?
  end
  errors << "seed shared definition #{definition["contractId"]} uses deprecated id field" if definition.key?("id")
  errors << "seed shared definition #{definition["contractId"]} has schema-extra name field" if definition.key?("name")
end

seed_state.dig("instructionMetrics", "envelopes").to_a.each do |envelope|
  %w[schemaVersion envelopeId status taskGroupId recipientRole effectiveInstructionPacketRef formatVersion stablePrefixDigest digestRefs sharedDefinitionRefs cacheKey tokenBudget outputContractRef createdAt updatedAt].each do |field|
    errors << "seed instruction envelope missing #{field}: #{envelope.inspect}" if envelope[field].nil? || envelope[field].to_s.empty?
  end
  errors << "seed instruction envelope #{envelope["envelopeId"]} uses deprecated id field" if envelope.key?("id")
end

# docs/machine-executable-artifacts.md 那张表逐行声称每份规格制品「由谁消费」。它是这份仓库里
# 唯一说明「哪些规格是真的被机器强制的」的地方 —— 而它此前没有任何东西核对过。
# 实测发现 4 行声称的消费者在代码里对该文件零引用（git-automation-policy / git-command /
# session-placement-policy / external-capability-boundary）：设计已被别的机制取代，表还在说它管用。
# 两个方向都要核：标了「当前无消费者」的必须真的没人引用（否则是过时的悲观标注，会让人以为
# 一条真在生效的约束不存在），没标的必须真有引用（否则是不实的声称）。
artifact_doc_path = File.join(ROOT, "docs/machine-executable-artifacts.md")
if File.exist?(artifact_doc_path)
  artifact_doc = File.read(artifact_doc_path)
  code_corpus = Dir[File.join(ROOT, "{apps,scripts}/**/*.{mjs,js,rb}")].map { |f| File.read(f) }.join("\n")
  rows = artifact_doc.scan(/^\| `(spec\/[^`]+)` \| ([^|]+) \|/)
  errors << "制品清单表没有解析到任何行 —— 这道核对在空转" if rows.length < 40
  rows.each do |file, consumers|
    path = File.join(ROOT, file)
    unless File.exist?(path)
      errors << "制品清单: #{file} 在表里列着，但文件不存在"
      next
    end
    base = File.basename(file)
    schema_version = nil
    if file.end_with?(".json")
      begin
        schema_version = JSON.parse(File.read(path)).dig("properties", "schemaVersion", "const")
      rescue StandardError
        schema_version = nil
      end
    end
    referenced = code_corpus.include?(base) || (schema_version && code_corpus.include?(schema_version))
    declared_unused = consumers.include?("当前无消费者")
    if referenced && declared_unused
      errors << "制品清单: #{file} 标着「当前无消费者」，但代码里确实引用了它 —— 过时的标注会让人以为一条正在生效的约束不存在"
    elsif !referenced && !declared_unused
      errors << "制品清单: #{file} 声称消费者是「#{consumers.strip}」，但全仓代码对它零引用 —— 这张表是判断「哪些规格真被机器强制」的唯一依据，说错了比不说更糟"
    end
  end
end

# 「凡是改变账号可登录性/凭据的地方都必须回收它已有的会话」——这条不变量写在 revokeAccountSessions
# 的注释里，此前没有任何东西强制它。少一次的后果很具体：被停用的人继续读租户数据；改了密码
# 而泄露的令牌照样能用（而改密码正是怀疑被盗号时唯一的自救手段）。
#
# 这条门钉的是【四条已知路径都还在】。它挡得住"回收被删掉/改名"这种回归，挡不住"新增一条
# 改凭据的路径却忘了回收"——后者需要在语法上枚举"哪些写入降低可登录性"，而停用那处写的是变量
# （member.status = nextMemberStatus），硬要囊括就会把"激活"也算进来，判据越做越绕、假红风险更大。
# 与其造一个自己都说不清边界的判据，不如把能判准的那部分判死，并在这里写明它的边界。
account_session_revocations = {
  "member_disabled" => "组织成员被停用",
  "account_suspended" => "MCP 侧挂起账号",
  "password_changed" => "改密码（怀疑被盗号时唯一的自救手段）",
  "invite_reissued" => "重发邀请＝铸一份新凭据"
}
revocation_sources = ["apps/control-plane-ui/server.mjs", "apps/mcp-server/server.mjs"]
  .map { |file| File.read(File.join(ROOT, file)) }.join("\n")
revocation_lines = revocation_sources.lines.select { |line| line.include?("revokeAccountSessions(") }
account_session_revocations.each do |reason, description|
  next if revocation_lines.any? { |line| line.include?(reason) }
  errors << "#{description}后没有回收该账号已有的会话（缺 revokeAccountSessions 的 #{reason}）—— " \
            "被停用的人仍能继续读，改过的密码对已泄露的令牌仍然无效"
end
if revocation_lines.length < account_session_revocations.length
  errors << "只找到 #{revocation_lines.length} 处 revokeAccountSessions 调用，少于已知的 #{account_session_revocations.length} 处 —— 提取逻辑与代码脱节"
end

# 组织"停用"必须叫停【已经在跑的】执行，而不只是挡住新建与认领。
# 任务组"暂停"一直会向在跑的 agent 下 pause_dispatch（applyTaskGroupRuntimeControl）；组织停用
# 此前只翻一个字段，名下已经在跑的 agent 继续跑到底、继续推 git、继续烧额度。
# 行为那一半由 contract-check 验（暂停执行器的语义），这一半钉住"停用路由确实调用了它"——
# 执行器住在 HTTP 层，契约门不启服务，只有源码断言够得着。
# 匹配前先剥掉注释：这段处理的注释里就提到了这个函数名，不剥的话门匹配的是我自己写的说明，
# 把调用整个删掉照样绿（这一处我已经踩到过一次）。
org_suspend_route = server_source[/orgStatusMatch = url\.pathname\.match.*?\n  \}/m]
if org_suspend_route.nil?
  errors << "找不到组织状态路由，无法核对停用是否叫停在跑的执行"
elsif !org_suspend_route.lines.reject { |line| line.strip.start_with?("//") }.join.include?("applyTaskGroupRuntimeControl(")
  errors << "停用组织没有叫停它名下正在跑的派发（缺 applyTaskGroupRuntimeControl）—— " \
            "agent 会跑到底、把产出推上 git、把额度烧完，而控制台上写着已停用"
end

# 源码字符串断言不得靠【注释】成立。
#
# 本门有 479 条 `xxx_source.include?("字面量")` 形式的断言。若那个字面量在目标文件里只出现在注释中，
# 这条断言守的就是一段说明而不是代码：把真实实现删掉、注释留着，它照样绿。实测抓到 3 条完全如此
# （shared_definition 的 continue、评审包的 submitted、过期会话扫描器），另有 4 条是"散文合取项 +
# 真实合取项"的组合——前者不守任何东西，还会因为改一句注释而假红。
# 这个坑我在两道新门上各踩过一次（HTML 注释、处理函数里的说明），所以做成常驻核对。
prose_only_assertions = []
prose_scan_sources = {
  "core_source" => "apps/control-plane-ui/lib/control-plane-core.mjs",
  "server_source" => "apps/control-plane-ui/server.mjs",
  "gateway_source" => "apps/control-plane-ui/lib/agent-gateway.mjs",
  "mcp_source" => "apps/mcp-server/server.mjs",
  "app_js_source" => "apps/control-plane-ui/public/app.js",
  "contract_check_source" => "scripts/contract-check.mjs",
  "schema_validator_source" => "scripts/lib/schema-validate.mjs"
}
# 登记：确实在要求"这段说明必须在"的断言（文档性要求），而不是在验代码行为。
prose_assertion_exemptions = ["admission ledger"]
prose_scan_cache = {}
prose_scanned = 0
File.read(File.join(ROOT, "scripts/validate-specs.rb")).scan(/([a-z_]+_source)\.include\?\("((?:[^"\\]|\\.)*)"\)/) do |var, literal|
  file = prose_scan_sources[var]
  next unless file
  path = File.join(ROOT, file)
  next unless File.exist?(path)
  prose_scan_cache[file] ||= begin
    raw = File.read(path)
    [raw, raw.lines.reject { |line| line.strip.start_with?("//") }.join]
  end
  needle = literal.gsub('\\"', '"').gsub("\\\\", "\\")
  raw, stripped = prose_scan_cache[file]
  next unless raw.include?(needle)
  prose_scanned += 1
  next if stripped.include?(needle)
  next if prose_assertion_exemptions.any? { |allowed| needle.include?(allowed) }
  prose_only_assertions << "#{file}: #{needle[0, 70]}"
end
if prose_scanned < 300
  errors << "源码字符串断言核对只扫到 #{prose_scanned} 条，远少于预期 —— 提取逻辑与本文件脱节，本条在空转"
end
prose_only_assertions.each do |detail|
  errors << "源码字符串断言只靠注释成立（#{detail}）—— 把真实实现删掉、注释留着，这条断言照样绿；" \
            "请改成指向真实代码，或登记到 prose_assertion_exemptions 说明它要求的确实是那段说明"
end


fail_with(errors)

puts "spec validation ok"
