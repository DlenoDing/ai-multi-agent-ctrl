import { readFileSync } from "node:fs";

// spec/state-machines.yaml 里某台机器登记的状态。不引 YAML 依赖。
// 注意 states 列表里夹着注释行（`      # ...`）—— 判断"列表结束"只能看缩进更浅的键，
// 不能看"这一行不是 - 开头"（我第一版探针就是这么写的，报出一个假漂移）。
export function extractMachineStates(yamlText, machine) {
  const lines = yamlText.split(/\r?\n/);
  let index = lines.findIndex((line) => line === `  ${machine}:`);
  if (index < 0) return [];
  const states = [];
  let inStates = false;
  for (index += 1; index < lines.length; index++) {
    const line = lines[index];
    if (/^  \S/.test(line)) break;                       // 下一台机器
    if (/^    states:\s*$/.test(line)) { inStates = true; continue; }
    if (!inStates) continue;
    const item = line.match(/^      - "([^"]+)"\s*$/u);
    if (item) { states.push(item[1]); continue; }
    if (/^    \S/.test(line)) break;                     // 下一个键（transitions: 等）
  }
  return states;
}

// 集合名 -> 机器名。默认按单复数推导，对不上的在这里点名。
const STATE_MACHINE_BY_COLLECTION = {agentRuntimeNodes: "AgentNode"};

// 没有同名状态机的集合要登记。不登记就静默跳过，而"跳过"和"查过了没问题"长得一模一样。
// 绝大多数的理由是同一条：它的 status 由自己那份 schema 的 enum 守住（那道核对压在真实记录上）。
const COLLECTIONS_WITHOUT_STATE_MACHINE = {
  accessGrants: "spec/access-control-grant.schema.json 的 status enum",
  sharedDefinitions: "spec/shared-definition-contract.schema.json 的 status enum",
  repositoryOutputs: "spec/repository-output-target.schema.json 的 status enum",
  managementSurfaces: "spec/management-console-surface.schema.json 的 status enum",
  skillSources: "spec/agent-skill-source.schema.json 的 status enum",
  roleSkills: "spec/agent-role-skill.schema.json 的 status enum",
  completionReadiness: "spec/completion-readiness.schema.json 的 status enum",
  agentDispatches: "spec/agent-dispatch.schema.json 的 status enum",
  workerLanes: "spec/worker-lane.schema.json 的 status enum",
  organizations: "spec/organization.schema.json 的 status enum",
  authSessions: "spec/auth-session.schema.json 的 status enum",
  agentJoinTokens: "spec/agent-join-token.schema.json 的 status enum",
  agentControlCommands: "spec/agent-control-command.schema.json 的 status enum",
  agents: "spec/agent.schema.json 的 status enum（逻辑智能体目录项没有生命周期，只有启停两态）",
  mcpCalls: "spec/mcp-call.schema.json 的 status enum（一次调用要么成了要么没成，没有生命周期）",
  // 这个集合此前【从没在任何 e2e 产出里出现过】（room_join 一次都没成功执行过），所以既没有
  // 规范也没被这道门看见。补规范时确认了它只有 joined 一个状态：离开是把记录淘汰掉，不改状态。
  // 同因（第四次）：system_upgrade_external_import 此前一次都没成功执行过。导入本身不生效 ——
  // 它停在等真人激活那一个状态上，激活走的是另一条路（另一个对象），所以这里没有生命周期。
  externalUpgradeImports: "spec/external-upgrade-import.schema.json 的 status enum（导入即等真人激活，没有生命周期）",
  // 同因（第三次）：test_result_submit 此前一次都没成功执行过。参与关闭门判定的是由它派生的
  // QualityGate（那个有自己的状态机）；这条是事实记录，写下就不再变，要重跑就是另一条。
  testResults: "spec/test-result.schema.json 的 status enum（一次执行的事实记录，没有生命周期）",
  // 同因：runtime_issue_pattern_submit 此前一次都没成功执行过，这个集合从没出现在任何 e2e 产出里。
  runtimeIssueSamples: "spec/runtime-issue-sample.schema.json 的 status enum（样本要么被升级成模式、要么被容量淘汰，没有生命周期）",
  roomParticipants: "spec/room-participant.schema.json 的 status enum（加入即 joined，离开是淘汰记录而不是改状态）"
};

const machineNameForCollection = (collection) => {
  if (STATE_MACHINE_BY_COLLECTION[collection]) return STATE_MACHINE_BY_COLLECTION[collection];
  const singular = collection.replace(/ies$/u, "y").replace(/s$/u, "");
  return singular.charAt(0).toUpperCase() + singular.slice(1);
};

// 记录的 status 必须是 spec/state-machines.yaml 里【那台机器登记过的】状态。
// 已有的「状态集合常量」那道门查的是源码里手写的 const XXX_STATUSES 清单，看不见
// `status: "planned"` 这种直接写在构造点上的取值。手跑一次同样的对表就扫出三处漂移：
// 问责台账写着机器没有的 accepted、任务组建出来就是机器没有的 planned、种子里的模型提供方是 configured。
// 判据落在【真实产出的记录】上，不解析源码。
export function checkRecordStatusesAreDeclaredStates(specPath, sourceState, label, {minChecked = 12} = {}) {
  const yamlText = readFileSync(specPath, "utf8");
  const errors = [];
  let checked = 0;
  const seenWithoutMachine = new Set();
  const unregistered = [];
  for (const [collection, items] of Object.entries(sourceState || {})) {
    if (!Array.isArray(items)) continue;
    const values = new Set(items
      .filter((item) => item && typeof item === "object" && typeof item.status === "string" && item.status)
      .map((item) => item.status));
    if (!values.size) continue;
    const machine = machineNameForCollection(collection);
    const states = extractMachineStates(yamlText, machine);
    if (!states.length) {
      seenWithoutMachine.add(collection);
      if (!COLLECTIONS_WITHOUT_STATE_MACHINE[collection]) {
        unregistered.push(`${collection}（取值 ${[...values].sort().join("/")}）`);
      }
      continue;
    }
    checked += 1;
    const stray = [...values].filter((value) => !states.includes(value)).sort();
    if (stray.length) {
      errors.push(`${label}：${collection} 里出现了 ${machine} 状态机没有登记的状态 ${stray.join("、")} —— `
        + "凡是按状态机推理的东西（关闭门的了结集、非终态集、迁移判权）都不认识它，"
        + "而这不会报任何错，只是那些判定永远不成立");
    }
  }
  // 这里【不加】"迁移证据的 from/to 要在状态机里登记过"那道核对 —— 我写完才发现它永远不会触发：
  // 产品自己的迁移引擎（lib/transition-engine.mjs）在运行时就按同一份 spec/state-machines.yaml
  // 判 from/to，严格模式直接抛、宽松模式记成 rejected（而 rejected 那类本来就该跳过）。
  // 也就是说它与被测代码共用同一个真相源、且守在更靠后的位置，只能是一道空转的门。
  // 真验到它的方式是把一处迁移改成未登记的状态：结果是引擎当场抛错、e2e 在别处红，
  // 而不是这道核对报出来 —— 「失败了但不是因为预期断言」。
  if (checked < minChecked) {
    errors.push(`${label}：只对上了 ${checked} 个有状态机的集合（至少该有 ${minChecked} 个）—— `
      + "集合名到机器名的推导已与数据脱节，本条在空转");
  }
  if (unregistered.length) {
    errors.push(`${label}：这些集合带 status 却没有同名状态机，也没有登记：${unregistered.join("、")} —— `
      + "要么建机器，要么在 COLLECTIONS_WITHOUT_STATE_MACHINE 里写明它凭什么可以没有");
  }
  const note = `${label}状态对表：${checked} 个集合的 status 取值逐个对过 spec/state-machines.yaml，`
    + `${seenWithoutMachine.size} 个按登记跳过（登记表共 ${Object.keys(COLLECTIONS_WITHOUT_STATE_MACHINE).length} 项）`
    ;
  return {errors, checked, note, seenWithoutMachine};
}
