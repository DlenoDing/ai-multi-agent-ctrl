/*
 * 面向人的全中文管理后台（human-org-console/v1 §6）
 * 三视角：系统管理员 / 组织管理员 / 组织成员。
 * 所有内部枚举展示一律经过 i18n-zh.js 提供的 t() 渲染。
 */

const {I18N, t, explainCoded} = window.AIMAC_CONSOLE_I18N_UTILS;
const {
  PROJECT_PAGES,
  PROJECT_MENU_TAIL,
  SYSTEM_MENU,
  ORG_MENU,
  MENUS,
  PAGE_META,
  perspectiveOf,
  defaultPageFor,
  allowedMenuItemsFor,
  managementSectionOf,
  menuForCurrentSection,
  sectionLabel,
  menuItemHtml
} = window.AIMAC_CONSOLE_NAV;
const {
  TONE_GREEN,
  GRANT_ROLE_LABELS,
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
} = window.AIMAC_CONSOLE_LABELS;
const {
  noteServerClock,
  serverNow,
  clockSkewNote,
  localZoneLabel,
  fmtTime,
  fmtBytes,
  durationText
} = window.AIMAC_CONSOLE_TIME;
const {uuid, copyText, esc} = window.AIMAC_CONSOLE_DOM_UTILS;
const {progressBar, progressLine, quotaLine, panel: renderPanel, row} = window.AIMAC_CONSOLE_UI_PRIMITIVES;
const workspaces = window.AIMAC_WORKSPACES;
function panel(title, body, options) { return workspaces.allows(title) ? renderPanel(title, body, options) : ""; }
const {
  WORK_ITEM_OWNER_ROLE_CHOICES,
  DEFAULT_ORGANIZATION_ID,
  organizationOf,
  MEMBER_PERMISSION_OPTIONS,
  PERMISSION_LABELS,
  RESOURCE_TYPE_LABELS,
  LANGUAGE_OPTIONS,
  RULE_LIMITS,
  COLLECTION_LABELS
} = window.AIMAC_CONSOLE_UI_CONFIG;

const app = document.querySelector("#app");

/* ---------------- 会话与全局状态 ---------------- */

let authToken = sessionStorage.getItem("aimac.sessionToken") || "";
let currentAccount = JSON.parse(sessionStorage.getItem("aimac.account") || "null");
workspaces.setAccount(currentAccount?.accountId || "");
let page = sessionStorage.getItem("aimac.page") || "";
let currentProjectId = sessionStorage.getItem("aimac.projectId") || "";
let managementGroupId = "";
let selectedWork = null;
let taskReturnContext = null;
let taskRunDisclosure = {};
let restoredWorkspaceLocation = false;
let recoveringWorkspaceLocation = false;
let routeWriteMode = "replace";
let applyingBrowserRoute = false;
let browserRouteBusy = false;
let queuedBrowserRoute = null;
let workListGroupId = "";
let workListState = null;
let taskSearch = "";
let taskStatus = "";
let taskPageData = null;
let taskWorkDetail = null;
let taskPageCursor = "";
let taskCursorStack = [];
let taskPageLoading = false;
let taskRequestGeneration = 0;
let taskSearchTimer = null;
let ruleEditorDirtySnapshot = null;
let workEventHistoryMode = false;
let workEventCursor = 0;
let workEventCursorStack = [];

let state = emptyState();
let systemOverview = null;
let systemOverviewStatus = "unloaded"; // unloaded | loaded | failed
let organizations = [];
let selectedOrganizationId = "";
let orgAgentNodes = [];
let orgMembers = [];
let selectedOrgMemberId = "";
let selectedProjectMemberId = "";
let selectedAgentProfileId = "";
let projConfig = null;
// null 同时代表"还没取过""取失败了""没选项目"三件事，而界面把三者一律说成"配置接口加载失败" ——
// 人会去追一个并不存在的故障（实测：渲染一个全新项目的设置页，第一眼就是这句）。分成三态。
let projConfigStatus = "unloaded"; // unloaded | loaded | failed
// 配置接口的失败原因原先被 .catch(() => null) 整个吞掉，紧接着 lastError = "" 又把横幅清了 ——
// 于是设置页三块空态都写着「原因见页面顶部的横幅」，而那一屏顶上根本没有横幅（实测渲染确认）。
// 指人去看一个不存在的东西比不说更坏：原因留在这里，由空态自己说出来。
let projConfigError = "";
let projConfigVersion = null;
let instructionState = null;
let loginHint = null;

let lastError = "";
let lastErrorIsRequest = true;
let lastLoadedAt = null;
// 「上一次加载成功」要【按页】记。原先是一个全局值：在能加载的页上待过之后再切到一个加载失败的页，
// 横幅会说「下面显示的是 0 秒前的旧数据」—— 而这一页根本没有过数据，那句话把最该警惕的一刻
// 说成了「数据是新的」。真实运行态上读到的正是这句（人工指令页取数失败时）。
const pageLoadedAt = {};
let lastLoadErrorToast = "";
let loading = false;
let pageReadGeneration = 0;
let taskGroupReadGeneration = 0;
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
let directiveWorkItemId = "";
let directiveList = [];
let pendingConfirmCount = 0;

let agentViewMode = "table";

let execScope = {type: "", id: ""};
// 执行历史里按需展开的「规则」摘要缓存（dispatchId → /contract-summary 回执）；再点一次收起。
const dispatchRuleSummaries = {};
let execEvents = [];
// 事件流是客户端的滚动窗口（只留最近 300 条）。丢弃发生过之后，页脚再报"共 N 条"就等于说
// "总共只发生过这些"，而人正是在这张表上排查"那一步到底做了什么"。丢过就改口径。
let execEventsDropped = false;
let execCursor = 0;
let execTimer = null;
let execRevision = 0;
let execHistoryMode = false;
let execHistoryStart = 0;
let execHistoryStack = [];
let execHasMore = false;

/* ---------------- 视角与菜单 ---------------- */

// "现在轮到我做什么" —— 此前控制台没有任何地方回答这个问题：菜单是写死的、没有计数，
// 唯一的待办数字在项目概览里且不可点击、只统计当前项目；而等人拍板的东西被拆在两个页面上，
// 其中一个还叫"执行监控"，名字完全不暗示"这里有等你签字的东西"。
// 这里按当前项目视图统计，且只统计"确实需要这个人动手"的项 —— 没权限处置的不算进来，
// 否则计数会变成一个人永远清不掉的红点。若未来视图里出现跨项目数据，按钮会先切到对应项目。
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

// 心跳超过服务端判死阈值时，这一行上的「在线」就是假的：status 只有在扫描跑过之后才会翻成
// offline，而扫描挂在编排拍上 —— 拍不跑（自治关着、进程刚起、没人写），它可以一直写着"在线"。
// 真实运行态上读到过同一行里【在线 + 已 175 分钟没有心跳】并排。阈值取服务端下发的那一个，
// 不在这里另写一个数（那就成了第二个真相源，两边会各自漂）。
// 心跳有多旧只算一处：本机时钟快 20 分钟时所有健康节点都会被算成失联，所以按【服务器时钟】算。
// 两个使用点（提示文案、超时判定）共用它，别各写一份。
function heartbeatAgeMs(node) {
  return serverNow() - new Date(node.lastHeartbeatAt).getTime();
}

function heartbeatTimedOut(node) {
  const timeoutMs = Number(state.runtime?.nodeHeartbeatTimeoutMs || 0);
  if (!timeoutMs || !node.lastHeartbeatAt || ["revoked", "offline"].includes(node.status)) return false;
  const ageMs = heartbeatAgeMs(node);
  return Number.isFinite(ageMs) && ageMs >= timeoutMs;
}

function heartbeatStaleHint(node) {
  if (!node.lastHeartbeatAt || ["revoked", "offline"].includes(node.status)) return "";
  const ageMs = heartbeatAgeMs(node);
  if (!Number.isFinite(ageMs) || ageMs < 3 * 60 * 1000) return "";
  return `<div class="small warn-text">⚠ 已 ${durationText(ageMs)}没有心跳${heartbeatTimedOut(node)
    ? "（已超过判死阈值，服务端会在下一次编排拍时把它标成离线）" : ""}</div>`;
}

function pendingForMe() {
  const groups = (state.taskGroups || []);
  const groupIds = new Set(groups.map((taskGroup) => taskGroup.id));
  const projectByGroup = new Map(groups.map((taskGroup) => [taskGroup.id, taskGroup.projectId]));
  const inScope = (item) => item && groupIds.has(item.taskGroupId);
  const projectIdsForItems = (items) => [...new Set(items
    .map((item) => item.projectId || projectByGroup.get(item.taskGroupId))
    .filter(Boolean))];
  // 任务组级的权限按【每个任务组】判：只在 tg1 上有评审权的人，不该把 tg2 的待办算成自己的
  //（这块面板明写着「只统计你有权处置的」）。项目级的两个仍按项目判 —— 这一屏本来就只看一个项目。
  const canReviewGroup = (item) => hasGroupPerm(item?.taskGroupId, "task_group:review");
  const canControlGroup = (item) => hasGroupPerm(item?.taskGroupId, "task_group:control");
  const canGrant = hasPerm("project:grant");
  const canUpdateProject = hasPerm("project:update");
  const buckets = [];
  // 视角接口为了体积把每个集合截到上限。截断后的数组长度不是总数，而这块面板恰恰以"总数"的口径
  // 说话（"共 N 项等待你处理"）——数据一多，人处置完 N 项会以为清空了。被截断的桶改报"N+"。
  const truncated = new Set(state.truncatedCollections || []);
  // taskGroups 自己也会被截断，而它决定了 inScope —— 超出上限的任务组下的待办连桶都进不去，
  // 一条都不会被算到。所以它一旦被截，所有桶的数字都只是下限，而不只是某一类不准。
  const scopeTruncated = truncated.has("taskGroups");
  // allowed 可以是布尔（项目级权限，这一屏只看一个项目）或按条判断的函数（任务组级权限）。
  // 范围内存在、但当前账号无权处置的条数——按去向页累计。给"暂无"一个诚实的替代：范围内明明有待办、
  // 只是你没权限，屏幕不能说"没有"（缺省不得等于有利结果）。桶本身仍只列"我的"，现有消费者不受影响。
  const othersByPage = {};
  const add = (id, label, page, items, allowed, sourceField) => {
    const mine = typeof allowed === "function" ? items.filter(allowed) : (allowed ? items : []);
    othersByPage[page] = (othersByPage[page] || 0) + Math.max(0, items.length - mine.length);
    if (!mine.length) return;
    buckets.push({id, label, page, count: mine.length, capped: scopeTruncated || truncated.has(sourceField),
      items: mine.slice(0, 5), projectIds: projectIdsForItems(mine)});
  };
  add("confirmations", "待你定稿的核心决策", "review",
    (state.humanConfirmationRequests || []).filter((item) => inScope(item) && item.status === "pending"), canReviewGroup, "humanConfirmationRequests");
  add("permissions", "待你批准的授权请求", "review",
    (state.permissionRequests || []).filter((item) => inScope(item) && item.status === "pending_approval"), canGrant, "permissionRequests");
  add("approvals", "待你处理的审批请求", "review",
    (state.approvalRequests || []).filter((item) => inScope(item) && ["requested", "quorum_collecting"].includes(item.status)), canReviewGroup, "approvalRequests");
  add("findings", "待你处置的发现项", "review",
    (state.findings || []).filter((item) => inScope(item) && !["resolved", "closed", "dismissed", "wontfix"].includes(item.status)), canReviewGroup, "findings");
  add("qualityGates", "未通过、可由你豁免的质量门", "monitor",
    (state.qualityGates || []).filter((item) => inScope(item) && !["passed", "waived"].includes(item.status)), canReviewGroup, "qualityGates");
  add("reviewPlans", "待你收尾的评审计划", "monitor",
    (state.reviewPlans || []).filter((item) => inScope(item) && !["closed", "rejected", "superseded"].includes(item.status)), canReviewGroup, "reviewPlans");
  add("reviewBundles", "待你收尾的评审包", "monitor",
    (state.reviewBundles || []).filter((item) => inScope(item) && !["consumed", "rejected"].includes(item.status)), canReviewGroup, "reviewBundles");
  add("ruleSources", "待你判定的规则来源", "monitor",
    (state.ruleSourceResolutions || []).filter((item) => inScope(item) && !["reference_only", "quarantined", "rejected", "superseded", "active"].includes(item.status)), canControlGroup, "ruleSourceResolutions");
  add("upgradeCandidates", "待你判定的系统升级候选项", "monitor",
    (state.systemUpgradeCandidates || []).filter((item) => inScope(item) && item.status === "candidate_created"), canControlGroup, "systemUpgradeCandidates");
  // 这两类同样【只有人能了结】，而且都在关闭门的阻塞清单里 —— 之前却不在待办里：
  // 人看到"0 待处理"，任务组却因为等他终止一个卡住的方案、或确认一条指令已被消费而关不掉。
  // 状态集与 computeCloseBarrier 的判据对齐（拓扑终态 merged/downgraded/cancelled；
  // 指令 queued/acknowledged 才算未消费），不另立一套 —— 两套口径迟早分叉，而分叉那天没人会发现。
  add("topologies", "待你终止的卡住执行方案", "monitor",
    (state.executionTopologies || []).filter((item) => inScope(item)
      && ["blocked", "needs_reconcile"].includes(item.status)), canControlGroup, "executionTopologies");
  add("directives", "待你确认已被消费的人工指令", "directives",
    (state.humanDirectives || []).filter((item) => inScope(item)
      && ["queued", "acknowledged"].includes(item.status)), canControlGroup, "humanDirectives");
  const visibleProjectIds = new Set(groups.map((taskGroup) => taskGroup.projectId).filter(Boolean));
  add("sharedDefinitions", "待你处置的共享定义契约", "monitor",
    (state.sharedDefinitions || []).filter((item) => ["owner_assigned", "proposed", "reviewing", "change_requested", "conflicted"].includes(item.status)
      && (!item.projectId || visibleProjectIds.has(item.projectId))), canUpdateProject, "sharedDefinitions");
  // "看不到"不等于"没有"。这些待办的来源集合只在 tasks 视角下发；在组织/系统/运行时视角里它们
  // 根本不存在，而 `|| []` 会把"这一页没加载"渲染成 0 —— 人在概览看到"3"，点进成员管理变成没有，
  // 会读成"已经处理掉了"。显式区分：不知道就别报数。
  const known = Array.isArray(state.taskGroups);
  const partial = buckets.some((bucket) => bucket.capped);
  return {buckets, total: buckets.reduce((sum, bucket) => sum + bucket.count, 0), known, partial, othersByPage};
}

function bucketNeedsProjectJump(bucket) {
  const projectIds = bucket.projectIds || [];
  if (!projectIds.length) return false;
  return projectIds.length > 1 || (currentProjectId && projectIds[0] !== currentProjectId) || (!currentProjectId && projectIds[0]);
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
    roleSkillIndex: [],
    roleSkillCountBySource: {},
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

/* 权限门控：system_admin / org_admin 全权；user_account 看 permissions 列表 */
// 「这个任务组上我有没有这个权限」。effectivePermissions 是【跨资源的并集】（服务端注释里写明了
// 它只是 UI 提示），拿它判具体任务组会把别人负责的那些也算成自己的 —— 而后端每一次写入都按资源判。
// 服务端在 tasks 视图里按任务组算好了真实权限；拿不到那份映射时（别的视图）退回并集，
// 那时宁可多显示一个按钮，也不要把人自己的活藏起来。
function hasGroupPerm(taskGroupId, perm) {
  const groupDetail = tgDetail?.progress?.taskGroup;
  if (groupDetail?.projectId === currentProjectId && groupDetail.id === taskGroupId) {
    if (perm === "task_group:control") return groupDetail.canControl === true;
    if (perm === "task_group:review") return groupDetail.canReview === true;
  }
  const detail = taskWorkDetail?.taskGroup;
  if (detail?.projectId === currentProjectId && detail.id === taskGroupId) {
    if (perm === "task_group:control") return detail.canControl === true;
    if (perm === "task_group:review") return detail.canReview === true;
  }
  const map = state.taskGroupPermissions;
  // 服务端只列【与默认集不同】的那些组（系统账号在每组上都是全权限，逐组重复要 8.4KB）。
  // 拿不到整份映射时才退回并集；拿得到、但这一组没列出来 = 它就是默认集。
  if (!map || !taskGroupId) return hasPerm(perm);
  const granted = map[taskGroupId] || state.taskGroupPermissionsDefault;
  if (!granted) return hasPerm(perm);
  return granted.includes(perm) || granted.includes(`${String(perm).split(":")[0]}:*`);
}

function hasPerm(perm) {
  const account = currentAccount;
  if (!account) return false;
  if (account.accountType === "system_admin" || account.accountType === "org_admin") return true;
  const scoped = state.projectPermissions;
  if (PROJECT_PAGES.has(page) && scoped?.projectId === currentProjectId && Array.isArray(scoped.permissions)) {
    if (scoped.permissions.includes(perm)) return true;
    if (["task_group:read", "task_group:review", "task_group:control"].includes(perm)) {
      return [...(state.taskGroupPermissionsDefault || []), ...Object.values(state.taskGroupPermissions || {}).flat()].includes(perm);
    }
    if (perm.startsWith("project:") || perm.startsWith("task_group:") || perm === "agent:activate") return false;
  }
  // effectivePermissions is the backend-resolved union of direct + granted (incl. project-owner) permissions.
  const permissions = account.effectivePermissions || account.permissions || [];
  if (permissions.includes("system:*") || permissions.includes("org:*")) return true;
  if (permissions.includes(perm)) return true;
  // wildcard family match (e.g. project:* grants project:update)
  const family = `${String(perm).split(":")[0]}:*`;
  if (permissions.includes(family)) return true;
  return false;
}

function hasProjectPermission(perm) {
  return state.projectPermissions?.projectId === currentProjectId
    ? Array.isArray(state.projectPermissions.permissions) && state.projectPermissions.permissions.includes(perm) : hasPerm(perm);
}

function accountName(accountId) {
  if (!accountId) return "-";
  const pool = [...(state.accounts || []), ...orgMembers];
  const found = pool.find((account) => account.accountId === accountId || account.email === accountId);
  if (found) return found.displayName || found.email || accountId;
  // Fall back to the lightweight server-provided id->displayName directory (views like tasks don't
  // carry the full accounts collection), then to the raw id — never the t() dictionary (an account id
  // is never an i18n key, and t() would emit a console warning + the raw id anyway).
  if (state.accountDirectory && state.accountDirectory[accountId]) return state.accountDirectory[accountId];
  // 服务名 actor（auth-service / policy-engine / bootstrap…）不是账号，但词表里【有】它们的中文——
  // 这里原先一律回落成原始 id，于是审计表上印着 "auth-service" 而词表里的「认证服务」没人用。
  // 只在 id 不是账号形状且词表真有这个键时才走 t()，仍不给不认识的 id 找词表（那会触发漏译警告）。
  const dict = (typeof I18N !== "undefined" && I18N.dict) || {};
  if (!/^(acct_|mcp:)/u.test(String(accountId)) && Object.prototype.hasOwnProperty.call(dict, accountId)) return t(accountId);
  return accountId;
}

// 已归档的项目不该出现在「签发加入令牌」的目标里：后端已经拒（project_archived），
// 界面还摆着它就是把人往死路上引 —— 按着选一个，回来的是一句拒绝。
// 归档意味着"移出可建新工作的范围"，而接一个 agent 进来正是要开新工作。
// 人停下来的任务组只有真人能恢复（后端同规）。判据是停因，而不是"谁在看这一屏"——
// 机器主体也会渲染这一屏（agent 侧的只读视图），给它一个按不动的按钮不如直接说清楚。
function canResumeTaskGroup(taskGroup) {
  if (!String(taskGroup?.pauseReason || "").startsWith("human_directive")) return true;
  return ["system_admin", "org_admin", "user_account"].includes(currentAccount?.accountType);
}

// 已归档的项目不该出现在任何「把人或机器放进去开工」的选择器里：后端两条路都已拒
// （project_archived / member_default_project_archived）。两处用同一份口径 ——
// 上一轮只滤了加入令牌那个下拉，成员的「默认项目」照旧列着归档项目（同一件事两处只改一处）。
function assignableProjects() {
  return (state.projects || []).filter((project) => project.status !== "archived");
}

function joinTokenTargetProjects() {
  return assignableProjects();
}

// 加载失败时，列表为空【不等于】没有记录 —— 它可能压根没取回来。
// 顶部横幅说的是"整页加载失败"，而表格里那句"暂无数据"是在断言"确实一条都没有"。
// 两句话互相矛盾时，人信的是离数据最近的那一句 —— 于是"接口挂了"被读成"这个组织没有成员"。
function listEmptyText(what) {
  return lastError ? `${what}没能加载出来（原因见页面顶部的横幅）` : "暂无数据";
}

// 项目配置是【子请求】，它失败不会置 lastError，所以顶部横幅那条路走不通 ——
// 这句话必须自己带上原因和出路。三态要分开：没取过与取失败不是一回事。
function projConfigUnavailableText() {
  if (projConfigStatus !== "failed") return "配置还没取回来，这里显示不了已有的配置 —— 不是「还没有配置」。";
  return `配置没能加载出来（配置接口这一次没取到：${projConfigError || "原因未记下"}），`
    + "这里显示不了已有的配置 —— 不是「还没有配置」。点右上角的 ↻ 刷新再试一次。";
}

// 给"请求级失败"打个记号：连不上、超时、服务端回 4xx/5xx —— 这些是控制面那边的事。
// 没有这个记号的异常是【控制台自己抛的】（我们代码里的缺陷）。两者在屏幕上必须分开说：
// 一律写"连不上控制面"会把人支去查网络和服务端，而 bug 就在这一页里。
function requestFailure(error, status) {
  error.requestFailure = true;
  // 状态码也归在这里：调用点分不清「没权限」和「服务端没给出来」时，只能把两件事写成
  // 一句「读取失败或无权查看」—— 人看了不知道该去要权限还是该重试（任务组房间那块就是）。
  if (status !== undefined) error.status = status;
  return error;
}

function table(headers, bodyRows, options = {}) {
  const th = (headline) => (headline && typeof headline === "object" && "label" in headline)
    ? `<th class="${headline.c || ""}">${esc(headline.label)}</th>`
    : `<th>${esc(headline)}</th>`;
  // 35 张表里 30 张没给 emptyText，于是加载失败时它们照样断言"暂无数据" ——
  // 而顶部横幅同时在说"这一页没加载出来"。人信的是离数据最近的那一句。
  // 这种"每个使用点自己记得传"的机制在本仓已经失效过一次（23 张表只有 5 张接上）；
  // 这次把默认值本身改对：没传 emptyText 时也按【有没有加载失败】分开说。
  const emptyRow = `<tr><td class="empty-cell" colspan="${headers.length}">`
    + `${esc(options.emptyText || (lastError ? "这张表没能加载出来（原因见页面顶部的横幅）—— 不是「一条都没有」" : "暂无数据"))}</td></tr>`;
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

// 过滤把行全筛光时该对人说什么。抽成纯函数是为了让判据验得到 ——
// 行是 innerHTML 渲染出来的，DOM 桩里没有真实行树，隐藏那半只能靠源码看接线。
function filteredEmptyText(query, hiddenCount) {
  if (!query) return "";
  return `没有匹配「${query}」的行${hiddenCount > 0 ? `（${hiddenCount} 行被过滤条件隐藏）` : ""}`;
}

// 按输入框内容隐藏不匹配的行/卡片；供输入时与每次 render 后回填复用
function applyFilterFor(inputEl) {
  if (!inputEl) return;
  const scope = inputEl.closest(".panel") || document;
  const raw = String(inputEl.value || "").trim();
  const query = raw.toLowerCase();
  scope.querySelectorAll(".data-table tbody tr, .agent-cards .agent-card").forEach((rowEl) => {
    if (rowEl.querySelector(".empty-cell")) return;
    rowEl.style.display = !query || rowEl.textContent.toLowerCase().includes(query) ? "" : "none";
  });
  // 全被筛光时必须说出来，否则人分不清"过滤没匹配"和"页面坏了"：
  //   走 DOM 隐藏这条路 —— 看到的是一张只有表头、body 一个字都没有的表；
  //   走 filterSource 那条路（源数组先筛） —— 看到的是"暂无数据"，会以为系统里压根没这类记录。
  // 两条路径在这里收口。原来的空行不改文案、只藏起来，过滤词一清就能原样回来。
  scope.querySelectorAll(".data-table tbody").forEach((tbody) => {
    const injected = tbody.querySelector("tr[data-filter-empty]");
    if (injected) injected.remove();
    const rows = [...tbody.querySelectorAll("tr")];
    const emptyRow = rows.find((rowEl) => rowEl.querySelector(".empty-cell"));
    const hidden = rows.filter((rowEl) => rowEl !== emptyRow && rowEl.style.display === "none");
    const visible = rows.filter((rowEl) => rowEl !== emptyRow && rowEl.style.display !== "none");
    if (!query || visible.length) {
      if (emptyRow) emptyRow.style.display = "";
      return;
    }
    if (emptyRow) emptyRow.style.display = "none";
    const columns = tbody.closest("table")?.querySelectorAll("thead th").length || 1;
    const row = document.createElement("tr");
    row.setAttribute("data-filter-empty", "1");
    row.innerHTML = `<td class="empty-cell" colspan="${columns}"></td>`;
    row.querySelector(".empty-cell").textContent = filteredEmptyText(raw, hidden.length);
    tbody.appendChild(row);
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
    if (modalHtml || formTouched || window.AIMAC_RULE_EDITOR?.isOpen?.()) return;
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

// 出错那一刻对人说的话，全部在这里拼。原先它埋在 api() 的 fetch 分支里 ——
// 那是【网络失败时才走到】的一段，断言够不着，于是这九十行报文谁也没验过：
// 实测配额拒绝会多打一句"故障类型：agents"（词表里没这个键，屏幕上是英文码，说的还是错的）。
// 抽成纯函数：进去一个服务端载荷，出来一句给人看的话，门可以直接拿真载荷调它。
// 越界这件事对人只有一个问题："到底是哪几条路"。服务端每一种都算好了（deniedPaths /
// outsidePaths / trespassedPaths / forbiddenPaths / changedPaths / approvedPaths），
// 而此前只有第一种被读 —— 那道「下发的字段有没有人接」的判据只扫 server.mjs，
// 这一族是 core 在拒绝里算的，整族不在它视野里（跑完整变异门时一条变异假绿才发现）。
function pathList(paths, label) {
  if (!Array.isArray(paths) || !paths.length) return "";
  return `${label}：${paths.slice(0, 8).join("、")}`
    + `${paths.length > 8 ? `（共 ${paths.length} 条，此处显示前 8 条）` : ""}`;
}

function requestFailureHint(payload) {
  let hint = "";
  // 服务端在 403 里已经写明了缺哪个权限、作用在哪个资源上，前端原先只取 error 字段丢掉其余，
  // 于是人只看到"权限不足"，看不出该去要什么权限、找谁要 —— 报错指不到真正的原因。
  if (payload.requiredPermission) {
    const scope = payload.resourceScope ? `${payload.resourceScope.resourceType || "?"}:${payload.resourceScope.resourceId || "?"}` : "";
    hint = `（需要 ${payload.requiredPermission}${scope ? ` @ ${scope}` : ""}${String(payload.requiredPermission).startsWith("task_group:") ? "；这类权限只能在「项目管理」→「成员权限」→「项目成员授权」里按角色授予，写在账号上的直接权限不生效" : ""}）`;
  }
  if (Array.isArray(payload.permissions) && payload.permissions.length) hint += `（涉及：${payload.permissions.join("、")}）`;
  // 核心决策闸门上最容易并发的一步：两个人同时打开同一张确认单各自点定稿。CAS 只让一个写成，
  // 输的那一方原先只看到"该确认单已不在待处理状态"，不知道是谁、定了什么，只能自己去翻记录。
  // 本函数产出的是【纯文本】提示，最终嵌进 Error.message，而 message 的两个显示口
  //（toast 的 esc(message)、顶部横幅的 esc(lastError)）都会整体转义一次。所以这里【不要】再 esc：
  // 再 esc 就是双重转义，含 < & " 的自由文本（如 decidedOption、账号名）会显示成 &lt; 字面乱码。
  // 本函数其余十几处字段（permissions/required/supported/received…）本来就没 esc，这里对齐它们。
  if (payload.decidedBy || payload.decidedAction) {
    const who = payload.decidedBy ? accountName(payload.decidedBy) : "另一个人";
    const what = payload.decidedAction === "finalize" ? "定稿" : payload.decidedAction === "reject" ? "打回返工" : payload.decidedAction === "revise" ? "提交了修改意见" : "处理";
    hint += `（${who} 已在 ${fmtTime(payload.decidedAt)} ${what}${payload.decidedOption ? `：${payload.decidedOption}` : ""}；刷新即可看到结果，重复提交不会生效）`;
  } else if (payload.currentRound !== undefined) {
    hint += `（当前轮次已是第 ${payload.currentRound} 轮，你看到的是更早的一轮 —— AI 在你点击前修订过候选方案，请刷新后重新查看再决定）`;
  }
  // 配额超限时服务端已经算出了【哪一类、用了多少、上限多少】，前端原先只取 error ——
  // 人看到"组织配额已超限"，不知道是成员、项目、任务组还是智能体，也不知道差多少，
  // 更不知道下一步该去哪。这三样都在手上，不给出来没有任何理由。
  if (payload.quota !== undefined && payload.usage !== undefined) {
    const kindLabel = {members: "成员", projects: "项目", taskGroups: "任务组", agents: "智能体"}[payload.kind] || "该资源";
    // 智能体这一类的"腾出来"和别的不一样：用量数的是【没被吊销的节点】，
    // 关停（draining）、停用档案都不减，未使用的加入令牌还要先占一格。
    // 写成笼统的"关掉不再需要的"，人会去关停节点然后发现数字纹丝不动。
    const freeUp = payload.kind === "agents"
      ? "或吊销一台不再用的节点（关停、停用档案都不减用量；未签发出去用掉的加入令牌也占着额度）"
      : "或先关掉/归档不再需要的";
    // 智能体这一格的"已用"是节点 + 未使用的加入令牌。不拆开的话，只有 2 台节点的人
    // 看到"3/3 已满"会以为系统数错了 —— 页面上那格现在也按同一口径显示。
    const breakdown = payload.outstandingJoinTokens
      ? `（其中 ${payload.nodes} 台节点 + ${payload.outstandingJoinTokens} 张未使用的加入令牌）` : "";
    hint += `（${kindLabel} ${payload.usage}/${payload.quota} 已满${breakdown}：到「组织管理」页调高这一项配额，`
      + `${freeUp}，再重试）`;
    if (payload.projectedUsage !== undefined) hint += `（本次操作完成后预计用量：${payload.projectedUsage}/${payload.quota}）`;
  }
  // 服务端在不少错误里写了给人看的说明（message / reason / required），前端原先只取 error 一个字段，
  // 把它们全丢了 —— 于是一条本来说清了"为什么、接下来怎么办"的 409，到人眼前只剩一串英文枚举。
  // 典型：停用一个还没接受邀请的成员 → 服务端解释了原因，人看到的是 `409 org_member_invitation_pending`。
  // supported 与 required 是同一件事的两面：服务端已经把【合法清单】算出来了，
  // 不给出来的话，人看到的就是"认不出的 X"然后自己猜（12 处拒绝里都带着它，前端一处都没读）。
  const guidance = [
    payload.message,
    payload.reason,
    Array.isArray(payload.required) ? payload.required.join("；") : payload.required,
    Array.isArray(payload.supported) && payload.supported.length
      ? `可用的取值：${payload.supported.join("、")}` : "",
    // 服务端算出了"多久之后能再试"，词表里却只写着"请稍后再试" —— 人只能反复试。
    payload.retryAfterSeconds ? `${payload.retryAfterSeconds} 秒后可再试` : "",
    // 已经关掉的东西：谁关的、什么时候关的，都在同一个响应里。不给的话人得自己去翻台账。
    payload.closedBy ? `已由 ${payload.closedBy} 关闭${payload.closedAt ? `（${payload.closedAt}）` : ""}` : "",
    // hint 是服务端写的"下一步怎么办"；received 是"你实际发上来的是什么"（参数写错时最省事的一句）；
    // openTaskGroupIds 是"还有哪几个挡着"。三样都在同一个响应里，不给出来人只能自己猜。
    payload.hint,
    payload.received ? `收到的是：${payload.received}` : "",
    Array.isArray(payload.openTaskGroupIds) && payload.openTaskGroupIds.length
      ? `还没关掉的任务组：${payload.openTaskGroupIds.join("、")}` : "",
    payload.minLength ? `至少需要 ${payload.minLength} 位` : "",
    // 「这是人停下来的」那条拒绝带着停因：不显示的话，人只知道自己点不动，
    // 不知道是谁、因为什么把它停下来的 —— 而那正是他下一步要去问的人。
    payload.pauseReason ? `停因：${t(payload.pauseReason)}` : "",
    // "现在是什么状态、只能转到哪几个"是一对：只给其中一个，人还是不知道能做什么。
    payload.currentStatus ? `当前状态：${payload.currentStatus}` : "",
    Array.isArray(payload.allowedStatuses) && payload.allowedStatuses.length
      ? `可以转到：${payload.allowedStatuses.join("、")}` : "",
    // 踩了禁区时，到底是哪几条路径 —— 不说的话人得自己拿 diff 去比对。
    // deniedPaths 的【同族兄弟】此前一个都没读：那道「下发的字段有没有人接」的判据只扫
    // server.mjs，而这些字段是 core 在拒绝里算出来的，整族不在它视野里（跑完整变异门才发现）。
    // 越界这件事对人只有一个问题："到底是哪几条路"，而服务端每一种都已经算好了。
    // 逐个写成 payload.X 而不是 payload[field]：那道判据要确认字段【真的从回执里取出来了】，
    // 动态取它认不出来（而认不出来就等于这几族又回到"没人读"的状态）。
    pathList(payload.deniedPaths, "踩到禁区的路径"),
    pathList(payload.unknownRoles, "不在词表里的账号角色"),
    pathList(payload.unknownOwnerRoles, "未登记的执行角色"),
    Array.isArray(payload.invalid) && payload.invalid.length
      ? `填错的项：${payload.invalid.map((item) => `${item.key}=${JSON.stringify(item.received)}`).join("、")}` : "",
    payload.limits && payload.limits.min !== undefined ? `允许范围：${payload.limits.min} 到 ${payload.limits.max}` : "",
    pathList(payload.unknownPermissions, "不在词表里的权限"),
    pathList(payload.unknownKeys, "认不出的键"),
    pathList(payload.outsidePaths, "落在允许范围之外的路径"),
    // 这两对说的都是【人批准的那份方案】怎么划的界，不是泛指的边界 —— 措辞照它的来源写：
    // approvedPaths 是方案里各分支的 ownedPaths，forbiddenPaths 是方案里明写的禁区。
    pathList(payload.trespassedPaths, "踩进了方案禁区的路径"),
    pathList(payload.forbiddenPaths, "人批准的方案里划为禁区的路径"),
    pathList(payload.changedPaths, "这次实际改动的路径"),
    pathList(payload.approvedPaths, "人批准的方案允许改的路径"),
    // 锁被别人占着时，"被谁占着"决定了下一步是去找他还是等它过期。
    payload.holderRef ? `当前持有者：${payload.holderRef}` : "",
    payload.activeLeaseRef ? `还生效的租约：${payload.activeLeaseRef}` : "",
    payload.maxBytes ? `上限 ${payload.maxBytes} 字节` : "",
    payload.mismatchedField ? `对不上的字段：${payload.mismatchedField}` : "",
    // 授权被拒时：作用域类型与角色决定了他该改哪一项再提交。
    payload.resourceType ? `作用域类型：${explainCoded(payload.resourceType)}` : "",
    payload.role ? `角色：${grantRoleLabel(payload.role)}` : "",
    payload.taskGroupStatus ? `任务组当前状态：${t(payload.taskGroupStatus)}` : "",
    payload.assessment ? `评估结论：${explainCoded(payload.assessment)}` : "",
    payload.dispositionClass ? `处置类别：${explainCoded(payload.dispositionClass)}` : "",
    // expected / actual 是一对：只说"应该是 X"而不说"实际是什么"，人还是不知道差在哪。
    // （前端原先一个都没读；同名的 expectedConfigVersion 是另一回事，别混。）
    payload.expected !== undefined && payload.actual !== undefined
      ? `应为 ${payload.expected}，实际 ${payload.actual}` : "",
    payload.commit ? `涉及的提交：${payload.commit}` : "",
    payload.directiveType ? `你发的指令类型：${payload.directiveType}` : "",
    payload.roleSkillRef ? `指定的角色 Skill：${payload.roleSkillRef}` : "",
    // 定稿冲突时，这张卡管的是哪件事 —— 同一个人手上常同时挂着好几张，不说清就得逐张点开找。
    payload.subjectRef ? `这张卡管的是：${payload.subjectRef}` : "",
    // 状态损坏时的 file/kind：中文文案里明写着"报文里的 file 指出是哪一份"，
    // 而前端原先根本不显示它 —— 那句话把人指向一个他看不到的东西（实测造了一次真损坏才发现）。
    // 产出目标被拒时，服务端会说清是【配置不合法】还是【这条路径 git 跟不住】，并带上真实取值。
    // 不转达的话，人看到的仍然只是"必须用 git 跟得住的路径"，不知道是哪一条不行。
    payload.cause === "path_allowlist_invalid" ? "原因：允许路径清单本身不合法（这是配置问题，不是你填的那条路径）" : "",
    payload.cause === "manifest_path_not_git_trackable" ? "原因：产出清单那条路径 git 跟不住" : "",
    payload.path ? `涉及的路径：${payload.path}` : "",
    // 分支名/remote 名被拒时，把人填的那个值原样回显 —— 这两个字段常是复制粘贴带进来的
    // （前后多个字符、藏了个 --option），不回显的话人盯着自己那份"看起来没错"的输入找不出问题。
    payload.branch ? `你填的分支名：${payload.branch}` : "",
    payload.remote ? `你填的 remote 名：${payload.remote}` : "",
    Array.isArray(payload.allowedPaths) && payload.allowedPaths.length
      ? `当前允许的路径：${payload.allowedPaths.join("、")}` : "",
    payload.file ? `涉及的文件：${payload.file}` : "",
    // kind 是个英文蛇形码。人看到它的时刻正是"控制面状态损坏"那一刻 ——
    // 原样打出来等于在最要紧的时候甩给人一个标识符。走词表；词表没有就退回原码，
    // 但那种情况由判据在提交前就拦下（每一种 kind 都必须有中文）。
    // 只在【存储故障】那一族里 kind 才是"故障类型"。配额拒绝里的 kind 是"哪一类配额"
    // （agents/members/…），上面那段已经按配额语义说过了 —— 不排掉的话这里会再打一句
    // "故障类型：agents"：词表里没有这个键，屏幕上就是一个英文标识符，而且说的还是错的。
    payload.kind && payload.quota === undefined ? `故障类型：${t(payload.kind)}` : "",
    payload.code && typeof payload.code === "string" ? `系统错误码：${payload.code}` : "",
    // 版本不匹配那条报文让运维"重新执行入网安装命令升级"——那就得说清差在哪一版。
    // 原先这两个字段登记成"装机脚本会读"，实测装机脚本与 agent 运行时都没读过（谁都没读）。
    payload.requiredRuntimeVersion
      ? `需要的运行时版本：${payload.requiredRuntimeVersion}（该节点当前 ${payload.nodeRuntimeVersion || "未知"}）` : "",
    // 代次对不上时，"你带的是哪一代、当前是哪一代"要一起给，否则人不知道自己落后了多少。
    payload.presented !== undefined && payload.claimEpoch !== undefined
      ? `你带的认领代次 ${payload.presented}，当前是 ${payload.claimEpoch}` : ""
  ].map((item) => String(item || "").trim()).filter(Boolean);
  if (guidance.length) hint += `：${[...new Set(guidance)].join("；")}`;
  return hint;
}

async function api(path, options = {}) {
  const requestToken = authToken;
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
    if (method === "GET") throw requestFailure(new Error(`加载失败：没有收到服务端响应（${String(path).split("?")[0]}：`
      + `${String(networkError?.message || networkError).slice(0, 120)}）`));
    throw requestFailure(new Error("这次操作没有收到服务端的回应（网络中断或服务未响应）。"
      + "它可能已经生效，也可能没有 —— 请先刷新页面确认结果，不要直接重试："
      + `重试会以新的幂等键再做一次。（${String(networkError?.message || networkError).slice(0, 120)}）`));
  }
  noteServerClock(response);
  if (!response.ok) {
    let detail = "";
    let hint = "";
    try {
      const payload = await response.json();
      detail = payload.error || "";
      hint = requestFailureHint(payload);
    } catch {}
    if (response.status === 401 && authToken && authToken === requestToken) {
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
    // 带上是【哪一次请求】失败的：一屏常常并发取两三个接口，只报 "500 server_error" 时
    // 人不知道该查哪个（组织数据没问题、是智能体列表挂了，这两种情况在屏幕上长得一样）。
    // 只给路径，不给查询串 —— 查询串里可能有项目 id 之类，横幅上不必要。
    const requestPath = String(path).split("?")[0];
    // 状态码要随错误一起带出去：调用点分不清「没权限」和「服务端没给出来」时，
    // 只能把两件事写成一句「读取失败或无权查看」—— 人看了不知道该去要权限还是该重试。
    throw requestFailure(new Error(`${response.status} ${detail ? explainCoded(detail) : response.statusText}${hint}（${requestPath}）`), response.status);
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
  const currentRead = pageReadCheckpoint();
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
  if (!currentRead()) throw new Error("页面读取已过期");
  noteServerClock(response);
  if (response.status === 304 && cached) return cached;
  if (!response.ok) {
    // 走回统一的错误处理（401 清会话、把服务端写的说明带给人）
    const result = await api(path);
    if (!currentRead()) throw new Error("页面读取已过期");
    return {...emptyState(), ...result};
  }
  const payload = {...emptyState(), ...(await response.json())};
  if (!currentRead()) throw new Error("页面读取已过期");
  const nextEtag = response.headers.get("etag");
  if (nextEtag) { stateEtags.set(cacheKey, nextEtag); stateCache.set(cacheKey, payload); }
  else { stateEtags.delete(cacheKey); stateCache.delete(cacheKey); }
  return payload;
}

function saveSession(sessionToken, account) {
  resetTaskWorkbench();
  authToken = sessionToken;
  currentAccount = account;
  workspaces.setAccount(account?.accountId || "");
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
  window.AIMAC_WORKSPACE_LOCATION?.clear();
  resetTaskWorkbench();
  authToken = "";
  currentAccount = null;
  workspaces.setAccount("");
  modalProtected = false;
  document.body.classList.remove("modal-open");
  state = emptyState();
  systemOverview = null;
  systemOverviewStatus = "unloaded";
  organizations = [];
  selectedOrganizationId = "";
  orgAgentNodes = [];
  orgMembers = [];
  selectedOrgMemberId = "";
  selectedProjectMemberId = "";
  selectedAgentProfileId = "";
  projConfig = null;
  projConfigStatus = "unloaded";
  instructionState = null;
  modalHtml = "";
  expandedTaskGroupId = "";
  tgDetail = null;
  reviewRequests = [];
  directiveWorkItemId = "";
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
  lastErrorIsRequest = error?.requestFailure === true;
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

// 配额输入框清空后 Number("") 是 0：建组织时服务端把 0 钳成 1（一个只装得下一个人的组织，没有任何提示），
// 改配额时被告知「你填了 0」（明明是留空）。留空＝这一项不改/用缺省，就不要把它发出去。
function quotaField(value) {
  return String(value ?? "").trim() === "" ? undefined : Number(value);
}
function quotaBody(data) {
  return {maxMembers: quotaField(data.maxMembers), maxProjects: quotaField(data.maxProjects), maxTaskGroups: quotaField(data.maxTaskGroups), maxAgents: quotaField(data.maxAgents)};
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
    // 焦点只是便利：找不到按钮（比如渲染被裁掉）也不能让整个确认流程带着异常死掉 —— 那会让人按了「终止」却得到一句 TypeError。
    mask.querySelector(danger ? '[data-confirm="cancel"]' : '[data-confirm="ok"]')?.focus();
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
  "agent-profile-update": "已保存 Agent 档案",
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
  "topology-downgrade": "已降级为串行执行：该方案进入终态，关闭门禁将在下一次重算时不再被它阻塞",
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
  const groups = (state.taskGroups || []).filter((taskGroup) => !currentProjectId || taskGroup.projectId === currentProjectId);
  const detail = tgDetail?.progress?.taskGroup;
  if (detail?.projectId === currentProjectId && !groups.some((group) => group.id === detail.id)) groups.push(detail);
  return groups;
}

/* ---------------- 页面数据加载 ---------------- */

function pageReadCheckpoint() {
  const generation = pageReadGeneration;
  const token = authToken;
  return () => generation === pageReadGeneration && token === authToken;
}

function mergeScopedRecords(existing, incoming, idKey) {
  const incomingIds = new Set((incoming || []).map((item) => item?.[idKey]).filter(Boolean));
  return [...(incoming || []), ...(existing || []).filter((item) => !incomingIds.has(item?.[idKey]))];
}

async function ensureManagementGroupContext(currentRead) {
  if (!managementGroupId || projectTaskGroups().some((group) => group.id === managementGroupId)) return true;
  const requestedGroupId = managementGroupId;
  let detail;
  try {
    detail = await api(`/api/task-groups/${encodeURIComponent(requestedGroupId)}?workItemLimit=200`);
  } catch (error) {
    if ([403, 404].includes(error.status)) return false;
    throw error;
  }
  if (!currentRead() || requestedGroupId !== managementGroupId) return false;
  if (!detail.taskGroup || detail.taskGroup.projectId !== currentProjectId) return false;
  state = {
    ...state,
    taskGroups: mergeScopedRecords(state.taskGroups, [detail.taskGroup], "id"),
    workSessions: mergeScopedRecords(state.workSessions, detail.workSessions, "sessionId"),
    agentDispatches: mergeScopedRecords(state.agentDispatches, detail.agentDispatches, "dispatchId"),
    repositoryOutputs: mergeScopedRecords(state.repositoryOutputs, detail.repositoryOutputs, "targetId"),
    closeBarriers: detail.latestCloseBarrier
      ? mergeScopedRecords(state.closeBarriers, [detail.latestCloseBarrier], "taskGroupId") : state.closeBarriers,
    completionReadiness: detail.latestReadiness
      ? mergeScopedRecords(state.completionReadiness, [detail.latestReadiness], "taskGroupId") : state.completionReadiness
  };
  return true;
}

async function loadPage() {
  pageReadGeneration += 1;
  const currentRead = pageReadCheckpoint();
  dirtyFormKinds.clear(); // a full page (re)load rebuilds the DOM, discarding any in-progress form edits
  if (!authToken) {
    render();
    return;
  }
  loading = true;
  try {
    if (page === "sys-overview") {
      // "还没取过"与"取失败了"此前共用同一个 null，那一块一律显示"正在加载系统概览…" ——
      // 加载已经失败、横幅就在上面写着原因，这一块却还在转圈，人会一直等一件不会发生的事。
      // （同一个形状在项目规则配置那里修过一次，这是第二处 —— 一个 null 兼表两种意思。）
      // 顺带：原先 Promise.all 一失败，state 也一起丢了；现在概览取不到时其余数据照样呈现。
      let overviewFailure = null;
      const [overviewResult, systemState] = await Promise.all([
        api("/api/system/overview").catch((error) => { overviewFailure = error; return null; }),
        fetchState("system")
      ]);
      if (!currentRead()) return;
      systemOverview = overviewResult;
      systemOverviewStatus = overviewResult ? "loaded" : "failed";
      state = systemState;
      if (overviewFailure) throw overviewFailure;
    } else if (page === "sys-orgs") {
      const [orgsResult, systemState] = await Promise.all([api("/api/orgs"), fetchState("system")]);
      if (!currentRead()) return;
      organizations = orgsResult.organizations || [];
      state = systemState;
    } else if (page === "sys-settings") {
      const [runtimeState, nextInstructions] = await Promise.all([fetchState("runtime"), fetchState("instructions")]);
      if (!currentRead()) return;
      state = runtimeState;
      instructionState = nextInstructions;
    } else if (page === "sys-accounts") {
      const nextState = await fetchState("users");
      if (!currentRead()) return;
      state = nextState;
    } else if (page === "org-overview") {
      const [fullState, agentsResult] = await Promise.all([fetchState("orgs"), api("/api/org/agents")]);
      if (!currentRead()) return;
      state = fullState;
      orgAgentNodes = agentsResult.agentRuntimeNodes || [];
    } else if (page === "org-members") {
      const [membersResult, projectState] = await Promise.all([api("/api/org/members"), fetchState("projects")]);
      if (!currentRead()) return;
      orgMembers = membersResult.members || [];
      state = projectState;
    } else if (page === "org-agents") {
      const [agentsResult, projectState, skillRegistry] = await Promise.all([
        api("/api/org/agents"),
        fetchState("projects"),
        api("/api/skill-registry").catch(() => ({roleSkillIndex: [], roleSkillOverlays: []}))
      ]);
      if (!currentRead()) return;
      orgAgentNodes = agentsResult.agentRuntimeNodes || [];
      state = {
        ...projectState,
        roleSkillIndex: skillRegistry.roleSkillIndex || [],
        roleSkillOverlays: skillRegistry.roleSkillOverlays || []
      };
    } else if (page === "org-projects") {
      const [projectState, membersResult] = await Promise.all([fetchState("projects"), api("/api/org/members")]);
      if (!currentRead()) return;
      state = projectState;
      orgMembers = membersResult.members || [];
    } else if (page === "proj-overview") {
      const nextState = await fetchState("tasks", {projectId: currentProjectId});
      if (!currentRead()) return;
      state = nextState;
      ensureProjectSelection();
      loadPendingConfirmCount();
    } else if (page === "proj-members") {
      const shouldLoadGrantDirectory = hasPerm("project:grant");
      const [tasksState, projectState, membersResult] = await Promise.all([
        fetchState("tasks", {projectId: currentProjectId}),
        fetchState("projects", {projectId: currentProjectId}),
        shouldLoadGrantDirectory ? api("/api/org/members").catch(() => ({members: []})) : Promise.resolve({members: []})
      ]);
      if (!currentRead()) return;
      state = {
        ...tasksState,
        accessGrants: projectState.accessGrants || [],
        accounts: projectState.accounts || []
      };
      orgMembers = membersResult.members || [];
      ensureProjectSelection();
    } else if (page === "tg" || page === "tasks") {
      // 建工作项表单里的「指定模型」下拉要读 modelCapabilities，而 tasks 视图不含它。
      // 用轻量的 /api/model-registry（只回模型清单，不是整份 runtime 视图）并回补 —— 取不到就只显示「自动」，不挡建工作项。
      const [tasksState, modelRegistry, skillRegistry] = await Promise.all([
        fetchState("tasks", {projectId: currentProjectId}),
        api("/api/model-registry").catch(() => ({modelCapabilities: []})),
        api("/api/skill-registry").catch(() => ({roleSkillIndex: [], roleSkillOverlays: []}))
      ]);
      if (!currentRead()) return;
      state = {
        ...tasksState,
        modelCapabilities: modelRegistry.modelCapabilities || [],
        roleSkillIndex: skillRegistry.roleSkillIndex || [],
        roleSkillOverlays: skillRegistry.roleSkillOverlays || []
      };
      ensureProjectSelection();
      if (page === "tasks" && workspaces.current("tasks")?.id !== "create") await loadTaskWorkbenchData();
      else if (expandedTaskGroupId) await loadTaskGroupDetail(expandedTaskGroupId);
    } else if (page === "review") {
      const nextState = await fetchState("tasks", {projectId: currentProjectId});
      if (!currentRead()) return;
      state = nextState;
      ensureProjectSelection();
      await ensureManagementGroupContext(currentRead);
      await loadReviewData();
    } else if (page === "directives") {
      const nextState = await fetchState("tasks", {projectId: currentProjectId});
      if (!currentRead()) return;
      state = nextState;
      ensureProjectSelection();
      await ensureManagementGroupContext(currentRead);
      await loadDirectiveData();
    } else if (page === "monitor") {
      const [tasksState, runtimeState] = await Promise.all([
        fetchState("tasks", {projectId: currentProjectId}),
        fetchState("runtime", {projectId: currentProjectId})
      ]);
      if (!currentRead()) return;
      state = {
        ...tasksState,
        modelSelectionDecisions: runtimeState.modelSelectionDecisions || [],
        sessionPlacementDecisions: runtimeState.sessionPlacementDecisions || [],
        admissionDecisions: runtimeState.admissionDecisions || [],
        workerLanes: runtimeState.workerLanes || [],
        skillSources: runtimeState.skillSources || [],
        // 服务端只下发【按来源分组的计数】：界面从不读技能正文，而整份 roleSkills 是状态里
        // 最大的一块（真实部署 281 条 293KB），整份传过来既浪费、又会被视图上限截断，
        // 让屏幕上那个"技能数"本身就是错的。
        roleSkillCountBySource: runtimeState.roleSkillCountBySource || {},
        agentJoinTokens: runtimeState.agentJoinTokens || []
      };
      ensureProjectSelection();
      await ensureManagementGroupContext(currentRead);
      ensureExecScope();
    } else if (page === "proj-agents") {
      const [tasksState, runtimeState, skillRegistry] = await Promise.all([
        fetchState("tasks", {projectId: currentProjectId}),
        fetchState("runtime", {projectId: currentProjectId}),
        api("/api/skill-registry").catch(() => ({roleSkillIndex: [], roleSkillOverlays: []}))
      ]);
      if (!currentRead()) return;
      state = {
        ...tasksState,
        agentRuntimeNodes: runtimeState.agentRuntimeNodes || [],
        agentJoinTokens: runtimeState.agentJoinTokens || [],
        agentDispatches: runtimeState.agentDispatches || [],
        roleSkillIndex: skillRegistry.roleSkillIndex || [],
        roleSkillOverlays: skillRegistry.roleSkillOverlays || []
      };
      ensureProjectSelection();
    } else if (page === "proj-settings") {
      const [tasksState, skillRegistry] = await Promise.all([
        fetchState("tasks", {projectId: currentProjectId}),
        api("/api/skill-registry").catch(() => ({roleSkillIndex: [], roleSkillOverlays: []}))
      ]);
      if (!currentRead()) return;
      state = {
        ...tasksState,
        roleSkillIndex: skillRegistry.roleSkillIndex || [],
        roleSkillOverlays: skillRegistry.roleSkillOverlays || []
      };
      ensureProjectSelection();
      if (currentProjectId) {
        projConfigStatus = "unloaded";
        projConfigError = "";
        const configResult = await api(`/api/projects/${encodeURIComponent(currentProjectId)}/config`)
          .catch((error) => { if (currentRead()) projConfigError = String(error?.message || error); return null; });
        if (!currentRead()) return;
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
    if (!currentRead()) return;
    ensureProjectSelection();
    reconcileRoutedObjectSelection();
    lastError = "";
    lastLoadErrorToast = "";
    lastLoadedAt = Date.now();
    pageLoadedAt[page] = lastLoadedAt;
  } catch (error) {
    if (!currentRead()) return;
    if (restoredWorkspaceLocation && !recoveringWorkspaceLocation && PROJECT_PAGES.has(page) && [403, 404].includes(error.status)) {
      restoredWorkspaceLocation = false;
      recoveringWorkspaceLocation = true;
      window.AIMAC_WORKSPACE_LOCATION?.clear();
      resetTaskWorkbench();
      expandedTaskGroupId = "";
      tgDetail = null;
      currentProjectId = "";
      page = "proj-overview";
      sessionStorage.setItem("aimac.page", page);
      sessionStorage.removeItem("aimac.projectId");
      try {
        const fallbackState = await fetchState("projects");
        if (!currentRead()) return;
        state = fallbackState;
        ensureProjectSelection();
        lastError = "";
        if (currentProjectId) {
          recoveringWorkspaceLocation = false;
          await loadPage();
          return;
        }
        loading = false;
        render();
        return;
      } catch (fallbackError) {
        if (!currentRead()) return;
        error = fallbackError;
      } finally {
        recoveringWorkspaceLocation = false;
      }
    }
    lastError = error?.message || String(error);
    lastErrorIsRequest = error?.requestFailure === true;
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

// 后台自动刷新（实时唤醒、5 秒兜底轮询、监控页事件流）此前是 `.catch(() => {})`。网络与后端错误
// loadPage 内部已经处理并弹了 toast，能漏到这里的是【渲染本身抛了】—— 那一刻屏幕停在旧数据上，
// 看起来还活着，而且以后每一拍都会在同一处崩掉、同样没有声音。toast 挂在独立图层，render 崩了它照样显示。
function reportBackgroundRefreshFailure(error) {
  const message = error?.message || String(error);
  console.error("[background-refresh]", error);
  if (message === lastLoadErrorToast) return;
  lastLoadErrorToast = message;
  toast.error(`后台刷新失败，界面停在${lastLoadedAgo()}的数据：${message}`);
}

async function loadTaskGroupDetail(taskGroupId) {
  const currentRead = pageReadCheckpoint();
  const generation = ++taskGroupReadGeneration;
  // 房间消息是 agent 之间实际说过的话。它此前在控制台上完全没有入口：人只看得到最后送上来的
  // 那一个提案，看不到它是怎么谈出来的。而人工定稿这道闸门的前提恰恰是「人能看见 AI 的推理过程
  // 再决定」—— 看不见协商过程，定稿就退化成对结论点头。读取失败不阻断详情页：房间是旁证，
  // 不该让它的问题挡住主干信息。
  // progress 这条原先没有 catch：它一失败，整个函数抛出、tgDetail 停在 null，
  // 而面板对 null 只有一种说法——"正在加载任务组详情…"。于是顶上横幅已经报了失败，
  // 面板还在转圈，人等一件不会发生的事。（同一个"一个 null 兼表两种意思"的形状，
  // 项目规则配置、系统概览各修过一次，这是第三处。）
  // 仍要把错误抛出去：横幅要说清原因。但先把 tgDetail 填上，让面板说得出"没能加载出来"。
  let progressFailure = null;
  // 这两条只有 progress 会把错误抛出去置横幅；它俩失败时这一屏没有任何横幅，
  // 面板只能自己说清楚。原先原因被 catch 吞了，房间那块于是写成
  //「读取失败或当前账号无权查看」—— 两件事并成一句，人不知道该去要权限还是该重试。
  let configFailure = null;
  let roomFailure = null;
  const [progressResult, configResult, roomResult] = await Promise.all([
    api(`/api/task-groups/${encodeURIComponent(taskGroupId)}/progress`)
      .catch((error) => { progressFailure = error; return null; }),
    api(`/api/task-groups/${encodeURIComponent(taskGroupId)}/config`)
      .catch((error) => { configFailure = error; return null; }),
    api(`/api/rooms/${encodeURIComponent(`room_${taskGroupId}`)}/messages?limit=50&tail=1`)
      .catch((error) => { roomFailure = error; return null; })
  ]);
  if (!currentRead() || generation !== taskGroupReadGeneration) return;
  tgDetail = {
    taskGroupId,
    loadFailed: Boolean(progressFailure),
    progress: progressResult,
    config: configResult?.config || null,
    configVersion: configResult?.configVersion || null,
    roomMessages: roomResult?.messages || null,
    configLoadError: configFailure ? String(configFailure?.message || configFailure) : null,
    roomLoadError: roomFailure ? String(roomFailure?.message || roomFailure) : null,
    roomLoadDenied: roomFailure ? roomFailure.status === 403 || roomFailure.status === 401 : false,
    roomMessageTotal: roomResult?.total ?? null,
    roomMessagesTruncated: Boolean(roomResult?.truncated),
  };
  if (progressFailure) throw progressFailure;
}

async function loadReviewData() {
  // 人工确认由 tasks 视角随 state.humanConfirmationRequests 项目级下发，此处无需再逐组拉取
  return;
}

async function loadDirectiveData() {
  const currentRead = pageReadCheckpoint();
  const groups = projectTaskGroups();
  if (!groups.length) {
    directiveTaskGroupId = "";
    directiveWorkItemId = "";
    directiveList = [];
    return;
  }
  if (!directiveTaskGroupId || !groups.some((taskGroup) => taskGroup.id === directiveTaskGroupId)) {
    directiveTaskGroupId = groups[0].id;
  }
  const targetGroupId = directiveTaskGroupId;
  let result;
  try {
    result = await api(`/api/task-groups/${encodeURIComponent(targetGroupId)}/human-directives`);
  } catch (error) {
    if (currentRead() && targetGroupId === directiveTaskGroupId) throw error;
    return;
  }
  if (!currentRead() || targetGroupId !== directiveTaskGroupId) return;
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
  if (currentProjectId) { execScope = {type: "project", id: currentProjectId}; return; }
  const first = projectTaskGroups()[0];
  if (first) {
    execScope = {type: "taskGroup", id: first.id};
    execEvents = [];
    execCursor = 0;
  }
}

function execEventsPath(scope) {
  if (scope.type === "project") return `/api/projects/${encodeURIComponent(scope.id)}/execution-events`;
  if (scope.type === "dispatch") return `/api/agent-dispatches/${encodeURIComponent(scope.id)}/events`;
  if (scope.type === "session") return `/api/work-sessions/${encodeURIComponent(scope.id)}/execution-events`;
  return `/api/task-groups/${encodeURIComponent(scope.id)}/execution-events`;
}

async function loadExecEvents(options = {}) {
  if (!execScope.id || !authToken) return;
  const scope = execScope;
  const token = authToken;
  const historyMode = execHistoryMode;
  if (options.reset) execRevision += 1;
  const revision = execRevision;
  const after = options.afterSequence ?? (options.reset ? 0 : execCursor);
  const waitMs = options.longPoll ? 2000 : 0;
  let result;
  try {
    result = await api(`${execEventsPath(scope)}?afterSequence=${after}&limit=${historyMode ? 120 : 200}&waitMs=${waitMs}${options.reset && !historyMode ? "&latest=1" : ""}`);
  } catch (error) {
    if (scope === execScope && token === authToken && historyMode === execHistoryMode && revision === execRevision) throw error;
    return;
  }
  if (scope !== execScope || token !== authToken || historyMode !== execHistoryMode || revision !== execRevision) return;
  if (options.reset) execEvents = [];
  if (options.reset) execEventsDropped = Boolean(result.historyTruncated || result.hasEarlierEvents);
  const known = new Set(execEvents.map((event) => event.eventId));
  for (const event of result.events || []) {
    if (!known.has(event.eventId)) execEvents.push(event);
  }
  if (execEvents.length > 300) {
    execEventsDropped = true;
    execEvents = execEvents.slice(-300);
  }
  execCursor = Math.max(Number(result.nextCursor || after || 0), options.reset ? 0 : execCursor);
  execHasMore = result.hasMore === true;
  if (historyMode) execHistoryStart = after;
}

function stopExecPolling() {
  if (execTimer) {
    clearInterval(execTimer);
    execTimer = null;
  }
}

function startExecPolling() {
  stopExecPolling();
  if (page !== "monitor" || !execScope.id || execHistoryMode || workspaces.current("monitor")?.id !== "events") return;
  execTimer = setInterval(async () => {
    if (!authToken || page !== "monitor" || execHistoryMode || workspaces.current("monitor")?.id !== "events") {
      stopExecPolling();
      return;
    }
    try {
      await loadExecEvents({longPoll: true});
      const active = document.activeElement;
      // Do not rebuild the DOM while the operator is typing in a filter box or has the scope select
      // open — a full innerHTML render would drop focus/caret and close the dropdown every tick.
      if (!formTouched && !modalHtml && !window.AIMAC_RULE_EDITOR?.isOpen?.() && !(active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName))) render();
    } catch (error) {
      // 这条长轮询是监控页事件流的唯一来源。原先整个吞掉：流悄悄停住，而屏幕上还摆着上一拍的事件，
      // 人会以为"这段时间真的什么都没发生"。
      reportBackgroundRefreshFailure(error);
    }
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
        <div><strong>本地调试</strong>：初始化令牌${loginHint.bootstrapTokenConfigured ? "已配置" : "未配置"}。</div>
        ${!loginHint.tokenHintsExposed && loginHint.bootstrapTokenConfigured ? `<div class="small muted">系统管理员账号和初始化令牌请看 <span class="mono">npm run init</span> 输出。生产环境不会在登录页显示账号或令牌。</div>` : ""}
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
        <p class="login-sub">系统管理、组织管理、项目执行控制统一入口</p>
        ${lastError ? `<div class="notice error-notice" style="margin-bottom:14px;">登录失败：${esc(lastError)}</div>` : ""}
        <form class="form-grid" data-form="login">
          <div class="form-row"><label for="loginEmail">登录账号（邮箱或账号 ID）</label><input id="loginEmail" name="email" required autocomplete="username"></div>
          <div class="form-row"><label for="loginSecret">登录令牌或密码</label><input id="loginSecret" name="secret" type="password" required autocomplete="current-password"></div>
          <button class="primary-button" type="submit">登录</button>
        </form>
        ${hintBlock}
        <p class="small muted" style="margin-top:16px;">首次用一次性令牌登录后，可在顶栏「设置密码」处设置个人密码。</p>
      </div>
    </div>
  `;
  // 登录页绕过了 render 的写入路径。不在这里作废缓存的话，退出再登录时 render 会算出
  // 与上次登录后【一模一样】的整页 HTML，于是被跳过 —— 人就永远停在登录页上。
  lastRenderedHtml = null;
  loadLoginHint();
}

/* ---------------- 框架渲染 ---------------- */

let operationalStatsCache = null;
function operationalStatsIndex() {
  if (operationalStatsCache?.source === state) return operationalStatsCache;
  const runs = new Map();
  const blockedRuns = new Map();
  const reviews = new Map();
  const bump = (map, id) => { if (id) map.set(id, Number(map.get(id) || 0) + 1); };
  for (const dispatch of state.agentDispatches || []) {
    if (!terminalDispatchStatuses.has(dispatch.status)) bump(runs, dispatch.taskGroupId);
    if (dispatch.status === "blocked") bump(blockedRuns, dispatch.taskGroupId);
  }
  for (const item of [...(state.humanConfirmationRequests || []), ...(state.permissionRequests || []), ...(state.approvalRequests || [])]) {
    if (["pending", "requested", "pending_approval"].includes(item.status)) bump(reviews, item.taskGroupId);
  }
  operationalStatsCache = {source: state, runs, blockedRuns, reviews};
  return operationalStatsCache;
}

function taskGroupOperationalStats(group) {
  if (!group) return {tasks: 0, runs: 0, reviews: 0, blocked: 0};
  const taskItems = tgDetail?.taskGroupId === group.id && tgDetail?.progress?.workItems
    ? tgDetail.progress.workItems : group.workItems || [];
  const indexed = operationalStatsIndex();
  const blockedWork = taskItems.filter((item) => item.blockedReason || String(item.status || "").startsWith("blocked")).length;
  return {
    tasks: group.workItemCount ?? taskItems.length,
    runs: Number(indexed.runs.get(group.id) || 0),
    reviews: Number(indexed.reviews.get(group.id) || 0),
    blocked: Number(group.blockerCount ?? group.blockers?.length ?? 0) + blockedWork + Number(indexed.blockedRuns.get(group.id) || 0)
  };
}

function sidebarContextHtml(perspective) {
  const currentSection = managementSectionOf(page, perspective);
  const accountOrganizationId = currentAccount?.organizationId || state.organizationContext?.id;
  const organization = (state.organizations || []).find((item) => item.orgId === accountOrganizationId)
    || (state.organizationContext?.id === accountOrganizationId ? state.organizationContext : null);
  const spaces = window.AIMAC_CONTEXT_NAVIGATION.managementSpaces({
    perspective,
    currentSection,
    organizationName: organization?.name || "",
    projectCount: selectableProjects().length
  });
  if (currentSection !== "project") return {spaces, project: ""};
  const project = currentProject();
  if (!project) return {spaces, project: ""};
  const groupId = managementGroupId || (page === "tg" ? expandedTaskGroupId : "");
  const group = projectTaskGroups().find((item) => item.id === groupId)
    || (taskWorkDetail?.taskGroup?.projectId === project.id && taskWorkDetail.taskGroup.id === groupId ? taskWorkDetail.taskGroup : null);
  const taskItems = group
    ? (tgDetail?.taskGroupId === group.id && tgDetail?.progress?.workItems ? tgDetail.progress.workItems : group.workItems || [])
    : [];
  const work = group && selectedWork?.taskGroupId === group.id
    ? (taskWorkDetail?.workItem?.id === selectedWork.workItemId ? taskWorkDetail.workItem
      : taskItems.find((item) => item.id === selectedWork.workItemId))
    : null;
  const stats = taskGroupOperationalStats(group);
  return {spaces, project: window.AIMAC_CONTEXT_NAVIGATION.projectContext({
    project,
    projects: selectableProjects(),
    group,
    work,
    stats,
    labels: {projectStatus: t(project.status), groupStatus: t(group?.goalExecutionStatus || group?.status), workStatus: t(work?.status)}
  })};
}

function workspaceRouteSnapshot() {
  const groupId = managementGroupId || (page === "tg" ? expandedTaskGroupId : "");
  const workspace = page === "tg" && expandedTaskGroupId
    ? workspaces.current("group-detail")?.id || "tasks"
    : workspaces.current(page)?.id || "";
  return {
    page,
    workspace,
    projectId: PROJECT_PAGES.has(page) ? currentProjectId : "",
    groupId,
    workId: page === "tasks" ? selectedWork?.workItemId || ""
      : page === "directives" ? directiveWorkItemId || "" : "",
    organizationId: page === "sys-orgs" ? selectedOrganizationId : "",
    accountId: page === "org-members" ? selectedOrgMemberId
      : page === "proj-members" ? selectedProjectMemberId : "",
    agentId: ["org-agents", "proj-agents"].includes(page) ? selectedAgentProfileId : ""
  };
}

function requestRoutePush() {
  if (!applyingBrowserRoute) routeWriteMode = "push";
}

function syncWorkspaceRoute() {
  if (!authToken || !currentAccount || applyingBrowserRoute) return;
  const replace = routeWriteMode !== "push";
  routeWriteMode = "replace";
  window.AIMAC_WORKSPACE_ROUTE?.write(workspaceRouteSnapshot(), {replace});
}

function restoreWorkspaceRoute(route = window.AIMAC_WORKSPACE_ROUTE?.parse()) {
  if (!route || !allowedMenuItemsFor(perspectiveOf(currentAccount)).some((item) => item.id === route.page)) return false;
  page = route.page;
  currentProjectId = PROJECT_PAGES.has(page) ? route.projectId || "" : currentProjectId;
  selectedOrganizationId = page === "sys-orgs" ? route.organizationId || "" : "";
  selectedOrgMemberId = page === "org-members" ? route.accountId || "" : "";
  selectedProjectMemberId = page === "proj-members" ? route.accountId || "" : "";
  selectedAgentProfileId = ["org-agents", "proj-agents"].includes(page) ? route.agentId || "" : "";
  memberGrantAccountId = selectedOrgMemberId || selectedProjectMemberId;
  managementGroupId = ["tg", "tasks", "monitor", "review", "directives"].includes(page) ? route.groupId || "" : "";
  expandedTaskGroupId = page === "tg" && managementGroupId ? managementGroupId : "";
  selectedWork = page === "tasks" && managementGroupId && route.workId
    ? {taskGroupId: managementGroupId, workItemId: route.workId} : null;
  directiveTaskGroupId = page === "directives" ? managementGroupId : "";
  directiveWorkItemId = page === "directives" ? route.workId || "" : "";
  const workspacePage = expandedTaskGroupId ? "group-detail" : page;
  const targetWorkspace = route.workspace || workspaces.catalog[workspacePage]?.[0]?.id;
  if (!workspaces.select(workspacePage, targetWorkspace)) {
    const first = workspaces.catalog[workspacePage]?.[0]?.id;
    if (first) workspaces.select(workspacePage, first);
  }
  execScope = managementGroupId ? {type: "taskGroup", id: managementGroupId}
    : currentProjectId ? {type: "project", id: currentProjectId} : {type: "", id: ""};
  execEvents = [];
  execCursor = 0;
  taskWorkDetail = null;
  tgDetail = null;
  restoredWorkspaceLocation = true;
  sessionStorage.setItem("aimac.page", page);
  if (currentProjectId) sessionStorage.setItem("aimac.projectId", currentProjectId);
  return true;
}

function reconcileRoutedObjectSelection() {
  let missing = "";
  if (page === "sys-orgs" && selectedOrganizationId
    && !(organizations || []).some((organization) => organization.orgId === selectedOrganizationId)) {
    selectedOrganizationId = "";
    missing = "组织";
  } else if (page === "org-members" && selectedOrgMemberId
    && !(orgMembers || []).some((account) => account.accountId === selectedOrgMemberId)) {
    selectedOrgMemberId = "";
    memberGrantAccountId = "";
    missing = "组织成员";
  } else if (page === "proj-members" && selectedProjectMemberId
    && !(currentProject()?.members || []).some((member) => member.accountId === selectedProjectMemberId)) {
    selectedProjectMemberId = "";
    missing = "项目成员";
  } else if (["org-agents", "proj-agents"].includes(page) && selectedAgentProfileId) {
    const visibleAgents = page === "org-agents" ? orgScopedAgents() : projectScopedAgents(currentProjectId);
    if (!visibleAgents.some((agent) => agent.id === selectedAgentProfileId)) {
      selectedAgentProfileId = "";
      missing = "Agent 档案";
    }
  }
  if (!missing && managementGroupId && ["tg", "tasks", "monitor", "review", "directives"].includes(page)
    && !projectTaskGroups().some((group) => group.id === managementGroupId)
    && taskWorkDetail?.taskGroup?.id !== managementGroupId) {
    managementGroupId = "";
    expandedTaskGroupId = "";
    selectedWork = null;
    directiveTaskGroupId = "";
    directiveWorkItemId = "";
    execScope = currentProjectId ? {type: "project", id: currentProjectId} : {type: "", id: ""};
    execEvents = [];
    execCursor = 0;
    missing = "任务组";
  }
  if (missing) {
    routeWriteMode = "replace";
    toast.info(`地址中的${missing}不存在或当前账号无权查看，已返回最近的可见范围`);
  }
  return missing;
}

function render() {
  if (window.AIMAC_RULE_EDITOR?.isOpen?.()) return;
  if (!authToken || !currentAccount) {
    renderLogin();
    return;
  }
  const perspective = perspectiveOf(currentAccount);
  // 人点名要的那一页给不了时不能一声不吭。两种情形都落到这里：
  //   页 id 不认识（版本升级改了名、旧书签、别人发来的链接）；
  //   页存在但【在他的视角下没有】（权限）。
  // 静默换成默认页，人会以为链接生效了、眼前这页就是他要的那页 —— 而系统明明知道不是。
  // "没点名要"（首次进入、page 为空）不在此列：那时默认页就是正确答案，不该打扰。
  const requestedPage = page;
  if (!page || !allowedMenuItemsFor(perspective).some((item) => item.id === page)) {
    page = defaultPageFor(perspective);
    if (requestedPage && requestedPage !== page) {
      const asked = PAGE_META[requestedPage]?.[0] || requestedPage;
      toast.info(`「${asked}」在当前视角下打不开，已回到「${PAGE_META[page]?.[0] || page}」`);
    }
  }
  if (workspaceOptions().canCreate === false && ["create", "register"].includes(workspaces.current(page)?.id)) {
    workspaces.select(page, workspaces.catalog[page]?.[0]?.id);
  }
  if (!loading && !lastError) {
    rememberWorkspaceLocation();
    syncWorkspaceRoute();
  }
  const [title, subtitle] = PAGE_META[page] || ["管理后台", ""];
  // 菜单上直接带计数：否则"等你签字的东西"藏在一个叫"执行监控"的页面里，人根本不会去点。
  const menuTodoCounts = todoCountsByPage();
  const visibleMenu = menuForCurrentSection(perspective, page);
  const menuHtml = visibleMenu.map((item) => item.divider
    ? `<div class="nav-divider">${esc(item.divider)}</div>`
    : (() => {
        const todo = menuTodoCounts[item.id] || {count: 0, capped: false};
        return menuItemHtml(item, item.id === page, todo) + (item.id === page ? workspaces.navigation(page === "tg" && expandedTaskGroupId ? "group-detail" : page, false, workspaceOptions()) : "");
      })()
  ).join("");
  const sidebarContext = sidebarContextHtml(perspective);

  const html = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-mark">智</span>
          <div>
            <strong>AI 多智能体管控台</strong>
            <span class="brand-section">${esc(sectionLabel(perspective, page))}</span>
          </div>
        </div>
        ${sidebarContext.spaces}
        ${sidebarContext.project}
        <nav class="nav" aria-label="管理菜单">${menuHtml}</nav>
      </aside>
      <main class="workspace">
        <header class="topbar">
          <div>
            <h1>${esc(title)}</h1>
            <p class="subtitle">${esc(subtitle)}</p>
          </div>
          ${currentAccount.accountType === "user_account" && (state.accountCapabilities?.canCreateProject ?? (currentAccount.permissions || []).includes("project:create"))
            ? `<button class="secondary-button" data-action="open-create-project">创建项目</button>` : ""}
          <div class="topbar-actions">
            <span class="account-chip">${esc(currentAccount.displayName || currentAccount.email)} ${badge(currentAccount.accountType)}</span>
            ${/* 界面上所有时间都按浏览器本机时区渲染，而服务端日志（audit-log.jsonl、执行事件）是 UTC。
                  不标时区，人拿屏幕上的时间去对日志会差好几个小时，进而以为那条记录根本不存在。 */""}
            <span class="small muted" title="界面时间按本机时区显示；服务端日志用的是 UTC">${esc(localZoneLabel())}</span>
            ${clockSkewNote() ? `<span class="small warn-text" title="相对时间已按服务器时钟校正">${esc(clockSkewNote())}</span>` : ""}
            ${/* 接口一直下发 authPolicy.passwordSet，这里此前没读：一个从没设过口令的人（邀请令牌登录的）
                  看到的是"修改密码"，弹窗里还写着"当前密码（首次设置可留空）"—— 让他去想自己是不是忘了什么。
                  系统知道他有没有设过，就该直接说对。 */""}
            <button class="secondary-button" data-action="open-change-password">${(currentAccount?.passwordSet ?? currentAccount?.authPolicy?.passwordSet) ? "修改密码" : "设置密码"}</button>
            <button class="icon-button" data-action="refresh" title="刷新" aria-label="刷新">↻</button>
            <button class="secondary-button" data-action="logout">退出登录</button>
          </div>
        </header>
        ${/* 加载失败此前只弹一次 toast。toast 会消失，而这一屏还挂着上一次成功时的数据 ——
              盯着执行监控页的人看到的是冻住的画面，屏幕上没有任何迹象说"这已经不是现在的样子了"。
              对一个监控台来说这是最要紧的那一刻，所以给一条常驻横幅，下一次加载成功自动消失。 */""}
        ${lastError ? `<div class="notice warn-notice">${lastErrorIsRequest
          ? `连不上控制面或这一页加载失败，${esc(lastLoadedAgo())}：${esc(lastError)}`
          : `控制台这一页自己出错了（不是控制面连不上），${esc(lastLoadedAgo())}：`
            + `${esc(lastError)}。这多半是控制台的缺陷 —— 请把这句话连同所在页面反馈给维护者`}</div>` : ""}
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
  window.AIMAC_RULE_EDITOR?.enhance(app);
}

function renderContent() {
  const project = PROJECT_PAGES.has(page) ? currentProject() : null;
  const group = projectTaskGroups().find((item) => item.id === (managementGroupId || (page === "tg" ? expandedTaskGroupId : "")))
    || (taskWorkDetail?.taskGroup?.projectId === currentProjectId && taskWorkDetail.taskGroup.id === managementGroupId ? taskWorkDetail.taskGroup : null);
  const returnTask = ["monitor", "review", "directives", "tg"].includes(page) && group
    && taskReturnContext?.accountId === currentAccount?.accountId && taskReturnContext.projectId === currentProjectId && taskReturnContext.taskGroupId === group.id ? taskReturnContext : null;
  const context = window.AIMAC_OBJECT_WORKSPACE.trail({organization: state.organizationContext, project, group: project && ["tg", "tasks", "monitor", "review", "directives"].includes(page) ? group : null,
    work: page === "tasks" && selectedWork ? taskWorkDetail?.workItem : null, pageLabel: PAGE_META[page]?.[0] || "", returnTask});
  const governanceObjectOpen = (page === "sys-orgs" && selectedOrganizationId)
    || (page === "org-members" && selectedOrgMemberId)
    || (page === "proj-members" && selectedProjectMemberId)
    || (["org-agents", "proj-agents"].includes(page) && selectedAgentProfileId);
  if (PROJECT_PAGES.has(page) && hasNoVisibleProject()) return context + renderPanel(PAGE_META[page]?.[0] || "项目管理", noVisibleProjectNotice(), {wide: true});
  const groupDetail = page === "tg" && expandedTaskGroupId;
  return context + workspaces.navigation(groupDetail ? "group-detail" : page, true, workspaceOptions())
    + (groupDetail || governanceObjectOpen ? "" : workspaces.heading(page, workspaceOptions()))
    + managementScopeBar() + workspaces.run(page, renderPageContent);
}

function workspaceOptions() {
  return {canCreate: page === "tg" ? hasProjectPermission("task_group:control")
    : page === "tasks" ? hasPerm("task_group:control")
      : page === "proj-agents" ? hasPerm("agent:activate") : true};
}

function focusedTaskGroups() {
  const groups = projectTaskGroups();
  const detailGroup = taskWorkDetail?.taskGroup;
  if (detailGroup?.projectId === currentProjectId && !groups.some((group) => group.id === detailGroup.id)) groups.push(detailGroup);
  if (managementGroupId && !groups.some((group) => group.id === managementGroupId)) managementGroupId = "";
  return managementGroupId ? groups.filter((group) => group.id === managementGroupId) : groups;
}

function managementScopeBar() {
  if (page === "tg" && expandedTaskGroupId) return "";
  if (!["tg", "tasks", "monitor", "review", "directives"].includes(page)) return "";
  focusedTaskGroups();
  const groups = projectTaskGroups();
  if (taskWorkDetail?.taskGroup?.projectId === currentProjectId && !groups.some((group) => group.id === taskWorkDetail.taskGroup.id)) groups.push(taskWorkDetail.taskGroup);
  return `<div class="workspace-scope"><label for="management-group">任务组范围</label><select id="management-group" data-management-group>
    <option value="">整个项目</option>${groups.map((group) => `<option value="${esc(group.id)}"${managementGroupId === group.id ? " selected" : ""}>${esc(group.name || group.id)}</option>`).join("")}</select>
    ${managementGroupId ? `<button class="secondary-button" data-focus-group="${esc(managementGroupId)}" data-focus-page="tg">任务组详情</button>` : ""}</div>`;
}

function renderTaskWorkbench() {
  if (hasNoVisibleProject()) return panel("任务工作台", noVisibleProjectNotice(), {wide: true});
  if (workspaces.current("tasks")?.id === "create") return renderTaskGroups();
  if (selectedWork && (taskWorkDetail?.workItem?.id !== selectedWork.workItemId || taskWorkDetail?.taskGroup?.id !== selectedWork.taskGroupId || taskWorkDetail?.taskGroup?.projectId !== currentProjectId)) {
    return panel("任务详情", `<button class="secondary-button" data-close-work>返回任务列表</button><div class="notice">${taskPageLoading ? "正在加载完整任务详情…" : "任务详情尚未加载成功，请刷新重试。"}</div>`, {wide: true});
  }
  return panel(selectedWork ? "任务详情" : "任务工作台", window.AIMAC_TASK_WORKBENCH.render({
    groups: focusedTaskGroups(), detail: tgDetail, state, selected: selectedWork, query: taskSearch, status: taskStatus,
    pageData: taskPageData, workDetail: taskWorkDetail, pageNumber: taskCursorStack.length + 1, loading: taskPageLoading,
    eventHistory: workEventHistoryMode, eventPage: workEventCursorStack.length + 1,
    disclosure: taskRunDisclosure,
    helpers: {badge, t, explainCoded, fmtTime, progressLine, humanTraceHtml, workItemExitHint, workItemResultHtml, repositoryFailureAction, dispatchRuleSummaries, ruleSummaryHtml,
      isTerminalDispatch: (status) => terminalDispatchStatuses.has(status)}
  }), {wide: true});
}

async function loadTaskWorkbenchData() {
  if (!currentProjectId) return;
  const currentRead = pageReadCheckpoint();
  const generation = ++taskRequestGeneration;
  const projectId = currentProjectId;
  taskPageLoading = true;
  try {
    const query = new URLSearchParams({limit: "50"});
    if (managementGroupId) query.set("taskGroupId", managementGroupId);
    if (taskSearch) query.set("q", taskSearch);
    if (taskStatus) query.set("status", taskStatus);
    if (taskPageCursor) query.set("cursor", taskPageCursor);
    const result = selectedWork
      ? await api(`/api/task-groups/${encodeURIComponent(selectedWork.taskGroupId)}/work-items/${encodeURIComponent(selectedWork.workItemId)}?${workEventHistoryMode ? `afterSequence=${workEventCursor}` : "latest=1"}&eventLimit=120`)
      : await api(`/api/projects/${encodeURIComponent(projectId)}/work-items?${query}`);
    if (!currentRead() || generation !== taskRequestGeneration || projectId !== currentProjectId || page !== "tasks") return;
    if (selectedWork) {
      if (result.projectId !== projectId || result.taskGroup?.projectId !== projectId || result.taskGroup?.id !== selectedWork.taskGroupId || result.workItem?.id !== selectedWork.workItemId) {
        const error = new Error("任务与当前项目或保存的位置不匹配，请返回任务列表重新选择");
        error.requestFailure = true;
        throw error;
      }
      if (taskWorkDetail?.workItem?.id !== result.workItem?.id || taskWorkDetail?.taskGroup?.id !== result.taskGroup?.id) taskRunDisclosure = {};
      taskWorkDetail = result;
      taskReturnContext = {...selectedWork, accountId: currentAccount?.accountId, projectId,
        title: result.workItem?.title || selectedWork.workItemId, listGroupId: workListGroupId, listState: workListState};
      for (const [key, id] of [["agentDispatches", "dispatchId"], ["workSessions", "sessionId"], ["repositoryOutputs", "targetId"], ["checkpoints", "runId"], ["agentRuntimeNodes", "nodeId"]]) {
        if (!Array.isArray(result[key])) continue;
        const incoming = new Set(result[key].map((item) => item[id]));
        state[key] = [...result[key], ...(state[key] || []).filter((item) => !incoming.has(item[id]))];
      }
      if (Array.isArray(result.events)) state.agentExecutionEvents = result.events;
    } else {
      taskPageData = result;
      taskWorkDetail = null;
    }
  } catch (error) {
    if (currentRead() && generation === taskRequestGeneration && projectId === currentProjectId && page === "tasks") throw error;
  } finally { if (generation === taskRequestGeneration) taskPageLoading = false; }
}

function resetTaskWorkbench() {
  taskRunDisclosure = {};
  taskReturnContext = null;
  memberGrantAccountId = "";
  selectedProjectMemberId = "";
  workEventHistoryMode = false;
  workEventCursor = 0;
  workEventCursorStack = [];
  execHistoryMode = false;
  execHistoryStack = [];
  execHistoryStart = 0;
  execHasMore = false;
  execRevision += 1;
  managementGroupId = "";
  selectedWork = null;
  workListGroupId = "";
  workListState = null;
  taskSearch = "";
  taskStatus = "";
  taskPageData = null;
  taskWorkDetail = null;
  taskPageCursor = "";
  taskCursorStack = [];
  taskPageLoading = false;
  taskRequestGeneration += 1;
  if (taskSearchTimer) clearTimeout(taskSearchTimer);
  taskSearchTimer = null;
}

function renderPageContent() {
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
  else if (page === "proj-members") body = renderProjectMembers();
  else if (page === "tg") body = renderTaskGroups();
  else if (page === "tasks") body = renderTaskWorkbench();
  else if (page === "review") body = renderReview();
  else if (page === "directives") body = renderDirectives();
  else if (page === "monitor") body = renderMonitor();
  else if (page === "proj-agents") body = renderProjectAgents();
  else if (page === "proj-settings") body = renderProjectSettings();
  return body;
}

function spaceHubHtml({title, score, scoreText, scoreLabel, meta = [], modules = []}) {
  if (!workspaces.showHub()) return "";
  const normalizedScore = Math.max(0, Math.min(100, Number(score || 0)));
  return `
    <section class="project-hub space-hub wide">
      <div class="project-hub-main">
        <div class="project-score" style="--score:${normalizedScore};"><strong>${esc(scoreText)}</strong><span>${esc(scoreLabel)}</span></div>
        <div class="project-hub-text">
          <div class="project-hub-title">${esc(title)}</div>
          <div class="project-hub-meta">${meta.map((item) => `<span>${item}</span>`).join("")}</div>
        </div>
      </div>
      <div class="module-grid">${modules.map((item) => projectModuleCard(item)).join("")}</div>
    </section>
  `;
}

function healthScore(part, total) {
  const denominator = Number(total || 0);
  if (!denominator) return 100;
  return Math.round((Math.max(0, Number(part || 0)) / denominator) * 100);
}

function isServiceHealthy(service) {
  return TONE_GREEN.has(String(service?.health || ""));
}

function renderSystemManagementHub(overview) {
  const services = state.runtime?.services || [];
  const healthyServices = services.filter(isServiceHealthy).length;
  const orgCount = overview?.runtime?.organizations ?? (organizations.length || (state.organizations || []).length);
  const projectCount = overview?.runtime?.projects ?? (state.projects || []).length;
  const orgAdmins = (state.accounts || []).filter((account) =>
    account.accountType === "org_admin" && !["retired", "suspended", "disabled"].includes(account.status)).length;
  const mcpToolCount = state.runtime?.mcp?.toolCount ?? "—";
  return spaceHubHtml({
    title: "系统管理总览",
    score: healthScore(healthyServices, services.length),
    scoreText: services.length ? `${healthyServices}/${services.length}` : "—",
    scoreLabel: "服务健康",
    meta: [
      `运行 ${badge(state.runtime?.status)}`,
      `状态版本 <span class="mono">${esc(overview?.runtime?.stateVersion ?? state.stateVersion ?? "-")}</span>`,
      `更新 ${fmtTime(overview?.at)}`
    ],
    modules: [
      {pageId: "sys-orgs", title: "组织与配额", metric: `${orgCount}`, detail: "创建组织、调整配额、启停组织", action: "管理组织", tone: "blue"},
      {pageId: "sys-orgs", title: "默认组织管理员", metric: `${orgAdmins}`, detail: "组织创建时签发初始管理员账号；子账户由组织管理员维护", action: "查看管理员", tone: orgAdmins ? "blue" : "orange"},
      {pageId: "sys-settings", title: "模型与技能源", metric: `${mcpToolCount}`, detail: "模型能力、技能源同步、指令压缩指标", action: "查看设置", tone: "blue"},
      {pageId: "proj-overview", title: "项目空间", metric: `${projectCount}`, detail: "进入当前项目的任务组、审核、指令和监控", action: "进入项目", tone: projectCount ? "blue" : "gray"}
    ]
  });
}

function renderOrgManagementHub(org, projects, openTaskGroups) {
  const members = (orgMembers || []).filter((account) => account.accountType !== "service_account"
    && !["disabled", "suspended", "retired"].includes(account.status));
  const memberCount = org?.usage?.members ?? members.length;
  const aliveNodes = (orgAgentNodes || []).filter((node) => node.status !== "revoked");
  const onlineNodes = aliveNodes.filter((node) => node.status === "online").length;
  const activeProjects = (projects || []).filter((project) => project.status !== "archived").length;
  const quotaStatus = org ? `${org.usage?.projects ?? activeProjects}/${org.quotas?.maxProjects ?? "—"}` : "—";
  return spaceHubHtml({
    title: org ? `组织管理总览 · ${org.name}` : "组织管理总览",
    score: healthScore(onlineNodes, aliveNodes.length),
    scoreText: aliveNodes.length ? `${onlineNodes}/${aliveNodes.length}` : "—",
    scoreLabel: "在线节点",
    meta: [
      `组织状态 ${statusBadge("organization", org?.status)}`,
      `项目配额 ${esc(quotaStatus)}`,
      `活跃任务组 ${esc(openTaskGroups.length)}`
    ],
    modules: [
      {pageId: "org-members", title: "成员管理", metric: `${memberCount}`, detail: "启用及待接受邀请的成员；创建、邀请与账号管理", action: "管理成员", tone: memberCount ? "blue" : "gray"},
      {pageId: "org-agents", title: "共享 Agent", metric: aliveNodes.length ? `${onlineNodes}/${aliveNodes.length}` : "0", detail: "组织档案、共享节点、自检与令牌治理", action: "管理共享 Agent", tone: onlineNodes ? "green" : "orange"},
      {pageId: "org-projects", title: "项目列表", metric: `${activeProjects}/${projects.length}`, detail: "创建项目、归档项目、补充分配授权", action: "管理项目", tone: activeProjects ? "blue" : "gray"},
      {pageId: "proj-overview", title: "项目空间", metric: `${(state.taskGroups || []).length}`, detail: "进入当前项目的任务组、审核、指令和监控", action: "进入项目", tone: projects.length ? "blue" : "gray"}
    ]
  });
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
    renderSystemManagementHub(overview),
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
  ].join("") : panel("系统概览", `<div class="notice">${systemOverviewStatus === "failed"
    ? "系统概览这一块没能加载出来（原因写在页面顶部的横幅里）—— 下面的系统服务与审计日志是刚取到的，可以照常看"
    : "正在加载系统概览…"}</div>`, {wide: true});

  return overviewPanels + [
    panel("系统服务", table(["服务", "状态", "健康度"], services)),
    panel("维护操作", `
      <div class="stack">
        <div class="notice warn-notice">
          <strong>高危操作：重新初始化运行态</strong>
          <div>重新初始化会把运行态整个重置为种子数据，生产环境同样点得动；真正拦住误操作的是下一步的打字确认。</div>
          <ul class="danger-summary">
            <li>会清空组织、项目、任务组、账号、授权和审计记录，并恢复为种子数据。</li>
            <li>该操作不可撤销；生产环境同样可执行，请只用于明确的本地排障或重建。</li>
            <li>下一步会要求按页面提示输入确认串；有会话、派发、确认单或工作项超出种子时，还会校验当前规模。</li>
          </ul>
        </div>
        <div class="button-row"><button class="danger-button" data-action="bootstrap-init">重新初始化运行态</button></div>
      </div>
    `),
    panel("审计日志", `
      <div class="stack">
        ${state.auditArchiveFault ? `<div class="notice warn-notice">审计归档写入失败，已有 ${esc(state.auditArchiveFault.lostEntries)} 条记录没能落盘（${esc(state.auditArchiveFault.error)}）—— 这段时间的操作事后查不到，请先修复磁盘或权限。</div>` : ""}
        ${state.eventLogFault ? `<div class="notice warn-notice">执行事件日志有损坏：${esc(state.eventLogFault)}</div>` : ""}
        ${table(["时间", "操作者", "动作", {label: "对象", c: "text-clip"}, "结果"], audit, {moreText: moreText((state.auditLog || []).length, 15, "auditLog")})}
        <div class="small muted">${auditWindowNote()}</div>
        ${/* 经 MCP 改的状态此前在这一屏上一条痕迹都没有（主台账只由 REST 侧写）。现在两条写路径
              共用同一本台账：MCP 的写入记成「MCP 工具调用」，执行者形如 mcp:<主体类型>:<id>。
              入参与返回摘要仍在 mcp-audit.jsonl 里，那是另一层的东西，这里说清去哪看。 */""}
        <div class="small muted">控制台、REST 与 MCP 三条路径的改动都记在这一本台账里
          （MCP 的记为「MCP 工具调用」，执行者形如 <span class="mono">mcp:主体类型:id</span>）。
          每次 MCP 调用的入参与返回摘要另存于服务端的 <span class="mono">mcp-audit.jsonl</span>。</div>
        <div class="button-row"><button class="ghost-button" data-action="open-audit-archive">查看审计归档</button></div>
      </div>
    `, {wide: true})
  ].join("");
}

/* ---------------- 系统管理员：组织管理 ---------------- */

function renderSysOrgsActionBoard({orgs, activeOrgs, suspendedOrgs, quotaPressure}) {
  return panel("组织与配额操作看板", `
    <div class="module-grid">
      ${jumpModuleCard({
        title: "启用组织",
        metric: `${activeOrgs}`,
        detail: activeOrgs ? "可继续创建项目、成员和智能体" : "当前没有启用中的组织",
        panelTitle: "组织列表",
        tone: activeOrgs ? "blue" : "orange",
        action: "查看组织"
      })}
      ${jumpModuleCard({
        title: "停用 / 异常",
        metric: `${suspendedOrgs}`,
        detail: suspendedOrgs ? "需要核对停用原因和恢复入口" : "当前没有停用或异常组织",
        panelTitle: "组织列表",
        tone: suspendedOrgs ? "red" : "green",
        action: "定位风险"
      })}
      ${jumpModuleCard({
        title: "配额压力",
        metric: `${quotaPressure}`,
        detail: quotaPressure ? "任一配额达到 80% 即计入" : "当前配额压力正常",
        panelTitle: "组织列表",
        tone: quotaPressure ? "orange" : "green",
        action: "查看配额"
      })}
      ${jumpModuleCard({
        title: "组织总数",
        metric: `${orgs.length}`,
        detail: "系统内全部组织资源边界",
        panelTitle: "组织列表",
        tone: orgs.length ? "blue" : "gray",
        action: "查看列表"
      })}
      ${jumpModuleCard({
        title: "创建组织",
        metric: "入口",
        detail: "创建组织并签发初始组织管理员",
        panelTitle: "创建组织",
        tone: "blue",
        action: "创建"
      })}
      ${jumpModuleCard({
        title: "治理说明",
        metric: "3 层",
        detail: "系统管理员、组织管理员、项目成员职责边界",
        panelTitle: "说明",
        tone: "gray",
        action: "查看说明"
      })}
    </div>
    <div class="small muted">处理顺序：先核对组织状态、配额压力和启停风险，再创建组织或调整配额。</div>
  `, {wide: true});
}

function renderSysOrgsLifecycleGuide({orgs, activeOrgs, suspendedOrgs, quotaPressure}) {
  return panel("组织开通治理流程", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "1 创建组织",
        metric: orgs.length || "创建",
        detail: "先创建组织并签发初始组织管理员账号，一次性令牌只在创建成功弹窗显示",
        panelTitle: "创建组织",
        tone: orgs.length ? "blue" : "orange",
        action: "去创建"
      })}
      ${jumpModuleCard({
        title: "2 设置配额",
        metric: quotaPressure,
        detail: "成员、项目、任务组和智能体配额在组织列表里调整，接近上限先扩容或收口",
        panelTitle: "组织列表",
        tone: quotaPressure ? "orange" : "green",
        action: "看配额"
      })}
      ${jumpModuleCard({
        title: "3 交付管理员",
        metric: "账号",
        detail: "系统管理员只签发初始组织管理员；日常子账户、项目和 Agent 管理由组织管理员承接",
        panelTitle: "组织列表",
        tone: "blue",
        action: "看管理员"
      })}
      ${projectModuleCard({
        pageId: "proj-overview",
        title: "4 项目侧建设",
        metric: activeOrgs,
        detail: "组织开通后，项目配置、Agent 注册、任务组执行和监控都在项目管理空间完成",
        tone: activeOrgs ? "green" : "gray",
        action: "去项目"
      })}
      ${jumpModuleCard({
        title: "5 启停治理",
        metric: suspendedOrgs,
        detail: "停用组织会影响成员、项目、任务组和 Agent 准入；恢复也从组织列表执行",
        panelTitle: "组织列表",
        tone: suspendedOrgs ? "red" : "green",
        action: "看状态"
      })}
      ${jumpModuleCard({
        title: "6 审计说明",
        metric: "3 层",
        detail: "系统管理员、组织管理员、项目成员职责边界在说明区固定展示",
        panelTitle: "说明",
        tone: "gray",
        action: "看说明"
      })}
    </div>
    <div class="small muted">组织管理页只负责租户开通、初始组织管理员、配额和启停治理；组织创建不是执行终点，后续子账户、项目、Agent、任务组和监控必须进入组织或项目管理空间处理。</div>
  `, {wide: true});
}

function systemOrganizationActions(org, initialAdmin) {
  return [
    `<button class="secondary-button" data-action="org-quota" data-org="${esc(org.orgId)}">调整配额</button>`,
    `<button class="secondary-button" data-action="replace-initial-admin" data-org="${esc(org.orgId)}">更换初始管理员</button>`,
    initialAdmin?.status === "invited"
      ? `<button class="secondary-button" data-action="member-reissue-invite" data-account="${esc(org.initialAdminAccountId)}">重发管理员邀请</button>` : "",
    initialAdmin && ["active", "suspended", "locked"].includes(initialAdmin.status)
      ? `<button class="secondary-button" data-action="reset-initial-admin-login" data-account="${esc(org.initialAdminAccountId)}">重置管理员登录</button>` : "",
    org.status === "active"
      ? `<button class="danger-button" data-action="org-status" data-org="${esc(org.orgId)}" data-status="suspended">停用组织</button>`
      : `<button class="secondary-button" data-action="org-status" data-org="${esc(org.orgId)}" data-status="active">启用组织</button>`
  ].filter(Boolean).join(" ");
}

function renderSysOrgs() {
  const initialAdminById = new Map((state.accounts || []).map((account) => [account.accountId, account]));
  const activeOrgs = organizations.filter((org) => org.status === "active").length;
  const suspendedOrgs = organizations.filter((org) => org.status !== "active").length;
  const quotaPressure = organizations.filter((org) => {
    const pairs = [
      [org.usage?.members, org.quotas?.maxMembers],
      [org.usage?.projects, org.quotas?.maxProjects],
      [org.usage?.taskGroups, org.quotas?.maxTaskGroups],
      [org.usage?.agents + (org.usage?.agentsReserved || 0), org.quotas?.maxAgents]
    ];
    return pairs.some(([used, max]) => Number(max) > 0 && Number(used || 0) / Number(max) >= 0.8);
  }).length;
  const selectedOrganization = organizations.find((org) => org.orgId === selectedOrganizationId);
  if (selectedOrganizationId && !selectedOrganization) selectedOrganizationId = "";
  if (selectedOrganization) {
    const initialAdmin = initialAdminById.get(selectedOrganization.initialAdminAccountId) || null;
    const subaccounts = (state.accounts || []).filter((account) => account.accountId !== selectedOrganization.initialAdminAccountId
      && account.accountType === "user_account"
      && (account.organizationId || DEFAULT_ORGANIZATION_ID) === selectedOrganization.orgId);
    const subaccountStats = {
      total: subaccounts.length,
      active: subaccounts.filter((account) => account.status === "active").length,
      invited: subaccounts.filter((account) => account.status === "invited").length,
      suspended: subaccounts.filter((account) => ["suspended", "disabled", "locked"].includes(account.status)).length,
      retired: subaccounts.filter((account) => account.status === "retired").length
    };
    return window.AIMAC_GOVERNANCE_WORKSPACE.organizationDetail({
      organization: selectedOrganization,
      initialAdmin,
      subaccountStats,
      actionsHtml: systemOrganizationActions(selectedOrganization, initialAdmin),
      helpers: {statusBadge, customBadge, fmtTime, quotaLine, panel: renderPanel}
    });
  }
  const orgRows = organizations.map((org) => row([
    `<div class="org-name"><strong>${esc(org.name)}</strong><details><summary>组织编号</summary><code>${esc(org.orgId)}</code></details></div>`,
    `<div class="org-admin"><strong>${esc(accountName(org.initialAdminAccountId))}</strong><div class="small muted">${esc(initialAdminById.get(org.initialAdminAccountId)?.email || "")}</div>
      ${initialAdminById.get(org.initialAdminAccountId)?.status ? statusBadge("account", initialAdminById.get(org.initialAdminAccountId).status) : ""}
      <details><summary>账号编号</summary><code>${esc(org.initialAdminAccountId || "-")}</code></details></div>`,
    statusBadge("organization", org.status),
    `<div class="org-quota-grid"><div><label>成员（含管理员）</label>${quotaLine(org.usage?.members, org.quotas?.maxMembers)}</div>
      <div><label>项目</label>${quotaLine(org.usage?.projects, org.quotas?.maxProjects)}</div>
      <div><label>任务组</label>${quotaLine(org.usage?.taskGroups, org.quotas?.maxTaskGroups)}</div>
      <div><label>Agent 节点</label>${quotaLine(org.usage?.agents, org.quotas?.maxAgents, org.usage?.agentsReserved)}</div></div>`,
    {v: fmtTime(org.createdAt), c: "nowrap"},
    `<div class="org-actions"><button class="primary-button" data-action="open-org-detail" data-org="${esc(org.orgId)}">查看与管理</button></div>`
  ])).join("");

  return [
    panel("组织管理总览", `
      <div class="metric-grid">
        <div class="metric"><span>组织总数</span><strong>${organizations.length}</strong></div>
        <div class="metric"><span>启用中</span><strong>${activeOrgs}</strong></div>
        <div class="metric"><span>停用 / 异常</span><strong>${suspendedOrgs}</strong></div>
        <div class="metric"><span>配额接近上限</span><strong>${quotaPressure}</strong>
          <div class="small muted">任一配额使用达到 80% 即计入</div></div>
      </div>
    `, {wide: true}),
    renderSysOrgsActionBoard({orgs: organizations, activeOrgs, suspendedOrgs, quotaPressure}),
    renderSysOrgsLifecycleGuide({orgs: organizations, activeOrgs, suspendedOrgs, quotaPressure}),
    panel("组织列表", `<div class="organization-table">` + table(["组织", "初始管理员", "状态", "配额用量", "创建时间", "操作"], orgRows,
      {emptyText: listEmptyText("组织列表")}) + "</div>", {wide: true, headerSide: filterInput("按组织名过滤…", "orgs")}),
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
        <div class="record"><div class="record-title"><strong>三级职责边界</strong></div><div class="record-meta"><span>系统管理员只负责组织、配额、启停和初始组织管理员；组织管理员负责子账户、组织级 Agent、项目与授权；组织成员在被授权的项目和任务组内工作。</span></div></div>
        <div class="record"><div class="record-title"><strong>配额强制</strong></div><div class="record-meta"><span>成员、项目、任务组、智能体创建时校验配额，超限将返回“组织配额超限”。</span></div></div>
      </div>
    `)
  ].join("");
}

/* ---------------- 系统管理员：系统设置 ---------------- */

function renderSysSettingsSummary(runtime, metrics) {
  const modelCapabilities = state.modelCapabilities || [];
  const skillSources = state.skillSources || [];
  const roleSkillCount = state.roleSkillCountBySource || {};
  const usableSkillSources = skillSources.filter((source) => source.status !== "retired"
    && Number(roleSkillCount[source.sourceId] || 0) > 0).length;
  const availableModels = modelCapabilities.filter((profile) =>
    !["unavailable", "disabled", "retired"].includes(profile.availability)).length;
  const activeOverlays = (state.roleSkillOverlays || []).filter((item) => item.status === "active").length;
  const sharedDefinitions = instructionState?.sharedDefinitions || [];
  return panel("系统设置总览", `
    <div class="metric-grid">
      ${summaryMetric("运行状态", t(runtime.status), "控制面当前运行状态")}
      ${summaryMetric("MCP 工具", runtime.mcp?.toolCount ?? "—", "集中式服务端工具数量")}
      ${summaryMetric("模型数量", modelCapabilities.length, "已登记的模型能力")}
      ${summaryMetric("可用模型", availableModels, "未被标记为不可用的模型")}
      ${summaryMetric("技能源", skillSources.length, "可同步角色 skill 的来源")}
      ${summaryMetric("可用技能源", usableSkillSources, "已经同步到角色 skill 的来源")}
      ${summaryMetric("角色叠加", activeOverlays, "项目或任务组级生效定制")}
      ${summaryMetric("共享定义", sharedDefinitions.length, "公共语义和契约归属")}
    </div>
    <div class="small muted">查看顺序：先看“技能源”和“模型能力注册”，再看“指令压缩指标”和“共享定义归属”；异常时优先处理 stale 技能源或不可用模型。</div>
  `, {wide: true});
}

function renderSysSettingsActionBoard(runtime, metrics) {
  const modelCapabilities = state.modelCapabilities || [];
  const skillSources = state.skillSources || [];
  const roleSkillCount = state.roleSkillCountBySource || {};
  const usableSkillSources = skillSources.filter((source) => source.status !== "retired"
    && Number(roleSkillCount[source.sourceId] || 0) > 0).length;
  const unavailableModels = modelCapabilities.filter((profile) =>
    ["unavailable", "disabled", "retired"].includes(profile.availability)).length;
  const activeOverlays = (state.roleSkillOverlays || []).filter((item) => item.status === "active").length;
  const sharedDefinitions = instructionState?.sharedDefinitions || [];
  const envelopeCount = (metrics.envelopes || []).length;
  return panel("系统设置操作看板", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "运行参数",
        metric: t(runtime.status),
        detail: "运行档案、自治周期、状态机和 MCP 工具数",
        panelTitle: "运行参数（只读）",
        tone: runtime.status === "active" || runtime.status === "initialized" ? "green" : "orange",
        action: "看参数"
      })}
      ${jumpModuleCard({
        title: "技能源",
        metric: `${usableSkillSources}/${skillSources.length}`,
        detail: usableSkillSources ? "可用角色 skill 来源" : "优先同步或排查 stale 来源",
        panelTitle: "技能源",
        tone: usableSkillSources ? "blue" : "orange",
        action: "看同步"
      })}
      ${jumpModuleCard({
        title: "模型能力",
        metric: `${modelCapabilities.length}`,
        detail: unavailableModels ? `${unavailableModels} 个不可用或退役` : "供应商、能力和上下文窗口",
        panelTitle: "模型能力注册（只读）",
        tone: unavailableModels ? "orange" : "blue",
        action: "看模型"
      })}
      ${jumpModuleCard({
        title: "角色叠加",
        metric: `${activeOverlays}`,
        detail: "项目/任务组级 role skill 定制追踪",
        panelTitle: "角色技能叠加（改动 agent 能力，只读）",
        tone: activeOverlays ? "orange" : "gray",
        action: "看叠加"
      })}
      ${jumpModuleCard({
        title: "指令压缩",
        metric: `${envelopeCount}`,
        detail: "稳定前缀、增量消息和缓存命中目标",
        panelTitle: "指令压缩指标",
        tone: envelopeCount ? "blue" : "gray",
        action: "看指标"
      })}
      ${jumpModuleCard({
        title: "共享定义",
        metric: `${sharedDefinitions.length}`,
        detail: "公共语义、契约归属和生产角色",
        panelTitle: "共享定义归属",
        tone: sharedDefinitions.length ? "blue" : "gray",
        action: "看归属"
      })}
    </div>
    <div class="small muted">系统设置只做全局能力查看和治理，不签发项目 agent 脚本；项目级注册仍在「项目管理」→「项目 Agent」→「注册项目节点」。</div>
  `, {wide: true});
}

function renderSysSettingsLifecycleGuide(runtime, metrics) {
  const modelCapabilities = state.modelCapabilities || [];
  const skillSources = state.skillSources || [];
  const roleSkillCount = state.roleSkillCountBySource || {};
  const usableSkillSources = skillSources.filter((source) => source.status !== "retired"
    && Number(roleSkillCount[source.sourceId] || 0) > 0).length;
  const unavailableModels = modelCapabilities.filter((profile) =>
    ["unavailable", "disabled", "retired"].includes(profile.availability)).length;
  const activeOverlays = (state.roleSkillOverlays || []).filter((item) => item.status === "active").length;
  const sharedDefinitions = instructionState?.sharedDefinitions || [];
  const envelopeCount = (metrics.envelopes || []).length;
  return panel("系统能力治理流程", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "1 运行参数",
        metric: t(runtime.status),
        detail: "先确认控制面状态、自治周期、状态机和集中 MCP 工具数",
        panelTitle: "运行参数（只读）",
        tone: runtime.status === "active" || runtime.status === "initialized" ? "green" : "orange",
        action: "看参数"
      })}
      ${jumpModuleCard({
        title: "2 技能源同步",
        metric: `${usableSkillSources}/${skillSources.length}`,
        detail: "技能源只在服务端同步，Agent 端按派发下载最小 Skill 工作集",
        panelTitle: "技能源",
        tone: usableSkillSources ? "blue" : "orange",
        action: "看技能源"
      })}
      ${jumpModuleCard({
        title: "3 模型能力",
        metric: `${modelCapabilities.length}`,
        detail: unavailableModels
          ? `${unavailableModels} 个模型不可用时任务选型会避开或阻塞`
          : "模型不可用时任务选型会避开或阻塞；这里登记供应商、能力和上下文窗口",
        panelTitle: "模型能力注册（只读）",
        tone: unavailableModels ? "orange" : "blue",
        action: "看模型"
      })}
      ${jumpModuleCard({
        title: "4 角色叠加追踪",
        metric: `${activeOverlays}`,
        detail: "系统页只追踪项目/任务组叠加，创建入口回项目设置或任务组详情",
        panelTitle: "角色技能叠加（改动 agent 能力，只读）",
        tone: activeOverlays ? "orange" : "gray",
        action: "看叠加"
      })}
      ${projectModuleCard({
        pageId: "proj-settings",
        title: "5 项目级定制",
        metric: "项目",
        detail: "仓库、规则、角色 Skill 定制和任务组覆盖回项目空间处理",
        tone: "blue",
        action: "去项目设置"
      })}
      ${projectModuleCard({
        pageId: "proj-agents",
        title: "6 Agent 注册",
        metric: "项目",
        detail: "系统设置不签发加入令牌；注册脚本只在项目 Agent 页生成",
        tone: "blue",
        action: "去注册"
      })}
      ${jumpModuleCard({
        title: "7 压缩与定义",
        metric: `${envelopeCount}/${sharedDefinitions.length}`,
        detail: "指令压缩指标和共享定义用于控制 token、缓存命中和公共语义归属",
        panelTitle: "指令压缩指标",
        tone: envelopeCount || sharedDefinitions.length ? "blue" : "gray",
        action: "看指标"
      })}
    </div>
    <div class="small muted">系统设置是全局能力治理面板：集中 MCP、模型能力、技能源和公共定义在服务端统一维护；项目执行仍回到项目设置、项目 Agent、任务组和执行监控。</div>
  `, {wide: true});
}

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
    statusBadge("skillSource", source.status) + (source.status === "stale" && source.lastSyncError
      ? `<div class="small warn-text">${esc(source.lastSyncError)}</div>` : ""),
    `<span class="mono">${esc(String(source.pinnedCommit || "").slice(0, 10))}</span>`,
    {v: String((state.roleSkillCountBySource || {})[source.sourceId] || 0), c: "num"},
    // 已退役的源不再提供同步（自治周期也不会再碰它）；未退役的多一条"退役"出口 ——
    // 接进来却拿不下去，此前只能眼看着它一遍遍重试。
    source.status === "retired"
      ? `<span class="small muted">已退役，不再同步</span>`
      : `<button class="secondary-button" data-action="sync-skill-source" data-source="${esc(source.sourceId)}">同步</button>`
        + ` <button class="secondary-button" data-action="retire-skill-source" data-source="${esc(source.sourceId)}"`
        + ` data-skills="${esc(String((state.roleSkillCountBySource || {})[source.sourceId] || 0))}">退役</button>`
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
    renderSysSettingsSummary(runtime, metrics),
    renderSysSettingsActionBoard(runtime, metrics),
    renderSysSettingsLifecycleGuide(runtime, metrics),
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
          : `<span class="warn-text">已关闭：不再产生新的派发，关闭门不会重算，人提交的指令会一直停在待处理。`
            + `但【已经排队的派发仍会被在线 agent 领走并执行】—— 认领走的是网关，与自治周期无关。`
            + `要连它们一起停，到任务组页点「暂停执行」。</span>`}</dd>
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
      + (() => {
        // 判据要问的是"有没有一个源【真的提供了】角色技能"，而不是"有没有非退役的源"。
        // 上面那条注释本来就写着两种情况——"没接过 / 全退役了"——而条件只覆盖了后一种。
        // 新部署撞的正是前一种：种子里的源是 configured（从没同步过）、角色数 0，它不算退役，
        // 于是这条提示不出现，而 agent 拿到的仍然是内置通用规则（种子里那 12 条属于 system-default，
        // 不属于这个源）。这是"缺席被当成正常"的一种：没同步过和同步坏了后果一样，提示却只认后者。
        const builtIn = (state.roleSkillCountBySource || {})["system-default"] || 0;
        const usable = (state.skillSources || []).filter((source) => source.status !== "retired"
          && ((state.roleSkillCountBySource || {})[source.sourceId] || 0) > 0);
        if (usable.length) return "";
        const neverSynced = (state.skillSources || []).filter((source) => source.status !== "retired");
        const why = neverSynced.length
          ? `已接入 ${neverSynced.length} 个技能源，但一个角色技能都还没取下来`
            + "（新部署要先点右侧的「同步」把它拉下来；同步失败时这一行会显示原因）"
          : "当前没有可用的技能源";
        // 内置技能也是 0 个时，「都在用系统内置技能（共 0 个）」是一句自相矛盾的话：此时 agent 手上没有任何角色技能。
        const fallback = builtIn
          ? `所有角色都在用系统内置技能（共 ${builtIn} 个）。派发照常进行，但 agent 拿到的是通用角色规则，不是你们自己的那一份。`
          : "而系统内置技能也是 0 个：现在没有任何角色技能可用，agent 只拿得到通用角色规则。";
        return `<div class="notice warn-notice">${esc(why)}，${esc(fallback)}</div>`;
      })()),
    // 角色技能叠加会【改掉 agent 实际拥有的能力】（含 forbiddenCapabilityAdds）。系统设置只做全局追踪；
    // 真正创建入口在项目设置和任务组详情，避免全局页误把定制打到错误项目。
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
        ? `<div class="notice">下面这些叠加正在改动 agent 实际拥有的能力。系统设置只做全局追踪；创建请到目标项目的「项目设置」或任务组详情。</div>`
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
    panel("指令信封", table(["编号", "接收角色", "缓存键", "状态", {label: "目标 Token 数", c: "num"}], envelopes, {moreText: moreText((metrics.envelopes || []).length, 12, (metrics.envelopes || []).length >= 2000)})),
    panel("共享定义归属", table(["定义", "类型", "归属角色", "生产角色", "状态"], definitions), {wide: true})
  ].join("");
}

/* ---------------- 系统管理员：账号与授权（保留既有功能） ---------------- */

// 已注销的账号：把"什么时候、为什么"贴在状态旁边。注销不可撤销，这句话是事后唯一的依据。
// artifacts_verified 这道阻塞此前只说一句"还有产物没核验"，指不出是哪一个 ——
// 而 artifacts 本来就随视图下发到了控制台，只是一处都没渲染。人被告知"等执行方补齐证据，
// 或取消对应工作项"，却不知道该盯哪个格子。这里把真正还挡着的那几条摆出来。
function stillGatingArtifact(item) {
  if (["verified", "rejected", "gc"].includes(item.status)) return false;
  return !(item.status === "registered" && item.contentDigestAttested === true);
}

function gatingArtifactRows(barrier) {
  if (!(barrier.blockingObjects || []).some((obj) => obj.gate === "artifacts_verified")) return "";
  const gating = (state.artifacts || [])
    .filter((item) => item.taskGroupId === barrier.taskGroupId && stillGatingArtifact(item));
  if (!gating.length) return "";
  return `<div class="record-meta">还挡着的产物（${gating.length} 条）：`
    + gating.slice(0, 8).map((item) => `<span class="mono">${esc(item.artifactId || "-")}</span>`
      + `${item.workItemId ? ` · ${esc(item.workItemId)}` : ""} · ${t(item.status) || esc(item.status)}`
      + `${item.contentDigestAttested === true ? "" : " · 内容摘要未核验"}`).join("；")
    + `${gating.length > 8 ? `；…共 ${gating.length} 条，此处显示前 8 条` : ""}</div>`;
}

function retiredNote(account) {
  if (account.status !== "retired" || !(account.retiredAt || account.retiredReason)) return "";
  return `<div class="record-meta">${esc(fmtTime(account.retiredAt))}`
    + `${account.retiredReason ? ` · ${esc(explainCoded(account.retiredReason))}` : ""}</div>`;
}

function summaryMetric(label, value, hint) {
  return `<div class="metric"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(hint)}</small></div>`;
}

function jumpModuleCard({title, metric, detail, panelTitle, tone = "blue", action = "查看明细"}) {
  return `
    <button class="module-card tone-${esc(tone)}" data-jump-panel="${esc(panelTitle)}">
      <span class="module-title">${esc(title)}</span>
      <strong>${esc(metric)}</strong>
      <span class="module-detail">${esc(detail)}</span>
      <span class="module-action">${esc(action)}</span>
    </button>
  `;
}

function renderSysAccountsSummary() {
  const accounts = state.accounts || [];
  const grants = state.accessGrants || [];
  const agents = state.agents || [];
  const activeAccounts = accounts.filter((account) => !["retired", "suspended", "disabled"].includes(account.status)).length;
  const serviceAccounts = accounts.filter((account) => account.accountType === "service_account" && account.status !== "retired").length;
  const activeGrants = grants.filter((grant) => grant.status === "active").length;
  const activeAgents = agents.filter((agent) => agent.status === "active").length;
  return panel("账号与授权总览", `
    <div class="metric-grid">
      ${summaryMetric("账号总数", accounts.length, "系统账号、组织成员和服务账号")}
      ${summaryMetric("启用账号", activeAccounts, "可登录或可被授权的账号")}
      ${summaryMetric("服务账号", serviceAccounts, "供 agent/runtime 服务身份使用")}
      ${summaryMetric("有效授权", activeGrants, "项目、任务组与系统资源授权")}
      ${summaryMetric("项目数", (state.projects || []).length, "可分配成员和 agent 的项目")}
      ${summaryMetric("待审加入令牌", liveJoinTokenCount(), "尚未消费且未过期的 agent 加入令牌")}
      ${summaryMetric("agent 档案", agents.length, "可被总控激活的编排角色档案")}
      ${summaryMetric("启用档案", activeAgents, "当前可参与调度的档案")}
    </div>
    <div class="small muted">先看总览确认系统账号、服务账号、跨项目授权和加入令牌规模；常规项目 Agent 注册请进入目标项目的“项目 Agent”页。</div>
  `, {wide: true});
}

function renderSysAccountsActionBoard() {
  const accounts = state.accounts || [];
  const grants = state.accessGrants || [];
  const agents = state.agents || [];
  const selectedProject = currentProject();
  const invited = accounts.filter((account) => account.status === "invited" || account.invitationWithdrawn).length;
  const activeAccounts = accounts.filter((account) => !["retired", "suspended", "disabled"].includes(account.status)).length;
  const systemAdmins = accounts.filter((account) => account.accountType === "system_admin" && account.status !== "retired").length;
  const serviceAccounts = accounts.filter((account) => account.accountType === "service_account" && account.status !== "retired").length;
  const activeGrants = grants.filter((grant) => grant.status === "active").length;
  const revokedGrants = grants.filter((grant) => grant.status !== "active").length;
  const activeAgents = agents.filter((agent) => agent.status === "active").length;
  const projects = state.projects || [];
  const assignableCount = assignableProjects().length;
  const selectedAssignableProject = selectedProject && selectedProject.status !== "archived";
  return panel("账号与授权操作看板", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "待接受邀请",
        metric: invited,
        detail: invited ? "先确认是否需要重发或撤回邀请" : "当前没有等待首次登录的账号",
        panelTitle: "账号列表",
        tone: invited ? "orange" : "green"
      })}
      ${jumpModuleCard({
        title: "启用账号",
        metric: activeAccounts,
        detail: `其中系统管理员 ${systemAdmins} 个，服务账号 ${serviceAccounts} 个`,
        panelTitle: "账号列表",
        tone: activeAccounts ? "blue" : "gray"
      })}
      ${jumpModuleCard({
        title: "有效授权",
        metric: activeGrants,
        detail: revokedGrants ? `另有 ${revokedGrants} 条已撤销或失效` : "项目、任务组与系统资源授权",
        panelTitle: "访问授权列表",
        tone: activeGrants ? "blue" : "gray"
      })}
      ${jumpModuleCard({
        title: "加入令牌审计",
        metric: liveJoinTokenCount(),
        detail: "查看跨项目待用令牌；常规注册到项目页签发",
        panelTitle: "智能体入网审计",
        tone: liveJoinTokenCount() ? "orange" : "green"
      })}
      ${jumpModuleCard({
        title: "agent 档案",
        metric: `${activeAgents}/${agents.length}`,
        detail: "总控可激活的编排角色档案",
        panelTitle: "编排智能体档案",
        tone: activeAgents ? "blue" : "gray"
      })}
      ${selectedAssignableProject ? projectModuleCard({
        pageId: "proj-members",
        title: "项目成员权限",
        metric: "当前",
        detail: `${selectedProject.name || selectedProject.id}：成员角色和任务组权限回「成员权限」处理`,
        tone: "green",
        action: "去项目授权"
      }) : assignableCount ? projectModuleCard({
        pageId: "proj-overview",
        title: "项目成员权限",
        metric: assignableCount,
        detail: selectedProject?.status === "archived"
          ? "当前项目已归档；进入「项目管理」选择其他可用项目，再回「成员权限」处理"
          : "进入「项目管理」后选择目标项目，再回「成员权限」处理",
        tone: "orange",
        action: "选项目"
      }) : jumpModuleCard({
        title: "项目成员权限",
        metric: assignableCount,
        detail: projects.length ? "现有项目已归档，需先创建新项目" : "还没有项目，需先创建项目",
        panelTitle: "创建项目（系统级）",
        tone: "gray",
        action: "建项目"
      })}
    </div>
    <div class="small muted">处理顺序：先核对账号与授权现状，再查看加入令牌审计和 agent 档案；项目成员角色、Agent 注册和任务组执行都从目标项目页发起。</div>
  `, {wide: true});
}

function renderSysAccountsBoundaryGuide() {
  const accounts = state.accounts || [];
  const grants = state.accessGrants || [];
  const agents = state.agents || [];
  const serviceAccounts = accounts.filter((account) => account.accountType === "service_account" && account.status !== "retired").length;
  const activeGrants = grants.filter((grant) => grant.status === "active").length;
  const activeAgents = agents.filter((agent) => agent.status === "active").length;
  const selectedProject = currentProject();
  return panel("账号与授权职责边界", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "系统账号",
        metric: accounts.length,
        detail: `登录身份、系统管理员和服务账号；服务账号 ${serviceAccounts} 个`,
        panelTitle: "账号列表",
        tone: accounts.length ? "blue" : "gray",
        action: "看账号"
      })}
      ${jumpModuleCard({
        title: "授权审计",
        metric: activeGrants,
        detail: "项目、任务组与系统资源授权在这里审计和撤销",
        panelTitle: "访问授权列表",
        tone: activeGrants ? "blue" : "gray",
        action: "看授权"
      })}
      ${selectedProject ? projectModuleCard({
        pageId: "proj-agents",
        title: "项目 Agent 注册",
        metric: "项目页",
        detail: "进入后先在侧栏确认目标项目，再到「项目管理」→「项目 Agent」→「注册项目节点」签发",
        tone: "green",
        action: "确认后注册"
      }) : jumpModuleCard({
        title: "项目 Agent 注册",
        metric: "先选项目",
        detail: "先创建或选择目标项目，再到「项目管理」→「项目 Agent」→「注册项目节点」签发",
        panelTitle: "创建项目（系统级）",
        tone: "orange",
        action: "建项目"
      })}
      ${jumpModuleCard({
        title: "Agent 档案",
        metric: `${activeAgents}/${agents.length}`,
        detail: "这里只维护总控可激活的角色档案，不替代项目注册",
        panelTitle: "编排智能体档案",
        tone: activeAgents ? "blue" : "gray",
        action: "看档案"
      })}
    </div>
    <div class="small muted">职责边界：系统页负责账号、服务账号、全局授权审计、加入令牌审计和 Agent 档案；项目页负责项目级节点、一次性加入令牌、注册脚本和远程 MCP 生效确认。</div>
  `, {wide: true});
}

function renderSysAccountsLifecycleGuide() {
  const accounts = state.accounts || [];
  const grants = state.accessGrants || [];
  const agents = state.agents || [];
  const selectedProject = currentProject();
  const projects = state.projects || [];
  const assignableCount = assignableProjects().length;
  const selectedAssignableProject = selectedProject && selectedProject.status !== "archived";
  const serviceAccounts = accounts.filter((account) => account.accountType === "service_account" && account.status !== "retired").length;
  const activeGrants = grants.filter((grant) => grant.status === "active").length;
  const activeAgents = agents.filter((agent) => agent.status === "active").length;
  const invited = accounts.filter((account) => account.status === "invited" || account.invitationWithdrawn).length;
  return panel("账号授权处置流程", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "1 账号身份",
        metric: accounts.length,
        detail: invited ? `先处理 ${invited} 个待接受或已撤回邀请` : "先确认系统管理员、组织成员和服务账号身份",
        panelTitle: "账号列表",
        tone: invited ? "orange" : "blue",
        action: "看账号"
      })}
      ${jumpModuleCard({
        title: "2 访问授权",
        metric: activeGrants,
        detail: "项目、任务组和系统资源授权先审计，必要时再撤销或补发",
        panelTitle: "访问授权列表",
        tone: activeGrants ? "blue" : "gray",
        action: "看授权"
      })}
      ${jumpModuleCard({
        title: "3 服务账号",
        metric: serviceAccounts,
        detail: "服务账号只用于系统和 agent runtime 服务身份，不作为真人管理入口",
        panelTitle: "账号列表",
        tone: serviceAccounts ? "blue" : "gray",
        action: "看服务账号"
      })}
      ${jumpModuleCard({
        title: "4 加入令牌审计",
        metric: liveJoinTokenCount(),
        detail: "这里只看跨项目待用令牌和撤销，项目加入令牌到项目 Agent 页签发",
        panelTitle: "智能体入网审计",
        tone: liveJoinTokenCount() ? "orange" : "green",
        action: "看审计"
      })}
      ${jumpModuleCard({
        title: "5 Agent 档案",
        metric: `${activeAgents}/${agents.length}`,
        detail: "编排角色档案决定总控可激活的角色，不等于某台 agent 节点已注册",
        panelTitle: "编排智能体档案",
        tone: activeAgents ? "blue" : "gray",
        action: "看档案"
      })}
      ${selectedAssignableProject ? projectModuleCard({
        pageId: "proj-members",
        title: "6 项目级落位",
        metric: "当前",
        detail: `${selectedProject.name || selectedProject.id}：进入「成员权限」完成成员角色，再去项目 Agent 和任务组执行`,
        tone: "green",
        action: "去授权"
      }) : assignableCount ? projectModuleCard({
        pageId: "proj-overview",
        title: "6 项目级落位",
        metric: assignableCount,
        detail: selectedProject?.status === "archived"
          ? "当前项目已归档；先进入项目管理选择其他可用项目，再到「成员权限」处理"
          : "先进入项目管理选择目标项目，再到项目「成员权限」处理",
        tone: "orange",
        action: "选项目"
      }) : jumpModuleCard({
        title: "6 项目级落位",
        metric: assignableCount,
        detail: projects.length ? "现有项目已归档；先创建新项目，再到项目「成员权限」处理" : "系统页不做项目成员授权；先创建项目，再到项目「成员权限」处理",
        panelTitle: "创建项目（系统级）",
        tone: "gray",
        action: "建项目"
      })}
    </div>
    <div class="small muted">账号授权页是系统身份和授权治理入口：先确认账号，再审计授权和令牌；真正让用户或 agent 参与某个项目，必须回到项目管理完成成员权限、Agent 注册和任务组执行。</div>
  `, {wide: true});
}

function renderSysAccounts() {
  const accounts = (state.accounts || []).map((account) => row([
    esc(account.displayName),
    esc(account.email),
    badge(account.accountType),
    // 注销不可撤销，而"为什么注销、什么时候注销的"此前落在 retiredAt/retiredReason 上、
    // 全仓没有任何读取点：屏幕上只有一个「已注销」，事后追不到依据。
    `${statusBadge("account", account.status)}${retiredNote(account)}`,
    esc((account.roles || []).map((role) => t(role)).join("、"))
  ])).join("");
  const grants = (state.accessGrants || []).map((grant) => row([
    `<span class="mono">${esc(grant.subjectRef?.subjectId || "-")}</span>`,
    resourceScopeLabel(grant.resource),
    esc(grantRoleLabel(grant.role)),
    statusBadge("grant", grant.status),
    esc((grant.permissions || []).map(permLabel).join("、")),
    grant.status === "active" ? `<button class="danger-button" data-action="revoke-grant" data-grant="${esc(grant.grantId)}">撤销</button>` : "-"
  ])).join("");
  const agents = (state.agents || []).map((agent) => row([
    esc(agent.name),
    esc(t(agent.role)),
    agentModelCell(agent.model),
    statusBadge("agent", agent.status),
    `<button class="secondary-button" data-action="toggle-agent" data-agent="${esc(agent.id)}">${agent.status === "active" ? "停用" : "启用"}</button>`
  ])).join("");

  return [
    renderSysAccountsSummary(),
    renderSysAccountsActionBoard(),
    renderSysAccountsBoundaryGuide(),
    renderSysAccountsLifecycleGuide(),
    panel("账号列表", table(["账号", "邮箱", "类型", "状态", "角色"], accounts), {wide: true}),
    panel("访问授权列表", table(["主体", "资源", "角色", "状态", "权限", "操作"], grants), {wide: true}),
    panel("智能体入网审计", renderJoinTokenSection({auditOnly: true, context: "system"}), {wide: true}),
    panel("编排智能体档案", table(["名称", "角色", "模型策略", "状态", "操作"], agents) + `
      <form class="form-grid" data-form="agent-create" style="margin-top:12px;">
        <div class="form-row-inline">
          <div class="form-row"><label>名称</label><input name="name" required></div>
          <div class="form-row"><label>角色（只认已登记的执行角色）</label><input name="role" value="reviewer" required list="agent-role-options">
            <datalist id="agent-role-options">${WORK_ITEM_OWNER_ROLE_CHOICES.map((roleId) => `<option value="${esc(roleId)}">${esc(t(roleId))}</option>`).join("")}</datalist></div>
          <div class="form-row"><label>模型策略</label>
            <select name="model"><option value="auto_best">自动最优</option><option value="auto_fast">自动快速</option><option value="cost_aware">成本优先</option></select>
          </div>
        </div>
        <button class="primary-button" type="submit">创建档案</button>
      </form>
    `, {wide: true}),
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
        <div class="form-row"><label>角色（逗号分隔；只认服务端词表里的：${esc((state.runtime?.accountRoles || []).map((role) => t(role)).join("、") || "词表未下发")}）</label>
          <input name="roles" value="viewer" list="account-role-options">
          <datalist id="account-role-options">${(state.runtime?.accountRoles || []).map((role) => `<option value="${esc(role)}">${esc(t(role))}</option>`).join("")}</datalist></div>
        <div class="form-row"><label>默认权限（逗号分隔；只认服务端词表里的）</label><input name="permissions" value="project:view" list="known-permission-options"><datalist id="known-permission-options">${(state.runtime?.knownPermissions || []).map((permission) => `<option value="${esc(permission)}">${esc(permLabel(permission))}</option>`).join("")}</datalist></div>
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
        <div class="form-row"><label>角色（权限模板；只认服务端词表里的）</label><input name="role" value="viewer" list="grant-role-options"><datalist id="grant-role-options">${[...new Set(Object.values(state.runtime?.grantRoleTemplates || {}).flat())].map((role) => `<option value="${esc(role)}">${esc(t(role))}</option>`).join("")}</datalist></div>
        <div class="form-row"><label>权限（逗号分隔；只认服务端词表里的）</label><input name="permissions" value="project:view" list="known-permission-options"><datalist id="known-permission-options">${(state.runtime?.knownPermissions || []).map((permission) => `<option value="${esc(permission)}">${esc(permLabel(permission))}</option>`).join("")}</datalist></div>
        <button class="primary-button" type="submit">新增授权</button>
      </form>
    `),
    panel("创建项目（系统级）", `
      <form class="form-grid" data-form="project-create">
        <div class="form-row"><label>项目名称</label><input name="name" required></div>
        <div class="form-row"><label>项目负责人</label>
          <select name="ownerAccountId">
            ${(state.accounts || []).filter((account) => account.status !== "retired")
              .map((account) => `<option value="${esc(account.accountId)}">${esc(account.displayName)}</option>`).join("")}
          </select>
        </div>
        <button class="primary-button" type="submit">创建项目</button>
      </form>
    `)
  ].join("");
}

// 一个项目都没有时，这两张表单的「项目」下拉是空的 —— 表单看着完整、点下去必然失败。
// 回归背景：全新组织曾经把加入令牌和项目成员授权渲染成可提交表单，项目下拉却是 0 个选项。
// 与其让人填完再撞一个错误，不如当场说清第一步是什么。
function noProjectYetNotice(what) {
  return `<div class="notice">还没有任何项目，而${what}必须落在具体项目上。`
    + "先创建一个项目：组织管理员切到「组织管理」→「项目列表」创建项目；系统管理员先在「系统管理」→「组织管理」开通组织并交付初始组织管理员，由组织管理员创建项目。创建后再进入「项目管理」→「成员权限」授权。</div>";
}

let memberGrantProjectId = "";
let memberGrantAccountId = "";

function renderProjectMemberForm(options = {}) {
  if (!(state.projects || []).length) return noProjectYetNotice("项目成员授权");
  // 已归档的项目不能再发成员授权（后端拒 project_archived）。这里原先列的是【全部项目】——
  // 与上面 assignableProjects 那段注释说的是同一件事，而它点名的两处之外还漏了这第三处：
  // 选中一个归档项目提交，回执是 409，人只看到一个按不动的杠杆。
  const scopedProjectId = options.projectId || "";
  const openProjects = scopedProjectId
    ? assignableProjects().filter((project) => project.id === scopedProjectId)
    : assignableProjects();
  if (!openProjects.length) {
    const scopedProject = scopedProjectId ? (state.projects || []).find((project) => project.id === scopedProjectId) : null;
    return `<div class="notice warn-notice">${scopedProject
      ? `当前项目「${esc(scopedProject.name || scopedProject.id)}」已归档：归档是终态、不可撤销，发不进成员授权。要继续这条线，请另建一个项目。`
      : `你能看到的项目【全部已归档】（共 ${esc((state.projects || []).length)} 个）：归档是终态、不可撤销，发不进成员授权。要继续这条线，请先新建一个项目。`}</div>`;
  }
  // 账号下拉此前列的是【全部账号】。而服务端对项目成员授权是无条件按组织判的
  //（cross_org_member_not_allowed，系统管理员也一样）—— 于是别的组织的人就摆在那里，
  // 选中提交必然被拒：一个按不动的杠杆。按【所选项目所属的组织】过滤，口径与服务端同一份。
  const projects = openProjects;
  const chosen = scopedProjectId
    ? projects[0]
    : projects.find((project) => project.id === memberGrantProjectId) || projects[0];
  const selectedOrg = organizationOf(chosen);
  const candidates = (orgMembers && orgMembers.length ? orgMembers : (state.accounts || []));
  // 已注销是终态：给它发授权后端会拒（grant_subject_account_retired），摆在这里就是把人往死路上引。
  const grantable = candidates.filter((account) => organizationOf(account) === selectedOrg
    && account.status !== "retired" && account.accountId !== chosen.ownerAccountId);
  const elsewhere = candidates.length - grantable.length;
  return `
    ${grantable.length ? "" : `<div class="notice warn-notice">「${esc(chosen?.name || chosen?.id || "")}」`
      + `所属的组织下还没有可授权的账号${elsewhere ? `（另有 ${elsewhere} 个账号属于别的组织，授不进来）` : ""}`
      + " —— 先到「组织管理」→「成员管理」邀请账号，把人邀进这个组织，再回来授权。</div>"}
    <form class="form-grid" data-form="project-member">
      <div class="form-row"><label>项目</label>
        ${scopedProjectId
          ? `<input type="hidden" name="projectId" value="${esc(chosen?.id || scopedProjectId)}"><strong>${esc(chosen?.name || scopedProjectId)}</strong>`
          : `<select name="projectId">${projects.map((project) =>
            `<option value="${esc(project.id)}"${project.id === chosen?.id ? " selected" : ""}>${esc(project.name || project.id)}</option>`).join("")}</select>`}
      </div>
      <div class="form-row"><label>账号</label>
        ${decisionSelect("accountId",
          grantable.map((account) => [account.accountId, account.displayName || account.accountId]),
          "请选择授权对象…", {selected: memberGrantAccountId})}
      </div>
      <div class="form-row"><label>项目角色</label>
        ${/* 默认停在 project_owner 上：不读就提交，等于把最高权限授予名单里排第一的人。
              授权对象与角色两个下拉都必须显式选择 —— 少了任一个，误授都能一次点击完成。 */ ""}
        ${/* 项目负责人是创建者且不可由普通授权改写；项目管理员是可分配角色。
              两者当前权限模板一致，但对象语义不同，所以这里只提供可分配的项目管理员。 */ ""}
        ${decisionSelect("role", [
          ["project_admin", "项目管理员"],
          ["task_group_owner", "任务组负责人"],
          ["reviewer", `${GRANT_ROLE_LABELS.reviewer}（可做人工定稿/验收）`],
          ["agent_operator", "智能体操作员"],
          ["viewer", "观察者"]
        ], "请选择项目角色…")}
      </div>
      <button class="primary-button" type="submit">授权</button>
    </form>
  `;
}

function taskGroupGrantCandidates(project) {
  const projectOrg = organizationOf(project);
  const candidates = (orgMembers && orgMembers.length ? orgMembers : (state.accounts || []));
  return candidates.filter((account) => organizationOf(account) === projectOrg && account.status !== "retired");
}

function renderTaskGroupGrantForm(project, options = {}) {
  const groups = (state.taskGroups || []).filter((taskGroup) => taskGroup.projectId === project.id);
  const candidates = taskGroupGrantCandidates(project);
  const fixedAccount = options.accountId ? candidates.find((account) => account.accountId === options.accountId) : null;
  if (!groups.length) {
    return `<div class="notice">当前项目还没有任务组。先到“任务组”页创建任务组，再按具体任务组授予控制、审核或监控权限。</div>`;
  }
  if (!candidates.length) {
    return `<div class="notice warn-notice">当前组织下没有可授权账号。先到“组织管理”→“成员管理”创建子账户，再回到这里按任务组授权。</div>`;
  }
  return `
    <form class="form-grid" data-form="grant-create" data-refresh-project-members="1">
      <input type="hidden" name="resourceType" value="task_group">
      <input type="hidden" name="replaceExisting" value="true">
      <div class="form-row-inline">
        <div class="form-row"><label>任务组</label>${decisionSelect("resourceId",
          groups.map((taskGroup) => [taskGroup.id, taskGroup.name || taskGroup.id]), "请选择任务组…")}</div>
        <div class="form-row"><label>账号</label>${fixedAccount
          ? `<input type="hidden" name="subjectId" value="${esc(fixedAccount.accountId)}"><strong>${esc(fixedAccount.displayName || fixedAccount.email || fixedAccount.accountId)}</strong>`
          : decisionSelect("subjectId", candidates.map((account) => [account.accountId, account.displayName || account.email || account.accountId]), "请选择账号…", {selected: memberGrantAccountId})}</div>
        <div class="form-row"><label>任务组角色</label>${decisionSelect("role", [
          ["task_group_owner", "任务组负责人（控制任务组与工作项）"],
          ["reviewer", "评审人（人工定稿 / 验收）"],
          ["agent_operator", "智能体操作员（监控与节点协同）"],
          ["viewer", "观察者（只读查看）"]
        ], "请选择任务组角色…")}</div>
      </div>
      <div class="notice">同一账号在同一任务组只保留一个角色；再次提交会撤销其当前角色并替换为新角色。任务组授权不会扩大到同项目其它任务组，项目级角色在“项目成员”栏目维护。</div>
      <button class="primary-button" type="submit">授予任务组权限</button>
    </form>
  `;
}

function renderTaskGroupGrantList(project) {
  const groupIds = new Set((state.taskGroups || []).filter((taskGroup) => taskGroup.projectId === project.id).map((taskGroup) => taskGroup.id));
  const grants = (state.accessGrants || []).filter((grant) =>
    grant.status === "active" && grant.resource?.resourceType === "task_group" && groupIds.has(grant.resource.resourceId));
  const rows = grants.map((grant) => row([
    esc(taskGroupNameOf(grant.resource.resourceId)),
    `<strong>${esc(accountName(grant.subjectRef?.subjectId))}</strong><div class="small muted mono">${esc(grant.subjectRef?.subjectId || "-")}</div>`,
    esc(grantRoleLabel(grant.role)),
    esc((grant.permissions || []).map((permission) => permLabel(permission)).join("、")),
    {v: fmtTime(grant.createdAt), c: "nowrap"},
    hasPerm("project:grant")
      ? `<button class="danger-button" data-action="revoke-grant" data-grant="${esc(grant.grantId)}">撤销</button>`
      : "-"
  ])).join("");
  return table(["任务组", "账号", "角色", "权限", {label: "授权时间", c: "nowrap"}, "操作"], rows,
    {emptyText: "当前项目还没有任务组级授权。项目成员可以先有项目角色，真正的任务组控制和审核建议按任务组细分。"});
}

function projectMembershipsForAccount(accountId) {
  return (state.projects || []).flatMap((project) => (project.members || [])
    .filter((member) => member.accountId === accountId)
    .map((member) => ({project, role: member.role})));
}

function taskGroupGrantsForAccount(accountId, projectId = "") {
  const groupIds = new Set((state.taskGroups || [])
    .filter((taskGroup) => !projectId || taskGroup.projectId === projectId)
    .map((taskGroup) => taskGroup.id));
  return (state.accessGrants || []).filter((grant) =>
    grant.status === "active"
    && grant.subjectRef?.subjectType === "account"
    && grant.subjectRef?.subjectId === accountId
    && grant.resource?.resourceType === "task_group"
    && groupIds.has(grant.resource.resourceId));
}

function renderOrgMemberScopeMatrix(members) {
  const selected = members.find((account) => account.accountId === memberGrantAccountId);
  const projects = assignableProjects().filter((project) => !selected || organizationOf(project) === organizationOf(selected));
  const chosen = projects.find((project) => project.id === memberGrantProjectId) || projects[0];
  const focus = selected ? `<div class="member-grant-focus"><strong>${esc(selected.displayName || selected.email)}</strong>
    <button class="secondary-button" data-action="clear-member-grants">全部成员</button></div>
    ${chosen && selected.status !== "retired" ? `<div class="member-grant-focus"><label for="member-grant-project">授权项目</label><select id="member-grant-project" data-member-grant-project>${projects.map((project) => `<option value="${esc(project.id)}"${project.id === chosen.id ? " selected" : ""}>${esc(project.name || project.id)}</option>`).join("")}</select>
      ${window.AIMAC_OBJECT_WORKSPACE.projectLink(chosen, "分配项目角色", {page: "proj-members", workspace: "list", accountId: selected.accountId})}
      ${window.AIMAC_OBJECT_WORKSPACE.projectLink(chosen, "分配任务组角色", {page: "proj-members", workspace: "groups", accountId: selected.accountId})}</div>` : ""}` : "";
  const rows = (selected ? [selected] : members).map((account) => {
    const projectMemberships = projectMembershipsForAccount(account.accountId);
    const taskGroupGrants = taskGroupGrantsForAccount(account.accountId);
    return row([
      `<strong>${esc(account.displayName || account.accountId)}</strong><div class="small muted mono">${esc(account.accountId)}</div>`,
      `${statusBadge("account", account.status)}${retiredNote(account)}`,
      esc((account.permissions || []).map((permission) => permLabel(permission)).join("、") || "无额外账号能力"),
      projectMemberships.length
        ? projectMemberships.map(({project, role}) => `${esc(project.name || project.id)}：${esc(grantRoleLabel(role))}`).join("<br>")
        : `<span class="muted">未分配项目</span>`,
      taskGroupGrants.length
        ? taskGroupGrants.map((grant) => `${esc(taskGroupNameOf(grant.resource.resourceId))}：${esc(grantRoleLabel(grant.role))}`).join("<br>")
        : `<span class="muted">未分配任务组角色</span>`,
      selected ? "-" : `<button class="secondary-button" data-action="member-grants" data-account="${esc(account.accountId)}">管理授权</button>`
    ]);
  }).join("");
  return panel("子账户项目 / 任务组权限矩阵", `
    ${focus}
    ${table(["成员", "状态", "账号能力", "项目角色", "任务组角色", "授权入口"], rows,
      {emptyText: listEmptyText("成员权限矩阵")})}
  `, {wide: true, headerSide: filterInput("按成员、项目、任务组过滤…", "member-scope-matrix")});
}

function renderJoinTokenSection(options = {}) {
  const scopedProjectId = options.projectId || "";
  const auditOnly = Boolean(options.auditOnly);
  const scopedProjects = scopedProjectId
    ? joinTokenTargetProjects().filter((project) => project.id === scopedProjectId)
    : joinTokenTargetProjects();
  const scopedTokens = (state.agentJoinTokens || [])
    .filter((token) => !scopedProjectId || token.projectId === scopedProjectId);
  const auditContext = options.context === "system" ? "system" : "org";
  const auditNotice = auditContext === "system"
    ? "系统页只做跨项目令牌审计和撤销。常规注册请进入目标项目的「项目管理」→「项目 Agent」→「注册项目节点」签发一次性令牌，并复制服务端安装脚本。"
    : "此栏目查看组织范围加入令牌与撤销记录。共享节点在组织“注册共享节点”接入；项目专属节点进入对应项目“注册项目节点”接入。";
  const tokens = scopedTokens.slice(0, 20).map((token) => {
    // 令牌过期只在【兑换时】才被标 expired（没人兑换就永停在 issued）。列表若按原始 status 显示，
    // 一张已过期的令牌会显示成「已签发」还带「撤销」按钮 —— 人以为它还在等 agent 来接，实际兑换必被拒。
    // 按【服务器时钟】(serverNow，抗本机时钟偏移，与过期时间同源) 派生显示状态，与占位统计同口径。
    const displayStatus = (token.status === "issued" && token.expiresAt
      && new Date(token.expiresAt).getTime() <= serverNow()) ? "expired" : token.status;
    return row([
      `<span class="mono">${esc(token.joinTokenId)}</span>`,
      esc(token.registrationScope === "organization" ? "组织共享" : projectNameOf(token.projectId)),
      esc((token.allowedRoles || []).join("、")),
      statusBadge("joinToken", displayStatus),
      {v: `${token.useCount ?? 0}/${token.maxUses ?? 1}`, c: "num"},
      {v: fmtTime(token.expiresAt), c: "nowrap"},
      displayStatus === "issued" ? `<button class="danger-button" data-action="revoke-join-token" data-token-id="${esc(token.joinTokenId)}">撤销</button>` : "-"
    ]);
  }).join("");
  if (!(state.projects || []).length && !scopedTokens.length) {
    return auditOnly
      ? `<div class="notice warn-notice">${auditNotice} 当前还没有任何项目，所以也没有可审计的 agent 加入令牌。</div>`
      : noProjectYetNotice("智能体加入令牌");
  }
  if (!scopedProjects.length && !auditOnly) {
    return `<div class="notice warn-notice">${scopedProjectId
      ? "当前项目不可签发智能体加入令牌：项目可能已归档，或当前账号没有这个项目的管理权限。"
      : "你能看到的项目里没有可签发智能体加入令牌的目标。"}`
      + "归档项目不能再接入新节点；需要继续执行时，请先创建或切换到一个未归档项目。</div>";
  }
  if (auditOnly) {
    return `
      <div class="stack">
        <div class="notice">${auditNotice}</div>
        ${table(["令牌", "项目", "角色范围", "状态", {label: "已用次数", c: "num"}, {label: "过期时间", c: "nowrap"}, "操作"], tokens, {moreText: moreText(scopedTokens.length, 20, "agentJoinTokens")})}
      </div>
    `;
  }
  const selectedProject = scopedProjects.find((project) => project.id === currentProjectId) || scopedProjects[0];
  const projectField = scopedProjectId
    ? `<input type="hidden" name="projectId" value="${esc(scopedProjectId)}">
       <div class="record-meta"><span>当前项目：${esc(projectNameOf(scopedProjectId))}</span></div>`
    : `<div class="form-row"><label>目标项目</label>
        <select name="projectId">${scopedProjects.map((project) => `<option value="${esc(project.id)}" ${project.id === selectedProject?.id ? "selected" : ""}>${esc(project.name || project.id)}</option>`).join("")}</select>
      </div>`;
  const liveIssued = scopedTokens.filter((token) =>
    token.status === "issued" && (!token.expiresAt || new Date(token.expiresAt).getTime() > serverNow())).length;
  const installNotice = liveIssued
    ? `<div class="notice warn-notice">当前有 ${esc(liveIssued)} 张待用加入令牌。安装命令和明文加入令牌只在签发成功弹窗里显示一次；列表不能还原明文加入令牌。如果弹窗已关闭且命令没有被目标 agent 使用，请撤销旧令牌后重新签发。</div>`
    : `<div class="notice">签发成功后会弹出一次性安装命令；关闭弹窗后列表只保留脱敏令牌记录、状态和撤销入口，不能还原明文加入令牌。</div>`;
  return `
    <div class="stack">
      ${options.context === "project"
        ? `<div class="notice">agent 节点通过一次性加入令牌注册到当前项目。服务端集中托管 MCP 与技能同步，agent 端只运行注册脚本和执行器。</div>`
        : ""}
      <form class="form-grid" data-form="join-token">
        <div class="form-row-inline">
          ${projectField}
          <div class="form-row"><label>节点名（可留空）</label><input name="nodeName" placeholder="自动生成"></div>
          <div class="form-row"><label>角色范围（逗号分隔；只认已登记的执行角色，* 表示不限）</label><input name="allowedRoles" value="agent-runtime" list="join-token-role-options">
            <datalist id="join-token-role-options"><option value="*">不限</option>${WORK_ITEM_OWNER_ROLE_CHOICES.map((roleId) => `<option value="${esc(roleId)}">${esc(t(roleId))}</option>`).join("")}</datalist></div>
          <div class="form-row"><label>有效期（秒）</label><input name="ttlSeconds" type="number" min="60" max="86400" value="1800"></div>
        </div>
        <button class="primary-button" type="submit">签发一次性加入令牌</button>
      </form>
      ${installNotice}
      ${table(["令牌", "项目", "角色范围", "状态", {label: "已用次数", c: "num"}, {label: "过期时间", c: "nowrap"}, "操作"], tokens, {moreText: moreText(scopedTokens.length, 20, "agentJoinTokens")})}
    </div>
  `;
}

function projectNameOf(projectId) {
  return (state.projects || []).find((project) => project.id === projectId)?.name || projectId || "-";
}

function renderOrgNodeRegistration() {
  const organizationId = currentAccount?.organizationId;
  if (!organizationId || currentAccount.accountType !== "org_admin") return `<div class="notice">组织共享节点由组织管理员注册。</div>`;
  return `<div class="stack"><div class="notice">共享节点可承接本组织当前及以后创建的有效项目；项目专属节点仍在项目内注册。MCP 和技能同步由服务端统一提供。</div>
    <form class="form-grid" data-form="join-token">
      <input type="hidden" name="registrationScope" value="organization"><input type="hidden" name="organizationId" value="${esc(organizationId)}">
      <div class="form-row"><label>共享节点名称</label><input name="nodeName" placeholder="例如：研发公共执行节点"></div>
      <div class="form-row"><label>执行角色范围</label><input name="allowedRoles" value="*" list="org-node-role-options"><datalist id="org-node-role-options"><option value="*">本组织全部机器执行角色</option>${WORK_ITEM_OWNER_ROLE_CHOICES.map((roleId) => `<option value="${esc(roleId)}">${esc(t(roleId))}</option>`).join("")}</datalist></div>
      <div class="form-row"><label>加入令牌有效期（秒）</label><input name="ttlSeconds" type="number" min="60" max="86400" value="1800"></div>
      <button class="primary-button" type="submit">生成共享节点注册命令</button>
    </form></div>`;
}

/* ---------------- 组织管理员：组织概览 ---------------- */

function renderOrgOverview() {
  // 按【当前账号自己的组织】取，不要拿数组第一个：今天服务端只给组织管理员下发它自己那一个
  // （scopedStateForAccount 过滤过），所以 [0] 碰巧总是对的 —— 而"碰巧对"意味着服务端哪天
  // 多下发一个组织（例如系统管理员视角、或将来支持跨组织视图），这一页就会把【别人组织的
  // 配额用量】当成自己的显示出来，而不会有任何东西报错。判据与服务端同一个口径：organizationId。
  const org = (state.organizations || []).find((item) => item.orgId === currentAccount?.organizationId)
    || (state.organizations || [])[0] || null;
  const projects = state.projects || [];
  const openTaskGroups = (state.taskGroups || []).filter((taskGroup) => !settledTaskGroupStatuses.has(taskGroup.status));
  const activeProjects = projects.filter((project) => project.status !== "archived");
  const memberCount = org?.usage?.members ?? (orgMembers || []).filter((account) => account.accountType !== "service_account"
    && !["retired", "disabled", "suspended"].includes(account.status)).length;
  const aliveNodes = (orgAgentNodes || []).filter((node) => node.status !== "revoked");
  const onlineNodes = aliveNodes.filter((node) => node.status === "online").length;
  const quotaPanel = org
    ? panel(`配额用量 · ${esc(org.name)}`, `
        <div class="stack">
          <div><div class="small muted">成员</div>${quotaLine(org.usage?.members, org.quotas?.maxMembers)}</div>
          <div><div class="small muted">项目</div>${quotaLine(org.usage?.projects, org.quotas?.maxProjects)}</div>
          <div><div class="small muted">任务组</div>${quotaLine(org.usage?.taskGroups, org.quotas?.maxTaskGroups)}</div>
          <div><div class="small muted">Agent 节点</div>${quotaLine(org.usage?.agents, org.quotas?.maxAgents, org.usage?.agentsReserved)}${(() => {
            // 配额只数没被吊销的，而智能体那张表把已吊销的也列着 —— 不说清楚，人会拿表里的行数
            // 去对这个数字，对不上又找不出原因。只在确实有已吊销节点时才出现这一句。
            const revoked = (orgAgentNodes || []).filter((node) => node.status === "revoked").length;
            return revoked ? `<div class="small muted">另有 ${revoked} 个已吊销，不计入配额</div>` : "";
          })()}</div>
          <div class="record-meta"><span>组织状态：${statusBadge("organization", org.status)}</span><span>创建时间：${fmtTime(org.createdAt)}</span></div>
        </div>
      `)
    : panel("配额用量", `<div class="notice">未找到当前账号归属的组织记录。</div>`);
  const projectRows = projects.map((project) => row([
    `<strong>${esc(project.name)}</strong><div class="small muted mono">${esc(project.id)}</div>`,
    badge(project.status),
    progressLine(project.progress?.percent),
    badge(project.progress?.phase),
    badge(project.progress?.health),
    `<div class="button-row">
      <button class="secondary-button" data-action="open-project-page" data-project="${esc(project.id)}" data-target-menu="proj-overview">进入项目</button>
      <button class="secondary-button" data-action="open-project-page" data-project="${esc(project.id)}" data-target-menu="org-projects">项目授权</button>
    </div>`
  ])).join("");
  const actionPath = panel("组织操作路径", `
    <div class="module-grid action-grid">
      ${projectModuleCard({
        pageId: "org-members",
        title: "1 成员与权限",
        metric: `${memberCount}`,
        detail: "先确认谁能管理项目、授权和任务组",
        action: "管理成员",
        tone: memberCount ? "blue" : "orange"
      })}
      ${projectModuleCard({
        pageId: "org-agents",
        title: "2 agent 节点",
        metric: aliveNodes.length ? `${onlineNodes}/${aliveNodes.length}` : "无节点",
        detail: aliveNodes.length ? "查看在线率、自检、加入令牌和吊销" : "组织注册共享节点，项目注册专属节点",
        action: "管理节点",
        tone: onlineNodes ? "green" : "orange"
      })}
      ${projectModuleCard({
        pageId: "org-projects",
        title: "3 项目与授权",
        metric: `${activeProjects.length}/${projects.length}`,
        detail: "创建项目、归档项目、给成员分配项目权限",
        action: "管理项目",
        tone: activeProjects.length ? "blue" : "gray"
      })}
      ${projectModuleCard({
        pageId: "proj-overview",
        title: "4 项目执行",
        metric: `${openTaskGroups.length}`,
        detail: "进入当前项目处理任务组、监控、审核和指令",
        action: "进入项目",
        tone: projects.length ? "blue" : "gray"
      })}
    </div>
    <div class="small muted">推荐顺序：先把成员权限和 agent 节点准备好，再创建项目并授权；进入项目空间后由总控自动拆分、派发和监控任务。</div>
  `, {wide: true});

  return [
    renderOrgManagementHub(org, projects, openTaskGroups),
    actionPath,
    quotaPanel,
    panel("组织运行统计", `
      <div class="metric-grid">
        <div class="metric"><span>项目总数</span><strong>${projects.length}${countSuffix("projects")}</strong>${(() => {
          // 这一格数的是全部项目，而同一屏上那格配额排除了已归档的 —— 两个数并排却不同口径，
          // 人只能以为其中一个错了。与上面"已吊销节点"同一处理：只在真有已归档项目时说一句。
          const archived = projects.filter((project) => project.status === "archived").length;
          return archived ? `<div class="small muted">另有 ${archived} 个已归档，不计入配额</div>` : "";
        })()}</div>
        <div class="metric"><span>进行中的任务组</span><strong>${openTaskGroups.length}${countSuffix("taskGroups")}</strong></div>
        <div class="metric"><span>在线 agent 节点</span><strong>${(() => {
          // 分母原先是"表里所有行"，把已吊销的也算了进去 —— 同一屏上配额那格明说了
          // "已吊销不计入配额"，两个分母各算各的，人对不上。已吊销的节点不再参与任何事，
          // 它不该出现在"在线 X/Y"的 Y 里。
          const alive = (orgAgentNodes || []).filter((node) => node.status !== "revoked");
          return `${alive.filter((node) => node.status === "online").length}/${alive.length}`;
        })()}</strong></div>
        <div class="metric"><span>受阻项</span><strong>${(state.taskGroups || []).flatMap((taskGroup) => taskGroup.blockers || []).length}</strong></div>
      </div>
    `),
    panel("项目一览", table(["项目", "状态", "进度", "阶段", "健康度", "操作"], projectRows), {wide: true})
  ].join("");
}

/* ---------------- 组织管理员：成员管理 ---------------- */

function permLabel(code) {
  return PERMISSION_LABELS[String(code || "")] || t(code);
}
function resourceScopeLabel(resource) {
  const type = resource?.resourceType;
  const typeLabel = RESOURCE_TYPE_LABELS[type] || (type || "-");
  return `${esc(typeLabel)}：<span class="mono">${esc(resource?.resourceId || "-")}</span>`;
}

function permissionCheckboxes(selected = []) {
  return `
    <div class="checkbox-grid">
      ${MEMBER_PERMISSION_OPTIONS.map(([value, label]) => `
        <label><input type="checkbox" name="perm" value="${esc(value)}" ${selected.includes(value) ? "checked" : ""}> ${esc(label)}</label>
      `).join("")}
    </div>
  `;
}

function memberStats(members) {
  const activeMembers = members.filter((account) => account.status === "active").length;
  const invitedMembers = members.filter((account) => account.status === "invited" || account.invitationWithdrawn).length;
  const suspendedMembers = members.filter((account) => ["suspended", "disabled"].includes(account.status)).length;
  const retiredMembers = members.filter((account) => account.status === "retired").length;
  return {activeMembers, invitedMembers, suspendedMembers, retiredMembers, assignableProjects: assignableProjects().length};
}

function renderOrgMembersLifecycleGuide(members) {
  const stats = memberStats(members);
  const activeProjects = assignableProjects().length;
  const selectedProject = currentProject();
  return panel("成员授权流程", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "1 邀请成员",
        metric: members.length || "创建",
        detail: "创建成员只完成账号入网，不等于已经能参与某个项目",
        panelTitle: "创建成员",
        tone: members.length ? "blue" : "orange",
        action: "创建成员"
      })}
      ${jumpModuleCard({
        title: "2 等待登录",
        metric: stats.invitedMembers,
        detail: stats.invitedMembers ? "待接受邀请需要重发或等待首次登录" : "当前没有待接受邀请",
        panelTitle: "成员列表",
        tone: stats.invitedMembers ? "orange" : "green",
        action: "看邀请"
      })}
      ${projectModuleCard({
        pageId: selectedProject ? "proj-members" : "org-projects",
        title: "3 分配项目",
        metric: activeProjects,
        detail: selectedProject
          ? "已选项目时直接进入「成员权限」→「项目成员授权」；组织项目列表保留集中入口"
          : "先在组织项目列表选定目标项目；进入项目后到「成员权限」→「项目成员授权」完成",
        tone: activeProjects ? "blue" : "orange",
        action: "去授权"
      })}
      ${projectModuleCard({
        pageId: "org-projects",
        title: "4 授任务组角色",
        metric: "角色",
        detail: "任务组控制和人工审核通过项目角色落位，不能只写在组织成员权限里",
        tone: "blue",
        action: "看角色"
      })}
      ${projectModuleCard({
        pageId: "proj-overview",
        title: "5 回项目操作",
        metric: "项目",
        detail: "授权后回项目概览检查任务组、项目 Agent、监控和审核入口是否可用",
        tone: activeProjects ? "blue" : "gray",
        action: "进项目"
      })}
      ${jumpModuleCard({
        title: "6 审计收口",
        metric: stats.suspendedMembers + stats.retiredMembers,
        detail: "停用、注销和重发邀请都保留审计；异常账号先在成员列表处理",
        panelTitle: "成员列表",
        tone: stats.suspendedMembers + stats.retiredMembers ? "orange" : "green",
        action: "看成员"
      })}
    </div>
    <div class="small muted">成员管理只处理组织账号生命周期；项目协作、Agent 操作、任务组控制和人工审核权限必须回到具体项目和任务组作用域。</div>
    <div class="small muted">推荐闭环：邀请成员 → 首次登录 → 进入目标项目「成员权限」完成项目成员授权 → 回项目检查按钮是否出现 → 后续在成员列表停用、注销或重发邀请。</div>
  `, {wide: true});
}

function organizationMemberActions(account) {
  const isSelf = account.accountId === currentAccount.accountId;
  const manageable = account.accountType === "user_account" && !isSelf;
  if (!manageable) return "";
  return [
    `<button class="secondary-button" data-action="member-perms" data-account="${esc(account.accountId)}">调整账号能力</button>`,
    account.status === "invited" || account.invitationWithdrawn
      ? `<button class="secondary-button" data-action="member-reissue-invite" data-account="${esc(account.accountId)}">重发邀请</button>` : "",
    account.invitationWithdrawn ? "" : ["disabled", "suspended"].includes(account.status)
      ? `<button class="secondary-button" data-action="member-status" data-account="${esc(account.accountId)}" data-status="active">启用账号</button>`
      : `<button class="danger-button" data-action="member-status" data-account="${esc(account.accountId)}" data-status="suspended">停用账号</button>`,
    account.status === "retired" ? ""
      : `<button class="danger-button" data-action="member-retire" data-account="${esc(account.accountId)}">注销账号</button>`
  ].filter(Boolean).join(" ");
}

function renderOrgMembers() {
  const members = (orgMembers || []).filter((account) => account.accountType !== "service_account");
  const stats = memberStats(members);
  const selectedMember = members.find((account) => account.accountId === selectedOrgMemberId);
  if (selectedOrgMemberId && !selectedMember) selectedOrgMemberId = "";
  if (selectedMember) {
    memberGrantAccountId = selectedMember.accountId;
    const projects = assignableProjects().filter((project) => organizationOf(project) === organizationOf(selectedMember));
    const chosenProject = projects.find((project) => project.id === memberGrantProjectId) || projects[0] || null;
    if (chosenProject) memberGrantProjectId = chosenProject.id;
    const projectSelectorHtml = chosenProject ? `<select id="member-detail-project" data-member-grant-project>${projects.map((project) =>
      `<option value="${esc(project.id)}"${project.id === chosenProject.id ? " selected" : ""}>${esc(project.name || project.id)}</option>`).join("")}</select>` : "";
    const manageable = selectedMember.accountType === "user_account" && selectedMember.accountId !== currentAccount.accountId
      && selectedMember.status !== "retired";
    const readOnlyNotice = `<div class="notice">${selectedMember.accountId === currentAccount.accountId
      ? "这是当前登录账号；为避免把自己锁在组织外，本页不提供自助停用、注销或改授权。"
      : "该账号不是可授权的组织子账户，当前只展示已有身份和权限。"}</div>`;
    return window.AIMAC_GOVERNANCE_WORKSPACE.memberDetail({
      member: selectedMember,
      project: chosenProject,
      projectMemberships: projectMembershipsForAccount(selectedMember.accountId),
      taskGroupGrants: taskGroupGrantsForAccount(selectedMember.accountId),
      accountActionsHtml: organizationMemberActions(selectedMember),
      projectSelectorHtml,
      projectGrantFormHtml: manageable && chosenProject ? renderProjectMemberForm({projectId: chosenProject.id}) : readOnlyNotice,
      taskGroupGrantFormHtml: manageable && chosenProject ? renderTaskGroupGrantForm(chosenProject) : readOnlyNotice,
      helpers: {statusBadge, retiredNote, t, permLabel, grantRoleLabel, projectNameOf, taskGroupNameOf,
        projectLink: window.AIMAC_OBJECT_WORKSPACE.projectLink, panel: renderPanel}
    });
  }
  const memberRows = members.map((account) => {
    const isSelf = account.accountId === currentAccount.accountId;
    return row([
      `<strong>${esc(account.displayName)}</strong>${isSelf ? ` ${customBadge("本人", "blue")}` : ""}`,
      esc(account.email),
      badge(account.accountType),
      `${statusBadge("account", account.status)}${retiredNote(account)}`,
      esc((account.roles || []).map((role) => t(role)).join("、")),
      `<button class="primary-button" data-action="open-member-detail" data-account="${esc(account.accountId)}">${isSelf ? "查看账号" : "查看与管理"}</button>`
    ]);
  }).join("");

  return [
    panel("成员列表", `<div class="member-counts" aria-label="组织成员统计">
      <span>共 <strong>${members.length}</strong> 人</span>
      <span>启用 ${stats.activeMembers}</span>
      <span>待接受邀请 ${stats.invitedMembers}</span>
      <span>已停用 ${stats.suspendedMembers}</span>
      <span>已注销 ${stats.retiredMembers}</span>
    </div>` + table(["成员", "邮箱", "类型", "状态", "角色", "操作"], memberRows,
      {emptyText: listEmptyText("成员列表")}), {wide: true, headerSide: `${filterInput("按姓名、邮箱过滤…", "members")}
        <button class="primary-button" data-jump-panel="创建成员">创建成员</button>`}),
    renderOrgMemberScopeMatrix(members),
    panel("创建成员", `
      <form class="form-grid" data-form="member-create">
        <div class="form-row-inline">
          <div class="form-row"><label>显示名</label><input name="displayName" required></div>
          <div class="form-row"><label>邮箱</label><input name="email" type="email" required></div>
        </div>
        <div class="form-row"><label>默认项目</label>
          <select name="defaultProjectId">
            <option value="">（不指定）</option>
            ${assignableProjects().map((project) => `<option value="${esc(project.id)}">${esc(project.name || project.id)}</option>`).join("")}
          </select>
        </div>
        <div class="form-row"><label>账号能力</label>${permissionCheckboxes()}</div>
        <div class="notice">创建成功后将弹窗展示一次性登录令牌，请提示成员保存并尽快登录改密。</div>
        <button class="primary-button" type="submit">创建成员</button>
      </form>
    `),
    guideBundle("授权流程指引", [renderOrgMembersLifecycleGuide(members), panel("说明", `
      <div class="stack">
        <div class="record"><div class="record-title"><strong>一次性令牌</strong></div><div class="record-meta"><span>成员首次使用令牌登录后令牌即失效，可在顶栏“修改密码”设置个人密码。</span></div></div>
        <div class="record"><div class="record-title"><strong>权限边界</strong></div><div class="record-meta"><span>成员权限不可包含系统级与组织级通配权限；项目、任务组细粒度授权优先在目标项目「成员权限」补充，系统管理只做跨项目身份和服务账号治理。</span></div></div>
      </div>
    `)], ["成员授权流程（6 步）", "账号与权限说明"])
  ].join("");
}

/* ---------------- 组织管理员：共享 Agent ---------------- */

function agentHoverPop(node) {
  const profile = node.profile || {};
  const display = node.display || {};
  return `
    <div class="hover-pop">
      <dl>
        <dt>CPU 核数</dt><dd>${esc(profile.cpuCount ?? "-")}</dd>
        <dt>内存</dt><dd>${fmtBytes(profile.memoryBytes)}</dd>
        <dt>磁盘可用</dt><dd>${fmtBytes(profile.diskFreeBytes)}</dd>
        <dt>支持模型</dt><dd>${esc((display.models || []).map((model) => String(model)).join("、") || "-")}</dd>
        <dt>网络速度</dt><dd>${display.networkSpeedMbps ? `${esc(display.networkSpeedMbps)} Mbps` : "-"}</dd>
        <dt>数据根路径</dt><dd class="mono">${esc(display.dataRoot || "-")}</dd>
        <dt>累计完成 / 失败</dt><dd>${esc(node.completedDispatchCount ?? 0)} / ${esc(node.failedDispatchCount ?? 0)}</dd>
      </dl>
    </div>
  `;
}

function nodeDispatchIds(node) {
  return Array.isArray(node?.activeDispatchIds) ? node.activeDispatchIds : node?.display?.currentDispatchIds || [];
}

function agentActions(node, options = {}) {
  if (node.status === "revoked") return "-";
  if (node.registrationScope === "organization" && perspectiveOf(currentAccount) === "user") return `<span class="small muted">组织共享节点，由组织管理员维护</span>`;
  const scope = options.scope || "org";
  const showDanger = scope === "org" || options.showDanger === true;
  const activeDispatchIds = nodeDispatchIds(node);
  const activeDispatch = (state.agentDispatches || []).find((dispatch) => activeDispatchIds.includes(dispatch.dispatchId));
  const dispatchControl = options.includeDispatchControl === false ? "" : activeDispatchIds.length > 1
    ? `<button class="secondary-button" data-action="open-node-tasks">查看 ${activeDispatchIds.length} 个当前任务</button>`
    : activeDispatch?.status === "blocked"
    ? `<button class="secondary-button" data-action="agent-control" data-node-id="${esc(node.nodeId)}" data-command="resume_dispatch" data-dispatch-id="${esc(activeDispatch.dispatchId)}" title="恢复当前被暂停或阻塞的派发">恢复当前任务</button>`
    : activeDispatch && ["queued", "running"].includes(activeDispatch.status)
      ? `<button class="secondary-button" data-action="agent-control" data-node-id="${esc(node.nodeId)}" data-command="pause_dispatch" data-dispatch-id="${esc(activeDispatch.dispatchId)}" title="暂停当前派发并等待后续处置">暂停当前任务</button>`
      : activeDispatchIds.length ? `<button class="secondary-button" data-action="open-node-tasks">查看当前任务</button>` : "";
  const buttons = [
    `<button class="secondary-button" data-action="agent-control" data-node-id="${esc(node.nodeId)}" data-command="refresh_profile" title="让节点重新探测模型执行器、远程 MCP、文件系统和 Git 能力">刷新自检</button>`,
    dispatchControl,
    `<button class="secondary-button" data-action="agent-control" data-node-id="${esc(node.nodeId)}" data-command="shutdown">关停</button>`
  ].filter(Boolean);
  if (showDanger) {
    buttons.push(
      `<button class="danger-button" data-action="revoke-agent-node" data-node-id="${esc(node.nodeId)}">吊销</button>`,
      `<button class="danger-button" data-action="force-revoke-agent-node" data-node-id="${esc(node.nodeId)}" title="不等节点确认，当场作废其凭据">立即切断</button>`
    );
  } else {
    buttons.push(`<span class="small muted">吊销和立即切断在「组织管理」→「共享 Agent」处理</span>`);
  }
  return buttons.join(" ");
}

function orgAgentStats(nodes) {
  const aliveNodes = nodes.filter((node) => node.status !== "revoked");
  const onlineNodes = aliveNodes.filter((node) => node.status === "online" && !heartbeatTimedOut(node) && node.display?.health !== "offline").length;
  const busyNodes = aliveNodes.filter((node) => nodeDispatchIds(node).length > 0).length;
  const runningDispatches = aliveNodes.reduce((sum, node) => sum + nodeDispatchIds(node).length, 0);
  const abnormalNodes = aliveNodes.filter((node) =>
    heartbeatTimedOut(node) || node.status !== "online" || !["ok", "healthy", "normal", undefined, ""].includes(node.display?.health)).length;
  const projectIds = new Set((state.projects || []).map((project) => project.id));
  const liveTokens = (state.agentJoinTokens || []).filter((token) =>
    projectIds.has(token.projectId)
    && token.status === "issued"
    && (!token.expiresAt || new Date(token.expiresAt).getTime() > serverNow())).length;
  return {aliveNodes, onlineNodes, busyNodes, runningDispatches, abnormalNodes, liveTokens};
}

function projectAgentNodes(projectId = currentProjectId) {
  if (!projectId) return [];
  return (state.agentRuntimeNodes || []).filter((node) => (Array.isArray(node.effectiveProjectIds) ? node.effectiveProjectIds : node.projectIds || []).includes(projectId));
}

function projectAgentStats(projectId = currentProjectId, nodes = projectAgentNodes(projectId)) {
  const aliveNodes = nodes.filter((node) => node.status !== "revoked");
  const onlineNodes = aliveNodes.filter((node) => node.status === "online" && !heartbeatTimedOut(node) && node.display?.health !== "offline").length;
  const busyNodes = aliveNodes.filter((node) => nodeDispatchIds(node).length > 0).length;
  const groupIds = new Set((state.taskGroups || []).filter((taskGroup) => taskGroup.projectId === projectId).map((taskGroup) => taskGroup.id));
  const runningDispatches = (state.agentDispatches || []).filter((dispatch) =>
    groupIds.has(dispatch.taskGroupId) && ["queued", "running", "blocked"].includes(dispatch.status)).length;
  const abnormalNodes = aliveNodes.filter((node) =>
    heartbeatTimedOut(node) || node.status !== "online" || !["ok", "healthy", "normal", undefined, ""].includes(node.display?.health)).length;
  const liveTokens = liveJoinTokenCount(projectId);
  return {aliveNodes, onlineNodes, busyNodes, runningDispatches, abnormalNodes, liveTokens};
}

function orgScopedAgents() {
  const orgId = currentAccount?.organizationId || DEFAULT_ORGANIZATION_ID;
  return (state.agents || []).filter((agent) => (agent.organizationId || DEFAULT_ORGANIZATION_ID) === orgId && !agent.projectId);
}

function projectScopedAgents(projectId) {
  const project = (state.projects || []).find((item) => item.id === projectId);
  const orgId = project?.organizationId || currentAccount?.organizationId || DEFAULT_ORGANIZATION_ID;
  return (state.agents || []).filter((agent) =>
    (agent.organizationId || DEFAULT_ORGANIZATION_ID) === orgId && (!agent.projectId || agent.projectId === projectId));
}

function agentScopeText(agent) {
  const agentOrganizationId = agent.organizationId || DEFAULT_ORGANIZATION_ID;
  const organization = (state.organizations || []).find((org) => org.orgId === agentOrganizationId);
  const contextOrganization = state.organizationContext?.id === agentOrganizationId ? state.organizationContext : null;
  return agent.projectId
    ? `项目级：${projectNameOf(agent.projectId)}`
    : `组织级：${contextOrganization?.name || organization?.name || agentOrganizationId || "当前组织"}`;
}

// 三个「自动选型」预设在创建表单里显示中文（自动最优 / 自动快速 / 成本优先），列表里此前却显示原始码 auto_best ——
// 同一个东西两种叫法，人对不上号。预设给中文并附原始码；真实模型 ID 照旧。
const AGENT_MODEL_PRESET_LABEL = {auto_best: "自动最优", auto_fast: "自动快速", cost_aware: "成本优先"};
function agentModelCell(model) {
  const id = String(model || "auto_best");
  const label = AGENT_MODEL_PRESET_LABEL[id];
  return label ? `${esc(label)}<div class="small muted mono">${esc(id)}</div>` : `<span class="mono">${esc(id)}</span>`;
}

function agentProfileRows(agents, {showScope = true} = {}) {
  return agents.map((agent) => row([
    `<strong>${esc(agent.name || agent.id)}</strong><div class="small muted mono">${esc(agent.id)}</div>`,
    esc(t(agent.role)),
    agentModelCell(agent.model),
    showScope ? esc(agentScopeText(agent)) : esc(agent.projectId ? "项目级" : "组织级"),
    statusBadge("agent", agent.status),
    {v: Number.isFinite(Number(agent.trustScore)) ? `${Math.round(Number(agent.trustScore) * 100)}%` : "-", c: "num"},
    agent.roleSkillRef ? `<span class="mono">${esc(agent.roleSkillRef)}</span>` : "-",
    `<button class="primary-button" data-action="open-agent-profile" data-agent="${esc(agent.id)}">查看与管理</button>`
  ])).join("");
}

function renderAgentProfileUpdateForm(agent) {
  return `<form class="form-grid" data-form="agent-profile-update" data-agent="${esc(agent.id)}">
    <div class="form-row-inline">
      <div class="form-row"><label>档案名称</label><input name="name" required value="${esc(agent.name || "")}"></div>
      <div class="form-row"><label>执行角色</label><input name="role" list="agent-profile-role-options" required value="${esc(agent.role || "")}">
        <datalist id="agent-profile-role-options">${WORK_ITEM_OWNER_ROLE_CHOICES.map((roleId) => `<option value="${esc(roleId)}">${esc(t(roleId))}</option>`).join("")}</datalist></div>
      <div class="form-row"><label>模型偏好</label><input name="model" list="agent-profile-model-options" required value="${esc(agent.model || "auto_best")}">
        <datalist id="agent-profile-model-options">${modelOptionsHtml()}</datalist></div>
      <div class="form-row"><label>信任分</label><input name="trustScore" type="number" step="0.01" min="0" max="1" required value="${esc(Number.isFinite(Number(agent.trustScore)) ? agent.trustScore : "")}"></div>
    </div>
    <div class="form-row"><label>角色 Skill 引用（留空则按角色集中解析）</label><input name="roleSkillRef" list="agent-profile-skill-options" value="${esc(agent.roleSkillRef || "")}">
      ${roleSkillChoiceList("agent-profile-skill-options")}</div>
    <button class="primary-button" type="submit">保存 Agent 档案</button>
  </form>`;
}

function renderAgentProfileDetail(agent, {editable, scopeLabel}) {
  return window.AIMAC_AGENT_PROFILE_WORKSPACE.detail({
    agent,
    scopeLabel,
    editable,
    formHtml: editable ? renderAgentProfileUpdateForm(agent) : "",
    activationHtml: editable
      ? `<button class="${agent.status === "active" ? "danger-button" : "secondary-button"}" data-action="toggle-agent" data-agent="${esc(agent.id)}">${agent.status === "active" ? "停用档案" : "启用档案"}</button>` : "",
    helpers: {statusBadge, t, modelCell: agentModelCell, fmtTime}
  });
}

function modelOptionsHtml() {
  const common = ["auto_best", "auto_fast", "cost_aware", "gpt-5.5", "gpt-5.6-sol",
    "claude-sonnet-4.5", "claude-opus-4.1", "gemini-2.5-pro", "gemini-2.5-flash",
    "grok-4", "deepseek-v3.1", "deepseek-r1"];
  const ids = [...common, ...(state.modelCapabilities || []).map((profile) => profile.modelId)].filter(Boolean);
  return [...new Set(ids)].map((id) => `<option value="${esc(id)}">${esc(AGENT_MODEL_PRESET_LABEL[id] || id)}</option>`).join("");
}

function renderAgentProfileForm({projectId = "", title = "创建 Agent 档案", readOnly = false} = {}) {
  if (readOnly) return `<div class="notice warn-notice">当前账号没有智能体管理权限，只能查看 Agent 档案。</div>`;
  return `
    <form class="form-grid" data-form="agent-create">
      ${projectId ? `<input type="hidden" name="projectId" value="${esc(projectId)}">` : ""}
      <div class="form-row-inline">
        <div class="form-row"><label>${esc(title)}名称</label><input name="name" placeholder="例如：后端实现 Agent"></div>
        <div class="form-row"><label>执行角色</label><input name="role" list="agent-role-options" required placeholder="例如：agent-runtime">
          <datalist id="agent-role-options">${WORK_ITEM_OWNER_ROLE_CHOICES.map((roleId) => `<option value="${esc(roleId)}">${esc(t(roleId))}</option>`).join("")}</datalist></div>
        <div class="form-row"><label>模型偏好</label><input name="model" list="agent-model-options" value="auto_best" placeholder="auto_best 或实际模型 ID">
          <datalist id="agent-model-options">${modelOptionsHtml()}</datalist>
          <div class="small muted">自动最优（auto_best）· 自动快速（auto_fast）· 成本优先（cost_aware），或填写模型能力列表中的实际模型 ID。偏好只在满足任务硬约束和模型上限的候选中生效。</div></div>
        <div class="form-row"><label>信任分</label><input name="trustScore" type="number" step="0.01" min="0" max="1" value="0.85"></div>
      </div>
      <div class="form-row"><label>角色 Skill 引用（可选）</label><input name="roleSkillRef" list="agent-role-skill-options" placeholder="默认使用技能源内匹配角色">
        ${roleSkillChoiceList("agent-role-skill-options")}</div>
      <div class="notice">${projectId ? "项目级 Agent 只服务当前项目；任务组派发时可同时调配当前项目级 Agent 和组织级 Agent。" : "组织级 Agent 可被本组织内项目调配；项目有特殊要求时再在项目页创建项目级 Agent。"}</div>
      <button class="primary-button" type="submit">${esc(title)}</button>
    </form>
  `;
}

function projectAgentCards(nodes, canControlNodes, options = {}) {
  return nodes.length ? `
    <div class="agent-cards">
      ${nodes.map((node) => {
        const timedOut = heartbeatTimedOut(node);
        return `
          <div class="agent-card">
            <h3><span class="hover-wrap">${esc(node.nodeName || node.nodeId)}${agentHoverPop(node)}</span>${timedOut ? badge("heartbeat_timeout") : badge(node.status)}</h3>
            <div class="agent-meta">
              <span>准入：${badge(node.admission)}</span>
              <span>健康度：${badge(timedOut ? "offline" : node.display?.health || node.status)}</span>
              <span>地区：${esc(node.display?.region || "-")}</span>
              <span>当前任务数：${nodeDispatchIds(node).length}</span>
              <span>最近心跳：${fmtTime(node.lastHeartbeatAt)}</span>
            </div>
            ${timedOut ? `<div class="small warn-text">上次状态仍为「${esc(t(node.status) || node.status)}」，但心跳已超过判死阈值。</div>` : ""}
            ${claimMissHint(node)}${selfCheckFailureHint(node)}${heartbeatStaleHint(node)}
            <div class="button-row" style="margin-top:10px;">${canControlNodes ? agentActions(node, {scope: "project", showDanger: options.showDanger === true}) : `<span class="small muted">当前账号无节点控制权限</span>`}</div>
          </div>
        `;
      }).join("")}
    </div>
  ` : `<div class="notice warn-notice">当前项目还没有任何 agent 节点。要让任务实际执行，请在下面“注册项目节点”签发一次性加入令牌，然后把弹窗里的安装命令放到目标 agent 主机执行。</div>`;
}

function renderOrgAgentsBoundaryGuide() {
  return panel("智能体管理边界", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "组织节点总览",
        metric: "组织",
        detail: "这里看全组织 agent 节点、健康度、负载和吊销",
        panelTitle: "agent 节点",
        tone: "blue",
        action: "看节点"
      })}
      ${projectModuleCard({
        pageId: "proj-agents",
        title: "项目注册入口",
        metric: "项目",
        detail: "进入后先确认当前项目就是目标项目，再签发一次性令牌",
        tone: "green",
        action: "去项目注册"
      })}
      ${jumpModuleCard({
        title: "令牌审计",
        metric: "组织",
        detail: "在这里查看组织范围加入令牌状态和撤销",
        panelTitle: "加入令牌审计",
        tone: "gray",
        action: "看令牌"
      })}
      ${jumpModuleCard({
        title: "服务集中运行",
        metric: "MCP",
        detail: "MCP 与技能同步在服务端，agent 端只跑轻量执行器",
        panelTitle: "加入令牌审计",
        tone: "gray",
        action: "看说明"
      })}
    </div>
    <div class="small muted">边界：组织页负责全组织节点状态、控制、吊销和令牌审计；项目页负责按项目签发一次性令牌、复制注册脚本和确认项目节点可用。</div>
  `, {wide: true});
}

function renderProjectAgentRegistrationFlow(project, nodes) {
  const stats = projectAgentStats(project.id, nodes);
  return panel("Agent 注册流程", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "1 选择项目",
        metric: "当前",
        detail: project.name || project.id,
        panelTitle: "注册项目节点",
        tone: "blue",
        action: "已定位"
      })}
      ${jumpModuleCard({
        title: "2 签发令牌",
        metric: stats.liveTokens || "签发",
        detail: "一次性加入令牌绑定当前项目、角色和 MCP 作用范围",
        panelTitle: "注册项目节点",
        tone: stats.liveTokens ? "green" : "orange",
        action: "签发"
      })}
      ${jumpModuleCard({
        title: "3 复制脚本",
        metric: "sh",
        detail: "弹窗返回 直接安装版和 SHA256 校验版安装命令",
        panelTitle: "注册项目节点",
        tone: "blue",
        action: "复制"
      })}
      ${jumpModuleCard({
        title: "4 自动自检",
        metric: "MCP",
        detail: "agent 自动注册、自检并维护远程 MCP 配置",
        panelTitle: "项目 agent 节点",
        tone: "gray",
        action: "等回报"
      })}
      ${jumpModuleCard({
        title: "5 确认可用",
        metric: `${stats.onlineNodes}/${stats.aliveNodes.length}`,
        detail: "回到节点列表确认在线、准入和健康度",
        panelTitle: "项目 agent 节点",
        tone: stats.onlineNodes ? "green" : "orange",
        action: "看节点"
      })}
    </div>
    <div class="small muted">注册脚本不是固定写死命令，必须先由服务端在当前项目签发一次性加入令牌；agent 注册后通过节点令牌与服务端 Gateway、远程 MCP 和技能工作集交互。</div>
  `, {wide: true});
}

function renderProjectAgentExecutionLoop(project, nodes) {
  const stats = projectAgentStats(project.id, nodes);
  const groupIds = new Set(projectTaskGroups().map((taskGroup) => taskGroup.id));
  const activeDispatches = (state.agentDispatches || [])
    .filter((dispatch) => groupIds.has(dispatch.taskGroupId) && !terminalDispatchStatuses.has(dispatch.status)).length;
  return panel("Agent 接入与运行闭环", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "1 项目签发",
        metric: stats.liveTokens || "令牌",
        detail: "只在「注册项目节点」签发一次性加入令牌，脚本由服务端按当前项目生成",
        panelTitle: "注册项目节点",
        tone: stats.liveTokens ? "blue" : "orange",
        action: "签发令牌"
      })}
      ${jumpModuleCard({
        title: "2 轻量 Runtime",
        metric: stats.aliveNodes.length || "未接入",
        detail: "Agent 主机只跑 Runtime：注册、自检、领活、写仓库，不启动本地 MCP、数据库或 Skill Registry",
        panelTitle: "项目 agent 节点",
        tone: stats.aliveNodes.length ? "green" : "gray",
        action: "看节点"
      })}
      ${jumpModuleCard({
        title: "3 远程能力",
        metric: "MCP/Skill",
        detail: "Runtime 访问控制面公网 /mcp，并按派发下载总控指定的最小 Skill 工作集",
        panelTitle: "项目 agent 节点",
        tone: "blue",
        action: "看自检"
      })}
      ${projectModuleCard({
        pageId: "monitor",
        title: "4 实时回送",
        metric: activeDispatches,
        detail: "执行中持续回送事件、进度、模型输出摘要、仓库变更和检查点准备",
        tone: activeDispatches ? "blue" : "gray",
        action: "看事件"
      })}
      ${projectModuleCard({
        pageId: "monitor",
        title: "5 服务端控制",
        metric: "ACK",
        detail: "暂停、取消、吊销先在服务端冻结派发并撤销 MCP grant，再等待节点 ACK",
        tone: "green",
        action: "看控制"
      })}
    </div>
    <div class="small muted">这条闭环是机器执行链路：管理界面只签发项目令牌、查看状态和下发控制；任务执行、MCP 调用、Skill 应用、事件回送和 checkpoint 都由 Agent Runtime 与控制面自动完成。</div>
  `, {wide: true});
}

function renderProjectAgentNodeGovernanceGuide(project, nodes) {
  const stats = projectAgentStats(project.id, nodes);
  const availableNodes = stats.aliveNodes.filter((node) => node.status === "online" && node.admission === "full").length;
  return panel("agent 节点处置流程", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "1 判断可派发",
        metric: `${availableNodes}/${stats.aliveNodes.length}`,
        detail: "先确认在线且准入为完整的节点数量，不足时先恢复节点或注册新 agent",
        panelTitle: "项目 agent 节点",
        tone: availableNodes ? "green" : stats.aliveNodes.length ? "orange" : "red",
        action: "看节点"
      })}
      ${jumpModuleCard({
        title: "2 离线恢复",
        metric: stats.abnormalNodes,
        detail: stats.abnormalNodes ? "离线先恢复目标 agent 主机、Runtime 进程和心跳，再刷新自检" : "当前没有异常节点；离线先恢复目标 agent 主机、Runtime 进程和心跳",
        panelTitle: "项目 agent 节点",
        tone: stats.abnormalNodes ? "orange" : "green",
        action: "定位"
      })}
      ${jumpModuleCard({
        title: "3 刷新自检",
        metric: "profile",
        detail: "执行器、远程 MCP、文件系统或 Git 能力修好后，点节点行“刷新自检”重新上报",
        panelTitle: "项目 agent 节点",
        tone: "blue",
        action: "看按钮"
      })}
      ${projectModuleCard({
        pageId: "monitor",
        title: "4 运行监控",
        metric: stats.runningDispatches,
        detail: "运行中异常先回执行监控看实时事件、派发状态和控制 ACK",
        tone: stats.runningDispatches ? "blue" : "gray",
        action: "看监控"
      })}
      ${jumpModuleCard({
        title: "5 暂停恢复",
        metric: "控制",
        detail: "暂停、恢复和关停在节点行执行，用于冻结后续领活或让节点排空退出",
        panelTitle: "项目 agent 节点",
        tone: "blue",
        action: "看控制"
      })}
      ${jumpModuleCard({
        title: "6 吊销切断",
        metric: "凭据",
        detail: "吊销或立即切断会废止节点令牌和 MCP grant，属于高影响动作",
        panelTitle: "项目 agent 节点",
        tone: "red",
        action: "看风险"
      })}
    </div>
    <div class="small muted">节点处置顺序：先恢复可派发能力，再刷新自检；运行中问题先看执行监控，确认影响面后再暂停、恢复、关停、吊销或立即切断。重新注册只用于新 agent 接入，不用于修复已有节点的普通自检问题。</div>
  `, {wide: true});
}

function renderOrgAgentsSummary(nodes) {
  const stats = orgAgentStats(nodes);
  return panel("智能体运行总览", `
    <div class="metric-grid">
      ${summaryMetric("节点总数", stats.aliveNodes.length, "已接入且未吊销的 agent 节点")}
      ${summaryMetric("在线节点", `${stats.onlineNodes}/${stats.aliveNodes.length}`, "可接收控制面派发")}
      ${summaryMetric("忙碌节点", stats.busyNodes, "当前正在承载任务")}
      ${summaryMetric("当前任务", stats.runningDispatches, "节点正在执行的派发数量")}
      ${summaryMetric("待用加入令牌", stats.liveTokens, "可注册到本组织项目的令牌")}
      ${summaryMetric("异常节点", stats.abnormalNodes, "离线、非健康或需排查的节点")}
    </div>
    <div class="small muted">组织共享节点在“注册共享节点”接入，项目专属节点从目标项目的「项目 Agent」接入。两种节点的控制、运行状态和加入令牌均按各自作用域管理。</div>
  `, {wide: true});
}

function renderOrgAgentsActionBoard(nodes) {
  const stats = orgAgentStats(nodes);
  return panel("智能体治理操作看板", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "在线节点",
        metric: `${stats.onlineNodes}/${stats.aliveNodes.length}`,
        detail: "可接收控制面派发",
        panelTitle: "agent 节点",
        tone: stats.onlineNodes ? "green" : "orange",
        action: "查看节点"
      })}
      ${jumpModuleCard({
        title: "异常节点",
        metric: `${stats.abnormalNodes}`,
        detail: stats.abnormalNodes ? "离线、非健康或需排查" : "当前没有异常节点",
        panelTitle: "agent 节点",
        tone: stats.abnormalNodes ? "red" : "green",
        action: "定位异常"
      })}
      ${jumpModuleCard({
        title: "忙碌节点",
        metric: `${stats.busyNodes}`,
        detail: "当前正在承载任务",
        panelTitle: "agent 节点",
        tone: stats.busyNodes ? "blue" : "gray",
        action: "查看负载"
      })}
      ${jumpModuleCard({
        title: "当前任务",
        metric: `${stats.runningDispatches}`,
        detail: "节点正在执行的派发数量",
        panelTitle: "agent 节点",
        tone: stats.runningDispatches ? "blue" : "green",
        action: "查看任务"
      })}
      ${jumpModuleCard({
        title: "待用加入令牌",
        metric: `${stats.liveTokens}`,
        detail: "可注册到本组织项目的令牌",
        panelTitle: "加入令牌审计",
        tone: stats.liveTokens ? "blue" : "orange",
        action: "查看令牌"
      })}
      ${projectModuleCard({
        pageId: "proj-agents",
        title: "当前项目接入入口",
        metric: "项目",
        detail: "进入后先在侧栏确认目标项目，再到「项目管理」→「项目 Agent」→「注册项目节点」签发脚本",
        tone: "blue",
        action: "确认后注册"
      })}
    </div>
    <div class="small muted">处理顺序：先核对在线率、异常和负载，再进入目标项目签发加入令牌接入新节点；本页可查看或撤销待用令牌。</div>
  `, {wide: true});
}

function renderOrgAgentsLifecycleGuide(nodes) {
  const stats = orgAgentStats(nodes);
  return panel("组织 Agent 治理流程", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "1 看在线率",
        metric: `${stats.onlineNodes}/${stats.aliveNodes.length}`,
        detail: "先判断组织内是否有可接收派发的节点，再看异常和负载",
        panelTitle: "agent 节点",
        tone: stats.onlineNodes ? "green" : "orange",
        action: "看节点"
      })}
      ${jumpModuleCard({
        title: "2 定位异常",
        metric: stats.abnormalNodes,
        detail: stats.abnormalNodes ? "离线、非健康或自检缺项先定位节点，再决定恢复或吊销" : "当前没有异常节点；离线、非健康或自检缺项先定位节点",
        panelTitle: "agent 节点",
        tone: stats.abnormalNodes ? "red" : "green",
        action: "定位"
      })}
      ${projectModuleCard({
        pageId: "proj-agents",
        title: "3 项目注册",
        metric: "加入令牌",
        detail: "项目专属节点在目标项目签发一次性令牌和 sh 安装命令；组织共享节点在组织注册栏目接入",
        tone: "blue",
        action: "去注册"
      })}
      ${projectModuleCard({
        pageId: "monitor",
        title: "4 负载与派发",
        metric: stats.runningDispatches,
        detail: "节点正在执行的派发、实时事件和控制 ACK 回项目执行监控查看",
        tone: stats.runningDispatches ? "blue" : "gray",
        action: "看监控"
      })}
      ${jumpModuleCard({
        title: "5 令牌审计",
        metric: stats.liveTokens,
        detail: "组织页只审计和撤销待用令牌，不在这里生成项目注册脚本",
        panelTitle: "加入令牌审计",
        tone: stats.liveTokens ? "orange" : "green",
        action: "看令牌"
      })}
      ${jumpModuleCard({
        title: "6 节点处置",
        metric: "控制",
        detail: "暂停、恢复、关停、吊销和立即切断都在节点列表按单节点执行",
        panelTitle: "agent 节点",
        tone: "blue",
        action: "看控制"
      })}
    </div>
    <div class="small muted">组织 Agent 页负责跨项目节点治理和令牌审计；项目级注册脚本、远程 MCP 生效确认、Skill 工作集和具体派发回送仍回目标项目处理。</div>
  `, {wide: true});
}

function renderOrgAgents() {
  const nodes = orgAgentNodes;
  const scopedAgents = orgScopedAgents();
  const selectedProfile = scopedAgents.find((agent) => agent.id === selectedAgentProfileId);
  if (selectedAgentProfileId && !selectedProfile) selectedAgentProfileId = "";
  if (selectedProfile) {
    const organization = (state.organizations || []).find((item) => item.orgId === (selectedProfile.organizationId || currentAccount?.organizationId));
    return renderAgentProfileDetail(selectedProfile, {editable: hasPerm("agent:activate"),
      scopeLabel: `组织共享 · ${organization?.name || selectedProfile.organizationId || "当前组织"}`});
  }
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
        ${nodes.map((node) => {
          const timedOut = heartbeatTimedOut(node);
          return `
          <div class="agent-card">
            <h3><span class="hover-wrap">${esc(node.nodeName || node.nodeId)}${agentHoverPop(node)}</span>${timedOut ? badge("heartbeat_timeout") : badge(node.status)}</h3>
            <div class="agent-meta">
              <span>地区：${esc(node.display?.region || "-")}</span>
              <span>健康度：${badge(timedOut ? "offline" : node.display?.health || node.status)}</span>
              <span>当前任务数：${nodeDispatchIds(node).length}</span>
              <span>最近心跳：${fmtTime(node.lastHeartbeatAt)}</span>
            </div>
            ${timedOut ? `<div class="small warn-text">上次状态仍为「${esc(t(node.status) || node.status)}」，但心跳已超过判死阈值。</div>` : ""}
            <div class="button-row" style="margin-top:10px;">${agentActions(node)}</div>
          </div>
        `;}).join("")}
      </div>
    ` : `<div class="notice">当前组织暂无 agent 节点。可注册组织共享节点，或在项目内注册专属节点。</div>`;
  } else {
    const nodeRows = nodes.map((node) => {
      const timedOut = heartbeatTimedOut(node);
      return row([
      `<span class="hover-wrap"><strong>${esc(node.nodeName || node.nodeId)}</strong>${agentHoverPop(node)}</span><div class="small muted mono">${esc(node.nodeId)}</div>${customBadge(node.registrationScope === "organization" ? "组织共享" : "项目专属", node.registrationScope === "organization" ? "green" : "blue")}`,
      timedOut ? `${badge("heartbeat_timeout")}<div class="small warn-text">上次状态仍为「${esc(t(node.status) || node.status)}」</div>` : badge(node.status),
      esc(node.display?.region || "-"),
      badge(timedOut ? "offline" : node.display?.health || node.status),
      {v: String(nodeDispatchIds(node).length), c: "num"},
      {v: fmtTime(node.lastHeartbeatAt), c: "nowrap"},
      agentActions(node)
    ]);}).join("");
    bodyHtml = table(["名称", "运行状态", "地区", "健康度", {label: "当前任务数", c: "num"}, {label: "最近心跳", c: "nowrap"}, "操作"],
      nodeRows, {emptyText: listEmptyText("agent 节点")});
  }

  return [
    panel("注册组织 agent", renderOrgNodeRegistration(), {wide: true}),
    renderOrgAgentsSummary(nodes),
    renderOrgAgentsActionBoard(nodes),
    renderOrgAgentsBoundaryGuide(),
    renderOrgAgentsLifecycleGuide(nodes),
    panel("组织级 Agent 档案", `
      <div class="stack">
        <div class="notice">角色档案定义可承担的工作。组织共享节点在“注册共享节点”接入，项目专属节点在对应项目接入，两类节点可使用本组织的角色档案。</div>
        <div class="agent-profile-table">${table(["档案", "角色", "模型偏好", "作用域", "状态", {label: "信任分", c: "num"}, "Skill", "操作"],
          agentProfileRows(scopedAgents), {emptyText: "当前组织还没有组织级 Agent 档案。可先创建通用角色档案，项目特殊角色再到项目页创建。"})}</div>
        ${renderAgentProfileForm({title: "创建组织级 Agent 档案", readOnly: !hasPerm("agent:activate")})}
      </div>
    `, {wide: true, headerSide: filterInput("按档案、角色、模型过滤…", "org-agent-profiles")}),
    panel("agent 节点", `<div class="stack"><div class="notice">鼠标悬浮在节点名称上可查看资源、支持模型、网络速度、数据根路径与累计完成、失败。</div>${bodyHtml}</div>`, {wide: true, headerSide: `${filterInput("按节点名、地区过滤…", "org-nodes")}${toggle}`}),
    panel("加入令牌审计", renderJoinTokenSection({auditOnly: true, context: "org"}), {wide: true})
  ].join("");
}

/* ---------------- 成员：项目智能体 ---------------- */

// 指引面板成组折叠：默认收起，摘要列出里面有哪几组；点开即展开，不丢任何内容。
function guideBundle(title, panelsHtml, names) {
  if (!workspaces.showGuide()) return "";
  return `<details class="guide-bundle"><summary class="guide-bundle-summary">${esc(title)}：${esc(names.join(" · "))} —— 默认收起，点这里展开</summary>`
    + `<div class="guide-bundle-body">${panelsHtml.join("")}</div></details>`;
}

function renderProjectAgentsSummary(project, nodes) {
  const stats = projectAgentStats(project.id, nodes);
  return panel("项目智能体总览", `
    <div class="metric-grid">
      ${summaryMetric("项目节点", stats.aliveNodes.length, "绑定当前项目且未吊销的 agent 节点")}
      ${summaryMetric("在线节点", `${stats.onlineNodes}/${stats.aliveNodes.length}`, "可接收当前项目派发")}
      ${summaryMetric("忙碌节点", stats.busyNodes, "正在承载任务的节点")}
      ${summaryMetric("当前任务", stats.runningDispatches, "当前项目排队、运行或被挡的派发")}
      ${summaryMetric("待用加入令牌", stats.liveTokens, "可注册到当前项目的一次性令牌")}
      ${summaryMetric("异常节点", stats.abnormalNodes, "离线、非健康或需排查的节点")}
    </div>
    <div class="small muted">查看顺序：先看在线率、异常节点和待用令牌；新机器只通过本页“注册项目节点”签发一次性加入令牌，脚本由服务端生成。</div>
  `, {wide: true});
}

function renderProjectAgentProfileSummary(project, agents) {
  const projectProfiles = agents.filter((agent) => agent.projectId === project.id);
  const organizationProfiles = agents.filter((agent) => !agent.projectId);
  const activeProfiles = agents.filter((agent) => agent.status === "active");
  const activeRoles = new Set(activeProfiles.map((agent) => agent.role));
  return `<div class="metric-grid" aria-label="可调配 Agent 档案摘要">
    <div class="metric"><span>项目专属档案</span><strong>${projectProfiles.length}</strong></div>
    <div class="metric"><span>组织共享档案</span><strong>${organizationProfiles.length}</strong></div>
    <div class="metric"><span>活动档案</span><strong>${activeProfiles.length}/${agents.length}</strong></div>
    <div class="metric"><span>覆盖执行角色</span><strong>${activeRoles.size}</strong></div>
  </div>`;
}

function renderProjectAgentsActionBoard(project, nodes) {
  const stats = projectAgentStats(project.id, nodes);
  return panel("项目智能体操作看板", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "注册新 agent",
        metric: stats.liveTokens ? `${stats.liveTokens}` : "签发",
        detail: stats.liveTokens ? "已有待用令牌，可继续复制注册脚本" : "生成一次性令牌和服务端安装脚本",
        panelTitle: "注册项目节点",
        tone: stats.liveTokens ? "blue" : "orange",
        action: "签发令牌"
      })}
      ${jumpModuleCard({
        title: "项目节点",
        metric: `${stats.onlineNodes}/${stats.aliveNodes.length}`,
        detail: stats.aliveNodes.length ? "查看当前项目可用节点" : "当前项目还没有节点",
        panelTitle: "项目 agent 节点",
        tone: stats.onlineNodes ? "green" : stats.aliveNodes.length ? "orange" : "gray",
        action: "查看节点"
      })}
      ${jumpModuleCard({
        title: "异常节点",
        metric: `${stats.abnormalNodes}`,
        detail: stats.abnormalNodes ? "需要排查或吊销" : "当前项目没有异常节点",
        panelTitle: "项目 agent 节点",
        tone: stats.abnormalNodes ? "red" : "green",
        action: "定位异常"
      })}
      ${projectModuleCard({
        pageId: "monitor",
        title: "运行任务",
        metric: `${stats.runningDispatches}`,
        detail: stats.runningDispatches ? "查看派发和实时事件" : "当前没有运行中的派发",
        tone: stats.runningDispatches ? "blue" : "green",
        action: "看监控"
      })}
    </div>
    <div class="small muted">注册脚本不是固定命令：必须先在本页签发绑定当前项目的一次性令牌，弹窗会给出直接安装和带完整性校验的安装命令。</div>
  `, {wide: true});
}

function renderProjectAgentScriptHub(project, nodes) {
  const stats = projectAgentStats(project.id, nodes);
  return panel("注册与脚本操作台", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "1 签发加入令牌",
        metric: stats.liveTokens ? `${stats.liveTokens}` : "签发",
        detail: "在当前项目生成一次性加入令牌",
        panelTitle: "注册项目节点",
        tone: stats.liveTokens ? "blue" : "orange",
        action: "去签发"
      })}
      ${jumpModuleCard({
        title: "2 获取安装脚本",
        metric: "签发后",
        detail: "签发成功弹窗给出 直接安装版和 SHA256 校验版 sh 命令，只显示一次",
        panelTitle: "注册项目节点",
        tone: "blue",
        action: "看入口"
      })}
      ${jumpModuleCard({
        title: "3 确认节点自检",
        metric: `${stats.onlineNodes}/${stats.aliveNodes.length}`,
        detail: "脚本执行后回到节点列表确认在线、准入、远程 MCP 和 Skill 工作集",
        panelTitle: "项目 agent 节点",
        tone: stats.onlineNodes ? "green" : stats.aliveNodes.length ? "orange" : "gray",
        action: "看节点"
      })}
      ${projectModuleCard({
        pageId: "monitor",
        title: "4 查看实时回送",
        metric: stats.runningDispatches ? `${stats.runningDispatches}` : "监控",
        detail: "派发状态、执行事件、模型输出摘要和控制 ACK 到执行监控查看",
        tone: stats.runningDispatches ? "blue" : "green",
        action: "看监控"
      })}
    </div>
    <div class="notice">这是第一次接入 agent 的快捷操作台：注册脚本不是固定写死命令；必须先由服务端按当前项目签发一次性加入令牌。安装命令和明文加入令牌只在签发成功弹窗显示一次，列表只能审计和撤销，不能还原明文。</div>
    <div class="small muted">Agent 端执行脚本后只运行 Runtime；后续通过服务端 Gateway、远程 MCP 和最小 Skill 工作集执行任务，并持续回送事件、进度、模型输出摘要和控制 ACK。</div>
  `, {wide: true});
}

function renderProjectAgents() {
  const project = currentProject();
  if (!project) return panel("项目 Agent", noVisibleProjectNotice(), {wide: true});
  const nodes = projectAgentNodes(project.id);
  const scopedAgents = projectScopedAgents(project.id);
  const selectedProfile = scopedAgents.find((agent) => agent.id === selectedAgentProfileId);
  if (selectedAgentProfileId && !selectedProfile) selectedAgentProfileId = "";
  if (selectedProfile) {
    const ownProjectProfile = selectedProfile.projectId === project.id;
    return renderAgentProfileDetail(selectedProfile, {editable: ownProjectProfile && hasPerm("agent:activate"),
      scopeLabel: ownProjectProfile ? `项目专属 · ${project.name || project.id}`
        : `组织共享 · ${agentScopeText(selectedProfile).replace(/^组织级：/u, "")}`});
  }
  const canControlNodes = hasPerm("agent:activate");
  const preferOrgGovernance = perspectiveOf(currentAccount) === "org";
  const toggle = `
    <div class="button-row">
      <button class="${agentViewMode === "table" ? "primary-button" : "secondary-button"}" data-action="agent-view-mode" data-mode="table">列表视图</button>
      <button class="${agentViewMode === "cards" ? "primary-button" : "secondary-button"}" data-action="agent-view-mode" data-mode="cards">卡片视图</button>
    </div>
  `;
  const nodeRows = nodes.map((node) => {
    const timedOut = heartbeatTimedOut(node);
    return row([
      `<span class="hover-wrap"><strong>${esc(node.nodeName || node.nodeId)}</strong>${agentHoverPop(node)}</span><div class="small muted mono">${esc(node.nodeId)}</div>${customBadge(node.registrationScope === "organization" ? "组织共享" : "项目专属", node.registrationScope === "organization" ? "green" : "blue")}`,
      `${timedOut
        ? `${badge("heartbeat_timeout")}<div class="small warn-text">项目页提示：上次状态仍为「${esc(t(node.status) || node.status)}」，但心跳已超过判死阈值</div>`
        : badge(node.status)}${claimMissHint(node)}${selfCheckFailureHint(node)}`,
      badge(node.admission),
      esc(node.display?.region || "-"),
      badge(timedOut ? "offline" : node.display?.health || node.status),
      {v: String(nodeDispatchIds(node).length), c: "num"},
      {v: `${fmtTime(node.lastHeartbeatAt)}${heartbeatStaleHint(node)}`, c: "nowrap"},
      canControlNodes ? agentActions(node, {scope: "project", showDanger: !preferOrgGovernance}) : "-"
    ]);
  }).join("");
  const nodeNotice = nodes.length
    ? `<div class="notice">鼠标悬浮在节点名称上可查看资源、支持模型、网络速度、数据根路径与累计完成、失败。</div>`
    : agentViewMode === "cards"
      ? ""
      : `<div class="notice warn-notice">当前项目还没有任何 agent 节点。要让任务实际执行，请在下面“注册项目节点”签发一次性加入令牌，然后把弹窗里的安装命令放到目标 agent 主机执行。</div>`;
  const bodyHtml = agentViewMode === "cards"
    ? projectAgentCards(nodes, canControlNodes, {showDanger: !preferOrgGovernance})
    : table(["名称", "运行状态", "准入", "地区", "健康度", {label: "当前任务数", c: "num"}, {label: "最近心跳", c: "nowrap"}, "操作"], nodeRows, {emptyText: "当前项目暂无 agent 节点"});
  // 真实产出读下来：这一页在节点列表前曾堆了总览 + 看板 + 四组流程指引（共 20 步），节点列表与注册表单被推到最底下。
  // 阅读型的三组指引默认收起（内容一字不少，摘要写明里面有什么）；可操作的「注册与脚本操作台」保持可见；面板顺序不变。
  return [
    renderProjectAgentsSummary(project, nodes),
    renderProjectAgentsActionBoard(project, nodes),
    guideBundle("接入前先读", [renderProjectAgentRegistrationFlow(project, nodes)], ["Agent 注册流程（5 步）"]),
    renderProjectAgentScriptHub(project, nodes),
    guideBundle("运行与处置指引", [renderProjectAgentExecutionLoop(project, nodes), renderProjectAgentNodeGovernanceGuide(project, nodes)],
      ["Agent 接入与运行闭环（5 步）", "agent 节点处置流程（6 步）"]),
    panel("可调配 Agent 档案", `
      <div class="stack">
        ${renderProjectAgentProfileSummary(project, scopedAgents)}
        <div class="notice">任务组执行时，总控可在当前项目级 Agent 和本组织级 Agent 中选择合适角色；项目级档案只服务当前项目，组织级档案可跨本组织项目复用。</div>
        <div class="agent-profile-table">${table(["档案", "角色", "模型偏好", "作用域", "状态", {label: "信任分", c: "num"}, "Skill", "操作"],
          agentProfileRows(scopedAgents), {emptyText: "当前项目还没有可调配 Agent 档案。可在这里创建项目级档案，或到组织页创建组织级档案。"})}</div>
        ${renderAgentProfileForm({projectId: project.id, title: "创建项目级 Agent 档案", readOnly: !hasPerm("agent:activate")})}
      </div>
    `, {wide: true, headerSide: filterInput("按档案、角色、模型过滤…", "project-agent-profiles")}),
    panel("项目 agent 节点", `<div class="stack">${nodeNotice}${bodyHtml}</div>`,
      {wide: true, headerSide: `${filterInput("按节点名、地区过滤…", "project-nodes")}${toggle}`}),
    panel("注册项目节点", renderJoinTokenSection({projectId: project.id, context: "project"}), {wide: true})
  ].join("");
}

/* ---------------- 组织管理员：项目管理 ---------------- */

function renderOrgProjectsActionBoard({projects, activeProjects, archivedProjects, unhealthyProjects, memberLinks}) {
  const assignableCount = assignableProjects().length;
  return panel("项目管理操作看板", `
    <div class="module-grid">
      ${jumpModuleCard({
        title: "在用项目",
        metric: `${activeProjects.length}`,
        detail: activeProjects.length ? "可继续创建任务组，并在「项目管理」→「项目 Agent」→「注册项目节点」注册 agent" : "当前没有可继续推进的项目",
        panelTitle: "项目列表",
        tone: activeProjects.length ? "blue" : "orange",
        action: "查看项目"
      })}
      ${jumpModuleCard({
        title: "健康异常",
        metric: `${unhealthyProjects}`,
        detail: unhealthyProjects ? "先进入项目列表定位异常项目" : "当前项目健康状态正常",
        panelTitle: "项目列表",
        tone: unhealthyProjects ? "red" : "green",
        action: "定位异常"
      })}
      ${jumpModuleCard({
        title: "已归档",
        metric: `${archivedProjects}`,
        detail: archivedProjects ? "历史保留，不能再创建新工作" : "暂无归档项目",
        panelTitle: "项目列表",
        tone: archivedProjects ? "gray" : "green",
        action: "查看归档"
      })}
      ${jumpModuleCard({
        title: "成员授权",
        metric: `${memberLinks}`,
        detail: memberLinks ? "项目成员与角色授权覆盖情况" : "还没有项目成员授权",
        panelTitle: "项目列表",
        tone: memberLinks ? "blue" : "orange",
        action: "核对授权"
      })}
      ${jumpModuleCard({
        title: "创建项目",
        metric: `${projects.length}`,
        detail: "在组织配额内创建新项目",
        panelTitle: "创建项目",
        tone: "blue",
        action: "创建"
      })}
      ${jumpModuleCard({
        title: "补成员授权",
        metric: `${assignableCount}`,
        detail: assignableCount ? "把用户加入项目并指定角色" : "没有可授权的在用项目",
        panelTitle: "项目成员授权",
        tone: assignableCount ? "blue" : "gray",
        action: "授权"
      })}
    </div>
    <div class="small muted">处理顺序：先核对项目状态、健康度和成员覆盖，再创建项目、归档项目或补成员授权。</div>
  `, {wide: true});
}

function renderOrgProjectsLifecycleGuide({projects, activeProjects, archivedProjects, unhealthyProjects, memberLinks}) {
  const assignableCount = assignableProjects().length;
  return panel("项目治理流程", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "1 创建项目",
        metric: projects.length || "创建",
        detail: "先在组织配额内创建项目，创建人自动成为项目负责人",
        panelTitle: "创建项目",
        tone: projects.length ? "blue" : "orange",
        action: "去创建"
      })}
      ${jumpModuleCard({
        title: "2 成员授权",
        metric: memberLinks,
        detail: "把用户加入项目并指定项目角色，否则只能看到组织账号，不能管理项目",
        panelTitle: "项目成员授权",
        tone: memberLinks ? "blue" : "orange",
        action: "去授权"
      })}
      ${projectModuleCard({
        pageId: "proj-settings",
        title: "3 项目配置",
        metric: activeProjects.length,
        detail: "仓库、基线、默认角色、系统规则、业务规则和角色 Skill 定制在项目设置维护",
        tone: activeProjects.length ? "blue" : "gray",
        action: "去设置"
      })}
      ${projectModuleCard({
        pageId: "proj-agents",
        title: "4 Agent 接入",
        metric: "注册",
        detail: "一次性加入令牌和 sh 安装命令只在目标项目 Agent 页生成",
        tone: activeProjects.length ? "green" : "gray",
        action: "去注册"
      })}
      ${projectModuleCard({
        pageId: "tg",
        title: "5 任务组执行",
        metric: "执行",
        detail: "任务组承载目标、统一语言、角色、工作项和自动派发主线",
        tone: activeProjects.length ? "blue" : "gray",
        action: "去任务组"
      })}
      ${jumpModuleCard({
        title: "6 归档收口",
        metric: archivedProjects,
        detail: unhealthyProjects
          ? "异常项目先修复或关闭任务组，再归档释放管理视野；归档是终态不能继续新建工作"
          : "任务组关闭后再归档，归档是终态不能继续新建工作",
        panelTitle: "项目列表",
        tone: unhealthyProjects ? "orange" : archivedProjects ? "gray" : "green",
        action: "看项目"
      })}
    </div>
    <div class="small muted">组织项目页负责项目生命周期治理；项目内部执行仍回到项目设置、项目 Agent、任务组和执行监控。不要在组织项目页寻找 Agent 注册脚本，脚本必须绑定具体项目后签发。</div>
    <div class="small muted">当前可授权在用项目：${esc(assignableCount)} 个；在用项目：${esc(activeProjects.length)} 个；健康异常：${esc(unhealthyProjects)} 个。</div>
  `, {wide: true});
}

function renderOrgProjects() {
  const projects = state.projects || [];
  const activeProjects = projects.filter((project) => project.status !== "archived");
  const archivedProjects = projects.length - activeProjects.length;
  const unhealthyProjects = projects.filter((project) => !["ok", "healthy", "normal"].includes(project.progress?.health)).length;
  const memberLinks = projects.reduce((sum, project) => sum + (project.members || []).length, 0);
  const projectRows = projects.map((project) => row([
    window.AIMAC_OBJECT_WORKSPACE.projectLink(project, project.name || project.id, {primary: true}),
    badge(project.status),
    progressLine(project.progress?.percent),
    badge(project.progress?.phase),
    badge(project.progress?.health),
    esc((project.members || []).map((member) => `${accountName(member.accountId)}（${grantRoleLabel(member.role)}）`).join("、")),
    // 项目此前没有任何终结路径，于是组织的项目配额只增不减、建满之后再也建不了新的。
    `<div class="button-row">${window.AIMAC_OBJECT_WORKSPACE.projectLink(project, "进入项目")}${window.AIMAC_OBJECT_WORKSPACE.projectLink(project, "成员权限", {page: "proj-members", workspace: "list"})}${window.AIMAC_OBJECT_WORKSPACE.projectLink(project, "项目设置", {page: "proj-settings", workspace: "repositories"})}</div>` + (hasPerm("project:update") && project.status !== "archived"
      ? `<button class="secondary-button" data-action="project-archive" data-project="${esc(project.id)}">归档</button>`
      : project.status === "archived" ? `<span class="small muted">已归档</span>` : "")
  ])).join("");

  return [
    panel("项目管理总览", `
      <div class="metric-grid">
        <div class="metric"><span>项目总数</span><strong>${projects.length}</strong></div>
        <div class="metric"><span>在用项目</span><strong>${activeProjects.length}</strong></div>
        <div class="metric"><span>已归档</span><strong>${archivedProjects}</strong></div>
        <div class="metric"><span>成员授权</span><strong>${memberLinks}</strong></div>
        <div class="metric"><span>健康异常</span><strong>${unhealthyProjects}</strong></div>
      </div>
    `, {wide: true}),
    renderOrgProjectsActionBoard({projects, activeProjects, archivedProjects, unhealthyProjects, memberLinks}),
    renderOrgProjectsLifecycleGuide({projects, activeProjects, archivedProjects, unhealthyProjects, memberLinks}),
    panel("项目列表", table(["项目", "状态", "进度", "阶段", "健康度", "成员", "操作"], projectRows), {wide: true}),
    panel("创建项目", `
      <form class="form-grid" data-form="org-project-create">
        <div class="form-row"><label>项目名称</label><input name="name" required></div>
        <div class="notice">项目在当前组织配额内创建，创建人自动成为项目负责人。</div>
        <button class="primary-button" type="submit">创建项目</button>
      </form>
    `),
    panel("项目成员授权", renderProjectMemberForm())
  ].join("");
}

// "一个项目都没有"与"项目里什么都没有"是两种处境，下一步完全不同：前者要去要/建一个项目，
// 后者要去建任务组。原先只有项目概览分得清 —— 任务组和人工指令一律说"当前项目暂无任务组"，
// 而此刻根本没有"当前项目"；执行监控更是直接摆出十一张空表，一句解释都没有。
// 实测普通成员首次登录看到的就是这几屏。文案按【这个人能做什么】分流，只此一处。
function noVisibleProjectNotice() {
  const perspective = perspectiveOf(currentAccount);
  const next = perspective === "system"
    ? "切到「系统管理」→「组织管理」开通组织并交付初始组织管理员；项目由对应组织管理员在「组织管理」→「项目列表」创建。"
    : perspective === "org"
      ? "切到「组织管理」→「项目列表」创建项目，或把已有项目授权给成员。"
      : "请联系组织管理员为你分配项目。";
  return `<div class="notice">当前账号暂无可见项目。${esc(next)}</div>`;
}

// 判据要和这句话完全对齐：说的是"一个可见项目都没有"，不是"当前没选中项目"
// （后者在项目存在、只是还没选上时也成立，那时这句话是错的）。
function hasNoVisibleProject() {
  return !visibleProjects().length;
}

/* ---------------- 成员：项目概览 ---------------- */

function projectModuleCard({pageId, title, metric, detail, action, tone = "blue"}) {
  return `
    <button class="module-card tone-${esc(tone)}" data-menu="${esc(pageId)}">
      <span class="module-title">${esc(title)}</span>
      <strong>${esc(metric)}</strong>
      <span class="module-detail">${esc(detail)}</span>
      <span class="module-action">${esc(action || "进入")}</span>
    </button>
  `;
}

function projectMemberRoleStats(project) {
  const members = project?.members || [];
  const countRole = (role) => members.filter((member) => member.role === role).length;
  return {
    total: members.length,
    admins: countRole("project_owner") + countRole("project_admin"),
    owners: countRole("task_group_owner"),
    reviewers: countRole("reviewer"),
    agentOperators: countRole("agent_operator"),
    viewers: countRole("viewer")
  };
}

function projectMemberRoleImpact(role) {
  if (role === "project_owner" || role === "project_admin") return "项目配置、成员授权和管理入口";
  if (role === "task_group_owner") return "任务组控制和工作项推进";
  if (role === "reviewer") return "人工审核、定稿和验收";
  if (role === "agent_operator") return "Agent 加入令牌和节点操作";
  return "查看项目状态和执行记录";
}

function renderProjectMemberRoleForm(project, membership) {
  const isOwner = membership.accountId === project.ownerAccountId || membership.role === "project_owner";
  if (isOwner) return `<div class="notice">项目负责人身份不能通过普通角色表单修改。</div>`;
  if (!hasPerm("project:grant")) return `<div class="notice warn-notice">当前账号没有项目授权管理权限，只能查看。</div>`;
  return `<form class="form-grid" data-form="project-member">
    <input type="hidden" name="projectId" value="${esc(project.id)}">
    <input type="hidden" name="accountId" value="${esc(membership.accountId)}">
    <div class="form-row"><label>新的项目角色</label>${decisionSelect("role", [
      ["project_admin", "项目管理员"],
      ["task_group_owner", "任务组负责人"],
      ["reviewer", `${GRANT_ROLE_LABELS.reviewer}（可做人工定稿/验收）`],
      ["agent_operator", "智能体操作员"],
      ["viewer", "观察者"]
    ], "请选择新的项目角色…", {selected: membership.role})}</div>
    <div class="notice">保存后会撤销该成员在当前项目上的旧活动角色，只保留新的项目角色；不会改动其它项目。</div>
    <button class="primary-button" type="submit">保存项目角色</button>
  </form>`;
}

function renderProjectMembersLifecycleGuide(project, stats) {
  return panel("成员协作流程", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "1 组织成员入网",
        metric: "组织",
        detail: "没有账号时先由组织管理员邀请成员，项目页不创建组织账号",
        panelTitle: "项目成员授权",
        tone: "gray",
        action: "看边界"
      })}
      ${jumpModuleCard({
        title: "2 项目角色授权",
        metric: stats.total,
        detail: "在当前项目授予项目管理员、任务组负责人、评审人、智能体操作员或观察者",
        panelTitle: "项目成员授权",
        tone: stats.total ? "blue" : "orange",
        action: "去授权"
      })}
      ${projectModuleCard({
        pageId: "proj-agents",
        title: "3 Agent 权限",
        metric: stats.agentOperators,
        detail: "智能体操作员或项目管理员可以签发当前项目 agent 加入令牌",
        tone: stats.agentOperators || stats.admins ? "blue" : "orange",
        action: "看 Agent"
      })}
      ${projectModuleCard({
        pageId: "tg",
        title: "4 任务组权限",
        metric: stats.owners,
        detail: "任务组负责人获得任务组控制入口，评审人获得审核入口",
        tone: stats.owners || stats.reviewers ? "blue" : "orange",
        action: "看任务组"
      })}
      ${projectModuleCard({
        pageId: "monitor",
        title: "5 执行监控",
        metric: "实时",
        detail: "授权落位后通过监控页确认派发、事件、关闭门和控制 ACK",
        tone: "green",
        action: "看监控"
      })}
    </div>
    <div class="small muted">授权不会直接启动任务。成员权限决定谁能管理 Agent、任务组、人工审核和执行监控；组织账号的创建、停用和邀请重发在「组织管理」→「成员管理」。</div>
  `, {wide: true});
}

function renderProjectMembers() {
  const project = currentProject();
  if (!project) return panel("成员权限", noVisibleProjectNotice(), {wide: true});
  const stats = projectMemberRoleStats(project);
  const selectedMembership = (project.members || []).find((member) => member.accountId === selectedProjectMemberId);
  if (selectedProjectMemberId && !selectedMembership) selectedProjectMemberId = "";
  if (selectedMembership) {
    const account = (orgMembers || []).find((item) => item.accountId === selectedMembership.accountId)
      || (state.accounts || []).find((item) => item.accountId === selectedMembership.accountId) || null;
    const taskGroupGrants = taskGroupGrantsForAccount(selectedMembership.accountId, project.id);
    const isOwner = selectedMembership.accountId === project.ownerAccountId || selectedMembership.role === "project_owner";
    const canGrant = hasPerm("project:grant");
    return window.AIMAC_GOVERNANCE_WORKSPACE.projectMemberDetail({
      project,
      membership: selectedMembership,
      account,
      taskGroupGrants,
      roleFormHtml: renderProjectMemberRoleForm(project, selectedMembership),
      taskGroupFormHtml: canGrant ? renderTaskGroupGrantForm(project, {accountId: selectedMembership.accountId})
        : `<div class="notice warn-notice">当前账号没有项目授权管理权限，只能查看任务组角色。</div>`,
      removeActionHtml: canGrant && !isOwner
        ? `<button class="danger-button" data-action="project-member-revoke" data-project="${esc(project.id)}" data-account="${esc(selectedMembership.accountId)}">移出当前项目</button>` : "",
      helpers: {statusBadge, customBadge, t, grantRoleLabel, taskGroupNameOf, roleImpact: projectMemberRoleImpact,
        canGrant, panel: renderPanel}
    });
  }
  const memberRows = (project.members || []).map((member) => row([
    `<strong>${esc(accountName(member.accountId))}</strong><div class="small muted mono">${esc(member.accountId)}</div>`,
    esc(grantRoleLabel(member.role)),
    projectMemberRoleImpact(member.role),
    `<button class="primary-button" data-action="open-project-member-detail" data-account="${esc(member.accountId)}">查看权限</button>`
  ])).join("");
  const grantPanel = hasPerm("project:grant")
    ? renderProjectMemberForm({projectId: project.id})
    : `<div class="notice warn-notice">当前账号没有“项目授权管理(project:grant)”权限，只能查看本项目成员角色。需要补授权时，请项目管理员或组织管理员处理。</div>`;
  return [
    panel("项目成员列表", `<div class="member-counts" aria-label="项目成员统计">
      <span>共 <strong>${stats.total}</strong> 人</span><span>管理员 ${stats.admins}</span>
      <span>任务组负责人 ${stats.owners}</span><span>评审人 ${stats.reviewers}</span>
      <span>智能体操作员 ${stats.agentOperators}</span><span>观察者 ${stats.viewers}</span>
    </div>` + (memberRows
      ? table(["成员", "项目角色", "角色影响", "操作"], memberRows)
      : `<div class="notice warn-notice">当前项目还没有成员授权。没有成员角色时，任务组控制、人工审核和 Agent 操作入口会缺少负责人。</div>`), {wide: true,
      headerSide: `${filterInput("按成员、角色过滤…", "project-members")}${hasPerm("project:grant") ? `<button class="primary-button" data-jump-panel="项目成员授权">添加项目成员</button>
        <button class="secondary-button" data-jump-panel="任务组权限授权">授任务组权限</button>` : ""}`}),
    panel("项目成员授权", grantPanel),
    panel("任务组权限授权", hasPerm("project:grant")
      ? renderTaskGroupGrantForm(project)
      : `<div class="notice warn-notice">当前账号没有“项目授权管理(project:grant)”权限，只能查看任务组授权列表。</div>`, {wide: true}),
    panel("任务组权限列表", renderTaskGroupGrantList(project), {wide: true, headerSide: filterInput("按任务组、账号、角色过滤…", "task-group-grants")}),
    guideBundle("协作流程指引", [renderProjectMembersLifecycleGuide(project, stats)], ["成员协作流程（5 步）"]),
  ].join("");
}

function projectHubHtml(project) {
  if (!workspaces.showHub()) return "";
  return window.AIMAC_OBJECT_WORKSPACE.projectSummary({
    project, agentOnline: Number(state.fleet?.online || 0), agentTotal: Number(state.fleet?.total || 0),
    repositoryCount: projectRepositoryConfigs(project).length,
    helpers: {badge, fmtTime, progressLine}
  });
}

function projectCommandCenterHtml(project, groups) {
  if (workspaces.current("proj-overview")?.id !== "overview") return "";
  const decision = window.AIMAC_PROJECT_COMMAND_CENTER.decide({
    project,
    groups,
    fleet: state.fleet || {},
    repositories: projectRepositoryConfigs(project),
    todos: todoCountsByPage(),
    statsFor: taskGroupOperationalStats,
    canControl: hasProjectPermission("task_group:control") || groups.some((group) => hasGroupPerm(group.id, "task_group:control"))
  });
  return window.AIMAC_PROJECT_COMMAND_CENTER.render(project, decision);
}

function projectRepositoryConfigs(project) {
  const configured = project?.config?.repositories;
  return Array.isArray(configured) && configured.length ? configured
    : Array.isArray(project?.repositories) ? project.repositories : [];
}

// 「项目操作路径」（7 张入口卡片 + 推荐顺序）已撤：与顶部「流程导航」是同一件事的两份说法，人不知道该看哪份。
// 人定（2026-09-05）：留更符合人工查阅的那份 —— 流程导航按建项目→任务组→任务→agent→启动→审核→复核→指令逐步走，
// 每步带实时状态、无权说明与直达；它原先缺的「项目设置」「成员权限」两步已并入流程导航。
function renderRepositoryOutputOverview(repoTargets) {
  const repoIds = new Set(repoTargets.map((target) => target.repositoryId || "-"));
  const effectiveTargets = repoTargets.filter((target) => !["superseded", "rejected"].includes(target.status));
  const supersededTargets = repoTargets.filter((target) => target.status === "superseded");
  const pathGroups = new Set(repoTargets.map((target) => (target.pathAllowlist || []).join("、") || "-"));
  const branches = new Set(repoTargets.map((target) => `${target.repositoryId || "-"}@${target.branch || "-"}`));
  return panel("仓库产出归属概览", `
    <div class="module-grid action-grid">
      ${summaryMetric("仓库数", repoIds.size, `${repoTargets.length} 条明细记录`)}
      ${summaryMetric("仓库分支", branches.size, "按仓库和分支去重")}
      ${summaryMetric("生效目标", effectiveTargets.length, "未被取代或驳回的写入边界")}
      ${summaryMetric("已被取代", supersededTargets.length, "原因仍在下面明细表查看")}
      ${summaryMetric("允许路径组", pathGroups.size, "同一组允许路径按配置去重")}
      ${jumpModuleCard({
        title: "查看明细",
        metric: repoTargets.length,
        detail: "完整任务组、仓库、分支、状态和允许路径仍保留在下方表格",
        panelTitle: "仓库产出归属",
        tone: repoTargets.length ? "blue" : "gray",
        action: "看表格"
      })}
    </div>
    <div class="small muted">这只是阅读概览，不改变总控选择仓库、绑定写入边界和 agent 写仓库的执行逻辑；多仓库、多任务组的完整记录仍以 Git 仓库产出和下方明细为准。</div>
  `, {wide: true});
}

// 「流程导航」：把人的路径串成一条线——登入后我在第几步、下一步去哪。此前各页的引导是分散的（关闭门出口、
// 节点离线指引、令牌签发说明、空态句），没有一条贯穿的线。每一步的状态都从本页手上的真实数据算
// （tasks 视图 + 基底 fleet，不发新请求）；「人工审核」步复用 pendingForMe()，与「待你处理」同一口径；
// 只对当前账号菜单里有的页摆「前往」（没权限的页不摆一个点了会拒的按钮）。
function workflowGuidePanel(project, groups) {
  const fleet = state.fleet || {};
  const online = Number(fleet.online || 0);
  const registered = Number(fleet.total || 0);
  // 接入这条链有三个中间态，卡在哪一环要分开说：签了令牌没人用（去 agent 主机上装）/ 注册了但全离线（恢复心跳）/ 在线但另有离线。
  const pendingTokens = (state.agentJoinTokens || []).filter((token) => token.projectId === project.id && token.status === "issued"
    && !(token.expiresAt && new Date(token.expiresAt).getTime() <= serverNow())).length;
  const offline = Math.max(0, registered - online);
  const groupIds = new Set(groups.map((taskGroup) => taskGroup.id));
  const workItemCount = groups.reduce((sum, taskGroup) => sum + Number(taskGroup.workItemCount ?? (taskGroup.workItems || []).length), 0);
  const dispatches = (state.agentDispatches || []).filter((item) => item.projectId === project.id || groupIds.has(item.taskGroupId)).length;
  const todo = pendingForMe();
  // 「待你处理」的桶各有去向页：定稿/授权/审批/发现项在人工审核页；评审计划/评审包/质量门豁免/规则来源/升级候选/
  // 卡住的执行方案/共享定义在执行监控页。把总数全算成"人工审核"会让找"复核"的人去错页——按去向页分开算、分开指路。
  const countOn = (pageId) => (todo.buckets || []).filter((bucket) => bucket.page === pageId).reduce((sum, bucket) => sum + Number(bucket.count || 0), 0);
  const reviewTodo = countOn("review");
  const recheckTodo = countOn("monitor");
  const othersOn = (pageId) => Number((todo.othersByPage || {})[pageId] || 0);
  const reviewOthers = othersOn("review");
  const recheckOthers = othersOn("monitor");
  const queuedDirectives = (state.humanDirectives || []).filter((item) => item.status === "queued" && groupIds.has(item.taskGroupId)).length;
  const openBarriers = (state.closeBarriers || []).filter((item) => groupIds.has(item.taskGroupId) && (item.blockers || []).length).length;
  const visible = new Set(menuForCurrentSection(perspectiveOf(currentAccount), page).filter((item) => item.id).map((item) => item.id));
  const go = (id) => visible.has(id) ? `<button class="secondary-button" data-menu="${esc(id)}">前往</button>` : "";
  // 「项目操作路径」并入后的两步：仓库没配时 agent 的产出没有落点；选了凭证模式却没填密钥的仓库要点名（配了等于没配）。
  const repos = projectRepositoryConfigs(project);
  const credentialMissing = repos.filter((repo) => {
    const mode = repo.credentialMode || repo.credential?.mode || "none";
    return mode !== "none" && !(repo.credential?.passwordSet || repo.credential?.apiKeySet || repo.credential?.sealedSecret);
  }).length;
  const ruleCount = (project.config?.systemRules || []).length + (project.config?.businessRules || []).length;
  const members = (project.members || []).length;
  const steps = [
    {title: "项目设置（仓库与凭证 / 规则 / 默认角色 / 角色 Skill 定制）", done: repos.length > 0 && !credentialMissing, attention: credentialMissing > 0, page: "proj-settings",
      state: repos.length
        ? `${repos.length} 个仓库 · ${ruleCount} 条规则${credentialMissing ? `；其中 ${credentialMissing} 个仓库选了凭证模式但从没填过密钥 —— 配了等于没配，去填并点「测试连接」` : ""}`
        : "还没配仓库：agent 的产出没有落点，先添加仓库并填凭证"},
    {title: "成员权限", done: members > 0, page: "proj-members",
      state: members ? `${members} 位成员；审核 / 任务组控制权限按具体任务组授予` : "还没有成员授权：项目管理员、评审人在这里授予"},
    {title: "接入项目 Agent", done: online > 0, page: "proj-agents",
      state: online
        ? `${online} 台在线${offline ? `，另 ${offline} 台离线` : ""}`
        : (registered
          ? `已注册 ${registered} 台，但没有在线的——活派不出去：先恢复 agent 主机/进程心跳`
          : (pendingTokens
            ? `已签发 ${pendingTokens} 张加入令牌待使用，还没有节点注册：到 agent 主机上执行安装命令`
            : "尚未接入：先签发加入令牌，再在 agent 主机上执行安装命令"))},
    {title: "创建任务组", done: groups.length > 0, page: "tg", state: groups.length ? `${groups.length} 个任务组` : "还没有任务组"},
    {title: "创建工作项（任务）", done: workItemCount > 0, page: "tg", state: workItemCount ? `${workItemCount} 个工作项` : "还没有工作项：到任务组里「创建工作项」"},
    {title: "启动执行", done: dispatches > 0, page: "monitor",
      // 人在这里就能推一拍：同一个动作、同一套回执（被挡/推进 N 项/无事可做）；只对能编排的账号摆，看得到却按不动＝杠杆不可达。
      action: hasPerm("task_group:orchestrate") && workItemCount > 0 ? `<button class="secondary-button" data-action="orchestrator-run">推进一拍</button>` : "",
      state: dispatches ? `已派发 ${dispatches} 次` : (workItemCount && online ? "还没派发：后台每拍自动推进；等不及可到「执行监控」点「运行自治循环」" : "有工作项且有在线 agent 后自动开始")},
    {title: "人工审核 / 定稿", done: reviewTodo === 0, attention: reviewTodo > 0, page: "review",
      state: reviewTodo ? `${reviewTodo}${todo.partial ? "+" : ""} 项等你处理（定稿 / 授权 / 审批 / 发现项）`
        : (reviewOthers ? `有 ${reviewOthers} 项在等有权的人处置——你在相关任务组上没有审核权限，只能看` : "暂无等你处理的审核项")},
    {title: "人工复核 / 阻塞处置", done: recheckTodo === 0, attention: recheckTodo > 0, page: "monitor",
      state: recheckTodo ? `${recheckTodo} 项等你收尾（评审计划 / 评审包 / 卡住的执行方案 / 质量门豁免等）`
        : (recheckOthers ? `有 ${recheckOthers} 项在等有权的人处置——你在相关任务组上没有相应权限，只能看` : "暂无等你收尾的复核项")},
    {title: "人工指令", done: queuedDirectives === 0, attention: queuedDirectives > 0, page: "directives",
      state: queuedDirectives ? `${queuedDirectives} 条指令待编排消费` : "需要干预（暂停/纠偏/调优先级）时在这里下达"},
    {title: "收口关闭", done: groups.length > 0 && openBarriers === 0, attention: openBarriers > 0, page: "monitor",
      state: openBarriers ? `${openBarriers} 个任务组还有关闭门阻塞` : (groups.length ? "关闭门无阻塞" : "—")}
  ];
  return panel("流程导航", `<div class="stack">${steps.map((step, index) => `
    <div class="record-meta"><span>${index + 1}. <strong>${esc(step.title)}</strong></span>
      <span class="${step.attention ? "warn-text" : (step.done ? "" : "muted")}">${step.attention ? "● " : (step.done ? "✓ " : "○ ")}${esc(step.state)}</span>
      ${step.action || ""}${go(step.page)}</div>`).join("")}
    <div class="small muted">按当前项目实时计算：○ 未开始 · ✓ 已就绪 · ● 等你处理</div></div>`, {wide: true});
}


function renderProjectOverview() {
  const project = currentProject();
  if (!project) {
    // 空态要按【这个人能做什么】说话。原先一律是"请联系组织管理员分配" —— 而系统管理员
    // 正是那个该去建项目的人，组织管理员也是；把他们支去找别人，是新部署第一步就撞上的死胡同。
    // （实测：全新部署、以系统管理员登录、打开项目概览，看到的就是这句。）
    return panel("项目概览", noVisibleProjectNotice(), {wide: true});
  }
  const groups = projectTaskGroups();
  const openGroups = groups.filter((taskGroup) => !settledTaskGroupStatuses.has(taskGroup.status));
  const blockers = groups.flatMap((taskGroup) => taskGroup.blockers || []);
  // 这个数是【按任务组】平均，而同一屏顶上那个大百分比是服务端【按工作项】平均算的
  // （control-plane-core 的 recomputeProgressSnapshots）。两个数并排、公式不同，
  // 实测种子上就是 73% 与 75% —— 标签原先写"事项完成度"，读起来像是同一件事的第二种说法。
  // 两个都有用（一个看整体、一个看有没有某个组在拖），但必须各自说清是怎么算的。
  const avgProgress = groups.length ? Math.round(groups.reduce((sum, taskGroup) => sum + Number(taskGroup.progress || 0), 0) / groups.length) : 0;
  const groupRows = groups.map((taskGroup) => row([
    window.AIMAC_OBJECT_WORKSPACE.groupLink(taskGroup, taskGroup.name || taskGroup.id, "tg", true),
    badge(taskGroup.status),
    badge(taskGroup.phase),
    progressLine(taskGroup.progress),
    badge(taskGroup.health),
    // 这一列数的是【关闭门的阻塞项】。而人扫这张表时想知道的是"哪个组卡住了" ——
    // 同一个组里被挡住的派发不算在这个数里，于是一个有 2 个派发被挡住的组在这一行显示 0，
    // 他就不会再往下找了（实测：真实运行态上正是这样）。上面「受阻项」那一格已经按同一个
    // 道理补过差额，这一行照它：不改这个数的口径，把另一件事说出来。
    {v: (() => {
      const blocked = (taskGroup.blockers || []).length;
      const stuck = (state.agentDispatches || [])
        .filter((item) => item.taskGroupId === taskGroup.id && item.status === "blocked").length;
      return stuck ? `${blocked} <span class="warn-text">· 派发被挡 ${stuck}</span>` : String(blocked);
    })(), c: "num"},
    `<div class="button-row">${window.AIMAC_OBJECT_WORKSPACE.groupLink(taskGroup, "任务", "tasks")}${window.AIMAC_OBJECT_WORKSPACE.groupLink(taskGroup, "监控", "monitor")}</div>`
  ])).join("");
  const repoTargets = (state.repositoryOutputs || []).filter((target) => target.projectId === project.id);
  const repoRows = repoTargets.map((target) => row([
    esc(taskGroupNameOf(target.taskGroupId)),
    `<span class="mono">${esc(target.repositoryId)}</span>`,
    `<span class="mono">${esc(target.branch)}</span>`,
    // 「已替代」是个终态，而人接着要问的就是【为什么】。supersededReason 三处都在写，
    // 全仓零处读 —— 与控制命令的 ackResult 同一形状：字段在记录里，屏幕上只有一个状态徽标。
    {v: badge(target.status) + (target.supersededReason
      ? `<div class="small muted">${esc(explainCoded(target.supersededReason))}</div>` : "")},
    `<span class="mono">${esc((target.pathAllowlist || []).join("、"))}</span>`
  ])).join("");
  // 只展示最新 10 条（数组是 unshift 追加的，最新在前）。总数要取【筛完范围之后】的长度：
  // 拿 state.agentExecutionEvents.length 会把别的任务组也算进去，报出一个人在这页看不到的数。
  const eventsInScope = (state.agentExecutionEvents || []).filter((event) => groups.some((taskGroup) => taskGroup.id === event.taskGroupId));
  const events = eventsInScope.slice(0, 10).map((event) => row([
    {v: fmtTime(event.createdAt), c: "nowrap"},
    badge(event.eventType, "blue"),
    badge(event.status),
    {v: esc(event.summary || "-") + repositoryFailureAction(event), c: "text-clip"}
  ])).join("");

  return [
    projectCommandCenterHtml(project, groups),
    workflowGuidePanel(project, groups),
    // 项目概览是项目负责人一直盯着的那一页，也是最容易被"看起来一切正常"骗到的一页：
    // 实测真实数据下它显示"健康度 ok、完成度 75%"，而当时一个在线 agent 都没有、
    // 3 个单元交出去之后永远不会动 —— 任务组页和监控页都说了这件事，唯独这一页不说。
    // 提示复用同一个函数，措辞与那两页一致，人不必在不同页面上对同一件事建立两套理解。
    projectRepositoryConfigs(project).length ? "" : cellsWaitingWithNoAgentNotice(groups),
    wipCapacityNotice(groups),
    projectHubHtml(project),
    panel("关键指标", `
      <div class="metric-grid">
        <div class="metric">${window.AIMAC_OBJECT_WORKSPACE.projectLink(project, "任务组", {page: "tg", workspace: "list", primary: true})}<strong>${openGroups.length}/${groups.length}</strong></div>
        <div class="metric"><span>任务组平均进度</span><strong>${avgProgress}%</strong>
          <div class="small muted">按任务组平均；上面那个总进度是按工作项平均的，两者不一定相等</div></div>
        <div class="metric">${window.AIMAC_OBJECT_WORKSPACE.projectLink(project, "受阻项", {page: "monitor", workspace: "barriers", primary: true})}<strong>${blockers.length}</strong>
          ${(() => {
            // 这一格数的是【任务组身上的 blockers】（关闭门那一套）。而「被挡住的派发」是另一回事，
            // 它出现在执行监控页上，那里明说「有执行被挡住，需要人处理」——
            // 项目概览是人每天先看的那一屏，这里显示 0 的时候人就不会再往下找了。
            // （实测：这里 0，同一份数据里有 2 个 blocked 派发，监控页正提示要人处理。
            //  与上一格「待人工确认」是同一种病，修法也照它：不改这个数的口径，把差额说出来并给出去处。）
            const stuck = (state.agentDispatches || []).filter((item) => item.status === "blocked").length;
            if (!stuck) return "";
            return `<div class="small warn-text">另有 ${stuck}${countSuffix("agentDispatches")} 个派发被挡住 ——`
              + " 到「执行监控」页看它们卡在哪</div>";
          })()}
        </div>
        <div class="metric">${window.AIMAC_OBJECT_WORKSPACE.projectLink(project, "待人工确认", {page: "review", workspace: "pending", primary: true})}<strong>${pendingConfirmCount}</strong>
          ${(() => {
            // 这一格只数【确认单】一类。而等人拍板的东西有九类，散在人工审核与执行监控两页上 ——
            // 项目概览是人每天先看的那一屏，它显示 0 的时候人就不会再往下找了
            //（实测：这里报 0，同一时刻人工审核页报"共 3 项等待你处理"）。
            // 两个数出自同一处判据（pendingForMe），这里把差额说出来并给出去处。
            const todo = pendingForMe();
            const others = Math.max(0, todo.total - pendingConfirmCount);
            // 这个数【不按权限过滤】（它是项目层面的事实），而旁边那句"等你处理"是按权限算的。
            // 只读成员看到的因此是一个光秃秃的数：管理员那边还有「另有 N 项等你处理 → 去哪处置」，
            // 他这边什么都没有，点进人工审核页才被告知"只能看、不能动"。
            // 口径不改（改了就与人工审核页那张卡对不上），把这件事直接说出来。
            if (!others && pendingConfirmCount > 0 && !todo.total) {
              return `<div class="small">这些你都没有定稿权限，只能看 —— 它们在等各自任务组里有权的人处置</div>`;
            }
            if (!others) return "";
            return `<div class="small warn-text">另有 ${others} 项${todo.partial ? "+" : ""}等你处理`
              + `（评审计划、发现项、授权请求…）—— 到「人工审核」页看汇总</div>`;
          })()}</div>
      </div>
    `),
    panel("任务组一览", table(["任务组", "状态", "阶段", "进度", "健康度", {label: "受阻数", c: "num"}, "操作"], groupRows), {wide: true,
      headerSide: `${window.AIMAC_OBJECT_WORKSPACE.projectLink(project, "全部任务组", {page: "tg", workspace: "list"})}${hasProjectPermission("task_group:control") && project.status !== "archived" ? `<button class="primary-button" data-workspace-page="tg" data-workspace="create">创建任务组</button>` : ""}`}),
    panel("最新执行事件", table([{label: "时间", c: "nowrap"}, "事件", "状态", {label: "摘要", c: "text-clip"}], events,
      {moreText: moreText(eventsInScope.length, 10, "agentExecutionEvents")})),
    renderRepositoryOutputOverview(repoTargets),
    panel("仓库产出归属", table(["任务组", "仓库", "分支", "状态", "允许路径"], repoRows))
  ].join("");
}

// 「这条工作项为什么回到就绪 / 它的方案是谁拍的板」—— 答案一直写在记录里
//（humanDecisionRef / planFinalizationRef，core 里注释写明是【溯源引用】），
// 而全仓零处读：屏幕上被人重开过的工作项和从没卡过的长得一模一样。
// 引用指向的记录可能已经被集合上限顶掉 —— 那时要说「查不到那条记录」，不能当成没有过这件事。
function humanTraceHtml(workItem) {
  const parts = [];
  if (workItem.humanDecisionRef) {
    const directive = (state.humanDirectives || []).find((item) => item.directiveId === workItem.humanDecisionRef);
    parts.push(directive
      ? `<span>由人工指令重开：${esc(accountName(directive.issuedBy))} · ${esc(fmtTime(directive.createdAt))}</span>`
      : `<span>由人工指令重开（指令 ${esc(workItem.humanDecisionRef)} 已不在当前列表里，查不到是谁下的）</span>`);
  }
  if (workItem.planFinalizationRef) {
    const request = (state.humanConfirmationRequests || [])
      .find((item) => item.requestId === workItem.planFinalizationRef);
    const decision = request?.decision;
    parts.push(decision
      ? `<span>方案已由人定稿：${esc(accountName(decision.decidedBy))} · ${esc(fmtTime(decision.decidedAt))}</span>`
      : `<span>方案已由人定稿（确认单 ${esc(workItem.planFinalizationRef)} 已不在当前列表里，查不到是谁定的）</span>`);
  }
  return parts.join("");
}

function taskGroupById(taskGroupId) {
  return (state.taskGroups || []).find((taskGroup) => taskGroup.id === taskGroupId) || null;
}
function taskGroupNameOf(taskGroupId) {
  return (state.taskGroups || []).find((taskGroup) => taskGroup.id === taskGroupId)?.name || taskGroupId || "-";
}

/* ---------------- 成员：任务组 ---------------- */

// 语种名要显示中文：后端存的 languageName 是英文（"Chinese"/"Japanese"），
// 直接摆到中文界面上就成了"语言：Chinese"。界面本来就有 LANGUAGE_OPTIONS（zh-CN → 中文），
// 先按语言标签查它，查不到再退回后端给的名字（那时至少还有个名字，好过空白）。
// "没上报过进度"与"上报了 0%"是两回事：对一个【已完成】的派发显示"0%"，
// 人会以为它什么都没干成（实测在真实状态上读出来的正是"已完成 0%"）。
// 没有数就写"—"，让人知道这一栏是空的，而不是给一个看起来精确的假数。
function percentCell(value) {
  return value === undefined || value === null || value === "" ? "—" : `${esc(value)}%`;
}

function languageLabel(policy) {
  const tag = policy?.languageTag;
  const known = LANGUAGE_OPTIONS.find(([value]) => value === tag);
  return known ? known[1] : (policy?.languageName || tag || "中文");
}


function languageSelectOptions(selected) {
  const known = LANGUAGE_OPTIONS.some(([value]) => value === selected);
  const options = known || !selected ? LANGUAGE_OPTIONS : [[selected, selected], ...LANGUAGE_OPTIONS];
  return options.map(([value, label]) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(label)} · ${esc(value)}</option>`).join("");
}

function renderTaskGroupsSummary(groups) {
  const activeGroups = groups.filter((taskGroup) => !["closed", "cancelled", "archived", "superseded"].includes(taskGroup.status));
  const avgProgress = groups.length
    ? Math.round(groups.reduce((sum, taskGroup) => sum + Number(taskGroup.progress || 0), 0) / groups.length)
    : 0;
  const workItemCount = groups.reduce((sum, taskGroup) =>
    sum + Number(taskGroup.workItemCount ?? (taskGroup.workItems || []).length), 0);
  const blockedCount = groups.reduce((sum, taskGroup) => sum
    + Number((taskGroup.blockers || []).length)
    + (taskGroup.workItems || []).filter((workItem) =>
      Boolean(workItem.blockedReason) || ["blocked", "needs_decision"].includes(workItem.status)).length, 0);
  const languages = new Map();
  for (const taskGroup of groups) {
    const label = languageLabel(taskGroup.languagePolicy);
    languages.set(label, (languages.get(label) || 0) + 1);
  }
  const languageText = groups.length
    ? [...languages].map(([label, count]) => `${label} ${count}`).join("、")
    : "暂无任务组";
  return panel("任务组总览", `
    <div class="metric-grid">
      ${summaryMetric("任务组", groups.length, "当前项目下的任务组总数")}
      ${summaryMetric("进行中", activeGroups.length, "未关闭、未取消的任务组")}
      ${summaryMetric("平均进度", `${avgProgress}%`, "按任务组进度平均")}
      ${summaryMetric("工作项", workItemCount, "任务组内拆分出的执行单元")}
      ${summaryMetric("受阻提示", blockedCount, "需要查看或处置的阻塞信号")}
      ${summaryMetric("统一语言", languages.size || 0, "任务组级协作语言种类")}
    </div>
    <div class="small muted">语言分布：${esc(languageText)}。先看处置看板和生命周期，再决定是否创建新任务组、追加工作项或进入 Agent/监控/审核模块。</div>
  `, {wide: true});
}

function renderTaskGroupAttentionBoard(groups) {
  if (!groups.length) {
    return panel("任务组处置看板", `<div class="notice">当前项目暂无任务组。先创建任务组，系统才会开始拆分工作项、分配角色并调度 agent。</div>`, {wide: true});
  }
  const fleet = (state || {}).fleet || {};
  const noOnlineAgent = Number(fleet.online || 0) <= 0;
  const waitingStatuses = new Set(["assigned", "in_progress", "checkpoint_submitted"]);
  const groupFacts = groups.map((taskGroup) => {
    const groupId = taskGroup.id;
    const barrier = (state.closeBarriers || []).find((item) => item.taskGroupId === groupId);
    const barrierBlocks = barrier && !barrier.satisfied ? (barrier.blockingObjects || []).length : 0;
    const blockedDispatches = (state.agentDispatches || [])
      .filter((item) => item.taskGroupId === groupId && item.status === "blocked").length;
    const activeDispatches = (state.agentDispatches || [])
      .filter((item) => item.taskGroupId === groupId && !terminalDispatchStatuses.has(item.status)).length;
    const blockedWorkItems = (taskGroup.workItems || [])
      .filter((item) => Boolean(item.blockedReason) || ["blocked", "needs_decision"].includes(item.status)).length;
    const waitingWithoutAgent = noOnlineAgent && (taskGroup.workItems || [])
      .filter((item) => waitingStatuses.has(item.status)).length;
    const pendingHuman = [
      ...(state.humanConfirmationRequests || []).filter((item) => item.taskGroupId === groupId && item.status === "pending"),
      ...(state.permissionRequests || []).filter((item) => item.taskGroupId === groupId && item.status === "pending_approval"),
      ...(state.approvalRequests || []).filter((item) => item.taskGroupId === groupId && ["requested", "quorum_collecting"].includes(item.status)),
      ...(state.findings || []).filter((item) => item.taskGroupId === groupId && !["resolved", "closed", "dismissed", "wontfix"].includes(item.status))
    ].length;
    const isSettled = ["closed", "aborted", "cancelled", "archived", "superseded"].includes(taskGroup.status);
    const score = barrierBlocks * 5 + blockedDispatches * 4 + pendingHuman * 3 + waitingWithoutAgent * 3 + blockedWorkItems * 2 + activeDispatches;
    const label = score
      ? "需处理"
      : isSettled
        ? "已收口"
        : activeDispatches
          ? "运行中"
          : "待启动";
    const tone = score ? "red" : isSettled ? "gray" : activeDispatches ? "blue" : "green";
    const details = [
      barrierBlocks ? `关闭门 ${barrierBlocks}` : "",
      blockedDispatches ? `派发被挡 ${blockedDispatches}` : "",
      pendingHuman ? `人工待办 ${pendingHuman}` : "",
      blockedWorkItems ? `工作项受阻 ${blockedWorkItems}` : "",
      waitingWithoutAgent ? `无在线 agent ${waitingWithoutAgent}` : "",
      activeDispatches && !score ? `活跃派发 ${activeDispatches}` : "",
      `进度 ${Number(taskGroup.progress || 0)}%`,
      `语言 ${languageLabel(taskGroup.languagePolicy)}`
    ].filter(Boolean);
    return {taskGroup, score, label, tone, details};
  }).sort((left, right) =>
    right.score - left.score
    || String(right.taskGroup.updatedAt || "").localeCompare(String(left.taskGroup.updatedAt || ""))
    || String(left.taskGroup.name || left.taskGroup.id).localeCompare(String(right.taskGroup.name || right.taskGroup.id)));
  const displayed = groupFacts.slice(0, 8);
  return panel("任务组处置看板", `
    <div class="module-grid action-grid">
      ${displayed.map(({taskGroup, label, tone, details}) => `
        <button class="module-card tone-${esc(tone)}" data-action="tg-detail" data-task="${esc(taskGroup.id)}">
          <span class="module-title">${esc(taskGroup.name || taskGroup.id)}</span>
          <strong>${esc(label)}</strong>
          <span class="module-detail">${esc(details.slice(0, 5).join(" · "))}</span>
          <span class="module-action">展开任务组</span>
        </button>
      `).join("")}
    </div>
    <div class="small muted">按“关闭门阻塞、派发阻塞、人工待办、工作项阻塞、无在线 agent”排序；只展示最需要先看的前 ${displayed.length} 个任务组。</div>
  `, {wide: true});
}

function renderTaskGroupLifecycleGuide(groups) {
  const activeGroups = groups.filter((taskGroup) => !["closed", "cancelled", "archived", "superseded"].includes(taskGroup.status));
  const workItemCount = groups.reduce((sum, taskGroup) =>
    sum + Number(taskGroup.workItemCount ?? (taskGroup.workItems || []).length), 0);
  const languageKinds = new Set(groups.map((taskGroup) => languageLabel(taskGroup.languagePolicy))).size;
  const canControl = hasPerm("task_group:control");
  return panel("任务组生命周期", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "1 创建任务组",
        metric: groups.length || "创建",
        detail: canControl ? "设定目标、统一语言和初始角色；后续角色 Skill 可在详情中覆盖" : "查看任务组目标、统一语言、初始角色和执行边界",
        panelTitle: canControl ? "创建任务组" : "任务组",
        tone: groups.length ? "green" : "orange",
        action: canControl ? "去创建" : "看列表"
      })}
      ${jumpModuleCard({
        title: "2 拆工作项",
        metric: workItemCount || "拆分",
        detail: canControl ? "工作项绑定执行角色、要求和可选指定模型，进入就绪后由总控派发" : "工作项承载具体执行要求、角色、模型约束和验收条件",
        panelTitle: canControl ? "创建工作项" : "任务组",
        tone: workItemCount ? "blue" : "gray",
        action: canControl ? "加工作项" : "看工作项"
      })}
      ${projectModuleCard({
        pageId: "proj-agents",
        title: "3 确认 Agent",
        metric: "注册",
        detail: "注册入口在「项目管理」→「项目 Agent」；没有准入节点时，工作项不会真正执行",
        tone: "blue",
        action: "看智能体"
      })}
      ${projectModuleCard({
        pageId: "monitor",
        title: "4 运行监控",
        metric: activeGroups.length || "实时",
        detail: "派发、会话、事件流和控制 ACK 在执行监控页实时回送，便于总控和监测角色纠偏",
        tone: activeGroups.length ? "blue" : "gray",
        action: "看监控"
      })}
      ${projectModuleCard({
        pageId: "review",
        title: "5 人工定稿",
        metric: "审核",
        detail: "核心决策、授权、审批和发现项进入人工审核；AI 不在运行中自行升级系统",
        tone: "orange",
        action: "看审核"
      })}
      ${projectModuleCard({
        pageId: "monitor",
        title: "6 关闭收口",
        metric: "门禁",
        detail: "关闭门清零后才能关闭任务组；阻塞对象、质量门和回送记录在监控页处置",
        tone: groups.length ? "green" : "gray",
        action: "看门禁"
      })}
    </div>
    <div class="small muted">这张图只使用当前项目已加载数据，不新增接口或轮询；任务组仍是 AI-native 执行单元，人只负责目标、权限、语言、定稿和必要控制。</div>
    <div class="small muted">统一语言：${esc(languageKinds || 0)} 类；运行主线：任务组目标 → 工作项 → Agent Runtime → 实时回送 → 人工审核 → 关闭门。</div>
  `, {wide: true});
}

function renderTaskGroups() {
  const groups = focusedTaskGroups();
  const canControl = hasPerm("task_group:control");
  const addableGroups = groups.filter((group) => group.status !== "closed" && group.status !== "aborted" && hasGroupPerm(group.id, "task_group:control"));
  const roleOptions = WORK_ITEM_OWNER_ROLE_CHOICES
    .map((role) => `<option value="${esc(role)}"${role === "agent-runtime" ? " selected" : ""}>${esc(role === "agent-runtime" ? "通用任务执行" : t(role))} (${esc(role)})</option>`).join("");

  // 当前项目已归档时，这两个创建表单后端一定拒（project_archived）—— 归档路由要求先把
  // 所有任务组关掉，归档之后还能往里建新组，那次收尾就白做了。摆着它们就是按不动的杠杆。
  const archivedProject = currentProject()?.status === "archived";
  const createPanels = archivedProject
    ? [panel("创建任务组", `<div class="notice warn-notice">这个项目已归档（终态，不可撤销）：`
      + "建不了新的任务组或工作项，已有的记录只能看。要继续这条线，请在上方切换到一个在用的项目，"
      + "或新建一个项目。</div>", {wide: true})]
    : !canControl ? [] : [
    panel("创建任务组", hasProjectPermission("task_group:control") ? `
      <form class="form-grid" data-form="task-group-create">
        <div class="form-row"><label>任务组名称</label><input name="name" required></div>
        <div class="form-row"><label>目标描述</label><textarea name="objective" required placeholder="描述该任务组要达成的目标"></textarea></div>
        <div class="form-row"><label>统一语言</label><select name="languageTag">${languageSelectOptions("zh-CN")}</select></div>
        <label><input type="checkbox" name="startPaused" value="true"> 创建后等待手动启动</label>
        <div class="form-row"><label>初始角色（逗号分隔；只认已登记的执行角色）</label><input name="roles" value="orchestrator,agent-runtime,reviewer" list="owner-role-options">
          <datalist id="owner-role-options">${WORK_ITEM_OWNER_ROLE_CHOICES.map((roleId) => `<option value="${esc(roleId)}">${esc(t(roleId))}</option>`).join("")}</datalist></div>
        ${currentProjectId ? "" : noVisibleProjectNotice()}
        <button class="primary-button" type="submit" ${currentProjectId ? "" : "disabled"}>创建任务组</button>
      </form>
    ` : `<div class="notice">创建任务组需要当前项目的任务组控制权限。仅获某个任务组授权时，可在已有任务组内创建任务。</div>`),
    panel("创建工作项", `
      <form class="form-grid" data-form="work-item-create">
        <div class="form-row"><label>所属任务组</label>
          ${(() => {
            // 【下拉里只放他真能往里加的组】。原先列的是项目下【全部】任务组，而建工作项
            // 后端是按任务组判 task_group:control 的 —— 只在 tg1 上有权的人能选中 tg2 提交，
            // 然后拿到一句拒绝。按组过滤，并在一个都没有时说清是"没有组"还是"都没权限"。
            const addable = addableGroups;
            if (!addable.length) {
              return `<select name="taskGroupId" disabled></select>`
                + `<div class="small warn-text">${groups.length
                  ? `这个项目有 ${groups.length} 个任务组，但你在其中任何一个上都没有「任务组控制」权限 ——`
                    + "权限按【任务组】授予，找项目负责人在具体的组上授予后再来"
                  : "这个项目还没有任务组，先在上面建一个"}</div>`;
            }
            return `<select name="taskGroupId">${addable.map((taskGroup) =>
              `<option value="${esc(taskGroup.id)}">${esc(taskGroup.name || taskGroup.id)}</option>`).join("")}</select>`
              + `${addable.length < groups.length
                ? `<div class="small">另有 ${groups.length - addable.length} 个组你没有「任务组控制」权限，没有列出来</div>`
                : ""}`;
          })()}
        </div>
        <div class="form-row"><label>工作项标题</label><input name="title" required></div>
        <div class="form-row"><label>执行角色</label><select name="ownerRole">${roleOptions}</select></div>
        <div class="form-row"><label>指定模型（可选）</label>
          <select name="pinnedModelId">
            <option value="">自动（按角色与任务选型）</option>
            ${(state.modelCapabilities || []).map((profile) =>
              `<option value="${esc(profile.modelId)}">${esc(profile.modelId)}</option>`).join("")}
          </select>
          <div class="small">选「自动」由系统按角色与任务选最合适的模型；指定后这个工作项每次派发都只用这个模型——它若不满足任务的约束或天花板，就挂阻塞交人工处置，而不会悄悄换一个。</div>
        </div>
        <div class="form-row"><label>机器可执行要求（每行一条）</label><textarea name="requirements" placeholder="每行一条约束或验收条件"></textarea></div>
        ${groups.length ? "" : `<div class="notice">先创建任务组后再追加工作项。</div>`}
        ${groups.length ? noOnlineAgentCreateNotice() : ""}
        <button class="primary-button" type="submit" ${addableGroups.length ? "" : "disabled"}>创建工作项</button>
      </form>
    `)
  ];

  if (hasNoVisibleProject()) return panel("任务组", noVisibleProjectNotice(), {wide: true});
  const notices = cellsWaitingWithNoAgentNotice(groups) + wipCapacityNotice(groups);
  if (!workspaces.allows("任务组列表")) return notices + renderTaskGroupsSummary(groups)
    + renderTaskGroupAttentionBoard(groups) + renderTaskGroupLifecycleGuide(groups) + createPanels.join("");
  const helpers = {row, table, badge, progressLine, fmtTime, languageLabel, t, controls: taskGroupControls, quickControl: taskGroupLifecycleControl,
    stats: taskGroupOperationalStats,
    project: currentProject(), projectLink: window.AIMAC_OBJECT_WORKSPACE.projectLink, groupLink: window.AIMAC_OBJECT_WORKSPACE.groupLink};
  if (expandedTaskGroupId) {
    const taskGroup = groups.find((group) => group.id === expandedTaskGroupId);
    if (!taskGroup) return panel("任务组详情", `<button class="secondary-button" data-action="tg-list">返回任务组列表</button><div class="notice">该任务组未能加载或已不在可见范围内。</div>`, {wide: true});
    return notices + window.AIMAC_TASK_GROUP_WORKSPACE.detail(taskGroup, renderTaskGroupDetail(taskGroup), helpers);
  }
  return notices + panel("任务组列表", window.AIMAC_TASK_GROUP_WORKSPACE.list(groups, helpers), {wide: true,
    headerSide: filterInput("按任务组名称、状态或语言筛选…", "task-group-list")});
}

function taskGroupControls(taskGroup) {
  const activeGroup = !settledTaskGroupStatuses.has(taskGroup.status);
  return `<div class="button-row">
    ${activeGroup && hasGroupPerm(taskGroup.id, "task_group:control") ? `<button class="primary-button" data-workspace-page="tasks" data-workspace="create" data-create-for-group="${esc(taskGroup.id)}">创建任务</button>` : ""}
    ${taskGroupLifecycleControl(taskGroup)}
    ${activeGroup && (hasGroupPerm(taskGroup.id, "task_group:review") || hasGroupPerm(taskGroup.id, "task_group:control")) ? `<button class="secondary-button" data-action="task-control" data-task="${esc(taskGroup.id)}" data-task-action="request_review">请求评审</button>` : ""}
    ${activeGroup && hasGroupPerm(taskGroup.id, "task_group:control") ? `<button class="danger-button" data-action="task-control" data-task="${esc(taskGroup.id)}" data-task-action="rebound_drift">纠偏</button>` : ""}
  </div>`;
}

function taskGroupLifecycleControl(taskGroup) {
  if (settledTaskGroupStatuses.has(taskGroup.status) || !hasGroupPerm(taskGroup.id, "task_group:control")) return "";
  if (String(taskGroup.goalExecutionStatus || "").startsWith("active_paused")) return canResumeTaskGroup(taskGroup)
    ? `<button class="primary-button" data-action="task-control" data-task="${esc(taskGroup.id)}" data-task-action="resume">启动执行</button>`
    : `<span class="notice">这个任务组是人停下来的（停因：${esc(t(taskGroup.pauseReason))}），只有真人能恢复它</span>`;
  return `<button class="secondary-button" data-action="task-control" data-task="${esc(taskGroup.id)}" data-task-action="pause">暂停</button>`;
}

function renderTaskGroupDetail(taskGroup) {
  return (page === "tg" && expandedTaskGroupId ? "" : workspaces.navigation("group-detail", "inline")) + workspaces.run("group-detail", () => renderTaskGroupDetailBody(taskGroup));
}

function renderTaskGroupDetailBody(taskGroup) {
  if (!tgDetail || tgDetail.taskGroupId !== taskGroup.id) {
    return `<div class="notice">正在加载任务组详情…</div>`;
  }
  if (tgDetail.loadFailed) {
    return `<div class="notice warn-notice">这个任务组的详情没能加载出来（原因写在页面顶部的横幅里）——`
      + "上面那行概要是刚取到的，可以照常看；点一下右上角的刷新可以再试一次。</div>";
  }
  const progressData = tgDetail.progress || {};
  const analysis = progressData.taskAnalysis;
  const analysisCount = (analysis?.items || []).length;
  const analysisHtml = analysis && analysisCount
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
    : `<div class="notice">事项清单尚未生成。控制面会按固定周期自动跑编排（${orchestratorCadenceText()}），
        生成后会出现在这里 —— 你不需要点任何按钮。若长时间没有变化，多半是这个任务组还缺前置条件
        （例如项目尚未登记仓库、或角色技能未同步），到「执行监控」页看阻塞项。</div>`;

  // 只读进度接口那份：视图里的任务组【不再带整份 roles】（列表只用 roleCount）。
  // 留着 `|| taskGroup.roles` 那截兜底会骗人 —— 它永远是 undefined，看代码的人以为还有第二个来源。
  const roleCount = (progressData.roles || []).length;
  const roles = (progressData.roles || []).map((role) => `
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
  // 这一页只对着一个任务组，按它判权（并集会让只在别的组上有权的人看到按不动的按钮）。
  const canControl = hasGroupPerm(taskGroup.id, "task_group:control") && taskGroup.status !== "closed" && taskGroup.status !== "aborted";
  const canReviewWork = hasGroupPerm(taskGroup.id, "task_group:review");
  const editDisabled = canControl ? "" : "disabled";
  const configHtml = config ? `
    <div class="stack">
      <div class="record-title">
        <strong>配置来源：</strong>
        ${config.configSource === "customized" ? customBadge("已自定义", "orange") : customBadge("继承项目", "green")}
        ${config.configSource === "customized" && canControl ? `<button class="danger-button" data-action="tg-config-reset" data-task="${esc(taskGroup.id)}">重置为继承项目</button>` : ""}
      </div>
      ${canControl ? "" : `<div class="notice warn-notice">当前账号无“任务组控制”权限，配置为只读。</div>`}
      ${sectionBlock("本任务组角色 Skill 定制", `
        <div class="notice">这里只处理本任务组的特殊角色能力要求。项目级定制会显示为“项目级继承”，任务组级定制会优先生效；下一次派发时由服务端同步到 agent。</div>
        ${roleSkillOverlayTable(taskGroupRoleSkillOverlays(taskGroup.id, taskGroup.projectId), {showScope: true})}
        ${roleSkillOverlayForm({scope: "task_group", projectId: taskGroup.projectId, taskGroupId: taskGroup.id, readOnly: !canControl})}
      `)}
      ${(() => {
        // 任务组卡里把项目/默认的全部规则（实测 32 条）整段全文渲染出来，即便本组一条覆盖都没有 —— 展开一张卡要滚几屏。
        // 全部继承时默认收起（摘要报条数）；本组有自己的覆盖时展开，人正是来看它的。规则编辑器本身一字不改。
        const systemRules = config.systemRules || [];
        const businessRules = config.businessRules || [];
        const overrides = [...systemRules, ...businessRules].filter((rule) => rule.source === "task_group").length;
        const summary = `系统规则 ${systemRules.length} 条 · 业务规则 ${businessRules.length} 条（本组覆盖 ${overrides} 条）—— `
          + (overrides ? "本组有自己的覆盖，已展开" : "全部继承自项目 / 默认，默认收起；点开查看，或在任务组层停用 / 改写 / 新增");
        return `<details class="guide-bundle rules-bundle"${overrides ? " open" : ""}><summary class="guide-bundle-summary">${esc(summary)}</summary><div class="guide-bundle-body">`;
      })()}
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
      </div></details>
      <form class="form-grid" data-form="tg-config" data-task="${esc(taskGroup.id)}">
        <div class="form-row"><label>默认角色（逗号分隔角色 ID）</label>
          <input name="defaultRoles" list="config-role-options" data-orig="${esc((config.defaultRoles || []).map((role) => role.roleId || role).join(","))}" value="${esc((config.defaultRoles || []).map((role) => role.roleId || role).join(","))}" ${editDisabled}>
          <datalist id="config-role-options">${WORK_ITEM_OWNER_ROLE_CHOICES.map((roleId) => `<option value="${esc(roleId)}">${esc(t(roleId))}</option>`).join("")}</datalist>
        </div>
        <div class="record-meta">
          <span>仓库配置：${(config.repositories || []).length} 条（在「项目设置」页维护，任务组可覆盖）</span>
          <span>基线数据：${(config.baselineData || []).length} 条</span>
        </div>
        <button class="primary-button" type="submit" ${editDisabled}>保存默认角色</button>
      </form>
    </div>
  ` : `<div class="notice">暂时无法读取任务组配置（${esc(tgDetail.configLoadError || "配置接口没取回来")}）：请点击右上角刷新重试；若一直取不回来，多半是这一台服务端有问题，配置本身没丢。</div>`;

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
  ` : `<div class="notice">当前账号无“任务组控制”权限，仅可查看。当前统一语言：${esc(languageLabel(languagePolicy))}。</div>`;

  // 视图里嵌的工作项是截断过的（真实总数在 workItemCount）。明细页优先用专用端点的完整列表；
  // 只有它没加载出来时才回落到这份截断的，而那时必须说清楚"这不是全部"。
  const embeddedTruncated = !progressData.workItems && taskGroup.workItemsTruncated === true;
  // 任务按时间线倒序：最新建的排最前（服务端下发的是插入序＝最旧在前）。两条数据路径（进度接口/列表内嵌）经同一个排序；slice 不改原数组。
  const workItems = (progressData.workItems || taskGroup.workItems || []).slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).map((workItem) => {
    return `
      <details class="record task-item">
        <summary class="record-title"><strong>${esc(workItem.title)}</strong>${badge(workItem.status)}
          <button class="secondary-button" data-open-work="${esc(workItem.id)}" data-work-group="${esc(taskGroup.id)}">查看任务</button></summary>
        ${progressLine(workItem.progress)}
        <div class="record-meta"><span>执行角色：${esc(t(workItem.ownerRole))}</span>${workItem.pinnedModelId ? `<span>指定模型：<span class="mono">${esc(workItem.pinnedModelId)}</span></span>` : ""}${workItem.blockedReason ? `<span>受阻原因：${esc(explainCoded(workItem.blockedReason))}</span>` : ""}${humanTraceHtml(workItem)}</div>
        <!-- 被阻塞的工作项：屏幕上要么给出【出口】，要么明说【系统会自清】。只写一句"受阻原因"
             等于把人留在原地 —— 后端有杠杆而界面没入口，等于这个杠杆不存在；而系统自清的也必须
             说出来，否则人会去找一个并不需要的操作。每一条都按代码里真实的清除路径写：
             blocked_dependency 由下一轮编排自动放行，其余两种都要人先动手（已核实过产生它们的分支）。 -->
        ${workItemExitHint(workItem)}
        <!-- 决定"这件事算不算需要人定稿的方案"的分类器是字面匹配：它认不出架构与选型这类决策。
             机器判不了的事，判断权归人 —— 这里给出那个杠杆，并说清分类器的局限，
             免得"没被要求定稿"被读成"系统判断过、认为不必"。 -->
        ${workItem.requiresPlanFinalization === true
          ? `<div class="notice warn-notice">已由 ${esc(workItem.planFinalizationDecidedBy || "?")} 指定：必须先有人工定稿的执行方案才能开跑${workItem.planFinalizationJustification ? `（${esc(workItem.planFinalizationJustification)}）` : ""}。
              ${/* 这句话原先只说事实、不说出口。而编排在这种情况下【不改工作项状态、也留不下任务组阻塞】
                    （没有工作项被标成受阻时，本轮结算会把阻塞面整体清空），所以除了这一句，屏幕上再没有
                    别的地方会讲它在等什么 —— 实测拉完杠杆连推三轮，单元一直停在原地。 */""}
              等 agent 提出执行方案后，到「人工审核」页定稿它；没有在线 agent 时不会有人提方案。
              不再需要这项要求时，在下面把它改回「不强制」。</div>`
          : ""}
        ${canReviewWork ? `
          ${/* 这张表单每张工作项卡都整套渲染（说明 + 下拉 + 理由 + 保存），卡片被撑得很高，而它是偶尔才动一次的杠杆。
                默认收起，摘要写明当前取值；上面那条「必须先定稿」的警示不受影响，仍然常显。 */""}
          <details class="guide-bundle plan-finalization-toggle"><summary class="guide-bundle-summary">执行方案定稿要求：当前「${workItem.requiresPlanFinalization === true ? "必须先由人定稿方案" : "不强制（按系统判断）"}」—— 点开可改</summary>
          <form class="form-grid" data-form="plan-finalization" data-task="${esc(taskGroup.id)}" data-work="${esc(workItem.id)}" style="margin-top:8px;">
            <div class="record-meta"><span>系统靠关键词判断这件事要不要人工定稿方案，它认不出架构选型这类决策 —— 你可以直接指定。</span></div>
            <div class="form-row"><label>是否必须先定稿执行方案</label><select name="requiresPlanFinalization">
              <option value="false"${workItem.requiresPlanFinalization === true ? "" : " selected"}>不强制（按系统判断）</option>
              <option value="true"${workItem.requiresPlanFinalization === true ? " selected" : ""}>必须先由人定稿方案</option>
            </select></div>
            <div class="form-row"><label>理由（必填）</label><input name="justification" placeholder="例如：这涉及存储选型，做错了后面全要返工"></div>
            <button class="secondary-button" type="submit">保存</button>
          </form></details>` : ""}
        ${(() => {
          // 执行历史：这个任务先后交给了哪些 agent、每次用什么角色/模型、结果如何——全部派发按时间倒序，最新在前。
          // 节点只展示 id：tg 页取的是 tasks 视图，里面没有 agentRuntimeNodes，不为一个名字多拉一份集合。
          const history = findWorkItemDispatches(taskGroup.id, workItem.id);
          if (!history.length) return "";
          return `<div class="stack" style="margin-top:6px;">
            <div class="small muted">执行历史（共 ${esc(history.length)} 次派发，最新在前）</div>
            ${history.map((item) => `
              <div class="record-meta">
                <span>${esc(fmtTime(item.createdAt || item.updatedAt))}</span>
                <span>${badge(item.status)} ${percentCell(item.progressPercent)}</span>
                <span>节点：<span class="mono">${esc(item.assignedNodeId || "未分配")}</span></span>
                <span>角色：${esc(t(item.roleId) || item.roleId || "-")}</span>
                <span>模型：${esc(item.model || "自动")}</span>
                ${Number(item.attempts) > 1 ? `<span>第 ${esc(item.attempts)} 次尝试</span>` : ""}
                ${item.failureReason ? `<span>失败：${esc(explainCoded(item.failureReason))}</span>` : ""}
                ${item.blockedReason ? `<span>受阻：${esc(explainCoded(item.blockedReason))}</span>` : ""}
                ${repositoryFailureAction(item)}
                <span>派发：<span class="mono">${esc(item.dispatchId)}</span></span>
                <button class="secondary-button" data-action="show-dispatch-events" data-dispatch-id="${esc(item.dispatchId)}">实时事件</button>
                <button class="secondary-button" data-action="show-dispatch-rules" data-dispatch-id="${esc(item.dispatchId)}">${dispatchRuleSummaries[item.dispatchId] ? "收起规则" : "规则"}</button>
              </div>
              ${dispatchRuleSummaries[item.dispatchId] ? ruleSummaryHtml(dispatchRuleSummaries[item.dispatchId]) : ""}`).join("")}
          </div>`;
        })()}
        ${workItemResultHtml(taskGroup.id, workItem.id)}
      </details>
    `;
  }).join("");

  // 这一节原先只看提示型 blockers（S0/S1/S2），与"这个任务组能不能关闭"完全无关：
  // 关闭门禁只存在于"执行监控"页。于是人在任务组页看到"无阻塞"，却关不掉它 ——
  // 界面给出的是与事实相反的结论。把关闭门的判定接进来，并说清下一步该去哪。
  const groupBarrier = (state.closeBarriers || []).find((item) => item.taskGroupId === taskGroup.id);
  const barrierBlockers = groupBarrier && !groupBarrier.satisfied ? (groupBarrier.blockingObjects || []) : [];
  const advisoryBlockerItems = progressData.blockers || taskGroup.blockers || [];
  const advisoryBlockers = advisoryBlockerItems.map((blocker) => `
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
    ? `<div class="notice warn-notice">${tgDetail.roomLoadDenied
        ? "当前账号无权查看这个任务组的协作记录 —— 要看的话，请让项目负责人给你这个任务组的查看权限。"
        : `协作记录没能取回来（${esc(tgDetail.roomLoadError || "服务端没有给出这一块")}）：`
          + "点右上角的 ↻ 刷新再试一次 —— 这不是「没有协作记录」。"}</div>`
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
  const workItemCount = Number(progressData.workItemCount ?? taskGroup.workItemCount ?? (progressData.workItems || taskGroup.workItems || []).length);
  const blockerCount = barrierBlockers.length + advisoryBlockerItems.length + Number(taskGroup.blockersDroppedCount || 0);
  const roomCount = Array.isArray(roomMessages) ? roomMessages.length : null;
  const detailPathHtml = renderTaskGroupDetailPath({
    analysisCount,
    roleCount,
    configLabel: config ? (config.configSource === "customized" ? "自定义" : "继承") : "未加载",
    canControl,
    workItemCount: Number.isFinite(workItemCount) ? workItemCount : 0,
    hasAdmission: Boolean(guard),
    blockerCount,
    roomCount
  });

  return `
    <div class="stack" style="margin-top:8px;">
      ${guideBundle("详情阅读路径", [detailPathHtml], ["任务组详情阅读路径（9 段）"])}
      ${sectionBlock("事项清单", analysisHtml)}
      ${sectionBlock("角色列表", `<div class="stack">${roles}</div>`)}
      ${sectionBlock("配置（继承 / 自定义）", configHtml)}
      ${sectionBlock("执行控制", controlHtml)}
      ${sectionBlock(`工作项${progressData.workItemsTruncated
        ? `（共 ${esc(progressData.workItemCount)} 个，当前展示 ${(progressData.workItems || []).length} 个）` : ""}`,
        `<div class="stack">${progressData.workItemsTruncated
        ? `<div class="notice">工作项很多，这里只加载了最新的 ${(progressData.workItems || []).length} 个（共 ${esc(progressData.workItemCount)} 个）—— 下面的筛选只在已加载的这些里找。</div>`
        : ""}${embeddedTruncated
        ? `<div class="notice warn-notice">进度接口没有加载出来，这里回落到列表视图里嵌的最新的 ${(taskGroup.workItems || []).length} 个（共 ${esc(taskGroup.workItemCount ?? "?")} 个）—— 不要据此判断"只有这些"。请刷新重试。</div>`
        : ""}${workItems || `<div class="notice">暂无工作项。</div>`}</div>`)}
      ${sectionBlock("准入与阻断分类", admissionHtml)}
      ${sectionBlock("阻塞", `<div class="stack">${blockers}</div>`)}
      ${sectionBlock("任务执行时间线", renderTaskGroupExecutionTimeline(taskGroup, progressData))}
      ${sectionBlock("协作记录（agent 之间的房间消息）", roomHtml)}
    </div>
  `;
}

function renderTaskGroupDetailPath(summary) {
  const roomMetric = summary.roomCount === null ? "不可见" : String(summary.roomCount || 0);
  const cards = [
    jumpModuleCard({
      title: "1 事项清单",
      metric: String(summary.analysisCount || 0),
      detail: "目标拆解、执行树和当前进度",
      panelTitle: "事项清单",
      tone: summary.analysisCount ? "blue" : "orange",
      action: "查看"
    }),
    jumpModuleCard({
      title: "2 角色列表",
      metric: String(summary.roleCount || 0),
      detail: "本任务组实际参与的 skill 角色",
      panelTitle: "角色列表",
      tone: summary.roleCount ? "blue" : "orange",
      action: "查看"
    }),
    jumpModuleCard({
      title: "3 配置",
      metric: summary.configLabel || "未加载",
      detail: "继承关系、规则覆盖和默认角色",
      panelTitle: "配置（继承 / 自定义）",
      tone: summary.configLabel === "自定义" ? "orange" : "green",
      action: "查看"
    }),
    jumpModuleCard({
      title: "4 执行控制",
      metric: summary.canControl ? "可控" : "只读",
      detail: "暂停、恢复、评审和统一语言策略",
      panelTitle: "执行控制",
      tone: summary.canControl ? "blue" : "gray",
      action: "查看"
    }),
    jumpModuleCard({
      title: "5 工作项",
      metric: String(summary.workItemCount || 0),
      detail: "执行单元、模型、派发和实时事件入口",
      panelTitle: "工作项",
      tone: summary.workItemCount ? "blue" : "orange",
      action: "查看"
    }),
    jumpModuleCard({
      title: "6 准入与阻断",
      metric: summary.hasAdmission ? "已计算" : "待编排",
      detail: "可执行、等待、真实阻断和整体阻断规则",
      panelTitle: "准入与阻断分类",
      tone: summary.hasAdmission ? "green" : "orange",
      action: "查看"
    }),
    jumpModuleCard({
      title: "7 阻塞",
      metric: String(summary.blockerCount || 0),
      detail: "关闭门禁、提示阻塞和下一步处置",
      panelTitle: "阻塞",
      tone: summary.blockerCount ? "red" : "green",
      action: "查看"
    }),
    jumpModuleCard({
      title: "8 任务时间线",
      metric: "倒序",
      detail: "任务、模型、会话、派发、事件和 Git 证据",
      panelTitle: "任务执行时间线",
      tone: "blue",
      action: "查看"
    }),
    jumpModuleCard({
      title: "9 协作记录",
      metric: roomMetric,
      detail: "agent 房间消息和过程追溯",
      panelTitle: "协作记录（agent 之间的房间消息）",
      tone: summary.roomCount === null ? "orange" : "blue",
      action: "查看"
    })
  ].join("");
  return sectionBlock("任务组详情阅读路径", `
    <div class="module-grid action-grid">${cards}</div>
    <div class="small muted">建议按 1 到 9 查看：先确认拆解和执行单元，再看配置、控制、阻塞、任务时间线和协作过程；需要操作时直接点对应卡片跳到小节。</div>
  `);
}

// 决策类下拉：默认必须是"尚未选择"。
// 这些下拉的第一项恰好都是后果最重的那一个（"已解决""关闭""采纳为本项目规则""激活为全局规范"），
// 而 select 默认选中第一项 —— 于是一个人点开表单直接提交，拿到的就是最重的处置，而他并没有做过
// 这个判断。规则源与共享定义那两条尤其要命：默认值等于"规则层变更默认发生"。
// 用禁用的占位项 + required：浏览器会在提交前拦下，人必须说出他决定的是什么。
// required 缺省为真：处置/授权类下拉空着不许提交。唯一的例外是「只对某一种类型生效」的下拉
// （人工指令的处置方式）—— 浏览器的约束校验不看类型，required 会把别的类型也拦住。
function decisionSelect(name, options, placeholder = "请选择处置方式…", {required = true, selected = ""} = {}) {
  const chosen = options.some(([value]) => value === selected) ? selected : "";
  return (required ? `<select name="${esc(name)}" required>` : `<select name="${esc(name)}">`)
    + (chosen ? `<option value="" disabled>${esc(placeholder)}</option>` : `<option value="" selected disabled>${esc(placeholder)}</option>`)
    + options.map(([value, label, attrs]) =>
      `<option value="${esc(value)}"${value === chosen ? " selected" : ""}${attrs ? ` ${attrs}` : ""}>${esc(label)}</option>`).join("")
    + `</select>`;
}

function sectionBlock(title, body) {
  if (!workspaces.allows(title)) return "";
  return `<div class="record" data-section-title="${esc(title)}" style="background:#fff;"><div class="record-title"><strong>${esc(title)}</strong></div><div style="margin-top:8px;">${body}</div></div>`;
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

function ruleContentPreview(content = "") {
  const normalized = String(content || "").replace(/\s+/gu, " ").trim();
  if (!normalized) return "暂无正文，展开后填写规则内容";
  return normalized.length > 180 ? `${normalized.slice(0, 180)}…` : normalized;
}

function ruleRow(rule, layer, readOnly = false) {
  const source = String(rule.source || "");
  const isDefault = source.split("+").includes("default");
  const owned = ruleOwnedAtLayer(source, layer);
  const enabled = rule.enabled !== false && (rule.status ? rule.status === "active" : true);
  const canDelete = owned && !isDefault && !readOnly; // 本层新增（非默认）规则可删除
  const ro = readOnly ? "readonly" : "";
  return `
    <details class="rule-row ${enabled ? "" : "disabled"}"
      data-rule-row
      data-rule-id="${esc(rule.ruleId || "")}"
      data-rule-category="${esc(rule.category || "")}"
      data-rule-source="${esc(source)}"
      data-orig-enabled="${enabled ? "1" : "0"}"
      data-orig-content="${esc(rule.content || "")}"
      data-orig-title="${esc(rule.title || "")}">
      <summary class="rule-summary">
        <span class="rule-summary-main">
          <strong>${esc(rule.title || rule.ruleId || "未命名规则")}</strong>
          ${ruleSourceBadge(source)}
          ${enabled ? customBadge("已启用", "green") : customBadge("已停用", "gray")}
          ${owned ? customBadge("本层覆盖", "orange") : customBadge("继承", "gray")}
        </span>
        <span class="rule-content-view">${esc(ruleContentPreview(rule.content || ""))}</span>
      </summary>
      <div class="rule-head">
        <input class="rule-title-input" name="ruleTitle" value="${esc(rule.title || "")}" ${(isDefault || readOnly) ? "readonly" : ""} placeholder="规则标题">
        ${ruleSourceBadge(source)}
        <label class="rule-toggle"><input type="checkbox" name="ruleEnabled" ${enabled ? "checked" : ""} ${readOnly ? "disabled" : ""}> 启用</label>
        ${canDelete ? `<button type="button" class="danger-button" data-action="rule-del">删除</button>` : ""}
      </div>
      <textarea name="ruleContent" ${ro} placeholder="规则内容（可改写默认内容）">${esc(rule.content || "")}</textarea>
    </details>
  `;
}

function ruleRowNew(category) {
  return `
    <details class="rule-row" open data-rule-row data-rule-category="${esc(category)}" data-rule-source="" data-orig-enabled="1" data-orig-content="" data-orig-title="">
      <summary class="rule-summary">
        <span class="rule-summary-main"><strong>新增${category === "system" ? "系统" : "业务"}规则</strong>${customBadge("本层新增", "orange")}${customBadge("已启用", "green")}</span>
        <span class="rule-content-view">先填写标题和正文，保存后成为本层规则。</span>
      </summary>
      <div class="rule-head">
        <input class="rule-id-input" name="ruleId" maxlength="128" placeholder="规则 ID（可留空自动生成）">
        <input class="rule-title-input" name="ruleTitle" placeholder="规则标题">
        <label class="rule-toggle"><input type="checkbox" name="ruleEnabled" checked> 启用</label>
        <button type="button" class="danger-button" data-action="rule-del">删除</button>
      </div>
      <textarea name="ruleContent" placeholder="规则内容"></textarea>
    </details>
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
    <form class="form-grid" ${formAttr} data-category="${esc(category)}" data-list="${esc(listId)}" data-config-version="${esc(layer === "project" ? projConfigVersion || "" : tgDetail?.configVersion || "")}">
      ${opts.note ? `<div class="notice">${opts.note}</div>` : ""}
      <div class="rule-list" data-cfg-list="${esc(listId)}">
        ${/* 「暂无规则。」对这两类的含义完全相反：业务规则空是常态，系统规则空【不正常】——
              内置默认系统规则本应始终在场（本机实测 32 条），一条都不剩说明要么被本项目全部停用了，
              要么这次根本没取到。前者是一句无害的说明，后者是执行方将在没有系统级约束下干活。 */""}
        ${(rules || []).map((rule) => ruleRow(rule, layer, readOnly)).join("")
          || (category === "system"
            ? `<div class="small warn-text">一条系统规则都没有 —— 内置默认规则本应始终在场：`
              + `要么它们被本项目逐条停用了，要么这次没取到。在恢复之前，执行方是在【没有系统级约束】的情况下干活的。</div>`
            : `<div class="small muted">还没有业务规则：本项目只受系统规则约束。`
              // 只读身份下那颗按钮是灰的：叫人去点一个点不动的按钮，等于把人留在原地。
              + (readOnly ? `你当前没有改这一层配置的权限，要加约束请找有权限的人。</div>` : `要加本项目自己的约束，点下面的「新增业务规则」。</div>`))}
      </div>
      <div class="button-row">
        <button type="button" class="secondary-button" data-action="rule-add" data-target="${esc(listId)}" data-category="${esc(category)}" ${disabled}>新增${catLabel}规则</button>
        <button class="primary-button" type="submit" ${disabled}>保存${catLabel}规则</button>
      </div>
    </form>
  `;
}

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

// 控制台跑在浏览器里，取不到 lib/lifecycle-states.mjs 那份共用常量，只能自己留一份。
// 它与真相源（state-machines.yaml 的 AgentDispatch.terminal）由 validate-specs 逐字核对，
// 并且【整个前端只准有这一份】—— 原先另有一处内联抄写，已改成用这个集合。
const terminalDispatchStatuses = new Set(["completed", "failed", "cancelled"]);
const settledTaskGroupStatuses = new Set(["closed", "aborted"]);

// 「这次派发用了什么规则」：如实展示契约记录的治理件。契约不在当前运行态里（被容量淘汰）要说清，不能显示成"没规则"。
function ruleSummaryHtml(summary) {
  if (!summary || summary.found !== true) return `<div class="notice">这次派发的任务契约已不在当前运行态里（可能已被容量淘汰），查不到它当时用的规则。</div>`;
  const list = (items, empty) => (items && items.length) ? items.map((x) => `<span class="mono">${esc(x)}</span>`).join("、") : empty;
  return `<div class="record-meta stack" style="margin-left:12px;">
    <span>角色技能：${esc(summary.roleSkill?.title || summary.roleSkill?.roleSkillId || "-")}${summary.roleSkill?.contentDigest ? `（摘要 ${esc(String(summary.roleSkill.contentDigest).slice(0, 12))}）` : ""}</span>
    <span>生效规则件：${list(summary.activeRuleRefs, "无")}</span>
    <span>规则集摘要：<span class="mono">${esc(String(summary.effectiveRulesDigest || summary.rulesetDigest || "-").slice(0, 16))}</span>${summary.rulesChangedAfterContract ? "　<b>签约后规则已变更</b>" : ""}</span>
    <span>禁止动作：${list(summary.forbiddenActions, "无")}</span>
    <span>验收要求：${list(summary.validationRequirements, "无")}</span>
  </div>`;
}


// 「结果」：这个任务产出了什么——仓库产出目标到哪一步（候选/已选/写入中/已提交/已推送）、检查点的 Git 证据（提交/推送）。
// 数据都在 tasks 视图里（repositoryOutputs / checkpoints），不发新请求；没有产出要如实说"还没有"，
// 推送与否更不能含糊——"没推送却说已推送"会让人以为改动已经到远端。
function workItemResultHtml(taskGroupId, workItemId) {
  const target = (state.repositoryOutputs || [])
    .filter((item) => item.taskGroupId === taskGroupId && item.workItemId === workItemId && item.status !== "superseded")
    .sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")))[0] || null;
  const points = (state.checkpoints || []).filter((item) => item.taskGroupId === taskGroupId && item.workId === workItemId);
  const latest = points.slice().sort((left, right) => String(right.createdAt || right.submittedAt || "").localeCompare(String(left.createdAt || left.submittedAt || "")))[0] || null;
  if (!target && !points.length) return `<div class="record-meta"><span>结果：还没有产出（尚未提交检查点）</span></div>`;
  const parts = [];
  if (target) parts.push(`仓库产出：<span class="mono">${esc(target.repositoryId || "-")}</span>${target.branch ? ` @ <span class="mono">${esc(target.branch)}</span>` : ""} ${badge(target.status)}`);
  if (latest) parts.push(`检查点 ${esc(points.length)} 个，最近一次：${(latest.commitRefs || []).length ? "有提交" : "无提交"} · ${(latest.pushRefs || []).length ? "已推送" : "未推送"}`);
  return `<div class="record-meta"><span>结果：</span>${parts.map((part) => `<span>${part}</span>`).join("")}</div>`;
}


// 一个工作项的【全部】派发（最新在前）：卡片上的「执行历史」用它——人要看的是这个任务先后交给了哪些 agent、
// 每次用什么角色/模型、结果如何，而不只是最新那一次（findWorkItemDispatch 只取活跃的那一个，给监控页用）。
function findWorkItemDispatches(taskGroupId, workItemId) {
  return (state.agentDispatches || [])
    .filter((dispatch) => dispatch.taskGroupId === taskGroupId && dispatch.workItemId === workItemId)
    .sort((left, right) => String(right.createdAt || right.updatedAt || "").localeCompare(String(left.createdAt || left.updatedAt || "")));
}

function findWorkItemDispatch(taskGroupId, workItemId) {
  const candidates = (state.agentDispatches || [])
    .filter((dispatch) => dispatch.taskGroupId === taskGroupId && dispatch.workItemId === workItemId)
    .sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
  return candidates.find((dispatch) => !terminalDispatchStatuses.has(dispatch.status)) || candidates[0] || null;
}

function agentNodeLabel(nodeId) {
  if (!nodeId) return "未分配";
  const node = (state.agentRuntimeNodes || []).find((item) => item.nodeId === nodeId);
  return node ? `${node.nodeName || node.nodeId}` : nodeId;
}

function eventTimeOf(item) {
  return item?.createdAt || item?.updatedAt || item?.decidedAt || item?.computedAt || "";
}

function workItemTitleIn(taskGroup, workItemId, fallback = "") {
  const workItem = (taskGroup.workItems || []).find((item) => item.id === workItemId)
    || ((tgDetail?.progress?.workItems || []).find((item) => item.id === workItemId));
  return workItem?.title || fallback || workItemId || "-";
}

function timelineItem({kind, title, status, at, tone = "blue", detail = "", meta = []}) {
  return {kind, title, status, at, tone, detail, meta: meta.filter(Boolean)};
}

function renderTaskGroupExecutionTimeline(taskGroup, progressData = {}) {
  const groupId = taskGroup.id;
  const workItems = progressData.workItems || taskGroup.workItems || [];
  const inGroup = (item) => item?.taskGroupId === groupId;
  const entries = [];
  for (const workItem of workItems) {
    entries.push(timelineItem({
      kind: "工作项",
      title: workItem.title || workItem.id,
      status: workItem.status,
      at: eventTimeOf(workItem) || taskGroup.updatedAt,
      tone: workItem.blockedReason || ["blocked", "needs_decision"].includes(workItem.status) ? "red" : "blue",
      detail: workItem.blockedReason ? explainCoded(workItem.blockedReason) : (workItem.requirements || []).slice(0, 2).join("；"),
      meta: [`角色：${t(workItem.ownerRole) || workItem.ownerRole || "未指定"}`,
        workItem.pinnedModelId ? `指定模型：${workItem.pinnedModelId}` : "模型：自动选择"]
    }));
  }
  for (const decision of (state.modelSelectionDecisions || []).filter(inGroup).slice(0, 40)) {
    entries.push(timelineItem({
      kind: "模型",
      title: workItemTitleIn(taskGroup, decision.workItemId, decision.workItemId),
      status: decision.status,
      at: eventTimeOf(decision),
      tone: decision.status === "blocked" ? "red" : "green",
      detail: modelDecisionSummaryZh(decision),
      meta: [`角色：${t(decision.roleId) || decision.roleId || "-"}`,
        `模型：${decision.selectedModel?.modelId || "-"}`,
        decision.modelDecision ? `依据：${decision.modelDecision}` : ""]
    }));
  }
  for (const placement of (state.sessionPlacementDecisions || []).filter(inGroup).slice(0, 40)) {
    entries.push(timelineItem({
      kind: "会话",
      title: workItemTitleIn(taskGroup, placement.workItemId, placement.workItemId),
      status: placement.status,
      at: eventTimeOf(placement),
      tone: placement.status === "blocked" ? "red" : "blue",
      detail: `放置方式：${t(placement.placement) || placement.placement || "-"}；执行载体：${placement.workerCarrierDecision?.carrier || "-"}`,
      meta: [placement.sessionId ? `会话：${placement.sessionId}` : "", placement.laneId ? `Lane：${placement.laneId}` : ""]
    }));
  }
  for (const dispatch of (state.agentDispatches || []).filter(inGroup)) {
    entries.push(timelineItem({
      kind: "派发",
      title: workItemTitleIn(taskGroup, dispatch.workItemId, dispatch.workItemId),
      status: dispatch.status,
      at: dispatch.lastExecutionEventAt || eventTimeOf(dispatch),
      tone: dispatch.status === "blocked" || dispatch.failureReason ? "red" : terminalDispatchStatuses.has(dispatch.status) ? "gray" : "blue",
      detail: explainCoded(dispatch.blockedReason || dispatch.failureReason || dispatch.dispatchReason || ""),
      meta: [`Agent：${agentNodeLabel(dispatch.assignedNodeId)}`,
        `派发：${dispatch.dispatchId}`,
        dispatch.progressPercent !== undefined ? `进度：${dispatch.progressPercent}%` : ""]
    }));
  }
  for (const event of (state.agentExecutionEvents || []).filter(inGroup).slice(0, 60)) {
    entries.push(timelineItem({
      kind: "事件",
      title: workItemTitleIn(taskGroup, event.workItemId, event.eventType),
      status: event.status,
      at: eventTimeOf(event),
      tone: event.status === "failed" || event.status === "error" ? "red" : "blue",
      detail: event.summary || "",
      meta: [`事件：${t(event.eventType) || event.eventType || "-"}`,
        `Agent：${agentNodeLabel(event.nodeId)}`,
        event.progressPercent !== undefined ? `进度：${event.progressPercent}%` : ""]
    }));
  }
  for (const checkpoint of (state.checkpoints || []).filter(inGroup)) {
    const lastCommit = checkpoint.commitRefs?.at(-1);
    entries.push(timelineItem({
      kind: "证据",
      title: workItemTitleIn(taskGroup, checkpoint.workId, checkpoint.workId),
      status: checkpoint.status || "checkpoint",
      at: eventTimeOf(checkpoint),
      tone: "green",
      detail: checkpoint.artifactManifestRefs?.[0] || "",
      meta: [lastCommit ? `提交：${String(lastCommit.commit || lastCommit).slice(0, 12)}` : "",
        checkpoint.pushRefs?.length ? `已推送：${checkpoint.pushRefs.length}` : ""]
    }));
  }
  entries.sort((left, right) => String(right.at || "").localeCompare(String(left.at || "")));
  const rows = entries.slice(0, 40).map((entry) => `
    <div class="timeline-row">
      <div class="timeline-point tone-${esc(entry.tone)}"></div>
      <div class="timeline-body">
        <div class="record-title">
          ${customBadge(entry.kind, entry.tone)}
          <strong>${esc(entry.title || "-")}</strong>
          ${entry.status ? badge(entry.status) : ""}
        </div>
        <div class="record-meta">
          <span>${fmtTime(entry.at)}</span>
          ${entry.meta.map((item) => `<span>${esc(item)}</span>`).join("")}
        </div>
        ${entry.detail ? `<div class="small muted">${esc(entry.detail).slice(0, 600)}</div>` : ""}
      </div>
    </div>
  `).join("");
  return `
    <div class="timeline-list">
      ${rows || `<div class="notice">当前任务组还没有可合并展示的执行记录。工作项进入派发、Agent 回送事件或提交 checkpoint 后，会按时间倒序出现在这里。</div>`}
    </div>
    ${entries.length > 40 ? `<div class="small muted">共 ${entries.length} 条，这里显示最新 40 条；更完整的事件仍在执行监控页按派发或任务组查看。</div>` : ""}
  `;
}

function renderTaskGroupMonitorMatrix(groups, {dispatchesAll = [], sessionsAll = [], barriersInScope = []} = {}) {
  const groupIds = new Set(groups.map((taskGroup) => taskGroup.id));
  const latestEventByGroup = new Map();
  for (const event of (state.agentExecutionEvents || []).filter((item) => groupIds.has(item.taskGroupId)).slice(0, 60)) {
    if (event.taskGroupId && !latestEventByGroup.has(event.taskGroupId)) latestEventByGroup.set(event.taskGroupId, event);
  }
  const cards = groups.map((taskGroup) => {
    const dispatches = dispatchesAll.filter((dispatch) => dispatch.taskGroupId === taskGroup.id);
    const sessions = sessionsAll.filter((session) => session.taskGroupId === taskGroup.id);
    const barrier = barriersInScope.find((item) => item.taskGroupId === taskGroup.id);
    const activeDispatches = dispatches.filter((dispatch) => !terminalDispatchStatuses.has(dispatch.status)).length;
    const blockedDispatches = dispatches.filter((dispatch) => dispatch.status === "blocked").length;
    const activeSessions = sessions.filter((session) => !SESSION_SETTLED_STATUSES.includes(session.status)).length;
    const barrierBlocks = barrier && !barrier.satisfied ? (barrier.blockingObjects || []).length : 0;
    const latest = latestEventByGroup.get(taskGroup.id);
    const tone = blockedDispatches || barrierBlocks ? "red" : activeDispatches || activeSessions ? "blue" : taskGroup.status === "closed" ? "gray" : "green";
    const details = [
      `进度 ${Number(taskGroup.progress || 0)}%`,
      `派发 ${activeDispatches}/${dispatches.length}`,
      `会话 ${activeSessions}/${sessions.length}`,
      barrier ? `关闭门 ${barrier.satisfied ? "可关闭" : `${barrierBlocks} 项阻塞`}` : "关闭门未计算",
      latest ? `最近事件 ${sinceText(latest.createdAt)}` : "暂无事件"
    ];
    return `
      <button class="module-card tone-${tone}" data-action="monitor-scope" data-scope="taskGroup:${esc(taskGroup.id)}">
        <span class="module-title">${esc(taskGroup.name || taskGroup.id)}</span>
        <strong>${esc(activeDispatches || activeSessions || barrierBlocks || Number(taskGroup.progress || 0))}</strong>
        <span class="module-detail">${esc(details.join(" · "))}</span>
        <span class="module-action">切到该任务组</span>
      </button>
    `;
  }).join("");
  return panel("任务组监控矩阵", `
    <div class="module-grid action-grid">${cards || `<div class="notice">当前项目还没有任务组。</div>`}</div>
    <div class="small muted">每张卡对应一个任务组，汇总进度、活跃派发、工作会话、关闭门和最近事件；点击后实时事件流切换到该任务组范围。</div>
  `, {wide: true});
}

/* ---------------- 成员：人工审核 ---------------- */

// requirePermission：只列出【在那个任务组上真有这个权限】的组。人工指令表单用它 ——
// 原先列出全部组，选到自己没权限的那个，提交必然 403，而人是照着下拉选的。
function taskGroupSelector(selectedId, selectName, requirePermission = null) {
  const all = projectTaskGroups();
  const groups = requirePermission
    ? all.filter((taskGroup) => hasGroupPerm(taskGroup.id, requirePermission))
    : all;
  // 【过滤空了要说清是哪一种空】。原先一个都不剩时渲染的是一个空下拉：人分不清
  // "这个项目没有任务组" 和 "有，但你一个都动不了" —— 而这两件事的下一步完全不同
  //（前者去建一个，后者去找人授权）。权限是按【任务组】给的，还要说这一句：
  // 他在别的组上可能确实有，不说就会以为界面坏了。
  if (!groups.length) {
    return `<select data-select="${selectName}" disabled></select>`
      + `<div class="small warn-text">${all.length
        ? `这个项目有 ${all.length} 个任务组，但你在其中任何一个上都没有「${esc(requirePermission || "")}」权限 ——`
          + "权限按【任务组】授予，找项目负责人在具体的组上授予后再来"
        : "这个项目还没有任务组"}</div>`;
  }
  return `
    <select data-select="${selectName}">
      ${groups.map((taskGroup) => `<option value="${esc(taskGroup.id)}" ${taskGroup.id === selectedId ? "selected" : ""}>${esc(taskGroup.name || taskGroup.id)}</option>`).join("")}
    </select>
    ${groups.length < all.length
      ? `<div class="small">另有 ${all.length - groups.length} 个组你没有这个权限，没有列出来</div>`
      : ""}
  `;
}


// 「待你处理」是当前项目里等人拍板的汇总入口；如果未来视图里混入跨项目记录，按钮必须先切到记录所属项目。
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
  WorkSession: "执行中的会话：等它结束，或在「agent 节点」上取消对应派发",
  AgentDispatch: "执行中的派发：等它结束，或在「agent 节点」上取消它",
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
  agent_runtime_executor_required: "该节点上没有模型执行器：到那台机器上装 codex / claude / gemini / ollama 任一个"
    + "（节点会自动探测这四个命令），或用 --executor-command 指定自定义执行器后重新加入；"
    + "装好后有项目 agent 管理权限的人可到「项目管理」→「项目 Agent」对该节点点「刷新自检」；"
    + "没有项目控制权时，让组织管理员到「组织管理」→「共享 Agent」点「刷新自检」确认它认出来了",
  // 下面三条是【节点拒绝了人的控制指令且重试已用尽】。它们不会自己好，而且最要紧的一点是：
  // 控制面这边已经停了，那台机器上的 agent 可能还在跑 —— 出口是绕开节点配合的强制吊销。
  control_pause_rejected_by_node: "节点拒绝了暂停且重试已用尽：让组织管理员切到「组织管理」，打开共享 Agent，对该节点点「立即切断」，再确认它确实停了",
  control_cancel_rejected_by_node: "节点拒绝了取消且重试已用尽：让组织管理员切到「组织管理」，打开共享 Agent，对该节点点「立即切断」，再确认它确实停了",
  assigned_node_stop_control_failed_retries_exhausted: "节点停止控制重试已用尽：让组织管理员切到「组织管理」，打开共享 Agent，对该节点点「立即切断」（不需要节点配合）",
  // 这两条只在【节点失联超时】后才会被自动重排；节点若还在心跳却始终不 ACK，它会一直等下去。
  // 所以不能登记成"会自己好"，出口是不需要节点配合的立即切断。
  assigned_node_revocation_pending_stop: "正在等节点确认吊销：节点失联超时后系统会自动重排；若它仍在心跳却迟迟不确认，让组织管理员切到「组织管理」，打开共享 Agent 点「立即切断」",
  // 关停与吊销是同一条代码路径的两个分支，恢复方式也一样。孪生项里只有吊销那一半写了
  // 中文和出口，停机那一半两样都没有 —— 于是同一件事，走吊销的人看到中文指引，
  // 走关停的人看到一串英文、且没有下一步。
  assigned_node_shutdown_pending_stop: "正在等节点确认关停：节点失联超时后系统会自动重排；若它仍在心跳却迟迟不确认，让组织管理员切到「组织管理」，打开共享 Agent 点「立即切断」",
  task_group_pause: "整个任务组被人暂停了：到该任务组页点「恢复执行」"
};
// 提示只在【当前真的有派发卡在这些原因上】时出现，且按出现过的原因去重 —— 逐行重复同一句话
// 会把表格淹掉，而人需要的是"现在卡在哪几件事上、各自去哪处理"。
// 会话也会被停住，而且可能在【派发已经终结之后】仍然停着（确认卡超时那条链就是这样）——
// 那时只扫派发的话，这条提示不会出现，而会话仍然算活跃、仍然挡着关闭门。两边一起扫，一条提示。
const SESSION_SETTLED_STATUSES = ["completed_objective", "recycled", "failed", "aborted"];
// 出口提示里有一类是【叫读的人自己去按一个按钮】。按不按得动要按【任务组】判：
// 观察者在监控页照样看得到「到该任务组页点「恢复执行」」，而他那一页上根本没有这个按钮 ——
// 指到一个够不着的地方，比不给出口更耗人。这里只登记我核过的那几条：
// 键是阻塞原因，值是按那个出口所需要的权限（按组判，口径与按钮本身同一个 hasGroupPerm）。
const STUCK_EXIT_PERMISSION = {
  task_group_pause: "task_group:control"
};
function stuckExitNotice(dispatches, sessions) {
  const blocked = [
    ...(dispatches || []).filter((dispatch) => dispatch.status === "blocked"),
    ...(sessions || []).filter((session) => !SESSION_SETTLED_STATUSES.includes(session.status))
  ].filter((item) => STUCK_EXIT_HINT[item.blockedReason]);
  const stuck = [...new Set(blocked.map((item) => item.blockedReason))];
  if (!stuck.length) return "";
  // 「够不着」要说清是哪几个任务组够不着，否则人只知道"我不行"，不知道该去找谁。
  const outOfReach = (reason) => {
    const perm = STUCK_EXIT_PERMISSION[reason];
    if (!perm) return "";
    const groups = [...new Set(blocked.filter((item) => item.blockedReason === reason)
      .map((item) => item.taskGroupId).filter(Boolean))];
    const denied = groups.filter((id) => !hasGroupPerm(id, perm));
    if (!denied.length || denied.length < groups.length) return "";
    return `（你在${denied.map((id) => `「${taskGroupNameOf(id)}」`).join("、")}上没有这个权限，`
      + "只能看、不能动 —— 它在等这个组里有权的人处置）";
  };
  return `<div class="notice warn-notice">有执行被挡住，需要人处理：${stuck
    .map((reason) => `<br>· ${esc(t(reason) || reason)} —— ${esc(STUCK_EXIT_HINT[reason])}${esc(outOfReach(reason))}`).join("")}</div>`;
}

// 被阻塞工作项的出口提示。键优先看 blockedReason（更具体），退回到 status。
// 每一条都对应代码里真实的清除路径：写一条并不存在的"会自动恢复"，比什么都不写更糟。
const WORK_ITEM_EXIT_HINT = {
  needs_decision: "编排不会再自动推进它：到「人工指令」页用「决策处置（重开 / 放弃）」处置。",
  blocked_dependency: "无需操作：它依赖的工作项通过验收后，下一轮编排会自动放行。",
  model_selection_rejected: "没有可运行的模型满足它的硬性约束：让系统管理员到「系统管理」→「系统设置」核对模型能力注册，或放宽该工作项的模型约束。",
  blocked_resource: "它等待的资源尚未就绪：让系统管理员到「系统管理」→「系统设置」核对模型与技能源状态。",
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
  // 尾段也要走词表：这几类阻塞项的最后一段是英文蛇形码（no_acceptance_checks 之类），
  // 原样打出来等于在"方案为什么跑不了"这一刻甩给人一个标识符。
  // 但中间段是【数据】（分支 id、路径），不是枚举 —— 对它们调 t() 会让漏译扫描把 b_api
  // 这种 id 报成"缺中文"。所以只翻译词表里确实有的那些段，其余原样。
  // 「尾码必须有中文」由契约门按源码枚举核对（verifyTopologyBlockerPartsAllHaveChinese），
  // 那才是权威来源 —— 这里不承担发现漏译的职责。
  const dict = I18N.dict || {};
  const detail = rest.filter(Boolean)
    .map((part) => (Object.prototype.hasOwnProperty.call(dict, part) ? t(part) : part))
    .join(" · ");
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
  // 挡住这道门的是【派发上的 MCP 授权】（mcpGrants），不是「账号与授权」页管的那些访问授权
  // （accessGrants）—— 原先这条指引指向后者，人撤了一圈门照样挡着。
  // 这类授权只随【派发的节点绑定被撤销】而回收：取消那次派发，或等它到期（门按到期时间判活跃）。
  no_active_temp_grants: "派发上的临时 MCP 授权还在有效期内。它到期后这道门会自动放行；"
    + "要立刻收回就到「人工指令」页取消对应的派发（撤销该派发的节点绑定时会一并收回这些授权）。"
    + "注意不是「账号与授权」页上的访问授权 —— 那是另一类，撤销它不会解开这道门",
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
  // 还有一种更隐蔽的停摆：周期【不抛异常，只是彻底不跑了】（定时器被清、进程卡住、
  // 主循环被某一拍卡死）。这时 consecutiveErrors 是 0、lastTickResult 停在上一次的 "ran"，
  // 屏幕上照写"已启用 · 每 60 秒推进一次（上一拍 ran）"，而实际什么都没动。
  // 判据照 agent 心跳那一套：拿上一拍的时间跟【周期本身声明的间隔】比，落后太多就说出来。
  const tickAgeMs = status.lastTickAt ? serverNow() - new Date(status.lastTickAt).getTime() : NaN;
  const intervalMs = Number(status.intervalMs || 0);
  if (Number.isFinite(tickAgeMs) && intervalMs > 0 && tickAgeMs > Math.max(intervalMs * 5, 3 * 60 * 1000)) {
    return `<span class="warn-text">（⚠ 已 ${durationText(tickAgeMs)}没有推进过 ——`
      + `说好每 ${Math.round(intervalMs / 1000)} 秒一拍，自治周期多半已经停摆）</span>`;
  }
  return status.lastTickAt ? `（上一拍 ${esc(t(status.lastTickResult) || status.lastTickResult || "ran")}）` : "";
}

function agentNodeManagementPath({needMoreCapacity = false, registeredNodeCount = 0} = {}) {
  const suffix = needMoreCapacity
    ? "刚接上的节点处于“受限”、自检有缺项的处于“只读”，这两种都不加额度"
    : "";
  const hasRegisteredNodes = Number(registeredNodeCount || 0) > 0;
  const canManageProjectAgents = hasPerm("agent:activate");
  const projectAgentPage = "「项目管理」→「项目 Agent」";
  const orgAgentPage = "「组织管理」→「共享 Agent」";
  const registerPath = `${projectAgentPage}→「注册项目节点」`;
  const registerAction = needMoreCapacity
    ? `${registerPath}接入更多已通过自检的节点`
    : `${registerPath}签发当前项目的加入令牌`;
  const directRegister = `到${registerAction}`;
  const askRegister = `联系有项目 agent 管理权限的人到${registerAction}`;
  const directRefresh = `已有节点离线时先恢复目标 agent 主机/进程心跳；执行器或能力修好后，在${projectAgentPage}对节点点「刷新自检」`;
  const askRefresh = `已有节点离线时先联系节点负责人恢复目标 agent 主机/进程心跳；执行器或能力修好后，联系有项目 agent 管理权限的人在${projectAgentPage}点「刷新自检」`;
  const governance = `需要跨项目治理、吊销或立即切断时，再由组织管理员到${orgAgentPage}处理`;
  if (needMoreCapacity) {
    return `${canManageProjectAgents ? directRegister : askRegister}；${canManageProjectAgents ? directRefresh : askRefresh}；${governance}${suffix ? `；${suffix}` : ""}`;
  }
  if (hasRegisteredNodes) {
    return `${canManageProjectAgents ? directRefresh : askRefresh}；${governance}`;
  }
  return `${canManageProjectAgents ? directRegister : askRegister}；agent 上线后回到${projectAgentPage}的「项目 agent 节点」确认在线`;
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
    inScope(item) && !terminalDispatchStatuses.has(item.status)).length;
  if (!waiting) return "";                     // 没有活在等，就不必吓人
  const total = Number(fleet.total || 0);
  return `<div class="notice warn-notice">这个项目有 ${esc(waiting)} 个派发在排队或执行中，`
    + `但【没有任何在线的 agent 节点】${total ? `（已注册 ${esc(total)} 个，此刻都不在线或已降级）` : "（一个都还没注册）"}：`
    + `这些活现在不会有任何进展，界面上的"执行中"只是挂着。`
    + `${esc(agentNodeManagementPath({registeredNodeCount: total}))}。</div>`;
}

// 人把方案「交回 AI 再分析」之后，卡片会停在 awaitingAiAnalysis 等着 agent 来回答。
// 如果此刻一个在线 agent 都没有，这个等待【永远不会结束】—— 而人工确认页上只写着
// "等待 AI 再分析"，人就坐在那儿等一件不会发生的事。舰队掉线的提示原先只挂在监控页，
// 而这一页才是他等的地方。
// 任务组页是项目负责人盯单元的地方：单元停在 assigned/dispatched 不动时，他在这一页等。
// 而"没有任何在线 agent"此前只在监控页说 —— 他要先想到去监控页看，才知道自己在等一件
// 不会发生的事。提示要出现在他所在的位置。
// 建工作项的表单旁要说清「建了也派不出去」：没有在线 agent 时，建好的工作项只会停在待派发，等人接节点。
// 顶部那条「已交给执行方的单元没人领」只在【已经有单元等着】时才出现 —— 第一次建工作项的人看不到它，
// 建完只看到进度条不动，会以为系统坏了。fleet 没下发时不瞎说。
function noOnlineAgentCreateNotice() {
  const fleet = (state || {}).fleet;
  if (!fleet || Number(fleet.online || 0) > 0) return "";
  const total = Number(fleet.total || 0);
  // 措辞刻意与顶部「没有任何在线的 agent 节点」那条区分：那条只在单元已交出去时挂，门按短语分别核。
  return `<div class="small warn-text">此刻没有 agent 节点在线${total ? `（已注册 ${esc(total)} 个，都不在线或已降级）` : "（一个都还没注册）"}：`
    + `可以先建，但建好后不会被领走，直到有节点接入并通过自检。${esc(agentNodeManagementPath({registeredNodeCount: total}))}。</div>`;
}

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
    + `它们不会有任何进展，进度条也不会再动。${esc(agentNodeManagementPath({registeredNodeCount: total}))}。</div>`;
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
    // 额度按【在线且准入为 full】的节点数算（wipCapacityForProject）。只说"在线"会让人白等：
    // 刚注册的节点是 limited、自检有缺项的是 read_only，两者都在线、都不加额度、也领不到活。
    // 人接上一台看额度没动，会以为系统坏了或自己接错了。
    + `想让它跑得更宽，${esc(agentNodeManagementPath({needMoreCapacity: true, registeredNodeCount: Number(((state || {}).fleet || {}).total || 0)}))}；额度按【在线且已通过自检】的节点数上调，`
    + `在该节点管理入口看它的「准入」列，缺项也列在那里。</div>`;
}

function aiAnalysisStalledNotice(requests) {
  const fleet = (state || {}).fleet;
  if (!fleet || Number(fleet.online || 0) > 0) return "";
  const waiting = (requests || []).filter((item) => item.awaitingAiAnalysis && item.status === "pending").length;
  if (!waiting) return "";
  const total = Number(fleet.total || 0);
  return `<div class="notice warn-notice">有 ${esc(waiting)} 张卡片在等 AI 再分析，`
    + `而当前【没有任何在线的 agent 节点】${total ? `（已注册 ${esc(total)} 个，此刻都不在线或已降级）` : "（一个都还没注册）"}：`
    + `这个等待不会有结果。要么${esc(agentNodeManagementPath({registeredNodeCount: total}))}，要么直接在这里定稿或打回 —— 不必等它回话。</div>`;
}

// 连续失败就不只是"参数里的一行小字"了：它意味着此刻没有任何东西在推进，
// 而人正在等系统自己往下走。放在监控页顶部。
// 停摆时人在本页能做的唯一一件事：手动推一拍。按钮就在这条提示下面（有 orchestrate 权限时），
// 而提示原先只说"需要人推进的事只能手动来"—— 人不会想到那句指的就是下面这个按钮。
// 后端有杠杆、界面也有入口，报文却不指过去，等于这个出口不存在。
function manualTickExit() {
  return hasPerm("task_group:orchestrate")
    ? "本页的「运行自治循环」可以手动推一拍（只顶这一拍，循环没恢复之前每一步都得这样推）；"
    : "手动推一拍需要「任务组编排」权限，本账号没有 —— 找有这个权限的人来推，或先把循环修好；";
}

// 编排节奏要按【真实下发的间隔】说，不能写死"每分钟一次"：它由 AIMAC_ORCHESTRATOR_INTERVAL_MS
// 决定，运维调过之后那句话就在说假话，而人正是照它判断"等多久还没动静才算不对劲"。
// 关掉自治时更要说清 —— 否则人会一直等一个永远不会来的自动推进。
function orchestratorCadenceText() {
  const status = (state.runtime || {}).autonomousOrchestrator || {};
  if (!status.enabled) return "当前这台没有开自治周期，不会自动跑";
  const seconds = Math.round(Number(status.intervalMs || 0) / 1000);
  return seconds > 0 ? `当前设置：每 ${seconds} 秒一次` : "间隔未知";
}

function orchestratorStalledNotice() {
  const status = (state.runtime || {}).autonomousOrchestrator;
  const failures = Number(status?.consecutiveErrors || 0);
  if (!status?.enabled) return "";
  // 静默停摆（不报错、只是不跑了）与连续失败一样严重，而它一个错误计数都没有：
  // 定时器被清、某一拍卡死时 consecutiveErrors 停在 0、lastTickResult 还是 "ran"。
  // 判据只能是"说好每 N 秒一拍，实际多久没动了"。
  const tickAgeMs = status.lastTickAt ? serverNow() - new Date(status.lastTickAt).getTime() : NaN;
  const intervalMs = Number(status.intervalMs || 0);
  if (failures < 2 && Number.isFinite(tickAgeMs) && intervalMs > 0
    && tickAgeMs > Math.max(intervalMs * 5, 3 * 60 * 1000)) {
    return `<div class="notice warn-notice">自治循环已经 ${esc(durationText(tickAgeMs))}没有推进过，`
      + `而它自称每 ${esc(Math.round(intervalMs / 1000))} 秒一拍 —— 它没有报错，只是【不跑了】：`
      + `不会再有新的派发、关闭门不会重算、人工指令会一直停在待处理；`
      + `而【已经排队的派发仍会被领走并执行】—— 认领走的是网关，不归它管。`
      + `请先看服务端日志（进程还在但主循环卡住时，日志里也会没有新的一拍）。`
      + manualTickExit() + `恢复之前，需要人推进的事只能手动来。</div>`;
  }
  if (failures < 2) return "";
  return `<div class="notice warn-notice">自治循环已连续 ${esc(failures)} 拍失败，当前【不会再有新的派发】：`
    + `关闭门不会重算、人工指令会一直停在待处理；而已经排队的派发仍会被领走并执行。`
    + `最近一次失败：${esc(status.lastError || "未记录")}`
    + `（最后一次成功推进：${status.lastSuccessAt ? esc(fmtTime(status.lastSuccessAt)) : "无记录"}）。`
    + `请先看服务端日志定位原因。` + manualTickExit() + `恢复之前，需要人推进的事只能手动来。</div>`;
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
  const at = pageLoadedAt[page];
  if (!at) {
    // 这一页从来没成过：说「显示的是 N 秒前的旧数据」是假的 —— 屏幕上根本没有这一页的数据。
    return lastLoadedAt ? "这一页从来没有加载成功过，下面是空的（不是「一条都没有」）"
      : "登录以来一直没能加载成功，下面是空的（不是「一条都没有」）";
  }
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  const ago = seconds < 60 ? `${seconds} 秒前` : (() => {
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`;
  })();
  return `下面显示的是 ${ago}的旧数据`;
}

// 一个正在跑的派发，屏幕上永远是「running 45%」—— 不管它上一次真有动静是一分钟前还是半天前。
// 实测过一次：agent 侧挂死，控制面因为心跳照常而一直显示「还在跑」，26 分钟后才被人发现。
// 控制面其实一直记着 lastExecutionEventAt，只是从没渲染过。这里不设阈值、不下判断，
// 只把「上一次动静是多久以前」摆出来 —— 什么算太久，看的人比任何阈值都清楚。
function sinceText(value) {
  const at = value ? new Date(value).getTime() : NaN;
  // 认不出的时间不能显示成「刚刚」：那会把一条坏记录说成最新的。
  if (!Number.isFinite(at)) return value ? "时间无法识别" : "";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`;
}

function countSuffix(field) {
  // 两种都会让这个数偏小：视图这次没加载全（记录还在），或者容量淘汰已经把老的丢了。
  // 数字后面都该带 "+"；两者的区别由顶部横幅分开讲清楚。
  return (state.truncatedCollections || []).includes(field)
    || Number((state.storageDroppedCounts || {})[field] || 0) > 0 ? "+" : "";
}

// 有些表把整个集合原样铺开（没有"当前展示 N 条"的页脚），于是视图截断在这些页上连一点痕迹都没有：
// 人看到的是一份自称完整的名单。账号、授权、智能体、项目这几张尤其要紧 —— 人正是照着它们
// 判断"谁有权限"、"有哪些项目"，少列一条就是漏掉一个人或一个项目。
// 视图为了体积会把每个集合截到上限，服务端如实登记在 truncatedCollections 里。此前只有 5 张表
// 各自调 capNotice 报出来，而界面上有 23 张表在渲染 state 集合 —— 其余 18 张【截了也不说】。
// 这句话原先是无条件的："这里只保留最近 N 条；更早的记录在归档文件里，不在这一屏内。"
// N 取的是当前条数 —— 于是全新部署只有 2 条时，它宣称"只保留最近 2 条、更早的在归档里"，
// 凭空造出一次截断，还把人支去看一个空归档。这是截断诚实的镜像：不是藏起截断，是发明截断。
// 上限由服务端下发（audit-ledger 的 AUDIT_LOG_CAP），界面不自己编这个数。
function auditWindowNote() {
  const shown = (state.auditLog || []).length;
  const cap = Number(state.runtime?.auditLogCap || 0);
  if (cap && shown >= cap) {
    return `这一屏只保留最近 ${cap} 条；更早的记录在归档文件里，不在这一屏内。`;
  }
  // 上限不明时不能落到「都在这一屏内」那句：那是有利的一句，而此时恰恰判断不了有没有被挤掉。
  if (!cap) return `台账共 ${shown} 条；服务端没给出保留上限，判断不了更早的记录是否已被挤出这一屏 —— 完整记录以归档文件为准。`;
  return `台账共 ${shown} 条，都在这一屏内；归档文件里是同一份完整记录。`;
}

function truncationBanner() {
  const nameOf = (field) => COLLECTION_LABELS[field] || t(field);
  const fields = (state.truncatedCollections || []).filter((field) => field !== "truncatedCollections");
  const droppedEntries = Object.entries(state.storageDroppedCounts || {}).filter(([, count]) => Number(count) > 0);
  const parts = [];
  if (fields.length) {
    parts.push(`<div class="notice warn-notice">这几份名单只加载了【最近的】若干条，实际条目更多：${esc(fields.map(nameOf).join("、"))}`
      + " —— 更早的记录还在系统里，只是这一屏没取；不要据此判断「没有别的了」。</div>");
  }
  // 与上面那句必须分开：这些不是「没加载」，是【已经被容量淘汰丢掉了】。
  // 说成「只加载了前若干条」会让人去翻页找一批根本不存在的记录。
  if (droppedEntries.length) {
    const detail = droppedEntries.map(([field, count]) => `${nameOf(field)} ${count} 条`).join("、");
    parts.push(`<div class="notice warn-notice">这些历史记录已被容量上限丢弃，不在系统里了（还在跑或还等着人处置的从不淘汰）：`
      + `${esc(detail)} —— 屏幕上这几个数是「剩下的」，不是「一共发生过的」。</div>`);
  }
  return parts.join("");
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

// 按【任务组】判权时，"你没有这个权限"这句话必须说清是【哪个组】：在 A 组有评审权的人
// 看到 B 组的卡，一句"当前账号无人工审核权限"是假的 —— 他有，只是不在这个组上。
// 另外两处（审批、发现项）此前【连这句都没有】：表单不见了、卡片照样挂着，人分不清是自己没权
// 还是页面坏了。而这些卡多半带着「阻塞执行」，看到它却动不了、又没人告诉他去找谁，是最难受的一种。
function noRightOnThisGroup(taskGroupId, what) {
  return `<div class="notice" style="margin-top:8px;">你在任务组「${esc(taskGroupNameOf(taskGroupId))}」上没有${esc(what)}的权限，`
    + "这里只能看、不能动 —— 它在等这个组里有权的人处置。</div>";
}

function recentHumanFinalizations(taskGroupIds) {
  const groups = taskGroupIds instanceof Set
    ? (state.taskGroups || []).filter((taskGroup) => taskGroupIds.has(taskGroup.id))
    : projectTaskGroups();
  const inScope = (item) => !item.taskGroupId || groups.some((taskGroup) => taskGroup.id === item.taskGroupId);
  const visibleProjectIds = new Set(groups.map((taskGroup) => taskGroup.projectId).filter(Boolean));
  return [
    ...(state.reviewPlans || []).filter(inScope).map((item) => ({kind: "评审计划",
      id: item.reviewPlanId, taskGroupId: item.taskGroupId, status: item.status,
      by: item.resolvedBy, why: item.resolutionJustification, at: item.updatedAt})),
    ...(state.reviewBundles || []).filter(inScope).map((item) => ({kind: "评审包",
      id: item.reviewBundleId, taskGroupId: item.taskGroupId, status: item.status,
      by: item.resolvedBy, why: item.resolutionJustification, at: item.updatedAt})),
    ...(state.systemUpgradeCandidates || []).filter(inScope).map((item) => ({kind: "升级候选",
      id: item.candidateId, taskGroupId: item.taskGroupId, status: item.status,
      by: item.resolvedBy, why: item.resolutionJustification, at: item.updatedAt})),
    ...(state.ruleSourceResolutions || []).filter(inScope).map((item) => ({kind: "规则来源分流",
      id: item.sourceRef || item.resolutionId, taskGroupId: item.taskGroupId, status: item.status,
      by: item.settledBy, why: item.settlementJustification, at: item.updatedAt})),
    ...(state.sharedDefinitions || []).filter((item) => inScope(item)
      || (!item.taskGroupId && (!item.projectId || visibleProjectIds.has(item.projectId))))
      .map((item) => ({kind: "共享定义契约", id: item.contractId, taskGroupId: item.taskGroupId,
        status: item.status, by: item.resolvedBy, why: item.resolutionJustification, at: item.updatedAt})),
    // 处置完的发现项要留得下「谁判的、判成了什么」。
    ...(state.findings || []).filter(inScope).map((item) => ({kind: "评审发现",
      id: item.findingId || item.id, taskGroupId: item.taskGroupId, status: item.status,
      by: item.dispositionedBy, why: item.dispositionClass, at: item.updatedAt}))
  ].filter((item) => item.by)
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 10);
}

function renderPendingForMePanel() {
  const todo = pendingForMe();
  return panel("待你处理", `
    ${!todo.known
      ? `<div class="notice">这一页没有加载待办所需的数据，因此这里不做统计（这不表示没有待办）。到「人工审核」或「执行监控」页查看。</div>`
      : todo.total === 0
      ? `<div class="notice">当前没有需要你处置的项。（只统计你有权处置的；别人负责的部分不会出现在这里。）</div>`
      : `<div class="notice warn-notice">共 ${todo.total}${todo.partial ? "+" : ""} 项等待你处理，按当前项目视图统计。等人拍板的东西分布在两个页面上，这里是当前项目的汇总入口。${todo.partial ? "<br><strong>带 + 的类别数据量超过本页加载上限，实际项数只多不少 —— 处置完这里列出的也未必清空。</strong>" : ""}</div>
         <div class="stack">
           ${todo.buckets.map((bucket) => `
             <div class="record">
               <div class="record-title"><strong>${esc(bucket.label)}</strong> ${customBadge(`${bucket.count}${bucket.capped ? "+" : ""}`, "red")}</div>
               <div class="record-meta"><span>处置入口：${esc(PAGE_META[bucket.page]?.[0] || bucket.page)}${bucketNeedsProjectJump(bucket)
                 ? ` · 先进入项目：${bucket.projectIds.slice(0, 3).map(projectNameOf).map(esc).join("、")}${bucket.projectIds.length > 3 ? "…" : ""}`
                 : ""}</span></div>
               <div class="button-row">${bucketNeedsProjectJump(bucket)
                 ? `<button class="secondary-button" data-action="open-project-page" data-project="${esc(bucket.projectIds[0])}" data-target-menu="${esc(bucket.page)}">${bucket.projectIds.length > 1 ? "前往首个项目处置" : "前往处置"}</button>`
                 : `<button class="secondary-button" data-menu="${esc(bucket.page)}">前往处置</button>`}</div>
             </div>`).join("")}
         </div>`}
  `, {wide: true});
}

function reviewStats({pending, pendingPermissions, pendingApprovals, openFindings}) {
  const blockingConfirmations = pending.filter((request) => request.blocking).length;
  const majorDecisions = pending.filter((request) => request.decisionClass === "major").length;
  const affectedTaskGroups = new Set([
    ...pending.map((item) => item.taskGroupId),
    ...pendingPermissions.map((item) => item.taskGroupId),
    ...pendingApprovals.map((item) => item.taskGroupId),
    ...openFindings.map((item) => item.taskGroupId)
  ].filter(Boolean)).size;
  return {blockingConfirmations, majorDecisions, affectedTaskGroups};
}

function renderReviewSummary({pending, pendingPermissions, pendingApprovals, openFindings, answered, finalizations}) {
  const stats = reviewStats({pending, pendingPermissions, pendingApprovals, openFindings});
  return panel("人工审核总览", `
    <div class="metric-grid">
      ${summaryMetric("待人工确认", pending.length, `${stats.blockingConfirmations} 条阻塞执行`)}
      ${summaryMetric("核心决策", stats.majorDecisions, "必须真人主动定稿")}
      ${summaryMetric("授权请求", pendingPermissions.length, "需要项目授权权限处理")}
      ${summaryMetric("审批请求", pendingApprovals.length, "需要审核权限处理")}
      ${summaryMetric("待处置发现", openFindings.length, "会影响关闭门禁")}
      ${summaryMetric("涉及任务组", stats.affectedTaskGroups, "当前项目内需要关注的范围")}
      ${summaryMetric("已答历史", answered.length, "已定稿或已作废的确认")}
      ${summaryMetric("最近定稿", finalizations.length, "真人收尾记录")}
    </div>
    <div class="small muted">查看顺序：先看“待你处理”，再处理“待人工确认”和“授权与处置”；历史结论在“已答历史”和“最近的人工定稿”里追溯。</div>
  `, {wide: true});
}

function renderReviewActionBoard({pending, pendingPermissions, pendingApprovals, openFindings, answered, finalizations}) {
  const stats = reviewStats({pending, pendingPermissions, pendingApprovals, openFindings});
  const todo = pendingForMe();
  return panel("人工审核处置看板", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "待你处理",
        metric: todo.known ? `${todo.total}${todo.partial ? "+" : ""}` : "未知",
        detail: todo.known ? "当前项目的个人处置入口" : "待办数据未完整加载",
        panelTitle: "待你处理",
        tone: todo.known && todo.total ? "red" : "green",
        action: "查看待办"
      })}
      ${jumpModuleCard({
        title: "待人工确认",
        metric: `${pending.length}`,
        detail: `${stats.blockingConfirmations} 条阻塞执行`,
        panelTitle: "待人工确认",
        tone: stats.blockingConfirmations ? "red" : pending.length ? "orange" : "green",
        action: "处理确认"
      })}
      ${jumpModuleCard({
        title: "核心决策",
        metric: `${stats.majorDecisions}`,
        detail: "必须真人主动定稿",
        panelTitle: "待人工确认",
        tone: stats.majorDecisions ? "red" : "green",
        action: "定稿"
      })}
      ${jumpModuleCard({
        title: "授权与审批",
        metric: `${pendingPermissions.length + pendingApprovals.length}`,
        detail: `授权 ${pendingPermissions.length} / 审批 ${pendingApprovals.length}`,
        panelTitle: "授权与处置",
        tone: pendingPermissions.length + pendingApprovals.length ? "orange" : "green",
        action: "处理授权"
      })}
      ${jumpModuleCard({
        title: "待处置发现",
        metric: `${openFindings.length}`,
        detail: "发现项会影响关闭门禁",
        panelTitle: "授权与处置",
        tone: openFindings.length ? "orange" : "green",
        action: "处置发现"
      })}
      ${jumpModuleCard({
        title: "历史追溯",
        metric: `${answered.length + finalizations.length}`,
        detail: "已答确认和最近真人收尾记录",
        panelTitle: "已答历史",
        tone: answered.length + finalizations.length ? "blue" : "gray",
        action: "查看历史"
      })}
    </div>
    <div class="small muted">处理顺序：先处理待你处理和阻塞确认，再处理授权 / 审批 / 发现项，最后查看历史追溯。</div>
  `, {wide: true});
}

function renderReviewLifecycleGuide({pending, pendingPermissions, pendingApprovals, openFindings, answered, finalizations}) {
  const stats = reviewStats({pending, pendingPermissions, pendingApprovals, openFindings});
  const todo = pendingForMe();
  return panel("人工审核流程", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "1 待办入口",
        metric: todo.known ? `${todo.total}${todo.partial ? "+" : ""}` : "未知",
        detail: todo.known ? "先处理当前项目里明确分派给你的待办，避免漏掉个人责任项" : "待办数据未完整加载，先查看汇总和明细",
        panelTitle: "待你处理",
        tone: todo.known && todo.total ? "red" : "green",
        action: "看待办"
      })}
      ${jumpModuleCard({
        title: "2 方案定稿",
        metric: pending.length,
        detail: `${stats.majorDecisions} 个核心决策必须真人主动选择；AI 只提交材料，不替人定稿`,
        panelTitle: "待人工确认",
        tone: stats.blockingConfirmations ? "red" : pending.length ? "orange" : "green",
        action: "处理确认"
      })}
      ${jumpModuleCard({
        title: "3 授权审批",
        metric: pendingPermissions.length + pendingApprovals.length,
        detail: "涉及权限、危险操作或阶段门放行时，先看资源范围再批准或驳回",
        panelTitle: "授权与处置",
        tone: pendingPermissions.length + pendingApprovals.length ? "orange" : "green",
        action: "处理授权"
      })}
      ${jumpModuleCard({
        title: "4 发现项处置",
        metric: openFindings.length,
        detail: "发现项会阻塞关闭门；处置时要补齐结论、状态和必要证据",
        panelTitle: "授权与处置",
        tone: openFindings.length ? "orange" : "green",
        action: "处置发现"
      })}
      ${projectModuleCard({
        pageId: "monitor",
        title: "5 执行回看",
        metric: stats.affectedTaskGroups || "回看",
        detail: "提交定稿、授权或处置后，回执行监控看派发继续、控制 ACK 和关闭门变化",
        tone: stats.affectedTaskGroups ? "blue" : "gray",
        action: "看监控"
      })}
      ${jumpModuleCard({
        title: "6 历史追溯",
        metric: answered.length + finalizations.length,
        detail: "已答确认和最近定稿用于追责、复盘和后续系统外升级依据",
        panelTitle: "已答历史",
        tone: answered.length + finalizations.length ? "blue" : "gray",
        action: "看历史"
      })}
    </div>
    <div class="small muted">人工审核是 AI-native 执行链路的阶段门：AI 负责提交结构化材料和互审，人只在目标、权限、风险、定稿和必要纠偏处介入。</div>
    <div class="small muted">处理闭环：待办/确认/授权/发现项 → 提交决定 → 执行监控实时回送 → 任务组关闭门重新计算；系统运行中不会自动把重复问题改造成系统升级。</div>
  `, {wide: true});
}

function renderReview() {
  if (!projectTaskGroups().length) {
    // 「待你处理」按当前项目视图统计，不能被"当前项目有没有任务组"这个不相干的条件
    // 挡在提前返回之后 —— 人切到一个空项目，"3 项等你处理"整块消失，会被读成"已经处理完了"。
    return panel("人工审核", hasNoVisibleProject()
      ? noVisibleProjectNotice()
      : `<div class="notice">当前项目暂无任务组。下面的汇总仍覆盖你可见的全部项目。</div>`, {wide: true})
      + renderPendingForMePanel();
  }
  // 页面级的这个仍是并集，只用来决定「整页要不要提示无权限」；每一条卡片的动作按【它所属的
  // 任务组】判（见下面的 hasGroupPerm）—— 后端就是按资源判的，并集会让人看到按不动的表单。
  const canReview = hasPerm("task_group:review");
  // 集中处理：汇总项目内全部任务组的人工确认（tasks 视角已按可见任务组下发），而非逐组切换
  const projectTaskGroupIds = new Set(focusedTaskGroups().map((taskGroup) => taskGroup.id));
  const allRequests = (state.humanConfirmationRequests || []).filter((request) => projectTaskGroupIds.has(request.taskGroupId)).slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const pending = allRequests.filter((request) => request.status === "pending");
  const answered = allRequests.filter((request) => request.status !== "pending");
  const pendingPermissions = (state.permissionRequests || []).filter((item) => projectTaskGroupIds.has(item.taskGroupId) && item.status === "pending_approval");
  const pendingApprovals = (state.approvalRequests || []).filter((item) => projectTaskGroupIds.has(item.taskGroupId) && ["requested", "quorum_collecting"].includes(item.status));
  const openFindings = (state.findings || []).filter((item) => projectTaskGroupIds.has(item.taskGroupId) && !["resolved", "closed", "dismissed", "wontfix"].includes(item.status));
  const finalizations = recentHumanFinalizations(projectTaskGroupIds);

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
          // 这里只显示前 12 条，而卡片本身在创建时又只留了前 20 条（服务端 evidenceRefsTotal 记着原始条数）。
          // 两层都截而都不说总数，人会以为证据就这些 —— 定稿是照着证据做的。
          const shown = evidence.slice(0, 12);
          const carded = Number(request.question?.evidenceRefsTotal || evidence.length);
          const note = carded > shown.length
            ? `（共 ${esc(carded)} 条，这里显示前 ${shown.length} 条${carded > evidence.length
              ? "；卡片创建时只留了前 " + evidence.length + " 条" : ""}）`
            : "";
          parts.push(`<div class="record-meta"><span>证据引用：${shown.map((ref) => `<span class="mono">${esc(ref)}</span>`).join("、")}${note}</span></div>`);
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
      ${hasGroupPerm(request.taskGroupId, "task_group:review") ? `<form class="form-grid" data-form="hcr-decide" data-request="${esc(request.requestId)}" data-round="${esc(String(request.round || 1))}" style="margin-top:10px;">
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
        <div class="notice" style="margin-top:6px;">定稿前可与 AI 多轮协商：你提方案 → AI 再分析（可提出不合理之处或更优方式）→ 你再决定。只有点「选择定稿」才锁定。</div>
      </form>` : noRightOnThisGroup(request.taskGroupId, "人工审核（定稿）")}
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
    // 被系统作废的单子在这张表里原本是【一行空的 cancelled】：没有选项、没有内容、没有确认人。
    // 人正要回答的问题凭空消失，而作废原因落在 cancelReason 上、全仓没有任何读取点。
    {v: request.status === "cancelled"
      ? esc(`已作废：${explainCoded(request.cancelReason) || request.cancelReason || "（没有记下原因）"}`)
      : esc(request.decision?.inputText || "-"), c: "text-clip"},
    esc(request.decision?.decidedBy ? accountName(request.decision.decidedBy) : "-"),
    {v: fmtTime(request.decision?.decidedAt || request.updatedAt), c: "nowrap"}
  ])).join("");

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
          <div class="record-meta"><span>任务组：${esc(taskGroupNameOf(item.taskGroupId))}</span><span>主体：${esc(accountName(item.subjectId))}</span><span>原因：${esc(item.reason || "-")}</span><span>${fmtTime(item.createdAt)}</span></div>
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
          ${hasGroupPerm(item.taskGroupId, "task_group:review") ? `<form class="form-grid" data-form="approval-resolve" data-request="${esc(item.approvalId)}" style="margin-top:8px;">
            <div class="btn-row"><button class="primary-button" type="submit" name="status" value="approved">批准</button><button class="ghost-button" type="submit" name="status" value="rejected">驳回</button></div>
          </form>` : noRightOnThisGroup(item.taskGroupId, "人工审核（审批）")}
        </div>`).join("")}
      ${openFindings.map((item) => `
        <div class="record">
          <div class="record-title"><strong>发现：${esc(item.summary || item.title || item.findingId)}</strong>${badge(item.status)}${item.severity ? customBadge(t(item.severity), "orange") : ""}</div>
          <div class="record-meta"><span>任务组：${esc(taskGroupNameOf(item.taskGroupId))}</span><span>${fmtTime(item.createdAt)}</span></div>
          <!-- 曾被处置但因证据/归属不全而未能了结：不说明原因的话，人只看到它还开着，
               不知道上一次处置是被什么挡下来的，也就不知道补什么才能过。 -->
          ${item.lastResolutionAttempt ? `<div class="notice warn-notice">上一次处置未能了结它：判为 ${esc(t(item.lastResolutionAttempt.dispositionClass) || item.lastResolutionAttempt.dispositionClass)}（${esc(t(item.lastResolutionAttempt.reason) || item.lastResolutionAttempt.reason)}）。补齐后可再次处置。</div>` : ""}
          ${hasGroupPerm(item.taskGroupId, "task_group:review") ? `<form class="form-grid" data-form="finding-resolve" data-request="${esc(item.findingId)}" style="margin-top:8px;">
            <div class="form-row"><label>处置类别</label>${dispositionSelectHtml}</div>
            <div class="form-row"><label>处置状态</label>${decisionSelect("status", [["resolved", "已解决"], ["closed", "已关闭"], ["dismissed", "已忽略"], ["wontfix", "不修复"]])}</div>
            <div class="form-row"><label>证据引用（可选，逗号分隔）</label><input name="evidenceRefs" placeholder="evidence:..."></div>
            <button class="primary-button" type="submit">提交处置</button>
          </form>` : noRightOnThisGroup(item.taskGroupId, "人工审核（处置发现项）")}
        </div>`).join("")}
      ${!pendingPermissions.length && !pendingApprovals.length && !openFindings.length ? `<div class="notice">当前项目没有待处置的授权 / 审批 / 发现。</div>` : ""}
    </div>`;

  const todoPanel = renderPendingForMePanel();

  return [
    renderReviewSummary({pending, pendingPermissions, pendingApprovals, openFindings, answered, finalizations}),
    renderReviewActionBoard({pending, pendingPermissions, pendingApprovals, openFindings, answered, finalizations}),
    renderReviewLifecycleGuide({pending, pendingPermissions, pendingApprovals, openFindings, answered, finalizations}),
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

function directiveStats(directives) {
  const projectGroupIds = new Set(projectTaskGroups().map((taskGroup) => taskGroup.id));
  const pending = directives.filter((directive) => ["created", "queued", "pending", "accepted"].includes(directive.status)).length;
  const applied = directives.filter((directive) => ["applied", "completed", "executed"].includes(directive.status)
    || (directive.appliedActions || []).length).length;
  const rejected = directives.filter((directive) => ["rejected", "failed"].includes(directive.status)
    || directive.rejectReason).length;
  const involvedGroups = new Set(directives.map((directive) => directive.taskGroupId).filter((id) => projectGroupIds.has(id))).size;
  const controllableGroups = projectTaskGroups().filter((taskGroup) => hasGroupPerm(taskGroup.id, "task_group:control")).length;
  return {pending, applied, rejected, involvedGroups, controllableGroups};
}

function renderDirectiveSummary(directives, canControl) {
  const stats = directiveStats(directives);
  return panel("人工指令总览", `
    <div class="metric-grid">
      ${summaryMetric("指令总数", directives.length, "当前项目范围内的人工指令")}
      ${summaryMetric("待处理", stats.pending, "等待编排周期消费或确认")}
      ${summaryMetric("已执行", stats.applied, "已产生结构化动作")}
      ${summaryMetric("已拒绝", stats.rejected, "需要查看拒绝原因")}
      ${summaryMetric("涉及任务组", stats.involvedGroups, "已有指令触达的任务组")}
      ${summaryMetric("可控任务组", stats.controllableGroups, canControl ? "你可下达控制指令的范围" : "当前账号只能查看")}
    </div>
    <div class="small muted">查看顺序：先看“指令流水”确认是否已提交或被拒，再决定是否下达新指令；指令会进入编排输入，不直接改总控会话。</div>
  `, {wide: true});
}

function renderDirectiveActionBoard(directives, canControl) {
  const stats = directiveStats(directives);
  return panel("人工指令操作看板", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "待处理",
        metric: `${stats.pending}`,
        detail: stats.pending ? "等待编排周期消费或确认" : "当前没有等待处理的指令",
        panelTitle: "指令流水",
        tone: stats.pending ? "orange" : "green",
        action: "查看流水"
      })}
      ${jumpModuleCard({
        title: "已拒绝",
        metric: `${stats.rejected}`,
        detail: stats.rejected ? "需要核对拒绝原因，避免重复提交" : "当前没有被拒绝的指令",
        panelTitle: "指令流水",
        tone: stats.rejected ? "red" : "green",
        action: "查看原因"
      })}
      ${jumpModuleCard({
        title: "已执行",
        metric: `${stats.applied}`,
        detail: "核对已产生的结构化动作",
        panelTitle: "指令流水",
        tone: stats.applied ? "blue" : "gray",
        action: "查看动作"
      })}
      ${jumpModuleCard({
        title: "涉及任务组",
        metric: `${stats.involvedGroups}`,
        detail: "已有指令触达的任务组范围",
        panelTitle: "指令流水",
        tone: stats.involvedGroups ? "blue" : "gray",
        action: "查看范围"
      })}
      ${jumpModuleCard({
        title: "可控任务组",
        metric: `${stats.controllableGroups}`,
        detail: canControl ? "你可下达控制指令的范围" : "当前账号只能查看",
        panelTitle: "下达人工指令",
        tone: canControl ? "blue" : "orange",
        action: canControl ? "准备下达" : "查看权限"
      })}
      ${jumpModuleCard({
        title: "下达入口",
        metric: canControl ? "可用" : "只读",
        detail: "向总控提交结构化输入，不直接改会话",
        panelTitle: "下达人工指令",
        tone: canControl ? "blue" : "gray",
        action: "打开表单"
      })}
    </div>
    <div class="small muted">处理顺序：先核对待处理、拒绝原因和已执行动作，再下达新指令。</div>
  `, {wide: true});
}

function renderDirectiveLifecycleGuide(directives, canControl) {
  const stats = directiveStats(directives);
  return panel("人工指令流程", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "1 选任务组",
        metric: stats.controllableGroups,
        detail: canControl ? "只能向你有任务组控制权的组下达指令，避免跨组误操作" : "当前账号只读，不能下达新指令",
        panelTitle: "下达人工指令",
        tone: canControl ? "blue" : "gray",
        action: canControl ? "选目标" : "看权限"
      })}
      ${jumpModuleCard({
        title: "2 选指令类型",
        metric: DIRECTIVE_TYPES.length,
        detail: "暂停、恢复、取消、调优先级、补充要求和决策处置都会落成结构化输入",
        panelTitle: "下达人工指令",
        tone: "blue",
        action: "看类型"
      })}
      ${jumpModuleCard({
        title: "3 提交输入",
        metric: canControl ? "可提交" : "只读",
        detail: "表单不会直接改总控会话，只生成可审计的人工指令记录",
        panelTitle: "下达人工指令",
        tone: canControl ? "blue" : "gray",
        action: "打开表单"
      })}
      ${jumpModuleCard({
        title: "4 编排消费",
        metric: stats.pending,
        detail: "待处理指令由下一编排周期读取；拒绝会写明原因，不能静默失败",
        panelTitle: "指令流水",
        tone: stats.pending ? "orange" : "green",
        action: "看待处理"
      })}
      ${jumpModuleCard({
        title: "5 核对结果",
        metric: stats.applied,
        detail: "已执行动作会留在流水里；被拒绝时先看原因，再决定是否重新提交",
        panelTitle: "指令流水",
        tone: stats.rejected ? "red" : stats.applied ? "blue" : "gray",
        action: "看流水"
      })}
      ${projectModuleCard({
        pageId: "monitor",
        title: "6 回看运行",
        metric: stats.involvedGroups || "回看",
        detail: "指令被消费后，到执行监控查看派发、会话、事件流和控制 ACK 是否按预期变化",
        tone: stats.involvedGroups ? "blue" : "gray",
        action: "看监控"
      })}
    </div>
    <div class="small muted">人工指令是给 AI-native 总控的结构化控制输入，不是给总控会话直接发聊天消息；系统会按任务组权限、状态机和编排周期消费。</div>
    <div class="small muted">推荐闭环：先查流水和拒绝原因 → 选择目标任务组和指令类型 → 提交 → 等编排消费 → 到执行监控看实时回送。</div>
  `, {wide: true});
}

function renderDirectives() {
  if (!projectTaskGroups().length) {
    return panel("人工指令", hasNoVisibleProject()
      ? noVisibleProjectNotice()
      // 空态要给出口：人工指令以任务组为目标，没有任务组时告诉人先去哪一页建，别只陈述一句"暂无"。
      : `<div class="notice">当前项目暂无任务组：人工指令以任务组为目标，先到「任务组」页创建一个再来。
          <div class="button-row" style="margin-top:8px;"><button class="secondary-button" data-menu="tg">去创建任务组</button></div></div>`, {wide: true});
  }
  const directiveRows = directiveList.map((directive) => row([
    {v: fmtTime(directive.createdAt), c: "nowrap"},
    badge(directive.directiveType, "blue"),
    directive.workItemId
      ? `<strong>${esc((taskGroupById(directive.taskGroupId)?.workItems || []).find((work) => work.id === directive.workItemId)?.title || "具体任务")}</strong><div class="small muted mono">${esc(directive.workItemId)}</div>`
      : `<span class="muted">整个任务组</span>`,
    {v: esc(directive.instruction || "-"), c: "text-clip"},
    badge(directive.status),
    {v: esc((directive.appliedActions || []).map((action) => t(action.action)).join("、") || "-"), c: "text-clip"},
    esc(directive.rejectReason ? t(directive.rejectReason) : "-")
  ])).join("");

  const canControl = managementGroupId ? hasGroupPerm(managementGroupId, "task_group:control") : hasPerm("task_group:control");
  const directiveTargetWorks = taskGroupById(directiveTaskGroupId)?.workItems || [];
  const targetWorkKnown = directiveTargetWorks.some((work) => work.id === directiveWorkItemId);
  const formHtml = canControl ? `
        <form class="form-grid" data-form="directive-create">
          <div class="form-row"><label>目标任务组</label>${taskGroupSelector(directiveTaskGroupId, "directive-tg", "task_group:control")}</div>
          <div class="form-row"><label>指令类型</label>
            <select name="directiveType">${DIRECTIVE_TYPES.map(([value, label]) => `<option value="${esc(value)}"${value === "free_text" ? " selected" : ""}>${esc(label)}</option>`).join("")}</select>
          </div>
          <div class="form-row directive-fields" data-directive-types="resolve_decision" hidden><label>决策处置方式</label>
            <!-- 不带 required：这个下拉只对「决策处置」类型生效，而浏览器的约束校验不看类型 ——
                 带上就连提交「补充要求」也会被拦住，逼人选一个随后被丢掉的处置方式。空着提交由处理器按类型拒。 -->
            ${decisionSelect("resolution", [["reopen", "重开（返回就绪，重置返工计数）"], ["abandon", "放弃（置为已替代，解除关闭阻塞）"]], "请选择处置方式…", {required: false})}
            <span class="small muted">仅“决策处置”类型生效</span>
          </div>
          <div class="form-row directive-fields" data-directive-types="adjust_priority" hidden><label>优先级档位</label>
            <!-- 仅「调整优先级」类型生效；不 required（浏览器约束不看类型）。空着提交由服务端拒：
                 调优先级落到调度器真读的 admissionPriorityClass，不选档位又不写关键词就是静默无效。 -->
            ${decisionSelect("priorityClass", [["p0_safety", t("p0_safety")], ["unblock_many", t("unblock_many")], ["available_window", t("available_window")], ["current_condition", t("current_condition")], ["capability_data", t("capability_data")], ["readiness_preflight", t("readiness_preflight")], ["formal_gate", t("formal_gate")]], "请选择优先级档位…", {required: false})}
            <span class="small muted">仅“调整优先级”类型生效；不选档位这条指令对执行顺序没有影响</span>
          </div>
          <div class="form-row directive-fields" data-directive-types="adjust_priority add_requirement resolve_decision free_text"><label>作用目标</label>
            <select name="workItemId" data-select="directive-work"><option value="">整个任务组</option>
              ${!targetWorkKnown && directiveWorkItemId ? `<option value="${esc(directiveWorkItemId)}" selected>当前任务 · ${esc(directiveWorkItemId)}</option>` : ""}
              ${directiveTargetWorks.map((work) => `<option value="${esc(work.id)}"${work.id === directiveWorkItemId ? " selected" : ""}>${esc(work.title || work.id)}</option>`).join("")}
            </select><span class="small muted">从任务详情进入时会自动选中该任务；留在“整个任务组”时才会影响组内全部未完成任务。</span></div>
          <div class="form-row"><label>指令内容</label><textarea name="instruction" placeholder="补充要求 / 自由指令必填，其余类型可选"></textarea></div>
          <button class="primary-button" type="submit">提交指令</button>
        </form>
  ` : `<div class="notice warn-notice">当前账号无“任务组控制 / 人工指令”权限，仅可查看指令流水。</div>`;

  return [
    renderDirectiveSummary(directiveList, canControl),
    renderDirectiveActionBoard(directiveList, canControl),
    renderDirectiveLifecycleGuide(directiveList, canControl),
    panel("指令流水", table([{label: "时间", c: "nowrap"}, "类型", "作用目标", {label: "指令内容", c: "text-clip"}, "状态", {label: "已执行动作", c: "text-clip"}, "拒绝原因"], directiveRows), {wide: true, headerSide: filterInput("按指令内容过滤…", "directives")}),
    panel("下达人工指令", `
      <div class="stack">
        <div class="notice">总控与调度会话不接受人工直接输入。所有人工操作通过本通道生成结构化指令，由编排周期作为决策输入消费并全程留审计。</div>
        ${formHtml}
      </div>
    `, {wide: true})
  ].join("");
}

/* ---------------- 成员：执行监控 ---------------- */

function renderMonitorSummary({eventsShown, sessionsAll, dispatchesAll, lanesAll, nodes, barriersInScope}) {
  const activeSessions = sessionsAll.filter((session) =>
    !["completed", "failed", "cancelled", "recycled", "closed"].includes(session.status)).length;
  const activeDispatches = dispatchesAll.filter((dispatch) => !terminalDispatchStatuses.has(dispatch.status)).length;
  const onlineNodes = nodes.filter((node) => node.status === "online").length;
  const blockedBarriers = barriersInScope.filter((barrier) => !barrier.satisfied).length;
  const blockingObjects = barriersInScope.reduce((sum, barrier) => sum + Number((barrier.blockingObjects || []).length), 0);
  return panel("执行监控总览", `
    <div class="metric-grid">
      ${summaryMetric("实时事件", eventsShown.length, "当前监听范围内的执行事件")}
      ${summaryMetric("活跃会话", activeSessions, "仍在运行、等待或受阻的工作会话")}
      ${summaryMetric("待执行派发", activeDispatches, "排队、已领走或执行中的派发")}
      ${summaryMetric("执行载体", lanesAll.length, "可复用 worker lane")}
      ${summaryMetric("在线节点", `${onlineNodes}/${nodes.length}`, "可承接任务的 agent 节点")}
      ${summaryMetric("关闭阻塞", blockingObjects, `${blockedBarriers} 个任务组仍未满足关闭门`)}
    </div>
    <div class="small muted">查看顺序：先看“实时事件流”，再看“智能体派发”和“工作会话”；需要收尾时看“关闭门禁”和“阻塞项人工处置”。</div>
  `, {wide: true});
}

function monitorActionCard({title, metric, detail, panelTitle, tone = "blue"}) {
  return jumpModuleCard({title, metric, detail, panelTitle, tone});
}

function renderMonitorActionBoard({
  dispatchesAll,
  sessionsAll,
  nodes,
  barriersInScope,
  stuckTopologies,
  downgradableTopologies,
  failingTests,
  waivableGates,
  openReviewPlans,
  openReviewBundles,
  openRuleSources,
  openUpgradeCandidates,
  blockingDefinitions
}) {
  const blockedDispatches = dispatchesAll.filter((dispatch) => dispatch.status === "blocked").length;
  const blockedSessions = sessionsAll.filter((session) => !SESSION_SETTLED_STATUSES.includes(session.status)
    && Boolean(session.blockedReason)).length;
  const barrierObjects = barriersInScope.reduce((sum, barrier) =>
    sum + (barrier.satisfied ? 0 : Number((barrier.blockingObjects || []).length)), 0);
  const topologyIssues = stuckTopologies.length + downgradableTopologies.length;
  const reviewClosures = openReviewPlans.length + openReviewBundles.length + openRuleSources.length
    + openUpgradeCandidates.length + blockingDefinitions.length;
  const qualityIssues = failingTests.length + waivableGates.length;
  const abnormalNodes = nodes.filter((node) => node.status !== "online" || heartbeatTimedOut(node)
    || node.runtimeOutdated || (node.selfCheckMissing || []).length
    || !["ok", "healthy", "normal", undefined, ""].includes(node.display?.health)).length;
  const nodeMetric = nodes.length ? `${abnormalNodes}/${nodes.length}` : "0";
  const nodeDetail = nodes.length
    ? (abnormalNodes
      ? "存在离线、心跳过旧、自检缺项或运行时过旧节点；先恢复 agent 主机/进程心跳，能力修好后到「项目管理」→「项目 Agent」→「项目运行节点」点「刷新自检」"
      : "可见节点当前正常")
    : "当前项目没有可见 agent 节点；先到「项目管理」→「项目 Agent」→「注册项目节点」签发加入令牌并复制服务端安装脚本";
  const nodeTone = nodes.length ? (abnormalNodes ? "orange" : "green") : "gray";
  const orchestrator = state.runtime?.autonomousOrchestrator || {};
  const orchestratorIssues = Number(orchestrator.consecutiveErrors || 0);
  const cards = [
    monitorActionCard({
      title: "派发 / 会话",
      metric: `${blockedDispatches + blockedSessions}`,
      detail: blockedDispatches || blockedSessions
        ? `${blockedDispatches} 个派发被挡，${blockedSessions} 个会话等处置`
        : "当前没有被挡住的派发或会话",
      panelTitle: blockedDispatches ? "智能体派发" : "工作会话",
      tone: blockedDispatches || blockedSessions ? "red" : "green"
    }),
    monitorActionCard({
      title: "关闭门禁",
      metric: `${barrierObjects}`,
      detail: barrierObjects ? "任务组收尾前必须清掉这些阻塞对象" : "当前关闭门禁没有阻塞对象",
      panelTitle: "关闭门禁",
      tone: barrierObjects ? "red" : "green"
    }),
    monitorActionCard({
      title: "执行方案",
      metric: `${topologyIssues + reviewClosures}`,
      detail: topologyIssues
        ? `${topologyIssues} 个方案需要终止或降级`
        : reviewClosures
          ? `${reviewClosures} 个评审/规则/定义收尾项`
          : "当前没有待人工收尾的执行方案",
      panelTitle: "阻塞项人工处置",
      tone: topologyIssues || reviewClosures ? "orange" : "green"
    }),
    monitorActionCard({
      title: "质量 / 测试",
      metric: `${qualityIssues}`,
      detail: failingTests.length ? `${failingTests.length} 个测试失败，可能挡住关闭门` : "当前没有待豁免或失败的质量项",
      panelTitle: "质量门禁 / 测试证据",
      tone: qualityIssues ? "orange" : "green"
    }),
    monitorActionCard({
      title: "节点",
      metric: nodeMetric,
      detail: nodeDetail,
      panelTitle: "agent 节点",
      tone: nodeTone
    }),
    monitorActionCard({
      title: "自治周期",
      metric: `${orchestratorIssues}`,
      detail: orchestratorIssues ? "自治周期连续失败，需要先看控制面原因" : "自治周期没有连续失败记录",
      panelTitle: "自治控制",
      tone: orchestratorIssues ? "red" : "blue"
    })
  ];
  return panel("监控处置看板", `
    <div class="module-grid action-grid">${cards.join("")}</div>
    <div class="small muted">先点红色或橙色卡片看明细；绿色表示当前没有需要人立即处理的同类问题。看板只聚合当前项目范围内已加载的数据。</div>
  `, {wide: true});
}

function renderMonitorRealtimeGuide({eventsShown, sessionsAll, dispatchesAll, commandsInScope, nodes, barriersInScope}) {
  const activeSessions = sessionsAll.filter((session) => !SESSION_SETTLED_STATUSES.includes(session.status)).length;
  const activeDispatches = dispatchesAll.filter((dispatch) => !terminalDispatchStatuses.has(dispatch.status)).length;
  const pendingCommands = commandsInScope.filter((command) => !["completed", "failed", "rejected", "cancelled"].includes(command.status)).length;
  const onlineNodes = nodes.filter((node) => node.status === "online" && !heartbeatTimedOut(node)).length;
  const blockingBarriers = barriersInScope.reduce((sum, barrier) =>
    sum + (barrier.satisfied ? 0 : Number((barrier.blockingObjects || []).length)), 0);
  return panel("实时回送链路", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "1 派发会话",
        metric: `${activeDispatches}/${activeSessions}`,
        detail: "总控把工作项落成派发和工作会话，Agent 从服务端原子领活",
        panelTitle: activeDispatches ? "智能体派发" : "工作会话",
        tone: activeDispatches || activeSessions ? "blue" : "gray",
        action: "看派发"
      })}
      ${jumpModuleCard({
        title: "2 实时事件",
        metric: eventsShown.length,
        detail: "Agent 执行中持续回送进度、输出摘要、仓库变更、push 和 checkpoint 准备",
        panelTitle: "实时事件流",
        tone: eventsShown.length ? "blue" : "gray",
        action: "看事件"
      })}
      ${jumpModuleCard({
        title: "3 控制通道",
        metric: pendingCommands,
        detail: "暂停、取消、刷新自检和吊销命令先在服务端落盘，再由节点长轮询领取并 ACK",
        panelTitle: "控制通道",
        tone: pendingCommands ? "orange" : "green",
        action: "看命令"
      })}
      ${jumpModuleCard({
        title: "4 agent 节点",
        metric: `${onlineNodes}/${nodes.length}`,
        detail: "节点只报告自身 Runtime 状态；远程 MCP、Skill 工作集和任务控制都由服务端统一调度",
        panelTitle: "agent 节点",
        tone: onlineNodes ? "green" : nodes.length ? "orange" : "gray",
        action: "看节点"
      })}
      ${jumpModuleCard({
        title: "5 收尾门禁",
        metric: blockingBarriers,
        detail: "检查点、质量门、人工定稿和共享定义都满足后，任务组才允许关闭",
        panelTitle: "关闭门禁",
        tone: blockingBarriers ? "red" : "green",
        action: "看门禁"
      })}
    </div>
    <div class="small muted">实时链路不依赖人盯终态：Agent 运行中持续上报事件；总控和监测角色通过服务端状态及时纠偏；管理界面点击派发、会话或节点即可查看对应明细。</div>
  `, {wide: true});
}

function repositoryFailureAction(item) {
  const reason = String(item?.failureReason || item?.blockedReason || item?.summary || "");
  if (!/(?:git_auth_failed|repository_auth_failed|credential_missing|repository_credential_unreadable)(?::|\b)/u.test(reason)) return "";
  const group = taskGroupById(item.taskGroupId);
  const project = (state.projects || []).find((entry) => entry.id === group?.projectId);
  if (!project || (item.projectId && item.projectId !== project.id)) return "";
  const dispatch = item.dispatchId
    ? (state.agentDispatches || []).find((entry) => entry.dispatchId === item.dispatchId && entry.projectId === project.id)
    : null;
  const output = (state.repositoryOutputs || []).find((entry) => entry.targetId === dispatch?.repositoryOutputTargetRef && entry.projectId === project.id);
  return `<div class="repository-recovery"><button class="secondary-button" data-action="open-project-page"
    data-project="${esc(project.id)}" data-target-menu="proj-settings" data-repo-focus="${esc(output?.repositoryId || "")}">检查仓库凭证</button></div>`;
}

function renderMonitor() {
  // 一个项目都没有时，这一页原先摆出十一张"暂无数据"的空表和一个空的监听范围下拉 ——
  // 屏幕上全是表头，没有一句话说明为什么什么都没有、下一步该做什么。
  // 条件是"没有项目，且这一页范围内一件事都没有"。生产上 projects 为空时本来就取不到任务组，
  // 两个条件必然同时成立；多这一句只是不去误伤那些"任务组挂着 projectId、状态里却没有 projects"
  // 的老夹具 —— 那种形状真实部署里不存在，但把它们逐个改掉的风险大于收益。
  if (hasNoVisibleProject() && !projectTaskGroups().length) {
    return panel("执行监控", noVisibleProjectNotice(), {wide: true});
  }
  const groups = focusedTaskGroups();
  // 这一页整体以"当前项目"为抬头，因此页内每张表都必须按它过滤。
  // 此前七张表里有五张漏了，最严重的一张还挂着"关闭任务组"按钮。
  const inScope = (item) => groups.some((taskGroup) => taskGroup.id === item.taskGroupId);
  const scopeOptions = [
    {value: `project:${currentProjectId}`, label: "整个项目"},
    ...groups.map((taskGroup) => ({value: `taskGroup:${taskGroup.id}`, label: `任务组 · ${taskGroup.name || taskGroup.id}`}))
  ];
  const scopeValue = execScope.id ? `${execScope.type}:${execScope.id}` : "";
  if (execScope.id && !scopeOptions.some((option) => option.value === scopeValue)) {
    scopeOptions.unshift({value: scopeValue, label: `${execScope.type === "dispatch" ? "派发" : execScope.type === "session" ? "会话" : "任务组"} · ${execScope.id}`});
  }

  const eventsShown = filterSource(execEvents.filter((event) => !managementGroupId || event.taskGroupId === managementGroupId).slice().reverse(), "events");
  const eventRows = eventsShown.slice(0, 120).map((event) => row([
    {v: esc(event.sequence), c: "num"},
    badge(event.eventType, "blue"),
    {v: percentCell(event.progressPercent), c: "num"},
    badge(event.status),
    // 证据引用此前从不渲染，而执行方恰恰在这里上报了"这次提示词里实际包含了哪几份规则文件"
    // （prompt-includes:system/rules.md 之类）。人在控制台上只看得到 summary 里那句"含 N 个规则文件"，
    // 看不到是哪几个 —— 而"人写下的那份规则有没有真的到达模型"正是要从这里回答的。
    {v: `${esc(event.summary || "-")}${evidenceRefsHint(event)}${repositoryFailureAction(event)}`, c: "text-clip"},
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
    esc(explainCoded(session.blockedReason)) + repositoryFailureAction(session),
    `<button class="secondary-button" data-action="show-session-events" data-session-id="${esc(session.sessionId)}">事件</button>`
  ])).join("");

  const dispatchesAll = filterSource((state.agentDispatches || []).filter((dispatch) => groups.some((taskGroup) => taskGroup.id === dispatch.taskGroupId)), "dispatches");
  const dispatches = dispatchesAll.slice(0, 20).map((dispatch) => {
    const canControlDispatch = hasGroupPerm(dispatch.taskGroupId, "task_group:control") && dispatch.assignedNodeId && !terminalDispatchStatuses.has(dispatch.status);
    const controls = [
      `<button class="secondary-button" data-action="show-dispatch-events" data-dispatch-id="${esc(dispatch.dispatchId)}">事件</button>`,
      canControlDispatch && dispatch.status === "blocked" ? `<button class="secondary-button" data-action="agent-control" data-node-id="${esc(dispatch.assignedNodeId)}" data-dispatch-id="${esc(dispatch.dispatchId)}" data-command="resume_dispatch">恢复</button>` : "",
      canControlDispatch && ["queued", "running"].includes(dispatch.status) ? `<button class="secondary-button" data-action="agent-control" data-node-id="${esc(dispatch.assignedNodeId)}" data-dispatch-id="${esc(dispatch.dispatchId)}" data-command="pause_dispatch">暂停</button>` : "",
      canControlDispatch ? `<button class="danger-button" data-action="agent-control" data-node-id="${esc(dispatch.assignedNodeId)}" data-dispatch-id="${esc(dispatch.dispatchId)}" data-command="cancel_dispatch">取消</button>` : ""
    ].filter(Boolean).join(" ");
    return row([
    `<span class="mono">${esc(dispatch.dispatchId)}</span>`,
    `<span class="mono">${esc(dispatch.workItemId || "-")}</span>`,
    badge(dispatch.status),
    {v: percentCell(dispatch.progressPercent), c: "num"},
    // 「最近动静」＝上一条执行事件到现在有多久。进度百分比是【最高水位】（只增不减），
    // 所以一个卡住的派发会一直显示同一个数字，看不出它其实早就不动了。
    // 已了结的派发不能说「还没被领走」：认领时间在了结时被清掉，于是一条【已完成】的派发
    // 在这一列上写着"还没被领走"（真实运行态上读到的，doctor 那条 work_management_ui 正是如此）。
    // 了结记录的 updatedAt 就是它最后一次动的时间，说这个既准确又不夸大。
    {v: dispatch.lastExecutionEventAt
      ? esc(sinceText(dispatch.lastExecutionEventAt))
      : terminalDispatchStatuses.has(dispatch.status)
        ? `<span class="muted">已了结${dispatch.updatedAt ? ` ${esc(sinceText(dispatch.updatedAt))}` : ""}</span>`
        : `<span class="muted">${dispatch.claimedAt ? `领走 ${esc(sinceText(dispatch.claimedAt))}，还没有过动静` : "还没被领走"}</span>`,
      c: "nowrap"},
    // 这两个标记控制面早就在写了（写它们的注释里明写着"必须留痕并让人看到"），而控制台从来没有
    // 渲染过它们 —— 于是人只看到"认领超时重新入队"，看不到最要紧的那句：上一任可能已经把提交推上去了。
    // 新持有者的 reset --hard origin/<branch> 会把那些提交当作基线继续往上做，而没有任何人复核过它们。
    [
      esc(explainCoded(dispatch.blockedReason || dispatch.failureReason)),
      repositoryFailureAction(dispatch),
      // 卡在人工确认上时，控制面【知道】是哪一张卡挡住的（dispatch.humanConfirmationRef），
      // 而这里从来没显示过它 —— 人只看到"到人工审核页定稿对应的确认卡"，
      // 却不知道是哪一张；审核页上同时挂着好几张时，只能一张张点开比对。
      dispatch.humanConfirmationRef
        ? `<div class="small muted">在等这张卡：<span class="mono">${esc(dispatch.humanConfirmationRef)}</span></div>`
        : "",
      dispatch.previousHolderMayHavePushed
        ? `<div class="small warn-text">⚠ 上一任持有者${dispatch.recycledFromNodeId ? `（${esc(dispatch.recycledFromNodeId)}）` : ""}可能已经推送过提交：新持有者会把它们当作基线，需人工核对该分支</div>`
        : "",
      dispatch.rulesChangedAfterContract
        ? `<div class="small warn-text">⚠ 契约签发之后规则发生过变更：这次执行遵循的可能不是当前生效的规则</div>`
        : ""
    ].filter(Boolean).join(""),
    controls
  ]);
  }).join("");

  const commandsInScope = (state.agentControlCommands || []).filter(inScope);
  const commands = commandsInScope.slice(0, 16).map((command) => row([
    {v: esc(command.sequence), c: "num"},
    `<span class="mono">${esc(command.nodeId)}</span>`,
    badge(command.commandType, "blue"),
    `<span class="mono">${esc(command.dispatchId || command.sessionId || "-")}</span>`,
    badge(command.status),
    // 节点报回来的原因（ackResult.reason）：网关一直在存，全仓零处读 ——
    // 屏幕上只有一个「已拒绝」，人无处可查为什么。code:detail 形态交给 explainCoded 查词表。
    {v: esc(explainCoded(command.ackResult?.reason || "")) || "-", c: "text-clip"},
    {v: fmtTime(command.updatedAt || command.createdAt), c: "nowrap"}
  ])).join("");

  const canControlNodes = hasPerm("agent:activate");
  const canOrchestrate = hasPerm("task_group:orchestrate");
  const involvedNodeIds = new Set([...dispatchesAll.map((dispatch) => dispatch.assignedNodeId), ...commandsInScope.map((command) => command.nodeId)].filter(Boolean));
  const monitorNodes = (state.agentRuntimeNodes || []).filter((node) => !managementGroupId || involvedNodeIds.has(node.nodeId));
  const nodes = monitorNodes.map((node) => row([
    `<strong>${esc(node.nodeName || node.nodeId)}</strong><div class="small muted mono">${esc(node.nodeId)}</div>`,
    // "降级/只读"此前不说原因：缺哪几项自检只进网关事件负载，而那条流没有任何界面。
    // 人看到一个黄色徽标，然后无从下手。
    `${heartbeatTimedOut(node)
      ? `${badge("heartbeat_timeout")}<div class="small warn-text">记录上还写着「${esc(t(node.status) || node.status)}」——`
        + "那是上一次扫描留下的，心跳早就断了</div>"
      : badge(node.status)}${claimMissHint(node)}${node.runtimeOutdated
      ? `<div class="small warn-text">运行时版本过旧（${esc(node.runtimeVersion || "未知")}）：它不发送认领代次，一旦这台机器上的派发被重新认领，提交就会被拒。请在该主机上重新执行入网安装命令升级。</div>`
      : ""}${(node.selfCheckMissing || []).length
      ? `<div class="small warn-text">自检未通过：${(node.selfCheckMissing || []).map((item) => esc(t(item))).join("、")}</div>`
        + selfCheckFailureHint(node) : ""}`,
    badge(node.admission),
    // 心跳时间戳原先只是一个时间：人得自己算它有多旧，而"节点其实已经死了"正是最该一眼看出来的。
    {v: `${fmtTime(node.lastHeartbeatAt)}${heartbeatStaleHint(node)}`, c: "nowrap"},
    node.status !== "revoked" && canControlNodes ? agentActions(node, {scope: "project", showDanger: false, includeDispatchControl: false}) : "-"
  ])).join("");

  const decisionsInScope = (state.modelSelectionDecisions || []).filter(inScope);
  const decisions = decisionsInScope.slice(0, 10).map((decision) => row([
    // 套用了别人的策略要在【角色】这一列上说出来：这条决策依据的能力要求与硬约束
    // 不是这个角色自己的（22 个已登记角色里有 10 个没有专属策略）。留痕不显示等于没留。
    esc(t(decision.roleId)) + (decision.policyFallback
      ? `<div class="small warn-text">套用了 ${esc(decision.policyFallback.boundTo || "别的角色")} 的选型策略（本角色没有专属策略）</div>`
      : ""),
    decision.selectedAgentId
      ? `<strong>${esc((state.agents || []).find((agent) => agent.id === decision.selectedAgentId)?.name || decision.selectedAgentId)}</strong>
        <div class="small muted mono">${esc(decision.selectedAgentId)}</div>
        <div class="small muted">偏好：${esc(AGENT_MODEL_PRESET_LABEL[decision.agentModelPreference] || decision.agentModelPreference || "未设置")}</div>`
      : `<span class="muted">未绑定档案</span>`,
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
  const finalizations = recentHumanFinalizations(new Set(groups.map((taskGroup) => taskGroup.id)));

  // 卡住的执行方案会永久挡住关闭门：分支报了 failed 之后拓扑照样进 integrating，merge 只认  // 卡住的执行方案会永久挡住关闭门：分支报了 failed 之后拓扑照样进 integrating，merge 只认
  // accepted、cancel 又只有人能做。后端一直有"人来取消"这条杠杆（契约检查专门断言过它必须存在），
  // 但 executionTopologies 根本不在下发字段里，界面上也没有入口 —— 后端有杠杆而界面没有入口，
  // 等于这个杠杆不存在：人只看到"存在阻塞 · N 项"里的一个红 chip，然后无从下手。
  const TOPOLOGY_CANCELLABLE = ["running", "integrating", "blocked", "needs_reconcile"];
  const stuckTopologies = (state.executionTopologies || [])
    .filter((item) => inScope(item) && TOPOLOGY_CANCELLABLE.includes(item.status)).slice(0, 8);
  // 资格检查没过的方案是另一个死角，而且此前【整个界面都看不到它】：
  //   start 被阻塞项挡下 · cancel 只从上面那四种状态走 · 于是后端唯一接受的出口是【降级为串行】。
  // 人在任务组上只看到"存在阻塞 · N 项"一个红 chip，点不进去也不知道该做什么，
  // 而 no_open_execution_topologies 会一直挡着关闭门（非终态）。降级后进入 downgraded 终态。
  const downgradableTopologies = (state.executionTopologies || [])
    .filter((item) => inScope(item) && item.status === "eligibility_checked" && (item.blockers || []).length)
    .slice(0, 8);
  const canControlRules = hasPerm("task_group:control");   // rule_source_settle
  const canUpdateProject = hasPerm("project:update");      // shared_definition_resolve
  // 【够不着的那几条要按任务组数，不能按跨资源并集判】。canReviewGates 之类走的是
  // effectivePermissions —— 服务端注释里就写着它只是 UI 提示、是所有资源上的并集。
  // 于是在 tg1 上有评审权的人，canReviewGates 为真：那句"你没有权限"的警告不显示；
  // 而下面每一段又按任务组过滤，tg2 里那两条待收尾的评审计划一条都不列 ——
  // 结果是它们既不显示、也不解释，人只看到任务组上「存在阻塞」，而它们正挡着关闭门。
  // 改成逐项数：够不着的有几条、在哪几个组、缺哪个权限，都说出来。
  const outOfReach = [
    ...openReviewPlans.filter((item) => !hasGroupPerm(item.taskGroupId, "task_group:review"))
      .map((item) => ["评审计划", item.taskGroupId, "人工审核(task_group:review)"]),
    ...openReviewBundles.filter((item) => !hasGroupPerm(item.taskGroupId, "task_group:review"))
      .map((item) => ["评审包", item.taskGroupId, "人工审核(task_group:review)"]),
    ...openRuleSources.filter((item) => !hasGroupPerm(item.taskGroupId, "task_group:control"))
      .map((item) => ["规则来源", item.taskGroupId, "任务组控制(task_group:control)"]),
    ...openUpgradeCandidates.filter((item) => !hasGroupPerm(item.taskGroupId, "task_group:control"))
      .map((item) => ["升级候选", item.taskGroupId, "任务组控制(task_group:control)"]),
    ...(canUpdateProject ? [] : blockingDefinitions.map((item) => ["共享定义契约", item.taskGroupId, "项目更新(project:update)"]))
  ];
  const outOfReachBlockerNotice = () => {
    if (!outOfReach.length) return "";
    const byPerm = new Map();
    for (const [kind, taskGroupId, perm] of outOfReach) {
      if (!byPerm.has(perm)) byPerm.set(perm, {count: 0, kinds: new Set(), groups: new Set()});
      const bucket = byPerm.get(perm);
      bucket.count += 1;
      bucket.kinds.add(kind);
      if (taskGroupId) bucket.groups.add(taskGroupNameOf(taskGroupId));
    }
    const lines = [...byPerm].map(([perm, bucket]) =>
      `${[...bucket.kinds].join("、")} ${bucket.count} 项`
      + `${bucket.groups.size ? `（${[...bucket.groups].slice(0, 3).join("、")}${bucket.groups.size > 3 ? "…" : ""}）` : ""}`
      + ` —— 需要「${perm}」`);
    return `<div class="notice warn-notice">其中 ${outOfReach.length} 项你处置不了，它们仍然挡着关闭门：`
      + `${esc(lines.join("；"))}。权限按【任务组】授予（在别的组上有同名权限不算），`
      + "只能在「项目管理」→「成员权限」→「项目成员授权」里按角色授予（例如\"评审人\"），请找项目负责人或组织管理员授予后再来。</div>";
  };

  // 同段其余六处都按 inScope 过滤，唯独关闭门禁没有 —— 于是在项目 A 的监控页上会列出项目 B 的
  // 门禁，并且直接给出"关闭任务组"按钮。关闭是最不可逆的一步（写 humanFinalization 且只能关一次），
  // 在错误的项目抬头下点它，人以为关的是 A 的任务组。
  const barriersInScope = (state.closeBarriers || []).filter(inScope);
  const barriers = barriersInScope.slice(0, 8).map((barrier) => row([
    esc(taskGroupNameOf(barrier.taskGroupId)),
    barrier.satisfied ? customBadge("可关闭", "green") : customBadge("存在阻塞", "red"),
    {v: String((barrier.blockingObjects || []).length), c: "num"},
    {v: fmtTime(barrier.computedAt), c: "nowrap"},
    (barrier.satisfied && hasGroupPerm(barrier.taskGroupId, "task_group:control")
      && taskGroupById(barrier.taskGroupId)?.status !== "closed")
      ? `<button class="primary-button" data-action="close-task-group" data-task="${esc(barrier.taskGroupId)}">关闭任务组</button>`
      : (taskGroupById(barrier.taskGroupId)?.status === "closed"
        // 关闭任务组是真人专属的决定，而【谁定的、什么时候定的】此前落在 confirmedBy/confirmedAt 上
        // 却没有任何读取点：屏幕上只有一个"已关闭"，追不到人。
        ? `${customBadge("已关闭", "gray")}${barrier.confirmedBy
          ? `<div class="record-meta">由 ${esc(accountName(barrier.confirmedBy))} 定稿于 ${fmtTime(barrier.confirmedAt)}</div>`
          : ""}`
        : "-")
  ])).join("");

  // 刚装完打开这一页，十一张表全是"暂无数据" —— 每一张都在说"这里什么都没有"，
  // 却没有一张说【为什么】和【下一步】。人分不清"还没开始跑"和"跑了但记录没取回来"。
  // 只在这一页范围内一件事都没有时说一句；有任何一条记录就不说（常亮的提示等于没有提示）。
  // 用这一页【已经算好的那几个作用域数组】判空，不再直接点名集合：
  // 账本限流那道门按"谁提到了这个集合名"找渲染点，直接点名会被它当成一处没设上限的渲染。
  const nothingRanYet = !eventsShown.length && !sessionsAll.length && !dispatchesAll.length
    && !lanesAll.length && !admissionsInScope.length && !nodes.length;
  // 项目空间已经和系统/组织空间拆开，跨空间指路不能再写成"去某某页"：
  // 人在当前左侧菜单里看不到那一项，会以为功能丢了。先点空间，再说面板名。
  const JOIN_TOKEN_ENTRY_BY_PERSPECTIVE = {
    system: "先打开「项目管理」→「项目 Agent」→「注册项目节点」",
    org: "先打开「项目管理」→「项目 Agent」→「注册项目节点」；也可以在「组织管理」→「共享 Agent」统一管理节点"
  };
  const joinTokenWhere = JOIN_TOKEN_ENTRY_BY_PERSPECTIVE[perspectiveOf(currentAccount)];
  const nothingRanYetNotice = nothingRanYet
    ? `<div class="notice">这个项目还没有任何执行记录 —— 下面几张表是空的，这在刚装完时是正常的，`
      + `不是没取回来。要让它动起来：${joinTokenWhere
        ? `${joinTokenWhere}，点「签发一次性加入令牌」并在 agent 主机运行安装命令注册一台节点，`
        : "先让管理员签发加入令牌，并在 agent 主机运行安装命令注册一台节点（签发加入令牌这件事你这个账号做不了），"}`
      + `再到「任务组」页把工作项推进到就绪。节点接上之后，这一页会实时显示会话、派发与执行事件。</div>`
    : "";

  return [
    nothingRanYetNotice,
    orchestratorStalledNotice(),
    fleetOfflineNotice(),
    renderMonitorSummary({eventsShown, sessionsAll, dispatchesAll, lanesAll, nodes: monitorNodes, barriersInScope}),
    renderMonitorActionBoard({
      dispatchesAll,
      sessionsAll,
      nodes: monitorNodes,
      barriersInScope,
      stuckTopologies,
      downgradableTopologies,
      failingTests,
      waivableGates,
      openReviewPlans,
      openReviewBundles,
      openRuleSources,
      openUpgradeCandidates,
      blockingDefinitions
    }),
    renderMonitorRealtimeGuide({
      eventsShown,
      sessionsAll,
      dispatchesAll,
      commandsInScope,
      nodes: monitorNodes,
      barriersInScope
    }),
    renderTaskGroupMonitorMatrix(groups, {dispatchesAll, sessionsAll, barriersInScope}),
    canOrchestrate ? panel("自治控制", `
      <div class="button-row">
        <button class="primary-button" data-action="orchestrator-run">运行自治循环</button>
        <button class="secondary-button" data-action="decide-model">模型决策</button>
      </div>
    `) : "",
    panel("实时事件流", `
      <div class="stack">
        <div class="button-row" role="group" aria-label="记录模式"><button class="${execHistoryMode ? "secondary-button" : "primary-button"}" data-exec-mode="live" aria-pressed="${!execHistoryMode}">实时记录</button>
          <button class="${execHistoryMode ? "primary-button" : "secondary-button"}" data-exec-mode="history" aria-pressed="${execHistoryMode}">历史记录</button></div>
        <div class="record-meta"><span>监听范围：</span><select data-select="exec-scope" aria-label="执行监听范围">${scopeOptions.map((option) => `<option value="${esc(option.value)}" ${option.value === scopeValue ? "selected" : ""}>${esc(option.label)}</option>`).join("")}</select></div>
        ${table([{label: "序号", c: "num"}, "事件", {label: "进度", c: "num"}, "状态", {label: "摘要", c: "text-clip"}, {label: "时间", c: "nowrap"}], eventRows, {moreText: moreText(eventsShown.length, 120, execEventsDropped)})}
        ${execHistoryMode ? `<div class="button-row"><button class="secondary-button" data-event-page="previous"${execHistoryStack.length ? "" : " disabled"}>上一页</button><span class="small muted">第 ${execHistoryStack.length + 1} 页</span><button class="secondary-button" data-event-page="next"${execHasMore ? "" : " disabled"}>下一页</button></div>` : ""}
      </div>
    `, {wide: true, headerSide: filterInput("按事件、摘要过滤…", "events")}),
    panel("可复用执行载体（Worker Lane）", table(["角色", "功能", "状态", {label: "复用代数", c: "num"}, "当前会话", {label: "更新时间", c: "nowrap"}], laneRows, {moreText: moreText(lanesAll.length, 20, "workerLanes")}), {wide: true, headerSide: filterInput("按角色、会话过滤…", "worker-lanes")}),
    panel("工作会话", table(["会话", "角色", "工作项", "放置方式", {label: "执行载体", c: "nowrap"}, "状态", "原因", "详情"], sessions, {moreText: moreText(sessionsAll.length, 20, "workSessions")}), {wide: true, headerSide: filterInput("按会话、工作项过滤…", "sessions")}),
    panel("智能体派发", stuckExitNotice(dispatchesAll, sessionsAll) + table(["派发", "工作项", "状态", {label: "进度", c: "num"}, {label: "最近动静", c: "nowrap"}, "原因", "详情"], dispatches, {moreText: moreText(dispatchesAll.length, 20, "agentDispatches")}), {wide: true, headerSide: filterInput("按派发、工作项过滤…", "dispatches")}),
    // 节点为什么拒/为什么失败，此前写进 command.ackResult 就再没人读过（全仓只有网关那一处写、
    // 零处读）—— 屏幕上只有一个「已拒绝」，人无处可查。它本来就随视图下发了，缺的只是这一列。
    panel("控制通道", table([{label: "序号", c: "num"}, "节点", "命令", "作用对象", "状态", "原因", {label: "更新时间", c: "nowrap"}], commands, {moreText: moreText(commandsInScope.length, 16, "agentControlCommands")}), {wide: true}),
    (() => {
      // 死信队列：命令重试超限时产生，非终态会一直挡住关闭门（no_active_dlq）。此前它连下发都没有、
      // 更没有处置入口 —— 一条死信就能让任务组永远关不掉。这里列出待处置的，给出丢弃/重放的出口。
      const DLQ_TERMINAL = new Set(["replayed", "discarded", "superseded"]);
      const dlqActive = (state.dlqEntries || []).filter((entry) => !DLQ_TERMINAL.has(entry.status) && (!managementGroupId || inScope(entry)));
      const dlqRows = dlqActive.map((entry) => row([
        `<span class="mono">${esc(entry.entryId)}</span>`,
        `<span class="mono">${esc(entry.commandId || entry.sourceObjectRef || "-")}</span>`,
        esc(taskGroupNameOf(entry.taskGroupId)),
        esc(entry.reason || "-"),
        badge(entry.status),
        {v: fmtTime(entry.updatedAt || entry.createdAt), c: "nowrap"},
        hasGroupPerm(entry.taskGroupId, "task_group:control") ? `
          <form class="form-grid" data-form="dlq-resolve" data-entry="${esc(entry.entryId)}">
            ${decisionSelect("resolution", [["discard", "丢弃（放弃这条失败命令）"], ["replay", "重放（判定可以放行）"]], "请选择处置…", {required: false})}
            <input name="justification" placeholder="处置理由（必填）">
            <button class="secondary-button" type="submit">处置</button>
          </form>` : noRightOnThisGroup(entry.taskGroupId, "任务组控制（处置死信）")
      ]));
      return panel("死信队列", dlqActive.length
        ? table(["条目", "命令", "作用对象", "原因", "状态", {label: "更新时间", c: "nowrap"}, "处置"], dlqRows)
        : `<div class="small muted">没有待处置的死信条目。命令重试超限时才会在这里出现，非终态会挡住任务组关闭。</div>`, {wide: true});
    })(),
    panel("agent 节点", table(["节点", "状态", "准入", {label: "最近心跳", c: "nowrap"}, "操作"], nodes), {wide: true, headerSide: filterInput("按节点过滤…", "runtime-nodes")}),
    panel("模型选择记录", table(["角色", "Agent 档案", "工作项", "实际模型", "状态", {label: "决策说明", c: "text-clip"}], decisions, {moreText: moreText(decisionsInScope.length, 10, "modelSelectionDecisions")})),
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
          ${waivableGates.filter((qg) => hasGroupPerm(qg.taskGroupId, "task_group:review")).map((qg) => `
            <form class="form-grid" data-form="quality-gate-waive" data-request="${esc(qg.gateId)}" style="margin-top:8px;">
              <div class="record-meta"><span class="mono">${esc(qg.gateId)}</span> · ${esc(t(qg.gateType) || qg.gateType || "-")} · ${esc(qg.workItemId || "-")} · ${badge(qg.status)}</div>
              <div class="form-row"><label>豁免理由（必填）</label><input name="justification" placeholder="例如：该门针对的能力不在本任务组范围内"></div>
              <button class="primary-button" type="submit">豁免此门</button>
            </form>`).join("")}
        </div>` : ""}
    `, {wide: true, headerSide: filterInput("按门禁类型、工作项过滤…", "quality-gates")}) : "",
    // 关闭门禁上每一个阻塞项都必须能在这里被人处理掉。后端有杠杆而界面上没有入口，
    // 等于这个杠杆不存在 —— 人只会看到一个红 chip，然后无从下手。
    (openReviewPlans.length || openRuleSources.length || blockingDefinitions.length || openReviewBundles.length || openUpgradeCandidates.length || stuckTopologies.length
      || downgradableTopologies.length) ? panel("阻塞项人工处置", `
      <div class="notice">下面这些阻塞只能由人来收尾：AI 要么不该有权决定（采纳规则、激活规范），要么已经无法推进（评审角色不再参与）。</div>
      ${outOfReachBlockerNotice()}
      ${canReviewGates && openReviewPlans.length ? `
        <div class="record" style="margin-top:8px;">
          <div class="record-title">评审计划（要求的评审角色到齐即自动闭合；到不齐时由你收尾）</div>
          ${openReviewPlans.filter((plan) => hasGroupPerm(plan.taskGroupId, "task_group:review")).map((plan) => `
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
          ${openRuleSources.filter((item) => hasGroupPerm(item.taskGroupId, "task_group:control")).map((item) => `
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
          ${openReviewBundles.filter((bundle) => hasGroupPerm(bundle.taskGroupId, "task_group:review")).map((bundle) => `
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
      ${canOrchestrate && downgradableTopologies.length ? `
        <div class="record" style="margin-top:8px;">
          <div class="record-title">资格检查没过的执行方案（这些阻塞项清不掉就启动不了；后端在这个阶段只接受【降级为串行】，不接受终止）</div>
          ${downgradableTopologies.map((topology) => `
            <form class="form-grid" data-form="topology-downgrade" data-request="${esc(topology.topologyId)}" style="margin-top:8px;">
              <div class="record-meta"><span class="mono">${esc(topology.topologyId)}</span> · ${esc(taskGroupNameOf(topology.taskGroupId))} · ${badge(topology.status)}
                · 工作项 <span class="mono">${esc(topology.workItemId || "-")}</span>
                ${topology.humanFinalization?.outcome === "confirmed" ? " · " + customBadge("已由人定稿", "blue") : ""}</div>
              <div class="small muted">卡在这几项：${(topology.blockers || [])
                .slice(0, 6).map((blocker) => esc(topologyBlockerText(blocker))).join("；")}</div>
              <div class="form-row"><label>降级理由（必填，会写进定稿记录）</label><input name="downgradeReason" placeholder="例如：这台机器上没有可用的隔离工作树，改为串行执行"></div>
              <button class="primary-button" type="submit">降级为串行执行</button>
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
    // 上面那一屏是"还要谁来收尾"，这一屏是"已经谁收的尾、为什么"。人写下的定稿理由此前落库之后
    // 没有任何读取点，而收尾之后对象又从待处置清单里消失 —— 于是这条链上唯一的人类判断不留痕迹。
    finalizations.length ? panel("最近的人工定稿", `
      <div class="notice">这些收尾只能由真人做。这里保留他们当时给出的理由 —— 后来的人要靠它判断能不能照做。</div>
      ${table(["对象", "任务组", "处置后状态", "定稿人", {label: "时间", c: "nowrap"}, "理由"],
        finalizations.map((item) => row([
          `${esc(item.kind)} <span class="mono">${esc(item.id || "-")}</span>`,
          esc(taskGroupNameOf(item.taskGroupId)),
          badge(item.status),
          esc(item.by ? accountName(item.by) : "-"),
          fmtTime(item.at),
          // 有的是人写的原话，有的是码（发现项的处置类别）—— 统一过 explainCoded：
          // 是码就译成人话，是原话就原样出来。
          {v: esc(item.why ? explainCoded(item.why) : "（当时没有填理由）"), c: "text-clip"}
        ])).join(""))}
    `, {wide: true}) : "",
    panel("关闭门禁", `
      ${table(["任务组", "状态", {label: "阻塞对象数", c: "num"}, {label: "计算时间", c: "nowrap"}, "操作"], barriers, {moreText: moreText(barriersInScope.length, 8, "closeBarriers")})}
      ${(state.closeBarriers || []).filter((barrier) => !barrier.satisfied && (barrier.blockingObjects || []).length).slice(0, 8).map((barrier) => `
        <div class="record" style="margin-top:8px;">
          <div class="record-title"><strong>${esc(taskGroupNameOf(barrier.taskGroupId))}</strong> 阻塞明细</div>
          <div class="chip-row">${(barrier.blockingObjects || []).map((obj) => customBadge(`${t(obj.objectType) || obj.objectType}${obj.gate ? `·${t(obj.gate) || obj.gate}` : ""}：${t(obj.status) || obj.status}`, "red")).join(" ")}</div>
          ${gatingArtifactRows(barrier)}
        </div>`).join("")}
    `, {wide: true})
  ].join("");
}

/* ---------------- 成员：项目设置 ---------------- */

// readOnly：无“项目授权管理”权限或项目已归档时，这几行只能看不能改。此前输入始终可编辑、删除按钮
// 始终启用（而同页的 rule 行、添加/保存按钮都按 readOnly 置灰了）—— read-only 的成员因此能就地改字段、
// 删行（本地暂存 formTouched），却存不下（保存按钮已禁用、后端也会拒 project_config_update），
// 是「按了看不到效果」的死动作。与 ruleRow 同规：输入加 readonly、删除按钮 readOnly 时干脆不渲染。
function cfgRepoRow(repo = {}, readOnly = false) {
  const ro = readOnly ? "readonly" : "";
  const disabled = readOnly ? "disabled" : "";
  const credential = repo.credential || {};
  const mode = repo.credentialMode || credential.mode || (repo.credentialSecretRef ? "api_key" : "none");
  const username = repo.username || credential.username || "";
  const password = repo.password || credential.password || "";
  const apiKey = repo.apiKey || credential.apiKey || repo.credentialSecretRef || "";
  const passwordPlaceholder = credential.passwordSet ? "已配置密码；留空保留原值" : "密码（账号密码模式）";
  const apiKeyPlaceholder = credential.apiKeySet ? "已配置 API Key；留空保留原值" : "API Key / Token";
  return `
    <div class="cfg-row cfg-row-repo" data-cfg-kind="repo">
      <input name="repoId" placeholder="仓库 ID" value="${esc(repo.id || "")}" ${ro}>
      <input name="repoUrl" placeholder="仓库地址（git@... / https://...）" value="${esc(repo.url || "")}" ${ro}>
      <input name="repoBranch" placeholder="默认分支" value="${esc(repo.defaultBranch || "main")}" ${ro}>
      <select name="repoCredentialMode" ${disabled}>
        <option value="none"${mode === "none" ? " selected" : ""}>无凭据 / 公共仓库</option>
        <option value="account_password"${mode === "account_password" ? " selected" : ""}>账号密码</option>
        <option value="api_key"${mode === "api_key" ? " selected" : ""}>API Key / Token</option>
      </select>
      <input name="repoUsername" placeholder="账号（账号密码模式）" value="${esc(username)}" ${ro}>
      <input name="repoPassword" type="password" placeholder="${esc(passwordPlaceholder)}" value="${esc(password)}" ${ro} autocomplete="new-password">
      <input name="repoApiKey" type="password" placeholder="${esc(apiKeyPlaceholder)}" value="${esc(apiKey)}" ${ro} autocomplete="new-password">
      ${readOnly ? "" : `<button type="button" class="danger-button" data-action="cfg-del">删除</button>`}
      ${!readOnly && repo.id ? `<button type="button" class="secondary-button" data-action="repo-test-connection" data-repo="${esc(repo.id)}" title="验证已保存的仓库地址和读取权限；推送权限请单独验证">测试连接</button>
        <button type="button" class="secondary-button" data-action="repo-test-connection" data-repo="${esc(repo.id)}" data-verify-write="true" title="真实创建并清理临时测试分支，验证推送权限">验证推送</button>` : ""}
    </div>
  `;
}

// 「测试连接」的结果原因 → 人话。键必须与 lib/git-connection-test.mjs 的 REPOSITORY_CONNECTION_REASONS 一一对上
// （console 门核）；认不出的原因不许当成功，原样带出来。
const REPO_CONNECTION_REASON_TEXT = {
  repository_auth_failed: "远端拒绝了这份凭证（账号密码或 API Key 不对、已过期，或没有这个仓库的权限）",
  repository_not_found: "远端说没有这个仓库（地址写错、仓库被删或改名，或这份凭证看不到它）",
  repository_unreachable: "够不着远端（域名解析不了、端口不通或网络被拦）",
  repository_connection_timeout: "远端在限定时间内没有应答（网络太慢或远端挂起）",
  repository_connection_failed: "git 没能完成握手，原因没归到已知类别 —— 看后面 git 的原话",
  credential_missing: "选了需要凭证的模式，但从没填过密钥（密码 / API Key 留空只是保留原值，从没填过就是空）",
  repository_credential_unreadable: "已保存的凭证解不开（控制面换过凭证密钥）—— 重新填一次账号密码或 API Key 再保存"
};

function repositoryWriteResultHtml(repoId, result) {
  const step = (value) => value?.ok === true ? customBadge("通过", "green")
    : value?.ok === false ? customBadge("未通过", "red") : customBadge("未执行", "gray");
  const write = result?.write;
  const passed = result?.ok === true && result?.read?.ok === true && write?.push?.ok === true && write?.cleanup?.ok === true;
  const uncertainCleanup = write?.probeRef && write?.cleanup?.ok !== true && write?.cleanup?.status !== "not_needed" && (write?.push || write?.cleanup?.uncertain);
  const why = REPO_CONNECTION_REASON_TEXT[result?.reason] || `原因未归类（${result?.reason || "服务端没给原因"}）`;
  return `<div class="stack"><div><strong>${esc(repoId)}</strong> ${passed ? customBadge("读写验证通过", "green") : customBadge("读写验证未通过", "red")}</div>
    ${table(["检测项目", "结果"], [
      row(["读取仓库", step(result?.read)]),
      row(["推送预检", step(write?.dryRun)]),
      row(["实际推送临时分支", step(write?.push)]),
      row(["清理临时分支", uncertainCleanup ? customBadge("需要核对", "red") : write?.cleanup?.status === "not_needed" ? customBadge("无需清理", "gray") : step(write?.cleanup)])
    ].join(""))}
    ${passed ? "" : `<div class="notice warn-notice">${esc(why)}${result?.detail ? `：${esc(result.detail)}` : ""}</div>`}
    ${uncertainCleanup ? `<div class="notice warn-notice">临时分支尚未确认清理，请仓库管理员核对。分支：<code>${esc(write.probeRef)}</code>${write.commit ? `；测试提交：<code>${esc(write.commit)}</code>` : ""}。</div>` : ""}
    <div class="small muted">本次验证仅针对临时测试分支。目标分支的保护规则、合并审批和服务端钩子仍可能拒绝实际任务推送。</div></div>`;
}

function cfgBaselineRow(item = {}, readOnly = false) {
  const ro = readOnly ? "readonly" : "";
  return `
    <div class="cfg-row" data-cfg-kind="baseline">
      <input name="blName" placeholder="名称" value="${esc(item.name || "")}" ${ro}>
      <input name="blLocator" placeholder="定位（如 git:docs/baseline/...）" value="${esc(item.locator || "")}" ${ro}>
      <input name="blDigest" placeholder="内容摘要（可选）" value="${esc(item.digest || "")}" ${ro}>
      ${readOnly ? "" : `<button type="button" class="danger-button" data-action="cfg-del">删除</button>`}
    </div>
  `;
}

function cfgRoleRow(role = {}, readOnly = false) {
  const ro = readOnly ? "readonly" : "";
  return `
    <div class="cfg-row" data-cfg-kind="role">
      <input name="roleId" placeholder="角色 ID（只认已登记的执行角色，如 reviewer）" list="config-role-options" value="${esc(role.roleId || "")}" ${ro}>
      <input name="roleSkillRef" placeholder="角色规则引用（可选）" value="${esc(role.roleSkillRef || "")}" ${ro}>
      ${readOnly ? "" : `<button type="button" class="danger-button" data-action="cfg-del">删除</button>`}
    </div>
  `;
}

function splitHumanList(value) {
  return String(value || "").split(/[,\n，、]/u).map((item) => item.trim()).filter(Boolean);
}

function roleSkillChoiceList(id = "role-skill-options") {
  const skills = state.roleSkillIndex || [];
  if (!skills.length) return `<datalist id="${esc(id)}"></datalist>`;
  return `<datalist id="${esc(id)}">${skills.slice(0, 500).map((skill) => `
    <option value="${esc(skill.roleSkillId)}">${esc([skill.name, skill.category, skill.sourceId].filter(Boolean).join(" · "))}</option>
  `).join("")}</datalist>`;
}

function roleSkillOverlaySummary(overlay) {
  const patch = overlay.patch || {};
  return [
    (patch.allowedCapabilityAdds || []).length ? `放开 ${(patch.allowedCapabilityAdds || []).join("、")}` : "",
    (patch.forbiddenCapabilityAdds || []).length ? `禁掉 ${(patch.forbiddenCapabilityAdds || []).join("、")}` : "",
    patch.instructionRef && patch.instructionRef !== "overlay:empty" ? `附加说明 ${patch.instructionRef}` : "",
    patch.modelRequirementPatchRef && patch.modelRequirementPatchRef !== "overlay:model:none" ? `模型要求 ${patch.modelRequirementPatchRef}` : ""
  ].filter(Boolean).join("；") || "保留默认补丁";
}

function projectRoleSkillOverlays(projectId) {
  return (state.roleSkillOverlays || []).filter((overlay) =>
    overlay.status === "active" && overlay.projectId === projectId);
}

function taskGroupRoleSkillOverlays(taskGroupId, projectId) {
  return (state.roleSkillOverlays || []).filter((overlay) =>
    overlay.status === "active"
    && (overlay.taskGroupId === taskGroupId || (!overlay.taskGroupId && overlay.projectId === projectId)));
}

function roleSkillOverlayTable(overlays, {showScope = false} = {}) {
  return table([
    "角色 Skill",
    ...(showScope ? ["作用范围"] : []),
    "定制内容",
    {label: "创建时间", c: "nowrap"}
  ], overlays.slice(0, 12).map((overlay) => row([
    `<span class="mono">${esc(overlay.roleSkillRef || "-")}</span>`,
    ...(showScope ? [esc(overlay.taskGroupId ? `任务组 ${taskGroupNameOf(overlay.taskGroupId)}` : "项目级继承")] : []),
    {v: esc(roleSkillOverlaySummary(overlay)), c: "text-clip"},
    {v: fmtTime(overlay.createdAt), c: "nowrap"}
  ])).join(""), {emptyText: "暂无生效中的角色 Skill 定制。", moreText: moreText(overlays.length, 12, "roleSkillOverlays")});
}

function roleSkillOverlayForm({scope, projectId, taskGroupId, readOnly = false}) {
  // 只读身份此前照样渲染整张表单（六个禁用输入 + 禁用按钮）：按不动的表单不是"只读"，是噪声。
  // 已生效的定制在上表；这里只说清为什么不能建、找谁建。
  if (readOnly) {
    return `<div class="small muted">当前账号没有${scope === "task_group" ? "「任务组控制」" : "「项目更新」"}权限，不能创建角色 Skill 定制 —— 已生效的定制见上表；要加定制，找有权限的人操作。</div>`;
  }
  const disabled = "";
  const formAttrs = [
    `data-form="role-skill-overlay"`,
    `data-scope="${esc(scope)}"`,
    `data-project="${esc(projectId || "")}"`,
    taskGroupId ? `data-task="${esc(taskGroupId)}"` : ""
  ].filter(Boolean).join(" ");
  return `
    <form class="form-grid" ${formAttrs}>
      ${roleSkillChoiceList(scope === "task_group" ? "tg-role-skill-options" : "project-role-skill-options")}
      <div class="form-row"><label>选择要定制的角色 Skill</label>
        <input name="roleSkillRef" list="${scope === "task_group" ? "tg-role-skill-options" : "project-role-skill-options"}" placeholder="输入或选择 roleSkillId" ${disabled}>
      </div>
      <div class="form-grid two">
        <div class="form-row"><label>追加允许的能力</label><input name="allowedCapabilityAdds" placeholder="例如 repo_write,playwright_check" ${disabled}></div>
        <div class="form-row"><label>追加禁止的能力</label><input name="forbiddenCapabilityAdds" placeholder="例如 schema_change,public_api_change" ${disabled}></div>
      </div>
      <div class="form-grid two">
        <div class="form-row"><label>附加说明引用</label><input name="instructionRef" placeholder="overlay:empty 或 git:docs/..." value="overlay:empty" ${disabled}></div>
        <div class="form-row"><label>模型要求补丁引用</label><input name="modelRequirementPatchRef" placeholder="overlay:model:none 或 git:docs/..." value="overlay:model:none" ${disabled}></div>
      </div>
      <div class="form-row"><label>决策记录引用</label><input name="decisionRecordRef" placeholder="可选；例如 decision:task-special-role" ${disabled}></div>
      <button class="primary-button" type="submit" ${disabled}>创建角色 Skill 定制</button>
    </form>
  `;
}

function liveJoinTokenCount(projectId = "") {
  return (state.agentJoinTokens || []).filter((token) =>
    (!projectId || token.projectId === projectId)
    && token.status === "issued"
    && (!token.expiresAt || new Date(token.expiresAt).getTime() > serverNow())).length;
}

function renderProjectSettingsSummary(project, repos, baselineData, defaultRoles, resolved, rulesLoaded) {
  const systemRuleCount = rulesLoaded ? (resolved.systemRules || []).length : "—";
  const businessRuleCount = rulesLoaded ? (resolved.businessRules || []).length : "—";
  const roleOverlayCount = projectRoleSkillOverlays(project.id).length;
  const archivedText = project.status === "archived"
    ? "项目已归档，设置只读"
    : "项目设置影响后续派发和产出落地；Agent 接入在独立页面管理";
  return panel("项目设置总览", `
    <div class="metric-grid">
      ${summaryMetric("仓库", repos.length, "代码与文档产出的 Git 落点")}
      ${summaryMetric("基线", baselineData.length, "agent 可引用的现状材料")}
      ${summaryMetric("默认角色", defaultRoles.length, "任务组未指定时的角色回退")}
      ${summaryMetric("待用加入令牌", liveJoinTokenCount(project.id), "在「项目管理」→「项目 Agent」签发和使用")}
      ${summaryMetric("角色定制", roleOverlayCount, "项目/任务组级 Skill 覆盖")}
      ${summaryMetric("系统规则", systemRuleCount, "项目层生效的系统规则")}
      ${summaryMetric("业务规则", businessRuleCount, "项目层生效的业务规则")}
    </div>
    <div class="small muted">${esc(archivedText)}。</div>
  `, {wide: true});
}

function renderProjectSettingsActionBoard(project, repos, baselineData, defaultRoles, resolved, rulesLoaded) {
  const liveTokens = liveJoinTokenCount(project.id);
  const agentStats = projectAgentStats(project.id);
  const systemRuleCount = rulesLoaded ? (resolved.systemRules || []).length : "—";
  const businessRuleCount = rulesLoaded ? (resolved.businessRules || []).length : "—";
  const roleOverlayCount = projectRoleSkillOverlays(project.id).length;
  const ruleTone = rulesLoaded ? "blue" : "orange";
  return panel("项目设置操作看板", `
    <div class="module-grid">
      ${jumpModuleCard({
        title: "产出仓库",
        metric: `${repos.length}`,
        detail: repos.length ? "代码、文档和检查点的 Git 落点" : "未配置时产出无法落地",
        panelTitle: "项目基础配置",
        tone: repos.length ? "blue" : "red",
        action: "配置仓库"
      })}
      ${jumpModuleCard({
        title: "基线数据",
        metric: `${baselineData.length}`,
        detail: baselineData.length ? "agent 可引用的现状材料" : "可选；空着不阻塞执行",
        panelTitle: "项目基础配置",
        tone: baselineData.length ? "blue" : "gray",
        action: "管理基线"
      })}
      ${jumpModuleCard({
        title: "默认角色",
        metric: `${defaultRoles.length}`,
        detail: defaultRoles.length ? "任务组未指定时的角色回退" : "空着时回退到系统内置角色",
        panelTitle: "项目基础配置",
        tone: defaultRoles.length ? "blue" : "gray",
        action: "管理角色"
      })}
      ${projectModuleCard({
        pageId: "proj-agents",
        title: "智能体入网",
        metric: agentStats.aliveNodes.length ? `${agentStats.onlineNodes}/${agentStats.aliveNodes.length}` : `${liveTokens}`,
        detail: liveTokens ? "有待用加入令牌；注册脚本只在签发成功弹窗显示" : "需要新节点时进入「项目 Agent」→「注册项目节点」签发",
        tone: agentStats.onlineNodes ? "green" : liveTokens ? "blue" : "orange",
        action: "去接入页"
      })}
      ${jumpModuleCard({
        title: "角色 Skill 定制",
        metric: `${roleOverlayCount}`,
        detail: roleOverlayCount ? "已有项目或任务组级角色定制" : "特殊角色要求在这里配置",
        panelTitle: "角色 Skill 定制",
        tone: roleOverlayCount ? "orange" : "gray",
        action: "配置定制"
      })}
      ${jumpModuleCard({
        title: "系统规则",
        metric: `${systemRuleCount}`,
        detail: rulesLoaded ? "项目层可停用或改写默认系统规则" : "规则配置未就绪或本次读取失败",
        panelTitle: rulesLoaded ? "系统规则" : "规则配置",
        tone: ruleTone,
        action: "查看规则"
      })}
      ${jumpModuleCard({
        title: "业务规则",
        metric: `${businessRuleCount}`,
        detail: rulesLoaded ? "项目自己的业务约束，可被任务组覆盖" : "规则配置未就绪或本次读取失败",
        panelTitle: rulesLoaded ? "业务规则" : "规则配置",
        tone: ruleTone,
        action: "查看规则"
      })}
    </div>
    <div class="small muted">处理顺序：本页先确认产出仓库、默认角色与规则；agent 节点和注册脚本到「项目 Agent」页处理。看板只使用本页已加载数据，不额外请求接口。</div>
  `, {wide: true});
}

function renderProjectSettingsBoundaryGuide(project, repos, baselineData, defaultRoles, resolved, rulesLoaded) {
  const systemRuleCount = rulesLoaded ? (resolved.systemRules || []).length : "—";
  const businessRuleCount = rulesLoaded ? (resolved.businessRules || []).length : "—";
  const agentStats = projectAgentStats(project.id);
  const roleOverlayCount = projectRoleSkillOverlays(project.id).length;
  return panel("项目设置职责分区", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "产出与基线",
        metric: `${repos.length}/${baselineData.length}`,
        detail: "仓库、访问凭据和基线材料在“项目基础配置”维护",
        panelTitle: "项目基础配置",
        tone: repos.length ? "blue" : "red",
        action: "看配置"
      })}
      ${jumpModuleCard({
        title: "角色回退",
        metric: defaultRoles.length,
        detail: "任务组未指定角色时使用项目默认角色或系统内置角色",
        panelTitle: "项目基础配置",
        tone: defaultRoles.length ? "blue" : "gray",
        action: "看角色"
      })}
      ${jumpModuleCard({
        title: "Skill 定制",
        metric: roleOverlayCount,
        detail: "项目或任务组的特殊角色能力要求在“角色 Skill 定制”维护",
        panelTitle: "角色 Skill 定制",
        tone: roleOverlayCount ? "orange" : "gray",
        action: "看定制"
      })}
      ${jumpModuleCard({
        title: "执行规则",
        metric: `${systemRuleCount}/${businessRuleCount}`,
        detail: "系统规则管安全和流程边界，业务规则管项目约束",
        panelTitle: rulesLoaded ? "系统规则" : "规则配置",
        tone: rulesLoaded ? "blue" : "orange",
        action: "看规则"
      })}
      ${projectModuleCard({
        pageId: "proj-agents",
        title: "Agent 接入",
        metric: agentStats.aliveNodes.length ? `${agentStats.onlineNodes}/${agentStats.aliveNodes.length}` : "项目页",
        detail: "agent 节点、注册脚本和远程 MCP 确认不在本页处理，进入「项目管理」→「项目 Agent」",
        tone: agentStats.onlineNodes ? "green" : "orange",
        action: "去注册"
      })}
    </div>
    <div class="small muted">职责分区：项目设置只维护会影响派发和产出落地的配置；agent 节点、一次性加入令牌、安装脚本、远程 MCP 和 Skill 工作集生效确认统一进入「项目管理」→「项目 Agent」。</div>
  `, {wide: true});
}

function renderProjectSettingsLifecycleGuide(project, repos, baselineData, defaultRoles, resolved, rulesLoaded) {
  const agentStats = projectAgentStats(project.id);
  const roleOverlayCount = projectRoleSkillOverlays(project.id).length;
  const ruleCount = rulesLoaded
    ? (resolved.systemRules || []).length + (resolved.businessRules || []).length
    : "—";
  return panel("项目配置生效流程", `
    <div class="module-grid action-grid">
      ${jumpModuleCard({
        title: "1 产出落点",
        metric: `${repos.length}`,
        detail: "先配置 Git 仓库和项目级访问凭据，所有任务产出仍落到项目仓库",
        panelTitle: "项目基础配置",
        tone: repos.length ? "blue" : "red",
        action: "看仓库"
      })}
      ${jumpModuleCard({
        title: "2 角色与 Skill",
        metric: `${defaultRoles.length + roleOverlayCount}`,
        detail: "默认角色和角色 Skill 定制会进入后续派发；任务组特殊要求在详情覆盖",
        panelTitle: "角色 Skill 定制",
        tone: roleOverlayCount ? "orange" : "blue",
        action: "看定制"
      })}
      ${jumpModuleCard({
        title: "3 规则生效",
        metric: `${ruleCount}`,
        detail: rulesLoaded
          ? "系统规则守执行边界，业务规则守项目约束，任务组可继续覆盖"
          : "规则配置未加载，先不要提交覆盖",
        panelTitle: rulesLoaded ? "系统规则" : "规则配置",
        tone: rulesLoaded ? "blue" : "orange",
        action: "看规则"
      })}
      ${projectModuleCard({
        pageId: "tg",
        title: "4 创建任务组",
        metric: "任务组",
        detail: "配置不会替你创建任务组；新任务组会引用项目配置并继续按组设语言和角色",
        tone: "blue",
        action: "去任务组"
      })}
      ${projectModuleCard({
        pageId: "proj-agents",
        title: "5 Agent 执行",
        metric: agentStats.aliveNodes.length ? `${agentStats.onlineNodes}/${agentStats.aliveNodes.length}` : "注册",
        detail: "Agent 注册、远程 MCP 和 Skill 工作集生效确认在项目 Agent 页",
        tone: agentStats.onlineNodes ? "green" : "orange",
        action: "看智能体"
      })}
      ${projectModuleCard({
        pageId: "monitor",
        title: "6 监控回看",
        metric: "实时",
        detail: "配置调整后看后续派发、事件流、模型选择和仓库产出是否按预期变化",
        tone: "blue",
        action: "看监控"
      })}
    </div>
    <div class="small muted">项目配置只影响后续派发和产出落地；已经在执行的会话按其任务契约继续回送，必要时由任务组控制或人工指令调整。</div>
  `, {wide: true});
}

function renderProjectRuleGovernanceOverview(resolved) {
  const systemRules = resolved.systemRules || [];
  const businessRules = resolved.businessRules || [];
  const systemDefaultRules = systemRules.filter((rule) => String(rule.source || "").split("+").includes("default")).length;
  const systemProjectRules = systemRules.filter((rule) => ruleOwnedAtLayer(rule.source, "project")).length;
  const systemDisabledRules = systemRules.filter((rule) => rule.enabled === false || (rule.status && rule.status !== "active")).length;
  const systemRewrittenDefaults = systemRules.filter((rule) => {
    const source = String(rule.source || "").split("+");
    return source.includes("default") && source.includes("project");
  }).length;
  return panel("规则治理概览", `
    <div class="module-grid action-grid">
      ${summaryMetric("系统规则", systemRules.length, "执行安全、流程边界和 AI-native 纪律")}
      ${summaryMetric("业务规则", businessRules.length, "项目自己的业务约束，可由任务组继续覆盖")}
      ${summaryMetric("默认系统规则", systemDefaultRules, "来自系统内置规则集")}
      ${summaryMetric("项目级系统规则", systemProjectRules, "本项目新增、停用或改写的系统规则")}
      ${summaryMetric("已停用系统规则", systemDisabledRules, "停用后不进入后续派发")}
      ${summaryMetric("已改写默认规则", systemRewrittenDefaults, "默认规则在项目层已有内容覆盖")}
      ${jumpModuleCard({
        title: "系统规则明细",
        metric: systemRules.length,
        detail: "查看、停用或改写执行纪律和安全边界",
        panelTitle: "系统规则",
        tone: systemRules.length ? "blue" : "red",
        action: "看系统规则"
      })}
      ${jumpModuleCard({
        title: "业务规则明细",
        metric: businessRules.length,
        detail: "新增或维护项目自己的业务约束",
        panelTitle: "业务规则",
        tone: businessRules.length ? "blue" : "gray",
        action: "看业务规则"
      })}
    </div>
    <div class="small muted">规则治理顺序：系统规则先守执行安全、流程边界、证据和 AI-native 纪律；业务规则再表达项目业务约束；任务组特殊要求继续在任务组详情覆盖。这里是概览，完整正文和保存动作仍在下方规则明细里。</div>
  `, {wide: true});
}

function renderProjectSettings() {
  const project = currentProject();
  if (!project) return panel("项目设置", noVisibleProjectNotice(), {wide: true});
  const config = project.config || {};
  // projConfig===null means the config GET failed (effectiveProjectConfig always returns non-empty
  // systemRules defaults on success). Rendering empty editable rule editors here and saving would post
  // {systemRules:[]} and WIPE the project's rule overrides. Guard: show a notice instead of the editors.
  const rulesLoaded = projConfig !== null;
  const resolved = projConfig || {};
  const canEdit = hasPerm("project:update");
  // 归档是项目的终结态、且不可撤销：后端已经拒（project_archived），界面上这些写入口
  // 就不该还摆着 —— 摆着一个按不动的杠杆，人会以为是自己哪里填错了。
  const archived = project.status === "archived";
  const editDisabled = canEdit && !archived && rulesLoaded ? "" : "disabled";
  const archivedNotice = archived
    ? `<div class="notice warn-notice">这个项目已归档（终态，不可撤销）：配置只能看、不能改，`
      + "成员授权也发不进去了。要继续这条线，请另建一个项目。</div>"
    : "";
  const readOnlyNotice = canEdit ? "" : `<div class="notice warn-notice">当前账号无“项目配置修改”权限，项目配置为只读。</div>`;
  const agentStats = projectAgentStats(project.id);

  // 三块配置为空时，页面原先只剩一个"添加 X"按钮 —— 人分不清"这个项目没配"
  // 和"配置没加载出来"，也不知道空着会怎样。空要自己说话，并说清后果。
  // 配置没加载出来时，「还没有配置 X」是假话 —— 那一刻我们并不知道有没有。
  const cfgEmpty = (list, text) => (Array.isArray(list) && list.length)
    ? ""
    : `<div class="small muted">${esc(rulesLoaded ? text : projConfigUnavailableText())}</div>`;

  // 这三块要读【config 接口算出来的那份】，不是状态里的原始 project.config。
  // 差别是真实的：仓库登记有两处落点，服务端的 effectiveProjectConfig 已经把它们并成一份
  //（projectRepositories：先看 config.repositories，空了退回顶层 project.repositories），
  // 而这一页原先直接读原始状态 —— 于是种子项目上显示「还没有配置仓库：产出会卡在没有产出目标」，
  // 同一份状态里产出【已经推上去了】。服务端那处的注释写的就是这个缺陷，修的却只有服务端一侧：
  // 界面读的字段必须由它取的那个接口下发，否则修好的口径根本到不了屏幕上。
  const cfgSource = rulesLoaded ? resolved : config;
  const repos = Array.isArray(cfgSource.repositories) ? cfgSource.repositories : [];
  const baselineData = Array.isArray(cfgSource.baselineData) ? cfgSource.baselineData : [];
  const defaultRoles = Array.isArray(cfgSource.defaultRoles) ? cfgSource.defaultRoles : [];

  return [
    renderProjectSettingsSummary(project, repos, baselineData, defaultRoles, resolved, rulesLoaded),
    renderProjectSettingsActionBoard(project, repos, baselineData, defaultRoles, resolved, rulesLoaded),
    renderProjectSettingsBoundaryGuide(project, repos, baselineData, defaultRoles, resolved, rulesLoaded),
    renderProjectSettingsLifecycleGuide(project, repos, baselineData, defaultRoles, resolved, rulesLoaded),
    panel("项目基础配置", `
      <div class="notice">当前项目：${esc(project.name || project.id)}。这里配置 agent 产出的仓库落点、可引用基线和任务组默认角色。</div>
      ${archivedNotice}
      ${readOnlyNotice}
      <form class="form-grid" data-form="project-config" data-project="${esc(project.id)}" data-config-fields="repositories" data-config-version="${esc(projConfigVersion || "")}">
        <div class="form-row"><label>仓库与访问凭据（按项目保存，不使用全局环境变量）</label>
          <div class="cfg-rows" data-cfg-list="proj-repos">${repos.map((repo) => cfgRepoRow(repo, Boolean(editDisabled))).join("")}${cfgEmpty(repos, "还没有配置仓库：执行方没有可提交的目标，产出会卡在「没有产出目标」而落不了地。点下面的「添加仓库」配置仓库地址，并按需要选择账号密码或 API Key。")}</div>

          <div class="button-row"><button type="button" class="secondary-button" data-action="cfg-add" data-kind="repo" data-target="proj-repos" ${editDisabled}>添加仓库</button></div>
        </div>
        <button class="primary-button" type="submit" ${editDisabled}>保存项目配置</button>
      </form>
    `, {wide: true}),
    panel("基线资料", `
      <form class="form-grid" data-form="project-config" data-project="${esc(project.id)}" data-config-fields="baselineData" data-config-version="${esc(projConfigVersion || "")}">
        <div class="form-row"><label>基线数据</label>
          <div class="cfg-rows" data-cfg-list="proj-baseline">${baselineData.map((item) => cfgBaselineRow(item, Boolean(editDisabled))).join("")}${cfgEmpty(baselineData, "还没有基线数据：这一项是可选的，空着不影响执行，只是 agent 少一份可对照的现状材料。")}</div>
          <div class="button-row"><button type="button" class="secondary-button" data-action="cfg-add" data-kind="baseline" data-target="proj-baseline" ${editDisabled}>添加基线</button></div>
        </div>
        <button class="primary-button" type="submit" ${editDisabled}>保存项目配置</button>
      </form>
    `, {wide: true}),
    panel("项目默认角色", `
      <form class="form-grid" data-form="project-config" data-project="${esc(project.id)}" data-config-fields="defaultRoles" data-config-version="${esc(projConfigVersion || "")}">
        <div class="form-row"><label>默认角色</label>
          <datalist id="config-role-options">${WORK_ITEM_OWNER_ROLE_CHOICES.map((roleId) => `<option value="${esc(roleId)}">${esc(t(roleId))}</option>`).join("")}</datalist>
          <div class="cfg-rows" data-cfg-list="proj-roles">${defaultRoles.map((role) => cfgRoleRow(role, Boolean(editDisabled))).join("")}${cfgEmpty(defaultRoles, "还没有项目默认角色：任务组会各自指定角色，指定不到时回退到系统内置角色。")}</div>
          <div class="button-row"><button type="button" class="secondary-button" data-action="cfg-add" data-kind="role" data-target="proj-roles" ${editDisabled}>添加角色</button></div>
        </div>
        <button class="primary-button" type="submit" ${editDisabled}>保存项目配置</button>
      </form>
    `, {wide: true}),
    panel("项目 Agent", `
      <div class="module-grid action-grid">
        ${projectModuleCard({
          pageId: "proj-agents",
          title: "进入智能体管理",
          metric: agentStats.aliveNodes.length ? `${agentStats.onlineNodes}/${agentStats.aliveNodes.length}` : `${agentStats.liveTokens}`,
          detail: "查看项目节点、签发加入令牌、复制注册脚本、下发节点控制",
          action: "打开项目 Agent",
          tone: agentStats.onlineNodes ? "green" : "orange"
        })}
      </div>
      <div class="small muted">这里不再承载注册表单，避免仓库/规则配置与 agent 节点管理混在一起。</div>
    `, {wide: true}),
    panel("角色 Skill 定制", `
      <div class="notice">项目级定制会影响本项目后续派发中匹配该角色 Skill 的 agent；任务组里的特殊要求请在对应任务组详情里创建。服务端会把生效 overlay 写进任务契约和下发给 agent 的 Skill 工作集。</div>
      ${roleSkillOverlayTable(projectRoleSkillOverlays(project.id), {showScope: true})}
      ${roleSkillOverlayForm({scope: "project", projectId: project.id, readOnly: !canEdit || archived})}
    `, {wide: true}),
    rulesLoaded ? renderProjectRuleGovernanceOverview(resolved) : "",
    !rulesLoaded
      ? panel("规则配置", projConfigStatus === "failed"
        ? `<div class="notice warn-notice">暂时无法读取项目规则配置（配置接口这一次没取到：${esc(projConfigError || "原因未记下")}），已隐藏规则编辑器以避免误保存清空规则。请点击右上角刷新重试。</div>`
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
      if (!resumedFromDraft && !restoreWorkspaceRoute()) page = defaultPageFor(perspectiveOf(currentAccount));
      sessionStorage.setItem("aimac.page", page);
      await loadPage();
      return;
    }
    if (kind === "change-password") {
      if (String(data.newPassword || "").length < 8) throw new Error("新密码至少 8 位");
      if (data.newPassword !== data.confirmPassword) throw new Error("两次输入的新密码不一致");
      await api("/api/auth/change-password", {method: "POST", body: JSON.stringify({currentPassword: data.currentPassword || undefined, newPassword: data.newPassword})});
      // 服务端改密即撤销该账号【全部】会话，含当前这一条（那是"我怀疑被盗号"时唯一的自救手段，
      // 不撤销就等于对攻击者毫无影响）。而这里原先说"下次登录可使用新密码" —— 人以为可以接着用，
      // 下一次点击才 401，弹出的还是"会话已过期，请重新登录"：一个刚成功的操作，
      // 紧接着一句像是出了故障的话，看起来就是个 bug。
      // 所以当场把本地会话也清掉、回到登录页，并说清这是安全设计而不是故障。
      // clearSession 会清掉 modalHtml，必须先清会话再开弹窗。
      clearSession();
      openModal("修改密码", `<div class="notice">密码已更新。为防止旧口令继续可用，
        这个账号的所有登录会话（包括当前这一台）都已失效 —— 请用新密码重新登录。</div>`);
      return;
    }
    if (kind === "org-create") {
      const result = await api("/api/orgs", {method: "POST", body: JSON.stringify({
        name: data.name,
        admin: {displayName: data.adminName, email: data.adminEmail},
        quotas: quotaBody(data)
      })});
      await loadPage();
      oneTimeTokenModal(`组织「${result.organization?.name || data.name}」创建成功`, result.adminAccount?.email || data.adminEmail, result.accountToken || "-", "请将令牌交给该组织的初始组织管理员，首次登录后建议立即设置密码。");
      return;
    }
    if (kind === "org-admin-replace") {
      if (!data.oldAdminDisposition) throw new Error("请选择旧管理员的处置方式");
      const oldAdmin = (state.accounts || []).find((account) => account.accountId === form.dataset.oldAdmin);
      const dispositionText = data.oldAdminDisposition === "suspend" ? "停用该账号" : "保留为普通成员";
      if (!(await confirmDialog({
        title: "确认更换初始组织管理员",
        message: `确认更换初始组织管理员？旧管理员“${oldAdmin?.displayName || "当前管理员"}”将立即失去组织管理权限，并${dispositionText}。`,
        sub: "旧管理员的组织管理权限和活动会话会立即失效；项目所有权和其它项目记录不会被暗中转移。新管理员的一次性令牌只显示一次。",
        danger: true,
        confirmText: "确认更换"
      }))) return;
      const result = await api(`/api/orgs/${encodeURIComponent(form.dataset.org)}/initial-admin/replace`, {
        method: "POST", body: JSON.stringify({displayName: data.displayName, email: data.email,
          oldAdminDisposition: data.oldAdminDisposition})
      });
      closeModal();
      await loadPage();
      oneTimeTokenModal("初始组织管理员已更换", result.adminAccount?.email || data.email, result.accountToken || "-",
        `旧管理员已${data.oldAdminDisposition === "suspend" ? "停用" : "保留为普通成员"}；请将一次性令牌通过受控通道交给新管理员。`);
      return;
    }
    if (kind === "org-quotas") {
      await api(`/api/orgs/${encodeURIComponent(form.dataset.org)}/quotas`, {method: "POST", body: JSON.stringify({
        quotas: quotaBody(data)
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
      const member = (orgMembers || []).find((account) => account.accountId === form.dataset.account);
      if (!member) throw new Error("成员信息已变化，请刷新后重试");
      const editablePermissions = new Set(MEMBER_PERMISSION_OPTIONS.map(([permission]) => permission));
      const permissions = [...new Set([
        ...(member.permissions || []).filter((permission) => !editablePermissions.has(permission)),
        ...[...form.querySelectorAll("input[name='perm']:checked")].map((input) => input.value)
      ])];
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
      const created = await api("/api/projects", {method: "POST", body: JSON.stringify(data)});
      if (created.id) {
        closeModal();
        resetTaskWorkbench();
        currentProjectId = created.id;
        managementGroupId = "";
        selectedWork = null;
        page = "proj-overview";
        sessionStorage.setItem("aimac.projectId", currentProjectId);
        sessionStorage.setItem("aimac.page", page);
      }
      await loadPage();
      return;
    }
    if (kind === "org-project-create") {
      const created = await api("/api/org/projects", {method: "POST", body: JSON.stringify({name: data.name})});
      if (created.id) {
        resetTaskWorkbench();
        currentProjectId = created.id;
        managementGroupId = "";
        selectedWork = null;
        page = "proj-overview";
        sessionStorage.setItem("aimac.projectId", currentProjectId);
        sessionStorage.setItem("aimac.page", page);
      }
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
        ...(data.registrationScope ? {registrationScope: data.registrationScope, organizationId: data.organizationId} : {}),
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
    if (kind === "agent-profile-update") {
      await api(`/api/agents/${encodeURIComponent(form.dataset.agent)}/profile`, {method: "POST", body: JSON.stringify({
        name: data.name,
        role: data.role,
        model: data.model,
        trustScore: Number(data.trustScore),
        roleSkillRef: data.roleSkillRef || ""
      })});
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
        startPaused: data.startPaused === "true",
        roles: String(data.roles || "").split(/[\n,]/u).map((item) => item.trim()).filter(Boolean)
      };
      const result = await api("/api/task-groups", {method: "POST", body: JSON.stringify(payload)});
      expandedTaskGroupId = result.taskGroup?.id || expandedTaskGroupId;
      managementGroupId = expandedTaskGroupId;
      workspaces.select("tg", "list");
      workspaces.select("group-detail", "tasks");
      formTouched = false;
      await loadPage();
      return;
    }
    if (kind === "work-item-create") {
      const taskGroupId = data.taskGroupId;
      const payload = {
        title: data.title,
        ownerRole: data.ownerRole,
        requirements: String(data.requirements || "").split(/\n/u).map((item) => item.trim()).filter(Boolean),
        ...(data.pinnedModelId ? {pinnedModelId: data.pinnedModelId} : {})
      };
      const created = await api(`/api/task-groups/${encodeURIComponent(taskGroupId)}/work-items`, {method: "POST", body: JSON.stringify(payload)});
      expandedTaskGroupId = taskGroupId;
      managementGroupId = taskGroupId;
      workListGroupId = taskGroupId;
      selectedWork = created.workItem?.id ? {taskGroupId, workItemId: created.workItem.id} : null;
      page = "tasks";
      workspaces.select("tasks", "list");
      sessionStorage.setItem("aimac.page", page);
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
    if (kind === "role-skill-overlay") {
      const roleSkillRef = String(data.roleSkillRef || "").trim();
      if (!roleSkillRef) throw new Error("请选择要定制的角色 Skill");
      const allowedCapabilityAdds = splitHumanList(data.allowedCapabilityAdds);
      const forbiddenCapabilityAdds = splitHumanList(data.forbiddenCapabilityAdds);
      const instructionRef = String(data.instructionRef || "").trim() || "overlay:empty";
      const modelRequirementPatchRef = String(data.modelRequirementPatchRef || "").trim() || "overlay:model:none";
      if (!allowedCapabilityAdds.length && !forbiddenCapabilityAdds.length
        && instructionRef === "overlay:empty" && modelRequirementPatchRef === "overlay:model:none") {
        throw new Error("请至少填写一项定制内容：允许能力、禁止能力、附加说明引用或模型要求补丁引用");
      }
      await api("/api/role-skill-overlays", {method: "POST", body: JSON.stringify({
        scope: form.dataset.scope || "project",
        projectId: form.dataset.project || currentProjectId,
        ...(form.dataset.scope === "task_group" ? {taskGroupId: form.dataset.task} : {}),
        roleSkillRef,
        decisionRecordRef: String(data.decisionRecordRef || "").trim() || undefined,
        patch: {allowedCapabilityAdds, forbiddenCapabilityAdds, instructionRef, modelRequirementPatchRef}
      })});
      formTouched = false;
      await loadPage();
      toast.success("已创建角色 Skill 定制，后续派发会使用新的生效配置");
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
        credentialMode: rowEl.querySelector("select[name='repoCredentialMode']")?.value || "none",
        credential: {
          mode: rowEl.querySelector("select[name='repoCredentialMode']")?.value || "none",
          username: rowEl.querySelector("input[name='repoUsername']")?.value?.trim() || "",
          password: rowEl.querySelector("input[name='repoPassword']")?.value || "",
          apiKey: rowEl.querySelector("input[name='repoApiKey']")?.value || ""
        }
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
      const values = {repositories, baselineData, defaultRoles};
      const fields = form.dataset.configFields ? form.dataset.configFields.split(",") : Object.keys(values);
      const payload = Object.fromEntries(fields.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]));
      payload.expectedConfigVersion = form.dataset.configVersion || projConfigVersion;
      await api(`/api/projects/${encodeURIComponent(form.dataset.project)}/config`, {method: "POST", body: JSON.stringify(payload)});
      formTouched = false;
      await loadPage();
      return;
    }
    if (kind === "project-rules") {
      const fragments = assertRuleFragmentLengths(collectRuleFragments(form, "project"));
      const payload = form.dataset.category === "system" ? {systemRules: fragments} : {businessRules: fragments};
      payload.expectedConfigVersion = form.dataset.configVersion || projConfigVersion;
      await api(`/api/projects/${encodeURIComponent(form.dataset.project)}/config`, {method: "POST", body: JSON.stringify(payload)});
      formTouched = false;
      await loadPage();
      return;
    }
    if (kind === "tg-rules") {
      const fragments = assertRuleFragmentLengths(collectRuleFragments(form, "task_group"));
      const payload = form.dataset.category === "system" ? {systemRules: fragments} : {businessRules: fragments};
      payload.expectedConfigVersion = form.dataset.configVersion || tgDetail?.configVersion || null;
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
      // 认不出 action 就拒，不缺省成 finalize：定稿是整套人工闸门里最重、不可逆的一步，
      // 提交器丢了（程序化 requestSubmit、桩、旧浏览器）时把它当缺省，等于替人做了最重的决定。
      const action = ["revise", "finalize", "reject"].find((value) => value === data.action);
      if (!action) throw new Error("请用下方的「提交修改意见」「选择定稿」或「打回返工」按钮提交 —— 系统不会替你选一个");
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
      // 缺省 reopen 是替人做的决定：决策处置必须自己选重开还是放弃。
      if (data.directiveType === "resolve_decision" && !data.resolution) throw new Error("决策处置必须选择处置方式（重开 / 放弃）—— 系统不会替你选一个");
      const targetableDirective = ["adjust_priority", "add_requirement", "resolve_decision", "free_text"].includes(data.directiveType);
      await api("/api/human-directives", {method: "POST", body: JSON.stringify({
        projectId: currentProjectId,
        taskGroupId: directiveTaskGroupId,
        directiveType: data.directiveType,
        instruction: data.instruction || "",
        ...(targetableDirective && String(data.workItemId || "").trim() ? {workItemId: data.workItemId.trim()} : {}),
        ...(data.directiveType === "resolve_decision" ? {resolution: data.resolution} : {}),
        ...(data.directiveType === "adjust_priority" && data.priorityClass ? {priorityClass: data.priorityClass} : {})
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
    if (kind === "dlq-resolve") {
      if (!data.resolution) throw new Error("处置死信必须选择「丢弃」或「重放」—— 系统不会替你选一个");
      if (!String(data.justification || "").trim()) throw new Error("处置死信必须写明理由（事后唯一的处置依据）");
      await api(`/api/dlq-entries/${encodeURIComponent(form.dataset.entry)}/resolve`,
        {method: "POST", body: JSON.stringify({resolution: data.resolution, justification: data.justification})});
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
      // 缺省 closed＝「视为已完成评审」，是最重的收尾方式；空着就拒。
      if (!data.status) throw new Error("请选择收尾方式 —— 系统不会替你选一个");
      await api(`/api/review-plans/${encodeURIComponent(form.dataset.request)}/resolve`, {method: "POST", body: JSON.stringify({status: data.status, justification: data.justification})});
      await loadPage();
      return;
    }
    if (kind === "review-bundle-resolve") {
      if (!String(data.justification || "").trim()) throw new Error("收尾评审包必须写明理由");
      if (!data.status) throw new Error("请选择收尾方式 —— 系统不会替你选一个");
      await api(`/api/review-bundles/${encodeURIComponent(form.dataset.request)}/resolve`, {method: "POST", body: JSON.stringify({status: data.status, justification: data.justification})});
      await loadPage();
      return;
    }
    if (kind === "upgrade-candidate-resolve") {
      if (!String(data.justification || "").trim()) throw new Error("处置系统升级候选项必须写明理由");
      // 缺省 dismissed＝「不予处理」：下拉里有占位项，空着提交原先就替人判了一个。
      if (!data.status) throw new Error("请选择判定 —— 系统不会替你选一个（「不予处理」不是缺省）");
      await api(`/api/system-upgrade-candidates/${encodeURIComponent(form.dataset.request)}/resolve`, {method: "POST", body: JSON.stringify({status: data.status, justification: data.justification})});
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
      // 缺省 reference_only＝「仅作参考」：那是一条终态，空着提交原先就替人把来源判死了。
      if (!data.status) throw new Error("请选择判定 —— 系统不会替你选一个（「仅作参考」不是缺省）");
      await api(`/api/rule-source-resolutions/${encodeURIComponent(form.dataset.request)}/settle`, {method: "POST", body: JSON.stringify({status: data.status, justification: data.justification || ""})});
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
    if (kind === "topology-downgrade") {
      const downgradeReason = String(data.downgradeReason || "").trim();
      if (!downgradeReason) throw new Error("降级执行方案必须写明理由（它会写进定稿记录）");
      // 降级是终态转移：方案不再按并行跑，也不能再启动。已定稿的方案由 AI 发起会被拦下并挂一张
      // 新的确认单；这里是【人自己】在按，直接生效并改写定稿记录。
      if (!(await confirmDialog({
        title: "确认把该执行方案降级为串行",
        message: "降级之后这个方案进入终态，不能再按并行启动或合并；若它已由人定稿，定稿记录会被改写为本次降级。",
        sub: "这一步不可撤销。要按并行跑的话，得先把上面列出的阻塞项清掉，再重新提一份方案。",
        danger: true,
        confirmText: "确认降级"
      }))) return "__skip_success__";
      await api(`/api/execution-topologies/${encodeURIComponent(form.dataset.request)}/advance`,
        {method: "POST", body: JSON.stringify({action: "downgrade", downgradeReason})});
      await loadPage();
      return;
    }
    if (kind === "shared-definition-resolve") {
      if (!String(data.justification || "").trim()) throw new Error("处置共享定义契约必须写明理由");
      // 下拉里有「驳回」，缺省却是「激活为全局规范」—— 空着提交等于替人做了最重的判断。空着就拒。
      if (!data.status) throw new Error("请选择处置方式 —— 系统不会替你选一个");
      await api(`/api/shared-definition-contracts/${encodeURIComponent(form.dataset.request)}/resolve`, {method: "POST", body: JSON.stringify({status: data.status, justification: data.justification})});
      await loadPage();
      return;
    }
    if (kind === "finding-resolve") {
      const evidenceRefs = String(data.evidenceRefs || "").split(",").map((ref) => ref.trim()).filter(Boolean);
      // fixed_verified without evidence is downgraded server-side to fixed_unverified (still blocks) —
      // require evidence up front so the operator isn't misled by a success toast on a still-blocking
      // disposition. (not_applicable / scope_adjusted need no evidence.)
      // 两个下拉都是 required，但处理器原先仍给了缺省（resolved / fixed_verified）—— 那正是最重的判断；
      // 绕过 required 的任何提交（程序化、桩、浏览器差异）都会替人做了它。空着就拒。
      if (!data.dispositionClass || !data.status) throw new Error("请选择处置类别与处置状态 —— 系统不会替你选一个");
      if (data.dispositionClass === "fixed_verified" && !evidenceRefs.length) {
        throw new Error("“已修复并验证”需填写证据引用（evidence:...），否则将被降级为不可闭合并继续阻塞关闭门禁");
      }
      await api(`/api/findings/${encodeURIComponent(form.dataset.request)}/resolve`, {method: "POST", body: JSON.stringify({
        status: data.status,
        dispositionClass: data.dispositionClass,
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

document.addEventListener("aimac-rule-editor-opened", () => {
  ruleEditorDirtySnapshot = {formTouched, dirty: [...dirtyFormKinds], page, projectId: currentProjectId, accountId: currentAccount?.accountId};
});
document.addEventListener("aimac-rule-editor-closed", (event) => {
  const previous = ruleEditorDirtySnapshot;
  ruleEditorDirtySnapshot = null;
  if (event.detail?.apply === false && previous?.page === page && previous.projectId === currentProjectId && previous.accountId === currentAccount?.accountId) {
    formTouched = previous.formTouched;
    dirtyFormKinds.clear();
    previous.dirty.forEach((key) => dirtyFormKinds.add(key));
  }
  if (!authToken) render();
});

async function focusManagementGroup(groupId, nextPage = page, options = {}) {
  const listedGroup = taskPageData?.projectId === currentProjectId && taskPageData.workItems?.some((work) => work.taskGroupId === groupId);
  const detailedGroup = taskWorkDetail?.taskGroup?.projectId === currentProjectId && taskWorkDetail.taskGroup.id === groupId;
  if (groupId && !projectTaskGroups().some((group) => group.id === groupId) && !listedGroup && !detailedGroup) throw new Error("该任务组不在当前项目可见范围内");
  if (!allowedMenuItemsFor(perspectiveOf(currentAccount)).some((item) => item.id === nextPage)) return false;
  if (formTouched && !(await confirmDialog({title: "放弃未保存的修改", message: "切换任务组范围会丢失未保存的修改，确认继续？", danger: true, confirmText: "放弃并切换"}))) return false;
  requestRoutePush();
  managementGroupId = groupId || "";
  selectedWork = options.workItemId ? {taskGroupId: groupId, workItemId: options.workItemId} : null;
  workEventHistoryMode = false;
  workEventCursor = 0;
  workEventCursorStack = [];
  taskPageCursor = options.listState?.cursor || "";
  taskCursorStack = options.listState?.stack || [];
  expandedTaskGroupId = nextPage === "tg" ? managementGroupId : "";
  if (!expandedTaskGroupId || tgDetail?.taskGroupId !== expandedTaskGroupId) tgDetail = null;
  directiveTaskGroupId = managementGroupId;
  directiveWorkItemId = nextPage === "directives" ? String(options.workItemId || "") : "";
  page = nextPage;
  sessionStorage.setItem("aimac.page", page);
  if (page === "tg") workspaces.select(page, "list");
  if (page === "tasks") workspaces.select(page, "list");
  execScope = managementGroupId ? {type: "taskGroup", id: managementGroupId} : {type: "project", id: currentProjectId};
  execHistoryMode = false;
  execHistoryStack = [];
  execEvents = [];
  execCursor = 0;
  formTouched = false;
  dirtyFormKinds.clear();
  stopExecPolling();
  await loadPage();
  if (page === "monitor") { await loadExecEvents({reset: true}); startExecPolling(); render(); }
  return true;
}

async function navigateWorkspace(nextPage, nextSection, options = {}) {
  const closesObjectDetail = (nextPage === "sys-orgs" && selectedOrganizationId)
    || (nextPage === "org-members" && selectedOrgMemberId)
    || (nextPage === "proj-members" && selectedProjectMemberId)
    || (["org-agents", "proj-agents"].includes(nextPage) && selectedAgentProfileId);
  if (closesObjectDetail) {
    selectedOrganizationId = "";
    selectedOrgMemberId = "";
    selectedProjectMemberId = "";
    selectedAgentProfileId = "";
    memberGrantAccountId = "";
    if (nextPage === page && workspaces.current(page)?.id === nextSection) { render(); return true; }
  }
  if (nextPage === "group-detail" && page === "tg" && expandedTaskGroupId) {
    if (formTouched && !(await confirmDialog({title: "放弃未保存的修改", message: "任务组详情有未保存的修改，确认切换栏目？", danger: true, confirmText: "放弃并切换"}))) return false;
    if (!workspaces.select(nextPage, nextSection)) return false;
    requestRoutePush();
    formTouched = false;
    dirtyFormKinds.clear();
    render();
    return true;
  }
  if (!allowedMenuItemsFor(perspectiveOf(currentAccount)).some((item) => item.id === nextPage)) return false;
  if (nextPage === page && workspaces.current(page)?.id === nextSection) return true;
  if (formTouched && !(await confirmDialog({title: "放弃未保存的修改", message: "当前栏目有未保存的修改，确认切换？", danger: true, confirmText: "放弃并切换"}))) return false;
  if (!workspaces.select(nextPage, nextSection)) return false;
  requestRoutePush();
  if (options.createForGroup && projectTaskGroups().some((group) => group.id === options.createForGroup)) managementGroupId = options.createForGroup;
  const changedPage = nextPage !== page;
  page = nextPage;
  sessionStorage.setItem("aimac.page", page);
  formTouched = false;
  dirtyFormKinds.clear();
  if (changedPage || !lastLoadedAt || Date.now() - lastLoadedAt > 2000) {
    stopExecPolling();
    await loadPage();
  } else render();
  if (page === "monitor" && workspaces.current(page)?.id === "events") {
    await loadExecEvents({reset: execCursor === 0});
    startExecPolling();
    render();
  }
  window.scrollTo?.({top: 0});
  return true;
}

document.addEventListener("change", async (event) => {
  const target = event.target;
  try {
    if (target.dataset.workspaceSelect !== undefined) {
      const nextPage = target.dataset.workspacePage || page;
      const previous = workspaces.current(nextPage)?.id || "";
      if (!(await navigateWorkspace(nextPage, target.value))) target.value = previous;
      return;
    }
    if (target.dataset.memberGrantProject !== undefined) {
      memberGrantProjectId = target.value;
      render();
      return;
    }
    if (target.dataset.managementGroup !== undefined) {
      if (!(await focusManagementGroup(target.value))) target.value = managementGroupId;
      return;
    }
    if (target.dataset.workStatus !== undefined) {
      taskStatus = target.value;
      taskPageCursor = "";
      taskCursorStack = [];
      await loadTaskWorkbenchData();
      render();
      return;
    }
    if (target.name === "ruleEnabled") {
      const rowEl = target.closest(".rule-row");
      if (rowEl) rowEl.classList.toggle("disabled", !target.checked);
      formTouched = true;
      return;
    }
    if (target.name === "directiveType") {
      const form = target.closest("form[data-form]");
      form?.querySelectorAll("[data-directive-types]").forEach((field) => {
        field.hidden = !field.dataset.directiveTypes.split(" ").includes(target.value);
        field.querySelectorAll("input,select").forEach((input) => { input.disabled = field.hidden; });
      });
      formTouched = true;
      return;
    }
    if (target.id === "project-switcher") {
      if (target.value !== currentProjectId && formTouched && !(await confirmDialog({title: "放弃未保存的修改", message: "切换项目将丢失当前页面未保存的修改，确认切换？", danger: true, confirmText: "放弃并切换"}))) {
        target.value = currentProjectId;
        return;
      }
      requestRoutePush();
      formTouched = false;
      currentProjectId = target.value;
      resetTaskWorkbench();
      managementGroupId = "";
      selectedWork = null;
      selectedAgentProfileId = "";
      sessionStorage.setItem("aimac.projectId", currentProjectId);
      expandedTaskGroupId = "";
      tgDetail = null;
      directiveTaskGroupId = "";
      directiveWorkItemId = "";
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
      directiveWorkItemId = "";
      await loadPage();
      return;
    }
    if (target.dataset.select === "directive-work") {
      directiveWorkItemId = target.value;
      return;
    }
    if (target.name === "projectId" && target.closest(`[data-form="project-member"]`)) {
      // 项目换了，能授权的人也就换了：重渲染，让下拉里只剩这个项目所属组织的人。
      // （原先想在 DOM 里按组织显隐 option —— 那段既更啰嗦，勘察工具也派发不了 change 事件，
      //   等于写了一段没有判据的代码。走重渲染这条路，渲染函数本身就能被断言。）
      memberGrantProjectId = target.value;
      render();
      return;
    }
    if (target.dataset.select === "exec-scope") {
      const [type, ...rest] = String(target.value).split(":");
      execScope = {type, id: rest.join(":")};
      execHistoryStack = [];
      managementGroupId = type === "taskGroup" ? execScope.id : type === "project" ? "" : managementGroupId;
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
  if (event.target.dataset.workSearch !== undefined) {
    taskSearch = event.target.value;
    taskPageCursor = "";
    taskCursorStack = [];
    if (taskSearchTimer) clearTimeout(taskSearchTimer);
    taskSearchTimer = setTimeout(async () => {
      taskSearchTimer = null;
      if (page !== "tasks") return;
      try {
        await loadTaskWorkbenchData();
        const position = document.querySelector("[data-work-search]")?.selectionStart;
        render();
        const input = document.querySelector("[data-work-search]");
        input?.focus();
        input?.setSelectionRange?.(position, position);
      } catch (error) { showError(error); }
    }, 220);
    return;
  }
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
  const workEventMode = event.target.closest("[data-work-event-mode]");
  if (workEventMode) {
    workEventHistoryMode = workEventMode.dataset.workEventMode === "history";
    workEventCursor = 0;
    workEventCursorStack = [];
    try { await loadTaskWorkbenchData(); render(); } catch (error) { showError(error); }
    return;
  }
  const workEventPage = event.target.closest("[data-work-event-page]");
  if (workEventPage) {
    const previous = {cursor: workEventCursor, stack: [...workEventCursorStack]};
    if (workEventPage.dataset.workEventPage === "next" && taskWorkDetail?.hasMoreEvents) { workEventCursorStack.push(workEventCursor); workEventCursor = taskWorkDetail.nextEventCursor; }
    else if (workEventPage.dataset.workEventPage === "previous" && workEventCursorStack.length) workEventCursor = workEventCursorStack.pop();
    else return;
    try { await loadTaskWorkbenchData(); render(); } catch (error) { workEventCursor = previous.cursor; workEventCursorStack = previous.stack; showError(error); }
    return;
  }
  const eventModeButton = event.target.closest("[data-exec-mode]");
  if (eventModeButton) {
    execHistoryMode = eventModeButton.dataset.execMode === "history";
    execHistoryStack = [];
    execHistoryStart = 0;
    stopExecPolling();
    try { await loadExecEvents({reset: true}); startExecPolling(); render(); } catch (error) { showError(error); }
    return;
  }
  const eventPageButton = event.target.closest("[data-event-page]");
  if (eventPageButton) {
    const previous = {start: execHistoryStart, stack: [...execHistoryStack]};
    let next = 0;
    if (eventPageButton.dataset.eventPage === "next" && execHasMore) { execHistoryStack.push(execHistoryStart); next = execCursor; }
    else if (eventPageButton.dataset.eventPage === "previous" && execHistoryStack.length) next = execHistoryStack.pop();
    else return;
    try { await loadExecEvents({reset: true, afterSequence: next}); render(); } catch (error) { execHistoryStart = previous.start; execHistoryStack = previous.stack; showError(error); }
    return;
  }
  const taskPageButton = event.target.closest("[data-task-page]");
  if (taskPageButton) {
    if (taskPageLoading) return;
    const previous = {cursor: taskPageCursor, stack: [...taskCursorStack]};
    if (taskPageButton.dataset.taskPage === "next" && taskPageData?.nextCursor) {
      taskCursorStack.push(taskPageCursor);
      taskPageCursor = taskPageData.nextCursor;
    } else if (taskPageButton.dataset.taskPage === "previous" && taskCursorStack.length) taskPageCursor = taskCursorStack.pop();
    else return;
    try { await loadTaskWorkbenchData(); render(); } catch (error) { taskPageCursor = previous.cursor; taskCursorStack = previous.stack; showError(error); }
    return;
  }
  const runDisclosure = event.target.closest("[data-run-disclosure]");
  if (runDisclosure) {
    taskRunDisclosure[runDisclosure.dataset.runDisclosure] = !runDisclosure.closest("details").open;
    return;
  }
  const returnWorkButton = event.target.closest("[data-return-work]");
  if (returnWorkButton) {
    const origin = taskReturnContext;
    if (!origin || origin.accountId !== currentAccount?.accountId || origin.projectId !== currentProjectId || origin.taskGroupId !== managementGroupId) return;
    try {
      if (await focusManagementGroup(origin.taskGroupId, "tasks", {workItemId: origin.workItemId})) {
        workListGroupId = origin.listGroupId;
        workListState = origin.listState;
      }
    } catch (error) { showError(error); }
    return;
  }
  const focusGroupButton = event.target.closest("[data-focus-group]");
  if (focusGroupButton) {
    try { await focusManagementGroup(focusGroupButton.dataset.focusGroup, focusGroupButton.dataset.focusPage || page,
      {workItemId: focusGroupButton.dataset.focusWork || ""}); } catch (error) { showError(error); }
    return;
  }
  const workButton = event.target.closest("[data-open-work]");
  if (workButton) {
    try {
      workListGroupId = page === "tasks" ? managementGroupId : workButton.dataset.workGroup;
      workListState = {cursor: taskPageCursor, stack: [...taskCursorStack]};
      await focusManagementGroup(workButton.dataset.workGroup, "tasks", {workItemId: workButton.dataset.openWork});
    } catch (error) { showError(error); }
    return;
  }
  if (event.target.closest("[data-close-work]")) {
    try { await focusManagementGroup(workListGroupId, "tasks", {listState: workListState}); } catch (error) { showError(error); }
    return;
  }
  const workspaceButton = event.target.closest("[data-workspace]");
  if (workspaceButton) {
    await navigateWorkspace(workspaceButton.dataset.workspacePage || page, workspaceButton.dataset.workspace,
      {createForGroup: workspaceButton.dataset.createForGroup || ""});
    return;
  }
  const mask = event.target.closest("[data-modal-mask]");
  if (mask && event.target === mask) {
    await requestCloseModal();
    return;
  }
  const sectionButton = event.target.closest("[data-section-target]");
  if (sectionButton) {
    const nextPage = sectionButton.dataset.sectionTarget;
    if (nextPage !== page && formTouched && !(await confirmDialog({title: "放弃未保存的修改", message: "当前页面有未保存的修改，确认离开？", danger: true, confirmText: "放弃并离开"}))) return;
    requestRoutePush();
    page = nextPage;
    sessionStorage.setItem("aimac.page", page);
    lastError = "";
    formTouched = false;
    stopExecPolling();
    await loadPage();
    render();
    return;
  }
  const menuButton = event.target.closest("[data-menu]");
  if (menuButton) {
    if (menuButton.dataset.menu !== page && formTouched && !(await confirmDialog({title: "放弃未保存的修改", message: "当前页面有未保存的修改，确认离开？", danger: true, confirmText: "放弃并离开"}))) return;
    requestRoutePush();
    page = menuButton.dataset.menu;
    if (page === "sys-orgs") selectedOrganizationId = "";
    if (page === "org-members") { selectedOrgMemberId = ""; memberGrantAccountId = ""; }
    if (page === "proj-members") selectedProjectMemberId = "";
    if (["org-agents", "proj-agents"].includes(page)) selectedAgentProfileId = "";
    if (page === "tg") { expandedTaskGroupId = ""; managementGroupId = ""; tgDetail = null; }
    sessionStorage.setItem("aimac.page", page);
    lastError = "";
    formTouched = false;
    stopExecPolling();
    await loadPage();
    if (page === "monitor") {
      try {
        await loadExecEvents({reset: true});
      } catch (error) {
        // 空白的事件列表分不出"这段时间没有事件"和"根本没取到" —— 后者必须说出来。
        toast.error(`执行事件加载失败：${error?.message || error}`);
      }
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
  const jumpButton = event.target.closest("[data-jump-panel]");
  if (jumpButton) {
    const title = jumpButton.dataset.jumpPanel || "";
    const targetWorkspace = workspaces.owner(page, title);
    if (targetWorkspace && targetWorkspace !== workspaces.current(page)?.id) {
      if (formTouched && !(await confirmDialog({title: "放弃未保存的修改", message: "当前栏目有未保存的修改，确认切换？", danger: true, confirmText: "放弃并切换"}))) return;
      workspaces.select(page, targetWorkspace);
      formTouched = false;
      dirtyFormKinds.clear();
      render();
    }
    const targetHeader = [...document.querySelectorAll(".panel-header h2")]
      .find((header) => header.textContent.trim() === title);
    const targetPanel = targetHeader?.closest(".panel");
    const targetSection = targetPanel ? null : [...document.querySelectorAll("[data-section-title]")]
      .find((section) => {
        const sectionTitle = section.dataset.sectionTitle || "";
        return sectionTitle === title || (title && sectionTitle.startsWith(title));
      });
    const targetBlock = targetPanel || targetSection;
    if (targetBlock) {
      targetBlock.scrollIntoView({behavior: "smooth", block: "start"});
      return;
    }
    toast.info(`当前没有「${title}」明细，可能是这一类记录还没有产生`);
    return;
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
    if (action === "open-org-detail") {
      const orgId = target.dataset.org || "";
      if (!(organizations || []).some((org) => org.orgId === orgId)) return;
      requestRoutePush();
      selectedOrganizationId = orgId;
      render();
      window.scrollTo?.({top: 0});
      document.querySelector("[data-governance-object-heading]")?.focus();
      return;
    }
    if (action === "replace-initial-admin") {
      const org = (organizations || []).find((item) => item.orgId === target.dataset.org);
      if (!org) return;
      const oldAdmin = (state.accounts || []).find((account) => account.accountId === org.initialAdminAccountId);
      openModal(`更换初始组织管理员 · ${org.name}`, `
        <div class="stack">
          <div class="notice warn-notice">当前管理员：${esc(oldAdmin?.displayName || org.initialAdminAccountId || "记录缺失")}。更换后旧账号立即失去组织管理身份，不能自动恢复。</div>
          <form class="form-grid" data-form="org-admin-replace" data-org="${esc(org.orgId)}" data-old-admin="${esc(org.initialAdminAccountId || "")}">
            <div class="form-row-inline">
              <div class="form-row"><label>新管理员姓名</label><input name="displayName" required></div>
              <div class="form-row"><label>新管理员登录邮箱</label><input name="email" type="email" required></div>
            </div>
            <div class="form-row"><label>旧管理员处置</label>${decisionSelect("oldAdminDisposition", [
              ["suspend", "停用旧管理员账号"],
              ["keep_member", "保留为普通组织成员"]
            ], "必须明确选择…")}</div>
            <div class="notice">新管理员以待接受邀请状态创建。旧管理员的组织管理权限和活动会话会立即撤销；项目所有权保持原记录，不做隐式转移。</div>
            <button class="danger-button" type="submit">更换并签发新管理员令牌</button>
          </form>
        </div>
      `);
      return;
    }
    if (action === "close-org-detail") {
      const orgId = selectedOrganizationId;
      requestRoutePush();
      selectedOrganizationId = "";
      render();
      window.scrollTo?.({top: 0});
      document.querySelector(`[data-action="open-org-detail"][data-org="${CSS.escape(orgId)}"]`)?.focus();
      return;
    }
    if (action === "open-member-detail") {
      const accountId = target.dataset.account || "";
      if (!(orgMembers || []).some((account) => account.accountId === accountId)) return;
      requestRoutePush();
      selectedOrgMemberId = accountId;
      memberGrantAccountId = accountId;
      workspaces.select("org-members", "list");
      render();
      window.scrollTo?.({top: 0});
      document.querySelector("[data-governance-object-heading]")?.focus();
      return;
    }
    if (action === "close-member-detail") {
      const accountId = selectedOrgMemberId;
      requestRoutePush();
      selectedOrgMemberId = "";
      memberGrantAccountId = "";
      render();
      window.scrollTo?.({top: 0});
      document.querySelector(`[data-action="open-member-detail"][data-account="${CSS.escape(accountId)}"]`)?.focus();
      return;
    }
    if (action === "open-project-member-detail") {
      const accountId = target.dataset.account || "";
      if (!(currentProject()?.members || []).some((member) => member.accountId === accountId)) return;
      requestRoutePush();
      selectedProjectMemberId = accountId;
      workspaces.select("proj-members", "list");
      render();
      window.scrollTo?.({top: 0});
      document.querySelector("[data-governance-object-heading]")?.focus();
      return;
    }
    if (action === "close-project-member-detail") {
      const accountId = selectedProjectMemberId;
      requestRoutePush();
      selectedProjectMemberId = "";
      render();
      window.scrollTo?.({top: 0});
      document.querySelector(`[data-action="open-project-member-detail"][data-account="${CSS.escape(accountId)}"]`)?.focus();
      return;
    }
    if (action === "project-member-revoke") {
      const project = currentProject();
      const accountId = target.dataset.account || "";
      if (!project || project.id !== target.dataset.project) return;
      const memberName = accountName(accountId);
      if (!(await confirmDialog({
        title: "移出项目成员",
        message: `确认将“${memberName}”移出当前项目？`,
        sub: "该成员在当前项目的项目角色和全部任务组角色会同时撤销，默认项目指向也会清除；组织账号和其它项目权限不受影响。",
        danger: true,
        confirmText: "确认移出"
      }))) return;
      await api(`/api/projects/${encodeURIComponent(project.id)}/members/${encodeURIComponent(accountId)}/revoke`, {method: "POST", body: "{}"});
      selectedProjectMemberId = "";
      await loadPage();
      toast.success(`已将“${memberName}”移出当前项目`);
      return;
    }
    if (action === "open-node-tasks") {
      workspaces.select("monitor", "runs");
      await focusManagementGroup("", "monitor");
      return;
    }
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
    if (action === "monitor-scope") {
      const [type, ...rest] = String(target.dataset.scope || "").split(":");
      execScope = {type, id: rest.join(":")};
      execHistoryMode = false;
      execHistoryStack = [];
      managementGroupId = type === "taskGroup" ? execScope.id : "";
      requestRoutePush();
      workspaces.select("monitor", "events");
      execEvents = [];
      execCursor = 0;
      await loadExecEvents({reset: true});
      startExecPolling();
      render();
      return;
    }
    if (action === "logout") {
      try {
        await api("/api/auth/logout", {method: "POST", body: "{}"});
      } catch (error) {
        // 本机会话无论如何都要清掉（登出不能失败）。但服务端没作废成功时，那个令牌仍然有效到过期为止 ——
        // 只说"已登出"等于让人以为凭据已经失效。共用电脑上这句话的分量不一样。
        toast.error(`本机已登出，但服务端未确认作废这次会话：${error?.message || error}。若这是共用设备，请让管理员吊销该会话。`);
      }
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
          <div class="form-row"><label>${(currentAccount?.passwordSet ?? currentAccount?.authPolicy?.passwordSet) ? "当前密码" : "当前密码（你还没有设过密码，留空即可）"}</label><input name="currentPassword" type="password" autocomplete="current-password"${(currentAccount?.passwordSet ?? currentAccount?.authPolicy?.passwordSet) ? " required" : ""}></div>
          <div class="form-row"><label>新密码（至少 8 位）</label><input name="newPassword" type="password" required minlength="8" autocomplete="new-password"></div>
          <div class="form-row"><label>确认新密码</label><input name="confirmPassword" type="password" required minlength="8" autocomplete="new-password"></div>
          <button class="primary-button" type="submit">保存新密码</button>
        </form>
      `);
      return;
    }
    if (action === "open-project-page") {
      const targetProjectId = target.dataset.project || "";
      const targetPage = target.dataset.targetMenu || "proj-overview";
      const targetWorkspace = target.dataset.targetWorkspace;
      if ((targetProjectId && targetProjectId !== currentProjectId || targetPage !== page || targetWorkspace && targetWorkspace !== workspaces.current(page)?.id) && formTouched
        && !(await confirmDialog({title: "放弃未保存的修改", message: "未保存的修改将丢失，确认继续切换？", danger: true, confirmText: "放弃并切换"}))) return;
      requestRoutePush();
      if (targetProjectId) {
        if (targetProjectId !== currentProjectId) resetTaskWorkbench();
        currentProjectId = targetProjectId;
        sessionStorage.setItem("aimac.projectId", currentProjectId);
      }
      page = targetPage;
      if (targetWorkspace) workspaces.select(page, targetWorkspace);
      memberGrantAccountId = target.dataset.grantAccount || "";
      selectedProjectMemberId = targetPage === "proj-members" ? memberGrantAccountId : "";
      selectedAgentProfileId = "";
      if (targetPage === "proj-settings" && target.dataset.repoFocus !== undefined) workspaces.select(page, "repositories");
      sessionStorage.setItem("aimac.page", page);
      lastError = "";
      formTouched = false;
      stopExecPolling();
      await loadPage();
      if (targetPage === "proj-settings" && target.dataset.repoFocus !== undefined) {
        const repoRow = [...document.querySelectorAll("[data-cfg-kind='repo']")]
          .find((element) => element.querySelector("[name='repoId']")?.value === target.dataset.repoFocus);
        const configForm = document.querySelector("form[data-form='project-config']");
        const focusTarget = repoRow || configForm;
        focusTarget?.scrollIntoView({behavior: "smooth", block: "center"});
        const connectionButton = focusTarget?.querySelector("[data-action='repo-test-connection']");
        connectionButton?.focus({preventScroll: true});
      }
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
        badge(entry.result || "ok"),
        // 经 MCP 写入的行带 ref = mcp-audit.jsonl 里那一行的 callId。不显示的话，下面那句
        // 「摘要另存于 mcp-audit.jsonl」等于让人去一本没有索引的账里翻。REST 侧的行没有它，留空。
        entry.ref ? `<span class="mono">${esc(entry.ref)}</span>` : "-"
      ])).join("");
      const chain = archive.chain || {verified: 0, breaks: []};
      const chainNotice = chain.breaks?.length
        ? `<div class="notice warn-notice">哈希链校验发现 ${chain.breaks.length} 处不一致（${esc(chain.breaks.slice(0, 3).map((item) => `${item.id}:${item.reason}`).join("、"))}${chain.breaks.length > 3 ? `，仅列前 3 处，其余 ${chain.breaks.length - 3} 处在服务端归档文件里` : ""}）—— 归档可能被改动过。</div>`
        : `<div class="notice">已按哈希链逐条校验本屏 ${chain.verified} 条记录，未发现改动。</div>`;
      // 服务端一直下发着 windowTruncated/bytesScanned/fileBytes，而这里从来没渲染它们。
      // 归档只按【尾部一窗】读取与校验：文件长到几百 MB 时，这一屏说"未发现改动"，
      // 而窗口之外的几百万条一条都没查过 —— 人恰恰是为了查有没有被改动才打开这一屏的。
      const scannedMb = (bytes) => `${(Number(bytes || 0) / (1024 * 1024)).toFixed(1)}MB`;
      const windowNotice = archive.windowTruncated
        ? `<div class="notice warn-notice">只读了归档末尾 ${esc(scannedMb(archive.bytesScanned))}（全文 ${esc(scannedMb(archive.fileBytes))}）：
           上面的校验只覆盖这一窗，更早的记录本屏没有查过。要查更早的，请直接取归档文件核对。</div>`
        : "";
      // 归档写失败过 = 这一屏少了东西。接口一直下发着这个事实，而这里从来没渲染它 ——
      // 而这一屏正是人专门来查历史的地方，"看起来完整"比别处更害人。
      const faultNotice = archive.archiveFault
        ? `<div class="notice warn-notice">这份归档不完整：写入失败过，已有 ${esc(String(archive.archiveFault.lostEntries || 0))}
           条记录没能落盘（${esc(String(archive.archiveFault.error || "原因未记录"))}）—— 下面看到的不是全部。</div>`
        : "";
      openModal("审计归档", `
        <div class="stack">
          ${faultNotice}
          ${chainNotice}
          ${windowNotice}
          ${archive.windowTruncated ? `<div class="small muted">归档文件共 ${Math.round((archive.fileBytes || 0) / 1024)} KB，这里只读了末尾 ${Math.round((archive.bytesScanned || 0) / 1024)} KB —— 更早的记录需要直接查归档文件。</div>` : ""}
          ${table(["时间", "操作者", "动作", {label: "对象", c: "text-clip"}, "结果", {label: "MCP 归档行", c: "nowrap"}], rows, {emptyText: "归档里还没有记录"})}
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
    if (action === "open-create-project") {
      if (currentAccount?.accountType !== "user_account" || !(state.accountCapabilities?.canCreateProject ?? (currentAccount.permissions || []).includes("project:create"))) return;
      openModal("创建项目", `<form class="form-grid" data-form="project-create">
        <div class="form-row"><label>项目名称</label><input name="name" maxlength="200" required></div>
        <button class="primary-button" type="submit">创建项目</button></form>`);
      return;
    }
    if (action === "member-grants" || action === "clear-member-grants") {
      const member = action === "member-grants" ? (orgMembers || []).find((account) => account.accountId === target.dataset.account) : null;
      if (action === "member-grants" && !member) return;
      if (formTouched && !(await confirmDialog({title: "放弃未保存的修改", message: "切换授权对象会丢失未保存的修改，确认继续？", danger: true, confirmText: "放弃并切换"}))) return;
      memberGrantAccountId = member?.accountId || "";
      selectedOrgMemberId = "";
      formTouched = false;
      dirtyFormKinds.clear();
      workspaces.select("org-members", "grants");
      render();
      return;
    }
    if (action === "member-perms") {
      const member = (orgMembers || []).find((account) => account.accountId === target.dataset.account);
      if (!member) return;
      openModal(`账号能力 · ${member.displayName}`, `
        <form class="form-grid" data-form="member-perms" data-account="${esc(member.accountId)}">
          <div class="notice">本次仅调整创建项目能力，不改变已授予的项目和任务组角色。</div>
          ${permissionCheckboxes(member.permissions || [])}
          <button class="primary-button" type="submit">保存账号能力</button>
        </form>
      `);
      return;
    }
    if (action === "member-status") {
      const status = target.dataset.status;
      // 成员列表里也有你自己那一行。停用会当场吊销该账号的全部会话 —— 落在自己头上就是把自己登出，
      // 而且只能由另一位组织管理员把你启用回来（"停到零"由服务端另行拦住）。
      // 原先这里两样都不说：弹窗写"该成员"，随后 loadPage 撞 401 弹"会话已过期"，
      // 紧接着又弹一个"已停用成员"的成功提示 —— 两条自相矛盾的话，而人始终不知道自己停用了自己。
      const isSelf = Boolean(currentAccount?.accountId) && target.dataset.account === currentAccount.accountId;
      if (status === "suspended" && !(await confirmDialog({
        title: isSelf ? "停用你自己的账号" : "停用成员",
        message: isSelf ? "这是你当前登录的账号，确认停用它？" : "确认停用该成员？",
        sub: isSelf
          ? "你会被立即登出，之后只能由另一位组织管理员把你启用回来。"
          : "其活动会话将被立即吊销。",
        danger: true, confirmText: "停用"
      }))) return;
      await api(`/api/org/members/${encodeURIComponent(target.dataset.account)}/status`, {method: "POST", body: JSON.stringify({status})});
      if (isSelf && status === "suspended") {
        // 会话已经在服务端没了，再 loadPage 只会撞 401 弹一句"会话已过期"，把真正发生的事盖掉。
        clearSession();
        openModal("已停用你自己的账号", `<div class="notice">你的账号已停用，这一台已经登出。
          要恢复，需要另一位组织管理员在「成员管理」里把它启用回来。</div>`);
        return;
      }
      await loadPage();
      toast.success(status === "suspended" ? "已停用成员" : "已启用成员");
      return;
    }
    if (action === "member-retire") {
      // 注销是【终态且不可撤销】。与停用共用一套话术会害人 —— 停用那句写的是"可以启用回来"，
      // 而这里回不来。所以三件事都当面说清：会话、名下授权、登录凭据一起断。
      const isSelfRetire = Boolean(currentAccount?.accountId) && target.dataset.account === currentAccount.accountId;
      if (!(await confirmDialog({
        title: isSelfRetire ? "注销你自己的账号" : "注销账号",
        message: isSelfRetire ? "这是你当前登录的账号，确认永久注销它？" : "确认永久注销该账号？",
        sub: "注销不可撤销：它的活动会话会被吊销、名下的资源授权会被撤销、登录凭据会被清除，"
          + "此后无法用任何方式登录回来。只是想暂时停掉的话，请用「停用」——那个可以启用回来。",
        danger: true, confirmText: "永久注销"
      }))) return;
      const retired = await api(`/api/org/members/${encodeURIComponent(target.dataset.account)}/retire`,
        {method: "POST", body: "{}"});
      if (isSelfRetire) {
        // 与停用自己同理：会话在服务端已经没了，再 loadPage 只会撞 401 弹"会话已过期"，
        // 把真正发生的事盖掉。而这一次连"让别人启用回来"这条出路都没有。
        clearSession();
        openModal("已注销你自己的账号", `<div class="notice">你的账号已永久注销，这一台已经登出。
          注销不可撤销 —— 需要重新参与的话，只能由管理员邀请一个新账号。</div>`);
        return;
      }
      await loadPage();
      // 回执里带着"这一下动了什么"，原样说给人听：光说"已注销"的话，人不知道授权断没断。
      toast.success(`账号已注销：吊销会话 ${retired?.revokedSessions ?? "?"} 个、`
        + `撤销授权 ${retired?.revokedGrants ?? "?"} 张、登录凭据已清除`);
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
        // 文案自己写着"当场失效"：这是不可逆的，而且作废的是【别人手上】那份。
        // confirmDialog 的安全语义（回车不触发、焦点落在「取消」）只对 danger 生效 ——
        // 不标的话，一个回车就把对方的令牌作废了。同一个坑 5018 行附近记过一次。
        danger: true,
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
    if (action === "reset-initial-admin-login") {
      if (!(await confirmDialog({
        title: "重置初始组织管理员登录",
        message: "确认撤销该管理员的现有登录会话和密码，并重新签发一次性登录令牌？",
        sub: "该管理员会被立即登出，原密码不再可用。新令牌只显示一次；管理员用它首次登录后应立即设置新密码。此操作只适用于组织登记的初始管理员。",
        danger: true,
        confirmText: "确认重置"
      }))) return;
      const reissued = await api(`/api/org/members/${encodeURIComponent(target.dataset.account)}/reissue-invite`, {
        method: "POST", body: JSON.stringify({resetActiveInitialAdmin: true})
      });
      await loadPage();
      openModal("初始组织管理员一次性登录凭据", `
        <div class="stack">
          <div class="notice warn-notice">原会话和密码已失效。以下凭据仅显示一次，请通过受控通道交给该组织管理员。</div>
          <div class="command-box"><strong>登录账号</strong><pre>${esc(reissued.login?.email || "")}</pre></div>
          <div class="command-box"><strong>一次性令牌</strong><pre id="reset-admin-token">${esc(reissued.accountToken || "")}</pre></div>
          <div class="button-row"><button type="button" class="secondary-button" data-action="copy-el" data-copy-target="#reset-admin-token">复制令牌</button></div>
        </div>
      `, {protected: true});
      return;
    }
    if (action === "agent-view-mode") {
      agentViewMode = target.dataset.mode;
      render();
      return;
    }
    if (action === "open-agent-profile") {
      const visibleProfiles = page === "org-agents" ? orgScopedAgents()
        : page === "proj-agents" ? projectScopedAgents(currentProjectId) : [];
      const agentId = target.dataset.agent || "";
      if (!visibleProfiles.some((agent) => agent.id === agentId)) return;
      requestRoutePush();
      selectedAgentProfileId = agentId;
      workspaces.select(page, page === "org-agents" ? "profiles" : "profiles");
      render();
      window.scrollTo?.({top: 0});
      document.querySelector("[data-agent-profile-heading]")?.focus();
      return;
    }
    if (action === "close-agent-profile") {
      requestRoutePush();
      selectedAgentProfileId = "";
      render();
      window.scrollTo?.({top: 0});
      return;
    }
    if (action === "toggle-agent") {
      const agent = (state.agents || []).find((item) => item.id === target.dataset.agent);
      if (agent?.status === "active" && !(await confirmDialog({title: "停用智能体", message: "确认停用该智能体档案？",
        // 这里最容易被误解成"把跑着的 agent 停了"。档案与运行中的节点是两回事，必须说破。
        sub: "停用的是这份档案：该角色的新工作会改落到其它启用中的档案。它不会让正在运行的 agent 节点停下来 —— 要让节点停，切到「组织管理」后打开共享 Agent，用「关停节点」或「立即切断」（本页管的是档案，不是节点）。随时可以再启用。",
        danger: true, confirmText: "停用"}))) return;
      await api(`/api/agents/${encodeURIComponent(target.dataset.agent)}/activate`, {method: "POST", body: JSON.stringify({active: agent?.status !== "active"})});
      await loadPage();
      toast.success(agent?.status === "active" ? "已停用智能体" : "已启用智能体");
      return;
    }
    if (action === "revoke-grant") {
      if (!(await confirmDialog({title: "撤销访问授权", message: "确认撤销该访问授权？",
        sub: "该账号下一次请求就会失去这项授权；已经登录的会话不会被登出。需要时可以重新授权 —— 这一步可逆。",
        danger: true, confirmText: "撤销"}))) return;
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
        title: "吊销 agent 节点",
        message: "确认吊销该 agent 节点？",
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
      if (command === "cancel_dispatch" && !(await confirmDialog({title: "取消派发", message: "确认取消该节点当前派发的任务？",
        sub: "这次派发就此进入终态，不会自动重排；工作项退回「待人工决策」等你处置，它名下的产出目标与 MCP 授权一并了结。",
        danger: true, confirmText: "取消派发"}))) return;
      if (command === "shutdown" && !(await confirmDialog({title: "关停节点", message: "确认优雅关停该节点？", sub: "节点将进入 draining，完成或围栏当前派发后离线（区别于硬吊销）。", danger: true, confirmText: "关停"}))) return;
      const node = [...(state.agentRuntimeNodes || []), ...orgAgentNodes].find((item) => item.nodeId === target.dataset.nodeId);
      const dispatchId = target.dataset.dispatchId || nodeDispatchIds(node)[0] || "";
      await api(`/api/agent-nodes/${encodeURIComponent(target.dataset.nodeId)}/control`, {
        method: "POST",
        body: JSON.stringify({commandType: command, dispatchId: dispatchId || undefined})
      });
      await loadPage();
      toast.success({pause_dispatch: "已暂停派发", resume_dispatch: "已恢复派发", cancel_dispatch: "已取消派发", refresh_profile: "已下发刷新自检：节点 ACK 后会回写最新能力", shutdown: "已关停节点"}[command] || "已下发控制指令");
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
      const control = await api(`/api/task-groups/${encodeURIComponent(target.dataset.task)}/control`,
        {method: "POST", body: JSON.stringify({action: taskAction})});
      await loadPage();
      // 暂停的全部意义就是停住【在跑的那些活】，而回执里正好有这个数（runtimeControl），
      // 此前被整个丢掉：无论叫停了三个派发还是一个都没有，人看到的都是同一句"已暂停任务组"。
      // "停住了 3 个"与"当前本来就没有在跑的"对下达暂停的人是两件事。
      const runtimeControl = control?.runtimeControl || {};
      const stopped = (runtimeControl.controlCommands || []).length + (runtimeControl.directDispatches || []).length;
      const resumed = (runtimeControl.resumedDispatches || []).length;
      if (taskAction === "pause") {
        toast.success(stopped ? `已暂停任务组，并叫停了 ${stopped} 个在跑的派发` : "已暂停任务组：当前没有在跑的派发");
      } else if (taskAction === "resume") {
        toast.success(resumed ? `已恢复任务组，放行了 ${resumed} 个此前被挡住的派发` : "已恢复任务组：没有被这次暂停挡住的派发");
      } else {
        toast.success({rebound_drift: "已触发纠偏"}[taskAction] || "已执行任务组操作");
      }
      return;
    }
    if (action === "tg-list") {
      await focusManagementGroup("", "tg");
      return;
    }
    if (action === "tg-detail") {
      await focusManagementGroup(target.dataset.task, "tg");
      return;
    }
    if (action === "tg-config-reset") {
      if (!(await confirmDialog({title: "重置任务组配置", message: "确认重置任务组配置？", sub: "将删除全部自定义项并回到继承项目配置。", danger: true, confirmText: "重置"}))) return;
      await api(`/api/task-groups/${encodeURIComponent(target.dataset.task)}/config/reset`, {method: "POST", body: "{}"});
      await loadPage();
      toast.success("已重置任务组配置");
      return;
    }
    if (action === "repo-test-connection") {
      // 测的是【已保存】的配置：表单里没保存的改动不参与。不先说清，人改了地址再点测试，会以为测的是新地址。
      if (formTouched) { toast.info("测试用的是已保存的仓库配置 —— 先点「保存项目配置」，再测"); return; }
      const projectId = target.closest("form[data-form='project-config']")?.dataset.project || currentProjectId;
      const repoId = target.dataset.repo;
      const verifyWrite = target.dataset.verifyWrite === "true";
      if (verifyWrite && !(await confirmDialog({title: "验证仓库推送权限", message: `验证仓库 ${repoId} 的推送权限？`,
        sub: "将创建一个仅含测试文本的临时分支并自动删除。不会修改业务分支，但可能触发仓库的推送通知或 CI。", confirmText: "开始验证"}))) return;
      const result = await api(`/api/projects/${encodeURIComponent(projectId)}/repositories/${encodeURIComponent(repoId)}/connection-test`, {method: "POST", body: JSON.stringify(verifyWrite ? {verifyWrite: true} : {})});
      if (verifyWrite) {
        openModal("仓库读写验证", repositoryWriteResultHtml(repoId, result));
        return;
      }
      if (result?.ok === true) {
        toast.success(`仓库 ${repoId} 连接成功：远端有 ${result.refCount} 个分支，默认分支${result.defaultBranchFound ? "存在" : "还不存在（首次推送时会新建）"}。仅验证读取，尚未验证推送权限`);
      } else {
        const why = REPO_CONNECTION_REASON_TEXT[result?.reason] || `原因未归类（${result?.reason || "服务端没给原因"}）`;
        toast.error(`仓库 ${repoId} 连不上：${why}${result?.detail ? `。git 说：${result.detail}` : ""}`);
      }
      return;
    }
    if (action === "cfg-add") {
      const container = document.querySelector(`[data-cfg-list='${target.dataset.target}']`);
      if (!container) return;
      const kind = target.dataset.kind;
      // 认不出的 kind 不插行：原先兜底插一行「业务规则」行（没有任何按钮会加它），而保存只收 repo / baseline / role ——
      // 那一行人填了就丢。规则有自己的编辑器（ruleTitle / ruleContent）。
      const html = kind === "repo" ? cfgRepoRow() : kind === "baseline" ? cfgBaselineRow() : kind === "role" ? cfgRoleRow() : "";
      if (!html) return;
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
      container.querySelectorAll(".small.muted, .small.warn-text").forEach((placeholder) => placeholder.remove());
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
      execHistoryMode = target.dataset.eventMode === "history";
      execHistoryStack = [];
      managementGroupId = (state.agentDispatches || []).find((item) => item.dispatchId === execScope.id)?.taskGroupId || "";
      workspaces.select("monitor", "events");
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
    if (action === "show-dispatch-rules") {
      const dispatchId = target.dataset.dispatchId || "";
      if (dispatchRuleSummaries[dispatchId]) { delete dispatchRuleSummaries[dispatchId]; render(); return; }
      dispatchRuleSummaries[dispatchId] = await api(`/api/agent-dispatches/${encodeURIComponent(dispatchId)}/contract-summary`);
      render();
      return;
    }
    if (action === "show-session-events") {
      execScope = {type: "session", id: target.dataset.sessionId || ""};
      execHistoryMode = false;
      execHistoryStack = [];
      managementGroupId = (state.workSessions || []).find((item) => item.sessionId === execScope.id)?.taskGroupId || "";
      workspaces.select("monitor", "events");
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
      const cycle = await api("/api/orchestrator/run", {method: "POST", body: JSON.stringify({mode: "all"})});
      await loadPage();
      // 这一拍完全可能【跑了但什么都没推进】：技能源同步失败会让整轮提前返回，
      // changed 里只留一条 blocked_resource。此前这里把回执整个丢掉、一律弹"已触发编排循环"——
      // 人以为成功了，而系统正卡在那儿，下一次再点还是同样的结果。
      const blocked = (cycle?.changed || []).filter((item) => item?.status === "blocked_resource");
      if (blocked.length) {
        const reasons = [...new Set(blocked.map((item) => t(item.reason) || item.reason))];
        toast.error(`编排这一拍被挡住了，没有推进任何事项：${reasons.join("；")}`);
        return;
      }
      // "跑了并推进了"与"跑了但没有可做的事"对人是两件事：后者说明系统健康且无事可做，
      // 前者说明它在干活。一句相同的"已触发"把这两种都盖住了。
      const advanced = (cycle?.changed || []).length;
      toast.success(advanced ? `已触发编排循环，推进了 ${advanced} 项` : "已触发编排循环：本轮没有可推进的事项");
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
let realtimeLastMessageAt = 0;
let realtimeReconnectTimer = null;
let realtimeWakeTimer = null;

function realtimeWake() {
  if (realtimeWakeTimer) return;
  realtimeWakeTimer = setTimeout(() => {
    realtimeWakeTimer = null;
    if (!authToken || loading || modalHtml || formTouched || window.AIMAC_RULE_EDITOR?.isOpen?.() || (page === "tasks" && workEventHistoryMode)) return;
    const active = document.activeElement;
    if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;
    loadPage().catch(reportBackgroundRefreshFailure);
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
    // 记下"实时通道确实在送东西"的时刻。判据不能是"socket 开着"——
    // socket 开着却不再送消息，正是最需要兜底轮询的那一刻（同形的静默停摆本仓修过两次）。
    realtimeLastMessageAt = Date.now();
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
  if (!authToken || loading || modalHtml || formTouched || window.AIMAC_RULE_EDITOR?.isOpen?.() || (page === "tasks" && workEventHistoryMode)) return;
  const active = document.activeElement;
  if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;
  // 这一拍是【兜底】，注释一直这么写，而代码原先无条件跑：实时通道正常时也照样每 5 秒全量拉一遍。
  // 判据用"最近确实收到过实时消息"，不用"socket 开着"：socket 开着却不送消息，
  // 恰恰是最需要兜底的那一刻。15 秒没消息就当它不在送了，照常轮询。
  if (Date.now() - realtimeLastMessageAt < 15000) return;
  loadPage().catch(reportBackgroundRefreshFailure);
}, 5000);

/* ---------------- 启动 ---------------- */

function rememberWorkspaceLocation() {
  window.AIMAC_WORKSPACE_LOCATION?.save({version: 1, accountId: currentAccount?.accountId, projectId: currentProjectId, page,
    workspace: workspaces.current(page)?.id, groupWorkspace: workspaces.current("group-detail")?.id,
    groupId: managementGroupId || (page === "tg" ? expandedTaskGroupId : ""), groupDetail: Boolean(page === "tg" && expandedTaskGroupId),
    workId: page === "tasks" ? selectedWork?.workItemId : "", directiveWorkId: page === "directives" ? directiveWorkItemId : "",
    search: taskSearch, status: taskStatus, cursor: taskPageCursor, stack: taskCursorStack,
    listGroupId: workListGroupId, listCursor: workListState?.cursor, listStack: workListState?.stack});
}

function restoreWorkspaceLocation() {
  const saved = window.AIMAC_WORKSPACE_LOCATION?.read(currentAccount?.accountId);
  if (!saved || !allowedMenuItemsFor(perspectiveOf(currentAccount)).some((item) => item.id === saved.page)) return;
  page = saved.page;
  currentProjectId = saved.projectId;
  workspaces.select(page, saved.workspace);
  workspaces.select("group-detail", saved.groupWorkspace);
  managementGroupId = ["tg", "tasks", "monitor", "review", "directives"].includes(page) ? saved.groupId : "";
  expandedTaskGroupId = page === "tg" && saved.groupDetail ? managementGroupId : "";
  selectedWork = page === "tasks" && saved.workId && managementGroupId ? {taskGroupId: managementGroupId, workItemId: saved.workId} : null;
  taskSearch = saved.search;
  taskStatus = saved.status;
  taskPageCursor = saved.cursor;
  taskCursorStack = saved.stack;
  workListGroupId = saved.listGroupId;
  workListState = {cursor: saved.listCursor, stack: saved.listStack};
  directiveTaskGroupId = managementGroupId;
  directiveWorkItemId = page === "directives" ? saved.directiveWorkId : "";
  restoredWorkspaceLocation = true;
  sessionStorage.setItem("aimac.page", page);
  sessionStorage.setItem("aimac.projectId", currentProjectId);
}

async function applyBrowserHistoryRoute(route) {
  if (!authToken || !currentAccount || !route) return;
  if (browserRouteBusy) {
    queuedBrowserRoute = route;
    return;
  }
  browserRouteBusy = true;
  try {
    if (!allowedMenuItemsFor(perspectiveOf(currentAccount)).some((item) => item.id === route.page)) {
      toast.info("这个地址不属于当前账号的管理空间，已保留在当前页面");
      window.AIMAC_WORKSPACE_ROUTE?.write(workspaceRouteSnapshot(), {replace: true});
      return;
    }
    if (formTouched && !(await confirmDialog({title: "放弃未保存的修改", message: "浏览器导航将离开当前对象，未保存的修改会丢失。确认继续？", danger: true, confirmText: "放弃并离开"}))) {
      queuedBrowserRoute = null;
      window.AIMAC_WORKSPACE_ROUTE?.write(workspaceRouteSnapshot(), {replace: true});
      return;
    }
    applyingBrowserRoute = true;
    formTouched = false;
    dirtyFormKinds.clear();
    stopExecPolling();
    if (!restoreWorkspaceRoute(route)) return;
    await loadPage();
    if (page === "monitor") {
      await loadExecEvents({reset: true});
      startExecPolling();
      render();
    }
  } catch (error) {
    showError(error);
  } finally {
    applyingBrowserRoute = false;
    browserRouteBusy = false;
    const nextRoute = queuedBrowserRoute;
    queuedBrowserRoute = null;
    if (nextRoute) Promise.resolve().then(() => applyBrowserHistoryRoute(nextRoute).catch(reportBackgroundRefreshFailure));
  }
}

window.AIMAC_WORKSPACE_ROUTE?.listen((route) => {
  applyBrowserHistoryRoute(route).catch(reportBackgroundRefreshFailure);
});

if (authToken && currentAccount) {
  if (!restoreWorkspaceRoute()) restoreWorkspaceLocation();
  page = page || defaultPageFor(perspectiveOf(currentAccount));
  connectRealtime();
  loadPage().then(() => {
    if (page === "monitor") {
      loadExecEvents({reset: true}).catch(reportBackgroundRefreshFailure);
      startExecPolling();
    }
  }).catch((error) => {
    lastError = error?.message || String(error);
    lastErrorIsRequest = error?.requestFailure === true;
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
