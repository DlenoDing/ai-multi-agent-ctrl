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
  account_invite_forbidden_for_machine_principal:
    "同上，identity-mcp.* 整族按前缀对服务令牌禁用（MCP e2e 里有一条断言按规则全量核对这个前缀）"
};
