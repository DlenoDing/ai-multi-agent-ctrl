// 两个进程同时写同一份状态：不能丢更新，也不能互相破锁。
// 这正是目录锁 + CAS 要防的事，而我刚改过破锁逻辑（按持锁进程存活判），必须重验。
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {once} from "node:events";
import {mkdtempSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";

import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {installGateFetch, transportErrorCode} from "./lib/gate-fetch.mjs";

// 本门只有批量写那一段自己 catch 了 fetch，后面几段（定稿竞争、双方复写）是裸的：
// 服务端中途不再监听时，一句裸 TypeError 就把整道门打断，连它自己收集的服务端日志都来不及打印。
installGateFetch("并发写入门");

// 起过的子进程一律登记，并在【所有】退出路径上收掉。
// 只在成功路径上 kill 是不够的：断言抛错、超时、Ctrl-C 时服务就成了孤儿（父进程没了、PPID=1），
// 而它还带着自治循环在跑。本机实测积了 13 个这样的进程、最久的活了 15 小时，
// 负载被抬到 7 以上 —— 后果不只是浪费：同一份代码的耗时量出 22s 和 99s 两个结果，
// 任何性能判断都作不得数。测试留下的垃圾会污染后面所有测试。
const spawnedChildren = [];
function trackChild(child) {
  spawnedChildren.push(child);
  return child;
}
function killTrackedChildren() {
  for (const child of spawnedChildren.splice(0)) {
    try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } catch { /* 尽力而为 */ }
  }
}
process.on("exit", killTrackedChildren);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { killTrackedChildren(); process.exit(130); });
}

const root = process.argv[2] || resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = mkdtempSync(join(tmpdir(), "aimac-conc-"));
const fails = [];
const serverLog = [];
// 这道门此前只在【断言失败】时才打印服务端输出。而它真正难查的那次是【裸异常】把整道门打断的：
// 证据就在 serverLog 里，却因为异常直接冒到顶层而从没打印过。任何收场方式都要留下这份证据。
const dumpServerLog = (why) => {
  // 空的时候也要出声："没打印"与"处理器没跑"长得一样，会让人去查一个不存在的问题（实撞一次）。
  if (!serverLog.length) {
    console.log(`  --  ${why}，但服务端一个字都没输出过 —— 它多半在起来之前就退了`);
    return;
  }
  console.log(`  --  ${why}，服务端输出（末 12 行）：`);
  for (const line of serverLog.slice(-12)) console.log(`      ${line}`);
};
// 只留【一个】uncaughtException 处理器。原先文件顶部另有一个（回收子进程后直接 process.exit(1)），
// 它先注册就先退出，下面这份留证据的根本轮不到跑 —— 于是每次偶发红都只剩一段栈。
// 两个处理器抢同一个出口，是"同一件事两道门"的另一种样子。
const bailOut = (why, detail) => {
  dumpServerLog(`${why}（${detail}）`);
  killTrackedChildren();
  console.log(`concurrent writer gate failed: ${why} —— 本轮什么也没验，别当成通过`);
  process.exit(1);
};
process.on("uncaughtException", (error) => bailOut("未捕获异常", error?.message || error));
process.on("unhandledRejection", (reason) => bailOut("未处理的拒绝", reason?.message || reason));
const check = (ok, label, detail = "") => {
  // 参数自检：布尔与标签写反时当场报错，而不是静默恒真。
  // 本仓库四道门里三道是 (ok, label)，控制台门是 (label, ok) —— 我照着另一道的顺序写过一次，
  // 结果四条断言全成了"非空字符串即真"，门全绿、变异也全绿，只有变异跑不出红才暴露。
  if (typeof ok !== "boolean" || typeof label !== "string") {
    throw new Error(`check(ok, label, detail) 参数错位：收到 ok=${typeof ok}、label=${typeof label}`
      + "（本门的顺序是【条件在前、名称在后】）");
  }
  console.log(`${ok ? "  ok " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  // 失败摘要要带上 detail：并发类的失败常常是偶发的，而上层（commit.sh / CI）多半只抓摘要那一行。
  // 一次抓不到细节的偶发红，等于什么线索都没留下 —— 实测就发生过一次，只看到断言名字。
  if (!ok) fails.push(detail ? `${label}（${detail}）` : label); };

const freePort = async () => {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const {port} = listener.address();
  listener.close();
  await once(listener, "close");
  return port;
};
const start = async (port) => {
  const child = trackChild(spawn(process.execPath, ["apps/control-plane-ui/server.mjs"], {cwd: root,
    env: {...process.env, AIMAC_HOST: "127.0.0.1", AIMAC_PORT: String(port), AIMAC_RUNTIME_DIR: runtimeDir,
      AIMAC_ORCHESTRATOR_INTERVAL_MS: "0", AIMAC_STATE_STORE: "runtime_json",
      // 这道门就是来查偶发故障的，服务端的堆栈默认要开着 —— 只有一行错误信息时，
      // "Unexpected end of JSON input" 这种报错根本定位不到是哪一处 parse。
      AIMAC_SERVER_ERROR_DEBUG: "1",
      AIMAC_BOOTSTRAP_TOKEN: "concurrent-probe-token-0123456789", DATABASE_URL: ""}, stdio: ["ignore", "pipe", "pipe"]}));
  // 服务端日志【一直】收着，失败时连同断言一起打出来。
  // 这道门的失败多半是时序偶发（实测六轮两次、之后十轮零次），事后复现不了 ——
  // 不留下那一刻的服务端输出，下一次偶发红同样查不动（这次就吃了这个亏）。
  // 两条流都要收：服务端的正常日志走 stdout，只收 stderr 的话，出事那一刻这份"证据"是空的 ——
  // 实测就是这样：门自报了 ECONNREFUSED，dump 却一个字都没打，我为此白查了一轮。
  for (const [stream, tag] of [[child.stdout, "out"], [child.stderr, "err"]]) {
    stream.on("data", (chunk) => {
      serverLog.push(`[srv${port}/${tag}] ${String(chunk).trimEnd()}`);
      if (serverLog.length > 200) serverLog.shift();
    });
  }
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return {child, base}; } catch {}
    if (child.exitCode !== null) throw new Error(`服务退出 ${child.exitCode}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("服务没起来");
};
const login = async (base) => {
  const result = await (await fetch(`${base}/api/auth/login`, {method: "POST", headers: {"content-type": "application/json"},
    body: JSON.stringify({email: "system.admin@local", token: "concurrent-probe-token-0123456789"})})).json();
  return {authorization: `Bearer ${result.sessionToken}`, "content-type": "application/json"};
};

// 两个独立进程共用同一个运行目录
const [portA, portB] = [await freePort(), await freePort()];
const a = await start(portA);
const b = await start(portB);
const authA = await login(a.base);
const authB = await login(b.base);
const orgId = (await (await fetch(`${a.base}/api/state?view=orgs`, {headers: authA})).json()).organizations?.[0]?.orgId;

// 各自建一批项目：每一条【被确认成功的】写入，最后都必须真的在状态里。
const created = new Set();
const conflicts = {a: 0, b: 0};
const rejectionCodes = new Set();
const unexpected = [];
const transportFlakes = [];
const fire = async (server, auth, tag, count) => {
  for (let index = 0; index < count; index += 1) {
    const name = `${tag}-项目-${index}`;
    // 传输层抖动要与【服务端错误】分开：keep-alive 连接被服务端回收的同一刻客户端复用它，
    // undici 会抛 UND_ERR_SOCKET —— 那是客户端侧的经典竞争，不是这道门要验的东西。
    // 原先这里没有任何保护，一次连接被关就把整道门打成 Node 崩溃栈（实测撞到过）。
    let response;
    try {
      response = await fetch(`${server.base}/api/projects`, {method: "POST",
        headers: {...auth, "idempotency-key": `conc-${tag}-${index}`},
        body: JSON.stringify({name, organizationId: orgId})});
    } catch (error) {
      // 取码要能穿透 AggregateError，否则 ECONNREFUSED 会被记成 unknown，
      // 下面"服务端一直在监听"那条结论就永远出不来（本轮实撞）。
      transportFlakes.push(transportErrorCode(error));
      continue;
    }
    if (response.ok) created.add(name);
    else if (response.status === 409) {
      conflicts[tag] += 1;
      const body = await response.json().catch(() => ({}));
      if (body.error) rejectionCodes.add(String(body.error));
    } else {
      // 非 200/409 原先被【静默忽略】：写入失败了，既不算成功也不算冲突，
      // 于是"被确认的写入没有一条丢失"恒成立 —— 一个写不进去的系统照样能过这道门。
      // 实测把 CAS 改坏之后，存储层另一道守卫抛出 500，正好落进这个盲区，
      // 那条 CAS 变异因此失去判别力（全量变异门抓到的就是这个）。
      const body = await response.json().catch(() => ({}));
      unexpected.push(`${response.status}:${body.error || "无错误码"}`);
    }
  }
};
await Promise.all([fire(a, authA, "a", 10), fire(b, authB, "b", 10)]);

const finalState = JSON.parse(readFileSync(join(runtimeDir, "control-plane-state.json"), "utf8"));
const names = new Set((finalState.projects || []).map((item) => item.name));
const lost = [...created].filter((name) => !names.has(name));
check(created.size >= 10, "确实产生了足够的并发写入（否则这道门什么也没验）",
  `${created.size} 条被确认（冲突退回：a=${conflicts.a} b=${conflicts.b}）`);
check(lost.length === 0, "被确认成功的写入没有一条丢失（并发下不得丢更新）",
  lost.length ? `丢了 ${lost.length} 条：${lost.slice(0, 3).join("、")}` : "0 条丢失");
// 还要钉住【是哪一道拦住的】。存储层有两道防线：CAS（版本对不上就冲突）与
// "项目分片只增不减"。CAS 失效时后者会顶上来把陈旧写入拒掉，于是"没丢更新"这条照样绿 ——
// 实测把 CAS 改坏，整道门仍然通过，那条变异因此失去了判别力（全量变异门抓到的就是这个）。
// 拒了不等于拒对了：并发退回必须是版本冲突，不能是别的守卫顺手接住。
// keep-alive 复用竞争（UND_ERR_SOCKET）不是被测性质，报数但不判红。
// 但 ECONNREFUSED 是另一回事：那是【服务端根本没在监听】，此时其余断言都没有意义 ——
// 把两者混在一起报，会让"服务没起来"伪装成"网络有点抖"。实测背靠背连跑多轮时出现过成批的
// ECONNREFUSED（本机负载所致，不是产品缺陷），正是靠分开报才看清的。
const unreachable = transportFlakes.filter((code) => code === "ECONNREFUSED");
if (transportFlakes.length) {
  console.log(`  --  另有 ${transportFlakes.length} 次传输层失败（${[...new Set(transportFlakes)].join("、")}）`);
}
check(unreachable.length === 0, "整轮里服务端一直在监听（否则下面几条什么也没验）",
  unreachable.length ? `${unreachable.length} 次 ECONNREFUSED —— 服务端没起来或中途死了，本轮结论不可信`
    : "没有连不上的时刻");
check(unexpected.length === 0,
  "并发写入只会成功或按版本冲突退回（没有第三种结局）",
  unexpected.length ? `另有 ${unexpected.length} 次别的失败：${[...new Set(unexpected)].slice(0, 3).join("、")}`
    : `退回的错误码：${[...rejectionCodes].join("、") || "（无退回）"}`);

// 最高风险的那种并发不是"两个人各建各的项目"，而是【两个人对同一张人工定稿卡同时下决定】：
// 定稿会写死一个不可逆的结论（谁批的、批了哪一版），两个都成立就等于账本上有两个互相矛盾的定稿。
// 这条既验"恰好一个成功"，也验"三方读回一致"——写成功的进程、写冲突的进程、磁盘上必须是同一份事实。
{
  const {readFileSync: readFile, readdirSync: readDir} = await import("node:fs");
  const store = await import(`${root}/apps/control-plane-ui/lib/state-store.mjs`);
  const core = await import(`${root}/apps/control-plane-ui/lib/control-plane-core.mjs`);
  const seedPath = join(root, "data/seed-state.json");
  const opts = {root, runtimeDir, statePath: join(runtimeDir, "control-plane-state.json"), seedPath,
    buildInitialState: () => JSON.parse(readFile(seedPath, "utf8"))};
  const seeded = store.readStoredState(opts);
  core.ensureRuntimeCollections(seeded, {root});
  const taskGroup = seeded.taskGroups.find((item) => item.id === "tg_runtime_management");
  taskGroup.workItems = [{id: "w_race", title: "待定稿的单元", status: "needs_decision", progress: 50, ownerRole: "agent-runtime"}];
  const card = core.createHumanConfirmationRequest(seeded, {
    taskGroupId: taskGroup.id, workItemId: "w_race", decisionType: "task_split", requestKey: "task_split:w_race",
    summary: "并发定稿探针",
    options: [{optionId: "opt_a", label: "方案甲"}, {optionId: "opt_b", label: "方案乙"}]
  });
  seeded.stateVersion = Number(seeded.stateVersion || 0) + 1;
  store.writeStoredState(seeded, {...opts, expectedStateVersion: seeded.__loadedStateVersion});

  const decide = (server, auth, tag) => fetch(`${server.base}/api/human-confirmations/${card.requestId}/decide`, {
    method: "POST", headers: {...auth, "idempotency-key": `race-${tag}`},
    body: JSON.stringify({decision: "approved", selectedOptionId: "opt_a", action: "finalize",
      justification: `${tag} 的定稿`, expectedRound: card.round ?? 1})
  }).then(async (response) => ({tag, ok: response.ok, status: response.status}));
  const outcomes = await Promise.all([decide(a, authA, "a"), decide(b, authB, "b")]);
  const winners = outcomes.filter((item) => item.ok);
  check(winners.length === 1, "同一张人工定稿卡被两个进程同时定稿时，恰好一个成功",
    `成功 ${winners.length} 个（${outcomes.map((item) => `${item.tag}:${item.status}`).join("，")}）`);

  const cardFrom = async (server, auth) => {
    const view = await (await fetch(`${server.base}/api/state?view=tasks&limit=200`, {headers: auth})).json();
    return (view.humanConfirmationRequests || []).find((item) => item.requestId === card.requestId);
  };
  const fromWinner = await cardFrom(a, authA);
  const fromLoser = await cardFrom(b, authB);
  let onDisk = null;
  for (const name of readDir(join(runtimeDir, "project-db"))) {
    const shard = JSON.parse(readFile(join(runtimeDir, "project-db", name), "utf8"));
    const hit = (shard.collections?.humanConfirmationRequests || []).find((item) => item.requestId === card.requestId);
    if (hit) onDisk = hit;
  }
  const same = fromWinner?.status === onDisk?.status && fromLoser?.status === onDisk?.status
    && fromWinner?.decision?.decidedBy === onDisk?.decision?.decidedBy;
  check(onDisk?.status === "answered" && same,
    "定稿之后两个进程与磁盘读到的是同一份事实（谁批的、批了哪一版）",
    `磁盘 ${onDisk?.status}/${onDisk?.decision?.decidedBy || "-"}｜甲 ${fromWinner?.status}｜乙 ${fromLoser?.status}`);
}

// 两边都还能继续写（谁也没被对方的锁堵死）
for (const [server, auth, tag] of [[a, authA, "a"], [b, authB, "b"]]) {
  const response = await fetch(`${server.base}/api/projects`, {method: "POST",
    headers: {...auth, "idempotency-key": `conc-final-${tag}`},
    body: JSON.stringify({name: `${tag}-收尾项目`, organizationId: orgId})});
  check(response.ok || response.status === 409, `${tag} 侧仍可写入（没有被对方的锁堵死）`, `HTTP ${response.status}`);
}

// 服务端在整轮里必须一直活着。这条不变式塌过一次，而且塌得很难看：兜底错误处理里那行日志
// 引用了不在作用域里的 req/url，于是【每一个走到兜底的请求都会让服务端进程直接退出】。
// 症状只是偶发 ECONNREFUSED，追了三轮。直接问"它还活着吗"，比数连接失败次数清楚得多。
for (const [tag, server] of [["a", a], ["b", b]]) {
  const dead = server.child.exitCode !== null || server.child.signalCode !== null;
  check(!dead, `${tag} 侧服务端在整轮里没有死过（死了的话上面每一条都不算数）`,
    dead ? `退出码 ${server.child.exitCode}／信号 ${server.child.signalCode}` : "仍在运行");
}
for (const server of [a, b]) { server.child.kill("SIGTERM"); }
await new Promise((resolve) => setTimeout(resolve, 500));
if (fails.length) dumpServerLog("有断言未通过");
console.log(fails.length
  ? `concurrent writer gate failed: ${fails.join("；")}`
  : "concurrent writer gate ok: 两进程并发写同一份状态，被确认的写入一条不丢、双方都没被对方的锁堵死");
process.exit(fails.length ? 1 : 0);
