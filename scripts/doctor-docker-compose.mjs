#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const composeEnv = {
  ...process.env,
  AIMAC_PUBLIC_URL: "http://127.0.0.1:4317",
  AIMAC_BOOTSTRAP_TOKEN: "doctor-bootstrap-token-0123456789",
  AIMAC_MCP_SERVICE_TOKEN: "doctor-mcp-service-token-0123456789",
  AIMAC_LOCAL_SEED_WORKSPACE_OWNER_TOKEN: "doctor-workspace-owner-token-0123456789",
  AIMAC_LOCAL_SEED_REVIEWER_TOKEN: "doctor-reviewer-token-0123456789",
  AIMAC_LOCAL_SEED_AGENT_RUNTIME_TOKEN: "doctor-agent-runtime-token-0123456789",
  POSTGRES_PASSWORD: "doctor-postgres-password-0123456789"
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

  const doctor = spawnSync("npm", ["run", "agentctl", "--", "doctor", "--server=http://127.0.0.1:4317"], {cwd: root, env: composeEnv, encoding: "utf8"});
  if (doctor.status !== 0 || !doctor.stdout.includes("agent gateway doctor ok")) throw new Error(`compose agentctl doctor failed: ${doctor.stderr || doctor.stdout}`);
  console.log("docker compose doctor ok: config, build, health, centralized MCP, installer artifacts and PostgreSQL state-store verified");
} finally {
  spawnSync("docker", ["compose", "down", "-v"], {cwd: root, env: composeEnv, encoding: "utf8", stdio: "pipe"});
}

function run(command, args, options = {}) {
  execFileSync(command, args, {cwd: root, env: composeEnv, stdio: "pipe", timeout: options.timeout || 60000});
}

function json(text) {
  return JSON.parse(text);
}
