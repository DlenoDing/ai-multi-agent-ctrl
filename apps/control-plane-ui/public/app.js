/*
 * 面向人的全中文管理后台（human-org-console/v1 §6）
 * 三视角：系统管理员 / 组织管理员 / 组织成员。
 * 所有内部枚举展示一律经过 i18n-zh.js 提供的 t() 渲染。
 */

const I18N = window.AIMAC_I18N || {t: (value) => String(value ?? "-")};
const t = (value) => I18N.t(value);

// 失败原因常常是 "code:detail" 形态（git_command_failed:… / skill_source_sync_failed:… /
// agent_runtime_executor_failed:…）：t() 拿到的是整串，词表里永远命中不了，于是屏幕上
// 摆着一串英文键加一段细节。这里先整串查词表，查不到就把冒号前那段翻译出来、细节原样接在后面。
function explainCoded(value) {
  if (value === null || value === undefined || value === "") return "-";
  const text = String(value);
  const dict = I18N.dict || {};
  if (Object.prototype.hasOwnProperty.call(dict, text)) return t(text);
  const at = text.indexOf(":");
  const prefix = at > 0 ? text.slice(0, at) : "";
  if (prefix && Object.prototype.hasOwnProperty.call(dict, prefix)) return `${t(prefix)}：${text.slice(at + 1)}`;
  return t(text);
}

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
// null 同时代表"还没取过""取失败了""没选项目"三件事，而界面把三者一律说成"配置接口加载失败" ——
// 人会去追一个并不存在的故障（实测：渲染一个全新项目的设置页，第一眼就是这句）。分成三态。
let projConfigStatus = "unloaded"; // unloaded | loaded | failed
let projConfigVersion = null;
let instructionState = null;
let loginHint = null;

let lastError = "";
let lastLoadedAt = null;
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

// 提交失败后 showError() 会整页重渲染，把人刚填的内容一起冲掉。最需要保住内容的恰恰是这一刻：
// expectedRound 409 不是故障，而是服务端在说「你看这页之后方案又改了，请重新看过再提交」——
// 人本来就要带着自己写的几百字理由回去比对。内容被清空会让人要么放弃、要么草草重写一句敷衍的
// 理由，而这些理由是要随决定留档的。这里按表单身份（data-form 及其全部 dataset）快照字段值，
// 重渲染之后原样填回。formDirtyKey 太粗（同类逐行表单共用一个 key），不能当身份用。
let pendingFormRestore = null;

function formIdentity(formEl) {
  return JSON.stringify(Object.keys(formEl.dataset).sort().map((key) => [key, formEl.dataset[key]]));
}

// 快照按【字段在表单里的位置】记录，不只按 name。规则编辑器每一行都有 name="ruleTitle"/"ruleContent"，
// 而回填原先用 querySelector 按 name 找元素 —— 它永远返回第一个匹配，于是 N 行的快照全写进第一行，
// 第一行最终变成最后一行的内容，而且被标成"未保存的修改"；人若直接再点保存，就把这份污染存了下去。
// 这是我为单字段表单（定稿理由、豁免理由）写的功能，没考虑同名多行 —— 而规则编辑器正是同名多行。
function snapshotFormValues(formEl) {
  const fields = [];
  [...formEl.querySelectorAll("input, textarea, select")].forEach((el, index) => {
    if (!el.name || el.type === "password") return; // 口令不进快照：内容留存的价值不值得让它多活一轮
    if (el.type === "checkbox" || el.type === "radio") fields.push([index, el.name, el.value, el.checked ? "checked" : "unchecked"]);
    else fields.push([index, el.name, el.value, "value"]);
  });
  return {identity: formIdentity(formEl), fields};
}

function restorePendingForm() {
  const snapshot = pendingFormRestore;
  pendingFormRestore = null; // 只补一次：过期的快照回填到别的表单上比清空更糟
  if (!snapshot) return;
  const formEl = [...document.querySelectorAll("form[data-form]")].find((el) => formIdentity(el) === snapshot.identity);
  if (!formEl) return;
  let restored = false;
  const targets = [...formEl.querySelectorAll("input, textarea, select")];
  for (const [index, name, value, mode] of snapshot.fields) {
    const el = targets[index];
    // 位置对上还要名字也对上：重渲染后行数或顺序可能变了，名字不符就说明这不是同一个字段，
    // 宁可不补也不能把内容写到别的格子里 —— 写错格比空着更难被发现。
    if (!el || el.name !== name) continue;
    if (mode === "value") {
      el.value = value;
      restored = restored || value !== "";
    } else {
      el.checked = mode === "checked";
    }
  }
  // 回填进来的是未保存内容，离开本页必须照样警告；提交失败时 formTouched 未被清掉，这里只是不让
  // 后续的重渲染把它当成干净页面。
  if (restored) { formTouched = true; dirtyFormKinds.add(formDirtyKey(formEl)); }
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
// 事件流是客户端的滚动窗口（只留最近 300 条）。丢弃发生过之后，页脚再报"共 N 条"就等于说
// "总共只发生过这些"，而人正是在这张表上排查"那一步到底做了什么"。丢过就改口径。
let execEventsDropped = false;
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

// "现在轮到我做什么" —— 此前控制台没有任何地方回答这个问题：菜单是写死的、没有计数，
// 唯一的待办数字在项目概览里且不可点击、只统计当前项目；而等人拍板的东西被拆在两个页面上，
// 其中一个还叫"执行监控"，名字完全不暗示"这里有等你签字的东西"。
// 这里跨【全部可见项目】统计，且只统计"确实需要这个人动手"的项 —— 没权限处置的不算进来，
// 否则计数会变成一个人永远清不掉的红点。
// 心跳有多旧要一眼看得出来。控制面把节点扫下线要等超时（默认 15 分钟），在那之前它照旧显示"在线" ——
// 而人此刻正想知道的就是"它是不是已经没了"。这里只做客户端提示，不改判定：真正的下线由服务端对账决定。
// "在线但一直不领活"是最容易让人干瞪眼的一种：节点绿着、派发排着，两种原因（角色不匹配 /
// 模型不可用）在界面上长得一模一样。控制面在筛的时候就知道答案，这里把它说出来。
// 执行事件带着的证据引用。规则文件那几条单独提出来放前面：它们回答的是"这次实际下发了哪几份规则"，
// 而其余引用（提交、检查点、指令）对人的价值低得多。
function evidenceRefsHint(event) {
  const refs = Array.isArray(event.evidenceRefs) ? event.evidenceRefs : [];
  if (!refs.length) return "";
  const ruleFiles = refs.filter((ref) => String(ref).startsWith("prompt-includes:"))
    .map((ref) => String(ref).slice("prompt-includes:".length));
  const others = refs.filter((ref) => !String(ref).startsWith("prompt-includes:"));
  return [
    ruleFiles.length ? `<div class="small muted">提示词实际包含：${ruleFiles.map((file) => esc(file)).join("、")}</div>` : "",
    others.length ? `<div class="small muted mono">${others.slice(0, 4).map((ref) => esc(String(ref).slice(0, 60))).join(" ")}</div>` : ""
  ].filter(Boolean).join("");
}

// sys.review-dual-track 要求轨道二比较替代方案时逐条给出【简单 / 高性能 / 稳定】三项取舍，
// 三项缺任一项即为评审未完成。但这条要求此前只写在规则正文里，没有任何东西能发现它被漏掉——
// 人看到的是一段读起来很完整的评估文字，看不出它其实只谈了性能。这里不拦截（关键词判断做不了
// 语义判断，拦错了会把合格评审挡在门外），只把"这条没提到哪一项"摆到人眼前，由人自己判断。
const REVIEW_AXES = [
  {label: "简单", pattern: /简单|简洁|复杂度|复杂性/},
  {label: "性能", pattern: /性能|吞吐|延迟|耗时|开销|QPS|qps/},
  {label: "稳定", pattern: /稳定|可靠|正确性|可恢复|健壮|容错/}
];

function alternativeAxisGaps(assessment) {
  const text = String(assessment || "");
  return REVIEW_AXES.filter((axis) => !axis.pattern.test(text)).map((axis) => axis.label);
}

// "自检未通过：gateway" 只说了缺哪一项，没说为什么 —— 人分不清是 DNS、TLS、401 还是服务端
// 没起，只能上那台机器翻日志。agent 那一侧知道确切原因，控制面也存了下来，这里必须显示出来。
function selfCheckFailureHint(node) {
  const failures = (node.selfCheckFailures || []).filter((item) => String(item?.detail || "").trim());
  if (!failures.length) return "";
  return failures.map((item) => `<div class="small muted">${esc(t(item.checkId) || item.checkId)}：${esc(item.detail)}</div>`).join("");
}

function claimMissHint(node) {
  const miss = node.lastClaimMiss;
  if (!miss || !miss.queuedCount) return "";
  const lines = (miss.reasons || []).slice(0, 3).map((item) => {
    if (item.reason === "role_not_allowed_on_node") {
      return `需要角色 ${esc(t(item.requiredRole) || item.requiredRole)}，本节点仅允许 ${esc((item.nodeRoles || []).map((role) => t(role) || role).join("、") || "无")}`;
    }
    if (item.reason === "model_not_runnable_on_node") {
      return `需要模型 ${esc(item.requiredModel)}，本节点可用 ${esc((item.nodeProviders || []).join("、") || "无")}`;
    }
    return esc(t(item.reason) || item.reason);
  });
  return `<div class="small warn-text">⚠ 有 ${miss.queuedCount} 个排队派发接不了：${lines.join("；")}</div>`;
}

function heartbeatStaleHint(node) {
  if (!node.lastHeartbeatAt || ["revoked", "offline"].includes(node.status)) return "";
  const ageMs = serverNow() - new Date(node.lastHeartbeatAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 3 * 60 * 1000) return "";
  const minutes = Math.floor(ageMs / 60000);
  return `<div class="small warn-text">⚠ 已 ${minutes} 分钟没有心跳</div>`;
}

function pendingForMe() {
  const groups = (state.taskGroups || []);
  const groupIds = new Set(groups.map((taskGroup) => taskGroup.id));
  const inScope = (item) => item && groupIds.has(item.taskGroupId);
  const canReview = hasPerm("task_group:review");
  const canControl = hasPerm("task_group:control");
  const canGrant = hasPerm("project:grant");
  const canUpdateProject = hasPerm("project:update");
  const buckets = [];
  // 视角接口为了体积把每个集合截到上限。截断后的数组长度不是总数，而这块面板恰恰以"总数"的口径
  // 说话（"共 N 项等待你处理"）——数据一多，人处置完 N 项会以为清空了。被截断的桶改报"N+"。
  const truncated = new Set(state.truncatedCollections || []);
  // taskGroups 自己也会被截断，而它决定了 inScope —— 超出上限的任务组下的待办连桶都进不去，
  // 一条都不会被算到。所以它一旦被截，所有桶的数字都只是下限，而不只是某一类不准。
  const scopeTruncated = truncated.has("taskGroups");
  const add = (id, label, page, items, allowed, sourceField) => {
    if (!allowed || !items.length) return;
    buckets.push({id, label, page, count: items.length, capped: scopeTruncated || truncated.has(sourceField), items: items.slice(0, 5)});
  };
  add("confirmations", "待你定稿的核心决策", "review",
    (state.humanConfirmationRequests || []).filter((item) => inScope(item) && item.status === "pending"), canReview, "humanConfirmationRequests");
  add("permissions", "待你批准的授权请求", "review",
    (state.permissionRequests || []).filter((item) => inScope(item) && item.status === "pending_approval"), canGrant, "permissionRequests");
  add("approvals", "待你处理的审批请求", "review",
    (state.approvalRequests || []).filter((item) => inScope(item) && ["requested", "quorum_collecting"].includes(item.status)), canReview, "approvalRequests");
  add("findings", "待你处置的发现项", "review",
    (state.findings || []).filter((item) => inScope(item) && !["resolved", "closed", "dismissed", "wontfix"].includes(item.status)), canReview, "findings");
  add("qualityGates", "未通过、可由你豁免的质量门", "monitor",
    (state.qualityGates || []).filter((item) => inScope(item) && !["passed", "waived"].includes(item.status)), canReview, "qualityGates");
  add("reviewPlans", "待你收尾的评审计划", "monitor",
    (state.reviewPlans || []).filter((item) => inScope(item) && !["closed", "rejected", "superseded"].includes(item.status)), canReview, "reviewPlans");
  add("reviewBundles", "待你收尾的评审包", "monitor",
    (state.reviewBundles || []).filter((item) => inScope(item) && !["consumed", "rejected"].includes(item.status)), canReview, "reviewBundles");
  add("ruleSources", "待你判定的规则来源", "monitor",
    (state.ruleSourceResolutions || []).filter((item) => inScope(item) && !["reference_only", "quarantined", "rejected", "superseded", "active"].includes(item.status)), canControl, "ruleSourceResolutions");
  add("upgradeCandidates", "待你判定的系统升级候选项", "monitor",
    (state.systemUpgradeCandidates || []).filter((item) => inScope(item) && item.status === "candidate_created"), canControl, "systemUpgradeCandidates");
  // 这两类同样【只有人能了结】，而且都在关闭门的阻塞清单里 —— 之前却不在待办里：
  // 人看到"0 待处理"，任务组却因为等他终止一个卡住的方案、或确认一条指令已被消费而关不掉。
  // 状态集与 computeCloseBarrier 的判据对齐（拓扑终态 merged/downgraded/cancelled；
  // 指令 queued/acknowledged 才算未消费），不另立一套 —— 两套口径迟早分叉，而分叉那天没人会发现。
  add("topologies", "待你终止的卡住执行方案", "monitor",
    (state.executionTopologies || []).filter((item) => inScope(item)
      && ["blocked", "needs_reconcile"].includes(item.status)), canControl, "executionTopologies");
  add("directives", "待你确认已被消费的人工指令", "directives",
    (state.humanDirectives || []).filter((item) => inScope(item)
      && ["queued", "acknowledged"].includes(item.status)), canControl, "humanDirectives");
  const visibleProjectIds = new Set(groups.map((taskGroup) => taskGroup.projectId).filter(Boolean));
  add("sharedDefinitions", "待你处置的共享定义契约", "monitor",
    (state.sharedDefinitions || []).filter((item) => ["owner_assigned", "proposed", "reviewing", "change_requested", "conflicted"].includes(item.status)
      && (!item.projectId || visibleProjectIds.has(item.projectId))), canUpdateProject, "sharedDefinitions");
  // "看不到"不等于"没有"。这些待办的来源集合只在 tasks 视角下发；在组织/系统/运行时视角里它们
  // 根本不存在，而 `|| []` 会把"这一页没加载"渲染成 0 —— 人在概览看到"3"，点进成员管理变成没有，
  // 会读成"已经处理掉了"。显式区分：不知道就别报数。
  const known = Array.isArray(state.taskGroups);
  const partial = buckets.some((bucket) => bucket.capped);
  return {buckets, total: buckets.reduce((sum, bucket) => sum + bucket.count, 0), known, partial};
}

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
const TONE_ORANGE = new Set(["attention", "pending", "review_requested", "paused", "draining", "degraded", "limited", "invited", "waiting_room_event", "waiting_dependency", "permission_required", "needs_decision", "stale_state", "reverify_required", "standby", "active_paused_by_control", "change_requested", "reopened", "requested", "reviewing", "candidate", "drift_signal", "monitor_attention", "needs_reconcile", "quota_limited", "awaiting_human_confirmation", "read_only", "close_candidate", "waived", "proposed", "conflicted", "change_requested", "discovered"]);
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
function laneFunctionLabel(value) { return value ? (LANE_FUNCTION_LABELS[value] || value) : "-"; }
// 模型决策的中文可读摘要（原始 modelDecision 为机器契约技术串，此处从结构化字段生成人读版本）
function modelDecisionSummaryZh(decision) {
  const parts = [];
  if (decision.taskExecutionClass) parts.push(`任务类型：${TASK_EXECUTION_CLASS_LABELS[decision.taskExecutionClass] || decision.taskExecutionClass}`);
  const model = decision.selectedModel?.modelId;
  if (model) parts.push(`选定模型：${model}`);
  const reasoning = decision.selectedModel?.reasoningLevel || decision.reasoningLevel;
  if (reasoning) parts.push(`推理档：${REASONING_LEVEL_LABELS[reasoning] || reasoning}`);
  // t() 自己就把空值渲染成 "-"；再兜一个 "-" 进去，等于拿显示文本当词条去查，
  // 开发期的"未映射枚举值"告警里就会混进 "-" 这种噪声，把真正漏译的那几条埋掉。
  return parts.length ? parts.join(" · ") : t(decision.selectionMode);
}

// 本机时区标签（UTC+8 这种）。服务端记的是 UTC，两边差几个小时而屏幕上不标，
// 对日志的人会以为记录不存在。
// 界面上"已 N 分钟没有心跳"这类判断，此前拿【浏览器本机时钟】去减服务端给的时间戳。
// 本机时钟快 20 分钟，所有健康节点都会显示"已 20 分钟没有心跳" —— 假警报会把人派去查一个
// 不存在的故障（慢的方向反而无害：算出来是负数，不会报警）。每次响应都带 Date 头，
// 拿它算一次偏差，之后所有相对时间都按【服务器的现在】算。
let serverClockSkewMs = 0;
function noteServerClock(response) {
  const header = response?.headers?.get?.("date");
  if (!header) return;
  const serverNowMs = new Date(header).getTime();
  if (!Number.isFinite(serverNowMs)) return;
  serverClockSkewMs = Date.now() - serverNowMs;
}
function serverNow() {
  return Date.now() - serverClockSkewMs;
}
// 偏差大到会影响判读时，直接说出来 —— 悄悄替人校正，人就永远不知道自己这台机器的表是错的。
function clockSkewNote() {
  const minutes = Math.round(serverClockSkewMs / 60000);
  if (Math.abs(minutes) < 2) return "";
  return `本机时钟比服务器${minutes > 0 ? "快" : "慢"} ${Math.abs(minutes)} 分钟`;
}

function localZoneLabel() {
  const minutes = -new Date().getTimezoneOffset();
  if (!Number.isFinite(minutes)) return "UTC";
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const rest = abs % 60;
  return `UTC${sign}${Math.floor(abs / 60)}${rest ? `:${String(rest).padStart(2, "0")}` : ""}`;
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
// total 来自 state 里的数组，而那个数组是视图按 limit 截过的 —— 直接写"共 200 条"是在报一个
// 被截出来的数字。传 field 时带上 +，口径与待办面板、菜单红点一致。
function moreText(total, shown, field) {
  const suffix = field === true ? "+" : (field ? countSuffix(field) : "");
  return total > shown ? `共 ${total}${suffix} 条，当前展示 ${shown} 条` : "";
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

/* ---------------- API 封装 ---------------- */

async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = {"content-type": "application/json", ...(options.headers || {})};
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  if (method !== "GET") headers["Idempotency-Key"] = uuid();
  // 服务端答了"不行"和"根本没答上话"，对人来说是两件完全不同的事：前者可以放心重试，
  // 后者【操作可能已经生效】—— 而控制台每次请求都换一个幂等键，重试等于再做一次。
  // 原先 fetch 自身失败时异常原样冒到界面：人看到一句浏览器的英文，且看不出这两者的区别。
  let response;
  try {
    response = await fetch(path, {...options, headers});
  } catch (networkError) {
    if (method === "GET") throw new Error(`加载失败：没有收到服务端响应（${String(networkError?.message || networkError).slice(0, 120)}）`);
    throw new Error("这次操作没有收到服务端的回应（网络中断或服务未响应）。"
      + "它可能已经生效，也可能没有 —— 请先刷新页面确认结果，不要直接重试："
      + `重试会以新的幂等键再做一次。（${String(networkError?.message || networkError).slice(0, 120)}）`);
  }
  noteServerClock(response);
  if (!response.ok) {
    let detail = "";
    let hint = "";
    try {
      const payload = await response.json();
      detail = payload.error || "";
      // 服务端在 403 里已经写明了缺哪个权限、作用在哪个资源上，前端原先只取 error 字段丢掉其余，
      // 于是人只看到"权限不足"，看不出该去要什么权限、找谁要 —— 报错指不到真正的原因。
      if (payload.requiredPermission) {
        const scope = payload.resourceScope ? `${payload.resourceScope.resourceType || "?"}:${payload.resourceScope.resourceId || "?"}` : "";
        hint = `（需要 ${payload.requiredPermission}${scope ? ` @ ${scope}` : ""}${String(payload.requiredPermission).startsWith("task_group:") ? "；这类权限只能在「项目成员授权」里按角色授予，写在账号上的直接权限不生效" : ""}）`;
      }
      if (Array.isArray(payload.permissions) && payload.permissions.length) hint += `（涉及：${payload.permissions.join("、")}）`;
      // 核心决策闸门上最容易并发的一步：两个人同时打开同一张确认单各自点定稿。CAS 只让一个写成，
      // 输的那一方原先只看到"该确认单已不在待处理状态"，不知道是谁、定了什么，只能自己去翻记录。
      if (payload.decidedBy || payload.decidedAction) {
        const who = payload.decidedBy ? accountName(payload.decidedBy) : "另一个人";
        const what = payload.decidedAction === "finalize" ? "定稿" : payload.decidedAction === "reject" ? "打回返工" : payload.decidedAction === "revise" ? "提交了修改意见" : "处理";
        hint += `（${esc(who)} 已在 ${fmtTime(payload.decidedAt)} ${what}${payload.decidedOption ? `：${esc(payload.decidedOption)}` : ""}；刷新即可看到结果，重复提交不会生效）`;
      } else if (payload.currentRound !== undefined) {
        hint += `（当前轮次已是第 ${esc(payload.currentRound)} 轮，你看到的是更早的一轮 —— AI 在你点击前修订过候选方案，请刷新后重新查看再决定）`;
      }
      // 配额超限时服务端已经算出了【哪一类、用了多少、上限多少】，前端原先只取 error ——
      // 人看到"组织配额已超限"，不知道是成员、项目、任务组还是智能体，也不知道差多少，
      // 更不知道下一步该去哪。这三样都在手上，不给出来没有任何理由。
      if (payload.quota !== undefined && payload.usage !== undefined) {
        const kindLabel = {members: "成员", projects: "项目", taskGroups: "任务组", agents: "智能体"}[payload.kind] || "该资源";
        hint += `（${kindLabel} ${esc(payload.usage)}/${esc(payload.quota)} 已满：到「组织管理」页调高这一项配额，`
          + "或先关掉/归档不再需要的，再重试）";
      }
      // 服务端在不少错误里写了给人看的说明（message / reason / required），前端原先只取 error 一个字段，
      // 把它们全丢了 —— 于是一条本来说清了"为什么、接下来怎么办"的 409，到人眼前只剩一串英文枚举。
      // 典型：停用一个还没接受邀请的成员 → 服务端解释了原因，人看到的是 `409 org_member_invitation_pending`。
      const guidance = [
        payload.message,
        payload.reason,
        Array.isArray(payload.required) ? payload.required.join("；") : payload.required
      ].map((item) => String(item || "").trim()).filter(Boolean);
      if (guidance.length) hint += `：${[...new Set(guidance)].join("；")}`;
    } catch {}
    if (response.status === 401 && authToken) {
      // 会话是【绝对过期】的（登录时定死，不续期）。而人在打字时轮询是暂停的，
      // 于是典型路径是：写了一大段说明、点提交，才发现会话早就过期了 ——
      // 此前这一刻会直接跳回登录页，内容、所在页面、所选项目一起没了，人只能凭记忆重写。
      stashDraftForExpiredSession();
      clearSession();
      render();
      toast.error("会话已过期，请重新登录 —— 你刚填写的内容已经保留，登录后会回到原处");
    }
    // 服务端有六处直接把 error.message 当错误码回（skill_source_sync_failed:… / pinned_commit_mismatch:… /
    // git_command_failed:…），同样是 code:detail 形态 —— 整串查词表命中不了，人看到一串英文键。
    throw new Error(`${response.status} ${detail ? explainCoded(detail) : response.statusText}${hint}`);
  }
  return response.json();
}

// 控制台每 5 秒轮询一次当前页的视图。内容没变时服务端回 304、不传载荷 ——
// 这里保留上一次的结果直接复用（连解析都省了）。ETag 里带了不写盘的运行时事实，
// 所以自治循环停摆这类变化不会被 304 挡住。
const stateEtags = new Map();
const stateCache = new Map();

// 项目视角的页面要带上当前项目：服务端据此在【截断之前】过滤，
// 既把载荷压回这个项目的规模，也避免"别的项目更新的记录把窗口占满、本项目的表是空的"。
//
// 作用域由【调用点】声明，不按视图名推断：runtime 视图既被项目视角的监控页用，
// 也被系统设置页用，而后者要看的是【全部项目】的角色技能叠加（叠加记录带 projectId）。
// 按视图名一刀切会让系统管理员只看得到当前项目的叠加，还以为别的项目没有改过角色规则。
async function fetchState(view, options = {}) {
  const scopeProjectId = options.projectId || "";
  const path = `/api/state?view=${encodeURIComponent(view)}&limit=200`
    + (scopeProjectId ? `&projectId=${encodeURIComponent(scopeProjectId)}` : "");
  const headers = {"content-type": "application/json"};
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const cacheKey = scopeProjectId ? `${view}:${scopeProjectId}` : view;
  const etag = stateEtags.get(cacheKey);
  const cached = stateCache.get(cacheKey);
  if (etag && cached) headers["if-none-match"] = etag;
  const response = await fetch(path, {headers});
  noteServerClock(response);
  if (response.status === 304 && cached) return cached;
  if (!response.ok) {
    // 走回统一的错误处理（401 清会话、把服务端写的说明带给人）
    return {...emptyState(), ...(await api(path))};
  }
  const payload = {...emptyState(), ...(await response.json())};
  const nextEtag = response.headers.get("etag");
  if (nextEtag) { stateEtags.set(cacheKey, nextEtag); stateCache.set(cacheKey, payload); }
  else { stateEtags.delete(cacheKey); stateCache.delete(cacheKey); }
  return payload;
}

function saveSession(sessionToken, account) {
  authToken = sessionToken;
  currentAccount = account;
  sessionStorage.setItem("aimac.sessionToken", sessionToken);
  sessionStorage.setItem("aimac.account", JSON.stringify(account));
  // 会话过期前留下的草稿：回到原页面原项目，并把内容交给既有的一次性回填。
  // 放在这里而不是登录表单的处理里 —— 所有登录路径都经过 saveSession。
  const resumed = restoreDraftAfterRelogin();
  if (resumed) toast.success("已回到会话过期前的位置，并恢复了你当时填写的内容 —— 请确认无误后再提交");
  connectRealtime();
  return resumed;
}

const EXPIRED_DRAFT_KEY = "aimac.expiredDraft";

// 会话过期这一刻，把"人正在填的东西"连同他所在的位置一起留下来。
// 只存一份、且带时间戳：隔了很久再登录时，回填一份陈旧草稿比空着更容易让人误交。
function stashDraftForExpiredSession() {
  try {
    const forms = [...document.querySelectorAll("form[data-form]")];
    const dirty = forms.find((form) => dirtyFormKinds.has(form.dataset.form)) || forms.find((form) =>
      [...form.querySelectorAll("input, textarea")].some((el) => el.type !== "password" && String(el.value || "").trim()));
    if (!dirty) return;
    sessionStorage.setItem(EXPIRED_DRAFT_KEY, JSON.stringify({
      page, projectId: currentProjectId || "", at: Date.now(), snapshot: snapshotFormValues(dirty)
    }));
  } catch { /* 存不下就算了：这是尽力而为的挽救，不能反过来把提交流程搞挂 */ }
}

// 重新登录之后：回到原来的页面与项目，并把草稿交给既有的一次性回填机制。
// 超过 30 分钟就丢掉 —— 那时人多半已经在做别的事，回填反而危险。
function restoreDraftAfterRelogin() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(EXPIRED_DRAFT_KEY) || "null"); } catch { saved = null; }
  sessionStorage.removeItem(EXPIRED_DRAFT_KEY);
  if (!saved?.snapshot || Date.now() - Number(saved.at || 0) > 30 * 60 * 1000) return false;
  if (saved.page) page = saved.page;
  if (saved.projectId) currentProjectId = saved.projectId;
  pendingFormRestore = saved.snapshot;
  return true;
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
  projConfigStatus = "unloaded";
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
// 打字确认：用于"点错一下就无法挽回、且影响面巨大"的操作。要求把提示里的那串字原样打一遍，
// 目的不是防脚本，而是逼人真的读到那几个数字 —— 单击式确认在这种场景下只能确认"你想做这类事"，
// 确认不了"你知道自己要毁掉多少东西"。返回 null 表示取消。
function promptDialog(options = {}) {
  const {title = "确认操作", message = "", sub = "", placeholder = "", danger = true, confirmText = "确定", cancelText = "取消"} = options;
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.style.zIndex = "350";
    mask.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" style="width:460px;">
        <div class="modal-header"><h3>${esc(title)}</h3></div>
        <div class="modal-body">
          <div class="confirm-message">${esc(message)}${sub ? `<span class="confirm-sub">${esc(sub)}</span>` : ""}</div>
          <div class="form-row" style="margin-top:10px;"><input data-prompt-input placeholder="${esc(placeholder)}" autocomplete="off"></div>
        </div>
        <div class="modal-footer">
          <button type="button" class="secondary-button" data-confirm="cancel">${esc(cancelText)}</button>
          <button type="button" class="primary-button ${danger ? "danger" : ""}" data-confirm="ok">${esc(confirmText)}</button>
        </div>
      </div>`;
    const input = () => mask.querySelector("[data-prompt-input]");
    const done = (value) => {
      document.removeEventListener("keydown", onKey);
      mask.remove();
      resolve(value);
    };
    const onKey = (event) => { if (event.key === "Escape") done(null); };
    mask.addEventListener("click", (event) => {
      const button = event.target.closest("[data-confirm]");
      if (!button) return;   // 点遮罩不关闭：与 confirmDialog 同规，避免误触
      done(button.dataset.confirm === "ok" ? String(input()?.value || "") : null);
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(mask);
    setTimeout(() => input()?.focus(), 0);
  });
}

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
  // 定稿之后不会当场发生什么：被挂起的执行要等下一次编排周期才放行。原先只说"已提交"，
  // 人会盯着页面等一个不会立刻到来的变化。说出它什么时候生效。
  "hcr-decide": "已提交人工确认：被它挂起的执行将在下一次编排周期（约一分钟内）继续",
  "directive-create": "已下达人工指令，将在下一编排周期生效",
  "perm-resolve": "已处理授权请求",
  "approval-resolve": "已处理审批请求",
  "finding-resolve": "已处置发现",
  "quality-gate-waive": "已豁免该质量门（理由已留档）",
  "review-plan-resolve": "已收尾评审计划",
  "rule-source-settle": "已提交规则来源判定",
  "plan-finalization": "已更新该工作项的方案定稿要求",
  "review-bundle-resolve": "已收尾评审包",
  "upgrade-candidate-resolve": "已处置系统升级候选项",
  "shared-definition-resolve": "已处置共享定义契约",
  "topology-cancel": "已终止该执行方案：关闭门禁将在下一次重算时不再被它阻塞",
  "close-task-group": "任务组已关闭"
};

/* ---------------- 项目范围 ---------------- */

function visibleProjects() {
  return state.projects || [];
}

// 切换器要能列出【全部】项目。完整记录有上限（每条 583 字节，全量下发会很贵），
// 所以超过上限时服务端另给一份只有 id/名称/状态的索引 —— 没有它，窗口之外的项目
// 在界面上根本选不到，而后端明明支持按它取数。
function selectableProjects() {
  return (state.projectIndex && state.projectIndex.length) ? state.projectIndex : visibleProjects();
}

function currentProject() {
  return visibleProjects().find((project) => project.id === currentProjectId) || null;
}

function ensureProjectSelection() {
  // 按【可选集合】判断，不按下发的完整记录：否则保存的项目一旦落在窗口之外，
  // 这里会认为它不存在，把人静默切到第一个项目 —— 人只会觉得"我的项目怎么变了"。
  const projects = selectableProjects();
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
      const [fullState, agentsResult] = await Promise.all([fetchState("orgs"), api("/api/org/agents")]);
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
      state = await fetchState("tasks", {projectId: currentProjectId});
      ensureProjectSelection();
      loadPendingConfirmCount();
    } else if (page === "tg") {
      state = await fetchState("tasks", {projectId: currentProjectId});
      ensureProjectSelection();
      if (expandedTaskGroupId) await loadTaskGroupDetail(expandedTaskGroupId);
    } else if (page === "review") {
      state = await fetchState("tasks", {projectId: currentProjectId});
      ensureProjectSelection();
      await loadReviewData();
    } else if (page === "directives") {
      state = await fetchState("tasks", {projectId: currentProjectId});
      ensureProjectSelection();
      await loadDirectiveData();
    } else if (page === "monitor") {
      const [tasksState, runtimeState] = await Promise.all([
        fetchState("tasks", {projectId: currentProjectId}),
        fetchState("runtime", {projectId: currentProjectId})
      ]);
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
      state = await fetchState("tasks", {projectId: currentProjectId});
      ensureProjectSelection();
      if (currentProjectId) {
        projConfigStatus = "unloaded";
        const configResult = await api(`/api/projects/${encodeURIComponent(currentProjectId)}/config`).catch(() => null);
        projConfig = configResult?.config || null;
        projConfigStatus = projConfig ? "loaded" : "failed";
        // 记住"我读到的是哪一版"。保存时带回去，服务端据此判断这层配置在我打开之后有没有被别人改过 ——
        // 规则保存是整份替换，没有这个前提，后保存的人会静默删掉先保存的人新增的规则，两人都拿到 200。
        projConfigVersion = configResult?.configVersion || null;
      } else {
        projConfig = null;
        projConfigStatus = "unloaded";
      }
    }
    ensureProjectSelection();
    lastError = "";
    lastLoadErrorToast = "";
    lastLoadedAt = Date.now();
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
  // 房间消息是 agent 之间实际说过的话。它此前在控制台上完全没有入口：人只看得到最后送上来的
  // 那一个提案，看不到它是怎么谈出来的。而人工定稿这道闸门的前提恰恰是「人能看见 AI 的推理过程
  // 再决定」—— 看不见协商过程，定稿就退化成对结论点头。读取失败不阻断详情页：房间是旁证，
  // 不该让它的问题挡住主干信息。
  const [progressResult, configResult, roomResult] = await Promise.all([
    api(`/api/task-groups/${encodeURIComponent(taskGroupId)}/progress`),
    api(`/api/task-groups/${encodeURIComponent(taskGroupId)}/config`).catch(() => null),
    api(`/api/rooms/${encodeURIComponent(`room_${taskGroupId}`)}/messages?limit=50&tail=1`).catch(() => null)
  ]);
  tgDetail = {
    taskGroupId,
    progress: progressResult,
    config: configResult?.config || null,
    configVersion: configResult?.configVersion || null,
    roomMessages: roomResult?.messages || null,
    roomMessageTotal: roomResult?.total ?? null,
    roomMessagesTruncated: Boolean(roomResult?.truncated),
  };
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
  if (options.reset) execEventsDropped = false;
  const known = new Set(execEvents.map((event) => event.eventId));
  for (const event of result.events || []) {
    if (!known.has(event.eventId)) execEvents.push(event);
  }
  if (execEvents.length > 300) {
    execEventsDropped = true;
    execEvents = execEvents.slice(-300);
  }
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

// 上一次真正写进 DOM 的整页 HTML；任何绕过 render 的写入都必须把它作废
let lastRenderedHtml = null;

function renderLogin() {
  const hintBlock = loginHint
    ? `
      <div class="login-hint">
        <div>初始化令牌：${loginHint.bootstrapTokenConfigured ? "已配置（系统管理员可用初始化令牌登录）" : "未配置"}</div>
        ${!loginHint.tokenHintsExposed && loginHint.bootstrapTokenConfigured ? `<div class="small muted">登录账号是哪一个：见 <span class="mono">npm run init</span> 的输出或 README —— 生产环境不在公开登录页上显示它，那等于把凭据的一半送出去。</div>` : ""}
        ${loginHint.tokenHintsExposed && loginHint.systemAdminLogin ? `<div>系统管理员登录账号：<span class="mono">${esc(loginHint.systemAdminLogin)}</span>（填在上面的「登录账号」处，令牌填初始化令牌）</div>` : ""}
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
  // 登录页绕过了 render 的写入路径。不在这里作废缓存的话，退出再登录时 render 会算出
  // 与上次登录后【一模一样】的整页 HTML，于是被跳过 —— 人就永远停在登录页上。
  lastRenderedHtml = null;
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
  // 菜单上直接带计数：否则"等你签字的东西"藏在一个叫"执行监控"的页面里，人根本不会去点。
  const menuTodoCounts = todoCountsByPage();
  const menuHtml = MENUS[perspective].map((item) => item.divider
    ? `<div class="nav-divider">${esc(item.divider)}</div>`
    : (() => {
        const todo = menuTodoCounts[item.id] || {count: 0, capped: false};
        return `<button class="nav-item ${item.id === page ? "active" : ""}" data-menu="${item.id}">${esc(item.label)}${todo.count ? `<span class="nav-badge">${todo.count}${todo.capped ? "+" : ""}</span>` : ""}</button>`;
      })()
  ).join("");

  const showSwitcher = PROJECT_PAGES.has(page) && selectableProjects().length > 0;
  const switcherHtml = showSwitcher
    ? `
      <div class="project-switch">
        <span>当前项目</span>
        <select id="project-switcher" aria-label="当前项目">
          ${selectableProjects().map((project) => `<option value="${esc(project.id)}" ${project.id === currentProjectId ? "selected" : ""}>${esc(project.name || project.id)}</option>`).join("")}
        </select>
      </div>
    `
    : "";

  const html = `
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
            ${/* 界面上所有时间都按浏览器本机时区渲染，而服务端日志（audit-log.jsonl、执行事件）是 UTC。
                  不标时区，人拿屏幕上的时间去对日志会差好几个小时，进而以为那条记录根本不存在。 */""}
            <span class="small muted" title="界面时间按本机时区显示；服务端日志用的是 UTC">${esc(localZoneLabel())}</span>
            ${clockSkewNote() ? `<span class="small warn-text" title="相对时间已按服务器时钟校正">${esc(clockSkewNote())}</span>` : ""}
            <button class="secondary-button" data-action="open-change-password">修改密码</button>
            <button class="icon-button" data-action="refresh" title="刷新" aria-label="刷新">↻</button>
            <button class="secondary-button" data-action="logout">退出登录</button>
          </div>
        </header>
        ${/* 加载失败此前只弹一次 toast。toast 会消失，而这一屏还挂着上一次成功时的数据 ——
              盯着执行监控页的人看到的是冻住的画面，屏幕上没有任何迹象说"这已经不是现在的样子了"。
              对一个监控台来说这是最要紧的那一刻，所以给一条常驻横幅，下一次加载成功自动消失。 */""}
        ${lastError ? `<div class="notice warn-notice">连不上控制面或这一页加载失败，下面显示的是
          ${esc(lastLoadedAgo())}的旧数据：${esc(lastError)}</div>` : ""}
        ${truncationBanner()}
        <section class="content">${renderContent()}</section>
      </main>
    </div>
    ${modalHtml}
  `;

  // 5 秒轮询一次，绝大多数时候数据一个字节没变（服务端已经用 ETag 回 304 了），
  // 但界面此前照样把整页 DOM 拆了重建：4000 单元时是 292KB 反复解析 + 重排，
  // 而且【每次都会清掉用户的文字选区】—— 想复制一个 ID 都复制不完。
  // 时间都渲染成绝对值，同一份数据两次渲染逐字节相同，直接比字符串即可。
  // 命令式改过的地方（防重按钮、悬浮卡、筛选行）全都自己在 finally 里复原，
  // 不依赖重渲染兜底，所以跳过不会让它们卡住。
  if (html === lastRenderedHtml) return;
  const prevScrollY = window.scrollY;
  const prevTableScroll = [...document.querySelectorAll(".table-scroll")].map((el) => el.scrollLeft);
  app.innerHTML = html;
  lastRenderedHtml = html;

  // 轮询/局部刷新后恢复滚动位置，避免整页 render 抖动
  window.scrollTo(0, prevScrollY);
  const tableScrolls = document.querySelectorAll(".table-scroll");
  prevTableScroll.forEach((left, index) => {
    if (tableScrolls[index]) tableScrolls[index].scrollLeft = left;
  });
  reapplyFilters();
  associateFormLabels();
  restorePendingForm();
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
        <dt>中央状态库</dt><dd>${overview.storage.centralStateBytes === null || overview.storage.centralStateBytes === undefined
          ? `<span class="warn-text">量不到（不是 0）</span>` : fmtBytes(overview.storage.centralStateBytes)}</dd>
        <dt>项目事件库</dt><dd>${overview.storage.projectDbBytes === null || overview.storage.projectDbBytes === undefined
          ? `<span class="warn-text">量不到（不是 0）</span>` : fmtBytes(overview.storage.projectDbBytes)}${
          overview.storage.partial ? `<span class="warn-text"> · 有文件量不到，这个数偏小</span>` : ""}</dd>
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
    panel("审计日志", `
      <div class="stack">
        ${state.auditArchiveFault ? `<div class="notice warn-notice">审计归档写入失败，已有 ${esc(state.auditArchiveFault.lostEntries)} 条记录没能落盘（${esc(state.auditArchiveFault.error)}）—— 这段时间的操作事后查不到，请先修复磁盘或权限。</div>` : ""}
        ${table(["时间", "操作者", "动作", {label: "对象", c: "text-clip"}, "结果"], audit, {moreText: moreText((state.auditLog || []).length, 15)})}
        <div class="small muted">这里只保留最近 ${(state.auditLog || []).length} 条；更早的记录在归档文件里，不在这一屏内。</div>
        ${/* 主审计只由控制台/REST 侧的 audit() 写，MCP 那 85 个工具一次都不调它 ——
              经 MCP 改的状态在这一屏上【一条痕迹都没有】。人来这里问的正是"谁动了它"，
              所以必须说清这份台账的边界在哪、另一半在哪里看。 */""}
        <div class="small muted">这份台账只记控制台与 REST 侧的动作。经 MCP 工具做的改动记在服务端的
          <span class="mono">mcp-audit.jsonl</span> 里，不在这一屏内 —— 查"谁动了它"时两处都要看。</div>
        <div class="button-row"><button class="ghost-button" data-action="open-audit-archive">查看审计归档</button></div>
      </div>
    `, {wide: true})
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
    // 仓库地址此前一处都不显示：人看不出这个源钉的到底是什么，而"钉住哪一份"正是它存在的理由。
    `<span class="mono">${esc(source.sourceId)}</span><div class="small muted mono">${esc(source.repositoryUrl || "-")}${source.defaultRef ? ` @${esc(source.defaultRef)}` : ""}</div>`,
    // 同步失败时光显示 stale 说不出为什么；原因此前只在服务端日志里。
    badge(source.status) + (source.status === "stale" && source.lastSyncError
      ? `<div class="small warn-text">${esc(source.lastSyncError)}</div>` : ""),
    `<span class="mono">${esc(String(source.pinnedCommit || "").slice(0, 10))}</span>`,
    {v: String((state.roleSkills || []).filter((skill) => skill.sourceId === source.sourceId).length), c: "num"},
    // 已退役的源不再提供同步（自治周期也不会再碰它）；未退役的多一条"退役"出口 ——
    // 接进来却拿不下去，此前只能眼看着它一遍遍重试。
    source.status === "retired"
      ? `<span class="small muted">已退役，不再同步</span>`
      : `<button class="secondary-button" data-action="sync-skill-source" data-source="${esc(source.sourceId)}">同步</button>`
        + ` <button class="secondary-button" data-action="retire-skill-source" data-source="${esc(source.sourceId)}"`
        + ` data-skills="${esc(String((state.roleSkills || []).filter((skill) => skill.sourceId === source.sourceId).length))}">退役</button>`
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
        ${/* 兜一个 "-" 进 executionProfileLabel，它会拿这个显示文本去查词条、查不到再原样吐出来：
              结果看着对，代价是开发期的"未映射枚举值"告警里多一条噪声，把真正漏译的埋掉。
              没有取值时让标签函数自己走 t(undefined)，它本来就渲染成 "-"。 */""}
        <dt>执行档位</dt><dd>${esc(executionProfileLabel(runtime.executionProfile))}</dd>
        <dt>后台自治</dt><dd>${runtime.autonomousOrchestrator?.enabled
          ? `每 ${esc(Math.round((runtime.autonomousOrchestrator.intervalMs || 0) / 1000))} 秒推进一次${orchestratorHealthText(runtime.autonomousOrchestrator)}`
          : `<span class="warn-text">已关闭：后台不推进任何东西 —— 人提交的指令会一直停在待处理，派发不会被领走，关闭门不会重算</span>`}</dd>
        <dt>状态机执行</dt><dd>${runtime.transitionEnforcement === "strict"
          ? "严格（非法状态转移一律拒绝）"
          : `<span class="warn-text">宽松：非法状态转移只记一笔就放行（${esc(runtime.transitionEnforcement || "未知")}）—— 流程不得跳步这条保证当前是关的</span>`}</dd>
        <dt>启动方式</dt><dd>${esc((runtime.launchModes || []).join("、") || "-")}</dd>
        <dt>MCP 工具数</dt><dd>${esc(runtime.mcp?.toolCount ?? "-")}</dd>
        <dt>更新时间</dt><dd>${fmtTime(runtime.updatedAt)}</dd>
      </dl>
    `),
    // 一个可用技能源都没有（没接过 / 全退役了）时，角色会全部回退到内置技能 —— 系统照常跑，
    // 但 agent 拿到的是通用规则而不是这个组织自己的角色规则。这件事不写出来，人看到的只是一张空表。
    panel("技能源", table(["技能源 / 仓库", "状态", "固定提交", {label: "角色数", c: "num"}, "操作"], sources)
      + ((state.skillSources || []).some((source) => source.status !== "retired")
        ? ""
        : `<div class="notice warn-notice">当前没有可用的技能源，所有角色都在用系统内置技能`
          + `（共 ${(state.roleSkills || []).filter((skill) => skill.sourceId === "system-default").length} 个）。`
          + "派发照常进行，但 agent 拿到的是通用角色规则，不是你们自己的那一份。</div>")),
    // 角色技能叠加会【改掉 agent 实际拥有的能力】（含 forbiddenCapabilityAdds），它是真人专属动作，
    // 数据也一直下发到这一页 —— 却从没有被渲染过：人看不到某个项目/任务组的角色规则被谁改过、改成了什么。
    // 创建仍走 API（补丁结构复杂，不值得为它在这里造一个编辑器），但"存在且生效"这件事必须看得见。
    panel("角色技能叠加（改动 agent 能力，只读）", (() => {
      const overlays = (state.roleSkillOverlays || []).filter((item) => item.status === "active");
      const rows = overlays.slice(0, 20).map((overlay) => row([
        `<span class="mono">${esc(overlay.roleSkillRef || "-")}</span>`,
        esc(overlay.taskGroupId ? `任务组 ${taskGroupNameOf(overlay.taskGroupId)}` : `项目 ${projectNameOf(overlay.projectId)}`),
        esc([
          (overlay.patch?.allowedCapabilityAdds || []).length ? `放开 ${(overlay.patch.allowedCapabilityAdds || []).join("、")}` : "",
          (overlay.patch?.forbiddenCapabilityAdds || []).length ? `禁掉 ${(overlay.patch.forbiddenCapabilityAdds || []).join("、")}` : ""
        ].filter(Boolean).join("；") || "只改了指令/模型要求"),
        {v: fmtTime(overlay.createdAt), c: "nowrap"}
      ])).join("");
      return `${overlays.length
        ? `<div class="notice">下面这些叠加正在改动 agent 实际拥有的能力。它们由人经 API 创建，控制台只读。</div>`
        : ""}${table(["被改的角色技能", "作用范围", "改了什么", {label: "创建时间", c: "nowrap"}], rows,
        {emptyText: "没有生效中的叠加：agent 用的就是技能源里的原始角色规则", moreText: moreText(overlays.length, 20, "roleSkillOverlays")})}`;
    })(), {wide: true}),
    panel("模型能力注册（只读）", table(["供应商", "模型", "能力", {label: "上下文窗口", c: "num"}, "可用性"], models, {moreText: moreText((state.modelCapabilities || []).length, 40, "modelCapabilities")}), {wide: true}),
    panel("指令压缩指标", `
      <div class="metric-grid">
        <div class="metric"><span>稳定前缀预算（配置值）</span><strong>${esc(metrics.stablePrefixTokens)}</strong></div>
        ${(() => {
          // 这一栏原先只显示上面那个【配置的预算值】，却写着"稳定前缀 Token 数"，被读成实测结果。
          // 实测与预算是两件事：预算是想要多少，实测是真的下发了多少。两个都显示，并且实测缺席时
          // 明说"尚未测量"，而不是拿预算值冒充。
          const measured = metrics.stablePrefixMeasured;
          if (!measured) {
            return `<div class="metric"><span>稳定前缀实测</span><strong class="warn-text">尚未测量</strong>
              <span class="small muted">还没有构建过内容包；下一次派发后这里会显示真实体积</span></div>`;
          }
          const over = Number(measured.chars) > Number(metrics.stablePrefixTokens || 0) * 2;
          return `<div class="metric"><span>稳定前缀实测（最近一次构建）</span>
            <strong class="${over ? "warn-text" : ""}">${esc(measured.chars)} 字符 / ${esc(measured.entryCount)} 份</strong>
            <span class="small muted">${esc(taskGroupNameOf(measured.taskGroupId))} · ${fmtTime(measured.observedAt)}${over ? " · 已显著超出预算" : ""}</span></div>`;
        })()}
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
        ${decisionSelect("accountId",
          (orgMembers && orgMembers.length ? orgMembers : (state.accounts || []))
            .map((account) => [account.accountId, account.displayName || account.accountId]),
          "请选择授权对象…")}
      </div>
      <div class="form-row"><label>项目角色</label>
        ${/* 默认停在 project_owner 上：不读就提交，等于把最高权限授予名单里排第一的人。
              授权对象与角色两个下拉都必须显式选择 —— 少了任一个，误授都能一次点击完成。 */ ""}
        ${decisionSelect("role", [
          ["project_owner", "项目负责人"],
          ["project_admin", "项目管理员"],
          ["task_group_owner", "任务组负责人"],
          ["reviewer", "评审人（可做人工定稿/验收）"],
          ["agent_operator", "智能体操作员"],
          ["viewer", "观察者"]
        ], "请选择项目角色…")}
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
      ${table(["令牌", "项目", "角色范围", "状态", {label: "已用次数", c: "num"}, {label: "过期时间", c: "nowrap"}, "操作"], tokens, {moreText: moreText((state.agentJoinTokens || []).length, 20, "agentJoinTokens")})}
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
          <div><div class="small muted">AI 智能体</div>${quotaLine(org.usage?.agents, org.quotas?.maxAgents)}${(() => {
            // 配额只数没被吊销的，而智能体那张表把已吊销的也列着 —— 不说清楚，人会拿表里的行数
            // 去对这个数字，对不上又找不出原因。只在确实有已吊销节点时才出现这一句。
            const revoked = (orgAgentNodes || []).filter((node) => node.status === "revoked").length;
            return revoked ? `<div class="small muted">另有 ${revoked} 个已吊销，不计入配额</div>` : "";
          })()}</div>
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
        <div class="metric"><span>项目总数</span><strong>${projects.length}${countSuffix("projects")}</strong></div>
        <div class="metric"><span>进行中的任务组</span><strong>${openTaskGroups.length}${countSuffix("taskGroups")}</strong></div>
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
  // task_group:* 这一类权限【只认按具体资源落位的 grant】，写在账号上的直接权限一律不生效
  // （直接权限不绑定任何资源，等于对所有资源生效，因此服务端一律拒绝）。
  // 继续把它们摆在这里，人会勾上、看到按钮被渲染出来、点下去却必定 403 —— 界面在说谎。
  // 要把"人工审核"交出去，请到「项目成员授权」里授予"评审人"角色。
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
  // 这几条此前掉到 permLabel 的 t() 兜底上，而 i18n 字典里也没有它们，于是「账号与授权」页
  // 的授权列表直接显示 task_group:control 这样的英文码。实测在真实数据上露出过四条。
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
    <div class="notice">「人工审核（验收定稿）」「任务组控制」这类任务组级权限不在这里授予 —— 它们必须按具体项目/任务组落位，请到「项目成员授权」里选择相应角色（例如"评审人"）。</div>
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
        // 邀请令牌只显示一次。丢了之后这一行原先只有「停用」——点它再点「启用」会撞 409，
        // 人会以为自己把账号弄坏了。真正需要的是重发。
        // 邀请被撤回（invited→停用）的账号同样从没接受过邀请：它唯一的出路也是重发，
        // 而「启用」对它必然 409 —— 所以这一行给的是重发，不是启用。
        account.status === "invited" || account.invitationWithdrawn
          ? `<button class="secondary-button" data-action="member-reissue-invite" data-account="${esc(account.accountId)}">重发邀请</button>`
          : "",
        account.invitationWithdrawn
          ? ""
          : account.status === "disabled"
            ? `<button class="secondary-button" data-action="member-status" data-account="${esc(account.accountId)}" data-status="active">启用</button>`
            : `<button class="danger-button" data-action="member-status" data-account="${esc(account.accountId)}" data-status="disabled">停用</button>`
      ].filter(Boolean).join(" ") : "-"
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
    + `<button class="danger-button" data-action="force-revoke-agent-node" data-node-id="${esc(node.nodeId)}" title="不等节点确认，当场作废其凭据">立即切断</button>`
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
    esc((project.members || []).map((member) => `${accountName(member.accountId)}（${t(member.role)}）`).join("、")),
    // 项目此前没有任何终结路径，于是组织的项目配额只增不减、建满之后再也建不了新的。
    hasPerm("project:update") && project.status !== "archived"
      ? `<button class="secondary-button" data-action="project-archive" data-project="${esc(project.id)}">归档</button>`
      : project.status === "archived" ? `<span class="small muted">已归档</span>` : "-"
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
    panel("项目列表", table(["项目", "状态", "进度", "阶段", "健康度", "成员", "操作"], projectRows), {wide: true})
  ].join("");
}

/* ---------------- 成员：项目概览 ---------------- */

function renderProjectOverview() {
  const project = currentProject();
  if (!project) {
    // 空态要按【这个人能做什么】说话。原先一律是"请联系组织管理员分配" —— 而系统管理员
    // 正是那个该去建项目的人，组织管理员也是；把他们支去找别人，是新部署第一步就撞上的死胡同。
    // （实测：全新部署、以系统管理员登录、打开项目概览，看到的就是这句。）
    const perspective = perspectiveOf(currentAccount);
    const next = perspective === "system"
      ? "到「账号与授权」页用「创建项目（系统级）」新建一个，或把已有项目授权给某个账号。"
      : perspective === "org"
        ? "到「项目管理」页创建项目，或把已有项目授权给成员。"
        : "请联系组织管理员为你分配项目。";
    return panel("项目概览", `<div class="notice">当前账号暂无可见项目。${esc(next)}</div>`, {wide: true});
  }
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
    // 项目概览是项目负责人一直盯着的那一页，也是最容易被"看起来一切正常"骗到的一页：
    // 实测真实数据下它显示"健康度 ok、完成度 75%"，而当时一个在线 agent 都没有、
    // 3 个单元交出去之后永远不会动 —— 任务组页和监控页都说了这件事，唯独这一页不说。
    // 提示复用同一个函数，措辞与那两页一致，人不必在不同页面上对同一件事建立两套理解。
    cellsWaitingWithNoAgentNotice(groups),
    wipCapacityNotice(groups),
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
          ${/* 人工指令的「暂停」和「取消」落到同一个执行状态（都是 active_paused_by_freeze），
                只有 pauseReason 分得开，而它此前一处都没渲染 —— 于是下了取消的人看到的是
                "已被冻结暂停"，和别人按的暂停一模一样，而两者能不能恢复并不一样。 */""}
          ${taskGroup.pauseReason ? customBadge(`停因：${t(taskGroup.pauseReason)}`, "orange") : ""}
        </div>
        ${progressLine(taskGroup.progress)}
        <div class="record-meta">
          <span>语言：${esc(taskGroup.languagePolicy?.languageName || taskGroup.languagePolicy?.languageTag || "中文")}</span>
          <span>角色数：${(taskGroup.roles || []).length}</span>
          <span>工作项：${esc(taskGroup.workItemCount ?? (taskGroup.workItems || []).length)}</span>
          <span>更新时间：${fmtTime(taskGroup.updatedAt)}</span>
        </div>
        ${/* 人工补充要求会原样进【每一次派发】的内容包，一直指挥后续所有 agent，而此前界面上
              一处都不渲染：人既看不到自己（或同事）当初加了什么，也就无从判断该不该再加一条。
              超出保留上限而丢掉的条数也要一并说出来。 */""}
        ${(taskGroup.humanGuidance || []).length ? `
        <details class="record">
          <summary>人工补充要求（${(taskGroup.humanGuidance || []).length} 条${Number(taskGroup.humanGuidanceDroppedCount || 0) ? `，另有 ${esc(taskGroup.humanGuidanceDroppedCount)} 条更早的已超出保留上限` : ""}）—— 它们会进入之后每一次派发</summary>
          ${(taskGroup.humanGuidance || []).slice(-20).reverse().map((item) => `
            <div class="record-meta"><span>${fmtTime(item.addedAt)}</span><span>${esc(item.text || "")}</span></div>
          `).join("")}
        </details>` : ""}
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

  return cellsWaitingWithNoAgentNotice(groups) + wipCapacityNotice(groups) + createPanels.join("") + (groupPanels || panel("任务组", `<div class="notice">当前项目暂无任务组。</div>`, {wide: true}));
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
    : `<div class="notice">事项清单尚未生成。控制面会按固定周期自动跑编排（默认每分钟一次），
        生成后会出现在这里 —— 你不需要点任何按钮。若长时间没有变化，多半是这个任务组还缺前置条件
        （例如项目尚未登记仓库、或角色技能未同步），到「执行监控」页看阻塞项。</div>`;

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
  const canReviewWork = hasPerm("task_group:review");
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

  // 视图里嵌的工作项是截断过的（真实总数在 workItemCount）。明细页优先用专用端点的完整列表；
  // 只有它没加载出来时才回落到这份截断的，而那时必须说清楚"这不是全部"。
  const embeddedTruncated = !progressData.workItems && taskGroup.workItemsTruncated === true;
  const workItems = (progressData.workItems || taskGroup.workItems || []).map((workItem) => {
    const dispatch = findWorkItemDispatch(taskGroup.id, workItem.id);
    return `
      <div class="record">
        <div class="record-title"><strong>${esc(workItem.title)}</strong>${badge(workItem.status)}</div>
        ${progressLine(workItem.progress)}
        <div class="record-meta"><span>执行角色：${esc(t(workItem.ownerRole))}</span>${workItem.blockedReason ? `<span>受阻原因：${esc(explainCoded(workItem.blockedReason))}</span>` : ""}</div>
        <!-- 被阻塞的工作项：屏幕上要么给出【出口】，要么明说【系统会自清】。只写一句"受阻原因"
             等于把人留在原地 —— 后端有杠杆而界面没入口，等于这个杠杆不存在；而系统自清的也必须
             说出来，否则人会去找一个并不需要的操作。每一条都按代码里真实的清除路径写：
             blocked_dependency 由下一轮编排自动放行，其余两种都要人先动手（已核实过产生它们的分支）。 -->
        ${workItemExitHint(workItem)}
        <!-- 决定"这件事算不算需要人定稿的方案"的分类器是字面匹配：它认不出架构与选型这类决策。
             机器判不了的事，判断权归人 —— 这里给出那个杠杆，并说清分类器的局限，
             免得"没被要求定稿"被读成"系统判断过、认为不必"。 -->
        ${workItem.requiresPlanFinalization === true
          ? `<div class="notice warn-notice">已由 ${esc(workItem.planFinalizationDecidedBy || "?")} 指定：必须先有人工定稿的执行方案才能开跑${workItem.planFinalizationJustification ? `（${esc(workItem.planFinalizationJustification)}）` : ""}</div>`
          : ""}
        ${canReviewWork ? `
          <form class="form-grid" data-form="plan-finalization" data-task="${esc(taskGroup.id)}" data-work="${esc(workItem.id)}" style="margin-top:8px;">
            <div class="record-meta"><span>系统靠关键词判断这件事要不要人工定稿方案，它认不出架构选型这类决策 —— 你可以直接指定。</span></div>
            <div class="form-row"><label>是否必须先定稿执行方案</label><select name="requiresPlanFinalization">
              <option value="false"${workItem.requiresPlanFinalization === true ? "" : " selected"}>不强制（按系统判断）</option>
              <option value="true"${workItem.requiresPlanFinalization === true ? " selected" : ""}>必须先由人定稿方案</option>
            </select></div>
            <div class="form-row"><label>理由（必填）</label><input name="justification" placeholder="例如：这涉及存储选型，做错了后面全要返工"></div>
            <button class="secondary-button" type="submit">保存</button>
          </form>` : ""}
        ${dispatch ? `
          <div class="record-meta"><span>派发：<span class="mono">${esc(dispatch.dispatchId)}</span></span><span>${badge(dispatch.status)} ${esc(dispatch.progressPercent || 0)}%</span></div>
          <div class="button-row"><button class="secondary-button" data-action="show-dispatch-events" data-dispatch-id="${esc(dispatch.dispatchId)}">实时事件</button></div>
        ` : ""}
      </div>
    `;
  }).join("");

  // 这一节原先只看提示型 blockers（S0/S1/S2），与"这个任务组能不能关闭"完全无关：
  // 关闭门禁只存在于"执行监控"页。于是人在任务组页看到"无阻塞"，却关不掉它 ——
  // 界面给出的是与事实相反的结论。把关闭门的判定接进来，并说清下一步该去哪。
  const groupBarrier = (state.closeBarriers || []).find((item) => item.taskGroupId === taskGroup.id);
  const barrierBlockers = groupBarrier && !groupBarrier.satisfied ? (groupBarrier.blockingObjects || []) : [];
  const advisoryBlockers = (progressData.blockers || taskGroup.blockers || []).map((blocker) => `
    <div class="record"><div class="record-title">${badge(blocker.severity || "attention")} <span>${esc(blocker.summary)}</span></div></div>
  `).join("") + (Number(taskGroup.blockersDroppedCount || 0) > 0
    // 提示有上限，超出的会被丢掉。悄悄丢等于让人以为问题只有屏幕上这几个。
    ? `<div class="record"><div class="record-title">${badge("attention")} <span>另有 ${esc(taskGroup.blockersDroppedCount)} 条较早的提示因数量上限已不再保留 —— 不要据此认为问题只有上面这些</span></div></div>`
    : "");
  const barrierSummary = !groupBarrier
    ? `<div class="record"><div class="record-title">关闭门禁：<strong>尚未计算</strong></div><div class="record-meta">在「执行监控」页点一次"重算关闭门禁"，或等下一次编排周期，才会知道这个任务组能不能关闭。</div></div>`
    : groupBarrier.satisfied
      ? `<div class="record"><div class="record-title">关闭门禁：${customBadge("可关闭", "green")}</div></div>`
      : `<div class="record">
          <div class="record-title">关闭门禁：${customBadge("存在阻塞", "red")}（${barrierBlockers.length} 项）</div>
          <div class="chip-row">${barrierBlockers.slice(0, 12).map((obj) => customBadge(`${t(obj.objectType) || obj.objectType}${obj.gate ? `·${t(obj.gate) || obj.gate}` : ""}`, "red")).join(" ")}</div>
          ${[...new Map(barrierBlockers.slice(0, 12)
            .map((obj) => [`${obj.objectType}:${obj.gate || ""}`, obj])).values()].map((obj) => {
            const guide = blockerGuide(obj.objectType, obj.gate);
            const label = obj.gate ? `${t(obj.gate) || obj.gate}` : `${t(obj.objectType) || obj.objectType}`;
            return guide ? `<div class="record-meta"><span>${esc(label)}：${esc(guide)}</span></div>` : "";
          }).join("")}
        </div>`;
  const blockers = `${barrierSummary}${advisoryBlockers || (barrierBlockers.length ? "" : `<div class="record">无其它提示型阻塞</div>`)}`;

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

  // 署名由服务端从已认证主体派生（account:… / agent_node:…），报文里自报的发送者一律不采信 ——
  // 否则这块面板会把 agent 自己署的名当成人说的话展示给人看，比不展示更糟。
  const roomMessages = tgDetail.roomMessages;
  const roomHtml = roomMessages === null
    ? `<div class="notice">协作记录读取失败或当前账号无权查看该任务组的房间。</div>`
    : !roomMessages.length
      ? `<div class="notice">暂无协作记录。agent 之间若通过房间协商方案，过程会显示在这里。</div>`
      : `<div class="stack">
          <div class="small muted">这些是 agent 之间实际交换的消息。送到你面前的方案可能是在这里谈成的 ——
            定稿前值得看一眼过程，而不只是结论。发送者由服务端按已认证身份署名，不是消息自报的。</div>
          ${/* 这一屏取的是【最近】的若干条：按游标从头取会正好错过谈成结论的那一段。
                被截掉的部分必须说出来，否则 50 条和"只有 50 条"在屏幕上长得一模一样。 */""}
          ${tgDetail.roomMessagesTruncated
            ? `<div class="small muted">共 ${esc(String(tgDetail.roomMessageTotal ?? "?"))} 条，这里显示最近 ${roomMessages.length} 条。</div>`
            : ""}
          ${roomMessages.map((message) => {
            const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
            const text = typeof payload.text === "string" && payload.text ? payload.text : JSON.stringify(payload, null, 2);
            return `
              <div class="record">
                <div class="record-title">
                  <span class="mono small">#${esc(String(message.sequence ?? ""))}</span>
                  <strong>${esc(String(message.senderRef || "unattributed"))}</strong>
                  ${message.senderRef === "unattributed" ? customBadge("无署名", "orange") : ""}
                </div>
                <div class="record-meta"><span>${fmtTime(message.createdAt)}</span></div>
                <pre class="small" style="white-space:pre-wrap;word-break:break-word;margin:6px 0 0;">${esc(String(text).slice(0, 4000))}</pre>
              </div>
            `;
          }).join("")}
        </div>`;

  return `
    <div class="stack" style="margin-top:8px;">
      ${sectionBlock("事项清单", analysisHtml)}
      ${sectionBlock("角色列表", `<div class="stack">${roles}</div>`)}
      ${sectionBlock("配置（继承 / 自定义）", configHtml)}
      ${sectionBlock("执行控制", controlHtml)}
      ${sectionBlock(`工作项${progressData.workItemsTruncated
        ? `（共 ${esc(progressData.workItemCount)} 个，当前展示 ${(progressData.workItems || []).length} 个）` : ""}`,
        `<div class="stack">${progressData.workItemsTruncated
        ? `<div class="notice">工作项很多，这里只加载了前 ${(progressData.workItems || []).length} 个（共 ${esc(progressData.workItemCount)} 个）—— 下面的筛选只在已加载的这些里找。</div>`
        : ""}${embeddedTruncated
        ? `<div class="notice warn-notice">进度接口没有加载出来，这里回落到列表视图里嵌的前 ${(taskGroup.workItems || []).length} 个（共 ${esc(taskGroup.workItemCount ?? "?")} 个）—— 不要据此判断"只有这些"。请刷新重试。</div>`
        : ""}${workItems || `<div class="notice">暂无工作项。</div>`}</div>`)}
      ${sectionBlock("准入与阻断分类", admissionHtml)}
      ${sectionBlock("阻塞", `<div class="stack">${blockers}</div>`)}
      ${sectionBlock("协作记录（agent 之间的房间消息）", roomHtml)}
    </div>
  `;
}

// 决策类下拉：默认必须是"尚未选择"。
// 这些下拉的第一项恰好都是后果最重的那一个（"已解决""关闭""采纳为本项目规则""激活为全局规范"），
// 而 select 默认选中第一项 —— 于是一个人点开表单直接提交，拿到的就是最重的处置，而他并没有做过
// 这个判断。规则源与共享定义那两条尤其要命：默认值等于"规则层变更默认发生"。
// 用禁用的占位项 + required：浏览器会在提交前拦下，人必须说出他决定的是什么。
function decisionSelect(name, options, placeholder = "请选择处置方式…") {
  return `<select name="${esc(name)}" required>`
    + `<option value="" selected disabled>${esc(placeholder)}</option>`
    + options.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join("")
    + `</select>`;
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
        <input class="rule-title-input" name="ruleTitle" value="${esc(rule.title || "")}" ${(isDefault || readOnly) ? "readonly" : ""} placeholder="规则标题">
        ${ruleSourceBadge(source)}
        <label class="rule-toggle"><input type="checkbox" name="ruleEnabled" ${enabled ? "checked" : ""} ${readOnly ? "disabled" : ""}> 启用</label>
        ${canDelete ? `<button type="button" class="danger-button" data-action="rule-del">删除</button>` : ""}
      </div>
      <textarea name="ruleContent" ${ro} placeholder="规则内容（可改写默认内容）">${esc(rule.content || "")}</textarea>
    </div>
  `;
}

function ruleRowNew(category) {
  return `
    <div class="rule-row" data-rule-row data-rule-category="${esc(category)}" data-rule-source="" data-orig-enabled="1" data-orig-content="" data-orig-title="">
      <div class="rule-head">
        <input class="rule-id-input" name="ruleId" maxlength="128" placeholder="规则 ID（可留空自动生成）">
        <input class="rule-title-input" name="ruleTitle" placeholder="规则标题">
        <label class="rule-toggle"><input type="checkbox" name="ruleEnabled" checked> 启用</label>
        <button type="button" class="danger-button" data-action="rule-del">删除</button>
      </div>
      <textarea name="ruleContent" placeholder="规则内容"></textarea>
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

// 服务端特意对超长规则回 422 而不是截断（它的注释写着"绝不静默削弱一条安全规则的语义"）——
// 而 textarea 的 maxlength 在请求发出之前就把超出部分丢掉了，于是那道 422 永远不会被人看到：
// 人写了一万字，存下的是前 8192 字，界面一声不吭。maxlength 已移除，改为提交时明确拒绝并说清超了多少。
const RULE_LIMITS = {title: 256, content: 8192};

function assertRuleFragmentLengths(fragments) {
  for (const fragment of fragments) {
    if (String(fragment.title || "").length > RULE_LIMITS.title) {
      throw new Error(`规则标题超长（${String(fragment.title).length} / 上限 ${RULE_LIMITS.title} 字）：${String(fragment.title).slice(0, 20)}… —— 请自行精简，系统不会替你截断`);
    }
    if (String(fragment.content || "").length > RULE_LIMITS.content) {
      throw new Error(`规则「${String(fragment.title || fragment.ruleId || "未命名")}」正文超长（${String(fragment.content).length} / 上限 ${RULE_LIMITS.content} 字）—— 请自行精简或拆成两条，系统不会替你截断（截断会悄悄改变这条规则的含义）`);
    }
  }
  return fragments;
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


// 「待你处理」是等人拍板的东西的唯一汇总入口，所以它不能依赖"当前选中的是哪个项目"。
// 视图接口按 limit 截断每个集合，因此数组长度不是总数。凡是把长度当成"共 N 项"呈现的地方，
// 数不全时都要带上 +，否则人会以为处置完眼前这些就清空了。
// 关闭门的阻塞类型有 16 种，而"执行监控页的阻塞项人工处置"只处理其中 6 种。其余 11 种的人
// 照着指引走过去是一片空白 —— 有出口却指错门，和没有出口一样让人卡住。按类型说清去哪、
// 或者说清"这一类不需要你动手，系统会自行清除"，后者同样重要：人不该守着一个不用他管的红点。
const BLOCKER_GUIDE = {
  HumanConfirmationRequest: "到「人工审核」页定稿或打回",
  PermissionOrApprovalRequest: "到「人工审核」页批准或驳回",
  HumanDirective: "到「人工指令」页确认该指令已被消费",
  ReviewPlan: "在本页下方「阻塞项人工处置」收尾评审计划",
  ReviewBundle: "在本页下方「阻塞项人工处置」收尾评审包",
  SharedDefinitionContract: "在本页下方「阻塞项人工处置」处置共享定义契约",
  ExecutionTopology: "在本页下方「阻塞项人工处置」终止卡住的执行方案",
  WorkSession: "执行中的会话：等它结束，或在「运行时节点」上取消对应派发",
  AgentDispatch: "执行中的派发：等它结束，或在「运行时节点」上取消它",
  Lease: "随持有它的会话一起释放：处理掉那个会话即可，无需单独操作",
  RoleDriftGuard: "随对应会话终结自动关闭：处理掉那个会话即可，无需单独操作",

  CommandEffect: "由编排周期自行和解，无需你动手",
  DerivedTaskRequest: "由编排周期分类后自行清除，无需你动手",
  WorkItem: "还有工作项没有交付所需产出：等执行完成，或取消对应工作项",
  Checkpoint: "缺少 Git 证据（提交/推送）：等执行方补齐，或取消对应工作项",
  RepositoryOutputTarget: "仓库产出目标尚未终态：等推送完成，或取消对应工作项"
};

// 派发卡住时的出口。只收【不动手就不会好】的那几种：*_requeued 与 control_* 是自愈或
// 操作员刚下达的瞬态，给它们写"出口"等于教人去做无用功。每条都对应代码里真实的解阻路径。
const STUCK_EXIT_HINT = {
  awaiting_human_confirmation: "到「人工审核」页定稿或打回对应的确认卡",
  human_confirmation_expired: "确认卡已超时：到「人工指令」页用「决策处置（重开 / 放弃）」处置",
  human_confirmation_expired_needs_decision: "确认卡已超时：到「人工指令」页用「决策处置（重开 / 放弃）」处置",
  permission_request_pending: "到「人工审核」页批准或驳回对应的权限申请",
  credential_required: "在承接它的 agent 节点上配置所需的凭据环境变量",
  agent_runtime_executor_required: "该节点没有可用的模型执行器：到「运行时」页核对节点自检结果",
  // 下面三条是【节点拒绝了人的控制指令且重试已用尽】。它们不会自己好，而且最要紧的一点是：
  // 控制面这边已经停了，那台机器上的 agent 可能还在跑 —— 出口是绕开节点配合的强制吊销。
  control_pause_rejected_by_node: "节点拒绝了暂停且重试已用尽：到「运行时」页对该节点点「立即切断」，再确认它确实停了",
  control_cancel_rejected_by_node: "节点拒绝了取消且重试已用尽：到「运行时」页对该节点点「立即切断」，再确认它确实停了",
  assigned_node_stop_control_failed_retries_exhausted: "节点停止控制重试已用尽：到「运行时」页对该节点点「立即切断」（不需要节点配合）",
  // 这两条只在【节点失联超时】后才会被自动重排；节点若还在心跳却始终不 ACK，它会一直等下去。
  // 所以不能登记成"会自己好"，出口是不需要节点配合的立即切断。
  assigned_node_revocation_pending_stop: "正在等节点确认吊销：节点失联超时后系统会自动重排；若它仍在心跳却迟迟不确认，到「运行时」页点「立即切断」",
  // 关停与吊销是同一条代码路径的两个分支，恢复方式也一样。孪生项里只有吊销那一半写了
  // 中文和出口，停机那一半两样都没有 —— 于是同一件事，走吊销的人看到中文指引，
  // 走关停的人看到一串英文、且没有下一步。
  assigned_node_shutdown_pending_stop: "正在等节点确认关停：节点失联超时后系统会自动重排；若它仍在心跳却迟迟不确认，到「运行时」页点「立即切断」",
  assigned_node_shutdown_pending_stop: "正在等节点确认下线：节点失联超时后系统会自动重排；若它仍在心跳却迟迟不确认，到「运行时」页点「立即切断」",
  task_group_pause: "整个任务组被人暂停了：到该任务组页点「恢复执行」"
};
// 提示只在【当前真的有派发卡在这些原因上】时出现，且按出现过的原因去重 —— 逐行重复同一句话
// 会把表格淹掉，而人需要的是"现在卡在哪几件事上、各自去哪处理"。
// 会话也会被停住，而且可能在【派发已经终结之后】仍然停着（确认卡超时那条链就是这样）——
// 那时只扫派发的话，这条提示不会出现，而会话仍然算活跃、仍然挡着关闭门。两边一起扫，一条提示。
const SESSION_SETTLED_STATUSES = ["completed_objective", "recycled", "failed", "aborted"];
function stuckExitNotice(dispatches, sessions) {
  const reasons = [
    ...(dispatches || []).filter((dispatch) => dispatch.status === "blocked").map((dispatch) => dispatch.blockedReason),
    ...(sessions || []).filter((session) => !SESSION_SETTLED_STATUSES.includes(session.status)).map((session) => session.blockedReason)
  ];
  const stuck = [...new Set(reasons.filter((reason) => STUCK_EXIT_HINT[reason]))];
  if (!stuck.length) return "";
  return `<div class="notice warn-notice">有执行被挡住，需要人处理：${stuck
    .map((reason) => `<br>· ${esc(t(reason) || reason)} —— ${esc(STUCK_EXIT_HINT[reason])}`).join("")}</div>`;
}

// 被阻塞工作项的出口提示。键优先看 blockedReason（更具体），退回到 status。
// 每一条都对应代码里真实的清除路径：写一条并不存在的"会自动恢复"，比什么都不写更糟。
const WORK_ITEM_EXIT_HINT = {
  needs_decision: "编排不会再自动推进它：到「人工指令」页用「决策处置（重开 / 放弃）」处置。",
  blocked_dependency: "无需操作：它依赖的工作项通过验收后，下一轮编排会自动放行。",
  model_selection_rejected: "没有可运行的模型满足它的硬性约束：到「运行时」页核对模型能力注册，或放宽该工作项的模型约束。",
  blocked_resource: "它等待的资源尚未就绪：到「运行时」页核对模型与技能源状态。",
  credential_required: "执行需要智能体运行时凭据：在承接它的 agent 节点上配置所需的凭据环境变量后重试。",
  permission_required: "需要先获得授权：到「人工审核」页批准对应的权限申请。",
  execution_failed_repeatedly: "同一个工作项连续多次执行失败，系统已停止自动重派（否则会一直空烧模型额度）：到「人工指令」页用「决策处置（重开 / 放弃）」处置，重开前先看阻塞提示里最近一次的失败原因。"
};
function workItemExitHint(workItem) {
  const hint = WORK_ITEM_EXIT_HINT[workItem.blockedReason] || WORK_ITEM_EXIT_HINT[workItem.status];
  return hint ? `<div class="notice warn-notice">${esc(hint)}</div>` : "";
}


// 拓扑阻塞项是 `种类:分支:细节` 这种结构串。原样铺出来人读不懂，而只显示"存在阻塞"
// 又等于没说 —— 按种类翻成中文，后面跟上分支与细节（它们是 id 与路径，本来就该原样给）。
function topologyBlockerText(blocker) {
  const [kind, ...rest] = String(blocker).split(":");
  const detail = rest.filter(Boolean).join(" · ");
  const label = t(kind);
  return detail ? `${label}（${detail}）` : label;
}

// 关闭门自己那一类阻塞（CloseBarrierGate）带的是【哪道门没过】，而指引按 objectType 查，
// 于是这一类永远查不到 —— 人看到一个红名词，没有下一步。指引因此要按门名给。
// 每条都对应代码里真实的解阻路径；不需要人动手的，就明说它会自己好，而不是编一个出口。
const CLOSE_GATE_GUIDE = {
  all_required_work_closed: "还有工作项没收口：到任务组页看它们卡在哪，或取消不再需要的那些",
  all_findings_terminal: "到「人工审核」页把未处置的发现项处置掉",
  all_quality_gates_passed: "到「执行监控」页处理未通过的质量门（可豁免，需填理由）",
  all_changes_integrated: "还有改动没合入：等执行方推完，或终止对应的执行方案",
  no_pending_permissions: "到「人工审核」页批准或驳回待处理的授权申请",
  no_pending_approvals: "到「人工审核」页处理待处理的审批请求",
  no_pending_human_confirmations: "到「人工审核」页定稿或打回待确认的卡",
  no_pending_human_directives: "到「人工指令」页确认那些指令已被消费",
  no_open_execution_topologies: "在「执行监控」页下方「阻塞项人工处置」终止卡住的执行方案",
  all_review_plans_closed: "在「执行监控」页下方「阻塞项人工处置」收尾评审计划",
  no_pending_review_bundles: "在「执行监控」页下方「阻塞项人工处置」收尾评审包",
  all_rule_sources_resolved: "在「执行监控」页下方「阻塞项人工处置」判定规则来源",
  all_shared_definitions_active: "在「执行监控」页下方「阻塞项人工处置」处置共享定义契约",
  rules_candidates_processed: "在「执行监控」页下方「阻塞项人工处置」判定系统升级候选项",
  artifacts_verified: "还有产物没核验：等执行方补齐证据，或取消对应工作项",
  all_repository_output_targets_terminal: "还有写入目标没终结：等对应会话结束，或取消它的派发",
  all_leases_terminal: "写锁随持有它的会话一起释放：处理掉那个会话即可",
  all_commands_terminal: "无需操作：命令总线会自行推进到终态",
  all_command_effects_terminal: "无需操作：编排周期会自行和解命令效果",
  no_blocking_derived_task_requests: "无需操作：编排周期分类后会自行清除",
  no_active_dlq: "死信条目只在命令重试超限时产生：到「执行监控」页核对命令总线",
  no_active_temp_grants: "临时授权到期自动回收；要立刻收回就到「账号与授权」页撤销",
  completion_readiness_clear: "完成度尚未就绪：看上面列出的其它阻塞项，它们清完这条自然就过",
  no_active_role_drift_blockers: "角色漂移守卫随对应会话终结自动关闭：处理掉那个会话即可",
  runtime_issue_candidates_exported: "到「执行监控」页把运行时问题候选导出/处置掉",
  all_contracts_compatible: "契约不兼容：需要重新签发契约，通常伴随规则变更 —— 看规则页的变更记录"
};


// "已启用 · 每 60 秒"说的是【意图】。周期每一拍都抛异常时，整套自动化已经停摆，
// 而这句话照写不误 —— 人要等到发现"什么都没动"才会怀疑，通常是几小时之后。
// 所以状态里带上上一拍的结果，界面据此说真话。
function orchestratorHealthText(status) {
  if (!status) return "";
  const failures = Number(status.consecutiveErrors || 0);
  if (failures >= 1) {
    return `<span class="warn-text">（连续 ${esc(failures)} 拍失败，最近一次：${esc(status.lastError || "未记录")}）</span>`;
  }
  return status.lastTickAt ? `（上一拍 ${esc(t(status.lastTickResult) || status.lastTickResult || "ran")}）` : "";
}

// 派发排着队、会话挂着 active，但一个能干活的 agent 都没有 —— 这时控制台看上去一片繁忙，
// 而真相是没有任何东西在跑。系统自己知道（节点数它有），此前却从不说。
// 判据用"在线"而不是"存在"：降级节点领不到活，把它算进去等于报喜不报忧。
function fleetOfflineNotice() {
  const fleet = (state || {}).fleet;
  if (!fleet) return "";                       // 这一视图没下发计数就不猜
  if (Number(fleet.online || 0) > 0) return "";
  const groups = projectTaskGroups();
  const inScope = (item) => groups.some((taskGroup) => taskGroup.id === item.taskGroupId);
  const waiting = (state.agentDispatches || []).filter((item) =>
    inScope(item) && !["completed", "failed", "cancelled"].includes(item.status)).length;
  if (!waiting) return "";                     // 没有活在等，就不必吓人
  const total = Number(fleet.total || 0);
  return `<div class="notice warn-notice">这个项目有 ${esc(waiting)} 个派发在排队或执行中，`
    + `但【没有任何在线的 agent 节点】${total ? `（已注册 ${esc(total)} 个，此刻都不在线或已降级）` : "（一个都还没注册）"}：`
    + `这些活现在不会有任何进展，界面上的"执行中"只是挂着。`
    + `先到 agent 页确认节点状态与自检结果${total ? "，把降级的那台修好或重启" : "，按安装指引接入一台"}。</div>`;
}

// 人把方案「交回 AI 再分析」之后，卡片会停在 awaitingAiAnalysis 等着 agent 来回答。
// 如果此刻一个在线 agent 都没有，这个等待【永远不会结束】—— 而人工确认页上只写着
// "等待 AI 再分析"，人就坐在那儿等一件不会发生的事。舰队掉线的提示原先只挂在监控页，
// 而这一页才是他等的地方。
// 任务组页是项目负责人盯单元的地方：单元停在 assigned/dispatched 不动时，他在这一页等。
// 而"没有任何在线 agent"此前只在监控页说 —— 他要先想到去监控页看，才知道自己在等一件
// 不会发生的事。提示要出现在他所在的位置。
function cellsWaitingWithNoAgentNotice(groups) {
  const fleet = (state || {}).fleet;
  if (!fleet || Number(fleet.online || 0) > 0) return "";
  const waitingStatuses = new Set(["assigned", "in_progress", "checkpoint_submitted"]);
  const waiting = (groups || []).flatMap((group) => (group.workItems || []))
    .filter((item) => waitingStatuses.has(item.status)).length;
  if (!waiting) return "";
  const total = Number(fleet.total || 0);
  return `<div class="notice warn-notice">这个项目有 ${esc(waiting)} 个单元已经交给执行方，`
    + `而当前【没有任何在线的 agent 节点】${total ? `（已注册 ${esc(total)} 个，此刻都不在线或已降级）` : "（一个都还没注册）"}：`
    + `它们不会有任何进展，进度条也不会再动。先到 agent 页确认节点状态${total ? "，把降级的那台修好或重启" : "，按安装指引接入一台"}。</div>`;
}

// 在制品额度用满时的出口。这条与"没有在线 agent"那条是两回事，不能合并：
// 额度满而【有】agent 在线是正常的背压，等在飞的活跑完就自己恢复，不需要人动手；
// 额度满而【没有】agent 在线才是死等 —— 那一条由 cellsWaitingWithNoAgentNotice 负责说，
// 这里不重复喊，否则两条提示同时出现，人会以为是两个毛病。
function wipCapacityNotice(groups) {
  const wip = (state || {}).wip;
  if (!wip || !Number(wip.capacity) || Number(wip.inFlight || 0) < Number(wip.capacity)) return "";
  const queued = (groups || []).flatMap((group) => (group.workItems || []))
    .filter((item) => ["draft", "ready"].includes(item.status)).length;
  const online = Number(((state || {}).fleet || {}).online || 0);
  if (!online) return "";
  // 占着名额的活自己也卡在等人时，"跑完就会自动继续"是假的：它们不会自己跑完。
  // 说错这一句的代价不是措辞问题 —— 人会照着它去干等，而实际上唯一能解开的人就是他。
  const blocked = Number(wip.blocked || 0);
  const stalled = blocked >= Number(wip.inFlight);
  const outlook = blocked
    ? `而占着名额的活里有 ${esc(blocked)} 个自己也卡住了（等你批权限、等你定稿、或被暂停）：`
      + `${stalled ? "名额全被它们占着，这个项目现在一步也走不动，" : ""}`
      + `这部分不会自己好，先到「人工审核」「人工指令」两页把它们处置掉，名额才腾得出来。`
    : "这是有意的背压，防止一次把成千上万个会话和租约摊开 —— 在飞的活跑完就会自动继续，不需要你动手。";
  return `<div class="notice${blocked ? " warn-notice" : ""}">这个项目的在制品已经达到上限`
    + `（在飞 ${esc(wip.inFlight)} / 上限 ${esc(wip.capacity)}）：`
    + `${queued ? `还有 ${esc(queued)} 个单元` : "后续单元"}会等额度，不会立刻派发。`
    + outlook
    + `想让它跑得更宽，就到 agent 页多接入几台节点（每多一台在线节点，额度自动上调）。</div>`;
}

function aiAnalysisStalledNotice(requests) {
  const fleet = (state || {}).fleet;
  if (!fleet || Number(fleet.online || 0) > 0) return "";
  const waiting = (requests || []).filter((item) => item.awaitingAiAnalysis && item.status === "pending").length;
  if (!waiting) return "";
  const total = Number(fleet.total || 0);
  return `<div class="notice warn-notice">有 ${esc(waiting)} 张卡片在等 AI 再分析，`
    + `而当前【没有任何在线的 agent 节点】${total ? `（已注册 ${esc(total)} 个，此刻都不在线或已降级）` : "（一个都还没注册）"}：`
    + `这个等待不会有结果。要么先到 agent 页把节点恢复，要么直接在这里定稿或打回 —— 不必等它回话。</div>`;
}

// 连续失败就不只是"参数里的一行小字"了：它意味着此刻没有任何东西在推进，
// 而人正在等系统自己往下走。放在监控页顶部。
function orchestratorStalledNotice() {
  const status = (state.runtime || {}).autonomousOrchestrator;
  const failures = Number(status?.consecutiveErrors || 0);
  if (!status?.enabled || failures < 2) return "";
  return `<div class="notice warn-notice">自治循环已连续 ${esc(failures)} 拍失败，当前【没有任何东西在自行推进】：`
    + `派发不会被领走、关闭门不会重算、人工指令会一直停在待处理。最近一次失败：${esc(status.lastError || "未记录")}`
    + `（最后一次成功推进：${status.lastSuccessAt ? esc(fmtTime(status.lastSuccessAt)) : "无记录"}）。`
    + `请先看服务端日志定位原因；恢复之前，需要人推进的事只能手动来。</div>`;
}


// 重置运行态要毁掉多少东西，只能用【服务端给的真实总数】。视图里的数组是截断过的，
// 而 organizations 在系统页那个视角里根本不下发 —— 拿它们算出来的是一个偏小甚至为 0 的数字。
// 拿不到就返回 null，让调用方拒绝执行，而不是拿假数字去换人的同意。
function bootstrapScaleFrom(overview) {
  const runtime = overview?.runtime;
  if (!runtime) return null;
  const {organizations, projects, taskGroups} = runtime;
  if ([organizations, projects, taskGroups].some((value) => typeof value !== "number")) return null;
  return {organizations, projects, taskGroups};
}

function blockerGuide(objectType, gate) {
  if (objectType === "CloseBarrierGate" && gate) return CLOSE_GATE_GUIDE[gate] || "";
  return BLOCKER_GUIDE[objectType] || "";
}

// 旧数据到底旧到什么程度，人得看得见 —— 只说"加载失败"，他不知道该不该继续照着这屏做决定。
function lastLoadedAgo() {
  if (!lastLoadedAt) return "登录以来一直没能加载成功的";
  const seconds = Math.max(0, Math.round((Date.now() - lastLoadedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`;
}

function countSuffix(field) {
  return (state.truncatedCollections || []).includes(field) ? "+" : "";
}

// 有些表把整个集合原样铺开（没有"当前展示 N 条"的页脚），于是视图截断在这些页上连一点痕迹都没有：
// 人看到的是一份自称完整的名单。账号、授权、智能体、项目这几张尤其要紧 —— 人正是照着它们
// 判断"谁有权限"、"有哪些项目"，少列一条就是漏掉一个人或一个项目。
// 视图为了体积会把每个集合截到上限，服务端如实登记在 truncatedCollections 里。此前只有 5 张表
// 各自调 capNotice 报出来，而界面上有 23 张表在渲染 state 集合 —— 其余 18 张【截了也不说】。
// 实测真实部署里 roleSkills 269 条被截到 188 条，屏幕上一个字都没有。
// 逐表加提示要靠每次新增表时都记得，改成整屏报一次并逐个点名：新表以后自动被覆盖。
const COLLECTION_LABELS = {
  accessGrants: "访问授权", accounts: "账号", admissionDecisions: "准入判决", agentControlCommands: "控制指令",
  agentDispatches: "派发", agentExecutionEvents: "执行事件", agentJoinTokens: "加入令牌",
  agentRuntimeNodes: "智能体节点", agents: "编排智能体", approvalRequests: "审批请求", auditLog: "审计台账",
  checkpoints: "检查点", closeBarriers: "关闭屏障", executionTopologies: "执行拓扑", findings: "评审发现",
  humanConfirmationRequests: "人工确认", humanDirectives: "人工指令", modelCapabilities: "模型能力",
  modelSelectionDecisions: "模型选择", organizations: "组织", permissionRequests: "授权请求", projects: "项目",
  qualityGates: "质量门", repositoryOutputs: "仓库产出", reviewBundles: "评审包", reviewPlans: "评审计划",
  roleSkillOverlays: "角色技能叠加", roleSkills: "角色技能", ruleSourceResolutions: "规则来源",
  sessionPlacementDecisions: "会话放置", sharedDefinitions: "共享定义", skillSources: "技能源",
  systemUpgradeCandidates: "升级候选", taskGroups: "任务组", testResults: "测试结果",
  workSessions: "工作会话", workerLanes: "载体"
};
function truncationBanner() {
  const fields = (state.truncatedCollections || []).filter((field) => field !== "truncatedCollections");
  if (!fields.length) return "";
  const names = fields.map((field) => COLLECTION_LABELS[field] || t(field)).join("、");
  return `<div class="notice warn-notice">这几份名单只加载了前若干条，实际条目更多：${esc(names)}`
    + " —— 不要据此判断「没有别的了」。</div>";
}

// 菜单红点的数字来源。独立成函数而不是内联在 render 里：内联的话，"红点与面板口径一致"这条
// 不变式只能靠源码字符串断言来守，而那类断言改个写法就假红、行为坏了却照样绿。
function todoCountsByPage() {
  const counts = {};
  try {
    const todo = pendingForMe();
    // 数据没下发到这一页时不出红点：0 与"未知"在红点上长得一模一样，而它们的含义相反。
    // 数不全时红点也要跟着改口径，否则同一件事在同一屏上出现两个数字：面板写"2+"，徽标写"2"。
    if (todo.known) for (const bucket of todo.buckets) {
      const prev = counts[bucket.page] || {count: 0, capped: false};
      counts[bucket.page] = {count: prev.count + bucket.count, capped: prev.capped || bucket.capped};
    }
  } catch { /* 计数是提示性的，任何异常都不该挡住导航渲染 */ }
  return counts;
}

function renderPendingForMePanel() {
  const todo = pendingForMe();
  return panel("待你处理", `
    ${!todo.known
      ? `<div class="notice">这一页没有加载待办所需的数据，因此这里不做统计（这不表示没有待办）。到「人工审核」或「执行监控」页查看。</div>`
      : todo.total === 0
      ? `<div class="notice">当前没有需要你处置的项。（只统计你有权处置的；别人负责的部分不会出现在这里。）</div>`
      : `<div class="notice warn-notice">共 ${todo.total}${todo.partial ? "+" : ""} 项等待你处理，跨你可见的全部项目统计。等人拍板的东西分布在两个页面上，这里是唯一的汇总入口。${todo.partial ? "<br><strong>带 + 的类别数据量超过本页加载上限，实际项数只多不少 —— 处置完这里列出的也未必清空。</strong>" : ""}</div>
         <div class="stack">
           ${todo.buckets.map((bucket) => `
             <div class="record">
               <div class="record-title"><strong>${esc(bucket.label)}</strong> ${customBadge(`${bucket.count}${bucket.capped ? "+" : ""}`, "red")}</div>
               <div class="record-meta"><span>处置入口：${esc(PAGE_META[bucket.page]?.[0] || bucket.page)}</span></div>
               <div class="button-row"><button class="secondary-button" data-menu="${esc(bucket.page)}">前往处置</button></div>
             </div>`).join("")}
         </div>`}
  `, {wide: true});
}

function renderReview() {
  if (!projectTaskGroups().length) {
    // 「待你处理」自称是跨全部可见项目的唯一汇总入口，却被"当前项目有没有任务组"这个不相干的条件
    // 挡在提前返回之后 —— 人切到一个空项目，"3 项等你处理"整块消失，会被读成"已经处理完了"。
    return panel("人工审核", `<div class="notice">当前项目暂无任务组。下面的汇总仍覆盖你可见的全部项目。</div>`, {wide: true})
      + renderPendingForMePanel();
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
      ${(() => {
        // 卡片正文是【创建那一刻】的快照。质量门在卡片挂起之后被豁免时，正文里什么都不会出现，
        // 而豁免表单上明写着"理由会随门一起留档并显示在验收卡片上" —— 界面许下的承诺没有兑现。
        // 证据引用同理：落在 question.evidenceRefs 里却从不渲染，人无法从卡片跳到检查点/提交记录。
        // 这两样都改成渲染时从当前状态实时取，而不是依赖创建瞬间的文本。
        const gates = (state.qualityGates || []).filter((gate) => gate.taskGroupId === request.taskGroupId
          && (!request.workItemId || gate.workItemId === request.workItemId));
        const waived = gates.filter((gate) => gate.status === "waived");
        const reversed = gates.filter((gate) => gate.previouslyFailed && gate.status === "passed");
        const reasserted = gates.filter((gate) => Number(gate.reassertedWithoutNewEvidenceCount) > 0);
        const evidence = request.question?.evidenceRefs || [];
        const parts = [];
        if (waived.length) {
          parts.push(`<div class="notice warn-notice" style="margin-top:8px;"><strong>已被人工豁免的质量门：</strong>${waived.map((gate) =>
            `<br>· ${esc(t(gate.gateType) || gate.gateType)} —— 由 ${esc(gate.waivedBy || "?")} 豁免${gate.waiveJustification ? `：${esc(gate.waiveJustification)}` : "（未填写理由）"}`).join("")}</div>`);
        }
        if (reversed.length || reasserted.length) {
          parts.push(`<div class="notice warn-notice" style="margin-top:8px;">
            ${reversed.length ? `<strong>曾判失败、后由执行方重报为通过：</strong>${esc(reversed.map((gate) => t(gate.gateType) || gate.gateType).join("、"))}` : ""}
            ${reasserted.length ? `<br><strong>无新证据的重报次数：</strong>${esc(reasserted.map((gate) => `${t(gate.gateType) || gate.gateType}×${gate.reassertedWithoutNewEvidenceCount}`).join("、"))}` : ""}
          </div>`);
        }
        if (evidence.length) {
          parts.push(`<div class="record-meta"><span>证据引用：${evidence.slice(0, 12).map((ref) => `<span class="mono">${esc(ref)}</span>`).join("、")}</span></div>`);
        }
        if (gates.length) {
          parts.push(`<div class="record-meta"><span>质量门：${gates.map((gate) => `${esc(t(gate.gateType) || gate.gateType)}${badge(gate.status)}`).join(" ")}</span></div>`);
        }
        return parts.join("");
      })()}
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
        ${(() => {
          // 轨道二（跳出方案另寻更优）与"考察边界声明"必须分开呈现：后者是一句免责声明
          // （控制面只核验证据层，结构上评估不了方案本身），混在一起会被读成"AI 已经比较过别的路了"。
          const all = request.peerReview.alternativesConsidered || [];
          const planLevel = all.filter((alt) => alt.scope !== "control_plane_evidence_only");
          const boundary = all.filter((alt) => alt.scope === "control_plane_evidence_only");
          const parts = [];
          if (planLevel.length) {
            parts.push(`<br><strong>考察过的其他方案：</strong>${planLevel.map((alt) => {
              const gaps = alternativeAxisGaps(alt.assessment);
              return `<br>· ${esc(alt.alternative)} —— ${esc(alt.assessment)}`
                + (gaps.length ? `<br><span class="warn-text">　⚠ 这条没说明：${esc(gaps.join(" / "))}（三项判准要求逐条给出取舍）</span>` : "");
            }).join("")}`);
          } else {
            parts.push(`<br><strong class="warn-text">⚠ 没有任何一方跳出当前方案考察过替代路径</strong><br><em>互审只沿着既定方案往下审，能发现"执行得不够好"，发现不了"方向本身就错了"。定稿前请自行判断这个方案是不是解决原问题的正确路径。</em>`);
          }
          if (boundary.length) {
            parts.push(`<br><strong>互审的考察边界：</strong>${boundary.map((alt) => `<br>· ${esc(alt.assessment)}`).join("")}`);
          }
          return parts.join("");
        })()}
      </div>` : ""}
      ${canReview ? `<form class="form-grid" data-form="hcr-decide" data-request="${esc(request.requestId)}" data-round="${esc(String(request.round || 1))}" style="margin-top:10px;">
        ${request.decisionClass === "major" ? `<div class="notice">核心决策不预选任何选项：这一栏必须由你主动勾选。AI 的推荐只是建议，预先替你选好会让"点一下定稿"成为最省力的路径，而这套闸门存在的理由正是不让 AI 的判断顺着惯性变成结论。</div>` : ""}
        <div class="option-list">
          ${(request.options || []).map((option, index) => `
            <label class="option-item">
              <input type="radio" name="selectedOptionId" value="${esc(option.optionId)}" ${request.decisionClass !== "major" && (option.recommended || (index === 0 && !(request.options || []).some((item) => item.recommended))) ? "checked" : ""}>
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
  // 同因：首项 fixed_verified 是唯一需要证据、也是唯一会被降级并继续阻塞的那一项，
  // 默认选中它等于替人做了最重的判断。
  const dispositionSelectHtml = decisionSelect("dispositionClass",
    ["fixed_verified", "not_applicable", "scope_adjusted"].map((cls) => [cls, t(cls)]), "请选择处置类别…");
  const authDispositionHtml = `
    <div class="stack">
      <div class="record-meta"><span>授权请求 ${pendingPermissions.length} · 审批请求 ${pendingApprovals.length} · 待处置发现 ${openFindings.length}（均阻塞关闭门禁）</span></div>
      ${!canReview && !canGrant ? `<div class="notice warn-notice">当前账号无“人工审核 / 授权”权限，仅可查看。</div>` : ""}
      ${pendingPermissions.map((item) => `
        <div class="record">
          <div class="record-title"><strong>授权请求：${esc(item.permission || "-")}</strong>${badge(item.status)}</div>
          <div class="record-meta"><span>任务组：${esc(taskGroupNameOf(item.taskGroupId))}</span><span>主体：${esc(item.subjectId || "-")}</span><span>原因：${esc(item.reason || "-")}</span><span>${fmtTime(item.createdAt)}</span></div>
          <!-- 卡片此前不显示 resource：一条申请 system:* 的越权请求在批准人眼里与普通任务组授权毫无区别。
               批准的是"给谁、什么权限、在什么资源上"，这三样必须同时可见，否则同意是盲签。 -->
          <div class="record-meta"><span>作用资源：<span class="mono">${esc(item.resource?.resourceType || "-")}${item.resource?.resourceId ? `:${esc(item.resource.resourceId)}` : ""}</span></span>${
            item.resource?.resourceType && item.resource.resourceType !== "task_group"
              ? customBadge(`超出任务组范围（${t(item.resource.resourceType) || item.resource.resourceType}）`, "red") : ""}</div>
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
          <!-- 曾被处置但因证据/归属不全而未能了结：不说明原因的话，人只看到它还开着，
               不知道上一次处置是被什么挡下来的，也就不知道补什么才能过。 -->
          ${item.lastResolutionAttempt ? `<div class="notice warn-notice">上一次处置未能了结它：判为 ${esc(t(item.lastResolutionAttempt.dispositionClass) || item.lastResolutionAttempt.dispositionClass)}（${esc(t(item.lastResolutionAttempt.reason) || item.lastResolutionAttempt.reason)}）。补齐后可再次处置。</div>` : ""}
          ${canReview ? `<form class="form-grid" data-form="finding-resolve" data-request="${esc(item.findingId)}" style="margin-top:8px;">
            <div class="form-row"><label>处置类别</label>${dispositionSelectHtml}</div>
            <div class="form-row"><label>处置状态</label>${decisionSelect("status", [["resolved", "已解决"], ["closed", "已关闭"], ["dismissed", "已忽略"], ["wontfix", "不修复"]])}</div>
            <div class="form-row"><label>证据引用（可选，逗号分隔）</label><input name="evidenceRefs" placeholder="evidence:..."></div>
            <button class="primary-button" type="submit">提交处置</button>
          </form>` : ""}
        </div>`).join("")}
      ${!pendingPermissions.length && !pendingApprovals.length && !openFindings.length ? `<div class="notice">当前项目没有待处置的授权 / 审批 / 发现。</div>` : ""}
    </div>`;

  const todoPanel = renderPendingForMePanel();

  return [
    todoPanel,
    aiAnalysisStalledNotice(allRequests),
    panel("待人工确认", `
      <div class="stack">
        <div class="record-meta"><span>共 ${pending.length}${countSuffix("humanConfirmationRequests")} 条待确认，覆盖 ${new Set(pending.map((item) => item.taskGroupId)).size} 个任务组（按提交时间倒序）</span></div>
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
            ${decisionSelect("resolution", [["reopen", "重开（返回就绪，重置返工计数）"], ["abandon", "放弃（置为已替代，解除关闭阻塞）"]])}
            <span class="small muted">仅“决策处置”类型生效</span>
          </div>
          <div class="form-row"><label>目标工作项 ID</label><input name="workItemId" placeholder="留空只处置该组处于“待人工决策”的格子；要放弃其它状态的工作项必须点名填写它的 ID" /></div>
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
  // 这一页整体以"当前项目"为抬头，因此页内每张表都必须按它过滤。
  // 此前七张表里有五张漏了，最严重的一张还挂着"关闭任务组"按钮。
  const inScope = (item) => groups.some((taskGroup) => taskGroup.id === item.taskGroupId);
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
    // 证据引用此前从不渲染，而执行方恰恰在这里上报了"这次提示词里实际包含了哪几份规则文件"
    // （prompt-includes:system/rules.md 之类）。人在控制台上只看得到 summary 里那句"含 N 个规则文件"，
    // 看不到是哪几个 —— 而"人写下的那份规则有没有真的到达模型"正是要从这里回答的。
    {v: `${esc(event.summary || "-")}${evidenceRefsHint(event)}`, c: "text-clip"},
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
    // 会话的阻塞原因此前只写在记录里、从不渲染：人看到一个 needs_decision 的徽标，看不出为什么。
    esc(explainCoded(session.blockedReason)),
    `<button class="secondary-button" data-action="show-session-events" data-session-id="${esc(session.sessionId)}">事件</button>`
  ])).join("");

  const dispatchesAll = filterSource((state.agentDispatches || []).filter((dispatch) => groups.some((taskGroup) => taskGroup.id === dispatch.taskGroupId)), "dispatches");
  const dispatches = dispatchesAll.slice(0, 20).map((dispatch) => row([
    `<span class="mono">${esc(dispatch.dispatchId)}</span>`,
    `<span class="mono">${esc(dispatch.workItemId || "-")}</span>`,
    badge(dispatch.status),
    {v: `${esc(dispatch.progressPercent || 0)}%`, c: "num"},
    // 这两个标记控制面早就在写了（写它们的注释里明写着"必须留痕并让人看到"），而控制台从来没有
    // 渲染过它们 —— 于是人只看到"认领超时重新入队"，看不到最要紧的那句：上一任可能已经把提交推上去了。
    // 新持有者的 reset --hard origin/<branch> 会把那些提交当作基线继续往上做，而没有任何人复核过它们。
    [
      esc(explainCoded(dispatch.blockedReason || dispatch.failureReason)),
      dispatch.previousHolderMayHavePushed
        ? `<div class="small warn-text">⚠ 上一任持有者${dispatch.recycledFromNodeId ? `（${esc(dispatch.recycledFromNodeId)}）` : ""}可能已经推送过提交：新持有者会把它们当作基线，需人工核对该分支</div>`
        : "",
      dispatch.rulesChangedAfterContract
        ? `<div class="small warn-text">⚠ 契约签发之后规则发生过变更：这次执行遵循的可能不是当前生效的规则</div>`
        : ""
    ].filter(Boolean).join(""),
    `<button class="secondary-button" data-action="show-dispatch-events" data-dispatch-id="${esc(dispatch.dispatchId)}">事件</button>`
  ])).join("");

  const commandsInScope = (state.agentControlCommands || []).filter(inScope);
  const commands = commandsInScope.slice(0, 16).map((command) => row([
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
    // "降级/只读"此前不说原因：缺哪几项自检只进网关事件负载，而那条流没有任何界面。
    // 人看到一个黄色徽标，然后无从下手。
    `${badge(node.status)}${claimMissHint(node)}${node.runtimeOutdated
      ? `<div class="small warn-text">运行时版本过旧（${esc(node.runtimeVersion || "未知")}）：它不发送认领代次，一旦这台机器上的派发被重新认领，提交就会被拒。请在该主机上重新执行入网安装命令升级。</div>`
      : ""}${(node.selfCheckMissing || []).length
      ? `<div class="small warn-text">自检未通过：${(node.selfCheckMissing || []).map((item) => esc(t(item))).join("、")}</div>`
        + selfCheckFailureHint(node) : ""}`,
    badge(node.admission),
    // 心跳时间戳原先只是一个时间：人得自己算它有多旧，而"节点其实已经死了"正是最该一眼看出来的。
    {v: `${fmtTime(node.lastHeartbeatAt)}${heartbeatStaleHint(node)}`, c: "nowrap"},
    node.status !== "revoked" && canControlNodes ? [
      `<button class="secondary-button" data-action="agent-control" data-node-id="${esc(node.nodeId)}" data-command="refresh_profile">刷新</button>`,
      `<button class="secondary-button" data-action="agent-control" data-node-id="${esc(node.nodeId)}" data-command="pause_dispatch">暂停</button>`,
      `<button class="danger-button" data-action="agent-control" data-node-id="${esc(node.nodeId)}" data-command="cancel_dispatch">取消</button>`
    ].join(" ") : "-"
  ])).join("");

  const decisionsInScope = (state.modelSelectionDecisions || []).filter(inScope);
  const decisions = decisionsInScope.slice(0, 10).map((decision) => row([
    esc(t(decision.roleId)),
    `<span class="mono">${esc(decision.workItemId || "-")}</span>`,
    `<span class="mono">${esc(decision.selectedModel?.modelId || "-")}</span>`,
    badge(decision.status),
    {v: esc(modelDecisionSummaryZh(decision)), c: "text-clip"}
  ])).join("");

  const placementsInScope = (state.sessionPlacementDecisions || []).filter(inScope);
  const placements = placementsInScope.slice(0, 10).map((decision) => row([
    `<span class="mono">${esc(decision.workItemId || "-")}</span>`,
    badge(decision.placement),
    badge(decision.workerCarrierDecision?.carrier || "-"),
    badge(decision.status)
  ])).join("");

  const admissionsInScope = (state.admissionDecisions || []).filter(inScope);
  const admissions = admissionsInScope.slice(0, 12).map((decision) => row([
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
  // 一张只显示"已通过"的表会让人以为门都真过了。曾判失败后被执行方重报为通过、以及无新证据的
  // 反复重报次数，都是"AI 在硬顶人工闸门"的信号，必须直接摆在这张表里。
  const qualityGateRows = filterSource((state.qualityGates || []).filter((qg) => groups.some((taskGroup) => taskGroup.id === qg.taskGroupId)), "quality-gates").slice(0, 20).map((qg) => row([
    esc(taskGroupNameOf(qg.taskGroupId)),
    esc(t(qg.gateType) || qg.gateType || "-"),
    `<span class="mono">${esc(qg.workItemId || "-")}</span>`,
    badge(qg.status) + (qg.previouslyFailed && qg.status === "passed" ? " " + customBadge("曾失败后被重报", "orange") : "")
      + (Number(qg.reassertedWithoutNewEvidenceCount) ? " " + customBadge(`无新证据重报 ${qg.reassertedWithoutNewEvidenceCount} 次`, "red") : "")
      + (qg.status === "waived" && qg.waivedBy ? ` <span class="record-meta">由 ${esc(qg.waivedBy)} 豁免</span>` : ""),
    {v: fmtTime(qg.updatedAt || qg.createdAt), c: "nowrap"}
  ])).join("");
  const waivableGates = (state.qualityGates || [])
    .filter((qg) => groups.some((taskGroup) => taskGroup.id === qg.taskGroupId) && !["passed", "waived"].includes(qg.status))
    .slice(0, 8);
  const failingTests = (state.testResults || []).filter((tr) => groups.some((taskGroup) => taskGroup.id === tr.taskGroupId) && ["failed", "error"].includes(tr.status));
  const canCloseTaskGroup = hasPerm("task_group:control"); // endpoint maps task_group_* -> task_group:control
  const canReviewGates = hasPerm("task_group:review");     // quality_gate_waive / review_plan_resolve
  const openReviewPlans = (state.reviewPlans || []).filter((plan) => inScope(plan) && !["closed", "rejected", "superseded"].includes(plan.status)).slice(0, 8);
  const openRuleSources = (state.ruleSourceResolutions || []).filter((item) => inScope(item) && !["reference_only", "quarantined", "rejected", "superseded", "active"].includes(item.status)).slice(0, 8);
  // 同段其余四处都按 inScope 过滤，唯独这里漏了 —— 于是在项目 A 的监控页上会列出项目 B 的契约。
  // （跨租户仍然安全：服务端只下发可见项目的契约。但列在这里会让人以为它属于当前项目。）
  const visibleProjectIds = new Set(groups.map((taskGroup) => taskGroup.projectId).filter(Boolean));
  const blockingDefinitions = (state.sharedDefinitions || []).filter((definition) =>
    ["owner_assigned", "proposed", "reviewing", "change_requested", "conflicted"].includes(definition.status)
    && (!definition.projectId || visibleProjectIds.has(definition.projectId))).slice(0, 8);
  const openReviewBundles = (state.reviewBundles || []).filter((item) => inScope(item) && !["consumed", "rejected"].includes(item.status)).slice(0, 8);
  const openUpgradeCandidates = (state.systemUpgradeCandidates || []).filter((item) => inScope(item) && item.status === "candidate_created").slice(0, 8);
  // 卡住的执行方案会永久挡住关闭门：分支报了 failed 之后拓扑照样进 integrating，merge 只认
  // accepted、cancel 又只有人能做。后端一直有"人来取消"这条杠杆（契约检查专门断言过它必须存在），
  // 但 executionTopologies 根本不在下发字段里，界面上也没有入口 —— 后端有杠杆而界面没有入口，
  // 等于这个杠杆不存在：人只看到"存在阻塞 · N 项"里的一个红 chip，然后无从下手。
  const TOPOLOGY_CANCELLABLE = ["running", "integrating", "blocked", "needs_reconcile"];
  const stuckTopologies = (state.executionTopologies || [])
    .filter((item) => inScope(item) && TOPOLOGY_CANCELLABLE.includes(item.status)).slice(0, 8);
  const canControlRules = hasPerm("task_group:control");   // rule_source_settle
  const canUpdateProject = hasPerm("project:update");      // shared_definition_resolve
  // 同段其余六处都按 inScope 过滤，唯独关闭门禁没有 —— 于是在项目 A 的监控页上会列出项目 B 的
  // 门禁，并且直接给出"关闭任务组"按钮。关闭是最不可逆的一步（写 humanFinalization 且只能关一次），
  // 在错误的项目抬头下点它，人以为关的是 A 的任务组。
  const barriersInScope = (state.closeBarriers || []).filter(inScope);
  const barriers = barriersInScope.slice(0, 8).map((barrier) => row([
    esc(taskGroupNameOf(barrier.taskGroupId)),
    barrier.satisfied ? customBadge("可关闭", "green") : customBadge("存在阻塞", "red"),
    {v: String((barrier.blockingObjects || []).length), c: "num"},
    {v: fmtTime(barrier.computedAt), c: "nowrap"},
    (barrier.satisfied && canCloseTaskGroup && taskGroupById(barrier.taskGroupId)?.status !== "closed")
      ? `<button class="primary-button" data-action="close-task-group" data-task="${esc(barrier.taskGroupId)}">关闭任务组</button>`
      : (taskGroupById(barrier.taskGroupId)?.status === "closed" ? customBadge("已关闭", "gray") : "-")
  ])).join("");

  return [
    orchestratorStalledNotice(),
    fleetOfflineNotice(),
    canOrchestrate ? panel("自治控制", `
      <div class="button-row">
        <button class="primary-button" data-action="orchestrator-run">运行自治循环</button>
        <button class="secondary-button" data-action="decide-model">模型决策</button>
      </div>
    `) : "",
    panel("实时事件流", `
      <div class="stack">
        <div class="record-meta"><span>监听范围：</span><select data-select="exec-scope" aria-label="执行监听范围">${scopeOptions.map((option) => `<option value="${esc(option.value)}" ${option.value === scopeValue ? "selected" : ""}>${esc(option.label)}</option>`).join("")}</select></div>
        ${table([{label: "序号", c: "num"}, "事件", {label: "进度", c: "num"}, "状态", {label: "摘要", c: "text-clip"}, {label: "时间", c: "nowrap"}], eventRows, {moreText: moreText(eventsShown.length, 120, execEventsDropped)})}
      </div>
    `, {wide: true, headerSide: filterInput("按事件、摘要过滤…", "events")}),
    panel("可复用执行载体（Worker Lane）", table(["角色", "功能", "状态", {label: "复用代数", c: "num"}, "当前会话", {label: "更新时间", c: "nowrap"}], laneRows, {moreText: moreText(lanesAll.length, 20, "workerLanes")}), {wide: true, headerSide: filterInput("按角色、会话过滤…", "worker-lanes")}),
    panel("工作会话", table(["会话", "角色", "工作项", "放置方式", {label: "执行载体", c: "nowrap"}, "状态", "原因", "详情"], sessions, {moreText: moreText(sessionsAll.length, 20, "workSessions")}), {wide: true, headerSide: filterInput("按会话、工作项过滤…", "sessions")}),
    panel("智能体派发", stuckExitNotice(dispatchesAll, sessionsAll) + table(["派发", "工作项", "状态", {label: "进度", c: "num"}, "原因", "详情"], dispatches, {moreText: moreText(dispatchesAll.length, 20, "agentDispatches")}), {wide: true, headerSide: filterInput("按派发、工作项过滤…", "dispatches")}),
    panel("控制通道", table([{label: "序号", c: "num"}, "节点", "命令", "作用对象", "状态", {label: "更新时间", c: "nowrap"}], commands, {moreText: moreText(commandsInScope.length, 16, "agentControlCommands")}), {wide: true}),
    panel("运行时节点", table(["节点", "状态", "准入", {label: "最近心跳", c: "nowrap"}, "操作"], nodes), {wide: true, headerSide: filterInput("按节点过滤…", "runtime-nodes")}),
    panel("模型选择记录", table(["角色", "工作项", "模型", "状态", {label: "决策说明", c: "text-clip"}], decisions, {moreText: moreText(decisionsInScope.length, 10, "modelSelectionDecisions")})),
    panel("会话放置记录", table(["工作项", "放置方式", {label: "执行载体", c: "nowrap"}, "状态"], placements, {moreText: moreText(placementsInScope.length, 10, "sessionPlacementDecisions")})),
    panel("准入决策", table(["工作项", "判定", "分类", {label: "原因", c: "text-clip"}], admissions, {moreText: moreText(admissionsInScope.length, 12, "admissionDecisions")}), {wide: true}),
    panel("检查点（Git 证据）", table(["任务组", "工作项", "提交", "推送", {label: "产出清单", c: "text-clip"}, {label: "时间", c: "nowrap"}], checkpointRows, {moreText: moreText(filterSource((state.checkpoints || []).filter((cp) => groups.some((taskGroup) => taskGroup.id === cp.taskGroupId)), "checkpoints").length, 20, "checkpoints")}), {wide: true, headerSide: filterInput("按工作项、提交过滤…", "checkpoints")}),
    (state.qualityGates || []).some((qg) => groups.some((taskGroup) => taskGroup.id === qg.taskGroupId)) ? panel("质量门禁 / 测试证据", `
      ${failingTests.length ? `<div class="notice warn-notice">有 ${failingTests.length}${countSuffix("testResults")} 项失败测试，阻塞关闭门禁（gateType 对应门禁为 failed，需修复并重提通过测试、取消对应工作项，或由你判定该门不适用后豁免）。</div>` : ""}
      ${table(["任务组", "门禁类型", "工作项", "状态", {label: "更新时间", c: "nowrap"}], qualityGateRows, {moreText: moreText(filterSource((state.qualityGates || []).filter((qg) => groups.some((taskGroup) => taskGroup.id === qg.taskGroupId)), "quality-gates").length, 20, "qualityGates")})}
      ${canReviewGates && waivableGates.length ? `
        <div class="record" style="margin-top:8px;">
          <div class="record-title">豁免未通过的质量门</div>
          <div class="record-meta">豁免是由你负责的放行决定：门仍未通过，只是你判定它在本次范围内不适用。执行方无法自行豁免，理由会随门一起留档并显示在验收卡片上。</div>
          ${waivableGates.map((qg) => `
            <form class="form-grid" data-form="quality-gate-waive" data-request="${esc(qg.gateId)}" style="margin-top:8px;">
              <div class="record-meta"><span class="mono">${esc(qg.gateId)}</span> · ${esc(t(qg.gateType) || qg.gateType || "-")} · ${esc(qg.workItemId || "-")} · ${badge(qg.status)}</div>
              <div class="form-row"><label>豁免理由（必填）</label><input name="justification" placeholder="例如：该门针对的能力不在本任务组范围内"></div>
              <button class="primary-button" type="submit">豁免此门</button>
            </form>`).join("")}
        </div>` : ""}
    `, {wide: true, headerSide: filterInput("按门禁类型、工作项过滤…", "quality-gates")}) : "",
    // 关闭门禁上每一个阻塞项都必须能在这里被人处理掉。后端有杠杆而界面上没有入口，
    // 等于这个杠杆不存在 —— 人只会看到一个红 chip，然后无从下手。
    (openReviewPlans.length || openRuleSources.length || blockingDefinitions.length || openReviewBundles.length || openUpgradeCandidates.length || stuckTopologies.length) ? panel("阻塞项人工处置", `
      <div class="notice">下面这些阻塞只能由人来收尾：AI 要么不该有权决定（采纳规则、激活规范），要么已经无法推进（评审角色不再参与）。</div>
      ${(!canReviewGates && (openReviewPlans.length || openReviewBundles.length)) || (!canControlRules && (openRuleSources.length || openUpgradeCandidates.length)) || (!canUpdateProject && blockingDefinitions.length)
        ? `<div class="notice warn-notice">其中有些阻塞需要你没有的权限才能处置：评审计划/评审包需要「人工审核(task_group:review)」，规则来源/升级候选需要「任务组控制(task_group:control)」，共享定义契约需要「项目更新(project:update)」。这类权限只能在「项目成员授权」里按角色授予（例如"评审人"），请找项目负责人或组织管理员授予后再来。</div>`
        : ""}
      ${canReviewGates && openReviewPlans.length ? `
        <div class="record" style="margin-top:8px;">
          <div class="record-title">评审计划（要求的评审角色到齐即自动闭合；到不齐时由你收尾）</div>
          ${openReviewPlans.map((plan) => `
            <form class="form-grid" data-form="review-plan-resolve" data-request="${esc(plan.reviewPlanId)}" style="margin-top:8px;">
              <div class="record-meta"><span class="mono">${esc(plan.reviewPlanId)}</span> · ${esc(taskGroupNameOf(plan.taskGroupId))} · ${badge(plan.status)}
                · 需要 ${esc((plan.requiredReviewerRoles || []).map((role) => t(role) || role).join("、") || "-")}
                · 已到 ${esc((plan.coveredReviewerRoles || []).map((role) => t(role) || role).join("、") || "无")}</div>
              <div class="form-row"><label>收尾方式</label>${decisionSelect("status", [["closed", "关闭（视为已完成评审）"], ["superseded", "被取代"], ["rejected", "驳回"]], "请选择收尾方式…")}</div>
              <div class="form-row"><label>理由（必填）</label><input name="justification" placeholder="例如：外部评审方不再参与，改由内部 QA 覆盖"></div>
              <button class="primary-button" type="submit">收尾评审计划</button>
            </form>`).join("")}
        </div>` : ""}
      ${canControlRules && openRuleSources.length ? `
        <div class="record" style="margin-top:8px;">
          <div class="record-title">规则来源分流（判为"采纳为本项目规则"只能由你做，AI 只能判不采纳）</div>
          ${openRuleSources.map((item) => `
            <form class="form-grid" data-form="rule-source-settle" data-request="${esc(item.resolutionId)}" style="margin-top:8px;">
              <div class="record-meta"><span class="mono">${esc(item.sourceRef || item.resolutionId)}</span> · ${esc(taskGroupNameOf(item.taskGroupId))} · ${badge(item.status)}</div>
              <div class="form-row"><label>判定</label>${decisionSelect("status", [["active", "采纳为本项目规则"], ["reference_only", "仅作参考"], ["quarantined", "隔离"], ["rejected", "不采纳"]], "请选择判定…")}</div>
              <div class="form-row"><label>理由（可选）</label><input name="justification" placeholder="判定依据"></div>
              <button class="primary-button" type="submit">提交判定</button>
            </form>`).join("")}
        </div>` : ""}
      ${canReviewGates && openReviewBundles.length ? `
        <div class="record" style="margin-top:8px;">
          <div class="record-title">评审包（外部评审结论回流后自动终态化；回不来时由你收尾）</div>
          ${openReviewBundles.map((bundle) => `
            <form class="form-grid" data-form="review-bundle-resolve" data-request="${esc(bundle.reviewBundleId)}" style="margin-top:8px;">
              <div class="record-meta"><span class="mono">${esc(bundle.reviewBundleId)}</span> · ${esc(taskGroupNameOf(bundle.taskGroupId))} · ${badge(bundle.status)}${bundle.workItemId ? ` · ${esc(bundle.workItemId)}` : ""}</div>
              <div class="form-row"><label>收尾方式</label>${decisionSelect("status", [["consumed", "已采纳该评审结论"], ["rejected", "驳回该评审包"]], "请选择收尾方式…")}</div>
              <div class="form-row"><label>理由（必填）</label><input name="justification" placeholder="例如：外部评审方未再回流，改由内部互审覆盖"></div>
              <button class="primary-button" type="submit">收尾评审包</button>
            </form>`).join("")}
        </div>` : ""}
      ${canControlRules && openUpgradeCandidates.length ? `
        <div class="record" style="margin-top:8px;">
          <div class="record-title">系统升级候选项（由运行时故障自动生成，需你判定后才不再阻塞）</div>
          ${openUpgradeCandidates.map((item) => `
            <form class="form-grid" data-form="upgrade-candidate-resolve" data-request="${esc(item.candidateId)}" style="margin-top:8px;">
              <div class="record-meta"><span class="mono">${esc(item.candidateId)}</span> · ${esc(taskGroupNameOf(item.taskGroupId))} · ${esc(t(item.issueClass) || item.issueClass || "-")} · ${badge(item.status)}</div>
              <div class="form-row"><label>判定</label>${decisionSelect("status", [["exported_for_external_maintenance", "已导出交外部维护"], ["dismissed", "不予处理"], ["closed", "已解决"]], "请选择判定…")}</div>
              <div class="form-row"><label>理由（必填）</label><input name="justification" placeholder="判定依据"></div>
              <button class="primary-button" type="submit">提交判定</button>
            </form>`).join("")}
        </div>` : ""}
      ${canUpdateProject && blockingDefinitions.length ? `
        <div class="record" style="margin-top:8px;">
          <div class="record-title">共享定义契约（AI 只能提议，激活为全局规范由你决定）</div>
          ${blockingDefinitions.map((definition) => `
            <form class="form-grid" data-form="shared-definition-resolve" data-request="${esc(definition.contractId)}" style="margin-top:8px;">
              <div class="record-meta"><span class="mono">${esc(definition.contractId)}</span> · ${esc(t(definition.definitionType) || definition.definitionType || "-")} · ${badge(definition.status)}${definition.proposedBy ? ` · 由 ${esc(definition.proposedBy)} 提议` : ""}</div>
              <div class="form-row"><label>处置</label>${decisionSelect("status", [["active", "激活为全局规范"], ["rejected", "驳回"], ["superseded", "被取代"], ["retired", "退役"]], "请选择处置…")}</div>
              <div class="form-row"><label>理由（必填）</label><input name="justification" placeholder="例如：已与相关方对齐，采纳为全局状态语义"></div>
              <button class="primary-button" type="submit">提交处置</button>
            </form>`).join("")}
        </div>` : ""}
      ${canOrchestrate && stuckTopologies.length ? `
        <div class="record" style="margin-top:8px;">
          <div class="record-title">卡住的执行方案（分支报失败后 merge 走不通，只有人能终止；不终止会一直挡着关闭门）</div>
          ${stuckTopologies.map((topology) => `
            <form class="form-grid" data-form="topology-cancel" data-request="${esc(topology.topologyId)}" style="margin-top:8px;">
              <div class="record-meta"><span class="mono">${esc(topology.topologyId)}</span> · ${esc(taskGroupNameOf(topology.taskGroupId))} · ${badge(topology.status)}
                · 工作项 <span class="mono">${esc(topology.workItemId || "-")}</span>
                ${topology.humanFinalization?.outcome === "confirmed" ? " · " + customBadge("已由人定稿", "blue") : ""}</div>
              ${(topology.blockers || []).length ? `<div class="small muted">卡在这几项：${(topology.blockers || [])
                .slice(0, 6).map((blocker) => esc(topologyBlockerText(blocker))).join("；")}</div>` : ""}
              <div class="form-row"><label>终止理由（必填，会写进定稿记录）</label><input name="cancelRef" placeholder="例如：分支 b_api 报失败且无法修复，改由串行方案重做"></div>
              <button class="danger-button" type="submit">终止该执行方案</button>
            </form>`).join("")}
        </div>` : ""}
    `, {wide: true}) : "",
    panel("关闭门禁", `
      ${table(["任务组", "状态", {label: "阻塞对象数", c: "num"}, {label: "计算时间", c: "nowrap"}, "操作"], barriers, {moreText: moreText(barriersInScope.length, 8, "closeBarriers")})}
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
      ? panel("规则配置", projConfigStatus === "failed"
        ? `<div class="notice warn-notice">暂时无法读取项目规则配置（配置接口加载失败），已隐藏规则编辑器以避免误保存清空规则。请点击右上角刷新重试。</div>`
        : `<div class="notice">正在加载项目规则配置…</div>`, {wide: true})
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
      const resumedFromDraft = saveSession(result.sessionToken, result.account);
      lastError = "";
      // 会话过期前留下过草稿时，saveSession 已经把页面/项目恢复成当时那一处；
      // 这里不能再把它覆盖成默认页，否则人登录后落在别处，草稿也就补不回那张表单了。
      if (!resumedFromDraft) page = defaultPageFor(perspectiveOf(currentAccount));
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
          <div class="command-box"><strong>带完整性校验的安装（推荐）</strong><pre id="join-verified">${esc(result.verifiedInstallCommand || "-")}</pre></div>
          <div class="button-row"><button type="button" class="secondary-button" data-action="copy-el" data-copy-target="#join-verified">复制该命令</button></div>
          ${/* 原先这里叫"校验安装（推荐）"，运维会读成"这条命令能防服务器被篡改"。实际不能：
                checksum 与安装脚本来自同一个地址、由同一个进程当场算出，没有离线签名。
                它防的是传输损坏与半截下载，不是有人换掉了产物。把这一点说清楚，
                否则这条命令给的是安全感而不是安全。 */ ""}
          <div class="notice">校验的是下载是否完整：checksum 与安装脚本来自同一个控制面地址、由同一个进程实时计算，
            因此它能发现传输损坏或下载不全，<strong>不能</strong>发现控制面本身被篡改或被中间人替换。
            要防住后者需要发布时离线签名、安装脚本内置公钥 —— 当前版本没有这一步。</div>
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
      await api(`/api/task-groups/${encodeURIComponent(form.dataset.task)}/config`, {method: "POST", body: JSON.stringify({defaultRoles, expectedConfigVersion: tgDetail?.configVersion || null})});
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
      await api(`/api/projects/${encodeURIComponent(form.dataset.project)}/config`, {method: "POST", body: JSON.stringify({repositories, baselineData, defaultRoles, expectedConfigVersion: projConfigVersion})});
      formTouched = false;
      await loadPage();
      return;
    }
    if (kind === "project-rules") {
      const fragments = assertRuleFragmentLengths(collectRuleFragments(form, "project"));
      const payload = form.dataset.category === "system" ? {systemRules: fragments} : {businessRules: fragments};
      payload.expectedConfigVersion = projConfigVersion;
      await api(`/api/projects/${encodeURIComponent(form.dataset.project)}/config`, {method: "POST", body: JSON.stringify(payload)});
      formTouched = false;
      await loadPage();
      return;
    }
    if (kind === "tg-rules") {
      const fragments = assertRuleFragmentLengths(collectRuleFragments(form, "task_group"));
      const payload = form.dataset.category === "system" ? {systemRules: fragments} : {businessRules: fragments};
      payload.expectedConfigVersion = tgDetail?.configVersion || null;
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
      // 定稿与打回都是一次性的：服务端对已非 pending 的确认单直接 409，点错不能改。而这三个按钮
      // 并排在同一行里，一个是"再商量一轮"，另两个是"永久锁定"或"打回"，视觉差别只有按钮配色。
      // 这是整套人工闸门的核心动作，此前却是唯一零确认的。
      if (action !== "revise") {
        const finalizing = action === "finalize";
        if (!(await confirmDialog({
          title: finalizing ? "确认定稿" : "确认打回返工",
          message: finalizing
            ? "定稿之后，AI 不得再自动更改这个方案；如需变更必须重新回到人工确认。"
            : "打回之后，这个工作项回到人工决策通道，等待重开或废弃。",
          sub: "该决定只能做一次，提交后无法修改。",
          danger: true,
          confirmText: finalizing ? "确认定稿" : "确认打回"
        }))) return "__skip_success__";
      }
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
    if (kind === "quality-gate-waive") {
      if (!String(data.justification || "").trim()) throw new Error("豁免质量门必须写明理由：这是由你负责的放行决定，理由会随门留档并显示在验收卡片上");
      await api(`/api/quality-gates/${encodeURIComponent(form.dataset.request)}/waive`, {method: "POST", body: JSON.stringify({justification: data.justification})});
      await loadPage();
      return;
    }
    if (kind === "review-plan-resolve") {
      if (!String(data.justification || "").trim()) throw new Error("收尾评审计划必须写明理由（例如：外部评审方不再参与）");
      await api(`/api/review-plans/${encodeURIComponent(form.dataset.request)}/resolve`, {method: "POST", body: JSON.stringify({status: data.status || "closed", justification: data.justification})});
      await loadPage();
      return;
    }
    if (kind === "review-bundle-resolve") {
      if (!String(data.justification || "").trim()) throw new Error("收尾评审包必须写明理由");
      await api(`/api/review-bundles/${encodeURIComponent(form.dataset.request)}/resolve`, {method: "POST", body: JSON.stringify({status: data.status || "consumed", justification: data.justification})});
      await loadPage();
      return;
    }
    if (kind === "upgrade-candidate-resolve") {
      if (!String(data.justification || "").trim()) throw new Error("处置系统升级候选项必须写明理由");
      await api(`/api/system-upgrade-candidates/${encodeURIComponent(form.dataset.request)}/resolve`, {method: "POST", body: JSON.stringify({status: data.status || "dismissed", justification: data.justification})});
      await loadPage();
      return;
    }
    if (kind === "plan-finalization") {
      if (!String(data.justification || "").trim()) throw new Error("指定是否需要人工定稿执行方案时必须写明理由");
      await api(`/api/task-groups/${encodeURIComponent(form.dataset.task)}/work-items/${encodeURIComponent(form.dataset.work)}/plan-finalization`,
        {method: "POST", body: JSON.stringify({requiresPlanFinalization: data.requiresPlanFinalization === "true", justification: data.justification})});
      await loadPage();
      return;
    }
    if (kind === "rule-source-settle") {
      await api(`/api/rule-source-resolutions/${encodeURIComponent(form.dataset.request)}/settle`, {method: "POST", body: JSON.stringify({status: data.status || "reference_only", justification: data.justification || ""})});
      await loadPage();
      return;
    }
    if (kind === "topology-cancel") {
      const cancelRef = String(data.cancelRef || "").trim();
      if (!cancelRef) throw new Error("终止执行方案必须写明理由（它会写进定稿记录）");
      // 终止是不可逆的终态转移，且当方案已被人定稿时会改写那条定稿记录（谁终止的、因为什么）。
      if (!(await confirmDialog({
        title: "确认终止该执行方案",
        message: "终止之后这个方案进入终态，不能再启动或合并；若它已由人定稿，定稿记录会被改写为本次终止。",
        sub: "这一步不可撤销。若只是想换一种执行方式，请先确认原方案确实走不通。",
        danger: true,
        confirmText: "确认终止"
      }))) return "__skip_success__";
      await api(`/api/execution-topologies/${encodeURIComponent(form.dataset.request)}/advance`, {method: "POST", body: JSON.stringify({action: "cancel", cancelRef})});
      await loadPage();
      return;
    }
    if (kind === "shared-definition-resolve") {
      if (!String(data.justification || "").trim()) throw new Error("处置共享定义契约必须写明理由");
      await api(`/api/shared-definition-contracts/${encodeURIComponent(form.dataset.request)}/resolve`, {method: "POST", body: JSON.stringify({status: data.status || "active", justification: data.justification})});
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
    pendingFormRestore = snapshotFormValues(form); // 必须在 showError 触发重渲染之前取
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
  // 防重提交原先靠一份手工维护的"会改状态的动作"清单，而清单必然漂移：新增一个会改状态的按钮
  // 忘了登记，防重就静默失效（实测 logout 就漏在外面）。下一个漏掉的可能是不可逆操作。
  // 导航走的是 data-menu 而不是 data-action，所以对每个动作按钮一律加防重不会误伤导航；
  // 同步动作只是在极短时间内禁用一次，代价可忽略。清单删掉，漂移这一类也就没了。
  const guardBtn = target.tagName === "BUTTON" ? target : null;
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
    if (action === "open-audit-archive") {
      // 归档此前只写不读：文件在磁盘上，而控制台没有任何入口 —— 对人来说等于不存在。
      const archive = await api("/api/audit-archive?limit=200");
      const rows = (archive.entries || []).map((entry) => row([
        fmtTime(entry.at),
        esc(accountName(entry.actor)),
        esc(t(entry.action)),
        {v: esc(entry.subject), c: "text-clip"},
        badge(entry.result || "ok")
      ])).join("");
      const chain = archive.chain || {verified: 0, breaks: []};
      const chainNotice = chain.breaks?.length
        ? `<div class="notice warn-notice">哈希链校验发现 ${chain.breaks.length} 处不一致（${esc(chain.breaks.slice(0, 3).map((item) => `${item.id}:${item.reason}`).join("、"))}）—— 归档可能被改动过。</div>`
        : `<div class="notice">已按哈希链逐条校验本屏 ${chain.verified} 条记录，未发现改动。</div>`;
      openModal("审计归档", `
        <div class="stack">
          ${chainNotice}
          ${archive.windowTruncated ? `<div class="small muted">归档文件共 ${Math.round((archive.fileBytes || 0) / 1024)} KB，这里只读了末尾 ${Math.round((archive.bytesScanned || 0) / 1024)} KB —— 更早的记录需要直接查归档文件。</div>` : ""}
          ${table(["时间", "操作者", "动作", {label: "对象", c: "text-clip"}, "结果"], rows, {emptyText: "归档里还没有记录"})}
        </div>
      `);
      return;
    }
    if (action === "bootstrap-init") {
      // 这是控制台里唯一一个能一次性摧毁全部租户的按钮，而它原先的交互成本与"刷新页面"相同：
      // 文案只说"重置为种子数据"，不会让人意识到自己名下所有组织、项目、账号、授权、审计链都会归零。
      // 先把规模摆出来，再要求把这个规模【原样打一遍】—— 打字是为了让人真的读到那几个数字。
      // 规模数字原先从【视图里的数组】算：而视图是按上限截断过的，organizations 在系统页
      // 这个视角里【压根不下发】—— 于是这个框会说"0 个组织、0 个项目"，人以为没什么可毁的，
      // 然后抹掉一切。这是全系统最不可逆的一步，宁可不做，也不能拿一个假数字换人的同意。
      const scale = bootstrapScaleFrom(systemOverview);
      if (!scale) {
        toast.error("拿不到当前运行态的真实规模（系统概览未加载）。不能在不知道会毁掉多少东西的情况下确认 —— 请刷新后重试。");
        return;
      }
      const confirmToken = `${Math.max(0, scale.organizations - 1)}/${scale.projects}/${scale.taskGroups}`;
      const typed = await promptDialog({
        title: "重新初始化运行态",
        message: `这会抹掉当前运行态里的【全部】数据：${scale.organizations} 个组织、${scale.projects} 个项目、${scale.taskGroups} 个任务组，以及全部账号、访问授权与审计记录。此操作不可撤销、没有备份。`,
        sub: `确认请在下方原样输入：${confirmToken}`,
        placeholder: confirmToken,
        danger: true,
        confirmText: "确认抹掉全部数据"
      });
      if (typed === null) return;
      if (String(typed).trim() !== confirmToken) { toast.error("输入与提示不一致，已取消"); return; }
      await api("/api/bootstrap/init", {method: "POST", body: JSON.stringify({confirmDestroy: confirmToken})});
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
    if (action === "project-archive") {
      if (!(await confirmDialog({
        title: "归档项目",
        message: "确认归档该项目？",
        sub: "归档只做一件事：把它移出可建新工作的范围，并把它占的项目配额释放出来。历史记录保留，内容不会被删除。项目下若还有未终结的任务组，会被拒绝并列出它们 —— 归档不替你处置它们。",
        danger: true, confirmText: "归档"
      }))) return;
      await api(`/api/projects/${encodeURIComponent(target.dataset.project)}/archive`, {method: "POST", body: "{}"});
      await loadPage();
      toast.success("项目已归档，配额已释放");
      return;
    }
    if (action === "member-reissue-invite") {
      if (!(await confirmDialog({
        title: "重发邀请",
        message: "确认为该成员重新签发一次性登录凭据？",
        sub: "旧的邀请令牌会当场失效 —— 重发不是再给一份，而是作废旧的、换一份，否则散落在聊天记录里的那一份仍然可用。新令牌同样只显示一次。",
        confirmText: "重发"
      }))) return;
      const reissued = await api(`/api/org/members/${encodeURIComponent(target.dataset.account)}/reissue-invite`, {method: "POST", body: "{}"});
      await loadPage();
      openModal("成员一次性登录凭据（重发）", `
        <div class="stack">
          <div class="notice warn-notice">以下凭据仅显示一次，请立即转交本人。旧的邀请令牌已失效。</div>
          <div class="command-box"><strong>登录账号</strong><pre>${esc(reissued.login?.email || "")}</pre></div>
          <div class="command-box"><strong>一次性令牌</strong><pre id="reissued-token">${esc(reissued.accountToken || "")}</pre></div>
          <div class="button-row"><button type="button" class="secondary-button" data-action="copy-el" data-copy-target="#reissued-token">复制令牌</button></div>
        </div>
      `, {protected: true});
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
    if (action === "retire-skill-source") {
      const skillCount = Number(target.dataset.skills || 0);
      if (!(await confirmDialog({
        title: "退役技能源",
        message: `确认退役技能源 ${target.dataset.source}？`,
        // 说清真实后果：不是"隐藏"，是把它带来的角色技能全部摘掉。
        sub: skillCount
          ? `它带来的 ${skillCount} 个角色技能会一并摘掉，用到这些技能的角色将回退到系统内置技能`
            + "（派发照常进行，界面上会标出「套用了别人的技能」）。指向它们的叠加规则会终态化。退役后不再自动同步。"
          : "该源目前没有带来任何角色技能。退役后不再自动同步。",
        danger: true,
        confirmText: "退役"
      }))) return;
      const result = await api(`/api/skill-sources/${encodeURIComponent(target.dataset.source)}/retire`, {method: "POST", body: "{}"});
      await loadPage();
      toast.success(`已退役：摘掉 ${result?.droppedRoleSkills ?? 0} 个角色技能`
        + (result?.supersededOverlays ? `，${result.supersededOverlays} 条叠加规则已终态化` : ""));
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
      // 原先这里写着"运行中的任务将被围栏并重新排队"、成功提示写着"已吊销" —— 而实际发生的只是
      // 排了一条撤销命令，节点在 ACK 之前仍然通过认证。界面报告了比实际更强的结果，运维会以为
      // 已经断开。文案必须说出真实发生的事，以及它什么时候才会真的生效。
      if (!(await confirmDialog({
        title: "吊销智能体节点",
        message: "确认吊销该智能体节点？",
        sub: "节点会收到撤销指令，交回运行中的任务后离线。它的凭据在此期间仍然有效（它需要凭据才能确认这条指令）；若在期限内没有确认，凭据会被自动作废。已知节点失陷时请改用「立即切断」。",
        danger: true, confirmText: "吊销"
      }))) return;
      await api(`/api/agent-nodes/${encodeURIComponent(target.dataset.nodeId)}/revoke`, {method: "POST", body: "{}"});
      await loadPage();
      toast.success("已下发吊销指令：节点确认后离线，超期未确认则自动作废其凭据");
      return;
    }
    if (action === "force-revoke-agent-node") {
      if (!(await confirmDialog({
        title: "立即切断该节点",
        message: "确认立即作废该节点的凭据？",
        sub: "凭据当场失效，不等节点确认 —— 用于已知失陷的节点。代价：它手上的任务不是被交回的，要等租约到期才回收，且会被标记为「上一任可能已推送」，需要人核对。",
        danger: true, confirmText: "立即切断"
      }))) return;
      await api(`/api/agent-nodes/${encodeURIComponent(target.dataset.nodeId)}/revoke`, {method: "POST", body: JSON.stringify({force: true})});
      await loadPage();
      toast.success("已立即作废该节点凭据");
      return;
    }
    if (action === "agent-control") {
      const command = target.dataset.command;
      if (command === "cancel_dispatch" && !(await confirmDialog({title: "取消派发", message: "确认取消该节点当前派发的任务？", danger: true, confirmText: "取消派发"}))) return;
      if (command === "shutdown" && !(await confirmDialog({title: "关停节点", message: "确认优雅关停该节点？", sub: "节点将进入 draining，完成或围栏当前派发后离线（区别于硬吊销）。", danger: true, confirmText: "关停"}))) return;
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
      // 原先漏了 danger:true —— 而 confirmDialog 的安全语义（回车不触发、焦点落在"取消"）只对 danger 生效。
      // 于是控制台里最不可逆的操作用的是"回车即确认"的弹窗，而"停用成员"这种可逆操作反而受保护。
      // 按钮逐行渲染、一屏可能八行，文案却不指名 —— 点错行时弹窗帮不了你，而关闭没有任何回退路径。
      if (!(await confirmDialog({
        title: "关闭任务组",
        message: `确认关闭任务组「${taskGroupNameOf(target.dataset.task)}」？`,
        sub: "关闭后进入终态 closed，系统没有任何重新打开的入口 —— 这一步不可撤销。",
        danger: true, confirmText: "关闭任务组"
      }))) return;
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

let realtimeReconnectAttempts = 0;

function connectRealtime() {
  if (!authToken || realtimeSocket) return;
  let socket;
  try {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    // 令牌走子协议头而不是查询串：查询串会被反向代理访问日志、浏览器历史等原样记下来，
    // 而浏览器的 WebSocket 又不允许设置 Authorization 头 —— 子协议是标准的替代位置。
    socket = new WebSocket(`${scheme}//${location.host}/api/realtime`, ["aimac.bearer", authToken]);
  } catch {
    return;
  }
  realtimeSocket = socket;
  socket.addEventListener("open", () => {
    realtimeReconnectAttempts = 0; // 连上了就把退避归零，否则一次抖动会让后续重连一直停在长间隔上
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
    // 固定 3 秒重连、没有退避也没有抖动：服务重启时每个开着的控制台都会同步、持续地猛击它，
    // 而 5 秒轮询兜底同时还在跑 —— 恰好在服务最脆弱的时候加载最重。
    // 指数退避 + 随机抖动，上限 30 秒；连上之后归零。
    realtimeReconnectAttempts = Math.min(realtimeReconnectAttempts + 1, 6);
    const backoffMs = Math.min(30000, 1000 * (2 ** realtimeReconnectAttempts));
    const jitterMs = Math.floor(Math.random() * Math.min(5000, backoffMs));
    realtimeReconnectTimer = setTimeout(() => { realtimeReconnectTimer = null; connectRealtime(); }, backoffMs + jitterMs);
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
