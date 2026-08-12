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

const root = process.argv[2] || resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = mkdtempSync(join(tmpdir(), "aimac-conc-"));
const fails = [];
const check = (ok, label, detail = "") => {
  // 参数自检：布尔与标签写反时当场报错，而不是静默恒真。
  // 本仓库四道门里三道是 (ok, label)，控制台门是 (label, ok) —— 我照着另一道的顺序写过一次，
  // 结果四条断言全成了"非空字符串即真"，门全绿、变异也全绿，只有变异跑不出红才暴露。
  if (typeof ok !== "boolean" || typeof label !== "string") {
    throw new Error(`check(ok, label, detail) 参数错位：收到 ok=${typeof ok}、label=${typeof label}`
      + "（本门的顺序是【条件在前、名称在后】）");
  }
  console.log(`${ok ? "  ok " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`); if (!ok) fails.push(label); };

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
  const child = spawn(process.execPath, ["apps/control-plane-ui/server.mjs"], {cwd: root,
    env: {...process.env, AIMAC_HOST: "127.0.0.1", AIMAC_PORT: String(port), AIMAC_RUNTIME_DIR: runtimeDir,
      AIMAC_ORCHESTRATOR_INTERVAL_MS: "0", AIMAC_STATE_STORE: "runtime_json",
      AIMAC_BOOTSTRAP_TOKEN: "concurrent-probe-token-0123456789", DATABASE_URL: ""}, stdio: ["ignore", "pipe", "pipe"]});
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
const fire = async (server, auth, tag, count) => {
  for (let index = 0; index < count; index += 1) {
    const name = `${tag}-项目-${index}`;
    const response = await fetch(`${server.base}/api/projects`, {method: "POST",
      headers: {...auth, "idempotency-key": `conc-${tag}-${index}`},
      body: JSON.stringify({name, organizationId: orgId})});
    if (response.ok) created.add(name);
    else if (response.status === 409) conflicts[tag] += 1;
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

for (const server of [a, b]) { server.child.kill("SIGTERM"); }
await new Promise((resolve) => setTimeout(resolve, 500));
console.log(fails.length
  ? `concurrent writer gate failed: ${fails.join("；")}`
  : "concurrent writer gate ok: 两进程并发写同一份状态，被确认的写入一条不丢、双方都没被对方的锁堵死");
process.exit(fails.length ? 1 : 0);
