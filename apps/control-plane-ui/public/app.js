/*
 * 面向人的全中文管理后台（human-org-console/v1 §6）
 * 三视角：系统管理员 / 组织管理员 / 组织成员。
 * 所有内部枚举展示一律经过 i18n-zh.js 提供的 t() 渲染。
 */

const I18N = window.AIMAC_I18N || {t: (value) => String(value ?? "-")};
const t = (value) => I18N.t(value);

const app = document.querySelector("#app");

/* ---------------- 会话与全局状态 ---------------- */

let authToken = sessionStorage.getItem("aimac.sessionToken") || "";
let currentAccount = JSON.parse(sessionStorage.getItem("aimac.account") || "null");
let page = sessionStorage.getItem("aimac.page") || "";
let currentProjectId = sessionStorage.getItem("aimac.projectId") || "";

let state = emptyState();
let systemOverview = null;
let organizations = [];
let orgAgentNodes = [];
let orgMembers = [];
let projConfig = null;
let instructionState = null;
let loginHint = null;

let lastError = "";
let lastLoadErrorToast = "";
let loading = false;
let formTouched = false;
// Which forms have unsaved edits. Submitting one form triggers a full loadPage() rebuild that discards
// OTHER dirty forms on the same page; this set lets the submit handler warn before that loss. The key
// includes data-category because two rule editors (system/business) on a page share the same data-form.
const dirtyFormKinds = new Set();
function formDirtyKey(formEl) {
  return `${formEl?.dataset?.form || ""}:${formEl?.dataset?.category || ""}`;
}
let modalHtml = "";
let modalProtected = false;

let expandedTaskGroupId = "";
let tgDetail = null;

let reviewRequests = [];
let directiveTaskGroupId = "";
let directiveList = [];
let pendingConfirmCount = 0;

let agentViewMode = "table";

let execScope = {type: "", id: ""};
let execEvents = [];
let execCursor = 0;
let execTimer = null;

/* ---------------- 视角与菜单 ---------------- */

const PROJECT_PAGES = new Set(["proj-overview", "tg", "review", "directives", "monitor", "proj-settings"]);

const PROJECT_MENU_TAIL = [
  {id: "proj-overview", label: "项目概览"},
  {id: "tg", label: "任务组"},
  {id: "review", label: "人工审核"},
  {id: "directives", label: "人工指令"},
  {id: "monitor", label: "执行监控"},
  {id: "proj-settings", label: "项目设置"}
];

const MENUS = {
  system: [
    {id: "sys-overview", label: "系统概览"},
    {id: "sys-orgs", label: "组织管理"},
    {id: "sys-settings", label: "系统设置"},
    {id: "sys-accounts", label: "账号与授权"},
    {divider: "项目支持（排障）"},
    ...PROJECT_MENU_TAIL
  ],
  org: [
    {id: "org-overview", label: "组织概览"},
    {id: "org-members", label: "成员管理"},
    {id: "org-agents", label: "AI 智能体"},
    {id: "org-projects", label: "项目管理"},
    {divider: "项目视角"},
    ...PROJECT_MENU_TAIL
  ],
  user: [...PROJECT_MENU_TAIL]
};

const PAGE_META = {
  "sys-overview": ["系统概览", "服务器信息、资源占用、能耗估算、存储体量与运行指标"],
  "sys-orgs": ["组织管理", "组织列表、配额与用量、创建组织并签发初始组织管理员账号"],
  "sys-settings": ["系统设置", "运行参数只读展示、模型能力注册、技能源与指令协议"],
  "sys-accounts": ["账号与授权", "账号邀请、访问授权、项目归属与智能体入网令牌"],
  "org-overview": ["组织概览", "配额用量、活跃项目与任务组统计"],
  "org-members": ["成员管理", "创建成员、权限分配、停用与一次性登录令牌"],
  "org-agents": ["AI 智能体", "组织内智能体节点：运行状态、健康度、加入令牌与吊销"],
  "org-projects": ["项目管理", "创建项目、基础配置与成员授权"],
  "proj-overview": ["项目概览", "进度、健康度、事项完成度与待人工确认数"],
  "tg": ["任务组", "事项清单、角色、配置继承与执行控制"],
  "review": ["人工审核", "集中处理执行过程中提交的人工确认请求"],
  "directives": ["人工指令", "通过独立通道向系统下达结构化指令"],
  "monitor": ["执行监控", "会话、派发、控制通道与实时执行事件流"],
  "proj-settings": ["项目设置", "仓库与凭证引用、基线数据、业务规则与默认角色"]
};

function perspectiveOf(account) {
  if (!account) return "user";
  if (account.accountType === "system_admin" || (account.permissions || []).includes("system:*")) return "system";
  if (account.accountType === "org_admin") return "org";
  return "user";
}

function defaultPageFor(perspective) {
  if (perspective === "system") return "sys-overview";
  if (perspective === "org") return "org-overview";
  return "proj-overview";
}

/* ---------------- 基础工具 ---------------- */

function emptyState() {
  return {
    runtime: {status: "login_required", services: []},
    accounts: [],
    accessGrants: [],
    agents: [],
    projects: [],
    taskGroups: [],
    modelCapabilities: [],
    modelSelectionPolicies: [],
    modelSelectionDecisions: [],
    skillSources: [],
    roleSkills: [],
    roleSkillOverlays: [],
    sessionPlacementDecisions: [],
    workSessions: [],
    agentDispatches: [],
    agentRuntimeNodes: [],
    agentJoinTokens: [],
    repositoryOutputs: [],
    agentControlCommands: [],
    agentExecutionEvents: [],
    closeBarriers: [],
    sharedDefinitions: [],
    organizations: [],
    instructionMetrics: {stablePrefixTokens: 0, deltaMessageTargetTokens: 0, cacheHitTarget: 0, envelopes: []},
    auditLog: [],
    progressSnapshots: []
  };
}

/* 兼容非 HTTPS / 非 localhost：crypto.randomUUID 可能不存在 */
function uuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
  }
  const rand = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${rand()}${rand()}-${rand()}-4${rand().slice(1)}-${rand()}-${rand()}${rand()}${Date.now().toString(16).slice(-6)}`;
}

/* 剪贴板降级：navigator.clipboard 在非安全上下文可能不可用 */
async function copyText(text) {
  const value = String(text ?? "");
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {}
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/* 权限门控：system_admin / org_admin 全权；user_account 看 permissions 列表 */
function hasPerm(perm) {
  const account = currentAccount;
  if (!account) return false;
  if (account.accountType === "system_admin" || account.accountType === "org_admin") return true;
  // effectivePermissions is the backend-resolved union of direct + granted (incl. project-owner) permissions.
  const permissions = account.effectivePermissions || account.permissions || [];
  if (permissions.includes("system:*") || permissions.includes("org:*")) return true;
  if (permissions.includes(perm)) return true;
  // wildcard family match (e.g. project:* grants project:update)
  const family = `${String(perm).split(":")[0]}:*`;
  if (permissions.includes(family)) return true;
  return false;
}

function accountName(accountId) {
  if (!accountId) return "-";
  const pool = [...(state.accounts || []), ...orgMembers];
  const found = pool.find((account) => account.accountId === accountId || account.email === accountId);
  if (found) return found.displayName || found.email || accountId;
  // Fall back to the lightweight server-provided id->displayName directory (views like tasks don't
  // carry the full accounts collection), then to the raw id — never the t() dictionary (an account id
  // is never an i18n key, and t() would emit a console warning + the raw id anyway).
  return (state.accountDirectory && state.accountDirectory[accountId]) || accountId;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const esc = escapeHtml;

const TONE_GREEN = new Set(["completed", "verified", "ok", "active", "online", "passed", "succeeded", "accepted", "applied", "answered", "consumed", "satisfied", "clear", "healthy", "available", "pushed", "committed", "merged", "full", "current", "resolved", "admitted", "acked", "indexed", "review_passed", "completed_objective", "closed", "fixed", "reverified", "code_complete", "corrected", "verification_ready"]);
const TONE_BLUE = new Set(["running", "in_progress", "queued", "assigned", "delivered", "monitoring", "syncing", "starting", "development", "evaluating", "collecting", "dispatched", "ready", "selected", "acknowledged", "received", "intake", "discovery", "product_design", "solution_design", "ui_design", "global_development_review", "verification", "repair", "reverification", "integration", "release", "online_quality", "implementation", "governance_design", "protocol", "cache_indexed", "initialized", "configured", "prepared", "submitted", "new_session", "subagent", "issued", "bound", "planned", "integrating", "checkpointed", "checkpoint_submitted", "created", "executor_started", "executor_output", "git_committed", "git_pushed", "repository_changed", "skill_synced", "dispatch_received", "heartbeat", "progress", "writing", "lease_bound"]);
const TONE_ORANGE = new Set(["attention", "pending", "review_requested", "paused", "draining", "degraded", "limited", "invited", "waiting_room_event", "waiting_dependency", "permission_required", "needs_decision", "stale_state", "reverify_required", "standby", "active_paused_by_control", "change_requested", "reopened", "requested", "reviewing", "candidate", "drift_signal", "monitor_attention", "needs_reconcile", "quota_limited", "awaiting_human_confirmation", "read_only", "close_candidate"]);
const TONE_RED = new Set(["failed", "blocked", "rejected", "denied", "error", "aborted", "quarantined", "quarantine", "dlq", "correction_required", "drift_detected", "timed_out", "unavailable", "blocked_dependency", "blocked_resource", "conflicted", "merge_conflict", "rolled_back", "invalidated", "S0", "critical"]);

/* 阻塞严重度着色：S0 阻断=红，S1 严重=橙，S2 一般=蓝 */
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

function badge(value, tone) {
  if (value === null || value === undefined || value === "") return `<span class="badge gray">-</span>`;
  return `<span class="badge ${tone || toneOf(value)}">${esc(t(value))}</span>`;
}

function customBadge(label, tone) {
  return `<span class="badge ${tone}">${esc(label)}</span>`;
}

// 任务分解项类别标签：优先 kind_<k> 映射，缺失则退回裸类别（再经 t 兜底），避免直出 "kind_xxx"
function kindLabel(k) {
  const key = `kind_${k}`;
  const mapped = t(key);
  return mapped === key ? String(k) : mapped;
}

// 模型能力标签专用映射（与 t() 共享命名空间隔离，避免 writing 等与仓库状态冲突）
const STRENGTH_LABELS = {
  planning: "规划", architecture: "架构", deep_reasoning: "深度推理", long_context: "长上下文",
  fast_execution: "快速执行", coding: "编码", review: "评审", security: "安全", qa: "质量保障",
  math: "数学", data_analysis: "数据分析", multimodal: "多模态", low_cost: "低成本",
  local_private: "本地私有", translation: "翻译", writing: "写作", reasoning: "推理", vision: "视觉"
};
function strengthLabel(code) { return STRENGTH_LABELS[String(code || "")] || t(code); }

// 执行档位专用映射（避免 verification 与"验证中"状态冲突）
const EXECUTION_PROFILE_LABELS = { verification: "验证档位", standard: "标准档位", fast: "高速档位", full: "完整档位" };
function executionProfileLabel(code) { return EXECUTION_PROFILE_LABELS[String(code || "")] || t(code); }

// 任务执行类别 / 推理档 专用映射（避免 verification 与"验证中"等跨域冲突）
const TASK_EXECUTION_CLASS_LABELS = { verification: "定向验证", short_execution: "短机械任务", deep_analysis: "深度分析", implementation: "实现", mixed_analysis_implementation: "分析并实现" };
const REASONING_LEVEL_LABELS = { high: "高", medium: "中", standard: "标准", low: "低", minimal: "最简" };
const LANE_FUNCTION_LABELS = { ...TASK_EXECUTION_CLASS_LABELS, general_execution: "通用执行", review: "评审", analysis: "分析", short_execution: "短机械任务", implementation: "实现" };
// §4.5 admission whyThisCellNow closed-set tokens → Chinese; dynamic reasons fall back to t(reasonCode).
const WHY_THIS_CELL_LABELS = {
  executable_cell_admitted_this_cycle: "本周期准入执行",
  cell_awaiting_independent_review: "等待独立评审",
  cell_needs_external_decision: "需人工决策处置",
  cell_already_executing: "已在执行中",
  cell_split_into_analysis_and_implementation: "已拆分为分析与实现",
  no_model_satisfies_hard_constraints: "无模型满足硬约束",
  role_drift_guard_intercepted_dispatch: "角色偏移守卫拦截派发",
  cell_deferred_condition_window: "等待条件窗口（按环境独立延后）"
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
function laneFunctionLabel(value) { return value ? (LANE_FUNCTION_LABELS[value] || value) : "-"; }
// 模型决策的中文可读摘要（原始 modelDecision 为机器契约技术串，此处从结构化字段生成人读版本）
function modelDecisionSummaryZh(decision) {
  const parts = [];
  if (decision.taskExecutionClass) parts.push(`任务类型：${TASK_EXECUTION_CLASS_LABELS[decision.taskExecutionClass] || decision.taskExecutionClass}`);
  const model = decision.selectedModel?.modelId;
  if (model) parts.push(`选定模型：${model}`);
  const reasoning = decision.selectedModel?.reasoningLevel || decision.reasoningLevel;
  if (reasoning) parts.push(`推理档：${REASONING_LEVEL_LABELS[reasoning] || reasoning}`);
  return parts.length ? parts.join(" · ") : t(decision.selectionMode || "-");
}

function fmtTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return esc(value);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fmtBytes(value) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function progressBar(percent, extra = "") {
  const safe = Math.max(0, Math.min(100, Number(percent || 0)));
  return `<div class="progress ${extra}" aria-label="进度 ${safe}%"><span style="width:${safe}%"></span></div>`;
}

function progressLine(percent) {
  const safe = Math.max(0, Math.min(100, Number(percent || 0)));
  return `<div class="progress-line">${progressBar(safe)}<em>${safe}%</em></div>`;
}

function quotaLine(used, max) {
  const total = Math.max(1, Number(max || 1));
  const percent = Math.round((Number(used || 0) / total) * 100);
  const tone = percent >= 100 ? "quota-full" : percent >= 80 ? "quota-warn" : "quota-ok";
  return `<div class="progress-line">${progressBar(percent, tone)}<em>${used ?? 0}/${max ?? 0}</em></div>`;
}

function panel(title, body, options = {}) {
  return `
    <article class="panel ${options.wide ? "wide" : ""}">
      <div class="panel-header"><h2>${esc(title)}</h2>${options.headerSide ? `<div class="header-side">${options.headerSide}</div>` : ""}</div>
      <div class="panel-body">${body}</div>
    </article>
  `;
}

// 单元格可为字符串，或 {v, c} 形态（v=已转义内容，c=列 class，如 "num"/"text-clip"/"nowrap"）
function cell(item) {
  if (item && typeof item === "object" && "v" in item) {
    // 截断列补 title，鼠标悬浮可看全文（v 为已转义纯文本时才加，避免把 HTML 塞进 title）
    const titleAttr = (item.c && item.c.includes("text-clip") && !/[<>]/u.test(String(item.v))) ? ` title="${item.v}"` : "";
    return `<td class="${item.c || ""}"${titleAttr}>${item.v}</td>`;
  }
  return `<td>${item}</td>`;
}

function row(items) {
  return `<tr>${items.map(cell).join("")}</tr>`;
}

function table(headers, bodyRows, options = {}) {
  const th = (headline) => (headline && typeof headline === "object" && "label" in headline)
    ? `<th class="${headline.c || ""}">${esc(headline.label)}</th>`
    : `<th>${esc(headline)}</th>`;
  const emptyRow = `<tr><td class="empty-cell" colspan="${headers.length}">${esc(options.emptyText || "暂无数据")}</td></tr>`;
  const footer = options.moreText ? `<div class="table-more">${esc(options.moreText)}</div>` : "";
  return `
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr>${headers.map(th).join("")}</tr></thead>
        <tbody>${bodyRows || emptyRow}</tbody>
      </table>
      ${footer}
    </div>
  `;
}

// 截断提示：数据超过展示上限时给出中性文案（不区分前/最新，避免与实际排序不符）
function moreText(total, shown) {
  return total > shown ? `共 ${total} 条，当前展示 ${shown} 条` : "";
}

const filterState = {};

// Filter the SOURCE array by the persisted query BEFORE the display cap, so a keyword filter finds
// items past the cap (the DOM-level applyFilterFor only searched already-rendered rows).
function filterSource(items, key) {
  const query = String(filterState[key] || "").trim().toLowerCase();
  if (!query) return items;
  return (items || []).filter((item) => JSON.stringify(item).toLowerCase().includes(query));
}

function filterInput(placeholder = "关键字过滤…", key = "") {
  const value = key ? filterState[key] || "" : "";
  return `<input class="filter-input" data-filter-input aria-label="${esc(placeholder)}" ${key ? `data-filter-key="${esc(key)}"` : ""} value="${esc(value)}" placeholder="${esc(placeholder)}">`;
}

// 按输入框内容隐藏不匹配的行/卡片；供输入时与每次 render 后回填复用
function applyFilterFor(inputEl) {
  if (!inputEl) return;
  const scope = inputEl.closest(".panel") || document;
  const query = String(inputEl.value || "").trim().toLowerCase();
  scope.querySelectorAll(".data-table tbody tr, .agent-cards .agent-card").forEach((rowEl) => {
    if (rowEl.querySelector(".empty-cell")) return;
    rowEl.style.display = !query || rowEl.textContent.toLowerCase().includes(query) ? "" : "none";
  });
}

// applyFilterFor only hides rows already in the DOM (≤ display cap). filterSource filters the FULL
// source before the cap, but only runs on a render() — and the pollers skip render() while a filter
// box is focused. So a keyword matching a row past the cap would show an empty panel until blur+poll.
// Debounce a full render() on filter input, then restore focus+caret to the same box so typing isn't
// interrupted and past-cap matches surface immediately.
let __filterRerenderTimer = null;
function scheduleFilterRerender(inputEl) {
  const key = inputEl.dataset.filterKey;
  if (!key) return; // keyless filters have no source array to re-slice; DOM-level applyFilterFor suffices
  const caret = inputEl.selectionStart;
  if (__filterRerenderTimer) clearTimeout(__filterRerenderTimer);
  __filterRerenderTimer = setTimeout(() => {
    __filterRerenderTimer = null;
    // Honor the same guards as every other auto-render path: never rebuild over an in-progress form
    // edit or an open modal. The one case the pollers can't cover is that we WANT to render while the
    // filter box itself is focused (they skip on any focused input) — so allow it only when this filter
    // box is still the active element (focus/caret restored below) or focus has settled somewhere safe.
    const active = document.activeElement;
    if (modalHtml || formTouched) return;
    const filterStillFocused = active === inputEl;
    const focusIsSafe = !(active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName));
    if (!filterStillFocused && !focusIsSafe) return;
    render();
    if (filterStillFocused) {
      const again = document.querySelector(`[data-filter-input][data-filter-key="${CSS.escape(key)}"]`);
      if (again) {
        again.focus();
        try { again.setSelectionRange(caret, caret); } catch { /* not a text input */ }
      }
    }
  }, 250);
}

// render 后重新应用所有已保存的过滤词，避免自动刷新/轮询把用户的筛选抹掉
function reapplyFilters() {
  document.querySelectorAll("[data-filter-input]").forEach((inputEl) => {
    if (inputEl.value) applyFilterFor(inputEl);
  });
}

let __labelSeq = 0;
// 为 .form-row 内"label + 控件"自动补 for/id 关联，让读屏正确朗读标签（避免逐表单手写 for）
function associateFormLabels() {
  document.querySelectorAll(".form-row").forEach((rowEl) => {
    const label = rowEl.querySelector(":scope > label");
    if (!label || label.getAttribute("for")) return;
    const control = rowEl.querySelector("input, select, textarea");
    if (!control) return;
    if (!control.id) control.id = `fld-${++__labelSeq}`;
    label.setAttribute("for", control.id);
  });
}

function errorBanner() {
  return lastError ? `<article class="panel wide"><div class="panel-body"><div class="notice error-notice">操作失败：${esc(lastError)}</div></div></article>` : "";
}

/* ---------------- API 封装 ---------------- */

async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = {"content-type": "application/json", ...(options.headers || {})};
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  if (method !== "GET") headers["Idempotency-Key"] = uuid();
  const response = await fetch(path, {...options, headers});
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.json()).error || "";
    } catch {}
    if (response.status === 401 && authToken) {
      clearSession();
      render();
    }
    throw new Error(`${response.status} ${detail ? t(detail) : response.statusText}`);
  }
  return response.json();
}

async function fetchState(view) {
  return {...emptyState(), ...(await api(`/api/state?view=${encodeURIComponent(view)}&limit=200`))};
}

function saveSession(sessionToken, account) {
  authToken = sessionToken;
  currentAccount = account;
  sessionStorage.setItem("aimac.sessionToken", sessionToken);
  sessionStorage.setItem("aimac.account", JSON.stringify(account));
  connectRealtime();
}

function clearSession() {
  authToken = "";
  currentAccount = null;
  modalProtected = false;
  document.body.classList.remove("modal-open");
  state = emptyState();
  systemOverview = null;
  organizations = [];
  orgAgentNodes = [];
  orgMembers = [];
  projConfig = null;
  instructionState = null;
  modalHtml = "";
  expandedTaskGroupId = "";
  tgDetail = null;
  reviewRequests = [];
  directiveList = [];
  execScope = {type: "", id: ""};
  execEvents = [];
  execCursor = 0;
  stopExecPolling();
  disconnectRealtime();
  sessionStorage.removeItem("aimac.sessionToken");
  sessionStorage.removeItem("aimac.account");
  sessionStorage.removeItem("aimac.page");
  sessionStorage.removeItem("aimac.projectId");
}

function showError(error) {
  lastError = error?.message || String(error);
  // 通过顶层 toast 呈现错误，确保弹窗遮罩之上也可见（此前弹窗内表单报错被遮罩挡住成为静默失败）
  toast.error(lastError);
  render();
}

/* ---------------- 反馈层：toast / 二次确认 / 提交态 ---------------- */

function ensureToastLayer() {
  let layer = document.getElementById("toast-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "toast-layer";
    layer.className = "toast-layer";
    layer.setAttribute("aria-live", "polite");
    document.body.appendChild(layer);
  }
  return layer;
}

function toast(message, kind = "success", ms = 2600) {
  if (!message) return;
  const layer = ensureToastLayer();
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  const ico = kind === "success" ? "✓" : kind === "error" ? "!" : "i";
  el.innerHTML = `<span class="toast-ico">${ico}</span><span>${esc(message)}</span>`;
  layer.appendChild(el);
  setTimeout(() => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 240);
  }, ms);
}
toast.success = (message) => toast(message, "success", 2400);
toast.error = (message) => toast(message, "error", 4200);
toast.info = (message) => toast(message, "info", 2600);

// 一致的中文二次确认弹窗，替代浏览器原生 confirm()。返回 Promise<boolean>。
function confirmDialog(options = {}) {
  const {title = "确认操作", message = "", sub = "", danger = false, confirmText = "确定", cancelText = "取消"} = options;
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.style.zIndex = "350";
    mask.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" style="width:420px;">
        <div class="modal-header"><h3>${esc(title)}</h3></div>
        <div class="modal-body"><div class="confirm-message">${esc(message)}${sub ? `<span class="confirm-sub">${esc(sub)}</span>` : ""}</div></div>
        <div class="modal-footer">
          <button type="button" class="secondary-button" data-confirm="cancel">${esc(cancelText)}</button>
          <button type="button" class="primary-button ${danger ? "danger" : ""}" data-confirm="ok">${esc(confirmText)}</button>
        </div>
      </div>`;
    const done = (value) => {
      document.removeEventListener("keydown", onKey);
      mask.remove();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape") done(false);
      // For destructive dialogs, Enter must not auto-trigger the irreversible action; require an
      // explicit click on the danger button. Enter still confirms non-destructive dialogs.
      else if (event.key === "Enter" && !danger) done(true);
    };
    mask.addEventListener("click", (event) => {
      const act = event.target.closest("[data-confirm]")?.dataset.confirm;
      if (act === "ok") done(true);
      else if (act === "cancel") done(false);
      // 点击遮罩空白处不关闭，强制用户明确选择
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(mask);
    // Destructive dialogs focus Cancel (safer default); others focus the confirm button.
    mask.querySelector(danger ? '[data-confirm="cancel"]' : '[data-confirm="ok"]').focus();
  });
}

// 异步提交期间禁用按钮并显示 loading，防止重复提交
async function withSubmitting(button, fn) {
  if (button) {
    button.disabled = true;
    button.classList.add("is-loading");
  }
  try {
    return await fn();
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove("is-loading");
    }
  }
}

// 各表单提交成功后的中文反馈（展示令牌/结果弹窗的表单不在此列，弹窗本身即反馈）
const SUBMIT_SUCCESS = {
  "org-quotas": "已保存组织配额",
  "member-perms": "已更新成员权限",
  "grant-create": "已创建访问授权",
  "project-create": "已创建项目",
  "org-project-create": "已创建项目",
  "project-member": "已添加项目成员",
  "agent-create": "已创建智能体档案",
  "task-group-create": "已创建任务组",
  "work-item-create": "已添加工作项",
  "language-policy": "已更新语言策略",
  "tg-config": "已保存任务组配置",
  "project-config": "已保存项目配置",
  "project-rules": "已保存规则",
  "tg-rules": "已保存规则",
  "hcr-decide": "已提交人工确认",
  "directive-create": "已下达人工指令，将在下一编排周期生效",
  "perm-resolve": "已处理授权请求",
  "approval-resolve": "已处理审批请求",
  "finding-resolve": "已处置发现",
  "close-task-group": "任务组已关闭"
};

/* ---------------- 项目范围 ---------------- */

function visibleProjects() {
  return state.projects || [];
}

function currentProject() {
  return visibleProjects().find((project) => project.id === currentProjectId) || null;
}

function ensureProjectSelection() {
  const projects = visibleProjects();
  if (!projects.length) {
    currentProjectId = "";
    return;
  }
  if (currentProjectId && projects.some((project) => project.id === currentProjectId)) return;
  const preferred = currentAccount?.defaultProjectId;
  currentProjectId = (preferred && projects.some((project) => project.id === preferred)) ? preferred : projects[0].id;
  sessionStorage.setItem("aimac.projectId", currentProjectId);
}

function projectTaskGroups() {
  return (state.taskGroups || []).filter((taskGroup) => !currentProjectId || taskGroup.projectId === currentProjectId);
}

/* ---------------- 页面数据加载 ---------------- */

async function loadPage() {
  dirtyFormKinds.clear(); // a full page (re)load rebuilds the DOM, discarding any in-progress form edits
  if (!authToken) {
    render();
    return;
  }
  loading = true;
  try {
    if (page === "sys-overview") {
      [systemOverview, state] = await Promise.all([api("/api/system/overview"), fetchState("system")]);
    } else if (page === "sys-orgs") {
      organizations = (await api("/api/orgs")).organizations || [];
    } else if (page === "sys-settings") {
      [state, instructionState] = await Promise.all([fetchState("runtime"), fetchState("instructions")]);
    } else if (page === "sys-accounts") {
      state = await fetchState("users");
    } else if (page === "org-overview") {
      const [fullState, agentsResult] = await Promise.all([fetchState("full"), api("/api/org/agents")]);
      state = fullState;
      orgAgentNodes = agentsResult.agentRuntimeNodes || [];
    } else if (page === "org-members") {
      const [membersResult, projectState] = await Promise.all([api("/api/org/members"), fetchState("projects")]);
      orgMembers = membersResult.members || [];
      state = projectState;
    } else if (page === "org-agents") {
      const [agentsResult, projectState] = await Promise.all([api("/api/org/agents"), fetchState("projects")]);
      orgAgentNodes = agentsResult.agentRuntimeNodes || [];
      state = projectState;
    } else if (page === "org-projects") {
      const [projectState, membersResult] = await Promise.all([fetchState("projects"), api("/api/org/members")]);
      state = projectState;
      orgMembers = membersResult.members || [];
    } else if (page === "proj-overview") {
      state = await fetchState("tasks");
      ensureProjectSelection();
      loadPendingConfirmCount();
    } else if (page === "tg") {
      state = await fetchState("tasks");
      ensureProjectSelection();
      if (expandedTaskGroupId) await loadTaskGroupDetail(expandedTaskGroupId);
    } else if (page === "review") {
      state = await fetchState("tasks");
      ensureProjectSelection();
      await loadReviewData();
    } else if (page === "directives") {
      state = await fetchState("tasks");
      ensureProjectSelection();
      await loadDirectiveData();
    } else if (page === "monitor") {
      const [tasksState, runtimeState] = await Promise.all([fetchState("tasks"), fetchState("runtime")]);
      state = {
        ...tasksState,
        modelSelectionDecisions: runtimeState.modelSelectionDecisions || [],
        sessionPlacementDecisions: runtimeState.sessionPlacementDecisions || [],
        admissionDecisions: runtimeState.admissionDecisions || [],
        workerLanes: runtimeState.workerLanes || [],
        skillSources: runtimeState.skillSources || [],
        roleSkills: runtimeState.roleSkills || [],
        agentJoinTokens: runtimeState.agentJoinTokens || []
      };
      ensureProjectSelection();
      ensureExecScope();
    } else if (page === "proj-settings") {
      state = await fetchState("tasks");
      ensureProjectSelection();
      if (currentProjectId) {
        const configResult = await api(`/api/projects/${encodeURIComponent(currentProjectId)}/config`).catch(() => null);
        projConfig = configResult?.config || null;
      } else {
        projConfig = null;
      }
    }
    ensureProjectSelection();
    lastError = "";
    lastLoadErrorToast = "";
  } catch (error) {
    lastError = error?.message || String(error);
    // Surface authenticated page-load failures — previously the value was only rendered on the login
    // screen, so a backend 500 / network blip left the operator on stale content with no signal. Dedupe
    // so the 5s fallback poll and realtime wake don't spam the same transient error.
    if (lastError && lastError !== lastLoadErrorToast) {
      lastLoadErrorToast = lastError;
      toast.error(`页面数据加载失败：${lastError}`);
    }
  }
  loading = false;
  render();
}

async function loadTaskGroupDetail(taskGroupId) {
  const [progressResult, configResult] = await Promise.all([
    api(`/api/task-groups/${encodeURIComponent(taskGroupId)}/progress`),
    api(`/api/task-groups/${encodeURIComponent(taskGroupId)}/config`).catch(() => null)
  ]);
  tgDetail = {taskGroupId, progress: progressResult, config: configResult?.config || null};
}

async function loadReviewData() {
  // 人工确认由 tasks 视角随 state.humanConfirmationRequests 项目级下发，此处无需再逐组拉取
  return;
}

async function loadDirectiveData() {
  const groups = projectTaskGroups();
  if (!groups.length) {
    directiveTaskGroupId = "";
    directiveList = [];
    return;
  }
  if (!directiveTaskGroupId || !groups.some((taskGroup) => taskGroup.id === directiveTaskGroupId)) {
    directiveTaskGroupId = groups[0].id;
  }
  const result = await api(`/api/task-groups/${encodeURIComponent(directiveTaskGroupId)}/human-directives`);
  directiveList = result.humanDirectives || [];
}

function loadPendingConfirmCount() {
  const visibleTaskGroupIds = new Set(projectTaskGroups().map((taskGroup) => taskGroup.id));
  const pendingIds = state.pendingHumanConfirmationTaskGroupIds
    || (state.humanConfirmationRequests || []).filter((item) => item.status === "pending").map((item) => item.taskGroupId);
  pendingConfirmCount = pendingIds.filter((taskGroupId) => visibleTaskGroupIds.has(taskGroupId)).length;
}

/* ---------------- 执行事件长轮询 ---------------- */

function ensureExecScope() {
  if (execScope.id) return;
  const first = projectTaskGroups()[0];
  if (first) {
    execScope = {type: "taskGroup", id: first.id};
    execEvents = [];
    execCursor = 0;
  }
}

function execEventsPath(scope) {
  if (scope.type === "dispatch") return `/api/agent-dispatches/${encodeURIComponent(scope.id)}/events`;
  if (scope.type === "session") return `/api/work-sessions/${encodeURIComponent(scope.id)}/execution-events`;
  return `/api/task-groups/${encodeURIComponent(scope.id)}/execution-events`;
}

async function loadExecEvents(options = {}) {
  if (!execScope.id || !authToken) return;
  const after = options.reset ? 0 : execCursor;
  const waitMs = options.longPoll ? 2000 : 0;
  const result = await api(`${execEventsPath(execScope)}?afterSequence=${after}&limit=200&waitMs=${waitMs}`);
  if (options.reset) execEvents = [];
  const known = new Set(execEvents.map((event) => event.eventId));
  for (const event of result.events || []) {
    if (!known.has(event.eventId)) execEvents.push(event);
  }
  execEvents = execEvents.slice(-300);
  execCursor = Number(result.nextCursor || execCursor || 0);
}

function stopExecPolling() {
  if (execTimer) {
    clearInterval(execTimer);
    execTimer = null;
  }
}

function startExecPolling() {
  stopExecPolling();
  if (page !== "monitor" || !execScope.id) return;
  execTimer = setInterval(async () => {
    if (!authToken || page !== "monitor") {
      stopExecPolling();
      return;
    }
    try {
      await loadExecEvents({longPoll: true});
      const active = document.activeElement;
      // Do not rebuild the DOM while the operator is typing in a filter box or has the scope select
      // open — a full innerHTML render would drop focus/caret and close the dropdown every tick.
      if (!formTouched && !modalHtml && !(active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName))) render();
    } catch {}
  }, 2500);
}

/* ---------------- 弹窗 ---------------- */

function openModal(title, body, options = {}) {
  modalProtected = Boolean(options.protected);
  modalHtml = `
    <div class="modal-mask" data-modal-mask>
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-header"><h3>${esc(title)}</h3><button class="modal-close" data-action="modal-close" title="关闭" aria-label="关闭">×</button></div>
        <div class="modal-body">${body}</div>
      </div>
    </div>
  `;
  document.body.classList.add("modal-open");
  render();
  // 打开后把焦点移入弹窗首个可交互控件（无障碍）
  const modalEl = document.querySelector("#app .modal") || document.querySelector(".modal");
  const firstField = modalEl?.querySelector("input, select, textarea, button:not(.modal-close)") || modalEl?.querySelector("button");
  if (firstField) firstField.focus();
}

// 当前置顶弹窗容器（确认框优先，其次 openModal 弹窗），用于 Tab 焦点陷阱
function activeModalContainer() {
  const confirmEl = document.querySelector('.modal-mask[style*="z-index: 350"] .modal');
  if (confirmEl) return confirmEl;
  if (modalHtml) return document.querySelector("#app .modal") || document.querySelector(".modal");
  return null;
}

function closeModal() {
  modalHtml = "";
  modalProtected = false;
  document.body.classList.remove("modal-open");
  render();
}

// 受保护弹窗（一次性令牌等）关闭前二次确认，避免误触导致不可恢复的信息丢失
async function requestCloseModal() {
  if (!modalHtml) return;
  if (modalProtected) {
    const ok = await confirmDialog({
      title: "确认关闭",
      message: "确认关闭该窗口？",
      sub: "其中的一次性令牌 / 安装命令关闭后将无法再次查看。",
      danger: true,
      confirmText: "仍要关闭"
    });
    if (!ok) return;
  }
  closeModal();
}

function oneTimeTokenModal(title, loginEmail, token, extraNote = "") {
  openModal(title, `
    <div class="stack">
      <div class="notice warn-notice">该登录令牌仅显示一次，请立即复制并妥善保存。关闭本弹窗后将无法再次查看。</div>
      <div class="command-box"><strong>登录凭据</strong><pre id="otm-token">登录账号：${esc(loginEmail)}
一次性令牌：${esc(token)}</pre></div>
      <div class="button-row"><button type="button" class="secondary-button" data-action="copy-el" data-copy-target="#otm-token">复制登录凭据</button></div>
      ${extraNote ? `<div class="notice">${esc(extraNote)}</div>` : ""}
    </div>
  `, {protected: true});
}

/* ---------------- 登录页 ---------------- */

async function loadLoginHint() {
  if (loginHint) return;
  try {
    loginHint = await api("/api/auth/bootstrap-hint");
  } catch {
    loginHint = {bootstrapTokenConfigured: false};
  }
  if (!authToken) render();
}

function renderLogin() {
  const hintBlock = loginHint
    ? `
      <div class="login-hint">
        <div>初始化令牌：${loginHint.bootstrapTokenConfigured ? "已配置（系统管理员可用初始化令牌登录）" : "未配置"}</div>
        ${loginHint.tokenHintsExposed && loginHint.tokenHint ? `<div>本机令牌提示：<span class="mono">${esc(loginHint.tokenHint)}</span></div>` : ""}
        ${loginHint.tokenHintsExposed && loginHint.localAccountTokenHints ? Object.entries(loginHint.localAccountTokenHints).map(([accountId, hint]) => `<div>${esc(accountId)}：<span class="mono">${esc(hint)}</span></div>`).join("") : ""}
      </div>
    `
    : "";
  app.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-brand">
          <span class="brand-mark">智</span>
          <h1>AI 多智能体管控台</h1>
        </div>
        <p class="login-sub">面向人的组织化管理后台 · 系统管理员、组织管理员、组织成员</p>
        ${lastError ? `<div class="notice error-notice" style="margin-bottom:14px;">登录失败：${esc(lastError)}</div>` : ""}
        <form class="form-grid" data-form="login">
          <div class="form-row"><label for="loginEmail">登录账号（邮箱或账号 ID）</label><input id="loginEmail" name="email" required autocomplete="username"></div>
          <div class="form-row"><label for="loginSecret">登录令牌 / 密码</label><input id="loginSecret" name="secret" type="password" required autocomplete="current-password"></div>
          <button class="primary-button" type="submit">登 录</button>
        </form>
        ${hintBlock}
        <p class="small muted" style="margin-top:16px;">首次使用一次性令牌登录后，可在顶栏“修改密码”设置个人密码。</p>
      </div>
    </div>
  `;
  loadLoginHint();
}

/* ---------------- 框架渲染 ---------------- */

function render() {
  if (!authToken || !currentAccount) {
    renderLogin();
    return;
  }
  const perspective = perspectiveOf(currentAccount);
  if (!page || !MENUS[perspective].some((item) => item.id === page)) {
    page = defaultPageFor(perspective);
  }
  const [title, subtitle] = PAGE_META[page] || ["管理后台", ""];
  const menuHtml = MENUS[perspective].map((item) => item.divider
    ? `<div class="nav-divider">${esc(item.divider)}</div>`
    : `<button class="nav-item ${item.id === page ? "active" : ""}" data-menu="${item.id}">${esc(item.label)}</button>`
  ).join("");

  const showSwitcher = PROJECT_PAGES.has(page) && visibleProjects().length > 0;
  const switcherHtml = showSwitcher
    ? `
      <div class="project-switch">
        <span>当前项目</span>
        <select id="project-switcher" aria-label="当前项目">
          ${visibleProjects().map((project) => `<option value="${esc(project.id)}" ${project.id === currentProjectId ? "selected" : ""}>${esc(project.name || project.id)}</option>`).join("")}
        </select>
      </div>
    `
    : "";

  const prevScrollY = window.scrollY;
  const prevTableScroll = [...document.querySelectorAll(".table-scroll")].map((el) => el.scrollLeft);

  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-mark">智</span>
          <div>
            <strong>AI 多智能体管控台</strong>
            <span>${esc(t(perspectiveOf(currentAccount) === "system" ? "system_admin" : currentAccount.accountType))}视角</span>
          </div>
        </div>
        <nav class="nav" aria-label="管理菜单">${menuHtml}</nav>
      </aside>
      <main class="workspace">
        <header class="topbar">
          <div>
            <h1>${esc(title)}</h1>
            <p class="subtitle">${esc(subtitle)}</p>
          </div>
          ${switcherHtml}
          <div class="topbar-actions">
            <span class="account-chip">${esc(currentAccount.displayName || currentAccount.email)} ${badge(currentAccount.accountType)}</span>
            <button class="secondary-button" data-action="open-change-password">修改密码</button>
            <button class="icon-button" data-action="refresh" title="刷新" aria-label="刷新">↻</button>
            <button class="secondary-button" data-action="logout">退出登录</button>
          </div>
        </header>
        <section class="content">${renderContent()}</section>
      </main>
    </div>
    ${modalHtml}
  `;

  // 轮询/局部刷新后恢复滚动位置，避免整页 render 抖动
  window.scrollTo(0, prevScrollY);
  const tableScrolls = document.querySelectorAll(".table-scroll");
  prevTableScroll.forEach((left, index) => {
    if (tableScrolls[index]) tableScrolls[index].scrollLeft = left;
  });
  reapplyFilters();
  associateFormLabels();
}

function renderContent() {
  let body = "";
  if (page === "sys-overview") body = renderSysOverview();
  else if (page === "sys-orgs") body = renderSysOrgs();
  else if (page === "sys-settings") body = renderSysSettings();
  else if (page === "sys-accounts") body = renderSysAccounts();
  else if (page === "org-overview") body = renderOrgOverview();
  else if (page === "org-members") body = renderOrgMembers();
  else if (page === "org-agents") body = renderOrgAgents();
  else if (page === "org-projects") body = renderOrgProjects();
  else if (page === "proj-overview") body = renderProjectOverview();
  else if (page === "tg") body = renderTaskGroups();
  else if (page === "review") body = renderReview();
  else if (page === "directives") body = renderDirectives();
  else if (page === "monitor") body = renderMonitor();
  else if (page === "proj-settings") body = renderProjectSettings();
  return body;
}

/* ---------------- 系统管理员：系统概览 ---------------- */

function renderSysOverview() {
  const overview = systemOverview;
  const services = (state.runtime?.services || []).map((service) => row([
    `<span class="mono">${esc(service.serviceId)}</span>`,
    badge(service.status),
    badge(service.health)
  ])).join("");
  const audit = (state.auditLog || []).slice(0, 15).map((entry) => row([
    fmtTime(entry.at),
    esc(accountName(entry.actor)),
    esc(t(entry.action)),
    {v: esc(entry.subject), c: "text-clip"},
    badge(entry.result || "ok")
  ])).join("");

  const overviewPanels = overview ? [
    panel("运行指标", `
      <div class="metric-grid">
        <div class="metric"><span>在线节点</span><strong>${esc(overview.runtime.onlineNodes)}/${esc(overview.runtime.totalNodes)}</strong></div>
        <div class="metric"><span>组织数</span><strong>${esc(overview.runtime.organizations)}</strong></div>
        <div class="metric"><span>项目数</span><strong>${esc(overview.runtime.projects)}</strong></div>
        <div class="metric"><span>活跃任务组</span><strong>${esc(overview.runtime.activeTaskGroups)}</strong></div>
        <div class="metric"><span>状态版本</span><strong>${esc(overview.runtime.stateVersion)}</strong></div>
      </div>
      <p class="small muted" style="margin-bottom:0;">审计链头：<span class="mono">${overview.runtime.auditChainHead ? esc(String(overview.runtime.auditChainHead).slice(0, 24)) + "…" : "-"}</span> · 统计时间 ${fmtTime(overview.at)}</p>
    `, {wide: true}),
    panel("服务器信息", `
      <dl class="kv-list">
        <dt>主机名</dt><dd class="mono">${esc(overview.server.hostname)}</dd>
        <dt>平台 / 架构</dt><dd>${esc(overview.server.platform)} / ${esc(overview.server.arch)}</dd>
        <dt>Node 版本</dt><dd>${esc(overview.server.nodeVersion)}</dd>
        <dt>进程号</dt><dd>${esc(overview.server.pid)}</dd>
        <dt>持续运行</dt><dd>${Math.floor(overview.server.uptimeSeconds / 3600)} 小时 ${Math.floor((overview.server.uptimeSeconds % 3600) / 60)} 分钟</dd>
      </dl>
    `),
    panel("资源占用", `
      <dl class="kv-list">
        <dt>常驻内存</dt><dd>${fmtBytes(overview.resources.rssBytes)}</dd>
        <dt>堆内存</dt><dd>${fmtBytes(overview.resources.heapUsedBytes)}</dd>
        <dt>累计 CPU 时间</dt><dd>${esc(overview.resources.cpuSeconds)} 秒</dd>
        <dt>负载（1/5/15 分钟）</dt><dd>${(overview.resources.loadAverage || []).map((load) => load.toFixed(2)).join(" / ")}</dd>
        <dt>CPU 核数</dt><dd>${esc(overview.resources.cpuCount)}</dd>
        <dt>系统内存</dt><dd>可用 ${fmtBytes(overview.resources.freeMemoryBytes)} / 共 ${fmtBytes(overview.resources.totalMemoryBytes)}</dd>
      </dl>
    `),
    panel("能耗估算", `
      <div class="metric-grid">
        <div class="metric"><span>累计估算能耗</span><strong>${esc(overview.energy.estimatedWattHours)} Wh</strong></div>
        <div class="metric"><span>功率系数</span><strong>${esc(overview.energy.wattsPerCpuCoefficient)} W/核</strong></div>
      </div>
    `),
    panel("存储体量", `
      <dl class="kv-list">
        <dt>中央状态库</dt><dd>${fmtBytes(overview.storage.centralStateBytes)}</dd>
        <dt>项目事件库</dt><dd>${fmtBytes(overview.storage.projectDbBytes)}</dd>
        <dt>状态存储引擎</dt><dd>${esc(t(overview.storage.stateStore))}</dd>
      </dl>
    `)
  ].join("") : panel("系统概览", `<div class="notice">正在加载系统概览…</div>`, {wide: true});

  return overviewPanels + [
    panel("系统服务", table(["服务", "状态", "健康度"], services)),
    panel("维护操作", `
      <div class="stack">
        <div class="notice warn-notice">重新初始化会将运行态重置为种子数据，仅用于本地环境排障。</div>
        <div class="button-row"><button class="danger-button" data-action="bootstrap-init">重新初始化运行态</button></div>
      </div>
    `),
    panel("审计日志", table(["时间", "操作者", "动作", {label: "对象", c: "text-clip"}, "结果"], audit, {moreText: moreText((state.auditLog || []).length, 15)}), {wide: true})
  ].join("");
}

/* ---------------- 系统管理员：组织管理 ---------------- */

function renderSysOrgs() {
  const orgRows = organizations.map((org) => row([
    `<strong>${esc(org.name)}</strong><div class="small muted mono">${esc(org.orgId)}</div>`,
    badge(org.status),
    quotaLine(org.usage?.members, org.quotas?.maxMembers),
    quotaLine(org.usage?.projects, org.quotas?.maxProjects),
    quotaLine(org.usage?.taskGroups, org.quotas?.maxTaskGroups),
    quotaLine(org.usage?.agents, org.quotas?.maxAgents),
    fmtTime(org.createdAt),
    [
      `<button class="secondary-button" data-action="org-quota" data-org="${esc(org.orgId)}">配额</button>`,
      org.status === "active"
        ? `<button class="danger-button" data-action="org-status" data-org="${esc(org.orgId)}" data-status="suspended">停用</button>`
        : `<button class="secondary-button" data-action="org-status" data-org="${esc(org.orgId)}" data-status="active">启用</button>`
    ].join(" ")
  ])).join("");

  return [
    panel("创建组织", `
      <form class="form-grid" data-form="org-create">
        <div class="form-row"><label>组织名称</label><input name="name" required placeholder="示例：华东研发中心"></div>
        <div class="form-row-inline">
          <div class="form-row"><label>初始组织管理员姓名</label><input name="adminName" required placeholder="组织管理员"></div>
          <div class="form-row"><label>初始组织管理员邮箱</label><input name="adminEmail" type="email" required></div>
        </div>
        <div class="form-row-inline">
          <div class="form-row"><label>成员上限</label><input name="maxMembers" type="number" min="1" value="50"></div>
          <div class="form-row"><label>项目上限</label><input name="maxProjects" type="number" min="1" value="20"></div>
          <div class="form-row"><label>任务组上限</label><input name="maxTaskGroups" type="number" min="1" value="200"></div>
          <div class="form-row"><label>智能体上限</label><input name="maxAgents" type="number" min="1" value="100"></div>
        </div>
        <div class="notice">创建成功后将弹窗展示初始组织管理员的一次性登录令牌，请务必保存。</div>
        <button class="primary-button" type="submit">创建组织并签发管理员账号</button>
      </form>
    `),
    panel("说明", `
      <div class="stack">
        <div class="record"><div class="record-title"><strong>三级职责边界</strong></div><div class="record-meta"><span>系统管理员负责组织与配额；组织管理员负责成员、智能体与项目；组织成员在被授权的项目内工作。</span></div></div>
        <div class="record"><div class="record-title"><strong>配额强制</strong></div><div class="record-meta"><span>成员、项目、任务组、智能体创建时校验配额，超限将返回“组织配额超限”。</span></div></div>
      </div>
    `),
    panel("组织列表", table(["组织", "状态", "成员", "项目", "任务组", "智能体", "创建时间", "操作"], orgRows), {wide: true, headerSide: filterInput("按组织名过滤…", "orgs")})
  ].join("");
}

/* ---------------- 系统管理员：系统设置 ---------------- */

function renderSysSettings() {
  const runtime = state.runtime || {};
  const models = (state.modelCapabilities || []).slice(0, 40).map((profile) => row([
    esc(t(profile.providerClass)),
    `<span class="mono">${esc(profile.modelId)}</span>`,
    esc((profile.strengths || []).slice(0, 4).map((item) => strengthLabel(item)).join("、")),
    {v: esc(profile.limits?.contextWindowTokens ?? "-"), c: "num"},
    badge(profile.availability)
  ])).join("");
  const sources = (state.skillSources || []).map((source) => row([
    `<span class="mono">${esc(source.sourceId)}</span>`,
    badge(source.status),
    `<span class="mono">${esc(String(source.pinnedCommit || "").slice(0, 10))}</span>`,
    {v: String((state.roleSkills || []).filter((skill) => skill.sourceId === source.sourceId).length), c: "num"},
    `<button class="secondary-button" data-action="sync-skill-source" data-source="${esc(source.sourceId)}">同步</button>`
  ])).join("");
  const metrics = instructionState?.instructionMetrics || {stablePrefixTokens: 0, deltaMessageTargetTokens: 0, cacheHitTarget: 0, envelopes: []};
  const envelopes = (metrics.envelopes || []).slice(0, 12).map((envelope) => row([
    `<span class="mono">${esc(envelope.envelopeId || "-")}</span>`,
    esc(t(envelope.recipientRole)),
    `<span class="mono">${esc(String(envelope.cacheKey || "").slice(0, 28))}</span>`,
    badge(envelope.status),
    {v: esc(envelope.tokenBudget?.targetDeltaTokens ?? "-"), c: "num"}
  ])).join("");
  const definitions = (instructionState?.sharedDefinitions || []).map((definition) => row([
    `<span class="mono">${esc(definition.contractId)}</span>`,
    esc(t(definition.definitionType)),
    esc(t(definition.canonicalOwnerRole)),
    esc(t(definition.producerRole)),
    badge(definition.status)
  ])).join("");

  return [
    panel("运行参数（只读）", `
      <dl class="kv-list">
        <dt>运行档案</dt><dd class="mono">${esc(runtime.profileId || "-")}</dd>
        <dt>运行状态</dt><dd>${badge(runtime.status)}</dd>
        <dt>执行档位</dt><dd>${esc(executionProfileLabel(runtime.executionProfile || "-"))}</dd>
        <dt>启动方式</dt><dd>${esc((runtime.launchModes || []).join("、") || "-")}</dd>
        <dt>MCP 工具数</dt><dd>${esc(runtime.mcp?.toolCount ?? "-")}</dd>
        <dt>更新时间</dt><dd>${fmtTime(runtime.updatedAt)}</dd>
      </dl>
    `),
    panel("技能源", table(["技能源", "状态", "固定提交", {label: "角色数", c: "num"}, "操作"], sources)),
    panel("模型能力注册（只读）", table(["供应商", "模型", "能力", {label: "上下文窗口", c: "num"}, "可用性"], models, {moreText: moreText((state.modelCapabilities || []).length, 40)}), {wide: true}),
    panel("指令压缩指标", `
      <div class="metric-grid">
        <div class="metric"><span>稳定前缀 Token 数</span><strong>${esc(metrics.stablePrefixTokens)}</strong></div>
        <div class="metric"><span>增量消息目标 Token 数</span><strong>${esc(metrics.deltaMessageTargetTokens)}</strong></div>
        <div class="metric"><span>缓存命中目标</span><strong>${Math.round((metrics.cacheHitTarget || 0) * 100)}%</strong></div>
      </div>
    `),
    panel("指令信封", table(["编号", "接收角色", "缓存键", "状态", {label: "目标 Token 数", c: "num"}], envelopes, {moreText: moreText((metrics.envelopes || []).length, 12)})),
    panel("共享定义归属", table(["定义", "类型", "归属角色", "生产角色", "状态"], definitions), {wide: true})
  ].join("");
}

/* ---------------- 系统管理员：账号与授权（保留既有功能） ---------------- */

function renderSysAccounts() {
  const accounts = (state.accounts || []).map((account) => row([
    esc(account.displayName),
    esc(account.email),
    badge(account.accountType),
    badge(account.status),
    esc((account.roles || []).map((role) => t(role)).join("、"))
  ])).join("");
  const grants = (state.accessGrants || []).map((grant) => row([
    `<span class="mono">${esc(grant.subjectRef?.subjectId || "-")}</span>`,
    resourceScopeLabel(grant.resource),
    esc(t(grant.role)),
    badge(grant.status),
    esc((grant.permissions || []).map(permLabel).join("、")),
    grant.status === "active" ? `<button class="danger-button" data-action="revoke-grant" data-grant="${esc(grant.grantId)}">撤销</button>` : "-"
  ])).join("");
  const agents = (state.agents || []).map((agent) => row([
    esc(agent.name),
    esc(t(agent.role)),
    esc(t(agent.model)),
    badge(agent.status),
    `<button class="secondary-button" data-action="toggle-agent" data-agent="${esc(agent.id)}">${agent.status === "active" ? "停用" : "启用"}</button>`
  ])).join("");

  return [
    panel("邀请账号", `
      <form class="form-grid" data-form="account-invite">
        <div class="form-row"><label>显示名</label><input name="displayName" required></div>
        <div class="form-row"><label>邮箱</label><input name="email" type="email" required></div>
        <div class="form-row"><label>账号类型</label>
          <select name="accountType">
            <option value="user_account">组织成员</option>
            <option value="system_admin">系统管理员</option>
            <option value="service_account">服务账号</option>
          </select>
        </div>
        <div class="form-row"><label>角色（逗号分隔）</label><input name="roles" value="viewer"></div>
        <div class="form-row"><label>默认权限（逗号分隔）</label><input name="permissions" value="project:view"></div>
        <button class="primary-button" type="submit">邀请并签发一次性令牌</button>
      </form>
    `),
    panel("新增访问授权", `
      <form class="form-grid" data-form="grant-create">
        <div class="form-row"><label>账号 ID</label><input name="subjectId" required placeholder="acct_..."></div>
        <div class="form-row"><label>资源类型</label>
          <select name="resourceType"><option value="project">项目</option><option value="task_group">任务组</option></select>
        </div>
        <div class="form-row"><label>资源 ID</label><input name="resourceId" required placeholder="prj_... / tg_..."></div>
        <div class="form-row"><label>角色</label><input name="role" value="viewer"></div>
        <div class="form-row"><label>权限（逗号分隔）</label><input name="permissions" value="project:view"></div>
        <button class="primary-button" type="submit">新增授权</button>
      </form>
    `),
    panel("创建项目（系统级）", `
      <form class="form-grid" data-form="project-create">
        <div class="form-row"><label>项目名称</label><input name="name" required></div>
        <div class="form-row"><label>项目负责人</label>
          <select name="ownerAccountId">
            ${(state.accounts || []).map((account) => `<option value="${esc(account.accountId)}">${esc(account.displayName)}</option>`).join("")}
          </select>
        </div>
        <button class="primary-button" type="submit">创建项目</button>
      </form>
    `),
    panel("项目成员授权", renderProjectMemberForm()),
    panel("智能体入网令牌", renderJoinTokenSection(), {wide: true}),
    panel("账号列表", table(["账号", "邮箱", "类型", "状态", "角色"], accounts), {wide: true}),
    panel("访问授权列表", table(["主体", "资源", "角色", "状态", "权限", "操作"], grants), {wide: true}),
    panel("编排智能体档案", table(["名称", "角色", "模型策略", "状态", "操作"], agents) + `
      <form class="form-grid" data-form="agent-create" style="margin-top:12px;">
        <div class="form-row-inline">
          <div class="form-row"><label>名称</label><input name="name" required></div>
          <div class="form-row"><label>角色</label><input name="role" value="reviewer" required></div>
          <div class="form-row"><label>模型策略</label>
            <select name="model"><option value="auto_best">自动最优</option><option value="auto_fast">自动快速</option><option value="cost_aware">成本优先</option></select>
          </div>
        </div>
        <button class="primary-button" type="submit">创建档案</button>
      </form>
    `, {wide: true})
  ].join("");
}

function renderProjectMemberForm() {
  return `
    <form class="form-grid" data-form="project-member">
      <div class="form-row"><label>项目</label>
        <select name="projectId">${(state.projects || []).map((project) => `<option value="${esc(project.id)}">${esc(project.name || project.id)}</option>`).join("")}</select>
      </div>
      <div class="form-row"><label>账号</label>
        <select name="accountId">${((orgMembers && orgMembers.length ? orgMembers : (state.accounts || [])).map((account) => `<option value="${esc(account.accountId)}">${esc(account.displayName || account.accountId)}</option>`)).join("")}</select>
      </div>
      <div class="form-row"><label>项目角色</label>
        <select name="role">
          <option value="project_owner">项目负责人</option>
          <option value="project_admin">项目管理员</option>
          <option value="task_group_owner">任务组负责人</option>
          <option value="agent_operator">智能体操作员</option>
          <option value="viewer">观察者</option>
        </select>
      </div>
      <button class="primary-button" type="submit">授权</button>
    </form>
  `;
}

function renderJoinTokenSection() {
  const tokens = (state.agentJoinTokens || []).slice(0, 20).map((token) => row([
    `<span class="mono">${esc(token.joinTokenId)}</span>`,
    esc(projectNameOf(token.projectId)),
    esc((token.allowedRoles || []).join("、")),
    badge(token.status),
    {v: `${token.useCount ?? 0}/${token.maxUses ?? 1}`, c: "num"},
    {v: fmtTime(token.expiresAt), c: "nowrap"},
    token.status === "issued" ? `<button class="danger-button" data-action="revoke-join-token" data-token-id="${esc(token.joinTokenId)}">撤销</button>` : "-"
  ])).join("");
  return `
    <div class="stack">
      <form class="form-grid" data-form="join-token">
        <div class="form-row-inline">
          <div class="form-row"><label>目标项目</label>
            <select name="projectId">${(state.projects || []).map((project) => `<option value="${esc(project.id)}" ${project.id === currentProjectId ? "selected" : ""}>${esc(project.name || project.id)}</option>`).join("")}</select>
          </div>
          <div class="form-row"><label>节点名（可留空）</label><input name="nodeName" placeholder="自动生成"></div>
          <div class="form-row"><label>角色范围</label><input name="allowedRoles" value="agent-runtime"></div>
          <div class="form-row"><label>有效期（秒）</label><input name="ttlSeconds" type="number" min="60" max="86400" value="1800"></div>
        </div>
        <button class="primary-button" type="submit">签发一次性加入令牌</button>
      </form>
      ${table(["令牌", "项目", "角色范围", "状态", {label: "已用次数", c: "num"}, {label: "过期时间", c: "nowrap"}, "操作"], tokens, {moreText: moreText((state.agentJoinTokens || []).length, 20)})}
    </div>
  `;
}

function projectNameOf(projectId) {
  return (state.projects || []).find((project) => project.id === projectId)?.name || projectId || "-";
}

/* ---------------- 组织管理员：组织概览 ---------------- */

function renderOrgOverview() {
  const org = (state.organizations || [])[0] || null;
  const projects = state.projects || [];
  const openTaskGroups = (state.taskGroups || []).filter((taskGroup) => !["closed", "aborted"].includes(taskGroup.status));
  const quotaPanel = org
    ? panel(`配额用量 · ${esc(org.name)}`, `
        <div class="stack">
          <div><div class="small muted">成员</div>${quotaLine(org.usage?.members, org.quotas?.maxMembers)}</div>
          <div><div class="small muted">项目</div>${quotaLine(org.usage?.projects, org.quotas?.maxProjects)}</div>
          <div><div class="small muted">任务组</div>${quotaLine(org.usage?.taskGroups, org.quotas?.maxTaskGroups)}</div>
          <div><div class="small muted">AI 智能体</div>${quotaLine(org.usage?.agents, org.quotas?.maxAgents)}</div>
          <div class="record-meta"><span>组织状态：${badge(org.status)}</span><span>创建时间：${fmtTime(org.createdAt)}</span></div>
        </div>
      `)
    : panel("配额用量", `<div class="notice">未找到当前账号归属的组织记录。</div>`);
  const projectRows = projects.map((project) => row([
    `<strong>${esc(project.name)}</strong><div class="small muted mono">${esc(project.id)}</div>`,
    badge(project.status),
    progressLine(project.progress?.percent),
    badge(project.progress?.phase),
    badge(project.progress?.health)
  ])).join("");

  return [
    quotaPanel,
    panel("组织运行统计", `
      <div class="metric-grid">
        <div class="metric"><span>项目总数</span><strong>${projects.length}</strong></div>
        <div class="metric"><span>进行中的任务组</span><strong>${openTaskGroups.length}</strong></div>
        <div class="metric"><span>在线智能体节点</span><strong>${(orgAgentNodes || []).filter((node) => node.status === "online").length}/${(orgAgentNodes || []).length}</strong></div>
        <div class="metric"><span>受阻项</span><strong>${(state.taskGroups || []).flatMap((taskGroup) => taskGroup.blockers || []).length}</strong></div>
      </div>
    `),
    panel("项目一览", table(["项目", "状态", "进度", "阶段", "健康度"], projectRows), {wide: true})
  ].join("");
}

/* ---------------- 组织管理员：成员管理 ---------------- */

const MEMBER_PERMISSION_OPTIONS = [
  ["project:view", "查看项目"],
  ["project:grant", "项目授权管理"],
  ["task_group:read", "查看任务组"],
  ["task_group:review", "人工审核"],
  ["task_group:control", "任务组控制与人工指令"],
  ["task_group:monitor", "执行监控"],
  ["member:invite", "邀请成员"],
  ["agent:activate", "智能体管理"]
];

// 权限码 → 中文（授权列表等处复用，覆盖成员可选项之外的权限码）
const PERMISSION_LABELS = {
  ...Object.fromEntries(MEMBER_PERMISSION_OPTIONS),
  "project:update": "编辑项目",
  "project:create": "创建项目",
  "project:*": "项目全部权限",
  "task_group:orchestrate": "编排调度",
  "task_group:checkpoint_submit": "提交检查点",
  "task_group:*": "任务组全部权限",
  "org:member_admin": "组织成员管理",
  "org:project_admin": "组织项目管理",
  "org:*": "组织全部权限",
  "system:*": "系统全部权限"
};
function permLabel(code) {
  return PERMISSION_LABELS[String(code || "")] || t(code);
}
const RESOURCE_TYPE_LABELS = {project: "项目", task_group: "任务组", organization: "组织", system: "系统"};
function resourceScopeLabel(resource) {
  const type = resource?.resourceType;
  const typeLabel = RESOURCE_TYPE_LABELS[type] || (type || "-");
  return `${esc(typeLabel)}：<span class="mono">${esc(resource?.resourceId || "-")}</span>`;
}

function permissionCheckboxes(selected = ["project:view", "task_group:read"]) {
  return `
    <div class="checkbox-grid">
      ${MEMBER_PERMISSION_OPTIONS.map(([value, label]) => `
        <label><input type="checkbox" name="perm" value="${esc(value)}" ${selected.includes(value) ? "checked" : ""}> ${esc(label)}</label>
      `).join("")}
    </div>
  `;
}

function renderOrgMembers() {
  const members = (orgMembers || []).filter((account) => account.accountType !== "service_account");
  const memberRows = members.map((account) => {
    const isSelf = account.accountId === currentAccount.accountId;
    const manageable = account.accountType === "user_account" && !isSelf;
    return row([
      `<strong>${esc(account.displayName)}</strong>${isSelf ? ` ${customBadge("本人", "blue")}` : ""}`,
      esc(account.email),
      badge(account.accountType),
      badge(account.status),
      esc((account.roles || []).map((role) => t(role)).join("、")),
      manageable ? [
        `<button class="secondary-button" data-action="member-perms" data-account="${esc(account.accountId)}">权限</button>`,
        account.status === "disabled"
          ? `<button class="secondary-button" data-action="member-status" data-account="${esc(account.accountId)}" data-status="active">启用</button>`
          : `<button class="danger-button" data-action="member-status" data-account="${esc(account.accountId)}" data-status="disabled">停用</button>`
      ].join(" ") : "-"
    ]);
  }).join("");

  return [
    panel("创建成员", `
      <form class="form-grid" data-form="member-create">
        <div class="form-row-inline">
          <div class="form-row"><label>显示名</label><input name="displayName" required></div>
          <div class="form-row"><label>邮箱</label><input name="email" type="email" required></div>
        </div>
        <div class="form-row"><label>默认项目</label>
          <select name="defaultProjectId">
            <option value="">（不指定）</option>
            ${(state.projects || []).map((project) => `<option value="${esc(project.id)}">${esc(project.name || project.id)}</option>`).join("")}
          </select>
        </div>
        <div class="form-row"><label>权限分配</label>${permissionCheckboxes()}</div>
        <div class="notice">创建成功后将弹窗展示一次性登录令牌，请提示成员保存并尽快登录改密。</div>
        <button class="primary-button" type="submit">创建成员</button>
      </form>
    `),
    panel("说明", `
      <div class="stack">
        <div class="record"><div class="record-title"><strong>一次性令牌</strong></div><div class="record-meta"><span>成员首次使用令牌登录后令牌即失效，可在顶栏“修改密码”设置个人密码。</span></div></div>
        <div class="record"><div class="record-title"><strong>权限边界</strong></div><div class="record-meta"><span>成员权限不可包含系统级与组织级通配权限；项目、任务组细粒度授权可在“账号与授权、项目管理”中补充。</span></div></div>
      </div>
    `),
    panel("成员列表", table(["成员", "邮箱", "类型", "状态", "角色", "操作"], memberRows), {wide: true, headerSide: filterInput("按姓名、邮箱过滤…", "members")})
  ].join("");
}

/* ---------------- 组织管理员：AI 智能体 ---------------- */

function agentHoverPop(node) {
  const profile = node.profile || {};
  const display = node.display || {};
  return `
    <div class="hover-pop">
      <dl>
        <dt>CPU 核数</dt><dd>${esc(profile.cpuCount ?? "-")}</dd>
        <dt>内存</dt><dd>${fmtBytes(profile.memoryBytes)}</dd>
        <dt>磁盘可用</dt><dd>${fmtBytes(profile.diskFreeBytes)}</dd>
        <dt>支持模型</dt><dd>${esc((display.models || []).map((model) => t(model)).join("、") || "-")}</dd>
        <dt>网络速度</dt><dd>${display.networkSpeedMbps ? `${esc(display.networkSpeedMbps)} Mbps` : "-"}</dd>
        <dt>数据根路径</dt><dd class="mono">${esc(display.dataRoot || "-")}</dd>
        <dt>累计完成 / 失败</dt><dd>${esc(node.completedDispatchCount ?? 0)} / ${esc(node.failedDispatchCount ?? 0)}</dd>
      </dl>
    </div>
  `;
}

function agentActions(node) {
  if (node.status === "revoked") return "-";
  return [
    `<button class="secondary-button" data-action="agent-control" data-node-id="${esc(node.nodeId)}" data-command="pause_dispatch">暂停</button>`,
    `<button class="secondary-button" data-action="agent-control" data-node-id="${esc(node.nodeId)}" data-command="resume_dispatch">恢复</button>`,
    `<button class="secondary-button" data-action="agent-control" data-node-id="${esc(node.nodeId)}" data-command="shutdown">关停</button>`,
    `<button class="danger-button" data-action="revoke-agent-node" data-node-id="${esc(node.nodeId)}">吊销</button>`
  ].join(" ");
}

function renderOrgAgents() {
  const nodes = orgAgentNodes;
  const toggle = `
    <div class="button-row">
      <button class="${agentViewMode === "table" ? "primary-button" : "secondary-button"}" data-action="agent-view-mode" data-mode="table">列表视图</button>
      <button class="${agentViewMode === "cards" ? "primary-button" : "secondary-button"}" data-action="agent-view-mode" data-mode="cards">卡片视图</button>
    </div>
  `;
  let bodyHtml;
  if (agentViewMode === "cards") {
    bodyHtml = nodes.length ? `
      <div class="agent-cards">
        ${nodes.map((node) => `
          <div class="agent-card">
            <h3><span class="hover-wrap">${esc(node.nodeName || node.nodeId)}${agentHoverPop(node)}</span>${badge(node.status)}</h3>
            <div class="agent-meta">
              <span>地区：${esc(node.display?.region || "-")}</span>
              <span>健康度：${badge(node.display?.health)}</span>
              <span>当前任务数：${(node.display?.currentDispatchIds || []).length}</span>
              <span>最近心跳：${fmtTime(node.lastHeartbeatAt)}</span>
            </div>
            <div class="button-row" style="margin-top:10px;">${agentActions(node)}</div>
          </div>
        `).join("")}
      </div>
    ` : `<div class="notice">当前组织暂无智能体节点，可先签发加入令牌。</div>`;
  } else {
    const nodeRows = nodes.map((node) => row([
      `<span class="hover-wrap"><strong>${esc(node.nodeName || node.nodeId)}</strong>${agentHoverPop(node)}</span><div class="small muted mono">${esc(node.nodeId)}</div>`,
      badge(node.status),
      esc(node.display?.region || "-"),
      badge(node.display?.health),
      {v: String((node.display?.currentDispatchIds || []).length), c: "num"},
      {v: fmtTime(node.lastHeartbeatAt), c: "nowrap"},
      agentActions(node)
    ])).join("");
    bodyHtml = table(["名称", "运行状态", "地区", "健康度", {label: "当前任务数", c: "num"}, {label: "最近心跳", c: "nowrap"}, "操作"], nodeRows);
  }

  return [
    panel("智能体节点", `<div class="stack"><div class="notice">鼠标悬浮在节点名称上可查看资源、支持模型、网络速度、数据根路径与累计完成、失败。</div>${bodyHtml}</div>`, {wide: true, headerSide: `${filterInput("按节点名、地区过滤…", "org-nodes")}${toggle}`}),
    panel("加入令牌管理", renderJoinTokenSection(), {wide: true})
  ].join("");
}

/* ---------------- 组织管理员：项目管理 ---------------- */

function renderOrgProjects() {
  const projectRows = (state.projects || []).map((project) => row([
    `<strong>${esc(project.name)}</strong><div class="small muted mono">${esc(project.id)}</div>`,
    badge(project.status),
    progressLine(project.progress?.percent),
    badge(project.progress?.phase),
    badge(project.progress?.health),
    esc((project.members || []).map((member) => `${accountName(member.accountId)}（${t(member.role)}）`).join("、"))
  ])).join("");

  return [
    panel("创建项目", `
      <form class="form-grid" data-form="org-project-create">
        <div class="form-row"><label>项目名称</label><input name="name" required></div>
        <div class="notice">项目在当前组织配额内创建，创建人自动成为项目负责人。</div>
        <button class="primary-button" type="submit">创建项目</button>
      </form>
    `),
    panel("项目成员授权", renderProjectMemberForm()),
    panel("项目列表", table(["项目", "状态", "进度", "阶段", "健康度", "成员"], projectRows), {wide: true})
  ].join("");
}

/* ---------------- 成员：项目概览 ---------------- */

function renderProjectOverview() {
  const project = currentProject();
  if (!project) return panel("项目概览", `<div class="notice">当前账号暂无可见项目，请联系组织管理员分配。</div>`, {wide: true});
  const groups = projectTaskGroups();
  const openGroups = groups.filter((taskGroup) => !["closed", "aborted"].includes(taskGroup.status));
  const blockers = groups.flatMap((taskGroup) => taskGroup.blockers || []);
  const avgProgress = groups.length ? Math.round(groups.reduce((sum, taskGroup) => sum + Number(taskGroup.progress || 0), 0) / groups.length) : 0;
  const groupRows = groups.map((taskGroup) => row([
    `<strong>${esc(taskGroup.name || taskGroup.id)}</strong>`,
    badge(taskGroup.status),
    badge(taskGroup.phase),
    progressLine(taskGroup.progress),
    badge(taskGroup.health),
    {v: String((taskGroup.blockers || []).length), c: "num"}
  ])).join("");
  const repoRows = (state.repositoryOutputs || []).filter((target) => target.projectId === project.id).map((target) => row([
    esc(taskGroupNameOf(target.taskGroupId)),
    `<span class="mono">${esc(target.repositoryId)}</span>`,
    `<span class="mono">${esc(target.branch)}</span>`,
    badge(target.status),
    `<span class="mono">${esc((target.pathAllowlist || []).join("、"))}</span>`
  ])).join("");
  const events = (state.agentExecutionEvents || []).filter((event) => groups.some((taskGroup) => taskGroup.id === event.taskGroupId)).slice(0, 10).map((event) => row([
    {v: fmtTime(event.createdAt), c: "nowrap"},
    badge(event.eventType, "blue"),
    badge(event.status),
    {v: esc(event.summary || "-"), c: "text-clip"}
  ])).join("");

  return [
    panel(`项目进度 · ${esc(project.name)}`, `
      <div class="stack">
        ${progressLine(project.progress?.percent)}
        <div class="record-meta">
          <span>阶段：${badge(project.progress?.phase)}</span>
          <span>健康度：${badge(project.progress?.health)}</span>
          <span>项目状态：${badge(project.status)}</span>
          <span>更新时间：${fmtTime(project.progress?.updatedAt)}</span>
        </div>
      </div>
    `),
    panel("关键指标", `
      <div class="metric-grid">
        <div class="metric"><span>任务组</span><strong>${openGroups.length}/${groups.length}</strong></div>
        <div class="metric"><span>事项完成度</span><strong>${avgProgress}%</strong></div>
        <div class="metric"><span>受阻项</span><strong>${blockers.length}</strong></div>
        <div class="metric"><span>待人工确认</span><strong>${pendingConfirmCount}</strong></div>
      </div>
    `),
    panel("任务组一览", table(["任务组", "状态", "阶段", "进度", "健康度", {label: "受阻数", c: "num"}], groupRows), {wide: true}),
    panel("最新执行事件", table([{label: "时间", c: "nowrap"}, "事件", "状态", {label: "摘要", c: "text-clip"}], events)),
    panel("仓库产出归属", table(["任务组", "仓库", "分支", "状态", "允许路径"], repoRows))
  ].join("");
}

function taskGroupById(taskGroupId) {
  return (state.taskGroups || []).find((taskGroup) => taskGroup.id === taskGroupId) || null;
}
function taskGroupNameOf(taskGroupId) {
  return (state.taskGroups || []).find((taskGroup) => taskGroup.id === taskGroupId)?.name || taskGroupId || "-";
}

/* ---------------- 成员：任务组 ---------------- */

const LANGUAGE_OPTIONS = [
  ["zh-CN", "中文"],
  ["en", "English"],
  ["ja", "日本語"],
  ["fr", "Français"],
  ["de", "Deutsch"],
  ["es", "Español"]
];

function languageSelectOptions(selected) {
  const known = LANGUAGE_OPTIONS.some(([value]) => value === selected);
  const options = known || !selected ? LANGUAGE_OPTIONS : [[selected, selected], ...LANGUAGE_OPTIONS];
  return options.map(([value, label]) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(label)} · ${esc(value)}</option>`).join("");
}

function renderTaskGroups() {
  const groups = projectTaskGroups();
  const canControl = hasPerm("task_group:control");
  const canReview = hasPerm("task_group:review");
  const roleOptions = [...new Set(["orchestrator", "agent-runtime", "reviewer", "qa", "security", "release", "monitor"])]
    .map((role) => `<option value="${esc(role)}">${esc(t(role))} (${esc(role)})</option>`).join("");

  const createPanels = !canControl ? [] : [
    panel("创建任务组", `
      <form class="form-grid" data-form="task-group-create">
        <div class="form-row"><label>任务组名称</label><input name="name" required></div>
        <div class="form-row"><label>目标描述</label><textarea name="objective" required placeholder="描述该任务组要达成的目标"></textarea></div>
        <div class="form-row"><label>统一语言</label><select name="languageTag">${languageSelectOptions("zh-CN")}</select></div>
        <div class="form-row"><label>初始角色（逗号分隔）</label><input name="roles" value="orchestrator,agent-runtime,reviewer"></div>
        ${currentProjectId ? "" : `<div class="notice warn-notice">当前无可见项目，无法创建任务组。</div>`}
        <button class="primary-button" type="submit" ${currentProjectId ? "" : "disabled"}>创建任务组</button>
      </form>
    `),
    panel("创建工作项", `
      <form class="form-grid" data-form="work-item-create">
        <div class="form-row"><label>所属任务组</label>
          <select name="taskGroupId" ${groups.length ? "" : "disabled"}>${groups.map((taskGroup) => `<option value="${esc(taskGroup.id)}">${esc(taskGroup.name || taskGroup.id)}</option>`).join("")}</select>
        </div>
        <div class="form-row"><label>工作项标题</label><input name="title" required></div>
        <div class="form-row"><label>执行角色</label><select name="ownerRole">${roleOptions}</select></div>
        <div class="form-row"><label>机器可执行要求（每行一条）</label><textarea name="requirements" placeholder="每行一条约束或验收条件"></textarea></div>
        ${groups.length ? "" : `<div class="notice">先创建任务组后再追加工作项。</div>`}
        <button class="primary-button" type="submit" ${groups.length ? "" : "disabled"}>创建工作项</button>
      </form>
    `)
  ];

  const groupPanels = groups.map((taskGroup) => {
    const expanded = expandedTaskGroupId === taskGroup.id;
    const head = `
      <div class="stack">
        <div class="record-title">
          ${badge(taskGroup.status)} ${badge(taskGroup.phase)} ${badge(taskGroup.health)} ${badge(taskGroup.goalExecutionStatus || "active")}
        </div>
        ${progressLine(taskGroup.progress)}
        <div class="record-meta">
          <span>语言：${esc(taskGroup.languagePolicy?.languageName || taskGroup.languagePolicy?.languageTag || "中文")}</span>
          <span>角色数：${(taskGroup.roles || []).length}</span>
          <span>工作项：${(taskGroup.workItems || []).length}</span>
          <span>更新时间：${fmtTime(taskGroup.updatedAt)}</span>
        </div>
        <div class="button-row">
          <button class="secondary-button" data-action="tg-detail" data-task="${esc(taskGroup.id)}">${expanded ? "收起详情" : "查看详情"}</button>
          ${canControl ? `<button class="secondary-button" data-action="task-control" data-task="${esc(taskGroup.id)}" data-task-action="pause">暂停</button>
          <button class="secondary-button" data-action="task-control" data-task="${esc(taskGroup.id)}" data-task-action="resume">恢复</button>` : ""}
          ${canReview || canControl ? `<button class="secondary-button" data-action="task-control" data-task="${esc(taskGroup.id)}" data-task-action="request_review">请求评审</button>` : ""}
          ${canControl ? `<button class="danger-button" data-action="task-control" data-task="${esc(taskGroup.id)}" data-task-action="rebound_drift">纠偏</button>` : ""}
        </div>
        ${expanded ? renderTaskGroupDetail(taskGroup) : ""}
      </div>
    `;
    return panel(taskGroup.name || taskGroup.id, head, {wide: true});
  }).join("");

  return createPanels.join("") + (groupPanels || panel("任务组", `<div class="notice">当前项目暂无任务组。</div>`, {wide: true}));
}

function renderTaskGroupDetail(taskGroup) {
  if (!tgDetail || tgDetail.taskGroupId !== taskGroup.id) {
    return `<div class="notice">正在加载任务组详情…</div>`;
  }
  const progressData = tgDetail.progress || {};
  const analysis = progressData.taskAnalysis;
  const analysisHtml = analysis && (analysis.items || []).length
    ? `<div class="tree">${(analysis.items || []).map((item) => `
        <div class="tree-item">
          <div class="tree-head">${customBadge(kindLabel(item.kind), "gray")} <strong>${esc(item.title)}</strong> ${badge(item.status)} <em class="small muted">${item.progress ?? 0}%</em></div>
          ${progressBar(item.progress)}
          ${item.note ? `<div class="tree-note">${esc(item.note)}</div>` : ""}
          ${(item.children || []).length ? `<div class="tree-children">${item.children.map((child) => `
            <div class="tree-item minor">
              <div class="tree-head">${customBadge(kindLabel(child.kind), "gray")} ${esc(child.title)} ${badge(child.status)} <em class="small muted">${child.progress ?? 0}%</em></div>
              ${child.note ? `<div class="tree-note">${esc(child.note)}</div>` : ""}
            </div>
          `).join("")}</div>` : ""}
        </div>
      `).join("")}</div>`
    : `<div class="notice">事项清单尚未生成（编排启动后自动生成）。</div>`;

  const roles = (progressData.roles || taskGroup.roles || []).map((role) => `
    <div class="record">
      <div class="record-title">
        <strong>${esc(t(role.roleId))}</strong><span class="mono small muted">${esc(role.roleId)}</span>
        ${badge(role.status)}
        ${role.addedBy === "auto" ? customBadge("自动加入", "orange") : role.addedBy === "inherited" ? customBadge("继承项目", "gray") : customBadge("手动添加", "blue")}
      </div>
      ${role.addedAt ? `<div class="record-meta"><span>加入时间：${fmtTime(role.addedAt)}</span></div>` : ""}
    </div>
  `).join("") || `<div class="notice">暂无角色记录。</div>`;

  const config = tgDetail.config;
  const canControl = hasPerm("task_group:control");
  const editDisabled = canControl ? "" : "disabled";
  const configHtml = config ? `
    <div class="stack">
      <div class="record-title">
        <strong>配置来源：</strong>
        ${config.configSource === "customized" ? customBadge("已自定义", "orange") : customBadge("继承项目", "green")}
        ${config.configSource === "customized" && canControl ? `<button class="danger-button" data-action="tg-config-reset" data-task="${esc(taskGroup.id)}">重置为继承项目</button>` : ""}
      </div>
      ${canControl ? "" : `<div class="notice warn-notice">当前账号无“任务组控制”权限，配置为只读。</div>`}
      ${sectionBlock("系统规则（默认 / 项目 / 任务组）", ruleEditorForm({
        rules: config.systemRules || [],
        listId: "tg-system-rules",
        category: "system",
        layer: "task_group",
        task: taskGroup.id,
        readOnly: !canControl,
        note: "展示解析结果：徽标标明来自默认、项目、任务组。可在任务组层停用、改写或新增。"
      }))}
      ${sectionBlock("业务规则（默认 / 项目 / 任务组）", ruleEditorForm({
        rules: config.businessRules || [],
        listId: "tg-business-rules",
        category: "business",
        layer: "task_group",
        task: taskGroup.id,
        readOnly: !canControl,
        note: "任务组层可覆盖项目业务规则，或新增仅本任务组生效的规则。"
      }))}
      <form class="form-grid" data-form="tg-config" data-task="${esc(taskGroup.id)}">
        <div class="form-row"><label>默认角色（逗号分隔角色 ID）</label>
          <input name="defaultRoles" data-orig="${esc((config.defaultRoles || []).map((role) => role.roleId || role).join(","))}" value="${esc((config.defaultRoles || []).map((role) => role.roleId || role).join(","))}" ${editDisabled}>
        </div>
        <div class="record-meta">
          <span>仓库配置：${(config.repositories || []).length} 条（在“项目设置”维护，任务组可覆盖）</span>
          <span>基线数据：${(config.baselineData || []).length} 条</span>
        </div>
        <button class="primary-button" type="submit" ${editDisabled}>保存默认角色</button>
      </form>
    </div>
  ` : `<div class="notice">暂时无法读取任务组配置。</div>`;

  const languagePolicy = taskGroup.languagePolicy || {languageTag: "zh-CN"};
  const controlHtml = canControl ? `
    <div class="stack">
      <div class="button-row">
        <button class="secondary-button" data-action="task-control" data-task="${esc(taskGroup.id)}" data-task-action="pause">暂停执行</button>
        <button class="secondary-button" data-action="task-control" data-task="${esc(taskGroup.id)}" data-task-action="resume">恢复执行</button>
        <button class="secondary-button" data-action="task-control" data-task="${esc(taskGroup.id)}" data-task-action="request_review">请求评审</button>
      </div>
      <form class="form-grid" data-form="language-policy" data-language-policy-form data-task="${esc(taskGroup.id)}">
        <div class="form-row"><label>任务组统一语言</label><select name="languageTag">${languageSelectOptions(languagePolicy.languageTag || "zh-CN")}</select></div>
        <button class="primary-button" type="submit">保存语言策略</button>
      </form>
    </div>
  ` : `<div class="notice">当前账号无“任务组控制”权限，仅可查看。当前统一语言：${esc(languagePolicy.languageName || languagePolicy.languageTag || "中文")}。</div>`;

  const workItems = (progressData.workItems || taskGroup.workItems || []).map((workItem) => {
    const dispatch = findWorkItemDispatch(taskGroup.id, workItem.id);
    return `
      <div class="record">
        <div class="record-title"><strong>${esc(workItem.title)}</strong>${badge(workItem.status)}</div>
        ${progressLine(workItem.progress)}
        <div class="record-meta"><span>执行角色：${esc(t(workItem.ownerRole))}</span>${workItem.blockedReason ? `<span>受阻原因：${esc(t(workItem.blockedReason))}</span>` : ""}</div>
        ${dispatch ? `
          <div class="record-meta"><span>派发：<span class="mono">${esc(dispatch.dispatchId)}</span></span><span>${badge(dispatch.status)} ${esc(dispatch.progressPercent || 0)}%</span></div>
          <div class="button-row"><button class="secondary-button" data-action="show-dispatch-events" data-dispatch-id="${esc(dispatch.dispatchId)}">实时事件</button></div>
        ` : ""}
      </div>
    `;
  }).join("");

  const blockers = (progressData.blockers || taskGroup.blockers || []).map((blocker) => `
    <div class="record"><div class="record-title">${badge(blocker.severity || "attention")} <span>${esc(blocker.summary)}</span></div></div>
  `).join("") || `<div class="record">无阻塞</div>`;

  const guard = taskGroup.singleCellEscalationGuard;
  const cellIds = (ids) => (ids || []).length ? (ids || []).map((id) => esc(id)).join("、") : "—";
  const admissionHtml = guard ? `
      <div class="record-meta">
        <span>可执行 cell：${(guard.executableCells || []).length}</span>
        <span>等待 cell：${(guard.waitingCells || []).length}</span>
        <span>阻塞 cell：${(guard.blockedCells || []).length}</span>
        <span>整体阻断：${guard.overallBlockedPermitted ? customBadge("允许", "red") : customBadge("不允许（仍有可推进项）", "green")}</span>
      </div>
      <div class="small muted">可执行：${cellIds(guard.executableCells)}</div>
      <div class="small muted">等待（不升格）：${cellIds(guard.waitingCells)}</div>
      <div class="small muted">真实阻断：${cellIds(guard.escalatableBlockedCells)}</div>
    ` : `<div class="notice">暂无准入分类（编排运行后自动生成）。</div>`;

  return `
    <div class="stack" style="margin-top:8px;">
      ${sectionBlock("事项清单", analysisHtml)}
      ${sectionBlock("角色列表", `<div class="stack">${roles}</div>`)}
      ${sectionBlock("配置（继承 / 自定义）", configHtml)}
      ${sectionBlock("执行控制", controlHtml)}
      ${sectionBlock("工作项", `<div class="stack">${workItems || `<div class="notice">暂无工作项。</div>`}</div>`)}
      ${sectionBlock("准入与阻断分类", admissionHtml)}
      ${sectionBlock("阻塞", `<div class="stack">${blockers}</div>`)}
    </div>
  `;
}

function sectionBlock(title, body) {
  return `<div class="record" style="background:#fff;"><div class="record-title"><strong>${esc(title)}</strong></div><div style="margin-top:8px;">${body}</div></div>`;
}

function cfgBusinessRow(rule = {}) {
  return `
    <div class="cfg-row" data-cfg-kind="business">
      <input name="brTitle" placeholder="规则标题" value="${esc(rule.title || "")}">
      <textarea name="brContent" placeholder="规则内容">${esc(rule.content || "")}</textarea>
      <button type="button" class="danger-button" data-action="cfg-del">删除</button>
    </div>
  `;
}

/* ---------------- 规则管理（系统规则 / 业务规则） ----------------
 * 三级继承：默认 → 项目 → 任务组。GET /config 返回解析后的规则视图，
 * 每条含 {ruleId, category, title, content, status, enabled, source, contentDigest}。
 * 保存时按“本层覆盖片段”提交（只提交本层既有覆盖 + 本次改动 / 新增 / 停用的条目）。
 */

function ruleOwnedAtLayer(source, layer) {
  return String(source || "").split("+").includes(layer);
}

function ruleSourceBadge(source) {
  const parts = String(source || "").split("+");
  if (parts.includes("task_group")) return customBadge("任务组", "orange");
  if (parts.includes("project")) return customBadge("项目", "blue");
  return customBadge("默认", "gray");
}

function ruleRow(rule, layer, readOnly = false) {
  const source = String(rule.source || "");
  const isDefault = source.split("+").includes("default");
  const owned = ruleOwnedAtLayer(source, layer);
  const enabled = rule.enabled !== false && (rule.status ? rule.status === "active" : true);
  const canDelete = owned && !isDefault && !readOnly; // 本层新增（非默认）规则可删除
  const ro = readOnly ? "readonly" : "";
  return `
    <div class="rule-row ${enabled ? "" : "disabled"}"
      data-rule-row
      data-rule-id="${esc(rule.ruleId || "")}"
      data-rule-category="${esc(rule.category || "")}"
      data-rule-source="${esc(source)}"
      data-orig-enabled="${enabled ? "1" : "0"}"
      data-orig-content="${esc(rule.content || "")}"
      data-orig-title="${esc(rule.title || "")}">
      <div class="rule-head">
        <input class="rule-title-input" name="ruleTitle" maxlength="256" value="${esc(rule.title || "")}" ${(isDefault || readOnly) ? "readonly" : ""} placeholder="规则标题">
        ${ruleSourceBadge(source)}
        <label class="rule-toggle"><input type="checkbox" name="ruleEnabled" ${enabled ? "checked" : ""} ${readOnly ? "disabled" : ""}> 启用</label>
        ${canDelete ? `<button type="button" class="danger-button" data-action="rule-del">删除</button>` : ""}
      </div>
      <textarea name="ruleContent" maxlength="8192" ${ro} placeholder="规则内容（可改写默认内容）">${esc(rule.content || "")}</textarea>
    </div>
  `;
}

function ruleRowNew(category) {
  return `
    <div class="rule-row" data-rule-row data-rule-category="${esc(category)}" data-rule-source="" data-orig-enabled="1" data-orig-content="" data-orig-title="">
      <div class="rule-head">
        <input class="rule-id-input" name="ruleId" maxlength="128" placeholder="规则 ID（可留空自动生成）">
        <input class="rule-title-input" name="ruleTitle" maxlength="256" placeholder="规则标题">
        <label class="rule-toggle"><input type="checkbox" name="ruleEnabled" checked> 启用</label>
        <button type="button" class="danger-button" data-action="rule-del">删除</button>
      </div>
      <textarea name="ruleContent" maxlength="8192" placeholder="规则内容"></textarea>
    </div>
  `;
}

function ruleEditorForm(opts) {
  const {rules, listId, category, layer, project, task, readOnly} = opts;
  const formAttr = layer === "project"
    ? `data-form="project-rules" data-project="${esc(project || "")}"`
    : `data-form="tg-rules" data-task="${esc(task || "")}"`;
  const catLabel = category === "system" ? "系统" : "业务";
  const disabled = readOnly ? "disabled" : "";
  return `
    <form class="form-grid" ${formAttr} data-category="${esc(category)}" data-list="${esc(listId)}">
      ${opts.note ? `<div class="notice">${opts.note}</div>` : ""}
      <div class="rule-list" data-cfg-list="${esc(listId)}">
        ${(rules || []).map((rule) => ruleRow(rule, layer, readOnly)).join("") || `<div class="small muted">暂无规则。</div>`}
      </div>
      <div class="button-row">
        <button type="button" class="secondary-button" data-action="rule-add" data-target="${esc(listId)}" data-category="${esc(category)}" ${disabled}>新增${catLabel}规则</button>
        <button class="primary-button" type="submit" ${disabled}>保存${catLabel}规则</button>
      </div>
    </form>
  `;
}

function collectRuleFragments(form, layer) {
  const listId = form.dataset.list;
  const category = form.dataset.category;
  const rows = [...form.querySelectorAll(`[data-cfg-list='${listId}'] [data-rule-row]`)];
  const fragments = [];
  for (const rowEl of rows) {
    const idFromData = rowEl.dataset.ruleId || "";
    const idFromInput = rowEl.querySelector("input[name='ruleId']")?.value?.trim() || "";
    const ruleId = (idFromData || idFromInput).trim();
    const title = rowEl.querySelector("input[name='ruleTitle']")?.value?.trim() || "";
    const content = rowEl.querySelector("textarea[name='ruleContent']")?.value ?? "";
    const enabled = Boolean(rowEl.querySelector("input[name='ruleEnabled']")?.checked);
    const source = rowEl.dataset.ruleSource || "";
    const owned = source.split("+").includes(layer);
    const isNew = !source;
    const enabledChanged = enabled !== (rowEl.dataset.origEnabled === "1");
    const contentChanged = content !== (rowEl.dataset.origContent || "");
    const titleChanged = title !== (rowEl.dataset.origTitle || "");
    const dirty = enabledChanged || contentChanged || titleChanged;
    // 未在本层改动、且非本层既有覆盖的默认/继承项不提交，保持继承
    if (!owned && !isNew && !dirty) continue;
    if (isNew && !title && !content) continue;
    const fragment = {category, enabled};
    if (ruleId) fragment.ruleId = ruleId;
    // 仅当本行内容并非「权威地存放在本层覆盖」时，才允许在纯切换启用状态时省略正文：
    // - owned（source 含本层）：正文就存在本层覆盖里，服务端整体替换本层覆盖后无法从下层找回，必须携带；
    // - isNew / 无 ruleId：新规则或需用内容派生 id 的规则，必须携带；
    // - 标题/内容被编辑：显然要携带。
    // 其余（仅从下层继承的默认/继承项）省略正文，避免仅切换启用状态就把上游正文冻结为旧文本。
    if (isNew || !ruleId || owned || titleChanged || contentChanged) {
      fragment.title = title;
      fragment.content = content;
      fragment.status = "active";
    }
    fragments.push(fragment);
  }
  return fragments;
}

const terminalDispatchStatuses = new Set(["completed", "failed", "cancelled"]);

function findWorkItemDispatch(taskGroupId, workItemId) {
  const candidates = (state.agentDispatches || [])
    .filter((dispatch) => dispatch.taskGroupId === taskGroupId && dispatch.workItemId === workItemId)
    .sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
  return candidates.find((dispatch) => !terminalDispatchStatuses.has(dispatch.status)) || candidates[0] || null;
}

/* ---------------- 成员：人工审核 ---------------- */

function taskGroupSelector(selectedId, selectName) {
  const groups = projectTaskGroups();
  return `
    <select data-select="${selectName}">
      ${groups.map((taskGroup) => `<option value="${esc(taskGroup.id)}" ${taskGroup.id === selectedId ? "selected" : ""}>${esc(taskGroup.name || taskGroup.id)}</option>`).join("")}
    </select>
  `;
}

function renderReview() {
  if (!projectTaskGroups().length) {
    return panel("人工审核", `<div class="notice">当前项目暂无任务组。</div>`, {wide: true});
  }
  const canReview = hasPerm("task_group:review");
  // 集中处理：汇总项目内全部任务组的人工确认（tasks 视角已按可见任务组下发），而非逐组切换
  const projectTaskGroupIds = new Set(projectTaskGroups().map((taskGroup) => taskGroup.id));
  const allRequests = (state.humanConfirmationRequests || []).filter((request) => projectTaskGroupIds.has(request.taskGroupId)).slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const pending = allRequests.filter((request) => request.status === "pending");
  const answered = allRequests.filter((request) => request.status !== "pending");

  const pendingHtml = pending.length ? pending.map((request) => `
    <div class="record">
      <div class="record-title"><strong>${esc(request.question?.summary || "-")}</strong>${badge(request.status)}${request.decisionClass === "major" ? customBadge("核心决策 · 必须人工定稿", "red") : ""}${request.blocking ? customBadge("阻塞执行", "orange") : ""}</div>
      ${request.question?.detail ? `<div class="record-meta"><span class="confirm-detail">${esc(request.question.detail)}</span></div>` : ""}
      <div class="record-meta">
        <span>任务组：${esc(taskGroupNameOf(request.taskGroupId))}</span>
        ${request.decisionType ? `<span>决策类型：${esc(t(request.decisionType) || request.decisionType)}</span>` : ""}
        ${request.workItemId ? `<span>工作项：<span class="mono">${esc(request.workItemId)}</span></span>` : ""}
        <span>提交时间：${fmtTime(request.createdAt)}</span>
        <span>过期时间：${fmtTime(request.expiresAt)}</span>
      </div>
      ${request.peerReview ? `<div class="notice" style="margin-top:8px;">
        <strong>AI 互审结论（仅供参考，不构成确认）：</strong>${esc(t(request.peerReview.verdict) || request.peerReview.verdict)}
        ${(request.peerReview.findings || []).length ? `<br>发现事项：${esc((request.peerReview.findings || []).map((f) => t(f) || f).join("、"))}` : ""}
        ${(request.peerReview.alternativesConsidered || []).length ? `<br><strong>考察过的其他方案：</strong>${(request.peerReview.alternativesConsidered || []).map((alt) => `<br>· ${esc(alt.alternative)} —— ${esc(alt.assessment)}`).join("")}` : `<br><em>（本次未记录其他候选方案）</em>`}
      </div>` : ""}
      ${canReview ? `<form class="form-grid" data-form="hcr-decide" data-request="${esc(request.requestId)}" data-round="${esc(String(request.round || 1))}" style="margin-top:10px;">
        <div class="option-list">
          ${(request.options || []).map((option, index) => `
            <label class="option-item">
              <input type="radio" name="selectedOptionId" value="${esc(option.optionId)}" ${option.recommended || (index === 0 && !(request.options || []).some((item) => item.recommended)) ? "checked" : ""}>
              <span class="option-text">
                <strong>${esc(option.label)} ${option.recommended ? customBadge("AI 推荐", "blue") : ""} ${option.optionId === "none" ? customBadge("自定义", "gray") : ""}</strong>
                ${option.description ? `<span>${esc(option.description)}</span>` : ""}
              </span>
            </label>
          `).join("")}
        </div>
        <div class="form-row"><label>你的意见 / 自己的方案（选择“不选择（自定义输入）”时必填）</label><textarea name="inputText" placeholder="可以直接提出你自己的方案；提交修改意见后由 AI 再分析是否可行、有无更优方式，你再决定是否定稿"></textarea></div>
        <div class="button-row">
          <button class="secondary-button" type="submit" name="action" value="revise">提交修改意见（交 AI 再分析）</button>
          <button class="primary-button" type="submit" name="action" value="finalize">选择定稿（此后 AI 不再更改）</button>
          <button class="danger-button" type="submit" name="action" value="reject">打回返工</button>
        </div>
        <div class="notice" style="margin-top:6px;">定稿前可与 AI 多轮协商：你提方案 → AI 再分析（可提出不合理之处或更优方式）→ 你再决定。只有点“选择定稿”才锁定。</div>
      </form>` : `<div class="notice warn-notice" style="margin-top:10px;">当前账号无“人工审核”权限，仅可查看待确认问题。</div>`}
      ${(request.deliberation || []).length ? `<div class="record-meta" style="margin-top:8px;display:block;">
        <strong>协商记录（第 ${esc(String(request.round || 1))} 轮${request.awaitingAiAnalysis ? "，等待 AI 再分析" : ""}）</strong>
        ${(request.deliberation || []).map((turn) => `<div>· ${turn.actorKind === "ai" ? "AI" : esc(accountName(turn.actor))}｜${esc(t(turn.action) || turn.action)}${turn.assessment ? `（${esc(t(turn.assessment) || turn.assessment)}）` : ""}：${esc(turn.summary)}</div>`).join("")}
      </div>` : ""}
    </div>
  `).join("") : `<div class="notice">当前项目没有待确认的问题。</div>`;

  const answeredRows = answered.map((request) => row([
    {v: esc(request.question?.summary || "-"), c: "text-clip"},
    badge(request.status),
    esc(request.decision?.selectedLabel || request.decision?.selectedOptionId || "-"),
    {v: esc(request.decision?.inputText || "-"), c: "text-clip"},
    esc(request.decision?.decidedBy ? accountName(request.decision.decidedBy) : "-"),
    {v: fmtTime(request.decision?.decidedAt || request.updatedAt), c: "nowrap"}
  ])).join("");

  const pendingPermissions = (state.permissionRequests || []).filter((item) => projectTaskGroupIds.has(item.taskGroupId) && item.status === "pending_approval");
  const pendingApprovals = (state.approvalRequests || []).filter((item) => projectTaskGroupIds.has(item.taskGroupId) && ["requested", "quorum_collecting"].includes(item.status));
  const openFindings = (state.findings || []).filter((item) => projectTaskGroupIds.has(item.taskGroupId) && !["resolved", "closed", "dismissed", "wontfix"].includes(item.status));
  const canGrant = hasPerm("project:grant");
  // blocked_external is omitted: the console can't collect the rootCauseOwner/recoveryRef the server
  // requires to keep it terminal, so it would always downgrade to a still-blocking class (use the
  // governance MCP path for that disposition).
  const dispositionHtml = ["fixed_verified", "not_applicable", "scope_adjusted"]
    .map((cls) => `<option value="${cls}">${esc(t(cls))}</option>`).join("");
  const authDispositionHtml = `
    <div class="stack">
      <div class="record-meta"><span>授权请求 ${pendingPermissions.length} · 审批请求 ${pendingApprovals.length} · 待处置发现 ${openFindings.length}（均阻塞关闭门禁）</span></div>
      ${!canReview && !canGrant ? `<div class="notice warn-notice">当前账号无“人工审核 / 授权”权限，仅可查看。</div>` : ""}
      ${pendingPermissions.map((item) => `
        <div class="record">
          <div class="record-title"><strong>授权请求：${esc(item.permission || "-")}</strong>${badge(item.status)}</div>
          <div class="record-meta"><span>任务组：${esc(taskGroupNameOf(item.taskGroupId))}</span><span>主体：${esc(item.subjectId || "-")}</span><span>原因：${esc(item.reason || "-")}</span><span>${fmtTime(item.createdAt)}</span></div>
          ${canGrant ? `<form class="form-grid" data-form="perm-resolve" data-request="${esc(item.requestId)}" style="margin-top:8px;">
            <div class="button-row"><button class="primary-button" type="submit" name="status" value="approved">批准</button><button class="secondary-button" type="submit" name="status" value="rejected">拒绝</button></div>
          </form>` : `<div class="notice">需“授权(project:grant)”权限处理。</div>`}
        </div>`).join("")}
      ${pendingApprovals.map((item) => `
        <div class="record">
          <div class="record-title"><strong>审批请求：${esc(item.summary || item.action || "-")}</strong>${badge(item.status)}</div>
          <div class="record-meta"><span>任务组：${esc(taskGroupNameOf(item.taskGroupId))}</span><span>${fmtTime(item.createdAt)}</span></div>
          ${canReview ? `<form class="form-grid" data-form="approval-resolve" data-request="${esc(item.approvalId)}" style="margin-top:8px;">
            <div class="btn-row"><button class="primary-button" type="submit" name="status" value="approved">批准</button><button class="ghost-button" type="submit" name="status" value="rejected">驳回</button></div>
          </form>` : ""}
        </div>`).join("")}
      ${openFindings.map((item) => `
        <div class="record">
          <div class="record-title"><strong>发现：${esc(item.summary || item.title || item.findingId)}</strong>${badge(item.status)}${item.severity ? customBadge(t(item.severity), "orange") : ""}</div>
          <div class="record-meta"><span>任务组：${esc(taskGroupNameOf(item.taskGroupId))}</span><span>${fmtTime(item.createdAt)}</span></div>
          ${canReview ? `<form class="form-grid" data-form="finding-resolve" data-request="${esc(item.findingId)}" style="margin-top:8px;">
            <div class="form-row"><label>处置类别</label><select name="dispositionClass">${dispositionHtml}</select></div>
            <div class="form-row"><label>处置状态</label><select name="status"><option value="resolved">已解决</option><option value="closed">已关闭</option><option value="dismissed">已忽略</option><option value="wontfix">不修复</option></select></div>
            <div class="form-row"><label>证据引用（可选，逗号分隔）</label><input name="evidenceRefs" placeholder="evidence:..."></div>
            <button class="primary-button" type="submit">提交处置</button>
          </form>` : ""}
        </div>`).join("")}
      ${!pendingPermissions.length && !pendingApprovals.length && !openFindings.length ? `<div class="notice">当前项目没有待处置的授权 / 审批 / 发现。</div>` : ""}
    </div>`;

  return [
    panel("待人工确认", `
      <div class="stack">
        <div class="record-meta"><span>共 ${pending.length} 条待确认，覆盖 ${new Set(pending.map((item) => item.taskGroupId)).size} 个任务组（按提交时间倒序）</span></div>
        ${pendingHtml}
      </div>
    `, {wide: true}),
    panel("授权与处置", authDispositionHtml, {wide: true}),
    panel("已答历史", table([{label: "问题", c: "text-clip"}, "状态", "所选选项", {label: "确认内容", c: "text-clip"}, "确认人", {label: "确认时间", c: "nowrap"}], answeredRows), {wide: true})
  ].join("");
}

/* ---------------- 成员：人工指令 ---------------- */

const DIRECTIVE_TYPES = [
  ["pause", "暂停执行"],
  ["resume", "恢复执行"],
  ["cancel", "取消任务"],
  ["adjust_priority", "调整优先级"],
  ["add_requirement", "补充要求"],
  ["resolve_decision", "决策处置（重开 / 放弃）"],
  ["free_text", "自由指令"]
];

function renderDirectives() {
  if (!projectTaskGroups().length) {
    return panel("人工指令", `<div class="notice">当前项目暂无任务组。</div>`, {wide: true});
  }
  const directiveRows = directiveList.map((directive) => row([
    {v: fmtTime(directive.createdAt), c: "nowrap"},
    badge(directive.directiveType, "blue"),
    {v: esc(directive.instruction || "-"), c: "text-clip"},
    badge(directive.status),
    {v: esc((directive.appliedActions || []).map((action) => t(action.action)).join("、") || "-"), c: "text-clip"},
    esc(directive.rejectReason ? t(directive.rejectReason) : "-")
  ])).join("");

  const canControl = hasPerm("task_group:control");
  const formHtml = canControl ? `
        <form class="form-grid" data-form="directive-create">
          <div class="form-row"><label>目标任务组</label>${taskGroupSelector(directiveTaskGroupId, "directive-tg")}</div>
          <div class="form-row"><label>指令类型</label>
            <select name="directiveType">${DIRECTIVE_TYPES.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join("")}</select>
          </div>
          <div class="form-row"><label>决策处置方式</label>
            <select name="resolution"><option value="reopen">重开（返回就绪，重置返工计数）</option><option value="abandon">放弃（置为已替代，解除关闭阻塞）</option></select>
            <span class="small muted">仅“决策处置”类型生效</span>
          </div>
          <div class="form-row"><label>目标工作项 ID</label><input name="workItemId" placeholder="仅“决策处置”可选：留空则处置该组全部待决策项" /></div>
          <div class="form-row"><label>指令内容</label><textarea name="instruction" placeholder="补充要求 / 自由指令必填，其余类型可选"></textarea></div>
          <button class="primary-button" type="submit">提交指令</button>
        </form>
  ` : `<div class="notice warn-notice">当前账号无“任务组控制 / 人工指令”权限，仅可查看指令流水。</div>`;

  return [
    panel("下达人工指令", `
      <div class="stack">
        <div class="notice">总控与调度会话不接受人工直接输入。所有人工操作通过本通道生成结构化指令，由编排周期作为决策输入消费并全程留审计。</div>
        ${formHtml}
      </div>
    `, {wide: true}),
    panel("指令流水", table([{label: "时间", c: "nowrap"}, "类型", {label: "指令内容", c: "text-clip"}, "状态", {label: "已执行动作", c: "text-clip"}, "拒绝原因"], directiveRows), {wide: true, headerSide: filterInput("按指令内容过滤…", "directives")})
  ].join("");
}

/* ---------------- 成员：执行监控 ---------------- */

function renderMonitor() {
  const groups = projectTaskGroups();
  const scopeOptions = [
    ...groups.map((taskGroup) => ({value: `taskGroup:${taskGroup.id}`, label: `任务组 · ${taskGroup.name || taskGroup.id}`}))
  ];
  const scopeValue = execScope.id ? `${execScope.type}:${execScope.id}` : "";
  if (execScope.id && !scopeOptions.some((option) => option.value === scopeValue)) {
    scopeOptions.unshift({value: scopeValue, label: `${execScope.type === "dispatch" ? "派发" : execScope.type === "session" ? "会话" : "任务组"} · ${execScope.id}`});
  }

  const eventsShown = filterSource(execEvents.slice().reverse(), "events");
  const eventRows = eventsShown.slice(0, 120).map((event) => row([
    {v: esc(event.sequence), c: "num"},
    badge(event.eventType, "blue"),
    {v: `${esc(event.progressPercent ?? 0)}%`, c: "num"},
    badge(event.status),
    {v: esc(event.summary || "-"), c: "text-clip"},
    {v: fmtTime(event.createdAt), c: "nowrap"}
  ])).join("");

  const LANE_STATUS = {idle: {label: "空闲", tone: "green"}, busy: {label: "占用中", tone: "blue"}, retired: {label: "已归档", tone: "gray"}};
  const lanesAll = filterSource((state.workerLanes || []).filter((lane) => groups.some((taskGroup) => taskGroup.id === lane.taskGroupId)), "worker-lanes");
  const laneRows = lanesAll.slice(0, 20).map((lane) => row([
    esc(t(lane.roleId)),
    esc(laneFunctionLabel(lane.laneFunction)),
    customBadge((LANE_STATUS[lane.status] || {label: lane.status}).label, (LANE_STATUS[lane.status] || {}).tone || "gray"),
    {v: String(lane.reuseGeneration ?? 0), c: "num"},
    lane.currentSessionId ? {v: `<span class="mono">${esc(lane.currentSessionId)}</span>`, c: "nowrap"} : "-",
    {v: fmtTime(lane.updatedAt), c: "nowrap"}
  ])).join("");

  const sessionsAll = filterSource((state.workSessions || []).filter((session) => groups.some((taskGroup) => taskGroup.id === session.taskGroupId)), "sessions");
  const sessions = sessionsAll.slice(0, 20).map((session) => row([
    `<span class="mono">${esc(session.sessionId)}</span>`,
    esc(t(session.roleId)),
    `<span class="mono">${esc(session.workItemId || "-")}</span>`,
    badge(session.placement),
    session.laneId ? {v: `<span class="mono">${esc(session.laneId)}</span>`, c: "nowrap"} : "-",
    badge(session.status),
    `<button class="secondary-button" data-action="show-session-events" data-session-id="${esc(session.sessionId)}">事件</button>`
  ])).join("");

  const dispatchesAll = filterSource((state.agentDispatches || []).filter((dispatch) => groups.some((taskGroup) => taskGroup.id === dispatch.taskGroupId)), "dispatches");
  const dispatches = dispatchesAll.slice(0, 20).map((dispatch) => row([
    `<span class="mono">${esc(dispatch.dispatchId)}</span>`,
    `<span class="mono">${esc(dispatch.workItemId || "-")}</span>`,
    badge(dispatch.status),
    {v: `${esc(dispatch.progressPercent || 0)}%`, c: "num"},
    esc(dispatch.blockedReason || dispatch.failureReason ? t(dispatch.blockedReason || dispatch.failureReason) : "-"),
    `<button class="secondary-button" data-action="show-dispatch-events" data-dispatch-id="${esc(dispatch.dispatchId)}">事件</button>`
  ])).join("");

  const commands = (state.agentControlCommands || []).slice(0, 16).map((command) => row([
    {v: esc(command.sequence), c: "num"},
    `<span class="mono">${esc(command.nodeId)}</span>`,
    badge(command.commandType, "blue"),
    `<span class="mono">${esc(command.dispatchId || command.sessionId || "-")}</span>`,
    badge(command.status),
    {v: fmtTime(command.updatedAt || command.createdAt), c: "nowrap"}
  ])).join("");

  const canControlNodes = hasPerm("agent:activate");
  const canOrchestrate = hasPerm("task_group:orchestrate");
  const nodes = (state.agentRuntimeNodes || []).map((node) => row([
    `<strong>${esc(node.nodeName || node.nodeId)}</strong><div class="small muted mono">${esc(node.nodeId)}</div>`,
    badge(node.status),
    badge(node.admission),
    {v: fmtTime(node.lastHeartbeatAt), c: "nowrap"},
    node.status !== "revoked" && canControlNodes ? [
      `<button class="secondary-button" data-action="agent-control" data-node-id="${esc(node.nodeId)}" data-command="refresh_profile">刷新</button>`,
      `<button class="secondary-button" data-action="agent-control" data-node-id="${esc(node.nodeId)}" data-command="pause_dispatch">暂停</button>`,
      `<button class="danger-button" data-action="agent-control" data-node-id="${esc(node.nodeId)}" data-command="cancel_dispatch">取消</button>`
    ].join(" ") : "-"
  ])).join("");

  const decisions = (state.modelSelectionDecisions || []).slice(0, 10).map((decision) => row([
    esc(t(decision.roleId)),
    `<span class="mono">${esc(decision.workItemId || "-")}</span>`,
    `<span class="mono">${esc(decision.selectedModel?.modelId || "-")}</span>`,
    badge(decision.status),
    {v: esc(modelDecisionSummaryZh(decision)), c: "text-clip"}
  ])).join("");

  const placements = (state.sessionPlacementDecisions || []).slice(0, 10).map((decision) => row([
    `<span class="mono">${esc(decision.workItemId || "-")}</span>`,
    badge(decision.placement),
    badge(decision.workerCarrierDecision?.carrier || "-"),
    badge(decision.status)
  ])).join("");

  const admissions = (state.admissionDecisions || []).slice(0, 12).map((decision) => row([
    `<span class="mono">${esc(decision.workItemId || "-")}</span>`,
    badge(decision.outcome),
    badge(decision.cellClass || "-"),
    {v: esc(admissionReasonLabel(decision)), c: "text-clip"}
  ])).join("");

  const checkpointRows = filterSource((state.checkpoints || []).filter((cp) => groups.some((taskGroup) => taskGroup.id === cp.taskGroupId)), "checkpoints").slice(0, 20).map((cp) => {
    const lastCommit = cp.commitRefs?.at(-1);
    const lastPush = cp.pushRefs?.at(-1);
    const commitLabel = lastCommit ? esc(String(lastCommit.commit || lastCommit).slice(0, 12)) : "";
    const commitExtra = (cp.commitRefs || []).length > 1 ? ` +${(cp.commitRefs || []).length - 1}` : "";
    const pushLabel = lastPush ? esc(`${String(lastPush.remote || "")}/${String(lastPush.ref || lastPush.remoteSha || lastPush)}`) : "";
    return row([
      esc(taskGroupNameOf(cp.taskGroupId)),
      `<span class="mono">${esc(cp.workId || "-")}</span>`,
      lastCommit ? {v: `<span class="mono">${commitLabel}</span>${commitExtra}`, c: "nowrap"} : "-",
      lastPush ? {v: `<span class="mono">${pushLabel}</span>`, c: "nowrap"} : "-",
      {v: esc(cp.artifactManifestRefs?.[0] || "-"), c: "text-clip"},
      {v: fmtTime(cp.createdAt), c: "nowrap"}
    ]);
  }).join("");
  const qualityGateRows = filterSource((state.qualityGates || []).filter((qg) => groups.some((taskGroup) => taskGroup.id === qg.taskGroupId)), "quality-gates").slice(0, 20).map((qg) => row([
    esc(taskGroupNameOf(qg.taskGroupId)),
    esc(t(qg.gateType) || qg.gateType || "-"),
    `<span class="mono">${esc(qg.workItemId || "-")}</span>`,
    badge(qg.status),
    {v: fmtTime(qg.updatedAt || qg.createdAt), c: "nowrap"}
  ])).join("");
  const failingTests = (state.testResults || []).filter((tr) => groups.some((taskGroup) => taskGroup.id === tr.taskGroupId) && ["failed", "error"].includes(tr.status));
  const canCloseTaskGroup = hasPerm("task_group:control"); // endpoint maps task_group_* -> task_group:control
  const barriers = (state.closeBarriers || []).slice(0, 8).map((barrier) => row([
    esc(taskGroupNameOf(barrier.taskGroupId)),
    barrier.satisfied ? customBadge("可关闭", "green") : customBadge("存在阻塞", "red"),
    {v: String((barrier.blockingObjects || []).length), c: "num"},
    {v: fmtTime(barrier.computedAt), c: "nowrap"},
    (barrier.satisfied && canCloseTaskGroup && taskGroupById(barrier.taskGroupId)?.status !== "closed")
      ? `<button class="primary-button" data-action="close-task-group" data-task="${esc(barrier.taskGroupId)}">关闭任务组</button>`
      : (taskGroupById(barrier.taskGroupId)?.status === "closed" ? customBadge("已关闭", "gray") : "-")
  ])).join("");

  return [
    canOrchestrate ? panel("自治控制", `
      <div class="button-row">
        <button class="primary-button" data-action="orchestrator-run">运行自治循环</button>
        <button class="secondary-button" data-action="decide-model">模型决策</button>
      </div>
    `) : "",
    panel("实时事件流", `
      <div class="stack">
        <div class="record-meta"><span>监听范围：</span><select data-select="exec-scope" aria-label="执行监听范围">${scopeOptions.map((option) => `<option value="${esc(option.value)}" ${option.value === scopeValue ? "selected" : ""}>${esc(option.label)}</option>`).join("")}</select></div>
        ${table([{label: "序号", c: "num"}, "事件", {label: "进度", c: "num"}, "状态", {label: "摘要", c: "text-clip"}, {label: "时间", c: "nowrap"}], eventRows, {moreText: moreText(eventsShown.length, 120)})}
      </div>
    `, {wide: true, headerSide: filterInput("按事件、摘要过滤…", "events")}),
    panel("可复用执行载体（Worker Lane）", table(["角色", "功能", "状态", {label: "复用代数", c: "num"}, "当前会话", {label: "更新时间", c: "nowrap"}], laneRows, {moreText: moreText(lanesAll.length, 20)}), {wide: true, headerSide: filterInput("按角色、会话过滤…", "worker-lanes")}),
    panel("工作会话", table(["会话", "角色", "工作项", "放置方式", {label: "执行载体", c: "nowrap"}, "状态", "详情"], sessions, {moreText: moreText(sessionsAll.length, 20)}), {wide: true, headerSide: filterInput("按会话、工作项过滤…", "sessions")}),
    panel("智能体派发", table(["派发", "工作项", "状态", {label: "进度", c: "num"}, "原因", "详情"], dispatches, {moreText: moreText(dispatchesAll.length, 20)}), {wide: true, headerSide: filterInput("按派发、工作项过滤…", "dispatches")}),
    panel("控制通道", table([{label: "序号", c: "num"}, "节点", "命令", "作用对象", "状态", {label: "更新时间", c: "nowrap"}], commands, {moreText: moreText((state.agentControlCommands || []).length, 16)}), {wide: true}),
    panel("运行时节点", table(["节点", "状态", "准入", {label: "最近心跳", c: "nowrap"}, "操作"], nodes), {wide: true, headerSide: filterInput("按节点过滤…", "runtime-nodes")}),
    panel("模型选择记录", table(["角色", "工作项", "模型", "状态", {label: "决策说明", c: "text-clip"}], decisions, {moreText: moreText((state.modelSelectionDecisions || []).length, 10)})),
    panel("会话放置记录", table(["工作项", "放置方式", {label: "执行载体", c: "nowrap"}, "状态"], placements, {moreText: moreText((state.sessionPlacementDecisions || []).length, 10)})),
    panel("准入决策", table(["工作项", "判定", "分类", {label: "原因", c: "text-clip"}], admissions, {moreText: moreText((state.admissionDecisions || []).length, 12)}), {wide: true}),
    panel("检查点（Git 证据）", table(["任务组", "工作项", "提交", "推送", {label: "产出清单", c: "text-clip"}, {label: "时间", c: "nowrap"}], checkpointRows, {moreText: moreText(filterSource((state.checkpoints || []).filter((cp) => groups.some((taskGroup) => taskGroup.id === cp.taskGroupId)), "checkpoints").length, 20)}), {wide: true, headerSide: filterInput("按工作项、提交过滤…", "checkpoints")}),
    (state.qualityGates || []).some((qg) => groups.some((taskGroup) => taskGroup.id === qg.taskGroupId)) ? panel("质量门禁 / 测试证据", `
      ${failingTests.length ? `<div class="notice warn-notice">有 ${failingTests.length} 项失败测试，阻塞关闭门禁（gateType 对应门禁为 failed，需修复并重提通过测试，或取消对应工作项）。</div>` : ""}
      ${table(["任务组", "门禁类型", "工作项", "状态", {label: "更新时间", c: "nowrap"}], qualityGateRows, {moreText: moreText(filterSource((state.qualityGates || []).filter((qg) => groups.some((taskGroup) => taskGroup.id === qg.taskGroupId)), "quality-gates").length, 20)})}
    `, {wide: true, headerSide: filterInput("按门禁类型、工作项过滤…", "quality-gates")}) : "",
    panel("关闭门禁", `
      ${table(["任务组", "状态", {label: "阻塞对象数", c: "num"}, {label: "计算时间", c: "nowrap"}, "操作"], barriers, {moreText: moreText((state.closeBarriers || []).length, 8)})}
      ${(state.closeBarriers || []).filter((barrier) => !barrier.satisfied && (barrier.blockingObjects || []).length).slice(0, 8).map((barrier) => `
        <div class="record" style="margin-top:8px;">
          <div class="record-title"><strong>${esc(taskGroupNameOf(barrier.taskGroupId))}</strong> 阻塞明细</div>
          <div class="chip-row">${(barrier.blockingObjects || []).map((obj) => customBadge(`${t(obj.objectType) || obj.objectType}${obj.gate ? `·${t(obj.gate) || obj.gate}` : ""}：${t(obj.status) || obj.status}`, "red")).join(" ")}</div>
        </div>`).join("")}
    `, {wide: true})
  ].join("");
}

/* ---------------- 成员：项目设置 ---------------- */

function cfgRepoRow(repo = {}) {
  return `
    <div class="cfg-row" data-cfg-kind="repo">
      <input name="repoId" placeholder="仓库 ID" value="${esc(repo.id || "")}">
      <input name="repoUrl" placeholder="仓库地址（git@... / https://...）" value="${esc(repo.url || "")}">
      <input name="repoBranch" placeholder="默认分支" value="${esc(repo.defaultBranch || "main")}">
      <input name="repoCred" placeholder="凭证引用（如 env:AIMAC_REPO_TOKEN_X）" value="${esc(repo.credentialSecretRef || "")}">
      <button type="button" class="danger-button" data-action="cfg-del">删除</button>
    </div>
  `;
}

function cfgBaselineRow(item = {}) {
  return `
    <div class="cfg-row" data-cfg-kind="baseline">
      <input name="blName" placeholder="名称" value="${esc(item.name || "")}">
      <input name="blLocator" placeholder="定位（如 git:docs/baseline/...）" value="${esc(item.locator || "")}">
      <input name="blDigest" placeholder="内容摘要（可选）" value="${esc(item.digest || "")}">
      <button type="button" class="danger-button" data-action="cfg-del">删除</button>
    </div>
  `;
}

function cfgRoleRow(role = {}) {
  return `
    <div class="cfg-row" data-cfg-kind="role">
      <input name="roleId" placeholder="角色 ID（如 backend-developer）" value="${esc(role.roleId || "")}">
      <input name="roleSkillRef" placeholder="角色规则引用（可选）" value="${esc(role.roleSkillRef || "")}">
      <button type="button" class="danger-button" data-action="cfg-del">删除</button>
    </div>
  `;
}

function renderProjectSettings() {
  const project = currentProject();
  if (!project) return panel("项目设置", `<div class="notice">当前账号暂无可见项目。</div>`, {wide: true});
  const config = project.config || {};
  // projConfig===null means the config GET failed (effectiveProjectConfig always returns non-empty
  // systemRules defaults on success). Rendering empty editable rule editors here and saving would post
  // {systemRules:[]} and WIPE the project's rule overrides. Guard: show a notice instead of the editors.
  const rulesLoaded = projConfig !== null;
  const resolved = projConfig || {};
  const canEdit = hasPerm("project:update");
  const editDisabled = canEdit ? "" : "disabled";
  const readOnlyNotice = canEdit ? "" : `<div class="notice warn-notice">当前账号无“项目授权管理”权限，项目配置为只读。</div>`;

  return [
    panel(`项目设置 · ${esc(project.name)}`, `
      ${readOnlyNotice}
      <form class="form-grid" data-form="project-config" data-project="${esc(project.id)}">
        <div class="form-row"><label>仓库与凭证引用（凭证只存引用，不落明文）</label>
          <div class="cfg-rows" data-cfg-list="proj-repos">${(config.repositories || []).map((repo) => cfgRepoRow(repo)).join("")}</div>
          <div class="button-row"><button type="button" class="secondary-button" data-action="cfg-add" data-kind="repo" data-target="proj-repos" ${editDisabled}>添加仓库</button></div>
        </div>
        <div class="form-row"><label>基线数据</label>
          <div class="cfg-rows" data-cfg-list="proj-baseline">${(config.baselineData || []).map((item) => cfgBaselineRow(item)).join("")}</div>
          <div class="button-row"><button type="button" class="secondary-button" data-action="cfg-add" data-kind="baseline" data-target="proj-baseline" ${editDisabled}>添加基线</button></div>
        </div>
        <div class="form-row"><label>默认角色</label>
          <div class="cfg-rows" data-cfg-list="proj-roles">${(config.defaultRoles || []).map((role) => cfgRoleRow(role)).join("")}</div>
          <div class="button-row"><button type="button" class="secondary-button" data-action="cfg-add" data-kind="role" data-target="proj-roles" ${editDisabled}>添加角色</button></div>
        </div>
        <button class="primary-button" type="submit" ${editDisabled}>保存项目配置</button>
      </form>
    `, {wide: true}),
    !rulesLoaded
      ? panel("规则配置", `<div class="notice warn-notice">暂时无法读取项目规则配置（配置接口加载失败），已隐藏规则编辑器以避免误保存清空规则。请点击右上角刷新重试。</div>`, {wide: true})
      : [
        panel("系统规则", ruleEditorForm({
          rules: resolved.systemRules || [],
          listId: "proj-system-rules",
          category: "system",
          layer: "project",
          project: project.id,
          readOnly: !canEdit,
          note: "内置默认系统规则可在项目层“停用”或“改写内容”，也可新增自定义系统规则。徽标标明来源：默认、项目。"
        }), {wide: true}),
        panel("业务规则", ruleEditorForm({
          rules: resolved.businessRules || [],
          listId: "proj-business-rules",
          category: "business",
          layer: "project",
          project: project.id,
          readOnly: !canEdit,
          note: "业务规则通常在项目层定义，可新增、停用或改写。任务组可进一步覆盖。"
        }), {wide: true})
      ].join("")
  ].join("");
}

/* ---------------- 表单提交处理 ---------------- */

document.addEventListener("submit", async (event) => {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.form;
  // Saving one form triggers a full loadPage() rebuild that discards sibling forms' unsaved edits. Warn
  // before that silent loss when another form on the page is dirty (e.g. edited system-rules then saved
  // project-config on the same 项目设置 page).
  const currentFormKey = formDirtyKey(form);
  if ([...dirtyFormKinds].some((other) => other !== currentFormKey)) {
    if (!(await confirmDialog({title: "存在未保存的其他修改", message: "本页其他表单有未保存的修改，保存并刷新会丢弃它们。是否继续？", danger: true, confirmText: "继续保存"}))) return;
  }
  // Include the submitter so a form with multiple submit buttons (e.g. 批准/拒绝 carrying name=status)
  // contributes the clicked button's name/value — without this, data.status is undefined and both
  // buttons fall through to the negative default (approve would silently deny).
  const data = Object.fromEntries(new FormData(form, event.submitter).entries());
  const submitBtn = form.querySelector("button[type='submit'], button:not([type='button'])");
  // Disable EVERY submit button in the form during the request (a form with 批准/拒绝 has two) so the
  // other button can't fire a second in-flight request; re-enabled on the next render/loadPage.
  const allSubmitBtns = [...form.querySelectorAll("button[type='submit'], button:not([type='button'])")];
  allSubmitBtns.forEach((btn) => { if (btn !== submitBtn) btn.disabled = true; });
  try {
    const submitOutcome = await withSubmitting(submitBtn, async () => {
    if (kind === "login") {
      const secret = String(data.secret || "");
      const result = await api("/api/auth/login", {method: "POST", body: JSON.stringify({email: data.email, token: secret, password: secret})});
      saveSession(result.sessionToken, result.account);
      lastError = "";
      page = defaultPageFor(perspectiveOf(currentAccount));
      sessionStorage.setItem("aimac.page", page);
      await loadPage();
      return;
    }
    if (kind === "change-password") {
      if (String(data.newPassword || "").length < 8) throw new Error("新密码至少 8 位");
      if (data.newPassword !== data.confirmPassword) throw new Error("两次输入的新密码不一致");
      await api("/api/auth/change-password", {method: "POST", body: JSON.stringify({currentPassword: data.currentPassword || undefined, newPassword: data.newPassword})});
      modalHtml = "";
      openModal("修改密码", `<div class="notice">密码修改成功，下次登录可使用新密码。</div>`);
      return;
    }
    if (kind === "org-create") {
      const result = await api("/api/orgs", {method: "POST", body: JSON.stringify({
        name: data.name,
        admin: {displayName: data.adminName, email: data.adminEmail},
        quotas: {maxMembers: Number(data.maxMembers), maxProjects: Number(data.maxProjects), maxTaskGroups: Number(data.maxTaskGroups), maxAgents: Number(data.maxAgents)}
      })});
      await loadPage();
      oneTimeTokenModal(`组织「${result.organization?.name || data.name}」创建成功`, result.adminAccount?.email || data.adminEmail, result.accountToken || "-", "请将令牌交给该组织的初始组织管理员，首次登录后建议立即设置密码。");
      return;
    }
    if (kind === "org-quotas") {
      await api(`/api/orgs/${encodeURIComponent(form.dataset.org)}/quotas`, {method: "POST", body: JSON.stringify({
        quotas: {maxMembers: Number(data.maxMembers), maxProjects: Number(data.maxProjects), maxTaskGroups: Number(data.maxTaskGroups), maxAgents: Number(data.maxAgents)}
      })});
      closeModal();
      await loadPage();
      return;
    }
    if (kind === "member-create") {
      const permissions = [...form.querySelectorAll("input[name='perm']:checked")].map((input) => input.value);
      const result = await api("/api/org/members", {method: "POST", body: JSON.stringify({
        displayName: data.displayName,
        email: data.email,
        permissions,
        defaultProjectId: data.defaultProjectId || null
      })});
      await loadPage();
      oneTimeTokenModal("成员创建成功", result.account?.email || data.email, result.accountToken || "-", "请将一次性登录令牌交给该成员。");
      return;
    }
    if (kind === "member-perms") {
      const permissions = [...form.querySelectorAll("input[name='perm']:checked")].map((input) => input.value);
      await api(`/api/org/members/${encodeURIComponent(form.dataset.account)}/permissions`, {method: "POST", body: JSON.stringify({permissions})});
      closeModal();
      await loadPage();
      return;
    }
    if (kind === "account-invite") {
      const result = await api("/api/accounts", {method: "POST", body: JSON.stringify(data)});
      await loadPage();
      oneTimeTokenModal("账号邀请成功", result.account?.email || result.login?.email || data.email, result.accountToken || "-", `令牌有效期至 ${fmtTime(result.tokenExpiresAt)}。`);
      return;
    }
    if (kind === "grant-create") {
      await api("/api/access-grants", {method: "POST", body: JSON.stringify(data)});
      await loadPage();
      return;
    }
    if (kind === "project-create") {
      await api("/api/projects", {method: "POST", body: JSON.stringify(data)});
      await loadPage();
      return;
    }
    if (kind === "org-project-create") {
      await api("/api/org/projects", {method: "POST", body: JSON.stringify({name: data.name})});
      await loadPage();
      return;
    }
    if (kind === "project-member") {
      await api(`/api/projects/${encodeURIComponent(data.projectId)}/members`, {method: "POST", body: JSON.stringify(data)});
      await loadPage();
      return;
    }
    if (kind === "join-token") {
      const payload = {
        projectId: data.projectId,
        nodeName: data.nodeName || undefined,
        allowedRoles: String(data.allowedRoles || "agent-runtime").split(",").map((item) => item.trim()).filter(Boolean),
        ttlSeconds: Number(data.ttlSeconds || 1800),
        maxUses: 1
      };
      const result = await api("/api/agent-join-tokens", {method: "POST", body: JSON.stringify(payload)});
      await loadPage();
      openModal("一次性智能体加入令牌", `
        <div class="stack">
          <div class="notice warn-notice">以下注册命令仅显示一次，请立即复制到目标主机执行。</div>
          <div class="command-box"><strong>直接安装</strong><pre id="join-install">${esc(result.installCommand || "-")}</pre></div>
          <div class="button-row"><button type="button" class="secondary-button" data-action="copy-el" data-copy-target="#join-install">复制直接安装命令</button></div>
          <div class="command-box"><strong>校验安装（推荐）</strong><pre id="join-verified">${esc(result.verifiedInstallCommand || "-")}</pre></div>
          <div class="button-row"><button type="button" class="secondary-button" data-action="copy-el" data-copy-target="#join-verified">复制校验安装命令</button></div>
        </div>
      `, {protected: true});
      return;
    }
    if (kind === "agent-create") {
      await api("/api/agents", {method: "POST", body: JSON.stringify(data)});
      await loadPage();
      return;
    }
    if (kind === "task-group-create") {
      if (!currentProjectId) throw new Error("请先选择项目");
      const languageSelect = form.querySelector("select[name='languageTag']");
      const languageName = languageSelect?.selectedOptions[0]?.textContent?.split(" · ")[0]?.trim() || data.languageTag;
      const payload = {
        projectId: currentProjectId,
        name: data.name,
        objective: data.objective,
        languageTag: data.languageTag,
        languageName,
        roles: String(data.roles || "").split(/[\n,]/u).map((item) => item.trim()).filter(Boolean)
      };
      const result = await api("/api/task-groups", {method: "POST", body: JSON.stringify(payload)});
      expandedTaskGroupId = result.taskGroup?.id || expandedTaskGroupId;
      formTouched = false;
      await loadPage();
      return;
    }
    if (kind === "work-item-create") {
      const taskGroupId = data.taskGroupId;
      const payload = {
        title: data.title,
        ownerRole: data.ownerRole,
        requirements: String(data.requirements || "").split(/\n/u).map((item) => item.trim()).filter(Boolean)
      };
      await api(`/api/task-groups/${encodeURIComponent(taskGroupId)}/work-items`, {method: "POST", body: JSON.stringify(payload)});
      expandedTaskGroupId = taskGroupId;
      formTouched = false;
      await loadPage();
      return;
    }
    if (kind === "language-policy") {
      const languageSelect = form.querySelector("select[name='languageTag']");
      const languageName = languageSelect?.selectedOptions[0]?.textContent?.split(" · ")[0]?.trim() || data.languageTag;
      await api(`/api/task-groups/${encodeURIComponent(form.dataset.task)}/language-policy`, {method: "POST", body: JSON.stringify({languageTag: data.languageTag, languageName})});
      formTouched = false;
      await loadPage();
      return;
    }
    if (kind === "tg-config") {
      const origRoles = form.querySelector("input[name='defaultRoles']")?.dataset.orig || "";
      const changed = String(data.defaultRoles || "").trim() !== String(origRoles).trim();
      if (!changed) { formTouched = false; toast.info("默认角色未改动，任务组仍继承项目配置"); return "__skip_success__"; }
      const defaultRoles = String(data.defaultRoles || "").split(",").map((item) => item.trim()).filter(Boolean).map((roleId) => ({roleId}));
      await api(`/api/task-groups/${encodeURIComponent(form.dataset.task)}/config`, {method: "POST", body: JSON.stringify({defaultRoles})});
      formTouched = false;
      await loadPage();
      return;
    }
    if (kind === "project-config") {
      const repositories = [...form.querySelectorAll("[data-cfg-kind='repo']")].map((rowEl) => ({
        id: rowEl.querySelector("input[name='repoId']")?.value?.trim() || "",
        url: rowEl.querySelector("input[name='repoUrl']")?.value?.trim() || "",
        defaultBranch: rowEl.querySelector("input[name='repoBranch']")?.value?.trim() || "main",
        credentialSecretRef: rowEl.querySelector("input[name='repoCred']")?.value?.trim() || ""
      })).filter((repo) => repo.id || repo.url);
      const baselineData = [...form.querySelectorAll("[data-cfg-kind='baseline']")].map((rowEl) => ({
        name: rowEl.querySelector("input[name='blName']")?.value?.trim() || "",
        locator: rowEl.querySelector("input[name='blLocator']")?.value?.trim() || "",
        digest: rowEl.querySelector("input[name='blDigest']")?.value?.trim() || ""
      })).filter((item) => item.name || item.locator);
      const defaultRoles = [...form.querySelectorAll("[data-cfg-kind='role']")].map((rowEl) => ({
        roleId: rowEl.querySelector("input[name='roleId']")?.value?.trim() || "",
        roleSkillRef: rowEl.querySelector("input[name='roleSkillRef']")?.value?.trim() || ""
      })).filter((role) => role.roleId);
      await api(`/api/projects/${encodeURIComponent(form.dataset.project)}/config`, {method: "POST", body: JSON.stringify({repositories, baselineData, defaultRoles})});
      formTouched = false;
      await loadPage();
      return;
    }
    if (kind === "project-rules") {
      const fragments = collectRuleFragments(form, "project");
      const payload = form.dataset.category === "system" ? {systemRules: fragments} : {businessRules: fragments};
      await api(`/api/projects/${encodeURIComponent(form.dataset.project)}/config`, {method: "POST", body: JSON.stringify(payload)});
      formTouched = false;
      await loadPage();
      return;
    }
    if (kind === "tg-rules") {
      const fragments = collectRuleFragments(form, "task_group");
      const payload = form.dataset.category === "system" ? {systemRules: fragments} : {businessRules: fragments};
      await api(`/api/task-groups/${encodeURIComponent(form.dataset.task)}/config`, {method: "POST", body: JSON.stringify(payload)});
      formTouched = false;
      await loadPage();
      return;
    }
    if (kind === "hcr-decide") {
      const selectedOptionId = data.selectedOptionId;
      if (!selectedOptionId) throw new Error("请先选择一个选项");
      if (selectedOptionId === "none" && !String(data.inputText || "").trim()) throw new Error("选择“不选择（自定义输入）”时必须填写确认内容");
      // action 来自被点击的按钮：revise（交 AI 再分析，不锁定）/ finalize（定稿并上锁）/ reject（打回）。
      const action = ["revise", "finalize", "reject"].includes(data.action) ? data.action : "finalize";
      if (action === "revise" && !String(data.inputText || "").trim()) throw new Error("提交修改意见时请填写你的方案或意见");
      // expectedRound：如果 AI 在你看这一页之后修订了候选方案，服务端会拒绝并要求你重新看过（防 TOCTOU）。
      await api(`/api/human-confirmations/${encodeURIComponent(form.dataset.request)}/decide`, {method: "POST", body: JSON.stringify({action, selectedOptionId, inputText: data.inputText || "", expectedRound: Number(form.dataset.round || 1)})});
      formTouched = false;
      await loadPage();
      return;
    }
    if (kind === "directive-create") {
      if (["add_requirement", "free_text"].includes(data.directiveType) && !String(data.instruction || "").trim()) {
        throw new Error("补充要求 / 自由指令必须填写指令内容");
      }
      await api("/api/human-directives", {method: "POST", body: JSON.stringify({
        projectId: currentProjectId,
        taskGroupId: directiveTaskGroupId,
        directiveType: data.directiveType,
        instruction: data.instruction || "",
        ...(data.directiveType === "resolve_decision" ? {resolution: data.resolution || "reopen", ...(String(data.workItemId || "").trim() ? {workItemId: data.workItemId.trim()} : {})} : {})
      })});
      formTouched = false;
      await loadPage();
      return;
    }
    if (kind === "perm-resolve") {
      await api(`/api/permission-requests/${encodeURIComponent(form.dataset.request)}/resolve`, {method: "POST", body: JSON.stringify({status: data.status || "rejected"})});
      await loadPage();
      return;
    }
    if (kind === "approval-resolve") {
      await api(`/api/approval-requests/${encodeURIComponent(form.dataset.request)}/resolve`, {method: "POST", body: JSON.stringify({status: data.status || "rejected"})});
      await loadPage();
      return;
    }
    if (kind === "finding-resolve") {
      const evidenceRefs = String(data.evidenceRefs || "").split(",").map((ref) => ref.trim()).filter(Boolean);
      // fixed_verified without evidence is downgraded server-side to fixed_unverified (still blocks) —
      // require evidence up front so the operator isn't misled by a success toast on a still-blocking
      // disposition. (not_applicable / scope_adjusted need no evidence.)
      if ((data.dispositionClass || "fixed_verified") === "fixed_verified" && !evidenceRefs.length) {
        throw new Error("“已修复并验证”需填写证据引用（evidence:...），否则将被降级为不可闭合并继续阻塞关闭门禁");
      }
      await api(`/api/findings/${encodeURIComponent(form.dataset.request)}/resolve`, {method: "POST", body: JSON.stringify({
        status: data.status || "resolved",
        dispositionClass: data.dispositionClass || "fixed_verified",
        evidenceRefs
      })});
      await loadPage();
      return;
    }
    });
    // Any successful data-form submit clears the dirty flag centrally, so navigating away afterwards
    // never fires a spurious "放弃未保存的修改" prompt (the create forms previously never reset it).
    if (submitOutcome !== "__skip_success__") { formTouched = false; dirtyFormKinds.clear(); }
    if (SUBMIT_SUCCESS[kind] && submitOutcome !== "__skip_success__") toast.success(SUBMIT_SUCCESS[kind]);
  } catch (error) {
    showError(error);
  }
});

/* ---------------- 点击与选择处理 ---------------- */

document.addEventListener("change", async (event) => {
  const target = event.target;
  try {
    if (target.name === "ruleEnabled") {
      const rowEl = target.closest(".rule-row");
      if (rowEl) rowEl.classList.toggle("disabled", !target.checked);
      formTouched = true;
      return;
    }
    if (target.id === "project-switcher") {
      if (target.value !== currentProjectId && formTouched && !(await confirmDialog({title: "放弃未保存的修改", message: "切换项目将丢失当前页面未保存的修改，确认切换？", danger: true, confirmText: "放弃并切换"}))) {
        target.value = currentProjectId;
        return;
      }
      formTouched = false;
      currentProjectId = target.value;
      sessionStorage.setItem("aimac.projectId", currentProjectId);
      expandedTaskGroupId = "";
      tgDetail = null;
      directiveTaskGroupId = "";
      execScope = {type: "", id: ""};
      execEvents = [];
      execCursor = 0;
      await loadPage();
      return;
    }
    if (target.dataset.select === "directive-tg") {
      if (target.value !== directiveTaskGroupId && formTouched && !(await confirmDialog({title: "放弃未保存的修改", message: "切换目标任务组将丢失已输入的指令内容，确认切换？", danger: true, confirmText: "放弃并切换"}))) {
        target.value = directiveTaskGroupId; // revert the select
        return;
      }
      directiveTaskGroupId = target.value;
      await loadPage();
      return;
    }
    if (target.dataset.select === "exec-scope") {
      const [type, ...rest] = String(target.value).split(":");
      execScope = {type, id: rest.join(":")};
      execEvents = [];
      execCursor = 0;
      await loadExecEvents({reset: true});
      startExecPolling();
      render();
      return;
    }
  } catch (error) {
    showError(error);
  }
});

document.addEventListener("input", (event) => {
  const filter = event.target.closest("[data-filter-input]");
  if (filter) {
    if (filter.dataset.filterKey) filterState[filter.dataset.filterKey] = filter.value;
    applyFilterFor(filter);           // immediate feedback on already-rendered rows
    scheduleFilterRerender(filter);   // debounced full re-render so filterSource surfaces past-cap matches
    return;
  }
  const touchedForm = event.target.closest("form[data-form]");
  if (touchedForm) { formTouched = true; dirtyFormKinds.add(formDirtyKey(touchedForm)); }
});

/* 悬浮气泡 fixed 定位，避免被 .table-scroll 裁剪 */
document.addEventListener("mouseover", (event) => {
  const wrap = event.target.closest(".hover-wrap");
  if (!wrap) return;
  const pop = wrap.querySelector(".hover-pop");
  if (!pop) return;
  const rect = wrap.getBoundingClientRect();
  const width = pop.offsetWidth || 300;
  pop.style.display = "block";
  pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  pop.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 20)}px`;
});

document.addEventListener("mouseout", (event) => {
  const wrap = event.target.closest(".hover-wrap");
  if (!wrap) return;
  if (wrap.contains(event.relatedTarget)) return;
  const pop = wrap.querySelector(".hover-pop");
  if (pop) pop.style.display = "none";
});

document.addEventListener("click", async (event) => {
  const mask = event.target.closest("[data-modal-mask]");
  if (mask && event.target === mask) {
    await requestCloseModal();
    return;
  }
  const menuButton = event.target.closest("[data-menu]");
  if (menuButton) {
    if (menuButton.dataset.menu !== page && formTouched && !(await confirmDialog({title: "放弃未保存的修改", message: "当前页面有未保存的修改，确认离开？", danger: true, confirmText: "放弃并离开"}))) return;
    page = menuButton.dataset.menu;
    sessionStorage.setItem("aimac.page", page);
    lastError = "";
    formTouched = false;
    stopExecPolling();
    await loadPage();
    if (page === "monitor") {
      try {
        await loadExecEvents({reset: true});
      } catch {}
      startExecPolling();
      render();
    }
    return;
  }
  // 触屏/无悬浮环境：点击 hover-wrap 切换资源气泡显隐（桌面仍支持悬浮）
  const hoverWrap = event.target.closest(".hover-wrap");
  if (hoverWrap && !event.target.closest("[data-action]")) {
    const pop = hoverWrap.querySelector(".hover-pop");
    if (pop) {
      const open = pop.style.display === "block";
      document.querySelectorAll(".hover-pop").forEach((el) => { el.style.display = "none"; });
      if (!open) {
        const rect = hoverWrap.getBoundingClientRect();
        const width = pop.offsetWidth || 300;
        pop.style.display = "block";
        pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
        pop.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 20)}px`;
      }
      return;
    }
  }
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const MUTATION_ACTIONS = new Set(["orchestrator-run", "decide-model", "sync-skill-source", "task-control", "agent-control", "toggle-agent", "revoke-grant", "revoke-join-token", "revoke-agent-node", "org-status", "member-status", "bootstrap-init", "tg-config-reset", "close-task-group"]);
  const guardBtn = MUTATION_ACTIONS.has(action) && target.tagName === "BUTTON" ? target : null;
  if (guardBtn) { guardBtn.disabled = true; guardBtn.classList.add("is-loading"); }
  try {
    if (action === "modal-close") {
      await requestCloseModal();
      return;
    }
    if (action === "copy-el") {
      const source = document.querySelector(target.dataset.copyTarget);
      const ok = await copyText(source ? source.textContent : "");
      const original = target.textContent;
      target.textContent = ok ? "已复制" : "复制失败，请手动选择";
      setTimeout(() => { target.textContent = original; }, 1600);
      return;
    }
    if (action === "logout") {
      try {
        await api("/api/auth/logout", {method: "POST", body: "{}"});
      } catch {}
      clearSession();
      lastError = "";
      render();
      return;
    }
    if (action === "refresh") {
      target.classList.add("spinning");
      try { await loadPage(); } finally { target.classList.remove("spinning"); }
      return;
    }
    if (action === "open-change-password") {
      openModal("修改密码", `
        <form class="form-grid" data-form="change-password">
          <div class="form-row"><label>当前密码（首次设置可留空）</label><input name="currentPassword" type="password" autocomplete="current-password"></div>
          <div class="form-row"><label>新密码（至少 8 位）</label><input name="newPassword" type="password" required minlength="8" autocomplete="new-password"></div>
          <div class="form-row"><label>确认新密码</label><input name="confirmPassword" type="password" required minlength="8" autocomplete="new-password"></div>
          <button class="primary-button" type="submit">保存新密码</button>
        </form>
      `);
      return;
    }
    if (action === "bootstrap-init") {
      if (!(await confirmDialog({title: "重新初始化运行态", message: "确认重新初始化运行态？", sub: "该操作会重置为种子数据，仅用于本地排障。", danger: true, confirmText: "重新初始化"}))) return;
      await api("/api/bootstrap/init", {method: "POST", body: "{}"});
      await loadPage();
      toast.success("已重新初始化运行态");
      return;
    }
    if (action === "org-quota") {
      const org = organizations.find((item) => item.orgId === target.dataset.org);
      if (!org) return;
      openModal(`调整配额 · ${org.name}`, `
        <form class="form-grid" data-form="org-quotas" data-org="${esc(org.orgId)}">
          <div class="form-row"><label>成员上限</label><input name="maxMembers" type="number" min="1" value="${esc(org.quotas?.maxMembers ?? 50)}"></div>
          <div class="form-row"><label>项目上限</label><input name="maxProjects" type="number" min="1" value="${esc(org.quotas?.maxProjects ?? 20)}"></div>
          <div class="form-row"><label>任务组上限</label><input name="maxTaskGroups" type="number" min="1" value="${esc(org.quotas?.maxTaskGroups ?? 200)}"></div>
          <div class="form-row"><label>智能体上限</label><input name="maxAgents" type="number" min="1" value="${esc(org.quotas?.maxAgents ?? 100)}"></div>
          <button class="primary-button" type="submit">保存配额</button>
        </form>
      `);
      return;
    }
    if (action === "org-status") {
      const status = target.dataset.status;
      if (status === "suspended" && !(await confirmDialog({title: "停用组织", message: "确认停用该组织？", sub: "停用后组织内账号与智能体将无法工作。", danger: true, confirmText: "停用"}))) return;
      await api(`/api/orgs/${encodeURIComponent(target.dataset.org)}/status`, {method: "POST", body: JSON.stringify({status})});
      await loadPage();
      toast.success(status === "suspended" ? "已停用组织" : "已启用组织");
      return;
    }
    if (action === "member-perms") {
      const member = (orgMembers || []).find((account) => account.accountId === target.dataset.account);
      if (!member) return;
      openModal(`调整权限 · ${member.displayName}`, `
        <form class="form-grid" data-form="member-perms" data-account="${esc(member.accountId)}">
          <div class="notice">提交后将以所选权限覆盖该成员当前权限集合。</div>
          ${permissionCheckboxes(member.permissions || [])}
          <button class="primary-button" type="submit">保存权限</button>
        </form>
      `);
      return;
    }
    if (action === "member-status") {
      const status = target.dataset.status;
      if (status === "disabled" && !(await confirmDialog({title: "停用成员", message: "确认停用该成员？", sub: "其活动会话将被立即吊销。", danger: true, confirmText: "停用"}))) return;
      await api(`/api/org/members/${encodeURIComponent(target.dataset.account)}/status`, {method: "POST", body: JSON.stringify({status})});
      await loadPage();
      toast.success(status === "disabled" ? "已停用成员" : "已启用成员");
      return;
    }
    if (action === "agent-view-mode") {
      agentViewMode = target.dataset.mode;
      render();
      return;
    }
    if (action === "toggle-agent") {
      const agent = (state.agents || []).find((item) => item.id === target.dataset.agent);
      if (agent?.status === "active" && !(await confirmDialog({title: "停用智能体", message: "确认停用该智能体档案？", danger: true, confirmText: "停用"}))) return;
      await api(`/api/agents/${encodeURIComponent(target.dataset.agent)}/activate`, {method: "POST", body: JSON.stringify({active: agent?.status !== "active"})});
      await loadPage();
      toast.success(agent?.status === "active" ? "已停用智能体" : "已启用智能体");
      return;
    }
    if (action === "revoke-grant") {
      if (!(await confirmDialog({title: "撤销访问授权", message: "确认撤销该访问授权？", danger: true, confirmText: "撤销"}))) return;
      await api(`/api/access-grants/${encodeURIComponent(target.dataset.grant)}/revoke`, {method: "POST", body: "{}"});
      await loadPage();
      toast.success("已撤销访问授权");
      return;
    }
    if (action === "sync-skill-source") {
      await api(`/api/skill-sources/${encodeURIComponent(target.dataset.source)}/sync`, {method: "POST", body: "{}"});
      await loadPage();
      toast.success("已触发技能源同步");
      return;
    }
    if (action === "revoke-join-token") {
      if (!(await confirmDialog({title: "撤销加入令牌", message: "确认撤销该加入令牌？", sub: "未使用的令牌将立即失效。", danger: true, confirmText: "撤销"}))) return;
      await api(`/api/agent-join-tokens/${encodeURIComponent(target.dataset.tokenId)}/revoke`, {method: "POST", body: "{}"});
      await loadPage();
      toast.success("已撤销加入令牌");
      return;
    }
    if (action === "revoke-agent-node") {
      if (!(await confirmDialog({title: "吊销智能体节点", message: "确认吊销该智能体节点？", sub: "节点上运行中的任务将被围栏并重新排队。", danger: true, confirmText: "吊销"}))) return;
      await api(`/api/agent-nodes/${encodeURIComponent(target.dataset.nodeId)}/revoke`, {method: "POST", body: "{}"});
      await loadPage();
      toast.success("已吊销智能体节点");
      return;
    }
    if (action === "agent-control") {
      const command = target.dataset.command;
      if (command === "cancel_dispatch" && !(await confirmDialog({title: "取消派发", message: "确认取消该节点当前派发的任务？", danger: true, confirmText: "取消派发"}))) return;
      if (command === "shutdown" && !(await confirmDialog({title: "关停节点", message: "确认优雅关停该节点？", sub: "节点将进入 draining，完成或围栏当前派发后离线（区别于硬吊销）。", confirmText: "关停"}))) return;
      const node = [...(state.agentRuntimeNodes || []), ...orgAgentNodes].find((item) => item.nodeId === target.dataset.nodeId);
      const dispatchId = (node?.activeDispatchIds || node?.display?.currentDispatchIds || [])[0] || "";
      await api(`/api/agent-nodes/${encodeURIComponent(target.dataset.nodeId)}/control`, {
        method: "POST",
        body: JSON.stringify({commandType: command, dispatchId: dispatchId || undefined})
      });
      await loadPage();
      toast.success({pause_dispatch: "已暂停派发", resume_dispatch: "已恢复派发", cancel_dispatch: "已取消派发", refresh_profile: "已刷新节点档案", shutdown: "已关停节点"}[command] || "已下发控制指令");
      return;
    }
    if (action === "close-task-group") {
      if (!(await confirmDialog({title: "关闭任务组", message: "确认关闭该任务组？", sub: "关闭门禁已满足；关闭后任务组进入终态 closed。", confirmText: "关闭任务组"}))) return;
      const result = await api(`/api/task-groups/${encodeURIComponent(target.dataset.task)}/close-barrier/compute`, {method: "POST", body: JSON.stringify({mutate: true})});
      await loadPage();
      if (result?.closeBarrier?.satisfied === false || result?.satisfied === false) toast.error("关闭门禁未满足，任务组未关闭");
      else toast.success("任务组已关闭");
      return;
    }
    if (action === "task-control") {
      const taskAction = target.dataset.taskAction;
      if (taskAction === "rebound_drift" && !(await confirmDialog({title: "执行纠偏", message: "确认执行纠偏？", sub: "任务组健康度将标记为需关注并触发复核。", confirmText: "执行纠偏"}))) return;
      await api(`/api/task-groups/${encodeURIComponent(target.dataset.task)}/control`, {method: "POST", body: JSON.stringify({action: taskAction})});
      await loadPage();
      toast.success({pause: "已暂停任务组", resume: "已恢复任务组", rebound_drift: "已触发纠偏"}[taskAction] || "已执行任务组操作");
      return;
    }
    if (action === "tg-detail") {
      const taskGroupId = target.dataset.task;
      if (expandedTaskGroupId === taskGroupId) {
        expandedTaskGroupId = "";
        tgDetail = null;
        render();
      } else {
        expandedTaskGroupId = taskGroupId;
        tgDetail = null;
        render();
        await loadTaskGroupDetail(taskGroupId);
        render();
      }
      return;
    }
    if (action === "tg-config-reset") {
      if (!(await confirmDialog({title: "重置任务组配置", message: "确认重置任务组配置？", sub: "将删除全部自定义项并回到继承项目配置。", danger: true, confirmText: "重置"}))) return;
      await api(`/api/task-groups/${encodeURIComponent(target.dataset.task)}/config/reset`, {method: "POST", body: "{}"});
      await loadPage();
      toast.success("已重置任务组配置");
      return;
    }
    if (action === "cfg-add") {
      const container = document.querySelector(`[data-cfg-list='${target.dataset.target}']`);
      if (!container) return;
      const kind = target.dataset.kind;
      const html = kind === "repo" ? cfgRepoRow() : kind === "baseline" ? cfgBaselineRow() : kind === "role" ? cfgRoleRow() : cfgBusinessRow();
      container.insertAdjacentHTML("beforeend", html);
      formTouched = true;
      return;
    }
    if (action === "cfg-del") {
      target.closest(".cfg-row")?.remove();
      formTouched = true;
      return;
    }
    if (action === "rule-add") {
      const container = document.querySelector(`[data-cfg-list='${target.dataset.target}']`);
      if (!container) return;
      const placeholder = container.querySelector(".small.muted");
      if (placeholder) placeholder.remove();
      container.insertAdjacentHTML("beforeend", ruleRowNew(target.dataset.category));
      formTouched = true;
      return;
    }
    if (action === "rule-del") {
      target.closest(".rule-row")?.remove();
      formTouched = true;
      return;
    }
    if (action === "show-dispatch-events") {
      execScope = {type: "dispatch", id: target.dataset.dispatchId || ""};
      execEvents = [];
      execCursor = 0;
      if (page !== "monitor") {
        page = "monitor";
        sessionStorage.setItem("aimac.page", page);
        await loadPage();
      }
      await loadExecEvents({reset: true});
      startExecPolling();
      render();
      return;
    }
    if (action === "show-session-events") {
      execScope = {type: "session", id: target.dataset.sessionId || ""};
      execEvents = [];
      execCursor = 0;
      if (page !== "monitor") {
        page = "monitor";
        sessionStorage.setItem("aimac.page", page);
        await loadPage();
      }
      await loadExecEvents({reset: true});
      startExecPolling();
      render();
      return;
    }
    if (action === "orchestrator-run") {
      await api("/api/orchestrator/run", {method: "POST", body: JSON.stringify({mode: "all"})});
      await loadPage();
      toast.success("已触发编排循环");
      return;
    }
    if (action === "decide-model") {
      const taskGroup = projectTaskGroups()[0];
      const workItem = (taskGroup?.workItems || [])[0];
      if (!taskGroup || !workItem) throw new Error("当前项目暂无可用于模型决策的任务组和工作项");
      await api("/api/model-selection/decide", {method: "POST", body: JSON.stringify({taskGroupId: taskGroup.id, workItemId: workItem.id, roleId: "orchestrator"})});
      await loadPage();
      toast.success("已完成模型决策");
      return;
    }
  } catch (error) {
    showError(error);
  } finally {
    if (guardBtn) { guardBtn.disabled = false; guardBtn.classList.remove("is-loading"); }
  }
});

/* ---------------- 实时推送（WebSocket，回退到 5 秒轮询） ---------------- */

let realtimeSocket = null;
let realtimeReconnectTimer = null;
let realtimeWakeTimer = null;

function realtimeWake() {
  if (realtimeWakeTimer) return;
  realtimeWakeTimer = setTimeout(() => {
    realtimeWakeTimer = null;
    if (!authToken || loading || modalHtml || formTouched) return;
    const active = document.activeElement;
    if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;
    loadPage().catch(() => {});
  }, 300);
}

function connectRealtime() {
  if (!authToken || realtimeSocket) return;
  let socket;
  try {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${scheme}//${location.host}/api/realtime?token=${encodeURIComponent(authToken)}`);
  } catch {
    return;
  }
  realtimeSocket = socket;
  socket.addEventListener("open", () => {
    try { socket.send(JSON.stringify({subscribe: ["state"]})); } catch { /* closing */ }
  });
  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.event === "wake") realtimeWake();
  });
  const scheduleReconnect = () => {
    if (realtimeSocket === socket) realtimeSocket = null;
    if (!authToken || realtimeReconnectTimer) return;
    realtimeReconnectTimer = setTimeout(() => { realtimeReconnectTimer = null; connectRealtime(); }, 3000);
  };
  socket.addEventListener("close", scheduleReconnect);
  socket.addEventListener("error", () => { try { socket.close(); } catch { /* already closed */ } });
}

function disconnectRealtime() {
  if (realtimeReconnectTimer) { clearTimeout(realtimeReconnectTimer); realtimeReconnectTimer = null; }
  if (realtimeSocket) { try { realtimeSocket.close(); } catch { /* already closed */ } realtimeSocket = null; }
}

// Long-poll fallback keeps the console fresh if the WebSocket is unavailable or between reconnects.
setInterval(() => {
  if (!authToken || loading || modalHtml || formTouched) return;
  const active = document.activeElement;
  if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;
  loadPage().catch(() => {});
}, 5000);

/* ---------------- 启动 ---------------- */

if (authToken && currentAccount) {
  page = page || defaultPageFor(perspectiveOf(currentAccount));
  connectRealtime();
  loadPage().then(() => {
    if (page === "monitor") {
      loadExecEvents({reset: true}).catch(() => {});
      startExecPolling();
    }
  }).catch((error) => {
    lastError = error?.message || String(error);
    render();
  });
} else {
  render();
}

// ESC 关闭当前弹窗（受保护弹窗会先二次确认）+ Tab 焦点陷阱（无障碍）
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && modalHtml && !document.querySelector('.modal-mask[style*="z-index: 350"]')) {
    requestCloseModal();
    return;
  }
  if (event.key === "Tab") {
    const container = activeModalContainer();
    if (!container) return;
    const focusable = [...container.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!container.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});
