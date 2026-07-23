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
