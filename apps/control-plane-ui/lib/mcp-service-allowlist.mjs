// MCP 服务令牌能用哪些工具 —— 只有这一处真相源。
// 此前白名单与过滤规则长在 server.mjs 里，而 npm run init 打印给运维的那句
// "默认放行 46 个工具" 是【写死的字面量】：46 是过滤前的条数，真实放行的是 44
// （两个被 forbiddenMcpServiceTool 拿掉了）。远程客户端一跑 tools/list 就与提示对不上。
// 数字要由代码算出来，不能写在话里。
export const defaultMcpServiceToolAllowlist = [
  "orchestration-mcp.state_get",
  "room-mcp.room_join",
  "room-mcp.room_send",
  "room-mcp.room_wait",
  "room-mcp.room_ack",
  "agent-control-mcp.node_probe",
  "agent-control-mcp.dispatch_status",
  "scheduler-mcp.model_select",
  "scheduler-mcp.session_place",
  "scheduler-mcp.capacity_snapshot",
  "scheduler-mcp.execution_topology_plan",
  "scheduler-mcp.execution_topology_advance",
  "scheduler-mcp.derived_task_classify",
  "resource-mcp.lease_claim",
  "resource-mcp.lease_release",
  "resource-mcp.resource_snapshot",
  "model-mcp.model_capabilities",
  "model-mcp.model_policy_get",
  "model-mcp.model_select",
  "skill-mcp.skill_source_sync",
  "skill-mcp.role_skill_parse",
  "skill-mcp.role_skill_overlay_validate",
  "skill-mcp.role_skill_resolve",
  "evidence-mcp.artifact_register",
  "evidence-mcp.test_result_submit",
  "permission-mcp.permission_probe",
  "permission-mcp.permission_request_submit",
  "permission-mcp.permission_status",
  "review-mcp.review_plan_create",
  "review-mcp.review_bundle_register",
  "review-mcp.review_result_consume",
  "review-mcp.completion_readiness_compute",
  "definition-mcp.shared_definition_create",
  "definition-mcp.shared_definition_publish",
  "definition-mcp.shared_definition_consumer_bind",
  "definition-mcp.shared_definition_conflict_report",
  "instruction-mcp.cache_key_index",
  "instruction-mcp.stable_prefix_get",
  "instruction-mcp.delta_payload_compact",
  "repository-mcp.repository_output_target_select",
  "repository-mcp.repository_target_lease_bind",
  "repository-mcp.artifact_manifest_index",
  "ui-console-mcp.runtime_health_get",
  "ui-console-mcp.management_surface_get",
  "ui-console-mcp.project_progress_get",
  "ui-console-mcp.task_group_progress_get"
];

// 运维配了什么、实际生效了什么，两者不一致时必须说出来。实测原先的行为：
// 配 3 个（1 个拼错、1 个在禁令表里）→ 放行 2 个，一声不吭；
// 而拼错的那个还【被当成有效工具放行了】—— 白名单从不核对工具是否存在。
// 两种都要说：被禁令拿掉的（配了也不会生效）、名字不存在的（多半是拼错，配了等于没配）。
let lastServiceAllowlistNotice = "";

export function mcpServiceAllowlistNotice() {
  return lastServiceAllowlistNotice;
}

export function mcpServiceAllowedTools(knownToolNames = null) {
  const configured = String(process.env.AIMAC_MCP_SERVICE_ALLOWED_TOOLS || "").split(",").map((item) => item.trim()).filter(Boolean);
  const tools = configured.length ? configured : defaultMcpServiceToolAllowlist;
  const allowed = tools.filter((tool) => !forbiddenMcpServiceTool(tool));
  if (configured.length) {
    const blocked = configured.filter((tool) => forbiddenMcpServiceTool(tool));
    const unknown = knownToolNames
      ? allowed.filter((tool) => !knownToolNames.includes(tool)) : [];
    const parts = [];
    if (blocked.length) parts.push(`${blocked.join("、")} 在禁令表里，配了也不会生效`);
    if (unknown.length) parts.push(`${unknown.join("、")} 不是任何一个工具的名字（多半拼错了），配了等于没配`);
    lastServiceAllowlistNotice = parts.length
      ? `AIMAC_MCP_SERVICE_ALLOWED_TOOLS 配了 ${configured.length} 个、实际放行 ${allowed.length} 个：${parts.join("；")}`
      : "";
  } else {
    lastServiceAllowlistNotice = "";
  }
  return allowed;
}

export function forbiddenMcpServiceTool(tool) {
  return tool === "*" ||
    tool === "evidence-mcp.checkpoint_submit" ||
    tool.startsWith("identity-mcp.") ||
    tool.startsWith("governance-mcp.") ||
    // 角色规则（"你是谁、职责边界、禁区"）是三类规则之一。skill_source_sync 会整体替换
    // state.roleSkills（改掉所有 agent 收到的 SKILL.md 正文），role_skill_overlay_validate
    // 直接创建 status:"active" 的 overlay 并立刻被下一次 buildTaskContract 选中。
    // 两者原先都对 MCP 服务令牌开放，且都不是真人专属 —— 规则层被改了，而人工闸门在旁边看着。
    // runtimeMutationPolicy 里那条 auto_publish_role_skill_overlay 是【声明了但从没有人执行】的禁令。
    tool === "skill-mcp.skill_source_sync" ||
    tool === "skill-mcp.role_skill_overlay_validate" ||
    // 真人专属动作的 MCP 孪生：批准权限请求。决策点上已经挡了机器主体，这里同时关掉配置面，
    // 免得运维以为"配上就能用"而实际收到一串拒绝。
    tool === "permission-mcp.permission_resolve" ||
    (tool.startsWith("orchestration-mcp.") && tool !== "orchestration-mcp.state_get");
}
