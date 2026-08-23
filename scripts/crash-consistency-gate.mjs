// 写入过程中被 SIGKILL：状态必须要么是写入前那份、要么是写入后那份，不能是半份。
// 做法：真实服务端持续写入，在写入密集时硬杀，重启后读回并核对完整性（含分片摘要）。
import {spawn, spawnSync} from "node:child_process";
import {createServer} from "node:net";
import {once} from "node:events";
import {chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync, utimesSync, unlinkSync} from "node:fs";
import {join} from "node:path";
import {hostname, tmpdir} from "node:os";
import {installGateFetch} from "./lib/gate-fetch.mjs";

installGateFetch("崩溃一致性门");

import {basename, dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {createChildTracker, waitForChildExit} from "./lib/child-tracking.mjs";

// 起过的子进程一律登记，并在【所有】退出路径上收掉。
// 只在成功路径上 kill 是不够的：断言抛错、超时、Ctrl-C 时服务就成了孤儿（父进程没了、PPID=1），
// 而它还带着自治循环在跑。本机实测积了 13 个这样的进程、最久的活了 15 小时，
// 负载被抬到 7 以上 —— 后果不只是浪费：同一份代码的耗时量出 22s 和 99s 两个结果，
// 任何性能判断都作不得数。测试留下的垃圾会污染后面所有测试。
const {trackChild, killTrackedChildren} = createChildTracker();
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
await waitForChildExit(child, 3000);
await inflight;

// ── 第二段：重启，状态必须能读回，且要么 45 要么 99，不能是坏的
const statePath = join(runtimeDir, "control-plane-state.json");
let parsed = null;
try { parsed = JSON.parse(readFileSync(statePath, "utf8")); } catch (error) { parsed = null; }
// 盘写不进去（满盘 / 只读挂载 / 权限 / 配额）是真实的运维故障，而它此前回的是 500 加一句
// Node 的原始英文错误，报文里还带着服务器的绝对路径：中文界面上看不懂，运维也不知道该查什么。
// 这里把运行目录改成不可写走一遍真实写入路径：必须是稳定错误码 + 不带路径；
// 读要照常（只读操作不该被写故障拖下水）；恢复可写之后不重启也能继续写。
{
  // startServer 固定用本门自己的 runtimeDir，这里要的是另一个目录，所以自己起一个。
  const roDir = mkdtempSync(join(tmpdir(), "aimac-crash-ro-"));
  spawnSync(process.execPath, ["scripts/init-control-plane.mjs"], {cwd: root, encoding: "utf8",
    env: {...process.env, AIMAC_RUNTIME_DIR: roDir, AIMAC_STATE_STORE: "runtime_json", DATABASE_URL: "",
      AIMAC_BOOTSTRAP_TOKEN: "crash-ro-token-0123456789ab"}});
  const roPort = await freePort();
  const roChild = trackChild(spawn(process.execPath, ["apps/control-plane-ui/server.mjs"], {
    cwd: root,
    env: {...process.env, AIMAC_HOST: "127.0.0.1", AIMAC_PORT: String(roPort), AIMAC_RUNTIME_DIR: roDir,
      AIMAC_ORCHESTRATOR_INTERVAL_MS: "0", AIMAC_STATE_STORE: "runtime_json",
      AIMAC_BOOTSTRAP_TOKEN: "crash-ro-token-0123456789ab", DATABASE_URL: ""},
    stdio: ["ignore", "pipe", "pipe"]
  }));
  const roBase = `http://127.0.0.1:${roPort}`;
  const roDeadline = Date.now() + 25000;
  while (Date.now() < roDeadline) {
    try { const probe = await fetch(`${roBase}/api/health`); if (probe.ok) break; } catch { /* 等它起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const call = async (path, options = {}) => {
    const response = await fetch(`${roBase}${path}`, {
      method: options.method || "GET",
      headers: {"content-type": "application/json", ...(options.headers || {})},
      ...(options.body ? {body: JSON.stringify(options.body)} : {})
    });
    let payload = {};
    try { payload = await response.json(); } catch { /* 空体 */ }
    return {status: response.status, payload};
  };
  try {
    const session = await call("/api/auth/login", {method: "POST",
      body: {email: "system.admin@local", token: "crash-ro-token-0123456789ab"}});
    const auth = {authorization: `Bearer ${session.payload.sessionToken}`};
    chmodSync(roDir, 0o500);
    const blocked = await call("/api/task-groups", {method: "POST",
      headers: {...auth, "idempotency-key": "crash-ro-1"},
      body: {projectId: "prj_control_plane", title: "只读盘上的任务组"}});
    check(blocked.status === 503 && blocked.payload.error === "state_storage_unavailable",
      "盘写不进去时给的是稳定错误码，不是 500 加一句原始报错",
      `HTTP ${blocked.status} ${blocked.payload.error || ""}`);
    check(!JSON.stringify(blocked.payload).includes(roDir),
      "写失败的报文里不带服务器的绝对路径", JSON.stringify(blocked.payload).slice(0, 90));
    const stillReads = await call("/api/state?view=tasks&limit=10", {headers: auth});
    check(stillReads.status === 200, "盘不可写时读操作照常（不该被写故障拖下水）", `HTTP ${stillReads.status}`);
    // 上面几条只问了"写请求得到什么"。真正决定运维知不知道出事的是【健康页】——
    // 而它原先一路回 ok：磁盘一个字都写不进去，监控探针全绿，每一次写都在 503。
    // 原因是"写不进磁盘"这一支根本不登记 storageFault（只有"状态损坏"那一支登记）。
    const degraded = await call("/api/health");
    check(degraded.status === 503 && degraded.payload.status === "degraded",
      "盘不可写时健康页必须转 degraded（否则监控一路绿灯，而每一次写都在 503）",
      `HTTP ${degraded.status} ${degraded.payload.status || ""}`);
    check(String(degraded.payload.hint || "").includes("写不进磁盘"),
      "健康页要说清是【写】不进去，不能套用「状态读不出来」那句 —— 运维会去查文件损坏，而实际是盘满或只读",
      String(degraded.payload.hint || "").slice(0, 60));
    chmodSync(roDir, 0o700);
    // 故障标记只置不清的话，修好了它也一直报 degraded；而复核不能统一用"读得出来吗"——
    // 盘不可写时状态照样读得出来，那样故障会被当场清掉（这一支要按可写性复核）。
    const healthy = await call("/api/health");
    check(healthy.status === 200 && healthy.payload.status === "ok",
      "盘恢复可写之后健康页自己转回 ok（不必重启）",
      `HTTP ${healthy.status} ${healthy.payload.status || ""}`);
    const recovered = await call("/api/task-groups", {method: "POST",
      headers: {...auth, "idempotency-key": "crash-ro-2"},
      body: {projectId: "prj_control_plane", title: "恢复之后"}});
    check(recovered.status === 201, "盘恢复可写之后不重启也能继续写", `HTTP ${recovered.status}`);
  } finally {
    try { chmodSync(roDir, 0o700); } catch { /* 尽力而为 */ }
    roChild.kill("SIGKILL");
  }
}

// 故障标记不能只置不清：修好之后还一直报 degraded，人就会开始无视这个信号。
// 但要分清两种 —— 文件损坏后还原了，本进程重读一次就好；而目录被换 / 状态被重建成空的，
// 进程已经接在另一份数据上，把数据还原回去也救不了它，必须重启。提示要如实说清是哪一种。
{
  const recDir = mkdtempSync(join(tmpdir(), "aimac-crash-recover-"));
  spawnSync(process.execPath, ["scripts/init-control-plane.mjs"], {cwd: root, encoding: "utf8",
    env: {...process.env, AIMAC_RUNTIME_DIR: recDir, AIMAC_STATE_STORE: "runtime_json", DATABASE_URL: "",
      AIMAC_BOOTSTRAP_TOKEN: "crash-recover-token-0123456789ab"}});
  const recStatePath = join(recDir, "control-plane-state.json");
  const recGood = readFileSync(recStatePath, "utf8");
  const recPort = await freePort();
  const recChild = trackChild(spawn(process.execPath, ["apps/control-plane-ui/server.mjs"], {
    cwd: root,
    env: {...process.env, AIMAC_HOST: "127.0.0.1", AIMAC_PORT: String(recPort), AIMAC_RUNTIME_DIR: recDir,
      AIMAC_ORCHESTRATOR_INTERVAL_MS: "0", AIMAC_STATE_STORE: "runtime_json", DATABASE_URL: ""},
    stdio: ["ignore", "pipe", "pipe"]
  }));
  const recBase = `http://127.0.0.1:${recPort}`;
  const recHealth = async () => {
    const response = await fetch(`${recBase}/api/health`);
    return {status: response.status, payload: await response.json().catch(() => ({}))};
  };
  try {
    const readyBy = Date.now() + 20000;
    while (Date.now() < readyBy) {
      try { if ((await fetch(`${recBase}/api/health`)).ok) break; } catch { /* 等它起来 */ }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    writeFileSync(recStatePath, recGood.slice(0, 300));
    const broken = await recHealth();
    check(broken.status === 503, "弄坏之后健康检查确实转红（否则下面那条无从验证）", `HTTP ${broken.status}`);
    check(/自动转回 ok/u.test(broken.payload.hint || ""),
      "可自愈的这一类，提示要说它会自己转回来", String(broken.payload.hint || "").slice(0, 60));
    writeFileSync(recStatePath, recGood);
    const healed = await recHealth();
    check(healed.status === 200 && healed.payload.status === "ok",
      "还原之后健康检查自动转回 ok（故障标记不能只置不清）", `HTTP ${healed.status} ${JSON.stringify(healed.payload.storageFault || "ok")}`);
    rmSync(join(recDir, "control-plane-state.json"), {force: true});
    await recHealth();
    const needsRestart = await recHealth();
    check(/重启本进程/u.test(needsRestart.payload.hint || ""),
      "救不回来的那一类，提示要说必须重启（还原数据不够）", String(needsRestart.payload.hint || "").slice(0, 60));
  } finally {
    recChild.kill("SIGKILL");
  }
}

// 只把状态文件删掉（目录还在）：存储层会按种子重建一份空的，登录全失败，而健康检查照样 ok。
// 目录 inode 那条判据认不出这种 —— 目录没变。所以让存储层把"我刚重建过"说出来，
// 启动之后的重建一律算故障（首次部署时的重建是正常的，靠时间戳区分）。
{
  const seedDir = mkdtempSync(join(tmpdir(), "aimac-crash-seed-"));
  spawnSync(process.execPath, ["scripts/init-control-plane.mjs"], {cwd: root, encoding: "utf8",
    env: {...process.env, AIMAC_RUNTIME_DIR: seedDir, AIMAC_STATE_STORE: "runtime_json", DATABASE_URL: "",
      AIMAC_BOOTSTRAP_TOKEN: "crash-seed-token-0123456789ab"}});
  const seedPort = await freePort();
  const seedChild = trackChild(spawn(process.execPath, ["apps/control-plane-ui/server.mjs"], {
    cwd: root,
    env: {...process.env, AIMAC_HOST: "127.0.0.1", AIMAC_PORT: String(seedPort), AIMAC_RUNTIME_DIR: seedDir,
      AIMAC_ORCHESTRATOR_INTERVAL_MS: "0", AIMAC_STATE_STORE: "runtime_json", DATABASE_URL: ""},
    stdio: ["ignore", "pipe", "pipe"]
  }));
  const seedBase = `http://127.0.0.1:${seedPort}`;
  try {
    const readyBy = Date.now() + 20000;
    while (Date.now() < readyBy) {
      try { if ((await fetch(`${seedBase}/api/health`)).ok) break; } catch { /* 等它起来 */ }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    rmSync(join(seedDir, "control-plane-state.json"), {force: true});
    const after = await fetch(`${seedBase}/api/health`);
    const payload = await after.json().catch(() => ({}));
    check(after.status === 503 && payload.storageFault?.kind === "state_rebuilt_from_seed",
      "状态文件被删后按种子重建，健康检查要认这是故障（不能一边空着一边报 ok）",
      `HTTP ${after.status} ${JSON.stringify(payload.storageFault || payload).slice(0, 80)}`);
  } finally {
    seedChild.kill("SIGKILL");
  }
}

// 运行目录在跑着的时候被清掉（有人清 /tmp、挂载掉了）：存储层会静默重建一份空状态 ——
// 登录全失败、数据全没了，而 /api/health 照样 200。只查"文件在不在"是没用的：请求管线里的
// ensureState 已经把它重建出来了。按 inode 认：重建出来的是另一个文件。
{
  const wipeDir = mkdtempSync(join(tmpdir(), "aimac-crash-wipe-"));
  spawnSync(process.execPath, ["scripts/init-control-plane.mjs"], {cwd: root, encoding: "utf8",
    env: {...process.env, AIMAC_RUNTIME_DIR: wipeDir, AIMAC_STATE_STORE: "runtime_json", DATABASE_URL: "",
      AIMAC_BOOTSTRAP_TOKEN: "crash-wipe-token-0123456789ab"}});
  const wipePort = await freePort();
  const wipeChild = trackChild(spawn(process.execPath, ["apps/control-plane-ui/server.mjs"], {
    cwd: root,
    env: {...process.env, AIMAC_HOST: "127.0.0.1", AIMAC_PORT: String(wipePort), AIMAC_RUNTIME_DIR: wipeDir,
      AIMAC_ORCHESTRATOR_INTERVAL_MS: "0", AIMAC_STATE_STORE: "runtime_json", DATABASE_URL: ""},
    stdio: ["ignore", "pipe", "pipe"]
  }));
  const wipeBase = `http://127.0.0.1:${wipePort}`;
  try {
    const readyBy = Date.now() + 20000;
    let healthy = false;
    while (Date.now() < readyBy) {
      try { if ((await fetch(`${wipeBase}/api/health`)).ok) { healthy = true; break; } } catch { /* 等它起来 */ }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    check(healthy, "清目录之前健康检查是 ok（否则下面那条无从对比）", String(healthy));
    rmSync(wipeDir, {recursive: true, force: true});
    // 触发一次请求，让存储层把空状态重建出来（真实场景里下一个请求就会这么做）
    await fetch(`${wipeBase}/api/state?view=tasks&limit=5`).catch(() => null);
    const after = await fetch(`${wipeBase}/api/health`);
    const payload = await after.json().catch(() => ({}));
    check(after.status === 503 && payload.status === "degraded",
      "运行目录被清掉之后健康检查转成 degraded（不能一边失忆一边报 ok）",
      `HTTP ${after.status} ${JSON.stringify(payload).slice(0, 80)}`);
    check(["runtime_dir_missing", "runtime_dir_replaced"].includes(payload.storageFault?.kind),
      "说得出是运行目录没了/被换了", JSON.stringify(payload.storageFault || null));
  } finally {
    wipeChild.kill("SIGKILL");
  }
}

// 运行时配置被改坏（人手改 runtime-config.json 加错一个逗号，是很常见的一步）。
// 此前启动只吐一句 "Expected property name or '}' in JSON at position 2" —— 连是哪个文件都没有，
// 而这套部署里同时有三份 JSON（运行时配置 / 中央状态 / 种子）。报文要点名文件并给下一步。
{
  const badCfgDir = mkdtempSync(join(tmpdir(), "aimac-crash-badcfg-"));
  spawnSync(process.execPath, ["scripts/init-control-plane.mjs"], {cwd: root, encoding: "utf8",
    env: {...process.env, AIMAC_RUNTIME_DIR: badCfgDir, AIMAC_STATE_STORE: "runtime_json", DATABASE_URL: "",
      AIMAC_BOOTSTRAP_TOKEN: "crash-badcfg-token-0123456789ab"}});
  writeFileSync(join(badCfgDir, "runtime-config.json"), "{ 这不是 json\n");
  const said = spawnSync(process.execPath, ["apps/control-plane-ui/server.mjs"], {cwd: root, encoding: "utf8",
    env: {...process.env, AIMAC_HOST: "127.0.0.1", AIMAC_PORT: "0", AIMAC_RUNTIME_DIR: badCfgDir,
      AIMAC_ORCHESTRATOR_INTERVAL_MS: "0", AIMAC_STATE_STORE: "runtime_json", DATABASE_URL: ""},
    timeout: 20000});
  const text = `${said.stdout || ""}${said.stderr || ""}`;
  check(/运行时配置/u.test(text) && text.includes("runtime-config.json"),
    "运行时配置坏了要点名是哪一份文件（三份 JSON 里的哪一份）",
    text.trim().split("\n")[0].slice(0, 120) || "（什么都没说）");
  check(/npm run init|删掉/u.test(text),
    "并且要给下一步（这份配置可以删掉重生成）",
    text.trim().split("\n").slice(0, 3).join(" ｜ ").slice(0, 140));
  rmSync(badCfgDir, {recursive: true, force: true});
}

// 状态文件损坏（截断 / 半份 / 被别的东西覆盖）是崩溃与坏盘之后的常见残局。此前两种都很难处置：
// 中央文件坏了，服务照样打印启动横幅，只有 /api/health 回 500 加一句 "Unterminated string in JSON
// at position 31584"；分片坏了更糟 —— 服务起来了、健康检查一路 200，而读数据全 500，监控是绿的。
// 现在两种都给带文件名的稳定码，且存储故障会把健康检查压成 degraded。
{
  const corruptDir = mkdtempSync(join(tmpdir(), "aimac-crash-corrupt-"));
  spawnSync(process.execPath, ["scripts/init-control-plane.mjs"], {cwd: root, encoding: "utf8",
    env: {...process.env, AIMAC_RUNTIME_DIR: corruptDir, AIMAC_STATE_STORE: "runtime_json", DATABASE_URL: "",
      AIMAC_BOOTSTRAP_TOKEN: "crash-corrupt-token-0123456789ab"}});
  const corruptStatePath = join(corruptDir, "control-plane-state.json");
  writeFileSync(corruptStatePath, readFileSync(corruptStatePath, "utf8").slice(0, 200));
  const corruptPort = await freePort();
  const corruptChild = trackChild(spawn(process.execPath, ["apps/control-plane-ui/server.mjs"], {
    cwd: root,
    env: {...process.env, AIMAC_HOST: "127.0.0.1", AIMAC_PORT: String(corruptPort), AIMAC_RUNTIME_DIR: corruptDir,
      AIMAC_ORCHESTRATOR_INTERVAL_MS: "0", AIMAC_STATE_STORE: "runtime_json", DATABASE_URL: ""},
    stdio: ["ignore", "pipe", "pipe"]
  }));
  try {
    let health = {status: 0, payload: {}};
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${corruptPort}/api/health`);
        health = {status: response.status, payload: await response.json().catch(() => ({}))};
        break;
      } catch { await new Promise((resolve) => setTimeout(resolve, 150)); }
    }
    check(health.status === 503 && health.payload.status === "degraded",
      "中央状态文件损坏时健康检查报 degraded（不是 200，也不是一句原始解析错误）",
      `HTTP ${health.status} ${JSON.stringify(health.payload).slice(0, 80)}`);
    check(health.payload.storageFault?.kind === "control_plane_state_corrupt"
      && Boolean(health.payload.storageFault?.file),
      "损坏报文说得出是哪一份文件（否则运维不知道该恢复哪个）",
      JSON.stringify(health.payload.storageFault || null));
    check(!JSON.stringify(health.payload).includes(corruptDir),
      "损坏报文里不带服务器的绝对路径", JSON.stringify(health.payload).slice(0, 90));
  } finally {
    corruptChild.kill("SIGKILL");
  }
}

// 上面那条"硬杀之后仍是完整 JSON"只有在 SIGKILL 恰好落进写窗口时才会红：实测把原子替换整个
// 拿掉、连跑五次仍然全绿（中央状态文件小、写得快，撞不上）。它证不了原子性，只能算个抽查。
// 原子性该按【结构】证：每一处持久写入都必须写临时文件、再 rename 到目标路径。
// 这条是确定性的 —— 把 temp 换成目标路径当场就红，不看运气。
{
  const storeSource = readFileSync(new URL("../apps/control-plane-ui/lib/state-store.mjs", import.meta.url), "utf8");
  const writeSites = [...storeSource.matchAll(/writeDurableFile\(([^,]+),/gu)]
    .map((match) => match[1].trim())
    .filter((target) => target !== "path"); // 定义处本身不算调用点
  check(writeSites.length >= 2, "取到了持久写入点（否则这条结构判据在空转）", `${writeSites.length} 处`);
  const nonAtomic = writeSites.filter((target) => target !== "temporary");
  check(nonAtomic.length === 0,
    "每一处持久写入都先写临时文件再 rename（原子替换，不就地改目标文件）",
    nonAtomic.length ? `这些写入直接落在目标路径上：${nonAtomic.join("、")}` : `${writeSites.length} 处都走临时文件`);
  const renames = [...storeSource.matchAll(/renameSync\(temporary,\s*([^)]+)\)/gu)].length;
  check(renames >= writeSites.length,
    "每一处临时文件都有对应的 rename（写了不改名等于没写进去）", `rename ${renames} 处 / 写入 ${writeSites.length} 处`);
  // 只看"实参叫 temporary"是看不住的：把 temporary 本身赋成目标路径，上面两条照样绿
  // （实测如此）。判据要落在【它到底指向哪】—— 必须是一条带 .tmp- 的独立路径。
  const temporaryBindings = [...storeSource.matchAll(/const temporary = ([^;]+);/gu)].map((match) => match[1]);
  check(temporaryBindings.length >= 2, "取到了临时路径的赋值（否则这条在空转）", `${temporaryBindings.length} 处`);
  const notTemp = temporaryBindings.filter((expression) => !expression.includes(".tmp-"));
  check(notTemp.length === 0,
    "临时路径必须是另一条路径（带 .tmp- 后缀），不能就是目标文件本身",
    notTemp.length ? `这些赋值直接指向目标文件：${notTemp.join("｜")}` : `${temporaryBindings.length} 处都带 .tmp-`);
}

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
// 上面那条"崩溃后立刻恢复"只有在 SIGKILL 恰好落在【owner 记录写完之后】才验得到 ——
// 落在建目录与写 owner 之间就只能走时间兜底，这一轮就整条跳过了。也就是说"按持锁进程存活破锁"
// 这条性质是否被检验取决于运气：实测把它改坏，变异门时红时绿。
// 所以这里直接造出确定的场景：留一把 owner 指向【已死进程】的锁，再做一次真实写入。
{
  const deadLockDir = `${statePath}.lock`;
  const deadPid = 2147480000; // 远超真实 pid 范围，必定不存在
  let staged = false;
  try {
    mkdirSync(deadLockDir, {recursive: true});
    writeFileSync(join(deadLockDir, "owner.json"),
      JSON.stringify({pid: deadPid, host: hostname(), at: new Date(0).toISOString()}));
    staged = existsSync(join(deadLockDir, "owner.json"));
  } catch { staged = false; }
  if (!staged) {
    console.log("  --  造不出'持有者已死'的锁，锁自愈这条未被检验");
  } else {
    const deadLockStarted = Date.now();
    const afterDeadLock = await fetch(`${base}/api/auth/login`, {method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({email: "system.admin@local", token: "crash-probe-token-0123456789ab"})});
    const deadLockMs = Date.now() - deadLockStarted;
    check(afterDeadLock.ok && deadLockMs < 3000,
      "持锁进程已死时立刻破锁（不是干等宽限期）",
      `HTTP ${afterDeadLock.status}，用时 ${deadLockMs}ms —— 只靠时间兜底会等满宽限期`);
  }
}
// 与上面那把"已死的锁"同一个道理：残留临时文件的清理只有在 SIGKILL 恰好落在写入中途时才验得到，
// 而那要看运气（实测多数轮次都没撞上，这条整条跳过）。所以直接把前置条件造出来。
// 临时文件有【两个】清理器，规则不同，必须分开造，否则一个夹具会同时满足两条、测不准是谁干的：
//   · sweepStaleTempFiles —— 按年龄（60 秒以上才扫），防的是"崩溃攒下的垃圾没人删"；
//   · sweepOrphanTempFiles —— 按写入者 pid 还活不活着，与年龄无关。
// 还要有第三种：pid 活着、文件也新 —— 这一个【绝不能被碰】，那是并发在飞的写入正用着的文件，
// 扫掉它就是把一次好写入毁掉。第一版我给"新文件"起名时用了一个不存在的 pid，
// 于是它被 orphan 那条正确地扫掉，判据却报成"60 秒规则失效" —— 夹具把两套机制混成了一个。
{
  const tempNamed = (pid, tag) => join(runtimeDir, `${basename(statePath)}.tmp-${pid}-${tag}`);
  const livePid = process.pid; // 本门自己：确实活着，且不是服务端进程自己
  const agedTemp = tempNamed(livePid, "agedfile");
  const orphanTemp = tempNamed(999999, "orphanfile");
  const inFlightTemp = tempNamed(livePid, "inflightfile");
  let staged = false;
  try {
    for (const path of [agedTemp, orphanTemp, inFlightTemp]) writeFileSync(path, "{}");
    const twoMinutesAgo = new Date(Date.now() - 120000);
    utimesSync(agedTemp, twoMinutesAgo, twoMinutesAgo);
    staged = [agedTemp, orphanTemp, inFlightTemp].every((path) => existsSync(path));
  } catch { staged = false; }
  if (!staged) {
    console.log("  --  造不出残留临时文件，清理这条未被检验");
  } else {
    // 端点用门里已经验过能写的那个 —— 我第一版拼错了路径，拿到 404，
    // 那条断言当场变成"在测我有没有拼错 URL"，而不是在测清理逻辑。
    const sweep = await fetch(`${base}/api/orgs/${orgId}/quotas`, {method: "POST",
      headers: {...auth, "idempotency-key": "crash-sweep"}, body: JSON.stringify({quotas: {maxMembers: 57}})});
    check(sweep.ok && !existsSync(agedTemp),
      "崩溃攒下的临时文件（够旧）被下一次写入清掉",
      `HTTP ${sweep.status}，${existsSync(agedTemp) ? "那个文件还在" : "已清掉"}`);
    check(!existsSync(orphanTemp),
      "写入者进程已死的临时文件被清掉（不必等够 60 秒）",
      existsSync(orphanTemp) ? "那个文件还在 —— 一次崩溃攒一个，没人会去删" : "已清掉");
    check(existsSync(inFlightTemp),
      "写入者还活着、文件也还新的临时文件绝不能碰（那是在飞的写入）",
      existsSync(inFlightTemp) ? "还在，没被碰" : "被扫掉了 —— 这会把一次正在进行的好写入毁掉");
    for (const path of [agedTemp, orphanTemp, inFlightTemp]) {
      try { unlinkSync(path); } catch { /* 清理探针自己留下的东西 */ }
    }
  }
}

const leftoversAfterWrite = readdirSync(runtimeDir).filter((name) => name.includes(".tmp-"));
// 这一轮若没撞上写入中途，清理逻辑根本没被检验 —— 报成 ok 就是假绿，必须自己说出来。
if (!leftoversAtKill.length) console.log("  --  本轮 SIGKILL 没有落在写入中途（盘上没有残留临时文件），清理这条未被检验");
if (!lockAtKill.length) console.log("  --  本轮 SIGKILL 没有留下写入锁，锁自愈这条未被检验");
if (leftoversAtKill.length) check(leftoversAfterWrite.length === 0, "崩溃留下的临时文件被下一次写入清掉了",
  `杀时 ${leftoversAtKill.length} 个 → 现在 ${leftoversAfterWrite.length} 个${leftoversAfterWrite.length ? "：" + leftoversAfterWrite.join(", ") : ""}`);

child.kill("SIGTERM");

await waitForChildExit(child, 3000);

// 【备份／还原】：设计文档把它列为要求，而此前没有任何东西验过"拷下来的那份还原得回去"。
// 运维最自然的做法是【不停机直接 cp -R 运行目录】—— 那一刻中央索引与项目分片、事件段清单
// 可能各处在不同时刻。分片是按 generation 命名的（旧的那份在盘上还留着），加上落盘都走
// 原子改名，所以这样拷到的是【某一时刻的完整快照】。这条性质今天正好被我改到的那几处
// （分片索引/摘要/段清单）撑着，必须钉住，否则将来某次"顺手删掉旧 generation"就会让它悄悄失效。
{
  const backupBase = mkdtempSync(join(tmpdir(), "aimac-backup-"));
  const liveDir = join(backupBase, "live");
  const copyDir = join(backupBase, "copy");
  const halfDir = join(backupBase, "half");
  const bootstrapToken = "backup-gate-token-0123456789ab";
  const initResult = spawnSync(process.execPath, ["scripts/init-control-plane.mjs"], {cwd: root, encoding: "utf8",
    env: {...process.env, AIMAC_RUNTIME_DIR: liveDir, AIMAC_STATE_STORE: "runtime_json", DATABASE_URL: "",
      AIMAC_BOOTSTRAP_TOKEN: bootstrapToken}});
  const startServer = async (dir, port) => {
    const server = trackChild(spawn(process.execPath, ["apps/control-plane-ui/server.mjs"], {cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: {...process.env, AIMAC_HOST: "127.0.0.1", AIMAC_PORT: String(port), AIMAC_RUNTIME_DIR: dir,
        AIMAC_ORCHESTRATOR_INTERVAL_MS: "0", AIMAC_STATE_STORE: "runtime_json", DATABASE_URL: "",
        AIMAC_BOOTSTRAP_TOKEN: bootstrapToken, AIMAC_EXIT_WITH_PARENT: "1"}}));
    let stderr = "";
    server.stderr.on("data", (chunk) => { stderr += String(chunk); });
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try { await fetch(`http://127.0.0.1:${port}/api/health`); return {server, stderr: () => stderr, up: true}; }
      catch { await new Promise((resolve) => setTimeout(resolve, 150)); }
    }
    return {server, stderr: () => stderr, up: false};
  };
  try {
    if (initResult.status !== 0) {
      check(false, "备份还原的夹具起不来", `init 退出码 ${initResult.status}：${String(initResult.stderr || "").slice(0, 120)}`);
    } else {
      const livePort = await freePort();
      const live = await startServer(liveDir, livePort);
      const login = await (await fetch(`http://127.0.0.1:${livePort}/api/auth/login`, {method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({email: "system.admin@local", token: bootstrapToken})})).json().catch(() => ({}));
      let written = 0;
      let stopWriting = false;
      const writer = (async () => {
        while (!stopWriting) {
          const response = await fetch(`http://127.0.0.1:${livePort}/api/task-groups`, {method: "POST",
            headers: {authorization: `Bearer ${login.sessionToken}`, "content-type": "application/json",
              "idempotency-key": `backup-gate-${written}`},
            body: JSON.stringify({projectId: "prj_control_plane", title: `备份期任务组 ${written}`})});
          if (response.status === 201) written += 1;
          await response.text();
        }
      })();
      await new Promise((resolve) => setTimeout(resolve, 700));
      // 用【文档里让运维用的那个脚本】备份，而不是在门里另写一份 cp —— 判据要压在真实产出上。
      // 它自己会重试并按索引核对：裸 cp 在写入密集时会撞上正在改名的临时文件（实测三次中一次），
      // 更要紧的是可能拷到"中央索引指着已被 GC 删掉的旧分片"那种看着完整、还原不回来的快照。
      const backup = spawnSync(process.execPath, ["scripts/backup-runtime.mjs", liveDir, copyDir],
        {cwd: root, encoding: "utf8"});
      check(backup.status === 0, "不停机备份（npm run backup）在持续写入下也能拿到通过核对的快照",
        `退出码 ${backup.status}：${String(backup.stdout || backup.stderr || "").trim().split("\n")[0].slice(0, 120)}`);
      cpSync(liveDir, halfDir, {recursive: true, force: true});
      rmSync(join(halfDir, "project-db"), {recursive: true, force: true});   // 只拷了一半的那种备份
      stopWriting = true;
      await writer;
      live.server.kill("SIGKILL");
      if (written < 3) {
        check(false, "备份还原的夹具没造出想测的情形", `拷贝期间只写成功了 ${written} 次，快照里几乎没有变化`);
      } else {
        const restoredPort = await freePort();
        const restored = await startServer(copyDir, restoredPort);
        const health = restored.up
          ? await (await fetch(`http://127.0.0.1:${restoredPort}/api/health`)).json().catch(() => ({})) : {};
        check(restored.up && health.status === "ok",
          "不停机拷下来的运行目录，还原之后起得来且健康检查为 ok",
          `起来了=${restored.up} health=${health.status || JSON.stringify(health.storageFault || {}).slice(0, 80)}`);
        const restoredLogin = restored.up ? await (await fetch(`http://127.0.0.1:${restoredPort}/api/auth/login`,
          {method: "POST", headers: {"content-type": "application/json"},
            body: JSON.stringify({email: "system.admin@local", token: bootstrapToken})})).json().catch(() => ({})) : {};
        let groups = -1;
        if (restoredLogin.sessionToken) {
          const view = await (await fetch(`http://127.0.0.1:${restoredPort}/api/state?view=tasks&limit=200&projectId=prj_control_plane`,
            {headers: {authorization: `Bearer ${restoredLogin.sessionToken}`}})).json().catch(() => ({}));
          groups = (view.taskGroups || []).length;
        }
        check(groups > 0, "还原之后读得出项目数据（分片与中央索引对得上）",
          `读到 ${groups} 个任务组（拷贝期间共写成功 ${written} 个）`);
        restored.server.kill("SIGKILL");

        // 只拷了中央文件、漏掉 project-db 的那种"半份备份"：必须响亮地拒绝，
        // 而不是带着一份【没有任何项目数据】的状态照常起来 —— 那才是最坏的：
        // 人以为还原成功了，登录进去发现活全没了，而系统一句话都没说。
        const halfPort = await freePort();
        const half = await startServer(halfDir, halfPort);
        const halfHealth = half.up
          ? await (await fetch(`http://127.0.0.1:${halfPort}/api/health`)).json().catch(() => ({})) : {};
        const complained = /shard|分片/u.test(JSON.stringify(halfHealth)) || /shard/u.test(half.stderr());
        check(halfHealth.status !== "ok" && complained,
          "只拷了一半的备份（漏掉 project-db）必须报出来，不许带着空项目照常起来",
          `health=${halfHealth.status || "起不来"} 说了分片=${complained}`);
        half.server.kill("SIGKILL");

        // 备份脚本自己的承诺也要验，而且要【确定性地】验：拿一份明知残缺的运行目录
        // （中央索引记着分片、project-db 却不在）让它备份，它必须拒绝并说清缺什么。
        // 不这么验的话，"拷完核一遍"那一步被删掉也照样绿 —— 竞态不撞上时，没核对的拷贝多半也是好的。
        const refused = spawnSync(process.execPath,
          ["scripts/backup-runtime.mjs", halfDir, join(backupBase, "half-backup")],
          {cwd: root, encoding: "utf8", env: {...process.env, AIMAC_BACKUP_ATTEMPTS: "1"}});
        const said = `${refused.stdout || ""}${refused.stderr || ""}`;
        check(refused.status !== 0 && /project-db|分片/u.test(said),
          "备份脚本对着一份残缺的运行目录必须拒绝（拷完要核，不是拷完就算）",
          `退出码 ${refused.status}：${said.trim().split("\n")[0].slice(0, 110)}`);

        // 只核对、不拷贝的那个模式（`--verify <目录>`）：备份是在【拷的那一刻】核过的，
        // 而人手里的备份未必出自这个命令（README 自己警告过 `cp -R` 会拷出"看着完整"的目录）。
        // 两个方向都验：好的要过、残缺的要拒 —— 只验一个方向的话，一个恒真/恒假的实现也能过。
        const checkedBadRun = spawnSync(process.execPath, ["scripts/backup-runtime.mjs", "--verify", halfDir],
          {cwd: root, encoding: "utf8"});
        const badSaid = `${checkedBadRun.stdout || ""}${checkedBadRun.stderr || ""}`;
        check(checkedBadRun.status !== 0 && /project-db|分片/u.test(badSaid),
          "只核对模式：对着残缺目录必须拒绝并说清缺什么",
          `退出码 ${checkedBadRun.status}：${badSaid.trim().split("\n")[0].slice(0, 110)}`);
        const checkedGoodRun = spawnSync(process.execPath, ["scripts/backup-runtime.mjs", "--verify", copyDir],
          {cwd: root, encoding: "utf8"});
        check(checkedGoodRun.status === 0 && /核对通过/u.test(`${checkedGoodRun.stdout || ""}`),
          "只核对模式：对着上面那份刚核过的备份必须通过（否则它就是个恒假的实现）",
          `退出码 ${checkedGoodRun.status}：${`${checkedGoodRun.stdout || ""}${checkedGoodRun.stderr || ""}`.trim().split("\n")[0].slice(0, 110)}`);
      }
    }
  } finally {
    rmSync(backupBase, {recursive: true, force: true});
  }
}
console.log(fails.length
  ? `crash consistency gate failed: ${fails.join("；")}`
  : "crash consistency gate ok: 写入中被 SIGKILL 后，状态不半份、锁不锁死系统、临时文件被下一次写入清掉");
process.exit(fails.length ? 1 : 0);
