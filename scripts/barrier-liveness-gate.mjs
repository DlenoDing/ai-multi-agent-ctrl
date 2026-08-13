#!/usr/bin/env node
// 空转门检查（barrier liveness gate）
//
// 关闭门的每一项都是一句形如「集合里还有 status 属于 X 的对象吗」的判断。如果 X 里写的字符串
// 该实体根本不可能取到，这道门就永远不会触发 —— 它在控制台上显示为「已通过」，人以为被检查过了，
// 其实从来没有检查过任何东西。这比没有这道门更糟：没有门至少不会给人虚假的安全感。
//
// 本门以 spec/state-machines.yaml 登记的状态集为权威，交叉核对 control-plane-core.mjs 里
// gateFailures 内所有与 `.status` 比较的字符串字面量。任一字面量不是该实体的已登记状态即失败。
//
// 之所以要有这道结构门而不是逐个修：这一类缺陷是"写门的人凭印象拼状态名"造成的，
// 只要还能凭印象拼，下一个新门就会再犯。
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

// 实体状态机登记表：实体名 -> {states, terminal}
function loadStateMachines() {
  const source = read("spec/state-machines.yaml");
  const machines = {};
  const entityRe = /^ {2}([A-Za-z]+):[ \t]*$/gm;
  const marks = [...source.matchAll(entityRe)];
  marks.forEach((mark, index) => {
    const body = source.slice(mark.index + mark[0].length, index + 1 < marks.length ? marks[index + 1].index : source.length);
    // 状态列表里允许夹注释 —— 解析器必须容忍，否则一条说明就能让本门对整个实体失明
    // （而失明的表现是"该实体的状态一个都不认识"，看起来像代码错了，其实是本门错了）。
    const states = body.match(/^ {4}states:\s*\n((?:(?: {6}(?:- "[^"]+"|#[^\n]*)|\s*)\n)+)/m);
    const terminal = body.match(/^ {4}terminal:\s*\[(.*?)\]/m);
    if (states) {
      machines[mark[1]] = {
        states: [...states[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]),
        terminal: terminal ? [...terminal[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []
      };
    }
  });
  return machines;
}

// state.<集合> / 取集合的辅助函数 -> 状态机实体名。
// 新增一个被关闭门检查的集合时必须在此登记，否则 unmappedCollections 会失败 —— 不允许悄悄绕过本门。
const COLLECTION_ENTITY = {
  allWorkItems: "WorkItem",
  workItems: "WorkItem",
  commands: "Command",
  readiness: "CompletionReadinessCheck",
  findings: "Finding",
  qualityGates: "QualityGate",
  repositoryOutputs: "RepositoryOutputTarget",
  permissionRequests: "PermissionRequest",
  approvalRequests: "ApprovalRequest",
  commandEffects: "CommandEffect",
  dlqEntries: "DLQEntry",
  leases: "Lease",
  mcpGrants: "TempGrant",
  artifacts: "Artifact",
  ruleSourceResolutions: "RuleSourceResolution",
  systemUpgradeCandidates: "SystemUpgradeCandidate",
  executionTopologies: "ExecutionTopology",
  derivedTaskRequests: "DerivedTaskRequest",
  reviewPlans: "ReviewPlan",
  reviewBundles: "ReviewBundle",
  humanConfirmationRequests: "HumanConfirmationRequest",
  humanDirectives: "HumanDirective",
  effectiveInstructionPackets: "EffectiveInstructionPacket",
  relatedSharedDefinitions: "SharedDefinitionContract",
  workSessions: "WorkSession",
  agentDispatches: "AgentDispatch",
  roleDriftGuards: "RoleDriftGuard"
};

// 全仓被写入过的 status 字面量。与门检查共用同一份提取，避免两处各写一套而慢慢分叉。
const PRODUCER_SOURCES = ["apps/control-plane-ui/lib/control-plane-core.mjs", "apps/control-plane-ui/server.mjs",
  "apps/mcp-server/server.mjs", "apps/control-plane-ui/lib/agent-gateway.mjs", "apps/agent-runtime/runtime.mjs"];

function loadProducedStatuses() {
  const produced = new Set();
  for (const rel of PRODUCER_SOURCES) {
    let text = "";
    try { text = read(rel); } catch { continue; }
    for (const match of text.matchAll(/(?:\.status\s*=|\bstatus:)\s*([^;\n]+)/g)) {
      for (const literal of match[1].matchAll(/"([^"]+)"/g)) produced.add(literal[1]);
    }
  }
  return produced;
}

// 终态的生产者必须按实体归属，不能用全局字面量池。第一版就是用全局池写的，结果把 AgentNode
// 改回原来那个无人写入的终态 retired 时，本门一声不吭 —— 因为 WorkerLane 有 lane.status = "retired"，
// 于是"retired 被写过"成立。这正是我在别处记过的空转形态：跨实体通用的状态名。
// 所以终态这条按【赋值目标变量】归属：lane.status 只算 WorkerLane 的，不算 AgentNode 的。
// 变量名有歧义的（request 可能是四种请求之一）映射成一个集合，宁可放宽也不误报。
const VAR_MACHINES = {
  workItem: ["WorkItem"], expiredWorkItem: ["WorkItem"], blockedItem: ["WorkItem"], project: ["Project"],
  dispatch: ["AgentDispatch"], session: ["WorkSession"], command: ["Command"], effect: ["CommandEffect"],
  topology: ["ExecutionTopology"], node: ["AgentNode"], taskGroup: ["TaskGroup"], account: ["Account"],
  request: ["PermissionRequest", "ApprovalRequest", "HumanConfirmationRequest", "DerivedTaskRequest"],
  target: ["RepositoryOutputTarget"], repositoryTarget: ["RepositoryOutputTarget"],
  source: ["AgentSkillSource"], lease: ["Lease"], lane: ["WorkerLane"], guard: ["RoleDriftGuard"],
  entry: ["DLQEntry"], directive: ["HumanDirective"], overlay: ["RoleSkillOverlay"], grant: ["TempGrant", "AccessControlGrant"],
  definition: ["SharedDefinitionContract"], pattern: ["RuntimeIssuePattern"], gate: ["QualityGate"],
  artifact: ["Artifact"], candidate: ["SystemUpgradeCandidate"],
  // 人工指令的暂停/恢复分支里，被停住与被放回的都是派发。
  running: ["AgentDispatch"], parked: ["AgentDispatch"],
  // 控制命令被节点连续拒绝、重试用尽时改写的那两个对象。
  failedSession: ["WorkSession"], failedWorkItem: ["WorkItem"], stuck: ["AgentDispatch"],
  // 不是控制对象：branch 是 git 分支名，record/entry 之类若指向无状态机的对象则映射为空集。
  branch: [], record: [],
  bundle: ["ReviewBundle"], plan: ["ReviewPlan"], finding: ["Finding"],
  // 这几个对象没有状态机（Organization/Account 的 agents 条目/规则片段/质量门检查项另有归属）
  agent: [], clean: [], organization: [], existing: ["QualityGate"],
  resolution: ["RuleSourceResolution"], error: [], member: []
};

// 表达式里的【取值位】是不是全为字面量。三元的条件部分不算取值位：
// `passed ? "passed" : "failed"` 是可判的，`closesFinding ? status : "open"` 不可判（一个分支是变量）。
// 只看有没有字面量是不够的 —— 半动态会被当成可判，于是"另一个分支写的什么"被当成不存在。
function statusExpressionIsDecidable(expression) {
  const valuePart = expression.includes("?") ? expression.slice(expression.indexOf("?") + 1) : expression;
  return !/[A-Za-z_$][\w$]*/.test(valuePart.replace(/"[^"]*"/g, ""));
}

function loadTerminalProducers() {
  const byMachine = new Map();
  const unregistered = new Set();
  // 动态赋值（bundle.status = nextStatus）里提不出字面量。对这类机器只能说"判不了"，
  // 不能说"终态不可达" —— 把看不出来报成有问题，是本门最容易犯也最招人厌的错。
  const dynamic = new Set();
  for (const rel of PRODUCER_SOURCES) {
    let text = "";
    try { text = read(rel); } catch { continue; }
    // 必须排除比较：`item.status === "x"` 里的 \s*=\s* 会匹配到 === 的第一个等号，
    // 把一大批【读】误当成【写】。第一版就是这么错的，表现是登记表里冒出十几个根本不写状态的变量名。
    for (const match of text.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\.status\s*(?<![=!<>])=(?!=)\s*([^;\n]+)/g)) {
      const [, variable, expression] = match;
      const machines = VAR_MACHINES[variable];
      if (!machines) { unregistered.add(variable); continue; }
      const statuses = [...expression.matchAll(/"([^"]+)"/g)].map((literal) => literal[1]);
      if (!statuses.length || !statusExpressionIsDecidable(expression)) {
        for (const machine of machines) dynamic.add(machine);
        continue;
      }
      for (const machine of machines) {
        if (!byMachine.has(machine)) byMachine.set(machine, new Set());
        for (const status of statuses) byMachine.get(machine).add(status);
      }
    }
  }
  return {byMachine, unregistered, dynamic};
}

// 建模先于实现的机器：登记在这里的，表示"知道它现在没有实现，是有意的"。
// 不登记就必须失败 —— AgentNode 就是这么装饰了很久的：它建模的唯一终态 retired 没有任何生产者，
// 运行时真正的终态 revoked 又没进模型，而没有任何一道检查会因此出声。
//
// 判据只取【整台机器一个状态都没写过】和【终态一个都没写过】这两条，不逐个状态查：全仓 395 个
// 登记状态里有 30% 没有生产者，逐个登记会变成 117 条噪声，而噪声多的门等于没有门。
// 整机死与终态死则是低噪声高信号 —— 前者说明这台机器纯属文档，后者说明这类对象永远无法终结。
const MODELED_AHEAD_OF_IMPLEMENTATION = {
  AuditLog: "审计走的是 runtime/audit-log.jsonl 追加文件，不是 state 里的状态机对象",
  Alert: "告警子系统尚未实现，没有任何代码产生 Alert 对象",
  ProgressSnapshot: "进度快照是被裁剪掉的，不走 archived 终态",
  // 下面这台是【真的缺一条路】，不是建模错误 —— 登记在这里是为了让缺口有名有姓，而不是让门闭嘴。
  // 同批登记的另外两台已经补上：AgentSkillSource 有了 retired（5572fbe），
  // RuntimeIssuePattern 有了 suppressed/closed（人在升级候选上的判断传导下来）。
  Account: "账号只有 active/suspended，没有退役路径（与项目无归档、maxProjects 只增不减同源的产品缺口）"
};

// 机器是不是活的：它至少要有一个状态被真的写过；有终态的话，终态里至少要有一个写得到 ——
// 否则这类对象在生产中永远无法终结，而模型看起来一切正常。
export function checkMachineLiveness() {
  const machines = loadStateMachines();
  const produced = loadProducedStatuses();
  const failures = [];
  if (Object.keys(machines).length < 40) {
    return [`机器活性检查: 只解析到 ${Object.keys(machines).length} 台状态机，远少于预期 —— 解析器已与 spec 脱节，本检查在空转`];
  }
  const {byMachine, unregistered, dynamic} = loadTerminalProducers();
  // 登记表必须跟着代码走：出现没登记的赋值目标就说出来，否则本门会悄悄少看一部分生产者，
  // 表现为"某台机器的终态没人写" —— 又是一次把本门自己的脱节报成代码有问题。
  if (unregistered.size) {
    failures.push(`机器活性检查: 这些 .status 赋值目标没有登记到 VAR_MACHINES，本门无法把它们归属到实体：`
      + `${[...unregistered].sort().join(", ")} —— 登记它们（或映射为空集，表示不是控制对象）`);
  }
  for (const [name, machine] of Object.entries(machines)) {
    const registered = Object.prototype.hasOwnProperty.call(MODELED_AHEAD_OF_IMPLEMENTATION, name);
    const anyProduced = machine.states.some((state) => produced.has(state));
    const terminals = machine.terminal || [];
    // 终态按实体归属判断；这台机器完全没有可归属的赋值目标时（例如只在对象字面量里创建、
    // 从不逐个赋值），退回全局池 —— 宁可放过，也不要制造一堆无法处置的误报。
    const own = dynamic.has(name) ? null : byMachine.get(name);
    const anyTerminalProduced = !terminals.length || dynamic.has(name)
      || (own ? terminals.some((state) => own.has(state)) : terminals.some((state) => produced.has(state)));
    if (!anyProduced && !registered) {
      failures.push(`机器活性检查: ${name} 的状态一个都没有被代码写入过（${machine.states.join("/")}）—— 这台状态机纯属文档，`
        + "要么补实现，要么登记进 MODELED_AHEAD_OF_IMPLEMENTATION 说明这是有意的");
    } else if (!anyTerminalProduced && !registered) {
      failures.push(`机器活性检查: ${name} 的终态 ${JSON.stringify(terminals)} 没有任何一个被代码写入过 —— `
        + "这类对象在生产中永远无法终结（AgentNode 此前正是如此：建模的终态无人写入，真正的终态没进模型）");
    }
    // 登记表本身也会过期：实现补上之后要把它从登记表里拿掉，否则它会继续替将来的漂移打掩护。
    // 但"过期"必须以【可归属的证据】为准，不能用全局池 —— 实测：给 Project 加了 archived 的写入之后，
    // ProgressSnapshot（没有可归属的赋值目标、退回全局池）也被判成"终态可达了"，而它其实一步没动。
    // 用全局池去要求别人撤销登记，等于让一个实体的实现去注销另一个实体的缺口登记。
    const terminalProducedByOwnWrites = Boolean(own) && terminals.some((state) => own.has(state));
    if (registered && anyProduced && terminalProducedByOwnWrites) {
      failures.push(`机器活性检查: ${name} 已登记为"建模先于实现"，但它现在已有生产者且终态可达 —— `
        + "请把它从 MODELED_AHEAD_OF_IMPLEMENTATION 里移除，否则这条登记会替以后的漂移打掩护");
    }
  }
  return failures;
}

export function checkBarrierLiveness() {
  const machines = loadStateMachines();
  const source = read("apps/control-plane-ui/lib/control-plane-core.mjs");
  const failures = [];
  const failuresBootstrap = failures;

  // 阻塞判据有两块：completion readiness 的 checkFailures 与关闭门的 gateFailures。
  // 只扫其中一块，本门自己就是半空转的 —— 另一块里同样有从不触发的判据。
  const blocks = [];
  for (const name of ["checkFailures", "gateFailures"]) {
    const block = source.match(new RegExp(`const ${name} = \\{(.*?)\\n {2}\\};`, "s"));
    if (!block) return [`空转门检查: 找不到 ${name} 块（阻塞判据结构已变，本门失效，必须同步更新）`];
    blocks.push(block[1]);
  }
  // 阻塞判据并不都写在对象字面量里：WorkSession / AgentDispatch / Lease 三条是独立的
  // `if (...) blockers.push(...)`。只扫对象字面量的话，本门对它们完全失明 —— 而实测那三条里
  // 恰好就藏着未登记的状态漂移。凡是往 blockers 里 push 的判据都必须进入扫描范围。
  const pushLines = [...source.matchAll(/^ {2}if \(\(state\.[\s\S]*?blockers\.push\(\{objectType: "([A-Za-z]+)".*$/gm)]
    .map((match) => `blocker_${match[1]}: ${match[0].trim()}`);
  if (pushLines.length < 3) failuresBootstrap.push(`空转门检查: 只识别到 ${pushLines.length} 条 blockers.push 判据（少于已知的 3 条，提取逻辑与代码脱节）`);
  blocks.push(pushLines.join("\n"));

  // 具名状态常量（pendingStatuses / FOO_TERMINAL 之类）展开成字面量集合
  const namedSets = {};
  // 字面量数组：const X = [...] / new Set([...]) / Object.freeze([...])
  for (const match of source.matchAll(/const ([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:Object\.freeze\(|new Set\(|)+\s*\[(.*?)\]/gs)) {
    namedSets[match[1]] = [...match[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  }
  // 再解一层别名：const COMMAND_TERMINAL = new Set(COMMAND_TERMINAL_STATES);
  // 不解这一层的话，凡是这样写的门在本门眼里"一个状态字面量都没有"，于是被静默跳过 ——
  // 实测正是这样：all_commands_terminal / all_command_effects_terminal / no_active_dlq /
  // no_unreconciled_command_effect 四道门从来没有被空转检查覆盖过，而本门存在的全部意义就是覆盖它们。
  for (const match of source.matchAll(/const ([A-Za-z_][A-Za-z0-9_]*)\s*=\s*new Set\(([A-Za-z_][A-Za-z0-9_]*)\)/gu)) {
    if (namedSets[match[2]] && !namedSets[match[1]]) namedSets[match[1]] = namedSets[match[2]];
  }

  // 全仓实际被写入过的 status 值（含 seed 与测试夹具外的生产代码）。
  const producerSources = ["apps/control-plane-ui/lib/control-plane-core.mjs", "apps/control-plane-ui/server.mjs",
    "apps/mcp-server/server.mjs", "apps/control-plane-ui/lib/agent-gateway.mjs", "apps/agent-runtime/runtime.mjs"];
  const producedStatuses = new Set();
  for (const rel of producerSources) {
    let text = "";
    try { text = read(rel); } catch { continue; }
    // 写入形态不止 `x.status = "a"` 一种：对象字面量里的 `status:`、三元、嵌套三元都算写入。
    // 提取不全会把"其实有生产者"的状态误判成空转 —— 本门自身的误报同样是要防的。
    for (const match of text.matchAll(/(?:\.status\s*=|\bstatus:)\s*([^;\n]+)/g)) {
      for (const literal of match[1].matchAll(/"([^"]+)"/g)) producedStatuses.add(literal[1]);
    }
  }

  // 按【条目】切，不按行切。逐行分析有个潜伏盲区：一道门只要换行写，
  // 带门名的那一行就看不到 .status、带 .status 的那一行又没有门名 —— 这道门于是被静默跳过，
  // 而 checked 只少 1，固定阈值那条自检根本发现不了。今天恰好没有跨行条目，
  // 但"今天恰好没有"不是判据。（本会话已经两次栽在"提取认不全真实写法"上。）
  const allLines = blocks.join("\n").split("\n");
  const entries = [];
  for (let index = 0; index < allLines.length; index += 1) {
    const head = allLines[index].trim();
    if (!head || !head.includes(":")) continue;
    const name = head.slice(0, head.indexOf(":")).trim();
    if (!/^[a-z_]+$/.test(name) && !name.startsWith("blocker_")) continue;
    let end = index + 1;
    while (end < allLines.length) {
      const next = allLines[end].trim();
      const nextName = next.includes(":") ? next.slice(0, next.indexOf(":")).trim() : "";
      if (next && (/^[a-z_]+$/.test(nextName) || nextName.startsWith("blocker_"))) break;
      end += 1;
    }
    entries.push({name, text: allLines.slice(index, end).join("\n")});
  }
  const statusEntries = entries.filter((entry) => /\.status\b/.test(entry.text));

  let checked = 0;
  const skipped = [];
  // 一个条目可能同时比较【两个集合】（如 no_pending_permission_or_approval 同时看授权与审批）。
  // 整段按一个实体去核对会把另一个实体的合法状态误判成"凭印象拼写"。所以按集合出现处分段：
  // 每一段从一个已登记集合名开始，到下一个集合名为止，各自用自己的实体核对。
  const segments = [];
  for (const entry of statusEntries) {
    const hits = [];
    for (const name of Object.keys(COLLECTION_ENTITY)) {
      for (const match of entry.text.matchAll(new RegExp(`\\b${name}\\b`, "gu"))) hits.push({name, at: match.index});
    }
    hits.sort((left, right) => left.at - right.at);
    if (!hits.length) { segments.push({name: entry.name, text: entry.text, collection: null}); continue; }
    hits.forEach((hit, index) => {
      const end = index + 1 < hits.length ? hits[index + 1].at : entry.text.length;
      const text = entry.text.slice(hit.at, end);
      if (/\.status\b/.test(text)) segments.push({name: entry.name, text, collection: hit.name});
    });
  }
  for (const entry of segments) {
    const line = entry.text;
    const gateName = entry.name;
    const collection = entry.collection;
    if (!collection) {
      skipped.push(`${gateName}(集合未登记)`);
      failures.push(`空转门检查: 门 ${gateName} 检查了 .status 但集合未登记到 COLLECTION_ENTITY（无法核对，等于绕过本门）`);
      continue;
    }
    const entity = COLLECTION_ENTITY[collection];
    const machine = machines[entity];
    if (!machine) {
      skipped.push(`${gateName}/${entity}(未登记状态机)`);
      failures.push(`空转门检查: 实体 ${entity} 未在 spec/state-machines.yaml 登记状态集（门 ${gateName} 的状态名无从核对）`);
      continue;
    }
    // 与 .status 比较的字面量：数组字面量里的 + === 右侧的 + 引用的具名状态常量
    const literals = [];
    for (const arr of line.matchAll(/\[([^\]]*?)\]\s*\.includes\(\s*[\w.?]*\.status/g)) {
      literals.push(...[...arr[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
    }
    for (const eq of line.matchAll(/\.status\s*[!=]==\s*"([^"]+)"/g)) literals.push(eq[1]);
    for (const named of line.matchAll(/([A-Z_a-z]+(?:STATUSES|TERMINAL|Statuses))(?:\.has|\.includes)\(\s*[\w.?]*\.status/g)) {
      if (namedSets[named[1]]) literals.push(...namedSets[named[1]]);
    }
    for (const named of line.matchAll(/([A-Z_a-z]+(?:STATUSES|TERMINAL|Statuses))\.includes\(/g)) {
      if (namedSets[named[1]] && /\.status/.test(line)) literals.push(...namedSets[named[1]]);
    }
    // 段里比较了 status，却一个状态字面量都没提取到 —— 那不是"没什么可查"，
    // 是提取没认出这里的写法（变量、模板串、具名常量换了命名规则都会这样）。要说出来。
    if (!literals.length) { skipped.push(`${gateName}/${collection}(没提取到状态字面量)`); continue; }
    checked += 1;
    const unique = [...new Set(literals)];
    // 第二层：状态名登记了不代表它会出现。真正要问的是 ——【什么状态会让这道门触发，
    // 那些状态有没有生产者】。否定式判据（!TERMINAL.includes(status) 即阻塞）尤其容易漏：
    // 门里写的字面量全都是终态、也都有生产者，可是能让它触发的那些非终态一个都没人写，
    // 于是门照样永远不响。这一整类空转门都只有这样才查得出来。
    const negated = /!\s*(?:\[|[A-Z_a-z]+(?:STATUSES|TERMINAL|Statuses))/.test(line);
    const firingStates = negated ? machine.states.filter((st) => !unique.includes(st)) : unique;
    if (firingStates.length && !firingStates.some((st) => producedStatuses.has(st))) {
      failures.push(`空转门检查: 门 ${gateName} 只有当 ${entity} 处于 ${JSON.stringify(firingStates)} 之一时才会触发，而这些状态全仓没有任何代码写入过 —— 这道门永远不会响`);
    }
    const dead = unique.filter((literal) => !machine.states.includes(literal));
    if (dead.length === unique.length) {
      failures.push(`空转门检查: 门 ${gateName} 是空转门 —— 它检查的状态 ${JSON.stringify(dead)} 没有一个是 ${entity} 的已登记状态（${machine.states.join("/")}），这道门永远不会触发，却在控制台上显示为已通过`);
    } else if (dead.length) {
      failures.push(`空转门检查: 门 ${gateName} 混入了 ${entity} 不存在的状态 ${JSON.stringify(dead)}（状态名凭印象拼写，实际判据与设计意图不符）`);
    }
  }

  // 自检从"魔数下限"改成【精确相等】：凡是文本里比较过 status 的条目，都必须被核对过。
  // 少一个就说明切分或登记出了问题，而不是"还在阈值以上所以没事"。下限那条保留，防两侧一起塌。
  // 每一个"比较了 status 的段"都必须被核对过。少一个就是有东西被静默跳过，
  // 而不是"还在阈值以上所以没事"。同时要求每个条目至少产出一段，否则条目整个消失也发现不了。
  if (checked !== segments.length) {
    failures.push(`空转门检查: 切出 ${segments.length} 段比较 status 的判据，却只核对了 ${checked} 段 —— 有判据被静默跳过`
      + `（跳过的：${skipped.join("、") || "未记录，说明还有一条没走 skipped"}）`);
  }
  const coveredEntries = new Set(segments.map((segment) => segment.name));
  const droppedEntries = statusEntries.filter((entry) => !coveredEntries.has(entry.name)).map((entry) => entry.name);
  if (droppedEntries.length) {
    failures.push(`空转门检查: 这些判据比较了 status 却一段都没切出来：${droppedEntries.join("、")} —— 切分逻辑与代码脱节`);
  }
  if (checked < 20) failures.push(`空转门检查: 仅核对到 ${checked} 道涉及 status 的关闭门，远少于预期 —— 提取逻辑已与代码脱节，本门可能在空转（本门自身也不许空转）`);
  return failures;
}

// 导出了却没有任何地方调用的函数，就是一条【够不到的杠杆】。本仓已经为这个形状交过学费：
// 后端有取消执行方案的能力而界面没入口、恢复钩子挂在跑不到的退出路径上、判据写好却没接在
// 写入路径上。共同点是读代码时看着能力都在，跑起来那条路根本不存在。
// 更危险的一种是【被替换掉的旧实现还留着导出】：revokeAgentNode 把吊销凭据与重排派发绑在
// 一起，正是后来被拆开修掉的缺陷，谁把它接上去就会把已修的问题重新引回来。
//
// 例外必须有名有姓地登记，并写清为什么 —— 登记是为了让缺口可见，不是为了让门闭嘴。
const DEAD_EXPORT_ACCEPTED = {
  cancelCommand: "命令总线的失败分支：生产上只走 runCommandLifecycle 的成功路径，failCommand/retryCommand 无人调用，因此 running->cancelled 不可达",
  compensateCommand: "同上：failed->compensated 依赖命令先失败，而生产上命令不会失败",
  discardDlqEntry: "同上：死信条目只由 retryCommand 超限产生，生产上从不产生，因此 assigned->discarded 不可达",
  // 下面这些【有人调，但只有门在调】。整族凑齐才看得清全貌：命令总线的失败-重试-死信这一层
  // 代码齐全、spec 建了模、关闭屏障有判据、界面有指引，而产品的写入路径一次都到不了它。
  // 之前只登记了三个"零引用"的，另外六个因为门里调过就被算成"接上了" —— 同一族里
  // 一半可见一半隐身，看代码的人会以为这套东西在跑。
  failCommand: "只有契约门在调：生产上 runCommandLifecycle 一路走到 succeeded，没有产生 failed 的路径",
  retryCommand: "只有契约门在调：没有失败就没有重试",
  toDlq: "只有契约门在调：要先 failed 才进死信，而 failed 到不了",
  classifyDlqEntry: "只有契约门在调：死信条目产生不出来，处置动作自然也到不了",
  assignDlqEntry: "同上",
  replayDlqEntry: "同上",
  relatedSharedDefinitionsForTest: "名字里就写明是测试辅助，专为门导出",
  // 这一条不是"暂时没接上"，是【生产上根本没有这种对象】：真实授权是 state.accessGrants
  // （subjectRef/resource/role/permissions，由 server.mjs 三处与 core 一处 push 出来），
  // 而 spec/mcp-grant.schema.json 描述的 MCP 调用信封没有任何生产者。于是契约门那条
  // schema 校验校的是本函数造出来的夹具，不是真实产出 —— 记在这里免得它被当成覆盖率。
  // 也别顺手把它接上：它默认发 workId:"*"、30 天有效期、只读工具直接 approval:not-required。
  createMcpGrant: "MCP 授权信封在生产上没有产生者：只有契约门拿它造夹具校 schema"
};

// 扫哪些文件也不手维护：apps/ 下每个带导出函数的模块都算。手列的那份漏了三个
// （pg-sync-store / project-event-store / transition-engine），而漏掉的模块等于没在看。
function deadExportFiles() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".mjs") && /^export function /mu.test(fs.readFileSync(full, "utf8"))) {
        found.push(path.relative(root, full));
      }
    }
  };
  walk(path.join(root, "apps"));
  if (found.length < 6) throw new Error(`只扫到 ${found.length} 个带导出的产品模块 —— 与目录结构脱节，死导出检查在少看`);
  return found.sort();
}

// 哪些是"验证代码"不能手维护 —— 清单一漂，被漏掉的门就重新变成合法调用方。
// 按 package.json 推导：凡被 doctor 的 npm-run 闭包引用过的脚本都算验证代码。
// 反过来按"两边都引用就算产品"会漏：mutation-gate.mjs 同时挂在 mutation-anchors（在闭包里）
// 和 mutation-gate（不在）名下，于是被判成产品，它那份变异清单里的函数名就成了合法调用方。
// 唯一两边都用的包装器 run-with-env.mjs 只做 import(argv[2])，不引用任何产品导出，排除它无害。
function verificationScripts() {
  const scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts || {};
  const filesOf = (command) => [...command.matchAll(/scripts\/([\w.-]+\.mjs)/gu)].map((match) => match[1]);
  const reachable = new Set();
  const walkCommand = (name) => {
    if (reachable.has(name) || !scripts[name]) return;
    reachable.add(name);
    for (const match of scripts[name].matchAll(/npm run (?:-s )?([\w:-]+)/gu)) walkCommand(match[1]);
  };
  walkCommand("doctor");
  const result = new Set();
  for (const [name, command] of Object.entries(scripts)) {
    if (!reachable.has(name)) continue;
    for (const file of filesOf(command)) result.add(path.join(root, "scripts", file));
  }
  if (result.size < 8) throw new Error(`验证脚本只推导出 ${result.size} 个 —— 与 package.json 脱节，死导出检查会把门算成调用方`);
  return result;
}

function sourceCorpus() {
  const files = [];
  const verification = verificationScripts();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if ([".git", "node_modules", ".runtime"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // 排除本门自身：例外登记表里就写着这些函数名，把自己算进去会让每一条登记都被判成"已接上"。
      // 也排除验证代码：门调过不等于产品到得了。把门算成调用方，会让"只有门在调"的
      // 整族机制隐身 —— 这正是死信那一层此前只露出三分之一的原因。
      else if (/\.(mjs|js)$/u.test(entry.name) && full !== fileURLToPath(import.meta.url)
        && !verification.has(full)) files.push(full);
    }
  };
  walk(root);
  // 展开语法 ...fn(x) 前面也是点号，不去掉就会把真的在用的函数判成死代码 —— 而假红会把人
  // 派去删掉有用的东西，比漏报更坏（这条判据第一版就栽在这里）。
  return files.map((file) => fs.readFileSync(file, "utf8")).join("\n").replace(/\.\.\./gu, " ");
}

export function checkNoDeadExports() {
  const failures = [];
  const corpus = sourceCorpus();
  let scanned = 0;
  for (const relative of deadExportFiles()) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    const names = [...source.matchAll(/^export function ([A-Za-z0-9_]+)\(/gmu)].map((match) => match[1]);
    scanned += names.length;
    for (const name of names) {
      const uses = corpus.match(new RegExp(`(^|[^A-Za-z0-9_.])${name}(?![A-Za-z0-9_])`, "gu")) || [];
      if (uses.length > 1) continue;
      if (Object.prototype.hasOwnProperty.call(DEAD_EXPORT_ACCEPTED, name)) continue;
      failures.push(`死导出检查: ${relative} 导出的 ${name} 没有任何地方调用或引用 —— 这是一条够不到的杠杆；`
        + "要么接上它，要么删掉它，要么在 DEAD_EXPORT_ACCEPTED 里写明为什么它现在到不了");
    }
  }
  for (const name of Object.keys(DEAD_EXPORT_ACCEPTED)) {
    const uses = corpus.match(new RegExp(`(^|[^A-Za-z0-9_.])${name}(?![A-Za-z0-9_])`, "gu")) || [];
    if (uses.length > 1) {
      failures.push(`死导出检查: ${name} 已经被接上了，但仍登记在 DEAD_EXPORT_ACCEPTED 里 —— 过期的例外会掩护掉下一个真的死导出`);
    }
  }
  if (scanned < 150) failures.push(`死导出检查: 仅扫到 ${scanned} 个导出函数，远少于预期 —— 提取逻辑已与代码脱节，本条可能在空转`);
  return failures;
}

// 入口判断按【真实路径】比较：原先是 import.meta.url === `file://${process.argv[1]}`，
// 而 macOS 上 /var/folders/... 是指向 /private/var/... 的符号链接 —— import.meta.url 解析成真实路径、
// argv[1] 保持原样，两者对不上，于是从 worktree 里运行时整个主块【一次都不执行】：
// 门静默退出 0、什么都不打印，而变异门把这读成"守卫通过"。实测两条已登记的变异因此假绿。
if (fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])) {
  const failures = [...checkBarrierLiveness(), ...checkMachineLiveness(), ...checkNoDeadExports()];
  if (failures.length) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  // 报数要把【跳过了什么】说全：这道门有两份例外登记表，它们一变大，覆盖就变小，
  // 而"全都通过"这句话一个字都不会变。两处都点名。
  const machineCount = Object.keys(loadStateMachines()).length;
  const modeledAhead = Object.keys(MODELED_AHEAD_OF_IMPLEMENTATION);
  const deadAccepted = Object.keys(DEAD_EXPORT_ACCEPTED);
  console.log(`barrier liveness gate ok: 关闭门无空转、${machineCount} 台状态机都有活的状态与可达的终态、`
    + `且没有够不到的导出杠杆；跳过的两类逐一点名 —— `
    + `${modeledAhead.length} 台登记为建模先于实现或缺一条路（${modeledAhead.join("、")}），`
    + `${deadAccepted.length} 个导出登记为产品里到不了（${deadAccepted.join("、")}）`);
}
