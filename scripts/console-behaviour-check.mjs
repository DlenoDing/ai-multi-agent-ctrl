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
  handlerSource: (type) => String(globalThis.__handlers[type])
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

runFormRestoreCase();

if (failures.length) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("console behaviour gate ok: 提交失败后表单内容回填（含选项/口令排除/一次性消费/不串单/脏页标记）已行为验证");
