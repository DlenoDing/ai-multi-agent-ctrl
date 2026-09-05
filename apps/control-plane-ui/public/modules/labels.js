/*
 * 控制台状态、角色、模型与执行类别中文标签。
 */
(function initLabels(global) {
  const i18n = global.AIMAC_CONSOLE_I18N_UTILS || {};
  const t = i18n.t || ((value) => String(value ?? "-"));
  const explainCoded = i18n.explainCoded || t;
  const esc = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

  const TONE_GREEN = new Set(["completed", "verified", "ok", "active", "online", "passed", "succeeded", "accepted", "applied", "answered", "consumed", "satisfied", "clear", "healthy", "available", "pushed", "committed", "merged", "full", "current", "resolved", "admitted", "acked", "indexed", "review_passed", "completed_objective", "closed", "fixed", "reverified", "code_complete", "corrected", "verification_ready"]);
  const TONE_BLUE = new Set(["running", "in_progress", "queued", "assigned", "delivered", "monitoring", "syncing", "starting", "development", "evaluating", "collecting", "dispatched", "ready", "selected", "acknowledged", "received", "intake", "discovery", "product_design", "solution_design", "ui_design", "global_development_review", "verification", "repair", "reverification", "integration", "release", "online_quality", "implementation", "governance_design", "protocol", "cache_indexed", "initialized", "configured", "prepared", "submitted", "new_session", "subagent", "issued", "bound", "planned", "integrating", "checkpointed", "checkpoint_submitted", "created", "executor_started", "executor_output", "git_committed", "git_pushed", "repository_changed", "skill_synced", "dispatch_received", "heartbeat", "progress", "writing", "lease_bound"]);
  const TONE_ORANGE = new Set(["attention", "pending", "review_requested", "paused", "draining", "degraded", "limited", "invited", "waiting_room_event", "waiting_dependency", "permission_required", "needs_decision", "stale_state", "reverify_required", "standby", "active_paused_by_control", "change_requested", "reopened", "requested", "reviewing", "candidate", "drift_signal", "monitor_attention", "needs_reconcile", "quota_limited", "awaiting_human_confirmation", "read_only", "close_candidate", "waived", "proposed", "conflicted", "change_requested", "discovered"]);
  const TONE_RED = new Set(["failed", "blocked", "rejected", "denied", "error", "aborted", "quarantined", "quarantine", "dlq", "correction_required", "drift_detected", "timed_out", "unavailable", "blocked_dependency", "blocked_resource", "conflicted", "merge_conflict", "rolled_back", "invalidated", "S0", "critical"]);

  TONE_ORANGE.add("S1").add("major");
  TONE_BLUE.add("S2").add("normal");
  TONE_GREEN.add("S3");

  function toneOf(value) {
    const key = String(value ?? "");
    if (TONE_GREEN.has(key)) return "green";
    if (TONE_BLUE.has(key)) return "blue";
    if (TONE_ORANGE.has(key)) return "orange";
    if (TONE_RED.has(key)) return "red";
    return "gray";
  }

  const GRANT_ROLE_LABELS = {
    project_owner: "项目负责人",
    project_admin: "项目管理员",
    task_group_owner: "任务组负责人",
    reviewer: "评审人",
    agent_operator: "智能体操作员",
    viewer: "观察者",
    project_member: "项目成员"
  };

  function grantRoleLabel(role) {
    return GRANT_ROLE_LABELS[role] || t(role);
  }

  const STATUS_LABEL_BY_KIND = {
    organization: {active: "启用中", suspended: "已停用", disabled: "已停用"},
    account: {active: "已启用", suspended: "已停用", disabled: "已停用", invited: "待接受邀请",
      retired: "已注销（不可恢复）"},
    grant: {active: "生效中", revoked: "已撤销", expired: "已过期"},
    agent: {active: "已启用", disabled: "已停用", retired: "已退役"},
    skillSource: {active: "已启用", retired: "已退役"},
    joinToken: {issued: "已签发", consumed: "已使用（一次性票已用掉）", expired: "已过期", revoked: "已撤销"}
  };

  function badge(value, tone) {
    if (value === null || value === undefined || value === "") return `<span class="badge gray">-</span>`;
    return `<span class="badge ${tone || toneOf(value)}">${esc(t(value))}</span>`;
  }

  function customBadge(label, tone) {
    return `<span class="badge ${tone}">${esc(label)}</span>`;
  }

  function statusBadge(kind, value, tone) {
    const label = STATUS_LABEL_BY_KIND[kind]?.[value];
    return label ? customBadge(label, tone || toneOf(value)) : badge(value, tone);
  }

  function kindLabel(k) {
    const key = `kind_${k}`;
    const mapped = t(key);
    return mapped === key ? String(k) : mapped;
  }

  const STRENGTH_LABELS = {
    planning: "规划", architecture: "架构", deep_reasoning: "深度推理", long_context: "长上下文",
    fast_execution: "快速执行", coding: "编码", review: "评审", security: "安全", qa: "质量保障",
    math: "数学", data_analysis: "数据分析", multimodal: "多模态", low_cost: "低成本",
    local_private: "本地私有", translation: "翻译", writing: "写作", reasoning: "推理", vision: "视觉"
  };

  function strengthLabel(code) {
    return STRENGTH_LABELS[String(code || "")] || t(code);
  }

  const EXECUTION_PROFILE_LABELS = {production: "生产档位", verification: "验证档位"};
  function executionProfileLabel(code) {
    return EXECUTION_PROFILE_LABELS[String(code || "")] || t(code);
  }

  const TASK_EXECUTION_CLASS_LABELS = {verification: "定向验证", short_execution: "短机械任务", deep_analysis: "深度分析", implementation: "实现", mixed_analysis_implementation: "分析并实现"};
  const REASONING_LEVEL_LABELS = {high: "高", medium: "中", standard: "标准", low: "低", minimal: "最简"};
  const LANE_FUNCTION_LABELS = {...TASK_EXECUTION_CLASS_LABELS, general_execution: "通用执行", review: "评审", analysis: "分析", short_execution: "短机械任务", implementation: "实现"};
  const WHY_THIS_CELL_LABELS = {
    executable_cell_admitted_this_cycle: "本周期准入执行",
    cell_awaiting_independent_review: "等待独立评审",
    cell_needs_external_decision: "需人工决策处置",
    cell_already_executing: "已在执行中",
    cell_split_into_analysis_and_implementation: "已拆分为分析与实现",
    no_model_satisfies_hard_constraints: "无模型满足硬约束",
    selected_agent_role_skill_cannot_be_resolved: "选中的 Agent 角色 Skill 无法解析",
    role_drift_guard_intercepted_dispatch: "角色偏移守卫拦截派发",
    cell_deferred_condition_window: "等待条件窗口（按环境独立延后）",
    cell_waiting_for_wip_capacity: "等在制品额度",
    cell_yielding_to_higher_priority: "让路给更高优先级的单元",
    cell_held_for_human_confirmation: "等你在确认卡上定稿",
    cell_held_for_human_plan_confirmation: "等你为拆分方案定稿",
    cell_processing_error: "处理这个单元时出错（详见运行时问题）"
  };

  function admissionReasonLabel(decision) {
    const why = decision.whyThisCellNow;
    if (why && WHY_THIS_CELL_LABELS[why]) return WHY_THIS_CELL_LABELS[why];
    if (decision.reasonCode) {
      const localized = t(decision.reasonCode);
      if (localized && localized !== decision.reasonCode) return localized;
    }
    return why || decision.reasonCode || "-";
  }

  function laneFunctionLabel(value) {
    return value ? (LANE_FUNCTION_LABELS[value] || value) : "-";
  }

  function modelDecisionSummaryZh(decision) {
    const parts = [];
    if (decision.taskExecutionClass) parts.push(`任务类型：${TASK_EXECUTION_CLASS_LABELS[decision.taskExecutionClass] || decision.taskExecutionClass}`);
    const model = decision.selectedModel?.modelId;
    if (model) parts.push(`选定模型：${model}`);
    const reasoning = decision.selectedModel?.reasoningLevel || decision.reasoningLevel;
    if (reasoning) parts.push(`推理档：${REASONING_LEVEL_LABELS[reasoning] || reasoning}`);
    if (decision.denialReason) {
      parts.push(`未选出模型：${explainCoded(decision.denialReason)}`);
      if (decision.fallbackPolicyRef) parts.push(`按策略 ${decision.fallbackPolicyRef} 的硬约束`);
    }
    return parts.length ? parts.join(" · ") : t(decision.selectionMode);
  }

  global.AIMAC_CONSOLE_LABELS = {
    TONE_GREEN,
    TONE_BLUE,
    TONE_ORANGE,
    TONE_RED,
    GRANT_ROLE_LABELS,
    STATUS_LABEL_BY_KIND,
    STRENGTH_LABELS,
    EXECUTION_PROFILE_LABELS,
    TASK_EXECUTION_CLASS_LABELS,
    REASONING_LEVEL_LABELS,
    LANE_FUNCTION_LABELS,
    WHY_THIS_CELL_LABELS,
    toneOf,
    grantRoleLabel,
    statusBadge,
    badge,
    customBadge,
    kindLabel,
    strengthLabel,
    executionProfileLabel,
    admissionReasonLabel,
    laneFunctionLabel,
    modelDecisionSummaryZh
  };
})(window);
