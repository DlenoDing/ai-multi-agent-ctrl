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
  "taskGroupScope", "projectScope", "recomputeBarrierAfterResolve", "appendEvent", "createId", "principalProjectFilter"]);

export function checkHumanOnlyParity() {
  const srv = read("apps/control-plane-ui/server.mjs");
  const mcp = read("apps/mcp-server/server.mjs");
  const failures = [];

  const actionsBlock = srv.match(/const HUMAN_ONLY_ACTIONS = \[([\s\S]*?)\n\];/);
  if (!actionsBlock) return ["真人专属对等门: 找不到 HUMAN_ONLY_ACTIONS —— 本门失效，必须同步更新"];
  const humanOnlyActions = new Set([...actionsBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));

  // REST：真人专属动作 -> 它真正调用的核心函数。窗口取到下一个 beginGuardedWrite 为止，
  // 固定行数会串到相邻路由上，把无关函数算成这道门的。
  const srvLines = srv.split("\n");
  const humanOnlyFunctions = new Map(); // fn -> action
  for (let i = 0; i < srvLines.length; i += 1) {
    const guard = srvLines[i].match(/beginGuardedWrite\(req, state, "([a-z_]+)"/);
    if (!guard || !humanOnlyActions.has(guard[1])) continue;
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

  // MCP：工具 -> case 体（到下一个同级 case 为止）。
  const caseRe = /^ {4}case "([a-z-]+-mcp\.[a-z_]+)":/gm;
  const marks = [...mcp.matchAll(caseRe)];
  if (marks.length < 40) failures.push(`真人专属对等门: 只识别到 ${marks.length} 个 MCP 工具分发点，提取逻辑已与代码脱节`);

  let checked = 0;
  marks.forEach((mark, index) => {
    const body = mcp.slice(mark.index, index + 1 < marks.length ? marks[index + 1].index : mark.index + 2000);
    const shared = [...callsIn(body)].filter((fn) => humanOnlyFunctions.has(fn));
    if (!shared.length) return;
    checked += 1;
    // 挡住机器主体的写法必须同时点名两类主体：只挡 agent_node 会放过服务令牌，
    // 而服务令牌恰恰是那条能被一个环境变量打开的路。
    const blocksMachine = /principal\?\.kind === "agent_node"/.test(body) && /principal\?\.kind === "system_service"/.test(body);
    if (!blocksMachine) {
      failures.push(`真人专属对等门: MCP 工具 ${mark[1]} 通向 ${shared.join("/")}，而 REST 侧把它定为真人专属`
        + `（${shared.map((fn) => humanOnlyFunctions.get(fn)).join("/")}），但这个 case 没有拒绝机器主体 —— `
        + `同一件事两道门只锁了一道，工具清单是配置，挡不住`);
    }
  });

  if (!checked) {
    failures.push("真人专属对等门: 没有比对到任何一对「REST 真人专属 ↔ MCP 同函数」，本门在空转（已知至少存在 confirmation_decide 这一对）");
  }
  return failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const failures = checkHumanOnlyParity();
  if (failures.length) {
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("human-only parity gate ok: 通向真人专属核心函数的 MCP 工具均在决策点拒绝机器主体");
}
