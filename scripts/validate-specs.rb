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
errors << "runAutonomousCycle must isolate per-cell and per-task-group failures" unless core_source.include?("cell_processing_error") && core_source.include?("Per-cell isolation") && core_source.include?("task_group_recompute_error")
# 2026-07-26 multi-dimension review fixes.
errors << "Remote git verification must validate the repository URL and restrict git transports" unless server_source.include?("prepareRemoteGitVerification") && server_source.include?("isSafeGitRemoteUrl(target.repositoryUrl)") && server_source.include?("GIT_ALLOW_PROTOCOL") && agent_gateway_source.include?("export function isSafeGitRemoteUrl")
errors << "Repository output target selection must reject an unsafe git URL at write time" unless server_source.include?("repository_output_target_unsafe_repository_url") && mcp_source.include?("repository_output_target_unsafe_repository_url")
errors << "isSafeGitRemoteUrl must reject remote-helper and ext/fd transports" unless agent_gateway_source.include?("value.startsWith(\"ext:\")") && agent_gateway_source.include?("/^[a-z0-9+.-]*::/iu")
errors << "Hosted deployments must be able to forbid local git remotes" unless server_source.include?("AIMAC_ALLOW_LOCAL_GIT_REMOTE") && server_source.include?("repository_output_target_local_git_remote_disabled")
errors << "MCP progress/capacity reads must be scoped by the principal project filter" unless mcp_source.include?("progressGet(state, args, \"project\", principalProjectFilter(context))") && mcp_source.include?("capacitySnapshot(state, principalProjectFilter(context))")
errors << "Blocked cells must not be auto-resumed with fabricated evidence" unless core_source.include?("awaiting_dependency") && core_source.include?("awaiting_decision") && core_source.include?("dependsOnWorkItemRefs || []).filter") && contract_check_source.include?("blocked_dependency hold")
errors << "Task contracts of active dispatches must not be evicted" unless core_source.include?("capTaskContracts") && contract_check_source.include?("capTaskContracts")
errors << "buildTaskContract must be idempotent against an existing active dispatch" unless core_source.include?("Idempotency guard: if a non-terminal dispatch already exists") && contract_check_source.include?("buildTaskContract idempotency")
errors << "close-barrier all_commands_terminal must match the exact task-group subject" unless core_source.include?("command.subject === `TaskGroup:${taskGroupId}`")
errors << "Postgres central+shards read must be transactionally consistent" unless pg_pool_worker_source.include?("readStateWithShards") && pg_pool_worker_source.include?("ISOLATION LEVEL REPEATABLE READ") && pg_sync_store_source.include?("pgReadStateWithShards") && state_store_source.include?("pgReadStateWithShards()")
app_js_source = File.read(File.join(ROOT, "apps/control-plane-ui/public/app.js"))
i18n_zh_source = File.read(File.join(ROOT, "apps/control-plane-ui/public/i18n-zh.js"))
# The zh dictionary must not contain duplicate keys — JS last-wins would silently shadow the intended
# value (a recurring defect this cycle when appending gate/objectType keys). Guard durably.
i18n_dup_keys = i18n_zh_source.scan(/^\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:/).flatten.tally.select { |_k, count| count > 1 }.keys
errors << "zh i18n dictionary has duplicate keys: #{i18n_dup_keys.join(', ')}" unless i18n_dup_keys.empty?
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
errors << "shared_definition_not_active must not break the admission scan (global scheduling)" unless core_source.include?("Always `continue` (never `break`, even in single mode): a cell blocked on an inactive shared")
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
errors << "contract-check schema validator must support conditional keywords" unless contract_check_source.include?("function schemaMatches") && contract_check_source.include?("resolveInternalRef") && contract_check_source.include?("schema.patternProperties")
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
errors << "schema validator must error on an unresolved local $ref and bound recursion" unless contract_check_source.include?("unresolved local $ref") && contract_check_source.include?("$ref recursion too deep")
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
errors << "reviewBundleRegister must create a modeled (submitted) bundle, not the unmodeled 'registered'" unless core_source.include?("\"submitted\" is a MODELED ReviewBundle state")
errors << "review_result_consume must terminalize the referenced review bundle" unless mcp_source.include?("state.reviewBundles || []).find((item) => item.reviewBundleId === args.reviewBundleId)") && contract_check_source.include?("reviewResultConsume: submitted bundle not terminalized")
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
errors << "定稿后必须有分歧拦截（human_finalized_decision_diverged）" unless core_source.include?("export function assertHumanFinalization") && core_source.include?("human_finalized_decision_diverged")
# 7. 上述语义必须有行为测试覆盖（否则回归时门仍绿）。
errors << "人工定稿闸门需要行为测试覆盖" unless contract_check_source.include?("人工闸门: 机器主体（service_account）竟然可以定稿核心决策") && contract_check_source.include?("人工闸门: AI 再分析竟然终结了决策") && contract_check_source.include?("人工闸门: AI 互审仍然直接把工作项标记为 verified")
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
errors << "persist-layer shard cap must retain open barrier items (shardOpenPredicates)" unless state_store_source.include?("const shardOpenPredicates") && state_store_source.include?("const open = sorted.filter(isOpen)") && ["workSessions", "humanConfirmationRequests", "humanDirectives", "repositoryOutputs", "effectiveInstructionPackets", "checkpoints", "agentDispatches", "roleDriftGuards"].all? { |c| state_store_source.include?("#{c}:") }
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
errors << "effective-instruction packet must carry the resolved effective-rules digest" unless core_source.include?("const effectiveRulesDigest = digestOf") && core_source.include?("effectiveRulesDigest: contract.effectiveRulesDigest")
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
errors << "Room send must scope authorization and routing from the path room only" unless server_source.include?("room_task_group_mismatch") && server_source.include?("roomSend(state, {...body, roomId, taskGroupId: roomTaskGroupId})")
errors << "close-barrier must not trust a stale-version cached readiness" unless core_source.include?("cachedReadiness.stateVersion === state.stateVersion") && contract_check_source.include?("stale readiness")
errors << "Human directives must be consumed oldest-first" unless core_source.include?("status === \"queued\").reverse()") && contract_check_source.include?("directive FIFO")
# 2026-07-27 MGP core-init absorption: global intelligent judgment over mechanical/redundant/useless gates.
errors << "Transitions must enforce state/actor legality but not ceremonial evidence tokens" unless transition_engine_source.include?("spec integrity: every required gate id must be modeled") && !transition_engine_source.include?("requires_evidence_missing") && transition_engine_source.include?("gate.unresolved")
errors << "dispatchWorkItem must not fabricate per-gate transition evidence" unless core_source.include?("no ceremonial evidence") && !core_source.include?("redispatch:")
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

fail_with(errors)

puts "spec validation ok"
