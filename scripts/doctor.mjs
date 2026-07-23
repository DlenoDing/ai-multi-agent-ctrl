import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";

async function getFreePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function waitForHealth(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/runtime/health`);
      if (response.ok) return await response.json();
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  throw new Error("control console health check timed out");
}

const root = resolve(new URL("..", import.meta.url).pathname);
const port = await getFreePort();
const child = spawn(process.execPath, ["apps/control-plane-ui/server.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    AIMAC_HOST: "127.0.0.1",
    AIMAC_PORT: String(port),
    AIMAC_RUNTIME_DIR: process.env.AIMAC_DOCTOR_RUNTIME_DIR || ".runtime/doctor"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  const health = await waitForHealth(port);
  console.log(`control console health ok: ${health.status}`);
} finally {
  child.kill("SIGTERM");
}

const [code, signal] = await once(child, "exit");
if (code && signal !== "SIGTERM") {
  throw new Error(`doctor server exited with ${code}: ${stderr}`);
}
