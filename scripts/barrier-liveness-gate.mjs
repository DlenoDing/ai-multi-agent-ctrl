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
  workItem: ["WorkItem"], expiredWorkItem: ["WorkItem"],
  dispatch: ["AgentDispatch"], session: ["WorkSession"], command: ["Command"], effect: ["CommandEffect"],
  topology: ["ExecutionTopology"], node: ["AgentNode"], taskGroup: ["TaskGroup"], account: ["Account"],
  request: ["PermissionRequest", "ApprovalRequest", "HumanConfirmationRequest", "DerivedTaskRequest"],
  target: ["RepositoryOutputTarget"], repositoryTarget: ["RepositoryOutputTarget"],
  source: ["AgentSkillSource"], lease: ["Lease"], lane: ["WorkerLane"], guard: ["RoleDriftGuard"],
  entry: ["DLQEntry"], directive: ["HumanDirective"], grant: ["TempGrant", "AccessControlGrant"],
  definition: ["SharedDefinitionContract"], pattern: ["RuntimeIssuePattern"], gate: ["QualityGate"],
  artifact: ["Artifact"], candidate: ["SystemUpgradeCandidate"],
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
  Project: "项目没有归档/删除路径（产品缺口，非疏漏）—— maxProjects 只增不减这件事同源",
  ProgressSnapshot: "进度快照是被裁剪掉的，不走 archived 终态",
  // 下面三台是【真的缺一条路】，不是建模错误 —— 登记在这里是为了让缺口有名有姓，而不是让门闭嘴。
  Account: "账号只有 active/suspended，没有退役路径（与项目无归档、maxProjects 只增不减同源的产品缺口）",
  AgentSkillSource: "技能源只有 syncing/quarantined/active，没有下线路径：接进来的源无法移除",
  RuntimeIssuePattern: "问题模式只有 observed/clustered/candidate_created，没有压制/收尾路径：一条噪声模式无法被消音，只会一直累积"
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
    if (registered && anyProduced && anyTerminalProduced) {
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
  for (const match of source.matchAll(/const ([A-Z_a-z]+(?:STATUSES|TERMINAL|Statuses))\s*=\s*(?:new Set\()?\[(.*?)\]/gs)) {
    namedSets[match[1]] = [...match[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
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

  let checked = 0;
  for (const line of blocks.join("\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes(":")) continue;
    const gateName = trimmed.slice(0, trimmed.indexOf(":"));
    // 只看确实在比较 status 的门；比较其它字段的（如 grantStatus、dispositionClass）不在本门范围内
    if (!/\.status\b/.test(line)) continue;
    const collection = Object.keys(COLLECTION_ENTITY).find((name) => new RegExp(`\\b${name}\\b`).test(line));
    if (!collection) {
      failures.push(`空转门检查: 门 ${gateName} 检查了 .status 但集合未登记到 COLLECTION_ENTITY（无法核对，等于绕过本门）`);
      continue;
    }
    const entity = COLLECTION_ENTITY[collection];
    const machine = machines[entity];
    if (!machine) {
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
    if (!literals.length) continue;
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

  if (checked < 20) failures.push(`空转门检查: 仅核对到 ${checked} 道涉及 status 的关闭门，远少于预期 —— 提取逻辑已与代码脱节，本门可能在空转（本门自身也不许空转）`);
  return failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const failures = [...checkBarrierLiveness(), ...checkMachineLiveness()];
  if (failures.length) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log("barrier liveness gate ok: 关闭门无空转，且每台状态机都有活的状态与可达的终态");
}
