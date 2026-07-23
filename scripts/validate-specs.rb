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

fail_with(errors)

puts "spec validation ok"
