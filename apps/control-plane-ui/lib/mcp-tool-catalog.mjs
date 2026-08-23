// MCP 工具目录。控制台的「运行参数」里要显示工具数，而 core 不能 import mcp-server
// （mcp-server 反过来 import core，会成环）—— 于是那个数此前是【手写的一个常量 81】，
// 而清单里实际是 85：运维 CLI（register-mcp-client）按清单算，屏幕上给人看的那个数少了 4。
// 同一个数两处各算一遍，必然分叉。目录收在这个叶子模块里，两侧都从这里取。
export const mcpToolGroups = {
  "orchestration-mcp": ["project_create", "task_group_create", "work_item_create", "work_assign", "orchestrator_run", "state_get"],
  "room-mcp": ["room_join", "room_send", "room_wait", "room_ack"],
  "agent-control-mcp": ["node_register", "node_probe", "session_start", "session_pause", "session_cancel", "session_recover", "dispatch_status"],
  "scheduler-mcp": ["model_select", "session_place", "work_assign", "capacity_snapshot", "execution_topology_plan", "execution_topology_advance", "derived_task_classify"],
  "resource-mcp": ["lease_claim", "lease_release", "resource_snapshot"],
  "model-mcp": ["model_capabilities", "model_policy_get", "model_select"],
  "skill-mcp": ["skill_source_sync", "role_skill_parse", "role_skill_overlay_validate", "role_skill_resolve"],
  "evidence-mcp": ["artifact_register", "checkpoint_submit", "test_result_submit"],
  "permission-mcp": ["permission_probe", "permission_request_submit", "permission_status", "permission_resolve"],
  "human-review-mcp": ["confirmation_request_submit", "confirmation_status", "confirmation_consume", "confirmation_analyze", "confirmation_decide"],
  "review-mcp": ["review_plan_create", "review_bundle_register", "review_result_consume", "completion_readiness_compute"],
  "governance-mcp": [
    "approval_request_create",
    "approval_resolve",
    "policy_decision_eval",
    "finding_submit",
    "finding_resolve",
    "contract_publish",
    "effective_instruction_create",
    "role_drift_guard_bind",
    "role_drift_rebound",
    "rule_source_resolve",
    "runtime_issue_pattern_submit",
    "system_upgrade_candidate_export",
    "system_upgrade_external_import",
    "close_barrier_compute"
  ],
  "identity-mcp": ["account_invite", "account_suspend", "grant_create", "grant_revoke", "permission_matrix_get"],
  "ui-console-mcp": ["runtime_health_get", "management_surface_get", "project_progress_get", "task_group_progress_get", "guarded_action_dispatch"],
  "definition-mcp": ["shared_definition_create", "shared_definition_publish", "shared_definition_consumer_bind", "shared_definition_conflict_report"],
  "instruction-mcp": ["instruction_envelope_create", "cache_key_index", "stable_prefix_get", "delta_payload_compact"],
  "repository-mcp": ["repository_output_target_select", "repository_target_lease_bind", "artifact_manifest_index"]
};

export const mcpToolNames = Object.entries(mcpToolGroups).flatMap(([serverId, tools]) => tools.map((tool) => `${serverId}.${tool}`));
