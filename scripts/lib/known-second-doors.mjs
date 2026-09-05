// 已【实测查明】今天没有判据的拒绝码，两类：
//   (a) 不可达的第二道门 —— 前面还有一道门先拒，编不出能走到它们的用例；
//   (b) 够得着、但代价与收益不成比例 —— 这一类【必须写明代价是多少】，别拿它当筐。
// 下面每条都注明属于哪一类。
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
  // (a) 不可达的第二道门。2026-08-26 人定「AI 不许动谁能干什么」之后，MCP 侧这两个工具
  // 也收归真人。但 identity-mcp.* 整族本来就不在任何派发下发的工具白名单里 ——
  // 机器主体连门都进不来（mcp_tool_not_granted_to_principal 先拒），所以这两道是第二层。
  // 留着它们是对的：拦在前面的是【配置】，配置改一行它们就成了最后一道。
  // REST 那一侧（access_grant_create / access_grant_revoke）是够得着的，已有行为断言。
  grant_create_forbidden_for_machine_principal:
    "identity-mcp.* 不在派发下发的工具白名单里，mcp_tool_not_granted_to_principal 先拒",
  grant_revoke_forbidden_for_machine_principal:
    "同上；它与 grant_create 是同一件事的两面，一起收归真人",
  // 2026-08-27 补：同族里只有 account_suspend 一道门都没有（停一个账号会连带撤销它全部的
  // 会话与授权）。REST 侧的 org_member_status_update / account_retire 早就是真人专属，
  // 这条孪生一直缺 —— 只锁一边等于没锁。可达性与上面两条相同：工具白名单先拒。
  account_suspend_forbidden_for_machine_principal:
    "identity-mcp.* 不在派发下发的工具白名单里，mcp_tool_not_granted_to_principal 先拒",
  mcp_project_create_requires_system_admin:
    "MCP 只认 agent_node / 系统管理员 / 服务令牌三种主体：前两者被工具白名单挡，后者本身就是管理员",
  // 这三条守的是"受限主体必须自报作用域"。实测（2026-08-20，MCP e2e 里用真实受限节点令牌）：
  // 派发绑定的授权在进工具之前就把缺的 dispatchId/projectId/taskGroupId/sessionId/runId 填上了
  // （applyAgentGrantScopeArgs）—— 受限主体【补不出一个缺参数的调用】，走不到这三道。
  //
  // 2026-08-22 复核时把话说准：那一步是 `args.x || scope.x`，**调用方自己给的值优先**，
  // 不是"覆盖"。所以真正挡住"自报别人的项目"的不是它，而是【补齐之前】那道
  // grantMatchesArgs：它拿【原始参数】逐字段与授权比，对不上就 mcp_grant_scope_mismatch。
  // 两句话差别很大 —— 按"覆盖"去理解的话，会以为这里天然安全而不去看那道比对。
  room_id_required_for_bounded_principal:
    "派发绑定的授权会把省掉的 taskGroupId 补上（applyAgentGrantScopeArgs），boundedRoomGuard 再由 taskGroupId 推出"
    + " room_<taskGroupId> —— 受限主体因此造不出'既不点名 roomId 也没有 taskGroupId'的调用。"
    + "（2026-08-27 核过：登记原先写成'补 roomId'，函数里并没有这一行；承重的是 taskGroupId 那一步）",
  task_group_id_required_for_bounded_principal: "同上，缺的 taskGroupId 由 applyAgentGrantScopeArgs 填上",
  idempotency_record_principal_unknown:
    "只有【本次主体绑定改动之前写下的】旧幂等记录才触发；新部署造不出这种记录，"
    + "而 e2e 只走 HTTP、碰不到状态内部（去改状态文件造它，夹具比守卫还脆）",
  mcp_principal_project_scope_unresolved:
    "给【将来新增的工具/参数】留的 fail-closed 兜底（源码注释里明写着 defends future-added tools）。"
    + "2026-08-27 核过一次：地址键清单后加的六个键里有五个没跟上解析分支，受限主体只传 reviewPlanId 就会撞它 ——"
    + " 已补齐并立门（契约门按清单逐键喂样例）。现有每个键都能解析，所以今天仍走不到；将来加键忘了加解析，那道门先红",
  project_id_required:
    "入参 schema 里 task_group_create 的 projectId 就是必填，"
    + "不给会先被 mcp_required_argument_missing 拒掉（e2e 里那条用例撞的正是它）",
  project_invite_cannot_grant_system_account_or_permission:
    "恒为假：路由的 systemScopedInvite 用的就是同一个谓词 requestedSystemAccountInvite(body)，"
    + "为真时 normalizeInvitedAccount 已提前返回。真正拦住越权邀请的是按系统作用域判权那道"
    + "（doctor 里有 403 policy_denied 的断言）。留着它是为两处口径漂开的那天，"
    + "「必须共用同一个谓词」由 verifyInviteEscalationGuardsShareOnePredicate 钉着",
    agent_dispatch_requires_selected_model_decision:
    "(a) fail-closed 兜底：派发前的 contract.model 由 buildTaskContract 统一填齐"
    + "（modelId / modelDecision / modelSelectionDecisionRef 三个一起写入），"
    + "正常路径造不出缺字段的 contract；enqueueAgentDispatch 不导出，也不为测试去导它。"
    + "它守的是上游哪天漏填 —— 那时事后说不清「为什么用了这个模型」",
    agent_runtime_no_git_changes:
    "本地工作器每趟都会重写产出清单，而清单里带 createdAt —— 于是总有一个文件在变，"
    + "hasStaged 永远为真。产出内容一字未变时撞的是检查点那道 artifact_output_ref_not_changed_in_commit"
    + "（有断言与变异守着）。留着它是防清单变成确定性内容的那天",
    agent_runtime_executor_no_git_changes:
    "要走到它，执行器得【声明了产出、却一行都没改】—— 而那正好先撞 declared_unchanged_paths"
    + "（gitOutputPaths 里每一条都必须在 git 里真的变过）。那道报得更准：它能点出是哪个文件。"
    + "留着它是防将来两处判据分开的那天",
    agent_runtime_executor_manifest_outside_allowlist:
    "gitOutputPaths = changedPaths ∪ artifactManifestRefs，所以清单路径先在【产出】那个循环里被查到，"
    + "agent_runtime_executor_output_outside_allowlist 先拒（实测）。两道判据逐字相同，"
    + "留着它是防将来两个集合分开算的那天",
    execution_topology_requires_runner_and_isolation:
    "载体/隔离为 none 现在是资格检查阶段的阻塞项（2026-08-21 修正：原先只对多分支报，单分支方案会白定稿一场），"
    + "有阻塞项就不挂人工定稿单，start 先撞 execution_topology_requires_human_plan_confirmation；"
    + "先用合法载体走到定稿再改成 none 则先撞 human_finalized_decision_diverged。阻塞项那道有断言与变异守着",
    state_conflict_not_recovered:
    "要连撞三次 CAS 冲突才到（重试 3 次），而冲突由并发时序决定，编不出稳定用例；"
    + "并发写入门验的是'冲突会被正确识别并退回'那一层（state_write_conflict，已有断言与变异）",
  organization_required:
    "orgId 两条来路都不会为空：系统账号走 `searchParams || DEFAULT_ORGANIZATION_ID`（有兜底），"
    + "非系统账号取 account.organizationId，而账号一律带组织（系统管理员的是 null，但它走前一支）"
    + "——这一道是给'将来去掉那个兜底'留的最后一关",
  repository_output_target_refs_must_match_single_session_target:
    "角色漂移守卫把 repositoryOutputTargetRefs 当作用域校验、要求恰好是本会话那一个，"
    + "编造的 id 与别处真实的 id 都先被它拒成 role_drift_guard_not_clear（两种都实测过）",
};

// 工具名 → 它那道人工专属守卫的拒绝码。放在这个文件里是有意的：**拒绝码棘轮不扫本文件**，
// 所以 MCP e2e 可以按工具名查表，而不必把码的字面量写进门的源码 —— 写进去的话，
// 门就"读到了自己写的字"，这五条会被算成已覆盖（本仓第十次撞这个形状，这次是我自己撞的）。
export const HUMAN_ONLY_MCP_TOOL_REFUSALS = {
  "skill-mcp.skill_source_sync": "rule_layer_mutation_forbidden_for_machine_principal",
  "skill-mcp.role_skill_overlay_validate": "rule_layer_mutation_forbidden_for_machine_principal",
  "permission-mcp.permission_resolve": "permission_resolution_forbidden_for_machine_principal",
  "governance-mcp.contract_publish": "contract_publish_forbidden_for_machine_principal",
  "identity-mcp.account_invite": "account_invite_forbidden_for_machine_principal",
  // 定稿是整套"人工闸门"的最后一道：机器主体替人点了确认，AI 的方案就此获得人的背书。
  // 它与上面五条同族，却一直不在册 —— 而这个工具【三套 e2e 从没调过】（2026-08-22 按
  // MCP 工具清单全量核对时发现：85 个工具里 53 个没被调过，其中 21 个是写工具）。
  "human-review-mcp.confirmation_decide": "human_confirmation_decision_forbidden_for_machine_principal",
  // 2026-08-26 人定：AI 只负责把任务做完，不许动"谁能干什么"。REST 侧的
  // access_grant_create / access_grant_revoke 已收归真人专属，这两个是它们的 MCP 孪生。
  "identity-mcp.grant_create": "grant_create_forbidden_for_machine_principal",
  "identity-mcp.grant_revoke": "grant_revoke_forbidden_for_machine_principal",
  // 2026-08-27：同族里只有它一道门都没有（停一个账号会连带撤销它全部的会话与授权）。
  // 这张表是手写的，而手写的期望表本身就是错误来源 —— 现在由 contract-check 的
  // verifyMachinePrincipalRefusalsAreAllRegistered 从 mcp-server 的派发里全量提取来核它。
  "identity-mcp.account_suspend": "account_suspend_forbidden_for_machine_principal"
};
