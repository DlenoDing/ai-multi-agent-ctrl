#!/usr/bin/env node
// 控制台行为门（console behaviour gate）
//
// 为什么要有这个：控制台的所有校验此前都是**源码字符串断言** —— 在 validate-specs.rb 里查
// app.js 含不含某段文本。这一类断言在本仓已经被证明极易假绿：改个函数名它就失败（假红），
// 而真正的行为坏掉时它照样通过（假绿），因为字符串还在。要断言"人填的内容在提交失败后还在"，
// 字符串断言根本无从下手 —— 它只能证明代码里写了一句 restorePendingForm()，不能证明它管用。
//
// app.js 用 type="module" 加载但**不含任何 import/export**，因此可以在 vm 里当普通脚本求值，
// 求值后它的全部顶层绑定都成为 context 上的变量，可以直接调用。这就让控制台第一次有了真正的
// 行为断言，而不必引入 jsdom（本仓无第三方测试依赖，这是刻意的）。
//
// DOM 桩只做被测代码真正用到的那点事。桩不认识的选择器一律抛错而不是返回空集 ——
// 静默返回空集会让断言"匹配到 0 个元素所以没发现问题"从而永远通过，那是本仓踩过的坑。
import { accountEffectivePermissions, consoleVocabularies, effectiveProjectConfig, effectiveTaskGroupConfig } from "../apps/control-plane-ui/lib/control-plane-core.mjs";
import { AUDIT_LOG_CAP } from "../apps/control-plane-ui/lib/audit-ledger.mjs";
import { mcpToolNames } from "../apps/control-plane-ui/lib/mcp-tool-catalog.mjs";
import { REPOSITORY_CONNECTION_REASONS } from "../apps/control-plane-ui/lib/git-connection-test.mjs";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const consolePublicDir = path.join(root, "apps/control-plane-ui/public");
const consoleModuleFiles = [
  "modules/dom-utils.js",
  "modules/i18n-utils.js",
  "modules/navigation.js",
  "modules/labels.js",
  "modules/time-format.js",
  "modules/ui-config.js",
  "modules/ui-primitives.js"
];

function readConsoleSource(file) {
  return fs.readFileSync(path.join(consolePublicDir, file), "utf8");
}

function readConsoleAppSource() {
  return readConsoleSource("app.js");
}

function readConsoleNavigationSource() {
  return readConsoleSource("modules/navigation.js");
}

function loadConsoleModules(context) {
  for (const file of consoleModuleFiles) {
    vm.runInContext(readConsoleSource(file), context, {filename: file});
  }
}

/* ---------------- 极简 DOM 桩 ---------------- */

class StubElement {
  constructor(tag, attrs = {}, children = []) {
    this.tagName = tag.toUpperCase();
    this.dataset = attrs.dataset || {};
    this.name = attrs.name || "";
    this.type = attrs.type || (this.tagName === "INPUT" ? "text" : "");
    this.value = attrs.value === undefined ? "" : attrs.value;
    this.checked = attrs.checked === true;
    this.children = children;
    for (const child of children) if (child && typeof child === "object") child.parentElement = this;
    this.classList = {add() {}, remove() {}, contains() { return false; }, toggle() {}};
    this.style = {};   // 弹窗遮罩要设 style.zIndex：桩没有 style 的话确认框那条路在第一行就抛错（变异态里看见的）。
  }
  // 提交处理器第一行就是 event.target.closest("form[data-form]")：桩没有 closest 的话，任何表单提交在门里都跑不到。
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.#matches(selector)) return node;
    }
    return null;
  }

  // toast 会给容器设 role/aria-live 之类：桩里少了这些方法，任何走到 toast 的路径都会
  // 以 "setAttribute is not a function" 收场 —— 那是桩的故障，不是被测代码的。
  setAttribute(name, value) { this.attributes = {...(this.attributes || {}), [name]: value}; }
  appendChild(child) { this.children.push(child); if (child && typeof child === "object") child.parentElement = this; return child; }
  insertBefore(child) { this.children.unshift(child); if (child && typeof child === "object") child.parentElement = this; return child; }
  getAttribute(name) { return (this.attributes || {})[name] ?? null; }
  removeAttribute(name) { if (this.attributes) delete this.attributes[name]; }
  // 记下监听器：确认弹窗（confirmDialog）把 click 挂在遮罩上等人点，门要能替人点「取消」/「确认」。
  addEventListener(type, handler) { (this.listeners ||= {})[type] = handler; }
  removeEventListener() {}
  remove() {}
  // 弹窗那条路要 document.body.classList.add("modal-open") 与 mask.querySelector(...).focus()。
  // 桩上没有这三样时，openModal 在第一行就抛 TypeError → 被页面级 catch 吞成「控制台这一页自己
  // 出错了」横幅 —— 而归档弹窗的四条断言此前一直在那条横幅旁边的页面上凑到期望串、绿着，
  // 弹窗从来没真的开过（第 67 拍加「探针自查」才发现）。
  // 实例属性而不是 getter：runDoubleSubmitGuardCase 会给自己的桩按钮换一个 classList 间谍来观察防重。
  querySelector() { return new StubElement("div"); }
  querySelectorAll() { return []; }
  focus() {}

  #descendants() {
    return this.children.flatMap((child) => [child, ...child.#descendants()]);
  }

  #matches(selector) {
    const tagList = selector.split(",").map((part) => part.trim());
    if (tagList.every((part) => /^[a-z]+$/.test(part))) {
      return tagList.some((tag) => this.tagName === tag.toUpperCase());
    }
    // 类选择器：桩里没有真实子树，一律空集。整页 render 会查 .table-scroll 之类，
    // 不认它就只能整个 render 都测不了。
    if (/^\.[a-zA-Z0-9_-]+$/.test(selector)) return false;
    const named = selector.match(/^\[name="(.*)"\]$/s);
    if (named) return this.name === named[1].replace(/\\(.)/g, "$1");
    // 表单提交路径用的形状：input[name='perm']:checked、textarea[name='ruleContent']、select[name='languageTag']。
    const tagNamed = selector.match(/^([a-z]+)\[name='([^']*)'\](:checked)?$/);
    if (tagNamed) {
      return this.tagName === tagNamed[1].toUpperCase() && this.name === tagNamed[2] && (!tagNamed[3] || this.checked === true);
    }
    // 提交按钮：button[type='submit'], button:not([type='button'])
    if (selector === "button[type='submit'], button:not([type='button'])") {
      return this.tagName === "BUTTON" && this.type !== "button";
    }
    const formSel = selector.match(/^form\[data-form\]$/);
    if (formSel) return this.tagName === "FORM" && this.dataset.form !== undefined;
    // 纯 data 属性选择器（render 之后的 restoreFilters 会查 [data-filter-input]）：
    // 桩里没有真实表单子树，按 dataset 判断即可 —— 没有就是空集，这是诚实的答案，
    // 不像未知选择器那样需要拦下来（拦的是"桩会给出一个看似合理其实错的答案"）。
    const dataSel = selector.match(/^\[data-([a-z-]+)\]$/);
    if (dataSel) {
      const key = dataSel[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return this.dataset[key] !== undefined;
    }
    // 带值的 data 选择器（配置编辑器加行时查 [data-cfg-list='xxx']）：同样按 dataset 判。
    const dataValueSel = selector.match(/^\[data-([a-z-]+)=['"]([^'"]*)['"]\]$/);
    if (dataValueSel) {
      const key = dataValueSel[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return this.dataset[key] === dataValueSel[2];
    }
    throw new Error(`DOM 桩不认识选择器 ${JSON.stringify(selector)} —— 桩已与被测代码脱节，不能据此下结论`);
  }

  querySelectorAll(selector) {
    // 后代组合（规则编辑器收行时查 `[data-cfg-list='X'] [data-rule-row]`）：先找匹配前半的祖先，再在其后代里找后半。
    const combo = /^(\S+)\s+(\S+)$/.exec(selector.trim());
    if (combo && !selector.includes(",")) {
      const out = [];
      for (const ancestor of this.#descendants().filter((el) => el.#matches(combo[1]))) {
        for (const node of ancestor.#descendants().filter((el) => el.#matches(combo[2]))) if (!out.includes(node)) out.push(node);
      }
      return out;
    }
    return this.#descendants().filter((el) => el.#matches(selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  // 配置编辑器的「加一行」走 insertAdjacentHTML；桩没有它的话点击会在这一行抛错、被吞成"点了没反应"。
  insertAdjacentHTML(_position, html) { this.innerHTML = `${this.innerHTML || ""}${html}`; }
}

// 提交处理器用 new FormData(form, submitter) 取值：按后代里带 name 的控件收，未勾选的 checkbox/radio 不收，
// 最后带上点击的那个提交按钮的 name/value（批准/拒绝那种双按钮表单就靠它）。
class StubFormData {
  constructor(form, submitter) {
    this.pairs = [];
    const walk = (node) => {
      for (const child of node.children || []) {
        if (child.name && ["INPUT", "SELECT", "TEXTAREA"].includes(child.tagName)) {
          if ((child.type === "checkbox" || child.type === "radio") && !child.checked) { walk(child); continue; }
          this.pairs.push([child.name, child.value]);
        }
        walk(child);
      }
    };
    walk(form);
    if (submitter?.name) this.pairs.push([submitter.name, submitter.value ?? ""]);
  }
  entries() { return this.pairs[Symbol.iterator](); }
}
if (!globalThis.FormData) globalThis.FormData = StubFormData;

function el(tag, attrs, children) { return new StubElement(tag, attrs, children); }

// 【走 probe.click 的用例都要自查：弹窗/动作真的执行了，而不是崩成横幅】。归档弹窗的四条断言
// 从第 54 拍起一直在「控制台这一页自己出错了」那条横幅旁边凑期望串（StubElement 缺 classList，
// openModal 第一行就抛）。任何点击用例拿到 HTML 后先过这一道，再断言自己关心的内容。
function assertNoCrashBanner(html, where) {
  const crashed = /控制台这一页自己出错了/u.exec(String(html));
  check(`【探针自查】${where}：点击没有崩成页面级横幅`,
    !crashed,
    `${where} 的 HTML 里有崩溃横幅 —— 这个用例后面的断言看的是横幅旁边的页面，不是它以为的那块：`
      + String(html).replace(/<[^>]+>/gu, " ").match(/控制台这一页自己出错了.{0,120}/u)?.[0]);
}


// 桩里 innerHTML 是普通属性，父节点取不到子节点的内容；而 toast 是 appendChild 到 body 上的
// 独立图层（真实浏览器里正因如此，#app 重渲染抹不掉它）。要断言 toast 说了什么，得走子树。
function stubSubtreeText(node) {
  if (!node) return "";
  return [String(node.innerHTML || ""), ...(node.children || []).map(stubSubtreeText)].join(" ");
}

function makeContext(documentRoot) {
  const noop = () => {};
  const context = {
    console,
    setInterval: () => 0,
    clearInterval: noop,
    setTimeout: () => 0,
    clearTimeout: noop,
    CSS: {escape: (value) => String(value).replace(/["\\]/g, "\\$&")},
    // 桩里缺 console 时，任何往浏览器日志里写一行的代码路径都会以 ReferenceError 收场 ——
    // 那是桩的故障，不是被测代码的（与上面 setAttribute 那条同理）。
    console: {log: noop, warn: noop, error: noop, info: noop, debug: noop},
    fetch: async () => { throw new Error("行为门不应发起网络请求"); },
    FormData: StubFormData,
    WebSocket: class { constructor() { this.close = noop; } },
    location: {origin: "http://localhost", protocol: "http:", host: "localhost", href: "http://localhost/"},
    // 会话存储要是【真的能存】的桩：草稿跨过会话过期这条路径全靠它，
    // 用只读空桩的话，那几条断言测的是"什么都没发生"。
    sessionStorage: (() => {
      const box = new Map();
      return {getItem: (k) => (box.has(k) ? box.get(k) : null), setItem: (k, v) => box.set(k, String(v)),
        removeItem: (k) => box.delete(k), __box: box};
    })(),
    localStorage: {getItem: () => null, setItem: noop, removeItem: noop},
    navigator: {clipboard: {writeText: async () => {}}},
    t: (key) => key,
    document: {
      documentElement: el("html"),
      body: documentRoot,
      activeElement: null,
      addEventListener: (type, handler) => { context.__handlers[type] = handler; },
      removeEventListener: noop,
      createElement: (tag) => el(tag),
      getElementById: () => null,
      querySelector: (selector) => (selector === "#app" ? documentRoot : documentRoot.querySelector(selector)),
      querySelectorAll: (selector) => documentRoot.querySelectorAll(selector)
    },
    __handlers: {}
  };
  context.window = context;
  context.globalThis = context;
  context.window.addEventListener = noop;
  context.window.scrollTo = noop;
  context.window.scrollY = 0;
  return context;
}

// vm 里普通脚本的顶层 let/const 落在脚本的词法作用域，**不会**成为全局对象的属性（只有
// function 声明和 var 会）。所以要读写 pendingFormRestore / formTouched 这类状态，必须追加一段
// 与被测代码同作用域的尾插探针来闭包捕获它们。app.js 本身不做任何改动。
// 若这些绑定被改名，尾插会在加载时抛 ReferenceError —— 本门直接失败，而不是悄悄测了个空。
const PROBE_EPILOGUE = `
globalThis.__probe = {
  grantRoleLabel: (role) => grantRoleLabel(role),
  joinTokenTargetProjects: (nextState) => { state = nextState; return joinTokenTargetProjects(); },
  canResumeTaskGroupAs: (taskGroup, accountType) => {
    currentAccount = {accountId: "probe", accountType};
    return canResumeTaskGroup(taskGroup);
  },
  requestFailureHint: (payload) => requestFailureHint(payload),
  ruleEditorFormWith: (options) => ruleEditorForm(options),
  ruleRowNewWith: (category) => ruleRowNew(category),
  snapshotFormValues: (formEl) => snapshotFormValues(formEl),
  restorePendingForm: () => restorePendingForm(),
  setPending: (value) => { pendingFormRestore = value; },
  getFormTouched: () => formTouched,
  setProjConfigVersion: (value) => { projConfigVersion = value; },
  setFormTouched: (value) => { formTouched = value; },
  renderSource: () => String(render),
  handlerSource: (type) => String(globalThis.__handlers[type]),
  click: (event) => globalThis.__handlers.click(event),
  submit: (event) => globalThis.__handlers.submit(event),
  stubNavigation: () => { render = () => {}; loadPage = async () => {}; toast = {success: () => {}, error: () => {}, info: () => {}}; },
  // 第三个入参可选：明细里有几处要读 state（溯源引用要拿 humanDirectives 解析成人名）。
  renderTaskGroupDetail: (detail, taskGroup, nextState) => {
    tgDetail = detail;
    if (nextState) state = nextState;
    return renderTaskGroupDetail(taskGroup);
  },
  loadTaskGroupDetailSource: () => String(loadTaskGroupDetail),
  decisionSelect: (...args) => decisionSelect(...args),
  listEmptyText: (what, failure) => { lastError = failure; return listEmptyText(what); },
  tableWith: (failure, headers, rows, options) => { lastError = failure; return table(headers, rows, options); },
  skillSourceNotice: (skillSources, roleSkillCountBySource) => {
    state = {...state, skillSources, roleSkillCountBySource};
    return String(renderSysSettings()).replace(/<[^>]+>/gu, " ").includes("系统内置技能")
      ? String(renderSysSettings()).replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ") : "";
  },
  systemOverviewText: (nextState, account, status) => {
    state = nextState; currentAccount = account; currentProjectId = null; page = "sys-overview";
    authToken = "probe-token"; systemOverview = null; systemOverviewStatus = status;
    render();
    return String(document.body.innerHTML || "").replace(/<[^>]+>/gu, " ");
  },
  failureBannerText: (nextState, account, message, isRequest) => {
    state = nextState; currentAccount = account; currentProjectId = null; page = "sys-overview";
    authToken = "probe-token";
    lastError = message; lastErrorIsRequest = isRequest;
    render();
    return String(document.body.innerHTML || "").replace(/<[^>]+>/gu, " ");
  },
  statusBadge: (kind, value) => statusBadge(kind, value),
  captureToast: (sink) => { toast.info = (message) => sink(message); },
  captureToastKind: (kind, sink) => { toast[kind] = (message) => sink(message); },
  bodyChildren: () => document.body.children || [],
  translate: (key) => t(key),
  filteredEmptyText: (query, hidden) => filteredEmptyText(query, hidden),
  applyFilterForSource: () => String(applyFilterFor),
  heartbeatStaleHint: (node) => heartbeatStaleHint(node),
  claimMissHint: (node) => claimMissHint(node),
  selfCheckFailureHint: (node) => selfCheckFailureHint(node),
  assertRuleFragmentLengths: (fragments) => assertRuleFragmentLengths(fragments),
  evidenceRefsHint: (event) => evidenceRefsHint(event),
  alternativeAxisGaps: (assessment) => alternativeAxisGaps(assessment),
  renderReviewWith: (nextState, account, projectId) => { state = nextState; currentAccount = account || null; if (projectId !== undefined) currentProjectId = projectId; return renderReview(); },
  renderPendingPanelWith: (nextState, account) => { state = nextState; currentAccount = account; return renderPendingForMePanel(); },
  todoCountsWith: (nextState, account) => { state = nextState; currentAccount = account; return todoCountsByPage(); },
  moreTextWith: (nextState, total, shown, field) => { state = nextState; return moreText(total, shown, field); },
  renderLoginWith: (hint) => { loginHint = hint; renderLogin(); return document.querySelector("#app").innerHTML || ""; },
  bootstrapScaleFrom: (overview) => bootstrapScaleFrom(overview),
  renderSysOverviewWith: (nextState, account, overviewData) => { state = nextState; currentAccount = account; systemOverview = overviewData; return renderSysOverview(); },
  renderSysSettingsWith: (nextState, instructions) => { state = nextState; if (instructions !== undefined) instructionState = instructions; return renderSysSettings(); },
  renderSysOrgsWith: (nextState, account, orgList) => { state = nextState; currentAccount = account; organizations = orgList || []; return renderSysOrgs(); },
  renderSysAccountsWith: (nextState, account, projectId) => {
    state = nextState; currentAccount = account;
    if (projectId !== undefined) currentProjectId = projectId;
    return renderSysAccounts();
  },
  renderOrgOverviewWith: (nextState, account, members, nodes) => {
    state = nextState; currentAccount = account; orgMembers = members || []; orgAgentNodes = nodes || [];
    return renderOrgOverview();
  },
  renderOrgMembersWith: (nextState, account, members, projectId) => {
    state = nextState; currentAccount = account; orgMembers = members || [];
    if (projectId !== undefined) currentProjectId = projectId;
    return renderOrgMembers();
  },
  renderOrgProjectsWith: (nextState, account, projectId, members) => {
    state = nextState; currentAccount = account; currentProjectId = projectId; orgMembers = members || [];
    return renderOrgProjects();
  },
  renderOrgAgentsWith: (nextState, account, nodes) => { state = nextState; currentAccount = account; orgAgentNodes = nodes || []; return renderOrgAgents(); },
  renderProjectAgentsWith: (nextState, account, projectId, viewMode) => {
    state = nextState; currentAccount = account; currentProjectId = projectId;
    if (viewMode) agentViewMode = viewMode;
    return renderProjectAgents();
  },
  renderProjectMembersWith: (nextState, account, projectId, members) => {
    state = nextState; currentAccount = account; currentProjectId = projectId; orgMembers = members || [];
    return renderProjectMembers();
  },
  renderProjectSettingsWith: (nextState, account, projectId, config) => {
    state = nextState; currentAccount = account; currentProjectId = projectId;
    projConfig = config || {repositories: [], baselineData: [], defaultRoles: [], systemRules: [], businessRules: []};
    projConfigStatus = "loaded"; projConfigVersion = "probe-config";
    return renderProjectSettings();
  },
  blockerGuide: (type) => blockerGuide(type),
  renderMonitorWith: (nextState, account, projectId) => { state = nextState; currentAccount = account; currentProjectId = projectId; return renderMonitor(); },
  setAuth: (token, account) => { authToken = token; currentAccount = account; },
  stashDraft: (pageId, projectId) => { page = pageId; currentProjectId = projectId; stashDraftForExpiredSession(); },
  peekDraft: () => sessionStorage.getItem("aimac.expiredDraft"),
  setDraftRaw: (raw) => sessionStorage.setItem("aimac.expiredDraft", raw),
  // 401 那条【接线】要单独验：光验函数本身，把 api() 里的调用删掉照样绿。
  expireViaApi: async (pageId, projectId) => {
    // 先清干净：不清的话读到的是上一次直接调函数留下的那份，
    // 把 401 分支的调用删掉照样"有草稿"，断言等于没验（第一版就是这样）。
    sessionStorage.removeItem("aimac.expiredDraft");
    page = pageId; currentProjectId = projectId; authToken = "probe-token";
    globalThis.fetch = async () => ({ok: false, status: 401, statusText: "Unauthorized",
      headers: {get: () => null}, json: async () => ({error: "auth_required"}), text: async () => "{}"});
    try { await api("/api/state?view=tasks"); } catch { /* 401 必然抛 */ }
    return sessionStorage.getItem("aimac.expiredDraft");
  },
  ageDraft: (ms) => {
    const saved = JSON.parse(sessionStorage.getItem("aimac.expiredDraft") || "null");
    if (saved) { saved.at = Date.now() - ms; sessionStorage.setItem("aimac.expiredDraft", JSON.stringify(saved)); }
  },
  restoreDraft: () => { const ok = restoreDraftAfterRelogin(); return {ok, page, projectId: currentProjectId, pending: pendingFormRestore}; },
  renderFullPageWith: (nextState, account, projectId, pageId) => { state = nextState; currentAccount = account; currentProjectId = projectId; page = pageId; authToken = authToken || "probe-token"; render(); },
  // 「待人工确认」那个数不在 state 里：它由 loadPage 从计数接口取回来放进模块级变量。
  // 不给探针一个入口的话，凡是依赖它的那一格都只能在 0 上被验，而真实产品里它常常不是 0。
  setPendingConfirmCount: (count) => { pendingConfirmCount = Number(count) || 0; },
  renderTaskGroupsWith: (nextState, account, projectId, detailId, detail) => { state = nextState; currentAccount = account; currentProjectId = projectId; expandedTaskGroupId = detailId; if (detail !== undefined) tgDetail = detail; return renderTaskGroups(); },
  renderProjectOverviewWith: (nextState, account, projectId) => { state = nextState; currentAccount = account; currentProjectId = projectId; page = "proj-overview"; return renderProjectOverview(); },
  renderDirectivesWith: (nextState, account, projectId, directives) => { state = nextState; currentAccount = account; currentProjectId = projectId; directiveList = directives || []; return renderDirectives(); },
  selectProjectWith: (nextState, account, projectId) => {
    state = nextState; currentAccount = account; currentProjectId = projectId;
    ensureProjectSelection();
    return {kept: currentProjectId, options: selectableProjects().map((item) => item.id)};
  },
  setMemberGrantProjectId: (value) => { memberGrantProjectId = value; },
  setProjConfigStatus: (status, error) => { projConfigStatus = status; projConfig = null; projConfigError = error || ""; },
  setFetch: (fn) => { globalThis.fetch = fn; },
  // 断连横幅要按【真实加载路径】验：直接改 lastError 只能证明模板会渲染，
  // 证不了加载失败真的会把它设上、也证不了下一次成功真的会把它清掉。
  loadWithFetch: async (nextState, account, projectId, pageId, fetchStub) => {
    state = nextState; currentAccount = account; currentProjectId = projectId; page = pageId;
    authToken = "probe-token";
    globalThis.fetch = fetchStub;
    await loadPage();
    return document.body.innerHTML;
  },
  // 漏译扫描要覆盖【数据不在 state 里】的那几页（人工指令 / 成员 / 智能体 / 项目设置）：
  // 它们各自另走接口取数，只喂 state 渲染出来的永远是空壳。走真实的 loadPage 让那些
  // 模块级变量被填上，再渲染 —— 与其给探针加一堆 setter，不如让它跑真实加载路径。
  loadPageWith: async (nextState, account, projectId, pageId, fetchStub) => {
    state = nextState; currentAccount = account; currentProjectId = projectId; page = pageId;
    authToken = "probe-token";
    globalThis.fetch = fetchStub;
    await loadPage();
    return document.body.innerHTML;
  },
  api: (path, options) => api(path, options),
  setPage: (value) => { page = value; },
  // 渲染之后【实际停在哪一页】。render() 会把「当前身份菜单里没有的页」静默改写成默认页，
  // 而调用方只拿到 HTML，看不出这件事 —— 会把别的页的内容当成自己要读的那一页。
  currentPage: () => page,
  backgroundRefreshFailure: (error) => reportBackgroundRefreshFailure(error),
  // 「上一次加载成功」是按页记的：钩子要把当前页那一格也填上，否则它模拟的其实是
  // 「别的页成过、这一页从没成过」——那是另一种情形（下面单独有断言）。
  setLastLoadedAt: (value) => { lastLoadedAt = value; pageLoadedAt[page] = value; }
};
`;

// realI18n：本门其余部分把 t 桩成恒等函数（断言按英文键匹配），但有些行为只有【真词表】在场时
// 才看得见 —— 比如 "code:detail" 形态的失败原因要不要拆开翻译。需要时按这个开关加载真的 i18n。
function loadConsole(documentRoot, options = {}) {
  const source = readConsoleAppSource();
  const context = vm.createContext(makeContext(documentRoot));
  if (options.realI18n) {
    vm.runInContext(readConsoleSource("i18n-zh.js"), context, {filename: "i18n-zh.js"});
    if (typeof context.window?.AIMAC_I18N?.t !== "function") {
      throw new Error("控制台行为门: 要求真词表却没加载上 —— 相关断言会在空转");
    }
  }
  loadConsoleModules(context);
  vm.runInContext(source + PROBE_EPILOGUE, context, {filename: "app.js"});
  if (!context.__probe) throw new Error("控制台行为门: 尾插探针未生效，本门无法断言任何东西");
  return context.__probe;
}

// 接线检查：上面那些断言证明了回填逻辑本身正确，但证明不了它被接上了 —— 把 render() 末尾那行
// 调用删掉，逻辑断言照样全绿。而"机制建好了却与被约束的那件事断了一环"正是本仓反复出现的缺陷类，
// 不能在这道门自己身上重演。
//
// 真正的端到端（触发 submit -> 请求失败 -> 整页重渲染 -> 断言内容还在）需要能解析 innerHTML 的
// DOM，本仓无 jsdom 且刻意不引第三方测试依赖。折中办法是取**实际函数对象**的源码来查接线，
// 而不是在文件里全文找字符串：render 取的是那个函数对象，submit 取的是真正注册到 document 上的
// 那个处理器 —— 注释、死代码、同名的另一处写法都不会误判成接上了。这一点必须如实说明：
// 它验证的是"调用写在了正确的位置"，不是"整条链路跑通了"。
function checkWiring(probe) {
  const renderSource = probe.renderSource();
  check("回填接进重渲染",
    /\brestorePendingForm\(\)/.test(renderSource),
    "render() 里没有调用 restorePendingForm —— 回填逻辑写好了但没人调用，提交失败照样清空");

  const submitSource = probe.handlerSource("submit");
  const captureAt = submitSource.indexOf("pendingFormRestore = snapshotFormValues(form)");
  const showErrorAt = submitSource.indexOf("showError(error)");
  check("快照在重渲染之前取",
    captureAt >= 0 && showErrorAt >= 0 && captureAt < showErrorAt,
    `submit 处理器没有在 showError 之前对表单取快照（捕获位置 ${captureAt}，报错位置 ${showErrorAt}）—— showError 会立刻整页重渲染，之后再取快照拿到的是已经被清空的表单`);
}

// 【拿真实状态把页面渲染成文本读】。夹具是人编的，编出来的只会是我想到的那些情形；
// 真实运行之后的状态里有编不出来的组合。用法：
//   AIMAC_RENDER_REAL=<运行目录> node scripts/console-behaviour-check.mjs
// 只打印、不断言 —— 它是勘察工具，不是判据（判据要能报红，而"读一遍"报不了红）。
// 打印时的截断【必须自报】。本工具是用来找「静默截断」这类缺陷的，而它自己就在
// 静静地砍掉每页 900 字之后的内容 —— 实测差点据此得出「这张卡没有『你没权限』那句提示」
// 的相反结论（那句话就在被砍掉的部分里）。截了就说清截在哪、总共多少。
// 想看全文：AIMAC_RENDER_CHARS=0（不限）或给一个更大的数。
const renderChars = process.env.AIMAC_RENDER_CHARS === undefined
  ? 900 : Number(process.env.AIMAC_RENDER_CHARS);
const clip = (text, limit = renderChars) => {
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（本页文本共 ${text.length} 字，这里只打了前 ${limit} 字 ——`
    + " 下面还有内容，不是页面到此为止；要看全文加 AIMAC_RENDER_CHARS=0）";
};

if (process.env.AIMAC_RENDER_REAL) {
  const dir = process.env.AIMAC_RENDER_REAL;
  const {readStoredState} = await import(`${root}/apps/control-plane-ui/lib/state-store.mjs`);
  const real = readStoredState({root, runtimeDir: dir, statePath: `${dir}/control-plane-state.json`,
    seedPath: `${root}/data/seed-state.json`, buildInitialState: () => ({})});
  // 视角可换：AIMAC_RENDER_AS=<邮箱>。默认系统管理员，但不同视角看到的是不同的页与不同的空态，
  // 只读一个人的屏幕会漏掉另一类人才撞得到的死胡同（"请联系组织管理员"那次就是这么发现的）。
  const wantWho = process.env.AIMAC_RENDER_AS;
  // 组织管理员四页（org-*）只有 org_admin 身份的菜单里才有；真实状态里常常没有这样的账号（本仓就没有）。
  // AIMAC_RENDER_AS=org_admin 时合成一个挂在第一个组织上的组织管理员来读这四页 —— 输出里标明是合成的。
  const syntheticOrgAdmin = wantWho === "org_admin" && !(real.accounts || []).some((item) => item.email === "org_admin")
    ? {accountId: "acct_survey_org_admin", email: "org_admin", accountType: "org_admin", displayName: "组织管理员（勘察合成）",
      organizationId: (real.organizations || [])[0]?.orgId || "org_default", status: "active", roles: ["org_admin"]}
    : null;
  if (syntheticOrgAdmin) console.log(`（AIMAC_RENDER_AS=org_admin：真实状态里没有组织管理员账号，合成了一个挂在 ${syntheticOrgAdmin.organizationId} 上的来读 org-* 四页）`);
  const whoOnDisk = syntheticOrgAdmin || (wantWho && (real.accounts || []).find((item) => item.email === wantWho))
    || (real.accounts || []).find((item) => item.accountType === "system_admin") || (real.accounts || [])[0];
  // 盘上的账号只有直接权限；控制台判权读的是服务端算出来的 effectivePermissions（直接 ∪ 授权）。
  // 不补上它，一个靠授权拿到评审权的人在这份输出里会被写成「当前账号无人工审核权限」——
  // 本轮就差点把它当产品缺陷去查。用的是与服务端同一个函数，不另抄一份。
  const who = whoOnDisk ? {...whoOnDisk, effectivePermissions: accountEffectivePermissions(real, whoOnDisk)} : whoOnDisk;
  // 盘上的状态没有下发给界面的词表（那是服务端读路径装饰上去的）：不补上，邀请/授权表单会写着「词表未下发」——
  // 与 effectivePermissions 同一类由工具自己制造的假缺陷。用与服务端同一个函数，不另抄一份。
  real.runtime = {...(real.runtime || {}), ...consoleVocabularies(), auditLogCap: AUDIT_LOG_CAP};
  // 同 consoleVocabularies：runtime.mcp.toolCount 是【代码派生】的（产品每次读都由 ensureRuntimeCollections
  // 刷成 mcpToolNames.length），盘上存的是冻结那一刻的旧值 —— 曾经是手写常量 81，而目录里实际 85。
  // 本工具不跑 ensureRuntimeCollections，不补的话屏幕上就是那个旧的 81，会被当成产品少报了 4 个工具去查
  // （本轮就差点）。用与产品同一个目录 mcpToolNames 刷新，不另抄一份计数。
  if (real.runtime.mcp) real.runtime.mcp = {...real.runtime.mcp, toolCount: mcpToolNames.length};
  if (wantWho && who?.email !== wantWho) {
    console.log(`（要的是 ${wantWho}，真实状态里没有这个账号 —— 下面渲染的是 ${who?.email}）`);
  }
  console.log(`=== 视角：${who?.email}（${who?.accountType}；有效权限：${(who?.effectivePermissions || []).join("、") || "无"}）`);
  // 这里喂进去的是【完整状态】：服务端的 scopedStateForAccount 没有导出（导入 server.mjs 会把服务起起来），
  // 所以下面渲染出来的东西没经过按账号的可见性过滤。非系统账号在真实控制台上收到的会更少。
  // 不写这一句的话，两个方向都会误判：把"成员看到了别人的项目"当成越权缺陷（其实是工具没过滤），
  // 或者反过来以为这里能验出越权（越权由 doctor 的读泄漏用例守着，不是这里）。
  if (who?.accountType !== "system_admin") {
    // 光说"会更少"不够：逐页读的时候很容易把一份跨组织的清单当成产品的事实
    //（本轮就差点把组织管理员那屏的「项目一览 7 个 / 配额 项目 1/12」报成两个数打架，
    //  而那 7 个里大半根本不属于他的组织）。给个【下界】：按组织归属数得出来，
    //  不复制服务端那套授权判定（复制一份出来本身就是缺陷来源），所以只多不少地说"至少"。
    const myOrg = who?.organizationId || "org_default";
    const foreignProjects = (real.projects || []).filter((item) => (item.organizationId || "org_default") !== myOrg);
    const myProjectIds = new Set((real.projects || [])
      .filter((item) => (item.organizationId || "org_default") === myOrg).map((item) => item.id));
    const foreignGroups = (real.taskGroups || []).filter((item) => item.projectId && !myProjectIds.has(item.projectId));
    console.log("（注意：喂进去的是完整状态，未经服务端按账号过滤 —— 这一视角实际收到的会更少；"
      + `按组织归属数，这份输出里【至少】有 ${foreignProjects.length} 个项目、${foreignGroups.length} 个任务组`
      + `不属于 ${myOrg}，真实控制台不会给他。越权与否由 e2e 的读泄漏用例守，不看这里）`);
  }
  // 有几块内容【不在状态里】：它们由页面加载后另发请求取（执行事件走长轮询、待确认数走计数接口、
  // 评审/指令走各自的接口）。这个工具只喂状态、不发请求，所以那几块渲出来永远是「暂无数据」——
  // 与产品真的没有数据长得一模一样。不说这一句，读的人会去查一个不存在的缺陷，
  // 或者反过来以为"事件流是通的"（本轮就差点把执行事件流的空当成缺陷去查）。
  console.log("（这几块的数据不在状态里、要另发请求取，本工具不发 —— 它们显示的「暂无数据」是工具的空，"
    + "不是产品的空：实时事件流 / 最新执行事件 / 待人工确认数 / 评审与人工指令明细 / 组织成员与节点）\n");
  // 另一类假线索：有些字段是【服务端视图算出来的】，原始状态里根本没有。喂原始状态渲染时它们
  // 显示成 0/缺省，看着像"产品把它算错了"。实测差点当成缺陷去查：任务组页「角色数：0」，
  // 而真实状态里那个组有 7 个角色 —— 界面读的是视图字段 roleCount（视图会把 roles 剥掉换成计数）。
  // 这两件事的区别只有一句话：产品读的是视图，本工具喂的是原始状态。
  // 第三类假线索：本工具是【逐页渲染】的，不为每一页重新走 loadPage，而 lastError 是全局的 ——
  // 上一页失败的请求会把横幅带到下一页，于是出现「项目概览顶上挂着 /api/system/overview 的 404」
  // 这种搭配，横幅里"这一页有多旧"说的是当前页、"哪个请求失败了"说的却是上一页。
  // 产品里不会这样：切页会重新加载，成功就清掉 lastError。我为此查过一轮才确认是工具的锅。
  console.log("（横幅里的失败请求可能来自【上一页】：本工具逐页渲染、不重走 loadPage，而 lastError 是全局的；"
    + "产品里切页会重新加载并清掉它 —— 看到「本页很新 + 别的页的 404」这种搭配，那是工具的拼接）\n");
  const noticeOfDerivedFields = "（这些数是服务端视图算出来的，本工具喂的是原始状态 —— 它们显示成 0/缺省是工具的缺省，"
    + "不是产品算错了：任务组「角色数」(roleCount)、任务组里嵌的工作项条数(workItemCount/workItemsTruncated)、"
    + "任务拆解条数(itemCount)、按任务组的权限(taskGroupPermissions)、"
    + "技能源角色数(roleSkillCountBySource，它也决定「系统内置技能（共 N 个）」那个数)、"
    + "各表的「共 N+ 条」截断标记）";
  console.log(`${noticeOfDerivedFields}\n`);
  // 上面那句提醒是【手写的固定清单】，而手写的清单本身就是漏洞来源：将来投影里多算一个派生字段，
  // 它不会跟着更新，而屏幕上那个字段会安静地显示成 0 —— 勘察工具不报红，只是把错的东西摆给你看。
  // 所以从投影函数的源码里现取一遍，核这句话有没有漏。
  {
    const serverSource = fs.readFileSync(path.join(root, "apps/control-plane-ui/server.mjs"), "utf8");
    const at = serverSource.indexOf("function projectTaskGroupsForView(");
    const body = at < 0 ? "" : serverSource.slice(at, serverSource.indexOf("\n}\n", at));
    // 只认【真正被返回的那几个对象字面量】里的键。整份函数体里扫的话，
    // taskAnalysis.items / languagePolicy.languageTag 这类嵌套键会被当成任务组自己的字段（误报三个）。
    const returned = [
      body.slice(body.indexOf("const projected = {"), body.indexOf("\n    if (items.length")),
      ...[...body.matchAll(/return \{[\s\S]*?\};/gu)].map((m) => m[0])
    ].join("\n");
    const derived = [...new Set([...returned.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*): [a-z]/gu)].map((m) => m[1]))]
      .filter((key) => !(real.taskGroups || []).some((group) => group[key] !== undefined));
    if (at < 0) {
      console.log("（找不到 projectTaskGroupsForView —— 上面那句「派生字段」提醒已经无人核对，别全信它）\n");
    } else {
      const unmentioned = derived.filter((key) => !noticeOfDerivedFields.includes(key));
      if (unmentioned.length) {
        console.log(`（上面那句提醒【漏了】这几个同样是视图现算的字段：${unmentioned.join("、")}`
          + " —— 它们在这份输出里也会显示成 0/缺省，同样不是产品的值）\n");
      }
    }
  }
  // 还有一类是【服务端读取时注入的内存心跳】：盘上那份状态里恒为 null。
  // 拿 npm run init 出来的目录渲染时，系统设置页会显示「后台自治 已关闭」——
  // 而默认其实是 60 秒一拍（AIMAC_ORCHESTRATOR_INTERVAL_MS ?? 60000）。我为此查过一轮才确认。
  console.log("（「后台自治」那一行是服务端读取时注入的内存心跳（runtime.autonomousOrchestrator），"
    + "盘上的状态里恒为 null —— 本工具喂的是盘上那份，所以它总显示「已关闭」，那不是产品的默认值）\n");
  const documentRoot = el("div");
  const probe = loadConsole(documentRoot, {realI18n: true});
  // 【禁用的控件要标出来】。剥成纯文本之后，disabled 的按钮和能按的长得一模一样 ——
  // 读的人会把一屏"已经收起来了"的写按钮当成"摆着一个按不动的杠杆"去查（本轮差点就这么报了：
  // 只读成员的项目设置页上四个写按钮其实都带 disabled，产品是对的）。
  // 反过来更危险：真有一个该收而没收的按钮，在这份输出里也看不出来。
  const strip = (html) => String(html)
    .replace(/<(button|input|select|textarea)\b[^>]*\bdisabled\b[^>]*>/gu, (tag) => `${tag}〔不可用〕`)
    .replace(/<[^>]+>/gu, " ").replace(/&nbsp;/gu, " ")
    .split("\n").map((line) => line.replace(/\s+/gu, " ").trim()).filter(Boolean).join("\n");
  const project = (real.projects || [])[0];
  const taskGroup = (real.taskGroups || [])[0];
  console.log(`=== 真实状态：${(real.projects || []).length} 个项目、${(real.taskGroups || []).length} 个任务组\n`);
  // 明细卡此前一直传 null → 每份真实渲染都停在「正在加载任务组详情…」，明细从来没被读过。
  // 按 loadTaskGroupDetail 拼三份：progress（就是任务组记录本身那几个字段）、config（与服务端同一个 effectiveTaskGroupConfig）、房间消息。
  const realDetail = taskGroup ? {
    taskGroupId: taskGroup.id, loadFailed: false,
    progress: {taskGroupId: taskGroup.id, phase: taskGroup.phase, progress: taskGroup.progress, health: taskGroup.health, languagePolicy: taskGroup.languagePolicy,
      roles: taskGroup.roles, taskAnalysis: taskGroup.taskAnalysis || null, workItems: (taskGroup.workItems || []).slice(0, 20), workItemCount: (taskGroup.workItems || []).length,
      blockers: taskGroup.blockers, repositoryOutputs: (real.repositoryOutputs || []).filter((target) => target.taskGroupId === taskGroup.id)},
    config: effectiveTaskGroupConfig(real, taskGroup), configVersion: "survey",
    roomMessages: (real.roomMessages || []).filter((message) => message.roomId === `room_${taskGroup.id}`).slice(-50),
    roomMessageTotal: (real.roomMessages || []).filter((message) => message.roomId === `room_${taskGroup.id}`).length,
    configLoadError: null, roomLoadError: null, roomLoadDenied: false
  } : null;
  console.log("=== 任务组页 ===\n" + clip(strip(probe.renderTaskGroupsWith(real, who, project?.id, taskGroup?.id, realDetail)), renderChars && Math.max(renderChars, 2400)));
  console.log("\n=== 监控页 ===\n" + clip(strip(probe.renderMonitorWith(real, who, project?.id)), renderChars && Math.max(renderChars, 1200)));
  // 其余各页走通用入口。渲染不出来（抛异常）本身就是发现：真实数据里有夹具没有的组合。
  // 页 id 必须是真的存在的那几个。第一版写的是 orgs / agents / rules —— 产品对认不出的页 id
  // 会静默回落到默认页，于是这三页渲染出来全是【系统概览】，而我在读它们时以为读的是组织管理。
  // 勘察工具骗自己比门骗自己更难发现：它不报红，只是把错的东西摆给你看。
  // 有几页的数据【不在 state 里】，各自另走接口取数（组织列表、成员、智能体、系统概览、项目配置）。
  // 只喂 state 直接渲染，它们一律显示"暂无数据" —— 而那是【工具的空】，不是产品的空态。
  // 实测这条假线索骗过我一次：系统管理员的「组织列表」显示暂无数据，而真实状态里有组织。
  // 办法：走真实 loadPage，state 类请求喂真状态；其余接口【不编数据】（编出来的是假故障），
  // 而是记下来、在那一页下面明说"这里的空白是勘察桩答不了，不是产品的空"。
  // 页面清单要与 app.js 里【登记过的那 15 页】对齐。原先这里只列了 8 页 + 上面两页 ——
  // 组织管理员那四页（概览/项目/成员/智能体）从来没有被读过一次，而"没读过"与"读过没问题"
  // 在这份输出上长得一模一样。下面那条自证会把漏掉的页点名。
  const SURVEY_PAGES = ["proj-overview", "proj-members", "review", "directives", "sys-orgs", "sys-accounts",
    "sys-settings", "sys-overview", "proj-agents", "proj-settings",
    "org-overview", "org-projects", "org-members", "org-agents"];
  {
    const registered = [...readConsoleNavigationSource().matchAll(/^\s*"([a-z][a-z0-9-]+)":\s*\["/gmu)].map((hit) => hit[1]);
    // tg 与 monitor 走上面两个专用入口（要额外传项目/任务组），不在这个通用循环里。
    const covered = new Set([...SURVEY_PAGES, "tg", "monitor"]);
    const missed = [...new Set(registered)].filter((page) => !covered.has(page));
    if (missed.length) {
      console.log(`（注意：app.js 登记了这些页而本工具没渲染 —— ${missed.join("、")}；`
        + "它们在这份输出里既不出现也不报错，等于从来没被读过）");
    }
  }
  // 页 id → 标题（取自 app.js 的 PAGE_META）：下面用它核对"渲染出来的是不是要读的那一页"。
  const pageTitles = Object.fromEntries([...readConsoleNavigationSource()
    .matchAll(/^\s*"([a-z][a-z0-9-]+)":\s*\["([^"]+)"/gmu)].map((hit) => [hit[1], hit[2]]));
  if (Object.keys(pageTitles).length < 10) {
    throw new Error(`只提取到 ${Object.keys(pageTitles).length} 个页标题 —— 提取脱节，下面那条"读的是不是这一页"的核对会空转`);
  }

  for (const page of SURVEY_PAGES) {
    const unserved = new Set();
    const fetchStub = async (path) => {
      const url = String(path);
      // headers 必须给：api() 会读 response.headers.get("etag")。第一版没给，
      // 于是每一页横幅上都挂着一句 "Cannot read properties of undefined (reading 'get')" ——
      // 一个由勘察工具自己制造的假故障，看着却像产品缺陷。
      const headers = {get: () => null};
      const ok = (payload) => ({ok: true, status: 200, headers, json: async () => payload});
      if (url.includes("/api/state")) return ok(real);
      if (url.includes("/api/orgs")) return ok({organizations: real.organizations || []});
      // 项目设置页从配置接口取规则/仓库/角色行；桩不答它，这一页就只剩一条「暂时无法读取」横幅，
      // 规则编辑器与角色行从来没在这份输出里出现过。config 用与服务端同一个 effectiveProjectConfig；
      // configVersion 只在保存时当乐观锁用，读文本不需要真值。
      const projectConfig = url.match(/\/api\/projects\/([^/?]+)\/config(?:\?|$)/u);
      if (projectConfig) {
        const project = (real.projects || []).find((item) => item.id === decodeURIComponent(projectConfig[1]));
        if (project) return ok({projectId: project.id, config: effectiveProjectConfig(project), configVersion: "survey"});
      }
      // 组织管理员四页取成员与节点：形状照服务端两条 GET（{orgId, members} / {orgId, agentRuntimeNodes}）。
      if (/\/api\/org\/members(?:\?|$)/u.test(url)) {
        const orgId = who?.organizationId;
        return ok({orgId, members: (real.accounts || []).filter((item) => item.organizationId === orgId)});
      }
      if (/\/api\/org\/agents(?:\?|$)/u.test(url)) {
        const orgId = who?.organizationId;
        const orgProjects = new Set((real.projects || []).filter((item) => item.organizationId === orgId).map((item) => item.id));
        return ok({orgId, agentRuntimeNodes: (real.agentRuntimeNodes || []).filter((node) => orgProjects.has(node.projectId))});
      }
      // 人工指令页按任务组取指令流水；桩不答，这一页就挂着一条「从来没有加载成功过」横幅。形状照服务端那条路由。
      const directives = url.match(/\/api\/task-groups\/([^/?]+)\/human-directives(?:\?|$)/u);
      if (directives) {
        const taskGroupId = decodeURIComponent(directives[1]);
        return ok({humanDirectives: (real.humanDirectives || []).filter((item) => item.taskGroupId === taskGroupId)});
      }
      unserved.add(url.split("?")[0]);
      return {ok: false, status: 404, statusText: "Not Found", headers,
        json: async () => ({error: "probe_stub_has_no_answer"})};
    };
    try {
      await probe.loadPageWith(real, who, project?.id, page, fetchStub);
      const text = strip(documentRoot.innerHTML || documentRoot.textContent || "");
      // 【渲染出来的必须就是要读的那一页】。控制台在 render() 里会把「当前身份菜单里没有的页」
      // 静默改写成默认页（app.js: !MENUS[perspective].some(...) → defaultPageFor）。于是用系统
      // 管理员视角读 org-* 那四页时，屏幕上其实是【系统概览】，而这份输出照旧把它印在
      // "=== org-members ===" 标题下面 —— 读的人会以为自己读过了成员管理。
      // 勘察工具骗自己比门骗自己更难发现：它不报红，只是把错的东西摆给你看。
      // 判据问的是【控制台实际停在哪一页】，不是从文本里猜标题：页头前面还有 logo 与整条导航，
      // 按标题猜会把 8 页都误判成"没读成"（第一版就是这样）。
      // 【这一段没有登记变异】：它只在 AIMAC_RENDER_REAL 这个按需勘察模式下跑，门链里没有任何
      // 一道会执行到它 —— 把它改坏，没有东西会红。登记一条验不出判别力的变异比不登记更坏，
      // 所以这里如实写明：它是勘察工具的自证，不是一道门。
      const landedOn = probe.currentPage();
      if (landedOn !== page) {
        console.log(`\n=== ${page} ===\n（没读成：控制台实际停在「${pageTitles[landedOn] || landedOn}」——`
          + "当前身份的菜单里没有这一页，render() 会把它静默改写成默认页。"
          + "换个视角再读：AIMAC_RENDER_AS=<该身份的邮箱>）");
        continue;
      }
      console.log(`\n=== ${page} ===\n` + (clip(text) || "（空）"));
      // 【这一屏上有哪些能按的动作】。读页面时最容易漏的一类问题是"摆着一个按不动的杠杆"，
      // 而剥成文本之后按钮与普通文字长得一样。AIMAC_RENDER_BUTTONS=1 把按钮单列出来，
      // 并标明是不是禁用的 —— 换个身份跑一遍，就能看出哪些写动作对这个人是敞开的。
      if (process.env.AIMAC_RENDER_BUTTONS) {
        const buttons = [...String(documentRoot.innerHTML || "").matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gu)]
          .map(([, attrs, label]) => ({
            label: label.replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim().slice(0, 24),
            disabled: /\bdisabled\b/u.test(attrs)
          }))
          .filter((item) => item.label);
        const active = buttons.filter((item) => !item.disabled).map((item) => item.label);
        const off = buttons.filter((item) => item.disabled).map((item) => item.label);
        console.log(`  ↑ 可按的动作 ${active.length} 个：${active.join("、") || "（无）"}`
          + (off.length ? `\n  ↑ 已禁用 ${off.length} 个：${off.join("、")}` : ""));
      }
      if (unserved.size) {
        console.log(`  ↑ 这一页还向 ${[...unserved].join("、")} 取数，勘察桩没有答案 ——`
          + " 上面与之相关的空白是工具的限制，不是产品的空态");
      }
    } catch (error) {
      console.log(`\n=== ${page} === 渲染抛异常：${String(error?.message || error).slice(0, 160)}`);
    }
  }
  process.exit(0);
}

/* ---------------- 断言 ---------------- */

const failures = [];
// 漏译扫描要用【这道门已经在用的】那几份状态，而不是我另编一份 —— 编出来的夹具只会覆盖
// 我碰巧想到的那些枚举值。各段在构造好自己的状态之后往这里登记一条。
const i18nScanStates = [];
let checkCount = 0;
function check(name, condition, detail) {
  checkCount += 1;
  // 参数自检：本门的顺序与另外三道门【相反】（那三道是 ok 在前）。写反时布尔落进 name、
  // 字符串落进 condition，非空字符串恒真 —— 断言永远通过，门绿、变异也绿，等于没写。
  // 真发生过一次，四条断言一起空转，只有"变异跑不出红"才暴露。
  if (typeof name !== "string" || typeof condition !== "boolean") {
    throw new Error(`check(name, condition, detail) 参数错位：收到 name=${typeof name}、condition=${typeof condition}`
      + "（本门的顺序是【名称在前、条件在后】）");
  }
  if (!condition) failures.push(`${name}: ${detail}`);
}

// 【暂停与恢复按当前状态二选一】。两个按钮一直摆着的话，总有一个按了什么都不会发生：
// 对已经停下来的组点「暂停」、对在跑的组点「恢复」，回执都是 200 而屏幕一点没变。
// 再加一条：人停下来的（停因 human_directive*）后端只让真人恢复 —— 机器主体不该看见那个按钮，
// 否则按下去只拿回一句 403，人不知道自己为什么点不动。
{
  const probe = loadConsole(el("div"), {realI18n: true});
  const paused = {id: "tg_p", goalExecutionStatus: "active_paused_by_control"};
  const running = {id: "tg_r", goalExecutionStatus: "active"};
  const humanStopped = {id: "tg_h", goalExecutionStatus: "active_paused_by_freeze",
    pauseReason: "human_directive_cancel"};
  const canResume = (taskGroup, accountType) => probe.canResumeTaskGroupAs
    ? probe.canResumeTaskGroupAs(taskGroup, accountType) : null;
  check("人停下来的任务组：真人可以恢复", canResume(humanStopped, "org_admin") === true, "真人被挡住了");
  check("人停下来的任务组：机器主体不许恢复",
    canResume(humanStopped, "service_account") === false,
    "机器主体看得到恢复按钮 —— 按下去只会拿回 403，而「取消归人」那条也就等于没有");
  check("不是人停下来的组，机器主体照常可以恢复（别把正常路径一起挡死）",
    canResume(paused, "service_account") === true, "把普通暂停也一起锁上了");
  check("在跑的组不该显示「恢复」（按了什么都不会发生）",
    !String(running.goalExecutionStatus).startsWith("active_paused"), "状态判断本身错了");
}

// 【已归档的项目不许出现在「签发入网令牌」的目标里】。后端已经拒（project_archived）——
// 界面还摆着它，人按指引选一个，回来的是一句拒绝：那不是"多一个选项"，是把人往死路上引。
// 只藏选项不锁门也不行（改个请求就绕过去），所以两边都做；这条验的是界面那半。
{
  const probe = loadConsole(el("div"), {realI18n: true});
  const projects = [
    {id: "prj_live", name: "在用项目", status: "active"},
    {id: "prj_gone", name: "已归档项目", status: "archived"}
  ];
  const targets = probe.joinTokenTargetProjects
    ? probe.joinTokenTargetProjects({projects}).map((project) => project.id) : null;
  check("签发入网令牌的目标里不许有已归档的项目",
    Array.isArray(targets) && !targets.includes("prj_gone"),
    `实得 ${JSON.stringify(targets)} —— 选了它只会拿回一句 project_archived`);
  check("在用的项目仍要留在目标里（别把正常路径一起收掉）",
    Array.isArray(targets) && targets.includes("prj_live"), `实得 ${JSON.stringify(targets)}`);
}

// 【授权角色：下拉里说的词与列表里显示的词必须是同一个】。此前 reviewer 这个键被两个对象共用：
// 执行角色那边是「评审员」（agent 干活的角色），而授权下拉写的是「评审人」——
// 于是"按指引去授评审人"，授完在项目列表里看到的是"评审员"，人会怀疑自己授错了角色。
// 判据不比对字面量表，而是问【同一个角色 id 在两处渲染出来的词一样不一样】。
{
  const probe = loadConsole(el("div"), {realI18n: true});
  const appText = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8");
  const dropdown = appText.slice(appText.indexOf('decisionSelect("role", ['));
  const options = [...dropdown.slice(0, dropdown.indexOf('], "请选择项目角色')).matchAll(/\["([a-z_]+)",\s*`?([^"`\]]*)/gu)]
    .map((hit) => [hit[1], hit[2]]);
  check("授权角色下拉不是空的（空了下面那条就成了永远为真）", options.length >= 4, `实得 ${options.length} 项`);
  // 不在这张表里的角色要回落到全局词表，而不是把角色 id 原样摆到屏幕上。
  // 用一个【确实不在新表、但全局词表里有】的角色来验，否则这条分支永远走不到（变异实测）。
  const fallback = probe.grantRoleLabel ? probe.grantRoleLabel("qa") : null;
  check("授权角色词表里没有的角色要回落到全局中文，不许掉成英文 id",
    Boolean(fallback) && fallback !== "qa" && !/^[a-z_]+$/u.test(fallback), `实得「${fallback}」`);
  for (const [roleId] of options) {
    const listed = probe.grantRoleLabel ? probe.grantRoleLabel(roleId) : null;
    check(`授权角色「${roleId}」在下拉与列表里必须是同一个词`,
      Boolean(listed) && dropdown.includes(listed),
      `列表里渲染成「${listed}」，而下拉里找不到这个词 —— 人按指引授的和事后看到的对不上`);
  }
}

// 勘察工具自己的截断必须自报。它是用来找「静默截断」这类缺陷的，而它每页只打前 900 字、
// 一声不响 —— 实测据此差点得出「这张卡缺少『你在这个组上没权限』那句提示」的相反结论，
// 而那句话就在被砍掉的部分里。勘察工具不报红，只是把错的东西摆给你看，所以它的诚实要单独钉。
check("勘察工具截断时必须自报（否则会让人得出相反结论）",
  clip("字".repeat(50), 10).includes("只打了前 10 字") && clip("字".repeat(50), 10).includes("共 50 字"),
  clip("字".repeat(50), 10).slice(0, 80));
check("没超长时不许硬塞截断提示（那会把完整的一页说成不完整）",
  clip("短文本", 10) === "短文本" && clip("字".repeat(50), 0) === "字".repeat(50),
  clip("短文本", 10));

// 场景：人在「打回并要求重做」表单里写了一大段理由，提交时撞上 expectedRound 409
// （并发下的正常回答，不是故障）。整页重渲染之后，那段理由必须还在。

// 全新部署的第一步：以系统管理员登录、打开项目概览，此时一个项目都没有。
// 空态原先一律说"请联系组织管理员分配" —— 而系统管理员和组织管理员正是能建项目的人，
// 把他们支去找别人是个死胡同，且出现在人第一次用这套系统的那一刻。
// 空态必须按【这个人能做什么】说话，所以三种视角逐一验，不是验"有没有提示"。
{
  const emptyRoot = el("div");
  // 出错那一刻对人说的话：拿【服务端真的会回的载荷】直接调拼装函数。
  // 这段原先埋在 api() 的网络失败分支里，断言够不着 —— 于是九十行报文一条都没验过。
  {
    // 真词表：这段话里要不要露出英文码，取决于词表有没有那个键。
    const probe = loadConsole(el("div"), {realI18n: true});
    // 【今天新加的三个拒绝码，提示要点名它们各自算好的东西】：拼错的角色/权限是哪几个、可用的是哪些。
    // 只显示一个码等于把人打回去猜；服务端每一种都算好了（unknownRoles / unknownPermissions / supported）。
    for (const [label, payload, mustName] of [
      ["配置默认角色没登记", {error: "config_default_role_not_registered", unknownOwnerRoles: ["reviwer"], supported: ["reviewer", "qa"]}, ["reviwer", "reviewer"]],
      ["智能体角色没登记", {error: "agent_role_not_registered", unknownRoles: ["reviwer"], supported: ["reviewer", "qa"]}, ["reviwer", "reviewer"]],
      ["账号角色不在词表", {error: "account_role_unknown", unknownRoles: ["project_member"], supported: ["member", "viewer"]}, ["project_member", "member"]],
      ["权限不在词表", {error: "permission_unknown", unknownPermissions: ["project:veiw"], supported: ["project:view"]}, ["project:veiw", "project:view"]],
      ["执行角色未登记", {error: "task_group_role_not_registered", unknownOwnerRoles: ["reviewr"], supported: ["reviewer"]}, ["reviewr", "reviewer", "执行角色"]]
    ]) {
      const hint = probe.requestFailureHint(payload);
      if (process.env.AIMAC_PRINT_HINTS) console.log(`[hint] ${label}: ${hint}`);
      check(`拒绝提示「${label}」要点名拼错的与可用的`, mustName.every((word) => String(hint).includes(word)),
        `提示里少了 ${mustName.filter((word) => !String(hint).includes(word)).join("、")}：${String(hint).slice(0, 160)}`);
    }
    const groupPermHint = probe.requestFailureHint({error: "forbidden", requiredPermission: "task_group:review",
      resourceScope: {resourceType: "task_group", resourceId: "tg1"}});
    check("任务组权限拒绝提示要直接指到项目成员权限页",
      /项目管理」→「成员权限」→「项目成员授权/u.test(groupPermHint)
        && /写在账号上的直接权限不生效/u.test(groupPermHint),
      `任务组权限拒绝仍只给面板名，用户不知道入口在哪里：${String(groupPermHint).slice(0, 200)}`);
    // requestFailureHint 产出【纯文本】，最终嵌进 Error.message，两个显示口（toast 的 esc(message)、
    // 顶部横幅的 esc(lastError)）都会整体转义一次。若函数内部再 esc 自由文本字段（decidedOption、账号名），
    // 就是双重转义：含 < & 的值会显示成 &lt; 字面乱码。这条钉住「函数内不得二次转义」——
    // 断言产出里保留原始特殊字符、且不含 HTML 实体（把内部任一 esc 加回来即红）。
    {
      const conflictHint = probe.requestFailureHint(
        {decidedBy: "lead@local", decidedAction: "finalize", decidedOption: "<b>选项 & 值</b>"});
      check("确认单冲突提示的自由文本须为纯文本（转义交给 sink，函数内不得二次转义）",
        conflictHint.includes("<b>选项 & 值</b>") && !conflictHint.includes("&lt;") && !conflictHint.includes("&amp;"),
        `decidedOption 被双重转义或漏掉：${String(conflictHint).slice(0, 200)}`);
    }
    // 【成员创建表单提交的正文要与勾选一致】。这是全站第一条走到 submit 处理器的用例：此前门只模拟点击与渲染，
    // 每个表单真正发出去的正文一条都没被钉过。权限按 input[name='perm']:checked 收 —— 收错（把没勾的也收进去）
    // 就是给人多发权限。
    {
      const recorded = [];
      const previousFetch = globalThis.fetch;
      probe.setFetch(async (url, init = {}) => {
        recorded.push({url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null});
        return {ok: true, status: 201, headers: {get: () => null}, json: async () => ({account: {accountId: "acct_new", email: "new@local"}, accountToken: "aimac_account_probe"})};
      });
      try {
        const form = el("form", {dataset: {form: "member-create"}}, [
          el("input", {name: "displayName", value: "新成员"}),
          el("input", {name: "email", value: "new@local"}),
          el("select", {name: "defaultProjectId", value: "p1"}),
          el("input", {name: "perm", type: "checkbox", value: "project:view", checked: true}),
          el("input", {name: "perm", type: "checkbox", value: "project:grant", checked: false}),
          el("button", {type: "submit"})
        ]);
        await probe.submit({target: form, submitter: form.children[5], preventDefault: () => {}});
        const post = recorded.find((item) => item.method === "POST" && /\/api\/org\/members$/u.test(item.url));
        if (!post) {
          check("成员创建提交要真的发出 POST /api/org/members", false, `没记录到提交（记录：${JSON.stringify(recorded).slice(0, 160)}）—— 下面那条什么也没验`);
        } else {
          check("成员创建提交的权限要且只要勾选的那些",
            JSON.stringify(post.body.permissions) === JSON.stringify(["project:view"]) && post.body.defaultProjectId === "p1",
            `发出去的是 ${JSON.stringify(post.body.permissions)}／defaultProjectId=${post.body.defaultProjectId} —— 没勾的权限也发了，等于替人多发权限`);
        }
      } finally {
        probe.setFetch(previousFetch);
      }
    }
    // 【规则编辑器保存时只发本层改过的规则】。继承来的、没动过的规则不能再发一遍（发了＝在本层复制一份覆盖，
    // 从此上层再改它这里不跟）；改过的必须发。这条走真实的 submit 处理器 + collectRuleFragments。
    {
      const recorded = [];
      const previousFetch = globalThis.fetch;
      probe.setFetch(async (url, init = {}) => {
        recorded.push({url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null});
        return {ok: true, status: 200, headers: {get: () => null}, json: async () => ({ok: true})};
      });
      const ruleRow = (id, title, content, {dirty}) => el("div", {dataset: {ruleRow: "", ruleId: id, ruleCategory: "business", ruleSource: "default",
        origTitle: title, origContent: content, origEnabled: "1"}}, [
        el("input", {name: "ruleTitle", value: title}),
        el("input", {name: "ruleEnabled", type: "checkbox", checked: true}),
        el("textarea", {name: "ruleContent", value: dirty ? `${content}（本层改写）` : content})
      ]);
      try {
        const list = el("div", {dataset: {cfgList: "rules-probe"}}, [
          ruleRow("rule_untouched", "没动过的继承规则", "原文", {dirty: false}),
          ruleRow("rule_dirty", "改过的继承规则", "原文", {dirty: true})
        ]);
        const form = el("form", {dataset: {form: "project-rules", list: "rules-probe", category: "business", project: "p1"}}, [list, el("button", {type: "submit"})]);
        await probe.submit({target: form, submitter: form.children[1], preventDefault: () => {}});
        const post = recorded.find((item) => item.method === "POST" && /\/api\/projects\/p1\/config$/u.test(item.url));
        const sent = (post?.body?.businessRules || []).map((item) => item.ruleId);
        if (!post) {
          check("规则编辑器提交要真的发出 POST /api/projects/:id/config", false, `没记录到提交（${JSON.stringify(recorded).slice(0, 160)}）—— 下面那条什么也没验`);
        } else {
          check("规则编辑器只发本层改过的规则（没动过的继承规则不再发一遍）",
            sent.includes("rule_dirty") && !sent.includes("rule_untouched"),
            `发出去的是 ${JSON.stringify(sent)} —— 没动过的继承规则被复制到本层，从此上层再改它这里不跟`);
        }
      } finally {
        probe.setFetch(previousFetch);
      }
    }
    // 【批准/拒绝双按钮表单：点哪个就发哪个】。status 由点下去的那个按钮（event.submitter）带上，
    // 缺省是 rejected（安全方向）—— 提交器丢了，每一次批准都会变成拒绝，而人看到的回执是"已处理"。
    {
      const recorded = [];
      const previousFetch = globalThis.fetch;
      probe.setFetch(async (url, init = {}) => {
        recorded.push({url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null});
        return {ok: true, status: 200, headers: {get: () => null}, json: async () => ({ok: true})};
      });
      try {
        const mkForm = () => el("form", {dataset: {form: "perm-resolve", request: "perm_1"}}, [
          el("button", {type: "submit", name: "status", value: "approved"}),
          el("button", {type: "submit", name: "status", value: "rejected"})
        ]);
        const approveForm = mkForm();
        await probe.submit({target: approveForm, submitter: approveForm.children[0], preventDefault: () => {}});
        const rejectForm = mkForm();
        await probe.submit({target: rejectForm, submitter: rejectForm.children[1], preventDefault: () => {}});
        const posts = recorded.filter((item) => item.method === "POST" && /permission-requests\/perm_1\/resolve$/u.test(item.url)).map((item) => item.body?.status);
        if (posts.length !== 2) {
          check("批准/拒绝表单要真的各发出一次处置", false, `记录到 ${posts.length} 次（${JSON.stringify(recorded).slice(0, 160)}）—— 下面那条什么也没验`);
        } else {
          check("点「批准」发 approved、点「拒绝」发 rejected（提交器丢了每次批准都会变成拒绝）",
            posts[0] === "approved" && posts[1] === "rejected",
            `发出去的是 ${JSON.stringify(posts)} —— 点的按钮没带进正文，缺省把批准变成了拒绝`);
        }
        // perm-resolve 的孤儿回退同方向（全类只有这两处 status 回退）：无提交器必须落 rejected。
        const orphanPerm = mkForm();
        await probe.submit({target: orphanPerm, submitter: null, preventDefault: () => {}});
        const orphanPermPost = recorded.filter((item) => item.method === "POST" && /permission-requests\/perm_1\/resolve$/u.test(item.url)).map((item) => item.body?.status).at(-1);
        check("授权处置丢了提交器时缺省必须是 rejected",
          orphanPermPost === "rejected",
          `无提交器那次发出的是 ${JSON.stringify(orphanPermPost)} —— 回退方向被翻成了放行`);
        // 【机器审批的回退方向必须是拒绝】。approval-resolve 的正文是 data.status || "rejected"：
        // submitter 丢了（或将来有人把回退写成 approved）时，缺省绝不能是放行 —— 这是机器高危动作的
        // 审批闸门，缺省=批准 就是「缺省=有利结果」的原型。此前这张表单零探针，翻转回退方向没有任何门会红。
        const mkApproval = () => el("form", {dataset: {form: "approval-resolve", request: "apr_1"}}, [
          el("button", {type: "submit", name: "status", value: "approved"}),
          el("button", {type: "submit", name: "status", value: "rejected"})
        ]);
        const orphanApproval = mkApproval();
        await probe.submit({target: orphanApproval, submitter: null, preventDefault: () => {}});
        const approveApproval = mkApproval();
        await probe.submit({target: approveApproval, submitter: approveApproval.children[0], preventDefault: () => {}});
        const approvalPosts = recorded.filter((item) => item.method === "POST" && /approval-requests\/apr_1\/resolve$/u.test(item.url)).map((item) => item.body?.status);
        if (approvalPosts.length !== 2) {
          check("审批表单要发出两次处置（无提交器一次、批准一次）", false, `记录到 ${approvalPosts.length} 次 —— 下面那条什么也没验`);
        } else {
          check("审批表单丢了提交器时缺省必须是 rejected（缺省放行＝机器高危动作自动过闸）",
            approvalPosts[0] === "rejected" && approvalPosts[1] === "approved",
            `发出去的是 ${JSON.stringify(approvalPosts)} —— 无提交器那次不是 rejected：回退方向被翻成了放行`);
        }
      } finally {
        probe.setFetch(previousFetch);
      }
    }
    // 【项目配置保存要带并发令牌】。expectedConfigVersion 是乐观并发的凭据：不带它，两个管理员各改一处、后保存的会把前一个的改动整个覆盖，谁都不会被告知。
    {
      const recorded = [];
      const previousFetch = globalThis.fetch;
      probe.setFetch(async (url, init = {}) => {
        recorded.push({url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null});
        return {ok: true, status: 200, headers: {get: () => null}, json: async () => ({ok: true, configVersion: "cv_8"})};
      });
      try {
        probe.setProjConfigVersion("cv_7");
        const repoRow = el("div", {dataset: {cfgKind: "repo"}}, [
          el("input", {name: "repoId", value: "repo_a"}), el("input", {name: "repoBranch", value: "main"}),
          el("select", {name: "repoCredentialMode", value: "api_key"}, []), el("input", {name: "repoApiKey", value: "secret://a"})
        ]);
        const form = el("form", {dataset: {form: "project-config", project: "p1"}}, [repoRow, el("button", {type: "submit"})]);
        await probe.submit({target: form, submitter: form.children[1], preventDefault: () => {}});
        const post = recorded.find((item) => item.method === "POST" && /\/api\/projects\/p1\/config$/u.test(item.url));
        if (!post) {
          check("项目配置保存要真的发出 POST", false, `没记录到提交（${JSON.stringify(recorded).slice(0, 160)}）—— 下面那条什么也没验`);
        } else {
          check("项目配置保存要带 expectedConfigVersion（不带＝两个管理员互相覆盖而不自知）",
            post.body.expectedConfigVersion === "cv_7" && (post.body.repositories || []).length === 1,
            `发出去的 expectedConfigVersion=${JSON.stringify(post.body.expectedConfigVersion)}、repositories=${(post.body.repositories || []).length} 条`);
        }
      } finally {
        probe.setProjConfigVersion(null);
        probe.setFetch(previousFetch);
      }
    }
    // 【人工定稿表单：action 只能来自点下去的按钮，认不出就拒，不缺省成 finalize】。定稿是整套闸门里最重、
    // 不可逆的一步；提交器丢了就当 finalize，等于替人做了最重的决定（确认框会问"确认定稿"，而人点的可能是打回）。
    {
      const recorded = [];
      const toasts = [];
      const previousFetch = globalThis.fetch;
      probe.setFetch(async (url, init = {}) => {
        recorded.push({url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null});
        return {ok: true, status: 200, headers: {get: () => null}, json: async () => ({ok: true})};
      });
      probe.captureToastKind("error", (message) => toasts.push(String(message)));
      const mkForm = () => el("form", {dataset: {form: "hcr-decide", request: "hcr_1", round: "2"}}, [
        el("input", {name: "selectedOptionId", type: "radio", value: "opt_a", checked: true}),
        el("textarea", {name: "inputText", value: "我的意见"}),
        el("button", {type: "submit", name: "action", value: "revise"}),
        el("button", {type: "submit", name: "action", value: "finalize"}),
        el("button", {type: "submit", name: "action", value: "reject"})
      ]);
      try {
        const reviseForm = mkForm();
        await probe.submit({target: reviseForm, submitter: reviseForm.children[2], preventDefault: () => {}});
        const revisePost = recorded.find((item) => item.method === "POST" && /human-confirmations\/hcr_1\/decide$/u.test(item.url));
        check("定稿表单点「提交修改意见」发 revise 且带本轮 expectedRound",
          revisePost?.body?.action === "revise" && revisePost?.body?.expectedRound === 2 && revisePost?.body?.selectedOptionId === "opt_a",
          `发出去的是 ${JSON.stringify(revisePost?.body)}`);
        recorded.length = 0; toasts.length = 0;
        const orphanForm = mkForm();
        // 没有提交器：修好的代码当场拒（错误 toast）；缺省成 finalize 的代码会去等确认框（桩里永远不回来），所以加个超时。
        await Promise.race([probe.submit({target: orphanForm, submitter: null, preventDefault: () => {}}), new Promise((resolve) => setTimeout(resolve, 150))]);
        const posted = recorded.some((item) => item.method === "POST");
        check("定稿表单没有提交器时要拒绝并说明用按钮提交（不许缺省成定稿）",
          !posted && toasts.some((message) => /按钮/u.test(message)),
          posted ? `没有提交器居然发出了 ${JSON.stringify(recorded[0]?.body)}` : `没拒绝：没有说明用按钮提交的提示（toast：${JSON.stringify(toasts).slice(0, 120)}）—— 它把缺省当成了定稿去走确认框，人点的可能是打回`);
      } finally {
        probe.setFetch(previousFetch);
      }
    }
    // 【发现项处置：处置类别/状态空着就拒，不缺省成 resolved + fixed_verified】。两个下拉是 required，
    // 但处理器原先仍有缺省 —— 缺省恰是最重的判断，绕过 required 的提交会替人做了它。
    {
      const recorded = [];
      const toasts = [];
      const previousFetch = globalThis.fetch;
      probe.setFetch(async (url, init = {}) => {
        recorded.push({url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null});
        return {ok: true, status: 200, headers: {get: () => null}, json: async () => ({ok: true})};
      });
      probe.captureToastKind("error", (message) => toasts.push(String(message)));
      const mkForm = (cls, status) => el("form", {dataset: {form: "finding-resolve", request: "finding_1"}}, [
        el("select", {name: "dispositionClass", value: cls}),
        el("select", {name: "status", value: status}),
        el("input", {name: "evidenceRefs", value: "evidence:probe"}),
        el("button", {type: "submit"})
      ]);
      try {
        const emptyForm = mkForm("", "");
        await probe.submit({target: emptyForm, submitter: emptyForm.children[3], preventDefault: () => {}});
        const postedEmpty = recorded.some((item) => item.method === "POST");
        check("发现项处置空着类别/状态要拒（不缺省成最重的 resolved + fixed_verified）",
          !postedEmpty && toasts.some((message) => /处置类别/u.test(message)),
          postedEmpty ? `空着也发出了 ${JSON.stringify(recorded[0]?.body)} —— 替人做了最重的判断` : `没拒（toast：${JSON.stringify(toasts).slice(0, 120)}）`);
        recorded.length = 0;
        const chosen = mkForm("not_applicable", "dismissed");
        await probe.submit({target: chosen, submitter: chosen.children[3], preventDefault: () => {}});
        const post = recorded.find((item) => item.method === "POST" && /findings\/finding_1\/resolve$/u.test(item.url));
        check("发现项处置发出的是人选的类别与状态", post?.body?.dispositionClass === "not_applicable" && post?.body?.status === "dismissed",
          `发出去的是 ${JSON.stringify(post?.body)}`);
      } finally {
        probe.setFetch(previousFetch);
      }
    }
    // 【三个收尾/处置表单：status 空着就拒，不缺省成肯定的那一项】。下拉里都有「驳回」，缺省却分别是
    // 激活为全局规范 / 视为已完成评审 / 视为已消费 —— 空着提交等于替人做了最重的判断。
    for (const [kind, route, heavy] of [
      ["shared-definition-resolve", /shared-definition-contracts\/req_1\/resolve$/u, "active"],
      ["review-plan-resolve", /review-plans\/req_1\/resolve$/u, "closed"],
      ["review-bundle-resolve", /review-bundles\/req_1\/resolve$/u, "consumed"],
      // 后补的两张：升级候选缺省「不予处理」、规则来源缺省「仅作参考」（终态）。
      ["upgrade-candidate-resolve", /system-upgrade-candidates\/req_1\/resolve$/u, "dismissed"],
      ["rule-source-settle", /rule-source-resolutions\/req_1\/settle$/u, "reference_only"]
    ]) {
      const recorded = [];
      const toasts = [];
      const previousFetch = globalThis.fetch;
      probe.setFetch(async (url, init = {}) => {
        recorded.push({url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null});
        return {ok: true, status: 200, headers: {get: () => null}, json: async () => ({ok: true})};
      });
      probe.captureToastKind("error", (message) => toasts.push(String(message)));
      const mkForm = (status) => el("form", {dataset: {form: kind, request: "req_1"}}, [
        el("select", {name: "status", value: status}),
        el("input", {name: "justification", value: "探针理由"}),
        el("button", {type: "submit"})
      ]);
      try {
        const emptyForm = mkForm("");
        await probe.submit({target: emptyForm, submitter: emptyForm.children[2], preventDefault: () => {}});
        const postedEmpty = recorded.find((item) => item.method === "POST" && route.test(item.url));
        check(`${kind}：status 空着要拒，不缺省成 ${heavy}`,
          !postedEmpty && toasts.some((message) => /请选择/u.test(message)),
          postedEmpty ? `空着也发出了 ${JSON.stringify(postedEmpty.body)} —— 替人做了最重的判断` : `没拒（toast：${JSON.stringify(toasts).slice(0, 100)}）`);
        recorded.length = 0;
        const rejectForm = mkForm("rejected");
        await probe.submit({target: rejectForm, submitter: rejectForm.children[2], preventDefault: () => {}});
        const post = recorded.find((item) => item.method === "POST" && route.test(item.url));
        check(`${kind}：选「驳回」发的就是 rejected`, post?.body?.status === "rejected", `发出去的是 ${JSON.stringify(post?.body)}`);
      } finally {
        probe.setFetch(previousFetch);
      }
    }
    // 【配额留空就不发那一项】。清空的输入框 Number("") 是 0：改配额会被告知「你填了 0」，建组织被钳成 1 人。
    {
      const recorded = [];
      const previousFetch = globalThis.fetch;
      probe.setFetch(async (url, init = {}) => {
        recorded.push({url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null});
        return {ok: true, status: 200, headers: {get: () => null}, json: async () => ({ok: true})};
      });
      try {
        const quotaForm = el("form", {dataset: {form: "org-quotas", org: "org_1"}}, [
          el("input", {name: "maxMembers", value: ""}),
          el("input", {name: "maxProjects", value: "30"}),
          el("input", {name: "maxTaskGroups", value: " "}),
          el("input", {name: "maxAgents", value: "7"}),
          el("button", {type: "submit"})
        ]);
        await probe.submit({target: quotaForm, submitter: quotaForm.children[4], preventDefault: () => {}});
        const post = recorded.find((item) => item.method === "POST" && /orgs\/org_1\/quotas$/u.test(item.url));
        const quotas = post?.body?.quotas || {};
        check("改配额：留空的项不发、填了的按数发",
          // Boolean(post)：post 是 .find() 结果，没记录到提交时是 undefined，`undefined && ...` 求值成
          // undefined（非布尔）会触发 check 的参数顺序自守卫抛错、把整门打崩（同 readonly 那处）。
          Boolean(post) && !("maxMembers" in quotas) && !("maxTaskGroups" in quotas) && quotas.maxProjects === 30 && quotas.maxAgents === 7,
          post ? `发出去的是 ${JSON.stringify(quotas)} —— 留空成了 0` : "没记录到提交");
      } finally {
        probe.setFetch(previousFetch);
      }
    }
    // 【终止/降级执行方案：理由空着要拒且不开弹窗；弹窗点「取消」不发；点「确认」发的正是那个动作与理由】。
    // 两者都是不可逆终态转移，还会改写人的定稿记录 —— 此前门从没走到过这两条提交路径，
    // 确认弹窗在桩里更是从没开过（它等一次真实点击）。
    for (const [kind, field, action, confirmText] of [
      ["topology-cancel", "cancelRef", "cancel", "确认终止"],
      ["topology-downgrade", "downgradeReason", "downgrade", "确认降级"]
    ]) {
      const recorded = [];
      const toasts = [];
      const previousFetch = globalThis.fetch;
      probe.setFetch(async (url, init = {}) => {
        recorded.push({url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null});
        return {ok: true, status: 200, headers: {get: () => null}, json: async () => ({ok: true})};
      });
      probe.captureToastKind("error", (message) => toasts.push(String(message)));
      const mkForm = (reason) => el("form", {dataset: {form: kind, request: "req_1"}}, [
        el("input", {name: field, value: reason}),
        el("button", {type: "submit"})
      ]);
      const masks = () => probe.bodyChildren().filter((node) => node && node.className === "modal-mask");
      const posted = () => recorded.find((item) => item.method === "POST" && /execution-topologies\/req_1\/advance$/u.test(item.url));
      const clickDialog = async (form, choice) => {
        // 桩里 remove() 是空操作，上一轮的遮罩还留在 body 上：要等的是【新】挂上来的那一个。
        const before = masks().length;
        const pending = probe.submit({target: form, submitter: form.children[1], preventDefault: () => {}});
        for (let i = 0; i < 10 && masks().length <= before; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
        if (masks().length <= before) { await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 50))]); return {mask: null, opened: false}; }
        const mask = masks().at(-1);
        if (!mask?.listeners?.click) return {mask, opened: false};
        mask.listeners.click({target: {closest: () => ({dataset: {confirm: choice}})}});
        await pending;
        return {mask, opened: true};
      };
      try {
        // 空理由也走 clickDialog：要是弹窗竟然开了（校验被拿掉），门要能看见它并替人点「取消」把提交放行，
        // 而不是永远等一次点击 —— 挂死不是红。
        const empty = await clickDialog(mkForm("   "), "cancel");
        check(`${kind}：理由空着要拒、不开确认弹窗、不发请求`,
          !empty.opened && !posted() && toasts.some((message) => /必须写明理由/u.test(message)),
          posted() ? `空着也发了 ${JSON.stringify(posted().body)}` : `没拒（弹窗${empty.opened ? "开了" : "没开"}；toast：${JSON.stringify(toasts).slice(0, 100)}）`);
        const cancelForm = mkForm("探针理由：方案走不通");
        const cancelled = await clickDialog(cancelForm, "cancel");
        check(`${kind}：确认弹窗要真的开、写着「${confirmText}」，点「取消」不发请求`,
          cancelled.opened && String(cancelled.mask.innerHTML || "").includes(confirmText) && !posted(),
          !cancelled.opened ? "弹窗没开（或没挂 click 监听）" : posted() ? `点了取消还是发了 ${JSON.stringify(posted().body)}` : "弹窗上没有确认按钮的字");
        const okForm = mkForm("探针理由：方案走不通");
        const confirmed = await clickDialog(okForm, "ok");
        const post = posted();
        check(`${kind}：点「${confirmText}」发出的是 ${action} 与人写的理由`,
          confirmed.opened && post?.body?.action === action && post?.body?.[field] === "探针理由：方案走不通",
          `发出去的是 ${JSON.stringify(post?.body)}（弹窗${confirmed.opened ? "开了" : "没开"}；toast：${JSON.stringify(toasts).slice(0, 200)}；请求：${JSON.stringify(recorded.map((item) => item.url)).slice(0, 200)}）`);
      } finally {
        probe.setFetch(previousFetch);
      }
    }
    // 【人工指令的三种提交】。非决策类型正文不带 resolution；决策处置空着要拒、不缺省成 reopen；选了就原样发。
    // （渲染属性那条 —— 处置方式下拉不带 required —— 在 runNoVisibleProjectCase 里，跟指令页夹具在一起。）
    {
        const recorded = [];
        const toasts = [];
        const previousFetch = globalThis.fetch;
        probe.setFetch(async (url, init = {}) => {
          recorded.push({url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null});
          return {ok: true, status: 201, headers: {get: () => null}, json: async () => ({ok: true})};
        });
        probe.captureToastKind("error", (message) => toasts.push(String(message)));
        const mkDirective = (type, resolution, instruction, workItemId = "") => el("form", {dataset: {form: "directive-create"}}, [
          el("select", {name: "directiveType", value: type}),
          el("select", {name: "resolution", value: resolution}),
          el("input", {name: "workItemId", value: workItemId}),
          el("textarea", {name: "instruction", value: instruction}),
          el("button", {type: "submit"})
        ]);
        const lastPost = () => recorded.filter((item) => item.method === "POST" && /human-directives$/u.test(item.url)).at(-1);
        try {
          const addForm = mkDirective("add_requirement", "", "补充一条要求");
          await probe.submit({target: addForm, submitter: addForm.children[4], preventDefault: () => {}});
          const added = lastPost();
          check("提交「补充要求」不需要处置方式、正文里也不带 resolution",
            added?.body?.directiveType === "add_requirement" && !("resolution" in (added.body || {})),
            added ? `发出去的是 ${JSON.stringify(added.body)}` : `没发出去（toast：${JSON.stringify(toasts).slice(0, 120)}）`);
          recorded.length = 0;
          const emptyResolve = mkDirective("resolve_decision", "", "");
          await probe.submit({target: emptyResolve, submitter: emptyResolve.children[4], preventDefault: () => {}});
          check("决策处置：处置方式空着要拒，不缺省成 reopen",
            !lastPost() && toasts.some((message) => /选择处置方式/u.test(message)),
            lastPost() ? `空着也发了 ${JSON.stringify(lastPost().body)}` : `没拒（toast：${JSON.stringify(toasts).slice(0, 120)}）`);
          const abandonForm = mkDirective("resolve_decision", "abandon", "", " w_9 ");
          await probe.submit({target: abandonForm, submitter: abandonForm.children[4], preventDefault: () => {}});
          const abandoned = lastPost();
          check("决策处置：选「放弃」并点名工作项，发出的正是 abandon 与去掉空白的 id",
            abandoned?.body?.resolution === "abandon" && abandoned?.body?.workItemId === "w_9",
            `发出去的是 ${JSON.stringify(abandoned?.body)}`);
        } finally {
          probe.setFetch(previousFetch);
        }
    }
    // 【配置编辑器不许插一行保存时会被丢掉的行】。cfg-add 原先对认不出的 kind 兜底插「业务规则」行，
    // 而保存只收 repo / baseline / role —— 人填了就丢。先自证点击真的会插行（repo），再验未知 kind 不插。
    {
      const cfgRoot = el("div");
      const cfgList = el("div", {dataset: {cfgList: "probe-list"}}); cfgRoot.appendChild(cfgList);
      const cfgProbe = loadConsole(cfgRoot, {realI18n: true});
      // 桩的形状照「归档弹窗」那条：closest 要按选择器分辨（一律 null 会让处理器认不出这是个动作按钮）。
      const mkButton = (kind) => {
        const b = {dataset: {action: "cfg-add", target: "probe-list", kind}, disabled: false, textContent: "添加", classList: {add() {}, remove() {}}};
        b.closest = (selector) => (selector === "[data-action]" ? b : null);
        return b;
      };
      const list = () => cfgRoot.querySelector("[data-cfg-list='probe-list']");
      await cfgProbe.click({target: mkButton("repo"), preventDefault: () => {}});
      const repoRows = (list()?.innerHTML.match(/data-cfg-kind="repo"/gu) || []).length;
      if (repoRows !== 1) {
        check("配置编辑器点击探针要真的能插行（repo）", false, `夹具没插出 repo 行（${repoRows}）—— 下面那条什么也没验`);
      } else {
        await cfgProbe.click({target: mkButton("business"), preventDefault: () => {}});
        const extra = (list()?.innerHTML.match(/class="cfg-row/gu) || []).length - 1;
        check("认不出的 kind 不许插一行保存时会被丢掉的行", extra === 0, `未知 kind 插了 ${extra} 行 —— 人填了保存就丢`);
      }
    }
    const quotaHint = probe.requestFailureHint({error: "org_quota_exceeded", kind: "agents", quota: 3, usage: 3});
    if (process.env.AIMAC_PRINT_HINTS) console.log(`[hint] 配额: ${String(quotaHint).slice(0, 60)}`);
    check("配额拒绝要说清是哪一类、用了多少、上限多少", quotaHint.includes("智能体 3/3"), quotaHint.slice(0, 90));
    check("智能体配额要说清只有吊销才腾得出来（关停/停用都不减）", quotaHint.includes("吊销"), quotaHint.slice(0, 120));
    check("配额里的 kind 是「哪一类配额」，不能被当成「故障类型」再打一遍（词表里没有 agents，会露出英文码）",
      !quotaHint.includes("故障类型"), quotaHint.slice(0, 120));
    // 屏幕上并排的两个数必须出自同一口径：页面那格数节点，签发令牌时却把未使用的令牌也算进去 ——
    // 于是"还剩一格"和"3/3 已满"同时成立，人只能以为系统数错了。
    const splitHint = probe.requestFailureHint(
      {error: "org_quota_exceeded", kind: "agents", quota: 3, usage: 3, nodes: 2, outstandingJoinTokens: 1});
    check("配额报文要拆开说清是节点还是没用掉的令牌占的位",
      splitHint.includes("2 台节点") && splitHint.includes("1 张未使用的入网令牌"), splitHint.slice(0, 130));
    const faultHint = probe.requestFailureHint({error: "state_store_unavailable", kind: "state_read_failed"});
    check("存储故障那一族仍要打出故障类型（上一条不能把它一起挡掉）", faultHint.includes("故障类型"), faultHint.slice(0, 90));
  }

  // 项目设置页几乎不经 t()，此前只在漏译扫描里渲染成空壳 —— 1000 行的一页没有任何行为断言。
  // 用【真实种子配置】渲染它：三块配置在种子里都是空的，而页面原先只剩一个"添加 X"按钮，
  // 人分不清"这个项目没配"和"配置没加载出来"，也不知道空着会怎样。
  {
    const {effectiveProjectConfig} = await import("../apps/control-plane-ui/lib/control-plane-core.mjs");
    const seed = JSON.parse(fs.readFileSync(path.join(root, "data/seed-state.json"), "utf8"));
    const proj = seed.projects[0];
    const cfg = effectiveProjectConfig(proj);
    // 种子项目【有】一个仓库（在顶层字段上），设置页必须把它显出来 ——
    // 否则同一屏上「仓库产出归属」列着仓库、而这里说"还没有配置仓库"。
    if (!(cfg.repositories || []).length) {
      throw new Error("控制台行为门: 种子项目的仓库没被 effectiveProjectConfig 认出来 —— "
        + "设置页会显示「还没有配置仓库」，而同一屏的「仓库产出归属」里列着它");
    }
    // 空配置那几条断言改用一个真的空项目，别拿种子当空的。
    const emptyProject = {id: "prj_empty_cfg", name: "空项目", organizationId: "org_default", status: "active", members: []};
    const emptyCfg = effectiveProjectConfig(emptyProject);
    const settingsRoot = el("div");
    const settingsProbe = loadConsole(settingsRoot, {realI18n: true});
    const settingsFetch = async (target) => ({ok: true, status: 200, statusText: "OK", headers: {get: () => null},
      json: async () => String(target).includes("/config") ? {projectId: proj.id, config: emptyCfg, configVersion: 1} : seed,
      text: async () => JSON.stringify(seed)});
    await settingsProbe.loadWithFetch(seed, {accountId: "u1", email: "a@b.c", accountType: "system_admin",
      displayName: "管理员", organizationId: "org_default", permissions: ["system:*"]},
      proj.id, "proj-settings", settingsFetch);
    const settingsHtml = String(settingsRoot.innerHTML || "");
    const settingsText = settingsHtml.replace(/<[^>]+>/gu, " ");
    // 接线断裂的那一半：effectiveProjectConfig 早就把两处仓库登记并成一份了（它的注释写的就是
    // 这个缺陷），而设置页读的是【状态里的原始 project.config】—— 修好的口径根本到不了屏幕上。
    // 上面那条断言只验了那个函数，验不到这一段接线；真实运行态渲染出来一看，
    // 种子项目上赫然写着「还没有配置仓库：产出会卡在没有产出目标」，
    // 而同一屏的「仓库产出归属」列着这个仓库、状态是「已推送」。
    {
      const wiredRoot = el("div");
      const wiredProbe = loadConsole(wiredRoot, {realI18n: true});
      const wiredFetch = async (target) => ({ok: true, status: 200, statusText: "OK", headers: {get: () => null},
        json: async () => String(target).includes("/config") ? {projectId: proj.id, config: cfg, configVersion: 1} : seed,
        text: async () => JSON.stringify(seed)});
      await wiredProbe.loadWithFetch(seed, {accountId: "u1", email: "a@b.c", accountType: "system_admin",
        displayName: "管理员", organizationId: "org_default", permissions: ["system:*"]},
        proj.id, "proj-settings", wiredFetch);
      const wiredHtml = String(wiredRoot.innerHTML || "");
      const wiredText = wiredHtml.replace(/<[^>]+>/gu, " ");
      const repoUrl = (cfg.repositories || [])[0]?.url || "";
      check("设置页要显示 config 接口算出来的仓库（而不是状态里的原始 config）",
        wiredHtml.includes(repoUrl) && !/还没有配置仓库/.test(wiredText),
        `种子项目只在顶层字段上登记了仓库（${repoUrl}）。屏幕上没有它就意味着这一页在说假话：`
        + "同一屏的「仓库产出归属」列着它、状态是已推送，而这里催人再登记一遍");
    }
    check("项目设置页真的渲染出来了（不是空壳）",
      settingsText.includes("仓库与访问凭据"), settingsText.slice(0, 120));
    const settingsPanelAt = (title) => settingsHtml.indexOf(`<h2>${title}</h2>`);
    check("项目设置页先显示总览和操作看板，再进入基础配置与规则明细",
      settingsPanelAt("项目设置总览") >= 0
        && settingsPanelAt("项目设置总览") < settingsPanelAt("项目设置操作看板")
        && settingsPanelAt("项目设置操作看板") < settingsPanelAt("项目设置职责分区")
        && settingsPanelAt("项目设置职责分区") < settingsPanelAt("项目配置生效流程")
        && settingsPanelAt("项目配置生效流程") < settingsPanelAt("项目基础配置")
        && settingsPanelAt("项目基础配置") < settingsPanelAt("AI 智能体")
        && settingsPanelAt("AI 智能体") < settingsPanelAt("规则治理概览")
        && settingsPanelAt("规则治理概览") < settingsPanelAt("系统规则")
        && settingsPanelAt("系统规则") < settingsPanelAt("业务规则"),
      "项目设置页仍然把长表单直接推到前面，用户要向下找才知道仓库、规则和 agent 管理在哪里");
    check("项目设置页必须先说明配置、规则和 Agent 接入的职责分区",
      /项目设置职责分区/u.test(settingsHtml)
        && /产出与基线/u.test(settingsHtml)
        && /角色回退/u.test(settingsHtml)
        && /执行规则/u.test(settingsHtml)
        && /Agent 接入/u.test(settingsHtml)
        && /Agent 节点、注册脚本和远程 MCP 确认不在本页处理/u.test(settingsHtml)
        && /一次性 join token.+安装脚本.+远程 MCP/u.test(settingsHtml)
        && /项目管理.+AI 智能体/u.test(settingsHtml),
      "项目设置页仍把配置、规则和 Agent 接入混成一个长页面，没有先给普通用户职责分区");
    check("项目设置页要说明配置从仓库、Skill、规则进入任务组、Agent 和监控",
      /项目配置生效流程/u.test(settingsHtml)
        && /所有任务产出仍落到项目仓库/u.test(settingsHtml)
        && /默认角色和角色 Skill 定制会进入后续派发/u.test(settingsHtml)
        && /新任务组会引用项目配置/u.test(settingsHtml)
        && /Agent 注册、远程 MCP 和 Skill 工作集生效确认/u.test(settingsHtml)
        && /配置调整后看后续派发、事件流、模型选择和仓库产出/u.test(settingsHtml)
        && /data-menu="tg"/u.test(settingsHtml)
        && /data-menu="proj-agents"/u.test(settingsHtml)
        && /data-menu="monitor"/u.test(settingsHtml),
      "项目设置页没有把配置如何进入任务组、agent 执行和监控回看讲成流程");
    check("项目设置里的 Agent 入口要说明注册脚本只来自项目 AI 智能体页",
      /注册脚本只在签发成功弹窗显示|需要新节点时进入「AI 智能体」→「注册 agent」签发/u.test(settingsHtml)
        && /Agent 节点、注册脚本和远程 MCP 确认不在本页处理/u.test(settingsHtml),
      "项目设置仍像 Agent 注册页的附属表单，用户会继续在这里找注册脚本");
    check("项目设置操作看板要提供能直接跳到各配置模块的入口",
      /data-jump-panel="项目基础配置"/u.test(settingsHtml)
        && /data-menu="proj-agents"/u.test(settingsHtml)
        && /data-jump-panel="系统规则"/u.test(settingsHtml)
        && /data-jump-panel="业务规则"/u.test(settingsHtml),
      "项目设置看板只显示指标，没有接上基础配置、AI 智能体页面和规则面板的跳转");
    check("项目设置页要在长规则列表前提供规则治理概览",
      /规则治理概览/u.test(settingsHtml)
        && /默认系统规则/u.test(settingsHtml)
        && /项目级系统规则/u.test(settingsHtml)
        && /已停用系统规则/u.test(settingsHtml)
        && /已改写默认规则/u.test(settingsHtml)
        && /系统规则先守执行安全、流程边界、证据和 AI-native 纪律/u.test(settingsHtml)
        && /业务规则再表达项目业务约束/u.test(settingsHtml)
        && /完整正文和保存动作仍在下方规则明细里/u.test(settingsHtml)
        && /data-jump-panel="系统规则"/u.test(settingsHtml)
        && /data-jump-panel="业务规则"/u.test(settingsHtml),
      "项目设置页仍让用户直接进入长系统规则列表，没有先给规则来源、覆盖和停用状态的治理概览");
    check("没配仓库时要说清空着会怎样（而不是只剩一个「添加仓库」按钮）",
      /还没有配置仓库/.test(settingsText) && /落不了地|没有产出目标/.test(settingsText),
      "人分不清「这个项目没配」和「配置没加载出来」，也不知道空着会卡在哪一步");
    check("可选项要说明它是可选的（基线数据空着不影响执行）",
      /还没有基线数据/.test(settingsText) && /可选/.test(settingsText),
      "把可选项写成和必填项一样的空提示，人会去填一份并不需要的东西");
    // 「暂无规则。」对两类规则的含义相反：业务规则空是常态，系统规则空是故障
    //（内置默认本应始终在场）。同一句话盖住两种情形，等于把一次故障说成常态。
    check("业务规则为空是常态，要说清它意味着什么",
      /还没有业务规则/.test(settingsText) && /只受系统规则约束/.test(settingsText),
      settingsText.includes("暂无规则") ? "还在用那句对两类都一样的「暂无规则」" : settingsText.slice(0, 100));
    const emptySystem = settingsProbe.ruleEditorFormWith({rules: [], listId: "x", category: "system",
      layer: "project", project: proj.id, readOnly: false, note: ""});
    check("一条系统规则都没有时要当成故障说（内置默认本应始终在场）",
      /一条系统规则都没有/.test(emptySystem) && /没有系统级约束/.test(emptySystem),
      String(emptySystem).replace(/<[^>]+>/gu, " ").slice(0, 130));
    const longRuleForm = settingsProbe.ruleEditorFormWith({
      rules: [{ruleId: "sys.long", category: "system", title: "长正文规则", content: "第一段规则正文 ".repeat(80), source: "default", enabled: true}],
      listId: "long-rules", category: "system", layer: "project", project: proj.id, readOnly: false, note: ""
    });
    check("已有规则要默认折叠成摘要，避免设置页和任务组详情被长正文撑成内容墙",
      /<details class="rule-row\s*"/u.test(longRuleForm)
        && !/<details class="rule-row[^>]*\sopen(?:\s|>)/u.test(longRuleForm)
        && /<summary class="rule-summary">/u.test(longRuleForm)
        && /class="rule-content-view"/u.test(longRuleForm)
        && /已启用/u.test(longRuleForm)
        && /继承/u.test(longRuleForm),
      "规则编辑器仍默认展开完整正文，用户打开项目设置或任务组配置就会先看到一长墙规则文本");
    check("规则正文 textarea 仍要留在折叠行里，展开后可编辑且保存逻辑不变",
      /textarea name="ruleContent"/u.test(longRuleForm)
        && /data-orig-content=/u.test(longRuleForm)
        && /第一段规则正文/u.test(longRuleForm),
      "规则折叠不能把正文编辑能力拿掉，也不能破坏保存时判断本层覆盖所需的原始正文");
    const newRuleRow = settingsProbe.ruleRowNewWith("business");
    check("新增规则行要默认展开，点新增后可以直接填写",
      /<details class="rule-row" open/u.test(newRuleRow)
        && /新增业务规则/u.test(newRuleRow)
        && /input class="rule-id-input"/u.test(newRuleRow)
        && /textarea name="ruleContent"/u.test(newRuleRow),
      "新增规则也被折叠会让人点了新增还找不到可填写字段");
    const styleText = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/styles.css"), "utf8");
    check("规则摘要样式要支持桌面三列与移动端单列",
      /\.rule-summary\s*\{[\s\S]*grid-template-columns:\s*auto minmax\(180px, 0\.9fr\) minmax\(220px, 1\.4fr\)/u.test(styleText)
        && /@media \(max-width: 860px\)[\s\S]*\.rule-summary \{ grid-template-columns: 1fr; \}/u.test(styleText),
      "规则摘要没有明确的桌面/移动布局约束，长标题或长预览在窄屏容易挤压错位");
    check("默认角色为空时要说清回退到哪里",
      /还没有项目默认角色/.test(settingsText) && /内置角色/.test(settingsText),
      "空着不是坏事，但要说清系统会拿什么顶上");
  }

  if (process.env.AIMAC_READ_FIRST) {
    const seed = JSON.parse(fs.readFileSync(path.join(root, "data/seed-state.json"), "utf8"));
    const firstRoot = el("div");
    const firstProbe = loadConsole(firstRoot, {realI18n: true});
    const firstFetch = async () => ({ok: true, status: 200, statusText: "OK", headers: {get: () => null},
      json: async () => seed, text: async () => JSON.stringify(seed)});
    await firstProbe.loadWithFetch(seed, {accountId: "u1", email: "a@b.c", accountType: "system_admin",
      displayName: "管理员", organizationId: "org_default", permissions: ["system:*"]},
      seed.projects[0].id, "proj-overview", firstFetch);
    console.log("\n======== 新人登录后的项目概览（真实种子）========");
    console.log(String(firstRoot.innerHTML || "").replace(/<[^>]+>/gu, " ")
      .split("\n").map((l) => l.replace(/\s+/gu, " ").trim()).filter(Boolean).join("\n").slice(0, 2500));
  }

  const emptyProbe = loadConsole(emptyRoot);
  const emptyState = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
    organizations: [{orgId: "org_default", name: "默认组织", status: "active"}],
    projects: [], taskGroups: [], agentRuntimeNodes: [], agents: [], agentDispatches: [],
    workSessions: [], closeBarriers: [], qualityGates: [], findings: [], humanConfirmationRequests: [],
    humanDirectives: [], truncatedCollections: [], fleet: {online: 0, total: 0}};
  const renderFor = (accountType) => {
    i18nScanStates.push(["空部署", emptyState, {accountId: "u1", email: "a@b.c", accountType, displayName: "某人", organizationId: "org_default"}, null]);
    emptyProbe.renderFullPageWith(emptyState,
      {accountId: "u1", email: "a@b.c", accountType, displayName: "某人", organizationId: "org_default"},
      "", "proj-overview");
    return String(emptyRoot.innerHTML || "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
  };
  const asSystem = renderFor("system_admin");
  check("全新部署时，系统管理员看到的是系统侧能做的下一步（而不是去找成员管理员）",
    /组织管理/u.test(asSystem) && /初始组织管理员/u.test(asSystem) && !/请联系组织管理员/.test(asSystem),
    `系统管理员看到：${(asSystem.match(/当前账号暂无可见项目。[^ ]*/u) || ["（没有空态提示）"])[0]}`);
  const asOrgAdmin = renderFor("org_admin");
  check("组织管理员看到的是「项目列表」入口，而不是去找组织管理员（他自己就是）",
    /项目列表/.test(asOrgAdmin) && !/请联系组织管理员/.test(asOrgAdmin),
    `组织管理员看到：${(asOrgAdmin.match(/当前账号暂无可见项目。[^ ]*/u) || ["（没有空态提示）"])[0]}`);
  const asMember = renderFor("user_account");
  check("普通成员确实该被告知去找组织管理员（这条保留，证明上面两条不是把提示删了了事）",
    /请联系组织管理员/.test(asMember),
    `普通成员看到：${(asMember.match(/当前账号暂无可见项目。[^ ]*/u) || ["（没有空态提示）"])[0]}`);
}


// 规则编辑器在读不到配置时会整块隐藏（防止误保存把规则清空），这是对的。
// 但"还没取过"与"取失败了"此前共用同一个 null，界面一律说"配置接口加载失败" ——
// 打开一个全新项目的设置页，第一眼就是这句，人会去追一个并不存在的故障。
{
  const settingsRoot = el("div");
  const settingsProbe = loadConsole(settingsRoot);
  const withProject = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
    organizations: [{orgId: "org_default", name: "默认组织", status: "active"}],
    projects: [{id: "p1", name: "新项目", organizationId: "org_default", status: "active", members: []}],
    taskGroups: [], agentRuntimeNodes: [], agents: [], agentDispatches: [], workSessions: [],
    closeBarriers: [], qualityGates: [], findings: [], humanConfirmationRequests: [], humanDirectives: [],
    truncatedCollections: [], fleet: {online: 0, total: 0}};
// 【只读成员那一屏不许有能按的写杠杆】。项目设置页对没有「项目授权管理」权限的人是只读的，
// 页面也明说了这句话 —— 但那句话与按钮是两处各写各的：按钮少收一个，屏幕上就同时出现
// "配置为只读"和一个按下去必被拒的保存键。判据按【渲染出来的 HTML】核，不看源码里的条件：
// 条件写在哪一行都行，看得见的只有这一屏上还有没有能按的写动作。
{
  const viewerRoot = el("div");
  const viewerProbe = loadConsole(viewerRoot, {realI18n: true});
  const viewerState = {
    projects: [{id: "p1", name: "只读探针项目", organizationId: "org_default", status: "active"}],
    organizations: [{orgId: "org_default", name: "默认组织", status: "active"}],
    accounts: [], accessGrants: [], taskGroups: [], agentJoinTokens: [],
    truncatedCollections: [], fleet: {online: 0, total: 0}
  };
  const viewer = {accountId: "u_viewer", email: "v@b.c", accountType: "user_account",
    displayName: "只读成员", organizationId: "org_default", permissions: ["project:view"], effectivePermissions: ["project:view"]};
  viewerProbe.renderFullPageWith(viewerState, viewer, "p1", "proj-settings");
  const viewerHtml = String(viewerRoot.innerHTML || "");
  const buttons = [...viewerHtml.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gu)]
    .map(([, attrs, label]) => ({label: label.replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim(), disabled: /\bdisabled\b/u.test(attrs)}));
  const writeLabels = ["添加仓库", "添加基线", "添加角色", "保存项目配置"];
  const rendered = writeLabels.filter((label) => buttons.some((item) => item.label === label));
  check("只读成员的项目设置页确实渲染了那几个写按钮（否则下面这条在空转）",
    rendered.length === writeLabels.length,
    `只渲染出 ${rendered.length}/${writeLabels.length} 个写按钮：${rendered.join("、") || "（一个都没有）"}`);
  const pressable = buttons.filter((item) => writeLabels.includes(item.label) && !item.disabled).map((item) => item.label);
  check("只读成员按不动项目配置上的任何写按钮",
    pressable.length === 0,
    `这些写按钮对只读成员仍然可按：${pressable.join("、")} —— 同一屏上还写着「项目配置为只读」`);
  check("并且屏幕上说清了为什么是只读",
    viewerHtml.includes("项目配置为只读"),
    "按钮收起来了却不说为什么，人只会以为页面坏了");
}

// 【只读成员的配置行也不许有能按的删除、也不许可编辑】。上一条只验了页脚的添加/保存；配置行（仓库/基线/角色）
// 的输入与每行的「删除」是另一处——它们此前始终可编辑、可删（cfg-del 本地暂存 formTouched），而保存已禁用，
// 于是只读成员能删掉一行、屏幕真的少一行，却存不下、也没有保存入口＝按了看不到效果的死动作（同页 rule 行早就按
// readOnly 收起了删除、输入设 readonly，唯独 repo/baseline/role 三种行漏了）。配置行经 config 接口取，故用带桩的 loadWithFetch。
{
  const roCfgRoot = el("div");
  const roCfgProbe = loadConsole(roCfgRoot, {realI18n: true});
  const roViewer = {accountId: "u_ro", email: "ro@b.c", accountType: "user_account", displayName: "只读成员",
    organizationId: "org_default", permissions: ["project:view"], effectivePermissions: ["project:view"]};
  const roSeed = {projects: [{id: "p1", name: "只读配置项目", organizationId: "org_default", status: "active"}],
    organizations: [{orgId: "org_default", name: "默认组织", status: "active"}],
    accounts: [], accessGrants: [], taskGroups: [], agentJoinTokens: [], truncatedCollections: [], fleet: {online: 0, total: 0}};
  const roCfg = {repositories: [{id: "r1", url: "https://example.test/repo.git", defaultBranch: "main"}], baselineData: [], defaultRoles: []};
  const roFetch = async (target) => ({ok: true, status: 200, statusText: "OK", headers: {get: () => null},
    json: async () => String(target).includes("/config") ? {projectId: "p1", config: roCfg, configVersion: 1} : roSeed,
    text: async () => JSON.stringify(roSeed)});
  await roCfgProbe.loadWithFetch(roSeed, roViewer, "p1", "proj-settings", roFetch);
  const roHtml = String(roCfgRoot.innerHTML || "");
  check("只读成员的项目设置里确实渲染了配置行（否则下面两条在空转）",
    roHtml.includes("example.test/repo.git"),
    `只读成员的项目设置里没有渲染出仓库行（${roHtml.length} 字）`);
  const cfgDelButtons = [...roHtml.matchAll(/data-action="cfg-del"/gu)].length;
  check("只读成员的配置行不许有「删除」按钮（点了删本地行却存不下＝按了看不到效果）",
    cfgDelButtons === 0,
    `只读成员的项目设置配置行上仍有 ${cfgDelButtons} 个 cfg-del 删除按钮`);
  const repoUrlInput = /<input[^>]*name="repoUrl"[^>]*>/u.exec(roHtml);
  check("只读成员的配置输入必须是 readonly（否则能就地改、却存不下）",
    // Boolean(...)：repoUrlInput 是 exec 结果，未命中时是 null，`null && ...` 求值成 null（非布尔），
    // 会触发 check 的参数顺序自守卫抛错、连带把整门打崩、掩盖同一轮里别的断言（cfgSource=config 变异下实测）。
    Boolean(repoUrlInput) && /\breadonly\b/u.test(repoUrlInput[0]),
    `只读成员的仓库地址输入不是 readonly：${repoUrlInput ? repoUrlInput[0].slice(0, 100) : "（没找到 repoUrl 输入）"}`);
  check("只读成员的仓库行不许有「测试连接」按钮（服务端按改配置权限拒，按了只会看到 403）",
    !/data-action="repo-test-connection"/u.test(roHtml),
    "只读成员的仓库行上渲染了「测试连接」按钮");
}

// 【项目仓库「测试连接」】。凭证配错此前要等派发失败才知道。按钮只给已保存的仓库行（测的是已保存的配置）；
// 结果按 reason 给中文；ok 不是严格 true 一律按失败说（认不出的原因原样带出，不许当成功）；表单有未保存改动时不发请求。
{
  const ctRoot = el("div");
  const ctProbe = loadConsole(ctRoot, {realI18n: true});
  const ctAdmin = {accountId: "u_ct", email: "ct@b.c", accountType: "system_admin", displayName: "管理员", organizationId: "org_default",
    permissions: ["*"], effectivePermissions: ["*"]};
  const ctSeed = {projects: [{id: "p1", name: "连接测试项目", organizationId: "org_default", status: "active"}],
    organizations: [{orgId: "org_default", name: "默认组织", status: "active"}],
    accounts: [], accessGrants: [], taskGroups: [], agentJoinTokens: [], truncatedCollections: [], fleet: {online: 0, total: 0}};
  const ctCfg = {repositories: [{id: "r1", url: "https://example.test/repo.git", defaultBranch: "main", credentialMode: "api_key", credential: {mode: "api_key", apiKeySet: true}}],
    baselineData: [], defaultRoles: []};
  const ctFetch = async (target) => ({ok: true, status: 200, statusText: "OK", headers: {get: () => null},
    json: async () => String(target).includes("/config") ? {projectId: "p1", config: ctCfg, configVersion: 1} : ctSeed,
    text: async () => JSON.stringify(ctSeed)});
  await ctProbe.loadWithFetch(ctSeed, ctAdmin, "p1", "proj-settings", ctFetch);
  const ctHtml = String(ctRoot.innerHTML || "");
  check("已保存的仓库行要有「测试连接」按钮且指向该仓库 ID",
    /data-action="repo-test-connection" data-repo="r1"/u.test(ctHtml),
    `项目设置的仓库行上没有 repo-test-connection 按钮（${ctHtml.length} 字）`);
  const successToasts = [];
  const errorToasts = [];
  const infoToasts = [];
  ctProbe.captureToastKind("success", (message) => successToasts.push(String(message)));
  ctProbe.captureToastKind("error", (message) => errorToasts.push(String(message)));
  ctProbe.captureToastKind("info", (message) => infoToasts.push(String(message)));
  const recorded = [];
  let reply = {ok: true, refCount: 3, defaultBranchFound: true};
  ctProbe.setFetch(async (url, init = {}) => {
    recorded.push({url: String(url), method: init.method || "GET"});
    return {ok: true, status: 200, statusText: "OK", headers: {get: () => null}, json: async () => reply};
  });
  const mkButton = () => {
    const button = {dataset: {action: "repo-test-connection", repo: "r1"}, disabled: false, textContent: "测试连接", classList: {add() {}, remove() {}}};
    button.closest = (selector) => (selector === "[data-action]" ? button : null);
    return button;
  };
  ctProbe.setFormTouched(false);
  await ctProbe.click({target: mkButton(), preventDefault: () => {}});
  const post = recorded.find((item) => item.method === "POST" && /\/api\/projects\/p1\/repositories\/r1\/connection-test$/u.test(item.url));
  check("「测试连接」要真的 POST 到该项目该仓库的 connection-test",
    Boolean(post),
    `没记录到请求（${JSON.stringify(recorded).slice(0, 160)}）`);
  check("连接成功要说清远端分支数与默认分支是否存在",
    successToasts.some((message) => /连接成功/u.test(message) && /3 个分支/u.test(message) && /默认分支存在/u.test(message)),
    `成功提示不对：${JSON.stringify(successToasts).slice(0, 200)}`);
  reply = {ok: false, reason: "repository_auth_failed", detail: "fatal: Authentication failed for 'https://***@example.test/repo.git/'"};
  await ctProbe.click({target: mkButton(), preventDefault: () => {}});
  check("认证失败要按原因给人话并附上 git 原话",
    errorToasts.some((message) => /拒绝了这份凭证/u.test(message) && /Authentication failed/u.test(message)),
    `认证失败的提示不对：${JSON.stringify(errorToasts).slice(0, 240)}`);
  reply = {reason: "weird_new_reason"};
  await ctProbe.click({target: mkButton(), preventDefault: () => {}});
  check("认不出的原因（或没有 ok 字段）一律按失败说、原因原样带出（不许当成功）",
    !successToasts.some((message) => /weird_new_reason/u.test(message) || successToasts.length > 1)
      && errorToasts.some((message) => /原因未归类/u.test(message) && /weird_new_reason/u.test(message)),
    `认不出的原因没按失败说：success=${JSON.stringify(successToasts).slice(0, 120)} error=${JSON.stringify(errorToasts).slice(-160)}`);
  const before = recorded.length;
  ctProbe.setFormTouched(true);
  await ctProbe.click({target: mkButton(), preventDefault: () => {}});
  ctProbe.setFormTouched(false);
  check("表单有未保存改动时不发请求、要说明测的是已保存的配置",
    recorded.length === before && infoToasts.some((message) => /已保存的仓库配置/u.test(message)),
    `未保存改动时仍发了请求或没说明（多发 ${recorded.length - before} 次；info=${JSON.stringify(infoToasts).slice(0, 120)}）`);
  const reasonSource = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8");
  const missingReasons = REPOSITORY_CONNECTION_REASONS.filter((reason) => !new RegExp(`\\n\\s*${reason}: "`, "u").test(reasonSource));
  check("测试连接的每个 reason 都要有中文（词表以 lib/git-connection-test.mjs 为准）",
    missingReasons.length === 0 && REPOSITORY_CONNECTION_REASONS.length >= 7,
    `这些 reason 在 app.js 里没有中文：${missingReasons.join("、") || "（词表本身太短）"}`);
}

// 【组织概览显示的必须是这个账号自己的组织】。它原先取 state.organizations[0] —— 今天服务端
// 只给组织管理员下发它自己那一个，所以"数组第一个"碰巧总是对的。而碰巧对意味着：服务端哪天
// 多下发一个组织（系统管理员视角、或将来的跨组织视图），这一页就会把【别人组织的配额用量】
// 当成自己的显示出来，且不会有任何东西报错。判据把账号的组织故意放在数组第二位。
{
  const orgRoot = el("div");
  const orgProbe = loadConsole(orgRoot, {realI18n: true});
  const orgState = {
    organizations: [
      {orgId: "org_other", name: "别人的组织", status: "active",
        usage: {members: 99, projects: 99, taskGroups: 99, agents: 99}, quotas: {maxMembers: 100, maxProjects: 100, maxTaskGroups: 100, maxAgents: 100}},
      {orgId: "org_mine", name: "我自己的组织", status: "active",
        usage: {members: 2, projects: 1, taskGroups: 1, agents: 0}, quotas: {maxMembers: 10, maxProjects: 5, maxTaskGroups: 5, maxAgents: 5}}
    ],
    projects: [{id: "p1", name: "项目", organizationId: "org_mine", status: "active"}],
    taskGroups: [], accounts: [], accessGrants: [], agentRuntimeNodes: [],
    truncatedCollections: [], fleet: {online: 0, total: 0}
  };
  const orgAdmin = {accountId: "u_org", email: "org@b.c", accountType: "org_admin", displayName: "组织管理员", organizationId: "org_mine"};
  orgProbe.renderFullPageWith(orgState, orgAdmin, "p1", "org-overview");
  const orgHtml = String(orgRoot.innerHTML || "");
  check("组织概览渲染出了配额面板（否则下面那条在空转）", orgHtml.includes("配额用量"),
    `组织概览里找不到配额面板（${orgHtml.length} 字）`);
  check("组织概览显示的是这个账号自己的组织，不是数组第一个",
    orgHtml.includes("我自己的组织") && !orgHtml.includes("别人的组织"),
    "取 organizations[0] 的话，服务端一旦多下发一个组织，人看到的就是别人组织的配额用量");
}

// 【已注销的账号不许出现在授权下拉里】。注销是终态，后端已经拒（grant_subject_account_retired），
// 界面还摆着它就是把人往死路上引 —— 按下去回来的是一句拒绝。控制台上有两个这样的下拉：
// 「项目成员授权」的账号选择、「创建项目」的项目负责人选择。判据压在【渲染出来的 HTML】上，
// 而不是源码里搜过滤条件：过滤写在哪一行都行，看得见的只有屏幕上还列不列它。
{
  const pickerRoot = el("div");
  const pickerProbe = loadConsole(pickerRoot, {realI18n: true});
  const retiredName = "已注销的探针账号";
  const pickerState = {
    projects: [{id: "p1", name: "控制面", organizationId: "org_default", status: "active"}],
    organizations: [{orgId: "org_default", name: "默认组织", status: "active"}],
    accounts: [
      {accountId: "acct_live", displayName: "在用探针账号", organizationId: "org_default", status: "active", accountType: "user_account"},
      {accountId: "acct_gone", displayName: retiredName, organizationId: "org_default", status: "retired", accountType: "user_account"}
    ],
    accessGrants: [], agentJoinTokens: [], taskGroups: [], truncatedCollections: [], fleet: {online: 0, total: 0}
  };
  const pickerAdmin = {accountId: "u1", email: "a@b.c", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"};
  pickerProbe.renderFullPageWith(pickerState, pickerAdmin, "p1", "proj-members");
  // 只看【下拉】：账号列表那张表本来就该把已注销的账号列出来（人要看得到它被注销了），
  // 搜整页会把那张表也算进去 —— 第一版就是这么误报的。
  const pickerHtml = String(pickerRoot.innerHTML || "");
  const selects = pickerHtml.match(/<select[\s\S]*?<\/select>/gu) || [];
  const selectText = selects.join("\n");
  check("授权下拉里列得出在用账号（否则下面那条在空转）",
    selects.length >= 1 && selectText.includes("在用探针账号"),
    `渲染出的项目成员页里只有 ${selects.length} 个下拉、且找不到在用账号`);
  check("已注销的账号不出现在项目成员授权下拉里",
    !selectText.includes(retiredName),
    "后端已经拒（grant_subject_account_retired），界面还摆着它就是把人往死路上引");
  check("项目成员页仍然看得到项目授权入口（否则上面两条在空转）",
    /项目成员授权/u.test(pickerHtml),
    "整页没有项目成员授权入口 —— 那是在别的页上验下拉");
}

  const admin = {accountId: "u1", email: "a@b.c", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"};
  const settingsText = (status, error) => {
    settingsProbe.setProjConfigStatus(status, error);
    i18nScanStates.push(["新建项目", withProject, admin, "p1"]);
    settingsProbe.renderFullPageWith(withProject, admin, "p1", "proj-settings");
    return String(settingsRoot.innerHTML || "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
  };
  const unloaded = settingsText("unloaded");
  check("配置还没取到时说的是'正在加载'，不是'加载失败'",
    /正在加载项目规则配置/.test(unloaded) && !/加载失败/.test(unloaded),
    `未加载时显示：${(unloaded.match(/规则配置 [^ ]*/u) || ["（没有规则配置面板）"])[0]}`);
  const failed = settingsText("failed", "503 project_config_unavailable");
  check("真的取失败时仍要说清失败、并说明为什么把编辑器藏了",
    /这一次没取到/.test(failed) && /误保存清空规则/.test(failed),
    `失败时显示：${(failed.match(/规则配置 [^ ]*/u) || ["（没有规则配置面板）"])[0]}`);
  // 原先这一段的 catch 是 .catch(() => null)：原因被整个吞掉，界面只能说一句笼统的"加载失败"，
  // 而三块空态又把人指去看一条并不存在的横幅。原因必须被留下来并出现在屏幕上。
  check("配置取失败时要把服务端给的原因原样摆出来（不能吞掉只说一句「加载失败」）",
    failed.includes("503 project_config_unavailable"),
    `失败原因在屏幕上${failed.includes("503") ? "有" : "没有"}`);
  check("配置没取过与取失败要分开说，且都不许说「还没有配置」",
    /配置还没取回来/.test(unloaded) && !/还没有配置仓库/.test(unloaded) && !/还没有配置仓库/.test(failed),
    `未取过时三块空态说的是：${(unloaded.match(/仓库与访问凭据[^添]*/u) || ["（没渲染出来）"])[0].slice(0, 60)}`);
  // 上面两条是【渲染分支】：它们直接设置状态，因此证明不了"真失败时真的会置成 failed"。
  // 少了这一条，把置位逻辑改成永远 unloaded 也照样全绿（变异验出来的）。
  // 接线只能从源码看：取配置那一段之后必须有一处把状态置成 failed。按语句边界切，不按行数猜。
  const appText = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8");
  const configFetch = appText.indexOf("/api/projects/${encodeURIComponent(currentProjectId)}/config");
  const wiringBlock = configFetch < 0 ? "" : appText.slice(configFetch, appText.indexOf("\n      }", configFetch));
  check("取配置失败时必须把状态置成 failed（否则界面永远停在'正在加载'）",
    /projConfigStatus = projConfig \? "loaded" : "failed"/u.test(wiringBlock),
    configFetch < 0 ? "找不到取配置那段代码 —— 本条在空转" : `取配置段落里${/failed/u.test(wiringBlock) ? "有" : "没有"}置 failed 的接线`);
}


// 项目概览是项目负责人盯得最久的一页，也最容易被"看起来一切正常"骗到：
// 实测真实编排产出下它显示"健康度 ok、完成度 75%"，而当时没有任何在线 agent、
// 交出去的单元永远不会动。任务组页与监控页都会说这件事，这一页此前不说。
{
  const overviewRoot = el("div");
  const overviewProbe = loadConsole(overviewRoot);
  const stalled = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
    organizations: [{orgId: "org_default", name: "默认组织", status: "active"}],
    projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: [],
      progress: {phase: "development", health: "ok", updatedAt: new Date(0).toISOString()}}],
    taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "development", blockers: [],
      workItems: [{id: "w1", title: "单元", status: "assigned", progress: 30, ownerRole: "agent-runtime"}]}],
    agentDispatches: [], workSessions: [], agentRuntimeNodes: [], agents: [], closeBarriers: [],
    qualityGates: [], findings: [], humanConfirmationRequests: [], humanDirectives: [],
    truncatedCollections: [], fleet: {online: 0, total: 0}};
  const admin = {accountId: "u1", email: "a@b.c", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"};
  const overviewText = (fleet) => {
    i18nScanStates.push(["有活没人干", {...stalled, fleet}, admin, "p1"]);
    overviewProbe.renderFullPageWith({...stalled, fleet}, admin, "p1", "proj-overview");
    return String(overviewRoot.innerHTML || "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
  };
  // 同一屏上两个百分比：顶上那个是服务端【按工作项】平均，关键指标里那个是前端【按任务组】平均。
  // 实测种子上就是 73% 与 75%。两个都有用，但标签必须说清各自是怎么算的，否则读起来像同一件事。
  {
    const twoNumbers = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: [],
        progress: {percent: 73, phase: "开发", health: "ok", updatedAt: "2026-08-01T00:00:00Z"}}],
      taskGroups: [{id: "tg1", projectId: "p1", name: "组一", status: "development", progress: 70, workItems: []},
        {id: "tg2", projectId: "p1", name: "组二", status: "development", progress: 80, workItems: []}],
      agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [], findings: [],
      humanConfirmationRequests: [], humanDirectives: [], truncatedCollections: []};
    const overviewRoot2 = el("div");
    const overviewProbe2 = loadConsole(overviewRoot2);
    overviewProbe2.renderFullPageWith(twoNumbers, admin, "p1", "proj-overview");
    const text = String(overviewRoot2.innerHTML || "").replace(/<[^>]+>/gu, " ");
    check("并排的两个百分比要各自说清是怎么算的",
      /任务组平均进度/.test(text) && /按工作项平均/.test(text) && !/事项完成度/.test(text),
      "顶上 73%、下面 75%，标签却都读作「完成度」—— 人只能以为其中一个错了");
  }

  check("项目概览也要说出'没有在线 agent，这些活不会动'（它是被盯得最久的一页）",
    /没有任何在线的 agent 节点/.test(overviewText({online: 0, total: 0})),
    "概览页显示健康度 ok、进度在走，而实际一个单元都动不了 —— 另外两页说了，这一页不说");
  check("有 agent 在线时概览页不挂这条提示",
    !/没有任何在线的 agent 节点/.test(overviewText({online: 1, total: 1})),
    "常亮的提示等于没有提示");
}


function runFormRestoreCase() {
  const justification = "这个方案把订单状态机换成了事件溯源，属于架构层面的选择，必须先由架构组定稿再开工。";
  const buildForm = () => el("form", {dataset: {form: "human-confirmation", request: "hcr-1", round: "2"}}, [
    el("textarea", {name: "inputText", value: ""}),
    el("input", {name: "selectedOptionId", type: "radio", value: "opt-a", checked: false}),
    el("input", {name: "selectedOptionId", type: "radio", value: "opt-b", checked: false}),
    el("input", {name: "password", type: "password", value: ""})
  ]);

  // 提交时的表单（人已填好），与重渲染之后的新表单（内容被清空）是两个不同的 DOM 对象 ——
  // 这正是缺陷的成因，桩必须如实还原这一点，否则测的就是同一个对象，永远会通过。
  const submitted = buildForm();
  submitted.querySelector('[name="inputText"]').value = justification;
  submitted.querySelectorAll('[name="selectedOptionId"]')[1].checked = true;
  submitted.querySelector('[name="password"]').value = "hunter2";

  const rerendered = buildForm();
  const documentRoot = el("div", {}, [rerendered]);
  const probe = loadConsole(documentRoot);

  probe.setFormTouched(false);
  probe.setPending(probe.snapshotFormValues(submitted));
  probe.restorePendingForm();

  check("提交失败保内容",
    rerendered.querySelector('[name="inputText"]').value === justification,
    `提交失败后重渲染，人填的理由没有被带回来（实际 ${JSON.stringify(rerendered.querySelector('[name="inputText"]').value)}）—— 一次并发冲突就让人白写`);
  check("提交失败保选项",
    rerendered.querySelectorAll('[name="selectedOptionId"]')[1].checked === true,
    "重渲染后人选中的方案项没有恢复，人会以为自己选过了而实际提交的是默认项");
  check("口令不进快照",
    rerendered.querySelector('[name="password"]').value === "",
    "口令字段被写进了快照并回填 —— 内容留存的价值不值得让口令在内存里多活一轮");

  // 一次性消费：快照回填过就必须作废。这里必须拿**文档里那个身份匹配的**表单来测 ——
  // 用一个不在文档里的表单测，回填本来就找不到它，这条断言会无条件通过（假绿）。
  rerendered.querySelector('[name="inputText"]').value = "";
  probe.restorePendingForm();
  check("快照只用一次",
    rerendered.querySelector('[name="inputText"]').value === "",
    "快照没有被消费掉，会在后续每次重渲染里反复把过期内容灌回表单，覆盖人新填的东西");

  // 身份不匹配时不得回填：人切到别的确认单，绝不能把上一单的理由灌进去。
  const otherForm = el("form", {dataset: {form: "human-confirmation", request: "hcr-2", round: "1"}}, [
    el("textarea", {name: "inputText", value: ""})
  ]);
  const otherRoot = el("div", {}, [otherForm]);
  const otherProbe = loadConsole(otherRoot);
  otherProbe.setPending(otherProbe.snapshotFormValues(submitted));
  otherProbe.restorePendingForm();
  check("不串单",
    otherForm.querySelector('[name="inputText"]').value === "",
    "上一张确认单的理由被回填到了另一张确认单上 —— 人会在没读过的单子上提交别处写的理由");

  // 回填了内容就等于页面有未保存修改，离开必须照样警告。
  check("回填后仍视为未保存",
    probe.getFormTouched() === true,
    "回填内容后 formTouched 未置位，人离开页面时不会收到「放弃未保存的修改」提示，内容会静默丢失");

  checkWiring(probe);
}

// 场景：agent 之间在房间里谈成了一个方案，再把结论送到人面前定稿。人工定稿这道闸门的前提是
// 「人能看见 AI 的推理过程再决定」——如果协商过程在控制台上没有任何入口，定稿就退化成对结论点头。
// 从 sectionBlock 渲染出的 HTML 里切出某一块的正文。切不出来时返回 null 而不是空串 ——
// 空串会被后续断言当成"正文是空的"，把提取器失灵误报成代码有问题。
function sectionBodyOf(html, title) {
  const titleAt = html.indexOf(`<strong>${title}`);
  if (titleAt < 0) return null;
  const bodyMark = '<div style="margin-top:8px;">';
  const bodyAt = html.indexOf(bodyMark, titleAt);
  if (bodyAt < 0) return null;
  return html.slice(bodyAt + bodyMark.length, bodyAt + bodyMark.length + 600);
}

// 人拉了"这个单元必须先由人定稿执行方案"这条杠杆之后，编排只把它记进准入台账：
// 不改工作项状态、也加不了任务组阻塞（没有工作项被标成受阻时，本轮结算会把阻塞面整体清空）。
// 于是这张卡上此前一个字都没有 —— 单元停在原地，人不知道它在等什么、不想等了怎么办。
function runPlanFinalizationNoticeCase() {
  const probe = loadConsole(el("div"));
  // 定稿要求表单只对有 task_group:review 的人渲染：不设身份，下面「表单收起」两条看的是一张不存在的表单。
  probe.setAuth("probe-token", {accountId: "u_pf", accountType: "system_admin", displayName: "管理员", organizationId: "org_default",
    permissions: ["*"], effectivePermissions: ["*"]});
  const withRequirement = probe.renderTaskGroupDetail({taskGroupId: "tg_pf", progress: {}, config: null, roomMessages: []},
    {id: "tg_pf", roles: [], workItems: [{id: "w_pf", title: "缓存策略", status: "in_progress", progress: 60,
      ownerRole: "room-broker", requiresPlanFinalization: true}]});
  check("被要求先定稿方案的单元要在卡上说清在等什么",
    /必须先有人工定稿的执行方案才能开跑/.test(withRequirement),
    "人自己拉了这条杠杆，单元却停在原地一个字都没有 —— 他不知道在等谁、等什么");
  check("而且要给出口",
    /人工审核/.test(withRequirement) && /改回「不强制」/.test(withRequirement),
    "只说了在等什么、没说怎么往下走（等 agent 提方案后到哪定稿、不想等了怎么撤）");
  const withoutRequirement = probe.renderTaskGroupDetail({taskGroupId: "tg_pf", progress: {}, config: null, roomMessages: []},
    {id: "tg_pf", roles: [], workItems: [{id: "w_pf", title: "缓存策略", status: "in_progress", progress: 60,
      ownerRole: "room-broker"}]});
  check("没有这项要求时不要多说一句",
    !/必须先有人工定稿的执行方案/.test(withoutRequirement),
    "没被要求定稿方案的单元也挂着这条提示 —— 噪声会让真的那条被忽略");
  // 【这张表单默认收起】：每张卡整套渲染（说明 + 下拉 + 理由 + 保存）把卡片撑得很高，而它是偶尔才动一次的杠杆。
  // 收起后摘要要写明当前取值；上面那条「必须先定稿」的警示必须留在折叠块外常显。
  const toggleOf = (html) => /<details class="guide-bundle plan-finalization-toggle"( open)?>([\s\S]*?)<\/details>/u.exec(html);
  const openedToggle = toggleOf(withRequirement);
  const closedToggle = toggleOf(withoutRequirement);
  check("工作项卡上的定稿要求表单要收进默认关闭的折叠块，摘要写明当前取值",
    Boolean(openedToggle) && !openedToggle[1] && /data-form="plan-finalization"/u.test(openedToggle[2]) && /当前「必须先由人定稿方案」/u.test(openedToggle[0])
      && Boolean(closedToggle) && !closedToggle[1] && /当前「不强制（按系统判断）」/u.test(closedToggle[0]),
    `定稿要求表单没有收起或摘要没写当前取值（有要求：${openedToggle ? openedToggle[0].slice(0, 160) : "没找到折叠块"}）`);
  check("「必须先定稿」的警示要留在折叠块外常显",
    Boolean(openedToggle) && !/必须先有人工定稿的执行方案才能开跑/u.test(openedToggle[2]) && /必须先有人工定稿的执行方案才能开跑/u.test(withRequirement),
    "警示被一起折进去了 —— 单元停在原地，人又看不到它在等什么");
}

// 任务按时间线倒序：任务组里的工作项要最新建的排最前。服务端下发的是插入序（最旧在前），
// 界面必须自己按 createdAt 倒序；两条数据路径（进度接口 / 列表内嵌）都经同一个排序，各验一遍。
function runWorkItemOrderCase() {
  const probe = loadConsole(el("div"));
  const older = {id: "w_old", title: "旧的工作项甲", status: "ready", progress: 0, ownerRole: "orchestrator", createdAt: "2026-01-01T00:00:00.000Z"};
  const newer = {id: "w_new", title: "新的工作项乙", status: "ready", progress: 0, ownerRole: "orchestrator", createdAt: "2026-09-01T00:00:00.000Z"};
  const embedded = probe.renderTaskGroupDetail({taskGroupId: "tg_ord", progress: {}, config: null, roomMessages: []},
    {id: "tg_ord", roles: [], workItems: [older, newer]});
  check("任务组内工作项按时间倒序（列表内嵌路径）：最新建的排最前",
    embedded.indexOf("新的工作项乙") >= 0 && embedded.indexOf("新的工作项乙") < embedded.indexOf("旧的工作项甲"),
    "最新建的工作项没有排在最前：界面按服务端的插入序（最旧在前）渲染，人找最近的活要翻到最底下");
  const viaProgress = probe.renderTaskGroupDetail({taskGroupId: "tg_ord", progress: {workItems: [older, newer]}, config: null, roomMessages: []},
    {id: "tg_ord", roles: [], workItems: []});
  check("任务组内工作项按时间倒序（进度接口路径）：最新建的排最前",
    viaProgress.indexOf("新的工作项乙") >= 0 && viaProgress.indexOf("新的工作项乙") < viaProgress.indexOf("旧的工作项甲"),
    "最新建的工作项没有排在最前（进度接口路径）");
}


// 规则内容文本框要随内容自动撑高（原先固定 min-height，长规则要在小框里滚动着改，正是人反映的「太小」）。
// field-sizing: content 让它按内容长高；不支持的浏览器保持原样（min-height + 手动拖高），无回归。
function runRuleTextareaAutoGrowCase() {
  const styles = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/styles.css"), "utf8");
  const rule = styles.match(/\.rule-row textarea\[name="ruleContent"\]\s*\{([^}]*)\}/u)?.[1] || "";
  check("规则内容文本框要随内容自动撑高（field-sizing: content）",
    /field-sizing:\s*content/u.test(rule),
    "规则文本框没有随内容自动撑高：长规则得在固定高度的小框里滚动着改");
}


// 「每个任务也能看到完整执行流程，涉及哪些 agent 分别执行了什么」：工作项卡要列出这个任务的【全部】派发
// （不只是最新一次），最新在前，每条带节点/角色/模型/尝试次数/失败原因。
function runWorkItemDispatchHistoryCase() {
  const probe = loadConsole(el("div"));
  const group = {id: "tg_hist", projectId: "p1", roles: [], workItems: [{id: "w_hist", title: "历史探针单元", status: "in_progress", progress: 10, ownerRole: "agent-runtime"}]};
  const older = {dispatchId: "adp_hist_old", taskGroupId: "tg_hist", workItemId: "w_hist", status: "failed", progressPercent: 40,
    assignedNodeId: "node_alpha", roleId: "agent-runtime", model: "openai:gpt-5.5", attempts: 1, failureReason: "executor_produced_no_changes",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T01:00:00.000Z"};
  const newer = {dispatchId: "adp_hist_new", taskGroupId: "tg_hist", workItemId: "w_hist", status: "running", progressPercent: 10,
    assignedNodeId: "node_beta", roleId: "reviewer", model: "anthropic:claude-sonnet-4-5", attempts: 2,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:10:00.000Z"};
  const html = probe.renderTaskGroupDetail({taskGroupId: "tg_hist", progress: {}, config: null, roomMessages: []}, group,
    {projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [group], agentDispatches: [older, newer], workSessions: [], closeBarriers: [], qualityGates: [], findings: [],
      humanConfirmationRequests: [], humanDirectives: [], truncatedCollections: []});
  check("工作项卡要列出这个任务的全部派发（执行历史），不只是最新一次",
    /执行历史（共 2 次派发/u.test(html) && html.includes("adp_hist_old") && html.includes("adp_hist_new"),
    "执行历史只显示了一次派发：人看不到这个任务先后交给过哪些 agent、之前为什么失败");
  check("执行历史最新在前",
    html.indexOf("adp_hist_new") >= 0 && html.indexOf("adp_hist_new") < html.indexOf("adp_hist_old"),
    "最新的派发没有排在最前：人找当前这一次要翻到最底下");
  check("每次派发要说清节点/角色/模型/尝试次数/失败原因",
    html.includes("node_beta") && html.includes("node_alpha") && /角色：/u.test(html)
      && html.includes("anthropic:claude-sonnet-4-5") && html.includes("openai:gpt-5.5") && /第 2 次尝试/u.test(html) && /失败：/u.test(html),
    "执行历史缺了节点、角色、模型、尝试次数或失败原因中的某一项——「涉及哪些 agent 分别执行了什么」答不上来");
  check("执行历史每条派发要有「规则」入口",
    (html.match(/data-action="show-dispatch-rules"/gu) || []).length === 2,
    "执行历史没有「规则」入口：人看得到派给了谁、看不到按什么规则干的");
}

// 「流程导航」：登入后我在第几步、下一步去哪——每一步要如实反映真实状态，并能直达对应页。
function runWorkflowGuideCase() {
  const probe = loadConsole(el("div"));
  const admin = {accountId: "u1", email: "a@b.c", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"};
  const project = {id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []};
  const base = {projects: [project], taskGroups: [], agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [], findings: [],
    humanConfirmationRequests: [], humanDirectives: [], permissionRequests: [], approvalRequests: [], truncatedCollections: [], repositoryOutputs: [],
    agentExecutionEvents: [], checkpoints: [], reviewPlans: [], reviewBundles: [], fleet: {online: 0, total: 0}};
  const fresh = probe.renderProjectOverviewWith(base, admin, "p1");
  check("流程导航：全新项目要如实说尚未接入 agent、还没有任务组",
    /流程导航/u.test(fresh) && /尚未接入/u.test(fresh) && /还没有任务组/u.test(fresh),
    "流程导航没有如实说尚未接入：全新项目第一步就该告诉人先去接 agent，而不是显示成已在线");
  // 只看「流程导航」面板自身的切片（到它的收尾句为止）：面板后面紧跟的通知与别处的入口卡片也有 data-menu，
  // 切到下一个面板标题都会把它们夹进来——第一版就是这样在变异下绿着过去的。
  const guideOf = (html) => { const text = String(html); const start = text.indexOf("流程导航"); const end = text.indexOf("按当前项目实时计算", start); return start >= 0 ? text.slice(start, end > start ? end : undefined) : ""; };
  const freshGuide = guideOf(fresh);
  check("流程导航每一步要有「前往」直达对应页",
    /data-menu="proj-agents"/u.test(freshGuide) && /data-menu="tg"/u.test(freshGuide) && /data-menu="review"/u.test(freshGuide)
      && /data-menu="directives"/u.test(freshGuide) && /data-menu="monitor"/u.test(freshGuide),
    "流程导航没有「前往」：知道在第几步却点不过去，等于还是几个 tab");
  const group = {id: "tg1", projectId: "p1", name: "组一", status: "development", progress: 40, workItemCount: 3, workItems: [], blockers: []};
  const busy = {...base, taskGroups: [group], fleet: {online: 2, total: 3},
    agentDispatches: [{dispatchId: "d1", projectId: "p1", taskGroupId: "tg1", workItemId: "w1", status: "running"},
      {dispatchId: "d2", projectId: "p1", taskGroupId: "tg1", workItemId: "w2", status: "completed"}],
    humanDirectives: [{directiveId: "hd1", taskGroupId: "tg1", status: "queued"}],
    closeBarriers: [{taskGroupId: "tg1", blockers: [{gate: "x"}]}]};
  const running = probe.renderProjectOverviewWith(busy, admin, "p1");
  check("流程导航：接入/建组/工作项/派发/指令/收口各步按真实数据计数",
    /2 台在线/u.test(running) && /1 个任务组/u.test(running) && /3 个工作项/u.test(running) && /已派发 2 次/u.test(running)
      && /1 条指令待编排消费/u.test(running) && /1 个任务组还有关闭门阻塞/u.test(running),
    "流程导航的某一步没按真实数据算（在线数/任务组数/工作项数/派发数/待消费指令/关闭门阻塞）");
  // 「推进一拍」：能编排的账号在第 4 步就能启动，不必跑去监控页；没权限的不摆（看得到却按不动＝杠杆不可达）。
  const PERMS = ["task_group:review", "task_group:control", "task_group:orchestrate", "task_group:checkpoint_submit", "project:grant", "project:update", "agent:activate"];
  const operator = (perms) => ({accountId: "u2", accountType: "user_account", displayName: "操作员", organizationId: "org_default", effectivePermissions: perms});
  const canRun = guideOf(probe.renderProjectOverviewWith(busy, operator(PERMS), "p1"));
  const cannotRun = guideOf(probe.renderProjectOverviewWith(busy, operator(PERMS.filter((item) => item !== "task_group:orchestrate")), "p1"));
  check("有编排权限时，流程导航第 4 步就能「推进一拍」",
    /流程导航/u.test(canRun) && /data-action="orchestrator-run"/u.test(canRun),
    "有权限的人在流程导航里还是得跑去执行监控页才能启动");
  check("没有编排权限时，流程导航不摆「推进一拍」",
    /流程导航/u.test(cannotRun) && !/data-action="orchestrator-run"/u.test(cannotRun),
    "没有编排权限却摆了「推进一拍」：按下去必然 403，看得到却按不动");
  // 接入这条链的中间态：签了令牌还没人用 / 注册了但都离线 / 在线但另有离线——各说清卡在哪一环。
  const tokenIssued = {...base, agentJoinTokens: [{joinTokenId: "jt1", projectId: "p1", status: "issued", expiresAt: "2099-01-01T00:00:00.000Z"}]};
  check("流程导航：签发了令牌但还没有节点注册时要说清卡在安装这一环",
    /已签发 1 张入网令牌待使用/u.test(guideOf(probe.renderProjectOverviewWith(tokenIssued, admin, "p1"))),
    "签发了令牌却还说尚未接入：人不知道令牌已经发了、下一步是去 agent 主机上装");
  const registeredOffline = {...base, fleet: {online: 0, total: 2}};
  check("流程导航：注册了但都离线时要说活派不出去",
    /已注册 2 台，但没有在线的/u.test(guideOf(probe.renderProjectOverviewWith(registeredOffline, admin, "p1"))),
    "注册了但全离线，导航却没说清活派不出去");
  check("流程导航：在线但另有离线时要一并说",
    /2 台在线，另 1 台离线/u.test(guideOf(probe.renderProjectOverviewWith(busy, admin, "p1"))),
    "有离线节点却只报在线数");
  // 复核类（评审计划/评审包等）的处置表单在执行监控页，不在人工审核页：导航要分开算、分开指路，
  // 否则找"复核"的人会去错页。一条开着的评审计划 → 第 6 步说 1 项等你收尾并指向监控页，第 5 步仍说暂无。
  const withPlan = {...busy, reviewPlans: [{reviewPlanId: "rp1", taskGroupId: "tg1", status: "open"}]};
  const planGuide = guideOf(probe.renderProjectOverviewWith(withPlan, admin, "p1"));
  check("流程导航：待收尾的评审计划要算进「人工复核 / 阻塞处置」并指向执行监控页",
    /人工复核 \/ 阻塞处置/u.test(planGuide) && /1 项等你收尾/u.test(planGuide) && /data-menu="monitor"/u.test(planGuide),
    "复核项没有算进人工复核这一步：找复核的人不知道它在执行监控页");
  check("流程导航：复核项不该混进「人工审核 / 定稿」的计数",
    /暂无等你处理的审核项/u.test(planGuide),
    "复核项被算进了人工审核：人去人工审核页找，那里没有");
  // 无权者不能被告知"暂无"：范围内有待办、只是你没权限——要如实说在等有权的人（缺省不得等于有利结果）。
  const withBoth = {...busy, reviewPlans: [{reviewPlanId: "rp1", taskGroupId: "tg1", status: "open"}],
    humanConfirmationRequests: [{requestId: "hc1", taskGroupId: "tg1", status: "pending"}]};
  const noReview = guideOf(probe.renderProjectOverviewWith(withBoth, operator(PERMS.filter((item) => item !== "task_group:review")), "p1"));
  check("流程导航：没有审核权限的人要被告知在等有权的人处置，而不是暂无",
    /有 1 项在等有权的人处置/u.test(noReview) && !/暂无等你处理的审核项/u.test(noReview) && !/暂无等你收尾的复核项/u.test(noReview),
    "无权限的人被告知暂无：范围内明明有待办、只是他没权限，屏幕却说没有");
}


// 「结果」：每个任务能看到它产出了什么——仓库产出到哪一步、检查点的 Git 证据；没有产出要如实说，推送与否不能含糊。
function runWorkItemResultCase() {
  const probe = loadConsole(el("div"));
  const group = {id: "tg_r", projectId: "p1", roles: [], workItems: [{id: "w_r", title: "结果探针单元", status: "in_progress", progress: 50, ownerRole: "agent-runtime"}]};
  const baseState = {projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}], taskGroups: [group],
    agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [], findings: [], humanConfirmationRequests: [], humanDirectives: [],
    truncatedCollections: [], repositoryOutputs: [], checkpoints: []};
  const detail = {taskGroupId: "tg_r", progress: {}, config: null, roomMessages: []};
  const none = probe.renderTaskGroupDetail(detail, group, baseState);
  check("工作项卡：没有产出时要如实说还没有", /结果：还没有产出/u.test(none), "没有任何产出的任务，卡上一个字都不提结果");
  const pushed = probe.renderTaskGroupDetail(detail, group, {...baseState,
    repositoryOutputs: [{taskGroupId: "tg_r", workItemId: "w_r", repositoryId: "repo_x", branch: "feat/x", status: "pushed"}],
    checkpoints: [{taskGroupId: "tg_r", workId: "w_r", commitRefs: ["c1"], pushRefs: ["p1"]}]});
  check("工作项卡：结果要说清仓库产出到哪一步与检查点的 Git 证据",
    /结果：/u.test(pushed) && pushed.includes("repo_x") && pushed.includes("feat/x") && /检查点 1 个/u.test(pushed) && /有提交/u.test(pushed) && /已推送/u.test(pushed),
    "任务的结果（仓库/分支/状态/提交/推送）没有在卡上说清");
  const unpushed = probe.renderTaskGroupDetail(detail, group, {...baseState,
    checkpoints: [{taskGroupId: "tg_r", workId: "w_r", commitRefs: ["c1"], pushRefs: []}]});
  check("工作项卡：有提交没推送时要说未推送",
    /有提交/u.test(unpushed) && /未推送/u.test(unpushed) && !/已推送/u.test(unpushed),
    "没推送却说已推送：人会以为改动已经到远端了");
}


// 人工指令以任务组为目标：没有任务组时不能只说"暂无"，要告诉人先去哪一页建、并给按钮。
function runDirectivesEmptyExitCase() {
  const probe = loadConsole(el("div"));
  const admin = {accountId: "u1", email: "a@b.c", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"};
  const html = probe.renderDirectivesWith({projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
    taskGroups: [], humanDirectives: [], truncatedCollections: []}, admin, "p1");
  check("人工指令页没有任务组时要指路去「任务组」页并给按钮",
    /先到「任务组」页/u.test(html) && /data-menu="tg"/u.test(html),
    "人工指令页空态只说暂无任务组、不给出口：人不知道指令为什么发不了、该去哪建");
}

function runRoomVisibilityCase() {
  const probe = loadConsole(el("div"));
  const spoken = "我建议把订单状态机换成事件溯源，评审那步可以跳过";
  const html = probe.renderTaskGroupDetail({
    taskGroupId: "tg_x",
    progress: {},
    config: null,
    roomMessages: [{
      messageId: "room_msg_1", roomId: "room_tg_x", sequence: 7,
      senderRef: "agent_node:node_a", payload: {text: spoken}, createdAt: "2026-08-02T00:00:00.000Z"
    }]
  }, {id: "tg_x", roles: []});

  check("房间消息对人可见",
    html.includes(spoken),
    "任务组详情里没有呈现房间消息 —— agent 之间谈成的方案，人只看得到送上来的结论，看不到过程");
  // 这一屏取的是【最近】的若干条，而不是从头 50 条：按游标从头取会正好错过谈成结论的那一段。
  // 而截掉的部分必须说出来 —— 50 条和"只有 50 条"在屏幕上长得一模一样，人会以为自己看全了。
  {
    const detailBase = {taskGroupId: "tg_x", progress: {}, config: null,
      roomMessages: [{messageId: "room_msg_9", roomId: "room_tg_x", sequence: 119,
        senderRef: "agent_node:node_a", payload: {text: spoken}, createdAt: "2026-08-02T00:00:00.000Z"}]};
    const truncatedHtml = probe.renderTaskGroupDetail({...detailBase, roomMessageTotal: 120, roomMessagesTruncated: true},
      {id: "tg_x", roles: []});
    check("房间消息被截断时要说清共有多少条",
      /共 120 条，这里显示最近/.test(truncatedHtml),
      "房间消息被截断却不报总数 —— 人以为自己看完了整段协商，其实只看到一部分");
    check("没有截断时不挂那句提示",
      !/这里显示最近/.test(probe.renderTaskGroupDetail({...detailBase, roomMessageTotal: 1, roomMessagesTruncated: false}, {id: "tg_x", roles: []})),
      "没有截断也说只显示最近若干条 —— 常亮的提示等于没有提示");
  }


  check("显示服务端署名",
    html.includes("agent_node:node_a"),
    "没有显示消息的发送者，人无法分辨哪句话是谁说的");

  // 没有消息时必须明说这条通道存在但为空，而不是整块不出现 —— 整块不出现会让人以为
  // 「没有协商过程」，而实际是「这个页面根本不显示协商过程」。两者对定稿判断的影响完全相反。
  const emptyHtml = probe.renderTaskGroupDetail({taskGroupId: "tg_x", progress: {}, config: null, roomMessages: []},
    {id: "tg_x", roles: []});
  // 只查「页面里出现了协作记录这四个字」是查不出问题的 —— 区块标题本身就含这四个字，正文空掉
  // 也照样通过。要查的是【正文】非空，所以从标题处切出这一块的正文再判断。
  const emptyBody = sectionBodyOf(emptyHtml, "协作记录");
  // 提取不出来是【探针与页面脱节】，不是页面有缺陷。混成一条会让人去改页面，而该改的是这里。
  check("正文提取器仍然有效",
    emptyBody !== null,
    "切不出协作记录这一块的正文（sectionBlock 的结构变了）—— 这是本门自己脱节了，不是页面的问题");
  if (emptyBody !== null) {
    check("空房间也要现身",
      emptyBody.replace(/<[^>]*>/g, "").trim().length > 8,
      `房间没有消息时这一块正文是空的（正文 ${JSON.stringify(emptyBody.slice(0, 40))}），`
      + "人会把「页面不显示协商过程」误读成「没有协商过程」——这两件事对定稿判断的影响完全相反");
  }

  // 接线：面板再好，不去拉数据就永远是空的。
  check("详情页确实去拉了房间",
    /\/api\/rooms\//.test(probe.loadTaskGroupDetailSource()),
    "loadTaskGroupDetail 没有请求房间消息，面板永远显示为空");
}

// 处置类下拉的第一项恰好都是后果最重的那个（已解决 / 关闭 / 采纳为本项目规则 / 激活为全局规范），
// 而 select 默认选中第一项 —— 人点开表单直接提交，拿到的就是最重的处置，而他没做过这个判断。
function runDecisionSelectCase() {
  const probe = loadConsole(el("div"));
  const html = probe.decisionSelect("status", [["active", "采纳为本项目规则"], ["rejected", "不采纳"]], "请选择判定…");
  const firstOption = html.slice(html.indexOf("<option"), html.indexOf("</option>"));
  check("默认不是任何一个实质选项",
    /value=""/.test(firstOption) && /\bselected\b/.test(firstOption),
    `处置下拉默认选中的是一个实质选项（首项：${firstOption}）—— 人不做选择直接提交就会拿到它`);
  check("占位项不可被选中提交",
    /\bdisabled\b/.test(firstOption),
    "占位项没有 disabled，人可以把「请选择」本身提交上去");
  check("未选择时提交被拦下",
    /<select[^>]*\brequired\b/.test(html),
    "处置下拉没有 required，浏览器不会在提交前拦下未做选择的表单，而服务端对空值的兜底各不相同");
  check("实质选项仍在",
    html.includes(">采纳为本项目规则<") && html.includes(">不采纳<"),
    "占位项把实质选项挤掉了");
}

// 服务端有六处直接把 error.message 当错误码回，于是 API 报错也常是 code:detail 形态。
// 这一段要真词表在场才看得见（本门其余部分把 t 桩成恒等函数）。
// 一屏常常并发取两三个接口。只报 "500 server_error" 时，人不知道是哪一个挂了 ——
// "组织数据没问题、是智能体列表挂了"与"整个组织视图都挂了"在屏幕上长得一模一样。
// 审计归档的哈希链告警是这套系统里最要紧的一条消息（"归档可能被改动过"）。
// 它只列前 3 处不一致，而原先没说这是【前 3 处】—— 查篡改的人以为自己看到的就是全部。
async function runAuditChainBreakNoticeCase() {
  const root = el("div");
  const probe = loadConsole(root);
  // 不要 stubNavigation：它把 render 换成空函数，而弹窗正是靠 render 落进 DOM 的（第一版就这么空转了）。
  // 先渲染一次带账号的页面：没有当前账号时 render() 出的是登录页，弹窗根本不在里面
  //（第一版就在看登录页的 HTML）。
  const admin = {accountId: "u1", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"};
  probe.renderFullPageWith({schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {}, projects: [],
    taskGroups: [], agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [], findings: [],
    humanConfirmationRequests: [], humanDirectives: [], truncatedCollections: []}, admin, null, "sys-overview");
  const breaks = Array.from({length: 7}, (_, index) => ({id: `audit_${index}`, reason: "hash_mismatch"}));
  probe.setFetch(async () => ({ok: true, status: 200, statusText: "OK", headers: {get: () => null},
    json: async () => ({entries: [], chain: {verified: 12, breaks}})}));
  // 事件处理是 event.target.closest("[data-action]") 取按钮的：closest 返回 null 时它直接退出
  // （第一版就这么空转了，两条断言都在看一个没渲染的弹窗）。
  // 桩要带 classList：产品对【每个】动作按钮都做 guardBtn.classList.add("is-loading")（防重提交，
  // 第 54 拍改成一律禁用），桩上没有它就在那一行抛 TypeError → 被页面级 catch 吞成「控制台这一页
  // 自己出错了」横幅 —— 而这几条归档断言的期望串恰好都能在横幅之外的页面上凑到，于是一直绿着，
  // 看的根本不是弹窗。下面那条「探针自查」就是为这件事立的。
  const button = {dataset: {action: "open-audit-archive"}, disabled: false, textContent: "查看审计归档",
    classList: {add() {}, remove() {}}};
  // closest 必须按选择器分辨：一律返回自己的话，前面 target.closest(".rule-row") 那一支会先命中，
  // 然后在没有 classList 的桩上抛错、被 try 吞掉 —— 表现为"点了没反应"。
  button.closest = (selector) => (selector === "[data-action]" ? button : null);
  await probe.click({target: button, preventDefault: () => {}});
  const shown = String(root.innerHTML || "");
  assertNoCrashBanner(shown, "归档弹窗（哈希链）");
  check("哈希链告警要说清一共几处不一致",
    /7 处不一致/.test(shown),
    `篡改告警没有给出总数（${shown.slice(0, 120)}）`);
  check("只列了前几处时要说出来",
    /仅列前 3 处/.test(shown),
    "只列了 3 处却不说这是前 3 处 —— 查篡改的人会以为自己看到的就是全部");
}

// 归档写失败过 = 这一屏少了东西。接口一直下发着 archiveFault，而弹窗从来没渲染它 ——
// 这一屏正是人专门来查历史的地方，"看起来完整"比别处更害人。
// 两支都验：有故障时要说不完整并给出丢了几条；没故障时不许平白吓人。
async function runArchiveFaultNoticeCase() {
  const admin = {accountId: "u1", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"};
  const openArchive = async (payload) => {
    const root = el("div");
    const probe = loadConsole(root);
    probe.renderFullPageWith({schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {}, projects: [],
      taskGroups: [], agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [], findings: [],
      humanConfirmationRequests: [], humanDirectives: [], truncatedCollections: []}, admin, null, "sys-overview");
    probe.setFetch(async () => ({ok: true, status: 200, statusText: "OK", headers: {get: () => null},
      json: async () => payload}));
    const button = {dataset: {action: "open-audit-archive"}, disabled: false, textContent: "查看审计归档",
      classList: {add() {}, remove() {}}};
    button.closest = (selector) => (selector === "[data-action]" ? button : null);
    await probe.click({target: button, preventDefault: () => {}});
    return String(root.innerHTML || "");
  };
  const faulted = await openArchive({entries: [], chain: {verified: 0, breaks: []},
    archiveFault: {lostEntries: 4, error: "EACCES: permission denied"}});
  assertNoCrashBanner(faulted, "归档弹窗（故障态）");
  check("归档写失败过时，这一屏要说清自己不完整",
    /这份归档不完整/u.test(faulted) && /4/u.test(faulted),
    `查历史的人看到的是一屏记录，却不知道有条目从没落盘（${faulted.slice(0, 140)}）`);
  check("并说出失败原因（人要据此判断能不能补救）",
    /EACCES/u.test(faulted),
    "只说不完整、不说为什么 —— 人不知道是盘满了还是权限没了");
  const healthy = await openArchive({entries: [], chain: {verified: 3, breaks: []}, archiveFault: null});
  check("归档没出过问题时不许平白说它不完整",
    !/这份归档不完整/u.test(healthy),
    "没有故障却报不完整 —— 这种狼来了会让真出事时那句话没人信");

  // 归档只按【尾部一窗】读取与校验（512KB）。文件长到几百 MB 时，这一屏说"未发现改动"，
  // 而窗口之外的记录一条都没查过 —— 人恰恰是为了查有没有被改动才打开这一屏的。
  // 服务端一直下发着 windowTruncated/bytesScanned/fileBytes，这里此前一个都没渲染。
  const windowed = await openArchive({entries: [], chain: {verified: 200, breaks: []}, archiveFault: null,
    windowTruncated: true, bytesScanned: 512 * 1024, fileBytes: 420 * 1024 * 1024});
  // 经 MCP 写入的行带 ref = mcp-audit.jsonl 里那一行的 callId。这一屏下面那句「摘要另存于
  // mcp-audit.jsonl」正是让人去那本账里查，而这里原先不显示 ref —— 等于让人去翻一本没有索引的账。
  const linked = await openArchive({chain: {verified: 2, breaks: []}, archiveFault: null, entries: [
    {id: "audit_1", at: "2026-08-27T00:00:00.000Z", actor: "mcp:agent_node:node_1", action: "mcp_tool_call",
      subject: "room-mcp.room_join · taskGroupId=tg_1", result: "succeeded", ref: "mcp_call_abc123"},
    {id: "audit_2", at: "2026-08-27T00:00:01.000Z", actor: "u1", action: "task_group_pause",
      subject: "TaskGroup:tg_1", result: "succeeded"}
  ]});
  check("归档页要显示每一行指向的 MCP 归档行",
    /mcp_call_abc123/u.test(linked),
    "归档页没显示它指向的 MCP 归档行 —— 人看到一次 MCP 写入，无法跳到它的入参/返回摘要");
  check("REST 侧的行没有 ref 时不许渲染成 undefined",
    !/undefined/u.test(linked),
    `没有 ref 的行把 undefined 印在了屏幕上：${(linked.match(/.{0,80}undefined.{0,40}/u) || [""])[0]}`);

  check("只校验了尾部一窗时要说出来",
    /只读了归档末尾/u.test(windowed),
    `这一屏说"未发现改动"，却没说窗口之外的记录一条都没查过（${windowed.slice(0, 160)}）`);
  check("并给出扫了多少、一共多少",
    /0\.5MB/u.test(windowed) && /420\.0MB/u.test(windowed),
    "只说'截断了'而不给量级，人判断不了漏掉的是十条还是几百万条");
  check("没被截断时不许平白说只读了一窗",
    !/只读了归档末尾/u.test(healthy),
    "整份都读完了却说只读了一窗 —— 同样是狼来了");
}

async function runFailingRequestIsNamedCase() {
  const probe = loadConsole(el("div"));
  probe.setFetch(async () => ({ok: false, status: 500, statusText: "Internal Server Error",
    json: async () => ({error: "server_error"})}));
  let thrown = null;
  try { await probe.api("/api/org/agents?orgId=org_default", {method: "GET"}); } catch (error) { thrown = error; }
  const message = String(thrown?.message || "");
  check("报错要说清是哪一次请求失败的",
    message.includes("/api/org/agents"),
    `报错里没有出请求路径（${JSON.stringify(message.slice(0, 90))}）—— 一屏并发取好几个接口，人不知道该查哪个`);
  check("路径不带查询串",
    !message.includes("orgId=org_default"),
    "把查询串也放进横幅了 —— 里面可能有项目 id 之类，屏幕上不必要");
  let networkThrown = null;
  probe.setFetch(async () => { throw new Error("fetch failed"); });
  try { await probe.api("/api/org/agents", {method: "GET"}); } catch (error) { networkThrown = error; }
  check("连不上时也要说清是哪一次请求",
    String(networkThrown?.message || "").includes("/api/org/agents"),
    "网络失败那条报错没有出请求路径");
}

async function runCodedApiErrorCase() {
  const probe = loadConsole(el("div"), {realI18n: true});
  probe.setFetch(async () => ({ok: false, status: 500, statusText: "Internal Server Error",
    json: async () => ({error: "skill_source_sync_failed:agency-agents-zh：同步失败（退出码 128：fatal: 凭据被拒）"})}));
  let thrown = null;
  try { await probe.api("/api/probe", {method: "POST"}); } catch (error) { thrown = error; }
  const message = String(thrown?.message || "");
  check("API 报错里的 code:detail 也要拆开翻译",
    /技能源同步失败/.test(message),
    `弹给人的提示还是一串英文键（实际：${JSON.stringify(message.slice(0, 120))}）`);
  check("API 报错翻译后细节不能丢",
    /凭据被拒/.test(message),
    "只剩翻译过的前缀，服务端给的原因没了");
}

// 服务端在不少错误里写了给人看的说明（message / reason / required）。前端原先只取 error 一个字段，
// 于是一条本来解释清楚了"为什么、接下来怎么办"的 409，到人眼前只剩一串英文枚举。
async function runErrorGuidanceCase() {
  const probe = loadConsole(el("div"));
  const cases = [
    {payload: {error: "org_member_invitation_pending", message: "该成员尚未接受邀请，不能启用"}, expect: "该成员尚未接受邀请"},
    {payload: {error: "policy_denied", reason: "组织已被暂停"}, expect: "组织已被暂停"},
    {payload: {error: "server_side_agent_execution_forbidden", required: ["请先注册一个 Agent Runtime 节点"]}, expect: "请先注册一个 Agent Runtime 节点"},
    // 配额超限时服务端已经算出了"哪一类、用了多少、上限多少"。只报"组织配额已超限"，
    // 人不知道是成员还是任务组、差多少，也不知道下一步去哪 —— 而这三样都在同一个响应里。
    {payload: {error: "org_quota_exceeded", quota: 200, usage: 200, kind: "taskGroups"}, expect: "任务组 200/200"},
    {payload: {error: "org_quota_exceeded", quota: 50, usage: 50, kind: "members"}, expect: "成员 50/50"},
    {payload: {error: "org_quota_exceeded", quota: 20, usage: 20, kind: "projects"}, expect: "组织管理"},
    // supported 与 required 是同一件事的两面：服务端已经把【合法清单】算出来了（12 处拒绝都带着它），
    // 前端原先一处都没读 —— 人看到的是"认不出的上报状态"，然后自己猜该填什么。
    {payload: {error: "dispatch_fail_status_unknown", supported: ["blocked", "cancelled", "failed"]},
      expect: "可用的取值：blocked、cancelled、failed"},
    {payload: {error: "unsupported_task_group_control_action", supported: ["pause", "resume"]},
      expect: "可用的取值：pause、resume"},
    // 服务端算出了"多久之后能再试"，词表里只写"请稍后再试" —— 人只能反复试到成功为止。
    {payload: {error: "too_many_login_attempts", retryAfterSeconds: 60}, expect: "60 秒后可再试"},
    // 谁关的、什么时候关的都在同一个响应里；不给的话人得自己去翻台账。
    {payload: {error: "task_group_already_closed", closedBy: "acct_owner", closedAt: "2026-08-20T10:00:00Z"},
      expect: "已由 acct_owner 关闭"},
    {payload: {error: "state_unreadable", hint: "按 file/code 指出的线索恢复"}, expect: "按 file/code 指出的线索恢复"},
    {payload: {error: "bootstrap_admin_required", received: "请求体里没有 admin 这一层"},
      expect: "收到的是：请求体里没有 admin 这一层"},
    {payload: {error: "project_has_open_task_groups", openTaskGroupIds: ["tg_a", "tg_b"]},
      expect: "还没关掉的任务组：tg_a、tg_b"},
    {payload: {error: "password_too_short", minLength: 8}, expect: "至少需要 8 位"},
    {payload: {error: "review_bundle_status_invalid", currentStatus: "consumed", allowedStatuses: ["rejected"]},
      expect: "当前状态：consumed"},
    {payload: {error: "review_bundle_status_invalid", currentStatus: "consumed", allowedStatuses: ["rejected"]},
      expect: "可以转到：rejected"},
    {payload: {error: "changed_paths_inside_repository_target_denylist", deniedPaths: [".github/workflows/ci.yml"]},
      expect: "踩到禁区的路径：.github/workflows/ci.yml"},
    // expected/actual 是一对：只说"应该是 X"，人还是不知道差在哪。
    {payload: {error: "checkpoint_tree_digest_mismatch", expected: "git-tree:aaa", actual: "git-tree:bbb"},
      expect: "应为 git-tree:aaa，实际 git-tree:bbb"},
    {payload: {error: "human_confirmation_already_decided", subjectRef: "WorkItem:w_api"},
      expect: "这张卡管的是：WorkItem:w_api"},
    // state_storage_corrupt 的中文明写着"报文里的 file 指出是哪一份" —— 那就必须真的显示出来，
    // 否则这句话把人指向一个他看不到的东西（造了一次真损坏才发现）。
    {payload: {error: "state_storage_corrupt", kind: "control_plane_state_corrupt", file: "control-plane-state.json"},
      expect: "涉及的文件：control-plane-state.json"},
    {payload: {error: "state_storage_unavailable", code: "ENOSPC"}, expect: "系统错误码：ENOSPC"},
    // 白名单拒绝必须带上白名单：合法取值就在被测代码的上一行，而回执原先只有一个码 ——
    // 调用方只知道"你给的不行"，不知道什么行，只能穷举重试。
    {payload: {error: "permission_request_status_invalid", received: "granted",
      allowedStatuses: ["approved", "rejected"]}, expect: "可以转到：approved、rejected"},
    // 产出目标被拒有两种完全不同的原因，原先共用一个裸码：清单配置不合法（不是调用方的错）、
    // 那条路径 git 跟不住（调用方能改）。两者都不带真实取值，人只看到"必须用 git 跟得住的路径"。
    {payload: {error: "repository_output_target_must_use_git_trackable_paths",
      cause: "path_allowlist_invalid", allowedPaths: ["docs/**", "spec/**"]},
      expect: "原因：允许路径清单本身不合法"},
    {payload: {error: "repository_output_target_must_use_git_trackable_paths",
      cause: "manifest_path_not_git_trackable", path: "../outside.json"},
      expect: "涉及的路径：../outside.json"},
    // 这个码在【运行时够不着】：清单要走到它，必须先在 changedPaths 里
    //（artifact_manifest_not_changed_in_commit 那道），而任何越出白名单的改动都会更早撞上
    // changed_paths_outside_repository_target_allowlist（整体校验）—— 两道合起来把它围死了。
    // 它原先登记在 known-second-doors 里；这条断言验的是【界面拿到它时说什么】，不是可达性。
    // 整体校验一旦放宽，它就是最后一道，那时这段说明就是它的来历。
    {payload: {error: "artifact_manifest_outside_allowlist",
      path: "tmp/x.json", allowedPaths: ["docs/**", "spec/**"]},
      expect: "当前允许的路径：docs/**、spec/**"},
    // 这条报文让运维"重新执行入网安装命令升级"，那就得说清差在哪一版。
    {payload: {error: "checkpoint_claim_epoch_required", requiredRuntimeVersion: "0.3.0", nodeRuntimeVersion: "0.2.1"},
      expect: "需要的运行时版本：0.3.0（该节点当前 0.2.1）"},
    {payload: {error: "checkpoint_claim_epoch_stale", presented: 2, claimEpoch: 5},
      expect: "你带的认领代次 2，当前是 5"}
  ];
  for (const item of cases) {
    probe.setFetch(async () => ({ok: false, status: 409, statusText: "Conflict", json: async () => item.payload}));
    let thrown = null;
    try { await probe.api("/api/probe", {method: "POST"}); } catch (error) { thrown = error; }
    if (!thrown) {
      check(`错误说明可见:${item.payload.error}`, false, "失败响应没有抛出错误");
      continue;
    }
    check(`错误说明可见:${item.payload.error}`,
      String(thrown.message).includes(item.expect),
      `服务端写的说明没有到达人（实际提示：${JSON.stringify(String(thrown.message).slice(0, 120))}）—— 人只看到一串英文错误码，而说明就在同一个响应里`);
  }
}

// 上面那批用的是桩词表（t 原样返回键），所以它们证明不了"kind 被翻译了"。
// 而 kind 恰恰是个英文蛇形码，人看到它的时刻正是控制面状态损坏那一刻 ——
// 最不该甩标识符的时候。这一条必须用【真词表】，否则断言与被测行为都在同一层假设上。
// 实测：把 t(payload.kind) 换回 payload.kind，整套控制台门 255 条断言全绿（接线没人守）。
{
  const realProbe = loadConsole(el("div"), {realI18n: true});
  realProbe.setFetch(async () => ({ok: false, status: 503, statusText: "Service Unavailable",
    json: async () => ({error: "state_storage_corrupt", kind: "control_plane_state_corrupt",
      file: "control-plane-state.json"})}));
  let storageError = null;
  try { await realProbe.api("/api/probe", {method: "POST"}); } catch (error) { storageError = error; }
  const said = String(storageError?.message || "");
  check("状态损坏时说的是中文的故障类型，不是英文码",
    /故障类型：控制面状态文件内容已损坏/u.test(said),
    `人看到的是：${JSON.stringify(said.slice(0, 160))} —— 出事那一刻甩给人一个英文标识符`);
  // 正面对照：真词表确实加载上了。少了这一条，词表没加载时上面那条会因为"两边都是原码"而误判。
// 人点名要的页给不了时（页 id 不认识 / 这个页在他的视角下没有），控制台此前静默换成默认页。
// 后果：人以为链接生效了、眼前这页就是他要的那页 —— 而系统明明知道不是。
// 实测这条静默回落把勘察工具也骗了：拿三个不存在的页 id 渲染，出来的全是「系统概览」。
{
  const notices = [];
  const navProbe = loadConsole(el("div"), {realI18n: true});
  navProbe.captureToast((message) => notices.push(String(message)));
  const account = {accountId: "u1", email: "a@b.c", accountType: "system_admin",
    displayName: "管理员", organizationId: "org_default"};
  const bare = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {}, projects: [],
    organizations: [{orgId: "org_default", name: "默认组织", status: "active"}],
    taskGroups: [], agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [],
    findings: [], humanConfirmationRequests: [], humanDirectives: [], truncatedCollections: []};
  navProbe.renderFullPageWith(bare, account, null, "org-members");
// "技能源接了但一个角色技能都没取下来"与"全退役了"后果完全一样：agent 拿到的都是内置通用规则。
// 而提示的条件此前只认后者 —— 新部署撞的恰恰是前者（种子里的源是 configured、角色数 0，不算退役）。
{
  const skillProbe = loadConsole(el("div"), {realI18n: true});
  // 服务端下发的是【按来源分组的计数】，不是技能数组：界面从不读正文，
  // 而整份 roleSkills 是状态里最大的一块（真实部署 281 条 293KB），还会被视图上限截断。
  const builtIn = {"system-default": 2};
  const neverSynced = skillProbe.skillSourceNotice(
    [{sourceId: "agency-agents-zh", status: "configured"}], builtIn);
  check("技能源接了但一条都没取下来时要说出来（新部署撞的就是这个）",
    /一个角色技能都还没取下来/u.test(neverSynced) && /同步/u.test(neverSynced),
    `未同步时说的是：${JSON.stringify(neverSynced.slice(0, 140))}`);
  // 内置技能也是 0 个时，不能说「都在用系统内置技能（共 0 个）」——那时 agent 没有任何角色技能。
  const nothingAtAll = skillProbe.skillSourceNotice(
    [{sourceId: "agency-agents-zh", status: "configured"}], {});
  check("内置技能也为 0 时要说「没有任何角色技能可用」，不许说「都在用内置技能（共 0 个）」",
    /没有任何角色技能可用/u.test(nothingAtAll) && !/共 0 个/u.test(nothingAtAll),
    `说的是：${JSON.stringify(nothingAtAll.slice(0, 160))}`);
  const allRetired = skillProbe.skillSourceNotice(
    [{sourceId: "agency-agents-zh", status: "retired"}], builtIn);
  check("全退役时仍照旧提示（这条不能因为改条件而丢掉）",
    /当前没有可用的技能源/u.test(allRetired),
    `全退役时说的是：${JSON.stringify(allRetired.slice(0, 140))}`);
  const healthy = skillProbe.skillSourceNotice(
    [{sourceId: "agency-agents-zh", status: "active"}],
    {...builtIn, "agency-agents-zh": 1});
  check("源真的提供了技能时不许再吓唬人（正面对照）",
    healthy === "",
    `源已可用却仍在提示：${JSON.stringify(healthy.slice(0, 140))}`);
}

// 侧栏菜单此前只有短标题；系统/组织/项目空间虽然已经分开，普通中文用户仍要逐页点开，
// 才知道「人工指令」「执行监控」「系统设置」「AI 智能体」各自管什么。
// 菜单用途说明不能另写一份文案：页面标题、副标题和菜单说明都必须取 PAGE_META 这一处真相源。
{
  const meta = Object.fromEntries([...readConsoleNavigationSource()
    .matchAll(/^\s*"([a-z][a-z0-9-]+)":\s*\["([^"]+)",\s*"([^"]+)"/gmu)]
    .map((hit) => [hit[1], {title: hit[2], desc: hit[3]}]));
  const navState = {
    schemaVersion: "runtime-state/v1",
    stateVersion: 1,
    runtime: {status: "ok", services: [], mcp: {toolCount: 44}},
    projects: [{id: "p1", name: "项目一", status: "active", organizationId: "org_default", progress: {percent: 0, phase: "draft", health: "ok"}}],
    organizations: [{orgId: "org_default", name: "默认组织", status: "active", usage: {members: 1, projects: 1, taskGroups: 0, agents: 0}, quotas: {maxMembers: 10, maxProjects: 10, maxTaskGroups: 20, maxAgents: 20}}],
    accounts: [], accessGrants: [], agents: [], taskGroups: [], agentDispatches: [], workSessions: [],
    closeBarriers: [], qualityGates: [], findings: [], humanConfirmationRequests: [], humanDirectives: [],
    approvalRequests: [], permissionRequests: [], truncatedCollections: []
  };
  const renderedNav = (account, projectId, pageId) => {
    const rootEl = el("div");
    loadConsole(rootEl, {realI18n: true}).renderFullPageWith(navState, account, projectId, pageId);
    return String(rootEl.innerHTML || "").replace(/<!--[\s\S]*?-->/gu, "");
  };
  const assertMenuDescriptions = (label, html, pageIds) => {
    for (const pageId of pageIds) {
      check(`${label}侧栏菜单要显示「${meta[pageId]?.title || pageId}」用途说明`,
        html.includes(`<span class="nav-item-desc">${meta[pageId]?.desc}</span>`),
        `菜单只有短标题或说明没有取自 PAGE_META：${pageId} / ${meta[pageId]?.desc}`);
    }
  };
  const systemNav = renderedNav({accountId: "sys", email: "sys@local", displayName: "系统管理员",
    accountType: "system_admin", roles: ["system_owner"], permissions: ["system:*"], organizationId: null}, null, "sys-overview");
  assertMenuDescriptions("系统管理", systemNav, ["sys-overview", "sys-orgs", "sys-settings"]);
  const orgNav = renderedNav({accountId: "org", email: "org@local", displayName: "组织管理员",
    accountType: "org_admin", roles: ["org_admin"], permissions: ["org:*", "project:create", "member:invite", "agent:activate"], organizationId: "org_default"}, "p1", "org-overview");
  assertMenuDescriptions("组织管理", orgNav, ["org-overview", "org-members", "org-agents", "org-projects"]);
  const projectNav = renderedNav({accountId: "user", email: "user@local", displayName: "项目成员",
    accountType: "user_account", roles: ["workspace_owner"], permissions: ["project:view", "project:update", "task_group:control", "task_group:review"], organizationId: "org_default"}, "p1", "proj-overview");
  const projectMenuOrder = ["proj-overview", "proj-members", "proj-agents", "tg", "monitor", "review", "directives", "proj-settings"];
  assertMenuDescriptions("项目管理", projectNav, projectMenuOrder);
  check("项目管理侧栏顺序要贴合执行路径",
    projectMenuOrder.every((pageId, index) => index === 0
      || projectNav.indexOf(`data-menu="${pageId}"`) > projectNav.indexOf(`data-menu="${projectMenuOrder[index - 1]}"`)),
    "项目菜单顺序没有按概览、Agent 准备、任务组织、实时监控、人工介入、控制补充、配置调整排列");
  check("项目管理侧栏要按普通管理动作分栏目",
    /<div class="nav-divider">项目总览<\/div>/u.test(projectNav)
      && /<div class="nav-divider">准备与接入<\/div>/u.test(projectNav)
      && /<div class="nav-divider">执行推进<\/div>/u.test(projectNav)
      && /<div class="nav-divider">人工控制<\/div>/u.test(projectNav)
      && /<div class="nav-divider">治理配置<\/div>/u.test(projectNav)
      && projectNav.indexOf("项目总览") < projectNav.indexOf('data-menu="proj-overview"')
      && projectNav.indexOf("准备与接入") < projectNav.indexOf('data-menu="proj-members"')
      && projectNav.indexOf("准备与接入") < projectNav.indexOf('data-menu="proj-agents"')
      && projectNav.indexOf("准备与接入") > projectNav.indexOf('data-menu="proj-overview"')
      && projectNav.indexOf("执行推进") < projectNav.indexOf('data-menu="tg"')
      && projectNav.indexOf("执行推进") < projectNav.indexOf('data-menu="monitor"')
      && projectNav.indexOf("执行推进") > projectNav.indexOf('data-menu="proj-agents"')
      && projectNav.indexOf("人工控制") < projectNav.indexOf('data-menu="review"')
      && projectNav.indexOf("人工控制") < projectNav.indexOf('data-menu="directives"')
      && projectNav.indexOf("人工控制") > projectNav.indexOf('data-menu="monitor"')
      && projectNav.indexOf("治理配置") < projectNav.indexOf('data-menu="proj-settings"')
      && projectNav.indexOf("治理配置") > projectNav.indexOf('data-menu="directives"'),
    "项目管理侧栏仍是平铺功能清单，没有把项目总览、准备接入、执行推进、人工控制和治理配置分开");
  const membersRoot = el("div");
  const membersProbe = loadConsole(membersRoot, {realI18n: true});
  const projectMemberState = {
    ...navState,
    projects: [{id: "p1", name: "项目一", organizationId: "org_default", status: "active", members: [
      {accountId: "acct_admin", role: "project_admin"},
      {accountId: "acct_reviewer", role: "reviewer"},
      {accountId: "acct_agent", role: "agent_operator"},
      {accountId: "acct_viewer", role: "viewer"}
    ]}],
    accountDirectory: {acct_admin: "项目管理员", acct_reviewer: "评审人甲", acct_agent: "Agent 操作员", acct_viewer: "观察者甲"},
    taskGroups: [], agentDispatches: [], humanDirectives: []
  };
  const projectMembersHtml = membersProbe.renderProjectMembersWith(projectMemberState,
    {accountId: "acct_admin", email: "admin@local", displayName: "项目管理员",
      accountType: "user_account", roles: ["project_admin"],
      effectivePermissions: ["project:view", "project:update", "project:grant", "agent:activate", "task_group:read", "task_group:control", "task_group:review"],
      organizationId: "org_default"}, "p1",
    [{accountId: "acct_new", displayName: "待授权成员", accountType: "user_account", status: "active", organizationId: "org_default"}]);
  const projectMembersPanelAt = (title) => projectMembersHtml.indexOf(`<h2>${title}</h2>`);
  {
    const bundles = [...projectMembersHtml.matchAll(/<details class="guide-bundle"( open)?>([\s\S]*?)<\/details>/gu)];
    check("项目成员页的「成员协作流程」要收进默认关闭的折叠块（列表与授权表单留在外面）",
      bundles.length === 1 && !bundles[0][1] && bundles[0][2].includes("<h2>成员协作流程</h2>")
        && !bundles[0][2].includes("<h2>项目成员列表</h2>") && !bundles[0][2].includes("<h2>项目成员授权</h2>"),
      `折叠块 ${bundles.length} 个（默认打开 ${bundles.filter((m) => m[1]).length} 个）—— 成员列表被三层引导推到下面`);
  }
  check("项目成员权限页要先总览、再看板、再流程、再成员列表、最后授权表单",
    projectMembersPanelAt("成员权限总览") >= 0
      && projectMembersPanelAt("成员权限总览") < projectMembersPanelAt("成员权限操作看板")
      && projectMembersPanelAt("成员权限操作看板") < projectMembersPanelAt("成员协作流程")
      && projectMembersPanelAt("成员协作流程") < projectMembersPanelAt("项目成员列表")
      && projectMembersPanelAt("项目成员列表") < projectMembersPanelAt("项目成员授权"),
    "项目成员权限页没有按普通用户先看现状、再看动作、再看流程、最后操作的顺序组织");
  check("项目成员权限页必须说明成员角色如何影响 Agent、任务组、审核和监控",
    /智能体操作员/u.test(projectMembersHtml)
      && /任务组负责人/u.test(projectMembersHtml)
      && /评审人/u.test(projectMembersHtml)
      && /Agent 加入令牌/u.test(projectMembersHtml)
      && /执行监控/u.test(projectMembersHtml)
      && /授权不会直接启动任务/u.test(projectMembersHtml),
    "项目成员权限页仍只是成员表或授权表单，没有说明角色与 Agent、任务组、审核、监控之间的关系");
  check("项目成员权限页的授权表单要锁定当前项目，避免跨项目误授权",
    /data-form="project-member"/u.test(projectMembersHtml)
      && /name="projectId" value="p1" readonly/u.test(projectMembersHtml)
      && /当前项目：项目一/u.test(projectMembersHtml)
      && !/<select name="projectId">/u.test(String(projectMembersHtml).slice(projectMembersPanelAt("项目成员授权"))),
    "项目内授权表单仍允许在同一页切到别的项目，用户以为在当前项目授权但实际可能提交到别处");
  const styles = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/styles.css"), "utf8");
  check("侧栏空间名要有明确 brand-section 类，不许再靠 .brand span 误伤图形标识",
    /<span class="brand-section">/u.test(systemNav)
      && !/\.brand span\b/u.test(styles),
    "品牌区仍在用 .brand span 这类宽选择器：它会把左上角「智」标识当成说明文字一起改样式或隐藏");
  check("移动端侧栏菜单隐藏用途说明，避免横向菜单被长文案撑开",
    /@media \(max-width: 860px\)[\s\S]*\.nav-item-desc \{ display: none; \}/u.test(styles),
    "桌面菜单说明已加，但移动端没有隐藏，390px 横向菜单会被长说明撑宽");
  check("移动端只隐藏空间说明，不隐藏品牌图形标识",
    /@media \(max-width: 860px\)[\s\S]*\.brand \.brand-section \{ display: none; \}/u.test(styles),
    "移动端隐藏规则仍可能把 .brand-mark 一起藏掉，首屏会失去系统识别锚点");
  const sidebarWidth = Number(/\.sidebar \{[\s\S]*?\bwidth:\s*(\d+)px/u.exec(styles)?.[1] || 0);
  const sidebarBasis = Number(/\.sidebar \{[\s\S]*?\bflex:\s*0\s+0\s+(\d+)px/u.exec(styles)?.[1] || 0);
  check("桌面侧栏要给中文用途说明足够宽度，width 与 flex-basis 必须一致",
    sidebarWidth >= 256 && sidebarWidth === sidebarBasis,
    `侧栏宽度 ${sidebarWidth}px / flex-basis ${sidebarBasis}px：菜单说明会过度换行或布局声明不一致`);
  check("移动端侧栏仍要覆盖为 100%，不能把桌面宽度带到窄屏",
    /@media \(max-width: 860px\)[\s\S]*\.sidebar \{ width: 100%; flex: none;/u.test(styles),
    "桌面侧栏加宽后，移动端没有明确改回 100%，390px 首屏可能被固定宽度撑开");
  check("菜单待办徽标不可收缩，长标题或未来新增入口不能把数字压扁",
    /\.nav-badge \{[^}]*flex:\s*0\s+0\s+auto/u.test(styles),
    "待办徽标没有 flex: 0 0 auto，标题行空间紧张时计数可能被压缩");
}

// 点「运行自治循环」拿到的回执此前被整个丢掉，一律弹"已触发编排循环"。
// 而这一拍完全可能【跑了但什么都没推进】：技能源同步失败会让整轮提前返回，
// changed 里只留一条 blocked_resource —— 人以为成功了，下次再点还是同样的结果。
{
  const cycleProbe = loadConsole(el("div"), {realI18n: true});
  const account = {accountId: "u1", email: "a@b.c", accountType: "system_admin",
    displayName: "管理员", organizationId: "org_default"};
  const bare = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {}, projects: [],
    organizations: [{orgId: "org_default", name: "默认组织", status: "active"}],
    taskGroups: [], agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [],
    findings: [], humanConfirmationRequests: [], humanDirectives: [], truncatedCollections: []};
  const said = [];
  const runWith = async (payload) => {
    said.length = 0;
    cycleProbe.renderFullPageWith(bare, account, null, "monitor");
    cycleProbe.setFetch(async () => ({ok: true, status: 200, headers: {get: () => null},
      json: async () => payload}));
    // stubNavigation 会把 toast 整个换掉 —— 捕获必须【装在它之后】，否则捕不到任何东西
    // （第一版装在前面，三条断言拿到的都是空字符串）。
    cycleProbe.stubNavigation();
    cycleProbe.captureToast((message) => said.push(`info:${message}`));
    cycleProbe.captureToastKind("success", (message) => said.push(`success:${message}`));
    cycleProbe.captureToastKind("error", (message) => said.push(`error:${message}`));
    const button = {dataset: {action: "orchestrator-run"}, disabled: false, textContent: "运行自治循环"};
    button.closest = (selector) => (selector === "[data-action]" ? button : null);
    await cycleProbe.click({target: button, preventDefault: () => {}});
    return said.join(" | ");
  };
  // 暂停/恢复的回执里带着"叫停/放行了几个派发"，此前也被整个丢掉：
  // 无论停住了三个还是一个都没有，人看到的都是同一句"已暂停任务组"。
  // 而暂停的全部意义就是停住在跑的活 —— 这两种情形对下达暂停的人是两件事。
  const controlSaid = async (action, runtimeControl) => {
    said.length = 0;
    cycleProbe.renderFullPageWith(bare, account, null, "tg");
    cycleProbe.setFetch(async () => ({ok: true, status: 200, headers: {get: () => null},
      json: async () => ({taskGroup: {id: "tg1"}, runtimeControl})}));
    cycleProbe.stubNavigation();
    cycleProbe.captureToastKind("success", (message) => said.push(String(message)));
    cycleProbe.captureToastKind("error", (message) => said.push(String(message)));
    const button = {dataset: {action: "task-control", task: "tg1", taskAction: action},
      disabled: false, textContent: "暂停"};
    button.closest = (selector) => (selector === "[data-action]" ? button : null);
    await cycleProbe.click({target: button, preventDefault: () => {}});
    return said.join(" | ");
  };
  const stoppedSaid = await controlSaid("pause", {controlCommands: [{}, {}], directDispatches: [{}], resumedDispatches: []});
  check("暂停时要说出叫停了几个在跑的派发",
    /叫停了 3 个/u.test(stoppedSaid),
    `暂停时说的是：${JSON.stringify(stoppedSaid.slice(0, 120))}`);
  const nothingSaid = await controlSaid("pause", {controlCommands: [], directDispatches: [], resumedDispatches: []});
  check("本来就没有在跑的派发时要说清楚（不能与'叫停了N个'共用一句话）",
    /当前没有在跑的派发/u.test(nothingSaid),
    `没有在跑时说的是：${JSON.stringify(nothingSaid.slice(0, 120))}`);
  const resumedSaid = await controlSaid("resume", {controlCommands: [], directDispatches: [], resumedDispatches: [{}, {}]});
  check("恢复时要说出放行了几个派发",
    /放行了 2 个/u.test(resumedSaid),
    `恢复时说的是：${JSON.stringify(resumedSaid.slice(0, 120))}`);

  const blockedSaid = await runWith({changed: [{status: "blocked_resource", reason: "skill_source_sync_failed"}]});
  check("这一拍被挡住时不许说成'已触发'（人会以为成功了）",
    /error:/u.test(blockedSaid) && /被挡住/u.test(blockedSaid),
    `被挡住时说的是：${JSON.stringify(blockedSaid.slice(0, 140))}`);
  check("被挡住时要说出是被什么挡住的",
    /技能源同步失败/u.test(blockedSaid),
    `没有点名原因：${JSON.stringify(blockedSaid.slice(0, 140))}`);
  const idleSaid = await runWith({changed: []});
  check("跑了但没有可做的事，要说出来（不能与'推进了'共用一句话）",
    /没有可推进的事项/u.test(idleSaid),
    `空转一拍说的是：${JSON.stringify(idleSaid.slice(0, 140))}`);
  const movedSaid = await runWith({changed: [{status: "dispatched"}, {status: "dispatched"}]});
  check("真推进了要报出推进了几项",
    /推进了 2 项/u.test(movedSaid),
    `推进两项时说的是：${JSON.stringify(movedSaid.slice(0, 140))}`);
}

// 列表为空【不等于】没有记录 —— 加载失败时它可能压根没取回来。
// 顶部横幅说"整页加载失败"，而表格里那句"暂无数据"是在断言"确实一条都没有"：
// 两句话矛盾时，人信的是离数据最近的那一句 —— "接口挂了"就被读成"这个组织没有成员"。
{
  const emptyProbeReal = loadConsole(el("div"), {realI18n: true});
  check("加载失败时空表说的是'没能加载出来'，不是'暂无数据'",
    /没能加载出来/u.test(emptyProbeReal.listEmptyText("成员列表", "500 server_error")),
    `失败时空表说的是：${JSON.stringify(emptyProbeReal.listEmptyText("成员列表", "500 server_error"))}`);
  // 35 张表里 30 张没传 emptyText，走的是 table() 的默认值 —— 那句默认值原先永远是"暂无数据"，
  // 于是加载失败时它照样在断言"确实一条都没有"。默认值本身要分开说，不能指望每个使用点记得传。
  check("没传 emptyText 的表，加载失败时也不许说「暂无数据」",
    /没能加载出来/u.test(emptyProbeReal.tableWith("500 server_error", ["列"], ""))
      && !/暂无数据/u.test(emptyProbeReal.tableWith("500 server_error", ["列"], "")),
    emptyProbeReal.tableWith("500 server_error", ["列"], "").replace(/<[^>]+>/gu, " ").trim().slice(0, 110));
  check("没有加载失败时仍然说「暂无数据」（不许无中生有地报故障）",
    /暂无数据/u.test(emptyProbeReal.tableWith("", ["列"], "")),
    emptyProbeReal.tableWith("", ["列"], "").replace(/<[^>]+>/gu, " ").trim().slice(0, 110));

  check("没有失败时仍然说'暂无数据'（真的没有就是没有）",
    emptyProbeReal.listEmptyText("成员列表", "") === "暂无数据",
    `没有失败却说成：${JSON.stringify(emptyProbeReal.listEmptyText("成员列表", ""))}`);
  // 接线：三张【由独立接口取数】的表都要用它。少了这条，helper 写了没人用照样全绿。
  const appSrc2 = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8");
  const wired = (appSrc2.match(/listEmptyText\(/gu) || []).length;
  check("三张独立取数的表都要接上（组织 / 成员 / 智能体节点）",
    wired >= 4,
    `listEmptyText 只被用了 ${wired - 1} 处（定义之外，应为 3）—— 有表还在说"暂无数据"`);
}

// 5 秒兜底轮询的注释一直写着"WebSocket 不可用时的兜底"，而代码原先【无条件跑】：
// 实时通道正常时也照样每 5 秒全量拉一遍。判据必须是"最近确实收到过实时消息"，
// 不能是"socket 开着" —— socket 开着却不再送消息，恰恰是最需要兜底的那一刻
// （同形的静默停摆本仓修过两次：编排心跳、控制通道）。
{
  const pollSource = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8")
    .replace(/\/\/[^\n]*/gu, (text) => " ".repeat(text.length));
  const at = pollSource.indexOf("}, 5000);");
  const body = at < 0 ? "" : pollSource.slice(Math.max(0, at - 700), at);
  check("兜底轮询在实时通道正常时要让路（否则等于双份负载）",
    /realtimeLastMessageAt/u.test(body),
    at < 0 ? "找不到那个 5 秒轮询 —— 本条在空转" : "兜底轮询无条件跑：实时通道正常时也在全量拉");
  check("让路的判据是【最近真收到过消息】，不是【socket 开着】",
    !/realtimeSocket\s*(&&|\?|\))/u.test(body) || /realtimeLastMessageAt/u.test(body),
    "用 socket 是否打开来判断：它开着却不送消息时，兜底会跟着一起哑掉");
  // 时刻只在真收到消息时更新 —— 否则"最近收到过"这个判据本身就是假的。
  const stamped = pollSource.indexOf("realtimeLastMessageAt = Date.now()");
  const inMessageHandler = stamped > 0
    && /addEventListener\("message"/u.test(pollSource.slice(Math.max(0, stamped - 300), stamped));
  check("那个时刻只在收到实时消息时更新（不能在别处顺手刷新）",
    inMessageHandler,
    "时刻不是在 message 事件里打的 —— 它证明不了通道还在送东西");
}

// 「正在加载…」这句话必须有对应的【失败态】说法，否则取失败之后它会一直转圈。
// 这个形状本仓撞了三次，每次长得都不一样：缺三态（项目规则配置）、
// Promise.all 整组失败（系统概览）、一组请求里有的 catch 了有的没 catch（任务组详情）。
// 共同点是：失败之后那个变量与"从没取过"长得一模一样。三处现在都修好了，这道门守第四处。
{
  const appForLoading = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8")
    .replace(/\/\/[^\n]*/gu, (text) => " ".repeat(text.length));
  const spots = [...appForLoading.matchAll(/正在加载[^`"<]{0,24}/gu)];
  const naked = [];
  for (const spot of spots) {
    // 判据要落在【同一个渲染分支】里：往前看一段，必须有区分"取失败了"的东西。
    const window = appForLoading.slice(Math.max(0, spot.index - 420), spot.index + 140);
    if (/Status === "failed"|Status !== "failed"|\.loadFailed|loadFailed:/u.test(window)) continue;
    naked.push(`${appForLoading.slice(0, spot.index).split("\n").length}: ${spot[0].trim()}`);
  }
  check("每一句「正在加载」都要有对应的「取失败了」说法（否则会一直转圈）",
    naked.length === 0 && spots.length >= 3,
    naked.length
      ? `这些「正在加载」没有失败态说法：\n    ${naked.join("\n    ")}`
      : `只找到 ${spots.length} 处「正在加载」（应至少 3）—— 提取与界面脱节，本条在空转`);
}

// 任务组详情：progress 那条请求原先没有 catch —— 一失败整个函数抛出、tgDetail 停在 null，
// 而面板对 null 只有一种说法「正在加载任务组详情…」。顶上横幅已经报了失败，面板还在转圈。
// 这是"一个 null 兼表两种意思"的第三处（前两处：项目规则配置、系统概览）。
{
  const tgProbe = loadConsole(el("div"), {realI18n: true});
  const group = {id: "tg1", name: "任务组", status: "active", workItems: [], roles: [], blockers: []};
  const loading = String(tgProbe.renderTaskGroupDetail(null, group)).replace(/<[^>]+>/gu, " ");
  check("还没取到时说的是'正在加载'",
    /正在加载任务组详情/u.test(loading),
    `未加载时显示：${JSON.stringify(loading.slice(0, 90))}`);
  // 这个对象要带上渲染所需的最小字段：否则把 loadFailed 分支去掉时渲染会直接崩，
  // 崩溃虽然也算失败，但拿不到干净的断言消息（变异登记的 expect 就对不上）。
  const failedDetail = {taskGroupId: "tg1", loadFailed: true, progress: {}, config: null,
    configVersion: null, roomMessages: null, roomMessageTotal: null, roomMessagesTruncated: false};
  const failed = String(tgProbe.renderTaskGroupDetail(failedDetail, group))
    .replace(/<[^>]+>/gu, " ");
  check("取失败时不许还说'正在加载'（人会一直等一件不会发生的事）",
    /没能加载出来/u.test(failed) && !/正在加载任务组详情/u.test(failed),
    `失败时显示：${JSON.stringify(failed.slice(0, 120))}`);
  check("失败时要给出下一步（刷新再试）",
    /刷新/u.test(failed),
    "只说没加载出来，没说能怎么办");
  // 上面三条是渲染分支，证明不了"真失败时会置上 loadFailed"。接线只能从源码看。
  const appSrc = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8");
  const at = appSrc.indexOf("async function loadTaskGroupDetail(");
  // 原先切的是【固定 1600 字】：函数里多加三行注释，要查的那句就溜出窗口，判据当场变红 ——
  // 变红还算好的，反过来（窗口罩住了隔壁函数的同形代码）就是静默喂饱。按函数结尾切。
  const bodyEnd = at < 0 ? -1 : appSrc.indexOf("\n}\n", at);
  const body = at < 0 || bodyEnd < 0 ? "" : appSrc.slice(at, bodyEnd);
  check("progress 取失败时必须把 loadFailed 置上（否则面板永远停在'正在加载'）",
    /progressFailure = error/u.test(body) && /loadFailed: Boolean\(progressFailure\)/u.test(body),
    at < 0 ? "找不到 loadTaskGroupDetail —— 本条在空转" : "取详情那段没有把失败记进 tgDetail");
  check("失败仍要抛出去（横幅要说清原因，不能被吞掉）",
    /if \(progressFailure\) throw progressFailure;/u.test(body),
    "失败被吞了 —— 面板说得出'没加载出来'，横幅却不说为什么");

  // 房间与任务组配置这两条【不会】把错误抛出去（progress 才会），所以这一屏没有横幅，
  // 面板必须自己说清楚。原先房间那块写的是「协作记录读取失败或当前账号无权查看该任务组的房间」——
  // 两件事并成一句：人不知道该去要权限，还是该重试。而分辨所需的状态码就在被吞掉的那个错误上。
  const roomDetail = (extra) => ({taskGroupId: "tg1", loadFailed: false, progress: {}, config: null,
    configVersion: null, roomMessages: null, roomMessageTotal: null, roomMessagesTruncated: false, ...extra});
  const denied = String(tgProbe.renderTaskGroupDetail(
    roomDetail({roomLoadError: "403 policy_denied（/api/rooms/room_tg1/messages）", roomLoadDenied: true}), group))
    .replace(/<[^>]+>/gu, " ");
  check("房间取数被拒时要说清是没权限，并说去找谁要",
    /无权查看这个任务组的协作记录/u.test(denied) && /项目负责人/u.test(denied),
    `403 时说的是：${(denied.match(/协作记录[^。]{0,60}。/u) || ["（没渲染出这块）"])[0]}`);
  const roomBroken = String(tgProbe.renderTaskGroupDetail(
    roomDetail({roomLoadError: "503 room_broker_unavailable（/api/rooms/room_tg1/messages）", roomLoadDenied: false}), group))
    .replace(/<[^>]+>/gu, " ");
  check("房间取数出故障时要给原因和出路，且不许说成「没权限」",
    roomBroken.includes("room_broker_unavailable") && /刷新/u.test(roomBroken) && !/无权/u.test(roomBroken),
    `503 时说的是：${(roomBroken.match(/协作记录[^。]{0,80}。/u) || ["（没渲染出这块）"])[0]}`);
  const roomTruly = String(tgProbe.renderTaskGroupDetail(roomDetail({roomMessages: []}), group))
    .replace(/<[^>]+>/gu, " ");
  check("真的一条协作记录都没有时，仍要说「暂无」而不是说成故障",
    /暂无协作记录/u.test(roomTruly) && !/没能取回来/u.test(roomTruly),
    `空时说的是：${(roomTruly.match(/协作记录[^。]{0,60}。/u) || ["（没渲染出这块）"])[0]}`);
  // 上面三条是渲染分支。接线：那两条 catch 必须真的把原因和状态码记下来，
  // 否则 roomLoadDenied 恒为 false —— 403 会被说成「服务端故障，刷新重试」，人白等。
  check("房间与配置取失败时必须把原因记进 tgDetail（否则面板只能说一句笼统的话）",
    /roomFailure = error/u.test(body) && /configFailure = error/u.test(body)
      && /roomLoadDenied: roomFailure \? roomFailure\.status === 403/u.test(body),
    "取详情那段没有把房间/配置的失败原因记下来");
  check("请求级失败要把状态码一起带出去（调用点靠它分辨「没权限」和「服务端故障」）",
    /if \(status !== undefined\) error\.status = status;/u.test(appSrc)
      && /requestFailure\(new Error\(`\$\{response\.status\}/u.test(appSrc),
    "requestFailure 没带状态码 —— 调用点只能把没权限和取不回来说成同一句");
}

// 系统概览这一块"还没取过"与"取失败了"此前共用同一个 null，一律显示"正在加载系统概览…"。
// 加载已经失败、横幅就在页面顶部写着原因，这一块却还在转圈 —— 人会一直等一件不会发生的事。
// 同一个形状在项目规则配置那里修过一次，这是第二处；所以这里连"接线"一起验（见下）。
{
  const overviewProbe = loadConsole(el("div"), {realI18n: true});
  const account = {accountId: "u1", email: "a@b.c", accountType: "system_admin",
    displayName: "管理员", organizationId: "org_default"};
  const bare = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {}, projects: [],
    organizations: [{orgId: "org_default", name: "默认组织", status: "active"}],
    taskGroups: [], agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [],
    findings: [], humanConfirmationRequests: [], humanDirectives: [], truncatedCollections: []};
  const shownWith = (status) => overviewProbe.systemOverviewText(bare, account, status);
  const unloaded = shownWith("unloaded");
  check("还没取到时说的是'正在加载'",
    /正在加载系统概览/u.test(unloaded) && !/没能加载出来/u.test(unloaded),
    `未加载时显示：${JSON.stringify(unloaded.slice(0, 100))}`);
  const failed = shownWith("failed");
  check("取失败时不许还说'正在加载'（人会一直等一件不会发生的事）",
    /没能加载出来/u.test(failed) && !/正在加载系统概览/u.test(failed),
    `失败时显示：${JSON.stringify(failed.slice(0, 120))}`);
  check("失败时要说清别的部分还能看（否则人以为整页都废了）",
    /可以照常看/u.test(failed),
    "只说这块没加载出来，没说下面的系统服务与审计仍然有效");
  // 上面三条是【渲染分支】：直接置状态，证明不了"真失败时真的会置成 failed"。
  // 少了这一条，把置位逻辑改成永远 unloaded 也照样全绿（项目配置那处就是被变异验出来的）。
  const appSrc = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8");
  const overviewFetch = appSrc.indexOf('api("/api/system/overview")');
  const wiring = overviewFetch < 0 ? "" : appSrc.slice(overviewFetch, overviewFetch + 500);
  check("取失败时必须把状态置成 failed（否则界面永远停在'正在加载'）",
    /systemOverviewStatus = overviewResult \? "loaded" : "failed"/u.test(wiring),
    overviewFetch < 0 ? "找不到取系统概览那段代码 —— 本条在空转"
      : `取概览段落里${/failed/u.test(wiring) ? "有" : "没有"}置 failed 的接线`);
}

// 加载失败的横幅此前一律写"连不上控制面或这一页加载失败" —— 而异常有两类：
//   请求级（连不上 / 超时 / 服务端 4xx5xx）：确实该去看控制面；
//   控制台【自己抛的】（我们代码里的缺陷）：说"连不上控制面"会把人支去查网络和服务端，而 bug 在这一页里。
// 这条是读真实渲染时撞见的：横幅上挂着一句 "Cannot read properties of undefined (reading 'get')"，
// 前面却写着"连不上控制面"。
{
  const bannerProbe = loadConsole(el("div"), {realI18n: true});
  const account = {accountId: "u1", email: "a@b.c", accountType: "system_admin",
    displayName: "管理员", organizationId: "org_default"};
  const bare = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {}, projects: [],
    organizations: [{orgId: "org_default", name: "默认组织", status: "active"}],
    taskGroups: [], agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [],
    findings: [], humanConfirmationRequests: [], humanDirectives: [], truncatedCollections: []};
  // 横幅文案由 lastErrorIsRequest 决定；探针直接置位，比造两种真异常稳（真异常的分类
  // 另有一条源码断言守着：三处请求级抛出都必须过 requestFailure）。
  const requestBanner = bannerProbe.failureBannerText(bare, account,
    "500 server_error（/api/system/overview）", true);
  check("请求级失败照旧指向控制面",
    /连不上控制面/u.test(requestBanner) && !/控制台这一页自己出错/u.test(requestBanner),
    `请求级失败说成了：${JSON.stringify(requestBanner.slice(0, 120))}`);
  const bugBanner = bannerProbe.failureBannerText(bare, account,
    "Cannot read properties of undefined (reading 'get')", false);
  check("控制台自己出错时不许说成'连不上控制面'",
    /控制台这一页自己出错/u.test(bugBanner) && !/连不上控制面/u.test(bugBanner),
    `控制台自身缺陷被说成了：${JSON.stringify(bugBanner.slice(0, 120))} —— 人会去查网络和服务端`);
  // 上面两条【直接置位】了分类标记，证明不了真异常会被分对类。
  // 少了下面这条，把三处 requestFailure( 全撤掉也照样全绿：那时每个请求失败都会被
  // 说成"控制台自己出错了"—— 比原先更糟（原先至少方向对一半）。
  const apiText = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8")
    .replace(/\/\/[^\n]*/gu, (text) => " ".repeat(text.length));
  const tagged = (apiText.match(/throw requestFailure\(/gu) || []).length;
  check("请求级失败必须都打上记号（否则连不上也会被说成'控制台的缺陷'）",
    tagged >= 3,
    `只有 ${tagged} 处请求级抛出打了记号（应至少 3 处：GET 无响应、写操作无响应、服务端 4xx5xx）`);
    check("说了之后要给出下一步（反馈给维护者）",
    /反馈给维护者/u.test(bugBanner),
    "只说'控制台自己出错了'，人不知道该做什么");
}

// 同一个英文枚举在不同对象上是不同的中文。词表全局、一个键一个值，于是最常见的那个意思
// 盖住其余全部 —— 读真实渲染时读到"组织：进行中""账号：进行中"（组织不会"进行"，账号也不会）。
{
  const statusProbe = loadConsole(el("div"), {realI18n: true});
  const cases = [
    ["organization", "active", /启用中/u, "组织"],
    ["account", "active", /已启用/u, "账号"],
    ["grant", "active", /生效中/u, "授权"],
    ["agent", "active", /已启用/u, "智能体"]
  ];
  for (const [kind, value, want, label] of cases) {
    const shown = String(statusProbe.statusBadge(kind, value));
    check(`${label}的 active 说的是它自己的那个词`,
      want.test(shown) && !/进行中/u.test(shown),
      `${label}显示成：${JSON.stringify(shown.replace(/<[^>]+>/gu, ""))}`);
  }
  // 上面全是【辅助函数】断言：证明不了这些状态格真的走了它。
  // 实测把 `statusBadge("organization", org.status)` 换回 `badge(org.status)`，265 条断言全绿。
  const appText = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8")
    .replace(/\/\/[^\n]*/gu, (text) => " ".repeat(text.length));
  const stillGeneric = ["org.status", "account.status", "grant.status", "agent.status", "source.status"]
    .filter((field) => appText.includes(`badge(${field})`) && !appText.includes(`statusBadge("`));
  const bypassed = ["org.status", "account.status", "grant.status", "agent.status", "source.status"]
    .filter((field) => new RegExp(`(?<!status)badge\\(${field.replace(".", "\\.")}\\)`, "u").test(appText));
  check("这些状态格必须走按对象的那层（否则覆盖表写了也没人用）",
    !bypassed.length && !stillGeneric.length,
    `这些还在走全局 badge()：${bypassed.join("、")} —— 覆盖表写了，屏幕上照旧是"进行中"`);

  // 正面对照：没有登记覆盖的对象要【退回全局词表】，不能因为加了这层就一律显示原始英文。
  check("没登记覆盖的对象仍走全局词表（任务组的 active 就是'进行中'）",
    /进行中/u.test(String(statusProbe.statusBadge("taskGroup", "active"))),
    "退不回全局词表了 —— 这层覆盖把没登记的对象也拦下了");
}

    check("要不到的那一页必须说出来（不能默默换一页给人）",
    notices.some((message) => /在当前视角下打不开/u.test(message) && /已回到/u.test(message)),
    `换页时什么都没说（收到的提示：${JSON.stringify(notices)}）—— 人会以为眼前这页就是他点的那页`);
  check("说的时候要点名是哪一页、回到了哪一页",
    notices.some((message) => /「成员管理」/u.test(message) && /已回到「系统概览」/u.test(message)),
    `提示没点名要的是哪一页：${JSON.stringify(notices)}`);
  // 正面对照：首次进入（没点名要任何页）时不该打扰。
  notices.length = 0;
  navProbe.renderFullPageWith(bare, account, null, "");
  check("没点名要页面时不打扰（默认页本来就是正确答案）",
    !notices.length,
    `首次进入却弹了提示：${JSON.stringify(notices)}`);
}

    check("这一条用的是真词表（对照：另一个已知键必须被翻译）",
    realProbe.translate("state_storage_unavailable") !== "state_storage_unavailable",
    "真词表没加载上 —— 上面那条断言其实在空转");
}

// 控制面把失联节点扫下线要等超时；在那之前它照旧显示"在线"，而人此刻正想知道的就是"它是不是已经没了"。
// "在线但一直不领活"：节点绿着、派发排着，而角色不匹配与模型不可用在界面上原先长得一模一样。
// 服务端对超长规则回 422 而不是截断（"绝不静默削弱一条安全规则的语义"），而 textarea 的 maxlength
// 在请求发出之前就把超出部分丢掉了 —— 人写了一万字，存下的是前 8192 字，一声不吭。
// "人写下的那份规则有没有真的到达模型"，唯一能回答它的证据就在执行事件的 evidenceRefs 里，
// 而事件表此前只渲染 summary。人只看到"含 3 个规则文件"，看不到是哪三个。
function runEvidenceRefsCase() {
  const probe = loadConsole(el("div"));
  const shown = probe.evidenceRefsHint({evidenceRefs: [
    "prompt:sha256abc", "prompt-includes:system/rules.md", "prompt-includes:business/rules.md"
  ]});
  check("说得出下发了哪几份规则",
    shown.includes("system/rules.md") && shown.includes("business/rules.md"),
    `执行事件没有说出提示词里实际包含了哪几份规则文件（${JSON.stringify(shown.slice(0, 100))}）`);
  check("没有证据时不占地方",
    probe.evidenceRefsHint({}) === "" && probe.evidenceRefsHint({evidenceRefs: []}) === "",
    "没有证据引用时仍然渲染了一块空内容");
}

function runReviewAxisCase() {
  const probe = loadConsole(el("div"));
  check("三项都谈到就不打扰",
    probe.alternativeAxisGaps("比当前方案更简单，性能相当，稳定性略差").length === 0,
    "三项判准都写清楚了却仍被标为缺失 —— 误报会让人学会无视这个提示");
  check("漏掉的项要点名",
    JSON.stringify(probe.alternativeAxisGaps("吞吐更高")) === JSON.stringify(["简单", "稳定"]),
    `只谈了性能却没被指出漏掉简单与稳定（${JSON.stringify(probe.alternativeAxisGaps("吞吐更高"))}）`);

  // 光有判据不够：它必须真的长在人会看到的那块渲染上。此前多次出现"守卫写了但没接到链路上"。
  const stateWith = (assessment) => ({
    taskGroups: [{id: "tg1", projectId: null, name: "组一"}],
    humanConfirmationRequests: [{
      requestId: "hcr1", taskGroupId: "tg1", status: "pending", decisionClass: "major",
      question: {summary: "选拓扑"}, options: [],
      peerReview: {verdict: "pass", findings: [], alternativesConsidered: [{alternative: "方案B", assessment}]}
    }],
    qualityGates: []
  });
  // 同一条纪律在任务组页：当前项目已归档时，两个创建表单后端一定拒（归档要求先把所有任务组
  // 关掉，之后还能往里建新组的话，那次收尾就白做了）。摆着它们就是按不动的杠杆。
  {
    const archRoot = el("div");
    loadConsole(archRoot, {realI18n: true}).renderFullPageWith({
      projects: [{id: "p_arch", name: "老项目", organizationId: "org_default", status: "archived", config: {}, members: []}],
      taskGroups: [], accounts: [], accessGrants: [], truncatedCollections: []
    }, {accountId: "u1", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"},
      "p_arch", "tg");
    const archHtml = String(archRoot.innerHTML || "");
    check("已归档项目的任务组页不许摆着「创建任务组 / 创建工作项」表单",
      /建不了新的任务组或工作项/u.test(archHtml)
        && !/data-form="task-group-create"/u.test(archHtml)
        && !/data-form="work-item-create"/u.test(archHtml),
      archHtml.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").match(/创建任务组[^|]{0,80}/u)?.[0] || "（这一页没渲染出来）");
    const liveRoot = el("div");
    loadConsole(liveRoot, {realI18n: true}).renderFullPageWith({
      projects: [{id: "p_live", name: "在用项目", organizationId: "org_default", status: "active", config: {}, members: []}],
      taskGroups: [], accounts: [], accessGrants: [], truncatedCollections: []
    }, {accountId: "u1", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"},
      "p_live", "tg");
    check("在用项目上照常摆着创建表单（否则这道判据把正常路径一起堵死）",
      /data-form="task-group-create"/u.test(String(liveRoot.innerHTML || "")),
      "在用项目上也建不了任务组了");
  }

  // 【已归档的项目不该出现在任何"把人或机器放进去开工"的选择器里】。后端两条路都已拒
  //（project_archived / member_default_project_archived），而「项目成员授权」那个下拉
  // 原先列的是全部项目 —— 选中一个归档项目提交，回执是 409，人只看到一个按不动的杠杆。
  {
    const grantRoot = el("div");
    const orgAdmin = {accountId: "u1", accountType: "org_admin", displayName: "组织管理员", organizationId: "org_default",
      roles: ["org_admin"], permissions: ["org:*", "project:create", "project:grant"]};
    loadConsole(grantRoot, {realI18n: true}).renderFullPageWith({
      accounts: [{accountId: "u1", displayName: "管理员", email: "a@x", accountType: "system_admin",
        status: "active", roles: [], organizationId: "org_default"}],
      projects: [
        {id: "p_live", name: "在用项目", organizationId: "org_default", status: "active"},
        {id: "p_arch", name: "老项目", organizationId: "org_default", status: "archived"}
      ],
      accessGrants: [], mcpGrants: [], auditLog: [], agents: [], agentJoinTokens: []
    }, orgAdmin,
      "p_live", "org-projects");
    const memberSection = String(grantRoot.innerHTML || "").split("<h2>项目成员授权</h2>")[1] || "";
    check("「项目成员授权」的项目下拉里不许出现已归档的项目（后端会拒）",
      /在用项目/u.test(memberSection) && !/老项目/u.test(memberSection),
      memberSection.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").slice(0, 120) || "（这一块没渲染出来）");
    const allArchivedRoot = el("div");
    loadConsole(allArchivedRoot, {realI18n: true}).renderFullPageWith({
      accounts: [{accountId: "u1", displayName: "管理员", email: "a@x", accountType: "system_admin",
        status: "active", roles: [], organizationId: "org_default"}],
      projects: [{id: "p_arch", name: "老项目", organizationId: "org_default", status: "archived"}],
      accessGrants: [], mcpGrants: [], auditLog: [], agents: [], agentJoinTokens: []
    }, orgAdmin,
      "p_arch", "org-projects");
    check("全部项目都已归档时要说清是「都归档了」，而不是渲染一个空下拉或「还没有项目」",
      /全部已归档/u.test(String(allArchivedRoot.innerHTML || "").split("<h2>项目成员授权</h2>")[1] || ""),
      "人分不清这个组织没有项目、还是有但都归档了 —— 这两件事的下一步不同");
  }

  // 切换器把已归档的项目和在用的混在一起、没有任何标记 —— 人要先切过去、点一下保存、
  // 拿到一句 409 才知道那是个只读的死项目。归档不可撤销，这件事该在选它之前就看得见。
  {
    const switchRoot = el("div");
    loadConsole(switchRoot, {realI18n: true}).renderFullPageWith({
      projects: [
        {id: "p_live", name: "在用项目", organizationId: "org_default", status: "active", config: {}, members: []},
        {id: "p_arch", name: "老项目", organizationId: "org_default", status: "archived", config: {}, members: []}
      ],
      taskGroups: [], accounts: [], accessGrants: [], truncatedCollections: []
    }, {accountId: "u1", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"},
      "p_live", "proj-overview");
    const switchHtml = String(switchRoot.innerHTML || "");
    check("项目切换器要标出哪些是已归档（切过去只能看，而归档不可撤销）",
      /老项目（已归档 · 只读）/u.test(switchHtml),
      switchHtml.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").match(/当前项目[^|]{0,60}/u)?.[0] || "（切换器没渲染出来）");
    check("在用的项目不要被加上这个后缀",
      !/在用项目（已归档/u.test(switchHtml),
      "在用项目也被标成了已归档");
  }

  // 归档是项目的终结态、且不可撤销：后端已经拒（project_archived），而项目切换器列得出
  // 已归档的项目 —— 选中它之后这一页的写入口原先照常摆着，人点「保存项目配置」只拿回一句 409。
  {
    const archRoot = el("div");
    loadConsole(archRoot, {realI18n: true}).renderFullPageWith({
      projects: [{id: "p_arch", name: "归档项目", organizationId: "org_default", status: "archived",
        config: {}, members: []}],
      taskGroups: [], accounts: [], accessGrants: [], truncatedCollections: []
    }, {accountId: "u1", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"},
      "p_arch", "proj-settings");
    const archHtml = String(archRoot.innerHTML || "");
    check("已归档项目的设置页要说明它只能看，不能摆一个按不动的保存按钮",
      /已归档（终态，不可撤销）/u.test(archHtml)
        && /<button[^>]*\bdisabled\b[^>]*>\s*保存项目配置/u.test(archHtml),
      archHtml.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").match(/项目设置[^|]{0,120}/u)?.[0] || "（这一页没渲染出来）");
    const liveRoot = el("div");
    loadConsole(liveRoot, {realI18n: true}).renderFullPageWith({
      projects: [{id: "p_live", name: "在用项目", organizationId: "org_default", status: "active",
        config: {}, members: []}],
      taskGroups: [], accounts: [], accessGrants: [], truncatedCollections: []
    }, {accountId: "u1", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"},
      "p_live", "proj-settings");
    check("在用项目照常能改（否则这道判据把正常路径一起堵死了）",
      !/已归档（终态，不可撤销）/u.test(String(liveRoot.innerHTML || "")),
      "在用项目也被标成了归档");
  }

  // 【同一个词在不同对象上意思不同，只能按对象覆盖】。入网令牌的 consumed 是"这张一次性票
  // 被用掉了"，而全局词表里 consumed 已经被评审包的「已采纳」占着 —— 真实运行态里两张用过的
  // 加入令牌就写着「已采纳」，读起来像有人批准了什么。（active / retired 都撞过同一个形状。）
  {
    const tokenProbe = loadConsole(el("div"), {realI18n: true});
    const tokenHtml = tokenProbe.renderSysAccountsWith({
      accounts: [{accountId: "u1", displayName: "管理员", email: "a@x", accountType: "system_admin",
        status: "active", roles: []}],
      projects: [{id: "p1", name: "项目一", status: "active"}],
      accessGrants: [], mcpGrants: [], auditLog: [], agents: [],
      agentJoinTokens: [
        {joinTokenId: "ajt_used", projectId: "p1", allowedRoles: ["monitor"], status: "consumed",
          useCount: 1, maxUses: 1, expiresAt: "2026-08-27T00:00:00.000Z"},
        // 未过期用【动态未来】：固定日期会随时间流逝变成过期，令 issued 令牌显示成「已过期」而非本意的「已签发」。
        {joinTokenId: "ajt_open", projectId: "p1", allowedRoles: ["monitor"], status: "issued",
          useCount: 0, maxUses: 1, expiresAt: new Date(Date.now() + 3600000).toISOString()}
      ]
    }, {accountId: "u1", accountType: "system_admin", displayName: "管理员"});
    check("用掉的入网令牌不能写成「已采纳」（那是评审包的词）",
      /已使用/u.test(tokenHtml) && !/已采纳/u.test(tokenHtml),
      String(tokenHtml).replace(/<[^>]+>/gu, " ").match(/ajt_used[^|]{0,80}/u)?.[0] || "（令牌表没渲染出来）");
    check("还能用的令牌照常显示「已签发」（正面对照走同一条分支）",
      /已签发/u.test(tokenHtml),
      "连未使用的令牌都不显示状态了 —— 上面那条可能是把整列砍掉了");
  }

  // 审计表上服务名 actor 此前印的是原始英文（"auth-service"），而词表里明明有「认证服务」——
  // accountName 一律回落成原始 id，从不看词表。只对非账号形状、且词表真有的 id 走 t()。
  {
    const actorProbe = loadConsole(el("div"), {realI18n: true});
    const html = actorProbe.renderSysOverviewWith({
      accounts: [{accountId: "acct_u1", displayName: "张三", email: "z@x", accountType: "system_admin", status: "active", roles: []}],
      auditLog: [
        {id: "a1", at: "2026-08-27T00:00:00.000Z", actor: "auth-service", action: "auth_logout", subject: "Account:acct_u1", result: "succeeded"},
        {id: "a2", at: "2026-08-27T00:00:01.000Z", actor: "acct_u1", action: "task_group_pause", subject: "TaskGroup:tg_1", result: "succeeded"},
        {id: "a3", at: "2026-08-27T00:00:02.000Z", actor: "acct_ghost", action: "task_group_pause", subject: "TaskGroup:tg_1", result: "succeeded"}
      ],
      services: [], truncatedCollections: []
    }, {accountId: "acct_u1", accountType: "system_admin", displayName: "张三"}, null);
    const text = String(html).replace(/<[^>]+>/gu, " ");
    check("审计表上的服务名 actor 要用词表里的中文（auth-service → 认证服务）",
      /认证服务/u.test(text) && !/auth-service/u.test(text),
      text.match(/退出登录[^|]{0,60}/u)?.[0] || "（审计表没渲染出来）");
    check("账号 actor 仍按账号池显示名（张三）",
      /张三/u.test(text), "账号 actor 不再解析成显示名");
    check("认不出的账号 id 仍原样回落，不许被当成词表键",
      /acct_ghost/u.test(text), "不认识的账号 id 被吞掉或译错了");
  }

  // 注销不可撤销，而"什么时候、为什么"此前落在 retiredAt/retiredReason 上、全仓没有读取点：
  // 屏幕上只有一个「已注销」，事后追不到依据。
  {
    const dictProbe = loadConsole(el("div"), {realI18n: true});
    const accountsHtml = dictProbe.renderSysAccountsWith({
      accounts: [
        {accountId: "u1", displayName: "李四", email: "l@x", accountType: "user_account",
          status: "retired", roles: [], retiredAt: "2026-08-20T00:00:00.000Z",
          retiredReason: "离职交接完成"},
        {accountId: "u2", displayName: "王五", email: "w@x", accountType: "user_account",
          status: "retired", roles: [], retiredAt: "2026-08-21T00:00:00.000Z",
          retiredReason: "human_retire_decision"},
        {accountId: "u3", displayName: "张三", email: "z@x", accountType: "user_account",
          status: "active", roles: []}
      ],
      accessGrants: [], mcpGrants: [], auditLog: []
    }, {accountId: "u3", accountType: "system_admin", displayName: "张三"});
    check("已注销的账号要说得出什么时候、为什么（注销不可撤销）",
      /离职交接完成/u.test(accountsHtml) && /2026-08-20/u.test(accountsHtml),
      "账号行上只有一个「已注销」，事后追不到依据");
    check("没填理由时的缺省值也要是人话，不能把 human_retire_decision 摆给人看",
      /当时没有填写理由/u.test(accountsHtml) && !/human_retire_decision/u.test(accountsHtml),
      String(accountsHtml).replace(/<[^>]+>/gu, " ").match(/王五[^|]{0,80}/u)?.[0] || "（没渲染出来）");
    check("还在用的账号不要多贴一行（常亮的提示等于没有提示）",
      !/张三[\s\S]{0,120}record-meta/u.test(accountsHtml),
      "活跃账号身上也贴了注销说明");
  }

  // 人正要回答的确认单被系统作废时，「已答历史」里原本是【一行空的 cancelled】：
  // 没有选项、没有内容、没有确认人。为什么消失了，只写在 cancelReason 上而全仓没人读它。
  {
    const cancelledHtml = probe.renderReviewWith({
      taskGroups: [{id: "tg1", projectId: null, name: "组一"}],
      humanConfirmationRequests: [
        {requestId: "hcr_c1", taskGroupId: "tg1", status: "cancelled", decisionClass: "operational",
          question: {summary: "还要不要继续"}, options: [], cancelReason: "dispatch_failed",
          updatedAt: "2026-08-20T00:00:00.000Z"},
        {requestId: "hcr_c2", taskGroupId: "tg1", status: "cancelled", decisionClass: "operational",
          question: {summary: "验收确认"}, options: [], cancelReason: "工作项已由人工放弃",
          updatedAt: "2026-08-20T01:00:00.000Z"}
      ],
      qualityGates: []
    });
    check("被作废的确认单要说得出为什么（人正要回答的问题凭空消失）",
      /已作废/u.test(cancelledHtml) && /工作项已由人工放弃/u.test(cancelledHtml),
      "已答历史里是一行空的「已取消」：没有选项、没有内容、没有确认人，也没有原因");
    // 另一处写的是 dispatch_failed 这类码 —— 直接摆给人看等于没说。用真词表验它被译过。
    // 用变量传选项，不复制 loadConsole(el("div"), {realI18n: true}) 这串字面量 ——
    // 「真词表对照要能红」那条变异的锚点正是它，出现两次就点不准被测的那一处。
    const withRealDict = {realI18n: true};
    const realProbe = loadConsole(el("div"), withRealDict);
    const codedHtml = realProbe.renderReviewWith({
      taskGroups: [{id: "tg1", projectId: null, name: "组一"}],
      humanConfirmationRequests: [{requestId: "hcr_c3", taskGroupId: "tg1", status: "cancelled",
        decisionClass: "operational", question: {summary: "还要不要继续"}, options: [],
        cancelReason: "dispatch_failed", updatedAt: "2026-08-20T00:00:00.000Z"}],
      qualityGates: []
    }, {accountId: "u1", accountType: "system_admin", displayName: "管理员"});
    check("码型的作废原因要译成人话，不能把 dispatch_failed 摆给人看",
      /派发已失败/u.test(codedHtml) && !/dispatch_failed/u.test(codedHtml),
      String(codedHtml).replace(/<[^>]+>/gu, " ").match(/已作废[^ ]{0,40}/u)?.[0] || "（没渲染出来）");
    check("作废原因不得以 [object Object] 的样子出现在人眼前（这个字段两处一处写码、一处写对象）",
      !/\[object Object\]/u.test(cancelledHtml),
      String(cancelledHtml).replace(/<[^>]+>/gu, " ").match(/已作废[^ ]{0,60}/u)?.[0] || "（没渲染出来）");
  }

  // 证据引用在两层各截了一次（服务端建卡时留前 20、界面再显示前 12），两层都不说总数的话，
  // 人会以为证据就这些 —— 而定稿正是照着证据做的。
  {
    const evidenceHtml = probe.renderReviewWith({
      taskGroups: [{id: "tg1", projectId: null, name: "组一"}],
      humanConfirmationRequests: [{
        requestId: "hcr_ev", taskGroupId: "tg1", status: "pending", decisionClass: "operational",
        question: {summary: "证据很多", evidenceRefs: Array.from({length: 20}, (_, i) => `ev:${i}`),
          evidenceRefsTotal: 25},
        options: []
      }],
      qualityGates: []
    });
    check("证据引用被截断时要说出总数（两层都截，都不说人就以为就这些）",
      /共 25 条/.test(evidenceHtml) && /显示前 12 条/.test(evidenceHtml),
      String(evidenceHtml).replace(/<[^>]+>/gu, " ").split("证据引用")[1]?.slice(0, 110) || "卡片上没有证据引用那一行");
    const fewHtml = probe.renderReviewWith({
      taskGroups: [{id: "tg1", projectId: null, name: "组一"}],
      humanConfirmationRequests: [{
        requestId: "hcr_ev2", taskGroupId: "tg1", status: "pending", decisionClass: "operational",
        question: {summary: "证据不多", evidenceRefs: ["ev:1", "ev:2"]}, options: []
      }],
      qualityGates: []
    });
    // 收窄到【证据那一行】：整页匹配会被面板抬头那句"共 N 条待确认"喂饱（第一版就是这样）。
    const fewLine = String(fewHtml).split("证据引用")[1]?.slice(0, 200) || "";
    check("证据没被截断时不要多说一句",
      Boolean(fewLine) && !/共 \d+ 条/.test(fewLine),
      fewLine ? fewLine.replace(/<[^>]+>/gu, " ").slice(0, 100) : "卡片上没有证据引用那一行 —— 这条断言在空转");
  }

  // 同一份数据在两个地方报数：面板说"2+"、列表标题说"2"，人不知道该信哪个。
  const cappedList = probe.renderReviewWith({
    ...stateWith("更简单，性能相当，稳定性略差"),
    truncatedCollections: ["humanConfirmationRequests"]
  });
  check("待确认列表标题也跟随截断口径",
    /共 1\+ 条待确认/.test(cappedList),
    "确认列表按截断后的长度报「共 N 条」，与面板的 N+ 口径不一致");

  // 核心决策不得预选：AI 推荐被预先勾上时，"点一下定稿"就是最省力的路径，人工闸门退化成
//  一次点击确认。运行级决策保留预选（低风险、高频）。
  const majorState = (decisionClass, options) => ({
    taskGroups: [{id: "tg1", projectId: null, name: "组一"}],
    humanConfirmationRequests: [{
      requestId: "hcr1", taskGroupId: "tg1", status: "pending", decisionClass,
      question: {summary: "选拓扑"}, options
    }],
    qualityGates: []
  });
  const reviewer = {accountId: "acct_r", accountType: "org_admin"};
  const opts = [{optionId: "a", label: "方案A", recommended: true}, {optionId: "b", label: "方案B"}];
  const majorHtml = probe.renderReviewWith(majorState("major", opts), reviewer);
  check("核心决策不预选任何选项",
    !/checked/.test(majorHtml),
    "核心决策卡片预先勾选了 AI 推荐的选项 —— 人只要点一下定稿就等于采纳了 AI 的判断");
  check("并且说明为什么没有预选",
    majorHtml.includes("必须由你主动勾选"),
    "没有预选却不解释，人会以为界面坏了或漏渲染");
  const opHtml = probe.renderReviewWith(majorState("operational", opts), reviewer);
  check("运行级决策仍然预选推荐项",
    /checked/.test(opHtml),
    "把低风险的运行级决策也改成必须手动勾选 —— 高频操作上增加无谓负担");

  const missing = probe.renderReviewWith(stateWith("吞吐更高"));
  check("确认卡片上标出该条漏了哪项",
    missing.includes("这条没说明") && missing.includes("简单") && missing.includes("稳定"),
    "人工确认卡片渲染了替代方案，却没有标出它漏掉的判准 —— 判据没接到人看得见的地方");
  const complete = probe.renderReviewWith(stateWith("更简单，性能相当，稳定性略差"));
  check("三项齐全的条目不加警告",
    !complete.includes("这条没说明"),
    "三项都写清楚的替代方案仍被加了缺失警告");
}

// "一个项目都没有"与"项目里什么都没有"是两种处境，下一步完全不同。实测普通成员首次登录：
// 项目概览说对了（暂无可见项目 + 找组织管理员），而任务组/人工指令说的是"当前项目暂无任务组"
// —— 此刻根本没有当前项目；执行监控更是摆出十一张空表，一句解释都没有。
// 两支都要验：没项目时六页都要说"暂无可见项目"，有项目而没任务组时那句区分必须还在。
function runNoVisibleProjectCase() {
  const member = {accountId: "m1", email: "m@b.c", accountType: "user_account",
    displayName: "普通成员甲", organizationId: "org_default"};
  const baseState = (projects, taskGroups) => ({schemaVersion: "runtime-state/v1", stateVersion: 1,
    runtime: {}, organizations: [{orgId: "org_default", name: "组织", status: "active"}],
    projects, taskGroups, accounts: [], agentRuntimeNodes: [], agentDispatches: [], workSessions: [],
    humanConfirmationRequests: [], humanDirectives: [], closeBarriers: [], qualityGates: [],
    findings: [], truncatedCollections: [], fleet: {online: 0, total: 0}});
  const renderAs = (account, state, pageId, projectId = "", pendingConfirmCount) => {
    const root = el("div");
    const probeHere = loadConsole(root, {realI18n: true});
    // 「待人工确认」那个数由计数接口给、不在 state 里 —— 不显式喂它，依赖它的那一格永远在 0 上被验。
    if (pendingConfirmCount !== undefined) probeHere.setPendingConfirmCount(pendingConfirmCount);
    probeHere.renderFullPageWith(state, account, projectId, pageId);
    return String(root.innerHTML || "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
  };
  // 指路要指【这个人自己菜单里有的那一页】。刚装完的第一屏最容易犯这个错：监控页那条
  // "还没有任何执行记录"的横幅原先一律写「AI 智能体」页 —— 而那一页只在项目空间里，
  // 刚 npm run init 完、最可能读到这句话的系统管理员只能先开通组织并交付初始组织管理员。
  // 这条判据不盯那一句文案，而是核【一般性质】：横幅里点名的页，必须出现在这一屏的导航里。
  {
    const emptyState = {
      schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "development", workItems: []}],
      agentDispatches: [], workSessions: [], agentRuntimeNodes: [], executionTopologies: [],
      humanConfirmationRequests: [], humanDirectives: [], closeBarriers: [], qualityGates: [],
      findings: [], permissionRequests: [], approvalRequests: [], truncatedCollections: []
    };
    const personas = [
      ["系统管理员", {accountId: "u_sys", accountType: "system_admin", displayName: "系统管理员",
        organizationId: "org_default", permissions: ["system:*"]}],
      ["组织管理员", {accountId: "u_org", accountType: "org_admin", displayName: "组织管理员",
        organizationId: "org_default", effectivePermissions: ["project:view", "org:member_admin"]}],
      ["组织成员", {accountId: "u_member", accountType: "user_account", displayName: "成员",
        organizationId: "org_default", effectivePermissions: ["project:view"]}]
    ];
    for (const [who, account] of personas) {
      const text = renderAs(account, emptyState, "monitor", "p1");
      if (!/还没有任何执行记录/u.test(text)) {
        check(`${who}：刚装完的监控页要有那条"表是空的、这是正常的"横幅`, false,
          "这一屏没渲染出横幅 —— 下面那条什么也没验");
        continue;
      }
      const banner = text.slice(text.indexOf("还没有任何执行记录"), text.indexOf("还没有任何执行记录") + 220);
      const named = [...banner.matchAll(/「([^」]{2,10})」页/gu)].map((hit) => hit[1]);
      const missing = named.filter((label) => !text.includes(label + " ") && !text.includes(" " + label));
      check(`${who}：横幅里指的页必须是这个账号菜单里有的`,
        missing.length === 0,
        `它让人去「${missing.join("、")}」页，而这一屏的导航里没有这几页 —— `
          + "照着做的人会在自己的菜单里找一个不存在的入口");
      if (who === "系统管理员") {
        check("系统管理员：刚装完的指路要指向项目级智能体注册入口",
          /项目管理」→「AI 智能体」→「注册 agent/.test(banner)
            && !/项目设置」→「智能体接入/.test(banner),
          `它让人去旧入口而这一屏的导航里没有这几页 —— 横幅是：${banner}`);
      }
    }
  }
  // 方案卡住时，人在监控页读到的"卡在这几项"必须是中文。阻塞项是 kind:分支:尾码 三段式，
  // 尾段（no_acceptance_checks 之类）此前一个中文都没有 —— 而它正是唯一说明原因的那一段。
  // 漏译扫描发现不了这类：它只在【渲染到】那一屏时才查得到，而三份基础状态里都没有执行拓扑。
  {
    const stuckState = {
      schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "development",
        workItems: [{id: "wi1", title: "并行改造", status: "assigned", ownerRole: "agent-runtime", progress: 20}]}],
      executionTopologies: [{
        schemaVersion: "execution-topology/v1", topologyId: "topo1", projectId: "p1", taskGroupId: "tg1",
        workItemId: "wi1", status: "blocked", mode: "parallel_active",
        runnerKind: "none", isolation: "none", mergePolicy: "parent_serial_after_all_required_reported",
        groups: [{groupId: "g1", branches: [{branchId: "b_api", objective: "", status: "queued",
          ownedPaths: [], acceptanceChecks: [], outputContract: []}]}],
        blockers: ["runner_isolated:topo1:runner_or_isolation_none",
          "final_validation_available:b_api:no_acceptance_checks"],
        baseSnapshot: {stateVersion: 1, gitHead: "abc1234"},
        createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z"
      }],
      humanConfirmationRequests: [], humanDirectives: [], agentDispatches: [], workSessions: [],
      closeBarriers: [], qualityGates: [], findings: [], permissionRequests: [], approvalRequests: [],
      truncatedCollections: []
    };
    const stuckText = renderAs({accountId: "u1", accountType: "system_admin", displayName: "管理员",
      organizationId: "org_default"}, stuckState, "monitor", "p1");
    check("方案卡住时，「卡在这几项」里每一段都要是人话，不能出现英文尾码",
      /载体或隔离方式填的是/u.test(stuckText) && /一条验收项都没写/u.test(stuckText)
        && !/runner_or_isolation_none|no_acceptance_checks/u.test(stuckText),
      `人读到的是：${(/卡在这几项：([^<]{0,160})/u.exec(stuckText) || [])[1] || "（这一屏根本没渲染出来）"}`);
    // 资格检查没过的方案此前【整个界面都看不到】：start 被阻塞项挡、cancel 只从 running 那四种
    // 状态走，后端唯一接受的出口是降级为串行。人只看到任务组上"存在阻塞"一个红 chip，
    // 点不进去也不知道该做什么，而这个方案是非终态，会一直挡着关闭门。
    const eligibilityState = structuredClone(stuckState);
    eligibilityState.executionTopologies[0].status = "eligibility_checked";
    const eligibilityText = renderAs({accountId: "u1", accountType: "system_admin", displayName: "管理员",
      organizationId: "org_default"}, eligibilityState, "monitor", "p1");
    check("资格检查没过的执行方案要在界面上看得见（它是非终态，会一直挡着关闭门）",
      /topo1/u.test(eligibilityText),
      "界面上找不到它 —— 人只看到任务组「存在阻塞」，点不进去也不知道该做什么");
    // 五处人工收尾都要求真人写理由、都做了长度校验、都落了库 —— 而此前【全仓一处都不读它】：
    // 收尾之后对象从"待你收尾"清单里消失，理由跟着一起消失。留痕正是这几条杠杆存在的理由。
    const finalizedState = structuredClone(stuckState);
    finalizedState.reviewBundles = [{reviewBundleId: "rb1", taskGroupId: "tg1", status: "consumed",
      resolvedBy: "u1", resolutionJustification: "外部评审方不再参与，改由内部 QA 覆盖",
      updatedAt: "2026-08-11T00:00:00.000Z"}];
    finalizedState.ruleSourceResolutions = [{resolutionId: "rs1", sourceRef: "src:mgp", taskGroupId: "tg1",
      status: "active", settledBy: "u1", settlementJustification: "与本项目现行规范不冲突，采纳为项目规则",
      updatedAt: "2026-08-12T00:00:00.000Z"}];
    const finalizedText = renderAs({accountId: "u1", accountType: "system_admin", displayName: "管理员",
      organizationId: "org_default"}, finalizedState, "monitor", "p1");
    check("人工定稿的理由要看得见（写了没人读＝没留痕）",
      /外部评审方不再参与/u.test(finalizedText) && /与本项目现行规范不冲突/u.test(finalizedText),
      "定稿理由在界面上一个字都找不到 —— 后来的人无从判断当时为什么这么定");
    // 关闭任务组是真人专属的决定，而屏幕上此前只有一个"已关闭"灰章 —— 追不到是谁定的。
    const closedState = structuredClone(finalizedState);
    closedState.taskGroups[0].status = "closed";
    closedState.closeBarriers = [{taskGroupId: "tg1", satisfied: true, blockingObjects: [],
      computedAt: "2026-08-12T00:00:00.000Z", confirmedBy: "u1", confirmedAt: "2026-08-12T01:00:00.000Z"}];
    const closedText = renderAs({accountId: "u1", accountType: "system_admin", displayName: "管理员",
      organizationId: "org_default"}, closedState, "monitor", "p1");
    check("已关闭的任务组要说得出是谁定稿关闭的（这是真人专属的决定）",
      /定稿于/u.test(closedText) && /管理员/u.test(closedText),
      "屏幕上只有一个「已关闭」，谁定的、什么时候定的都追不到");

    // 没选出模型的那一条决策，屏幕上原本只剩一个"任务类型"：为什么没选出来、按的是哪条
    // 策略的硬约束，都写进了记录却没有任何读取点。人看到的是"这个工作项就是没有模型"。
    const denialState = structuredClone(stuckState);
    denialState.modelSelectionDecisions = [{decisionId: "msd1", taskGroupId: "tg1", workItemId: "wi_9",
      roleId: "implementer", status: "denied", taskExecutionClass: "code_change",
      denialReason: "no_candidate_satisfied_hard_constraints", fallbackPolicyRef: "msp_impl"}];
    const denialText = renderAs({accountId: "u1", accountType: "system_admin", displayName: "管理员",
      organizationId: "org_default"}, denialState, "monitor", "p1");
    check("没选出模型时要说得出为什么、按的是哪条策略",
      /没有任何候选模型同时满足硬约束/u.test(denialText) && /msp_impl/u.test(denialText),
      `选型行上只有一个任务类型，人查不下去。渲染出来的片段：${String(denialText).replace(/<[^>]+>/gu, " ").match(/模型选择[\s\S]{0,200}/u)?.[0] || "（这一屏没渲染出模型选择）"}`);
    check("原因码不许原样摆给人看",
      !/no_candidate_satisfied_hard_constraints/u.test(denialText),
      "把 no_candidate_satisfied_hard_constraints 直接印在屏幕上了");

    // 同一条纪律在【建工作项】那个下拉上：它原先列的是项目下全部任务组，而后端按组判
    // task_group:control —— 只在 tg1 上有权的人能选中 tg2 提交，然后拿到一句拒绝。
    {
      const pickState = structuredClone(stuckState);
      pickState.taskGroups = [
        {id: "tg1", projectId: "p1", name: "我有权的组", status: "development", workItems: []},
        {id: "tg2", projectId: "p1", name: "别人的组", status: "development", workItems: []}
      ];
      pickState.taskGroupPermissions = {tg1: ["task_group:control"]};
      pickState.taskGroupPermissionsDefault = [];
      const picker = {accountId: "u8", accountType: "org_member", displayName: "成员",
        organizationId: "org_default", effectivePermissions: ["task_group:control", "project:read"]};
      const pickText = renderAs(picker, pickState, "tg", "p1");
      check("建工作项的下拉里不许出现他没权限的任务组（选了也只会被后端拒掉）",
        /我有权的组/u.test(pickText) && /另有 1 个组你没有/u.test(pickText),
        String(pickText).replace(/<[^>]+>/gu, " ").match(/所属任务组[^|]{0,90}/u)?.[0] || "（这一段没渲染出来）");
      const noneState = structuredClone(pickState);
      noneState.taskGroupPermissions = {};
      const noneText = renderAs(picker, noneState, "tg", "p1");
      check("一个都没权限时要说清是「都没权限」而不是「没有任务组」",
        /都没有「任务组控制」权限/u.test(noneText),
        "下拉是空的，人分不清这个项目没有任务组、还是他一个都动不了");
    }

    // 同一条纪律在人工指令页那个下拉上（它走 taskGroupSelector，另一条代码路径）。
    {
      const dirState = structuredClone(stuckState);
      dirState.taskGroups = [
        {id: "tg1", projectId: "p1", name: "我有权的组", status: "development", workItems: []},
        {id: "tg2", projectId: "p1", name: "别人的组", status: "development", workItems: []}
      ];
      dirState.taskGroupPermissions = {};
      dirState.taskGroupPermissionsDefault = [];
      const member = {accountId: "u7", accountType: "org_member", displayName: "成员",
        organizationId: "org_default", effectivePermissions: ["task_group:control", "project:read"]};
      const dirText = renderAs(member, dirState, "directives", "p1");
      check("人工指令的目标任务组下拉空了，也要说清是「都没权限」而不是「没有任务组」",
        /都没有/u.test(dirText) && /按【任务组】授予/u.test(dirText),
        String(dirText).replace(/<[^>]+>/gu, " ").match(/目标任务组[^|]{0,80}/u)?.[0] || "（这一段没渲染出来）");
    }

    // 【在别的组上有同名权限，不等于这个组上有】。面板级那三个判据走的是 effectivePermissions
    // （跨资源并集，服务端注释里写明它只是 UI 提示），而下面每一段按任务组过滤 ——
    // 于是"在 tg1 上有评审权、待收尾的计划都在 tg2"这种人：警告不显示、列表也空，
    // 那两条计划既不显示也不解释，而它们正挡着关闭门。
    const reachState = structuredClone(stuckState);
    reachState.taskGroups = [
      {id: "tg1", projectId: "p1", name: "我有权的组", status: "development", workItems: []},
      {id: "tg2", projectId: "p1", name: "别人的组", status: "development", workItems: []}
    ];
    reachState.reviewPlans = [
      {reviewPlanId: "rp_far1", projectId: "p1", taskGroupId: "tg2", status: "planned",
        requiredReviewerRoles: ["reviewer"], coveredReviewerRoles: []},
      {reviewPlanId: "rp_far2", projectId: "p1", taskGroupId: "tg2", status: "planned",
        requiredReviewerRoles: ["reviewer"], coveredReviewerRoles: []}
    ];
    reachState.executionTopologies = [];
    // 按任务组的权限由【视图】下发在 state 上（服务端只列与默认集不同的那些组），不在账号上。
    reachState.taskGroupPermissions = {tg1: ["task_group:review"]};
    reachState.taskGroupPermissionsDefault = [];
    const partialReviewer = {accountId: "u9", accountType: "org_member", displayName: "评审员",
      organizationId: "org_default", effectivePermissions: ["task_group:review", "project:read"]};
    const reachText = renderAs(partialReviewer, reachState, "monitor", "p1");
    check("在别的组上有同名权限的人，也要被告知这几条他够不着（它们仍挡着关闭门）",
      /你处置不了/u.test(reachText) && /2 项/u.test(reachText) && /别人的组/u.test(reachText),
      "警告没出来：跨资源并集判成「有权」，而按组过滤又把这两条计划整个滤掉 —— 人什么都看不到");
    check("要说清权限是按任务组给的（否则他会以为自己已经有了）",
      /按【任务组】授予/u.test(reachText)
        && /项目管理」→「成员权限」→「项目成员授权/u.test(reachText),
      "只说缺权限，没说这个权限是按组给的 —— 他在别的组上确实有，会以为界面坏了");
    // 正面对照：全都够得着时不要多说一句（常亮的警告等于没有警告）。
    const fullReachState = structuredClone(reachState);
    fullReachState.taskGroupPermissions = {tg1: ["task_group:review"], tg2: ["task_group:review"]};
    check("全都够得着时不要多说一句",
      !/你处置不了/u.test(renderAs(partialReviewer, fullReachState, "monitor", "p1")),
      "有权处置的人也被告知自己处置不了");

    // 关闭门被 artifacts_verified 挡住时，人被告知"等执行方补齐证据，或取消对应工作项" ——
  // 却不知道该盯哪一条产物。artifacts 那时在防泄漏白名单里，但没有任何视图真的下发它。
    {
    const artifactState = {
      taskGroups: [{id: "tg1", projectId: "p1", name: "组一", status: "active", workItems: []}],
      closeBarriers: [{taskGroupId: "tg1", satisfied: false, computedAt: "2026-08-20T00:00:00.000Z",
        blockingObjects: [{objectType: "CloseBarrierGate", objectId: "tg1", gate: "artifacts_verified",
          status: "blocked"}]}],
      artifacts: [
        {artifactId: "af_missing", taskGroupId: "tg1", workItemId: "wi_7", status: "registered",
          contentDigestAttested: false},
        {artifactId: "af_ok", taskGroupId: "tg1", workItemId: "wi_8", status: "verified"}
      ],
      humanConfirmationRequests: [], humanDirectives: [], agentDispatches: [], workSessions: [],
      qualityGates: [], findings: [], permissionRequests: [], approvalRequests: [],
      truncatedCollections: []
    };
    const artifactText = renderAs({accountId: "u1", accountType: "system_admin", displayName: "管理员",
      organizationId: "org_default"}, artifactState, "monitor", "p1");
    check("产物没核验挡住关闭门时，要点名是哪一条产物、哪个格子",
      /af_missing/u.test(artifactText) && /wi_7/u.test(artifactText),
      "只说了「还有产物没核验」，人不知道该盯哪个格子 —— 而它就在下发的载荷里");
    check("已核验的产物不要混进「还挡着的」里（那会让人去追一条根本没挡路的记录）",
      !/af_ok/u.test(artifactText),
      "把已核验的产物也列成了阻塞");
  }

    // 发现项处置完也从「待你处置」里消失，处置人同样没有读取点。
    finalizedState.findings = [{findingId: "fd1", taskGroupId: "tg1", status: "resolved",
      dispositionClass: "fixed_verified", dispositionedBy: "u1", updatedAt: "2026-08-13T00:00:00.000Z"}];
    const withFindingText = renderAs({accountId: "u1", accountType: "system_admin", displayName: "管理员",
      organizationId: "org_default"}, finalizedState, "monitor", "p1");
    // 抬头写着"这些收尾只能由真人做"。AI 自己处置掉的发现项（没有 dispositionedBy）混进来，
    // 这一屏就在说假话 —— 真实运行态里第一行正是这样：定稿人一栏是个「-」。
    finalizedState.findings = [...finalizedState.findings,
      {findingId: "fd_ai", taskGroupId: "tg1", status: "resolved", dispositionClass: "fixed_verified",
        updatedAt: "2026-08-14T00:00:00.000Z"}];
    const mixedText = renderAs({accountId: "u1", accountType: "system_admin", displayName: "管理员",
      organizationId: "org_default"}, finalizedState, "monitor", "p1");
    check("没有真人在上面的处置不许列进「人工定稿」（那一屏抬头就是这么承诺的）",
      !/fd_ai/u.test(mixedText),
      "AI 自己处置的记录也被列成了人工定稿，定稿人一栏是个「-」");

    check("处置完的发现项也要留得下「谁判的、判成了什么」",
      /fd1/u.test(withFindingText) && /fixed_verified|已修复/u.test(withFindingText),
      "发现项一处置就从界面上整个消失，事后查不到是谁判的");

    check("定稿理由旁边要说得出是谁定的、定成了什么",
      /最近的人工定稿/u.test(finalizedText) && /管理员/u.test(finalizedText)
        && /rs1|src:mgp/u.test(finalizedText),
      "只有理由没有定稿人/对象 —— 一句话悬在那里，追不到是谁在哪件事上说的");

    check("给的出口必须是后端在这个状态真接受的那一个（降级），而不是它会拒绝的终止",
      /降级为串行执行/u.test(eligibilityText) && /降级理由/u.test(eligibilityText),
      "没有降级入口 —— 后端有这条杠杆而界面上没有，等于这个杠杆不存在");
    // 中间那段是数据（分支 id），必须【原样】留着 —— 它是人定位到哪个分支的唯一线索。
    check("阻塞项里的分支 id 要原样显示，不要被当成枚举翻译掉",
      /b_api/u.test(stuckText),
      "分支 id 不见了 —— 人知道「有个分支没写验收项」，却不知道是哪一个");
  }
  // 界面上的每一个权限门（canOrchestrate 之类）都应当真的挡住些东西。一个门如果去掉它
  // 页面一字不变，那它要么写错了权限名、要么包的那块早就被挪走了 —— 人的权限被"看起来"
  // 限制住了，实际没有；反过来，一个真起作用的门若权限名与后端要的不一致，
  // 人会看到一个按下去必然 403 的按钮。这里用差分核对：不需要手编"哪个门管哪些按钮"的表。
  {
    const ALL_PERMS = ["task_group:review", "task_group:control", "task_group:orchestrate",
      "task_group:checkpoint_submit", "project:grant", "project:update", "agent:activate"];
    const richState = {
      schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "development",
        workItems: [{id: "wi1", title: "并行改造", status: "assigned", ownerRole: "agent-runtime", progress: 20}]}],
      executionTopologies: [{
        schemaVersion: "execution-topology/v1", topologyId: "topo1", projectId: "p1", taskGroupId: "tg1",
        workItemId: "wi1", status: "eligibility_checked", mode: "parallel_active",
        runnerKind: "none", isolation: "none", mergePolicy: "parent_serial_after_all_required_reported",
        groups: [{groupId: "g1", branches: [{branchId: "b_api", objective: "", status: "queued",
          ownedPaths: [], acceptanceChecks: [], outputContract: []}]}],
        blockers: ["runner_isolated:topo1:runner_or_isolation_none"],
        baseSnapshot: {stateVersion: 1, gitHead: "abc1234"},
        createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z"
      }],
      // 另外两种权限各配一条真数据，否则"去掉它页面一字不变"只说明这份状态触发不了那一块，
      // 不说明那道门是死的（差分判据最容易在这里骗自己）。形状照抄自这两块的过滤条件。
      reviewPlans: [{reviewPlanId: "rp1", projectId: "p1", taskGroupId: "tg1", workItemId: "wi1",
        status: "planned", createdAt: "2026-08-10T00:00:00.000Z"}],
      systemUpgradeCandidates: [{candidateId: "suc1", projectId: "p1", taskGroupId: "tg1",
        status: "candidate_created", summary: "把重试上限做成可配", createdAt: "2026-08-10T00:00:00.000Z"}],
      humanConfirmationRequests: [], humanDirectives: [], agentDispatches: [], workSessions: [],
      closeBarriers: [], qualityGates: [], findings: [], permissionRequests: [], approvalRequests: [],
      truncatedCollections: []
    };
    const asUser = (perms) => renderAs({accountId: "u2", accountType: "user_account", displayName: "操作员",
      organizationId: "org_default", effectivePermissions: perms}, richState, "monitor", "p1");
    const full = asUser(ALL_PERMS);
    const deadGates = [];
    for (const perm of ALL_PERMS) {
      const without = asUser(ALL_PERMS.filter((item) => item !== perm));
      if (without === full) deadGates.push(perm);
    }
    // 只在监控页上量：这一页同时用到 orchestrate / review / control 三种权限，
    // 另外四种主要落在别的页上，缺了它们这一页本来就不该变 —— 所以判据只针对这三种。
    const shouldMatter = ["task_group:orchestrate", "task_group:review", "task_group:control"];
    const silentlyDead = deadGates.filter((perm) => shouldMatter.includes(perm));
    check("监控页上三种权限各自都要真的挡住些东西（不然人的权限只是「看起来」被限制了）",
      silentlyDead.length === 0,
      `这些权限去掉后监控页一字不变：${silentlyDead.join("、")} —— 门包的那块要么被挪走了、要么权限名写错了`);
    // 反面：给全权限时，需要 orchestrate 的那两个入口必须都在（否则上面那条是"永远相等"）。
    check("有 orchestrate 权限时，自治循环与方案降级两个入口都要在",
      /运行自治循环/u.test(full) && /降级为串行执行/u.test(full),
      "全权限身份都看不到这两个入口 —— 上面那条差分断言测不出任何东西");
    // 缺 orchestrate 时，这两个入口必须都不在 —— 看得到却按不动同样是杠杆不可达。
    const noOrchestrate = asUser(ALL_PERMS.filter((item) => item !== "task_group:orchestrate"));
    check("没有 orchestrate 权限时，这两个入口都不该出现（按下去必然 403）",
      !/运行自治循环/u.test(noOrchestrate) && !/降级为串行执行/u.test(noOrchestrate),
      "看得到按钮却按不动 —— 后端 execution_topology_advance / orchestrator_run 都要 task_group:orchestrate");
  }
  // 派发卡在人工确认上时，控制面知道是哪一张卡挡住的，而界面从来没显示过它 ——
  // 人只看到"到人工审核页定稿对应的确认卡"，同时挂着好几张时只能一张张点开比对。
  {
    const blockedState = {
      schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "development",
        workItems: [{id: "wi1", title: "改造", status: "assigned", ownerRole: "agent-runtime", progress: 30}]}],
      agentDispatches: [{schemaVersion: "agent-dispatch/v1", dispatchId: "dsp_waiting", projectId: "p1",
        taskGroupId: "tg1", workItemId: "wi1", sessionId: "ws1", runId: "run1", status: "blocked",
        blockedReason: "awaiting_human_confirmation", humanConfirmationRef: "hcr_the_one_blocking_it",
        attempts: 1, createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z"}],
      workSessions: [], humanConfirmationRequests: [], humanDirectives: [], executionTopologies: [],
      closeBarriers: [], qualityGates: [], findings: [], permissionRequests: [], approvalRequests: [],
      truncatedCollections: []
    };
    const blockedText = renderAs({accountId: "u1", accountType: "system_admin", displayName: "管理员",
      organizationId: "org_default"}, blockedState, "monitor", "p1");
    check("派发卡在人工确认上时，要说清在等哪一张卡",
      /hcr_the_one_blocking_it/u.test(blockedText),
      "只说了「到人工审核页定稿对应的确认卡」，没说是哪一张 —— 同时挂着几张时人只能一张张点开比对");
  }
  // 一个卡住的派发在屏幕上跟一个正常在跑的派发长得一模一样：状态 running、进度是最高水位
  // （只增不减），没有任何时间。实测过一次 —— agent 侧挂死，心跳照常，控制面一直显示「还在跑」，
  // 26 分钟后才被人发现。控制面其实一直记着 lastExecutionEventAt，只是从没渲染过。
  {
    const stallState = {
      schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "development",
        workItems: [{id: "wi1", title: "改造", status: "in_progress", ownerRole: "agent-runtime", progress: 45}]}],
      agentDispatches: [
        {schemaVersion: "agent-dispatch/v1", dispatchId: "dsp_stalled", projectId: "p1", taskGroupId: "tg1",
          workItemId: "wi1", sessionId: "ws1", runId: "run1", status: "running", progressPercent: 45,
          attempts: 1, claimedAt: new Date(Date.now() - 95 * 60000).toISOString(),
          lastExecutionEventAt: new Date(Date.now() - 93 * 60000).toISOString(),
          createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z"},
        {schemaVersion: "agent-dispatch/v1", dispatchId: "dsp_fresh", projectId: "p1", taskGroupId: "tg1",
          workItemId: "wi1", sessionId: "ws2", runId: "run2", status: "running", progressPercent: 45,
          attempts: 1, claimedAt: new Date(Date.now() - 120000).toISOString(),
          lastExecutionEventAt: new Date(Date.now() - 30000).toISOString(),
          createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z"},
        {schemaVersion: "agent-dispatch/v1", dispatchId: "dsp_silent", projectId: "p1", taskGroupId: "tg1",
          workItemId: "wi1", sessionId: "ws3", runId: "run3", status: "running", progressPercent: 0,
          attempts: 1, claimedAt: new Date(Date.now() - 40 * 60000).toISOString(),
          createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z"},
        // 写坏的时间：Date 解析不出来时 NaN 会一路走成 0 —— 那会把一条坏记录说成「刚刚才动过」，
        // 恰好是最有利的那个解释。
        {schemaVersion: "agent-dispatch/v1", dispatchId: "dsp_bad_time", projectId: "p1", taskGroupId: "tg1",
          workItemId: "wi1", sessionId: "ws4", runId: "run4", status: "running", progressPercent: 10,
          attempts: 1, lastExecutionEventAt: "前天下午",
          createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z"},
        // 已了结的派发：认领时间在了结时被清掉，事件时间这一条也没有（doctor 的真实运行态里
        // 正是这样一条 completed 派发）。原先这一格照着 claimedAt 说话，于是写着「还没被领走」——
        // 一条已经跑完的活，屏幕上说它没人领。
        {schemaVersion: "agent-dispatch/v1", dispatchId: "dsp_done", projectId: "p1", taskGroupId: "tg1",
          workItemId: "wi1", sessionId: "ws5", runId: "run5", status: "completed", progressPercent: 100,
          attempts: 1, createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: new Date(Date.now() - 25 * 60000).toISOString()}
      ],
      workSessions: [], humanConfirmationRequests: [], humanDirectives: [], executionTopologies: [],
      closeBarriers: [], qualityGates: [], findings: [], permissionRequests: [], approvalRequests: [],
      truncatedCollections: []
    };
    const stallText = renderAs({accountId: "u1", accountType: "system_admin", displayName: "管理员",
      organizationId: "org_default"}, stallState, "monitor", "p1");
    check("正在跑的派发要说出它上一次有动静是多久以前",
      /2 小时前|93 分钟前/u.test(stallText) && /30 秒前/u.test(stallText),
      "两个派发都是 running 45%，一个刚动过、一个一个半小时没动了 —— 屏幕上必须能分出来，"
        + "否则挂死的 agent 与正常干活的 agent 长得一模一样");
    check("认不出的时间不得显示成「刚刚」",
      /时间无法识别/u.test(stallText) && !/(?<![0-9])0 秒前/u.test(stallText),
      "NaN 一路走成 0，一条坏记录就被说成刚刚才动过 —— 认不出的取值不许落在最有利的那个解释上");
    check("已了结的派发不许说「还没被领走」",
      /已了结 25 分钟前/u.test(stallText),
      "认领时间在了结时被清掉，这一格于是照着 claimedAt 说「还没被领走」—— 一条已经跑完的活，"
        + "屏幕上说它没人领过（真实运行态上读到的）。了结记录的 updatedAt 就是它最后一次动的时间");
    check("领走了却一次动静都没有的派发，要说的是「还没有过动静」而不是留空",
      /还没有过动静/u.test(stallText),
      "这一格空着与「刚刚才动过」看不出区别 —— 而它恰恰是最该被人看到的那种");
  }
  // 语言策略在视图里只留 languageTag / languageName（整份 331 字节里 scope 就占 133，而界面不读它）。
  // 钉住：只给这两个字段时，列表那句「语言：X」和详情页那个下拉的预选值都还对。
  {
    const slimLangState = {
      schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [{id: "tg1", projectId: "p1", name: "日语组", status: "development", roleCount: 0,
        languagePolicy: {languageTag: "ja", languageName: "Japanese"}, workItems: []}],
      humanConfirmationRequests: [], humanDirectives: [], agentDispatches: [], workSessions: [],
      executionTopologies: [], closeBarriers: [], qualityGates: [], findings: [],
      permissionRequests: [], approvalRequests: [], truncatedCollections: []
    };
    const langText = renderAs({accountId: "u1", accountType: "system_admin", displayName: "管理员",
      organizationId: "org_default"}, slimLangState, "tg", "p1");
    check("语言策略只给 tag 时，界面显示的仍是那门语言（不是回落成中文）",
      /语言：日本語/u.test(langText),
      "视图里的语言策略已经瘦到只剩 languageTag / languageName —— 界面若还依赖别的字段，"
        + "屏幕上会静默回落成默认的「中文」，而这个组配的是别的语言");
  }
  // 任务组整份 roles 不再进视图（列表只用来数个数，明细页读的是进度接口那份）——
  // 服务端改给 roleCount。这里钉住：界面显示的就是服务端给的那个数，而不是它自己数出来的 0。
  {
    const countState = {
      schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [{id: "tg1", projectId: "p1", name: "有七个角色的组", status: "development",
        roleCount: 7, workItems: []}],
      humanConfirmationRequests: [], humanDirectives: [], agentDispatches: [], workSessions: [],
      executionTopologies: [], closeBarriers: [], qualityGates: [], findings: [],
      permissionRequests: [], approvalRequests: [], truncatedCollections: []
    };
    const countText = renderAs({accountId: "u1", accountType: "system_admin", displayName: "管理员",
      organizationId: "org_default"}, countState, "tg", "p1");
    check("任务组的角色数显示的是服务端给的那个数（整份 roles 不再下发）",
      /角色数：7/u.test(countText),
      "视图不再带整份 roles（列表只数个数、明细页另有来源）—— 界面必须用服务端给的 roleCount，"
        + "否则它自己数一个空数组，屏幕上永远是 0");
  }
  // 人工指令页的「目标任务组」下拉：只列出你真能控制的那些。列全了的话，人照着下拉选一个，
  // 提交必然 403 —— 而下拉本身就是这一页告诉他"可以选什么"的地方。
  {
    const directiveState = {
      schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [
        {id: "tg_mine", projectId: "p1", name: "我能控的", status: "development", workItems: []},
        {id: "tg_theirs", projectId: "p1", name: "别人的组", status: "development", workItems: []}
      ],
      taskGroupPermissions: {tg_mine: ["task_group:read", "task_group:control"], tg_theirs: ["task_group:read"]},
      humanDirectives: [], humanConfirmationRequests: [], agentDispatches: [], workSessions: [],
      executionTopologies: [], closeBarriers: [], qualityGates: [], findings: [],
      permissionRequests: [], approvalRequests: [], truncatedCollections: []
    };
    const directiveText = renderAs({accountId: "u_op", accountType: "member", displayName: "操作员",
      organizationId: "org_default", effectivePermissions: ["project:view", "task_group:read", "task_group:control"]},
      directiveState, "directives", "p1");
    check("人工指令的「目标任务组」下拉只列出你真能控制的组",
      /我能控的/u.test(directiveText) && !/别人的组/u.test(directiveText),
      "下拉列出了没有控制权的任务组 —— 人照着它选一个，提交必然 403");
    // 【处置方式下拉不许 required】。它只对「决策处置」类型生效，浏览器的约束校验却不看类型：一旦 required，
    // 提交「补充要求」也会被拦住（门的 probe.submit 绕过约束校验，只能看渲染出来的属性 —— renderAs 会剥掉标签，
    // 这里要拿原始 HTML）。
    {
      const rawRoot = el("div");
      loadConsole(rawRoot, {realI18n: true}).renderFullPageWith(directiveState,
        {accountId: "u_op", accountType: "member", displayName: "操作员", organizationId: "org_default",
          effectivePermissions: ["project:view", "task_group:read", "task_group:control"]}, "p1", "directives");
      const formHtml = String(rawRoot.innerHTML || "");
      const resolutionTag = formHtml.match(/<select name="resolution"[^>]*>/u)?.[0] || "";
      check("人工指令表单要渲染出来、处置方式下拉不带 required",
        /data-form="directive-create"/u.test(formHtml) && resolutionTag && !/\brequired\b/u.test(resolutionTag),
        !resolutionTag ? "表单或下拉没渲染出来（这条什么也没验）" : `下拉是 ${resolutionTag} —— 提交「补充要求」会被浏览器拦住`);
    }
  }
  // 监控页上的「关闭任务组 / 豁免质量门」也一样：动作按【那一行所属的任务组】判。
  {
    const monitorState = {
      schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [
        {id: "tg_mine", projectId: "p1", name: "我能控的", status: "development", workItems: []},
        {id: "tg_theirs", projectId: "p1", name: "别人的组", status: "development", workItems: []}
      ],
      taskGroupPermissions: {tg_mine: ["task_group:read", "task_group:control", "task_group:review"],
        tg_theirs: ["task_group:read"]},
      closeBarriers: [
        {barrierId: "cb1", projectId: "p1", taskGroupId: "tg_mine", satisfied: true, blockingObjects: [],
          computedAt: "2026-08-20T00:00:00.000Z"},
        {barrierId: "cb2", projectId: "p1", taskGroupId: "tg_theirs", satisfied: true, blockingObjects: [],
          computedAt: "2026-08-20T00:00:00.000Z"}
      ],
      humanConfirmationRequests: [], humanDirectives: [], agentDispatches: [], workSessions: [],
      executionTopologies: [], qualityGates: [], findings: [], permissionRequests: [], approvalRequests: [],
      truncatedCollections: []
    };
    const monitorText = renderAs({accountId: "u_op", accountType: "member", displayName: "操作员",
      organizationId: "org_default", effectivePermissions: ["project:view", "task_group:read", "task_group:control"]},
      monitorState, "monitor", "p1");
    const closeButtons = (monitorText.match(/关闭任务组/gu) || []).length;
    if (!/我能控的/u.test(monitorText)) {
      check("监控页按组判权的夹具要真渲染出关闭门那张表", false, "这一屏没渲染出关闭门 —— 断言什么也没验");
    } else {
      check("「关闭任务组」按钮只出现在你真有权控制的那一行",
        closeButtons === 1,
        `两个任务组都满足关闭条件，而按钮出现了 ${closeButtons} 个（应为 1）—— `
          + "并集判权会让人在别人负责的组上也看到「关闭任务组」，按下去必然 403");
    }
  }
  // 人工审核页上，够不着的那几张卡要说清【是哪个组】不给你动。三种卡里两种此前一句话都没有
  // （表单不见了、卡片照样挂着，多半还带着「阻塞执行」），第三种那句写的是"当前账号无人工审核权限"——
  // 而判权是按任务组的：在 A 组有权的人看到 B 组的卡时，这句话是假的。
  {
    const reviewScopeState = {
      schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [
        {id: "tg_mine", projectId: "p1", name: "我能审的", status: "development", workItems: []},
        {id: "tg_theirs", projectId: "p1", name: "别人的组", status: "development", workItems: []}
      ],
      taskGroupPermissions: {tg_mine: ["task_group:read", "task_group:review"], tg_theirs: ["task_group:read"]},
      humanConfirmationRequests: [
        {requestId: "hcr_mine", projectId: "p1", taskGroupId: "tg_mine", status: "pending", round: 1,
          decisionClass: "major", blocking: true, question: {summary: "我这组的定稿"}, options: [{optionId: "o1", label: "通过"}],
          createdAt: "2026-08-20T00:00:00.000Z"},
        {requestId: "hcr_theirs", projectId: "p1", taskGroupId: "tg_theirs", status: "pending", round: 1,
          decisionClass: "major", blocking: true, question: {summary: "别人组的定稿"}, options: [{optionId: "o1", label: "通过"}],
          createdAt: "2026-08-20T00:00:00.000Z"}
      ],
      approvalRequests: [{approvalId: "apr_theirs", projectId: "p1", taskGroupId: "tg_theirs", status: "requested",
        riskClass: "high", summary: "别人组的审批", createdAt: "2026-08-20T00:00:00.000Z"}],
      findings: [{findingId: "fnd_theirs", projectId: "p1", taskGroupId: "tg_theirs", status: "open",
        severity: "high", summary: "别人组的发现项", createdAt: "2026-08-20T00:00:00.000Z"}],
      permissionRequests: [], humanDirectives: [], agentDispatches: [], workSessions: [],
      executionTopologies: [], closeBarriers: [], qualityGates: [], truncatedCollections: []
    };
    const reviewText = renderAs({accountId: "u_rev", accountType: "member", displayName: "评审员",
      organizationId: "org_default", effectivePermissions: ["project:view", "task_group:read", "task_group:review"]},
      reviewScopeState, "review", "p1");
    // 夹具没造出想测的情形也要能自报：两张卡都得渲染出来，断言才有意义。
    if (!/我这组的定稿/u.test(reviewText) || !/别人组的定稿/u.test(reviewText)) {
      check("人工审核按组判权的夹具要把两张卡都渲染出来", false,
        "这一屏没渲染出待确认卡 —— 下面几条断言什么也没验");
    } else {
      const notes = (reviewText.match(/别人的组」上没有/gu) || []).length;
      check("够不着的卡要说清是【哪个任务组】不给你动",
        notes === 3,
        `三张够不着的卡（定稿 / 审批 / 发现项）里只有 ${notes} 张说了 —— `
          + "另外那些表单不见了、卡片还挂着（多半带着「阻塞执行」），人分不清是自己没权还是页面坏了");
      check("按组判权时不许再说「当前账号无人工审核权限」",
        !/当前账号无“人工审核”权限/u.test(reviewText),
        "这个账号在另一个组上明明有评审权 —— 说他「账号无权限」是假话，他找不到该找谁");
      check("有权的那张卡照常给表单",
        /选择定稿/u.test(reviewText),
        "有权的组上也没有定稿表单 —— 上面那条测的就不是「够不着」了");
    }
    // 【靠授权拿到评审权的人，控制台要认】。effectivePermissions 由服务端算（直接 ∪ 生效授权），
    // 这里不手写它，而是用服务端那同一个函数从授权算出来 —— 函数漏掉授权那一支时，这条会红。
    {
      const grantedReviewer = {accountId: "u_granted_rev", accountType: "user_account", displayName: "靠授权的评审员",
        organizationId: "org_default", permissions: []};
      const grantState = {
        ...reviewScopeState,
        accessGrants: [{grantId: "g_rev", status: "active", subjectRef: {subjectType: "account", subjectId: "u_granted_rev"},
          resourceType: "task_group", resourceId: "tg1", permissions: ["task_group:read", "task_group:review"]}]
      };
      const effective = accountEffectivePermissions(grantState, grantedReviewer);
      const grantedText = renderAs({...grantedReviewer, effectivePermissions: effective}, grantState, "review", "p1");
      check("靠授权拿到评审权的人，人工审核页不许说他「无权限」",
        effective.includes("task_group:review") && !/仅可查看/u.test(grantedText),
        `服务端算出的有效权限是 [${effective.join("、")}]，页面${/仅可查看/u.test(grantedText) ? "写着「仅可查看」" : "没写「仅可查看」"} —— `
          + "他手里的授权白发了，人以为是自己没权而不是页面漏算");
    }
  }
  // 按钮同理：任务组列表上「暂停 / 恢复 / 纠偏」这些是按任务组授权的，而控制台原先用跨资源并集判 ——
  // 只在 tg1 上有控制权的人，在 tg2 那一行也看得到按钮，按下去必然 403（「看得到按不动」）。
  {
    const twoGroups = {
      schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [
        {id: "tg_mine", projectId: "p1", name: "我能控的", status: "development", workItems: []},
        {id: "tg_theirs", projectId: "p1", name: "别人的组", status: "development", workItems: []}
      ],
      taskGroupPermissions: {tg_mine: ["task_group:read", "task_group:control"], tg_theirs: ["task_group:read"]},
      humanConfirmationRequests: [], humanDirectives: [], agentDispatches: [], workSessions: [],
      executionTopologies: [], closeBarriers: [], qualityGates: [], findings: [],
      permissionRequests: [], approvalRequests: [], truncatedCollections: []
    };
    const rows = renderAs({accountId: "u_op", accountType: "member", displayName: "操作员",
      organizationId: "org_default", effectivePermissions: ["project:view", "task_group:read", "task_group:control"]},
      twoGroups, "tg", "p1");
    // renderAs 给的是【去掉标签之后的可见文本】，所以按可见文案分段核，不要去匹配 HTML 属性
    //（第一版就是这么写的，两边都数到 0，看起来像修复没生效）。
    const flat = rows.replace(/\s+/gu, " ");
    // 用【最后一次出现】：这一页上面的「创建工作项」表单里有个下拉，把两个组名先列了一遍，
    // 取第一次出现会切到那段下拉文本上，两边都数不到按钮（第一版就是这么误判的）。
    const mineFrom = flat.lastIndexOf("我能控的");
    const theirsFrom = flat.lastIndexOf("别人的组");
    const mineSegment = mineFrom >= 0 && theirsFrom > mineFrom ? flat.slice(mineFrom, theirsFrom) : "";
    const theirsSegment = theirsFrom >= 0 ? flat.slice(theirsFrom) : "";
    if (!mineSegment || !theirsSegment) {
      check("任务组列表按组判权的夹具要真渲染出两组", false,
        "这一屏没渲染出那两个任务组 —— 下面的断言什么也没验");
    } else {
      check("任务组列表上的控制按钮只出现在你真有权控制的那一组",
        /暂停/u.test(mineSegment) && !/暂停/u.test(theirsSegment),
        `我能控的那段${/暂停/u.test(mineSegment) ? "有" : "没有"}控制按钮、别人那段${/暂停/u.test(theirsSegment) ? "也有" : "没有"} —— `
          + "并集判权会让人在别人负责的组上也看到按钮，按下去必然 403");
    }
  }
  // 「待你处理」那块明写着「只统计你有权处置的；别人负责的部分不会出现在这里」。
  // 而控制台判权用的是 effectivePermissions —— 服务端注释里就写着它是【跨资源的并集、只作 UI 提示】，
  // 后端每一次写入却是按资源判的。于是只在 tg1 上有评审权的人，会把 tg2 的待办也算成自己的，
  // 点进去必然 403。服务端现在按任务组把真实权限算好下发（taskGroupPermissions）。
  {
    const scopedState = {
      schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [
        {id: "tg1", projectId: "p1", name: "我负责的", status: "development", workItems: []},
        {id: "tg2", projectId: "p1", name: "别人负责的", status: "development", workItems: []}
      ],
      // 两个任务组各有一张待定稿的确认单，而这个人只在 tg1 上有评审权。
      humanConfirmationRequests: [
        {requestId: "hcr_mine", projectId: "p1", taskGroupId: "tg1", status: "pending", round: 1,
          question: {title: "我该定的", detail: "我该定的"}, options: [{optionId: "a", summary: "甲"}]},
        {requestId: "hcr_theirs", projectId: "p1", taskGroupId: "tg2", status: "pending", round: 1,
          question: {title: "别人该定的", detail: "别人该定的"}, options: [{optionId: "a", summary: "甲"}]}
      ],
      taskGroupPermissions: {tg1: ["task_group:read", "task_group:review"], tg2: ["task_group:read"]},
      humanDirectives: [], agentDispatches: [], workSessions: [], executionTopologies: [],
      closeBarriers: [], qualityGates: [], findings: [], permissionRequests: [], approvalRequests: [],
      truncatedCollections: []
    };
    const scopedText = renderAs({accountId: "u_reviewer", accountType: "member", displayName: "评审人",
      organizationId: "org_default", effectivePermissions: ["project:view", "task_group:read", "task_group:review"]},
      scopedState, "review", "p1");
    // 计数按组算了，卡片上的【动作】也要按组：同一屏上两张确认单，只有我负责的那张能定稿。
    // （这一屏会把两张卡片都列出来 —— 看得见没问题，「看得见却按不动」才是问题。）
    const mineAt = scopedText.lastIndexOf("我该定的");
    const theirsAt = scopedText.lastIndexOf("别人该定的");
    if (mineAt < 0 || theirsAt < 0) {
      check("人工审核页按组判权的夹具要真渲染出两张卡片", false,
        "这一屏没渲染出那两张确认单 —— 下面的断言什么也没验");
    } else {
      const first = mineAt < theirsAt ? scopedText.slice(mineAt, theirsAt) : scopedText.slice(mineAt);
      const second = mineAt < theirsAt ? scopedText.slice(theirsAt) : scopedText.slice(theirsAt, mineAt);
      // 认【按钮上的字】而不是"定稿"这两个字：够不着的卡上现在会写一句"你在任务组「X」上没有
      // 人工审核（定稿）的权限"，光搜 /定稿/ 会被它喂饱（本仓的老毛病：新文案喂饱旁边那条断言）。
      const hasForm = (text) => /选择定稿/u.test(text);
      check("确认单的定稿表单只出现在你有权评审的那个任务组上",
        hasForm(first) && !hasForm(second),
        `我负责的那张${hasForm(first) ? "有" : "没有"}定稿表单、别人那张${hasForm(second) ? "也有" : "没有"} —— `
          + "后端按资源判权，并集会让人对着一张按不动的表单填半天");
    }
    check("「待你处理」只算你在【那个任务组】上真有权处置的",
      /共 1 项等待你处理/u.test(scopedText) && !/共 2 项等待你处理/u.test(scopedText),
      "控制台判权用的是跨资源的并集，而后端按资源判 —— 只在 tg1 上有评审权的人会看到 tg2 的待办，"
        + "点进去必然 403，而这块面板明写着「别人负责的部分不会出现在这里」");
    check("当前项目待办不要重复提示先进入当前项目",
      /按当前项目视图统计/u.test(scopedText) && !/先进入项目：项目/u.test(scopedText),
      "服务端 tasks 视图已经按当前项目过滤，当前项目内待办再写「先进入项目」只会误导用户以为这里是跨项目总览");
    const crossProjectRoot = el("div");
    const crossProjectState = structuredClone(scopedState);
    crossProjectState.projects = [
      {id: "p1", name: "当前项目", organizationId: "org_default", status: "active", members: []},
      {id: "p2", name: "待办项目", organizationId: "org_default", status: "active", members: []}
    ];
    crossProjectState.taskGroups = [
      {id: "tg2_only", projectId: "p2", name: "待办组", status: "development", workItems: []}
    ];
    crossProjectState.humanConfirmationRequests = [
      {requestId: "hcr_p2", projectId: "p2", taskGroupId: "tg2_only", status: "pending", round: 1,
        question: {title: "跨项目定稿", detail: "跨项目定稿"}, options: [{optionId: "a", summary: "甲"}]}
    ];
    crossProjectState.taskGroupPermissions = {tg2_only: ["task_group:read", "task_group:review"]};
    loadConsole(crossProjectRoot, {realI18n: true}).renderFullPageWith(crossProjectState, {
      accountId: "u_reviewer", accountType: "member", displayName: "评审人", organizationId: "org_default",
      effectivePermissions: ["project:view", "task_group:read", "task_group:review"]
    }, "p1", "review");
    const crossProjectHtml = String(crossProjectRoot.innerHTML || "").replace(/<!--[\s\S]*?-->/gu, "");
    check("跨项目待办入口必须先切到待办所在项目",
      /处置入口：人工审核 · 先进入项目：待办项目/u.test(crossProjectHtml)
        && /data-action="open-project-page" data-project="p2" data-target-menu="review"/u.test(crossProjectHtml),
      "待你处理面板必须按当前项目口径说明；若混入跨项目数据，按钮要先切到待办所属项目");
  }
  // 「受阻项」数的是任务组身上的 blockers；而【被挡住的派发】是另一回事，只在执行监控页上说。
  // 真实运行态上实测过：概览显示「受阻项 0」，同一份数据里有 2 个 blocked 派发、
  // 监控页正提示「有执行被挡住，需要人处理」—— 人先看的那一屏让他得出相反结论。
  {
    const stuckState = {
      schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "development",
        blockers: [], workItems: [{id: "wi1", title: "改造", status: "in_progress", ownerRole: "agent-runtime", progress: 40}]}],
      agentDispatches: [
        {schemaVersion: "agent-dispatch/v1", dispatchId: "d_blocked_1", projectId: "p1", taskGroupId: "tg1",
          workItemId: "wi1", sessionId: "s1", runId: "r1", status: "blocked", blockedReason: "task_group_pause",
          attempts: 1, createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z"},
        {schemaVersion: "agent-dispatch/v1", dispatchId: "d_blocked_2", projectId: "p1", taskGroupId: "tg1",
          workItemId: "wi1", sessionId: "s2", runId: "r2", status: "blocked", blockedReason: "task_group_pause",
          attempts: 1, createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z"},
        {schemaVersion: "agent-dispatch/v1", dispatchId: "d_running", projectId: "p1", taskGroupId: "tg1",
          workItemId: "wi1", sessionId: "s3", runId: "r3", status: "running", attempts: 1,
          createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z"}
      ],
      workSessions: [], humanConfirmationRequests: [], humanDirectives: [], executionTopologies: [],
      closeBarriers: [], qualityGates: [], findings: [], permissionRequests: [], approvalRequests: [],
      truncatedCollections: []
    };
    const stuckText = renderAs({accountId: "u1", accountType: "system_admin", displayName: "管理员",
      organizationId: "org_default"}, stuckState, "proj-overview", "p1");
    check("受阻项为 0 但有派发被挡住时，概览要把这件事说出来",
      /另有 2\s*个派发被挡住/u.test(stuckText),
      "概览是人每天先看的那一屏 —— 它显示「受阻项 0」时人就不会再往执行监控页找了，"
        + "而那边正提示「有执行被挡住，需要人处理」");
    // 出口提示里有一类是「叫读的人自己去按一个按钮」，而按不按得动要按【任务组】判。
    // 观察者在监控页照样看到「到该任务组页点「恢复执行」」，他那一页上却根本没有这个按钮 ——
    // 指到一个够不着的地方，比不给出口更耗人（真实运行态渲染出来读到的）。
    {
      const viewerAccount = {accountId: "u2", accountType: "user_account", displayName: "观察者",
        organizationId: "org_default", permissions: ["task_group:read"], effectivePermissions: ["task_group:read"]};
      const viewerText = renderAs(viewerAccount, {...stuckState,
        taskGroupPermissions: {tg1: ["task_group:read"]}, taskGroupPermissionsDefault: ["task_group:read"]},
        "monitor", "p1");
      check("够不着的出口要说清是哪个任务组够不着",
        /有执行被挡住/u.test(viewerText) && /没有这个权限/u.test(viewerText) && /任务组/u.test(viewerText),
        "观察者读到「到该任务组页点「恢复执行」」，而那一页上没有这个按钮 —— "
          + "出口指到够不着的地方，人只会在两页之间来回找");
      const adminText = renderAs({accountId: "u1", accountType: "system_admin", displayName: "管理员",
        organizationId: "org_default"}, stuckState, "monitor", "p1");
      check("有权限的人不该看到那句「你没有权限」",
        /有执行被挡住/u.test(adminText) && !/没有这个权限/u.test(adminText),
        "给有权的人加一句「你没权限」，会让他以为自己按不动而去找别人");
    }
    // 同一屏上还有一张「任务组一览」，每行一个「受阻数」—— 它数的也是 blockers。
    // 人扫这张表是在找"哪个组卡住了"，而卡着 2 个派发的那一行显示 0，等于把他从答案上引开。
    check("任务组一览的受阻数为 0 但这个组有派发被挡住时，行上要说出来",
      /派发被挡 2/u.test(stuckText),
      "关键指标那一格已经补过差额，而逐行看表的人看到的仍是「0」—— 两个数并排且都出自这一屏，"
        + "不能一个说了、另一个不说");
  }
  // 项目概览上的「待人工确认」只数确认单一类，而等人拍板的东西有九类、散在两个页面上。
  // 它是人每天先看的那一屏：显示 0 的时候人就不会再往下找（真实运行态上实测到过 ——
  // 这里 0，同一时刻人工审核页"共 3 项等待你处理"）。
  {
    const todoState = {
      schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "development", workItems: []}],
      // 一条确认单都没有，但有三条等人收尾的评审计划。
      humanConfirmationRequests: [],
      reviewPlans: [1, 2, 3].map((n) => ({reviewPlanId: `rp${n}`, projectId: "p1", taskGroupId: "tg1",
        status: "planned", createdAt: "2026-08-10T00:00:00.000Z"})),
      humanDirectives: [], agentDispatches: [], workSessions: [], executionTopologies: [],
      closeBarriers: [], qualityGates: [], findings: [], permissionRequests: [], approvalRequests: [],
      truncatedCollections: []
    };
    const overview = renderAs({accountId: "u1", accountType: "system_admin", displayName: "管理员",
      organizationId: "org_default"}, todoState, "proj-overview", "p1");
    check("项目概览上「待人工确认 0」时，若别处还有等人处理的事，必须在同一格里说出来",
      /另有 3 项等你处理/u.test(overview),
      "只显示了「待人工确认 0」—— 人当天就不会再去人工审核页，而那里正躺着三条等他收尾的评审计划");
    check("并且要给出去处（否则人知道有事却不知道去哪）",
      /人工审核/u.test(overview),
      "说了还有事，没说去哪看");

    // 反过来：这个数【不按权限过滤】（它是项目层面的事实），而旁边那句"等你处理"是按权限算的。
    // 于是只读成员看到的是一个光秃秃的数：管理员那边还有「另有 N 项等你处理 → 去哪处置」，
    // 他这边什么都没有，点进人工审核页才被告知"只能看、不能动"（真实运行态上就是这样）。
    const viewerState = structuredClone(todoState);
    viewerState.reviewPlans = [];
    viewerState.humanConfirmationRequests = [{requestId: "hcr1", projectId: "p1", taskGroupId: "tg1",
      status: "pending", decisionClass: "major", question: {summary: "验收确认"}, options: [],
      createdAt: "2026-08-10T00:00:00.000Z"}];
    const viewerText = renderAs({accountId: "u2", accountType: "org_member", displayName: "只读成员",
      organizationId: "org_default", permissions: ["project:read"], taskGroupPermissions: {}},
      viewerState, "proj-overview", "p1", 1);
    check("够不着的那个数要说清「你没权限、在等谁」，不能只摆一个数字",
      /没有定稿权限/u.test(viewerText) && /有权的人/u.test(viewerText),
      String(viewerText).replace(/<[^>]+>/gu, " ").match(/待人工确认[^|]{0,60}/u)?.[0] || "（这一格没渲染出来）");
    const adminSame = renderAs({accountId: "u1", accountType: "system_admin", displayName: "管理员",
      organizationId: "org_default"}, viewerState, "proj-overview", "p1", 1);
    check("有权的人不要看到这句（给有权的人说「你没权限」会让他去找别人）",
      !/没有定稿权限/u.test(adminSame),
      "有处置权的人也被告知自己没有权限");
  }
  // 「重新初始化运行态」这个按钮就在系统管理员的落地页上，一点抹掉全部数据。
  // 它的说明原先写着"仅用于本地环境排障"—— 而服务端【没有任何环境判据】，生产同样点得动
  // （服务端注释自己写着这一点）。文案让人以为生产点不了，那比不写更坏。
  {
    const sysText = renderAs({accountId: "u1", accountType: "system_admin", displayName: "管理员",
      organizationId: "org_default"}, baseState([], []), "sys-overview");
    check("抹掉全部数据那个按钮，说明里不能暗示「生产环境点不了」",
      !/仅用于本地环境排障/u.test(sysText),
      "说明写着「仅用于本地环境排障」，而服务端没有环境判据 —— 人以为生产点不了，实际点得动");
    check("要说清真正拦住误操作的是什么（打字确认），以及它在什么条件下触发",
      /生产环境同样点得动/u.test(sysText) && /打字确认|原样输入/u.test(sysText),
      "没说清拦住它的是下一步的打字确认，人会以为有别的保护");
  }
  // 「控制面会按固定周期自动跑编排」这句原先写死"默认每分钟一次"——而间隔由环境变量决定，
  // 运维调过之后它就在说假话，而人正是照它判断"等多久还没动静才算不对劲"。
  // 关掉自治时更要说清：否则人会一直等一个永远不会来的自动推进。
  {
    const cadenceState = (orchestrator) => ({
      schemaVersion: "runtime-state/v1", stateVersion: 1,
      runtime: {autonomousOrchestrator: orchestrator},
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      // 没有 taskAnalysis 的任务组才会出现那句「事项清单尚未生成」。
      taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "development", workItems: []}],
      humanConfirmationRequests: [], humanDirectives: [], agentDispatches: [], workSessions: [],
      executionTopologies: [], closeBarriers: [], qualityGates: [], findings: [],
      permissionRequests: [], approvalRequests: [], truncatedCollections: []
    });
    const who = {accountId: "u1", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"};
    // 「事项清单尚未生成」那块在任务组【详情】里，要走 renderTaskGroupsWith 并给一份没有
    // taskAnalysis 的 detail —— 用整页渲染的话那一屏根本不出现，断言会报"没渲染出来"（实测）。
    const renderDetail = (orchestrator) => {
      // renderTaskGroupsWith 是【返回】这段 HTML 的，不写进 documentRoot（第一版读 innerHTML，
      // 拿到 123 个字符的空壳，断言报"这一屏没渲染出来"）。
      const html = loadConsole(el("div"), {realI18n: true})
        .renderTaskGroupsWith(cadenceState(orchestrator), who, "p1", "tg1",
          // taskGroupId 必须对上，否则详情面板会显示"正在加载"而不是内容（第一版漏了它）。
          // 形状照抄 loadTaskGroupDetail 真实赋的那一份：少一个字段面板就会在别处炸
          // （第一版只给 progress，撞了 "Cannot read properties of undefined"）。
          {taskGroupId: "tg1", loadFailed: false,
            progress: {taskAnalysis: null, roles: [], blockers: [], workItems: []},
            config: null, configVersion: null,
            roomMessages: [], roomMessageTotal: 0, roomMessagesTruncated: false});
      return String(html || "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
    };
    const slow = renderDetail({enabled: true, intervalMs: 300000});
    check("编排节奏要按真实下发的间隔说，不能写死「每分钟一次」",
      /每 300 秒一次/u.test(slow) && !/默认每分钟一次/u.test(slow),
      `运维把间隔调成 5 分钟，界面还在说别的：${(/自动跑编排（([^）]{0,40})/u.exec(slow) || [])[1] || "（这一屏没渲染出来）"}`);
    const off = renderDetail({enabled: false, intervalMs: 0});
    check("自治关掉时要说清「不会自动跑」，别让人等一个不会来的推进",
      /没有开自治周期/u.test(off),
      "自治关着，界面还在说「会按固定周期自动跑编排」—— 人会一直等下去");
  }
  const pages = ["proj-overview", "proj-members", "tg", "review", "directives", "monitor", "proj-agents", "proj-settings"];
  const silent = pages.filter((pageId) => !/当前账号暂无可见项目/u.test(renderAs(member, baseState([], []), pageId)));
  check("一个项目都没有时，八个项目页都要说清是【没有项目】而不是项目空着",
    silent.length === 0,
    `这些页没说：${silent.join("、")} —— 说"当前项目暂无任务组"会让人去找是哪个项目空着`);
  check("这句话要按视角给出下一步（成员去找组织管理员，自己建不了项目）",
    /请联系组织管理员为你分配项目/u.test(renderAs(member, baseState([], []), "monitor")),
    "只说了没有项目，没说下一步 —— 而成员自己建不了项目");
  // 反向：有项目、只是项目里还没有任务组 —— 那句区分必须还在，否则等于把一个有用的提示改没了。
  const withProject = baseState([{id: "p1", name: "探针项目", organizationId: "org_default", status: "active"}], []);
  const tgText = renderAs(member, withProject, "tg", "p1");
  check("有项目但项目里没有任务组时，仍要说的是「当前项目暂无任务组」",
    /当前项目暂无任务组/u.test(tgText) && !/当前账号暂无可见项目/u.test(tgText),
    `实得：${(tgText.match(/当前[^ ]{0,20}/u) || ["（两句都没有）"])[0]}`);
}

async function runSelfRowHasNoActionsCase() {
// 真正挡住"把自己停用"的是【渲染那一层】：成员列表给自己那一行不发任何操作按钮，
// 只挂一个「本人」徽标（manageable = accountType === "user_account" && !isSelf）。
// 这一条钉的就是它 —— 下面那段钉的是"万一将来把这层拿掉，处理器要说对话"，两层都要有。
{
  const root = el("div");
  const probeSelf = loadConsole(root, {realI18n: true});
  const me = {accountId: "acct_me", accountType: "org_admin", displayName: "我自己",
    email: "me@probe.local", organizationId: "org_default", status: "active", roles: ["org_admin"]};
  const mate = {accountId: "acct_mate", accountType: "user_account", displayName: "同事",
    email: "mate@probe.local", organizationId: "org_default", status: "active", roles: []};
  const canned = {"/api/org/members": {members: [me, mate]}, "/api/org/agents": {agentRuntimeNodes: []}};
  const stub = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/u, "").split("?")[0];
    const payload = path === "/api/state"
      ? {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {}, projects: [],
         organizations: [], accounts: [], taskGroups: [], truncatedCollections: []}
      : (canned[path] ?? {});
    return {ok: true, status: 200, statusText: "OK", headers: {get: () => null},
      json: async () => payload, text: async () => JSON.stringify(payload)};
  };
  const html = await probeSelf.loadPageWith(null, me, "", "org-members", stub);
  // 定位锚点踩过两次坑，都记在这里：
  // ① 不能按 accountId —— 自己那一行正因为没有任何按钮，accountId 压根不出现在 HTML 里；
  // ② 不能按显示名 —— 它先出现在【顶栏的账号标签】里，窗口会落在页头上而不是表格行。
  // 用邮箱：它只在成员表那一行里出现。
  const rowFor = (email) => {
    const at = html.indexOf(email);
    return at < 0 ? "" : html.slice(Math.max(0, at - 400), at + 900);
  };
  if (!rowFor("mate@probe.local").includes("data-account=\"acct_mate\"")) {
    failures.push("自己那一行: 成员表没渲染出同事那一行 —— 夹具没触达被测代码，本条在空转");
  } else {
    check("成员列表不给自己那一行发操作按钮（同事那一行有，才证明不是整表都没按钮）",
      !/data-action="member-status" data-account="acct_me"/u.test(html)
        && !/data-action="member-perms" data-account="acct_me"/u.test(html)
        && /data-action="member-status" data-account="acct_mate"/u.test(html),
      "自己那一行也给了停用/权限按钮 —— 点下去就是把自己登出");
    check("自己那一行要标出「本人」，否则人分不清哪一行是自己",
      rowFor("me@probe.local").includes("本人"),
      "成员表里认不出哪一行是自己");
  }
}
}

function runPendingTruncationCase() {
  const probe = loadConsole(el("div"));
  const admin = {accountId: "acct_a", accountType: "org_admin"};
  const stateWith = (truncatedCollections) => ({
    taskGroups: [{id: "tg1", projectId: "p1"}],
    humanConfirmationRequests: [
      {requestId: "h1", taskGroupId: "tg1", status: "pending"},
      {requestId: "h2", taskGroupId: "tg1", status: "pending"}
    ],
    ...(truncatedCollections ? {truncatedCollections} : {})
  });
  const exact = probe.renderPendingPanelWith(stateWith(null), admin);
  check("数得全时就报准确数",
    exact.includes("共 2 项") && !exact.includes("2+"),
    "没有截断时也把总数说成了约数 —— 会让人对准确的数字也不敢信");
  const capped = probe.renderPendingPanelWith(stateWith(["humanConfirmationRequests"]), admin);
  check("数不全时不得报成准确数",
    capped.includes("共 2+ 项"),
    "来源集合被视图截断了，汇总仍按准确总数呈现 —— 人处置完这几项会以为清空了，实际还有没加载出来的");
  check("说清楚哪一类没数全",
    capped.includes("2+") && /只多不少/.test(capped),
    "只改了总数却没说明是哪一类被截断、也没说明数字的方向");

  // 成员列表里也有你自己那一行，而「停用」会当场吊销该账号的全部会话。落在自己头上就是把自己登出，
  // 只能由另一位组织管理员恢复。原先弹窗只说"该成员"，随后 loadPage 撞 401 弹"会话已过期"，
  // 紧接着又弹"已停用成员" —— 两条自相矛盾的话，而人始终不知道自己停用了自己。
  // 按语法结构切出 member-status 那一支（先剥 // 注释：这一支的注释里就写着旧文案）。
  {
    const source = probe.handlerSource("click");
    const at = source.indexOf('action === "member-status"');
    let branch = "";
    if (at >= 0) {
      let index = source.indexOf("{", at);
      const start = index;
      let depth = 0;
      do {
        if (source[index] === "{") depth += 1;
        else if (source[index] === "}") depth -= 1;
        index += 1;
      } while (index < source.length && depth > 0);
      branch = source.slice(start, index).replace(/\/\/[^\n]*$/gmu, "");
    }
    if (!branch.trim()) {
      failures.push("自停用提示: 切不出 member-status 这一支 —— 提取与代码脱节，本条在空转");
    } else {
      check("停用成员时要认出「这一行就是你自己」",
        /currentAccount\?\.accountId/u.test(branch) && /isSelf/u.test(branch),
        "自己那一行和别人那一行走同一段话 —— 人不知道自己正在把自己登出");
      check("停用自己时要说清只能由别人恢复",
        /另一位组织管理员/u.test(branch),
        "没说清恢复要靠谁 —— 人被登出之后不知道该找谁");
      check("停用自己之后不要再去 loadPage 撞 401",
        /clearSession\(\)/u.test(branch),
        "会话已经没了还去加载，弹的是「会话已过期」，把真正发生的事盖掉了");
    }
  }

  // 改密码这一刻：服务端会撤销该账号【全部】会话，含当前这一条。而界面原先说
  // "密码修改成功，下次登录可使用新密码" —— 人以为可以接着用，下一次点击才 401，
  // 弹出的还是"会话已过期"：一个刚成功的操作紧接着一句像故障的话，看起来就是个 bug。
  // 判据按语法结构切出 change-password 那一支，不取字符窗口（窗口会把邻居算进来）。
  {
    const source = probe.handlerSource("submit");
    const at = source.indexOf('kind === "change-password"');
    let branch = "";
    if (at >= 0) {
      let index = source.indexOf("{", at);
      const start = index;
      let depth = 0;
      do {
        if (source[index] === "{") depth += 1;
        else if (source[index] === "}") depth -= 1;
        index += 1;
      } while (index < source.length && depth > 0);
      // 注释要剥掉再判：这一支的注释里就写着"原先说……"，含着旧文案本身。
      // 第一版没剥，当场被自己解释历史的那句话判成"文案没改"（门读到被测代码的注释，
      // 与门读到自己写的字是同一形状）。剥掉之后正反两向都只看真正会跑的代码。
      // 只剥"// 到行尾"，不要整行删 —— 整行删会把带尾注释的真代码一起删掉，造出假红。
      branch = source.slice(start, index).replace(/\/\/[^\n]*$/gmu, "");
    }
    if (!branch.trim()) {
      failures.push("改密提示: 切不出 change-password 这一支 —— 提取与代码脱节，本条在空转");
    } else {
      check("改完密码要当场把本地会话也清掉（服务端已经把它撤销了）",
        /clearSession\(\)/u.test(branch),
        "改密之后仍留在一条已经死掉的会话里 —— 下一次点击才 401，而那句提示写的是「会话已过期」");
      check("改密的成功提示不许暗示当前会话还能接着用",
        !/下次登录可使用新密码/u.test(branch),
        "提示仍是「下次登录可使用新密码」—— 而这一台此刻已经被登出了");
      check("改密的成功提示要说清所有会话（含这一台）都失效了",
        /都已失效|包括当前这一台/u.test(branch),
        "没有说清为什么突然要重新登录 —— 人会以为是故障");
    }
  }

  // 台账那句脚注原先是无条件的："这里只保留最近 N 条；更早的记录在归档文件里"，N 取当前条数。
  // 于是全新部署只有 2 条时它宣称有更早的记录被挤到归档里 —— 凭空造出一次截断，
  // 还把人支去看一个空归档。真实全新部署上读到的就是这句。两支都要验：
  // 没挤掉时不许暗示有东西被挤掉，挤掉了要报【上限】而不是当前条数。
  {
    const overview = {storage: {}, server: {}, resources: {}, energy: {}, runtime: {}};
    const withAudit = (count) => ({
      schemaVersion: "runtime-state/v1", stateVersion: 1,
      runtime: {auditLogCap: 80}, projects: [], taskGroups: [], accounts: [], organizations: [],
      auditLog: Array.from({length: count}, (unused, index) => ({at: "2026-08-13T00:00:00.000Z",
        actor: "auth-service", action: "login", subject: `Account:a${index}`, result: "succeeded"}))
    });
    const few = probe.renderSysOverviewWith(withAudit(2), admin, overview);
    check("台账没被挤掉时不许暗示有更早的记录不在这一屏",
      /台账共 2 条，都在这一屏内/.test(few) && !/不在这一屏内/.test(few),
      `实得：${(few.match(/台账[^<]{0,60}|这一屏只保留[^<]{0,60}/u) || ["（没有这句脚注）"])[0]}`);
    const many = probe.renderSysOverviewWith(withAudit(80), admin, overview);
    check("台账被挤掉时要报【上限】而不是当前条数",
      /这一屏只保留最近 80 条/.test(many) && /不在这一屏内/.test(many),
      `实得：${(many.match(/台账[^<]{0,60}|这一屏只保留[^<]{0,60}/u) || ["（没有这句脚注）"])[0]}`);
    // 上限必须来自服务端下发的真相源：界面自己写死一个数，服务端一改这句话就开始说谎。
    const noCap = probe.renderSysOverviewWith({...withAudit(80), runtime: {}}, admin, overview);
    check("服务端没给上限时，界面不许自己编一个",
      !/只保留最近 80 条/.test(noCap),
      "界面在没拿到 auditLogCap 的情况下报出了 80 —— 那个数是写死的");
    // 上限不明也不许落到有利的那句：此时恰恰判断不了有没有被挤掉（真实渲染里 80 条正好卡在上限，却写着「都在这一屏内」）。
    check("服务端没给上限时，界面也不许说「都在这一屏内」，要说判断不了",
      !/都在这一屏内/.test(noCap) && /没给出保留上限/.test(noCap),
      `实得：${(noCap.match(/台账[^<]{0,80}/u) || ["（没有这句脚注）"])[0]}`);
  }

  // 全新组织的第一屏：一个项目都没有，而「智能体加入令牌」和「项目成员授权」两张表单
  // 照样完整渲染，「项目」下拉 0 个选项 —— 人填完点下去必然失败。实测真实开通流程就是这样。
  // 两支都要验：没项目时不许摆出这两张表单，有项目时它们必须还在（否则是把杠杆藏了）。
  {
    const orgAdmin = {accountId: "oa1", email: "oa@b.c", accountType: "org_admin",
      displayName: "组织管理员甲", organizationId: "org_probe"};
    const orgState = (projects) => ({schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
      organizations: [{orgId: "org_probe", name: "探针组织", status: "active",
        quotas: {maxMembers: 50, maxProjects: 20, maxTaskGroups: 200, maxAgents: 100},
        usage: {members: 1, projects: projects.length, taskGroups: 0, agents: 0}}],
      projects, taskGroups: [], accounts: [], agentRuntimeNodes: [], agentJoinTokens: [],
      accessGrants: [], auditLog: [], truncatedCollections: []});
    const renderOrg = (projects, pageId, selectedProjectId = "") => {
      const root = el("div");
      loadConsole(root, {realI18n: true}).renderFullPageWith(orgState(projects), orgAdmin, selectedProjectId, pageId);
      return String(root.innerHTML || "");
    };
    const emptyAgents = renderOrg([], "org-agents");
    check("全新组织没有项目时，不摆出一张点了必然失败的加入令牌表单",
      !/data-form="join-token"/u.test(emptyAgents) && /还没有任何项目/u.test(emptyAgents),
      `实得：${(emptyAgents.replace(/<[^>]+>/gu, " ").match(/还没有任何项目[^<]{0,40}/u) || ["（照旧摆出了表单）"])[0]}`);
    const emptyGrant = renderOrg([], "org-projects");
    check("全新组织没有项目时，不摆出一张点了必然失败的成员授权表单",
      !/data-form="project-member"/u.test(emptyGrant) && /还没有任何项目/u.test(emptyGrant),
      `实得：${(emptyGrant.replace(/<[^>]+>/gu, " ").match(/还没有任何项目[^<]{0,40}/u) || ["（照旧摆出了表单）"])[0]}`);
    // 提示必须说清第一步在哪一页，否则人还是不知道往哪走。
    check("这条提示要指出该去哪一页创建项目",
      /项目列表/u.test(emptyGrant) && /组织管理/u.test(emptyGrant),
      "提示没有点名创建项目的入口页");
    const withProjects = [{id: "p1", name: "探针项目", organizationId: "org_probe", status: "active"}];
    const orgAgentsWithProject = renderOrg(withProjects, "org-agents", "p1");
    const projectAgentsWithProject = renderOrg(withProjects, "proj-agents", "p1");
    check("有项目时组织页只做令牌审计，项目页保留智能体注册表单",
      !/data-form="join-token"/u.test(orgAgentsWithProject)
        && /加入令牌审计/u.test(orgAgentsWithProject)
        && /data-menu="proj-agents"/u.test(orgAgentsWithProject)
        && /data-form="join-token"/u.test(projectAgentsWithProject)
        && /签发一次性加入令牌/u.test(projectAgentsWithProject)
        && /data-form="project-member"/u.test(renderOrg(withProjects, "org-projects", "p1")),
      "Agent 签发边界不清：组织页不该承载注册表单，项目页必须保留注册表单和脚本来源");
  }

  // 红点只能统计"这个人有权处置"的项。把别人负责的也算进来，那个数字就永远清不掉 ——
  // 人每次打开都看到"还有 N 项等你处理"，点进去无事可做，最后学会无视它。
  // 决定"哪些项算数"的 taskGroups 自己也会被截断：超出上限的任务组下的待办连桶都进不去。
  // 只看桶自身的集合有没有被截，会漏掉这一整类丢失，而界面照样报一个精确数字。
  // 量不到的体积不能显示成 0：人据此判断容量，"0 字节"看起来完全正常，实际是错的。
  {
    const baseState = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {}, projects: [],
      taskGroups: [], accounts: [], organizations: [], auditLog: []};
    const unknown = probe.renderSysOverviewWith(baseState, admin,
      {storage: {centralStateBytes: null, projectDbBytes: null, stateStore: "runtime_json", partial: true},
       server: {}, resources: {}, energy: {}, runtime: {}});
    // 判据只看【中央状态库那一行】：整页还有内存占用等别的字节字段，
    // 拿整页去找 "0 B" 会被它们带偏（第一版就是这样，断言恒不成立）。
    // 窗口要在本行结束处收住：取固定字数会把【下一行】也框进来，
    // 而下一行还留着同样的提示 —— 那样把本行改坏它也照样绿（第一版就是这样）。
    const storageLine = (html) => {
      const start = html.indexOf("中央状态库");
      if (start < 0) return "";
      const end = html.indexOf("</dd>", start);
      return html.slice(start, end < 0 ? start + 200 : end);
    };
    check("存储体积量不到时不得显示成 0",
      /量不到/.test(storageLine(unknown)),
      `statSync 失败时体积回落成 0，界面照样把它渲染成 0 B —— 人据此判断容量，而那是个假数字（那一行：${storageLine(unknown).slice(0, 120)}）`);
    const known = probe.renderSysOverviewWith(baseState, admin,
      {storage: {centralStateBytes: 2048, projectDbBytes: 4096, stateStore: "runtime_json"},
       server: {}, resources: {}, energy: {}, runtime: {}});
    check("量得到时照常显示数字",
      !/量不到（不是 0）/.test(known),
      "体积明明量到了，界面却说量不到 —— 那条提示会变成常亮的噪音");
  }

  // 重置运行态是全系统最不可逆的一步。它的确认框要人照着规模数字原样打一遍 ——
  // 而那几个数字此前是从【截断过的视图数组】算的，organizations 在系统页那个视角里
  // 根本不下发，于是框里会写"0 个组织、0 个项目"：人以为没什么可毁的，然后抹掉一切。
  {
    const real = probe.bootstrapScaleFrom({runtime: {organizations: 3, projects: 12, taskGroups: 240}});
    check("重置确认用服务端给的真实总数",
      real && real.organizations === 3 && real.projects === 12 && real.taskGroups === 240,
      `拿到的规模不是服务端的真实总数：${JSON.stringify(real)}`);
    check("拿不到规模时必须返回空（由调用方拒绝执行）",
      probe.bootstrapScaleFrom(null) === null
        && probe.bootstrapScaleFrom({}) === null
        && probe.bootstrapScaleFrom({runtime: {organizations: 3, projects: 12}}) === null,
      "系统概览没加载出来时仍算出一个数字 —— 那个数字必然是偏小的，而人会照着它同意抹掉一切");
    const handler = probe.handlerSource("click");
    check("拿不到规模时不执行重置",
      /bootstrapScaleFrom\(systemOverview\)/.test(handler) && /if \(!scale\)/.test(handler),
      "重置流程没有在拿不到真实规模时中止");
  }

  // 控制台每 5 秒轮询一次。数据没变时（服务端已按 ETag 回 304）整页 DOM 还要拆了重建，
  // 4000 单元时是 292KB 反复解析 + 重排，而且每次都清掉用户的文字选区。
  // 这里验两件事，缺任何一件这个优化都是错的：没变时不重建，变了必须重建。
  {
    const root = el("div");
    let writes = 0;
    let value = "";
    Object.defineProperty(root, "innerHTML", {get: () => value, set: (next) => { value = next; writes += 1; }});
    const probe = loadConsole(root);
    writes = 0; // app.js 加载时自己会渲染一次登录页，不算在这一段里
    const account = {accountId: "u1", email: "a@b.c", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"};
    const makeState = (groupName) => ({schemaVersion: "runtime-state/v1", stateVersion: 3, runtime: {},
      organizations: [{orgId: "org_default", name: "组织", status: "active"}],
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [{id: "tg1", projectId: "p1", name: groupName, status: "development", health: "ok", workItems: [], blockers: []}],
      agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [], findings: [],
      humanConfirmationRequests: [], truncatedCollections: [], users: [account]});
    probe.setAuth("probe-token", account);
    probe.renderFullPageWith(makeState("任务组"), account, "p1", "tg");
    const afterFirst = writes;
    check("整页渲染确实写了 DOM（否则下面的判据全是空转）", afterFirst === 1, `写入次数 ${afterFirst}`);
    probe.renderFullPageWith(makeState("任务组"), account, "p1", "tg");
    check("数据没变时不重建整页 DOM",
      writes === afterFirst,
      `同一份数据渲染两次写了 ${writes} 次 DOM —— 每 5 秒清一次用户选区，还要白解析几百 KB`);
    probe.renderFullPageWith(makeState("改过名的任务组"), account, "p1", "tg");
    check("数据变了必须重建（跳过不能把真实变化一起挡住）",
      writes === afterFirst + 1 && /改过名的任务组/.test(value),
      `写入次数 ${writes}，界面上${/改过名的任务组/.test(value) ? "有" : "没有"}新名字`);
    // 【建工作项表单旁要说「没有在线 agent 时建了也派不出去」】。顶部那条「已交给执行方的单元没人领」
    // 只在已经有单元等着时出现，第一次建工作项的人看不到；有在线节点时不许喊。
    probe.renderFullPageWith({...makeState("任务组"), fleet: {online: 0, total: 2}}, account, "p1", "tg");
    const noAgentForm = /data-form="work-item-create"[\s\S]*?<\/form>/u.exec(value)?.[0] || "";
    check("没有在线 agent 时，建工作项表单里要说建好后不会被领走、已注册几个",
      /不会被领走/u.test(noAgentForm) && /已注册 2 个/u.test(noAgentForm),
      `建工作项表单里没说（${noAgentForm.length ? noAgentForm.slice(-300) : "没找到 work-item-create 表单"}）`);
    probe.renderFullPageWith({...makeState("任务组"), fleet: {online: 1, total: 2}}, account, "p1", "tg");
    const withAgentForm = /data-form="work-item-create"[\s\S]*?<\/form>/u.exec(value)?.[0] || "";
    check("有在线 agent 时建工作项表单不许喊「不会被领走」",
      withAgentForm.length > 0 && !/不会被领走/u.test(withAgentForm),
      "有节点在线仍在表单里喊没人领 —— 人会去白查节点");
    // 登录页绕过 render 自己写 DOM。缓存不作废的话，退出再登录会算出和上次一模一样的整页 HTML
    // 而被跳过，人就卡在登录页上 —— 这是本次改动最容易造出来的新故障。
    probe.renderLoginWith(null);
    const afterLogin = writes;
    probe.renderFullPageWith(makeState("改过名的任务组"), account, "p1", "tg");
    check("从登录页回到控制台一定要重建（哪怕内容和上次登录前一样）",
      writes === afterLogin + 1,
      "退出再登录后界面没有被重建 —— 人会一直停在登录页上");
  }

  // 零在线 agent 时，循环照样会造出成千上万个 active 会话与租约：控制台一片"执行中"，
  // 而真相是没有任何东西在跑。系统自己有节点计数，此前从不说。
  {
    const base = {
      schemaVersion: "runtime-state/v1", stateVersion: 1,
      runtime: {autonomousOrchestrator: {enabled: true, intervalMs: 60000, consecutiveErrors: 0, lastTickResult: "ran", lastTickAt: "2026-08-12T00:00:00Z"}},
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "development", workItems: []}],
      agentDispatches: [{dispatchId: "adp1", taskGroupId: "tg1", workItemId: "w1", status: "blocked", blockedReason: "awaiting_human_confirmation"}],
      workSessions: [], workerLanes: [], agentRuntimeNodes: [], qualityGates: [],
      testResults: [], checkpoints: [], admissionDecisions: [], modelSelectionDecisions: [],
      sessionPlacementDecisions: [], closeBarriers: [], truncatedCollections: [],
      fleet: {online: 0, total: 2}
    };
    // 没上报过进度的派发不能显示成 "0%"：那是把"没有"说成了一个看起来精确的数，
    // 而对一个【已完成】的派发，人看到 0% 会以为它什么都没干成（真实状态里读出来的就是这样）。
    const noProgress = structuredClone(base);
    noProgress.agentDispatches = [{dispatchId: "adp_x", workItemId: "w1", taskGroupId: "tg1",
      projectId: "p1", status: "completed"}];
    const noProgressView = probe.renderMonitorWith(noProgress, admin, "p1");
    check("没上报过进度就写「—」，不能显示成 0%",
      /—/.test(noProgressView) && !/>0%</.test(noProgressView),
      "已完成的派发显示「0%」—— 它根本没上报过进度，人会以为它什么都没干成");
    const offlineView = probe.renderMonitorWith(structuredClone(base), admin, "p1");
    check("有活在排队却没有在线 agent 时要在监控页上说出来",
      /没有任何在线的 agent 节点/.test(offlineView),
      "一个能干活的节点都没有，界面却只显示'执行中' —— 人会一直等一件永远不会发生的事");
    check("提示要说清已注册几个、以及该去哪儿看",
      /已注册 2 个/.test(offlineView)
        && /AI 智能体/.test(offlineView)
        && /刷新自检/.test(offlineView)
        && /恢复目标 agent 主机\/进程心跳/.test(offlineView)
        && !/项目设置」→「智能体接入/.test(offlineView)
        && !/接入或恢复节点/.test(offlineView)
        && /「项目管理」|「组织管理」|联系项目管理员|联系组织管理员/u.test(offlineView),
      "只说没有在线节点，不说是一台都没装还是装了都挂了，人不知道下一步做什么");

    const noRegistered = structuredClone(base);
    noRegistered.fleet = {online: 0, total: 0};
    const noRegisteredView = probe.renderMonitorWith(noRegistered, admin, "p1");
    check("一个 agent 都没注册时，监控页出口要直接指向项目注册脚本",
      /注册 agent/.test(noRegisteredView)
        && /加入令牌/.test(noRegisteredView)
        && !/接入或恢复节点/.test(noRegisteredView),
      "没有注册节点时还说恢复节点，项目负责人不知道安装脚本从哪里来");

    const withNode = structuredClone(base);
    withNode.fleet = {online: 1, total: 2};
    check("有在线节点时不挂这条提示",
      !/没有任何在线的 agent 节点/.test(probe.renderMonitorWith(withNode, admin, "p1")),
      "有节点在线还提示没有 —— 常亮的告警等于没有告警");

    const noWork = structuredClone(base);
    noWork.agentDispatches = [];
    check("没有活在等时不挂这条提示",
      !/没有任何在线的 agent 节点/.test(probe.renderMonitorWith(noWork, admin, "p1")),
      "没有任何活在等却提示节点掉线 —— 项目还没开工就先吓人一跳");

    const otherProject = structuredClone(base);
    otherProject.agentDispatches = [{dispatchId: "adp9", taskGroupId: "tg_other", workItemId: "w9", status: "queued"}];
    check("只统计当前项目范围内的活",
      !/没有任何在线的 agent 节点/.test(probe.renderMonitorWith(otherProject, admin, "p1")),
      "拿别的项目的派发在这个项目上报警 —— 这一页整体以当前项目为抬头");
  }

  // 普通中文管理者打开高密度页面时，应该先看到状态总览，再看到表单和长表。
  // 否则首屏就是一组操作杆，人还没判断当前规模、风险和下一步，就被推去填表。
  {
    const overviewState = {
      schemaVersion: "runtime-state/v1", stateVersion: 1,
      runtime: {status: "running", accountRoles: ["viewer"], knownPermissions: ["project:view"], grantRoleTemplates: {project: ["viewer"]}, mcp: {toolCount: 85}},
      organizations: [{orgId: "org_default", name: "默认组织", status: "active", quotas: {maxProjects: 5}, usage: {projects: 1}}],
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "development", progress: 40,
        languagePolicy: {languageTag: "zh-CN"}, workItemCount: 2,
        workItems: [{id: "w1", title: "工作项", status: "assigned"}]}],
      accounts: [
        {accountId: "acct_a", displayName: "甲", email: "a@example.com", accountType: "system_admin", status: "active", roles: ["system-owner"]},
        {accountId: "acct_svc", displayName: "服务", email: "svc@example.com", accountType: "service_account", status: "active", roles: ["runtime-service"]}
      ],
      accessGrants: [{grantId: "g1", subjectRef: {subjectId: "acct_a"}, resource: {type: "system", id: "system"}, role: "system-owner", status: "active", permissions: ["system:*"]}],
      agents: [{id: "agent_1", name: "档案", role: "reviewer", model: "auto_best", status: "active"}],
      agentJoinTokens: [{joinTokenId: "join_1", projectId: "p1", status: "issued", expiresAt: "2099-01-01T00:00:00Z"}],
      skillSources: [{sourceId: "src_1", status: "active", repositoryUrl: "https://example.test/skills.git"}],
      roleSkillIndex: [{roleSkillId: "reviewer", name: "评审员", category: "review", sourceId: "src_1"}],
      roleSkillCountBySource: {src_1: 3},
      modelCapabilities: [{modelId: "gpt-5.5", providerClass: "openai", availability: "available", strengths: ["implementation"]}],
      roleSkillOverlays: [{overlayId: "ov_1", status: "active", roleSkillRef: "reviewer", projectId: "p1",
        patch: {allowedCapabilityAdds: ["repo_read"], forbiddenCapabilityAdds: ["schema_change"]}, createdAt: "2026-08-12T00:00:00Z"}],
      repositoryOutputs: [
        {targetId: "rot1", projectId: "p1", taskGroupId: "tg1", workItemId: "w1", repositoryId: "repo_api", branch: "main", status: "lease_bound", pathAllowlist: ["apps/**", "docs/**"]},
        {targetId: "rot2", projectId: "p1", taskGroupId: "tg1", workItemId: "w1", repositoryId: "repo_api", branch: "main", status: "superseded", supersededReason: "rework_started", pathAllowlist: ["apps/**", "docs/**"]},
        {targetId: "rot3", projectId: "p1", taskGroupId: "tg1", workItemId: "w1", repositoryId: "repo_docs", branch: "release", status: "pushed", pathAllowlist: ["docs/**"]}
      ],
      agentDispatches: [{dispatchId: "adp1", taskGroupId: "tg1", workItemId: "w1", status: "queued"}],
      humanConfirmationRequests: [{requestId: "hcr1", taskGroupId: "tg1", workItemId: "w1", status: "pending",
        decisionClass: "major", blocking: true, createdAt: "2026-08-12T00:00:00Z", question: {summary: "是否定稿方案"}, options: []}],
      permissionRequests: [{requestId: "perm1", taskGroupId: "tg1", subjectId: "acct_a", permission: "task_group:review",
        status: "pending_approval", createdAt: "2026-08-12T00:00:00Z"}],
      approvalRequests: [{approvalId: "apr1", taskGroupId: "tg1", status: "requested", summary: "审批", createdAt: "2026-08-12T00:00:00Z"}],
      findings: [{findingId: "find1", taskGroupId: "tg1", status: "open", summary: "发现", createdAt: "2026-08-12T00:00:00Z"}],
      workSessions: [{sessionId: "sess1", taskGroupId: "tg1", roleId: "reviewer", workItemId: "w1", placement: "new_session", status: "active"}],
      workerLanes: [{laneId: "lane1", taskGroupId: "tg1", roleId: "reviewer", laneFunction: "implementation", status: "busy", reuseGeneration: 1}],
      agentRuntimeNodes: [{nodeId: "node1", nodeName: "节点", status: "online", admission: "full", lastHeartbeatAt: "2099-01-01T00:00:00Z"}],
      closeBarriers: [{taskGroupId: "tg1", satisfied: false, blockingObjects: [{objectType: "WorkItem", gate: "all_work_items_terminal"}], computedAt: "2026-08-12T00:00:00Z"}],
      qualityGates: [], testResults: [], checkpoints: [], admissionDecisions: [], modelSelectionDecisions: [],
      sessionPlacementDecisions: [], agentControlCommands: [], executionTopologies: [], reviewPlans: [],
      reviewBundles: [], ruleSourceResolutions: [], sharedDefinitions: [], systemUpgradeCandidates: [],
      dlqEntries: [], truncatedCollections: []
    };
    const orgAdmin = {accountId: "acct_a", accountType: "org_admin", displayName: "组织管理员", email: "a@example.com", organizationId: "org_default",
      roles: ["org_admin"], permissions: ["project:create", "project:grant", "member:invite", "agent:activate", "task_group:control", "task_group:review"]};
    const systemAdmin = {accountId: "acct_sys", accountType: "system_admin", displayName: "系统管理员", email: "sys@example.com", organizationId: "org_default",
      roles: ["system-owner"], permissions: ["system:*"]};
    const panelAt = (html, title) => html.indexOf(`<h2>${title}</h2>`);
    const panelSlice = (html, title, nextTitle) => {
      const start = panelAt(html, title);
      if (start < 0) return "";
      const end = nextTitle ? panelAt(html, nextTitle) : -1;
      return end > start ? html.slice(start, end) : html.slice(start);
    };
    const sysOrgsHtml = probe.renderSysOrgsWith(overviewState, admin, overviewState.organizations).replace(/<!--[\s\S]*?-->/gu, "");
    check("系统组织页先显示总览、操作看板和治理流程，再显示列表、创建表单和说明",
      panelAt(sysOrgsHtml, "组织管理总览") >= 0
        && panelAt(sysOrgsHtml, "组织管理总览") < panelAt(sysOrgsHtml, "组织与配额操作看板")
        && panelAt(sysOrgsHtml, "组织与配额操作看板") < panelAt(sysOrgsHtml, "组织开通治理流程")
        && panelAt(sysOrgsHtml, "组织开通治理流程") < panelAt(sysOrgsHtml, "组织列表")
        && panelAt(sysOrgsHtml, "组织列表") < panelAt(sysOrgsHtml, "创建组织")
        && panelAt(sysOrgsHtml, "创建组织") < panelAt(sysOrgsHtml, "说明"),
      "系统组织页仍然缺少总览后的操作入口，系统管理员要先读长表和表单才知道从哪里处理");
    check("系统组织操作看板要提供组织列表、创建组织和说明的跳转入口",
      /data-jump-panel="组织列表"/u.test(sysOrgsHtml)
        && /data-jump-panel="创建组织"/u.test(sysOrgsHtml)
        && /data-jump-panel="说明"/u.test(sysOrgsHtml),
      "组织与配额操作看板只显示指标，没有接上组织列表、创建组织和说明面板的跳转");
    check("系统组织页要把组织开通、配额、管理员交接、项目建设和启停治理串成流程",
      /组织开通治理流程/u.test(sysOrgsHtml)
        && /一次性令牌只在创建成功弹窗显示/u.test(sysOrgsHtml)
        && /成员、项目、任务组和智能体配额在组织列表里调整/u.test(sysOrgsHtml)
        && /日常子账户、项目和 Agent 管理由组织管理员承接/u.test(sysOrgsHtml)
        && /项目配置、Agent 注册、任务组执行和监控都在项目管理空间完成/u.test(sysOrgsHtml)
        && /停用组织会影响成员、项目、任务组和 Agent 准入/u.test(sysOrgsHtml)
        && /组织创建不是执行终点/u.test(sysOrgsHtml)
        && /data-menu="proj-overview"/u.test(sysOrgsHtml),
      "系统组织页没有把租户开通后的交接和治理顺序讲成流程");
    const accountHtml = probe.renderSysAccountsWith(overviewState, admin, "p1").replace(/<!--[\s\S]*?-->/gu, "");
    check("账号与授权页先显示总览，再显示邀请表单",
      panelAt(accountHtml, "账号与授权总览") >= 0
        && panelAt(accountHtml, "账号与授权总览") < panelAt(accountHtml, "邀请账号"),
      "账号与授权页首屏直接进入表单，普通管理员看不到账号、授权、项目和令牌规模");
    check("账号与授权页先显示操作看板和现状列表，再显示新增表单",
      panelAt(accountHtml, "账号与授权操作看板") >= 0
        && panelAt(accountHtml, "账号与授权总览") < panelAt(accountHtml, "账号与授权操作看板")
        && panelAt(accountHtml, "账号与授权操作看板") < panelAt(accountHtml, "账号与授权职责边界")
        && panelAt(accountHtml, "账号与授权职责边界") < panelAt(accountHtml, "账号授权处置流程")
        && panelAt(accountHtml, "账号授权处置流程") < panelAt(accountHtml, "账号列表")
        && panelAt(accountHtml, "账号列表") < panelAt(accountHtml, "访问授权列表")
        && panelAt(accountHtml, "访问授权列表") < panelAt(accountHtml, "邀请账号")
        && panelAt(accountHtml, "邀请账号") < panelAt(accountHtml, "新增访问授权")
        && panelAt(accountHtml, "新增访问授权") < panelAt(accountHtml, "创建项目（系统级）")
        && /data-jump-panel="账号列表"/u.test(accountHtml)
        && /data-jump-panel="访问授权列表"/u.test(accountHtml),
      "账号与授权页仍然是先给邀请/授权表单，系统管理员没先核对现有账号与授权就被推去操作");
    check("系统账号页不得再内嵌项目成员授权表单",
      panelAt(accountHtml, "项目成员授权") < 0
        && !/data-form="project-member"/u.test(accountHtml)
        && !/data-jump-panel="项目成员授权"/u.test(accountHtml),
      "系统账号页仍把项目成员授权表单混在系统管理里，和项目成员权限页形成双入口");
    check("账号与授权页必须把项目 Agent 注册入口和系统令牌审计分开",
      /账号与授权职责边界/u.test(accountHtml)
        && /项目 Agent 注册/u.test(accountHtml)
        && /项目管理.+AI 智能体.+注册 agent/u.test(accountHtml)
        && /智能体入网审计/u.test(accountHtml)
        && /系统页只做跨项目令牌审计和撤销/u.test(accountHtml)
        && /data-menu="proj-agents"/u.test(accountHtml),
      "账号与授权页仍像普通 Agent 注册入口，没有明确提示常规注册应进入目标项目的项目级 AI 智能体注册面板");
    check("账号与授权页要把账号、授权、服务账号、令牌审计、Agent 档案和项目落位串成流程",
      /账号授权处置流程/u.test(accountHtml)
        && /项目、任务组和系统资源授权先审计/u.test(accountHtml)
        && /服务账号只用于系统和 agent runtime 服务身份/u.test(accountHtml)
        && /项目 join token 到项目 AI 智能体页签发/u.test(accountHtml)
        && /不等于某台执行节点已注册/u.test(accountHtml)
        && /真正让用户或 agent 参与某个项目/u.test(accountHtml)
        && /data-jump-panel="智能体入网审计"/u.test(accountHtml)
        && /data-jump-panel="编排智能体档案"/u.test(accountHtml)
        && /[^<：]+：进入「成员权限」完成成员角色/u.test(accountHtml)
        && /data-menu="proj-members"/u.test(accountHtml)
        && /data-menu="proj-agents"/u.test(accountHtml),
      "账号与授权页没有把系统身份治理和项目级落位讲成可操作流程");
    const accountNoSelectedProjectHtml = probe.renderSysAccountsWith(overviewState, admin, "").replace(/<!--[\s\S]*?-->/gu, "");
    check("系统账号页有可见项目但未选中时要去项目管理选项目，而不是跳创建项目",
      /进入「项目管理」后选择目标项目，再回「成员权限」处理/u.test(accountNoSelectedProjectHtml)
        && /先进入项目管理选择目标项目，再到项目「成员权限」处理/u.test(accountNoSelectedProjectHtml)
        && /data-menu="proj-overview"/u.test(accountNoSelectedProjectHtml),
      "系统账号页在有项目但未选中时仍把用户带到创建项目或给出旧的先选项目按钮");
    const accountArchivedProjectHtml = probe.renderSysAccountsWith({...overviewState,
      projects: [{id: "p_old", name: "已归档项目", organizationId: "org_default", status: "archived", members: []}]
    }, admin, "p_old").replace(/<!--[\s\S]*?-->/gu, "");
    check("系统账号页当前项目已归档时不得显示绿色项目成员授权直达",
      /现有项目已归档/u.test(accountArchivedProjectHtml)
        && /data-jump-panel="创建项目（系统级）"/u.test(accountArchivedProjectHtml)
        && !/去项目授权/u.test(accountArchivedProjectHtml),
      "当前项目已归档时系统账号页仍给出可授权的直达入口");
    const accountArchivedWithFallbackHtml = probe.renderSysAccountsWith({...overviewState,
      projects: [
        {id: "p_old", name: "已归档项目", organizationId: "org_default", status: "archived", members: []},
        {id: "p2", name: "可用项目", organizationId: "org_default", status: "active", members: []}
      ]
    }, admin, "p_old").replace(/<!--[\s\S]*?-->/gu, "");
    check("系统账号页当前项目已归档但还有可用项目时，要说清改去选其他项目",
      /当前项目已归档/u.test(accountArchivedWithFallbackHtml)
        && /选择其他可用项目/u.test(accountArchivedWithFallbackHtml)
        && /data-menu="proj-overview"/u.test(accountArchivedWithFallbackHtml)
        && !/去项目授权/u.test(accountArchivedWithFallbackHtml),
      "当前项目已归档但还有可用项目时，系统账号页没有解释为何不能直达成员权限");
    check("系统账号页不能承载常规 Agent 注册表单，项目页才保留注册脚本入口",
      !/data-form="join-token"/u.test(accountHtml)
        && /智能体入网审计/u.test(accountHtml)
        && /data-menu="proj-agents"/u.test(accountHtml)
        && !/组织页只做组织范围令牌审计/u.test(accountHtml),
      "系统账号页仍渲染了 Agent 加入令牌签发表单，或复用了组织页审计提示");
    const taskGroupHtml = probe.renderTaskGroupsWith(overviewState, admin, "p1", null, {}).replace(/<!--[\s\S]*?-->/gu, "");
    check("任务组页先显示任务组总览，再显示创建表单",
      panelAt(taskGroupHtml, "任务组总览") >= 0
        && panelAt(taskGroupHtml, "任务组总览") < panelAt(taskGroupHtml, "创建任务组"),
      "任务组页首屏直接进入创建表单，管理者得向下找才知道已有任务组状态");
    check("任务组页先显示处置看板，再显示创建表单",
      panelAt(taskGroupHtml, "任务组处置看板") >= 0
        && panelAt(taskGroupHtml, "任务组总览") < panelAt(taskGroupHtml, "任务组处置看板")
        && panelAt(taskGroupHtml, "任务组处置看板") < panelAt(taskGroupHtml, "创建任务组")
        && /data-action="tg-detail"/u.test(taskGroupHtml),
      "任务组页没有把需要先处理的任务组排成可点击看板，用户仍要逐个读大面板");
    check("任务组页要在创建表单前给出 AI-native 生命周期路径",
      panelAt(taskGroupHtml, "任务组生命周期") >= 0
        && panelAt(taskGroupHtml, "任务组处置看板") < panelAt(taskGroupHtml, "任务组生命周期")
        && panelAt(taskGroupHtml, "任务组生命周期") < panelAt(taskGroupHtml, "创建任务组")
        && /设定目标、统一语言和初始角色/u.test(taskGroupHtml)
        && /工作项绑定执行角色、要求和可选指定模型/u.test(taskGroupHtml)
        && /注册入口在「项目管理」→「AI 智能体」/u.test(taskGroupHtml)
        && /控制 ACK 在执行监控页实时回送/u.test(taskGroupHtml)
        && /核心决策、授权、审批和发现项进入人工审核/u.test(taskGroupHtml)
        && /关闭门清零后才能关闭任务组/u.test(taskGroupHtml)
        && /任务组仍是 AI-native 执行单元/u.test(taskGroupHtml)
        && /data-menu="proj-agents"/u.test(taskGroupHtml)
        && /data-menu="monitor"/u.test(taskGroupHtml)
        && /data-menu="review"/u.test(taskGroupHtml),
      "任务组页仍缺少从创建、拆分、Agent 注册、实时监控、人工审核到关闭门的图形化主线");
    const detailTaskGroup = {...overviewState.taskGroups[0], languagePolicy: {languageTag: "zh-CN"}};
    const detailState = {...overviewState, taskGroups: [detailTaskGroup]};
    const taskGroupDetailHtml = probe.renderTaskGroupsWith(detailState, admin, "p1", detailTaskGroup.id, {
      taskGroupId: detailTaskGroup.id,
      progress: {
        taskAnalysis: {items: [{kind: "task", title: "拆解", status: "running", progress: 40}]},
        roles: [{roleId: "agent-runtime", status: "active", addedBy: "auto"}],
        workItems: [{id: "wi1", title: "实现单元", status: "assigned", ownerRole: "agent-runtime", progress: 20}],
        workItemCount: 1,
        blockers: [{severity: "attention", summary: "等待自检"}]
      },
      config: {configSource: "customized", systemRules: [], businessRules: [], defaultRoles: [], repositories: [], baselineData: []},
      roomMessages: [{sequence: 1, senderRef: "agent_node:node1", createdAt: "2026-08-12T00:00:00Z", payload: {text: "执行中"}}]
    }).replace(/<!--[\s\S]*?-->/gu, "");
    check("任务组展开详情要先给阅读路径，再进入长明细",
      taskGroupDetailHtml.indexOf("任务组详情阅读路径") >= 0
        && taskGroupDetailHtml.indexOf("任务组详情阅读路径") < taskGroupDetailHtml.indexOf('data-section-title="事项清单"'),
      "任务组详情仍然一展开就堆事项、角色、配置、工作项，缺少普通用户能先扫读的详情路径");
    check("任务组详情阅读路径要覆盖八个关键小节并能跳转",
      /data-jump-panel="事项清单"/u.test(taskGroupDetailHtml)
        && /data-jump-panel="角色列表"/u.test(taskGroupDetailHtml)
        && /data-jump-panel="配置（继承 \/ 自定义）"/u.test(taskGroupDetailHtml)
        && /data-jump-panel="执行控制"/u.test(taskGroupDetailHtml)
        && /data-jump-panel="工作项"/u.test(taskGroupDetailHtml)
        && /data-jump-panel="准入与阻断分类"/u.test(taskGroupDetailHtml)
        && /data-jump-panel="阻塞"/u.test(taskGroupDetailHtml)
        && /data-jump-panel="协作记录（agent 之间的房间消息）"/u.test(taskGroupDetailHtml),
      "任务组详情阅读路径没有覆盖事项、角色、配置、控制、工作项、准入阻断、阻塞和协作记录");
    check("任务组详情小节要输出稳定锚点，供卡片跳转定位",
      /data-section-title="事项清单"/u.test(taskGroupDetailHtml)
        && /data-section-title="角色列表"/u.test(taskGroupDetailHtml)
        && /data-section-title="执行控制"/u.test(taskGroupDetailHtml)
        && /data-section-title="工作项"/u.test(taskGroupDetailHtml),
      "任务组详情的小节没有稳定锚点，卡片只能跳顶层 panel，不能跳展开详情里的具体位置");
    const projectSettingsHtml = probe.renderProjectSettingsWith(overviewState, admin, "p1", {
      repositories: [{id: "repo", url: "git@example.test/repo.git", defaultBranch: "main"}],
      baselineData: [], defaultRoles: [], systemRules: [], businessRules: []
    }).replace(/<!--[\s\S]*?-->/gu, "");
    check("项目设置页必须提供角色 Skill 定制入口和创建表单",
      /项目设置总览/u.test(projectSettingsHtml)
        && /角色定制/u.test(projectSettingsHtml)
        && /data-jump-panel="角色 Skill 定制"/u.test(projectSettingsHtml)
        && /data-form="role-skill-overlay" data-scope="project"/u.test(projectSettingsHtml)
        && /reviewer/u.test(projectSettingsHtml)
        && /禁掉 schema_change/u.test(projectSettingsHtml),
      "角色 Skill 叠加仍然只能在系统设置只读追踪或 API 里处理，项目管理员没有图形化入口");
    check("任务组详情必须提供本组角色 Skill 定制入口和任务组级提交表单",
      /本任务组角色 Skill 定制/u.test(taskGroupDetailHtml)
        && /项目级继承/u.test(taskGroupDetailHtml)
        && /data-form="role-skill-overlay" data-scope="task_group"/u.test(taskGroupDetailHtml)
        && /下一次派发时由服务端同步到 agent/u.test(taskGroupDetailHtml),
      "任务组特殊角色能力要求仍没有图形化入口，用户只能改规则或离开界面构造 API");
    check("角色 Skill 定制提交处理必须调用既有 overlay 接口并写入 patch",
      /\/api\/role-skill-overlays/u.test(probe.handlerSource("submit"))
        && /allowedCapabilityAdds/u.test(probe.handlerSource("submit"))
        && /forbiddenCapabilityAdds/u.test(probe.handlerSource("submit"))
        && /modelRequirementPatchRef/u.test(probe.handlerSource("submit")),
      "角色 Skill 定制表单没有接到后端已有 overlay 写入路径，界面只是空壳");
    check("详情跳转处理器要支持 data-section-title 小节和动态标题前缀",
      /querySelectorAll\("\[data-section-title\]"\)/u.test(probe.handlerSource("click"))
        && /sectionTitle\.startsWith\(title\)/u.test(probe.handlerSource("click")),
      "点击处理器只会找顶层 panel，任务组详情里的卡片无法跳到动态工作项等小节");
    const monitorHtml = probe.renderMonitorWith(overviewState, admin, "p1").replace(/<!--[\s\S]*?-->/gu, "");
    check("执行监控页先显示监控总览，再显示十三张明细表",
      panelAt(monitorHtml, "执行监控总览") >= 0
        && panelAt(monitorHtml, "执行监控总览") < panelAt(monitorHtml, "实时事件流"),
      "执行监控页没有入口级状态地图，用户只能从长表里猜当前卡点");
    check("执行监控页先显示处置看板和实时回送链路，再显示实时事件流",
      panelAt(monitorHtml, "监控处置看板") >= 0
        && panelAt(monitorHtml, "执行监控总览") < panelAt(monitorHtml, "监控处置看板")
        && panelAt(monitorHtml, "监控处置看板") < panelAt(monitorHtml, "实时回送链路")
        && panelAt(monitorHtml, "实时回送链路") < panelAt(monitorHtml, "实时事件流")
        && /data-jump-panel="(智能体派发|工作会话)"/u.test(monitorHtml)
        && /data-jump-panel="关闭门禁"/u.test(monitorHtml),
      "执行监控页没有把派发、关闭门、节点、质量门和实时回送关系汇成可跳转的处置看板");
    check("执行监控页要说明任务执行中的实时回送和控制 ACK 关系",
      /实时回送链路/u.test(monitorHtml)
        && /Agent 从服务端原子领活/u.test(monitorHtml)
        && /Agent 执行中持续回送进度、输出摘要/u.test(monitorHtml)
        && /节点长轮询领取并 ACK/u.test(monitorHtml)
        && /远程 MCP、Skill 工作集和任务控制都由服务端统一调度/u.test(monitorHtml)
        && /总控和监测角色通过服务端状态及时纠偏/u.test(monitorHtml)
        && /data-jump-panel="控制通道"/u.test(monitorHtml)
        && /data-jump-panel="运行时节点"/u.test(monitorHtml),
      "执行监控页仍然只堆明细表，没有解释事件流、控制通道、节点和关闭门之间的实时链路");
    const monitorNoNodeState = structuredClone(overviewState);
    monitorNoNodeState.agentRuntimeNodes = [];
    const monitorNoNodeHtml = probe.renderMonitorWith(monitorNoNodeState, admin, "p1").replace(/<!--[\s\S]*?-->/gu, "");
    check("执行监控无节点卡片必须给完整项目注册路径",
      /先到「项目管理」→「AI 智能体」→「注册 agent」签发加入令牌并复制服务端安装脚本/u.test(monitorNoNodeHtml),
      "监控页节点卡片只写去 AI 智能体页，用户不知道注册脚本来自项目级一次性令牌弹窗");
    const monitorAbnormalState = structuredClone(overviewState);
    monitorAbnormalState.agentRuntimeNodes = [{nodeId: "node_bad", nodeName: "异常节点", status: "degraded",
      admission: "read_only", lastHeartbeatAt: "2099-01-01T00:00:00Z", selfCheckMissing: ["mcp_remote"]}];
    const monitorAbnormalHtml = probe.renderMonitorWith(monitorAbnormalState, admin, "p1").replace(/<!--[\s\S]*?-->/gu, "");
    check("执行监控异常节点卡片必须指向项目智能体刷新自检",
      /先恢复 agent 主机\/进程心跳/u.test(monitorAbnormalHtml)
        && /项目管理.+AI 智能体.+项目智能体节点.+刷新自检/u.test(monitorAbnormalHtml)
        && /data-jump-panel="运行时节点"/u.test(monitorAbnormalHtml),
      "监控页能看到异常节点，却没有把用户带回真实的项目节点自检操作");
    const sysSettingsHtml = probe.renderSysSettingsWith(overviewState, {sharedDefinitions: [{contractId: "def_1", definitionType: "api_contract", canonicalOwnerRole: "integration_owner", producerRole: "architect", status: "active"}]}).replace(/<!--[\s\S]*?-->/gu, "");
    check("系统设置页先显示总览，再显示运行参数",
      panelAt(sysSettingsHtml, "系统设置总览") >= 0
        && panelAt(sysSettingsHtml, "系统设置总览") < panelAt(sysSettingsHtml, "运行参数（只读）"),
      "系统设置页首屏直接进入只读字段和长表，管理员无法先判断模型、技能、MCP 与共享定义状态");
    check("系统设置页要先给全局能力操作看板，再显示长表",
      panelAt(sysSettingsHtml, "系统设置总览") >= 0
        && panelAt(sysSettingsHtml, "系统设置总览") < panelAt(sysSettingsHtml, "系统设置操作看板")
        && panelAt(sysSettingsHtml, "系统设置操作看板") < panelAt(sysSettingsHtml, "系统能力治理流程")
        && panelAt(sysSettingsHtml, "系统能力治理流程") < panelAt(sysSettingsHtml, "运行参数（只读）")
        && /data-jump-panel="运行参数（只读）"/u.test(sysSettingsHtml)
        && /data-jump-panel="技能源"/u.test(sysSettingsHtml)
        && /data-jump-panel="模型能力注册（只读）"/u.test(sysSettingsHtml)
        && /data-jump-panel="角色技能叠加（改动 agent 能力，只读）"/u.test(sysSettingsHtml)
        && /data-jump-panel="指令压缩指标"/u.test(sysSettingsHtml)
        && /data-jump-panel="共享定义归属"/u.test(sysSettingsHtml)
        && /项目管理.+AI 智能体.+注册 agent/u.test(sysSettingsHtml),
      "系统设置页只有总览没有操作入口，管理员仍要向下读运行参数、技能源、模型和共享定义长表");
    check("系统设置页要说明全局能力治理和项目级入口边界",
      /系统能力治理流程/u.test(sysSettingsHtml)
        && /集中 MCP 工具数/u.test(sysSettingsHtml)
        && /技能源只在服务端同步/u.test(sysSettingsHtml)
        && /Agent 端按派发下载最小 Skill 工作集/u.test(sysSettingsHtml)
        && /任务选型会避开或阻塞/u.test(sysSettingsHtml)
        && /系统页只追踪项目\/任务组叠加/u.test(sysSettingsHtml)
        && /系统设置不签发 join token/u.test(sysSettingsHtml)
        && /项目执行仍回到项目设置、AI 智能体、任务组和执行监控/u.test(sysSettingsHtml)
        && /data-menu="proj-settings"/u.test(sysSettingsHtml)
        && /data-menu="proj-agents"/u.test(sysSettingsHtml),
      "系统设置页没有把模型、技能源、集中 MCP、项目级定制和 agent 注册边界讲成流程");
    const membersHtml = probe.renderOrgMembersWith(overviewState, orgAdmin, [
      {...orgAdmin, status: "active"},
      {accountId: "acct_wait", accountType: "user_account", displayName: "待登录成员", email: "wait@example.com", status: "invited", roles: []}
    ], "p1").replace(/<!--[\s\S]*?-->/gu, "");
    check("成员管理页先显示总览和列表，再显示创建表单",
      panelAt(membersHtml, "成员管理总览") >= 0
        && panelAt(membersHtml, "成员管理总览") < panelAt(membersHtml, "成员管理操作看板")
        && panelAt(membersHtml, "成员管理操作看板") < panelAt(membersHtml, "成员授权流程")
        && panelAt(membersHtml, "成员授权流程") < panelAt(membersHtml, "成员列表")
        && panelAt(membersHtml, "成员列表") < panelAt(membersHtml, "创建成员"),
      "成员管理页没有把邀请、停用、注销、授权边界和创建入口排成可点击操作看板与流程图");
    {
      const bundles = [...membersHtml.matchAll(/<details class="guide-bundle"( open)?>([\s\S]*?)<\/details>/gu)];
      check("组织成员页的「成员授权流程」要收进默认关闭的折叠块（成员列表与创建表单留在外面）",
        bundles.length === 1 && !bundles[0][1] && bundles[0][2].includes("<h2>成员授权流程</h2>")
          && !bundles[0][2].includes("<h2>成员列表</h2>") && !bundles[0][2].includes("<h2>创建成员</h2>"),
        `折叠块 ${bundles.length} 个（默认打开 ${bundles.filter((m) => m[1]).length} 个）—— 成员列表被三层引导推到下面`);
    }
    check("成员管理操作看板要提供成员列表、创建成员和说明的跳转入口",
      /data-jump-panel="成员列表"/u.test(membersHtml)
        && /data-jump-panel="创建成员"/u.test(membersHtml)
        && /data-jump-panel="说明"/u.test(membersHtml),
      "成员管理操作看板只显示指标，没有接上成员列表、创建成员和说明面板的跳转");
    check("成员授权流程要说明组织成员、项目授权和任务组权限边界",
      /成员授权流程/u.test(membersHtml)
        && /创建成员只完成账号入网，不等于已经能参与某个项目/u.test(membersHtml)
        && /已选项目时直接进入「成员权限」→「项目成员授权」/u.test(membersHtml)
        && /组织项目列表保留集中入口/u.test(membersHtml)
        && /任务组控制和人工审核通过项目角色落位/u.test(membersHtml)
        && /进入目标项目「成员权限」完成项目成员授权/u.test(membersHtml)
        && /回项目概览检查任务组、AI 智能体、监控和审核入口是否可用/u.test(membersHtml)
        && /成员管理只处理组织账号生命周期/u.test(membersHtml)
        && /data-menu="proj-members"/u.test(membersHtml)
        && /data-menu="proj-overview"/u.test(membersHtml),
      "成员管理页没有把账号入网、项目授权、任务组权限和回项目操作讲成闭环");
    const membersWithoutProjectHtml = probe.renderOrgMembersWith(overviewState, orgAdmin, [
      {...orgAdmin, status: "active"}
    ], "").replace(/<!--[\s\S]*?-->/gu, "");
    check("成员授权流程没有当前项目时仍要回组织项目列表选目标项目",
      /先在组织项目列表选定目标项目/u.test(membersWithoutProjectHtml)
        && /data-menu="org-projects"/u.test(membersWithoutProjectHtml),
      "没有当前项目时仍直接跳项目成员权限，用户没有目标项目上下文");
    const agentsHtml = probe.renderOrgAgentsWith(overviewState, orgAdmin, [
      {nodeId: "node1", nodeName: "节点", status: "online", display: {health: "ok", currentDispatchIds: ["adp1"]}, lastHeartbeatAt: "2099-01-01T00:00:00Z"}
    ]).replace(/<!--[\s\S]*?-->/gu, "");
    check("AI 智能体页先显示运行总览、治理看板、管理边界和治理流程，再显示节点列表",
      panelAt(agentsHtml, "智能体运行总览") >= 0
        && panelAt(agentsHtml, "智能体运行总览") < panelAt(agentsHtml, "智能体治理操作看板")
        && panelAt(agentsHtml, "智能体治理操作看板") < panelAt(agentsHtml, "智能体管理边界")
        && panelAt(agentsHtml, "智能体管理边界") < panelAt(agentsHtml, "组织 Agent 治理流程")
        && panelAt(agentsHtml, "组织 Agent 治理流程") < panelAt(agentsHtml, "智能体节点")
        && panelAt(agentsHtml, "智能体节点") < panelAt(agentsHtml, "加入令牌审计"),
      "AI 智能体页没有把在线率、异常节点、负载、令牌审计和组织/项目边界排成可点击操作看板");
    check("组织 AI 智能体治理看板要提供节点、令牌审计和项目注册跳转入口",
      /data-jump-panel="智能体节点"/u.test(agentsHtml)
        && /data-jump-panel="加入令牌审计"/u.test(agentsHtml)
        && /data-menu="proj-agents"/u.test(agentsHtml)
        && /进入后先用顶部项目选择器确认目标项目/u.test(agentsHtml)
        && !/data-form="join-token"/u.test(agentsHtml),
      "组织智能体治理看板只显示指标，或仍把组织页当作常规 agent 注册入口");
    check("组织 AI 智能体页要把在线率、异常、项目注册、派发、令牌审计和节点处置串成流程",
      /组织 Agent 治理流程/u.test(agentsHtml)
        && /先判断组织内是否有可接收派发的节点/u.test(agentsHtml)
        && /离线、非健康或自检缺项先定位节点/u.test(agentsHtml)
        && /新增节点必须回目标项目 AI 智能体页签发一次性令牌和 sh 安装命令/u.test(agentsHtml)
        && /实时事件和控制 ACK 回项目执行监控查看/u.test(agentsHtml)
        && /组织页只审计和撤销待用令牌，不在这里生成项目注册脚本/u.test(agentsHtml)
        && /暂停、恢复、关停、吊销和立即切断都在节点列表按单节点执行/u.test(agentsHtml)
        && /项目级注册脚本、远程 MCP 生效确认、Skill 工作集和具体派发回送/u.test(agentsHtml)
        && /data-menu="proj-agents"/u.test(agentsHtml)
        && /data-menu="monitor"/u.test(agentsHtml),
      "组织 AI 智能体页没有按节点治理和项目注册分工形成流程");
    check("组织 AI 智能体节点操作要提供刷新自检入口",
      /data-command="refresh_profile"/u.test(agentsHtml) && /刷新自检/u.test(agentsHtml),
      "阻塞处置提示会要求到组织 AI 智能体页刷新自检，但节点行没有这个按钮");
    check("组织 AI 智能体危险按钮不能粘连成一段",
      /data-action="revoke-agent-node"/u.test(agentsHtml)
        && /data-action="force-revoke-agent-node"/u.test(agentsHtml)
        && !/吊销立即切断/u.test(agentsHtml),
      "节点控制区把两个危险按钮粘成「吊销立即切断」，普通用户会读不清这是两个动作");
    const projectAgentsState = {
      ...overviewState,
      taskGroups: [{id: "tg1", projectId: "p1", name: "执行组", status: "development", workItems: []}],
      agentRuntimeNodes: [{nodeId: "node_p1", nodeName: "项目节点", status: "online", admission: "full",
        projectIds: ["p1"], display: {health: "ok", currentDispatchIds: ["adp1"], region: "ap-east"}}],
      agentJoinTokens: [{joinTokenId: "join_1", projectId: "p1", allowedRoles: ["agent-runtime"],
        status: "issued", useCount: 0, maxUses: 1, expiresAt: "2099-01-01T00:00:00Z"}],
      agentDispatches: [{dispatchId: "adp1", taskGroupId: "tg1", status: "running"}]
    };
    const projectAgentHtml = probe.renderProjectAgentsWith(projectAgentsState, systemAdmin, "p1").replace(/<!--[\s\S]*?-->/gu, "");
    const projectAgentScriptHubHtml = panelSlice(projectAgentHtml, "注册与脚本操作台", "Agent 接入与运行闭环");
    check("项目 AI 智能体页要先显示总览、操作看板、注册流程、运行闭环和节点处置流程，再显示节点与注册入口",
      panelAt(projectAgentHtml, "项目智能体总览") >= 0
        && panelAt(projectAgentHtml, "项目智能体总览") < panelAt(projectAgentHtml, "项目智能体操作看板")
        && panelAt(projectAgentHtml, "项目智能体操作看板") < panelAt(projectAgentHtml, "Agent 注册流程")
        && panelAt(projectAgentHtml, "Agent 注册流程") < panelAt(projectAgentHtml, "注册与脚本操作台")
        && panelAt(projectAgentHtml, "注册与脚本操作台") < panelAt(projectAgentHtml, "Agent 接入与运行闭环")
        && panelAt(projectAgentHtml, "Agent 接入与运行闭环") < panelAt(projectAgentHtml, "Agent 节点处置流程")
        && panelAt(projectAgentHtml, "Agent 节点处置流程") < panelAt(projectAgentHtml, "项目智能体节点")
        && panelAt(projectAgentHtml, "项目智能体节点") < panelAt(projectAgentHtml, "注册 agent"),
      "项目级智能体入口仍可能藏在项目设置里，项目负责人不能直接按项目查看节点、注册流程、运行闭环和注册脚本");
    check("项目 AI 智能体页要在节点长表前提供注册与脚本操作台",
      /注册与脚本操作台/u.test(projectAgentScriptHubHtml)
        && /签发 join token/u.test(projectAgentScriptHubHtml)
        && /获取安装脚本/u.test(projectAgentScriptHubHtml)
        && /签发后/u.test(projectAgentScriptHubHtml)
        && /确认节点自检/u.test(projectAgentScriptHubHtml)
        && /查看实时回送/u.test(projectAgentScriptHubHtml)
        && /签发成功弹窗给出 direct 和 SHA256 校验版 sh 命令，只显示一次/u.test(projectAgentScriptHubHtml)
        && /第一次接入 agent 的快捷操作台/u.test(projectAgentScriptHubHtml)
        && /必须先由服务端按当前项目签发一次性 join token/u.test(projectAgentScriptHubHtml)
        && /列表只能审计和撤销，不能还原明文/u.test(projectAgentScriptHubHtml)
        && /Agent 端执行脚本后只运行 Runtime/u.test(projectAgentScriptHubHtml)
        && /服务端 Gateway、远程 MCP 和最小 Skill 工作集/u.test(projectAgentScriptHubHtml)
        && /模型输出摘要和控制 ACK/u.test(projectAgentScriptHubHtml)
        && /data-jump-panel="注册 agent"/u.test(projectAgentScriptHubHtml)
        && /data-jump-panel="项目智能体节点"/u.test(projectAgentScriptHubHtml)
        && /data-menu="monitor"/u.test(projectAgentScriptHubHtml)
        && panelAt(projectAgentHtml, "注册与脚本操作台") < panelAt(projectAgentHtml, "项目智能体节点"),
      "项目 AI 智能体页仍没有把生成注册脚本、节点自检和实时监控入口做成节点长表前的操作台");
    // 【阅读型指引默认收起】：真实产出读下来这一页在节点列表前堆了四组流程指引（20 步）。三组阅读型的收进
    // 默认关闭的折叠块（内容仍在、摘要说明里面有什么），可操作的「注册与脚本操作台」与节点列表必须留在折叠块外。
    {
      const bundles = [...projectAgentHtml.matchAll(/<details class="guide-bundle"( open)?>([\s\S]*?)<\/details>/gu)];
      const inBundle = (title) => bundles.some((m) => m[2].includes(`<h2>${title}</h2>`));
      check("项目 AI 智能体页的三组阅读型指引要收进默认关闭的折叠块",
        bundles.length === 2 && bundles.every((m) => !m[1])
          && inBundle("Agent 注册流程") && inBundle("Agent 接入与运行闭环") && inBundle("Agent 节点处置流程"),
        `折叠块 ${bundles.length} 个（默认打开 ${bundles.filter((m) => m[1]).length} 个）；注册流程/运行闭环/处置流程在折叠块里：`
          + `${["Agent 注册流程", "Agent 接入与运行闭环", "Agent 节点处置流程"].map(inBundle).join("/")} —— 节点列表又被推到几屏之下`);
      check("可操作的「注册与脚本操作台」与「项目智能体节点」不许被折叠起来",
        !inBundle("注册与脚本操作台") && !inBundle("项目智能体节点") && !inBundle("注册 agent"),
        "第一次接入用的操作台或节点列表被收进折叠块 —— 人得先猜再点");
      check("折叠块摘要要说明里面有哪几组、默认收起",
        bundles.length === 2 && /Agent 注册流程（5 步）[\s\S]*默认收起/u.test(projectAgentHtml)
          && /Agent 接入与运行闭环（5 步） · Agent 节点处置流程（6 步）[\s\S]*默认收起/u.test(projectAgentHtml),
        "折叠块摘要没说清里面是什么");
      check("Agent 档案表的默认模型预设要显示与创建表单一致的中文（不是原始码 auto_best）",
        /自动最优<div class="small muted mono">auto_best<\/div>/u.test(projectAgentHtml),
        "档案表里默认模型仍是原始码 auto_best，而创建表单里叫「自动最优」—— 同一个东西两种叫法");
    }
    check("项目 AI 智能体页要提供注册脚本来源和节点控制入口",
      /签发一次性加入令牌/u.test(projectAgentHtml)
        && /注册脚本/u.test(projectAgentHtml)
        && /Agent 注册流程/u.test(projectAgentHtml)
        && /远程 MCP/u.test(projectAgentHtml)
        && /项目节点/u.test(projectAgentHtml)
        && /data-command="refresh_profile"/u.test(projectAgentHtml)
        && /data-jump-panel="注册 agent"/u.test(projectAgentHtml),
      "项目智能体页没有把「先签发令牌、再拿服务端注册脚本」这条操作链路放到首屏");
    check("项目 AI 智能体页要说明 Agent 接入后的机器执行闭环",
      /Agent 接入与运行闭环/u.test(projectAgentHtml)
        && /Agent 主机只跑 Runtime/u.test(projectAgentHtml)
        && /不启动本地 MCP、数据库或 Skill Registry/u.test(projectAgentHtml)
        && /控制面公网 \/mcp/u.test(projectAgentHtml)
        && /最小 Skill 工作集/u.test(projectAgentHtml)
        && /持续回送事件、进度、模型输出摘要/u.test(projectAgentHtml)
        && /撤销 MCP grant，再等待节点 ACK/u.test(projectAgentHtml)
        && /data-menu="monitor"/u.test(projectAgentHtml),
      "项目智能体页仍只讲安装步骤，没有把集中 MCP、Skill 工作集、实时回送和服务端控制画成闭环");
    check("项目 AI 智能体页要把节点查看、离线恢复、自检、监控和高影响控制串成处置流程",
      /Agent 节点处置流程/u.test(projectAgentHtml)
        && /先确认在线且准入为完整的节点数量/u.test(projectAgentHtml)
        && /离线先恢复目标 agent 主机、Runtime 进程和心跳/u.test(projectAgentHtml)
        && /执行器、远程 MCP、文件系统或 Git 能力修好后/u.test(projectAgentHtml)
        && /点节点行“刷新自检”重新上报/u.test(projectAgentHtml)
        && /运行中异常先回执行监控看实时事件、派发状态和控制 ACK/u.test(projectAgentHtml)
        && /暂停、恢复和关停在节点行执行/u.test(projectAgentHtml)
        && /吊销或立即切断会废止 node token 和 MCP grant/u.test(projectAgentHtml)
        && /重新注册只用于新 agent 接入/u.test(projectAgentHtml)
        && /data-jump-panel="项目智能体节点"/u.test(projectAgentHtml)
        && /data-menu="monitor"/u.test(projectAgentHtml),
      "项目 AI 智能体页没有把注册完成后的节点治理做成普通用户能顺着处理的流程");
    check("项目 AI 智能体页要说明加入令牌命令只显示一次且不能从列表还原",
      /安装命令和明文 join token 只在签发成功弹窗里显示一次/u.test(projectAgentHtml)
        && /不能还原明文 join token/u.test(projectAgentHtml)
        && /撤销旧令牌后重新签发/u.test(projectAgentHtml),
      "项目智能体注册入口没有说明弹窗关闭后的令牌处置方式，用户会误以为列表还能拿回安装命令");
    check("项目 AI 智能体页要提供列表和卡片两种节点管理视图",
      /data-action="agent-view-mode" data-mode="table"/u.test(projectAgentHtml)
        && /data-action="agent-view-mode" data-mode="cards"/u.test(projectAgentHtml),
      "项目智能体页只有长表，普通用户不能用卡片方式快速扫读节点状态");
    const projectAgentCardsHtml = probe.renderProjectAgentsWith(projectAgentsState, systemAdmin, "p1", "cards").replace(/<!--[\s\S]*?-->/gu, "");
    check("项目 AI 智能体卡片视图要显示准入、健康、任务、心跳和节点控制操作",
      /class="agent-card"/u.test(projectAgentCardsHtml)
        && /准入：/u.test(projectAgentCardsHtml)
        && /健康度：/u.test(projectAgentCardsHtml)
        && /当前任务数：1/u.test(projectAgentCardsHtml)
        && /最近心跳：/u.test(projectAgentCardsHtml)
        && /data-action="agent-control"/u.test(projectAgentCardsHtml)
        && /data-command="refresh_profile"/u.test(projectAgentCardsHtml),
      "项目智能体卡片视图没有承载关键管理字段或节点控制按钮");
    check("系统管理员在项目 AI 智能体页仍够得到服务端允许的危险治理操作",
      /data-action="revoke-agent-node"/u.test(projectAgentHtml)
        && /data-action="force-revoke-agent-node"/u.test(projectAgentHtml),
      "服务端按项目作用域 agent:activate 允许吊销/立即切断，系统管理员若只能看项目页，界面不能把这两个杠杆藏到组织页");
    const orgProjectAgentHtml = probe.renderProjectAgentsWith(projectAgentsState, orgAdmin, "p1").replace(/<!--[\s\S]*?-->/gu, "");
    check("组织管理员在项目 AI 智能体页看到组织治理出口而不是重复危险按钮",
      !/data-action="revoke-agent-node"/u.test(orgProjectAgentHtml)
        && !/data-action="force-revoke-agent-node"/u.test(orgProjectAgentHtml)
        && /吊销和立即切断在「组织管理」→「AI 智能体」处理/u.test(orgProjectAgentHtml),
      "组织管理员已有组织级智能体治理页，项目页再放吊销/立即切断会弱化职责边界");
    check("项目 AI 智能体节点危险按钮不能粘连成一段",
      !/吊销立即切断/u.test(projectAgentHtml) && !/吊销立即切断/u.test(projectAgentCardsHtml),
      "项目节点操作区把「吊销」和「立即切断」粘在一起，危险操作边界不清晰");
    const projectOverviewRoot = el("div");
    loadConsole(projectOverviewRoot, {realI18n: true}).renderFullPageWith(projectAgentsState, admin, "p1", "proj-overview");
    const overviewHtml = String(projectOverviewRoot.innerHTML || "").replace(/<!--[\s\S]*?-->/gu, "");
    check("项目概览要有 AI 智能体模块卡片，不能只靠项目设置里的隐藏入口",
      /data-menu="proj-agents"/u.test(overviewHtml) && /AI 智能体/u.test(overviewHtml) && /注册 agent|管理节点/u.test(overviewHtml),
      "项目概览缺少通往项目智能体管理的一跳入口，用户看到无在线 agent 时仍要自己猜去哪里注册");
    const noAgentOverviewRoot = el("div");
    const noAgentOverviewState = structuredClone(projectAgentsState);
    noAgentOverviewState.agentRuntimeNodes = [];
    loadConsole(noAgentOverviewRoot, {realI18n: true}).renderFullPageWith(noAgentOverviewState, admin, "p1", "proj-overview");
    const noAgentOverviewHtml = String(noAgentOverviewRoot.innerHTML || "").replace(/<!--[\s\S]*?-->/gu, "");
    check("项目概览无节点时必须说清注册脚本来源",
      /进入「项目管理」→「AI 智能体」→「注册 agent」签发加入令牌并复制服务端安装脚本/u.test(noAgentOverviewHtml)
        && /agent 主机上执行安装命令/u.test(noAgentOverviewHtml),
      "项目概览虽然有 AI 智能体入口，但没有把一次性令牌、服务端安装脚本和 MCP/Skill 生效串成闭环");
    // 【项目概览只留一份贯穿的人工路径】。曾同时有顶部「流程导航」与下方「项目操作路径」（7 张卡 + 推荐顺序），
    // 同一件事两份说法。人定留流程导航；它原先缺的「项目设置（含角色 Skill 定制）」「成员权限」两步并进去。
    const overviewGuide = (() => { const start = overviewHtml.indexOf("流程导航"); const end = overviewHtml.indexOf("按当前项目实时计算", start); return start >= 0 ? overviewHtml.slice(start, end > start ? end : undefined) : ""; })();
    check("项目概览只留一份贯穿的人工路径（流程导航），不再另摆「项目操作路径」",
      panelAt(overviewHtml, "流程导航") >= 0 && panelAt(overviewHtml, "项目操作路径") < 0 && !/推荐顺序：/u.test(overviewHtml),
      "项目概览同时摆着两份流程指引 —— 人不知道该看哪份");
    check("流程导航要把项目设置（含角色 Skill 定制）与成员权限纳入路径并能直达",
      /data-menu="proj-settings"/u.test(overviewGuide) && /角色 Skill 定制/u.test(overviewGuide) && /data-menu="proj-members"/u.test(overviewGuide)
        && /data-menu="proj-agents"/u.test(overviewGuide) && /data-menu="tg"/u.test(overviewGuide) && /data-menu="monitor"/u.test(overviewGuide)
        && /data-menu="review"/u.test(overviewGuide) && /data-menu="directives"/u.test(overviewGuide),
      "撤掉「项目操作路径」后，项目设置 / 成员权限的入口没有并进流程导航 —— 去重变成了删功能");
    check("项目概览要先显示仓库产出归属概览，再保留完整仓库明细表",
      panelAt(overviewHtml, "最新执行事件") >= 0
        && panelAt(overviewHtml, "最新执行事件") < panelAt(overviewHtml, "仓库产出归属概览")
        && panelAt(overviewHtml, "仓库产出归属概览") < panelAt(overviewHtml, "仓库产出归属")
        && /仓库数/u.test(overviewHtml)
        && /仓库分支/u.test(overviewHtml)
        && /生效目标/u.test(overviewHtml)
        && /已被取代/u.test(overviewHtml)
        && /允许路径组/u.test(overviewHtml)
        && /完整任务组、仓库、分支、状态和允许路径仍保留在下方表格/u.test(overviewHtml)
        && /data-jump-panel="仓库产出归属"/u.test(overviewHtml)
        && /多仓库、多任务组的完整记录仍以 Git 仓库产出和下方明细为准/u.test(overviewHtml),
      "项目概览仍直接把仓库产出明细堆在底部，没有先给仓库、分支、状态和允许路径的归纳层");
    const orgProjectsRoot = el("div");
    loadConsole(orgProjectsRoot, {realI18n: true}).renderFullPageWith(overviewState, orgAdmin, "p1", "org-projects");
    const orgProjectsHtml = String(orgProjectsRoot.innerHTML || "").replace(/<!--[\s\S]*?-->/gu, "");
    check("组织项目页先显示总览和操作看板，再显示列表与新增授权表单",
      panelAt(orgProjectsHtml, "项目管理总览") >= 0
        && panelAt(orgProjectsHtml, "项目管理总览") < panelAt(orgProjectsHtml, "项目管理操作看板")
        && panelAt(orgProjectsHtml, "项目管理操作看板") < panelAt(orgProjectsHtml, "项目治理流程")
        && panelAt(orgProjectsHtml, "项目治理流程") < panelAt(orgProjectsHtml, "项目列表")
        && panelAt(orgProjectsHtml, "项目列表") < panelAt(orgProjectsHtml, "创建项目")
        && panelAt(orgProjectsHtml, "创建项目") < panelAt(orgProjectsHtml, "项目成员授权"),
      "组织项目页仍然缺少总览后的操作入口，组织管理员要先读长表和表单才知道从哪里处理");
    check("组织项目操作看板要提供项目列表、创建项目和成员授权的跳转入口",
      /data-jump-panel="项目列表"/u.test(orgProjectsHtml)
        && /data-jump-panel="创建项目"/u.test(orgProjectsHtml)
        && /data-jump-panel="项目成员授权"/u.test(orgProjectsHtml),
      "项目管理操作看板只显示指标，没有接上列表、创建项目和成员授权面板的跳转");
    check("组织项目页要把项目创建、成员授权、配置、Agent 接入、任务组执行和归档串成流程",
      /项目治理流程/u.test(orgProjectsHtml)
        && /创建人自动成为项目负责人/u.test(orgProjectsHtml)
        && /否则只能看到组织账号，不能管理项目/u.test(orgProjectsHtml)
        && /角色 Skill 定制在项目设置维护/u.test(orgProjectsHtml)
        && /一次性 join token 和 sh 安装命令只在目标项目 AI 智能体页生成/u.test(orgProjectsHtml)
        && /统一语言、角色、工作项和自动派发主线/u.test(orgProjectsHtml)
        && /归档是终态不能继续新建工作/u.test(orgProjectsHtml)
        && /不要在组织项目页寻找 Agent 注册脚本/u.test(orgProjectsHtml)
        && /data-menu="proj-settings"/u.test(orgProjectsHtml)
        && /data-menu="proj-agents"/u.test(orgProjectsHtml)
        && /data-menu="tg"/u.test(orgProjectsHtml),
      "组织项目页没有把项目生命周期和项目内部执行入口讲成清晰流程");
    const orgOverviewHtml = probe.renderOrgOverviewWith(overviewState, orgAdmin, [
      {...orgAdmin, status: "active"},
      {accountId: "acct_wait", accountType: "user_account", displayName: "待登录成员", email: "wait@example.com", status: "invited", roles: []}
    ], overviewState.agentRuntimeNodes).replace(/<!--[\s\S]*?-->/gu, "");
    const orgHubAt = orgOverviewHtml.indexOf("project-hub-title\">组织管理总览 · 默认组织");
    check("组织概览要先显示组织操作路径，再显示配额、统计和项目一览",
      orgHubAt >= 0
        && orgHubAt < panelAt(orgOverviewHtml, "组织操作路径")
        && panelAt(orgOverviewHtml, "组织操作路径") < panelAt(orgOverviewHtml, "配额用量 · 默认组织")
        && panelAt(orgOverviewHtml, "配额用量 · 默认组织") < panelAt(orgOverviewHtml, "组织运行统计")
        && panelAt(orgOverviewHtml, "组织运行统计") < panelAt(orgOverviewHtml, "项目一览"),
      "组织概览仍像只读报表，组织管理员看完指标后不知道该先管成员、节点、项目还是进入项目执行");
    check("组织概览操作路径要覆盖成员、Agent、项目和项目执行四个入口",
      /1 成员与权限/u.test(orgOverviewHtml)
        && /2 Agent 节点/u.test(orgOverviewHtml)
        && /3 项目与授权/u.test(orgOverviewHtml)
        && /4 项目执行/u.test(orgOverviewHtml)
        && /data-menu="org-members"/u.test(orgOverviewHtml)
        && /data-menu="org-agents"/u.test(orgOverviewHtml)
        && /data-menu="org-projects"/u.test(orgOverviewHtml)
        && /data-menu="proj-overview"/u.test(orgOverviewHtml),
      "组织概览缺少按中文管理顺序组织的图形化入口，用户仍要从左侧菜单猜下一步");
    const orgOverviewWithoutNodes = probe.renderOrgOverviewWith(overviewState, orgAdmin, [
      {...orgAdmin, status: "active"}
    ], []).replace(/<!--[\s\S]*?-->/gu, "");
    check("组织概览无节点时不能把常规注册说成组织页接入",
      /新增 agent 先进入目标项目注册/u.test(orgOverviewWithoutNodes)
        && !/需要执行任务前先接入节点/u.test(orgOverviewWithoutNodes)
        && !/先接入 agent/u.test(orgOverviewWithoutNodes),
      "组织概览把新增 agent 写成组织页接入，用户会在组织页找不到项目注册脚本");
    check("组织概览项目表要有进入项目和项目授权按钮",
      /data-action="open-project-page" data-project="p1" data-target-menu="proj-overview"/u.test(orgOverviewHtml)
        && /data-action="open-project-page" data-project="p1" data-target-menu="org-projects"/u.test(orgOverviewHtml)
        && /进入项目/u.test(orgOverviewHtml)
        && /项目授权/u.test(orgOverviewHtml),
      "组织概览的项目一览仍然只能看不能操作，多项目时用户无法从表格直接进入目标项目或授权");
    check("组织概览的项目按钮处理器必须先切 currentProjectId 再跳页",
      /open-project-page/u.test(probe.handlerSource("click"))
        && /currentProjectId = targetProjectId/u.test(probe.handlerSource("click"))
        && /sessionStorage\.setItem\("aimac\.projectId", currentProjectId\)/u.test(probe.handlerSource("click")),
      "组织概览项目表按钮只跳页面、不切项目，多项目时会打开上一个项目");
    const reviewHtml = probe.renderReviewWith(overviewState, orgAdmin, "p1").replace(/<!--[\s\S]*?-->/gu, "");
    check("人工审核页先显示审核总览和处置看板，再显示待办与明细",
      panelAt(reviewHtml, "人工审核总览") >= 0
        && panelAt(reviewHtml, "人工审核总览") < panelAt(reviewHtml, "人工审核处置看板")
        && panelAt(reviewHtml, "人工审核处置看板") < panelAt(reviewHtml, "人工审核流程")
        && panelAt(reviewHtml, "人工审核流程") < panelAt(reviewHtml, "待你处理")
        && panelAt(reviewHtml, "待你处理") < panelAt(reviewHtml, "待人工确认"),
      "人工审核页没有把确认、授权、审批、发现项和历史追溯排成可点击处置看板与流程图");
    check("人工审核处置看板要提供待办、确认、授权处置和历史的跳转入口",
      /data-jump-panel="待你处理"/u.test(reviewHtml)
        && /data-jump-panel="待人工确认"/u.test(reviewHtml)
        && /data-jump-panel="授权与处置"/u.test(reviewHtml)
        && /data-jump-panel="已答历史"/u.test(reviewHtml),
      "人工审核处置看板只显示指标，没有接上待你处理、待人工确认、授权与处置和已答历史面板的跳转");
    check("人工审核流程要说明人机边界、监控回看和关闭门闭环",
      /人工审核流程/u.test(reviewHtml)
        && /AI 只提交材料，不替人定稿/u.test(reviewHtml)
        && /涉及权限、危险操作或阶段门放行/u.test(reviewHtml)
        && /发现项会阻塞关闭门/u.test(reviewHtml)
        && /执行监控看派发继续、控制 ACK 和关闭门变化/u.test(reviewHtml)
        && /系统运行中不会自动把重复问题改造成系统升级/u.test(reviewHtml)
        && /data-menu="monitor"/u.test(reviewHtml),
      "人工审核页没有把人工定稿、授权审批、发现项、执行监控回看和系统外升级边界讲成流程");
    const directivesHtml = probe.renderDirectivesWith(overviewState, orgAdmin, "p1", [
      {directiveId: "dir1", taskGroupId: "tg1", directiveType: "pause", instruction: "暂停", status: "applied", appliedActions: [{action: "task_group_pause"}], createdAt: "2026-08-12T00:00:00Z"},
      {directiveId: "dir2", taskGroupId: "tg1", directiveType: "free_text", instruction: "补充说明", status: "rejected", rejectReason: "task_group_settled", createdAt: "2026-08-12T00:01:00Z"}
    ]).replace(/<!--[\s\S]*?-->/gu, "");
    check("人工指令页先显示总览和操作看板，再显示流水与下达表单",
      panelAt(directivesHtml, "人工指令总览") >= 0
        && panelAt(directivesHtml, "人工指令总览") < panelAt(directivesHtml, "人工指令操作看板")
        && panelAt(directivesHtml, "人工指令操作看板") < panelAt(directivesHtml, "人工指令流程")
        && panelAt(directivesHtml, "人工指令流程") < panelAt(directivesHtml, "指令流水")
        && panelAt(directivesHtml, "指令流水") < panelAt(directivesHtml, "下达人工指令"),
      "人工指令页没有把待处理、拒绝、可控范围和下达入口排成可点击看板与流程图，用户仍要先读长表");
    check("人工指令操作看板要提供流水和下达表单的跳转入口",
      /data-jump-panel="指令流水"/u.test(directivesHtml)
        && /data-jump-panel="下达人工指令"/u.test(directivesHtml),
      "人工指令操作看板只显示指标，没有接上指令流水和下达人工指令面板的跳转");
    check("人工指令流程要说明结构化输入、编排消费和监控回看",
      /人工指令流程/u.test(directivesHtml)
        && /只能向你有任务组控制权的组下达指令/u.test(directivesHtml)
        && /都会落成结构化输入/u.test(directivesHtml)
        && /不会直接改总控会话/u.test(directivesHtml)
        && /下一编排周期读取/u.test(directivesHtml)
        && /被拒绝时先看原因/u.test(directivesHtml)
        && /控制 ACK 是否按预期变化/u.test(directivesHtml)
        && /data-menu="monitor"/u.test(directivesHtml),
      "人工指令页没有把目标任务组、结构化指令、编排周期、拒绝原因和监控回看讲成流程");
  }

  // 明细页的工作项来自专用端点，它现在也有上限（4000 单元时曾是约 1.1MB 载荷 + 4000 个 DOM 节点）。
  // 截断了就必须说清"共多少、当前展示多少"，并且要告诉人筛选只覆盖已加载的这些。
  {
    const baseGroup = {id: "tg1", projectId: "p1", name: "任务组", status: "development", workItems: []};
    const detailState = {
      schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [baseGroup], agentDispatches: [], workSessions: [], closeBarriers: [],
      qualityGates: [], findings: [], humanConfirmationRequests: [], truncatedCollections: []
    };
    const truncatedProgress = {taskGroupId: "tg1", progress: {}, config: null, roomMessages: [],
      progress: {workItems: Array.from({length: 300}, (_, index) => ({id: `w${index}`, title: `单元${index}`, status: "draft"})),
        workItemCount: 4000, workItemsTruncated: true, blockers: []}};
    const detailHtml = probe.renderTaskGroupsWith(detailState, admin, "p1", "tg1", truncatedProgress);
    // 【建组表单要列出已登记的执行角色】：自由文本配登记册校验＝拼错一次就 400（建组时现在就拒，不等派发）。
    if (!/创建任务组/u.test(detailHtml)) {
      check("建组表单的夹具要真的渲染出「创建任务组」面板", false, "夹具没渲染出建组面板 —— 下面那条什么也没验");
    } else {
      check("建组表单要列出已登记的执行角色（自由文本配登记册校验＝拼错一次就 400）",
        /<datalist id="owner-role-options">/u.test(detailHtml) && detailHtml.includes('<option value="reviewer">'),
        "建组表单没有执行角色的 datalist，或里面少了 reviewer");
    }
    // 判据要各自独立：标题与提示里都写着"共 4000 个"，用同一个模式匹配的话，
    // 删掉标题那一处它照样绿（第一版就是这样）。
    check("明细页的小节标题要带上真实总数",
      /工作项（共 4000 个，当前展示 300 个）/.test(detailHtml),
      "工作项被截断到 300 条，小节标题却没说共有多少 —— 人一眼看到的就是那个假数字");
    check("截断后的工作项动态标题也要作为小节锚点",
      /data-section-title="工作项（共 4000 个，当前展示 300 个）"/.test(detailHtml)
        && /data-jump-panel="工作项"/.test(detailHtml),
      "工作项标题带真实总数后没有稳定小节锚点，详情路径卡片会找不到这一节");
    check("提示里要写清只加载了最新的多少个",
      /只加载了最新的 300 个/.test(detailHtml),
      "截断了却没说只加载了一部分 —— 人会以为只有这些");
    check("要说清筛选只覆盖已加载的部分",
      /筛选只在已加载的这些里找/.test(detailHtml),
      "截断之后没说筛选范围 —— 人筛不到就会以为那个工作项不存在");
    const fullProgress = {taskGroupId: "tg1", progress: {}, config: null, roomMessages: [],
      progress: {workItems: [{id: "w0", title: "单元0", status: "draft"}], workItemCount: 1, blockers: []}};
    check("没有截断时不挂那条提示",
      !/筛选只在已加载的这些里找/.test(probe.renderTaskGroupsWith(detailState, admin, "p1", "tg1", fullProgress)),
      "没有截断却仍提示只加载了一部分 —— 常亮的提示等于没有提示");
    // 人工指令的「暂停」与「取消」落到同一个执行状态（active_paused_by_freeze），
    // 分得开它们的只有 pauseReason。服务端一直在写、中文也早就有，而界面一处都没渲染 ——
    // 于是下了取消的人看到的字样和别人按的暂停完全一样，而这两种停能不能恢复并不相同。
    const pausedState = {...detailState,
      taskGroups: [{...baseGroup, goalExecutionStatus: "active_paused_by_freeze", pauseReason: "human_directive_cancel"}]};
    i18nScanStates.push(["冻结暂停的任务组", pausedState, admin, "p1"]);
    const pausedHtml = probe.renderTaskGroupsWith(pausedState, admin, "p1", "tg1", fullProgress);
    check("冻结暂停要说清是什么原因停的",
      /human_directive_cancel/.test(pausedHtml),
      "任务组被冻结却不说停因 —— 人工指令的暂停与取消停在同一个状态上，界面上分不出是哪一种");
    // 人工补充要求会进入之后每一次派发、一直指挥所有 agent，而此前界面上一处都不渲染：
    // 人看不到自己（或同事）当初加了什么，也就无从判断该不该再加一条、或者为什么 agent 一直
    // 绕开某件事。超出保留上限而被丢掉的条数也要说出来 —— 悄悄丢掉人下达的要求是不能接受的。
    const guidanceState = {...detailState, taskGroups: [{...baseGroup,
      humanGuidance: [{text: "先不要动数据库结构", addedAt: "2026-08-01T00:00:00.000Z"}], humanGuidanceDroppedCount: 3}]};
    // 拿真实状态渲染时读出来的两处（AIMAC_RENDER_REAL）：
    //  · "语言：Chinese" —— 后端存的是英文语种名，直接摆在中文界面上。
    //  · 已完成的派发显示"0%" —— 它根本没上报过进度，`|| 0` 把"没有"变成了一个看起来精确的假数。
    const langState = {...detailState, taskGroups: [{...baseGroup,
      languagePolicy: {languageTag: "zh-CN", languageName: "Chinese"}}]};
    const langHtml = probe.renderTaskGroupsWith(langState, admin, "p1", "tg1", fullProgress);
    check("语种名要显示中文，不能把后端的英文名摆上去",
      /语言：中文/.test(langHtml) && !/语言：Chinese/.test(langHtml),
      "中文界面上写着「语言：Chinese」—— 界面本来就有 zh-CN→中文 的对照表");
    const guidanceHtml = probe.renderTaskGroupsWith(guidanceState, admin, "p1", "tg1", fullProgress);
    check("人工补充要求要看得见",
      /先不要动数据库结构/.test(guidanceHtml),
      "任务组页不显示人工补充要求 —— 它会进入之后每一次派发，人却看不到自己当初加了什么");
    check("被丢掉的补充要求要报数",
      /另有 3 条更早的/.test(guidanceHtml),
      "补充要求超出上限被丢掉了却不报数 —— 人以为自己下达的要求都还在");
    check("没有补充要求时不挂这一块",
      !/人工补充要求/.test(probe.renderTaskGroupsWith(detailState, admin, "p1", "tg1", fullProgress)),
      "没有补充要求也渲染那一块 —— 常亮的区块等于没有区块");
    check("没有停因时不挂那个标记",
      !/停因/.test(probe.renderTaskGroupsWith(detailState, admin, "p1", "tg1", fullProgress)),
      "没有 pauseReason 也挂停因标记 —— 常亮的标记等于没有标记");
  }

  // 视图里嵌的工作项是截断过的（真实总数在 workItemCount）。把截断后的长度当总数，
  // 正是这套系统反复栽过的坑：人看到"工作项：20"，实际有 300 个。
  {
    const truncatedState = {
      schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "development",
        workItems: Array.from({length: 20}, (_, index) => ({id: `w${index}`, title: `单元${index}`, status: "draft"})),
        workItemCount: 300, workItemsTruncated: true}],
      agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [], findings: [],
      humanConfirmationRequests: [], truncatedCollections: []
    };
    const listView = probe.renderTaskGroupsWith(truncatedState, admin, "p1");
    check("列表页的工作项数要报真实总数",
      /工作项：300/.test(listView),
      `嵌入的工作项被截断到 20 条，列表页却按截断后的长度报数 —— 人看到的是一个假数字（片段：${
        (listView.match(/工作项：\d+/) || ["无"])[0]}）`);
    // 明细页的 tgDetail 要给全形状（taskGroupId/progress/config/roomMessages），
    // 只传 {} 的话渲染根本走不到工作项那一段 —— 断言就成了在看一个没渲染出来的页面。
    const detailView = probe.renderTaskGroupsWith(truncatedState, admin, "p1", "tg1",
      {taskGroupId: "tg1", progress: {}, config: null, roomMessages: []});
    check("回落到截断列表时必须说清不是全部",
      /不要据此判断/.test(detailView) && /共 300 个/.test(detailView),
      "进度接口没加载出来、明细页回落到截断过的那份，却不说这只是前若干个 —— 人会据此判断只有这些");
    const fullState = structuredClone(truncatedState);
    fullState.taskGroups[0] = {...fullState.taskGroups[0], workItemCount: 20, workItemsTruncated: false};
    check("没有截断时不得挂着那条提示",
      !/不要据此判断/.test(probe.renderTaskGroupsWith(fullState, admin, "p1", "tg1",
        {taskGroupId: "tg1", progress: {}, config: null, roomMessages: []})),
      "没有截断却仍提示这不是全部 —— 常亮的提示等于没有提示");
  }

  // 角色技能叠加会改掉 agent 实际拥有的能力（含禁用某些能力），数据一直下发到系统设置页，
  // 却从没被渲染过 —— 人看不到某个项目/任务组的角色规则被谁改过、改成了什么。
  {
    const withOverlay = {
      schemaVersion: "runtime-state/v1", stateVersion: 1,
      runtime: {}, projects: [{id: "p1", name: "示例项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [{id: "tg1", projectId: "p1", name: "示例任务组", status: "development", workItems: []}],
      skillSources: [], roleSkills: [], modelCapabilities: [], accounts: [], organizations: [],
      roleSkillOverlays: [
        {overlayId: "rso_1", status: "active", roleSkillRef: "rsk_reviewer", projectId: "p1",
         patch: {allowedCapabilityAdds: [], forbiddenCapabilityAdds: ["repo_write"]}, createdAt: "2026-08-01T00:00:00Z"},
        {overlayId: "rso_old", status: "superseded", roleSkillRef: "rsk_old", projectId: "p1",
         patch: {forbiddenCapabilityAdds: ["mcp_call"]}, createdAt: "2026-07-01T00:00:00Z"}
      ],
      truncatedCollections: []
    };
    const view = probe.renderSysSettingsWith(withOverlay);
    check("生效中的角色技能叠加要看得见",
      view.includes("rsk_reviewer") && /禁掉 repo_write/.test(view),
      "叠加正在改动 agent 的能力，界面上却一个字都没有 —— 人不知道这个项目的角色规则被改过");
    check("已失效的叠加不得混进来",
      !view.includes("rsk_old"),
      "已被取代的叠加仍显示成生效中 —— 人会以为一条早就不作数的限制还在起作用");
    const noOverlay = {...withOverlay, roleSkillOverlays: []};
    check("没有叠加时明说 agent 用的是原始规则",
      /没有生效中的叠加/.test(probe.renderSysSettingsWith(noOverlay)),
      "空态什么都不说，人分不清是没有叠加、还是这一页没加载出来");
  }

  // 自治循环连续失败＝此刻没有任何东西在自行推进，而人正在等系统往下走。
  // 这必须在监控页上说出来，而不是只在"运行参数"里留一行小字。
  {
    const stalled = {
      schemaVersion: "runtime-state/v1", stateVersion: 1,
      runtime: {autonomousOrchestrator: {enabled: true, intervalMs: 60000, consecutiveErrors: 3,
        lastError: "boom", lastSuccessAt: "2026-08-01T00:00:00Z", lastTickResult: "error"}},
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "development", workItems: []}],
      agentDispatches: [], workSessions: [], workerLanes: [], agentRuntimeNodes: [], qualityGates: [],
      testResults: [], checkpoints: [], admissionDecisions: [], modelSelectionDecisions: [],
      sessionPlacementDecisions: [], closeBarriers: [], truncatedCollections: []
    };
    const stalledView = probe.renderMonitorWith(stalled, admin, "p1").replace(/<!--[\s\S]*?-->/gu, "");
    // 刚装完打开这一页是十一张"暂无数据"：每张都在说"这里什么都没有"，没有一张说为什么、下一步做什么。
    const freshState = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "development", workItems: []}],
      agentDispatches: [], workSessions: [], workerLanes: [], agentRuntimeNodes: [], qualityGates: [],
      testResults: [], checkpoints: [], admissionDecisions: [], modelSelectionDecisions: [],
      sessionPlacementDecisions: [], closeBarriers: [], agentExecutionEvents: [], truncatedCollections: []};
    const freshView = probe.renderMonitorWith(freshState, admin, "p1").replace(/<!--[\s\S]*?-->/gu, "");
    const freshBanner = freshView.slice(freshView.indexOf("还没有任何执行记录"), freshView.indexOf("还没有任何执行记录") + 260);
    check("一件执行记录都没有时，监控页要说清这是正常的以及下一步",
      /还没有任何执行记录/.test(freshBanner)
        && /项目管理」→「AI 智能体」→「注册 agent/.test(freshBanner)
        && !/项目设置」→「智能体接入/.test(freshBanner)
        && /签发一次性加入令牌/.test(freshBanner),
      "十一张「暂无数据」并排，人分不清「还没开始跑」和「跑了但没取回来」");
    const busyState = structuredClone(freshState);
    busyState.workSessions = [{sessionId: "s1", taskGroupId: "tg1", status: "running"}];
    check("有记录时不挂这条（常亮的提示等于没有提示）",
      !/还没有任何执行记录/.test(probe.renderMonitorWith(busyState, admin, "p1")),
      "有会话在跑，界面却还说「还没有任何执行记录」");

    check("自治循环连续失败要在监控页上说出来",
      /连续 3 拍失败|没有任何东西在自行推进/.test(stalledView),
      "自治循环已经连续失败、系统实际停摆，监控页却一个字都不说 —— 人会一直以为它在跑");
    // 停摆时人在这一页能做的唯一一件事就是手动推一拍，按钮就在这条提示下面 ——
    // 提示原先只说"只能手动来"，不指过去，等于这个出口不存在。
    // 判据必须收窄到【这条提示】：拿整页匹配的话，页面上那个按钮自己就含这四个字，
    // 把提示里的出口整段删掉它照样绿（第一版就是这样）。
    // 切到【这一条 notice 的 </div> 为止】：固定长度的窗口会越过提示够到页面上那个按钮，
    // 于是把提示里的出口整段删掉它照样绿（第一版 400 字的窗口就是这样）。
    const noticeStart = stalledView.indexOf("自治循环已连续");
    const stalledNotice = noticeStart < 0 ? ""
      : stalledView.slice(noticeStart, stalledView.indexOf("</div>", noticeStart));
    if (!stalledNotice) throw new Error("控制台行为门: 监控页上找不到停摆提示 —— 这一段断言在空转");
    check("停摆提示要指出本页就能手动推一拍",
      stalledNotice.includes("运行自治循环"),
      "报文说「需要人推进的事只能手动来」，而同一页上就有那个按钮 —— 不点名等于没有出口");
    check("停摆提示要带上失败原因与最后一次成功时间",
      stalledView.includes("boom") && /最后一次成功推进/.test(stalledView),
      "只说停了，不说为什么、也不说停了多久 —— 人无从判断严重程度");
    // 还有一种更隐蔽的停摆：周期【不抛异常，只是彻底不跑了】（定时器被清、某一拍卡死）。
    // 这时 consecutiveErrors 是 0、lastTickResult 还停在 "ran" —— 上面那两条断言全都不触发，
    // 屏幕上照写"已启用 · 每 60 秒推进一次（上一拍 ran）"。判据要拿【上一拍的时间】跟间隔比。
    const silent = structuredClone(stalled);
    silent.runtime.autonomousOrchestrator = {enabled: true, intervalMs: 60000, consecutiveErrors: 0,
      lastTickResult: "ran", lastTickAt: new Date(Date.now() - 42 * 60 * 1000).toISOString(),
      lastSuccessAt: new Date(Date.now() - 42 * 60 * 1000).toISOString()};
    const silentView = probe.renderMonitorWith(silent, admin, "p1").replace(/<!--[\s\S]*?-->/gu, "");
    const silentStart = silentView.indexOf("自治循环已经");
    const silentNotice = silentStart < 0 ? "" : silentView.slice(silentStart, silentView.indexOf("</div>", silentStart));
    check("静默停摆那条也要指出手动推一拍的出口（两条分支各写各的会漏掉一条）",
      Boolean(silentNotice) && silentNotice.includes("运行自治循环"),
      silentNotice.slice(0, 120) || "监控页上找不到静默停摆提示 —— 这条断言在空转");
    check("自治循环静默停摆（不报错、只是不跑了）也要说出来",
      /没有推进过/.test(silentView),
      "周期已经 42 分钟没动过，而它自称每 60 秒一拍 —— 监控页却仍写着「上一拍 ran」，"
      + "人要等到发现什么都没动才会怀疑");
    const healthy = structuredClone(stalled);
    healthy.runtime.autonomousOrchestrator = {enabled: true, intervalMs: 60000, consecutiveErrors: 0,
      lastTickResult: "ran", lastTickAt: new Date(Date.now() - 30 * 1000).toISOString(),
      lastSuccessAt: "2026-08-01T00:05:00Z"};
    const healthyView = probe.renderMonitorWith(healthy, admin, "p1").replace(/<!--[\s\S]*?-->/gu, "");
    check("正常时不得挂着停摆告警",
      !/没有任何东西在自行推进|没有推进过/.test(healthyView),
      "自治循环正常，监控页却仍挂着停摆告警 —— 常亮的告警等于没有告警");
  }

  // 关闭门会因为"卡住的执行方案"和"未被消费的人工指令"挡住任务组，而这两类【只有人能了结】。
  // 它们此前不在待办聚合里：人看到"0 待处理"，任务组却正等着他去终止一个方案、确认一条指令。
  // 判据落在【关闭门认定的阻塞状态】上，与 computeCloseBarrier 同口径。
  {
    const withBlockers = {
      schemaVersion: "runtime-state/v1", stateVersion: 1,
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "development", workItems: []}],
      executionTopologies: [{topologyId: "topo_stuck", taskGroupId: "tg1", workItemId: "w1", status: "blocked"},
        {topologyId: "topo_running", taskGroupId: "tg1", workItemId: "w2", status: "running"},
        {topologyId: "topo_done", taskGroupId: "tg1", workItemId: "w3", status: "merged"}],
      humanDirectives: [{directiveId: "hd_open", taskGroupId: "tg1", status: "queued"},
        {directiveId: "hd_done", taskGroupId: "tg1", status: "consumed"}],
      humanConfirmationRequests: [], permissionRequests: [], approvalRequests: [], findings: [],
      qualityGates: [], reviewPlans: [], reviewBundles: [], ruleSourceResolutions: [],
      systemUpgradeCandidates: [], sharedDefinitions: [], truncatedCollections: []
    };
    const panel = probe.renderPendingPanelWith(withBlockers, admin);
    check("卡住的执行方案要进待办",
      /待你终止的卡住执行方案/.test(panel),
      "关闭门因为一个卡住的执行方案挡着，而待办里一个字都没有 —— 人看到 0 待处理，任务组却关不掉");
    check("未被消费的人工指令要进待办",
      /待你确认已被消费的人工指令/.test(panel),
      "关闭门因为一条未消费的人工指令挡着，而待办里看不到它");
    // 判据必须落在【数字】上：面板不打印对象 id，按 id 找"有没有混进来"恒为真（第一版就是这样，
    // 把过滤条件整个删掉它照样绿）。夹具里只有 topo_stuck 与 hd_open 该算，合计 2 项。
    check("已了结的不得混进待办",
      /共 2 项/.test(panel),
      "已合并的方案或已消费的指令被算成了待办 —— 那个数字永远清不掉，人最后会学会无视它");
    const counts = probe.todoCountsWith(withBlockers, admin);
    check("红点口径与面板一致",
      (counts.monitor?.count || 0) >= 1 && (counts.directives?.count || 0) >= 1,
      "面板里列出来了，菜单红点却不算 —— 同一件事在同一屏上给出两个数字");
  }

  const scopeCapped = probe.renderPendingPanelWith(stateWith(["taskGroups"]), admin);
  check("可见范围本身没数全时也不得报准确数",
    scopeCapped.includes("共 2+ 项"),
    "taskGroups 被截断（超出上限的任务组下的待办一条都没算进来），汇总仍按准确数呈现");

  // 红点与面板必须同一口径，否则同一屏上出现两个数字，人不知道该信哪个。
  const badgeExact = probe.todoCountsWith(stateWith(null), admin);
  const badgeCapped = probe.todoCountsWith(stateWith(["humanConfirmationRequests"]), admin);
  check("红点数不全时同样带 +",
    badgeCapped.review?.capped === true && badgeExact.review?.capped === false,
    `菜单红点没有跟随面板改口径（准确=${JSON.stringify(badgeExact.review)} 截断=${JSON.stringify(badgeCapped.review)}）—— 面板写 2+、徽标写 2`);

  // 表格页脚的"共 N 条"同样取自被视图截过的数组；事件流则是客户端只留最近 300 条的滚动窗口。
  // 两者都会把一个被截出来的数字说成总数，而人正是据此判断"是不是就这些了"。
  const plain = probe.moreTextWith({}, 200, 20);
  check("没被截断时页脚仍报准确数",
    plain.includes("共 200 条"),
    `没有截断也把页脚总数说成了约数（${JSON.stringify(plain)}）`);
  const viewCapped = probe.moreTextWith({truncatedCollections: ["workSessions"]}, 200, 20, "workSessions");
  check("视图截断时页脚带 +",
    viewCapped.includes("共 200+ 条"),
    `集合被视图截断了，表格页脚仍把截断后的长度报成总数（${JSON.stringify(viewCapped)}）`);
  const rolled = probe.moreTextWith({}, 300, 120, true);
  check("事件流丢过旧事件时页脚带 +",
    rolled.includes("共 300+ 条"),
    `滚动窗口丢弃过旧事件，页脚仍说"共 300 条" —— 人会读成总共只发生过这些（${JSON.stringify(rolled)}）`);

  const noPerm = probe.renderPendingPanelWith(stateWith(null), {accountId: "acct_b", accountType: "user_account", permissions: []});
  check("无权处置的类别不进统计",
    noPerm.includes("当前没有需要你处置的项"),
    "把这个人无权处置的项也算进了待办 —— 红点永远清不掉，人点进去什么也做不了");
}

// 关闭任务组是最不可逆的一步（写定稿归属且只能关一次）。监控页按当前项目呈现，若关闭门禁没有
// 按项目过滤，人会在项目 A 的抬头下看到并点掉项目 B 的任务组。
function runCloseBarrierScopeCase() {
  const probe = loadConsole(el("div"));
  const admin = {accountId: "acct_a", accountType: "org_admin"};
  const monitorState = {
    taskGroups: [
      {id: "tg_a", projectId: "p_a", name: "甲组", status: "active"},
      {id: "tg_b", projectId: "p_b", name: "乙组", status: "active"}
    ],
    closeBarriers: [
      {taskGroupId: "tg_a", satisfied: true, blockingObjects: [], computedAt: "2026-08-02T00:00:00Z"},
      {taskGroupId: "tg_b", satisfied: true, blockingObjects: [], computedAt: "2026-08-02T00:00:00Z"}
    ],
    // 这一页整体以"当前项目"为抬头，页内每张表都必须按它过滤。逐张放入一条属于别的项目的记录：
    // 只要有一张漏了过滤，别的项目的运行时痕迹就会挂在本项目的抬头下。
    agentControlCommands: [
      {sequence: 1, nodeId: "n1", taskGroupId: "tg_a", commandType: "pause_dispatch", status: "acked", dispatchId: "d_own"},
      {sequence: 2, nodeId: "n1", taskGroupId: "tg_b", commandType: "pause_dispatch", status: "acked", dispatchId: "d_other"}
    ],
    modelSelectionDecisions: [
      {roleId: "r", taskGroupId: "tg_a", workItemId: "wi_own", selectedModel: {modelId: "m1"}, status: "active"},
      {roleId: "r", taskGroupId: "tg_b", workItemId: "wi_other", selectedModel: {modelId: "m1"}, status: "active"}
    ],
    sessionPlacementDecisions: [
      {taskGroupId: "tg_a", workItemId: "wi_own_p", placement: "local", status: "active"},
      {taskGroupId: "tg_b", workItemId: "wi_other_p", placement: "local", status: "active"}
    ],
    admissionDecisions: [
      {taskGroupId: "tg_a", workItemId: "wi_own_a", outcome: "admitted"},
      {taskGroupId: "tg_b", workItemId: "wi_other_a", outcome: "admitted"}
    ],
    agentRuntimeNodes: [], qualityGates: [], testResults: [], checkpoints: []
  };
  const html = probe.renderMonitorWith(monitorState, admin, "p_a");
  for (const [label, own, other] of [
    ["控制通道", "d_own", "d_other"],
    ["模型选择记录", "wi_own", "wi_other"],
    ["会话放置记录", "wi_own_p", "wi_other_p"],
    ["准入决策", "wi_own_a", "wi_other_a"]
  ]) {
    check(`${label}只列当前项目`,
      html.includes(own) && !html.includes(`>${other}<`),
      `${label}列出了别的项目的记录 —— 这一页以当前项目为抬头，人会把它读成本项目的运行痕迹`);
  }
  check("别的项目的关闭门禁不出现在本项目监控页",
    html.includes("甲组") && !html.includes("乙组"),
    "监控页列出了当前项目之外的任务组关闭门禁 —— 人会在错误的项目抬头下按掉别人的关闭按钮");
  check("别的项目的任务组不给关闭按钮",
    !html.includes('data-task="tg_b"'),
    "给出了关闭当前项目之外任务组的按钮 —— 关闭不可逆，且会写下定稿归属");
}

// 状态机执行模式可以被环境变量整个降级成"记一笔然后放行"，而被放行的非法转移只进
// transitionEvidence（任何视角都不下发）。控制台上必须看得出这条保证当前是开还是关。
// 有些表把整个集合原样铺开，没有"当前展示 N 条"的页脚 —— 视图截断在这些页上连痕迹都没有，
// 而人正是照着账号/授权名单判断"谁有权限"。少列一条就是漏掉一个人。
function runWholeListCapCase() {
  const admin = {accountId: "acct_a", accountType: "system_admin"};
  const base = {
    accounts: [{accountId: "acct_x", displayName: "某人", accountType: "user_account", status: "active", organizationId: "org_default"}],
    projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
    taskGroups: [{id: "tg1", name: "任务组", projectId: "p1", status: "development"}],
    accessGrants: [], agents: []
  };
  const fullRoot = el("div");
  loadConsole(fullRoot).renderFullPageWith({...base}, admin, "p1", "sys-overview");
  check("系统管理菜单不再暴露账号与授权混合入口",
    !String(fullRoot.innerHTML || "").includes('data-menu="sys-accounts"'),
    "系统侧栏仍暴露账号、授权、项目和 Agent 混合入口，边界会再次被打散");
  const projectRoot = el("div");
  loadConsole(projectRoot).renderFullPageWith({...base}, admin, "p1", "proj-members");
  const projectHtml = String(projectRoot.innerHTML || "");
  check("项目成员页提供任务组级授权入口",
    /任务组权限授权/u.test(projectHtml) && /data-form="grant-create"/u.test(projectHtml)
      && /task_group_owner/u.test(projectHtml) && /reviewer/u.test(projectHtml),
    "项目成员页没有任务组级授权入口，子账户只能拿项目角色，不能按任务组控制或审核");
}

// 项目成员授权的账号下拉此前列的是【全部账号】，而服务端对这条路是无条件按组织判的
//（cross_org_member_not_allowed —— 系统管理员也一样）。于是别的组织的人就摆在下拉里，
// 选中提交必然被拒：一个按不动的杠杆。系统账号页已不再承载项目成员授权表单，
// 所以这条必须钉在项目「成员权限」主入口上。
function runCrossOrgGrantSelectCase() {
  const admin = {accountId: "acct_a", accountType: "system_admin"};
  const state = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
    organizations: [{orgId: "org_default", name: "默认组织", status: "active"},
      {orgId: "org_other", name: "另一个组织", status: "active"}],
    projects: [{id: "p_default", name: "本组织项目", organizationId: "org_default", status: "active", members: []}],
    accounts: [
      {accountId: "acct_same", displayName: "同组织的人", organizationId: "org_default", accountType: "user_account", status: "active"},
      {accountId: "acct_other", displayName: "别组织的人", organizationId: "org_other", accountType: "user_account", status: "active"},
      // 归属为空：服务端按「默认组织」处理（`organizationId || DEFAULT_ORGANIZATION_ID`），
      // 界面必须用同一个口径，否则会把本可以授的人藏起来。
      {accountId: "acct_legacy", displayName: "没有归属的人", accountType: "user_account", status: "active"}],
    accessGrants: [], agents: [], agentRuntimeNodes: [], agentJoinTokens: [],
    taskGroups: [], truncatedCollections: []};
  const accountsRoot = el("div");
  const html = String(loadConsole(accountsRoot).renderProjectMembersWith(state, admin, "p_default", state.accounts) || "");
  // 只看【项目成员授权】那张表单：其它页面也可能有负责人/账号下拉，整页找会假绿。
  const formAt = html.indexOf(`data-form="project-member"`);
  const formHtml = formAt < 0 ? "" : html.slice(formAt, html.indexOf("</form>", formAt));
  // 别在这里 throw：整跑变异门时，另一条变异会把这两个入口整块摘掉，
  // 抛异常等于把【那条变异自己的预期断言】一起挡住 —— 实测就是这么报的
  //「失败了但不是因为预期断言」。用普通判据说清楚，让后面的检查照常跑完。
  if (!formHtml) {
    check("跨组织授权用例要能找到 project-member 表单（找不到就是本段在空转）", false,
      "这一页上没有渲染出项目成员授权表单");
    return;
  }
  const optionOf = (accountId) => (formHtml.match(new RegExp(`<option value="${accountId}"[^>]*>`, "u")) || [""])[0];
  check("别的组织的账号不许出现在项目成员授权的下拉里（后端必拒，选了也白选）",
    optionOf("acct_other") === "",
    `别组织那一项渲染成了：${optionOf("acct_other") || "（没找到这一项）"}`);
  check("同组织的账号仍要能选（上一条不能靠把所有人都藏起来通过）",
    optionOf("acct_same") !== "",
    `同组织那一项渲染成了：${optionOf("acct_same") || "（没找到这一项）"}`);
  check("归属为空的账号要按「默认组织」算，与服务端同一口径（否则本可以授的人被藏起来）",
    optionOf("acct_legacy") !== "",
    `没有归属那一项渲染成了：${optionOf("acct_legacy") || "（没找到这一项）"}`);
  // 一个可授权的人都没有时，表单看着完整、点下去必然失败 —— 要当场说清第一步是什么。
  const emptyRoot = el("div");
  // 第三个组织：它名下一个账号都没有 —— 这才是「表单看着完整、点下去必然失败」那一屏。
  const emptyHtml = String(loadConsole(emptyRoot).renderProjectMembersWith({...state,
    organizations: [...state.organizations, {orgId: "org_empty", name: "空组织", status: "active"}],
    projects: [{id: "p_empty", name: "空组织的项目", organizationId: "org_empty", status: "active", members: []}]},
    admin, "p_empty", state.accounts) || "").replace(/<[^>]+>/gu, " ");
  check("这个组织下一个可授权的账号都没有时要说清，而不是给一个空下拉",
    /还没有可授权的账号/u.test(emptyHtml) && /属于别的组织/u.test(emptyHtml)
      && /组织管理.+成员管理/u.test(emptyHtml) && !/上面的「邀请账号」/u.test(emptyHtml),
    `空的时候说的是：${(emptyHtml.match(/[^ ]*所属的组织[^。]*。/u) || ["（什么都没说）"])[0]}`);
  // 换项目那条路：处理器就两行（记下选的项目 + 重渲染），效果全在渲染函数里 —— 这里直接验效果。
  const switchedRoot = el("div");
  const switchedHtml = String(loadConsole(switchedRoot).renderProjectMembersWith({...state,
    projects: [...state.projects,
      {id: "p_other_org", name: "别组织的项目", organizationId: "org_other", status: "active", members: []}]},
    admin, "p_other_org", state.accounts) || "");
  const switchedAt = switchedHtml.indexOf(`data-form="project-member"`);
  const switchedForm = switchedAt < 0 ? "" : switchedHtml.slice(switchedAt, switchedHtml.indexOf("</form>", switchedAt));
  check("换到别组织的项目之后，下拉里换成那个组织的人",
    switchedForm.includes(`<option value="acct_other"`) && !switchedForm.includes(`<option value="acct_same"`),
    `切过去之后下拉里是：${(switchedForm.match(/<option value="acct[^"]*"/gu) || []).join("、") || "（一项都没有）"}`);

  // 组织「项目列表」仍保留集中项目成员授权入口；那里不是 scoped 当前项目输入框，
  // 而是靠 projectId 下拉切换，必须单独覆盖 memberGrantProjectId 这条状态线。
  const orgSwitchRoot = el("div");
  const orgSwitchProbe = loadConsole(orgSwitchRoot);
  orgSwitchProbe.setMemberGrantProjectId("p_other_org");
  const orgSwitchHtml = String(orgSwitchProbe.renderOrgProjectsWith({...state,
    projects: [...state.projects,
      {id: "p_other_org", name: "别组织的项目", organizationId: "org_other", status: "active", members: []}]},
    admin, "p_default", state.accounts) || "");
  const orgSwitchAt = orgSwitchHtml.indexOf(`data-form="project-member"`);
  const orgSwitchForm = orgSwitchAt < 0 ? "" : orgSwitchHtml.slice(orgSwitchAt, orgSwitchHtml.indexOf("</form>", orgSwitchAt));
  check("组织项目页切换授权项目后，下拉也要跟着换成目标项目组织的人",
    orgSwitchForm.includes(`<option value="acct_other"`) && !orgSwitchForm.includes(`<option value="acct_same"`),
    `组织项目页切过去之后下拉里是：${(orgSwitchForm.match(/<option value="acct[^"]*"/gu) || []).join("、") || "（一项都没有）"}`);

  // 界面这个默认组织常量与 core 那份必须是同一个值：不一致时，归属为空的账号会在
  // 一边算作「默认组织」、另一边算作别的组织 —— 屏幕能选的正是后端要拒的。
  const appConstant = /const DEFAULT_ORGANIZATION_ID = "([^"]+)";/u
    .exec(fs.readFileSync(path.join(root, "apps/control-plane-ui/public/modules/ui-config.js"), "utf8"));
  const coreConstant = /export const DEFAULT_ORGANIZATION_ID = "([^"]+)";/u
    .exec(fs.readFileSync(path.join(root, "apps/control-plane-ui/lib/control-plane-core.mjs"), "utf8"));
  check("界面与 core 的「默认组织」必须是同一个值",
    Boolean(appConstant && coreConstant) && appConstant[1] === coreConstant[1],
    `界面=${appConstant?.[1] ?? "（没找到）"} / core=${coreConstant?.[1] ?? "（没找到）"}`);
}

// 卡住的执行方案会永久挡住关闭门，而"人来取消"这条杠杆后端一直有、界面上却没有入口。
// 后端有杠杆而界面没有入口，等于这个杠杆不存在。
// 关闭门阻塞类型有 16 种，而"阻塞项人工处置"只处理其中 6 种。指引必须按类型说清去哪；
// 对系统自行清除的那几类，必须明说"不用你动手"——否则人会守着一个不该他管的红点。
function runBlockerGuideCase() {
  const probe = loadConsole(el("div"));
  // 这份清单原先是手写的 16 种 —— 而同一仓库的 contract-check 里就写着"手写表必然漂"
  // （那条说的是关闭门名那一侧，已经按权威来源核对了；对象类型这一侧当时还没有）。
  // core 新增一种阻塞类型时，手写清单不会跟着长，这条断言就会静默漏掉它。改成从 core 全量提取。
  const coreSource = fs.readFileSync(path.join(root, "apps/control-plane-ui/lib/control-plane-core.mjs"), "utf8");
  const covered = [...new Set([...coreSource.matchAll(/objectType:\s*"([A-Za-z]+)"/gu)].map((match) => match[1]))]
    // CloseBarrierGate 不走按类型的指引表，它按【门名】另有一张表（blockerGuide 先分这一支），
    // 而那张表的覆盖由 contract-check 按权威门目录核对。
    .filter((type) => type !== "CloseBarrierGate");
  if (covered.length < 12) throw new Error(`阻塞类型提取只拿到 ${covered.length} 种 —— 提取逻辑与 core 脱节，本条在空转`);
  const missing = covered.filter((type) => !probe.blockerGuide(type));
  check("每一种阻塞类型都说得出下一步",
    missing.length === 0,
    `这些阻塞类型没有任何处置指引：${missing.join("、")} —— 人看到红 chip 却不知道该去哪`);
  check("系统自行清除的类型要明说不用管",
    /无需你动手/.test(probe.blockerGuide("CommandEffect")) && /无需单独操作/.test(probe.blockerGuide("Lease")),
    "对系统会自行清除的阻塞没有明说不用人管 —— 人会守着一个他做不了任何事的红点");
  check("需要人处理的类型要指到具体页面",
    /人工审核/.test(probe.blockerGuide("HumanConfirmationRequest")) && /人工指令/.test(probe.blockerGuide("HumanDirective")),
    "把所有类型都指向同一个面板，而那个面板不处理它们 —— 人走过去是一片空白");
}

function runStuckTopologyLeverCase() {
  const probe = loadConsole(el("div"));
  const orchestrator = {accountId: "acct_o", accountType: "org_admin"};
  const withTopologies = (topologies) => ({
    // 这一页以"当前项目"为抬头，夹具就必须真的有那个项目 —— 原先只有任务组挂着 projectId，
    // 状态里一个项目都没有。那是个真实部署里不存在的形状（此前没人读这个字段，所以一直没露）。
    projects: [{id: "p_a", name: "甲项目", organizationId: "org_default", status: "active"}],
    taskGroups: [{id: "tg_a", projectId: "p_a", name: "甲组", status: "active"}],
    executionTopologies: topologies,
    closeBarriers: [], agentRuntimeNodes: [], qualityGates: [], testResults: [], checkpoints: []
  });
  const stuck = probe.renderMonitorWith(withTopologies([
    {topologyId: "topo_stuck", taskGroupId: "tg_a", workItemId: "wi_1", status: "integrating"}
  ]), orchestrator, "p_a");
  check("卡住的执行方案给得出终止入口",
    stuck.includes("topo_stuck") && stuck.includes('data-form="topology-cancel"'),
    "执行方案卡在 integrating（merge 走不通）却没有任何界面入口 —— 它会永久挡着关闭门，人只看到一个红 chip");
  check("并说明不终止的后果",
    /挡着关闭门/.test(stuck),
    "给了按钮却没说为什么要按 —— 人不知道不处理会怎样");
  const terminal = probe.renderMonitorWith(withTopologies([
    {topologyId: "topo_done", taskGroupId: "tg_a", workItemId: "wi_1", status: "merged"}
  ]), orchestrator, "p_a");
  check("已终态的方案不再给终止入口",
    !terminal.includes('data-form="topology-cancel"'),
    "已经 merged/cancelled 的方案还给终止按钮 —— 点下去只会撞 409，且让人以为它还阻塞着");
  const otherProject = probe.renderMonitorWith({
    ...withTopologies([{topologyId: "topo_other", taskGroupId: "tg_b", workItemId: "wi_1", status: "integrating"}]),
    taskGroups: [{id: "tg_a", projectId: "p_a", name: "甲组"}, {id: "tg_b", projectId: "p_b", name: "乙组"}]
  }, orchestrator, "p_a");
  check("别的项目的方案不出现在本项目",
    !otherProject.includes("topo_other"),
    "把别的项目的执行方案列进了本项目的阻塞处置 —— 会在错误的项目抬头下终止别人的方案");
}

// 「稳定前缀 Token 数」一直显示初始化时写死的 1800，从来没有生产者更新过它 —— 人看到的是常量，
// 却被当成测量结果（实测系统规则正文已 15000+ 字符，差 8 倍以上）。预算与实测必须分开显示，
// 且实测缺席时要明说"尚未测量"，不能拿预算值冒充。
// 编排周期设成 0 时后台什么都不推进：人提交的指令一直停在"待处理"，派发不会被领走，
// 关闭门不会重算 —— 而控制台上一切如常。与状态机执行模式同形，必须如实公布。
// 生产模式下登录页刻意不显示管理员账号（说出来等于把凭据的一半送出去），但那样一来
// 第一次上手的人拿着令牌面对"登录账号"输入框无从下手。不泄漏，但要告诉他去哪儿找。
// 带认领代次提交是 0.3.0 引入的契约。低于它的节点，其派发一旦被重认领就会卡住 ——
// 控制面本来就知道每个节点的运行时版本，就该在卡住【之前】把它摆出来。
function runOutdatedRuntimeVisibilityCase() {
  const probe = loadConsole(el("div"));
  const admin = {accountId: "acct_a", accountType: "org_admin"};
  const withNode = (node) => probe.renderMonitorWith({
    projects: [{id: "p_a", name: "甲项目", organizationId: "org_default", status: "active"}],
    taskGroups: [{id: "tg_a", projectId: "p_a", name: "甲组"}],
    agentRuntimeNodes: [node],
    closeBarriers: [], qualityGates: [], testResults: [], checkpoints: [], executionTopologies: []
  }, admin, "p_a");
  const old = withNode({nodeId: "n_old", nodeName: "旧节点", status: "online", admission: "full",
    runtimeVersion: "0.2.0", runtimeOutdated: true});
  check("运行时过旧要在卡住之前就标出来",
    /运行时版本过旧/.test(old) && old.includes("0.2.0"),
    "节点用的是不发认领代次的旧运行时，控制台却看不出来 —— 只有等派发被重认领卡住才会浮现");
  check("并说清该怎么办",
    /重新执行入网安装命令/.test(old),
    "标了过旧却不说怎么升级 —— 人看到一个红字，然后无从下手");
  const fresh = withNode({nodeId: "n_new", nodeName: "新节点", status: "online", admission: "full",
    runtimeVersion: "0.3.0", runtimeOutdated: false});
  check("版本达标的节点不打扰",
    !/运行时版本过旧/.test(fresh),
    "版本已达标却仍被标成过旧 —— 误报会让人不再相信这个提示");
}

function runFirstRunGuidanceCase() {
  const probe = loadConsole(el("div"));
  const prod = probe.renderLoginWith({bootstrapTokenConfigured: true, tokenHintsExposed: false});
  check("生产模式下不泄漏管理员账号",
    !prod.includes("系统管理员登录账号"),
    "公开登录页上显示了管理员账号 —— 等于把凭据的一半送出去");
  check("但要告诉人去哪儿找账号",
    prod.includes("npm run init"),
    "只说令牌已配置却不说登录账号从哪来 —— 第一次上手的人拿着令牌面对输入框无从下手");
  const dev = probe.renderLoginWith({bootstrapTokenConfigured: true, tokenHintsExposed: true, systemAdminLogin: "system.admin@local"});
  check("开发模式下直接给出账号",
    dev.includes("system.admin@local") && !dev.includes("npm run init"),
    "本机开发时既不显示账号也不给指引，等于两头落空");
}

function runOrchestratorVisibilityCase() {
  const probe = loadConsole(el("div"));
  const on = probe.renderSysSettingsWith({runtime: {transitionEnforcement: "strict", autonomousOrchestrator: {enabled: true, intervalMs: 60000}}});
  check("自治开启时说得出多久一次",
    on.includes("后台自治") && on.includes("60"),
    "运行参数里看不到后台自治的周期 —— 人无从判断系统到底在不在推进");
  const off = probe.renderSysSettingsWith({runtime: {transitionEnforcement: "strict", autonomousOrchestrator: {enabled: false, intervalMs: 0}}});
  check("自治关闭时必须显眼并说清后果",
    off.includes("warn-text") && /指令会一直停在待处理/.test(off),
    "后台自治被关掉却与正常状态长得一样 —— 人会一直等一个永远不会发生的推进");
}

function runStablePrefixMeasurementCase() {
  const probe = loadConsole(el("div"));
  const withMetrics = (metrics) => probe.renderSysSettingsWith({
    runtime: {transitionEnforcement: "strict"},
    taskGroups: [{id: "tg1", projectId: "p1", name: "甲组"}]
  }, {instructionMetrics: metrics});
  const notMeasured = withMetrics({stablePrefixTokens: 1800, deltaMessageTargetTokens: 420, cacheHitTarget: 0.7, envelopes: []});
  check("没有实测时明说尚未测量",
    notMeasured.includes("尚未测量"),
    "从未构建过内容包时，界面用配置的预算值冒充实测结果 —— 人会以为那就是真实下发体积");
  const measured = withMetrics({stablePrefixTokens: 1800, deltaMessageTargetTokens: 420, cacheHitTarget: 0.7, envelopes: [],
    stablePrefixMeasured: {chars: 15383, entryCount: 4, taskGroupId: "tg1", observedAt: "2026-08-03T00:00:00Z"}});
  check("有实测时显示真实体积",
    measured.includes("15383"),
    "有实测值却不显示 —— 这个数字正是回答「每次派发烧多少上下文」的那一个");
  check("实测显著超预算时要标出来",
    /warn-text/.test(measured) && measured.includes("已显著超出预算"),
    "实测远超预算却与正常值长得一样 —— 预算形同虚设");
}

function runTransitionModeVisibilityCase() {
  const probe = loadConsole(el("div"));
  const strictHtml = probe.renderSysSettingsWith({runtime: {transitionEnforcement: "strict"}});
  check("严格模式如实显示",
    strictHtml.includes("状态机执行") && strictHtml.includes("严格"),
    "运行参数里根本没有状态机执行模式这一项 —— 人无从判断这条保证是开是关");
  const warnHtml = probe.renderSysSettingsWith({runtime: {transitionEnforcement: "warn"}});
  check("宽松模式必须显眼地说明后果",
    warnHtml.includes("warn-text") && /流程不得跳步/.test(warnHtml),
    "宽松模式没有被标红、也没说清后果 —— 只写一个模式名，人不会意识到保证已经关了");
  check("两种模式长得不一样",
    strictHtml !== warnHtml,
    "严格与宽松渲染成了同一段文字 —— 人分不出来");
}

function runRuleLengthCase() {
  const probe = loadConsole(el("div"));
  let threw = null;
  try { probe.assertRuleFragmentLengths([{ruleId: "r1", title: "t", content: "x".repeat(8193)}]); }
  catch (error) { threw = error; }
  check("超长规则被拒而不是截断",
    threw !== null && /8193/.test(String(threw.message)),
    `超长规则没有被拒绝（${threw ? JSON.stringify(String(threw.message).slice(0, 80)) : "未抛错"}）—— 浏览器会静默丢弃超出部分，而人以为整条都存下了`);
  check("拒绝时说清超了多少",
    threw !== null && /8192/.test(String(threw.message)),
    "拒绝信息里没有说出上限，人不知道该精简到多少");
  let ok = null;
  try { probe.assertRuleFragmentLengths([{ruleId: "r2", title: "t", content: "x".repeat(8192)}]); }
  catch (error) { ok = error; }
  check("恰好到上限必须放行",
    ok === null,
    `正好等于上限的规则被拒（${ok && ok.message}）—— 判据把边界算错了一位`);
}

// "自检未通过：gateway" 只说了缺哪一项。原因在 agent 那一侧是知道的，被 catch {} 吞掉过一次，
// 现在一路带到控制面 —— 界面必须把它显示出来，否则人只能上那台机器翻日志。
// "建好了却从没被调用"是本仓反复出现的形状：后端有杠杆而界面没入口、判据写好却没接上、
// 提示函数留在文件里而渲染早就不走它了（errorBanner 就是 toast 化改造后遗留的死代码，
// 它渲染的错误横幅任何人都看不到）。这类东西读代码时看着一切都有，跑起来什么都没有。
// 这里只做一件事：每个顶层函数至少要被调用或引用一次。引用式用法（const esc = escapeHtml、
// .map(cell)）同样算数，所以判据是"标识符在定义之外还出现过"，而不是"有没有括号调用"。
// 防重提交此前靠一份手工维护的动作清单，清单必然漂移（实测 logout 就漏在外面，下一个漏掉的
// 可能是不可逆操作）。现在对每个动作按钮一律生效 —— 这条断言直接驱动真实的点击处理器，
// 断言请求进行中按钮确实被禁用，而不是去文件里找那份清单还在不在。
// 服务端答"不行"和"根本没答上话"，对人是两件完全不同的事：前者可以放心重试，后者操作可能
// 已经生效，而控制台每次请求都换一个幂等键 —— 重试等于再做一次。
async function runNoResponseGuidanceCase() {
  const probe = loadConsole(el("div"));
  probe.setFetch(() => Promise.reject(new TypeError("Failed to fetch")));
  let writeError = null;
  try { await probe.api("/api/projects", {method: "POST", body: "{}"}); }
  catch (error) { writeError = String(error?.message || error); }
  check("写操作没得到回应时说清可能已生效",
    /可能已经生效/.test(writeError || "") && /不要直接重试/.test(writeError || ""),
    `写请求没有收到响应时，界面没有说清"操作可能已经生效、不要直接重试"（${JSON.stringify(String(writeError).slice(0, 120))}）—— 人会再点一次，而那是新的幂等键`);
  check("不是把浏览器的英文原样抛给人",
    /^[^A-Za-z]/.test(String(writeError || "").trim()),
    `没有收到响应时抛出的是浏览器原文（${JSON.stringify(String(writeError).slice(0, 60))}）—— 中文控制台里的一句英文，且不说明后果`);

  let readError = null;
  try { await probe.api("/api/state"); }
  catch (error) { readError = String(error?.message || error); }
  check("只读请求不吓唬人",
    /加载失败/.test(readError || "") && !/可能已经生效/.test(readError || ""),
    `只读请求也提示"操作可能已经生效"（${JSON.stringify(String(readError).slice(0, 80))}）—— 读取不会改变任何东西，这种提示只会让人不敢刷新`);
}

async function runDoubleSubmitGuardCase() {
  const probe = loadConsole(el("div"));
  probe.stubNavigation(); // 断言的是防重，不是渲染；渲染与取数在这里不该被牵扯进来
  const button = el("button", {dataset: {action: "orchestrator-run"}});
  button.closest = (selector) => (selector === "[data-action]" ? button : null);
  button.classList = {add: () => {}, remove: () => {}};
  let disabledDuringRequest = null;
  let release = null;
  probe.setFetch(() => new Promise((resolve) => {
    disabledDuringRequest = button.disabled;
    release = () => resolve({ok: true, status: 200, json: async () => ({ok: true})});
  }));
  const clicked = probe.click({target: button, preventDefault: () => {}});
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (release) release();
  await clicked;
  check("动作进行中按钮被禁用",
    disabledDuringRequest === true,
    "动作按钮在请求进行中没有被禁用 —— 人连点两下就会发出两次不可逆操作");
  check("请求结束后按钮恢复可用",
    button.disabled === false,
    "请求结束后按钮仍然禁用 —— 人再也点不了它，只能刷新页面");
}

function runNoDeadHelperCase() {
  const source = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8");
  const names = [...source.matchAll(/^function ([A-Za-z0-9_]+)\(/gmu)].map((match) => match[1]);
  // 判据要排除属性访问（obj.fn），但展开语法 ...fn(config) 前面也是点 —— 不先去掉这三个点，
  // 一个真的在用的函数会被判成死代码。假红比漏报更坏：它会把人派去删掉有用的东西。
  const scanSource = source.replace(/\.\.\./gu, " ");
  if (names.length < 50) {
    check("扫得到函数定义", false, `只扫到 ${names.length} 个顶层函数 —— 判据与文件结构脱节，这条检查等于空转`);
    return;
  }
  const dead = names.filter((name) => {
    const uses = scanSource.match(new RegExp(`(^|[^A-Za-z0-9_.])${name}(?![A-Za-z0-9_])`, "gu")) || [];
    return uses.length <= 1; // 只有定义那一处
  });
  check("没有定义了却从没人用的界面函数",
    dead.length === 0,
    `这些函数定义了却没有任何地方调用或引用：${dead.join("、")} —— 读代码时看着功能都在，跑起来人什么也看不到`);
}

function runSelfCheckReasonCase() {
  const probe = loadConsole(el("div"));
  const shown = probe.selfCheckFailureHint({
    selfCheckMissing: ["gateway"],
    selfCheckFailures: [{checkId: "gateway", detail: "http://ctl.example — connect ECONNREFUSED 10.0.0.9:443"}]
  });
  check("说得出自检为什么没过",
    shown.includes("ECONNREFUSED"),
    `节点自检失败的原因没有显示出来（${JSON.stringify(shown.slice(0, 120))}）—— 人分不清是 DNS、TLS、401 还是服务端没起`);
  check("没有原因时不占地方",
    probe.selfCheckFailureHint({selfCheckMissing: ["gateway"]}) === ""
      && probe.selfCheckFailureHint({selfCheckMissing: ["gateway"], selfCheckFailures: [{checkId: "gateway", detail: "  "}]}) === "",
    "没有原因可说时仍然渲染了一块空内容");

  // 上面两条只证明判据本身对，证明不了它长在人看得见的那一行上 —— 把渲染里那次调用删掉，
  // 它们照样全绿。运行时节点表才是人真正看这件事的地方。
  const html = probe.renderMonitorWith({
    projects: [{id: "p_a", name: "甲项目", organizationId: "org_default", status: "active"}],
    taskGroups: [{id: "tg_a", projectId: "p_a", name: "甲组"}],
    agentRuntimeNodes: [{nodeId: "n1", nodeName: "节点一", status: "degraded", admission: "read_only",
      selfCheckMissing: ["gateway"],
      selfCheckFailures: [{checkId: "gateway", detail: "http://ctl.example — connect ECONNREFUSED 10.0.0.9:443"}]}],
    closeBarriers: [], qualityGates: [], testResults: [], checkpoints: [], executionTopologies: []
  }, {accountId: "acct_a", accountType: "org_admin"}, "p_a");
  check("原因长在运行时节点表上",
    html.includes("自检未通过") && html.includes("ECONNREFUSED"),
    "节点表上只写了自检未通过、没写原因 —— 判据写好了却没接到人看得见的地方");
}

function runClaimMissCase() {
  const probe = loadConsole(el("div"));
  const roleMiss = probe.claimMissHint({lastClaimMiss: {queuedCount: 2, reasons: [
    {dispatchId: "d1", reason: "role_not_allowed_on_node", requiredRole: "reviewer", nodeRoles: ["orchestrator"]}
  ]}});
  check("说得出是角色不匹配",
    roleMiss.includes("reviewer") || roleMiss.includes("评审"),
    `角色不匹配时没有说出需要哪个角色（${JSON.stringify(roleMiss.slice(0, 120))}）—— 人只能猜`);
  const modelMiss = probe.claimMissHint({lastClaimMiss: {queuedCount: 1, reasons: [
    {dispatchId: "d2", reason: "model_not_runnable_on_node", requiredModel: "anthropic", nodeProviders: ["openai"]}
  ]}});
  check("说得出是模型不可用",
    modelMiss.includes("anthropic") && modelMiss.includes("openai"),
    `模型不可用时没有说出需要什么、本机有什么（${JSON.stringify(modelMiss.slice(0, 120))}）`);
  check("两种原因不再长得一样",
    roleMiss !== modelMiss,
    "角色不匹配与模型不可用渲染成了同一段文字 —— 人还是分不出来");
  check("没有排队派发时不打扰",
    probe.claimMissHint({lastClaimMiss: {queuedCount: 0, reasons: []}}) === "" && probe.claimMissHint({}) === "",
    "没有排队派发时仍然报警 —— 一直在响的警告没人看");
}

// 【过期的入网令牌不得在列表里显示成「已签发」还带撤销按钮】。令牌过期只在兑换时才被标 expired，
// 没人兑换就永停在 issued —— 列表若按原始 status 显示，人以为它还在等 agent 来接，实际兑换必被拒。
// 按 serverNow 派生显示状态（与占位统计同口径）。realI18n：statusBadge 走真词表。
function runJoinTokenExpiryDisplayCase() {
  const root = el("div");
  const probe = loadConsole(root, {realI18n: true});
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 3600000).toISOString();
  const orgAdmin = {accountId: "u_org", accountType: "org_admin", displayName: "组织管理员", organizationId: "org_default"};
  probe.renderFullPageWith({schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
    projects: [{id: "p1", name: "项目一", organizationId: "org_default", status: "active", members: []}],
    taskGroups: [], agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [], findings: [],
    humanConfirmationRequests: [], humanDirectives: [], truncatedCollections: [],
    agentJoinTokens: [
      {joinTokenId: "jt_stale", projectId: "p1", allowedRoles: ["agent-runtime"], status: "issued", useCount: 0, maxUses: 1, expiresAt: past},
      {joinTokenId: "jt_live", projectId: "p1", allowedRoles: ["agent-runtime"], status: "issued", useCount: 0, maxUses: 1, expiresAt: future}
    ]}, orgAdmin, "p1", "org-agents");
  const html = String(root.innerHTML || "");
  if (!/jt_stale/u.test(html) || !/jt_live/u.test(html)) {
    check("令牌列表要渲染出来", false, "org-agents 没渲染出令牌行 —— 下面几条什么也没验");
    return;
  }
  // 过期那张：显示「已过期」、且没有撤销按钮（撤销一张已失效的令牌无意义、且暗示它还活着）。
  const staleRow = html.slice(html.indexOf("jt_stale"), html.indexOf("jt_live"));
  check("过期的 issued 令牌要显示「已过期」而不是「已签发」",
    /已过期/u.test(staleRow) && !/已签发/u.test(staleRow),
    `过期令牌仍显示为已签发（${staleRow.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").slice(0, 140)}）—— 人以为还能等 agent 来接`);
  check("过期令牌不给撤销按钮（它已失效）",
    !new RegExp('data-token-id="jt_stale"').test(html),
    "过期令牌还带撤销按钮 —— 暗示它还活着");
  // 未过期那张：显示「已签发」、带撤销按钮（正对照，防「一律显示已过期」蒙混）。
  const liveRow = html.slice(html.indexOf("jt_live"));
  check("未过期的 issued 令牌仍显示「已签发」并带撤销按钮",
    /已签发/u.test(liveRow) && new RegExp('data-token-id="jt_live"').test(html),
    `未过期令牌没正常显示（${liveRow.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").slice(0, 140)}）`);
}

function runHeartbeatHintCase() {
  const probe = loadConsole(el("div"));
  const fresh = probe.heartbeatStaleHint({status: "online", lastHeartbeatAt: new Date(Date.now() - 30 * 1000).toISOString()});
  check("刚心跳过不报警", fresh === "",
    `刚心跳过的节点被标成失联（${JSON.stringify(fresh)}）—— 一直在响的警告，人很快就不看了`);
  const stale = probe.heartbeatStaleHint({status: "online", lastHeartbeatAt: new Date(Date.now() - 42 * 60 * 1000).toISOString()});
  check("久未心跳要报警", /42/.test(stale) && stale.includes("没有心跳"),
    `一个 42 分钟没心跳的节点仍显示为健康（${JSON.stringify(stale)}）—— 控制台上看不出它已经没了`);
  const revoked = probe.heartbeatStaleHint({status: "revoked", lastHeartbeatAt: new Date(Date.now() - 42 * 60 * 1000).toISOString()});
  check("已终态的不重复报警", revoked === "",
    "已撤销的节点还在提示心跳陈旧 —— 它本来就不该再有心跳");
  // 陈旧时长要分级显示，不堆分钟：真实运行态里读到过「已 11173 分钟没有心跳」——超过一小时就该
  // 按小时/天说，否则运维得对着一个四五位数的分钟数自己换算有多久。
  const staleHours = probe.heartbeatStaleHint({status: "online", lastHeartbeatAt: new Date(Date.now() - 185 * 60 * 1000).toISOString()});
  check("以小时计的心跳陈旧要按小时说、不堆分钟", staleHours.includes("小时") && !/\d+ 分钟/u.test(staleHours),
    `一个 3 小时没心跳的节点仍以分钟堆着显示（${JSON.stringify(staleHours)}）—— 运维得自己把「185 分钟」换算成几个钟头`);
  const staleDays = probe.heartbeatStaleHint({status: "online", lastHeartbeatAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()});
  check("以天计的心跳陈旧要按天说", staleDays.includes("天") && !/\d+ 分钟/u.test(staleDays),
    `一个 3 天没心跳的节点没有按天显示（${JSON.stringify(staleDays)}）—— 「4320 分钟」这种数运维读不出是几天`);

  // 心跳超过服务端判死阈值时，同一行上的「在线」是假的：status 只有在扫描跑过之后才翻成 offline，
  // 而扫描挂在编排拍上。真实运行态上读到过同一行【在线 + 已 175 分钟没有心跳】并排。
  // 阈值必须取服务端下发的那个（runtime.nodeHeartbeatTimeoutMs），界面自己再写死一个就成了第二个真相源。
  {
    const nodeState = {
      schemaVersion: "runtime-state/v1", stateVersion: 1,
      runtime: {nodeHeartbeatTimeoutMs: 15 * 60 * 1000},
      projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "development", workItems: []}],
      agentRuntimeNodes: [{schemaVersion: "agent-runtime-node/v1", nodeId: "node_zombie", nodeName: "僵尸节点",
        status: "online", admission: "full", projectIds: ["p1"],
        lastHeartbeatAt: new Date(Date.now() - 175 * 60 * 1000).toISOString()}],
      agentDispatches: [], workSessions: [], humanConfirmationRequests: [], humanDirectives: [],
      executionTopologies: [], closeBarriers: [], qualityGates: [], findings: [],
      permissionRequests: [], approvalRequests: [], truncatedCollections: []
    };
    // 这个函数里没有 renderAs（它在另一个块的作用域里），照它的做法就地渲染一次。
    // realI18n 必须开：下面判的「心跳超时」是词表给的，桩成恒等函数时拿到的是英文键。
    const nodeRoot = el("div");
    loadConsole(nodeRoot, {realI18n: true}).renderFullPageWith(nodeState,
      {accountId: "u1", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"},
      "p1", "monitor");
    const nodeText = String(nodeRoot.innerHTML || "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
    if (!/僵尸节点/u.test(nodeText)) {
      check("心跳超时的节点行要渲染出来", false, "这一屏没渲染出运行时节点表 —— 下面几条什么也没验");
    } else {
      const row = nodeText.slice(nodeText.indexOf("僵尸节点"), nodeText.indexOf("僵尸节点") + 260);
      check("心跳早就超时的节点，行上不许还写着「在线」",
        /心跳超时/u.test(row) && !/(^|[^未])在线(?![^的]*的)/u.test(row.replace(/记录上还写着「[^」]*」/u, "")),
        `同一行里「在线」和「已 175 分钟没有心跳」并排（${row.slice(0, 120)}）—— `
          + "status 只有扫描跑过才翻成 offline，而扫描挂在编排拍上，拍不跑它能一直写着在线");
      check("要说清那个「在线」是哪来的",
        /记录上还写着/u.test(row) && /下一次编排拍/u.test(nodeText),
        "只把字换掉、不说它为什么还是旧的，人会以为控制台和服务端各说各话");
    }
  }
}

// 规则编辑器每一行都用同样的 name。回填若按 name 找元素（querySelector 永远取第一个），
// N 行的内容会全部写进第一行 —— 第一行变成最后一行的内容，还被标成"未保存"，人再点保存就把它存下去。
function runMultiRowRestoreCase() {
  const buildRuleForm = () => el("form", {dataset: {form: "project-rules", project: "prj_x", category: "business"}}, [
    el("input", {name: "ruleTitle", value: ""}),
    el("textarea", {name: "ruleContent", value: ""}),
    el("input", {name: "ruleTitle", value: ""}),
    el("textarea", {name: "ruleContent", value: ""}),
    el("input", {name: "ruleTitle", value: ""}),
    el("textarea", {name: "ruleContent", value: ""})
  ]);
  const submitted = buildRuleForm();
  const titles = ["第一条规则", "第二条规则", "第三条规则"];
  const bodies = ["正文一", "正文二", "正文三"];
  submitted.querySelectorAll('[name="ruleTitle"]').forEach((node, index) => { node.value = titles[index]; });
  submitted.querySelectorAll('[name="ruleContent"]').forEach((node, index) => { node.value = bodies[index]; });

  const rerendered = buildRuleForm();
  const probe = loadConsole(el("div", {}, [rerendered]));
  probe.setFormTouched(false);
  probe.setPending(probe.snapshotFormValues(submitted));
  probe.restorePendingForm();

  const restoredTitles = rerendered.querySelectorAll('[name="ruleTitle"]').map((node) => node.value);
  const restoredBodies = rerendered.querySelectorAll('[name="ruleContent"]').map((node) => node.value);
  check("多行表单逐行回填",
    JSON.stringify(restoredTitles) === JSON.stringify(titles) && JSON.stringify(restoredBodies) === JSON.stringify(bodies),
    `同名多行的回填串行了（标题 ${JSON.stringify(restoredTitles)}，正文 ${JSON.stringify(restoredBodies)}）—— 第一行会变成最后一行的内容，而人再点一次保存就把它存下去`);
}

runFormRestoreCase();
runMultiRowRestoreCase();
runHeartbeatHintCase();
runJoinTokenExpiryDisplayCase();
runClaimMissCase();
runRuleLengthCase();
runEvidenceRefsCase();
runReviewAxisCase();
runPendingTruncationCase();
runCloseBarrierScopeCase();
runTransitionModeVisibilityCase();
runStablePrefixMeasurementCase();
runOrchestratorVisibilityCase();
runFirstRunGuidanceCase();
runOutdatedRuntimeVisibilityCase();
// 工作项「执行角色」下拉是界面写死的 7 个，而后端按 core 的 REGISTERED_OWNER_ROLES（22 个）判。
// 两份同一件事的清单，中间没有任何东西钉着 —— 这类必漂。两向都要核：
// 界面列了 core 不认的 = 选中必被拒的死杠杆；core 认而界面不列的 = 界面够不着的角色。
// 后者多数是有意的（服务角色不该派活给人指派），但必须【逐个写明】，不能靠"大概是有意的"。
const OWNER_ROLES_NOT_OFFERED_IN_CONSOLE = {
  "decision-center": "控制面自身的决策中枢，不是人指派给工作项的执行角色",
  "scheduler": "控制面自身的调度组件",
  "work-session": "会话这个概念本身，不是执行角色",
  "rule-steward": "规则治理由「系统管理」→「系统设置」的规则源与叠加来做，不走工作项派活",
  "command-bus": "控制面内部服务",
  "permission-gateway": "控制面内部服务",
  "policy-engine": "控制面内部服务",
  "mcp-proxy": "控制面内部服务",
  "room-broker": "控制面内部服务",
  "model-registry": "控制面内部服务",
  "skill-registry": "控制面内部服务",
  "identity-service": "控制面内部服务",
  "ui-console-service": "控制面内部服务（种子数据里有工作项挂着它，但那是自举，不是人该选的）",
  "repository-router": "控制面内部服务",
  "instruction-optimizer": "控制面内部服务"
};
function runOwnerRoleChoiceCase() {
  const uiConfigText = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/modules/ui-config.js"), "utf8");
  const catalogText = fs.readFileSync(path.join(root, "apps/control-plane-ui/lib/model-catalog.mjs"), "utf8");
  const listOf = (text, pattern) => {
    const hit = pattern.exec(text);
    return hit ? [...hit[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]) : [];
  };
  const offered = listOf(uiConfigText, /const WORK_ITEM_OWNER_ROLE_CHOICES = \[([^\]]*)\];/u);
  const registered = listOf(catalogText, /export const REGISTERED_OWNER_ROLES = \[([\s\S]*?)\];/u);
  check("两份执行角色清单都要真的提取到（提取失配的话下面两条在空转）",
    offered.length >= 5 && registered.length >= 15,
    `界面提到 ${offered.length} 个、core 提到 ${registered.length} 个`);
  const notRegistered = offered.filter((role) => !registered.includes(role));
  check("界面列出的执行角色必须都是后端认的（否则选中提交必被拒）",
    notRegistered.length === 0,
    `这些角色下拉里有、后端不认：${notRegistered.join("、")}`);
  const unexplained = registered.filter((role) =>
    !offered.includes(role) && !(role in OWNER_ROLES_NOT_OFFERED_IN_CONSOLE));
  check("后端认而界面不列的角色，每一个都要写明为什么不列",
    unexplained.length === 0,
    `这些角色人在界面上够不着，登记册里也没说为什么：${unexplained.join("、")}`);
  const stale = Object.keys(OWNER_ROLES_NOT_OFFERED_IN_CONSOLE)
    .filter((role) => !registered.includes(role) || offered.includes(role));
  check("登记册不许留过期条目（过期的登记会掩护掉下一个）",
    stale.length === 0,
    `这些登记已经不成立了：${stale.join("、")}`);
}
runOwnerRoleChoiceCase();

runWholeListCapCase();
// 节点为什么拒了一条控制命令，此前写进 command.ackResult 就再没人读过
//（全仓只有网关那一处写、零处读）—— 控制通道表里只有一个「已拒绝」，人无处可查。
// 这是「记了却没人读」与「失败 / -」的合流：字段本来就随视图下发了，缺的只是那一列。
function runControlCommandReasonCase() {
  const admin = {accountId: "acct_a", accountType: "system_admin", organizationId: "org_default"};
  const state = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
    organizations: [{orgId: "org_default", name: "默认组织", status: "active"}],
    projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
    taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "active", workItems: [], roles: [], blockers: []}],
    agentControlCommands: [{commandId: "cmd_1", sequence: 1, nodeId: "node_1", taskGroupId: "tg1",
      commandType: "pause_dispatch", status: "rejected", dispatchId: "adp_1",
      ackResult: {reason: "agent_control_command_unsupported"},
      createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:01.000Z"}],
    agentRuntimeNodes: [], agentDispatches: [], workSessions: [], agentExecutionEvents: [],
    workerLanes: [], modelSelectionDecisions: [], sessionPlacementDecisions: [],
    accounts: [], accessGrants: [], agents: [], truncatedCollections: [], fleet: {online: 1, total: 1}};
  const monitorRoot = el("div");
  loadConsole(monitorRoot, {realI18n: true}).renderFullPageWith(state, admin, "p1", "monitor");
  const text = String(monitorRoot.innerHTML || "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
  check("控制命令被拒时要说出节点给的原因（不能只留一个「已拒绝」）",
    /认不出这条控制命令/u.test(text),
    `控制通道那一行显示的是：${(text.match(/pause_dispatch[^。]{0,80}/u) || ["（没渲染出这一行）"])[0]}`);
  check("原因要查中文词表，不能把码原样摆出来",
    !/agent_control_command_unsupported/u.test(text),
    "屏幕上出现了英文原因码 —— 它没经过 explainCoded，或者词表里没有这一条");
}
// 「已替代」是终态，人接着要问的就是为什么。supersededReason 三处在写、全仓零处读 ——
// 与控制命令的 ackResult 同一形状。这两条一起证明：字段在记录里，缺的只是那一眼。
function runSupersededReasonCase() {
  const admin = {accountId: "acct_a", accountType: "system_admin", organizationId: "org_default"};
  const state = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
    organizations: [{orgId: "org_default", name: "默认组织", status: "active"}],
    projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: [],
      progress: {percent: 10, phase: "intake", health: "ok"}}],
    taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "active", workItems: [], roles: [], blockers: []}],
    repositoryOutputs: [{targetId: "rot_1", projectId: "p1", taskGroupId: "tg1", repositoryId: "repo_main",
      branch: "main", status: "superseded", supersededReason: "lease_expired", pathAllowlist: ["docs/**"]}],
    agentDispatches: [], workSessions: [], agentExecutionEvents: [], humanConfirmationRequests: [],
    accounts: [], accessGrants: [], agents: [], findings: [], closeBarriers: [], qualityGates: [],
    truncatedCollections: [], fleet: {online: 1, total: 1}};
  const overviewRoot = el("div");
  loadConsole(overviewRoot, {realI18n: true}).renderFullPageWith(state, admin, "p1", "proj-overview");
  const text = String(overviewRoot.innerHTML || "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
  check("产出目标被顶替时要说出为什么（不能只留一个「已替代」）",
    /租约过期/u.test(text),
    `仓库产出那一行显示的是：${(text.match(/repo_main[^。]{0,60}/u) || ["（没渲染出这一行）"])[0]}`);
}
// 被人重开过的工作项、方案被人拍过板的工作项，屏幕上与从没卡过的长得一模一样 ——
// 答案一直写在记录里（humanDecisionRef / planFinalizationRef 是 core 有意写的【溯源引用】），
// 全仓零处读。引用指向的记录被集合上限顶掉时，要说「查不到那条记录」，不能当成没有过这件事。
function runHumanTraceCase() {
  const admin = {accountId: "acct_a", accountType: "system_admin", organizationId: "org_default"};
  const workItem = {id: "w1", title: "被重开过的单元", status: "ready", ownerRole: "orchestrator",
    humanDecisionRef: "hd_1", planFinalizationRef: "hcr_1", requirements: []};
  const taskGroup = {id: "tg1", projectId: "p1", name: "任务组", status: "active",
    workItems: [workItem], roles: [], blockers: []};
  const base = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
    organizations: [{orgId: "org_default", name: "默认组织", status: "active"}],
    projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
    taskGroups: [taskGroup],
    humanDirectives: [{directiveId: "hd_1", taskGroupId: "tg1", directiveType: "resolve_decision",
      instruction: "重开", status: "applied", issuedBy: "ops@local", appliedActions: [],
      createdAt: "2026-08-20T01:02:03.000Z"}],
    humanConfirmationRequests: [{requestId: "hcr_1", taskGroupId: "tg1", workItemId: "w1",
      status: "answered", question: "选方案", options: [],
      decision: {selectedOptionId: "a", decidedBy: "lead@local", decidedAt: "2026-08-21T04:05:06.000Z"},
      createdAt: "2026-08-21T00:00:00.000Z"}],
    agentDispatches: [], workSessions: [], agentExecutionEvents: [], findings: [], closeBarriers: [],
    qualityGates: [], accounts: [], accessGrants: [], agents: [], truncatedCollections: [],
    fleet: {online: 1, total: 1}};
  const detailOf = (nextState) => String(loadConsole(el("div"), {realI18n: true}).renderTaskGroupDetail(
    {taskGroupId: "tg1", loadFailed: false, progress: {workItems: [workItem]}, config: null,
      configVersion: null, roomMessages: [], roomMessageTotal: 0, roomMessagesTruncated: false},
    taskGroup, nextState)).replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
  // 【显示人名，不是账号 id】。溯源那两句是给人看的：`acct_ops` 不是人，
  // 而 accountName() 连服务端下发的 id→名字目录一起兜（tasks 视图不带完整 accounts 集合）。
  const withNames = {...base, accounts: [
    {accountId: "ops@local", displayName: "运维小张", accountType: "user_account", status: "active"},
    {accountId: "lead@local", displayName: "评审组长", accountType: "user_account", status: "active"}]};
  const named = detailOf(withNames);
  check("溯源里要显示人名而不是账号 id",
    /由人工指令重开：运维小张/u.test(named) && /方案已由人定稿：评审组长/u.test(named),
    `带上账号之后显示的是：${(named.match(/由人工指令重开：[^·]*/u) || ["（没渲染出这一行）"])[0]}`);

  const resolved = detailOf(base);
  check("被人重开过的工作项要说出是谁在什么时候重开的",
    /由人工指令重开：ops@local/u.test(resolved),
    `工作项那一行显示的是：${(resolved.match(/执行角色[^执]{0,120}/u) || ["（没渲染出这一行）"])[0]}`);
  check("方案被人定稿过的工作项要说出是谁拍的板",
    /方案已由人定稿：lead@local/u.test(resolved),
    `工作项那一行显示的是：${(resolved.match(/执行角色[^执]{0,160}/u) || ["（没渲染出这一行）"])[0]}`);
  // 引用还在、记录被容量顶掉了：不能因为查不到就当成没发生过。
  const dropped = detailOf({...base, humanDirectives: [], humanConfirmationRequests: []});
  check("溯源引用查不到对应记录时要说「查不到」，不能当成没有过这件事",
    /已不在当前列表里/u.test(dropped) && /由人工指令重开/u.test(dropped),
    `记录被顶掉之后显示的是：${(dropped.match(/执行角色[^执]{0,160}/u) || ["（没渲染出这一行）"])[0]}`);
}
// 存储层的容量淘汰一直是哑的：分片裁掉记录不记数、不下发，界面把裁剪后的长度当总数报给人
//（「共 5000 条派发」而实际发生过 12000）。它与视图截断是两件事 ——
// 视图截断是「这次没加载全，记录还在」，容量淘汰是「已经没了」，人的下一步动作完全不同。
function runStorageDropDisclosureCase() {
  const admin = {accountId: "acct_a", accountType: "system_admin", organizationId: "org_default"};
  const base = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
    organizations: [{orgId: "org_default", name: "默认组织", status: "active"}],
    projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
    taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "active", workItems: [], roles: [], blockers: []}],
    agentDispatches: [], workSessions: [], agentExecutionEvents: [], accounts: [], accessGrants: [],
    agents: [], findings: [], closeBarriers: [], qualityGates: [], humanConfirmationRequests: [],
    truncatedCollections: [], fleet: {online: 1, total: 1}};
  const screen = (extra) => {
    const root = el("div");
    loadConsole(root, {realI18n: true}).renderFullPageWith({...base, ...extra}, admin, "p1", "monitor");
    return String(root.innerHTML || "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
  };
  const quiet = screen({});
  check("没有淘汰过时不许多挂一句（误报会让人不再相信这个提示）",
    !/已被容量上限丢弃/u.test(quiet),
    "什么都没淘汰也报了「已被容量上限丢弃」");
  const dropped = screen({storageDroppedCounts: {agentDispatches: 1200}});
  check("容量淘汰过的记录要说出来，并说清是「没了」而不是「没加载」",
    /已被容量上限丢弃/u.test(dropped) && /1200/u.test(dropped) && !/只加载了【最近的】若干条/u.test(dropped),
    `淘汰时说的是：${(dropped.match(/这些历史记录[^。]*。/u) || ["（什么都没说）"])[0]}`);
  check("淘汰过的集合，屏幕上的数字要带「+」（它是剩下的，不是一共发生过的）",
    /共 \d+\+ 条|\d+\+/u.test(dropped) || /不是「一共发生过的」/u.test(dropped),
    "数字没有任何「这个数偏小」的痕迹");
  // 两种信号要分开：视图截断那句不能被容量淘汰这句顶掉，反之亦然。
  const both = screen({truncatedCollections: ["accounts"], storageDroppedCounts: {agentDispatches: 5}});
  check("视图截断与容量淘汰同时发生时，两句话都要在",
    /只加载了【最近的】若干条/u.test(both) && /已被容量上限丢弃/u.test(both),
    `同时发生时屏幕上只说了：${(both.match(/这[几些][^。]*。/u) || ["（什么都没说）"])[0]}`);
}
runStorageDropDisclosureCase();

// 批准一条授权请求，人要同时看清「给谁、什么权限、在什么资源上」。
// 「在什么资源上」此前补过；「给谁」一直显示的是 acct_xxx 这样的账号 id —— id 不是人。
function runPermissionCardNamesTheSubjectCase() {
  const admin = {accountId: "acct_a", accountType: "system_admin", organizationId: "org_default",
    permissions: ["project:grant", "task_group:review"]};
  const state = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
    organizations: [{orgId: "org_default", name: "默认组织", status: "active"}],
    projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active",
      members: [{accountId: "acct_a", role: "project_owner"}]}],
    taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "active", workItems: [], roles: [], blockers: []}],
    accounts: [{accountId: "acct_bob", displayName: "外包小李", accountType: "user_account", status: "active"}],
    permissionRequests: [{requestId: "pr_1", taskGroupId: "tg1", subjectId: "acct_bob",
      permission: "github_push", status: "pending_approval",
      resource: {resourceType: "external_capability", resourceId: "repo:x"},
      reason: "执行到「before_git_push」这一步被权限挡住", createdAt: "2026-08-23T00:00:00.000Z"}],
    approvalRequests: [], findings: [], humanConfirmationRequests: [], accessGrants: [], agents: [],
    agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [], truncatedCollections: []};
  const root = el("div");
  loadConsole(root, {realI18n: true}).renderFullPageWith(state, admin, "p1", "review");
  const text = String(root.innerHTML || "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
  check("授权请求卡上「主体」要显示人名，不是账号 id（批准的是「给谁」）",
    /主体：外包小李/u.test(text),
    `卡片上显示的是：${(text.match(/主体：[^ ]*/u) || ["（没渲染出这张卡）"])[0]}`);
}
runPermissionCardNamesTheSubjectCase();

runHumanTraceCase();

runSupersededReasonCase();

runControlCommandReasonCase();

runCrossOrgGrantSelectCase();
runStuckTopologyLeverCase();
runBlockerGuideCase();
runSelfCheckReasonCase();
await runNoResponseGuidanceCase();
await runDoubleSubmitGuardCase();
runNoDeadHelperCase();
runPlanFinalizationNoticeCase();
runWorkItemOrderCase();
runRuleTextareaAutoGrowCase();
runWorkItemDispatchHistoryCase();
runWorkflowGuideCase();
runWorkItemResultCase();
runDirectivesEmptyExitCase();
runRoomVisibilityCase();
runDecisionSelectCase();
await runErrorGuidanceCase();
runNoVisibleProjectCase();
await runSelfRowHasNoActionsCase();
await runAuditChainBreakNoticeCase();
await runArchiveFaultNoticeCase();
await runFailingRequestIsNamedCase();
await runCodedApiErrorCase();

// 控制台不得再走 view=full。
//
// full 视图【不切片】：实测 1000 个单元时它返回 16.9MB、单次请求同步占用服务端主线程 149ms，
// 而且随部署规模无界增长（组织概览页原先就取它，只因为没有哪个视图带 organizations）。
// 受限视图同样规模只有 1.2MB / 59ms。这类退化没有任何功能测试会发现：页面显示完全正确，
// 只是每开一次就让服务端停顿一次，规模越大停得越久。
// 判据落在【控制台的取数调用】上，而不是某个页面名 —— 换个页面犯同样的错照样会被抓住。
{
  const appSource = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8");
  const fetched = [...appSource.matchAll(/fetchState\("([a-z]+)"\)/gu)].map((match) => match[1]);
  if (fetched.length < 5) {
    failures.push(`视图规模: 只解析到 ${fetched.length} 处 fetchState 调用 —— 提取逻辑与代码脱节，本条在空转`);
  }
  const unbounded = [...new Set(fetched)].filter((view) => view === "full");
  if (unbounded.length) {
    failures.push("视图规模: 控制台仍有页面取 view=full —— 该视图不切片，载荷与序列化耗时随部署规模无界增长；"
      + "请为这一页新增一个只含它真正要用的集合的视图（见 server.mjs 的 viewFields）");
  }
}

// 人点"确认定稿"必须真的定稿。
//
// 服务端对【核心决策】的默认动作是 revise（AI 提案 → 人提意见 → AI 再分析），
// 只有显式 action:"finalize" 才会落定稿锁。也就是说：控制台一旦漏传 action，
// 人点了"确认定稿"、看到成功提示、页面刷新，而那张卡只是轮次 +1 仍然待办 ——
// 什么都没定稿，且界面上没有任何地方说得出这件事。这一类"看起来做了其实没做"
// 不会有任何功能测试报错，所以判据要落在【提交出去的报文】上。
{
  const probe = loadConsole(el("div"));
  const submitSource = probe.handlerSource("submit");
  const at = submitSource.indexOf("/decide");
  // 判据要落在【真正被提交出去的那个对象字面量】上，不能取一段字符窗口：
  // action 这个词在附近到处都是（变量声明、注释），窗口一取就永远为真 ——
  // 实测把 action 从报文里删掉，按窗口判的版本照样是绿的。
  const payloadStart = at < 0 ? -1 : submitSource.indexOf("JSON.stringify({", at);
  let body = "";
  if (payloadStart >= 0) {
    let index = submitSource.indexOf("{", payloadStart + "JSON.stringify".length);
    const start = index;
    let depth = 0;
    do {
      if (submitSource[index] === "{") depth += 1;
      else if (submitSource[index] === "}") depth -= 1;
      index += 1;
    } while (index < submitSource.length && depth > 0);
    body = submitSource.slice(start, index);
  }
  if (at < 0 || !body) {
    failures.push("定稿报文: 找不到人工确认的 decide 提交 —— 提取逻辑与代码脱节，本条在空转");
  } else {
    if (!/\baction\b/.test(body)) {
      failures.push("定稿报文: 控制台提交人工确认决定时没有带上 action —— 服务端对核心决策默认按 revise 处理，"
        + "人点了'确认定稿'会看到成功提示，而那张卡只是轮次 +1、仍然待办，什么都没定稿");
    }
    // 同样按语法结构取：只看 action 是怎么算出来的那一条语句，不看它前后一大片
    // （"finalize" 与 data.action 在附近别处都出现，按窗口判会永远为真）。
    const declAt = submitSource.lastIndexOf("const action =", at);
    const declaration = declAt < 0 ? "" : submitSource.slice(declAt, submitSource.indexOf(";", declAt) + 1);
    if (!declaration.includes("data.action") || !/"revise"[\s\S]*"reject"/.test(declaration)) {
      failures.push("定稿报文: action 必须来自被点击的那个按钮（revise / finalize / reject），"
        + "写死一个值等于把三个按钮做成同一个动作");
    }
    if (!/expectedRound/.test(body)) {
      failures.push("定稿报文: 提交时必须带 expectedRound —— 少了它，AI 在你看这一页之后修订过方案，"
        + "你的定稿会落在一个你没看过的版本上");
    }
  }
}

// 任务组页是项目负责人盯单元的地方：单元交给执行方之后停着不动时，他在这一页等。
// "没有任何在线 agent"此前只在监控页说 —— 他得先想到去那一页看，才知道自己在等一件
// 不会发生的事。同一条规矩：提示要出现在人所在的位置。
{
  const account = {accountId: "u1", email: "a@b.c", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"};
  const withCells = (status, fleet) => ({
    schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
    organizations: [{orgId: "org_default", name: "组织", status: "active"}],
    projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
    taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "development",
      workItems: [{id: "w1", title: "单元", status, progress: 30, ownerRole: "agent-runtime"}]}],
    agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [], findings: [],
    humanConfirmationRequests: [], humanDirectives: [], truncatedCollections: [], fleet
  });
  const probe = loadConsole(el("div"));
  const stalled = probe.renderTaskGroupsWith(withCells("assigned", {online: 0, total: 2}), account, "p1", null, {});
  check("单元已交给执行方而没有在线 agent 时，要在任务组页上说出来",
    /没有任何在线的 agent 节点/.test(stalled),
    "进度条不会再动，而这一页一个字都不说 —— 人会一直等，并且会以为是 agent 在慢慢做");
  check("要说清它们不会有进展、以及去哪儿看",
    /不会有任何进展/.test(stalled)
      && /AI 智能体/.test(stalled)
      && /刷新自检/.test(stalled)
      && /恢复目标 agent 主机\/进程心跳/.test(stalled)
      && !/项目设置」→「智能体接入/.test(stalled)
      && !/接入或恢复节点/.test(stalled)
      && /「项目管理」|联系项目管理员/u.test(stalled),
    "只说没节点，不说这对他意味着什么、下一步做什么");
  const neverRegistered = probe.renderTaskGroupsWith(withCells("assigned", {online: 0, total: 0}), account, "p1", null, {});
  check("一个 agent 都没注册时，任务组页出口要直接指向项目注册脚本",
    /注册 agent/.test(neverRegistered)
      && /加入令牌/.test(neverRegistered)
      && !/接入或恢复节点/.test(neverRegistered),
    "单元已交出去但项目没有节点时还说恢复节点，项目负责人不知道先去哪儿拿脚本");
  check("有在线 agent 时不挂这条提示",
    !/没有任何在线的 agent 节点/.test(probe.renderTaskGroupsWith(withCells("assigned", {online: 1, total: 2}), account, "p1", null, {})),
    "有节点在线还提示 —— 常亮的告警等于没有告警");
  check("单元还没交出去时不挂这条提示",
    !/没有任何在线的 agent 节点/.test(probe.renderTaskGroupsWith(withCells("draft", {online: 0, total: 2}), account, "p1", null, {})),
    "单元还在 draft 就提示 agent 掉线 —— 这时它本来也不该动");

  // 提示里筛的状态名必须是状态机登记过的。这条不是洁癖：上一版这里写的是 "dispatched"，
  // 而 WorkItem 根本没有这个状态（那是 command.status 的值）—— 代码和夹具共用同一个假名字，
  // 断言绿了整整一轮，实际上一次都没验到真实状态。字面量对不上状态机 = 那个分支永远不成立。
  const machineText = fs.readFileSync(path.join(root, "spec/state-machines.yaml"), "utf8");
  const workItemStates = (() => {
    const lines = machineText.split(/\r?\n/);
    let index = lines.findIndex((line) => line === "  WorkItem:");
    const states = [];
    let inStates = false;
    for (index += 1; index >= 1 && index < lines.length; index += 1) {
      if (/^  \S/.test(lines[index])) break;
      if (/^    states:\s*$/.test(lines[index])) { inStates = true; continue; }
      if (!inStates) continue;
      const item = lines[index].match(/^      - "([^"]+)"\s*$/u);
      if (item) { states.push(item[1]); continue; }
      if (/^    \S/.test(lines[index])) break;
    }
    return states;
  })();
  const noticeSource = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8");
  const noticeLiterals = [];
  for (const fnName of ["cellsWaitingWithNoAgentNotice", "wipCapacityNotice"]) {
    const start = noticeSource.indexOf(`function ${fnName}(`);
    if (start < 0) { noticeLiterals.push({fnName, missing: true}); continue; }
    // 按花括号配对切出函数体，不按字符数猜窗口（窗口溢到隔壁函数是这套门反复栽过的坑）。
    let depth = 0, end = start;
    for (let index = noticeSource.indexOf("{", start); index < noticeSource.length; index += 1) {
      if (noticeSource[index] === "{") depth += 1;
      else if (noticeSource[index] === "}") { depth -= 1; if (!depth) { end = index; break; } }
    }
    const body = noticeSource.slice(start, end);
    for (const match of body.matchAll(/\.includes\(item\.status\)|has\(item\.status\)/gu)) void match;
    for (const list of body.matchAll(/\[((?:\s*"[a-z_]+"\s*,?)+)\]|new Set\(\[((?:\s*"[a-z_]+"\s*,?)+)\]\)/gu)) {
      for (const literal of String(list[1] || list[2]).matchAll(/"([a-z_]+)"/gu)) noticeLiterals.push({fnName, status: literal[1]});
    }
  }
  const unknownLiterals = noticeLiterals.filter((entry) => entry.missing || !workItemStates.includes(entry.status));
  check("提示里筛的工作项状态必须是状态机登记过的",
    workItemStates.length > 5 && noticeLiterals.length >= 5 && !unknownLiterals.length,
    workItemStates.length <= 5 ? "没能从 spec 取到 WorkItem 状态集，本条在空转"
      : (noticeLiterals.length < 5 ? `只提取到 ${noticeLiterals.length} 个状态字面量 —— 提取逻辑与代码脱节，本条在空转`
        : `${unknownLiterals.map((entry) => entry.missing ? `${entry.fnName} 找不到` : `${entry.fnName} 用了 ${entry.status}`).join("；")}`
          + " —— 状态机里没有这个名字，这个筛选分支永远不成立，提示永远不出现"));

  // 在制品额度用满：这是背压不是故障，提示要说清"会自己恢复"和"想更宽就加节点"。
  const withWip = (wip, fleet, status = "ready") => ({...withCells(status, fleet), wip});
  const wipFull = probe.renderTaskGroupsWith(withWip({inFlight: 8, capacity: 8}, {online: 2, total: 2}), account, "p1", null, {});
  check("在制品额度用满时，任务组页要说出来",
    /在制品已经达到上限/.test(wipFull) && /8/.test(wipFull),
    "后端按额度把单元判成 resource_queued，界面却什么都不说 —— 人只看到单元不动，无从判断是背压还是坏了");
  check("要说清这是背压、会自己恢复，以及想更宽怎么做",
    /不需要你动手/.test(wipFull)
      && /AI 智能体/.test(wipFull)
      && /注册 agent/.test(wipFull)
      && /刷新自检/.test(wipFull)
      && /准入/u.test(wipFull)
      && !/接入或恢复节点/.test(wipFull),
    "只说达到上限，不说会不会自己好、也不说怎么调宽 —— 人会去找一个并不存在的故障");
  check("额度没用满时不挂这条提示",
    !/在制品已经达到上限/.test(probe.renderTaskGroupsWith(withWip({inFlight: 3, capacity: 8}, {online: 2, total: 2}), account, "p1", null, {})),
    "没到上限也提示背压 —— 常亮的提示等于没有提示");
  // 占着名额的活自己也在等人时，"跑完就会自动继续"是一句假话 —— 它们不会自己跑完。
  const wipStalled = probe.renderTaskGroupsWith(withWip({inFlight: 8, capacity: 8, blocked: 8}, {online: 2, total: 2}), account, "p1", null, {});
  check("占额度的活自己卡在等人时，不许说会自动继续",
    !/不需要你动手/.test(wipStalled),
    "这些活在等人批权限或定稿，永远不会自己跑完 —— 照这句话去等，唯一能解开它的人正在干等");
  check("要说清是它们卡住了、以及去哪儿处置",
    /自己也卡住了/.test(wipStalled) && /人工审核/.test(wipStalled),
    "只说达到上限，人会去加节点 —— 而加多少台都没用，卡的是待处置的那几件");
  check("名额被卡住的活全占满时，要说明项目走不动了",
    /一步也走不动/.test(wipStalled),
    "部分卡住和全卡住对人的紧迫程度完全不同，界面不该让他自己去算");
  check("在飞的活都在正常跑时，仍按背压说明（不误报成卡住）",
    /不需要你动手/.test(probe.renderTaskGroupsWith(withWip({inFlight: 8, capacity: 8, blocked: 0}, {online: 2, total: 2}), account, "p1", null, {})),
    "正常背压被说成等人处置 —— 人会去翻一堆并不存在的待办");

  check("一个 agent 都没在线时，只说没节点，不叠加背压提示",
    !/在制品已经达到上限/.test(probe.renderTaskGroupsWith(withWip({inFlight: 8, capacity: 8}, {online: 0, total: 2}, "assigned"), account, "p1", null, {})),
    "两条提示同时出现，人会以为是两个毛病 —— 零节点时的真正出口是接节点，不是等额度");
}

// 项目多到超过下发上限时，窗口之外的项目在界面上必须仍然选得到。
// 切换器是拿下发的项目列表直接渲染的 <select>：没有额外的索引，第 81 个之后的项目
// 就只能在后端存在而在界面上不存在 —— 而后端明明支持按它取数（实测带上它的 projectId
// 照样正确返回它的任务组）。更糟的是控制台发现"保存的项目不在列表里"会静默切到第一个，
// 于是一个在第 95 个项目上工作的人刷新之后人在第 1 个项目里，一句提示都没有。
{
  const account = {accountId: "u1", email: "a@b.c", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"};
  const probe = loadConsole(el("div"));
  const many = (count, indexed) => {
    const projects = [];
    for (let i = 0; i < count; i += 1) projects.push({id: `p${i}`, name: `项目${i}`, organizationId: "org_default", status: "active", members: []});
    return {
      schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {}, organizations: [],
      projects: projects.slice(0, 80),
      ...(indexed ? {projectIndex: projects.map((x) => ({id: x.id, name: x.name, status: x.status}))} : {}),
      taskGroups: [], agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [], findings: [],
      humanConfirmationRequests: [], humanDirectives: [], truncatedCollections: ["projects"], fleet: {online: 1, total: 1}
    };
  };
  const withIndex = probe.selectProjectWith(many(100, true), account, "p95");
  check("项目多到超过下发上限时，窗口之外的项目仍然选得到（不许把人静默切走）",
    withIndex.kept === "p95",
    `选中 p95 后停在 ${withIndex.kept}｜可选项目 ${withIndex.options.length} 个`);
  check("切换器要列出全部项目，而不只是下发了完整记录的那一批",
    withIndex.options.length === 100,
    `切换器里有 ${withIndex.options.length} 个项目（共 100 个）`);
  const withoutIndex = probe.selectProjectWith(many(100, false), account, "p95");
  check("没有索引时才允许回退到第一个项目（说明这条断言测的是索引本身，不是恒真）",
    withoutIndex.kept === "p0",
    `没有 projectIndex 时停在 ${withoutIndex.kept}`);
  const small = probe.selectProjectWith({...many(5, false), projects: [{id: "p3", name: "三", status: "active"}]}, account, "p3");
  check("项目数没到上限时不需要索引，行为不变",
    small.kept === "p3" && small.options.length === 1,
    `停在 ${small.kept}｜可选 ${small.options.length} 个`);
}

// 人把方案「交回 AI 再分析」之后，如果一个在线 agent 都没有，这个等待永远不会结束。
// 而人工确认页上此前只写着"等待 AI 再分析"—— 人就坐在那儿等一件不会发生的事。
// （舰队掉线的提示原先只挂在监控页，而这一页才是他等的地方。）
{
  const account = {accountId: "u1", email: "a@b.c", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"};
  const baseState = () => ({
    schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
    organizations: [{orgId: "org_default", name: "组织", status: "active"}],
    projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
    taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "development", workItems: []}],
    humanConfirmationRequests: [{requestId: "hcr1", projectId: "p1", taskGroupId: "tg1", status: "pending",
      decisionType: "task_split", decisionClass: "major", round: 2, awaitingAiAnalysis: true,
      summary: "交回 AI 再分析的卡", options: [{optionId: "a", label: "方案甲"}], createdAt: "2026-08-12T00:00:00Z"}],
    agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [], findings: [],
    humanDirectives: [], truncatedCollections: [], fleet: {online: 0, total: 1}
  });
  const probe = loadConsole(el("div"));
  const stalled = probe.renderReviewWith(baseState(), account);
  check("等 AI 再分析而没有在线 agent 时，要在人工确认页上说出来",
    /没有任何在线的 agent 节点/.test(stalled),
    "卡片停在'等待 AI 再分析'，而没有任何 agent 能回答 —— 人会一直等下去");
  check("要给出不必干等的出路",
    /直接在这里定稿或打回/.test(stalled)
      && /刷新自检/.test(stalled)
      && /恢复目标 agent 主机\/进程心跳/.test(stalled)
      && !/接入或恢复节点/.test(stalled),
    "只说没人回答，不说人现在能做什么 —— 等于把他留在原地");

  const online = baseState();
  online.fleet = {online: 1, total: 1};
  check("有在线 agent 时不挂这条提示",
    !/没有任何在线的 agent 节点/.test(probe.renderReviewWith(online, account)),
    "有 agent 在线还说没有 —— 常亮的告警等于没有告警");

  const notWaiting = baseState();
  notWaiting.humanConfirmationRequests[0].awaitingAiAnalysis = false;
  check("没有卡在等 AI 时不挂这条提示",
    !/没有任何在线的 agent 节点/.test(probe.renderReviewWith(notWaiting, account)),
    "没有人在等 AI 却提示 agent 掉线 —— 这一页不该替监控页操心");
}

// 会话过期不该让人丢掉正在写的东西。
//
// 会话是【绝对过期】的（登录时定死一小时，不续期），而人在打字时轮询是暂停的 ——
// 于是典型路径是：写了一大段说明、点提交，才发现会话早就过期了。此前这一刻直接跳回登录页，
// 内容、所在页面、所选项目一起没了，人只能凭记忆重写一遍（而这段话往往是定稿理由）。
{
  const documentRoot = el("div");
  const form = el("form", {dataset: {form: "confirmation-decide"}}, [
    el("textarea", {name: "justification", value: "这是我写了很久的定稿理由"}),
    el("input", {name: "password", type: "password", value: "不该被存下来"})
  ]);
  documentRoot.children = [form];
  const probe = loadConsole(documentRoot);
  probe.stashDraft("tg", "prj_alpha");
  const stashed = probe.peekDraft();
  check("会话过期时把正在填的内容留下来", Boolean(stashed) && stashed.includes("定稿理由"),
    "过期这一刻直接跳登录页，人写的东西没有任何地方留存 —— 只能凭记忆重写");
  // 接线：真的走一次 401，而不是直接调那个函数
  const viaApi = await probe.expireViaApi("tg", "prj_alpha");
  check("401 这条路径上真的会去留存（不是只有函数写对了）",
    Boolean(viaApi) && viaApi.includes("定稿理由"),
    "函数写对了但 401 分支没调用它 —— 人遇到的正是 401 这条路径");
  check("留存的内容里不含口令", Boolean(stashed) && !stashed.includes("不该被存下来"),
    "口令进了会话存储 —— 保内容的价值不值得让它多活一轮");

  // 模拟"登录后落在默认页"：不先挪开的话，页面本来就还停在 tg，
  // 恢复与否都长一样 —— 断言等于没验（第一版就是这样）。
  probe.stashDraft("sys-overview", "");
  probe.setDraftRaw(stashed);
  const resumed = probe.restoreDraft();
  check("重新登录后回到过期前的页面与项目",
    resumed.ok && resumed.page === "tg" && resumed.projectId === "prj_alpha",
    `恢复结果 page=${resumed.page} project=${resumed.projectId} —— 落回默认页的话，草稿也补不回那张表单`);
  check("内容交回既有的一次性回填机制", Boolean(resumed.pending),
    "页面回去了，内容却没有交给回填 —— 人看到的还是一张空表");

  // 隔太久不许回填：那时人多半在做别的事，把一份陈旧草稿填进去比空着更容易让人误交。
  const stale = loadConsole((() => {
    const rootEl = el("div");
    rootEl.children = [el("form", {dataset: {form: "confirmation-decide"}}, [el("textarea", {name: "justification", value: "很久以前的草稿"})])];
    return rootEl;
  })());
  stale.stashDraft("tg", "prj_alpha");
  stale.ageDraft(31 * 60 * 1000);
  const staleResult = stale.restoreDraft();
  check("隔了太久的草稿不再回填", !staleResult.ok && !staleResult.pending,
    "半小时前的草稿仍被填回表单 —— 人多半已经在做别的事了，这比空着更危险");
}

// 被限流的账本集合，界面渲染的行数不得超过它取到的条数。
//
// 服务端给账本类集合单独设了一个更小的上限（省载荷：取 200 条渲染 10 行是纯浪费）。
// 但"少取"的前提是【少取的那部分没人看】—— 哪天某张表改成渲染 120 行，
// 它就会安静地只显示 60 行，人以为那就是全部。判据按服务端的登记表全量核对。
{
  const serverSource = fs.readFileSync(path.join(root, "apps/control-plane-ui/server.mjs"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8");
  const setAt = serverSource.indexOf("const LEDGER_COLLECTIONS = new Set([");
  const setBlock = setAt < 0 ? "" : serverSource.slice(setAt, serverSource.indexOf("]);", setAt));
  const ledgers = [...setBlock.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/gu)].map((match) => match[1]);
  // 取【默认值】，不锁死写法：这一处从 Math.min(capped, 60) 改成可配（环境变量 || 60）之后，
  // 只认字面量的提取会拿到 0，于是"界面渲染 20 行 > 服务端给 0 条"整片误报 ——
  // 判据锁写法就会挡住正确的改进（本会话第三次撞见）。
  const limitMatch = serverSource.match(/const ledgerLimit = Math\.min\(capped,[\s\S]{0,120}?(\d+)\)/u);
  const ledgerLimit = limitMatch ? Number(limitMatch[1]) : 0;
  if (!ledgers.length || !ledgerLimit || ledgerLimit < 5) {
    failures.push(`账本限流: 解析到集合 ${ledgers.length} 个、上限 ${ledgerLimit} —— 提取逻辑与代码脱节；`
      + "上限解析成 0 或极小值时，下面每条渲染上限都会被误判成超额");
  }
  for (const collection of ledgers) {
    for (const use of appSource.matchAll(new RegExp(`state\\.${collection}\\b`, "gu"))) {
      const window = appSource.slice(use.index, use.index + 400);
      const cap = window.match(/\.slice\(0, (\d+)\)/u);
      // 取不到显式截断说明这张表可能整表铺开 —— 那更危险，必须说出来而不是放过
      if (!cap) {
        failures.push(`账本限流: 控制台用了 ${collection} 却看不到显式的渲染上限 ——`
          + ` 服务端只给它 ${ledgerLimit} 条，整表铺开的话人会以为这就是全部`);
        continue;
      }
      if (Number(cap[1]) > ledgerLimit) {
        failures.push(`账本限流: ${collection} 在界面上渲染 ${cap[1]} 行，而服务端只给 ${ledgerLimit} 条 ——`
          + " 少取的前提是少取的那部分没人看，现在有人看了");
      }
    }
  }
}

// 按项目取数：项目视角的页面必须带上当前项目，系统级页面必须【不带】。
//
// 服务端在截断之前按 projectId 过滤，所以带不带决定了取到的是什么：
// 项目页不带 → 别的项目更新的记录把窗口占满，本项目的表是空的（人以为"没有记录"）；
// 系统页带了 → 系统管理员只看得到当前项目的角色技能叠加，以为别的项目没改过角色规则。
// 这两种错都不会报错，只会让人看到一份自称完整的名单。判据落在取数调用的实参上。
{
  const appSource = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8");
  const loadAt = appSource.indexOf("async function loadPage()");
  const loadBody = loadAt < 0 ? "" : appSource.slice(loadAt, appSource.indexOf("\nasync function loadTaskGroupDetail", loadAt));
  const projectScopedPages = new Set(["proj-overview", "proj-members", "tg", "review", "directives", "monitor", "proj-agents", "proj-settings"]);
  const calls = [];
  let currentPage = null;
  for (const line of loadBody.split("\n")) {
    const pageMatch = line.match(/page === "([a-z-]+)"/u);
    if (pageMatch) currentPage = pageMatch[1];
    for (const call of line.matchAll(/fetchState\("(tasks|runtime)"(,\s*\{[^}]*\})?\)/gu)) {
      calls.push({page: currentPage, view: call[1], scoped: /projectId/u.test(call[2] || "")});
    }
  }
  if (calls.length < 5) {
    failures.push(`按项目取数: 只解析到 ${calls.length} 处 tasks/runtime 取数调用 —— 提取逻辑与代码脱节，本条在空转`);
  }
  for (const call of calls) {
    if (projectScopedPages.has(call.page) && !call.scoped) {
      failures.push(`按项目取数: ${call.page} 页取 ${call.view} 视图时没有带上当前项目 ——`
        + " 别的项目更新的记录会把窗口占满，这一页会显示成'本项目没有记录'");
    }
    if (!projectScopedPages.has(call.page) && call.scoped) {
      failures.push(`按项目取数: ${call.page} 是系统级页面，却按当前项目过滤了 ${call.view} 视图 ——`
        + " 系统管理员会只看到当前项目的记录（如角色技能叠加），以为别的项目没有改过");
    }
  }
}

// 视图里被裁掉的字段，控制台一处都不许读。
//
// 裁字段是为了省载荷（关闭门记录单条 5.6KB，而控制台只读其中四个小字段），
// 但读一个被裁掉的字段【不会报错】：它永远是 undefined，界面上永远显示空或 0，
// 而人以为那里本来就没东西 —— 和"视图压根不下发这个集合"是同一类隐蔽故障。
// 判据按 server.mjs 的 viewDroppedFields 全量核对，新增一条裁剪就自动被守住。
{
  const serverSource = fs.readFileSync(path.join(root, "apps/control-plane-ui/server.mjs"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8");
  const at = serverSource.indexOf("const viewDroppedFields = {");
  const block = at < 0 ? "" : serverSource.slice(at, serverSource.indexOf("\n  };", at));
  const dropped = [];
  for (const entry of block.matchAll(/^\s{4}([A-Za-z_][A-Za-z0-9_]*):\s*\[([^\]]*)\]/gmu)) {
    for (const field of entry[2].matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/gu)) dropped.push({collection: entry[1], field: field[1]});
  }
  // 自检用精确相等：登记表里写了几个集合，就必须解析出几个集合的字段。
  // 用"条数下限"做自检不够 —— 删掉一整个集合之后条数照样过线（实测如此）。
  const declaredCollections = (block.match(/^\s{4}[A-Za-z_][A-Za-z0-9_]*:\s*\[/gmu) || []).length;
  const parsedCollections = new Set(dropped.map((item) => item.collection)).size;
  if (!declaredCollections || parsedCollections !== declaredCollections) {
    failures.push(`被裁字段: viewDroppedFields 里登记了 ${declaredCollections} 个集合，只解析出 ${parsedCollections} 个 ——`
      + " 提取逻辑与登记表脱节，本条在空转");
  }
  // 少数字段控制台确实在读，但读的是【另一个来源】给的那份（专用接口），不是视图里这份。
  // 登记要可核：下面会逐个确认那些读取点【全部】带着声明的那个前缀，光写一句豁免不算数。
  const READ_FROM_ANOTHER_SOURCE = {
    "taskGroups.taskAnalysis": "progressData."
  };
  for (const {collection, field} of dropped) {
    const fromElsewhere = READ_FROM_ANOTHER_SOURCE[`${collection}.${field}`];
    if (fromElsewhere) {
      const reads = [...appSource.matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\.${field}\\b`, "gu"))]
        .map((match) => `${match[1]}.`);
      const strays = [...new Set(reads.filter((prefix) => prefix !== fromElsewhere))];
      if (!reads.length) {
        failures.push(`被裁字段: ${collection}.${field} 登记为"读的是 ${fromElsewhere}那份"，`
          + "但控制台一处都没读它 —— 这条登记该撤");
      } else if (strays.length) {
        failures.push(`被裁字段: ${collection}.${field} 登记为只从 ${fromElsewhere}读，`
          + `实际还有 ${strays.join("、")} 这样的读取点 —— 那些会永远拿到 undefined`);
      }
      continue;
    }
    // 控制台里出现 `.field` 即视为读它。字段名都足够独特（gateResults / candidateRankings…），
    // 真撞上同名字段宁可报红让人来分辨 —— 漏报的代价是界面永远显示空值。
    if (new RegExp(`\\.${field}\\b`, "u").test(appSource)) {
      failures.push(`被裁字段: 视图里已经把 ${collection}.${field} 裁掉了，控制台却仍在读它 ——`
        + " 不会报错，只会永远显示空值；要么别裁，要么改用别的字段");
    }
  }
}

// 控制台读的每一个顶层字段，都必须真的有视图会下发它。
//
// 读一个从不下发的字段【不会报错】：它只是永远是 undefined，界面永远显示空或 0，
// 而人以为那里本来就没东西。这一类在这套系统里反复出现过（视图裁字段、新页面忘了加字段、
// 新加的字段只写了渲染没写投影），逐个页面盯是盯不过来的，所以按两侧的权威来源全量对一遍。
{
  const appSource = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8");
  const serverSource = fs.readFileSync(path.join(root, "apps/control-plane-ui/server.mjs"), "utf8");
  // 提取要认得住实际写法：控制台里既有 state.x，也有 (state || {}).x。
  // 只认字面 state.x 的话，用后一种写法的读取会静默逃逸 —— 第一版就是这样，
  // 把服务端的 fleet 删掉，门照样是绿的。
  const readFields = new Set([...appSource.matchAll(/state\s*(?:\|\|\s*\{\})?\s*\)?\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/gu)]
    .map((match) => match[1]));
  const guardedReads = (appSource.match(/\(state\s*\|\|\s*\{\}\)\s*\./gu) || []).length;
  if (guardedReads > 0 && ![...readFields].some((field) => new RegExp(`\\(state\\s*\\|\\|\\s*\\{\\}\\)\\.${field}\\b`, "u").test(appSource))) {
    failures.push(`视图接线: 源码里有 ${guardedReads} 处 (state || {}).x 写法，但提取一个都没认出来 —— 提取器与代码脱节`);
  }
  // 控制台自己合成进 state 的字段（monitor 页会把两个视图拼起来）
  const assigned = new Set();
  for (const block of appSource.matchAll(/state\s*=\s*\{([\s\S]{0,1600}?)\n\s*\};/gu)) {
    for (const key of block[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gmu)) assigned.add(key[1]);
  }
  // 按花括号配对切出整个对象字面量，不按字符数猜窗口。
  // 原先是 slice(at, at + 2500)：给 base 里某一项加了 4 行注释之后，后面的 accountDirectory
  // 被挤出窗口，门当场报"控制台读了一个没有任何视图下发的字段"——一个纯属排版造成的假红，
  // 而它指向的位置离真正的改动十万八千里。距离窗口迟早会这样咬人。
  const blockAfter = (marker) => {
    const at = serverSource.indexOf(marker);
    if (at < 0) return "";
    let depth = 0;
    for (let index = serverSource.indexOf("{", at); index < serverSource.length; index += 1) {
      if (serverSource[index] === "{") depth += 1;
      else if (serverSource[index] === "}") { depth -= 1; if (!depth) return serverSource.slice(at, index + 1); }
    }
    return "";
  };
  const baseBlock = blockAfter("const base = {");
  const viewBlock = blockAfter("const viewFields = {");
  if (!baseBlock.trimEnd().endsWith("}") || !viewBlock.trimEnd().endsWith("}")) {
    failures.push("视图接线: 没能按花括号配对切出 base / viewFields 对象 —— 提取逻辑与代码脱节，下面几条全在空转");
  }
  const delivered = new Set([
    ...[...baseBlock.matchAll(/^\s{4}([A-Za-z_][A-Za-z0-9_]*):/gmu)].map((match) => match[1]),
    // 条件展开也是下发：...(cond ? {projectIndex: ...} : {})。只认行首缩进的键会把这一整类
    // 判成"从不下发"，于是一个真的在下发的字段被报成假红。只匹配 `? {键:`，
    // 不泛化到所有嵌套对象 —— 那会把 fleet:{online} 里的 online 也算成下发，反过来遮住真缺口。
    ...[...baseBlock.matchAll(/\?\s*\{([A-Za-z_][A-Za-z0-9_]*):/gu)].map((match) => match[1]),
    ...[...viewBlock.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/gu)].map((match) => match[1]),
    ...[...serverSource.matchAll(/scoped\.([A-Za-z_][A-Za-z0-9_]*)/gu)].map((match) => match[1]),
    ...[...serverSource.matchAll(/\bbase\.([A-Za-z_][A-Za-z0-9_]*)\s*=/gu)].map((match) => match[1]),
    ...[...serverSource.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\s*:/gu)].map((match) => match[1]),
    ...assigned
  ]);
  if (readFields.size < 20 || delivered.size < 20) {
    failures.push(`视图接线: 只解析到 ${readFields.size} 个读取字段 / ${delivered.size} 个下发字段 —— 提取逻辑与代码脱节，本条在空转`);
  }
  const undelivered = [...readFields].filter((field) => !delivered.has(field)).sort();
  if (undelivered.length) {
    failures.push(`视图接线: 控制台读了 ${undelivered.join("、")}，但 server.mjs 的任何视图都不下发它 ——`
      + " 读一个从不下发的字段不会报错，只会让界面永远显示空，人以为那里本来就没东西");
  }
}

// 上面那道门是【按页无差别】的：它只问"有没有哪个视图下发过这个字段"，不问"这一页手上
// 那份 state 里有没有"。每一页各取自己那个视图，读别的视图才有的键会永远是空 —— 不报错、
// 只是显示不出来。监控页更甚：它拼两个视图，而从 runtime 里【只挑几个键搬过来】
//（实测 modelSelectionPolicies 就这样被丢掉）。所以逐页对一遍，而不是只盯监控页。
{
  const appSource = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8");
  const serverSource = fs.readFileSync(path.join(root, "apps/control-plane-ui/server.mjs"), "utf8");
  const sliceBalanced = (text, from, open, close) => {
    const at = text.indexOf(open, from);
    if (at < 0) return "";
    let depth = 0;
    for (let index = at; index < text.length; index += 1) {
      if (text[index] === open) depth += 1;
      else if (text[index] === close) { depth -= 1; if (!depth) return text.slice(at, index + 1); }
    }
    return "";
  };
  const bodyOf = (name) => {
    const at = appSource.indexOf(`function ${name}(`);
    return at < 0 ? "" : sliceBalanced(appSource, at, "{", "}");
  };
  const readsIn = (text) => [...text.matchAll(/state\s*(?:\|\|\s*\{\})?\s*\)?\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/gu)]
    .map((m) => m[1]);
  // 页 → 渲染函数、页 → 它取的视图
  const renderOf = new Map([...appSource.matchAll(/page === "([a-z-]+)"\) body = (render[A-Za-z]+)\(\)/gu)]
    .map((m) => [m[1], m[2]]));
  const branchOf = (page) => {
    const at = appSource.indexOf(`page === "${page}"`);
    if (at < 0) return "";
    const next = appSource.slice(at).search(/\n {4}\} else if \(page ===|\n {4}\} else \{/u);
    return next < 0 ? appSource.slice(at, at + 2000) : appSource.slice(at, at + next);
  };
  // 服务端：每个视图的集合清单 + 基底（基底里还有 ...spread 进来的那几项）
  const viewBlock = sliceBalanced(serverSource, serverSource.indexOf("const viewFields = {"), "{", "}");
  const viewCols = new Map([...viewBlock.matchAll(/^\s*([a-z]+): \[([\s\S]*?)\]/gmu)]
    .map((m) => [m[1], [...m[2].matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/gu)].map((x) => x[1])]));
  const baseBlock = sliceBalanced(serverSource, serverSource.indexOf("const base = {"), "{", "}");
  const baseKeys = new Set([
    ...[...baseBlock.matchAll(/^\s{4}([A-Za-z_][A-Za-z0-9_]*):/gmu)].map((m) => m[1]),
    // base 上还有一批是后补的（base.x = …，只在真发生时才挂）与各投影里补的那几项。
    ...[...serverSource.matchAll(/\bbase\.([A-Za-z_][A-Za-z0-9_]*)\s*=/gu)].map((m) => m[1]),
    ...[...serverSource.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*): state\.[A-Za-z_]/gmu)].map((m) => m[1])
  ]);
  // 基底里的 ...xxx 展开：把那个变量声明里出现的键也算成"到得了手上"。
  // 不认它的话，auditArchiveFault / eventLogFault 这种只在故障时才挂的字段会被判成从不下发（假红）。
  for (const spread of baseBlock.matchAll(/\.\.\.([A-Za-z_][A-Za-z0-9_]*)\b/gu)) {
    const declAt = serverSource.indexOf(`const ${spread[1]} =`);
    if (declAt < 0) continue;
    const decl = serverSource.slice(declAt, serverSource.indexOf("\n  const ", declAt + 10) + 1 || declAt + 400);
    for (const key of decl.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/gu)) baseKeys.add(key[1]);
  }
  if (renderOf.size < 10 || viewCols.size < 5 || baseKeys.size < 10) {
    failures.push(`按页接线: 只解析到 ${renderOf.size} 页 / ${viewCols.size} 个视图 / ${baseKeys.size} 个基底键`
      + " —— 提取与代码脱节，本条在空转");
  } else {
    const broken = [];
    for (const [page, renderName] of renderOf) {
      const branch = branchOf(page);
      const fetched = [...branch.matchAll(/fetchState\("([a-z]+)"/gu)].map((m) => m[1]);
      if (!fetched.length) continue; // 数据不走 state 的页（组织列表等）另走接口，不在这条的管辖内
      // 【取了这个视图】不等于【这一页手上有它的全部键】。监控页把两个视图拼起来时，
      // state 是从 tasksState 铺开的，runtime 那份只挑几个键搬过来 —— 剩下的到不了手上。
      // 所以按"state 是从哪一份铺开的"算：有 ...xxxState 就只认那一份，其余靠显式列出的键。
      const spreadVar = branch.match(/state\s*=\s*\{\s*\.\.\.([A-Za-z_][A-Za-z0-9_]*)/u)?.[1];
      const destructured = branch.match(/\[([^\]]*)\]\s*=\s*await Promise\.all/u)?.[1] || "";
      const varNames = destructured.split(",").map((name) => name.trim()).filter(Boolean);
      let views = fetched;
      if (spreadVar && varNames.length === fetched.length) {
        const at = varNames.indexOf(spreadVar);
        if (at >= 0) views = [fetched[at]];
      } else if (varNames.length === fetched.length && varNames.includes("state")) {
        // `[state, other] = await Promise.all([...])`：只有 state 那一份是这一页的 state。
        views = [fetched[varNames.indexOf("state")]];
      }
      const renderBody = bodyOf(renderName);
      // 按【函数体】切会漏掉它调用的通用函数（modelSelectionPolicies 的读取就在
      // modelDecisionSummaryZh 里）。所以把它直接调用的本文件函数展开一层，更深的不展开。
      const helpers = new Set([...renderBody.matchAll(/\b([a-z][A-Za-z0-9_]*)\s*\(/gu)].map((m) => m[1]));
      const reads = new Set([...readsIn(renderBody), ...[...helpers].flatMap((name) => readsIn(bodyOf(name)))]);
      const available = new Set([...baseKeys, ...views.flatMap((view) => viewCols.get(view) || [])]);
      for (const key of branch.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s/gmu)) available.add(key[1]);
      const missing = [...reads].filter((key) => !available.has(key)).sort();
      if (missing.length) broken.push(`${page}（${renderName}）读了 ${missing.join("、")}`);
    }
    if (broken.length) {
      failures.push(`按页接线: ${broken.join("；")} —— 这几页手上那份 state 里没有这些键`
        + "（既不在它取的视图里，也不在基底、也不是这一页自己拼上去的）：永远是空，界面不报错只显示不出来");
    }
  }
}

// 工作项的阻塞状态是可枚举的（core 的 BLOCKED_WORKITEM_STATUSES 五种）。人在任务组页看到
// 一个被阻塞的工作项时，屏幕上要么给出【出口】，要么明说【系统会自清】—— 只写一句"受阻原因"
// 等于把人留在原地。后端有杠杆而界面没入口，等于这个杠杆不存在；系统自清的也必须说出来，
// 否则人会去找一个并不需要的操作。
// 逐条写死只守得住写它的人当时想到的那一种，所以按 core 的清单全量核对。
{
  const probe = loadConsole(el("div"));
  const account = {accountId: "acct_admin", accountType: "system_admin", organizationId: "org_default",
    permissions: ["*"], roles: ["system_admin"]};
  const coreSource = fs.readFileSync(path.join(root, "apps/control-plane-ui/lib/control-plane-core.mjs"), "utf8");
  const declared = coreSource.match(/BLOCKED_WORKITEM_STATUSES = \[([^\]]*)\]/u);
  const blockedStatuses = declared ? [...declared[1].matchAll(/"([a-z_]+)"/gu)].map((match) => match[1]) : [];
  if (blockedStatuses.length < 4) {
    failures.push(`阻塞状态出口: 只从 core 提取到 ${blockedStatuses.length} 个阻塞状态 —— 提取逻辑与代码脱节，本条在空转`);
  }
  // 明说"系统会自清"的状态：这里登记的是【为什么人不需要动手】，写不出理由的就该给出口。
  // 只有【真的会自清】的才登记在这里 —— 我第一版把 blocked_resource 也写了进来，
  // 而它来自"没有可运行的模型满足硬性约束"，不动手永远不会好。写一条不存在的"会自动恢复"
  // 比什么都不写更糟：人会一直等下去。
  const SELF_CLEARING = {
    blocked_dependency: "依赖的工作项通过验收后，下一轮编排自动放行"
  };
  // stale_state 在全仓没有任何产生者（不可达状态）。登记在此，免得下次有人为它编一段界面文案；
  // 一旦将来有代码真的写它，这里的登记就该连同出口一起补。
  const NO_PRODUCER = {stale_state: "全仓无任何代码把工作项置为该状态"};
  for (const status of blockedStatuses) {
    const stateWithParkedCell = {
      schemaVersion: "runtime-state/v1", stateVersion: 1,
      projects: [{id: "p_park", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [{id: "tg_park", projectId: "p_park", name: "任务组", status: "development", health: "attention",
        workItems: [{id: "w_park", title: "被停住的工作项", status, blockedReason: status,
          ownerRole: "agent-runtime", progress: 40}]}],
      truncatedCollections: []
    };
    const html = probe.renderTaskGroupsWith(stateWithParkedCell, account, "p_park", "tg_park", {
      taskGroupId: "tg_park", progress: {}, config: null, roomMessages: []
    });
    if (!html.includes("被停住的工作项")) {
      failures.push(`阻塞状态出口: ${status} 的工作项根本没被渲染出来 —— 这一轮断言在空转`);
      continue;
    }
    // 判据必须收窄到【这张卡片】：拿整页去匹配的话，页面别处本来就有"人工指令/人工审核"这些词，
    // 判据恒为真 —— 我第一版就是这样，把出口整段删掉它照样绿。
    // 先剥掉 HTML 注释再匹配：模板里那段解释性注释本身就含"自动放行""人工指令"这些词，
    // 它会原样出现在渲染结果里 —— 我第一版匹配到的正是自己写的注释，把出口整段删掉照样绿。
    const visible = html.replace(/<!--[\s\S]*?-->/gu, "");
    const cardStart = visible.indexOf("被停住的工作项");
    const card = visible.slice(cardStart, cardStart + 900);
    // 别写死页名：本门原先认的是"运行时」页"，而界面上【根本没有】这个页（实测 10 处报文
    // 都指向它）—— 门和被测代码共用了同一个漂掉的名字，于是"指向不存在的页"被当成合法出口。
    // 这里只要求卡片指到【某个】页，那个页名是不是真的，由 contract-check 的
    // verifyGuidanceNamesRealPages 按 PAGE_META 全量核对。
    const hasExit = /人工指令|人工审核|「[^」]{2,16}」页|「[^」]{2,16}」→「[^」]{2,16}」|agent 节点/.test(card);
    const saysSelfClearing = /自动放行|无需操作/.test(card);
    if (NO_PRODUCER[status]) continue;
    if (!hasExit && !saysSelfClearing) {
      failures.push(`阻塞状态出口: 工作项停在 ${status}，卡片上既没有告诉人去哪处置，也没说系统会自清`
        + (SELF_CLEARING[status] ? `（这一种应当明说：${SELF_CLEARING[status]}）` : "（这一种需要一个人工出口）")
        + " —— 人只看到一句「受阻原因」就没有下文了");
    }
  }
}


// 派发也会卡住，而它显示在监控页的表格里 —— 一列"原因"，没有下文。
// 与工作项那条同形：按【代码里真实产生的】阻塞原因全量核对，每种要么给出口，要么登记为瞬态
// 并写明为什么人不需要动手。逐条写死只守得住写它的人当时想到的那几种。
{
  const probe = loadConsole(el("div"));
  const account = {accountId: "acct_admin", accountType: "system_admin", organizationId: "org_default",
    permissions: ["*"], roles: ["system_admin"]};
  const producerSource = [
    fs.readFileSync(path.join(root, "apps/control-plane-ui/lib/control-plane-core.mjs"), "utf8"),
    fs.readFileSync(path.join(root, "apps/control-plane-ui/lib/agent-gateway.mjs"), "utf8"),
    fs.readFileSync(path.join(root, "apps/control-plane-ui/server.mjs"), "utf8")
  ].join("\n");
  // 会话侧的阻塞原因一并纳入：会话可能在【派发已经终结之后】仍被停住（确认卡超时那条链），
  // 那时只看派发是看不见的，而会话仍算活跃、仍挡着关闭门。
  // 提取要认得【表达式化的赋值】：只认 `dispatch.blockedReason = "字面量"` 的写法，会漏掉
  //   stuck.blockedReason = "..."（换个变量名）
  //   dispatch.blockedReason = rejectedReason（先算好再赋值）
  // 而漏掉的原因不会有出口提示、也不会有人发现 —— 门在自己看不见的地方失效。
  // 做法：取每一处 *.blockedReason 赋值的右侧表达式；是字面量就直接收，是标识符就回到
  // 它的 const 声明里取字面量（三元的两支都收）。
  // 只取【赋值真正的取值】：三元的分支，或整个右侧就是一个字面量。条件里的操作数不算 ——
  // 第一版把 `command.commandType === "pause_dispatch" ? ...` 里的 commandType 也收成了阻塞原因，
  // 于是门去要一个根本不存在的原因的出口提示（提取放得太松，制造的是假活）。
  const literalsIn = (text) => text
    .split(/\?|:/u)
    .map((part) => part.trim().match(/^"([a-z_]{4,})"$/u)?.[1])
    .filter(Boolean);
  // 按赋值目标分面：工作项那一面在界面上有 needs_decision 兜底出口（WORK_ITEM_EXIT_HINT），
  // 派发/会话这一面走 STUCK_EXIT_HINT。混在一起要求同一张表，会去要一个本来就不该在那儿的出口。
  const isWorkItemTarget = (name) => /item$/iu.test(name) || /work[_]?item/iu.test(name);
  const reasonsFromAssignments = [];
  for (const match of producerSource.matchAll(/\b(\w+)\.blockedReason\s*=\s*([^;]+);/gu)) {
    const [, target, rhs] = match;
    if (isWorkItemTarget(target)) continue;
    let values = literalsIn(rhs);
    if (!values.length && /^[A-Za-z_$][\w$]*$/u.test(rhs.trim())) {
      const declaration = producerSource.match(new RegExp(`const ${rhs.trim()}\\s*=\\s*([^;]+);`, "u"));
      if (declaration) values = literalsIn(declaration[1]);
    }
    reasonsFromAssignments.push(...values);
  }
  const reasons = [...new Set([
    ...reasonsFromAssignments,
    ...[...producerSource.matchAll(/markDispatchBlocked\([^,]+, [^,]+, "([a-z_]+)"/gu)].map((match) => match[1])
  ])];
  if (reasons.length < 8) {
    failures.push(`派发出口: 只从生产者提取到 ${reasons.length} 种派发阻塞原因 —— 提取逻辑与代码脱节，本条在空转`);
  }
  // 工作项那一面此前【整个没有门】：上面那句 isWorkItemTarget 把它排除掉了，理由是
  // "界面上有 needs_decision 兜底出口"。这句话是对的（workItemExitHint 会退回按 status 取），
  // 但门自己从没验过那个兜底在不在 —— 只要有人写出一个 status 不在出口表里的阻塞，
  // 人就会看到一个原因码、没有下一步，而这一面没有任何东西会红。
  // 判据：每一个写到工作项上的 blockedReason，要么它自己在出口表里，
  // 要么登记说明【是哪个状态带着出口】。
  {
    const workItemHintKeys = new Set(Object.keys(probe.workItemExitHintKeys?.() || {}));
    const hintBlock = /const WORK_ITEM_EXIT_HINT = \{([\s\S]*?)\n\};/u.exec(
      fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8"))?.[1] || "";
    for (const key of hintBlock.matchAll(/^\s{2}([a-z_]+):/gmu)) workItemHintKeys.add(key[1]);
    // 登记：这些原因自己不在出口表里，但它们【总是与某个带出口的状态一起写】。
    // 值就写那个状态 —— 门会去核对出口表里确实有它。
    const CARRIED_BY_STATUS = {
      dependency_abandoned: "needs_decision",
      role_drift_guard_blocked: "needs_decision",
      cell_processing_error: "needs_decision",
      awaiting_human_split_confirmation: "needs_decision",
      agent_reported_blocked: "needs_decision",
      human_confirmation_cancelled_by_dispatch_failure: "needs_decision",
      human_verification_rejected: "needs_decision",
      human_confirmation_expired: "needs_decision",
      human_directive_cancel: "needs_decision",
      agent_runtime_executor_required: "blocked_resource"
    };
    const workItemReasons = new Set([...producerSource.matchAll(/\w*[Ii]tem\.blockedReason\s*=\s*"([a-z_]+)"/gu)]
      .map((match) => match[1]));
    if (workItemReasons.size < 8) {
      failures.push(`工作项出口: 只提取到 ${workItemReasons.size} 种工作项阻塞原因 —— 提取与代码脱节，本条在空转`);
    }
    for (const reason of workItemReasons) {
      if (workItemHintKeys.has(reason)) continue;
      const carrier = CARRIED_BY_STATUS[reason];
      if (carrier && workItemHintKeys.has(carrier)) continue;
      failures.push(`工作项出口: 阻塞原因「${reason}」在 WORK_ITEM_EXIT_HINT 里没有出口`
        + (carrier ? `，登记说它由状态「${carrier}」带出口，而那个状态也不在表里` : "，也没有登记是哪个状态带着出口")
        + " —— 人会看到一个原因码、没有下一步");
    }
    const staleCarried = Object.keys(CARRIED_BY_STATUS).filter((reason) =>
      !workItemReasons.has(reason) || workItemHintKeys.has(reason));
    if (staleCarried.length) {
      failures.push(`工作项出口: 登记表已过时：${staleCarried.join("、")} 现在要么自己有出口了、要么代码里已经不写这个原因`);
    }
    check("工作项那一面的阻塞原因也各有出口",
      !failures.some((line) => line.startsWith("工作项出口:")),
      `${workItemReasons.size} 种工作项阻塞原因逐个核过（${Object.keys(CARRIED_BY_STATUS).length} 种登记为由状态带出口）`);
  }

  // 「没有可用模型执行器」这条的出口原先只说"去看该节点的自检结果"——那是【去哪看】，不是【做什么】。
  // 运行时自动探测的就是 codex / claude / gemini / ollama 四个命令（runtime.mjs probeProfile），
  // 四个都没有、也没给 --executor-command，节点就没有执行器。出路是具体的，就该写出来。
  {
    const executorHintState = {
      schemaVersion: "runtime-state/v1", stateVersion: 1,
      projects: [{id: "p_x", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [{id: "tg_x", projectId: "p_x", name: "任务组", status: "development", workItems: []}],
      agentDispatches: [{dispatchId: "dsp_x", taskGroupId: "tg_x", workItemId: "w_x",
        status: "blocked", blockedReason: "agent_runtime_executor_required", progressPercent: 0}],
      workSessions: [], workerLanes: [], agentRuntimeNodes: [], qualityGates: [], testResults: [],
      checkpoints: [], admissionDecisions: [], modelSelectionDecisions: [], sessionPlacementDecisions: [],
      truncatedCollections: []
    };
    const executorRendered = probe.renderMonitorWith(executorHintState, account, "p_x").replace(/<!--[\s\S]*?-->/gu, "");
    check("「没有模型执行器」的出口要说清装什么、怎么覆盖",
      /codex/.test(executorRendered) && /ollama/.test(executorRendered) && /--executor-command/.test(executorRendered),
      "只说「去看该节点的自检结果」等于把人送到一屏数据前面，而没告诉他下一步做什么："
        + "自动探测的四个命令与 --executor-command 覆盖项都该出现在这句话里");
  }

  // 瞬态：不需要人动手，写"出口"反而是教人做无用功。登记的是【为什么它会自己好】。
  const TRANSIENT = {
    claim_expired_requeued: "claim 过期后派发已被重排回队列，下一个节点会认领",
    assigned_node_revocation_ack_requeued: "节点吊销 ACK 后已重排回队列",
    assigned_node_shutdown_ack_requeued: "节点下线 ACK 后已重排回队列",
    assigned_node_stop_control_failed_retry_queued: "停止控制失败后已重排重试",
    // 与 revocation_ack_timeout_requeued 同源：死节点兜底已经把派发写回 queued，人不用动手。
    // 它们此前只是没被提取到，不是被判过瞬态 —— 提取一收紧就露出来了。
    paused_node_dead_requeued: "承接节点已失联，派发被兜底重排回队列",
    shutdown_ack_timeout_requeued: "节点下线确认超时，派发被兜底重排回队列",
    control_pause_requested: "操作员刚下达的暂停，恢复即可继续",
    control_resume_requested: "操作员刚下达的恢复，下一轮即生效"
  };
  for (const reason of reasons) {
    if (TRANSIENT[reason]) continue;
    const stateWithStuckDispatch = {
      schemaVersion: "runtime-state/v1", stateVersion: 1,
      projects: [{id: "p_d", name: "项目", organizationId: "org_default", status: "active", members: []}],
      taskGroups: [{id: "tg_d", projectId: "p_d", name: "任务组", status: "development", workItems: []}],
      agentDispatches: [{dispatchId: "dsp_stuck", taskGroupId: "tg_d", workItemId: "w_d",
        status: "blocked", blockedReason: reason, progressPercent: 10}],
      workSessions: [], workerLanes: [], agentRuntimeNodes: [], qualityGates: [], testResults: [],
      checkpoints: [], admissionDecisions: [], modelSelectionDecisions: [], sessionPlacementDecisions: [],
      truncatedCollections: []
    };
    // 每种阻塞原因各登记一份：这一段本来就要逐个原因构造状态，正好是漏译扫描最需要的
    // 那种"枚举值真的出现在某一屏上"的样本。
    i18nScanStates.push([`阻塞:${reason}`, stateWithStuckDispatch, account, "p_d"]);
    const rendered = probe.renderMonitorWith(stateWithStuckDispatch, account, "p_d")
      .replace(/<!--[\s\S]*?-->/gu, "");
    // 同一原因换成"只有会话被停住、派发已终结"再验一次：合并这条提示的全部理由就在这里。
    const sessionOnly = {...stateWithStuckDispatch,
      agentDispatches: [{dispatchId: "dsp_done", taskGroupId: "tg_d", workItemId: "w_d", status: "completed"}],
      workSessions: [{sessionId: "ws_stuck", taskGroupId: "tg_d", workItemId: "w_d", roleId: "agent-runtime",
        status: "needs_decision", blockedReason: reason, placement: "subagent"}]};
    const sessionRendered = probe.renderMonitorWith(sessionOnly, account, "p_d").replace(/<!--[\s\S]*?-->/gu, "");
    if (sessionRendered.includes("ws_stuck") && !/需要人处理/.test(sessionRendered)) {
      failures.push(`派发出口: 只有会话卡在 ${reason}（派发已终结）时，监控页没有任何出口提示`
        + " —— 这个会话仍算活跃、仍挡着关闭门，而人看不到该去哪处理");
    }
    // 提示之外，会话那一行自己也要显示原因：记录里有而界面不渲染，人看到的只是一个状态徽标。
    // 判据收窄到这一行 —— 上面那条提示里也含同样的词，拿整页匹配会恒为真。
    if (sessionRendered.includes("ws_stuck")) {
      const rowStart = sessionRendered.indexOf("ws_stuck");
      const rowRegion = sessionRendered.slice(rowStart, rowStart + 500);
      if (!rowRegion.includes(reason) && !rowRegion.includes(String(reason).replace(/_/gu, " "))) {
        const translated = rowRegion.match(/受阻|超时|确认|凭据|权限|暂停/u);
        if (!translated) {
          failures.push(`派发出口: 会话卡在 ${reason}，但会话那一行没有显示原因`
            + " —— 原因记录在状态里却从不渲染，人只看到一个状态徽标，看不出为什么");
        }
      }
    }
    if (!rendered.includes("dsp_stuck")) {
      failures.push(`派发出口: ${reason} 的派发没被渲染出来 —— 这一轮断言在空转`);
      continue;
    }
    if (!/需要人处理/.test(rendered)) {
      failures.push(`派发出口: 派发卡在 ${reason}，监控页只显示一列"原因"，没有告诉人该去哪处理`
        + " —— 它不会自己好；若它其实是瞬态，请登记到 TRANSIENT 并写明为什么");
    }
  }
}

// ── 中文界面上不许出现英文枚举（用【真的】那份 t 渲染一遍） ──────────────────────────
//
// 这道门其余部分把 t 桩成恒等函数（断言按英文键匹配），于是它的一百多条断言【一次都没跑过
// 真的翻译】。而漏译只在真的 t 上才看得见：i18n-zh 的 t 命中不了就原样返回英文键，
// 只往浏览器控制台 warn 一条 —— 真正的用户不会去看那里。
// 词表类的门（状态/错误码/原因码/审计动作/权限码）各自按权威来源核对，但它们都答不了
// "这个值到底会不会出现在某一屏上"。这里换个方向：把页面渲染出来，把 t 的每一次未命中收下来。
// 实测这套办法在真实数据上找出过授权列表里的四个英文权限码。
{
  const i18nSource = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/i18n-zh.js"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8");
  // 生成的 id 也会被 t() 碰到（末段带数字），它们本来就没有中文，不算漏译。
  const looksGenerated = (value) => /\d/u.test(String(value).split("_").pop() || "");
  const misses = new Map();
  {
    const runtimeHealthKeys = ["gateway", "filesystem", "git", "remote_mcp"];
    const directI18nContext = vm.createContext({
      window: {},
      console: {log: () => {}, error: () => {}, warn: (message) => {
        const hit = /未映射的枚举值：(.+)$/u.exec(String(message));
        if (hit) misses.set(hit[1], new Set(["直接运行时健康标签"]));
      }}
    });
    vm.runInContext(i18nSource, directI18nContext, {filename: "i18n-zh.js"});
    const directI18n = directI18nContext.window.AIMAC_I18N;
    check("运行时健康检查标签要有中文映射，浏览器控制台不能再报未映射枚举",
      directI18n && runtimeHealthKeys.every((key) => directI18n.t(key) !== key)
        && runtimeHealthKeys.every((key) => !misses.has(key)),
      "运行时健康检查标签漏译：gateway / filesystem / git / remote_mcp 会在真实浏览器里产生 warn");
  }
  // 一份状态建一次上下文、在里面把所有页面渲一遍：每页都新建的话，app.js 要被重新解析上百次。
// 技能源那张表此前不显示仓库地址：人看不出这个源钉的到底是什么，而"钉住哪一份"正是它存在的理由。
{
  const skillRoot = el("div");
  const probe = loadConsole(skillRoot);
  const admin = {accountId: "u1", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"};
  const withSource = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
    projects: [], taskGroups: [], agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [],
    findings: [], humanConfirmationRequests: [], humanDirectives: [], truncatedCollections: [],
    skillSources: [{sourceId: "agency-agents-zh", repositoryUrl: "https://example.invalid/skills.git",
      defaultRef: "main", pinnedCommit: "abc1234567", status: "stale",
      lastSyncError: "同步失败（退出码 128：fatal: Authentication failed，凭据被拒）"}],
    roleSkills: [], roleSkillOverlays: [], modelCapabilities: []};
  probe.renderFullPageWith(withSource, admin, null, "sys-settings");
  const html = String(skillRoot.innerHTML || "");
  check("技能源要显示仓库地址",
    /example\.invalid\/skills\.git/.test(html),
    "技能源那张表不显示仓库地址 —— 人看不出这个源钉的到底是什么");
  check("同步失败的技能源要能在表上看出来",
    /没能刷新|stale|已过期|陈旧/.test(html),
    "同步失败之后状态没有呈现出来 —— 人点完同步只看到一条会消失的 toast");
  // stale 只说了"没同步上"。为什么没上（要认证 / 仓库不在了 / ref 写错了）此前只在服务端日志里，
  // 而技能源决定 agent 会做什么 —— 人得能在这张表上直接读到原因。
  check("同步失败要在表上写出原因",
    /Authentication failed/.test(html),
    "技能源同步失败的原因没有出现在表上 —— 人只看到 stale，得去翻服务端日志才知道是要认证还是仓库不在了");
  // 同步成功后原因不该继续显示：产品那边会清掉 lastSyncError，但本行不依赖它被清掉，
  // 而是核对"只在 stale 时显示" —— 两道保险里这一道是造得出来的那道。
  const recovered = structuredClone(withSource);
  recovered.skillSources[0].status = "active";
  const recoveredRoot = el("div");
  loadConsole(recoveredRoot).renderFullPageWith(recovered, admin, null, "sys-settings");
  // 接进来的源此前拿不下去：界面上只有"同步"。退役这条出口要在表上，且要说清后果。
  check("技能源要能退役",
    /data-action="retire-skill-source"/.test(html),
    "技能源那张表只有同步，没有任何拿下去的出口 —— 配错地址的源只能一直留着，还会被自治周期反复重试");
  {
    const retired = structuredClone(withSource);
    retired.skillSources[0].status = "retired";
    const retiredRoot = el("div");
    loadConsole(retiredRoot).renderFullPageWith(retired, admin, null, "sys-settings");
    const retiredHtml = String(retiredRoot.innerHTML || "");
    {
    // 把唯一的源退役之后，22 个角色会全部落到内置技能上。系统照常跑，所以这件事【只能靠界面说】。
    const allRetired = structuredClone(withSource);
    allRetired.skillSources[0].status = "retired";
    allRetired.roleSkills = [{roleSkillId: "system-orchestrator", sourceId: "system-default", roleId: "orchestrator"}];
    const bareRoot = el("div");
    loadConsole(bareRoot).renderFullPageWith(allRetired, admin, null, "sys-settings");
    check("一个可用技能源都没有时要说清后果",
      /没有可用的技能源/.test(String(bareRoot.innerHTML || "")),
      "所有源都退役了，页面只是一张空表 —— 人看不出所有角色已经落到系统内置技能上");
  }
  check("已退役的源不再给同步按钮",
      !/data-action="sync-skill-source"/.test(retiredHtml) && /已退役/.test(retiredHtml),
      "已退役的源还摆着同步按钮 —— 点了也不会有任何效果，而人不知道");
  }
  check("同步恢复之后不再显示上一次的失败原因",
    !/Authentication failed/.test(String(recoveredRoot.innerHTML || "")),
    "技能源已经同步成功了，表上还挂着上一次的失败原因 —— 人会去追一个已经解决的故障");
}

// 本机时钟快 20 分钟时，所有健康节点都会被算成"已 20 分钟没有心跳" —— 假警报把人派去查
// 一个不存在的故障。相对时间要按服务器时钟算（响应头 Date），并且把偏差本身告诉人。
{
  const skewRoot = el("div");
  const probe = loadConsole(skewRoot);
  const admin = {accountId: "u1", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"};
  const freshBeat = new Date(Date.now() - 20 * 60 * 1000 + 5000).toISOString();  // 服务器眼里刚刚心跳过
  const nodeState = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
    projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
    taskGroups: [], agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [],
    findings: [], humanConfirmationRequests: [], humanDirectives: [], truncatedCollections: [],
    agentRuntimeNodes: [{nodeId: "n1", status: "online", projectIds: ["p1"], organizationId: "org_default",
      lastHeartbeatAt: freshBeat}]};
  // 服务器的"现在"比本机慢 20 分钟：本机直接相减会得出"已 20 分钟没有心跳"。
  const skewedFetch = async () => ({ok: true, status: 200, statusText: "OK",
    headers: {get: (name) => String(name).toLowerCase() === "date" ? new Date(Date.now() - 20 * 60 * 1000).toUTCString() : null},
    json: async () => nodeState, text: async () => JSON.stringify(nodeState)});
  // 心跳提示渲染在执行监控页（renderMonitor 的节点表），不是智能体档案那一屏。
  const skewBody = await probe.loadWithFetch(nodeState, admin, "p1", "monitor", skewedFetch);
  const skewHtml = `${String(skewRoot.innerHTML || "")}${skewBody || ""}`;
  // 先自证这一屏真的渲染出来了：不然"没找到失联提示"只是因为什么都没渲染。
  check("时钟偏差夹具确实渲染了节点那一屏",
    /n1/.test(skewHtml),
    "这一屏没渲染出节点，下面两条在空转");
  check("本机时钟快时不许把健康节点报成失联",
    !/没有心跳/.test(skewHtml),
    "相对时间拿本机时钟减服务端时间戳 —— 本机快 20 分钟，所有健康节点都会显示已失联");
  check("时钟偏差本身要告诉人",
    /本机时钟比服务器快/.test(skewHtml),
    "悄悄替人校正了偏差，人就永远不知道自己这台机器的表是错的");
}

// 主审计只由控制台/REST 侧写，MCP 那 85 个工具一次都不调它 —— 经 MCP 改的状态在审计页上
// 一条痕迹都没有。人来这一页问的正是"谁动了它"，台账的边界必须写在页面上。
{
  const auditRoot = el("div");
  const admin = {accountId: "u1", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"};
  const auditState = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
    projects: [], taskGroups: [], agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [],
    findings: [], humanConfirmationRequests: [], humanDirectives: [], truncatedCollections: [],
    auditLog: [{id: "a1", at: new Date().toISOString(), actor: "u1", action: "skill_source_retire",
      subject: "AgentSkillSource:x", result: "succeeded"}]};
  loadConsole(auditRoot).renderFullPageWith(auditState, admin, null, "sys-overview");
  const auditHtml = String(auditRoot.innerHTML || "");
  check("审计页要说清这份台账覆盖到哪几条路径",
    /mcp-audit\.jsonl/.test(auditHtml) && /MCP 工具调用/.test(auditHtml),
    "台账现在含 MCP 的写入了，页面要说清这件事、以及入参摘要另存在哪 —— 否则人仍以为只看了一半");
  {
    // MCP 那条记录的动作名要有中文（它和 REST 的动作名走同一列 t()）。
    const mcpAudit = structuredClone(auditState);
    mcpAudit.auditLog = [{id: "a2", at: new Date().toISOString(), actor: "mcp:system_admin:acct_x",
      action: "mcp_tool_call", subject: "review-mcp.review_plan_create · taskGroupId=tg1", result: "succeeded"}];
    const mcpRoot = el("div");
    loadConsole(mcpRoot, {realI18n: true}).renderFullPageWith(mcpAudit, admin, null, "sys-overview");
    const mcpHtml = String(mcpRoot.innerHTML || "");
    check("MCP 那条审计记录要显示成中文且看得出是谁做的",
      /MCP 工具调用/.test(mcpHtml) && /mcp:system_admin:acct_x/.test(mcpHtml),
      "审计页上出现英文动作名或看不出执行者 —— 问责这一栏作废");
  }
}

// 视图会把每个集合截到上限（服务端如实登记在 truncatedCollections 里）。此前只有 5 张表各自
// 报出来，而界面上有 23 张表在渲染 state 集合 —— 实测真实部署里角色技能 269 条被截到 188 条，
// 屏幕上一个字都没有。改成整屏报一次并逐个点名。
{
  const cutRoot = el("div");
  const probe = loadConsole(cutRoot, {realI18n: true});
  const admin = {accountId: "u1", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"};
  const cutState = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
    projects: [], taskGroups: [], agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [],
    findings: [], humanConfirmationRequests: [], humanDirectives: [],
    truncatedCollections: ["roleSkills", "qualityGates"]};
  probe.renderFullPageWith(cutState, admin, null, "sys-overview");
  const cutHtml = String(cutRoot.innerHTML || "");
  check("名单被截断时要在屏上说出来",
    /只加载了【最近的】若干条/.test(cutHtml),
    "服务端已经如实登记了哪些名单被截断，而屏幕上一个字都没有 —— 人会把截断后的条数当成全部");
  check("被截断的名单要逐个点名，且是中文",
    /角色技能/.test(cutHtml) && /质量门/.test(cutHtml),
    "只说「有名单被截断了」，人不知道是哪一份 —— 一屏上有六七张表");
  {
    const fullRoot = el("div");
    const full = structuredClone(cutState);
    full.truncatedCollections = [];
    loadConsole(fullRoot, {realI18n: true}).renderFullPageWith(full, admin, null, "sys-overview");
    check("没有截断时不要多说一句",
      !/只加载了【最近的】若干条/.test(String(fullRoot.innerHTML || "")),
      "什么都没截断却挂着一条提示 —— 噪声会让真的截断被忽略");
  }
}

// 界面上所有时间按本机时区渲染，而服务端日志是 UTC。不标时区，人拿屏幕上的时间去对日志
// 会差几个小时，进而以为那条记录不存在。
{
  const zoneRoot = el("div");
  const probe = loadConsole(zoneRoot);
  const admin = {accountId: "u1", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"};
  const anyState = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
    projects: [], taskGroups: [], agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [],
    findings: [], humanConfirmationRequests: [], humanDirectives: [], truncatedCollections: []};
  probe.renderFullPageWith(anyState, admin, null, "sys-overview");
  const shell = String(zoneRoot.innerHTML || "");
  check("界面要说清时间是按哪个时区显示的",
    /UTC[+-]?\d*/.test(shell) && /本机时区/.test(shell),
    "屏幕上所有时间都不带时区，而服务端日志是 UTC —— 对日志的人会差几个小时，以为记录不存在");
}

// 配额只数没被吊销的节点，而智能体那张表把已吊销的也列着。不说清楚，人会拿表里的行数去对
// 这个数字，对不上又找不出原因。走真实加载路径（org-overview 会真的去取 /api/org/agents）。
{
  const overviewRoot = el("div");
  const probe = loadConsole(overviewRoot);
  const orgAdmin = {accountId: "u_org", accountType: "org_admin", displayName: "组织管理员", organizationId: "org_default"};
  const orgState = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
    organizations: [{orgId: "org_default", name: "默认组织", status: "active",
      quotas: {maxMembers: 50, maxProjects: 20, maxTaskGroups: 200, maxAgents: 100},
      usage: {members: 2, projects: 1, taskGroups: 1, agents: 1}}],
    projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
    taskGroups: [], agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [],
    findings: [], humanConfirmationRequests: [], humanDirectives: [], truncatedCollections: []};
  const nodes = [
    {nodeId: "node-live", status: "online", organizationId: "org_default"},
    {nodeId: "node-gone", status: "revoked", organizationId: "org_default"}
  ];
  const overviewFetch = async (path) => ({ok: true, status: 200, statusText: "OK", headers: {get: () => null},
    json: async () => String(path).includes("/api/org/agents") ? {agentRuntimeNodes: nodes} : orgState,
    text: async () => JSON.stringify(orgState)});
  await probe.loadWithFetch(orgState, orgAdmin, "", "org-overview", overviewFetch);
  const overviewHtml = String(overviewRoot.innerHTML || "");
  // 同一屏上另一处分母：「在线智能体节点 X/Y」原先把已吊销的也算进 Y，
  // 而旁边那格明说"已吊销不计入配额" —— 两个分母各算各的。
  const fleetCell = overviewHtml.slice(overviewHtml.indexOf("在线智能体节点"), overviewHtml.indexOf("在线智能体节点") + 220);
  check("在线节点的分母不含已吊销的（与旁边那格配额同口径）",
    fleetCell.includes(">1/1<") || /1\/1/.test(fleetCell.replace(/<[^>]+>/gu, "")),
    fleetCell.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").slice(0, 120));
  check("已吊销的节点不计入配额这件事要写出来",
    /已吊销.*不计入配额|不计入配额/.test(overviewHtml),
    "配额只数没被吊销的节点，而智能体那张表把已吊销的也列着 —— 两个数对不上，人找不出原因");
  {
    // 「项目总数」数全部、同屏那格配额排除已归档 —— 两个数并排却不同口径。
    const archRoot = el("div");
    const archProbe = loadConsole(archRoot);
    const archState = {...orgState,
      projects: [...orgState.projects, {id: "p_old", name: "旧项目", organizationId: "org_default", status: "archived", members: []}]};
    const archFetch = async (path) => ({ok: true, status: 200, statusText: "OK", headers: {get: () => null},
      json: async () => String(path).includes("/api/org/agents") ? {agentRuntimeNodes: [nodes[0]]} : archState,
      text: async () => JSON.stringify(archState)});
    await archProbe.loadWithFetch(archState, orgAdmin, "", "org-overview", archFetch);
    check("已归档的项目不计入配额这件事要写出来",
      /已归档，不计入配额/.test(String(archRoot.innerHTML || "")),
      "「项目总数 2」和「项目 1/20」并排显示，人只能以为其中一个错了");
    const noArchRoot = el("div");
    const noArchProbe = loadConsole(noArchRoot);
    const noArchFetch = async (path) => ({ok: true, status: 200, statusText: "OK", headers: {get: () => null},
      json: async () => String(path).includes("/api/org/agents") ? {agentRuntimeNodes: [nodes[0]]} : orgState,
      text: async () => JSON.stringify(orgState)});
    await noArchProbe.loadWithFetch(orgState, orgAdmin, "", "org-overview", noArchFetch);
    check("没有已归档项目时不要多说一句",
      !/已归档，不计入配额/.test(String(noArchRoot.innerHTML || "")), "噪声会让真正要紧的那句被忽略");
  }

  {
    // 未使用的入网令牌【占着配额的位】，页面上却只数节点 —— 于是"还剩一格"和"3/3 已满"
    // 同时成立。两个面必须同一口径：占位数要显出来，且合计要算给人看。
    const reservedRoot = el("div");
    const reservedProbe = loadConsole(reservedRoot);
    const reservedState = {...orgState, organizations: [{...orgState.organizations[0],
      quotas: {...orgState.organizations[0].quotas, maxAgents: 3},
      usage: {members: 2, projects: 1, taskGroups: 1, agents: 2, agentsReserved: 1}}]};
    const reservedFetch = async (path) => ({ok: true, status: 200, statusText: "OK", headers: {get: () => null},
      json: async () => String(path).includes("/api/org/agents") ? {agentRuntimeNodes: [nodes[0]]} : reservedState,
      text: async () => JSON.stringify(reservedState)});
    await reservedProbe.loadWithFetch(reservedState, orgAdmin, "", "org-overview", reservedFetch);
    const reservedHtml = String(reservedRoot.innerHTML || "");
    check("未使用的入网令牌占着配额，页面要显出来并给出合计",
      reservedHtml.includes("未使用的入网令牌占着位") && reservedHtml.includes("合计 3/3"),
      "页面只数节点时，人看着还剩一格却签不出令牌，报文还说 3/3 已满 —— 两个数出自不同口径");
    const noReserveRoot = el("div");
    const noReserveProbe = loadConsole(noReserveRoot);
    const noReserveState = {...orgState, organizations: [{...orgState.organizations[0],
      usage: {members: 2, projects: 1, taskGroups: 1, agents: 2, agentsReserved: 0}}]};
    const noReserveFetch = async (path) => ({ok: true, status: 200, statusText: "OK", headers: {get: () => null},
      json: async () => String(path).includes("/api/org/agents") ? {agentRuntimeNodes: [nodes[0]]} : noReserveState,
      text: async () => JSON.stringify(noReserveState)});
    await noReserveProbe.loadWithFetch(noReserveState, orgAdmin, "", "org-overview", noReserveFetch);
    check("没有未使用的令牌时不要多说一句",
      !String(noReserveRoot.innerHTML || "").includes("未使用的入网令牌占着位"),
      "一张待用令牌都没有，界面却挂着一句解释");
  }
  {
    const cleanRoot = el("div");
    const cleanProbe = loadConsole(cleanRoot);
    const liveOnly = async (path) => ({ok: true, status: 200, statusText: "OK", headers: {get: () => null},
      json: async () => String(path).includes("/api/org/agents") ? {agentRuntimeNodes: [nodes[0]]} : orgState,
      text: async () => JSON.stringify(orgState)});
    await cleanProbe.loadWithFetch(orgState, orgAdmin, "", "org-overview", liveOnly);
    check("没有已吊销节点时不要多说一句",
      !/不计入配额/.test(String(cleanRoot.innerHTML || "")),
      "一个已吊销节点都没有，界面却挂着一句解释 —— 噪声会让真正要紧的那句被忽略");
  }
}

// 失败原因常常带着细节（"git_command_failed:git push …（退出码 128：fatal: …）"）。
// 词表按整串查永远命中不了，于是屏幕上摆着英文键 + 细节 —— 而细节恰恰是唯一有用的部分。
{
  const probe = loadConsole(el("div"), {realI18n: true});
  const account = {accountId: "u1", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"};
  const withCodedFailure = {
    schemaVersion: "runtime-state/v1", stateVersion: 1,
    projects: [{id: "p_d", name: "项目", organizationId: "org_default", status: "active", members: []}],
    taskGroups: [{id: "tg_d", projectId: "p_d", name: "任务组", status: "development", workItems: []}],
    agentDispatches: [{dispatchId: "dsp_failed", taskGroupId: "tg_d", workItemId: "w_d", status: "failed",
      failureReason: "git_command_failed:git push origin HEAD:refs/heads/main（退出码 128：fatal: 凭据被拒）"}],
    workSessions: [], workerLanes: [], agentRuntimeNodes: [], qualityGates: [], testResults: [],
    checkpoints: [], admissionDecisions: [], modelSelectionDecisions: [], sessionPlacementDecisions: [],
    truncatedCollections: []
  };
  const rendered = probe.renderMonitorWith(withCodedFailure, account, "p_d").replace(/<!--[\s\S]*?-->/gu, "");
  check("带细节的失败原因要翻成中文",
    /git 命令失败/.test(rendered),
    "失败原因是 code:detail 形态，词表按整串查命中不了 —— 屏幕上摆着一串英文键");
  check("翻译之后细节不能丢",
    /凭据被拒/.test(rendered),
    "只显示了翻译过的前缀，git 自己说的原因没了 —— 而那才是唯一有用的部分");
  check("认不出的前缀要原样显示，不能变成占位符",
    (() => {
      const unknown = structuredClone(withCodedFailure);
      unknown.agentDispatches[0].failureReason = "some_brand_new_code:细节还在";
      const html = probe.renderMonitorWith(unknown, account, "p_d");
      return /some_brand_new_code/.test(html) && /细节还在/.test(html);
    })(),
    "词表里没有的前缀被吃掉了 —— 人连原始错误码都拿不到，没法搜也没法上报");
}

// 控制面挂掉时，这一屏此前只弹一次 toast：toast 消失之后，画面还挂着上一次成功时的数据，
// 而屏幕上没有任何迹象说"这已经不是现在的样子了"。监控台最要紧的恰恰是这一刻。
{
  const probe = loadConsole(el("div"));
  const admin = {accountId: "u1", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"};
  const baseState = {schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
    projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
    taskGroups: [], agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [],
    findings: [], humanConfirmationRequests: [], humanDirectives: [], truncatedCollections: []};
  const okFetch = async () => ({ok: true, status: 200, statusText: "OK", headers: {get: () => null},
    json: async () => baseState, text: async () => JSON.stringify(baseState)});
  const deadFetch = async () => { throw new Error("fetch failed"); };
  await probe.loadWithFetch(baseState, admin, "p1", "directives", okFetch);
  const healthy = probe.renderFullPageWith(baseState, admin, "p1", "directives");
  check("连得上时不挂断连横幅", !/旧数据/.test(healthy), "常亮的横幅等于没有横幅");
  const brokenHtml = await probe.loadWithFetch(baseState, admin, "p1", "directives", deadFetch);
  check("加载失败时要常驻说明这是旧数据",
    /旧数据/.test(brokenHtml),
    "控制面连不上时只弹了一次 toast —— 它消失之后，人对着一屏冻住的数据看不出任何异常");
  check("要说清旧到什么程度",
    /(秒前|分钟前|小时前|一直没能加载成功)/.test(brokenHtml),
    "只说加载失败，人不知道该不该继续照着这一屏做决定");
  const recoveredHtml = await probe.loadWithFetch(baseState, admin, "p1", "directives", okFetch);
  check("恢复之后横幅要自己消失", !/旧数据/.test(recoveredHtml), "只置不清的提示，人很快就会开始无视它");

  // 上面那条横幅由 render() 画出来 —— 而【render 自己抛了】的时候画不出任何东西。后台自动刷新
  // （实时唤醒 / 5 秒兜底轮询 / 监控页事件流）此前一律 `.catch(() => {})`：那一刻屏幕停在旧数据上，
  // 看起来还活着，而且以后每一拍都在同一处崩掉、同样没有声音。toast 挂独立图层，render 崩了它还在。
  const crashRoot = el("div");
  const crashProbe = loadConsole(crashRoot);
  crashProbe.setLastLoadedAt(Date.now() - 90 * 1000);
  crashProbe.backgroundRefreshFailure(new Error("boom-render"));
  const crashed = stubSubtreeText(crashRoot);
  check("后台刷新崩了要出声",
    /boom-render/.test(crashed),
    `后台刷新失败一声不响 —— 屏幕停在旧数据上，看起来还活着（${crashed.slice(0, 120)}）`);
  check("要说清屏幕停在多久以前的数据",
    /(秒前|分钟前|小时前|一直没能加载成功)/.test(crashed),
    "只说刷新失败，人不知道眼前这屏还能不能照着做决定");
  // 在能加载的页上待过之后，切到一个从没加载成功过的页：原先横幅照着【全局】那个时间说话，
  // 于是写出「下面显示的是 0 秒前的旧数据」—— 而这一页根本没有过数据。
  // 真实运行态上读到的正是这句。最该警惕的一刻不能被说成「数据是新的」。
  {
    const freshRoot = el("div");
    const freshProbe = loadConsole(freshRoot);
    freshProbe.setLastLoadedAt(Date.now() - 3000);
    freshProbe.setPage("directives");
    freshProbe.backgroundRefreshFailure(new Error("boom-other-page"));
    const freshText = stubSubtreeText(freshRoot);
    check("从没加载成功过的页不许说「显示的是几秒前的旧数据」",
      /从来没有加载成功过/u.test(freshText) && !/秒前的旧数据/u.test(freshText),
      `别的页刚加载过，切到这一页却失败了 —— 横幅照着全局时间说「0 秒前的旧数据」，`
        + `而这一页一条数据都没有过（${freshText.slice(0, 140)}）`);
  }
  crashProbe.backgroundRefreshFailure(new Error("boom-render"));
  check("同一个错误不许每拍刷一条",
    (stubSubtreeText(crashRoot).match(/boom-render/gu) || []).length === 1,
    "5 秒一拍的兜底轮询会把同一条错误刷满整屏，人反而看不见别的");
}

// 登出请求失败时此前整个吞掉：本机会话清了、界面说"已登出"，而服务端那边这次会话仍然有效到过期
// 为止。共用设备上，人以为凭据已经失效。
{
  const root = el("div");
  const probe = loadConsole(root);
  const admin = {accountId: "u1", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"};
  probe.renderFullPageWith({schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {}, projects: [],
    taskGroups: [], agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [], findings: [],
    humanConfirmationRequests: [], humanDirectives: [], truncatedCollections: []}, admin, null, "sys-overview");
  probe.setFetch(async () => { throw new Error("fetch failed"); });
  const button = {dataset: {action: "logout"}, disabled: false, textContent: "登出",
    classList: {add() {}, remove() {}}};
  button.closest = (selector) => (selector === "[data-action]" ? button : null);
  await probe.click({target: button, preventDefault: () => {}});
  const shown = stubSubtreeText(root);
  assertNoCrashBanner(shown, "登出失败提示");
  check("服务端没确认登出时必须说出来",
    /服务端未确认作废/.test(shown),
    `登出请求失败被吞掉了 —— 人以为凭据已经失效，实际那次会话还有效（${shown.slice(0, 160)}）`);
  check("说了之后还要给出下一步",
    /吊销/.test(shown),
    "只说'没确认作废'，人不知道该找谁做什么");
}

// 过滤把行全筛光时，人看到的东西此前有两种，都不对：
//   DOM 隐藏那条路 —— 一张只有表头、body 一个字都没有的表（分不清是没匹配还是页面坏了）；
//   filterSource 那条路 —— "暂无数据"，会以为系统里压根没这类记录。
// 文案抽成纯函数才验得到：行是 innerHTML 渲染的，DOM 桩里没有真实行树。
{
  const filterProbe = loadConsole(el("div"));
  check("过滤没匹配时说的是'没有匹配某词的行'，不是'暂无数据'",
    filterProbe.filteredEmptyText("abc", 0) === "没有匹配「abc」的行",
    `实际是：${JSON.stringify(filterProbe.filteredEmptyText("abc", 0))}`);
  check("有行被藏起来时要报出藏了几行（人才知道清掉过滤词能看回来）",
    filterProbe.filteredEmptyText("abc", 12) === "没有匹配「abc」的行（12 行被过滤条件隐藏）",
    `实际是：${JSON.stringify(filterProbe.filteredEmptyText("abc", 12))}`);
  check("没有过滤词时不得冒出这句话（本来就空的表还是该说'暂无数据'）",
    filterProbe.filteredEmptyText("", 0) === "",
    `没有过滤词却给出了：${JSON.stringify(filterProbe.filteredEmptyText("", 0))}`);
  // 上面三条是【纯函数】：它们证明不了这句话真的被挂到了表上。
  // 少了下面这条，把 applyFilterFor 里的调用整段删掉也照样全绿。
  const wiring = filterProbe.applyFilterForSource();
  check("过滤逻辑必须真的把这句话挂到空表上（否则纯函数写了也没人用）",
    /filteredEmptyText\(raw, hidden\.length\)/u.test(wiring) && /data-filter-empty/u.test(wiring),
    `applyFilterFor 里${/filteredEmptyText/u.test(wiring) ? "调了但形状对不上" : "根本没调"}这个文案函数`);
// 表格有展示上限就必须说出来 —— 逐张写断言必然漏（本仓的教训是"可枚举的面要按权威来源全量核对"）。
// table() 是唯一的表格 helper，把它的调用点全量枚举，行数据被截过就要求带 moreText。
// 两处易自欺，都踩过：
//   一、同名变量（projectRows 出现两次）要从调用点【往前】找最近定义，取全文第一处会查错对象；
//   二、行构造体里的 .slice 多半是截【字符串】（短 SHA），不是截集合 —— 按第一个 .map( 切开只看前半。
//      不切的话 sources 那张表会被误判成静默截断（实际截的是 pinnedCommit）。
{
  const appSource = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8");
  const callAt = (start) => {
    let depth = 1;
    let cursor = start;
    while (cursor < appSource.length && depth > 0) {
      if (appSource[cursor] === "(") depth += 1;
      else if (appSource[cursor] === ")") depth -= 1;
      cursor += 1;
    }
    return appSource.slice(start, cursor - 1);
  };
  const topLevelArgs = (text) => {
    const parts = [];
    let depth = 0;
    let current = "";
    for (const ch of text) {
      if ("([{".includes(ch)) depth += 1;
      else if (")]}".includes(ch)) depth -= 1;
      if (ch === "," && depth === 0) { parts.push(current); current = ""; } else current += ch;
    }
    parts.push(current);
    return parts;
  };
  const silent = [];
  let scanned = 0;
  for (const match of appSource.matchAll(/\btable\(/gu)) {
    const line = appSource.slice(0, match.index).split("\n").length;
    if (line === appSource.slice(0, appSource.indexOf("function table(")).split("\n").length) continue;
    const call = callAt(match.index + match[0].length);
    if (/moreText/u.test(call)) { scanned += 1; continue; }
    const body = (topLevelArgs(call)[1] || "").trim();
    const named = /^([A-Za-z_$][\w$]*)$/u.exec(body);
    let definition = body;
    if (named) {
      const defs = [...appSource.matchAll(new RegExp(`(?:const|let)\\s+${named[1]}\\s*=`, "gu"))]
        .filter((item) => item.index < match.index);
      if (!defs.length) { silent.push(`${line}: ${named[1]} —— 找不到定义，本条【没查成】`); continue; }
      const from = defs[defs.length - 1].index;
      const end = appSource.indexOf(";\n", from);
      definition = appSource.slice(from, end < 0 ? from + 600 : end);
    }
    scanned += 1;
    const beforeMap = definition.split(".map(")[0];
    if (/\.slice\(\s*0\s*,\s*\d+\s*\)/u.test(beforeMap)) {
      silent.push(`${line}: ${named ? named[1] : "（内联）"} 被截到固定条数却没有 moreText 提示`);
    }
  }
  // 提示里的"当前展示 N 条"是个【字面量】，真正的截断写在别处的 slice(0, N)。
  // 两个数由两处分别写死 —— 改了一处忘了另一处，界面就会稳稳地报一个假数。
  // 屏幕上并排的两个数必须对得上，这一条不能靠人记得。
  const mismatched = [];
  let paired = 0;
  for (const entry of appSource.matchAll(/\btable\(/gu)) {
    const line = appSource.slice(0, entry.index).split("\n").length;
    if (line < 615) continue;
    const call = callAt(entry.index + entry[0].length);
    const notice = /moreText\(/u.exec(call);
    if (!notice) continue;
    const shown = (topLevelArgs(callAt(entry.index + entry[0].length + notice.index + notice[0].length))[1] || "").trim();
    const body = (topLevelArgs(call)[1] || "").trim();
    const named = /^([A-Za-z_$][\w$]*)$/u.exec(body);
    let definition = body;
    if (named) {
      const defs = [...appSource.matchAll(new RegExp(`(?:const|let)\\s+${named[1]}\\s*=`, "gu"))]
        .filter((item) => item.index < entry.index);
      if (!defs.length) { mismatched.push(`${line}: ${named[1]} 的定义找不到 —— 本条【没查成】`); continue; }
      const from = defs[defs.length - 1].index;
      const end = appSource.indexOf(";\n", from);
      definition = appSource.slice(from, end < 0 ? from + 600 : end);
    }
    const cap = /\.slice\(\s*0\s*,\s*(\d+)\s*\)/u.exec(definition.split(".map(")[0]);
    paired += 1;
    if (!cap) mismatched.push(`${line}: 行数据没有截断，却在说「当前展示 ${shown} 条」`);
    else if (cap[1] !== shown) mismatched.push(`${line}: 真实截到 ${cap[1]} 条，提示说 ${shown} 条`);
  }
  check("提示里的「当前展示 N 条」必须等于真实截断数（两处写死的数会各走各的）",
    mismatched.length === 0 && paired >= 15,
    mismatched.length ? `对不上：\n    ${mismatched.join("\n    ")}` : `只配上 ${paired} 对数 —— 扫描没打到该打的地方`);
    check("每张有展示上限的表都要说出总数（否则人以为看到的就是全部）",
    silent.length === 0 && scanned >= 30,
    silent.length ? `静默截断：\n    ${silent.join("\n    ")}` : `只核对到 ${scanned} 处 table() 调用 —— 扫描没打到该打的地方`);
}

    check("原来的空行只藏不改（过滤词一清，'暂无数据'要能原样回来）",
    /emptyRow\.style\.display = "none"/u.test(wiring) && /emptyRow\.style\.display = ""/u.test(wiring),
    "空行被改文案或被删掉了 —— 清掉过滤词后回不到原样");
}

  const pageTouchCounts = new Map();
  const danglingBannerRefs = new Set();
  const seenKeys = new Set();
  const newKeysByState = new Map();
  const scanState = (label, state, account, projectId, pages) => {
    const tCalls = new Map();
    const scanRoot = el("div");
    const context = vm.createContext(makeContext(scanRoot));
    context.scrollTo = () => {};
    vm.runInContext(i18nSource, context, {filename: "i18n-zh.js"});
    const real = context.window.AIMAC_I18N;
    if (!real || typeof real.t !== "function") throw new Error("漏译扫描: 没能加载真的 i18n —— 本段在空转");
    // 数一数每页真正过了多少次 t()：只有外壳那点固定次数的页，等于它的枚举值从没被渲染过 ——
    // 这道扫描对那些页是空的。这个数不作为判据（页面本来就有繁简之分），但必须【报出来】，
    // 否则"渲染了 N 页、未命中 0 个"会被读成"N 页都查过了"。
    context.t = real.t;
    const inner = real.t;
    context.window.AIMAC_I18N.t = (value) => {
      tCalls.set(pageId, (tCalls.get(pageId) || 0) + 1);
      // 记下这份状态让扫描【第一次】看到的枚举值。一份新加的夹具如果一个新键都没带来，
      // 多半是它压根没渲染出来（状态取值不对、集合名写错），而扫描照样报"未命中 0 个"——
      // 那读起来像"全查过了"。2026-08-22 实测踩过一次：executionTopologies 的 status 不在
      // 可终止的四种之内，那一屏根本不渲染，摘掉中文也照样绿。
      const key = String(value);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        newKeysByState.set(label, (newKeysByState.get(label) || 0) + 1);
      }
      return inner(value);
    };
    let pageId = "?";
    context.console = {log: () => {}, error: () => {}, warn: (message) => {
      const hit = /未映射的枚举值：(.+)$/u.exec(String(message));
      if (!hit || looksGenerated(hit[1])) return;
      if (!misses.has(hit[1])) misses.set(hit[1], new Set());
      misses.get(hit[1]).add(`${label}/${pageId}`);
    }};
    loadConsoleModules(context);
    vm.runInContext(appSource + PROBE_EPILOGUE, context, {filename: "app.js"});
    const done = [];
    for (const page of pages) {
      pageId = page;
      // 同一个上下文里 t 对每个未命中只 warn 一次，所以一条漏译只会记在最先碰到它的那一页上 ——
      // 页面名只是线索，判据是"有没有漏译"，不是"漏在哪几页"。
      context.__probe.renderFullPageWith(state, account, projectId, page);
      done.push(`${label}/${page}`);
      // 「原因见页面顶部的横幅」只有在那一屏【真的挂着横幅】时才是真话。横幅由 lastError 驱动，
      // 而项目配置这类【子请求】失败不置 lastError（它的 catch 把错误吞了，紧接着 lastError 又被清空）——
      // 于是设置页三块空态都指着一个不存在的东西。指人去看没有的东西比不说更坏，
      // 而且这一条只能整屏看：单看那一块的文案永远是对的。
      const screenText = String(scanRoot.innerHTML || "").replace(/<[^>]+>/gu, " ");
      if (/页面顶部的横幅|页面顶部的提示|顶部的横幅里/u.test(screenText)
        && !/连不上控制面或这一页加载失败|控制台这一页自己出错了/u.test(screenText)) {
        danglingBannerRefs.add(`${label}/${page}`);
      }
      pageTouchCounts.set(page, Math.max(pageTouchCounts.get(page) || 0, tCalls.get(page) || 0));
    }
    return done;
  };
  // 定稿页上的协商记录此前没有任何一份登记状态覆盖到：三份基础状态里都没有待确认单，
  // 于是 t(turn.action) / t(turn.assessment) 这一族值从没被渲染过 —— 实测漏了 revise。
  // 判据要覆盖【人真正读来做决定的那一屏】，而不只是列表页。
  i18nScanStates.push(["待定稿的核心决策", {
    schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
    projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
    taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "development", workItems: []}],
    humanConfirmationRequests: [{
      requestId: "hcr_scan", projectId: "p1", taskGroupId: "tg1", workItemId: "w1", status: "pending",
      decisionClass: "major", decisionType: "work_item_verification", blocking: true, round: 2,
      question: {summary: "问题", detail: "细节"},
      options: [{optionId: "a", label: "甲"}, {optionId: "none", label: "不选择（自定义输入）"}],
      deliberation: [
        {round: 1, actorKind: "human", actor: "u1", action: "revise", summary: "人的意见", at: "2026-08-10T02:00:00.000Z"},
        {round: 1, actorKind: "ai", actor: "agent", action: "analysis", assessment: "concerns", summary: "AI 的意见", at: "2026-08-10T02:05:00.000Z"},
        {round: 1, actorKind: "human", actor: "u1", action: "finalize", summary: "定了", at: "2026-08-10T03:00:00.000Z"},
        {round: 1, actorKind: "human", actor: "u1", action: "reject", summary: "打回", at: "2026-08-10T03:10:00.000Z"},
        {round: 1, actorKind: "human", actor: "u1", action: "propose", summary: "提案", at: "2026-08-10T03:20:00.000Z"}
      ]
    }],
    humanDirectives: [], agentDispatches: [], workSessions: [], closeBarriers: [], qualityGates: [],
    findings: [], permissionRequests: [], approvalRequests: [], truncatedCollections: []
  }, {accountId: "u1", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"}, "p1"]);
  // 执行方案的阻塞项此前【从没被渲染过】：三份基础状态里都没有 executionTopologies，
  // 于是 topologyBlockerText 那一族值不在扫描面里 —— 扫描报"未命中 0 个"，而真实情况是
  // 那几个尾码一个中文都没有（2026-08-22 实测：no_acceptance_checks / missing_objective /
  // incomplete / runner_or_isolation_none 全是英文，人看到的是「（b_api · no_acceptance_checks）」）。
  // 这份状态把那一屏也渲染出来，让扫描真的查得到它。
  i18nScanStates.push(["卡住的执行方案", {
    schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
    projects: [{id: "p1", name: "项目", organizationId: "org_default", status: "active", members: []}],
    taskGroups: [{id: "tg1", projectId: "p1", name: "任务组", status: "development",
      workItems: [{id: "wi1", title: "并行改造", status: "assigned", ownerRole: "agent-runtime", progress: 20}]}],
    executionTopologies: [{
      schemaVersion: "execution-topology/v1", topologyId: "topo1", projectId: "p1", taskGroupId: "tg1",
      // 状态必须是可终止的那四种之一（TOPOLOGY_CANCELLABLE），否则这一屏根本不渲染，
      // 扫描会报"未命中 0 个"而其实一个字都没查到（第一版写 eligibility_checked，实测就是这样）。
      workItemId: "wi1", status: "blocked", mode: "parallel_active",
      runnerKind: "none", isolation: "none", mergePolicy: "parent_serial_after_all_required_reported",
      groups: [{groupId: "g1", branches: [
        {branchId: "b_api", objective: "", status: "queued", ownedPaths: [], acceptanceChecks: [], outputContract: []},
        {branchId: "b_ui", objective: "UI", status: "queued", ownedPaths: ["apps/ui/**"], acceptanceChecks: ["npm test"],
          outputContract: ["a", "b", "c", "d"]}
      ]}],
      // 五种尾码各来一条：这正是人在"方案为什么跑不了"那一刻会读到的整屏。
      blockers: [
        "runner_isolated:topo1:runner_or_isolation_none",
        "independent_deliverables:b_api:missing_objective",
        "final_validation_available:b_api:no_acceptance_checks",
        "result_bundle_contract:b_api:incomplete",
        "owned_paths_disjoint:b_ui:wrote_apps/api/x.txt"
      ],
      baseSnapshot: {stateVersion: 1, gitHead: "abc1234"},
      createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z"
    }],
    humanConfirmationRequests: [], humanDirectives: [], agentDispatches: [], workSessions: [],
    closeBarriers: [], qualityGates: [], findings: [], permissionRequests: [], approvalRequests: [],
    truncatedCollections: []
  }, {accountId: "u1", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"}, "p1"]);
  // 上面几份状态只覆盖到 5 个页面：量过每页触发的 t() 次数，14 页里有 9 页只有外壳那 38 次，
  // 等于它们的枚举值从没被渲染过（定稿页的 revise 就是这么漏掉的）。
  // 这一份补的是人工指令与账号授权两页 —— 记录形状照抄自真实服务的返回，不是编的：
  // 编夹具是误报的主要来源，本会话已经两次把自己编错的字段名当成界面缺陷。
  i18nScanStates.push(["有指令与授权", {
    schemaVersion: "runtime-state/v1", stateVersion: 1, runtime: {},
    projects: [{id: "prj_control_plane", name: "控制面", organizationId: "org_default", status: "active", members: []}],
    taskGroups: [{id: "tg_runtime_management", projectId: "prj_control_plane", name: "运行时管理", status: "development", workItems: []}],
    humanDirectives: [
      {schemaVersion: "human-directive/v1", directiveId: "hd_1", projectId: "prj_control_plane",
        taskGroupId: "tg_runtime_management", directiveType: "cancel", instruction: "这条不做了",
        issuedBy: "acct_system_owner", status: "applied",
        appliedActions: [{action: "task_group_cancel", ref: "TaskGroup:tg_runtime_management"}],
        createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z"},
      {schemaVersion: "human-directive/v1", directiveId: "hd_2", projectId: "prj_control_plane",
        taskGroupId: "tg_runtime_management", directiveType: "add_requirement", instruction: "接口都要有中文错误信息",
        issuedBy: "acct_system_owner", status: "rejected", rejectReason: "task_group_not_found",
        appliedActions: [], createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z"}
    ],
    accessGrants: [{schemaVersion: "access-control-grant/v1", grantId: "grant_1",
      subjectRef: {subjectType: "account", subjectId: "acct_system_owner"},
      resource: {resourceType: "system_console", resourceId: "system"},
      role: "system_owner", permissions: ["system:*", "task_group:read", "task_group:control"], status: "active"}],
    accounts: [{schemaVersion: "account/v1", accountId: "acct_system_owner", accountType: "system_admin",
      displayName: "System Owner", email: "system.admin@local", status: "active", roles: ["system_owner"],
      permissions: ["system:*", "system:bootstrap", "system:skill_sync", "system:model_registry"]}],
    agentRuntimeNodes: [], agentJoinTokens: [], agentDispatches: [], workSessions: [], closeBarriers: [],
    qualityGates: [], findings: [], humanConfirmationRequests: [], truncatedCollections: []
  }, {accountId: "acct_system_owner", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"}, "prj_control_plane"]);
  const scanned = [];
  const pages = ["sys-overview", "sys-orgs", "sys-settings", "sys-accounts", "org-overview", "org-members",
    "org-agents", "org-projects", "proj-overview", "proj-members", "tg", "review", "directives", "monitor", "proj-agents", "proj-settings"];
  for (const [label, state, account, projectId] of i18nScanStates) {
    scanned.push(...scanState(label, state, account, projectId, pages));
  }
  if (scanned.length < 14) failures.push(`漏译扫描: 只渲染了 ${scanned.length} 个页面 —— 本段在空转`);
  check("说「原因见页面顶部的横幅」的屏，必须真的挂着那条横幅",
    danglingBannerRefs.size === 0 && scanned.length >= 14,
    danglingBannerRefs.size
      ? `这些屏指了一条不存在的横幅：\n    ${[...danglingBannerRefs].join("\n    ")}`
      : `${scanned.length} 屏都核过了`);
  // 上面那四页的数据各自另走接口取，喂 state 只会渲染空壳。这里走真实的 loadPage，
  // 用一个按路径回真实形状的 fetch 桩把它们填上 —— 形状照抄自真实服务的返回。
  {
    const canned = {
      "/api/task-groups/tg_runtime_management/human-directives": {humanDirectives: [
        {directiveId: "hd_1", directiveType: "cancel", instruction: "这条不做了", status: "applied",
          issuedBy: "acct_system_owner", appliedActions: [{action: "task_group_cancel", ref: "TaskGroup:tg_runtime_management"}],
          createdAt: "2026-08-12T00:00:00.000Z"},
        {directiveId: "hd_2", directiveType: "add_requirement", instruction: "接口都要有中文错误信息",
          status: "rejected", rejectReason: "task_group_not_found", issuedBy: "acct_system_owner",
          appliedActions: [], createdAt: "2026-08-12T00:00:00.000Z"}]},
      "/api/org/members": {members: [{accountId: "acct_m1", accountType: "user_account", displayName: "成员甲",
        email: "m1@local", status: "invited", roles: ["project_member"], permissions: ["project:view"],
        authPolicy: {method: "invite_token", mfaRequired: false, passwordSet: false}}]},
      "/api/org/agents": {agentRuntimeNodes: [{nodeId: "node_1", nodeName: "节点甲", status: "online", admission: "full",
        health: "ok", allowedRoles: ["*"], projectIds: ["prj_control_plane"], display: {region: null, dataRoot: null}}]},
      "/api/org/projects": {projects: []},
      "/api/orgs": {organizations: []},
      "/api/system/overview": {server: {}, runtime: {}},
      "/api/projects/prj_control_plane/config": {config: {
        repositories: [{id: "repo_main", url: "https://example.invalid/repo.git", defaultBranch: "main",
          credentialMode: "api_key", credential: {mode: "api_key", apiKey: "fixture-token"}}],
        baselineData: [{name: "订单基线", locator: "git:baseline/orders.json"}],
        businessRules: [{ruleId: "br_1", title: "对外接口必须有中文错误信息", content: "…", status: "active"}],
        systemRules: [], defaultRoles: ["implementer"]}, configVersion: 3}
    };
    const [, scanStateForFetch] = i18nScanStates.at(-1);
    const fetchStub = async (url) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/u, "").split("?")[0];
      // loadPage 自己会去拉 /api/state：不把登记的那份状态回给它，state 会被空对象冲掉，
      // 页面于是渲染成"当前项目暂无任务组"，而扫描看起来"跑过了"。
      const body = path === "/api/state" ? scanStateForFetch : (canned[path] ?? {});
      return {ok: true, status: 200, statusText: "OK", headers: {get: () => null},
        json: async () => body, text: async () => JSON.stringify(body)};
    };
    // org-* 那两页只在【组织管理员】视角下存在：用系统管理员去渲染会被切回系统概览，
    // 页数照涨而那两页的枚举一个都没过 —— 这正是"跑过了"最容易骗人的形态。
    const orgAdmin = {accountId: "acct_org_admin", accountType: "org_admin", displayName: "组织管理员",
      organizationId: "org_default"};
    const [label, state, account, projectId] = i18nScanStates.at(-1);
    const fetchDriven = [["directives", account], ["org-members", orgAdmin], ["org-agents", orgAdmin],
      ["proj-settings", account]];
    for (const [page, pageAccount] of fetchDriven) {
      const context = vm.createContext(makeContext(el("div")));
      context.scrollTo = () => {};
      vm.runInContext(i18nSource, context, {filename: "i18n-zh.js"});
      // 变量名与上面那段不同是有意的：变异门要求锚点在文件里唯一，
      // 同名会让"加载不到真 i18n 就报空转"那条变异认不出该改哪一处。
      const pageI18n = context.window.AIMAC_I18N;
      if (!pageI18n || typeof pageI18n.t !== "function") throw new Error("漏译扫描（走接口那几页）: 没能加载真的 i18n —— 本段在空转");
      context.t = pageI18n.t;
      let touched = 0;
      const inner = pageI18n.t;
      context.window.AIMAC_I18N.t = (value) => { touched += 1; return inner(value); };
      context.console = {log: () => {}, error: () => {}, warn: (message) => {
        const hit = /未映射的枚举值：(.+)$/u.exec(String(message));
        if (!hit || looksGenerated(hit[1])) return;
        if (!misses.has(hit[1])) misses.set(hit[1], new Set());
        misses.get(hit[1]).add(`${label}(走接口)/${page}`);
      }};
      loadConsoleModules(context);
      vm.runInContext(appSource + PROBE_EPILOGUE, context, {filename: "app.js"});
      try { await context.__probe.loadPageWith(state, pageAccount, projectId, page, fetchStub); }
      catch (error) { failures.push(`漏译扫描: ${page} 走 loadPage 抛错（${String(error?.message || error).slice(0, 100)}）—— 这一页没被检验`); }
      scanned.push(`${label}(走接口)/${page}`);
      pageTouchCounts.set(page, Math.max(pageTouchCounts.get(page) || 0, touched));
    }

    // 上面那两条设置页断言是【渲染分支】：探针直接把状态设成 failed，走不到真正的 catch。
    // 而真实缺陷就出在 catch 上（.catch(() => null) 把原因整个吞了）—— 这一条走真实 loadPage，
    // 让 /config 这一路真的失败，看屏幕上最后说了什么。
    const failingConfigFetch = async (url) => {
      const requested = String(url).replace(/^https?:\/\/[^/]+/u, "").split("?")[0];
      if (requested.endsWith("/config")) {
        const body = {error: "project_config_unavailable"};  // 真形状：payload.error 一律是字符串码
        return {ok: false, status: 503, statusText: "Service Unavailable", headers: {get: () => null},
          json: async () => body, text: async () => JSON.stringify(body)};
      }
      return fetchStub(url);
    };
    const failRoot = el("div");
    const failContext = vm.createContext(makeContext(failRoot));
    failContext.scrollTo = () => {};
    vm.runInContext(i18nSource, failContext, {filename: "i18n-zh.js"});
    failContext.t = failContext.window.AIMAC_I18N.t;
    failContext.console = {log: () => {}, error: () => {}, warn: () => {}};
    loadConsoleModules(failContext);
    vm.runInContext(appSource + PROBE_EPILOGUE, failContext, {filename: "app.js"});
    await failContext.__probe.loadPageWith(state, account, projectId, "proj-settings", failingConfigFetch);
    const failScreen = String(failRoot.innerHTML || "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
    check("配置接口真失败时，屏幕上要出现服务端给的原因（catch 不许把它吞掉）",
      failScreen.includes("project_config_unavailable"),
      `设置页失败时说的是：${(failScreen.match(/暂时无法读取项目规则配置[^。]*。/u) || ["（没渲染出这句）"])[0]}`);
    check("配置接口真失败时，不许把人指去看一条不存在的横幅",
      !/页面顶部的横幅|顶部的横幅里|页面顶部的提示/u.test(failScreen)
        || /连不上控制面或这一页加载失败|控制台这一页自己出错了/u.test(failScreen),
      `屏幕上${/页面顶部的横幅/u.test(failScreen) ? "指了横幅但横幅不在" : "没有悬空的横幅指引"}`);
  }
  // 判定必须在【全部扫描做完之后】：这一段起初写在走接口那四页之前，于是它们发现的漏译
  // 只进了计数、没进 failures —— 门报"未命中 1 个"却退出码 0。
  for (const [value, where] of misses) {
    failures.push(`漏译扫描: 中文界面上会显示英文枚举「${value}」（出现在 ${[...where].slice(0, 3).join("、")}）`
      + " —— 给它补中文，或者别把这个值直接交给 t()");
  }
  // 一份状态没带来任何新枚举值 = 它没有扩大扫描面。这不是判据（后加的状态可能只为补页面覆盖），
  // 但必须报出来，否则"我加了夹具"与"那份夹具真渲染出来了"分不开。
  const barrenStates = [...newKeysByState].filter(([, count]) => count === 0).map(([name]) => name);
  const untouchedStates = i18nScanStates.map(([name]) => name).filter((name) => !newKeysByState.has(name));
  if (barrenStates.length || untouchedStates.length) {
    console.log(`  ..  这些夹具没给漏译扫描带来任何新枚举值：${[...barrenStates, ...untouchedStates].join("、")}`
      + " —— 多半是那一屏没渲染出来（状态取值不对、集合名写错），不是「已经全覆盖了」");
  }
  const shellOnly = [...pageTouchCounts].filter(([, count]) => count <= Math.min(...pageTouchCounts.values()));
  console.log(`漏译扫描：用真的 t 渲染了 ${scanned.length} 个页面，未命中 ${misses.size} 个`
    + `；另有 ${shellOnly.length} 页只渲染了空壳（${shellOnly.map(([page]) => page).join("、")}）——`
    + "它整页几乎不经 t()（标签写死在模板里），枚举面本来就小 —— 这不是覆盖缺口。"
    + "数据不在 state 里的那几页（人工指令 / 成员 / 智能体）已改为走真实 loadPage + 接口桩来覆盖。");
}

if (failures.length) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
// 同样报出覆盖面：这道门有一百多条断言，只说 ok 的话，少跑一整段与全跑过在输出上没有区别。
console.log(`console behaviour gate ok: ${checkCount} 条断言全部通过`
  + "（提交失败保内容、房间协作记录对人可见、视图接线、项目切换器、额度提示等已行为验证）");
