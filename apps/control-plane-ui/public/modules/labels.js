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

  // ---- 内部键 → 人话（用户要求：界面上不出现内部 key）----
  // 能力标记（角色 Skill 的 capabilities / 定制里的允许·禁止能力）
  const CAPABILITY_LABELS = {
    planning: "规划", architecture: "架构设计", deep_reasoning: "深度推理", long_context: "长上下文", tool_use: "工具调用",
    review: "评审", fast_execution: "快速执行", cost_aware: "成本敏感", quota_aware: "额度敏感", coding: "编码",
    security: "安全", qa: "质量保障", data_analysis: "数据分析", creative: "创意", writing: "写作", translation: "翻译",
    repo_read: "读仓库", repo_write: "写仓库", playwright_check: "浏览器检查", schema_change: "改数据结构", public_api_change: "改公开接口",
    shell_exec: "执行命令", network_access: "访问网络", secrets_access: "读取密钥"
  };
  const SKILL_CATEGORY_LABELS = {control: "控制", review: "评审", quality: "质量", security: "安全", release: "发布", monitor: "监控",
    runtime: "运行时", policy: "策略", ui: "界面", engineering: "工程", design: "设计", marketing: "市场", product: "产品", testing: "测试", data: "数据"};
  const SKILL_SOURCE_LABELS = {"system-default": "系统内置", "agency-agents-zh": "中文智能体技能库"};
  // 供应商 id → 显示名
  const PROVIDER_LABELS = {openai: "OpenAI", anthropic: "Anthropic", google: "Google", xai: "xAI", meta: "Meta", mistral: "Mistral", deepseek: "DeepSeek",
    qwen: "通义千问", moonshot: "月之暗面", zhipu: "智谱", baidu: "百度", tencent: "腾讯", openrouter: "OpenRouter", azure_openai: "Azure OpenAI",
    aws_bedrock: "AWS Bedrock", vertex_ai: "Vertex AI", ollama: "Ollama", vllm: "vLLM", custom: "自定义"};
  const humanizeKey = (value) => String(value ?? "").replace(/[_-]+/gu, " ").trim();
  function capabilityLabel(value) { return CAPABILITY_LABELS[value] || t(value) !== String(value) && t(value) || humanizeKey(value); }
  function providerLabel(value) { return PROVIDER_LABELS[value] || t(value) !== String(value) && t(value) || String(value || "-"); }
  // 角色 Skill：system-<roleId> 是系统内置，按角色中文名显示；技能库里的按名字去掉连字符。
  function roleSkillLabel(skill = {}) {
    const id = String(skill.roleSkillId || skill || "");
    const system = /^system-(.+)$/u.exec(id);
    if (system) return `${t(system[1])}（系统内置技能）`;
    const name = skill.name && !/ system role skill$/u.test(skill.name) ? skill.name : id;
    const category = skill.category ? SKILL_CATEGORY_LABELS[skill.category] || skill.category : "";
    const source = skill.sourceId ? SKILL_SOURCE_LABELS[skill.sourceId] || skill.sourceId : "";
    return [humanizeKey(name), [category, source].filter(Boolean).join(" · ")].filter(Boolean).join(" · ");
  }
  // 任务契约里的规则件引用（terminal-execution-manifest:v1 这类）
  const RULE_REF_LABELS = {"terminal-execution-manifest": "终态执行清单", "state-machines": "状态机", "language-policy": "语言策略",
    "effective-ruleset": "生效规则集", "role-skill": "角色技能", "system-rules": "系统规则", "business-rules": "业务规则"};
  function contractRefLabel(ref) {
    const text = String(ref || "");
    const [head, ...rest] = text.split(":");
    const label = RULE_REF_LABELS[head];
    if (!label) return text;
    const tail = rest.join(":");
    return tail ? `${label}（${/^sha256/u.test(tail) ? tail.slice(0, 19) : tail}）` : label;
  }
  // 选型判断：core 的 shortModelDecision 拼的是一句英文（"modelDecision: bounded writeSet directed verification; no architecture裁决 -> openai:gpt-5.5 / medium"）。
  const WRITE_SET_LABELS = {fixed: "固定写入范围", bounded: "有界写入范围"};
  const WORK_KIND_LABELS = {"directed verification": "定向验证", "short mechanical task": "短机械任务", "analysis/cross-check": "分析与交叉核对", implementation: "实现"};
  const RISK_LABELS = {"P0 risk": "P0 风险", "decision risk": "涉及决策风险", "no architecture裁决": "无架构裁决"};
  function modelDecisionTextZh(text) {
    const raw = String(text || "").trim();
    if (!raw) return "未记录";
    const hit = /^modelDecision:\s*(fixed|bounded) writeSet (.+?); (P0 risk|decision risk|no architecture裁决) -> (\S+) \/ (\S+)$/u.exec(raw);
    if (!hit) return raw;
    return [WRITE_SET_LABELS[hit[1]], `任务类型：${WORK_KIND_LABELS[hit[2]] || hit[2]}`, `风险：${RISK_LABELS[hit[3]] || hit[3]}`,
      `模型：${hit[4]}`, `推理档：${REASONING_LEVEL_LABELS[hit[5]] || hit[5]}`].join(" · ");
  }
  // agent 运行时回送的事件摘要是英文定句：按句式翻成中文，参数（提交号、路径、数量）原样保留；
  // 像 "code:detail" 的失败原因走 explainCoded；认不出的原样显示。
  const STREAM_LABELS = {stdout: "标准输出", stderr: "标准错误"};
  const PERMISSION_STATUS_LABELS = {approved: "已批准", denied: "已拒绝", expired: "已过期", granted: "已授予"};
  const EVENT_SUMMARY_PATTERNS = [
    [/^Dispatch package received and binding verified\.$/u, () => "已接收派发包并核对绑定"],
    [/^Server-issued skill workset synchronized\.$/u, () => "已同步服务端下发的技能工作集"],
    [/^Execution content bundle synchronized and verified\.(.*)$/u, (m) => `已同步并核对执行内容包${m[1] ? `（${m[1].trim()}）` : ""}`],
    [/^Model executor started with (\d+) rule\/context file\(s\) in the prompt\.$/u, (m) => `执行器已启动，提示词含 ${m[1]} 份规则／上下文文件`],
    [/^(\w+) output received from model executor\.$/u, (m) => `收到执行器的${STREAM_LABELS[m[1]] || m[1]}`],
    [/^Model executor changed (\d+) repository paths?\.$/u, (m) => `执行器改动了 ${m[1]} 个仓库路径`],
    [/^Committed repository changes at ([0-9a-f]+)\.$/u, (m) => `已提交仓库改动 ${m[1].slice(0, 12)}`],
    [/^Pushed ([0-9a-f]+) to (\S+)\/refs\/heads\/(\S+)\.$/u, (m) => `已推送 ${m[1].slice(0, 12)} 到 ${m[2]}/${m[3]}`],
    [/^Checkpoint prepared for local outbox and control-plane ACK\.$/u, () => "检查点已准备，等待控制面确认"],
    [/^Checkpoint accepted by control plane\.$/u, () => "检查点已被控制面接受"],
    [/^Checkpoint replay accepted by control plane\.$/u, () => "重放的检查点已被控制面接受"],
    [/^Execution keep-alive heartbeat renews the dispatch claim\.$/u, () => "执行心跳已续租本次派发"],
    [/^No follow-up action remains\.$/u, () => "没有后续动作"],
    [/^Permission required: (\S+) for (\S+) on (.+)\.$/u, (m) => `需要授权：${capabilityLabel(m[2])}（${m[1]}）作用于 ${m[3]}`],
    [/^Permission (\w+); refreshing profile and retrying from (.+)\.$/u, (m) => `授权${PERMISSION_STATUS_LABELS[m[1]] || m[1]}，刷新档案后从 ${m[2]} 重试`],
    [/^Resumed from safe retry point after permission (\w+)\.$/u, (m) => `授权${PERMISSION_STATUS_LABELS[m[1]] || m[1]}后从安全重试点恢复`],
    [/^Permission scope reduced; re-reading work contract before resuming from (.+)\.$/u, (m) => `授权范围缩小，重读任务契约后从 ${m[1]} 恢复`],
    [/^External capability now available; re-probed and retrying from (.+)\.$/u, (m) => `外部能力已可用，重新探测后从 ${m[1]} 重试`]
  ];
  function agentEventSummaryZh(summary) {
    const text = String(summary || "").trim();
    if (!text) return "";
    for (const [pattern, render] of EVENT_SUMMARY_PATTERNS) {
      const hit = pattern.exec(text);
      if (hit) return render(hit);
    }
    if (/^[a-z][a-z0-9_]+:/u.test(text)) return explainCoded(text);
    return text;
  }

  function skillCategoryLabel(value) { return SKILL_CATEGORY_LABELS[value] || String(value || "其他"); }
  // 证据引用是 "种类:值" 的机器串（review-evidence:commit:<sha> / push:origin/refs/heads/main:<sha> / agent-node:<id>…）：
  // 种类翻成中文，值（提交号、节点 id、路径）原样保留并截短。
  const EVIDENCE_KIND_LABELS = {"agent-node": "节点", "skill-workset": "技能工作集", "content-bundle": "内容包", "remote-mcp": "远程 MCP",
    commit: "提交", push: "推送", "git-path": "改动路径", "git-diff": "差异", prompt: "提示词", checkpoint: "检查点", dispatch: "派发",
    session: "会话", run: "运行", "review-evidence": "评审证据", manifest: "产物清单", artifact: "产物", audit: "审计", decision: "决策记录"};
  function evidenceRefLabel(ref) {
    let text = String(ref || "");
    if (text.startsWith("review-evidence:")) text = text.slice("review-evidence:".length);
    const at = text.indexOf(":");
    const kind = at > 0 ? text.slice(0, at) : "";
    const rest = at > 0 ? text.slice(at + 1) : text;
    if (kind === "push") {
      const hit = /^(.+?)\/refs\/heads\/(.+?):([0-9a-f]{7,64})$/u.exec(rest);
      if (hit) return `推送 ${hit[1]}/${hit[2]} @ ${hit[3].slice(0, 12)}`;
    }
    if (kind === "commit" && /^[0-9a-f]{7,64}$/u.test(rest)) return `提交 ${rest.slice(0, 12)}`;
    const label = EVIDENCE_KIND_LABELS[kind];
    return label ? `${label} ${rest.slice(0, 48)}` : text.slice(0, 60);
  }

  global.AIMAC_CONSOLE_LABELS = {
    CAPABILITY_LABELS,
    PROVIDER_LABELS,
    skillCategoryLabel,
    evidenceRefLabel,
    capabilityLabel,
    providerLabel,
    roleSkillLabel,
    contractRefLabel,
    modelDecisionTextZh,
    agentEventSummaryZh,
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
