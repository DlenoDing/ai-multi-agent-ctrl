(function () {
  "use strict";

  const WORK_ITEM_OWNER_ROLE_CHOICES = ["orchestrator", "agent-runtime", "reviewer", "qa", "security", "release", "monitor"];
  const DEFAULT_ORGANIZATION_ID = "org_default";
  const organizationOf = (record) => String(record?.organizationId || DEFAULT_ORGANIZATION_ID);

  const MEMBER_PERMISSION_OPTIONS = [
    ["project:create", "允许创建项目"]
  ];

  const PERMISSION_LABELS = {
    ...Object.fromEntries(MEMBER_PERMISSION_OPTIONS),
    "project:view": "查看项目",
    "project:grant": "项目授权管理",
    "member:invite": "邀请成员",
    "agent:activate": "智能体管理",
    "project:update": "编辑项目",
    "project:create": "创建项目",
    "project:*": "项目全部权限",
    "task_group:orchestrate": "任务组编排调度",
    "task_group:checkpoint_submit": "提交检查点",
    "task_group:*": "任务组全部权限",
    "org:member_admin": "组织成员管理",
    "org:project_admin": "组织项目管理",
    "org:*": "组织全部权限",
    "task_group:read": "查看任务组",
    "task_group:control": "任务组执行控制",
    "task_group:review": "任务组人工审核",
    "task_group:monitor": "任务组执行监控",
    "system:account_admin": "系统账号管理",
    "system:bootstrap": "系统初始化",
    "system:model_registry": "模型能力注册",
    "system:skill_sync": "技能源同步",
    "system:*": "系统全部权限"
  };

  const RESOURCE_TYPE_LABELS = {
    project: "项目", task_group: "任务组", organization: "组织", system: "系统",
    system_console: "系统控制台", user_console: "用户控制台", system_policy: "系统策略",
    agent: "智能体", shared_definition: "共享定义", environment: "环境", state: "运行态",
    mcp_server: "MCP 服务", mcp_tool: "MCP 工具",
    git_repo: "Git 仓库", git_worktree: "Git 工作树",
    file_path: "文件路径", dir_path: "目录路径", artifact_path: "产物路径",
    db_schema: "数据库 schema", db_table: "数据库表"
  };

  const LANGUAGE_OPTIONS = [
    ["zh-CN", "中文"],
    ["en", "English"],
    ["ja", "日本語"],
    ["fr", "Français"],
    ["de", "Deutsch"],
    ["es", "Español"]
  ];

  const RULE_LIMITS = {title: 256, content: 8192};

  const COLLECTION_LABELS = {
    agentTaskContracts: "任务契约", effectiveInstructionPackets: "生效指令包",
    roleDriftGuards: "角色漂移守卫", completionReadiness: "完成就绪度",
    progressSnapshots: "进度快照", runtimeIssueSamples: "运行问题样本",
    runtimeIssuePatterns: "运行问题模式", transitionEvidence: "状态转移证据",
    instructionMetrics: "指令度量", modelSelectionPolicies: "模型选型策略",
    accessGrants: "访问授权", accounts: "账号", admissionDecisions: "准入判决", agentControlCommands: "控制指令",
    agentDispatches: "派发", agentExecutionEvents: "执行事件", agentJoinTokens: "加入令牌",
    agentRuntimeNodes: "agent 节点", agents: "编排智能体", approvalRequests: "审批请求", auditLog: "审计台账",
    artifacts: "产物", checkpoints: "检查点", closeBarriers: "关闭屏障", executionTopologies: "执行拓扑", findings: "评审发现",
    humanConfirmationRequests: "人工确认", humanDirectives: "人工指令", modelCapabilities: "模型能力",
    modelSelectionDecisions: "模型选择", organizations: "组织", permissionRequests: "授权请求", projects: "项目",
    qualityGates: "质量门", repositoryOutputs: "仓库产出", reviewBundles: "评审包", reviewPlans: "评审计划",
    roleSkillOverlays: "角色技能叠加", roleSkills: "角色技能", ruleSourceResolutions: "规则来源",
    sessionPlacementDecisions: "会话放置", sharedDefinitions: "共享定义", skillSources: "技能源",
    systemUpgradeCandidates: "升级候选", taskGroups: "任务组", testResults: "测试结果", dlqEntries: "死信队列",
    workSessions: "工作会话", workerLanes: "载体"
  };

  window.AIMAC_CONSOLE_UI_CONFIG = {
    WORK_ITEM_OWNER_ROLE_CHOICES,
    DEFAULT_ORGANIZATION_ID,
    organizationOf,
    MEMBER_PERMISSION_OPTIONS,
    PERMISSION_LABELS,
    RESOURCE_TYPE_LABELS,
    LANGUAGE_OPTIONS,
    RULE_LIMITS,
    COLLECTION_LABELS
  };
})();
