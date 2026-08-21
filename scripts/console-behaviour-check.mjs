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
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  }

  // toast 会给容器设 role/aria-live 之类：桩里少了这些方法，任何走到 toast 的路径都会
  // 以 "setAttribute is not a function" 收场 —— 那是桩的故障，不是被测代码的。
  setAttribute(name, value) { this.attributes = {...(this.attributes || {}), [name]: value}; }
  appendChild(child) { this.children.push(child); return child; }
  insertBefore(child) { this.children.unshift(child); return child; }
  getAttribute(name) { return (this.attributes || {})[name] ?? null; }
  removeAttribute(name) { if (this.attributes) delete this.attributes[name]; }
  addEventListener() {}
  removeEventListener() {}
  remove() {}

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
    throw new Error(`DOM 桩不认识选择器 ${JSON.stringify(selector)} —— 桩已与被测代码脱节，不能据此下结论`);
  }

  querySelectorAll(selector) {
    return this.#descendants().filter((el) => el.#matches(selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function el(tag, attrs, children) { return new StubElement(tag, attrs, children); }

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
  snapshotFormValues: (formEl) => snapshotFormValues(formEl),
  restorePendingForm: () => restorePendingForm(),
  setPending: (value) => { pendingFormRestore = value; },
  getFormTouched: () => formTouched,
  setFormTouched: (value) => { formTouched = value; },
  renderSource: () => String(render),
  handlerSource: (type) => String(globalThis.__handlers[type]),
  click: (event) => globalThis.__handlers.click(event),
  stubNavigation: () => { render = () => {}; loadPage = async () => {}; toast = {success: () => {}, error: () => {}, info: () => {}}; },
  renderTaskGroupDetail: (detail, taskGroup) => { tgDetail = detail; return renderTaskGroupDetail(taskGroup); },
  loadTaskGroupDetailSource: () => String(loadTaskGroupDetail),
  decisionSelect: (...args) => decisionSelect(...args),
  listEmptyText: (what, failure) => { lastError = failure; return listEmptyText(what); },
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
  translate: (key) => t(key),
  filteredEmptyText: (query, hidden) => filteredEmptyText(query, hidden),
  applyFilterForSource: () => String(applyFilterFor),
  heartbeatStaleHint: (node) => heartbeatStaleHint(node),
  claimMissHint: (node) => claimMissHint(node),
  selfCheckFailureHint: (node) => selfCheckFailureHint(node),
  assertRuleFragmentLengths: (fragments) => assertRuleFragmentLengths(fragments),
  evidenceRefsHint: (event) => evidenceRefsHint(event),
  alternativeAxisGaps: (assessment) => alternativeAxisGaps(assessment),
  renderReviewWith: (nextState, account) => { state = nextState; currentAccount = account || null; return renderReview(); },
  renderPendingPanelWith: (nextState, account) => { state = nextState; currentAccount = account; return renderPendingForMePanel(); },
  todoCountsWith: (nextState, account) => { state = nextState; currentAccount = account; return todoCountsByPage(); },
  moreTextWith: (nextState, total, shown, field) => { state = nextState; return moreText(total, shown, field); },
  renderLoginWith: (hint) => { loginHint = hint; renderLogin(); return document.querySelector("#app").innerHTML || ""; },
  bootstrapScaleFrom: (overview) => bootstrapScaleFrom(overview),
  renderSysOverviewWith: (nextState, account, overviewData) => { state = nextState; currentAccount = account; systemOverview = overviewData; return renderSysOverview(); },
  renderSysSettingsWith: (nextState, instructions) => { state = nextState; if (instructions !== undefined) instructionState = instructions; return renderSysSettings(); },
  renderSysAccountsWith: (nextState, account) => { state = nextState; currentAccount = account; return renderSysAccounts(); },
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
  renderTaskGroupsWith: (nextState, account, projectId, detailId, detail) => { state = nextState; currentAccount = account; currentProjectId = projectId; expandedTaskGroupId = detailId; if (detail !== undefined) tgDetail = detail; return renderTaskGroups(); },
  selectProjectWith: (nextState, account, projectId) => {
    state = nextState; currentAccount = account; currentProjectId = projectId;
    ensureProjectSelection();
    return {kept: currentProjectId, options: selectableProjects().map((item) => item.id)};
  },
  setProjConfigStatus: (status) => { projConfigStatus = status; projConfig = null; },
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
  backgroundRefreshFailure: (error) => reportBackgroundRefreshFailure(error),
  setLastLoadedAt: (value) => { lastLoadedAt = value; }
};
`;

// realI18n：本门其余部分把 t 桩成恒等函数（断言按英文键匹配），但有些行为只有【真词表】在场时
// 才看得见 —— 比如 "code:detail" 形态的失败原因要不要拆开翻译。需要时按这个开关加载真的 i18n。
function loadConsole(documentRoot, options = {}) {
  const source = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8");
  const context = vm.createContext(makeContext(documentRoot));
  if (options.realI18n) {
    vm.runInContext(fs.readFileSync(path.join(root, "apps/control-plane-ui/public/i18n-zh.js"), "utf8"),
      context, {filename: "i18n-zh.js"});
    if (typeof context.window?.AIMAC_I18N?.t !== "function") {
      throw new Error("控制台行为门: 要求真词表却没加载上 —— 相关断言会在空转");
    }
  }
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
if (process.env.AIMAC_RENDER_REAL) {
  const dir = process.env.AIMAC_RENDER_REAL;
  const {readStoredState} = await import(`${root}/apps/control-plane-ui/lib/state-store.mjs`);
  const real = readStoredState({root, runtimeDir: dir, statePath: `${dir}/control-plane-state.json`,
    seedPath: `${root}/data/seed-state.json`, buildInitialState: () => ({})});
  // 视角可换：AIMAC_RENDER_AS=<邮箱>。默认系统管理员，但不同视角看到的是不同的页与不同的空态，
  // 只读一个人的屏幕会漏掉另一类人才撞得到的死胡同（"请联系组织管理员"那次就是这么发现的）。
  const wantWho = process.env.AIMAC_RENDER_AS;
  const who = (wantWho && (real.accounts || []).find((item) => item.email === wantWho))
    || (real.accounts || []).find((item) => item.accountType === "system_admin") || (real.accounts || [])[0];
  if (wantWho && who?.email !== wantWho) {
    console.log(`（要的是 ${wantWho}，真实状态里没有这个账号 —— 下面渲染的是 ${who?.email}）`);
  }
  console.log(`=== 视角：${who?.email}（${who?.accountType}）`);
  // 这里喂进去的是【完整状态】：服务端的 scopedStateForAccount 没有导出（导入 server.mjs 会把服务起起来），
  // 所以下面渲染出来的东西没经过按账号的可见性过滤。非系统账号在真实控制台上收到的会更少。
  // 不写这一句的话，两个方向都会误判：把"成员看到了别人的项目"当成越权缺陷（其实是工具没过滤），
  // 或者反过来以为这里能验出越权（越权由 doctor 的读泄漏用例守着，不是这里）。
  if (who?.accountType !== "system_admin") {
    console.log("（注意：喂进去的是完整状态，未经服务端按账号过滤 —— 这一视角实际收到的会更少；越权与否由 e2e 的读泄漏用例守，不看这里）");
  }
  const documentRoot = el("div");
  const probe = loadConsole(documentRoot, {realI18n: true});
  const strip = (html) => String(html).replace(/<[^>]+>/gu, " ").replace(/&nbsp;/gu, " ")
    .split("\n").map((line) => line.replace(/\s+/gu, " ").trim()).filter(Boolean).join("\n");
  const project = (real.projects || [])[0];
  const taskGroup = (real.taskGroups || [])[0];
  console.log(`=== 真实状态：${(real.projects || []).length} 个项目、${(real.taskGroups || []).length} 个任务组\n`);
  console.log("=== 任务组页 ===\n" + strip(probe.renderTaskGroupsWith(real, who, project?.id, taskGroup?.id, null)).slice(0, 2400));
  console.log("\n=== 监控页 ===\n" + strip(probe.renderMonitorWith(real, who, project?.id)).slice(0, 1200));
  // 其余各页走通用入口。渲染不出来（抛异常）本身就是发现：真实数据里有夹具没有的组合。
  // 页 id 必须是真的存在的那几个。第一版写的是 orgs / agents / rules —— 产品对认不出的页 id
  // 会静默回落到默认页，于是这三页渲染出来全是【系统概览】，而我在读它们时以为读的是组织管理。
  // 勘察工具骗自己比门骗自己更难发现：它不报红，只是把错的东西摆给你看。
  // 有几页的数据【不在 state 里】，各自另走接口取数（组织列表、成员、智能体、系统概览、项目配置）。
  // 只喂 state 直接渲染，它们一律显示"暂无数据" —— 而那是【工具的空】，不是产品的空态。
  // 实测这条假线索骗过我一次：系统管理员的「组织列表」显示暂无数据，而真实状态里有组织。
  // 办法：走真实 loadPage，state 类请求喂真状态；其余接口【不编数据】（编出来的是假故障），
  // 而是记下来、在那一页下面明说"这里的空白是勘察桩答不了，不是产品的空"。
  for (const page of ["proj-overview", "review", "directives", "sys-orgs", "sys-accounts",
    "sys-settings", "sys-overview", "proj-settings"]) {
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
      unserved.add(url.split("?")[0]);
      return {ok: false, status: 404, statusText: "Not Found", headers,
        json: async () => ({error: "probe_stub_has_no_answer"})};
    };
    try {
      await probe.loadPageWith(real, who, project?.id, page, fetchStub);
      const text = strip(documentRoot.innerHTML || documentRoot.textContent || "");
      console.log(`\n=== ${page} ===\n` + (text.slice(0, 900) || "（空）"));
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

// 场景：人在「打回并要求重做」表单里写了一大段理由，提交时撞上 expectedRound 409
// （并发下的正常回答，不是故障）。整页重渲染之后，那段理由必须还在。

// 全新部署的第一步：以系统管理员登录、打开项目概览，此时一个项目都没有。
// 空态原先一律说"请联系组织管理员分配" —— 而系统管理员和组织管理员正是能建项目的人，
// 把他们支去找别人是个死胡同，且出现在人第一次用这套系统的那一刻。
// 空态必须按【这个人能做什么】说话，所以三种视角逐一验，不是验"有没有提示"。
{
  const emptyRoot = el("div");
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
  check("全新部署时，系统管理员看到的是他自己能做的下一步（而不是去找别人）",
    /创建项目（系统级）/.test(asSystem) && !/请联系组织管理员/.test(asSystem),
    `系统管理员看到：${(asSystem.match(/当前账号暂无可见项目。[^ ]*/u) || ["（没有空态提示）"])[0]}`);
  const asOrgAdmin = renderFor("org_admin");
  check("组织管理员看到的是「项目管理」页，而不是去找组织管理员（他自己就是）",
    /项目管理/.test(asOrgAdmin) && !/请联系组织管理员/.test(asOrgAdmin),
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
  const admin = {accountId: "u1", email: "a@b.c", accountType: "system_admin", displayName: "管理员", organizationId: "org_default"};
  const settingsText = (status) => {
    settingsProbe.setProjConfigStatus(status);
    i18nScanStates.push(["新建项目", withProject, admin, "p1"]);
    settingsProbe.renderFullPageWith(withProject, admin, "p1", "proj-settings");
    return String(settingsRoot.innerHTML || "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
  };
  const unloaded = settingsText("unloaded");
  check("配置还没取到时说的是'正在加载'，不是'加载失败'",
    /正在加载项目规则配置/.test(unloaded) && !/加载失败/.test(unloaded),
    `未加载时显示：${(unloaded.match(/规则配置 [^ ]*/u) || ["（没有规则配置面板）"])[0]}`);
  const failed = settingsText("failed");
  check("真的取失败时仍要说清失败、并说明为什么把编辑器藏了",
    /加载失败/.test(failed) && /误保存清空规则/.test(failed),
    `失败时显示：${(failed.match(/规则配置 [^ ]*/u) || ["（没有规则配置面板）"])[0]}`);
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
  const button = {dataset: {action: "open-audit-archive"}, disabled: false, textContent: "查看审计归档"};
  // closest 必须按选择器分辨：一律返回自己的话，前面 target.closest(".rule-row") 那一支会先命中，
  // 然后在没有 classList 的桩上抛错、被 try 吞掉 —— 表现为"点了没反应"。
  button.closest = (selector) => (selector === "[data-action]" ? button : null);
  await probe.click({target: button, preventDefault: () => {}});
  const shown = String(root.innerHTML || "");
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
    const button = {dataset: {action: "open-audit-archive"}, disabled: false, textContent: "查看审计归档"};
    button.closest = (selector) => (selector === "[data-action]" ? button : null);
    await probe.click({target: button, preventDefault: () => {}});
    return String(root.innerHTML || "");
  };
  const faulted = await openArchive({entries: [], chain: {verified: 0, breaks: []},
    archiveFault: {lostEntries: 4, error: "EACCES: permission denied"}});
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
  const renderAs = (account, state, pageId, projectId = "") => {
    const root = el("div");
    loadConsole(root, {realI18n: true}).renderFullPageWith(state, account, projectId, pageId);
    return String(root.innerHTML || "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
  };
  const pages = ["proj-overview", "tg", "review", "directives", "monitor", "proj-settings"];
  const silent = pages.filter((pageId) => !/当前账号暂无可见项目/u.test(renderAs(member, baseState([], []), pageId)));
  check("一个项目都没有时，六个项目页都要说清是【没有项目】而不是项目空着",
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
    const renderOrg = (projects, pageId) => {
      const root = el("div");
      loadConsole(root, {realI18n: true}).renderFullPageWith(orgState(projects), orgAdmin, "", pageId);
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
      /项目管理/u.test(emptyGrant) && /账号与授权/u.test(emptyGrant),
      "提示没有点名创建项目的入口页");
    const withProjects = [{id: "p1", name: "探针项目", organizationId: "org_probe", status: "active"}];
    check("有项目时这两张表单必须还在（守卫不能把杠杆藏掉）",
      /data-form="join-token"/u.test(renderOrg(withProjects, "org-agents"))
        && /data-form="project-member"/u.test(renderOrg(withProjects, "org-projects")),
      "有项目了却还在显示空态提示 —— 这两个入口被守卫吃掉了");
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
      agentDispatches: [{dispatchId: "adp1", taskGroupId: "tg1", workItemId: "w1", status: "queued"}],
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
      /已注册 2 个/.test(offlineView) && /agent 页/.test(offlineView),
      "只说没有在线节点，不说是一台都没装还是装了都挂了，人不知道下一步做什么");

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
    // 判据要各自独立：标题与提示里都写着"共 4000 个"，用同一个模式匹配的话，
    // 删掉标题那一处它照样绿（第一版就是这样）。
    check("明细页的小节标题要带上真实总数",
      /工作项（共 4000 个，当前展示 300 个）/.test(detailHtml),
      "工作项被截断到 300 条，小节标题却没说共有多少 —— 人一眼看到的就是那个假数字");
    check("提示里要写清只加载了前多少个",
      /只加载了前 300 个/.test(detailHtml),
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
    check("自治循环连续失败要在监控页上说出来",
      /连续 3 拍失败|没有任何东西在自行推进/.test(stalledView),
      "自治循环已经连续失败、系统实际停摆，监控页却一个字都不说 —— 人会一直以为它在跑");
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
  const base = {accounts: [{accountId: "acct_x", displayName: "某人", accountType: "user_account", status: "active"}], accessGrants: [], agents: []};
  // 截断提示从"每张表各自调一次"改成了整屏报一次（逐表调用要靠每次新增表时都记得，
  // 而界面上 23 张表里此前只有 5 张接了）。所以这里要按【整页】渲染，narrow probe 看不到外壳。
  const fullRoot = el("div");
  loadConsole(fullRoot).renderFullPageWith({...base}, admin, null, "sys-accounts");
  check("名单完整时不加多余提示",
    !String(fullRoot.innerHTML || "").includes("不要据此判断"),
    "名单没有被截断也提示了不完整 —— 误报会让人不再相信这个提示");
  const cappedRoot = el("div");
  loadConsole(cappedRoot).renderFullPageWith({...base, truncatedCollections: ["accounts"]}, admin, null, "sys-accounts");
  check("整表铺开的名单被截断时必须说出来",
    String(cappedRoot.innerHTML || "").includes("不要据此判断"),
    "账号名单被视图截断了，页面上却没有任何痕迹 —— 人会把它当成完整名单，据此判断谁有权限");
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
runWholeListCapCase();
runStuckTopologyLeverCase();
runBlockerGuideCase();
runSelfCheckReasonCase();
await runNoResponseGuidanceCase();
await runDoubleSubmitGuardCase();
runNoDeadHelperCase();
runPlanFinalizationNoticeCase();
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
    /不会有任何进展/.test(stalled) && /agent 页/.test(stalled),
    "只说没节点，不说这对他意味着什么、下一步做什么");
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
    /不需要你动手/.test(wipFull) && /agent 页/.test(wipFull),
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
    /直接在这里定稿或打回/.test(stalled),
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
  const projectScopedPages = new Set(["proj-overview", "tg", "review", "directives", "monitor", "proj-settings"]);
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
  for (const {collection, field} of dropped) {
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
    const hasExit = /人工指令|人工审核|运行时」页|agent 节点/.test(card);
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
    /只加载了前若干条/.test(cutHtml),
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
      !/只加载了前若干条/.test(String(fullRoot.innerHTML || "")),
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
  check("已吊销的节点不计入配额这件事要写出来",
    /已吊销.*不计入配额|不计入配额/.test(overviewHtml),
    "配额只数没被吊销的节点，而智能体那张表把已吊销的也列着 —— 两个数对不上，人找不出原因");
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
  const button = {dataset: {action: "logout"}, disabled: false, textContent: "登出"};
  button.closest = (selector) => (selector === "[data-action]" ? button : null);
  await probe.click({target: button, preventDefault: () => {}});
  const shown = stubSubtreeText(root);
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
  const scanState = (label, state, account, projectId, pages) => {
    const tCalls = new Map();
    const context = vm.createContext(makeContext(el("div")));
    context.window = {scrollTo: () => {}, addEventListener: () => {}, removeEventListener: () => {}};
    context.scrollTo = () => {};
    vm.runInContext(i18nSource, context, {filename: "i18n-zh.js"});
    const real = context.window.AIMAC_I18N;
    if (!real || typeof real.t !== "function") throw new Error("漏译扫描: 没能加载真的 i18n —— 本段在空转");
    // 数一数每页真正过了多少次 t()：只有外壳那点固定次数的页，等于它的枚举值从没被渲染过 ——
    // 这道扫描对那些页是空的。这个数不作为判据（页面本来就有繁简之分），但必须【报出来】，
    // 否则"渲染了 N 页、未命中 0 个"会被读成"N 页都查过了"。
    context.t = real.t;
    const inner = real.t;
    context.window.AIMAC_I18N.t = (value) => { tCalls.set(pageId, (tCalls.get(pageId) || 0) + 1); return inner(value); };
    let pageId = "?";
    context.console = {log: () => {}, error: () => {}, warn: (message) => {
      const hit = /未映射的枚举值：(.+)$/u.exec(String(message));
      if (!hit || looksGenerated(hit[1])) return;
      if (!misses.has(hit[1])) misses.set(hit[1], new Set());
      misses.get(hit[1]).add(`${label}/${pageId}`);
    }};
    vm.runInContext(appSource + PROBE_EPILOGUE, context, {filename: "app.js"});
    const done = [];
    for (const page of pages) {
      pageId = page;
      // 同一个上下文里 t 对每个未命中只 warn 一次，所以一条漏译只会记在最先碰到它的那一页上 ——
      // 页面名只是线索，判据是"有没有漏译"，不是"漏在哪几页"。
      context.__probe.renderFullPageWith(state, account, projectId, page);
      done.push(`${label}/${page}`);
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
    "org-agents", "org-projects", "proj-overview", "tg", "review", "directives", "monitor", "proj-settings"];
  for (const [label, state, account, projectId] of i18nScanStates) {
    scanned.push(...scanState(label, state, account, projectId, pages));
  }
  if (scanned.length < 14) failures.push(`漏译扫描: 只渲染了 ${scanned.length} 个页面 —— 本段在空转`);
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
        repositories: [{repositoryId: "repo_main", url: "https://example.invalid/repo.git", defaultBranch: "main",
          credentialRef: "env:GIT_TOKEN"}],
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
      context.window = {scrollTo: () => {}, addEventListener: () => {}, removeEventListener: () => {}};
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
      vm.runInContext(appSource + PROBE_EPILOGUE, context, {filename: "app.js"});
      try { await context.__probe.loadPageWith(state, pageAccount, projectId, page, fetchStub); }
      catch (error) { failures.push(`漏译扫描: ${page} 走 loadPage 抛错（${String(error?.message || error).slice(0, 100)}）—— 这一页没被检验`); }
      scanned.push(`${label}(走接口)/${page}`);
      pageTouchCounts.set(page, Math.max(pageTouchCounts.get(page) || 0, touched));
    }
  }
  // 判定必须在【全部扫描做完之后】：这一段起初写在走接口那四页之前，于是它们发现的漏译
  // 只进了计数、没进 failures —— 门报"未命中 1 个"却退出码 0。
  for (const [value, where] of misses) {
    failures.push(`漏译扫描: 中文界面上会显示英文枚举「${value}」（出现在 ${[...where].slice(0, 3).join("、")}）`
      + " —— 给它补中文，或者别把这个值直接交给 t()");
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
