// 写入过程中被 SIGKILL：状态必须要么是写入前那份、要么是写入后那份，不能是半份。
// 做法：真实服务端持续写入，在写入密集时硬杀，重启后读回并核对完整性（含分片摘要）。
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {once} from "node:events";
import {mkdtempSync, readFileSync, existsSync, readdirSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";

import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

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
process.on("uncaughtException", (error) => { killTrackedChildren(); console.error(error); process.exit(1); });

const root = process.argv[2] || resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = mkdtempSync(join(tmpdir(), "aimac-crash-"));
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

const startServer = async (port) => {
  const child = trackChild(spawn(process.execPath, ["apps/control-plane-ui/server.mjs"], {
    cwd: root,
    env: {...process.env, AIMAC_HOST: "127.0.0.1", AIMAC_PORT: String(port), AIMAC_RUNTIME_DIR: runtimeDir,
      AIMAC_ORCHESTRATOR_INTERVAL_MS: "0", AIMAC_STATE_STORE: "runtime_json",
      AIMAC_BOOTSTRAP_TOKEN: "crash-probe-token-0123456789ab", DATABASE_URL: ""},
    stdio: ["ignore", "pipe", "pipe"]
  }));
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
    body: JSON.stringify({email: "system.admin@local", token: "crash-probe-token-0123456789ab"})})).json();
  return {authorization: `Bearer ${result.sessionToken}`, "content-type": "application/json"};
};

// ── 第一段：正常写入若干次，然后在下一次写入进行中硬杀
const port1 = await freePort();
let {child, base} = await startServer(port1);
let auth = await login(base);
const orgId = (await (await fetch(`${base}/api/state?view=orgs`, {headers: auth})).json()).organizations?.[0]?.orgId;
let acknowledged = 0;
for (let round = 0; round < 6; round += 1) {
  const response = await fetch(`${base}/api/orgs/${orgId}/quotas`, {method: "POST",
    headers: {...auth, "idempotency-key": `crash-${round}`}, body: JSON.stringify({quotas: {maxMembers: 40 + round}})});
  if (response.ok) acknowledged = 40 + round;
}
check(acknowledged === 45, "崩溃前的写入都被确认了", `maxMembers=${acknowledged}`);

// 不等响应就硬杀：让进程死在写入过程中。
// 单发一次很可能杀在写入之外 —— 那样"没有残留临时文件"只是运气。并发压一批再杀，
// 让"正在写"这件事在被杀的那一刻大概率成立；杀完再核对确实处于写入密集期（stateVersion 有推进）。
const versionBeforeKill = (await (await fetch(`${base}/api/state?view=orgs`, {headers: auth})).json()).stateVersion;
const inflight = Promise.all(Array.from({length: 12}, (_, index) => fetch(`${base}/api/orgs/${orgId}/quotas`, {method: "POST",
  headers: {...auth, "idempotency-key": `crash-inflight-${index}`},
  body: JSON.stringify({quotas: {maxMembers: 90 + index}})}).catch(() => null)));
await new Promise((resolve) => setTimeout(resolve, 40));
child.kill("SIGKILL");
await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 3000))]);
await inflight;

// ── 第二段：重启，状态必须能读回，且要么 45 要么 99，不能是坏的
const statePath = join(runtimeDir, "control-plane-state.json");
let parsed = null;
try { parsed = JSON.parse(readFileSync(statePath, "utf8")); } catch (error) { parsed = null; }
check(Boolean(parsed), "硬杀之后中央状态文件仍是完整 JSON", parsed ? `stateVersion=${parsed.stateVersion}` : "解析失败");
// 硬杀那一刻盘上留下临时文件与锁目录是必然的（进程没机会收尾）。要验的是【它们会不会自愈】：
// 锁必须不挡住后续写入，临时文件必须被下一次写入清掉 —— 否则一次崩溃攒一个，没人会去删。
const leftoversAtKill = existsSync(runtimeDir) ? readdirSync(runtimeDir).filter((name) => name.includes(".tmp-")) : [];
const lockAtKill = existsSync(runtimeDir) ? readdirSync(runtimeDir).filter((name) => name.includes(".lock")) : [];


const port2 = await freePort();
({child, base} = await startServer(port2));
// 恢复要【立刻】发生，不能靠等：只有时间兜底的话，崩溃后的第一次写入要白等一个宽限期，
// 而那第一次写入通常就是有人在登录。按持锁进程是否还活着判，才能做到立刻。
const recoveryStarted = Date.now();
const loginResult = await (await fetch(`${base}/api/auth/login`, {method: "POST", headers: {"content-type": "application/json"},
  body: JSON.stringify({email: "system.admin@local", token: "crash-probe-token-0123456789ab"})})).json();
const recoveryMs = Date.now() - recoveryStarted;
check(Boolean(loginResult.sessionToken), "重启后还能登录（登录要写会话，写不进去就等于系统废了）",
  loginResult.sessionToken ? "ok" : JSON.stringify(loginResult).slice(0, 160));
auth = {authorization: `Bearer ${loginResult.sessionToken}`, "content-type": "application/json"};
// 快恢复靠的是锁里那条 owner 记录（pid+host）：按持锁进程是否还活着来破锁。
// 但 SIGKILL 可能正好落在【建了锁目录、owner 还没写下去】的那个毫秒级窗口里 ——
// 那时按设计只能退回短宽限期，慢是【正确行为】，不是故障。
// 此前这一条只看"有没有留下锁目录"，于是落在那个窗口时会报一次假红
// （实测发生过一次，我差点把它当成刚改的代码引入的回归）。
// 门宁可说"这一轮没验到"，也不能报一个会让人查错方向的红。
const lockOwnerStamped = lockAtKill.some((name) => existsSync(join(runtimeDir, name, "owner.json")));
if (lockAtKill.length && lockOwnerStamped) {
  check(recoveryMs < 1500, "崩溃后的第一次写入立刻恢复（不是干等宽限期）", `${recoveryMs}ms`);
} else if (lockAtKill.length) {
  console.log(`  --  本轮 SIGKILL 落在建锁与写 owner 之间（锁目录里没有 owner 记录），`
    + `只能走时间兜底，"立刻恢复"这条未被检验（本轮 ${recoveryMs}ms）`);
} else {
  console.log("  --  本轮崩溃没有留下锁目录，\"立刻恢复\"这条未被检验");
}
const after = (await (await fetch(`${base}/api/state?view=orgs`, {headers: auth})).json()).organizations
  ?.find((item) => item.orgId === orgId);
const acceptable = [45, ...Array.from({length: 12}, (_, index) => 90 + index)];
check(acceptable.includes(after?.quotas?.maxMembers), "重启后读到的是某一次写入的完整结果，不是半份",
  `maxMembers=${after?.quotas?.maxMembers}`);
check(Number(parsed?.stateVersion || 0) > Number(versionBeforeKill || 0),
  "确实杀在写入密集期（被杀前状态版本推进过）", `${versionBeforeKill} → ${parsed?.stateVersion}`);

// 分片完整性：读一次完整状态，任何摘要对不上都会在这里抛
const full = await fetch(`${base}/api/state?view=tasks&limit=200`, {headers: auth});
check(full.ok, "重启后能正常读出任务视图（分片摘要校验通过）", `HTTP ${full.status}`);

// 还能继续写
const resumed = await fetch(`${base}/api/orgs/${orgId}/quotas`, {method: "POST",
  headers: {...auth, "idempotency-key": "crash-resume"}, body: JSON.stringify({quotas: {maxMembers: 55}})});
check(resumed.ok, "重启后还能继续写入（残留的锁没有把系统锁死）", `HTTP ${resumed.status}`);
const leftoversAfterWrite = readdirSync(runtimeDir).filter((name) => name.includes(".tmp-"));
// 这一轮若没撞上写入中途，清理逻辑根本没被检验 —— 报成 ok 就是假绿，必须自己说出来。
if (!leftoversAtKill.length) console.log("  --  本轮 SIGKILL 没有落在写入中途（盘上没有残留临时文件），清理这条未被检验");
if (!lockAtKill.length) console.log("  --  本轮 SIGKILL 没有留下写入锁，锁自愈这条未被检验");
if (leftoversAtKill.length) check(leftoversAfterWrite.length === 0, "崩溃留下的临时文件被下一次写入清掉了",
  `杀时 ${leftoversAtKill.length} 个 → 现在 ${leftoversAfterWrite.length} 个${leftoversAfterWrite.length ? "：" + leftoversAfterWrite.join(", ") : ""}`);

child.kill("SIGTERM");
await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 3000))]);
console.log(fails.length
  ? `crash consistency gate failed: ${fails.join("；")}`
  : "crash consistency gate ok: 写入中被 SIGKILL 后，状态不半份、锁不锁死系统、临时文件被下一次写入清掉");
process.exit(fails.length ? 1 : 0);
