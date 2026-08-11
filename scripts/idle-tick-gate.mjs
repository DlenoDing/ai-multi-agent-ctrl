// 自治循环空转时不得落盘 —— 但也不得因此让系统看起来死了、或挡住真实进展。
// 实测背景：空转一拍会重写一堆派生记录并全量落盘，2000 单元时一拍卡死整个服务 2.3 秒，
// 而且每分钟作废一次所有客户端的 ETag，让每个控制台重新拉视图、重建 DOM。
// 这道门用真实服务端验三件事：空转会收敛到不落盘；空转期间系统仍自报"还活着"；有真活时照样推进。
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {once} from "node:events";
import {mkdtempSync} from "node:fs";
import {join, dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {tmpdir} from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

const tickMs = 3000;
const port = await freePort();
const child = spawn(process.execPath, ["apps/control-plane-ui/server.mjs"], {cwd: root,
  env: {...process.env, AIMAC_HOST: "127.0.0.1", AIMAC_PORT: String(port), AIMAC_RUNTIME_DIR: runtimeDir,
    AIMAC_ORCHESTRATOR_INTERVAL_MS: String(tickMs), AIMAC_STATE_STORE: "runtime_json",
    AIMAC_BOOTSTRAP_TOKEN: "idle-tick-gate-token-0123456789", DATABASE_URL: ""},
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

child.kill("SIGTERM");
await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 3000))]);
if (fails.length) {
  console.error(`idle tick gate failed: ${fails.join("；")}`);
  process.exit(1);
}
console.log("idle tick gate ok: 空转不落盘、空转期间仍自报在跑、有真活时照常推进");
