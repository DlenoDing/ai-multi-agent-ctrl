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
  const failures = checkBarrierLiveness();
  if (failures.length) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log("barrier liveness gate ok: 关闭门检查的状态名均为已登记状态，无空转门");
}
