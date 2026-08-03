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

  #descendants() {
    return this.children.flatMap((child) => [child, ...child.#descendants()]);
  }

  #matches(selector) {
    const tagList = selector.split(",").map((part) => part.trim());
    if (tagList.every((part) => /^[a-z]+$/.test(part))) {
      return tagList.some((tag) => this.tagName === tag.toUpperCase());
    }
    const named = selector.match(/^\[name="(.*)"\]$/s);
    if (named) return this.name === named[1].replace(/\\(.)/g, "$1");
    const formSel = selector.match(/^form\[data-form\]$/);
    if (formSel) return this.tagName === "FORM" && this.dataset.form !== undefined;
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

function makeContext(documentRoot) {
  const noop = () => {};
  const context = {
    console,
    setInterval: () => 0,
    clearInterval: noop,
    setTimeout: () => 0,
    clearTimeout: noop,
    CSS: {escape: (value) => String(value).replace(/["\\]/g, "\\$&")},
    fetch: async () => { throw new Error("行为门不应发起网络请求"); },
    WebSocket: class { constructor() { this.close = noop; } },
    location: {origin: "http://localhost", protocol: "http:", host: "localhost", href: "http://localhost/"},
    sessionStorage: {getItem: () => null, setItem: noop, removeItem: noop},
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
  renderSysSettingsWith: (nextState, instructions) => { state = nextState; if (instructions !== undefined) instructionState = instructions; return renderSysSettings(); },
  renderSysAccountsWith: (nextState, account) => { state = nextState; currentAccount = account; return renderSysAccounts(); },
  blockerGuide: (type) => blockerGuide(type),
  renderMonitorWith: (nextState, account, projectId) => { state = nextState; currentAccount = account; currentProjectId = projectId; return renderMonitor(); },
  setFetch: (fn) => { globalThis.fetch = fn; },
  api: (path, options) => api(path, options)
};
`;

function loadConsole(documentRoot) {
  const source = fs.readFileSync(path.join(root, "apps/control-plane-ui/public/app.js"), "utf8");
  const context = vm.createContext(makeContext(documentRoot));
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

/* ---------------- 断言 ---------------- */

const failures = [];
function check(name, condition, detail) {
  if (!condition) failures.push(`${name}: ${detail}`);
}

// 场景：人在「打回并要求重做」表单里写了一大段理由，提交时撞上 expectedRound 409
// （并发下的正常回答，不是故障）。整页重渲染之后，那段理由必须还在。
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

// 服务端在不少错误里写了给人看的说明（message / reason / required）。前端原先只取 error 一个字段，
// 于是一条本来解释清楚了"为什么、接下来怎么办"的 409，到人眼前只剩一串英文枚举。
async function runErrorGuidanceCase() {
  const probe = loadConsole(el("div"));
  const cases = [
    {payload: {error: "org_member_invitation_pending", message: "该成员尚未接受邀请，不能启用"}, expect: "该成员尚未接受邀请"},
    {payload: {error: "policy_denied", reason: "组织已被暂停"}, expect: "组织已被暂停"},
    {payload: {error: "server_side_agent_execution_forbidden", required: ["请先注册一个 Agent Runtime 节点"]}, expect: "请先注册一个 Agent Runtime 节点"}
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

  // 红点只能统计"这个人有权处置"的项。把别人负责的也算进来，那个数字就永远清不掉 ——
  // 人每次打开都看到"还有 N 项等你处理"，点进去无事可做，最后学会无视它。
  // 决定"哪些项算数"的 taskGroups 自己也会被截断：超出上限的任务组下的待办连桶都进不去。
  // 只看桶自身的集合有没有被截，会漏掉这一整类丢失，而界面照样报一个精确数字。
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
  const probe = loadConsole(el("div"));
  const admin = {accountId: "acct_a", accountType: "system_admin"};
  const base = {accounts: [{accountId: "acct_x", displayName: "某人", accountType: "user_account", status: "active"}], accessGrants: [], agents: []};
  const full = probe.renderSysAccountsWith({...base}, admin);
  check("名单完整时不加多余提示",
    !full.includes("不要据此判断"),
    "名单没有被截断也提示了不完整 —— 误报会让人不再相信这个提示");
  const capped = probe.renderSysAccountsWith({...base, truncatedCollections: ["accounts"]}, admin);
  check("整表铺开的名单被截断时必须说出来",
    capped.includes("不要据此判断"),
    "账号名单被视图截断了，页面上却没有任何痕迹 —— 人会把它当成完整名单，据此判断谁有权限");
}

// 卡住的执行方案会永久挡住关闭门，而"人来取消"这条杠杆后端一直有、界面上却没有入口。
// 后端有杠杆而界面没有入口，等于这个杠杆不存在。
// 关闭门阻塞类型有 16 种，而"阻塞项人工处置"只处理其中 6 种。指引必须按类型说清去哪；
// 对系统自行清除的那几类，必须明说"不用你动手"——否则人会守着一个不该他管的红点。
function runBlockerGuideCase() {
  const probe = loadConsole(el("div"));
  const covered = ["HumanConfirmationRequest", "PermissionOrApprovalRequest", "HumanDirective", "ReviewPlan",
    "ReviewBundle", "SharedDefinitionContract", "ExecutionTopology", "WorkSession", "AgentDispatch", "Lease",
    "RoleDriftGuard", "CommandEffect", "DerivedTaskRequest", "WorkItem", "Checkpoint", "RepositoryOutputTarget"];
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
runWholeListCapCase();
runStuckTopologyLeverCase();
runBlockerGuideCase();
runSelfCheckReasonCase();
await runNoResponseGuidanceCase();
await runDoubleSubmitGuardCase();
runNoDeadHelperCase();
runRoomVisibilityCase();
runDecisionSelectCase();
await runErrorGuidanceCase();

if (failures.length) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("console behaviour gate ok: 提交失败保内容（选项/口令排除/一次性消费/不串单/脏页标记/两处接线）与房间协作记录对人可见（含空态与取数接线）已行为验证");
