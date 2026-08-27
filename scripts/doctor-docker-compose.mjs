#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { dockerFailureAdvice } from "./lib/docker-failure-advice.mjs";

const root = new URL("..", import.meta.url).pathname;
// 运维起容器走的是 scripts/docker-up.sh。两个 compose 命令都不在时，原先落到 exec 上，
// 人看到的是 "docker-compose: command not found" —— 那指的是已废弃的 v1，照着去装反而走错路。
// 这条不需要真的 docker：把 PATH 收窄到系统目录跑一次即可。
{
  const probe = spawnSync("bash", [`${root}scripts/docker-up.sh`],
    {cwd: root, env: {PATH: "/usr/bin:/bin", HOME: process.env.HOME || "/tmp"}, encoding: "utf8"});
  const said = String(probe.stderr || probe.stdout || "");
  if (probe.status !== 1 || !said.includes("找不到 Docker Compose")) {
    throw new Error(`没装 compose 时 docker-up.sh 没给人话（退出码 ${probe.status}）：${said.slice(0, 200)}`);
  }
  if (!/docker compose version|Docker Desktop/u.test(said) || !/npm run init/u.test(said)) {
    throw new Error("没装 compose 的提示里缺少下一步（装什么、怎么验证、不用容器怎么跑）");
  }
  console.log("docker-up 前置检查 ok: 没装 compose 时给的是人话与下一步，不是 command not found");
}

const composeEnv = {
  ...process.env,
  AIMAC_PUBLIC_URL: "http://127.0.0.1:4317",
  AIMAC_BOOTSTRAP_TOKEN: "doctor-bootstrap-token-0123456789",
  AIMAC_MCP_SERVICE_TOKEN: "doctor-mcp-service-token-0123456789",
  AIMAC_LOCAL_SEED_WORKSPACE_OWNER_TOKEN: "doctor-workspace-owner-token-0123456789",
  AIMAC_LOCAL_SEED_REVIEWER_TOKEN: "doctor-reviewer-token-0123456789",
  AIMAC_LOCAL_SEED_AGENT_RUNTIME_TOKEN: "doctor-agent-runtime-token-0123456789",
  POSTGRES_PASSWORD: "doctor-postgres-password-0123456789",
  // 把自治循环调快，才验得动"空转不落盘"这条 —— 默认 60 秒一拍，等三拍要三分钟。
  AIMAC_ORCHESTRATOR_INTERVAL_MS: "5000"
};

run("docker", ["compose", "config"]);
try {
  run("docker", ["compose", "up", "-d", "--build", "--wait"], {timeout: 180000});
  const health = json(execFileSync("curl", ["-fsSL", "http://127.0.0.1:4317/api/health"], {cwd: root, encoding: "utf8"}));
  if (health.status !== "ok" || health.mcp?.hostedBy !== "control-plane" || health.mcp?.endpoint !== "http://127.0.0.1:4317/mcp") {
    throw new Error("compose control-plane health did not expose centralized MCP");
  }
  const manifest = json(execFileSync("curl", ["-fsSL", "http://127.0.0.1:4317/api/agent/v1/bootstrap-manifest"], {cwd: root, encoding: "utf8"}));
  if (manifest.localMcpServerAllowed !== false || manifest.skillSynchronization !== "server_managed_on_demand") {
    throw new Error("compose bootstrap manifest did not enforce lightweight remote-only Agent Runtime");
  }
  const installerChecksum = execFileSync("curl", ["-fsSL", "http://127.0.0.1:4317/install-agent.sh.sha256"], {cwd: root, encoding: "utf8"});
  if (!/install-agent\.sh/u.test(installerChecksum)) throw new Error("compose server did not publish installer checksum");
  const stateStore = execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "aimac", "-d", "aimac", "-t", "-A", "-c", "select concat(jsonb_typeof(state), '|', state->'runtime'->'storage'->>'stateStore') from aimac_control_plane_state where id='default';"], {cwd: root, env: composeEnv, encoding: "utf8"}).trim();
  if (stateStore !== "object|postgresql") throw new Error(`compose PostgreSQL state-store not active: ${stateStore}`);
  // 生产用的是 PostgreSQL，而"并发不丢更新"此前只在 runtime_json 上验过。
  // 这里从【两个独立进程】读同一个版本再各自写回：CAS 必须只让一个成功，另一个收到冲突 ——
  // 两个都成功就意味着后写的把先写的整份覆盖掉了，而谁也不会察觉。
  const pgEnv = {...composeEnv, AIMAC_STATE_STORE: "postgresql",
    DATABASE_URL: `postgres://aimac:${composeEnv.POSTGRES_PASSWORD}@127.0.0.1:55432/aimac`};
  // 空转不落盘这条此前只在 runtime_json 后端上量过。PG 这一侧的读路径不同（分片按 project_id
  // 排序读回、再水合），指纹只要有一处不稳定，跳过就永远不会发生，而外面完全看不出来 ——
  // 系统照常工作，只是每分钟白写一次整份状态、并作废所有客户端的 ETag。
  {
    const pgStateVersion = () => Number(execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "aimac",
      "-d", "aimac", "-t", "-A", "-c", "select state->>'stateVersion' from aimac_control_plane_state where id = 'default'"],
      {cwd: root, env: composeEnv, encoding: "utf8"}).trim());
    const settleDeadline = Date.now() + 90000;
    let previous = pgStateVersion();
    let stableSince = Date.now();
    while (Date.now() < settleDeadline) {
      execFileSync("sleep", ["2"]);
      const current = pgStateVersion();
      if (current !== previous) { previous = current; stableSince = Date.now(); }
      else if (Date.now() - stableSince > 16000) break;   // 连续 3 拍以上没动
    }
    if (Date.now() - stableSince <= 16000) {
      throw new Error(`PostgreSQL 后端上空转仍在每拍落盘：观察 90 秒版本号一直在涨（最后 ${previous}）—— 跳过在这个后端没生效`);
    }
    const login = json(execFileSync("curl", ["-fsSL", "-X", "POST", "-H", "content-type: application/json",
      "-d", JSON.stringify({email: "system.admin@local", token: composeEnv.AIMAC_BOOTSTRAP_TOKEN}),
      "http://127.0.0.1:4317/api/auth/login"], {cwd: root, encoding: "utf8"}));
    if (!login.sessionToken) throw new Error("compose 登录失败，拿不到会话令牌，无法核对自治循环状态");
    const tick = json(execFileSync("curl", ["-fsSL", "-H", `authorization: Bearer ${login.sessionToken}`,
      "http://127.0.0.1:4317/api/state?view=runtime"], {cwd: root, encoding: "utf8"}))?.runtime?.autonomousOrchestrator;
    if (!tick?.lastTickAt) throw new Error("PostgreSQL 后端上读不到自治循环心跳，无法判断它是不是根本没在跑");
    if (tick.lastTickResult !== "unchanged") {
      throw new Error(`PostgreSQL 后端上自治循环最后一拍报的是 ${tick.lastTickResult}，期望 unchanged —— 版本号不涨可能只是因为循环停了`);
    }
    console.log(`  PostgreSQL 空转不落盘 ok: 版本号停在 ${previous}，而循环仍在跑（最后一拍 ${tick.lastTickResult}）`);
  }

  // 版本读一次、两个探针共用：各自去读会变成顺序执行（先读先写、后读后写），
  // 那样两个都成功是正常的，测的就不是 CAS 了。
  const casVersionRaw = execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "aimac", "-d", "aimac",
    "-t", "-A", "-c", "select state->>'stateVersion' from aimac_control_plane_state where id = 'default'"], {cwd: root, env: composeEnv, encoding: "utf8"}).trim();
  const casVersion = Number(casVersionRaw);
  if (!Number.isFinite(casVersion)) throw new Error(`compose 读不到当前 stateVersion：${casVersionRaw}`);
  const casRuns = ["a", "b"].map((marker) => spawnSync(process.execPath,
    ["scripts/lib/pg-cas-probe.mjs", marker, String(casVersion)], {cwd: root, env: pgEnv, encoding: "utf8"}));
  const casResults = casRuns.map((run, index) => {
    const line = String(run.stdout || "").trim().split("\n").filter(Boolean).at(-1) || "";
    try { return JSON.parse(line); } catch { return {marker: index === 0 ? "a" : "b", outcome: `unparsable:${String(run.stderr || run.stdout || "").slice(0, 160)}`}; }
  });
  const written = casResults.filter((item) => item.outcome === "written");
  const conflicted = casResults.filter((item) => item.outcome === "conflict");
  if (written.length !== 1 || conflicted.length !== 1) {
    throw new Error(`compose PostgreSQL CAS 没有守住并发写：${JSON.stringify(casResults)} —— `
      + "两个进程读到同一个版本各自写回，必须只有一个成功；两个都成功等于后写的把先写的整份覆盖掉");
  }
  console.log(`PostgreSQL CAS ok: 同版本并发写，1 个成功 / 1 个冲突（${casResults.map((item) => `${item.marker}:${item.outcome}`).join("，")}）`);

  // 分片防篡改此前【只在没人拿来跑生产的那个后端上验过】（runtime_json 有三道校验且被契约门钉着，
  // 而生产是 PostgreSQL）。这道守卫存在的全部理由，就是"有 DB 写权限的人直接改分片行"——
  // 那正是这里要做的事：改一行、再让控制面读一次，它必须拒绝开工而不是照读照用。
  {
    const psql = (sql) => execFileSync("docker",
      ["compose", "exec", "-T", "postgres", "psql", "-U", "aimac", "-d", "aimac", "-t", "-A", "-c", sql],
      {cwd: root, env: composeEnv, encoding: "utf8"}).trim();
    const target = psql("select project_id from aimac_project_state_shards limit 1");
    if (!target) {
      console.log("  --  PostgreSQL 里还没有项目分片，「直接改分片行必须被拒」未被检验");
    } else {
      // 整行快照再改：只还原被我改的那个字段是不够的（第一版只还原了 schemaVersion，
      // 而破坏的是 collections.taskGroups —— 环境就那么坏在那儿，后面的断言全被带倒）。
      const snapshot = psql(`select shard::text from aimac_project_state_shards where project_id = '${target}'`);
      // 只动分片里的内容，不碰中央索引里的摘要 —— 这正是"有 DB 写权限的人"能做的那种改动。
      psql(`update aimac_project_state_shards set shard = jsonb_set(shard, '{collections,taskGroups}', '[]'::jsonb) where project_id = '${target}'`);
      const probe = spawnSync("curl", ["-fsS", "-o", "/dev/null", "-w", "%{http_code}",
        "-H", "accept: application/json", "http://127.0.0.1:4317/api/health"],
        {cwd: root, env: composeEnv, encoding: "utf8"});
      const tampered = spawnSync("curl", ["-fsS", "-X", "POST", "-H", "content-type: application/json",
        "-d", JSON.stringify({email: "system.admin@local", token: composeEnv.AIMAC_BOOTSTRAP_TOKEN || "docker-doctor-bootstrap-token"}),
        "http://127.0.0.1:4317/api/auth/login"], {cwd: root, env: composeEnv, encoding: "utf8"});
      const said = `${tampered.stdout || ""}${tampered.stderr || ""}`;
      if (tampered.status === 0 && !/digest_mismatch|shard/u.test(said)) {
        throw new Error("直接改了 PostgreSQL 里的分片行，控制面照读照用 —— "
          + `分片防篡改在生产后端上等于不存在（健康检查 ${probe.stdout}，登录回执：${said.slice(0, 160)}）`);
      }
      console.log("  PostgreSQL 分片防篡改 ok: 直接改分片行之后控制面拒绝开工，没有把被改过的内容当成真相");
      // 同一个威胁模型下还有两种改法。它们的后果与"改内容"不同，所以要分开验：
      //   · 把整行删掉：索引里还有这个项目，而它的数据没了 —— 照读的话人会看到一个空项目，
      //     以为"这个项目本来就没东西"，而不是"数据丢了"。
      //   · 把 schemaVersion 改成认不出的值：旧构建照读照写会把认不出的语义就地改掉，没有回头路。
      const restoreShard = () => execFileSync("docker",
        ["compose", "exec", "-T", "postgres", "psql", "-U", "aimac", "-d", "aimac", "-v", "ON_ERROR_STOP=1", "-c",
          `insert into aimac_project_state_shards (project_id, shard) values ('${target}', $json$${snapshot}$json$::jsonb)`
          + ` on conflict (project_id) do update set shard = excluded.shard`],
        {cwd: root, env: composeEnv, encoding: "utf8"});
      const loginNow = () => spawnSync("curl", ["-fsS", "-X", "POST", "-H", "content-type: application/json",
        "-d", JSON.stringify({email: "system.admin@local", token: composeEnv.AIMAC_BOOTSTRAP_TOKEN || "docker-doctor-bootstrap-token"}),
        "http://127.0.0.1:4317/api/auth/login"], {cwd: root, env: composeEnv, encoding: "utf8"});
      for (const [why, sql, expect] of [
        ["整行被删掉", `delete from aimac_project_state_shards where project_id = '${target}'`, /missing|shard/u],
        // 改 schemaVersion 也改了分片内容，所以【摘要那道门会先拦下它】——
        // 这条用例证明的是"连版本字段这种改动也逃不掉"，不是"版本门本身在起作用"。
        // 版本门自己由契约门的三条变异守着（SUPPORTED_PROJECT_SHARD_SCHEMA_VERSIONS）。
        ["连版本字段这种小改动也逃不掉",
          `update aimac_project_state_shards set shard = jsonb_set(shard, '{schemaVersion}', '"project-shard/v99"'::jsonb) where project_id = '${target}'`,
          /schema|shard|digest/u]
      ]) {
        psql(sql);
        const attempt = loginNow();
        const answer = `${attempt.stdout || ""}${attempt.stderr || ""}`;
        restoreShard();
        if (attempt.status === 0 && !expect.test(answer)) {
          throw new Error(`PostgreSQL 里${why}之后控制面照常开工 —— ${answer.slice(0, 160)}`);
        }
      }
      console.log("  PostgreSQL 分片被删/被小改 ok: 两种改法控制面都拒绝开工，没有把缺失当成「本来就没有」"
        + "（版本门本身由契约门的变异守，这里的小改动是被摘要那道先拦下的）");
      // 收拾干净：后面的断言还要用这套环境。整行原样写回，不做"聪明的部分还原"。
      execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "aimac", "-d", "aimac",
        "-v", "ON_ERROR_STOP=1", "-c",
        `update aimac_project_state_shards set shard = $json$${snapshot}$json$::jsonb where project_id = '${target}'`],
        {cwd: root, env: composeEnv, encoding: "utf8"});
    }
  }

  // 【PostgreSQL 读路径读出来的记录要按规范与状态机核一遍】。三套 e2e 都在 runtime_json 上扫产出，
  // 生产用的 PG 后端（分片按 project_id 读回再水合）此前从没被任何门按规范验过。走产品自己的读路径。
  {
    const sweep = spawnSync(process.execPath, ["scripts/lib/pg-sweep-probe.mjs"], {cwd: root, env: pgEnv, encoding: "utf8"});
    const line = String(sweep.stdout || "").trim().split("\n").pop() || "";
    let report = null;
    try { report = JSON.parse(line); } catch { report = null; }
    if (sweep.status !== 0 || !report) {
      throw new Error(`PostgreSQL 产出核对探针没跑成（exit ${sweep.status}）：${String(sweep.stderr || sweep.stdout).slice(-300)}`);
    }
    if (report.errors.length) {
      throw new Error(`docker 部署（PostgreSQL 后端）读出来的记录不符合规范/状态机：\n- ${report.errors.join("\n- ")}\n没带 schemaVersion 的记录样本：${JSON.stringify(report.samples || {}).slice(0, 600)}`);
    }
    console.log(`  PostgreSQL 产出规范核对 ok: ${report.validated} 条记录符合各自声明的 schema；${report.uncoveredNote}；${report.statesNote}`);
  }
  const doctor = spawnSync("npm", ["run", "agentctl", "--", "doctor", "--server=http://127.0.0.1:4317"], {cwd: root, env: composeEnv, encoding: "utf8"});
  if (doctor.status !== 0 || !doctor.stdout.includes("agent gateway doctor ok")) throw new Error(`compose agentctl doctor failed: ${doctor.stderr || doctor.stdout}`);
  console.log("docker compose doctor ok: config, build, health, centralized MCP, installer artifacts and PostgreSQL state-store verified");
} finally {
  spawnSync("docker", ["compose", "down", "-v"], {cwd: root, env: composeEnv, encoding: "utf8", stdio: "pipe"});
}

// 这道门旁边已经有一条「没装 compose 时给人话」的前置，而【环境把 docker 挡住】的样子不止那一种。
// 实测撞到两种，两种都只吐一段 Node 崩溃栈：读的人以为是本仓的代码坏了，实际一行都没坏。
// 判别与措辞收在 lib/docker-failure-advice.mjs 里 —— 那类故障在本机复现不了（镜像一旦缓存
// 就不再走那条路），抽出来才能拿真实抓到的原话把它验一遍。认不出来的原样抛，不假装懂。
function run(command, args, options = {}) {
  try {
    execFileSync(command, args, {cwd: root, env: composeEnv, stdio: "pipe", timeout: options.timeout || 60000});
  } catch (error) {
    const said = `${error?.stdout || ""}${error?.stderr || ""}`;
    const advice = dockerFailureAdvice(said);
    if (advice) throw new Error(`${advice}\ndocker 原话：${said.trim().split("\n").slice(0, 3).join(" / ")}`);
    throw error;
  }
}

function json(text) {
  return JSON.parse(text);
}
