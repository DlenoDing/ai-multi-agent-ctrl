// 自治循环空转时不得落盘 —— 但也不得因此让系统看起来死了、或挡住真实进展。
// 实测背景：空转一拍会重写一堆派生记录并全量落盘，2000 单元时一拍卡死整个服务 2.3 秒，
// 而且每分钟作废一次所有客户端的 ETag，让每个控制台重新拉视图、重建 DOM。
// 这道门用真实服务端验三件事：空转会收敛到不落盘；空转期间系统仍自报"还活着"；有真活时照样推进。
import {spawn, spawnSync} from "node:child_process";
import {createServer} from "node:net";
import {once} from "node:events";
import {existsSync, mkdtempSync, readFileSync, readdirSync} from "node:fs";
import {join, dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {tmpdir} from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── 新部署的第一条路径：npm run init 打印账号与令牌 → npm start → 照着它登录 ──────────
// 这条路此前没有任何门走过，而它一旦断了，人连门都进不去（README 的前两条命令就是它）。
// 必须走【真实启动路径】：npm start 经 run-with-env.mjs 加载 init 写下的运行配置；
// 直接起 server.mjs 会绕过那一层，测的就是另一件事。
async function verifyFirstRunPath() {
  const firstRunDir = mkdtempSync(join(tmpdir(), "aimac-first-run-"));
  const initEnv = {...process.env, AIMAC_RUNTIME_DIR: firstRunDir, AIMAC_STATE_STORE: "runtime_json", DATABASE_URL: ""};
  const init = spawnSync(process.execPath, ["scripts/init-control-plane.mjs"], {cwd: root, env: initEnv, encoding: "utf8"});
  check(init.status === 0, "npm run init 能跑通（新部署的第一条命令）",
    init.status === 0 ? "ok" : String(init.stderr || init.stdout).slice(0, 160));
  if (init.status !== 0) return;
  const email = (init.stdout.match(/system admin login:\s*(\S+)/u) || [])[1];
  const bootstrapToken = (init.stdout.match(/local bootstrap token:\s*(\S+)/u) || [])[1];
  check(Boolean(email && bootstrapToken), "init 会把登录账号与令牌一起打印出来",
    `账号 ${email || "（没打印）"}｜令牌 ${bootstrapToken ? "已打印" : "（没打印）"}`);
  if (!email || !bootstrapToken) return;

  const firstRunPort = await freePort();
  const firstRunChild = spawn(process.execPath, ["scripts/run-with-env.mjs", "apps/control-plane-ui/server.mjs"], {
    cwd: root,
    env: {...process.env, AIMAC_HOST: "127.0.0.1", AIMAC_PORT: String(firstRunPort), AIMAC_RUNTIME_DIR: firstRunDir,
      AIMAC_ORCHESTRATOR_INTERVAL_MS: "0", AIMAC_STATE_STORE: "runtime_json", DATABASE_URL: "",
      AIMAC_BOOTSTRAP_TOKEN: undefined, AIMAC_MCP_SERVICE_TOKEN: undefined},
    stdio: ["ignore", "pipe", "pipe"]
  });
  const firstRunBase = `http://127.0.0.1:${firstRunPort}`;
  const upDeadline = Date.now() + 30000;
  let up = false;
  while (Date.now() < upDeadline) {
    try { if ((await fetch(`${firstRunBase}/api/health`)).ok) { up = true; break; } } catch { /* 还没起来 */ }
    if (firstRunChild.exitCode !== null) break;
    await new Promise((resolve2) => setTimeout(resolve2, 150));
  }
  check(up, "init 之后 npm start 能直接起来（不必再手工设环境变量）",
    up ? "ok" : "服务没起来 —— 人照着 README 的前两条命令做就卡在这里");
  if (up) {
    const login = await (await fetch(`${firstRunBase}/api/auth/login`, {method: "POST",
      headers: {"content-type": "application/json"}, body: JSON.stringify({email, token: bootstrapToken})})).json();
    check(Boolean(login.sessionToken), "照 init 打印的账号与令牌能登进去",
      login.sessionToken ? "ok" : JSON.stringify(login).slice(0, 160));
  }
  firstRunChild.kill("SIGTERM");
  await Promise.race([once(firstRunChild, "exit"), new Promise((resolve2) => setTimeout(resolve2, 3000))]);
}
const runtimeDir = mkdtempSync(join(tmpdir(), "aimac-idle-"));
const fails = [];
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fails.push(label);
};

const freePort = async () => {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const {port} = listener.address();
  listener.close();
  await once(listener, "close");
  return port;
};

await verifyFirstRunPath();

// 账本上限调小到这个值，验"截断仍会被如实标记"才不用真造 60 条记录。
// 断言的触发条件要用【同一个值】：服务端若不认这个环境变量（知识退化成写死 60），
// 记录数就压不到上限，这时该说"这一轮没验到"，而不是报"截断标记 无" ——
// 后者看起来像标记坏了，会把人引到错误的方向去查。
// 调到 1：本轮实测这个安静项目在 runtime 视图里能拿到的账本集合只有 workerLanes 且只有 2 条，
// 上限设 2 时"下发数 == 总数"，根本不发生截断，这条断言只会永远自报"未被检验"。
// 上限设 1 才真的压出截断。这个数字取决于夹具能造出多少记录，不是越大越像真实场景 ——
// 它唯一的作用是让截断发生。
const gateLedgerLimit = 1;

const tickMs = 3000;
const port = await freePort();
const child = spawn(process.execPath, ["apps/control-plane-ui/server.mjs"], {cwd: root,
  env: {...process.env, AIMAC_HOST: "127.0.0.1", AIMAC_PORT: String(port), AIMAC_RUNTIME_DIR: runtimeDir,
    AIMAC_ORCHESTRATOR_INTERVAL_MS: String(tickMs), AIMAC_STATE_STORE: "runtime_json",
    AIMAC_BOOTSTRAP_TOKEN: "idle-tick-gate-token-0123456789", DATABASE_URL: "",
    // 把账本上限调到 2：验"截断仍会被如实标记"不需要真造 60 条记录。
    AIMAC_VIEW_LEDGER_LIMIT: String(gateLedgerLimit)},
  stdio: ["ignore", "pipe", "pipe"]});
const base = `http://127.0.0.1:${port}`;
const bootDeadline = Date.now() + 30000;
while (Date.now() < bootDeadline) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* 还没起来 */ }
  if (child.exitCode !== null) throw new Error(`服务退出 ${child.exitCode}`);
  await new Promise((r) => setTimeout(r, 150));
}
const login = await (await fetch(`${base}/api/auth/login`, {method: "POST", headers: {"content-type": "application/json"},
  body: JSON.stringify({email: "system.admin@local", token: "idle-tick-gate-token-0123456789"})})).json();
const auth = {authorization: `Bearer ${login.sessionToken}`, "content-type": "application/json"};
const stateVersion = async () => Number((await (await fetch(`${base}/api/state?view=orgs`, {headers: auth})).json()).stateVersion || 0);

// 1) 空转会收敛：连续若干拍状态版本不再推进
let last = await stateVersion();
let stableSince = Date.now();
const convergeDeadline = Date.now() + 90000;
const quietMs = tickMs * 3 + 1500;
while (Date.now() < convergeDeadline) {
  await new Promise((r) => setTimeout(r, 1000));
  const now = await stateVersion();
  if (now !== last) { last = now; stableSince = Date.now(); }
  else if (Date.now() - stableSince > quietMs) break;
}
const converged = Date.now() - stableSince > quietMs;
check(converged, "空转的自治循环会收敛到不再落盘",
  converged ? `连续 ${Math.round((Date.now() - stableSince) / 1000)} 秒（≥3 拍）状态版本停在 ${last}` : `观察 90 秒仍在每拍推进，最后版本 ${last}`);

// 2) 不落盘不等于装死：控制台看到的心跳仍要往前走
const tickAt = async () => (await (await fetch(`${base}/api/state?view=runtime`, {headers: auth})).json())?.runtime?.autonomousOrchestrator?.lastTickAt;
const beforeTick = await tickAt();
await new Promise((r) => setTimeout(r, tickMs * 2 + 1000));
const afterTick = await tickAt();
check(Boolean(afterTick) && afterTick !== beforeTick,
  "空转期间控制台仍看得到自治循环在跑（跳过落盘不能让它看起来死了）",
  `lastTickAt ${beforeTick} → ${afterTick}`);

// 3) 真有活时照样推进：跳过不能把真实变化一起挡住。
// 注意基准要取在【建完之后】：建任务组这个写请求自己就会推进版本，
// 拿建之前的版本做基准的话，"一律跳过"也能让这条断言通过（第一版就是这样）。
const orgId = (await (await fetch(`${base}/api/state?view=orgs`, {headers: auth})).json()).organizations?.[0]?.orgId;
const project = await (await fetch(`${base}/api/projects`, {method: "POST",
  headers: {...auth, "idempotency-key": "idle-gate-project"},
  body: JSON.stringify({name: "空转门项目", organizationId: orgId})})).json();
const created = await (await fetch(`${base}/api/task-groups`, {method: "POST",
  headers: {...auth, "idempotency-key": "idle-gate-tg"},
  body: JSON.stringify({projectId: project.id, name: "空转门任务组", objective: "验证有真活时循环仍会推进"})})).json();
check(Boolean(created?.taskGroup?.id || created?.id), "造得出一个真任务组（造不出来，下面那条就是空转）",
  JSON.stringify(created).slice(0, 160));
await new Promise((r) => setTimeout(r, 1500));       // 等这次写落定
const versionAfterCreate = await stateVersion();
let advanced = false;
const workDeadline = Date.now() + tickMs * 6 + 8000;
while (Date.now() < workDeadline) {
  await new Promise((r) => setTimeout(r, 1000));
  if (await stateVersion() > versionAfterCreate) { advanced = true; break; }
}
check(advanced, "有真活时自治循环照样推进并落盘（跳过不能把真实变化一起挡住）",
  advanced ? `新任务组出现后自治循环继续推进（${versionAfterCreate} → 更高）` : `新任务组建好之后状态版本停在 ${versionAfterCreate} 再也没动过`);

// 项目视角的页面按 projectId 取数：既压载荷，也保证【安静项目看得到自己的记录】。
// 视图是"按账号可见范围取最新 N 条"再截断，别的项目更新的记录会把窗口占满 ——
// 页面上是空表，而人以为"这个项目没有记录"。过滤必须发生在截断【之前】。
{
  const orgId = (await (await fetch(`${base}/api/state?view=orgs`, {headers: auth})).json()).organizations?.[0]?.orgId;
  const makeProject = async (name, key) => (await (await fetch(`${base}/api/projects`, {method: "POST",
    headers: {...auth, "idempotency-key": key}, body: JSON.stringify({name, organizationId: orgId})})).json());
  const quiet = await makeProject("安静项目", "scope-quiet");
  const busy = await makeProject("繁忙项目", "scope-busy");
  const quietId = quiet.id || quiet.project?.id;
  const busyId = busy.id || busy.project?.id;
  const seed = async (projectId, count, prefix) => {
    for (let index = 0; index < count; index += 1) {
      await fetch(`${base}/api/task-groups`, {method: "POST", headers: {...auth, "idempotency-key": `${prefix}-${index}`},
        body: JSON.stringify({projectId, name: `${prefix}-任务组-${index}`, objective: "作用域探针"})});
    }
  };
  // 任务组是【追加】存的（最老的在前），所以被上限挤掉的是【后建】的那个项目。
  // 先把繁忙项目铺满，再建安静项目 —— 这样不带 projectId 时安静项目会一个都看不到。
  // （方向搞反过一次：先建安静项目，它反而落在窗口里，断言看起来绿其实没验到东西。）
  // 让【本项目自己的记录数超过窗口】：正确实现（先按项目过滤再截断）能把 12 个全给出来，
  // 而"先截断再过滤"最多只能给出窗口那么多。这样判据就不依赖哪个项目恰好落在窗口里
  // （前两版分别按创建顺序和"谁被挤掉"来判，都因为顺序其实由分片合并决定而没验到东西）。
  await seed(busyId, 12, "busy");
  await seed(quietId, 12, "quiet");
  const fetchScopedFull = async (projectId) => (await (await fetch(
    `${base}/api/state?view=tasks&limit=200&projectId=${encodeURIComponent(projectId)}`, {headers: auth})).json());
  const fetchScoped = async (projectId, view = "tasks") => (await (await fetch(
    `${base}/api/state?view=${view}&limit=10${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`,
    {headers: auth})).json());
  const unscoped = await fetchScoped(null);
  const scoped = await fetchScoped(quietId);
  const own = (list) => (list || []).filter((item) => item.projectId === quietId).length;
  // 逐个字段核对，不只盯 taskGroups：这条断言原先只验了 tasks 视图里的 taskGroups 一个字段，
  // 而基底里的 taskGroups 走的是另一条路、根本没过滤 —— runtime 视图因此长期下发全部项目的
  // 任务组，门却是绿的。可枚举的面就要全量核对。
  // 视图也要枚举。这条断言原先只探 view=tasks，而 tasks 恰好把 taskGroups 列进了 viewFields、
  // 用过滤版【覆盖】了基底 —— 基底那份没过滤的 taskGroups 在这个视图里根本看不见。
  // 于是 runtime 视图长期下发全部项目的任务组（实测 100 个项目 235KB/次），门却一直是绿的。
  // 一个字段在某个视图里是对的，不代表它在别的视图里也对。
  const foreignByField = [];
  let collectionsChecked = 0;
  for (const view of ["tasks", "runtime", "projects", "users", "instructions", "orgs"]) {
    const body = await fetchScoped(quietId, view);
    for (const [field, value] of Object.entries(body)) {
      if (!Array.isArray(value)) continue;
      if (field === "projects") continue; // 项目切换器要看到全部项目，它本来就不该被切
      collectionsChecked += 1;
      const foreign = value.filter((item) => item && typeof item === "object"
        && item.projectId !== undefined && item.projectId !== null && item.projectId !== quietId).length;
      if (foreign) foreignByField.push(`${view} 视图的 ${field} ${foreign} 条`);
    }
  }
  const others = foreignByField.length;
  // 判据不依赖"谁先谁后被挤掉"：任务组在视图里的顺序由分片按 projectId 合并决定，
  // 哪个项目落在窗口里是随机的（第一版按创建顺序猜方向，两个方向都没验到东西）。
  // 稳的判据是：全局取数确实被上限截断了，而按项目取数把这个项目的全部取到了。
  // 上限同样作用于按项目取数，所以判据不是"12 个全给"，而是【整个窗口都是本项目的】：
  // 先过滤再截断 → 10 条全是我的；先截断再过滤 → 只剩窗口里恰好属于我的那几条。
  check(scoped.taskGroups.length === 10 && own(scoped.taskGroups) === 10 && own(unscoped.taskGroups) < 10,
    "全局取数会被上限截断，而按 projectId 取数能把这个项目的记录取全",
    `全局取数返回 ${unscoped.taskGroups.length} 个（上限 10，说明确实被截断了），`
    + `其中属于这个项目的 ${own(unscoped.taskGroups)} 个；按项目取数返回 ${scoped.taskGroups.length} 个、全部属于本项目的有 ${own(scoped.taskGroups)} 个（应为 10/10）`);
  // 按项目取全的集合【不许】被标成截断：截断标记如果拿"账号范围的数组"来比，
  // 按项目取数时每个集合都会被标上，界面到处显示"共 N+ 条"，而它其实取全了 ——
  // 那是把"我这里就这么多"说成"还有更多"，同样是报数不实。
  const complete = await fetchScopedFull(quietId);
  const markedTruncated = (complete.truncatedCollections || []).includes("taskGroups");
  const ownComplete = (complete.taskGroups || []).filter((item) => item.projectId === quietId).length;
  check(ownComplete === 12 && !markedTruncated,
    "按项目取全时不得再标成截断（否则界面把'就这么多'说成'还有更多'）",
    `取到本项目 ${ownComplete} 个任务组（共 12 个）｜截断标记 ${markedTruncated ? "有" : "无"}`);

  // 两处改动的交叉点：按项目过滤 + 账本类集合的更小上限。
  // 本项目自己的账本超过那个上限时，截断标记必须仍然为真 —— 否则界面会把 60 条说成全部，
  // 而这正是"少取"这个优化最容易踩的坑：省了载荷，却顺手把报数变成了谎话。
  {
    const ledger = await (await fetch(`${base}/api/state?view=runtime&limit=200&projectId=${encodeURIComponent(quietId)}`,
      {headers: auth})).json();
    // 挑一个这一轮真的有记录的账本集合来验（哪个有取决于编排跑了什么，不写死）。
    const ledgerNames = ["admissionDecisions", "modelSelectionDecisions", "sessionPlacementDecisions",
      "workerLanes", "agentExecutionEvents", "agentControlCommands", "transitionEvidence"];
    // 判据必须落在【真实总数】上，不能拿"下发数正好等于上限"当截断发生了：
    // 集合总共就 gateLedgerLimit 条时，下发数同样等于上限，而这时【不该】有截断标记。
    // 第一版就是这么写的，于是上游一个把在制品压小的改动让记录数正好落到 2，
    // 断言当场要求一个不该存在的标记 —— 一条本该"未被检验"的路走成了假红。
    // 真实总数从盘上的状态取（门自己起的服务，运行目录是自己的）。
    const stored = JSON.parse(readFileSync(join(runtimeDir, "control-plane-state.json"), "utf8"));
    const shardDir = join(runtimeDir, "project-state-shards");
    const shards = existsSync(shardDir)
      ? readdirSync(shardDir).map((name) => JSON.parse(readFileSync(join(shardDir, name), "utf8")))
      : [];
    // 总数要和视图【同一个作用域】：视图是按这个项目过滤过的，拿全局总数去比，
    // 会挑中一个本项目一条都没有的集合，然后要求它有截断标记 —— 又是一条假红。
    // 归属判据与服务端一致：没有 projectId 的记录属于所有人（中央集合）。
    const mine = (item) => item.projectId === undefined || item.projectId === null || item.projectId === quietId;
    const trueCount = (name) => (stored[name] || []).filter(mine).length
      + shards.reduce((sum, shard) => sum + ((shard.collections || {})[name] || []).filter(mine).length, 0);
    // 还要求这个集合【确实在这个视图里下发】：view=runtime 并不带全部账本集合，
    // 挑中一个根本不在视图里的（下发 undefined），同样是在要求一个不存在的标记。
    const picked = ledgerNames.find((name) => Array.isArray(ledger[name]) && trueCount(name) > gateLedgerLimit);
    if (picked) {
      const shipped = (ledger[picked] || []).length;
      const marked = (ledger.truncatedCollections || []).includes(picked);
      // 下发数超过配置的上限 = 服务端根本没认这个旋钮。这时照样要红（旋钮不生效，这道门就没有意义），
      // 但标题不能说成"标记没打"—— 那会把人支到渲染那边去查，而问题在读取环境变量那一行。
      if (shipped > gateLedgerLimit) {
        check(false, "账本上限旋钮必须生效（否则'截断仍要标记'无从检验）",
          `${picked} 实有 ${trueCount(picked)} 条，配置上限 ${gateLedgerLimit} 却下发了 ${shipped} 条 ——`
          + " 服务端没有认 AIMAC_VIEW_LEDGER_LIMIT，不是标记坏了");
      } else {
        check(marked, "账本被账本上限截断时，仍要如实标记（界面才会显示'共 N+ 条'）",
          `${picked} 实有 ${trueCount(picked)} 条、下发 ${shipped} 条（上限 ${gateLedgerLimit}），截断标记 ${marked ? "有" : "无"}`);
      }
    } else {
      console.log(`  --  这一轮没有任何账本集合的真实条数超过上限 ${gateLedgerLimit}`
        + `（各集合实有：${ledgerNames.map((name) => `${name} ${trueCount(name)}`).join("、")}）——`
        + ` 没有发生截断，"截断仍要标记"这条未被检验`);
    }
  }

  check(others === 0, "带上 projectId 时，视图里【任何】集合都不许夹带别的项目的记录",
    others ? `混进来：${foreignByField.join("、")}` : `6 个视图共 ${collectionsChecked} 个集合逐个核对，无一夹带`);
}

child.kill("SIGTERM");
await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 3000))]);
if (fails.length) {
  console.error(`idle tick gate failed: ${fails.join("；")}`);
  process.exit(1);
}
console.log("idle tick gate ok: 空转不落盘、空转期间仍自报在跑、有真活时照常推进");
