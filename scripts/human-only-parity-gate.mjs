#!/usr/bin/env node
// 真人专属对等门（human-only parity gate）
//
// 一件事被定为"必须真人来做"，通常只在 REST 那一侧写进 HUMAN_ONLY_ACTIONS。但同一个核心函数
// 往往还有一扇 MCP 门，那一侧的主体全是机器（agent_node 是执行体，system_service 是服务令牌）。
// 于是就出现本仓反复出现的形态：同一间屋子两道门，只锁了一道。permission_resolve 就是这样 ——
// REST 侧写着"这既是治理决策也是破坏性操作，不该由机器主体自行完成"，MCP 侧直接
// `return permissionResolve(state, args)`。
//
// 靠工具清单挡不算锁上：DEFAULT_AGENT_MCP_TOOLS 与服务令牌白名单都是配置，改一个环境变量就能
// 把真人专属悄悄取消，而且不会有任何提示。唯一可靠的位置是决策点本身 —— 就像 confirmation_decide
// 那样，在 case 里直接拒绝机器主体。
//
// 本门做的就是这条对等性检查：MCP 的某个工具若落到 REST 侧声明为真人专属的同一个核心函数上，
// 它的 case 体里必须有机器主体拒绝。
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

// 核心函数调用形态统一是 fn(state, ...)；只认这一种，避免把 esc()/json() 之类的工具函数算进来。
const CORE_CALL = /\b([a-z][A-Za-z0-9]{3,})\(\s*state\s*[,)]/g;
const callsIn = (text) => new Set([...text.matchAll(CORE_CALL)].map((m) => m[1]));

// 与授权/记账有关的通用函数不是"这道门在做的那件事"，两侧都会出现，纳入比对只会制造噪声。
const NEUTRAL = new Set(["beginGuardedWrite", "finishGuardedWrite", "writeState", "audit", "ensureAgentGatewayCollections",
  "ensureRuntimeCollections", "scopeStateForAgentPrincipal", "hasPermission", "accountFromRequest", "resourceScopeOrganizationId",
  "taskGroupScope", "projectScope", "recomputeBarrierAfterResolve", "appendEvent", "createId", "principalProjectFilter",
  // 只读校验/查询助手：它们到处都在被调用，不构成"这件事被做了"。把它们当决策函数会造成误报，
  // 而误报和漏报一样会让人不再信这道门。（account_invite 那条路由此前从没被扫描到，
  // 一旦扫描到，organizationQuotaCheck 立刻把不相干的 MCP 工具牵连进来。）
  "organizationQuotaCheck", "assertUniqueRecordId", "publicAccountRecord", "requestedSystemAccountInvite"]);

export function checkHumanOnlyParity() {
  const srv = read("apps/control-plane-ui/server.mjs");
  const mcp = read("apps/mcp-server/server.mjs");
  const failures = [];

  const actionsBlock = srv.match(/const HUMAN_ONLY_ACTIONS = \[([\s\S]*?)\n\];/);
  if (!actionsBlock) return ["真人专属对等门: 找不到 HUMAN_ONLY_ACTIONS —— 本门失效，必须同步更新"];
  // 注释行里的引号词（"人"、"只能提案"…）不是动作名。混进来虽然不会误报，
  // 但会让"每个真人专属动作都要能定位到守卫"这类核对失去意义。
  const actionsText = actionsBlock[1].split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  const humanOnlyActions = new Set([...actionsText.matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1]));

  // REST：真人专属动作 -> 它真正调用的核心函数。窗口取到下一个 beginGuardedWrite 为止，
  // 固定行数会串到相邻路由上，把无关函数算成这道门的。
  const srvLines = srv.split("\n");
  const humanOnlyFunctions = new Map(); // fn -> action
  const locatedActions = new Set();
  for (let i = 0; i < srvLines.length; i += 1) {
    // 动作名不一定是个字面量：account_invite / system_account_invite 就写成三元
    // （systemScopedInvite ? "system_account_invite" : "account_invite"）。只认字面量的话，
    // 这两个真人专属动作的核心函数【永远进不了清单】，它们的 MCP 平权也就从来没有被检查过 ——
    // 实测 identity-mcp.account_invite 正是这样直接落到核心函数上、不拒绝机器主体。
    const guardLine = /beginGuardedWrite\(\s*$|beginGuardedWrite\(req, state/.test(srvLines[i])
      ? srvLines.slice(i, i + 4).join(" ")
      : srvLines[i];
    if (!/beginGuardedWrite\(/.test(srvLines[i])) continue;
    const names = [...guardLine.matchAll(/"([a-z_0-9]+)"/gu)].map((match) => match[1])
      .filter((name) => humanOnlyActions.has(name));
    if (!names.length) continue;
    const guard = [null, names[0]];
    for (const name of names) locatedActions.add(name);
    // 边界必须同时认「下一个 beginGuardedWrite」和「下一条路由的 pathname.match」：只认前者时，
    // 不走 beginGuardedWrite 的路由会让窗口一路串下去，把隔壁路由的函数算成这道门的
    // （实测把 roomWait 算成了 contract_publish 的）。误报和漏报一样会让人不再信这道门。
    let end = i + 1;
    while (end < srvLines.length && end < i + 40
      && !/beginGuardedWrite\(req, state, "/.test(srvLines[end])
      && !/url\.pathname\.match\(/.test(srvLines[end])) end += 1;
    for (const fn of callsIn(srvLines.slice(i, end).join("\n"))) {
      if (!NEUTRAL.has(fn)) humanOnlyFunctions.set(fn, guard[1]);
    }
  }
  if (humanOnlyFunctions.size < 5) {
    failures.push(`真人专属对等门: 只从 REST 侧提取到 ${humanOnlyFunctions.size} 个真人专属核心函数，提取逻辑已与代码脱节`);
  }
  // 每一个真人专属动作都必须能在 REST 侧定位到它的守卫调用。定位不到就等于这个动作
  // 整个跳出了本门的视野 —— 而"跳出视野"与"检查通过"在门的输出上长得一模一样。
  const unlocated = [...humanOnlyActions].filter((action) => !locatedActions.has(action));
  if (unlocated.length) {
    failures.push(`真人专属对等门: 这些真人专属动作在 REST 侧找不到对应的守卫调用：${unlocated.join("、")} ——`
      + " 它们的核心函数进不了清单，MCP 那一侧的平权检查对它们完全失明");
  }

  // MCP：工具 -> case 体（到下一个同级 case 为止）。
  const caseRe = /^ {4}case "([a-z-]+-mcp\.[a-z_]+)":/gm;
  const marks = [...mcp.matchAll(caseRe)];
  if (marks.length < 40) failures.push(`真人专属对等门: 只识别到 ${marks.length} 个 MCP 工具分发点，提取逻辑已与代码脱节`);

  // 第二条链路：按【动作名】对等。上面那条靠"两侧共用同一个核心函数"，而 account_invite
  // 恰恰是两侧各写一份实现（REST 内联、MCP 有自己的 accountInvite），函数名对不上，
  // 结构上就连不起来 —— 实测 identity-mcp.account_invite 因此从未被检查，
  // 而它直接创建账号且不拒绝机器主体。所以再加一条不依赖实现的判据：
  // MCP 工具名的后半段若正好是某个真人专属动作，这个 case 同样必须拒绝机器主体。
  let nameChecked = 0;
  const nameCoveredActions = new Set();
  for (const [index, mark] of marks.entries()) {
    // 后缀也算：human_confirmation_decide 对应的工具叫 confirmation_decide，
    // 严格同名就接不上。放宽成"动作名等于工具后半段，或以 _后半段 结尾"。
    const suffix = mark[1].split(".")[1];
    const matched = [...humanOnlyActions].filter((name) => name === suffix || name.endsWith(`_${suffix}`));
    if (!matched.length) continue;
    const action = matched.join("/");
    nameChecked += 1;
    for (const name of matched) nameCoveredActions.add(name);
    const body = mcp.slice(mark.index, index + 1 < marks.length ? marks[index + 1].index : mark.index + 2000);
    // 两种合格写法：
    // （甲）白名单——"不是真人会话就拒"。更强：以后新增任何机器主体，默认就被挡住。
    // （乙）黑名单——同时点名 agent_node 与 system_service。只挡 agent_node 会放过服务令牌，
    //       而服务令牌恰恰是那条能被一个环境变量打开的路。
    // 原先只认（乙）：把判据升级成（甲）这种严格更安全的改法，反而让这道门报红，
    // 而且报的是"这个 case 没有拒绝机器主体"——与事实相反。判据锁死写法就会挡住正确的改进。
    const blocksMachine = /principal\?\.kind !== "system_admin"/.test(body)
      || (/principal\?\.kind === "agent_node"/.test(body) && /principal\?\.kind === "system_service"/.test(body));
    if (!blocksMachine) {
      failures.push(`真人专属对等门: MCP 工具 ${mark[1]} 与 REST 侧的真人专属动作 ${action} 同名，`
        + "但这个 case 没有拒绝机器主体 —— 同一件事两侧各实现一份，函数名对不上，只能按动作名认");
    }
  }

  // 这条链路必须真的匹配上过东西，否则它只是一段永远不执行的代码。
  if (nameChecked < 3) {
    failures.push(`真人专属对等门: 按名字只匹配到 ${nameChecked} 个 MCP 工具，远少于预期 —— 命名规则已变，这条链路在空转`);
  }

  let checked = 0;
  // 真的被核对过的动作要单独记下来。此前的账按"这个动作有没有对应的 core 函数"记，
  // 而【有函数但 MCP 侧没有同名工具】的动作两条路都走不到，却因为在函数映射里而被算成已覆盖 ——
  // 于是它既不出现在"已核对"里、也不出现在"够不到"里，自述的数字加起来对不上总数
  // （22 个动作只交代了 16 个，skill_source_retire 一个字都没提）。
  const functionVerifiedActions = new Set();
  marks.forEach((mark, index) => {
    const body = mcp.slice(mark.index, index + 1 < marks.length ? marks[index + 1].index : mark.index + 2000);
    const shared = [...callsIn(body)].filter((fn) => humanOnlyFunctions.has(fn));
    if (!shared.length) return;
    checked += 1;
    for (const fn of shared) {
      for (const action of String(humanOnlyFunctions.get(fn)).split("/")) functionVerifiedActions.add(action);
    }
    // 挡住机器主体的写法必须同时点名两类主体：只挡 agent_node 会放过服务令牌，
    // 而服务令牌恰恰是那条能被一个环境变量打开的路。
    // 两种合格写法：
    // （甲）白名单——"不是真人会话就拒"。更强：以后新增任何机器主体，默认就被挡住。
    // （乙）黑名单——同时点名 agent_node 与 system_service。只挡 agent_node 会放过服务令牌，
    //       而服务令牌恰恰是那条能被一个环境变量打开的路。
    // 原先只认（乙）：把判据升级成（甲）这种严格更安全的改法，反而让这道门报红，
    // 而且报的是"这个 case 没有拒绝机器主体"——与事实相反。判据锁死写法就会挡住正确的改进。
    const blocksMachine = /principal\?\.kind !== "system_admin"/.test(body)
      || (/principal\?\.kind === "agent_node"/.test(body) && /principal\?\.kind === "system_service"/.test(body));
    if (!blocksMachine) {
      failures.push(`真人专属对等门: MCP 工具 ${mark[1]} 通向 ${shared.join("/")}，而 REST 侧把它定为真人专属`
        + `（${shared.map((fn) => humanOnlyFunctions.get(fn)).join("/")}），但这个 case 没有拒绝机器主体 —— `
        + `同一件事两道门只锁了一道，工具清单是配置，挡不住`);
    }
  });

  if (!checked) {
    failures.push("真人专属对等门: 没有比对到任何一对「REST 真人专属 ↔ MCP 同函数」，本门在空转（已知至少存在 confirmation_decide 这一对）");
  }
  // 一并交出覆盖面。数组仍是主返回值（调用方按 .failures 取），覆盖数字用于收尾打印：
  // 覆盖悄悄缩水与"全都查过了"在输出上长得一模一样，而本会话有三次是靠这种数字先看出问题的。
  // 两条路都够不到的动作要【点名】：REST 路由里就地改状态、不调 fn(state, ...) 的那些进不了
  // 函数映射（project_archive 就是这样），而只要 MCP 侧没有同名工具，按名字那条路也接不上。
  // 于是它们既不在按函数核对里、也不在按名字核对里 —— "没查到问题"与"根本没查"在输出上一样。
  // 这不判失败（多数动作本就没有 MCP 对应物），但必须说出来，否则覆盖缩水没人看得见。
  const uncoveredActions = [...humanOnlyActions]
    .filter((action) => !functionVerifiedActions.has(action) && !nameCoveredActions.has(action));
  // 账必须加得起来：已核对 + 够不到 = 全部。差一个都说明有动作从这份自述里漏掉了。
  const accounted = new Set([...functionVerifiedActions, ...nameCoveredActions, ...uncoveredActions]
    .filter((action) => humanOnlyActions.has(action)));
  if (accounted.size !== humanOnlyActions.size) {
    const missing = [...humanOnlyActions].filter((action) => !accounted.has(action));
    failures.push(`真人专属对等门: ${humanOnlyActions.size} 个动作里有 ${missing.length} 个没进任何一栏`
      + `（${missing.join("、")}）—— 自述的账加不起来，覆盖缩水看不出来`);
  }
  failures.coverage = {actions: humanOnlyActions.size, functions: humanOnlyFunctions.size,
    dispatchPoints: marks.length, byFunction: checked, byName: nameChecked, uncovered: uncoveredActions};
  return failures;
}

// 入口判断按【真实路径】比较：原先是 import.meta.url === `file://${process.argv[1]}`，
// 而 macOS 上 /var/folders/... 是指向 /private/var/... 的符号链接 —— import.meta.url 解析成真实路径、
// argv[1] 保持原样，两者对不上，于是从 worktree 里运行时整个主块【一次都不执行】：
// 门静默退出 0、什么都不打印，而变异门把这读成"守卫通过"。实测两条已登记的变异因此假绿。
if (fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])) {
  const failures = checkHumanOnlyParity();
  if (failures.length) {
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  // 报出覆盖面而不只是 ok：覆盖悄悄缩水与"全都查过了"在输出上长得一模一样。
  // 本会话有三次是靠这种数字先看出问题的（视图枚举漏了一个、反查一次都没走到、判据一种都没挡住）。
  const coverage = failures.coverage || {};
  console.log(`human-only parity gate ok: ${coverage.actions} 个真人专属动作、`
    + `${coverage.functions} 个核心函数、${coverage.dispatchPoints} 个 MCP 分发点；`
    + `按函数核对 ${coverage.byFunction} 处、按动作名核对 ${coverage.byName} 处，均在决策点只放行真人会话；`
    + `另有 ${(coverage.uncovered || []).length} 个动作两条路都够不到（${(coverage.uncovered || []).join("、") || "无"}）——`
    + "它们在 REST 路由里就地改状态、也没有同名 MCP 工具，所以本门对它们【当下没有可比对的另一条路】。"
    + "这不等于没有防线：REST 侧仍由 beginGuardedWrite 按动作名挡机器主体；"
    + "而一旦有人给其中某个加上同名 MCP 工具，上面「按动作名」那条就会把它收进来并要求同样的拒绝。"
    + "");
}
