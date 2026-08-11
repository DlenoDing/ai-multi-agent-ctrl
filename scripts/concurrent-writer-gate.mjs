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
const check = (ok, label, detail = "") => { console.log(`${ok ? "  ok " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`); if (!ok) fails.push(label); };

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
