// 已【实测查明】当前不可达的第二道门：前面还有一道门先拒，所以编不出能走到它们的用例。
// 它们照样计入零覆盖（那是事实），登记在这里只为一件事：**别再有人花一轮去够它们**。
// 本仓已经为此查过三轮（checkpoint_submit 一轮、project_create 一轮、规则层那族两轮）。
//
// 这份登记必须【单独成文件】并被拒绝码棘轮排除在扫描面之外：登记不是判据 ——
// 写在被扫文件里的话，光是列出这些码就会把它们算成"已覆盖"（本仓第九次撞这个形状）。
//
// 留着这些守卫是对的：拦在它们前面的是【配置】（工具白名单），配置改一行它们就成了最后一道。
export const KNOWN_SECOND_DOORS = {
  agent_checkpoint_must_use_gateway:
    "checkpoint_submit 不在任何派发下发的工具白名单里，mcp_tool_not_granted_to_principal 先拒",
  mcp_project_create_requires_system_admin:
    "MCP 只认 agent_node / 系统管理员 / 服务令牌三种主体：前两者被工具白名单挡，后者本身就是管理员",
  rule_layer_mutation_forbidden_for_machine_principal:
    "skill-mcp.* 不在服务令牌工具表里，机器主体够不到这个决策点",
  contract_publish_forbidden_for_machine_principal:
    "同上，definition-mcp.shared_definition_publish 对机器主体不下发",
  permission_resolution_forbidden_for_machine_principal:
    "同上，permission-mcp.permission_resolve 对机器主体不下发",
  // 这三条守的是"受限主体必须自报作用域"。实测（2026-08-20，MCP e2e 里用真实受限节点令牌）：
  // 派发绑定的授权在进工具之前就把 dispatchId/projectId/taskGroupId/sessionId/runId 补齐了
  // （applyAgentGrantScopeArgs）—— 受限主体【补不出一个缺参数的调用】，走不到这三道。
  // 缺省在这里是靠"填上唯一正确的值"解决的，不是靠拒绝；那条自动补全另有断言与变异守着。
  room_id_required_for_bounded_principal:
    "派发绑定的授权会把省掉的 roomId 补成本派发自己的房间，受限主体造不出'不点名'的调用",
  scope_ref_required_for_bounded_principal: "同上，作用域参数由 applyAgentGrantScopeArgs 补齐",
  task_group_id_required_for_bounded_principal: "同上，taskGroupId 由 applyAgentGrantScopeArgs 补齐",
  idempotency_record_principal_unknown:
    "只有【本次主体绑定改动之前写下的】旧幂等记录才触发；新部署造不出这种记录，"
    + "而 e2e 只走 HTTP、碰不到状态内部（去改状态文件造它，夹具比守卫还脆）",
  mcp_principal_project_scope_unresolved:
    "给【将来新增的工具/参数】留的兜底（源码注释里明写着 defends future-added tools）："
    + "现有每个带资源地址的参数都推得出 projectId，走不到这一支",
  mcp_dispatch_bound_grant_required:
    "受限节点调没被授予的工具时，mcp_tool_not_granted_to_principal 先拒（工具白名单在授权检查之前）",
  project_id_required:
    "入参 schema 里 task_group_create 的 projectId 就是必填，"
    + "不给会先被 mcp_required_argument_missing 拒掉（e2e 里那条用例撞的正是它）",
  state_conflict_not_recovered:
    "要连撞三次 CAS 冲突才到（重试 3 次），而冲突由并发时序决定，编不出稳定用例；"
    + "并发写入门验的是'冲突会被正确识别并退回'那一层（state_write_conflict，已有断言与变异）",
  organization_required:
    "orgId 两条来路都不会为空：系统账号走 `searchParams || DEFAULT_ORGANIZATION_ID`（有兜底），"
    + "非系统账号取 account.organizationId，而账号一律带组织（系统管理员的是 null，但它走前一支）"
    + "——这一道是给'将来去掉那个兜底'留的最后一关",
  artifact_manifest_outside_allowlist:
    "要走到它，清单必须先【在 changedPaths 里】（artifact_manifest_not_changed_in_commit 那道），"
    + "而任何越出白名单的改动都会更早撞上 changed_paths_outside_repository_target_allowlist（整体校验）"
    + "——两道合起来把它围死了；留着是对的：整体校验一旦放宽，它就是最后一道",
  repository_output_target_refs_must_match_single_session_target:
    "角色漂移守卫把 repositoryOutputTargetRefs 当作用域校验、要求恰好是本会话那一个，"
    + "编造的 id 与别处真实的 id 都先被它拒成 role_drift_guard_not_clear（两种都实测过）",
  account_invite_forbidden_for_machine_principal:
    "同上，identity-mcp.* 整族按前缀对服务令牌禁用（MCP e2e 里有一条断言按规则全量核对这个前缀）"
};

// 工具名 → 它那道人工专属守卫的拒绝码。放在这个文件里是有意的：**拒绝码棘轮不扫本文件**，
// 所以 MCP e2e 可以按工具名查表，而不必把码的字面量写进门的源码 —— 写进去的话，
// 门就"读到了自己写的字"，这五条会被算成已覆盖（本仓第十次撞这个形状，这次是我自己撞的）。
export const HUMAN_ONLY_MCP_TOOL_REFUSALS = {
  "skill-mcp.skill_source_sync": "rule_layer_mutation_forbidden_for_machine_principal",
  "skill-mcp.role_skill_overlay_validate": "rule_layer_mutation_forbidden_for_machine_principal",
  "permission-mcp.permission_resolve": "permission_resolution_forbidden_for_machine_principal",
  "governance-mcp.contract_publish": "contract_publish_forbidden_for_machine_principal",
  "identity-mcp.account_invite": "account_invite_forbidden_for_machine_principal"
};
