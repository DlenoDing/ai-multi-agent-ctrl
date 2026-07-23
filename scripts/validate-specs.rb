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
errors << "Dockerfile must install postgresql-client for docker compose state store" unless dockerfile.include?("postgresql-client")
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
project_event_store_source = File.read(File.join(ROOT, "apps/control-plane-ui/lib/project-event-store.mjs"))
doctor_source = File.read(File.join(ROOT, "scripts/doctor.mjs"))
mcp_source = File.read(File.join(ROOT, "apps/mcp-server/server.mjs"))
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
  "scheduler-mcp" => %w[model_select session_place work_assign capacity_snapshot execution_topology_plan derived_task_classify],
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
errors << "MCP room messages must be bounded, paginated and use persistent per-room sequence" unless mcp_source.include?("pruneRoomMessages") && mcp_source.include?("AIMAC_ROOM_MESSAGES_MAX_TOTAL") && mcp_source.include?("Math.min(500") && mcp_source.include?("roomSequenceByRoom")
errors << "MCP audit must rotate with unique locked files and mark conflict writes as failed" unless mcp_source.include?("rotateMcpAuditIfNeeded") && mcp_source.include?("AIMAC_MCP_AUDIT_MAX_BYTES") && mcp_source.include?("withMcpAuditLock") && mcp_source.include?("randomBytes(4)") && mcp_source.include?("conflict: true")
errors << "production MCP must not expose server-side agent execution" if mcp_source.include?("agent-control-mcp.runtime_run") || !mcp_doctor_source.include?("remote MCP still exposes server-side Agent execution")
errors << "MCP server must reject full state scope by default" unless mcp_source.include?("full_state_scope_not_allowed") && mcp_doctor_source.include?("state_get full scope was not denied")
errors << "MCP server must enforce unique active lease and fencing token" unless mcp_source.include?("lease_already_active") && mcp_source.include?("lease_fencing_token_mismatch") && mcp_doctor_source.include?("lease_claim allowed a second active holder")
errors << "MCP grant validation must require active leases for lease-bound tools" unless mcp_source.include?("active_mcp_lease_required") && mcp_source.include?("leaseRequiredForTool")
errors << "MCP grant validation must require fencing tokens for lease-bound tools" unless mcp_source.include?("mcp_lease_fencing_token_required")
errors << "MCP server must validate tool input schemas at call time" unless mcp_source.include?("validateInputArgs") && mcp_source.include?("mcp_input_unknown_property") && mcp_source.include?("mcp_required_argument_missing")
errors << "MCP repository target selection must reject non-git-trackable paths" unless mcp_source.include?("repository_output_target_must_use_git_trackable_paths") && mcp_source.include?("pathAllowlistValid")
errors << "MCP server must mark tool results untrusted" unless mcp_source.include?("untrustedResult")
errors << "HTTP server must use shared state-store" unless server_source.include?("readStoredState") && server_source.include?("writeStoredState")
errors << "HTTP health checks must avoid full project shard hydration" unless server_source.include?("readHealthState") && server_source.include?("readStoredCentralState")
errors << "MCP server must use shared state-store" unless mcp_source.include?("readStoredState") && mcp_source.include?("writeStoredState")
errors << "state-store must support PostgreSQL JSONB authority" unless state_store_source.include?("AIMAC_STATE_STORE") && state_store_source.include?("jsonb") && state_store_source.include?("psql")
errors << "state-store must enforce versioned write conflict detection" unless state_store_source.include?("expectedStateVersion") && state_store_source.include?("AIMAC_STATE_CONFLICT")
errors << "state-store must externalize project-scoped collections into project shards" unless state_store_source.include?("projectShardCollections") && state_store_source.include?("aimac_project_state_shards") && state_store_source.include?(".state.json")
errors << "project shard writes must be protected by the central state CAS" unless state_store_source.include?("writePostgresStateWithProjectShards") && state_store_source.include?("AIMAC_WRITE_CONFLICT") && state_store_source.index("assertExpectedVersion") && state_store_source.index("writeRuntimeJsonProjectShards") && state_store_source.index("assertExpectedVersion") < state_store_source.index("writeRuntimeJsonProjectShards")
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
errors << "UI and API must expose session-scoped execution events" unless server_source.include?("work-sessions") && server_source.include?("sessionEventsMatch") && server_source.include?("sessionId: session.sessionId") && public_app_source.include?("show-session-events")
errors << "Execution event project sequence must be assigned under the per-project append lock" unless project_event_store_source.include?("sequence: Number(index.lastSequence || 0) + 1") && contract_check_source.include?("append-order project sequences inside the project lock")
errors << "Execution event projection must append durable events before central projection and recover historical bindings" unless server_source.include?("prepareAgentExecutionEvent") && server_source.include?("appendProjectExecutionEvent(runtimeDir, prepared.event)") && server_source.include?("allowHistoricalNodeBinding") && server_source.include?("event_node_binding_mismatch")
errors << "Long polling must use write notifications instead of fixed interval synchronous polling" unless server_source.include?("waitForLongPollSignal") && server_source.include?("notifyLongPollWaiters") && !server_source.include?("await delay(250)")
errors << "Agent Gateway must issue server-managed skill worksets" unless agent_gateway_source.include?("agent-skill-workset/v1") && agent_gateway_source.include?("server_managed_on_demand") && agent_gateway_source.include?("Child roles MUST receive")
errors << "Agent Runtime must use remote MCP and on-demand skill worksets" unless agent_runtime_source.include?("AIMAC_MCP_URL") && agent_runtime_source.include?("syncSkillWorkset") && agent_runtime_source.include?("do not start or install any local MCP server")
errors << "Agent Runtime dispatch prompt must use compact DISPATCH v1 envelope" unless agent_runtime_source.include?("\"DISPATCH v1\"") && agent_runtime_source.include?("`model: ${model.model") && agent_runtime_source.include?("`reasoning: ${model.reasoning") && agent_runtime_source.include?("model.modelDecision")
errors << "Agent Runtime dispatch prompt must prefer locators over pasted long context" unless agent_runtime_source.include?("contract.inputLocators") && agent_runtime_source.include?("`package:${packagePath}`") && agent_runtime_source.include?("writeSet:")
errors << "Agent task contract schema must require explicit model/reasoning/modelDecision" unless load_json("spec/agent-task-contract.schema.json").dig("properties", "model", "required")&.include?("modelDecision")
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
