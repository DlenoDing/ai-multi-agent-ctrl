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
  scripts/init-control-plane.mjs
  scripts/doctor.mjs
  scripts/sync-agent-skills.mjs
  apps/control-plane-ui/server.mjs
  apps/control-plane-ui/lib/control-plane-core.mjs
  apps/control-plane-ui/public/index.html
  apps/control-plane-ui/public/styles.css
  apps/control-plane-ui/public/app.js
  data/seed-state.json
  spec/agent-dispatch.schema.json
]

required_runtime_files.each do |path|
  errors << "runtime entrypoint missing: #{path}" unless File.exist?(File.join(ROOT, path))
end

required_npm_scripts = %w[init dev start shell:start skills:sync validate doctor docker:build docker:up]
available_scripts = package_json.fetch("scripts", {})
missing_npm_scripts = required_npm_scripts.reject { |script_name| available_scripts.key?(script_name) }
errors << "package.json missing scripts: #{missing_npm_scripts.join(", ")}" unless missing_npm_scripts.empty?

unless File.executable?(File.join(ROOT, "scripts/start.sh"))
  errors << "scripts/start.sh must be executable"
end

dockerfile = File.read(File.join(ROOT, "Dockerfile"))
errors << "Dockerfile must install git for skills:sync" unless dockerfile.include?("git")

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
  InstructionEnvelope
  SharedDefinitionContract
  RepositoryOutputTarget
  AgentTaskContract
  CloseBarrier
])

schema_titles = Set.new(Dir[File.join(ROOT, "spec/*.schema.json")].map { |path| JSON.parse(File.read(path)).fetch("title") })
missing_critical_schemas = critical_schema_titles - schema_titles
errors << "critical schema titles missing: #{missing_critical_schemas.to_a.sort.join(", ")}" unless missing_critical_schemas.empty?

Dir[File.join(ROOT, "spec/*.schema.json")].sort.each do |path|
  schema = JSON.parse(File.read(path))
  title = schema["title"]
  status_enum = schema.dig("properties", "status", "enum")
  next unless title && status_enum && state_machines["machines"][title]

  schema_statuses = Set.new(status_enum)
  machine_states = Set.new(state_machines["machines"][title]["states"])
  missing_in_schema = machine_states - schema_statuses
  missing_in_machine = schema_statuses - machine_states
  unless missing_in_schema.empty? && missing_in_machine.empty?
    errors << "#{title} status enum/state machine mismatch; missing in schema: #{missing_in_schema.to_a.sort.join(", ")}; missing in state machine: #{missing_in_machine.to_a.sort.join(", ")}"
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
  agent-runtime
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
doctor_source = File.read(File.join(ROOT, "scripts/doctor.mjs"))
{
  "server must expose agent runtime worker endpoint" => "/api/agent-runtime/run",
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

fail_with(errors)

puts "spec validation ok"
